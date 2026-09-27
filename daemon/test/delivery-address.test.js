// Where a minted deposit is delivered. A supervised asset is never allowed
// in a blinded output, so a confidential destination for one must reduce to
// its unconfidential form; everything else is delivered as given.
// Run: npm test
import test from "node:test";
import assert from "node:assert/strict";
import { Bridge } from "../lib/bridge.js";

const BLINDED = "tsqb1qqfyeytwm0250dwlhrq4x2exd2ucj4p87vr0t8w74qrjayd32hlg8adxg0dm62p6ufksejdej8he5x2k02s995lmhpwzxl0thf";
const PLAIN = "tb1qkny8kaa9qawymgvexuermu6r9t84gzj6xna424";

// What validateaddress answers on the testnet node for these two forms.
const node = async (method, { address }) => {
  assert.equal(method, "validateaddress");
  if (address === BLINDED) {
    return { isvalid: true, confidential_key: "0249922ddb7aa8f6bbf7182a6564cd57312a84fe60deb3bbd500e5d2362abfd07e", unconfidential: PLAIN };
  }
  if (address === PLAIN) return { isvalid: true };
  return { isvalid: false };
};
const deliveryAddress = (address, mapping, n = node) =>
  Bridge.prototype.deliveryAddress.call({ seq: { node: n } }, address, mapping);

const supervised = { symbol: "USDC.e", supervision: { supervised: true, operationalkey: "aa", recoverykey: "bb", pauseAllowed: true } };
const plainAsset = { symbol: "WETH.e" };
// A unified asset issued without supervision records that it is not.
const unsupervisedUnified = { symbol: "PYUSD.e", unified: true, supervision: { supervised: false } };

test("a supervised asset to a confidential address goes to its unconfidential form", async () => {
  assert.equal(await deliveryAddress(BLINDED, supervised), PLAIN);
});

test("a supervised asset to a transparent address is delivered as given", async () => {
  assert.equal(await deliveryAddress(PLAIN, supervised), PLAIN);
});

test("an unsupervised asset keeps the confidential address the user asked for", async () => {
  let asked = false;
  const spy = async (...a) => ((asked = true), node(...a));
  assert.equal(await deliveryAddress(BLINDED, plainAsset, spy), BLINDED);
  assert.equal(asked, false, "no node call is needed for an unsupervised asset");
  assert.equal(await deliveryAddress(BLINDED, unsupervisedUnified, spy), BLINDED);
  assert.equal(asked, false);
});

test("a confidential address without an unconfidential form is refused, not guessed", async () => {
  const odd = async () => ({ isvalid: true, confidential_key: "02" + "11".repeat(32) });
  await assert.rejects(deliveryAddress(BLINDED, supervised, odd), /no unconfidential form/);
});
