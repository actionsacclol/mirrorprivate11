// Find wallets worth copying this week, judged from the chain the way the
// app would copy them (2 s lag, 0.1 SOL a copy, the paper cost model).
//
// WHY THIS SHAPE (docs/copy-candidates-2026-10-27.md)
//
// Ranking leaders by their own profit selects for speed: the wallets that
// make the most are first-block snipers whose edge is gone 2 s later. Ranking
// by what a COPY would have made, on the coins where copies could have made
// anything, is what found the two week-positive wallets of 2026-10-27.
//
// The trick that makes it affordable: read a coin's whole week ONCE and
// replay a lagged copy of every signing trader's trips on it from that one
// stream. 21 coins (about 42,000 credits) judged 7,828 wallets on the coins
// that went up. The best of them are then read across their whole week with
// the app's own pricer, because a wallet that looks good on the winners is
// usually a loser everywhere else (selection), and finally priced with every
// rule the app applies (half-sell exit, max three open, sniper and bundle
// flags). Expect a handful of survivors, every one carried by a few trips
// and often by one day; report the mean without the top five and the day
// split, not just the mean.
//
// STAGES (each writes into --out, default test/.copy-candidates/<today>)
//   coins   Jupiter's token lists -> scan-coins.json: pump coins <= 14 d old
//           with mcap >= 150 k and liquidity >= 20 k, plus 14-90 d runners
//           with mcap >= 1 M and 500 k daily volume. No credits.
//   scan    read each coin's week (cap --max-txs-coin, ~10 credits per 100
//           transactions) and replay every signer's trips -> winners-scan.json
//   pool    rank the scan by copy total, keep wallets with >= 2 priced trips,
//           median > 0, >= 50 % winners, median buy >= 0.1 SOL, hold >= 30 s,
//           not sniper-led; drop identical clusters -> pool.json (--top N)
//   replay  each pool wallet's whole week, --sample random trips priced with
//           the app's pricer (~900 credits a wallet at 50) -> replay-summary.json
//   split   in-scan vs out-of-scan trips, bad-print check (copy cannot beat
//           the leader by 300 points on the same trip) -> replay-analysis.json,
//           finalists-pool.json (week-positive on the sample)
//   rules   finalists with every app rule, up to --rules-sample trips each,
//           births read -> rules-summary.json
//   size    the finalists repriced at 0.05 … 2 SOL a copy (fee floor by size)
//   all     coins, scan, pool, replay, split, rules, size
//
// USAGE
//   node scripts/analysis/copy-candidates.mjs all
//   node scripts/analysis/copy-candidates.mjs all --observed "[20747,20748]"   # local day numbers the feed watched
//   node scripts/analysis/copy-candidates.mjs replay --wallets Addr1,Addr2     # judge given wallets, no discovery
//   node scripts/analysis/copy-candidates.mjs rules --pool path/to/pool.json
//
// The Helius key comes from HELIUS_API_KEY or the app's settings.json. The
// credits spent are NOT counted in the app's meter; the log prints them.
// Nothing here signs or sends anything.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const args = process.argv.slice(2);
const stage = args[0] && !args[0].startsWith('--') ? args[0] : 'all';
const argOf = (k, d) => {
  const i = args.indexOf(k);
  return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : d;
};
const today = new Date().toISOString().slice(0, 10);
const OUT = path.resolve(argOf('--out', path.join('test', '.copy-candidates', today)));
const DAYS = argOf('--days', '7');
const MAX_COINS_YOUNG = Number(argOf('--coins-young', '18'));
const MAX_COINS_RUNNERS = Number(argOf('--coins-runners', '8'));
const MAX_TXS_COIN = argOf('--max-txs-coin', '20000');
const TOP = Number(argOf('--top', '50'));
const SAMPLE = argOf('--sample', '50');
const RULES_SAMPLE = argOf('--rules-sample', '150');
const OBSERVED = argOf('--observed', '[]');
const POOL = argOf('--pool', null);
const WALLETS = argOf('--wallets', null);
const PARALLEL = argOf('--parallel', '2');
const CAP_REPLAY = argOf('--cap-replay', '60000');
const CAP_RULES = argOf('--cap-rules', '20000');

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');
fs.mkdirSync(path.join(OUT, '.bundles'), { recursive: true });
const log = (s) => console.log(`[copy-candidates] ${s}`);

