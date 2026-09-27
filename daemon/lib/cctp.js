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
import { buildTx, ataAddress, ataCreateIdempotent, b58encode, b58decode, TOKEN_PROGRAM } from "./sol.js";
import { unitsToAtoms } from "./eth.js";
import {
  depositForBurnWithHookIx,
  receiveMessageIx,
  readTokenMessenger,
  isNonceUsed,
  estimateReceiveComputeUnits,
  RECEIVE_CU_LIMIT,
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

/** The CCTP chains the bridge accepts USDC from and pays USDC out to, each
 *  checked on its own chain: the transmitter's localDomain, and Circle's USDC
 *  at the address given. Testnets; a deployment on mainnets configures
 *  `cctp.chains` instead. EVM chains share Circle's contract addresses. */
export const CCTP_TESTNET_CHAINS = [
  { domain: 6, name: "Base Sepolia", chainId: 84532, usdc: "0x036CbD53842c5426634e7929541eC2318f3dCF7e", rpc: "https://sepolia.base.org", explorer: "https://sepolia.basescan.org" },
  { domain: 3, name: "Arbitrum Sepolia", chainId: 421614, usdc: "0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d", rpc: "https://sepolia-rollup.arbitrum.io/rpc", explorer: "https://sepolia.arbiscan.io" },
  { domain: 2, name: "OP Sepolia", chainId: 11155420, usdc: "0x5fd84259d66Cd46123540766Be93DFE6D43130D7", rpc: "https://sepolia.optimism.io", explorer: "https://sepolia-optimism.etherscan.io" },
  { domain: 1, name: "Avalanche Fuji", chainId: 43113, usdc: "0x5425890298aed601595a70AB815c96711a31Bc65", rpc: "https://api.avax-test.network/ext/bc/C/rpc", explorer: "https://testnet.snowtrace.io" },
  { domain: 10, name: "Unichain Sepolia", chainId: 1301, usdc: "0x31d0220469e10c4E71834a79b1f276d740d3768F", rpc: "https://sepolia.unichain.org", explorer: "https://sepolia.uniscan.xyz" },
  { domain: 11, name: "Linea Sepolia", chainId: 59141, usdc: "0xFEce4462D57bD51A6A552365A011b95f0E16d9B7", rpc: "https://rpc.sepolia.linea.build", explorer: "https://sepolia.lineascan.build" },
  { domain: 14, name: "World Chain Sepolia", chainId: 4801, usdc: "0x66145f38cBAC35Ca6F1Dfb4914dF98F1614aeA88", rpc: "https://worldchain-sepolia.g.alchemy.com/public", explorer: "https://worldchain-sepolia.explorer.alchemy.com" },
];
export const CCTP_EVM_TOKEN_MESSENGER = "0x8FE6B999Dc680CcFDD5Bf7EB0974218be2542DAA";
export const CCTP_EVM_MESSAGE_TRANSMITTER = "0xE737e5cEBEEBa77EFE34D4aa090756590b1CE275";

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
      // Releases already on their way out of the treasury are not movable:
      // a burn and a release competing for the same funds leaves one waiting.
      let inFlight = 0n;
      for (const r of Object.values(this.bridge.state.data.solRedemptions ?? {})) {
        if (r.tokenKey === src.tokenKey && !r.viaCctp && ["new", "releasing"].includes(r.status)) {
          inFlight += BigInt(r.amountUnits ?? "0");
        }
      }
      const movable = (held < ledger ? held : ledger) - inFlight - BigInt(this.c.solFloatUnits ?? "5000000");
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

  // ================= USDC from and to other chains =================
  //
  // A user on another CCTP chain burns USDC there naming the deposit vault as
  // mintRecipient and as destinationCaller, with hookData
  // "compages:deposit:<Sequentia address>" (the page builds this call). The
  // page reports the burn here; the daemon fetches Circle's attestation and
  // relays it through vault.receiveCctp, which emits an ordinary Deposited
  // event that the deposit scan mints against like any other. A deposit the
  // bridge cannot deliver, or an arrival for no recognised purpose, is
  // refunded to its source chain with refundViaCctp.
  //
  // Redemptions can be paid out on another CCTP chain the same way in
  // reverse: the vault burns the USDC (releaseViaCctp), and the recipient
  // claims it on the destination chain with the attestation this module
  // fetches (a Solana payout is relayed by the daemon itself).

  get chains() {
    return this.c.chains ?? CCTP_TESTNET_CHAINS;
  }

  chain(domain) {
    return this.chains.find((c) => c.domain === Number(domain)) ?? null;
  }

  get inbound() {
    const s = this.bridge.state.data;
    return (s.cctpInbound ??= {});
  }

  /** The vault that receives CCTP deposits: the one the page deposits into. */
  depositVault() {
    return this.bridge.eth.vaultFor(this.cfg.depositVault ?? this.cfg.vaultAddress);
  }

  /** Record a burn a user made on another chain, to be relayed. */
  registerInbound(sourceDomain, txHash) {
    const d = Number(sourceDomain);
    if (!this.chain(d)) throw Object.assign(new Error("this chain is not one the bridge accepts USDC from"), { badRequest: true });
    if (!/^0x[0-9a-fA-F]{64}$/.test(String(txHash))) throw Object.assign(new Error("invalid transaction hash"), { badRequest: true });
    const key = `${d}:${String(txHash).toLowerCase()}`;
    this.inbound[key] ??= { key, sourceDomain: d, txHash: String(txHash).toLowerCase(), stage: "attesting", createdAt: new Date().toISOString() };
    this.bridge.state.save();
    return this.inbound[key];
  }

  /** Move every reported burn along: attestation, then the relay. */
  async advanceInbound() {
    if (!this.c.enabled) return;
    for (const rec of Object.values(this.inbound)) {
      if (!["attesting", "relaying"].includes(rec.stage)) continue;
      try {
        await this.bridge.withRecord(`cctpin:${rec.key}`, () => this.stepInbound(rec));
      } catch (e) {
        rec.error = e.message;
        this.bridge.state.save();
      }
    }
  }

  async stepInbound(rec) {
    const bridge = this.bridge;
    const vault = this.depositVault();
    const vaultAddr = (await vault.getAddress()).toLowerCase();
    if (rec.stage === "attesting") {
      const msgs = await irisMessages({ sourceDomain: rec.sourceDomain, txHash: rec.txHash, baseUrl: this.iris });
      // A transaction can carry several messages; take the one addressed to
      // this bridge: minted to the vault (all 32 bytes), relayable by it.
      const vault32 = ethers.zeroPadValue(vaultAddr, 32).toLowerCase();
      const forUs = (x) => {
        try {
          const hh = parseMessageV2(x.message);
          const bb = parseBurnBodyV2(hh.body);
          const caller = `0x${Buffer.from(hh.destinationCaller).toString("hex")}`;
          return (
            hh.destinationDomain === DOMAIN.ethereum &&
            `0x${Buffer.from(bb.mintRecipient).toString("hex")}` === vault32 &&
            (caller === vault32 || /^0x0{64}$/.test(caller))
          );
        } catch {
          return false;
        }
      };
      const complete = msgs.filter((x) => x.status === "complete" && x.message && x.attestation);
      const m = complete.find(forUs) ?? complete[0];
      if (!m) {
        const ageH = (Date.now() - Date.parse(rec.createdAt)) / 3_600_000;
        rec.waiting = msgs.length ? "waiting for Circle's attestation" : "Circle has not seen this burn yet";
        if (ageH > (this.c.inboundGiveUpHours ?? 6) && !msgs.length) rec.stage = "not_found";
        bridge.state.save();
        return;
      }
      const h = parseMessageV2(m.message);
      const body = parseBurnBodyV2(h.body);
      const mintRecipient = `0x${Buffer.from(body.mintRecipient).subarray(12).toString("hex")}`.toLowerCase();
      if (h.destinationDomain !== DOMAIN.ethereum || mintRecipient !== vaultAddr) {
        rec.stage = "not_for_bridge";
        rec.error = "this burn does not mint to the bridge's vault on Ethereum";
        bridge.state.save();
        return;
      }
      rec.message = `0x${m.message.toString("hex")}`;
      rec.attestation = `0x${m.attestation.toString("hex")}`;
      rec.nonce = `0x${Buffer.from(h.nonce).toString("hex")}`;
      rec.amount = body.amount.toString();
      rec.stage = "relaying";
      delete rec.waiting;
      bridge.state.save();
    }
    if (rec.stage === "relaying") {
      if ((await this.transmitter.usedNonces(rec.nonce)) !== 0n) {
        rec.stage = "relayed";
        bridge.state.save();
        return;
      }
      if (rec.ethTx && (await bridge.eth.sentTxState(rec.ethTx)) === "pending") return;
      try {
        const receipt = await bridge.eth.sendAndWait(vault, "receiveCctp", [rec.message, rec.attestation], (sent) => {
          rec.ethTx = sent;
          bridge.state.save();
        });
        if (receipt?.status === 1) {
          rec.relayTx = receipt.hash;
          rec.stage = "relayed";
          delete rec.waiting;
          bridge.state.save();
          bridge.log(`cctp inbound ${rec.key}: relayed in ${receipt.hash}`);
        }
      } catch (e) {
        if (e?.code !== "CALL_EXCEPTION" || typeof e.data !== "string") throw e;
        const name = bridge.eth.revertName(e.data) ?? e.data;
        rec.waiting = name === "DepositsArePaused" ? "deposits are paused on the vault" : `the vault refused it (${name})`;
        bridge.state.save();
      }
    }
  }

  /** The address a CCTP refund to `sourceDomain` mints to, for a burn made
   *  by `sender` (bytes32 hex). On an EVM chain that is the sender itself; on
   *  Solana, CCTP mints into a token account, so it is the sender's USDC
   *  associated token account. */
  refundRecipient(sourceDomain, sender) {
    if (Number(sourceDomain) !== DOMAIN.solana) return sender;
    const owner = b58encode(Buffer.from(sender.replace(/^0x/, ""), "hex"));
    const mint = this.solUsdcMint();
    return `0x${Buffer.from(b58decode(ataAddress(owner, mint, TOKEN_PROGRAM))).toString("hex")}`;
  }

  solUsdcMint() {
    for (const { sol } of this.assets()) if (sol) return sol.token;
    return this.c.solUsdcMint ?? "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU";
  }

  /** After a payout to another chain, fetch Circle's attestation so the
   *  recipient can claim it there, and notice once they have. */
  async advanceOutbound() {
    if (!this.c.enabled) return;
    const s = this.bridge.state.data;
    for (const rec of [...Object.values(s.redemptions), ...Object.values(s.deposits)]) {
      const o = rec.cctpOut;
      if (!o || o.stage === "claimed" || !o.burnTx) continue;
      try {
        const msgs = await irisMessages({ sourceDomain: DOMAIN.ethereum, txHash: o.burnTx, baseUrl: this.iris });
        const m = msgs.find((x) => x.status === "complete" && x.message && x.attestation);
        if (!m) continue;
        o.message = `0x${m.message.toString("hex")}`;
        o.attestation = `0x${m.attestation.toString("hex")}`;
        o.stage = m.destinationMintTxHash ? "claimed" : "claimable";
        if (m.destinationMintTxHash) o.claimTx = m.destinationMintTxHash;
        // A payout to Solana is relayed by the daemon; elsewhere the
        // recipient claims it with the attestation now recorded.
        if (o.domain === DOMAIN.solana && o.stage !== "claimed" && this.bridge.sol) {
          if (await this.relayToSolana(o)) {
            o.stage = "claimed";
            o.claimTx = o.solTx?.signature ?? null;
          }
        }
        this.bridge.state.save();
      } catch (e) {
        o.error = e.message;
      }
    }
  }

  /** Relay a payout the vault burned toward Solana: create the recipient's
   *  USDC account if needed, then receive_message, paid by the treasury.
   *  Persist-before-broadcast like every Solana transfer. Returns true once
   *  the USDC is minted on Solana. */
  async relayToSolana(o) {
    const sol = this.bridge.sol;
    const treasury = sol.treasury;
    if (!o.message || !o.attestation) return false;
    const h = parseMessageV2(Buffer.from(o.message.slice(2), "hex"));
    if (await isNonceUsed(sol, h.nonce)) return true;
    if (o.solTx) {
      const fate = await this.bridge.solTransferFate(o.solTx);
      if (fate === "pending") return false;
      if (fate === "landed") return true;
      delete o.solTx;
    }
    if (estimateReceiveComputeUnits(Buffer.from(o.message.slice(2), "hex")) > RECEIVE_CU_LIMIT) {
      o.error = "this message needs more compute than a single legacy Solana transaction allows";
      return false;
    }
    const body = parseBurnBodyV2(h.body);
    const recipientAta = b58encode(Buffer.from(body.mintRecipient));
    const mint = this.solUsdcMint();
    const bh = await sol.latestBlockhash();
    if (!o.ataReady) {
      // The program mints only into an existing token account, and creating
      // one in the same transaction would not fit, so it goes first.
      const acct = await sol.rpc("getAccountInfo", [recipientAta, { encoding: "base64", commitment: "confirmed" }]);
      if (!acct?.value) {
        if (!o.owner) throw new Error("the recipient's USDC account does not exist and its owner is unknown");
        const built = buildTx({
          feePayer: treasury,
          recentBlockhash: bh.blockhash,
          instructions: [ataCreateIdempotent({ payer: treasury.address, ata: recipientAta, owner: o.owner, mint })],
        });
        await sol.send(built.tx);
        return false; // the next pass relays once the account exists
      }
      o.ataReady = true;
    }
    const tm = await readTokenMessenger(sol);
    const ix = receiveMessageIx({
      payer: treasury.address,
      caller: treasury.address,
      message: Buffer.from(o.message.slice(2), "hex"),
      attestation: Buffer.from(o.attestation.slice(2), "hex"),
      feeRecipient: tm.feeRecipient,
      mint,
    });
    const built = buildTx({ feePayer: treasury, recentBlockhash: bh.blockhash, instructions: [ix] });
    o.solTx = { signature: built.signature, lastValidBlockHeight: bh.lastValidBlockHeight };
    this.bridge.state.save(); // persisted BEFORE broadcast
    await sol.send(built.tx);
    this.bridge.log(`cctp: relaying a payout to Solana (${built.signature})`);
    return false;
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

  /** Consolidations of `assetId` still in flight or finished within
   *  `withinMs`, with what identifies each on chain: the Solana burn and
   *  the CCTP nonce. A reserve snapshot taken at a past height uses these
   *  to find transfers that were in flight AT that height, which the
   *  current in-flight list no longer shows once they have landed. */
  recentTransfers(assetId, withinMs = 7 * 24 * 3600_000) {
    const since = Date.now() - withinMs;
    const out = [];
    for (const r of Object.values(this.records)) {
      if (r.assetId !== assetId || !r.burn?.signature) continue;
      if (r.stage === "burning") continue; // nothing has left the treasury for certain yet
      if (r.stage === "done" && Date.parse(r.doneAt ?? 0) < since) continue;
      out.push({
        id: r.id,
        amount: r.amount,
        solanaBurn: r.burn.signature,
        nonce: r.nonce ?? null,
        stage: r.stage,
        doneAt: r.doneAt ?? null,
      });
    }
    return out;
  }
}
