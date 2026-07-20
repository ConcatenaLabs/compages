# Compages

*compāgēs: a joining together; a framework.*

Compages is a centralized, operator-run bridge between **Ethereum** and the
**Sequentia network**. Users lock ether or any ERC-20 token in a vault contract
on Ethereum and receive a matching asset on Sequentia; sending the bridged
asset back releases the original funds on Ethereum. It is a proof of concept
running on the **Sepolia** testnet and the **Sequentia public testnet**, live at:

> **https://sequentiatestnet.com/bridge/**

Everything here is testnet software. There is no mainnet deployment, and the
tokens involved have no value.

## Trust model, stated plainly

**This is a custodial bridge.** Deposited funds are held by the vault contract
and can only be moved by the bridge operator's key; minting on Sequentia and
releases on Ethereum are actions the operator performs. If the operator
disappears or misbehaves, bridged funds are lost. Users trust the operator.
This is a demonstration of the bridging mechanics, not a trust-minimized
design.

Within that assumption, the design removes every failure mode it can:

- Releases and refunds are keyed by deterministic ids and replay-guarded on
  chain (`processedRedemptions`), so nothing can be paid twice.
- Every deposit of the same ERC-20 mints the **same** Sequentia asset; the
  mapping from token contract to Sequentia asset id is created exactly once,
  on the first deposit, so no duplicate assets can exist.
- Redeemed Sequentia amounts are destroyed, keeping the circulating bridged
  supply equal to the locked Ethereum funds.
- Deposits that cannot be delivered (invalid Sequentia address, amount not
  representable) are refunded automatically on Ethereum.
- Releases on Ethereum are gated on **Bitcoin-anchor finality** of the
  Sequentia burn, not on a Sequentia block count (see below).

## Status

