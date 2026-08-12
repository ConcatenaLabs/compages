#!/usr/bin/env node
// Mock Solana JSON-RPC node for the Compages e2e: an in-memory ledger behind
// the handful of methods the daemon and driver use. It independently DECODES
// every submitted transaction with its own parser (not the daemon's encoder)
// and verifies every required ed25519 signature over the message bytes, so an
// encoding bug in daemon/lib/sol.js fails here instead of only on devnet.
// Everything settles at "finalized" instantly; fees are the static 5000
// lamports per signature; blockhashes rotate and expire like the real thing.
//
// Usage: node mock-solana.mjs --port 18999

import http from "node:http";
import crypto from "node:crypto";
import { b58encode, b58decode, ed25519Verify, keypairFromSeed, SYSTEM_PROGRAM } from "../daemon/lib/sol.js";

const port = Number(process.argv[process.argv.indexOf("--port") + 1] || 18999);

const GENESIS = b58encode(crypto.createHash("sha256").update("mock-solana-genesis").digest());
const FAUCET = keypairFromSeed(crypto.createHash("sha256").update("mock-solana-faucet").digest()).address;
const FEE = 5000n;

const balances = new Map([[FAUCET, 10n ** 15n]]); // address -> lamports
const ledger = new Map(); // signature -> { slot, blockTime, err, accountKeys, preBalances, postBalances }
const byAddress = new Map(); // address -> [signature, ...] newest first
const blockhashes = new Map(); // blockhash -> lastValidBlockHeight
let height = 1000;
setInterval(() => { height++; }, 100).unref?.();

function currentBlockhash() {
  const bh = b58encode(crypto.createHash("sha256").update(`mock-bh:${Math.floor(height / 20)}`).digest());
  if (!blockhashes.has(bh)) blockhashes.set(bh, height + 150);
  return { blockhash: bh, lastValidBlockHeight: blockhashes.get(bh) };
}

function record(sig, accountKeys, pre, post, err) {
  ledger.set(sig, {
    slot: height,
    blockTime: Math.floor(Date.now() / 1000),
    err,
    accountKeys,
    preBalances: pre.map(Number),
    postBalances: post.map(Number),
  });
  for (const k of accountKeys) {
    if (!byAddress.has(k)) byAddress.set(k, []);
    byAddress.get(k).unshift(sig);
  }
}

const rpcErr = (code, message) => Object.assign(new Error(message), { rpcCode: code });

// Independent legacy-transaction parser (mirrors the wire format, not sol.js).
function parseTx(buf) {
  let o = 0;
  const shortvec = () => {
    let n = 0, shift = 0;
    for (;;) {
      const b = buf[o++];
      n |= (b & 0x7f) << shift;
      if (!(b & 0x80)) return n;
      shift += 7;
    }
  };
  const nsigs = shortvec();
  const sigs = [];
  for (let i = 0; i < nsigs; i++) { sigs.push(buf.subarray(o, o + 64)); o += 64; }
  const msgStart = o;
  const numRequired = buf[o++];
  o += 2; // read-only signed / unsigned counts (unused here)
  const nkeys = shortvec();
  const keys = [];
  for (let i = 0; i < nkeys; i++) { keys.push(b58encode(buf.subarray(o, o + 32))); o += 32; }
  const blockhash = b58encode(buf.subarray(o, o + 32)); o += 32;
  const ninstr = shortvec();
  const instrs = [];
  for (let i = 0; i < ninstr; i++) {
    const progIdx = buf[o++];
    const na = shortvec();
    const accounts = [];
    for (let j = 0; j < na; j++) accounts.push(buf[o++]);
    const dlen = shortvec();
    instrs.push({ progIdx, accounts, data: buf.subarray(o, o + dlen) });
    o += dlen;
  }
  return { sigs, numRequired, keys, blockhash, instrs, message: buf.subarray(msgStart) };
}

