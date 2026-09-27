// Push alerts: one message per condition per cooldown, one "resolved" note
// when it clears, and delivery failures that never break the caller.
// Run: npm test
import test from "node:test";
import assert from "node:assert/strict";
import { Alerts } from "../lib/alerts.js";

const MIN = 60_000;

/** Alerts with a fake clock and a fetch that records every post. */
function setup(t, cfg = { alertUrl: "https://ntfy.example/topic", alertCooldownMinutes: 60 }, fetchImpl = null) {
  t.mock.timers.enable({ apis: ["Date"], now: 1_000_000 });
  const posts = [];
  t.mock.method(globalThis, "fetch", async (url, opts) => {
    posts.push({ url, ...opts });
    if (fetchImpl) return fetchImpl(url, opts);
    return new Response("ok");
  });
  const lines = [];
  const alerts = new Alerts(cfg, (m) => lines.push(m));
  return { alerts, posts, lines, tick: (ms) => t.mock.timers.tick(ms) };
}

test("the same key is sent once per cooldown while it stays active", async (t) => {
  const { alerts, posts, tick } = setup(t);
  await alerts.raise("k", "eth scan failing", "details");
  await alerts.raise("k", "eth scan failing", "details");
  tick(59 * MIN);
  await alerts.raise("k", "eth scan failing", "details");
  assert.equal(posts.length, 1);
  tick(1 * MIN);
  await alerts.raise("k", "eth scan failing", "details");
  assert.equal(posts.length, 2, "sent again once the cooldown has passed");
});

test("different keys are independent", async (t) => {
  const { alerts, posts } = setup(t);
  await alerts.raise("a", "A", "x");
  await alerts.raise("b", "B", "y");
  await alerts.raise("a", "A", "x");
  assert.deepEqual(
    posts.map((p) => p.headers.Title),
    ["Compages: A", "Compages: B"]
  );
});

test("the post carries title, priority, tags and the token in ntfy's form", async (t) => {
  const { alerts, posts } = setup(t, { alertUrl: "https://ntfy.example/topic", alertToken: "tk" });
  await alerts.raise("k", "vault short", "the vault holds less than it owes", { priority: 5, tags: ["rotating_light", "money"] });
  assert.equal(posts[0].url, "https://ntfy.example/topic");
  assert.equal(posts[0].method, "POST");
  assert.equal(posts[0].body, "the vault holds less than it owes");
  assert.deepEqual(posts[0].headers, {
    Title: "Compages: vault short",
    Priority: "5",
    Tags: "rotating_light,money",
    Authorization: "Bearer tk",
  });
});

test("defaults: priority 4, a warning tag, no token header, a 6-hour cooldown", async (t) => {
  const { alerts, posts, tick } = setup(t, { alertUrl: "https://ntfy.example/topic" });
  await alerts.raise("k", "T", "m");
  assert.deepEqual(posts[0].headers, { Title: "Compages: T", Priority: "4", Tags: "warning" });
  tick(359 * MIN);
  await alerts.raise("k", "T", "m");
  assert.equal(posts.length, 1);
  tick(MIN);
  await alerts.raise("k", "T", "m");
  assert.equal(posts.length, 2);
});

test("a long title is cut to what a header can carry", async (t) => {
  const { alerts, posts } = setup(t);
  await alerts.raise("k", "x".repeat(1000), "m");
  assert.equal(posts[0].headers.Title.length, 250);
});

test("settle sends one resolved note per cleared key and keeps the rest", async (t) => {
  const { alerts, posts, lines } = setup(t);
  await alerts.raise("gone", "Gone", "x");
  await alerts.raise("stays", "Stays", "y");
  posts.length = 0;
  await alerts.settle(new Set(["stays"]));
  assert.equal(posts.length, 1);
  assert.equal(posts[0].headers.Title, "Compages: Resolved: Gone");
  assert.equal(posts[0].headers.Priority, "2");
  assert.ok(lines.includes("RESOLVED Gone"));
  await alerts.settle(new Set(["stays"]));
  assert.equal(posts.length, 1, "resolved only once");
  // The still-active key keeps its cooldown.
  await alerts.raise("stays", "Stays", "y");
  assert.equal(posts.length, 1);
});

test("a key raised again after it resolved is sent at once", async (t) => {
  const { alerts, posts } = setup(t);
  await alerts.raise("k", "K", "x");
  await alerts.settle(new Set());
  await alerts.raise("k", "K", "x");
  assert.equal(posts.filter((p) => p.headers.Title === "Compages: K").length, 2);
});

test("without an alertUrl alerts go to the log only", async (t) => {
  const { alerts, posts, lines } = setup(t, {});
  await alerts.raise("k", "T", "m");
  await alerts.settle(new Set());
  assert.equal(posts.length, 0);
  assert.deepEqual(lines, ["ALERT T: m", "RESOLVED T"]);
});

test("a delivery failure is logged, never thrown", async (t) => {
  const { alerts, posts, lines } = setup(t, undefined, async () => {
    throw new Error("connection refused");
  });
  await alerts.raise("k", "T", "m");
  assert.equal(posts.length, 1);
  assert.ok(lines.some((l) => l === "alert delivery failed: connection refused"));
});
