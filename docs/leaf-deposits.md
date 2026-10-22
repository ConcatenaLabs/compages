# Deposits paid as Arca leaves: runbook

A deposit on Ethereum can arrive on Sequentia as a leaf of an Arca operator,
paid out of round into the depositor's receive request, instead of as an
on-chain coin. The README's "Deposits paid as Arca leaves" says how the route
works for a depositor; this page is for the operator who runs it. The route is
reachable through the API and the wallets' developer mode only: the bridge's
web page does not offer it.

## What it rests on

- **A mint limiter for the asset.** A leaf is minted by the asset's mint
  limiter straight into the leaf wallet; an asset that does not mint through
  one is refused at the intent, and the daemon refuses leaf deposits
  altogether without `mintLimiter`.
- **An operator that serves the asset.** The operator lists it in its
  configuration (`[[assets]]`) and reloads (SIGHUP). An asset is bridged
  first, by an ordinary on-chain deposit; only then does it have an id the
  operator can serve.
- **The bridge's own leaf wallet.** An `arca` wallet on that operator, made
  for the bridge alone: never the bridge's node wallet, a reserve, the
  treasury or another service's wallet. Its on-chain side holds coins of the
  accepted fee asset the boards pay in (`leafWallet.feeAsset`, by default the
  bridge's `seqFeeAsset`), which the daemon tops up from the node wallet's own
  stock of it, the stock that pays every Sequentia fee of the bridge
  (`leafWallet.feeTopUpBoards`, recorded in `leafFeeTopUps`); it holds a
  bridged asset only between a deposit's mint and its payment.
- **Landing keys, for a supervised asset.** The operator serves an asset
  whose issuer can freeze a holding (a supervised asset: the unified
  stablecoins are) under the supervised profile, in `landing-1` leaves only,
  and says so in `info`'s `assets[].supervised` with its
  `landing_allowance`. Every such leaf names a landing key, a P2WPKH key of
  its holder's own, where its exit pays and where the issuer's freeze
  follows it. The depositor's request must name the depositor's landing
  (`landing`), and the leaf wallet holds the deposit between the board and
  the payment in a `landing-1` leaf at its own landing key, which the leaf
  wallet's `info` shows as `landing_address`. An open asset needs neither.
- **No float.** Nothing is minted ahead of a deposit, so circulating supply
  never exceeds escrow. What the leaf wallet holds at any moment is owed to
  deposits not paid yet, and `/api/por` counts it as held by the bridge.

## Setting it up

1. Build `arca` from `ConcatenaLabs/arca` at the revision the operator runs.
   To pay a supervised asset that revision must have `landing-1` leaves
   (arca's wallet with a landing key; `.github/workflows/ci.yml` pins the
   revision the suite runs): an older `arca` shows no `landing_address`, and
   the daemon then refuses intents for every supervised asset. An existing
   leaf wallet's directory is kept when its `arca` is replaced: the landing
   key comes from the wallet's own seed.
2. Make the wallet on the operator, with the default exit delays, which must
   fall within the operator's published bounds (`info`'s `exit_delay_units`):

       arca --datadir /var/lib/compages/leaf-wallet create \
         --server https://<operator> --node-url http://127.0.0.1:<rpc port>/ \
         --node-user <rpc user> --node-password-file <file holding the password>

   Compare the operator key it prints with the one the operator publishes.
3. Leave its fee coins to the daemon, which tops them up from its own fee
   asset once it runs; with a `feeAsset` other than `seqFeeAsset`, fund them
   from a wallet you name (`arca --datadir … address` gives the address).
4. Configure the daemon (`leafWallet` in the configuration reference: `arca`,
   `datadir`, `feeAsset`) and restart it. The start-up log names the leaf
   wallet's operator, chain, the assets the operator serves and how many of
   them are supervised, and the leaf wallet's landing address (or a warning
   that it has none).
5. Have the operator serve each bridged asset the bridge pays as leaves. It
   serves a supervised asset under the supervised profile by itself, once its
   node lists the asset as supervised; its signer then reads freezes from a
   node of its own (`arca-signer --supervision-node … --supervision-cookie …`).

## A deposit's path, and its records

`POST /api/leaf/intent` checks the request and answers a fresh address of the
node wallet; the deposit names it. When the deposit lands the daemon checks
the request again (operator, chain, asset served, for a supervised asset a
landing named and a leaf wallet with a landing key, unused, lapsing no sooner
than `landingLapseSeconds`, above the smallest leaf). An intent for a
supervised asset whose request names no landing is refused at
`POST /api/leaf/intent` with a 400 (`… is a supervised asset: its leaf lands
only at its receiver's own landing key, and the receive request names no
landing …`), and one an operator began serving as supervised after the
intent takes its fallback when the deposit lands. A deposit that fails
takes the intent's fallback, an on-chain delivery to its `fallbackAddress` or
a refund on Ethereum, and its record says why (`leaf.fallbackReason`).

Otherwise the deposit goes through these statuses:

