// The mint limiter: every reissuance of a bridged asset goes through a
// `sequentia/mint-limiter` covenant that holds the asset's reissuance token.
//
// The covenant (sequentia-contracts, templates/mint_limiter and
// docs/mint-limiter.md) lets the operator key mint at most an allowance per
// window of blocks, and lets a cold key stop it: the cold key's signature over
// a message that names no coin applies a brake to whichever coin is current,
// and after a long delay the cold key can take the token. The daemon holds the
// operator key's mnemonic and nothing else; the cold key never reaches this
// host.
//
// Spends are built by `mint-limiter` from sequentia-contracts
// (tools/mint-limiter), which reaches no node and holds no credential: this
// module hands it the coins as the transactions that made them, has the bridge
// wallet sign the fee coin, and broadcasts. The covenant's signature commits
// to every input and output, so the transaction id the tool returns is final
// before anything is broadcast, and is recorded first.
//
// State kept per mapping, in `mapping.limiter`:
//   instance   the instance file's content: template hash, parameters, genesis
//   address    where the instance with nothing minted lives (the token moves in there)
//   coin       { txid, vout } of the covenant's current coin, and coinHex the
//              transaction that made it, so no transaction index is needed
//   state      { minted, elapsed, armed } the coin holds
//   tokenAtoms the token's whole supply, all of which the coin must hold

import { execFile } from "node:child_process";
import { amountToSats, satsToAmount } from "./seqrpc.js";

/** The least age, in blocks, of a coin a mint spends. */
export const MIN_AGE = 2;

/** Parameters of an instance, as numbers. */
export function limits(instance) {
  const p = instance.params;
  return {
    window: parseInt(p.WINDOW, 16),
    allowance: BigInt("0x" + p.ALLOWANCE),
    recoveryDelay: parseInt(p.RECOVERY_DELAY, 16),
  };
}

/** The state a mint of `amount` atoms, from a coin `age` blocks old, leads
 *  to, as the covenant computes it; or `{ refused }` with the reason. */
export function mintNext(instance, state, age, amount) {
  const { window, allowance } = limits(instance);
  const x = BigInt(amount);
  if (state.armed) return { refused: "the mint limiter's brake is on" };
  if (age < MIN_AGE) return { refused: `the limiter's coin is ${age} block(s) old; a mint needs ${MIN_AGE}`, waitBlocks: MIN_AGE - age };
  const ended = state.elapsed + age >= window;
  const next = ended
    ? { minted: x, elapsed: 0, armed: 0 }
    : { minted: BigInt(state.minted) + x, elapsed: state.elapsed + age, armed: 0 };
  if (next.minted > allowance) {
    if (x > allowance) return { refused: `a mint of ${x} is above the limiter's whole allowance of ${allowance}`, never: true };
    const waitBlocks = ended ? 0 : window - state.elapsed - age;
    return {
      refused: `the window's allowance of ${allowance} is used (${state.minted} minted); the window ends in ${waitBlocks} block(s)`,
      waitBlocks,
    };
  }
  return { next: { minted: next.minted.toString(), elapsed: next.elapsed, armed: 0 } };
}

/** What the coin's state is, for the reserves page and the watcher. */
export function limiterView(mapping) {
  const L = mapping.limiter;
  if (!L) return null;
  const { window, allowance, recoveryDelay } = limits(L.instance);
  return {
    template: "sequentia/mint-limiter",
    templateHash: L.instance.template_hash,
    // The instance, from which anyone derives the covenant's script for a
    // state and checks it against the coin: sequentia-contracts' mirrors do
    // it with no compiler.
    instance: L.instance,
    params: L.instance.params,
    tokenId: mapping.reissuanceToken,
    address: L.address,
    coin: L.coin ?? null,
    state: L.state ?? null,
    tokenAtoms: L.tokenAtoms ?? null,
    windowBlocks: window,
    allowanceAtoms: allowance.toString(),
    recoveryDelaySeconds: recoveryDelay * 512,
    braked: Boolean(L.state?.armed),
    recovered: L.recovered ?? null,
  };
}

export class MintLimiter {
  /** `cfg` is the daemon's configuration: `mintLimiter` holds the tool, the
   *  operator mnemonic, the cold key and the limits; `seqFeeAsset` pays every
   *  fee. `seq` is the bridge wallet's RPC client. */
  constructor(cfg, seq, log = () => {}) {
    this.cfg = cfg.mintLimiter;
    this.feeAsset = cfg.seqFeeAsset;
    this.seq = seq;
    this.log = log;
    this.locks = new Map();
    for (const k of ["tool", "operatorMnemonicFile", "coldKey", "windowBlocks", "recoveryDelay"]) {
      if (this.cfg?.[k] === undefined) throw new Error(`mintLimiter.${k} is required`);
    }
    if (!this.feeAsset) throw new Error("mintLimiter needs seqFeeAsset: a covenant spend pays its fee from a wallet coin of it");
  }

