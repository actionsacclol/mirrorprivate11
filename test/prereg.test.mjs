// The pre-registered test (2026-10-25, P1): shared/prereg.ts and
// electron/engine/prereg.ts. Pinned: the freeze is canonical and hashed and
// a changed file is caught; the random arm is stratified and seeded; a week
// settles every arm by one rule at one lag with mint-clustered intervals; the
// rank-decay track; the verdict's decision tree; and the engine's clock —
// Sunday freezes, late freezes said so, settlement after the week, inside
// the allowance, never twice.

import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import {
  PREREG_ARM_N,
  PREREG_FUTILITY_WEEKS,
  PREREG_LAGS,
  PREREG_LAG_ASSUMED,
  PREREG_SIZE_SOL,
  PREREG_WEEKS,
  canonical,
  freezeDueFor,
  preregFloorPct,
  preregMarkdown,
  preregVerdict,
  rankDecay,
  settleArm,
  settleWeek,
  stratifiedDraw,
  weekLabel,
} from './.prereg.mjs';
import * as eng from './.preregengine.mjs';
import { weekOf } from './.walletscout.mjs';

let passed = 0;
const ok = (label) => {
  console.log(`  ok   ${label}`);
  passed += 1;
};

const WEEK = 7 * 86_400_000;
const W0 = Date.UTC(2026, 10, 2); // Monday 2 Nov 2026
const sha = (s) => createHash('sha256').update(s).digest('hex');

const rule = { ranker: 'eb-lcb', muPct: -17, k: 12, priorWallets: 40, z: 0.84, minTrips: 10, botPerMin: 40, filters: 'all', sizeSol: PREREG_SIZE_SOL, lagSlots: 9, lagSource: 'assumed', minLeaderSellPct: 50, maxOpenPerWallet: 3 };
const freezeOf = (week, top, rand = [], lead = [], over = {}) => {
  const body = {
    version: 1,
    chain: 'solana',
    week,
    frozenAt: week - 3_600_000,
    late: false,
    rule,
    arms: [
      { name: 'TOP', wallets: top, rule: 'top' },
      { name: 'RAND', wallets: rand, rule: 'rand' },
      { name: 'LEAD', wallets: lead, rule: 'lead' },
    ],
    floorPct: preregFloorPct(PREREG_SIZE_SOL),
    eligible: 40,
    universe: 300,
    rulesTried: 2,
    ...over,
  };
  return { ...body, hash: sha(canonical(body)) };
};