function sendTransaction(b64) {
  const t = parseTx(Buffer.from(b64, "base64"));
  const sig = b58encode(t.sigs[0]);
  if (ledger.has(sig)) return sig; // resubmission of a landed transaction
  if (t.sigs.length !== t.numRequired) throw rpcErr(-32003, "missing signatures");
  for (let i = 0; i < t.numRequired; i++) {
    if (!ed25519Verify(b58decode(t.keys[i]), t.message, t.sigs[i])) {
      throw rpcErr(-32003, `signature verification failure for ${t.keys[i]}`);
    }
  }
  const lastValid = blockhashes.get(t.blockhash);
  if (lastValid === undefined || height > lastValid) throw rpcErr(-32002, "Blockhash not found");

  // Simulate on a scratch copy (preflight): any failure rejects the whole tx.
  const work = new Map();
  const get = (k) => (work.has(k) ? work.get(k) : balances.get(k) ?? 0n);
  const set = (k, v) => work.set(k, v);
  const feePayer = t.keys[0];
  const fee = FEE * BigInt(t.numRequired);
  if (get(feePayer) < fee) throw rpcErr(-32002, "insufficient funds for fee");
  set(feePayer, get(feePayer) - fee);
  for (const ins of t.instrs) {
    if (t.keys[ins.progIdx] !== SYSTEM_PROGRAM) throw rpcErr(-32002, "unsupported program");
    if (ins.data.readUInt32LE(0) !== 2) throw rpcErr(-32002, "unsupported system instruction");
    const lamports = ins.data.readBigUInt64LE(4);
    const from = t.keys[ins.accounts[0]];
    const to = t.keys[ins.accounts[1]];
    if (get(from) < lamports) {
      throw rpcErr(-32002, "Transaction simulation failed: insufficient lamports");
    }
    set(from, get(from) - lamports);
    set(to, get(to) + lamports);
  }
  const pre = t.keys.map((k) => balances.get(k) ?? 0n);
  for (const [k, v] of work) balances.set(k, v);
  const post = t.keys.map((k) => balances.get(k) ?? 0n);
  record(sig, t.keys, pre, post, null);
  return sig;
}

const methods = {
  getGenesisHash: () => GENESIS,
  getBlockHeight: () => height,
  getLatestBlockhash: () => ({ context: { slot: height }, value: currentBlockhash() }),
  getBalance: ([addr]) => ({ context: { slot: height }, value: Number(balances.get(addr) ?? 0n) }),
  requestAirdrop: ([addr, lamports]) => {
    const l = BigInt(lamports);
    const pre = [balances.get(FAUCET) ?? 0n, balances.get(addr) ?? 0n];
    balances.set(FAUCET, pre[0] - l);
    balances.set(addr, pre[1] + l);
    const sig = b58encode(crypto.randomBytes(64));
    record(sig, [FAUCET, addr], pre, [balances.get(FAUCET), balances.get(addr)], null);
    return sig;
  },
  sendTransaction: ([b64]) => sendTransaction(b64),
  getSignaturesForAddress: ([addr, opts]) => {
    let list = byAddress.get(addr) ?? [];
    if (opts?.before) {
      const i = list.indexOf(opts.before);
      if (i >= 0) list = list.slice(i + 1);
    }
    if (opts?.until) {
      const i = list.indexOf(opts.until);
      if (i >= 0) list = list.slice(0, i);
    }
    return list.slice(0, opts?.limit ?? 1000).map((s) => {
      const e = ledger.get(s);
      return { signature: s, slot: e.slot, err: e.err, memo: null, blockTime: e.blockTime, confirmationStatus: "finalized" };
    });
  },
  getTransaction: ([sig]) => {
    const e = ledger.get(sig);
    if (!e) return null;
    return {
      slot: e.slot,
      blockTime: e.blockTime,
      meta: { err: e.err, fee: Number(FEE), preBalances: e.preBalances, postBalances: e.postBalances },
      transaction: { message: { accountKeys: e.accountKeys } },
    };
  },
  getSignatureStatuses: ([sigs]) => ({
    context: { slot: height },
    value: sigs.map((s) => {
      const e = ledger.get(s);
      return e ? { slot: e.slot, confirmations: null, err: e.err, confirmationStatus: "finalized" } : null;
    }),
  }),
};

http
  .createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      let reply;
      try {
        const { id, method, params } = JSON.parse(body || "{}");
        const fn = methods[method];
        if (!fn) throw rpcErr(-32601, `method not found: ${method}`);
        reply = { jsonrpc: "2.0", id, result: fn(params ?? []) };
      } catch (e) {
        reply = { jsonrpc: "2.0", id: 1, error: { code: e.rpcCode ?? -32000, message: e.message } };
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(reply));
    });
  })
  .listen(port, "127.0.0.1", () => console.log(`mock solana rpc on 127.0.0.1:${port} (genesis ${GENESIS})`));
