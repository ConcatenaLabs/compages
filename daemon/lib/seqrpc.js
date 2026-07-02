// Minimal JSON-RPC client for the Sequentia node (Elements-style RPC).
// Uses named parameters everywhere so argument order can never bite us.

export class SeqRpc {
  /**
   * @param {string} url  http://user:pass@host:port  (wallet appended per call set)
   * @param {string} [wallet]  wallet name to route calls to
   */
  constructor(url, wallet) {
    const u = new URL(url);
    this.auth = u.username
      ? "Basic " + Buffer.from(`${decodeURIComponent(u.username)}:${decodeURIComponent(u.password)}`).toString("base64")
      : null;
    u.username = "";
    u.password = "";
    this.base = u.toString().replace(/\/$/, "");
    this.wallet = wallet || null;
  }

  async call(method, params = {}, { wallet = this.wallet } = {}) {
    const url = wallet ? `${this.base}/wallet/${encodeURIComponent(wallet)}` : this.base;
    const body = JSON.stringify({ jsonrpc: "2.0", id: "bridge", method, params });
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(this.auth ? { authorization: this.auth } : {}),
      },
      body,
    });
    const text = await res.text();
    let json;
    try {
      json = JSON.parse(text);
    } catch {
      throw new Error(`seq rpc ${method}: non-JSON response (HTTP ${res.status}): ${text.slice(0, 200)}`);
    }
    if (json.error) {
      const e = new Error(`seq rpc ${method}: ${json.error.message} (code ${json.error.code})`);
      e.code = json.error.code;
      throw e;
    }
    return json.result;
  }

  // Node-level (no wallet routing)
  node(method, params = {}) {
    return this.call(method, params, { wallet: null });
  }
}

// Elements RPC amounts arrive as JSON numbers with 8 decimal places. Convert
// via rounding: all representable amounts (max 21M * 1e8 sats) sit well below
// 2^53, so the round-trip is exact.
export function amountToSats(amount) {
  return BigInt(Math.round(Number(amount) * 1e8));
}

export function satsToAmount(sats) {
  const s = BigInt(sats);
  const whole = s / 100000000n;
  const frac = (s % 100000000n).toString().padStart(8, "0");
  return `${whole}.${frac}`;
}
