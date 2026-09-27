#!/usr/bin/env node
// compages-reserves snapshot: append one signed proof-of-reserves snapshot.
//
//   node snapshot.mjs [config.json] [--dry-run]
//
// Picks the Sequentia height H (the latest multiple of `intervalBlocks` at
// least `minDepth` blocks deep), and when the history has no snapshot for it
// yet, records every bridged asset's circulating supply at H (from the node
// repository's supply auditor) against its escrow at the matching Ethereum
// block and on Solana, signs the result with the attestation key and writes
// `<snapshotDir>/<H>.json` plus a rebuilt `index.json`. Running it again for
// the same H does nothing, so it is safe to run from a frequent timer.
//
// --dry-run prints the payload it would sign, and writes nothing.
//
// Exit status: 0 when a snapshot was written or there was nothing to do yet,
// 1 on any failure (nothing is written then).

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ethers } from "ethers";
import { takeSnapshot } from "./lib/take.mjs";
import { canonicalize } from "./lib/format.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const dryRun = argv.includes("--dry-run");
const cfgPath = path.resolve(argv.find((a) => !a.startsWith("--")) ?? path.join(here, "config.json"));
const cfg = JSON.parse(fs.readFileSync(cfgPath, "utf8"));
const rel = (p) => (p ? path.resolve(path.dirname(cfgPath), p) : p);
for (const k of ["snapshotDir", "attestationKeyFile", "auditScript", "auditCheckpoint"]) cfg[k] = rel(cfg[k]);
for (const k of ["snapshotDir", "seqRpcUrl", "auditScript", "daemonUrl", "ethRpcUrl", "ethChainId", "vaults"]) {
  if (cfg[k] === undefined || cfg[k] === "") {
    console.error(`config: ${k} is required`);
    process.exit(1);
  }
}
const log = (m) => console.log(`${new Date().toISOString()} ${m}`);

let signer = null;
if (!dryRun) {
  if (!cfg.attestationKeyFile || !fs.existsSync(cfg.attestationKeyFile)) {
    console.error("config: attestationKeyFile must name the attestation key (see README, \"Signed reserve snapshots\")");
    process.exit(1);
  }
  signer = new ethers.Wallet(fs.readFileSync(cfg.attestationKeyFile, "utf8").trim());
}

try {
  const r = await takeSnapshot(cfg, { signer, dryRun, log });
  if (r.status === "written") log(`wrote ${r.file} (sha256 ${r.hash}), signed by ${signer.address}`);
  else if (r.status === "dry-run") console.log(JSON.stringify(JSON.parse(canonicalize(r.payload)), null, 1));
  else if (r.status === "up-to-date") log(`up to date: the latest snapshot is height ${r.height}`);
  else log(`nothing to do yet: ${r.reason}`);
} catch (e) {
  log(`snapshot failed: ${e.message}`);
  process.exit(1);
}
