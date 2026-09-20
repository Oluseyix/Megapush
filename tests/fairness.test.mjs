import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { RoundDO } from '../cf-worker/dos/round-do.js';
import { handleCashout } from '../cf-worker/cashout.js';
import {
  elapsedForMult, settlementFromIntent, sha256Hex, verifyRound,
} from '../cf-worker/crash-curve.js';
import {
  createSeedChain, consumeNextSeed, ensureChainReady, loadOrCreateChain,
  verifySeedUnderHead, CHAIN_KEY,
} from '../cf-worker/seed-chain.js';

const PLAYER = '0x1111111111111111111111111111111111111111';
const OTHER = '0x2222222222222222222222222222222222222222';
const ENTRY = `${PLAYER}-test-entry`;
const START = 1_700_000_000_000;
const originalNow = Date.now;
const originalFetch = globalThis.fetch;
const originalCaches = globalThis.caches;
let clock;

beforeEach(() => {
  clock = START + 1000;
  Date.now = () => clock;
  globalThis.fetch = async () => { throw new Error('Unexpected network access in offline test'); };
  const cached = new Map();
  globalThis.caches = { default: {
    match: async (req) => cached.get(req.url)?.clone(),
    put: async (req, res) => cached.set(req.url, res.clone()),
  } };
});
afterEach(() => {
  Date.now = originalNow;
  globalThis.fetch = originalFetch;
  globalThis.caches = originalCaches;
});

function memory(initial = {}) {
  const data = new Map(Object.entries(initial));
  return {
    data,
    get: async (key) => structuredClone(data.get(key)),
    put: async (key, value) => { data.set(key, structuredClone(value)); },
    setAlarm: async () => {},
  };
}

function fixture({ autoMult = null, status = 'open', hand: extraHand = {}, row: extraRow = {} } = {}) {
  const hand = {
    roundId: 1, seq: 1, phase: 'flying', windowClosed: true,
    unconfigured: false, voided: false, handStart: START - 6000,
    bettingEndsAt: START - 1000, flyStart: START,
    crashAt: START + elapsedForMult(5), crashMult: 5,
    resultEnd: START + elapsedForMult(5) + 2800,
    serverSeed: 'a'.repeat(64), serverSeedHash: 'b'.repeat(64),
    blockHash: '0x' + 'c'.repeat(64), targetBlock: 10,
    exposureUsdc: 50, stakeCount: 1,
    ...extraHand,
  };
  const row = {
    entryId: ENTRY, player: PLAYER, stakeUsdc: 1, status,
    roundId: 1, at: START - 2000, exposureAdd: 50, autoMult,
    ...extraRow,
  };
  const storage = memory({ hand, entries: { [ENTRY]: row }, seq: 1, history: [], kill: false });
  const tasks = [];
  const state = { storage, waitUntil: (p) => tasks.push(p) };
  const kv = new Map();
  const purchases = [];
  const env = {
    ROUND_SECRET: 'offline-fairness-fixture',
    BANK_KV: {
      get: async (key, opts) => opts?.type === 'json' ? JSON.parse(kv.get(key) || 'null') : kv.get(key),
      put: async (key, value) => kv.set(key, value),
    },
    TX_SEQUENCER_DO: {
      idFromName: () => 'house',
      get: () => ({ fetch: async (_url, init) => {
        const job = JSON.parse(init.body);
        purchases.push(job);
        return Response.json({ ok: true, result: { ok: true, tickets: job.payload.tickets, txHash: 'offline-tx' } });
      } }),
    },
  };
  let round = new RoundDO(state, env);
  env.ROUND_DO = {
    idFromName: () => 'global',
    get: () => ({ fetch: (url, init) => round.fetch(new Request(url, init)) }),
  };
  return {
    env, hand, storage, purchases,
    get round() { return round; },
    restart() { round = new RoundDO(state, env); },
    async flush() { for (let i = 0; i < tasks.length; i++) await tasks[i]; },
    async settle(body = {}) {
      const res = await round.settlementAt(new Request('https://offline.invalid/settlement', {
        method: 'POST', body: JSON.stringify({ entryId: ENTRY, recipient: PLAYER, roundId: 1, arrivalMs: clock, ...body }),
      }));
      return res.json();
    },
    async cashout(body = {}) {
      const res = await handleCashout(new Request('https://offline.invalid/api/cashout', {
        method: 'POST', body: JSON.stringify({ entryId: ENTRY, recipient: PLAYER, roundId: 1, sync: true, ...body }),
      }), env, { waitUntil: (p) => tasks.push(p) });
      return { status: res.status, body: await res.json() };
    },
  };
}

