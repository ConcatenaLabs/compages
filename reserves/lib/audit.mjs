// Circulating supply at a fixed height, from the node repository's supply
// auditor (contrib/asset-supply-audit/audit.py), which rebuilds each asset's
// supply from block data alone: explicit issuances plus reissuances minus
// provably unspendable burns.
//
// The auditor keeps a checkpoint so a daily run scans one day of blocks, not
// the whole chain. A checkpoint is a running total up to some height, which
// is only valid while the blocks below that height are still the chain, and
// the auditor itself does not check that: resumed after a reorg it would add
// the new blocks to totals that include the orphaned ones. So beside the
// checkpoint this module records the hash of the last block it covers, and
// discards the checkpoint (a full rescan) when that block is no longer on
// the chain, when the set of assets changed, or when anything about it is
// not exactly as the last successful run left it.

import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

export function fileSha256(file) {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

/** The commit of the checkout the auditor lives in, when it is one. */
export async function gitCommitOf(file) {
  const out = await run("git", ["-C", path.dirname(file), "rev-parse", "HEAD"], { timeoutMs: 10_000 }).catch(() => null);
  const c = out?.code === 0 ? out.stdout.trim() : null;
  return c && /^[0-9a-f]{40,64}$/.test(c) ? c : null;
}

function run(cmd, args, { timeoutMs }) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => {
      stderr += d;
      if (stderr.length > 200_000) stderr = stderr.slice(-100_000);
    });
    const timer = setTimeout(() => child.kill("SIGTERM"), timeoutMs);
    child.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, stdout, stderr });
    });
  });
}

const anchorPath = (checkpoint) => `${checkpoint}.anchor.json`;

/** Decide whether the checkpoint may be resumed at `height`; delete it (and
 *  its anchor) when not. Returns the reason it was discarded, or null. */
export async function vetCheckpoint(checkpoint, { height, assets, blockHash }) {
  if (!fs.existsSync(checkpoint)) {
    fs.rmSync(anchorPath(checkpoint), { force: true });
    return null;
  }
  let reason = null;
  try {
    const cp = JSON.parse(fs.readFileSync(checkpoint, "utf8"));
    const anchor = fs.existsSync(anchorPath(checkpoint)) ? JSON.parse(fs.readFileSync(anchorPath(checkpoint), "utf8")) : null;
    const next = cp.next_height;
    if (!anchor) reason = "no record of the block it ends at";
    else if (anchor.nextHeight !== next) reason = "it moved since the last complete run (an interrupted scan)";
    else if (!Number.isSafeInteger(next) || next < 1) reason = "it covers no blocks";
    else if (next > height + 1) reason = `it already covers past height ${height}`;
    else if (JSON.stringify(anchor.assets) !== JSON.stringify([...assets].sort())) reason = "the set of assets changed";
    else if ((await blockHash(next - 1)) !== anchor.blockHash) reason = `block ${next - 1} is no longer on the chain (a reorg)`;
  } catch (e) {
    reason = `it could not be read (${e.message})`;
  }
  if (reason) {
    fs.rmSync(checkpoint, { force: true });
    fs.rmSync(anchorPath(checkpoint), { force: true });
  }
  return reason;
}

/**
 * Run the auditor over blocks 0..height for `assets`.
 *
 *   script      path to audit.py
 *   python      interpreter (default python3)
 *   rpc         { url, user, password }: the node, credentials kept off the
 *               command line (they go to a private cookie file instead,
 *               since any local user can read a process's arguments)
 *   checkpoint  path of the auditor's checkpoint (optional)
 *   blockHash   async (h) => the node's hash at h
 *
 * Returns { exitStatus, report, discarded }: exit status 0 means every
 * figure is exact and 2 that at least one is only a bound; anything else
 * throws.
 */
export async function runAudit({ script, python = "python3", rpc, height, assets, checkpoint = null, blockHash, timeoutMs = 6 * 3_600_000, log = () => {} }) {
  const wanted = [...assets].sort();
  if (wanted.length === 0) throw new Error("no assets to audit");
  const hashBefore = await blockHash(height);
  let discarded = null;
  if (checkpoint) {
    fs.mkdirSync(path.dirname(checkpoint), { recursive: true });
    discarded = await vetCheckpoint(checkpoint, { height, assets: wanted, blockHash });
    if (discarded) log(`audit checkpoint discarded, rescanning from genesis: ${discarded}`);
  }
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "compages-audit-"));
  try {
    const cookie = path.join(tmpDir, "cookie");
    fs.writeFileSync(cookie, `${rpc.user}:${rpc.password}`, { mode: 0o600 });
    const args = [script, "--rpc-url", rpc.url, "--cookie", cookie, "--start", "0", "--end", String(height), "--json"];
    if (checkpoint) args.push("--checkpoint", checkpoint);
    for (const a of wanted) args.push("--asset", a);
    const r = await run(python, args, { timeoutMs });
    if (r.code !== 0 && r.code !== 2) {
      throw new Error(`the supply auditor failed (${r.signal ?? `exit ${r.code}`}): ${r.stderr.trim().split("\n").slice(-3).join(" / ")}`);
    }
    let report;
    try {
      report = JSON.parse(r.stdout);
    } catch {
      throw new Error("the supply auditor did not print a JSON report");
    }
    if (report.scanned_end !== height) throw new Error(`the auditor scanned to ${report.scanned_end}, not ${height}`);
    if ((await blockHash(height)) !== hashBefore) throw new Error(`block ${height} changed while it was audited (a reorg); try again`);
    if (checkpoint) {
      fs.writeFileSync(anchorPath(checkpoint), JSON.stringify({ nextHeight: height + 1, blockHash: hashBefore, assets: wanted }));
    }
    return { exitStatus: r.code, report, discarded };
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}
