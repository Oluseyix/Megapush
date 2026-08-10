/**
 * Safe public smoke checks (no admin probes, no house execution).
 *
 *   BASE=https://your-deployment.example npm run test:acceptance
 */
const BASE = (process.env.BASE || '').replace(/\/$/, '');
if (!BASE) {
  console.error('Set BASE to your deployment origin, e.g. BASE=https://… npm run test:acceptance');
  process.exit(2);
}

let failed = 0;
function ok(name, cond, detail = '') {
  if (cond) console.log(`  ✓ ${name}${detail ? ' — ' + detail : ''}`);
  else {
    failed++;
    console.error(`  ✗ ${name}${detail ? ' — ' + detail : ''}`);
  }
}

async function jget(path) {
  const r = await fetch(BASE + path, { cache: 'no-store' });
  let body;
  try {
    body = JSON.parse(await r.text());
  } catch {
    body = {};
  }
  return { status: r.status, body };
}

console.log(`Smoke @ ${BASE}\n`);

{
  console.log('1. Ping');
  const { status, body } = await jget('/api/ping');
  ok('up', status === 200 && body.ok === true);
  ok('no binding leak', body.bindings == null && body.platform == null);
}

{
  console.log('\n2. Health');
  const { status, body } = await jget('/api/health');
  ok('responds', status === 200 || status === 503);
  ok('no key leak', body.hasHousePrivateKey == null && body.house == null && body.houseUsdc == null);
  ok('no bindings leak', body.bindings == null);
}

{
  console.log('\n3. Round');
  const { status, body } = await jget('/api/round');
  ok('ok', status === 200 && body.ok);
  ok('phase', typeof body.phase === 'string');
  ok('commit present while live', body.serverSeedHash != null || body.phase === 'intermission');
  ok('no admin surface', body.roundDo == null);
}

{
  console.log('\n4. Verify docs route');
  const { status, body } = await jget('/api/verify');
  ok('ok', status === 200 && body.ok);
}

{
  console.log('\n5. Removed admin probe');
  const { status } = await jget('/api/do');
  ok('/api/do gone', status === 404);
}

{
  console.log('\n6. Game asset');
  const r = await fetch(BASE + '/game.html', { redirect: 'follow' });
  ok('game.html', r.status === 200);
}

console.log(failed ? `\nFAILED ${failed}` : '\nOK');
process.exit(failed ? 1 : 0);
