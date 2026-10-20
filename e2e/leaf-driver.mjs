// Compages e2e checks of a deposit that arrives as an Arca leaf, against the
// stack run-leaf-e2e.sh brings up. Exits non-zero when any check fails.
//
//  1. the first deposit of a token goes on the chain (the on-chain path), and
//     its asset is then served by the operator;
//  2. receive requests the bridge cannot pay are refused before any deposit:
//     another operator, another chain, an amount named, a token not bridged;
//  3. a deposit for a fresh wallet's receive request arrives as a leaf of the
//     bridged asset in that wallet, with the daemon killed between the mint
//     and the payment (once before the board, once while it is in flight) and
//     restarted, the reserves reconciling before, during and after;
//  4. the daemon killed right after the wallet paid and before it recorded
//     the payment: the restarted daemon finds the payment, pays nothing twice;
//  5. a second deposit to a used request takes its fallback (a refund);
//  6. a request that has lapsed when its deposit lands takes its fallback (an
//     on-chain delivery to the address the intent named).

import { ethers } from "ethers";
import fs from "node:fs";
import { spawn, execFileSync } from "node:child_process";
import { Chain } from "./leaf-chain.mjs";

const E = process.env;
const RUN = E.RUN_DIR;
const API = `http://127.0.0.1:${E.API_PORT}/api`;
const chain = new Chain(E.SEQ_RPC_URL, E.PARENT_RPC_URL);
const provider = new ethers.JsonRpcProvider(`http://127.0.0.1:${E.ANVIL_PORT}`, 31337, { staticNetwork: true, cacheTimeout: -1 });
const user = new ethers.Wallet(E.USER_KEY, provider);
const vault = new ethers.Contract(E.VAULT, ["function depositToken(address token, uint256 amount, string sequentiaAddress)"], user);
const musd = new ethers.Contract(E.MUSD, ["function approve(address,uint256) returns (bool)", "function balanceOf(address) view returns (uint256)"], user);

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

