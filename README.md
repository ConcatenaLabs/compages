# Compages

*compāgēs: a joining together; a framework.*

Compages is a centralized, operator-run bridge into the **Sequentia network**
from three chains:

- **Ethereum**: lock ether or any ERC-20 in a vault contract, receive a
  matching Sequentia asset (`SYMBOL.e`); sending it back releases the
  original funds.
- **Bitcoin**: send BTC to a bridge address and receive SBTC 1:1 (custody and
  mint/burn are performed by the sbtc-bridge service; Compages is the public
  front for it).
- **Solana**: send SOL or any SPL token to a bridge address and receive the
  matching Sequentia asset (SOL.s, or the token under its own `.s` ticker);
  sending it back releases the original.

It is a proof of concept running on the **Sepolia** testnet, **Bitcoin
testnet4** and the **Solana devnet** against the **Sequentia public testnet**,
live at:

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
  representable) are refunded automatically on Ethereum. The Solana leg
  removes the failure mode instead: the Sequentia destination is validated
  before a deposit address is ever handed out.
- Irreversible releases (on Ethereum and on Solana alike) are gated on
  **Bitcoin-anchor finality** of the Sequentia burn, not on a Sequentia block
  count (see below).
- Solana transfers have no vault contract to replay-guard them, so the daemon
  uses the chain itself: a Solana transaction's id is its fee payer's
  signature, known before broadcast, and every outbound transfer's signature
  is persisted before sending. After a crash the recorded signature answers,
  on chain, whether the transfer landed or can never land.

## Status

