// Compages HTTP API for the web front-end. JSON everywhere, permissive CORS
// (the front-end is a static page). Public calls hold no secrets, and the only
// public mutating calls create deposit or redemption intents, rate-limited
// per client. /api/admin/* exists only when `adminToken` is configured, and
// answers 404 to any request without it.

import crypto from "node:crypto";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ethers } from "ethers";
import { tokenKeyOf, sourcesOf, SEQ_MAX_SATS } from "./bridge.js";
import { unitsToAtoms } from "./eth.js";
import { porHistory } from "./porhistory.js";

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
};

/** The /64 an IPv6 address belongs to, as "a:b:c:d::/64", or null when `ip`
 *  is not an IPv6 address this can read. The address is expanded first:
 *  a compressed zero run inside the first four groups ("2001:db8::1") must
 *  not make every host of that /64 look like a network of its own. */
export function ipv6Prefix64(ip) {
  const addr = String(ip).split("%")[0].toLowerCase();
  const halves = addr.split("::");
  if (halves.length > 2) return null;
  const groupsOf = (s) => (s ? s.split(":") : []);
  const head = groupsOf(halves[0]);
  const tail = halves.length === 2 ? groupsOf(halves[1]) : [];
  // A trailing dotted IPv4 part stands for the last two groups.
  const width = (gs) => gs.length + (gs.length && gs[gs.length - 1].includes(".") ? 1 : 0);
  const fill = 8 - width(head) - width(tail);
  if (halves.length === 1 ? fill !== 0 : fill < 1) return null;
  const groups = [...head, ...Array(fill).fill("0"), ...tail].slice(0, 4);
  if (!groups.every((g) => /^[0-9a-f]{1,4}$/.test(g))) return null;
  return groups.map((g) => parseInt(g, 16).toString(16)).join(":") + "::/64";
}

/** The client a request counts against: the socket peer, or the first
 *  X-Forwarded-For hop when the daemon sits behind a reverse proxy it trusts
 *  (`trustProxy`). One IPv6 client owns a whole /64, so it counts as one. */
export function clientIpOf(req, trustProxy = false) {
  let ip = req.socket?.remoteAddress ?? "unknown";
  if (trustProxy) {
    const fwd = String(req.headers?.["x-forwarded-for"] ?? "").split(",")[0].trim();
    if (fwd) ip = fwd;
  }
  if (ip.includes(":") && !ip.toLowerCase().startsWith("::ffff:")) ip = ipv6Prefix64(ip) ?? ip;
  return ip;
}

/** Fixed one-hour windows per key ("bucket:client"). */
export class RateLimiter {
  constructor({ windowMs = 3_600_000, maxKeys = 50_000 } = {}) {
    this.windowMs = windowMs;
    this.maxKeys = maxKeys;
    this.hits = new Map(); // key -> { windowStart, count }
  }
  /** Count one call against `key`; true once it exceeds `limit` in the window. */
  over(key, limit, now = Date.now()) {
    let h = this.hits.get(key);
    if (!h || now - h.windowStart > this.windowMs) {
      h = { windowStart: now, count: 0 };
      this.hits.set(key, h);
    }
    h.count++;
    if (this.hits.size > this.maxKeys) this.hits.clear(); // bounded memory under a flood
    return h.count > limit;
  }
}

export const RECORD_GROUPS = ["deposits", "solDeposits", "redemptions", "solRedemptions"];

/** An operator's decision about a record that stopped for a person.
 *  Every action is appended to the state's admin log. */
export function resolveRecord(state, log, group, key, action, body) {
  const list = state.data[group];
  if (!RECORD_GROUPS.includes(group) || !list || !Object.hasOwn(list, key)) {
    throw Object.assign(new Error("no such record"), { status: 404 });
  }
  const r = list[key];
  const before = r.status;
  const isDeposit = group === "deposits" || group === "solDeposits";
  if (action === "retire") {
    r.retired = { note: String(body.note ?? ""), at: new Date().toISOString() };
  } else if (action === "mark_delivered" && isDeposit) {
    if (!/^[0-9a-f]{64}$/.test(String(body.txid ?? ""))) throw Object.assign(new Error("txid required"), { status: 400 });
    r.steps ??= {};
    delete r.steps.pendingSend;
    delete r.steps.sendCandidate;
    r.steps.sendTxid = body.txid;
    r.status = "minted";
  } else if (action === "retry") {
    // The operator asserts that nothing from the stopped step is in flight
    // (they checked the chain), so the step may run again.
    delete r.error;
    delete r.nextAttemptAt;
    r.firstFailureAt = undefined;
    r.attempts = 0;
    if (isDeposit) {
      const st = (r.steps ??= {});
      if (r.status === "delivery_reorged") {
        delete st.sendTxid;
        delete r.deliveryFinal;
      }
      for (const k of ["pendingIssue", "pendingMint", "pendingSend", "issueCandidate", "mintCandidate", "sendCandidate"]) delete st[k];
      // A record on its way back to its depositor stays on that path: sending
      // it to minting while a refund may still be reinstated on the vault
      // would pay the depositor on both chains.
      r.status = String(before).startsWith("refund")
        ? "refund_pending"
        : st.issueTxid || st.mintTxid
          ? "send_retry"
          : "mint_retry";
    } else if (r.status === "destroy_manual") {
      delete r.pendingDestroy;
      delete r.burn;
      r.status = "destroy_pending";
    } else {
      r.status = "new";
    }
  } else {
    throw Object.assign(new Error("unknown action"), { status: 400 });
  }
  state.data.adminLog ??= [];
  state.data.adminLog.push({ at: new Date().toISOString(), group, key, action, from: before, to: r.status, note: body.note ?? null });
  state.save();
  log(`admin: ${action} ${group}/${key} (${before} -> ${r.status})`);
  return r;
}

