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

// ---- amount conversion between ERC-20 base units and Sequentia sats (8 dp) ----

/** Floor-convert token base units to Sequentia sats. */
export function unitsToSats(units, decimals) {
  const u = BigInt(units);
  if (decimals >= 8) return u / 10n ** BigInt(decimals - 8);
  return u * 10n ** BigInt(8 - decimals);
}

/** Floor-convert Sequentia sats back to token base units. */
export function satsToUnits(sats, decimals) {
  const s = BigInt(sats);
  if (decimals >= 8) return s * 10n ** BigInt(decimals - 8);
  return s / 10n ** BigInt(8 - decimals);
}
