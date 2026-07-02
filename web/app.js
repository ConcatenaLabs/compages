// Compages web app. No framework, no external dependencies: contract calls
// are ABI-encoded by hand against the vault's small, fixed interface.

const SEL = {
  depositEther: "0x77c76321", // depositEther(string)
  depositToken: "0xa10d0960", // depositToken(address,uint256,string)
  allowance: "0xdd62ed3e", // allowance(address,address)
  approve: "0x095ea7b3", // approve(address,uint256)
};

const $ = (id) => document.getElementById(id);
// Resolve the API relative to this module's own URL, so the app works whether
// it is served at the site root (local daemon) or behind a path prefix such as
// /bridge/ (reverse-proxied in production). import.meta.url is the absolute URL
// of app.js, e.g. https://host/bridge/app.js -> API root https://host/bridge/api/.
const API_ROOT = new URL("api/", import.meta.url);
const api = async (path, opts) => {
  const res = await fetch(new URL(path, API_ROOT), opts);
  const body = await res.json();
  if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
  return body;
};

// ---------- state ----------
let status = null; // /api/status
let assets = []; // /api/assets
let account = null;
let walletChainId = null;
let token = null; // selected token info from /api/token
let depositBusy = false;

const ETHERSCAN = { 11155111: "https://sepolia.etherscan.io", 1: "https://etherscan.io" };
const short = (s) => (s && s.length > 16 ? `${s.slice(0, 8)}…${s.slice(-6)}` : s);
const escapeHtml = (s) =>
  String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

// ---------- ABI helpers ----------
const strip0x = (h) => (h.startsWith("0x") ? h.slice(2) : h);
const word = (v) => BigInt(v).toString(16).padStart(64, "0");
const wordAddr = (a) => strip0x(a).toLowerCase().padStart(64, "0");
function wordsString(s) {
  const bytes = new TextEncoder().encode(s);
  let hex = "";
  for (const b of bytes) hex += b.toString(16).padStart(2, "0");
  const padded = hex.padEnd(Math.ceil(hex.length / 64) * 64 || 64, "0");
  return word(bytes.length) + padded;
}
const dataDepositEther = (seqAddr) => SEL.depositEther + word(0x20) + wordsString(seqAddr);
const dataDepositToken = (tok, units, seqAddr) =>
  SEL.depositToken + wordAddr(tok) + word(units) + word(0x60) + wordsString(seqAddr);
const dataAllowance = (owner, spender) => SEL.allowance + wordAddr(owner) + wordAddr(spender);
const dataApprove = (spender, units) => SEL.approve + wordAddr(spender) + word(units);

// ---------- amounts ----------
function parseUnits(str, decimals) {
  const m = /^(\d+)(?:\.(\d+))?$/.exec(str.trim());
  if (!m) throw new Error("enter a plain decimal amount");
  const maxDp = Math.min(8, decimals);
  const frac = m[2] ?? "";
  if (frac.length > maxDp) {
    throw new Error(`use at most ${maxDp} decimal places (Sequentia amounts have 8)`);
  }
  const units =
    BigInt(m[1]) * 10n ** BigInt(decimals) +
    BigInt(frac.padEnd(decimals, "0") || "0");
  if (units === 0n) throw new Error("amount is zero");
  return units;
}
function formatSats(sats) {
  const s = BigInt(sats);
  const frac = (s % 100000000n).toString().padStart(8, "0").replace(/0+$/, "");
  return `${s / 100000000n}${frac ? "." + frac : ""}`;
}

// ---------- ethereum provider ----------
const eth = () => {
  if (!window.ethereum) throw new Error("no Ethereum wallet found; install MetaMask");
  return window.ethereum;
};
const rpc = (method, params = []) => eth().request({ method, params });

async function connect() {
  try {
    const accounts = await rpc("eth_requestAccounts");
    account = accounts[0];
    walletChainId = parseInt(await rpc("eth_chainId"), 16);
    eth().on?.("accountsChanged", (a) => {
      account = a[0] ?? null;
      renderWallet();
    });
    eth().on?.("chainChanged", (c) => {
      walletChainId = parseInt(c, 16);
      renderWallet();
    });
  } catch (e) {
    $("wallet-line").textContent = e.message;
    $("wallet-line").classList.add("err");
    return;
  }
  renderWallet();
}

async function switchNetwork() {
  try {
    await rpc("wallet_switchEthereumChain", [
      { chainId: "0x" + status.ethChainId.toString(16) },
    ]);
  } catch (e) {
    $("wallet-line").textContent = `switch to ${status.ethChainName} in your wallet: ${e.message}`;
  }
}

