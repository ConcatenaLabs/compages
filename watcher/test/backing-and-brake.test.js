// What counts as backing, when a reserve gap is a breach, and what the brake
// acts on once one is found.
// Run: npm test
import test from "node:test";
import assert from "node:assert/strict";
import { backingFrom, reserveBreached, reserveShortfall, shouldBrake, brakeTargets, Streaks, unitsToAtoms } from "../lib/checks.js";

const ETH = "0x0000000000000000000000000000000000000000";
const USDC = "0x1c7d4b196cb0c7b01d743fbc6116a902379c7238";
const V1 = "0xd72af53b4f0551a25072cc72a29f699ed9d8ed41";
const V2 = "0x7b702d6a2e2351f0c4e549642e65ababc0324384";
const MIN = 60_000;

// ------------------------------------------------------------------ backing

test("owed, queued and cancelled amounts are not backing", () => {
  assert.equal(backingFrom(1000n, { owed: 100n, queued: 200n, cancelled: 50n }), 650n);
  assert.equal(backingFrom(1000n, { owed: 100n }), 900n);
  assert.equal(backingFrom(1000n, { queued: 1000n }), 0n);
});

test("an older vault reserves nothing: its whole balance backs supply", () => {
  assert.equal(backingFrom(1000n), 1000n);
  assert.equal(backingFrom(1000n, {}), 1000n);
});

test("reservations above the balance give zero backing, never negative", () => {
  assert.equal(backingFrom(100n, { owed: 60n, queued: 60n }), 0n);
});

test("contract call results (ethers BigInt or numeric strings) are accepted", () => {
  assert.equal(backingFrom("500", { owed: "100", queued: 0n, cancelled: 1n }), 399n);
});

test("a reservation turns an apparently backed asset into a shortfall", () => {
  // 10 USDC circulating on Sequentia (8-decimal atoms), 10 USDC in the vault
  // (6 decimals), of which 3 are owed to a recipient who refused a payout.
  const supply = 10n * 10n ** 8n;
  const naive = unitsToAtoms(10_000_000n, 6);
  assert.equal(reserveShortfall(supply, naive), 0n);
  const escrow = unitsToAtoms(backingFrom(10_000_000n, { owed: 3_000_000n }), 6);
  assert.equal(reserveShortfall(supply, escrow), 3n * 10n ** 8n);
});

// --------------------------------------------------------- reserve breach

test("a shortfall counts only once it has lasted breachMinutes", () => {
  assert.equal(reserveBreached(5n, 9 * MIN, 10), false);
  assert.equal(reserveBreached(5n, 10 * MIN, 10), true);
  assert.equal(reserveBreached(5n, 10 * MIN - 1, 10), false);
  assert.equal(reserveBreached(5n, 10 * MIN), true, "the default is 10 minutes");
  assert.equal(reserveBreached(5n, 0, 0), true, "a zero window breaches at once");
});

test("no shortfall, or an unmeasured one, is never a breach", () => {
  assert.equal(reserveBreached(0n, 60 * MIN, 10), false);
  assert.equal(reserveBreached(null, 60 * MIN, 10), false);
  assert.equal(reserveBreached(reserveShortfall(null, 5n), 60 * MIN, 10), false);
  assert.equal(reserveBreached(reserveShortfall(5n, null), 60 * MIN, 10), false);
});

test("a gap that closes resets the clock", () => {
  const s = new Streaks();
  const t0 = 1_000_000;
  assert.equal(s.observe("reserve:a", true, t0), 0);
  assert.equal(reserveBreached(1n, s.observe("reserve:a", true, t0 + 9 * MIN)), false);
  s.observe("reserve:a", false, t0 + 9 * MIN + 1);
  assert.equal(s.observe("reserve:a", true, t0 + 11 * MIN), 0);
  assert.equal(reserveBreached(1n, s.observe("reserve:a", true, t0 + 20 * MIN)), false);
  assert.equal(reserveBreached(1n, s.observe("reserve:a", true, t0 + 21 * MIN)), true);
});

// -------------------------------------------------------------------- brake

test("only a critical problem about the bridge pulls the brake", () => {
  assert.equal(shouldBrake({ severity: "critical" }), true);
  assert.equal(shouldBrake({ severity: "critical", noBrake: true }), false, "an RPC dropping logs is not the vault's fault");
  assert.equal(shouldBrake({ severity: "warning" }), false);
});

const vaults = [{ address: V1 }, { address: V2 }];
const assets = [
  { assetId: "weth", sources: [{ chainId: 11155111, token: "eth" }] },
  { assetId: "usdc", sources: [{ chainId: 11155111, token: "0x1C7D4B196Cb0C7B01d743Fbc6116a902379C7238" }, { chainId: "solana-devnet", token: "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU" }] },
  { assetId: "musd", sources: [{ chainId: 11155111, token: "0x00000000000000000000000000000000000000aa" }] },
];

test("a vault-level fault pauses that vault and halts the assets its token backs", () => {
  const t = brakeTargets({ vault: V1, token: USDC }, vaults, assets);
  assert.deepEqual([...t.pause], [V1]);
  assert.deepEqual(t.halt, ["usdc"]);
});

test("a vault-level fault on ether halts the asset the daemon names 'eth'", () => {
  // Regression: the vault's books name ether by the zero address and the
  // daemon's asset list names it "eth", so an ether fault halted nothing.
  const t = brakeTargets({ vault: V1, token: ETH }, vaults, assets);
  assert.deepEqual(t.halt, ["weth"]);
});

test("a reserve breach pauses every vault and halts only that asset", () => {
  const t = brakeTargets({ assetId: "musd" }, vaults, assets);
  assert.deepEqual([...t.pause].sort(), [V1, V2].sort());
  assert.deepEqual(t.halt, ["musd"]);
});

test("a problem naming neither vault, token nor asset brakes nothing", () => {
  const t = brakeTargets({ key: "daemon" }, vaults, assets);
  assert.equal(t.pause.size, 0);
  assert.deepEqual(t.halt, []);
});

test("without the daemon's asset list a token fault still pauses its vault", () => {
  const t = brakeTargets({ vault: V1, token: USDC }, vaults, []);
  assert.deepEqual([...t.pause], [V1]);
  assert.deepEqual(t.halt, []);
});
