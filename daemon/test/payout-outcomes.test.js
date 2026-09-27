// What the daemon records once a vault payout has an outcome, and how it
// reads that outcome back from a vault that has already taken the payout on.
// A record that lands in the wrong state either pays twice or never, so every
// branch is pinned here against small fakes of the vault and the state file.
// Run: npm test
import test from "node:test";
import assert from "node:assert/strict";
import { Bridge } from "../lib/bridge.js";

const TOKEN_KEY = "11155111:0x1c7d4b196cb0c7b01d743fbc6116a902379c7238";
const ASSET = "aa".repeat(32);
const ID = "0x" + "ab".repeat(32);

/** A Bridge with no constructor side effects: just a state file that counts
 *  saves, a log that remembers, and a halt that records instead of acting. */
function bridge({ mappings = {}, cfg = {}, eth = {} } = {}) {
  const b = Object.create(Bridge.prototype);
  b.cfg = cfg;
  b.eth = eth;
  b.saves = 0;
  b.state = { data: { mappings, halted: {} }, save: () => b.saves++ };
  b.lines = [];
  b.log = (m) => b.lines.push(m);
  b.halts = [];
  b.halt = (assetId, scope, reason) => b.halts.push({ assetId, scope, reason });
  return b;
}

/** A unified-style mapping that keeps an escrow ledger for TOKEN_KEY. */
const ledgerMapping = (escrowedUnits = "1000") => ({
  assetId: ASSET,
  sources: { [TOKEN_KEY]: { tokenKey: TOKEN_KEY, escrowedUnits } },
});

const redemption = (extra = {}) => ({
  assetId: ASSET,
  tokenKey: TOKEN_KEY,
  amountUnits: "400",
  ethAddress: "0x70997970c51812dc3a010c7d01b50e0d17dc79c8",
  status: "releasing",
  ethTx: { hash: "0x01" },
  waiting: "releases are paused on the vault",
  ...extra,
});

// ---------------------------------------------------------------- releases

test("a paid release is released, keeps its tx hash and debits the escrow once", () => {
  const m = ledgerMapping("1000");
  const b = bridge({ mappings: { k: m } });
  const rec = redemption();
  b.applyReleaseOutcome(rec, { paid: "0xpaid" }, "t");
  assert.equal(rec.status, "released");
  assert.equal(rec.releaseTxHash, "0xpaid");
  assert.equal(rec.ethTx, undefined, "the sent-tx marker is cleared");
  assert.equal(rec.waiting, undefined, "a stale waiting reason is cleared");
  assert.equal(m.sources[TOKEN_KEY].escrowedUnits, "600");
  assert.equal(rec.escrowDebited, true);
  assert.ok(b.saves >= 1);
  // Learning the same outcome again (another path saw the payout) must not
  // debit the ledger a second time or replace the recorded transaction.
  b.applyReleaseOutcome(rec, { paid: "0xother" }, "t");
  assert.equal(m.sources[TOKEN_KEY].escrowedUnits, "600");
  assert.equal(rec.releaseTxHash, "0xpaid");
});

test("a release the recipient refused is still released, and records what is owed", () => {
  const b = bridge({ mappings: { k: ledgerMapping() } });
  const rec = redemption();
  const deferred = { to: rec.ethAddress, amount: "400" };
  b.applyReleaseOutcome(rec, { paid: "0xpaid", deferred }, "t");
  assert.equal(rec.status, "released");
  assert.deepEqual(rec.deferred, deferred);
  assert.match(b.lines.at(-1), /owed on the vault and claimable/);
});

test("a queued release waits with its execution time and block, and debits nothing", () => {
  const m = ledgerMapping("1000");
  const b = bridge({ mappings: { k: m } });
  const rec = redemption();
  b.applyReleaseOutcome(rec, { queued: 1_800_000_000, block: 1234 }, "t");
  assert.equal(rec.status, "queued");
  assert.equal(rec.executeAfter, new Date(1_800_000_000 * 1000).toISOString());
  assert.equal(rec.queuedBlock, 1234);
  assert.equal(m.sources[TOKEN_KEY].escrowedUnits, "1000");
  assert.equal(rec.escrowDebited, undefined);
});

test("a cancelled or discarded release stops for an operator and debits nothing", () => {
  for (const [o, status] of [
    [{ cancelled: true }, "release_cancelled"],
    [{ discarded: true }, "release_discarded"],
  ]) {
    const m = ledgerMapping("1000");
    const b = bridge({ mappings: { k: m } });
    const rec = redemption();
    b.applyReleaseOutcome(rec, o, "t");
    assert.equal(rec.status, status);
    assert.equal(m.sources[TOKEN_KEY].escrowedUnits, "1000");
    assert.equal(rec.releaseTxHash, undefined);
    assert.match(b.lines.at(-1), /an operator must decide/);
  }
});