{
  const a = freezeOf(W0, ['T1', 'T2']);
  const b = { ...a };
  // Key order and the hash itself never change the canonical text.
  const reordered = Object.fromEntries(Object.entries(b).reverse());
  assert.equal(canonical(reordered), canonical(a), 'keys sorted, the hash left out');
  assert.equal(canonical({ ...a, hash: 'other' }), canonical(a));
  assert.notEqual(canonical({ ...a, arms: [...a.arms].reverse() }), canonical(a), 'array order is part of the record');
  assert.equal(sha(canonical(a)), a.hash);
  assert.notEqual(sha(canonical({ ...a, eligible: 41 })), a.hash, 'one changed number, another hash');
  const md = preregMarkdown(a);
  assert.match(md, /# PREREG 2026-11-02/);
  assert.match(md, new RegExp(a.hash));
  assert.match(md, /T1/);
  assert.match(md, /FLOOR: -7\.\d\d %/);
  assert.equal(weekLabel(W0), '2026-11-02');
  assert.equal(freezeDueFor(W0), W0 - 86_400_000, 'due Sunday 00:00 UTC, the day before');
  assert.equal(PREREG_LAGS.includes(0) && PREREG_LAGS.includes(PREREG_LAG_ASSUMED), true);
  ok('a freeze canonicalises to one text and hashes to one hash; the markdown carries both');
}

{
  // Thirty eligible wallets: trips 10..39, first-buy sizes cycling small/mid/large.
  const rows = Array.from({ length: 30 }, (_, i) => ({ address: `W${i}`, fTrips: 10 + i, medianFirstBuy: [0.02, 0.1, 0.6][i % 3] }));
  const d1 = stratifiedDraw(rows, PREREG_ARM_N, 11);
  assert.equal(d1.length, PREREG_ARM_N);
  assert.equal(new Set(d1).size, PREREG_ARM_N, 'no wallet twice');
  assert.deepEqual(stratifiedDraw(rows, PREREG_ARM_N, 11), d1, 'the same seed, the same draw');
  assert.notDeepEqual(stratifiedDraw(rows, PREREG_ARM_N, 12), d1, 'another seed, another draw');
  // Stratified: every trip tercile and every size tercile is represented.
  const idx = d1.map((a) => Number(a.slice(1)));
  assert.ok(idx.some((i) => i < 10) && idx.some((i) => i >= 10 && i < 20) && idx.some((i) => i >= 20), 'every trip tercile drawn from');
  assert.ok([0, 1, 2].every((m) => idx.some((i) => i % 3 === m)), 'every size tercile drawn from');
  assert.deepEqual(stratifiedDraw([], 5, 1), []);
  assert.equal(stratifiedDraw(rows.slice(0, 4), 10, 1).length, 4, 'never more than there are');
  ok('RAND is a seeded draw stratified on trip count and first-buy size');
}

const copy = (arm, wallet, mint, openedAt, at, over = {}) => ({ arm, wallet, mint, openedAt, closedAt: openedAt + 60_000, atLag: at, tooFast: false, ...over });
const lagged = (r9, r0 = r9 + 6) => ({ 0: r0, 1: r0 - 1, 2: r0 - 2, 4: r0 - 4, 9: r9 });

{
  // TOP: three wallets, each on its own coins, recorded medians around +2 at 9 slots.
  const copies = [];
  for (let w = 0; w < 3; w++) for (let i = 0; i < 12; i++) copies.push(copy('TOP', `T${w}`, `m${w}-${i % 6}`, W0 + i * 3_600_000, lagged(2 + (i % 5) - 2)));
  copies.push(copy('TOP', 'T0', 'fast', W0, {}, { tooFast: true }));
  const a = settleArm('TOP', ['T0', 'T1', 'T2', 'T3'], copies, PREREG_SIZE_SOL, 9, 5);
  assert.equal(a.wallets, 4);
  assert.equal(a.walletsPriced, 3, 'T3 had no copy');
  assert.equal(a.copies, 36);
  assert.equal(a.skipped, 1, 'the too-fast trip is counted, not priced');
  // Recorded +2 at 1.5 %/side repriced to 0.1 SOL: lower by the fixed fees and the per-side difference.
  assert.ok(a.medianPct < 2 && a.medianPct > -8, `repriced median ${a.medianPct}`);
  assert.ok(a.ci && a.ci.lo <= a.medianPct && a.ci.hi >= a.medianPct, 'the interval covers the median');
  assert.equal(a.byLag['0'].copies, 36);
  assert.ok(a.byLag['0'].medianPct > a.byLag['9'].medianPct, 'the 0-slot copy does better than the 9-slot one, as the fixture says');
  assert.ok(Math.abs(a.byLag['9'].medianPct - a.medianPct) < 1e-9, 'the judged lag is the arm’s figure');
  assert.equal(typeof a.netSol, 'number');
  assert.ok(a.winRatePct >= 0 && a.winRatePct <= 100);
  const empty = settleArm('LEAD', ['L0'], [], PREREG_SIZE_SOL, 9, 5);
  assert.deepEqual([empty.copies, empty.medianPct, empty.ci, empty.netSol], [0, null, null, null]);
  ok('an arm settles at one lag with a mint-clustered interval; skipped trips are counted');
}

{
  // Rank decay: last week's TOP in frozen order, this week's medians falling with rank → ρ ≈ 1.
  const order = ['A', 'B', 'C', 'D', 'E', 'F'];
  const copies = [];
  order.forEach((w, i) => {
    for (let j = 0; j < 4; j++) copies.push(copy('TRACK1', w, `${w}${j}`, W0, { 9: 10 - 3 * i + (j % 2) }));
  });
  const d = rankDecay(order, copies, 9);
  assert.ok(d && d.rho > 0.95, `holds: ${JSON.stringify(d)}`);
  assert.equal(d.wallets, 6);
  const noise = rankDecay(order, copies.map((c) => ({ ...c, atLag: { 9: [5, -5, 0, 3, -3, 1][order.indexOf(c.wallet)] } })), 9);
  assert.ok(Math.abs(noise.rho) < 0.5, `scrambled: ${noise.rho}`);
  assert.equal(rankDecay(order.slice(0, 4), copies, 9), null, 'under five wallets with copies');
  ok('rank decay is the Spearman of the frozen order against the realised medians');
}

{
  const fz = freezeOf(W0, ['T0', 'T1'], ['R0', 'R1'], ['L0']);
  const prev = freezeOf(W0 - WEEK, ['P0', 'P1', 'P2', 'P3', 'P4']);
  const copies = [];
  for (let i = 0; i < 20; i++) {
    copies.push(copy('TOP', `T${i % 2}`, `t${i % 8}`, W0 + i * 1000, lagged(5)));
    copies.push(copy('RAND', `R${i % 2}`, `r${i % 8}`, W0 + i * 1000, lagged(-20)));
    copies.push(copy('LEAD', 'L0', `l${i % 8}`, W0 + i * 1000, lagged(-30)));
  }
  for (let i = 0; i < 5; i++) for (let j = 0; j < 4; j++) copies.push(copy('TRACK1', `P${i}`, `p${i}${j}`, W0, { 9: 5 - 2 * i }));
  const s = settleWeek(fz, copies, { prev1: prev, prev2: null }, 9, W0 + WEEK + 1000, { complete: true, credits: 1234, message: '' });
  assert.equal(s.week, W0);
  assert.equal(s.lagSlots, 9);
  assert.equal(s.floorPct, fz.floorPct);
  assert.deepEqual(s.arms.map((a) => a.name), ['TOP', 'RAND', 'LEAD']);
  assert.ok(s.diffs.vsRand && s.diffs.vsRand.lo > 0, `TOP beat RAND: ${JSON.stringify(s.diffs.vsRand)}`);
  assert.ok(s.diffs.vsLead && s.diffs.vsLead.lo > 0);
  assert.ok(s.tracks.prev1 && s.tracks.prev1.copies === 20 && s.tracks.prev1.wallets === 5);
  assert.equal(s.tracks.prev2, null);
  assert.ok(s.decay.prev1 && s.decay.prev1.rho > 0.9);
  assert.equal(s.decay.prev2, null);
  assert.deepEqual([s.complete, s.credits], [true, 1234]);
  const again = settleWeek(fz, copies, { prev1: prev, prev2: null }, 9, W0 + WEEK + 1000, { complete: true, credits: 1234, message: '' });
  assert.deepEqual(again.arms, s.arms, 'seeded from the freeze’s hash: the same copies settle the same way');
  ok('a week settles every arm and both tracks by one rule at one lag');
}

{
  // The decision tree.
  const armsAt = (topMed, lo, hi, zeroMed, randDiffLo) => ({
    version: 1,
    week: W0,
    settledAt: 0,
    sizeSol: PREREG_SIZE_SOL,
    floorPct: -7.6,
    lagSlots: 9,
    arms: [
      { name: 'TOP', wallets: 10, walletsPriced: 10, copies: 100, skipped: 0, medianPct: topMed, ci: { lo, hi }, trimmedMeanPct: topMed, winRatePct: 50, netSol: 0, byLag: { 0: { copies: 100, medianPct: zeroMed }, 9: { copies: 100, medianPct: topMed } } },
      { name: 'RAND', wallets: 10, walletsPriced: 10, copies: 100, skipped: 0, medianPct: -10, ci: { lo: -12, hi: -8 }, trimmedMeanPct: -10, winRatePct: 40, netSol: 0, byLag: {} },
      { name: 'LEAD', wallets: 10, walletsPriced: 10, copies: 100, skipped: 0, medianPct: -15, ci: { lo: -17, hi: -13 }, trimmedMeanPct: -15, winRatePct: 30, netSol: 0, byLag: {} },
    ],
    diffs: { vsRand: { diff: topMed + 10, lo: randDiffLo, hi: randDiffLo + 4 }, vsLead: { diff: topMed + 15, lo: 1, hi: 5 } },
    tracks: { prev1: null, prev2: null },
    decay: { prev1: null, prev2: null },
    complete: true,
    credits: 0,
    message: '',
  });
  const weeks = (n, f) => Array.from({ length: n }, (_, i) => ({ ...f(i), week: W0 + i * WEEK }));
  assert.equal(preregVerdict([]).outcome, 'running');
  assert.equal(preregVerdict(weeks(2, () => armsAt(-5, -7, -3, -2, -1))).outcome, 'running', 'nothing is decided before week four');
  const futile = preregVerdict(weeks(PREREG_FUTILITY_WEEKS, () => armsAt(-5, -7, -3, -2, -1)));
  assert.equal(futile.outcome, 'futile', 'four weeks with the upper bound under zero stop it');
  assert.match(futile.text[0], /futility/);
  assert.equal(preregVerdict(weeks(5, (i) => armsAt(i % 2 ? 2 : -1, i % 2 ? 1 : -3, 4, 3, 1))).outcome, 'running', 'mixed weeks run on to eight');
  const pass = preregVerdict(weeks(PREREG_WEEKS, (i) => armsAt(3, i < 6 ? 1 : -1, 5, 6, 1)));
  assert.equal(pass.outcome, 'pass', 'six of eight lower bounds above zero and the pooled bound above zero');
  assert.equal(pass.weeksAboveZero, 6);
  assert.ok(pass.topLo > 0 || pass.weeksAboveZero >= 6);
  const latency = preregVerdict(weeks(PREREG_WEEKS, () => armsAt(-3, -5, -1, 4, 1)));
  assert.equal(latency.outcome, 'fail-latency', 'fails at the judged lag, positive at 0 slots');
  assert.match(latency.text[0], /latency/);
  const selection = preregVerdict(weeks(PREREG_WEEKS, () => armsAt(-9, -11, -7, -6, -2)));
  assert.equal(selection.outcome, 'fail-selection', 'negative even at 0 slots and no better than RAND');
  const inconclusive = preregVerdict(weeks(PREREG_WEEKS, () => armsAt(-3, -5, -1, -1, 1)));
  assert.equal(inconclusive.outcome, 'inconclusive', 'beats RAND but clears nothing');
  // Pooled across weeks as the median of weekly medians, never one grand pool.
  assert.equal(pass.topMedianPct, 3);
  ok('the verdict follows the pre-written decision tree');
}

// ── the engine ────────────────────────────────────────────────────────

const B58 = (s) => `${s}z`.padEnd(44, 'x');
function rowsOf(n) {
  return Array.from({ length: n }, (_, i) => ({
    chain: 'solana',
    address: B58(`W${i}`),
    buys: 20,
    sells: 20,
    roundTrips: 20,
    pnl: 5 - i * 0.1,
    fTrips: 15 + i,
    fMedianReturnPct: -2 - i * 0.1,
    fShrunkPct: -5 - i * 0.1,
    fLowerPct: -8 - i * 0.1,
    copyScore: 60 - i,
    ranked: true,
    looksAutomated: false,
    reachablePct: 80,
    medianHoldMs: 90_000,
    medianFirstBuy: [0.02, 0.1, 0.6][i % 3],
    fastPct: 0,
    spanDays: 7,
    activeDays: 5,
    createdCoins: 0,
    mayhemTrips: 0,
    warnings: [],
    flags: [],
    sizeSol: 0.1,
    lastSeen: W0,
    winRatePct: 50,
    volume: 10,
    peakPerMin: 5,
    distinctMints: 20,
    fixedCostPct: 0,
    basis: { shrunkPct: -5, lowerPct: -8, winRatePct: 50 },
    shrink: { k: 12, muPct: -17, wallets: 40 },
  }));
}

function engineDeps(over = {}) {
  const replayed = [];
  let credits = 100_000;
  let now = W0 - 3_600_000; // Sunday 23:00 UTC before W0
  return {
    replayed,
    credits: () => credits,
    setNow: (t) => (now = t),
    deps: {
      rows: () => rowsOf(30),
      prior: () => ({ muPct: -17, k: 12, sigmaPct: 35, tauPct: 10, wallets: 40, at: now }),
      leaderboard: async () => Array.from({ length: 12 }, (_, i) => B58(`L${i}`)),
      slotGap: () => null,
      async replay(address, opts) {
        replayed.push([address, opts]);
        credits -= 500;
        // Four trips in the window per wallet, priced at every lag.
        const trips = Array.from({ length: 4 }, (_, j) => ({
          mint: `${address.slice(0, 3)}${j}`,
          openedAt: opts.since + j * 3_600_000,
          closedAt: opts.since + j * 3_600_000 + 60_000,
          cost: 1,
          pnl: 0,
          holdMs: 60_000,
          entryPx: 1,
          exitPx: 1,
          returnPct: -3,
          atLag: Object.fromEntries(opts.lags.map((l) => [String(l), -3 + (9 - l) * 0.5])),
          note: 'filled',
          source: 'chain',
        }));
        return { trips, credits: 500 };
      },
      creditsLeft: () => credits,
      chainOk: () => true,
      now: () => now,
      random: () => 0.5,
      ...over,
    },
  };
}

{
  eng._reset();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'prereg-'));
  eng.init(dir);
  const h = engineDeps();
  // Sunday 23:00 before W0: the freeze for W0 is due (Sunday 00:00) and not made → tick freezes W0.
  eng.tick(h.deps);
  assert.equal(eng.status(h.deps).phase, 'freezing');
  await eng.wait();
  let s = eng.status(h.deps);
  assert.equal(s.running, false);
  assert.equal(s.freezes.length, 1);
  const fz = s.freezes[0];
  assert.equal(fz.week, W0, 'frozen for the coming week');
  assert.equal(fz.late, false, 'before the week began');
  assert.equal(fz.rule.lagSlots, PREREG_LAG_ASSUMED);
  assert.equal(fz.rule.lagSource, 'assumed');
  assert.equal(fz.rule.k, 12);
  assert.equal(fz.rule.priorWallets, 40);
  const top = fz.arms.find((a) => a.name === 'TOP');
  const rand = fz.arms.find((a) => a.name === 'RAND');
  const lead = fz.arms.find((a) => a.name === 'LEAD');
  assert.equal(top.wallets.length, PREREG_ARM_N);
  assert.deepEqual(top.wallets, rowsOf(30).slice(0, PREREG_ARM_N).map((r) => r.address), 'the top ten on the lower bound');
  assert.equal(rand.wallets.length, PREREG_ARM_N);
  assert.ok(rand.wallets.every((w) => !top.wallets.includes(w)), 'RAND never shares a wallet with TOP');
  assert.equal(lead.wallets.length, PREREG_ARM_N, 'the leaderboard’s top ten');
  assert.equal(fz.eligible, 30);
  assert.equal(sha(canonical(fz)), fz.hash, 'the record hashes to its hash');
  const file = path.join(dir, 'prereg', 'PREREG-2026-11-02.json');
  assert.ok(fs.existsSync(file), 'written to disk');
  assert.ok(fs.existsSync(path.join(dir, 'prereg', 'PREREG-2026-11-02.md')), 'with a readable twin');
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')).hash, fz.hash);
  // A second tick the same night does nothing; freezing the same week again is refused.
  eng.tick(h.deps);
  await eng.wait();
  assert.equal(eng.status(h.deps).freezes.length, 1);
  assert.equal((await eng.freeze(W0, h.deps)).ok, false, 'one freeze per week, ever');
  // Settling before the week ends is refused.
  h.setNow(W0 + 3 * 86_400_000);
  assert.match(eng.settle(W0, h.deps).message, /not ended/);
  eng.tick(h.deps);
  await eng.wait();
  assert.equal(eng.status(h.deps).settled.length, 0, 'mid-week: nothing to settle, and W0 is frozen so no late freeze');
  // The week ends. The running week was never frozen (the app "was off" on
  // Sunday): the tick freezes it LATE first, and says so…
  h.setNow(W0 + WEEK + 3_600_000);
  eng.tick(h.deps);
  assert.equal(eng.status(h.deps).phase, 'freezing');
  await eng.wait();
  s = eng.status(h.deps);
  const late = s.freezes.find((f) => f.week === W0 + WEEK);
  assert.ok(late, 'the running week is frozen late rather than skipped');
  assert.equal(late.late, true, 'and says so');
  assert.equal(late.frozenAt, W0 + WEEK + 3_600_000);
  // …and the next tick settles the ended week: every arm's wallet once, over exactly the week, at the lags.
  eng.tick(h.deps);
  s = eng.status(h.deps);
  assert.equal(s.running, true);
  assert.equal(s.phase, 'settling');
  assert.equal(s.total, 30, 'ten TOP, ten RAND, ten LEAD, no track yet');
  await eng.wait();
  s = eng.status(h.deps);
  assert.equal(s.running, false);
  assert.equal(h.replayed.length, 30);
  assert.equal(new Set(h.replayed.map(([a]) => a)).size, 30, 'each wallet once');
  for (const [, o] of h.replayed) {
    assert.deepEqual([o.since, o.until, o.sample], [W0, W0 + WEEK, 'random'], 'exactly the week, a random sample');
    assert.deepEqual([...o.lags].sort((a, b) => a - b), [...PREREG_LAGS].sort((a, b) => a - b), 'the ablation’s lags (the judged lag is among them)');
  }
  assert.equal(s.settled.length, 1);
  const st = s.settled[0];
  assert.equal(st.week, W0);
  assert.equal(st.complete, true);
  assert.equal(st.credits, 30 * 500);
  const topR = st.arms.find((a) => a.name === 'TOP');
  assert.equal(topR.copies, 40, 'ten wallets, four trips each');
  assert.equal(topR.byLag['0'].copies, 40);
  assert.ok(topR.byLag['0'].medianPct > topR.byLag['9'].medianPct, 'the ablation is kept per lag');
  assert.ok(fs.existsSync(path.join(dir, 'prereg', 'settled-2026-11-02.json')));
  assert.equal(s.verdict.outcome, 'running');
  assert.equal(s.verdict.weeks, 1);
  // Settling again is refused; the tick does not redo it.
  assert.match(eng.settle(W0, h.deps).message, /already settled/);
  eng.tick(h.deps);
  assert.equal(eng.status(h.deps).running, false, 'nothing left to do this hour');
  // The next week ends, but the app comes back only on its Thursday: too late
  // to freeze that week (a rule written with half the answer in hand), so the
  // tick settles the ended week instead, with the previous TOP tracked —
  // 30 arm wallets and the 10 of W0's TOP, each wallet replayed once.
  h.replayed.length = 0;
  h.setNow(W0 + 2 * WEEK + 4 * 86_400_000);
  eng.tick(h.deps);
  assert.equal(eng.status(h.deps).phase, 'settling', 'no freeze four days into a week');
  await eng.wait();
  s = eng.status(h.deps);
  assert.equal(s.freezes.length, 2, 'the missed week stays unfrozen');
  assert.equal(s.settled.length, 2);
  const w1 = s.settled.find((x) => x.week === W0 + WEEK);
  assert.ok(w1.tracks.prev1 && w1.tracks.prev1.wallets === PREREG_ARM_N, 'last week’s TOP followed through this week');
  assert.ok(h.replayed.length <= 40 && h.replayed.length >= 30, `wallets replayed once each: ${h.replayed.length}`);
  // Reload from disk: everything is back, and a tampered freeze is named.
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  raw.eligible = 31;
  fs.writeFileSync(file, JSON.stringify(raw), 'utf8');
  eng._reset();
  eng.init(dir);
  s = eng.status(h.deps);
  assert.equal(s.freezes.length, 2);
  assert.equal(s.settled.length, 2);
  assert.deepEqual(s.badHash, [W0], 'the edited freeze no longer hashes to its hash');
  fs.rmSync(dir, { recursive: true, force: true });
  ok('the clock: a Sunday freeze, a late freeze said so, settlement after the week at the lags, once; records reload and a changed file is caught');
}

