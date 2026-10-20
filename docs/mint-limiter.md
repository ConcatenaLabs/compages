# The mint limiter: running it

Every Sequentia asset Compages mints has a reissuance token, and whoever holds
the token can mint any amount. Compages keeps each token in a mint limiter, a
covenant from [sequentia-contracts](https://github.com/ConcatenaLabs/sequentia-contracts)
(`templates/mint_limiter`, described in its `docs/mint-limiter.md`). This page
is how to set it up and how to act on it.

| Key | Where it lives | What it can do |
|---|---|---|
| Operator key | a mnemonic file on the bridge host (`mintLimiter.operatorMnemonicFile`) | mint, at most `allowance` atoms per window of `windowBlocks` blocks |
| Cold key | a mnemonic written down offline, never on the bridge host | sign the brake once, in advance; lift the brake; take the token after the brake has held `recoveryDelay` |
| Arm signature | wherever the brake should be pulled from: the operator's laptop, a watcher | apply the brake, and nothing else |

The daemon mints through the limiter and nowhere else once `mintLimiter` is
configured: a deposit of an asset whose token is still in the wallet waits
until the token is moved in, and a bare reissuance never happens. A mint the
covenant would refuse waits instead of failing: over the window's allowance it
waits for the next window, on a braked limiter until the brake is lifted, and
on a coin younger than two blocks for the next block. A deposit larger than a
whole allowance is stopped for the operator (`failed_manual`). `/api/assets`
and `/api/por` show each asset's limiter: its address, coin, state, allowance
and window, and whether it is braked.

A new asset's first deposit is an issuance, not a reissuance, so it mints the
deposit's amount and then moves the new token into a limiter at once, with
`defaultAllowance`. A unified stablecoin's ceremony moves its token in the same
way. Every later deposit mints through the limiter.

## Setting it up

1. Build the tool in a sequentia-contracts checkout:

   ```sh
   cargo build --release --manifest-path tools/mint-limiter/Cargo.toml
   ```

   and set `mintLimiter.tool` to `tools/mint-limiter/target/release/mint-limiter`
   in that checkout (the tool reads its template from there).

2. Make the operator key on the bridge host, in a new file only its owner can
   read:

   ```sh
   mint-limiter key --new --mnemonic-file /path/to/limiter-operator.words
   ```

3. Make the cold key on another machine, and write the twelve words down
   offline: `mint-limiter key --new` prints them once with the key. Only the
   key (`"key"`, 32 bytes of hex) goes into `mintLimiter.coldKey`.

4. Configure, in `config.json`:

   ```json
   "mintLimiter": {
     "tool": "/path/to/sequentia-contracts/tools/mint-limiter/target/release/mint-limiter",
     "operatorMnemonicFile": "/path/to/limiter-operator.words",
     "coldKey": "<the cold key>",
     "windowBlocks": 1440,
     "recoveryDelay": 5063,
     "defaultAllowance": "<atoms per window for a newly bridged asset>",
     "allowances": { "USDC.e": "<atoms>", "ETH.e": "<atoms>" }
   }
   ```

   `windowBlocks` is in blocks (1,440 is a day at the testnet's 60-second
   blocks; at most 65,535), `recoveryDelay` in units of 512 seconds (5,063 is
   30 days), allowances in the asset's atoms, keyed by ticker, symbol or
   mapping key. Restart the daemon: it checks the tool runs, the operator
   mnemonic reads, and the cold key is another key, and logs how many assets
   still hold their token outside a limiter.

5. Move each existing asset's token in. With the daemon stopped:

   ```sh
   node limiter-move.js --all                         # every asset not yet in a limiter
   node limiter-move.js <mappingKey> [allowance]      # one asset
   ```

   or, from the running daemon:

   ```sh
   node admin.js limiters                                  # every asset and its limiter, or null
   node admin.js limiter-move <mappingKey> [allowance]     # the token, whole, into a new limiter
   ```

   Either checks that the wallet holds every unit the asset's issuance
   created: a token unit left outside could still mint without limit. It sends
   the whole token to the new instance's address in one transfer, paying the
   fee in `seqFeeAsset`, and prints the limiter. An asset already in a limiter
   is left as it is, so running it again changes nothing.

6. Make the arm signature, on the machine that holds the cold key, from the
   instance the daemon reports (`node admin.js limiters`, the `instance` field,
   saved as `instance.json`):

   ```sh
   mint-limiter arm-signature --instance instance.json --mnemonic-file cold.words
   ```

   Keep the `arm_signature` where the brake should be pulled from. It names no
   coin, so it works on whichever coin the limiter has when it is used, and it
   can only apply the brake. One is needed per asset.

## The brake

```sh
node admin.js limiter-arm <mappingKey> <arm signature>
```

applies it: the limiter's coin is spent into its braked state, the daemon pays
the fee, and no mint is possible until the cold key lifts it. Anyone holding
the signature and a coin to pay the fee can apply it the same way with the
tool's `build` (path `arm`), without the daemon. A mint needs a coin two
blocks old, so after any mint there is a block in which only the brake can
spend the coin: a thief holding the operator key mints at most once more
after the brake is broadcast, within the allowance.

The health report and the watcher raise a braked limiter as critical. Deposits
of the asset wait, and the daemon keeps following the coin.

To lift the brake, the cold key signs a `disarm` built by the tool on its own
machine, with a fee coin of its own wallet:

```json
{"path": "disarm", "coin": {"tx": "<the limiter coin's transaction>", "vout": 0},
 "state": <the limiter's state>, "fee": {"coins": [...], "atoms": "...", "change_to": "..."}}
```

`mint-limiter build --instance instance.json --mnemonic-file cold.words < request.json`
returns the transaction; its wallet signs the fee coin and broadcasts it. The
daemon sees the spend, follows it, and the waiting deposits mint.

## Recovery

When the operator key is lost or in other hands, brake the limiter, wait out
`recoveryDelay`, and have the cold key take the token with a `recover` build
(`recover_to`: where the token goes, such as the bridge wallet's new address).
Then put a new operator mnemonic in `operatorMnemonicFile`, restart, and move
the token into a new limiter with `limiter-move`. The daemon marks the old
limiter `recovered` and mints nothing for the asset until then.

Each mint the daemon did not sign that spends a limiter halts the asset's
minting: it means the operator key is used elsewhere. Brake first, then look.
