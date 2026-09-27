// Compages core: moves value between other chains and Sequentia assets.
//
// Ethereum -> Sequentia: scan confirmed Deposited events. First deposit of a
// token issues a new reissuable Sequentia asset (the daemon wallet keeps the
// reissuance token); later deposits of the same token reissue the SAME asset,
// so no token ever gets a duplicate. The minted amount is sent to the
// depositor's Sequentia address.
//
// Sequentia -> Ethereum: users create a redemption intent (a fresh Sequentia
// address bound to their Ethereum address) and send the bridged asset there
// from any wallet. Once confirmed on the active (Bitcoin-anchored) chain, the
// daemon releases the locked ether/tokens from the vault, then destroys the
// returned Sequentia amount so circulating supply always equals locked funds.
//
// Solana <-> Sequentia: no vault contract; both directions are intent-based
// (see the Solana section below). Deposited SOL is minted as SOL.s through the
// same issue-or-reissue machinery, and releases are paid from the operator's
// treasury account behind the same Bitcoin-anchor finality gate.
//
// Crash safety: every irreversible step is bracketed by a persisted marker.
// If the daemon dies between a chain write and its acknowledgment, the record
// halts in a *_manual state for operator review instead of double-paying.

import crypto from "node:crypto";
import { ethers } from "ethers";
import { amountToSats, satsToAmount } from "./seqrpc.js";
import { unitsToSats, satsToUnits, unitsToAtoms, atomsToUnits } from "./eth.js";
import {
  transferTx,
  buildTx,
  ataCreateIdempotent,
  splTransferChecked,
  ataAddress,
  isSolAddress,
  TOKEN_PROGRAM,
  FEE_LAMPORTS,
  RENT_EXEMPT_MIN_LAMPORTS,
  TOKEN_ACCOUNT_RENT_LAMPORTS,
} from "./sol.js";

// Per-asset money cap on Sequentia chains (21M * 1e8 sats).
export const SEQ_MAX_SATS = 2_100_000_000_000_000n;

// Canonical JSON exactly as the Sequentia Asset Registry computes it (object
// keys sorted lexicographically, no insignificant whitespace). The registry
// binds metadata to an asset by requiring the asset's on-chain contract_hash to
// equal SHA256(canonical-JSON(contract)), so the bridge must issue each asset
// with this exact hash for the metadata to be verifiable.
export function canonicalizeContract(v) {
  if (Array.isArray(v)) return "[" + v.map(canonicalizeContract).join(",") + "]";
  if (v && typeof v === "object") {
    return (
      "{" +
      Object.keys(v)
        .sort()
        .map((k) => JSON.stringify(k) + ":" + canonicalizeContract(v[k]))
        .join(",") +
      "}"
    );
  }
  return JSON.stringify(v);
}

export function contractHash(contract) {
  return crypto.createHash("sha256").update(canonicalizeContract(contract), "utf8").digest("hex");
}

// Turn a token symbol into a registry ticker: uppercase, keep only [A-Z0-9.-],
// and suffix an origin marker (".e" Ethereum-bridged, ".s" Solana-bridged) to
// avoid colliding with a native asset of the same symbol. Registry tickers are
// 1..12 chars.
export function bridgedTicker(symbol, suffix = ".e") {
  let base = String(symbol || "").toUpperCase().replace(/[^A-Z0-9.-]/g, "");
  if (!base) base = "TOKEN";
  return `${base.slice(0, 10)}${suffix}`;
}

export function tokenKeyOf(chainId, token) {
  return token === "eth" || token === ethers.ZeroAddress
    ? `${chainId}:eth`
    : `${chainId}:${token.toLowerCase()}`;
}

/** The mapping key of a unified asset: one Sequentia asset fed by several
 *  source chains, keyed by its symbol rather than by any one chain's token. */
export function unifiedKeyOf(symbol) {
  return `unified:${String(symbol).toUpperCase()}`;
}

/** A token key as the deposit paths spell it.
 *
 *  Ethereum addresses are case-insensitive hex and are stored lowercased
 *  (tokenKeyOf does the same). Solana mints are base58, where case carries
 *  meaning: lowercasing one yields a key no deposit can ever match, so a
 *  configured source would sit there looking correct and never route. */
export function normalizeTokenKey(tokenKey) {
  const key = String(tokenKey);
  const sep = key.indexOf(":");
  if (sep < 0) return key;
  const chain = key.slice(0, sep);
  const token = key.slice(sep + 1);
  return token.startsWith("0x") || token === "eth"
    ? `${chain}:${token.toLowerCase()}`
    : `${chain}:${token}`;
}

/** Every source a mapping serves, as { tokenKey: source }.
 *
 *  An ordinary bridged asset has exactly one source, its own token on its own
 *  chain, which older state files do not spell out; synthesize it so callers
 *  can treat every mapping the same way. A unified asset carries its sources
 *  explicitly, one per chain, and is the only kind with more than one. */
export function sourcesOf(mapping) {
  if (mapping.sources) return mapping.sources;
  return {
    [mapping.tokenKey]: {
      tokenKey: mapping.tokenKey,
      chainId: mapping.chainId,
      token: mapping.token,
      decimals: mapping.decimals,
      tokenProgram: mapping.tokenProgram,
    },
  };
}

/** The source this mapping serves on `chainId`, or null if it serves none.
 *  This is what makes a redemption's release target come from the ROUTED
 *  source rather than from whichever record an asset-id lookup returned. */
export function sourceForChain(mapping, chainId) {
  for (const src of Object.values(sourcesOf(mapping))) {
    if (src.chainId === chainId) return src;
  }
  return null;
}

export function refundId(chainId, nonce, vault = null) {
  // Each vault numbers its own deposits from zero, so a refund id must name
  // the vault as well once more than one is watched. The primary vault keeps
  // the original form so ids already recorded on chain still match.
  return ethers.keccak256(
    ethers.toUtf8Bytes(vault ? `compages:refund:${chainId}:${vault}:${nonce}` : `compages:refund:${chainId}:${nonce}`)
  );
}

export function redemptionIdOf(seqChain, txid, vout) {
  return ethers.keccak256(ethers.toUtf8Bytes(`compages:redeem:${seqChain}:${txid}:${vout}`));
}

/** A minimal async mutex: `run` executes `fn` after every earlier `run` has
 *  settled. */
class Mutex {
  constructor() {
    this.tail = Promise.resolve();
  }
  run(fn) {
    const result = this.tail.then(() => fn());
    this.tail = result.catch(() => {});
    return result;
  }
}

export class Bridge {
  /**
   * @param {object} cfg     daemon config
   * @param {import('./eth.js').Eth} eth
   * @param {import('./seqrpc.js').SeqRpc} seq
   * @param {import('./state.js').State} state
   * @param {(msg: string) => void} log
   * @param {import('./sol.js').Sol | null} sol   null disables the Solana leg
   */
  constructor(cfg, eth, seq, state, log, sol = null) {
    this.cfg = cfg;
    this.eth = eth;
    this.seq = seq;
    this.state = state;
    this.log = log;
    this.sol = sol;
    // The core and Solana loops run concurrently. Two things must still happen
    // one at a time: building-and-broadcasting a burn (two burns funded at
    // once could pick the same coins), and driving any one Solana redemption
    // (both loops reach them, and two concurrent drives could each build a
    // release with its own signature, which is a double payment).
    this.burnLock = new Mutex();
    this.recordLocks = new Set();
    this.phases = {};
  }

  /** Run `fn` unless the record `key` is already being driven elsewhere. */
  async withRecord(key, fn) {
    if (this.recordLocks.has(key)) return;
    this.recordLocks.add(key);
    try {
      return await fn();
    } finally {
      this.recordLocks.delete(key);
    }
  }

  phaseOk(name) {
    const p = (this.phases[name] ??= {});
    p.lastOk = Date.now();
    p.consecutiveFailures = 0;
  }

  phaseFailed(name, e) {
    const p = (this.phases[name] ??= {});
    p.lastError = e.message;
    p.lastErrorAt = Date.now();
    p.consecutiveFailures = (p.consecutiveFailures ?? 0) + 1;
  }

  // ================= Unified assets =================
  //
  // Normally one bridged token gets one Sequentia asset, so a token key IS a
  // mapping key. USDC breaks that: the same dollar arrives from Ethereum and
  // from Solana, and issuing an asset per chain would hand the network two
  // non-fungible USDCs, the exact liquidity split Circle's Bridged USDC
  // Standard exists to prevent. So a unified asset is ONE mapping fed by
  // several token keys, and `tokenRoutes` points each of those keys at it.
  //
  // Everything downstream keeps working on a single mapping record, which is
  // what keeps supply accounting honest: one asset, one circulating figure,
  // one registry contract. Per-chain facts (which token, how many decimals,
  // how much is escrowed there) live per source instead.

  /** The mapping serving `tokenKey`, following a unified route if there is
   *  one. Returns undefined when nothing bridges that token yet. */
  mappingFor(tokenKey) {
    const s = this.state.data;
    return s.mappings[this.mappingKeyFor(tokenKey)];
  }

  /** The mapping key `tokenKey` belongs to: itself, or the unified asset that
   *  claims it. */
  mappingKeyFor(tokenKey) {
    return this.state.data.tokenRoutes?.[tokenKey] ?? tokenKey;
  }

  /** Does this mapping serve this exact source? Used as the wrong-network
   *  guard, so an asset can only ever be released on a chain it is actually
   *  backed on. For an ordinary mapping the answer is "only my own token key",
   *  identical to the single-chain rule it replaces. */
  mappingServesSource(mapping, tokenKey) {
    return Boolean(sourcesOf(mapping)[tokenKey]);
  }

  /** Unified asset definitions from config, keyed by mapping key. */
  unifiedDefs() {
    const out = {};
    for (const [symbol, def] of Object.entries(this.cfg.unified ?? {})) {
      out[unifiedKeyOf(symbol)] = { symbol, ...def };
    }
    return out;
  }

  /** The two BIP340 keys that supervise a unified asset, generated once.
   *
   *  A supervised asset is one whose issuer can freeze holders by consensus
   *  rule, which is what lets a bridged stablecoin meet the freeze obligation a
   *  regulated issuer has. Two keys, and the split is the point (Sequentia
   *  src/supervision.h):
   *
   *    operational  freezes and unfreezes, day to day
   *    recovery     replaces either key, and can do nothing else
   *
   *  A stolen operational key can grief, visibly and on chain, but can never
   *  take the authority away from its owner, because it cannot rotate. That is
   *  the entire reason for the second key.
   *
   *  BOTH ARE PERMANENT. They are committed in the asset id, so they cannot be
   *  changed for this asset ever, and an asset issued without them can never
   *  become supervised. Hence: generated once, recorded in state before the
   *  issuance that commits them, and logged loudly so they survive a lost state
   *  file. The private halves live in the node wallet, which means THAT WALLET'S
   *  BACKUP IS THE FREEZE AUTHORITY. Fine for a testnet operator; a production
   *  issuer would generate these under FROST and pass the public halves in via
   *  config instead, which is why the RPC never asks for a private key. */
  async supervisionKeysFor(mappingKey, def) {
    const s = this.state.data;
    s.supervision ??= {};
    if (s.supervision[mappingKey]) return s.supervision[mappingKey];

    // Configured public keys win: an issuer with a real signing setup brings
    // its own and the node never sees the private halves at all.
    const cfg = def.supervision ?? {};
    let operationalkey = cfg.operationalKey;
    let recoverykey = cfg.recoveryKey;

    const freshXOnly = async () => {
      const addr = await this.seq.call("getnewaddress", {});
      const info = await this.seq.call("getaddressinfo", { address: addr });
      const compressed = String(info.pubkey || "");
      if (compressed.length !== 66) {
        throw new Error(`node returned a ${compressed.length / 2}-byte pubkey, cannot use for BIP340`);
      }
      // Compressed is 33 bytes: a parity byte then the x coordinate. BIP340
      // signs under the x coordinate alone.
      return compressed.slice(2);
    };

    if (!operationalkey) operationalkey = await freshXOnly();
    if (!recoverykey) recoverykey = await freshXOnly();
    if (operationalkey === recoverykey) {
      throw new Error("supervision keys must differ; the wallet handed out the same key twice");
    }

    const keys = {
      operationalkey,
      recoverykey,
      pause: Boolean(cfg.pause),
      source: cfg.operationalKey ? "config" : "node-wallet",
      createdAt: new Date().toISOString(),
    };
    s.supervision[mappingKey] = keys;
    this.state.save();

    this.log(
      `unified ${def.symbol}: SUPERVISION KEYS, permanent and committed in the asset id. ` +
        `operational=${operationalkey} recovery=${recoverykey} pause=${keys.pause} ` +
        `source=${keys.source}. Back up the node wallet: it holds the freeze authority.`
    );
    return keys;
  }

