#!/usr/bin/env node
// compages-watch: an independent check on the Compages bridge.
//
//   node compages-watch.js [config.json]
//
// The bridge daemon reports on itself; this process does not take its word
// for anything that matters. It reads the chains through its OWN endpoints
// (a different Ethereum RPC, the block explorer's indexer for Sequentia
// supply, its own Solana RPC) and checks, once a minute:
//
//   1. Every vault's books, rebuilt from the vault's own events: no token may
//      have left a vault in greater amount than entered it, the vault must
//      still hold what its events say it holds, and the number of deposit
//      events the RPC returned must equal the vault's own deposit counter (an
//      RPC that silently drops logs is caught here, not trusted).
//   2. Reserves: for every bridged asset, circulating supply on Sequentia (as
//      the explorer's indexer counts it) may not exceed what the source chains
//      hold for it. A gap has to persist for `breachMinutes` before it counts,
//      because a redemption is paid out a few seconds before its burn.
//   3. The daemon itself: its health endpoint must answer, and not "failing",
//      for more than `daemonDownMinutes`.
//
// Anything critical is pushed to `alertUrl` and, when `daemonAdminToken` is
// set, the affected assets are halted in the daemon (minting and payouts
// stop until an operator clears them); with a guardian key the watcher also
// pauses payouts on a version-3 vault itself. Payouts at or above
// largePayout[token] (or all of them, with announceEveryPayout) are announced
// as they happen, so a payout nobody expected is seen.
//
// A status report is served on `statusPort` (127.0.0.1) at /status.

import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ethers } from "ethers";
import { Alerts } from "../daemon/lib/alerts.js";
import { ataAddress, TOKEN_PROGRAM, TOKEN_2022_PROGRAM } from "../daemon/lib/sol.js";
import {
  emptyBooks,
  applyEvent,
  checkVault,
  reserveShortfall,
  Streaks,
  unitsToAtoms,
  backingFrom,
  reserveBreached,
  shouldBrake,
  brakeTargets,
} from "./lib/checks.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const cfgPath = process.argv[2] ?? path.join(here, "config.json");
const cfg = JSON.parse(fs.readFileSync(cfgPath, "utf8"));
const log = (m) => console.log(`${new Date().toISOString()} ${m}`);
const alerts = new Alerts({ ...cfg, alertUrl: cfg.alertUrl, alertCooldownMinutes: cfg.alertCooldownMinutes ?? 360 }, (m) =>
  log(m.replace(/^ALERT /, "ALERT watcher: "))
);

// Every event any vault version emits that moves or commits funds.
const VAULT_EVENTS = new ethers.Interface([
  "event Deposited(uint256 indexed nonce, address indexed token, address indexed from, uint256 amount, string sequentiaAddress)",
  "event Released(bytes32 indexed redemptionId, address indexed token, address indexed to, uint256 amount)",
  "event Refunded(address indexed token, address indexed to, uint256 amount, bytes32 indexed refundId)",
  "event ReleaseDeferred(bytes32 indexed redemptionId, address indexed token, address indexed to, uint256 amount)",
  "event Claimed(address indexed token, address indexed account, address indexed payTo, uint256 amount)",
  "event Rebalanced(address indexed token, address indexed to, uint256 amount, string destination)",
  "event RebalancedIn(address indexed token, uint256 amount, uint32 indexed sourceDomain, bytes32 sender)",
  "event CctpUnrecognized(uint32 indexed sourceDomain, bytes32 sender, bytes32 cctpNonce, uint256 amount, bytes hookData)",
  "event LockedStablecoinBurned(address indexed token, uint256 amount)",
  "event ReleasedViaCctp(bytes32 indexed redemptionId, uint32 indexed destinationDomain, bytes32 mintRecipient, uint256 amount)",
  "event RefundedViaCctp(bytes32 indexed refundId, uint32 indexed destinationDomain, bytes32 mintRecipient, uint256 amount)",
]);
const TRANSFER_TOPIC = ethers.id("Transfer(address,address,uint256)");
const VAULT_VIEWS = [
  "function depositCount() view returns (uint256)",
  "function cctpUsdc() view returns (address)",
  "function VERSION() view returns (uint256)",
  "function owedTotal(address) view returns (uint256)",
  "function queuedTotal(address) view returns (uint256)",
  "function cancelledTotal(address) view returns (uint256)",
];

