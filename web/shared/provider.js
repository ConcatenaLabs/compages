// Vendored from ConcatenaLabs/seqdex-web shared/provider.js at 085965ffcf5650295ed3951c47f140eecae78e07, unchanged below this line: edit it there, then vendor it again (daemon/test/vendor-connectors.test.js).
// The site's one door to a wallet: whichever connector the person chose
// (shared/connectors.js), behind the provider protocol of
// sequentia-extension/doc/PROVIDER.md. The site never holds keys; every sensitive
// call goes to the wallet, which asks its owner. Only the methods this site actually
// uses get a wrapper: anything that touches UTXOs, PSETs or invoices is the wallet's
// business and stays out of this file so it can never be called from here by accident.
import { extensionConnector, localConnector, webWalletConnector, remoteConnector, railsOf, LOCAL_DEFAULT_URL } from './connectors.js';

// The site this door serves: its name in a wallet's pairing, where the person's choice is kept,
// and the connectors it offers, in the order a wallet is looked for when none was chosen. SeqDEX
// offers all four. Another site of this origin that carries this file sets
// `globalThis.SEQ_PROVIDER_SITE` before importing it: Emissio offers the connectors its
// configuration names.
const SITE = { name: 'SeqDEX', choiceKey: 'seqdex.connector', offer: ['extension', 'local', 'webwallet', 'phone'],
  ...(globalThis.SEQ_PROVIDER_SITE || {}) };
const CHOICE_KEY = SITE.choiceKey;
// The daemon's address: its default port, or another on this computer's loopback
// address that `?local=<port>` names (kept in the browser; `?local=default` clears it).
// Nothing but a loopback address is taken, so a link cannot point the site's requests
// at another machine.
const LOCAL_KEY = 'seqdex.local.url';
function localUrl() {
  try {
    const q = new URLSearchParams(location.search).get('local');
    if (q === 'default') localStorage.removeItem(LOCAL_KEY);
    else if (q && /^\d{2,5}$/.test(q) && Number(q) > 0 && Number(q) < 65536) localStorage.setItem(LOCAL_KEY, 'http://127.0.0.1:' + Number(q));
    const v = localStorage.getItem(LOCAL_KEY);
    if (v && /^http:\/\/(127\.0\.0\.1|localhost):\d{2,5}$/.test(v)) return v;
  } catch { /* no storage: the default port */ }
  return LOCAL_DEFAULT_URL;
}
// The web wallet lives on this origin at /wallet/ (the site at /dex/).
const MAKE = { extension: () => extensionConnector(), local: () => localConnector({ url: localUrl() }),
  webwallet: () => webWalletConnector({ url: '/wallet/' }), phone: () => remoteConnector({ name: SITE.name }) };
const OFFER = SITE.offer.filter((id, i, a) => MAKE[id] && a.indexOf(id) === i);
if (!OFFER.length) throw new Error('this site offers no wallet connector');
const CONNECTORS = Object.fromEntries(OFFER.map((id) => [id, MAKE[id]()]));
const offered = (id) => !!CONNECTORS[id];
const here = (id) => offered(id) && CONNECTORS[id].present();

let cachedAccount = null;
const listeners = new Set();
const chooseListeners = new Set();

function storedChoice() {
  try { const v = localStorage.getItem(CHOICE_KEY); return CONNECTORS[v] ? v : null; } catch { return null; }
}
// Disconnected by the person (the menu's Disconnect): no wallet is asked again, silently or
// otherwise, until they connect one, in this tab or any other.
function storedDisconnect() {
  try { return localStorage.getItem(CHOICE_KEY) === 'none'; } catch { return false; }
}
let disconnected = storedDisconnect();
// The connector in use: the one the person chose last; else the extension when it is
// installed; else the daemon on this computer once it answers; else an open web wallet; else
// a paired phone.
let chosen = storedChoice();
function active() {
  if (chosen) return CONNECTORS[chosen];
  for (const id of OFFER) if (here(id)) return CONNECTORS[id];
  return CONNECTORS[OFFER[0]];
}
export function connectorById(id) { return CONNECTORS[id] || null; }

export function connectors() { return Object.values(CONNECTORS); }
export function activeConnector() { return active(); }
export function onChoose(fn) { chooseListeners.add(fn); }

