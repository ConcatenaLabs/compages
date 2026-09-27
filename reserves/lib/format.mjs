// The snapshot format: canonical JSON, the payload hash, the signed message,
// and the checks a verifier runs. Pure apart from `ethers` for the
// signature, so the same file can be copied verbatim into a mirror and run
// there with nothing else from this repository.
//
// A snapshot file is the canonical JSON of
//
//   { format, version, hash, payload, signature: { scheme, address, message, signature } }
//
// followed by one newline, where
//
//   hash      = sha256 of canonical(payload), lowercase hex
//   message   = signingMessage(payload.height, hash)
//   signature = EIP-191 personal_sign of `message` by payload.attester
//
// and payload.previous is { height, hash } of the snapshot before it (null
// for the first), so the snapshots form a hash chain: rewriting or dropping
// one breaks the link of the next.

import crypto from "node:crypto";
import { ethers } from "ethers";

export const SNAPSHOT_FORMAT = "compages-reserves-snapshot";
export const INDEX_FORMAT = "compages-reserves-index";
export const FORMAT_VERSION = 1;

/** Canonical JSON: object keys sorted, no insignificant whitespace, and only
 *  values whose serialization cannot vary between implementations. Numbers
 *  must be safe integers (amounts are decimal strings), so no float
 *  formatting ever enters a hash. Anything else is refused rather than
 *  coerced, because a value that serializes two ways is a signature nobody
 *  else can reproduce. */
export function canonicalize(value) {
  if (value === null || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) throw new TypeError(`canonical JSON admits only safe integers, got ${value}`);
    return String(value === 0 ? 0 : value); // no "-0"
  }
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
  if (typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype) {
    const keys = Object.keys(value).sort();
    const parts = [];
    for (const k of keys) {
      if (value[k] === undefined) throw new TypeError(`canonical JSON has no undefined (key ${k})`);
      parts.push(`${JSON.stringify(k)}:${canonicalize(value[k])}`);
    }
    return `{${parts.join(",")}}`;
  }
  throw new TypeError(`canonical JSON cannot hold a ${typeof value}`);
}

export const sha256hex = (text) => crypto.createHash("sha256").update(text, "utf8").digest("hex");

export const payloadHash = (payload) => sha256hex(canonicalize(payload));

/** The exact text the attestation key signs. Human-readable on purpose: a
 *  signer that displays it shows what is being attested. */
export function signingMessage(height, hash) {
  return `Compages proof-of-reserves snapshot\nSequentia height: ${height}\nPayload sha256: ${hash}`;
}

/** The bytes of a snapshot or index file. */
export const fileText = (obj) => `${canonicalize(obj)}\n`;

/** Sign a payload with an ethers signer (a Wallet). The payload must name
 *  the signer as its attester, so the address is covered by the hash. */
export async function signSnapshot(payload, signer) {
  if (String(payload.attester).toLowerCase() !== signer.address.toLowerCase()) {
    throw new Error(`payload names attester ${payload.attester} but the key is ${signer.address}`);
  }
  const hash = payloadHash(payload);
  const message = signingMessage(payload.height, hash);
  return {
    format: SNAPSHOT_FORMAT,
    version: FORMAT_VERSION,
    hash,
    payload,
    signature: { scheme: "eip191-personal-sign", address: signer.address, message, signature: await signer.signMessage(message) },
  };
}

/** Check one snapshot on its own: shape, hash, message and signature.
 *  `attester`, when given, is the address the signature must recover to
 *  (the pinned address a mirror trusts); without it the snapshot is checked
 *  against the attester it names, which proves integrity but not origin.
 *  Returns { ok, errors, hash, signer }. */
