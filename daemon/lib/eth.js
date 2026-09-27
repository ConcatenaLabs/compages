// Ethereum-side helpers: provider, operator wallet, vault contract, ERC-20
// metadata lookups.

import { ethers } from "ethers";

// Every custom error any deployed vault version can raise, so a revert is
// read by name rather than filed under "something went wrong".
export const VAULT_ERRORS = [
  "error NotOwner()",
  "error NotOperator()",
  "error NotBurner()",
  "error DepositsArePaused()",
  "error ReleasesArePaused()",
  "error SupplyNotLocked()",
  "error NoStablecoinConfigured()",
  "error BurnFailed()",
  "error ZeroAmount()",
  "error ZeroAddress()",
  "error BadSequentiaAddress()",
  "error AlreadyReleased()",
  "error EtherTransferFailed()",
  "error TokenTransferFailed()",
  "error Reentrancy()",
  "error InsufficientVaultBalance()",
];

export const VAULT_ABI = [
  ...VAULT_ERRORS,
  "event Deposited(uint256 indexed nonce, address indexed token, address indexed from, uint256 amount, string sequentiaAddress)",
  "event Released(bytes32 indexed redemptionId, address indexed token, address indexed to, uint256 amount)",
  "function release(address token, address to, uint256 amount, bytes32 redemptionId)",
  "function processedRedemptions(bytes32) view returns (bool)",
  "function operator() view returns (address)",
  "function depositCount() view returns (uint256)",
];

const ERC20_ABI = [
  "function symbol() view returns (string)",
  "function name() view returns (string)",
  "function decimals() view returns (uint8)",
];

const ERC20_BALANCE_ABI = ["function balanceOf(address) view returns (uint256)"];

// Tokens like MKR return bytes32 instead of string.
const ERC20_BYTES32_ABI = [
  "function symbol() view returns (bytes32)",
  "function name() view returns (bytes32)",
];

export class Eth {
  constructor(cfg, operatorKey) {
    this.cfg = cfg;
    // Bounded like every other outbound call: a provider that stops
    // answering must fail the tick, not hang it.
    const req = new ethers.FetchRequest(cfg.ethRpcUrl);
    req.timeout = cfg.ethRpcTimeoutMs ?? 30_000;
    // One request per HTTP call. ethers batches JSON-RPC calls by default,
    // and a provider that stalls on a batch holding eth_sendRawTransaction
    // (Tenderly's Sepolia gateway does) turns every payout into a timeout
    // while reads keep working, which hides the fault until money must move.
    this.provider = new ethers.JsonRpcProvider(req, cfg.ethChainId, {
      staticNetwork: true,
      batchMaxCount: 1,
    });
    this.wallet = new ethers.Wallet(operatorKey, this.provider);

    // More than one vault can be live at once on the same chain. A stablecoin
    // whose issuer may adopt it needs an escrow that can lock its supply and
    // burn itself at hand-off, and this contract is deliberately not
    // upgradeable, so that capability arrives as a NEW vault. Escrow already
    // sitting in the old one must not be disturbed to get it: moving user
    // funds to gain a feature nobody has used yet would be the riskier half of
    // the trade. So both are watched, and each source names the vault holding
    // its escrow.
    const configured = Array.isArray(cfg.vaults) && cfg.vaults.length
      ? cfg.vaults
      : [{ address: cfg.vaultAddress, deployBlock: cfg.vaultDeployBlock }];
    this.vaults = new Map();
    this.deployBlocks = new Map();
    for (const v of configured) {
      if (!v?.address) continue;
      if (v.deployBlock !== undefined) this.deployBlocks.set(v.address.toLowerCase(), v.deployBlock);
      this.vaults.set(v.address.toLowerCase(), new ethers.Contract(v.address, VAULT_ABI, this.wallet));
    }
    this.vaultAddresses = [...this.vaults.keys()];
    this.vault = this.vaults.get(String(cfg.vaultAddress ?? "").toLowerCase()) ?? this.vaults.values().next().value;
  }

  /** The block a watched vault was deployed in, when configured. */
  deployBlockOf(address) {
    return this.deployBlocks.get(String(address).toLowerCase()) ?? null;
  }

  /** The vault contract at `address`, or the primary vault when a record
   *  predates multi-vault support and names none. */
  vaultFor(address) {
    if (!address) return this.vault;
    return this.vaults.get(String(address).toLowerCase()) ?? this.vault;
  }

  /** The name of a vault custom error in revert data, or null. */
  revertName(data) {
    if (typeof data !== "string" || data.length < 10) return null;
    try {
      return this.vault.interface.parseError(data)?.name ?? null;
    } catch {
      return null;
    }
  }

