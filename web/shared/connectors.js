// Vendored from ConcatenaLabs/seqdex-web shared/connectors.js at 085965ffcf5650295ed3951c47f140eecae78e07, unchanged below this line: edit it there, then vendor it again (daemon/test/vendor-connectors.test.js).
// The wallets this site can connect to, behind one interface.
//
// The interface is the Sequentia website provider protocol
// (sequentia-extension/doc/PROVIDER.md): a method name and its params in, a result
// or an Error out, and a few named events. A connector is anything that speaks it:
//
//   { id, label, available(): Promise<bool>, request(method, params): Promise<any>,
//     on(event, fn), identity }
//
// `identity` is the `provider` string its getCapabilities must answer; a connector
// whose answer differs is refused before any other method reaches it. What a
// connector can do is the `methods` list of its getCapabilities, read through
// `railsOf` into the groups the pages ask about, so a page offers a rail only to a
// wallet that settles it.
//
// Four connectors exist:
//
// - `extension`: Ambra browser, which injects `window.sequentia`.
// - `local`: a person's own stack (Sequentia Core, a Lightning node, a leaf wallet)
//   behind the `sequentia-connect` daemon on this computer
//   (https://github.com/ConcatenaLabs/sequentia-connect). The daemon answers on the
//   loopback address only, to the origins its owner allowed, and asks its owner in
//   its own terminal before anything is signed or paid.
// - `webwallet`: the Sequentia web wallet, open in another tab or window of this
//   site's origin, over the `sequentia-wallet` BroadcastChannel; it asks its owner in
//   its own page.
// - `phone`: Ambra mobile (or any wallet on another device that pairs the same way), paired
//   by a QR code or a link and reached over a Nostr relay (Nostr Connect framing); it
//   asks its owner on its own screen.
//
// The wire of the last two is the extension's doc/PAIRING.md. No connector holds keys
// here; the site sends method names and reads answers.

export const EXTENSION_ID = 'sequentia-wallet-extension';
export const LOCAL_ID = 'sequentia-connect';
export const LOCAL_DEFAULT_URL = 'http://127.0.0.1:7419';
export const WEBWALLET_ID = 'sequentia-web-wallet';
export const CHANNEL = 'sequentia-wallet';
// The relays a pairing names: both sides publish to each and listen on each. A relay sees
// two keys, the times and the sizes, and nothing of what is said (PAIRING.md, "Relays").
export const PAIR_RELAYS = ['wss://relay.primal.net', 'wss://relay.damus.io'];
export const PAIR_PROTOCOL = 'sequentia-provider-1';
// How long a request waits: a read, and one the wallet's owner must approve.
export const READ_MS = 30000;   // a phone's wallet can take ten seconds to read its balances
export const APPROVAL_MS = 10 * 60 * 1000;   // the wallet prices first, then its owner decides
const SILENT = new Set(['getCapabilities', 'getWalletMode', 'getAccounts', 'getBalances', 'getOrders', 'getNetwork']);
const rid = () => Math.random().toString(16).slice(2) + Math.random().toString(16).slice(2);

// The site as a wallet page knows it: its origin and the folder it is served from (/dex/), the
// same for every view, so one approval in the wallet covers the markets, a pair and the
// portfolio, in this tab and the next, and the orders placed from one are listed on all.
export function siteKey(loc = globalThis.location) {
  if (!loc) return '';
  return loc.origin + loc.pathname.replace(/[^/]*$/, '');
}

// ---- the groups of methods a page asks about ----
// Each group is offered when the wallet serves every method listed for it.
export const RAILS = {
  account: ['connect', 'getAccounts', 'getBalances'],
  market: ['placeOrder', 'getOrders', 'cancelOrder'],
  chainFill: ['dexFillOnchain'],
  instant: ['dexSwapLn', 'dexJobResult'],
  lightning: ['lnChannels', 'createInvoice', 'payInvoice'],
  inbound: ['lnRequestInbound'],
  leaves: ['getLeafBalances', 'getLeafAddress'],
  leafOrders: ['getLeafOperator', 'takeOrder', 'getLeafTakes', 'placeOrderFromLeaves', 'getLeafOrders'],
  restingLeaves: ['restOrder', 'fillRestingOrder', 'cancelRestingOrder', 'getRestingOrders'],
  pools: ['dexFillPool'],
};

export function railsOf(methods) {
  const have = new Set(Array.isArray(methods) ? methods : []);
  const out = {};
  for (const [k, list] of Object.entries(RAILS)) out[k] = list.every((m) => have.has(m));
  return out;
}

