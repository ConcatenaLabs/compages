// Circle CCTP V2 on Solana: instruction builders, message parsers and an Iris
// client, hand-encoded like the rest of sol.js so the daemon stays free of
// @solana/web3.js and Anchor.
//
// Two flows use it:
//   - burn:    deposit_for_burn_with_hook on TokenMessengerMinterV2 burns USDC
//              from a token account and has MessageTransmitterV2 write the
//              outgoing message into a fresh "MessageSent event data" account.
//   - receive: receive_message on MessageTransmitterV2 checks Circle's
//              attestation, records the nonce in a per-nonce PDA, and CPIs into
//              TokenMessengerMinterV2 (handle_receive_finalized_message or
//              handle_receive_unfinalized_message, chosen by the program from
//              the message's finalityThresholdExecuted), which pays the USDC
//              out of its custody account into the message's mintRecipient.
//
// Account order, signer/writable flags, PDA seeds and discriminators follow the
// V2 Anchor IDLs and program source in circlefin/solana-cctp-contracts
// (programs/v2, examples/target/idl/*_v2.json). The encodings are checked
// byte-for-byte against @coral-xyz/anchor + @solana/web3.js output by
// test/cctp-sol.test.js, whose fixtures were produced by those libraries.

import crypto from "node:crypto";
import {
  b58decode,
  b58encode,
  findProgramAddress,
  ataAddress,
  keypairFromSeed,
  SYSTEM_PROGRAM,
  TOKEN_PROGRAM,
} from "./sol.js";

// ---- constants ---------------------------------------------------------------

// Same addresses on devnet and mainnet (programs/v2/Anchor.toml, declare_id!,
// and developers.circle.com/cctp/references/solana-programs).
export const MESSAGE_TRANSMITTER_V2 = "CCTPV2Sm4AdWt5296sk4P66VBZ7bEhcARwFaaS9YPbeC";
export const TOKEN_MESSENGER_MINTER_V2 = "CCTPV2vPZJS2u2BBsUoscuikbYjnpFmbFsvVuJdgUMQe";

// Circle's USDC on the Solana devnet (developers.circle.com/stablecoins/usdc-contract-addresses).
export const DEVNET_USDC_MINT = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU";

// CCTP domain ids.
export const DOMAIN = Object.freeze({ ethereum: 0, solana: 5 });

// minFinalityThreshold values: <= 1000 is a Fast transfer, 2000 is Standard.
// The Solana receiver rejects a finalityThresholdExecuted below 500.
export const FINALITY = Object.freeze({ fast: 1000, standard: 2000 });

export const IRIS_SANDBOX = "https://iris-api-sandbox.circle.com";
export const IRIS_MAINNET = "https://iris-api.circle.com";

// The largest legacy transaction the cluster accepts (packet size minus headers).
export const MAX_TX_BYTES = 1232;

/** Anchor instruction discriminator: sha256("global:<name>")[0..8]. */
export function ixDiscriminator(name) {
  return crypto.createHash("sha256").update(`global:${name}`).digest().subarray(0, 8);
}

/** Anchor account discriminator: sha256("account:<Name>")[0..8]. */
export function accountDiscriminator(name) {
  return crypto.createHash("sha256").update(`account:${name}`).digest().subarray(0, 8);
}

const IX = {
  depositForBurn: ixDiscriminator("deposit_for_burn"),
  depositForBurnWithHook: ixDiscriminator("deposit_for_burn_with_hook"),
  receiveMessage: ixDiscriminator("receive_message"),
  reclaimEventAccount: ixDiscriminator("reclaim_event_account"),
};

// ---- small encoders ----------------------------------------------------------

const u32le = (n) => {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(Number(n));
  return b;
};
const u64le = (n) => {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(BigInt(n));
  return b;
};
// Borsh Vec<u8>: u32 little-endian length, then the bytes.
const borshBytes = (bytes) => Buffer.concat([u32le(bytes.length), Buffer.from(bytes)]);

const addr = (x) => (typeof x === "string" ? x : x.address);
const meta = (pubkey, isSigner, isWritable) => ({ pubkey, isSigner, isWritable });

/** Normalize a CCTP bytes32 address: a 32-byte buffer, 0x-hex of 20 bytes (an
 *  EVM address, left-padded with zeros) or 32 bytes, or a base58 Solana key. */
