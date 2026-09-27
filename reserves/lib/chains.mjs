// Reads from the three chains a snapshot spans. Every read is pinned: the
// Sequentia block by height and hash, Ethereum by block number, Solana at
// `finalized` commitment with the slot the node answered at recorded.

import { ethers } from "ethers";
import { ataAddress, TOKEN_PROGRAM, TOKEN_2022_PROGRAM } from "../../daemon/lib/sol.js";
import { vaultBacking } from "./figures.mjs";

async function fetchJson(url, opts = {}, timeoutMs = 30_000) {
  const res = await fetch(url, { ...opts, signal: AbortSignal.timeout(timeoutMs) });
  const text = await res.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    throw new Error(`${new URL(url).host}: HTTP ${res.status}, not JSON`);
  }
  if (!res.ok && !body?.error) throw new Error(`${new URL(url).host}: HTTP ${res.status}`);
  return body;
}

// ---- Sequentia ------------------------------------------------------------------

/** Split `http://user:pass@host:port` into a URL without credentials and the
 *  credentials, so the latter never reach a command line or a log. */
export function splitRpcUrl(url) {
  const u = new URL(url);
  const user = decodeURIComponent(u.username);
  const password = decodeURIComponent(u.password);
  u.username = "";
  u.password = "";
  return { url: u.toString(), user, password };
}

export function seqClient(rpcUrl) {
  const { url, user, password } = splitRpcUrl(rpcUrl);
  const auth = "Basic " + Buffer.from(`${user}:${password}`).toString("base64");
  let id = 0;
  const call = async (method, params = []) => {
    const r = await fetchJson(url, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: auth },
      body: JSON.stringify({ jsonrpc: "1.0", id: ++id, method, params }),
    });
    if (r.error) throw new Error(`Sequentia ${method}: ${r.error.message ?? JSON.stringify(r.error)}`);
    return r.result;
  };
  return { call, url, user, password };
}

// ---- Ethereum -------------------------------------------------------------------

export function ethProvider(url, chainId) {
  const r = new ethers.FetchRequest(url);
  r.timeout = 30_000;
  return new ethers.JsonRpcProvider(r, chainId, { staticNetwork: true, batchMaxCount: 1 });
}

const VAULT_VIEWS = [
  "function VERSION() view returns (uint256)",
  "function owedTotal(address) view returns (uint256)",
  "function queuedTotal(address) view returns (uint256)",
  "function cancelledTotal(address) view returns (uint256)",
];
const ERC20 = ["function balanceOf(address) view returns (uint256)"];

/** One vault's figures for one token at `blockTag` (a block number):
 *  balance, the version-3 reservations, and the backing that leaves. A vault
 *  with no code at that block holds nothing it could reserve and backs
 *  nothing. `pinnedVersion`, when given, is the vault's known interface
 *  version and replaces asking VERSION(): some RPCs answer an older vault's
 *  missing function in a form that cannot be told apart from an outage. */
export async function vaultFigures(provider, vault, token, blockTag, pinnedVersion) {
  const address = ethers.getAddress(vault);
  const native = token === "eth" || token === ethers.ZeroAddress;
  const code = await provider.getCode(address, blockTag);
  if (code === "0x") {
    return { vault: address, deployed: false, version: null, balance: "0", owed: "0", queued: "0", cancelled: "0", backing: "0" };
  }
  const balance = native
    ? BigInt(await provider.getBalance(address, blockTag))
    : BigInt(await new ethers.Contract(ethers.getAddress(token), ERC20, provider).balanceOf(address, { blockTag }));
  const v = new ethers.Contract(address, VAULT_VIEWS, provider);
  let version = null;
  if (pinnedVersion !== undefined && pinnedVersion !== null) {
    // Versions before 3 have no VERSION() and are recorded as null.
    version = Number(pinnedVersion) >= 3 ? Number(pinnedVersion) : null;
  } else {
    try {
      version = Number(await v.VERSION({ blockTag }));
    } catch (e) {
      if (e.code !== "CALL_EXCEPTION") throw e; // an older vault has no VERSION() and reserves nothing
    }
  }
  let owed = 0n;
  let queued = 0n;
  let cancelled = 0n;
  if (version !== null && version >= 3) {
    const t = native ? ethers.ZeroAddress : ethers.getAddress(token);
    owed = BigInt(await v.owedTotal(t, { blockTag }));
    queued = BigInt(await v.queuedTotal(t, { blockTag }));
    cancelled = BigInt(await v.cancelledTotal(t, { blockTag }));
  }
  return {
    vault: address,
    deployed: true,
    version,
    balance: balance.toString(),
    owed: owed.toString(),
    queued: queued.toString(),
    cancelled: cancelled.toString(),
    backing: vaultBacking({ balance, owed, queued, cancelled }).toString(),
  };
}