  /** Issue every configured unified asset that does not exist yet, and route
   *  its sources to it.
   *
   *  This is a deliberate ceremony rather than a side effect of the first
   *  deposit: the asset is created with ZERO supply and exactly ONE reissuance
   *  token, so backing is exact from the very first atom and the mint
   *  authority is a single, transferable object. It runs before any deposit is
   *  accepted, and is idempotent, so a restart re-routes without re-issuing.
   *
   *  Every parameter here is permanent. The contract (name, ticker, domain,
   *  issuer key) is hashed into the asset id, and the precision is read from
   *  this issuance forever, so none of it can be corrected later. */
  async ensureUnifiedAssets() {
    const s = this.state.data;
    const defs = this.unifiedDefs();
    if (!Object.keys(defs).length) return;
    s.tokenRoutes ??= {};

    for (const [mappingKey, def] of Object.entries(defs)) {
      const sources = def.sources ?? {};
      if (!Object.keys(sources).length) {
        throw new Error(`unified asset ${def.symbol} has no sources configured`);
      }
      let mapping = s.mappings[mappingKey];

      // A ceremony whose broadcast could not be confirmed either way last time
      // is resolved before anything else: issuing again while the first one
      // might still land would create a second, rival asset.
      const pending = s.pendingUnified?.[mappingKey];
      if (!mapping && pending) {
        const fate = await this.resolveBroadcast(pending.issued.txid);
        if (fate === "unknown") {
          throw new Error(
            `unified ${def.symbol}: issuance ${pending.issued.txid} is neither provably broadcast nor provably absent; ` +
              `refusing to issue again until the node can say which`
          );
        }
        delete s.pendingUnified[mappingKey];
        if (fate === "visible") {
          mapping = this.unifiedMappingFrom(mappingKey, def, pending);
          s.mappings[mappingKey] = mapping;
          this.log(`unified ${def.symbol}: earlier issuance ${pending.issued.txid} confirmed visible; adopted`);
        }
        this.state.save();
      }

      if (!mapping) {
        const precision = def.precision ?? 8;
        const contract = await this.buildAssetContract(
          { symbol: def.symbol, name: def.name },
          null,
          null,
          { ticker: def.ticker, name: def.name, precision }
        );
        const ch = contractHash(contract);
        // Zero asset amount, one reissuance token: nothing circulates until a
        // deposit is verified, and the token supply is fixed at 1 forever so
        // "who can mint" is answerable by looking at who holds it.
        // Supervision is decided HERE and nowhere else, permanently: the keys
        // go into the asset id, so this asset and the unsupervised one are
        // different assets and no later change can convert between them.
        const supervision = def.supervision?.enabled
          ? await this.supervisionKeysFor(mappingKey, def)
          : null;

        const issued = await this.seq.call("issueasset", {
          assetamount: 0,
          tokenamount: 1,
          blind: false,
          contract_hash: ch,
          denomination: precision,
          ...(this.cfg.seqFeeAsset ? { fee_asset: this.cfg.seqFeeAsset } : {}),
          ...(supervision
            ? {
                supervision: {
                  operationalkey: supervision.operationalkey,
                  recoverykey: supervision.recoverykey,
                  pause: supervision.pause,
                },
              }
            : {}),
        });
        const ceremony = { issued, precision, contract, contractHash: ch, supervision };
        s.pendingUnified ??= {};
        s.pendingUnified[mappingKey] = ceremony;
        this.state.save();
        const fate = await this.confirmBroadcast(issued.txid);
        if (fate === "absent") {
          delete s.pendingUnified[mappingKey];
          this.state.save();
          throw new Error(`unified ${def.symbol}: issuance tx never reached the mempool`);
        }
        if (fate === "unknown") {
          throw new Error(
            `unified ${def.symbol}: could not establish whether issuance ${issued.txid} was broadcast; ` +
              `it is recorded and will be resolved on the next start`
          );
        }
        delete s.pendingUnified[mappingKey];
        mapping = this.unifiedMappingFrom(mappingKey, def, ceremony);
        s.mappings[mappingKey] = mapping;
        this.state.save();
        this.log(
          `unified ${def.symbol}: issued Sequentia asset ${issued.asset} as ${contract.ticker} ` +
            `(precision ${precision}, zero supply, 1 reissuance token ${issued.token}` +
            `${supervision ? ", SUPERVISED" + (supervision.pause ? " with pause" : "") : ""})`
        );
        await this.registerAsset(mapping).catch((e) =>
          this.log(`asset ${mapping.assetId}: registry registration deferred: ${e.message}`)
        );
      }

      // Route every configured source at this asset. Adding a source later is
      // just a config change plus a restart; it never mints a second asset,
      // because the route makes the deposit path find this mapping.
      mapping.sources ??= {};
      for (const [tokenKey, src] of Object.entries(sources)) {
        // Ethereum token keys are case-insensitive hex and are stored
        // lowercased; Solana mints are base58, where case is significant and
        // lowercasing would silently produce a key no deposit can ever match.
        const key = normalizeTokenKey(tokenKey);
        mapping.sources[key] ??= {
          tokenKey: key,
          chainId: src.chainId,
          token: src.token,
          decimals: src.decimals,
          tokenProgram: src.tokenProgram,
          escrowedUnits: "0",
        };
        // Config is the authority on identity; escrow is the daemon's ledger.
        Object.assign(mapping.sources[key], {
          chainId: src.chainId,
          token: src.token,
          decimals: src.decimals,
          ...(src.tokenProgram ? { tokenProgram: src.tokenProgram } : {}),
          // Which vault escrows this source. A stablecoin destined for a
          // hand-off needs one that can lock its supply and burn itself, which
          // may not be the vault older assets sit in.
          ...(src.vault ? { vault: src.vault } : {}),
        });
        if (s.tokenRoutes[key] !== mappingKey) {
          s.tokenRoutes[key] = mappingKey;
          this.log(`unified ${def.symbol}: routed ${key} -> ${mappingKey}`);
        }
      }
      this.state.save();
    }
  }

  /** The mapping record for a unified asset whose issuance is visible. */
  unifiedMappingFrom(mappingKey, def, { issued, precision, contract, contractHash: ch, supervision }) {
    return {
      tokenKey: mappingKey,
      unified: true,
      symbol: def.symbol,
      name: def.name,
      precision,
      assetId: issued.asset,
      reissuanceToken: issued.token,
      entropy: issued.entropy,
      issueTxid: issued.txid,
      mintedSats: "0",
      sources: {},
      contract,
      contractHash: ch,
      registered: false,
      createdAt: new Date().toISOString(),
      supervision: supervision
        ? {
            supervised: true,
            operationalkey: supervision.operationalkey,
            recoverykey: supervision.recoverykey,
            pauseAllowed: supervision.pause,
          }
        : { supervised: false },
    };
  }

  /** Record that `units` more of a source's token now sit in that chain's
   *  escrow. The sum of these across sources is what circulating supply must
   *  equal; see /api/por.
   *
   *  `dep` is credited at most once. Escrow measures what users actually sent,
   *  not how many times we tried to mint against it, and a deposit CAN be
   *  re-driven: a mint deferred by a false negative (the reissue confirmed but
   *  we failed to see it) is retried from the top. Crediting twice would
   *  inflate the escrow figure, and an inflated escrow makes /api/por report
   *  backing that the source chain does not actually hold, which is the one
   *  direction a proof of reserves must never err in. */
  creditEscrow(mapping, tokenKey, units, dep = null) {
    this.escrowEpoch = (this.escrowEpoch ?? 0) + 1;
    if (dep) {
      dep.steps ??= {};
      if (dep.steps.escrowCredited) return;
      dep.steps.escrowCredited = true;
    }
    // Only a mapping with persisted sources keeps an escrow ledger. An
    // ordinary bridged asset predates the ledger and its source is synthesized
    // on read, so there is nowhere to record this; its backing is still the
    // vault balance, which the release checks against directly.
    const src = mapping.sources?.[tokenKey];
    if (!src) return;
    src.escrowedUnits = (BigInt(src.escrowedUnits ?? "0") + BigInt(units)).toString();
  }

  /** Circulating supply of an asset in atoms, read from the Sequentia chain
   *  rather than from this daemon's own bookkeeping.
   *
   *  That independence is the point: proof of reserves compares escrow against
   *  what the CHAIN says is circulating, so a bug in the daemon's ledger shows
   *  up as a discrepancy instead of quietly agreeing with itself. The node has
   *  no per-asset supply index, so supply is reconstructed the same way the
   *  standard's auditor does it, from issuances minus burns; the wallet has
   *  seen every one of this bridge's own issuances, which is what listissuances
   *  reports. A blinded issuance would be unknowable, so refuse to report a
   *  number rather than report a wrong one. */
  async chainSupplyAtoms(assetId) {
    const issuances = await this.seq.call("listissuances", { asset: assetId });
    let atoms = 0n;
    for (const iss of issuances) {
      // Read the amount from the transaction itself rather than from
      // listissuances, whose `assetamount` is -1 both for a blinded issuance
      // AND for an explicit zero one (a token-only issuance, exactly what the
      // unified ceremony performs), which would make the two indistinguishable.
      // In the raw transaction they are not: an explicit amount appears as
      // `assetamount`, a blinded one as `assetamountcommitment`, and an
      // issuance that mints no units of the asset carries neither.
      // An issuance's amount never changes once it is in a transaction, so
      // it is read once and remembered.
      this._issuanceCache ??= new Map();
      const ck = `${iss.txid}:${iss.vin}`;
      let amt = this._issuanceCache.get(ck);
      if (amt === undefined) {
        const wtx = await this.seq.call("gettransaction", { txid: iss.txid });
        const decoded = await this.seq.call("decoderawtransaction", { hexstring: wtx.hex });
        const issuance = decoded.vin?.[iss.vin]?.issuance;
        if (issuance?.assetamountcommitment) {
          throw new Error(`asset ${assetId} has a blinded issuance; supply is not knowable`);
        }
        amt = issuance?.assetamount === undefined ? 0n : amountToSats(issuance.assetamount);
        if ((wtx.confirmations ?? 0) >= (this.cfg.seqConfirmations ?? 6)) this._issuanceCache.set(ck, amt);
      }
      atoms += amt;
    }
    const burned = await this.burnedAtoms(assetId);
    return atoms - burned;
  }

  /** Atoms of an asset this bridge has provably destroyed, summed from the
   *  wallet's own burn transactions. */
  async burnedAtoms(assetId) {
    let burned = 0n;
    for (const rec of Object.values(this.state.data.redemptions)) {
      if (rec.assetId === assetId && rec.destroyTxid) burned += BigInt(rec.sats);
    }
    for (const rec of Object.values(this.state.data.solRedemptions)) {
      if (rec.assetId === assetId && rec.destroyTxid) burned += BigInt(rec.sats);
    }
    return burned;
  }

  /** Record that `units` left a source's escrow on release. `rec` is debited
   *  at most once, however many paths learn that its payout landed. */
  debitEscrow(mapping, tokenKey, units, rec = null) {
    this.escrowEpoch = (this.escrowEpoch ?? 0) + 1;
    if (rec) {
      if (rec.escrowDebited) return;
      rec.escrowDebited = true;
    }
    const src = mapping.sources?.[tokenKey];
    if (!src) return;
    const now = BigInt(src.escrowedUnits ?? "0") - BigInt(units);
    if (now < 0n) {
      // More left this escrow than ever entered it. That cannot happen
      // unless something paid out that should not have: stop paying.
      this.halt(mapping.assetId, "all", `${tokenKey} escrow ledger went negative by ${-now} units`);
    }
    src.escrowedUnits = (now < 0n ? 0n : now).toString();
  }

  // ================= Ethereum -> Sequentia =================

  /** The newest block whose deposits may be minted against. By default the
   *  chain's own finalized block: a deposit minted on Sequentia cannot be
   *  taken back if an Ethereum reorg removes it, so it waits until Ethereum
   *  itself says it cannot be reorged. A fixed confirmation count
   *  (`ethFinality: "confirmations"`) is for local test chains. */
  async ethSafeHead() {
    if ((this.cfg.ethFinality ?? "finalized") === "finalized") {
      const b = await this.eth.provider.getBlock("finalized");
      if (!b) throw new Error("the Ethereum RPC returned no finalized block");
      return b.number;
    }
    return (await this.eth.provider.getBlockNumber()) - this.cfg.ethConfirmations;
  }

  async processDeposits() {
    const s = this.state.data;
    const confirmedHead = await this.ethSafeHead();
    this.lastEthSafeHead = confirmedHead;
    await this.checkDepositGaps(confirmedHead);
    if (confirmedHead <= s.lastEthBlock) return;

    const chunk = this.cfg.ethLogChunk ?? 5000;
    let from = s.lastEthBlock + 1;
    while (from <= confirmedHead) {
      const to = Math.min(from + chunk - 1, confirmedHead);
      // Every vault is on this chain and shares its block numbers, so one
      // cursor covers them all; a vault deployed later simply has no logs
      // before its deploy block.
      for (const address of this.eth.vaultAddresses) {
        const vault = this.eth.vaultFor(address);
        const logs = await vault.queryFilter(vault.filters.Deposited(), from, to);
        for (const ev of logs) {
          await this.handleDeposit(ev, address);
        }
      }
      s.lastEthBlock = to;
      this.state.save();
      from = to + 1;
    }
  }

  /** The state key of deposit `nonce` on `vaultAddress`. The primary vault
   *  keeps the bare nonce so existing records and refund ids stay valid. */
  depositKey(nonce, vaultAddress) {
    const isPrimary =
      !vaultAddress || String(this.cfg.vaultAddress ?? "").toLowerCase() === String(vaultAddress).toLowerCase();
    return isPrimary ? String(nonce) : `${vaultAddress}:${nonce}`;
  }

  /** Every vault numbers its deposits 0, 1, 2, ... with no gaps, so the
   *  count at the safe head says exactly which records must exist. A missing
   *  one means a log the RPC failed to return (a lagging node behind a load
   *  balancer can answer an eth_getLogs range with nothing and let the cursor
   *  move past it). Re-read the whole vault once; if a deposit is still
   *  missing, report it rather than let it vanish silently. */
  async checkDepositGaps(safeHead) {
    const s = this.state.data;
    const every = this.cfg.gapCheckMinutes ?? 10;
    if (this._lastGapCheck && Date.now() - this._lastGapCheck < every * 60_000) return;
    if (safeHead > s.lastEthBlock) return; // still catching up; check once level
    this._lastGapCheck = Date.now();
    const missing = [];
    for (const address of this.eth.vaultAddresses) {
      const vault = this.eth.vaultFor(address);
      let count;
      try {
        count = Number(await vault.depositCount({ blockTag: s.lastEthBlock }));
      } catch {
        continue; // a vault not yet deployed at that height
      }
      const lost = [];
      for (let n = 0; n < count; n++) if (!s.deposits[this.depositKey(n, address)]) lost.push(n);
      if (!lost.length) continue;
      this.log(`vault ${address}: deposits ${lost.join(",")} have no record; re-reading the vault`);
      const from = this.eth.deployBlockOf(address) ?? this.cfg.vaultDeployBlock ?? 0;
      const chunk = this.cfg.ethLogChunk ?? 5000;
      for (let b = from; b <= s.lastEthBlock; b += chunk) {
        const logs = await vault.queryFilter(vault.filters.Deposited(), b, Math.min(b + chunk - 1, s.lastEthBlock));
        for (const ev of logs) await this.handleDeposit(ev, address);
      }
      for (const n of lost) if (!s.deposits[this.depositKey(n, address)]) missing.push(`${address}#${n}`);
    }
    this.missingDeposits = missing;
  }

  async handleDeposit(ev, vaultAddress = null) {
    const s = this.state.data;
    const nonce = ev.args.nonce.toString();
    // Vaults number their deposits independently, so nonce alone stops being
    // unique the moment a second vault is watched. The primary vault keeps
    // the bare nonce as its key so existing records and their on-chain refund
    // ids are untouched.
    const key = this.depositKey(nonce, vaultAddress);
    if (s.deposits[key]) {
      // Already seen. The same nonce with a different transaction would mean
      // a reorg rewrote the vault's history under a record: say so loudly.
      const known = s.deposits[key];
      if (known.ethTxHash && known.ethTxHash.toLowerCase() !== ev.transactionHash.toLowerCase()) {
        this.log(`deposit ${key}: seen again in a DIFFERENT transaction (${ev.transactionHash} vs ${known.ethTxHash})`);
        this.depositConflicts = [...new Set([...(this.depositConflicts ?? []), key])];
      }
      return;
    }

    const token = ev.args.token === ethers.ZeroAddress ? "eth" : ev.args.token.toLowerCase();
    const dep = {
      nonce,
      key,
      vault: vaultAddress ?? null,
      tag: `deposit #${nonce}`,
      ethTxHash: ev.transactionHash,
      ethBlock: ev.blockNumber,
      token,
      tokenKey: tokenKeyOf(this.cfg.ethChainId, token),
      from: ev.args.from,
      amountUnits: ev.args.amount.toString(),
      seqAddress: ev.args.sequentiaAddress,
      status: "minting",
      steps: {},
      createdAt: new Date().toISOString(),
    };
    s.deposits[key] = dep;
    this.state.save();
    this.log(
      `deposit #${nonce}: ${dep.amountUnits} units of ${token} from ${dep.from} -> ${dep.seqAddress}`
    );

    try {
      await this.mintDeposit(dep);
    } catch (e) {
      if (dep.status === "minting") this.mintFailed(dep, e);
    }
  }