  /** Runs `fn` with this mapping's coin to itself: the core and Solana loops
   *  can both mint one asset, and two spends of one coin cannot both land. */
  async exclusive(key, fn) {
    const prev = this.locks.get(key) ?? Promise.resolve();
    let release;
    const mine = new Promise((r) => (release = r));
    this.locks.set(key, prev.then(() => mine));
    await prev;
    try {
      return await fn();
    } finally {
      release();
    }
  }

  /** One call of the tool: arguments, and a request on stdin. */
  tool(args, request) {
    return new Promise((resolve, reject) => {
      const child = execFile(this.cfg.tool, args, { maxBuffer: 16 << 20, timeout: 120_000 }, (err, stdout, stderr) => {
        if (err) {
          const why = String(stderr || err.message).trim().replace(/^mint-limiter: /, "");
          return reject(Object.assign(new Error(`mint-limiter: ${why}`), { limiter: true }));
        }
        try {
          resolve(JSON.parse(stdout));
        } catch (e) {
          reject(new Error(`mint-limiter: unreadable reply: ${e.message}`));
        }
      });
      child.stdin.end(request === undefined ? "" : JSON.stringify(request));
    });
  }

  /** The tool reads its instance from a file; one is written per call. */
  async withInstance(instance, fn) {
    const fs = await import("node:fs");
    const os = await import("node:os");
    const path = await import("node:path");
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "compages-limiter-"));
    const file = path.join(dir, "instance.json");
    fs.writeFileSync(file, JSON.stringify(instance));
    try {
      return await fn(file);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }

  allowanceFor(mapping, mappingKey) {
    const a = this.cfg.allowances ?? {};
    const v = a[mapping.contract?.ticker] ?? a[mapping.symbol] ?? a[mappingKey] ?? this.cfg.defaultAllowance;
    if (v === undefined) throw new Error(`no mint limiter allowance for ${mapping.contract?.ticker ?? mapping.symbol}`);
    return BigInt(v);
  }

  /** A new instance for this asset, with the configured keys and limits. */
  async instanceFor(mapping, mappingKey, allowance) {
    const operatorKey = (await this.tool(["key", "--mnemonic-file", this.cfg.operatorMnemonicFile])).key;
    const genesis = await this.seq.node("getblockhash", { height: 0 });
    const inst = await this.tool([
      "instance",
      "--asset", mapping.assetId,
      "--token", mapping.reissuanceToken,
      "--entropy", mapping.entropy,
      "--operator-key", operatorKey,
      "--cold-key", this.cfg.coldKey,
      "--window", String(this.cfg.windowBlocks),
      "--allowance", String(allowance ?? this.allowanceFor(mapping, mappingKey)),
      "--recovery-delay", String(this.cfg.recoveryDelay),
      "--genesis", genesis,
      ...(this.cfg.template ? ["--template", this.cfg.template] : []),
    ]);
    // The tool prints the address on every chain the template names; this
    // node's chain is the one whose address it accepts.
    const { address: byChain, ...instance } = inst;
    for (const address of Object.values(byChain ?? {})) {
      if ((await this.seq.node("validateaddress", { address })).isvalid) return { instance, address };
    }
    throw new Error(`the node accepts none of the instance's addresses ${JSON.stringify(byChain)}`);
  }

  /** The token's whole supply, read from the transaction that issued it. */
  async tokenSupply(mapping) {
    const tx = await this.rawTx(mapping.issueTxid);
    const d = await this.seq.node("decoderawtransaction", { hexstring: tx });
    for (const vin of d.vin ?? []) {
      const iss = vin.issuance;
      if (iss && iss.token === mapping.reissuanceToken && !iss.isreissuance) {
        if (iss.tokenamountcommitment) throw new Error("the token's issuance is blinded; its supply is not knowable");
        return amountToSats(iss.tokenamount ?? 0);
      }
    }
    throw new Error(`issuance ${mapping.issueTxid} does not issue token ${mapping.reissuanceToken}`);
  }

  /** A transaction's hex: the wallet's copy, else the node's (txindex or mempool). */
  async rawTx(txid) {
    try {
      return (await this.seq.call("gettransaction", { txid })).hex;
    } catch {
      return this.seq.node("getrawtransaction", { txid });
    }
  }

  /** The covenant coin as the chain has it: unspent and how deep, or spent. */
  async coinNow(coin) {
    const out = await this.seq.node("gettxout", { txid: coin.txid, n: coin.vout, include_mempool: true });
    if (!out) return { spent: true };
    return { spent: false, confirmations: out.confirmations ?? 0 };
  }

  /** Moves the token into a new instance: every unit the issuance created,
   *  from the wallet, in one transfer. Returns the record to keep. */
  async moveIn(mapping, mappingKey, allowance, confirmBroadcast) {
    const supply = await this.tokenSupply(mapping);
    const { instance, address } = await this.instanceFor(mapping, mappingKey, allowance);
    const coins = await this.seq.call("listunspent", {
      minconf: 0,
      include_unsafe: true,
      query_options: { asset: mapping.reissuanceToken },
    });
    const held = coins.filter((u) => u.asset === mapping.reissuanceToken).reduce((a, u) => a + amountToSats(u.amount), 0n);
    if (held !== supply) {
      throw new Error(
        `the wallet holds ${held} of the token's ${supply} atoms; the limiter takes the whole supply or nothing, ` +
          "since a token atom outside it can still mint"
      );
    }
    const txid = await this.seq.call("sendtoaddress", {
      address,
      amount: satsToAmount(supply),
      assetlabel: mapping.reissuanceToken,
      fee_asset_label: this.feeAsset,
    });
    const fate = await confirmBroadcast(txid);
    if (fate !== "visible") throw new Error(`the token's transfer ${txid} is ${fate}`);
    const d = await this.seq.node("decoderawtransaction", { hexstring: await this.rawTx(txid) });
    const spk = (await this.seq.node("validateaddress", { address })).scriptPubKey;
    const vout = d.vout.findIndex((o) => o.scriptPubKey?.hex === spk);
    if (vout < 0) throw new Error(`the token's transfer ${txid} pays no output to ${address}`);
    return {
      instance,
      address,
      coin: { txid, vout },
      coinHex: await this.rawTx(txid),
      state: { minted: "0", elapsed: 0, armed: 0 },
      tokenAtoms: supply.toString(),
      movedAt: new Date().toISOString(),
    };
  }

  /** The fee rate the node asks, in reference units per 1,000 vbytes. */
  async referenceRate() {
    const n = await this.seq.node("getnetworkinfo");
    const m = await this.seq.node("getmempoolinfo");
    let est = 0;
    try {
      est = Number((await this.seq.node("estimatesmartfee", { conf_target: 2 })).feerate ?? 0);
    } catch {}
    return Math.max(1, Math.ceil(Math.max(Number(n.relayfee ?? 0), Number(m.mempoolminfee ?? 0), est) * 1e8));
  }

  /** The node's exchange rate for fees in the fee asset: atoms per 10^8 reference units. */
  async exchangeRate() {
    const rates = await this.seq.node("getfeeexchangerates");
    if (rates[this.feeAsset]) return Number(rates[this.feeAsset]);
    const labels = await this.seq.node("dumpassetlabels").catch(() => ({}));
    for (const [label, id] of Object.entries(labels)) {
      if ((id === this.feeAsset || label === this.feeAsset) && rates[label]) return Number(rates[label]);
      if (label === this.feeAsset && rates[id]) return Number(rates[id]);
    }
    throw new Error(`the node accepts no fee in ${this.feeAsset}`);
  }

  /** The fee for `vsize` vbytes, in the fee asset's atoms: the reference fee
   *  converted at the node's rate, rounding up. */
  async feeAtoms(vsize) {
    const ref = Math.ceil(((await this.referenceRate()) * vsize) / 1000);
    return Math.ceil((ref * 1e8) / (await this.exchangeRate()));
  }

  /** A confirmed, unlocked wallet coin of the fee asset, largest first. */
  async feeCoin() {
    const coins = await this.seq.call("listunspent", { minconf: 1, query_options: { asset: this.feeAsset } });
    const locked = new Set((await this.seq.call("listlockunspent")).map((l) => `${l.txid}:${l.vout}`));
    const free = coins.filter((u) => !locked.has(`${u.txid}:${u.vout}`)).sort((a, b) => Number(b.amount) - Number(a.amount));
    if (!free.length) throw new Error(`the wallet has no confirmed coin of the fee asset ${this.feeAsset}`);
    return free[0];
  }

  async spkOf(address) {
    return (await this.seq.call("getaddressinfo", { address })).scriptPubKey;
  }

  /** Builds a covenant spend, has the wallet sign its fee coin, and returns
   *  it unbroadcast: { txid, hex, reply }. The fee is measured on a first
   *  build and paid on the second, which differs from it only in two
   *  amounts. */
  async build(mapping, path, fields, mnemonicFile) {
    const L = mapping.limiter;
    const fc = await this.feeCoin();
    await this.seq.call("lockunspent", { unlock: false, transactions: [{ txid: fc.txid, vout: fc.vout }] });
    try {
      const request = {
        path,
        coin: { tx: L.coinHex ?? (await this.rawTx(L.coin.txid)), vout: L.coin.vout },
        state: { minted: String(L.state.minted), elapsed: L.state.elapsed, armed: L.state.armed },
        ...fields,
        fee: {
          coins: [{ tx: await this.rawTx(fc.txid), vout: fc.vout }],
          atoms: "0",
          change_to: await this.spkOf(await this.seq.call("getrawchangeaddress")),
        },
      };
      const args = (file) => ["build", "--instance", file, ...(mnemonicFile ? ["--mnemonic-file", mnemonicFile] : []),
        ...(this.cfg.template ? ["--template", this.cfg.template] : [])];
      const signedOf = async (reply) => {
        const s = await this.seq.call("signrawtransactionwithwallet", { hexstring: reply.hex });
        if (!s.complete) throw new Error(`the wallet could not sign the fee coin: ${JSON.stringify(s.errors ?? [])}`);
        const d = await this.seq.node("decoderawtransaction", { hexstring: s.hex });
        if (d.txid !== reply.txid) throw new Error(`the signed transaction is ${d.txid}, the tool built ${reply.txid}`);
        return { hex: s.hex, vsize: d.vsize };
      };
      return await this.withInstance(L.instance, async (file) => {
        request.fee.atoms = "1";
        const draft = await signedOf(await this.tool(args(file), request));
        // One vbyte over the draft: a wallet signature can be a byte longer.
        request.fee.atoms = String(await this.feeAtoms(draft.vsize + 1));
        const reply = await this.tool(args(file), request);
        const signed = await signedOf(reply);
        return { txid: reply.txid, hex: signed.hex, vsize: signed.vsize, reply };
      });
    } finally {
      await this.seq.call("lockunspent", { unlock: true, transactions: [{ txid: fc.txid, vout: fc.vout }] }).catch(() => {});
    }
  }

  /** A mint of `sats` from the mapping's coin to a fresh wallet address. */
  async buildMint(mapping, age, sats) {
    const to = await this.spkOf(await this.seq.call("getnewaddress"));
    return this.build(mapping, "mint", { entropy: mapping.entropy, age, amount: String(sats), mint_to: to },
      this.cfg.operatorMnemonicFile);
  }

  /** The brake, applied with a signature the cold key made in advance. */
  async buildArm(mapping, armSignature) {
    return this.build(mapping, "arm", { arm_signature: armSignature });
  }

  /** What the transaction that spent the coin did to it. */
  async follow(mapping, txHex) {
    const L = mapping.limiter;
    return this.withInstance(L.instance, async (file) =>
      this.tool(["follow", "--instance", file, ...(this.cfg.template ? ["--template", this.cfg.template] : [])], {
        coin: { tx: L.coinHex ?? (await this.rawTx(L.coin.txid)), vout: L.coin.vout },
        state: { minted: String(L.state.minted), elapsed: L.state.elapsed, armed: L.state.armed },
        tx: txHex,
      })
    );
  }

  /** The transaction that spent the coin, searched for in the blocks from
   *  the coin's own forward, then in the mempool; null while it is not found. */
  async findSpender(coin) {
    const node = (m, p) => this.seq.node(m, p);
    let height;
    try {
      const raw = await node("getrawtransaction", { txid: coin.txid, verbose: true });
      if (raw.blockhash) height = (await node("getblockheader", { blockhash: raw.blockhash })).height;
    } catch {
      const w = await this.seq.call("gettransaction", { txid: coin.txid }).catch(() => null);
      if (w?.blockhash) height = (await node("getblockheader", { blockhash: w.blockhash })).height;
    }
    const spends = (tx) => (tx.vin ?? []).some((i) => i.txid === coin.txid && i.vout === coin.vout);
    if (height !== undefined) {
      const tip = await node("getblockcount");
      for (let h = height; h <= tip; h++) {
        const block = await node("getblock", { blockhash: await node("getblockhash", { height: h }), verbosity: 2 });
        const tx = block.tx.find(spends);
        if (tx) return tx.hex;
      }
    }
    for (const txid of await node("getrawmempool")) {
      const tx = await node("getrawtransaction", { txid, verbose: true }).catch(() => null);
      if (tx && spends(tx)) return tx.hex;
    }
    return null;
  }
}
