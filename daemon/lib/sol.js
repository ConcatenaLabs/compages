// Solana-side helpers: JSON-RPC client, ed25519 keys, and a hand-rolled legacy
// transaction builder for SystemProgram transfers. Kept dependency-free on
// purpose (the web app hand-encodes its ABI calls for the same reason): the
// bridge only ever needs one instruction, a lamport transfer, and the mock RPC
// in e2e independently decodes and signature-checks what this file encodes.
//
// Crash-safety primitive: a Solana transaction's id IS its fee payer's ed25519
// signature over the message, so it is known before broadcast. transferTx()
// returns it; the bridge persists it before sending, and after a crash the
// recorded signature plus the blockhash's lastValidBlockHeight decide, on
// chain, whether the transfer landed or can never land (see Bridge.solRelease).

import crypto from "node:crypto";

// ---- base58 (Bitcoin alphabet, as Solana uses) -------------------------------

const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const B58_INDEX = new Map([...B58].map((c, i) => [c, BigInt(i)]));

export function b58encode(bytes) {
  let n = 0n;
  for (const b of bytes) n = n * 256n + BigInt(b);
  let s = "";
  while (n > 0n) {
    s = B58[Number(n % 58n)] + s;
    n /= 58n;
  }
  for (const b of bytes) {
    if (b !== 0) break;
    s = "1" + s;
  }
  return s;
}

export function b58decode(s) {
  let n = 0n;
  for (const c of s) {
    const v = B58_INDEX.get(c);
    if (v === undefined) throw new Error(`invalid base58 character '${c}'`);
    n = n * 58n + v;
  }
  const out = [];
  while (n > 0n) {
    out.unshift(Number(n % 256n));
    n /= 256n;
  }
  for (const c of s) {
    if (c !== "1") break;
    out.unshift(0);
  }
  return Buffer.from(out);
}

/** True iff `s` is a well-formed Solana account address (base58 of 32 bytes). */
export function isSolAddress(s) {
  if (typeof s !== "string" || s.length < 32 || s.length > 44) return false;
  try {
    return b58decode(s).length === 32;
  } catch {
    return false;
  }
}

// ---- ed25519 via node:crypto -------------------------------------------------

// PKCS#8 DER wrapper for a raw 32-byte ed25519 seed (RFC 8410).
const PKCS8_ED25519_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex");

/** Build a signing keypair from a raw 32-byte seed. */
export function keypairFromSeed(seed) {
  if (seed.length !== 32) throw new Error("ed25519 seed must be 32 bytes");
  const priv = crypto.createPrivateKey({
    key: Buffer.concat([PKCS8_ED25519_PREFIX, seed]),
    format: "der",
    type: "pkcs8",
  });
  const jwk = crypto.createPublicKey(priv).export({ format: "jwk" });
  const pub = Buffer.from(jwk.x, "base64url");
  return { priv, pub, address: b58encode(pub) };
}

/** Verify an ed25519 signature over `message` for a raw 32-byte public key.
 *  Used by the e2e mock RPC to check what transferTx() produced. */
export function ed25519Verify(pub, message, signature) {
  const key = crypto.createPublicKey({
    key: { kty: "OKP", crv: "Ed25519", x: Buffer.from(pub).toString("base64url") },
    format: "jwk",
  });
  return crypto.verify(null, message, key, signature);
}

// ---- legacy transaction encoding --------------------------------------------

export const SYSTEM_PROGRAM = "11111111111111111111111111111111"; // 32 zero bytes

// Compact-u16 ("shortvec") length prefix.
export function shortvec(n) {
  const out = [];
  for (;;) {
    const b = n & 0x7f;
    n >>= 7;
    if (n === 0) {
      out.push(b);
      return Buffer.from(out);
    }
    out.push(b | 0x80);
  }
}

/** Build and sign a legacy transaction carrying one SystemProgram transfer.
 *
 *  - `feePayer` and `source` are keypairs from keypairFromSeed(); they may be
 *    the same object (a plain payout) or differ (the sweep of a deposit
 *    address, where the treasury pays the fee so the swept amount arrives
 *    intact).
 *  - `dest` is a base58 address; it may equal the fee payer (sweeps pay the
 *    treasury itself).
 *
 *  Returns { tx, signature }: the wire bytes and the transaction id (the fee
 *  payer's signature, base58), known before broadcast. */
export function transferTx({ feePayer, source, dest, lamports, recentBlockhash }) {
  const signers = [feePayer];
  if (source.address !== feePayer.address) signers.push(source);

  // Account order per the message format: writable signers, then writable
  // non-signers, then read-only non-signers (the program).
  const keys = signers.map((s) => s.pub);
  const destBytes = b58decode(dest);
  if (destBytes.length !== 32) throw new Error(`invalid destination address ${dest}`);
  let destIdx = keys.findIndex((k) => k.equals(destBytes));
  if (destIdx < 0) {
    destIdx = keys.length;
    keys.push(destBytes);
  }
  const progIdx = keys.length;
  keys.push(b58decode(SYSTEM_PROGRAM));
  const srcIdx = signers.findIndex((s) => s.address === source.address);

  const data = Buffer.alloc(12); // u32 instruction tag (2 = Transfer) + u64 lamports
  data.writeUInt32LE(2, 0);
  data.writeBigUInt64LE(BigInt(lamports), 4);
  const instruction = Buffer.concat([
    Buffer.from([progIdx]),
    shortvec(2),
    Buffer.from([srcIdx, destIdx]),
    shortvec(data.length),
    data,
  ]);

  const message = Buffer.concat([
    Buffer.from([signers.length, 0, 1]), // header: sigs, ro-signed, ro-unsigned
    shortvec(keys.length),
    ...keys,
    b58decode(recentBlockhash),
    shortvec(1),
    instruction,
  ]);

  const sigs = signers.map((s) => crypto.sign(null, message, s.priv));
  return {
    tx: Buffer.concat([shortvec(sigs.length), ...sigs, message]),
    signature: b58encode(sigs[0]),
  };
}

