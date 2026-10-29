// Fixture tests for the Pump.fun Anchor event decoder. Layouts are pinned
// by constructing byte-exact synthetic events (discriminator = the Anchor
// spec sha256) and asserting the decoder reads them back — plus tolerance
// checks for the "newer layout appends fields" case.

import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import { decodeEventData, decodeLogs } from './.decoder.mjs';

function disc(name) {
  return createHash('sha256').update(`event:${name}`).digest().subarray(0, 8);
}

function str(s) {
  const b = Buffer.from(s, 'utf8');
  const len = Buffer.alloc(4);
  len.writeUInt32LE(b.length);
  return Buffer.concat([len, b]);
}

function u64(v) {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(BigInt(v));
  return b;
}

const PK_A = Buffer.alloc(32, 1);
const PK_B = Buffer.alloc(32, 2);
const PK_C = Buffer.alloc(32, 3);
const PK_D = Buffer.alloc(32, 4);

// ── CreateEvent: classic layout (name, symbol, uri, mint, curve, user) ──
{
  const payload = Buffer.concat([
    disc('CreateEvent'),
    str('Test Token'), str('TEST'), str('https://example.com/meta.json'),
    PK_A, PK_B, PK_C,
  ]);
  const ev = decodeEventData(payload.toString('base64'));
  assert.equal(ev.kind, 'create');
  assert.equal(ev.name, 'Test Token');
  assert.equal(ev.symbol, 'TEST');
  assert.equal(ev.creator, ev.user, 'classic layout: creator falls back to user');
  assert.equal(ev.virtualSolReserves, null);
  console.log('ok  create (classic layout)');
}

// ── CreateEvent: extended layout (creator + timestamp + reserves) ──
{
  const payload = Buffer.concat([
    disc('CreateEvent'),
    str('T2'), str('T2'), str('u'),
    PK_A, PK_B, PK_C,
    PK_D,                       // creator
    u64(1721234567),            // timestamp (i64, positive)
    u64(1073000000000000n),     // virtualTokenReserves
    u64(30000000000n),          // virtualSolReserves
    u64(0), u64(0),             // trailing fields the decoder must tolerate
  ]);
  const ev = decodeEventData(payload.toString('base64'));
  assert.equal(ev.kind, 'create');
  assert.notEqual(ev.creator, ev.user, 'extended layout: creator is its own field');
  assert.equal(ev.virtualSolReserves, 30000000000n);
  assert.equal(ev.isMayhem, null, 'a layout that stops before is_mayhem_mode is unknown, not standard');
  console.log('ok  create (extended layout)');
}

