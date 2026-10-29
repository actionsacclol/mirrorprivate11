// Stage "scan" of scripts/analysis/copy-candidates.mjs, which bundles and runs this file; see its header for the method and usage.
// Winner-coin copy scan. For each coin that went up this week and still has
// a market, read the whole week of its trades once, then replay a lagged
// copy of EVERY signing trader's trips on it from that one stream: entry at
// the price 9 slots after their first buy, exit 9 slots after their first
// half-sell (the app's rule) or their last sell. Wallets are ranked by what
// the copies made, not by what they made. One coin read prices every wallet
// on it, so discovery costs a few thousand credits for thousands of wallets.
import fs from 'node:fs';
import path from 'node:path';
import { getTransactionsForAddress, addressTxCredits, resolveAccountKeys } from '@app/chain/rpcClient';
import * as chainPrice from '@app/engine/chainPrice';
import { copyCostModel } from '@shared/walletScout';
import { repriceReturn } from '@shared/walletScore';

const env = (k: string, d: string): string => process.env[k] ?? d;
const OUT = env('OUT', '');
const LIST = env('LIST', path.join(OUT, 'scan-coins.json'));
const MAX_TXS_COIN = Number(env('MAX_TXS_COIN', '20000'));
const PARALLEL = Number(env('PARALLEL', '2'));
const TAG = env('TAG', 'coins3');
const settings = JSON.parse(fs.readFileSync(path.join(process.env.APPDATA as string, 'Krypto Copy', 'settings.json'), 'utf8'));
const HTTP = `https://mainnet.helius-rpc.com/?api-key=${String(process.env.HELIUS_API_KEY ?? settings.rpc.heliusApiKey).trim()}`;
chainPrice.init(path.join(OUT, 'cache'));
const DAY = 86_400_000;
const LAG = chainPrice.LAG_SLOTS;
const M01 = copyCostModel('solana', 0.1);
const M05 = copyCostModel('solana', 0.5);
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const log = (s: string): void => {
  const line = `${new Date().toISOString().slice(11, 19)} ${s}`;
  console.log(line);
  fs.appendFileSync(path.join(OUT, `${TAG}.log`), line + '\n');
};

type Coin = { id: string; symbol: string; ageD: number; mcap: number; liq: number; vol24: number };
interface Trade { slot: number; seq: number; at: number; user: string; isBuy: boolean; sol: number; tokens: number; price: number; signer: boolean }
interface Trip {
  coin: string;
  symbol: string;
  entrySlot: number;
  entryAt: number;
  closeSlot: number;
  halfSlot: number;
  entrySol: number;
  cost: number;
  leaderPnl: number;
  buys: number;
  sells: number;
  sinceBirth: number | null;
  ret01: number | null;
  ret01Final: number | null;
  ret05: number | null;
  artifact: boolean;
}
interface WalletAgg {
  wallet: string;
  coins: Set<string>;
  trips: Trip[];
  open: number;
  untrackedSells: number;
}

let credits = 0;
const wallets = new Map<string, WalletAgg>();
const coinStats: Array<Record<string, unknown>> = [];

