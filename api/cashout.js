/**
 * POST /api/cashout — house buys Megapot tickets on Base Sepolia.
 * Private key: process.env.HOUSE_PRIVATE_KEY only (never log or return it).
 *
 * - Serialize all house txs (in-memory lock per warm isolate)
 * - Always await receipt between approve and buy
 * - Nonce from getTransactionCount(..., blockTag: 'pending')
 * - Retry once on "nonce too low"
 */

/** Global queue: only one cash-out at a time on this isolate */
let houseTxChain = Promise.resolve();

function withHouseLock(fn) {
  const run = houseTxChain.then(() => fn());
  // Keep chain alive even if this job fails
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
  let tickets = Math.floor(Number(body.count));
  if (!Number.isFinite(tickets) || tickets <= 0) {
    if (Number.isFinite(stake) && Number.isFinite(multiplier) && stake > 0 && multiplier > 0) {
      tickets = Math.floor(stake * multiplier);
    }
  }
  if (!Number.isFinite(tickets) || tickets <= 0) {
    return res.status(400).json({
      ok: false,
      error: 'tickets must be ≥ 1 (pass count or stake × multiplier)',
    });
  }

  const entryId = body.entryId != null ? String(body.entryId) : null;

  const USDC = '0x036CbD53842c5426634e7929541eC2318f3dCF7e';
  const RANDOM_BUYER = '0x53c04e7e5044B28Ea8A4F9c4b26E3Ac1aeb63746';
  const BATCH = '0x62A5D60F486D01a28071652a7951Aff1EA4c5b7c';
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
        'function createBatchOrder(address _recipient, uint64 _dynamicTicketCount, (uint8[] normals, uint8 bonusball)[] _userStaticTickets, address[] _referrers, uint256[] _referralSplit, bytes32 _source)',
        'function hasActiveBatchOrder(address _recipient) view returns (bool)',
      ]);

      const pk = key.startsWith('0x') ? key : `0x${key}`;
      const account = privateKeyToAccount(/** @type {`0x${string}`} */ (pk));
      const house = account.address;

      const publicClient = createPublicClient({
        chain: baseSepolia,
        transport: http(RPC),
      });
      const walletClient = createWalletClient({
        account,
        chain: baseSepolia,
        transport: http(RPC),
      });

      /** Pending-aware nonce (includes in-flight txs). */
      async function pendingNonce() {
        return publicClient.getTransactionCount({
          address: house,
          blockTag: 'pending',
        });
      }

      /**
       * writeContract with explicit pending nonce.
       * On nonce-too-low: re-read pending nonce and retry once.
       * Always wait for receipt before returning.
       */
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
          // Let RPC index the tx before the next nonce fetch
          await sleep(750);
          return hash;
        };

        let nonce = await pendingNonce();
        try {
          return await attempt(nonce);
        } catch (e) {
          if (!isNonceError(e)) throw e;
          // Retry once with fresh pending nonce
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

      /**
       * allowance(house, spender) → approve if needed → wait receipt → re-check.
       * spender = RANDOM_BUYER or BATCH only (never Jackpot).
       */
      async function ensureUsdcAllowance(spender, amount) {
        if (
          spender.toLowerCase() !== RANDOM_BUYER.toLowerCase() &&
          spender.toLowerCase() !== BATCH.toLowerCase()
        ) {
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

        // Reset non-zero allowance first (some ERC20s require this)
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
            `Allowance still insufficient after approve: have ${allowance}, need ${amount}, spender ${spender}`,
          );
        }

        return { approveTx, skipped: false };
      }

      let txHash;
      let approveInfo;
      let mode;

      if (tickets <= 10) {
        mode = 'randomBuyer';
        // 1) approve RANDOM_BUYER → wait receipt (inside sendAndWait)
        approveInfo = await ensureUsdcAllowance(RANDOM_BUYER, cost);
        // 2) only then buyTickets → wait receipt
        txHash = await sendAndWait({
          address: RANDOM_BUYER,
          abi: megapotAbi,
          functionName: 'buyTickets',
          args: [BigInt(tickets), recipient, [REFERRER], [PRECISE_UNIT], SOURCE],
        });
      } else {
        mode = 'batch';
        approveInfo = await ensureUsdcAllowance(BATCH, cost);

        const active = await publicClient.readContract({
          address: BATCH,
          abi: megapotAbi,
          functionName: 'hasActiveBatchOrder',
          args: [recipient],
        });
        if (active) {
          const err = new Error('Recipient has an active batch order');
          err.statusCode = 409;
          throw err;
        }

        txHash = await sendAndWait({
          address: BATCH,
          abi: megapotAbi,
          functionName: 'createBatchOrder',
          args: [recipient, BigInt(tickets), [], [REFERRER], [PRECISE_UNIT], SOURCE],
        });
      }

      return {
        ok: true,
        txHash,
        tickets,
        entryId: entryId || undefined,
        recipient,
        stake: Number.isFinite(stake) ? stake : undefined,
        multiplier: Number.isFinite(multiplier) ? multiplier : undefined,
        mode,
        approveTx: approveInfo?.approveTx || undefined,
        spender: tickets <= 10 ? RANDOM_BUYER : BATCH,
        cost: cost.toString(),
        house,
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