// ── PostCompleteBuyEvent (synthetic migration, 2026-10-24) ──
// The buy that empties a curve emits TradeEvent (curve part), CompleteEvent,
// then PostCompleteBuyEvent (pool part); the buyer's total is the sum. The
// discriminator is pinned to pump's published IDL, and the fold must give
// one trade with both parts, never a second trade or the curve part alone.
{
  assert.deepEqual([...disc('PostCompleteBuyEvent')], [111, 176, 109, 139, 49, 108, 213, 251], 'matches idl/pump.json');
  const WSOL = Buffer.from('069b8857feab8184fb687f634618c035dac439dc1aeb3b5598a0f00000000001', 'hex');
  const trade = (isBuy, user) =>
    Buffer.concat([disc('TradeEvent'), PK_A, u64(2_000_000_000n), u64(50_000_000_000n), Buffer.from([isBuy ? 1 : 0]), user, u64(1729700000), u64(115_000_000_000n), u64(280_000_000_000_000n)]);
  const post = (user, quote = WSOL) =>
    Buffer.concat([disc('PostCompleteBuyEvent'), user, PK_A, PK_C, quote, u64(1729700000), u64(7_000_000_000n), u64(300_000_000n), ...Array(9).fill(u64(1))]);
  const complete = Buffer.concat([disc('CompleteEvent'), PK_B, PK_A, PK_C, u64(1729700000), WSOL]);
  const lines = (...bufs) => bufs.map((b) => `Program data: ${b.toString('base64')}`);
  const evs = decodeLogs(lines(trade(true, PK_B), complete, post(PK_B)));
  const trades = evs.filter((e) => e.kind === 'trade');
  assert.equal(trades.length, 1, 'one buy, not two');
  assert.equal(trades[0].solAmount, 2_300_000_000n, 'curve part + pool part');
  assert.equal(trades[0].tokenAmount, 57_000_000_000n);
  assert.equal(trades[0].postComplete, true);
  assert.equal(trades[0].virtualSolReserves, 115_000_000_000n, 'the curve reserves stay the curve’s');
  assert.ok(!evs.some((e) => e.kind === 'postCompleteBuy'), 'nobody downstream sees the raw event');
  assert.ok(evs.some((e) => e.kind === 'complete'));
  // Another buyer's pool part, or one quoted in a pump coin, is not folded.
  assert.equal(decodeLogs(lines(trade(true, PK_B), post(PK_D))).find((e) => e.kind === 'trade').solAmount, 2_000_000_000n);
  assert.equal(decodeLogs(lines(trade(true, PK_B), post(PK_B, PK_D))).find((e) => e.kind === 'trade').solAmount, 2_000_000_000n);
  // A sell is never topped up by a buy's pool part.
  assert.equal(decodeLogs(lines(trade(false, PK_B), post(PK_B))).find((e) => e.kind === 'trade').solAmount, 2_000_000_000n);
  console.log('ok  a curve-completing buy is booked whole: TradeEvent + PostCompleteBuyEvent');
}

// ── CreateEvent: is_mayhem_mode, off two REAL mainnet creates (2026-09-24) ──
// Both curves started at exactly 30 virtual SOL, so the reserves-based guess
// this replaced called every coin standard — the runner flag's `mayhem` and
// the Execution page's mayhem filter never matched once. The byte after
// token_program is the flag; the curve's byte 81 agreed on both coins.
{
  const { readFileSync } = await import('node:fs');
  const fx = JSON.parse(readFileSync(new URL('./fixtures/create-mayhem.json', import.meta.url), 'utf8'));
  const may = decodeEventData(fx.mayhem.eventB64);
  const std = decodeEventData(fx.standard.eventB64);
  assert.equal(may.mint, fx.mayhem.mint);
  assert.equal(std.mint, fx.standard.mint);
  assert.equal(may.virtualSolReserves, std.virtualSolReserves, 'the reserves cannot tell them apart');
  assert.equal(may.isMayhem, true, 'CHIPS is a mayhem coin');
  assert.equal(std.isMayhem, false, 'FanFee is standard');

  // A byte that is neither 0 nor 1 is not trusted either way.
  // On the wire (09-24): 83 bytes follow token_total_supply — token_program
  // (32), then is_mayhem_mode (1), then fields the decoder does not read.
  const bad = Buffer.from(fx.standard.eventB64, 'base64');
  const at = bad.length - 83 + 32;
  assert.equal(bad[at], 0, 'the offset lands on the flag');
  bad[at] = 7;
  assert.equal(decodeEventData(bad.toString('base64')).isMayhem, null);

  // The engine reads the flag, never the reserves.
  const eng = readFileSync(new URL('../electron/engine/engine.ts', import.meta.url), 'utf8');
  assert.ok(!/mayhemFromReserves/.test(eng), 'the reserves-based guess is gone');
  assert.ok(/const isMayhem = ev\.isMayhem;/.test(eng) && /mayhem: t\.createEvent\.isMayhem,/.test(eng), 'filter and runner flag both use the decoded byte');
  console.log('ok  create: is_mayhem_mode decoded from real mayhem + standard creates');
}

