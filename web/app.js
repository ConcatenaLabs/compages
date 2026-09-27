// Compages web app. No framework, no external dependencies: contract calls
// are ABI-encoded by hand (abi.js) against small, fixed interfaces, and QR
// codes come from the page's own encoder (qr.js).

import { qrSvg } from "./qr.js";
import {
  ZERO_ADDRESS,
  dataAllowance,
  dataApprove,
  dataClaim,
  dataDepositEther,
  dataDepositForBurnWithHook,
  dataDepositToken,
  dataReceiveMessage,
} from "./abi.js";

const $ = (id) => document.getElementById(id);
// Resolve the API relative to this module's own URL, so the app works whether
// it is served at the site root (local daemon) or behind a path prefix such as
// /bridge/ (reverse-proxied in production). import.meta.url is the absolute URL
// of app.js, e.g. https://host/bridge/app.js -> API root https://host/bridge/api/.
const API_ROOT = new URL("api/", import.meta.url);

/** GET or POST a JSON API route. Errors carry the HTTP status, so a caller can
 *  tell "not found" from "unreachable". */
async function api(path, opts) {
  const res = await fetch(new URL(path, API_ROOT), opts);
  let body = null;
  try {
    body = await res.json();
  } catch {
    body = null;
  }
  if (!res.ok) {
    const e = new Error(body?.error ?? `the bridge answered HTTP ${res.status}`);
    e.status = res.status;
    e.body = body;
    throw e;
  }
  return body;
}
const postJson = (path, obj) =>
  api(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(obj) });

// Browser storage is a convenience only: private windows and blocked storage
// throw, and the page must work the same without it.
const store = {
  get(k) {
    try {
      const v = localStorage.getItem(`compages.${k}`);
      return v === null ? null : JSON.parse(v);
    } catch {
      return null;
    }
  },
  set(k, v) {
    try {
      localStorage.setItem(`compages.${k}`, JSON.stringify(v));
    } catch {
      /* storage unavailable */
    }
  },
};

// ---------- state ----------
let status = null; // /api/status
let assets = []; // /api/assets
let porAssets = []; // /api/por rows: also names retired assets, which /api/assets omits
let haltedAssets = new Map(); // assetId -> "mint" | "all", from /api/health
let account = null;
let walletChainId = null;
let token = null; // selected token: /api/token plus what the user receives
let depositBusy = false;
let depTrackId = 0; // bumping it cancels any running deposit tracker

const ETHERSCAN = { 11155111: "https://sepolia.etherscan.io", 1: "https://etherscan.io" };
// Where the Sequentia explorer, faucet and downloads live, per chain label.
const SEQ_SITES = { "sequentia-testnet": "https://sequentiatestnet.com" };
// Ethereum finalizes a block about two epochs after it is mined.
const ETH_FINALITY_MINUTES = 15;
const ETH_BLOCK_SECONDS = 12;

const short = (s) => (s && s.length > 16 ? `${s.slice(0, 8)}…${s.slice(-6)}` : s ?? "");
const escapeHtml = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// Polling pauses while the tab is hidden, and backs off when the bridge
// answers 429 (too many requests).
const IDLE_POLL_MS = 60_000;
const BACKOFF_MS = 60_000;
const whenVisible = () =>
  document.hidden
    ? new Promise((resolve) => {
        const f = () => {
          if (document.hidden) return;
          document.removeEventListener("visibilitychange", f);
          resolve();
        };
        document.addEventListener("visibilitychange", f);
      })
    : Promise.resolve();
/** Sleep, then wait until the tab is visible. Answers how long the tab was
 *  hidden, so a caller measuring a timeout can leave that time out. */
async function pollSleep(ms) {
  await sleep(ms);
  const t = Date.now();
  await whenVisible();
  return Date.now() - t;
}
const ethName = () => status?.ethChainName ?? "Ethereum";
const solName = () => status?.solChainName ?? "Solana devnet";
const ETH_CHAIN = () => status?.ethChainId;
const SOL_CHAIN = () => status?.solChainLabel ?? "solana-devnet";

function announce(text) {
  const el = $("announce");
  el.textContent = "";
  setTimeout(() => (el.textContent = text), 50);
}

/** Set a status line's text (never HTML) and its tone. */
function say(id, text, tone) {
  const el = $(id);
  el.textContent = text ?? "";
  el.classList.toggle("err", tone === "err");
  el.classList.toggle("ok", tone === "ok");
}
/** Same, for markup the caller has built from escaped parts. */
function sayHtml(id, html, tone) {
  const el = $(id);
  el.innerHTML = html;
  el.classList.toggle("err", tone === "err");
  el.classList.toggle("ok", tone === "ok");
}

// ---------- amounts ----------
/** Parse a decimal amount into base units. `precision` is the Sequentia
 *  asset's: finer digits than that cannot be represented there. */
function parseUnits(str, decimals, precision = 8) {
  const m = /^(\d+)(?:\.(\d+))?$/.exec(String(str).trim());
  if (!m) throw new Error("Enter a plain decimal amount, such as 0.5.");
  const maxDp = Math.min(precision, decimals);
  const frac = m[2] ?? "";
  if (frac.length > maxDp) {
    throw new Error(`Use at most ${maxDp} decimal places.`);
  }
  const units = BigInt(m[1]) * 10n ** BigInt(decimals) + BigInt(frac.padEnd(decimals, "0") || "0");
  if (units === 0n) throw new Error("The amount is zero.");
  return units;
}
/** Mirror of the daemon's floor conversion (eth.js unitsToAtoms). */
function unitsToAtoms(units, decimals, precision = 8) {
  const u = BigInt(units);
  const shift = precision - decimals;
  return shift >= 0 ? u * 10n ** BigInt(shift) : u / 10n ** BigInt(-shift);
}
const groupInt = (s) => s.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
/** Base units to a readable decimal: scaled, trailing zeros dropped, the
 *  whole part grouped in thousands. */
function formatAtoms(atoms, precision = 8) {
  if (atoms === null || atoms === undefined) return null;
  let a;
  try {
    a = BigInt(atoms);
  } catch {
    return String(atoms);
  }
  const neg = a < 0n;
  if (neg) a = -a;
  const base = 10n ** BigInt(precision);
  const frac = precision ? (a % base).toString().padStart(precision, "0").replace(/0+$/, "") : "";
  return `${neg ? "-" : ""}${groupInt((a / base).toString())}${frac ? "." + frac : ""}`;
}
/** Minutes as "about 2 h 5 min". */
function fmtMinutes(min) {
  const m = Math.max(0, Math.round(min));
  if (m < 1) return "less than a minute";
  if (m < 60) return `about ${m} min`;
  const h = Math.floor(m / 60);
  return m % 60 ? `about ${h} h ${m % 60} min` : `about ${h} h`;
}

// ---------- assets ----------
// The bridge is multi-leg, and a unified stablecoin is one asset fed from
// several chains, so "which leg is this asset on" means "which chains does it
// have a source on", never a single chainId.
const sameChain = (a, b) => String(a) === String(b);
function sourceOn(asset, chainId) {
  const s = (asset.sources ?? []).find((x) => sameChain(x.chainId, chainId));
  if (s) return s;
  return sameChain(asset.chainId, chainId) ? { chainId, token: asset.token, decimals: asset.decimals } : null;
}
const legAssets = (chainId) => assets.filter((a) => sourceOn(a, chainId));
// Ethereum addresses are case-insensitive hex; Solana mints are case-sensitive.
const sameToken = (chainId, x, y) =>
  sameChain(chainId, ETH_CHAIN()) ? String(x).toLowerCase() === String(y).toLowerCase() : x === y;
const assetForToken = (chainId, tok) =>
  assets.find((a) => {
    const s = sourceOn(a, chainId);
    return s && sameToken(chainId, s.token, tok);
  }) ?? null;
const assetById = (id) =>
  id ? assets.find((a) => a.assetId === id) ?? porAssets.find((a) => a.assetId === id) ?? null : null;
const tickerOf = (a) => a?.ticker ?? a?.symbol ?? "";
const precisionOf = (a) => a?.precision ?? 8;
/** Mirror of the daemon's bridgedTicker: the ticker a first bridge will get. */
function bridgedTicker(symbol, suffix) {
  const base = String(symbol || "").toUpperCase().replace(/[^A-Z0-9.-]/g, "") || "TOKEN";
  return `${base.slice(0, 10)}${suffix}`;
}
const retiredNote = (a) => (a?.retired ? a.retired.note || "no longer bridged" : null);

// ---------- links ----------
const seqSite = () => SEQ_SITES[status?.seqChainLabel] ?? null;
function seqTxLink(txid, text) {
  const label = escapeHtml(text ?? short(txid));
  return /^[0-9a-f]{64}$/i.test(txid ?? "") && seqSite()
    ? `<a href="${seqSite()}/explorer/tx/${txid}" target="_blank" rel="noopener">${label}</a>`
    : label;
}
function ethTxLink(hash, text) {
  const scan = ETHERSCAN[status?.ethChainId];
  const label = escapeHtml(text ?? short(hash));
  return /^0x[0-9a-f]{64}$/i.test(hash ?? "") && scan
    ? `<a href="${scan}/tx/${hash}" target="_blank" rel="noopener">${label}</a>`
    : label;
}
// Bitcoin transactions on mempool.space, for the testnet4 chain the SBTC reserve uses.
function btcTxLink(txid, text) {
  const label = escapeHtml(text ?? short(txid));
  return /^[0-9a-f]{64}$/i.test(txid ?? "") && /testnet4/i.test(status?.btcChainName ?? "Bitcoin testnet4")
    ? `<a href="https://mempool.space/testnet4/tx/${txid}" target="_blank" rel="noopener">${label}</a>`
    : label;
}
// The official Solana explorer, devnet only (other clusters need their own parameter).
function solTxLink(sig, text) {
  if (!sig || !/^[1-9A-HJ-NP-Za-km-z]{64,90}$/.test(sig) || !/devnet/i.test(solName())) return "";
  return `<a href="https://explorer.solana.com/tx/${sig}?cluster=devnet" target="_blank" rel="noopener">${escapeHtml(text)}</a>`;
}

// ---------- progress bars ----------
function setProgress(el, fraction, text) {
  const pct = Math.max(0, Math.min(100, Math.round(fraction * 100)));
  el.classList.remove("hide");
  el.querySelector(".fill").style.width = `${pct}%`;
  el.querySelector(".ptext").textContent = text;
  el.setAttribute("aria-valuenow", String(pct));
  el.setAttribute("aria-valuetext", text);
}
function progressHtml(fraction, text) {
  const pct = Math.max(0, Math.min(100, Math.round(fraction * 100)));
  const t = escapeHtml(text);
  return (
    `<div class="progress" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${pct}" aria-valuetext="${t}">` +
    `<div class="bar"><div class="fill" style="width:${pct}%"></div></div><div class="ptext">${t}</div></div>`
  );
}

// ---------- copy, QR codes and payment links ----------
function wireCopy(btn) {
  const target = $(btn.dataset.copy);
  btn.addEventListener("click", async () => {
    const text = target.textContent.trim();
    if (!text) return;
    const label = btn.dataset.label ?? (btn.dataset.label = btn.textContent);
    let ok = false;
    try {
      await navigator.clipboard.writeText(text);
      ok = true;
    } catch {
      // Clipboard refused (permissions, an insecure origin): select the text
      // so one keystroke copies it.
      const range = document.createRange();
      range.selectNodeContents(target);
      const sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
    }
    btn.textContent = ok ? "Copied" : "Selected: press Ctrl+C";
    btn.classList.toggle("done", ok);
    announce(ok ? "Address copied" : "Address selected; copy it with your keyboard");
    clearTimeout(btn._reset);
    btn._reset = setTimeout(() => {
      btn.textContent = label;
      btn.classList.remove("done");
    }, 2200);
  });
}

/** Fill one of the "send to this address" blocks: the address, its QR code
 *  (of the payment link when there is one) and the link itself. */
function showPayTarget(prefix, address, uri, what) {
  $(`${prefix}-addr`).textContent = address;
  const qr = $(`${prefix}-qr`);
  try {
    qr.innerHTML = qrSvg(uri ?? address, { label: `QR code of the ${what}` });
    qr.classList.remove("hide");
  } catch {
    qr.classList.add("hide");
  }
  const link = $(`${prefix}-link`);
  if (link && uri) link.href = uri;
}

// ---------- Sequentia address checks ----------
// Every Sequentia destination is checked against the node before any funds
// move. Both forms are valid: the default transparent address (tb1…) and the
// opt-in confidential one (tsqb1…), which hides the amount received for
// every asset except a supervised one.
const PLAUSIBLE_SEQ = /^[A-Za-z0-9]{14,120}$/;

// A supervised asset (a unified stablecoin whose issuer can freeze holders)
// can never be blinded: consensus rejects it in a blinded output. The bridge
// therefore delivers it to a confidential address's unconfidential form, the
// same wallet and script with the amount visible.
const isSupervised = (a) => a?.supervised === true || a?.supervision?.supervised === true;
const joinAnd = (names) => (names.length > 1 ? `${names.slice(0, -1).join(", ")} and ${names.at(-1)}` : names[0] ?? "");
/** What a confidential (blinded) destination means for `asset`, as plain
 *  text starting with `prefix`. `asset` is the asset that will arrive
 *  ({ticker, supervised} or an asset row), or null when any asset may
 *  (an address that takes whatever is sent to it). */
function blindedNote(prefix, asset, unconfidential) {
  const hidden = "the amount you receive will be hidden on chain.";
  const where = `the unconfidential form of this address${unconfidential ? ` (${unconfidential})` : ""}`;
  if (asset) {
    if (!isSupervised(asset)) return `${prefix}: ${hidden}`;
    const t = tickerOf(asset) || "This asset";
    return (
      `${prefix}. ${t} is a supervised asset and always travels transparently, so it will arrive at ${where} ` +
      "with the amount visible on chain. It is the same wallet."
    );
  }
  const sup = assets.filter(isSupervised).map(tickerOf).filter(Boolean);
  if (!sup.length) return `${prefix}: ${hidden}`;
  return (
    `${prefix}: the amount you receive will be hidden on chain, except for ${joinAnd(sup)}. ` +
    `Supervised assets always travel transparently, so they arrive at ${where} with the amount visible on chain. ` +
    "It is the same wallet."
  );
}

class SeqAddrField {
  /** `assetFor` names the asset this field receives, for the confidential
   *  address note: an asset, or null when the address may receive any. */
  constructor(id, onChange = () => {}, assetFor = () => null) {
    this.id = id;
    this.input = $(id);
    this.out = $(`${id}-check`);
    this.onChange = onChange;
    this.assetFor = assetFor;
    this.state = "empty";
    this.blinded = false;
    this.unconfidential = null;
    this.checked = null;
    this.seq = 0;
    this.timer = null;
    this.input.addEventListener("input", () => this.schedule());
  }
  get value() {
    return this.input.value.trim();
  }
  schedule() {
    clearTimeout(this.timer);
    if (!this.value) return this.set("empty");
    this.set("checking");
    this.timer = setTimeout(() => this.check(), 400);
  }
  async check() {
    clearTimeout(this.timer);
    const v = this.value;
    const n = ++this.seq;
    if (!v) {
      this.set("empty");
      return this.state;
    }
    let st;
    let blinded = false;
    let unconfidential = null;
    try {
      const r = await api(`seqaddress/${encodeURIComponent(v)}`);
      st = r.valid ? "valid" : "invalid";
      blinded = Boolean(r.blinded);
      if (typeof r.unconfidential === "string" && PLAUSIBLE_SEQ.test(r.unconfidential)) unconfidential = r.unconfidential;
    } catch {
      st = "unknown";
      blinded = /^tsqb/i.test(v);
    }
    if (n !== this.seq || v !== this.value) return this.state; // superseded by newer input
    this.checked = v;
    this.unconfidential = unconfidential;
    this.set(st, blinded);
    return st;
  }
  async ensure() {
    if (this.checked === this.value && this.state !== "checking") return this.state;
    return this.check();
  }
  /** Usable as a destination: confirmed valid, or plausible when the check
   *  itself could not run (the daemon still validates before minting). */
  ok() {
    return this.state === "valid" || (this.state === "unknown" && PLAUSIBLE_SEQ.test(this.value));
  }
  /** Say again what the address means, after the asset it receives changed. */
  renote() {
    if (this.state === "valid" || this.state === "unknown") this.set(this.state, this.blinded);
  }
  set(state, blinded = false) {
    this.state = state;
    this.blinded = blinded && (state === "valid" || state === "unknown");
    if (!this.blinded) this.unconfidential = null;
    const o = this.out;
    o.className = "addrcheck";
    this.input.removeAttribute("aria-invalid");
    const note = (prefix) => blindedNote(prefix, this.assetFor(), this.unconfidential);
    if (state === "empty") o.textContent = "";
    else if (state === "checking") o.textContent = "Checking the address…";
    else if (state === "valid" && this.blinded) {
      o.textContent = note("Confidential (blinded) address");
      o.classList.add("info");
    } else if (state === "valid") {
      o.textContent = "Valid Sequentia address.";
      o.classList.add("ok");
    } else if (state === "invalid") {
      o.textContent = "This is not a valid Sequentia address.";
      o.classList.add("bad");
      this.input.setAttribute("aria-invalid", "true");
    } else if (!PLAUSIBLE_SEQ.test(this.value)) {
      o.textContent = "This does not look like a Sequentia address.";
      o.classList.add("bad");
      this.input.setAttribute("aria-invalid", "true");
    } else {
      o.textContent =
        "The address could not be checked right now." +
        (this.blinded ? ` ${note("It looks like a confidential (blinded) address")}` : "");
    }
    this.onChange();
  }
}
const seqFields = {};

