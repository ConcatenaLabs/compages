// A stand-in for Circle's attestation service (Iris) for the e2e suite.
//
//   node mock-iris.mjs --port 18995 --eth http://127.0.0.1:8545 --transmitter 0x...
//
// GET /v2/messages/<domain>?transactionHash=<hash> answers the way Iris does.
// For domain 0 (the local test chain) it finds the burn's message itself, in
// the MessageSent log the mock transmitter emitted in that transaction. For
// any other domain it answers with messages the suite registered with
// POST /__add {domain, txHash, message}, which stands for a burn made on
// another chain. Every message is "attested" with the bytes the mock
// transmitter accepts ("valid").

import http from "node:http";

const arg = (name, dflt) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : dflt;
};
const PORT = Number(arg("port", 18995));
const ETH = arg("eth", "http://127.0.0.1:8545");
const TRANSMITTER = String(arg("transmitter", "")).toLowerCase();
const ATTESTATION = "0x" + Buffer.from("valid").toString("hex");
// keccak256("MessageSent(bytes)")
const MESSAGE_SENT = "0x8c5261668696ce22758910d05bab8f186d6eb247ceac2af2e82c7dc17669b036";

const registered = new Map(); // "domain:txhash" -> [message hex]

async function ethRpc(method, params) {
  const r = await fetch(ETH, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  return (await r.json()).result;
}

function decodeBytes(data) {
  const hex = data.slice(2);
  const len = parseInt(hex.slice(64, 128), 16);
  return "0x" + hex.slice(128, 128 + len * 2);
}

async function messagesFor(domain, txHash) {
  const key = `${domain}:${txHash.toLowerCase()}`;
  if (registered.has(key)) return registered.get(key);
  if (domain !== 0) return [];
  const receipt = await ethRpc("eth_getTransactionReceipt", [txHash]);
  return (receipt?.logs ?? [])
    .filter((l) => l.address.toLowerCase() === TRANSMITTER && l.topics[0] === MESSAGE_SENT)
    .map((l) => decodeBytes(l.data));
}

http
  .createServer(async (req, res) => {
    const url = new URL(req.url, "http://x");
    const body = await new Promise((resolve) => {
      let d = "";
      req.on("data", (c) => (d += c));
      req.on("end", () => resolve(d));
    });
    if (req.method === "POST" && url.pathname === "/__add") {
      const { domain, txHash, message } = JSON.parse(body);
      const key = `${Number(domain)}:${String(txHash).toLowerCase()}`;
      registered.set(key, [...(registered.get(key) ?? []), message]);
      res.writeHead(200).end("{}");
      return;
    }
    const m = url.pathname.match(/^\/v2\/messages\/(\d+)$/);
    if (req.method === "GET" && m) {
      const msgs = await messagesFor(Number(m[1]), url.searchParams.get("transactionHash") ?? "");
      if (!msgs.length) {
        res.writeHead(404, { "content-type": "application/json" }).end(JSON.stringify({ error: "Message not found" }));
        return;
      }
      res.writeHead(200, { "content-type": "application/json" }).end(
        JSON.stringify({
          messages: msgs.map((message) => ({
            status: "complete",
            message,
            attestation: ATTESTATION,
            eventNonce: "0x" + message.slice(2 + 24, 2 + 88),
            cctpVersion: 2,
            decodedMessage: null,
          })),
        })
      );
      return;
    }
    res.writeHead(404).end("{}");
  })
  .listen(PORT, "127.0.0.1", () => console.log(`mock-iris on :${PORT}`));
