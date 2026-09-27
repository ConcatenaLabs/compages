// A JSON-RPC proxy that sits between compagesd and the Sequentia node and
// fails chosen calls on command, so the e2e suite can reproduce the outages
// that make a bridge pay twice: a node that stops answering right after a
// mint was broadcast, or a response lost after the node already acted on it.
//
//   node fault-proxy.mjs --port 18894 --target http://127.0.0.1:18892
//
// Control, over the same port:
//
//   POST /__fault {"after": "reissueasset", "fail": ["getmempoolentry", ...], "seconds": 20}
//     Once a call to `after` has passed through, calls to any method in
//     `fail` get HTTP 503 WITHOUT reaching the node, for `seconds`.
//     Omit `after` to start the window at once.
//   POST /__fault {"dropResponse": "sendrawtransaction", "count": 1}
//     The next `count` calls to that method reach the node (so they take
//     effect) but the caller gets HTTP 503 instead of the answer.
//   POST /__fault {"clear": true}
//   GET  /__fault            what is armed, and what has fired

import http from "node:http";

const arg = (name, dflt) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : dflt;
};
const PORT = Number(arg("port", 18894));
const TARGET = new URL(arg("target", "http://127.0.0.1:18892"));

let armed = null; // { after, fail: Set, seconds, until }
let drop = null; // { method, count }
const fired = { failed: 0, dropped: 0, windows: 0 };

const readBody = (req) =>
  new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });

function forward(req, body) {
  return new Promise((resolve, reject) => {
    const r = http.request(
      {
        host: TARGET.hostname,
        port: TARGET.port,
        path: req.url,
        method: req.method,
        headers: { ...req.headers, host: TARGET.host },
      },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
      }
    );
    r.on("error", reject);
    r.end(body);
  });
}

const unavailable = (res) => {
  res.writeHead(503, { "content-type": "text/plain" });
  res.end("fault-proxy: injected outage");
};

http
  .createServer(async (req, res) => {
    const body = await readBody(req);
    if (req.url === "/__fault") {
      if (req.method === "POST") {
        const c = JSON.parse(body.toString() || "{}");
        if (c.clear) {
          armed = null;
          drop = null;
        }
        if (c.fail) {
          armed = {
            after: c.after ?? null,
            fail: new Set(c.fail),
            seconds: c.seconds ?? 20,
            until: c.after ? null : Date.now() + (c.seconds ?? 20) * 1000,
          };
          if (!c.after) fired.windows++;
        }
        if (c.dropResponse) drop = { method: c.dropResponse, count: c.count ?? 1 };
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          armed: armed && { ...armed, fail: [...armed.fail] },
          drop,
          fired,
        })
      );
      return;
    }

    let method = null;
    try {
      method = JSON.parse(body.toString()).method ?? null;
    } catch {}

    if (armed?.until && Date.now() > armed.until) armed = null;
    if (armed?.until && armed.fail.has(method)) {
      fired.failed++;
      return unavailable(res);
    }

    let upstream;
    try {
      upstream = await forward(req, body);
    } catch {
      return unavailable(res);
    }

    if (armed && !armed.until && method === armed.after) {
      armed.until = Date.now() + armed.seconds * 1000;
      fired.windows++;
    }
    if (drop && method === drop.method && drop.count > 0) {
      drop.count--;
      fired.dropped++;
      if (drop.count === 0) drop = null;
      return unavailable(res);
    }
    res.writeHead(upstream.status, upstream.headers);
    res.end(upstream.body);
  })
  .listen(PORT, "127.0.0.1", () => console.log(`fault-proxy on :${PORT} -> ${TARGET.href}`));
