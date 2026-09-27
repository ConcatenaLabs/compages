// Take one snapshot: choose the height, read every figure pinned to it, sign,
// and append it to the history. See ../snapshot.mjs for the command and the
// README ("Signed reserve snapshots") for what each figure means.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ethers } from "ethers";
import { payloadHash, signSnapshot, verifyChain } from "./format.mjs";
import { readAll, writeSnapshotOnce, writeIndex } from "./store.mjs";
import { chooseHeight, unitsToAtoms, supplyFromAudit, backedVerdict, lastBlockAtOrBefore } from "./figures.mjs";
import { runAudit, fileSha256, gitCommitOf } from "./audit.mjs";
import { seqClient, ethProvider, vaultFigures, solClient, escrowAccounts, readSolanaAccounts, heldUnits, checkBurn } from "./chains.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
export const TOOL_VERSION = JSON.parse(fs.readFileSync(path.join(here, "..", "package.json"), "utf8")).version;

async function daemonJson(cfg, p) {
  const res = await fetch(`${cfg.daemonUrl.replace(/\/+$/, "")}${p}`, { signal: AbortSignal.timeout(60_000) });
  if (!res.ok) throw new Error(`the daemon answered ${p} with HTTP ${res.status}`);
  return res.json();
}

/**
 * cfg: the parsed config with paths already resolved (see snapshot.mjs).
 * opts.signer: an ethers signer; opts.dryRun: build and return the payload
 * without signing or writing. Returns { status, height, file?, payload? },
 * status one of "written", "dry-run", "up-to-date", "not-yet".
 */