// ---- the extension ----
export function extensionConnector(win = globalThis.window) {
  return {
    id: 'extension',
    identity: EXTENSION_ID,
    label: 'Ambra browser',
    present: () => !!(win && win.sequentia && win.sequentia.isSequentia),
    async available() { return this.present(); },
    async request(method, params = {}) {
      if (!this.present()) throw new Error('Ambra browser is not installed');
      return await win.sequentia.request({ method, params });
    },
    on(event, fn) {
      if (!this.present()) return false;
      try { win.sequentia.on(event, fn); return true; } catch { return false; }
    },
  };
}

// ---- the daemon on this computer ----
// Requests: POST <url>/v1/request {method, params}, with the session the daemon gave
// at connect in the `x-sequentia-session` header. Events: GET <url>/v1/events?after=n,
// which the daemon holds open until one is due (or 25 s pass) and answers
// {events: [{n, event, data}], next}. The site never sends the daemon a key, a
// password or an RPC address: the daemon reads its own configuration.
export function localConnector({ url = LOCAL_DEFAULT_URL, fetchFn = globalThis.fetch, store = safeStore() } = {}) {
  const KEY = 'seqdex.local.session';
  let session = store.get(KEY);
  const handlers = new Map();
  let polling = false;
  let lastProbe = { at: 0, ok: false };

  async function post(method, params) {
    let r;
    try {
      r = await fetchFn(url + '/v1/request', {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...(session ? { 'x-sequentia-session': session } : {}) },
        body: JSON.stringify({ method, params }),
      });
    } catch (e) {
      throw new Error('Sequentia Core on this computer is not answering: start sequentia-connect, then try again');
    }
    let j = null;
    try { j = await r.json(); } catch { /* not JSON */ }
    if (!j) throw new Error('Sequentia Core on this computer gave an answer this site cannot read (HTTP ' + r.status + ')');
    if (j.error) {
      if (j.code === 'no_session') { session = null; store.del(KEY); }
      throw new Error(j.error);
    }
    return j.result;
  }

  async function poll() {
    if (polling) return;
    polling = true;
    let after = 0;
    while (handlers.size) {
      try {
        const r = await fetchFn(url + '/v1/events?after=' + after, { headers: session ? { 'x-sequentia-session': session } : {} });
        const j = await r.json();
        for (const ev of j.events || []) {
          for (const fn of handlers.get(ev.event) || []) { try { fn(ev.data); } catch {} }
        }
        after = j.next ?? after;
      } catch { await new Promise((r) => setTimeout(r, 5000)); }
    }
    polling = false;
  }

  return {
    id: 'local',
    identity: LOCAL_ID,
    label: 'Sequentia Core on this computer',
    url,
    present: () => lastProbe.ok,
    // A quiet look: the daemon answers GET /v1/hello to an allowed origin with its
    // name, and to any other origin with a refusal this site shows nobody.
    async available() {
      if (Date.now() - lastProbe.at < 3000) return lastProbe.ok;
      let ok = false;
      try {
        const r = await fetchFn(url + '/v1/hello', { cache: 'no-store' });
        const j = await r.json();
        ok = r.ok && j && j.provider === LOCAL_ID;
      } catch { ok = false; }
      lastProbe = { at: Date.now(), ok };
      return ok;
    },
    async request(method, params = {}) {
      const res = await post(method, params);
      if (method === 'connect' && res && res.session) {
        session = res.session; store.set(KEY, session);
        const { session: _s, ...account } = res;
        return account;
      }
      return res;
    },
    on(event, fn) {
      if (!handlers.has(event)) handlers.set(event, new Set());
      handlers.get(event).add(fn);
      poll();
      return true;
    },
    // Drops this browser's session: the daemon asks its owner again at the next connect.
    forget() { session = null; store.del(KEY); },
  };
}