export function verifySnapshot(snap, { attester = null } = {}) {
  const errors = [];
  const fail = (m) => errors.push(m);
  if (!snap || typeof snap !== "object") return { ok: false, errors: ["not a JSON object"], hash: null, signer: null };
  if (snap.format !== SNAPSHOT_FORMAT) fail(`format is ${JSON.stringify(snap.format)}, not ${SNAPSHOT_FORMAT}`);
  if (snap.version !== FORMAT_VERSION) fail(`unsupported version ${JSON.stringify(snap.version)}`);
  const p = snap.payload;
  if (!p || typeof p !== "object") return { ok: false, errors: [...errors, "no payload"], hash: null, signer: null };
  if (!Number.isSafeInteger(p.height) || p.height < 0) fail("payload.height is not a height");
  let hash = null;
  try {
    hash = payloadHash(p);
  } catch (e) {
    fail(`payload is not canonical JSON: ${e.message}`);
  }
  if (hash && snap.hash !== hash) fail(`hash field ${snap.hash} does not match the payload (sha256 ${hash})`);
  const sig = snap.signature ?? {};
  if (sig.scheme !== "eip191-personal-sign") fail(`unknown signature scheme ${JSON.stringify(sig.scheme)}`);
  if (hash && sig.message !== signingMessage(p.height, hash)) fail("the signed message is not the one this payload defines");
  let signer = null;
  try {
    signer = ethers.verifyMessage(String(sig.message), String(sig.signature));
  } catch (e) {
    fail(`the signature does not parse: ${e.shortMessage ?? e.message}`);
  }
  if (signer) {
    const eq = (a, b) => String(a).toLowerCase() === String(b).toLowerCase();
    if (!eq(signer, p.attester)) fail(`signed by ${signer}, but the payload names attester ${p.attester}`);
    if (!eq(signer, sig.address)) fail(`signed by ${signer}, but the signature block names ${sig.address}`);
    if (attester && !eq(signer, attester)) fail(`signed by ${signer}, not by the expected attester ${attester}`);
  }
  return { ok: errors.length === 0, errors, hash, signer };
}

/** The link from `prev` to `next`: `next` must name `prev` (height and
 *  payload hash) as its predecessor, and come after it. `prev` null means
 *  `next` must be the first snapshot. Returns a list of errors. */
export function checkLink(prev, next) {
  const errors = [];
  const link = next?.payload?.previous ?? null;
  if (prev === null) {
    if (link !== null) errors.push(`${next.payload.height} names a predecessor (${link.height}) that is not in the history`);
    return errors;
  }
  if (link === null) {
    errors.push(`${next.payload.height} claims to be the first snapshot, but ${prev.payload.height} precedes it`);
    return errors;
  }
  if (link.height !== prev.payload.height) {
    errors.push(`${next.payload.height} names ${link.height} as its predecessor, but the one before it is ${prev.payload.height}`);
  }
  let prevHash = null;
  try {
    prevHash = payloadHash(prev.payload);
  } catch {
    errors.push(`${prev.payload.height} cannot be hashed, so nothing can link to it`);
  }
  if (prevHash !== null && link.hash !== prevHash) {
    errors.push(`${next.payload.height} links to hash ${link.hash}, but ${prev.payload.height} hashes to ${prevHash}`);
  }
  if (!(next.payload.height > prev.payload.height)) errors.push(`${next.payload.height} does not come after ${prev.payload.height}`);
  return errors;
}

/** Verify a whole history, given its snapshots in any order: every
 *  signature, and every link from the first to the last. */
export function verifyChain(snaps, { attester = null } = {}) {
  const signatureErrors = [];
  const linkErrors = [];
  const sorted = [...snaps].sort((a, b) => a.payload.height - b.payload.height);
  let prev = null;
  for (const s of sorted) {
    const v = verifySnapshot(s, { attester });
    for (const e of v.errors) signatureErrors.push(`${s.payload?.height}: ${e}`);
    if (v.hash) linkErrors.push(...checkLink(prev, s));
    prev = s;
  }
  const errors = [...signatureErrors, ...linkErrors];
  return {
    ok: errors.length === 0,
    errors,
    signatureErrors,
    linkErrors,
    head: prev ? { height: prev.payload.height, hash: payloadHash(prev.payload) } : null,
  };
}

/** The index a history directory publishes beside its snapshots. It is
 *  derived from them and unsigned; every entry can be checked against the
 *  snapshot it names. */
export function buildIndex(snaps) {
  const sorted = [...snaps].sort((a, b) => a.payload.height - b.payload.height);
  const last = sorted.at(-1) ?? null;
  return {
    format: INDEX_FORMAT,
    version: FORMAT_VERSION,
    attester: last?.payload.attester ?? null,
    head: last ? { height: last.payload.height, hash: payloadHash(last.payload) } : null,
    snapshots: sorted.map((s) => ({
      height: s.payload.height,
      hash: payloadHash(s.payload),
      previous: s.payload.previous?.hash ?? null,
      createdAt: s.payload.createdAt ?? null,
      file: `${s.payload.height}.json`,
    })),
  };
}

/** Parse an index as served, answering null for anything that is not one
 *  (an old daemon answers /api/por/history with the live reserves report). */
export function parseIndex(obj) {
  if (!obj || obj.format !== INDEX_FORMAT || !Array.isArray(obj.snapshots)) return null;
  for (const e of obj.snapshots) {
    if (!Number.isSafeInteger(e?.height) || e.height < 0) return null;
    if (typeof e.hash !== "string" || !/^[0-9a-f]{64}$/.test(e.hash)) return null;
  }
  return obj;
}