async function api(path, opts) {
  const res = await fetch(`${API}/${path}`, opts);
  const j = await res.json().catch(() => ({}));
  return { status: res.status, body: j };
}
const post = (path, body) =>
  api(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

function arca(w, ...args) {
  try {
    return JSON.parse(execFileSync(E.ARCA, ["--datadir", `${RUN}/arca/${w}`, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }));
  } catch (e) {
    try {
      return JSON.parse(e.stdout);
    } catch {
      return { error: { message: String(e.stdout || e.message) } };
    }
  }
}

async function waitFor(desc, fn, timeoutMs = 180_000, everyMs = 1000) {
  const start = Date.now();
  for (;;) {
    const v = await fn().catch(() => null);
    if (v) return v;
    if (Date.now() - start > timeoutMs) throw new Error(`timeout waiting for ${desc}`);
    await sleep(everyMs);
  }
}

// ---- the daemon, which the checks stop and start again
let daemon = null;
function startDaemon() {
  const out = fs.openSync(`${RUN}/daemon.log`, "a");
  daemon = spawn("node", [E.DAEMON_JS, `${RUN}/config.json`], { cwd: RUN, stdio: ["ignore", out, out] });
  fs.writeFileSync(`${RUN}/daemon.pid`, String(daemon.pid));
  return waitFor("the daemon's API", async () => (await api("status")).status === 200, 60_000, 500);
}
const exited = (p) => p.exitCode !== null || p.signalCode !== null;
async function killDaemon() {
  const p = daemon;
  try {
    process.kill(p.pid, "SIGKILL");
  } catch {}
  await waitFor("the daemon to exit", async () => exited(p) || null, 10_000, 100);
}
const stateNow = () => JSON.parse(fs.readFileSync(`${RUN}/state.json`, "utf8"));
const depByTx = (hash) => Object.values(stateNow().deposits).find((d) => d.ethTxHash?.toLowerCase() === hash.toLowerCase());

async function porOf(assetId) {
  const r = await api(`por?asset=${assetId}`);
  return r.body.assets?.[0];
}
async function reconciles(label, assetId, expect = {}) {
  const row = await porOf(assetId);
  const r = row?.reconciliation ?? {};
  const detail =
    `escrow ${row?.escrowedAtoms}, supply ${row?.chainCirculatingAtoms}, bridge holds ${r.bridgeHeldAtoms} ` +
    `(node ${r.nodeWalletAtoms}, leaf wallet ${r.leafWalletAtoms}), users ${r.usersHoldAtoms}, owed ${r.owedAtoms}, ` +
    `returned ${r.returnedAtoms}, boards in flight ${r.leaves?.boardsInFlightAtoms}, leaves paid ${r.leaves?.paidAtoms} ` +
    `(+${r.leaves?.marginsAtoms} margins, ${r.leaves?.paidCount} paid)${r.error ? `, error ${r.error}` : ""}`;
  check(`reserves reconcile ${label}`, r.reconciles === true && row.backed === true, detail);
  for (const [k, v] of Object.entries(expect)) {
    const got = k in r ? r[k] : r.leaves?.[k];
    check(`  ${label}: ${k} = ${v}`, String(got) === String(v), `got ${got}`);
  }
  fs.appendFileSync(`${RUN}/por.log`, `${at()} ${label}\n${JSON.stringify(row, null, 1)}\n`);
  return row;
}

async function deposit(units, seqAddress) {
  await (await musd.approve(E.VAULT, units)).wait();
  return (await vault.depositToken(E.MUSD, units, seqAddress)).wait();
}

/** A receive request's text with fields of its JSON changed. */
function editRequest(text, changes) {
  const i = text.indexOf(":");
  const v = JSON.parse(Buffer.from(text.slice(i + 1), "hex").toString());
  Object.assign(v, changes);
  return text.slice(0, i + 1) + Buffer.from(JSON.stringify(v)).toString("hex");
}

const stopChain = chain.run(1000, 2);
try {
  await startDaemon();
  const userAddr = await seq("getnewaddress", [], "user");

  // ---------------- 1. the on-chain path, and the asset served
  console.log(`\n-- ${at()} 1. first deposit of MUSD, on the chain`);
  const d0 = await deposit(100_000_000n, userAddr);
  const dep0 = await waitFor("the first deposit delivered", async () => {
    const d = depByTx(d0.hash);
    return d?.status === "minted" ? d : null;
  });
  const A = dep0.assetId;
  const got0 = Math.round(Number((await seq("getreceivedbyaddress", [userAddr, 0], "user"))?.[A] ?? 0) * 1e8);
  check("the first deposit is delivered on the chain", Boolean(dep0.steps.sendTxid) && got0 === 10_000_000_000, `asset ${A}, received ${got0}`);
  await waitFor("the token in its mint limiter", async () => {
    const r = await api("assets");
    return r.body.find((m) => m.assetId === A)?.mintLimiter?.coin ? true : null;
  });
  check("the asset's token is in its mint limiter", true);
  // The operator serves the new asset: its entry in the configuration, and
  // SIGHUP, as an operator adds an asset.
  const conf = fs.readFileSync(`${RUN}/arca/arcad.toml`, "utf8");
  fs.writeFileSync(`${RUN}/arca/arcad.toml`, conf + `[[assets]]\nasset = "${A}"\nmin_leaf = "1000"\n`);
  process.kill(Number(E.ARCAD_PID), "SIGHUP");
  await waitFor("the operator to serve the asset", async () => (arca("leaf", "info").server_info?.assets ?? []).some((a) => a.asset === A) || null, 30_000);
  check("the operator serves the bridged asset after its reload", true);
  await reconciles("before any leaf deposit", A, { owedAtoms: 0, leafWalletAtoms: 0 });

  // ---------------- 2. refused before any deposit
  console.log(`\n-- ${at()} 2. receive requests the bridge cannot pay`);
  const intentsBefore = Object.keys(stateNow().leafIntents ?? {}).length;
  const good = arca("alice", "receive", "--asset", A).request;
  let r = await post("leaf/intent", { request: editRequest(good, { operator: "11".repeat(32) }), token: E.MUSD });
  check("a request for another operator is refused", r.status === 400 && /operator/.test(r.body.error), `${r.status} ${r.body.error}`);
  r = await post("leaf/intent", { request: editRequest(good, { genesis_hash: "22".repeat(32) }), token: E.MUSD });
  check("a request for another chain is refused", r.status === 400 && /chain of genesis/.test(r.body.error), `${r.status} ${r.body.error}`);
  r = await post("leaf/intent", { request: arca("alice", "receive", "--asset", A, "--amount", "5000").request, token: E.MUSD });
  check("a request naming an amount is refused", r.status === 400 && /amount/.test(r.body.error), `${r.status} ${r.body.error}`);
  r = await post("leaf/intent", { request: arca("alice", "receive").request, token: "0x000000000000000000000000000000000000dEaD" });
  check("a request for a token not bridged is refused", r.status === 400 && /not bridged/.test(r.body.error), `${r.status} ${r.body.error}`);
  r = await post("leaf/intent", { request: arca("alice", "receive", "--asset", E.FEEX).request, token: E.MUSD });
  check("a request for another asset is refused", r.status === 400 && /asks for asset/.test(r.body.error), `${r.status} ${r.body.error}`);
  check("no intent was recorded for any of them", Object.keys(stateNow().leafIntents ?? {}).length === intentsBefore);

  // ---------------- 3. a deposit arrives as a leaf, through two crashes
  console.log(`\n-- ${at()} 3. a deposit for alice's receive request, the daemon killed between the mint and the payment`);
  const it1 = (await post("leaf/intent", { request: good, token: E.MUSD })).body;
  check("the intent binds the request to a fresh address", Boolean(it1.seqAddress) && it1.assetId === A && it1.fallback?.kind === "refund", `${it1.seqAddress}`);
  const again = (await post("leaf/intent", { request: good, token: E.MUSD })).body;
  check("asking again answers the same address", again.seqAddress === it1.seqAddress);
  const tDeposit = Date.now();
  const d1 = await deposit(25_000_000n, it1.seqAddress);
  const SATS1 = 2_500_000_000n;
  await waitFor("the mint into the leaf wallet", async () => (depByTx(d1.hash)?.status === "leaf_minted" ? true : null), 120_000, 100);
  const tMinted = Date.now();
  await reconciles("after the mint, before the board", A, { owedAtoms: SATS1 });
  await killDaemon();
  check("killed with the deposit minted and not boarded", depByTx(d1.hash).status === "leaf_minted", depByTx(d1.hash).status);
  await startDaemon();
  await reconciles("after the restart, before the board", A, { owedAtoms: SATS1 });
  await waitFor("the board", async () => (depByTx(d1.hash)?.status === "leaf_boarding" ? true : null), 120_000, 100);
  await killDaemon();
  check("killed with the board in flight", depByTx(d1.hash).status === "leaf_boarding", depByTx(d1.hash).status);
  await startDaemon();
  await reconciles("after the restart, the board in flight", A, { owedAtoms: SATS1, leafWalletAtoms: SATS1 });
  const paid1 = await waitFor("the payment", async () => {
    const d = depByTx(d1.hash);
    return d?.status === "minted" && d.leaf?.paid ? d : null;
  });
  const tPaid = Date.now();
  check("the deposit was paid as a leaf", BigInt(paid1.leaf.paid.value) + BigInt(paid1.leaf.paid.margins) === SATS1,
    `leaf ${paid1.leaf.paid.value} + margins ${paid1.leaf.paid.margins} = ${SATS1}`);
  check("the board was made once", Object.values(stateNow().deposits).filter((d) => d.steps?.leafBoard?.leafId === paid1.steps.leafBoard.leafId).length === 1);
  const mail = arca("alice", "sync");
  const alice = arca("alice", "coins").filter((c) => c.asset === A);
  check("alice holds one coin of the bridged asset, of the leaf's value",
    alice.length === 1 && alice[0].value === paid1.leaf.paid.value && alice[0].state === "live",
    JSON.stringify(alice.map((c) => [c.value, c.state, c.standing])) + `; mailbox accepted ${mail.mailbox?.accepted?.length}`);
  await reconciles("after the payment", A, { owedAtoms: 0, leafWalletAtoms: 0, paidAtoms: paid1.leaf.paid.value });
  const lat = {
    deposit_to_mint_s: (tMinted - tDeposit) / 1000,
    mint_to_board_s: (Date.parse(paid1.leaf.boardedAt) - Date.parse(paid1.leaf.mintedAt)) / 1000,
    board_to_live_s: (Date.parse(paid1.leaf.liveAt) - Date.parse(paid1.leaf.boardedAt)) / 1000,
    live_to_paid_s: (Date.parse(paid1.leaf.paid.at) - Date.parse(paid1.leaf.liveAt)) / 1000,
    deposit_to_paid_s_with_two_restarts: (tPaid - tDeposit) / 1000,
  };
  console.log(`   latency: ${JSON.stringify(lat)}`);

  // ---------------- 4. killed after the payment, before its record
  console.log(`\n-- ${at()} 4. the daemon killed right after the wallet paid, before it recorded the payment`);
  const req2 = arca("alice", "receive", "--asset", A).request;
  const it2 = (await post("leaf/intent", { request: req2, token: E.MUSD })).body;
  fs.writeFileSync(`${RUN}/kill-after-send`, "");
  const tDeposit2 = Date.now();
  const d2 = await deposit(12_345_678n, it2.seqAddress);
  const SATS2 = 1_234_567_800n;
  const p2 = daemon;
  await waitFor("the daemon killed by the payment", async () => exited(p2) || null, 240_000, 200);
  const mid = depByTx(d2.hash);
  check("the record shows the payment asked for and not recorded", mid.status === "leaf_paying" && Boolean(mid.steps.pendingLeafPay) && !mid.steps.leafPay, mid.status);
  await startDaemon();
  const paid2 = await waitFor("the payment found", async () => {
    const d = depByTx(d2.hash);
    return d?.status === "minted" ? d : null;
  });
  console.log(`   latency of an undisturbed leaf deposit up to its payment: ${(Date.parse(mid.steps.pendingLeafPay.at) - tDeposit2) / 1000} s`);
  check("the restarted daemon found the payment the wallet made", Boolean(paid2.steps.leafPay?.transferId) && paid2.steps.leafPay.recovered === true &&
    BigInt(paid2.leaf.paid.value) + BigInt(paid2.leaf.paid.margins) === SATS2, `transfer ${paid2.steps.leafPay?.transferId}`);
  arca("alice", "sync");
  const alice2 = arca("alice", "coins").filter((c) => c.asset === A);
  check("alice holds exactly one coin for the second request", alice2.length === 2 && alice2.filter((c) => c.value === paid2.leaf.paid.value).length === 1,
    JSON.stringify(alice2.map((c) => [c.value, c.state])));
  await reconciles("after the recovered payment", A, { owedAtoms: 0, leafWalletAtoms: 0 });

  // ---------------- 5. a used request takes its fallback
  console.log(`\n-- ${at()} 5. a second deposit to a request already paid`);
  const before5 = await musd.balanceOf(user.address);
  const d3 = await deposit(7_000_000n, it1.seqAddress);
  const refunded = await waitFor("the refund", async () => {
    const d = depByTx(d3.hash);
    return d?.status === "refunded" ? d : null;
  });
  check("it is refunded on Ethereum, with the reason", /already used/.test(refunded.refundReason ?? ""), refunded.refundReason);
  check("the depositor has the tokens back", (await musd.balanceOf(user.address)) === before5, `${before5} -> ${await musd.balanceOf(user.address)}`);
  await reconciles("after the refund", A, { owedAtoms: 0 });

  // ---------------- the signed snapshot's dry run counts the leaves
  if (E.AUDIT_SCRIPT) {
    console.log(`\n-- ${at()} the reserve snapshot (dry run) on this chain`);
    const rcfg = {
      snapshotDir: `${RUN}/reserves`,
      intervalBlocks: 10,
      minDepth: 2,
      seqRpcUrl: `http://e2e:e2e@127.0.0.1:${E.SEQ_RPC}`,
      auditScript: E.AUDIT_SCRIPT,
      python: "python3",
      daemonUrl: `http://127.0.0.1:${E.API_PORT}`,
      ethChainId: 31337,
      ethChainName: "anvil",
      ethRpcUrl: `http://127.0.0.1:${E.ANVIL_PORT}`,
      vaults: [{ address: E.VAULT, version: 3 }],
    };
    fs.writeFileSync(`${RUN}/reserves.json`, JSON.stringify(rcfg));
    const { checkFigures } = await import("../reserves/lib/consistency.mjs");
    let last = "";
    const snap = await waitFor("a snapshot height Ethereum has finalized past", async () => {
      let out;
      try {
        out = execFileSync("node", [`${E.REPO_DIR}/reserves/snapshot.mjs`, `${RUN}/reserves.json`, "--dry-run"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
      } catch (e) {
        out = `${e.stdout}${e.stderr}`;
      }
      last = out;
      return out.trim().startsWith("{") ? JSON.parse(out) : null;
    }, 120_000, 3000).catch((e) => {
      throw new Error(`${e.message}: ${last.trim().split("\n").slice(-3).join(" | ")}`);
    });
    fs.writeFileSync(`${RUN}/snapshot-dry-run.json`, JSON.stringify(snap, null, 1));
    const a = snap.assets.find((x) => x.assetId === A);
    check("the snapshot records the leaf route beside the asset", a?.leaves && a.leaves.paidCount === 2 && a.leaves.owedAtoms === "0" && a.leaves.boardsInFlight.length === 0,
      JSON.stringify(a?.leaves));
    check("the snapshot's figures add up and the asset is backed", checkFigures(snap).length === 0 && a.backed === true, `height ${snap.height}, ${checkFigures(snap).join("; ")}`);
  }

  // ---------------- 6. a request lapsed when its deposit lands
  console.log(`\n-- ${at()} 6. a request that has lapsed when its deposit lands`);
  const req4 = arca("alice", "receive", "--asset", A).request;
  const fallbackAddr = await seq("getnewaddress", [], "user");
  const it4 = (await post("leaf/intent", { request: req4, token: E.MUSD, fallbackAddress: fallbackAddr })).body;
  check("an intent with a fallback address states it", it4.fallback?.kind === "address" && it4.fallback.address === fallbackAddr);
  await killDaemon();
  const lapse = it4.until;
  const mtp = await chain.advance(lapse - (await seq("getblockchaininfo")).mediantime - 3600);
  check("the chain's median time is within an hour of the request's lapse", lapse - mtp <= 3600 && lapse > mtp, `lapse ${lapse}, median time ${mtp}`);
  const received = async () => Math.round(Number((await seq("getreceivedbyaddress", [fallbackAddr, 0], "user"))?.[A] ?? 0) * 1e8);
  const before6 = await received();
  const d4 = await deposit(5_000_000n, it4.seqAddress);
  await startDaemon();
  const fb = await waitFor("the fallback delivery", async () => {
    const d = depByTx(d4.hash);
    return d?.status === "minted" ? d : null;
  });
  const got6 = await received();
  check("it is delivered on the chain to the fallback address, with the reason",
    Boolean(fb.steps.sendTxid) && fb.leaf.route === "fallback" && got6 - before6 === 500_000_000, `${fb.leaf.fallbackReason}; received ${got6 - before6}`);
  await reconciles("after the fallback delivery", A, { owedAtoms: 0, leafWalletAtoms: 0 });

  const st = await api("health");
  check("health names no leaf problem", !(st.body.problems ?? []).some((p) => String(p.key).startsWith("leaf:")), JSON.stringify((st.body.problems ?? []).map((p) => p.key)));
} catch (e) {
  console.log(`FAIL  ${e.message}`);
  failures++;
} finally {
  await stopChain();
  if (daemon && !exited(daemon)) process.kill(daemon.pid, "SIGTERM");
}
console.log(`\n${failures ? `${failures} CHECK(S) FAILED` : "ALL LEAF CHECKS PASSED"} (${record.length} checks, ${at()})`);
process.exit(failures ? 1 : 0);