// ---- the web wallet in another tab of this origin ----
// Messages (PAIRING.md, "Same origin"): hello / here, then request / answer addressed by the
// wallet page's id; events from that page. A wallet page that stops answering (closed,
// reloaded) is looked for again once, then the request fails in plain words.
export function webWalletConnector({ win = globalThis.window, url = '/wallet/', makeChannel } = {}) {
  const page = rid();
  let ch = null, wallet = null, walletWin = null;
  const waiting = new Map();
  const handlers = new Map();
  const heres = new Set();
  function channel() {
    if (ch) return ch;
    const mk = makeChannel || ((n) => (win && typeof win.BroadcastChannel === 'function' ? new win.BroadcastChannel(n) : null));
    ch = mk(CHANNEL);
    if (ch) ch.onmessage = (ev) => {
      const m = (ev && ev.data) || {};
      if (m.type === 'here' && m.to === page) { if (!wallet) wallet = m.wallet; for (const fn of heres) fn(m); return; }
      if (m.type === 'answer' && m.to === page && waiting.has(m.id)) {
        const w = waiting.get(m.id); waiting.delete(m.id); clearTimeout(w.t);
        if (m.ok) w.resolve(m.result); else w.reject(new Error(m.error || 'the web wallet refused'));
        return;
      }
      if (m.type === 'event' && m.wallet && m.wallet === wallet) for (const fn of handlers.get(m.event) || []) { try { fn(m.data); } catch {} }
    };
    return ch;
  }
  function hello(ms = 600) {
    const c = channel();
    if (!c) return Promise.resolve(false);
    return new Promise((resolve) => {
      const done = (ok) => { heres.delete(on); clearTimeout(t); resolve(ok); };
      const on = () => done(true);
      heres.add(on);
      const t = setTimeout(() => done(!!wallet), ms);
      c.postMessage({ type: 'hello', from: page });
    });
  }
  function send(method, params) {
    const id = rid();
    const ms = SILENT.has(method) ? READ_MS : APPROVAL_MS;
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => { waiting.delete(id); const e = new Error('the web wallet did not answer'); e.code = 'timeout'; reject(e); }, ms);
      waiting.set(id, { resolve, reject, t });
      channel().postMessage({ type: 'request', id, from: page, wallet, page: siteKey(), method, params });
    });
  }
  return {
    id: 'webwallet',
    identity: WEBWALLET_ID,
    label: 'Sequentia web wallet',
    url,
    present: () => !!wallet,
    async available() { if (wallet) return true; return await hello(); },
    // Opens the wallet in a window of its own (or brings that window forward), where its owner
    // unlocks it and approves each request.
    open() {
      try { if (walletWin && !walletWin.closed) { walletWin.focus(); return; } } catch {}
      walletWin = win.open(url, 'sequentia-web-wallet');
    },
    async request(method, params = {}) {
      if (!wallet && !(await hello())) throw new Error('the web wallet is not open: open it in another tab, then try again');
      if (!SILENT.has(method)) { try { if (walletWin && !walletWin.closed) walletWin.focus(); } catch {} }
      try { return await send(method, params); } catch (e) {
        if (e.code !== 'timeout' || !SILENT.has(method)) throw e;
        // The page that answered is gone: ask once more of whichever is open now.
        wallet = null;
        if (!(await hello())) throw new Error('the web wallet is not open: open it in another tab, then try again');
        return await send(method, params);
      }
    },
    on(event, fn) {
      channel();
      if (!handlers.has(event)) handlers.set(event, new Set());
      handlers.get(event).add(fn);
      return true;
    },
  };
}