function noSecrets(value) {
  for (const [key, item] of Object.entries(value || {})) {
    assert.ok(!['serverSeed', 'crashMult', 'crashAt', 'blockHash', 'terminal', 'resultEnd'].includes(key), key);
    if (item && typeof item === 'object') noSecrets(item);
  }
}

test('invalid cashout cannot reveal a live crash point, with or without an entry', async () => {
  const f = fixture();
  for (const body of [{ claimedMult: 0.5 }, { claimedMult: 0.5, entryId: null }]) {
    const res = await f.cashout(body);
    assert.equal(res.status, 400);
    noSecrets(res.body);
  }
  assert.equal(f.purchases.length, 0);
  assert.equal((await f.storage.get('entries'))[ENTRY].status, 'open');
});

test('cashout payout comes from server time and registered stake, not request claims', async () => {
  const f = fixture();
  const res = await f.cashout({ stake: 50000, claimedMult: 9000, clientCashoutAt: START + 8000 });
  assert.equal(res.body.ok, true);
  assert.equal(res.body.stake, 1);
  assert.equal(res.body.multiplier, 1.2);
  assert.equal(res.body.cashoutTickets, 1);
  assert.equal(f.purchases.length, 1);
  noSecrets(res.body);
});

test('new manual cashout at or after the crash always loses, despite backdating', async () => {
  for (const delay of [0, 1, 500, 5999, 7000]) {
    const f = fixture();
    clock = Math.ceil(f.hand.crashAt) + delay;
    const res = await f.cashout({ claimedMult: 4.99, clientCashoutAt: START + 1000, arrivalMs: START + 1000, auto: true });
    assert.equal(res.body.lost, true);
    assert.equal(f.purchases.length, 0);
    noSecrets(res.body);
  }
});

test('invalid numeric claims and preflight requests do not produce winning settlements', () => {
  const timing = { flyStart: START, crashAt: START + 10000, crashMult: 6 };
  for (const claimedMult of [0, -1, 0.5, NaN, Infinity, 'bad']) {
    assert.equal(settlementFromIntent(timing, { arrivalMs: START + 1000, claimedMult }).ok, false);
  }
  assert.equal(settlementFromIntent(timing, { arrivalMs: START - 1 }).ok, false);
  assert.equal(settlementFromIntent(timing, { arrivalMs: NaN }).ok, false);
  assert.equal(settlementFromIntent(timing, { arrivalMs: START + 10000 }).lost, true);
});

test('cashout requires the recorded player, entry and round', async () => {
  const f = fixture();
  for (const body of [{ recipient: OTHER }, { entryId: 'unknown' }, { roundId: 2 }, { roundId: null }]) {
    const res = await f.cashout(body);
    assert.equal(res.body.ok, false);
    noSecrets(res.body);
  }
  assert.equal(f.purchases.length, 0);
});

test('released and refunded entries cannot win', async () => {
  for (const status of ['released', 'refunded']) {
    const f = fixture({ status });
    assert.equal((await f.cashout()).body.ok, false);
    assert.equal(f.purchases.length, 0);
  }
});

