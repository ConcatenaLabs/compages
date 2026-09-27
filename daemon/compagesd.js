#!/usr/bin/env node
// Compages bridge daemon: Ethereum, Bitcoin (proxied), and Solana <-> Sequentia.
// Usage: node compagesd.js [config.json]

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { SeqRpc } from "./lib/seqrpc.js";
import { State } from "./lib/state.js";
import { Eth } from "./lib/eth.js";
import { Sol } from "./lib/sol.js";
import { Bridge } from "./lib/bridge.js";
import { startApi } from "./lib/api.js";
import { Alerts } from "./lib/alerts.js";
import { Cctp } from "./lib/cctp.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const cfgPath = process.argv[2] ?? path.join(here, "config.json");
const cfg = JSON.parse(fs.readFileSync(cfgPath, "utf8"));

const log = (msg) => console.log(`${new Date().toISOString()} ${msg}`);

const operatorKey = fs
  .readFileSync(path.resolve(path.dirname(cfgPath), cfg.operatorKeyFile), "utf8")
  .trim();

// The Solana leg is optional: no solRpcUrl, no leg. Its operator key (a 32-byte
// hex seed) is generated on first boot so bringing the leg up needs no manual
// key ceremony — but the file is a secret like operator.key: back it up, never
// commit it.
let sol = null;
if (cfg.solRpcUrl) {
  const keyPath = path.resolve(path.dirname(cfgPath), cfg.solKeyFile ?? "solana.key");
  if (!fs.existsSync(keyPath)) {
    fs.writeFileSync(keyPath, crypto.randomBytes(32).toString("hex") + "\n", { mode: 0o600 });
    log(`generated a new Solana operator key at ${keyPath} (back it up)`);
  }
  const seed = Buffer.from(fs.readFileSync(keyPath, "utf8").trim(), "hex");
  if (seed.length !== 32) throw new Error(`${keyPath} must hold 32 bytes of hex`);
  sol = new Sol(cfg, seed);
}

const state = new State(path.resolve(path.dirname(cfgPath), cfg.stateFile));
const eth = new Eth(cfg, operatorKey);
const seq = new SeqRpc(cfg.seqRpcUrl, cfg.seqWallet);
const bridge = new Bridge(cfg, eth, seq, state, log, sol);
const alerts = new Alerts(cfg, log);
bridge.startedAt = Date.now();
const cctp = new Cctp(cfg, bridge);
bridge.cctp = cctp;

