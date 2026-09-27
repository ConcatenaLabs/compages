// Circle CCTP V2 for the unified stablecoins: moving escrow from Solana into
// the Ethereum vault through Circle's own burn-and-mint.
//
// Why: a unified asset (USDC.e) is backed by USDC escrowed on every chain it
// arrives from. Circle adopts a bridged USDC by burning ONE escrow, so the
// escrow should end up in one place. Deposits keep arriving on Solana (that
// is the easy path for a Solana user), and this module moves what the Solana
// treasury holds beyond a working float into the Ethereum vault that already
// escrows the Ethereum side: USDC is burned on Solana and minted by Circle on
// Ethereum, with no third-party wrapper anywhere in the backing.
//
// One consolidation is a record in state.cctpTransfers moving through:
//
//   burning     the Solana burn is built, signed, persisted, then sent; its
//               signature is the replay guard, exactly as for Solana releases
//   attesting   the burn landed; waiting for Circle's attestation
//   relaying    attested; the operator submits receiveMessage on Ethereum
//               (anyone may, since the message names no destination caller;
//               the message's nonce tells whether someone already did)
//   done        minted into the vault; escrow ledgers moved accordingly
//
// While a record is attesting or relaying its amount is IN TRANSIT: already
// debited from the Solana escrow, not yet credited to the Ethereum one. The
// reserves page and the supply invariant count it, so a transfer in flight
// never reads as a shortfall.

import { ethers } from "ethers";
import { buildTx, ataAddress, TOKEN_PROGRAM } from "./sol.js";
import { unitsToAtoms } from "./eth.js";
import {
  depositForBurnWithHookIx,
  reclaimEventAccountIx,
  readMessageSent,
  EVENT_ACCOUNT_WINDOW_SECONDS,
  eventDataKeypair,
  irisMessages,
  parseMessageV2,
  parseBurnBodyV2,
  DOMAIN,
  FINALITY,
  IRIS_SANDBOX,
} from "./cctp-sol.js";
import { sourcesOf, unifiedKeyOf } from "./bridge.js";

const TRANSMITTER_ABI = [
  "function receiveMessage(bytes message, bytes attestation) returns (bool)",
  "function usedNonces(bytes32 nonce) view returns (uint256)",
];

// Rent for the MessageSent account the burn creates (446 bytes with our hook
// at current devnet rates is about 2.92M lamports), plus two signatures.
// Checked with margin so a burn is never attempted by a treasury that would
// then fail on chain.
const BURN_LAMPORTS_NEEDED = 4_000_000n;

export class Cctp {
  /** @param {object} cfg daemon config; `cctp` holds this module's settings
   *  @param {import('./bridge.js').Bridge} bridge */
  constructor(cfg, bridge) {
    this.cfg = cfg;
    this.c = cfg.cctp ?? {};
    this.bridge = bridge;
    this.iris = this.c.irisUrl ?? IRIS_SANDBOX;
    this.transmitter = this.c.messageTransmitter
      ? new ethers.Contract(this.c.messageTransmitter, TRANSMITTER_ABI, bridge.eth.wallet)
      : null;
  }

  get enabled() {
    return Boolean(this.c.enabled && this.transmitter && this.bridge.sol);
  }

  get records() {
    const s = this.bridge.state.data;
    return (s.cctpTransfers ??= {});
  }

  /** The unified mappings this module moves, each with its Solana and its
   *  Ethereum source. */
  assets() {
    const s = this.bridge.state.data;
    const out = [];
    for (const symbol of this.c.assets ?? ["USDC"]) {
      const m = s.mappings[unifiedKeyOf(symbol)];
      if (!m) continue;
      const srcs = Object.values(sourcesOf(m));
      const sol = srcs.find((x) => x.chainId === (this.cfg.solChainLabel ?? "solana-devnet"));
      const eth = srcs.find((x) => x.chainId === this.cfg.ethChainId);
      if (sol && eth?.vault) out.push({ mapping: m, sol, eth });
    }
    return out;
  }

