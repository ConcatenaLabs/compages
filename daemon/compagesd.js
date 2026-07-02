#!/usr/bin/env node
// Compages bridge daemon: Ethereum <-> Sequentia.
// Usage: node compagesd.js [config.json]

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { SeqRpc } from "./lib/seqrpc.js";
import { State } from "./lib/state.js";
import { Eth } from "./lib/eth.js";
import { Bridge } from "./lib/bridge.js";
import { startApi } from "./lib/api.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const cfgPath = process.argv[2] ?? path.join(here, "config.json");
const cfg = JSON.parse(fs.readFileSync(cfgPath, "utf8"));

const log = (msg) => console.log(`${new Date().toISOString()} ${msg}`);

const operatorKey = fs
  .readFileSync(path.resolve(path.dirname(cfgPath), cfg.operatorKeyFile), "utf8")
  .trim();

const state = new State(path.resolve(path.dirname(cfgPath), cfg.stateFile));
const eth = new Eth(cfg, operatorKey);
const seq = new SeqRpc(cfg.seqRpcUrl, cfg.seqWallet);
const bridge = new Bridge(cfg, eth, seq, state, log);

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

  if (!state.data.lastEthBlock) {
    state.data.lastEthBlock = cfg.vaultDeployBlock - 1;
  }
  if (!state.data.seqLastBlockHash) {
    state.data.seqLastBlockHash = await seq.node("getbestblockhash");
  }
  state.save();

  startApi(cfg, eth, seq, state, bridge, log);

  // --- main loop, one pass at a time ---
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      await bridge.processDeposits();
      await bridge.retryDeposits();
      await bridge.processRefunds();
      await bridge.processRedemptions();
      await bridge.advanceRedemptions();
      await bridge.retryRedemptions();
    } catch (e) {
      log(`tick error: ${e.message}`);
    } finally {
      running = false;
    }
  };
  await tick();
  setInterval(tick, cfg.pollIntervalMs ?? 15000);
}

main().catch((e) => {
  log(`fatal: ${e.stack ?? e.message}`);
  process.exit(1);
});