export function toBytes32(x) {
  if (x instanceof Uint8Array) {
    if (x.length !== 32) throw new Error(`bytes32 must be 32 bytes, got ${x.length}`);
    return Buffer.from(x);
  }
  if (typeof x !== "string") throw new Error("bytes32: expected a buffer or string");
  if (/^0x[0-9a-fA-F]{40}$/.test(x)) return Buffer.concat([Buffer.alloc(12), Buffer.from(x.slice(2), "hex")]);
  if (/^0x[0-9a-fA-F]{64}$/.test(x)) return Buffer.from(x.slice(2), "hex");
  const b = b58decode(x);
  if (b.length !== 32) throw new Error(`bytes32: ${x} is neither 0x-hex nor a 32-byte base58 key`);
  return b;
}

/** The EVM address in a left-padded bytes32 (throws if the top 12 bytes are set). */
export function bytes32ToEvmAddress(b) {
  if (b.length !== 32 || b.subarray(0, 12).some((v) => v !== 0)) {
    throw new Error("bytes32 does not hold a left-padded 20-byte address");
  }
  return "0x" + Buffer.from(b.subarray(12)).toString("hex");
}

// ---- PDAs --------------------------------------------------------------------

const pda = (seeds, programId) =>
  findProgramAddress(
    seeds.map((s) => (typeof s === "string" ? Buffer.from(s, "utf8") : Buffer.from(s))),
    programId
  ).address;

/** Every program-derived account the burn and receive flows touch, for one
 *  local mint and one remote domain. `remoteToken` (bytes32-able; needed only
 *  for the receive-side token pair) is the burned token on the remote domain,
 *  e.g. Sepolia USDC. */
export function cctpPdas({ mint = DEVNET_USDC_MINT, remoteDomain, remoteToken } = {}) {
  const TMM = TOKEN_MESSENGER_MINTER_V2;
  const MT = MESSAGE_TRANSMITTER_V2;
  const m = b58decode(mint);
  const out = {
    messageTransmitter: pda(["message_transmitter"], MT),
    tokenMessenger: pda(["token_messenger"], TMM),
    tokenMinter: pda(["token_minter"], TMM),
    senderAuthority: pda(["sender_authority"], TMM),
    localToken: pda(["local_token", m], TMM),
    custody: pda(["custody", m], TMM),
    tmmEventAuthority: pda(["__event_authority"], TMM),
    mtEventAuthority: pda(["__event_authority"], MT),
    // Signs the CPI from MessageTransmitterV2 into the receiver program.
    mtAuthority: findProgramAddress([Buffer.from("message_transmitter_authority"), b58decode(TMM)], MT),
  };
  if (remoteDomain !== undefined) {
    // Domain seeds are the domain's DECIMAL STRING, not its integer bytes.
    out.remoteTokenMessenger = pda(["remote_token_messenger", String(remoteDomain)], TMM);
    if (remoteToken !== undefined) {
      out.tokenPair = pda(["token_pair", String(remoteDomain), toBytes32(remoteToken)], TMM);
    }
  }
  return out;
}

/** An account whose existence denylists `owner` from burning. */
export function denylistAddress(owner) {
  return pda(["denylist_account", b58decode(owner)], TOKEN_MESSENGER_MINTER_V2);
}

/** The PDA MessageTransmitterV2 creates when a message with this 32-byte nonce
 *  is received: it exists iff the message has been received. */
export function usedNonceAddress(nonce) {
  const n = Buffer.from(nonce);
  if (n.length !== 32) throw new Error("CCTP V2 nonce must be 32 bytes");
  return pda(["used_nonce", n], MESSAGE_TRANSMITTER_V2);
}

// ---- MessageSent event data keypair ------------------------------------------

/** Deterministic keypair for the account MessageTransmitterV2 stores an
 *  outgoing message in. It must sign the burn, and its address has to be known
 *  before broadcast (the transaction's signature is persisted first), so it is
 *  derived from the master seed and an index rather than generated randomly:
 *  after a crash the account, its message and its rent are all recoverable.
 *  Domain-separated from Sol.depositKeypair's "compages-sol-deposit:" seeds. */
export function eventDataKeypair(masterSeed, index) {
  const seed = crypto
    .createHmac("sha256", masterSeed)
    .update(`compages-cctp-event:${index}`)
    .digest();
  return keypairFromSeed(seed);
}

// ---- deposit_for_burn(_with_hook) ------------------------------------------

