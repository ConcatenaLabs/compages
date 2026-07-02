# Compages

*comp&#257;g&#275;s: a joining together; a framework.*

Compages is a centralized, operator-run bridge between **Ethereum** and the
**Sequentia network**. Users lock ether or any ERC-20 token in a vault
contract on Ethereum and receive a matching asset on Sequentia; burning the
bridged asset on Sequentia releases the original funds on Ethereum.

The proof of concept runs on the Sepolia testnet and the Sequentia testnet,
and is written to migrate to both mainnets by configuration only: chain ids,
RPC endpoints, the vault address and confirmation depths are all config, and
asset mappings are keyed per chain id.

## Trust model, stated plainly

This is a custodial bridge. Deposited funds are held by the vault contract
and can only be moved by the bridge operator's key; minting on Sequentia and
releases on Ethereum are actions the operator performs. Users trust the
operator. The design still removes every failure mode it can without
touching that assumption:

- Releases and refunds are keyed by deterministic ids and replay-guarded on
  chain (`processedRedemptions`), so nothing can be paid twice.
- Every deposit of the same ERC-20 mints the **same** Sequentia asset; the
  mapping from token contract to Sequentia asset id is created exactly once,
  on the first deposit, so no duplicate assets can exist.
- Redeemed Sequentia amounts are destroyed (`destroyamount`), keeping the
  circulating bridged supply equal to the locked Ethereum funds.
- Deposits that cannot be delivered (invalid Sequentia address, amount not
  representable) are refunded automatically on Ethereum.

## How it works

### Ethereum to Sequentia (lock, then mint)

1. The user calls `depositEther(seqAddress)` or
   `depositToken(token, amount, seqAddress)` on the `CompagesVault` contract.
2. The daemon (`compagesd`) picks the deposit up after N confirmations.
3. First deposit of a token: the daemon issues a new reissuable Sequentia
   asset carrying the token's symbol, name and decimals, and records the
   mapping. Every later deposit of that token, by anyone, reissues the same
   asset.
4. The minted amount is sent to the user's Sequentia address.

Amounts convert 1:1 with decimal normalization: Sequentia amounts have 8
decimal places, so a token with `d > 8` decimals bridges at a granularity of
`10^(d-8)` base units (the web app limits inputs accordingly).

### Sequentia to Ethereum (return, then release)

1. The user asks the bridge for a redemption address bound to their Ethereum
   address (one API call; the front-end does it in one click).
2. They send the bridged asset to that address from any Sequentia wallet; no
   special transaction format is needed.
3. After N confirmations on the active chain the daemon releases the locked
   ether or tokens from the vault to the bound Ethereum address, then
   destroys the returned Sequentia amount.

Only assets that were bridged in can be redeemed; Compages never mints
Ethereum-side representations of Sequentia-native assets.

## Layout

| Path | What it is |
|---|---|
| `contracts/` | Foundry project: `CompagesVault.sol`, unit tests, deploy script |
| `daemon/` | `compagesd`, the Node.js bridge daemon plus its HTTP API |
| `web/` | static web front-end, served by the daemon |
| `e2e/` | full-stack end-to-end test (anvil + Sequentia elementsregtest) |

## Running the daemon

```
cd daemon
npm install
cp config.example.json config.json   # edit: RPC endpoints, vault, wallet
echo <operator-private-key-hex> > operator.key
node compagesd.js config.json
```

The daemon serves the web app and its API on `apiPort` (default 9950). The
Sequentia wallet named in `seqWallet` must hold enough of `seqFeeAsset` to
pay Sequentia fees (any accepted asset works; the testnet deployment uses
tSEQ), and the operator key must match the vault's `operator()`.

Deploying the vault:

```
cd contracts
forge script script/Deploy.s.sol --rpc-url $ETH_RPC_URL \
  --private-key $BRIDGE_OPERATOR_KEY --broadcast
```

## Sequentia-side notes

- **Fees**: Sequentia has an open fee market; fees are payable in any accepted
  asset and no asset (including the Sequence token) is privileged. The bridge
  pays every fee — issuance, reissuance, delivery and the redeem-side burn — in
  the single asset named by `seqFeeAsset`, whatever the operator chooses; it
  never needs the policy asset. Pinning the fee asset explicitly is also
  necessary because the wallet would otherwise default the fee to the asset
  being sent, and a freshly bridged asset has no exchange rate on the node yet.
  The end-to-end test proves this by funding the bridge with only a non-policy
  fee asset and asserting its policy-asset balance stays zero throughout.
- **Burning in any fee asset**: `destroyamount` only pays its fee in the policy
  asset, so the redeem-side burn is built as a raw transaction (a `burn` output
  for the bridged asset plus a fee output in `seqFeeAsset`), blinded, signed and
  broadcast by the daemon.
- **Reissuance tokens stay confidential**: consensus accepts a reissuance
  only when the reissuance-token input carries a commitment asset tag, so
  the daemon keeps each asset's reissuance token on a blinded (confidential)
  address and re-blinds it after every reissue (wallet change comes back
  unblinded on transparent-by-default Sequentia). This is handled
  automatically.
- The daemon verifies every mint transaction actually reached the mempool
  before counting it, and rolls the wallet back (`abandontransaction`) if it
  did not.

## End-to-end test

```
e2e/run-e2e.sh
```

Brings up anvil, deploys the vault and a mock ERC-20, starts a Sequentia
`elementsregtest` node and the daemon, then drives the full lifecycle:
first-bridge issuance, duplicate-free reissuance, native ether bridging,
redemption with exact release and supply destruction, and automatic refund
of an undeliverable deposit. Requires foundry, node >= 20 and a Sequentia
build (`SEQ_REPO` defaults to `~/SequentiaByClaude`).

The keys in the e2e script are anvil's standard, publicly known development
keys; they hold nothing on any real network.
