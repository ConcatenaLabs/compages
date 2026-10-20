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
- **No float.** Nothing is minted ahead of a deposit, so circulating supply
  never exceeds escrow. What the leaf wallet holds at any moment is owed to
  deposits not paid yet, and `/api/por` counts it as held by the bridge.

## Setting it up

1. Build `arca` from `ConcatenaLabs/arca` at the revision the operator runs.
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
   wallet's operator, chain and the assets the operator serves.
5. Have the operator serve each bridged asset the bridge pays as leaves.

## A deposit's path, and its records

`POST /api/leaf/intent` checks the request and answers a fresh address of the
node wallet; the deposit names it. When the deposit lands the daemon checks
the request again (operator, chain, asset served, unused, lapsing no sooner
than `landingLapseSeconds`, above the smallest leaf). A deposit that fails
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
| `leaf_held` | the request can no longer take the leaf (it lapsed, or the operator refused the payment); the leaf stays in the leaf wallet, owed to the deposit | |

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

## When something needs a person

- **`leaf_held`** (health: `leaf:held`). Ask the depositor for a new receive
  request from the same wallet, then

      node admin.js leaf-pay <deposit key> <receive request>

  which checks it as an intent is checked and pays the held leaf into it.
  `admin.js retry` and `delivered` refuse a leaf deposit that has minted: its
  mint is in the leaf wallet, not the node wallet.
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
