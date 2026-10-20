// The watcher's judgements, kept free of any network access so they can be
// tested on their own. Everything here takes numbers the watcher read from
// the chains and says whether something is wrong.

/** Per-vault, per-token books kept from the vault's own events. Amounts are
 *  BigInt base units of the token. */
export function emptyBooks() {
  return { tokens: {}, deposits: 0 };
}

function tokenBook(books, token) {
  return (books.tokens[token.toLowerCase()] ??= { in: 0n, out: 0n, owed: 0n });
}

const ETHER = "0x0000000000000000000000000000000000000000";
const isEther = (t) => String(t).toLowerCase() === ETHER;

/** Apply one decoded event to the books. Returns a note for events worth
 *  reporting on their own (every payout), or null. Unknown events are
 *  ignored: a vault version this watcher does not know yet must not be read
 *  as moving funds.
 *
 *  What came IN is counted from the most complete source for each kind of
 *  asset. For an ERC-20 that is the token's own Transfer logs into the vault
 *  ("TokenIn"): they cover deposits, CCTP mints, migrations from another
 *  vault and donations alike, some of which emit no vault event at all. For
 *  ether, which a vault only accepts through its own functions, it is the
 *  vault's events. What went OUT is always the vault's payout events, so the
 *  two checks keep their meaning: payouts may not exceed what came in, and
 *  funds may not leave without a payout event. */
export function applyEvent(books, name, a) {
  switch (name) {
    case "TokenIn":
      tokenBook(books, a.token).in += a.amount;
      return null;
    case "Deposited":
      if (isEther(a.token)) tokenBook(books, a.token).in += a.amount;
      books.deposits += 1;
      return null;
    case "RebalancedIn":
    case "CctpUnrecognized": // arrived for no known purpose; the daemon refunds it
      if (isEther(a.token)) tokenBook(books, a.token).in += a.amount;
      return null;
    case "Released":
      tokenBook(books, a.token).out += a.amount;
      return { kind: "payout", token: a.token, amount: a.amount, to: a.to };
    case "Refunded":
      tokenBook(books, a.token).out += a.amount;
      return { kind: "refund", token: a.token, amount: a.amount, to: a.to };
    case "ReleaseDeferred":
      // Committed to a recipient who could not take it yet: it leaves the
      // free balance now and the vault when claimed.
      tokenBook(books, a.token).owed += a.amount;
      return { kind: "deferred", token: a.token, amount: a.amount, to: a.to };
    case "Claimed": {
      const b = tokenBook(books, a.token);
      b.owed -= a.amount;
      b.out += a.amount;
      return { kind: "claim", token: a.token, amount: a.amount, to: a.to };
    }
    case "ReleasedViaCctp":
    case "RefundedViaCctp":
      tokenBook(books, a.token).out += a.amount;
      return { kind: "cctp-payout", token: a.token, amount: a.amount, to: a.to ?? null };
    case "Rebalanced":
    case "LockedStablecoinBurned":
      tokenBook(books, a.token).out += a.amount;
      return { kind: name === "Rebalanced" ? "rebalance-out" : "circle-burn", token: a.token, amount: a.amount };
    default:
      return null;
  }
}

/** Problems with one vault's books against its live balances and deposit
 *  counter. `balances` maps lowercase token address (ZeroAddress for ether)
 *  to BigInt; `depositCount` is the vault's own counter at the scanned head. */