  /** Start a consolidation when the Solana treasury holds more than the
   *  float, at most one in flight per asset and one attempt per interval. */
  async consolidate() {
    if (!this.enabled) return;
    const every = (this.c.consolidateEveryMinutes ?? 30) * 60_000;
    if (this._lastConsolidate && Date.now() - this._lastConsolidate < every) return;
    this._lastConsolidate = Date.now();
    const sol = this.bridge.sol;
    await sol.ensureCluster();
    for (const { mapping, sol: src, eth } of this.assets()) {
      if (Object.values(this.records).some((r) => r.assetId === mapping.assetId && r.stage !== "done")) continue;
      const treasury = sol.treasury;
      const ata = ataAddress(treasury.address, src.token, src.tokenProgram ?? TOKEN_PROGRAM);
      const held = await sol.escrowBalance(treasury.address, src.token, src.tokenProgram ?? TOKEN_PROGRAM);
      const ledger = BigInt(src.escrowedUnits ?? "0");
      const movable = (held < ledger ? held : ledger) - BigInt(this.c.solFloatUnits ?? "5000000");
      if (movable < BigInt(this.c.minConsolidateUnits ?? "1000000")) continue;
      if ((await sol.balance(treasury.address)) < BURN_LAMPORTS_NEEDED) {
        this.bridge.log(`cctp ${mapping.symbol}: treasury lamports too low to pay for a burn; waiting`);
        continue;
      }
      // A vault that can receive CCTP itself (version 3) is named as the
      // only relayer, and relaying through it records the arrival as a
      // RebalancedIn event; an older vault just receives the mint.
      const viaVault = (await this.bridge.eth.vaultVersion(this.bridge.eth.vaultFor(eth.vault))) >= 3;
      const s = this.bridge.state.data;
      const index = (s.cctpEventIndex = (s.cctpEventIndex ?? 0) + 1);
      const id = `cctp-${mapping.symbol}-${index}`;
      this.records[id] = {
        id,
        kind: "consolidate",
        assetId: mapping.assetId,
        symbol: mapping.symbol,
        mappingKey: mapping.tokenKey,
        fromTokenKey: src.tokenKey,
        toTokenKey: eth.tokenKey,
        mint: src.token,
        decimals: src.decimals,
        precision: mapping.precision ?? 8,
        tokenProgram: src.tokenProgram ?? TOKEN_PROGRAM,
        sourceAta: ata,
        vault: eth.vault,
        viaVault,
        amount: movable.toString(),
        eventIndex: index,
        stage: "burning",
        steps: {},
        createdAt: new Date().toISOString(),
      };
      this.bridge.state.save();
      this.bridge.log(`cctp ${mapping.symbol}: moving ${movable} units from the Solana treasury to vault ${eth.vault}`);
      await this.sendBurn(this.records[id]);
    }
  }

  /** Build, persist, then broadcast the Solana burn for `rec`. */
  async sendBurn(rec) {
    const sol = this.bridge.sol;
    const treasury = sol.treasury;
    const eventKp = eventDataKeypair(sol.masterSeed, rec.eventIndex);
    const bh = await sol.latestBlockhash();
    const ix = depositForBurnWithHookIx({
      owner: treasury.address,
      ownerTokenAccount: rec.sourceAta,
      amount: BigInt(rec.amount),
      destinationDomain: DOMAIN.ethereum,
      mintRecipient: rec.vault,
      destinationCaller: rec.viaVault ? rec.vault : null,
      maxFee: 0n,
      minFinalityThreshold: FINALITY.standard,
      hookData: "compages:rebalance",
      messageSentEventData: eventKp,
      eventRentPayer: treasury.address,
      mint: rec.mint,
    });
    const built = buildTx({ feePayer: treasury, signers: [eventKp], instructions: [ix], recentBlockhash: bh.blockhash });
    rec.burn = { signature: built.signature, lastValidBlockHeight: bh.lastValidBlockHeight };
    rec.burnExpiredChecks = 0;
    this.bridge.state.save(); // persisted BEFORE broadcast: a crash cannot burn twice
    await sol.send(built.tx);
    this.bridge.log(`cctp ${rec.id}: burn sent (${built.signature})`);
  }

  /** Drive every unfinished consolidation one step. */
  async advance() {
    if (!this.enabled) return;
    for (const rec of Object.values(this.records)) {
      if (rec.stage === "done") continue;
      try {
        await this.bridge.withRecord(`cctp:${rec.id}`, () => this.step(rec));
      } catch (e) {
        rec.error = e.message;
        this.bridge.state.save();
        this.bridge.log(`cctp ${rec.id}: ${e.message}`);
      }
    }
  }

