import test from "node:test";
import assert from "node:assert/strict";
import { decodeRequest, takesFromRefusal, holdingOf, LeafDeposits } from "../lib/leaves.js";

const OP = "a".repeat(64);
const GEN = "b".repeat(64);
const ASSET = "c".repeat(64);
const encode = (v, prefix = "arca") => `${prefix}:${Buffer.from(JSON.stringify(v)).toString("hex")}`;
const request = (over = {}) =>
  encode({ kind: "request", operator: OP, genesis_hash: GEN, owner: "1".repeat(64), owner_nonce: "2".repeat(64), mailbox: "3".repeat(64), until: 10_000_000, ...over });

test("a receive request is read whatever its prefix, in its newer and older forms", () => {
  assert.equal(decodeRequest(request()).operator, OP);
  assert.equal(decodeRequest(request({}).replace(/^arca/, "request")).genesis_hash, GEN);
  const older = encode({ arca_request: 1, operator: OP, genesis_hash: GEN, owner: "1".repeat(64), owner_nonce: "2".repeat(64), mailbox: "3".repeat(64) });
  assert.equal(decodeRequest(older).owner, "1".repeat(64));
  assert.throws(() => decodeRequest("arca:zz"), /not hex/);
  assert.throws(() => decodeRequest(encode({ kind: "swap-offer" })), /not a receive request/);
  assert.throws(() => decodeRequest(request({ mailbox: "x" })), /no mailbox/);
  assert.throws(() => decodeRequest(":" + request().split(":")[1]), /no prefix/);
});

test("the margins come from the wallet's own refusal of an amount it cannot pay", () => {
  const m =
    "refused: the wallet holds 200000 of asset dd in live coins, and paying 200001 takes 200481 with the margins its transactions leave for their fees";
  assert.deepEqual(takesFromRefusal(m), { paid: 200001n, takes: 200481n });
  assert.equal(takesFromRefusal("the server refused"), null);
});

test("a balance's holdings of one asset, on the chain and by state", () => {
  const h = holdingOf({ arca: { [ASSET]: { live: "5", pending: "7" } }, sequentia_onchain: { [ASSET]: "11" } }, ASSET);
  assert.equal(h.total, 23n);
  assert.equal(h.onchain, 11n);
  assert.equal(holdingOf({}, ASSET).total, 0n);
});

// A wallet that answers as `arca` does, its coins in memory.
class FakeWallet {
  constructor() {
    this.coinsList = [];
    this.onchain = 0n;
    this.calls = [];
    this.medianTime = 1_000;
    this.sendBehaviour = "pay";
  }
  async info() {
    return { operator: OP, genesis: GEN, medianTime: this.medianTime, served: new Map([[ASSET, { asset: ASSET, min_leaf: "1000" }]]) };
  }
  async address() {
    return "ert1qleafwallet";
  }
  async balance() {
    return { arca: {}, sequentia_onchain: { [ASSET]: this.onchain.toString() } };
  }
  async coins() {
    return this.coinsList.map((c) => ({ ...c }));
  }
  async sync() {
    return { out: { schedule: { now: 1, next_sync_at: 100 } } };
  }
  async board(asset, atoms) {
    this.calls.push(["board", asset, String(atoms)]);
    this.onchain -= BigInt(atoms);
    const c = { leaf_id: `board${this.calls.length}`, kind: "board", asset, value: String(atoms), state: "pending", note: `waiting: ${"9".repeat(64)} is in_mempool` };
    this.coinsList.push(c);
    if (this.boardBehaviour === "lose-answer") return { error: { kind: "unreachable", message: "timed out" } };
    return { out: { txid: "9".repeat(64), leaf_id: c.leaf_id, value: c.value, state: "pending" } };
  }
  async send(request, atoms, asset) {
    this.calls.push(["send", String(atoms)]);
    const live = this.coinsList.filter((c) => c.asset === asset && c.state === "live");
    const total = live.reduce((a, c) => a + BigInt(c.value), 0n);
    if (BigInt(atoms) > total - 4n) {
      return { error: { kind: "refused", message: `refused: the wallet holds ${total} of asset ${asset} in live coins, and paying ${atoms} takes ${BigInt(atoms) + 4n} with the margins` } };
    }
    for (const c of live) {
      c.state = this.sendBehaviour === "unanswered" ? "sending" : "spent";
      c.spent_by = this.sendBehaviour === "unanswered" ? null : "transfer feed";
    }
    if (this.sendBehaviour === "lose-answer") return { error: { kind: "unreachable", message: "the daemon died" } };
    if (this.sendBehaviour === "unanswered") return { error: { kind: "unreachable", message: "no answer" } };
    return { out: { sent: { value: String(atoms) }, transfer: { transfer_id: "feed" } } };
  }
}

