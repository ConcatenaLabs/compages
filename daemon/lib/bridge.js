// Compages core: moves value between the Ethereum vault and Sequentia assets.
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
// Crash safety: every irreversible step is bracketed by a persisted marker.
// If the daemon dies between a chain write and its acknowledgment, the record
// halts in a *_manual state for operator review instead of double-paying.

import { ethers } from "ethers";
import { amountToSats, satsToAmount } from "./seqrpc.js";
import { unitsToSats, satsToUnits } from "./eth.js";

// Per-asset money cap on Sequentia chains (21M * 1e8 sats).
export const SEQ_MAX_SATS = 2_100_000_000_000_000n;

export function tokenKeyOf(chainId, token) {
  return token === "eth" || token === ethers.ZeroAddress
    ? `${chainId}:eth`
    : `${chainId}:${token.toLowerCase()}`;
}

export function refundId(chainId, nonce) {
  return ethers.keccak256(ethers.toUtf8Bytes(`compages:refund:${chainId}:${nonce}`));
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
   */
  constructor(cfg, eth, seq, state, log) {
    this.cfg = cfg;
    this.eth = eth;
    this.seq = seq;
    this.state = state;
    this.log = log;
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
      const logs = await this.eth.vault.queryFilter(
        this.eth.vault.filters.Deposited(),
        from,
        to
      );
      for (const ev of logs) {
        await this.handleDeposit(ev);
      }
      s.lastEthBlock = to;
      this.state.save();
      from = to + 1;
    }
  }

  async handleDeposit(ev) {
    const s = this.state.data;
    const nonce = ev.args.nonce.toString();
    if (s.deposits[nonce]) return; // already seen (rescan)

    const token = ev.args.token === ethers.ZeroAddress ? "eth" : ev.args.token.toLowerCase();
    const dep = {
      nonce,
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
    s.deposits[nonce] = dep;
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

    // 2. Resolve token metadata and the deposit amount in sats.
    let mapping = s.mappings[dep.tokenKey];
    const meta = mapping ?? (await this.eth.tokenMetadata(dep.token));
    const sats = unitsToSats(dep.amountUnits, meta.decimals);
    if (sats === 0n) {
      dep.status = "refund_pending";
      dep.refundReason = "amount below 1e-8 of a token (not representable on Sequentia)";
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
    if (!mapping) {
      dep.steps.pendingIssue = true;
      this.state.save();
      let issued;
      try {
        issued = await this.seq.call("issueasset", {
          assetamount: satsToAmount(sats),
          tokenamount: 1,
          blind: false,
          ...(this.cfg.seqFeeAsset ? { fee_asset: this.cfg.seqFeeAsset } : {}),
        });
      } catch (e) {
        if (typeof e.code === "number") return this.deferMint(dep, "pendingIssue", e);
        throw e;
      }
      if (!(await this.waitWalletTxVisible(issued.txid))) {
        await this.seq.call("abandontransaction", { txid: issued.txid }).catch(() => {});
        return this.deferMint(dep, "pendingIssue", new Error("issuance tx never reached the mempool"));
      }
      mapping = {
        tokenKey: dep.tokenKey,
        chainId: this.cfg.ethChainId,
        token: dep.token,
        symbol: meta.symbol,
        name: meta.name,
        decimals: meta.decimals,
        assetId: issued.asset,
        reissuanceToken: issued.token,
        entropy: issued.entropy,
        issueTxid: issued.txid,
        firstDepositNonce: dep.nonce,
        mintedSats: sats.toString(),
        createdAt: new Date().toISOString(),
      };
      s.mappings[dep.tokenKey] = mapping;
      delete dep.steps.pendingIssue;
      dep.steps.issueTxid = issued.txid;
      this.state.save();
      this.log(
        `deposit #${dep.nonce}: issued NEW Sequentia asset ${issued.asset} for ${meta.symbol} (${dep.tokenKey})`
      );
    } else {
      // Consensus only accepts a reissuance whose token input carries a
      // commitment asset tag, so the reissuance token must sit on a blinded
      // (confidential) output. Sequentia wallets are transparent by default
      // and leave token change unblinded, so re-blind before every reissue.
      await this.ensureBlindedReissuanceToken(mapping);

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
        if (typeof e.code === "number") return this.deferMint(dep, "pendingMint", e);
        throw e;
      }
      if (!(await this.waitWalletTxVisible(re.txid))) {
        // The wallet handed us a txid for a transaction the chain rejected
        // (observed with unblinded token inputs). Roll the wallet back and
        // retry from a clean slate.
        await this.seq.call("abandontransaction", { txid: re.txid }).catch(() => {});
        return this.deferMint(dep, "pendingMint", new Error("reissuance tx never reached the mempool"));
      }
      mapping.mintedSats = (already + sats).toString();
      delete dep.steps.pendingMint;
      dep.steps.mintTxid = re.txid;
      this.state.save();
      this.log(
        `deposit #${dep.nonce}: reissued ${satsToAmount(sats)} of existing asset ${mapping.assetId} (${mapping.symbol})`
      );
    }
    dep.assetId = mapping.assetId;

    await this.sendMinted(dep, mapping);
  }

  /** A mint step failed before anything landed on chain: safe to retry. */
  deferMint(dep, marker, err) {
    delete dep.steps[marker];
    dep.attempts = (dep.attempts ?? 0) + 1;
    dep.status = dep.attempts > 10 ? "failed_manual" : "mint_retry";
    dep.error = err.message;
    this.state.save();
    this.log(`deposit #${dep.nonce}: mint deferred (attempt ${dep.attempts}): ${err.message}`);
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

  /** Move the reissuance token to a confidential address if it currently
   *  sits unblinded (consensus rejects reissuance from unblinded token
   *  inputs; wallet change is unblinded on Sequentia, so this recurs). */
  async ensureBlindedReissuanceToken(mapping) {
    const utxos = await this.seq.call("listunspent", {
      minconf: 0,
      maxconf: 9999999,
      query_options: { asset: mapping.reissuanceToken },
    });
    if (!utxos.length) {
      throw new Error(`reissuance token ${mapping.reissuanceToken} not found in the bridge wallet`);
    }
    const ZERO_BLINDER = "0".repeat(64);
    if (utxos.some((u) => u.assetblinder !== ZERO_BLINDER)) return; // already usable
    const total = utxos.reduce((a, u) => a + Number(u.amount), 0);
    const blindAddr = await this.seq.call("getnewaddress", {
      label: "compages-token",
      address_type: "blech32",
    });
    const txid = await this.seq.call("sendtoaddress", {
      address: blindAddr,
      amount: total,
      assetlabel: mapping.reissuanceToken,
      ...(this.cfg.seqFeeAsset ? { fee_asset_label: this.cfg.seqFeeAsset } : {}),
    });
    this.log(`re-blinded reissuance token for ${mapping.symbol} in ${txid}`);
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
        this.log(`deposit #${dep.nonce}: send rejected (attempt ${dep.attempts}): ${e.message}`);
        return;
      }
      throw e;
    }
    delete dep.steps.pendingSend;
    dep.steps.sendTxid = sendTxid;
    dep.status = "minted";
    delete dep.error;
    this.state.save();
    this.log(`deposit #${dep.nonce}: sent ${satsToAmount(dep.sats)} ${mapping.symbol} in ${sendTxid}`);
  }

  /** Retry deposits that failed at a safely retryable point. */
  async retryDeposits() {
    for (const dep of Object.values(this.state.data.deposits)) {
      if (dep.status === "send_retry") {
        // Minting already happened; only the send to the user is outstanding.
        const mapping = this.state.data.mappings[dep.tokenKey];
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
      const id = refundId(this.cfg.ethChainId, dep.nonce);
      try {
        if (await this.eth.vault.processedRedemptions(id)) {
          dep.status = "refunded";
          this.state.save();
          continue;
        }
        const tokenAddr = dep.token === "eth" ? ethers.ZeroAddress : dep.token;
        const tx = await this.eth.vault.release(tokenAddr, dep.from, dep.amountUnits, id);
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
    const res = await this.seq.call("listsinceblock", {
      blockhash: s.seqLastBlockHash ?? undefined,
      target_confirmations: this.cfg.seqConfirmations,
      include_watchonly: true,
    });

    for (const tx of res.transactions) {
      if (tx.category !== "receive") continue;
      const intent = s.redeemIntents[tx.address];
      if (!intent) continue;
      if (tx.confirmations < 1) continue; // needs a block before we can read its anchor
      const key = `${tx.txid}:${tx.vout}`;
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
    rec.tokenKey = mapping.tokenKey;
    rec.symbol = mapping.symbol;

    const units = satsToUnits(rec.sats, mapping.decimals);
    if (units === 0n) {
      rec.status = "dust_ignored";
      this.state.save();
      this.log(`redemption ${rec.key}: amount too small to represent on Ethereum, needs manual handling`);
      return;
    }
    rec.amountUnits = units.toString();

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

    if (rec.status === "new") {
      if (await this.eth.vault.processedRedemptions(id)) {
        rec.status = "released"; // paid in a previous life; continue to destroy
      } else {
        rec.status = "releasing";
        this.state.save();
        const tokenAddr = rec.tokenKey.endsWith(":eth") ? ethers.ZeroAddress : mapping.token;
        try {
          const tx = await this.eth.vault.release(tokenAddr, rec.ethAddress, rec.amountUnits, id);
          await tx.wait(1);
          rec.releaseTxHash = tx.hash;
          rec.status = "released";
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
      try {
        const burnTxid = await this.destroyAsset(rec.assetId, rec.sats);
        rec.destroyTxid = burnTxid;
        mapping.mintedSats = (BigInt(mapping.mintedSats) - BigInt(rec.sats)).toString();
        rec.status = "done";
        this.state.save();
        this.log(`redemption ${rec.key}: destroyed ${satsToAmount(rec.sats)} ${mapping.symbol} in ${burnTxid}`);
      } catch (e) {
        // Supply bookkeeping only; the user is already paid. Retry later.
        rec.status = "destroy_pending";
        rec.error = e.message;
        this.state.save();
        this.log(`redemption ${rec.key}: destroy failed, will retry: ${e.message}`);
      }
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
        rec.status = (await this.eth.vault.processedRedemptions(rec.redemptionId))
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
}
