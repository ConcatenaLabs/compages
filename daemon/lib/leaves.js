// Deposits that arrive as Arca leaves.
//
// A depositor on Ethereum may name an Arca receive request instead of a
// Sequentia address. The request is too long for the vault's event, and it
// must be checked before anything is locked, so it is bound to a short
// address first: POST /api/leaf/intent checks the request (operator, chain,
// asset, lapse, single use) and answers a fresh Sequentia address of the
// bridge's node wallet, which the deposit then names as its destination, as a
// redemption names its own fresh address. When the deposit lands the request
// is checked again; one that can no longer be paid takes the path the intent
// stated, an on-chain delivery to the depositor's fallback address or a
// refund on Ethereum, and never silence.
//
// The leaf is minted per deposit, never ahead of one: the limiter mints
// exactly what the deposit credits into the bridge's own leaf wallet (an
// `arca` wallet of its own, driven through the command line), the wallet
// boards it, and once the board is final pays the request out of round. So
// circulating supply never exceeds escrow, and what the bridge holds between
// the mint and the payment is counted as held by the bridge and owed to the
// deposit (see figures()). The transfer's margins, which every out-of-round
// payment leaves in the asset moved for the fees of its pre-signed
// transactions, come out of the deposit: the leaf holds the deposit's credit
// less them, and the receipt states both.
//
// One asset's leaf deposits go through the wallet one at a time, from board to
// payment, so the wallet holds a single live coin of the asset when it pays:
// the margins of a one-coin payment are then exactly what the wallet's own
// refusal of an impossible amount names, and the payment takes the coin whole.
//
// Every step is crash-safe. The mint is the bridge's own (a limiter mint whose
// txid is recorded before broadcast). The board and the payment are recorded
// by the wallet itself before it asks the operator, so after a crash the
// wallet answers whether they happened: a board shows in `boards`; a payment
// shows as the deposit's coin spent by a transfer.

import { execFile } from "node:child_process";
import { satsToAmount } from "./seqrpc.js";

const HEX64 = /^[0-9a-f]{64}$/;

/** A refusal for the caller of the intent API, with its HTTP status. */
const refuse = (status, message) => Object.assign(new Error(message), { status, badRequest: status === 400 });

/** A receive request as a wallet hands it out: a prefix word, a colon, and
 *  the hex of its JSON, which says it is a request (`kind`, or the older
 *  `arca_request`). Returns the decoded request; throws a 400 otherwise. */
export function decodeRequest(text) {
  const s = String(text ?? "").trim();
  if (!s) throw refuse(400, "request required: a receive request from an Arca wallet");
  if (s.length > 4096) throw refuse(400, "the receive request is too long");
  const i = s.indexOf(":");
  if (i < 1 || !/^[A-Za-z0-9-]+$/.test(s.slice(0, i))) throw refuse(400, "not a receive request: it has no prefix");
  const h = s.slice(i + 1);
  if (!/^([0-9a-f]{2})+$/.test(h)) throw refuse(400, "not a receive request: it is not hex after its prefix");
  let v;
  try {
    v = JSON.parse(Buffer.from(h, "hex").toString("utf8"));
  } catch {
    throw refuse(400, "not a receive request: it holds no JSON");
  }
  if (!v || typeof v !== "object" || (v.kind !== "request" && v.arca_request === undefined)) {
    throw refuse(400, "not a receive request");
  }
  for (const k of ["operator", "genesis_hash", "owner", "owner_nonce", "mailbox"]) {
    if (!HEX64.test(v[k] ?? "")) throw refuse(400, `the receive request has no ${k}`);
  }
  if (v.asset !== undefined && !HEX64.test(v.asset)) throw refuse(400, "the receive request names an asset that is not an asset id");
  if (v.until !== undefined && !Number.isSafeInteger(v.until)) throw refuse(400, "the receive request's lapse is not a time");
  return v;
}

/** The atoms a refused send says paying `paid` would take, or null. */
export function takesFromRefusal(message) {
  const m = /paying (\d+) takes (\d+)/.exec(String(message ?? ""));
  return m ? { paid: BigInt(m[1]), takes: BigInt(m[2]) } : null;
}

/** Atoms by state of one asset in an `arca balance` answer, plus its
 *  on-chain coins, and their total. */
export function holdingOf(balance, assetId) {
  const out = { onchain: 0n, states: {}, total: 0n };
  const on = balance?.sequentia_onchain?.[assetId];
  if (on !== undefined && on !== null) out.onchain = BigInt(typeof on === "object" ? on.total ?? 0 : on);
  for (const [state, v] of Object.entries(balance?.arca?.[assetId] ?? {})) {
    if (!/^[0-9]+$/.test(String(v))) continue;
    out.states[state] = BigInt(v);
  }
  out.total = out.onchain + Object.values(out.states).reduce((a, b) => a + b, 0n);
  return out;
}

