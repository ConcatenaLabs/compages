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

// ---- program ids -------------------------------------------------------------

export const SYSTEM_PROGRAM = "11111111111111111111111111111111"; // 32 zero bytes
export const TOKEN_PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
export const TOKEN_2022_PROGRAM = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";
export const ATA_PROGRAM = "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL";
export const METADATA_PROGRAM = "metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s";

// ---- ed25519 curve check + program-derived addresses -------------------------

// Associated token accounts are PDAs: sha256(seeds..., programId,
// "ProgramDerivedAddress") bumped until the result is NOT a valid ed25519
// point. So deriving one needs the on-curve test: decompress per RFC 8032
// over GF(2^255-19) and see whether x can be recovered.
const P = 2n ** 255n - 19n;
const D = (function () {
  // d = -121665 / 121666 mod p
  const inv = powmod(121666n, P - 2n);
  return ((P - 121665n) * inv) % P;
})();
const SQRT_M1 = powmod(2n, (P - 1n) / 4n); // sqrt(-1)

function powmod(base, exp) {
  let r = 1n;
  base %= P;
  while (exp > 0n) {
    if (exp & 1n) r = (r * base) % P;
    base = (base * base) % P;
    exp >>= 1n;
  }
  return r;
}

/** True iff the 32 bytes decompress to a point on the ed25519 curve (i.e. the
 *  bytes could be a real public key, so they canNOT be a PDA). */
export function isOnCurve(bytes) {
  if (bytes.length !== 32) return false;
  let y = 0n;
  for (let i = 31; i >= 0; i--) y = (y << 8n) | BigInt(bytes[i]);
  const sign = (y >> 255n) & 1n;
  y &= (1n << 255n) - 1n;
  if (y >= P) return false; // non-canonical encoding: not a valid point
  const y2 = (y * y) % P;
  const u = (y2 + P - 1n) % P; // y^2 - 1
  const v = (D * y2 + 1n) % P; // d*y^2 + 1
  // x^2 = u/v; candidate root x = (u/v)^((p+3)/8) computed as u*v^3*(u*v^7)^((p-5)/8)
  const v3 = (v * v % P) * v % P;
  const v7 = (v3 * v3 % P) * v % P;
  let x = (u * v3 % P) * powmod((u * v7) % P, (P - 5n) / 8n) % P;
  const vxx = (v * (x * x % P)) % P;
  if (vxx !== u) {
    if (vxx !== (P - u) % P) return false;
    x = (x * SQRT_M1) % P;
  }
  if (x === 0n && sign === 1n) return false; // -0 is invalid
  return true;
}

const PDA_MARKER = Buffer.from("ProgramDerivedAddress");

/** Solana's find_program_address: highest bump in [255..0] whose
 *  sha256(seeds, [bump], programId, marker) is NOT on the curve. */
export function findProgramAddress(seeds, programId) {
  for (let bump = 255; bump >= 0; bump--) {
    const h = crypto
      .createHash("sha256")
      .update(Buffer.concat([...seeds, Buffer.from([bump]), b58decode(programId), PDA_MARKER]))
      .digest();
    if (!isOnCurve(h)) return { address: b58encode(h), bump };
  }
  throw new Error("no viable program address bump");
}

/** The associated token account of (owner, mint) under a token program. */
export function ataAddress(owner, mint, tokenProgram = TOKEN_PROGRAM) {
  return findProgramAddress(
    [b58decode(owner), b58decode(tokenProgram), b58decode(mint)],
    ATA_PROGRAM
  ).address;
}

// ---- legacy transaction encoding --------------------------------------------

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

/** Build and sign a legacy transaction from instructions.
 *
 *  - `feePayer` and every entry of `signers` are keypairs from
 *    keypairFromSeed(); feePayer need not be repeated in `signers`.
 *  - Each instruction is { programId, keys: [{ pubkey, isSigner, isWritable }],
 *    data } with base58 pubkeys, exactly the shape @solana/web3.js uses.
 *
 *  Accounts are merged across instructions (signer/writable are OR-ed) and
 *  ordered per the message format: writable signers (fee payer first),
 *  read-only signers, writable non-signers, read-only non-signers, keeping
 *  first-appearance order within each class.
 *
 *  Returns { tx, signature }: the wire bytes and the transaction id (the fee
 *  payer's signature, base58), known before broadcast. */
