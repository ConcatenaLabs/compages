# Compages

*compāgēs: a joining together; a framework.*

Compages is a centralized, operator-run bridge into the **Sequentia network**
from three chains:

- **Ethereum**: lock ether or any ERC-20 in a vault contract, receive a
  matching Sequentia asset (`SYMBOL.e`); sending it back releases the
  original funds.
- **Bitcoin**: bitcoin needs no bridge to be used on Sequentia. Every
  Sequentia wallet holds and spends native bitcoin directly, at the same
  `tb1...` address it uses for Sequentia assets. For the few uses that need
  bitcoin on the Sequentia chain itself (confidential transactions, and
  anything that needs a covenant, such as a resting limit order), BTC sent to
  a bridge address is wrapped 1:1 as SBTC (custody and mint/burn are performed
  by the sbtc-bridge service; Compages is the public front for it).
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
  mapping from token contract to Sequentia asset id is created exactly once
  (on the first deposit for an ordinary token, in the issuance ceremony for a
  unified stablecoin, see below), so no duplicate assets can exist.
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

### Unified stablecoins

For the stablecoins declared under `unified` in the config (live: **USDC.e**
and **EURC.e**), there is exactly one Sequentia asset per coin, whichever
chain a deposit came from: a USDC deposit from Sepolia and one from the
Solana devnet both mint into the same `USDC.e`. The bridge only unifies tokens
the operator has explicitly declared to be the same money, never tokens that
merely share a symbol.

- The asset is issued once, in a ceremony at daemon start, **before any
  deposit**, with zero supply and exactly one reissuance token, so backing is
  exact from the first atom and the mint authority is a single object. The
  daemon refuses to run if the ceremony fails.
- It is issued at the issuer's own precision (6 for USDC and EURC), not the 8
  decimals ordinary bridged assets use; amounts convert at that precision.
- It is issued as a node-level **supervised** asset with pause
  (`supervision: {enabled, pause}`): the holder of the operational key can
  freeze individual holdings, or pause the asset, by consensus rule. This is
  the node's supervised-asset feature, not OpenAMP. It is permanent: both
  supervision keys are committed in the asset id. By default the daemon
  derives them from the bridge wallet, which makes that wallet's backup the
  freeze authority; a production issuer pins its own public keys instead.
- `unifiedIssuerPubkey` is hashed into the asset id and later authorizes
  handing the asset's registry identity to the real issuer, which is why the
  asset is built this way: so the issuer can adopt it in place.