/** The `arca` command line on the bridge's own leaf wallet. One command at a
 *  time: the wallet is one store. */
export class LeafWallet {
  constructor(c, log) {
    this.c = c;
    this.log = log;
    this.queue = Promise.resolve();
    this._info = null;
  }

  /** Runs `arca --datadir D ARGS`; resolves { out, error, stderr }, never
   *  throws. `error` is the wallet's refusal ({ kind, message, code, status })
   *  or a description of a run that printed nothing it could read. */
  run(args, timeout = this.c.timeoutMs ?? 300_000) {
    const go = () =>
      new Promise((resolve) => {
        execFile(this.c.arca, ["--datadir", this.c.datadir, ...args], { timeout, maxBuffer: 1 << 26 }, (err, stdout, stderr) => {
          let out = null;
          try {
            out = JSON.parse(stdout);
          } catch {}
          let error = null;
          if (out && out.error) error = out.error;
          else if (err || !out) {
            const last = String(stderr || "").trim().split("\n").pop();
            error = { kind: "unreachable", message: last || (err ? err.message : "the wallet printed nothing") };
          }
          resolve({ out: error ? null : out, error, stderr: String(stderr || "") });
        });
      });
    const p = this.queue.then(go, go);
    this.queue = p.catch(() => {});
    return p;
  }

  async must(args, what, timeout) {
    const r = await this.run(args, timeout);
    if (r.error) throw Object.assign(new Error(`arca ${what}: ${r.error.message ?? JSON.stringify(r.error)}`), { arca: r.error });
    return r.out;
  }

  /** The wallet's operator, chain, the chain's median time and what the
   *  operator serves; cached for `infoMs`. */
  async info(fresh = false) {
    if (!fresh && this._info && Date.now() - this._info.at < (this.c.infoMs ?? 30_000)) return this._info;
    const i = await this.must(["info"], "info");
    const served = new Map();
    for (const a of i.server_info?.assets ?? []) served.set(a.asset, a);
    this._info = {
      at: Date.now(),
      operator: i.operator,
      genesis: i.genesis_hash,
      medianTime: i.tip?.median_time ?? null,
      served,
      fees: i.server_info?.fees ?? null,
    };
    return this._info;
  }

  address() {
    return this.must(["address"], "address").then((o) => (typeof o === "string" ? o : o.address));
  }
  balance() {
    return this.must(["balance", "--without-bitcoin"], "balance");
  }
  coins() {
    return this.must(["coins"], "coins");
  }
  boards() {
    return this.must(["boards"], "boards");
  }
  sync() {
    return this.run(["sync"], this.c.syncTimeoutMs ?? 600_000);
  }
  board(asset, atoms, feeAsset) {
    return this.run(["board", asset, String(atoms), "--fee-asset", feeAsset]);
  }
  send(request, atoms, asset) {
    return this.run(["send", request, "--amount", String(atoms), "--asset", asset]);
  }
}

// A deposit's leaf states, in order. `minted` (with `leaf.paid`) ends it.
export const LEAF_STATES = ["leaf_minted", "leaf_boarding", "leaf_paying", "leaf_held"];

export class LeafDeposits {
  /** `bridge` is the Bridge; cfg.leafWallet configures the wallet (`wallet`
   *  stands in for it in tests). */
  constructor(bridge, wallet = null) {
    this.bridge = bridge;
    this.cfg = bridge.cfg;
    this.c = bridge.cfg.leafWallet;
    this.log = bridge.log;
    this.wallet = wallet ?? new LeafWallet(this.c, bridge.log);
    this.feeAsset = this.c.feeAsset ?? bridge.cfg.seqFeeAsset;
    this.lastSync = 0;
    this.nextSyncAt = 0;
  }

  get s() {
    return this.bridge.state.data;
  }

  /** The mapping of `assetId`, or undefined. */
  mappingOfAsset(assetId) {
    return Object.entries(this.s.mappings).find(([, m]) => m.assetId === assetId && !m.retired);
  }

  // ---------------------------------------------------------------- intents

