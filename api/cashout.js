/**
 * POST /api/cashout — house buys Megapot tickets for the player (fast path).
 * Private key: process.env.HOUSE_PRIVATE_KEY only.
 *
 * Optimizations:
 * - Warm-isolate module cache (viem clients, allowance, ticket price)
 * - No multi-second sleeps after every tx
 * - Skip debit polling / on-chain ticket verify (receipt = success)
 * - Skip approve when allowance already covers cost
 */

let houseTxChain = Promise.resolve();
/** @type {null | Promise<{ ready: true, publicClient: any, walletClient: any, account: any, house: string, usdcAbi: any, megapotAbi: any, PRECISE_UNIT: bigint, SOURCE: `0x${string}`, USDC: string, RANDOM_BUYER: string, JACKPOT: string, maxUint256: bigint, formatUnits: Function }>} */
let depsPromise = null;
let cachedTicketPrice = null; // { value: bigint, at: number }
let knownAllowanceOk = false; // max approve already set this isolate

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
        maxUint256,
      } = await import('viem');
      const { privateKeyToAccount } = await import('viem/accounts');
      const { baseSepolia } = await import('viem/chains');

      const key = process.env.HOUSE_PRIVATE_KEY;
      if (!key) throw Object.assign(new Error('HOUSE_PRIVATE_KEY not configured'), { statusCode: 500 });

      const RPC = process.env.RPC_URL || 'https://sepolia.base.org';
      const USDC = '0x036CbD53842c5426634e7929541eC2318f3dCF7e';
      const RANDOM_BUYER = '0x53c04e7e5044B28Ea8A4F9c4b26E3Ac1aeb63746';
      const JACKPOT = '0x465dA3c859f193A3807386387bEE941B2A4c3279';
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

      const publicClient = createPublicClient({
        chain: baseSepolia,
        transport: http(RPC, { timeout: 12_000 }),
      });
      const walletClient = createWalletClient({
        account,
        chain: baseSepolia,
        transport: http(RPC, { timeout: 12_000 }),
      });

      return {
        ready: true,
        publicClient,
        walletClient,
        account,
        house,
        usdcAbi,
        megapotAbi,
        PRECISE_UNIT,
        SOURCE,
        USDC,
        RANDOM_BUYER,
        JACKPOT,
        maxUint256,
        formatUnits,
        baseSepolia,
      };
    })().catch((e) => {
      depsPromise = null;
      throw e;
    });
  }
  return depsPromise;
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

  if (!process.env.HOUSE_PRIVATE_KEY) {
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

  const MAX_TICKETS = 40;
  if (tickets > MAX_TICKETS) tickets = MAX_TICKETS;

  const entryId = body.entryId != null ? String(body.entryId) : null;
  const REFERRER = '0x804BEb025844c189b72C8D810a1A7776043677FF';

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
        PRECISE_UNIT,
        SOURCE,
        USDC,
        RANDOM_BUYER,
        JACKPOT,
        maxUint256,
        formatUnits,
        baseSepolia,
      } = d;

      if (recipient.toLowerCase() === house.toLowerCase()) {
        const err = new Error('Recipient cannot be the house wallet — tickets must go to the player');
        err.statusCode = 400;
        throw err;
      }

      async function pendingNonce() {
        return publicClient.getTransactionCount({
          address: house,
          blockTag: 'pending',
        });
      }

      /** Send tx and wait for 1 confirmation — no extra artificial delay */
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
            timeout: 45_000,
            pollingInterval: 500,
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
          await sleep(300);
          nonce = await pendingNonce();
          return await attempt(nonce);
        }
      }

      // Ticket price: cache 60s on warm isolate
      let ticketPrice = 10000n; // Sepolia often $0.01
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
        } catch (_) {
          /* keep default */
        }
      }

      const houseBalBefore = await publicClient.readContract({
        address: USDC,
        abi: usdcAbi,
        functionName: 'balanceOf',
        args: [house],
      });

      const maxAffordable = Number(houseBalBefore / ticketPrice);
      if (maxAffordable < 1) {
        const err = new Error(
          `House USDC empty: have ${formatUnits(houseBalBefore, 6)} — cannot buy tickets`,
        );
        err.statusCode = 400;
        throw err;
      }
      if (tickets > maxAffordable) tickets = maxAffordable;

      const cost = ticketPrice * BigInt(tickets);

      // Fast approve: skip if we already max-approved this isolate, else check once
      if (!knownAllowanceOk) {
        let allowance = await publicClient.readContract({
          address: USDC,
          abi: usdcAbi,
          functionName: 'allowance',
          args: [house, RANDOM_BUYER],
        });
        if (allowance < cost) {
          if (allowance > 0n) {
            await sendAndWait({
              address: USDC,
              abi: usdcAbi,
              functionName: 'approve',
              args: [RANDOM_BUYER, 0n],
            });
          }
          await sendAndWait({
            address: USDC,
            abi: usdcAbi,
            functionName: 'approve',
            args: [RANDOM_BUYER, maxUint256],
          });
        }
        knownAllowanceOk = true;
      }

      // Buy in chunks of ≤10 (RandomBuyer limit). Sequential nonces, no extra sleep.
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

      // Receipt success = tickets bought. Do not block on balance re-reads.
      return {
        ok: true,
        txHash: buyTxs[buyTxs.length - 1],
        buyTxs,
        tickets,
        entryId: entryId || undefined,
        recipient,
        stake: Number.isFinite(stake) ? stake : undefined,
        multiplier: Number.isFinite(multiplier) ? multiplier : undefined,
        mode: 'randomBuyer_fast',
        spender: RANDOM_BUYER,
        cost: cost.toString(),
        ticketPrice: ticketPrice.toString(),
        ticketPriceUsdc: formatUnits(ticketPrice, 6),
        house,
        houseDebitedUsdc: formatUnits(cost, 6),
        debitConfirmed: true,
      };
    });

    return res.status(200).json(result);
  } catch (e) {
    console.error('cashout error', e?.shortMessage || e?.message || e);
    depsPromise = null; // reset clients on hard failure
    knownAllowanceOk = false;
    const status = e?.statusCode || 500;
    return res.status(status).json({
      ok: false,
      error: e?.shortMessage || e?.message || String(e),
      tickets,
    });
  }
};
