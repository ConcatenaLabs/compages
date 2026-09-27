// The snapshot tool end to end, against local stand-ins for the Sequentia,
// Ethereum and Solana nodes and the daemon (see mocks.mjs), and the verify
// tool on what it writes.
// Run: npm test
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { ethers } from "ethers";
import { takeSnapshot } from "../lib/take.mjs";
import { verifySnapshot, verifyChain, fileText } from "../lib/format.mjs";
import { readSnapshot } from "../lib/store.mjs";
import { checkFigures } from "../lib/consistency.mjs";
import { escrowAccounts } from "../lib/chains.mjs";
import { mockSequentia, mockEthereum, mockSolana, mockDaemon, tokenAccount, mockIris, cctpMessage } from "./mocks.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const key = ethers.Wallet.createRandom(); // a throwaway test key

const V3 = "0x7B702D6A2E2351F0c4E549642e65AbABC0324384";
const V1 = "0xd72AF53b4F0551A25072cC72A29F699Ed9d8Ed41";
const LATE = "0x15B3c97eD82C62b7828A775456Bd75e67A8eC42C"; // deployed after the first snapshot's block
const USDC = "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238";
const MINT = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU";
const TREASURY = "76ZPjfcZGjidKPm9eqmCADKvkYzsEfTwv1wroANJZuhv";
const INTENT = "4WvdLGfPXDajZEHyk3p3q5J3251CP31H3TC2oqKbf1PY";
const U = "aa".repeat(32); // USDC.e, unified: Sepolia + Solana
const E = "bb".repeat(32); // ETH.e
const RETIRED = "cc".repeat(32);

const auditEntry = (circ) => ({
  issued_atoms: 0,
  reissued_atoms: circ,
  burned_atoms: 0,
  circulating_atoms: circ,
  exact: true,
  blinded_issuances: 0,
  blinded_reissuances: 0,
  blinded_burns: 0,
});

const TRANSMITTER_ADDR = "0xE737e5cEBEEBa77EFE34D4aa090756590b1CE275";
const NONCE_DONE = `0x${"d0".repeat(32)}`;
const NONCE_BURN = `0x${"b1".repeat(32)}`;

