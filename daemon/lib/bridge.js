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
        const issued = await this.seq.call("issueasset", {
          assetamount: 0,
          tokenamount: 1,
          blind: false,
          contract_hash: ch,
          denomination: precision,
          ...(this.cfg.seqFeeAsset ? { fee_asset: this.cfg.seqFeeAsset } : {}),
        });
        if (!(await this.waitWalletTxVisible(issued.txid))) {
          await this.seq.call("abandontransaction", { txid: issued.txid }).catch(() => {});
          throw new Error(`unified ${def.symbol}: issuance tx never reached the mempool`);
        }
        mapping = {
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
        };
        s.mappings[mappingKey] = mapping;
        this.state.save();
        this.log(
          `unified ${def.symbol}: issued Sequentia asset ${issued.asset} as ${contract.ticker} ` +
            `(precision ${precision}, zero supply, 1 reissuance token ${issued.token})`
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

  /** Record that `units` more of a source's token now sit in that chain's
   *  escrow. The sum of these across sources is what circulating supply must
   *  equal; see /api/por. */
  creditEscrow(mapping, tokenKey, units) {
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
      const wtx = await this.seq.call("gettransaction", { txid: iss.txid });
      const decoded = await this.seq.call("decoderawtransaction", { hexstring: wtx.hex });
      const issuance = decoded.vin?.[iss.vin]?.issuance;
      if (!issuance) continue;
      if (issuance.assetamountcommitment) {
        throw new Error(`asset ${assetId} has a blinded issuance; supply is not knowable`);
      }
      if (issuance.assetamount === undefined) continue; // mints no units
      atoms += amountToSats(issuance.assetamount);
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

  /** Record that `units` left a source's escrow on release. */
  debitEscrow(mapping, tokenKey, units) {
    const src = mapping.sources?.[tokenKey];
    if (!src) return;
    const now = BigInt(src.escrowedUnits ?? "0") - BigInt(units);
    src.escrowedUnits = (now < 0n ? 0n : now).toString();
  }

  // ================= Ethereum -> Sequentia =================

  async processDeposits() {
    const s = this.state.data;
    const head = await this.eth.provider.getBlockNumber();
    const confirmedHead = head - this.cfg.ethConfirmations;
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

  async handleDeposit(ev, vaultAddress = null) {
    const s = this.state.data;
    const nonce = ev.args.nonce.toString();
    // Vaults number their deposits independently, so nonce alone stops being
    // unique the moment a second vault is watched. The primary vault keeps
    // the bare nonce as its key so existing records and their on-chain refund
    // ids are untouched.
    const isPrimary =
      !vaultAddress || String(this.cfg.vaultAddress ?? "").toLowerCase() === String(vaultAddress).toLowerCase();
    const key = isPrimary ? nonce : `${vaultAddress}:${nonce}`;
    if (s.deposits[key]) return; // already seen (rescan)

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
      this.log(`deposit #${nonce}: mint failed: ${e.message}`);
      if (dep.status === "minting" && !dep.steps.pendingIssue && !dep.steps.pendingMint && !dep.steps.pendingSend) {
        // Nothing irreversible happened yet; retry on the next scan pass.
        dep.status = "mint_retry";
        dep.error = e.message;
      } else if (dep.status === "minting") {
        dep.status = "failed_manual";
        dep.error = e.message;
      }
      this.state.save();
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
    const already = mapping ? BigInt(mapping.mintedSats) : 0n;
    if (already + sats > SEQ_MAX_SATS) {
      dep.status = "refund_pending";
      dep.refundReason = "would exceed the Sequentia per-asset amount cap";
      this.state.save();
      return;
    }
    dep.sats = sats.toString();

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
    this.creditEscrow(mapping, dep.tokenKey, dep.amountUnits);
    this.state.save();

    await this.sendMinted(dep, mapping);
  }

  /** Issue-or-reissue the bridged asset for `tokenKey` by `sats`, creating the
   *  mapping (with its registry contract) on first use. Shared by every leg;
   *  `origin` describes where the deposit came from: { chainId, token, meta:
   *  {symbol, name, decimals}, chainName, tickerSuffix }. Returns the mapping,
   *  or null when the mint was deferred for a later retry (dep status/markers
   *  already updated via deferMint). */
  async ensureMintedMapping(dep, tokenKey, sats, origin) {
    const s = this.state.data;
    const tag = dep.tag ?? `deposit #${dep.nonce}`;
    // Follow a unified route before deciding to issue: this lookup is the one
    // and only thing standing between a second source chain and a duplicate,
    // liquidity-splitting asset.
    const mappingKey = this.mappingKeyFor(tokenKey);
    let mapping = s.mappings[mappingKey];
    if (!mapping) {
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
      if (!(await this.waitWalletTxVisible(issued.txid))) {
        await this.seq.call("abandontransaction", { txid: issued.txid }).catch(() => {});
        this.deferMint(dep, "pendingIssue", new Error("issuance tx never reached the mempool"));
        return null;
      }
      mapping = {
        tokenKey,
        chainId: origin.chainId,
        token: origin.token,
        symbol: origin.meta.symbol,
        name: origin.meta.name,
        decimals: origin.meta.decimals,
        assetId: issued.asset,
        reissuanceToken: issued.token,
        entropy: issued.entropy,
        issueTxid: issued.txid,
        firstDepositNonce: dep.nonce ?? dep.sig ?? null,
        mintedSats: sats.toString(),
        contract,
        contractHash: ch,
        registered: false,
        createdAt: new Date().toISOString(),
      };
      s.mappings[mappingKey] = mapping;
      delete dep.steps.pendingIssue;
      dep.steps.issueTxid = issued.txid;
      this.state.save();
      this.log(
        `${tag}: issued NEW Sequentia asset ${issued.asset} for ${origin.meta.symbol} as ${contract.ticker} (${tokenKey})`
      );
      // Best-effort: label it in the asset registry. Never blocks the mint.
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
      if (!(await this.waitWalletTxVisible(re.txid))) {
        // The wallet can hand out a txid for a transaction the chain rejects
        // without surfacing an error. Roll the wallet back and retry clean.
        await this.seq.call("abandontransaction", { txid: re.txid }).catch(() => {});
        this.deferMint(dep, "pendingMint", new Error("reissuance tx never reached the mempool"));
        return null;
      }
      mapping.mintedSats = (BigInt(mapping.mintedSats) + sats).toString();
      delete dep.steps.pendingMint;
      dep.steps.mintTxid = re.txid;
      this.state.save();
      this.log(
        `${tag}: reissued ${satsToAmount(sats)} of existing asset ${mapping.assetId} (${mapping.symbol})`
      );
    }
    return mapping;
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
      const res = await fetch(`${this.cfg.registryUrl.replace(/\/$/, "")}/index.minimal.json`);
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
    dep.attempts = (dep.attempts ?? 0) + 1;
    dep.status = dep.attempts > 10 ? "failed_manual" : "mint_retry";
    dep.error = err.message;
    this.state.save();
    this.log(`${dep.tag ?? `deposit #${dep.nonce}`}: mint deferred (attempt ${dep.attempts}): ${err.message}`);
  }

  /** True once the wallet tx is in the mempool or a block. The wallet can
   *  commit a tx the chain rejects without surfacing an error, so never
   *  treat a returned txid as broadcast without this check. */
  async waitWalletTxVisible(txid, timeoutMs = 15000) {
    const t0 = Date.now();
    for (;;) {
      try {
        await this.seq.node("getmempoolentry", { txid });
        return true;
      } catch {
        try {
          const gt = await this.seq.call("gettransaction", { txid });
          if (gt.confirmations > 0) return true;
        } catch {}
      }
      if (Date.now() - t0 > timeoutMs) return false;
      await new Promise((r) => setTimeout(r, 1000));
    }
  }

  /** Destroy (burn) `sats` of `assetId`, keeping circulating supply equal to
   *  the funds locked on Ethereum. When a fee asset is configured the burn is
   *  built as a raw transaction paying its fee in that asset, so the bridge
   *  never needs the policy asset; otherwise it falls back to destroyamount
   *  (which pays its fee in the policy asset). Returns the burn txid. */
  async destroyAsset(assetId, sats) {
    const amount = satsToAmount(sats);
    if (!this.cfg.seqFeeAsset) {
      return this.seq.call("destroyamount", { asset: assetId, amount });
    }
    // No preset inputs: the any-asset-fee coin selector rejects them, so let
    // the node choose the asset inputs to burn and the fee-asset inputs.
    const base = await this.seq.call("createrawtransaction", {
      inputs: [],
      outputs: [{ burn: amount, asset: assetId }],
    });
    const funded = await this.seq.call("fundrawtransaction", {
      hexstring: base,
      options: { fee_asset: this.cfg.seqFeeAsset },
    });
    // The wallet gives its change outputs blinding nonces even when receive
    // addresses are transparent, so blind before signing or the node rejects
    // the tx ("output has nonce, but is not blinded").
    const blinded = await this.seq.call("blindrawtransaction", {
      hexstring: funded.hex,
      ignoreblindfail: true,
    });
    const signed = await this.seq.call("signrawtransactionwithwallet", {
      hexstring: blinded,
    });
    if (!signed.complete) throw new Error("burn transaction signing incomplete");
    const txid = await this.seq.call("sendrawtransaction", { hexstring: signed.hex });
    if (!(await this.waitWalletTxVisible(txid))) {
      await this.seq.call("abandontransaction", { txid }).catch(() => {});
      throw new Error("burn transaction never reached the mempool");
    }
    return txid;
  }

  /** Step 4: send the minted amount to the depositor's Sequentia address. */
  async sendMinted(dep, mapping) {
    const tag = dep.tag ?? `deposit #${dep.nonce}`;
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
        // spendable). Ambiguous failures (network errors) keep the marker
        // and halt for the operator instead.
        delete dep.steps.pendingSend;
        dep.attempts = (dep.attempts ?? 0) + 1;
        dep.status = dep.attempts > 10 ? "failed_manual" : "send_retry";
        dep.error = e.message;
        this.state.save();
        this.log(`${tag}: send rejected (attempt ${dep.attempts}): ${e.message}`);
        return;
      }
      throw e;
    }
    // T8: never mark a deposit "delivered" until the final send is actually
    // relayed. The wallet can return a txid for a tx the chain rejected (the
    // issue/reissue/burn steps already guard this) — so confirm mempool/block
    // visibility before "minted". If it never shows, roll back and retry rather
    // than reporting a delivery that did not happen.
    if (!(await this.waitWalletTxVisible(sendTxid))) {
      await this.seq.call("abandontransaction", { txid: sendTxid }).catch(() => {});
      delete dep.steps.pendingSend;
      dep.attempts = (dep.attempts ?? 0) + 1;
      dep.status = dep.attempts > 10 ? "failed_manual" : "send_retry";
      dep.error = "send transaction never reached the mempool";
      this.state.save();
      this.log(`${tag}: send not visible (attempt ${dep.attempts}), will retry`);
      return;
    }
    delete dep.steps.pendingSend;
    dep.steps.sendTxid = sendTxid;
    dep.status = "minted";
    delete dep.error;
    this.state.save();
    this.log(`${tag}: sent ${satsToAmount(dep.sats)} ${mapping.symbol} in ${sendTxid}`);
  }

  /** Retry deposits that failed at a safely retryable point. */
  async retryDeposits() {
    for (const dep of Object.values(this.state.data.deposits)) {
      if (dep.status === "send_retry") {
        // Minting already happened; only the send to the user is outstanding.
        const mapping = this.mappingFor(dep.tokenKey);
        try {
          await this.sendMinted(dep, mapping);
        } catch (e) {
          this.log(`deposit #${dep.nonce}: send retry failed: ${e.message}`);
        }
        continue;
      }
      if (dep.status !== "mint_retry") continue;
      dep.status = "minting";
      this.state.save();
      try {
        await this.mintDeposit(dep);
      } catch (e) {
        dep.status =
          dep.steps.pendingIssue || dep.steps.pendingMint || dep.steps.pendingSend
            ? "failed_manual"
            : "mint_retry";
        dep.error = e.message;
        this.state.save();
      }
    }
  }

  /** Pay back deposits whose Sequentia leg cannot happen. Idempotent via the
   *  vault's processedRedemptions guard keyed by a deterministic refund id. */
  async processRefunds() {
    for (const dep of Object.values(this.state.data.deposits)) {
      if (dep.status !== "refund_pending") continue;
      const id = refundId(this.cfg.ethChainId, dep.nonce, dep.key === dep.nonce ? null : dep.vault);
      // Refund out of the vault that took the deposit: no other vault holds
      // escrow for it.
      const vault = this.eth.vaultFor(dep.vault);
      try {
        if (await vault.processedRedemptions(id)) {
          dep.status = "refunded";
          this.state.save();
          continue;
        }
        const tokenAddr = dep.token === "eth" ? ethers.ZeroAddress : dep.token;
        const tx = await vault.release(tokenAddr, dep.from, dep.amountUnits, id);
        await tx.wait(1);
        dep.status = "refunded";
        dep.refundTxHash = tx.hash;
        this.state.save();
        this.log(`deposit #${dep.nonce}: refunded (${dep.refundReason}) in ${tx.hash}`);
      } catch (e) {
        this.log(`deposit #${dep.nonce}: refund attempt failed: ${e.message}`);
      }
    }
  }

  // ================= Sequentia -> Ethereum =================

  /** Create a redemption intent: a fresh Sequentia address bound to an
   *  Ethereum destination. Anything bridged that arrives there is redeemed. */
  async createRedeemIntent(ethAddress) {
    const checksummed = ethers.getAddress(ethAddress); // throws on invalid
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

  /** Re-evaluate redemptions still waiting for the burn to become final, so a
   *  burn that has since accrued enough Bitcoin-anchor depth gets released even
   *  if no new redemption arrived this tick. */
  async advanceRedemptions() {
    for (const rec of Object.values(this.state.data.redemptions)) {
      if (rec.status !== "awaiting_finality") continue;
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
      return { final: false, reason: `burn not confirmed (${gt.confirmations} conf)` };
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
      };
    }
    if (anchor.anchorstatus !== "ok") {
      return { final: false, reason: `node anchor status is ${anchor.anchorstatus}` };
    }

    const hdr = await this.seq.call("getblockheader", {
      blockhash: gt.blockhash,
      verbose: true,
    });
    // poscertified is feature-detected: enforce it only when the node reports it
    // (null on nodes/chains that predate committee certification).
    if (hdr.poscertified === false) {
      return { final: false, reason: "burn block not yet committee-certified" };
    }
    const depth = Number(anchor.anchorheight) - Number(hdr.anchorheight);
    const need = this.cfg.btcAnchorConfirmations ?? 3;
    return {
      final: depth >= need,
      reason: `${depth}/${need} Bitcoin-anchor confirmations`,
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
        try {
          const tx = await vault.release(tokenAddr, rec.ethAddress, rec.amountUnits, id);
          await tx.wait(1);
          rec.releaseTxHash = tx.hash;
          rec.status = "released";
          this.debitEscrow(mapping, rec.tokenKey, rec.amountUnits);
          this.state.save();
          this.log(
            `redemption ${rec.key}: released ${rec.amountUnits} units of ${mapping.symbol} to ${rec.ethAddress} in ${tx.hash}`
          );
        } catch (e) {
          // A CALL_EXCEPTION with revert data is a deterministic contract
          // rejection (e.g. the recipient rejects ETH -> EtherTransferFailed,
          // or a token transfer fails): retrying can't help, so flag it for the
          // operator instead of looping forever. The burn already happened, so
          // the returned amount is safe in the bridge wallet pending manual
          // resolution. Transient errors (network/RPC) rethrow and are retried.
          if (e?.code === "CALL_EXCEPTION" && typeof e.data === "string") {
            rec.status = "release_failed_manual";
            rec.error = `release reverted (${e.data})`;
            this.state.save();
            this.log(`redemption ${rec.key}: release reverted (${e.data}); flagged for operator, not retrying`);
            return;
          }
          // transient (network/RPC): leave status "releasing" so
          // retryRedemptions re-drives it (it reconciles against the on-chain
          // processedRedemptions guard first).
          throw e;
        }
      }
    }

    if (rec.status === "released") {
      await this.destroyRedeemed(rec, mapping, mapping.symbol);
    }
  }

  /** Retry stuck releases (daemon restarted mid-flight) and pending destroys. */
  async retryRedemptions() {
    const s = this.state.data;
    for (const rec of Object.values(s.redemptions)) {
      if (rec.status !== "releasing" && rec.status !== "destroy_pending") continue;
      const mapping = Object.values(s.mappings).find((m) => m.assetId === rec.assetId);
      if (!mapping) continue;
      if (rec.status === "releasing") {
        // The on-chain guard tells us whether the payout landed before the crash.
        rec.status = (await this.eth.vaultFor(rec.vault).processedRedemptions(rec.redemptionId))
          ? "released"
          : "new";
        this.state.save();
      }
      try {
        await this.releaseRedemption(rec, mapping);
      } catch (e) {
        this.log(`redemption ${rec.key}: retry failed: ${e.message}`);
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
      const marker = dep.steps?.pendingIssue || dep.steps?.pendingMint || dep.steps?.pendingSend;
      dep.status = marker ? "failed_manual" : "mint_retry";
      dep.error = marker
        ? "interrupted mid-mint with an irreversible step in flight"
        : "interrupted before any irreversible step";
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
    this.log(`${dep.tag}: mint failed: ${e.message}`);
    if (
      dep.status === "minting" &&
      !dep.steps.pendingIssue &&
      !dep.steps.pendingMint &&
      !dep.steps.pendingSend
    ) {
      dep.status = "mint_retry";
      dep.error = e.message;
    } else if (dep.status === "minting") {
      dep.status = "failed_manual";
      dep.error = e.message;
    }
    this.state.save();
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
    const already = existing ? BigInt(existing.mintedSats) : 0n;
    if (already + sats > SEQ_MAX_SATS) {
      dep.status = "failed_manual";
      dep.error = "would exceed the Sequentia per-asset amount cap";
      this.state.save();
      return;
    }
    dep.sats = sats.toString();
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
    this.creditEscrow(mapping, tokenKey, units);
    this.state.save();
    await this.sendMinted(dep, mapping);
  }

  /** Retry Solana deposits stuck at a safely retryable point. */
  async retrySolDeposits() {
    if (!this.sol) return;
    await this.sol.ensureCluster();
    const s = this.state.data;
    for (const dep of Object.values(s.solDeposits)) {
      if (dep.status === "send_retry") {
        const mapping = Object.values(s.mappings).find((m) => m.assetId === dep.assetId);
        try {
          await this.sendMinted(dep, mapping);
        } catch (e) {
          this.log(`${dep.tag}: send retry failed: ${e.message}`);
        }
        continue;
      }
      if (dep.status !== "mint_retry") continue;
      dep.status = "minting";
      this.state.save();
      await this.mintSolDeposit(dep).catch((e) => this.solMintFailed(dep, e));
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
    if (!fin.final) {
      rec.status = "awaiting_finality";
      this.state.save();
      this.log(`sol redemption ${rec.key}: awaiting finality: ${fin.reason}`);
      return;
    }
    if (rec.status === "awaiting_finality") rec.status = "new";
    this.state.save();
    await this.releaseSolRedemption(rec, mapping);
  }

  async releaseSolRedemption(rec, mapping) {
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
          this.debitEscrow(mapping, src.tokenKey, rec.amountUnits ?? rec.lamports);
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

    if (rec.status === "released") {
      await this.destroyRedeemed(rec, mapping, rec.ticker ?? mapping.symbol);
    }
  }

  /** Destroy the returned amount after a release, bracketed by a persisted
   *  marker so a crash mid-burn can never burn twice: an interrupted destroy
   *  parks as destroy_manual for the operator instead of re-broadcasting on
   *  guesswork. Used by both the Ethereum and the Solana leg. */
  async destroyRedeemed(rec, mapping, label) {
    if (rec.pendingDestroy) {
      rec.status = "destroy_manual";
      this.state.save();
      this.log(`redemption ${rec.key}: destroy was interrupted mid-flight; parked for the operator`);
      return;
    }
    rec.pendingDestroy = true;
    this.state.save();
    try {
      const burnTxid = await this.destroyAsset(rec.assetId, rec.sats);
      delete rec.pendingDestroy;
      rec.destroyTxid = burnTxid;
      mapping.mintedSats = (BigInt(mapping.mintedSats) - BigInt(rec.sats)).toString();
      rec.status = "done";
      this.state.save();
      this.log(`redemption ${rec.key}: destroyed ${satsToAmount(rec.sats)} ${label} in ${burnTxid}`);
    } catch (e) {
      // A node rejection, an abandoned tx, or an incomplete signing all mean
      // nothing landed: safe to retry later. Anything else (a network error
      // mid-broadcast) is ambiguous, so keep the marker and let the next pass
      // park it for the operator. The user is already paid either way.
      if (typeof e.code === "number" || /never reached the mempool|signing incomplete/.test(e.message)) {
        delete rec.pendingDestroy;
        rec.status = "destroy_pending";
      }
      rec.error = e.message;
      this.state.save();
      this.log(`redemption ${rec.key}: destroy failed (${rec.status ?? "ambiguous"}): ${e.message}`);
    }
  }

  /** Re-drive Solana redemptions across ticks: finality waits, in-flight
   *  releases, and pending destroys (advance + retry in one pass). */
  async advanceSolRedemptions() {
    if (!this.sol) return;
    await this.sol.ensureCluster();
    const s = this.state.data;
    for (const rec of Object.values(s.solRedemptions)) {
      try {
        if (rec.status === "awaiting_finality") {
          await this.handleSolRedemption(rec);
        } else if (["new", "releasing", "released", "destroy_pending"].includes(rec.status)) {
          const mapping = Object.values(s.mappings).find((m) => m.assetId === rec.assetId);
          if (mapping) await this.releaseSolRedemption(rec, mapping);
        }
      } catch (e) {
        this.log(`sol redemption ${rec.key}: advance failed: ${e.message}`);
      }
    }
  }
}