test('receipt survives restart, crash and changed request claims', async () => {
  const f = fixture();
  const first = await f.settle();
  assert.equal(first.mult, 1.2);
  clock = Math.ceil(f.hand.crashAt) + 10000;
  f.restart();
  const retry = await f.settle({ claimedMult: 4.99 });
  assert.deepEqual(retry, { ...first, replay: true });
  noSecrets(retry);
});

test('concurrent cashouts and later retries mint a registered win once', async () => {
  const f = fixture();
  const responses = await Promise.all(Array.from({ length: 8 }, () => f.cashout()));
  assert.ok(responses.every((r) => r.body.ok));
  assert.equal(f.purchases.length, 1);
  clock = Math.ceil(f.hand.crashAt) + 1000;
  f.restart();
  const retry = await f.cashout();
  assert.equal(retry.body.already, true);
  assert.equal(retry.body.multiplier, 1.2);
  assert.equal(f.purchases.length, 1);
});

test('server receipt preserves a pre-crash arrival through processing delay', async () => {
  const f = fixture();
  const acceptedAt = clock;
  clock = Math.ceil(f.hand.crashAt) + 2000;
  const res = await f.settle({ arrivalMs: acceptedAt });
  assert.equal(res.lost, false);
  assert.equal(res.mult, 1.2);
});

test('auto-cashout settles its stored target after crash even when alarm is late', async () => {
  const f = fixture({ autoMult: 2 });
  clock = Math.ceil(f.hand.crashAt) + 1000;
  const res = await f.settle({ auto: true, claimedMult: 4.99 });
  assert.equal(res.lost, false);
  assert.equal(res.mult, 2);
  assert.equal(res.mode, 'auto');
});

test('manual cashout after its auto target receives only the stored auto target', async () => {
  const f = fixture({ autoMult: 2 });
  clock = START + 7000;
  const res = await f.cashout({ claimedMult: 3 });
  assert.equal(res.body.multiplier, 2);
});

test('auto target at crash, above crash, or registered late cannot win', async () => {
  for (const options of [{ autoMult: 5 }, { autoMult: 6 }, { autoMult: 2, row: { at: START + 1 } }]) {
    const f = fixture(options);
    clock = Math.ceil(f.hand.crashAt) + 1000;
    assert.equal((await f.settle({ auto: true })).ok, false);
  }
});

test('late alarm processes only eligible entries of the matching archived round', async () => {
  const f = fixture({ autoMult: 2 });
  await f.storage.put('history', [{ ...f.hand, phase: 'crashed' }]);
  await f.storage.put('hand', { roundId: 2, phase: 'betting' });
  clock = Math.ceil(f.hand.crashAt) + 5000;
  await f.round.processAutoBanks(clock);
  await f.flush();
  assert.equal(f.purchases.length, 1);
  const row = (await f.storage.get('entries'))[ENTRY];
  assert.equal(row.status, 'settled');
  assert.equal(row.cashout.roundId, 1);
  assert.equal(row.cashout.mult, 2);
});

test('failure to persist settlement stops ticket purchases', async () => {
  const f = fixture();
  f.round.settleEntry = async () => Response.json({ ok: false });
  assert.equal((await f.cashout()).status, 503);
  assert.equal(f.purchases.length, 0);
});

test('public live fields hide outcome until reveal in every active phase', () => {
  const f = fixture();
  for (const phase of ['betting', 'waiting', 'flying']) {
    const out = f.round.publicFields({ ...f.hand, phase }, clock);
    for (const key of ['serverSeed', 'crashMult', 'crashAt', 'blockHash', 'resultEnd']) {
      assert.equal(out[key], null, `${phase}.${key}`);
    }
  }
  assert.equal(f.round.publicFields({ ...f.hand, phase: 'crashed' }, clock).serverSeed, f.hand.serverSeed);
});