function harness() {
  const data = {
    deposits: {},
    leafIntents: {},
    mappings: { "31337:0xmusd": { assetId: ASSET, symbol: "MUSD", limiter: { coin: { txid: "l", vout: 0 } } } },
  };
  const bridge = {
    cfg: { leafWallet: { datadir: "/x" }, seqFeeAsset: "f".repeat(64) },
    state: { data, save() {} },
    log() {},
    limiter: {},
    withRecord: (k, f) => f(),
  };
  const wallet = new FakeWallet();
  const leaves = new LeafDeposits(bridge, wallet);
  return { data, bridge, wallet, leaves };
}

function intentAndDeposit(h, over = {}) {
  h.data.leafIntents["ert1qintent"] = {
    request: request(),
    operator: OP,
    genesis: GEN,
    owner: "1".repeat(64),
    until: 10_000_000,
    assetId: ASSET,
    symbol: "MUSD",
    fallback: { kind: "refund" },
    ...over,
  };
  const dep = { key: "7", tag: "deposit #7", seqAddress: "ert1qintent", sats: "2500000000", status: "minting", steps: {}, createdAt: "t" };
  h.data.deposits["7"] = dep;
  return dep;
}

test("a deposit to a payable request goes the leaf's way, and the request is then used", async () => {
  const h = harness();
  const dep = intentAndDeposit(h);
  assert.equal(await h.leaves.decide(dep, h.data.mappings["31337:0xmusd"]), "leaf");
  assert.equal(h.data.leafIntents["ert1qintent"].usedBy, "7");
  const dep2 = { key: "8", tag: "deposit #8", seqAddress: "ert1qintent", sats: "100000", status: "minting", steps: {} };
  assert.equal(await h.leaves.decide(dep2, h.data.mappings["31337:0xmusd"]), "fallback");
  assert.equal(dep2.status, "refund_pending");
  assert.match(dep2.refundReason, /already used by 7/);
});

test("a request too close to its lapse when the deposit lands takes the stated fallback address", async () => {
  const h = harness();
  const dep = intentAndDeposit(h, { until: 1_000 + 3600, fallback: { kind: "address", address: "ert1qfallback" } });
  assert.equal(await h.leaves.decide(dep, h.data.mappings["31337:0xmusd"]), "fallback");
  assert.equal(dep.seqAddress, "ert1qfallback");
  assert.equal(dep.status, "minting"); // goes on to the ordinary on-chain delivery
  assert.match(dep.leaf.fallbackReason, /too soon/);
});

async function mintedDeposit(h) {
  const dep = intentAndDeposit(h);
  await h.leaves.decide(dep, h.data.mappings["31337:0xmusd"]);
  dep.assetId = ASSET;
  h.leaves.minted(dep);
  h.wallet.onchain = 2_500_000_000n;
  return dep;
}

test("a board whose answer was lost is found in the wallet, never made twice", async () => {
  const h = harness();
  const dep = await mintedDeposit(h);
  h.wallet.boardBehaviour = "lose-answer";
  await h.leaves.step(dep);
  assert.equal(dep.status, "leaf_boarding");
  assert.equal(dep.steps.leafBoard.leafId, "board1");
  assert.equal(h.wallet.calls.filter((c) => c[0] === "board").length, 1);
  // A crash after the marker and before the answer: the restart looks first.
  const h2 = harness();
  const dep2 = await mintedDeposit(h2);
  dep2.steps.pendingLeafBoard = { at: "t", boardsBefore: [] };
  h2.wallet.coinsList.push({ leaf_id: "boardX", kind: "board", asset: ASSET, value: "2500000000", state: "pending", note: "" });
  await h2.leaves.step(dep2);
  assert.equal(dep2.steps.leafBoard.leafId, "boardX");
  assert.equal(h2.wallet.calls.length, 0);
});

test("the payment takes the coin whole, its margins out of it", async () => {
  const h = harness();
  const dep = await mintedDeposit(h);
  await h.leaves.step(dep); // board
  h.wallet.coinsList[0].state = "live";
  await h.leaves.step(dep); // live, then paid
  assert.equal(dep.status, "minted");
  assert.deepEqual([dep.leaf.paid.value, dep.leaf.paid.margins], ["2499999996", "4"]);
  assert.deepEqual(h.wallet.calls.filter((c) => c[0] === "send").map((c) => c[1]), ["2500000001", "2499999996"]);
});

