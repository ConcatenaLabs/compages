// CCTP V2 Solana encoders and parsers against fixtures produced by the
// reference tooling (Anchor + @solana/web3.js over Circle's V2 IDLs), real
// Iris attestation responses and a devnet simulation. Run: npm test
import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import * as c from "../lib/cctp-sol.js";
import { b58encode, buildTx, keypairFromSeed } from "../lib/sol.js";

const fx = JSON.parse(fs.readFileSync(new URL("./fixtures/cctp-sol.json", import.meta.url)));

// The fixtures' keypairs are ed25519 seeds of sha256(label).
const kp = (label) => keypairFromSeed(crypto.createHash("sha256").update(label).digest());
const ixJson = (ix) => ({
  programId: ix.programId,
  keys: ix.keys.map(({ pubkey, isSigner, isWritable }) => ({ pubkey, isSigner, isWritable })),
  data: Buffer.from(ix.data).toString("hex"),
});
const hex = (b) => Buffer.from(b).toString("hex");

test("instruction and account discriminators match the V2 IDLs", () => {
  for (const idl of Object.values(fx.discriminators)) {
    for (const [name, d] of Object.entries(idl.instructions)) assert.equal(hex(c.ixDiscriminator(name)), d, name);
    for (const [name, d] of Object.entries(idl.accounts)) assert.equal(hex(c.accountDiscriminator(name)), d, name);
  }
});

test("PDAs match the accounts that exist on devnet", () => {
  const p = c.cctpPdas({ remoteDomain: c.DOMAIN.ethereum, remoteToken: "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238" });
  assert.equal(p.messageTransmitter, "W1k5ijkaSTo5iA5zChNpfzcy796fLhkBxfmJuR8W8HU");
  assert.equal(p.tokenMessenger, "AawthJCGRmggpfv9MMWV6Jmo9cue4gL9wUZgRBShg58W");
  assert.equal(p.tokenMinter, "E1bQJ8eMMn3zmeSewW3HQ8zmJr7KR75JonbwAtWx2bux");
  assert.equal(p.senderAuthority, "45hzrGLQ2EGo1Ln7QpXjDwb589GDQ9H2aEXXw6ds6BFE");
  assert.equal(p.localToken, "7MwmWTK2R9Na6rnoSAEt5gytFmSZj9WLVdazvxvru9AU");
  assert.equal(p.custody, "CFUgYpbas5UdJkwwSobYgzhFqFuj6C8MfXwBetE3o4SY");
  assert.equal(p.remoteTokenMessenger, "3EzN2mcmdfSNGXRCAixSpTteK6ywdmFDZZWvkMnznFt9");
  assert.equal(p.tokenPair, "AR6mnr7XRVDUvK7SDGKpREBwGQMxZbKRsY22gXN8bvQU");
  assert.equal(p.tmmEventAuthority, "6TCCnJ9R1m1RXFzyoH7GYH2J6NJDtZaUvfipPuLWxHNd");
  assert.equal(p.mtEventAuthority, "2PcXTomVAbX5Es1NUZUkxwuCm8tvV4NmRk3fmQWFCWoV");
  assert.equal(p.mtAuthority.address, "DsAdX23SVpTPYhKP2ua1mx8gTPqLyzx7a43cyxYjS2up");
  // A used-nonce PDA that devnet created when this message was received.
  const nonce = Buffer.from("2969035912f16d37ed2e1d619159d655027ae7c21f3e220d533e7bc6589c6210", "hex");
  assert.equal(c.usedNonceAddress(nonce), "AtcggFx6MfhzexvKHnYQRjJ4FYAfuApfNKadYtum2EPi");
});

test("deposit_for_burn(_with_hook) instructions and transactions are byte-identical to Anchor/web3.js", () => {
  assert.ok(fx.burn.length >= 10);
  for (const f of fx.burn) {
    const p = f.params;
    const owner = kp(f.seeds.owner);
    const ev = kp(f.seeds.event);
    const payer = kp(f.seeds.payer);
    assert.equal(owner.address, p.owner);
    assert.equal(ev.address, p.messageSentEventData);
    const args = {
      ...p,
      amount: BigInt(p.amount),
      maxFee: BigInt(p.maxFee),
      mintRecipient: Buffer.from(p.mintRecipient, "hex"),
      destinationCaller: Buffer.from(p.destinationCaller, "hex"),
      messageSentEventData: ev,
    };
    const ix = p.hookData
      ? c.depositForBurnWithHookIx({ ...args, hookData: Buffer.from(p.hookData, "hex") })
      : c.depositForBurnIx(args);
    assert.deepEqual(ixJson(ix), f.ix);
    const { tx } = buildTx({ feePayer: payer, signers: [owner, ev], recentBlockhash: f.recentBlockhash, instructions: [ix] });
    assert.equal(hex(tx), f.tx);
  }
});