// ── TradeEvent ──
{
  const payload = Buffer.concat([
    disc('TradeEvent'),
    PK_A,                       // mint
    u64(500000000n),            // solAmount (0.5 SOL)
    u64(15000000000000n),       // tokenAmount
    Buffer.from([1]),           // isBuy
    PK_B,                       // user
    u64(1721234567),            // timestamp
    u64(30500000000n),          // virtualSolReserves
    u64(1058000000000000n),     // virtualTokenReserves
    u64(1), u64(2),             // trailing (real reserves) — tolerated
  ]);
  const ev = decodeEventData(payload.toString('base64'));
  assert.equal(ev.kind, 'trade');
  assert.equal(ev.isBuy, true);
  assert.equal(ev.solAmount, 500000000n);
  assert.equal(ev.virtualSolReserves, 30500000000n);
  console.log('ok  trade');
}

// ── Robustness: garbage, unknown discriminator, truncated body ──
{
  assert.equal(decodeEventData('!!!not base64!!!'), null);
  assert.equal(decodeEventData(Buffer.alloc(4).toString('base64')), null);
  assert.equal(decodeEventData(Buffer.concat([disc('SomethingElse'), PK_A]).toString('base64')), null);
  const truncated = Buffer.concat([disc('TradeEvent'), PK_A, u64(1)]); // far too short
  assert.equal(decodeEventData(truncated.toString('base64')), null, 'truncated event decodes to null, not a crash');
  console.log('ok  robustness');
}

// ── decodeLogs extracts only Program data lines ──
{
  const payload = Buffer.concat([
    disc('CompleteEvent'), PK_A, PK_B, PK_C, u64(1721234567),
  ]);
  const events = decodeLogs([
    'Program 6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P invoke [1]',
    'Program log: Instruction: Buy',
    `Program data: ${payload.toString('base64')}`,
    'Program 6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P success',
  ]);
  assert.equal(events.length, 1);
  assert.equal(events[0].kind, 'complete');
  console.log('ok  decodeLogs');
}

// ── Real mainnet fixtures (harvested by test/harvest.fixtures.mjs) ──
// These pin the decoder against actual chain data. If Pump's event layout
// drifts, THIS is the test that goes red after a re-harvest.
{
  const { readFileSync, existsSync } = await import('node:fs');
  const path = new URL('./fixtures/live-logs.json', import.meta.url);
  if (existsSync(path)) {
    const { fixtures } = JSON.parse(readFileSync(path, 'utf8'));
    let events = 0;
    for (const fx of fixtures) {
      const decoded = decodeLogs(fx.logs);
      assert.ok(decoded.length > 0, `fixture ${fx.signature.slice(0, 12)}… must decode`);
      for (const kind of fx.expectKinds) {
        assert.ok(decoded.some((e) => e.kind === kind), `fixture ${fx.signature.slice(0, 12)}… missing ${kind}`);
      }
      for (const e of decoded) {
        if (e.kind === 'create') {
          assert.ok(e.mint.length >= 32 && e.symbol.length > 0);
        }
        if (e.kind === 'trade') {
          assert.equal(typeof e.solAmount, 'bigint');
          assert.ok(e.virtualSolReserves > 0n && e.virtualTokenReserves > 0n, 'reserves must be positive');
        }
      }
      events += decoded.length;
    }
    console.log(`ok  ${fixtures.length} real mainnet fixtures (${events} events)`);
  } else {
    console.log('..  no live fixtures yet (run test/harvest.fixtures.mjs)');
  }
}