test("a payment the wallet made and the daemon never recorded is found, not made again", async () => {
  const h = harness();
  const dep = await mintedDeposit(h);
  await h.leaves.step(dep);
  h.wallet.coinsList[0].state = "live";
  h.wallet.sendBehaviour = "lose-answer"; // paid, the answer lost
  await h.leaves.step(dep);
  assert.equal(dep.status, "minted");
  assert.equal(dep.steps.leafPay.transferId, "feed");
  // And after a crash with the marker standing: the coin spent by a transfer.
  const h2 = harness();
  const d2 = await mintedDeposit(h2);
  await h2.leaves.step(d2);
  h2.wallet.coinsList[0].state = "spent";
  h2.wallet.coinsList[0].spent_by = "transfer abc123";
  d2.status = "leaf_paying";
  d2.steps.pendingLeafPay = { at: "t", value: "2499999996", margins: "4" };
  await h2.leaves.step(d2);
  assert.equal(d2.status, "minted");
  assert.equal(d2.steps.leafPay.transferId, "abc123");
  assert.equal(h2.wallet.calls.filter((c) => c[0] === "send").length, 0);
});

test("a payment posted and unanswered waits for the wallet's sync; a coin still live is paid", async () => {
  const h = harness();
  const dep = await mintedDeposit(h);
  await h.leaves.step(dep);
  h.wallet.coinsList[0].state = "live";
  h.wallet.sendBehaviour = "unanswered";
  await h.leaves.step(dep);
  assert.equal(dep.status, "leaf_paying");
  assert.ok(dep.steps.pendingLeafPay);
  assert.match(dep.waiting, /posted and unanswered/);
  // The coin is back to live (the operator refused, say): paid afresh.
  h.wallet.coinsList[0].state = "live";
  h.wallet.sendBehaviour = "pay";
  await h.leaves.step(dep);
  assert.equal(dep.status, "minted");
});

test("a request lapsed by the time the board is final holds the leaf for the deposit", async () => {
  const h = harness();
  const dep = await mintedDeposit(h);
  await h.leaves.step(dep);
  h.wallet.coinsList[0].state = "live";
  h.wallet.medianTime = 10_000_000;
  await h.leaves.step(dep);
  assert.equal(dep.status, "leaf_held");
  assert.match(dep.leaf.heldReason, /lapsed/);
  assert.equal(h.leaves.problems()[0].key, "leaf:held");
  const f = await h.leaves.figures(ASSET);
  assert.equal(f.owedAtoms, "2500000000");
});

test("an operator pays a held leaf into a new request of the depositor's, checked first", async () => {
  const h = harness();
  const dep = await mintedDeposit(h);
  await h.leaves.step(dep);
  h.wallet.coinsList[0].state = "live";
  h.wallet.medianTime = 10_000_000;
  await h.leaves.step(dep);
  assert.equal(dep.status, "leaf_held");
  await assert.rejects(h.leaves.repay("7", request({ until: 10_000_100 })), /too soon/);
  await assert.rejects(h.leaves.repay("7", request({ operator: "e".repeat(64), until: 20_000_000 })), /another operator/);
  await assert.rejects(h.leaves.repay("8", request({ until: 20_000_000 })), /no deposit holds a leaf/);
  const r = await h.leaves.repay("7", request({ owner: "4".repeat(64), until: 20_000_000 }));
  assert.equal(r.status, "minted");
  assert.equal(dep.leaf.owner, "4".repeat(64));
  assert.equal(dep.leaf.paid.value, "2499999996");
});

test("the leaf wallet's fee coins are topped up from the bridge's own fee asset, waiting for a top-up to confirm", async () => {
  const h = harness();
  const FEE = "f".repeat(64);
  const sent = [];
  let confirmations = 0;
  h.bridge.cfg.leafWallet.feeCheckMs = 0;
  h.bridge.limiter = { feeAtoms: async (v) => v }; // 1 atom a vbyte
  h.bridge.seq = {
    node: async () => ({}),
    call: async (m, p) => {
      if (m === "sendtoaddress") {
        sent.push(p);
        return `tx${sent.length}`;
      }
      if (m === "gettransaction") return { confirmations };
      throw new Error(m);
    },
  };
  h.wallet.balance = async () => ({ sequentia_onchain: { [FEE]: "10000" } });
  await h.leaves.topUpFees(); // 10,000 < a quarter of 50 x 1,000: topped up to 50,000
  assert.equal(sent.length, 1);
  assert.equal(sent[0].amount, "0.00040000");
  assert.equal(sent[0].assetlabel, FEE);
  await h.leaves.topUpFees(); // the top-up is not confirmed: waits
  assert.equal(sent.length, 1);
  confirmations = 1;
  h.wallet.balance = async () => ({ sequentia_onchain: { [FEE]: "50000" } });
  await h.leaves.topUpFees(); // enough now
  assert.equal(sent.length, 1);
  h.bridge.cfg.leafWallet.feeAsset = "e".repeat(64);
  const other = new LeafDeposits(h.bridge, h.wallet);
  other.c.feeCheckMs = 0;
  h.wallet.balance = async () => ({ sequentia_onchain: {} });
  await other.topUpFees(); // another fee asset than the bridge's: its operator funds it
  assert.equal(sent.length, 1);
});