// ---------- a Sequentia wallet in the browser ----------
// When a Sequentia wallet injects its provider (window.sequentia), each
// address field offers to fill itself from it. A Sequentia wallet uses one
// tb1 address for Sequentia assets and for bitcoin, so the same address also
// fills the Bitcoin destination of an unwrap.
const seqWallet = () => (window.sequentia?.isSequentia ? window.sequentia : null);
function showWalletButtons() {
  if (!seqWallet()) return;
  for (const b of document.querySelectorAll(".walletfill")) b.classList.remove("hide");
}
async function fillFromSeqWallet(btn) {
  const p = seqWallet();
  if (!p) return;
  const input = $(btn.dataset.fill);
  const report = (msg) => {
    const out = $(`${btn.dataset.fill}-check`);
    if (out) {
      out.className = "addrcheck bad";
      out.textContent = msg;
    } else {
      say(btn.dataset.fill === "unwrap-btcaddr" ? "unwrap-status" : "dep-status", msg, "err");
    }
  };
  btn.disabled = true;
  try {
    const conn = await p.request({ method: "connect" });
    let address = conn?.address ?? null;
    try {
      const r = await p.request({ method: "getAddress", params: { confidential: false } });
      if (r?.address) address = r.address;
    } catch {
      /* the address from connect is the same default address */
    }
    if (!address) throw new Error("it returned no address");
    input.value = address;
    input.dispatchEvent(new Event("input", { bubbles: true }));
  } catch (e) {
    report(`Your Sequentia wallet did not share an address: ${e?.message ?? e}`);
  } finally {
    btn.disabled = false;
  }
}

// ---------- ethereum provider ----------
const rpc = (method, params = []) => {
  if (!window.ethereum) throw new Error("no Ethereum wallet found in this browser");
  return window.ethereum.request({ method, params });
};
const walletReady = () => Boolean(account && status && walletChainId === status.ethChainId);
function walletError(e) {
  if (e?.code === 4001) return "You rejected the request in your wallet.";
  return e?.message ?? String(e);
}
/** The vault's own chain, in the shape the send and receipt helpers take. */
const vaultChain = () => ({ chainId: status.ethChainId, name: ethName() });
const chainHex = (id) => "0x" + Number(id).toString(16);

/** The chain the wallet is on right now, read from the wallet itself rather
 *  than from the last event it sent. */
async function readWalletChain() {
  const now = parseInt(await rpc("eth_chainId"), 16);
  if (now !== walletChainId) {
    walletChainId = now;
    renderWallet();
  }
  return now;
}

/** Send a transaction on `chain`, and only there. The wallet's chain is read
 *  again immediately before the send, and the chainId goes into the request
 *  so the wallet itself refuses it on any other chain. */
async function sendTx(params, chain) {
  const want = Number(chain.chainId);
  if ((await readWalletChain()) !== want) {
    throw new Error(`Your wallet is on another network. Switch it to ${chain.name}; nothing was sent.`);
  }
  return rpc("eth_sendTransaction", [{ ...params, chainId: chainHex(want) }]);
}

let ethListening = false;
function listenEth() {
  if (ethListening || !window.ethereum?.on) return;
  ethListening = true;
  window.ethereum.on("accountsChanged", (a) => {
    account = a[0] ?? null;
    renderWallet();
    onAccount();
  });
  window.ethereum.on("chainChanged", (c) => {
    walletChainId = parseInt(c, 16);
    renderWallet();
  });
}

async function connect() {
  if (!window.ethereum) {
    say("wallet-line", "No Ethereum wallet found in this browser. Install MetaMask to deposit from Ethereum.", "err");
    return;
  }
  try {
    const accounts = await rpc("eth_requestAccounts");
    account = accounts[0] ?? null;
    walletChainId = parseInt(await rpc("eth_chainId"), 16);
    listenEth();
  } catch (e) {
    say("wallet-line", walletError(e), "err");
    return;
  }
  renderWallet();
  onAccount();
}

/** Pick up a wallet this site is already connected to, without a prompt. */
async function restoreEthWallet() {
  if (!window.ethereum) return;
  try {
    const accounts = await rpc("eth_accounts");
    if (!accounts?.length) return;
    account = accounts[0];
    walletChainId = parseInt(await rpc("eth_chainId"), 16);
    listenEth();
    renderWallet();
    onAccount();
  } catch {
    /* not connected; the button stays */
  }
}

async function switchNetwork() {
  try {
    await rpc("wallet_switchEthereumChain", [{ chainId: "0x" + status.ethChainId.toString(16) }]);
  } catch (e) {
    say("wallet-line", `Switch to ${ethName()} in your wallet: ${walletError(e)}`, "err");
  }
}

function renderWallet() {
  const btn = $("btn-connect");
  if (!account) {
    btn.textContent = "Connect wallet";
    say("wallet-line", "");
  } else if (status && walletChainId !== status.ethChainId) {
    btn.textContent = `Switch to ${ethName()}`;
    say("wallet-line", `${short(account)} is on another network; Compages uses ${ethName()}.`, "err");
  } else {
    btn.textContent = short(account);
    say("wallet-line", "connected", "ok");
  }
  updateDepositButton();
  renderCctpWallet();
  renderClaim();
}

/** With a connected account, fill the redemption form and show that
 *  account's redemption address for the chain under "Receive on", if it has
 *  one. A redemption the user asked for is never replaced; one restored from
 *  an earlier visit is replaced only by one for the same payout chain. */
function onAccount() {
  if (!account) return;
  const input = $("ethaddr-input");
  if (!input.value.trim()) input.value = account;
  if (!ethRedeem || ethRedeem.origin !== "user") lookupRedemptionByEth(account, { quiet: true });
}

// ---------- deposit asset selector (keyboard-operable combobox) ----------
let dropItems = [];
let dropActive = -1;

function dropOpen(open) {
  $("token-droplist").classList.toggle("hide", !open);
  $("token-search").setAttribute("aria-expanded", String(open));
  if (!open) {
    dropActive = -1;
    $("token-search").removeAttribute("aria-activedescendant");
  }
}
const dropIsOpen = () => !$("token-droplist").classList.contains("hide");

function tokenEntries() {
  const raw = $("token-search").value.trim();
  const q = raw.toLowerCase();
  const items = [];
  if (/^0x[0-9a-fA-F]{40}$/.test(raw)) {
    const addr = raw.toLowerCase();
    items.push({ title: `Look up ${short(addr)}`, sub: "any ERC-20 by its address", pick: () => pickToken(addr, addr) });
  }
  const eth = assetForToken(ETH_CHAIN(), "eth");
  const entries = [
    {
      t: "eth",
      title: "ETH",
      sub: `Ether, ${ethName()}'s own coin → ${eth ? tickerOf(eth) : "ETH.e"}`,
      retired: retiredNote(eth),
    },
  ];
  for (const a of legAssets(ETH_CHAIN())) {
    const s = sourceOn(a, ETH_CHAIN());
    if (!s || s.token === "eth") continue;
    entries.push({ t: s.token.toLowerCase(), title: a.symbol, sub: `${a.name} → ${tickerOf(a)}`, retired: retiredNote(a) });
  }
  for (const e of entries) {
    const hay = `${e.title} ${e.sub} ${e.t}`.toLowerCase();
    if (q && !hay.includes(q)) continue;
    items.push(
      e.retired
        ? { title: e.title, sub: `retired: ${e.retired}`, disabled: true }
        : { title: e.title, sub: e.sub, pick: () => pickToken(e.t, e.title) }
    );
  }
  return items;
}

function renderTokenDroplist() {
  const box = $("token-droplist");
  dropItems = tokenEntries();
  box.innerHTML = "";
  if (!dropItems.length) {
    box.innerHTML = `<div class="droprow empty note" role="option" aria-disabled="true">No match. Paste an ERC-20 contract address (0x…).</div>`;
    dropActive = -1;
    return;
  }
  if (dropActive >= dropItems.length) dropActive = -1;
  dropItems.forEach((it, i) => {
    const d = document.createElement("div");
    d.className = "droprow" + (i === dropActive ? " active" : "");
    d.id = `tokopt-${i}`;
    d.setAttribute("role", "option");
    d.setAttribute("aria-selected", String(i === dropActive));
    if (it.disabled) d.setAttribute("aria-disabled", "true");
    d.innerHTML = `<span class="sym">${escapeHtml(it.title)}</span> <span class="note">${escapeHtml(it.sub)}</span>`;
    // mousedown, not click: the input's blur fires first and would close the list.
    d.addEventListener("mousedown", (ev) => {
      ev.preventDefault();
      if (!it.disabled) it.pick();
    });
    box.appendChild(d);
  });
}

function setDropActive(i) {
  dropActive = i;
  const input = $("token-search");
  for (const [j, el] of [...$("token-droplist").children].entries()) {
    el.classList.toggle("active", j === i);
    el.setAttribute("aria-selected", String(j === i));
  }
  if (i >= 0) {
    input.setAttribute("aria-activedescendant", `tokopt-${i}`);
    $(`tokopt-${i}`)?.scrollIntoView({ block: "nearest" });
  } else {
    input.removeAttribute("aria-activedescendant");
  }
}
function moveDrop(step) {
  if (!dropItems.length) return;
  let i = dropActive;
  for (let n = 0; n < dropItems.length; n++) {
    i = (i + step + dropItems.length) % dropItems.length;
    if (!dropItems[i].disabled) return setDropActive(i);
  }
}

function pickToken(t, label) {
  $("token-search").value = label;
  dropOpen(false);
  selectToken(t);
}

function wireTokenCombo() {
  const input = $("token-search");
  const open = () => {
    renderTokenDroplist();
    dropOpen(true);
  };
  input.addEventListener("focus", open);
  input.addEventListener("click", open);
  input.addEventListener("input", () => {
    dropActive = -1;
    open();
  });
  input.addEventListener("blur", () => setTimeout(() => dropOpen(false), 120));
  input.addEventListener("keydown", (e) => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      if (!dropIsOpen()) open();
      moveDrop(e.key === "ArrowDown" ? 1 : -1);
    } else if (e.key === "Enter") {
      if (dropIsOpen() && dropActive >= 0 && dropItems[dropActive]?.pick) {
        e.preventDefault();
        dropItems[dropActive].pick();
      } else if (/^0x[0-9a-fA-F]{40}$/.test(input.value.trim())) {
        e.preventDefault();
        pickToken(input.value.trim().toLowerCase(), input.value.trim().toLowerCase());
      }
    } else if (e.key === "Escape") {
      if (dropIsOpen()) {
        e.preventDefault();
        dropOpen(false);
      }
    }
  });
}

// ---------- token selection ----------
async function selectToken(t) {
  const card = $("token-card");
  card.classList.remove("hide");
  card.innerHTML = `<span class="note">Looking up the token…</span>`;
  token = null;
  updateDepositButton();
  renderDepositPreview();
  let info;
  try {
    info = await api(`token/${encodeURIComponent(t)}`);
  } catch (e) {
    card.innerHTML = `<span class="note">${escapeHtml(e.message)}</span>`;
    return;
  }
  // What the user receives on Sequentia. The asset list is authoritative:
  // it knows unified stablecoins, whose Sequentia asset is shared across
  // chains and has its own precision.
  const a = assetForToken(ETH_CHAIN(), info.token);
  info.receive = a
    ? {
        ticker: tickerOf(a),
        precision: precisionOf(a),
        assetId: a.assetId,
        exists: true,
        unified: a.unified,
        supervised: isSupervised(a),
        retired: retiredNote(a),
      }
    : {
        ticker: info.bridged && info.ticker ? info.ticker : bridgedTicker(info.symbol, ".e"),
        precision: info.precision ?? 8,
        assetId: info.assetId ?? null,
        exists: Boolean(info.bridged),
        unified: false,
        supervised: false,
        retired: null,
      };
  token = info;
  seqFields.dep?.renote();
  const r = info.receive;
  const isEth = info.token === "eth";
  const idLine = isEth
    ? `ether, ${escapeHtml(ethName())}'s own coin`
    : `<span class="mono">${escapeHtml(info.token)}</span>`;
  const badge = r.retired
    ? '<span class="badge retired">retired</span>'
    : r.exists
      ? '<span class="badge known">already bridged</span>'
      : '<span class="badge new">first bridge</span>';
  const tick = `<strong>${escapeHtml(r.ticker)}</strong>`;
  let note;
  if (r.retired) {
    note = `The operator has retired ${tick}: ${escapeHtml(r.retired)}. It cannot be bridged.`;
  } else if (r.exists) {
    note =
      `You receive ${tick} on Sequentia. It already exists there` +
      (r.assetId ? ` (asset <span class="mono">${escapeHtml(short(r.assetId))}</span>)` : "") +
      `, so your deposit <strong>mints more of the same asset</strong>; no duplicate is created.` +
      (r.unified ? ` ${tick} is one asset for ${escapeHtml(info.symbol)} from every chain the bridge accepts it from.` : "");
  } else {
    note =
      `Not on Sequentia yet. <strong>You would be the first to bridge it</strong>: your deposit issues a new ` +
      `Sequentia asset, ${tick}, and later deposits by anyone mint more of that same asset.`;
  }
  card.innerHTML =
    `<div><span class="sym">${escapeHtml(info.symbol)}</span> <span class="note">${escapeHtml(info.name)}</span>${badge}</div>` +
    `<div class="mono" style="margin-top:4px">${idLine} &middot; ${Number(info.decimals)} decimals</div>` +
    `<div class="note" style="margin-top:6px">${note}</div>`;
  const maxDp = Math.min(r.precision, info.decimals);
  $("amount-note").textContent =
    `Up to ${maxDp} decimal places.` +
    (info.decimals > r.precision ? ` ${r.ticker} has ${r.precision}, so finer amounts cannot be bridged.` : "");
  updateDepositButton();
  renderDepositPreview();
}

/** The deposit amount in base units and in Sequentia atoms, or an error. */
function depositAmount() {
  const raw = $("amount-input").value.trim();
  if (!token || !raw) return null;
  try {
    const units = parseUnits(raw, token.decimals, token.receive.precision);
    const atoms = unitsToAtoms(units, token.decimals, token.receive.precision);
    if (atoms === 0n) return { error: "This amount is too small to represent on Sequentia." };
    return { units, atoms };
  } catch (e) {
    return { error: e.message };
  }
}

function updateDepositButton() {
  const btn = $("btn-deposit");
  const amt = depositAmount();
  const ready =
    !depositBusy &&
    walletReady() &&
    token &&
    !token.receive.retired &&
    amt &&
    !amt.error &&
    seqFields.dep?.ok();
  btn.disabled = !ready;
  if (!depositBusy) btn.textContent = token ? `Deposit ${token.symbol}` : "Deposit";
}

const ethFinality = () => status?.ethFinality ?? "confirmations";
// Operator-provided: always a plain number before it reaches the page.
const ethConfs = () => Math.max(1, Math.floor(Number(status?.ethConfirmations)) || 1);
function expectedDepositMinutes() {
  return ethFinality() === "finalized"
    ? ETH_FINALITY_MINUTES
    : Math.max(1, Math.ceil((ethConfs() * ETH_BLOCK_SECONDS) / 60));
}
function depositWaitText() {
  if (ethFinality() === "finalized") {
    return `Expected wait: about ${ETH_FINALITY_MINUTES} minutes. The bridge mints once Ethereum finalizes the block holding your deposit.`;
  }
  const n = ethConfs();
  return `Expected wait: ${fmtMinutes(expectedDepositMinutes())}, for ${n} Ethereum confirmation${n === 1 ? "" : "s"}, then minting on Sequentia.`;
}

// Pre-commit preview: what arrives, what it costs, how long it takes.
function renderDepositPreview() {
  const box = $("dep-preview");
  const amt = depositAmount();
  if (!amt || !status) {
    box.classList.add("hide");
    box.innerHTML = "";
    return;
  }
  box.classList.remove("hide");
  if (amt.error) {
    box.innerHTML = `<span class="note">${escapeHtml(amt.error)}</span>`;
    return;
  }
  const r = token.receive;
  const lines = [
    `<div class="note"><strong>You receive ${formatAtoms(amt.atoms, r.precision)} ${escapeHtml(r.ticker)}</strong> on Sequentia` +
      (r.exists ? "" : ", issued as a new asset by your deposit") +
      ".</div>",
    `<div class="note">No bridge fee. You pay the Ethereum gas; the operator pays the Sequentia network fees.</div>`,
    `<div class="note">${escapeHtml(depositWaitText())}</div>`,
  ];
  if (token.token !== "eth") {
    lines.push(`<div class="note">Your wallet first asks you to let the vault spend this ${escapeHtml(token.symbol)}.</div>`);
  }
  if (r.assetId && haltedAssets.has(r.assetId)) {
    lines.push(
      `<div class="note"><strong>Minting of ${escapeHtml(r.ticker)} is paused while the operator investigates.</strong> A deposit made now waits and mints once it resumes.</div>`
    );
  }
  if (seqFields.dep?.blinded) {
    lines.push(
      `<div class="note">${escapeHtml(blindedNote("Your address is confidential (blinded)", r, seqFields.dep.unconfidential))}</div>`
    );
  }
  box.innerHTML = lines.join("");
}

