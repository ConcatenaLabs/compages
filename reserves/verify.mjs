#!/usr/bin/env node
// compages-reserves verify: check signed proof-of-reserves snapshots.
//
//   node verify.mjs <target> [--attester 0x...] [--rederive ...options]
//
// <target> is one of
//   a snapshot file        checks it; if the file before it sits beside it,
//                          checks the link too
//   a history directory    checks every snapshot, every link, and index.json
//   an http(s) URL         the bridge (https://host/bridge) or its
//                          /api/por/history: fetches the index and every
//                          snapshot it lists, then checks them as a directory
//
// Always checked: the canonical form and payload hash, the EIP-191
// signature, the hash chain, and that every derived figure follows from the
// raw ones. --attester pins the address the signatures must recover to;
// without it each snapshot is checked against the attester it names, which
// proves it is intact but not who made it.
//
// --rederive re-reads the latest snapshot's figures (or --height H's) from
// public endpoints you choose:
//   --eth-rpc URL        vault balances and reservations at block B, B's hash,
//                        and that B is the last block at or before H's time
//                        (needs a node that still has B's state: an archive
//                        node for an old snapshot)
//   --seq-rpc URL        block H's hash and the genesis hash (http://user:pass@host:port)
//   --audit-script PATH  with --seq-rpc: rerun the supply auditor to H and
//                        compare every supply figure (a full scan)
//   --sol-rpc URL        the cluster's genesis hash and every listed CCTP
//                        transfer's burn; with --eth-rpc as well, whether each
//                        was still in flight at block B (its CCTP nonce, from
//                        Circle's attestation service, unused at B)
//   --iris-url URL       Circle's attestation service (default: the sandbox)
//   --transmitter 0x...  Circle's MessageTransmitterV2 on the Ethereum chain
// Solana balances cannot be re-derived: Solana's RPC answers only for the
// current state, never for a past slot.
//
// Exit status 0 when everything checked passed, 1 otherwise.

import fs from "node:fs";
import path from "node:path";
import { ethers } from "ethers";
import { verifySnapshot, verifyChain, checkLink, buildIndex, canonicalize, parseIndex } from "./lib/format.mjs";
import { listHeights, readSnapshot } from "./lib/store.mjs";
import { checkFigures } from "./lib/consistency.mjs";
import { supplyFromAudit } from "./lib/figures.mjs";
import { runAudit } from "./lib/audit.mjs";
import { seqClient, ethProvider, vaultFigures, solClient, checkBurn, checkTransfer } from "./lib/chains.mjs";

function parseArgs(argv) {
  const o = { target: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) o.target = a;
    else if (a === "--rederive") o.rederive = true;
    else o[a.slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = argv[++i];
  }
  return o;
}

const opts = parseArgs(process.argv.slice(2));
if (!opts.target) {
  console.error("usage: node verify.mjs <snapshot.json | history-dir | https://host/bridge> [--attester 0x...] [--rederive --eth-rpc URL ...]");
  process.exit(1);
}

let failures = 0;
const ok = (m) => console.log(`ok    ${m}`);
const bad = (m) => {
  failures++;
  console.log(`FAIL  ${m}`);
};
const note = (m) => console.log(`note  ${m}`);

async function fetchHistory(target) {
  const base = target.replace(/\/+$/, "").replace(/\/api\/por\/history$/, "");
  const get = async (p) => {
    const res = await fetch(`${base}/api/por/history${p}`, { signal: AbortSignal.timeout(30_000) });
    if (!res.ok) throw new Error(`${base}/api/por/history${p}: HTTP ${res.status}`);
    return res.json();
  };
  const index = parseIndex(await get(""));
  if (!index) throw new Error(`${base}/api/por/history did not answer with a snapshot index`);
  const snaps = [];
  for (const e of index.snapshots) snaps.push(await get(`/${e.height}`));
  return { index, snaps };
}

function checkIndex(index, snaps) {
  if (!index) return bad("no index.json");
  const expected = canonicalize(buildIndex(snaps));
  if (canonicalize(index) === expected) ok(`index lists all ${snaps.length} snapshots and their hashes`);
  else bad("index.json does not match the snapshots it lists");
}

