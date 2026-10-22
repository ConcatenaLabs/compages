// Height choice, the Ethereum block search, and the figures' arithmetic.
// Run: npm test
import test from "node:test";
import assert from "node:assert/strict";
import { chooseHeight, unitsToAtoms, vaultBacking, supplyFromAudit, backedVerdict, lastBlockAtOrBefore } from "../lib/figures.mjs";
import { checkFigures } from "../lib/consistency.mjs";
import { escrowAccounts } from "../lib/chains.mjs";

test("the height is the latest multiple of the interval at least minDepth deep", () => {
  assert.equal(chooseHeight(3000, 1440, 10), 2880);
  assert.equal(chooseHeight(2890, 1440, 10), 2880);
  assert.equal(chooseHeight(2889, 1440, 10), 1440, "2880 is only 9 deep");
  assert.equal(chooseHeight(1449, 1440, 10), null);
  assert.equal(chooseHeight(100, 1440, 10), null);
  assert.equal(chooseHeight(2880, 1440, 0), 2880);
  assert.throws(() => chooseHeight(3000, 0, 10));
});

test("units convert to atoms by the asset's precision, flooring", () => {
  assert.equal(unitsToAtoms(1_000_000_000n, 9, 8), 100_000_000n);
  assert.equal(unitsToAtoms(19n, 9, 8), 1n);
  assert.equal(unitsToAtoms(4_000_000n, 6, 6), 4_000_000n);
  assert.equal(unitsToAtoms(1n, 6, 8), 100n);
});

test("reservations are not backing, and backing never goes negative", () => {
  assert.equal(vaultBacking({ balance: 100n, owed: 10n, queued: 20n, cancelled: 5n }), 65n);
  assert.equal(vaultBacking({ balance: "10", owed: "30" }), 0n);
});

test("supply comes from the auditor's report, and only exact figures are exact", () => {
  const report = {
    assets: {
      a: { issued_atoms: 0, reissued_atoms: 30, burned_atoms: 10, circulating_atoms: 20, exact: true, blinded_issuances: 0, blinded_reissuances: 0, blinded_burns: 0 },
      b: { issued_atoms: 5, reissued_atoms: 0, burned_atoms: 0, circulating_atoms: 5, exact: false, blinded_issuances: 1, blinded_reissuances: 0, blinded_burns: 0 },
      c: { issued_atoms: 0, reissued_atoms: 0, burned_atoms: 7, circulating_atoms: -7, exact: true, blinded_issuances: 0, blinded_reissuances: 0, blinded_burns: 0 },
    },
  };
  assert.equal(supplyFromAudit(report, "a").circulatingAtoms, "20");
  assert.equal(supplyFromAudit(report, "a").exact, true);
  const b = supplyFromAudit(report, "b");
  assert.equal(b.exact, false);
  assert.match(b.error, /bound/);
  const c = supplyFromAudit(report, "c");
  assert.equal(c.circulatingAtoms, null);
  assert.match(c.error, /not on this chain/);
  const none = supplyFromAudit(report, "d");
  assert.equal(none.seen, false);
  assert.equal(none.circulatingAtoms, "0");
});

test("a verdict is given only when every figure was measured exactly", () => {
  const supply = { circulatingAtoms: "100", exact: true };
  assert.equal(backedVerdict({ supply, escrowAtoms: "100" }), true);
  assert.equal(backedVerdict({ supply, escrowAtoms: "99" }), false);
  assert.equal(backedVerdict({ supply, escrowAtoms: "90", inTransitAtoms: "10" }), true);
  assert.equal(backedVerdict({ supply, escrowAtoms: null }), null);
  assert.equal(backedVerdict({ supply: { circulatingAtoms: "100", exact: false }, escrowAtoms: "1000" }), null);
  assert.equal(backedVerdict({ supply: { circulatingAtoms: null, exact: true }, escrowAtoms: "1" }), null);
});

