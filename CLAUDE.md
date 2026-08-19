# Compages

A centralized, operator-run bridge into the Sequentia testnet from three chains: Ethereum
(Sepolia; lock ether or any ERC-20 in a vault contract, mint a matching Sequentia asset),
Bitcoin (testnet4; BTC to SBTC, proxied to the sbtc-bridge custody service), and Solana
(devnet; SOL or any SPL token to matching `.s` assets, custody native to the daemon).
Sending a bridged asset back releases the original funds.

`README.md` states the trust model plainly and documents both flows. Read it first — this file
covers only the mechanics of working on the code.

Node and consensus conventions live in the
[`Sequentia`](https://github.com/GracedEternalKingCabbageMan/Sequentia) repo.

## Pieces

| Path | What |
|---|---|
| `contracts/` | Foundry project. One contract, `src/CompagesVault.sol`, with `test/CompagesVault.t.sol` and `script/Deploy.s.sol`. |
| `daemon/` | `compagesd.js` plus `lib/{api,bridge,eth,sol,seqrpc,state}.js`. Node with one dependency, `ethers` (`lib/sol.js` hand-rolls the Solana wire format; keep it dependency-free). It also serves the web front-end. |
| `web/` | `index.html` + `app.js`, served by the daemon. |
| `e2e/` | `run-e2e.sh`, `driver.mjs`, and `mock-solana.mjs` (an in-memory Solana RPC that independently decodes and signature-checks submitted transactions). |

```sh
cd daemon && npm install && npm start     # node compagesd.js
cd contracts && forge test                # the vault unit tests
```

There is no CI. Deployment is pull-only: the server pulls from GitHub. Never edit source on the
server.

## Finality is measured against Bitcoin, not Sequentia blocks

This is the design decision the whole bridge rests on, and it is easy to "simplify" into a fund
loss. Releasing on Ethereum or Solana is irreversible, so the Sequentia burn that triggers it
must be final.
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
- **One Sequentia asset per unified stablecoin, across every chain it arrives from.** The same
  dollar reaching us from Ethereum and from Solana must be ONE asset, or the bridge creates the
  liquidity split it exists to prevent and forecloses a later in-place adoption by the issuer,
  which can only ever adopt a single asset. A unified asset is ONE mapping keyed `unified:SYMBOL`,
  with `state.tokenRoutes[tokenKey] -> mappingKey` pointing every source at it; per-chain facts
  (token, decimals, escrow, vault, token program) live in `mapping.sources`. Never model it as one
  mapping per chain sharing an asset id: supply increments and decrements would land on different
  records. It is issued in a ceremony before any deposit, with zero supply and one reissuance
  token. Spec: `doc/sequentia/bridged-usdc-standard.md` in the node repo.
- **Never lowercase a non-EVM token key.** Ethereum addresses are case-insensitive hex; Solana
  mints are base58, where case is significant. Lowercasing one yields a key no deposit can match,
  so a configured source silently fails to route and the next deposit mints a duplicate asset.
  `normalizeTokenKey` is the only correct way to canonicalize one.
- **Read issuance amounts from the raw transaction, never from `listissuances`.** That RPC reports
  `assetamount: -1` for a blinded issuance AND for an explicit zero one, so the two are
  indistinguishable there. In the transaction they are not: an explicit amount, a commitment, and
  no issuance at all are three distinct things.
- **Deposit nonces are per vault.** With more than one vault watched, a nonce no longer identifies
  a deposit and refund ids derived from it would collide. The primary vault keeps the bare nonce
  and the original refund-id form so records and ids already on chain stay valid; other vaults key
  `vault:nonce`.
- **Proof of reserves reports only what it measured.** Untracked escrow is null, not zero, and a
  backing verdict is given only when both sides were actually measured. A reassuring number nobody
  measured is worse than an honest gap.
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
- **Solana transfers are replay-guarded by precomputed signatures.** A Solana transaction's id is
  its fee payer's signature, known before broadcast; the daemon persists it (with the blockhash's
  `lastValidBlockHeight`) BEFORE sending, and after a crash the chain itself answers whether the
  transfer landed or can never land. Never "simplify" this into send-then-record.
- **An asset returned to the wrong leg's redemption address parks as `ignored_wrong_network`.**
  SOL.s must never reach the Ethereum vault release path, nor an Ethereum-bridged asset the
  Solana treasury; both directions are guarded and e2e-tested.

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

<!-- BEGIN SHARED AGENT CONVENTIONS: identical in every Sequentia repo. Change it in all of them together. -->
## Working with git and GitHub here

These rules are the same in every Sequentia repository. They are repeated in each
one because this file is the only thing an agent is guaranteed to read, whatever
machine it is working from.

**Nothing pushed to GitHub credits Claude, Anthropic, or any AI tool.** No
`Co-Authored-By: Claude` trailer, no `Claude-Session:` trailer or `claude.ai`
link, no "Generated with Claude Code" in a commit message or a pull request body,
no `claude/*` branch names or session ids, and no mention in source, comments,
docs or issue text. Agent tooling offers several of these by default; compose the
message without them rather than stripping them afterwards.

**Author every commit as**
`GracedEternalKingCabbageMan <151803062+GracedEternalKingCabbageMan@users.noreply.github.com>`.
Never a personal address.

**Every change lands through a pull request that you merge yourself, at once.**
There is no reviewer on this project; the pull request exists so the reasoning is
recorded beside the diff. Branch, push, open it, merge it, delete the branch, all
in one sitting. Pushing straight to the default branch is the rule most often
broken here, and it is the one that costs the record. A pull request stays open
only when the repository owner asks for that specific one, and that never carries
over to the next.

**Name branches `area/short-description`**: `fix/`, `doc/`, `feature/`, `test/`,
`build/`, or the component being changed. Never a tool name, a session id, or
`worktree-*`.

**Write the subject as `area: what changed`**, one line, 72 characters at the
outside and 50 where you can manage it. Put the reasoning in the body, and
explain why rather than what.

**These repositories are public and world-readable.** Never commit private keys,
seeds, `wallet.dat`, RPC credentials, `.env` files or API tokens. Read the diff
before every commit. Secrets belong on the server and in offline backups.

**A file belongs to the repository whose code it describes.** Decide which repo
owns it before writing it; if it landed in the wrong one, move it rather than
deleting it.

**Push the same day you commit.** The testnet server pulls only from GitHub, so a
branch left on one laptop is invisible to every other machine and to the box.
<!-- END SHARED AGENT CONVENTIONS -->
