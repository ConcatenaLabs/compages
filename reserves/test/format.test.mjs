// Canonical JSON, signing and the hash chain.
// Run: npm test
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { ethers } from "ethers";
import {
  canonicalize,
  payloadHash,
  sha256hex,
  signingMessage,
  signSnapshot,
  verifySnapshot,
  verifyChain,
  checkLink,
  buildIndex,
  parseIndex,
} from "../lib/format.mjs";

// A throwaway key made for the test; it attests to nothing.
const key = ethers.Wallet.createRandom();
const other = ethers.Wallet.createRandom();

const payload = (height, previous, extra = {}) => ({
  height,
  previous,
  createdAt: "2026-01-01T00:00:00.000Z",
  attester: key.address,
  assets: [{ assetId: "ab".repeat(32), supply: { circulatingAtoms: "20000000", exact: true }, escrowAtoms: "20000000", backed: true }],
  ...extra,
});

async function history(n) {
  const out = [];
  let prev = null;
  for (let i = 1; i <= n; i++) {
    const s = await signSnapshot(payload(i * 1440, prev), key);
    out.push(s);
    prev = { height: s.payload.height, hash: s.hash };
  }
  return out;
}

test("canonical JSON sorts keys at every depth and has no whitespace", () => {
  const a = { b: 1, a: { d: [3, { z: null, y: true }], c: "x" } };
  const b = { a: { c: "x", d: [3, { y: true, z: null }] }, b: 1 };
  assert.equal(canonicalize(a), '{"a":{"c":"x","d":[3,{"y":true,"z":null}]},"b":1}');
  assert.equal(canonicalize(a), canonicalize(b));
  assert.equal(payloadHash(a), payloadHash(b));
});

test("canonical JSON keeps array order: order in a list is meaning", () => {
  assert.notEqual(canonicalize([1, 2]), canonicalize([2, 1]));
});

test("canonical JSON refuses values that could serialize two ways", () => {
  for (const v of [1.5, NaN, Infinity, 2 ** 60, 10n, undefined, () => 0, new Date(0), { a: undefined }]) {
    assert.throws(() => canonicalize(v), TypeError, String(v));
  }
  assert.equal(canonicalize(-0), "0");
  assert.equal(canonicalize("é\n\"\\"), JSON.stringify("é\n\"\\"));
});

test("jq -cS reproduces the canonical bytes, so a verifier needs no JavaScript", (t) => {
  try {
    execFileSync("jq", ["--version"]);
  } catch {
    return t.skip("jq is not installed");
  }
  const p = payload(1440, null, { note: "Solana's RPC — é", n: 9007199254740991, neg: -5, list: [{ b: 2, a: 1 }] });
  const viaJq = execFileSync("jq", ["-cS", "."], { input: JSON.stringify(p, null, 3) }).toString().trimEnd();
  assert.equal(viaJq, canonicalize(p));
  assert.equal(sha256hex(viaJq), payloadHash(p));
});

test("a signed snapshot verifies with ethers.verifyMessage alone", async () => {
  const s = await signSnapshot(payload(1440, null), key);
  assert.equal(s.hash, payloadHash(s.payload));
  assert.equal(s.signature.message, signingMessage(1440, s.hash));
  assert.equal(ethers.verifyMessage(s.signature.message, s.signature.signature), key.address);
  const v = verifySnapshot(s, { attester: key.address });
  assert.deepEqual(v.errors, []);
  assert.equal(v.signer, key.address);
});

test("signing refuses a payload that names another attester", async () => {
  await assert.rejects(signSnapshot(payload(1440, null), other), /names attester/);
});