async function bundle(name) {
  const outfile = path.join(OUT, '.bundles', `${name}.mjs`);
  await build({
    entryPoints: [path.join(HERE, `copy-candidates-${name}.entry.ts`)],
    bundle: true,
    format: 'esm',
    platform: 'node',
    absWorkingDir: ROOT,
    alias: { '@shared': './shared', '@app': './electron', electron: './test/electronstub.mjs' },
    external: ['ws', 'undici'],
    banner: { js: "import{createRequire}from 'module';const require=createRequire(import.meta.url);" },
    outfile,
    logLevel: 'warning',
  });
  return outfile;
}

function run(script, env, extraArgs = []) {
  const r = spawnSync(process.execPath, [script, ...extraArgs], { cwd: ROOT, stdio: 'inherit', env: { ...process.env, OUT, ...env } });
  if (r.status !== 0) throw new Error(`${path.basename(script)} exited ${r.status}${r.error ? `: ${r.error.message}` : ''}`);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function stageCoins() {
  const lists = ['toptraded/1h', 'toptraded/6h', 'toptraded/24h', 'toptrending/1h', 'toptrending/6h', 'toptrending/24h', 'toporganicscore/24h', 'recent'];
  const dir = path.join(OUT, 'jup');
  fs.mkdirSync(dir, { recursive: true });
  const seen = new Map();
  const now = Date.now();
  for (const l of lists) {
    let arr = [];
    try {
      const res = await fetch(`https://lite-api.jup.ag/tokens/v2/${l}?limit=100`);
      if (!res.ok) {
        log(`jupiter ${l}: HTTP ${res.status} (skipped)`);
        await sleep(2000);
        continue;
      }
      const j = await res.json();
      arr = Array.isArray(j) ? j : j.data ?? j.tokens ?? [];
      fs.writeFileSync(path.join(dir, `${l.replace('/', '-')}.json`), JSON.stringify(arr));
    } catch (e) {
      log(`jupiter ${l}: ${e.message} (skipped)`);
    }
    for (const t of arr) {
      const created = t.firstPool?.createdAt ?? t.createdAt ?? null;
      const ageD = created ? (now - Date.parse(created)) / 86_400_000 : null;
      const s = t.stats24h ?? {};
      const row = seen.get(t.id) ?? { id: t.id, symbol: t.symbol, launchpad: t.launchpad ?? '', created, ageD: ageD === null ? null : +ageD.toFixed(1), mcap: Math.round(t.mcap ?? 0), liq: Math.round(t.liquidity ?? 0), vol24: Math.round((s.buyVolume ?? 0) + (s.sellVolume ?? 0)), traders24: s.numTraders ?? 0, holders: t.holderCount ?? 0, lists: [] };
      row.lists.push(l);
      seen.set(t.id, row);
    }
    await sleep(2000);
  }
  const all = [...seen.values()];
  // Only coins the app can price and copy: pump.fun curve and PumpSwap.
  const isPump = (t) => t.id.endsWith('pump') || /pump/i.test(t.launchpad);
  const young = all.filter((t) => isPump(t) && t.ageD !== null && t.ageD <= 14 && t.mcap >= 150_000 && t.liq >= 20_000).sort((a, b) => b.mcap - a.mcap);
  const runners = all.filter((t) => isPump(t) && t.ageD !== null && t.ageD > 14 && t.ageD <= 90 && t.mcap >= 1_000_000 && t.vol24 >= 500_000).sort((a, b) => b.vol24 - a.vol24);
  const pick = [...young.slice(0, MAX_COINS_YOUNG), ...runners.slice(0, MAX_COINS_RUNNERS)];
  fs.writeFileSync(path.join(OUT, 'scan-coins.json'), JSON.stringify(pick, null, 1));
  log(`${all.length} tokens seen; ${young.length} young pump coins, ${runners.length} runners; picked ${pick.length} -> scan-coins.json (about ${pick.length * Math.ceil(Number(MAX_TXS_COIN) / 10)} credits to scan)`);
  for (const t of pick) log(`  ${t.symbol.padEnd(10)} ${t.id.slice(0, 8)} age ${t.ageD} d  mcap ${t.mcap}  liq ${t.liq}  vol24 ${t.vol24}`);
}

async function stageScan() {
  const b = await bundle('scan');
  run(b, { LIST: path.join(OUT, 'scan-coins.json'), MAX_TXS_COIN, PARALLEL, TAG: 'winners' });
}

function stagePool() {
  const j = JSON.parse(fs.readFileSync(path.join(OUT, 'winners-scan.json'), 'utf8'));
  const W = j.wallets.filter((r) => r.priced >= 2 && r.median01 > 0 && r.win01 >= 50 && r.snipes / r.trips <= 0.5 && r.medianEntrySol >= 0.1 && r.medianHoldS >= 30);
  const seen = new Map();
  const picked = [];
  for (const r of W) {
    // Several wallets with the same trips, sizes and returns are one bot.
    const key = `${r.trips}/${r.priced}/${r.best01}/${r.mean01}`;
    if (seen.has(key)) {
      seen.get(key).push(r.wallet);
      continue;
    }
    seen.set(key, [r.wallet]);
    picked.push(r);
  }
  const pool = picked.slice(0, TOP).map((r) => ({ address: r.wallet, sources: [`winners:${r.coins}c/${r.priced}t/${r.copyPnl01}`] }));
  fs.writeFileSync(path.join(OUT, 'pool.json'), JSON.stringify(pool, null, 1));
  const clusters = [...seen.values()].filter((v) => v.length > 1);
  log(`${j.wallets.length} ranked, ${W.length} qualify, ${clusters.length} clusters collapsed, pool ${pool.length} -> pool.json (about ${pool.length * 18 * Number(SAMPLE)} credits to replay)`);
}

function poolFromWallets() {
  const pool = WALLETS.split(',').map((a) => a.trim()).filter(Boolean).map((address) => ({ address, sources: ['given'] }));
  const file = path.join(OUT, 'pool-given.json');
  fs.writeFileSync(file, JSON.stringify(pool, null, 1));
  return file;
}

async function stageReplay() {
  const b = await bundle('replay');
  const pool = WALLETS ? poolFromWallets() : POOL ?? path.join(OUT, 'pool.json');
  run(b, { POOL: pool, SAMPLE, CAP: CAP_REPLAY, MAX_TXS: '4000', MIN_HOLD_S: '15', MAX_WEEK_TRIPS: '3000', DAYS, PARALLEL, OBSERVED, TAG: 'replay' });
}

function stageSplit() {
  if (!fs.existsSync(path.join(OUT, 'scan-coins.json'))) fs.writeFileSync(path.join(OUT, 'scan-coins.json'), '[]');
  run(path.join(HERE, 'copy-candidates-split.mjs'), { TAG: 'replay' });
  const a = JSON.parse(fs.readFileSync(path.join(OUT, 'replay-analysis.json'), 'utf8'));
  const finalists = a.filter((o) => !o.skipped && o.all.n >= 5 && o.all.total > 0).map((o) => ({ address: o.address, sources: [...(o.sources ?? []), `replay:+${o.all.total}`] }));
  fs.writeFileSync(path.join(OUT, 'finalists-pool.json'), JSON.stringify(finalists, null, 1));
  log(`${finalists.length} week-positive on the sample -> finalists-pool.json`);
}

async function stageRules() {
  const b = await bundle('rules');
  const pool = WALLETS ? poolFromWallets() : POOL ?? path.join(OUT, 'finalists-pool.json');
  run(b, { POOL: pool, SAMPLE: RULES_SAMPLE, CAP: CAP_RULES, MAX_TXS: '8000', DAYS, OBSERVED, TAG: 'rules' });
}

async function stageSize() {
  const b = await bundle('size');
  const dir = path.join(OUT, 'rules');
  const files = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith('.json')).map((f) => path.join(dir, f)) : [];
  if (!files.length) return log('no rules output to reprice');
  run(b, {}, files);
}

const stages = { coins: stageCoins, scan: stageScan, pool: stagePool, replay: stageReplay, split: stageSplit, rules: stageRules, size: stageSize };
const order = stage === 'all' ? ['coins', 'scan', 'pool', 'replay', 'split', 'rules', 'size'] : [stage];
for (const s of order) {
  if (!stages[s]) {
    console.error(`unknown stage ${s}; stages: ${Object.keys(stages).join(', ')}, all`);
    process.exit(2);
  }
  log(`== ${s} -> ${OUT}`);
  await stages[s]();
}
