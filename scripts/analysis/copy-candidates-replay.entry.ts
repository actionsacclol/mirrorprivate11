// Stage "replay" of scripts/analysis/copy-candidates.mjs, which bundles and runs this file; see its header for the method and usage.
import fs from 'node:fs';
import path from 'node:path';
import { getTransactionsForAddress, addressTxCredits } from '@app/chain/rpcClient';
import { decodeWalletSwap } from '@app/engine/walletSwap';
import * as chainPrice from '@app/engine/chainPrice';
import { buildTrips, sampleTrips, sampleSeed, swapChecks, replayReturn, markBirth, type ReplaySwap, type ReplayTrip } from '@shared/copyReplay';
import { repriceReturn, feeFloorPct } from '@shared/walletScore';
import { copyCostModel, dayOf, SNIPER_SLOTS } from '@shared/walletScout';
import { bootstrapMedianCI, median } from '@shared/stats';

const env = (k: string, d: string): string => process.env[k] ?? d;
const OUT = env('OUT', '');
const pool = JSON.parse(fs.readFileSync(env('POOL', ''), 'utf8')) as Array<{ address: string; sources: string[] }>;
const SAMPLE = Number(env('SAMPLE', '80'));
const CAP = Number(env('CAP', '120000'));
const MAX_TXS = Number(env('MAX_TXS', '6000'));
const DAYS = Number(env('DAYS', '7'));
const BIRTHS = env('BIRTHS', '0') === '1';
const PARALLEL = Number(env('PARALLEL', '2'));
const TRIP_PAR = 4;
const OBSERVED = new Set(JSON.parse(env('OBSERVED', '[]')) as number[]);
const TAG = env('TAG', 'pass1');
/** Skip pricing (spend nothing past the read) when the wallet's week is
 *  faster than this median hold, or busier than this many trips. */
const MIN_HOLD_S = Number(env('MIN_HOLD_S', '0'));
const MAX_WEEK_TRIPS = Number(env('MAX_WEEK_TRIPS', '1000000'));
const settings = JSON.parse(fs.readFileSync(path.join(process.env.APPDATA as string, 'Krypto Copy', 'settings.json'), 'utf8'));
const HTTP = `https://mainnet.helius-rpc.com/?api-key=${String(process.env.HELIUS_API_KEY ?? settings.rpc.heliusApiKey).trim()}`;
const cacheDir = path.join(OUT, 'cache');
fs.mkdirSync(cacheDir, { recursive: true });
fs.mkdirSync(path.join(OUT, TAG), { recursive: true });
chainPrice.init(cacheDir);
const now = Number(env('NOW', String(Date.now())));
const DAY = 86_400_000;
const since = now - DAYS * DAY;
const m01 = copyCostModel('solana', 0.1);
const FLOOR = feeFloorPct(m01);
let credits = 0;
let calls = 0;
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const log = (s: string): void => {
  const line = `${new Date().toISOString().slice(11, 19)} ${s}`;
  console.log(line);
  fs.appendFileSync(path.join(OUT, `${TAG}.log`), line + '\n');
};

async function readSwaps(addr: string): Promise<{ swaps: ReplaySwap[]; txs: number; pages: number; message: string; truncated: boolean }> {
  const swaps: ReplaySwap[] = [];
  let token: string | null = null;
  let txs = 0;
  let pages = 0;
  let message = '';
  let fails = 0;
  for (;;) {
    const r = await getTransactionsForAddress(HTTP, addr, { limit: 100, paginationToken: token, sinceSec: Math.floor((since - DAY) / 1000) });
    calls += 1;
    if (!r.ok || !r.data) {
      fails += 1;
      if (fails > 6 || r.refused) {
        message = r.message;
        break;
      }
      await sleep(1500 * fails);
      continue;
    }
    fails = 0;
    pages += 1;
    credits += addressTxCredits(r.data.txs.length);
    for (const tx of r.data.txs as Array<(typeof r.data.txs)[number] & { transactionIndex?: number }>) {
      const s = decodeWalletSwap(tx, addr);
      if (!s || typeof tx.blockTime !== 'number' || typeof tx.slot !== 'number') continue;
      const payer = tx.transaction?.message?.accountKeys?.[0];
      swaps.push({
        mint: s.mint,
        isBuy: s.isBuy,
        sol: s.sol,
        tokens: s.tokens,
        at: tx.blockTime * 1000,
        tx: tx.signature,
        slot: tx.slot,
        ...(typeof tx.transactionIndex === 'number' ? { txIndex: tx.transactionIndex } : {}),
        ...(payer && payer !== addr ? { payer } : {}),
      });
    }
    txs += r.data.txs.length;
    token = r.data.paginationToken;
    if (!token || txs >= MAX_TXS) break;
  }
  return { swaps, txs, pages, message, truncated: !!token && txs >= MAX_TXS };
}