async function currentSlot(): Promise<number> {
  const res = await fetch(HTTP, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getSlot', params: [{ commitment: 'confirmed' }] }) });
  const body = (await res.json()) as { result?: number };
  if (typeof body.result !== 'number') throw new Error('getSlot failed');
  return body.result;
}

async function readCoin(c: Coin, weekAgoSlot: number): Promise<{ trades: Trade[]; txs: number; truncated: boolean; birth: number | null; spent: number }> {
  const b = await chainPrice.mintBirth(HTTP, c.id);
  credits += b.credits;
  let spent = b.credits;
  const birth = b.birth?.slot ?? null;
  const young = birth !== null && birth >= weekAgoSlot;
  const from = young ? (birth as number) : weekAgoSlot;
  const trades: Trade[] = [];
  let token: string | null = null;
  let txs = 0;
  let fails = 0;
  let truncated = false;
  for (;;) {
    const r = await getTransactionsForAddress(HTTP, c.id, { limit: 100, sortOrder: young ? 'asc' : 'desc', slot: { gte: from }, paginationToken: token });
    if (!r.ok || !r.data) {
      fails += 1;
      if (fails > 6 || r.refused) {
        log(`${c.symbol}: read stopped (${r.message ?? 'no data'})`);
        break;
      }
      await sleep(1500 * fails);
      continue;
    }
    fails = 0;
    const cr = addressTxCredits(r.data.txs.length);
    credits += cr;
    spent += cr;
    for (const tx of r.data.txs) {
      txs += 1;
      if (tx.meta?.err) continue;
      const keys = resolveAccountKeys(tx);
      const signers = tx.transaction?.message?.header?.numRequiredSignatures ?? 0;
      const slot = tx.slot;
      const at = (tx.blockTime ?? 0) * 1000;
      let seq = 0;
      for (const t of chainPrice.tradesOfTx(tx, c.id)) {
        const idx = keys.indexOf(t.user);
        trades.push({ slot, seq: seq++, at, user: t.user, isBuy: t.isBuy, sol: t.sol, tokens: t.tokens, price: t.price, signer: idx >= 0 && idx < signers });
      }
    }
    token = r.data.paginationToken;
    if (!token || r.data.txs.length < 100) break;
    if (txs >= MAX_TXS_COIN) {
      truncated = true;
      break;
    }
  }
  trades.sort((a, b) => a.slot - b.slot || a.seq - b.seq);
  return { trades, txs, truncated, birth, spent };
}

function replayCoin(c: Coin, trades: Trade[], birth: number | null): { traders: number; trips: number } {
  const slots = trades.map((t) => t.slot);
  const prices = trades.map((t) => t.price);
  const priceAt = (slot: number): number | null => {
    let lo = 0;
    let hi = slots.length - 1;
    let best = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (slots[mid] <= slot) {
        best = mid;
        lo = mid + 1;
      } else hi = mid - 1;
    }
    return best < 0 ? null : prices[best];
  };
  interface Pos { held: number; maxHeld: number; cost: number; entrySlot: number; entryAt: number; entrySol: number; halfSlot: number | null; leaderPnl: number; buys: number; sells: number }
  const pos = new Map<string, Pos>();
  let trips = 0;
  const traders = new Set<string>();
  for (const t of trades) {
    if (!t.signer) continue;
    traders.add(t.user);
    let w = wallets.get(t.user);
    if (!w) wallets.set(t.user, (w = { wallet: t.user, coins: new Set(), trips: [], open: 0, untrackedSells: 0 }));
    w.coins.add(c.id);
    let p = pos.get(t.user);
    if (t.isBuy) {
      if (!p || p.held <= p.maxHeld * 0.01) {
        p = { held: 0, maxHeld: 0, cost: 0, entrySlot: t.slot, entryAt: t.at, entrySol: t.sol, halfSlot: null, leaderPnl: 0, buys: 0, sells: 0 };
        pos.set(t.user, p);
      }
      p.held += t.tokens;
      p.maxHeld = Math.max(p.maxHeld, p.held);
      p.cost += t.sol;
      p.buys += 1;
      continue;
    }
    if (!p || p.held <= 0) {
      w.untrackedSells += 1;
      continue;
    }
    const sellTokens = Math.min(t.tokens, p.held);
    const solOut = t.tokens > 0 ? t.sol * (sellTokens / t.tokens) : 0;
    const basis = p.cost * (sellTokens / p.held);
    p.leaderPnl += solOut - basis;
    p.cost -= basis;
    if (p.halfSlot === null && sellTokens >= 0.5 * p.held) p.halfSlot = t.slot;
    p.held -= sellTokens;
    p.sells += 1;
    if (p.held <= p.maxHeld * 0.01) {
      const halfSlot = p.halfSlot ?? t.slot;
      const pe = priceAt(p.entrySlot + LAG);
      const ph = priceAt(halfSlot + LAG);
      const px = priceAt(t.slot + LAG);
      const rec = (entry: number | null, exit: number | null): number | null => (entry && exit && entry > 0 && exit > 0 ? ((exit * 0.985) / (entry * 1.015) - 1) * 100 : null);
      const rHalf = rec(pe, ph);
      const rFinal = rec(pe, px);
      const artifact = (rHalf !== null && Math.abs(rHalf) > 10_000) || (rFinal !== null && Math.abs(rFinal) > 10_000);
      w.trips.push({
        coin: c.id,
        symbol: c.symbol,
        entrySlot: p.entrySlot,
        entryAt: p.entryAt,
        closeSlot: t.slot,
        halfSlot,
        entrySol: p.entrySol,
        cost: p.cost + basis,
        leaderPnl: p.leaderPnl,
        buys: p.buys,
        sells: p.sells,
        sinceBirth: birth === null ? null : p.entrySlot - birth,
        ret01: artifact || rHalf === null ? null : repriceReturn(rHalf, M01),
        ret01Final: artifact || rFinal === null ? null : repriceReturn(rFinal, M01),
        ret05: artifact || rHalf === null ? null : repriceReturn(rHalf, M05),
        artifact,
      });
      trips += 1;
      pos.delete(t.user);
    }
  }
  for (const [user, p] of pos) if (p.held > p.maxHeld * 0.01) (wallets.get(user) as WalletAgg).open += 1;
  return { traders: traders.size, trips };
}

const med = (xs: number[]): number | null => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
};

