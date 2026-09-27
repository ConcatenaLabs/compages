// The API's own logic: an operator's decisions on stopped records, per-client
// rate limits, and the redaction of RPC URLs from what the public API returns.
// Run: npm test
import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { startApi, resolveRecord, RateLimiter, clientIpOf, ipv6Prefix64, scrub } from "../lib/api.js";

// ------------------------------------------------------------ resolveRecord

function stateWith(group, key, record) {
  const s = { data: { deposits: {}, solDeposits: {}, redemptions: {}, solRedemptions: {}, [group]: { [key]: record } }, saves: 0 };
  s.save = () => s.saves++;
  return s;
}
const quiet = () => {};
const resolve = (group, record, action, body = {}) => {
  const state = stateWith(group, "k", record);
  const r = resolveRecord(state, quiet, group, "k", action, body);
  return { r, state };
};

test("retrying a deposit on its way back to the depositor keeps it on the refund path", () => {
  // Minting it instead, while the refund may still be reinstated on the
  // vault, would pay the depositor on both chains.
  for (const status of ["refund_manual", "refund_cancelled", "refund_discarded", "refunding", "refund_queued"]) {
    const { r } = resolve("deposits", { status, steps: { mintTxid: "aa" } }, "retry");
    assert.equal(r.status, "refund_pending", status);
  }
});

test("retrying a deposit resumes at the step it reached", () => {
  assert.equal(resolve("deposits", { status: "mint_manual" }, "retry").r.status, "mint_retry");
  assert.equal(resolve("deposits", { status: "send_manual", steps: { issueTxid: "aa" } }, "retry").r.status, "send_retry");
  assert.equal(resolve("solDeposits", { status: "send_manual", steps: { mintTxid: "bb" } }, "retry").r.status, "send_retry");
});

test("a retry clears the failure bookkeeping and every in-flight marker", () => {
  const rec = {
    status: "mint_manual",
    error: "boom",
    nextAttemptAt: 5,
    firstFailureAt: 1,
    attempts: 9,
    steps: {
      pendingIssue: 1,
      pendingMint: 1,
      pendingSend: 1,
      issueCandidate: "x",
      mintCandidate: "y",
      sendCandidate: "z",
      escrowCredited: true,
    },
  };
  const { r, state } = resolve("deposits", rec, "retry", { note: "checked the chain" });
  assert.equal(r.error, undefined);
  assert.equal(r.nextAttemptAt, undefined);
  assert.equal(r.firstFailureAt, undefined);
  assert.equal(r.attempts, 0);
  assert.deepEqual(r.steps, { escrowCredited: true }, "only the in-flight markers go");
  assert.equal(state.saves, 1);
  assert.deepEqual(
    { ...state.data.adminLog[0], at: undefined },
    { at: undefined, group: "deposits", key: "k", action: "retry", from: "mint_manual", to: "mint_retry", note: "checked the chain" }
  );
});

test("retrying a reorged delivery forgets the delivery that no longer exists", () => {
  const { r } = resolve(
    "deposits",
    { status: "delivery_reorged", deliveryFinal: true, steps: { mintTxid: "aa", sendTxid: "bb" } },
    "retry"
  );
  assert.equal(r.steps.sendTxid, undefined);
  assert.equal(r.deliveryFinal, undefined);
  assert.equal(r.status, "send_retry");
});

test("retrying a redemption restarts it, or its destroy step", () => {
  assert.equal(resolve("redemptions", { status: "release_manual" }, "retry").r.status, "new");
  const { r } = resolve("solRedemptions", { status: "destroy_manual", pendingDestroy: 1, burn: {} }, "retry");
  assert.equal(r.status, "destroy_pending");
  assert.equal(r.pendingDestroy, undefined);
  assert.equal(r.burn, undefined);
});

test("mark_delivered needs a txid and applies to deposits only", () => {
  const txid = "ab".repeat(32);
  const { r } = resolve("deposits", { status: "unresolved", steps: { pendingSend: 1, sendCandidate: "c" } }, "mark_delivered", { txid });
  assert.equal(r.status, "minted");
  assert.deepEqual(r.steps, { sendTxid: txid });
  assert.throws(() => resolve("deposits", { status: "unresolved" }, "mark_delivered", { txid: "nope" }), (e) => e.status === 400);
  assert.throws(() => resolve("redemptions", { status: "x" }, "mark_delivered", { txid }), (e) => e.status === 400 && /unknown action/.test(e.message));
});