// ---------- deposit flow ----------
/** Wait for a transaction on `chain` ({chainId, name}) through the user's
 *  wallet. Answers with the receipt, or why there is none: replaced (a
 *  speed-up or cancel reused its nonce), missing (the chain never saw it),
 *  timeout, or cancelled (a newer tracker took over).
 *
 *  The wallet only sees the chain it is on, so its chain is read again on
 *  every poll. While it is elsewhere nothing is judged: the caller is told to
 *  switch back, and that time does not count toward any give-up. */
async function waitReceipt(hash, chain, { alive = () => true, onNote = () => {} } = {}) {
  const want = Number(chain.chainId);
  const away = () => onNote(`Switch your wallet back to ${chain.name} to keep following this transaction.`);
  let started = Date.now();
  let seen = null;
  let lastSeenAt = Date.now();
  let wasAway = false;
  for (;;) {
    if (!alive()) return { kind: "cancelled" };
    const pollStart = Date.now();
    let offChain = false;
    try {
      if ((await readWalletChain()) !== want) {
        offChain = true;
      } else {
        if (wasAway) onNote("");
        const r = await rpc("eth_getTransactionReceipt", [hash]);
        if (r) return { kind: "receipt", receipt: r };
        const tx = await rpc("eth_getTransactionByHash", [hash]);
        if (tx) {
          seen = tx;
          lastSeenAt = Date.now();
        }
        let verdict = null;
        if (seen?.from && seen.nonce) {
          const next = parseInt(await rpc("eth_getTransactionCount", [seen.from, "latest"]), 16);
          if (next > parseInt(seen.nonce, 16)) {
            // The nonce is used. Either this transaction was just mined or
            // another one took its place.
            const again = await rpc("eth_getTransactionReceipt", [hash]);
            if (again) return { kind: "receipt", receipt: again };
            verdict = "replaced";
          }
        }
        if (!verdict && !tx && Date.now() - lastSeenAt > 3 * 60_000) verdict = seen ? "replaced" : "missing";
        // Every answer above must have come from `chain`: a wallet that moved
        // mid-poll answered some of them from another one.
        if (verdict && (await readWalletChain()) !== want) offChain = true;
        else if (verdict) return { kind: verdict };
      }
    } catch (e) {
      onNote(`Your wallet could not reach ${chain.name} (${e?.message ?? e}); retrying.`);
    }
    if (offChain) {
      away();
      wasAway = true;
    } else {
      wasAway = false;
      if (Date.now() - started > 30 * 60_000) return { kind: "timeout" };
    }
    const hidden = await pollSleep(4000);
    // Time spent on another chain or in a hidden tab is not time the
    // transaction had to show up in.
    const skip = offChain ? Date.now() - pollStart : hidden;
    started += skip;
    lastSeenAt += skip;
  }
}

async function waitApproval(hash, chain, statusId, again = "press Deposit again") {
  const r = await waitReceipt(hash, chain, { onNote: (n) => n && say(statusId, n) });
  if (r.kind === "receipt") {
    if (r.receipt.status !== "0x1") throw new Error("The approval failed. Nothing was deposited.");
    return;
  }
  if (r.kind === "replaced") {
    throw new Error(`The approval was replaced in your wallet. Once the new one is mined, ${again}.`);
  }
  throw new Error(`The approval was not mined. Check your wallet, then ${again}.`);
}

/** Make sure `spender` may take `units` of `tokenAddr` from the account,
 *  approving if not. Some tokens (USDT among them) refuse to change one
 *  non-zero allowance into another, so an existing one goes to zero first. */
async function ensureAllowance(chain, tokenAddr, spender, units, symbol, statusId, btn, again) {
  if ((await readWalletChain()) !== Number(chain.chainId)) {
    throw new Error(`Your wallet is on another network. Switch it to ${chain.name}; nothing was sent.`);
  }
  const hex = await rpc("eth_call", [{ to: tokenAddr, data: dataAllowance(account, spender) }, "latest"]);
  const allowance = BigInt(!hex || hex === "0x" ? 0 : hex);
  if (allowance >= units) return;
  if (allowance > 0n) {
    btn.textContent = "Reset the allowance in your wallet…";
    say(statusId, `${symbol} needs its current allowance set to zero before a new one. Confirm that first.`);
    const h0 = await sendTx({ from: account, to: tokenAddr, data: dataApprove(spender, 0n) }, chain);
    say(statusId, `Allowance reset sent (${short(h0)}); waiting for it to be mined.`);
    await waitApproval(h0, chain, statusId, again);
  }
  btn.textContent = `Approve ${symbol} in your wallet…`;
  const h = await sendTx({ from: account, to: tokenAddr, data: dataApprove(spender, units) }, chain);
  say(statusId, `Approval sent (${short(h)}); waiting for it to be mined.`);
  await waitApproval(h, chain, statusId, again);
}

async function deposit() {
  if (depositBusy || !token) return;
  const amt = depositAmount();
  if (!amt || amt.error) {
    say("dep-status", amt?.error ?? "Enter an amount.", "err");
    return;
  }
  const field = seqFields.dep;
  await field.ensure();
  if (!field.ok()) {
    say("dep-status", "Enter a valid Sequentia address first. Nothing has been sent.", "err");
    return;
  }
  const seqAddr = field.value;
  const t = token;
  const vault = status.vaultAddress;
  const btn = $("btn-deposit");
  depositBusy = true;
  updateDepositButton();
  say("dep-status", "");
  try {
    let txParams;
    if (t.token === "eth") {
      txParams = { from: account, to: vault, value: "0x" + amt.units.toString(16), data: dataDepositEther(seqAddr) };
    } else {
      await ensureAllowance(vaultChain(), t.token, vault, amt.units, t.symbol, "dep-status", btn, "press Deposit again");
      txParams = { from: account, to: vault, data: dataDepositToken(t.token, amt.units, seqAddr) };
    }
    btn.textContent = "Confirm the deposit in your wallet…";
    const hash = await sendTx(txParams, vaultChain());
    depositBusy = false;
    updateDepositButton();
    trackDeposit(hash, { sent: true });
  } catch (e) {
    say("dep-status", walletError(e), "err");
  } finally {
    depositBusy = false;
    updateDepositButton();
  }
}

function setSeg(i, state) {
  // state: "active" | "done" | "bad" | ""
  $(`seg-${i}`).className = "span-seg" + (state ? " " + state : "");
  $(`lab-${i}`).className = state === "done" ? "done" : "";
}
function resetTruss() {
  for (let i = 0; i < 4; i++) setSeg(i, "");
  $("lab-1").textContent = ethFinality() === "finalized" ? "Ethereum finality" : "confirming";
  $("dep-progress").classList.add("hide");
  $("dep-truss").classList.add("on");
}

const isVaultDeposit = (receipt) => {
  const vaults = (status.vaultAddresses?.length ? status.vaultAddresses : [status.vaultAddress])
    .filter(Boolean)
    .map((v) => v.toLowerCase());
  return (receipt.logs ?? []).some((l) => vaults.includes(String(l.address).toLowerCase()));
};

/** Follow one deposit from the Ethereum transaction to delivery on Sequentia.
 *  Starting another track cancels this one. */
async function trackDeposit(rawHash, { sent = false } = {}) {
  const hash = rawHash.toLowerCase();
  const id = ++depTrackId;
  const alive = () => id === depTrackId;
  store.set("eth.depositTx", hash);
  $("resume-dep-input").value = hash;
  resetTruss();
  setSeg(0, "active");
  const prog = $("dep-progress");
  const head = `deposit ${ethTxLink(hash, short(hash))}`;
  const line = (html, tone) => alive() && sayHtml("dep-status", `${head}<br><span class="plain">${html}</span>`, tone);
  const waitingText = sent ? "Waiting for Ethereum to mine your deposit." : "Looking up this deposit.";
  line(waitingText);
  const expectMin = expectedDepositMinutes();
  const ctx = { minedBlock: null, minedTs: null };
  // A hash that can never become a deposit is not worth resuming on reload.
  const forget = () => store.get("eth.depositTx") === hash && store.set("eth.depositTx", null);
  /** A transaction receipt that settles the question: a failure, or a
   *  transaction that is not a deposit. Answers true when it did. */
  const judgeReceipt = (receipt) => {
    if (receipt.status !== "0x1") {
      setSeg(0, "bad");
      line("This transaction failed on Ethereum, so nothing was deposited.", "err");
      forget();
      return true;
    }
    if (!isVaultDeposit(receipt)) {
      setSeg(0, "bad");
      line("This transaction is not a Compages deposit: it did not deposit into the bridge's vault.", "err");
      forget();
      return true;
    }
    ctx.minedBlock = parseInt(receipt.blockNumber, 16);
    return false;
  };
  try {
    // With a wallet on the right network, follow the transaction itself: a
    // failed, replaced or unrelated transaction is caught at once.
    if (walletReady()) {
      const r = await waitReceipt(hash, vaultChain(), {
        alive,
        onNote: (n) => line(n ? escapeHtml(n) : waitingText),
      });
      if (!alive() || r.kind === "cancelled") return;
      if (r.kind !== "receipt") {
        setSeg(0, "bad");
        const msg = {
          replaced:
            "Your wallet replaced this transaction (a speed-up or a cancel), so it will never be mined. " +
            "If you sped it up, paste the new transaction hash below to track that one.",
          missing: `${escapeHtml(ethName())} does not know this transaction. Check the hash, and that it was sent on ${escapeHtml(ethName())}. If your wallet replaced it, paste the new hash below.`,
          timeout:
            "Ethereum has not mined this transaction in 30 minutes. If you sped it up or replaced it in your wallet, paste the new hash below.",
        }[r.kind];
        line(msg, "err");
        forget();
        $("resume-dep-input").value = "";
        $("resume-dep-input").focus();
        return;
      }
      if (judgeReceipt(r.receipt)) return;
    }
    setSeg(0, "done");
    setSeg(1, "active");
    const watchStart = Date.now();
    for (;;) {
      if (!alive()) return;
      let list = null;
      let apiError = null;
      let limited = false;
      try {
        list = await api(`deposit/tx/${hash}`);
      } catch (e) {
        if (e.status === 429) limited = true;
        if (e.status !== 404) apiError = e.message;
      }
      if (!alive()) return;
      let next = 6000;
      if (Array.isArray(list) && list.length) {
        prog.classList.add("hide");
        if (renderDeposit(list, line)) {
          refreshAssets();
          return;
        }
      } else {
        // Not followed through the wallet yet (resumed without one, or on
        // another network): check the receipt whenever the wallet is on the
        // vault's chain, since only it can tell a failed or unrelated
        // transaction from a slow one.
        if (ctx.minedBlock === null && walletReady()) {
          try {
            if ((await readWalletChain()) === status.ethChainId) {
              const receipt = await rpc("eth_getTransactionReceipt", [hash]);
              if (!alive()) return;
              if (receipt && judgeReceipt(receipt)) return;
            }
          } catch {
            /* the bridge's own answer below still stands */
          }
        }
        const waited = (Date.now() - watchStart) / 60_000;
        if (ctx.minedBlock === null && waited > expectMin + 30) {
          // Without the transaction itself there is no telling a slow
          // deposit from something else, so nothing is concluded: keep
          // watching, less often.
          prog.classList.add("hide");
          line(
            `The bridge has not seen a deposit in this transaction yet, after ${Math.round(waited)} minutes. ` +
              `It keeps watching. To check the transaction itself, connect your wallet on ${escapeHtml(ethName())}.` +
              (apiError ? ` (The bridge did not answer: ${escapeHtml(apiError)}. Retrying.)` : "")
          );
          next = IDLE_POLL_MS;
        } else {
          await renderFinalityWait(ctx, line, apiError, waited, expectMin);
        }
      }
      await pollSleep(limited ? BACKOFF_MS : next);
    }
  } catch (e) {
    line(escapeHtml(walletError(e)), "err");
  }
}

/** Progress while Ethereum finalizes (or confirms) the deposit's block. */
async function renderFinalityWait(ctx, line, apiError, waited, expectMin) {
  const prog = $("dep-progress");
  const trouble = apiError ? ` (The bridge did not answer: ${escapeHtml(apiError)}. Retrying.)` : "";
  if (ctx.minedBlock !== null && walletReady()) {
    try {
      if (ethFinality() === "confirmations") {
        const headN = parseInt(await rpc("eth_blockNumber"), 16);
        const need = ethConfs();
        const confs = Math.max(0, headN - ctx.minedBlock + 1);
        const left = Math.max(0, need - confs);
        $("lab-1").textContent = `confirming ${Math.min(confs, need)}/${need}`;
        setProgress(
          prog,
          confs / need,
          left
            ? `${Math.min(confs, need)} of ${need} confirmations · ${fmtMinutes((left * ETH_BLOCK_SECONDS) / 60)} left`
            : "Confirmed. The bridge picks it up shortly."
        );
      } else {
        const fin = await rpc("eth_getBlockByNumber", ["finalized", false]);
        if (fin && parseInt(fin.number, 16) >= ctx.minedBlock) {
          setProgress(prog, 1, "Ethereum has finalized the block. The bridge mints it shortly.");
        } else {
          if (ctx.minedTs === null) {
            const b = await rpc("eth_getBlockByNumber", ["0x" + ctx.minedBlock.toString(16), false]);
            ctx.minedTs = b ? parseInt(b.timestamp, 16) : Date.now() / 1000;
          }
          const elapsed = (Date.now() / 1000 - ctx.minedTs) / 60;
          const left = ETH_FINALITY_MINUTES - elapsed;
          setProgress(
            prog,
            elapsed / ETH_FINALITY_MINUTES,
            left > 0.5
              ? `Waiting for Ethereum to finalize the block · ${fmtMinutes(left)} left`
              : "Waiting for Ethereum to finalize the block · any moment now"
          );
        }
      }
      line(`Mined in block ${ctx.minedBlock}. ${escapeHtml(depositWaitText())}${trouble}`);
      return;
    } catch {
      /* fall through to the estimate without the wallet */
    }
  }
  prog.classList.add("hide");
  line(
    `If this is a deposit, the bridge picks it up ${
      ethFinality() === "finalized"
        ? `once Ethereum finalizes its block, about ${ETH_FINALITY_MINUTES} minutes after it is mined`
        : `after ${ethConfs()} confirmations`
    }. Watching for ${Math.round(waited)} of up to ${Math.round(expectMin + 30)} minutes.${trouble}`
  );
}

// Record statuses a person must read in plain words. `waiting` can name an
// operator halt; its internal reason is not for the public page.
function publicWaiting(w) {
  if (!w) return "";
  return /^halted/i.test(w) ? "minting of this asset is paused while the operator investigates" : w;
}

/** A deposit record (either leg) in plain words. `leg` supplies the source
 *  chain's name and where its funds wait meanwhile. */