  /** Send an operator transaction and wait a bounded time for it to mine.
   *
   *  `record(sent)` is called with { hash, nonce, sentAt, maxFeePerGas,
   *  maxPriorityFeePerGas, to, data, value } as soon as the transaction is
   *  broadcast, so a caller can persist it before waiting. Returns the
   *  receipt, or null if it did not mine within `timeoutMs` (it may still:
   *  the caller re-examines it with sentTxState and, if it is stuck, replaces
   *  it at the same nonce with replaceStuck). A revert found while estimating
   *  gas throws before anything is sent. */
  async sendAndWait(contract, method, args, record, timeoutMs = this.cfg.ethTxWaitMs ?? 180_000) {
    const populated = await contract[method].populateTransaction(...args);
    const gasLimit = ((await contract[method].estimateGas(...args)) * 12n) / 10n;
    const fee = await this.provider.getFeeData();
    const tx = await this.wallet.sendTransaction({
      ...populated,
      gasLimit,
      ...(fee.maxFeePerGas ? { maxFeePerGas: fee.maxFeePerGas, maxPriorityFeePerGas: fee.maxPriorityFeePerGas } : {}),
    });
    const sent = {
      hash: tx.hash,
      nonce: tx.nonce,
      sentAt: new Date().toISOString(),
      to: tx.to,
      data: tx.data,
      value: tx.value.toString(),
      gasLimit: tx.gasLimit.toString(),
      maxFeePerGas: tx.maxFeePerGas?.toString() ?? null,
      maxPriorityFeePerGas: tx.maxPriorityFeePerGas?.toString() ?? null,
    };
    await record(sent);
    return this.waitMined(sent.hash, timeoutMs);
  }

  /** A receipt, or null when nothing mined within `timeoutMs`. */
  async waitMined(hash, timeoutMs) {
    try {
      return await this.provider.waitForTransaction(hash, 1, timeoutMs);
    } catch (e) {
      if (e.code === "TIMEOUT") return null;
      throw e;
    }
  }

  /** Where a transaction we sent stands: "mined" (receipt status 1),
   *  "reverted" (mined, status 0), "pending" (known, not mined), or "dropped"
   *  (the node no longer knows it, and its nonce has been used by nothing,
   *  so it can never mine as sent). "replaced" means another transaction of
   *  ours took that nonce. */
  async sentTxState(sent) {
    const receipt = await this.provider.getTransactionReceipt(sent.hash);
    if (receipt) return receipt.status === 1 ? "mined" : "reverted";
    const tx = await this.provider.getTransaction(sent.hash);
    if (tx) return "pending";
    const mined = await this.provider.getTransactionCount(this.wallet.address, "latest");
    return mined > sent.nonce ? "replaced" : "dropped";
  }

  /** Re-send the same call at the same nonce with fees raised by at least
   *  the 10% the mempool demands (30% here), so a release stuck behind a gas
   *  spike cannot hold up every later operator transaction. Returns the new
   *  `sent` record; the old hash stops being the one to watch. */
  async replaceStuck(sent) {
    const fee = await this.provider.getFeeData();
    const bump = (v, floor) => {
      const raised = (BigInt(v ?? 0) * 13n) / 10n;
      const f = BigInt(floor ?? 0);
      return raised > f ? raised : f;
    };
    const maxFeePerGas = bump(sent.maxFeePerGas, fee.maxFeePerGas);
    const maxPriorityFeePerGas = bump(sent.maxPriorityFeePerGas, fee.maxPriorityFeePerGas);
    const tx = await this.wallet.sendTransaction({
      to: sent.to,
      data: sent.data,
      value: BigInt(sent.value ?? 0),
      nonce: sent.nonce,
      gasLimit: BigInt(sent.gasLimit),
      maxFeePerGas,
      maxPriorityFeePerGas,
    });
    return {
      ...sent,
      hash: tx.hash,
      sentAt: new Date().toISOString(),
      maxFeePerGas: maxFeePerGas.toString(),
      maxPriorityFeePerGas: maxPriorityFeePerGas.toString(),
      replaces: [...(sent.replaces ?? []), sent.hash],
    };
  }

  /** What one vault holds of `token` (ZeroAddress or "eth" for ether). */
  async vaultHolding(vault, token) {
    const addr = await vault.getAddress();
    if (token === "eth" || token === ethers.ZeroAddress) return BigInt(await this.provider.getBalance(addr));
    const erc20 = new ethers.Contract(ethers.getAddress(token), ERC20_BALANCE_ABI, this.provider);
    return BigInt(await erc20.balanceOf(addr));
  }

