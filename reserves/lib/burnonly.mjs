// The units of an issuer-operated asset live under burn-only sweeps at a
// snapshot's height H (see ../../daemon/lib/burnonly.js for what they are and
// why a reserve check deducts them).
//
// The operator reports what is live now; the snapshot is taken some blocks
// after H. So the units live at H are what the operator lists now and the
// chain shows made at or below H, plus every output of the asset's burn-only
// batches made at or below H and spent in a block after it, found by reading
// those blocks: each such output's spender is recorded, so anyone can check
// that it was spent above H. The operator's mints and burns count when they
// are in blocks at or below H. What is deducted is the smaller of the units
// live at H and those mints less those burns, as everywhere else.

import { nodeReader, checkBurnOnly, BURN_SCRIPT } from "../../daemon/lib/burnonly.js";

export { operatorClient, Trees, nodeReader } from "../../daemon/lib/burnonly.js";

/** The burn-only batches of `assetId` the operator's rounds made: for each
 *  round it lists a mint of, each of its outputs of the asset that has a
 *  published burn-only tree in the asset. */
export async function batchesOf({ assetId, report, trees, reader }) {
  const out = [];
  for (const m of report?.mints ?? []) {
    const tx = await reader.tx(m.txid);
    if (!tx?.inChain) continue;
    for (const o of tx.vout) {
      if (o.asset !== assetId || o.script === BURN_SCRIPT) continue;
      const t = await trees.get(m.txid, o.n).catch(() => null);
      if (t?.burn === true && t.asset === assetId && (t.nodes ?? []).length) out.push({ round: m.txid, vout: o.n, tree: t });
    }
  }
  return out;
}

/** Where output `vout` of `prev` sits in one of `batches`: { kind, round,
 *  level?, index? }, or null when it is in none. */
export async function placeIn(batches, prev, vout, reader) {
  const o = prev.vout[vout];
  for (const b of batches) {
    const levels = b.tree.nodes;
    if (prev.txid === b.round && vout === b.vout) return { kind: "batch", round: `${b.round}:${b.vout}` };
    for (let l = 0; l < levels.length; l++) {
      const i = levels[l].findIndex((n) => n.script_pubkey === o.script);
      if (i >= 0) return { kind: "node", round: `${b.round}:${b.vout}`, level: l, index: i };
    }
  }
  // An entry: made by a transaction that spends a lowest node of a batch.
  for (const i of prev.vin) {
    let script = i.prevoutScript ?? null;
    if (!script && i.txid) script = (await reader.tx(i.txid))?.vout?.[i.vout]?.script ?? null;
    if (!script) continue;
    for (const b of batches) {
      if ((b.tree.nodes[0] ?? []).some((n) => n.script_pubkey === script)) return { kind: "entry", round: `${b.round}:${b.vout}`, level: -1 };
    }
  }
  return null;
}

/**
 * The figures at `height`: { liveAtoms, outputs, deductAtoms, check } where
 * `outputs` lists every output live at H (outpoint, value, kind, round,
 * height, and for one spent since, `spentBy` and `spentAt`), and `check` is
 * checkBurnOnly's result at H (its mints and burns those at or below H).
 *
 *   rpc     (method, params[]) => result, a node with -txindex
 *   report  the operator's issuer_supply answer
 *   trees   a Trees of the operator's published trees
 */
export async function burnOnlyAtHeight({ rpc, assetId, report, trees, height }) {
  const reader = nodeReader(rpc);
  const check = await checkBurnOnly({ assetId, report, trees, reader, atOrBelow: height });
  const outputs = check.outputs.filter((o) => o.ok).map((o) => ({ outpoint: o.outpoint, value: o.value, kind: o.kind, round: o.round, height: o.height }));
  let live = check.liveAtoms;
  const batches = await batchesOf({ assetId, report, trees, reader });
  const tip = await rpc("getblockcount", []);
  const seen = new Set(outputs.map((o) => o.outpoint));
  for (let h = height + 1; h <= tip && batches.length; h++) {
    const block = await rpc("getblock", [await rpc("getblockhash", [h]), 2]);
    for (const t of block.tx ?? []) {
      for (const i of t.vin ?? []) {
        if (!i.txid) continue;
        const prev = await reader.tx(i.txid);
        if (!prev?.inChain || prev.height > height) continue;
        const o = prev.vout[i.vout];
        if (!o || o.asset !== assetId || o.value === null) continue;
        const place = await placeIn(batches, prev, i.vout, reader);
        if (!place) continue;
        const outpoint = `${i.txid}:${i.vout}`;
        if (seen.has(outpoint)) continue;
        seen.add(outpoint);
        outputs.push({ outpoint, value: o.value.toString(), ...place, height: prev.height, spentBy: t.txid, spentAt: h });
        live += o.value;
      }
    }
  }
  const net = check.mintedAtoms - check.burnedAtoms;
  return { liveAtoms: live, outputs, deductAtoms: live < net ? live : net, check };
}
