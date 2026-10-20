// The chain the leaf checks run on: a Sequentia proof-of-stake regtest chain
// anchored to a Bitcoin regtest parent, as an Arca operator needs (its
// finality is a certified block whose anchor is buried two Bitcoin blocks).
// Blocks are produced here with the committee's test keys, which anyone can
// derive (regtest only), as the Arca test harness does.
//
//   node leaf-chain.mjs stakers            # the -staker=<pubkey>:1 arguments
//   node leaf-chain.mjs produce N          # N Sequentia blocks
//   node leaf-chain.mjs bury               # two parent blocks, then anchor to them
//
// SEQ_RPC_URL and PARENT_RPC_URL name the two nodes (http://user:pass@host:port).

import crypto from "node:crypto";
import { ethers } from "ethers";

const sha256 = (b) => crypto.createHash("sha256").update(b).digest();

/** The three test stakers: WIF (regtest prefix 0xef, compressed) and pubkey. */
export function stakers() {
  return [0, 1, 2].map((i) => {
    const secret = sha256(Buffer.from(`sequentia-ext regtest staker ${i}`));
    const payload = Buffer.concat([Buffer.from([0xef]), secret, Buffer.from([0x01])]);
    const check = sha256(sha256(payload)).subarray(0, 4);
    const wif = ethers.encodeBase58(Buffer.concat([payload, check]));
    const pubkey = new ethers.SigningKey("0x" + secret.toString("hex")).compressedPublicKey.slice(2);
    return { wif, pubkey };
  });
}

export function rpcClient(url) {
  const u = new URL(url);
  const auth = "Basic " + Buffer.from(`${decodeURIComponent(u.username)}:${decodeURIComponent(u.password)}`).toString("base64");
  const endpoint = `${u.protocol}//${u.host}${u.pathname}`;
  return async (method, params = []) => {
    const res = await fetch(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: auth },
      body: JSON.stringify({ jsonrpc: "1.0", id: 1, method, params }),
    });
    const j = await res.json();
    if (j.error) throw Object.assign(new Error(`${method}: ${j.error.message}`), { code: j.error.code });
    return j.result;
  };
}

export class Chain {
  constructor(seqUrl, parentUrl) {
    this.seq = rpcClient(seqUrl);
    this.parent = rpcClient(parentUrl);
    this.keys = stakers();
    this.mockOffset = 0; // seconds the node's clock runs ahead of ours
  }

  async setClock() {
    if (this.mockOffset) await this.seq("setmocktime", [Math.floor(Date.now() / 1000) + this.mockOffset]);
  }

  /** One certified block from the mempool, each staker tried as the leader. */
  async produce() {
    const all = this.keys.map((k) => k.wif);
    const t0 = Date.now();
    let last = "";
    for (;;) {
      await this.setClock();
      for (const k of this.keys) {
        try {
          return (await this.seq("generateposblock", [k.wif, all])).hash;
        } catch (e) {
          last = e.message;
        }
      }
      if (Date.now() - t0 > 30_000) throw new Error(`no staker could produce a block: ${last}`);
      await new Promise((r) => setTimeout(r, 250));
    }
  }

  async produceN(n) {
    for (let i = 0; i < n; i++) await this.produce();
  }

  /** Two parent blocks, then Sequentia blocks until its tip anchors to the
   *  parent's tip: everything before is buried two Bitcoin blocks. */
  async bury() {
    await this.parent("generatetodescriptor", [2, "raw(51)"]);
    const target = await this.parent("getblockcount");
    const t0 = Date.now();
    for (;;) {
      await this.produce();
      const h = await this.seq("getblockheader", [await this.seq("getbestblockhash")]);
      if ((h.anchorheight ?? -1) >= target) return;
      if (Date.now() - t0 > 60_000) throw new Error(`the tip did not anchor to parent height ${target} within 60 s`);
      await new Promise((r) => setTimeout(r, 300));
    }
  }

  /** Moves the chain's median time at least `seconds` on, as the Arca
   *  harness does: the node's clock ahead, then a dozen blocks. */
  async advance(seconds) {
    const start = (await this.seq("getblockchaininfo")).mediantime;
    this.mockOffset += seconds + 60;
    await this.produceN(12);
    const now = (await this.seq("getblockchaininfo")).mediantime;
    if (now < start + seconds) throw new Error(`the median time moved from ${start} to ${now} only`);
    return now;
  }

  /** Keeps the chain moving: a block every `blockMs`, a parent block every
   *  `parentEvery` blocks. Returns a stop function. */
  run(blockMs = 1500, parentEvery = 3) {
    let stop = false;
    let n = 0;
    const loop = async () => {
      while (!stop) {
        try {
          if (++n % parentEvery === 0) await this.parent("generatetodescriptor", [1, "raw(51)"]);
          await this.produce();
        } catch (e) {
          if (!stop) console.error(`chain: ${e.message}`);
        }
        await new Promise((r) => setTimeout(r, blockMs));
      }
    };
    const done = loop();
    return async () => {
      stop = true;
      await done;
    };
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [cmd, arg] = process.argv.slice(2);
  if (cmd === "stakers") {
    console.log(stakers().map((k) => `-staker=${k.pubkey}:1`).join(" "));
  } else {
    const chain = new Chain(process.env.SEQ_RPC_URL, process.env.PARENT_RPC_URL);
    if (cmd === "produce") await chain.produceN(Number(arg ?? 1));
    else if (cmd === "bury") await chain.bury();
    else throw new Error(`unknown command ${cmd}`);
  }
}
