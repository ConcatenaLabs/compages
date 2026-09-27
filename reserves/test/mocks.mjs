// In-memory stand-ins for the four things a snapshot reads: a Sequentia
// node, an Ethereum node, a Solana node and the bridge daemon. Each is a
// real HTTP server on a random local port, so the tool is exercised through
// the same clients it uses in production.

import http from "node:http";
import crypto from "node:crypto";
import { ethers } from "ethers";

function serve(handler) {
  return new Promise((resolve) => {
    const server = http.createServer(async (req, res) => {
      let body = "";
      for await (const c of req) body += c;
      try {
        const [status, obj] = await handler(req, body);
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify(obj));
      } catch (e) {
        res.writeHead(500).end(String(e.stack));
      }
    });
    server.listen(0, "127.0.0.1", () => resolve({ server, url: `http://127.0.0.1:${server.address().port}` }));
  });
}

// ---- Sequentia ----------------------------------------------------------------

/** A chain of `tip + 1` blocks, 60 s apart. `txs[h]` are the decoded
 *  transactions of block h (verbosity 2). Changing `fork` renames every
 *  block from `forkFrom` up, as a reorg does. */
export async function mockSequentia({ user = "u", password = "p" } = {}) {
  const chain = { tip: 0, txs: {}, fork: 0, forkFrom: Infinity, t0: 1_700_000_000, calls: [] };
  const hashOf = (h) =>
    crypto.createHash("sha256").update(`block ${h} ${h >= chain.forkFrom ? chain.fork : 0}`).digest("hex");
  const auth = "Basic " + Buffer.from(`${user}:${password}`).toString("base64");
  const { server, url } = await serve(async (req, body) => {
    if (req.headers.authorization !== auth) return [401, { error: "unauthorized" }];
    const { id, method, params } = JSON.parse(body);
    chain.calls.push(method);
    const ok = (result) => [200, { id, result, error: null }];
    const byHash = (hash) => {
      const shape = `${chain.tip}/${chain.fork}/${chain.forkFrom}`;
      if (chain.index?.shape !== shape) {
        chain.index = { shape, map: new Map() };
        for (let h = 0; h <= chain.tip; h++) chain.index.map.set(hashOf(h), h);
      }
      return chain.index.map.get(hash) ?? null;
    };
    switch (method) {
      case "getblockcount":
        return ok(chain.tip);
      case "getblockhash":
        if (params[0] > chain.tip) return [200, { id, result: null, error: { code: -8, message: "Block height out of range" } }];
        return ok(hashOf(params[0]));
      case "getblockheader": {
        const h = byHash(params[0]);
        return ok({ hash: params[0], height: h, time: chain.t0 + 60 * h, mediantime: chain.t0 + 60 * h - 300 });
      }
      case "getblock": {
        const h = byHash(params[0]);
        return ok({ hash: params[0], height: h, tx: chain.txs[h] ?? [] });
      }
      case "getblockchaininfo":
        return ok({ chain: "test", blocks: chain.tip });
      default:
        return [200, { id, result: null, error: { code: -32601, message: `no ${method}` } }];
    }
  });
  chain.hashOf = hashOf;
  chain.timeOf = (h) => chain.t0 + 60 * h;
  return { chain, server, rpcUrl: `http://${user}:${password}@${url.slice(7)}/`, url };
}

// ---- Ethereum -----------------------------------------------------------------

const ERC20 = new ethers.Interface(["function balanceOf(address) view returns (uint256)"]);
const TRANSMITTER = new ethers.Interface(["function usedNonces(bytes32) view returns (uint256)"]);
const VAULT = new ethers.Interface([
  "function VERSION() view returns (uint256)",
  "function owedTotal(address) view returns (uint256)",
  "function queuedTotal(address) view returns (uint256)",
  "function cancelledTotal(address) view returns (uint256)",
]);