// ---- Solana ---------------------------------------------------------------------

export function solClient(url) {
  let id = 0;
  return async (method, params) => {
    const r = await fetchJson(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params }),
    });
    if (r.error) {
      const e = new Error(`Solana ${method}: ${r.error.message}`);
      e.code = r.error.code;
      throw e;
    }
    return r.result;
  };
}

/** The accounts that hold escrow of `mint` for `owners`: the owner itself
 *  for native SOL, otherwise its associated token account under both token
 *  programs. */
export function escrowAccounts(owners, mint) {
  const out = [];
  for (const owner of owners) {
    if (mint === "sol") out.push({ owner, account: owner, program: null });
    else for (const program of [TOKEN_PROGRAM, TOKEN_2022_PROGRAM]) out.push({ owner, account: ataAddress(owner, mint, program), program });
  }
  return out;
}

/** Read accounts at `finalized`, 100 per call. Every batch after the first
 *  asks for at least the slot the first one answered at, so the reads never
 *  go backwards. Returns { accounts: Map(address -> account|null), minSlot,
 *  maxSlot }. Solana's RPC answers only for the current state, never for a
 *  past slot, so the slots are those the reads were answered at. */
export async function readSolanaAccounts(sol, addresses) {
  const uniq = [...new Set(addresses)];
  const accounts = new Map();
  let minSlot = null;
  let maxSlot = null;
  for (let i = 0; i < uniq.length; i += 100) {
    const batch = uniq.slice(i, i + 100);
    const opts = { encoding: "jsonParsed", commitment: "finalized" };
    if (minSlot !== null) opts.minContextSlot = maxSlot;
    const r = await sol("getMultipleAccounts", [batch, opts]);
    const slot = r.context.slot;
    minSlot = minSlot === null ? slot : Math.min(minSlot, slot);
    maxSlot = maxSlot === null ? slot : Math.max(maxSlot, slot);
    batch.forEach((a, j) => accounts.set(a, r.value[j] ?? null));
  }
  return { accounts, minSlot, maxSlot };
}

/** Units of `mint` an account holds, checked to be what it should be: the
 *  owner's lamports for SOL, or a token account of that mint and owner. */
export function heldUnits(entry, acct, mint) {
  if (!acct) return 0n;
  if (mint === "sol") return BigInt(acct.lamports);
  const info = acct.data?.parsed?.info;
  if (!info || info.mint !== mint || info.owner !== entry.owner) return 0n;
  return BigInt(info.tokenAmount?.amount ?? 0);
}

/** A CCTP burn the daemon lists as in transit, checked on Solana itself:
 *  final, successful, moving exactly that amount of `mint` out of the
 *  treasury, and in a slot no later than the escrow reads (so the treasury
 *  balance already excludes it and it is not counted twice). */