function renderWallet() {
  const line = $("wallet-line");
  line.classList.remove("err");
  if (!account) {
    $("btn-connect").textContent = "Connect wallet";
    line.textContent = "";
  } else if (status && walletChainId !== status.ethChainId) {
    $("btn-connect").textContent = `Switch to ${status.ethChainName}`;
    line.textContent = `${short(account)} is on chain ${walletChainId}; Compages uses ${status.ethChainName}`;
    line.classList.add("err");
  } else {
    $("btn-connect").textContent = short(account);
    line.textContent = "connected";
  }
  updateDepositButton();
}

// ---------- token selection ----------
async function selectToken(t) {
  const card = $("token-card");
  card.classList.remove("hide");
  card.innerHTML = `<span class="note">looking up token&hellip;</span>`;
  token = null;
  updateDepositButton();
  try {
    token = await api(`token/${t}`);
  } catch (e) {
    card.innerHTML = `<span class="note">${escapeHtml(e.message)}</span>`;
    return;
  }
  const isEth = token.token === "eth";
  const idLine = isEth
    ? "ether, the chain's own coin"
    : `<span class="mono">${escapeHtml(token.token)}</span>`;
  const badge = token.bridged
    ? '<span class="badge known">already bridged</span>'
    : '<span class="badge new">first bridge</span>';
  const note = token.bridged
    ? `<div class="note" style="margin-top:6px">This asset already exists on Sequentia
       (asset id <span class="mono">${short(token.assetId)}</span>).
       Your deposit <strong>mints more of the same asset</strong>; no duplicate is created.</div>`
    : `<div class="note" style="margin-top:6px">Not on Sequentia yet.
       <strong>You would be the first to bridge it</strong>: your deposit issues a brand-new
       Sequentia asset for ${escapeHtml(token.symbol)}, and later deposits by anyone mint that same asset.</div>`;
  card.innerHTML = `
    <div><span class="sym">${escapeHtml(token.symbol)}</span>
    <span class="note">${escapeHtml(token.name)}</span> ${badge}</div>
    <div class="mono" style="margin-top:4px">${idLine} &middot; ${token.decimals} decimals</div>
    ${note}`;
  $("amount-note").textContent =
    `Up to ${Math.min(8, token.decimals)} decimal places. ` +
    (token.decimals > 8
      ? "Sequentia amounts have 8 decimal places; finer amounts cannot be bridged."
      : "");
  updateDepositButton();
  renderChips();
}

function renderChips() {
  const box = $("asset-chips");
  box.innerHTML = "";
  const mk = (label, t) => {
    const b = document.createElement("button");
    b.className = "chip" + (token && token.token === t ? " sel" : "");
    b.textContent = label;
    b.onclick = () => {
      $("token-input").value = t === "eth" ? "" : t;
      selectToken(t);
    };
    box.appendChild(b);
  };
  mk("ETH", "eth");
  for (const a of assets) mk(a.symbol, a.token);
}

function updateDepositButton() {
  const btn = $("btn-deposit");
  const ready =
    !depositBusy &&
    account &&
    status &&
    walletChainId === status.ethChainId &&
    token &&
    $("amount-input").value.trim() &&
    $("seqaddr-input").value.trim().length >= 14;
  btn.disabled = !ready;
  if (!depositBusy) {
    btn.textContent = token ? `Deposit ${token.symbol}` : "Deposit";
  }
}

// ---------- deposit flow ----------
async function deposit() {
  const statusLine = $("dep-status");
  statusLine.classList.remove("err");
  let units;
  try {
    units = parseUnits($("amount-input").value, token.decimals);
  } catch (e) {
    statusLine.textContent = e.message;
    statusLine.classList.add("err");
    return;
  }
  const seqAddr = $("seqaddr-input").value.trim();
  depositBusy = true;
  const btn = $("btn-deposit");
  btn.disabled = true;

  try {
    let txParams;
    if (token.token === "eth") {
      txParams = {
        from: account,
        to: status.vaultAddress,
        value: "0x" + units.toString(16),
        data: dataDepositEther(seqAddr),
      };
    } else {
      // ensure allowance
      const allowanceHex = await rpc("eth_call", [
        { to: token.token, data: dataAllowance(account, status.vaultAddress) },
        "latest",
      ]);
      if (BigInt(allowanceHex === "0x" ? 0 : allowanceHex) < units) {
        btn.textContent = `Approving ${token.symbol}…`;
        const approveHash = await rpc("eth_sendTransaction", [
          { from: account, to: token.token, data: dataApprove(status.vaultAddress, units) },
        ]);
        statusLine.textContent = `approval sent: ${short(approveHash)}`;
        await waitReceipt(approveHash);
      }
      txParams = {
        from: account,
        to: status.vaultAddress,
        data: dataDepositToken(token.token, units, seqAddr),
      };
    }
    btn.textContent = "Confirm in wallet…";
    const hash = await rpc("eth_sendTransaction", [txParams]);
    trackDeposit(hash);
  } catch (e) {
    statusLine.textContent = e?.message ?? String(e);
    statusLine.classList.add("err");
    depositBusy = false;
    updateDepositButton();
  }
}

