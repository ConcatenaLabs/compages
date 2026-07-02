// Compages e2e driver: exercises the full bridge lifecycle against the
// stack brought up by run-e2e.sh. Exits non-zero on the first failed check.

import { ethers } from "ethers";
import crypto from "node:crypto";

// Asset-id derivation from (issuance prevout, contract_hash), mirroring the
// registry's deriveAssetId (Elements GenerateAssetEntropy/CalculateAsset via
// SHA256-midstate fast-merkle). Used to prove the asset was issued committed to
// the contract hash the bridge computed.
function sha256Midstate(block64) {
  const K = new Uint32Array([
    0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,0x923f82a4,0xab1c5ed5,
    0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,
    0xe49b69c1,0xefbe4786,0x0fc19dc6,0x240ca1cc,0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,
    0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,0xc6e00bf3,0xd5a79147,0x06ca6351,0x14292967,
    0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,
    0xa2bfe8a1,0xa81a664b,0xc24b8b70,0xc76c51a3,0xd192e819,0xd6990624,0xf40e3585,0x106aa070,
    0x19a4c116,0x1e376c08,0x2748774c,0x34b0bcb5,0x391c0cb3,0x4ed8aa4a,0x5b9cca4f,0x682e6ff3,
    0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2]);
  let h0=0x6a09e667,h1=0xbb67ae85,h2=0x3c6ef372,h3=0xa54ff53a,h4=0x510e527f,h5=0x9b05688c,h6=0x1f83d9ab,h7=0x5be0cd19;
  const w=new Uint32Array(64);
  for(let i=0;i<16;i++)w[i]=block64.readUInt32BE(i*4);
  const r=(x,n)=>((x>>>n)|(x<<(32-n)))>>>0;
  for(let i=16;i<64;i++){const s0=(r(w[i-15],7)^r(w[i-15],18)^(w[i-15]>>>3))>>>0;const s1=(r(w[i-2],17)^r(w[i-2],19)^(w[i-2]>>>10))>>>0;w[i]=(w[i-16]+s0+w[i-7]+s1)>>>0;}
  let a=h0,b=h1,c=h2,d=h3,e=h4,f=h5,g=h6,h=h7;
  for(let i=0;i<64;i++){const S1=(r(e,6)^r(e,11)^r(e,25))>>>0;const ch=((e&f)^(~e&g))>>>0;const t1=(h+S1+ch+K[i]+w[i])>>>0;const S0=(r(a,2)^r(a,13)^r(a,22))>>>0;const mj=((a&b)^(a&c)^(b&c))>>>0;const t2=(S0+mj)>>>0;h=g;g=f;f=e;e=(d+t1)>>>0;d=c;c=b;b=a;a=(t1+t2)>>>0;}
  const o=Buffer.alloc(32);
  o.writeUInt32BE((h0+a)>>>0,0);o.writeUInt32BE((h1+b)>>>0,4);o.writeUInt32BE((h2+c)>>>0,8);o.writeUInt32BE((h3+d)>>>0,12);
  o.writeUInt32BE((h4+e)>>>0,16);o.writeUInt32BE((h5+f)>>>0,20);o.writeUInt32BE((h6+g)>>>0,24);o.writeUInt32BE((h7+h)>>>0,28);
  return o;
}
const merkleNode = (l, rr) => sha256Midstate(Buffer.concat([l, rr]));
function deriveAssetId(prevoutTxid, prevoutVout, contractHashHex) {
  const txidInternal = Buffer.from(prevoutTxid, "hex").reverse();
  const vout = Buffer.alloc(4); vout.writeUInt32LE(prevoutVout, 0);
  const sha = (b) => crypto.createHash("sha256").update(b).digest();
  const leafPrevout = sha(sha(Buffer.concat([txidInternal, vout])));
  const entropy = merkleNode(leafPrevout, Buffer.from(contractHashHex, "hex"));
  return Buffer.from(merkleNode(entropy, Buffer.alloc(32))).reverse().toString("hex");
}

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
// The user already holds FEEX (funded by the miner in run-e2e.sh) and pays
// its own redeem-send fee in FEEX too; no participant but the miner ever
// touches the policy asset.
const intent = await api("redeem", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ ethAddress: RECEIVER }),
});
console.log(`redemption address: ${intent.seqAddress}`);
const recvBefore = await musd.balanceOf(RECEIVER);
await seqRpc(
  "sendtoaddress",
  { address: intent.seqAddress, amount: 30, assetlabel: minted1.assetId, fee_asset_label: process.env.FEEX },
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

// ---------------- test 6: the bridge never touched the policy asset --------
console.log("\n-- fee-asset independence: bridge paid every fee in FEEX, never the policy asset");
const bridgeBal = await seqRpc("getbalance", {}, "compages");
check(
  "bridge wallet holds zero policy asset (all fees paid in FEEX)",
  (bridgeBal["bitcoin"] ?? 0) === 0,
  `policy balance ${bridgeBal["bitcoin"] ?? 0}`
);

// ---------------- test 7: asset registry integration ----------------
if (process.env.REGISTRY_URL) {
  console.log("\n-- asset registry: bridged assets registered with human-readable metadata");
  const reg = async (p) => (await fetch(`${process.env.REGISTRY_URL}${p}`)).json();
  const minimal = await waitFor("registry has the MUSD-bridged asset", async () => {
    const m = await reg("/index.minimal.json");
    return m[minted1.assetId] ? m : null;
  });
  // minimal index entry: [domain, ticker, name, precision, verified]
  const [, ticker, name, precision] = minimal[minted1.assetId];
  check("bridged MUSD registered as ticker MUSD.e", ticker === "MUSD.e", ticker);
  check("registry precision is 8", precision === 8, `${precision}`);
  check("registry name records the Ethereum origin", /bridged from/i.test(name), name);
  check("bridged ETH registered as ticker ETH.e", minimal[minted3.assetId]?.[1] === "ETH.e", minimal[minted3.assetId]?.[1]);

  // The asset was issued committed to SHA256(canonical-JSON(contract)), so the
  // metadata is bound on-chain, not just asserted by the operator.
  const assets = await api("assets");
  const m = assets.find((a) => a.assetId === minted1.assetId);
  check("daemon recorded a 32-byte contract hash", /^[0-9a-f]{64}$/.test(m.contractHash || ""), m.contractHash);
  const raw = await seqRpc("getrawtransaction", { txid: m.issueTxid, verbose: true });
  const vin = (raw.vin || []).find((v) => v.issuance && !v.issuance.isreissuance);
  const reversedHash = m.contractHash.match(/../g).reverse().join("");
  const derivedFwd = vin ? deriveAssetId(vin.txid, vin.vout, m.contractHash) : null;
  const derivedRev = vin ? deriveAssetId(vin.txid, vin.vout, reversedHash) : null;
  const order = derivedFwd === minted1.assetId ? "as-is" : derivedRev === minted1.assetId ? "byte-reversed" : "no-match";
  check(
    "asset id re-derives from (issuance prevout, contract hash) — on-chain binding",
    order !== "no-match",
    `contract-hash leaf order: ${order} (fwd=${derivedFwd})`
  );
}

// ---------------- summary ----------------
clearInterval(miner);
console.log(failures ? `\n${failures} CHECK(S) FAILED` : "\nALL CHECKS PASSED");
process.exit(failures ? 1 : 0);
