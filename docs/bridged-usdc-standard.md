# Unified Bridged USDC on Sequentia

**A bridged-to-native stablecoin standard for a UTXO chain**

This document specifies how the Compages bridge issues a single unified USDC asset on the
Sequentia network, backed by Circle-issued native USDC, in a form that reproduces every
invariant of Circle's Bridged USDC Standard that the standard actually protects, so that
Circle can later upgrade the asset to native USDC in place, with no user migration, as it
has done on EVM chains. It is written to be read as due-diligence material: every claim
names the code, contract or RPC that makes it checkable.

Paths such as `src/...`, `test/...` and `contrib/...` are in the [Sequentia node repository](https://github.com/ConcatenaLabs/Sequentia).

Circle publishes its standard for EVM chains only. There is no official standard for UTXO
chains. This spec is therefore an adaptation, not an implementation, of Circle's standard:
where an EVM mechanism has a Sequentia equivalent we use it, where it has none we state the
gap and, where possible, the path that closes it. A requirement-by-requirement conformance
matrix is in section 8; what adoption still requires is in section 9.

Where the live deployment is named, it runs on the Sequentia public testnet against
testnet USDC (Ethereum Sepolia, the Solana devnet and Circle's CCTP testnets). Sequentia
mainnet issues its own asset by the same ceremony (section 5.1).

---

## 1. The problem

Circle's Bridged USDC Standard exists to prevent two failure modes on new networks:

1. **Liquidity splits.** If several bridges each issue their own wrapped USDC, the network
   ends up with USDC.e, axlUSDC, whUSDC and so on, none fungible with the others.
2. **Dead-end wrappers.** When Circle later launches native USDC, every wrapped variant
   must be migrated by hand: users swap, liquidity pools drain and refill, integrations
   rewrite addresses. Sui and Aptos both went through this with their Wormhole-wrapped
   USDC.

The standard solves both by having one blessed bridged deployment, built so that Circle
can take ownership of it and upgrade it in place. On Linea, the first such upgrade, the
bridge was paused, ownership of the token contract transferred to Circle, Circle burned
the USDC locked in the Ethereum bridge contract, and every USDC.e balance became native
USDC with no user action. World Chain followed the same path. In both cases the token
contract address, balances, and integrations survived untouched.

Sequentia adds a third failure mode the EVM standard never had to consider: USDC arrives
from more than one source chain. Compages bridges from Ethereum and Solana, and accepts
USDC from every chain Circle's Cross-Chain Transfer Protocol (CCTP) reaches. An ordinary
bridged token becomes one Sequentia asset per source-chain token, so without unification
USDC bridged from Ethereum and USDC bridged from Solana would be two distinct,
non-fungible assets: a liquidity split manufactured by the bridge itself. This spec
unifies them.

## 2. What the standard actually protects

Stripped of its EVM mechanics, Circle's standard enforces seven invariants. These are the
things our design must preserve; everything else is implementation detail.

- **I1. One canonical asset.** Exactly one bridged USDC exists on the network, whatever
  its backing route.
- **I2. Immutable identity, fixed before launch.** The token's identity and rules are set
  at deployment and cannot be changed afterward by anyone but Circle. Circle states the
  standard "cannot be retroactively applied": a deployment that did not build the upgrade
  path in from day one can never be upgraded.
- **I3. Provable 1:1 backing.** Circulating bridged supply equals native USDC locked in
  the bridge escrow, and both sides are independently verifiable.
- **I4. Transferable control.** The bridge operator can hand every issuer power to Circle
  in one auditable step, without touching user balances.
- **I5. Supply lock.** Bridging can be paused and in-flight activity reconciled, so that
  at upgrade time the books balance exactly.
- **I6. Burnable escrow.** Circle can burn the locked backing on the source chain, at
  which point the network's supply is backed by Circle's reserves directly.
- **I7. Continuity.** After the upgrade, the asset identifier, all balances, and all
  integrations survive unchanged. Users do nothing.

## 3. Sequentia ground truth

Facts about the node this design builds on. File references name functions rather than
lines.

**Asset identity is entropy-committed and immutable.** An Elements asset id is derived
from the issuance input's prevout and a 32-byte `contract_hash`
(`GenerateAssetEntropy`, `CalculateAsset` in `src/issuance.cpp`). The contract, and
therefore the asset's committed identity, can never be changed or added after issuance.
The `issueasset` RPC accepts a structured `contract` object (name, ticker, precision,
issuer domain, issuer pubkey) and commits its canonical-JSON SHA256, which the asset
registry verifies by re-deriving the asset id.

**The reissuance token is the only minting power, and it exists only if created at
issuance.** Consensus permits minting more of an asset only in a transaction that spends
the asset's reissuance token (`VerifyAmounts` reissuance branch,
`src/confidential_validation.cpp`). Only an initial issuance may create reissuance tokens;
the check `assetBlindingNonce.IsNull()` makes a reissuance that tries to mint new tokens
consensus-invalid, and zero-value spendable outputs are banned precisely to close the
retrofit hole. Two consequences:

1. The decision to make the asset reissuable, and the token quantity, is irreversible and
   must be made in the very first issuance transaction.
2. Whoever holds the token outputs holds total and exclusive minting power. Transferring
   the token outputs is a complete, on-chain-auditable transfer of that power. Together
   with the supervision key rotation below, this is the UTXO-native equivalent of
   `transferUSDCRoles`.

**The reissuance token is held and spent transparently.** Upstream Elements encodes "this
input is a reissuance" as a non-null `assetBlindingNonce` carrying the token's blinding
factor, and cannot express a reissuance from an unblinded token. Sequentia makes an
explicit reissuance-token spend valid at consensus, on the testnet and from genesis on
mainnet parameters. Custody of the token is therefore an ordinary transparent-UTXO custody
problem, and anyone can see which output holds it.

**Supervision gives an issuer a consensus-level freeze and pause.** An asset may be issued
*supervised* ([supervised-assets.md](https://github.com/ConcatenaLabs/Sequentia/blob/master/doc/sequentia/supervised-assets.md); `src/supervision.cpp`). The
issuance commits a supervision declaration into the asset id: two distinct x-only BIP340
keys and feature bits. The **operational key** signs freeze and unfreeze records; the
**recovery key** signs only rotations, of either key. If the asset was issued with the
pause bit, the operational key can also pause the asset: one record that freezes every
single-owner holding at once. Supervision is permanent in both directions: an asset cannot
gain it after issuance or lose it later, and nodes recompute the asset id from the
declaration rather than trusting a claim. Section 5.5 states exactly what it reaches.

**A supervised asset is never blinded.** Consensus rejects any transaction that moves a
supervised asset (as an input, an issuance or a reissuance) if any of its outputs is
blinded in asset or value (`bad-txns-supervised-blinded`, `src/consensus/tx_verify.cpp`),
and a supervised issuance must itself be fully explicit. Every output that has ever held a
supervised asset is therefore readable by every node. For an unsupervised asset the
Elements default applies: any holder may send it to a confidential address.

**Burns are native and explicit.** The `destroyamount` RPC (and the raw `burn` output
type) removes an explicit amount of an asset from circulation as an unblinded OP_RETURN
output: provable, attributable to the asset, permanent.

**Precision is a first-class issuance field.** Sequentia extends Elements issuance with
`nDenomination` (`src/primitives/confidential.h`), the asset's decimal precision,
serialized with the initial issuance and read authoritatively from it. It is display
metadata, not consensus-checked, and the registry contract's `precision` must agree with
it at issuance.

**There is no per-asset supply index in the node.** `coinstatsindex` sums atoms across
all assets into one number and skips blinded outputs; `listissuances` is wallet-scoped.
Exact circulating supply of one asset is computed by walking every block and summing
explicit issuances minus explicit burns for that asset id. Section 5.4 describes the tool
that does this.

**Simplicity and tapscript introspection are active; nothing in this standard depends on
them.** Simplicity is active on the testnet and from genesis on mainnet parameters
(`getdeploymentinfo` reports it), and the Elements tapscript introspection opcodes (leaf
version 0xc4) are active from block 1. Section 5.5 explains why this spec uses neither for
USDC: supervision reaches holders a covenant cannot.

**Fees are payable in any whitelisted asset.** `g_con_any_asset_fees` is on for
Sequentia. Admitted to a node's fee whitelist, bridged USDC pays its own transaction fees:
a user can hold USDC alone, with no other asset, and transact. On EVM chains this requires
a paymaster; here it is native.

## 4. Design summary

One Sequentia asset, ticker `USDC.e`, name `Bridged USDC (Compages)`, precision 6, one
atom equal to exactly one micro-USDC on every source chain. It is issued once, in a
deliberate ceremony, with zero initial supply, a single reissuance token, and a
supervision declaration with pause. The reissuance token and the two supervision keys are
the asset's entire control plane.

Compages mints against finalized deposits of Circle-issued native USDC and burns against
redemptions, which the user may route to Ethereum, Solana or any CCTP chain. Deposits
arrive in the Ethereum vault (directly, or over CCTP from any supported chain) or in the
bridge's Solana treasury; the daemon moves Solana USDC beyond a working float into the
Ethereum vault through CCTP, so the backing concentrates in one escrow. The bridge
maintains and publishes the invariant

    circulating atoms on Sequentia  ==  sum of escrowed micro-USDC across source chains
                                        (plus USDC in transit between them over CCTP)

with equality at rest and `supply <= escrow` at every instant in between.

The upgrade to native USDC is: lock the supply, consolidate the Solana float into the
vault, hand Circle the reissuance token and rotate both supervision keys to Circle's
keys, Circle burns the vault's escrow, and the registry identity succeeds to Circle. The
asset id never changes; balances, DEX orders, Lightning channels and integrations are
untouched.

**The live asset (testnet):**

| | |
|---|---|
| Asset id | `9121a8204fda7aab6108b8e09b3a07aa5b7858df7b536393a5a8d636801aebfa` |
| Issuance transaction | `e810128321d4b4d02d2fb9b9044fbdcb352febbd6085c9a437be2c1ce1c5703b` |
| Contract hash | `95cafd318797404e87359af19e02bf638ff0bef981512a7c7351e62beb297579` |
| Contract | name `Bridged USDC (Compages)`, ticker `USDC.e`, precision 6, domain `bridge.sequentia.io` |
| Supervision | version 1, pause allowed (`getsupervisedassets` shows the keys issued and the keys current) |
| Ethereum escrow | `CompagesVault` v3, Sepolia `0x7B702D6A2E2351F0c4E549642e65AbABC0324384` |

`EURC.e` (asset `d1bb6f4d0d12dde93405c23da8da38c6d00270930d75b7cdcb91ad8f0646efef`,
`Bridged EURC (Compages)`) is a second unified asset built the same way: precision 6,
supervised with pause, sourced from Circle's EURC on Sepolia and the Solana devnet. The
CCTP consolidation and routing of section 5.2 apply to USDC only, so EURC.e's escrow sits
on each source chain.

## 5. Normative specification

Keywords MUST, MUST NOT, SHOULD, MAY are used in the RFC 2119 sense.

### 5.1 The asset

**Issuance ceremony.** The unified asset MUST be created by a deliberate operator action
before any deposit is accepted, not lazily in the deposit path. `compagesd` performs it at
start-up for every configured unified asset and refuses to run if it fails. The issuance
transaction MUST be:

```
issueasset
  assetamount   0
  tokenamount   1
  blind         false
  fee_asset     <operator's fee asset>
  denomination  6
  contract      {
    name:          "Bridged USDC (Compages)",
    ticker:        "USDC.e",
    precision:     6,
    domain:        <bridge domain>,
    issuer_pubkey: <pinned operator key, see below>
  }
  supervision   {
    operationalkey: <x-only key>,
    recoverykey:    <different x-only key>,
    pause:          true
  }
```

Rationale for each parameter:

- `assetamount 0`: nothing circulates before the first verified deposit, so backing is
  exact from the first block (`issueasset` accepts a zero asset amount when the token
  amount is nonzero).
- `tokenamount 1`: the token supply is fixed forever at 1.00000000. Handover can
  therefore be verified as "Circle's outputs hold 100% of the token supply", with no
  ambiguity about stray token outputs. The holder may split the token into several
  outputs for operational redundancy; the audit condition is unchanged. Consensus also
  requires a supervised asset to be reissuable, so the token is mandatory, not a choice.
- `blind false`: the issuance is explicit, which a supervised issuance must be anyway.
  This fixes the reissuance token id to the explicit derivation
  (`CalculateReissuanceToken` with the explicit tag) and starts the auditable supply
  record.
- `denomination 6` and `precision 6`: one atom is one micro-USDC. USDC has 6 decimals on
  every chain Circle issues on, so every bridge direction is an exact identity map on base
  units. This deliberately departs from the Compages default of precision 8 for bridged
  assets; the departure is confined to unified assets. Three consequences:
  1. Exactness. Under precision 8 a redemption of an atom count not divisible by 100
     would floor the payout while burning the full amount, leaving sub-micro-USDC dust in
     escrow forever and breaking the exact equality the supply lock requires. At
     precision 6 the atom is the smallest expressible unit, so no such remainder can
     exist.
  2. Irreversibility. `nDenomination` is read authoritatively from the initial issuance
     and can never be changed afterward, so an asset Circle may adopt must carry USDC's
     canonical 6 decimals from birth.
  3. Fees still work. The node values a fee as `atoms * rate / 1e8` and is
     precision-blind, but the price server carries the denomination in the rate
     (`price * 1e8 * 10**(8 - precision)`), so a 6-decimal asset is charged the same real
     fee as an 8-decimal one. The node's RPCs express every amount as atoms divided by
     1e8 regardless of precision, so tooling MUST work in atoms and apply precision only
     for display.
- `supervision` with `pause: true`: the asset carries the freeze and pause capability that
  FiatToken's Blacklister and Pauser provide (section 5.5). It can only be conferred here:
  an asset issued without it can never gain it. The two keys MUST differ; consensus
  refuses equal keys.
- Naming follows Circle's stated convention for bridged deployments: token name
  "Bridged USDC (Third-Party Team)" and symbol "USDC.e". The `.e` suffix here is Circle's
  bridged-asset marker, not an "Ethereum" marker; the unified asset carries it regardless
  of source mix. The per-source suffix scheme (`.e` / `.s`) that Compages uses for other
  tokens MUST NOT be applied to unified assets.

**Issuer key.** `issuer_pubkey` MUST be a pinned, persistent, backed-up operator key,
recorded in the bridge configuration (`unifiedIssuerPubkey`). It MUST NOT be a throwaway
key derived at issuance time. It authorizes the registry identity succession at upgrade
time (section 5.6).

**Supervision keys.** The public halves are committed in the asset id at issuance. Either
may be held as a FROST or MuSig2 threshold key, since the chain sees one ordinary Schnorr
key and signature. The daemon takes pinned public keys from configuration
(`supervision.operationalKey`, `supervision.recoveryKey`); left unset, it derives both from
the bridge's node wallet once, which makes that wallet's backup the freeze authority. The
recovery key SHOULD be kept cold and separate from the operational key: it is what lets
the holder recover from a stolen operational key, by rotating it away.

**Reissuance token custody.** The token is the asset's minting power and MUST be
custodied accordingly: held by the bridge wallet, backed up, and never commingled with
user funds. Every reissuance MUST be verified to have reached the mempool or a block
before it is counted (`compagesd` establishes this after every mint, send and burn).

**Registration.** After issuance the operator MUST register the contract with the
Sequentia asset registry and serve the domain proof, so the asset displays as `USDC.e`
with a verified issuer domain in wallets, the explorer and the price server.

**Supply cap sanity.** The daemon's per-asset mint cap applies. Mints and burns for this
asset are explicit by consensus (section 3), which is what keeps supply exactly auditable.

### 5.2 The unified multi-source model

**Canonical token table.** The bridge configuration MUST contain a table of canonical
token identities per unified asset. For USDC on testnet:

| Source chain | Identity | Decimals |
|---|---|---|
| Ethereum Sepolia (chainId 11155111) | `0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238` | 6 |
| Solana devnet | SPL mint `4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU` | 6 |
| CCTP chains (Base Sepolia, Arbitrum Sepolia, OP Sepolia, Avalanche Fuji, Unichain Sepolia, Linea Sepolia, World Chain Sepolia) | Circle's USDC on each, arriving by CCTP burn into the Ethereum vault | 6 |

The CCTP list is configuration (`cctp.chains`) and is published at `GET /api/status`. At
Sequentia mainnet launch the table is re-created with the mainnet identities (Ethereum
`0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48`, Solana mint
`EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v`, and Circle's mainnet CCTP contracts).
Only Circle-issued native USDC ever qualifies. Wrapped or bridged representations from
other bridges (Wormhole, Axelar, any `USDC.e` from another network) MUST NOT be accepted
as backing under any circumstances: the unified asset's claim to the standard rests on
its backing being native USDC and nothing else. Adding a source chain is an explicit
operator configuration change and a public announcement, never an automatic inference
from a token's symbol.

**State model.** A unified asset is one mapping (`unified:USDC`) holding the asset id,
reissuance token, contract and contract hash, precision, supervision keys and the list of
sources; each source token key routes to it, and each source keeps its own
`escrowedUnits`. `GET /api/assets` publishes this record. The reverse lookup from asset id
to mapping is exact, since one asset id serves several token keys.

**Deposits.** A deposit of a canonical token, once final under its chain's rule
(Ethereum: the block is finalized; Solana: `finalized` commitment; CCTP: Circle's
attestation at the finalized threshold, then relay through `receiveCctp`), mints the
deposited base units as atoms (identity map) to the depositor's Sequentia address via
`reissueasset`, and increments `escrowedUnits` for the source that now holds it. The first
deposit does not issue; the asset already exists (section 5.1).

- **Ethereum:** `depositToken` on the vault.
- **Solana:** a transfer to a bridge-derived deposit address bound to the depositor's
  Sequentia address, swept into the bridge's Solana treasury.
- **Any CCTP chain:** the user burns USDC with Circle's TokenMessengerV2, naming the vault
  as `mintRecipient` and as `destinationCaller`, with hookData
  `compages:deposit:<Sequentia address>`; the daemon relays Circle's attestation through
  `vault.receiveCctp`, which mints the USDC into the vault and emits `Deposited` and
  `CctpDeposit`. A burn with an invalid Sequentia address or unrecognized hookData is
  still received (only the vault can complete it) and reported with `CctpUnrecognized`,
  for refund to its source chain with `refundViaCctp`.

**Redemptions.** A redemption intent binds a fresh Sequentia address to a target chain and
target address. The user sends `USDC.e` there; after Bitcoin-anchor finality of that
transfer (anchor depth is the finality rule on Sequentia), the daemon pays out and then
burns the received atoms explicitly. The payout route depends on the target:

- **Ethereum:** `release` from the vault.
- **Any CCTP chain:** `releaseViaCctp`, which burns USDC in the vault at Circle's
  finalized threshold for minting to the recipient on the target chain; anyone, the
  recipient included, completes the mint with Circle's attestation.
- **Solana:** from the Solana treasury's float, or, when the float cannot cover it,
  `releaseViaCctp` from the vault with the daemon completing the mint on Solana.

Because the asset is source-blind, a user who deposited on one chain may redeem to any
other; the bridge is thereby also a USDC router, which is safe as long as the solvency
rule below holds. The `ignored_wrong_network` guard that parks redemptions returned to the
wrong leg asks whether the asset is backed on the release chain, not where it came from.

**Per-escrow solvency.** A payout is made only from an escrow that can cover it. A
redemption no escrow route can serve waits in `awaiting_liquidity` and is never
rejected-and-burned. On the vault, a payout is refused outright when its unreserved
balance cannot cover it, so the vault never promises more than it holds.

**Consolidation and rebalancing.** Circle adopts a bridged USDC by burning one escrow, so
the backing is kept in one place. The daemon moves whatever the Solana treasury holds
beyond a working float (`cctp.solFloatUnits`) into the Ethereum vault with Circle's CCTP
V2: `deposit_for_burn_with_hook` on Solana naming the vault as mint recipient and
destination caller, with hookData `compages:rebalance`, relayed through
`vault.receiveCctp`, which records the arrival as `RebalancedIn` and creates no deposit.
Each move is recorded before anything is sent, and the Solana burn's signature is
persisted before broadcast. Between burn and mint the amount is in transit, and the
reserves report counts it as backing. The owner can also move unreserved escrow out of
the vault with `rebalanceOut`, which emits `Rebalanced` rather than `Released`, so an
auditor can always tell liquidity movements from user redemptions. No third-party wrapper
ever enters the backing: every movement is Circle's own burn and mint.

**The invariant.** At rest:

```
sum over sources of escrowedUnits  (+ USDC in transit over CCTP)
    ==  circulating atoms of USDC.e on Sequentia
```

where circulating atoms is computed from chain data (explicit issuances minus explicit
burns, section 5.4), not from internal counters. In flight, mint-after-finality and
burn-before-release ordering guarantee `circulating <= escrow` at every instant. The
daemon checks the invariant every minute against the chain; a breach seen on two
consecutive checks halts minting for the asset until an operator clears it, and an escrow
ledger that would go negative halts payouts too.

### 5.3 The Ethereum escrow: `CompagesVault`

The escrow is `CompagesVault` v3 (`contracts/src/CompagesVault.sol` in the Compages
repository; `VERSION() == 3`), deployed on Sepolia at
`0x7B702D6A2E2351F0c4E549642e65AbABC0324384`. It is deliberately not upgradeable: a new
version is a new deployment, and every property below is fixed in the deployed bytecode.
Two other deployments, `0xd72AF53b4F0551A25072cC72A29F699Ed9d8Ed41` and
`0x15B3c97eD82C62b7828A775456Bd75e67A8eC42C`, have deposits paused and hold no funds.

1. **Roles.** Three keys, set at deployment:

   | Role | Can |
   |---|---|
   | `owner` | set the other roles and every limit; unpause; reinstate, amend or discard cancelled releases; move unreserved escrow (`rebalanceOut`); configure CCTP (`setCctp`) and the stablecoin burner (`setStablecoinBurner`). Transferred in two steps (`transferOwnership`, `acceptOwnership`) |
   | `operator` | `release`, `refund`, `releaseViaCctp`, `refundViaCctp`, nothing else |
   | `guardian` | `pauseDeposits`, `pauseReleases`, `cancelRelease`; never unpause, never move funds |

2. **Replay-guarded release.** Every payout is keyed by a deterministic id recorded in
   `processedRedemptions` the moment it is paid or queued, so nothing is paid twice.
3. **Rate limit and delay queue.** Each token has a bucket (`setReleaseLimit`). A payout
   that fits pays at once; one that does not is queued for `releaseDelay` (one hour to 30
   days, `ReleaseQueued`), during which the guardian or owner can cancel it. A token with
   no bucket queues every payout. A leaked operator key therefore cannot empty the vault
   at once.
4. **Owed payouts and claims.** A payout the recipient cannot accept (a blocklisted
   address, a contract rejecting ether) does not block the redemption: the amount becomes
   owed (`ReleaseDeferred`) and the recipient withdraws it with `claim(token, payTo)`.
   Owed, queued and cancelled-but-reinstatable amounts are reserved: no immediate payout
   and no rebalance can spend them (`unreservedBalance(token)`).
5. **Pause, both directions, on chain.** `pauseDeposits` and `pauseReleases` are
   separate, emit `DepositsPausedSet` and `ReleasesPausedSet`, and are callable by the
   guardian or owner; only the owner unpauses. A CCTP deposit waits out a deposit pause;
   CCTP rebalancing into the vault (`compages:rebalance`) does not, so consolidation can
   complete while the supply is locked. `rebalanceOut` is stopped by the release pause.
   The supply lock is therefore an on-chain fact, not an operator promise.
6. **Circle's burn hook,** with Circle's interface:

   ```solidity
   function burnLockedUSDC() external;
   ```

   Callable only by the address the owner names with `setStablecoinBurner(token,
   burner)` (per the standard: "only callable by an address that Circle specifies closer
   to the time of the upgrade"; until it is set, nothing can burn). It reverts unless both
   deposits and releases are paused, and burns the token's whole balance except what is
   reserved for individual users (owed, queued and cancelled payouts), which stay and are
   paid out as normal. It takes no amount argument, because the supply lock has already
   made the unreserved balance equal to that escrow's share of circulating supply. It
   calls the token's own `burn(uint256)`; FiatToken restricts `burn` to configured
   minters, so Circle enables the vault as a minter (with zero mint allowance) for this
   step.
7. **Deposit rules.** Per-token minimum, balance cap and token block, owner-set.
   Deposits credit the balance actually received.

The contract suite (`forge test`) covers roles and access control, the rate limit and
queue, owed payouts and claims, pausing, the stablecoin hand-off, CCTP against mocks
pinned byte for byte to a real Sepolia message, and an invariant suite checking that the
vault's balance always equals what its events credited less what they paid out and always
covers everything reserved.

**Solana.** The Solana leg has no contract. The escrow is the bridge treasury's USDC token
account; the replay guard is the outbound transaction's signature, persisted before
broadcast, so after a crash the chain answers whether a transfer landed. Deposits are
halted for an asset by the daemon (`admin.js halt`), an operator action rather than an
on-chain fact. This is acceptable only because the Solana treasury holds a working float,
not the backing: at the supply lock the float is set to zero and consolidated into the
vault (section 6), so there is no Solana escrow left for Circle to burn.

### 5.4 Supply auditability

The node offers no per-asset supply accounting (section 3), so the standard supplies it:

1. **Explicit by consensus.** Every issuance, reissuance, burn and transfer of a
   supervised asset is explicit (section 3). The bridged phase's supply record is
   therefore complete by construction, and so is its distribution: every holding of
   `USDC.e` is visible on chain. Holders cannot use confidential transactions with this
   asset; that is the cost of a freezable asset, since consensus cannot freeze what it
   cannot read.
2. **The auditor.** `contrib/asset-supply-audit/audit.py` in the node repository walks
   the chain over RPC and computes, for an asset id, total explicitly issued, total
   explicitly burned and circulating supply, trusting the node for nothing but block
   data. It checks exactness instead of assuming it: a blinded issuance, reissuance or
   burn makes it report a bound and exit with status 2. Anyone, including Circle, can run
   it against their own node.
3. **Continuous proof of reserves.** `GET /api/por` on the bridge publishes, per unified
   asset: escrow on each source chain read live from that chain, USDC in transit over
   CCTP, circulating supply read from the Sequentia chain beside the daemon's ledger, and
   a `backed` verdict. An unmeasured side is reported as `null`, never as zero.
   At fixed Sequentia heights the bridge also takes a signed snapshot: circulating
   supply from the supply auditor at height H, escrow at the last Ethereum block at or
   before H's time, CCTP transfers in flight at that moment (each proven on chain by its
   Solana burn and its CCTP nonce), each snapshot linked by hash to the one before. The
   history is served at `GET /api/por/history` and copied, verified, into the public
   repository `ConcatenaLabs/compages-reserves`; `reserves/verify.mjs` in the Compages
   repository re-derives any snapshot from public endpoints.
4. **An independent watcher.** `watcher/compages-watch.js` in the Compages repository
   trusts none of the daemon's bookkeeping. Once a minute it rebuilds every vault's books
   from the token's own transfers and the vault's events up to Ethereum's finalized block,
   reading logs and balances from two different providers; checks circulating supply (as
   the block explorer's indexer counts it) against what the source chains hold; and, on a
   critical finding, can halt the asset in the daemon and pause the vault's payouts
   through the guardian key.

### 5.5 Compliance capabilities

FiatToken, the contract Circle upgrades bridged deployments into, carries transfer-level
controls. The mapping:

| FiatToken role | Sequentia equivalent | Coverage |
|---|---|---|
| Owner / ProxyAdmin | Reissuance token custody, plus the supervision recovery key | Equivalent. Per-asset rules are consensus, not upgradeable code |
| MasterMinter, minters, allowances | Holder of the reissuance token; the operator mints only against finalized deposits | Operational analogue; on-chain minting power is unbounded for the token holder |
| Pauser | Supervision pause, signed by the operational key | Equivalent for single-owner holdings; see the limits below |
| Blacklister | Supervision freeze of a script (an address), signed by the operational key | Equivalent for single-owner holdings; see the limits below |
| Role rotation (`updatePauser`, `updateBlacklister`, ...) | `rotateoperational` / `rotaterecovery`, signed by the recovery key | Equivalent |
| Rescuer | None needed: no contract exists to which tokens can be sent by mistake | Not applicable |

**What supervision does.** A freeze record names an asset and a script. From the block
after the one containing it, consensus rejects a single-owner spend of that asset from
that script. Paying *to* a frozen script stays legal, so a known destination can be frozen
pre-emptively and funds arrive already trapped. A pause names the wildcard target and
freezes every single-owner holding at once. Lifting a freeze or a pause is spending its
record, authorized by the *current* operational key, so freezes placed before a key
rotation remain liftable by the new key and never by a retired one. The operational key
cannot rotate anything; the recovery key can do nothing but rotate. To avoid a holder
moving funds while a freeze record waits in the public mempool, records can be submitted
straight to a block producer (`submitsupervisionrecord`).

**What supervision does not do, stated exactly:**

- **Reach is single-owner scripts only.** A freeze or pause blocks spends that reveal a
  single-owner script: P2PK, P2PKH, P2WPKH (bare or P2SH-wrapped) and Taproot key-path.
  It does not block spends through P2WSH scripts, Taproot script paths or bare multisig,
  whatever the number of keys behind them, because consensus cannot tell a one-person
  script from a shared one, and freezing a Lightning channel, an HTLC or a covenant would
  trap an innocent counterparty. A holder who deliberately keeps the asset in such a
  script is beyond a freeze, and a Taproot output with a script path can be spent through
  it even when its script is frozen.
- **A freeze names a script, not a person.** Funds moved to a new script before the
  freeze confirms are not caught by it.
- **No seizure or clawback.** No key can move a holder's output. FiatToken has no
  clawback either; a blacklist there also only stops movement. Where a court orders
  seizure, the economic route is a permanent freeze plus reissuing the same amount to the
  named address. The frozen units still count in the explicit supply, so a backed issuer
  doing this must account for them as retired against the escrow; that is an accounting
  convention, not a consensus fact.
- **Freeze and pause stop spending, not minting.** Minting is the reissuance token, a
  separate authority; a stolen supervision key cannot mint, and a stolen reissuance token
  cannot freeze.

A covenant, in Tapscript or Simplicity, binds only outputs created under it, so it could
not have reached a holder who already holds the asset; supervision is a consensus rule
over the asset itself, which is why this spec uses it and no covenant. The OpenAMP model,
which governs an asset by requiring every unit to sit in an issuer-co-signed output, is
not used either: it costs the composability a general-purpose dollar depends on.

Context for the due-diligence conversation: every non-EVM chain where Circle issues
native USDC (Solana, Stellar, Sui, Aptos, Algorand, NEAR, Hedera) has an account-freeze
primitive at the token layer. `USDC.e` carries one from issuance, with the reach stated
above.

### 5.6 Registry metadata and the rename

The chain-committed contract (name "Bridged USDC (Compages)", ticker "USDC.e") is
immutable by construction: it records who issued the asset and under what identity,
forever. The upgrade renames the asset in the display layer, which on Sequentia is the
asset registry (the node, wallets, explorer and price server all read labels from it; the
node treats them as advisory display data).

The registry (`sequentia-registry`) supports **succession** (`POST /succeed`): an
authorized update that overlays display metadata (name, ticker, entity domain, issuer
pubkey) on an asset while preserving and continuing to serve the original chain-committed
contract and its hash. A succession requires both:

1. a signature by the `issuer_pubkey` of the current (original or latest successor)
   contract, over `sequentia-asset-succession:v1:<asset_id>:<successor contract hash>`,
   and
2. the standard domain proof served from the successor entity's domain.

At upgrade time the operator signs a successor naming "USD Coin" / "USDC" with entity
`circle.com`, and Circle serves the domain proof. Squatting is impossible (both factors
are required) and the change is a public, auditable registry event appended to the
entry's `successions[]`.

A running node adopts a changed label for an asset it already labels only on restart
(`CAssetsDir::Merge` leaves existing labels alone). The rename therefore reaches wallets,
the explorer and the price server on their next registry poll, and nodes on their next
restart, which suits a one-time planned event.

## 6. The upgrade lifecycle

**Phase 0, bootstrap.** Issue the asset (5.1), deploy the vault (5.3), open deposits, grow
adoption. Publish `/api/por` from the first deposit, so the backing record is unbroken
from the first atom.

**Phase 1, audit.** Circle (or anyone) runs the supply auditor against their own
Sequentia node and reads the vault's balance on Ethereum and the Solana treasury directly.
Because every movement of the asset is explicit by consensus, the audit is exact, not
statistical. The due-diligence packet consists of this spec, the vault source and its
tests, the auditor, the proof-of-reserves record, the supervision design
([supervised-assets.md](https://github.com/ConcatenaLabs/Sequentia/blob/master/doc/sequentia/supervised-assets.md)), and the Sequentia protocol documentation
(anchoring, proof of stake, finality).

**Phase 2, supply lock.** Jointly scheduled with Circle.

1. Stop accepting new deposits and redemptions: pause deposits on the vault
   (`pauseDeposits`, an on-chain event) and halt the asset's minting in the daemon
   (`admin.js halt <asset> mint`), which also stops Solana deposits from minting.
   `USDC.e` sent to a redemption address after this point MUST be returned to its sender
   rather than redeemed.
2. Drain the in-flight queues: finalized deposits received before the pause are minted,
   pending redemptions are released and burned, refunds are settled.
3. Set the Solana float to zero, so the consolidation moves the whole Solana escrow into
   the vault over CCTP. The vault accepts `compages:rebalance` arrivals while deposits
   are paused. Wait until nothing is in transit and the Solana treasury holds no USDC.
4. Pause releases on the vault (`pauseReleases`).

At completion the vault's unreserved USDC balance equals circulating `USDC.e` supply,
plus any USDC anyone transferred to the vault unsolicited (a plain ERC-20 transfer is
always possible and is visible to the watcher's reconciliation). Both sides re-run the
audit and sign off on the numbers.

**Phase 3, control transfer.** Three on-chain steps on Sequentia, each checkable by Circle
and any auditor:

1. **Reissuance token.** The operator sends 100% of the reissuance token supply (fixed at
   1.00000000 since issuance) to a Circle-designated Sequentia address. A transparent
   address lets Circle, and any auditor, see the token at the destination.
2. **Operational key.** A `rotateoperational` record, signed by the current recovery
   key, replaces the operational key with Circle's.
3. **Recovery key.** A `rotaterecovery` record, signed by the current recovery key,
   replaces the recovery key with Circle's. From then on the operator's old keys can
   neither freeze, lift, pause nor rotate.

Circle verifies with `getsupervisedassets` that the asset's current keys are its own, and
on chain that its outputs hold the entire token supply. The asset id permanently records
the keys it was issued with (reported as `issuedoperationalkey` and `issuedrecoverykey`);
authority follows the current keys only. After these steps the operator holds no power
over the asset: the reissuance token is singular by possession, and the supervision keys
are replaced by consensus. This is the UTXO equivalent of `transferUSDCRoles`, with the
"partner removes all configured minters" requirement satisfied structurally.

On the Ethereum side the vault owner names Circle's address with `setStablecoinBurner`.

**Phase 4, escrow burn.** Circle enables the vault as a USDC minter for burning and its
designated address calls `burnLockedUSDC()`. The amount burned is the vault's unreserved
USDC balance, which phase 2 made equal to circulating Sequentia supply. From this moment
the asset on Sequentia is a direct liability of Circle, backed by Circle's reserves,
exactly as native USDC on any chain. Amounts reserved for individual users (owed, queued
or cancelled payouts) are not burned; they belong to redemptions already settled on the
Sequentia side and are paid out as normal.

**Phase 5, identity succession.** The successor registry record renames the asset to
"USD Coin" / "USDC" under `circle.com` (5.6).

**Continuity (I7).** The asset id never changes, so all balances are untouched; all DEX
orders, covenant order-book entries and Lightning channels denominated in the asset remain
valid; fee-whitelist entries, keyed by asset id, remain valid; every integration that
stored the asset id needs no change; freezes in force at the handover stay in force and
become Circle's to lift. Users do nothing, as on Linea and World Chain. Circle mints and
burns thereafter directly on Sequentia with the token it holds; whether it retains
Compages as a technical operator or runs its own issuance infrastructure is Circle's
choice. The vault's CCTP paths are the natural base for Circle's own CCTP integration.

## 7. What the asset looks like to users and the ecosystem

Nothing user-visible changes at the upgrade beyond the name. During the bridged phase:

- Wallets treat `USDC.e` as one asset with one balance, whatever chain it came from. The
  bridge page offers deposits from Ethereum, from Solana and from any CCTP chain, and
  payouts to any of them. No `USDC.s` exists.
- `USDC.e` pays its own fees. Which assets a node accepts for fees is that node's policy,
  published by its price server; the reference configuration
  (`contrib/price-server/config.example.json`) prices `USDC.e` at the market USDC price
  through `feed_aliases`, and the testnet's block-producing nodes admit it. The whitelist
  entry is keyed by asset id and survives the upgrade.
- Per the network's design principles, `USDC.e` has equal standing with every other
  asset: no special badges beyond the registry's verified issuer display, no privileged
  placement, and fee denominations in its own units.
- `USDC.e` is always transparent. A wallet sending it must keep every output of that
  transaction explicit (section 3); the node wallet and the DEX wallet daemon do.

## 8. Conformance matrix

Circle's requirements (quoted from the Bridged USDC Standard) against this spec:

| # | Circle requirement | This spec | Status |
|---|---|---|---|
| 1 | Token contract uses Circle's FiatToken bytecode | No contract exists; the asset is a consensus-native primitive with no upgradeable code. Its powers are the reissuance token and the two supervision keys | Analogue. The requirement's purpose (audited, known behavior; control reserved to Circle) is met by consensus rules plus I4 |
| 2 | Name "Bridged USDC (Third-Party Team)", symbol "USDC.e" | Name "Bridged USDC (Compages)", ticker "USDC.e", committed at issuance and registry-served | Met |
| 3 | "Must not be upgraded... outside of subsequent FiatToken versions authored by Circle" | No code to upgrade. Consensus upgrades are chain governance, as on any L1 Circle issues on; post-handover, every per-asset power is held by Circle | Analogue |
| 4 | Deployed following the standard from day one; "cannot be retroactively applied" | Reissuance token, supervision with pause, precision, contract identity and the vault's hooks are all fixed at issuance or deployment (5.1, 5.3); none are retrofittable, and none need to be | Met |
| 5 | `transferUSDCRoles` transferring all roles, callable only by Circle | Transfer of the entire fixed token supply plus rotation of both supervision keys to Circle's keys; UTXO spends and rotations are holder-initiated by construction, and receipt is verifiable on chain | Met (analogue) |
| 6 | "Remove all configured minters prior to transferring roles" | Minting power is possession-based and singular; handover leaves the operator nothing to remove | Met, structurally |
| 7 | Bridge upgradable to add supply-lock pause | The vault pauses deposits and releases separately, on chain, from deployment; `burnLockedUSDC` requires both. The Solana leg holds only a float, consolidated into the vault at the lock | Met |
| 8 | `burnLockedUSDC()` callable only by a Circle-specified address, burning exactly the circulating supply | Implemented with Circle's signature on the vault; burns the unreserved balance, which the supply lock makes equal to circulating supply; the backing is in that one escrow after consolidation | Met |
| 9 | Pause bridging, reconcile in-flight, harmonize locked vs circulating supply | Phase 2, with exact verification: every movement of the asset is explicit by consensus | Met |
| 10 | In-place upgrade retaining supply, holders, integrations | Asset id is immutable; only display metadata succeeds to Circle | Met |
| 11 | (Implied by FiatToken) blacklist and pause capability post-upgrade | Supervision freeze and pause by consensus, keys rotated to Circle at handover. Reach is single-owner scripts; holdings in P2WSH, Taproot script-path and bare-multisig outputs are out of reach (5.5) | Met for single-owner holdings; the reach limit is stated |
| 12 | (Implied by FiatToken) allowances, permit, EIP-3009 gasless flows | Not applicable to UTXO; the practical need (users transact holding only USDC) is met natively by any-asset fees | Not applicable, with a native analogue |
| 13 | Backing is native USDC locked on the origin chain | Backing is exclusively Circle-issued native USDC, arriving from Ethereum, Solana or any CCTP chain and held in one Ethereum vault apart from a Solana working float; other wrappers are forbidden as backing | Met, multi-origin documented |

## 9. Implementation, and what adoption still requires

**Where each part lives:**

| Part | Implementation |
|---|---|
| Issuance ceremony, supervision keys, unified mapping, routing, solvency gating | `compagesd` (`daemon/lib/bridge.js`, Compages repository) |
| Ethereum escrow | `CompagesVault` v3 (`contracts/src/CompagesVault.sol`), Sepolia `0x7B702D6A2E2351F0c4E549642e65AbABC0324384` |
| Solana leg, including SPL USDC | `daemon/lib/sol.js` |
| CCTP V2: consolidation, inbound deposits, outbound payouts | `daemon/lib/cctp.js`, `daemon/lib/cctp-sol.js`, and the vault's `receiveCctp`, `releaseViaCctp`, `refundViaCctp` |
| Supply auditor | `contrib/asset-supply-audit/` (node repository) |
| Proof of reserves | `GET /api/por` on the bridge (live); signed snapshots at `GET /api/por/history`, taken by `reserves/snapshot.mjs` (Compages repository) and mirrored in `ConcatenaLabs/compages-reserves` |
| Independent watcher | `watcher/compages-watch.js` (Compages repository) |
| Supervision | `src/supervision.cpp` and the `supervision` RPC category (node repository) |
| Registry succession | `POST /succeed` (`sequentia-registry`) |
| End-to-end test | `e2e/run-e2e.sh` (Compages repository): unified ceremony, deposits from Ethereum and Solana into one `USDC.e`, redemption, registry binding, and fault injection against the node |

**Required before Circle can adopt the asset.** None of these is a protocol change; each is
a condition on the deployment.

- **An external security audit** of `CompagesVault` and of the daemon's mint, release and
  burn paths. Only internal review and the test suites exist.
- **Owner custody held by the issuer's signers.** The vault owner MUST be a Safe (or
  equivalent multisig) whose signers are the issuer's, with the guardian a separate key
  and the operator the only hot key. On the testnet vault the owner is a 2-of-3 Safe,
  `0xc5540Be5eDc4D06459964dE061aFAB5c3b0025c0`, whose signers are the bridge operator's
  keys.
- **Threshold custody of the asset's powers.** The supervision keys and the reissuance
  token MUST be held under threshold custody (FROST or MuSig2 for the Schnorr supervision
  keys), with the recovery key cold. On the testnet assets the recovery key is a single
  cold key held off the bridge's host, and the operational key and the token are in the
  bridge's node wallet. A mainnet asset MUST be issued with pinned public
  keys rather than keys derived from the bridge's node wallet, since the keys committed at
  issuance are permanent in the asset id.
- **An unbroken reserve history from the first mainnet deposit.** Signed snapshots at
  fixed heights, hash-linked and mirrored publicly (section 5.4), MUST run from the
  mainnet asset's first deposit, so the record Circle inherits has no gap.
- **A verified registry identity.** The registry serves the asset's contract and
  supervision data but does not mark the entry chain- and domain-verified. The asset MUST
  be registered through the verified path, with the domain proof served, before the
  identity it will hand to Circle is presented as verified.
- **Mainnet issuance.** The live asset is a testnet asset backed by testnet USDC. The
  mainnet asset is a fresh issuance, by the same ceremony, against Circle's mainnet USDC
  and CCTP contracts.
- **Hand-off rehearsal.** `burnLockedUSDC` is tested against a mock token. The full
  sequence of section 6 (lock, consolidation to zero float, token transfer, both key
  rotations, burn) SHOULD be rehearsed end to end on testnet with Circle's participation
  before it is relied on.

A per-asset supply index in the node (a `getassetsupply` RPC) would make the audit a
single call; it is not required, since the auditor already answers the question.

## 10. Risks and decisions

**Risks:**

- Circle's upgrade is an option, never an obligation, and Circle has completed upgrades
  only on EVM chains. A UTXO chain is a novel due-diligence exercise for them. This spec's
  job is to make every technical answer in that exercise written down and verifiable; the
  discretionary risk remains.
- The freeze reaches single-owner holdings only (5.5). A holder can keep `USDC.e` in a
  script a freeze cannot reach. This is the price of never trapping a counterparty in a
  channel, HTLC or covenant, and it is likely the point Circle examines hardest.
- Multi-source backing is a generalization of the standard, not a violation of it. The
  consolidation mechanism reduces it to the single-escrow case Circle knows before the
  burn.
- `USDC.e` holders cannot use confidential transactions. Supply and distribution are
  fully visible, which serves the audit and the freeze, and costs holders the
  confidentiality other Sequentia assets allow.
- The registry label layer is advisory and HTTP-served; nothing about supply or ownership
  depends on it, but display spoofing is a real, chain-wide concern that succession does
  not worsen. Registry transport hardening is worth doing independently of this spec.
- Until the custody requirements of section 9 are met, a compromised operator key can
  misuse the bridge within the vault's limits, and a compromised node wallet holds the testnet asset's operational supervision key
  (never its recovery key, which is cold and can rotate the operational key away).

**Decisions this standard rests on:**

- **D1. Precision 6.** Unified assets map one atom to one source base unit rather than
  following the bridge's precision-8 convention. At precision 8 a redemption would floor
  its payout while burning the full amount, leaving escrow dust that breaks the exact
  equality the supply lock needs; `nDenomination` is read from the initial issuance and
  can never be changed; and fees stay correct because the price server publishes rates
  scaled by `10**(8 - precision)` while the node values a fee as `atoms * rate / 1e8`.
- **D2. Supervised, with pause.** The asset is issued as a supervised asset with the
  pause bit, because Circle's native deployments all carry a freeze, and supervision can
  only be conferred at issuance.
- **D3. Fee eligibility.** `USDC.e` is priced as USDC by the reference price-server
  configuration, so nodes running it accept `USDC.e` for fees. Each node operator decides
  its own fee whitelist; admitting `USDC.e` is what makes the asset usable with no
  companion asset.
- **D4. One escrow.** Backing arriving on Solana or any CCTP chain is consolidated into
  the Ethereum vault over CCTP, so Circle burns one escrow.

## Appendix A. Relation to the Elements-targeted draft

A draft specification titled "Bridged-to-Native Stablecoin Standard, Technical
Specification for Elements-Based UTXO Architectures" has circulated as a starting point
for this problem. It is directionally useful and specifically wrong for Sequentia. Nothing
in this spec depends on it.

**Adopted from it** (independently verified against this codebase): the reissuance token
as the ownership-transfer root; `destroyamount` burns as the supply-reduction primitive;
the three-phase lifecycle skeleton (bridged, audit, takeover), here expanded to six phases
with the reconciliation, key-rotation and metadata steps it omits.

**Rejected:**

- Its central mechanism, a mandatory "Compliance Wrapper" of recursive Simplicity
  covenants with a compliance-oracle co-signature on every transfer. A covenant binds only
  outputs created under it, and an oracle in the path of every transfer makes the asset
  uncomposable with channels, DEX orders and any other contract. Sequentia reaches the
  same compliance goal at consensus instead: supervision freezes holdings without any
  party co-signing ordinary transfers (section 5.5).
- Its claim that the issuer "simply parses the blockchain state" to audit supply. There
  is no per-asset supply accounting in the node; auditability is constructed from the
  explicit-by-consensus rule and the auditor tool (section 5.4).
- Its "Oracle Key Rotation... via a Simplicity state-update transaction", which has no
  corresponding mechanism on this chain. Key rotation for this asset is supervision's
  recovery-key rotation.

**Absent from it entirely:** the multi-source unification problem (the reason this spec
exists), naming and registry identity, precision and unit mapping, source-chain burn
hooks (`burnLockedUSDC`), pause and reconciliation mechanics, escrow consolidation, and
every operational detail of the handover.

## Appendix B. Issuance runbook

`compagesd` performs steps 2 to 5 itself for every asset under `unified` in its
configuration. By hand:

1. Pin the keys: generate the issuer key once, back it up, record its compressed pubkey
   as `unifiedIssuerPubkey`. Generate the two supervision keys (distinct x-only keys,
   under threshold custody for anything beyond testnet) and record their public halves as
   `supervision.operationalKey` and `supervision.recoveryKey`.
2. Issue (RPC amounts are expressed in 8-decimal units regardless of asset precision;
   atom counts are what matter):

   ```
   sequentia-cli -named issueasset assetamount=0 tokenamount=1 blind=false \
     fee_asset=<fee asset> denomination=6 \
     contract='{"name":"Bridged USDC (Compages)","ticker":"USDC.e",
                "domain":"<bridge domain>","precision":6,
                "issuer_pubkey":"<pinned key>"}' \
     supervision='{"operationalkey":"<x-only key>","recoverykey":"<x-only key>",
                   "pause":true}'
   ```

3. Record `asset`, `token`, `entropy`, `txid`, the returned `contract` and
   `contract_hash`. Verify the asset id re-derives from the issuance prevout and contract
   hash, and that `getsupervisedassets` lists the asset with the intended keys and
   `pauseallowed: true`.
4. Confirm the reissuance token landed in the bridge wallet (`listunspent` filtered to the
   token asset id). Back up the wallet.
5. Register the contract with the registry and serve the domain proof; confirm the asset
   appears verified with ticker `USDC.e` and precision 6.
6. Run the supply auditor: expected supply 0. Publish the first `/api/por` snapshot.
7. Open deposits.