test("a release paid by a CCTP burn is followed until claimed on the other chain", () => {
  const b = bridge({ mappings: { k: ledgerMapping() } });
  const rec = redemption({ destinationDomain: 6 });
  b.applyReleaseOutcome(rec, { paid: "0xburn", viaCctp: true }, "t");
  assert.equal(rec.status, "released");
  assert.equal(rec.viaCctp, true);
  assert.deepEqual(rec.cctpOut, { domain: 6, burnTx: "0xburn", stage: "attesting" });
});

test("a CCTP release to Solana defaults to domain 5 and names the owner", () => {
  const b = bridge({ mappings: { k: ledgerMapping() } });
  const owner = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM";
  const rec = redemption({ solAddress: owner });
  b.applyReleaseOutcome(rec, { paid: "0xburn", viaCctp: true }, "t");
  assert.deepEqual(rec.cctpOut, { domain: 5, burnTx: "0xburn", owner, stage: "attesting" });
  // An existing cctpOut (already being relayed) is never reset.
  rec.cctpOut.stage = "minted";
  b.applyReleaseOutcome(rec, { paid: "0xburn", viaCctp: true }, "t");
  assert.equal(rec.cctpOut.stage, "minted");
});

test("a release on a mapping without an escrow ledger is released without a debit", () => {
  // An ordinary bridged asset keeps no per-source ledger; its backing is the
  // vault balance itself.
  const plain = { assetId: ASSET, tokenKey: TOKEN_KEY };
  const b = bridge({ mappings: { k: plain } });
  const rec = redemption();
  b.applyReleaseOutcome(rec, { paid: "0xpaid" }, "t");
  assert.equal(rec.status, "released");
  assert.equal(b.halts.length, 0);
});

test("a release that drives the escrow ledger negative halts the asset", () => {
  const m = ledgerMapping("100");
  const b = bridge({ mappings: { k: m } });
  b.applyReleaseOutcome(redemption(), { paid: "0xpaid" }, "t");
  assert.equal(m.sources[TOKEN_KEY].escrowedUnits, "0");
  assert.equal(b.halts.length, 1);
  assert.equal(b.halts[0].assetId, ASSET);
  assert.equal(b.halts[0].scope, "all");
});

test("the mapping passed in wins over the asset-id lookup", () => {
  const routed = ledgerMapping("1000");
  const other = ledgerMapping("1000");
  const b = bridge({ mappings: { k: other } });
  b.applyReleaseOutcome(redemption(), { paid: "0xpaid" }, "t", routed);
  assert.equal(routed.sources[TOKEN_KEY].escrowedUnits, "600");
  assert.equal(other.sources[TOKEN_KEY].escrowedUnits, "1000");
});

// ----------------------------------------------------------------- refunds

const deposit = (extra = {}) => ({
  nonce: "7",
  status: "refunding",
  refundReason: "invalid Sequentia address",
  ethTx: { hash: "0x01" },
  waiting: "the vault does not hold enough of this token right now",
  ...extra,
});

test("a paid refund is refunded and keeps its first tx hash", () => {
  const b = bridge();
  const dep = deposit();
  b.applyRefundOutcome(dep, { paid: "0xrefund" }, "t");
  assert.equal(dep.status, "refunded");
  assert.equal(dep.refundTxHash, "0xrefund");
  assert.equal(dep.ethTx, undefined);
  assert.equal(dep.waiting, undefined);
  b.applyRefundOutcome(dep, { paid: "0xlater" }, "t");
  assert.equal(dep.refundTxHash, "0xrefund");
});

test("a refund the depositor refused is refunded and owed", () => {
  const b = bridge();
  const dep = deposit();
  b.applyRefundOutcome(dep, { paid: "0xrefund", deferred: { to: "0xabc", amount: "5" } }, "t");
  assert.equal(dep.status, "refunded");
  assert.deepEqual(dep.deferred, { to: "0xabc", amount: "5" });
});

test("a queued refund records when and where it was queued", () => {
  const b = bridge();
  const dep = deposit();
  b.applyRefundOutcome(dep, { queued: 1_800_000_000, block: 99 }, "t");
  assert.equal(dep.status, "refund_queued");
  assert.equal(dep.executeAfter, new Date(1_800_000_000 * 1000).toISOString());
  assert.equal(dep.queuedBlock, 99);
});

test("a cancelled or discarded refund stops for an operator", () => {
  for (const [o, status] of [
    [{ cancelled: true }, "refund_cancelled"],
    [{ discarded: true }, "refund_discarded"],
  ]) {
    const dep = deposit();
    bridge().applyRefundOutcome(dep, o, "t");
    assert.equal(dep.status, status);
    assert.equal(dep.refundTxHash, undefined);
  }
});

