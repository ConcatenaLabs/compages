import test from "node:test";
import assert from "node:assert/strict";
import { leafReconciliation, leafProblems } from "../lib/checks.js";

const A = "a".repeat(64);
const MIN = 60_000;

test("escrow reconciles with users' holdings plus what the bridge owes and was returned", () => {
  // 125 escrowed; supply 125, of which the bridge's leaf wallet holds 25 for a deposit not paid yet.
  assert.deepEqual(leafReconciliation({ escrow: "12500", supply: "12500", bridgeHeld: "2500", owed: "2500", returned: "0" }), { usersHold: 10000n, diff: 0n });
  // The leaf paid: the bridge holds nothing, owes nothing.
  assert.deepEqual(leafReconciliation({ escrow: "12500", supply: "12500", bridgeHeld: "0", owed: "0", returned: "0" }), { usersHold: 12500n, diff: 0n });
  // A float: supply minted ahead of a deposit and held by the bridge, owed to no one.
  assert.equal(leafReconciliation({ escrow: "12500", supply: "13000", bridgeHeld: "500", owed: "0", returned: "0" }).diff, 0n);
  assert.equal(leafReconciliation({ escrow: "12500", supply: null, bridgeHeld: "0", owed: "0", returned: "0" }), null);
});

test("a board the daemon names must be on the chain, holding what it says, after a grace", () => {
  const leaves = { boardsInFlight: [{ deposit: "7", txid: "t1", atoms: "2500" }] };
  assert.deepEqual(leafProblems(A, "MUSD.e", leaves, { boards: { t1: { found: false, missingForMs: 5 * MIN } } }), []);
  const missing = leafProblems(A, "MUSD.e", leaves, { boards: { t1: { found: false, missingForMs: 16 * MIN } } });
  assert.equal(missing[0].key, `leafboard:${A}:t1`);
  assert.equal(missing[0].severity, "warning");
  const wrong = leafProblems(A, "MUSD.e", leaves, { boards: { t1: { found: true, asset: A, value: "2000", missingForMs: 16 * MIN } } });
  assert.equal(wrong[0].severity, "critical");
  assert.ok(wrong[0].noBrake);
  assert.deepEqual(leafProblems(A, "MUSD.e", leaves, { boards: { t1: { found: true, asset: A, value: "2500", missingForMs: 0 } } }), []);
});

test("an escrow that does not reconcile is reported once it lasts; a shortfall is critical", () => {
  const leaves = { boardsInFlight: [] };
  assert.deepEqual(leafProblems(A, "X", leaves, { recon: { diff: -5n }, offForMs: 2 * MIN }), []);
  const short = leafProblems(A, "X", leaves, { recon: { diff: -5n }, offForMs: 20 * MIN });
  assert.equal(short[0].severity, "critical");
  assert.match(short[0].title, /short/);
  const over = leafProblems(A, "X", leaves, { recon: { diff: 7n }, offForMs: 20 * MIN });
  assert.equal(over[0].severity, "warning");
  assert.deepEqual(leafProblems(A, "X", leaves, { recon: { diff: 0n }, offForMs: 0 }), []);
});
