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
and can only be moved by the bridge's keys; minting on Sequentia and releases
on Ethereum are actions the operator performs. If the operator disappears or
misbehaves, bridged funds are lost. Users trust the operator. This is a
demonstration of the bridging mechanics, not a trust-minimized design.

Within that assumption, the design removes every failure mode it can:

- Releases and refunds are keyed by deterministic ids and replay-guarded on
  chain (`processedRedemptions`), so nothing can be paid twice.
- The vault splits its authority across three keys (see "The vault
  contract"): a cold owner, a hot operator whose immediate payouts are
  rate-limited per token, and a guardian that can only stop things. A
  payout over the limit waits in a timelocked queue where it can be
  cancelled, so a leaked operator key cannot empty the vault at once.
- A payout the recipient cannot accept (a contract that rejects ether, a
  blocklisted address) never blocks a redemption: the vault records the
  amount as owed and the recipient claims it to any address it chooses.
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
| Vault contract | `CompagesVault` on Sepolia at [`0x7B702D6A2E2351F0c4E549642e65AbABC0324384`](https://sepolia.etherscan.io/address/0x7B702D6A2E2351F0c4E549642e65AbABC0324384), which takes deposits. Two earlier vaults, [`0xd72AF53b…`](https://sepolia.etherscan.io/address/0xd72AF53b4F0551A25072cC72A29F699Ed9d8Ed41) and [`0x15b3c97e…`](https://sepolia.etherscan.io/address/0x15b3c97ed82c62b7828a775456bd75e67a8ec42c), accept no new deposits; the daemon still watches all three |
| Unified stablecoins | `USDC.e` and `EURC.e`, precision 6, fed from Sepolia and the Solana devnet, node-level supervised (see "Unified stablecoins") |
| Bitcoin ↔ SBTC (wrap, unwrap) | Address-based, proxied to the sbtc-bridge custody service (`/api/btc/*`); only for uses that need bitcoin on the Sequentia chain, since Sequentia wallets hold native bitcoin directly |
| Solana ↔ Sequentia (wrap, sweep, unwrap; SOL and any SPL token) | Implemented natively in the daemon (`daemon/lib/sol.js`, no extra dependency) |
| Asset Registry integration | Bridged assets are registered with origin-suffixed tickers (`SYMBOL.e` Ethereum, `SOL.s` Solana), bound on-chain via the issuance contract hash |
| Web front-end | Served by the daemon itself at https://sequentiatestnet.com/bridge/: `web/index.html`, `web/app.js`, `web/abi.js` (the hand-written encoding of the few contract calls the page makes) and `web/qr.js` (the page's own QR encoder) |

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
   from any Sequentia wallet works. A confidential (blinded) `tsqb1...`
   address works too and hides the amount received on chain, except for
   supervised assets (USDC.e, EURC.e): consensus never lets one sit in a
   blinded output, so the bridge delivers it to the same address's
   transparent `tb1...` form, the same wallet with the amount visible. The
   page checks the address with the bridge's node as you type and keeps the deposit
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
   Ethereum wallet connected, the page shows its redemption address for the
   chain chosen under "Receive on", and its redemptions, without asking.
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

"Receive on" chooses where USDC.e is paid out: Sepolia, or another EVM chain
Circle's CCTP reaches from the vault. Every other asset is always paid on
Sepolia. A redemption address is bound to the address and the chain
together, and "Receive on" always shows the chain of the redemption address
on screen. For a payout on another EVM chain the vault burns the USDC on
Sepolia; once Circle has attested the burn, the page offers "Claim on
<chain>", which switches your wallet to that chain and sends the attested
message there. Anyone may send it, and it mints only to the recipient the
burn names; once it is mined the page shows "Claimed" with the transaction.
To receive USDC.e on Solana, use the Solana leg's unwrap address instead.

A payout larger than the vault's rate limit waits in the vault's queue, and
the page shows when it goes out. The bridge's guardian can stop a queued
payout; the page then says so, and the operator decides what happens next.
When the receiving address refuses a payout (a contract that rejects plain
ether, for example), the vault holds it for that address, and the page
offers "Claim": connect that account on Sepolia, choose where the funds
should go, and the vault pays them there. Refunds of undeliverable deposits
behave the same way.

### USDC from another chain

Choose "USDC from another chain" in the "Bridge from" selector to bridge USDC
from a chain other than Sepolia over Circle's CCTP. Pick the chain, enter the
amount and your Sequentia address, and confirm. The page switches your wallet
to that chain (adding it when the wallet does not know it), asks you to let
Circle's TokenMessenger spend the USDC, and burns it with the bridge's vault
named as the only party allowed to complete the transfer. The page reports
the burn to the bridge as soon as your wallet returns its hash, so it
completes even if you close the page. Circle attests a burn once its chain
finalizes it, typically 15 to 30 minutes on these testnets; the bridge then
relays it to the vault, and the deposit mints USDC.e once Sepolia finalizes
the relay, about 15 more minutes. USDC.e is the same asset as USDC bridged
from Sepolia or Solana. The page follows each stage and remembers the last
burn. A burn made elsewhere, in another tab or on another device, is picked
up by entering its chain and transaction hash in the "Track a burn" box.

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
   Once a BTC deposit has one confirmation and Sequentia has anchored the
   Bitcoin block holding it, you receive SBTC 1:1 (a Bitcoin reorg that undid
   the deposit would then undo the credit too); a Solana deposit is
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
Bitcoin leg looks up any Bitcoin deposit address or SBTC return address. A
banner at the top names any asset whose minting the operator has paused.

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
Ethereum itself. When the vault can receive CCTP (`receiveCctp`), the burn
names the vault as the only relayer and the relay goes through it, so the
arrival is recorded on the vault as `RebalancedIn`; an older vault simply
receives the mint. Either way the message's nonce says whether it was
already relayed. Between the
burn and the mint the amount is in transit: the reserves page
(`inTransitAtoms`, with each Solana burn listed) and the supply invariant
count it as backing, so a move in flight never reads as a shortfall.

Each Solana burn leaves a small account holding Circle's record of the
message, paid for from the treasury. Circle's program lets the payer close it
five days after the burn; the daemon does so automatically, with the same
persist-before-broadcast guard, and the rent returns to the treasury.

### USDC from and to other chains

USDC.e is one asset whichever chain the dollar came from, and Circle's
Cross-Chain Transfer Protocol (CCTP) connects the bridge to every chain
Circle supports, not only Ethereum and Solana:

- **In.** On any chain in the bridge's CCTP list (`GET /api/status`, `cctp`),
  a user burns USDC with Circle's TokenMessenger, naming the deposit vault as
  mint recipient and as the only relayer, with hookData
  `compages:deposit:<Sequentia address>`. The page builds that call and
  reports the burn (`POST /api/cctp/deposit`); the daemon waits for Circle's
  attestation and relays it through the vault's `receiveCctp`, which mints the
  USDC into the vault and emits an ordinary deposit. From there it is minted
  as USDC.e like any other deposit. A burn with an invalid Sequentia address,
  or hookData the vault does not recognise, is refunded to the chain and
  sender it came from (`refundViaCctp`).
- **Out.** A redemption address can name another CCTP chain as its
  destination (`POST /api/redeem` with `destinationDomain`). USDC.e returned
  to it is paid out there: the vault burns the USDC (`releaseViaCctp`) for
  minting to the recipient, and the redemption record carries `cctpOut` with
  Circle's attestation once it exists, so the recipient (or anyone) can
  complete the mint on that chain with `receiveMessage`. Any other asset
  returned to such an address is paid on Ethereum, to the same address.
- **Solana.** A USDC.e redemption to Solana that the Solana float cannot
  cover is paid out of the Ethereum vault the same way, and the daemon relays
  the mint on Solana itself (creating the recipient's USDC account first when
  it has none).

### The vault contract

`CompagesVault` (`contracts/src/CompagesVault.sol`) holds the Ethereum-side
escrow. It is deliberately not upgradeable; a new version is a new
deployment. Its `VERSION` constant says which one an address runs.
`contracts/deployments/sepolia.json` records each Sepolia vault's address,
deploy block and transaction, source commit, compiler settings and constructor
arguments; every one is source-verified on Sourcify and Blockscout, and
rebuilding its source commit reproduces the deployed bytecode exactly.

**Roles.** Three keys, set at deployment:

| Role | Intended holder | Can |
|---|---|---|
| `owner` | a Safe or a cold key | set the other roles and every limit, unpause, reinstate, amend or discard cancelled releases, move unreserved escrow with `rebalanceOut` and add ether escrow with `fundEther`, configure CCTP and the stablecoin burner. Transferred in two steps (`transferOwnership`, then `acceptOwnership` by the new owner) |
| `operator` | the daemon's hot key | `release`, `refund`, `releaseViaCctp` and `refundViaCctp`, nothing else |
| `guardian` | an incident-response key | `pauseDeposits`, `pauseReleases` and `cancelRelease`; never unpause, never move funds |

**Rate limit and queue.** Each token (address zero for ether) has a token
bucket set by `setReleaseLimit(token, capacity, refillPerSecond)`. A release
or refund that fits in the bucket pays at once; one that does not is queued
for `releaseDelay` seconds (between one hour and 30 days) and emits
`ReleaseQueued`. After the delay anyone may call `executeRelease(id)`. During
it the guardian or owner can `cancelRelease(id)`. A cancelled release stays
with the owner, who can `reinstateRelease(id)` (queued again with a fresh
delay), first `amendCancelledRelease` its destination (a different recipient,
or switching between a direct and a CCTP payout, keeping the token and
amount), or `discardCancelledRelease(id)` it for good once `releaseDelay` has
passed since the cancel (`releaseDiscardableAfter(id)`), which is how a bogus
entry queued with a stolen operator key is cleared. A token with no bucket has capacity
zero, so every payout of it is queued. A newly configured bucket starts empty
and fills at its refill rate, and reconfiguring one never tops it up. An id is
marked processed the moment it is paid or queued, and a cancelled id stays
spent. `availableToRelease(token)` and `queuedRelease(id)` show the current
state.

Queued releases and cancelled ones the owner may still reinstate are
reserved, like owed amounts: no immediate payout and no rebalance can spend
the escrow they will need. A release is refused outright, paid now or queued,
when the unreserved balance cannot cover it, so the queue never promises more
than the vault holds and a stolen operator key cannot reserve a token away.
Queued releases draw on the escrow first come, first served: executing one
holds back only owed and cancelled amounts.

**Owed payouts and claims.** Before paying or queuing, the vault requires its unreserved
balance (balance minus what it owes claimants and what queued and cancelled
releases hold, shown by `unreservedBalance(token)`) to cover the amount, and
otherwise reverts with `InsufficientVaultBalance` so the payout can be retried
later. If the transfer itself fails, the amount becomes owed to the recipient
(`ReleaseDeferred`), stays reserved, and the recipient calls
`claim(token, payTo)` to withdraw it to any address. Only the recipient itself
can claim, so a contract that can neither accept the payout nor make calls can
never collect what it is owed. `Released`, `Refunded` and the CCTP payout
events are emitted only when funds actually leave.

**Adding escrow.** Tokens arrive by plain transfer. Ether has no such path,
since the vault has no `receive()`: the owner adds it with `fundEther()`,
which emits `RebalancedIn` with the source domain `FUNDING_DOMAIN`
(`type(uint32).max`) and creates no deposit.

**Deposit rules.** The owner can set a per-token minimum (`setMinDeposit`), a
cap on the vault's balance after a deposit (`setDepositCap`, zero for none),
and refuse a token outright (`setTokenBlocked`). Deposits credit the balance
actually received, so fee-on-transfer tokens bridge the post-fee amount.
Rebasing tokens are not supported: a balance that shrinks can leave owed
amounts unbacked.

**USDC over CCTP.** Once the owner points the vault at Circle's CCTP V2
contracts (`setCctp(tokenMessenger, messageTransmitter, usdc)`), USDC can
arrive from and leave to other chains while staying in this one escrow:

- *Inbound.* A burn on the source chain names the vault as `mintRecipient`
  and as `destinationCaller`, and anyone relays it with
  `receiveCctp(message, attestation)`. The `destinationCaller` matters: a burn
  that leaves it empty can be relayed straight to Circle's transmitter,
  around the vault, and its USDC then arrives with no event, as an
  unaccounted donation. Its hookData decides what it is. The ASCII bytes
  `compages:deposit:` followed by a Sequentia address (14 to 120 bytes) make
  a deposit, which emits `Deposited` (with `from` zero) and
  `CctpDeposit(nonce, sourceDomain, sender, cctpNonce, amount)` under the same
  deposit number. Exactly `compages:rebalance` is liquidity from another
  escrow and emits `RebalancedIn`. Anything else, a malformed deposit
  included, is still received, because nothing but the vault could ever
  complete it, and is reported with `CctpUnrecognized(sourceDomain, sender,
  cctpNonce, amount, hookData)` so it can be refunded with `refundViaCctp`;
  like a deposit, it waits out a deposit pause, so nothing new becomes
  burnable while the supply is locked.
  A burn that names the vault as `destinationCaller` but mints to someone
  else is relayed too, for the same reason: it credits nothing, emits
  `CctpForwarded(sourceDomain, mintRecipient, cctpNonce)`, and reverts if it
  would change the vault's USDC balance. The vault relays only messages
  addressed to Circle's TokenMessenger.
  The amount credited is the USDC balance change across the mint. A deposit
  is refused while deposits are paused and can be relayed again afterwards;
  the deposit minimum, cap and token block do not apply, since the dollars
  are already minted and the daemon refunds what it cannot bridge.
- *Outbound.* `releaseViaCctp(amount, destinationDomain, mintRecipient,
  redemptionId, maxFee)` burns USDC here for minting on another chain, under
  the same replay map, USDC rate limit, queue and pause as `release`, at
  Circle's finalized threshold. It emits `ReleasedViaCctp`, and
  `refundViaCctp` emits `RefundedViaCctp`. The vault approves exactly the
  amount for each burn and resets the approval afterwards.

**Supply lock and stablecoin hand-off.** Pausing both deposits and releases
freezes the escrow against the circulating supply. With the supply locked, the
burner named by `setStablecoinBurner` can call `burnLockedUSDC()`, which burns
the stablecoin's whole balance except what is committed to individual users:
amounts owed to claimants, releases still in the queue, and cancelled releases
the owner may still reinstate. Those are paid out as normal afterwards, and a
guardian cancel can never make a user's escrow burnable. The burn uses the
token's own `burn`, so on USDC the issuer first makes the vault a minter; see
"Rehearsing the hand-off to Circle".

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
the burn block to be committee-certified. If the node cannot report its
anchor status, or does not validate anchors, nothing is final and releases
wait. Only a local test chain that has no anchoring at all sets
`allowUnanchoredFinality`, which falls back to a count of
`seqConfirmations` Sequentia blocks.

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
intents, rate-limited per client (`intentLimitPerHour`); none moves funds.
The heavier reads (`por`, `seqaddress`, `token`, `health`) have their own
per-client limit (`readLimitPerHour`), and IPv6 clients are counted per /64.
Error text in responses never carries an RPC URL. Redemption records report
their progress toward finality as numbers (`finalityProgress`:
`{depth, need, kind}`), so a page can draw it.

| Method and path | Purpose |
|---|---|
| `GET /api/status` | Bridge configuration and counters: chain ids, vault address, confirmation depths, number of bridged assets, deposits, redemptions |
| `GET /api/assets` | All bridged assets: token, symbol, decimals, Sequentia asset id, ticker, contract hash, circulating amount (`mintedSats`), and whether the asset is `supervised` (freezable by its issuer and never blinded) |
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
| `POST /api/cctp/deposit` `{"sourceDomain": 6, "txHash": "0x..."}` | Report a USDC burn made on another CCTP chain for relaying (see "USDC from and to other chains") |
| `GET /api/cctp/deposit/<domain>/<txHash>` | Where a reported burn stands (`attesting`, `relaying`, `relayed`, `not_found`, `not_for_bridge`) and the deposit it became |
| `GET /api/redeem/by-eth/<ethAddress>` (optionally `?domain=<cctpDomain>`) | The redemption address bound to an Ethereum address, and its redemptions. Each Ethereum (or Solana) destination has one redemption address: asking again returns the same one. An address can have one per payout chain; `?domain=` picks the one paying out on that CCTP domain (0 is the vault's own chain) |
| `GET /api/seqaddress/<address>` | Whether an address is a valid Sequentia address, whether it is a blinded one, and for a blinded one its `unconfidential` form (where supervised assets are delivered); checked before any funds move |
| `GET /api/health` | The operator's health report (see "Watch it and act on what it reports"); HTTP 503 while anything critical is wrong |
| `/api/admin/*` | Operator actions (records, resolve, halt, unhalt, retire-asset); exists only with `adminToken`, and answers 404 without it |

Deposit records move through the statuses `minting`, `mint_retry` and
`send_retry` (a safe retry, with backoff), `unresolved` (a chain write whose
outcome the node could not confirm yet; re-checked every tick), `minted`
(delivered; watched until the delivery is final under Bitcoin anchoring;
`deliveredTo` names the address used when it differs from the one given),
`delivery_reorged` (a delivery later displaced on Sequentia), `refund_pending`,
`refunding`, `refund_queued` (over the vault's rate limit, waiting out its
delay), `refunded`, `refund_cancelled` (a queued refund the guardian
cancelled), `refund_discarded` (a cancelled refund the owner discarded on the
vault; an operator decides), `refund_failed_manual`, and `failed_manual` (paused
for operator review; Solana deposits use `dust_manual` instead of the refund
states). A deposit of a halted asset waits in `mint_retry` with a `waiting`
reason; a refund that comes due while its asset is halted stays
`refund_pending`. Redemption records move through `awaiting_finality`,
`awaiting_liquidity` (the payout chain's treasury is short; a `waiting`
reason says of what), `halted`, `new`, `releasing`, `release_paused` (the
vault's releases are paused), `queued` (over the vault's rate limit; the
daemon executes it once `executeAfter` passes, in block time),
`release_cancelled` (a queued release the guardian cancelled; an operator
decides), `release_discarded` (a cancelled release the owner discarded on
the vault; an operator decides), `released`, `destroy_pending`, `destroying`, `done`,
plus the terminal `dust_ignored`, `ignored_unknown_asset`,
`ignored_wrong_network` (an asset returned to the wrong leg's address),
`release_failed_manual` (the vault refuses the recipient address) and
`destroy_manual`. A payout the recipient refuses (a contract that rejects
plain ether, a blocklisted address) is still final: the record carries
`deferred: {to, amount}`, the amount is owed on the vault, and the recipient
claims it to any address with `claim(token, payTo)`.

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
OWNER=0x... OPERATOR=0x... GUARDIAN=0x... RELEASE_DELAY=86400 \
  forge script script/Deploy.s.sol --rpc-url $ETH_RPC_URL \
  --private-key $DEPLOYER_KEY --broadcast
```

| Variable | Meaning |
|---|---|
| `OWNER` | The owner: a Safe or a cold key. Holds every administrative power |
| `OPERATOR` | The daemon's hot key, the address of `operator.key` |
| `GUARDIAN` | The incident key that can pause and cancel queued releases |
| `RELEASE_DELAY` | Seconds a payout over the rate limit waits before it can be executed (3600 to 2592000: one hour to 30 days) |

The deployer holds no role. Until the owner configures a release limit, every
payout is queued, so the owner's next steps are `setReleaseLimit` for each
token the bridge pays out (address zero for ether) and, for USDC over CCTP,
`setCctp` with Circle's TokenMessengerV2, MessageTransmitterV2 and USDC
addresses on that chain. The owner can later rotate the operator
(`setOperator`) and guardian (`setGuardian`), transfer ownership in two steps,
and pause or unpause deposits and releases (see "The vault contract").

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
| `vaults` | Optional list of `{address, deployBlock, version}`; the daemon watches every vault in it (`vaultAddress` stays the primary). Omit to watch `vaultAddress` alone. `version` pins the vault's interface version (3 for a vault with `VERSION()`, 1 for an older one) instead of asking the vault at startup; an address missing from this list and from `vaultAddress` is never acted on |
| `depositVault` | The vault the web page sends new deposits to, when it is not `vaultAddress`. `vaultAddress` never changes once deposits exist: deposit records of the primary vault are keyed by their bare number. A token's first deposit fixes which vault holds its escrow and pays its redemptions |
| `ethFinality` | `finalized` (default): a deposit mints once Ethereum finalizes its block, so no Ethereum reorg can undo a deposit that was already minted. `confirmations`: after `ethConfirmations` blocks instead, for local test chains |
| `ethConfirmations` | Confirmations before a deposit is processed when `ethFinality` is `confirmations` |
| `ethLogChunk` | Max block range per `eth_getLogs` call |
| `operatorKeyFile` | File containing the operator's private key (never commit it) |
| `seqRpcUrl` | Sequentia node RPC, `http://user:pass@host:port` |
| `seqWallet` | Node wallet name; auto-loaded at startup if on disk |
| `seqChainLabel` | Label mixed into redemption ids (prevents cross-chain replay) |
| `seqConfirmations` | Sequentia confirmations; also the finality count under `allowUnanchoredFinality` |
| `allowUnanchoredFinality` | For a local test chain with no Bitcoin anchoring only: treat a burn as final after `seqConfirmations` blocks. Unset (the default), a node that cannot report or does not validate anchors makes every release wait |
| `btcAnchorConfirmations` | Bitcoin-anchor depth required before a release (see "Finality") |
| `registryUrl`, `registryAdminToken`, `assetDomain` | Asset Registry endpoint, optional admin token, and the entity domain written into asset contracts |
| `esploraUrl` | Indexer used to read the circulating supply of assets this bridge did not issue (SBTC on the reserves page). Without it their supply is reported as unknown, never as zero |
| `seqFeeAsset` | Asset id or label the bridge pays all Sequentia fees in (any accepted fee asset the wallet holds) |
| `sbtcBridgeUrl`, `sbtcBridgeToken` | The sbtc-bridge custody service behind `/api/btc/*` (omit the URL to disable the Bitcoin leg); it decides when a deposit is credited, and reports it per address |
| `solRpcUrl`, `solChainName`, `solChainLabel` | Solana JSON-RPC endpoint and naming for the Solana leg (omit the URL to disable it) |
| `solGenesisHash` | Expected cluster genesis hash, verified before the leg acts (the Ethereum chain-id check's Solana equivalent) |
| `solKeyFile` | 32-byte hex seed for the Solana treasury and deposit-address derivation; generated on first boot, never commit it |
| `solWatchDays` | How long a wrap intent's deposit address is polled (default 7 days); re-requesting a wrap for the same Sequentia address revives it |
| `solMinReleaseSats` | Smallest SOL.s return that is released (default 100000 sats = 0.001 SOL, clear of Solana's rent-exempt minimum) |
| `cctp` | Circle's CCTP V2 for the unified stablecoins: consolidating Solana escrow into the Ethereum vault, USDC in from and out to other CCTP chains. `enabled`, `chains` (the other chains, each `{domain, name, chainId, usdc, rpc, explorer}`; the testnets by default), `tokenMessengerEvm` (Circle's TokenMessengerV2, the same address on every EVM chain), `inboundGiveUpHours`, `messageTransmitter` (Circle's MessageTransmitterV2 on the Ethereum chain), `irisUrl` (Circle's attestation service; the sandbox by default), `assets` (default `["USDC"]`), `solFloatUnits` (what stays on Solana for releases there, default 5 USDC), `minConsolidateUnits`, `consolidateEveryMinutes`, `stuckHours` |
| `unified` | Unified stablecoins, keyed by symbol: `name`, `ticker`, `precision`, `supervision` and the `sources` (one per chain) that all mint into the one asset (see "Unified stablecoins") |
| `unifiedIssuerPubkey` | Pinned 33-byte compressed pubkey the bridge wallet controls; hashed into every unified asset id and later authorizes handing the asset to its issuer. Generate once, back up, never change |
| `supervision` (per unified asset) | `enabled` issues the asset as a node-level supervised asset; `pause` additionally allows stopping every holding. Both permanent. `operationalKey`/`recoveryKey` pin the public keys; unset, the daemon derives them from the node wallet once |
| `btcChainName` | Display name of the Bitcoin network behind the SBTC leg (default `Bitcoin testnet4`) |
| `webDir` | Directory of the static web app to serve (default: the repository's `web/`) |
| `apiHost`, `apiPort` | Where the API + web app listen |
| `pollIntervalMs`, `solPollIntervalMs` | Interval of the main loop and of the Solana leg's own loop |
| `adminToken` | Enables `/api/admin/*` and `admin.js` for anyone presenting it. Unset, the admin API does not exist |
| `alertUrl`, `alertToken`, `alertCooldownMinutes` | Where alerts are POSTed (an ntfy topic URL, or anything that takes a plain-text POST), an optional bearer token, and how often an unchanged alert repeats (default 360). Unset, alerts go to the log only |
| `trustProxy`, `intentLimitPerHour`, `readLimitPerHour` | Take the client address from `X-Forwarded-For` (only behind a proxy you run), how many intents one client may create per hour (default 30), and how many of the heavier reads it may make per hour (default 1200) |
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

- **Rebuilds every vault's books**, up to Ethereum's finalized block: what
  came in (for an ERC-20, every `Transfer` into the vault, which also covers
  CCTP mints and migrations from another vault that emit no vault event; for
  ether, the vault's own events) against what the vault's payout events say
  went out. No token may have left a vault in greater amount than entered it, the vault must hold (at that same block) what its
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
payouts until an operator clears the halt. With `guardianKeyFile` set to the
key holding a vault's guardian role, the watcher also pauses payouts on the
vault itself, which holds even if the daemon or its host is what failed; the
guardian can pause and cancel queued payouts and nothing else, and only the
vault's owner can resume. A fault in the watcher's own data source (an RPC
dropping logs) alerts but never pauses. Payouts at or above
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
| `contracts/` | Foundry project: `src/CompagesVault.sol`, unit tests, deploy script (`forge-std` as a git submodule), and `deployments/sepolia.json`, the deployed vaults |
| `daemon/` | `compagesd.js`, the Node.js bridge daemon: `lib/bridge.js` (core logic), `lib/eth.js` (Ethereum side), `lib/sol.js` (Solana side: RPC client, keys, transaction builder), `lib/cctp-sol.js` (Circle CCTP V2 on Solana: burn and receive instructions, message parsing, attestation lookup), `lib/seqrpc.js` (Sequentia RPC), `lib/state.js` (persistence), `lib/api.js` (HTTP API + static server), `lib/alerts.js` (push alerts); `admin.js` is the operator CLI |
| `web/` | Static web front-end (no framework, no external dependencies), served by the daemon |
| `watcher/` | `compages-watch.js`, the independent checker (see "The watcher"), with `lib/checks.js` and unit tests |
| `e2e/` | Full-stack end-to-end test: anvil + a mock Solana RPC + Sequentia `elementsregtest` + the real daemon and contracts |
| `contrib/` | `handover-rehearsal.sh`, the Circle hand-off rehearsal on a Sepolia fork (see "Rehearsing the hand-off to Circle") |

The daemon's only runtime dependency is `ethers`.

## Testing

Contract tests: unit tests for deposits and deposit rules, roles and access
control, the rate limit and queue, owed payouts and claims against rejecting,
blocklisting, pausing and non-standard tokens, the stablecoin hand-off and the
deploy script; CCTP tests against mocks that follow Circle's V2 message layout,
pinned byte for byte to a real Sepolia message; and an invariant suite that
drives random sequences of every operation and checks that the vault's
balance always equals what its events credited in less what they paid out,
that it always covers everything owed, queued or cancelled, and that no
outflow ever spends that reserved escrow:

```
cd contracts
forge test
```

Daemon unit tests, which need no network: the Solana CCTP V2 encoders and
parsers, checked against fixtures produced by `@solana/web3.js` and Anchor
over Circle's program IDLs, real attestation-service responses and a devnet
simulation; the record state machines (what a paid, owed, queued, cancelled,
discarded or CCTP payout does to a redemption or refund, and how a payout
the vault already took on is read back from its queue and events); the
Bitcoin-anchor finality gate; an operator's retry and resolve decisions;
per-client rate limits, including IPv6 /64 grouping and trusted proxies; the
redaction of RPC URLs from API errors; and alert cooldowns:

```
cd daemon
npm ci
npm test
```

Watcher unit tests: rebuilding a vault's books from its events, backing net
of owed, queued and cancelled reservations, how long a reserve gap must last
before it is a breach, and what the brake pauses and halts:

```
cd watcher
npm ci
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
reports must equal the daemon's ledger. Requires foundry, node >= 20, the
daemon's dependencies (`npm ci` in `daemon/`) and the Sequentia node
(`sequentiad`/`sequentia-cli`): either a release from the
[download page](https://sequentiatestnet.com/download/core/), with
`SEQ_BIN_DIR` set to the `bin/` directory of the unpacked tarball, or a build
of the [Sequentia repo](https://github.com/ConcatenaLabs/Sequentia), with
`SEQ_REPO` set to the checkout (the script looks in `build-linux/src`, then
`src`). The registry checks are skipped unless `REGISTRY_REPO` points at a
checkout of `sequentia-registry`. The suite takes about a quarter of an hour.

```
SEQ_BIN_DIR=~/sequentia-core-<version>/bin e2e/run-e2e.sh
```

GitHub Actions runs all of the above on every pull request and every push to
`main` (`.github/workflows/ci.yml`): `forge build` and `forge test`, the
daemon and watcher unit tests on Node 22, and the end-to-end suite against the
Sequentia node release named in the workflow, whose tarball it checks against
a pinned SHA-256. No job needs a secret; the Sepolia fork rehearsal is not
run there.

The keys in the e2e script are anvil's standard, publicly known development
keys; they hold nothing on any real network.

## Rehearsing the hand-off to Circle

Under Circle's
[Bridged USDC Standard](https://github.com/circlefin/stablecoin-evm/blob/master/doc/bridged_USDC_standard.md)
the issuer can adopt `USDC.e` in place: the supply is locked, Circle takes the
minting power on Sequentia and burns the Ethereum escrow, and the asset becomes
a direct liability of Circle without any balance moving. The Ethereum half of
that can be rehearsed against the vault and USDC exactly as deployed on
Sepolia:

```
contrib/handover-rehearsal.sh
```

It runs `contracts/test/fork/HandoverRehearsal.t.sol` on a local fork of
Sepolia (Foundry required; the RPC defaults to Tenderly's public gateway and
is overridden with `REHEARSAL_RPC_URL`). Nothing is broadcast: the vault's
owner, guardian and operator, and USDC's `masterMinter` and `blacklister`
(read from the token proxy), are impersonated on the fork. `FORK_BLOCK` pins
the fork to one block for a reproducible run, `CIRCLE_BURNER` names the
burner address Circle supplies, `VAULT` and `USDC` point it elsewhere, and
further arguments go to `forge test` (`-vvvv` for call traces). A plain
`forge test` skips it.

It walks the hand-off in order and prints each step, whether it was accepted
or refused, and the escrow before and after:

1. **In flight.** Four redemptions are queued: one is executed, one is
   cancelled by the guardian, one stays queued, and one pays a blacklisted
   recipient and becomes owed. These are the three reservations the burn must
   spare.
2. **Supply lock.** The guardian pauses deposits, the in-flight releases
   settle, then the guardian pauses releases. Deposits, releases, queued
   executions and `rebalanceOut` are then refused.
3. **Burner.** The owner calls `setStablecoinBurner(usdc, burner)`. The burn
   still fails at this point, because FiatToken lets only a minter burn.
4. **Minter.** USDC's `masterMinter` calls `configureMinter(vault, 0)`: the
   vault can burn and cannot mint.
5. **Burn.** Every other role is refused `burnLockedUSDC()`; the burner's call
   emits `LockedStablecoinBurned`, and a second call finds nothing left.

It passes only if USDC's `totalSupply` falls by exactly the vault's
unreserved balance, the vault is left holding exactly its owed, queued and
cancelled amounts, both pauses still hold afterwards, and an owed amount can
still be claimed while releases stay paused. A vault holding under 1 USDC is
first topped up with 10 USDC through a temporary minter, so there is always
something to burn.

The Sequentia half is performed with the node's RPCs (`sequentia-cli`), in
this order, once the supply lock is in place and reconciled:

- **Minting power.** `listissuances <asset>` gives the asset's reissuance
  token id (`token`). The whole token supply, 1, goes to Circle's address with
  `sendtoaddress` naming `assetlabel=<token>` (and the fee asset in
  `fee_asset_label`). Holding it is the only way to mint the asset.
- **Supervision keys.** Both rotations are signed by the *current* recovery
  key, so the operational key is rotated first and the recovery key last.
  `getsupervisionrecordhash rotateoperational <asset> <new key> <old key>
  <txid> <vout>` gives the message to sign (BIP340, offline), where
  `<txid> <vout>` is the first input the record's transaction will spend;
  `buildsupervisionrecord` turns the signature into a record script,
  `addsupervisionrecordoutput` appends it to a `createrawtransaction` that
  spends that input, and `signrawtransactionwithwallet` and
  `sendrawtransaction` publish it. Then the same with `rotaterecovery`.
  `getsupervisedassets` shows the asset's current keys, and
  `doc/sequentia/supervised-assets.md` in the node repository covers the
  records.
- **Registry identity.** The asset registry's `POST /succeed` takes
  `{ asset_id, contract, signature }`: the new contract (Circle's name,
  ticker and domain, at the same precision) signed by the current
  `issuer_pubkey`, the key pinned as `unifiedIssuerPubkey`, with
  `tools/sign-succession.js` from `sequentia-registry`. Circle's domain
  serves the usual proof.

The full sequence, including the reconciliation that makes the escrow equal
the circulating supply, is in
[`bridged-usdc-standard.md`](https://github.com/ConcatenaLabs/Sequentia/blob/master/doc/sequentia/bridged-usdc-standard.md).

## Limitations

- **Centralized custody.** The vault's keys control it. Its owner can be a
  multisig and its hot operator is rate-limited, but there is no threshold
  scheme over releases and no fraud proofs. Do not use this design to hold
  funds of value.
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
and `e2e/run-e2e.sh`; for watcher changes, `npm test` in `watcher/`. CI runs
the same checks on the pull request.
Never commit `config.json`, `operator.key`, or state files (they are
`.gitignore`d; keep it that way).

## License

MIT, see [`LICENSE`](LICENSE). The Solidity sources carry matching SPDX
identifiers.