test('first playable seed is secret, hashes to head, and passes existing verifier', async () => {
  const chain = await createSeedChain({ SEED_CHAIN_LENGTH: 8 });
  chain.anchorTxHash = 'offline-anchor';
  const storage = memory();
  const first = await consumeNextSeed(storage, chain);
  assert.equal(first.chainIndex, 1);
  assert.notEqual(first.serverSeed, chain.head);
  assert.equal(await sha256Hex(first.serverSeed), chain.head);
  assert.equal(await verifySeedUnderHead(first.serverSeed, 1, chain.head), true);
  const verified = await verifyRound({ serverSeed: first.serverSeed, serverSeedHash: chain.head,
    chainHead: chain.head, chainIndex: 1, chainPrevSeed: first.prevSeed });
  assert.equal(verified.chainOk, true);
  const next = await consumeNextSeed(storage, chain);
  assert.equal(await sha256Hex(next.serverSeed), first.serverSeed);
});

test('legacy unused head is skipped without changing its anchor or terminal', async () => {
  const chain = await createSeedChain({ SEED_CHAIN_LENGTH: 8 });
  chain.nextIndex = 0;
  chain.anchorTxHash = 'existing-anchor';
  const storage = memory({ [CHAIN_KEY]: chain });
  const loaded = await loadOrCreateChain(storage, {});
  assert.equal(loaded.nextIndex, 1);
  assert.equal(loaded.head, chain.head);
  assert.equal(loaded.terminal, chain.terminal);
  assert.equal(loaded.anchorTxHash, chain.anchorTxHash);
});

test('anchor failure prevents opening or consuming a round', async () => {
  const chain = await createSeedChain({ SEED_CHAIN_LENGTH: 8 });
  const storage = memory({ [CHAIN_KEY]: chain });
  const ready = await ensureChainReady(storage, {});
  assert.equal(ready.ok, false);
  assert.equal((await storage.get(CHAIN_KEY)).nextIndex, 1);
  await assert.rejects(consumeNextSeed(storage, ready.chain), /anchored/);
  const f = fixture();
  await f.storage.put(CHAIN_KEY, chain);
  const hand = await f.round.openNewHand(clock, {});
  assert.equal(hand.acceptingBets, false);
  assert.equal(hand.serverSeed, null);
});

test('exhaustion does not replace the chain or silently change its commitment', async () => {
  const chain = await createSeedChain({ SEED_CHAIN_LENGTH: 8 });
  chain.nextIndex = chain.length;
  chain.anchorTxHash = 'existing-anchor';
  const storage = memory({ [CHAIN_KEY]: chain });
  assert.equal((await ensureChainReady(storage, {})).ok, false);
  assert.deepEqual(await storage.get(CHAIN_KEY), chain);
});

test('direct consumption refuses the public head even on an anchored chain', async () => {
  const chain = await createSeedChain({ SEED_CHAIN_LENGTH: 8 });
  chain.anchorTxHash = 'existing-anchor';
  chain.nextIndex = 0;
  await assert.rejects(consumeNextSeed(memory(), chain), /Public chain head/);
});

test('concurrent stake registration enforces the cumulative exposure cap', async () => {
  const f = fixture({ hand: { phase: 'betting', windowClosed: false, bettingEndsAt: clock + 5000,
    flyStart: null, crashAt: null, crashMult: null, resultEnd: null } });
  await f.storage.put('entries', {});
  f.env.MAX_ROUND_EXPOSURE = '50';
  const responses = await Promise.all(['a', 'b'].map((id) => f.round.recordStake(new Request('https://offline.invalid/stake', {
    method: 'POST', body: JSON.stringify({ player: PLAYER, entryId: PLAYER + id, stakeUsdc: 1, autoMult: 2 }),
  })).then((r) => r.json())));
  assert.equal(responses.filter((r) => r.ok).length, 1);
  assert.equal((await f.storage.get('hand')).exposureUsdc, 50);
});

