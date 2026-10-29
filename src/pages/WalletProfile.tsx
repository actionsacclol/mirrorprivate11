// A wallet's profile (2026-10-22) — everything the app knows about one
// wallet, laid out to answer "should I follow this one?".
//
// The top says it in a sentence: copyable or not, and what a copier would
// actually have kept. Under it, side by side, what THEY did and what a COPY
// of them would have got, their results over time, how long they hold, how
// the copies' results spread, the checks behind the Copy score, and every
// recent trade. If you already follow them, what your copies did is here too.
//
// Same record and the same shared functions as the leaderboard (summarise,
// scoreOfRow), so the profile cannot disagree with its row. A wallet the feed
// never saw can be read from the chain (Solana).
//
// Chain first (2026-10-25). The record is what the live feed carried: for one
// wallet 12 trades in a week where the chain held 508, and its marks read
// +17 % where a replay of the newest 30 read −21 %. So once the chain has
// spoken — a replay finished here, or the board's chain check — the verdict
// and the copy panel lead with the chain's figure and state the feed's as
// what the feed saw. Opening a Solana profile reads the wallet from the chain
// on its own (once a session; no pricing), so the record is at least whole.

import { useEffect, useMemo, useRef, useState } from 'react';
import { ArrowLeft, Bookmark, BookmarkCheck, Check, ExternalLink, Loader2, Plus, RefreshCw } from 'lucide-react';
import { FOLLOWER_LAG_MS, SCORE_MIN_F_TRIPS, feeFloorPct, repriceReturn } from '@shared/walletScore';
import {
  BOT_TRADES_PER_MIN,
  MIN_TRIPS_FOR_RANK,
  SCOUT_FAST_WALLET_PCT,
  SCOUT_WINDOW_DAYS,
  SCOUT_WINDOW_LABEL,
  copyCostModel,
  dayOf,
  emptyRow,
  scoreOfRow,
  summarise,
  type ScoutChain,
  type ScoutTrip,
  type ScoutWallet,
  type ScoutWindow,
  type WalletReadStatus,
} from '@shared/walletScout';
import { paperSideCost, winRate } from '@shared/copytrade';
import type { PumpUser } from '@shared/pumpLookup';
import { useAppState } from '../state/AppStateProvider';
import { BOARD_SIZES, useBoardSize } from '../state/boardSize';
import { useNav } from '../state/nav';
import { useCopySnapshot } from '../state/useCopy';
import { useAddressBook } from '../state/useAddressBook';
import { BookEditor, BookLine } from '../components/copy/BookEditor';
import { openTokenExternally, openWalletExternally } from '../utils/links';
import { RowTags } from '../components/copy/WalletTags';
import { ReplayPanel, type ReplayResult } from '../components/copy/ReplayPanel';
import { FeedLossNote } from '../components/copy/FeedLossNote';
import { AddressChip, Avatar, Bars, DASH, DayStrip, Fact, LineChart, Meter, Panel, ScoreRing, Segmented, Tag, btn, fmtAmt, fmtHold, fmtPctS, short, toneOf } from '../ui/kit';
import { cls, fmtAgo } from '../utils/format';

const UNIT: Record<ScoutChain, string> = { solana: 'SOL', robinhood: 'ETH', bnb: 'BNB' };

/**
 * The chain's figure for a copy of this wallet, when one exists: a replay
 * finished this session (their newest trades, summed at the page's size),
 * else the board's last chain check (a random sample of the week's trades,
 * repriced to the size). Null until the chain has been read.
 */
interface ChainView {
  source: 'replay' | 'label';
  at: number;
  /** Median follower return over the priced copies, %, at the size; null under five. */
  medianPct: number | null;
  winRatePct: number | null;
  /** Copies priced, out of the trips the source looked at. */
  priced: number;
  trips: number;
  /** Trips over before a copy could land — the replay counts them; the board's check does not. */
  tooFast: number | null;
}

/** What the live feed's own marks say, in one clause, beside the chain's figure. */
function feedSawLine(r: ReturnType<typeof summarise>): string {
  const seen = `${r.fTrips} of their ${r.roundTrips} finished trades in this window`;
  if (r.fastWallet) return `The live feed saw ${seen} and gives no figure for a wallet this fast.`;
  if (r.fMedianReturnPct !== null) return `The live feed saw ${seen} and read ${fmtPctS(r.fMedianReturnPct, { signed: true })} per copy on those — set aside: it misses trades and fills at the last mark it carried.`;
  return `The live feed priced ${seen}.`;
}

