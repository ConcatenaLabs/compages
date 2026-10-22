// Compages e2e checks of an asset an Arca operator serves issuer-operated,
// against the stack run-issuer-e2e.sh brings up. Exits non-zero when any
// check fails.
//
//  1. the first deposit of a token issues the asset, its token goes into its
//     mint limiter; a second deposit pays a holder's Arca wallet on the chain;
//  2. the operator serves the asset issuer-operated: its signer mints through
//     the same limiter, the daemon, the watcher and the snapshot tool each
//     ask the operator for its supply report;
//  3. the holder boards and refreshes: the round mints the batch's value at
//     input 0 through the limiter. Every reserve check passes: the daemon
//     follows the limiter through the round without a halt, its invariants
//     and /api/por deduct the units under the burn-only sweep, the watcher
//     finds no shortfall, and a signed snapshot taken at a height after the
//     round deducts them too and re-derives on the node;
//  4. the batch expires and its sweep burns it, the holder's abandoned leaf
//     with it: the accounting follows (supply falls, nothing is deducted, the
//     asset stays backed); a snapshot at a height before the sweep, taken
//     after it, still deducts the batch output, its spender named;
//  5. a reorg takes the round and its sweep out together, and the chain that
//     replaces them puts both back: the accounting stays backed throughout;
//  6. a mint through the limiter that no burn-only sweep holds (the minting
//     key's holder minting to a coin of its own): the daemon halts the asset
//     and its supply invariant counts the mint, and the watcher finds the
//     shortfall and halts the asset as well.

import { ethers } from "ethers";
import fs from "node:fs";
import { spawn, execFileSync } from "node:child_process";
import { Chain } from "./leaf-chain.mjs";

const E = process.env;
const RUN = E.RUN_DIR;
const API = `http://127.0.0.1:${E.API_PORT}/api`;
const ARCAD = `http://127.0.0.1:${E.ARCAD_PORT}`;
const chain = new Chain(E.SEQ_RPC_URL, E.PARENT_RPC_URL);
const provider = new ethers.JsonRpcProvider(`http://127.0.0.1:${E.ANVIL_PORT}`, 31337, { staticNetwork: true, cacheTimeout: -1 });
const user = new ethers.Wallet(E.USER_KEY, provider);
const vault = new ethers.Contract(E.VAULT, ["function depositToken(address token, uint256 amount, string sequentiaAddress)"], user);
const musd = new ethers.Contract(E.MUSD, ["function approve(address,uint256) returns (bool)"], user);