test("receive_message instructions and transactions are byte-identical to Anchor/web3.js", () => {
  for (const f of fx.receive) {
    const payer = kp(f.seed);
    const ix = c.receiveMessageIx({
      payer: payer.address,
      message: f.message,
      attestation: f.attestation,
      feeRecipient: f.feeRecipient,
      mint: f.mint,
    });
    assert.deepEqual(ixJson(ix), f.ix);
    const { tx } = buildTx({ feePayer: payer, recentBlockhash: f.recentBlockhash, instructions: [ix] });
    assert.equal(hex(tx), f.tx);
    assert.ok(tx.length <= c.MAX_TX_BYTES);
  }
});

test("reclaim_event_account instructions are byte-identical to Anchor", () => {
  for (const f of fx.reclaim) {
    const ix = c.reclaimEventAccountIx({
      payee: f.payee,
      messageSentEventData: f.messageSentEventData,
      attestation: Buffer.from(f.attestation, "hex"),
      destinationMessage: Buffer.from(f.destinationMessage, "hex"),
    });
    assert.deepEqual(ixJson(ix), f.ix);
  }
});

test("parseMessageV2 / parseBurnBodyV2 agree with Iris's own decoding", () => {
  const b32 = (b, domain) =>
    domain === c.DOMAIN.solana ? b58encode(b) : c.bytes32ToEvmAddress(b);
  for (const { raw } of fx.iris) {
    const d = raw.decodedMessage;
    const m = c.parseMessageV2(raw.message);
    const src = Number(d.sourceDomain);
    const dst = Number(d.destinationDomain);
    assert.equal(m.version, 1);
    assert.equal(m.sourceDomain, src);
    assert.equal(m.destinationDomain, dst);
    assert.equal(m.nonceHex, d.nonce);
    assert.equal(m.nonceHex, raw.eventNonce);
    assert.equal(b32(m.sender, src), d.sender);
    assert.equal(b32(m.recipient, dst), d.recipient);
    const caller = m.destinationCaller.every((v) => v === 0) && dst === c.DOMAIN.solana
      ? "11111111111111111111111111111111"
      : dst === c.DOMAIN.solana ? b58encode(m.destinationCaller) : "0x" + hex(m.destinationCaller);
    assert.equal(caller, d.destinationCaller);
    assert.equal(m.minFinalityThreshold, Number(d.minFinalityThreshold));
    assert.equal(m.finalityThresholdExecuted, Number(d.finalityThresholdExecuted));
    assert.equal("0x" + hex(m.body), d.messageBody);

    const b = c.parseBurnBodyV2(m.body);
    const db = d.decodedMessageBody;
    assert.equal(b.version, 1);
    assert.equal(b32(b.burnToken, src), db.burnToken);
    assert.equal(b32(b.mintRecipient, dst), db.mintRecipient);
    assert.equal(b.amount, BigInt(db.amount));
    assert.equal(b32(b.messageSender, src), db.messageSender);
    assert.equal(b.maxFee, BigInt(db.maxFee));
    assert.equal(b.feeExecuted, BigInt(db.feeExecuted));
    assert.equal(b.expirationBlock, BigInt(db.expirationBlock));
    assert.equal(b.hookData.length, 0);
  }
});

