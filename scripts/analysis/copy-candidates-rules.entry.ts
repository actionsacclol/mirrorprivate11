// Stage "rules" of scripts/analysis/copy-candidates.mjs, which bundles and runs this file; see its header for the method and usage.
// Pass 2: the finalists, every finished trip of the week priced from the
// chain, plus what the app's own copy rules would have done: the copy sells
// at the leader's FIRST sell of half or more of the position (minLeaderSellPct
// 50), and at most three copies are open at once (the pre-registered test's
// rule). Births are read for the sniper and launch-bundle checks.
import fs from 'node:fs';
import path from 'node:path';
import { getTransactionsForAddress, addressTxCredits } from '@app/chain/rpcClient';
import { decodeWalletSwap } from '@app/engine/walletSwap';
import * as chainPrice from '@app/engine/chainPrice';
import { buildTrips, sampleTrips, sampleSeed, swapChecks, replayReturn, markBirth, type ReplaySwap, type ReplayTrip } from '@shared/copyReplay';
import { repriceReturn, feeFloorPct, FOLLOWER_LAG_MS } from '@shared/walletScore';
import { copyCostModel, dayOf, SNIPER_SLOTS } from '@shared/walletScout';
import { bootstrapMedianCI, median } from '@shared/stats';

const env = (k: string, d: string): string => process.env[k] ?? d;
const OUT = env('OUT', '');
const pool = JSON.parse(fs.readFileSync(env('POOL', ''), 'utf8')) as Array<{ address: string; sources: string[] }>;
const CAP = Number(env('CAP', '60000'));
const MAX_TXS = Number(env('MAX_TXS', '20000'));
const DAYS = Number(env('DAYS', '7'));
const MAX_OPEN = Number(env('MAX_OPEN', '3'));
/** Trips priced per wallet: a uniform random sample of the week (all when 0). */
const SAMPLE = Number(env('SAMPLE', '0'));
const TRIP_PAR = 4;
const OBSERVED = new Set(JSON.parse(env('OBSERVED', '[]')) as number[]);
const TAG = env('TAG', 'pass2');
const settings = JSON.parse(fs.readFileSync(path.join(process.env.APPDATA as string, 'Krypto Copy', 'settings.json'), 'utf8'));
const HTTP = `https://mainnet.helius-rpc.com/?api-key=${String(process.env.HELIUS_API_KEY ?? settings.rpc.heliusApiKey).trim()}`;
chainPrice.init(path.join(OUT, 'cache'));
fs.mkdirSync(path.join(OUT, TAG), { recursive: true });
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
const med = (xs: number[]): number | null => median(xs);
const r1 = (x: number | null): number | null => (x === null ? null : Math.round(x * 10) / 10);
const sumSol = (xs: number[]): number => Math.round(xs.reduce((a, r) => a + 0.1 * (r / 100), 0) * 1000) / 1000;
const stat = (xs: number[]): { n: number; median: number | null; mean: number | null; win: number | null; total: number } => ({
  n: xs.length,
  median: r1(med(xs)),
  mean: r1(xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null),
  win: xs.length ? Math.round((xs.filter((r) => r > 0).length / xs.length) * 100) : null,
  total: sumSol(xs),
});

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