The specification is
[`bridged-usdc-standard.md`](https://github.com/ConcatenaLabs/Sequentia/blob/master/doc/sequentia/bridged-usdc-standard.md)
in the node repository.

## What the bridge does

| Piece | What it does |
|---|---|
| Ethereum → Sequentia (lock, then mint) | ETH and ERC-20 deposits, first-bridge issuance, duplicate-free reissuance, automatic refunds |
| Sequentia → Ethereum (return, then release) | Releases the locked funds against a returned bridged asset; live redemptions wait for 100 Bitcoin-anchor confirmations first (see "Finality") |
| Vault contract | `CompagesVault` on Sepolia at [`0xd72AF53b4F0551A25072cC72A29F699Ed9d8Ed41`](https://sepolia.etherscan.io/address/0xd72AF53b4F0551A25072cC72A29F699Ed9d8Ed41) (primary) and [`0x15b3c97ed82c62b7828a775456bd75e67a8ec42c`](https://sepolia.etherscan.io/address/0x15b3c97ed82c62b7828a775456bd75e67a8ec42c); the daemon watches both |
| Unified stablecoins | `USDC.e` and `EURC.e`, precision 6, fed from Sepolia and the Solana devnet, node-level supervised (see "Unified stablecoins") |
| Bitcoin ↔ SBTC (wrap, unwrap) | Address-based, proxied to the sbtc-bridge custody service (`/api/btc/*`); only for uses that need bitcoin on the Sequentia chain, since Sequentia wallets hold native bitcoin directly |
| Solana ↔ Sequentia (wrap, sweep, unwrap; SOL and any SPL token) | Implemented natively in the daemon (`daemon/lib/sol.js`, no extra dependency) |
| Asset Registry integration | Bridged assets are registered with origin-suffixed tickers (`SYMBOL.e` Ethereum, `SOL.s` Solana), bound on-chain via the issuance contract hash |
| Web front-end | Served by the daemon itself at https://sequentiatestnet.com/bridge/: `web/index.html`, `web/app.js`, and `web/qr.js` (the page's own QR encoder) |

Every leg is exercised end to end by `e2e/run-e2e.sh`.

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
3. Enter the amount and your Sequentia address. The default `tb1...` address
   from any Sequentia wallet works; a confidential (blinded) `tsqb1...`
   address works too and hides the amount received on chain. The page checks
   the address with the bridge's node as you type and keeps the deposit
   button disabled while it is invalid. When a Sequentia wallet is installed
   in the browser, "Use my Sequentia wallet" fills it in. A preview shows the
   exact amount and ticker you will receive (`SYMBOL.e`) and the expected
   wait before you commit.
4. Confirm the deposit. For an ERC-20 the page first requests an `approve`,
   and resets an existing non-zero allowance to zero first for tokens that
   require it. Once Ethereum finalizes the block holding your deposit (about
   15 minutes), the daemon mints on Sequentia and sends the asset to your
   address. The page tracks each stage with a progress bar and the time left.
   It remembers the last deposit and resumes tracking when you come back; the
   "Track a deposit" box follows any deposit by its Ethereum transaction hash.
   If your wallet speeds up or replaces the transaction, the page says so and
   asks for the new hash.

### Sequentia → Ethereum

1. On the "Sequentia → Ethereum" tab, enter the Ethereum address that should
   receive the released funds and click "Get my redemption address". The
   bridge returns the Sequentia address bound to that Ethereum address; each
   Ethereum address has one, and asking again returns the same one. With an
   Ethereum wallet connected, the page shows its redemption address and
   redemptions without asking.
2. Send the bridged asset to that address from any Sequentia wallet. No
   special transaction format is needed.
3. Once the transfer is **final under Bitcoin anchoring** (100 Bitcoin-anchor
   confirmations on the live deployment, roughly 17 hours at the 10-minute
   block target), the vault releases
   the locked ether or tokens to your Ethereum address, and the returned
   Sequentia amount is destroyed. The page shows each redemption's progress
   toward finality with the time left, remembers the address for your next
   visit, and "Look up a redemption address" finds one again by the
   redemption address or by the Ethereum address it pays.

### Bitcoin ↔ SBTC and Solana ↔ SOL.s

Bitcoin needs no bridge to be used on Sequentia: every Sequentia wallet holds
and spends native bitcoin directly, at the same `tb1...` address it uses for
Sequentia assets. SBTC, bitcoin pegged 1:1 on Sequentia, is only needed
for confidential (blinded) transactions and for anything that needs a
covenant, such as a limit order that rests on chain until it is filled. The
page says this before it shows the Bitcoin forms.

Both legs are address-based; no wallet extension is involved. Pick the chain
in the "Bridge from" selector:

1. **Wrap**: enter the Sequentia address that should receive the bridged
   asset; the bridge returns a deposit address on the origin chain. Send BTC
   (testnet4), or SOL **or any SPL token** (devnet), to it from any wallet.
   After 2 Bitcoin confirmations you receive SBTC 1:1; a Solana deposit is
   minted once it is finalized and picked up by the bridge, usually under a
   minute: SOL as SOL.s, a token under its own origin-suffixed ticker, with
   the first deposit issuing the asset and later deposits by anyone minting
   more of the same one, exactly like the Ethereum leg's ERC-20s. The page
   checks the Sequentia address before it requests a deposit address, and
   shows the deposit address with a QR code and a payment link
   (`bitcoin:<address>`, or `solana:<address>` with `spl-token=<mint>` when
   you pick a token).
2. **Unwrap**: enter the Bitcoin or Solana address that should receive the
   released funds; the bridge returns a Sequentia address. Send SBTC or SOL.s
   to it from any wallet, and once the burn is final under Bitcoin anchoring
   the original BTC or SOL is released. A Sequentia wallet's `tb1...`
   address also receives bitcoin, so "Use my Sequentia wallet" can fill the
   Bitcoin destination too.

The page lists every transfer to a wrap or unwrap address with its status:
confirmations so far with the time left, then crediting or releasing, then
the transaction that paid you. It remembers the last address it gave you on
each leg and shows it again when you come back, and the "Track" box on the
Bitcoin leg looks up any Bitcoin deposit address or SBTC return address. A banner at the top names any asset whose minting the operator has
paused.

SOL amounts should be at least 0.001 in both directions (below Solana's
rent-exempt minimum a lamport transfer cannot create the destination account;
smaller SOL.s returns are parked for the operator). Token amounts have no
such floor: the treasury funds the recipient's associated token account on
release. An ordinary bridged asset carries 8 decimal places, so decimals
beyond 8 are dropped when minting (SOL has 9; most SPL mints have 6 or 9); a
unified stablecoin converts at its own precision instead.

Only assets that were bridged in can be redeemed; Compages never mints
Ethereum-side or Solana-side representations of Sequentia-native assets, and
an asset returned to the wrong leg's redemption address is parked for the
operator, never released on the wrong chain.

## How it works

### Ethereum → Sequentia (lock, then mint)

1. The user calls `depositEther(seqAddress)` or
   `depositToken(token, amount, seqAddress)` on the `CompagesVault` contract.
2. The daemon (`compagesd`) picks the deposit up from the `Deposited` event
   once Ethereum has finalized its block (`ethFinality`), and checks that
   every deposit number the vault has counted has a record, so a log an RPC
   failed to return is found rather than lost.
3. First deposit of a token: the daemon issues a new reissuable Sequentia
   asset carrying the token's symbol, name and decimals, and records the
   mapping. Every later deposit of that token, by anyone, reissues the same
   asset. A token declared under `unified` is routed to the asset issued in
   the start-up ceremony instead, which already exists before any deposit.
4. The minted amount is sent to the user's Sequentia address.

Amounts convert 1:1 with decimal normalization at the asset's precision: an
ordinary bridged asset has 8 decimal places, so a token with more than 8
decimals bridges at a granularity of `10^(d-8)` base units (the web app
limits inputs accordingly, and the daemon refunds a deposit too small to
represent); a unified stablecoin converts at its issuer's precision (6 for
USDC and EURC).

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

### One escrow for a unified stablecoin: CCTP

A unified stablecoin arrives from several chains, and each chain's deposits
are escrowed there. Circle adopts a bridged USDC by burning a single escrow,
so the daemon keeps the escrow in one place: whatever the Solana treasury
holds beyond a working float (`solFloatUnits`, kept for releases on Solana)
is moved into the Ethereum vault with Circle's own Cross-Chain Transfer
Protocol. The USDC is burned on Solana and minted by Circle into the vault,
so nothing but native USDC ever backs the asset.

Each move is recorded before anything is sent, and the Solana burn's
signature is persisted before broadcast, like every other outbound Solana
transfer. The daemon fetches Circle's attestation and relays the mint on
Ethereum itself; the message names no destination caller, so anyone else may
relay it too, and the message's nonce says whether someone did. Between the
burn and the mint the amount is in transit: the reserves page
(`inTransitAtoms`, with each Solana burn listed) and the supply invariant
count it as backing, so a move in flight never reads as a shortfall.

Each Solana burn leaves a small account holding Circle's record of the
message, paid for from the treasury. Circle's program lets the payer close it
five days after the burn; the daemon does so automatically, with the same
persist-before-broadcast guard, and the rent returns to the treasury.

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
[Sequentia Asset Registry](https://github.com/ConcatenaLabs/sequentia-registry)
with an origin-suffixed ticker (`.e` marks it Ethereum-bridged, `.s`
Solana-bridged; the suffix avoids colliding with native assets) and the name
`<token name> (<chain name>)`, e.g. `Ether (Sepolia)` as `ETH.e` and
`SOL (Solana devnet)` as `SOL.s`. Unified stablecoins are the exception: one
ticker (`USDC.e`, `EURC.e`) whichever chain the deposit came from, because
there is exactly one asset per coin. The asset is issued committed to
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
  (`daemon/lib/bridge.js`, `buildBurn`).
- **Broadcast verification**: a txid returned by the wallet is never taken as
  proof of broadcast. After every mint, send and burn the daemon establishes
  one of three answers: the transaction is in the mempool or a block; it is
  provably absent (the wallet accepted `abandontransaction`, which it refuses
  for anything in the mempool or a block), which makes a retry safe; or the
  node could not say. In that last case the record waits as `unresolved` and
  is asked again every tick, because retrying a transaction whose fate is
  unknown is exactly how a bridge mints or pays twice.
- **Crash safety**: every irreversible step is bracketed by a persisted
  marker in the state file, and the transaction id is recorded before its
  outcome is checked, so after a crash the chain answers whether it landed.
  Burns go further: the signed burn is persisted before broadcast and
  re-broadcast as-is after an interruption, which can never burn twice. On
  Ethereum the vault's `processedRedemptions` is the authority on whether a
  payout landed. Only a step interrupted before its transaction id was
  recorded, or one the node cannot settle for `unresolvedHours`, becomes a
  `*_manual` case for the operator.
- **Bounded waits**: every call to a node, an RPC provider or a service has a
  timeout, and an Ethereum payout that sits unmined for `ethStuckMinutes` is
  replaced at the same nonce with higher fees, so one stuck call cannot stall
  every leg of the bridge.
- **Durable state**: each save is flushed to disk (file and directory) before
  the daemon acts on it, and a copy per day for the last 14 days is kept in
  `snapshots/` beside the state file.

## HTTP API

The daemon serves the static web app and a JSON API from the same port
(`apiPort`, default 9950). The live instance is reverse-proxied under
`https://sequentiatestnet.com/bridge/`. CORS is permissive; the API holds no
secrets, and the only public mutating calls create deposit or redemption
intents, rate-limited per client; none moves funds. Redemption records report
their progress toward finality as numbers (`finalityProgress`:
`{depth, need, kind}`), so a page can draw it.

| Method and path | Purpose |
|---|---|
| `GET /api/status` | Bridge configuration and counters: chain ids, vault address, confirmation depths, number of bridged assets, deposits, redemptions |
| `GET /api/assets` | All bridged assets: token, symbol, decimals, Sequentia asset id, ticker, contract hash, circulating amount (`mintedSats`) |
| `GET /api/por` (optionally `?asset=<id\|symbol>`) | Proof of reserves per bridged asset: escrow on each source chain against circulating Sequentia supply, read from the chains rather than the daemon's ledger; an unmeasured side is `null`, never zero |
| `GET /api/token/<address\|eth>` | Metadata for a token and whether it is already bridged (used by the front-end's token lookup) |
| `POST /api/redeem` `{"ethAddress": "0x..."}` | Create a redemption intent; returns the Sequentia address to send bridged assets to |
| `GET /api/redeem/<seqAddress>` | A redemption address's bound Ethereum address and the status of every redemption seen on it |
| `GET /api/deposit/tx/<ethTxHash>` | Look up deposits by their Ethereum transaction hash (used to track and resume deposits) |
| `POST /api/btc/wrap` `{"seqAddress": "..."}` | Bitcoin deposit address for a BTC → SBTC wrap (proxied to the sbtc-bridge) |
| `POST /api/btc/unwrap` `{"btcAddress": "..."}` | Sequentia return address for an SBTC → BTC unwrap (proxied to the sbtc-bridge) |
| `GET /api/btc/wrap/<depositAddress>`, `GET /api/btc/unwrap/<sbtcAddress>` | Every transfer sent to a BTC deposit address or an SBTC return address: amount, confirmations, stage, and the credit or release txid (proxied to the sbtc-bridge) |
| `POST /api/sol/wrap` `{"seqAddress": "..."}` | Solana deposit address for a SOL → SOL.s wrap (the Sequentia address is validated up front) |
| `GET /api/sol/wrap/<solAddress>` | A wrap intent's bound Sequentia address and the status of every deposit seen on it |
| `POST /api/sol/unwrap` `{"solAddress": "..."}` | Sequentia return address for a SOL.s → SOL unwrap |
| `GET /api/sol/redeem/<seqAddress>` | A Solana unwrap address's bound Solana destination and the status of every redemption seen on it |
| `GET /api/sol/intents` | The Solana treasury and every deposit address the bridge has handed out, for anyone checking the Solana escrow |
| `GET /api/redeem/by-eth/<ethAddress>` | The redemption address bound to an Ethereum address, and its redemptions. Each Ethereum (or Solana) destination has one redemption address: asking again returns the same one |
| `GET /api/seqaddress/<address>` | Whether an address is a valid Sequentia address, and whether it is a blinded one; checked before any funds move |
| `GET /api/health` | The operator's health report (see "Watch it and act on what it reports"); HTTP 503 while anything critical is wrong |
| `/api/admin/*` | Operator actions (records, resolve, halt, unhalt, retire-asset); exists only with `adminToken`, and answers 404 without it |

Deposit records move through the statuses `minting`, `mint_retry` and
`send_retry` (a safe retry, with backoff), `unresolved` (a chain write whose
outcome the node could not confirm yet; re-checked every tick), `minted`
(delivered; watched until the delivery is final under Bitcoin anchoring),
`delivery_reorged` (a delivery later displaced on Sequentia), `refund_pending`,
`refunding`, `refunded`, `refund_failed_manual`, and `failed_manual` (paused
for operator review; Solana deposits use `dust_manual` instead of the refund
states). A deposit of a halted asset waits in `mint_retry` with a `waiting`
reason. Redemption records move through `awaiting_finality`,
`awaiting_liquidity`, `halted`, `new`, `releasing`, `release_paused` (the
vault's releases are paused), `released`, `destroy_pending`, `destroying`, `done`,
plus the terminal `dust_ignored`, `ignored_unknown_asset`,
`ignored_wrong_network` (an asset returned to the wrong leg's address),
`release_failed_manual` (the recipient address does not accept the payout)
and `destroy_manual`.

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
git clone --recurse-submodules https://github.com/ConcatenaLabs/compages.git
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
| `vaultAddress`, `vaultDeployBlock` | The primary `CompagesVault` and the block to start scanning from |
| `vaults` | Optional list of `{address, deployBlock}`; the daemon watches every vault in it (`vaultAddress` stays the primary). Omit to watch `vaultAddress` alone |
| `ethFinality` | `finalized` (default): a deposit mints once Ethereum finalizes its block, so no Ethereum reorg can undo a deposit that was already minted. `confirmations`: after `ethConfirmations` blocks instead, for local test chains |
| `ethConfirmations` | Confirmations before a deposit is processed when `ethFinality` is `confirmations` |
| `ethLogChunk` | Max block range per `eth_getLogs` call |
| `operatorKeyFile` | File containing the operator's private key (never commit it) |
| `seqRpcUrl` | Sequentia node RPC, `http://user:pass@host:port` |
| `seqWallet` | Node wallet name; auto-loaded at startup if on disk |
| `seqChainLabel` | Label mixed into redemption ids (prevents cross-chain replay) |
| `seqConfirmations` | Sequentia confirmations; also the finality fallback on chains without anchoring |
| `btcAnchorConfirmations` | Bitcoin-anchor depth required before a release (see "Finality") |
| `registryUrl`, `registryAdminToken`, `assetDomain` | Asset Registry endpoint, optional admin token, and the entity domain written into asset contracts |
| `esploraUrl` | Indexer used to read the circulating supply of assets this bridge did not issue (SBTC on the reserves page). Without it their supply is reported as unknown, never as zero |
| `seqFeeAsset` | Asset id or label the bridge pays all Sequentia fees in (any accepted fee asset the wallet holds) |
| `sbtcBridgeUrl`, `sbtcBridgeToken`, `btcConfirmations` | The sbtc-bridge custody service behind `/api/btc/*` (omit the URL to disable the Bitcoin leg) |
| `solRpcUrl`, `solChainName`, `solChainLabel` | Solana JSON-RPC endpoint and naming for the Solana leg (omit the URL to disable it) |
| `solGenesisHash` | Expected cluster genesis hash, verified before the leg acts (the Ethereum chain-id check's Solana equivalent) |
| `solKeyFile` | 32-byte hex seed for the Solana treasury and deposit-address derivation; generated on first boot, never commit it |
| `solWatchDays` | How long a wrap intent's deposit address is polled (default 7 days); re-requesting a wrap for the same Sequentia address revives it |
| `solMinReleaseSats` | Smallest SOL.s return that is released (default 100000 sats = 0.001 SOL, clear of Solana's rent-exempt minimum) |
| `cctp` | Moving unified-stablecoin escrow from Solana into the Ethereum vault through Circle's CCTP V2: `enabled`, `messageTransmitter` (Circle's MessageTransmitterV2 on the Ethereum chain), `irisUrl` (Circle's attestation service; the sandbox by default), `assets` (default `["USDC"]`), `solFloatUnits` (what stays on Solana for releases there, default 5 USDC), `minConsolidateUnits`, `consolidateEveryMinutes`, `stuckHours` |
| `unified` | Unified stablecoins, keyed by symbol: `name`, `ticker`, `precision`, `supervision` and the `sources` (one per chain) that all mint into the one asset (see "Unified stablecoins") |
| `unifiedIssuerPubkey` | Pinned 33-byte compressed pubkey the bridge wallet controls; hashed into every unified asset id and later authorizes handing the asset to its issuer. Generate once, back up, never change |
| `supervision` (per unified asset) | `enabled` issues the asset as a node-level supervised asset; `pause` additionally allows stopping every holding. Both permanent. `operationalKey`/`recoveryKey` pin the public keys; unset, the daemon derives them from the node wallet once |
| `btcChainName` | Display name of the Bitcoin network behind the SBTC leg (default `Bitcoin testnet4`) |
| `webDir` | Directory of the static web app to serve (default: the repository's `web/`) |
| `apiHost`, `apiPort` | Where the API + web app listen |
| `pollIntervalMs`, `solPollIntervalMs` | Interval of the main loop and of the Solana leg's own loop |
| `adminToken` | Enables `/api/admin/*` and `admin.js` for anyone presenting it. Unset, the admin API does not exist |
| `alertUrl`, `alertToken`, `alertCooldownMinutes` | Where alerts are POSTed (an ntfy topic URL, or anything that takes a plain-text POST), an optional bearer token, and how often an unchanged alert repeats (default 360). Unset, alerts go to the log only |
| `trustProxy`, `intentLimitPerHour` | Take the client address from `X-Forwarded-For` (only behind a proxy you run), and how many intents one client may create per hour (default 30) |
| `solMaxWatchedIntents`, `maxNewAssetsPerDay` | Caps on Solana deposit addresses watched at once (default 1000) and on newly bridged tokens issued per day (default 20) |
| `retryHours`, `unresolvedHours` | How long a safe retry, or an unconfirmable transaction, keeps being tried before it becomes an operator case (default 24 each) |
| `ethStuckMinutes`, `ethTxWaitMs` | When an unmined payout is replaced at the same nonce with higher fees (default 10), and how long one send waits for mining (default 180000) |
| `minOperatorGasWei`, `minFeeAssetBalance`, `minSolTreasuryLamports` | Balances below which the health report and alerts warn (defaults 0.02 ETH, 1 unit, 0.05 SOL) |
| `phaseStaleMinutes`, `invariantIntervalMs`, `gapCheckMinutes` | When a loop phase that keeps failing is reported (default 10), how often supply invariants are checked (default 60000) and how often vault deposit counts are reconciled (default 10) |
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

### 4. Watch it and act on what it reports

`GET /api/health` is the one report an operator needs: when each loop phase
last succeeded, how many records sit in each status and since when, halted
assets, the last supply-invariant check, the balances that stop the bridge
when they run out, and a `problems` list. It answers 503 while anything
critical is wrong, so an uptime monitor can watch it directly. The same
problems are pushed to `alertUrl` once a minute, repeated every
`alertCooldownMinutes` while they last, with one "resolved" note when they
clear.

Supply invariants are checked every minute against the chain: the supply the
Sequentia chain reports may never exceed the daemon's ledger, and for assets
that keep an escrow ledger, circulating supply may never exceed escrow beyond
what is in flight. A breach seen on two consecutive checks halts minting for
that asset until an operator clears it, and an escrow ledger that would go
negative halts payouts too. A halt is sticky on purpose.

Records that need a person, and halts, are handled with `admin.js`, which
talks to the running daemon's admin API (enabled by `adminToken`):

```
node admin.js health
node admin.js records failed_manual
node admin.js show deposits 12
node admin.js retry redemptions <txid:vout> "checked: the release never landed"
node admin.js delivered deposits 12 <seqTxid> "sent by hand"
node admin.js retire redemptions <txid:vout> "recipient can never accept ether"
node admin.js retire-asset <mappingKey> "issued before the chain reset"   # the token's next deposit issues a fresh asset
node admin.js halt <assetId> mint "investigating"
node admin.js unhalt <assetId>
```

`retry` is for when you have checked the chain and nothing from the stopped
step is in flight. Every admin action is recorded in the state file's
`adminLog`.

## The watcher

`watcher/compages-watch.js` is an independent check on the bridge, meant to
run beside the daemon but trusting none of its bookkeeping. It reads the
chains through its own endpoints and, once a minute:

- **Rebuilds every vault's books from the vault's own events**, up to
  Ethereum's finalized block: no token may have left a vault in greater
  amount than entered it, the vault must hold (at that same block) what its
  events say it holds, and the number of deposit events must equal the
  vault's own deposit counter. Logs come from `ethLogsRpcUrl` and balances and
  counters from `ethRpcUrl`, two different providers, so a log source that
  drops events is caught by a counter it did not supply.
- **Checks reserves**: for every bridged asset, circulating supply as the
  block explorer's indexer counts it (`esploraUrl`, issuances minus burns,
  never the bridge wallet) may not exceed what the source chains hold. A gap
  must persist for `breachMinutes` before it counts, since a redemption is
  paid out seconds before its burn.
- **Checks the daemon**: its `/api/health` must answer, and not "failing",
  within `daemonDownMinutes`.

Critical findings go to `alertUrl`, and with `daemonAdminToken` set the
affected assets are halted in the daemon, which stops their minting and
payouts until an operator clears the halt. Payouts at or above
`largePayout[token]` are announced as they happen (`announceEveryPayout`
announces all of them). A JSON report is served on
`127.0.0.1:<statusPort>/status`.

```
cd watcher
npm install
cp config.example.json config.json   # then fill in the URLs and tokens
npm test
npm start
```

A systemd unit for it looks like the daemon's, with
`WorkingDirectory=<checkout>/watcher` and `ExecStart=/usr/bin/node
compages-watch.js config.json`.

## Repository layout

| Path | What it is |
|---|---|
| `contracts/` | Foundry project: `src/CompagesVault.sol`, unit tests, deploy script (`forge-std` as a git submodule) |
| `daemon/` | `compagesd.js`, the Node.js bridge daemon: `lib/bridge.js` (core logic), `lib/eth.js` (Ethereum side), `lib/sol.js` (Solana side: RPC client, keys, transaction builder), `lib/cctp-sol.js` (Circle CCTP V2 on Solana: burn and receive instructions, message parsing, attestation lookup), `lib/seqrpc.js` (Sequentia RPC), `lib/state.js` (persistence), `lib/api.js` (HTTP API + static server), `lib/alerts.js` (push alerts); `admin.js` is the operator CLI |
| `web/` | Static web front-end (no framework, no external dependencies), served by the daemon |
| `watcher/` | `compages-watch.js`, the independent checker (see "The watcher"), with `lib/checks.js` and unit tests |
| `e2e/` | Full-stack end-to-end test: anvil + a mock Solana RPC + Sequentia `elementsregtest` + the real daemon and contracts |

The daemon's only runtime dependency is `ethers`.

## Testing

Contract unit tests (deposits, fee-on-transfer tokens, pausing, release replay
protection, access control):

```
cd contracts
forge test
```

Daemon unit tests (the Solana CCTP V2 encoders and parsers, checked against
fixtures produced by `@solana/web3.js` and Anchor over Circle's program IDLs,
real attestation-service responses and a devnet simulation; no dependency
needed):

```
cd daemon
npm test
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
the unified-asset ceremony (USDC from Ethereum and from Solana landing on one
`USDC.e`), registry metadata binding, and fault injection: the daemon reaches
the node through `e2e/fault-proxy.mjs`, which makes the node go silent right
after a reissuance or a delivery is broadcast, drops the answer to a burn the
node accepted, and the suite kills and restarts the daemon mid-mint. After
each, the user must hold exactly what they deposited and the supply the chain
reports must equal the daemon's ledger. Requires foundry, node >= 20 and a
build of the Sequentia node (`sequentiad`/`sequentia-cli`; set `SEQ_REPO` to
your checkout of the
[Sequentia repo](https://github.com/ConcatenaLabs/Sequentia),
the script looks in `build-linux/src` then `src`);
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
[`Sequentia/doc/sequentia/`](https://github.com/ConcatenaLabs/Sequentia/tree/HEAD/doc/sequentia).

| Repo | One-liner |
|---|---|
| [`Sequentia`](https://github.com/ConcatenaLabs/Sequentia) | The Sequentia node (Sequentia Core, `sequentiad`; a fork of Elements 23.3.3): consensus, anchoring, proof of stake, open fee market, plus the canonical protocol documentation in `doc/sequentia/`. |
| [`sequentia-registry`](https://github.com/ConcatenaLabs/sequentia-registry) | Sequentia Asset Registry service (asset metadata). |
| [`sequentia-explorer`](https://github.com/ConcatenaLabs/sequentia-explorer) | Sequentia block explorer frontend (esplora fork); the indexer lives in sequentia-electrs. |
| [`SWK`](https://github.com/ConcatenaLabs/SWK) | Sequentia Wallet Kit: a fork of Blockstream LWK; Rust wallet library, CLI, and WASM bindings for building Sequentia (and Bitcoin testnet4) wallets. |
| [`seqdex`](https://github.com/ConcatenaLabs/seqdex) | SeqDEX: non-custodial atomic-swap DEX; P2P order book (seqob), same-chain swaps, and cross-chain BTC↔asset swaps made safe by Bitcoin anchoring. |

## Contributing

Development happens on `main`; open pull requests against it. Before
committing, run `forge test` and, for daemon changes, `npm test` in `daemon/`
and `e2e/run-e2e.sh`.
Never commit `config.json`, `operator.key`, or state files (they are
`.gitignore`d; keep it that way).

## License

MIT, see [`LICENSE`](LICENSE). The Solidity sources carry matching SPDX
identifiers.