  /** Checks `request` for a leaf deposit of `token` (or of the asset the
   *  request names) and binds it to a fresh address of the node wallet.
   *  `fallbackAddress`, when given, is where the deposit goes on the chain if
   *  the request can no longer be paid when it lands; without it the deposit
   *  is refunded on Ethereum. */
  async createIntent({ request, token, fallbackAddress } = {}) {
    const req = decodeRequest(request);
    const info = await this.wallet.info(true).catch((e) => {
      throw refuse(503, `the bridge's leaf wallet cannot be read now (${e.message}); try again later`);
    });
    if (req.operator !== info.operator) {
      throw refuse(400, `the receive request is for operator ${req.operator}; this bridge pays leaves through operator ${info.operator} only`);
    }
    if (req.genesis_hash !== info.genesis) {
      throw refuse(400, `the receive request is for the chain of genesis ${req.genesis_hash}, not this bridge's (${info.genesis})`);
    }
    if (req.value !== undefined) {
      throw refuse(400, "the receive request names an amount; a deposit's leaf holds what the deposit credits, so ask the wallet for a request without one");
    }
    // The asset: the request's, or the token's bridged asset.
    let entry = null;
    if (token !== undefined && token !== null && token !== "") {
      const key = this.bridge.normalizedEthTokenKey(String(token));
      if (!key) throw refuse(400, "token: an Ethereum token address, or \"eth\"");
      const mk = this.bridge.mappingKeyFor(key);
      const m = this.s.mappings[mk];
      if (!m || m.retired) throw refuse(400, `${token} is not bridged yet: its first deposit goes to a Sequentia address, after which its asset can be paid as a leaf`);
      entry = [mk, m];
      if (req.asset !== undefined && req.asset !== m.assetId) {
        throw refuse(400, `the receive request asks for asset ${req.asset}, and ${token} is bridged as ${m.assetId}`);
      }
    } else if (req.asset !== undefined) {
      entry = this.mappingOfAsset(req.asset) ?? null;
      if (!entry) throw refuse(400, `asset ${req.asset} is not one this bridge mints`);
    } else {
      throw refuse(400, "name the token (token) or ask the wallet for a request naming the asset");
    }
    const [mappingKey, mapping] = entry;
    if (!this.bridge.limiter || !mapping.limiter?.coin) {
      throw refuse(400, `${mapping.symbol} is not minted through a mint limiter here, so it cannot be paid as a leaf`);
    }
    const served = info.served.get(mapping.assetId);
    if (!served) throw refuse(400, `the operator does not serve ${mapping.symbol} (${mapping.assetId})`);
    if (req.until === undefined) throw refuse(400, "the receive request names no lapse; ask the wallet for a new one");
    const need = this.c.intentLapseSeconds ?? 2 * 86_400;
    if (info.medianTime === null || req.until < info.medianTime + need) {
      throw refuse(
        400,
        `the receive request lapses at ${req.until} (a median time; the chain's is ${info.medianTime}), and a deposit's leaf can take ` +
          `until ${info.medianTime + need} to arrive (Ethereum finality, the mint and the board's finality): ask the wallet for a new one`
      );
    }
    let fallback = { kind: "refund", note: "refunded on Ethereum to the address the deposit came from" };
    if (fallbackAddress) {
      const v = await this.bridge.seq.node("validateaddress", { address: String(fallbackAddress) });
      if (!v.isvalid) throw refuse(400, "fallbackAddress is not a Sequentia address");
      if (this.s.leafIntents?.[fallbackAddress]) throw refuse(400, "fallbackAddress is a leaf deposit address, not a destination");
      fallback = { kind: "address", address: String(fallbackAddress), note: `delivered on the chain to ${fallbackAddress}` };
    }
    // Asking again with the same request and the same fallback answers the
    // same address. Another fallback makes another intent: a request is
    // public, and whoever binds it first must not choose where someone
    // else's deposit falls back to. The request is still paid once, whichever
    // intent's deposit lands first (decide()).
    this.s.leafIntents ??= {};
    for (const [addr, it] of Object.entries(this.s.leafIntents)) {
      if (it.request === String(request).trim() && JSON.stringify(it.fallback) === JSON.stringify(fallback)) {
        return { seqAddress: addr, ...this.publicIntent(it) };
      }
    }
    const seqAddress = await this.bridge.seq.call("getnewaddress", { label: "compages-leaf" });
    const it = {
      request: String(request).trim(),
      operator: req.operator,
      genesis: req.genesis_hash,
      owner: req.owner,
      until: req.until,
      assetId: mapping.assetId,
      mappingKey,
      symbol: mapping.symbol,
      fallback,
      createdAt: new Date().toISOString(),
    };
    this.s.leafIntents[seqAddress] = it;
    this.bridge.state.save();
    this.log(`leaf intent: ${seqAddress} -> a leaf of ${mapping.symbol} for key ${req.owner} (fallback: ${fallback.kind})`);
    return { seqAddress, ...this.publicIntent(it) };
  }

  publicIntent(it) {
    return {
      assetId: it.assetId,
      symbol: it.symbol,
      operator: it.operator,
      owner: it.owner,
      until: it.until,
      fallback: it.fallback,
      usedBy: it.usedBy ?? null,
      createdAt: it.createdAt,
    };
  }

