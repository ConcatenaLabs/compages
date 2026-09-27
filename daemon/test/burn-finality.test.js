// The release gate: a Sequentia burn is final for an irreversible payout only
// once its Bitcoin anchor is buried deep enough. These cases pin that a node
// that cannot answer, or does not validate anchors, is "not final" rather
// than a fallback to a Sequentia block count, unless the chain is explicitly
// configured as unanchored.
// Run: npm test
import test from "node:test";
import assert from "node:assert/strict";
import { Bridge } from "../lib/bridge.js";

const TXID = "cd".repeat(32);
const BLOCK = "ef".repeat(32);

/** burnFinality against a fake node. `anchor` is getanchorstatus's answer,
 *  or an Error it throws; `header` is getblockheader's. */
function finality({ tx = { blockhash: BLOCK, confirmations: 10 }, anchor, header = {}, cfg = {} }) {
  const calls = [];
  const seq = {
    call: async (method, params) => {
      calls.push(method);
      if (method === "gettransaction") {
        assert.equal(params.txid, TXID);
        return tx;
      }
      if (method === "getblockheader") {
        assert.equal(params.blockhash, BLOCK);
        assert.equal(params.verbose, true);
        return header;
      }
      assert.fail(`unexpected wallet call ${method}`);
    },
    node: async (method) => {
      calls.push(method);
      assert.equal(method, "getanchorstatus");
      if (anchor instanceof Error) throw anchor;
      return anchor;
    },
  };
  return Bridge.prototype.burnFinality.call({ seq, cfg }, TXID).then((r) => ({ ...r, calls }));
}

const OK = { validateanchor: true, anchorstatus: "ok", anchorheight: 120_000 };

test("an unconfirmed or conflicted burn is never final", async () => {
  for (const tx of [{ blockhash: null, confirmations: 0 }, { blockhash: BLOCK, confirmations: -3 }, { confirmations: 5 }]) {
    const r = await finality({ tx, anchor: OK });
    assert.equal(r.final, false);
    assert.match(r.reason, /burn not confirmed/);
    assert.deepEqual(r.calls, ["gettransaction"], "nothing else is asked");
  }
});

test("an error reading the anchor status is not final, not an unanchored chain", async () => {
  const r = await finality({ anchor: new Error("Work queue depth exceeded"), cfg: { seqConfirmations: 1 } });
  assert.equal(r.final, false);
  assert.equal(r.kind, "bitcoin");
  assert.match(r.reason, /could not read the node's anchor status: Work queue depth exceeded/);
});

test("a node that does not validate anchors cannot vouch for finality", async () => {
  const r = await finality({ anchor: { validateanchor: false, anchorstatus: "ok" }, cfg: { seqConfirmations: 1 } });
  assert.equal(r.final, false);
  assert.equal(r.kind, "bitcoin");
  assert.match(r.reason, /does not validate Bitcoin anchors/);
});

test("only a chain configured as unanchored falls back to Sequentia confirmations", async () => {
  const cfg = { allowUnanchoredFinality: true, seqConfirmations: 6 };
  for (const anchor of [new Error("Method not found"), null, { validateanchor: false }]) {
    const short = await finality({ tx: { blockhash: BLOCK, confirmations: 5 }, anchor, cfg });
    assert.deepEqual(
      { final: short.final, depth: short.depth, need: short.need, kind: short.kind },
      { final: false, depth: 5, need: 6, kind: "sequentia" }
    );
    const deep = await finality({ tx: { blockhash: BLOCK, confirmations: 6 }, anchor, cfg });
    assert.equal(deep.final, true);
  }
  // The default count, when none is configured, is 6.
  const d = await finality({ tx: { blockhash: BLOCK, confirmations: 5 }, anchor: null, cfg: { allowUnanchoredFinality: true } });
  assert.equal(d.need, 6);
  assert.equal(d.final, false);
});

test("allowUnanchoredFinality does not relax a node that DOES validate anchors", async () => {
  const cfg = { allowUnanchoredFinality: true, seqConfirmations: 1, btcAnchorConfirmations: 3 };
  const r = await finality({ tx: { blockhash: BLOCK, confirmations: 500 }, anchor: OK, header: { anchorheight: 119_999 }, cfg });
  assert.equal(r.kind, "bitcoin");
  assert.equal(r.final, false, "500 Sequentia blocks do not make a 1-deep anchor final");
});

test("an anchor status other than ok is not final", async () => {
  for (const anchorstatus of ["behind", "unknown", "stale", undefined]) {
    const r = await finality({ anchor: { validateanchor: true, anchorstatus, anchorheight: 999_999 }, header: { anchorheight: 1 } });
    assert.equal(r.final, false, String(anchorstatus));
    assert.match(r.reason, /anchor status/);
  }
});

test("a burn block not yet certified by the committee is not final", async () => {
  const r = await finality({ anchor: OK, header: { poscertified: false, anchorheight: 1 } });
  assert.equal(r.final, false);
  assert.match(r.reason, /committee-certified/);
});

test("certification is enforced only where the node reports it", async () => {
  const r = await finality({ anchor: OK, header: { anchorheight: 119_990 } });
  assert.equal(r.final, true, "no poscertified field: gate on anchor depth alone");
});

test("depth is the node's anchor height minus the burn block's", async () => {
  const cfg = { btcAnchorConfirmations: 100 };
  const at = async (h) => finality({ anchor: OK, header: { poscertified: true, anchorheight: h }, cfg });
  const below = await at(120_000 - 99);
  assert.deepEqual([below.final, below.depth, below.need, below.kind], [false, 99, 100, "bitcoin"]);
  assert.equal(below.reason, "99/100 Bitcoin-anchor confirmations");
  const exact = await at(120_000 - 100);
  assert.deepEqual([exact.final, exact.depth], [true, 100]);
  // A burn anchored above the node's own anchor (the node is behind) is not
  // final and reports no negative depth.
  const ahead = await at(120_005);
  assert.deepEqual([ahead.final, ahead.depth], [false, 0]);
});

test("the default anchor depth is 3", async () => {
  const two = await finality({ anchor: OK, header: { anchorheight: 119_998 } });
  assert.deepEqual([two.final, two.need], [false, 3]);
  const three = await finality({ anchor: OK, header: { anchorheight: 119_997 } });
  assert.equal(three.final, true);
});

test("a header or status without an anchor height is never final", async () => {
  const noHeader = await finality({ anchor: OK, header: {} });
  assert.equal(noHeader.final, false);
  const noStatusHeight = await finality({ anchor: { validateanchor: true, anchorstatus: "ok" }, header: { anchorheight: 1 } });
  assert.equal(noStatusHeight.final, false);
});
