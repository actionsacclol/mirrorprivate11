// Stage "size" of scripts/analysis/copy-candidates.mjs, which bundles and runs this file; see its header for the method and usage.
// Reprice a pass-2 wallet file at several copy sizes: the recorded return
// (1.5 %/side) under the paper cost model at each size, with the fee floor.
import fs from 'node:fs';
import { repriceReturn, feeFloorPct } from '@shared/walletScore';
import { copyCostModel } from '@shared/walletScout';
import { bootstrapMedianCI, median } from '@shared/stats';

const SIZES = [0.05, 0.1, 0.25, 0.5, 1, 2];
console.log('fee floor by copy size: ' + SIZES.map((s) => `${s} SOL ${feeFloorPct(copyCostModel('solana', s)).toFixed(2)} %`).join(' | '));
const m = copyCostModel('solana', 0.1);
console.log(`cost model: ${(m.side * 100).toFixed(2)} % a side, fixed ${((m.fixedPct / 100) * 0.1 * 1e3).toFixed(2)} mSOL a round trip (${m.fixedPct.toFixed(1)} % of 0.1 SOL)`);
const stat = (xs: number[]): string => {
  if (!xs.length) return '—';
  const s = [...xs].sort((a, b) => a - b);
  const mean = s.reduce((a, b) => a + b, 0) / s.length;
  const trimmedN = Math.max(0, Math.floor(s.length * 0.02));
  const t = s.slice(trimmedN, s.length - trimmedN);
  const tmean = t.reduce((a, b) => a + b, 0) / t.length;
  const win = (s.filter((x) => x > 0).length / s.length) * 100;
  return `n ${s.length} median ${(median(s) as number).toFixed(1)} mean ${mean.toFixed(1)} trimmed ${tmean.toFixed(1)} win ${win.toFixed(0)} % total/copy ${(mean / 100).toFixed(3)}×size`;
};
for (const file of process.argv.slice(2)) {
  const j = JSON.parse(fs.readFileSync(file, 'utf8')) as { summary: { address: string; weekTrips: number }; rows: Array<{ mint: string; ret: number | null; ret50: number | null; skippedCap: boolean; day: number; closedAt: number; cost: number; holdMs: number }> };
  console.log(`\n== ${j.summary.address} (${j.summary.weekTrips} trips in the week)`);
  for (const size of SIZES) {
    const cm = copyCostModel('solana', size);
    const rows = j.rows.filter((r) => r.ret50 !== null && !r.skippedCap);
    const xs = rows.map((r) => repriceReturn(r.ret50 as number, cm));
    const byMint = new Map<string, number[]>();
    rows.forEach((r, i) => byMint.set(r.mint, [...(byMint.get(r.mint) ?? []), xs[i]]));
    const ci = bootstrapMedianCI([...byMint.values()], 400, 11);
    const byDay = new Map<number, number[]>();
    rows.forEach((r, i) => byDay.set(r.day, [...(byDay.get(r.day) ?? []), xs[i]]));
    const days = [...byDay].sort((a, b) => a[0] - b[0]).map(([d, v]) => `${d}:${v.length}/${(v.reduce((a, b) => a + b, 0) / v.length).toFixed(0)}`);
    const totalSol = xs.reduce((a, x) => a + size * (x / 100), 0);
    console.log(`  ${String(size).padStart(4)} SOL copies (app rules): ${stat(xs)} | week total ${totalSol.toFixed(2)} SOL on ${(rows.length * size).toFixed(0)} SOL turned over | CI median ${ci ? `${ci.lo.toFixed(1)} … ${ci.hi.toFixed(1)}` : '—'} | days n/mean ${days.join(' ')}`);
  }
  const byCost = [0.5, 1, 2, 5].map((c) => `>=${c}: ${j.rows.filter((r) => r.cost >= c).length}`);
  console.log(`  leader trade sizes: ${byCost.join(' ')} of ${j.rows.length}; holds under 10 min: ${j.rows.filter((r) => r.holdMs < 600_000).length}`);
}
