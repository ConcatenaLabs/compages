# A bridged asset served issuer-operated by an Arca operator

An Arca operator can serve a Compages asset **issuer-operated**: instead of
funding each batch from coins it holds, it reissues the asset in the round
that makes the batch, through the asset's own mint limiter, and every sweep
of such a batch can only burn (arca `server/README.md`, "Issuer-operated
assets"). This page is what that means for the bridge's reserves, how
Compages accounts for it, and how to set it up.

## Why the accounting must know

A refresh mints the batch's value in its round while the coins the holders
gave up for it (a board, or an older batch's leaves) still exist. Until the
old batch is swept, the asset's supply counts the same holding twice; and
nothing on Ethereum backs the round's mint. A reserve check that compares
supply with escrow reads that as inflation and halts the bridge, which is
right for any mint that is not under a burn-only sweep and wrong for these.

So every reserve check of Compages deducts, before it compares supply with
escrow, the smaller of two figures:

    live      the units live under the operator's burn-only sweeps: the
              unspent outputs of the asset's burn-only batches (each batch
              output, and each node and entry of a batch a holder unrolled)
    net mint  what the operator's rounds minted, less what the operator
              burned (its sweeps, its claims of forfeits, the margins it
              burns)

    escrow  >=  supply  -  min(live, net mint)

Each figure guards against what the other cannot see:

- **`net mint` makes every mint outside a deposit a listed round's.**
  Supply less `net mint` is exactly what deposits minted, less what anyone
  but the operator burned. A mint through the limiter that is neither a
  deposit's nor one of the operator's rounds raises the supply and nothing
  else, so it shows at once, whatever the batches hold.
- **`live` makes every unit outside the batches backed.** A unit that leaves
  a batch other than by a burn (a holder's exit, an offboard) is no longer
  deducted, so a round's unit that the operator made for a key of its own
  shows once it is taken out, unless the batches still hold more than the
  operator's net mint.
- **Holders' fees paid in the asset, and coins abandoned past their batch's
  expiry**, are burned with the batch or the coin they ride on, so the
  supply falls by them. They stay counted as escrow's to back: the chain
  cannot tell a burned abandoned leaf from burned refresh liquidity, and
  escrow is never credited with a surplus it might owe to a holder.

## Nothing is taken on the operator's word

Each check asks the operator for its `issuer_supply` report and reads every
part of it again on the chain (`daemon/lib/burnonly.js`):

- a **mint** counts when its transaction is in a block of the active chain
  and issues exactly the amount listed;
- a **burn** counts when its transaction is in such a block and pays exactly
  the amount listed to bare `OP_RETURN` outputs of the asset;
- a **live output** counts when it is unspent in a block, holds the asset
  explicitly with the value listed, its round is in the chain, its batch's
  published tree (`tree`) is burn-only in the asset, and the output is where
  that tree puts it: the batch output with the tree's top script, a node
  with its published script and value, or an entry made by unrolling one of
  the tree's lowest nodes.

What does not check out is left out of its figure and named in the report's
`problems`; an operator that lists less only makes the check stricter. A reorg that takes a round and its sweep out of the chain takes
both out of the accounting together, since each pass reads them again on the
chain as it stands, and the chain that replaces them counts them again.

## Where each check reads it

| Check | Supply from | Outputs read on | What happens on a shortfall |
|---|---|---|---|
| Daemon invariants (`checkInvariants`) | the wallet's issuances, the limiter's mints the operator lists, every other limiter mint it followed, less its own and the operator's burns | the bridge's node (needs `-txindex`) | the asset's minting halts after two passes |
| `/api/por` | as the invariants | the bridge's node | `backed: false` |
| The watcher | the indexer's issued less burned, in blocks | its own indexer (`esploraUrl`) | after `breachMinutes`, a critical problem: the asset halted in the daemon, and the vault paused with a guardian key |
| Signed snapshot | the supply auditor at H | the snapshot tool's node (needs `-txindex`) | `backed: false` in the signed record |

The daemon also follows the limiter's coin: a mint through the limiter that
the daemon did not make is expected once the operator lists it among its
rounds' mints and the node shows it minting what the list says. Until it is
listed (an operator lists a round once it is in a block) the daemon waits;
after `issuerMintGraceMs` (30 minutes by default) an unlisted mint halts the
asset, and its amount counts in the supply from then on.

A signed snapshot at a past height H records each output live at H: those
the operator lists now that the chain shows made at or below H, and every
output of the asset's burn-only batches made at or below H and spent in a
block above it, with its spender; and each of the operator's mints and burns
in a block at or below H. `verify.mjs --rederive --seq-rpc …
--operator …` reads each one again: made at or below H, holding what the
snapshot says, live at H, and where its tree puts it; and each mint and burn
in a block at or below H with its amount.

## What the check cannot see

Inside a round the operator lists, the chain cannot tell a holder's leaf or
offboard from one `arcad` makes for a key of its own. The signer checks
everything else about a round's mint, and the limiter bounds it by its
allowance per window; such a unit shows once it leaves the batches, as long
as the batches do not hold more than the operator's net mint. This is the
issuer-operated profile's residual, stated in arca's design; serve a bridged
asset this way only from an operator the bridge's operator runs, with its
signer on a machine of its own.

The burn-only flag is the published tree's. Compages does not rebuild the
tree's scripts (Arca wallets do, before they accept a leaf); a batch whose
sweep paid the operator would show as a rise in the supply less `net mint`
at its sweep.

## Setting it up

The operator serves the asset with its signer holding the limiter's operator
mnemonic, the same one the daemon mints deposits with
(`mintLimiter.operatorMnemonicFile`): arca `doc/operator-procedure.md`,
"Serving an asset issuer-operated". Its `[assets.issuer]` section names the
instance (the daemon's `/api/assets` → `mintLimiter.instance`, without its
`address`), the asset's entropy, and the limiter's current coin and state.
The daemon and the signer then both mint through the limiter, the daemon for
deposits and the signer for rounds; each follows the other's mints.

Then, in each of the three configurations, name the asset and its operator:

    "issuerOperated": { "<asset id>": "https://<operator>" }

- the daemon (`daemon/config.json`), with `issuerMintGraceMs` and
  `burnOnlyRefreshMs` (how often the report is read again, 5 s by default)
  if the defaults do not suit; its node needs `-txindex`;
- the watcher (`watcher/config.json`): its own entry, never the daemon's
  word, so a compromised daemon cannot point it at a report of its making;
- the snapshot tool (`reserves/config.json`); its node needs `-txindex`.

`/api/assets` names the operator of each asset served so
(`issuerOperated`), and `/api/por` reports, beside the chain's supply, the checked report
(`burnOnly`: both figures and the deduction, the operator's own figures,
each mint, burn and output with whether the chain confirmed it), and what
escrow must cover (`liabilityAtoms`).

An Arca operator does not serve a supervised asset (USDC.e, EURC.e)
issuer-operated: its server refuses the two profiles together, since an
issuer-operated batch is not kept in `landing-1` leaves.