/** The one-sentence answer: the chain's figure when there is one, the measured record otherwise. */
function verdict(r: ReturnType<typeof summarise>, cv: ChainView | null): { head: string; body: string; tone: 'up' | 'down' | 'warn' | 'neutral' } {
  if (r.looksAutomated) {
    const byRate = r.peakPerMin !== null && r.peakPerMin >= BOT_TRADES_PER_MIN;
    return {
      head: 'Probably a bot — too fast to copy',
      body: byRate
        ? `They made ${r.peakPerMin} trades inside one minute — ${BOT_TRADES_PER_MIN} or more is past what a person clicks. A copy lands seconds after each one, so it would be trading different prices from theirs.`
        : `Their typical trade lasts ${fmtHold(r.medianHoldMs)}. A copy lands seconds after them, so it would be buying and selling different prices from theirs.`,
      tone: 'warn',
    };
  }
  // The chain leads (2026-10-25): every trade, priced to the slot, against a
  // record of whatever the feed happened to carry.
  if (cv && cv.medianPct !== null) {
    const v = cv.medianPct;
    const at = r.sizeSol !== null ? `At ${r.sizeSol} SOL a copy, that is` : 'That is';
    const sample = cv.source === 'replay' ? `their newest ${cv.trips} finished trades` : `a random sample of their ${cv.trips} finished trades this week`;
    const how = `${at} the median over ${cv.priced} copies priced from ${sample}, each read from the chain and filled ${FOLLOWER_LAG_MS / 1000} s behind both legs, with the fees paper charges. ${feedSawLine(r)}`;
    const thin = cv.priced < SCORE_MIN_F_TRIPS ? ` Only ${cv.priced} copies priced — a handful of trades swings a lot.` : '';
    return v < 0
      ? {
          head: `Read from the chain: copies would have lost ${fmtPctS(Math.abs(v))} per trade`,
          body: `${how} This is normal: across the whole market, even the least-bad wallets lose per copied trade.${thin}`,
          tone: 'down',
        }
      : {
          head: `Read from the chain: copies would have kept ${fmtPctS(v, { signed: true })} per trade`,
          body: `${how} Past trades, not a forecast — try it on paper first.${thin}`,
          tone: 'neutral',
        };
  }
  if (r.roundTrips === 0 && r.buys + r.sells === 0) {
    return { head: 'No trades on record in this window', body: 'Widen the window, or read their recent trades from the chain below.', tone: 'neutral' };
  }
  if (!r.ranked) {
    return {
      head: 'Too few trades to judge',
      body: `${r.roundTrips} finished trade${r.roundTrips === 1 ? '' : 's'} in this window — under ${MIN_TRIPS_FOR_RANK}, any result is mostly luck.`,
      tone: 'neutral',
    };
  }
  if (r.reachablePct !== null && r.reachablePct < 25) {
    return {
      head: 'Mostly too fast to copy',
      body: `A copy could have got into only ${Math.round(r.reachablePct)}% of their trades — the rest were over before it could land.`,
      tone: 'warn',
    };
  }
  // No live figure for a fast wallet (SCOUT_FAST_WALLET_PCT): the marks fill
  // a copy at the last print before its due time, and on a trade over inside
  // a minute that is the leader's own print, or a stale one.
  if (r.fastWallet) {
    return {
      head: 'Too fast for the live feed to price — the chain can',
      body: `${Math.round(r.fastPct ?? 0)}% of their measured trades are over inside a minute. The feed's marks cannot price a copy of trades that short, so no live figure is given. Replay below prices a copy of each trade from the chain, to the slot.`,
      tone: 'warn',
    };
  }
  if (r.fMedianReturnPct !== null) {
    const v = r.fMedianReturnPct;
    const at = r.sizeSol !== null ? `At ${r.sizeSol} SOL a copy, ` : '';
    const how = `the median over ${r.fTrips} trades a copy could have joined, ${FOLLOWER_LAG_MS / 1000} s behind them, with the swap fees and network fees paper charges. Slippage is not modelled, so real copies do a little worse.`;
    // Under SCORE_MIN_F_TRIPS copies the figure is shown but not trusted:
    // five lucky trades read +50 % on 10-22 and topped the board.
    const thin = r.fTrips < SCORE_MIN_F_TRIPS ? ` Only ${r.fTrips} copies — too few to rank; it needs ${SCORE_MIN_F_TRIPS}.` : '';
    return v < 0
      ? {
          head: `${at}copies would have lost ${fmtPctS(Math.abs(v))} per trade`,
          body: `That is ${how} This is normal: across the whole market, even the least-bad wallets lose per copied trade.${thin}`,
          tone: 'down',
        }
      : {
          // Never green (2026-10-22): the same ranking still lost money on
          // held-out data. It reads as "least bad", not as "profitable".
          head: `${at}copies would have kept ${fmtPctS(v, { signed: true })} per trade`,
          body: `That is ${how} Past results, not a forecast — try it on paper first.${thin}`,
          tone: 'neutral',
        };
  }
  return {
    head: 'Not enough copyable trades measured yet',
    body: `${r.fTrips} of their trades have been priced for a copier so far; the score needs ${MIN_TRIPS_FOR_RANK}. Keep recording, or scan the last hours on Discover.`,
    tone: 'neutral',
  };
}

