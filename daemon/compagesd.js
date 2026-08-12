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

  startApi(cfg, eth, seq, state, bridge, log);

  // --- main loop, one pass at a time ---
  // Each phase fails independently, so an outage on one chain's RPC never
  // starves the other legs.
  const phases = [
    () => bridge.processDeposits(),
    () => bridge.retryDeposits(),
    () => bridge.registerPendingAssets(),
    () => bridge.processRefunds(),
    () => bridge.processRedemptions(),
    () => bridge.advanceRedemptions(),
    () => bridge.retryRedemptions(),
    () => bridge.processSolDeposits(),
    () => bridge.retrySolDeposits(),
    () => bridge.sweepSolIntents(),
    () => bridge.advanceSolRedemptions(),
  ];
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    for (const phase of phases) {
      try {
        await phase();
      } catch (e) {
        log(`tick error: ${e.message}`);
      }
    }
    running = false;
  };
  await tick();
  setInterval(tick, cfg.pollIntervalMs ?? 15000);
}

main().catch((e) => {
  log(`fatal: ${e.stack ?? e.message}`);
  process.exit(1);
});