async function main(): Promise<void> {
  const coins = JSON.parse(fs.readFileSync(LIST, 'utf8')) as Coin[];
  const nowSlot = await currentSlot();
  const weekAgoSlot = nowSlot - Math.round((7 * DAY) / chainPrice.SLOT_MS);
  log(`start ${TAG}: ${coins.length} coins, cap ${MAX_TXS_COIN} txs a coin, lag ${LAG} slots, now slot ${nowSlot}`);
  let i = 0;
  const worker = async (): Promise<void> => {
    while (i < coins.length) {
      const c = coins[i++];
      const t0 = Date.now();
      try {
        const r = await readCoin(c, weekAgoSlot);
        const rep = replayCoin(c, r.trades, r.birth);
        coinStats.push({ ...c, txs: r.txs, trades: r.trades.length, truncated: r.truncated, birth: r.birth, traders: rep.traders, trips: rep.trips, credits: r.spent });
        log(`${c.symbol.padEnd(10)} ${c.id.slice(0, 8)} age ${c.ageD}d mcap ${c.mcap} txs ${r.txs}${r.truncated ? '+' : ''} trades ${r.trades.length} signers ${rep.traders} trips ${rep.trips} cr ${r.spent} ${Math.round((Date.now() - t0) / 1000)}s total ${credits}`);
      } catch (e) {
        log(`${c.symbol}: failed ${(e as Error).message}`);
      }
    }
  };
  await Promise.all(Array.from({ length: PARALLEL }, () => worker()));
  const rows = [...wallets.values()]
    .map((w) => {
      const closed = w.trips.filter((t) => t.ret01 !== null);
      const r01 = closed.map((t) => t.ret01 as number);
      const r01f = w.trips.filter((t) => t.ret01Final !== null).map((t) => t.ret01Final as number);
      const r05 = closed.map((t) => t.ret05 as number);
      const snipes = w.trips.filter((t) => t.sinceBirth !== null && t.sinceBirth <= 5).length;
      return {
        wallet: w.wallet,
        coins: w.coins.size,
        trips: w.trips.length,
        priced: closed.length,
        open: w.open,
        untrackedSells: w.untrackedSells,
        artifacts: w.trips.filter((t) => t.artifact).length,
        snipes,
        copyPnl01: +r01.reduce((a, x) => a + 0.1 * (x / 100), 0).toFixed(4),
        copyPnl01Final: +r01f.reduce((a, x) => a + 0.1 * (x / 100), 0).toFixed(4),
        copyPnl05: +r05.reduce((a, x) => a + 0.5 * (x / 100), 0).toFixed(4),
        mean01: r01.length ? +(r01.reduce((a, x) => a + x, 0) / r01.length).toFixed(1) : null,
        median01: med(r01) === null ? null : +(med(r01) as number).toFixed(1),
        win01: r01.length ? Math.round((r01.filter((x) => x > 0).length / r01.length) * 100) : null,
        best01: r01.length ? +Math.max(...r01).toFixed(1) : null,
        meanWithoutBest: r01.length > 1 ? +(([...r01].sort((a, b) => a - b).slice(0, -1).reduce((a, x) => a + x, 0)) / (r01.length - 1)).toFixed(1) : null,
        leaderPnl: +w.trips.reduce((a, t) => a + t.leaderPnl, 0).toFixed(3),
        medianEntrySol: +(med(w.trips.map((t) => t.entrySol)) ?? 0).toFixed(3),
        medianHoldS: Math.round(((med(w.trips.map((t) => (t.closeSlot - t.entrySlot) * chainPrice.SLOT_MS)) ?? 0) as number) / 1000),
        days: new Set(w.trips.map((t) => Math.floor(t.entryAt / DAY))).size,
        symbols: [...new Set(w.trips.map((t) => t.symbol))].join(' '),
        trip: w.trips.map((t) => ({ s: t.symbol, at: new Date(t.entryAt).toISOString().slice(5, 16), holdS: Math.round(((t.closeSlot - t.entrySlot) * chainPrice.SLOT_MS) / 1000), in: +t.entrySol.toFixed(3), lead: +t.leaderPnl.toFixed(3), r01: t.ret01, r01f: t.ret01Final, birth: t.sinceBirth })),
      };
    })
    .filter((r) => r.priced >= 1);
  rows.sort((a, b) => b.copyPnl01 - a.copyPnl01);
  fs.writeFileSync(path.join(OUT, `${TAG}-scan.json`), JSON.stringify({ credits, coins: coinStats, wallets: rows.slice(0, 400) }, null, 1));
  const positive = rows.filter((r) => r.copyPnl01 > 0);
  log(`done: ${credits} credits; signing traders with a closed priced trip ${rows.length}; copy-positive at 0.1 SOL ${positive.length} (${Math.round((positive.length / rows.length) * 100)} %); with >= 2 trips ${rows.filter((r) => r.priced >= 2).length}, of which copy-positive ${positive.filter((r) => r.priced >= 2).length}; with >= 5 trips ${rows.filter((r) => r.priced >= 5).length}, of which copy-positive ${positive.filter((r) => r.priced >= 5).length}`);
  await sleep(1500);
  process.exit(0);
}
void main();
