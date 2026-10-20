import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { limiterProblems, limiterSlots, shouldBrake } from "../lib/checks.js";
import { parseDescriptor, derive } from "../vendor/sequentia-address.mjs";

const VENDOR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "vendor");
const read = (f) => fs.readFileSync(path.join(VENDOR, f), "utf8");

test("the vendored mirror and descriptor are the pinned sequentia-contracts files", () => {
  const pin = JSON.parse(read("PIN.json"));
  for (const [file, { sha256 }] of Object.entries(pin.files)) {
    assert.equal(crypto.createHash("sha256").update(fs.readFileSync(path.join(VENDOR, file))).digest("hex"), sha256, file);
  }
});

test("the watcher derives every golden vector's script, from state as the daemon reports it", () => {
  const d = parseDescriptor(read("mint_limiter.descriptor.json"));
  const { addresses } = JSON.parse(read("mint_limiter.vectors.json"));
  assert.ok(addresses.length >= 4);
  for (const v of addresses) {
    const state = { minted: BigInt("0x" + v.slots.MINTED).toString(), elapsed: parseInt(v.slots.ELAPSED, 16), armed: parseInt(v.slots.ARMED, 16) };
    assert.deepEqual(limiterSlots(state), v.slots, v.name);
    assert.equal(derive(d, v.params, limiterSlots(state)).script_pubkey, v.script_pubkey, v.name);
  }
});

const view = {
  coin: { txid: "aa".repeat(32), vout: 0 },
  state: { minted: "100", elapsed: 3, armed: 0 },
  tokenId: "bb".repeat(32),
  braked: false,
  recovered: null,
};
const coin = { scriptpubkey: "5120" + "cc".repeat(32), asset: "bb".repeat(32), value: 100000000 };
const ok = { coin, expectedScript: coin.scriptpubkey, tokenSupply: 100000000n };

test("a limiter holding the whole token at the derived script raises nothing", () => {
  assert.deepEqual(limiterProblems("A", "MUSD.e", view, ok), []);
});

test("token units outside the limiter are critical and pull the brake", () => {
  const p = limiterProblems("A", "MUSD.e", view, { ...ok, tokenSupply: 200000000n });
  assert.equal(p.length, 1);
  assert.equal(p[0].key, "limiter:outside:A");
  assert.ok(shouldBrake(p[0]));
});

test("a coin that is not the instance in the reported state is critical", () => {
  const p = limiterProblems("A", "MUSD.e", view, { ...ok, expectedScript: "5120" + "dd".repeat(32) });
  assert.deepEqual(p.map((x) => x.key), ["limiter:script:A"]);
  assert.ok(shouldBrake(p[0]));
});

test("a coin of another asset is critical", () => {
  const p = limiterProblems("A", "MUSD.e", view, { ...ok, coin: { ...coin, asset: "ee".repeat(32) } });
  assert.ok(p.some((x) => x.key === "limiter:asset:A"));
});

test("the brake and a recovery are reported and pull no brake of the watcher's own", () => {
  const b = limiterProblems("A", "MUSD.e", { ...view, braked: true }, ok);
  assert.deepEqual(b.map((x) => x.key), ["limiter:brake:A"]);
  assert.equal(shouldBrake(b[0]), false);
  const r = limiterProblems("A", "MUSD.e", { ...view, recovered: { txid: "ff" } }, ok);
  assert.deepEqual(r.map((x) => x.key), ["limiter:recovered:A"]);
  assert.equal(shouldBrake(r[0]), false);
});

test("a spent coin the daemon still names is reported once it has been so for a while", () => {
  assert.deepEqual(limiterProblems("A", "MUSD.e", view, { ...ok, spentBy: "99", spentForMs: 60_000 }), []);
  const p = limiterProblems("A", "MUSD.e", view, { ...ok, spentBy: "99", spentForMs: 20 * 60_000 });
  assert.deepEqual(p.map((x) => x.key), ["limiter:stale:A"]);
});

test("an unread side gives no verdict on it", () => {
  assert.deepEqual(limiterProblems("A", "MUSD.e", view, { coin: null, expectedScript: null, tokenSupply: null }), []);
});
