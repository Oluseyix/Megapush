/**
 * POST /api/cashout — house buys Megapot tickets on Base Sepolia for the player.
 * Private key: process.env.HOUSE_PRIVATE_KEY only (never log or return it).
 *
 * Flow (house is DEBITED, player receives ticket NFTs):
 * 1) House wallet holds USDC (player stakes already transferred here at bet time)
 * 2) House approves RandomBuyer
 * 3) House calls buyTickets(_count, player, …) — USDC leaves house → Megapot
 * 4) Ticket NFTs mint to player (immediate for RandomBuyer ≤10 per call)
 *
 * Large wins are split into chunks of 10 RandomBuyer buys (no delayed batch).
 * Returns houseDebited so the client can prove house spent funds.
 */

/** Global queue: only one house job at a time on this isolate */
let houseTxChain = Promise.resolve();

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
  const msg = String(e?.shortMessage || e?.message || e || '');
  const details = String(e?.details || e?.cause?.message || '');
  const s = (msg + ' ' + details).toLowerCase();
  return (
    s.includes('nonce') &&
    (s.includes('lower') ||
      s.includes('too low') ||
      s.includes('already been used') ||
      s.includes('already known') ||
      s.includes('replacement') ||
      s.includes('underpriced'))
  );
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Cache-Control', 'no-store');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') {
    return res.status(405).json({ ok: false, error: 'Use POST' });
  }

  const key = process.env.HOUSE_PRIVATE_KEY;
  if (!key) {
    return res.status(500).json({ ok: false, error: 'HOUSE_PRIVATE_KEY not configured' });
  }

  let body = req.body;
  if (typeof body === 'string') {
    try {
      body = JSON.parse(body || '{}');
    } catch {
      return res.status(400).json({ ok: false, error: 'Invalid JSON' });
    }
  }
  body = body || {};

  const recipient = body.recipient;
  if (!recipient || !/^0x[a-fA-F0-9]{40}$/.test(recipient)) {
    return res.status(400).json({ ok: false, error: 'Valid recipient required' });
  }

  const stake = Number(body.stake);
  const multiplier = Number(body.multiplier);
  // Tickets = floor(stake) × floor(mult) — whole numbers only (no decimal mult)
  let tickets = Math.floor(Number(body.count));
  if (!Number.isFinite(tickets) || tickets <= 0) {
    const s = Number.isFinite(stake) && stake > 0 ? Math.floor(stake) : 0;
    const mx = Number.isFinite(multiplier) && multiplier > 0 ? Math.floor(multiplier) : 0;
    if (s > 0 && mx > 0) tickets = s * mx;
  }
  if (!Number.isFinite(tickets) || tickets <= 0) {
    return res.status(400).json({
      ok: false,
      error: 'tickets must be ≥ 1 (pass count or stake × whole mult)',
    });
  }

  // Safety cap per request (Vercel time + house float)
  const MAX_TICKETS = 40;
  if (tickets > MAX_TICKETS) tickets = MAX_TICKETS;

  const entryId = body.entryId != null ? String(body.entryId) : null;

  const USDC = '0x036CbD53842c5426634e7929541eC2318f3dCF7e';
  const RANDOM_BUYER = '0x53c04e7e5044B28Ea8A4F9c4b26E3Ac1aeb63746';
  const JACKPOT = '0x465dA3c859f193A3807386387bEE941B2A4c3279';
  const REFERRER = '0x804BEb025844c189b72C8D810a1A7776043677FF';

  try {
    const result = await withHouseLock(async () => {
      const {
        createPublicClient,
        createWalletClient,
        http,
        parseAbi,
        keccak256,
        toBytes,
        formatUnits,
        maxUint256,
      } = await import('viem');
      const { privateKeyToAccount } = await import('viem/accounts');
      const { baseSepolia } = await import('viem/chains');

      const RPC = process.env.RPC_URL || 'https://sepolia.base.org';
      const PRECISE_UNIT = 1000000000000000000n;
      const SOURCE = keccak256(toBytes('megapush'));

      const usdcAbi = parseAbi([
        'function balanceOf(address account) view returns (uint256)',
        'function allowance(address owner, address spender) view returns (uint256)',
        'function approve(address spender, uint256 amount) returns (bool)',
      ]);
      const megapotAbi = parseAbi([
        'function ticketPrice() view returns (uint256)',
        'function buyTickets(uint256 _count, address _recipient, address[] _referrers, uint256[] _referralSplitBps, bytes32 _source) returns (uint256[] ticketIds)',
      ]);

      const pk = key.startsWith('0x') ? key : `0x${key}`;
      const account = privateKeyToAccount(/** @type {`0x${string}`} */ (pk));
      const house = account.address;

      // Never mint tickets to the house wallet by mistake
      if (recipient.toLowerCase() === house.toLowerCase()) {
        const err = new Error('Recipient cannot be the house wallet — tickets must go to the player');
        err.statusCode = 400;
        throw err;
      }

      const publicClient = createPublicClient({
        chain: baseSepolia,
        transport: http(RPC),
      });
      const walletClient = createWalletClient({
        account,
        chain: baseSepolia,
        transport: http(RPC),
      });

      async function pendingNonce() {
        return publicClient.getTransactionCount({
          address: house,
          blockTag: 'pending',
        });
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
          });
          if (receipt.status !== 'success') {
            throw new Error(`Transaction reverted: ${hash}`);
          }
          await sleep(750);
          return hash;
        };

        let nonce = await pendingNonce();
        try {
          return await attempt(nonce);
        } catch (e) {
          if (!isNonceError(e)) throw e;
          await sleep(1000);
          nonce = await pendingNonce();
          return await attempt(nonce);
        }
      }

      let ticketPrice = 1000000n;
      try {
        ticketPrice = await publicClient.readContract({
          address: JACKPOT,
          abi: megapotAbi,
          functionName: 'ticketPrice',
        });
      } catch (_) {
        /* default 1 USDC */
      }

      const houseBalBefore = await publicClient.readContract({
        address: USDC,
        abi: usdcAbi,
        functionName: 'balanceOf',
        args: [house],
      });

      // Afford only what house can pay (house is debited, not credited)
      const maxAffordable = Number(houseBalBefore / ticketPrice);
      if (maxAffordable < 1) {
        const err = new Error(
          `House USDC empty: have ${formatUnits(houseBalBefore, 6)} — cannot buy tickets`,
        );
        err.statusCode = 400;
        throw err;
      }
      if (tickets > maxAffordable) {
        tickets = maxAffordable;
      }

      const cost = ticketPrice * BigInt(tickets);

      async function ensureUsdcAllowance(spender, amount) {
        if (spender.toLowerCase() !== RANDOM_BUYER.toLowerCase()) {
          throw new Error(`Refusing to approve unexpected spender ${spender}`);
        }

        let allowance = await publicClient.readContract({
          address: USDC,
          abi: usdcAbi,
          functionName: 'allowance',
          args: [house, spender],
        });

        if (allowance >= amount) {
          return { approveTx: null, skipped: true };
        }

        if (allowance > 0n) {
          await sendAndWait({
            address: USDC,
            abi: usdcAbi,
            functionName: 'approve',
            args: [spender, 0n],
          });
        }

        const approveAmount = amount > maxUint256 / 2n ? amount : maxUint256;
        const approveTx = await sendAndWait({
          address: USDC,
          abi: usdcAbi,
          functionName: 'approve',
          args: [spender, approveAmount],
        });

        allowance = await publicClient.readContract({
          address: USDC,
          abi: usdcAbi,
          functionName: 'allowance',
          args: [house, spender],
        });
        if (allowance < amount) {
          throw new Error(
            `Allowance still insufficient after approve: have ${allowance}, need ${amount}`,
          );
        }

        return { approveTx, skipped: false };
      }

      // Approve once for full cost, then buy in chunks of ≤10 (immediate NFT mint)
      const approveInfo = await ensureUsdcAllowance(RANDOM_BUYER, cost);

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

      const houseBalAfter = await publicClient.readContract({
        address: USDC,
        abi: usdcAbi,
        functionName: 'balanceOf',
        args: [house],
      });

      const debited = houseBalBefore - houseBalAfter;
      if (debited <= 0n) {
        const err = new Error(
          'House was not debited after buyTickets — tickets may not have been purchased',
        );
        err.statusCode = 500;
        throw err;
      }

      return {
        ok: true,
        txHash: buyTxs[buyTxs.length - 1],
        buyTxs,
        tickets,
        entryId: entryId || undefined,
        recipient,
        stake: Number.isFinite(stake) ? stake : undefined,
        multiplier: Number.isFinite(multiplier) ? multiplier : undefined,
        mode: 'randomBuyer_chunked',
        approveTx: approveInfo?.approveTx || undefined,
        spender: RANDOM_BUYER,
        cost: cost.toString(),
        house,
        houseBalBefore: houseBalBefore.toString(),
        houseBalAfter: houseBalAfter.toString(),
        houseDebited: debited.toString(),
        houseDebitedUsdc: formatUnits(debited, 6),
      };
    });

    return res.status(200).json(result);
  } catch (e) {
    console.error('cashout error', e?.shortMessage || e?.message || e);
    const status = e?.statusCode || 500;
    return res.status(status).json({
      ok: false,
      error: e?.shortMessage || e?.message || String(e),
      tickets,
    });
  }
};