| Piece | State |
|---|---|
| Ethereum → Sequentia (lock, then mint) | Working on the live deployment; ETH and ERC-20 deposits, first-bridge issuance, duplicate-free reissuance, automatic refunds |
| Sequentia → Ethereum (return, then release) | Implemented and exercised end-to-end in `e2e/run-e2e.sh`; live redemptions wait for 100 Bitcoin-anchor confirmations before releasing (see "Finality") |
| Vault contract | `CompagesVault` deployed on Sepolia at [`0xd72AF53b4F0551A25072cC72A29F699Ed9d8Ed41`](https://sepolia.etherscan.io/address/0xd72AF53b4F0551A25072cC72A29F699Ed9d8Ed41); 13 Foundry unit tests |
| Bitcoin ↔ SBTC (wrap, unwrap) | Live; address-based, proxied to the sbtc-bridge custody service (`/api/btc/*`) |
| Solana ↔ Sequentia (wrap, sweep, unwrap; SOL and any SPL token) | Implemented natively in the daemon (`daemon/lib/sol.js`, no extra dependency) and exercised end-to-end against a mock Solana RPC in `e2e/run-e2e.sh` |
| Asset Registry integration | Bridged assets are registered with origin-suffixed tickers (`SYMBOL.e` Ethereum, `SOL.s` Solana), bound on-chain via the issuance contract hash |
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

### Bitcoin ↔ SBTC and Solana ↔ SOL.s

Both legs are address-based; no wallet extension is involved. Pick the chain
in the "Bridge from" selector:

1. **Wrap**: enter the Sequentia address that should receive the bridged
   asset; the bridge returns a deposit address on the origin chain. Send BTC
   (testnet4), or SOL **or any SPL token** (devnet), to it from any wallet.
   After 2 Bitcoin confirmations you receive SBTC 1:1; a Solana deposit is
   minted once it is finalized and picked up by the bridge, usually under a
   minute: SOL as SOL.s, a token under its own origin-suffixed ticker, with
   the first deposit issuing the asset and later deposits by anyone minting
   more of the same one, exactly like the Ethereum leg's ERC-20s.
2. **Unwrap**: enter the Bitcoin or Solana address that should receive the
   released funds; the bridge returns a Sequentia address. Send SBTC or SOL.s
   to it from any wallet, and once the burn is final under Bitcoin anchoring
   the original BTC or SOL is released.

SOL amounts should be at least 0.001 in both directions (below Solana's
rent-exempt minimum a lamport transfer cannot create the destination account;
smaller SOL.s returns are parked for the operator). Token amounts have no
such floor: the treasury funds the recipient's associated token account on
release. Sequentia amounts carry 8 decimal places, so decimals beyond 8 are
dropped when minting (SOL has 9; most SPL mints have 6 or 9).

Only assets that were bridged in can be redeemed; Compages never mints
Ethereum-side or Solana-side representations of Sequentia-native assets, and
an asset returned to the wrong leg's redemption address is parked for the
operator, never released on the wrong chain.

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

### Solana ↔ Sequentia (intent-based, no contract)

The Solana leg reuses the redemption-intent idea in both directions. A wrap
intent binds a fresh operator-derived deposit address (HMAC of a master seed
and an index, so every address is recoverable from the seed) to a
pre-validated Sequentia destination; the daemon watches it at `finalized`
commitment and mints whatever arrives through the same issue-or-reissue
machinery as the Ethereum leg: native SOL from the address's own signature
stream, and any SPL token from the streams of the token accounts the address
owns (token transfers to an existing token account do not reference the
owner, so each token account is scanned with its own cursor). Deposits are
swept into the operator treasury, which pays every fee and the rent of its
own associated token accounts, so swept amounts arrive whole. Token identity
is the mint address; decimals come from the mint account, and the name and
symbol from the Metaplex metadata account when one exists, else a
mint-address-prefix fallback (the Ethereum leg's bytes32 fallback, in
Solana form). An unwrap intent binds a fresh Sequentia address to a Solana
destination; any Solana-bridged asset arriving there is released from the
treasury after the Bitcoin-anchor finality gate (creating the recipient's
associated token account when needed), then destroyed. All Solana-side
transaction building (legacy transactions, program-derived addresses with
the ed25519 on-curve check, SPL `transferChecked`, ed25519 via
`node:crypto`, base58) is hand-rolled in `daemon/lib/sol.js` and
byte-for-byte verified against `@solana/web3.js` and `@solana/spl-token`
during development; the e2e mock RPC independently decodes and
signature-checks every submitted transaction.

### Finality: measured against Bitcoin, not Sequentia blocks

Releasing on Ethereum or Solana is irreversible, so the burn that triggers it
must be final. On Sequentia, **Bitcoin anchoring is the supreme consensus rule**:
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
with an origin-suffixed ticker (`.e` marks it Ethereum-bridged, `.s`
Solana-bridged; the suffix avoids colliding with native assets) and the name
`<token name> (<chain name>)`, e.g. `Ether (Sepolia)` as `ETH.e` and
`SOL (Solana devnet)` as `SOL.s`. The asset is issued committed to
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
| `POST /api/btc/wrap` `{"seqAddress": "..."}` | Bitcoin deposit address for a BTC → SBTC wrap (proxied to the sbtc-bridge) |
| `POST /api/btc/unwrap` `{"btcAddress": "..."}` | Sequentia return address for an SBTC → BTC unwrap (proxied to the sbtc-bridge) |
| `POST /api/sol/wrap` `{"seqAddress": "..."}` | Solana deposit address for a SOL → SOL.s wrap (the Sequentia address is validated up front) |
| `GET /api/sol/wrap/<solAddress>` | A wrap intent's bound Sequentia address and the status of every deposit seen on it |
| `POST /api/sol/unwrap` `{"solAddress": "..."}` | Sequentia return address for a SOL.s → SOL unwrap |
| `GET /api/sol/redeem/<seqAddress>` | A Solana unwrap address's bound Solana destination and the status of every redemption seen on it |

Deposit records move through the statuses `minting`, `mint_retry`,
`send_retry`, `minted` (delivered), `refund_pending`, `refunded`, and
`failed_manual` (paused for operator review; Solana deposits use `dust_manual`
instead of the refund states). Redemption records move through
`awaiting_finality`, `new`, `releasing`, `released`, `destroy_pending`, `done`,
plus the terminal `dust_ignored`, `ignored_unknown_asset`,
`ignored_wrong_network` (an asset returned to the wrong leg's address) and
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
| `sbtcBridgeUrl`, `sbtcBridgeToken`, `btcConfirmations` | The sbtc-bridge custody service behind `/api/btc/*` (omit the URL to disable the Bitcoin leg) |
| `solRpcUrl`, `solChainName`, `solChainLabel` | Solana JSON-RPC endpoint and naming for the Solana leg (omit the URL to disable it) |
| `solGenesisHash` | Expected cluster genesis hash, verified before the leg acts (the Ethereum chain-id check's Solana equivalent) |
| `solKeyFile` | 32-byte hex seed for the Solana treasury and deposit-address derivation; generated on first boot, never commit it |
| `solWatchDays` | How long a wrap intent's deposit address is polled (default 7 days); re-requesting a wrap for the same Sequentia address revives it |
| `solMinReleaseSats` | Smallest SOL.s return that is released (default 100000 sats = 0.001 SOL, clear of Solana's rent-exempt minimum) |
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
| `daemon/` | `compagesd.js`, the Node.js bridge daemon: `lib/bridge.js` (core logic), `lib/eth.js` (Ethereum side), `lib/sol.js` (Solana side: RPC client, keys, transaction builder), `lib/seqrpc.js` (Sequentia RPC), `lib/state.js` (persistence), `lib/api.js` (HTTP API + static server) |
| `web/` | Static web front-end (no framework, no external dependencies), served by the daemon |
| `e2e/` | Full-stack end-to-end test: anvil + a mock Solana RPC + Sequentia `elementsregtest` + the real daemon and contracts |

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

Brings up anvil, a mock Solana RPC (an in-memory ledger that independently
decodes and signature-checks every submitted transaction), deploys the vault
and a mock ERC-20, starts a Sequentia `elementsregtest` node and the daemon,
then drives the full lifecycle: first-bridge issuance, duplicate-free
reissuance, native ether bridging, redemption with exact release and supply
destruction, automatic refund of an undeliverable deposit, the Solana leg
(wrap, reissue, sweep, unwrap, and the cross-leg wrong-network guards),
fee-asset independence (the bridge wallet never touches the policy asset),
and registry metadata binding. Requires foundry, node >= 20 and a build of
the Sequentia node (set `SEQ_REPO` to your checkout of the
[Sequentia repo](https://github.com/GracedEternalKingCabbageMan/Sequentia));
the registry checks are skipped unless `REGISTRY_REPO` points at a checkout of
`sequentia-registry`.

The keys in the e2e script are anvil's standard, publicly known development
keys; they hold nothing on any real network.

## Limitations

- **Centralized custody.** The operator's key controls the vault; there is no
  multisig, no threshold scheme, no fraud proofs. Do not use this design to
  hold funds of value.
- **Testnet only.** Sepolia, Bitcoin testnet4, the Solana devnet and the
  Sequentia public testnet; all tokens are worthless.
- **Single hot key and single process.** The operator keys (Ethereum,
  Solana) sit on the bridge host; state is one JSON file
  (`daemon/lib/state.js`), fine for a PoC, not for volume.
- **Exotic token-2022 extensions are handled honestly but not specially.**
  Transfer-fee mints bridge and release at the actually-received amounts
  (detection reads balance deltas, not instruction amounts); transfer-hook or
  non-transferable mints may leave a deposit unsweepable or a release
  unexecutable, in which case the record parks for the operator instead of
  looping.
- **Unauthenticated intents.** Anyone can create redemption intents; each one
  allocates a wallet address. Harmless at PoC scale, a griefing surface at
  real scale.
- **The state file is the Solana leg's replay guard.** The Ethereum leg
  reconciles against the vault's on-chain `processedRedemptions` after any
  state loss; the Solana leg has no contract, so `state.json` is what stops
  double-mints and double-releases there. Treat it like a wallet: keep it on
  durable storage, and never restore an old copy while the daemon can act.
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
