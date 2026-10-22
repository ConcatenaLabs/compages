// Checks a snapshot's figures against each other, with no network access:
// every derived number must follow from the raw ones it was derived from.
// A signature proves who said it; this proves it adds up.

import { unitsToAtoms, vaultBacking, backedVerdict } from "./figures.mjs";
import { escrowAccounts } from "./chains.mjs";

export function checkFigures(payload) {
  const errors = [];
  const solLabel = payload.solana?.cluster ?? null;
  for (const a of payload.assets ?? []) {
    const name = a.ticker ?? a.symbol ?? a.assetId;
    let escrow = 0n;
    let measured = a.sources.length > 0;
    for (const s of a.sources) {
      if (s.escrowUnits === null) {
        measured = false;
        continue;
      }
      let units = 0n;
      if (String(s.chainId) === String(payload.ethereum?.chainId)) {
        for (const h of s.holdings) {
          const b = vaultBacking({ balance: h.balance, owed: h.owed, queued: h.queued, cancelled: h.cancelled }).toString();
          if (b !== h.backing) errors.push(`${name}: vault ${h.vault} backing ${h.backing} should be ${b}`);
          units += BigInt(h.backing);
        }
        const vaults = s.holdings.map((h) => h.vault.toLowerCase()).sort();
        const listed = (payload.ethereum.vaults ?? []).map((v) => v.toLowerCase()).sort();
        if (JSON.stringify(vaults) !== JSON.stringify(listed)) errors.push(`${name}: not every listed vault was read`);
      } else if (s.chainId === solLabel) {
        const expected = new Map(escrowAccounts(payload.solana.owners, s.token).map((e) => [e.account, e]));
        for (const h of s.holdings) {
          const e = expected.get(h.account);
          if (!e || e.owner !== h.owner) errors.push(`${name}: ${h.account} is not an escrow account of ${h.owner} for ${s.token}`);
          units += BigInt(h.units);
        }
      }
      if (units.toString() !== s.escrowUnits) errors.push(`${name}: ${s.chainId} escrow ${s.escrowUnits} should be ${units}`);
      const atoms = unitsToAtoms(units, s.decimals, a.precision).toString();
      if (atoms !== s.escrowAtoms) errors.push(`${name}: ${s.chainId} escrow atoms ${s.escrowAtoms} should be ${atoms}`);
      escrow += BigInt(atoms);
    }
    const want = measured ? escrow.toString() : null;
    if (a.escrowAtoms !== want) errors.push(`${name}: escrowAtoms ${a.escrowAtoms} should be ${want}`);
    let transit = 0n;
    const solSource = a.sources.find((s) => s.chainId === solLabel);
    for (const b of a.inTransit ?? []) if (b.counted) transit += unitsToAtoms(b.amount, solSource?.decimals ?? a.precision, a.precision);
    if (a.inTransitAtoms !== transit.toString()) errors.push(`${name}: inTransitAtoms ${a.inTransitAtoms} should be ${transit}`);
    const s = a.supply;
    if (s.circulatingAtoms !== null && s.seen) {
      const c = BigInt(s.issuedAtoms) + BigInt(s.reissuedAtoms) - BigInt(s.burnedAtoms);
      if (c.toString() !== s.circulatingAtoms) errors.push(`${name}: circulating ${s.circulatingAtoms} should be ${c}`);
    }
    let deducted = "0";
    if (a.burnOnly) {
      const b = a.burnOnly;
      const sum = (list, f) => list.reduce((x, o) => x + BigInt(o[f]), 0n);
      const live = sum(b.outputs, "value");
      if (live.toString() !== b.liveAtoms) errors.push(`${name}: liveAtoms ${b.liveAtoms} should be ${live}`);
      const outpoints = new Set();
      for (const o of b.outputs) {
        if (outpoints.has(o.outpoint)) errors.push(`${name}: output ${o.outpoint} is counted twice`);
        outpoints.add(o.outpoint);
        if (!(o.height <= payload.height)) errors.push(`${name}: output ${o.outpoint} is made at ${o.height}, above H`);
        if (o.spentBy && !(o.spentAt > payload.height)) errors.push(`${name}: output ${o.outpoint} is spent at ${o.spentAt}, not above H`);
      }
      for (const [list, total, label] of [[b.mints, b.mintedAtoms, "mintedAtoms"], [b.burns, b.burnedAtoms, "burnedAtoms"]]) {
        const t = sum(list, "amount");
        if (t.toString() !== total) errors.push(`${name}: ${label} ${total} should be ${t}`);
        for (const x of list) if (!(x.height <= payload.height)) errors.push(`${name}: ${x.txid} is in block ${x.height}, above H`);
      }
      const net = BigInt(b.mintedAtoms) - BigInt(b.burnedAtoms);
      const want = (live < net ? live : net).toString();
      if (b.deductedAtoms !== want) errors.push(`${name}: deductedAtoms ${b.deductedAtoms} should be ${want}`);
      deducted = b.deductedAtoms;
    }
    const verdict = backedVerdict({ supply: s, escrowAtoms: a.escrowAtoms, inTransitAtoms: a.inTransitAtoms, deductedAtoms: deducted });
    if (verdict !== a.backed) errors.push(`${name}: backed is ${a.backed}, the figures say ${verdict}`);
    if (a.leaves) {
      const l = a.leaves;
      const sum = l.boardsInFlight.reduce((x, b) => x + BigInt(b.atoms), 0n).toString();
      if (sum !== l.boardsInFlightAtoms) errors.push(`${name}: boardsInFlightAtoms ${l.boardsInFlightAtoms} should be ${sum}`);
      for (const b of l.boardsInFlight) {
        const below = b.blockHeight !== null && b.blockHeight <= payload.height;
        if (b.atOrBelowH !== below) errors.push(`${name}: board ${b.txid} atOrBelowH is ${b.atOrBelowH}, its height ${b.blockHeight} says ${below}`);
      }
      if (BigInt(l.owedAtoms) < BigInt(l.boardsInFlightAtoms)) errors.push(`${name}: owes ${l.owedAtoms}, less than its boards in flight ${l.boardsInFlightAtoms}`);
    }
  }
  return errors;
}