test("the Ethereum block is the last one at or before the time, and unique", async () => {
  // Blocks every 12 s from t=1000, with one gap of a missed slot.
  const ts = (n) => 1000 + 12 * n + (n >= 50 ? 12 : 0);
  let calls = 0;
  const getBlock = async (n) => (calls++, { number: n, timestamp: ts(n) });
  const hi = { number: 1000, timestamp: ts(1000) };
  for (const [t, want] of [
    [1000, 0],
    [1011, 0],
    [1012, 1],
    [1000 + 12 * 49 + 23, 49], // inside the gap
    [ts(50), 50],
    [ts(999) + 11, 999],
  ]) {
    const b = await lastBlockAtOrBefore(getBlock, t, hi);
    assert.equal(b.number, want, `t=${t}`);
    assert.ok(b.timestamp <= t && ts(b.number + 1) > t);
  }
  assert.ok(calls < 6 * 14, "a binary search, not a scan");
  await assert.rejects(lastBlockAtOrBefore(getBlock, 999, hi), /before the chain's first block/);
  await assert.rejects(lastBlockAtOrBefore(getBlock, ts(1000), hi), /not after/);
});

test("the consistency check recomputes every derived figure", () => {
  const owner = "76ZPjfcZGjidKPm9eqmCADKvkYzsEfTwv1wroANJZuhv";
  const mint = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU";
  const ata = escrowAccounts([owner], mint)[0];
  const payload = {
    ethereum: { chainId: 11155111, vaults: ["0x7B702D6A2E2351F0c4E549642e65AbABC0324384"] },
    solana: { cluster: "solana-devnet", owners: [owner] },
    assets: [
      {
        assetId: "ab",
        ticker: "USDC.e",
        precision: 6,
        supply: { seen: true, circulatingAtoms: "20000000", issuedAtoms: "0", reissuedAtoms: "20000000", burnedAtoms: "0", exact: true },
        sources: [
          {
            chainId: 11155111,
            token: "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238",
            decimals: 6,
            escrowUnits: "16000000",
            escrowAtoms: "16000000",
            holdings: [{ vault: "0x7B702D6A2E2351F0c4E549642e65AbABC0324384", balance: "16000000", owed: "0", queued: "0", cancelled: "0", backing: "16000000" }],
          },
          { chainId: "solana-devnet", token: mint, decimals: 6, escrowUnits: "4000000", escrowAtoms: "4000000", holdings: [{ owner, account: ata.account, units: "4000000" }] },
        ],
        escrowAtoms: "20000000",
        inTransitAtoms: "0",
        inTransit: [],
        backed: true,
      },
    ],
  };
  assert.deepEqual(checkFigures(payload), []);
  const bad = (f) => {
    const p = structuredClone(payload);
    f(p.assets[0]);
    return checkFigures(p).join("; ");
  };
  assert.match(bad((a) => (a.backed = false)), /the figures say true/);
  assert.match(bad((a) => (a.sources[0].holdings[0].owed = "1")), /backing 16000000 should be 15999999/);
  assert.match(bad((a) => (a.sources[1].holdings[0].account = owner)), /is not an escrow account/);
  assert.match(bad((a) => (a.escrowAtoms = "30000000")), /escrowAtoms 30000000 should be 20000000/);
  assert.match(bad((a) => (a.supply.burnedAtoms = "1")), /circulating 20000000 should be 19999999/);
  assert.match(bad((a) => (a.inTransit = [{ counted: true, amount: "5" }])), /inTransitAtoms 0 should be 5/);

  // An issuer-operated asset: the units live under burn-only sweeps at H are
  // deducted, each output made at or below H, one spent above it.
  const io = structuredClone(payload);
  io.height = 100;
  const a = io.assets[0];
  a.supply.reissuedAtoms = a.supply.circulatingAtoms = "23000000";
  a.burnOnly = {
    liveAtoms: "3000000",
    outputs: [
      { outpoint: "r1:1", value: "2000000", kind: "batch", round: "r1:1", height: 90 },
      { outpoint: "r0:1", value: "1000000", kind: "batch", round: "r0:1", height: 80, spentBy: "s", spentAt: 101 },
    ],
    mintedAtoms: "3000000",
    mints: [{ txid: "r0", amount: "1000000", height: 80 }, { txid: "r1", amount: "2000000", height: 90 }],
    burnedAtoms: "0",
    burns: [],
    deductedAtoms: "3000000",
  };
  assert.deepEqual(checkFigures(io), []);
  const badIo = (f) => {
    const p = structuredClone(io);
    f(p.assets[0]);
    return checkFigures(p).join("; ");
  };
  assert.match(badIo((x) => (x.burnOnly.liveAtoms = "4000000")), /liveAtoms 4000000 should be 3000000/);
  assert.match(badIo((x) => (x.burnOnly.deductedAtoms = "2000000")), /deductedAtoms 2000000 should be 3000000/);
  // A burn of the operator's at or below H: the smaller figure is deducted.
  assert.match(badIo((x) => {
    x.burnOnly.burns = [{ txid: "b", amount: "500000", height: 95 }];
    x.burnOnly.burnedAtoms = "500000";
  }), /deductedAtoms 3000000 should be 2500000/);
  assert.match(badIo((x) => (x.burnOnly.mints[1].height = 101)), /r1 is in block 101, above H/);
  assert.match(badIo((x) => (x.burnOnly.outputs[0].height = 101)), /made at 101, above H/);
  assert.match(badIo((x) => (x.burnOnly.outputs[1].spentAt = 100)), /spent at 100, not above H/);
  assert.match(badIo((x) => x.burnOnly.outputs.push({ ...x.burnOnly.outputs[0] })), /counted twice/);
  assert.match(badIo((x) => (x.backed = false)), /the figures say true/);
  // Without the deduction the same figures are short.
  assert.match(badIo((x) => delete x.burnOnly), /backed is true, the figures say false/);
});

test("the deduction under burn-only sweeps enters the verdict", () => {
  const supply = { circulatingAtoms: "1500", exact: true };
  assert.equal(backedVerdict({ supply, escrowAtoms: "1000" }), false);
  assert.equal(backedVerdict({ supply, escrowAtoms: "1000", deductedAtoms: "500" }), true);
  assert.equal(backedVerdict({ supply, escrowAtoms: "1000", deductedAtoms: "499" }), false);
  assert.equal(backedVerdict({ supply, escrowAtoms: "2000", deductedAtoms: "-500" }), true, "a negative deduction adds");
  assert.equal(backedVerdict({ supply, escrowAtoms: "1999", deductedAtoms: "-500" }), false);
  assert.equal(backedVerdict({ supply, escrowAtoms: "1000", deductedAtoms: null }), null);
});

test("a pinned vault version is used, so a backend without the state cannot make a v3 vault read long", async () => {
  const { mockEthereum } = await import("./mocks.mjs");
  const { ethProvider, vaultFigures } = await import("../lib/chains.mjs");
  const { ethers } = await import("ethers");
  const VAULT = ethers.getAddress("0x00000000000000000000000000000000000000a1");
  const USDC = ethers.getAddress("0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238");
  // A version-3 vault holding 7 with 2 owed, behind a backend whose answer
  // to VERSION() is a data-less revert, as when it lacks the state at B.
  const { eth, server, url } = await mockEthereum({
    finalized: 100,
    vaults: {
      [VAULT]: { deployedAt: 1, version: 3, versionError: true, tokens: { [USDC]: () => 7n }, reserved: (fn) => (fn === "owedTotal" ? 2n : 0n) },
    },
  });
  try {
    const provider = ethProvider(url, eth.chainId);
    const asked = await vaultFigures(provider, VAULT, USDC, 50);
    assert.equal(asked.backing, "7", "asked, the failure reads as an older vault and the owed payout as backing");
    eth.calls.length = 0;
    const pinned = await vaultFigures(provider, VAULT, USDC, 50, 3);
    assert.equal(pinned.version, 3);
    assert.equal(pinned.owed, "2");
    assert.equal(pinned.backing, "5");
    const older = await vaultFigures(provider, VAULT, USDC, 50, 1);
    assert.equal(older.version, null, "an older vault is recorded as having no VERSION()");
  } finally {
    server.close();
  }
});