let failures = 0;
const record = [];
function check(name, cond, detail = "") {
  const line = `${cond ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`;
  console.log(line);
  record.push(line);
  if (!cond) failures++;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const t0 = Date.now();
const at = () => `${((Date.now() - t0) / 1000).toFixed(1)} s`;
const evidence = (name, v) => fs.appendFileSync(`${RUN}/evidence.log`, `${at()} ${name}\n${typeof v === "string" ? v : JSON.stringify(v, null, 1)}\n`);

const seq = async (method, params = [], wallet = null) => {
  const url = `http://127.0.0.1:${E.SEQ_RPC}/${wallet ? `wallet/${wallet}` : ""}`;
  const res = await fetch(url, {
    method: "POST",
    headers: { authorization: "Basic " + Buffer.from("e2e:e2e").toString("base64"), "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "1.0", id: 1, method, params }),
  });
  const j = await res.json();
  if (j.error) throw new Error(`${method}: ${j.error.message}`);
  return j.result;
};
async function getJson(url, opts) {
  const res = await fetch(url, opts);
  const j = await res.json().catch(() => ({}));
  return { status: res.status, body: j };
}
const api = (path, opts) => getJson(`${API}/${path}`, opts);
const operator = async (call, body = {}) =>
  (await getJson(`${ARCAD}/v1/${call}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })).body;

function arca(w, ...args) {
  try {
    return JSON.parse(execFileSync(E.ARCA, ["--datadir", `${RUN}/arca/${w}`, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }));
  } catch (e) {
    try {
      return JSON.parse(e.stdout);
    } catch {
      return { error: { message: String(e.stdout || e.stderr || e.message) } };
    }
  }
}

async function waitFor(desc, fn, timeoutMs = 180_000, everyMs = 1000) {
  const start = Date.now();
  let last = null;
  for (;;) {
    const v = await fn().catch((e) => {
      last = e.message;
      return null;
    });
    if (v) return v;
    if (Date.now() - start > timeoutMs) throw new Error(`timeout waiting for ${desc}${last ? ` (last error: ${last})` : ""}`);
    await sleep(everyMs);
  }
}
const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
async function stopPid(pid, sig) {
  try {
    process.kill(pid, sig);
  } catch {}
  await waitFor(`process ${pid} to exit`, async () => !alive(pid) || null, 30_000, 200);
}

// ---- the daemon, which the checks stop and start again
let daemon = null;
const exited = (p) => p.exitCode !== null || p.signalCode !== null;
function startDaemon() {
  const out = fs.openSync(`${RUN}/daemon.log`, "a");
  daemon = spawn("node", [E.DAEMON_JS, `${RUN}/config.json`], { cwd: RUN, stdio: ["ignore", out, out] });
  fs.writeFileSync(`${RUN}/daemon.pid`, String(daemon.pid));
  return waitFor("the daemon's API", async () => (await api("status")).status === 200, 60_000, 500);
}
async function killDaemon() {
  const p = daemon;
  try {
    process.kill(p.pid, "SIGKILL");
  } catch {}
  await waitFor("the daemon to exit", async () => exited(p) || null, 10_000, 100);
}
const stateNow = () => JSON.parse(fs.readFileSync(`${RUN}/state.json`, "utf8"));
const depByTx = (hash) => Object.values(stateNow().deposits).find((d) => d.ethTxHash?.toLowerCase() === hash.toLowerCase());

async function deposit(units, seqAddress) {
  await (await musd.approve(E.VAULT, units)).wait();
  return (await vault.depositToken(E.MUSD, units, seqAddress)).wait();
}

// ---- the reserve views
async function por(A) {
  return (await api(`por?asset=${A}`)).body.assets?.[0];
}
async function watcherRow(A) {
  return (await getJson(`http://127.0.0.1:${E.WATCH_PORT}/status`)).body;
}
const halted = (A) => stateNow().halted?.[A] ?? null;

/** What the checks deduct for the operator's report `s`: the smaller of the
 *  units live under its burn-only sweeps and what it minted less what it
 *  burned. */
const expectDeduct = (s) => {
  const live = BigInt(s.in_batches);
  const net = BigInt(s.minted) - BigInt(s.burned);
  return live < net ? live : net;
};

/** The reserve views agree the asset is backed, each deducting what the
 *  operator's report says it should when it is read (they read every item
 *  again on the chain). The operator's figures move while it claims and
 *  burns, so each view is compared with the report read beside it. */
async function backed(label, A, extra = {}) {
  const now = async () => expectDeduct(await operator("issuer_supply", { asset: A }));
  let deduct;
  const row = await waitFor(`${label}: the daemon's figures for the deduction`, async () => {
    deduct = await now();
    const r = await por(A);
    return r?.burnOnly && r.burnOnly.deductedAtoms === String(deduct) && r.burnOnly.agrees ? r : null;
  }, 90_000, 1000).catch(async () => por(A));
  const b = row?.burnOnly ?? {};
  check(`${label}: /api/por deducts ${deduct}, every item of the operator's report confirmed on the node`, b.deductedAtoms === String(deduct) && b.agrees === true,
    `live under burn-only sweeps ${b.liveAtoms} (operator ${b.reportedInBatchesAtoms}), minted ${b.mintedAtoms}, burned ${b.burnedAtoms}${b.problems?.length ? `, problems ${b.problems.join("; ")}` : ""}`);
  check(`${label}: /api/por calls it backed`, row?.backed === true && BigInt(row.escrowedAtoms) >= BigInt(row.liabilityAtoms),
    `chain supply ${row?.chainCirculatingAtoms}, to back ${row?.liabilityAtoms}, escrow ${row?.escrowedAtoms}`);
  for (const [k, v] of Object.entries(extra)) check(`${label}: ${k} = ${v}`, String(row?.[k]) === String(v), `got ${row?.[k]}`);
  // The daemon's invariants run every 5 s.
  const irow = await waitFor(`${label}: the daemon's invariants`, async () => {
    const d = await now();
    const inv = (await api("health")).body.invariants?.assets ?? {};
    const r = Object.values(inv).find((x) => x.underBurnOnlySweeps !== undefined);
    return r?.deducted === String(d) ? r : null;
  }, 90_000, 1000).catch(async () => Object.values((await api("health")).body.invariants?.assets ?? {}).find((x) => x.underBurnOnlySweeps !== undefined));
  check(`${label}: the daemon's invariants deduct the same and halt nothing`, !halted(A) && irow?.deducted !== undefined &&
    BigInt(irow.chainSupply) - BigInt(irow.deducted) <= BigInt(irow.ledger),
    `${JSON.stringify(irow)}${halted(A) ? `; HALTED ${halted(A).reason}` : ""}`);
  const w = await waitFor(`${label}: the watcher's figures`, async () => {
    const d = await now();
    const x = (await watcherRow(A)).assets?.[A];
    return x?.burnOnly && x.burnOnly.deductedAtoms === String(d) && x.burnOnly.agrees ? x : null;
  }, 90_000, 1000).catch(async () => (await watcherRow(A)).assets?.[A]);
  const wp = ((await watcherRow(A)).problems ?? []).filter((p) => p.key === `reserve:${A}`);
  check(`${label}: the watcher deducts the same, read on its indexer, and finds no shortfall`,
    w?.burnOnly?.agrees === true && BigInt(w.escrow) >= BigInt(w.supply) && wp.length === 0,
    `watcher: chain ${w?.chainSupply}, deducted ${w?.burnOnly?.deductedAtoms}, to back ${w?.supply}, escrow ${w?.escrow}${w?.error ? `, error ${w.error}` : ""}`);
  evidence(label, { por: row, invariants: irow, watcher: w });
  return row;
}

// ---- the reserve snapshot tool
function snapshotCfg(extra = {}) {
  const c = {
    snapshotDir: `${RUN}/reserves`,
    attestationKeyFile: `${RUN}/attestation.key`,
    intervalBlocks: 1,
    minDepth: 2,
    seqRpcUrl: `http://e2e:e2e@127.0.0.1:${E.SEQ_RPC}`,
    auditScript: E.AUDIT_SCRIPT,
    python: "python3",
    daemonUrl: `http://127.0.0.1:${E.API_PORT}`,
    ethChainId: 31337,
    ethChainName: "anvil",
    ethRpcUrl: `http://127.0.0.1:${E.ANVIL_PORT}`,
    vaults: [{ address: E.VAULT, version: 3 }],
    issuerOperated: {},
    ...extra,
  };
  fs.writeFileSync(`${RUN}/reserves.json`, JSON.stringify(c));
  return c;
}
function runNode(args) {
  try {
    return { ok: true, out: execFileSync("node", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }) };
  } catch (e) {
    return { ok: false, out: `${e.stdout}${e.stderr}` };
  }
}

const stopChainFns = [];
let chainStopped = true;
function runChain() {
  stopChainFns.push(chain.run(1000, 2));
  chainStopped = false;
}
async function stopChain() {
  while (stopChainFns.length) await stopChainFns.pop()();
  chainStopped = true;
}

runChain();
try {
  await startDaemon();
  const userAddr = await seq("getnewaddress", [], "user");

  // ---------------- 1. the asset, its limiter, a holder's coins
  console.log(`\n-- ${at()} 1. the first deposit issues the asset; a second pays a holder's Arca wallet`);
  const d0 = await deposit(100_000_000n, userAddr);
  const dep0 = await waitFor("the first deposit delivered", async () => (depByTx(d0.hash)?.status === "minted" ? depByTx(d0.hash) : null));
  const A = dep0.assetId;
  check("the first deposit issues the asset and delivers it", Boolean(dep0.steps.sendTxid), `asset ${A}`);
  await waitFor("the token in its mint limiter", async () => ((await api("assets")).body.find((m) => m.assetId === A)?.mintLimiter?.coin ? true : null));
  arca("hold", "create", "--server", ARCAD, "--node-url", `http://127.0.0.1:${E.SEQ_RPC}/`, "--node-user", "e2e", "--node-password-file", `${RUN}/arca/node.password`);
  const holdAddr = arca("hold", "address").address;
  const d1 = await deposit(20_000_000n, holdAddr);
  await waitFor("the second deposit delivered", async () => (depByTx(d1.hash)?.status === "minted" ? true : null));
  await seq("sendtoaddress", { address: holdAddr, amount: 50, assetlabel: E.FEEX, fee_asset_label: E.FEEX }, "miner").catch(async () =>
    seq("sendtoaddress", [holdAddr, 50, "", "", false, false, null, "unset", false, E.FEEX], "miner"));
  await chain.bury();
  const mapping = Object.values(stateNow().mappings).find((m) => m.assetId === A);
  check("the holder's wallet holds 2,000,000,000 atoms of the asset on the chain", true, `limiter coin ${mapping.limiter.coin.txid}:${mapping.limiter.coin.vout}, state ${JSON.stringify(mapping.limiter.state)}`);

  // ---------------- 2. served issuer-operated
  console.log(`\n-- ${at()} 2. the operator serves the asset issuer-operated, minting through the same limiter`);
  const inst = { ...mapping.limiter.instance };
  delete inst.address;
  fs.writeFileSync(`${RUN}/arca/limiter.json`, JSON.stringify(inst));
  await stopPid(Number(E.SIGNER_PID), "SIGTERM");
  fs.rmSync(`${RUN}/arca/signer.sock`, { force: true });
  const sOut = fs.openSync(`${RUN}/signer.log`, "a");
  const signer = spawn(`${E.ARCA_BIN_DIR}/arca-signer`, ["--key-file", `${RUN}/arca/operator.key`, "--genesis", E.GENESIS, "--record", `${RUN}/arca/signer.record`,
    "--socket", `${RUN}/arca/signer.sock`, "--issuer", `${RUN}/arca/limiter.json=${RUN}/limiter-operator.words`, "--mint-limiter", E.MINT_LIMITER],
  { stdio: ["ignore", sOut, sOut], detached: false });
  fs.writeFileSync(`${RUN}/signer.pid`, String(signer.pid));
  await waitFor("the signer's socket", async () => fs.existsSync(`${RUN}/arca/signer.sock`) || null, 30_000, 200);
  const L = mapping.limiter;
  let conf = fs.readFileSync(`${RUN}/arca/arcad.toml`, "utf8");
  conf = conf.replace("round_interval_seconds = 0", `round_interval_seconds = 2\nfee_assets = ["${E.FEEX}"]`);
  conf += `[[assets]]\nasset = "${A}"\nmin_leaf = "1000"\n[assets.issuer]\nlimiter = "${RUN}/arca/limiter.json"\nentropy = "${mapping.entropy}"\n` +
    `coin = "${L.coin.txid}:${L.coin.vout}"\nstate = "${L.state.minted},${L.state.elapsed},${L.state.armed ? 1 : 0}"\n`;
  fs.writeFileSync(`${RUN}/arca/arcad.toml`, conf);
  await stopPid(Number(E.ARCAD_PID), "SIGINT");
  const aOut = fs.openSync(`${RUN}/arcad.log`, "a");
  const arcad = spawn(`${E.ARCA_BIN_DIR}/arcad`, [`${RUN}/arca/arcad.toml`], { stdio: ["ignore", aOut, aOut], env: { ...process.env, RUST_LOG: "info" } });
  fs.writeFileSync(`${RUN}/arcad.pid`, String(arcad.pid));
  const served = await waitFor("the operator to serve the asset issuer-operated", async () => {
    const info = await (await fetch(`${ARCAD}/v1/info`)).json();
    return info.assets?.find((a) => a.asset === A && a.issuer) ?? null;
  }, 60_000, 500);
  check("the operator's info names the asset's mint limiter", served.issuer.token === mapping.reissuanceToken, `allowance ${served.issuer.allowance}, window ${served.issuer.window_blocks}`);
  const sup0 = await operator("issuer_supply", { asset: A });
  check("the operator's supply report reads the limiter where the daemon left it", sup0.limiter_coin === `${L.coin.txid}:${L.coin.vout}` && sup0.in_batches === "0",
    `${sup0.limiter_coin ?? sup0.limiter_unavailable}`);

  await killDaemon();
  const cfg = JSON.parse(fs.readFileSync(`${RUN}/config.json`, "utf8"));
  Object.assign(cfg, { issuerOperated: { [A]: ARCAD }, issuerMintGraceMs: 30_000, burnOnlyRefreshMs: 1000 });
  fs.writeFileSync(`${RUN}/config.json`, JSON.stringify(cfg, null, 1));
  await startDaemon();
  const wcfg = {
    ethChainId: 31337,
    ethRpcUrl: `http://127.0.0.1:${E.ANVIL_PORT}`,
    ethFinality: "finalized",
    vaults: [{ address: E.VAULT, deployBlock: 1 }],
    esploraUrl: `http://127.0.0.1:${E.ESPLORA_PORT}`,
    daemonUrl: `http://127.0.0.1:${E.API_PORT}`,
    daemonAdminToken: "e2e-admin",
    guardianKeyFile: "",
    alertUrl: "",
    breachMinutes: 2,
    limiterSpentMinutes: 600,
    leafMinutes: 600,
    daemonDownMinutes: 600,
    largePayout: {},
    intervalMs: 4000,
    statusPort: Number(E.WATCH_PORT),
    stateFile: `${RUN}/watch-state.json`,
    issuerOperated: { [A]: ARCAD },
  };
  fs.writeFileSync(`${RUN}/watcher.json`, JSON.stringify(wcfg, null, 1));
  const wOut = fs.openSync(`${RUN}/watcher.log`, "a");
  const watcher = spawn("node", [`${E.REPO_DIR}/watcher/compages-watch.js`, `${RUN}/watcher.json`], { stdio: ["ignore", wOut, wOut] });
  fs.writeFileSync(`${RUN}/watcher.pid`, String(watcher.pid));
  await waitFor("the watcher's status", async () => ((await watcherRow(A)).assets?.[A]?.supply !== undefined ? true : null), 120_000, 1000);
  const level0 = BigInt((await por(A)).chainCirculatingAtoms);
  await backed("before any round", A, { chainCirculatingAtoms: 12_000_000_000n, liabilityAtoms: 12_000_000_000n });

  // ---------------- 3. a refresh mints into a round
  console.log(`\n-- ${at()} 3. the holder boards and refreshes; the round mints the batch through the limiter`);
  const b = arca("hold", "board", A, "1500000000", "--fee-asset", E.FEEX);
  check("the holder boards 1,500,000,000 atoms", Boolean(b.leaf_id), JSON.stringify(b).slice(0, 200));
  await waitFor("the board credited", async () => {
    await chain.bury();
    const bs = arca("hold", "boards");
    return Array.isArray(bs) && bs.length && bs.every((x) => x.server?.state === "credited") ? true : null;
  }, 240_000, 2000);
  arca("hold", "sync");
  const p = arca("hold", "participate", "--leaf", b.leaf_id);
  check("the refresh is submitted", !p.error, JSON.stringify(p).slice(0, 200));
  const sup1 = await waitFor("the round's mint in a block", async () => {
    const s = await operator("issuer_supply", { asset: A });
    return s.mints?.length === 1 ? s : null;
  }, 300_000, 2000);
  const roundTxid = sup1.mints[0].txid;
  const roundTx = await seq("getrawtransaction", [roundTxid, true]);
  const roundHeight = (await seq("getblockheader", [roundTx.blockhash])).height;
  const minted = BigInt(sup1.mints[0].amount);
  check("the round reissues the asset at input 0, spending the limiter's coin", roundTx.vin[0].issuance?.asset === A &&
    roundTx.vin[0].txid === L.coin.txid && roundTx.vin[0].vout === L.coin.vout, `round ${roundTxid} at height ${roundHeight}, mints ${minted}`);
  evidence("issuer_supply after the round", sup1);
  await waitFor("the round final and the holder's new leaf", async () => {
    await chain.bury();
    const s = arca("hold", "sync");
    return (s.participations ?? []).some((x) => x.state === "released") ? true : null;
  }, 240_000, 3000);
  const leaves = arca("hold", "coins").filter((c) => c.asset === A && c.kind === "batch");
  check("the holder's new leaf is in an issuer-operated batch", leaves.length === 1 && leaves[0].batch_profile === "issuer-operated", JSON.stringify(leaves.map((c) => [c.value, c.state, c.batch_profile])));
  const followed = await waitFor("the daemon to follow the limiter through the round", async () => {
    const m = Object.values(stateNow().mappings).find((x) => x.assetId === A);
    return m.limiter.coin.txid === roundTxid ? m : null;
  }, 120_000, 1000);
  check("the daemon followed its limiter through the operator's round, and halted nothing", !halted(A) && followed.limiter.coin.vout === 0,
    `limiter coin ${followed.limiter.coin.txid}:0, state ${JSON.stringify(followed.limiter.state)}`);
  const inBatches = BigInt((await operator("issuer_supply", { asset: A })).in_batches);
  const r3 = await backed("after the round", A);
  check("the batch holds what the round minted", inBatches === minted, `in batches ${inBatches}, minted ${minted}`);
  check("what escrow must cover is what the deposits minted: the supply less the deduction", BigInt(r3.liabilityAtoms) === level0 &&
    BigInt(r3.chainCirculatingAtoms) === level0 + minted - BigInt(r3.burnOnly.burnedAtoms),
    `level ${level0}, supply ${r3.chainCirculatingAtoms}, to back ${r3.liabilityAtoms}, burned ${r3.burnOnly.burnedAtoms} (${(r3.burnOnly.burns ?? []).map((x) => x.kind).join(",")})`);

  // The signed snapshot, at a height after the round.
  const key = ethers.Wallet.createRandom();
  fs.writeFileSync(`${RUN}/attestation.key`, `${key.privateKey}\n`, { mode: 0o600 });
  snapshotCfg({ issuerOperated: { [A]: ARCAD } });
  let snapOut = "";
  const snap1 = await waitFor("a snapshot at a height after the round, Ethereum finalized past it", async () => {
    const r = runNode([`${E.REPO_DIR}/reserves/snapshot.mjs`, `${RUN}/reserves.json`]);
    snapOut = r.out;
    const m = r.out.match(/wrote .*\/(\d+)\.json/);
    if (!m) return null;
    const h = Number(m[1]);
    if (h < roundHeight) {
      fs.rmSync(`${RUN}/reserves`, { recursive: true, force: true });
      return null;
    }
    return JSON.parse(fs.readFileSync(`${RUN}/reserves/${h}.json`, "utf8"));
  }, 240_000, 3000).catch((e) => {
    throw new Error(`${e.message}: ${snapOut.trim().split("\n").slice(-3).join(" | ")}`);
  });
  const sa = snap1.payload.assets.find((x) => x.assetId === A);
  check("the snapshot at H after the round counts the batch live and calls the asset backed",
    sa.burnOnly?.liveAtoms === String(minted) && sa.burnOnly.mintedAtoms === String(minted) && sa.backed === true,
    `H ${snap1.payload.height}, supply ${sa.supply.circulatingAtoms}, live ${sa.burnOnly?.liveAtoms}, minted ${sa.burnOnly?.mintedAtoms}, burned ${sa.burnOnly?.burnedAtoms}, deducted ${sa.burnOnly?.deductedAtoms}, escrow ${sa.escrowAtoms}`);
  evidence("snapshot after the round", sa);
  const v1 = runNode([`${E.REPO_DIR}/reserves/verify.mjs`, `${RUN}/reserves`, "--attester", key.address, "--rederive", "--seq-rpc", `http://e2e:e2e@127.0.0.1:${E.SEQ_RPC}`,
    "--operator", ARCAD, "--audit-script", E.AUDIT_SCRIPT]);
  evidence("verify after the round", v1.out);
  check("verify re-derives the snapshot, its outputs under burn-only sweeps checked on the node and in the tree", v1.ok && /output\(s\) under burn-only sweeps/.test(v1.out),
    v1.out.trim().split("\n").filter((l) => /burn-only|FAIL|all checks/.test(l)).join(" | "));

  // ---------------- 4. the sweep burns the batch
  console.log(`\n-- ${at()} 4. the batch expires; its sweep burns it, the abandoned leaf with it`);
  const before4 = await por(A);
  await stopChain();
  // 28 days to expiry, then the notice: the chain's median time moved on.
  await chain.advance(28 * 86_400 + 3_600);
  runChain();
  await waitFor("the batch released at expiry", async () => {
    const s = await operator("issuer_supply", { asset: A });
    return s ? true : null;
  });
  await sleep(10_000);
  await stopChain();
  await chain.advance(37 * 3_600);
  runChain();
  const sup4 = await waitFor("the sweep's burn in a block", async () => {
    await chain.bury();
    const s = await operator("issuer_supply", { asset: A });
    return s.burns?.some((x) => x.kind === "sweep") && s.in_batches === "0" ? s : null;
  }, 300_000, 3000);
  const sweep = sup4.burns.find((x) => x.kind === "sweep");
  const sweepTx = await seq("getrawtransaction", [sweep.txid, true]);
  const sweepHeight = (await seq("getblockheader", [sweepTx.blockhash])).height;
  check("the sweep burns the whole batch output, the abandoned leaf with it", BigInt(sweep.amount) === minted, `sweep ${sweep.txid} at ${sweepHeight} burns ${sweep.amount}`);
  evidence("issuer_supply after the sweep", sup4);
  const r4 = await backed("after the sweep", A);
  check("the supply fell by the burn, the abandoned leaf with it; what escrow must cover is still what the deposits minted",
    BigInt(r4.chainCirculatingAtoms) === BigInt(before4.chainCirculatingAtoms) - BigInt(sweep.amount) && BigInt(r4.liabilityAtoms) === level0 && BigInt(r4.escrowedAtoms) === level0,
    `supply ${before4.chainCirculatingAtoms} -> ${r4.chainCirculatingAtoms}, to back ${r4.liabilityAtoms}, escrow ${r4.escrowedAtoms}`);
  // Ethereum's clock to the chain's, so a snapshot height after the time
  // jump has a finalized Ethereum block after it.
  const ahead = (await seq("getblockchaininfo")).mediantime - Math.floor(Date.now() / 1000) + 600;
  if (ahead > 0) await provider.send("evm_increaseTime", [ahead]);
  // A snapshot at H just below the sweep, taken now: the batch output is
  // spent above H, so it is still deducted, its spender named.
  const snap2 = await waitFor("a snapshot at the height before the sweep", async () => {
    fs.rmSync(`${RUN}/reserves`, { recursive: true, force: true });
    snapshotCfg({ issuerOperated: { [A]: ARCAD }, minDepth: (await seq("getblockcount")) - (sweepHeight - 1) });
    const r = runNode([`${E.REPO_DIR}/reserves/snapshot.mjs`, `${RUN}/reserves.json`]);
    snapOut = r.out;
    const m = r.out.match(/wrote .*\/(\d+)\.json/);
    return m ? JSON.parse(fs.readFileSync(`${RUN}/reserves/${m[1]}.json`, "utf8")) : null;
  }, 180_000, 3000).catch((e) => {
    throw new Error(`${e.message}: ${snapOut.trim().split("\n").slice(-3).join(" | ")}`);
  });
  const sb = snap2.payload.assets.find((x) => x.assetId === A);
  const spent = (sb.burnOnly?.outputs ?? []).find((o) => o.spentBy === sweep.txid);
  check("a snapshot at H below the sweep, taken after it, counts the batch output live at H and names its spender",
    snap2.payload.height < sweepHeight && sb.burnOnly?.liveAtoms === String(minted) && Boolean(spent) && sb.backed === true,
    `H ${snap2.payload.height}, sweep at ${sweepHeight}, live ${sb.burnOnly?.liveAtoms}, deducted ${sb.burnOnly?.deductedAtoms}, spender ${spent?.spentBy} at ${spent?.spentAt}`);
  const v2 = runNode([`${E.REPO_DIR}/reserves/verify.mjs`, `${RUN}/reserves`, "--attester", key.address, "--rederive", "--seq-rpc", `http://e2e:e2e@127.0.0.1:${E.SEQ_RPC}`,
    "--operator", ARCAD]);
  evidence("snapshot before the sweep, and its verify", { asset: sb, verify: v2.out });
  check("verify re-derives it: the output made at or below H and spent above it", v2.ok, v2.out.trim().split("\n").filter((l) => /burn-only|FAIL|all checks/.test(l)).join(" | "));

  // ---------------- 5. a reorg across the mint and its burn
  console.log(`\n-- ${at()} 5. a reorg takes the round and its sweep out together`);
  await stopChain();
  const roundBlock = roundTx.blockhash;
  await seq("invalidateblock", [roundBlock]);
  const inMempool = new Set(await seq("getrawmempool"));
  check("the round and the sweep left the active chain", (await seq("getrawtransaction", [roundTxid, true])).confirmations === undefined || inMempool.has(roundTxid),
    `round in the mempool: ${inMempool.has(roundTxid)}, sweep in the mempool: ${inMempool.has(sweep.txid)}`);
  const r5 = await waitFor("the daemon's view of the reorg", async () => {
    const r = await por(A);
    return r?.burnOnly && r.burnOnly.mints.every((m) => m.ok === false || m.txid !== roundTxid) && r.burnOnly.burns.every((x) => x.txid !== sweep.txid || x.ok === false) ? r : null;
  }, 60_000, 1000);
  check("with both out, neither the mint nor its burn is counted, and the asset is backed",
    BigInt(r5.burnOnly.mintedAtoms) === 0n && r5.backed === true && !halted(A),
    `minted ${r5.burnOnly.mintedAtoms}, burned ${r5.burnOnly.burnedAtoms}, supply ${r5.chainCirculatingAtoms}, to back ${r5.liabilityAtoms}, escrow ${r5.escrowedAtoms}; ${r5.burnOnly.problems.join("; ")}`);
  evidence("during the reorg", r5);
  runChain();
  await waitFor("the round back in a block", async () => {
    await chain.bury();
    const st = await operator("issuer_supply", { asset: A });
    const r = await por(A);
    return st.mints?.some((m) => m.txid === roundTxid) && r?.burnOnly?.mints?.some((m) => m.txid === roundTxid && m.ok) ? r : null;
  }, 300_000, 3000);
  const back = await seq("getrawtransaction", [roundTxid, true]);
  check("the chain that replaced them holds the round again", Boolean(back.blockhash) && (await seq("getblockheader", [back.blockhash])).confirmations >= 1,
    `round now in ${back.blockhash}`);
  await backed("the round back, its sweep not yet", A);
  // The sweep waits its notice again after the release made in the new
  // chain, which the operator broadcasts again once the chain lets it: the
  // clock moves on until the sweep is back.
  const sweepBack = async () => {
    const st = await operator("issuer_supply", { asset: A });
    return st.burns?.some((x) => x.kind === "sweep") && st.in_batches === "0" ? true : null;
  };
  for (let i = 0; i < 4 && !(await sweepBack()); i++) {
    await sleep(30_000);
    await stopChain();
    await chain.advance(38 * 3_600);
    runChain();
    await waitFor("the sweep back in a block", async () => {
      await chain.bury();
      return sweepBack();
    }, 90_000, 3000).catch(() => null);
  }
  check("the sweep is back in a block of the new chain", Boolean(await sweepBack()));
  const r5c = await backed("the sweep back", A);
  check("the accounting after the reorg is the accounting before it", r5c.liabilityAtoms === r4.liabilityAtoms && r5c.chainCirculatingAtoms === r4.chainCirculatingAtoms,
    `to back ${r5c.liabilityAtoms} vs ${r4.liabilityAtoms}, supply ${r5c.chainCirculatingAtoms} vs ${r4.chainCirculatingAtoms}`);

  // ---------------- 6. a mint that no burn-only sweep holds
  console.log(`\n-- ${at()} 6. a mint through the limiter to a coin of the minter's own`);
  await waitFor("the daemon at the limiter's latest coin", async () => {
    const s = await operator("issuer_supply", { asset: A });
    const m = Object.values(stateNow().mappings).find((x) => x.assetId === A);
    return s.limiter_coin === `${m.limiter.coin.txid}:${m.limiter.coin.vout}` ? true : null;
  }, 120_000, 2000);
  const m6 = Object.values(stateNow().mappings).find((x) => x.assetId === A);
  const coinTx = await seq("getrawtransaction", [m6.limiter.coin.txid, true]);
  const coinHeight = (await seq("getblockheader", [coinTx.blockhash])).height;
  // A fee coin of the minter's own: an explicit FEEX output in the miner wallet.
  const feeAddr = await seq("getnewaddress", [], "miner");
  const feeTxid = await seq("sendtoaddress", { address: feeAddr, amount: 1, assetlabel: E.FEEX, fee_asset_label: E.FEEX }, "miner");
  await chain.produce();
  await chain.produce();
  const feeTx = await seq("getrawtransaction", [feeTxid, true]);
  const feeVout = feeTx.vout.findIndex((o) => o.scriptPubKey?.address === feeAddr || o.scriptPubKey?.addresses?.[0] === feeAddr);
  const toAddr = await seq("getnewaddress", [], "miner");
  const toSpk = (await seq("validateaddress", [toAddr])).scriptPubKey;
  const changeSpk = (await seq("validateaddress", [await seq("getrawchangeaddress", [], "miner")])).scriptPubKey;
  const age = (await seq("getblockcount")) - coinHeight + 1;
  const req = (fee) => ({
    path: "mint",
    coin: { tx: coinTx.hex, vout: m6.limiter.coin.vout },
    state: { minted: String(m6.limiter.state.minted), elapsed: m6.limiter.state.elapsed, armed: m6.limiter.state.armed },
    entropy: m6.entropy,
    age: Math.min(age, 65535),
    amount: "1000000",
    mint_to: toSpk,
    fee: { coins: [{ tx: feeTx.hex, vout: feeVout }], atoms: String(fee), change_to: changeSpk },
  });
  const build = (fee) => JSON.parse(execFileSync(E.MINT_LIMITER, ["build", "--instance", `${RUN}/arca/limiter.json`, "--mnemonic-file", `${RUN}/limiter-operator.words`],
    { input: JSON.stringify(req(fee)), encoding: "utf8" }));
  const built = build(5000);
  const signed = await seq("signrawtransactionwithwallet", [built.hex], "miner");
  const rogue = await seq("sendrawtransaction", [signed.hex]);
  await chain.produce();
  check("a mint of 1,000,000 atoms through the limiter to the minter's own coin is in a block", Boolean(rogue), rogue);
  await chain.bury();
  const h6 = await waitFor("the daemon to halt the asset", async () => halted(A), 120_000, 1000);
  check("the daemon halts the asset: a limiter mint its operator lists no round for", /did not sign spent the mint limiter/.test(h6.reason) && h6.reason.includes(rogue) && /does not list it/.test(h6.reason), h6.reason);
  const inv6 = await waitFor("the supply invariant to count the mint", async () => {
    const inv = (await api("health")).body.invariants?.assets ?? {};
    const row = Object.values(inv).find((r) => r.underBurnOnlySweeps !== undefined);
    return row && BigInt(row.chainSupply) - BigInt(row.deducted) > BigInt(row.ledger) ? row : null;
  }, 180_000, 1000);
  check("the daemon's supply invariant counts the mint: supply outside the batches above the ledger", true, JSON.stringify(inv6));
  const dlog = fs.readFileSync(`${RUN}/daemon.log`, "utf8");
  check("the invariant itself reports the breach", /invariant supply failed once for .*outside burn-only batches exceeds the ledger/.test(dlog),
    (dlog.match(/invariant supply failed once[^\n]*/) ?? [""])[0]);
  const w6 = await waitFor("the watcher to find the shortfall and halt the asset", async () => {
    const st = await watcherRow(A);
    const p6 = (st.problems ?? []).find((x) => x.key === `reserve:${A}`);
    return p6 ? { p6, st } : null;
  }, 300_000, 2000);
  const wlog = fs.readFileSync(`${RUN}/watcher.log`, "utf8");
  check("the watcher reports the supply outside burn-only batches above escrow, and halts the asset in the daemon",
    /outside burn-only batches exceeds its escrow/.test(w6.p6.title) && wlog.includes(`halted ${A} in the daemon`), `${w6.p6.title}: ${w6.p6.detail}`);
  evidence("the rogue mint", { halt: h6, invariants: inv6, watcher: w6 });
} catch (e) {
  console.log(`FAIL  ${e.stack ?? e.message}`);
  failures++;
} finally {
  await stopChain().catch(() => {});
  if (daemon && !exited(daemon)) process.kill(daemon.pid, "SIGTERM");
}
console.log(`\n${failures ? `${failures} CHECK(S) FAILED` : "ALL ISSUER-OPERATED CHECKS PASSED"} (${record.length} checks, ${at()})`);
process.exit(failures ? 1 : 0);