function peakPerMin(swaps: readonly ReplaySwap[]): number {
  const ts = swaps.map((s) => s.at).sort((a, b) => a - b);
  let best = 0;
  let j = 0;
  for (let i = 0; i < ts.length; i++) {
    while (ts[i] - ts[j] > 60_000) j++;
    best = Math.max(best, i - j + 1);
  }
  return best;
}

const med = (xs: number[]): number | null => median(xs);
const r1 = (x: number | null): number | null => (x === null ? null : Math.round(x * 10) / 10);
const sumSol = (xs: number[]): number => Math.round(xs.reduce((a, r) => a + 0.1 * (r / 100), 0) * 1000) / 1000;

async function one(p: { address: string; sources: string[] }): Promise<Record<string, unknown>> {
  const addr = p.address;
  const t0 = Date.now();
  const rd = await readSwaps(addr);
  const built = buildTrips(rd.swaps);
  const week = built.trips.filter((t) => t.closedAt >= since && t.closedAt < now);
  const checks = swapChecks(rd.swaps, addr);
  const weekHoldS = (med(week.map((t) => t.holdMs)) ?? 0) / 1000;
  const skipFast = week.length > 0 && (weekHoldS < MIN_HOLD_S || week.length > MAX_WEEK_TRIPS);
  const sample = skipFast ? [] : sampleTrips(week, SAMPLE, 'random', sampleSeed(addr));
  const todo = sample.filter((t) => t.note !== 'too-fast' && typeof t.openSlot === 'number' && typeof t.closeSlot === 'number');
  let next = 0;
  let fails = 0;
  let stopped = skipFast ? `skipped: median hold ${weekHoldS.toFixed(0)} s, ${week.length} trips` : '';
  let walletCredits = 0;
  let cachedN = 0;
  const worker = async (): Promise<void> => {
    while (next < todo.length && !stopped) {
      const t = todo[next++];
      if (credits > CAP) {
        stopped = 'cap';
        break;
      }
      let r = await chainPrice.priceTrip(HTTP, t.mint, t.openSlot as number, t.closeSlot as number);
      for (let a = 0; !r.ok && !r.refused && a < 3; a++) {
        await sleep(1000 * (a + 1));
        r = await chainPrice.priceTrip(HTTP, t.mint, t.openSlot as number, t.closeSlot as number);
      }
      calls += r.calls;
      credits += r.credits;
      walletCredits += r.credits;
      if (r.cached) cachedN += 1;
      if (!r.ok) {
        fails += 1;
        if (r.refused || fails >= 5) stopped = `read failed: ${r.message}`;
        continue;
      }
      fails = 0;
      if (r.entry !== null && r.exit !== null) {
        t.entryPx = r.entry;
        t.exitPx = r.exit;
        t.returnPct = replayReturn(r.entry, r.exit);
        if (t.returnPct !== null) {
          t.note = 'filled';
          t.source = 'chain';
        }
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(TRIP_PAR, todo.length) }, worker));
  let sniper = 0;
  let bundle = 0;
  let mintsChecked = 0;
  if (BIRTHS && !stopped) {
    const byMint = new Map<string, ReplayTrip[]>();
    for (const t of sample) if (t.note === 'filled') byMint.set(t.mint, [...(byMint.get(t.mint) ?? []), t]);
    for (const [mint, ts] of byMint) {
      const b = await chainPrice.mintBirth(HTTP, mint);
      calls += b.calls;
      credits += b.credits;
      walletCredits += b.credits;
      if (!b.ok || !b.birth) continue;
      mintsChecked += ts.length;
      for (const t of ts) {
        markBirth(t, b.birth, addr);
        if (typeof t.sinceBirth === 'number' && t.sinceBirth <= SNIPER_SLOTS) sniper += 1;
        if (t.bundle) bundle += 1;
      }
    }
  }
  const filled = sample.filter((t) => t.returnPct !== null);
  const rows = sample.map((t) => ({
    mint: t.mint,
    openedAt: t.openedAt,
    closedAt: t.closedAt,
    day: dayOf(t.closedAt),
    holdMs: t.holdMs,
    cost: t.cost,
    pnl: t.pnl,
    openSlot: t.openSlot,
    closeSlot: t.closeSlot,
    note: t.note,
    ret: t.returnPct,
    ret01: t.returnPct === null ? null : repriceReturn(t.returnPct, m01),
    entryPx: t.entryPx,
    exitPx: t.exitPx,
    sinceBirth: t.sinceBirth ?? null,
    bundle: t.bundle ?? null,
  }));
  const rets01 = rows.filter((r) => r.ret01 !== null).map((r) => r.ret01 as number);
  const sorted = [...rets01].sort((a, b) => a - b);
  const mean01 = rets01.length ? rets01.reduce((a, b) => a + b, 0) / rets01.length : null;
  const byMintRet = new Map<string, number[]>();
  for (const r of rows) if (r.ret01 !== null) byMintRet.set(r.mint, [...(byMintRet.get(r.mint) ?? []), r.ret01]);
  const ci = bootstrapMedianCI([...byMintRet.values()], 300, sampleSeed(addr + ':ci'));
  const byDay = new Map<number, number[]>();
  for (const r of rows) if (r.ret01 !== null) byDay.set(r.day, [...(byDay.get(r.day) ?? []), r.ret01]);
  const days = [...byDay].sort((a, b) => a[0] - b[0]).map(([d, xs]) => ({ day: d, seen: OBSERVED.has(d), n: xs.length, median: r1(med(xs)), total: sumSol(xs) }));
  const unseen = rows.filter((r) => r.ret01 !== null && !OBSERVED.has(r.day)).map((r) => r.ret01 as number);
  const seen = rows.filter((r) => r.ret01 !== null && OBSERVED.has(r.day)).map((r) => r.ret01 as number);
  const half = since + (DAYS * DAY) / 2;
  const h1 = rows.filter((r) => r.ret01 !== null && r.closedAt < half).map((r) => r.ret01 as number);
  const h2 = rows.filter((r) => r.ret01 !== null && r.closedAt >= half).map((r) => r.ret01 as number);
  const weekPnl = week.reduce((a, t) => a + t.pnl, 0);
  const weekCost = week.reduce((a, t) => a + t.cost, 0);
  const sampledShare = sample.length ? filled.length / sample.length : 0;
  const summary = {
    address: addr,
    sources: p.sources,
    txs: rd.txs,
    pages: rd.pages,
    truncated: rd.truncated,
    readMessage: rd.message,
    swaps: rd.swaps.length,
    open: built.open,
    orphanSells: built.orphanSells,
    weekTrips: week.length,
    tooFast: week.filter((t) => t.note === 'too-fast').length,
    sampled: sample.length,
    priced: filled.length,
    unpriceable: todo.length - filled.length,
    cached: cachedN,
    stopped,
    median01: r1(med(rets01)),
    mean01: r1(mean01),
    win01: rets01.length ? Math.round((rets01.filter((r) => r > 0).length / rets01.length) * 100) : null,
    total01: sumSol(rets01),
    estWeekSol: mean01 === null ? null : Math.round((mean01 / 100) * 0.1 * week.length * sampledShare * 100) / 100,
    ciLo: ci ? r1(ci.lo) : null,
    ciHi: ci ? r1(ci.hi) : null,
    p25: r1(sorted.length ? sorted[Math.floor(sorted.length * 0.25)] : null),
    p75: r1(sorted.length ? sorted[Math.floor(sorted.length * 0.75)] : null),
    best: r1(sorted.length ? sorted[sorted.length - 1] : null),
    worst: r1(sorted.length ? sorted[0] : null),
    days,
    unseen: { n: unseen.length, median: r1(med(unseen)), total: sumSol(unseen) },
    seen: { n: seen.length, median: r1(med(seen)) },
    halves: { h1: { n: h1.length, median: r1(med(h1)) }, h2: { n: h2.length, median: r1(med(h2)) } },
    leader: {
      pnl: Math.round(weekPnl * 100) / 100,
      cost: Math.round(weekCost * 10) / 10,
      retPct: weekCost ? r1((weekPnl / weekCost) * 100) : null,
      win: week.length ? Math.round((week.filter((t) => t.pnl > 0).length / week.length) * 100) : null,
      medianHoldS: r1((med(week.map((t) => t.holdMs)) ?? 0) / 1000),
      medianCost: r1(med(week.map((t) => t.cost))),
      mints: new Set(week.map((t) => t.mint)).size,
      peakPerMin: peakPerMin(rd.swaps),
      activeDays: new Set(week.map((t) => dayOf(t.closedAt))).size,
    },
    checks: { ...checks, sniper, bundle, mintsChecked },
    credits: walletCredits,
    ms: Date.now() - t0,
  };
  fs.writeFileSync(path.join(OUT, TAG, `${addr.slice(0, 8)}.json`), JSON.stringify({ summary, rows }, null, 1));
  log(
    `${addr.slice(0, 8)} txs ${rd.txs} swaps ${rd.swaps.length} week ${week.length} fast ${summary.tooFast} sampled ${sample.length} priced ${filled.length} med ${summary.median01} mean ${summary.mean01} win ${summary.win01} total ${summary.total01} est ${summary.estWeekSol} ci [${summary.ciLo},${summary.ciHi}] unseen ${summary.unseen.n}/${summary.unseen.median} lead ${summary.leader.pnl} hold ${summary.leader.medianHoldS}s ppm ${summary.leader.peakPerMin} wash ${checks.washTrips} payers ${checks.sharedPayers} cr ${walletCredits} ${(summary.ms / 1000).toFixed(0)}s${stopped ? ' STOPPED ' + stopped : ''}${rd.message ? ' READ ' + rd.message : ''}`,
  );
  return summary;
}

async function main(): Promise<void> {
  log(`start ${TAG}: ${pool.length} wallets, sample ${SAMPLE}, cap ${CAP}, window ${new Date(since).toISOString()} → ${new Date(now).toISOString()}, floor ${FLOOR.toFixed(2)} %`);
  const results: Record<string, unknown>[] = [];
  let i = 0;
  const worker = async (): Promise<void> => {
    while (i < pool.length) {
      const p = pool[i++];
      if (credits > CAP) {
        log(`cap reached before ${p.address.slice(0, 8)}; skipping the rest`);
        return;
      }
      try {
        results.push(await one(p));
      } catch (e) {
        log(`${p.address.slice(0, 8)} FAILED ${(e as Error).message}`);
      }
    }
  };
  await Promise.all(Array.from({ length: PARALLEL }, worker));
  results.sort((a, b) => ((b.ciLo as number | null) ?? -999) - ((a.ciLo as number | null) ?? -999));
  fs.writeFileSync(path.join(OUT, `${TAG}-summary.json`), JSON.stringify({ now, since, floor: FLOOR, credits, calls, results }, null, 1));
  log(`done: ${results.length} wallets, ${credits} credits, ${calls} calls`);
  await sleep(2500);
  process.exit(0);
}
void main();