export async function takeSnapshot(cfg, { signer = null, dryRun = false, log = () => {}, now = () => new Date() } = {}) {
  const interval = cfg.intervalBlocks ?? 1440;
  const minDepth = cfg.minDepth ?? 10;
  const dir = cfg.snapshotDir;

  // The history this snapshot extends must itself be intact: a snapshot
  // linked to a tampered predecessor would lend it a fresh signature.
  const existing = readAll(dir);
  const chain = verifyChain(existing);
  if (!chain.ok) throw new Error(`the history in ${dir} does not verify, refusing to extend it: ${chain.errors.join("; ")}`);
  const head = chain.head;

  // ---- Sequentia: the height ----
  const seq = seqClient(cfg.seqRpcUrl);
  const tip = await seq.call("getblockcount");
  const height = chooseHeight(tip, interval, minDepth);
  if (height === null) return { status: "not-yet", reason: `the chain (tip ${tip}) has no height ${minDepth} deep at a multiple of ${interval}` };
  if (head && height <= head.height) return { status: "up-to-date", height: head.height };
  const blockHash = await seq.call("getblockhash", [height]);
  const header = await seq.call("getblockheader", [blockHash]);
  const genesisHash = await seq.call("getblockhash", [0]);
  const chainName = (await seq.call("getblockchaininfo")).chain;

  // ---- Ethereum: the block at the same moment ----
  // The last block whose timestamp is at or before Sequentia block H's. Escrow
  // and supply are then measured at one cut in time: a deposit is escrowed
  // before it is minted and a redemption burned before it is released, so at
  // a common moment escrow may exceed supply but never legitimately fall
  // short of it. Taking Ethereum's latest block instead would count deposits
  // made after H against a supply from before them. B must be final, and it
  // is exactly determined: its successor is after H's time.
  const eth = ethProvider(cfg.ethRpcUrl, cfg.ethChainId);
  const netId = Number((await eth.send("eth_chainId", [])) ?? 0);
  if (netId !== Number(cfg.ethChainId)) throw new Error(`the Ethereum RPC is chain ${netId}, not ${cfg.ethChainId}`);
  const finalized = await eth.getBlock("finalized");
  if (!(finalized.timestamp > header.time)) {
    return { status: "not-yet", height, reason: `Ethereum has not finalized a block after Sequentia block ${height}'s time yet` };
  }
  const blockB = await lastBlockAtOrBefore((n) => eth.getBlock(n), header.time, finalized);

  // ---- the assets ----
  const assets = (await daemonJson(cfg, "/api/assets")).filter((m) => !m.retired).sort((a, b) => (a.assetId < b.assetId ? -1 : 1));
  if (assets.length === 0) return { status: "not-yet", height, reason: "the bridge has no assets yet" };

  // ---- Sequentia: supply at H ----
  const audit = await runAudit({
    script: cfg.auditScript,
    python: cfg.python ?? "python3",
    rpc: seq,
    height,
    assets: assets.map((m) => m.assetId),
    checkpoint: cfg.auditCheckpoint ?? null,
    blockHash: (h) => seq.call("getblockhash", [h]),
    timeoutMs: (cfg.auditTimeoutMinutes ?? 360) * 60_000,
    log,
  });

  // ---- Solana: the escrow accounts ----
  const solLabel = cfg.solChainLabel ?? "solana-devnet";
  const solSources = assets.flatMap((m) => m.sources.filter((s) => s.chainId === solLabel).map((s) => ({ m, s })));
  let solana = null;
  let solAccounts = null;
  let owners = [];
  const sol = cfg.solRpcUrl ? solClient(cfg.solRpcUrl) : null;
  if (solSources.length && sol) {
    const intents = await daemonJson(cfg, "/api/sol/intents");
    if (cfg.solTreasury && intents.treasury !== cfg.solTreasury) {
      throw new Error(`the daemon names Solana treasury ${intents.treasury}, not the configured ${cfg.solTreasury}`);
    }
    owners = [intents.treasury, ...[...intents.addresses].sort()];
    const genesis = await sol("getGenesisHash", []);
    if (cfg.solGenesisHash && genesis !== cfg.solGenesisHash) throw new Error(`the Solana RPC is cluster ${genesis}, not ${cfg.solGenesisHash}`);
    const wanted = [...new Set(solSources.map(({ s }) => s.token))].flatMap((mint) => escrowAccounts(owners, mint).map((e) => e.account));
    solAccounts = await readSolanaAccounts(sol, wanted);
    solana = {
      cluster: solLabel,
      genesisHash: genesis,
      commitment: "finalized",
      slot: solAccounts.minSlot,
      lastSlot: solAccounts.maxSlot,
      readAt: now().toISOString(),
      pastSlotQueryable: false,
      note: "Solana's RPC reads only the current state, so these balances are as of the slots the reads were answered at, taken after Sequentia block H, not at H itself.",
      treasury: intents.treasury,
      owners,
    };
  }

  // ---- per asset ----
  const out = [];
  for (const m of assets) {
    const precision = m.precision ?? 8;
    const supply = supplyFromAudit(audit.report, m.assetId);
    const sources = [];
    let escrowAtoms = 0n;
    let escrowMeasured = m.sources.length > 0;
    let inTransitAtoms = 0n;
    let inTransit = [];
    for (const s of m.sources) {
      const src = { chainId: s.chainId, token: s.token, decimals: s.decimals, escrowUnits: null, escrowAtoms: null, holdings: [], error: null };
      try {
        let units = 0n;
        if (String(s.chainId) === String(cfg.ethChainId)) {
          const token = s.token === "eth" ? ethers.ZeroAddress : s.token;
          for (const v of cfg.vaults) {
            const f = await vaultFigures(eth, v.address, token, blockB.number);
            src.holdings.push(f);
            units += BigInt(f.backing);
          }
        } else if (s.chainId === solLabel && solAccounts) {
          for (const e of escrowAccounts(owners, s.token)) {
            const held = heldUnits(e, solAccounts.accounts.get(e.account), s.token);
            if (held > 0n) src.holdings.push({ owner: e.owner, account: e.account, program: e.program, units: held.toString() });
            units += held;
          }
          // Unified USDC moves between its escrows through CCTP: burned on
          // Solana, then minted into the vault. In between it is in neither
          // balance, yet still backs the asset.
          if (m.unified && m.sources.some((x) => String(x.chainId) === String(cfg.ethChainId))) {
            const por = await daemonJson(cfg, `/api/por?asset=${m.assetId}`);
            for (const b of por.assets?.[0]?.inTransit ?? []) {
              const c = await checkBurn(sol, b, { mint: s.token, treasury: solana.treasury, readSlot: solana.slot });
              inTransit.push(c);
              if (c.counted) inTransitAtoms += unitsToAtoms(c.amount, s.decimals, precision);
            }
          }
        } else {
          throw new Error(`no reader for source chain ${s.chainId}`);
        }
        src.escrowUnits = units.toString();
        src.escrowAtoms = unitsToAtoms(units, s.decimals, precision).toString();
        escrowAtoms += BigInt(src.escrowAtoms);
      } catch (e) {
        src.error = e.shortMessage ?? e.message;
        escrowMeasured = false;
      }
      sources.push(src);
    }
    const escrow = escrowMeasured ? escrowAtoms.toString() : null;
    out.push({
      assetId: m.assetId,
      symbol: m.symbol ?? null,
      ticker: m.ticker ?? null,
      precision,
      unified: m.unified === true,
      supply,
      sources,
      escrowAtoms: escrow,
      inTransitAtoms: inTransitAtoms.toString(),
      inTransit,
      backed: backedVerdict({ supply, escrowAtoms: escrow, inTransitAtoms: inTransitAtoms.toString() }),
    });
  }

  const auditScript = path.resolve(cfg.auditScript);
  const payload = {
    height,
    previous: head,
    createdAt: now().toISOString(),
    attester: signer ? signer.address : null,
    tool: {
      name: "compages-reserves",
      version: TOOL_VERSION,
      source: cfg.toolSource ?? "https://github.com/ConcatenaLabs/compages",
      path: "reserves/snapshot.mjs",
      commit: await gitCommitOf(path.join(here, "..", "snapshot.mjs")),
    },
    sequentia: {
      chain: chainName,
      genesisHash,
      height,
      blockHash,
      time: header.time,
      medianTime: header.mediantime ?? null,
      tip,
      interval,
      minDepth,
      auditor: {
        source: cfg.auditSource ?? "https://github.com/ConcatenaLabs/Sequentia",
        path: "contrib/asset-supply-audit/audit.py",
        commit: await gitCommitOf(auditScript),
        sha256: fileSha256(auditScript),
        args: ["--start", "0", "--end", String(height), "--json", ...assets.flatMap((m) => ["--asset", m.assetId])],
        exitStatus: audit.exitStatus,
        exact: audit.exitStatus === 0,
        scannedStart: audit.report.scanned_start,
        scannedEnd: audit.report.scanned_end,
      },
    },
    ethereum: {
      chainId: Number(cfg.ethChainId),
      chainName: cfg.ethChainName ?? null,
      block: blockB.number,
      blockHash: blockB.hash,
      blockTime: blockB.timestamp,
      selection: "the last block whose timestamp is at or before the Sequentia block's time",
      finalizedAtSnapshot: finalized.number,
      vaults: cfg.vaults.map((v) => ethers.getAddress(v.address)),
    },
    solana,
    assets: out,
  };

  if (dryRun) return { status: "dry-run", height, payload };
  if (!signer) throw new Error("no attestation key");
  const snap = await signSnapshot(payload, signer);
  const file = writeSnapshotOnce(dir, snap);
  writeIndex(dir);
  return { status: "written", height, file, hash: payloadHash(payload), payload };
}
