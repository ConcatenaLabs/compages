// web/shared is seqdex-web's connector layer, vendored: each file is one header line naming the
// source path and commit, then the upstream file unchanged. These tests fail when a vendored body
// is edited here, or differs from that commit upstream, so the copy cannot drift silently. To
// update it, vendor the files again from a new seqdex-web commit and set the hashes below.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { walletConnectors, WALLET_CONNECTORS } from "../lib/api.js";

const WEB = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "web");
const VENDORED = {
  "shared/connectors.js": "7a4ddcc9f1e69197040d0af6fe58a0ddc1259aa4ab23082576967bce4768f8de",
  "shared/provider.js": "81c351bae379aba6a639b4ccccc95a857234675692bd7149a73e4bfd5e4836d3",
  "shared/vendor/nostr-tools.js": "a87e35d03745faca61dff2ada2110e3757542a7dc412a41badf87615dd71757f",
  "shared/vendor/qrcode.mjs": "ea91d7118a5395289170da848b7c6758b996163bfbccf312591ab65a4911b7c0",
};
const HEADER = /^\/\/ Vendored from ConcatenaLabs\/seqdex-web (\S+) at ([0-9a-f]{40}), unchanged below this line/;

function vendored(rel) {
  const b = fs.readFileSync(path.join(WEB, rel));
  const nl = b.indexOf(10);
  const m = nl > 0 && HEADER.exec(b.subarray(0, nl).toString());
  assert.ok(m, `${rel}: no vendoring header naming the source file and commit`);
  return { src: m[1], commit: m[2], body: b.subarray(nl + 1) };
}

test("the vendored connector files are unchanged, from one commit", () => {
  const commits = new Set();
  for (const [rel, want] of Object.entries(VENDORED)) {
    const { commit, body } = vendored(rel);
    commits.add(commit);
    const got = crypto.createHash("sha256").update(body).digest("hex");
    assert.equal(got, want, `${rel} was edited here: change it in seqdex-web and vendor it again`);
  }
  assert.equal(commits.size, 1, "the vendored files come from more than one seqdex-web commit");
});

test("the vendored connector files are seqdex-web's at the named commit", async (t) => {
  for (const rel of Object.keys(VENDORED)) {
    const { src, commit, body } = vendored(rel);
    let res;
    try {
      res = await fetch(`https://raw.githubusercontent.com/ConcatenaLabs/seqdex-web/${commit}/${src}`);
    } catch (e) {
      t.skip(`GitHub unreachable: ${e.message}`);
      return;
    }
    assert.equal(res.status, 200, `${rel}: upstream ${src} at ${commit}`);
    assert.ok(Buffer.from(await res.arrayBuffer()).equals(body), `${rel} differs from seqdex-web ${src} at ${commit}`);
  }
});

test("walletConnectors: the web wallet by default, known connectors only", () => {
  assert.deepEqual(walletConnectors({}), ["webwallet"]);
  assert.deepEqual(walletConnectors({ walletConnectors: ["webwallet", "phone", "webwallet"] }), ["webwallet", "phone"]);
  assert.throws(() => walletConnectors({ walletConnectors: ["ambra"] }), /not a connector/);
  assert.throws(() => walletConnectors({ walletConnectors: "webwallet" }), /must be a list/);
  // Every connector the setting accepts is one connectors.js defines.
  const src = vendored("shared/connectors.js").body.toString();
  for (const id of WALLET_CONNECTORS) assert.match(src, new RegExp(`id: '${id}'`), id);
});