test("retire records the note and leaves the status alone", () => {
  const { r } = resolve("redemptions", { status: "release_manual" }, "retire", { note: "paid by hand" });
  assert.equal(r.status, "release_manual");
  assert.equal(r.retired.note, "paid by hand");
});

test("unknown groups, missing keys and inherited properties are 404", () => {
  const state = stateWith("deposits", "k", { status: "x" });
  for (const [group, key] of [
    ["mappings", "k"],
    ["deposits", "missing"],
    ["deposits", "__proto__"],
    ["deposits", "toString"],
  ]) {
    assert.throws(() => resolveRecord(state, quiet, group, key, "retry", {}), (e) => e.status === 404, `${group}/${key}`);
  }
  assert.equal(state.saves, 0);
});

// ---------------------------------------------------------- rate limiting

test("a bucket allows exactly `limit` calls per window, then refuses", () => {
  const l = new RateLimiter();
  const t0 = 1_000_000;
  for (let i = 0; i < 3; i++) assert.equal(l.over("intent:1.2.3.4", 3, t0 + i), false);
  assert.equal(l.over("intent:1.2.3.4", 3, t0 + 10), true);
  // A fresh window starts only once the hour has fully passed.
  assert.equal(l.over("intent:1.2.3.4", 3, t0 + 3_600_000), true);
  assert.equal(l.over("intent:1.2.3.4", 3, t0 + 3_600_001), false);
});

test("buckets and clients are counted apart", () => {
  const l = new RateLimiter();
  assert.equal(l.over("intent:a", 1), false);
  assert.equal(l.over("intent:a", 1), true);
  assert.equal(l.over("read:a", 1), false, "reads do not spend the intent allowance");
  assert.equal(l.over("intent:b", 1), false, "another client has its own");
});

test("memory stays bounded under a flood of distinct clients", () => {
  const l = new RateLimiter({ maxKeys: 100 });
  for (let i = 0; i < 1000; i++) l.over(`intent:${i}`, 5);
  assert.ok(l.hits.size <= 100);
});

const req = (remoteAddress, xff) => ({ socket: { remoteAddress }, headers: xff === undefined ? {} : { "x-forwarded-for": xff } });

test("the client is the socket peer unless a trusted proxy names it", () => {
  assert.equal(clientIpOf(req("10.0.0.1", "6.6.6.6")), "10.0.0.1", "X-Forwarded-For is ignored by default");
  assert.equal(clientIpOf(req("127.0.0.1", "6.6.6.6, 10.0.0.1"), true), "6.6.6.6", "the first hop is the client");
  assert.equal(clientIpOf(req("127.0.0.1", " 6.6.6.6 "), true), "6.6.6.6");
  assert.equal(clientIpOf(req("127.0.0.1", ""), true), "127.0.0.1", "no header: the peer");
  assert.equal(clientIpOf(req("127.0.0.1"), true), "127.0.0.1");
  assert.equal(clientIpOf({ socket: {}, headers: {} }), "unknown");
});

test("an IPv4-mapped peer is its own client, not a /64", () => {
  assert.equal(clientIpOf(req("::ffff:1.2.3.4")), "::ffff:1.2.3.4");
});

test("every address of one IPv6 /64 is one client", () => {
  const key = (ip) => clientIpOf(req(ip));
  assert.equal(key("2a01:4f8:c17:1234::5"), "2a01:4f8:c17:1234::/64");
  assert.equal(key("2a01:4f8:c17:1234:1:2:3:4"), "2a01:4f8:c17:1234::/64");
  assert.notEqual(key("2a01:4f8:c17:1235::5"), key("2a01:4f8:c17:1234::5"));
  // Via a trusted proxy too, in whatever case it writes hex.
  assert.equal(clientIpOf(req("127.0.0.1", "2A01:4F8:C17:1234::9"), true), "2a01:4f8:c17:1234::/64");
});

