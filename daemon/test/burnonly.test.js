// The burn-only accounting: an operator's issuer_supply report, each part
// checked against a chain reader. A fake reader and fake trees stand in for
// the node and the operator.

import test from "node:test";
import assert from "node:assert/strict";
import { checkBurnOnly, issuedOf, burnedOf, BURN_SCRIPT, nodeReader } from "../lib/burnonly.js";

const X = "aa".repeat(32);
const Y = "bb".repeat(32);
const R1 = "11".repeat(32);
const R2 = "22".repeat(32);
const SWEEP = "33".repeat(32);
const NODE_TX = "44".repeat(32);
const ENTRY_TX = "55".repeat(32);
const TOP = "5120" + "01".repeat(32);
const LOW0 = "5120" + "02".repeat(32);
const LOW1 = "5120" + "03".repeat(32);

// A tree of two lowest nodes under the batch output: leaves 0-1 under LOW0,
// 2-3 under LOW1.
const tree = (asset = X, burn = true) => ({
  asset,
  burn,
  round_state: "final",
  nodes: [
    [
      { value: "600", reserve: "0", script_pubkey: LOW0, children: [0, 2] },
      { value: "400", reserve: "0", script_pubkey: LOW1, children: [2, 4] },
    ],
    [{ value: "1000", reserve: "0", script_pubkey: TOP, children: [0, 2] }],
  ],
});

function fakeChain() {
  const txs = new Map();
  const utxos = new Map();
  const add = (txid, t) => txs.set(txid, { txid, inChain: true, height: 10, vin: [], vout: [], ...t });
  // Round 1 mints 1000 of X into its batch output 1 (output 0 is the
  // limiter's successor).
  add(R1, {
    vin: [{ txid: "00".repeat(32), vout: 0, issuance: { asset: X, amount: 1000n, blinded: false } }],
    vout: [{ n: 0, asset: "cc".repeat(32), value: 1n, script: "5120" + "09".repeat(32) }, { n: 1, asset: X, value: 1000n, script: TOP }],
  });
  utxos.set(`${R1}:1`, { asset: X, value: 1000n, script: TOP });
  // A sweep burns 700 of X.
  add(SWEEP, { vout: [{ n: 0, asset: X, value: 700n, script: BURN_SCRIPT }, { n: 1, asset: Y, value: 5n, script: "0014" + "07".repeat(20) }] });
  return {
    txs,
    utxos,
    add,
    reader: {
      async tx(txid) {
        return txs.get(txid) ?? null;
      },
      async utxo(txid, vout) {
        return utxos.get(`${txid}:${vout}`) ?? null;
      },
    },
  };
}

const trees = (map) => ({ async get(txid, vout) {
  const t = map[`${txid}:${vout}`];
  if (!t) throw new Error("no such tree");
  return t;
} });

const report = (over = {}) => ({
  asset: X,
  mints: [{ txid: R1, kind: "round", amount: "1000", state: "final" }],
  burns: [{ txid: SWEEP, kind: "sweep", amount: "700", state: "final" }],
  minted: "1000",
  burned: "700",
  in_batches: "1000",
  in_batches_outputs: [{ outpoint: `${R1}:1`, value: "1000", round_txid: R1, batch_vout: 1, kind: "batch" }],
  ...over,
});

test("a report the chain confirms is counted whole", async () => {
  const c = fakeChain();
  const r = await checkBurnOnly({ assetId: X, report: report(), trees: trees({ [`${R1}:1`]: tree() }), reader: c.reader });
  assert.equal(r.mintedAtoms, 1000n);
  assert.equal(r.burnedAtoms, 700n);
  assert.equal(r.liveAtoms, 1000n);
  assert.equal(r.deductAtoms, 300n, "the smaller of what is live and what the operator minted less what it burned");
  assert.equal(r.agrees, true, r.problems.join("; "));
});

