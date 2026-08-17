// Compages HTTP API for the web front-end. JSON everywhere, permissive CORS
// (the front-end is a static page; the API holds no secrets and every
// mutating action is limited to creating a redemption intent).

import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ethers } from "ethers";
import { tokenKeyOf, sourcesOf, SEQ_MAX_SATS } from "./bridge.js";
import { unitsToAtoms } from "./eth.js";

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
};

export function startApi(cfg, eth, seq, state, bridge, log) {
  const metaCache = new Map(); // token address -> metadata promise

  async function tokenInfo(token) {
    const key = tokenKeyOf(cfg.ethChainId, token);
    const mapping = state.data.mappings[key] ?? null;
    if (mapping) {
      return { token, tokenKey: key, ...publicMapping(mapping), bridged: true };
    }
    if (!metaCache.has(token)) {
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
    const res = await fetch(`${cfg.esploraUrl.replace(/\/+$/, "")}/asset/${assetId}`);
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
  const cache = new Map();
  const ESCROW_TTL_MS = 60_000;
  async function cached(key, fn) {
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
      res.end(JSON.stringify(obj, null, 1));
    };

    try {
      const url = new URL(req.url, "http://x");
      const parts = url.pathname.split("/").filter(Boolean); // ["api", ...]

      if (parts[0] !== "api") {
        if (req.method === "GET") return serveStatic(res, url.pathname);
        return send(404, { error: "not found" });
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
          vaultAddress: cfg.vaultAddress,
          // Every vault, not just the primary one. More than one can hold
          // escrow at a time, and naming only the first understates where user
          // funds actually sit.
          vaultAddresses: eth.vaultAddresses ?? [cfg.vaultAddress].filter(Boolean),
          seqChainLabel: cfg.seqChainLabel,
          ethConfirmations: cfg.ethConfirmations,
          seqConfirmations: cfg.seqConfirmations,
          btcAnchorConfirmations: cfg.btcAnchorConfirmations ?? 3,
          btcChainName: cfg.btcChainName ?? "Bitcoin testnet4",
          btcConfigured: !!cfg.sbtcBridgeUrl,
          btcReserveAddresses,
          btcCustody,
          solChainName: cfg.solChainName ?? "Solana devnet",
          solChainLabel: cfg.solChainLabel ?? "solana-devnet",
          solConfigured: !!bridge.sol,
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

      // Proof of reserves. A bridged asset's whole claim is that every unit in
      // circulation is backed one-for-one by a unit escrowed on its source
      // chain, so the bridge publishes both sides and their difference rather
      // than asking anyone to take it on trust. Circulating supply is read
      // from the Sequentia chain itself, not from the daemon's own ledger, so
      // a bug in this daemon shows up here as a discrepancy instead of hiding.
      if (req.method === "GET" && parts[1] === "por") {
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
            ledgerCirculatingAtoms: ledger.toString(),
            chainCirculatingAtoms: chainSupply,
            chainSupplyError: chainError,
            backed: comparable ? escrowedAtoms >= BigInt(chainSupply) : null,
            ledgerMatchesChain: chainSupply === null ? null : ledger === BigInt(chainSupply),
          });
        }

        // SBTC belongs on this page. It is the same operator's bridge holding
        // the same kind of promise: every circulating unit backed by a unit
        // locked on the source chain.
        //
        // It appears in none of the mappings above only because its reserve is
        // held differently -- BTC in the peg multisig on Bitcoin, rather than a
        // token in a vault contract this daemon watches -- so it is measured
        // through the peg service instead of by reading a vault. That is a
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
            custody: "BTC in the peg multisig, via the SBTC peg service",
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
                row.chainCirculatingAtoms = supply.toString();
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

      if (req.method === "POST" && parts[1] === "redeem") {
        const body = await readBody(req);
        let ethAddress;
        try {
          ethAddress = ethers.getAddress(JSON.parse(body || "{}").ethAddress ?? "");
        } catch {
          return send(400, { error: "invalid ethAddress" });
        }
        const seqAddress = await bridge.createRedeemIntent(ethAddress);
        return send(200, {
          seqAddress,
          ethAddress,
          note: `Send any bridged asset to this Sequentia address from any wallet. Once the burn is final under Bitcoin anchoring (${cfg.btcAnchorConfirmations ?? 3} Bitcoin-anchor confirmations), the locked funds are released to ${ethAddress} on ${cfg.ethChainName}. This waits on Bitcoin, not a Sequentia block count, because a Sequentia transaction can be reorged if its Bitcoin anchor is.`,
        });
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
          note: `Send BTC (testnet4) to this address from any Bitcoin wallet. After ${cfg.btcConfirmations ?? 2} confirmations you receive the same amount of SBTC at ${body.seqAddress}, 1:1.`,
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
            throw e;
          }
          return send(200, {
            depositAddress,
            seqAddress: body.seqAddress,
            note: `Send SOL or any SPL token (${solName}) to this address from any Solana wallet; SOL deposits need at least 0.001 SOL. Sequentia amounts have 8 decimal places, so decimals beyond 8 are dropped. Once the transfer is finalized on Solana and picked up by the bridge, usually under a minute, the matching .s asset is minted to ${body.seqAddress}: SOL as SOL.s, a token under its own ticker, issued on first bridge exactly like the Ethereum leg's ERC-20s.`,
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
