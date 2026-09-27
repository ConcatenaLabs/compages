// GET /api/por/history and /api/por/history/<H>: the signed reserve history,
// served byte for byte from `porHistoryDir`, with nothing else reachable
// through it.
// Run: npm test
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { porHistory } from "../lib/porhistory.js";
import { startApi } from "../lib/api.js";

function historyDir() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "por-history-"));
  const dir = path.join(root, "history");
  fs.mkdirSync(dir);
  // Bytes that must come back exactly as stored: key order and spacing are
  // part of what the signature covers.
  fs.writeFileSync(path.join(dir, "index.json"), '{"format":"compages-reserves-index","snapshots":[{"height":1440}]}\n');
  fs.writeFileSync(path.join(dir, "1440.json"), '{"z":1,"a":2}\n');
  fs.writeFileSync(path.join(root, "config.json"), '{"secret":"do not serve"}');
  fs.writeFileSync(path.join(root, "0.json"), '{"outside":true}');
  fs.mkdirSync(path.join(dir, "2880.json")); // a directory where a file is expected
  return { root, dir };
}

test("the index and a snapshot are served as stored", async () => {
  const { dir } = historyDir();
  const idx = await porHistory(dir, []);
  assert.equal(idx.status, 200);
  assert.equal(idx.body.toString(), fs.readFileSync(path.join(dir, "index.json"), "utf8"));
  assert.match(idx.headers["cache-control"], /max-age=60/);
  const snap = await porHistory(dir, ["1440"]);
  assert.equal(snap.status, 200);
  assert.equal(snap.body.toString(), '{"z":1,"a":2}\n');
  assert.match(snap.headers["cache-control"], /immutable/);
});

test("only a plain decimal height names a file", async () => {
  const { dir } = historyDir();
  for (const rest of [["..", "config.json"], [".."], ["../0"], ["%2e%2e"], ["1440.json"], ["01440"], ["-1"], ["1e3"], [" 1440"], ["1440", "x"], ["index"], ["0x5a0"]]) {
    const r = await porHistory(dir, rest);
    assert.equal(r.status, 404, rest.join("/"));
    assert.doesNotMatch(String(r.body), /secret|outside/);
  }
});

test("a missing snapshot, a missing index and an unset directory answer 404", async () => {
  const { dir } = historyDir();
  assert.match(String((await porHistory(dir, ["4320"])).body), /no snapshot at height 4320/);
  assert.equal((await porHistory(dir, ["2880"])).status, 404, "a directory is not a snapshot");
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), "por-history-empty-"));
  assert.match(String((await porHistory(empty, [])).body), /no reserve snapshot has been taken yet/);
  assert.match(String((await porHistory(null, [])).body), /publishes no reserve snapshot history/);
});

// Through the daemon's HTTP server: routing, the raw bytes, and the read limit.
async function daemon(cfg) {
  const state = { data: { mappings: {}, deposits: {}, redemptions: {}, solWrapIntents: {} } };
  const server = startApi({ apiHost: "127.0.0.1", apiPort: 0, ...cfg }, {}, {}, state, {}, () => {});
  await new Promise((r) => server.once("listening", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  return { server, get: (p) => fetch(base + p) };
}

test("the daemon routes /api/por/history to the files and nothing else", async (t) => {
  const { dir } = historyDir();
  const { server, get } = await daemon({ porHistoryDir: dir, readLimitPerHour: 1000 });
  t.after(() => server.close());
  let r = await get("/api/por/history");
  assert.equal(r.status, 200);
  assert.equal(r.headers.get("content-type"), "application/json; charset=utf-8");
  assert.equal(await r.text(), fs.readFileSync(path.join(dir, "index.json"), "utf8"));
  r = await get("/api/por/history/1440");
  assert.equal(await r.text(), '{"z":1,"a":2}\n');
  for (const p of ["/api/por/history/%2e%2e/config.json", "/api/por/history/..%2fconfig.json", "/api/por/history/1440.json", "/api/por/history/1440/x"]) {
    r = await get(p);
    assert.ok(r.status === 404, `${p} -> ${r.status}`);
    assert.doesNotMatch(await r.text(), /secret/);
  }
  // Any other path under /api/por is not the live report either.
  assert.equal((await get("/api/por/anything")).status, 404);
});

test("the history counts against the heavy-read limit", async (t) => {
  const { dir } = historyDir();
  const { server, get } = await daemon({ porHistoryDir: dir, readLimitPerHour: 2 });
  t.after(() => server.close());
  assert.equal((await get("/api/por/history")).status, 200);
  assert.equal((await get("/api/por/history/1440")).status, 200);
  assert.equal((await get("/api/por/history")).status, 429);
});

test("without porHistoryDir the history does not exist", async (t) => {
  const { server, get } = await daemon({});
  t.after(() => server.close());
  const r = await get("/api/por/history");
  assert.equal(r.status, 404);
  assert.match(await r.text(), /publishes no reserve snapshot history/);
});