  isIntentAddress(address) {
    return Boolean(address && this.s.leafIntents && Object.hasOwn(this.s.leafIntents, address));
  }

  // ------------------------------------------------------- when one lands

  /** Decides a deposit to a leaf intent address, before anything is minted:
   *  `dep.leaf.route` becomes "leaf", or the deposit takes its intent's
   *  fallback with the reason. Called once per deposit. */
  async decide(dep, mapping) {
    const it = this.s.leafIntents[dep.seqAddress];
    const intentAddress = dep.seqAddress;
    dep.leaf = { intent: intentAddress, owner: it.owner, until: it.until, assetId: it.assetId };
    let why = null;
    // A request is paid once, through whichever of its intents a deposit
    // reaches first: every intent naming its key counts.
    const used = Object.values(this.s.leafIntents).find((i) => i.owner === it.owner && i.usedBy && i.usedBy !== dep.key);
    if (used) {
      why = `the receive request was already used by ${used.usedBy}; a request is paid once`;
    } else if (!mapping || mapping.assetId !== it.assetId) {
      why = `the deposit's token is not the asset the request was bound to (${it.symbol})`;
    } else if (!this.bridge.limiter) {
      why = "the bridge mints without a mint limiter, and a leaf is minted only through one";
    } else {
      try {
        const info = await this.wallet.info(true);
        const served = info.served.get(it.assetId);
        const margin = this.c.landingLapseSeconds ?? 6 * 3600;
        if (info.operator !== it.operator || info.genesis !== it.genesis) {
          why = "the bridge's leaf wallet is no longer on the operator and chain the request names";
        } else if (!served) {
          why = `the operator no longer serves ${it.symbol}`;
        } else if (info.medianTime === null || it.until < info.medianTime + margin) {
          why = `the receive request lapses at ${it.until} (the chain's median time is ${info.medianTime}), too soon for the mint and the board to finish`;
        } else if (BigInt(dep.sats) < BigInt(served.min_leaf ?? 0) + 1000n) {
          why = `the deposit (${dep.sats} atoms) is below the operator's smallest leaf in ${it.symbol} (${served.min_leaf}) with the transfer's margins`;
        }
      } catch (e) {
        // The wallet could not be read: not a reason to give up the leaf.
        throw new Error(`the leaf wallet cannot be read to check the request: ${e.message}`);
      }
    }
    it.usedBy ??= dep.key;
    if (!why) {
      dep.leaf.route = "leaf";
      this.bridge.state.save();
      this.log(`${dep.tag}: arrives as a leaf of ${it.symbol} for key ${it.owner}`);
      return "leaf";
    }
    dep.leaf.route = "fallback";
    dep.leaf.fallbackReason = why;
    if (it.fallback.kind === "address") {
      dep.seqAddress = it.fallback.address;
      this.log(`${dep.tag}: ${why}; delivering on the chain to ${dep.seqAddress} as the intent states`);
    } else {
      dep.status = "refund_pending";
      dep.refundReason = `${why}; the intent names no fallback address`;
      this.log(`${dep.tag}: ${why}; refunding on Ethereum as the intent states`);
    }
    this.bridge.state.save();
    return "fallback";
  }

  /** The leaf wallet's on-chain address the limiter mints a deposit to,
   *  drawn once per deposit and recorded before the mint is built. */
  async mintTo(dep) {
    if (!dep.leaf.address) {
      dep.leaf.address = await this.wallet.address();
      this.bridge.state.save();
    }
    return dep.leaf.address;
  }

  /** After the mint: the deposit waits its turn to board. */
  minted(dep) {
    dep.status = "leaf_minted";
    dep.leaf.mintedAt = new Date().toISOString();
    delete dep.error;
    delete dep.nextAttemptAt;
    this.bridge.state.save();
    this.log(`${dep.tag}: minted ${satsToAmount(dep.sats)} into the leaf wallet; boarding next`);
  }

  // ------------------------------------------------------------ the phase

  /** The fee asset's id: the configured id, or the node's label for it. */
  async feeAssetId() {
    if (this._feeId) return this._feeId;
    const f = String(this.feeAsset ?? "");
    if (/^[0-9a-f]{64}$/.test(f)) return (this._feeId = f);
    const id = (await this.bridge.seq.node("dumpassetlabels"))?.[f];
    if (!id) throw new Error(`the node has no asset labelled ${f}`);
    return (this._feeId = id);
  }

