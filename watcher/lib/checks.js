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

/** Apply one decoded vault event to the books. Returns a note for events
 *  worth reporting on their own (every payout), or null. Unknown events are
 *  ignored: a vault version this watcher does not know yet must not be read
 *  as moving funds. */
export function applyEvent(books, name, a) {
  switch (name) {
    case "Deposited":
      tokenBook(books, a.token).in += a.amount;
      books.deposits += 1;
      return null;
    case "RebalancedIn":
      tokenBook(books, a.token).in += a.amount;
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