function describeDeposit(dep, leg, amountText) {
  const reason = escapeHtml(dep.refundReason ?? "see the operator");
  const wait = dep.waiting ? escapeHtml(publicWaiting(dep.waiting)) : "";
  const safe = `Your funds are safe ${leg.custody}.`;
  let html;
  let cls = "wait";
  let stage = 2;
  let terminal = false;
  switch (dep.status) {
    case "minting":
      html = "Minting on Sequentia.";
      break;
    case "mint_retry":
      html = wait ? `Minting is waiting: ${wait}. It continues on its own.` : "Minting on Sequentia, retrying after a temporary error.";
      break;
    case "send_retry":
      html = wait
        ? `Minted; sending it to your address is waiting: ${wait}. It continues on its own.`
        : "Minted; sending it to your address, retrying after a temporary error.";
      break;
    case "unresolved":
      html =
        "The bridge is waiting for the Sequentia node to confirm a transaction it sent. Nothing is lost; it is checked again every minute.";
      break;
    case "minted":
      html =
        `Delivered: ${escapeHtml(amountText)} sent to your Sequentia address` +
        (dep.deliveryFinal ? ", final under Bitcoin anchoring." : ".") +
        (dep.seqTxid ? ` Transaction ${seqTxLink(dep.seqTxid)}.` : "");
      cls = "ok";
      stage = 3;
      terminal = true;
      break;
    case "delivery_reorged":
      html = "The delivery was undone by a reorg on Sequentia. The operator has been alerted and will send it again.";
      cls = "bad";
      break;
    case "refund_pending":
      html = `This deposit cannot be bridged (${reason}). A refund on ${escapeHtml(leg.chain)} is queued${wait ? `; it is waiting: ${wait}` : ""}.`;
      cls = "bad";
      stage = 1;
      break;
    case "refunding":
      html = `This deposit cannot be bridged (${reason}). Refunding it on ${escapeHtml(leg.chain)}.`;
      cls = "bad";
      stage = 1;
      break;
    case "queued":
    case "refund_queued":
      html = `This deposit cannot be bridged (${reason}). ${queuedText(dep.executeAfter)}`;
      cls = "bad";
      stage = 1;
      break;
    case "refund_cancelled":
      html = `This deposit cannot be bridged (${reason}), and its refund was stopped. ${GUARDIAN_TEXT}`;
      cls = "bad";
      stage = 1;
      break;
    case "refunded": {
      stage = 1;
      cls = "bad";
      terminal = true;
      if (dep.cctpOut) {
        const o = cctpOutHtml(dep);
        html = `This deposit could not be bridged (${reason}), so it is being returned.${o.html}`;
        terminal = cctpOutDone(dep);
        break;
      }
      html =
        `Refunded on ${escapeHtml(leg.chain)}: this deposit could not be bridged (${reason}).` +
        (dep.refundTxHash ? ` Refund ${ethTxLink(dep.refundTxHash)}.` : "") +
        deferredHtml(dep, "refund");
      break;
    }
    case "refund_failed_manual":
      html = `This deposit cannot be bridged (${reason}), and the refund could not be sent automatically. The operator has been alerted. ${safe}`;
      cls = "bad";
      stage = 1;
      terminal = true;
      break;
    case "failed_manual":
      html = `The bridge hit an unexpected error and paused this deposit for the operator, who has been alerted. ${safe}`;
      cls = "bad";
      terminal = true;
      break;
    case "dust_manual":
      html = "This deposit is too small to bridge. It is set aside for the operator.";
      cls = "bad";
      terminal = true;
      break;
    default:
      html = `Status: ${escapeHtml(dep.status)}.`;
  }
  if (dep.retired) {
    html += ` The operator has closed this record: ${escapeHtml(dep.retired.note || "no note")}.`;
    terminal = true;
  }
  return { html, cls, stage, terminal };
}

const ETH_DEPOSIT_LEG = () => ({ chain: ethName(), custody: "in the vault" });

/** Render the Ethereum deposit record(s) of one transaction into the truss
 *  and status line. Returns true once nothing more will change. */
function renderDeposit(list, line) {
  const dep = list[list.length - 1];
  const a = assetById(dep.assetId) ?? assetForToken(ETH_CHAIN(), dep.token);
  const ticker = a ? tickerOf(a) : token?.receive?.ticker ?? "";
  const amount = dep.sats ? `${formatAtoms(dep.sats, a ? precisionOf(a) : 8)} ${ticker}`.trim() : "your deposit";
  const d = describeDeposit(dep, ETH_DEPOSIT_LEG(), amount);
  setSeg(0, "done");
  setSeg(1, "done");
  if (d.stage >= 3) {
    setSeg(2, "done");
    setSeg(3, "done");
  } else if (d.cls === "bad") {
    setSeg(2, "bad");
  } else {
    setSeg(2, "active");
  }
  const more = list.length > 1 ? ` (${list.length} deposits in this transaction; showing the last)` : "";
  line(d.html + escapeHtml(more), d.cls === "bad" ? "err" : d.cls === "ok" ? "ok" : undefined);
  return d.terminal;
}

function resumeDeposit() {
  const hash = $("resume-dep-input").value.trim().toLowerCase();
  if (!/^0x[0-9a-f]{64}$/.test(hash)) {
    say("dep-status", "Enter an Ethereum transaction hash: 0x followed by 64 hex characters.", "err");
    return;
  }
  trackDeposit(hash);
}

// ---------- redemptions (Ethereum and Solana legs) ----------
// Address views poll the bridge for their records. `fn` answers "stop" when
// there is nothing more to follow, or "idle" when every record it shows is
// final, so that only a new transfer to the address could change the view;
// that is checked once a minute. Polling pauses while the tab is hidden and
// backs off after a 429.
const polls = {};
function stopPoll(name) {
  if (polls[name]) clearTimeout(polls[name].timer);
  polls[name] = null;
}
function poll(name, fn, ms) {
  stopPoll(name);
  const p = (polls[name] = { timer: null });
  const tick = async () => {
    await whenVisible();
    if (polls[name] !== p) return;
    let next = ms;
    try {
      const r = await fn();
      if (r === "stop") {
        if (polls[name] === p) stopPoll(name);
        return;
      }
      if (r === "idle") next = IDLE_POLL_MS;
    } catch (e) {
      if (e?.status === 429) next = BACKOFF_MS;
    }
    if (polls[name] === p) p.timer = setTimeout(tick, next);
  };
  tick();
}

/** A redemption nothing more will happen to: paid (and, for a payout to
 *  another chain, claimed there), set aside, or closed by the operator. */
const REDEEM_PAID = ["released", "destroy_pending", "destroying", "destroy_manual", "done"];
const REDEEM_SET_ASIDE = ["dust_ignored", "ignored_unknown_asset", "ignored_wrong_network"];
function redemptionFinal(ev) {
  if (ev.retired) return true;
  if (REDEEM_PAID.includes(ev.status)) return (!ev.cctpOut || cctpOutDone(ev)) && !ev.deferred?.to;
  return /_manual$/.test(ev.status ?? "") || REDEEM_SET_ASIDE.includes(ev.status);
}

/** A redemption record in plain words, with finality progress and an
 *  estimate of the time left when it is waiting on confirmations. */
function describeRedemption(ev, leg) {
  let html;
  let cls = "wait";
  let progress = "";
  switch (ev.status) {
    case "awaiting_finality": {
      const fp = ev.finalityProgress;
      // Operator-provided numbers: coerced before they reach the page.
      const need = Math.floor(Number(fp?.need));
      const rawDepth = fp?.depth === null || fp?.depth === undefined ? NaN : Math.floor(Number(fp.depth));
      if (fp && need > 0 && Number.isFinite(need) && Number.isFinite(rawDepth) && fp.kind) {
        const perBlock = fp.kind === "bitcoin" ? 10 : 1;
        const depth = Math.max(0, Math.min(rawDepth, need));
        const left = need - depth;
        const unit = fp.kind === "bitcoin" ? "Bitcoin-anchor confirmations" : "Sequentia confirmations";
        html = `Waiting for finality: ${depth} of ${need} ${unit}.`;
        progress = progressHtml(depth / need, left ? `${fmtMinutes(left * perBlock)} left` : "Final. Releasing shortly.");
      } else if (fp && fp.kind === "bitcoin") {
        html = "Waiting for the Sequentia node to catch up with Bitcoin before counting confirmations.";
      } else if (fp) {
        html = "Waiting for the return transaction to confirm on Sequentia.";
      } else {
        html = "Waiting for Bitcoin-anchor finality" + (ev.finality ? ` (${escapeHtml(ev.finality)})` : "") + ".";
      }
      break;
    }
    case "awaiting_liquidity":
      html = `Waiting for the operator to move reserves to ${escapeHtml(leg.chain)}. It is released once they arrive.`;
      break;
    case "halted":
      html = "Payouts of this asset are paused while the operator investigates. It is released once they resume.";
      break;
    case "release_paused":
      html = "Releases from the vault are paused. This payout goes out once they resume.";
      break;
    case "new":
    case "releasing":
      html = `Releasing on ${escapeHtml(leg.chain)}.`;
      break;
    case "unresolved":
      html = "Confirming the payout transaction. Nothing is lost; it is checked again every minute.";
      break;
    case "queued":
      html = queuedText(ev.executeAfter);
      break;
    case "release_cancelled":
      html = GUARDIAN_TEXT;
      cls = "bad";
      break;
    case "released":
    case "destroy_pending":
    case "destroying":
    case "destroy_manual":
    case "done":
      if (ev.cctpOut) {
        const o = cctpOutHtml(ev);
        html = o.html.trim();
        cls = o.cls;
      } else if (ev.deferred?.to) {
        html = `Released on ${escapeHtml(leg.chain)}.${deferredHtml(ev, "payment")}`;
      } else {
        html = `Released on ${escapeHtml(leg.chain)}.`;
        cls = "ok";
      }
      break;
    case "dust_ignored":
      html = `Too small to release on ${escapeHtml(leg.chain)}. It is set aside for the operator.`;
      cls = "bad";
      break;
    case "ignored_unknown_asset":
      html = "This is not an asset the bridge issued, so there is nothing to release. It is set aside for the operator.";
      cls = "bad";
      break;
    case "ignored_wrong_network":
      html = `This asset was not bridged from ${escapeHtml(leg.chain)}, so it cannot be released there. It is set aside for the operator.`;
      cls = "bad";
      break;
    case "release_failed_manual":
      html = "The receiving address does not accept this payout; the operator has been alerted.";
      cls = "bad";
      break;
    default:
      html = `Status: ${escapeHtml(ev.status)}.`;
  }
  if (ev.retired) html += ` The operator has closed this record: ${escapeHtml(ev.retired.note || "no note")}.`;
  return { html, cls, progress };
}

const ETH_REDEEM_LEG = () => ({
  chain: ethName(),
  payout: (ev) => (ev.releaseTxHash ? ` ${ethTxLink(ev.releaseTxHash, "release transaction")}` : ""),
});
const SOL_REDEEM_LEG = () => ({
  chain: solName(),
  payout: (ev) => (ev.releaseSig ? ` ${solTxLink(ev.releaseSig, "release transaction")}` : ""),
});

function renderRedemptions(boxId, r, leg, seqAddress) {
  const box = $(boxId);
  const list = [...(r.redemptions ?? [])].reverse(); // newest first
  if (!list.length) {
    box.innerHTML = `<span class="note">Nothing received yet. Waiting for a transfer to ${escapeHtml(short(seqAddress))}.</span>`;
    return false;
  }
  box.innerHTML = "";
  for (const ev of list) {
    const a = assetById(ev.assetId);
    const ticker = ev.ticker ?? (a ? tickerOf(a) : ev.symbol ?? "");
    const d = describeRedemption(ev, leg);
    const el = document.createElement("div");
    el.className = "event";
    el.innerHTML =
      `<div><div>${escapeHtml(formatAtoms(ev.sats, a ? precisionOf(a) : 8))} ${escapeHtml(ticker)}</div>` +
      `<div class="mono">${seqTxLink(ev.txid, `${short(ev.txid)}:${Number(ev.vout)}`)}</div></div>` +
      `<div class="state ${d.cls}">${d.html}${leg.payout(ev)}</div>${d.progress}`;
    box.appendChild(el);
  }
  return list.every(redemptionFinal);
}

// Ethereum redemptions. `origin` records why an address is on screen, so a
// wallet connecting later does not replace one the user asked for.
let ethRedeem = null;
function showEthRedemption(seqAddress, ethAddress, origin = "user", domain = 0) {
  domain = Number(domain) || 0;
  ethRedeem = { seqAddress, ethAddress, origin, domain };
  store.set("eth.redeem", { seqAddress, ethAddress, domain });
  setRedeemDomain(domain);
  $("red-result").classList.remove("hide");
  showPayTarget("red", seqAddress, null, "redemption address");
  const where = cctpChainName(domain);
  $("red-note").textContent = !ethAddress
    ? ""
    : Number(domain)
      ? `USDC.e sent here is paid to ${ethAddress} on ${where}; any other asset is paid on ${ethName()}. ` +
        "This is the redemption address for that address and chain; asking again returns the same one."
      : `Releases go to ${ethAddress} on ${ethName()}. This is the redemption address for that Ethereum address; asking again returns the same one.`;
  $("red-events").innerHTML = `<span class="note">Loading…</span>`;
  poll("ethRedeem", () => refreshEthRedemptions(seqAddress), 8000);
}
async function refreshEthRedemptions(seqAddress) {
  const r = await api(`redeem/${encodeURIComponent(seqAddress)}`);
  if (ethRedeem?.seqAddress !== seqAddress) return;
  return renderRedemptions("red-events", r, ETH_REDEEM_LEG(), seqAddress) ? "idle" : undefined;
}

/** The payout chain picked under "Receive on": 0 is the vault's own chain. */
const redeemDomain = () => (status?.cctp ? Number($("red-domain").value || 0) : 0);

/** Show `domain` under "Receive on", so the select always names the chain
 *  the redemption address on screen pays out on. */
function setRedeemDomain(domain) {
  const sel = $("red-domain");
  if (!status?.cctp || !sel) return;
  const v = String(Number(domain) || 0);
  if (![...sel.options].some((o) => o.value === v)) {
    const o = document.createElement("option");
    o.value = v;
    o.textContent = `${cctpChainName(v)} (USDC.e only)`;
    sel.appendChild(o);
  }
  sel.value = v;
  renderRedDomainNote();
}
function renderRedDomainNote() {
  $("red-domain-note").textContent =
    redeemDomain() === 0
      ? `Every asset is paid on ${ethName()}. The other chains take ${usdcTicker()} only.`
      : `${usdcTicker()} only; any other asset is paid on ${ethName()}, to the same address.`;
}

async function createIntent() {
  const ethAddr = $("ethaddr-input").value.trim();
  const domain = redeemDomain();
  if (!/^0x[0-9a-fA-F]{40}$/.test(ethAddr)) {
    say("red-status", "Enter an Ethereum address: 0x followed by 40 hex characters.", "err");
    return;
  }
  const btn = $("btn-intent");
  btn.disabled = true;
  say("red-status", "Requesting your redemption address…");
  try {
    const body = status?.cctp ? { ethAddress: ethAddr, destinationDomain: domain } : { ethAddress: ethAddr };
    const r = await postJson("redeem", body);
    say("red-status", "");
    showEthRedemption(r.seqAddress, r.ethAddress ?? ethAddr, "user", r.destinationDomain ?? 0);
  } catch (e) {
    say("red-status", e.message, "err");
  } finally {
    btn.disabled = false;
  }
}

/** The redemption address of `ethAddress` for the chain under "Receive on".
 *  `quiet` is a wallet connecting rather than the user asking: it never
 *  replaces a redemption the user asked for, nor a restored one that pays
 *  out on another chain. */
async function lookupRedemptionByEth(ethAddress, { quiet = false } = {}) {
  const domain = redeemDomain();
  try {
    const r = await api(`redeem/by-eth/${encodeURIComponent(ethAddress)}?domain=${domain}`);
    const d = Number(r.destinationDomain ?? 0);
    if (quiet && ethRedeem && (ethRedeem.origin === "user" || (ethRedeem.origin === "restored" && ethRedeem.domain !== d))) {
      return false;
    }
    showEthRedemption(r.seqAddress, r.ethAddress ?? ethAddress, quiet ? "wallet" : "user", d);
    return true;
  } catch (e) {
    if (!quiet) {
      say(
        "red-status",
        e.status === 404
          ? `This Ethereum address has no redemption address for ${cctpChainName(domain)} yet. Use the button above to get one.`
          : e.message,
        "err"
      );
    }
    return false;
  }
}

async function resumeRedemption() {
  const addr = $("resume-red-input").value.trim();
  if (!addr) {
    say("red-status", "Enter a redemption address, or the Ethereum address it pays.", "err");
    return;
  }
  say("red-status", "");
  if (/^0x[0-9a-fA-F]{40}$/.test(addr)) {
    await lookupRedemptionByEth(addr);
    return;
  }
  try {
    const r = await api(`redeem/${encodeURIComponent(addr)}`);
    showEthRedemption(r.seqAddress ?? addr, r.ethAddress ?? null, "user", r.destinationDomain ?? 0);
  } catch (e) {
    say("red-status", e.status === 404 ? "No redemption address found. Check it and try again." : e.message, "err");
  }
}

// Filterable list of a leg's bridged assets with their circulating supply.
function renderAssetList(boxId, searchId, list, emptyText) {
  const box = $(boxId);
  const q = ($(searchId)?.value ?? "").trim().toLowerCase();
  if (!list.length) {
    box.innerHTML = `<span class="note">${escapeHtml(emptyText)}</span>`;
    return;
  }
  box.innerHTML = "";
  for (const a of list) {
    const hay = `${a.symbol} ${a.name} ${a.ticker ?? ""} ${a.assetId}`.toLowerCase();
    if (q && !hay.includes(q)) continue;
    const retired = retiredNote(a);
    const el = document.createElement("div");
    el.className = "event" + (retired ? " retired" : "");
    el.innerHTML =
      `<div><div>${escapeHtml(tickerOf(a))} <span class="note">${escapeHtml(a.name)}</span></div>` +
      `<div class="mono">asset ${escapeHtml(a.assetId)}</div></div>` +
      (retired
        ? `<div class="state muted">retired: ${escapeHtml(retired)}</div>`
        : `<div class="state muted">${escapeHtml(formatAtoms(a.mintedSats, precisionOf(a)))} in circulation</div>`);
    box.appendChild(el);
  }
  if (!box.children.length) box.innerHTML = `<span class="note">no match</span>`;
}

