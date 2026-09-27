// The judgements a snapshot makes, free of network access so they can be
// tested on their own.

/** The height a snapshot is taken at: the latest multiple of `interval`
 *  that is at least `minDepth` blocks below the tip. Null while the chain
 *  has no such height yet. Everyone can recompute it, and it does not depend
 *  on when the tool happens to run, so two runs agree on which block a
 *  snapshot describes. */
export function chooseHeight(tip, interval, minDepth) {
  if (!Number.isSafeInteger(tip) || !Number.isSafeInteger(interval) || interval <= 0 || !(minDepth >= 0)) {
    throw new Error(`bad height parameters: tip ${tip}, interval ${interval}, minDepth ${minDepth}`);
  }
  const deepest = tip - minDepth;
  if (deepest < interval) return null;
  return Math.floor(deepest / interval) * interval;
}

/** Sequentia amounts are atoms at the asset's precision; a source chain
 *  counts in its token's own decimals. Floors, as the daemon does, so a
 *  conversion never creates backing. */
export function unitsToAtoms(units, decimals, precision) {
  const u = BigInt(units);
  const shift = precision - decimals;
  return shift >= 0 ? u * 10n ** BigInt(shift) : u / 10n ** BigInt(-shift);
}

/** What a vault holds that backs circulating supply: its balance less what
 *  it has reserved for claimants and queued or cancelled payouts (a
 *  version-3 vault's owedTotal + queuedTotal + cancelledTotal). Counting a
 *  reservation as backing would hide a shortfall of that size. */
export function vaultBacking({ balance, owed = 0n, queued = 0n, cancelled = 0n }) {
  const reserved = BigInt(owed) + BigInt(queued) + BigInt(cancelled);
  const b = BigInt(balance);
  return b > reserved ? b - reserved : 0n;
}

/** Circulating supply of one asset from the supply auditor's report.
 *  An asset the auditor saw no issuance, reissuance or burn of has a supply
 *  of exactly zero: the scan covered the whole chain up to the height, and a
 *  blinded event would still have been seen (and counted as blinded). */
export function supplyFromAudit(report, assetId) {
  const d = report?.assets?.[assetId];
  if (!d) {
    return {
      seen: false,
      circulatingAtoms: "0",
      issuedAtoms: "0",
      reissuedAtoms: "0",
      burnedAtoms: "0",
      exact: true,
      blindedIssuances: 0,
      blindedReissuances: 0,
      blindedBurns: 0,
      error: null,
    };
  }
  const circ = BigInt(d.circulating_atoms);
  const out = {
    seen: true,
    circulatingAtoms: circ.toString(),
    issuedAtoms: BigInt(d.issued_atoms).toString(),
    reissuedAtoms: BigInt(d.reissued_atoms).toString(),
    burnedAtoms: BigInt(d.burned_atoms).toString(),
    exact: d.exact === true,
    blindedIssuances: Number(d.blinded_issuances),
    blindedReissuances: Number(d.blinded_reissuances),
    blindedBurns: Number(d.blinded_burns),
    error: null,
  };
  if (circ < 0n) {
    // More burned than issued means the issuance is not on this chain (an
    // asset issued before a chain reset). There is no supply to report.
    out.circulatingAtoms = null;
    out.error = "more burned than issued is visible; this asset's issuance is not on this chain";
  } else if (!out.exact) {
    out.error = "a blinded issuance, reissuance or burn hides part of the supply, so the figure is a bound";
  }
  return out;
}

/** The verdict: backed when escrow plus verified in-transit amounts covers
 *  circulating supply. Given only when every figure it rests on was measured
 *  exactly; otherwise null, never a guess. */
export function backedVerdict({ supply, escrowAtoms, inTransitAtoms = "0" }) {
  if (!supply || supply.circulatingAtoms === null || !supply.exact) return null;
  if (escrowAtoms === null || escrowAtoms === undefined) return null;
  return BigInt(escrowAtoms) + BigInt(inTransitAtoms) >= BigInt(supply.circulatingAtoms);
}

/** Binary search for the last block whose timestamp is at or before `t`,
 *  below a block `hi` whose timestamp is after it. `getBlock(n)` answers
 *  { number, timestamp }. The answer is unique: its successor is after `t`. */
export async function lastBlockAtOrBefore(getBlock, t, hi) {
  if (!(hi.timestamp > t)) throw new Error("the upper block is not after the target time");
  let lo = 0;
  let loBlock = await getBlock(0);
  if (loBlock.timestamp > t) throw new Error("the target time is before the chain's first block");
  let high = hi.number;
  while (high - lo > 1) {
    const mid = Math.floor((lo + high) / 2);
    const b = await getBlock(mid);
    if (b.timestamp <= t) {
      lo = mid;
      loBlock = b;
    } else {
      high = mid;
    }
  }
  return loBlock;
}
