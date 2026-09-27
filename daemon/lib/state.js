// Durable daemon state: a single JSON file, written atomically and durably
// after every mutation.
//
// Durability is not a nicety here. On the Solana leg the persisted transfer
// signature IS the replay guard, and on every leg a step marker persisted
// before an irreversible action is what stops a crash from repeating it. A
// write the kernel still holds in its page cache when the power goes is a
// write that never happened, so each save is flushed to disk (file, then the
// directory entry the rename created) before save() returns.

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
    const dir = path.dirname(this.file);
    const tmp = this.file + ".tmp";
    fs.mkdirSync(dir, { recursive: true });
    const fd = fs.openSync(tmp, "w", 0o600);
    try {
      fs.writeSync(fd, JSON.stringify(this.data));
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(tmp, this.file);
    const dfd = fs.openSync(dir, "r");
    try {
      fs.fsyncSync(dfd);
    } finally {
      fs.closeSync(dfd);
    }
    this.snapshot();
  }

  /** Keep one copy per day for `keepDays`, beside the live file. This is a
   *  local safety net against a bad write or an operator mistake; off-host
   *  backup is still the host's job. */
  snapshot(keepDays = 14) {
    const day = new Date().toISOString().slice(0, 10);
    if (this._snapshotDay === day) return;
    const dir = path.join(path.dirname(this.file), "snapshots");
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const base = path.basename(this.file, ".json");
    fs.copyFileSync(this.file, path.join(dir, `${base}-${day}.json`));
    const old = fs
      .readdirSync(dir)
      .filter((f) => f.startsWith(`${base}-`) && f.endsWith(".json"))
      .sort()
      .slice(0, -keepDays);
    for (const f of old) fs.rmSync(path.join(dir, f), { force: true });
    this._snapshotDay = day;
  }
}