export function buildTx({ feePayer, signers = [], instructions, recentBlockhash }) {
  const metas = new Map(); // address -> { signer, writable }
  const touch = (address, signer, writable) => {
    const m = metas.get(address);
    if (m) {
      m.signer ||= signer;
      m.writable ||= writable;
    } else {
      metas.set(address, { address, signer, writable });
    }
  };
  touch(feePayer.address, true, true);
  for (const ins of instructions) {
    for (const k of ins.keys) touch(k.pubkey, k.isSigner, k.isWritable);
    touch(ins.programId, false, false);
  }

  // Match @solana/web3.js ordering exactly (so our bytes are indistinguishable
  // from standard tooling and byte-level tests stay meaningful): signers before
  // non-signers, writable before read-only, base58 locale-compare within a
  // class, and the fee payer hoisted to the front.
  const ordered = [...metas.values()].sort((a, b) => {
    if (a.signer !== b.signer) return a.signer ? -1 : 1;
    if (a.writable !== b.writable) return a.writable ? -1 : 1;
    return a.address.localeCompare(b.address, "en", {
      localeMatcher: "best fit",
      usage: "sort",
      sensitivity: "variant",
      ignorePunctuation: false,
      numeric: false,
      caseFirst: "lower",
    });
  });
  ordered.unshift(...ordered.splice(ordered.findIndex((m) => m.address === feePayer.address), 1));
  const index = new Map(ordered.map((m, i) => [m.address, i]));
  const numSigners = ordered.filter((m) => m.signer).length;
  const numReadonlySigned = ordered.filter((m) => m.signer && !m.writable).length;
  const numReadonlyUnsigned = ordered.filter((m) => !m.signer && !m.writable).length;

  const compiled = instructions.map((ins) =>
    Buffer.concat([
      Buffer.from([index.get(ins.programId)]),
      shortvec(ins.keys.length),
      Buffer.from(ins.keys.map((k) => index.get(k.pubkey))),
      shortvec(ins.data.length),
      ins.data,
    ])
  );
  const message = Buffer.concat([
    Buffer.from([numSigners, numReadonlySigned, numReadonlyUnsigned]),
    shortvec(ordered.length),
    ...ordered.map((m) => b58decode(m.address)),
    b58decode(recentBlockhash),
    shortvec(compiled.length),
    ...compiled,
  ]);

  const byAddress = new Map([feePayer, ...signers].map((s) => [s.address, s]));
  const sigs = ordered.slice(0, numSigners).map((m) => {
    const kp = byAddress.get(m.address);
    if (!kp) throw new Error(`missing keypair for required signer ${m.address}`);
    return crypto.sign(null, message, kp.priv);
  });
  return {
    tx: Buffer.concat([shortvec(sigs.length), ...sigs, message]),
    signature: b58encode(sigs[0]),
  };
}

/** A SystemProgram lamport transfer instruction. */
export function systemTransfer({ from, to, lamports }) {
  const data = Buffer.alloc(12); // u32 tag (2 = Transfer) + u64 lamports
  data.writeUInt32LE(2, 0);
  data.writeBigUInt64LE(BigInt(lamports), 4);
  return {
    programId: SYSTEM_PROGRAM,
    keys: [
      { pubkey: from, isSigner: true, isWritable: true },
      { pubkey: to, isSigner: false, isWritable: true },
    ],
    data,
  };
}

/** Create the associated token account of (owner, mint) if it does not exist
 *  yet (the idempotent variant, safe to prepend to every token transfer). */
export function ataCreateIdempotent({ payer, ata, owner, mint, tokenProgram = TOKEN_PROGRAM }) {
  return {
    programId: ATA_PROGRAM,
    keys: [
      { pubkey: payer, isSigner: true, isWritable: true },
      { pubkey: ata, isSigner: false, isWritable: true },
      { pubkey: owner, isSigner: false, isWritable: false },
      { pubkey: mint, isSigner: false, isWritable: false },
      { pubkey: SYSTEM_PROGRAM, isSigner: false, isWritable: false },
      { pubkey: tokenProgram, isSigner: false, isWritable: false },
    ],
    data: Buffer.from([1]),
  };
}

/** An SPL TransferChecked instruction (works for classic SPL and token-2022;
 *  "checked" pins mint and decimals so a wrong assumption fails on chain). */
export function splTransferChecked({ source, mint, dest, owner, amount, decimals, tokenProgram = TOKEN_PROGRAM }) {
  const data = Buffer.alloc(10); // u8 tag (12) + u64 amount + u8 decimals
  data[0] = 12;
  data.writeBigUInt64LE(BigInt(amount), 1);
  data[9] = decimals;
  return {
    programId: tokenProgram,
    keys: [
      { pubkey: source, isSigner: false, isWritable: true },
      { pubkey: mint, isSigner: false, isWritable: false },
      { pubkey: dest, isSigner: false, isWritable: true },
      { pubkey: owner, isSigner: true, isWritable: false },
    ],
    data,
  };
}

/** One SystemProgram transfer as a signed transaction (see buildTx). `feePayer`
 *  and `source` may be the same keypair (a payout) or differ (a sweep, where
 *  the treasury pays the fee so the swept amount arrives intact); `dest` may
 *  equal the fee payer (sweeps pay the treasury itself). */