async function rederive(snap) {
  const p = snap.payload;
  console.log(`\nre-deriving height ${p.height}`);
  if (opts.ethRpc) {
    const eth = ethProvider(opts.ethRpc, p.ethereum.chainId);
    const B = await eth.getBlock(p.ethereum.block);
    if (B?.hash === p.ethereum.blockHash) ok(`Ethereum block ${B.number} hash`);
    else bad(`Ethereum block ${p.ethereum.block} is ${B?.hash}, snapshot says ${p.ethereum.blockHash}`);
    const next = await eth.getBlock(p.ethereum.block + 1);
    if (B && next && B.timestamp <= p.sequentia.time && next.timestamp > p.sequentia.time) {
      ok(`block ${B.number} is the last at or before Sequentia block ${p.height}'s time`);
    } else bad(`block ${p.ethereum.block} is not the last Ethereum block at or before ${p.sequentia.time}`);
    for (const a of p.assets) {
      for (const s of a.sources) {
        if (String(s.chainId) !== String(p.ethereum.chainId) || s.escrowUnits === null) continue;
        for (const h of s.holdings) {
          const token = s.token === "eth" ? ethers.ZeroAddress : s.token;
          const f = await vaultFigures(eth, h.vault, token, p.ethereum.block);
          if (canonicalize(f) === canonicalize(h)) ok(`${a.ticker ?? a.symbol}: vault ${h.vault} at block ${p.ethereum.block}`);
          else bad(`${a.ticker ?? a.symbol}: vault ${h.vault} reads ${canonicalize(f)}, snapshot says ${canonicalize(h)}`);
        }
      }
    }
  } else note("Ethereum not re-derived (no --eth-rpc)");

  if (opts.seqRpc) {
    const seq = seqClient(opts.seqRpc);
    const h = await seq.call("getblockhash", [p.height]);
    if (h === p.sequentia.blockHash) ok(`Sequentia block ${p.height} hash`);
    else bad(`Sequentia block ${p.height} is ${h}, snapshot says ${p.sequentia.blockHash} (reorged since, or another chain)`);
    const g = await seq.call("getblockhash", [0]);
    if (g === p.sequentia.genesisHash) ok("Sequentia genesis hash");
    else bad(`Sequentia genesis is ${g}, snapshot says ${p.sequentia.genesisHash}`);
    if (opts.auditScript) {
      const audit = await runAudit({
        script: opts.auditScript,
        python: opts.python ?? "python3",
        rpc: seq,
        height: p.height,
        assets: p.assets.map((a) => a.assetId),
        checkpoint: opts.auditCheckpoint ?? null,
        blockHash: (x) => seq.call("getblockhash", [x]),
        log: note,
      });
      if (audit.exitStatus === p.sequentia.auditor.exitStatus) ok(`auditor exit status ${audit.exitStatus}`);
      else bad(`auditor exits ${audit.exitStatus}, snapshot says ${p.sequentia.auditor.exitStatus}`);
      for (const a of p.assets) {
        const s = supplyFromAudit(audit.report, a.assetId);
        if (canonicalize(s) === canonicalize(a.supply)) ok(`${a.ticker ?? a.symbol}: supply ${s.circulatingAtoms} at ${p.height}`);
        else bad(`${a.ticker ?? a.symbol}: auditor says ${canonicalize(s)}, snapshot says ${canonicalize(a.supply)}`);
      }
    } else note("supply not re-derived (no --audit-script)");
  } else note("Sequentia not re-derived (no --seq-rpc)");

  if (p.solana) {
    note(`Solana balances are as of slot ${p.solana.slot}..${p.solana.lastSlot}; Solana cannot be read at a past slot, so they are not re-derivable`);
    if (opts.solRpc) {
      const sol = solClient(opts.solRpc);
      const g = await sol("getGenesisHash", []);
      if (g === p.solana.genesisHash) ok("Solana genesis hash");
      else bad(`Solana genesis is ${g}, snapshot says ${p.solana.genesisHash}`);
      for (const a of p.assets) {
        const s = a.sources.find((x) => x.chainId === p.solana.cluster);
        for (const b of a.inTransit ?? []) {
          // With an Ethereum RPC the whole rule is re-derived: burned before
          // the Solana read AND not received by block B. Without one, only
          // the burn half can be.
          const c = opts.ethRpc
            ? await checkTransfer({
                sol,
                eth: ethProvider(opts.ethRpc, p.ethereum.chainId),
                burn: b,
                mint: s.token,
                treasury: p.solana.treasury,
                readSlot: p.solana.slot,
                blockB: p.ethereum.block,
                irisUrl: opts.irisUrl,
                transmitter: opts.transmitter,
              })
            : await checkBurn(sol, b, { mint: s.token, treasury: p.solana.treasury, readSlot: p.solana.slot });
          if (c.counted === b.counted) ok(`${a.ticker ?? a.symbol}: CCTP burn ${b.solanaBurn} ${c.counted ? "counted" : "not counted"}`);
          else bad(`${a.ticker ?? a.symbol}: CCTP burn ${b.solanaBurn}: ${c.reason ?? "checks out"}, but the snapshot ${b.counted ? "counts" : "does not count"} it`);
        }
      }
    }
  }
}