async function world() {
  const seq = await mockSequentia();
  const { chain } = seq;
  const eth = await mockEthereum({
    t0: chain.t0,
    transmitter: TRANSMITTER_ADDR,
    // DONE's message was received on Ethereum at block 0, before any B.
    nonces: { [NONCE_DONE]: 0 },
    vaults: {
      [V3]: {
        deployedAt: 100,
        version: 3,
        tokens: { [USDC]: (n) => (n >= 1000 ? 16_000_000n : 0n) },
        reserved: (fn, token, n) => (fn === "owedTotal" && token === USDC && n >= 14000 ? 1_000_000n : 0n),
      },
      [V1]: { deployedAt: 10, version: null, ether: (n) => (n >= 10 ? 5n * 10n ** 17n : 0n) },
      [LATE]: { deployedAt: 20000, version: 3 },
    },
  });
  const [tAta] = escrowAccounts([TREASURY], MINT);
  const [iAta] = escrowAccounts([INTENT], MINT);
  const sol = await mockSolana({
    slot: 100,
    accounts: { [tAta.account]: tokenAccount(TREASURY, MINT, 3_000_000), [iAta.account]: tokenAccount(INTENT, MINT, 1_000_000) },
    transactions: {
      DONE: {
        slot: 80,
        meta: {
          err: null,
          preTokenBalances: [{ mint: MINT, owner: TREASURY, uiTokenAmount: { amount: "7000000" } }],
          postTokenBalances: [{ mint: MINT, owner: TREASURY, uiTokenAmount: { amount: "2000000" } }],
        },
      },
      BURN: {
        slot: 90,
        meta: {
          err: null,
          preTokenBalances: [{ mint: MINT, owner: TREASURY, uiTokenAmount: { amount: "2000000" } }],
          postTokenBalances: [{ mint: MINT, owner: TREASURY, uiTokenAmount: { amount: "1000000" } }],
        },
      },
    },
  });
  const daemon = await mockDaemon({
    assets: [
      {
        assetId: E,
        symbol: "ETH",
        ticker: "ETH.e",
        precision: 8,
        unified: false,
        retired: null,
        sources: [{ chainId: 11155111, token: "eth", decimals: 18 }],
      },
      {
        assetId: U,
        symbol: "USDC",
        ticker: "USDC.e",
        precision: 6,
        unified: true,
        retired: null,
        sources: [
          { chainId: 11155111, token: USDC, decimals: 6 },
          { chainId: "solana-devnet", token: MINT, decimals: 6 },
        ],
      },
      { assetId: RETIRED, symbol: "OLD", retired: { at: "x", note: "chain reset" }, sources: [] },
    ],
    intents: { treasury: TREASURY, addresses: [INTENT] },
    inTransit: { [U]: [{ id: "c1", amount: "1000000", solanaBurn: "BURN", stage: "attesting" }] },
    // The daemon's week of consolidations: one still in flight, one that
    // Ethereum had received long before B and is in the vault's balance.
    recentTransfers: {
      [U]: [
        { id: "c0", amount: "5000000", solanaBurn: "DONE", stage: "done" },
        { id: "c1", amount: "1000000", solanaBurn: "BURN", stage: "relaying" },
      ],
    },
  });
  const iris = await mockIris({
    messages: {
      DONE: cctpMessage({ nonce: NONCE_DONE, amount: 5_000_000n }),
      BURN: cctpMessage({ nonce: NONCE_BURN, amount: 1_000_000n }),
    },
  });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "reserves-e2e-"));
  const auditLog = path.join(dir, "audit-args.json");
  const cfg = {
    snapshotDir: path.join(dir, "history"),
    intervalBlocks: 1440,
    minDepth: 10,
    seqRpcUrl: seq.rpcUrl,
    auditScript: path.join(here, "fixtures", "fake-audit.mjs"),
    python: process.execPath,
    auditCheckpoint: path.join(dir, "state", "audit-checkpoint.json"),
    daemonUrl: daemon.url,
    ethChainId: 11155111,
    ethChainName: "Sepolia",
    ethRpcUrl: eth.url,
    vaults: [{ address: V1, version: 1 }, { address: LATE, version: 3 }, { address: V3, version: 3 }],
    irisUrl: iris.url,
    cctpMessageTransmitter: TRANSMITTER_ADDR,
    solRpcUrl: sol.url,
    solChainLabel: "solana-devnet",
    solTreasury: TREASURY,
    solGenesisHash: "GENESIS",
  };
  process.env.FAKE_AUDIT_LOG = auditLog;
  process.env.FAKE_AUDIT_EXIT = "0";
  process.env.FAKE_AUDIT_REPORT = JSON.stringify({ assets: { [U]: auditEntry(20_000_000), [E]: auditEntry(50_000_000) } });
  const close = () => [seq, eth, sol, daemon, iris].forEach((s) => s.server.close());
  return { seq, chain, eth: eth.eth, ethUrl: eth.url, sol: sol.sol, daemon: daemon.daemon, cfg, dir, auditLog, close };
}

const logs = [];
const run = (w, extra = {}) => takeSnapshot(w.cfg, { signer: key, log: (m) => logs.push(m), ...extra });

