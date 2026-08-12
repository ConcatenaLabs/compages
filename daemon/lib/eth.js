// Ethereum-side helpers: provider, operator wallet, vault contract, ERC-20
// metadata lookups.

import { ethers } from "ethers";

export const VAULT_ABI = [
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

// Tokens like MKR return bytes32 instead of string.
const ERC20_BYTES32_ABI = [
  "function symbol() view returns (bytes32)",
  "function name() view returns (bytes32)",
];

export class Eth {
  constructor(cfg, operatorKey) {
    this.cfg = cfg;
    this.provider = new ethers.JsonRpcProvider(cfg.ethRpcUrl, cfg.ethChainId, {
      staticNetwork: true,
    });
    this.wallet = new ethers.Wallet(operatorKey, this.provider);
    this.vault = new ethers.Contract(cfg.vaultAddress, VAULT_ABI, this.wallet);
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
