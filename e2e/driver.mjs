// Compages e2e driver: exercises the full bridge lifecycle against the
// stack brought up by run-e2e.sh. Exits non-zero on the first failed check.

import { ethers } from "ethers";

const ANVIL = `http://127.0.0.1:${process.env.ANVIL_PORT}`;
const API = `http://127.0.0.1:${process.env.API_PORT}/api`;
const SEQ = `http://127.0.0.1:${process.env.SEQ_RPC}`;
const SEQ_AUTH = "Basic " + Buffer.from("e2e:e2e").toString("base64");

const provider = new ethers.JsonRpcProvider(ANVIL, 31337, { staticNetwork: true });
const user = new ethers.Wallet(process.env.USER_KEY, provider);
const RECEIVER = "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC"; // anvil #2, untouched

const vault = new ethers.Contract(
  process.env.VAULT,
  [
    "function depositEther(string sequentiaAddress) payable",
    "function depositToken(address token, uint256 amount, string sequentiaAddress)",
  ],
  user
);
const musd = new ethers.Contract(
  process.env.MUSD,
  [
    "function approve(address,uint256) returns (bool)",
    "function balanceOf(address) view returns (uint256)",
  ],
  user
);

let failures = 0;
function check(name, cond, detail = "") {
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
  if (!cond) failures++;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function seqRpc(method, params = {}, wallet = null) {
  const url = wallet ? `${SEQ}/wallet/${wallet}` : SEQ;
  const res = await fetch(url, {
    method: "POST",
    headers: { authorization: SEQ_AUTH, "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: "e2e", method, params }),
  });
  const j = await res.json();
  if (j.error) throw new Error(`${method}: ${j.error.message}`);
  return j.result;
}

async function api(path, opts) {
  const res = await fetch(`${API}/${path}`, opts);
  const j = await res.json();
  if (!res.ok) throw new Error(j.error ?? `HTTP ${res.status}`);
  return j;
}

// keep Sequentia blocks flowing (anvil mines by itself via --block-time)
const mineAddr = await seqRpc("getnewaddress", {}, "compages");
const miner = setInterval(() => {
  seqRpc("generatetoaddress", { nblocks: 1, address: mineAddr }).catch(() => {});
}, 1200);

async function waitFor(desc, fn, timeoutMs = 90_000) {
  const t0 = Date.now();
  for (;;) {
    const v = await fn().catch(() => null);
    if (v) return v;
    if (Date.now() - t0 > timeoutMs) throw new Error(`timeout waiting for ${desc}`);
    await sleep(1500);
  }
}

async function seqAssetBalance(wallet, assetId) {
  const b = await seqRpc("getbalance", {}, wallet);
  return Math.round(((b ?? {})[assetId] ?? 0) * 1e8);
}

const userSeqAddr = await seqRpc("getnewaddress", {}, "user");
console.log(`user Sequentia address: ${userSeqAddr}`);

// ---------------- test 1: first deposit issues a NEW asset ----------------
console.log("\n-- deposit 100 MUSD (first bridge of this token)");
await (await musd.approve(process.env.VAULT, 150_000_000n)).wait();
const dep1 = await (await vault.depositToken(process.env.MUSD, 100_000_000n, userSeqAddr)).wait();

const minted1 = await waitFor("deposit 1 minted", async () => {
  const list = await api(`deposit/tx/${dep1.hash}`);
  return list[0]?.status === "minted" ? list[0] : null;
});
check("deposit 1 minted", true, `asset ${minted1.assetId?.slice(0, 12)}`);
check("deposit 1 amount is 100.00000000 on Sequentia", minted1.sats === "10000000000", minted1.sats);

const bal1 = await waitFor("user wallet sees 100 MUSD-asset", async () =>
  (await seqAssetBalance("user", minted1.assetId)) === 10000000000 ? 1 : null
);
check("user Sequentia wallet holds 100 of the bridged asset", !!bal1);

let assets = await api("assets");
check("exactly one bridged asset exists", assets.length === 1, `${assets.length}`);
check("bridged asset metadata is the ERC-20's", assets[0].symbol === "MUSD" && assets[0].decimals === 6);

// ---------------- test 2: second deposit REISSUES the same asset ----------------
console.log("\n-- deposit 50 MUSD more (must mint the same asset, no duplicate)");
const dep2 = await (await vault.depositToken(process.env.MUSD, 50_000_000n, userSeqAddr)).wait();
const minted2 = await waitFor("deposit 2 minted", async () => {
  const list = await api(`deposit/tx/${dep2.hash}`);
  return list[0]?.status === "minted" ? list[0] : null;
});
check("deposit 2 minted the SAME asset id", minted2.assetId === minted1.assetId);
assets = await api("assets");
check("still exactly one bridged asset (no duplicate)", assets.length === 1, `${assets.length}`);
await waitFor("user balance reaches 150", async () =>
  (await seqAssetBalance("user", minted1.assetId)) === 15000000000 ? 1 : null
);
check("user balance is 150 after reissue", true);

// ---------------- test 3: native ether bridges too ----------------
console.log("\n-- deposit 0.25 ETH");
const dep3 = await (await vault.depositEther(userSeqAddr, { value: ethers.parseEther("0.25") })).wait();
const minted3 = await waitFor("ETH deposit minted", async () => {
  const list = await api(`deposit/tx/${dep3.hash}`);
  return list[0]?.status === "minted" ? list[0] : null;
});
check("ETH minted as its own Sequentia asset", minted3.assetId && minted3.assetId !== minted1.assetId);
check("0.25 ETH -> 0.25000000 asset units", minted3.sats === "25000000", minted3.sats);
assets = await api("assets");
check("two bridged assets now", assets.length === 2, `${assets.length}`);

// ---------------- test 4: redemption releases the original ERC-20 ----------------
console.log("\n-- redeem 30 MUSD-asset back to Ethereum");
// the user wallet needs a little of the fee asset to pay the Sequentia fee
const userFeeAddr = await seqRpc("getnewaddress", {}, "user");
await seqRpc("sendtoaddress", { address: userFeeAddr, amount: 1 }, "compages");
await waitFor("user fee funds confirmed", async () =>
  ((await seqRpc("getbalance", {}, "user"))["bitcoin"] ?? 0) >= 1 ? 1 : null
);

const intent = await api("redeem", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ ethAddress: RECEIVER }),
});
console.log(`redemption address: ${intent.seqAddress}`);
const recvBefore = await musd.balanceOf(RECEIVER);
await seqRpc(
  "sendtoaddress",
  { address: intent.seqAddress, amount: 30, assetlabel: minted1.assetId, fee_asset_label: "bitcoin" },
  "user"
);