export function checkVault(vault, books, balances, depositCount) {
  const problems = [];
  if (depositCount !== null && depositCount !== undefined && BigInt(depositCount) !== BigInt(books.deposits)) {
    problems.push({
      key: `vault:${vault}:count`,
      severity: "critical",
      title: `vault ${short(vault)} counts ${depositCount} deposits but the RPC returned ${books.deposits}`,
      detail: "the Ethereum RPC is dropping logs; nothing read from it can be trusted until a full rescan agrees",
      rescan: true,
      // A data-source fault, not a fault of the vault: alert, never brake.
      noBrake: true,
    });
  }
  for (const [token, b] of Object.entries(books.tokens)) {
    const committed = b.out + b.owed;
    if (committed > b.in) {
      problems.push({
        key: `vault:${vault}:${token}:overpaid`,
        severity: "critical",
        title: `vault ${short(vault)} paid out more ${short(token)} than was ever deposited`,
        detail: `in ${b.in}, out ${b.out}, owed ${b.owed}`,
        token,
        vault,
      });
    }
    const held = balances[token];
    if (held !== undefined && held < b.in - committed) {
      problems.push({
        key: `vault:${vault}:${token}:short`,
        severity: "critical",
        title: `vault ${short(vault)} holds less ${short(token)} than its own events account for`,
        detail: `holds ${held}, events say ${b.in - committed}: funds left by a path that emits no event`,
        token,
        vault,
      });
    }
  }
  return problems;
}

/** Whether circulating supply exceeds what backs it. Both sides in atoms of
 *  the Sequentia asset; either may be null when it could not be measured,
 *  and an unmeasured side never produces a verdict. */
export function reserveShortfall(supplyAtoms, escrowAtoms) {
  if (supplyAtoms === null || escrowAtoms === null) return null;
  return supplyAtoms > escrowAtoms ? supplyAtoms - escrowAtoms : 0n;
}

/** What a vault's balance of a token contributes as backing: the balance
 *  less what a version-3 vault has set aside for claimants and for queued or
 *  cancelled payouts. Those already belong to users whose Sequentia side is
 *  settled, so counting them would hide a shortfall of that size. Never
 *  negative. */
export function backingFrom(held, { owed = 0n, queued = 0n, cancelled = 0n } = {}) {
  const reserved = BigInt(owed) + BigInt(queued) + BigInt(cancelled);
  const h = BigInt(held);
  return h > reserved ? h - reserved : 0n;
}

/** Whether a shortfall has lasted long enough to count as a breach: a brief
 *  gap (a redemption paid out a few seconds before its burn) never does. */
export function reserveBreached(shortfall, heldMs, breachMinutes = 10) {
  return Boolean(shortfall) && shortfall > 0n && heldMs >= breachMinutes * 60_000;
}

/** Whether a problem pulls the brake: only a critical one about the bridge
 *  itself, never a fault of the watcher's own data source. */
export function shouldBrake(p) {
  return p.severity === "critical" && !p.noBrake;
}

/** What the brake acts on for problem `p`: the vaults to pause (the one
 *  named, or every vault when a whole asset is short) and the daemon assets
 *  to halt (the one named, or every asset a vault-level fault's token backs).
 *  `assets` is the daemon's /api/assets list. The daemon names ether "eth"
 *  where the vault's books name it by the zero address; both mean ether. */
export function brakeTargets(p, vaults, assets) {
  const pause = new Set();
  if (p.vault) pause.add(p.vault);
  if (p.assetId) for (const v of vaults) pause.add(v.address);
  let halt = [];
  if (p.assetId) halt = [p.assetId];
  else if (p.token) {
    const want = String(p.token).toLowerCase();
    const tokenOf = (s) => (s.token === "eth" ? ETHER : String(s.token).toLowerCase());
    halt = assets.filter((m) => (m.sources ?? []).some((s) => tokenOf(s) === want)).map((m) => m.assetId);
  }
  return { pause, halt };
}

/** Tracks how long each condition has held, so a brief, explainable gap (a
 *  redemption paid out a few seconds before its burn) never raises an
 *  alarm, while one that persists does. */
export class Streaks {
  constructor(saved = {}) {
    this.since = { ...saved };
  }
  /** Record that `key` holds (true) or not (false) at `now`; returns how
   *  many milliseconds it has held continuously. */
  observe(key, holds, now = Date.now()) {
    if (!holds) {
      delete this.since[key];
      return 0;
    }
    this.since[key] ??= now;
    return now - this.since[key];
  }
  toJSON() {
    return this.since;
  }
}