test("snapshots are taken, chained, skipped when current, and refused over a tampered history", async (t) => {
  const w = await world();
  t.after(w.close);
  w.chain.tip = 3000;
  w.eth.finalized = 20000;

  // ---- the first snapshot ----
  const r = await run(w);
  assert.equal(r.status, "written");
  assert.equal(r.height, 2880);
  const s = readSnapshot(w.cfg.snapshotDir, 2880);
  assert.equal(fs.readFileSync(r.file, "utf8"), fileText(s), "the file is canonical");
  assert.deepEqual(verifySnapshot(s, { attester: key.address }).errors, []);
  assert.deepEqual(checkFigures(s.payload), []);
  const p = s.payload;
  assert.equal(p.previous, null);
  assert.equal(p.attester, key.address);
  assert.equal(p.sequentia.blockHash, w.chain.hashOf(2880));
  assert.equal(p.sequentia.genesisHash, w.chain.hashOf(0));
  assert.equal(p.sequentia.time, w.chain.timeOf(2880));
  assert.equal(p.sequentia.auditor.exitStatus, 0);
  assert.equal(p.sequentia.auditor.sha256.length, 64);
  // Ethereum at the same moment: the last block at or before H's time.
  assert.equal(p.ethereum.block, (w.chain.timeOf(2880) - w.chain.t0) / 12);
  assert.equal(p.ethereum.blockHash, w.eth.blockHash(p.ethereum.block));
  assert.equal(p.solana.slot, 100);
  assert.equal(p.solana.pastSlotQueryable, false);
  assert.deepEqual(p.solana.owners, [TREASURY, INTENT]);

  assert.deepEqual(p.assets.map((a) => a.ticker), ["USDC.e", "ETH.e"], "sorted by asset id, retired assets left out");
  const [usdc, ether] = p.assets;
  // 16 USDC in the vault less 1 owed, 4 on Solana, 1 burned in transit by CCTP.
  assert.equal(usdc.sources[0].escrowUnits, "15000000");
  assert.deepEqual(
    usdc.sources[0].holdings.map((h) => [h.vault, h.deployed, h.version, h.balance, h.owed, h.backing]),
    [
      [V1, true, null, "0", "0", "0"],
      [LATE, false, null, "0", "0", "0"],
      [V3, true, 3, "16000000", "1000000", "15000000"],
    ]
  );
  assert.equal(usdc.sources[1].escrowUnits, "4000000");
  assert.equal(usdc.escrowAtoms, "19000000");
  assert.equal(usdc.inTransitAtoms, "1000000");
  // The week's transfers, each judged on chain: DONE had reached Ethereum by
  // B (its nonce was used) and is in the vault's balance; BURN had not.
  assert.deepEqual(
    usdc.inTransit.map((c) => [c.solanaBurn, c.counted, c.receivedByB, c.nonce]),
    [
      ["DONE", false, true, NONCE_DONE],
      ["BURN", true, false, NONCE_BURN],
    ]
  );
  assert.equal(usdc.supply.circulatingAtoms, "20000000");
  assert.equal(usdc.backed, true);
  assert.equal(ether.escrowAtoms, "50000000", "0.5 ether in 8-decimal atoms");
  assert.equal(ether.backed, true);

  // The node's credentials went to a private cookie file, never the command line.
  const audit = JSON.parse(fs.readFileSync(w.auditLog, "utf8"));
  assert.equal(audit.cookie, "u:p");
  assert.ok(!audit.argv.some((a) => a.includes("u:p") || a.includes("@")), audit.argv.join(" "));
  assert.deepEqual(audit.argv.slice(audit.argv.indexOf("--end"), audit.argv.indexOf("--end") + 2), ["--end", "2880"]);

  // ---- the same height again: nothing to do, nothing rewritten ----
  const before = fs.readFileSync(r.file, "utf8");
  w.chain.tip = 4000;
  assert.equal((await run(w)).status, "up-to-date");
  assert.equal(fs.readFileSync(r.file, "utf8"), before);

  // ---- Ethereum has not finalized past H's time yet ----
  w.chain.tip = 4400;
  w.eth.finalized = (w.chain.timeOf(4320) - w.chain.t0) / 12; // exactly H's time: not after it
  const early = await run(w);
  assert.equal(early.status, "not-yet");
  assert.match(early.reason, /not finalized/);

  // ---- the next snapshot links to the first, and the checkpoint is resumed ----
  w.eth.finalized = 30000;
  logs.length = 0;
  const r2 = await run(w);
  assert.equal(r2.status, "written");
  assert.equal(r2.height, 4320);
  const s2 = readSnapshot(w.cfg.snapshotDir, 4320);
  assert.deepEqual(s2.payload.previous, { height: 2880, hash: s.hash });
  assert.deepEqual(verifyChain([s, s2], { attester: key.address }).errors, []);
  assert.ok(!logs.some((m) => /discarded/.test(m)), logs.join("\n"));
  const idx = JSON.parse(fs.readFileSync(path.join(w.cfg.snapshotDir, "index.json"), "utf8"));
  assert.deepEqual(idx.snapshots.map((e) => e.height), [2880, 4320]);
  // The vault deployed in between now counts, at its own figures.
  assert.equal(s2.payload.assets[0].sources[0].holdings[1].deployed, true);

  // ---- the verify tool agrees, and re-derives the Ethereum side ----
  // Asynchronously: the stand-in nodes answer from this same process.
  const verify = (...args) =>
    new Promise((resolve) =>
      execFile(process.execPath, [path.join(here, "..", "verify.mjs"), ...args], (err, stdout, stderr) =>
        resolve({ status: err ? err.code : 0, stdout, stderr })
      )
    );
  const good = await verify(w.cfg.snapshotDir, "--attester", key.address, "--rederive", "--eth-rpc", w.ethUrl);
  assert.equal(good.status, 0, good.stdout + good.stderr);
  assert.match(good.stdout, /hash chain intact over 2 snapshots/);
  assert.match(good.stdout, /is the last at or before Sequentia block 4320's time/);
  const wrongKey = await verify(w.cfg.snapshotDir, "--attester", ethers.Wallet.createRandom().address);
  assert.equal(wrongKey.status, 1);
  assert.match(wrongKey.stdout, /not by the expected attester/);
  const one = await verify(path.join(w.cfg.snapshotDir, "4320.json"), "--attester", key.address);
  assert.equal(one.status, 0, one.stdout);
  assert.match(one.stdout, /4320 links to 2880/);

  // ---- a history that no longer verifies is not extended ----
  const tampered = JSON.parse(before);
  tampered.payload.assets[0].escrowAtoms = "99000000";
  fs.chmodSync(r.file, 0o644);
  fs.rmSync(r.file);
  fs.writeFileSync(r.file, fileText(tampered));
  w.chain.tip = 5800;
  w.eth.finalized = 40000;
  await assert.rejects(run(w), /does not verify, refusing to extend it/);
  assert.ok(!fs.existsSync(path.join(w.cfg.snapshotDir, "5760.json")));
  const caught = await verify(w.cfg.snapshotDir, "--attester", key.address);
  assert.equal(caught.status, 1);
});

test("a figure the auditor can only bound is recorded as such, with no verdict", async (t) => {
  const w = await world();
  t.after(w.close);
  w.chain.tip = 1500;
  w.eth.finalized = 20000;
  process.env.FAKE_AUDIT_EXIT = "2";
  process.env.FAKE_AUDIT_REPORT = JSON.stringify({
    assets: { [U]: { ...auditEntry(20_000_000), exact: false, blinded_reissuances: 1 }, [E]: auditEntry(50_000_000) },
  });
  const r = await run(w);
  assert.equal(r.status, "written");
  const p = readSnapshot(w.cfg.snapshotDir, 1440).payload;
  assert.equal(p.sequentia.auditor.exitStatus, 2);
  assert.equal(p.sequentia.auditor.exact, false);
  assert.equal(p.assets[0].supply.exact, false);
  assert.equal(p.assets[0].backed, null);
  assert.equal(p.assets[1].backed, true);
});

test("an auditor failure writes nothing", async (t) => {
  const w = await world();
  t.after(w.close);
  w.chain.tip = 1500;
  w.eth.finalized = 20000;
  process.env.FAKE_AUDIT_EXIT = "1";
  await assert.rejects(run(w), /the supply auditor failed \(exit 1\): RuntimeError: getblock/);
  assert.ok(!fs.existsSync(path.join(w.cfg.snapshotDir, "1440.json")));
});

test("an unreadable source leaves the escrow unknown, never zero", async (t) => {
  const w = await world();
  t.after(w.close);
  w.chain.tip = 1500;
  w.eth.finalized = 20000;
  w.sol.genesis = "GENESIS";
  const cfg = { ...w.cfg, solRpcUrl: undefined };
  const r = await takeSnapshot(cfg, { signer: key });
  const usdc = r.payload.assets[0];
  assert.equal(usdc.sources[1].escrowUnits, null);
  assert.match(usdc.sources[1].error, /no reader/);
  assert.equal(usdc.escrowAtoms, null);
  assert.equal(usdc.backed, null);
  assert.deepEqual(checkFigures(r.payload), []);
});

test("the tool refuses a daemon that names a different Solana treasury", async (t) => {
  const w = await world();
  t.after(w.close);
  w.chain.tip = 1500;
  w.eth.finalized = 20000;
  w.daemon.intents = { treasury: INTENT, addresses: [] };
  await assert.rejects(run(w), /names Solana treasury/);
});

test("a dry run signs and writes nothing", async (t) => {
  const w = await world();
  t.after(w.close);
  w.chain.tip = 1500;
  w.eth.finalized = 20000;
  const r = await takeSnapshot(w.cfg, { dryRun: true });
  assert.equal(r.status, "dry-run");
  assert.equal(r.payload.height, 1440);
  assert.ok(!fs.existsSync(w.cfg.snapshotDir) || fs.readdirSync(w.cfg.snapshotDir).length === 0);
});

test("a vault without a configured version is refused before anything is read", async () => {
  const w = await world();
  try {
    w.cfg.vaults = w.cfg.vaults.map(({ version, ...v }) => v);
    await assert.rejects(run(w), /has no "version" in the configuration/);
  } finally {
    w.close();
  }
});