  /** Keeps the leaf wallet's on-chain fee coins at about `feeTopUpBoards`
   *  boards' worth (1,000 vbytes each at the node's fee rate now, about three
   *  boards apiece), from the node wallet's own stock of the fee asset, which
   *  pays every Sequentia fee of the bridge: when they fall below a quarter of
   *  that, the wallet is topped up to it. Only when the leaf wallet's fee
   *  asset is the bridge's own (`seqFeeAsset`); otherwise its operator funds
   *  it. A top-up that has not confirmed yet is waited for. Every top-up is
   *  recorded (`leafFeeTopUps`). */
  async topUpFees() {
    const boards = BigInt(this.c.feeTopUpBoards ?? 50);
    if (!boards || !this.bridge.limiter) return;
    if (Date.now() - (this._feeCheckedAt ?? 0) < (this.c.feeCheckMs ?? 300_000)) return;
    this._feeCheckedAt = Date.now();
    try {
      const id = await this.feeAssetId();
      const own = this.cfg.seqFeeAsset;
      const ownId = /^[0-9a-f]{64}$/.test(String(own)) ? own : (await this.bridge.seq.node("dumpassetlabels"))?.[own];
      if (id !== ownId) return;
      const last = this.s.leafFeeTopUps?.at(-1);
      if (last) {
        const t = await this.bridge.seq.call("gettransaction", { txid: last.txid }).catch(() => null);
        if (!t || (t.confirmations ?? 0) < 1) return;
      }
      const target = BigInt(await this.bridge.limiter.feeAtoms(1000)) * boards;
      const have = holdingOf(await this.wallet.balance(), id).onchain;
      if (have * 4n >= target) return;
      const amount = target - have;
      const address = await this.wallet.address();
      const txid = await this.bridge.seq.call("sendtoaddress", {
        address,
        amount: satsToAmount(amount),
        assetlabel: id,
        fee_asset_label: own,
      });
      (this.s.leafFeeTopUps ??= []).push({ txid, atoms: amount.toString(), address, at: new Date().toISOString() });
      this.bridge.state.save();
      delete this.feeTopUpError;
      this.log(`leaf wallet: topped up its fee coins with ${satsToAmount(amount)} of ${own} (${txid}); it held ${have} atoms`);
    } catch (e) {
      this.feeTopUpError = e.message;
      this.log(`leaf wallet: fee top-up failed: ${e.message}`);
    }
  }

  /** One pass: sync the wallet when due, keep its fee coins, then move each
   *  asset's head deposit one step. */
  async advance() {
    const deps = Object.values(this.s.deposits).filter((d) => LEAF_STATES.includes(d.status));
    const now = Date.now();
    const busy = deps.some((d) => d.status === "leaf_boarding" || d.status === "leaf_paying");
    if (busy ? now - this.lastSync >= (this.c.syncBusyMs ?? 5_000) : now >= this.nextSyncAt) {
      await this.syncNow();
    }
    await this.topUpFees();
    const byAsset = new Map();
    for (const d of deps.sort((a, b) => String(a.leaf.mintedAt ?? a.createdAt).localeCompare(String(b.leaf.mintedAt ?? b.createdAt)))) {
      if (!byAsset.has(d.assetId)) byAsset.set(d.assetId, []);
      byAsset.get(d.assetId).push(d);
    }
    for (const list of byAsset.values()) {
      // The head: a deposit already past its board, else the oldest minted.
      const head = list.find((d) => d.status !== "leaf_minted") ?? list[0];
      if (head.status === "leaf_held") continue; // waits for the operator
      await this.bridge.withRecord(`leaf:${head.key}`, () => this.step(head)).catch((e) => {
        head.error = e.message;
        this.bridge.state.save();
        this.log(`${head.tag}: leaf step failed: ${e.message}`);
      });
    }
  }

  async syncNow() {
    const r = await this.wallet.sync();
    this.lastSync = Date.now();
    const sc = r.out?.schedule;
    const min = this.c.syncMinMs ?? 60_000;
    const max = this.c.syncMaxMs ?? 3_600_000;
    let wait = max;
    if (sc && sc.next_sync_at !== null && sc.next_sync_at !== undefined && sc.now) wait = (sc.next_sync_at - sc.now) * 1000;
    if (r.error) {
      this.lastSyncError = r.error.message;
      wait = min;
      this.log(`leaf wallet sync: ${r.error.message}`);
    } else {
      delete this.lastSyncError;
    }
    this.nextSyncAt = Date.now() + Math.min(Math.max(wait, min), max);
    return r;
  }

  async step(dep) {
    if (dep.status === "leaf_minted") return this.boardStep(dep);
    if (dep.status === "leaf_boarding") return this.awaitBoard(dep);
    if (dep.status === "leaf_paying") return this.payStep(dep);
  }

  // ---- board