async function main() {
  let snaps;
  let index = null;
  let single = false;
  const t = opts.target;
  if (/^https?:\/\//.test(t)) {
    ({ index, snaps } = await fetchHistory(t));
  } else if (fs.statSync(t).isDirectory()) {
    snaps = listHeights(t).map((h) => readSnapshot(t, h));
    const ip = path.join(t, "index.json");
    index = fs.existsSync(ip) ? JSON.parse(fs.readFileSync(ip, "utf8")) : null;
  } else {
    single = true;
    snaps = [JSON.parse(fs.readFileSync(t, "utf8"))];
  }
  if (snaps.length === 0) {
    note("no snapshots");
    return;
  }

  const attester = opts.attester ?? null;
  for (const s of snaps) {
    const v = verifySnapshot(s, { attester });
    const h = s.payload?.height;
    if (v.ok) ok(`${h}: signed by ${v.signer}${attester ? " (the pinned attester)" : ""}, sha256 ${v.hash}`);
    else v.errors.forEach((e) => bad(`${h}: ${e}`));
    if (v.hash) {
      const errs = checkFigures(s.payload);
      if (errs.length === 0) ok(`${h}: the figures add up`);
      else errs.forEach((e) => bad(`${h}: ${e}`));
    }
  }

  if (single) {
    const s = snaps[0];
    const prevH = s.payload.previous?.height;
    const prevFile = prevH !== undefined ? path.join(path.dirname(t), `${prevH}.json`) : null;
    if (prevH === undefined) note(`${s.payload.height} is the first snapshot of its history`);
    else if (fs.existsSync(prevFile)) {
      const errs = checkLink(JSON.parse(fs.readFileSync(prevFile, "utf8")), s);
      if (errs.length) errs.forEach(bad);
      else ok(`${s.payload.height} links to ${prevH}`);
    } else note(`the link to ${prevH} is not checked: ${prevFile} is not here`);
  } else {
    const c = verifyChain(snaps, { attester });
    if (c.linkErrors.length) c.linkErrors.forEach(bad);
    else ok(`hash chain intact over ${snaps.length} snapshots, head ${c.head.height} (${c.head.hash})`);
    checkIndex(index, snaps);
  }

  if (opts.rederive) {
    const want = opts.height !== undefined ? Number(opts.height) : Math.max(...snaps.map((s) => s.payload.height));
    const s = snaps.find((x) => x.payload.height === want);
    if (!s) bad(`no snapshot at height ${want}`);
    else await rederive(s);
  }
}

try {
  await main();
} catch (e) {
  bad(e.message);
}
console.log(failures ? `\n${failures} check(s) FAILED` : "\nall checks passed");
process.exit(failures ? 1 : 0);
