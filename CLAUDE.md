# Compages

A centralized, operator-run bridge between Ethereum (Sepolia) and the Sequentia testnet. Users
lock ether or an ERC-20 in a vault contract and receive a matching Sequentia asset; sending the
bridged asset back releases the original funds.

`README.md` states the trust model plainly and documents both flows. Read it first — this file
covers only the mechanics of working on the code.

Node and consensus conventions live in the
[`Sequentia`](https://github.com/GracedEternalKingCabbageMan/Sequentia) repo.

## Pieces

| Path | What |
|---|---|
| `contracts/` | Foundry project. One contract, `src/CompagesVault.sol`, with `test/CompagesVault.t.sol` and `script/Deploy.s.sol`. |
| `daemon/` | `compagesd.js` plus `lib/{api,bridge,eth,seqrpc,state}.js`. Node with one dependency, `ethers`. It also serves the web front-end. |
| `web/` | `index.html` + `app.js`, served by the daemon. |
| `e2e/` | `run-e2e.sh` and `driver.mjs`. |

```sh
cd daemon && npm install && npm start     # node compagesd.js
cd contracts && forge test                # the vault unit tests
```

There is no CI. Deployment is pull-only: the server pulls from GitHub. Never edit source on the
server.

## Finality is measured against Bitcoin, not Sequentia blocks

This is the design decision the whole bridge rests on, and it is easy to "simplify" into a fund
loss. Releasing on Ethereum is irreversible, so the Sequentia burn that triggers it must be final.
Bitcoin anchoring is Sequentia's supreme consensus rule: a burn buried under many Sequentia blocks
is still undone if its Bitcoin anchor is reorged.

So the release gate is the burn's **Bitcoin-anchor depth**, never a Sequentia confirmation count.
The gate additionally requires the node's `anchorstatus` to be `ok` and, when the node reports it,
the burn block to be committee-certified. It falls back to a Sequentia confirmation count only on
a chain without anchoring, such as regtest.

The live deployment anchors to Bitcoin testnet4 and therefore sets a deep threshold (100), because
testnet4's minimum-difficulty rule permits unusually deep reorgs. The config default of 3 suits a
chain anchored to Bitcoin proper. Do not lower the deployed value to make redemptions faster.

## Other invariants that must not regress

- **One Sequentia asset per ERC-20, forever.** The mapping from token contract to Sequentia asset
  id is created exactly once, on the first deposit; every later deposit reissues the same asset.
  Duplicate assets would silently split liquidity.
- **Releases and refunds are replay-guarded on chain** by deterministic ids, so nothing can be paid
  twice.
- **Redeemed Sequentia amounts are destroyed**, keeping circulating bridged supply equal to the
  locked Ethereum funds.
- **Undeliverable deposits are refunded automatically** — an invalid Sequentia address, or an
  amount too small to represent. Sequentia amounts carry 8 decimals, so a token with more decimals
  bridges at a granularity of `10^(d-8)`.
- **Every Sequentia fee is paid in the configured asset, never the policy asset by default.** This
  was a specific fix; Sequentia has an open fee market and no privileged unit.
- Chain ids, RPC endpoints, the vault address and confirmation depths are all configuration, and
  asset mappings are keyed per chain id. Keep it that way.

## Secrets

`daemon/config.json`, `daemon/operator.key`, `daemon/*.key`, `daemon/state/` and `e2e/run/` are
gitignored, and a working checkout has real ones on disk. **Never `git add -A` in this repo.**
The repository is public; a committed operator key is a total loss of the vault.

## Working in this repo

- **Commit author:**
  `GracedEternalKingCabbageMan <151803062+GracedEternalKingCabbageMan@users.noreply.github.com>`
- **Always open a pull request, then merge it yourself immediately.** The PR exists so the change
  and its reasoning are recorded, not because anyone is waiting to review it. There is no review
  process. If you are ever told to leave one specific PR open, that applies to that PR only and
  never becomes the default.
- PRs go against `main`, which is the remote default.