/** The slot and time of the first sell taking half or more of each position, keyed `${mint}:${openedAt}`. */
function firstHalfSells(swaps: readonly ReplaySwap[]): Map<string, { slot: number | null; at: number }> {
  const out = new Map<string, { slot: number | null; at: number }>();
  const pos = new Map<string, { tokens: number; cost: number; openedAt: number; half: { slot: number | null; at: number } | null }>();
  for (const s of [...swaps].sort((a, b) => a.at - b.at || (a.slot ?? 0) - (b.slot ?? 0) || (a.txIndex ?? 0) - (b.txIndex ?? 0))) {
    if (!(s.sol > 0) || !(s.tokens > 0)) continue;
    const p = pos.get(s.mint);
    if (s.isBuy) {
      if (p) {
        p.tokens += s.tokens;
        p.cost += s.sol;
      } else pos.set(s.mint, { tokens: s.tokens, cost: s.sol, openedAt: s.at, half: null });
      continue;
    }
    if (!p || p.tokens <= 0) continue;
    const share = Math.min(1, s.tokens / p.tokens);
    if (share >= 0.5 && !p.half) p.half = { slot: s.slot ?? null, at: s.at };
    const costOut = p.cost * share;
    p.cost -= costOut;
    p.tokens -= Math.min(s.tokens, p.tokens);
    if (p.tokens <= 0 || p.cost <= 1e-9) {
      if (p.half) out.set(`${s.mint}:${p.openedAt}`, p.half);
      pos.delete(s.mint);
    }
  }
  return out;
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

interface Row {
  mint: string;
  openedAt: number;
  closedAt: number;
  day: number;
  holdMs: number;
  cost: number;
  pnl: number;
  openSlot: number | null;
  closeSlot: number | null;
  half: number | null;
  note: string;
  ret: number | null;
  ret01: number | null;
  ret50: number | null;
  ret50_01: number | null;
  entryPx: number | null;
  exitPx: number | null;
  exit50Px: number | null;
  skippedCap: boolean;
  sinceBirth: number | null;
  bundle: boolean | null;
}

async function one(p: { address: string; sources: string[] }): Promise<Record<string, unknown>> {
  const addr = p.address;
  const t0 = Date.now();
  const rd = await readSwaps(addr);
  const built = buildTrips(rd.swaps);
  const halves = firstHalfSells(rd.swaps);
  const week = built.trips.filter((t) => t.closedAt >= since && t.closedAt < now).sort((a, b) => a.openedAt - b.openedAt);
  const checks = swapChecks(rd.swaps, addr);
  // The open cap: a copy is skipped while MAX_OPEN copies are still open.
  const skipped = new Set<ReplayTrip>();
  const open: number[] = [];
  for (const t of week) {
    while (open.length && open[0] + FOLLOWER_LAG_MS <= t.openedAt) open.shift();
    if (open.length >= MAX_OPEN) skipped.add(t);
    else {
      open.push(t.closedAt);
      open.sort((a, b) => a - b);
    }
  }
  // The open cap is judged on the whole week; the pricing on a sample of it.
  const chosen = SAMPLE > 0 && week.length > SAMPLE ? sampleTrips(week, SAMPLE, 'random', sampleSeed(addr + ':p2')).sort((a, b) => a.openedAt - b.openedAt) : week;
  const todo = chosen.filter((t) => t.note !== 'too-fast' && typeof t.openSlot === 'number' && typeof t.closeSlot === 'number');
  const half = new Map<ReplayTrip, { slot: number | null; at: number }>();
  for (const t of todo) {
    const h = halves.get(`${t.mint}:${t.openedAt}`);
    if (h && h.slot !== null && h.slot !== t.closeSlot) half.set(t, h);
  }
  const exit50 = new Map<ReplayTrip, number | null>();
  let next = 0;
  let fails = 0;
  let stopped = '';
  let walletCredits = 0;
  // A copy cannot return a million percent: such a fill is a mis-decoded
  // pool (an inverted or non-6-decimal pool on PumpSwap), left unpriced.
  let artifacts = 0;
  const sane = (ret: number | null): number | null => (ret !== null && Math.abs(ret) > 10_000 ? null : ret);
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
      if (!r.ok) {
        fails += 1;
        if (r.refused || fails >= 5) stopped = `read failed: ${r.message}`;
        continue;
      }
      fails = 0;
      if (r.entry !== null && r.exit !== null) {
        const ret = replayReturn(r.entry, r.exit);
        if (sane(ret) === null && ret !== null) artifacts += 1;
        else {
          t.entryPx = r.entry;
          t.exitPx = r.exit;
          t.returnPct = ret;
          if (t.returnPct !== null) {
            t.note = 'filled';
            t.source = 'chain';
          }
        }
      }
      const h = half.get(t);
      if (h && r.entry !== null) {
        let r2 = await chainPrice.priceTrip(HTTP, t.mint, t.openSlot as number, h.slot as number);
        for (let a = 0; !r2.ok && !r2.refused && a < 3; a++) {
          await sleep(1000 * (a + 1));
          r2 = await chainPrice.priceTrip(HTTP, t.mint, t.openSlot as number, h.slot as number);
        }
        calls += r2.calls;
        credits += r2.credits;
        walletCredits += r2.credits;
        if (r2.ok) exit50.set(t, r2.exit);
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(TRIP_PAR, todo.length) }, worker));
  let sniper = 0;
  let bundle = 0;
  let mintsChecked = 0;
  if (!stopped) {
    const byMint = new Map<string, ReplayTrip[]>();
    for (const t of chosen) if (t.note === 'filled') byMint.set(t.mint, [...(byMint.get(t.mint) ?? []), t]);
    for (const [mint, ts] of byMint) {
      if (credits > CAP) break;
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
  const rows: Row[] = chosen.map((t) => {
    const e50 = half.has(t) ? (exit50.get(t) ?? null) : t.exitPx;
    const ret50 = sane(t.entryPx !== null && e50 !== null ? replayReturn(t.entryPx, e50) : null);
    return {
      mint: t.mint,
      openedAt: t.openedAt,
      closedAt: t.closedAt,
      day: dayOf(t.closedAt),
      holdMs: t.holdMs,
      cost: t.cost,
      pnl: t.pnl,
      openSlot: t.openSlot ?? null,
      closeSlot: t.closeSlot ?? null,
      half: half.get(t)?.slot ?? null,
      note: t.note,
      ret: t.returnPct,
      ret01: t.returnPct === null ? null : repriceReturn(t.returnPct, m01),
      ret50,
      ret50_01: ret50 === null ? null : repriceReturn(ret50, m01),
      entryPx: t.entryPx,
      exitPx: t.exitPx,
      exit50Px: e50,
      skippedCap: skipped.has(t),
      sinceBirth: t.sinceBirth ?? null,
      bundle: t.bundle ?? null,
    };
  });
  const priced = rows.filter((r) => r.ret01 !== null);
  const all01 = priced.map((r) => r.ret01 as number);
  const cap01 = priced.filter((r) => !r.skippedCap).map((r) => r.ret01 as number);
  const all50 = rows.filter((r) => r.ret50_01 !== null).map((r) => r.ret50_01 as number);
  const cap50 = rows.filter((r) => r.ret50_01 !== null && !r.skippedCap).map((r) => r.ret50_01 as number);
  const byMintRet = new Map<string, number[]>();
  for (const r of priced) byMintRet.set(r.mint, [...(byMintRet.get(r.mint) ?? []), r.ret01 as number]);
  const ci = bootstrapMedianCI([...byMintRet.values()], 400, 7);
  const byMint50 = new Map<string, number[]>();
  for (const r of rows) if (r.ret50_01 !== null && !r.skippedCap) byMint50.set(r.mint, [...(byMint50.get(r.mint) ?? []), r.ret50_01]);
  const ci50 = bootstrapMedianCI([...byMint50.values()], 400, 7);
  const byDay = new Map<number, number[]>();
  for (const r of rows) if (r.ret50_01 !== null && !r.skippedCap) byDay.set(r.day, [...(byDay.get(r.day) ?? []), r.ret50_01]);
  const days = [...byDay].sort((a, b) => a[0] - b[0]).map(([d, xs]) => ({ day: d, seen: OBSERVED.has(d), ...stat(xs) }));
  const unseen = rows.filter((r) => r.ret50_01 !== null && !r.skippedCap && !OBSERVED.has(r.day)).map((r) => r.ret50_01 as number);
  const sorted = [...cap50].sort((a, b) => a - b);
  const weekPnl = week.reduce((a, t) => a + t.pnl, 0);
  const weekCost = week.reduce((a, t) => a + t.cost, 0);
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
    sampled: chosen.length,
    tooFast: chosen.filter((t) => t.note === 'too-fast').length,
    priced: priced.length,
    unpriceable: todo.length - priced.length,
    halfSellTrips: half.size,
    artifacts,
    skippedByCap: week.filter((t) => skipped.has(t)).length,
    /** Share of the week's trips the leader put at least 0.05 SOL into: a
     *  0.1 SOL copy of a 0.01 SOL trade is a bigger trade than the leader's. */
    costGe05Pct: week.length ? Math.round((week.filter((t) => t.cost >= 0.05).length / week.length) * 100) : null,
    stopped,
    finalSell: { all: stat(all01), ci: ci ? { lo: r1(ci.lo), hi: r1(ci.hi) } : null, cap: stat(cap01) },
    halfSell: { all: stat(all50), cap: stat(cap50), ci: ci50 ? { lo: r1(ci50.lo), hi: r1(ci50.hi) } : null },
    p10: r1(sorted.length ? sorted[Math.floor(sorted.length * 0.1)] : null),
    p25: r1(sorted.length ? sorted[Math.floor(sorted.length * 0.25)] : null),
    p75: r1(sorted.length ? sorted[Math.floor(sorted.length * 0.75)] : null),
    p90: r1(sorted.length ? sorted[Math.floor(sorted.length * 0.9)] : null),
    best: r1(sorted.length ? sorted[sorted.length - 1] : null),
    worst: r1(sorted.length ? sorted[0] : null),
    top5Share: sorted.length ? Math.round((sorted.slice(-5).reduce((a, b) => a + b, 0) / Math.max(1e-9, Math.abs(sorted.reduce((a, b) => a + b, 0)))) * 100) : null,
    days,
    unseen: stat(unseen),
    leader: {
      pnl: Math.round(weekPnl * 100) / 100,
      cost: Math.round(weekCost * 10) / 10,
      retPct: weekCost ? r1((weekPnl / weekCost) * 100) : null,
      win: week.length ? Math.round((week.filter((t) => t.pnl > 0).length / week.length) * 100) : null,
      medianHoldS: r1((med(week.map((t) => t.holdMs)) ?? 0) / 1000),
      medianCost: ((x) => (x === null ? null : Math.round(x * 1000) / 1000))(med(week.map((t) => t.cost))),
      mints: new Set(week.map((t) => t.mint)).size,
      peakPerMin: peakPerMin(rd.swaps),
      activeDays: new Set(week.map((t) => dayOf(t.closedAt))).size,
      firstTrade: rd.swaps.length ? new Date(Math.min(...rd.swaps.map((s) => s.at))).toISOString() : null,
      lastTrade: rd.swaps.length ? new Date(Math.max(...rd.swaps.map((s) => s.at))).toISOString() : null,
    },
    checks: { ...checks, sniper, bundle, mintsChecked },
    credits: walletCredits,
    ms: Date.now() - t0,
  };
  fs.writeFileSync(path.join(OUT, TAG, `${addr.slice(0, 8)}.json`), JSON.stringify({ summary, rows }, null, 1));
  log(
    `${addr.slice(0, 8)} txs ${rd.txs}${rd.truncated ? '+' : ''} week ${week.length} fast ${summary.tooFast} priced ${priced.length} | final med ${summary.finalSell.all.median} mean ${summary.finalSell.all.mean} win ${summary.finalSell.all.win} total ${summary.finalSell.all.total} ci [${summary.finalSell.ci?.lo},${summary.finalSell.ci?.hi}] | half+cap n ${summary.halfSell.cap.n} med ${summary.halfSell.cap.median} mean ${summary.halfSell.cap.mean} win ${summary.halfSell.cap.win} total ${summary.halfSell.cap.total} ci [${summary.halfSell.ci?.lo},${summary.halfSell.ci?.hi}] | skippedCap ${summary.skippedByCap} unseen ${summary.unseen.n}/${summary.unseen.median}/${summary.unseen.total} | lead ${summary.leader.pnl} hold ${summary.leader.medianHoldS}s ppm ${summary.leader.peakPerMin} snipe ${sniper}/${mintsChecked} bundle ${bundle} wash ${checks.washTrips} payers ${checks.sharedPayers} cr ${walletCredits} ${(summary.ms / 1000).toFixed(0)}s${stopped ? ' STOPPED ' + stopped : ''}${rd.message ? ' READ ' + rd.message : ''}`,
  );
  return summary;
}

async function main(): Promise<void> {
  log(`start ${TAG}: ${pool.length} wallets, cap ${CAP}, window ${new Date(since).toISOString()} → ${new Date(now).toISOString()}, floor ${FLOOR.toFixed(2)} %, max open ${MAX_OPEN}`);
  const results: Record<string, unknown>[] = [];
  for (const p of pool) {
    if (credits > CAP) {
      log(`cap reached before ${p.address.slice(0, 8)}`);
      break;
    }
    try {
      results.push(await one(p));
    } catch (e) {
      log(`${p.address.slice(0, 8)} FAILED ${(e as Error).message}`);
    }
  }
  fs.writeFileSync(path.join(OUT, `${TAG}-summary.json`), JSON.stringify({ now, since, floor: FLOOR, credits, calls, results }, null, 1));
  log(`done: ${results.length} wallets, ${credits} credits, ${calls} calls`);
  await sleep(2500);
  process.exit(0);
}
void main();