const redemption = await waitFor(
  "redemption released + destroyed",
  async () => {
    const r = await api(`redeem/${intent.seqAddress}`);
    return r.redemptions[0]?.status === "done" ? r.redemptions[0] : null;
  },
  120_000
);
const recvAfter = await musd.balanceOf(RECEIVER);
check("receiver got exactly 30 MUSD on Ethereum", recvAfter - recvBefore === 30_000_000n, `${recvAfter - recvBefore}`);
check("redemption destroyed the returned Sequentia amount", !!redemption.destroyTxid);
assets = await api("assets");
const musdAsset = assets.find((a) => a.assetId === minted1.assetId);
check("circulating supply decreased to 120", musdAsset.mintedSats === "12000000000", musdAsset.mintedSats);

// ---------------- test 5: undeliverable deposit is refunded ----------------
console.log("\n-- deposit with an invalid Sequentia address (must refund)");
const userMusdBefore = await musd.balanceOf(user.address);
await (await musd.approve(process.env.VAULT, 10_000_000n)).wait();
const dep5 = await (await vault.depositToken(process.env.MUSD, 10_000_000n, "zzzzzzzzzzzzzzzzzzzzzzzz")).wait();
await waitFor("refund executed", async () => {
  const list = await api(`deposit/tx/${dep5.hash}`);
  return list[0]?.status === "refunded" ? list[0] : null;
});
const userMusdAfter = await musd.balanceOf(user.address);
check("undeliverable deposit fully refunded on Ethereum", userMusdAfter === userMusdBefore);

// ---------------- summary ----------------
clearInterval(miner);
console.log(failures ? `\n${failures} CHECK(S) FAILED` : "\nALL CHECKS PASSED");
process.exit(failures ? 1 : 0);