function burnKeys({ owner, eventRentPayer, ownerTokenAccount, mint, destinationDomain, messageSentEventData }) {
  const p = cctpPdas({ mint, remoteDomain: destinationDomain });
  return [
    meta(owner, true, false), // owner
    meta(eventRentPayer, true, true), // event_rent_payer
    meta(p.senderAuthority, false, false), // sender_authority_pda
    meta(ownerTokenAccount, false, true), // burn_token_account
    meta(denylistAddress(owner), false, false), // denylist_account
    meta(p.messageTransmitter, false, true), // message_transmitter
    meta(p.tokenMessenger, false, false), // token_messenger
    meta(p.remoteTokenMessenger, false, false), // remote_token_messenger
    meta(p.tokenMinter, false, false), // token_minter
    meta(p.localToken, false, true), // local_token
    meta(mint, false, true), // burn_token_mint
    meta(messageSentEventData, true, true), // message_sent_event_data
    meta(MESSAGE_TRANSMITTER_V2, false, false), // message_transmitter_program
    meta(TOKEN_MESSENGER_MINTER_V2, false, false), // token_messenger_minter_program
    meta(TOKEN_PROGRAM, false, false), // token_program
    meta(SYSTEM_PROGRAM, false, false), // system_program
    meta(p.tmmEventAuthority, false, false), // event_authority (#[event_cpi])
    meta(TOKEN_MESSENGER_MINTER_V2, false, false), // program (#[event_cpi])
  ];
}

function burnParams({ amount, destinationDomain, mintRecipient, destinationCaller, maxFee, minFinalityThreshold }) {
  const recipient = toBytes32(mintRecipient);
  if (recipient.every((v) => v === 0)) throw new Error("mintRecipient must not be zero");
  return Buffer.concat([
    u64le(amount),
    u32le(destinationDomain),
    recipient,
    destinationCaller == null ? Buffer.alloc(32) : toBytes32(destinationCaller),
    u64le(maxFee),
    u32le(minFinalityThreshold),
  ]);
}

/** TokenMessengerMinterV2.deposit_for_burn_with_hook as a sol.js instruction.
 *
 *  - owner, ownerTokenAccount: base58; owner signs and owns the token account.
 *  - eventRentPayer (default owner) signs and funds the MessageSent account.
 *  - messageSentEventData: a keypair (or its address) that must ALSO be passed
 *    to buildTx as a signer; see eventDataKeypair.
 *  - mintRecipient / destinationCaller: bytes32-able (see toBytes32). For an
 *    EVM destination these are left-padded addresses; destinationCaller null
 *    or zero lets anyone relay the message.
 *  - amount, maxFee: base units (BigInt or number); maxFee < amount.
 *  - hookData: Buffer or string, non-empty (the program rejects empty hooks;
 *    use depositForBurnIx for none). */
export function depositForBurnWithHookIx({
  owner,
  ownerTokenAccount,
  amount,
  destinationDomain,
  mintRecipient,
  destinationCaller = null,
  maxFee = 0n,
  minFinalityThreshold = FINALITY.standard,
  hookData,
  messageSentEventData,
  eventRentPayer = owner,
  mint = DEVNET_USDC_MINT,
}) {
  const hook = Buffer.from(hookData ?? []);
  if (hook.length === 0) throw new Error("hookData must be non-empty");
  return {
    programId: TOKEN_MESSENGER_MINTER_V2,
    keys: burnKeys({
      owner,
      eventRentPayer,
      ownerTokenAccount,
      mint,
      destinationDomain,
      messageSentEventData: addr(messageSentEventData),
    }),
    data: Buffer.concat([
      IX.depositForBurnWithHook,
      burnParams({ amount, destinationDomain, mintRecipient, destinationCaller, maxFee, minFinalityThreshold }),
      borshBytes(hook),
    ]),
  };
}

/** TokenMessengerMinterV2.deposit_for_burn (no hook); same accounts and
 *  arguments as depositForBurnWithHookIx without hookData. */
export function depositForBurnIx({
  owner,
  ownerTokenAccount,
  amount,
  destinationDomain,
  mintRecipient,
  destinationCaller = null,
  maxFee = 0n,
  minFinalityThreshold = FINALITY.standard,
  messageSentEventData,
  eventRentPayer = owner,
  mint = DEVNET_USDC_MINT,
}) {
  return {
    programId: TOKEN_MESSENGER_MINTER_V2,
    keys: burnKeys({
      owner,
      eventRentPayer,
      ownerTokenAccount,
      mint,
      destinationDomain,
      messageSentEventData: addr(messageSentEventData),
    }),
    data: Buffer.concat([
      IX.depositForBurn,
      burnParams({ amount, destinationDomain, mintRecipient, destinationCaller, maxFee, minFinalityThreshold }),
    ]),
  };
}

