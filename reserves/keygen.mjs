#!/usr/bin/env node
// Create the attestation key: a fresh secp256k1 key written to <file>
// (mode 0600), refusing to replace one that exists. Prints the address,
// which is what the README and the public mirror publish.
//
//   node keygen.mjs <file>
//
// Run it on the host that signs, and back the file up offline. Never commit
// it: whoever holds it can sign snapshots in the bridge's name.

import fs from "node:fs";
import { ethers } from "ethers";

const file = process.argv[2];
if (!file) {
  console.error("usage: node keygen.mjs <file>");
  process.exit(1);
}
const w = ethers.Wallet.createRandom();
try {
  fs.writeFileSync(file, `${w.privateKey}\n`, { flag: "wx", mode: 0o600 });
} catch (e) {
  console.error(e.code === "EEXIST" ? `${file} already exists; an attestation key is never replaced by accident` : e.message);
  process.exit(1);
}
console.log(w.address);