test('registering the same entry cannot change a precommitted auto target', async () => {
  const f = fixture({ autoMult: 2, hand: { phase: 'betting', windowClosed: false, bettingEndsAt: clock + 5000,
    flyStart: null, crashAt: null, crashMult: null, resultEnd: null } });
  const res = await f.round.recordStake(new Request('https://offline.invalid/stake', {
    method: 'POST', body: JSON.stringify({ player: PLAYER, entryId: ENTRY, stakeUsdc: 1, autoMult: 4 }),
  }));
  assert.equal((await res.json()).already, true);
  assert.equal((await f.storage.get('entries'))[ENTRY].autoMult, 2);
});

function rpcBlock(timestamp) {
  globalThis.fetch = async (_url, init) => {
    const req = JSON.parse(init.body);
    const result = req.method === 'eth_blockNumber' ? '0xa' : {
      number: '0xa', hash: '0x' + 'd'.repeat(64), timestamp: '0x' + timestamp.toString(16),
      transactions: [],
    };
    return Response.json({ jsonrpc: '2.0', id: req.id, result });
  };
}

test('block already timestamped by betting close causes a void, never a new target', async () => {
  const f = fixture();
  const hand = { ...f.hand, phase: 'waiting', blockHash: null, crashMult: null, crashAt: null, flyStart: null };
  rpcBlock(Math.floor(hand.bettingEndsAt / 1000));
  const resolved = await f.round.tryResolveEntropy(hand, clock);
  assert.equal(resolved.voided, true);
  assert.equal(resolved.hand.voidReason, 'target_block_not_after_betting');
  assert.equal(resolved.hand.targetBlock, 10);
});

test('future block resolves the committed seed without changing its target', async () => {
  const f = fixture();
  const hand = { ...f.hand, phase: 'waiting', blockHash: null, crashMult: null, crashAt: null, flyStart: null };
  rpcBlock(Math.floor(clock / 1000));
  const resolved = await f.round.tryResolveEntropy(hand, clock);
  assert.equal(resolved.voided, false);
  assert.equal(resolved.hand.phase, 'flying');
  assert.equal(resolved.hand.targetBlock, 10);
  assert.equal(resolved.hand.serverSeed, f.hand.serverSeed);
});

test('void refunds finish while holding the round queue and do not double-credit', { timeout: 2000 }, async () => {
  const f = fixture();
  f.hand.voidReason = 'target_block_not_after_betting';
  const entries = await f.storage.get('entries');
  await f.round._serialize(() => f.round.voidAndRefund(f.hand, entries, clock));
  await f.round._serialize(() => f.round.voidAndRefund(f.hand, entries, clock));
  const bank = await f.env.BANK_KV.get('bank:v2:' + PLAYER, { type: 'json' });
  assert.equal(bank.deposited, 1);
  assert.equal(entries[ENTRY].status, 'refunded');
});

test('a slow upload cannot reserve a pre-crash cashout timestamp', async () => {
  const f = fixture();
  const request = new Request('https://offline.invalid/api/cashout', { method: 'POST', body: '{}' });
  request.json = async () => {
    clock = Math.ceil(f.hand.crashAt) + 500;
    return { entryId: ENTRY, recipient: PLAYER, roundId: 1, claimedMult: 4.99 };
  };
  const res = await handleCashout(request, f.env, {});
  assert.equal((await res.json()).lost, true);
  assert.equal(f.purchases.length, 0);
});

test('verifier refuses unbounded, negative or fractional chain indices', async () => {
  for (const chainIndex of [Infinity, -1, 2.5, 50001]) {
    const result = await verifyRound({ serverSeed: 'a'.repeat(64), chainIndex, chainHead: 'b'.repeat(64) });
    assert.equal(result.chainOk, false);
    assert.equal(result.ok, false);
  }
});

test('verifier cannot approve a claimed winning payout after the crash', async () => {
  const result = await verifyRound({ serverSeed: 'a'.repeat(64), flyStart: START,
    cashoutAt: START + 60000, expectedSettlementMult: 1.5 });
  assert.equal(result.settlementOk, false);
  assert.equal(result.ok, false);
});