// ---- receive_message -----------------------------------------------------------

/** MessageTransmitterV2.receive_message for a TokenMessengerMinterV2 burn
 *  message, as a sol.js instruction.
 *
 *  - payer funds the used-nonce PDA; caller signs and must equal the message's
 *    destinationCaller unless that is zero. Pass the same key for both: a
 *    second signer does not fit in a legacy transaction.
 *  - message, attestation: the bytes (or 0x-hex) Iris returns, message with the
 *    nonce and finalityThresholdExecuted Iris filled in.
 *  - feeRecipient: TokenMessenger.fee_recipient, read from chain with
 *    readTokenMessenger(); its USDC associated token account is passed.
 *  - mint: the local USDC mint the message's token pair resolves to.
 *
 *  The recipient token account is the message's mintRecipient and must already
 *  exist; the program does not create it.
 *
 *  Size: with payer == caller the legacy transaction is 1224 bytes plus the
 *  message's hookData length, so only a hook of at most 8 bytes fits in
 *  MAX_TX_BYTES, and nothing else (not even a ComputeBudget instruction) can
 *  share the transaction. See also estimateReceiveComputeUnits.
 *
 *  message_transmitter and token_minter are passed read-only, as the IDL and
 *  program declare them; Circle's example client marks them writable, which
 *  only widens the write locks. */
export function receiveMessageIx({ payer, caller = payer, message, attestation, feeRecipient, mint = DEVNET_USDC_MINT }) {
  const msg = hexOrBytes(message);
  const att = hexOrBytes(attestation);
  const m = parseMessageV2(msg);
  const recipientProgram = b58encode(m.recipient);
  if (recipientProgram !== TOKEN_MESSENGER_MINTER_V2) {
    throw new Error(`message recipient ${recipientProgram} is not TokenMessengerMinterV2`);
  }
  const body = parseBurnBodyV2(m.body);
  const p = cctpPdas({ mint, remoteDomain: m.sourceDomain, remoteToken: body.burnToken });
  return {
    programId: MESSAGE_TRANSMITTER_V2,
    keys: [
      meta(payer, true, true), // payer
      meta(caller, true, false), // caller
      meta(p.mtAuthority.address, false, false), // authority_pda
      meta(p.messageTransmitter, false, false), // message_transmitter
      meta(usedNonceAddress(m.nonce), false, true), // used_nonce (init)
      meta(TOKEN_MESSENGER_MINTER_V2, false, false), // receiver
      meta(SYSTEM_PROGRAM, false, false), // system_program
      meta(p.mtEventAuthority, false, false), // event_authority (#[event_cpi])
      meta(MESSAGE_TRANSMITTER_V2, false, false), // program (#[event_cpi])
      // remaining accounts: HandleReceiveMessageContext after its authority_pda,
      // which MessageTransmitterV2 prepends itself.
      meta(p.tokenMessenger, false, false),
      meta(p.remoteTokenMessenger, false, false),
      meta(p.tokenMinter, false, false),
      meta(p.localToken, false, true),
      meta(p.tokenPair, false, false),
      meta(ataAddress(feeRecipient, mint), false, true), // fee_recipient_token_account
      meta(b58encode(body.mintRecipient), false, true), // recipient_token_account
      meta(p.custody, false, true), // custody_token_account
      meta(TOKEN_PROGRAM, false, false),
      meta(p.tmmEventAuthority, false, false), // event_authority (#[event_cpi])
      meta(TOKEN_MESSENGER_MINTER_V2, false, false), // program (#[event_cpi])
    ],
    data: Buffer.concat([IX.receiveMessage, borshBytes(msg), borshBytes(att)]),
  };
}

// ---- reclaim_event_account -----------------------------------------------------

/** MessageTransmitterV2.reclaim_event_account: closes a MessageSent event data
 *  account and refunds its rent to `payee`, which must be the burn's
 *  event_rent_payer and signs. Allowed only 5 days after the burn, with the
 *  attested destination message and attestation from Iris. */
export function reclaimEventAccountIx({ payee, messageSentEventData, attestation, destinationMessage }) {
  return {
    programId: MESSAGE_TRANSMITTER_V2,
    keys: [
      meta(payee, true, true),
      meta(cctpPdas().messageTransmitter, false, true),
      meta(addr(messageSentEventData), false, true),
    ],
    data: Buffer.concat([
      IX.reclaimEventAccount,
      borshBytes(hexOrBytes(attestation)),
      borshBytes(hexOrBytes(destinationMessage)),
    ]),
  };
}