// Error text can carry an RPC endpoint, API key included (ethers puts the
// request URL into its messages). What the public API returns is scrubbed
// of URLs in every error-like field.
const ERROR_FIELDS = new Set(["error", "lastError", "detail", "waiting", "reason", "finality"]);
export function scrub(v, key = null) {
  if (typeof v === "string") {
    return key && ERROR_FIELDS.has(key) ? v.replace(/[a-z][a-z0-9+.-]*:\/\/[^\s"'<>,;)]+/gi, "<url>") : v;
  }
  if (Array.isArray(v)) return v.map((x) => scrub(x, key));
  if (v && typeof v === "object") {
    const out = {};
    for (const [k, x] of Object.entries(v)) out[k] = scrub(x, k);
    return out;
  }
  return v;
}

export function startApi(cfg, eth, seq, state, bridge, log) {
  const metaCache = new Map(); // token address -> metadata promise

  async function tokenInfo(token) {
    const key = tokenKeyOf(cfg.ethChainId, token);
    const mapping = state.data.mappings[key] ?? null;
    if (mapping) {
      return { token, tokenKey: key, ...publicMapping(mapping), bridged: true };
    }
    if (!metaCache.has(token)) {
      if (metaCache.size > 2000) metaCache.clear();
      metaCache.set(
        token,
        eth.tokenMetadata(token).catch((e) => {
          metaCache.delete(token);
          throw e;
        })
      );
    }
    const meta = await metaCache.get(token);
    return { token, tokenKey: key, ...meta, bridged: false };
  }

  function publicMapping(m) {
    const sources = Object.values(sourcesOf(m));
    return {
      tokenKey: m.tokenKey,
      chainId: m.chainId, // which leg bridged it (ethChainId number, or a chain label)
      // A unified asset is bridged from several chains at once, so a caller
      // filtering per leg must ask which chains it serves rather than which
      // single one it came from.
      unified: m.unified ?? false,
      chainIds: sources.map((s) => s.chainId),
      sources: sources.map((s) => ({
        tokenKey: s.tokenKey,
        chainId: s.chainId,
        token: s.token,
        decimals: s.decimals,
        escrowedUnits: s.escrowedUnits ?? "0",
      })),
      precision: m.precision ?? 8,
      // A supervised asset can be frozen by its issuer and is never blinded,
      // so a confidential destination receives it at its unconfidential form.
      supervised: Boolean(m.supervision?.supervised),
      retired: m.retired ?? null,
      token: m.token,
      symbol: m.symbol,
      name: m.name,
      decimals: m.decimals,
      assetId: m.assetId,
      ticker: m.contract?.ticker ?? null,
      registered: m.registered ?? false,
      contractHash: m.contractHash ?? null,
      issueTxid: m.issueTxid,
      mintedSats: m.mintedSats,
      createdAt: m.createdAt,
    };
  }

  // Per-client limits on the calls that make the bridge do work: every intent
  // is watched, and every redemption address is a wallet key.
  const limiter = new RateLimiter();
  const overLimit = (req, bucket = "intent", limit = cfg.intentLimitPerHour ?? 30) =>
    limiter.over(`${bucket}:${clientIpOf(req, cfg.trustProxy)}`, limit);

  function adminAuthorized(req) {
    if (!cfg.adminToken) return false;
    const got = String(req.headers.authorization ?? "");
    const want = `Bearer ${cfg.adminToken}`;
    return got.length === want.length && crypto.timingSafeEqual(Buffer.from(got), Buffer.from(want));
  }

  function publicDeposit(d) {
    const { steps, ...rest } = d;
    return { ...rest, seqTxid: steps?.sendTxid ?? null };
  }

  const webDir = cfg.webDir
    ? path.resolve(cfg.webDir)
    : path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "web");

  function serveStatic(res, pathname) {
    const rel = pathname === "/" ? "index.html" : pathname.slice(1);
    const file = path.normalize(path.join(webDir, rel));
    if (file !== webDir && !file.startsWith(webDir + path.sep)) {
      res.writeHead(403).end();
      return;
    }
    fs.readFile(file, (err, data) => {
      if (err) {
        res.writeHead(404, { "content-type": "text/plain" }).end("not found");
        return;
      }
      res.writeHead(200, {
        "content-type": MIME[path.extname(file)] ?? "application/octet-stream",
      });
      res.end(data);
    });
  }

  // Proxy a request to the sbtc-bridge (the BTC<->SBTC custody service). The daemon holds the bridge
  // token so the browser never sees it; the bridge itself enforces 1:1 backing.
  async function sbtcBridge(bridgePath, body, method = "POST") {
    const headers = { "content-type": "application/json" };
    if (cfg.sbtcBridgeToken) headers.authorization = "Bearer " + cfg.sbtcBridgeToken;
    const res = await fetch(cfg.sbtcBridgeUrl.replace(/\/+$/, "") + bridgePath, {
      method,
      headers,
      signal: AbortSignal.timeout(15_000),
      ...(method === "GET" ? {} : { body: JSON.stringify(body) }),
    });
    return res.json().catch(() => ({ ok: false, error: "bad bridge response" }));
  }

  // Circulating supply of an asset this daemon did NOT issue.
  //
  // bridge.chainSupplyAtoms reads listissuances, a WALLET call: it sees only
  // issuances this daemon's own wallet made. For an externally issued asset it
  // therefore returns zero, and zero is the one wrong answer that reads as
  // right -- a supply of zero makes any reserve look like full backing. So an
  // external asset is measured against the indexer, which sees the whole
  // chain, and when the indexer cannot be reached the supply is reported as
  // unknown rather than as zero.
  async function externalChainSupplyAtoms(assetId) {
    if (!cfg.esploraUrl) {
      throw new Error("no indexer is configured, so this asset's supply cannot be read");
    }
    const res = await fetch(`${cfg.esploraUrl.replace(/\/+$/, "")}/asset/${assetId}`, {
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) throw new Error(`the indexer returned ${res.status} for this asset`);
    const a = await res.json();
    const stats = a.chain_stats ?? {};
    if (stats.has_blinded_issuances) {
      throw new Error("this asset has a blinded issuance, so its supply is not knowable");
    }
    if (stats.issued_amount === undefined || stats.issued_amount === null) {
      throw new Error("the indexer reported no issuance for this asset");
    }
    return BigInt(stats.issued_amount) - BigInt(stats.burned_amount ?? 0);
  }

  // Whole BTC, as a Bitcoin RPC reports a balance, to satoshis. JSON.parse has
  // already turned it into a double by the time it arrives, so rounding rather
  // than truncating is what keeps it exact: every satoshi count a real balance
  // can hold is far below 2^53 and survives the round trip intact, while the
  // decimal-to-binary step leaves a value like 1.01 a hair under.
  const btcToSats = (btc) => BigInt(Math.round(Number(btc) * 1e8));

  // A chain id is how the daemon routes; it is not how a person reads a page.
  // The rest of the UI already names chains from config, so anything else that
  // shows a chain to a reader resolves it the same way rather than printing a
  // bare 11155111.
  function chainNameOf(chainId) {
    if (chainId === (cfg.solChainLabel ?? "solana-devnet")) return cfg.solChainName ?? "Solana devnet";
    if (String(chainId) === String(cfg.ethChainId)) return cfg.ethChainName ?? `chain ${chainId}`;
    return `chain ${chainId}`;
  }

  // What a source chain actually holds in escrow, in that source's base units.
  //
  // Read from the chain, never from this daemon's escrow counter. Proof of
  // reserves whose both halves come from the operator's own bookkeeping proves
  // only that the bookkeeping agrees with itself; reading the lock side from
  // the source chain and the circulating side from Sequentia means a bug in
  // this daemon surfaces as a discrepancy instead of hiding behind one. It is
  // also the only way to report assets bridged before that counter existed,
  // which otherwise stay permanently untracked.
  //
  // Reads are cached so a page full of open tabs does not become a load
  // generator. The cache alone was not what fixed the Solana 429 though: that
  // endpoint throttles getTokenAccountsByOwner so hard it refuses a single cold
  // call, so the fix was to stop making that call at all (see Sol.escrowBalance).
  //
  // The cache is dropped whenever this daemon itself moves escrow (a deposit
  // credited, a payout made): a cached pre-release balance set beside a fresh
  // post-burn supply would overstate backing, the one direction a proof of
  // reserves must never err in.
  const cache = new Map();
  const ESCROW_TTL_MS = cfg.porCacheMs ?? 60_000;
  let cacheEpoch = 0;
  async function cached(key, fn) {
    if ((bridge.escrowEpoch ?? 0) !== cacheEpoch) {
      cache.clear();
      cacheEpoch = bridge.escrowEpoch ?? 0;
    }
    const now = Date.now();
    const hit = cache.get(key);
    if (hit?.ok && now - hit.at < ESCROW_TTL_MS) return hit;
    try {
      const value = await fn();
      const entry = { ok: true, at: now, value };
      cache.set(key, entry);
      return entry;
    } catch (e) {
      // Serve the last good answer rather than reporting the reserve as
      // unreadable. A rate-limited poll is not evidence that anything changed,
      // and a page that flickers between a figure and an error teaches the
      // reader to disregard it. Staleness is reported instead, so the reader
      // knows how old the number is.
      if (hit?.ok) return { ...hit, staleError: e.message };
      const entry = { ok: false, at: now, error: e.message };
      cache.set(key, entry);
      throw e;
    }
  }

  async function chainEscrowUnits(source) {
    const isSol = source.chainId === (cfg.solChainLabel ?? "solana-devnet");
    if (!isSol) {
      const r = await cached(`eth:${source.tokenKey}`, () => eth.escrowBalance(source.token));
      return { units: r.value, at: r.at, staleError: r.staleError };
    }
    if (!bridge.sol) throw new Error("the Solana leg is not configured");
    const treasury = bridge.sol.treasury.address;
    if (source.token === "sol") {
      const r = await cached("sol:native", () => bridge.sol.balance(treasury));
      return { units: r.value, at: r.at, staleError: r.staleError };
    }
    // Escrow on this leg is NOT all in the treasury. A Solana deposit lands on
    // its own intent address and is never swept, so reading the treasury alone
    // reported a real 20 USDC deposit as zero escrow and called the asset
    // unbacked -- while the daemon's own ledger, the thing chain reads are
    // supposed to check, had it right. Every address the bridge derives is
    // counted, because funds sitting on an unswept intent address are still
    // locked and still backing.
    //
    // This costs one read per intent address, which grows with deposits
    // forever; sweeping intents into the treasury would bound it.
    const owners = [treasury, ...Object.keys(state.data.solWrapIntents ?? {})];
    let total = 0n;
    let at = Date.now();
    let staleError = null;
    for (const owner of owners) {
      const r = await cached(`sol:${owner}:${source.token}`, () =>
        bridge.sol.escrowBalance(owner, source.token, source.tokenProgram ?? null),
      );
      total += r.value;
      at = Math.min(at, r.at);
      staleError = staleError ?? r.staleError;
    }
    return { units: total, at, staleError };
  }

  const server = http.createServer(async (req, res) => {
    res.setHeader("access-control-allow-origin", "*");
    res.setHeader("access-control-allow-methods", "GET, POST, OPTIONS");
    res.setHeader("access-control-allow-headers", "content-type");
    if (req.method === "OPTIONS") {
      res.writeHead(204).end();
      return;
    }

    const send = (code, obj) => {
      res.writeHead(code, { "content-type": "application/json" });
      res.end(JSON.stringify(scrub(obj), null, 1));
    };

    try {
      const url = new URL(req.url, "http://x");
      const parts = url.pathname.split("/").filter(Boolean); // ["api", ...]

      if (parts[0] !== "api") {
        if (req.method === "GET") return serveStatic(res, url.pathname);
        return send(404, { error: "not found" });
      }

      if (parts[1] === "admin") {
        if (!adminAuthorized(req)) return send(404, { error: "not found" });
        if (req.method === "GET" && parts[2] === "records") {
          const want = url.searchParams.get("status");
          const out = [];
          for (const g of RECORD_GROUPS) {
            for (const [key, r] of Object.entries(state.data[g] ?? {})) {
              if (!want || r.status === want) out.push({ group: g, key, ...r });
            }
          }
          return send(200, out);
        }
        if (req.method === "POST" && parts[2] === "resolve") {
          const body = parseJson(await readBody(req));
          if (!body) return send(400, { error: "invalid JSON body" });
          try {
            return send(200, resolveRecord(state, log, String(body.group), String(body.key), String(body.action), body));
          } catch (e) {
            return send(e.status ?? 500, { error: e.message });
          }
        }
        if (req.method === "POST" && (parts[2] === "halt" || parts[2] === "unhalt")) {
          const body = parseJson(await readBody(req));
          if (!body?.assetId) return send(400, { error: "assetId required" });
          if (parts[2] === "unhalt") return send(200, { cleared: bridge.unhalt(String(body.assetId)) });
          bridge.halt(String(body.assetId), body.scope === "mint" ? "mint" : "all", String(body.reason ?? "halted by the operator"));
          return send(200, { halted: state.data.halted[body.assetId] });
        }
        if (req.method === "POST" && parts[2] === "retire-asset") {
          const body = parseJson(await readBody(req));
          if (!body?.mappingKey) return send(400, { error: "mappingKey required" });
          try {
            const r = bridge.retireMapping(String(body.mappingKey), String(body.note ?? ""));
            state.data.adminLog ??= [];
            state.data.adminLog.push({ at: r.retired.at, mappingKey: body.mappingKey, action: "retire-asset", note: r.retired.note });
            state.save();
            return send(200, { retired: r.retired, assetId: r.assetId });
          } catch (e) {
            return send(e.status ?? 500, { error: e.message });
          }
        }
        return send(404, { error: "not found" });
      }

      // The reads that cost the bridge RPC calls get a limit of their own,
      // checked before any of them is answered.
      const isHeavyRead =
        req.method === "GET" && ["por", "seqaddress", "token", "health"].includes(parts[1]);
      if (isHeavyRead && overLimit(req, "read", cfg.readLimitPerHour ?? 1200)) {
        return send(429, { error: "too many requests from this address; try again later" });
      }
      const isIntent =
        req.method === "POST" &&
        (parts[1] === "redeem" ||
          parts[1] === "cctp" ||
          (["sol", "btc"].includes(parts[1]) && ["wrap", "unwrap"].includes(parts[2])));
      if (isIntent && overLimit(req)) {
        return send(429, { error: "too many requests from this address; try again in an hour" });
      }

      if (req.method === "GET" && parts[1] === "health") {
        const h = await bridge.health();
        return send(h.status === "failing" ? 503 : 200, h);
      }

      if (req.method === "GET" && parts[1] === "seqaddress" && parts[2]) {
        try {
          return send(200, await bridge.checkSeqAddress(decodeURIComponent(parts[2])));
        } catch (e) {
          return send(502, { error: `the Sequentia node could not check the address: ${e.message}` });
        }
      }

      if (req.method === "GET" && parts[1] === "status") {
        // Where the Bitcoin reserve actually sits, so the page can show custody
        // for every leg rather than for Ethereum alone. Cached and best-effort:
        // the bridge being unreachable must not take the whole page down.
        let btcReserveAddresses = null;
        let btcCustody = null;
        if (cfg.sbtcBridgeUrl) {
          try {
            const st = await cached("sbtc:status", () => sbtcBridge("/status", null, "GET"));
            btcReserveAddresses = st.value?.reserve_addresses ?? null;
            btcCustody = st.value?.reserve_custody ?? null;
          } catch {}
        }
        return send(200, {
          app: "Compages",
          ethChainId: cfg.ethChainId,
          ethChainName: cfg.ethChainName,
          // The vault the page sends deposits to. `vaultAddress` stays the
          // oldest vault, which anchors how deposit records are keyed.
          vaultAddress: cfg.depositVault ?? cfg.vaultAddress,
          // Every vault, not just the primary one. More than one can hold
          // escrow at a time, and naming only the first understates where user
          // funds actually sit.
          vaultAddresses: eth.vaultAddresses ?? [cfg.vaultAddress].filter(Boolean),
          seqChainLabel: cfg.seqChainLabel,
          ethConfirmations: cfg.ethConfirmations,
          // "finalized": deposits mint once Ethereum finalizes their block
          // (about 13 minutes on mainnet and Sepolia); "confirmations": after
          // ethConfirmations blocks.
          ethFinality: cfg.ethFinality ?? "finalized",
          seqConfirmations: cfg.seqConfirmations,
          btcAnchorConfirmations: cfg.btcAnchorConfirmations ?? 3,
          btcChainName: cfg.btcChainName ?? "Bitcoin testnet4",
          btcConfigured: !!cfg.sbtcBridgeUrl,
          btcReserveAddresses,
          btcCustody,
          solChainName: cfg.solChainName ?? "Solana devnet",
          solChainLabel: cfg.solChainLabel ?? "solana-devnet",
          solConfigured: !!bridge.sol,
          // USDC from and to other chains through Circle's CCTP: the chains,
          // and Circle's contracts the page calls on them.
          cctp: bridge.cctp?.c.enabled
            ? {
                // Each chain's public RPC is included: a wallet needs it to add
                // a chain it does not know yet.
                chains: bridge.cctp.chains,
                tokenMessenger: cfg.cctp.tokenMessengerEvm ?? "0x8FE6B999Dc680CcFDD5Bf7EB0974218be2542DAA",
                messageTransmitter: cfg.cctp.messageTransmitter,
                depositVault: cfg.depositVault ?? cfg.vaultAddress,
                depositHookPrefix: "compages:deposit:",
              }
            : null,
          ...(bridge.sol ? { solTreasury: bridge.sol.treasury.address } : {}),
          maxSatsPerAsset: SEQ_MAX_SATS.toString(),
          bridgedAssets: Object.keys(state.data.mappings).length,
          deposits: Object.keys(state.data.deposits).length,
          redemptions: Object.keys(state.data.redemptions).length,
        });
      }

      if (req.method === "GET" && parts[1] === "assets") {
        return send(200, Object.values(state.data.mappings).map(publicMapping));
      }

      // The signed, append-only reserve history (reserves/snapshot.mjs writes
      // it). Files are served as they are on disk: they are signed bytes.
      if (req.method === "GET" && parts[1] === "por" && parts[2] === "history") {
        const r = await porHistory(cfg.porHistoryDir ? path.resolve(cfg.porHistoryDir) : null, parts.slice(3));
        res.writeHead(r.status, r.headers);
        return res.end(r.body);
      }

      // Proof of reserves. A bridged asset's whole claim is that every unit in
      // circulation is backed one-for-one by a unit escrowed on its source
      // chain, so the bridge publishes both sides and their difference rather
      // than asking anyone to take it on trust. Circulating supply is read
      // from the Sequentia chain itself, not from the daemon's own ledger, so
      // a bug in this daemon shows up here as a discrepancy instead of hiding.
      if (req.method === "GET" && parts[1] === "por" && parts.length === 2) {
        const only = url.searchParams.get("asset");
        const out = [];
        for (const m of Object.values(state.data.mappings)) {
          if (only && m.assetId !== only && m.symbol !== only) continue;
          // Escrow comes from the source chain, so every asset can be reported,
          // including those bridged before this daemon kept an escrow counter
          // at all. The counter is still published beside it: where the two
          // disagree, that gap is itself the finding, and hiding one of them
          // would hide it.
          const rawSources = Object.values(sourcesOf(m));
          const sources = [];
          let escrowedAtoms = 0n;
          let escrowTracked = rawSources.length > 0;
          for (const s of rawSources) {
            let units = null;
            let escrowError = null;
            let readAt = null;
            let stale = null;
            try {
              const r = await chainEscrowUnits(s);
              units = r.units;
              readAt = new Date(r.at).toISOString();
              stale = r.staleError ?? null;
            } catch (e) {
              escrowError = e.message;
            }
            // One unreadable source makes the whole total unknown rather than
            // low. Reporting a partial sum as if it were the reserve would
            // manufacture a shortfall out of an RPC failure.
            if (units === null) escrowTracked = false;
            else escrowedAtoms += unitsToAtoms(units, s.decimals, m.precision);
            sources.push({
              tokenKey: s.tokenKey,
              chainId: s.chainId,
              chainName: chainNameOf(s.chainId),
              token: s.token,
              decimals: s.decimals,
              escrowedUnits: units === null ? null : units.toString(),
              escrowError,
              readAt,
              stale,
              ledgerEscrowedUnits: s.escrowedUnits ?? null,
            });
          }
          if (!escrowTracked) escrowedAtoms = null;

          let chainSupply = null;
          let chainError = null;
          try {
            const supply = await bridge.chainSupplyAtoms(m.assetId);
            if (supply < 0n) {
              // More burned than issued is impossible on a chain that can see
              // the whole history, so this means the history is not visible:
              // typically an asset issued before a chain reset, whose issuance
              // no longer exists. Refuse to report a supply rather than report
              // a negative one.
              chainError =
                "more burned than issued is visible for this asset; its issuance is not on this chain " +
                "(an asset issued before a chain reset will do this)";
            } else {
              chainSupply = supply.toString();
            }
          } catch (e) {
            chainError = e.message;
          }

          const ledger = BigInt(m.mintedSats ?? "0");
          // Backing must never be short. In flight, a deposit is escrowed
          // before it is minted and a redemption is burned before it is
          // released, so escrow may legitimately EXCEED circulation briefly;
          // the reverse would mean unbacked units exist. A verdict is only
          // given when both sides of the comparison were actually measured.
          // A CCTP transfer between two of this asset's escrows is burned on
          // one chain before Circle mints it on the other; it still backs the
          // asset. Listed with the burns, so each can be checked on chain.
          const transit = bridge.cctp?.inTransit(m.assetId) ?? { atoms: 0n, burns: [] };
          if (escrowedAtoms !== null) escrowedAtoms += transit.atoms;
          const comparable = escrowedAtoms !== null && chainSupply !== null;
          out.push({
            assetId: m.assetId,
            symbol: m.symbol,
            ticker: m.contract?.ticker ?? null,
            precision: m.precision ?? 8,
            unified: m.unified ?? false,
            sources,
            escrowTracked,
            escrowSource: escrowTracked ? "chain" : null,
            escrowedAtoms: escrowedAtoms === null ? null : escrowedAtoms.toString(),
            inTransitAtoms: transit.atoms.toString(),
            inTransit: transit.burns,
            recentTransfers: bridge.cctp?.recentTransfers(m.assetId) ?? [],
            ledgerCirculatingAtoms: ledger.toString(),
            chainCirculatingAtoms: chainSupply,
            chainSupplyError: chainError,
            backed: comparable ? escrowedAtoms >= BigInt(chainSupply) : null,
            // An asset the operator has retired (for example one issued
            // before a chain reset, whose tokens no longer exist) is listed
            // with the reason rather than hidden.
            retired: m.retired ?? null,
            ledgerMatchesChain: chainSupply === null ? null : ledger === BigInt(chainSupply),
          });
        }

        // SBTC belongs on this page. It is the same operator's bridge holding
        // the same kind of promise: every circulating unit backed by a unit
        // locked on the source chain.
        //
        // It appears in none of the mappings above only because its reserve is
        // held differently -- BTC in the peg service's reserve on Bitcoin,
        // rather than a token in a vault contract this daemon watches -- so it
        // is measured through the peg service instead of by reading a vault. That is a
        // difference in mechanism, not in who is answerable for it, and a
        // reserves page that omits a reserve it could have checked is worse
        // than no page at all.
        if (cfg.sbtcBridgeUrl && !only) {
          const row = {
            assetId: null,
            symbol: "SBTC",
            ticker: "SBTC",
            precision: 8,
            unified: false,
            // How the reserve is held is the peg service's to state; never
            // assume a threshold of signers it did not name.
            custody: null,
            sources: [],
            escrowTracked: false,
            escrowSource: null,
            escrowedAtoms: null,
            ledgerCirculatingAtoms: null,
            chainCirculatingAtoms: null,
            chainSupplyError: null,
            backed: null,
            ledgerMatchesChain: null,
          };
          try {
            const st = await sbtcBridge("/status", null, "GET");
            if (!st?.ok) throw new Error(st?.error || "the Bitcoin bridge did not answer");
            row.assetId = st.sbtc_asset ?? null;
            row.custody = st.reserve_custody ?? null;
            // reserve_btc is whole BTC from a Bitcoin wallet, not base units.
            if (st.reserve_btc !== null && st.reserve_btc !== undefined) {
              row.sources = [{
                tokenKey: "bitcoin:btc",
                chainId: "bitcoin",
                chainName: cfg.btcChainName ?? "Bitcoin testnet4",
                token: "btc",
                decimals: 8,
                escrowedUnits: btcToSats(st.reserve_btc).toString(),
                escrowError: null,
                ledgerEscrowedUnits: null,
              }];
              row.escrowedAtoms = btcToSats(st.reserve_btc).toString();
              row.escrowTracked = true;
              row.escrowSource = "chain";
            }
            if (row.assetId) {
              const supply = await externalChainSupplyAtoms(row.assetId);
              if (supply < 0n) {
                row.chainSupplyError =
                  "more burned than issued is visible for this asset; its issuance is not on this chain";
              } else {
                row.issuedAtoms = supply.toString();
                // SBTC minted but still sitting with the bridge is inventory,
                // not a liability: nobody holds a claim on it, so the reserve
                // does not have to cover it. Subtracting it is what separates
                // "10 minted at setup, none issued to anyone" from a genuine
                // shortfall, and without it the page reported a 1.01 BTC
                // reserve against 10 SBTC as SHORT while no user held any.
                //
                // Only subtracted when it is actually known. Treating an
                // unreadable float as zero would turn every failed read into a
                // false shortfall, which is the alarm this is fixing.
                if (st.bridge_sbtc_balance !== null && st.bridge_sbtc_balance !== undefined) {
                  const held = btcToSats(st.bridge_sbtc_balance);
                  row.issuerHeldAtoms = held.toString();
                  const circ = supply - held;
                  row.chainCirculatingAtoms = (circ < 0n ? 0n : circ).toString();
                } else {
                  row.issuerHeldAtoms = null;
                  row.chainSupplyError =
                    "the bridge could not report how much SBTC it still holds, so the amount " +
                    "actually in circulation is unknown";
                }
              }
            } else {
              row.chainSupplyError = "the Bitcoin bridge did not say which asset its reserve backs";
            }
          } catch (e) {
            row.chainSupplyError = e.message;
          }
          if (row.escrowedAtoms !== null && row.chainCirculatingAtoms !== null) {
            row.backed = BigInt(row.escrowedAtoms) >= BigInt(row.chainCirculatingAtoms);
          }
          out.push(row);
        }
        // Retired assets (issued before a chain reset, for example) are listed
        // with the reason, not measured: their supply no longer exists here.
        if (!only) {
          for (const m of Object.values(state.data.retiredMappings ?? {})) {
            out.push({
              assetId: m.assetId,
              symbol: m.symbol,
              ticker: m.contract?.ticker ?? null,
              precision: m.precision ?? 8,
              unified: false,
              sources: [],
              escrowTracked: false,
              escrowSource: null,
              escrowedAtoms: null,
              ledgerCirculatingAtoms: null,
              chainCirculatingAtoms: null,
              chainSupplyError: null,
              backed: null,
              ledgerMatchesChain: null,
              retired: m.retired,
            });
          }
        }
        return send(200, {
          generatedAt: new Date().toISOString(),
          assets: out,
        });
      }

      if (req.method === "GET" && parts[1] === "token" && parts[2]) {
        let token = parts[2].toLowerCase();
        if (token !== "eth") {
          try {
            token = ethers.getAddress(token).toLowerCase();
          } catch {
            return send(400, { error: "invalid token address" });
          }
        }
        try {
          return send(200, await tokenInfo(token));
        } catch (e) {
          return send(404, { error: `token lookup failed: ${e.message}` });
        }
      }

      if (req.method === "POST" && parts[1] === "cctp" && parts[2] === "deposit") {
        const body = parseJson(await readBody(req));
        if (!body) return send(400, { error: "invalid JSON body" });
        if (!bridge.cctp?.c.enabled) return send(503, { error: "USDC from other chains is not enabled" });
        try {
          const rec = bridge.cctp.registerInbound(body.sourceDomain, body.txHash);
          return send(200, { key: rec.key, stage: rec.stage });
        } catch (e) {
          if (e.badRequest) return send(400, { error: e.message });
          throw e;
        }
      }
      if (req.method === "GET" && parts[1] === "cctp" && parts[2] === "deposit" && parts[3] && parts[4]) {
        const key = `${Number(parts[3])}:${String(parts[4]).toLowerCase()}`;
        const rec = Object.hasOwn(bridge.cctp?.inbound ?? {}, key) ? bridge.cctp.inbound[key] : null;
        if (!rec) return send(404, { error: "this burn has not been reported to the bridge" });
        const { attestation, message, ethTx, ...pub } = rec;
        // The deposit it became, once relayed: found by the CCTP nonce.
        const dep = rec.nonce
          ? Object.values(state.data.deposits).find((d) => d.cctp?.cctpNonce === rec.nonce) ?? null
          : null;
        return send(200, { ...pub, deposit: dep ? publicDeposit(dep) : null });
      }

      if (req.method === "POST" && parts[1] === "redeem") {
        const raw = parseJson(await readBody(req));
        let ethAddress;
        try {
          ethAddress = ethers.getAddress(raw?.ethAddress ?? "");
        } catch {
          return send(400, { error: "invalid ethAddress" });
        }
        let seqAddress;
        try {
          seqAddress = await bridge.createRedeemIntent(ethAddress, raw?.destinationDomain ?? 0);
        } catch (e) {
          if (e.badRequest) return send(400, { error: e.message });
          throw e;
        }
        return send(200, {
          seqAddress,
          ethAddress,
          destinationDomain: Number(raw?.destinationDomain ?? 0),
          note: `Send any bridged asset to this Sequentia address from any wallet. Once the transfer is final under Bitcoin anchoring (${cfg.btcAnchorConfirmations ?? 3} Bitcoin-anchor confirmations), the locked funds are released to ${ethAddress} on ${
            Number(raw?.destinationDomain ?? 0) ? `${bridge.cctp.chain(raw.destinationDomain).name} (USDC.e, through Circle's CCTP: claim it there with the attestation this page fetches; any other asset is paid on ${cfg.ethChainName})` : cfg.ethChainName
          }. This waits on Bitcoin, not a Sequentia block count, because a Sequentia transaction can be reorged if its Bitcoin anchor is.`,
        });
      }

      if (req.method === "GET" && parts[1] === "redeem" && parts[2] === "by-eth" && parts[3]) {
        let ethAddress;
        try {
          ethAddress = ethers.getAddress(parts[3]);
        } catch {
          return send(400, { error: "invalid Ethereum address" });
        }
        // ?domain=N asks for the address that pays out on that chain; without
        // it, the first one found.
        const wantDomain = url.searchParams.has("domain") ? Number(url.searchParams.get("domain")) : null;
        const entry = Object.entries(state.data.redeemIntents).find(
          ([, it]) => it.ethAddress === ethAddress && (wantDomain === null || Number(it.destinationDomain ?? 0) === wantDomain)
        );
        if (!entry) return send(404, { error: "no redemption address for this Ethereum address yet" });
        const [seqAddress, intent] = entry;
        const redemptions = Object.values(state.data.redemptions).filter((r) => r.seqAddress === seqAddress);
        return send(200, { seqAddress, ...intent, redemptions });
      }

      if (req.method === "GET" && parts[1] === "redeem" && parts[2]) {
        const seqAddress = parts[2];
        const intent = Object.hasOwn(state.data.redeemIntents, seqAddress)
          ? state.data.redeemIntents[seqAddress]
          : null;
        if (!intent) return send(404, { error: "unknown redemption address" });
        const events = Object.values(state.data.redemptions).filter(
          (r) => r.seqAddress === seqAddress
        );
        return send(200, { seqAddress, ...intent, redemptions: events });
      }

      if (req.method === "GET" && parts[1] === "deposit" && parts[2] === "tx" && parts[3]) {
        const hash = parts[3].toLowerCase();
        const matches = Object.values(state.data.deposits)
          .filter((d) => d.ethTxHash.toLowerCase() === hash)
          .map(publicDeposit);
        if (!matches.length) {
          return send(404, {
            error: "deposit not seen yet",
            hint: `deposits are processed after ${cfg.ethConfirmations} confirmations`,
          });
        }
        return send(200, matches);
      }

      // --- Bitcoin bridge (BTC <-> SBTC) -------------------------------------------------------
      // Compages is the unified public wrap/unwrap front (Ethereum today, Bitcoin here, Solana +
      // others coming). Unlike ETH (MetaMask), BTC wrap/unwrap is ADDRESS-based: the user sends
      // BTC / SBTC from any wallet to a bridge-allocated address. We proxy to the sbtc-bridge, which
      // holds custody and mints/burns SBTC 1:1; the daemon holds the bridge token so the browser
      // never sees it.
      if (req.method === "POST" && parts[1] === "btc" && parts[2] === "wrap") {
        if (!cfg.sbtcBridgeUrl) return send(503, { error: "the Bitcoin bridge is not configured" });
        const body = parseJson(await readBody(req));
        if (!body) return send(400, { error: "invalid JSON body" });
        if (!body.seqAddress) return send(400, { error: "seqAddress required" });
        const r = await sbtcBridge("/pegin", { seq_recipient: String(body.seqAddress) });
        if (!r.ok || !r.deposit_address) return send(502, { error: r.error || "bridge error" });
        return send(200, {
          depositAddress: r.deposit_address,
          seqAddress: body.seqAddress,
          note: `Send BTC (testnet4) to this address from any Bitcoin wallet. Once it has one confirmation and Sequentia has anchored the Bitcoin block holding it, you receive the same amount of SBTC at ${body.seqAddress}, 1:1. From then on a Bitcoin reorg that undid your deposit would undo the SBTC credit with it.`,
        });
      }
      // --- Solana bridge (SOL <-> SOL.s) --------------------------------------------------------
      // Address-based like the Bitcoin leg (no wallet extension: the user sends
      // SOL / SOL.s from any wallet to a bridge-allocated address), but custody
      // is native to this daemon: intent addresses are operator-derived,
      // deposits are minted as SOL.s and swept to the operator treasury, and
      // releases are paid from it.
      if (parts[1] === "sol") {
        if (!bridge.sol) return send(503, { error: "the Solana bridge is not configured" });
        const solName = cfg.solChainName ?? "Solana devnet";
        if (req.method === "POST" && parts[2] === "wrap" && !parts[3]) {
          const body = parseJson(await readBody(req));
          if (!body) return send(400, { error: "invalid JSON body" });
          if (!body.seqAddress) return send(400, { error: "seqAddress required" });
          let depositAddress;
          try {
            depositAddress = await bridge.createSolWrapIntent(String(body.seqAddress));
          } catch (e) {
            if (e.badRequest) return send(400, { error: e.message });
            if (e.busy) return send(503, { error: e.message });
            throw e;
          }
          return send(200, {
            depositAddress,
            seqAddress: body.seqAddress,
            note: `Send SOL or any SPL token (${solName}) to this address from any Solana wallet; SOL deposits need at least 0.001 SOL. Sequentia amounts have 8 decimal places, so decimals beyond 8 are dropped. Once the transfer is finalized on Solana and picked up by the bridge, usually under a minute, the matching .s asset is minted to ${body.seqAddress}: SOL as SOL.s, a token under its own ticker, issued on first bridge exactly like the Ethereum leg's ERC-20s.`,
          });
        }
        if (req.method === "GET" && parts[2] === "intents") {
          // Every deposit address the bridge has handed out. Escrow on this
          // leg sits on these and on the treasury, so anyone checking the
          // reserves needs the list; the addresses are public on chain anyway.
          return send(200, {
            treasury: bridge.sol.treasury.address,
            addresses: Object.keys(state.data.solWrapIntents),
          });
        }
        if (req.method === "GET" && parts[2] === "wrap" && parts[3]) {
          const intent = Object.hasOwn(state.data.solWrapIntents, parts[3])
            ? state.data.solWrapIntents[parts[3]]
            : null;
          if (!intent) return send(404, { error: "unknown deposit address" });
          const deposits = Object.values(state.data.solDeposits)
            .filter((d) => d.address === parts[3])
            .map(publicDeposit);
          return send(200, {
            depositAddress: parts[3],
            seqAddress: intent.seqAddress,
            createdAt: intent.createdAt,
            deposits,
          });
        }
        if (req.method === "POST" && parts[2] === "unwrap" && !parts[3]) {
          const body = parseJson(await readBody(req));
          if (!body) return send(400, { error: "invalid JSON body" });
          if (!body.solAddress) return send(400, { error: "solAddress required" });
          let seqAddress;
          try {
            seqAddress = await bridge.createSolRedeemIntent(String(body.solAddress));
          } catch (e) {
            if (e.badRequest) return send(400, { error: e.message });
            throw e;
          }
          return send(200, {
            seqAddress,
            solAddress: body.solAddress,
            note: `Send any Solana-bridged asset (SOL.s or a bridged token) to this Sequentia address from any wallet; SOL.s returns need at least 0.001 (a smaller lamport release cannot create a Solana account and is parked for the operator). Once the burn is final under Bitcoin anchoring (${cfg.btcAnchorConfirmations ?? 3} Bitcoin-anchor confirmations), the original SOL or tokens are released to ${body.solAddress} on ${solName}. This waits on Bitcoin, not a Sequentia block count, because a Sequentia transaction can be reorged if its Bitcoin anchor is.`,
          });
        }
        if (req.method === "GET" && parts[2] === "redeem" && parts[3]) {
          const seqAddress = parts[3];
          const intent = Object.hasOwn(state.data.solRedeemIntents, seqAddress)
            ? state.data.solRedeemIntents[seqAddress]
            : null;
          if (!intent) return send(404, { error: "unknown redemption address" });
          const redemptions = Object.values(state.data.solRedemptions).filter(
            (r) => r.seqAddress === seqAddress
          );
          return send(200, { seqAddress, ...intent, redemptions });
        }
        return send(404, { error: "not found" });
      }

      // Where a user's bitcoin is: every transfer to a peg-in deposit address
      // or an SBTC return address, as the peg service reports it.
      if (req.method === "GET" && parts[1] === "btc" && (parts[2] === "wrap" || parts[2] === "unwrap") && parts[3]) {
        if (!cfg.sbtcBridgeUrl) return send(503, { error: "the Bitcoin bridge is not configured" });
        if (!/^[A-Za-z0-9]{20,120}$/.test(parts[3])) return send(400, { error: "invalid address" });
        const r = await sbtcBridge(`/${parts[2] === "wrap" ? "pegin" : "pegout"}/${parts[3]}`, null, "GET");
        if (!r.ok) return send(r.error === "unknown address" ? 404 : 502, { error: r.error || "bridge error" });
        const { ok, ...rest } = r;
        return send(200, { ...rest, btcChainName: cfg.btcChainName ?? "Bitcoin testnet4" });
      }

      if (req.method === "POST" && parts[1] === "btc" && parts[2] === "unwrap") {
        if (!cfg.sbtcBridgeUrl) return send(503, { error: "the Bitcoin bridge is not configured" });
        const body = parseJson(await readBody(req));
        if (!body) return send(400, { error: "invalid JSON body" });
        if (!body.btcAddress) return send(400, { error: "btcAddress required" });
        const r = await sbtcBridge("/pegout", { btc_dest: String(body.btcAddress) });
        if (!r.ok || !r.sbtc_address) return send(502, { error: r.error || "bridge error" });
        return send(200, {
          sbtcAddress: r.sbtc_address,
          btcAddress: body.btcAddress,
          note: `Send SBTC to this Sequentia address from any wallet. It is burned and the same amount of real BTC is released to ${body.btcAddress}, 1:1.`,
        });
      }

      return send(404, { error: "not found" });
    } catch (e) {
      log(`api error: ${e.message}`);
      send(500, { error: "internal error" });
    }
  });

  server.listen(cfg.apiPort, cfg.apiHost ?? "127.0.0.1", () => {
    log(`api listening on ${cfg.apiHost ?? "127.0.0.1"}:${cfg.apiPort}`);
  });
  return server;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (c) => {
      data += c;
      if (data.length > 65536) {
        // Settle AND stop the stream: rejecting alone would keep buffering
        // whatever the client cares to send until its timeout.
        reject(new Error("body too large"));
        req.destroy();
      }
    });
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}

/** JSON.parse that answers null for malformed bodies (a client error, not a
 *  server fault: callers turn it into a 400). */
function parseJson(raw) {
  try {
    return JSON.parse(raw || "{}");
  } catch {
    return null;
  }
}