/** What a vault holds of `token` that actually backs circulating supply:
 *  its balance minus what it has set aside for claimants and for queued or
 *  cancelled payouts (a version-3 vault's reservations). Counting those as
 *  backing would hide a shortfall of that size. */
async function backingHeld(address, token) {
  const held = (await vaultBalances(address, [token]))[token];
  const v = new ethers.Contract(address, VAULT_VIEWS, provider);
  let reserved = {};
  try {
    if (Number(await v.VERSION()) >= 3) {
      reserved = { owed: await v.owedTotal(token), queued: await v.queuedTotal(token), cancelled: await v.cancelledTotal(token) };
    }
  } catch (e) {
    if (e.code !== "CALL_EXCEPTION") throw e; // an older vault reserves nothing
  }
  return backingFrom(held, reserved);
}

/** USDC burned on Solana by the bridge's CCTP consolidation and not yet
 *  minted on Ethereum is still backing. The daemon lists those burns; each is
 *  checked here on Solana itself (final, successful, and moving that amount
 *  out of the treasury) rather than taken on the daemon's word. */
async function verifiedInTransit(assetId, mint) {
  let total = 0n;
  let por;
  try {
    por = (await json(`${cfg.daemonUrl.replace(/\/$/, "")}/api/por?asset=${assetId}`)).assets?.[0];
  } catch {
    return 0n;
  }
  for (const b of por?.inTransit ?? []) {
    if (!b.solanaBurn || !cfg.solRpcUrl) continue;
    const tx = await solRpc("getTransaction", [b.solanaBurn, { encoding: "jsonParsed", commitment: "finalized", maxSupportedTransactionVersion: 0 }]);
    if (!tx || tx.meta?.err) continue;
    const bal = (list) =>
      (list ?? [])
        .filter((x) => x.mint === mint && x.owner === cfg.solTreasury)
        .reduce((a, x) => a + BigInt(x.uiTokenAmount?.amount ?? 0), 0n);
    const moved = bal(tx.meta.preTokenBalances) - bal(tx.meta.postTokenBalances);
    if (moved === BigInt(b.amount)) total += moved;
  }
  return total;
}

// The USDC a vault burns and mints through CCTP: its CCTP events name no
// token, so the vault's own setting says which one moved.
const usdcOfVault = new Map();
async function cctpUsdcOf(address) {
  if (!usdcOfVault.has(address)) {
    let usdc = null;
    try {
      usdc = String(await new ethers.Contract(address, VAULT_VIEWS, provider).cctpUsdc()).toLowerCase();
    } catch {}
    usdcOfVault.set(address, usdc);
  }
  return usdcOfVault.get(address);
}
const ERC20 = ["function balanceOf(address) view returns (uint256)"];

// Two Ethereum providers on purpose. Logs come from `ethLogsRpcUrl` (few
// free endpoints serve full log history); balances and each vault's deposit
// counter come from `ethRpcUrl`, a different provider. A log source that
// drops events is then caught by a counter it did not supply.
const makeProvider = (url) => {
  const r = new ethers.FetchRequest(url);
  r.timeout = 30_000;
  return new ethers.JsonRpcProvider(r, cfg.ethChainId, { staticNetwork: true, batchMaxCount: 1 });
};
const provider = makeProvider(cfg.ethRpcUrl);
const logsProvider = cfg.ethLogsRpcUrl ? makeProvider(cfg.ethLogsRpcUrl) : provider;
const statePath = path.resolve(path.dirname(cfgPath), cfg.stateFile ?? "state/watch-state.json");

// ---- state -----------------------------------------------------------------

