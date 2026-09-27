// Which consolidations the daemon lists for a reserve snapshot: every one
// whose burn has left the treasury, in flight or finished within the window,
// so a snapshot at a past height can find what was in flight then.
// Run: npm test
import test from "node:test";
import assert from "node:assert/strict";
import { Cctp } from "../lib/cctp.js";

const hoursAgo = (h) => new Date(Date.now() - h * 3600_000).toISOString();
const rec = (id, stage, extra = {}) => ({ id, assetId: "usdc", amount: "1000000", stage, burn: { signature: `sig-${id}` }, ...extra });
const records = {
  a: rec("a", "burning"),
  b: rec("b", "attesting"),
  c: rec("c", "relaying", { nonce: "0xc0" }),
  d: rec("d", "done", { nonce: "0xd0", doneAt: hoursAgo(2) }),
  e: rec("e", "done", { nonce: "0xe0", doneAt: hoursAgo(24 * 8) }),
  f: rec("f", "done", { assetId: "eurc", doneAt: hoursAgo(1) }),
  g: { id: "g", assetId: "usdc", amount: "1", stage: "burning" },
};
const recent = (withinMs) => Cctp.prototype.recentTransfers.call({ records }, "usdc", withinMs);

test("in-flight and recently finished transfers of the asset are listed, with burn and nonce", () => {
  assert.deepEqual(
    recent().map((t) => [t.id, t.stage, t.solanaBurn, t.nonce]),
    [
      ["b", "attesting", "sig-b", null],
      ["c", "relaying", "sig-c", "0xc0"],
      ["d", "done", "sig-d", "0xd0"],
    ]
  );
});

test("the window bounds finished transfers only", () => {
  assert.deepEqual(recent(3600_000).map((t) => t.id), ["b", "c"]);
});