// Switches to another connector: the account of the old one is forgotten, and every
// page listening hears the change as an account change.
export async function choose(id) {
  if (!CONNECTORS[id]) throw new Error('no such wallet connector: ' + id);
  chosen = id;
  disconnected = false;
  try { localStorage.setItem(CHOICE_KEY, id); } catch {}
  genuine = null;
  cachedAccount = null;
  for (const fn of chooseListeners) { try { fn(id); } catch {} }
  fireReady();
  emit();
}

export function hasWallet() { return active().present(); }
export function account() { return cachedAccount; }

export function onAccountChange(fn) { listeners.add(fn); }
function emit() { for (const fn of listeners) { try { fn(cachedAccount); } catch {} } }

// ---- provider identity ----
// Resolved once per connector: the first request of any kind waits on it, so no
// method ever reaches a wallet that did not identify itself as the connector it was
// chosen as. Any page script can define a window.sequentia of its own; this check is
// what keeps a look-alike from harvesting a connect. A failed check is not cached,
// so a transient error (the extension reloading, the daemon restarting) is retried.
let genuine = null;
function assertGenuine() {
  if (genuine && genuine.conn === active()) return genuine.p;
  const conn = active();
  const p = (async () => {
    let caps;
    try { caps = await conn.request('getCapabilities', {}); }
    catch (e) { throw new Error('the wallet did not identify itself: ' + (e && e.message ? e.message : e)); }
    // A paired wallet is bound by its pairing's secret and names itself; every other connector
    // must answer as the one it was chosen as.
    const ok = caps && (conn.identity ? caps.provider === conn.identity : typeof caps.provider === 'string' && caps.provider.length > 0);
    if (!ok) {
      throw new Error('refusing an unrecognised wallet on this page; choose your wallet again from Connect wallet, then reload');
    }
    return caps;
  })();
  genuine = { conn, p };
  p.catch(() => { if (genuine && genuine.p === p) genuine = null; });
  return p;
}

const NOT_THERE = {
  local: 'Sequentia Core on this computer is not answering',
  extension: 'Ambra browser is not installed',
  webwallet: 'the web wallet is not open: open it in another tab, then try again',
  phone: 'no wallet is paired: pair one from the Connect wallet menu',
};
export async function request(method, params = {}) {
  const conn = active();
  if (!conn.present() && conn.id === 'webwallet') await conn.available();
  if (!conn.present()) throw new Error(NOT_THERE[conn.id] || 'the wallet is not there');
  if (method !== 'getCapabilities') await assertGenuine();
  return await conn.request(method, params);
}

// Silent session restore: succeeds only if the origin is connected AND the
// wallet is unlocked; never prompts.
export async function restore() {
  if (disconnected || !hasWallet()) { cachedAccount = null; emit(); return null; }
  try {
    const { accounts } = await request('getAccounts');
    cachedAccount = accounts && accounts[0] ? accounts[0] : null;
  } catch { cachedAccount = null; }
  emit();
  return cachedAccount;
}

// Explicit connect (prompts once per origin; doubles as unlock when locked).
// The identity check runs first, so an impostor never gets to show its own
// "approval" dialog on the strength of a click meant for the real wallet.
export async function connect() {
  const conn = active();
  if (disconnected) {
    disconnected = false;
    if (!chosen) { chosen = conn.id; }
    try { localStorage.setItem(CHOICE_KEY, chosen); } catch {}
  }
  cachedAccount = await request('connect');
  emit();
  return cachedAccount;
}

// ---- provider lifecycle ----
// The extension's inpage script can land after this module has run (an extension
// enabled while the tab is open, a page restored from the back/forward cache), and the
// daemon may be started after the page loads. Everything that wires a wallet registers
// here so it runs once a wallet is there, whenever that is.
const pending = new Set();
function fireReady() {
  if (!hasWallet()) return;
  for (const fn of pending) {
    pending.delete(fn);
    try { fn(); } catch (e) { console.warn('[provider]', e); }
  }
}
// Disconnects this site from the wallet: the choice is forgotten here and in every other tab
// (a reload asks no wallet), a session with Sequentia Core on this computer is dropped, a
// paired phone is unpaired. The wallet itself keeps nothing of this site's to revoke beyond
// that; Ambra browser's own Settings list the sites it trusts.
export function disconnect() {
  const conn = active();
  try { if (conn.forget) conn.forget(); } catch {}
  disconnected = true; chosen = null; genuine = null; cachedAccount = null;
  try { localStorage.setItem(CHOICE_KEY, 'none'); } catch {}
  emit();
}
export function isDisconnected() { return disconnected; }

