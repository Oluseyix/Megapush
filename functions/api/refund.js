/**
 * POST /api/refund — house refunds stake to player (Cloudflare Pages Function)
 */
import {
  createPublicClient,
  createWalletClient,
  http,
  parseAbi,
  parseUnits,
  formatUnits,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { baseSepolia } from 'viem/chains';
import { json, corsOptions, envGet } from '../_lib/json.js';

const USDC = '0x036CbD53842c5426634e7929541eC2318f3dCF7e';

export async function onRequest(context) {
  const { request, env } = context;
  if (request.method === 'OPTIONS') return corsOptions('POST, OPTIONS');
  if (request.method !== 'POST') return json({ ok: false, error: 'Use POST' }, 405);

  const key = envGet(env, 'HOUSE_PRIVATE_KEY', 'HOUSE_KEY');
  if (!key) {
    return json(
      {
        ok: false,
        error:
          'HOUSE_PRIVATE_KEY not configured on Cloudflare. Pages → Settings → Secrets → Redeploy.',
      },
      500,
    );
  }

  let body = {};
  try {
    body = await request.json();
  } catch {
    body = {};
  }

  const player = body.player;
  const entryId = body.entryId != null ? String(body.entryId) : '';
  const stake = Number(body.stake);

  if (!player || !/^0x[a-fA-F0-9]{40}$/.test(player)) {
    return json({ ok: false, error: 'Valid player address required' }, 400);
  }
  if (!entryId) return json({ ok: false, error: 'entryId required' }, 400);
  if (!entryId.toLowerCase().startsWith(player.toLowerCase())) {
    return json({ ok: false, error: 'entryId does not match player' }, 403);
  }
  if (!Number.isFinite(stake) || stake <= 0) {
    return json({ ok: false, error: 'Invalid stake amount' }, 400);
  }

  try {
    const pk = key.startsWith('0x') ? key : `0x${key}`;
    const account = privateKeyToAccount(/** @type {`0x${string}`} */ (pk));
    const house = account.address;
    const RPC = envGet(env, 'RPC_URL') || 'https://sepolia.base.org';
    const publicClient = createPublicClient({ chain: baseSepolia, transport: http(RPC) });
    const walletClient = createWalletClient({
      account,
      chain: baseSepolia,
      transport: http(RPC),
    });
    const usdcAbi = parseAbi([
      'function balanceOf(address account) view returns (uint256)',
      'function transfer(address to, uint256 amount) returns (bool)',
    ]);
    const raw = parseUnits(String(stake), 6);
    const bal = await publicClient.readContract({
      address: USDC,
      abi: usdcAbi,
      functionName: 'balanceOf',
      args: [house],
    });
    if (bal < raw) {
      return json(
        {
          ok: false,
          error: `House USDC low for refund: have ${formatUnits(bal, 6)}, need ${formatUnits(raw, 6)}`,
        },
        400,
      );
    }
    const nonce = await publicClient.getTransactionCount({
      address: house,
      blockTag: 'pending',
    });
    const hash = await walletClient.writeContract({
      address: USDC,
      abi: usdcAbi,
      functionName: 'transfer',
      args: [/** @type {`0x${string}`} */ (player), raw],
      account,
      chain: baseSepolia,
      nonce,
    });
    const receipt = await publicClient.waitForTransactionReceipt({ hash, confirmations: 1 });
    if (receipt.status !== 'success') throw new Error(`Refund transfer reverted: ${hash}`);

    return json({
      ok: true,
      platform: 'cloudflare-pages',
      tx: hash,
      refunded: stake,
      player,
      entryId,
      house,
    });
  } catch (e) {
    return json({ ok: false, error: e?.shortMessage || e?.message || String(e) }, 500);
  }
}