// ---- a wallet on another device, paired over a Nostr relay ----
// PAIRING.md, "Another device": the site makes a key pair and a one-time secret and shows
// `nostrconnect://…` as a QR code and a link; the wallet answers the secret from a key of its
// own, and every request and answer after that is a kind-24133 event, NIP-44 encrypted,
// between those two keys only. `tools` is nostr-tools (shared/vendor/nostr-tools.js), loaded
// when a pairing starts or one is kept. The pairing is kept in the browser so a reload resumes it.
export function remoteConnector({ loadTools = () => import('./vendor/nostr-tools.js').then((m) => m.default), store = safeStore(), relays = PAIR_RELAYS, name = 'SeqDEX', origin = globalThis.location ? globalThis.location.origin : '' } = {}) {
  const KEY = 'seqdex.remote.pairing';
  let kept = null;
  try { kept = JSON.parse(store.get(KEY) || 'null'); } catch { kept = null; }
  let T = null, pool = null, sub = null;
  const waiting = new Map();
  const handlers = new Map();
  const toHex = (b) => [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
  const fromHex = (h) => new Uint8Array(String(h).match(/../g).map((x) => parseInt(x, 16)));
  async function tools() { if (!T) T = await loadTools(); if (!pool) pool = new T.SimplePool(); return T; }
  function ck(sk, pk) { return T.nip44.getConversationKey(sk, pk); }
  async function listen(sk, onMsg) {
    await tools();
    if (sub) { try { sub.close(); } catch {} }
    const me = T.getPublicKey(sk);
    sub = pool.subscribeMany(kept ? kept.relays : relays, { kinds: [24133], '#p': [me], since: Math.floor(Date.now() / 1000) - 10 }, {
      onevent: (ev) => { try { if (!T.verifyEvent(ev)) return; onMsg(ev); } catch {} },
    });
  }
  function onWalletEvent(ev) {
    if (!kept || ev.pubkey !== kept.wallet) return;
    let m;
    try { m = JSON.parse(T.nip44.decrypt(ev.content, ck(fromHex(kept.sk), kept.wallet))); } catch { return; }
    if (m && m.id && waiting.has(m.id)) {
      const w = waiting.get(m.id); waiting.delete(m.id); clearTimeout(w.t);
      if (m.error) w.reject(new Error(String(m.error))); else w.resolve(m.result);
      return;
    }
    if (m && m.event === 'disconnect') { forget(false); for (const fn of handlers.get('disconnect') || []) { try { fn({}); } catch {} } return; }
    if (m && m.event) for (const fn of handlers.get(m.event) || []) { try { fn(m.data); } catch {} }
  }
  async function publish(obj) {
    await tools();
    const sk = fromHex(kept.sk);
    const ev = T.finalizeEvent({ kind: 24133, created_at: Math.floor(Date.now() / 1000), tags: [['p', kept.wallet]],
      content: T.nip44.encrypt(JSON.stringify(obj), ck(sk, kept.wallet)) }, sk);
    const res = await Promise.allSettled(pool.publish(kept.relays, ev));
    if (!res.some((r) => r.status === 'fulfilled')) throw new Error('no relay took the request; check your connection');
  }
  function forget(tell = true) {
    if (tell && kept && T) publish({ event: 'disconnect' }).catch(() => {});
    kept = null; store.del(KEY);
    if (sub) { try { sub.close(); } catch {} sub = null; }
  }
  let resumed = null;
  const resume = () => (resumed = resumed || (kept ? listen(fromHex(kept.sk), onWalletEvent) : Promise.resolve()));
  return {
    id: 'phone',
    identity: null,          // any wallet that pairs with the secret; its getCapabilities names it
    label: 'Ambra mobile',
    present: () => !!kept,
    async available() { return !!kept; },
    paired: () => (kept ? { wallet: kept.wallet, at: kept.at } : null),
    // Starts a pairing: -> { uri, paired: Promise } resolving once the wallet answers the secret.
    async pair() {
      await tools();
      forget(true);
      const sk = T.generateSecretKey();
      const pk = T.getPublicKey(sk);
      const secret = toHex(crypto.getRandomValues(new Uint8Array(16)));
      const q = relays.map((r) => 'relay=' + encodeURIComponent(r)).join('&');
      const uri = `nostrconnect://${pk}?${q}&secret=${secret}&name=${encodeURIComponent(name)}&url=${encodeURIComponent(origin)}&protocol=${PAIR_PROTOCOL}`;
      let done;
      const paired = new Promise((resolve) => { done = resolve; });
      let used = false;
      await listen(sk, (ev) => {
        if (kept) return onWalletEvent(ev);
        if (used) return;
        let m;
        try { m = JSON.parse(T.nip44.decrypt(ev.content, ck(sk, ev.pubkey))); } catch { return; }
        if (!m || m.result !== secret) return;
        used = true;
        kept = { sk: toHex(sk), wallet: ev.pubkey, relays, at: Date.now() };
        store.set(KEY, JSON.stringify(kept));
        done(kept.wallet);
      });
      return { uri, paired };
    },
    forget() { forget(true); },
    async request(method, params = {}) {
      if (!kept) throw new Error('no wallet is paired: pair one from the Connect wallet menu');
      await resume();
      const id = rid();
      const ms = SILENT.has(method) ? READ_MS : APPROVAL_MS;
      const answer = new Promise((resolve, reject) => {
        const t = setTimeout(() => { waiting.delete(id); reject(new Error(SILENT.has(method) ? 'Ambra mobile is not answering: open it, then try again' : 'Ambra mobile did not answer in time')); }, ms);
        waiting.set(id, { resolve, reject, t });
      });
      try { await publish({ id, method, params }); } catch (e) { const w = waiting.get(id); if (w) { clearTimeout(w.t); waiting.delete(id); } throw e; }
      return await answer;
    },
    on(event, fn) {
      if (!handlers.has(event)) handlers.set(event, new Set());
      handlers.get(event).add(fn);
      if (kept) resume();
      return true;
    },
  };
}

function safeStore() {
  const ls = (() => { try { return globalThis.localStorage || null; } catch { return null; } })();
  return {
    get: (k) => { try { return ls ? ls.getItem(k) : null; } catch { return null; } },
    set: (k, v) => { try { ls && ls.setItem(k, v); } catch {} },
    del: (k) => { try { ls && ls.removeItem(k); } catch {} },
  };
}
