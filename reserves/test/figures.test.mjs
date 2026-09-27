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
});
