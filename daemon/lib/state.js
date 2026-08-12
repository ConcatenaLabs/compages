// Durable daemon state: a single JSON file written atomically after every
// mutation. Small enough for a PoC bridge; swap for a real DB when volume
// demands it.

import fs from "node:fs";
import path from "node:path";

const DEFAULTS = () => ({
  version: 1,
  // Ethereum scan cursor: last block whose Deposited events are fully processed.
  lastEthBlock: 0,
  // Sequentia scan cursor for listsinceblock.
  seqLastBlockHash: null,
  // mapping key -> asset mapping. Usually the key IS a token key
  // ("chainId:0x..." | "chainId:eth"); a unified asset is keyed
  // "unified:SYMBOL" instead, because it is fed by several chains at once.
  mappings: {},
  // tokenKey -> mapping key, for the sources of a unified asset. This is what
  // makes a second source chain reissue the one asset instead of minting a
  // rival one, so it is the guard against splitting a token's liquidity.
  tokenRoutes: {},
  // deposit nonce -> record
  deposits: {},
  // sequentia redeem address -> { ethAddress, createdAt }
  redeemIntents: {},
  // "txid:vout" -> redemption record
  redemptions: {},
  // Solana leg. Next deposit-address derivation index:
  solIntentIndex: 0,
  // solana deposit address -> { index, seqAddress, seen: [signature], createdAt, sweep? }
  solWrapIntents: {},
  // solana tx signature -> deposit record
  solDeposits: {},
  // sequentia redeem address -> { solAddress, createdAt }
  solRedeemIntents: {},
  // "txid:vout" -> redemption record
  solRedemptions: {},
});

export class State {
  constructor(file) {
    this.file = file;
    if (fs.existsSync(file)) {
      this.data = { ...DEFAULTS(), ...JSON.parse(fs.readFileSync(file, "utf8")) };
    } else {
      this.data = DEFAULTS();
      this.save();
    }
  }

  save() {
    const tmp = this.file + ".tmp";
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2));
    fs.renameSync(tmp, this.file);
  }
}
