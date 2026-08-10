/**
 * POST /api/cashout — house buys Megapot tickets for the PLAYER (never house).
 *
 * Body: { recipient, stake?, multiplier?, tickets?|count?, entryId? }
 *
 * - recipient MUST be player wallet (rejected if house)
 * - tickets = body.tickets|count OR floor(stake * multiplier)
 * - ≤10: RandomBuyer.buyTickets
 * - ≥11: Batch.createBatchOrder (+ poll when possible)
 * - Approve correct spender; wait receipt before buy
 * - On failure after stake taken: refund stake USDC to player
 * - Serialized house txs (nonce-safe)
 */

let houseTxChain = Promise.resolve();
let depsPromise = null;
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

function isAddr(a) {
  return typeof a === 'string' && /^0x[a-fA-F0-9]{40}$/.test(a);
}

async function getDeps() {
  if (!depsPromise) {
    depsPromise = (async () => {
      const {
        createPublicClient,
        createWalletClient,
        http,
        parseAbi,
        keccak256,
        toBytes,
        formatUnits,
        parseUnits,
        maxUint256,
      } = await import('viem');
      const { privateKeyToAccount } = await import('viem/accounts');
      const { baseSepolia } = await import('viem/chains');

      const key = (process.env.HOUSE_PRIVATE_KEY || process.env.HOUSE_KEY || '').trim();
      if (!key) {
        throw Object.assign(
          new Error(
            'HOUSE_PRIVATE_KEY not configured on server. Set it in Vercel → Settings → Environment Variables, then Redeploy.',
          ),
          { statusCode: 500 },
        );
      }

      const RPC = process.env.RPC_URL || 'https://sepolia.base.org';
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

      const pk = key.startsWith('0x') ? key : `0x${key}`;
      const account = privateKeyToAccount(/** @type {`0x${string}`} */ (pk));
      const house = account.address;

      const publicClient = createPublicClient({
        chain: baseSepolia,
        transport: http(RPC, { timeout: 20_000 }),
      });
      const walletClient = createWalletClient({
        account,
        chain: baseSepolia,
        transport: http(RPC, { timeout: 20_000 }),
      });

      return {
        publicClient,
        walletClient,
        account,
        house,
        usdcAbi,
        megapotAbi,
        ticketReadAbi,
        PRECISE_UNIT,
        SOURCE,
        USDC,
        RANDOM_BUYER,
        BATCH,
        JACKPOT,
        TICKET_NFT,
        REFERRER,
        maxUint256,
        formatUnits,
        parseUnits,
        baseSepolia,
      };
    })().catch((e) => {
      depsPromise = null;
      throw e;
    });
  }
  return depsPromise;
}

/**
 * Attempt stake refund to player. Never throws to outer caller.
 */