export function onProvider(fn) {
  pending.add(fn);
  fireReady();
}
if (typeof window !== 'undefined') window.addEventListener('sequentia#initialized', () => { emitPresence(); fireReady(); });

// The daemon is looked for when it is the wallet chosen, or while no wallet is there at
// all (every few seconds, so starting it after the page opened is enough), and whenever
// the chooser opens. A page whose wallet is the extension never knocks on the port.
const presence = new Set();
export function onPresence(fn) { presence.add(fn); }
function emitPresence() { for (const fn of presence) { try { fn(); } catch {} } }
async function probeLocal() {
  if (!offered('local')) return false;
  const was = CONNECTORS.local.present();
  const ok = await CONNECTORS.local.available();
  if (ok !== was) emitPresence();
  fireReady();
  return ok;
}
const wantsLocal = () => offered('local') && (chosen === 'local' || (!chosen && !here('extension')));
// The extension's inpage script runs before the page's own, so whether it is there is
// known at load; one that lands later is announced by its event.
export const localReady = wantsLocal() ? probeLocal() : Promise.resolve(false);
// The web wallet answers on the channel at once, when a wallet page is open: looked for when it
// is the wallet chosen, or while no wallet is there at all.
async function probeWebWallet() {
  if (!offered('webwallet')) return false;
  const was = CONNECTORS.webwallet.present();
  const ok = await CONNECTORS.webwallet.available();
  if (ok !== was) emitPresence();
  fireReady();
  return ok;
}
const wantsWebWallet = () => offered('webwallet') && (chosen === 'webwallet' || (!chosen && !here('extension')));
export const webWalletReady = wantsWebWallet() ? probeWebWallet() : Promise.resolve(false);
export const probeWebWalletNow = probeWebWallet;
export const probeLocalNow = probeLocal;
if (typeof setInterval !== 'undefined') setInterval(() => {
  if (wantsLocal()) probeLocal();
  if (offered('webwallet') && !CONNECTORS.webwallet.present() && (chosen === 'webwallet' || (!chosen && !hasWallet()))) probeWebWallet();
}, 5000);

const watched = new WeakSet();
export function watchEvents() {
  const conn = active();
  if (!hasWallet() || watched.has(conn)) return;
  watched.add(conn);
  conn.on('accountsChanged', () => { if (active() === conn) restore(); });
  conn.on('disconnect', () => { if (active() === conn) { cachedAccount = null; emit(); } });
}

// Subscribe to a wallet event. Returns false when there is no wallet yet; callers that
// need the subscription to survive a late wallet go through onProvider.
export function onEvent(event, fn) {
  const conn = active();
  if (!hasWallet()) return false;
  return conn.on(event, (d) => { if (active() === conn) fn(d); });
}

// The wallet's mode ('developer' | 'user'); null when it cannot say. Needs no
// connection. The developer-mode rooms are drawn only while it says 'developer'.
export async function walletMode() {
  try { return (await request('getWalletMode')).mode || null; } catch { return null; }
}

// Whether the wallet serves a method (its getCapabilities list): a wallet that does
// not is told so in plain words rather than met with an unknown-method error.
export async function supports(method) {
  try { const caps = await assertGenuine(); return Array.isArray(caps.methods) && caps.methods.includes(method); }
  catch { return false; }
}

// The groups of methods the wallet serves (connectors.js RAILS), for a page to decide
// what to offer.
// What the wallet offers beyond its methods (getCapabilities' `features`), such as the
// order options: a control that needs one is drawn only when the wallet lists it.
export async function features() {
  try { const caps = await assertGenuine(); return new Set(Array.isArray(caps.features) ? caps.features : []); }
  catch { return new Set(); }
}

export async function rails() {
  try { const caps = await assertGenuine(); return railsOf(caps.methods); }
  catch { return railsOf([]); }
}

// The words a page uses when no wallet is there to trade with.
export const NO_WALLET = 'Trading needs a wallet: the Sequentia web wallet, Ambra mobile, Ambra browser, or Sequentia Core on this computer through sequentia-connect.';

// ---- typed helpers over the raw protocol (only what the site calls) ----
export const getBalances = () => request('getBalances');
export const lnChannels = () => request('lnChannels');
export const lnRequestInbound = (amount, asset) => request('lnRequestInbound', { amount, asset });