function renderRedeemAssets() {
  renderAssetList(
    "red-assets",
    "red-assets-search",
    legAssets(ETH_CHAIN()),
    "No assets have been bridged from Ethereum yet."
  );
  renderAssetList(
    "sol-red-assets",
    "sol-red-assets-search",
    legAssets(SOL_CHAIN()),
    "No assets have been bridged from Solana yet."
  );
}

// ---------- Bitcoin bridge (BTC <-> SBTC) ----------
// Address-based, no wallet connection: request a bridge-allocated address,
// then send BTC or SBTC to it from any wallet. The daemon proxies to the
// sbtc-bridge service, which holds custody and mints and burns SBTC 1:1.
const BTC_ADDR = /^(tb1[02-9ac-hj-np-z]{8,87}|[mn2][1-9A-HJ-NP-Za-km-z]{25,34})$/i;

let btcWrap = null; // { depositAddress, seqAddress, note, blinded }
let btcUnwrap = null; // { sbtcAddress, btcAddress, note }
let btcTabs = null; // selects the wrap (0) or unwrap (1) tab

/** Show a Bitcoin deposit address, only after checking that the peg service
 *  answered with one: anything else is never shown or put in a QR code.
 *  Answers whether it was shown. */
function showBtcWrap(s, statusId = "wrap-status") {
  if (!BTC_ADDR.test(String(s?.depositAddress ?? ""))) {
    if (store.get("btc.wrap")?.depositAddress === s?.depositAddress) store.set("btc.wrap", null);
    say(
      statusId,
      "The bridge answered with something that is not a testnet4 Bitcoin address, so it is not shown. Send nothing, and try again later.",
      "err"
    );
    return false;
  }
  btcWrap = s;
  $("wrap-result").classList.remove("hide");
  showPayTarget("wrap", s.depositAddress, `bitcoin:${s.depositAddress}`, "Bitcoin deposit address");
  $("wrap-note").textContent =
    (s.note ?? `Send testnet4 BTC to this address from any Bitcoin wallet; SBTC arrives at ${s.seqAddress}, 1:1.`) +
    (s.blinded
      ? ` ${blindedNote("Your Sequentia address is confidential (blinded)", { ticker: "SBTC", supervised: false }, s.unconfidential)}`
      : "");
  $("wrap-events").innerHTML = `<span class="note">Loading…</span>`;
  poll("btcWrap", () => refreshBtcWrap(s.depositAddress), 20_000);
  return true;
}
function showBtcUnwrap(s) {
  btcUnwrap = s;
  $("unwrap-result").classList.remove("hide");
  showPayTarget("unwrap", s.sbtcAddress, null, "SBTC return address");
  $("unwrap-note").textContent =
    s.note ?? `Send SBTC to this Sequentia address from any wallet; the same amount of BTC is released to ${s.btcAddress}.`;
  $("unwrap-events").innerHTML = `<span class="note">Loading…</span>`;
  poll("btcUnwrap", () => refreshBtcUnwrap(s.sbtcAddress), 20_000);
}

// "0.05000000" -> "0.05"
const trimAmount = (a) => String(a ?? "?").replace(/(\.\d*?)0+$/, "$1").replace(/\.$/, "");

/** One Bitcoin-leg transfer in plain words. `kind` is "wrap" (BTC in, SBTC
 *  out; confirmations are Bitcoin blocks, about 10 minutes each) or "unwrap"
 *  (SBTC in, BTC out; confirmations are Sequentia blocks, about 1 minute). */
function describeBtcTransfer(t, minConf, kind, anchor = null) {
  const wrap = kind === "wrap";
  const need = Number(minConf ?? 0);
  const conf = Math.max(0, Number(t.confirmations ?? 0));
  let html;
  let cls = "wait";
  let progress = "";
  switch (t.state) {
    case "waiting":
      if (need > 0) {
        const unit = wrap ? "Bitcoin" : "Sequentia";
        const left = Math.max(0, need - conf);
        html = `Waiting for ${Math.min(conf, need)}/${need} ${unit} confirmations.`;
        // Confirmed, but a deposit is credited only once Sequentia's
        // Bitcoin anchor reaches its block: then a Bitcoin reorg that undid
        // the deposit would undo the credit too.
        const anchorBehind =
          wrap && !left && anchor?.anchorHeight != null && anchor?.btcTip != null &&
          anchor.anchorHeight < anchor.btcTip - conf + 1;
        if (anchorBehind) html = "Confirmed. Waiting for Sequentia to anchor the Bitcoin block that holds it.";
        progress = progressHtml(
          Math.min(conf, need) / need,
          left ? `${fmtMinutes(left * (wrap ? 10 : 1))} left` : anchorBehind ? "usually within a few minutes" : "Confirmed. Processing shortly."
        );
      } else {
        html = "Seen. The bridge processes it shortly.";
      }
      break;
    case "in_progress":
      html = wrap ? "Crediting SBTC…" : "Releasing BTC…";
      break;
    case "done": {
      const out = wrap ? t.credit_txid : t.release_txid;
      html = `${wrap ? "SBTC" : "BTC"} sent.` + (out ? ` Transaction ${wrap ? seqTxLink(out) : btcTxLink(out)}.` : "");
      cls = "ok";
      break;
    }
    default:
      html = `Status: ${escapeHtml(t.state)}.`;
  }
  return { html, cls, progress };
}

/** Render a Bitcoin-leg address's transfers. Answers whether every one of
 *  them is done. */
function renderBtcTransfers(boxId, list, minConf, kind, address, anchor = null) {
  const box = $(boxId);
  const items = [...(list ?? [])].reverse(); // newest first
  if (!items.length) {
    const need = Number(minConf ?? 0);
    const when =
      kind === "wrap"
        ? need > 0
          ? `SBTC is credited after ${need} Bitcoin confirmation${need === 1 ? "" : "s"} (${fmtMinutes(need * 10)}), once Sequentia has anchored that Bitcoin block.`
          : "SBTC is credited once the bridge sees the payment."
        : "BTC is released once the transfer is processed.";
    box.innerHTML = `<span class="note">Nothing received yet at ${escapeHtml(short(address))}. ${escapeHtml(when)}</span>`;
    return false;
  }
  box.innerHTML = "";
  for (const t of items) {
    const d = describeBtcTransfer(t, minConf, kind, anchor);
    const amount = kind === "wrap" ? `${trimAmount(t.amount_btc)} BTC` : `${trimAmount(t.amount_sbtc)} SBTC`;
    const inLink = kind === "wrap" ? btcTxLink : seqTxLink;
    const el = document.createElement("div");
    el.className = "event";
    el.innerHTML =
      `<div><div>${escapeHtml(amount)}</div>` +
      `<div class="mono">${inLink(t.txid, `${short(t.txid)}:${Number(t.vout)}`)}</div></div>` +
      `<div class="state ${d.cls}">${d.html}</div>${d.progress}`;
    box.appendChild(el);
  }
  return items.every((t) => t.state === "done");
}

async function refreshBtcWrap(address) {
  let r;
  try {
    r = await api(`btc/wrap/${encodeURIComponent(address)}`);
  } catch (e) {
    if (btcWrap?.depositAddress !== address) return;
    if (e.status === 404) {
      $("wrap-events").innerHTML = `<span class="note">The bridge does not know this deposit address.</span>`;
      return "stop";
    }
    throw e; // anything else: keep the last list and try again next time
  }
  if (btcWrap?.depositAddress !== address) return;
  const final = renderBtcTransfers("wrap-events", r.deposits, r.min_conf, "wrap", address, {
    anchorHeight: r.anchor_height ?? null,
    btcTip: r.btc_tip ?? null,
  });
  return final ? "idle" : undefined;
}

async function refreshBtcUnwrap(address) {
  let r;
  try {
    r = await api(`btc/unwrap/${encodeURIComponent(address)}`);
  } catch (e) {
    if (btcUnwrap?.sbtcAddress !== address) return;
    if (e.status === 404) {
      $("unwrap-events").innerHTML = `<span class="note">The bridge does not know this return address.</span>`;
      return "stop";
    }
    throw e;
  }
  if (btcUnwrap?.sbtcAddress !== address) return;
  return renderBtcTransfers("unwrap-events", r.returns, r.min_conf, "unwrap", address) ? "idle" : undefined;
}

/** Look up a Bitcoin-leg address in either direction: a Bitcoin deposit
 *  address first, then an SBTC return address. */
async function trackBtc() {
  const addr = $("btc-track-input").value.trim();
  if (!addr) {
    say("btc-track-status", "Enter a Bitcoin deposit address or an SBTC return address.", "err");
    return;
  }
  const btn = $("btn-btc-track");
  btn.disabled = true;
  say("btc-track-status", "Looking it up…");
  try {
    try {
      const r = await api(`btc/wrap/${encodeURIComponent(addr)}`);
      const s = { depositAddress: r.deposit_address ?? addr, seqAddress: r.seq_recipient ?? null, note: null, blinded: false };
      say("btc-track-status", "");
      if (!showBtcWrap(s, "btc-track-status")) return;
      store.set("btc.wrap", s);
      if (s.seqAddress) {
        $("wrap-seqaddr").value = s.seqAddress;
        seqFields.wrap.schedule();
      }
      btcTabs?.(0);
      return;
    } catch (e) {
      if (e.status !== 404 && e.status !== 400) throw e;
    }
    try {
      const r = await api(`btc/unwrap/${encodeURIComponent(addr)}`);
      const s = { sbtcAddress: r.sbtc_address ?? addr, btcAddress: r.btc_dest ?? null, note: null };
      store.set("btc.unwrap", s);
      if (s.btcAddress) $("unwrap-btcaddr").value = s.btcAddress;
      btcTabs?.(1);
      showBtcUnwrap(s);
      say("btc-track-status", "");
      return;
    } catch (e) {
      if (e.status !== 404 && e.status !== 400) throw e;
    }
    say("btc-track-status", "The bridge knows no Bitcoin deposit address or SBTC return address like this one.", "err");
  } catch (e) {
    say("btc-track-status", e.message, "err");
  } finally {
    btn.disabled = false;
  }
}

async function wrapBtc() {
  const f = seqFields.wrap;
  if (!f.value) {
    say("wrap-status", "Enter your Sequentia address first; it receives the SBTC.", "err");
    return;
  }
  const btn = $("btn-wrap");
  btn.disabled = true;
  try {
    say("wrap-status", "Checking the address…");
    await f.ensure();
    if (!f.ok()) {
      say("wrap-status", "Enter a valid Sequentia address. Nothing has been requested.", "err");
      return;
    }
    say("wrap-status", "Requesting a deposit address…");
    const r = await postJson("btc/wrap", { seqAddress: f.value });
    const s = { depositAddress: r.depositAddress, seqAddress: f.value, note: r.note, blinded: f.blinded, unconfidential: f.unconfidential };
    say("wrap-status", "");
    if (showBtcWrap(s)) store.set("btc.wrap", s);
  } catch (e) {
    say("wrap-status", e.message, "err");
  } finally {
    btn.disabled = false;
  }
}

async function unwrapBtc() {
  const btcAddress = $("unwrap-btcaddr").value.trim();
  if (!BTC_ADDR.test(btcAddress)) {
    say("unwrap-status", "Enter a testnet4 Bitcoin address (tb1…); it receives the BTC.", "err");
    return;
  }
  const btn = $("btn-unwrap");
  btn.disabled = true;
  say("unwrap-status", "Requesting a return address…");
  try {
    const r = await postJson("btc/unwrap", { btcAddress });
    const s = { sbtcAddress: r.sbtcAddress, btcAddress, note: r.note };
    store.set("btc.unwrap", s);
    say("unwrap-status", "");
    showBtcUnwrap(s);
  } catch (e) {
    say("unwrap-status", e.message, "err");
  } finally {
    btn.disabled = false;
  }
}

// ---------- Solana bridge (SOL or SPL <-> .s assets) ----------
// Address-based like the Bitcoin leg, but the daemon itself holds custody,
// so both directions report live per-transfer status here.
const SOL_ADDR = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
let solWrap = null; // { depositAddress, seqAddress, note, blinded }
let solUnwrap = null; // { seqAddress, solAddress, note }

/** Trim-zeros display of base units at a given number of decimal places. */
function formatUnits(units, decimals) {
  return formatAtoms(units ?? 0, Number(decimals ?? 9));
}

// Solana Pay link: the deposit address, plus the SPL mint when a token is chosen.
function solPayUri(address) {
  const mint = $("sol-pay-token").value;
  return mint ? `solana:${address}?spl-token=${encodeURIComponent(mint)}` : `solana:${address}`;
}
function fillSolPayTokens() {
  const sel = $("sol-pay-token");
  const keep = sel.value;
  sel.innerHTML = `<option value="">SOL</option>`;
  for (const a of legAssets(SOL_CHAIN())) {
    const s = sourceOn(a, SOL_CHAIN());
    if (!s || s.token === "sol" || a.retired) continue;
    const o = document.createElement("option");
    o.value = s.token;
    o.textContent = `${a.symbol} (${short(s.token)})`;
    sel.appendChild(o);
  }
  sel.value = [...sel.options].some((o) => o.value === keep) ? keep : "";
}
function renderSolWrapTarget() {
  if (!solWrap) return;
  showPayTarget("sol-wrap", solWrap.depositAddress, solPayUri(solWrap.depositAddress), "Solana deposit address");
}

function showSolWrap(s) {
  solWrap = s;
  $("sol-wrap-result").classList.remove("hide");
  renderSolWrapTarget();
  $("sol-wrap-note").textContent =
    (s.note ?? `Send SOL or any SPL token to this address; the matching asset is minted to ${s.seqAddress}.`) +
    (s.blinded ? ` ${blindedNote("Your Sequentia address is confidential (blinded)", null, s.unconfidential)}` : "");
  $("sol-wrap-events").innerHTML = `<span class="note">Loading…</span>`;
  poll("solWrap", () => refreshSolDeposits(s.depositAddress), 8000);
}

async function wrapSol() {
  const f = seqFields.solWrap;
  if (!f.value) {
    say("sol-wrap-status", "Enter your Sequentia address first; it receives the bridged asset.", "err");
    return;
  }
  const btn = $("btn-sol-wrap");
  btn.disabled = true;
  try {
    say("sol-wrap-status", "Checking the address…");
    await f.ensure();
    if (!f.ok()) {
      say("sol-wrap-status", "Enter a valid Sequentia address. Nothing has been requested.", "err");
      return;
    }
    say("sol-wrap-status", "Requesting a deposit address…");
    const r = await postJson("sol/wrap", { seqAddress: f.value });
    const s = { depositAddress: r.depositAddress, seqAddress: f.value, note: r.note, blinded: f.blinded, unconfidential: f.unconfidential };
    store.set("sol.wrap", s);
    say("sol-wrap-status", "");
    showSolWrap(s);
  } catch (e) {
    say("sol-wrap-status", e.message, "err");
  } finally {
    btn.disabled = false;
  }
}

const SOL_DEPOSIT_LEG = () => ({ chain: solName(), custody: "with the bridge" });

async function refreshSolDeposits(depositAddress) {
  const r = await api(`sol/wrap/${encodeURIComponent(depositAddress)}`);
  if (solWrap?.depositAddress !== depositAddress) return;
  const box = $("sol-wrap-events");
  const list = [...(r.deposits ?? [])].reverse();
  if (!list.length) {
    box.innerHTML = `<span class="note">Nothing received yet. Waiting for a transfer to ${escapeHtml(short(depositAddress))}. A deposit mints once Solana finalizes it, usually within a minute.</span>`;
    return;
  }
  let final = true;
  // A first bridge creates a new asset; refresh so its ticker resolves.
  if (list.some((d) => d.assetId && !assetById(d.assetId))) await refreshAssets();
  box.innerHTML = "";
  for (const d of list) {
    const a = assetById(d.assetId) ?? (d.mint && d.mint !== "sol" ? assetForToken(SOL_CHAIN(), d.mint) : assetForToken(SOL_CHAIN(), "sol"));
    const ticker = a ? tickerOf(a) : "";
    const amount = d.sats ? `${formatAtoms(d.sats, a ? precisionOf(a) : 8)} ${ticker}`.trim() : "the deposit";
    const desc = describeDeposit(d, SOL_DEPOSIT_LEG(), amount);
    if (!desc.terminal) final = false;
    const sent = !d.mint || d.mint === "sol" ? "SOL" : a?.symbol ?? short(d.mint);
    const el = document.createElement("div");
    el.className = "event";
    el.innerHTML =
      `<div><div>${escapeHtml(formatUnits(d.amountUnits ?? d.lamports, d.decimals ?? 9))} ${escapeHtml(sent)}</div>` +
      `<div class="mono">${escapeHtml(short(d.sig))}</div></div>` +
      `<div class="state ${desc.cls}">${desc.html} ${solTxLink(d.sig, "deposit transaction")}</div>`;
    box.appendChild(el);
  }
  return final ? "idle" : undefined;
}