/**
 * What the headline does not say on its own (2026-10-22): a good copier
 * figure built on trades that last seconds, on one day, or on a handful of
 * trades is weaker than it reads, and the page says so beside it.
 */
function cautions(r: ReturnType<typeof summarise>, windowDays: number, trips: readonly ScoutTrip[], cv: ChainView | null): string[] {
  const out: string[] = [];
  if (r.looksAutomated || !r.ranked) return out;
  // The feed's sample is beside the point once the chain's figure leads.
  const chainLeads = cv !== null && cv.medianPct !== null;
  // How long the whole record took: eleven trips inside four minutes is one
  // burst, not a track record, however good its numbers look.
  if (trips.length >= MIN_TRIPS_FOR_RANK) {
    const spanMs = Math.max(...trips.map((t) => t.closedAt)) - Math.min(...trips.map((t) => t.openedAt));
    if (spanMs < 60 * 60_000) out.push(`Their last ${trips.length} finished trades all happened within ${fmtHold(spanMs)} — one burst, not a track record.`);
  }
  // Said in the verdict itself once the share makes it a fast wallet.
  if (r.fastPct !== null && r.fastPct >= SCOUT_FAST_WALLET_PCT && !r.fastWallet && !chainLeads) {
    out.push(
      `${Math.round(r.fastPct)}% of their trades are over in under a minute. A copy lands seconds behind, so on those it buys and sells at different prices from theirs — the margin is thin.`,
    );
  }
  if (windowDays >= 3 && r.activeDays <= 1) out.push('All of it comes from a single day. One good day is luck until there are more.');
  if (!chainLeads && r.fTrips > 0 && r.fTrips < 20) out.push(`Only ${r.fTrips} copyable trade${r.fTrips === 1 ? '' : 's'} measured — a small sample swings a lot.`);
  if (r.flags.includes('concentrated')) out.push('Most trades are on the same few coins.');
  return out;
}

const HOLD_BUCKETS: Array<{ label: string; max: number }> = [
  { label: '<10s', max: 10_000 },
  { label: '10s–1m', max: 60_000 },
  { label: '1–5m', max: 300_000 },
  { label: '5–30m', max: 1_800_000 },
  { label: '30m–3h', max: 10_800_000 },
  { label: '3h+', max: Infinity },
];
const RETURN_BUCKETS: Array<{ label: string; max: number; tone: string }> = [
  { label: '≤−50%', max: -50, tone: 'text-down' },
  { label: '−50…−20', max: -20, tone: 'text-down' },
  { label: '−20…0', max: 0, tone: 'text-down' },
  { label: '0…20', max: 20, tone: 'text-up' },
  { label: '20…50', max: 50, tone: 'text-up' },
  { label: '>50%', max: Infinity, tone: 'text-up' },
];

const NOTE: Record<ScoutTrip['followerNote'], string> = {
  filled: '',
  'too-fast': 'over before a copy could land',
  'no-entry': 'nothing to buy at after them',
  'no-exit': 'no price to sell at yet',
  unpriced: 'read from chain — not priced',
};

