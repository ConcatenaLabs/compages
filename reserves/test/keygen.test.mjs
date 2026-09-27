// The attestation key is created once, private, and never replaced.
// Run: npm test
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { ethers } from "ethers";

const script = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "keygen.mjs");

test("keygen writes a private key file once and prints its address", () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "reserves-key-")), "attestation.key");
  const r = spawnSync(process.execPath, [script, file], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  const key = fs.readFileSync(file, "utf8");
  assert.equal(r.stdout.trim(), new ethers.Wallet(key.trim()).address);
  const again = spawnSync(process.execPath, [script, file], { encoding: "utf8" });
  assert.equal(again.status, 1);
  assert.match(again.stderr, /already exists/);
  assert.equal(fs.readFileSync(file, "utf8"), key);
});
