// Hand-rolled ABI encoding for the few contract calls the page makes. The
// interfaces are small and fixed, so this replaces a library. Every selector
// is the first four bytes of keccak256 of the signature beside it.

export const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

export const SEL = {
  depositEther: "0x77c76321", // depositEther(string)
  depositToken: "0xa10d0960", // depositToken(address,uint256,string)
  allowance: "0xdd62ed3e", // allowance(address,address)
  approve: "0x095ea7b3", // approve(address,uint256)
  claim: "0x21c0b342", // claim(address,address)
  // depositForBurnWithHook(uint256,uint32,bytes32,address,bytes32,uint256,uint32,bytes)
  depositForBurnWithHook: "0x779b432d",
  receiveMessage: "0x57ecfd28", // receiveMessage(bytes,bytes)
};

const strip0x = (h) => (h.startsWith("0x") ? h.slice(2) : h);
export const word = (v) => BigInt(v).toString(16).padStart(64, "0");
export const wordAddr = (a) => strip0x(a).toLowerCase().padStart(64, "0");

/** Dynamic `bytes` from hex: its length, then the data right-padded to 32. */
export function encBytesHex(hex) {
  const h = strip0x(hex).toLowerCase();
  if (h.length % 2 || /[^0-9a-f]/.test(h)) throw new Error("not hex bytes");
  const padded = h.padEnd(Math.ceil(h.length / 64) * 64, "0");
  return word(h.length / 2) + padded;
}
const utf8Hex = (s) => Array.from(new TextEncoder().encode(s), (b) => b.toString(16).padStart(2, "0")).join("");
/** Dynamic `string` (or `bytes` of UTF-8 text). */
export const encString = (s) => encBytesHex(utf8Hex(s));

export const dataDepositEther = (seqAddr) => SEL.depositEther + word(0x20) + encString(seqAddr);
export const dataDepositToken = (tok, units, seqAddr) =>
  SEL.depositToken + wordAddr(tok) + word(units) + word(0x60) + encString(seqAddr);
export const dataAllowance = (owner, spender) => SEL.allowance + wordAddr(owner) + wordAddr(spender);
export const dataApprove = (spender, units) => SEL.approve + wordAddr(spender) + word(units);
export const dataClaim = (token, payTo) => SEL.claim + wordAddr(token) + wordAddr(payTo);

/** CCTP V2 TokenMessenger.depositForBurnWithHook. Eight head words, the last
 *  being the offset of hookData, which follows them. */
export function dataDepositForBurnWithHook({
  amount,
  destinationDomain,
  mintRecipient,
  burnToken,
  destinationCaller,
  maxFee,
  minFinalityThreshold,
  hookText,
}) {
  return (
    SEL.depositForBurnWithHook +
    word(amount) +
    word(destinationDomain) +
    wordAddr(mintRecipient) +
    wordAddr(burnToken) +
    wordAddr(destinationCaller) +
    word(maxFee) +
    word(minFinalityThreshold) +
    word(8 * 32) +
    encString(hookText)
  );
}

/** CCTP V2 MessageTransmitter.receiveMessage(bytes message, bytes attestation). */
export function dataReceiveMessage(message, attestation) {
  const m = encBytesHex(message);
  const a = encBytesHex(attestation);
  return SEL.receiveMessage + word(0x40) + word(0x40 + m.length / 2) + m + a;
}