{
  // The allowance: a settlement that cannot start is not written; one that
  // runs out part way is written as incomplete.
  eng._reset();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'prereg2-'));
  eng.init(dir);
  const h = engineDeps();
  await eng.freeze(W0, h.deps);
  h.setNow(W0 + WEEK + 4 * 86_400_000);
  let left = 600;
  const deps = { ...h.deps, creditsLeft: () => left };
  const r = eng.settle(W0, deps);
  assert.equal(r.ok, false, 'under one wallet’s worth, nothing starts');
  assert.match(r.message, /allowance/);
  eng.tick(deps);
  assert.equal(eng.status(deps).running, false, 'and the tick does not retry within the hour');
  left = 5 * 700 + 100;
  const deps2 = {
    ...h.deps,
    creditsLeft: () => left,
    replay: async (a, o) => {
      left -= 700;
      return h.deps.replay(a, o);
    },
  };
  assert.equal(eng.settle(W0, deps2, { force: true }).ok, true);
  await eng.wait();
  const s = eng.status(deps2);
  assert.equal(s.settled.length, 1);
  assert.equal(s.settled[0].complete, false, 'the allowance ran out part way: written, and said to be incomplete');
  assert.match(s.settled[0].message, /allowance/);
  assert.ok(s.done >= 5 && s.done < 30, `${s.done} wallets replayed before the stop`);
  // No chain: nothing settles, and the status says why.
  fs.rmSync(path.join(dir, 'prereg', 'settled-2026-11-02.json'));
  eng._reset();
  eng.init(dir);
  const noChain = { ...h.deps, chainOk: () => false };
  assert.match(eng.settle(W0, noChain).message, /Helius/);
  assert.equal(eng.status(noChain).chainOk, false);
  fs.rmSync(dir, { recursive: true, force: true });
  ok('the allowance governs a settlement: none without a wallet’s worth, incomplete and said so when it runs out');
}

console.log(`\nprereg: ${passed}/${passed} passed`);