  async mintDeposit(dep) {
    const s = this.state.data;

    // 1. Validate the destination address on the Sequentia node.
    const v = await this.seq.node("validateaddress", { address: dep.seqAddress });
    if (!v.isvalid) {
      this.log(`deposit #${dep.nonce}: invalid Sequentia address, scheduling refund`);
      dep.status = "refund_pending";
      dep.refundReason = "invalid Sequentia address";
      this.state.save();
      return;
    }

    // 2. Resolve token metadata and the deposit amount in atoms. A unified
    //    asset is found through its route, so a second source chain reissues
    //    the one asset instead of minting a rival one.
    let mapping = this.mappingFor(dep.tokenKey);
    const src = mapping ? sourcesOf(mapping)[dep.tokenKey] : null;
    const meta = src ?? mapping ?? (await this.eth.tokenMetadata(dep.token));
    const sats = unitsToAtoms(dep.amountUnits, meta.decimals, mapping?.precision);
    if (sats === 0n) {
      dep.status = "refund_pending";
      dep.refundReason = "amount too small to represent on Sequentia";
      this.state.save();
      return;
    }
    const minted = Boolean(dep.steps.issueTxid || dep.steps.mintTxid);
    const already = mapping && !minted ? BigInt(mapping.mintedSats) : 0n;
    if (!minted && already + sats > SEQ_MAX_SATS) {
      dep.status = "refund_pending";
      dep.refundReason = "would exceed the Sequentia per-asset amount cap";
      this.state.save();
      return;
    }
    dep.sats = sats.toString();
    if (mapping && this.haltedReason(mapping.assetId, "mint")) return this.holdForHalt(dep, mapping.assetId);

    // 3. First bridge of this token: issue a brand-new reissuable asset with
    //    exactly the deposit amount. Later deposits: reissue the same asset.
    mapping = await this.ensureMintedMapping(dep, dep.tokenKey, sats, {
      chainId: this.cfg.ethChainId,
      token: dep.token,
      meta: { symbol: meta.symbol, name: meta.name, decimals: meta.decimals },
      chainName: this.cfg.ethChainName,
      tickerSuffix: ".e",
    });
    if (!mapping) return; // deferred or halted; status/markers already recorded
    dep.assetId = mapping.assetId;
    // The deposit is now backed: the tokens are in this chain's escrow.
    this.creditEscrow(mapping, dep.tokenKey, dep.amountUnits, dep);
    this.state.save();

    await this.sendMinted(dep, mapping);
  }

  /** Issue-or-reissue the bridged asset for `tokenKey` by `sats`, creating the
   *  mapping (with its registry contract) on first use. Shared by every leg;
   *  `origin` describes where the deposit came from: { chainId, token, meta:
   *  {symbol, name, decimals}, chainName, tickerSuffix }. Returns the mapping,
   *  or null when the mint was deferred or is unresolved (dep status and
   *  markers already recorded).
   *
   *  Idempotent per deposit: once a deposit's mint is recorded, calling this
   *  again returns the mapping without minting, so a deposit re-driven after a
   *  crash or a failed delivery can never be minted twice. */
  async ensureMintedMapping(dep, tokenKey, sats, origin) {
    const s = this.state.data;
    const tag = dep.tag ?? `deposit #${dep.nonce}`;
    // Follow a unified route before deciding to issue: this lookup is the one
    // and only thing standing between a second source chain and a duplicate,
    // liquidity-splitting asset.
    const mappingKey = this.mappingKeyFor(tokenKey);
    if (dep.steps.issueTxid || dep.steps.mintTxid) return s.mappings[mappingKey];

    let mapping = s.mappings[mappingKey];
    if (!mapping) {
      // Anyone can create a token and bridge it, and each first bridge makes
      // the operator issue and register a new asset. Cap how many per day so
      // that cannot be turned into an unbounded fee and registry bill.
      const dayAgo = Date.now() - 86_400_000;
      const recent = Object.values(s.mappings).filter((m) => Date.parse(m.createdAt ?? 0) > dayAgo && !m.unified).length;
      if (recent >= (this.cfg.maxNewAssetsPerDay ?? 20)) {
        dep.waiting = "the daily limit on newly bridged tokens is reached; this deposit mints tomorrow";
        this.deferMint(dep, "pendingIssue", new Error(dep.waiting));
        return null;
      }
      // Build the registry contract up front and issue the asset committed to
      // its hash, so the metadata is bound on-chain and independently verifiable.
      const contract = await this.buildAssetContract(origin.meta, origin.chainName, origin.tickerSuffix);
      const ch = contractHash(contract);

      dep.steps.pendingIssue = true;
      this.state.save();
      let issued;
      try {
        issued = await this.seq.call("issueasset", {
          assetamount: satsToAmount(sats),
          tokenamount: 1,
          blind: false,
          contract_hash: ch,
          ...(this.cfg.seqFeeAsset ? { fee_asset: this.cfg.seqFeeAsset } : {}),
        });
      } catch (e) {
        if (typeof e.code === "number") {
          this.deferMint(dep, "pendingIssue", e);
          return null;
        }
        throw e;
      }
      // Everything needed to finish the step is recorded BEFORE asking whether
      // it landed, so an unanswered question can be asked again later instead
      // of being guessed at.
      dep.steps.issueCandidate = {
        txid: issued.txid,
        asset: issued.asset,
        token: issued.token,
        entropy: issued.entropy,
        sats: sats.toString(),
        mappingKey,
        tokenKey,
        origin: { chainId: origin.chainId, token: origin.token, meta: origin.meta },
        contract,
        contractHash: ch,
      };
      this.state.save();
      const fate = await this.confirmBroadcast(issued.txid);
      if (fate === "absent") {
        delete dep.steps.issueCandidate;
        this.deferMint(dep, "pendingIssue", new Error("issuance tx never reached the mempool"));
        return null;
      }
      if (fate === "unknown") {
        this.markUnresolved(dep, `could not establish whether issuance ${issued.txid} was broadcast`);
        return null;
      }
      mapping = this.finishIssue(dep);
      await this.registerAsset(mapping).catch((e) =>
        this.log(`asset ${mapping.assetId}: registry registration deferred: ${e.message}`)
      );
    } else {
      dep.steps.pendingMint = true;
      this.state.save();
      let re;
      try {
        re = await this.seq.call("reissueasset", {
          asset: mapping.assetId,
          assetamount: satsToAmount(sats),
          ...(this.cfg.seqFeeAsset ? { fee_asset: this.cfg.seqFeeAsset } : {}),
        });
      } catch (e) {
        if (typeof e.code === "number") {
          this.deferMint(dep, "pendingMint", e);
          return null;
        }
        throw e;
      }
      dep.steps.mintCandidate = { txid: re.txid, sats: sats.toString(), mappingKey };
      this.state.save();
      const fate = await this.confirmBroadcast(re.txid);
      if (fate === "absent") {
        delete dep.steps.mintCandidate;
        this.deferMint(dep, "pendingMint", new Error("reissuance tx never reached the mempool"));
        return null;
      }
      if (fate === "unknown") {
        this.markUnresolved(dep, `could not establish whether reissuance ${re.txid} was broadcast`);
        return null;
      }
      mapping = this.finishReissue(dep);
    }
    return mapping;
  }

  /** Record a confirmed first issuance: create the mapping, clear the marker. */
  finishIssue(dep) {
    const s = this.state.data;
    const c = dep.steps.issueCandidate;
    const tag = dep.tag ?? `deposit #${dep.nonce}`;
    const mapping = {
      tokenKey: c.tokenKey,
      chainId: c.origin.chainId,
      token: c.origin.token,
      symbol: c.origin.meta.symbol,
      name: c.origin.meta.name,
      decimals: c.origin.meta.decimals,
      assetId: c.asset,
      reissuanceToken: c.token,
      entropy: c.entropy,
      issueTxid: c.txid,
      firstDepositNonce: dep.nonce ?? dep.sig ?? null,
      mintedSats: c.sats,
      contract: c.contract,
      contractHash: c.contractHash,
      registered: false,
      createdAt: new Date().toISOString(),
    };
    s.mappings[c.mappingKey] = mapping;
    delete dep.steps.pendingIssue;
    delete dep.steps.issueCandidate;
    dep.steps.issueTxid = c.txid;
    this.state.save();
    this.log(
      `${tag}: issued NEW Sequentia asset ${c.asset} for ${c.origin.meta.symbol} as ${c.contract.ticker} (${c.tokenKey})`
    );
    return mapping;
  }

  /** Record a confirmed reissuance: count the supply, clear the marker. */
  finishReissue(dep) {
    const s = this.state.data;
    const c = dep.steps.mintCandidate;
    const mapping = s.mappings[c.mappingKey];
    mapping.mintedSats = (BigInt(mapping.mintedSats) + BigInt(c.sats)).toString();
    delete dep.steps.pendingMint;
    delete dep.steps.mintCandidate;
    dep.steps.mintTxid = c.txid;
    this.state.save();
    this.log(
      `${dep.tag ?? `deposit #${dep.nonce}`}: reissued ${satsToAmount(c.sats)} of existing asset ${mapping.assetId} (${mapping.symbol})`
    );
    return mapping;
  }

  /** Park a deposit whose last chain write could not be confirmed either way.
   *  It is re-examined every tick (resolveUnresolved) and only becomes a
   *  manual case if the node cannot answer for `unresolvedHours`. */
  markUnresolved(dep, why) {
    dep.status = "unresolved";
    dep.error = why;
    dep.unresolvedSince ??= new Date().toISOString();
    this.state.save();
    this.log(`${dep.tag ?? `deposit #${dep.nonce}`}: ${why}; re-checking every tick`);
  }

  /** Settle a deposit left "unresolved": ask the node again about the one
   *  transaction in question, finish the step if it landed, retry cleanly if
   *  it provably did not, and keep waiting otherwise. Returns true when the
   *  deposit may continue its normal flow. */
  async resolveUnresolved(dep) {
    const st = dep.steps ?? {};
    const cand = st.issueCandidate ?? st.mintCandidate ?? st.sendCandidate;
    const tag = dep.tag ?? `deposit #${dep.nonce}`;
    if (!cand) {
      dep.status = "failed_manual";
      dep.error = "unresolved with no recorded transaction to examine";
      this.state.save();
      return false;
    }
    const fate = await this.resolveBroadcast(cand.txid);
    if (fate === "unknown") {
      const hours = (Date.now() - Date.parse(dep.unresolvedSince ?? dep.createdAt)) / 3_600_000;
      if (hours > (this.cfg.unresolvedHours ?? 24)) {
        dep.status = "failed_manual";
        dep.error = `transaction ${cand.txid} still unresolved after ${Math.floor(hours)} h`;
        this.state.save();
        this.log(`${tag}: ${dep.error}; parked for the operator`);
      }
      return false;
    }
    delete dep.unresolvedSince;
    if (st.issueCandidate) {
      if (fate === "visible") this.finishIssue(dep);
      else {
        delete st.issueCandidate;
        delete st.pendingIssue;
      }
    } else if (st.mintCandidate) {
      if (fate === "visible") this.finishReissue(dep);
      else {
        delete st.mintCandidate;
        delete st.pendingMint;
      }
    } else {
      if (fate === "visible") {
        this.finishSend(dep, cand.txid);
        return false; // delivered: nothing left to drive
      }
      delete st.sendCandidate;
      delete st.pendingSend;
    }
    this.log(`${tag}: transaction ${cand.txid} resolved as ${fate}`);
    dep.status = "mint_retry"; // re-enters the idempotent flow from the top
    delete dep.nextAttemptAt;
    this.state.save();
    return true;
  }

  // ---- Asset Registry integration --------------------------------------

  /** A compressed pubkey the bridge wallet controls, for the registry contract's
   *  issuer_pubkey field (cached; any valid non-zero pubkey the issuer holds). */
  async issuerPubkey() {
    if (this._issuerPubkey) return this._issuerPubkey;
    // A unified asset's issuer key is PINNED in config: it is committed into
    // the asset id and later authorizes the registry hand-off to the stablecoin
    // issuer, so it must survive restarts rather than being a fresh wallet key
    // each time the daemon boots.
    if (this.cfg.unifiedIssuerPubkey) {
      this._issuerPubkey = this.cfg.unifiedIssuerPubkey;
      return this._issuerPubkey;
    }
    const addr = await this.seq.call("getnewaddress", { label: "compages-issuer" });
    const info = await this.seq.call("getaddressinfo", { address: addr });
    if (!info.pubkey) throw new Error("wallet returned no pubkey for the issuer address");
    this._issuerPubkey = info.pubkey;
    return this._issuerPubkey;
  }

  /** The registry contract (metadata) for a bridged token. The name is the
   *  token's own name with a concise origin marker; the origin-suffixed ticker
   *  and the bridge's entity domain convey which chain it bridged from.
   *
   *  `override` supplies a unified asset's fixed identity instead, since that
   *  asset belongs to no single chain: its name and ticker are the ones the
   *  stablecoin issuer's standard prescribes, and its precision matches the
   *  token's own decimals rather than the 8 that ordinary bridged assets use.
   *  Everything here is hashed into the asset id, so it is permanent. */
  async buildAssetContract(meta, chainName = this.cfg.ethChainName, tickerSuffix = ".e", override = null) {
    return {
      name: (override?.name ?? `${meta.name} (${chainName})`).slice(0, 255),
      ticker: override?.ticker ?? bridgedTicker(meta.symbol, tickerSuffix),
      precision: override?.precision ?? 8,
      entity: { domain: this.cfg.assetDomain || "compages.invalid" },
      issuer_pubkey: await this.issuerPubkey(),
      version: 0,
    };
  }

  /** Register (or refresh) an asset's metadata in the Sequentia Asset Registry
   *  so every surface (wallet, explorer, DEX, node GUI) shows a ticker and name
   *  instead of a raw asset id. Uses the operator admin endpoint when a token is
   *  configured (the path the native assets use), else the public verify-on-chain
   *  endpoint. The asset was issued committed to contractHash(contract), so the
   *  binding is on-chain-verifiable regardless of which endpoint is used. */
  async registerAsset(mapping) {
    if (!this.cfg.registryUrl || !mapping.contract) return;
    const base = this.cfg.registryUrl.replace(/\/$/, "");
    const admin = !!this.cfg.registryAdminToken;
    const res = await fetch(admin ? `${base}/admin/seed` : `${base}/`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(admin ? { authorization: `Bearer ${this.cfg.registryAdminToken}` } : {}),
      },
      body: JSON.stringify({ asset_id: mapping.assetId, contract: mapping.contract }),
      signal: AbortSignal.timeout(15_000),
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`registry ${res.status}: ${text.slice(0, 200)}`);
    mapping.registered = true;
    this.state.save();
    this.log(`asset ${mapping.assetId}: registered in the asset registry as ${mapping.contract.ticker}`);
  }

  /** Retry registry registration for any bridged asset the registry does not
   *  actually have. The local `registered` flag alone is NOT proof: the
   *  registry can be redeployed or purged out from under us (it has been,
   *  which silently stripped the Ethereum-leg assets of their labels), so
   *  each pass consults the registry's own index and re-registers whatever is
   *  missing. Assets issued before registry integration have no stored
   *  contract; build one from their recorded metadata so they get a label too
   *  (operator-asserted admin entries, consistent with the admin path). */
  async registerPendingAssets() {
    if (!this.cfg.registryUrl) return;
    let index = null;
    try {
      const res = await fetch(`${this.cfg.registryUrl.replace(/\/$/, "")}/index.minimal.json`, {
        signal: AbortSignal.timeout(15_000),
      });
      if (res.ok) index = await res.json();
    } catch {
      // Registry unreachable: unregistered mappings still retry below, and
      // registered ones are left alone rather than spammed blindly.
    }
    for (const m of Object.values(this.state.data.mappings)) {
      if (m.registered && (!index || index[m.assetId])) continue;
      try {
        if (!m.contract) {
          const isSol = m.chainId === (this.cfg.solChainLabel ?? "solana-devnet");
          m.contract = await this.buildAssetContract(
            { symbol: m.symbol, name: m.name, decimals: m.decimals },
            isSol ? this.cfg.solChainName ?? "Solana devnet" : this.cfg.ethChainName,
            isSol ? ".s" : ".e"
          );
          m.contractHash = contractHash(m.contract);
          this.state.save();
        }
        await this.registerAsset(m);
      } catch (e) {
        this.log(`asset ${m.assetId}: registry retry failed: ${e.message}`);
      }
    }
  }

  /** A mint step failed before anything landed on chain: safe to retry. */
  deferMint(dep, marker, err) {
    delete dep.steps[marker];
    this.scheduleRetry(dep, "mint_retry", err);
  }

