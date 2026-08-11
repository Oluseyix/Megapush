/**
 * Reverse hash-chain seeds for MegaPush fairness (Change 2).
 *
 * Construction (once, before first use):
 *   terminal = seed[length]  // random, never revealed
 *   seed[i]  = sha256(seed[i+1])  for i = length-1 … 0
 *   head     = seed[0]            // published on-chain once
 *
 * Consumption: forward index 0, 1, 2, … length-1
 * Link: sha256(seed[i]) === seed[i-1]  (and after i steps of hashing → head)
 *
 * When exhausted: refuse to open rounds (no silent re-generation).
 */

import { sha256Hex, normalizeHex } from './crash-curve.js';
import { baseSepolia } from 'viem/chains';
import { makeClients, sleep } from './house-tx.js';

/** Default chain length — configurable via SEED_CHAIN_LENGTH. */
export const DEFAULT_CHAIN_LENGTH = 10_000;

/** Max length to keep DO recompute bounded (hashes from terminal per open). */
export const MAX_CHAIN_LENGTH = 50_000;

export const CHAIN_KEY = 'seed_chain_v1';

/**
 * @typedef {{
 *   version: 1,
 *   length: number,
 *   terminal: string,
 *   head: string,
 *   nextIndex: number,
 *   anchorTxHash: string|null,
 *   anchorBlockNumber: number|null,
 *   createdAt: number,
 *   exhaustedAt: number|null,
 * }} SeedChain
 */

export function chainLengthFromEnv(env) {
  const n = Number(env?.SEED_CHAIN_LENGTH);
  if (Number.isFinite(n) && n >= 1) {
    return Math.min(MAX_CHAIN_LENGTH, Math.floor(n));
  }
  return DEFAULT_CHAIN_LENGTH;
}

/** Random 32-byte terminal as hex (64 chars). */
export function randomTerminalHex() {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Compute seed[index] from terminal without storing the full chain.
 * seed[length] = terminal; seed[i] = sha256(seed[i+1]).
 */
export async function seedAtIndex(terminal, length, index) {
  const len = Number(length);
  const i = Number(index);
  if (!Number.isFinite(len) || len < 1) throw new Error('invalid chain length');
  if (!Number.isFinite(i) || i < 0 || i >= len) throw new Error('chain index out of range');
  let s = normalizeHex(terminal);
  if (s.length < 16) throw new Error('invalid terminal');
  // Hash (length - index) times: terminal → seed[length-1] → … → seed[index]
  const steps = len - i;
  for (let k = 0; k < steps; k++) {
    s = await sha256Hex(s);
  }
  return s;
}

/** Head = seed[0]. */
export async function computeHead(terminal, length) {
  return seedAtIndex(terminal, length, 0);
}

/**
 * Create a new chain (caller must persist + anchor before use).
 * @returns {Promise<SeedChain>}
 */
export async function createSeedChain(env) {
  const length = chainLengthFromEnv(env);
  const terminal = randomTerminalHex();
  const head = await computeHead(terminal, length);
  return {
    version: 1,
    length,
    terminal,
    head,
    nextIndex: 0,
    anchorTxHash: null,
    anchorBlockNumber: null,
    createdAt: Date.now(),
    exhaustedAt: null,
  };
}

/**
 * Walk reverse from a revealed seed toward head.
 * After `index` hashes of seed[index], result must equal head.
 */
export async function walkToHead(serverSeed, index) {
  let h = normalizeHex(serverSeed);
  const steps = Math.max(0, Math.floor(Number(index) || 0));
  for (let k = 0; k < steps; k++) {
    h = await sha256Hex(h);
  }
  return h;
}

/**
 * chainOk: sha256(current) === prevSeed (when prev provided).
 * For index 0, prev is null and link is N/A — use headMatch instead.
 */
export async function verifyChainLink(serverSeed, prevServerSeed) {
  if (prevServerSeed == null || String(prevServerSeed).length < 8) return null;
  const link = await sha256Hex(normalizeHex(serverSeed));
  return normalizeHex(link) === normalizeHex(prevServerSeed);
}

/**
 * Verify seed sits at `index` under published head.
 */
export async function verifySeedUnderHead(serverSeed, index, head) {
  if (!head || !serverSeed) return false;
  const walked = await walkToHead(serverSeed, index);
  return normalizeHex(walked) === normalizeHex(head);
}

/**
 * Publish head on Base Sepolia as a 0-value self-tx with data = 0x<head>.
 * Uses HOUSE_PRIVATE_KEY (separate from ROUND_SECRET).
 * @returns {Promise<{ txHash: string, blockNumber: number|null }>}
 */
export async function publishChainHeadOnChain(env, headHex) {
  const head = normalizeHex(headHex);
  if (head.length !== 64) {
    throw new Error('chain head must be 32-byte hex');
  }
  const clients = await makeClients(env);
  const { walletClient, publicClient, account, house } = clients;
  const data = /** @type {`0x${string}`} */ (`0x${head}`);

  let lastErr;
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const nonce = await publicClient.getTransactionCount({
        address: house,
        blockTag: 'pending',
      });
      // House may be EIP-7702-delegated (has code) — self-call with data reverts.
      // Anchor by sending 0-value + head calldata to the burn address (plain EOA sink).
      const ANCHOR_SINK = '0x000000000000000000000000000000000000dEaD';
      const txHash = await walletClient.sendTransaction({
        account,
        chain: baseSepolia,
        to: ANCHOR_SINK,
        value: 0n,
        data,
        nonce,
        gas: 50_000n,
      });
      const receipt = await publicClient.waitForTransactionReceipt({
        hash: txHash,
        confirmations: 1,
        timeout: 90_000,
        pollingInterval: 500,
      });
      if (receipt.status !== 'success') {
        throw new Error(`chain head tx reverted: ${txHash}`);
      }
      return {
        txHash: String(txHash),
        blockNumber: receipt.blockNumber != null ? Number(receipt.blockNumber) : null,
      };
    } catch (e) {
      lastErr = e;
      const msg = String(e?.shortMessage || e?.message || e || '').toLowerCase();
      if (
        attempt < 3 &&
        (msg.includes('nonce') ||
          msg.includes('timeout') ||
          msg.includes('429') ||
          msg.includes('network') ||
          msg.includes('fetch failed'))
      ) {
        await sleep(400 + attempt * 400);
        continue;
      }
      throw e;
    }
  }
  throw lastErr || new Error('publishChainHeadOnChain failed');
}

