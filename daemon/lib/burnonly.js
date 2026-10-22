// Units of an issuer-operated asset that live under burn-only sweeps, checked
// against the chain.
//
// An Arca operator that serves a bridged asset issuer-operated funds each
// batch by reissuing the asset in the round that makes it, through the
// asset's mint limiter, and every sweep of such a batch can only burn. Until
// a batch is swept, its units sit on the chain beside the coins its holders
// gave up for it: the supply counts both. So the bridge's reserve checks
// deduct what is live under burn-only sweeps before they compare supply with
// escrow, and count what the operator burns (sweeps, claims, the fees holders
// paid in the asset, coins abandoned past expiry) as burned when it burns.
//
// Nothing here takes the operator's word for a figure. Its `issuer_supply`
// report names each round's mint, each burn, and each output it counts as
// live under a burn-only sweep; every one of them is read again through a
// chain reader of the caller's (the bridge's node, the watcher's indexer)
// and counted only when the chain shows it: a mint or a burn in a block of
// the active chain with the amount listed, an output unspent there holding
// the asset explicitly, its batch published (`tree`) as burn-only in the
// asset, and the output where that tree puts it. A reorg that takes a round
// and its sweep out takes both out of the accounting together, since every
// figure is read again on the chain as it stands.
//
// What a check deducts is the smaller of two figures, each read on the chain:
//
//   live   the units live under the operator's burn-only sweeps now;
//   net    what the operator's rounds minted less what the operator burned.
//
// `live` alone would let the batches hide units: a holder's leaf still in a
// batch is a claim, yet it is deducted with the batch. `net` alone would let
// a unit minted in a round leave the batches unburned unseen. The smaller of
// the two holds both ways: every unit the chain issues outside a deposit
// must be a listed round's, and every unit outside the batches must be
// backed. Supply less `net` is exactly what deposits minted, less what
// anyone but the operator burned: the holders' fees and abandoned coins the
// operator burns stay counted as escrow's to back, since the chain cannot
// tell them from refresh liquidity being burned.
//
// This module is shared by the daemon, the watcher and the reserve snapshot
// tool; it has no dependencies.

export const BURN_SCRIPT = "6a";

/** A client for the operator's API: `op(call, body)` posts to /v1/<call>. */
export function operatorClient(baseUrl, { timeoutMs = 20_000 } = {}) {
  const base = String(baseUrl).replace(/\/+$/, "");
  return async (call, body = {}) => {
    const res = await fetch(`${base}/v1/${call}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await res.text();
    let j;
    try {
      j = JSON.parse(text);
    } catch {
      throw new Error(`the operator's ${call} answered HTTP ${res.status}: ${text.slice(0, 200)}`);
    }
    if (!res.ok) throw new Error(`the operator's ${call} answered HTTP ${res.status}: ${j?.error?.message ?? text.slice(0, 200)}`);
    return j;
  };
}

/** The operator's published trees, each read once: a tree never changes once
 *  its round is built. */
export class Trees {
  constructor(op) {
    this.op = op;
    this.cache = new Map();
  }
  async get(txid, vout) {
    const k = `${txid}:${vout}`;
    if (!this.cache.has(k)) {
      const t = await this.op("tree", { txid, vout });
      // A round that is still being built may change; keep only what is out.
      if (t?.round_state && t.round_state !== "built") this.cache.set(k, t);
      return t;
    }
    return this.cache.get(k);
  }
}

/** Node RPC amounts are decimal numbers of 8 places. */
export function atomsOf(amount) {
  return BigInt(Math.round(Number(amount) * 1e8));
}

/** A chain reader over a node's RPC. `rpc(method, params[])` answers with
 *  the result. A foreign transaction is read with getrawtransaction, so the
 *  node needs -txindex for anything already in a block. Outputs are read in
 *  the block view (a spend in the mempool leaves an output live), the view
 *  the operator's report and the supply in blocks share. */
