/**
 * POST /api/cashout — house buys tickets for PLAYER (Cloudflare Pages Function)
 */
import {
  createPublicClient,
  createWalletClient,
  http,
  parseAbi,
  keccak256,
  toBytes,
  formatUnits,
  parseUnits,
  maxUint256,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { baseSepolia } from 'viem/chains';

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': 'no-store',
    },
  });
}
function envGet(env, ...keys) {
  for (const k of keys) {
    const v = env?.[k];
    if (v != null && String(v).trim() !== '') return String(v).trim();
  }
  return '';
}


let houseTxChain = Promise.resolve();
let cachedTicketPrice = null;

function withHouseLock(fn) {
  const run = houseTxChain.then(() => fn());
  houseTxChain = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function isNonceError(e) {
  const s = String(e?.shortMessage || e?.message || e || '').toLowerCase();
  return s.includes('nonce') && (s.includes('too low') || s.includes('already') || s.includes('replacement'));
}

function isAddr(a) {
  return typeof a === 'string' && /^0x[a-fA-F0-9]{40}$/.test(a);
}

const USDC = '0x036CbD53842c5426634e7929541eC2318f3dCF7e';
const RANDOM_BUYER = '0x53c04e7e5044B28Ea8A4F9c4b26E3Ac1aeb63746';
const BATCH = '0x62A5D60F486D01a28071652a7951Aff1EA4c5b7c';
const JACKPOT = '0x465dA3c859f193A3807386387bEE941B2A4c3279';
const TICKET_NFT = '0x45084829ac63f9dC6a3D4981A46FA896f9180ECd';
const REFERRER = '0x804BEb025844c189b72C8D810a1A7776043677FF';
const PRECISE_UNIT = 1000000000000000000n;
const SOURCE = keccak256(toBytes('megapush'));

const usdcAbi = parseAbi([
  'function balanceOf(address account) view returns (uint256)',
  'function allowance(address owner, address spender) view returns (uint256)',
  'function approve(address spender, uint256 amount) returns (bool)',
  'function transfer(address to, uint256 amount) returns (bool)',
]);
const megapotAbi = parseAbi([
  'function ticketPrice() view returns (uint256)',
  'function buyTickets(uint256 _count, address _recipient, address[] _referrers, uint256[] _referralSplitBps, bytes32 _source) returns (uint256[] ticketIds)',
  'function createBatchOrder(address _recipient, uint64 _dynamicTicketCount, (uint8[] normals, uint8 bonusball)[] _userStaticTickets, address[] _referrers, uint256[] _referralSplit, bytes32 _source)',
  'function hasActiveBatchOrder(address _recipient) view returns (bool)',
]);
const ticketReadAbi = parseAbi([
  'function currentDrawingId() view returns (uint256)',
  'function getUserTickets(address _userAddress, uint256 _drawingId) view returns ((uint256 ticketId, (uint256 drawingId, uint256 packedTicket, bytes32 referralScheme) ticket, uint8[] normals, uint8 bonusball)[])',
]);

function makeClients(env) {
  const key = envGet(env, 'HOUSE_PRIVATE_KEY', 'HOUSE_KEY');
  if (!key) {
    const err = new Error(
      'HOUSE_PRIVATE_KEY not configured on Cloudflare. Pages → Settings → Environment variables → Secret → Redeploy.',
    );
    err.statusCode = 500;
    throw err;
  }
  const pk = key.startsWith('0x') ? key : `0x${key}`;
  const account = privateKeyToAccount(/** @type {`0x${string}`} */ (pk));
  const RPC = envGet(env, 'RPC_URL') || 'https://sepolia.base.org';
  const publicClient = createPublicClient({
    chain: baseSepolia,
    transport: http(RPC, { timeout: 20_000 }),
  });
  const walletClient = createWalletClient({
    account,
    chain: baseSepolia,
    transport: http(RPC, { timeout: 20_000 }),
  });
  return { account, house: account.address, publicClient, walletClient };
}

async function tryRefundStake(clients, player, stakeUsd) {
  try {
    if (!isAddr(player) || !(Number(stakeUsd) > 0)) return null;
    const { publicClient, walletClient, account, house } = clients;
    const raw = parseUnits(String(stakeUsd), 6);
    const bal = await publicClient.readContract({
      address: USDC,
      abi: usdcAbi,
      functionName: 'balanceOf',
      args: [house],
    });
    if (bal < raw) return null;
    const nonce = await publicClient.getTransactionCount({ address: house, blockTag: 'pending' });
    const hash = await walletClient.writeContract({
      address: USDC,
      abi: usdcAbi,
      functionName: 'transfer',
      args: [/** @type {`0x${string}`} */ (player), raw],
      account,
      chain: baseSepolia,
      nonce,
    });
    const receipt = await publicClient.waitForTransactionReceipt({ hash, confirmations: 1, timeout: 60_000 });
    if (receipt.status !== 'success') return null;
    return hash;
  } catch (e) {
    console.error('cf refund failed', e?.message || e);
    return null;
  }
}

export async function handleCashout(request, env) {
  if (request.method !== 'POST') return json({ ok: false, error: 'Use POST' }, 405);

  let body = {};
  try {
    body = await request.json();
  } catch {
    body = {};
  }

  const recipient = body.recipient;
  if (!isAddr(recipient)) {
    return json({ ok: false, error: 'Valid player recipient required', recipient: recipient || null }, 400);
  }

  const stake = Number(body.stake);
  const multiplier = Number(body.multiplier);
  const entryId = body.entryId != null ? String(body.entryId) : null;

  let tickets = Math.floor(Number(body.tickets != null ? body.tickets : body.count));
  if (!Number.isFinite(tickets) || tickets <= 0) {
    if (Number.isFinite(stake) && Number.isFinite(multiplier) && stake > 0 && multiplier > 0) {
      tickets = Math.floor(stake * multiplier);
    }
  }
  if (!Number.isFinite(tickets) || tickets <= 0) {
    return json(
      { ok: false, error: 'tickets must be ≥ 1 (pass tickets/count or stake × multiplier)', recipient },
      400,
    );
  }
  if (tickets > 100) tickets = 100;

  try {
    const result = await withHouseLock(async () => {
      const clients = makeClients(env);
      const { publicClient, walletClient, account, house } = clients;

      if (recipient.toLowerCase() === house.toLowerCase()) {
        const err = new Error('Recipient cannot be the house treasury — tickets must go to the player');
        err.statusCode = 400;
        throw err;
      }

      async function pendingNonce() {
        return publicClient.getTransactionCount({ address: house, blockTag: 'pending' });
      }

      async function sendAndWait(buildArgs) {
        const attempt = async (nonce) => {
          const hash = await walletClient.writeContract({
            ...buildArgs,
            account,
            chain: baseSepolia,
            nonce,
          });
          const receipt = await publicClient.waitForTransactionReceipt({
            hash,
            confirmations: 1,
            timeout: 60_000,
            pollingInterval: 400,
          });
          if (receipt.status !== 'success') throw new Error(`Transaction reverted: ${hash}`);
          return hash;
        };
        let nonce = await pendingNonce();
        try {
          return await attempt(nonce);
        } catch (e) {
          if (!isNonceError(e)) throw e;
          await sleep(400);
          nonce = await pendingNonce();
          return await attempt(nonce);
        }
      }

      let ticketPrice = 10000n;
      const now = Date.now();
      if (cachedTicketPrice && now - cachedTicketPrice.at < 60_000) {
        ticketPrice = cachedTicketPrice.value;
      } else {
        try {
          ticketPrice = await publicClient.readContract({
            address: JACKPOT,
            abi: megapotAbi,
            functionName: 'ticketPrice',
          });
          cachedTicketPrice = { value: ticketPrice, at: now };
        } catch (_) {}
      }

      const cost = ticketPrice * BigInt(tickets);
      const houseBal = await publicClient.readContract({
        address: USDC,
        abi: usdcAbi,
        functionName: 'balanceOf',
        args: [house],
      });
      if (houseBal < cost) {
        const err = new Error(
          `House USDC low: have ${formatUnits(houseBal, 6)}, need ${formatUnits(cost, 6)} for ${tickets} tickets`,
        );
        err.statusCode = 400;
        throw err;
      }

      const spender = RANDOM_BUYER;
      const mode = 'randomBuyer_chunked';

      let allowance = await publicClient.readContract({
        address: USDC,
        abi: usdcAbi,
        functionName: 'allowance',
        args: [house, spender],
      });
      if (allowance < cost) {
        if (allowance > 0n) {
          await sendAndWait({
            address: USDC,
            abi: usdcAbi,
            functionName: 'approve',
            args: [spender, 0n],
          });
        }
        await sendAndWait({
          address: USDC,
          abi: usdcAbi,
          functionName: 'approve',
          args: [spender, maxUint256],
        });
      }

      async function countPlayerTickets() {
        try {
          const drawingId = await publicClient.readContract({
            address: JACKPOT,
            abi: ticketReadAbi,
            functionName: 'currentDrawingId',
          });
          let total = 0;
          for (let i = 0; i < 4; i++) {
            const did = drawingId - BigInt(i);
            if (did < 0n) break;
            try {
              const rows = await publicClient.readContract({
                address: TICKET_NFT,
                abi: ticketReadAbi,
                functionName: 'getUserTickets',
                args: [recipient, did],
              });
              total += Array.isArray(rows) ? rows.length : 0;
            } catch (_) {}
          }
          return total;
        } catch (_) {
          return null;
        }
      }

      const beforeCount = await countPlayerTickets();
      // Always RandomBuyer in chunks of ≤10 (reliable immediate NFT mint to player)
      const buyTxs = [];
      let remaining = tickets;
      while (remaining > 0) {
        const chunk = Math.min(10, remaining);
        const hash = await sendAndWait({
          address: RANDOM_BUYER,
          abi: megapotAbi,
          functionName: 'buyTickets',
          args: [BigInt(chunk), recipient, [REFERRER], [PRECISE_UNIT], SOURCE],
        });
        buyTxs.push(hash);
        remaining -= chunk;
      }
      const txHash = buyTxs[buyTxs.length - 1];

      let afterCount = beforeCount;
      for (let i = 0; i < 4; i++) {
        await sleep(300);
        afterCount = await countPlayerTickets();
        if (beforeCount != null && afterCount != null && afterCount > beforeCount) break;
      }

      const delivered =
        beforeCount != null && afterCount != null ? Math.max(0, afterCount - beforeCount) : tickets;

      return {
        ok: true,
        platform: 'cloudflare-pages-worker',
        txHash,
        tickets: delivered > 0 ? delivered : tickets,
        recipient,
        stake: Number.isFinite(stake) ? stake : undefined,
        multiplier: Number.isFinite(multiplier) ? multiplier : undefined,
        entryId: entryId || undefined,
        mode,
        spender,
        house,
        beforeCount,
        afterCount,
        delivered,
        cost: cost.toString(),
        ticketPriceUsdc: formatUnits(ticketPrice, 6),
      };
    });

    return json(result, 200);
  } catch (e) {
    console.error('cf cashout error', e?.shortMessage || e?.message || e);
    let refundTxHash = null;
    if (Number.isFinite(stake) && stake > 0 && isAddr(recipient)) {
      try {
        const clients = makeClients(env);
        refundTxHash = await withHouseLock(() => tryRefundStake(clients, recipient, stake));
      } catch (_) {}
    }
    return json(
      {
        ok: false,
        platform: 'cloudflare-pages-worker',
        error: e?.shortMessage || e?.message || String(e),
        recipient,
        tickets,
        stake: Number.isFinite(stake) ? stake : undefined,
        refundTxHash: refundTxHash || undefined,
      },
      e?.statusCode || 500,
    );
  }
}