async function waitReceipt(hash) {
  for (;;) {
    const r = await rpc("eth_getTransactionReceipt", [hash]);
    if (r) {
      if (r.status !== "0x1") throw new Error(`transaction ${short(hash)} failed`);
      return r;
    }
    await sleep(4000);
  }
}

function setSeg(i, state) {
  // state: "active" | "done" | ""
  $(`seg-${i}`).className = "span-seg" + (state ? " " + state : "");
  $(`lab-${i}`).className = state === "done" ? "done" : "";
}

async function trackDeposit(hash) {
  const statusLine = $("dep-status");
  const scan = ETHERSCAN[status.ethChainId];
  $("dep-truss").classList.add("on");
  for (let i = 0; i < 4; i++) setSeg(i, "");
  setSeg(0, "active");
  statusLine.innerHTML = scan
    ? `deposit: <a href="${scan}/tx/${hash}" target="_blank" rel="noopener">${hash}</a>`
    : `deposit: ${hash}`;

  const receipt = await waitReceipt(hash).catch((e) => {
    statusLine.textContent = e.message;
    statusLine.classList.add("err");
    depositBusy = false;
    updateDepositButton();
    return null;
  });
  if (!receipt) return;
  setSeg(0, "done");
  setSeg(1, "active");
  const minedAt = parseInt(receipt.blockNumber, 16);

  // wait for daemon confirmation depth, then for the mint
  for (;;) {
    const head = parseInt(await rpc("eth_blockNumber"), 16);
    const confs = Math.max(0, head - minedAt + 1);
    $("lab-1").textContent = `confirming ${Math.min(confs, status.ethConfirmations)}/${status.ethConfirmations}`;
    let dep = null;
    try {
      const list = await api(`deposit/tx/${hash}`);
      dep = list[list.length - 1];
    } catch {
      /* not seen by the daemon yet */
    }
    if (dep) {
      setSeg(1, "done");
      if (dep.status === "minted") {
        setSeg(2, "done");
        setSeg(3, "done");
        const sym = escapeHtml(token?.symbol ?? "");
        statusLine.innerHTML =
          `delivered: ${formatSats(dep.sats)} ${sym} sent to your Sequentia address` +
          `<br>Sequentia transaction: ${dep.seqTxid ?? "?"}` +
          (dep.assetId ? `<br>asset id: ${dep.assetId}` : "");
        break;
      } else if (dep.status === "refund_pending" || dep.status === "refunded") {
        setSeg(2, "");
        statusLine.textContent = `bridging not possible (${dep.refundReason}); your deposit is being refunded on ${status.ethChainName}`;
        statusLine.classList.add("err");
        break;
      } else if (dep.status === "failed_manual") {
        statusLine.textContent =
          "the bridge hit an unexpected error and paused this deposit for operator review; funds are safe in the vault";
        statusLine.classList.add("err");
        break;
      } else {
        setSeg(2, "active");
      }
    }
    await sleep(5000);
  }
  depositBusy = false;
  updateDepositButton();
  refreshAssets();
}

// ---------- redeem flow ----------
let redeemPoll = null;

async function createIntent() {
  const line = $("red-status");
  line.classList.remove("err");
  const ethAddr = $("ethaddr-input").value.trim();
  if (!/^0x[0-9a-fA-F]{40}$/.test(ethAddr)) {
    line.textContent = "enter a valid Ethereum address (0x + 40 hex characters)";
    line.classList.add("err");
    return;
  }
  try {
    const r = await api("redeem", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ethAddress: ethAddr }),
    });
    $("red-result").classList.remove("hide");
    $("red-addr").textContent = r.seqAddress;
    $("red-note").textContent = r.note;
    line.textContent = "";
    if (redeemPoll) clearInterval(redeemPoll);
    const poll = () => refreshRedemptions(r.seqAddress);
    redeemPoll = setInterval(poll, 6000);
    poll();
  } catch (e) {
    line.textContent = e.message;
    line.classList.add("err");
  }
}

