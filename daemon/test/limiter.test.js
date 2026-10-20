import test from "node:test";
import assert from "node:assert/strict";
import { mintNext, limits, limiterView, MIN_AGE } from "../lib/limiter.js";

// The instance of sequentia-contracts' m1 harness test: a window of 20
// blocks, an allowance of 1,000,000,000 atoms.
const instance = {
  instance: 2,
  template_hash: "77218080daacd33cb636f1411920eb5f2d6ee805cb94d8d0651ce1808c0b557b",
  params: { WINDOW: "0014", ALLOWANCE: "000000003b9aca00", RECOVERY_DELAY: "0002" },
  genesis: "00".repeat(32),
};
const s = (minted, elapsed, armed = 0) => ({ minted: String(minted), elapsed, armed });

test("the limits read from the instance's parameters", () => {
  assert.deepEqual(limits(instance), { window: 20, allowance: 1_000_000_000n, recoveryDelay: 2 });
});

test("a mint within the window adds to the count and to the window's blocks", () => {
  assert.deepEqual(mintNext(instance, s(0, 0), 2, 500_000_000n), { next: s(500_000_000, 2) });
  assert.deepEqual(mintNext(instance, s(500_000_000, 2), 2, 500_000_000n), { next: s(1_000_000_000, 4) });
});

test("over the allowance waits for the window's end, in blocks", () => {
  const r = mintNext(instance, s(1_000_000_000, 4), 2, 1n);
  assert.match(r.refused, /allowance/);
  assert.equal(r.waitBlocks, 14);
  assert.ok(!r.never);
});

test("the window ends once its blocks reach WINDOW, and the count restarts", () => {
  assert.equal(mintNext(instance, s(1_000_000_000, 4), 15, 1n).refused !== undefined, true);
  assert.deepEqual(mintNext(instance, s(1_000_000_000, 4), 16, 1_000_000_000n), { next: s(1_000_000_000, 0) });
});

test("more than a whole allowance never mints", () => {
  const r = mintNext(instance, s(0, 0), 50, 1_000_000_001n);
  assert.ok(r.never);
});

test("a coin under two blocks old, and a braked coin, wait", () => {
  assert.equal(MIN_AGE, 2);
  assert.equal(mintNext(instance, s(0, 0), 1, 1n).waitBlocks, 1);
  assert.match(mintNext(instance, s(0, 0, 1), 5, 1n).refused, /brake/);
});

test("the view names the coin, its state and its limits", () => {
  const v = limiterView({
    reissuanceToken: "ab".repeat(32),
    limiter: { instance, address: "ert1p…", coin: { txid: "cd".repeat(32), vout: 0 }, state: s(7, 3), tokenAtoms: "100000000" },
  });
  assert.equal(v.windowBlocks, 20);
  assert.equal(v.allowanceAtoms, "1000000000");
  assert.equal(v.recoveryDelaySeconds, 1024);
  assert.equal(v.braked, false);
  assert.equal(v.tokenId, "ab".repeat(32));
  assert.equal(limiterView({}), null);
});
