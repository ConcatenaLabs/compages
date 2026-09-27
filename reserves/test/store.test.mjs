// The history directory: write once, never overwrite.
// Run: npm test
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ethers } from "ethers";
import { signSnapshot, fileText, buildIndex } from "../lib/format.mjs";
import { listHeights, readAll, writeSnapshotOnce, writeIndex } from "../lib/store.mjs";

const key = ethers.Wallet.createRandom();
const tmpdir = () => fs.mkdtempSync(path.join(os.tmpdir(), "reserves-store-"));
const snap = (height, previous = null, escrow = "1") =>
  signSnapshot({ height, previous, attester: key.address, assets: [{ escrowAtoms: escrow }] }, key);

test("a snapshot is written as canonical JSON with one trailing newline", async () => {
  const dir = tmpdir();
  const s = await snap(1440);
  const file = writeSnapshotOnce(dir, s);
  assert.equal(file, path.join(dir, "1440.json"));
  assert.equal(fs.readFileSync(file, "utf8"), fileText(s));
  assert.deepEqual(fs.readdirSync(dir), ["1440.json"], "no temporary file is left behind");
});

test("a snapshot is never overwritten", async () => {
  const dir = tmpdir();
  const first = await snap(1440, null, "1");
  writeSnapshotOnce(dir, first);
  const second = await snap(1440, null, "2");
  assert.throws(() => writeSnapshotOnce(dir, second), /never overwritten/);
  assert.equal(fs.readFileSync(path.join(dir, "1440.json"), "utf8"), fileText(first));
  assert.deepEqual(fs.readdirSync(dir), ["1440.json"]);
});

test("a file that appears between the check and the write is not overwritten either", async () => {
  const dir = tmpdir();
  const s = await snap(1440);
  const real = fs.existsSync;
  // Simulate a concurrent writer: the existence check passes, then the file exists.
  fs.existsSync = (p) => (p === path.join(dir, "1440.json") ? (fs.writeFileSync(p, "someone else\n"), false) : real(p));
  try {
    assert.throws(() => writeSnapshotOnce(dir, s), /never overwritten/);
  } finally {
    fs.existsSync = real;
  }
  assert.equal(fs.readFileSync(path.join(dir, "1440.json"), "utf8"), "someone else\n");
  assert.deepEqual(fs.readdirSync(dir), ["1440.json"]);
});

test("only <height>.json files are snapshots", () => {
  const dir = tmpdir();
  for (const f of ["2880.json", "1440.json", "index.json", "01.json", ".1440.json.1.tmp", "1440.json.bak", "x.json"]) {
    fs.writeFileSync(path.join(dir, f), "{}");
  }
  assert.deepEqual(listHeights(dir), [1440, 2880]);
  assert.deepEqual(listHeights(path.join(dir, "missing")), []);
});

test("a file whose content is another height is refused", async () => {
  const dir = tmpdir();
  fs.writeFileSync(path.join(dir, "1440.json"), fileText(await snap(2880)));
  assert.throws(() => readAll(dir), /holds the snapshot of height 2880/);
});

test("the index is rebuilt from the files and replaced atomically", async () => {
  const dir = tmpdir();
  const a = await snap(1440);
  const b = await snap(2880, { height: 1440, hash: a.hash });
  writeSnapshotOnce(dir, a);
  writeIndex(dir);
  writeSnapshotOnce(dir, b);
  const idx = writeIndex(dir);
  assert.deepEqual(idx, buildIndex([a, b]));
  assert.equal(fs.readFileSync(path.join(dir, "index.json"), "utf8"), fileText(idx));
  assert.deepEqual(fs.readdirSync(dir).sort(), ["1440.json", "2880.json", "index.json"]);
});