test("the deduction is the smaller of the live units and the operator's net mint", async () => {
  const c = fakeChain();
  // No burn yet: both are 1000.
  let r = await checkBurnOnly({ assetId: X, report: report({ burns: [], burned: "0" }), trees: trees({ [`${R1}:1`]: tree() }), reader: c.reader });
  assert.equal(r.deductAtoms, 1000n);
  // The batch gone (swept), the burn counted: what was minted less what was
  // burned is negative, and supply less it is what deposits minted.
  c.utxos.delete(`${R1}:1`);
  r = await checkBurnOnly({ assetId: X, report: report({ in_batches: "0", in_batches_outputs: [], burns: [{ txid: SWEEP, kind: "sweep", amount: "700" }, { txid: SWEEP, kind: "claim", amount: "700" }], burned: "1400" }),
    trees: trees({ [`${R1}:1`]: tree() }), reader: c.reader });
  assert.equal(r.burnedAtoms, 1400n);
  assert.equal(r.deductAtoms, -400n);
  // A mint whose transaction makes no burn-only batch is not a round's.
  r = await checkBurnOnly({ assetId: X, report: report(), trees: trees({ [`${R1}:1`]: tree(X, false) }), reader: c.reader });
  assert.equal(r.mintedAtoms, 0n);
  assert.match(r.mints[0].why, /makes no burn-only batch/);
  assert.equal(r.deductAtoms, -700n, "an operator that lists less only makes the check stricter");
});

test("a mint the chain does not show minting the listed amount is not counted", async () => {
  const c = fakeChain();
  const rep = report({ mints: [{ txid: R1, kind: "round", amount: "999", state: "final" }] });
  const r = await checkBurnOnly({ assetId: X, report: rep, trees: trees({ [`${R1}:1`]: tree() }), reader: c.reader });
  assert.equal(r.mintedAtoms, 0n);
  assert.equal(r.agrees, false);
  assert.match(r.mints[0].why, /the chain shows 1000, the operator 999/);
});

test("a mint or burn in no block of the active chain is not counted (a reorg takes both out)", async () => {
  const c = fakeChain();
  c.txs.get(R1).inChain = false;
  c.txs.get(SWEEP).inChain = false;
  c.utxos.delete(`${R1}:1`);
  const r = await checkBurnOnly({ assetId: X, report: report(), trees: trees({ [`${R1}:1`]: tree() }), reader: c.reader });
  assert.equal(r.mintedAtoms, 0n);
  assert.equal(r.burnedAtoms, 0n);
  assert.equal(r.liveAtoms, 0n);
  assert.match(r.mints[0].why, /not in a block of the active chain/);
  assert.match(r.outputs[0].why, /its round is in no block/);
});

test("an output whose batch is not published burn-only is not deducted", async () => {
  const c = fakeChain();
  const r = await checkBurnOnly({ assetId: X, report: report(), trees: trees({ [`${R1}:1`]: tree(X, false) }), reader: c.reader });
  assert.equal(r.liveAtoms, 0n);
  assert.match(r.outputs[0].why, /not published as burn-only/);
});

test("an output of another asset's batch, or holding something else, is not deducted", async () => {
  const c = fakeChain();
  let r = await checkBurnOnly({ assetId: X, report: report(), trees: trees({ [`${R1}:1`]: tree(Y) }), reader: c.reader });
  assert.equal(r.liveAtoms, 0n);
  assert.match(r.outputs[0].why, /its batch holds/);
  c.utxos.set(`${R1}:1`, { asset: X, value: 999n, script: TOP });
  r = await checkBurnOnly({ assetId: X, report: report(), trees: trees({ [`${R1}:1`]: tree() }), reader: c.reader });
  assert.equal(r.liveAtoms, 0n);
  assert.match(r.outputs[0].why, /the chain shows 999/);
});

