// The AI desk (2026-10-28): the rules a verdict must fit, and the broker the
// copy engine asks — offline and not-allowed answer at once, a poll wakes on
// the first event, a verdict resolves the ask, the deadline falls back.

import assert from 'node:assert';
import {
  AI_WAIT_MAX_SEC,
  DEFAULT_AI_GATE,
  accessDecides,
  aiGateLine,
  aiStarterPrompt,
  checkVerdict,
  exitAsks,
  validateAiGate,
} from './.aideskshared.mjs';
import * as desk from './.aidesk.mjs';

let passed = 0;
const ok = (name) => {
  passed += 1;
  console.log(`  ok   ${name}`);
};

const entry = (over = {}) => ({
  id: 'ai_1',
  kind: 'entry',
  configId: 'cfg1',
  follow: 'Sharky',
  mode: 'paper',
  chain: 'solana',
  wallet: 'W',
  mint: 'M',
  symbol: 'COPY',
  askedAt: Date.now(),
  deadline: Date.now() + 200,
  leaderSide: 'buy',
  leaderSol: 1,
  leaderPriceSol: 0.001,
  leaderAt: Date.now(),
  sizeSol: 0.05,
  direction: 'copy',
  facts: { liquidityUsd: null, marketCapUsd: null, kryptScore: null, isPumpfun: null, ageSec: null },
  ...over,
});
const exitReq = (over = {}) => ({ ...entry(), kind: 'exit', rule: 'takeProfit', why: 'take-profit +50%', sellPct: 100, positionSol: 0.05, entryPriceSol: 0.001, priceSol: 0.002, movePct: 100, heldSec: 60, ...over });

{
  // Verdicts can only narrow what the follow would do.
  assert.deepEqual(checkVerdict(entry(), { verdict: 'skip', reason: 'thin' }), { ok: true, verdict: { verdict: 'skip', reason: 'thin' } });
  assert.deepEqual(checkVerdict(entry(), { verdict: 'buy', sizeSol: 0.02, reason: 'half' }).verdict, { verdict: 'buy', sizeSol: 0.02, reason: 'half' });
  assert.match(checkVerdict(entry(), { verdict: 'buy', sizeSol: 0.06, reason: 'more' }).message, /can only shrink the copy: at most 0.05/);
  assert.match(checkVerdict(entry(), { verdict: 'sell', reason: 'x' }).message, /"buy" or "skip"/);
  assert.match(checkVerdict(entry(), { verdict: 'buy', reason: '  ' }).message, /reason/);
  assert.match(checkVerdict(entry(), { verdict: 'buy', percent: 50, reason: 'x' }).message, /percent is for exits/);
  assert.deepEqual(checkVerdict(exitReq(), { verdict: 'sell', percent: 40, reason: 'trim' }).verdict, { verdict: 'sell', percent: 40, reason: 'trim' });
  assert.equal(checkVerdict(exitReq(), { verdict: 'hold', percent: 40, reason: 'x' }).ok, false, 'percent goes with sell');
  assert.equal(checkVerdict(exitReq(), { verdict: 'buy', reason: 'x' }).ok, false);
  assert.equal(checkVerdict(exitReq(), { verdict: 'sell', percent: 0, reason: 'x' }).ok, false);
  assert.equal(checkVerdict(entry(), { verdict: 'buy', reason: 'x'.repeat(500) }).verdict.reason.length, 300, 'the reason is capped');
  ok('a verdict can skip, shrink, hold or sell less — never buy more — and always says why');
}