function loadState() {
  if (!fs.existsSync(statePath)) return { vaults: {}, streaks: {} };
  const raw = JSON.parse(fs.readFileSync(statePath, "utf8"), (k, v) =>
    typeof v === "string" && /^-?\d+n$/.test(v) ? BigInt(v.slice(0, -1)) : v
  );
  return raw;
}
function saveState() {
  fs.mkdirSync(path.dirname(statePath), { recursive: true });
  const tmp = `${statePath}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ ...state, streaks: streaks.toJSON() }, (k, v) => (typeof v === "bigint" ? `${v}n` : v)));
  fs.renameSync(tmp, statePath);
}
const state = loadState();
const streaks = new Streaks(state.streaks);
let report = { startedAt: new Date().toISOString(), lastRun: null, problems: [], vaults: {}, assets: {} };

// ---- vault books ------------------------------------------------------------

async function scanVault(v, safeHead) {
  const addr = v.address.toLowerCase();
  const st = (state.vaults[addr] ??= { cursor: v.deployBlock - 1, books: emptyBooks() });
  const chunk = cfg.ethLogChunk ?? 5000;
  const notes = [];
  for (let from = st.cursor + 1; from <= safeHead; from += chunk) {
    const to = Math.min(from + chunk - 1, safeHead);
    const logs = await logsProvider.getLogs({ address: v.address, fromBlock: from, toBlock: to });
    // Every ERC-20 transfer INTO the vault, whatever token and whoever sent
    // it: the complete record of what came in (see applyEvent).
    const inbound = await logsProvider.getLogs({
      fromBlock: from,
      toBlock: to,
      topics: [TRANSFER_TOPIC, null, ethers.zeroPadValue(v.address, 32)],
    });
    for (const l of inbound) {
      if (l.topics.length !== 3 || l.data.length < 66) continue; // not an ERC-20 Transfer (ERC-721 indexes the id)
      applyEvent(st.books, "TokenIn", { token: l.address.toLowerCase(), amount: BigInt(l.data.slice(0, 66)) });
    }
    for (const l of logs) {
      let ev;
      try {
        ev = VAULT_EVENTS.parseLog(l);
      } catch {
        continue;
      }
      if (!ev) continue;
      const a = ev.args;
      const token = a.token ?? (await cctpUsdcOf(v.address)) ?? ethers.ZeroAddress;
      const note = applyEvent(st.books, ev.name, {
        token: String(token),
        amount: BigInt(a.amount),
        to: a.to ?? a.payTo ?? null,
      });
      if (note) notes.push({ ...note, vault: addr, tx: l.transactionHash, block: l.blockNumber });
    }
    st.cursor = to;
  }
  return notes;
}

/** Balances at `blockTag`: the books are rebuilt only up to the finalized
 *  block, so they must be compared with the balances at that same block, or
 *  every payout of the last few minutes reads as funds that left without an
 *  event. */
async function vaultBalances(address, tokens, blockTag = "latest") {
  const out = {};
  for (const t of tokens) {
    out[t] =
      t === ethers.ZeroAddress
        ? BigInt(await provider.getBalance(address, blockTag))
        : BigInt(await new ethers.Contract(t, ERC20, provider).balanceOf(address, { blockTag }));
  }
  return out;
}

async function checkVaults() {
  const problems = [];
  const fin = await provider.getBlock(cfg.ethFinality === "latest" ? "latest" : "finalized");
  const safeHead = fin.number;
  for (const v of cfg.vaults) {
    const addr = v.address.toLowerCase();
    const notes = await scanVault(v, safeHead);
    for (const n of notes) {
      const big = cfg.largePayout?.[n.token.toLowerCase()];
      const isBig = big !== undefined && n.amount >= BigInt(big);
      log(`vault ${addr}: ${n.kind} of ${n.amount} ${n.token} ${n.to ? `to ${n.to} ` : ""}in ${n.tx}`);
      if (n.kind !== "deferred" && (isBig || cfg.announceEveryPayout)) {
        // A notice, not a condition: it is sent once and never "resolves".
        await alerts.post(`${isBig ? "LARGE " : ""}${n.kind} from vault ${addr.slice(0, 10)}`, `${n.amount} of ${n.token} in ${n.tx}`, isBig ? 4 : 2, [
          "money_with_wings",
        ]);
      }
    }
    const st = state.vaults[addr];
    const count = await new ethers.Contract(v.address, VAULT_VIEWS, provider).depositCount({ blockTag: safeHead });
    const balances = await vaultBalances(v.address, Object.keys(st.books.tokens), safeHead);
    const found = checkVault(addr, st.books, balances, count);
    for (const p of found) {
      if (p.rescan) {
        // Rebuild from scratch next pass; if the RPC is still dropping logs
        // the mismatch simply repeats and stays critical.
        state.vaults[addr] = { cursor: v.deployBlock - 1, books: emptyBooks() };
      }
    }
    problems.push(...found);
    report.vaults[addr] = {
      scannedTo: safeHead,
      deposits: st.books.deposits,
      depositCount: Number(count),
      tokens: Object.fromEntries(
        Object.entries(st.books.tokens).map(([t, b]) => [t, { in: `${b.in}`, out: `${b.out}`, owed: `${b.owed}`, held: `${balances[t]}` }])
      ),
    };
  }
  return problems;
}

// ---- reserves ---------------------------------------------------------------

async function json(url, opts = {}) {
  const res = await fetch(url, { ...opts, signal: AbortSignal.timeout(20_000) });
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  return res.json();
}

async function supplyAtoms(assetId) {
  const a = await json(`${cfg.esploraUrl.replace(/\/$/, "")}/asset/${assetId}`);
  const c = a.chain_stats ?? {};
  if (c.has_blinded_issuances) return null; // not knowable; never guess
  const m = a.mempool_stats ?? {};
  // Mempool issuances count too: a mint the chain has not confirmed yet is
  // still supply someone holds.
  return BigInt(c.issued_amount ?? 0) + BigInt(m.issued_amount ?? 0) - BigInt(c.burned_amount ?? 0) - BigInt(m.burned_amount ?? 0);
}

async function solRpc(method, params) {
  const r = await json(cfg.solRpcUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  if (r.error) {
    const e = new Error(r.error.message);
    e.code = r.error.code;
    throw e;
  }
  return r.result;
}

async function solHolding(owner, mint) {
  if (mint === "sol") return BigInt(await solRpc("getBalance", [owner, { commitment: "finalized" }]).then((r) => r.value));
  let total = 0n;
  for (const program of [TOKEN_PROGRAM, TOKEN_2022_PROGRAM]) {
    try {
      const r = await solRpc("getTokenAccountBalance", [ataAddress(owner, mint, program), { commitment: "finalized" }]);
      total += BigInt(r?.value?.amount ?? 0);
    } catch (e) {
      if (e.code !== -32602) throw e; // no account under this program
    }
  }
  return total;
}

async function checkReserves() {
  const problems = [];
  const now = Date.now();
  const assets = await json(`${cfg.daemonUrl.replace(/\/$/, "")}/api/assets`);
  let solOwners = null;
  for (const m of assets) {
    if (m.retired) continue;
    const row = { symbol: m.ticker ?? m.symbol, assetId: m.assetId };
    report.assets[m.assetId] = row;
    try {
      const supply = await supplyAtoms(m.assetId);
      let escrow = 0n;
      for (const src of m.sources) {
        let units;
        if (src.chainId === cfg.ethChainId) {
          const token = src.token === "eth" || src.token === "sol" ? ethers.ZeroAddress : src.token;
          units = 0n;
          for (const v of cfg.vaults) units += await backingHeld(v.address, token);
        } else if (cfg.solRpcUrl && src.chainId === cfg.solChainLabel) {
          solOwners ??= [
            cfg.solTreasury,
            ...(await json(`${cfg.daemonUrl.replace(/\/$/, "")}/api/sol/intents`)).addresses,
          ];
          units = 0n;
          for (const o of solOwners) units += await solHolding(o, src.token);
          if (m.unified) units += await verifiedInTransit(m.assetId, src.token);
        } else {
          throw new Error(`no reader for source chain ${src.chainId}`);
        }
        escrow += unitsToAtoms(units, src.decimals, m.precision ?? 8);
      }
      const short = reserveShortfall(supply, escrow);
      row.supply = `${supply}`;
      row.escrow = `${escrow}`;
      const held = streaks.observe(`reserve:${m.assetId}`, short !== null && short > 0n, now);
      if (reserveBreached(short, held, cfg.breachMinutes ?? 10)) {
        problems.push({
          key: `reserve:${m.assetId}`,
          severity: "critical",
          title: `${row.symbol} circulating supply exceeds its escrow`,
          detail: `supply ${supply} atoms, escrow ${escrow} atoms, for ${Math.round(held / 60_000)} min`,
          assetId: m.assetId,
        });
      }
    } catch (e) {
      row.error = e.message;
    }
  }
  return problems;
}

// ---- the daemon --------------------------------------------------------------

async function checkDaemon() {
  let bad = false;
  let why = "";
  try {
    const res = await fetch(`${cfg.daemonUrl.replace(/\/$/, "")}/api/health`, { signal: AbortSignal.timeout(20_000) });
    const h = await res.json();
    report.daemon = { status: h.status, problems: h.problems.length };
    bad = h.status === "failing";
    why = h.problems.map((p) => p.title).join("; ");
  } catch (e) {
    bad = true;
    why = `unreachable: ${e.message}`;
    report.daemon = { status: "unreachable" };
  }
  const held = streaks.observe("daemon", bad);
  if (bad && held >= (cfg.daemonDownMinutes ?? 10) * 60_000) {
    return [{ key: "daemon", severity: "critical", title: "the bridge daemon is failing or unreachable", detail: why }];
  }
  return [];
}

// ---- the brake ----------------------------------------------------------------

// With a guardian key (a vault role that can pause and cancel queued
// payouts, and nothing else), a critical finding also pauses payouts on the
// vault itself. That holds even if the daemon, its host or its admin API is
// the thing that failed; only the vault's owner can resume.
const guardian = cfg.guardianKeyFile
  ? new ethers.Wallet(fs.readFileSync(path.resolve(path.dirname(cfgPath), cfg.guardianKeyFile), "utf8").trim(), provider)
  : null;
const GUARDIAN_ABI = [
  "function guardian() view returns (address)",
  "function releasesPaused() view returns (bool)",
  "function pauseReleases()",
];

async function pauseVault(address, why) {
  if (!guardian) return;
  try {
    const v = new ethers.Contract(address, GUARDIAN_ABI, guardian);
    if (String(await v.guardian()).toLowerCase() !== guardian.address.toLowerCase()) return; // not our role here
    if (await v.releasesPaused()) return;
    const tx = await v.pauseReleases();
    await tx.wait(1, 120_000);
    log(`PAUSED payouts on vault ${address} (${tx.hash}): ${why}`);
    await alerts.raise(`paused:${address}`, `payouts paused on vault ${address.slice(0, 10)}`, `${why}. Only the owner can resume.`, {
      priority: 5,
    });
  } catch (e) {
    log(`could not pause vault ${address}: ${e.message}`);
  }
}

async function brake(p) {
  // Which vaults the finding concerns: the one named, or every vault that
  // escrows the affected asset.
  for (const v of brakeTargets(p, cfg.vaults, []).pause) await pauseVault(v, p.title);
  if (!cfg.daemonAdminToken) return;
  const assets = await json(`${cfg.daemonUrl.replace(/\/$/, "")}/api/assets`).catch(() => []);
  // A vault-level fault halts every asset backed by that token.
  for (const assetId of brakeTargets(p, cfg.vaults, assets).halt) {
    try {
      await json(`${cfg.daemonUrl.replace(/\/$/, "")}/api/admin/halt`, {
        method: "POST",
        headers: { authorization: `Bearer ${cfg.daemonAdminToken}`, "content-type": "application/json" },
        body: JSON.stringify({ assetId, scope: "all", reason: `watcher: ${p.title}` }),
      });
      log(`halted ${assetId} in the daemon: ${p.title}`);
    } catch (e) {
      log(`could not halt ${assetId}: ${e.message}`);
    }
  }
}

// ---- loop ---------------------------------------------------------------------

async function pass() {
  const problems = [];
  for (const [name, fn] of [
    ["vaults", checkVaults],
    ["reserves", checkReserves],
    ["daemon", checkDaemon],
  ]) {
    try {
      problems.push(...(await fn()));
    } catch (e) {
      const held = streaks.observe(`check:${name}`, true);
      log(`check ${name} failed: ${e.message}`);
      if (held >= 30 * 60_000) {
        problems.push({ key: `check:${name}`, severity: "warning", title: `the watcher cannot run its ${name} check`, detail: e.message });
      }
      continue;
    }
    streaks.observe(`check:${name}`, false);
  }
  const active = new Set();
  for (const p of problems) {
    active.add(p.key);
    await alerts.raise(p.key, p.title, p.detail, { priority: p.severity === "critical" ? 5 : 4 });
    if (shouldBrake(p)) await brake(p);
  }
  await alerts.settle(active);
  report = { ...report, lastRun: new Date().toISOString(), problems };
  saveState();
}

http
  .createServer((req, res) => {
    res.writeHead(req.url === "/status" ? 200 : 404, { "content-type": "application/json" });
    res.end(req.url === "/status" ? JSON.stringify(report, (k, v) => (typeof v === "bigint" ? `${v}` : v), 1) : "{}");
  })
  .listen(cfg.statusPort ?? 9951, "127.0.0.1");

log(
  `compages-watch: ${cfg.vaults.length} vault(s) on chain ${cfg.ethChainId}; state from ${new URL(cfg.ethRpcUrl).host}, ` +
    `logs from ${new URL(cfg.ethLogsRpcUrl ?? cfg.ethRpcUrl).host}, supply from ${cfg.esploraUrl}`
);
await pass();
setInterval(() => pass().catch((e) => log(`pass failed: ${e.message}`)), cfg.intervalMs ?? 60_000);
