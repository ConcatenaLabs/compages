import test from "node:test";
import assert from "node:assert/strict";
import { emptyBooks, applyEvent, checkVault, reserveShortfall, Streaks, unitsToAtoms } from "../lib/checks.js";

const ETH = "0x0000000000000000000000000000000000000000";
const USDC = "0x1c7d4b196cb0c7b01d743fbc6116a902379c7238";
const V = "0xd72af53b4f0551a25072cc72a29f699ed9d8ed41";

function books(events) {
  const b = emptyBooks();
  for (const [name, a] of events) applyEvent(b, name, a);
  return b;
}

test("balanced books raise nothing", () => {
  const b = books([
    ["Deposited", { token: USDC, amount: 100n }],
    ["Released", { token: USDC, amount: 40n, to: "0xabc" }],
  ]);
  assert.deepEqual(checkVault(V, b, { [USDC]: 60n }, 1), []);
});

test("paying out more than was deposited is critical", () => {
  const b = books([
    ["Deposited", { token: ETH, amount: 10n }],
    ["Released", { token: ETH, amount: 11n, to: "0xabc" }],
  ]);
  const p = checkVault(V, b, { [ETH]: 0n }, 1);
  assert.equal(p.length, 1);
  assert.equal(p[0].severity, "critical");
  assert.match(p[0].key, /overpaid$/);
});

test("funds leaving without an event are caught by the balance", () => {
  const b = books([["Deposited", { token: USDC, amount: 100n }]]);
  const p = checkVault(V, b, { [USDC]: 70n }, 1);
  assert.equal(p.length, 1);
  assert.match(p[0].key, /short$/);
});

test("a donation (more held than booked) is not a problem", () => {
  const b = books([["Deposited", { token: USDC, amount: 100n }]]);
  assert.deepEqual(checkVault(V, b, { [USDC]: 150n }, 1), []);
});

test("an RPC that drops a deposit log is caught by the vault's own counter", () => {
  const b = books([["Deposited", { token: USDC, amount: 100n }]]);
  const p = checkVault(V, b, { [USDC]: 100n }, 2);
  assert.equal(p.length, 1);
  assert.equal(p[0].rescan, true);
});

test("owed payouts count as committed until claimed", () => {
  const b = books([
    ["Deposited", { token: ETH, amount: 10n }],
    ["ReleaseDeferred", { token: ETH, amount: 4n, to: "0xabc" }],
  ]);
  // Still held by the vault, but committed: the free balance is 6.
  assert.deepEqual(checkVault(V, b, { [ETH]: 10n }, 1), []);
  applyEvent(b, "Claimed", { token: ETH, amount: 4n, to: "0xdef" });
  assert.equal(b.tokens[ETH].owed, 0n);
  assert.equal(b.tokens[ETH].out, 4n);
  assert.deepEqual(checkVault(V, b, { [ETH]: 6n }, 1), []);
});

test("rebalancing in and out, and the Circle hand-off burn, are booked", () => {
  const b = books([
    ["Deposited", { token: USDC, amount: 100n }],
    ["RebalancedIn", { token: USDC, amount: 50n }],
    ["Rebalanced", { token: USDC, amount: 20n }],
    ["LockedStablecoinBurned", { token: USDC, amount: 130n }],
  ]);
  assert.equal(b.tokens[USDC].in, 150n);
  assert.equal(b.tokens[USDC].out, 150n);
  assert.deepEqual(checkVault(V, b, { [USDC]: 0n }, 1), []);
});

test("an unknown event moves nothing", () => {
  const b = emptyBooks();
  assert.equal(applyEvent(b, "SomethingNew", { token: USDC, amount: 5n }), null);
  assert.deepEqual(b.tokens, {});
});

test("reserve shortfall needs both sides measured", () => {
  assert.equal(reserveShortfall(null, 5n), null);
  assert.equal(reserveShortfall(5n, null), null);
  assert.equal(reserveShortfall(5n, 5n), 0n);
  assert.equal(reserveShortfall(6n, 5n), 1n);
});

test("a condition must persist before it counts", () => {
  const s = new Streaks();
  assert.equal(s.observe("k", true, 1000), 0);
  assert.equal(s.observe("k", true, 61_000), 60_000);
  assert.equal(s.observe("k", false, 62_000), 0);
  assert.equal(s.observe("k", true, 63_000), 0);
});

test("atoms convert with floor, both directions of precision", () => {
  assert.equal(unitsToAtoms(1_000_000_000_000_000_000n, 18, 8), 100_000_000n);
  assert.equal(unitsToAtoms(1_234_567n, 6, 6), 1_234_567n);
  assert.equal(unitsToAtoms(1n, 6, 8), 100n);
});