export function nodeReader(rpc) {
  const headers = new Map();
  return {
    async tx(txid) {
      let t;
      try {
        t = await rpc("getrawtransaction", [txid, true]);
      } catch {
        return null;
      }
      let inChain = false;
      let height = null;
      if (t.blockhash) {
        let h = headers.get(t.blockhash);
        if (!h) {
          h = await rpc("getblockheader", [t.blockhash]).catch(() => null);
          if (h && h.confirmations > 6) headers.set(t.blockhash, h);
        }
        if (h && h.confirmations >= 1) {
          inChain = true;
          height = h.height;
        }
      }
      return {
        txid,
        inChain,
        height,
        vin: (t.vin ?? []).map((i) => ({
          txid: i.txid ?? null,
          vout: i.vout ?? null,
          issuance: i.issuance
            ? { asset: i.issuance.asset ?? null, amount: i.issuance.assetamount === undefined ? null : atomsOf(i.issuance.assetamount),
                blinded: i.issuance.assetamountcommitment !== undefined }
            : null,
        })),
        vout: (t.vout ?? []).map((o) => ({
          n: o.n,
          asset: o.asset ?? null,
          value: o.value === undefined ? null : atomsOf(o.value),
          script: o.scriptPubKey?.hex ?? "",
        })),
      };
    },
    async utxo(txid, vout) {
      const o = await rpc("gettxout", [txid, vout, false]);
      if (!o) return null;
      return { asset: o.asset ?? null, value: o.value === undefined ? null : atomsOf(o.value), script: o.scriptPubKey?.hex ?? "" };
    },
  };
}

/** A chain reader over an Esplora indexer (`get(path)` answers the JSON).
 *  The block view: an output spent by a transaction still in the mempool is
 *  live, as the operator's report and the supply in blocks count it. */
export function esploraReader(get) {
  return {
    async tx(txid) {
      let t;
      try {
        t = await get(`/tx/${txid}`);
      } catch {
        return null;
      }
      return {
        txid,
        inChain: t.status?.confirmed === true,
        height: t.status?.block_height ?? null,
        vin: (t.vin ?? []).map((i) => ({
          txid: i.txid ?? null,
          vout: i.vout ?? null,
          prevoutScript: i.prevout?.scriptpubkey ?? null,
          issuance: i.issuance
            ? { asset: i.issuance.asset_id ?? null, amount: i.issuance.assetamount === undefined ? null : BigInt(i.issuance.assetamount),
                blinded: i.issuance.assetamountcommitment !== undefined }
            : null,
        })),
        vout: (t.vout ?? []).map((o, n) => ({ n, asset: o.asset ?? null, value: o.value === undefined ? null : BigInt(o.value), script: o.scriptpubkey ?? "" })),
      };
    },
    async utxo(txid, vout) {
      const s = await get(`/tx/${txid}/outspend/${vout}`);
      if (s.spent && s.status?.confirmed) return null;
      const t = await this.tx(txid);
      if (!t?.inChain) return null;
      const o = t.vout[vout];
      return o ? { asset: o.asset, value: o.value, script: o.script } : null;
    },
  };
}

/** What `tx` (a reader's transaction) issues of `assetId`; null when an
 *  issuance of it hides its amount. */
export function issuedOf(tx, assetId) {
  let total = 0n;
  for (const i of tx.vin) {
    if (!i.issuance || i.issuance.asset !== assetId) continue;
    if (i.issuance.blinded) return null;
    total += i.issuance.amount ?? 0n;
  }
  return total;
}

/** What `tx` burns of `assetId`: its explicit outputs of the asset to a bare
 *  OP_RETURN. */
export function burnedOf(tx, assetId) {
  let total = 0n;
  for (const o of tx.vout) if (o.asset === assetId && o.script === BURN_SCRIPT && o.value !== null) total += o.value;
  return total;
}

/** The script of output `vout` of `txid`, read through `reader`. */
async function prevoutScript(reader, vin) {
  if (vin.prevoutScript) return vin.prevoutScript;
  if (!vin.txid) return null;
  const p = await reader.tx(vin.txid);
  return p?.vout?.[vin.vout]?.script ?? null;
}

