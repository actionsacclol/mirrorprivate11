// Stage "split" of scripts/analysis/copy-candidates.mjs; see its header for the method and usage.
// Pass-5 analysis: each wallet's sampled week split into trips on the scanned
// winner coins (in-sample: the wallet was picked for them) and trips on every
// other coin (the honest test). Flags copy returns that beat the leader's own
// return by an impossible margin (a bad price print).
import fs from 'node:fs';
import path from 'node:path';

const OUT = process.env.OUT;
const TAG = process.env.TAG ?? 'pass5';
const scanCoins = new Set(JSON.parse(fs.readFileSync(path.join(OUT, 'scan-coins.json'), 'utf8')).map((c) => c.id));
const sum = JSON.parse(fs.readFileSync(path.join(OUT, `${TAG}-summary.json`), 'utf8'));
const stat = (rows) => {
  const xs = rows.map((r) => r.ret01).filter((x) => x !== null && x !== undefined);
  if (!xs.length) return { n: 0 };
  const s = [...xs].sort((a, b) => a - b);
  const mean = s.reduce((a, b) => a + b, 0) / s.length;
  return { n: s.length, mean: +mean.toFixed(1), median: +s[Math.floor(s.length / 2)].toFixed(1), win: Math.round((s.filter((x) => x > 0).length / s.length) * 100), total: +(s.reduce((a, x) => a + 0.1 * (x / 100), 0)).toFixed(3), best: +s[s.length - 1].toFixed(0), woBest: s.length > 1 ? +((mean * s.length - s[s.length - 1]) / (s.length - 1)).toFixed(1) : null };
};
const fmt = (o) => (o.n ? `n ${o.n} med ${o.median} mean ${o.mean} win ${o.win} total ${o.total} (w/o best ${o.woBest})` : 'n 0');
const out = [];
for (const r of sum.results) {
  const file = path.join(OUT, TAG, `${r.address.slice(0, 8)}.json`);
  if (!fs.existsSync(file)) {
    out.push({ address: r.address, skipped: r.stopped || r.readMessage || 'no file', weekTrips: r.weekTrips, leader: r.leader });
    continue;
  }
  const j = JSON.parse(fs.readFileSync(file, 'utf8'));
  const rows = j.rows.filter((x) => x.ret01 !== null);
  // A copy cannot beat the leader's own return by 300 points on the same trip: bad print.
  for (const x of rows) {
    const leadPct = x.cost > 0 ? (x.pnl / x.cost) * 100 : 0;
    x.suspect = x.ret01 > 150 && x.ret01 - leadPct > 300;
  }
  const clean = rows.filter((x) => !x.suspect);
  const inScan = clean.filter((x) => scanCoins.has(x.mint));
  const outScan = clean.filter((x) => !scanCoins.has(x.mint));
  out.push({
    address: r.address,
    sources: r.sources,
    weekTrips: r.weekTrips,
    truncated: r.truncated,
    sampled: r.sampled,
    priced: rows.length,
    suspect: rows.length - clean.length,
    all: stat(clean),
    inScan: stat(inScan),
    outScan: stat(outScan),
    unseen: r.unseen,
    ci: [r.ciLo, r.ciHi],
    leader: r.leader,
    checks: r.checks,
    estWeekSol: clean.length && r.weekTrips ? +((stat(clean).mean / 100) * 0.1 * r.weekTrips).toFixed(2) : null,
  });
}
fs.writeFileSync(path.join(OUT, `${TAG}-analysis.json`), JSON.stringify(out, null, 1));
const judged = out.filter((o) => !o.skipped && o.all.n >= 5).sort((a, b) => (b.outScan.total ?? -9) - (a.outScan.total ?? -9));
console.log(`${TAG}: ${out.length} wallets, ${judged.length} with >= 5 clean priced copies, credits ${sum.credits}`);
console.log('wallet   | week trips | hold | med buy | ALL (sampled)                                   | OUT OF SCAN (other coins)                        | IN SCAN | est week SOL @0.1 | lead SOL | ppm');
for (const o of judged) {
  console.log(`${o.address.slice(0, 8)} | ${String(o.weekTrips).padStart(5)}${o.truncated ? '+' : ' '} | ${String(o.leader.medianHoldS).padStart(5)}s | ${String(o.leader.medianCost).padStart(6)} | ${fmt(o.all).padEnd(48)} | ${fmt(o.outScan).padEnd(48)} | ${o.inScan.n ? `n ${o.inScan.n} mean ${o.inScan.mean}` : 'n 0'} | ${o.estWeekSol} | ${o.leader.pnl} | ${o.leader.peakPerMin}${o.suspect ? ` | suspect prints ${o.suspect}` : ''}`);
}
const positive = judged.filter((o) => o.all.total > 0);
const outPos = judged.filter((o) => o.outScan.n >= 3 && o.outScan.total > 0);
console.log(`\nweek-positive on the sample: ${positive.length} of ${judged.length}; positive on other coins too (>= 3 trips): ${outPos.length}: ${outPos.map((o) => o.address.slice(0, 8)).join(' ')}`);
const sk = out.filter((o) => o.skipped);
console.log(`skipped ${sk.length}: ${sk.map((o) => `${o.address.slice(0, 8)} (${o.skipped})`).join('; ')}`);
