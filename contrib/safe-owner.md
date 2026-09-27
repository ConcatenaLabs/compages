# Moving the vault owner to a Safe

The vault's `owner` holds every administrative power: it sets the other roles
and every limit, unpauses, moves unreserved escrow and names the stablecoin
burner. A single key in that role is a single point of failure. This runbook
moves the role to a [Safe](https://safe.global) multisig, so every owner action
needs a threshold of signers, and shows how to move it back.

Ownership moves in two steps on the vault: the current owner calls
`transferOwnership(safe)`, which only names a pending owner, and the Safe then
calls `acceptOwnership()` through a transaction its signers approve. Nothing
changes hands until the second step, and a mistyped address in the first
cannot take the vault, because nothing at that address can accept.

The tooling is `contracts/script/SafeOwner.s.sol`. It deploys Safe v1.4.1
(the `SafeL2` singleton behind a proxy, with the compatibility fallback
handler) through the canonical `SafeProxyFactory`, at the addresses listed in
[safe-global/safe-deployments](https://github.com/safe-global/safe-deployments/tree/main/src/assets/v1.4.1).
Every step checks that those addresses hold the expected code on the chain it
runs against, and that the Safe it is given is a proxy of that singleton with
that handler, and refuses otherwise.

## The other two roles stay as they are

**The guardian stays a single key.** Its job is to stop a drain, and the
watcher (`guardianKeyFile`, see "The watcher" in the README) pauses the vault
with it automatically, within a minute of seeing the books go wrong. A
multisig guardian would wait for people to wake up and sign while the
operator's rate-limited payouts kept flowing. The role is safe to leave on one
key because it cannot move funds or resume anything: a stolen guardian key can
at worst pause the bridge, and the Safe, as owner, resumes it and replaces the
guardian with `setGuardian`.

**The operator stays hot.** The daemon signs every release and refund with
it, unattended. Its damage is bounded by the per-token rate limit and the
release queue, which the guardian and the owner can cancel from.

`deploySafe()` refuses the operator or the guardian as a Safe signer: a key
that already holds one role must not also count toward the owner's threshold.

## Before you start

- [Foundry](https://getfoundry.sh), and `git submodule update --init` in the
  checkout.
- The signers' addresses and the threshold. Each signer keeps their own key:
  a hardware wallet, a Foundry keystore (`cast wallet import <name>
  --interactive`), or a wallet connected to the Safe web app.
- The current owner's key, available to Foundry as a keystore account or a
  hardware wallet. No step reads a key from the environment or a file in the
  repository.
- A little ether for gas in whichever account deploys the Safe and submits
  the final transaction; neither needs any role.

Rehearse the whole move first, on a local fork of Sepolia, against the live
vault and the real Safe contracts:

```
contrib/safe-owner-rehearsal.sh
```

It runs `contracts/test/fork/SafeOwnerRehearsal.t.sol`, which drives the same
script functions described below with the current owner impersonated and three
throwaway signer keys in a 2-of-3 Safe, and prints each step. It proves that
afterwards the Safe is the owner and the old key is refused, that an
owner-only call goes through the Safe, that the guardian still pauses alone
and the operator still releases, and that the Safe can hand ownership back to
a single key. `REHEARSAL_RPC_URL` overrides the RPC (Tenderly's public Sepolia
gateway by default), `FORK_BLOCK` pins the block and `VAULT` the vault. A
plain `forge test` skips it.

## The move

All commands run in `contracts/`. The script reads the vault from `VAULT`
(the live Sepolia vault when unset). Every `forge script` command simulates
first; leave off `--broadcast` to see what it would do without sending
anything.

```
cd contracts
export ETH_RPC_URL=<an RPC for the vault's chain>
export VAULT=0x7B702D6A2E2351F0c4E549642e65AbABC0324384
```

In the key flags below, `--account <name>` is a Foundry keystore account
(`cast wallet list` shows them). For a hardware wallet use `--ledger` or
`--trezor` instead, with `--sender <its address>` and, off the default
derivation path, `--mnemonic-derivation-paths <path>`.

### 1. Deploy the Safe

Any funded key can do this; it gets no power over the Safe.

```
SAFE_OWNERS=0x<signer1>,0x<signer2>,0x<signer3> SAFE_THRESHOLD=2 \
  forge script script/SafeOwner.s.sol --sig 'deploySafe()' \
  --rpc-url $ETH_RPC_URL --broadcast --account <deployer>
```

The address follows from the signers, the threshold and `SAFE_SALT_NONCE`
(default 0), and is printed before anything is sent. Running it again with
the same values finds the same Safe and sends nothing. The script prints the
Safe's owners, threshold and version as read back from the chain; check them.

```
export SAFE=0x<the Safe address>
```

### 2. The current owner names the Safe

```
forge script script/SafeOwner.s.sol --sig 'proposeSafe()' \
  --rpc-url $ETH_RPC_URL --broadcast --account <vault-owner>
```

The transaction is sent as the vault's current owner, whatever key is
supplied: Forge stops with "No associated wallet" unless that key is the
owner's. Afterwards `pendingOwner()` is the Safe and the owner is unchanged.
To abandon the move at this point, the owner calls
`transferOwnership(0x0000000000000000000000000000000000000000)`, or runs this
step again with a different `SAFE`.

### 3. Print the transaction the signers approve

```
forge script script/SafeOwner.s.sol --sig 'acceptTx()' --rpc-url $ETH_RPC_URL
```

This sends nothing. It prints the Safe transaction field by field (`to` is the
vault, `value` 0, `data` `0x79ba5097`, which is `acceptOwnership()`,
`operation` 0 for a call, every gas and refund field zero, and the Safe's
current `nonce`), its EIP-712 `safeTxHash`, which it has checked against the
Safe's own `getTransactionHash`, and the same transaction as EIP-712 typed
data. Send the signers the printed block, and save the typed-data line as
`safe-tx.json` for those signing with Foundry.

### 4. The signers sign

Each signer checks that the transaction they are shown matches the printed
one, above all `to`, `data` and the `safeTxHash`, then signs in one of two
ways.

**In the Safe web app.** Open the Safe at [app.safe.global](https://app.safe.global)
(Sepolia is `sep:<SAFE>`), choose *New transaction*, then *Transaction
Builder*, enter the vault address, and either pick `acceptOwnership` from its
ABI or switch on custom data and enter `0x79ba5097`, with no value. Before
signing, each signer checks that the app shows the vault as the recipient, a
plain call (not a MultiSend batch), the printed nonce and the printed
`safeTxHash` as its *Safe Tx hash*; anything else, do not sign. The other
signers confirm it in the app's queue, and the last one executes it there.
Skip step 5.

**With Foundry**, one 65-byte signature per signer:

```
cast wallet sign --data --from-file safe-tx.json --account <signer>   # or --ledger / --trezor
cast wallet sign --no-hash <safeTxHash> --account <signer>            # keystore accounts only
```

Both produce the same signature. Hardware wallets sign the typed data and
show its fields on the device; they do not sign a bare hash. A signature
authorises only this transaction at this nonce, so it is safe to send over any
channel.

### 5. Submit the signatures

Anyone with gas can submit; the signatures are the authorisation.

```
SAFE_SIGNATURES=0x<sig>,0x<sig> \
  forge script script/SafeOwner.s.sol --sig 'execAccept()' \
  --rpc-url $ETH_RPC_URL --broadcast --account <any funded key>
```

The signatures can be in any order. The script recovers each signer, refuses
one that is not an owner of the Safe or that signed twice, sorts them as the
Safe requires, and refuses fewer than the threshold before sending. A
signature made with `eth_sign` / `personal_sign` over the `safeTxHash` is
accepted too.

The signatures are bound to the Safe's nonce. If any other Safe transaction
executes first, run step 3 again and collect new signatures.

## Verify on chain

```
forge script script/SafeOwner.s.sol --rpc-url $ETH_RPC_URL
cast call $VAULT 'owner()(address)'            # the Safe
cast call $VAULT 'pendingOwner()(address)'     # 0x000...000
cast call $VAULT 'guardian()(address)'         # unchanged
cast call $VAULT 'operator()(address)'         # unchanged
cast call $VAULT 'setReleaseDelay(uint256)' 3600 \
  --from 0x<old owner>                         # reverts with NotOwner()
```

The last call is a simulation, not a transaction: it asks whether the old key
could still change a setting, and the answer must be `NotOwner()`. On a block
explorer the vault shows `OwnershipTransferStarted(oldOwner, safe)` in the old
owner's transaction and `OwnershipTransferred(oldOwner, safe)` in the Safe's,
beside the Safe's own `ExecutionSuccess`.

## Owner actions afterwards

Every owner-only call (`setReleaseLimit`, `unpauseReleases`, `setGuardian`,
`rebalanceOut`, and the rest in the README's roles table) is now a Safe
transaction to the vault: build it in the web app's Transaction Builder, or
encode it with `cast calldata` for signers using Foundry. The OFT receiver
(`src/CompagesOftReceiver.sol`) reads its owner from the vault, so its owner
calls move to the Safe with the same step. The guardian's
pauses and cancels, and the operator's releases and refunds, work exactly as
before and need no signatures.

## Moving it back

The move is reversible. The Safe names a single key as pending owner, and
that key accepts:

```
export NEW_OWNER=0x<the key>
forge script script/SafeOwner.s.sol --sig 'handBackTx()' --rpc-url $ETH_RPC_URL
# the signers sign the printed transaction, as in step 4
SAFE_SIGNATURES=0x<sig>,0x<sig> \
  forge script script/SafeOwner.s.sol --sig 'execHandBack()' \
  --rpc-url $ETH_RPC_URL --broadcast --account <any funded key>
cast send $VAULT 'acceptOwnership()' --rpc-url $ETH_RPC_URL --account <the key>
```

Moving to a different Safe is the same `handBackTx()` / `execHandBack()`
pair with the new Safe as `NEW_OWNER`, followed by steps 3 to 5 with `SAFE`
set to the new Safe.