  async step(rec) {
    const bridge = this.bridge;
    const mapping = bridge.state.data.mappings[rec.mappingKey];
    if (rec.stage === "burning") {
      const fate = await bridge.solTransferFate(rec.burn);
      if (fate === "pending") return;
      if (fate === "landed") {
        bridge.debitEscrow(mapping, rec.fromTokenKey, rec.amount, rec);
        rec.stage = "attesting";
        rec.burnedAt = new Date().toISOString();
        bridge.state.save();
        bridge.log(`cctp ${rec.id}: burned on Solana; waiting for Circle's attestation`);
        return;
      }
      if (fate === "expired") {
        // Two consecutive expired verdicts before rebuilding, as for releases.
        rec.burnExpiredChecks = (rec.burnExpiredChecks ?? 0) + 1;
        bridge.state.save();
        if (rec.burnExpiredChecks < 2) return;
      }
      // Failed on chain, or provably never landed: nothing moved. Rebuild
      // with the same event account (it was never created).
      await this.sendBurn(rec);
      return;
    }
    if (rec.stage === "attesting") {
      const msgs = await irisMessages({ sourceDomain: DOMAIN.solana, txHash: rec.burn.signature, baseUrl: this.iris });
      const m = msgs.find((x) => x.status === "complete" && x.message && x.attestation);
      if (!m) return;
      const header = parseMessageV2(m.message);
      const body = parseBurnBodyV2(header.body);
      rec.message = `0x${m.message.toString("hex")}`;
      rec.attestation = `0x${m.attestation.toString("hex")}`;
      rec.nonce = `0x${header.nonce.toString("hex")}`;
      rec.feeExecuted = body.feeExecuted.toString();
      rec.stage = "relaying";
      bridge.state.save();
      bridge.log(`cctp ${rec.id}: attested; relaying to Ethereum`);
    }
    if (rec.stage === "relaying") {
      if ((await this.transmitter.usedNonces(rec.nonce)) !== 0n) return this.finish(rec, mapping);
      if (rec.ethTx) {
        const st = await bridge.eth.sentTxState(rec.ethTx);
        if (st === "pending") return;
        delete rec.ethTx; // reverted, dropped or displaced; the nonce check above said it did not land
      }
      const [target, method] = rec.viaVault
        ? [bridge.eth.vaultFor(rec.vault), "receiveCctp"]
        : [this.transmitter, "receiveMessage"];
      const receipt = await bridge.eth.sendAndWait(target, method, [rec.message, rec.attestation], (sent) => {
        rec.ethTx = sent;
        bridge.state.save();
      });
      if (receipt?.status === 1) return this.finish(rec, mapping);
    }
  }

  finish(rec, mapping) {
    const credited = BigInt(rec.amount) - BigInt(rec.feeExecuted ?? "0");
    this.bridge.creditEscrow(mapping, rec.toTokenKey, credited, rec);
    rec.stage = "done";
    rec.doneAt = new Date().toISOString();
    rec.creditedUnits = credited.toString();
    delete rec.error;
    this.bridge.state.save();
    this.bridge.log(`cctp ${rec.id}: ${credited} units now escrowed in vault ${rec.vault}`);
  }

  /** Take back the rent of each burn's MessageSent account. Circle's
   *  program keeps the account (and the treasury's rent in it) until five
   *  days after the burn, then lets the rent payer close it with the
   *  attested message. Replay-guarded like every Solana transfer: the
   *  signature is persisted before broadcast, and the account's absence
   *  afterwards is the proof it was closed. */
  async reclaim() {
    if (!this.enabled) return;
    const sol = this.bridge.sol;
    const windowMs = (EVENT_ACCOUNT_WINDOW_SECONDS + 3600) * 1000;
    for (const rec of Object.values(this.records)) {
      if (rec.stage !== "done" || rec.reclaimed || !rec.burnedAt || !rec.attestation) continue;
      if (Date.now() - Date.parse(rec.burnedAt) < windowMs) continue;
      await this.bridge.withRecord(`cctp:${rec.id}`, async () => {
        const eventKp = eventDataKeypair(sol.masterSeed, rec.eventIndex);
        if (rec.reclaimTx) {
          const fate = await this.bridge.solTransferFate(rec.reclaimTx);
          if (fate === "pending") return;
          if (fate !== "landed") delete rec.reclaimTx; // failed or expired: try again below
        }
        const account = await readMessageSent(sol, eventKp.address);
        if (!account) {
          rec.reclaimed = true;
          rec.reclaimedAt = new Date().toISOString();
          this.bridge.state.save();
          this.bridge.log(`cctp ${rec.id}: event account closed; its rent is back in the treasury`);
          return;
        }
        if (rec.reclaimTx) return; // landed but the RPC still shows the account: next tick
        const bh = await sol.latestBlockhash();
        const ix = reclaimEventAccountIx({
          payee: sol.treasury.address,
          messageSentEventData: eventKp.address,
          attestation: rec.attestation,
          destinationMessage: rec.message,
        });
        const built = buildTx({ feePayer: sol.treasury, instructions: [ix], recentBlockhash: bh.blockhash });
        rec.reclaimTx = { signature: built.signature, lastValidBlockHeight: bh.lastValidBlockHeight };
        this.bridge.state.save(); // persisted BEFORE broadcast
        await sol.send(built.tx);
        this.bridge.log(`cctp ${rec.id}: reclaiming the event account's rent (${built.signature})`);
      });
    }
  }

  /** Atoms of `assetId` burned on one chain and not yet minted on the other.
   *  Also lists the burns, so a reader can check each one on chain. */
  inTransit(assetId) {
    let atoms = 0n;
    const burns = [];
    for (const r of Object.values(this.records)) {
      if (r.assetId !== assetId || !["attesting", "relaying"].includes(r.stage)) continue;
      atoms += unitsToAtoms(r.amount, r.decimals ?? 6, r.precision ?? 6);
      burns.push({ id: r.id, amount: r.amount, solanaBurn: r.burn?.signature ?? null, stage: r.stage });
    }
    return { atoms, burns };
  }
}