/** Seconds after a burn before reclaim_event_account is accepted. */
export const EVENT_ACCOUNT_WINDOW_SECONDS = 5 * 24 * 60 * 60;

// ---- message parsing -----------------------------------------------------------

function hexOrBytes(x) {
  if (typeof x === "string") {
    const h = x.startsWith("0x") ? x.slice(2) : x;
    if (!/^([0-9a-fA-F]{2})*$/.test(h)) throw new Error("expected hex string");
    return Buffer.from(h, "hex");
  }
  return Buffer.from(x);
}

// Big-endian unsigned integer of any width.
const beUint = (b) => BigInt("0x" + (Buffer.from(b).toString("hex") || "0"));

export const MESSAGE_HEADER_BYTES = 148;
export const BURN_BODY_FIXED_BYTES = 228;

/** Parse a CCTP V2 message (big-endian integers throughout):
 *  version 0..4, sourceDomain 4..8, destinationDomain 8..12, nonce 12..44,
 *  sender 44..76, recipient 76..108, destinationCaller 108..140,
 *  minFinalityThreshold 140..144, finalityThresholdExecuted 144..148, body.
 *  32-byte fields are returned as Buffers; nonceHex is the nonce as 0x-hex,
 *  the form Iris reports as eventNonce. A message read from a Solana
 *  MessageSent account has a zero nonce and finalityThresholdExecuted: Iris
 *  fills both in at attestation time. */
export function parseMessageV2(bytes) {
  const b = hexOrBytes(bytes);
  if (b.length < MESSAGE_HEADER_BYTES) throw new Error(`CCTP message too short (${b.length} bytes)`);
  return {
    version: b.readUInt32BE(0),
    sourceDomain: b.readUInt32BE(4),
    destinationDomain: b.readUInt32BE(8),
    nonce: b.subarray(12, 44),
    nonceHex: "0x" + b.subarray(12, 44).toString("hex"),
    sender: b.subarray(44, 76),
    recipient: b.subarray(76, 108),
    destinationCaller: b.subarray(108, 140),
    minFinalityThreshold: b.readUInt32BE(140),
    finalityThresholdExecuted: b.readUInt32BE(144),
    body: b.subarray(MESSAGE_HEADER_BYTES),
  };
}

/** Parse a CCTP V2 burn message body: version 0..4, burnToken 4..36,
 *  mintRecipient 36..68, amount 68..100, messageSender 100..132,
 *  maxFee 132..164, feeExecuted 164..196, expirationBlock 196..228,
 *  hookData 228... The uint256 fields are returned as BigInt. */
export function parseBurnBodyV2(bytes) {
  const b = hexOrBytes(bytes);
  if (b.length < BURN_BODY_FIXED_BYTES) throw new Error(`CCTP burn body too short (${b.length} bytes)`);
  return {
    version: b.readUInt32BE(0),
    burnToken: b.subarray(4, 36),
    mintRecipient: b.subarray(36, 68),
    amount: beUint(b.subarray(68, 100)),
    messageSender: b.subarray(100, 132),
    maxFee: beUint(b.subarray(132, 164)),
    feeExecuted: beUint(b.subarray(164, 196)),
    expirationBlock: beUint(b.subarray(196, 228)),
    hookData: b.subarray(BURN_BODY_FIXED_BYTES),
  };
}

// ---- account decoding ----------------------------------------------------------

const DISC_MESSAGE_SENT = accountDiscriminator("MessageSent");
const DISC_TOKEN_MESSENGER = accountDiscriminator("TokenMessenger");

/** Decode a MessageSent event data account (owner MessageTransmitterV2):
 *  { rentPayer, createdAt (unix seconds), message }. */
export function decodeMessageSentAccount(data) {
  const b = Buffer.from(data);
  if (!b.subarray(0, 8).equals(DISC_MESSAGE_SENT)) throw new Error("not a MessageSent account");
  const len = b.readUInt32LE(48);
  return {
    rentPayer: b58encode(b.subarray(8, 40)),
    createdAt: Number(b.readBigInt64LE(40)),
    message: b.subarray(52, 52 + len),
  };
}