test("a /64 whose prefix has a compressed zero run is still one client", () => {
  // Regression: splitting the compressed text on ":" gave each host of
  // 2001:db8:0:0::/64 its own bucket, so the limit did not hold there.
  const key = (ip) => clientIpOf(req(ip));
  const want = "2001:db8:0:0::/64";
  for (const ip of ["2001:db8::1", "2001:db8::2", "2001:db8::a:b:c:d", "2001:db8::b:b:c:d", "2001:db8:0:0:ffff::1", "2001:0db8:0000:0000:0:0:0:7"]) {
    assert.equal(key(ip), want, ip);
  }
  assert.equal(key("::1"), "0:0:0:0::/64");
  assert.equal(key("fe80::1%eth0"), "fe80:0:0:0::/64");
});

test("text that is not an IPv6 address is left as it is", () => {
  assert.equal(ipv6Prefix64("1::2::3"), null);
  assert.equal(ipv6Prefix64("1:2:3"), null);
  assert.equal(ipv6Prefix64("zzzz::1"), null);
  assert.equal(clientIpOf(req("127.0.0.1", "garbage:value"), true), "garbage:value");
});

// ------------------------------------------------------------------ scrub

test("URLs are removed from every error-like field, at any depth", () => {
  const key = "https://eth-sepolia.g.alchemy.com/v2/SECRETKEY";
  const out = scrub({
    error: `request timeout (info={ "requestUrl": "${key}" })`,
    phases: { eth: { lastError: `could not reach ${key}; retrying`, lastOk: 5 } },
    problems: [{ title: "eth has not succeeded", detail: `fetch ${key}` }],
    waiting: "rpc http://user:pass@10.0.0.1:18884/wallet/x failed",
    reason: ["wss://node.example/ws?token=abc", "no url here"],
    finality: `node at http://127.0.0.1:18892 did not answer`,
  });
  const text = JSON.stringify(out);
  for (const secret of ["SECRETKEY", "user:pass", "token=abc", "127.0.0.1:18892"]) assert.ok(!text.includes(secret), secret);
  assert.equal(out.error, 'request timeout (info={ "requestUrl": "<url>" })');
  assert.equal(out.phases.eth.lastError, "could not reach <url>; retrying");
  assert.equal(out.phases.eth.lastOk, 5);
  assert.deepEqual(out.reason, ["<url>", "no url here"]);
});

test("fields that are not error text keep their URLs", () => {
  const v = { explorer: "https://sequentiatestnet.com/explorer/tx/ab", note: "see https://x.y", title: "t" };
  assert.deepEqual(scrub(v), v);
  assert.equal(scrub("https://top.level/string"), "https://top.level/string");
});

test("non-string values pass through scrub unchanged", () => {
  const v = { error: null, detail: 5, lastError: false, waiting: undefined, list: [1, "a"], n: 0 };
  assert.deepEqual(scrub(v), v);
});

// ---------------------------------------------- the limits, over HTTP

test("the heavy-read limit covers health and seqaddress too", async (t) => {
  // Regression: /api/health and /api/seqaddress were answered before the
  // read limit was checked, so the limit never applied to them.
  let healthCalls = 0;
  let addressCalls = 0;
  const bridge = {
    health: async () => (healthCalls++, { status: "ok", problems: [] }),
    checkSeqAddress: async () => (addressCalls++, { valid: true }),
  };
  const state = { data: { mappings: {} }, save() {} };
  const server = startApi({ apiPort: 0, apiHost: "127.0.0.1", readLimitPerHour: 2 }, {}, {}, state, bridge, () => {});
  t.after(() => server.close());
  await once(server, "listening");
  const base = `http://127.0.0.1:${server.address().port}/api`;
  const codes = async (p, n) => {
    const out = [];
    for (let i = 0; i < n; i++) out.push((await fetch(`${base}/${p}`)).status);
    return out;
  };
  assert.deepEqual(await codes("health", 3), [200, 200, 429]);
  assert.equal(healthCalls, 2, "a limited request costs the node nothing");
  // The bucket is per client, shared by every heavy read.
  assert.deepEqual(await codes("seqaddress/tb1qexample", 1), [429]);
  assert.equal(addressCalls, 0);
});