function showSolUnwrap(s) {
  solUnwrap = s;
  $("sol-unwrap-result").classList.remove("hide");
  showPayTarget("sol-unwrap", s.seqAddress, null, "Solana return address");
  $("sol-unwrap-note").textContent =
    s.note ?? `Send Solana-bridged assets to this address; the originals are released to ${s.solAddress}.`;
  $("sol-unwrap-events").innerHTML = `<span class="note">Loading…</span>`;
  poll("solUnwrap", () => refreshSolRedemptions(s.seqAddress), 8000);
}

async function unwrapSol() {
  const solAddress = $("sol-unwrap-addr-input").value.trim();
  if (!SOL_ADDR.test(solAddress)) {
    say("sol-unwrap-status", "Enter a Solana address (base58, 32 to 44 characters).", "err");
    return;
  }
  const btn = $("btn-sol-unwrap");
  btn.disabled = true;
  say("sol-unwrap-status", "Requesting a return address…");
  try {
    const r = await postJson("sol/unwrap", { solAddress });
    const s = { seqAddress: r.seqAddress, solAddress, note: r.note };
    store.set("sol.unwrap", s);
    say("sol-unwrap-status", "");
    showSolUnwrap(s);
  } catch (e) {
    say("sol-unwrap-status", e.message, "err");
  } finally {
    btn.disabled = false;
  }
}

async function refreshSolRedemptions(seqAddress) {
  const r = await api(`sol/redeem/${encodeURIComponent(seqAddress)}`);
  if (solUnwrap?.seqAddress !== seqAddress) return;
  return renderRedemptions("sol-unwrap-events", r, SOL_REDEEM_LEG(), seqAddress) ? "idle" : undefined;
}

// ---------- payouts the vault holds back: queued, stopped, deferred ----------
const GUARDIAN_TEXT = "Stopped by the bridge's guardian; the operator decides what happens next.";

/** A payout over the vault's rate limit waits in a queue until `executeAfter`. */
function queuedText(executeAfter) {
  const t = Date.parse(executeAfter ?? "");
  if (!Number.isFinite(t)) return "Over the vault's rate limit: paid automatically once the limit allows.";
  const when = new Date(t).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
  const mins = (t - Date.now()) / 60_000;
  const rel = mins > 0.5 ? `in ${fmtMinutes(mins).replace(/^about /, "")}` : "any moment now";
  return `Over the vault's rate limit: paid automatically after ${escapeHtml(when)} (${escapeHtml(rel)}).`;
}

// Claims the page can start, keyed by the data-claim attribute of their
// button. Lists re-render on every poll, so the buttons only carry a key.
const claimables = new Map();
const recordId = (rec) => rec.key ?? (rec.txid ? `${rec.txid}:${rec.vout}` : rec.ethTxHash ?? rec.nonce ?? "record");

/** The token claim() takes for a record: the zero address for ether, else
 *  the Ethereum token address from its tokenKey ("11155111:0x…"). */
function claimTokenOf(rec) {
  const tk = String(rec.tokenKey ?? "");
  if (tk.endsWith(":eth")) return ZERO_ADDRESS;
  const t = tk.split(":")[1] ?? "";
  return /^0x[0-9a-fA-F]{40}$/.test(t) ? t : null;
}

/** A payout the recipient refused (a contract that rejects plain ether, for
 *  example): the vault holds it for that address, which can claim it. */
function deferredHtml(rec, what) {
  const d = rec.deferred;
  if (!d?.to) return "";
  const tokenAddr = claimTokenOf(rec);
  const isEther = tokenAddr === ZERO_ADDRESS;
  const a = tokenAddr && !isEther ? assetForToken(ETH_CHAIN(), tokenAddr) : null;
  const decimals = isEther ? 18 : a ? sourceOn(a, ETH_CHAIN())?.decimals : null;
  const symbol = isEther ? "ETH" : a?.symbol ?? rec.symbol ?? "tokens";
  const amountText = decimals != null ? `${formatAtoms(d.amount, decimals)} ${symbol}` : `${d.amount} base units of ${symbol}`;
  const key = `deferred:${recordId(rec)}`;
  claimables.set(key, { kind: "deferred", to: d.to, amountText, token: tokenAddr, vault: rec.vault || status.vaultAddress });
  return (
    ` The receiving address refused the ${what}, so the vault holds ${escapeHtml(amountText)} for ${escapeHtml(short(d.to))}.` +
    (tokenAddr ? ` <button type="button" class="copybtn claimbtn" data-claim="${escapeHtml(key)}">Claim</button>` : "")
  );
}

// ---------- CCTP: USDC to and from other chains ----------
const cctpChains = () => status?.cctp?.chains ?? [];
const cctpChain = (domain) => cctpChains().find((c) => Number(c.domain) === Number(domain)) ?? null;
function cctpChainName(domain) {
  if (Number(domain) === 0) return ethName();
  if (Number(domain) === 5) return cctpChain(5)?.name ?? "Solana";
  return cctpChain(domain)?.name ?? `CCTP domain ${Number(domain)}`;
}
/** Chains a user can burn USDC on from this page: EVM chains other than the vault's own. */
const cctpInboundChains = () =>
  cctpChains().filter(
    (c) => Number(c.chainId) > 0 && ![0, 5].includes(Number(c.domain)) && /^0x[0-9a-fA-F]{40}$/.test(c.usdc ?? "")
  );