  /** How much of `token` is actually escrowed, in that token's base units:
   *  the total held across every vault this bridge watches.
   *
   *  Read from the chain rather than from the daemon's own escrow counter, for
   *  the same reason circulating supply is read from the Sequentia chain: if
   *  both sides of a proof of reserves come from the operator's bookkeeping, it
   *  proves only that the bookkeeping agrees with itself. It also gives a
   *  figure for assets bridged before that counter existed, which otherwise
   *  can never be reported at all.
   *
   *  Every watched vault counts, not just the one a source names. Escrow left
   *  in a superseded vault is still escrow, and omitting it would understate
   *  backing and read as a shortfall. */
  async escrowBalance(token) {
    const native = token === "eth" || token === ethers.ZeroAddress;
    const erc20 = native
      ? null
      : new ethers.Contract(ethers.getAddress(token), ERC20_BALANCE_ABI, this.provider);
    let total = 0n;
    for (const addr of this.vaultAddresses) {
      const held = native
        ? await this.provider.getBalance(ethers.getAddress(addr))
        : await erc20.balanceOf(ethers.getAddress(addr));
      total += BigInt(held);
    }
    return total;
  }

  /** Fetch symbol/name/decimals for a token address; "eth" for ether. */
  async tokenMetadata(token) {
    if (token === "eth" || token === ethers.ZeroAddress) {
      return { symbol: "ETH", name: "Ether", decimals: 18 };
    }
    const addr = ethers.getAddress(token);
    if ((await this.provider.getCode(addr)) === "0x") {
      throw new Error(`no contract at ${addr}`);
    }
    const c = new ethers.Contract(addr, ERC20_ABI, this.provider);
    const decimals = Number(await c.decimals()); // required; throws if absent
    let symbol, name;
    try {
      [symbol, name] = await Promise.all([c.symbol(), c.name()]);
    } catch {
      const b = new ethers.Contract(addr, ERC20_BYTES32_ABI, this.provider);
      try {
        symbol = ethers.decodeBytes32String(await b.symbol());
        name = ethers.decodeBytes32String(await b.name());
      } catch {
        symbol = addr.slice(0, 10);
        name = addr;
      }
    }
    return { symbol: String(symbol), name: String(name), decimals };
  }
}

// ---- amount conversion between source base units and Sequentia atoms ----
//
// A Sequentia amount is an integer count of ATOMS. How many atoms make one
// whole unit is the asset's precision, fixed forever by the issuance's
// nDenomination: an 8-precision asset has 1e8 atoms per unit, a 6-precision
// one 1e6. Converting a source chain's base units to atoms is therefore a
// shift by (assetPrecision - sourceDecimals) decimal places.
//
// When that shift is negative the conversion floors, and flooring loses value:
// a redemption pays out the floored amount while burning the full atom count,
// so the remainder stays locked in escrow forever and escrow quietly exceeds
// circulating supply. Matching an asset's precision to its source decimals
// makes the shift zero, which is why the unified USDC asset is precision 6
// (doc/sequentia/bridged-usdc-standard.md in the node repo): 1 atom is exactly
// 1 micro-USDC on Ethereum and on Solana, so neither direction can lose value.

export const DEFAULT_ASSET_PRECISION = 8;

/** Floor-convert source base units to Sequentia atoms of a `precision` asset. */
export function unitsToAtoms(units, decimals, precision = DEFAULT_ASSET_PRECISION) {
  const u = BigInt(units);
  const shift = precision - decimals;
  if (shift >= 0) return u * 10n ** BigInt(shift);
  return u / 10n ** BigInt(-shift);
}

/** Floor-convert Sequentia atoms of a `precision` asset back to base units. */
export function atomsToUnits(atoms, decimals, precision = DEFAULT_ASSET_PRECISION) {
  const a = BigInt(atoms);
  const shift = precision - decimals;
  if (shift >= 0) return a / 10n ** BigInt(shift);
  return a * 10n ** BigInt(-shift);
}

/** Floor-convert token base units to Sequentia sats (an 8-precision asset). */
export function unitsToSats(units, decimals) {
  return unitsToAtoms(units, decimals, DEFAULT_ASSET_PRECISION);
}

/** Floor-convert Sequentia sats back to token base units (8-precision asset). */
export function satsToUnits(sats, decimals) {
  return atomsToUnits(sats, decimals, DEFAULT_ASSET_PRECISION);
}