// ── emit_cpi inner instruction, real block fixture (2026-08-30) ──
// The block feed hands the decoder the raw inner-instruction data:
// [8-byte Anchor CPI wrapper][8-byte event disc][body]. Same body as the
// log payload, so the two must agree field for field.
{
  const { decodeCpiEventData, decodeCpiEventDataEx, logsMentionPumpTrade, CPI_EVENT_WRAPPER } = await import('./.decoder.mjs');
  const { base58Decode } = await import('./.b58.mjs');
  const { readFileSync } = await import('node:fs');
  const fx = JSON.parse(readFileSync(new URL('./fixtures/block-cpi.json', import.meta.url), 'utf8')).pump.tx;
  assert.equal(CPI_EVENT_WRAPPER.toString('hex'), 'e445a52e51cb9a1d');
  const inner = fx.meta.innerInstructions.flatMap((g) => g.instructions).map((ix) => Buffer.from(base58Decode(ix.data)));
  const wrapped = inner.filter((d) => d.length >= 16 && d.subarray(0, 8).equals(CPI_EVENT_WRAPPER));
  assert.equal(wrapped.length, 1, 'the fixture carries one emit_cpi event');
  const ev = decodeCpiEventData(wrapped[0]);
  assert.ok(ev && ev.kind === 'trade', 'inner ix decodes to a trade');
  const fromLog = decodeLogs(fx.meta.logMessages).find((e) => e.kind === 'trade');
  assert.ok(fromLog, 'the same tx still logs the trade today (double emit)');
  for (const k of ['mint', 'solAmount', 'tokenAmount', 'isBuy', 'user', 'timestamp', 'virtualSolReserves', 'virtualTokenReserves', 'creator']) {
    assert.deepEqual(ev[k], fromLog[k], `cpi.${k} equals log.${k}`);
  }
  // Non-wrapper inner instructions (token transfers, the real Buy ix) are
  // null without being a layout error; a wrapper with a broken body IS one.
  for (const d of inner.filter((d) => !wrapped.includes(d))) {
    const r = decodeCpiEventDataEx(d);
    assert.equal(r.event, null);
    assert.equal(r.layoutError, false);
  }
  const broken = Buffer.concat([wrapped[0].subarray(0, 16), Buffer.alloc(10)]);
  assert.equal(decodeCpiEventDataEx(broken).layoutError, true, 'truncated TradeEvent body is drift');
  assert.equal(decodeCpiEventData(Buffer.alloc(8)), null);
  // Watchdog helper: the instruction line, exact match only.
  assert.equal(logsMentionPumpTrade(fx.meta.logMessages), true);
  assert.equal(logsMentionPumpTrade(['Program log: Instruction: Create']), false);
  assert.equal(logsMentionPumpTrade(['Program log: Instruction: Sell']), true);
  assert.equal(logsMentionPumpTrade([]), false);
  // The names pump shipped 10-07..13, counted on 10-23 (execution.md §4):
  // the watchdog must see them, or drift in two thirds of the feed is silent.
  const PUMP = '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P';
  const AMM = 'pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA';
  const inPump = (ix) => [`Program ${PUMP} invoke [1]`, `Program log: Instruction: ${ix}`, `Program ${PUMP} success`];
  for (const ix of ['SellV3', 'BuyExactQuoteInV3', 'BuyExactQuoteInV2', 'BuyExactSolIn', 'SellV2', 'BuyV2', 'BuyV3', 'Buy', 'Sell', 'BuyExactQuoteIn']) {
    assert.equal(logsMentionPumpTrade(inPump(ix)), true, ix);
  }
  for (const ix of ['Create', 'CreateV2', 'DistributeFeeToHolders', 'CloseUserVolumeAccumulator', 'Buyback', 'SellAll', 'BuyV']) {
    assert.equal(logsMentionPumpTrade(inPump(ix)), false, ix);
  }
  // PumpSwap logs the same words; only pump's own lines count.
  const ammBuy = [`Program ${AMM} invoke [1]`, 'Program log: Instruction: Buy', `Program ${AMM} success`];
  assert.equal(logsMentionPumpTrade(ammBuy), false, 'a PumpSwap Buy is not a pump trade');
  const nested = [`Program ${PUMP} invoke [1]`, 'Program log: Instruction: Migrate', `Program ${AMM} invoke [2]`, 'Program log: Instruction: Buy', `Program ${AMM} success`, `Program ${PUMP} success`];
  assert.equal(logsMentionPumpTrade(nested), false, 'a PumpSwap Buy inside a pump instruction is not one either');
  const afterAmm = [...ammBuy, ...inPump('SellV3')];
  assert.equal(logsMentionPumpTrade(afterAmm), true, 'scope returns to pump after PumpSwap finishes');
  console.log('ok  emit_cpi inner ix decodes to the same TradeEvent as the log (real fixture)');
  console.log('ok  the watchdog sees V2/V3/ExactIn trade lines, and only when pump logged them');
}

console.log('decoder tests passed');