/** Blocks 12 s apart from `t0`. `vaults[address] = { deployedAt, version,
 *  ether(n), tokens: { [token]: (n) => balance }, reserved: (fn, token, n)
 *  => amount }`. `finalized` is the finalized block number. */
/** `transmitter`/`nonces`: Circle's MessageTransmitter at that address,
 *  where nonces[nonce] is the block from which it counts as used. */
export async function mockEthereum({ chainId = 11155111, t0 = 1_700_000_000, vaults = {}, finalized = 0, transmitter = null, nonces = {} } = {}) {
  const eth = { chainId, t0, vaults, finalized, transmitter, nonces, calls: [] };
  const blockHash = (n) => ethers.id(`eth block ${n}`);
  const blockOf = (n) => ({
    number: ethers.toQuantity(n),
    hash: blockHash(n),
    parentHash: n ? blockHash(n - 1) : ethers.ZeroHash,
    timestamp: ethers.toQuantity(t0 + 12 * n),
    nonce: "0x0000000000000000",
    difficulty: "0x0",
    gasLimit: "0x1c9c380",
    gasUsed: "0x0",
    miner: ethers.ZeroAddress,
    extraData: "0x",
    baseFeePerGas: "0x7",
    transactions: [],
  });
  const tagOf = (tag) => (tag === "finalized" || tag === "latest" ? eth.finalized : Number(tag));
  const vaultAt = (addr) => eth.vaults[ethers.getAddress(addr)];
  const { server, url } = await serve(async (req, body) => {
    const { id, method, params } = JSON.parse(body);
    eth.calls.push(method);
    const ok = (result) => [200, { jsonrpc: "2.0", id, result }];
    const revert = () => [200, { jsonrpc: "2.0", id, error: { code: 3, message: "execution reverted", data: "0x" } }];
    switch (method) {
      case "eth_chainId":
        return ok(ethers.toQuantity(eth.chainId));
      case "eth_getBlockByNumber": {
        const n = tagOf(params[0]);
        return ok(n > Math.max(eth.finalized + 64, 0) ? null : blockOf(n));
      }
      case "eth_getCode": {
        const v = vaultAt(params[0]);
        return ok(v && tagOf(params[1]) >= v.deployedAt ? "0x6080" : "0x");
      }
      case "eth_getBalance": {
        const v = vaultAt(params[0]);
        return ok(ethers.toQuantity(v?.ether?.(tagOf(params[1])) ?? 0n));
      }
      case "eth_call": {
        const { to, data } = params[0];
        const n = tagOf(params[1]);
        const sel = data.slice(0, 10);
        if (sel === ERC20.getFunction("balanceOf").selector) {
          const [holder] = ERC20.decodeFunctionData("balanceOf", data);
          const v = vaultAt(holder);
          const bal = v?.tokens?.[ethers.getAddress(to)]?.(n) ?? 0n;
          return ok(ERC20.encodeFunctionResult("balanceOf", [bal]));
        }
        if (eth.transmitter && to.toLowerCase() === eth.transmitter.toLowerCase()) {
          const [nonce] = TRANSMITTER.decodeFunctionData("usedNonces", data);
          const from = eth.nonces[nonce.toLowerCase()];
          return ok(TRANSMITTER.encodeFunctionResult("usedNonces", [from !== undefined && n >= from ? 1n : 0n]));
        }
        const v = vaultAt(to);
        if (!v || n < v.deployedAt || (v.version === null && !v.versionError)) return revert();
        const f = VAULT.parseTransaction({ data });
        if (!f) return revert();
        // publicnode answers an older vault's missing VERSION() with a revert
        // that carries no data, which ethers cannot classify as one.
        if (f.name === "VERSION" && v.versionError) return [200, { jsonrpc: "2.0", id, error: { code: 3, message: "execution reverted" } }];
        if (f.name === "VERSION") return ok(VAULT.encodeFunctionResult("VERSION", [v.version]));
        const token = ethers.getAddress(f.args[0]);
        return ok(VAULT.encodeFunctionResult(f.name, [v.reserved?.(f.name, token, n) ?? 0n]));
      }
      default:
        return [200, { jsonrpc: "2.0", id, error: { code: -32601, message: `no ${method}` } }];
    }
  });
  eth.blockHash = blockHash;
  return { eth, server, url };
}