  async boardStep(dep) {
    const st = dep.steps;
    if (st.leafBoard) {
      dep.status = "leaf_boarding";
      this.bridge.state.save();
      return;
    }
    if (st.pendingLeafBoard) {
      // A board was asked for and its answer never recorded: the wallet
      // records a board before it asks the operator, so `boards` says
      // whether it exists.
      const found = await this.findBoard(dep);
      if (found) return this.boarded(dep, found);
      delete st.pendingLeafBoard;
      this.bridge.state.save();
    }
    // The mint must be in the wallet's view of the chain first.
    const bal = await this.wallet.balance();
    const onchain = holdingOf(bal, dep.assetId).onchain;
    if (onchain < BigInt(dep.sats)) {
      dep.waiting = `the leaf wallet sees ${onchain} of ${dep.sats} atoms minted on the chain yet`;
      this.bridge.state.save();
      return;
    }
    st.pendingLeafBoard = { at: new Date().toISOString(), boardsBefore: (await this.boardIds()) };
    this.bridge.state.save();
    const r = await this.wallet.board(dep.assetId, dep.sats, this.feeAsset);
    if (r.error) {
      // A refusal boards nothing; anything else may have (the wallet keeps
      // the board pending and sync posts it again), so look before retrying.
      const found = await this.findBoard(dep).catch(() => null);
      if (found) return this.boarded(dep, found);
      if (r.error.kind !== "unreachable" || r.error.status) {
        delete st.pendingLeafBoard;
        dep.waiting = `the board was refused: ${r.error.message}`;
        this.bridge.state.save();
        this.log(`${dep.tag}: ${dep.waiting}`);
      }
      return;
    }
    return this.boarded(dep, this.boardOf(r.out));
  }

  /** { txid, leafId } of a board answer. */
  boardOf(out) {
    return { txid: out?.txid ?? null, leafId: out?.leaf_id ?? null, vsize: out?.vsize ?? null, fee: out?.fee ?? null };
  }

  /** The leaf ids of every board coin the wallet holds or held. */
  async boardIds() {
    return (await this.wallet.coins()).filter((c) => c.kind === "board").map((c) => c.leaf_id);
  }

  /** The board coin of this deposit's amount and asset that was not in the
   *  wallet before it asked, and that no other deposit has recorded. */
  async findBoard(dep) {
    const coins = await this.wallet.coins();
    const before = new Set(dep.steps.pendingLeafBoard?.boardsBefore ?? []);
    const taken = new Set(
      Object.values(this.s.deposits)
        .map((d) => d.steps?.leafBoard?.leafId)
        .filter(Boolean)
    );
    for (const c of coins) {
      if (c.kind !== "board" || before.has(c.leaf_id) || taken.has(c.leaf_id)) continue;
      if (c.asset === dep.assetId && String(c.value) === String(dep.sats) && c.state !== "lost") {
        const txid = /([0-9a-f]{64})/.exec(String(c.note ?? ""))?.[1] ?? null;
        return { txid, leafId: c.leaf_id, recovered: true };
      }
    }
    return null;
  }

  boarded(dep, b) {
    delete dep.steps.pendingLeafBoard;
    dep.steps.leafBoard = b;
    dep.status = "leaf_boarding";
    delete dep.waiting;
    dep.leaf.boardedAt = new Date().toISOString();
    this.bridge.state.save();
    this.log(`${dep.tag}: boarded ${satsToAmount(dep.sats)} into the leaf wallet (${b.txid}); spendable once final`);
  }

  /** The deposit's coin as the wallet has it now. */
  async coinOf(dep) {
    const coins = await this.wallet.coins();
    const b = dep.steps.leafBoard;
    return coins.find((c) => c.leaf_id === b.leafId) ?? null;
  }

  async awaitBoard(dep) {
    const coin = await this.coinOf(dep);
    if (!coin) {
      dep.waiting = "the board's coin is not in the wallet yet";
      this.bridge.state.save();
      return;
    }
    if (!dep.steps.leafBoard.leafId) dep.steps.leafBoard.leafId = coin.leaf_id;
    if (coin.state === "lost") {
      // A lost board spent nothing that stays spent: its coins are on the
      // chain again, and the deposit boards again.
      delete dep.steps.leafBoard;
      dep.status = "leaf_minted";
      dep.waiting = `the board ${coin.leaf_id} was lost (${coin.note ?? "refused"}); boarding again`;
      this.bridge.state.save();
      this.log(`${dep.tag}: ${dep.waiting}`);
      return;
    }
    if (coin.state !== "live") {
      dep.waiting = `the board is ${coin.state}: the operator credits it once its transaction is final`;
      this.bridge.state.save();
      return;
    }
    delete dep.waiting;
    dep.leaf.liveAt = new Date().toISOString();
    dep.status = "leaf_paying";
    this.bridge.state.save();
    return this.payStep(dep);
  }