async function main() {
  // --- startup checks ---
  const net = await eth.provider.getNetwork();
  if (Number(net.chainId) !== cfg.ethChainId) {
    throw new Error(`Ethereum RPC chain id ${net.chainId} != configured ${cfg.ethChainId}`);
  }
  const operator = await eth.vault.operator();
  if (operator.toLowerCase() !== eth.wallet.address.toLowerCase()) {
    throw new Error(`vault operator is ${operator}, but our key is ${eth.wallet.address}`);
  }
  const chainInfo = await seq.node("getblockchaininfo");
  // Load our wallet if the node has it on disk but not loaded (e.g. after a
  // node restart), so a reboot never strands the bridge.
  try {
    await seq.call("getwalletinfo");
  } catch {
    try {
      await seq.node("loadwallet", { filename: cfg.seqWallet });
      log(`loaded Sequentia wallet '${cfg.seqWallet}'`);
    } catch (e) {
      throw new Error(`Sequentia wallet '${cfg.seqWallet}' is not loaded and could not be loaded: ${e.message}`);
    }
  }
  const walletInfo = await seq.call("getwalletinfo");
  log(
    `Compages starting: ${cfg.ethChainName} (chain ${cfg.ethChainId}, vault ${cfg.vaultAddress}, operator ${eth.wallet.address})` +
      ` <-> Sequentia [${chainInfo.chain}] wallet '${walletInfo.walletname}' at height ${chainInfo.blocks}`
  );
  const ethBal = await eth.provider.getBalance(eth.wallet.address);
  log(`operator gas balance: ${ethBal} wei${ethBal === 0n ? " (WARNING: cannot send releases)" : ""}`);

  if (sol) {
    // Same spirit as the Ethereum chain-id check: never act against the wrong
    // cluster (intent addresses and the treasury are cluster-blind). But a
    // merely unreachable Solana RPC must not take the other legs down with it:
    // the check is retried lazily by every Solana tick phase, and the leg
    // idles until it passes.
    try {
      await sol.ensureCluster();
      const solBal = await sol.balance(sol.treasury.address);
      log(
        `Solana leg: ${cfg.solChainName ?? "Solana"} treasury ${sol.treasury.address}, ` +
          `balance ${solBal} lamports${solBal === 0n ? " (WARNING: cannot pay releases or sweep fees)" : ""}`
      );
    } catch (e) {
      log(`WARNING: Solana startup check failed; the Solana leg idles until its RPC responds: ${e.message}`);
    }
    if (BigInt(cfg.solMinReleaseSats ?? 100_000) * 10n < 890_880n) {
      log(
        `WARNING: solMinReleaseSats is below Solana's rent-exempt minimum; releases to fresh accounts would fail`
      );
    }
  }

  if (!state.data.lastEthBlock) {
    state.data.lastEthBlock = cfg.vaultDeployBlock - 1;
  }
  if (!state.data.seqLastBlockHash) {
    state.data.seqLastBlockHash = await seq.node("getbestblockhash");
  }
  state.save();
  bridge.reconcileInterrupted();

  // Unified assets are issued before the first deposit can be accepted, so a
  // deposit is never the thing that creates one. If this fails the daemon must
  // not run: minting into an asset that does not exist, or one issued with the
  // wrong permanent parameters, cannot be undone afterwards.
  await bridge.ensureUnifiedAssets();

  startApi(cfg, eth, seq, state, bridge, log);

  // --- main loops, one pass at a time each ---
  // Each phase fails independently, so an outage on one chain's RPC never
  // starves the other legs, and the Solana leg runs on a loop of its own: a
  // slow or throttled cluster must not delay an Ethereum release, nor the
  // other way round. Every phase records when it last succeeded, which is
  // what /api/health and the alerts read to tell a quiet bridge from a
  // stalled one.
  const runLoop = (name, phases, intervalMs) => {
    let running = false;
    const tick = async () => {
      if (running) return;
      running = true;
      for (const [phaseName, phase] of phases) {
        try {
          await phase();
          bridge.phaseOk(phaseName);
        } catch (e) {
          bridge.phaseFailed(phaseName, e);
          log(`tick error (${phaseName}): ${e.message}`);
        }
      }
      running = false;
    };
    tick();
    setInterval(tick, intervalMs);
    log(`${name} loop running every ${intervalMs} ms`);
  };

  const interval = cfg.pollIntervalMs ?? 15000;
  runLoop(
    "core",
    [
      ["ethDeposits", () => bridge.processDeposits()],
      ["depositRetries", () => bridge.retryDeposits()],
      ["deliveries", () => bridge.watchDeliveries()],
      ["registry", () => bridge.registerPendingAssets()],
      ["refunds", () => bridge.processRefunds()],
      ["seqRedemptions", () => bridge.processRedemptions()],
      ["ethRedemptions", () => bridge.advanceRedemptions()],
      ["ethRetries", () => bridge.retryRedemptions()],
      ["cctpTransfers", () => cctp.advance()],
      ["cctpInbound", () => cctp.advanceInbound()],
      ["cctpOutbound", () => cctp.advanceOutbound()],
      ["invariants", () => bridge.checkInvariants()],
    ],
    interval
  );
  if (sol) {
    runLoop(
      "solana",
      [
        ["solDeposits", () => bridge.processSolDeposits()],
        ["solRetries", () => bridge.retrySolDeposits()],
        ["solSweeps", () => bridge.sweepSolIntents()],
        ["solRedemptions", () => bridge.advanceSolRedemptions()],
        ["cctpConsolidate", () => cctp.consolidate()],
        ["cctpReclaim", () => cctp.reclaim()],
      ],
      cfg.solPollIntervalMs ?? interval
    );
  }

  // Alerts: one pass a minute over the same health report the API serves.
  const checkAlerts = async () => {
    try {
      const h = await bridge.health();
      const active = new Set();
      for (const p of h.problems) {
        active.add(p.key);
        await alerts.raise(p.key, p.title, p.detail, { priority: p.severity === "critical" ? 5 : 4 });
      }
      await alerts.settle(active);
    } catch (e) {
      log(`alert check failed: ${e.message}`);
    }
  };
  setTimeout(checkAlerts, 30_000);
  setInterval(checkAlerts, 60_000);
}

main().catch((e) => {
  log(`fatal: ${e.stack ?? e.message}`);
  process.exit(1);
});