// ---- Solana -------------------------------------------------------------------

/** `accounts[address]` is what getMultipleAccounts answers for it;
 *  `transactions[signature]` what getTransaction does. */
export async function mockSolana({ genesis = "GENESIS", slot = 100, accounts = {}, transactions = {} } = {}) {
  const sol = { genesis, slot, accounts, transactions, calls: [] };
  const { server, url } = await serve(async (req, body) => {
    const { id, method, params } = JSON.parse(body);
    sol.calls.push(method);
    const ok = (result) => [200, { jsonrpc: "2.0", id, result }];
    switch (method) {
      case "getGenesisHash":
        return ok(sol.genesis);
      case "getMultipleAccounts":
        if (params[0].length > 100) return [200, { jsonrpc: "2.0", id, error: { code: -32602, message: "too many" } }];
        return ok({ context: { slot: Math.max(sol.slot, params[1]?.minContextSlot ?? 0) }, value: params[0].map((a) => sol.accounts[a] ?? null) });
      case "getTransaction":
        return ok(sol.transactions[params[0]] ?? null);
      default:
        return [200, { jsonrpc: "2.0", id, error: { code: -32601, message: `no ${method}` } }];
    }
  });
  return { sol, server, url };
}

export const tokenAccount = (owner, mint, amount) => ({
  lamports: 2039280,
  owner: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
  data: { parsed: { info: { owner, mint, tokenAmount: { amount: String(amount), decimals: 6 } }, type: "account" }, program: "spl-token" },
});

// ---- the daemon ---------------------------------------------------------------

export async function mockDaemon({ assets = [], intents = { treasury: null, addresses: [] }, inTransit = {}, recentTransfers = null } = {}) {
  const d = { assets, intents, inTransit, recentTransfers };
  const { server, url } = await serve(async (req) => {
    const u = new URL(req.url, "http://x");
    if (u.pathname === "/api/assets") return [200, d.assets];
    if (u.pathname === "/api/sol/intents") return [200, d.intents];
    if (u.pathname === "/api/por") {
      const a = u.searchParams.get("asset");
      const row = { inTransit: d.inTransit[a] ?? [] };
      if (d.recentTransfers) row.recentTransfers = d.recentTransfers[a] ?? [];
      return [200, { assets: [row] }];
    }
    return [404, { error: "not found" }];
  });
  return { daemon: d, server, url };
}

// ---- Circle's attestation service ------------------------------------------------

/** A CCTP V2 burn message with `nonce`, `amount` and `feeExecuted` at the
 *  offsets Circle's format puts them. */
export function cctpMessage({ nonce, amount, feeExecuted = 0n }) {
  const b = Buffer.alloc(148 + 228);
  Buffer.from(nonce.slice(2), "hex").copy(b, 12);
  Buffer.from(ethers.toBeHex(BigInt(amount), 32).slice(2), "hex").copy(b, 148 + 68);
  Buffer.from(ethers.toBeHex(BigInt(feeExecuted), 32).slice(2), "hex").copy(b, 148 + 164);
  return `0x${b.toString("hex")}`;
}

/** `messages[signature]` is the message Circle has attested for that Solana
 *  burn; any other burn is unknown (404), as for a burn not yet attested. */
export async function mockIris({ messages = {} } = {}) {
  const { server, url } = await serve(async (req) => {
    const u = new URL(req.url, "http://x");
    const m = messages[u.searchParams.get("transactionHash")];
    if (!u.pathname.startsWith("/v2/messages/5") || !m) return [404, { error: "Message not found" }];
    return [200, { messages: [{ status: "complete", message: m, attestation: "0x00" }] }];
  });
  return { server, url };
}