| Piece | State |
|---|---|
| Ethereum → Sequentia (lock, then mint) | Working on the live deployment; ETH and ERC-20 deposits, first-bridge issuance, duplicate-free reissuance, automatic refunds |
| Sequentia → Ethereum (return, then release) | Implemented and exercised end-to-end in `e2e/run-e2e.sh`; live redemptions wait for 100 Bitcoin-anchor confirmations before releasing (see "Finality") |
| Vault contract | `CompagesVault` deployed on Sepolia at [`0xd72AF53b4F0551A25072cC72A29F699Ed9d8Ed41`](https://sepolia.etherscan.io/address/0xd72AF53b4F0551A25072cC72A29F699Ed9d8Ed41); 13 Foundry unit tests |
| Asset Registry integration | Bridged assets are registered with `SYMBOL.e` tickers, bound on-chain via the issuance contract hash |
| Web front-end | Live at https://sequentiatestnet.com/bridge/, served by the daemon itself |

Chain ids, RPC endpoints, the vault address and confirmation depths are all
configuration, and asset mappings are keyed per chain id, so nothing in the
code pins it to a particular network. It has only ever run on testnets.

## Using the live bridge

### Ethereum → Sequentia

1. Open https://sequentiatestnet.com/bridge/ and connect an Ethereum wallet
   (e.g. MetaMask) on **Sepolia**.
2. Pick an asset: ETH, one of the already-bridged tokens, or paste any ERC-20
   contract address. The page tells you whether this would be the **first
   bridge** of that token (your deposit issues a brand-new Sequentia asset) or
   whether it **mints more of an existing asset**.
3. Enter the amount and your Sequentia address (the default `tb1...` address
   from any Sequentia wallet works). A preview shows the exact amount you will
   receive before you commit.
4. Confirm the deposit (for ERC-20s the page first requests an `approve`).
   After 5 Ethereum confirmations the daemon mints on Sequentia and sends the
   asset to your address; the page tracks each stage. If you close the page,
   the "Track an existing deposit" box resumes tracking from the Ethereum
   transaction hash.

### Sequentia → Ethereum

1. On the "Sequentia → Ethereum" tab, enter the Ethereum address that should
   receive the released funds and click "Create redemption address". The
   bridge returns a fresh Sequentia address bound to your Ethereum address.
2. Send the bridged asset to that address from any Sequentia wallet. No
   special transaction format is needed.
3. Once the transfer is **final under Bitcoin anchoring** (100 Bitcoin-anchor
   confirmations on the live deployment, roughly 17 hours at the 10-minute
   block target), the vault releases
   the locked ether or tokens to your Ethereum address, and the returned
   Sequentia amount is destroyed. The page shows each redemption's progress;
   "Resume a redemption" looks a redemption up again by its address.

Only assets that were bridged in can be redeemed; Compages never mints
Ethereum-side representations of Sequentia-native assets.

## How it works

### Ethereum → Sequentia (lock, then mint)

1. The user calls `depositEther(seqAddress)` or
   `depositToken(token, amount, seqAddress)` on the `CompagesVault` contract.
2. The daemon (`compagesd`) picks the deposit up from the `Deposited` event
   after `ethConfirmations` confirmations.
3. First deposit of a token: the daemon issues a new reissuable Sequentia
   asset carrying the token's symbol, name and decimals, and records the
   mapping. Every later deposit of that token, by anyone, reissues the same
   asset.
4. The minted amount is sent to the user's Sequentia address.

Amounts convert 1:1 with decimal normalization: Sequentia amounts have 8
decimal places, so a token with more than 8 decimals bridges at a granularity
of `10^(d-8)` base units (the web app limits inputs accordingly, and the
daemon refunds a deposit too small to represent).

### Sequentia → Ethereum (return, then release)

1. The user asks the bridge for a redemption address bound to their Ethereum
   address (`POST /api/redeem`; the front-end does it in one click).
2. They send the bridged asset to that address from any Sequentia wallet.
3. Once the transfer is final under Bitcoin anchoring, the daemon calls
   `release()` on the vault to pay the locked ether or tokens to the bound
   Ethereum address, then destroys the returned Sequentia amount.

### Finality: measured against Bitcoin, not Sequentia blocks

Releasing on Ethereum is irreversible, so the burn that triggers it must be
final. On Sequentia, **Bitcoin anchoring is the supreme consensus rule**:
every Sequentia block references a Bitcoin block, and if that Bitcoin block is
reorged the Sequentia block is discarded in real time, no matter how many
Sequentia blocks were built on top. A burn buried under many Sequentia blocks
can therefore still be undone by a Bitcoin reorg.

So the release gate is the burn's **Bitcoin-anchor depth**, not a Sequentia
block count: `depth = getanchorstatus.anchorheight − getblockheader(burnBlock).anchorheight`,
required to reach `btcAnchorConfirmations`. Because consecutive Sequentia
blocks share a Bitcoin anchor, this depth advances only as Bitcoin advances,
which is precisely the finality that protects the release. The gate also
requires the node's `anchorstatus` to be `"ok"` and, when the node reports it,
the burn block to be committee-certified. On a chain without anchoring
(e.g. regtest) it falls back to a Sequentia-confirmation count.

Choosing `btcAnchorConfirmations`: it must exceed the deepest reorg of the
anchor chain you are willing to tolerate. The live deployment anchors to
Bitcoin **testnet4** and sets it to **100**, because testnet4 permits
unusually deep reorgs (its min-difficulty rule lets a miner rewrite long
stretches). A chain anchored to Bitcoin proper could use a much shallower
depth (the config default is 3). Deeper means slower redemptions (each
confirmation is about one Bitcoin block), which is the honest cost of
anchored finality.

### Bridged asset metadata

Each bridged asset is registered in the
[Sequentia Asset Registry](https://github.com/GracedEternalKingCabbageMan/sequentia-registry)
with the ticker `SYMBOL.e` (the `.e` marks it Ethereum-bridged and avoids
colliding with native assets) and the name `<token name> (<chain name>)`, e.g.
`Ether (Sepolia)` as `ETH.e`. The asset is issued committed to
`SHA256(canonical-JSON(contract))` as its contract hash, so the metadata is
bound on-chain and independently verifiable, not just asserted by the
operator. Registration is best-effort and retried; it never blocks a mint.

### Fees

- **The bridge charges no fee of its own.** Users pay their own Ethereum gas
  (deposit, approve) and the Sequentia network fee of the transfer to the
  redemption address; the operator pays everything else (issuance,
  reissuance, delivery, the redeem-side burn, and release gas on Ethereum).
- Sequentia has an open fee market: fees are payable in any accepted asset
  and no asset (including the Sequence token) is privileged. The daemon pays
  every Sequentia fee in the single asset named by `seqFeeAsset`, whatever
  the operator chooses; it never needs the policy asset. Pinning the fee
  asset explicitly is also necessary because the wallet would otherwise
  default the fee to the asset being sent, and a freshly bridged asset has no
  exchange rate on the node yet. The end-to-end test proves this by funding
  the bridge with only a non-policy fee asset and asserting its policy-asset
  balance stays zero throughout.

### Sequentia-side implementation notes

- **Burning in any fee asset**: `destroyamount` only pays its fee in the
  policy asset, so when `seqFeeAsset` is set the redeem-side burn is built as
  a raw transaction (a `burn` output for the bridged asset plus a fee output
  in `seqFeeAsset`), blinded, signed and broadcast by the daemon
  (`daemon/lib/bridge.js`, `destroyAsset`).
- **Reissuance tokens stay confidential**: consensus accepts a reissuance
  only when the reissuance-token input carries a commitment asset tag, so the
  daemon keeps each asset's reissuance token on a blinded (confidential)
  address and re-blinds it after every reissue (wallet change comes back
  unblinded on transparent-by-default Sequentia). Handled automatically.
- **Mempool verification**: the daemon verifies every mint, send and burn
  transaction actually reached the mempool before counting it, and rolls the
  wallet back (`abandontransaction`) if it did not.
- **Crash safety**: every irreversible step is bracketed by a persisted
  marker in the state file. If the daemon dies between a chain write and its
  acknowledgment, the record halts in a `*_manual` status for operator review
  instead of double-paying; on-chain `processedRedemptions` is consulted on
  restart to reconcile releases that landed before a crash.

## HTTP API

The daemon serves the static web app and a JSON API from the same port
(`apiPort`, default 9950). The live instance is reverse-proxied under
`https://sequentiatestnet.com/bridge/`. CORS is permissive; the API holds no
secrets, and the only mutating call creates a redemption intent.

| Method and path | Purpose |
|---|---|
| `GET /api/status` | Bridge configuration and counters: chain ids, vault address, confirmation depths, number of bridged assets, deposits, redemptions |
| `GET /api/assets` | All bridged assets: token, symbol, decimals, Sequentia asset id, ticker, contract hash, circulating amount (`mintedSats`) |
| `GET /api/token/<address\|eth>` | Metadata for a token and whether it is already bridged (used by the front-end's token lookup) |
| `POST /api/redeem` `{"ethAddress": "0x..."}` | Create a redemption intent; returns the Sequentia address to send bridged assets to |
| `GET /api/redeem/<seqAddress>` | A redemption address's bound Ethereum address and the status of every redemption seen on it |
| `GET /api/deposit/tx/<ethTxHash>` | Look up deposits by their Ethereum transaction hash (used to track and resume deposits) |

Deposit records move through the statuses `minting`, `mint_retry`,
`send_retry`, `minted` (delivered), `refund_pending`, `refunded`, and
`failed_manual` (paused for operator review). Redemption records move through
`awaiting_finality`, `new`, `releasing`, `released`, `destroy_pending`, `done`,
plus the terminal `dust_ignored`, `ignored_unknown_asset` and
`release_failed_manual`.

Try it against the live instance:

```
curl -s https://sequentiatestnet.com/bridge/api/status
curl -s https://sequentiatestnet.com/bridge/api/assets
```

## Running your own instance

Requirements: Node.js 20+ for the daemon, [Foundry](https://getfoundry.sh)
for the contract, a synced Sequentia node with a funded wallet, and an
Ethereum RPC endpoint that supports `eth_getLogs` over block ranges.

### 1. Deploy the vault

```
git clone --recurse-submodules https://github.com/GracedEternalKingCabbageMan/compages.git
cd compages/contracts
forge script script/Deploy.s.sol --rpc-url $ETH_RPC_URL \
  --private-key $BRIDGE_OPERATOR_KEY --broadcast
```

The deployer becomes both `owner` and `operator`. The owner can later rotate
the operator (`setOperator`), transfer ownership, and pause new deposits
(`setDepositsPaused`) while keeping existing funds releasable.

### 2. Configure and run the daemon

```
cd ../daemon
npm install
cp config.example.json config.json    # edit, see below
echo <operator-private-key-hex> > operator.key
node compagesd.js config.json
```

Configuration reference (`daemon/config.example.json`):

| Key | Meaning |
|---|---|
| `ethChainName`, `ethChainId` | Display name and chain id of the Ethereum network (checked against the RPC at startup) |
| `ethRpcUrl` | Ethereum JSON-RPC endpoint (must support `eth_getLogs`) |
| `vaultAddress`, `vaultDeployBlock` | The deployed `CompagesVault` and the block to start scanning from |
| `ethConfirmations` | Confirmations before a deposit is processed |
| `ethLogChunk` | Max block range per `eth_getLogs` call |
| `operatorKeyFile` | File containing the operator's private key (never commit it) |
| `seqRpcUrl` | Sequentia node RPC, `http://user:pass@host:port` |
| `seqWallet` | Node wallet name; auto-loaded at startup if on disk |
| `seqChainLabel` | Label mixed into redemption ids (prevents cross-chain replay) |
| `seqConfirmations` | Sequentia confirmations; also the finality fallback on chains without anchoring |
| `btcAnchorConfirmations` | Bitcoin-anchor depth required before a release (see "Finality") |
| `registryUrl`, `registryAdminToken`, `assetDomain` | Asset Registry endpoint, optional admin token, and the entity domain written into asset contracts |
| `seqFeeAsset` | Asset id or label the bridge pays all Sequentia fees in (any accepted fee asset the wallet holds) |
| `apiHost`, `apiPort` | Where the API + web app listen |
| `pollIntervalMs` | Main loop interval |
| `stateFile` | Path of the JSON state file |

The Sequentia wallet named in `seqWallet` must hold enough of `seqFeeAsset`
to pay Sequentia fees, the operator's Ethereum account needs gas for releases
and refunds, and the operator key must match the vault's `operator()`; the
daemon verifies all of this at startup.

### 3. Keep it running (systemd example)

The repository ships no unit file; a minimal one looks like this (adjust user
and paths):

```ini
[Unit]
Description=Compages bridge daemon
After=network-online.target

[Service]
User=compages
WorkingDirectory=/opt/compages/daemon
ExecStart=/usr/bin/node compagesd.js config.json
Restart=on-failure
RestartSec=10

[Install]
WantedBy=multi-user.target
```

The daemon is crash-safe by design (state file + on-chain replay guards), so
`Restart=on-failure` is safe.

## Repository layout

| Path | What it is |
|---|---|
| `contracts/` | Foundry project: `src/CompagesVault.sol`, unit tests, deploy script (`forge-std` as a git submodule) |
| `daemon/` | `compagesd.js`, the Node.js bridge daemon: `lib/bridge.js` (core logic), `lib/eth.js` (Ethereum side), `lib/seqrpc.js` (Sequentia RPC), `lib/state.js` (persistence), `lib/api.js` (HTTP API + static server) |
| `web/` | Static web front-end (no framework, no external dependencies), served by the daemon |
| `e2e/` | Full-stack end-to-end test: anvil + Sequentia `elementsregtest` + the real daemon and contracts |

The daemon's only runtime dependency is `ethers`.

## Testing

Contract unit tests (13 tests: deposits, fee-on-transfer tokens, pausing,
release replay protection, access control):

```
cd contracts
forge test
```

Full end-to-end test:

```
e2e/run-e2e.sh
```

Brings up anvil, deploys the vault and a mock ERC-20, starts a Sequentia
`elementsregtest` node and the daemon, then drives the full lifecycle:
first-bridge issuance, duplicate-free reissuance, native ether bridging,
redemption with exact release and supply destruction, automatic refund of an
undeliverable deposit, fee-asset independence (the bridge wallet never touches
the policy asset), and registry metadata binding. Requires foundry, node >= 20
and a build of the Sequentia node (set `SEQ_REPO` to your checkout of the
[Sequentia repo](https://github.com/GracedEternalKingCabbageMan/Sequentia));
the registry checks are skipped unless `REGISTRY_REPO` points at a checkout of
`sequentia-registry`.

The keys in the e2e script are anvil's standard, publicly known development
keys; they hold nothing on any real network.

## Limitations

- **Centralized custody.** The operator's key controls the vault; there is no
  multisig, no threshold scheme, no fraud proofs. Do not use this design to
  hold funds of value.
- **Testnet only.** Sepolia and the Sequentia public testnet; all tokens are
  worthless.
- **Single hot key and single process.** The operator key sits on the bridge
  host; state is one JSON file (`daemon/lib/state.js`), fine for a PoC,
  not for volume.
- **Unauthenticated intents.** Anyone can create redemption intents; each one
  allocates a wallet address. Harmless at PoC scale, a griefing surface at
  real scale.
- **Redemptions are slow by design** on the live deployment: 100
  Bitcoin-anchor confirmations, because Bitcoin testnet4 allows deep reorgs.

## Ecosystem

Compages is one component of the Sequentia testnet ecosystem. The umbrella
protocol documentation lives in
[`Sequentia/doc/sequentia/`](https://github.com/GracedEternalKingCabbageMan/Sequentia/tree/HEAD/doc/sequentia).

| Repo | One-liner |
|---|---|
| [`Sequentia`](https://github.com/GracedEternalKingCabbageMan/Sequentia) | The Sequentia node (`elementsd` fork of Elements 23.3.3): consensus, anchoring, proof of stake, open fee market, plus the canonical protocol documentation in `doc/sequentia/`. |
| [`sequentia-registry`](https://github.com/GracedEternalKingCabbageMan/sequentia-registry) | Sequentia Asset Registry service (asset metadata). |
| [`sequentia-explorer`](https://github.com/GracedEternalKingCabbageMan/sequentia-explorer) | Sequentia block explorer frontend (esplora fork); the indexer lives in sequentia-electrs. |
| [`SWK`](https://github.com/GracedEternalKingCabbageMan/SWK) | Sequentia Wallet Kit: a fork of Blockstream LWK; Rust wallet library, CLI, and WASM bindings for building Sequentia (and Bitcoin testnet4) wallets. |
| [`seqdex`](https://github.com/GracedEternalKingCabbageMan/seqdex) | SeqDEX: non-custodial atomic-swap DEX; P2P order book (seqob), same-chain swaps, and cross-chain BTC↔asset swaps made safe by Bitcoin anchoring. |

## Contributing

Development happens on `main`; open pull requests against it. Before
committing, run `forge test` and, for daemon changes, `e2e/run-e2e.sh`.
Never commit `config.json`, `operator.key`, or state files (they are
`.gitignore`d; keep it that way).

## License

The Solidity sources carry MIT SPDX identifiers. The repository does not yet
include a top-level license file.
