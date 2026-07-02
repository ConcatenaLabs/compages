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
  // tokenKey ("chainId:0x..." | "chainId:eth") -> asset mapping
  mappings: {},
  // deposit nonce -> record
  deposits: {},
  // sequentia redeem address -> { ethAddress, createdAt }
  redeemIntents: {},
  // "txid:vout" -> redemption record
  redemptions: {},
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
