// The supply auditor's checkpoint is resumed only while it is still valid,
// and the real auditor (when a node checkout is at hand) agrees with a
// chain whose supply is known.
// Run: npm test   (AUDIT_SCRIPT=<Sequentia>/contrib/asset-supply-audit/audit.py
//                  also runs the real auditor against a stand-in node)
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { vetCheckpoint, runAudit } from "../lib/audit.mjs";
import { seqClient } from "../lib/chains.mjs";
import { supplyFromAudit } from "../lib/figures.mjs";
import { mockSequentia } from "./mocks.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "reserves-audit-"));
const hashes = { 99: "h99", 199: "h199" };
const blockHash = async (h) => hashes[h] ?? `h${h}`;

function lay(dir, { next = 100, anchor = { nextHeight: 100, blockHash: "h99", assets: ["a", "b"] } } = {}) {
  const cp = path.join(dir, "cp.json");
  fs.writeFileSync(cp, JSON.stringify({ want: ["a", "b"], next_height: next, accs: {} }));
  if (anchor) fs.writeFileSync(`${cp}.anchor.json`, JSON.stringify(anchor));
  return cp;
}

test("a checkpoint the last run completed is resumed", async () => {
  const cp = lay(tmp());
  assert.equal(await vetCheckpoint(cp, { height: 1440, assets: ["b", "a"], blockHash }), null);
  assert.ok(fs.existsSync(cp));
  assert.equal(await vetCheckpoint(cp, { height: 99, assets: ["a", "b"], blockHash }), null, "resuming exactly at its end");
});

test("a checkpoint is discarded when it cannot be trusted", async () => {
  const cases = [
    [{ anchor: null }, {}, /no record/],
    [{ next: 5100 }, {}, /interrupted/],
    [{}, { height: 50 }, /already covers past height 50/],
    [{}, { assets: ["a", "b", "c"] }, /assets changed/],
    [{}, { blockHash: async () => "other" }, /no longer on the chain/],
  ];
  for (const [layout, opts, why] of cases) {
    const cp = lay(tmp(), layout);
    const reason = await vetCheckpoint(cp, { height: 1440, assets: ["a", "b"], blockHash, ...opts });
    assert.match(reason, why);
    assert.ok(!fs.existsSync(cp) && !fs.existsSync(`${cp}.anchor.json`), "discarded means deleted");
  }
  const dir = tmp();
  fs.writeFileSync(path.join(dir, "cp.json"), "not json");
  assert.match(await vetCheckpoint(path.join(dir, "cp.json"), { height: 1, assets: [], blockHash }), /could not be read/);
});

const candidates = [process.env.AUDIT_SCRIPT, path.resolve(here, "../../../Sequentia/contrib/asset-supply-audit/audit.py")];
const auditScript = candidates.find((p) => p && fs.existsSync(p));

test("the real auditor, resumed from its checkpoint and after a reorg", { skip: !auditScript && "no audit.py (set AUDIT_SCRIPT)" }, async (t) => {
  const seq = await mockSequentia();
  t.after(() => seq.server.close());
  const A = "aa".repeat(32);
  const B = "bb".repeat(32);
  const issue = (asset, amount, reissue = false) => ({ vin: [{ issuance: { asset, assetamount: amount, isreissuance: reissue } }], vout: [] });
  const burn = (asset, value) => ({ vin: [], vout: [{ asset, value, scriptPubKey: { type: "nulldata" } }] });
  seq.chain.tip = 3000;
  seq.chain.txs = {
    10: [issue(A, 0)],
    100: [issue(A, 0.2, true), issue(B, 1.5)],
    2000: [burn(A, 0.05)],
    2900: [issue(A, 1, true)], // above the first height
  };
  const rpc = seqClient(seq.rpcUrl);
  const dir = tmp();
  const checkpoint = path.join(dir, "state", "cp.json");
  const go = (height) =>
    runAudit({ script: auditScript, rpc, height, assets: [A, B], checkpoint, blockHash: (h) => rpc.call("getblockhash", [h]) });

  let r = await go(1440);
  assert.equal(r.exitStatus, 0);
  assert.equal(supplyFromAudit(r.report, A).circulatingAtoms, "20000000");
  assert.equal(supplyFromAudit(r.report, B).circulatingAtoms, "150000000");

  // The next height resumes: only the new blocks are read.
  seq.chain.calls.length = 0;
  r = await go(2880);
  assert.equal(r.discarded, null);
  assert.equal(supplyFromAudit(r.report, A).circulatingAtoms, "15000000");
  assert.ok(seq.chain.calls.filter((m) => m === "getblock").length <= 2880 - 1440, "resumed, not rescanned");

  // A reorg below the checkpoint: the burn at 2000 is gone from the chain.
  seq.chain.forkFrom = 1500;
  seq.chain.fork = 1;
  delete seq.chain.txs[2000];
  seq.chain.tip = 4400;
  r = await go(4320);
  assert.match(r.discarded, /no longer on the chain/);
  assert.equal(supplyFromAudit(r.report, A).circulatingAtoms, "120000000");

  // A blinded reissuance makes the figure a bound: exit status 2.
  seq.chain.txs[4330] = [{ vin: [{ issuance: { asset: A, assetamountcommitment: "08ab", isreissuance: true } }], vout: [] }];
  seq.chain.tip = 5800;
  r = await go(5760);
  assert.equal(r.exitStatus, 2);
  assert.equal(supplyFromAudit(r.report, A).exact, false);
});
