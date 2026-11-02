// LIVE check for pump.fun's coin trade tape and candles (2026-11-01).
//
//   npx esbuild electron/data/providers/pumpswap.ts --bundle --format=esm --platform=node --alias:@shared=./shared --outfile=test/.pumpswap.mjs
//   node test/pumptape.live.mjs [mint] [createdAtMs]
//
// NOT part of `npm test`: it reads frontend-api-v3.pump.fun. Read-only, a
// handful of keyless GETs, one every 2 s (the provider's pace in the app).
//
// What this proves that the simulated tape in launchintel.test.mjs cannot:
// that the route really treats `before` / `after` as slot bounds in the
// directions the provider assumes, and that priceAt / launchTrades land on
// real data in the number of calls the tests allow.

import assert from 'node:assert';
import { priceAt, launchTrades, recentTrades, _setPageSource, SOLANA_CHAIN_ID } from './.pumpswap.mjs';

const MINT = process.argv[2] ?? '8ANLUXihz9FrSy6Jbg85CGsuPCpPjf5S9ZUXNRG5pump';
const HOST = 'https://frontend-api-v3.pump.fun';
const GAP_MS = 2_000;

let last = 0;
let calls = 0;
async function get(path) {
  const wait = last + GAP_MS - Date.now();
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  last = Date.now();
  calls++;
  const t0 = Date.now();
  try {
    const res = await fetch(HOST + path, { headers: { accept: 'application/json', 'user-agent': 'KryptoMirror-livecheck' } });
    const text = await res.text();
    let data = null;
    try {
      data = JSON.parse(text);
    } catch {
      /* not JSON */
    }
    const ok = res.ok && data !== null;
    return { ok, data, status: res.status, ms: Date.now() - t0, message: ok ? 'ok' : `HTTP ${res.status}: ${text.slice(0, 160)}` };
  } catch (err) {
    return { ok: false, data: null, status: null, ms: Date.now() - t0, message: String(err) };
  }
}
_setPageSource(get);

const tape = (q) => get(`/trades/${encodeURIComponent(SOLANA_CHAIN_ID)}/${encodeURIComponent(MINT)}?${new URLSearchParams(q)}`);
const slots = (rows) => rows.map((r) => Number(r.blockId));
const show = (label, v) => console.log(`${label.padEnd(26)} ${v}`);

let failed = 0;
async function check(name, fn) {
  try {
    await fn();
    console.log(`ok   ${name}`);
  } catch (err) {
    failed++;
    console.log(`FAIL ${name}\n     ${err.message}`);
  }
}

console.log(`mint ${MINT}\n`);

let newest = [];
await check('newest page answers in the documented shape', async () => {
  const r = await tape({ limit: '20' });
  assert.ok(r.ok, r.message);
  newest = r.data.trades;
  assert.ok(Array.isArray(newest) && newest.length > 1, 'some trades');
  const s = slots(newest);
  assert.ok(s.every((x, i) => i === 0 || x <= s[i - 1]), 'newest first');
  for (const k of ['blockId', 'blockTimeMs', 'side', 'trader', 'baseAmount']) assert.ok(k in newest[0], `row has ${k}`);
  show('newest', `slot ${newest[0].blockId} at ${new Date(newest[0].blockTimeMs).toISOString()}, venue ${newest[0].venue}`);
  show('cursor', r.data.cursor ? 'present' : 'none');
});

const pivot = newest.length > 4 ? newest[Math.floor(newest.length / 2)] : null;
if (pivot) {
  const S = Number(pivot.blockId);
  await check('`before` returns slots below the key, newest first', async () => {
    const r = await tape({ limit: '5', before: `${S}-0-0-${pivot.blockTimeMs}` });
    assert.ok(r.ok, r.message);
    const s = slots(r.data.trades);
    show('before rows', s.join(', ') || '(none)');
    assert.ok(s.length > 0, 'rows below a slot the coin traded around');
    assert.ok(s.every((x) => x < S), `every slot < ${S}`);
    assert.ok(s.every((x, i) => i === 0 || x <= s[i - 1]), 'newest first');
  });
  await check('`after` returns slots from the key, oldest first', async () => {
    const r = await tape({ limit: '5', after: `${S}-0-0-${pivot.blockTimeMs}` });
    assert.ok(r.ok, r.message);
    const s = slots(r.data.trades);
    show('after rows', s.join(', ') || '(none)');
    assert.ok(s.length > 0, 'rows from a slot the coin traded around');
    assert.ok(s.every((x) => x >= S), `every slot >= ${S}`);
    assert.ok(s.every((x, i) => i === 0 || x >= s[i - 1]), 'oldest first');
  });
  await check('`after` with a slot far before the coin reads its first trades', async () => {
    const r = await tape({ limit: '3', after: '1-0-0-0' });
    assert.ok(r.ok, r.message);
    show('from slot 1', slots(r.data.trades).join(', ') || '(none)');
    assert.ok(r.data.trades.length > 0, 'a key long before the coin still reads forward');
  });
}

if (newest.length) {
  const atMs = newest[newest.length - 1].blockTimeMs - 3_600_000;
  await check('priceAt an hour before the oldest newest-page trade', async () => {
    const before = calls;
    const p = await priceAt(MINT, atMs);
    show('priceAt', JSON.stringify(p));
    show('priceAt calls', calls - before);
    assert.ok(calls - before <= 4, 'within PRICE_CALLS');
    if (p.price !== null) assert.ok(p.at <= atMs, 'the trade is at or before the moment');
    else assert.equal(p.failed, false, p.message);
  });
  await check('recentTrades over the last hour', async () => {
    const r = await recentTrades(MINT, Date.now() - 3_600_000, 2);
    show('recent', `${r.trades.length} trades, ${r.calls} calls, complete ${r.complete}, ${r.message}`);
    assert.ok(r.ok, r.message);
  });
}

const createdAt = Number(process.argv[3]);
if (Number.isFinite(createdAt) && createdAt > 0) {
  await check('launchTrades from the creation time', async () => {
    const s = await launchTrades(MINT, createdAt);
    show('launch', `${s.trades.length} trades, ${s.calls} calls, complete ${s.complete}, ${s.message}`);
    if (s.trades.length) show('first trade', `slot ${s.trades[0].slot} at ${new Date(s.trades[0].ts).toISOString()} by ${s.trades[0].user}`);
  });
} else {
  console.log('(skipping the launch read — pass the coin\'s creation time in ms as the second argument)');
}

await check('candles route answers', async () => {
  const r = await get(`/candles/${encodeURIComponent(SOLANA_CHAIN_ID)}/${encodeURIComponent(MINT)}?${new URLSearchParams({ res: '1m', count: '5', measure: 'price_usd' })}`);
  assert.ok(r.ok, r.message);
  assert.ok(Array.isArray(r.data.candles), 'a candles array');
  show('candles', `${r.data.candles.length} bars; first ${JSON.stringify(r.data.candles[0] ?? null).slice(0, 160)}`);
});

console.log(`\n${calls} requests; ${failed ? `${failed} FAILED` : 'all checks passed'}`);
process.exitCode = failed ? 1 : 0;