async function refreshRedemptions(seqAddress) {
  let r;
  try {
    r = await api(`redeem/${seqAddress}`);
  } catch {
    return;
  }
  const box = $("red-events");
  if (!r.redemptions.length) {
    box.innerHTML = `<span class="note">nothing received yet; waiting for a transfer to ${escapeHtml(short(seqAddress))}</span>`;
    return;
  }
  const scan = ETHERSCAN[status.ethChainId];
  box.innerHTML = "";
  for (const ev of r.redemptions) {
    const el = document.createElement("div");
    el.className = "event";
    let state, cls;
    switch (ev.status) {
      case "awaiting_finality":
        state = "waiting for Bitcoin-anchor finality" + (ev.finality ? ` (${ev.finality})` : "");
        cls = "wait";
        break;
      case "new":
      case "releasing":
        state = "releasing on " + status.ethChainName;
        cls = "wait";
        break;
      case "released":
      case "destroy_pending":
      case "done":
        state = "released";
        cls = "ok";
        break;
      case "dust_ignored":
        state = "too small to release; contact the operator";
        cls = "bad";
        break;
      case "ignored_unknown_asset":
        state = "not a bridged asset; contact the operator";
        cls = "bad";
        break;
      default:
        state = ev.status;
        cls = "wait";
    }
    const link =
      ev.releaseTxHash && scan
        ? ` &middot; <a href="${scan}/tx/${ev.releaseTxHash}" target="_blank" rel="noopener">release tx</a>`
        : "";
    el.innerHTML = `
      <div>
        <div>${formatSats(ev.sats)} ${escapeHtml(ev.symbol ?? "")}</div>
        <div class="mono">${escapeHtml(short(ev.txid))}:${ev.vout}</div>
      </div>
      <div class="state ${cls}">${state}${link}</div>`;
    box.appendChild(el);
  }
}

function renderRedeemAssets() {
  const box = $("red-assets");
  if (!assets.length) {
    box.innerHTML = `<span class="note">no assets have been bridged yet; bridge one from the Ethereum side first</span>`;
    return;
  }
  box.innerHTML = "";
  for (const a of assets) {
    const el = document.createElement("div");
    el.className = "event";
    el.innerHTML = `
      <div>
        <div>${escapeHtml(a.symbol)} <span class="note">${escapeHtml(a.name)}</span></div>
        <div class="mono">asset ${escapeHtml(a.assetId)}</div>
      </div>
      <div class="state">${formatSats(a.mintedSats)} in circulation</div>`;
    box.appendChild(el);
  }
}

// ---------- tabs + init ----------
function showTab(dep) {
  $("panel-dep").classList.toggle("hide", !dep);
  $("panel-red").classList.toggle("hide", dep);
  $("tab-dep").classList.toggle("active", dep);
  $("tab-red").classList.toggle("active", !dep);
  $("tab-dep").setAttribute("aria-selected", dep);
  $("tab-red").setAttribute("aria-selected", !dep);
}

async function refreshAssets() {
  try {
    assets = await api("assets");
  } catch {
    assets = [];
  }
  renderChips();
  renderRedeemAssets();
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function init() {
  try {
    status = await api("status");
  } catch {
    $("dep-status").textContent = "the bridge daemon is unreachable; try again later";
    $("dep-status").classList.add("err");
    return;
  }
  $("net-eth").textContent = status.ethChainName;
  $("net-seq").textContent = status.seqChainLabel.replace(/-/g, " ");
  const scan = ETHERSCAN[status.ethChainId];
  $("vault-line").innerHTML = scan
    ? `<a href="${scan}/address/${status.vaultAddress}" target="_blank" rel="noopener">${status.vaultAddress}</a>`
    : status.vaultAddress;

  await refreshAssets();

  $("btn-connect").onclick = () =>
    account && walletChainId !== status.ethChainId ? switchNetwork() : connect();
  $("btn-deposit").onclick = deposit;
  $("btn-intent").onclick = createIntent;
  $("btn-copy").onclick = () => navigator.clipboard.writeText($("red-addr").textContent);
  $("tab-dep").onclick = () => showTab(true);
  $("tab-red").onclick = () => showTab(false);
  $("token-input").addEventListener("change", () => {
    const v = $("token-input").value.trim();
    if (/^0x[0-9a-fA-F]{40}$/.test(v)) selectToken(v.toLowerCase());
  });
  for (const id of ["amount-input", "seqaddr-input"]) {
    $(id).addEventListener("input", updateDepositButton);
  }
}

init();