| Status | Meaning | Step marker |
|---|---|---|
| `minting` | the limiter mint into the leaf wallet, with the crash rules of every mint | `pendingMint`, `mintCandidate`, `mintTxid` |
| `leaf_minted` | in the leaf wallet on the chain, waiting its turn to board | `pendingLeafBoard` while the board is asked for |
| `leaf_boarding` | the board in flight, until its transaction is final | `leafBoard` (its txid and leaf id) |
| `leaf_paying` | the payment out of round | `pendingLeafPay` while it is asked for |
| `minted` | paid: `leaf.paid` holds the leaf's value, the margins and the transfer | `leafPay` |
| `leaf_held` | the request can no longer take the leaf (it lapsed, the operator refused the payment, or the issuer froze the bridge's landing); the leaf stays in the leaf wallet, owed to the deposit | |

The wallet records a board and a payment before it asks the operator, so a
crash at any point is settled from the wallet: a board asked for and never
recorded is found among the wallet's board coins (a coin of the deposit's
amount that was not there before); a payment asked for and never recorded is
found as the deposit's coin spent by a transfer, is waited on while the coin
is `sending` (each sync posts it again), and is made afresh only when the
coin is still live. The operator refuses a second payment to one request's
key, so a request is never paid twice whatever happens to the daemon.

One asset's deposits are boarded and paid one at a time, so the wallet holds
a single live coin of the asset when it pays. The payment takes that coin
whole: the margins its pre-signed transactions leave come out of it, priced
by the wallet's own refusal of an amount it cannot pay, before anything is
signed. A `leaf_held` deposit keeps its asset's turn: the asset's later leaf
deposits mint and wait behind it until an operator pays it.

## The time it takes

A deposit waits for Ethereum's finality (about 13 minutes on mainnet and
Sepolia), the limiter mint (the limiter's coin must be two blocks old, so one
mint per two blocks per asset), the board's finality (its block certified and
its anchor buried two Bitcoin blocks: about 20 minutes on Bitcoin, longer on
testnet4 when its blocks come slowly), and the payment (about a second).
Deposits of one asset queue behind each other's board.

A float of leaves minted ahead would pay at Ethereum's finality alone, but it
is supply minted with no deposit behind it, held off the chain where only the
operator's word shows whose it is. Per-deposit minting keeps the backing
provable from the two chains alone, at the cost of the board's finality.

## Reserves

`/api/por`'s `reconciliation` breaks each asset's supply down: what the node
wallet holds, what the leaf wallet holds (on the chain, in boards in flight,
in leaves, and a leaf mint still in the mempool), what users hold, what is
owed to deposits not delivered and what users returned that is not released.
Escrow equals users' holdings plus owed plus returned at every step of a leaf
deposit. `leaves` lists the boards in flight, the leaves paid out and the
margins. The watcher checks every board against its own indexer and
reconciles the figures against the escrow and supply it read itself; the
signed snapshot records the same figures, each board's block checked against
its height.

A supervised asset changes none of this. Its leaves are minted per deposit
like any other, its supply is read from the chain, its escrow from the vault,
and the reconciliation adds up the same way; a coin held in a `landing-1`
leaf is counted where any leaf is. An issuer-operated asset is another
matter, which this page does not cover: its units live under burn-only
sweeps, counted from the operator's `issuer_supply.in_batches`, and holders'
fees and abandoned coins in it are burned rather than kept.

## When something needs a person

- **`leaf_held`** (health: `leaf:held`). Ask the depositor for a new receive
  request from the same wallet, then

      node admin.js leaf-pay <deposit key> <receive request>

  which checks it as an intent is checked and pays the held leaf into it.
  `admin.js retry` and `delivered` refuse a leaf deposit that has minted: its
  mint is in the leaf wallet, not the node wallet. For a supervised asset
  the new request must name the depositor's landing, as at the intent.
- **`leaf_held` because the issuer froze the bridge's landing** (the
  reason names the landing, or says the asset is paused). The operator
  co-signs nothing that spends the coin while the freeze stands, so nothing
  can pay it, and it stays owed to the deposit. Ask the issuer why the
  bridge's landing (the leaf wallet's `landing_address`) is frozen. Once it
  lifts the freeze, pay the deposit with `admin.js leaf-pay` as above. While
  it stands, the leaf wallet's `sync` takes the coin home before its exit
  date, into the landing key on the chain, where it stays frozen; a coin
  that has gone home is no longer a leaf that `leaf-pay` can pay, and is
  settled by hand from the leaf wallet once the freeze is lifted.
- **Intents for a supervised asset refused with a 503** (`… the bridge's
  leaf wallet has no landing key …`), and the start-up log's warning: the
  leaf wallet's `arca` predates landing keys. Rebuild it at the operator's
  revision (step 1 of setting it up) and restart the daemon.
- **`leaf:sync`**: the leaf wallet's sync failed (its operator or node
  unreachable). Deposits wait; nothing is lost. `arca --datadir … sync` by
  hand says why.
- **`leaf:fees`**: the daemon could not top up the leaf wallet's fee coins;
  the node wallet is short of `seqFeeAsset`, which every Sequentia fee of
  the bridge needs anyway. Fund the node wallet.
- **A deposit waiting in `leaf_minted`** with `waiting` saying the board was
  refused: the leaf wallet has no fee coin, or the operator no longer serves
  the asset. See `leaf:fees`, or have the operator serve the asset again.
- **The wallet's own coins.** The daemon runs `arca sync` on the schedule the
  wallet gives, which keeps any coin it holds alive; between deposits it
  holds none of a bridged asset.
