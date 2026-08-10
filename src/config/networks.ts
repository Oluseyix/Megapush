export type NetworkKey = 'sepolia' | 'mainnet';

export type NetworkConfig = {
  key: NetworkKey;
  label: string;
  shortLabel: string;
  chainId: number;
  chainIdHex: string;
  rpc: string;
  explorer: string;
  jackpot: string;
  usdc: string;
  randomBuyer: string;
  batch: string;
  ticketNft: string;
};

export const NET_STORAGE_KEY = 'megapush_network';

/** Operator wallet — earns referral fees. */
export const REFERRER =
  '0x804BEb025844c189b72C8D810a1A7776043677FF' as const;

/**
 * House buy backend URL. Empty = demo house (UI credit only).
 * Backend holds house key + USDC — never put private keys in the frontend.
 */
export const HOUSE_BUY_URL = '/api/cashout' as const;

/** Active product target: Base Sepolia */
export const DEFAULT_NETWORK: NetworkKey = 'sepolia';

export const NETWORKS: Record<NetworkKey, NetworkConfig> = {
  sepolia: {
    key: 'sepolia',
    label: 'Base Sepolia',
    shortLabel: 'Sepolia',
    chainId: 84532,
    chainIdHex: '0x14a34',
    rpc: 'https://sepolia.base.org',
    explorer: 'https://sepolia.basescan.org',
    jackpot: '0x465dA3c859f193A3807386387bEE941B2A4c3279',
    usdc: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
    randomBuyer: '0x53c04e7e5044B28Ea8A4F9c4b26E3Ac1aeb63746',
    batch: '0x62A5D60F486D01a28071652a7951Aff1EA4c5b7c',
    ticketNft: '0x45084829ac63f9dC6a3D4981A46FA896f9180ECd',
  },
  // Kept for future mainnet launch — game currently targets Sepolia only
  mainnet: {
    key: 'mainnet',
    label: 'Base Mainnet',
    shortLabel: 'Base',
    chainId: 8453,
    chainIdHex: '0x2105',
    rpc: 'https://mainnet.base.org',
    explorer: 'https://basescan.org',
    jackpot: '0x3bAe643002069dBCbcd62B1A4eb4C4A397d042a2',
    usdc: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
    randomBuyer: '0xb9560b43b91dE2c1DaF5dfbb76b2CFcDaFc13aBd',
    batch: '0xBA343479D98a1Ed333899999D95a7343B808a76F',
    ticketNft: '0x48FfE35AbB9f4780a4f1775C2Ce1c46185b366e4',
  },
};

export function isNetworkKey(v: string | null | undefined): v is NetworkKey {
  return v === 'mainnet' || v === 'sepolia';
}

export function readStoredNetwork(): NetworkKey {
  // Product targets Sepolia; ignore stored mainnet until launch
  return DEFAULT_NETWORK;
}

export function persistNetwork(key: NetworkKey) {
  try {
    localStorage.setItem(NET_STORAGE_KEY, key);
  } catch {
    /* ignore */
  }
}

export function gameUrl(network: NetworkKey = DEFAULT_NETWORK): string {
  return `/game.html?net=${network}`;
}

export function shortAddress(addr: string): string {
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}
