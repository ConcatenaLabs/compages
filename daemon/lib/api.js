// Compages HTTP API for the web front-end. JSON everywhere, permissive CORS
// (the front-end is a static page; the API holds no secrets and every
// mutating action is limited to creating a redemption intent).

import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ethers } from "ethers";
import { tokenKeyOf, SEQ_MAX_SATS } from "./bridge.js";

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
    return {
      tokenKey: m.tokenKey,
      token: m.token,
      symbol: m.symbol,
      name: m.name,
      decimals: m.decimals,
      assetId: m.assetId,
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
        return send(200, {
          app: "Compages",
          ethChainId: cfg.ethChainId,
          ethChainName: cfg.ethChainName,
          vaultAddress: cfg.vaultAddress,
          seqChainLabel: cfg.seqChainLabel,
          ethConfirmations: cfg.ethConfirmations,
          seqConfirmations: cfg.seqConfirmations,
          btcAnchorConfirmations: cfg.btcAnchorConfirmations ?? 3,
          maxSatsPerAsset: SEQ_MAX_SATS.toString(),
          bridgedAssets: Object.keys(state.data.mappings).length,
          deposits: Object.keys(state.data.deposits).length,
          redemptions: Object.keys(state.data.redemptions).length,
        });
      }

      if (req.method === "GET" && parts[1] === "assets") {
        return send(200, Object.values(state.data.mappings).map(publicMapping));
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
        const intent = state.data.redeemIntents[seqAddress];
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
      if (data.length > 65536) reject(new Error("body too large"));
    });
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}