test("a CCTP refund is followed back to its source chain", () => {
  const evm = deposit({ cctp: { sourceDomain: 6, sender: "0x" + "11".repeat(32) } });
  bridge().applyRefundOutcome(evm, { paid: "0xburn" }, "t");
  assert.deepEqual(evm.cctpOut, { domain: 6, burnTx: "0xburn", stage: "attesting" });

  // From Solana (domain 5) the 32-byte sender is a base58 account, which the
  // relay needs as the mint's owner.
  const sol = deposit({ cctp: { sourceDomain: 5, sender: "0x" + "00".repeat(31) + "01" } });
  bridge().applyRefundOutcome(sol, { paid: "0xburn" }, "t");
  assert.equal(sol.cctpOut.domain, 5);
  assert.equal(sol.cctpOut.owner, "11111111111111111111111111111112");
});

// ------------------------------------------------------ reading the vault

/** A fake v3 vault: a queue entry and a set of emitted events by filter name. */
function vault({ state = 0, executeAfter = 0, events = {}, fail = null } = {}) {
  const asked = [];
  const filter = (name) => (...args) => ({ name, args });
  return {
    asked,
    queuedRelease: async (id) => {
      assert.equal(id, ID);
      return { state: BigInt(state), executeAfter: BigInt(executeAfter) };
    },
    filters: {
      ReleaseDeferred: filter("ReleaseDeferred"),
      ReleasedViaCctp: filter("ReleasedViaCctp"),
      RefundedViaCctp: filter("RefundedViaCctp"),
      Released: filter("Released"),
      Refunded: filter("Refunded"),
    },
    queryFilter: async (f, from) => {
      asked.push({ ...f, from });
      if (fail === f.name) throw new Error("rpc range unavailable");
      return events[f.name] ?? [];
    },
  };
}

const eth = (version = 3, head = 1_000_000) => ({
  vaultVersion: async () => version,
  provider: { getBlockNumber: async () => head },
});

test("an older vault has no queue: a processed payout was paid", async () => {
  const v = vault();
  v.queuedRelease = async () => assert.fail("a v2 vault has no queuedRelease");
  const o = await bridge({ eth: eth(2) }).settledOutcome(v, ID);
  assert.deepEqual(o, { paid: null });
});

test("the queue state decides queued, cancelled and discarded", async () => {
  const b = bridge({ eth: eth() });
  assert.deepEqual(await b.settledOutcome(vault({ state: 1, executeAfter: 1_800_000_000 }), ID), { queued: 1_800_000_000 });
  assert.deepEqual(await b.settledOutcome(vault({ state: 2 }), ID), { cancelled: true });
  assert.deepEqual(await b.settledOutcome(vault({ state: 4 }), ID), { discarded: true });
});

test("an executed payout the recipient refused reads as paid and owed", async () => {
  const v = vault({
    state: 3,
    events: { ReleaseDeferred: [{ transactionHash: "0xd", args: { to: "0xabc", amount: 42n } }], Released: [{ transactionHash: "0xr" }] },
  });
  const o = await bridge({ eth: eth() }).settledOutcome(v, ID, 500);
  assert.deepEqual(o, { paid: "0xd", deferred: { to: "0xabc", amount: "42" } });
  assert.equal(v.asked[0].from, 500);
});

test("a payout found as a CCTP burn is marked viaCctp; a plain one is not", async () => {
  const b = bridge({ eth: eth() });
  for (const [name, viaCctp] of [
    ["ReleasedViaCctp", true],
    ["RefundedViaCctp", true],
    ["Released", false],
    ["Refunded", false],
  ]) {
    const o = await b.settledOutcome(vault({ state: 3, events: { [name]: [{ transactionHash: `0x${name}` }] } }), ID, 1);
    assert.deepEqual(o, { paid: `0x${name}`, viaCctp }, name);
  }
});

test("a refund is looked up by its third indexed field, the refund id", async () => {
  const v = vault({ state: 0 });
  await bridge({ eth: eth() }).settledOutcome(v, ID, 1);
  const refunded = v.asked.find((a) => a.name === "Refunded");
  assert.deepEqual(refunded.args, [null, null, ID]);
  assert.deepEqual(v.asked.find((a) => a.name === "Released").args, [ID]);
});

test("a payout never queued with no event in range reads as paid, hash unknown", async () => {
  const o = await bridge({ eth: eth() }).settledOutcome(vault({ state: 0 }), ID, 1);
  assert.deepEqual(o, { paid: null });
});

test("without a starting block the lookback window is bounded by the head", async () => {
  const v = vault({ state: 3 });
  await bridge({ eth: eth(3, 1_000_000), cfg: { ethLookbackBlocks: 1000 } }).settledOutcome(v, ID);
  assert.ok(v.asked.every((a) => a.from === 999_000));
  const w = vault({ state: 3 });
  await bridge({ eth: eth(3, 10) }).settledOutcome(w, ID);
  assert.ok(w.asked.every((a) => a.from === 0), "never a negative block");
});

test("an unreadable event range is an error, never 'nothing found'", async () => {
  const b = bridge({ eth: eth() });
  await assert.rejects(b.settledOutcome(vault({ state: 3, fail: "Released" }), ID, 1), /rpc range unavailable/);
});