  // ---- payment

  async payStep(dep) {
    const st = dep.steps;
    const it = this.s.leafIntents[dep.leaf.intent];
    if (st.leafPay) return this.paid(dep, st.leafPay);
    if (st.pendingLeafPay) {
      const fate = await this.payFate(dep);
      if (fate.state === "paid") return this.paid(dep, { transferId: fate.transferId, value: st.pendingLeafPay.value, margins: st.pendingLeafPay.margins, recovered: true });
      if (fate.state === "pending") {
        dep.waiting = "the payment is posted and the operator has not answered it; sync posts it again";
        this.bridge.state.save();
        return;
      }
      delete st.pendingLeafPay; // the coin is live: nothing was paid
      this.bridge.state.save();
    }
    const coin = await this.coinOf(dep);
    if (!coin || coin.state !== "live") {
      dep.waiting = `the deposit's coin is ${coin?.state ?? "missing"}`;
      this.bridge.state.save();
      return;
    }
    const info = await this.wallet.info(true);
    if (info.medianTime !== null && it.until <= info.medianTime + 60) {
      return this.hold(dep, `the receive request lapsed at ${it.until} (the chain's median time is ${info.medianTime}) before the board was final`);
    }
    // The margins of paying this one coin: what the wallet says an amount it
    // cannot pay would take beyond itself, before it builds or signs anything.
    const live = (await this.wallet.coins()).filter((c) => c.asset === dep.assetId && c.state === "live");
    if (live.length !== 1 || live[0].leaf_id !== coin.leaf_id) {
      dep.waiting = `the leaf wallet holds ${live.length} live coins of the asset; a deposit is paid from its coin alone`;
      this.bridge.state.save();
      return;
    }
    const value = BigInt(coin.value);
    const probe = await this.wallet.send(it.request, value + 1n, dep.assetId);
    const t = probe.error ? takesFromRefusal(probe.error.message) : null;
    if (!t) {
      throw new Error(`the wallet did not price the margins (${probe.error?.message ?? "the probe was paid"})`);
    }
    const margins = t.takes - t.paid;
    const pay = value - margins;
    st.pendingLeafPay = { at: new Date().toISOString(), coin: coin.leaf_id, value: pay.toString(), margins: margins.toString() };
    this.bridge.state.save();
    const r = await this.wallet.send(it.request, pay, dep.assetId);
    if (r.error) {
      const fate = await this.payFate(dep).catch(() => ({ state: "unknown" }));
      if (fate.state === "paid") return this.paid(dep, { transferId: fate.transferId, value: pay.toString(), margins: margins.toString() });
      if (fate.state === "pending") {
        dep.waiting = `the payment is posted and unanswered (${r.error.message}); sync posts it again`;
        this.bridge.state.save();
        return;
      }
      delete st.pendingLeafPay;
      const m = String(r.error.message ?? "");
      // The operator refused the payment itself: the request cannot be paid.
      if (r.error.status >= 400 && r.error.status < 500 && r.error.code !== "rate_limited") {
        return this.hold(dep, `the operator refused the payment: ${m}`);
      }
      if (/lapsed/.test(m)) return this.hold(dep, m);
      dep.waiting = `the payment did not go through: ${m}`;
      this.bridge.state.save();
      this.log(`${dep.tag}: ${dep.waiting}`);
      return;
    }
    return this.paid(dep, {
      transferId: r.out?.transfer?.transfer_id ?? null,
      value: r.out?.sent?.value ?? pay.toString(),
      margins: margins.toString(),
    });
  }

  /** Whether a payment of the deposit's coin happened: the wallet records a
   *  transfer, and marks its coins `sending`, before it asks the operator,
   *  and marks them spent by the transfer once it is co-signed. */
  async payFate(dep) {
    const coin = await this.coinOf(dep);
    if (!coin) return { state: "unknown" };
    if (coin.state === "spent") {
      const m = /transfer ([0-9a-f]+)/.exec(String(coin.spent_by ?? coin.note ?? ""));
      return { state: "paid", transferId: m ? m[1] : coin.spent_by ?? null };
    }
    if (coin.state === "sending") return { state: "pending" };
    return { state: coin.state === "live" ? "none" : "unknown" };
  }

  paid(dep, p) {
    delete dep.steps.pendingLeafPay;
    dep.steps.leafPay = p;
    dep.leaf.paid = { value: String(p.value), margins: String(p.margins), transferId: p.transferId, at: new Date().toISOString() };
    dep.status = "minted";
    dep.deliveredAt = dep.leaf.paid.at;
    delete dep.waiting;
    delete dep.error;
    this.bridge.state.save();
    this.log(
      `${dep.tag}: paid a leaf of ${p.value} atoms (${p.margins} in the transfer's margins) to key ${dep.leaf.owner}, transfer ${p.transferId}`
    );
  }