  /** Schedule a safe retry with exponential backoff (15 s doubling to one
   *  hour), and give up to the operator only after `retryHours` of trying.
   *  A short node restart or a fee-asset top-up is not a reason for a human
   *  to look at every deposit that happened to be in flight. */
  scheduleRetry(rec, status, err) {
    const now = Date.now();
    rec.attempts = (rec.attempts ?? 0) + 1;
    rec.firstFailureAt ??= new Date(now).toISOString();
    rec.error = err.message;
    const hours = (now - Date.parse(rec.firstFailureAt)) / 3_600_000;
    if (hours > (this.cfg.retryHours ?? 24)) {
      rec.status = "failed_manual";
      delete rec.nextAttemptAt;
    } else {
      rec.status = status;
      const delay = Math.min(15_000 * 2 ** Math.min(rec.attempts - 1, 8), 3_600_000);
      rec.nextAttemptAt = new Date(now + delay).toISOString();
    }
    this.state.save();
    this.log(
      `${rec.tag ?? `deposit #${rec.nonce}`}: ${rec.status === "failed_manual" ? "gave up" : "deferred"} ` +
        `(attempt ${rec.attempts}): ${err.message}`
    );
  }

  /** Whether a record parked for retry is due for another attempt. */
  retryDue(rec) {
    return !rec.nextAttemptAt || Date.parse(rec.nextAttemptAt) <= Date.now();
  }

  /** Is a wallet transaction in the mempool or in a block right now? Throws
   *  when the node cannot answer: "I could not ask" is not "no". */
  async txVisible(txid) {
    try {
      await this.seq.node("getmempoolentry", { txid });
      return true;
    } catch (e) {
      if (e.code !== -5) throw e; // -5: not in the mempool; anything else is an outage
    }
    const gt = await this.seq.call("gettransaction", { txid });
    return gt.confirmations > 0;
  }

  /** The fate of a transaction the wallet just built and broadcast:
   *
   *    "visible"  in the mempool or a block
   *    "absent"   provably neither, and now abandoned, so it can never land
   *    "unknown"  could not be established either way
   *
   *  The wallet can hand back a txid for a transaction the mempool rejected,
   *  so a returned txid is never proof of broadcast. Nor is failing to see it
   *  proof of absence: fifteen seconds of node trouble looks exactly like a
   *  missing transaction. The proof of absence used here is the wallet
   *  ACCEPTING abandontransaction, which it refuses for anything in the
   *  mempool or in a block. Only "absent" makes a retry safe; a retry on
   *  "unknown" is how a mint, a delivery or a burn happens twice. */
  async confirmBroadcast(txid, timeoutMs = this.cfg.broadcastWaitMs ?? 15_000) {
    const t0 = Date.now();
    for (;;) {
      try {
        if (await this.txVisible(txid)) return "visible";
      } catch {
        // an outage; keep asking until the deadline
      }
      if (Date.now() - t0 > timeoutMs) break;
      await new Promise((r) => setTimeout(r, 1000));
    }
    try {
      await this.seq.call("abandontransaction", { txid });
      return "absent";
    } catch {
      try {
        if (await this.txVisible(txid)) return "visible";
      } catch {}
      return "unknown";
    }
  }

  /** Re-examine a transaction whose broadcast was left "unknown": the same
   *  three answers as confirmBroadcast, without waiting. */
  async resolveBroadcast(txid) {
    return this.confirmBroadcast(txid, 0);
  }

  /** Build and sign (but do not broadcast) a burn of `sats` of `assetId`.
   *  When a fee asset is configured the burn pays its fee in that asset, so
   *  the bridge never needs the policy asset. Returns { txid, hex }. */
  async buildBurn(assetId, sats) {
    const amount = satsToAmount(sats);
    // No preset inputs: the any-asset-fee coin selector rejects them, so let
    // the node choose the asset inputs to burn and the fee-asset inputs.
    const base = await this.seq.call("createrawtransaction", {
      inputs: [],
      outputs: [{ burn: amount, asset: assetId }],
    });
    const funded = await this.seq.call("fundrawtransaction", {
      hexstring: base,
      options: this.cfg.seqFeeAsset ? { fee_asset: this.cfg.seqFeeAsset } : {},
    });
    // The wallet gives its change outputs blinding nonces even when receive
    // addresses are transparent, so blind before signing or the node rejects
    // the tx ("output has nonce, but is not blinded").
    const blinded = await this.seq.call("blindrawtransaction", {
      hexstring: funded.hex,
      ignoreblindfail: true,
    });
    const signed = await this.seq.call("signrawtransactionwithwallet", { hexstring: blinded });
    if (!signed.complete) throw new Error("burn transaction signing incomplete");
    const decoded = await this.seq.call("decoderawtransaction", { hexstring: signed.hex });
    return { txid: decoded.txid, hex: signed.hex };
  }

  /** Step 4: send the minted amount to the depositor's Sequentia address. */
  async sendMinted(dep, mapping) {
    const tag = dep.tag ?? `deposit #${dep.nonce}`;
    if (dep.steps.sendTxid) {
      // Delivered already (a re-drive after a crash or a resolved check).
      if (dep.status !== "minted") this.finishSend(dep, dep.steps.sendTxid);
      return;
    }
    if (dep.steps.pendingSend) {
      // A previous send was started and never settled. Sending again without
      // knowing its fate is how a user gets paid twice.
      if (dep.steps.sendCandidate) this.markUnresolved(dep, "an earlier delivery is still unresolved");
      else {
        dep.status = "failed_manual";
        dep.error = "an earlier delivery was interrupted before its txid was recorded";
        this.state.save();
        this.log(`${tag}: ${dep.error}; parked for the operator`);
      }
      return;
    }
    dep.steps.pendingSend = true;
    this.state.save();
    let sendTxid;
    try {
      // With Sequentia's any-asset fees the wallet defaults the fee to the
      // asset being sent (a bridged asset the node has no exchange rate for),
      // so pin the fee to the asset the operator wallet holds for fees.
      sendTxid = await this.seq.call("sendtoaddress", {
        address: dep.seqAddress,
        amount: satsToAmount(dep.sats),
        assetlabel: mapping.assetId,
        ...(this.cfg.seqFeeAsset ? { fee_asset_label: this.cfg.seqFeeAsset } : {}),
      });
    } catch (e) {
      if (typeof e.code === "number") {
        // A JSON-RPC error means the node rejected the send outright, so
        // nothing went out: safe to retry (e.g. the mint output is not yet
        // spendable, or the fee asset needs a top-up). Ambiguous failures
        // (network errors) keep the marker and halt for the operator instead.
        delete dep.steps.pendingSend;
        this.scheduleRetry(dep, "send_retry", e);
        return;
      }
      throw e;
    }
    dep.steps.sendCandidate = { txid: sendTxid };
    this.state.save();
    // Never mark a deposit delivered until the send is actually relayed: the
    // wallet can return a txid for a transaction the mempool rejected.
    const fate = await this.confirmBroadcast(sendTxid);
    if (fate === "absent") {
      delete dep.steps.pendingSend;
      delete dep.steps.sendCandidate;
      this.scheduleRetry(dep, "send_retry", new Error("send transaction never reached the mempool"));
      return;
    }
    if (fate === "unknown") {
      this.markUnresolved(dep, `could not establish whether delivery ${sendTxid} was broadcast`);
      return;
    }
    this.finishSend(dep, sendTxid);
    this.log(`${tag}: sent ${satsToAmount(dep.sats)} ${mapping.symbol} in ${sendTxid}`);
  }

  /** Record a confirmed delivery. */
  finishSend(dep, txid) {
    delete dep.steps.pendingSend;
    delete dep.steps.sendCandidate;
    dep.steps.sendTxid = txid;
    dep.status = "minted";
    dep.deliveredAt = new Date().toISOString();
    delete dep.error;
    delete dep.nextAttemptAt;
    delete dep.unresolvedSince;
    this.state.save();
  }

  /** Retry deposits that failed at a safely retryable point, and settle
   *  those whose last chain write is unresolved. */
  async retryDeposits() {
    for (const dep of Object.values(this.state.data.deposits)) {
      await this.redriveDeposit(dep, (d) => this.mintDeposit(d), (d, e) => this.mintFailed(d, e));
    }
  }

  /** Shared by both deposit legs: `mint` runs the leg's idempotent mint flow,
   *  `onError` applies its failure split. */
  async redriveDeposit(dep, mint, onError) {
    const tag = dep.tag ?? `deposit #${dep.nonce}`;
    try {
      if (dep.status === "unresolved") {
        if (!(await this.resolveUnresolved(dep))) return;
      }
      if (dep.status === "send_retry") {
        if (!this.retryDue(dep)) return;
        // Minting already happened; only the send to the user is outstanding.
        const mapping = Object.values(this.state.data.mappings).find((m) => m.assetId === dep.assetId);
        if (!mapping) throw new Error(`no mapping for ${dep.assetId}`);
        await this.sendMinted(dep, mapping);
        return;
      }
      if (dep.status !== "mint_retry" || !this.retryDue(dep)) return;
      dep.status = "minting";
      this.state.save();
      await mint(dep);
    } catch (e) {
      if (dep.status === "minting") onError(dep, e);
      else this.log(`${tag}: retry failed: ${e.message}`);
    }
  }