/**
 * Check the operator's report for `assetId` against the chain.
 *
 *   report  the operator's `issuer_supply` answer
 *   trees   a Trees (the operator's published trees)
 *   reader  a nodeReader or esploraReader
 *   atOrBelow  optional height: only mints, burns and outputs in blocks at
 *              or below it count (a snapshot at a past height)
 *
 * Returns the checked figures, all amounts BigInt atoms:
 *   mintedAtoms, burnedAtoms  the listed mints and burns the chain confirms
 *                             (a mint only in a round with a burn-only batch
 *                             of the asset)
 *   liveAtoms                 the listed live outputs the chain and their
 *                             trees confirm
 *   deductAtoms               what a reserve check deducts: the smaller of
 *                             liveAtoms and mintedAtoms - burnedAtoms, which
 *                             may be negative
 *   reportedInBatches         the operator's own figure
 *   mints, burns, outputs     each listed item with `ok` and, if not, `why`
 *   problems                  every item not confirmed, in words
 *   agrees                    every item confirmed and the operator's sum
 *                             equal to the confirmed one
 */
export async function checkBurnOnly({ assetId, report, trees, reader, atOrBelow = null }) {
  const out = {
    assetId,
    mintedAtoms: 0n,
    burnedAtoms: 0n,
    liveAtoms: 0n,
    deductAtoms: 0n,
    reportedInBatches: BigInt(report?.in_batches ?? "0"),
    reportedMinted: BigInt(report?.minted ?? "0"),
    reportedBurned: BigInt(report?.burned ?? "0"),
    mints: [],
    burns: [],
    outputs: [],
    problems: [],
    agrees: true,
  };
  if (report?.asset && report.asset !== assetId) throw new Error(`the operator reported asset ${report.asset}, not ${assetId}`);
  const fail = (list, item, why) => {
    item.ok = false;
    item.why = why;
    out.problems.push(`${item.kind ?? "output"} ${item.txid ?? item.outpoint}: ${why}`);
    list.push(item);
  };

  for (const [key, readAmount, sumKey] of [
    ["mints", (tx) => issuedOf(tx, assetId), "mintedAtoms"],
    ["burns", (tx) => burnedOf(tx, assetId), "burnedAtoms"],
  ]) {
    for (const e of report?.[key] ?? []) {
      const item = { txid: e.txid, kind: e.kind, amount: String(e.amount), state: e.state };
      const tx = await reader.tx(e.txid);
      if (!tx) {
        fail(out[key], item, "the chain reader does not know this transaction");
        continue;
      }
      if (!tx.inChain) {
        fail(out[key], item, "not in a block of the active chain");
        continue;
      }
      const onChain = readAmount(tx);
      if (onChain === null || onChain !== BigInt(e.amount)) {
        fail(out[key], item, `the chain shows ${onChain === null ? "a hidden amount" : onChain}, the operator ${e.amount}`);
        continue;
      }
      if (atOrBelow !== null && tx.height > atOrBelow) {
        item.ok = false;
        item.why = `in block ${tx.height}, above ${atOrBelow}`;
        out[key].push(item);
        continue;
      }
      if (key === "mints") {
        // A round: the transaction makes a batch of the asset that its
        // published tree says is burn-only.
        let round = false;
        for (const o of tx.vout) {
          if (round || o.asset !== assetId || o.script === BURN_SCRIPT) continue;
          const t = await trees.get(e.txid, o.n).catch(() => null);
          if (t?.burn === true && t.asset === assetId) round = true;
        }
        if (!round) {
          fail(out[key], item, "it makes no burn-only batch of the asset");
          continue;
        }
      }
      item.ok = true;
      item.height = tx.height;
      out[key].push(item);
      out[sumKey] += onChain;
    }
  }

  let listed = 0n;
  for (const e of report?.in_batches_outputs ?? []) {
    listed += BigInt(e.value);
    // `txid:vout` (an older operator prefixes its network, `[elements]`).
    const [txid, voutStr] = String(e.outpoint).replace(/^\[[a-z]+\]/, "").split(":");
    const vout = Number(voutStr);
    const item = { outpoint: e.outpoint, value: String(e.value), kind: e.kind, round: `${e.round_txid}:${e.batch_vout}` };
    let tree;
    try {
      tree = await trees.get(e.round_txid, e.batch_vout);
    } catch (err) {
      fail(out.outputs, item, `its batch's tree could not be read: ${err.message}`);
      continue;
    }
    if (!tree || tree.burn !== true) {
      fail(out.outputs, item, "its batch is not published as burn-only");
      continue;
    }
    if (tree.asset !== assetId) {
      fail(out.outputs, item, `its batch holds ${tree.asset}`);
      continue;
    }
    const levels = tree.nodes ?? [];
    if (levels.length === 0) {
      fail(out.outputs, item, "its batch's tree publishes no nodes");
      continue;
    }
    const round = await reader.tx(e.round_txid);
    if (!round?.inChain) {
      fail(out.outputs, item, "its round is in no block of the active chain");
      continue;
    }
    const coin = await reader.utxo(txid, vout).catch((err) => ({ error: err.message }));
    if (coin?.error) {
      fail(out.outputs, item, `the chain reader could not read it: ${coin.error}`);
      continue;
    }
    if (!coin) {
      fail(out.outputs, item, "not an unspent output in a block of the active chain");
      continue;
    }
    if (coin.asset !== assetId || coin.value === null || coin.value !== BigInt(e.value)) {
      fail(out.outputs, item, `the chain shows ${coin.value} of ${coin.asset}`);
      continue;
    }
    let why = null;
    if (e.kind === "batch") {
      const top = levels[levels.length - 1]?.[0];
      if (txid !== e.round_txid || vout !== Number(e.batch_vout)) why = "a batch output that is not the round's";
      else if (!top || coin.script !== top.script_pubkey) why = "a batch output whose script is not its tree's top node";
    } else if (e.kind === "node") {
      const node = levels[e.level]?.[e.index];
      if (!node) why = `no node ${e.level}/${e.index} in its tree`;
      else if (coin.script !== node.script_pubkey || BigInt(node.value) !== coin.value) why = `not the published node ${e.level}/${e.index}`;
    } else if (e.kind === "entry") {
      // An entry is made by the transaction that unrolls its lowest node:
      // that transaction must spend a lowest node of this tree whose leaves
      // include the entry's.
      const made = await reader.tx(txid);
      const lowest = (levels[0] ?? []).filter((n) => e.index >= n.children[0] && e.index < n.children[1]).map((n) => n.script_pubkey);
      let parentOk = false;
      for (const i of made?.vin ?? []) {
        if (lowest.includes(await prevoutScript(reader, i))) parentOk = true;
      }
      if (!made?.inChain) why = "an entry in no block of the active chain";
      else if (!parentOk) why = "an entry not made by unrolling a lowest node of its tree";
    } else {
      why = `an output of unknown kind ${e.kind}`;
    }
    if (!why && atOrBelow !== null) {
      const made = await reader.tx(txid);
      if (made?.height === null || made?.height === undefined || made.height > atOrBelow) why = `made above height ${atOrBelow}`;
      else item.height = made.height;
    }
    if (why) {
      fail(out.outputs, item, why);
      continue;
    }
    item.ok = true;
    out.outputs.push(item);
    out.liveAtoms += coin.value;
  }
  out.listedInBatches = listed;
  const net = out.mintedAtoms - out.burnedAtoms;
  out.deductAtoms = out.liveAtoms < net ? out.liveAtoms : net;
  if (listed !== out.reportedInBatches) out.problems.push(`the operator lists outputs of ${listed} and reports ${out.reportedInBatches} in batches`);
  if (atOrBelow === null) {
    if (out.mintedAtoms !== out.reportedMinted) out.problems.push(`the operator reports ${out.reportedMinted} minted, the chain confirms ${out.mintedAtoms}`);
    if (out.burnedAtoms !== out.reportedBurned) out.problems.push(`the operator reports ${out.reportedBurned} burned, the chain confirms ${out.burnedAtoms}`);
  }
  out.agrees = out.problems.length === 0 && out.liveAtoms === out.reportedInBatches;
  return out;
}

/** The figures of checkBurnOnly as JSON (decimal strings). */
export function burnOnlyJson(c) {
  return {
    mintedAtoms: c.mintedAtoms.toString(),
    burnedAtoms: c.burnedAtoms.toString(),
    liveAtoms: c.liveAtoms.toString(),
    deductedAtoms: c.deductAtoms.toString(),
    reportedInBatchesAtoms: c.reportedInBatches.toString(),
    agrees: c.agrees,
    problems: c.problems,
    mints: c.mints,
    burns: c.burns,
    outputs: c.outputs,
  };
}