test("a coin of the operator's own listed as a batch output is not deducted", async () => {
  const c = fakeChain();
  // An ordinary coin of X, named as round 1's batch output elsewhere.
  c.add(R2, { vout: [{ n: 0, asset: X, value: 1000n, script: "0014" + "08".repeat(20) }] });
  c.utxos.set(`${R2}:0`, { asset: X, value: 1000n, script: "0014" + "08".repeat(20) });
  const rep = report({ in_batches_outputs: [{ outpoint: `${R2}:0`, value: "1000", round_txid: R1, batch_vout: 1, kind: "batch" }] });
  let r = await checkBurnOnly({ assetId: X, report: rep, trees: trees({ [`${R1}:1`]: tree() }), reader: c.reader });
  assert.equal(r.liveAtoms, 0n);
  assert.match(r.outputs[0].why, /not the round's/);
  // Named as a node of the tree.
  const rep2 = report({ in_batches_outputs: [{ outpoint: `${R2}:0`, value: "1000", round_txid: R1, batch_vout: 1, kind: "node", level: 0, index: 0 }] });
  r = await checkBurnOnly({ assetId: X, report: rep2, trees: trees({ [`${R1}:1`]: tree() }), reader: c.reader });
  assert.equal(r.liveAtoms, 0n);
  assert.match(r.outputs[0].why, /not the published node 0\/0/);
  // Named as an entry: no lowest node of the tree made it.
  c.add(R2, { vin: [{ txid: "66".repeat(32), vout: 0, prevoutScript: "0014" + "06".repeat(20) }], vout: [{ n: 0, asset: X, value: 1000n, script: "0014" + "08".repeat(20) }] });
  const rep3 = report({ in_batches_outputs: [{ outpoint: `${R2}:0`, value: "1000", round_txid: R1, batch_vout: 1, kind: "entry", level: -1, index: 1 }] });
  r = await checkBurnOnly({ assetId: X, report: rep3, trees: trees({ [`${R1}:1`]: tree() }), reader: c.reader });
  assert.equal(r.liveAtoms, 0n);
  assert.match(r.outputs[0].why, /not made by unrolling a lowest node/);
});

test("an unrolled batch: its nodes and an entry are deducted where the tree puts them", async () => {
  const c = fakeChain();
  c.utxos.delete(`${R1}:1`);
  c.add(NODE_TX, { vin: [{ txid: R1, vout: 1, prevoutScript: TOP }], vout: [{ n: 0, asset: X, value: 600n, script: LOW0 }, { n: 1, asset: X, value: 400n, script: LOW1 }] });
  c.utxos.set(`${NODE_TX}:1`, { asset: X, value: 400n, script: LOW1 });
  // LOW0 unrolled into its two entries; one is still on the chain.
  c.add(ENTRY_TX, { vin: [{ txid: NODE_TX, vout: 0 }], vout: [{ n: 0, asset: X, value: 300n, script: "5120" + "0a".repeat(32) }] });
  c.utxos.set(`${ENTRY_TX}:0`, { asset: X, value: 300n, script: "5120" + "0a".repeat(32) });
  const rep = report({
    in_batches: "700",
    in_batches_outputs: [
      { outpoint: `${NODE_TX}:1`, value: "400", round_txid: R1, batch_vout: 1, kind: "node", level: 0, index: 1 },
      { outpoint: `${ENTRY_TX}:0`, value: "300", round_txid: R1, batch_vout: 1, kind: "entry", level: -1, index: 1 },
    ],
  });
  const r = await checkBurnOnly({ assetId: X, report: rep, trees: trees({ [`${R1}:1`]: tree() }), reader: c.reader });
  assert.equal(r.liveAtoms, 700n, r.problems.join("; "));
  assert.equal(r.agrees, true);
  // The same entry under the other lowest node is refused.
  const rep2 = report({ in_batches: "300", in_batches_outputs: [{ outpoint: `${ENTRY_TX}:0`, value: "300", round_txid: R1, batch_vout: 1, kind: "entry", level: -1, index: 2 }] });
  const r2 = await checkBurnOnly({ assetId: X, report: rep2, trees: trees({ [`${R1}:1`]: tree() }), reader: c.reader });
  assert.equal(r2.liveAtoms, 0n);
});

test("an operator figure above what it lists is a disagreement, and only the confirmed sum is deducted", async () => {
  const c = fakeChain();
  const r = await checkBurnOnly({ assetId: X, report: report({ in_batches: "5000" }), trees: trees({ [`${R1}:1`]: tree() }), reader: c.reader });
  assert.equal(r.liveAtoms, 1000n);
  assert.equal(r.agrees, false);
  assert.ok(r.problems.some((p) => /lists outputs of 1000 and reports 5000/.test(p)));
});

test("a snapshot at a past height counts only outputs made at or below it", async () => {
  const c = fakeChain();
  let r = await checkBurnOnly({ assetId: X, report: report(), trees: trees({ [`${R1}:1`]: tree() }), reader: c.reader, atOrBelow: 9 });
  assert.equal(r.liveAtoms, 0n);
  assert.equal(r.mintedAtoms, 0n, "a mint above the height is not counted");
  r = await checkBurnOnly({ assetId: X, report: report(), trees: trees({ [`${R1}:1`]: tree() }), reader: c.reader, atOrBelow: 10 });
  assert.equal(r.liveAtoms, 1000n);
  assert.equal(r.deductAtoms, 300n);
});

test("issued and burned amounts are read from the transaction", () => {
  const tx = {
    vin: [{ issuance: { asset: X, amount: 5n, blinded: false } }, { issuance: { asset: Y, amount: 7n, blinded: false } }],
    vout: [{ asset: X, value: 3n, script: BURN_SCRIPT }, { asset: X, value: 4n, script: "6a0100" }, { asset: Y, value: 1n, script: BURN_SCRIPT }],
  };
  assert.equal(issuedOf(tx, X), 5n);
  assert.equal(burnedOf(tx, X), 3n, "only a bare OP_RETURN is a burn");
  assert.equal(issuedOf({ vin: [{ issuance: { asset: X, amount: null, blinded: true } }] }, X), null);
});

test("the node reader reads a block-view output and a transaction's place in the chain", async () => {
  const calls = [];
  const rpc = async (m, p) => {
    calls.push([m, p]);
    if (m === "getrawtransaction") return { blockhash: "bh", vin: [{ txid: R1, vout: 1, issuance: { asset: X, assetamount: 0.0000101 } }], vout: [{ n: 0, asset: X, value: 0.00000007, scriptPubKey: { hex: BURN_SCRIPT } }] };
    if (m === "getblockheader") return { confirmations: 3, height: 42 };
    if (m === "gettxout") return null;
  };
  const r = nodeReader(rpc);
  const t = await r.tx(SWEEP);
  assert.equal(t.inChain, true);
  assert.equal(t.height, 42);
  assert.equal(issuedOf(t, X), 1010n);
  assert.equal(burnedOf(t, X), 7n);
  assert.equal(await r.utxo(R1, 1), null);
  assert.deepEqual(calls.find((c) => c[0] === "gettxout")[1], [R1, 1, false], "the block view: mempool spends ignored");
});

test("the indexer reader reads the block view: a spend still in the mempool leaves an output live", async () => {
  const { esploraReader } = await import("../lib/burnonly.js");
  const pages = {
    [`/tx/${R1}`]: { status: { confirmed: true, block_height: 7 }, vin: [{ txid: "00".repeat(32), vout: 0, prevout: { scriptpubkey: "51" }, issuance: { asset_id: X, assetamount: 1000 } }],
      vout: [{ scriptpubkey: "51", asset: "cc".repeat(32), value: 1 }, { scriptpubkey: TOP, asset: X, value: 1000 }] },
    [`/tx/${R1}/outspend/1`]: { spent: true, txid: SWEEP, status: { confirmed: false } },
    [`/tx/${R1}/outspend/0`]: { spent: true, txid: SWEEP, status: { confirmed: true } },
  };
  const r = esploraReader(async (p) => {
    if (!(p in pages)) throw new Error(`404 ${p}`);
    return pages[p];
  });
  const t = await r.tx(R1);
  assert.equal(t.height, 7);
  assert.equal(issuedOf(t, X), 1000n);
  assert.equal(t.vin[0].prevoutScript, "51");
  assert.deepEqual(await r.utxo(R1, 1), { asset: X, value: 1000n, script: TOP });
  assert.equal(await r.utxo(R1, 0), null);
  assert.equal(await r.tx(SWEEP), null);
});
