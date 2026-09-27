#!/usr/bin/env node
// Operator commands for a running compagesd, over its admin API.
//
//   node admin.js [--config config.json] <command> [args]
//
//   health                          the daemon's health report
//   records [status]                every record, or those in one status
//   show <group> <key>              one record in full
//   retry <group> <key> [note]      re-run a stopped step (you have checked
//                                   the chain and nothing from it is in flight)
//   delivered <group> <key> <txid> [note]
//                                   record a delivery made by hand
//   retire <group> <key> [note]     close a record that needs no further action
//   retire-asset <mappingKey> [note]
//                                   mark a bridged asset retired (e.g. issued
//                                   before a chain reset)
//   halt <assetId> [mint|all] [reason]
//   unhalt <assetId>
//
// Groups: deposits, solDeposits, redemptions, solRedemptions. The admin API
// is enabled by setting `adminToken` in the daemon config; this tool reads the
// token and port from the same file.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
let cfgPath = path.join(here, "config.json");
if (argv[0] === "--config") {
  cfgPath = argv[1];
  argv.splice(0, 2);
}
const cfg = JSON.parse(fs.readFileSync(cfgPath, "utf8"));
if (!cfg.adminToken) {
  console.error(`no adminToken in ${cfgPath}; the admin API is disabled`);
  process.exit(2);
}
const base = `http://${cfg.apiHost ?? "127.0.0.1"}:${cfg.apiPort}/api`;

async function call(method, route, body) {
  const res = await fetch(`${base}/${route}`, {
    method,
    headers: { authorization: `Bearer ${cfg.adminToken}`, "content-type": "application/json" },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  if (!res.ok && res.status !== 503) {
    console.error(`${res.status}: ${text}`);
    process.exit(1);
  }
  return JSON.parse(text);
}

const [cmd, ...a] = argv;
const print = (v) => console.log(JSON.stringify(v, null, 2));
switch (cmd) {
  case "health":
    print(await call("GET", "health"));
    break;
  case "records": {
    const rows = await call("GET", `admin/records${a[0] ? `?status=${encodeURIComponent(a[0])}` : ""}`);
    for (const r of rows) {
      console.log(`${r.group.padEnd(15)} ${String(r.key).slice(0, 70).padEnd(70)} ${r.status}${r.retired ? " (retired)" : ""}`);
    }
    break;
  }
  case "show": {
    const rows = await call("GET", "admin/records");
    print(rows.find((r) => r.group === a[0] && String(r.key) === a[1]) ?? "no such record");
    break;
  }
  case "retry":
    print(await call("POST", "admin/resolve", { group: a[0], key: a[1], action: "retry", note: a[2] }));
    break;
  case "delivered":
    print(await call("POST", "admin/resolve", { group: a[0], key: a[1], action: "mark_delivered", txid: a[2], note: a[3] }));
    break;
  case "retire":
    print(await call("POST", "admin/resolve", { group: a[0], key: a[1], action: "retire", note: a[2] }));
    break;
  case "retire-asset":
    print(await call("POST", "admin/retire-asset", { mappingKey: a[0], note: a[1] }));
    break;
  case "halt":
    print(await call("POST", "admin/halt", { assetId: a[0], scope: a[1] ?? "all", reason: a[2] }));
    break;
  case "unhalt":
    print(await call("POST", "admin/unhalt", { assetId: a[0] }));
    break;
  default:
    console.error(fs.readFileSync(fileURLToPath(import.meta.url), "utf8").split("\n").slice(1, 22).join("\n"));
    process.exit(2);
}