async function tryRefundStake(d, player, stakeUsd, entryId) {
  try {
    if (!isAddr(player) || !(Number(stakeUsd) > 0)) return null;
    const { publicClient, walletClient, account, house, usdcAbi, USDC, parseUnits, baseSepolia } =
      d;
    const raw = parseUnits(String(stakeUsd), 6);
    const bal = await publicClient.readContract({
      address: USDC,
      abi: usdcAbi,
      functionName: 'balanceOf',
      args: [house],
    });
    if (bal < raw) {
      console.error('refund: house USDC low', String(bal), String(raw));
      return null;
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
    const receipt = await publicClient.waitForTransactionReceipt({
      hash,
      confirmations: 1,
      timeout: 60_000,
    });
    if (receipt.status !== 'success') return null;
    console.log('cashout refund ok', { player, stakeUsd, entryId, hash });
    return hash;
  } catch (e) {
    console.error('cashout refund failed', e?.shortMessage || e?.message || e);
    return null;
  }
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

  const keyCheck = (process.env.HOUSE_PRIVATE_KEY || process.env.HOUSE_KEY || '').trim();
  if (!keyCheck) {
    return res.status(500).json({
      ok: false,
      error:
        'HOUSE_PRIVATE_KEY not configured on server. Set it in Vercel → Project → Settings → Environment Variables (Production + Preview), then Redeploy.',
    });
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

  // 1) recipient = PLAYER only (never house)
  const recipient = body.recipient;
  if (!isAddr(recipient)) {
    return res.status(400).json({
      ok: false,
      error: 'Valid player recipient required',
      recipient: recipient || null,
    });
  }

  const stake = Number(body.stake);
  const multiplier = Number(body.multiplier);
  const entryId = body.entryId != null ? String(body.entryId) : null;

  // 2) tickets = body.tickets|count OR floor(stake * multiplier)
  let tickets = Math.floor(Number(body.tickets != null ? body.tickets : body.count));
  if (!Number.isFinite(tickets) || tickets <= 0) {
    if (Number.isFinite(stake) && Number.isFinite(multiplier) && stake > 0 && multiplier > 0) {
      tickets = Math.floor(stake * multiplier);
    }
  }
  if (!Number.isFinite(tickets) || tickets <= 0) {
    return res.status(400).json({
      ok: false,
      error: 'tickets must be ≥ 1 (pass tickets/count or stake × multiplier)',
      recipient,
    });
  }

  // Cap to keep under serverless timeout; still buy for player
  const MAX_TICKETS = 100;
  if (tickets > MAX_TICKETS) tickets = MAX_TICKETS;

  try {
    const result = await withHouseLock(async () => {
      const d = await getDeps();
      const {
        publicClient,
        walletClient,
        account,
        house,
        usdcAbi,
        megapotAbi,
        ticketReadAbi,
        PRECISE_UNIT,
        SOURCE,
        USDC,
        RANDOM_BUYER,
        BATCH,
        JACKPOT,
        TICKET_NFT,
        REFERRER,
        maxUint256,
        formatUnits,
        baseSepolia,
      } = d;

      // NEVER mint to house
      if (recipient.toLowerCase() === house.toLowerCase()) {
        const err = new Error('Recipient cannot be the house treasury — tickets must go to the player');
        err.statusCode = 400;
        throw err;
      }

      console.log('cashout start', {
        recipient,
        house,
        tickets,
        stake,
        multiplier,
        entryId,
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
            timeout: 60_000,
            pollingInterval: 400,
          });
          if (receipt.status !== 'success') {
            throw new Error(`Transaction reverted: ${hash}`);
          }
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

      // Ticket price
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

      // 5) Approve correct spender (RandomBuyer OR Batch)
      const spender = tickets <= 10 ? RANDOM_BUYER : BATCH;
      const mode = tickets <= 10 ? 'randomBuyer' : 'batch';

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
        allowance = await publicClient.readContract({
          address: USDC,
          abi: usdcAbi,
          functionName: 'allowance',
          args: [house, spender],
        });
        if (allowance < cost) {
          throw new Error(`Allowance still insufficient for ${spender}`);
        }
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
      let txHash;

      if (tickets <= 10) {
        // 3) RandomBuyer — immediate mint to recipient (PLAYER)
        txHash = await sendAndWait({
          address: RANDOM_BUYER,
          abi: megapotAbi,
          functionName: 'buyTickets',
          args: [
            BigInt(tickets),
            recipient,
            [REFERRER],
            [PRECISE_UNIT],
            SOURCE,
          ],
        });
      } else {
        // 4) Batch ≥11 — create order for recipient (PLAYER)
        const active = await publicClient.readContract({
          address: BATCH,
          abi: megapotAbi,
          functionName: 'hasActiveBatchOrder',
          args: [recipient],
        });
        if (active) {
          const err = new Error('Player already has an active batch order — try again shortly');
          err.statusCode = 409;
          throw err;
        }
        txHash = await sendAndWait({
          address: BATCH,
          abi: megapotAbi,
          functionName: 'createBatchOrder',
          args: [
            recipient,
            BigInt(tickets),
            [],
            [REFERRER],
            [PRECISE_UNIT],
            SOURCE,
          ],
        });

        // Poll until batch no longer active OR tickets appear
        for (let i = 0; i < 20; i++) {
          await sleep(750);
          let stillActive = false;
          try {
            stillActive = await publicClient.readContract({
              address: BATCH,
              abi: megapotAbi,
              functionName: 'hasActiveBatchOrder',
              args: [recipient],
            });
          } catch (_) {}
          const after = await countPlayerTickets();
          if (
            !stillActive ||
            (beforeCount != null && after != null && after >= beforeCount + 1)
          ) {
            break;
          }
        }
      }

      // Verify tickets moved to PLAYER (best-effort)
      let afterCount = beforeCount;
      for (let i = 0; i < 8; i++) {
        await sleep(350 + i * 100);
        afterCount = await countPlayerTickets();
        if (
          beforeCount == null ||
          afterCount == null ||
          afterCount > beforeCount ||
          (tickets <= 10 && afterCount >= beforeCount + tickets)
        ) {
          if (
            beforeCount != null &&
            afterCount != null &&
            afterCount >= beforeCount + (tickets <= 10 ? tickets : 1)
          ) {
            break;
          }
          if (tickets <= 10 && beforeCount != null && afterCount != null && afterCount > beforeCount) {
            break;
          }
        }
      }

      const delivered =
        beforeCount != null && afterCount != null
          ? Math.max(0, afterCount - beforeCount)
          : tickets;

      // For immediate RandomBuyer path, require at least some tickets on player
      if (mode === 'randomBuyer' && beforeCount != null && afterCount != null && delivered < 1) {
        throw new Error(
          'Buy tx succeeded but player ticket balance did not increase — will refund',
        );
      }

      const payload = {
        ok: true,
        txHash,
        tickets: mode === 'randomBuyer' && delivered > 0 ? delivered : tickets,
        recipient, // 9) always log/return player address
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
      console.log('cashout success', payload);
      return payload;
    });

    return res.status(200).json(result);
  } catch (e) {
    console.error('cashout error', e?.shortMessage || e?.message || e, { recipient, tickets, stake });
    depsPromise = null;

    // 7) Buy failed after stake was taken → refund stake to player
    let refundTxHash = null;
    if (Number.isFinite(stake) && stake > 0 && isAddr(recipient)) {
      try {
        const d = await getDeps();
        refundTxHash = await withHouseLock(() => tryRefundStake(d, recipient, stake, entryId));
      } catch (re) {
        console.error('refund path error', re);
      }
    }

    const status = e?.statusCode || 500;
    return res.status(status).json({
      ok: false,
      error: e?.shortMessage || e?.message || String(e),
      recipient,
      tickets,
      stake: Number.isFinite(stake) ? stake : undefined,
      refundTxHash: refundTxHash || undefined,
    });
  }
};