export function transferTx({ feePayer, source, dest, lamports, recentBlockhash }) {
  if (b58decode(dest).length !== 32) throw new Error(`invalid destination address ${dest}`);
  return buildTx({
    feePayer,
    signers: source.address === feePayer.address ? [] : [source],
    recentBlockhash,
    instructions: [systemTransfer({ from: source.address, to: dest, lamports })],
  });
}

// ---- RPC client --------------------------------------------------------------

// Base fee per signature, and the rent-exempt minimum for a 0-data system
// account: a transfer may not leave a writable account above zero but below
// this, so releases must keep the treasury clear of the band.
export const FEE_LAMPORTS = 5000n;
export const RENT_EXEMPT_MIN_LAMPORTS = 890_880n;
// Rent-exempt balance of a 165-byte SPL token account, funded by the payer of
// every associated-token-account creation (sweeps and releases budget for it).
export const TOKEN_ACCOUNT_RENT_LAMPORTS = 2_039_280n;

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

  /** Every token account owned by `address`, across both token programs:
   *  [{ address, mint, amount, decimals, tokenProgram }]. */
  async tokenAccountsByOwner(address) {
    const out = [];
    for (const tokenProgram of [TOKEN_PROGRAM, TOKEN_2022_PROGRAM]) {
      const r = await this.rpc("getTokenAccountsByOwner", [
        address,
        { programId: tokenProgram },
        { encoding: "jsonParsed", commitment: "finalized" },
      ]);
      for (const a of r.value) {
        const info = a.account.data.parsed.info;
        out.push({
          address: a.pubkey,
          mint: info.mint,
          amount: BigInt(info.tokenAmount.amount),
          decimals: info.tokenAmount.decimals,
          tokenProgram,
        });
      }
    }
    return out;
  }

  /** Symbol, name, decimals, and owning token program for a mint. Decimals and
   *  the program come from the mint account itself (authoritative); symbol and
   *  name come from the Metaplex metadata account when one exists, else fall
   *  back to a mint-address prefix, like the Ethereum leg falls back for
   *  ERC-20s with unreadable metadata. */
  async tokenMetadata(mint) {
    const info = await this.rpc("getAccountInfo", [
      mint,
      { encoding: "jsonParsed", commitment: "finalized" },
    ]);
    const parsed = info.value?.data?.parsed;
    if (!parsed || parsed.type !== "mint") {
      throw new Error(`${mint} is not a token mint`);
    }
    const decimals = parsed.info.decimals;
    const tokenProgram = info.value.owner;
    let symbol = mint.slice(0, 8);
    let name = mint;
    try {
      const metaAddr = findProgramAddress(
        [Buffer.from("metadata"), b58decode(METADATA_PROGRAM), b58decode(mint)],
        METADATA_PROGRAM
      ).address;
      const meta = await this.rpc("getAccountInfo", [
        metaAddr,
        { encoding: "base64", commitment: "finalized" },
      ]);
      if (meta.value) {
        // Metaplex Metadata (borsh): key u8, update authority 32, mint 32,
        // then name and symbol as u32-length-prefixed strings padded with \0.
        const buf = Buffer.from(meta.value.data[0], "base64");
        let o = 1 + 32 + 32;
        const str = () => {
          const len = buf.readUInt32LE(o);
          o += 4;
          const s = buf.subarray(o, o + len).toString("utf8").replace(/\0+$/, "").trim();
          o += len;
          return s;
        };
        const mName = str();
        const mSymbol = str();
        if (mSymbol) symbol = mSymbol;
        if (mName) name = mName;
      }
    } catch {
      // metadata is decorative; the fallback naming stands
    }
    return { symbol, name, decimals, tokenProgram };
  }

  /** How many base units of its mint `tokenAccountAddress` gained in
   *  transaction `sig` (see receivedLamports for the throw-vs-zero contract). */
  async receivedTokenAmount(sig, tokenAccountAddress) {
    const tx = await this.transaction(sig);
    if (!tx) throw new Error(`finalized transaction ${sig} not returned by the RPC (lagging node?)`);
    if (tx.meta?.err) return 0n;
    const keys = [
      ...tx.transaction.message.accountKeys,
      ...(tx.meta.loadedAddresses?.writable ?? []),
      ...(tx.meta.loadedAddresses?.readonly ?? []),
    ];
    const i = keys.indexOf(tokenAccountAddress);
    if (i < 0) return 0n;
    const bal = (list) =>
      BigInt((list ?? []).find((b) => b.accountIndex === i)?.uiTokenAmount.amount ?? 0);
    const delta = bal(tx.meta.postTokenBalances) - bal(tx.meta.preTokenBalances);
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