export async function checkBurn(sol, burn, { mint, treasury, readSlot }) {
  const out = { id: burn.id ?? null, solanaBurn: burn.solanaBurn ?? null, amount: String(burn.amount), slot: null, counted: false, reason: null };
  if (!burn.solanaBurn) {
    out.reason = "no Solana burn signature";
    return out;
  }
  const tx = await sol("getTransaction", [burn.solanaBurn, { encoding: "jsonParsed", commitment: "finalized", maxSupportedTransactionVersion: 0 }]);
  if (!tx) {
    out.reason = "not found as finalized";
    return out;
  }
  out.slot = tx.slot;
  if (tx.meta?.err) {
    out.reason = "the transaction failed";
    return out;
  }
  const bal = (list) =>
    (list ?? []).filter((x) => x.mint === mint && x.owner === treasury).reduce((a, x) => a + BigInt(x.uiTokenAmount?.amount ?? 0), 0n);
  const moved = bal(tx.meta.preTokenBalances) - bal(tx.meta.postTokenBalances);
  if (moved !== BigInt(burn.amount)) {
    out.reason = `it moved ${moved} out of the treasury, not ${burn.amount}`;
    return out;
  }
  if (tx.slot > readSlot) {
    out.reason = `it landed after the escrow was read (slot ${tx.slot} > ${readSlot}); the treasury balance still includes it`;
    return out;
  }
  out.counted = true;
  return out;
}

// ---- CCTP transfers between escrows ------------------------------------------------

export const IRIS_SANDBOX = "https://iris-api-sandbox.circle.com";
export const MESSAGE_TRANSMITTER_V2 = "0xE737e5cEBEEBa77EFE34D4aa090756590b1CE275";
const SOLANA_DOMAIN = 5;

/** What Circle's attestation service knows of a Solana burn: the message's
 *  nonce and the fee taken, or null while it has not attested the burn.
 *  Offsets are CCTP V2's: the nonce is header bytes 12..44, and in the burn
 *  body (after the 148-byte header) the amount is at 68 and feeExecuted at
 *  164. */
export async function cctpMessageOf(irisUrl, signature) {
  const url = `${(irisUrl ?? IRIS_SANDBOX).replace(/\/+$/, "")}/v2/messages/${SOLANA_DOMAIN}?transactionHash=${encodeURIComponent(signature)}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(30_000) });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`Circle attestation service: HTTP ${res.status}`);
  const m = ((await res.json()).messages ?? []).find((x) => typeof x.message === "string" && /^0x[0-9a-fA-F]+$/.test(x.message) && x.message.length > 2 + 2 * 344);
  if (!m) return null;
  const hex = m.message.slice(2);
  const word = (at) => BigInt(`0x${hex.slice(at * 2, (at + 32) * 2)}`);
  return {
    nonce: `0x${hex.slice(24, 88)}`,
    amount: word(148 + 68).toString(),
    feeExecuted: word(148 + 164).toString(),
  };
}

/** Whether Circle's MessageTransmitter had received the message with
 *  `nonce` by block `blockTag`: it marks every nonce it accepts. */
export async function nonceUsedAt(provider, transmitter, nonce, blockTag) {
  const t = new ethers.Contract(transmitter, ["function usedNonces(bytes32) view returns (uint256)"], provider);
  return (await t.usedNonces(nonce, { blockTag })) !== 0n;
}

/** A consolidation counts as in transit at a snapshot when its Solana burn
 *  left the treasury before the Solana read (checkBurn) and Ethereum had not
 *  received it by block B, so it is in neither balance. What counts is what
 *  arrives: the burned amount less Circle's fee. The nonce comes from
 *  Circle's attestation service, not from the operator; an unattested burn
 *  cannot have been received yet. */
export async function checkTransfer({ sol, eth, burn, mint, treasury, readSlot, blockB, irisUrl, transmitter }) {
  const out = await checkBurn(sol, burn, { mint, treasury, readSlot });
  out.nonce = null;
  out.receivedByB = null;
  if (!out.counted) return out;
  const msg = await cctpMessageOf(irisUrl, burn.solanaBurn);
  if (msg) {
    out.nonce = msg.nonce;
    if (BigInt(msg.amount) !== BigInt(burn.amount)) {
      out.counted = false;
      out.reason = `Circle's message is for ${msg.amount}, not ${burn.amount}`;
      return out;
    }
    out.receivedByB = await nonceUsedAt(eth, transmitter ?? MESSAGE_TRANSMITTER_V2, msg.nonce, blockB);
    if (out.receivedByB) {
      out.counted = false;
      out.reason = `received on Ethereum by block ${blockB}, so the vault balance already includes it`;
      return out;
    }
    out.amount = (BigInt(burn.amount) - BigInt(msg.feeExecuted)).toString();
  } else {
    out.receivedByB = false;
  }
  return out;
}