/** Decode the TokenMessengerMinterV2 TokenMessenger account. */
export function decodeTokenMessenger(data) {
  const b = Buffer.from(data);
  if (!b.subarray(0, 8).equals(DISC_TOKEN_MESSENGER)) throw new Error("not a TokenMessenger account");
  return {
    denylister: b58encode(b.subarray(8, 40)),
    owner: b58encode(b.subarray(40, 72)),
    messageBodyVersion: b.readUInt32LE(104),
    authorityBump: b[108],
    feeRecipient: b58encode(b.subarray(109, 141)),
    minFeeController: b58encode(b.subarray(141, 173)),
    // Minimum fee as a fraction of the amount, in units of 1e-7.
    minFee: b.readUInt32LE(173),
  };
}

async function accountData(sol, address) {
  const r = await sol.rpc("getAccountInfo", [address, { encoding: "base64", commitment: "confirmed" }]);
  return r.value ? Buffer.from(r.value.data[0], "base64") : null;
}

/** Read and decode the live TokenMessenger account (feeRecipient, minFee). */
export async function readTokenMessenger(sol) {
  const data = await accountData(sol, cctpPdas().tokenMessenger);
  if (!data) throw new Error("TokenMessengerV2 account not found (wrong cluster?)");
  return decodeTokenMessenger(data);
}

/** Read a MessageSent event data account; null once reclaimed or never created. */
export async function readMessageSent(sol, address) {
  const data = await accountData(sol, address);
  return data ? decodeMessageSentAccount(data) : null;
}

/** Compute units receive_message is expected to consume for this message
 *  (measured against the devnet program binaries). A legacy transaction runs
 *  under the default 200,000-unit limit, and a ComputeBudget instruction does
 *  not fit beside receive_message in one, so a message estimated above
 *  RECEIVE_CU_LIMIT needs a versioned transaction with an address lookup
 *  table. Two terms vary: the used-nonce PDA's bump search (Anchor finds it,
 *  about 1,500 units per bump below 255) and the fee transfer when
 *  feeExecuted is non-zero. */
export function estimateReceiveComputeUnits(message) {
  const m = parseMessageV2(message);
  const b = parseBurnBodyV2(m.body);
  const { bump } = findProgramAddress([Buffer.from("used_nonce"), m.nonce], MESSAGE_TRANSMITTER_V2);
  return 178_100 + 1_500 * (255 - bump) + (b.feeExecuted > 0n ? 2_900 : 0);
}

export const RECEIVE_CU_LIMIT = 200_000;

/** True iff the message with this 32-byte nonce has been received on Solana. */
export async function isNonceUsed(sol, nonce) {
  return (await accountData(sol, usedNonceAddress(nonce))) !== null;
}

// ---- Iris ----------------------------------------------------------------------

/** Messages and attestations Iris holds for a source transaction (for a Solana
 *  source, `txHash` is the transaction signature). Returns [] while Iris has
 *  not indexed the transaction yet (HTTP 404). Each entry is
 *  { status, message, attestation, eventNonce, cctpVersion, delayReason,
 *    destinationMintTxHash, decodedMessage } with message/attestation as
 *  Buffers, both null until status is "complete". Circle blocks a client for
 *  5 minutes above 40 requests per second, so poll gently. */
export async function irisMessages({ sourceDomain, txHash, baseUrl = IRIS_SANDBOX, timeoutMs = 10_000 }) {
  const url = `${baseUrl}/v2/messages/${Number(sourceDomain)}?transactionHash=${encodeURIComponent(txHash)}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  if (res.status === 404) return [];
  const text = await res.text();
  if (!res.ok) throw new Error(`iris ${url}: HTTP ${res.status}: ${text.slice(0, 200)}`);
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(`iris ${url}: non-JSON response: ${text.slice(0, 200)}`);
  }
  const bytesOrNull = (h) => (typeof h === "string" && /^0x([0-9a-fA-F]{2})+$/.test(h) ? Buffer.from(h.slice(2), "hex") : null);
  return (json.messages ?? []).map((m) => {
    const complete = m.status === "complete";
    return {
      status: m.status,
      message: complete ? bytesOrNull(m.message) : null,
      attestation: complete ? bytesOrNull(m.attestation) : null,
      eventNonce: m.eventNonce ?? null,
      cctpVersion: m.cctpVersion ?? null,
      delayReason: m.delayReason ?? null,
      // Set once Iris has seen the message minted on the destination chain.
      destinationMintTxHash: m.destinationMintTxHash ?? null,
      decodedMessage: m.decodedMessage ?? null,
    };
  });
}
