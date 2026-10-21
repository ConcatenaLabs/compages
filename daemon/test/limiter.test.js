import test from "node:test";
import assert from "node:assert/strict";
import { mintNext, limits, limiterView, explicitCoin, MIN_AGE, MintLimiter } from "../lib/limiter.js";

// The instance of sequentia-contracts' m1 harness test: a window of 20
// blocks, an allowance of 1,000,000,000 atoms.
const instance = {
  instance: 2,
  template_hash: "77218080daacd33cb636f1411920eb5f2d6ee805cb94d8d0651ce1808c0b557b",
  params: { WINDOW: "0014", ALLOWANCE: "000000003b9aca00", RECOVERY_DELAY: "0002" },
  genesis: "00".repeat(32),
};
const s = (minted, elapsed, armed = 0) => ({ minted: String(minted), elapsed, armed });

test("the limits read from the instance's parameters", () => {
  assert.deepEqual(limits(instance), { window: 20, allowance: 1_000_000_000n, recoveryDelay: 2 });
});

test("a mint within the window adds to the count and to the window's blocks", () => {
  assert.deepEqual(mintNext(instance, s(0, 0), 2, 500_000_000n), { next: s(500_000_000, 2) });
  assert.deepEqual(mintNext(instance, s(500_000_000, 2), 2, 500_000_000n), { next: s(1_000_000_000, 4) });
});

test("over the allowance waits for the window's end, in blocks", () => {
  const r = mintNext(instance, s(1_000_000_000, 4), 2, 1n);
  assert.match(r.refused, /allowance/);
  assert.equal(r.waitBlocks, 14);
  assert.ok(!r.never);
});

test("the window ends once its blocks reach WINDOW, and the count restarts", () => {
  assert.equal(mintNext(instance, s(1_000_000_000, 4), 15, 1n).refused !== undefined, true);
  assert.deepEqual(mintNext(instance, s(1_000_000_000, 4), 16, 1_000_000_000n), { next: s(1_000_000_000, 0) });
});

test("more than a whole allowance never mints", () => {
  const r = mintNext(instance, s(0, 0), 50, 1_000_000_001n);
  assert.ok(r.never);
});

test("a coin under two blocks old, and a braked coin, wait", () => {
  assert.equal(MIN_AGE, 2);
  assert.equal(mintNext(instance, s(0, 0), 1, 1n).waitBlocks, 1);
  assert.match(mintNext(instance, s(0, 0, 1), 5, 1n).refused, /brake/);
});

test("the view names the coin, its state and its limits", () => {
  const v = limiterView({
    reissuanceToken: "ab".repeat(32),
    limiter: { instance, address: "ert1p…", coin: { txid: "cd".repeat(32), vout: 0 }, state: s(7, 3), tokenAtoms: "100000000" },
  });
  assert.equal(v.windowBlocks, 20);
  assert.equal(v.allowanceAtoms, "1000000000");
  assert.equal(v.recoveryDelaySeconds, 1024);
  assert.equal(v.braked, false);
  assert.equal(v.tokenId, "ab".repeat(32));
  assert.equal(limiterView({}), null);
});

test("only an explicit coin pays a covenant spend's fee", () => {
  const z = "00".repeat(32);
  assert.equal(explicitCoin({ amount: 1, amountblinder: z, assetblinder: z }), true);
  assert.equal(explicitCoin({ amount: 1 }), true);
  assert.equal(explicitCoin({ amount: 1, amountcommitment: "08ab", amountblinder: "11".repeat(32), assetblinder: "22".repeat(32) }), false);
  assert.equal(explicitCoin({ amount: 1, amountblinder: "11".repeat(32), assetblinder: z }), false);
});

// A supervised asset's issuance, as decoderawtransaction reads it, names other
// ids than the chain gives the asset; the wallet's own record of the issuance
// is the one that knows its token.
test("the token's supply of a supervised issuance is read from the wallet's record", async () => {
  const mapping = { assetId: "91".repeat(32), reissuanceToken: "f5".repeat(32), issueTxid: "e8".repeat(32) };
  const seq = {
    call: async (m, p) => {
      if (m === "gettransaction") return { hex: "00" };
      if (m === "listissuances") {
        assert.equal(p.asset, mapping.assetId);
        return [
          { txid: mapping.issueTxid, asset: mapping.assetId, token: mapping.reissuanceToken, isreissuance: false, tokenamount: 1.0 },
          { txid: "c5".repeat(32), asset: mapping.assetId, isreissuance: true },
        ];
      }
      throw new Error("unexpected " + m);
    },
    node: async (m) => {
      if (m === "decoderawtransaction") return { vin: [{ issuance: { asset: "b7".repeat(32), token: "06".repeat(32), isreissuance: false, tokenamount: 1.0 } }] };
      throw new Error("unexpected " + m);
    },
  };
  const lim = new MintLimiter({ seqFeeAsset: "aa".repeat(32), mintLimiter: { tool: "t", operatorMnemonicFile: "f", coldKey: "k", windowBlocks: 1440, recoveryDelay: 1182 } }, seq);
  assert.equal(await lim.tokenSupply(mapping), 100_000_000n);
  await assert.rejects(lim.tokenSupply({ ...mapping, reissuanceToken: "ee".repeat(32) }), /does not issue token/);
});

// A tool that exits before reading its request reports its own error; the
// write to its closed stdin does not crash the process.
test("a tool that exits at once is reported, not a crash", async () => {
  const fs = await import("node:fs");
  const os = await import("node:os");
  const path = await import("node:path");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "limiter-tool-"));
  const tool = path.join(dir, "tool");
  fs.writeFileSync(tool, "#!/bin/sh\necho 'mint-limiter: refused: an argument it does not know' >&2\nexit 2\n", { mode: 0o755 });
  try {
    const lim = new MintLimiter({ seqFeeAsset: "aa".repeat(32), mintLimiter: { tool, operatorMnemonicFile: "f", coldKey: "k", windowBlocks: 1440, recoveryDelay: 1182 } }, {});
    await assert.rejects(lim.tool(["x"], { big: "y".repeat(1 << 20) }), /refused: an argument it does not know/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
