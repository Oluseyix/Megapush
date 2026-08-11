/**
 * Base (Sepolia) read-only RPC helpers for fairness entropy.
 * Same endpoint stack as house-tx / bank — no private key required.
 */
import { createPublicClient, http, fallback } from 'viem';
import { baseSepolia } from 'viem/chains';

function envGet(env, ...keys) {
  for (const k of keys) {
    const v = env?.[k];
    if (v != null && String(v).trim() !== '') return String(v).trim();
  }
  return '';
}

export function makePublicClient(env, { timeoutMs = 12_000, retryCount = 1 } = {}) {
  const urls = [
    envGet(env, 'RPC_URL'),
    'https://sepolia.base.org',
    'https://base-sepolia-rpc.publicnode.com',
    'https://base-sepolia.gateway.tenderly.co',
  ].filter(Boolean);
  const transport = fallback(
    urls.map((u) => http(u, { timeout: timeoutMs, retryCount, retryDelay: 150 })),
    { rank: false },
  );
  return createPublicClient({ chain: baseSepolia, transport });
}

/** Current head block number (number). */
export async function getBlockNumber(env, opts = {}) {
  const client = makePublicClient(env, opts);
  const n = await client.getBlockNumber();
  return Number(n);
}

/**
 * Fetch block by number. Returns null if not mined yet or RPC error.
 * Fast path: if head < target, skip the full block fetch (avoids long DO stalls at 1×).
 * @returns {Promise<{ number: number, hash: string } | null>}
 */
export async function getBlockByNumber(env, blockNumber, opts = {}) {
  const n = Number(blockNumber);
  if (!Number.isFinite(n) || n < 0) return null;
  const timeoutMs = opts.timeoutMs ?? 4_000;
  const skipHeadCheck = !!opts.skipHeadCheck;
  try {
    const client = makePublicClient(env, { timeoutMs, retryCount: 0 });
    if (!skipHeadCheck) {
      try {
        const head = Number(await client.getBlockNumber());
        if (Number.isFinite(head) && head < n) return null;
      } catch (_) {
        // Fall through to direct getBlock — some nodes are flaky on blockNumber only
      }
    }
    const block = await client.getBlock({ blockNumber: BigInt(Math.floor(n)) });
    if (!block?.hash) return null;
    return {
      number: Number(block.number),
      hash: String(block.hash).toLowerCase(),
    };
  } catch (e) {
    // eth_getBlockByNumber returns null for future blocks on some nodes; viem may throw
    const msg = String(e?.shortMessage || e?.message || e || '').toLowerCase();
    if (msg.includes('could not be found') || msg.includes('not found') || msg.includes('null')) {
      return null;
    }
    console.warn('getBlockByNumber', n, e?.message || e);
    return null;
  }
}