/** Convert source base units to Sequentia atoms (floor), as the bridge does. */
export function unitsToAtoms(units, decimals, precision = 8) {
  const u = BigInt(units);
  const shift = precision - decimals;
  return shift >= 0 ? u * 10n ** BigInt(shift) : u / 10n ** BigInt(-shift);
}

function short(x) {
  const s = String(x);
  return s.length > 14 ? `${s.slice(0, 8)}…${s.slice(-4)}` : s;
}

/** The mint limiter's slots for a state, as the descriptor's data leaf holds
 *  them: big-endian hex at each slot's width. */
export function limiterSlots(state) {
  const hex = (n, w) => BigInt(n).toString(16).padStart(w, "0");
  return { MINTED: hex(state.minted, 16), ELAPSED: hex(state.elapsed, 4), ARMED: hex(state.armed, 2) };
}

/** What is wrong with an asset's mint limiter, read from the chain rather
 *  than taken from the daemon.
 *
 *  `view` is what the daemon reports (`mintLimiter` in /api/assets). Then,
 *  each read through the watcher's own indexer and null when unread:
 *    coin            the output the daemon names: { scriptpubkey, asset, value }
 *    expectedScript  the instance's script in the state the daemon names,
 *                    derived here from the descriptor
 *    tokenSupply     every unit of the reissuance token the chain has issued
 *    spentBy, spentForMs  who spent the coin, and for how long the daemon has
 *                    named a spent coin
 *  The limiter holds the asset's mint authority only if the coin is the
 *  instance in that state, holds the token, and holds all of it: a token
 *  unit anywhere else can still mint without limit. */
export function limiterProblems(assetId, symbol, view, { coin = null, expectedScript = null, tokenSupply = null, spentBy = null, spentForMs = 0 } = {}, spentMinutes = 15) {
  const p = [];
  const key = (k) => `limiter:${k}:${assetId}`;
  if (!view) return p;
  if (view.recovered) {
    // The cold key's own act, not a fault of the bridge: it alerts and pulls no brake.
    p.push({ key: key("recovered"), severity: "critical", title: `${symbol}: the cold key recovered the token from its mint limiter`, detail: `recovery ${view.recovered.txid}`, assetId, noBrake: true });
    return p;
  }
  if (!view.coin) {
    p.push({ key: key("none"), severity: "warning", title: `${symbol}: its token is in no mint limiter`, detail: "the daemon names no limiter coin", assetId });
    return p;
  }
  if (view.braked) {
    p.push({ key: key("brake"), severity: "critical", title: `${symbol}: the mint limiter's brake is on`, detail: "no mint until the cold key lifts it", assetId, noBrake: true });
  }
  if (coin && expectedScript && coin.scriptpubkey !== expectedScript) {
    p.push({
      key: key("script"),
      severity: "critical",
      title: `${symbol}: the coin the daemon names is not the mint limiter in the state it reports`,
      detail: `coin ${view.coin.txid}:${view.coin.vout} pays ${coin.scriptpubkey.slice(0, 20)}…, the instance in that state is ${expectedScript.slice(0, 20)}…`,
      assetId,
    });
  }
  if (coin && coin.asset !== view.tokenId) {
    p.push({ key: key("asset"), severity: "critical", title: `${symbol}: the limiter coin does not hold the reissuance token`, detail: `it holds ${coin.asset}`, assetId });
  }
  if (coin && tokenSupply !== null && BigInt(coin.value) !== BigInt(tokenSupply)) {
    p.push({
      key: key("outside"),
      severity: "critical",
      title: `${symbol}: reissuance token units exist outside the mint limiter`,
      detail: `the limiter holds ${coin.value} of ${tokenSupply}; the rest can mint without limit`,
      assetId,
    });
  }
  if (spentBy && spentForMs >= spentMinutes * 60_000) {
    p.push({
      key: key("stale"),
      severity: "warning",
      title: `${symbol}: the mint limiter's coin was spent and the daemon still names it`,
      detail: `spent by ${spentBy} ${Math.round(spentForMs / 60_000)} min ago`,
      assetId,
    });
  }
  return p;
}