{
  // Who may decide, and which exits ask.
  assert.equal(accessDecides('read', 'paper'), false);
  assert.equal(accessDecides('paper', 'paper'), true);
  assert.equal(accessDecides('paper', 'live'), false, 'approving a live buy is spending');
  assert.equal(accessDecides('live', 'live'), true);
  const g = { ...DEFAULT_AI_GATE, exits: true };
  assert.equal(exitAsks(g, 'takeProfit'), true);
  assert.equal(exitAsks(g, 'leader'), true);
  assert.equal(exitAsks(g, 'stopLoss'), false, 'protective exits do not wait');
  assert.equal(exitAsks(g, 'trailing'), false);
  assert.equal(exitAsks(g, 'creatorSell'), false);
  assert.equal(exitAsks({ ...g, protectiveWait: true }, 'stopLoss'), true);
  assert.equal(exitAsks(g, 'resume'), false, 'an exit already decided is never asked twice');
  assert.equal(exitAsks({ ...g, exits: false }, 'takeProfit'), false);
  assert.equal(exitAsks(null, 'takeProfit'), false);
  assert.equal(validateAiGate(null).ok, true);
  assert.equal(validateAiGate(DEFAULT_AI_GATE).ok, true);
  assert.equal(validateAiGate({ ...DEFAULT_AI_GATE, waitSec: AI_WAIT_MAX_SEC + 1 }).ok, false);
  assert.equal(validateAiGate({ ...DEFAULT_AI_GATE, onTimeout: 'x' }).ok, false);
  assert.equal(aiGateLine(null), null);
  assert.equal(aiGateLine({ ...DEFAULT_AI_GATE, exits: true }), 'Your AI decides each buy and sell within 15 s — no answer skips the buy; stop-loss, trailing and creator-sell exits do not wait.');
  assert.match(aiStarterPrompt('krypto-mirror'), /wait_for_events/);
  assert.match(aiStarterPrompt('krypto-mirror'), /decide_trade/);
  ok('paper follows need a paper connection and live ones a live one; stop-losses do not wait unless asked');
}

let access = 'paper';
desk.attach({ access: () => access, gated: () => [] });

{
  desk._reset();
  // Nobody polling: answered at once, never waited on.
  const t0 = Date.now();
  const a = await desk.ask(entry({ id: desk.newId() }));
  assert.equal(a.by, 'none');
  assert.equal(a.why, 'no AI is connected');
  assert.ok(Date.now() - t0 < 50);
  // Not allowed: a paper connection and a live follow.
  const p = desk.poll(null, 0);
  await p;
  const b = await desk.ask(entry({ id: desk.newId(), mode: 'live' }));
  assert.equal(b.why, 'the AI connection is on paper and this follow is live');
  access = 'read';
  assert.equal((await desk.ask(entry({ id: desk.newId() }))).why, 'the AI connection is read only');
  access = 'paper';
  const s = desk.status();
  assert.deepEqual(
    s.log.map((l) => l.outcome),
    ['not allowed', 'not allowed', 'offline'],
  );
  ok('with no AI listening, or one not allowed, the answer is immediate and logged');
}

{
  desk._reset();
  // A poll in progress makes the AI online; the decision wakes it.
  const polling = desk.poll(null, 2_000);
  const req = entry({ id: desk.newId(), askedAt: Date.now(), deadline: Date.now() + 2_000 });
  const asking = desk.ask(req);
  const got = await polling;
  assert.equal(got.events.length, 1);
  assert.equal(got.events[0].kind, 'decision');
  assert.equal(got.events[0].data.request.id, req.id);
  assert.equal(got.pending.length, 1);
  assert.equal(desk.status().online, true);
  // A bad verdict is refused and the request stays open.
  assert.match(desk.decide(req.id, { verdict: 'buy', sizeSol: 1, reason: 'big' }).message, /only shrink/);
  assert.equal(desk.pendingList().length, 1);
  const r = desk.decide(req.id, { verdict: 'buy', sizeSol: 0.01, reason: 'small' });
  assert.equal(r.ok, true);
  const a = await asking;
  assert.equal(a.by, 'ai');
  assert.deepEqual(a.verdict, { verdict: 'buy', sizeSol: 0.01, reason: 'small' });
  assert.equal(desk.pendingList().length, 0);
  assert.match(desk.decide(req.id, { verdict: 'skip', reason: 'late' }).message, /No pending decision/);
  desk.settled(req, a, 'approved — copying 0.01');
  assert.equal(desk.status().log[0].result, 'approved — copying 0.01');
  assert.equal(desk.status().answered, 1);
  // The next poll from the cursor sees the verdict, not the request again.
  const next = await desk.poll(got.cursor, 0);
  assert.deepEqual(next.events.map((e) => e.kind), ['decided']);
  ok('a poll wakes on the decision, a bad verdict is refused, a good one resolves the ask once');
}