test("decodeMessageSentAccount reads Anchor's encoding and a devnet-simulated burn", () => {
  const a = c.decodeMessageSentAccount(Buffer.from(fx.messageSentAccount.data, "hex"));
  assert.equal(a.rentPayer, fx.messageSentAccount.rentPayer);
  assert.equal(a.createdAt, fx.messageSentAccount.createdAt);

  // The event account deposit_for_burn_with_hook created in a devnet simulation
  // of 1 USDC from the bridge treasury toward the Sepolia vault.
  const sim = fx.simulatedBurnEventAccount;
  assert.equal(sim.owner, c.MESSAGE_TRANSMITTER_V2);
  const ev = c.decodeMessageSentAccount(Buffer.from(sim.data, "hex"));
  assert.equal(ev.rentPayer, "76ZPjfcZGjidKPm9eqmCADKvkYzsEfTwv1wroANJZuhv");
  const m = c.parseMessageV2(ev.message);
  assert.equal(m.sourceDomain, c.DOMAIN.solana);
  assert.equal(m.destinationDomain, c.DOMAIN.ethereum);
  assert.equal(m.nonceHex, "0x" + "00".repeat(32)); // Iris assigns it
  assert.equal(m.finalityThresholdExecuted, 0);
  assert.equal(m.minFinalityThreshold, 2000);
  assert.equal(b58encode(m.sender), c.TOKEN_MESSENGER_MINTER_V2);
  assert.equal(c.bytes32ToEvmAddress(m.recipient), "0x8fe6b999dc680ccfdd5bf7eb0974218be2542daa");
  assert.equal(c.bytes32ToEvmAddress(m.destinationCaller), "0x15b3c97ed82c62b7828a775456bd75e67a8ec42c");
  const b = c.parseBurnBodyV2(m.body);
  assert.equal(b58encode(b.burnToken), c.DEVNET_USDC_MINT);
  assert.equal(c.bytes32ToEvmAddress(b.mintRecipient), "0x15b3c97ed82c62b7828a775456bd75e67a8ec42c");
  assert.equal(b.amount, 1_000_000n);
  assert.equal(b58encode(b.messageSender), "76ZPjfcZGjidKPm9eqmCADKvkYzsEfTwv1wroANJZuhv");
  assert.equal(b.maxFee, 0n);
  assert.equal(b.hookData.toString(), "compages:rebalance");
});

test("irisMessages normalizes complete, pending and not-yet-indexed responses", async () => {
  const realFetch = globalThis.fetch;
  const raw = fx.iris[0].raw;
  const responses = [
    { status: 200, body: { messages: [raw] } },
    { status: 200, body: { messages: [{ message: "0x", attestation: "PENDING", eventNonce: raw.eventNonce, status: "pending_confirmations" }] } },
    { status: 404, body: { code: 404, message: "Not found." } },
  ];
  const urls = [];
  globalThis.fetch = async (url) => {
    urls.push(url);
    const r = responses.shift();
    return { status: r.status, ok: r.status === 200, text: async () => JSON.stringify(r.body) };
  };
  try {
    const [done] = await c.irisMessages({ sourceDomain: 0, txHash: fx.iris[0].txHash });
    assert.equal(done.status, "complete");
    assert.equal("0x" + hex(done.message), raw.message);
    assert.equal("0x" + hex(done.attestation), raw.attestation);
    assert.equal(done.eventNonce, raw.eventNonce);
    assert.equal(done.destinationMintTxHash, raw.destinationMintTxHash);
    const [pending] = await c.irisMessages({ sourceDomain: 5, txHash: "sig" });
    assert.equal(pending.message, null);
    assert.equal(pending.attestation, null);
    assert.deepEqual(await c.irisMessages({ sourceDomain: 5, txHash: "sig" }), []);
    assert.equal(urls[0], `${c.IRIS_SANDBOX}/v2/messages/0?transactionHash=${fx.iris[0].txHash}`);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("input validation", () => {
  const evm = "0x15B3c97eD82C62b7828A775456Bd75e67A8eC42C";
  assert.equal(hex(c.toBytes32(evm)), "00".repeat(12) + evm.slice(2).toLowerCase());
  assert.equal(b58encode(c.toBytes32(c.DEVNET_USDC_MINT)), c.DEVNET_USDC_MINT);
  assert.throws(() => c.toBytes32("0x1234"));
  const base = {
    owner: c.DEVNET_USDC_MINT,
    ownerTokenAccount: c.DEVNET_USDC_MINT,
    amount: 1n,
    destinationDomain: 0,
    mintRecipient: evm,
    messageSentEventData: c.DEVNET_USDC_MINT,
  };
  assert.throws(() => c.depositForBurnWithHookIx({ ...base, hookData: "" }), /hookData/);
  assert.throws(() => c.depositForBurnIx({ ...base, mintRecipient: Buffer.alloc(32) }), /mintRecipient/);
  // A message addressed to a program other than TokenMessengerMinterV2.
  const msg = Buffer.from(fx.iris[0].raw.message.slice(2), "hex");
  msg.fill(0, 76, 108);
  assert.throws(() => c.receiveMessageIx({ payer: c.DEVNET_USDC_MINT, message: msg, attestation: "0x", feeRecipient: c.DEVNET_USDC_MINT }), /recipient/);
});

test("receive compute estimate tracks the measured cost", () => {
  // Measured by executing this message's receive against the devnet binaries.
  const measured = 179_545;
  const est = c.estimateReceiveComputeUnits(fx.iris[1].raw.message);
  assert.ok(Math.abs(est - measured) < 200, `estimate ${est} vs measured ${measured}`);
  assert.ok(est < c.RECEIVE_CU_LIMIT);
});
