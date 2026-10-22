// A small stand-in for the Esplora indexer the watcher reads, answering from a
// node's RPC (with -txindex) the few calls the watcher makes:
//
//   GET /asset/:id                    chain_stats and mempool_stats: issued and
//                                     burned amounts, reissuance tokens
//   GET /tx/:txid                     the transaction, with each input's prevout
//   GET /tx/:txid/outspend/:vout      whether the output is spent, and by what
//
// Every answer is read from the node when asked (blocks are cached by hash),
// so a reorg shows at once. For the e2e suites only.
//
//   node mini-esplora.mjs <port>      with SEQ_RPC_URL naming the node

import http from "node:http";
import { rpcClient } from "./leaf-chain.mjs";

const rpc = rpcClient(process.env.SEQ_RPC_URL);
const port = Number(process.argv[2]);
const atoms = (v) => BigInt(Math.round(Number(v) * 1e8));
const blocks = new Map();

async function block(h) {
  const hash = await rpc("getblockhash", [h]);
  if (!blocks.has(hash)) blocks.set(hash, await rpc("getblock", [hash, 2]));
  return blocks.get(hash);
}

async function prevScript(txid, vout) {
  const t = await rpc("getrawtransaction", [txid, true]).catch(() => null);
  return t?.vout?.[vout]?.scriptPubKey?.hex ?? null;
}

async function esploraTx(t, status) {
  const vin = [];
  for (const i of t.vin ?? []) {
    const e = { txid: i.txid, vout: i.vout, is_coinbase: Boolean(i.coinbase) };
    if (i.txid) e.prevout = { scriptpubkey: await prevScript(i.txid, i.vout) };
    if (i.issuance) {
      e.issuance = { asset_id: i.issuance.asset, is_reissuance: Boolean(i.issuance.isreissuance) };
      if (i.issuance.assetamount !== undefined) e.issuance.assetamount = Number(atoms(i.issuance.assetamount));
      if (i.issuance.assetamountcommitment !== undefined) e.issuance.assetamountcommitment = i.issuance.assetamountcommitment;
    }
    vin.push(e);
  }
  const vout = (t.vout ?? []).map((o) => ({ scriptpubkey: o.scriptPubKey?.hex ?? "", asset: o.asset, value: o.value === undefined ? undefined : Number(atoms(o.value)) }));
  return { txid: t.txid, vin, vout, status };
}

function statsOf(txs, assetId, tokenId) {
  const s = { issued_amount: 0n, burned_amount: 0n, has_blinded_issuances: false, reissuance_tokens: 0n, burned_reissuance_tokens: 0n };
  for (const t of txs) {
    for (const i of t.vin ?? []) {
      if (!i.issuance) continue;
      if (i.issuance.asset === assetId) {
        if (i.issuance.assetamountcommitment !== undefined) s.has_blinded_issuances = true;
        else if (i.issuance.assetamount !== undefined) s.issued_amount += atoms(i.issuance.assetamount);
        if (!i.issuance.isreissuance && i.issuance.tokenamount !== undefined) s.reissuance_tokens += atoms(i.issuance.tokenamount);
      }
    }
    for (const o of t.vout ?? []) {
      if (!String(o.scriptPubKey?.hex ?? "").startsWith("6a")) continue; // provably unspendable: a burn
      if (o.asset === assetId && o.value !== undefined) s.burned_amount += atoms(o.value);
      if (tokenId && o.asset === tokenId && o.value !== undefined) s.burned_reissuance_tokens += atoms(o.value);
    }
  }
  return Object.fromEntries(Object.entries(s).map(([k, v]) => [k, typeof v === "bigint" ? Number(v) : v]));
}

async function chainTxs() {
  const tip = await rpc("getblockcount");
  const out = [];
  for (let h = 0; h <= tip; h++) out.push(...(await block(h)).tx.map((t) => ({ ...t, height: h })));
  return out;
}

async function mempoolTxs() {
  const out = [];
  for (const txid of await rpc("getrawmempool")) {
    const t = await rpc("getrawtransaction", [txid, true]).catch(() => null);
    if (t) out.push(t);
  }
  return out;
}

async function handle(path) {
  let m;
  if ((m = path.match(/^\/asset\/([0-9a-f]{64})$/))) {
    const id = m[1];
    const chain = await chainTxs();
    // The token id of the asset: from its issuance, as the node reports it.
    let token = null;
    for (const t of chain) for (const i of t.vin ?? []) if (i.issuance?.asset === id && i.issuance.token) token = i.issuance.token;
    return { asset_id: id, chain_stats: statsOf(chain, id, token), mempool_stats: statsOf(await mempoolTxs(), id, token) };
  }
  if ((m = path.match(/^\/tx\/([0-9a-f]{64})\/outspend\/(\d+)$/))) {
    const [txid, vout] = [m[1], Number(m[2])];
    if (await rpc("gettxout", [txid, vout, true])) return { spent: false };
    for (const t of await mempoolTxs()) if ((t.vin ?? []).some((i) => i.txid === txid && i.vout === vout)) return { spent: true, txid: t.txid, status: { confirmed: false } };
    const tip = await rpc("getblockcount");
    for (let h = tip; h >= 0; h--) {
      const b = await block(h);
      const t = b.tx.find((x) => (x.vin ?? []).some((i) => i.txid === txid && i.vout === vout));
      if (t) return { spent: true, txid: t.txid, status: { confirmed: true, block_height: h } };
    }
    return { spent: false };
  }
  if ((m = path.match(/^\/tx\/([0-9a-f]{64})$/))) {
    const t = await rpc("getrawtransaction", [m[1], true]);
    let status = { confirmed: false };
    if (t.blockhash) {
      const h = await rpc("getblockheader", [t.blockhash]);
      if (h.confirmations >= 1) status = { confirmed: true, block_height: h.height, block_hash: t.blockhash };
    }
    return esploraTx(t, status);
  }
  return null;
}

http
  .createServer(async (req, res) => {
    try {
      const out = await handle(new URL(req.url, "http://x").pathname);
      if (out === null) res.writeHead(404).end("not found");
      else res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(out));
    } catch (e) {
      res.writeHead(500).end(e.message);
    }
  })
  .listen(port, "127.0.0.1", () => console.log(`mini-esplora on ${port}`));