// ---- RPC client --------------------------------------------------------------

// Base fee per signature, and the rent-exempt minimum for a 0-data system
// account: a transfer may not leave a writable account above zero but below
// this, so releases must keep the treasury clear of the band.
export const FEE_LAMPORTS = 5000n;
export const RENT_EXEMPT_MIN_LAMPORTS = 890_880n;

export class Sol {
  /**
   * @param {object} cfg          daemon config (solRpcUrl et al)
   * @param {Buffer} masterSeed   32-byte operator master seed
   */
  constructor(cfg, masterSeed) {
    this.cfg = cfg;
    this.url = cfg.solRpcUrl;
    this.masterSeed = masterSeed;
    this.treasury = keypairFromSeed(masterSeed);
  }

  /** Deterministic per-intent deposit keypair: recoverable forever from the
   *  master seed and the intent's index, so no derived key is ever stored. */
  depositKeypair(index) {
    const seed = crypto
      .createHmac("sha256", this.masterSeed)
      .update(`compages-sol-deposit:${index}`)
      .digest();
    return keypairFromSeed(seed);
  }

  async rpc(method, params = []) {
    const res = await fetch(this.url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    });
    const text = await res.text();
    let json;
    try {
      json = JSON.parse(text);
    } catch {
      throw new Error(`sol rpc ${method}: non-JSON response (HTTP ${res.status}): ${text.slice(0, 200)}`);
    }
    if (json.error) {
      const e = new Error(`sol rpc ${method}: ${json.error.message} (code ${json.error.code})`);
      e.code = json.error.code;
      throw e;
    }
    return json.result;
  }

  genesisHash() {
    return this.rpc("getGenesisHash");
  }

  /** Lazily verify the RPC serves the intended cluster (intent addresses and
   *  the treasury are cluster-blind, so running against the wrong one would
   *  quietly misdirect funds). Cached once it succeeds; throws until then. */
  async ensureCluster() {
    if (this._clusterOk) return;
    const gh = await this.genesisHash();
    if (this.cfg.solGenesisHash && gh !== this.cfg.solGenesisHash) {
      throw new Error(`Solana RPC genesis hash ${gh} != configured ${this.cfg.solGenesisHash}`);
    }
    this._clusterOk = true;
  }

  async latestBlockhash() {
    const r = await this.rpc("getLatestBlockhash", [{ commitment: "finalized" }]);
    return r.value; // { blockhash, lastValidBlockHeight }
  }

  async blockHeight() {
    return this.rpc("getBlockHeight", [{ commitment: "finalized" }]);
  }

  async balance(address) {
    const r = await this.rpc("getBalance", [address, { commitment: "finalized" }]);
    return BigInt(r.value);
  }

  /** All finalized signatures touching `address` newer than `until`
   *  (exclusive), newest first, paginating with a `before` cursor so an
   *  active address can never outrun the scan window. Returns
   *  { sigs, complete }; when the page cap was hit, complete is false and the
   *  caller must NOT advance its `until` cursor (the unwalked middle would be
   *  skipped forever). */
  async signaturesFor(address, until = undefined, maxPages = 50) {
    const sigs = [];
    let before;
    for (let page = 0; page < maxPages; page++) {
      const opts = { limit: 100, commitment: "finalized" };
      if (before) opts.before = before;
      if (until) opts.until = until;
      const batch = await this.rpc("getSignaturesForAddress", [address, opts]);
      sigs.push(...batch);
      if (batch.length < 100) return { sigs, complete: true };
      before = batch[batch.length - 1].signature;
    }
    return { sigs, complete: false };
  }

  transaction(signature) {
    return this.rpc("getTransaction", [
      signature,
      { commitment: "finalized", encoding: "json", maxSupportedTransactionVersion: 0 },
    ]);
  }

  /** How many lamports `address` gained in transaction `sig` (0n if none, or
   *  the tx failed, or the address is not among its accounts). A finalized
   *  signature whose body the RPC cannot return yet is a THROW, not 0n:
   *  conflating the two would permanently mark a real deposit as seen. Works
   *  for transfers from any wallet, including versioned txs with lookup
   *  tables: pre/postBalances cover static keys then loaded writable then
   *  loaded read-only, in that order. */
  async receivedLamports(sig, address) {
    const tx = await this.transaction(sig);
    if (!tx) throw new Error(`finalized transaction ${sig} not returned by the RPC (lagging node?)`);
    if (tx.meta?.err) return 0n;
    const keys = [
      ...tx.transaction.message.accountKeys,
      ...(tx.meta.loadedAddresses?.writable ?? []),
      ...(tx.meta.loadedAddresses?.readonly ?? []),
    ];
    const i = keys.indexOf(address);
    if (i < 0) return 0n;
    const delta = BigInt(tx.meta.postBalances[i]) - BigInt(tx.meta.preBalances[i]);
    return delta > 0n ? delta : 0n;
  }

  async send(txBytes) {
    return this.rpc("sendTransaction", [
      Buffer.from(txBytes).toString("base64"),
      { encoding: "base64" },
    ]);
  }

  /** Status of a signature, searching the full ledger history: null if the
   *  cluster has never seen it, else { confirmationStatus, err }. */
  async signatureStatus(signature) {
    const r = await this.rpc("getSignatureStatuses", [
      [signature],
      { searchTransactionHistory: true },
    ]);
    return r.value[0];
  }

  requestAirdrop(address, lamports) {
    return this.rpc("requestAirdrop", [address, Number(lamports)]);
  }
}