  /** The request cannot be paid any more and the coin is the bridge's: it is
   *  held for the deposit, counted as owed, until an operator pays a new
   *  request of the depositor's (admin leaf-pay). */
  hold(dep, why) {
    dep.status = "leaf_held";
    dep.leaf.heldReason = why;
    dep.error = why;
    this.bridge.state.save();
    this.log(`${dep.tag}: ${why}; the leaf is held for the deposit until an operator pays a new request (admin leaf-pay)`);
  }

  /** Admin: pay a held deposit's leaf to a new request of the depositor's. */
  async repay(key, request) {
    const dep = this.s.deposits[key];
    if (!dep || dep.status !== "leaf_held") throw refuse(404, "no deposit holds a leaf under that key");
    const req = decodeRequest(request);
    const info = await this.wallet.info(true);
    if (req.operator !== info.operator || req.genesis_hash !== info.genesis) throw refuse(400, "the request is for another operator or chain");
    if (req.asset !== undefined && req.asset !== dep.assetId) throw refuse(400, "the request asks for another asset");
    if (req.value !== undefined) throw refuse(400, "the request names an amount; ask the depositor for one without");
    const need = this.c.landingLapseSeconds ?? 6 * 3600;
    if (req.until === undefined || info.medianTime === null || req.until < info.medianTime + need) {
      throw refuse(400, `the request lapses at ${req.until ?? "no time"}, too soon (the chain's median time is ${info.medianTime})`);
    }
    const addr = dep.leaf.intent;
    this.s.leafIntents[addr] = { ...this.s.leafIntents[addr], request: String(request).trim(), owner: req.owner, until: req.until, repaidAt: new Date().toISOString() };
    dep.leaf.owner = req.owner;
    dep.leaf.until = req.until;
    delete dep.leaf.heldReason;
    dep.status = "leaf_paying";
    this.bridge.state.save();
    await this.payStep(dep);
    return { key, status: dep.status, leaf: dep.leaf };
  }

  // ---------------------------------------------------------------- figures

  /** What the leaf route holds and has paid, for one asset: the wallet's
   *  holdings by state, the boards in flight, the leaves paid out and the
   *  amount still owed to leaf deposits. */
  async figures(assetId, balance = null) {
    const deps = Object.values(this.s.deposits).filter((d) => d.leaf?.route === "leaf" && d.assetId === assetId);
    let held = null;
    let walletError = null;
    try {
      held = holdingOf(balance ?? (await this.wallet.balance()), assetId);
    } catch (e) {
      walletError = e.message;
    }
    const boards = deps
      .filter((d) => d.status === "leaf_boarding" || d.status === "leaf_paying" || d.status === "leaf_held")
      .map((d) => ({ deposit: d.key, txid: d.steps.leafBoard?.txid ?? null, atoms: d.sats, status: d.status }));
    const paid = deps.filter((d) => d.leaf?.paid);
    const sum = (xs, f) => xs.reduce((a, d) => a + BigInt(f(d)), 0n);
    return {
      walletAtoms: held ? held.total.toString() : null,
      walletByState: held ? Object.fromEntries([["onchain", held.onchain.toString()], ...Object.entries(held.states).map(([k, v]) => [k, v.toString()])]) : null,
      walletError,
      boardsInFlight: boards,
      boardsInFlightAtoms: sum(boards, (b) => b.atoms).toString(),
      paidCount: paid.length,
      paidAtoms: sum(paid, (d) => d.leaf.paid.value).toString(),
      marginsAtoms: sum(paid, (d) => d.leaf.paid.margins).toString(),
      owedAtoms: sum(
        deps.filter((d) => LEAF_STATES.includes(d.status)),
        (d) => d.sats
      ).toString(),
    };
  }

  /** Problems for /api/health. */
  problems() {
    const out = [];
    const held = Object.values(this.s.deposits).filter((d) => d.status === "leaf_held");
    if (held.length) {
      out.push({
        key: "leaf:held",
        severity: "warning",
        title: `${held.length} deposit(s) hold a leaf the receive request can no longer take`,
        detail: `${held.map((d) => d.key).join(", ")}: pay a new request of the depositor's (admin.js leaf-pay)`,
      });
    }
    if (this.feeTopUpError) {
      out.push({ key: "leaf:fees", severity: "warning", title: "the leaf wallet's fee coins could not be topped up", detail: this.feeTopUpError });
    }
    if (this.lastSyncError) {
      out.push({ key: "leaf:sync", severity: "warning", title: "the leaf wallet's sync failed", detail: this.lastSyncError });
    }
    return out;
  }
}