function chainTxLink(chain, hash, text) {
  const label = escapeHtml(text ?? short(hash));
  if (!/^https:\/\//.test(chain?.explorer ?? "") || !/^0x[0-9a-fA-F]{64}$/.test(hash ?? "")) return label;
  return `<a href="${escapeHtml(chain.explorer.replace(/\/+$/, ""))}/tx/${hash}" target="_blank" rel="noopener">${label}</a>`;
}
const usdcAsset = () => assets.find((a) => a.unified && a.symbol === "USDC") ?? null;
const usdcTicker = () => tickerOf(usdcAsset()) || "USDC.e";
const usdcPrecision = () => usdcAsset()?.precision ?? 6;

// Claims sent from this page, keyed by the burn they complete. The bridge
// notices a claim only on its next pass, so without this the Claim button
// would come back after a successful claim.
const cctpBurnKey = (rec) => rec.cctpOut?.burnTx ?? recordId(rec);
function claimedCctp(burnKey) {
  const m = store.get("cctp.claimed");
  const c = m && typeof m === "object" && Object.hasOwn(m, burnKey) ? m[burnKey] : null;
  return c?.tx ? c : null;
}
function rememberCctpClaim(burnKey, domain, tx) {
  const m = store.get("cctp.claimed");
  const next = m && typeof m === "object" ? m : {};
  next[burnKey] = { domain: Number(domain), tx, at: Date.now() };
  // Keep the newest fifty.
  const keep = Object.entries(next).sort((a, b) => (b[1]?.at ?? 0) - (a[1]?.at ?? 0)).slice(0, 50);
  store.set("cctp.claimed", Object.fromEntries(keep));
}
const cctpOutDone = (rec) => rec.cctpOut?.stage === "claimed" || Boolean(claimedCctp(cctpBurnKey(rec)));

/** A payout that leaves the vault through CCTP: burned on the vault's chain,
 *  attested by Circle, then minted on the destination chain by whoever sends
 *  the attested message there (the bridge itself for Solana). */
function cctpOutHtml(rec) {
  const o = rec.cctpOut;
  const name = escapeHtml(cctpChainName(o.domain));
  const solana = Number(o.domain) === 5;
  const burn = o.burnTx ? ` ${ethTxLink(o.burnTx, "burn transaction")}` : "";
  switch (o.stage) {
    case "attesting":
      return { html: ` Burned on ${escapeHtml(ethName())} for minting on ${name}; waiting for Circle's attestation.${burn}`, cls: "wait" };
    case "claimable": {
      if (solana || !o.message || !o.attestation) {
        return { html: ` Attested by Circle. The bridge is minting it on ${name}.${burn}`, cls: "wait" };
      }
      const burnKey = cctpBurnKey(rec);
      const mine = claimedCctp(burnKey);
      if (mine) {
        return {
          html: ` Claimed on ${name}: ${chainTxLink(cctpChain(o.domain), mine.tx, "claim transaction")}.`,
          cls: "ok",
        };
      }
      const key = `cctp:${Number(o.domain)}:${burnKey}`;
      claimables.set(key, { kind: "cctp", domain: Number(o.domain), message: o.message, attestation: o.attestation, burnKey });
      return {
        html:
          ` Attested by Circle and ready to mint on ${name}.${burn} ` +
          `<button type="button" class="copybtn claimbtn" data-claim="${escapeHtml(key)}">Claim on ${name}</button>`,
        cls: "wait",
      };
    }
    case "claimed":
      return {
        html: solana
          ? ` Minted on ${name}.`
          : ` Claimed on ${name}.${o.claimTx ? ` ${chainTxLink(cctpChain(o.domain), o.claimTx, "claim transaction")}` : ""}`,
        cls: "ok",
      };
    default:
      return { html: ` CCTP transfer to ${name}: ${escapeHtml(o.stage)}.`, cls: "wait" };
  }
}

/** Ask the wallet to move to `chain`, adding it first when the wallet does
 *  not know it (error 4902). */
async function switchChain(chain) {
  const want = Number(chain.chainId);
  if (walletChainId === want) return;
  const hex = "0x" + want.toString(16);
  try {
    await rpc("wallet_switchEthereumChain", [{ chainId: hex }]);
  } catch (e) {
    const code = e?.code ?? e?.data?.originalError?.code;
    if (code !== 4902 || !chain.rpc) throw e;
    const avax = want === 43113;
    await rpc("wallet_addEthereumChain", [
      {
        chainId: hex,
        chainName: chain.name,
        rpcUrls: [chain.rpc],
        blockExplorerUrls: chain.explorer ? [chain.explorer] : [],
        nativeCurrency: avax ? { name: "Avalanche", symbol: "AVAX", decimals: 18 } : { name: "Ether", symbol: "ETH", decimals: 18 },
      },
    ]);
  }
  walletChainId = parseInt(await rpc("eth_chainId"), 16);
  renderWallet();
  if (walletChainId !== want) throw new Error(`Your wallet is still on another network. Switch it to ${chain.name}.`);
}

// ---------- the claim dialog ----------
let claimCur = null;
let claimBusy = false;
const claimTarget = (c) =>
  c.kind === "deferred"
    ? { chainId: status.ethChainId, name: ethName(), explorer: ETHERSCAN[status.ethChainId] ?? null }
    : cctpChain(c.domain);

function openClaim(key) {
  const c = claimables.get(key);
  if (!c || !status) return;
  claimCur = c;
  const target = claimTarget(c);
  const dlg = $("claim-dialog");
  if (c.kind === "deferred") {
    $("claim-title").textContent = `Claim ${c.amountText}`;
    $("claim-body").textContent =
      `The vault holds ${c.amountText} for ${c.to}, because that address refused the payment when it was sent. ` +
      `Only ${c.to} can claim it: connect that account on ${ethName()}, choose where the funds should go, and claim.`;
    $("claim-payto").value = account ?? c.to;
  } else {
    $("claim-title").textContent = `Claim on ${target?.name ?? "the destination chain"}`;
    $("claim-body").textContent =
      `The USDC was burned on ${ethName()} and Circle has attested it. Minting it on ${target?.name} takes one ` +
      `transaction that anyone may send: it pays only the recipient named in the burn. You pay the gas on ${target?.name}.`;
  }
  $("claim-payto-field").classList.toggle("hide", c.kind !== "deferred");
  say("claim-status", "");
  if (!dlg.open) {
    if (typeof dlg.showModal === "function") dlg.showModal();
    else dlg.setAttribute("open", "");
  }
  renderClaim();
}

function renderClaim() {
  const dlg = $("claim-dialog");
  if (!claimCur || !dlg?.open) return;
  const c = claimCur;
  const target = claimTarget(c);
  const go = $("claim-go");
  let label;
  let action;
  if (!window.ethereum) {
    go.disabled = true;
    say("claim-status", "No Ethereum wallet found in this browser. Install MetaMask to claim.", "err");
    return;
  }
  if (!account) [label, action] = ["Connect wallet", "connect"];
  else if (walletChainId !== Number(target?.chainId)) [label, action] = [`Switch to ${target?.name}`, "switch"];
  else if (c.kind === "deferred" && account.toLowerCase() !== String(c.to).toLowerCase()) {
    [label, action] = ["Choose the account in your wallet", "pick"];
    say("claim-status", `Only ${c.to} can claim this. Your wallet is using ${account}.`);
  } else [label, action] = [c.kind === "deferred" ? "Claim" : `Claim on ${target.name}`, "claim"];
  if (c.done) [label, action] = ["Claimed", "done"];
  go.textContent = label;
  go.dataset.action = action;
  const payTo = $("claim-payto").value.trim();
  const payToProblem = c.kind === "deferred" ? claimPayToProblem(payTo) : null;
  if (action === "claim" && payTo && payToProblem && !claimBusy) say("claim-status", payToProblem, "err");
  go.disabled = claimBusy || action === "done" || (action === "claim" && Boolean(payToProblem));
}

/** Why `payTo` cannot receive a deferred payout, or null when it can. */
function claimPayToProblem(payTo) {
  if (!/^0x[0-9a-fA-F]{40}$/.test(payTo)) return "Enter the address the funds go to: 0x followed by 40 hex characters.";
  if (payTo.toLowerCase() === ZERO_ADDRESS) return "The zero address cannot receive the funds. Enter the address that should.";
  return null;
}

async function claimGo() {
  const c = claimCur;
  if (!c) return;
  const action = $("claim-go").dataset.action;
  const target = claimTarget(c);
  try {
    if (action === "connect") {
      const a = await rpc("eth_requestAccounts");
      account = a[0] ?? null;
      walletChainId = parseInt(await rpc("eth_chainId"), 16);
      listenEth();
      renderWallet();
      if (c.kind === "deferred" && !$("claim-payto").value.trim()) $("claim-payto").value = account ?? "";
      return;
    }
    if (action === "pick") {
      await rpc("wallet_requestPermissions", [{ eth_accounts: {} }]);
      account = (await rpc("eth_accounts"))[0] ?? null;
      renderWallet();
      return;
    }
    if (action === "switch") {
      await switchChain(target);
      return;
    }
    if (action !== "claim") return;
    let to;
    let data;
    if (c.kind === "deferred") {
      const payTo = $("claim-payto").value.trim();
      const problem = claimPayToProblem(payTo);
      if (problem) {
        say("claim-status", problem, "err");
        return;
      }
      to = c.vault;
      data = dataClaim(c.token, payTo);
    } else {
      to = status.cctp.messageTransmitter;
      data = dataReceiveMessage(c.message, c.attestation);
    }
    claimBusy = true;
    renderClaim();
    say("claim-status", "Confirm the claim in your wallet…");
    const hash = await sendTx({ from: account, to, data }, target);
    const link = c.kind === "deferred" ? ethTxLink(hash) : chainTxLink(target, hash);
    const sent = `Sent ${link}; waiting for it to be mined.`;
    sayHtml("claim-status", sent);
    const r = await waitReceipt(hash, target, {
      onNote: (n) => sayHtml("claim-status", n ? `Sent ${link}. ${escapeHtml(n)}` : sent),
    });
    if (r.kind === "receipt" && r.receipt.status === "0x1") {
      c.done = true;
      if (c.kind === "cctp") {
        rememberCctpClaim(c.burnKey, c.domain, hash);
        // Show "Claimed" in every list at once, not on the next poll.
        if (ethRedeem) refreshEthRedemptions(ethRedeem.seqAddress).catch(() => {});
        if (solUnwrap) refreshSolRedemptions(solUnwrap.seqAddress).catch(() => {});
      }
      sayHtml("claim-status", `Claimed. Transaction ${link}.`, "ok");
    } else if (r.kind === "receipt") sayHtml("claim-status", `The claim failed on ${escapeHtml(target.name)}. Transaction ${link}.`, "err");
    else say("claim-status", "The claim was not mined. Check your wallet.", "err");
  } catch (e) {
    say("claim-status", walletError(e), "err");
  } finally {
    claimBusy = false;
    renderClaim();
  }
}

// ---------- USDC from another chain (CCTP inbound) ----------
let cctpBusy = false;
let cctpTrackId = 0;

function setupCctp() {
  const c = status?.cctp;
  if (!c) return;
  const inbound = cctpInboundChains();
  for (const id of ["cctp-chain", "cctp-track-chain"]) {
    const sel = $(id);
    sel.innerHTML = "";
    for (const ch of inbound) {
      const o = document.createElement("option");
      o.value = String(ch.domain);
      o.textContent = ch.name;
      sel.appendChild(o);
    }
  }
  $("cctp-intro").innerHTML =
    `Burn USDC on any chain listed here and receive <strong>${escapeHtml(usdcTicker())}</strong> on Sequentia: ` +
    `the same asset as USDC bridged from ${escapeHtml(ethName())} or Solana. The burn names the bridge's vault ` +
    `as the only party allowed to complete it.`;

  // "Receive on" for redemptions: the vault's own chain, then every CCTP destination.
  const red = $("red-domain");
  red.innerHTML = "";
  const own = document.createElement("option");
  own.value = "0";
  own.textContent = ethName();
  red.appendChild(own);
  for (const ch of cctpChains()) {
    // Solana payouts go through the Solana leg: a Solana address is not an
    // address this form can take.
    if ([0, 5].includes(Number(ch.domain))) continue;
    const o = document.createElement("option");
    o.value = String(ch.domain);
    o.textContent = `${ch.name} (USDC.e only)`;
    red.appendChild(o);
  }
  $("red-domain-field").classList.remove("hide");
  red.addEventListener("change", renderRedDomainNote);
  renderRedDomainNote();

  $("cctp-chain").addEventListener("change", () => {
    if ($("net-choice").value === "cctp") $("net-from").textContent = cctpChain($("cctp-chain").value)?.name ?? "USDC via CCTP";
    renderCctpWallet();
    renderCctpPreview();
  });
  $("cctp-amount").addEventListener("input", () => {
    updateCctpButton();
    renderCctpPreview();
  });
  $("cctp-connect").addEventListener("click", () => {
    if (!window.ethereum) {
      say("cctp-wallet-line", "No Ethereum wallet found in this browser. Install MetaMask to bridge USDC.", "err");
      return;
    }
    connect();
  });
  $("btn-cctp").addEventListener("click", cctpDeposit);
  $("btn-cctp-track").addEventListener("click", trackCctpFromBox);
  $("cctp-track-hash").addEventListener("keydown", (e) => e.key === "Enter" && trackCctpFromBox());
  renderCctpWallet();
}

function renderCctpWallet() {
  if (!status?.cctp) return;
  const chain = cctpChain($("cctp-chain").value);
  const btn = $("cctp-connect");
  if (!account) {
    btn.textContent = "Connect wallet";
    say("cctp-wallet-line", "");
  } else {
    btn.textContent = short(account);
    if (chain && walletChainId === Number(chain.chainId)) say("cctp-wallet-line", `connected on ${chain.name}`, "ok");
    else say("cctp-wallet-line", `connected; the page asks your wallet to switch to ${chain?.name ?? "the source chain"} when you bridge`);
  }
  updateCctpButton();
}

function cctpAmount() {
  const raw = $("cctp-amount").value.trim();
  if (!raw) return null;
  try {
    const units = parseUnits(raw, 6, 6);
    return { units, atoms: unitsToAtoms(units, 6, usdcPrecision()) };
  } catch (e) {
    return { error: e.message };
  }
}

function updateCctpButton() {
  const btn = $("btn-cctp");
  const amt = cctpAmount();
  btn.disabled = cctpBusy || !cctpChain($("cctp-chain").value) || !amt || Boolean(amt.error) || !seqFields.cctp?.ok();
  if (!cctpBusy) btn.textContent = "Burn USDC and bridge it";
}

/** When a relayed CCTP deposit mints: it is an ordinary vault deposit from
 *  then on, so it waits for the vault's chain like any other. */
function relayFinalityText() {
  return ethFinality() === "finalized"
    ? `once ${ethName()} finalizes the relay, about ${ETH_FINALITY_MINUTES} more minutes`
    : `after ${ethConfs()} ${ethName()} confirmation${ethConfs() === 1 ? "" : "s"} of the relay`;
}

function renderCctpPreview() {
  const box = $("cctp-preview");
  const amt = cctpAmount();
  const chain = cctpChain($("cctp-chain").value);
  if (!amt || !chain) {
    box.classList.add("hide");
    box.innerHTML = "";
    return;
  }
  box.classList.remove("hide");
  if (amt.error) {
    box.innerHTML = `<span class="note">${escapeHtml(amt.error)}</span>`;
    return;
  }
  const name = escapeHtml(chain.name);
  const a = usdcAsset();
  const lines = [
    `<div class="note"><strong>You receive ${formatAtoms(amt.atoms, usdcPrecision())} ${escapeHtml(usdcTicker())}</strong> on Sequentia.</div>`,
    `<div class="note">No bridge fee. You pay the gas on ${name}.</div>`,
    `<div class="note">Expected wait: Circle attests a burn once ${name} finalizes it, typically 15–30 minutes on these testnets. ` +
      `The bridge then relays it to the vault, and the deposit mints ${escapeHtml(relayFinalityText())}.</div>`,
    `<div class="note">Your wallet asks you to let Circle's TokenMessenger spend this USDC, then to confirm the burn.</div>`,
  ];
  if (a?.assetId && haltedAssets.has(a.assetId)) {
    lines.push(
      `<div class="note"><strong>Minting of ${escapeHtml(usdcTicker())} is paused while the operator investigates.</strong> A deposit made now waits and mints once it resumes.</div>`
    );
  }
  if (seqFields.cctp?.blinded) {
    lines.push(
      `<div class="note">${escapeHtml(blindedNote("Your address is confidential (blinded)", a, seqFields.cctp.unconfidential))}</div>`
    );
  }
  box.innerHTML = lines.join("");
}

async function cctpDeposit() {
  if (cctpBusy) return;
  const chain = cctpChain($("cctp-chain").value);
  const amt = cctpAmount();
  if (!chain) return;
  if (!amt || amt.error) {
    say("cctp-status", amt?.error ?? "Enter an amount.", "err");
    return;
  }
  const f = seqFields.cctp;
  await f.ensure();
  if (!f.ok()) {
    say("cctp-status", "Enter a valid Sequentia address first. Nothing has been sent.", "err");
    return;
  }
  if (!window.ethereum) {
    say("cctp-status", "No Ethereum wallet found in this browser. Install MetaMask to bridge USDC.", "err");
    return;
  }
  const c = status.cctp;
  const btn = $("btn-cctp");
  cctpBusy = true;
  updateCctpButton();
  say("cctp-status", "");
  try {
    if (!account) {
      account = (await rpc("eth_requestAccounts"))[0] ?? null;
      walletChainId = parseInt(await rpc("eth_chainId"), 16);
      listenEth();
    }
    btn.textContent = `Switch to ${chain.name} in your wallet…`;
    await switchChain(chain);
    await ensureAllowance(chain, chain.usdc, c.tokenMessenger, amt.units, "USDC", "cctp-status", btn, "press the button again");
    btn.textContent = "Confirm the burn in your wallet…";
    const data = dataDepositForBurnWithHook({
      amount: amt.units,
      destinationDomain: 0,
      mintRecipient: c.depositVault,
      burnToken: chain.usdc,
      destinationCaller: c.depositVault,
      maxFee: 0,
      minFinalityThreshold: 2000,
      hookText: (c.depositHookPrefix ?? "compages:deposit:") + f.value,
    });
    const hash = await sendTx({ from: account, to: c.tokenMessenger, data }, chain);
    cctpBusy = false;
    updateCctpButton();
    // trackCctp remembers and reports the burn before it waits for anything.
    trackCctp(chain.domain, hash, { sent: true });
  } catch (e) {
    say("cctp-status", walletError(e), "err");
  } finally {
    cctpBusy = false;
    updateCctpButton();
  }
}

function cSeg(i, state) {
  $(`cseg-${i}`).className = "span-seg" + (state ? " " + state : "");
  $(`clab-${i}`).className = state === "done" ? "done" : "";
}

function trackCctpFromBox() {
  const domain = Number($("cctp-track-chain").value);
  const hash = $("cctp-track-hash").value.trim().toLowerCase();
  if (!cctpChain(domain)) return;
  if (!/^0x[0-9a-f]{64}$/.test(hash)) {
    say("cctp-status", "Enter the burn's transaction hash: 0x followed by 64 hex characters.", "err");
    return;
  }
  trackCctp(domain, hash);
}

/** Follow a CCTP burn from the source chain to a deposit on Sequentia.
 *  Starting another track cancels this one.
 *
 *  The burn is remembered and reported to the bridge before anything else:
 *  the bridge waits for Circle's attestation itself, so a burn reported while
 *  it is still being mined is safe, and from then on it completes even if
 *  this page is closed or the wallet moves to another chain. The wallet
 *  follows the transaction alongside, only to catch a failed or replaced
 *  burn at once. */
async function trackCctp(domain, rawHash, { sent = false } = {}) {
  const txHash = rawHash.toLowerCase();
  const id = ++cctpTrackId;
  const alive = () => id === cctpTrackId;
  const chain = cctpChain(domain);
  store.set("cctp.burn", { domain: Number(domain), txHash });
  const forget = () => store.get("cctp.burn")?.txHash === txHash && store.set("cctp.burn", null);

  let registered = false;
  let fatal = null;
  const register = async () => {
    try {
      await postJson("cctp/deposit", { sourceDomain: Number(domain), txHash });
      registered = true;
      return null;
    } catch (e) {
      if (e.status && e.status < 500 && e.status !== 429) fatal = e.message;
      return e;
    }
  };
  let reportError = register();

  $("cctp-track-chain").value = String(domain);
  $("cctp-track-hash").value = txHash;
  $("cctp-truss").classList.add("on");
  for (let i = 0; i < 4; i++) cSeg(i, "");
  cSeg(0, "active");
  const head = `burn on ${escapeHtml(chain?.name ?? `domain ${domain}`)} ${chainTxLink(chain, txHash, short(txHash))}`;
  let body = { html: sent ? "Reporting the burn to the bridge." : "Looking up this burn.", tone: undefined };
  let walletNote = "";
  const redraw = () =>
    alive() &&
    sayHtml(
      "cctp-status",
      `${head}<br><span class="plain">${body.html}${walletNote ? `<br>${escapeHtml(walletNote)}` : ""}</span>`,
      body.tone
    );
  const line = (html, tone) => {
    body = { html, tone };
    redraw();
  };
  redraw();

  // A burn this page sent is followed in the wallet too. Only a definitive
  // answer from its own chain ends the tracking early; a wallet on another
  // chain, or one that cannot find the transaction, leaves it to the bridge.
  const ctx = { mined: !sent };
  let verdict = null;
  let wake = () => {};
  if (sent && chain) {
    waitReceipt(txHash, chain, {
      alive,
      onNote: (n) => {
        walletNote = n;
        redraw();
      },
    })
      .then((r) => {
        if (!alive()) return;
        walletNote = "";
        // Mined, or beyond what the wallet can tell (it never saw the
        // transaction, or 30 minutes passed): the bridge's record rules.
        if (r.kind === "receipt" && r.receipt.status === "0x1") ctx.mined = true;
        else if (r.kind === "missing" || r.kind === "timeout") ctx.mined = true;
        else if (r.kind === "receipt") verdict = `The burn failed on ${escapeHtml(chain.name)}, so no USDC left your wallet.`;
        else if (r.kind === "replaced") {
          verdict =
            "Your wallet replaced this transaction (a speed-up or a cancel), so it will never be mined. " +
            "If you sped it up, enter the new hash under Track a burn.";
        }
        redraw();
        wake();
      })
      .catch(() => {});
  }
  const nap = (ms) =>
    new Promise((resolve) => {
      wake = resolve;
      pollSleep(ms).then(resolve);
    });

  const started = Date.now();
  try {
    reportError = await reportError;
    for (;;) {
      if (!alive()) return;
      if (verdict) {
        cSeg(0, "bad");
        line(verdict, "err");
        forget();
        return;
      }
      if (fatal) {
        // The bridge refused the report itself (a chain it does not accept,
        // a malformed hash): asking again cannot change that.
        cSeg(1, "bad");
        line(escapeHtml(fatal), "err");
        forget();
        return;
      }
      let limited = false;
      if (!registered) {
        if (!reportError) reportError = await register();
        if (!alive()) return;
        if (reportError && !fatal) {
          limited = reportError.status === 429;
          line(`The bridge did not answer (${escapeHtml(reportError.message)}); retrying. This page remembers the burn.`);
        }
        reportError = null;
      }
      if (registered && !fatal) {
        let r = null;
        try {
          r = await api(`cctp/deposit/${Number(domain)}/${txHash}`);
        } catch (e) {
          if (e.status === 404) registered = false;
          else {
            limited = e.status === 429;
            line(`The bridge did not answer (${escapeHtml(e.message)}); retrying.`);
          }
        }
        if (!alive()) return;
        if (r && !verdict) {
          const done = renderCctp(r, line, chain, started, ctx);
          if (done === "forget") forget();
          if (done) return;
        }
      }
      await nap(limited ? BACKOFF_MS : 10_000);
    }
  } catch (e) {
    line(escapeHtml(walletError(e)), "err");
  }
}

/** One poll of a burn's progress. Returns true (or "forget") when nothing
 *  more will change. `ctx.mined` is false while a burn this page sent is not
 *  yet mined. */
function renderCctp(r, line, chain, started, ctx = { mined: true }) {
  const name = escapeHtml(chain?.name ?? "its chain");
  const extra =
    (r.waiting ? ` It is waiting: ${escapeHtml(publicWaiting(r.waiting))}.` : "") +
    (r.error ? ` (The bridge reports: ${escapeHtml(r.error)}.)` : "");
  const then = escapeHtml(relayFinalityText());
  switch (r.stage) {
    case "attesting":
      if (!ctx.mined) {
        cSeg(0, "active");
        line(`Waiting for the burn to be mined on ${name}. The bridge has it and takes over from there.`);
        return false;
      }
      cSeg(0, "done");
      cSeg(1, "active");
      line(
        `Waiting for Circle's attestation. Circle attests a burn once ${name} finalizes it, typically 15–30 minutes on these testnets. ` +
          `After the relay to the vault, the deposit mints ${then}. ` +
          `Watching for ${fmtMinutes((Date.now() - started) / 60_000).replace(/^about /, "")}.${extra}`
      );
      return false;
    case "relaying":
      cSeg(0, "done");
      cSeg(1, "done");
      cSeg(2, "active");
      line(`Attested by Circle. The bridge is relaying it to the vault on ${escapeHtml(ethName())}; the deposit then mints ${then}.${extra}`);
      return false;
    case "relayed": {
      cSeg(0, "done");
      cSeg(1, "done");
      cSeg(2, "done");
      const relay = r.relayTx ? ` (${ethTxLink(r.relayTx, "relay transaction")})` : "";
      const dep = r.deposit;
      if (!dep) {
        cSeg(3, "active");
        line(`Relayed to the vault${relay}. The deposit mints ${then}.${extra}`);
        return false;
      }
      const a = assetById(dep.assetId) ?? usdcAsset();
      const amount = dep.sats ? `${formatAtoms(dep.sats, a?.precision ?? 6)} ${tickerOf(a) || usdcTicker()}` : "your deposit";
      const d = describeDeposit(dep, ETH_DEPOSIT_LEG(), amount);
      cSeg(3, d.stage >= 3 ? "done" : d.cls === "bad" ? "bad" : "active");
      line(`Relayed to the vault${relay}. ${d.html}${extra}`, d.cls === "bad" ? "err" : d.cls === "ok" ? "ok" : undefined);
      return d.terminal;
    }
    case "not_found":
      if (Date.now() - started < 5 * 60_000) {
        line(`Looking for the burn in this transaction on ${name}.${extra}`);
        return false;
      }
      cSeg(1, "bad");
      line(`No USDC burn was found in this transaction on ${name}. Check the chain and the hash.`, "err");
      return "forget";
    case "not_for_bridge":
      cSeg(1, "bad");
      line(
        "This burn is not addressed to the bridge's vault, so the bridge cannot complete it. Only the party the burn names can.",
        "err"
      );
      return "forget";
    default:
      line(`Status: ${escapeHtml(r.stage)}.${extra}`);
      return false;
  }
}

// ---------- custody, reserves, health ----------
/** Where the funds are held: one line per chain the bridge takes custody on,
 *  each address linked to a block explorer so a reader can check it. */
function renderCustody() {
  const box = $("custody-block");
  box.innerHTML = "";
  const scan = ETHERSCAN[status.ethChainId];
  const row = (label, entries, note) => {
    if (!entries?.length) return;
    const d = document.createElement("div");
    d.style.marginTop = "3px";
    d.innerHTML =
      `${escapeHtml(label)}: ` +
      entries
        .map((e) =>
          e.href
            ? `<a class="mono" href="${escapeHtml(e.href)}" target="_blank" rel="noopener">${escapeHtml(e.text)}</a>`
            : `<span class="mono">${escapeHtml(e.text)}</span>`
        )
        .join(", ") +
      (note ? ` <span class="note">&middot; ${escapeHtml(note)}</span>` : "");
    box.appendChild(d);
  };
  const vaults = status.vaultAddresses?.length ? status.vaultAddresses : [status.vaultAddress].filter(Boolean);
  // USDC burned on another chain through Circle's CCTP is minted into the
  // deposit vault, so it is held here too, not somewhere else.
  const cctpIn = cctpInboundChains().length > 0;
  const vaultNote = [
    vaults.length > 1 ? "each holds escrow" : null,
    cctpIn ? `USDC bridged from other chains through Circle's CCTP is held ${vaults.length > 1 ? "in the deposit vault" : "here"} too` : null,
  ].filter(Boolean);
  row(
    `${ethName()} vault${vaults.length > 1 ? "s" : ""}`,
    vaults.map((v) => ({ text: v, href: scan ? `${scan}/address/${v}` : null })),
    vaultNote.length ? vaultNote.join("; ") : null
  );
  if (status.btcConfigured) {
    const addrs = status.btcReserveAddresses ?? [];
    row(
      `${status.btcChainName ?? "Bitcoin"} reserve`,
      addrs.length
        ? addrs.map((a) => ({
            text: `${a.address} (${a.amount_btc} BTC)`,
            href: /^[a-z0-9]+$/i.test(a.address) ? `https://mempool.space/testnet4/address/${a.address}` : null,
          }))
        : [{ text: "reserve address unavailable", href: null }],
      // Say plainly what guards it, as the custody service states it.
      status.btcCustody ?? null
    );
  }
  if (status.solConfigured && status.solTreasury) {
    row(`${solName()} treasury`, [
      { text: status.solTreasury, href: `https://explorer.solana.com/address/${status.solTreasury}?cluster=devnet` },
    ]);
  }
}

/** Why a reserve could not be verified, in plain words. */
function plainSupplyError(err) {
  if (/more burned than issued/i.test(err)) {
    return "its issuance is not on the current chain, which happens when an asset was issued before a chain reset";
  }
  return err;
}

/** Proof of reserves: what is locked on each source chain, beside what
 *  circulates on Sequentia. An unmeasured side is shown as unmeasured, never
 *  as zero. */
async function refreshReserves() {
  const box = $("por-body");
  let por;
  try {
    por = await api("por");
  } catch (e) {
    box.innerHTML = `<div class="center">Reserves are unavailable right now: ${escapeHtml(e.message)}</div>`;
    return;
  }
  porAssets = (por.assets ?? []).filter((a) => a.assetId);
  const rows = (por.assets ?? []).filter((a) => a.escrowTracked || a.chainCirculatingAtoms !== null || a.retired);
  if (!rows.length) {
    box.innerHTML = `<div class="center">No bridged assets yet.</div>`;
    return;
  }
  box.innerHTML = "";
  for (const a of rows) {
    const precision = a.precision ?? 8;
    const supply = formatAtoms(a.chainCirculatingAtoms, precision);
    const locked = formatAtoms(a.escrowedAtoms, precision);
    const label = a.ticker ?? a.symbol ?? (a.assetId ? short(a.assetId) : "unknown asset");
    const retired = a.retired ? a.retired.note || "no longer bridged" : null;
    let verdict;
    let vcls = "";
    if (retired) verdict = "retired";
    else if (a.backed === true) {
      verdict = "fully backed";
      vcls = "ok";
    } else if (a.backed === false) {
      verdict = "short: less is locked than circulates";
      vcls = "bad";
    } else if (a.chainSupplyError) verdict = "cannot be checked";
    else verdict = "locked amount not measured";

    const row = document.createElement("div");
    row.className = "porrow" + (retired ? " retired" : "");
    const lines = [];
    if (!retired || supply !== null || locked !== null) {
      lines.push(
        `${supply === null ? "amount in circulation unknown" : `${supply} in circulation`} · ` +
          `${locked === null ? "locked amount not measured" : `${locked} locked`}`
      );
    }
    if (retired) lines.push(`Retired by the operator: ${retired}.`);
    else if (a.backed === null && a.chainSupplyError) lines.push(`Cannot be checked: ${plainSupplyError(a.chainSupplyError)}.`);
    if (Array.isArray(a.sources) && a.sources.length) {
      const per = a.sources.map((s) => {
        const where = s.chainName ?? `chain ${s.chainId}`;
        if (s.escrowError) return `${where}: unreadable (${s.escrowError})`;
        if (s.escrowedUnits === null || s.escrowedUnits === undefined) return `${where}: not measured`;
        // A rate-limited refresh keeps the last good figure; say how old it is.
        const age = s.stale && s.readAt ? ` as of ${s.readAt.replace("T", " ").slice(0, 16)} UTC` : "";
        return `${where} ${formatUnits(s.escrowedUnits, s.decimals ?? 8)}${age}`;
      });
      lines.push(`Locked on ${per.join(", ")}.`);
    }
    // Minted but still with the issuer is inventory, not anyone's claim.
    if (a.issuerHeldAtoms && a.issuedAtoms) {
      lines.push(
        `${formatAtoms(a.issuedAtoms, precision)} minted, of which ${formatAtoms(a.issuerHeldAtoms, precision)} is still held by the bridge and issued to nobody.`
      );
    }
    if (a.custody) lines.push(`Reserve held as ${a.custody}.`);
    row.innerHTML =
      `<div class="head"><span class="tick">${escapeHtml(label)}</span><span class="verdict ${vcls}">${escapeHtml(verdict)}</span></div>` +
      lines.map((l) => `<div>${escapeHtml(l)}</div>`).join("");
    box.appendChild(row);
  }
}

/** A banner while the operator has paused an asset. The health report can
 *  answer 503 while failing; its JSON is read either way, and nothing but the
 *  paused assets is shown publicly. */
async function refreshHealth() {
  const banner = $("health-banner");
  let h = null;
  try {
    const res = await fetch(new URL("health", API_ROOT));
    h = await res.json();
  } catch {
    h = null;
  }
  const halted = new Map();
  for (const [id, v] of Object.entries(h?.halted ?? {})) halted.set(id, v?.scope ?? "all");
  for (const p of h?.problems ?? []) {
    if (typeof p?.key === "string" && p.key.startsWith("halt:")) {
      const id = p.key.slice(5);
      if (!halted.has(id)) halted.set(id, /\(mint\)/.test(p.title ?? "") ? "mint" : "all");
    }
  }
  haltedAssets = halted;
  renderDepositPreview();
  if (!halted.size) {
    banner.classList.add("hide");
    banner.innerHTML = "";
    return;
  }
  const name = (id) => tickerOf(assetById(id)) || `asset ${short(id)}`;
  const group = (scope) => [...halted].filter(([, s]) => (scope === "mint" ? s === "mint" : s !== "mint")).map(([id]) => name(id));
  const list = (names) => (names.length > 1 ? `${names.slice(0, -1).join(", ")} and ${names.at(-1)}` : names[0]);
  const lines = [];
  const mint = group("mint");
  const all = group("all");
  if (mint.length) {
    lines.push(`<strong>Minting of ${escapeHtml(list(mint))} is paused while the operator investigates.</strong> Deposits of it wait and mint once it resumes.`);
  }
  if (all.length) {
    lines.push(`<strong>Minting and payouts of ${escapeHtml(list(all))} are paused while the operator investigates.</strong> Deposits and returns of it wait until it resumes.`);
  }
  banner.innerHTML = lines.map((l) => `<div>${l}</div>`).join("");
  banner.classList.remove("hide");
}

async function refreshAssets() {
  try {
    assets = await api("assets");
  } catch {
    /* keep the last list */
  }
  if (dropIsOpen()) renderTokenDroplist();
  for (const f of Object.values(seqFields)) f.renote();
  renderRedeemAssets();
  fillSolPayTokens();
  renderSolWrapTarget();
}

// ---------- legs, tabs ----------
// Every "Bridge from" option. Adding a source (for example USDC arriving
// from another chain) is one entry here plus its <section class="leg"> in
// index.html.
const LEGS = [
  {
    id: "eth",
    label: () => `Ethereum (${ethName()})`,
    pill: () => ethName(),
    available: () => true,
  },
  {
    id: "cctp",
    label: () => "USDC from another chain",
    pill: () => cctpChain($("cctp-chain").value)?.name ?? "USDC via CCTP",
    available: () => cctpInboundChains().length > 0,
  },
  {
    id: "btc",
    label: () => `Bitcoin (${(status?.btcChainName ?? "Bitcoin testnet4").replace(/^Bitcoin\s*/i, "") || "testnet4"})`,
    pill: () => status?.btcChainName ?? "Bitcoin testnet4",
    available: () => status?.btcConfigured !== false,
  },
  {
    id: "sol",
    label: () => `Solana (${solName().replace(/^Solana\s*/i, "") || "devnet"})`,
    pill: () => solName(),
    available: () => status?.solConfigured !== false,
  },
];

function buildLegSelect() {
  const sel = $("net-choice");
  const keep = sel.value;
  sel.innerHTML = "";
  for (const leg of LEGS) {
    if (!leg.available()) continue;
    const o = document.createElement("option");
    o.value = leg.id;
    o.textContent = leg.label();
    sel.appendChild(o);
  }
  if ([...sel.options].some((o) => o.value === keep)) sel.value = keep;
}

function showLeg(id) {
  const sel = $("net-choice");
  if (![...sel.options].some((o) => o.value === id)) id = sel.options[0]?.value ?? "eth";
  sel.value = id;
  for (const leg of LEGS) $(`leg-${leg.id}`)?.classList.toggle("hide", leg.id !== id);
  const leg = LEGS.find((l) => l.id === id);
  const pill = $("net-from");
  pill.textContent = leg ? leg.pill() : id;
  pill.className = `net ${id}`;
  store.set("leg", id);
  try {
    history.replaceState(null, "", `#${id}`);
  } catch {
    /* sandboxed; the hash is only a convenience */
  }
}

/** A two-tab strip with the ARIA tabs pattern: arrow keys, Home and End move
 *  between tabs, and only the selected tab is in the tab order. */
function setupTabs(pairs) {
  const select = (i, focus = false) => {
    pairs.forEach((p, j) => {
      const on = i === j;
      const tab = $(p.tab);
      tab.setAttribute("aria-selected", String(on));
      tab.tabIndex = on ? 0 : -1;
      $(p.panel).classList.toggle("hide", !on);
    });
    if (focus) $(pairs[i].tab).focus();
  };
  pairs.forEach((p, i) => {
    const tab = $(p.tab);
    tab.addEventListener("click", () => select(i));
    tab.addEventListener("keydown", (e) => {
      const n = pairs.length;
      const k = { ArrowRight: (i + 1) % n, ArrowLeft: (i - 1 + n) % n, Home: 0, End: n - 1 }[e.key];
      if (k !== undefined) {
        e.preventDefault();
        select(k, true);
      }
    });
  });
  return select;
}

// ---------- remember and resume ----------
function restoreSessions() {
  const dep = store.get("eth.depositTx");
  if (typeof dep === "string" && /^0x[0-9a-f]{64}$/.test(dep)) trackDeposit(dep);
  const red = store.get("eth.redeem");
  if (red?.seqAddress && !ethRedeem) {
    if (red.ethAddress) $("ethaddr-input").value = red.ethAddress;
    showEthRedemption(red.seqAddress, red.ethAddress ?? null, "restored", red.domain ?? 0);
  }
  const bw = store.get("btc.wrap");
  if (bw?.depositAddress) {
    $("wrap-seqaddr").value = bw.seqAddress ?? "";
    if (bw.seqAddress) seqFields.wrap.schedule();
    showBtcWrap(bw);
  }
  const bu = store.get("btc.unwrap");
  if (bu?.sbtcAddress) {
    $("unwrap-btcaddr").value = bu.btcAddress ?? "";
    showBtcUnwrap(bu);
  }
  const sw = store.get("sol.wrap");
  if (sw?.depositAddress) {
    $("sol-wrap-seqaddr").value = sw.seqAddress ?? "";
    if (sw.seqAddress) seqFields.solWrap.schedule();
    showSolWrap(sw);
  }
  const su = store.get("sol.unwrap");
  if (su?.seqAddress) {
    $("sol-unwrap-addr-input").value = su.solAddress ?? "";
    showSolUnwrap(su);
  }
  const burn = store.get("cctp.burn");
  if (burn?.txHash && cctpChain(burn.domain) && /^0x[0-9a-f]{64}$/.test(burn.txHash)) trackCctp(burn.domain, burn.txHash);
}

// ---------- init ----------
function wireStatic() {
  setupTabs([
    { tab: "tab-dep", panel: "panel-dep" },
    { tab: "tab-red", panel: "panel-red" },
  ]);
  btcTabs = setupTabs([
    { tab: "tab-wrap", panel: "panel-wrap" },
    { tab: "tab-unwrap", panel: "panel-unwrap" },
  ]);
  setupTabs([
    { tab: "tab-sol-wrap", panel: "panel-sol-wrap" },
    { tab: "tab-sol-unwrap", panel: "panel-sol-unwrap" },
  ]);
  for (const b of document.querySelectorAll(".copybtn[data-copy]")) wireCopy(b);
  for (const b of document.querySelectorAll(".walletfill")) b.addEventListener("click", () => fillFromSeqWallet(b));
  $("net-choice").addEventListener("change", (e) => showLeg(e.target.value));
  showWalletButtons();
  window.addEventListener("sequentia#initialized", showWalletButtons);
  const onDepChange = () => {
    updateDepositButton();
    renderDepositPreview();
  };
  seqFields.dep = new SeqAddrField("seqaddr-input", onDepChange, () =>
    token ? { ticker: token.receive.ticker, supervised: token.receive.supervised } : null
  );
  seqFields.wrap = new SeqAddrField("wrap-seqaddr", undefined, () => ({ ticker: "SBTC", supervised: false }));
  seqFields.solWrap = new SeqAddrField("sol-wrap-seqaddr");
  seqFields.cctp = new SeqAddrField(
    "cctp-seqaddr",
    () => {
      updateCctpButton();
      renderCctpPreview();
    },
    () => usdcAsset()
  );
  // Claim buttons live inside lists that re-render on every poll, so one
  // listener on the document serves them all.
  document.addEventListener("click", (e) => {
    const b = e.target.closest?.("[data-claim]");
    if (b) openClaim(b.dataset.claim);
  });
  $("claim-go").addEventListener("click", claimGo);
  $("claim-close").addEventListener("click", () => $("claim-dialog").close());
  $("claim-payto").addEventListener("input", renderClaim);
}

function initialLeg() {
  const fromHash = location.hash.replace(/^#/, "");
  if (LEGS.some((l) => l.id === fromHash)) return fromHash;
  return store.get("leg") ?? "eth";
}

async function init() {
  wireStatic();
  try {
    status = await api("status");
  } catch {
    // Show the failure on every leg, and keep the selector working so a
    // Bitcoin- or Solana-minded visitor sees the message too.
    for (const id of ["dep-status", "wrap-status", "sol-wrap-status"]) {
      say(id, "The bridge is unreachable right now. Try again later.", "err");
    }
    showLeg(initialLeg());
    return;
  }
  const seqLabel = String(status.seqChainLabel ?? "Sequentia").replace(/-/g, " ");
  $("net-seq").textContent = seqLabel.charAt(0).toUpperCase() + seqLabel.slice(1);
  setupCctp();
  buildLegSelect();
  showLeg(initialLeg());

  // State the real release gate, with an estimate, before any funds move.
  const anchorConfs = status.btcAnchorConfirmations ?? 3;
  const gate =
    ` The wait is ${anchorConfs} Bitcoin-anchor confirmation${anchorConfs === 1 ? "" : "s"}, ` +
    `${fmtMinutes(anchorConfs * 10)} at the usual 10 minutes per Bitcoin block.`;
  $("red-gate-note").textContent = gate;
  $("sol-gate-note").textContent = gate;

  const site = seqSite();
  if (site) {
    const links = $("seq-links");
    links.innerHTML =
      `<a href="${site}/download/core/">Download Sequentia Core</a>` +
      `<a href="${site}/faucet">Testnet faucet</a>` +
      `<a href="${site}/explorer/">Block explorer</a>`;
    links.classList.remove("hide");
  }

  renderCustody();
  await Promise.all([refreshAssets(), refreshReserves().catch(() => {})]);
  refreshHealth().catch(() => {});
  // Nothing is polled while the tab is hidden.
  setInterval(() => !document.hidden && refreshHealth().catch(() => {}), 60_000);
  setInterval(() => !document.hidden && refreshReserves().catch(() => {}), 5 * 60_000);

  $("btn-connect").addEventListener("click", () =>
    account && walletChainId !== status.ethChainId ? switchNetwork() : connect()
  );
  $("btn-deposit").addEventListener("click", deposit);
  $("btn-intent").addEventListener("click", createIntent);
  $("btn-resume-dep").addEventListener("click", resumeDeposit);
  $("resume-dep-input").addEventListener("keydown", (e) => e.key === "Enter" && resumeDeposit());
  $("btn-resume-red").addEventListener("click", resumeRedemption);
  $("resume-red-input").addEventListener("keydown", (e) => e.key === "Enter" && resumeRedemption());
  $("btn-wrap").addEventListener("click", wrapBtc);
  $("btn-unwrap").addEventListener("click", unwrapBtc);
  $("btn-btc-track").addEventListener("click", trackBtc);
  $("btc-track-input").addEventListener("keydown", (e) => e.key === "Enter" && trackBtc());
  $("btn-sol-wrap").addEventListener("click", wrapSol);
  $("btn-sol-unwrap").addEventListener("click", unwrapSol);
  $("sol-pay-token").addEventListener("change", renderSolWrapTarget);
  wireTokenCombo();
  $("red-assets-search").addEventListener("input", renderRedeemAssets);
  $("sol-red-assets-search").addEventListener("input", renderRedeemAssets);
  $("amount-input").addEventListener("input", () => {
    updateDepositButton();
    renderDepositPreview();
  });

  restoreSessions();
  restoreEthWallet();
}

init();