  /** The Ethereum leg's failure split: nothing irreversible in flight means a
   *  safe retry; a dangling marker with no recorded txid means the operator. */
  mintFailed(dep, e) {
    this.log(`${dep.tag ?? `deposit #${dep.nonce}`}: mint failed: ${e.message}`);
    const st = dep.steps ?? {};
    if (st.pendingIssue || st.pendingMint || st.pendingSend) {
      if (st.issueCandidate || st.mintCandidate || st.sendCandidate) this.markUnresolved(dep, e.message);
      else {
        dep.status = "failed_manual";
        dep.error = e.message;
        this.state.save();
      }
      return;
    }
    this.scheduleRetry(dep, "mint_retry", e);
  }

  /** Pay back deposits whose Sequentia leg cannot happen. Idempotent via the
   *  vault's processedRedemptions guard keyed by a deterministic refund id. */
  async processRefunds() {
    for (const dep of Object.values(this.state.data.deposits)) {
      if (dep.status !== "refund_pending" && dep.status !== "refunding") continue;
      const id = refundId(this.cfg.ethChainId, dep.nonce, dep.key === dep.nonce ? null : dep.vault);
      // Refund out of the vault that took the deposit: no other vault holds
      // escrow for it.
      const vault = this.eth.vaultFor(dep.vault);
      const tag = `deposit #${dep.nonce}`;
      try {
        if (await vault.processedRedemptions(id)) {
          dep.status = "refunded";
          dep.refundTxHash ??= dep.ethTx?.hash ?? null;
          delete dep.ethTx;
          this.state.save();
          this.log(`${tag}: refunded (${dep.refundReason})`);
          continue;
        }
        if (dep.status === "refunding") {
          if ((await this.settleSentTx(dep, tag)) === "wait") continue;
        }
        const tokenAddr = dep.token === "eth" ? ethers.ZeroAddress : dep.token;
        dep.status = "refunding";
        this.state.save();
        const r = await this.payOut(dep, vault, [tokenAddr, dep.from, dep.amountUnits, id]);
        if (r.paid) {
          dep.status = "refunded";
          dep.refundTxHash = r.paid;
          delete dep.ethTx;
          delete dep.waiting;
          this.state.save();
          this.log(`${tag}: refunded (${dep.refundReason}) in ${r.paid}`);
        } else if (r.revert) {
          await this.parkRevert(dep, r.revert, vault, tokenAddr, dep.amountUnits, "refund", tag);
        }
      } catch (e) {
        this.log(`${tag}: refund attempt failed: ${e.message}`);
      }
    }
  }

  /** Send one vault payout and report what happened: { paid: hash } once it
   *  mined, { revert: name } when the vault refuses it, {} when it is sent
   *  but not mined yet (the caller's record holds it as `ethTx`). */
  async payOut(rec, vault, args) {
    try {
      const receipt = await this.eth.sendAndWait(vault, "release", args, (sent) => {
        rec.ethTx = sent;
        this.state.save();
      });
      if (!receipt) return {};
      if (receipt.status === 1) return { paid: receipt.hash };
      return {}; // mined but reverted: re-examined from the on-chain guard next tick
    } catch (e) {
      if (e?.code === "CALL_EXCEPTION" && typeof e.data === "string" && e.data.length >= 10) {
        return { revert: this.eth.revertName(e.data) ?? e.data };
      }
      throw e;
    }
  }

  /** A payout that was sent and not yet seen to mine. Returns "wait" while it
   *  may still mine (replacing it at the same nonce once it has been stuck
   *  for `ethStuckMinutes`), or "resend" once it provably never will. The
   *  caller has already checked the on-chain replay guard, which is what
   *  makes a resend safe: the vault refuses to pay the same id twice. */
  async settleSentTx(rec, tag) {
    if (!rec.ethTx) return "resend";
    const st = await this.eth.sentTxState(rec.ethTx);
    if (st === "pending") {
      const minutes = (Date.now() - Date.parse(rec.ethTx.sentAt)) / 60_000;
      if (minutes >= (this.cfg.ethStuckMinutes ?? 10)) {
        rec.ethTx = await this.eth.replaceStuck(rec.ethTx);
        this.state.save();
        this.log(`${tag}: transaction stuck for ${Math.floor(minutes)} min; replaced at nonce ${rec.ethTx.nonce} (${rec.ethTx.hash})`);
      }
      return "wait";
    }
    // Mined-and-reverted, dropped, or displaced by another transaction of
    // ours: none of these paid (the guard said so), so send it again.
    this.log(`${tag}: earlier transaction ${rec.ethTx.hash} ${st}; sending again`);
    delete rec.ethTx;
    this.state.save();
    return "resend";
  }

  /** Decide what a vault refusal means instead of filing every revert as a
   *  manual case: a pause or a short vault is something to wait out, a
   *  payout already made is a success, and only a recipient that cannot take
   *  the funds needs a person. */
  async parkRevert(rec, name, vault, tokenAddr, amountUnits, kind, tag) {
    const isRefund = kind === "refund";
    delete rec.ethTx;
    const wait = (why, status) => {
      rec.status = status;
      rec.waiting = why;
      this.state.save();
      this.log(`${tag}: ${why}; waiting`);
    };
    if (name === "AlreadyReleased") {
      rec.status = isRefund ? "refunded" : "released";
      this.state.save();
      return;
    }
    if (name === "ReleasesArePaused") {
      return wait("releases are paused on the vault", isRefund ? "refund_pending" : "release_paused");
    }
    let short = name === "InsufficientVaultBalance";
    if (!short && (name === "EtherTransferFailed" || name === "TokenTransferFailed")) {
      // An older vault reports a short balance and a refusing recipient the
      // same way; the balance tells them apart.
      const held = await this.eth.vaultHolding(vault, tokenAddr);
      short = held < BigInt(amountUnits);
    }
    if (short) {
      return wait("the vault does not hold enough of this token right now", isRefund ? "refund_pending" : "awaiting_liquidity");
    }
    rec.status = isRefund ? "refund_failed_manual" : "release_failed_manual";
    rec.error =
      name === "EtherTransferFailed" || name === "TokenTransferFailed"
        ? "the recipient address does not accept this payout"
        : `the vault refused the payout (${name})`;
    this.state.save();
    this.log(`${tag}: ${rec.error}; flagged for the operator`);
  }

  // ================= Sequentia -> Ethereum =================

  /** Create a redemption intent: a fresh Sequentia address bound to an
   *  Ethereum destination. Anything bridged that arrives there is redeemed. */
  async createRedeemIntent(ethAddress) {
    const checksummed = ethers.getAddress(ethAddress); // throws on invalid
    // One redemption address per Ethereum destination: asking again returns
    // the same one, so a user who comes back finds their redemption instead
    // of a fresh, empty address.
    for (const [addr, it] of Object.entries(this.state.data.redeemIntents)) {
      if (it.ethAddress === checksummed) return addr;
    }
    const seqAddress = await this.seq.call("getnewaddress", { label: "compages-redeem" });
    this.state.data.redeemIntents[seqAddress] = {
      ethAddress: checksummed,
      createdAt: new Date().toISOString(),
    };
    this.state.save();
    this.log(`redeem intent: ${seqAddress} -> ${checksummed}`);
    return seqAddress;
  }

  async processRedemptions() {
    const s = this.state.data;
    let res;
    try {
      res = await this.seq.call("listsinceblock", {
        blockhash: s.seqLastBlockHash ?? undefined,
        target_confirmations: this.cfg.seqConfirmations,
        include_watchonly: true,
      });
    } catch (e) {
      if (e.code !== -5) throw e;
      // The cursor block fell out of the node's main index (deep
      // Bitcoin-anchor reorgs do this on testnet4). Rescan the whole wallet
      // once: redemption records are keyed by txid:vout, so nothing is
      // double-processed, and the cursor is re-seeded from this response.
      this.log(`redemption scan cursor ${s.seqLastBlockHash} is gone (reorged); rescanning from the start`);
      res = await this.seq.call("listsinceblock", {
        target_confirmations: this.cfg.seqConfirmations,
        include_watchonly: true,
      });
    }

    for (const tx of res.transactions) {
      if (tx.category !== "receive") continue;
      const intent = s.redeemIntents[tx.address];
      const solIntent = s.solRedeemIntents?.[tx.address];
      if (!intent && !solIntent) continue;
      if (tx.confirmations < 1) continue; // needs a block before we can read its anchor
      const key = `${tx.txid}:${tx.vout}`;

      if (intent) {
        if (s.redemptions[key]) continue;
        const rec = {
          key,
          txid: tx.txid,
          vout: tx.vout,
          seqAddress: tx.address,
          ethAddress: intent.ethAddress,
          assetId: tx.asset,
          sats: amountToSats(tx.amount).toString(),
          status: "awaiting_finality",
          createdAt: new Date().toISOString(),
        };
        s.redemptions[key] = rec;
        this.state.save();
        await this.handleRedemption(rec);
      } else {
        if (s.solRedemptions[key]) continue;
        const rec = {
          key,
          txid: tx.txid,
          vout: tx.vout,
          seqAddress: tx.address,
          solAddress: solIntent.solAddress,
          assetId: tx.asset,
          sats: amountToSats(tx.amount).toString(),
          status: "awaiting_finality",
          createdAt: new Date().toISOString(),
        };
        s.solRedemptions[key] = rec;
        this.state.save();
        // Errors park the record in awaiting_finality; advanceSolRedemptions
        // re-drives it every tick, so nothing is lost by continuing the scan.
        await this.handleSolRedemption(rec).catch((e) =>
          this.log(`sol redemption ${key}: ${e.message}`)
        );
      }
    }

    // res.lastblock is the hash at target_confirmations depth: anything after
    // it reappears on the next call, so shallower entries are never lost.
    s.seqLastBlockHash = res.lastblock;
    this.state.save();
  }

  /** Re-evaluate redemptions parked before release, so one gets sent the tick
   *  after its blocker clears without waiting for a new redemption to arrive:
   *  a burn that has since accrued enough Bitcoin-anchor depth
   *  (awaiting_finality), or a short chain whose escrow a later deposit has
   *  since refilled (awaiting_liquidity). handleRedemption re-checks both gates
   *  and is idempotent, so re-driving a still-blocked record just re-parks it. */
  async advanceRedemptions() {
    for (const rec of Object.values(this.state.data.redemptions)) {
      if (!["awaiting_finality", "awaiting_liquidity", "halted"].includes(rec.status)) continue;
      try {
        await this.handleRedemption(rec);
      } catch (e) {
        this.log(`redemption ${rec.key}: advance failed: ${e.message}`);
      }
    }
  }

  /** Finality of a burn for the purpose of an IRREVERSIBLE Ethereum release.
   *
   *  Bitcoin anchoring is supreme on Sequentia: a block whose Bitcoin anchor is
   *  reorged is discarded in real time, regardless of how many Sequentia blocks
   *  sit on top. So the burn is only final once its Bitcoin anchor is buried
   *  deep enough that a Bitcoin reorg cannot orphan it — a Sequentia block count
   *  is NOT a sufficient measure. Depth = (node's current anchor height) minus
   *  (the burn block's anchor height); it advances only as Bitcoin advances,
   *  which is exactly the finality we want. Also requires the node's anchor
   *  status to be "ok" and, when the node reports it, the block to be
   *  committee-certified (immediately final on the Sequentia axis).
   *
   *  On a chain without Bitcoin anchoring (e.g. regtest) there is no anchor to
   *  wait on, so it falls back to a Sequentia-confirmation count. */
  async burnFinality(txid, blockhash) {
    const gt = await this.seq.call("gettransaction", { txid });
    // A reorged/conflicted burn shows <1 (often negative) confirmations: never
    // final, so a reverted burn can never trigger a release.
    if (!gt.blockhash || gt.confirmations < 1) {
      return { final: false, reason: `burn not confirmed (${gt.confirmations} conf)`, depth: 0, need: null, kind: null };
    }

    let anchor = null;
    try {
      anchor = await this.seq.node("getanchorstatus");
    } catch {
      anchor = null; // chain built without Bitcoin anchoring
    }
    if (!anchor || anchor.validateanchor === false) {
      const need = this.cfg.seqConfirmations ?? 6;
      return {
        final: gt.confirmations >= need,
        reason: `no Bitcoin anchoring; ${gt.confirmations}/${need} Sequentia confirmations`,
        depth: gt.confirmations,
        need,
        kind: "sequentia",
      };
    }
    if (anchor.anchorstatus !== "ok") {
      return { final: false, reason: `node anchor status is ${anchor.anchorstatus}`, depth: null, need: null, kind: "bitcoin" };
    }

    const hdr = await this.seq.call("getblockheader", {
      blockhash: gt.blockhash,
      verbose: true,
    });
    // poscertified is feature-detected: enforce it only when the node reports it
    // (null on nodes/chains that predate committee certification).
    const need = this.cfg.btcAnchorConfirmations ?? 3;
    if (hdr.poscertified === false) {
      return { final: false, reason: "burn block not yet committee-certified", depth: 0, need, kind: "bitcoin" };
    }
    const depth = Number(anchor.anchorheight) - Number(hdr.anchorheight);
    return {
      final: depth >= need,
      reason: `${depth}/${need} Bitcoin-anchor confirmations`,
      depth: Math.max(0, depth),
      need,
      kind: "bitcoin",
    };
  }

  async handleRedemption(rec) {
    const s = this.state.data;
    const mapping = Object.values(s.mappings).find((m) => m.assetId === rec.assetId);
    if (!mapping) {
      rec.status = "ignored_unknown_asset";
      this.state.save();
      this.log(`redemption ${rec.key}: asset ${rec.assetId} is not a bridged asset, ignoring`);
      return;
    }
    // Release only on a chain this asset is actually backed on. For an
    // ordinary asset that is its single origin chain, exactly as before; a
    // unified asset is backed on several, and answers for each of them.
    const src = sourceForChain(mapping, this.cfg.ethChainId);
    if (!src) {
      // Bridged from another chain (e.g. SOL.s sent to an Ethereum redemption
      // address): the vault holds nothing to release for it. Park it for the
      // operator; it must never reach the Ethereum release path.
      rec.status = "ignored_wrong_network";
      this.state.save();
      this.log(`redemption ${rec.key}: asset ${rec.assetId} is not Ethereum-bridged, parked for the operator`);
      return;
    }
    rec.tokenKey = src.tokenKey;
    if (this.haltedReason(mapping.assetId, "release")) {
      rec.status = "halted";
      rec.waiting = this.haltedReason(mapping.assetId, "release");
      this.state.save();
      return;
    }
    // Pin the vault holding this source's escrow now, so a later config change
    // cannot redirect an in-flight release to a vault that never held it.
    rec.vault = src.vault ?? this.cfg.vaultAddress ?? null;
    rec.symbol = mapping.symbol;

    const units = atomsToUnits(rec.sats, src.decimals, mapping.precision);
    if (units === 0n) {
      rec.status = "dust_ignored";
      this.state.save();
      this.log(`redemption ${rec.key}: amount too small to represent on Ethereum, needs manual handling`);
      return;
    }
    rec.amountUnits = units.toString();

    // Per-escrow solvency: global backing can be sound while THIS chain's
    // escrow is short, because a unified asset lets users deposit on one chain
    // and redeem on another. Wait for the operator to rebalance rather than
    // sending a release that would revert. Only sources that actually keep an
    // escrow ledger are gated; an ordinary bridged asset never had one, and
    // its release is checked against the vault balance as before.
    const escrowed = src.escrowedUnits === undefined ? null : BigInt(src.escrowedUnits);
    if (escrowed !== null && escrowed < units) {
      rec.status = "awaiting_liquidity";
      this.state.save();
      this.log(
        `redemption ${rec.key}: ${src.tokenKey} escrow holds ${escrowed}, needs ${units}; awaiting rebalance`
      );
      return;
    }

    // Gate the irreversible release on the burn's Bitcoin-anchor finality, not
    // a Sequentia block count (anchoring is supreme; see burnFinality).
    const fin = await this.burnFinality(rec.txid);
    rec.finality = fin.reason;
    rec.finalityProgress = { depth: fin.depth, need: fin.need, kind: fin.kind };
    if (!fin.final) {
      rec.status = "awaiting_finality";
      this.state.save();
      this.log(`redemption ${rec.key}: awaiting finality — ${fin.reason}`);
      return;
    }

    rec.status = "new";
    this.state.save();
    await this.releaseRedemption(rec, mapping);
  }

  async releaseRedemption(rec, mapping) {
    const id = redemptionIdOf(this.cfg.seqChainLabel, rec.txid, rec.vout);
    rec.redemptionId = id;
    // Pay out of the vault holding THIS asset's escrow on this chain.
    const vault = this.eth.vaultFor(rec.vault ?? sourcesOf(mapping)[rec.tokenKey]?.vault);

    if (rec.status === "new") {
      if (await vault.processedRedemptions(id)) {
        rec.status = "released"; // paid in a previous life; continue to destroy
        this.debitEscrow(mapping, rec.tokenKey, rec.amountUnits, rec);
        this.state.save();
      } else {
        // Anchoring is supreme: re-verify the burn is STILL final immediately
        // before the irreversible vault release. A crash or RPC outage can put
        // an arbitrarily long gap between the first verdict and this call, and
        // a deep Bitcoin reorg in that gap must park the release, not pay it.
        const fin = await this.burnFinality(rec.txid);
        if (!fin.final) {
          rec.finality = fin.reason;
          rec.status = "awaiting_finality";
          this.state.save();
          this.log(`redemption ${rec.key}: burn no longer final (${fin.reason}); release parked`);
          return;
        }
        rec.status = "releasing";
        this.state.save();
        // The token to release is the ROUTED source's token on this chain,
        // never whatever token some other source of the same asset uses.
        const ethSrc = sourcesOf(mapping)[rec.tokenKey];
        const tokenAddr = rec.tokenKey.endsWith(":eth")
          ? ethers.ZeroAddress
          : ethSrc?.token ?? mapping.token;
        const tag = `redemption ${rec.key}`;
        const r = await this.payOut(rec, vault, [tokenAddr, rec.ethAddress, rec.amountUnits, id]);
        if (r.paid) {
          rec.releaseTxHash = r.paid;
          rec.status = "released";
          delete rec.ethTx;
          delete rec.waiting;
          this.debitEscrow(mapping, rec.tokenKey, rec.amountUnits, rec);
          this.state.save();
          this.log(`${tag}: released ${rec.amountUnits} units of ${mapping.symbol} to ${rec.ethAddress} in ${r.paid}`);
        } else if (r.revert) {
          await this.parkRevert(rec, r.revert, vault, tokenAddr, rec.amountUnits, "redemption", tag);
          if (rec.status === "released") this.debitEscrow(mapping, rec.tokenKey, rec.amountUnits, rec);
        } else {
          this.log(`${tag}: release sent (${rec.ethTx?.hash}), not mined yet`);
        }
      }
    }

    if (["released", "destroy_pending", "destroying"].includes(rec.status)) {
      await this.destroyRedeemed(rec, mapping, mapping.symbol);
    }
  }

  /** Re-drive every redemption between "final" and "done": releases that
   *  were sent but not yet seen to mine (or were interrupted), releases
   *  waiting out a vault pause, and burns still owed after a payout. */
  async retryRedemptions() {
    const s = this.state.data;
    const ACTIVE = ["new", "releasing", "release_paused", "released", "destroy_pending", "destroying"];
    for (const rec of Object.values(s.redemptions)) {
      if (!ACTIVE.includes(rec.status)) continue;
      const mapping = Object.values(s.mappings).find((m) => m.assetId === rec.assetId);
      if (!mapping) continue;
      const tag = `redemption ${rec.key}`;
      try {
        if (rec.status === "releasing" || rec.status === "release_paused" || rec.status === "new") {
          // The on-chain guard is the authority on whether the payout landed.
          const vault = this.eth.vaultFor(rec.vault);
          const id = rec.redemptionId ?? redemptionIdOf(this.cfg.seqChainLabel, rec.txid, rec.vout);
          if (await vault.processedRedemptions(id)) {
            rec.status = "released";
            rec.releaseTxHash ??= rec.ethTx?.hash ?? null;
            delete rec.ethTx;
            delete rec.waiting;
            this.debitEscrow(mapping, rec.tokenKey, rec.amountUnits, rec);
            this.state.save();
          } else if (rec.status === "releasing") {
            if ((await this.settleSentTx(rec, tag)) === "wait") continue;
            rec.status = "new";
            this.state.save();
          } else {
            rec.status = "new";
          }
        }
        await this.releaseRedemption(rec, mapping);
      } catch (e) {
        this.log(`${tag}: retry failed: ${e.message}`);
      }
    }
  }

  /** Startup pass: recover deposits stranded mid-mint by a crash. A record
   *  persisted as "minting" can never be re-entered by the scan (its signature
   *  or event is already marked seen), so convert it: no pending marker means
   *  nothing irreversible was in flight (safe to retry); a marker means a
   *  chain write may have landed without its acknowledgment (operator review,
   *  per the crash-safety contract in the file header). */
  reconcileInterrupted() {
    const s = this.state.data;
    for (const dep of [...Object.values(s.deposits), ...Object.values(s.solDeposits ?? {})]) {
      if (dep.status !== "minting") continue;
      const st = dep.steps ?? {};
      const marker = st.pendingIssue || st.pendingMint || st.pendingSend;
      const candidate = st.issueCandidate || st.mintCandidate || st.sendCandidate;
      if (!marker) {
        dep.status = "mint_retry";
        dep.error = "interrupted before any irreversible step";
      } else if (candidate) {
        // The transaction is known, so the chain can say whether it landed.
        dep.status = "unresolved";
        dep.unresolvedSince ??= new Date().toISOString();
        dep.error = "interrupted with a recorded transaction in flight";
      } else {
        dep.status = "failed_manual";
        dep.error = "interrupted mid-step before its transaction id was recorded";
      }
      this.state.save();
      this.log(`${dep.tag ?? `deposit #${dep.nonce}`}: ${dep.error}; recovered at startup as ${dep.status}`);
    }
  }

  // ================= Solana <-> Sequentia =================
  //
  // The Solana leg has no vault contract: custody is the operator's treasury
  // account, and both directions are intent-based, like the Ethereum
  // redemption flow. A wrap intent binds a fresh operator-derived deposit
  // address to a Sequentia destination; whatever lands there is minted as
  // SOL.s (through the same issue-or-reissue machinery as the Ethereum leg)
  // and swept to the treasury. An unwrap intent binds a fresh Sequentia
  // address to a Solana destination; SOL.s arriving there is released from
  // the treasury once the burn is final under Bitcoin anchoring, then
  // destroyed.
  //
  // Replay guard without a contract: a Solana transaction's id is its fee
  // payer's signature, known before broadcast (sol.js transferTx). Every
  // outbound transfer's signature and blockhash expiry height are persisted
  // BEFORE sending, so after any crash the chain itself answers whether the
  // transfer landed, may still land, or can never land (solTxResolved).

  solTokenKey() {
    return `${this.cfg.solChainLabel ?? "solana-devnet"}:sol`;
  }

  /** Create a wrap intent: a fresh Solana deposit address bound to a validated
   *  Sequentia destination. Validation happens here, before the user sends
   *  anything, so the deposit path needs no refund machinery. Idempotent per
   *  destination: re-requesting for the same Sequentia address revives the
   *  existing intent with a fresh watch window, which is also the recovery
   *  path for a deposit sent after the old window expired. */
  async createSolWrapIntent(seqAddress) {
    const v = await this.seq.node("validateaddress", { address: seqAddress });
    if (!v.isvalid) {
      throw Object.assign(new Error("invalid Sequentia address"), { badRequest: true });
    }
    const s = this.state.data;
    for (const [addr, it] of Object.entries(s.solWrapIntents)) {
      if (it.seqAddress === seqAddress) {
        it.createdAt = new Date().toISOString();
        this.state.save();
        this.log(`sol wrap intent ${it.index}: revived ${addr} -> ${seqAddress}`);
        return addr;
      }
    }
    // Every intent is polled for days, so an unbounded number of them is an
    // unbounded RPC bill; past the cap, new ones wait for old ones to expire.
    const watched = Object.entries(s.solWrapIntents).filter(([a, it]) => this.solIntentWatched(a, it)).length;
    if (watched >= (this.cfg.solMaxWatchedIntents ?? 1000)) {
      throw Object.assign(new Error("the bridge is watching too many deposit addresses right now; try again later"), {
        busy: true,
      });
    }
    const index = s.solIntentIndex ?? 0;
    s.solIntentIndex = index + 1;
    const kp = this.sol.depositKeypair(index);
    s.solWrapIntents[kp.address] = {
      index,
      seqAddress,
      seen: [],
      createdAt: new Date().toISOString(),
    };
    this.state.save();
    this.log(`sol wrap intent ${index}: ${kp.address} -> ${seqAddress}`);
    return kp.address;
  }

  /** An intent is polled while young, or while any of its deposits is still in
   *  flight, so RPC load stays bounded as intents accumulate. A deposit sent
   *  to an expired intent is recovered by requesting a wrap for the same
   *  Sequentia destination again: createSolWrapIntent revives the intent (same
   *  address) instead of allocating a new one. */
  solIntentWatched(address, intent) {
    const days = this.cfg.solWatchDays ?? 7;
    if (Date.now() - Date.parse(intent.createdAt) < days * 86_400_000) return true;
    const TERMINAL = new Set(["minted", "dust_manual", "failed_manual"]);
    return Object.values(this.state.data.solDeposits).some(
      (d) => d.address === address && !TERMINAL.has(d.status)
    );
  }

  /** Scan watched wrap intents for finalized inbound transfers and mint them:
   *  native SOL from the intent address's own signature stream, and any SPL
   *  token from the streams of the token accounts the address owns (a token
   *  transfer to an existing token account does not reference the owner, so
   *  scanning only the owner would miss it). */
  async processSolDeposits() {
    if (!this.sol) return;
    await this.sol.ensureCluster();
    const s = this.state.data;
    for (const [address, intent] of Object.entries(s.solWrapIntents)) {
      if (!this.solIntentWatched(address, intent)) continue;
      await this.scanSolDeposits(address, intent, {
        scanAddress: address,
        mint: "sol",
        decimals: 9,
      });
      let tokenAccounts;
      try {
        tokenAccounts = await this.sol.tokenAccountsByOwner(address);
      } catch (e) {
        this.log(`sol intent ${address}: token account scan failed: ${e.message}`);
        continue;
      }
      for (const ta of tokenAccounts) {
        await this.scanSolDeposits(address, intent, {
          scanAddress: ta.address,
          mint: ta.mint,
          decimals: ta.decimals,
          tokenProgram: ta.tokenProgram,
        });
      }
    }
  }

  /** Scan one signature stream for new inbound transfers and mint them.
   *  Cursor and seen bookkeeping are per stream; deposits are keyed by
   *  (signature, stream) since one transaction can touch several streams.
   *  Rescans are idempotent; our own sweeps show a non-positive delta and are
   *  remembered but skipped. The cursor only advances after a complete pass
   *  with no gaps, so a burst of traffic can never push a deposit out of the
   *  scan window. */
  async scanSolDeposits(address, intent, { scanAddress, mint, decimals, tokenProgram }) {
    const s = this.state.data;
    intent.scans ??= {};
    // Pre-SPL records kept the native cursor directly on the intent; migrate.
    if (intent.seen && !intent.scans[address]) {
      intent.scans[address] = { seen: intent.seen, until: intent.until ?? null };
      delete intent.seen;
      delete intent.until;
      this.state.save();
    }
    const cursor = (intent.scans[scanAddress] ??= { seen: [], until: null });
    let scan;
    try {
      scan = await this.sol.signaturesFor(scanAddress, cursor.until ?? undefined);
    } catch (e) {
      this.log(`sol intent ${address}: signature scan of ${scanAddress} failed: ${e.message}`);
      return;
    }
    if (!scan.complete) {
      this.log(`sol intent ${address}: scan of ${scanAddress} truncated at ${scan.sigs.length}; continuing next tick`);
    }
    let gaps = false;
    for (const si of [...scan.sigs].reverse()) { // oldest first
      if (cursor.seen.includes(si.signature)) continue;
      let units = 0n;
      if (!si.err) {
        try {
          units =
            mint === "sol"
              ? await this.sol.receivedLamports(si.signature, scanAddress)
              : await this.sol.receivedTokenAmount(si.signature, scanAddress);
        } catch (e) {
          // Not marked seen: retried on the next scan pass.
          this.log(`sol intent ${address}: tx ${si.signature} fetch failed: ${e.message}`);
          gaps = true;
          continue;
        }
      }
      cursor.seen.push(si.signature);
      if (units === 0n) {
        this.state.save(); // a sweep of ours, or a failed tx: remember and skip
        continue;
      }
      const dep = {
        sig: si.signature,
        tag: `sol deposit ${si.signature.slice(0, 8)}`,
        address,
        scanAddress,
        mint,
        decimals,
        ...(tokenProgram ? { tokenProgram } : {}),
        seqAddress: intent.seqAddress,
        amountUnits: units.toString(),
        status: "minting",
        steps: {},
        createdAt: new Date().toISOString(),
      };
      s.solDeposits[`${si.signature}:${scanAddress}`] = dep;
      this.state.save();
      this.log(`${dep.tag}: ${units} units of ${mint} at ${address} -> ${intent.seqAddress}`);
      await this.mintSolDeposit(dep).catch((e) => this.solMintFailed(dep, e));
    }
    if (scan.complete && !gaps && scan.sigs.length) {
      cursor.until = scan.sigs[0].signature;
      this.state.save();
    }
  }

  /** Mirror of handleDeposit's failure split: nothing irreversible yet means
   *  retry next tick; a dangling marker means halt for the operator. */
  solMintFailed(dep, e) {
    if (dep.status === "minting") this.mintFailed(dep, e);
  }

  async mintSolDeposit(dep) {
    const s = this.state.data;
    const chainLabel = this.cfg.solChainLabel ?? "solana-devnet";
    const isNative = !dep.mint || dep.mint === "sol"; // pre-SPL records lack mint
    const tokenKey = isNative ? this.solTokenKey() : `${chainLabel}:${dep.mint}`;
    const existing = this.mappingFor(tokenKey);
    const existingSrc = existing ? sourcesOf(existing)[tokenKey] : null;
    let meta;
    if (isNative) {
      meta = { symbol: "SOL", name: "SOL", decimals: 9 };
    } else if (existingSrc?.decimals !== undefined) {
      // A configured source states its own decimals, which is what a unified
      // asset needs: each chain's token carries its own.
      meta = { symbol: existing.symbol, name: existing.name, decimals: existingSrc.decimals };
    } else {
      // Metadata lookup failures throw and defer the mint; the deposit is
      // never lost to a flaky metadata fetch.
      meta = await this.sol.tokenMetadata(dep.mint);
    }
    const units = BigInt(dep.amountUnits ?? dep.lamports); // lamports: pre-SPL records
    const sats = unitsToAtoms(units, meta.decimals, existing?.precision);
    if (sats === 0n) {
      // Not representable on Sequentia (a mint with more than 8 decimals can
      // floor a tiny amount to zero). Funds are swept; flag for the operator.
      dep.status = "dust_manual";
      this.state.save();
      return;
    }
    const minted = Boolean(dep.steps.issueTxid || dep.steps.mintTxid);
    const already = existing && !minted ? BigInt(existing.mintedSats) : 0n;
    if (!minted && already + sats > SEQ_MAX_SATS) {
      dep.status = "failed_manual";
      dep.error = "would exceed the Sequentia per-asset amount cap";
      this.state.save();
      return;
    }
    dep.sats = sats.toString();
    if (existing && this.haltedReason(existing.assetId, "mint")) return this.holdForHalt(dep, existing.assetId);
    const mapping = await this.ensureMintedMapping(dep, tokenKey, sats, {
      chainId: chainLabel,
      token: isNative ? "sol" : dep.mint,
      meta: { symbol: meta.symbol, name: meta.name, decimals: meta.decimals },
      chainName: this.cfg.solChainName ?? "Solana devnet",
      tickerSuffix: ".s",
    });
    if (!mapping) return; // deferred or halted; status/markers already recorded
    if (!isNative && (dep.tokenProgram || meta.tokenProgram)) {
      // The token program is a per-source fact (sweeps and releases need it),
      // so it belongs on the source, not on an asset that may span chains.
      const src = sourcesOf(mapping)[tokenKey];
      if (src && !src.tokenProgram) {
        src.tokenProgram = dep.tokenProgram ?? meta.tokenProgram;
        this.state.save();
      }
      if (!mapping.sources && !mapping.tokenProgram) {
        mapping.tokenProgram = dep.tokenProgram ?? meta.tokenProgram;
        this.state.save();
      }
    }
    dep.assetId = mapping.assetId;
    this.creditEscrow(mapping, tokenKey, units, dep);
    this.state.save();
    await this.sendMinted(dep, mapping);
  }

  /** Retry Solana deposits stuck at a safely retryable point. */
  async retrySolDeposits() {
    if (!this.sol) return;
    await this.sol.ensureCluster();
    const s = this.state.data;
    for (const dep of Object.values(s.solDeposits)) {
      await this.redriveDeposit(dep, (d) => this.mintSolDeposit(d), (d, e) => this.solMintFailed(d, e));
    }
  }

  /** Fate of a recorded outbound transfer: 'landed' (finalized, ok), 'failed'
   *  (executed on chain with an error, so no lamports moved), 'pending' (may
   *  still land), or 'expired' (blockhash expired and the signature unseen, so
   *  it can never land). The height is read BEFORE the status on purpose: a
   *  null status is only meaningful once the chain is provably past the
   *  blockhash's validity, and reading in the other order lets a lagging
   *  status view race a fresh height view into a false 'expired'. Callers
   *  about to rebuild an irreversible payment must additionally demand two
   *  consecutive 'expired' verdicts across ticks (see releaseSolRedemption). */
  async solTransferFate(t) {
    const height = await this.sol.blockHeight();
    const st = await this.sol.signatureStatus(t.signature);
    if (st && st.err) return "failed";
    if (st) return st.confirmationStatus === "finalized" ? "landed" : "pending";
    return height > t.lastValidBlockHeight ? "expired" : "pending";
  }

  /** Sweep deposits into the treasury: lamports, and the balance of every
   *  token account whose mint we have bridged (unbridged mints stay put; spam
   *  tokens are never worth treasury fees and rent). The treasury pays every
   *  fee, so swept amounts arrive whole. Each sweep is signature-guarded like
   *  releases; a lost race costs a fee, never funds — and detection is
   *  signature-based, so sweeping can never hide a deposit from minting. */
  async sweepSolIntents() {
    if (!this.sol) return;
    await this.sol.ensureCluster();
    const s = this.state.data;
    const chainLabel = this.cfg.solChainLabel ?? "solana-devnet";
    for (const [address, intent] of Object.entries(s.solWrapIntents)) {
      if (!this.solIntentWatched(address, intent)) continue;
      try {
        await this.sweepNativeIntent(address, intent);
      } catch (e) {
        this.log(`sol intent ${address}: sweep failed: ${e.message}`);
      }
      let tokenAccounts = [];
      try {
        tokenAccounts = await this.sol.tokenAccountsByOwner(address);
      } catch (e) {
        this.log(`sol intent ${address}: token sweep scan failed: ${e.message}`);
      }
      for (const ta of tokenAccounts) {
        try {
          await this.sweepTokenAccount(address, intent, ta, chainLabel);
        } catch (e) {
          this.log(`sol intent ${address}: sweep of ${ta.address} failed: ${e.message}`);
        }
      }
    }
  }

  async sweepNativeIntent(address, intent) {
    const bal = await this.sol.balance(address);
    // A sweep carries two signatures (treasury + intent) at 5000 lamports
    // each; leave balances that are not clearly worth the 10,000 fee.
    if (bal < 20_000n) return;
    // A pending sweep blocks a new one; any settled fate may proceed (the
    // balance was re-read above, so a landed sweep leaves nothing to take
    // and a false 'expired' costs at most one duplicate fee, never funds).
    if (intent.sweep && (await this.solTransferFate(intent.sweep)) === "pending") return;
    const bh = await this.sol.latestBlockhash();
    const kp = this.sol.depositKeypair(intent.index);
    const { tx, signature } = transferTx({
      feePayer: this.sol.treasury,
      source: kp,
      dest: this.sol.treasury.address,
      lamports: bal,
      recentBlockhash: bh.blockhash,
    });
    intent.sweep = { signature, lastValidBlockHeight: bh.lastValidBlockHeight };
    this.state.save();
    await this.sol.send(tx);
    this.log(`sol intent ${address}: sweeping ${bal} lamports to the treasury (${signature})`);
  }

  async sweepTokenAccount(address, intent, ta, chainLabel) {
    if (ta.amount === 0n) return;
    if (!this.mappingFor(`${chainLabel}:${ta.mint}`)) return; // unbridged mint
    intent.sweeps ??= {};
    const prev = intent.sweeps[ta.address];
    if (prev && (await this.solTransferFate(prev)) === "pending") return;
    // The treasury pays two signatures and, on the first sweep of a mint, rent
    // for its own associated token account; wait rather than bounce on chain.
    const treasuryBal = await this.sol.balance(this.sol.treasury.address);
    if (treasuryBal < 2n * FEE_LAMPORTS + TOKEN_ACCOUNT_RENT_LAMPORTS + RENT_EXEMPT_MIN_LAMPORTS) {
      this.log(`sol intent ${address}: treasury underfunded for a token sweep; waiting`);
      return;
    }
    const treasury = this.sol.treasury;
    const treasuryAta = ataAddress(treasury.address, ta.mint, ta.tokenProgram);
    const kp = this.sol.depositKeypair(intent.index);
    const bh = await this.sol.latestBlockhash();
    const { tx, signature } = buildTx({
      feePayer: treasury,
      signers: [kp],
      recentBlockhash: bh.blockhash,
      instructions: [
        ataCreateIdempotent({
          payer: treasury.address,
          ata: treasuryAta,
          owner: treasury.address,
          mint: ta.mint,
          tokenProgram: ta.tokenProgram,
        }),
        splTransferChecked({
          source: ta.address,
          mint: ta.mint,
          dest: treasuryAta,
          owner: kp.address,
          amount: ta.amount,
          decimals: ta.decimals,
          tokenProgram: ta.tokenProgram,
        }),
      ],
    });
    intent.sweeps[ta.address] = { signature, lastValidBlockHeight: bh.lastValidBlockHeight };
    this.state.save();
    await this.sol.send(tx);
    this.log(`sol intent ${address}: sweeping ${ta.amount} of ${ta.mint} to the treasury (${signature})`);
  }

  /** Create an unwrap intent: a fresh Sequentia address bound to a Solana
   *  destination. SOL.s arriving there is released as SOL from the treasury. */
  async createSolRedeemIntent(solAddress) {
    if (!isSolAddress(solAddress)) {
      throw Object.assign(new Error("invalid Solana address"), { badRequest: true });
    }
    for (const [addr, it] of Object.entries(this.state.data.solRedeemIntents)) {
      if (it.solAddress === solAddress) return addr;
    }
    const seqAddress = await this.seq.call("getnewaddress", { label: "compages-sol-redeem" });
    this.state.data.solRedeemIntents[seqAddress] = {
      solAddress,
      createdAt: new Date().toISOString(),
    };
    this.state.save();
    this.log(`sol redeem intent: ${seqAddress} -> ${solAddress}`);
    return seqAddress;
  }

  async handleSolRedemption(rec) {
    return this.withRecord(`sol:${rec.key}`, () => this.handleSolRedemptionLocked(rec));
  }

  async handleSolRedemptionLocked(rec) {
    const s = this.state.data;
    const chainLabel = this.cfg.solChainLabel ?? "solana-devnet";
    const mapping = Object.values(s.mappings).find(
      (m) => m.assetId === rec.assetId && sourceForChain(m, chainLabel)
    );
    const src = mapping ? sourceForChain(mapping, chainLabel) : null;
    if (!mapping || !src) {
      // Only Solana-bridged assets can be released on Solana. Anything else
      // (say, an Ethereum-bridged asset sent to a Solana unwrap address) parks
      // for the operator — and must never reach the Ethereum release path.
      rec.status = "ignored_wrong_network";
      this.state.save();
      this.log(`sol redemption ${rec.key}: asset ${rec.assetId} is not Solana-bridged, parked for the operator`);
      return;
    }
    rec.symbol = mapping.symbol;
    rec.ticker = mapping.contract?.ticker ?? null;
    rec.tokenKey = src.tokenKey;
    if (this.haltedReason(mapping.assetId, "release")) {
      rec.status = "halted";
      rec.waiting = this.haltedReason(mapping.assetId, "release");
      this.state.save();
      return;
    }
    if (src.token === "sol") {
      // Below Solana's rent-exempt minimum, a lamport release to a fresh
      // account cannot execute; park tiny redemptions instead of burning
      // attempts on them. (Token releases have no such floor: the treasury
      // funds the recipient's associated token account.)
      const minSats = BigInt(this.cfg.solMinReleaseSats ?? 100_000); // 0.001 SOL
      if (BigInt(rec.sats) < minSats) {
        rec.status = "dust_ignored";
        this.state.save();
        this.log(`sol redemption ${rec.key}: below the minimum Solana release, needs manual handling`);
        return;
      }
    }
    const units = atomsToUnits(rec.sats, src.decimals, mapping.precision);
    if (units === 0n) {
      rec.status = "dust_ignored";
      this.state.save();
      this.log(`sol redemption ${rec.key}: amount too small to represent on Solana, needs manual handling`);
      return;
    }
    rec.amountUnits = units.toString();

    // Per-escrow solvency, as on the Ethereum leg, and gated the same way:
    // only a source that keeps an escrow ledger is checked here.
    const escrowed = src.escrowedUnits === undefined ? null : BigInt(src.escrowedUnits);
    if (escrowed !== null && escrowed < units) {
      rec.status = "awaiting_liquidity";
      this.state.save();
      this.log(
        `sol redemption ${rec.key}: ${src.tokenKey} escrow holds ${escrowed}, needs ${units}; awaiting rebalance`
      );
      return;
    }

    // The same gate as the Ethereum leg: the release is irreversible, so the
    // burn must be final under Bitcoin anchoring, never a Sequentia block count.
    const fin = await this.burnFinality(rec.txid);
    rec.finality = fin.reason;
    rec.finalityProgress = { depth: fin.depth, need: fin.need, kind: fin.kind };
    if (!fin.final) {
      rec.status = "awaiting_finality";
      this.state.save();
      this.log(`sol redemption ${rec.key}: awaiting finality: ${fin.reason}`);
      return;
    }
    // Both gates passed: proceed to release, whichever pre-release park the
    // record came from (awaiting_finality or awaiting_liquidity). This mirrors
    // the Ethereum leg's unconditional promotion; a conditional check here
    // would leave a rebalanced awaiting_liquidity record stuck, passing both
    // gates every tick yet never releasing.
    rec.status = "new";
    this.state.save();
    await this.releaseSolRedemptionLocked(rec, mapping);
  }

  async releaseSolRedemption(rec, mapping) {
    return this.withRecord(`sol:${rec.key}`, () => this.releaseSolRedemptionLocked(rec, mapping));
  }

  async releaseSolRedemptionLocked(rec, mapping) {
    // The mint, decimals and token program to pay with are this asset's
    // SOLANA source's, not those of whichever source an asset-id lookup
    // happened to return first (a unified asset has one per chain).
    const src =
      sourcesOf(mapping)[rec.tokenKey] ??
      sourceForChain(mapping, this.cfg.solChainLabel ?? "solana-devnet");
    if (!src) {
      rec.status = "ignored_wrong_network";
      this.state.save();
      this.log(`sol redemption ${rec.key}: asset ${rec.assetId} has no Solana source; parked`);
      return;
    }
    if (rec.status === "new" || rec.status === "releasing") {
      // Resolve any transfer already sent (or possibly sent) before building a
      // new one: the recorded signature is the on-chain replay guard.
      if (rec.release) {
        const fate = await this.solTransferFate(rec.release);
        if (fate === "pending") return; // may still land; next tick
        if (fate === "landed") {
          rec.status = "released";
          rec.releaseSig = rec.release.signature;
          this.debitEscrow(mapping, src.tokenKey, rec.amountUnits ?? rec.lamports, rec);
          this.state.save();
          this.log(
            `sol redemption ${rec.key}: released ${rec.amountUnits ?? rec.lamports} units of ${rec.symbol ?? "SOL"} to ${rec.solAddress} in ${rec.release.signature}`
          );
        } else if (fate === "failed") {
          // Executed on chain but failed (e.g. treasury underfunded): no
          // lamports moved, safe to rebuild once the cause clears.
          this.log(`sol redemption ${rec.key}: release ${rec.release.signature} failed on chain`);
          rec.release = null;
          rec.releaseExpiredChecks = 0;
          this.state.save();
        } else {
          // 'expired'. Before rebuilding an irreversible payment, demand the
          // verdict on two separate ticks: a single check can be a race
          // between inconsistent RPC views (a lagging status node beside a
          // fresh height node would double-pay the user).
          rec.releaseExpiredChecks = (rec.releaseExpiredChecks ?? 0) + 1;
          this.state.save();
          if (rec.releaseExpiredChecks < 2) return;
          rec.release = null;
          rec.releaseExpiredChecks = 0;
          this.state.save();
        }
      }
      if (rec.status !== "released") {
        // Anchoring is supreme: re-verify the burn is STILL final immediately
        // before the irreversible send. A crash or RPC outage can put an
        // arbitrarily long gap between the first verdict and this broadcast,
        // and a deep Bitcoin reorg in that gap must park the release, not pay.
        const fin = await this.burnFinality(rec.txid);
        if (!fin.final) {
          rec.finality = fin.reason;
          rec.status = "awaiting_finality";
          this.state.save();
          this.log(`sol redemption ${rec.key}: burn no longer final (${fin.reason}); release parked`);
          return;
        }
        const isNative = src.token === "sol";
        const units = BigInt(rec.amountUnits ?? rec.lamports);
        const treasury = this.sol.treasury;
        // An underfunded treasury should simply wait for a top-up, not burn
        // attempts; and a lamport transfer may not leave the treasury above
        // zero but below the rent-exempt minimum (the chain rejects it).
        const treasuryBal = await this.sol.balance(treasury.address);
        if (isNative) {
          if (treasuryBal < units + FEE_LAMPORTS + RENT_EXEMPT_MIN_LAMPORTS) {
            this.log(`sol redemption ${rec.key}: treasury underfunded (${treasuryBal} lamports for a ${units} release); waiting`);
            return;
          }
        } else {
          if (treasuryBal < FEE_LAMPORTS + TOKEN_ACCOUNT_RENT_LAMPORTS + RENT_EXEMPT_MIN_LAMPORTS) {
            this.log(`sol redemption ${rec.key}: treasury lamports too low for a token release; waiting`);
            return;
          }
          const held = (await this.sol.tokenAccountsByOwner(treasury.address))
            .filter((t) => t.mint === src.token)
            .reduce((a, t) => a + t.amount, 0n);
          if (held < units) {
            this.log(`sol redemption ${rec.key}: treasury holds ${held} of ${mapping.symbol}, needs ${units}; waiting`);
            return;
          }
        }
        rec.attempts = (rec.attempts ?? 0) + 1;
        if (rec.attempts > 10) {
          rec.status = "release_failed_manual";
          rec.error = "release did not land after 10 attempts";
          this.state.save();
          this.log(`sol redemption ${rec.key}: ${rec.error}`);
          return;
        }
        const bh = await this.sol.latestBlockhash();
        let built;
        if (isNative) {
          built = transferTx({
            feePayer: treasury,
            source: treasury,
            dest: rec.solAddress,
            lamports: units,
            recentBlockhash: bh.blockhash,
          });
        } else {
          const tokenProgram = src.tokenProgram ?? TOKEN_PROGRAM;
          const treasuryAta = ataAddress(treasury.address, src.token, tokenProgram);
          const userAta = ataAddress(rec.solAddress, src.token, tokenProgram);
          built = buildTx({
            feePayer: treasury,
            recentBlockhash: bh.blockhash,
            instructions: [
              ataCreateIdempotent({
                payer: treasury.address,
                ata: userAta,
                owner: rec.solAddress,
                mint: src.token,
                tokenProgram,
              }),
              splTransferChecked({
                source: treasuryAta,
                mint: src.token,
                dest: userAta,
                owner: treasury.address,
                amount: units,
                decimals: src.decimals,
                tokenProgram,
              }),
            ],
          });
        }
        rec.release = { signature: built.signature, lastValidBlockHeight: bh.lastValidBlockHeight };
        rec.releaseExpiredChecks = 0;
        rec.status = "releasing";
        this.state.save(); // persisted BEFORE broadcast: a crash cannot double-pay
        await this.sol.send(built.tx);
        this.log(`sol redemption ${rec.key}: release sent (${built.signature})`);
        return; // finalization is checked on the next tick
      }
    }

    if (["released", "destroy_pending", "destroying"].includes(rec.status)) {
      await this.destroyRedeemed(rec, mapping, rec.ticker ?? mapping.symbol);
    }
  }

  /** Destroy the returned amount after a release, so circulating supply
   *  keeps matching what the source chains hold. Used by every leg.
   *
   *  Replay-guarded the way Solana releases are: the signed burn is persisted
   *  BEFORE it is broadcast, so after any interruption the daemon holds the
   *  exact transaction in question. Re-broadcasting that same transaction can
   *  never burn twice (it has one txid), so an interrupted burn finishes on
   *  its own. A fresh burn is built only once the recorded one provably can
   *  never land: its inputs were spent by something else. */
  async destroyRedeemed(rec, mapping, label) {
    return this.burnLock.run(() => this.destroyRedeemedLocked(rec, mapping, label));
  }

  async destroyRedeemedLocked(rec, mapping, label) {
    if (rec.destroyTxid) return this.finishDestroy(rec, mapping, label, rec.destroyTxid);
    if (rec.pendingDestroy && !rec.burn) {
      // A burn interrupted by an older daemon that did not record its
      // transaction first: nothing to examine, so a human must.
      rec.status = "destroy_manual";
      this.state.save();
      this.log(`redemption ${rec.key}: destroy was interrupted before its transaction was recorded; parked`);
      return;
    }
    rec.status = "destroying";
    if (!rec.burn) {
      try {
        rec.burn = await this.buildBurn(rec.assetId, rec.sats);
      } catch (e) {
        rec.status = "destroy_pending";
        rec.error = e.message;
        this.state.save();
        this.log(`redemption ${rec.key}: could not build the burn, will retry: ${e.message}`);
        return;
      }
      rec.burn.builtAt = new Date().toISOString();
      this.state.save(); // persisted BEFORE broadcast
    }
    const { txid, hex } = rec.burn;
    let visible = false;
    try {
      visible = await this.txVisible(txid);
    } catch {}
    if (!visible) {
      try {
        await this.seq.node("sendrawtransaction", { hexstring: hex });
      } catch (e) {
        if (/missing-inputs|missingorspent|bad-txns-inputs/i.test(e.message)) {
          // Its inputs are gone. If our burn had spent them it would be
          // visible, and it is not, so something else did: this transaction
          // can never land, and building a new one cannot double-burn.
          let stillVisible = false;
          try {
            stillVisible = await this.txVisible(txid);
          } catch {}
          if (!stillVisible) {
            await this.seq.call("abandontransaction", { txid }).catch(() => {});
            delete rec.burn;
            rec.status = "destroy_pending";
            rec.error = "recorded burn's inputs were spent elsewhere; rebuilding";
            this.state.save();
            this.log(`redemption ${rec.key}: ${rec.error}`);
            return;
          }
        } else if (!/already in (block ?chain|the mempool)|txn-already-(known|in-mempool)/i.test(e.message)) {
          this.waitOnBurn(rec, `burn ${txid} could not be broadcast: ${e.message}`);
          return;
        }
      }
      const fate = await this.confirmBroadcast(txid);
      if (fate === "absent") {
        // Rejected by the mempool yet not conflicting: rebuild from fresh coins.
        delete rec.burn;
        rec.status = "destroy_pending";
        rec.error = "burn was rejected by the mempool; rebuilding";
        this.state.save();
        this.log(`redemption ${rec.key}: ${rec.error}`);
        return;
      }
      if (fate === "unknown") {
        this.waitOnBurn(rec, `could not establish whether burn ${txid} was broadcast`);
        return;
      }
    }
    return this.finishDestroy(rec, mapping, label, txid);
  }

  /** Keep a recorded burn and try it again next tick; only a burn nobody can
   *  settle for `unresolvedHours` becomes a manual case. The user is already
   *  paid either way; this only keeps the supply figures exact. */
  waitOnBurn(rec, why) {
    rec.status = "destroying";
    rec.error = why;
    const hours = (Date.now() - Date.parse(rec.burn?.builtAt ?? rec.createdAt)) / 3_600_000;
    if (hours > (this.cfg.unresolvedHours ?? 24)) rec.status = "destroy_manual";
    this.state.save();
    this.log(`redemption ${rec.key}: ${why}${rec.status === "destroy_manual" ? "; parked for the operator" : ""}`);
  }

  finishDestroy(rec, mapping, label, txid) {
    if (rec.status === "done") return;
    this.escrowEpoch = (this.escrowEpoch ?? 0) + 1;
    rec.destroyTxid = txid;
    delete rec.burn;
    delete rec.pendingDestroy;
    delete rec.error;
    mapping.mintedSats = (BigInt(mapping.mintedSats) - BigInt(rec.sats)).toString();
    rec.status = "done";
    this.state.save();
    this.log(`redemption ${rec.key}: destroyed ${satsToAmount(rec.sats)} ${label} in ${txid}`);
  }

  /** Re-drive Solana redemptions across ticks: finality waits, in-flight
   *  releases, and pending destroys (advance + retry in one pass). */
  async advanceSolRedemptions() {
    if (!this.sol) return;
    await this.sol.ensureCluster();
    const s = this.state.data;
    for (const rec of Object.values(s.solRedemptions)) {
      try {
        if (["awaiting_finality", "awaiting_liquidity", "halted"].includes(rec.status)) {
          await this.handleSolRedemption(rec);
        } else if (["new", "releasing", "released", "destroy_pending", "destroying"].includes(rec.status)) {
          const mapping = Object.values(s.mappings).find((m) => m.assetId === rec.assetId);
          if (mapping) await this.releaseSolRedemption(rec, mapping);
        }
      } catch (e) {
        this.log(`sol redemption ${rec.key}: advance failed: ${e.message}`);
      }
    }
  }

  // ================= Supervision: halts, deliveries, health =================

  /** Why the asset is halted for `kind` ("mint" or "release"), or null. */
  haltedReason(assetId, kind) {
    const h = this.state.data.halted?.[assetId];
    if (!h) return null;
    return h.scope === "all" || h.scope === kind ? `halted: ${h.reason}` : null;
  }

  /** Stop minting (scope "mint") or everything (scope "all") for an asset
   *  until an operator clears it. Sticky on purpose: an invariant that broke
   *  once is not trusted again because it looks fine a minute later. */
  halt(assetId, scope, reason) {
    const s = this.state.data;
    s.halted ??= {};
    const prev = s.halted[assetId];
    if (prev && (prev.scope === "all" || prev.scope === scope)) return;
    s.halted[assetId] = { scope: prev ? "all" : scope, reason, at: new Date().toISOString() };
    this.state.save();
    this.log(`HALTED ${scope} for ${assetId}: ${reason}`);
  }

  /** Retire a bridged asset: its mapping moves to `retiredMappings`, so
   *  the next deposit of the same token issues a fresh asset instead of
   *  trying to reissue one that no longer exists (an asset issued before a
   *  chain reset, say). The record is kept, with the reason, for the
   *  reserves page and the history. A unified asset cannot be retired this
   *  way: its identity is meant to outlive any one chain. */
  retireMapping(mappingKey, note) {
    const s = this.state.data;
    const m = s.mappings[mappingKey];
    if (!m) throw Object.assign(new Error("no such mapping"), { status: 404 });
    if (m.unified) throw Object.assign(new Error("a unified asset is never retired"), { status: 400 });
    const at = new Date().toISOString();
    s.retiredMappings ??= {};
    s.retiredMappings[`${mappingKey}@${at}`] = { ...m, retired: { note, at } };
    delete s.mappings[mappingKey];
    for (const [k, v] of Object.entries(s.tokenRoutes ?? {})) if (v === mappingKey) delete s.tokenRoutes[k];
    this.state.save();
    this.log(`retired asset ${m.assetId} (${mappingKey}): ${note}`);
    return s.retiredMappings[`${mappingKey}@${at}`];
  }

  unhalt(assetId) {
    const s = this.state.data;
    if (!s.halted?.[assetId]) return false;
    delete s.halted[assetId];
    this.state.save();
    this.log(`halt cleared for ${assetId}`);
    return true;
  }

  holdForHalt(dep, assetId) {
    dep.status = "mint_retry";
    dep.waiting = this.haltedReason(assetId, "mint");
    dep.nextAttemptAt = new Date(Date.now() + 60_000).toISOString();
    this.state.save();
  }

  /** Watch each delivery until it is final under Bitcoin anchoring. A
   *  delivery counts as done once it reaches the mempool, but a Sequentia
   *  reorg can still undo it; one that ends up conflicted must be seen by a
   *  person, not discovered by the user. */
  async watchDeliveries() {
    const s = this.state.data;
    // Only deliveries this watcher saw happen (they carry `deliveredAt`). An
    // older record can predate a chain reset, and its delivery would read as
    // displaced when the chain it landed on simply no longer exists.
    const pending = [...Object.values(s.deposits), ...Object.values(s.solDeposits)].filter(
      (d) => d.status === "minted" && d.steps?.sendTxid && d.deliveredAt && !d.deliveryFinal
    );
    for (const d of pending.slice(0, this.cfg.deliveryWatchBatch ?? 25)) {
      const txid = d.steps.sendTxid;
      let gt;
      try {
        gt = await this.seq.call("gettransaction", { txid });
      } catch {
        continue;
      }
      if (gt.confirmations < 0) {
        d.status = "delivery_reorged";
        d.error = `delivery ${txid} was displaced by a conflicting transaction`;
        this.state.save();
        this.log(`${d.tag ?? `deposit #${d.nonce}`}: ${d.error}`);
        continue;
      }
      const fin = await this.burnFinality(txid);
      if (fin.final) {
        d.deliveryFinal = true;
        d.deliveryFinalAt = new Date().toISOString();
        this.state.save();
      }
    }
  }

  /** Check each asset's supply against what backs it, and halt what fails.
   *
   *  Two rules, from the unified-asset standard: the supply the CHAIN reports
   *  may never exceed this daemon's own ledger (anything beyond it was minted
   *  by something other than a verified deposit), and for assets that keep an
   *  escrow ledger, circulating supply may never exceed escrow beyond what is
   *  in flight (paid out, not yet burned). A breach halts minting for the
   *  asset; the operator investigates and clears it (admin API). */
  async checkInvariants() {
    const every = this.cfg.invariantIntervalMs ?? 60_000;
    if (this._lastInvariants && Date.now() - this._lastInvariants < every) return;
    this._lastInvariants = Date.now();
    const s = this.state.data;
    const report = {};
    // Mints broadcast but not yet recorded (in flight, or unresolved) are in
    // the chain's supply before they are in the ledger; allow for them.
    const pendingMint = {};
    for (const d of [...Object.values(s.deposits), ...Object.values(s.solDeposits)]) {
      const c = d.steps?.mintCandidate;
      if (c && s.mappings[c.mappingKey]) {
        const a = s.mappings[c.mappingKey].assetId;
        pendingMint[a] = (pendingMint[a] ?? 0n) + BigInt(c.sats);
      }
    }
    // A breach must be seen on two consecutive passes before it halts: one
    // read can race a mint whose RPC answer has not been processed yet.
    const seenNow = new Set();
    const breach = (assetId, rule, reason) => {
      const k = `${assetId}:${rule}`;
      seenNow.add(k);
      if (this._suspect?.has(k)) this.halt(assetId, "mint", reason);
      else this.log(`invariant ${rule} failed once for ${assetId} (${reason}); halting if it repeats`);
    };
    for (const [key, m] of Object.entries(s.mappings)) {
      if (m.retired) continue;
      let supply;
      try {
        supply = await this.chainSupplyAtoms(m.assetId);
      } catch (e) {
        report[key] = { error: e.message };
        continue;
      }
      const ledger = BigInt(m.mintedSats ?? "0");
      const row = { chainSupply: supply.toString(), ledger: ledger.toString() };
      if (supply < 0n) {
        row.note = "issuance not visible on this chain";
        report[key] = row;
        continue;
      }
      const pending = pendingMint[m.assetId] ?? 0n;
      if (supply > ledger + pending) {
        breach(m.assetId, "supply", `chain supply ${supply} exceeds the ledger ${ledger}`);
      }
      if (m.sources && Object.values(m.sources).every((src) => src.escrowedUnits !== undefined)) {
        let escrow = 0n;
        for (const src of Object.values(m.sources)) {
          escrow += unitsToAtoms(src.escrowedUnits, src.decimals, m.precision);
        }
        let inFlight = 0n;
        for (const r of [...Object.values(s.redemptions), ...Object.values(s.solRedemptions)]) {
          if (r.assetId === m.assetId && ["released", "destroy_pending", "destroying"].includes(r.status)) {
            inFlight += BigInt(r.sats);
          }
        }
        row.escrow = escrow.toString();
        row.inFlight = inFlight.toString();
        if (supply - inFlight - pending > escrow) {
          breach(m.assetId, "escrow", `circulating ${supply - inFlight} exceeds escrow ${escrow}`);
        }
      }
      report[key] = row;
    }
    this._suspect = seenNow;
    this.invariantReport = { at: new Date().toISOString(), assets: report };
  }

  /** Balances that stop the bridge when they run out, read at most every
   *  five minutes. */
  async operatingBalances() {
    if (this._balances && Date.now() - this._balances.at < 300_000) return this._balances.value;
    const out = {};
    try {
      out.ethGasWei = (await this.eth.provider.getBalance(this.eth.wallet.address)).toString();
    } catch (e) {
      out.ethGasError = e.message;
    }
    if (this.cfg.seqFeeAsset) {
      try {
        // Asked for by label: the balance map keys a registered asset by its
        // ticker, so looking a hex id up in it reads zero for an asset the
        // wallet holds plenty of.
        const b = await this.seq.call("getbalance", { assetlabel: this.cfg.seqFeeAsset });
        out.seqFeeAsset = String(typeof b === "object" ? b?.[this.cfg.seqFeeAsset] ?? 0 : b);
      } catch (e) {
        out.seqFeeError = e.message;
      }
    }
    if (this.sol) {
      try {
        out.solTreasuryLamports = (await this.sol.balance(this.sol.treasury.address)).toString();
      } catch (e) {
        out.solError = e.message;
      }
    }
    this._balances = { at: Date.now(), value: out };
    return out;
  }

  /** One report of everything an operator needs to know, used by
   *  /api/health and by the alerts. `problems` lists each thing that needs
   *  attention with a stable key, so an alert can be raised and cleared. */
  async health() {
    const s = this.state.data;
    const now = Date.now();
    const problems = [];
    const staleMs = (this.cfg.phaseStaleMinutes ?? 10) * 60_000;
    const started = this.startedAt ?? now;

    const phases = {};
    for (const [name, p] of Object.entries(this.phases)) {
      const since = p.lastOk ?? started;
      phases[name] = {
        lastOk: p.lastOk ? new Date(p.lastOk).toISOString() : null,
        lastError: p.lastError ?? null,
        lastErrorAt: p.lastErrorAt ? new Date(p.lastErrorAt).toISOString() : null,
        consecutiveFailures: p.consecutiveFailures ?? 0,
      };
      if (now - since > staleMs && (p.consecutiveFailures ?? 0) > 0) {
        problems.push({
          key: `phase:${name}`,
          severity: "critical",
          title: `${name} has not succeeded for ${Math.round((now - since) / 60_000)} min`,
          detail: p.lastError ?? "no error recorded",
        });
      }
    }

    const ATTENTION = new Set([
      "failed_manual",
      "dust_manual",
      "release_failed_manual",
      "refund_failed_manual",
      "destroy_manual",
      "delivery_reorged",
    ]);
    const records = {};
    for (const [group, list] of Object.entries({
      deposits: s.deposits,
      solDeposits: s.solDeposits,
      redemptions: s.redemptions,
      solRedemptions: s.solRedemptions,
    })) {
      const g = (records[group] = {});
      for (const r of Object.values(list ?? {})) {
        const e = (g[r.status] ??= { count: 0, oldest: null });
        e.count++;
        const t = r.unresolvedSince ?? r.createdAt;
        if (t && (!e.oldest || t < e.oldest)) e.oldest = t;
        if (r.retired) e.retired = (e.retired ?? 0) + 1;
      }
      for (const [status, e] of Object.entries(g)) {
        const live = e.count - (e.retired ?? 0);
        if (!live) continue;
        const ageH = e.oldest ? (now - Date.parse(e.oldest)) / 3_600_000 : 0;
        if (ATTENTION.has(status)) {
          problems.push({
            key: `records:${group}:${status}`,
            severity: "warning",
            title: `${live} ${group} record(s) need an operator (${status})`,
            detail: `oldest since ${e.oldest}; see /api/admin/records?status=${status}`,
          });
        } else if (status === "unresolved" && ageH > 1) {
          problems.push({
            key: `records:${group}:unresolved`,
            severity: "warning",
            title: `${live} ${group} record(s) unresolved for over an hour`,
            detail: `the node has not been able to confirm a transaction since ${e.oldest}`,
          });
        } else if (status === "awaiting_liquidity") {
          problems.push({
            key: `records:${group}:awaiting_liquidity`,
            severity: "warning",
            title: `${live} ${group} redemption(s) waiting for escrow to be rebalanced`,
            detail: `oldest since ${e.oldest}`,
          });
        }
      }
    }

    for (const [assetId, h] of Object.entries(s.halted ?? {})) {
      problems.push({
        key: `halt:${assetId}`,
        severity: "critical",
        title: `asset ${assetId.slice(0, 12)} halted (${h.scope})`,
        detail: h.reason,
      });
    }
    for (const miss of this.missingDeposits ?? []) {
      problems.push({ key: `missing:${miss}`, severity: "critical", title: `deposit ${miss} has no record`, detail: "the vault counts it but no log was found" });
    }
    for (const key of this.depositConflicts ?? []) {
      problems.push({ key: `conflict:${key}`, severity: "critical", title: `deposit ${key} reappeared in a different transaction`, detail: "an Ethereum reorg rewrote a deposit already recorded" });
    }

    const balances = await this.operatingBalances();
    const low = (cond, key, title, detail) => cond && problems.push({ key, severity: "warning", title, detail });
    const minGas = BigInt(this.cfg.minOperatorGasWei ?? "20000000000000000"); // 0.02 ETH
    low(balances.ethGasWei && BigInt(balances.ethGasWei) < minGas, "balance:eth", "operator gas is low", `${balances.ethGasWei} wei`);
    const minFee = Number(this.cfg.minFeeAssetBalance ?? 1);
    low(balances.seqFeeAsset !== undefined && Number(balances.seqFeeAsset) < minFee, "balance:fee", "Sequentia fee asset is low", `${balances.seqFeeAsset}`);
    const minSol = BigInt(this.cfg.minSolTreasuryLamports ?? 50_000_000);
    low(balances.solTreasuryLamports && BigInt(balances.solTreasuryLamports) < minSol, "balance:sol", "Solana treasury is low", `${balances.solTreasuryLamports} lamports`);

    return {
      status: problems.some((p) => p.severity === "critical") ? "failing" : problems.length ? "degraded" : "ok",
      generatedAt: new Date(now).toISOString(),
      startedAt: new Date(started).toISOString(),
      phases,
      records,
      halted: s.halted ?? {},
      invariants: this.invariantReport ?? null,
      balances,
      problems,
    };
  }

  /** Whether `address` is a valid Sequentia address, and whether it is a
   *  blinded (confidential) one. Both forms are accepted everywhere; the page
   *  uses this to check an address before any funds move. */
  async checkSeqAddress(address) {
    const v = await this.seq.node("validateaddress", { address });
    return {
      valid: Boolean(v.isvalid),
      blinded: Boolean(v.isvalid && v.confidential_key),
    };
  }
}
