// Re-derive the Scout's population prior under the old fill rule (first print
// at/after due, by anyone, avg price) and the new STATE rule (last print before
// due; dead coins at their last print), 1.5 %/side, 2 s lag, wallets >= 5 trips.
import fs from 'fs';
import readline from 'readline';
const file = process.argv[2];
const LAG = 2000, C = 0.015, STALE = 600_000;
const ret = (e, x) => ((x * (1 - C)) / (e * (1 + C)) - 1) * 100;
const pos = new Map();            // user|mint -> pos
const last = new Map();           // mint -> { at, price }
const pend = new Map();           // mint -> [{kind, due, ...}]
const trips = { old: new Map(), state: new Map() }; // user -> returns[]
let n = 0;
const push = (m, k, u, r) => { let a = trips[m].get(u); if (!a) trips[m].set(u, (a = [])); a.push(r); };
const addPend = (mint, p) => { let l = pend.get(mint); if (!l) pend.set(mint, (l = [])); l.push(p); };
function resolve(mint, price, at) {
  const l = pend.get(mint); const prev = last.get(mint);
  if (l) {
    const keep = [];
    for (const p of l) {
      if (at < p.due) { keep.push(p); continue; }
      const statePx = prev ? prev.price : price;   // state left by the last print before due
      const stale = at - p.due > STALE;
      if (p.kind === 'entry') {
        if (!stale) p.pos.oldEntry ??= price;      // OLD: first print at/after due (within stale)
        p.pos.stateEntry ??= statePx;
      } else {
        if (!stale && p.oldEntry) push('old', 0, p.u, ret(p.oldEntry, price));
        if (p.stateEntry) push('state', 0, p.u, ret(p.stateEntry, statePx));
      }
    }
    if (keep.length) pend.set(mint, keep); else pend.delete(mint);
  }
  last.set(mint, { at, price });
}
const rl = readline.createInterface({ input: fs.createReadStream(file, { highWaterMark: 1 << 22 }), crlfDelay: Infinity });
let first = true;
for await (const line of rl) {
  if (first) { first = false; continue; }
  const p = line.split(',');
  const at = +p[0], mint = p[1], u = p[2], isBuy = p[3] === '1', sol = +p[4], tok = +p[5];
  if (!(sol > 0) || !(tok > 0)) continue;
  n++;
  resolve(mint, sol / tok, at);
  const key = u + '|' + mint;
  let q = pos.get(key);
  if (isBuy) {
    if (q) { q.tokens += tok; q.cost += sol; }
    else { q = { tokens: tok, cost: sol, due: at + LAG, oldEntry: null, stateEntry: null }; pos.set(key, q); addPend(mint, { kind: 'entry', due: q.due, pos: q }); }
    continue;
  }
  if (!q || q.tokens <= 0) continue;
  const share = Math.min(1, tok / q.tokens);
  q.cost -= q.cost * share; q.tokens -= Math.min(tok, q.tokens);
  if (q.tokens <= 0 || q.cost <= 1e-9) {
    pos.delete(key);
    if (at < q.due) continue; // too fast: never entered (both rules)
    addPend(mint, { kind: 'exit', due: at + LAG, u, oldEntry: q.oldEntry, stateEntry: q.stateEntry });
  }
}
// End of file: every waiting STATE leg fills at the coin's last print (a curve
// always quotes); OLD legs with no print after due are unreachable.
for (const [mint, l] of pend) {
  const lp = last.get(mint);
  for (const p of l) if (p.kind === 'exit' && p.stateEntry && lp) push('state', 0, p.u, ret(p.stateEntry, lp.price));
}
const med = (a) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.floor(s.length / 2)] : NaN; };
for (const m of ['old', 'state']) {
  const all = []; const wm = []; let w = 0;
  for (const [, a] of trips[m]) if (a.length >= 5) { w++; wm.push(med(a)); for (const r of a) all.push(r); }
  console.log(`${file.split(/[\/]/).pop()} ${m}: ${n} prints, wallets>=5 ${w}, trips ${all.length}, pooled median ${med(all).toFixed(2)}%, median of wallet medians ${med(wm).toFixed(2)}%`);
}