{
  desk._reset();
  await desk.poll(null, 0);
  const req = entry({ id: desk.newId(), askedAt: Date.now(), deadline: Date.now() + 80 });
  const a = await desk.ask(req);
  assert.equal(a.by, 'none');
  assert.match(a.why, /did not answer in 0 s/);
  assert.equal(desk.status().timedOut, 1);
  assert.equal(desk.status().log[0].outcome, 'timeout');
  // Withdrawn.
  const r2 = entry({ id: desk.newId(), askedAt: Date.now(), deadline: Date.now() + 5_000 });
  const asking = desk.ask(r2);
  desk.cancel(r2.id, 'they sold first');
  assert.equal((await asking).why, 'cancelled — they sold first');
  ok('the deadline falls back, and a withdrawn request resolves as cancelled');
}

{
  desk._reset();
  // The feed: a cursor, kinds, and missed events said rather than hidden.
  desk.note('leader_trade', 'a');
  const first = await desk.poll(null, 0);
  assert.equal(first.events.length, 0, 'no cursor: from now on');
  for (let i = 0; i < 2_005; i++) desk.note('copy', `c${i}`);
  desk.note('scan', 'done');
  const back = await desk.poll(first.cursor, 0);
  assert.equal(back.missed, 6, 'six fell off the 2,000 kept');
  assert.equal(back.events.length, 2_000);
  const scans = await desk.poll(first.cursor, 0, ['scan']);
  assert.deepEqual(scans.events.map((e) => e.text), ['done']);
  // A waiting poll wakes on the first event of its kinds only.
  const t0 = Date.now();
  const waiting = desk.poll(scans.cursor, 1_000, ['scan']);
  setTimeout(() => desk.note('copy', 'not this'), 10);
  setTimeout(() => desk.note('scan', 'this'), 60);
  const woke = await waiting;
  assert.deepEqual(woke.events.map((e) => e.text), ['this']);
  assert.ok(Date.now() - t0 < 900);
  ok('the feed pages by cursor, filters by kind, wakes a poll on the first match and counts what it dropped');
}

{
  desk._reset();
  // The app restarted while the AI kept its cursor: the count starts again,
  // so a cursor past it is read as "from the start of this run".
  desk.note('copy', 'after restart');
  const r = await desk.poll(4_000, 0);
  assert.equal(r.restarted, true);
  assert.deepEqual(r.events.map((e) => e.text), ['after restart']);
  assert.equal(r.missed, 0);
  // A decision wakes a poll filtered to other kinds — it is waiting on the reader.
  const waiting = desk.poll(r.cursor, 1_000, ['scan']);
  const req = entry({ id: desk.newId(), askedAt: Date.now(), deadline: Date.now() + 2_000 });
  const asking = desk.ask(req);
  const woke = await waiting;
  assert.deepEqual(woke.events.map((e) => e.kind), ['decision']);
  desk.cancel(req.id, 'the follow was paused');
  assert.equal((await asking).why, 'cancelled — the follow was paused');
  assert.equal(desk.status().log[0].outcome, 'cancelled', 'a withdrawal is on the AI page’s log');
  ok('a cursor from before a restart reads the new run, a decision always wakes a poll, a withdrawal is logged');
}

console.log(`\naidesk: ${passed}/7 passed`);
