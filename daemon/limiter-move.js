#!/usr/bin/env node
// Move bridged assets' reissuance tokens from the wallet into their mint
// limiters, with the daemon stopped.
//
//   node limiter-move.js [--config config.json] --all
//   node limiter-move.js [--config config.json] <mappingKey> [<allowance atoms>]
//
// Each token moves whole, in one transfer, to a new mint limiter instance made
// from `mintLimiter` in the config (operator key, cold key, window, recovery
// delay) and the asset's allowance there (`allowances`, else
// `defaultAllowance`), or the allowance given. An asset already in a limiter
// is left as it is, so a second run changes nothing; a retired asset is
// skipped. Stop the daemon first (its state file is written here): the
// command refuses to run while the daemon's API answers. The running daemon's
// admin API does the same for one asset (`admin.js limiter-move`).

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { SeqRpc } from "./lib/seqrpc.js";
import { State } from "./lib/state.js";
import { Bridge } from "./lib/bridge.js";
import { limiterView } from "./lib/limiter.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
let cfgPath = path.join(here, "config.json");
if (argv[0] === "--config") {
  cfgPath = argv[1];
  argv.splice(0, 2);
}
if (!argv.length) {
  console.error(fs.readFileSync(fileURLToPath(import.meta.url), "utf8").split("\n").slice(1, 16).join("\n"));
  process.exit(2);
}
const cfg = JSON.parse(fs.readFileSync(cfgPath, "utf8"));
if (!cfg.mintLimiter) {
  console.error(`${cfgPath}: no mintLimiter is configured`);
  process.exit(2);
}
const log = (m) => console.error(`${new Date().toISOString()} ${m}`);

// The daemon writes the same state file; never both at once.
try {
  await fetch(`http://${cfg.apiHost ?? "127.0.0.1"}:${cfg.apiPort ?? 9950}/api/status`, { signal: AbortSignal.timeout(3000) });
  console.error("the daemon's API answers: stop the daemon first");
  process.exit(2);
} catch {}

const state = new State(path.resolve(path.dirname(cfgPath), cfg.stateFile));
const seq = new SeqRpc(cfg.seqRpcUrl, cfg.seqWallet);
const bridge = new Bridge(cfg, null, seq, state, log, null);

const keys = argv[0] === "--all" ? Object.keys(state.data.mappings) : [argv[0]];
const allowance = argv[0] === "--all" || argv[1] === undefined ? undefined : BigInt(argv[1]);
const out = {};
for (const key of keys) {
  const m = state.data.mappings[key];
  if (!m) {
    console.error(`no mapping ${key}`);
    process.exit(1);
  }
  if (m.retired) continue;
  const had = Boolean(m.limiter?.coin);
  try {
    await bridge.limiterHandover(key, allowance);
  } catch (e) {
    console.error(`${key} (${m.contract?.ticker ?? m.symbol}): ${e.message}`);
    process.exit(1);
  }
  const v = limiterView(state.data.mappings[key]);
  out[key] = { ticker: m.contract?.ticker ?? m.symbol, moved: !had, address: v.address, coin: v.coin,
    allowanceAtoms: v.allowanceAtoms, windowBlocks: v.windowBlocks, recoveryDelaySeconds: v.recoveryDelaySeconds };
}
console.log(JSON.stringify(out, null, 2));