export function WalletProfile({ address, chain: chainIn, onBack }: { address: string; chain: ScoutChain; onBack: () => void }) {
  const nav = useNav();
  const { settings } = useAppState();
  const { snap } = useCopySnapshot();
  // A 0x wallet is looked up on whichever EVM chain is switched on.
  const chain: ScoutChain = chainIn === 'solana' ? 'solana' : settings.evm.robinhood.enabled ? 'robinhood' : 'bnb';
  const unit = UNIT[chain];
  const [win, setWin] = useState<ScoutWindow>('week');
  // Your address-book name for them (2026-10-28).
  const named = useAddressBook().nameOf(address);
  const [wallet, setWallet] = useState<ScoutWallet | null>(null);
  const [saved, setSaved] = useState(false);
  const [loading, setLoading] = useState(true);
  const [refresh, setRefresh] = useState(0);
  const [read, setRead] = useState<WalletReadStatus | null>(null);
  const [symbols, setSymbols] = useState<Record<string, string>>({});
  // Their pump.fun account, when the wallet has one (2026-10-23): one public
  // read per profile, cached in main; nothing shown when there is none.
  const [pump, setPump] = useState<PumpUser | null>(null);
  useEffect(() => {
    setPump(null);
    if (chain !== 'solana') return;
    let alive = true;
    void window.krypt.scout.pumpUser(address).then((r) => alive && r.ok && r.data && setPump(r.data));
    return () => {
      alive = false;
    };
  }, [chain, address]);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    void window.krypt.scout.detail(chain, address).then((r) => {
      if (!alive) return;
      setLoading(false);
      if (r.ok && r.data) {
        setWallet(r.data.wallet);
        setSaved(r.data.saved);
      }
    });
    return () => {
      alive = false;
    };
  }, [chain, address, refresh]);

  // A chain read moves every second while it runs; the record is read again
  // when it ends. A wallet not read this session is read now (2026-10-25):
  // the record is otherwise whatever the feed carried, and the page would
  // judge them on it. No pricing — the free RPC's last week or a Helius
  // key's last 30 days, about 100 credits. Once per wallet, not per render.
  const autoRead = useRef<string | null>(null);
  useEffect(() => {
    if (chain !== 'solana') return;
    let alive = true;
    void window.krypt.scout.readWalletStatus(chain, address).then((r) => {
      if (!alive || !r.ok || !r.data) return;
      if (r.data.startedAt !== null) return void setRead(r.data);
      if (autoRead.current === address) return;
      autoRead.current = address;
      void window.krypt.scout.readWallet(chain, address).then((x) => alive && x.ok && x.data && setRead(x.data));
    });
    return () => {
      alive = false;
    };
  }, [chain, address]);
  const reading = read?.running === true;
  useEffect(() => {
    if (!reading) return;
    const id = setInterval(() => {
      void window.krypt.scout.readWalletStatus(chain, address).then((r) => {
        if (!r.ok || !r.data) return;
        setRead(r.data);
        if (!r.data.running) setRefresh((n) => n + 1);
      });
    }, 1_000);
    return () => clearInterval(id);
  }, [reading, chain, address]);
  const startRead = async (): Promise<void> => {
    const r = reading ? await window.krypt.scout.readWalletCancel(chain, address) : await window.krypt.scout.readWallet(chain, address);
    if (r.ok && r.data) setRead(r.data);
  };

  const trips = useMemo(() => wallet?.recentTrips ?? [], [wallet]);
  useEffect(() => {
    if (chain !== 'solana' || !trips.length) return;
    const mints = [...new Set(trips.map((t) => t.mint))];
    void window.krypt.market.summaries(mints).then((r) => {
      if (!r.ok || !r.data) return;
      const out: Record<string, string> = {};
      for (const [m, s] of Object.entries(r.data as Record<string, { symbol?: string }>)) if (s?.symbol) out[m] = s.symbol;
      setSymbols(out);
    });
  }, [chain, trips]);

  const [size, setSize] = useBoardSize();
  const row = useMemo(() => (wallet ? summarise(wallet, win, Date.now(), { sizeSol: size }) : emptyRow(chain, address, win)), [wallet, win, chain, address, size]);
  const span = SCOUT_WINDOW_DAYS[win];
  // The days of this window the market was actually watched (summarise).
  const windowDays = row.spanDays;
  const score = useMemo(() => scoreOfRow(row, windowDays >= 3 ? windowDays : null), [row, windowDays]);
  // The chain's word, when it has spoken: this session's replay first (the
  // panel below hands its figures up), else the board's last check.
  const [replay, setReplay] = useState<ReplayResult | null>(null);
  const chainView = useMemo<ChainView | null>(() => {
    if (chain !== 'solana') return null;
    if (replay) {
      const s = replay.summary;
      return { source: 'replay', at: replay.status.finishedAt ?? Date.now(), medianPct: s.medianPct, winRatePct: s.winRatePct, priced: s.copied, trips: s.trips, tooFast: s.tooFast };
    }
    const l = row.chainLabel;
    if (l && l.chainTrips > 0) {
      return {
        source: 'label',
        at: l.at,
        medianPct: l.medianPct === null ? null : repriceReturn(l.medianPct, copyCostModel(chain, row.sizeSol)),
        winRatePct: null,
        priced: l.priced,
        trips: l.chainTrips,
        tooFast: null,
      };
    }
    return null;
  }, [chain, replay, row.chainLabel, row.sizeSol]);
  const v = verdict(row, chainView);
  const warn = cautions(row, windowDays, trips, chainView);
  // What the last chain read found, in one clause, for the copy panel.
  const readLine =
    read && !read.running && read.finishedAt !== null && read.swaps > 0
      ? ` Read from the chain ${fmtAgo(read.finishedAt)}: ${read.swaps} swaps over the last ${read.via === 'helius' ? '30 days' : 'week'}, ${read.duplicates} of them the feed had already seen.`
      : '';

  // Their realised result by day over the window (oldest first), and the
  // running total — what the chart draws.
  const days = useMemo(() => {
    if (!wallet) return [];
    const today = dayOf(Date.now());
    const from = span === null ? -Infinity : today - (span - 1);
    return [...wallet.days].filter((d) => d.day >= from).sort((a, b) => a.day - b.day);
  }, [wallet, span]);
  // By day once there are three days to draw; before that a two-point "curve"
  // filled the panel as one block (2026-10-22), so it draws trade by trade —
  // the recent finished trades, from zero.
  const byTrade = days.length < 3 && trips.length >= 2;
  const curve = useMemo(() => {
    let run = 0;
    if (byTrade) {
      const pts = [...trips].sort((a, b) => a.closedAt - b.closedAt).map((t) => ({ t: t.closedAt, v: (run += t.pnl) }));
      return [{ t: pts[0].t - 1, v: 0 }, ...pts];
    }
    const pts = days.map((d) => ({ t: d.day * 86_400_000, v: (run += d.pnl) }));
    if (pts.length === 1) pts.unshift({ t: pts[0].t - 86_400_000, v: 0 });
    return pts;
  }, [days, trips, byTrade]);

  const holdBars = useMemo(() => {
    const n = HOLD_BUCKETS.map(() => 0);
    for (const t of trips) n[HOLD_BUCKETS.findIndex((b) => t.holdMs < b.max)] += 1;
    return HOLD_BUCKETS.map((b, i) => ({ label: b.label, value: n[i], tone: i < 2 ? 'text-warn' : 'text-accent' }));
  }, [trips]);
  const returnBars = useMemo(() => {
    const n = RETURN_BUCKETS.map(() => 0);
    for (const t of trips) if (t.followerReturnPct !== null) n[RETURN_BUCKETS.findIndex((b) => (t.followerReturnPct as number) <= b.max)] += 1;
    return RETURN_BUCKETS.map((b, i) => ({ label: b.label, value: n[i], tone: b.tone }));
  }, [trips]);

  const config = snap?.configs.find((c) => c.wallet.toLowerCase() === address.toLowerCase()) ?? null;
  const myStats = config ? snap?.stats[config.id] : undefined;
  const theirSince = snap?.leaders[config?.wallet ?? ''];

  const toggleSave = async (): Promise<void> => {
    const r = await window.krypt.scout.save(chain, address, !saved);
    if (r.ok) setSaved(!saved);
  };

  return (
    <div className="h-full overflow-auto" data-testid="wallet-profile">
      <div className="mx-auto w-full max-w-[1240px] px-8 pb-12 pt-6">
        <button onClick={onBack} className={cls(btn.ghost, '-ml-3')}>
          <ArrowLeft className="h-4 w-4" /> Discover
        </button>

        <div className="mt-3 flex flex-wrap items-center gap-4">
          <Avatar address={address} size={56} label={config?.label || named || undefined} />
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <h1 className="text-[22px] font-semibold text-white">{config?.label || named || (pump?.isPumpUser ? `@${pump.username}` : short(address, 6))}</h1>
              <RowTags r={row} />
              {config && <Tag tone="accent">following · {config.mode}</Tag>}
            </div>
            <div className="mt-1 flex flex-wrap items-center gap-3 text-body text-krypt-muted">
              <AddressChip address={address} n={8} />
              {pump?.isPumpUser && (
                <button
                  onClick={() => void window.krypt.app.openExternal(`https://pump.fun/profile/${encodeURIComponent(pump.username)}`)}
                  className="hover:text-white hover:underline"
                  title="Their pump.fun profile. This page copies the wallet the account signs in with; they may also trade from others."
                  data-testid="profile-pump-user"
                >
                  pump.fun @{pump.username}
                  {pump.followers !== null ? ` · ${pump.followers.toLocaleString()} followers` : ''}
                  {pump.banned ? ' · banned' : ''}
                </button>
              )}
              {wallet && <span>first seen {fmtAgo(wallet.firstSeen)} · last trade {fmtAgo(wallet.lastSeen)}</span>}
            </div>
            <BookLine address={address} className="mt-1.5" />
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <BookEditor address={address} suggest={config?.label || (pump?.isPumpUser ? `@${pump.username}` : '')} />
            <button onClick={() => openWalletExternally(address, chain)} className={btn.secondary} title="Check it on the chain's explorer">
              <ExternalLink className="h-4 w-4" /> Explorer
            </button>
            <button onClick={() => void toggleSave()} className={btn.secondary}>
              {saved ? <BookmarkCheck className="h-4 w-4 text-accent" /> : <Bookmark className="h-4 w-4" />}
              {saved ? 'Saved' : 'Save'}
            </button>
            {config ? (
              <button onClick={() => nav.go('following')} className={btn.secondary}>
                <Check className="h-4 w-4" /> Manage follow
              </button>
            ) : (
              <button onClick={() => nav.follow(address)} className={btn.primary} data-testid="profile-follow">
                <Plus className="h-4 w-4" /> Follow on paper
              </button>
            )}
          </div>
        </div>

        <div className="mt-6 flex flex-wrap items-center justify-between gap-3">
          <Segmented value={win} onChange={setWin} options={(['day', 'week', 'month', 'all'] as ScoutWindow[]).map((w) => ({ value: w, label: SCOUT_WINDOW_LABEL[w] }))} />
          {chain === 'solana' && (
            <div className="flex items-center gap-3">
              {read && (
                <span className="text-body text-krypt-muted" data-testid="profile-read-status">
                  {read.running
                    ? read.via === 'helius'
                      ? `Reading via Helius… ${read.read} transactions`
                      : `Reading… ${read.read}/${read.signatures} transactions`
                    : `Read ${read.swaps} swaps ${read.via === 'helius' ? 'from the last 30 days via Helius' : 'from the last week'}, ${read.fed} new`}
                </span>
              )}
              <button
                onClick={() => void startRead()}
                className={btn.secondary}
                title="Read their recent swaps straight from the chain — runs on its own the first time a profile opens in a session; this reads again. On the free RPC: the last week, up to 200 transactions, a few minutes. With a Helius key (Settings): the last 30 days, up to 1,000, in seconds — about 100 credits. Prices nothing; Replay below does that."
              >
                {reading ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
                {reading ? 'Stop reading' : 'Read from chain'}
              </button>
            </div>
          )}
        </div>

        {loading && !wallet ? (
          <div className="flex items-center justify-center gap-2 py-24 text-note text-krypt-muted">
            <Loader2 className="h-4 w-4 animate-spin" /> Reading their record…
          </div>
        ) : (
          <>
            <div
              className={cls(
                'mt-4 flex items-center gap-5 rounded-xl border p-5',
                v.tone === 'up' ? 'border-up/25 bg-up/[0.06]' : v.tone === 'down' ? 'border-down/25 bg-down/[0.05]' : v.tone === 'warn' ? 'border-warn/25 bg-warn/[0.06]' : 'border-white/8 bg-card',
              )}
              data-testid="profile-verdict"
            >
              <ScoreRing score={row.copyScore} size={72} stroke={6} />
              <div className="min-w-0">
                <div className="text-body text-krypt-muted">Copy score {row.copyScore === null ? '— not enough data' : `${row.copyScore} of 100`}</div>
                <div className="mt-0.5 text-[18px] font-semibold text-white">{v.head}</div>
                <p className="mt-1 max-w-3xl text-note leading-relaxed text-krypt-muted">{v.body}</p>
                {warn.length > 0 && (
                  <ul className="mt-2 space-y-1" data-testid="profile-cautions">
                    {warn.map((w) => (
                      <li key={w} className="flex gap-2 text-body leading-relaxed text-warn">
                        <span aria-hidden="true">•</span>
                        {w}
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </div>
            <FeedLossNote where="this record" />

            <div className="mt-6 grid gap-6 lg:grid-cols-2">
              <Panel title="What they did" subtitle={`${SCOUT_WINDOW_LABEL[win]}, their own trades.`}>
                <div className="grid grid-cols-2 gap-x-6 gap-y-4 sm:grid-cols-3">
                  <Fact label="Profit" value={row.roundTrips > 0 ? fmtAmt(row.pnl, { signed: true, unit }) : DASH} tone={toneOf(row.roundTrips > 0 ? row.pnl : null)} />
                  <Fact label="Return" value={fmtPctS(row.returnPct, { signed: true })} tone={toneOf(row.returnPct)} />
                  <Fact label="Win rate" value={fmtPctS(row.winRatePct, { digits: 0 })} />
                  <Fact label="Finished trades" value={String(row.roundTrips)} hint={`${row.buys} buys, ${row.sells} sells`} />
                  <Fact label="Typical hold" value={fmtHold(row.medianHoldMs)} tone={row.medianHoldMs !== null && row.medianHoldMs < 60_000 ? 'text-warn' : undefined} />
                  <Fact
                    label="Days active"
                    value={windowDays >= 2 ? `${row.activeDays} of ${windowDays}` : String(row.activeDays)}
                    hint="Days with a finished trade, out of the days this app watched the market in the window."
                  />
                  <Fact label="Coins traded" value={String(row.distinctMints || DASH)} />
                  <Fact label="Volume" value={fmtAmt(row.volume, { unit })} />
                  <Fact label="Holding now" value={wallet ? `${wallet.openCount} coin${wallet.openCount === 1 ? '' : 's'}` : DASH} hint="Open positions are not valued here — a big winner still held makes them look worse than they are." />
                </div>
              </Panel>
              <Panel
                title="What a copy of them would have got"
                subtitle={`${
                  chainView
                    ? `From the chain (${chainView.source === 'replay' ? 'replay' : 'the board’s check'} ${fmtAgo(chainView.at)}): each copy ${FOLLOWER_LAG_MS / 1000} s behind both legs`
                    : `From the live feed’s marks: ${FOLLOWER_LAG_MS / 1000} s behind each trade`
                }, ${(paperSideCost(chain) * 100).toFixed(2)}% swap fees each way${row.fixedCostPct > 0 ? `, network fees ${row.fixedCostPct.toFixed(1)}% of a ${row.sizeSol} SOL copy` : ''}.`}
                action={chain === 'solana' ? <Segmented size="sm" value={size} onChange={setSize} options={BOARD_SIZES.map((s) => ({ value: s, label: `${s}` }))} /> : undefined}
              >
                <div className="grid grid-cols-2 gap-x-6 gap-y-4 sm:grid-cols-3" data-testid={chainView ? 'profile-copy-chain' : 'profile-copy-feed'}>
                  {chainView ? (
                    <>
                      <Fact
                        label="Result per trade"
                        value={fmtPctS(chainView.medianPct, { signed: true })}
                        tone={toneOf(chainView.medianPct)}
                        hint={chainView.medianPct === null ? 'Under five copies priced — no median.' : 'Median over the copies the chain priced, at this size.'}
                      />
                      <Fact
                        label="Copies that won"
                        value={fmtPctS(chainView.winRatePct, { digits: 0 })}
                        hint={chainView.source === 'label' ? 'The board’s check keeps the median only — replay below for the rest.' : undefined}
                      />
                      <Fact
                        label="Copies priced"
                        value={`${chainView.priced} of ${chainView.trips}`}
                        hint={chainView.source === 'replay' ? `Their newest ${chainView.trips} finished trades, both legs priced.` : `A random sample of their ${chainView.trips} finished trades this week.`}
                      />
                      {chainView.tooFast !== null ? (
                        <Fact label="Too fast to copy" value={String(chainView.tooFast)} tone={chainView.tooFast > chainView.priced ? 'text-warn' : undefined} hint="Over before a copy two seconds behind could land." />
                      ) : (
                        <Fact label="Over in under a minute" value={fmtPctS(row.fastPct, { digits: 0 })} tone={row.fastPct !== null && row.fastPct >= SCOUT_FAST_WALLET_PCT ? 'text-warn' : undefined} />
                      )}
                    </>
                  ) : (
                    <>
                      <Fact
                        label="Result per trade"
                        value={fmtPctS(row.fMedianReturnPct, { signed: true })}
                        tone={toneOf(row.fMedianReturnPct)}
                        hint={row.fastWallet ? 'No live figure for a wallet this fast — see below.' : 'Median over the trades a copy could join'}
                      />
                      <Fact label="Copies that won" value={fmtPctS(row.fWinRatePct, { digits: 0 })} />
                      <Fact
                        label="Trades a copy could join"
                        value={row.reachablePct === null ? DASH : `${row.fTrips} of ${row.judgedTrips}`}
                        tone={row.reachablePct !== null && row.reachablePct < 25 ? 'text-warn' : undefined}
                        hint={
                          row.roundTrips > row.judgedTrips
                            ? `${row.roundTrips} finished trades in the window; ${row.roundTrips - row.judgedTrips} not priced by the feed (read from the chain, or waiting for an exit print).`
                            : undefined
                        }
                      />
                      <Fact label="Over in under a minute" value={fmtPctS(row.fastPct, { digits: 0 })} tone={row.fastPct !== null && row.fastPct >= SCOUT_FAST_WALLET_PCT ? 'text-warn' : undefined} />
                    </>
                  )}
                  <Fact
                    label="A copy that goes nowhere"
                    value={fmtPctS(feeFloorPct({ side: paperSideCost(chain), fixedPct: row.fixedCostPct }), { signed: true })}
                    hint="Fees alone, price unchanged from buy to sell, at this size. Compare the result per trade with this, not with zero."
                  />
                </div>
                <p className="mt-4 text-body leading-relaxed text-krypt-muted" data-testid="profile-feed-saw">
                  {chainView ? (
                    <>
                      <span className="text-white">What the live feed saw:</span> {row.fTrips} of their {row.roundTrips} finished trades in this window
                      {row.fMedianReturnPct !== null ? `, ${fmtPctS(row.fMedianReturnPct, { signed: true })} per copy on those` : row.fastWallet ? ', no figure — too fast for its marks' : ''}. The
                      feed misses trades and fills at the last mark it carried, so the chain’s figure above leads.{readLine}
                    </>
                  ) : (
                    <>
                      {row.fastWallet
                        ? `No live figure: ${Math.round(row.fastPct ?? 0)}% of their measured trades are over inside a minute, and the feed’s marks cannot price a copy of trades that short. Replay below prices them from the chain. `
                        : ''}
                      Priced the way paper trading prices your copies, at the size picked above — network fees are a fixed amount per trade, so they take a
                      bigger share of a small copy. Slippage is not modelled, so these figures are, if anything, kind to the copier.
                      {readLine ? `${readLine} The figures above come from the ${row.fTrips} trades the feed priced; Replay below prices the rest.` : ''}
                    </>
                  )}
                </p>
              </Panel>
            </div>

            {chain === 'solana' && <ReplayPanel address={address} size={size} symbols={symbols} onResult={setReplay} />}

            <div className="mt-6 grid gap-6 lg:grid-cols-3">
              <Panel
                className="lg:col-span-2"
                title="Their profit over time"
                subtitle={byTrade ? `Realised, trade by trade — their last ${trips.length} finished trades.` : 'Realised, by the day each trade closed.'}
              >
                <LineChart
                  points={curve}
                  height={200}
                  format={(x) => fmtAmt(x, { signed: true, unit })}
                  label={byTrade ? (t) => new Date(t).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : undefined}
                  empty="No finished trades in this window."
                />
                {days.length > 1 && (
                  <div className="mt-4">
                    <DayStrip days={days.map((d) => ({ day: d.day, pnl: d.pnl }))} />
                  </div>
                )}
              </Panel>
              <Panel title="Why this score" subtitle={`${score.resolved} of ${score.total} checks measured.`}>
                <div className="space-y-3">
                  {score.checks.map((c) => (
                    <div key={c.id} title={c.note}>
                      <div className="flex items-baseline justify-between gap-2 text-note">
                        <span className="text-white">{c.label}</span>
                        <span className="tabular-nums text-krypt-muted">{c.value}</span>
                      </div>
                      <div className="mt-1">
                        <Meter value={c.points} tone={c.points === null ? 'accent' : c.points >= 60 ? 'up' : c.points >= 35 ? 'warn' : 'down'} />
                      </div>
                      <p className="mt-1 text-body leading-snug text-krypt-muted">{c.note}</p>
                    </div>
                  ))}
                </div>
              </Panel>
            </div>

            {trips.length > 0 && (
              <div className="mt-6 grid gap-6 lg:grid-cols-2">
                <Panel title="How long they hold" subtitle={`Their last ${trips.length} finished trades. Amber is faster than a copy can follow.`}>
                  <Bars data={holdBars} />
                </Panel>
                <Panel title="How copies of those trades ended" subtitle="Each copyable trade's result for a copier, after fees.">
                  <Bars data={returnBars} />
                </Panel>
              </div>
            )}

            {config && myStats && (
              <Panel className="mt-6" title="Your copies of them" subtitle={`Since you followed them, ${config.mode}.`}>
                <div className="grid grid-cols-2 gap-x-6 gap-y-4 sm:grid-cols-5">
                  <Fact label="Copies" value={String(myStats.trades)} />
                  <Fact label="Result" value={myStats.wins + myStats.losses ? fmtAmt(myStats.realizedPnlSol, { signed: true, unit }) : DASH} tone={toneOf(myStats.wins + myStats.losses ? myStats.realizedPnlSol : null)} />
                  <Fact label="Won" value={winRate(myStats) === null ? DASH : `${Math.round(winRate(myStats) as number)}%`} />
                  <Fact label="Open" value={String(myStats.openCount)} />
                  <Fact label="Skipped by your filters" value={String(myStats.skipped + myStats.blocked)} />
                </div>
                {theirSince && theirSince.roundTrips > 0 && (
                  <p className="mt-4 text-body text-krypt-muted">
                    Over the same time they made {fmtAmt(theirSince.realizedPnlSol, { signed: true, unit })} on {theirSince.roundTrips} finished trades. The gap between
                    their result and yours is what following costs.
                  </p>
                )}
              </Panel>
            )}

            <Panel className="mt-6" title="Recent trades" subtitle="Their newest finished trades, and what a copy of each would have done." bodyClass="!px-0">
              {trips.length === 0 ? (
                <p className="px-5 text-note text-krypt-muted">
                  No finished trades on record.{chain === 'solana' ? ' Read from chain above to fill it in.' : ''}
                </p>
              ) : (
                <div>
                  <div className="grid grid-cols-[minmax(140px,1.4fr)_repeat(5,minmax(80px,1fr))] gap-3 border-b border-white/8 px-5 pb-2 text-body text-krypt-muted">
                    <span>Coin</span>
                    <span className="text-right">Closed</span>
                    <span className="text-right">Held</span>
                    <span className="text-right">They put in</span>
                    <span className="text-right">They made</span>
                    <span className="text-right">A copy made</span>
                  </div>
                  {trips.slice(0, 40).map((t, i) => (
                    <div key={`${t.mint}${t.closedAt}${i}`} className="grid grid-cols-[minmax(140px,1.4fr)_repeat(5,minmax(80px,1fr))] items-center gap-3 border-b border-white/[0.05] px-5 py-2.5 text-note last:border-b-0">
                      <button onClick={() => openTokenExternally(t.mint, chain)} className="truncate text-left font-medium text-white hover:underline" title={t.mint}>
                        {symbols[t.mint] ?? short(t.mint, 4)}
                      </button>
                      <span className="text-right text-krypt-muted">{fmtAgo(t.closedAt)}</span>
                      <span className={cls('text-right tabular-nums', t.holdMs < 60_000 ? 'text-warn' : 'text-white')}>{fmtHold(t.holdMs)}</span>
                      <span className="text-right tabular-nums text-white">{fmtAmt(t.cost)}</span>
                      <span className={cls('text-right tabular-nums', toneOf(t.pnl))}>{fmtAmt(t.pnl, { signed: true })}</span>
                      <span className={cls('text-right tabular-nums', toneOf(t.followerReturnPct))} title={NOTE[t.followerNote] || undefined}>
                        {t.followerReturnPct !== null ? fmtPctS(t.followerReturnPct, { signed: true }) : <span className="text-body text-krypt-muted">{NOTE[t.followerNote] || DASH}</span>}
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </Panel>
          </>
        )}
      </div>
    </div>
  );
}