/**
 * Public (non-secret) view of chain status.
 */
export function chainPublicView(chain) {
  if (!chain) {
    return {
      chainReady: false,
      chainHead: null,
      chainLength: null,
      chainNextIndex: null,
      chainRemaining: null,
      chainAnchorTx: null,
      chainAnchorBlock: null,
      chainExhausted: false,
    };
  }
  const remaining = Math.max(0, Number(chain.length) - Number(chain.nextIndex));
  return {
    chainReady: !!chain.anchorTxHash && remaining > 0,
    chainHead: chain.head || null,
    chainLength: chain.length,
    chainNextIndex: chain.nextIndex,
    chainRemaining: remaining,
    chainAnchorTx: chain.anchorTxHash || null,
    chainAnchorBlock: chain.anchorBlockNumber ?? null,
    chainExhausted: remaining <= 0 || !!chain.exhaustedAt,
    chainCreatedAt: chain.createdAt || null,
  };
}

/**
 * Load chain from DO storage; create if missing (does not auto-anchor).
 * @param {DurableObjectStorage} storage
 */
export async function loadOrCreateChain(storage, env) {
  let chain = await storage.get(CHAIN_KEY);
  if (chain && chain.version === 1 && chain.terminal && chain.head) {
    return chain;
  }
  chain = await createSeedChain(env);
  await storage.put(CHAIN_KEY, chain);
  console.log('SEED_CHAIN_CREATED', {
    length: chain.length,
    head: chain.head.slice(0, 12) + '…',
    createdAt: chain.createdAt,
  });
  return chain;
}

/**
 * Ensure chain exists, is anchored on-chain, and has remaining seeds.
 * @returns {Promise<{ ok: true, chain: SeedChain } | { ok: false, error: string, chain?: SeedChain }>}
 */
export async function ensureChainReady(storage, env) {
  let chain = await loadOrCreateChain(storage, env);

  if (chain.nextIndex >= chain.length) {
    if (!chain.exhaustedAt) {
      chain.exhaustedAt = Date.now();
      await storage.put(CHAIN_KEY, chain);
    }
    console.error('SEED_CHAIN_EXHAUSTED', {
      length: chain.length,
      nextIndex: chain.nextIndex,
      head: chain.head,
      anchorTxHash: chain.anchorTxHash,
    });
    return {
      ok: false,
      error:
        'Seed chain exhausted — refusing to open rounds. Deploy a new chain and publish a new on-chain head (no silent re-seed).',
      chain,
    };
  }

  if (!chain.anchorTxHash) {
    try {
      const pub = await publishChainHeadOnChain(env, chain.head);
      chain.anchorTxHash = pub.txHash;
      chain.anchorBlockNumber = pub.blockNumber;
      chain.anchorDeferred = false;
      chain.anchorError = null;
      await storage.put(CHAIN_KEY, chain);
      console.log('SEED_CHAIN_ANCHORED', {
        head: chain.head.slice(0, 12) + '…',
        txHash: pub.txHash,
        blockNumber: pub.blockNumber,
      });
    } catch (e) {
      // Do not freeze the game: chain head is still fixed in DO storage and public via API.
      // Retry on-chain publish on later opens when HOUSE_PRIVATE_KEY + gas are available.
      console.warn('SEED_CHAIN_ANCHOR_DEFERRED', e?.message || e);
      chain.anchorDeferred = true;
      chain.anchorError = String(e?.message || e || 'anchor failed');
      await storage.put(CHAIN_KEY, chain);
    }
  }

  return { ok: true, chain };
}

/**
 * Consume next seed (advances nextIndex). Caller must have ensureChainReady.
 * Caches the revealed seed as prev for the next link check (avoids recompute).
 * @returns {Promise<{ serverSeed: string, chainIndex: number, prevSeed: string|null, chain: SeedChain }>}
 */
export async function consumeNextSeed(storage, chain) {
  if (chain.nextIndex >= chain.length) {
    throw new Error('Seed chain exhausted');
  }
  const chainIndex = chain.nextIndex;
  const serverSeed = await seedAtIndex(chain.terminal, chain.length, chainIndex);
  // Prefer cached last reveal for prev link (O(1)); fall back to recompute
  let prevSeed = null;
  if (chainIndex > 0) {
    prevSeed =
      chain.lastRevealedSeed && chain.lastRevealedIndex === chainIndex - 1
        ? chain.lastRevealedSeed
        : await seedAtIndex(chain.terminal, chain.length, chainIndex - 1);
  }
  chain.nextIndex = chainIndex + 1;
  chain.lastRevealedSeed = serverSeed;
  chain.lastRevealedIndex = chainIndex;
  if (chain.nextIndex >= chain.length) {
    chain.exhaustedAt = Date.now();
  }
  await storage.put(CHAIN_KEY, chain);
  return { serverSeed, chainIndex, prevSeed, chain };
}