test("any change to a signed snapshot is caught", async () => {
  const s = await signSnapshot(payload(1440, null), key);
  const edit = (f) => {
    const c = structuredClone(s);
    f(c);
    return verifySnapshot(c, { attester: key.address });
  };
  // A figure changed: the hash no longer matches.
  assert.match(edit((c) => (c.payload.assets[0].escrowAtoms = "99000000")).errors.join(), /does not match the payload/);
  // The figure and the hash field changed together: the signed message no longer matches.
  assert.match(
    edit((c) => {
      c.payload.assets[0].escrowAtoms = "99000000";
      c.hash = payloadHash(c.payload);
    }).errors.join(),
    /signed message/
  );
  // Everything rebuilt and re-signed by another key: not the attester.
  const forged = structuredClone(s);
  forged.payload.attester = other.address;
  forged.payload.assets[0].escrowAtoms = "99000000";
  const reSigned = await signSnapshot(forged.payload, other);
  assert.equal(verifySnapshot(reSigned).ok, true, "intact on its own terms");
  assert.match(verifySnapshot(reSigned, { attester: key.address }).errors.join(), /not by the expected attester/);
  // A signature swapped in from another snapshot.
  const s2 = await signSnapshot(payload(2880, { height: 1440, hash: s.hash }), key);
  assert.equal(edit((c) => (c.signature = s2.signature)).ok, false);
  // A float smuggled into the payload cannot be hashed canonically.
  assert.match(edit((c) => (c.payload.assets[0].ratio = 0.5)).errors.join(), /not canonical/);
});

test("an intact history verifies, first to last", async () => {
  const h = await history(3);
  const c = verifyChain([h[2], h[0], h[1]], { attester: key.address });
  assert.deepEqual(c.errors, []);
  assert.deepEqual(c.head, { height: 4320, hash: h[2].hash });
});

test("a dropped snapshot breaks the chain", async () => {
  const h = await history(3);
  const c = verifyChain([h[0], h[2]]);
  assert.equal(c.ok, false);
  assert.match(c.linkErrors.join(), /names 2880 as its predecessor, but the one before it is 1440/);
});

test("a rewritten snapshot breaks the link after it, even when validly re-signed", async () => {
  const h = await history(3);
  const p = structuredClone(h[1].payload);
  p.assets[0].escrowAtoms = "1";
  const rewritten = await signSnapshot(p, key);
  assert.equal(verifySnapshot(rewritten, { attester: key.address }).ok, true);
  const c = verifyChain([h[0], rewritten, h[2]]);
  assert.equal(c.ok, false);
  assert.deepEqual(c.signatureErrors, []);
  assert.match(c.linkErrors.join(), /4320 links to hash/);
});

test("a history cut at the front is caught: the new first snapshot names a predecessor", async () => {
  const h = await history(2);
  assert.match(checkLink(null, h[1]).join(), /not in the history/);
  assert.match(checkLink(h[0], { payload: { ...h[1].payload, previous: null } }).join(), /claims to be the first/);
});

test("the index lists every snapshot with its hash and link", async () => {
  const h = await history(2);
  const idx = buildIndex([h[1], h[0]]);
  assert.equal(idx.attester, key.address);
  assert.deepEqual(idx.head, { height: 2880, hash: h[1].hash });
  assert.deepEqual(
    idx.snapshots.map((e) => [e.height, e.hash, e.previous, e.file]),
    [
      [1440, h[0].hash, null, "1440.json"],
      [2880, h[1].hash, h[0].hash, "2880.json"],
    ]
  );
  assert.ok(parseIndex(idx));
  assert.deepEqual(buildIndex([]).snapshots, []);
});

test("parseIndex refuses anything that is not an index", () => {
  // What /api/por/history answered before it existed: the live reserves report.
  assert.equal(parseIndex({ generatedAt: "x", assets: [] }), null);
  assert.equal(parseIndex(null), null);
  assert.equal(parseIndex({ format: "compages-reserves-index", snapshots: [{ height: "1", hash: "ab" }] }), null);
  assert.equal(parseIndex({ format: "compages-reserves-index", snapshots: [{ height: -1, hash: "a".repeat(64) }] }), null);
});
