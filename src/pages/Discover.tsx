// Discover (2026-10-22) — find a wallet worth following, and research it.
//
// The leaderboard opens on one question — "who is best to COPY?" — ranked by
// what a copier would have kept after the lag and the fees, with the wallets
// nobody can copy (bots, three-trade records, trips over before a follower
// could land) filtered out. Other views are one click: most profitable, most
// active, most recent, saved. Every row opens a full profile; up to three
// can be compared side by side.
//
// The data comes from Krypto Bot's Scout, unchanged: the live trade feed
// records wallets as they trade, and a Scan reads the last hours at once.
// Nothing here predicts; the page says so where it matters.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Bookmark, BookmarkCheck, Check, GitCompare, Loader2, Play, Plus, Radio, ScanSearch, Search, SlidersHorizontal, Square, Users, X } from 'lucide-react';
import { DEFAULT_FOMO_MIN_WALLETS, defaultConfig } from '@shared/copytrade';
import { EVM_CHAIN_META } from '@shared/evm';
import { RELIABLE_COPIES, SCORE_MIN_F_TRIPS, feeFloorPct, repriceReturn, type ShrinkPrior } from '@shared/walletScore';

import {
  MIN_TRIPS_FOR_RANK,
  SCOUT_FILTERS,
  SCOUT_FILTER_TEXT,
  BOARD_RANDOM_DRAWS,
  SCOUT_PICKS_N,
  SCOUT_RANK_SORT,
  SCOUT_RECORD_MIN_COPIES,
  passesScoutFilter,
  SCOUT_SCAN_HOURS,
  SCOUT_WINNERS_HOURS,
  WINNERS_SCAN_MAX_COINS,
  recentScanCredits,
  winnersCoinCredits,
  winnersCoinsAffordable,
  winnersScanCredits,
  SCOUT_WINDOW_DAYS,
  SCOUT_WINDOW_LABEL,
  applyScoutFilters,
  copyCostModel,
  scoreOfRow,
  scoutFiltersAllOff,
  scoutFiltersAllOn,
  clearsFloor,
  shortlistVerdict,
  type BoardRecord,
  type BoardWeek,
  type ChainLabel,
  type LabelStatus,
  type Scorecard,
  type ScoutChain,
  type ScoutFilter,
  type ScoutRow,
  type ScoutScanHours,
  type ScoutScanStatus,
  type ScoutSort,
  type ScoutWindow,
} from '@shared/walletScout';
import { DEFAULT_BACKTEST_CREDITS, backtestCreditsLeft, type CreditUsage } from '@shared/credits';
import { useAppState } from '../state/AppStateProvider';
import { BOARD_SIZES, useBoardSize } from '../state/boardSize';
import { useToast } from '../state/ToastProvider';
import { useNav } from '../state/nav';
import { useAddressBook } from '../state/useAddressBook';
import { resolveWalletInput } from '../utils/walletInput';
import { WalletProfile } from './WalletProfile';
import { RowTags } from '../components/copy/WalletTags';
import { PumpBoard } from '../components/copy/PumpBoard';
import { PreregPanel } from '../components/copy/PreregPanel';
import { FeedLossNote } from '../components/copy/FeedLossNote';
import { Avatar, CheckChip, DASH, Meter, ScoreRing, SearchBox, Segmented, Tag, btn, fmtAmt, fmtHold, fmtPctS, short, toneOf } from '../ui/kit';
import { cls, fmtAgo } from '../utils/format';

type View = 'best' | 'copier' | 'winners' | 'profit' | 'active' | 'pump' | 'saved' | 'test';

const VIEWS: Array<{ value: View; label: string; sort: ScoutSort; filters: () => Record<ScoutFilter, boolean>; blurb: string }> = [
  {
    value: 'best',
    label: 'Best to copy',
    sort: 'fLowerPct',
    filters: scoutFiltersAllOn,
    blurb:
      'Least bad to copy first: what a copier kept, pulled toward this week’s market by how few trades stand behind it, and ranked on the LOWER end of what that figure could be — so five lucky trades cannot top the list. Bots, thin records and wallets too fast to follow are taken out.',
  },
  {
    value: 'copier',
    label: 'Copier return',
    sort: 'fLowerPct',
    filters: () => ({ ...scoutFiltersAllOff(), ranked: true }),
    blurb: 'The same ranking with only the "Enough trades" filter: every wallet a copy has a record for, fast ones included.',
  },
  {
    value: 'winners',
    label: 'Week total',
    sort: 'fSumPct',
    filters: () => ({ ...scoutFiltersAllOff(), hideBots: true, ranked: true, reachable: true, clean: true }),
    blurb:
      'What copies of every trade made over the window, added up. The search that found this week’s copyable wallets ranked on this, not the median: a positive total over a negative median is a wallet carried by a few trades, and each row says what is left without its best five. Fill the record first with “Scan the week’s winners” — the coins that went up are where copies could have made anything.',
  },
  {
    value: 'profit',
    label: 'Most profitable',
    sort: 'pnl',
    filters: scoutFiltersAllOff,
    blurb: 'What the wallet itself made. The top of this list is mostly fast traders and bots a copy cannot keep up with — compare it with Best to copy.',
  },
  {
    value: 'active',
    label: 'Most active',
    sort: 'roundTrips',
    filters: () => ({ ...scoutFiltersAllOff(), hideBots: true }),
    blurb: 'Most finished trades in the window, bots left out. A bigger record says more than a lucky few trades.',
  },
  {
    value: 'pump',
    label: 'pump.fun top',
    sort: 'pnl',
    filters: scoutFiltersAllOff,
    blurb:
      'pump.fun’s own leaderboard: its top 100 wallets by what they made themselves over the last day, week or month. Replay the top of it to see what copying them would have done.',
  },
  { value: 'saved', label: 'Saved', sort: 'fLowerPct', filters: scoutFiltersAllOff, blurb: 'Wallets you saved. Saved wallets are never dropped from the record.' },
  {
    value: 'test',
    label: 'The test',
    sort: 'fLowerPct',
    filters: scoutFiltersAllOn,
    blurb: 'The pre-registered test: does copying this board’s picks beat random wallets, pump.fun’s leaderboard, the fee floor and copying nobody? Frozen before each week, settled from the chain after it, eight weeks to a verdict.',
  },
];

/**
 * Why the board is empty, in one sentence: the filter that hides the most of
 * the record, by name and count (2026-10-22 — "widen the window, or loosen
 * the filters" told nobody which one, and often neither would help).
 */
function filterBlame(rows: readonly ScoutRow[], f: Record<ScoutFilter, boolean>): string {
  const on = SCOUT_FILTERS.filter((k) => f[k]);
  const hid = on.map((k) => ({ k, n: rows.filter((r) => !passesScoutFilter(r, k)).length })).sort((a, b) => b.n - a.n);
  if (!hid.length || hid[0].n === 0) return 'Widen the window, or loosen the filters.';
  const top = hid[0];
  const ranked = rows.filter((r) => r.ranked).length;
  const more =
    top.k === 'ranked'
      ? ` Only ${ranked} ha${ranked === 1 ? 's' : 've'} the ${MIN_TRIPS_FOR_RANK} finished trades a ranking needs — leave the live feed recording and the record grows.`
      : '';
  return `“${SCOUT_FILTER_TEXT[top.k].label}” hides ${top.n} of them.${more}`;
}

const CHAIN_NAME: Record<ScoutChain, string> ={ solana: 'Solana', robinhood: EVM_CHAIN_META.robinhood.shortName, bnb: EVM_CHAIN_META.bnb.shortName };
const UNIT: Record<ScoutChain, string> = { solana: 'SOL', robinhood: 'ETH', bnb: 'BNB' };

export function DiscoverPage() {
  const nav = useNav();
  if (nav.profile) return <WalletProfile address={nav.profile} chain={nav.profile.startsWith('0x') ? 'robinhood' : 'solana'} onBack={nav.closeProfile} />;
  return <Board />;
}

function Board() {
  const nav = useNav();
  const toast = useToast();
  const { settings } = useAppState();
  const chains = (['solana', 'robinhood', 'bnb'] as ScoutChain[]).filter((c) => c === 'solana' || settings.evm[c].enabled);
  const [chain, setChain] = useState<ScoutChain>('solana');
  const [view, setView] = useState<View>('best');
  const [win, setWin] = useState<ScoutWindow>('week');
  const [filters, setFilters] = useState(scoutFiltersAllOn);
  const [showFilters, setShowFilters] = useState(false);
  const [all, setAll] = useState<ScoutRow[]>([]);
  const [saved, setSaved] = useState<string[]>([]);
  const [followed, setFollowed] = useState<string[]>([]);
  const [counts, setCounts] = useState<{ tracked: number; watching: number; cap: number } | null>(null);
  const [loading, setLoading] = useState(true);
  const [lookup, setLookup] = useState('');
  const [compare, setCompare] = useState<string[]>([]);
  const [comparing, setComparing] = useState(false);
  const [size, setSize] = useBoardSize();
  const v = VIEWS.find((x) => x.value === view)!;
  // pump.fun's own board, Solana only, its own table (2026-10-25); and the
  // pre-registered test, its own panel.
  const pumpView = view === 'pump';
  const testView = view === 'test';
  // Does anyone on "Best to copy" beat a copy that goes nowhere? The page
  // says so before the list, so the top row is never read as a winner.
  const verdict = useMemo(() => (view === 'best' ? shortlistVerdict(all, SCOUT_PICKS_N) : null), [view, all]);
  const floorPct = feeFloorPct(copyCostModel(chain, chain === 'solana' ? size : null));

  const pickView = (next: View): void => {
    setView(next);
    setFilters(VIEWS.find((x) => x.value === next)!.filters());
  };

  const load = useCallback(async () => {
    const [top, marks, copies] = await Promise.all([
      window.krypt.scout.top(chain, win, v.sort, 200, size),
      window.krypt.scout.saved(chain, win, size),
      window.krypt.copy.list(),
    ]);
    if (top.ok && top.data) {
      setCounts(top.data.counts);
      if (view !== 'saved') setAll(top.data.rows);
    }
    if (marks.ok && marks.data) {
      setSaved(marks.data.saved);
      if (view === 'saved') setAll(marks.data.rows);
    }
    if (copies.ok && copies.data) setFollowed(copies.data.configs.map((c) => c.wallet.toLowerCase()));
    setLoading(false);
  }, [chain, win, v.sort, view, size]);

  useEffect(() => {
    setLoading(true);
    void load();
    const id = setInterval(() => void load(), 20_000);
    return () => clearInterval(id);
  }, [load]);

  const rows = useMemo(() => applyScoutFilters(all, filters), [all, filters]);
  // Convergence from here (2026-10-28): the crowd is this view's ranking
  // (its top 25, re-read as the record moves), the saved wallets, or the
  // ones ticked for comparison. Opens the Follow page on a paper draft.
  const followCrowd = (picked?: string[]): void => {
    const base = defaultConfig('', '', 'solana', 'fomo');
    const draft = picked
      ? { ...base, label: `Crowd · ${picked.length} picked`, fomoSource: 'list' as const, fomoWallets: picked, fomoMinWallets: Math.min(DEFAULT_FOMO_MIN_WALLETS, picked.length) }
      : view === 'saved'
        ? { ...base, label: 'Crowd · saved wallets', fomoSource: 'saved' as const }
        : { ...base, label: `Crowd · ${v.label}`, fomoSource: 'top' as const, fomoTopSort: v.sort };
    nav.editFollow(draft);
  };
  // Case-insensitive: a mark saved before 2026-10-22 may be lower-cased.
  const savedSet = useMemo(() => new Set(saved.map((a) => a.toLowerCase())), [saved]);
  const hidden = all.length - rows.length;
  const windowDays = SCOUT_WINDOW_DAYS[win];

  const toggleSave = async (address: string): Promise<void> => {
    const on = !savedSet.has(address.toLowerCase());
    const r = await window.krypt.scout.save(chain, address, on);
    if (r.ok && Array.isArray(r.data)) setSaved(r.data);
    if (view === 'saved') void load();
  };

  // A wallet address, or a pump.fun username / profile link (2026-10-23):
  // the name is turned into the wallet it signs in with, then opened like
  // any other — the profile can replay what copying it would have done.
  const [finding, setFinding] = useState(false);
  const openLookup = async (): Promise<void> => {
    setFinding(true);
    try {
      const r = await resolveWalletInput(lookup);
      if (!r.ok) return void toast.error(r.message);
      if (r.wallet.pump?.banned) toast.warn(`@${r.wallet.pump.username} is banned on pump.fun`);
      nav.openWallet(r.wallet.address);
    } finally {
      setFinding(false);
    }
  };

  const toggleCompare = (a: string): void =>
    setCompare((c) => (c.includes(a) ? c.filter((x) => x !== a) : c.length >= 3 ? (toast.warn('Compare up to three wallets'), c) : [...c, a]));

  return (
    <div className="h-full overflow-auto">
      <div className="mx-auto w-full max-w-[1240px] px-8 pb-28 pt-8">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <h1 className="text-[26px] font-semibold tracking-display text-white">Discover</h1>
            <p className="mt-1 max-w-2xl text-[14px] text-krypt-muted">
              Find a wallet worth following. Ranked by what a copier would really have kept — not by what the wallet made.
            </p>
          </div>
          <div className="flex items-center gap-2">
            {finding && <Loader2 className="h-4 w-4 animate-spin text-krypt-muted" />}
            <SearchBox
              value={lookup}
              onChange={setLookup}
              onSubmit={() => void openLookup()}
              placeholder="Wallet address or pump.fun username"
              testId="discover-lookup"
              className="w-[340px]"
            />
          </div>
        </div>

        <DataStrip chain={chain} counts={counts} onChanged={() => void load()} />
        <FeedLossNote where="this board" />
        {chain === 'solana' && <BoardRecordStrip size={size} />}

        <div className="mt-6 flex flex-wrap items-center gap-3">
          <Segmented value={view} onChange={pickView} options={VIEWS.map((x) => ({ value: x.value, label: x.value === 'saved' && saved.length ? `Saved · ${saved.length}` : x.label }))} testId="discover-views" />
          {!testView && (
            <Segmented
              size="sm"
              value={pumpView && win === 'all' ? 'week' : win}
              onChange={setWin}
              options={((pumpView ? ['day', 'week', 'month'] : ['day', 'week', 'month', 'all']) as ScoutWindow[]).map((w) => ({ value: w, label: SCOUT_WINDOW_LABEL[w] }))}
              testId="discover-window"
            />
          )}
          {chains.length > 1 && !pumpView && !testView && <Segmented size="sm" value={chain} onChange={setChain} options={chains.map((c) => ({ value: c, label: CHAIN_NAME[c] }))} />}
          {(chain === 'solana' || pumpView) && !testView && (
            <div className="flex items-center gap-2" title="The copy size the copier figures are priced at. Network fees are a fixed amount per trade, so they take a bigger share of a small copy.">
              <span className="text-body text-krypt-muted">Priced at</span>
              <Segmented size="sm" value={size} onChange={setSize} options={BOARD_SIZES.map((s) => ({ value: s, label: `${s} SOL` }))} testId="discover-size" />
            </div>
          )}
          {chain === 'solana' && !pumpView && !testView && (
            <button
              className={btn.secondary}
              onClick={() => followCrowd()}
              data-testid="discover-crowd"
              title={
                view === 'saved'
                  ? 'Follow the crowd: buy when several of your saved wallets buy the same coin within a window. Opens a paper draft you can change.'
                  : `Follow the crowd: buy when several of the top 25 wallets by “${v.label}” buy the same coin within a window. The list is re-read every 30 s as the record moves. Opens a paper draft you can change.`
              }
            >
              <Users className="h-4 w-4" /> Follow the crowd
            </button>
          )}
          {!pumpView && !testView && (
            <button className={cls(btn.ghost, 'ml-auto')} onClick={() => setShowFilters((s) => !s)} data-testid="discover-filters">
              <SlidersHorizontal className="h-4 w-4" /> Filters{SCOUT_FILTERS.some((k) => filters[k]) ? ` · ${SCOUT_FILTERS.filter((k) => filters[k]).length}` : ''}
            </button>
          )}
        </div>
        <p className="mt-2 text-body text-krypt-muted">{v.blurb}</p>
        {verdict && !loading && all.length > 0 && (
          <div
            className={cls('mt-3 rounded-xl border px-4 py-3 text-note leading-relaxed shadow-soft', verdict.nobody ? 'border-warn/30 bg-warn/10 text-white' : 'border-up/25 bg-up/10 text-white')}
            data-testid="discover-verdict"
          >
            {verdict.nobody ? (
              <>
                <span className="font-semibold">Nobody to recommend this week.</span>{' '}
                {verdict.rows.length === 0
                  ? `No wallet passes the checks with the ${SCORE_MIN_F_TRIPS} copied trades a ranking needs.`
                  : `The least-bad wallet's copies made ${fmtPctS(verdict.bestPct, { signed: true })} per trade; a copy that goes nowhere makes ${fmtPctS(verdict.floorPct, { signed: true })} at ${size} SOL (fees alone). Everything below lost more than doing nothing with the same fees — ranked least bad, not recommended.`}
              </>
            ) : (
              <>
                <span className="font-semibold">
                  {verdict.clears} wallet{verdict.clears === 1 ? '' : 's'} clear{verdict.clears === 1 ? 's' : ''} the fee floor this week
                </span>{' '}
                — copies of {verdict.clears === 1 ? 'it' : 'them'} beat a copy that goes nowhere ({fmtPctS(verdict.floorPct, { signed: true })} at {size} SOL). On every tape so far a week's winner was luck that reverted the week after; the chain check and next
                week's record decide, not this list.
              </>
            )}
            {chain === 'solana' && <ChainCheckStrip onDone={() => void load()} />}
          </div>
        )}
        {pumpView && <PumpBoard period={win === 'day' ? 'daily' : win === 'month' ? 'monthly' : 'weekly'} size={size} />}
        {testView && <PreregPanel />}
        {showFilters && !pumpView && !testView && (
          <div className="mt-3 flex flex-wrap gap-2">
            {SCOUT_FILTERS.map((k) => (
              <CheckChip key={k} on={filters[k]} onToggle={() => setFilters((f) => ({ ...f, [k]: !f[k] }))} title={SCOUT_FILTER_TEXT[k].why} testId="scout-filter">
                {SCOUT_FILTER_TEXT[k].label}
              </CheckChip>
            ))}
          </div>
        )}

        {!pumpView && !testView && (
          <>
            <div className="mt-4 overflow-hidden rounded-xl border border-white/8 bg-card shadow-soft">
              <div className="grid grid-cols-[28px_minmax(220px,1.6fr)_64px_repeat(5,minmax(84px,1fr))_150px] items-center gap-3 border-b border-white/8 px-4 py-2.5 text-body text-krypt-muted">
                <span />
                <span>Wallet</span>
                <span title="0–100: how a copier would have done. Least bad to follow, not an edge.">Score</span>
                <span className="text-right" title={`Median result per copied trade at ${size} SOL a copy: 2 s behind them, swap fees both ways and network fees, as paper charges. Slippage is not modelled. A copy that goes nowhere makes ${fmtPctS(floorPct, { signed: true })} — a figure under that lost more than doing nothing. Under it, the lower bound the list is ranked on: the median pulled toward this week's market by how few copies stand behind it, less 0.84 of its standard error.`}>
                  Copier / trade
                  <span className="block text-label text-krypt-muted">floor {fmtPctS(floorPct, { signed: true })}</span>
                </span>
                <span className="text-right" title="Share of their trades a copy could have been in at all">Copyable</span>
                <span className="text-right">Their profit</span>
                <span className="text-right">Win rate</span>
                <span className="text-right">Trades · hold</span>
                <span />
              </div>
              {loading && all.length === 0 ? (
                <div className="flex items-center justify-center gap-2 py-16 text-note text-krypt-muted">
                  <Loader2 className="h-4 w-4 animate-spin" /> Reading the record…
                </div>
              ) : rows.length === 0 ? (
                <div className="px-6 py-14 text-center">
                  <p className="text-[15px] font-medium text-white">
                    {all.length > 0 ? 'No wallet passes these filters in this window.' : view === 'saved' ? 'No saved wallets yet.' : 'Nothing recorded in this window yet.'}
                  </p>
                  <p className="mx-auto mt-1 max-w-lg text-note text-krypt-muted">
                    {all.length > 0
                      ? `${all.length} wallet${all.length === 1 ? ' is' : 's are'} on record. ${filterBlame(all, filters)}`
                      : view === 'saved'
                        ? 'Save a wallet from any list and it will be kept here.'
                        : 'The leaderboard fills from live trades. Press Scan above to read the last few hours right now — it takes about two minutes and costs nothing.'}
                  </p>
                  {all.length > 0 && (
                    <button className={cls(btn.secondary, 'mt-4')} onClick={() => setFilters(scoutFiltersAllOff())}>
                      Show every wallet
                    </button>
                  )}
                </div>
              ) : (
                <div>
                  {rows.map((r, i) => (
                    <div key={r.address}>
                      {v.sort === SCOUT_RANK_SORT && r.fLowerPct === null && (i === 0 || rows[i - 1].fLowerPct !== null) && (
                        <div className="border-b border-white/[0.06] bg-white/[0.02] px-4 py-2 text-body text-krypt-muted" data-testid="discover-unranked">
                          {i === 0 ? 'Nobody is ranked yet. ' : 'Not ranked yet. '}A ranking needs {SCORE_MIN_F_TRIPS} trades a copy could have joined; these have
                          fewer, so they are ordered by what was measured — low confidence.
                        </div>
                      )}
                      <BoardRow
                        r={r}
                        // A place number only for a wallet the ranking has placed.
                        rank={v.sort === SCOUT_RANK_SORT && r.fLowerPct === null ? null : i + 1}
                        unit={UNIT[chain]}
                        saved={savedSet.has(r.address.toLowerCase())}
                        following={followed.includes(r.address.toLowerCase())}
                        comparing={compare.includes(r.address)}
                        onOpen={() => nav.openWallet(r.address)}
                        onSave={() => void toggleSave(r.address)}
                        onFollow={() => nav.follow(r.address)}
                        onCompare={() => toggleCompare(r.address)}
                        canFollow={chain === 'solana' || settings.evm[chain as 'robinhood' | 'bnb']?.enabled}
                      />
                    </div>
                  ))}
                </div>
              )}
            </div>
            {hidden > 0 && rows.length > 0 && (
              <p className="mt-2 text-body text-krypt-muted">
                {hidden} wallet{hidden === 1 ? '' : 's'} hidden by the filters.{' '}
                <button className="text-accent hover:underline" onClick={() => setFilters(scoutFiltersAllOff())}>
                  Show all
                </button>
              </p>
            )}

            <p className="mt-6 max-w-3xl text-body leading-relaxed text-krypt-muted">
              Every number here is something that happened, over the window you picked. Measured across 9.3 million trades, ranking wallets by what a copier
              keeps beats ranking by their own profit — and still no group of wallets was profitable to copy after costs. Nothing on this page says a wallet will
              keep winning.
            </p>
          </>
        )}
      </div>

      {compare.length > 0 && (
        <div className="fixed bottom-5 left-1/2 z-30 flex -translate-x-1/2 items-center gap-3 rounded-xl border border-white/10 bg-card px-4 py-3 shadow-pop">
          <div className="flex -space-x-2">
            {compare.map((a) => (
              <Avatar key={a} address={a} size={28} />
            ))}
          </div>
          <span className="text-note text-white">
            {compare.length} selected{compare.length < 2 ? ' — pick one more to compare' : ''}
          </span>
          <button className={btn.primary} disabled={compare.length < 2} onClick={() => setComparing(true)} data-testid="compare-open">
            <GitCompare className="h-4 w-4" /> Compare
          </button>
          {chain === 'solana' && (
            <button className={btn.secondary} disabled={compare.length < 2} onClick={() => followCrowd(compare)} data-testid="compare-crowd" title="Follow these as a crowd: buy when they converge on the same coin within a window. Paper draft.">
              <Users className="h-4 w-4" /> Converge on these
            </button>
          )}
          <button className={btn.ghost} onClick={() => setCompare([])}>
            Clear
          </button>
        </div>
      )}
      {comparing && (
        <CompareSheet
          rows={compare.map((a) => all.find((r) => r.address === a)).filter((r): r is ScoutRow => !!r)}
          windowDays={windowDays}
          unit={UNIT[chain]}
          onClose={() => setComparing(false)}
          onOpen={(a) => (setComparing(false), nav.openWallet(a))}
          onFollow={(a) => (setComparing(false), nav.follow(a))}
        />
      )}
    </div>
  );
}

/**
 * The chain's word under the record's figure (2026-10-25): the median of a
 * random sample of the week's chain trips, repriced at the row's size so the
 * two read on one scale; how many of the week's trips the record had seen;
 * and the dead share of what it missed. The record's figure stays the
 * ranking; this is the check on it.
 */
function ChainLabelLine({ r, l }: { r: ScoutRow; l: ChainLabel }) {
  const m = copyCostModel(r.chain, r.sizeSol);
  const at = l.medianPct === null ? null : repriceReturn(l.medianPct, m);
  const title =
    `Read from the chain ${fmtAgo(l.at)}: ${l.chainTrips} finished trade${l.chainTrips === 1 ? '' : 's'} this week, ${l.priced} of a random ${l.sampled} priced as copies` +
    (at === null ? ' (under five priced — no median).' : `, median ${fmtPctS(at, { signed: true })} at ${r.sizeSol ?? '—'} SOL.`) +
    (l.coveragePct === null ? '' : ` The record had seen ${Math.round(l.coveragePct)}% of those trades`) +
    (l.unseenDeadPct === null ? (l.coveragePct === null ? '' : '.') : `; ${Math.round(l.unseenDeadPct)}% of the ones it missed ended on a dead coin.`) +
    ` Checks: ${l.washTrips} same-transaction round trip${l.washTrips === 1 ? '' : 's'}, ${l.sharedPayers} other fee payer${l.sharedPayers === 1 ? '' : 's'}, ${l.sniperTrips} snipe${l.sniperTrips === 1 ? '' : 's'} and ${l.bundleTrips} launch-bundle buy${l.bundleTrips === 1 ? '' : 's'} over ${l.mintsChecked} checked. ${l.credits} Helius credits.`;
  const gap = at !== null && r.fMedianReturnPct !== null ? at - r.fMedianReturnPct : null;
  return (
    <div className={cls('text-label tabular-nums', gap !== null && gap < -3 ? 'text-warn' : 'text-krypt-muted')} title={title} data-testid="scout-chain-label">
      chain {at === null ? DASH : fmtPctS(at, { signed: true })} · {l.priced}/{l.chainTrips}
      {l.coveragePct !== null ? ` · seen ${Math.round(l.coveragePct)}%` : ''}
    </div>
  );
}

/**
 * "Check on the chain" (2026-10-25): runs the board labeler — the ranked
 * wallets and a random fifth of the rest, read back from the chain inside
 * the backtest allowance — and shows where it is. Once a day it runs on its
 * own; this is for now.
 */
function ChainCheckStrip({ onDone }: { onDone: () => void }) {
  const [st, setSt] = useState<LabelStatus | null>(null);
  const toast = useToast();
  const wasRunning = useRef(false);
  useEffect(() => {
    let alive = true;
    const read = (): void =>
      void window.krypt.scout.labelStatus().then((r) => {
        if (!alive || !r.ok || !r.data) return;
        setSt(r.data);
        if (wasRunning.current && !r.data.running) onDone();
        wasRunning.current = r.data.running;
      });
    read();
    const id = setInterval(read, 2_000);
    return () => {
      alive = false;
      clearInterval(id);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const go = async (): Promise<void> => {
    const r = st?.running ? await window.krypt.scout.labelCancel() : await window.krypt.scout.labelBoard();
    if (!r.ok) return void toast.error(r.message);
    if (r.data) setSt(r.data);
    if (!st?.running && r.data && !r.data.running && r.data.message) toast.info(r.data.message);
  };
  const line = !st
    ? ''
    : st.running
      ? `Checking ${st.total} wallet${st.total === 1 ? '' : 's'} on the chain… ${st.done} done, ${st.credits.toLocaleString()} credits.`
      : st.finishedAt
        ? `${st.cancelled ? 'Stopped' : 'Checked'} ${fmtAgo(st.finishedAt)}: ${st.labelled} of ${st.total} labelled, ${st.excluded} excluded, ${st.credits.toLocaleString()} credits.${st.message ? ` ${st.message}` : ''}`
        : '';
  return (
    <div className="mt-2 flex flex-wrap items-center gap-3 border-t border-white/10 pt-2 text-body text-krypt-muted">
      <span className="min-w-0 flex-1">
        {line || 'The ranked wallets are read back from the chain once a day: every trade of the week, a random sample priced, and the launch-bundle, sniper, wash and shared-payer checks.'}
      </span>
      <button
        className={btn.secondary}
        onClick={() => void go()}
        data-testid="discover-chain-check"
        title="Reads the top 30 and a random fifth of the rest from the chain through your Helius key — about 350–700 credits a wallet from the backtest allowance. Spends nothing else."
      >
        {st?.running ? <Square className="h-4 w-4" /> : <ScanSearch className="h-4 w-4" />}
        {st?.running ? 'Stop' : 'Check on the chain'}
      </button>
    </div>
  );
}

/** Red under the fee floor, amber above it but negative, green when positive. */
function copierTone(r: ScoutRow): string {
  if (r.fMedianReturnPct === null) return 'text-krypt-muted';
  if (r.fMedianReturnPct > 0) return 'text-up';
  return clearsFloor({ chain: r.chain, fShrunkPct: r.fMedianReturnPct, sizeSol: r.sizeSol }) ? 'text-warn' : 'text-down';
}

function BoardRow({
  r,
  rank,
  unit,
  saved,
  following,
  comparing,
  canFollow,
  onOpen,
  onSave,
  onFollow,
  onCompare,
}: {
  r: ScoutRow;
  rank: number | null;
  unit: string;
  saved: boolean;
  following: boolean;
  comparing: boolean;
  canFollow: boolean;
  onOpen: () => void;
  onSave: () => void;
  onFollow: () => void;
  onCompare: () => void;
}) {
  // Your name for them (2026-10-28), over the address.
  const named = useAddressBook().nameOf(r.address);
  return (
    <div
      onClick={onOpen}
      data-testid="scout-row"
      className="grid cursor-pointer grid-cols-[28px_minmax(220px,1.6fr)_64px_repeat(5,minmax(84px,1fr))_150px] items-center gap-3 border-b border-white/[0.06] px-4 py-3 transition last:border-b-0 hover:bg-white/[0.03]"
    >
      <button
        onClick={(e) => (e.stopPropagation(), onCompare())}
        title="Compare"
        className={cls('flex h-4 w-4 items-center justify-center rounded-[4px] border', comparing ? 'border-accent bg-accent text-[#fff]' : 'border-white/25 hover:border-white/50')}
      >
        {comparing && <Check className="h-3 w-3" strokeWidth={3} />}
      </button>
      <div className="flex min-w-0 items-center gap-3">
        <span className="w-5 text-right text-body tabular-nums text-krypt-muted">{rank}</span>
        <Avatar address={r.address} size={34} label={named ?? undefined} />
        <div className="min-w-0">
          {named ? (
            <div className="flex min-w-0 items-baseline gap-2" data-testid="scout-row-name">
              <span className="truncate text-note font-medium text-white">{named}</span>
              <span className="font-mono text-body text-krypt-muted">{short(r.address, 4)}</span>
            </div>
          ) : (
            <div className="font-mono text-note text-white">{short(r.address, 5)}</div>
          )}
          <div className="mt-0.5 flex flex-wrap items-center gap-1">
            <RowTags r={r} max={2} />
            {r.flags.length === 0 && r.warnings.length === 0 && <span className="text-body text-krypt-muted">active {fmtAgo(r.lastSeen)}</span>}
          </div>
        </div>
      </div>
      <ScoreRing score={r.copyScore} size={36} stroke={3} />
      {/* The measured median at the picked size, with how many copies it
          stands on: under SCORE_MIN_F_TRIPS it is shown, muted, and never
          ranked (2026-10-22 — five trips at +50 % topped the list). */}
      <div
        className="text-right"
        title={
          r.fMedianReturnPct === null
            ? undefined
            : `Median over ${r.fTrips} copied trades at ${r.sizeSol ?? '—'} SOL a copy. A copy that goes nowhere: ${fmtPctS(feeFloorPct(copyCostModel(r.chain, r.sizeSol)), { signed: true })} (fees alone).`
        }
      >
        {/* Tone against the FLOOR, not zero (2026-10-25): red under it (lost
            more than doing nothing), amber above it but still a loss, green
            only when the copies actually made money. */}
        <div className={cls('text-note font-semibold tabular-nums', r.fTrips < SCORE_MIN_F_TRIPS ? 'text-krypt-muted' : copierTone(r))}>
          {fmtPctS(r.fMedianReturnPct, { signed: true })}
        </div>
        {r.fMedianReturnPct !== null && (
          <div className="text-label tabular-nums text-krypt-muted">
            {r.fTrips} cop{r.fTrips === 1 ? 'y' : 'ies'}
            {r.fTrips < SCORE_MIN_F_TRIPS ? ' · low confidence' : r.fTrips >= RELIABLE_COPIES ? ' · reliable' : ''}
          </div>
        )}
        {/* The figure the list is ranked on (2026-10-25): the median shrunk
            toward the week's prior, less 0.84 standard errors — the lower
            end of what it could be. A thin record's bound sits well under
            its median; a reliable one's barely. */}
        {r.fLowerPct !== null && (
          <div
            className="text-label tabular-nums text-krypt-muted"
            data-testid="scout-lower"
            title={`Ranked on this: the median pulled toward this week's market (${fmtPctS(r.shrink.muPct, { signed: true })} before fees, as if ${Math.round(r.shrink.k)} more copies${r.shrink.wallets ? `, measured from ${r.shrink.wallets} wallets` : ''}) less 0.84 of its standard error. ${r.fTrips >= RELIABLE_COPIES ? `With ${r.fTrips} copies the median is its own evidence.` : `Reliable at ${RELIABLE_COPIES} copies.`}`}
          >
            bound {fmtPctS(r.fLowerPct, { signed: true })}
          </div>
        )}
        {/* The week as a whole (2026-10-27): what copies at the size made or
            lost over the window, and the mean without the best five — a
            positive total over a negative median is a few trades' work. */}
        {r.fTotalSol !== null && (
          <div
            className="text-label tabular-nums text-krypt-muted"
            data-testid="scout-total"
            title={`Every copied trade at ${r.sizeSol ?? '—'} SOL, added up over the window.${r.fTrimmedMeanPct !== null ? ` Without its best five copies the mean is ${fmtPctS(r.fTrimmedMeanPct, { signed: true })}.` : ' Under ten copies there is no figure without the best five.'}`}
          >
            total <span className={toneOf(r.fTotalSol)}>{fmtAmt(r.fTotalSol, { signed: true, unit })}</span>
            {r.fTrimmedMeanPct !== null ? ` · w/o best 5 ${fmtPctS(r.fTrimmedMeanPct, { signed: true })}` : ''}
          </div>
        )}
        {r.chainLabel && <ChainLabelLine r={r} l={r.chainLabel} />}
      </div>
      <div className="text-right">
        <div className="text-note tabular-nums text-white">{r.reachablePct === null ? DASH : `${Math.round(r.reachablePct)}%`}</div>
        <div className="ml-auto mt-1 w-14">
          <Meter value={r.reachablePct} tone={r.reachablePct !== null && r.reachablePct < 25 ? 'warn' : 'accent'} />
        </div>
      </div>
      {/* A dash until a trip has closed: a wallet seen only buying has made
          nothing measurable, not 0 (92 of 137 rows read 0.0000 on 10-22). */}
      <div className={cls('text-right text-note tabular-nums', toneOf(r.roundTrips > 0 ? r.pnl : null))}>{r.roundTrips > 0 ? fmtAmt(r.pnl, { signed: true, unit }) : DASH}</div>
      <div className="text-right text-note tabular-nums text-white">{fmtPctS(r.winRatePct, { digits: 0 })}</div>
      <div className="text-right text-note tabular-nums text-white">
        {r.roundTrips}
        <span className="text-krypt-muted"> · {fmtHold(r.medianHoldMs)}</span>
      </div>
      <div className="flex items-center justify-end gap-1.5" onClick={(e) => e.stopPropagation()}>
        <button onClick={onSave} className={cls(btn.ghost, '!px-2')} title={saved ? 'Saved — click to remove' : 'Save'} aria-label={saved ? 'Remove from saved' : 'Save'}>
          {saved ? <BookmarkCheck className="h-4 w-4 text-accent" /> : <Bookmark className="h-4 w-4" />}
        </button>
        {following ? (
          <Tag tone="accent">
            <Check className="h-3 w-3" /> Following
          </Tag>
        ) : canFollow ? (
          <button onClick={onFollow} className={cls(btn.primary, '!px-3 !py-1.5')}>
            <Plus className="h-3.5 w-3.5" /> Follow
          </button>
        ) : null}
      </div>
    </div>
  );
}

/** Where the leaderboard's data comes from, and the two ways to get more. */
/**
 * The board's own record (2026-10-23, shared/walletScout.ts): what copies of
 * the wallets "Best to copy" listed went on to do, next to every copy the
 * record priced over the same time. Never green — beating everyone else by a
 * few points is still a loss per copy, and the line says what a copy that
 * goes nowhere costs so the reader has the right zero.
 */
function BoardRecordStrip({ size }: { size: number }) {
  const [rec, setRec] = useState<BoardRecord | null>(null);
  const [weeks, setWeeks] = useState<BoardWeek[]>([]);
  const [card, setCard] = useState<Scorecard | null>(null);
  const [prior, setPrior] = useState<ShrinkPrior | null>(null);
  useEffect(() => {
    let alive = true;
    const read = (): void => {
      void window.krypt.scout.record('solana', size).then((r) => {
        if (alive && r.ok && r.data) setRec(r.data);
      });
      // The weeks with their controls, and the scorecard over them (2026-10-25).
      void window.krypt.scout.scorecard('solana', size).then((r) => {
        if (!alive || !r.ok || !r.data) return;
        setWeeks(r.data.weeks);
        setCard(r.data.card);
        setPrior(r.data.prior);
      });
    };
    read();
    const id = setInterval(read, 60_000);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [size]);
  if (!rec) return null;
  const since = rec.since === null ? '' : new Date(rec.since).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  let line: string;
  if (rec.picks === 0) {
    line = `Nothing picked yet. Once Best to copy lists wallets, the top ${SCOUT_PICKS_N} are written down and every copy of a trade they open afterwards is priced here — the board grading itself on trades it had not seen.`;
  } else if (!rec.enough) {
    line = `Following ${rec.picks} pick${rec.picks === 1 ? '' : 's'} since ${since}: ${rec.copies} cop${rec.copies === 1 ? 'y' : 'ies'} priced so far. Too early to read — it needs ${SCOUT_RECORD_MIN_COPIES}.`;
  } else {
    const gap = rec.medianPct !== null && rec.baselineMedianPct !== null ? rec.medianPct - rec.baselineMedianPct : null;
    line =
      `Since ${since}, copies of its ${rec.picks} picks made ${fmtPctS(rec.medianPct, { signed: true })} per copy (median of ${rec.copies}, ${fmtPctS(rec.winRatePct, { digits: 0 })} won), ` +
      `against ${fmtPctS(rec.baselineMedianPct, { signed: true })} for every wallet on record` +
      (gap === null ? '.' : ` — ${Math.abs(gap) < 0.5 ? 'no better' : gap > 0 ? `${gap.toFixed(1)} points better` : `${Math.abs(gap).toFixed(1)} points worse`}.`) +
      ` A copy that goes nowhere: ${fmtPctS(rec.feeFloorPct, { signed: true })}.`;
  }
  const shown = weeks.filter((w) => w.copies > 0 || w.baselineCopies > 0);
  const grid = 'grid-cols-[88px_repeat(7,minmax(84px,1fr))]';
  const cell = (x: { copies: number; medianPct: number | null }, extra = ''): JSX.Element => (
    <span className={cls('text-right tabular-nums', x.copies < SCOUT_RECORD_MIN_COPIES ? 'text-krypt-muted' : toneOf(x.medianPct))} title={`${x.copies} copies${x.copies < SCOUT_RECORD_MIN_COPIES ? ' — too few to read' : ''}${extra}`}>
      {x.copies ? fmtPctS(x.medianPct, { signed: true }) : DASH}
      <span className="text-krypt-muted"> · {x.copies}</span>
    </span>
  );
  const marks = weeks.find((w) => w.marks.fills > 0)?.marks ?? null;
  return (
    <div className="mt-3 rounded-xl border border-white/8 bg-card px-4 py-3 text-body leading-relaxed text-krypt-muted shadow-soft" data-testid="discover-record-line">
      <span className="font-medium text-white">This board’s own record · </span>
      {line} Priced at {size} SOL a copy.
      {prior && (
        <span data-testid="discover-prior">
          {' '}
          Shrinking toward {fmtPctS(prior.muPct, { signed: true })} before fees as if {Math.round(prior.k)} more copies
          {prior.wallets ? `, measured from ${prior.wallets} wallets this week` : ` — the fixed figures, under ${30} wallets to measure from`}.
        </span>
      )}
      {shown.length > 0 && (
        <div className="mt-3 overflow-hidden rounded-lg border border-white/8" data-testid="discover-record-weeks">
          <div className={cls('grid gap-3 border-b border-white/8 px-3 py-1.5 text-label text-krypt-muted', grid)}>
            <span>Week</span>
            <span className="text-right" title="Median per copy of the picks' trades opened that week, and how many copies. The 5 %-winsorised mean is in the tooltip.">Picks</span>
            <span className="text-right" title="Median per copy of every wallet on record that week. Tooltip: picks minus everyone, with a wallet-clustered bootstrap 90 % interval.">Everyone</span>
            <span className="text-right" title={`What ${SCOUT_PICKS_N} wallets drawn at random from that week would have made: the 5th to 95th percentile of ${BOARD_RANDOM_DRAWS} draws. The picks have to sit above this band to have beaten luck.`}>
              Random {SCOUT_PICKS_N}
            </span>
            <span className="text-right" title={`The top ${SCOUT_PICKS_N} by the wallets' OWN profit, tracked like picks — what every other copy tool ranks on.`}>
              Leader PnL
            </span>
            <span className="text-right" title={`The ${SCOUT_PICKS_N} wallets just under the picks in this ranking (the research's "decile 9"). If they beat the picks, the top of the list is luck.`}>
              Next {SCOUT_PICKS_N}
            </span>
            <span className="text-right" title="Picks made before the week began, held another week, against picks made in it: what rotation itself is worth.">
              Held · fresh
            </span>
            <span className="text-right" title="Spearman between the ranking figure at the week's start and the median each wallet realised, over every ranked wallet with both — the ranking's own skill, not just the top of it. The half-day reference is 0.48.">
              Rank ρ
            </span>
          </div>
          {shown.map((w) => {
            const vs = w.randomBand && w.medianPct !== null ? (w.medianPct > w.randomBand.hi ? 'above' : w.medianPct < w.randomBand.lo ? 'below' : 'inside') : null;
            const d = w.vsEveryone;
            return (
              <div key={w.week} className={cls('grid items-center gap-3 border-b border-white/[0.05] px-3 py-1.5 text-body last:border-b-0', grid)} data-testid="discover-record-week">
                <span className="text-white">{new Date(w.week).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}</span>
                {cell({ copies: w.copies, medianPct: w.medianPct }, w.copies ? `, ${fmtPctS(w.winRatePct, { digits: 0 })} won, winsorised mean ${fmtPctS(w.meanPct, { signed: true })}` : '')}
                <span
                  className="text-right tabular-nums text-white"
                  title={`${w.baselineCopies} copies${d ? `. Picks minus everyone: ${d.diff >= 0 ? '+' : ''}${d.diff.toFixed(1)} points (${d.lo >= 0 ? '+' : ''}${d.lo.toFixed(1)} to ${d.hi >= 0 ? '+' : ''}${d.hi.toFixed(1)})` : ''}`}
                >
                  {w.baselineCopies ? fmtPctS(w.baselineMedianPct, { signed: true }) : DASH}
                  {d && <span className={cls('block text-label', d.lo > 0 ? 'text-up' : d.hi < 0 ? 'text-down' : 'text-krypt-muted')}>{d.diff >= 0 ? '+' : ''}{d.diff.toFixed(1)} ({d.lo >= 0 ? '+' : ''}{d.lo.toFixed(1)}…{d.hi >= 0 ? '+' : ''}{d.hi.toFixed(1)})</span>}
                </span>
                <span className={cls('text-right tabular-nums', vs === 'above' ? 'text-up' : vs === 'below' ? 'text-down' : 'text-krypt-muted')}>
                  {w.randomBand ? `${fmtPctS(w.randomBand.lo, { signed: true })} to ${fmtPctS(w.randomBand.hi, { signed: true })}` : DASH}
                  {vs && w.copies >= SCOUT_RECORD_MIN_COPIES ? ` · ${vs}` : ''}
                </span>
                {cell(w.lead, `, ${w.lead.picks} wallets`)}
                {cell(w.next, `, ${w.next.picks} wallets`)}
                <span className="text-right tabular-nums text-white" title={`Held: ${w.held.copies} copies of picks made before the week. Fresh: ${w.fresh.copies} copies of picks made in it.`}>
                  {w.held.copies ? fmtPctS(w.held.medianPct, { signed: true }) : DASH}
                  <span className="text-krypt-muted"> · {w.fresh.copies ? fmtPctS(w.fresh.medianPct, { signed: true }) : DASH}</span>
                </span>
                <span className={cls('text-right tabular-nums', w.rankRho ? (w.rankRho.rho >= 0.4 ? 'text-up' : w.rankRho.rho <= 0 ? 'text-down' : 'text-white') : 'text-krypt-muted')} title={w.rankRho ? `over ${w.rankRho.wallets} wallets` : 'needs a ranking snapshot at the week’s start and ten wallets with three copies each'}>
                  {w.rankRho ? w.rankRho.rho.toFixed(2) : DASH}
                </span>
              </div>
            );
          })}
        </div>
      )}
      {card && (rec.picks > 0 || shown.length > 0) && (
        <div className="mt-3 space-y-1 border-t border-white/8 pt-2" data-testid="discover-scorecard">
          <div>
            <span className="font-medium text-white">Scorecard · </span>
            {card.notes.join(' ')}
          </div>
          {card.decayByAge.some((d) => d.copies > 0) && (
            <div>
              By days since the pick:{' '}
              {card.decayByAge.map((d, i) => (
                <span key={d.label}>
                  {i > 0 ? ' · ' : ''}
                  {d.label} <span className={d.copies >= SCOUT_RECORD_MIN_COPIES ? toneOf(d.medianPct) : 'text-krypt-muted'}>{d.copies ? fmtPctS(d.medianPct, { signed: true }) : DASH}</span> ({d.copies})
                </span>
              ))}
              . A fall with age is the board’s own decay: naming a wallet crowds it.
            </div>
          )}
          {marks && (
            <div title="Where a copy stood 30 s and 5 min after its fill, before any exit: a selection whose fills are under water at once is paying for crowding whatever its trips end at.">
              After the fill (30 s · 5 min): picks {marks.pick30 === null ? DASH : fmtPctS(marks.pick30, { signed: true })} · {marks.pick300 === null ? DASH : fmtPctS(marks.pick300, { signed: true })}, everyone{' '}
              {marks.all30 === null ? DASH : fmtPctS(marks.all30, { signed: true })} · {marks.all300 === null ? DASH : fmtPctS(marks.all300, { signed: true })} over {marks.fills} fills this week.
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function DataStrip({ chain, counts, onChanged }: { chain: ScoutChain; counts: { tracked: number; watching: number; cap: number } | null; onChanged: () => void }) {
  const toast = useToast();
  const [collecting, setCollecting] = useState<boolean | null>(null);
  const [scan, setScan] = useState<ScoutScanStatus | null>(null);
  const [hours, setHours] = useState<ScoutScanHours>(6);
  const [busy, setBusy] = useState(false);
  // The backtest allowance (2026-10-27): what the chain scans may still spend
  // this month, read with the scan status so the bar moves as a scan bills.
  const { settings } = useAppState();
  const allowance = settings.rpc.heliusBacktestCredits ?? DEFAULT_BACKTEST_CREDITS;
  const [usage, setUsage] = useState<CreditUsage | null>(null);

  const read = useCallback(async () => {
    if (chain === 'solana') {
      const r = await window.krypt.engine.snapshot();
      setCollecting(r.ok && r.data ? r.data.status.running : null);
    } else {
      const r = await window.krypt.evm.scan.status(chain);
      setCollecting(r.ok && r.data ? r.data.running : null);
    }
    const s = await window.krypt.scout.scanStatus(chain);
    setScan(s.ok && s.data ? s.data : null);
    if (chain === 'solana') {
      const c = await window.krypt.rpc.credits();
      setUsage(c.ok && c.data ? c.data : null);
    }
  }, [chain]);
  useEffect(() => {
    void read();
  }, [read]);
  const running = scan?.running === true;
  useEffect(() => {
    if (!running) return;
    const id = setInterval(() => void read(), 1_000);
    return () => clearInterval(id);
  }, [running, read]);
  const was = useRef(false);
  useEffect(() => {
    if (was.current && !running) onChanged();
    was.current = running;
  }, [running, onChanged]);

  const toggleRecord = async (): Promise<void> => {
    setBusy(true);
    try {
      const r =
        chain === 'solana'
          ? collecting
            ? await window.krypt.engine.stop()
            : await window.krypt.engine.start()
          : collecting
            ? await window.krypt.evm.scan.stop(chain)
            : await window.krypt.evm.scan.start(chain);
      if (!r.ok) toast.error(r.message);
      await read();
    } finally {
      setBusy(false);
    }
  };
  const doScan = async (): Promise<void> => {
    const r = running ? await window.krypt.scout.scanCancel(chain) : await window.krypt.scout.scan(chain, hours);
    if (r.ok && r.data) setScan(r.data);
    else if (!r.ok) toast.error(r.message);
  };
  // The winners scan (2026-10-27): the week's winner coins, whole, from the chain.
  const doWinners = async (): Promise<void> => {
    const r = await window.krypt.scout.scan(chain, SCOUT_WINNERS_HOURS, 'winners');
    if (r.ok && r.data) setScan(r.data);
    else if (!r.ok) toast.error(r.message);
  };
  const winnersRun = scan?.mode === 'winners';
  // What is left to spend and what each scan can cost, so the price is on
  // the button and the bar says whether it fits.
  const left = usage ? backtestCreditsLeft(usage, allowance) : null;
  const btUsed = usage?.backtest ?? 0;
  const btPct = allowance > 0 ? Math.min(100, (btUsed / allowance) * 100) : null;
  const coinsFit = left === null ? null : winnersCoinsAffordable(left);
  const recentMax = recentScanCredits();
  const winnersMax = winnersScanCredits(WINNERS_SCAN_MAX_COINS);

  const pct = running && scan && scan.units > 0 ? Math.round((scan.unitsDone / scan.units) * 100) : null;
  return (
    <div className="mt-6 flex flex-wrap items-center gap-x-6 gap-y-3 rounded-xl border border-white/8 bg-card px-4 py-3 shadow-soft" data-testid="discover-data">
      <div className="flex items-center gap-2.5">
        <span className={cls('flex h-8 w-8 items-center justify-center rounded-lg', collecting ? 'bg-up/10 text-up' : 'bg-white/5 text-krypt-muted')}>
          <Radio className="h-4 w-4" />
        </span>
        <div className="leading-tight">
          <div className="text-note font-medium text-white">{counts ? `${counts.tracked.toLocaleString()} wallets on record` : 'Reading the record…'}</div>
          <div className="text-body text-krypt-muted">
            {collecting === null ? 'Feed state unknown' : collecting ? 'Recording live trades as they happen' : 'Live recording is off'}
          </div>
        </div>
        <button onClick={() => void toggleRecord()} disabled={busy || collecting === null} className={cls(btn.secondary, '!py-1.5')} data-testid="discover-record">
          {collecting ? <Square className="h-3.5 w-3.5" /> : <Play className="h-3.5 w-3.5" />}
          {collecting ? 'Stop' : 'Record live'}
        </button>
      </div>

      <div className="flex flex-1 flex-wrap items-center justify-end gap-2">
        {running ? (
          <div className="flex min-w-[220px] flex-1 items-center gap-3">
            <div className="flex-1">
              <div className="h-1.5 overflow-hidden rounded-full bg-white/10">
                <div className="h-full rounded-full bg-accent transition-[width] duration-500" style={{ width: `${pct ?? 8}%` }} />
              </div>
              <div className="mt-1 text-body text-krypt-muted">
                {winnersRun ? 'Reading the week’s winner coins…' : 'Scanning…'} {scan?.fed.toLocaleString()} trades read
                {scan?.units ? ` · ${scan.unitsDone}/${scan.units}${winnersRun ? ' coins' : ''}` : ''}
                {winnersRun && scan?.credits ? ` · ${scan.credits.toLocaleString()} credits` : ''}
                {scan?.waitingUntil ? ` · pump.fun asked us to slow down, waiting ${Math.max(1, Math.ceil((scan.waitingUntil - Date.now()) / 1000))} s` : ''}
              </div>
            </div>
          </div>
        ) : (
          <span className="text-body text-krypt-muted" title={scan?.message || undefined}>
            {scan?.finishedAt
              ? `Last ${winnersRun ? 'winners scan' : 'scan'} ${fmtAgo(scan.finishedAt)}: ${scan.fed.toLocaleString()} trades, ${scan.trackedAfter - scan.trackedBefore >= 0 ? '+' : ''}${(scan.trackedAfter - scan.trackedBefore).toLocaleString()} wallets`
              : 'Read past trades now:'}
            {scan?.finishedAt && scan.unitsUnread > 0 ? (
              <span className="text-warn">
                {' '}
                · {scan.unitsUnread} of {scan.units} {chain === 'solana' ? 'coins' : 'block ranges'} not read
              </span>
            ) : null}
            {scan?.finishedAt && scan.unitsPartial > 0 ? ` · ${scan.unitsPartial} busy coin${scan.unitsPartial === 1 ? '' : 's'} read in part (newest trades only)` : null}
            {scan?.finishedAt && chain === 'solana' && (scan.viaChain || scan.viaPump) ? (
              <span title={scan.fallbackWhy ? `pump.fun’s history was used because ${scan.fallbackWhy}` : undefined}>
                {' '}
                · {scan.viaChain ?? 0} from the chain ({(scan.credits ?? 0).toLocaleString()} credits){scan.viaPump ? `, ${scan.viaPump} from pump.fun` : ''}
              </span>
            ) : null}
          </span>
        )}
        {!running && (
          <Segmented size="sm" value={hours} onChange={setHours} options={SCOUT_SCAN_HOURS.map((h) => ({ value: h, label: `${h}h` }))} />
        )}
        <button
          onClick={() => void doScan()}
          className={running ? btn.secondary : btn.primary}
          data-testid="scout-scan"
          title={`Reads recent trades into the record. Trades nothing.${chain === 'solana' ? ` Reads the chain through your Helius key first (seconds, at most ${recentMax.toLocaleString()} credits from the backtest allowance), and pump.fun's history for anything left (slow, free).` : ''}`}
        >
          {running ? <X className="h-4 w-4" /> : <Search className="h-4 w-4" />}
          {running ? 'Stop scan' : 'Scan'}
          {!running && chain === 'solana' && <span className="font-mono text-label opacity-70">≤{recentMax.toLocaleString()}</span>}
        </button>
        {!running && chain === 'solana' && (
          <button
            onClick={() => void doWinners()}
            className={btn.secondary}
            disabled={coinsFit === 0}
            data-testid="scout-scan-winners"
            title={
              coinsFit === 0
                ? `Not enough backtest allowance for one coin (${winnersCoinCredits().toLocaleString()} credits). Raise it under Settings › API keys, or wait for the month to roll.`
                : `Reads the whole week of up to ${WINNERS_SCAN_MAX_COINS} coins that went up and kept a market, and records every wallet that signed a trade on them — the search that found this week’s copyable wallets. Chain only, through your Helius key: ${winnersCoinCredits().toLocaleString()} credits a coin at most, ${winnersMax.toLocaleString()} for all ${WINNERS_SCAN_MAX_COINS}, from the backtest allowance; about ten minutes. Then open “Week total”.`
            }
          >
            <Search className="h-4 w-4" />
            Scan the week’s winners
            <span className="font-mono text-label opacity-70">≤{winnersMax.toLocaleString()}</span>
          </button>
        )}
      </div>
      {/* The allowance as a bar (2026-10-27): the chain scans spend it, so
          the page that spends it says how much is left and what each scan
          costs, instead of the scan stopping short and saying so after. */}
      {chain === 'solana' && (
        <div className="flex basis-full flex-wrap items-center gap-x-4 gap-y-1 border-t border-white/8 pt-3" data-testid="scout-credits">
          <span className="text-label uppercase tracking-label text-krypt-muted">Backtest allowance</span>
          <div className="w-36">
            <Meter value={btPct} tone={btPct !== null && btPct > 90 ? 'down' : btPct !== null && btPct > 60 ? 'warn' : 'accent'} />
          </div>
          <span
            className="font-mono text-label text-white"
            title="What chain-priced scans, replays and board checks have spent of the allowance this month. Settings › API keys sets the allowance and shows the key's whole month."
          >
            {usage ? btUsed.toLocaleString() : '—'}
            <span className="text-krypt-muted"> of {allowance.toLocaleString()} used</span>
            {left !== null && <span className="text-krypt-muted"> · {left.toLocaleString()} left</span>}
          </span>
          {allowance <= 0 ? (
            <span className="text-label text-warn">Chain reads are off (allowance 0): scans use pump.fun’s slow history and the winners scan cannot run.</span>
          ) : (
            <span className="text-label text-krypt-muted">
              Scan ≤ {recentMax.toLocaleString()} · Winners ≤ {winnersMax.toLocaleString()} ({winnersCoinCredits().toLocaleString()} a coin
              {coinsFit !== null ? <span className={coinsFit < WINNERS_SCAN_MAX_COINS ? 'text-warn' : undefined}>, enough for {coinsFit} of {WINNERS_SCAN_MAX_COINS}</span> : null})
            </span>
          )}
          {scan?.finishedAt && !running && (scan.credits ?? 0) > 0 ? (
            <span className="text-label text-krypt-muted" title="Credits the last scan billed to the allowance.">
              Last {winnersRun ? 'winners scan' : 'scan'} took {(scan.credits ?? 0).toLocaleString()}
            </span>
          ) : null}
        </div>
      )}
    </div>
  );
}

function CompareSheet({
  rows,
  windowDays,
  unit,
  onClose,
  onOpen,
  onFollow,
}: {
  rows: ScoutRow[];
  windowDays: number | null;
  unit: string;
  onClose: () => void;
  onOpen: (a: string) => void;
  onFollow: (a: string) => void;
}) {
  const book = useAddressBook();
  const metrics: Array<{ label: string; get: (r: ScoutRow) => number | null; fmt: (v: number | null) => string; better: 'high' | 'low' | null; signed?: boolean }> = [
    { label: 'Copy score', get: (r) => r.copyScore, fmt: (v) => (v === null ? DASH : String(v)), better: 'high' },
    { label: 'Copier result / trade', get: (r) => r.fMedianReturnPct, fmt: (v) => fmtPctS(v, { signed: true }), better: 'high', signed: true },
    { label: 'Copier win rate', get: (r) => r.fWinRatePct, fmt: (v) => fmtPctS(v, { digits: 0 }), better: 'high' },
    { label: 'Trades a copy could join', get: (r) => r.reachablePct, fmt: (v) => fmtPctS(v, { digits: 0 }), better: 'high' },
    { label: 'Their profit', get: (r) => (r.roundTrips > 0 ? r.pnl : null), fmt: (v) => fmtAmt(v, { signed: true, unit }), better: 'high', signed: true },
    { label: 'Their win rate', get: (r) => r.winRatePct, fmt: (v) => fmtPctS(v, { digits: 0 }), better: 'high' },
    { label: 'Finished trades', get: (r) => r.roundTrips, fmt: (v) => (v === null ? DASH : String(v)), better: 'high' },
    { label: 'Median hold', get: (r) => r.medianHoldMs, fmt: (v) => fmtHold(v), better: null },
    { label: 'Days active', get: (r) => r.activeDays, fmt: (v) => (v === null ? DASH : String(v)), better: 'high' },
    { label: 'Coins traded', get: (r) => r.distinctMints, fmt: (v) => (v === null ? DASH : String(v)), better: null },
  ];
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/55 p-6" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="max-h-full w-full max-w-4xl overflow-auto rounded-2xl border border-white/10 bg-card shadow-pop" data-testid="compare-sheet">
        <div className="flex items-center justify-between border-b border-white/8 px-6 py-4">
          <div className="text-[16px] font-semibold text-white">Compare wallets</div>
          <button onClick={onClose} className={btn.ghost} aria-label="Close">
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="grid px-6 py-5" style={{ gridTemplateColumns: `180px repeat(${rows.length}, minmax(0, 1fr))` }}>
          <div />
          {rows.map((r) => (
            <div key={r.address} className="flex flex-col items-center gap-2 px-3 pb-4 text-center">
              <Avatar address={r.address} size={44} label={book.nameOf(r.address) ?? undefined} />
              {book.nameOf(r.address) && <div className="text-note font-medium text-white">{book.nameOf(r.address)}</div>}
              <div className="font-mono text-note text-white">{short(r.address, 5)}</div>
              <div className="flex flex-wrap justify-center gap-1">
                <RowTags r={r} />
              </div>
            </div>
          ))}
          {metrics.map((m) => {
            const vals = rows.map(m.get);
            const known = vals.filter((x): x is number => x !== null);
            const best = m.better && known.length > 1 ? (m.better === 'high' ? Math.max(...known) : Math.min(...known)) : null;
            return (
              <div key={m.label} className="contents">
                <div className="border-t border-white/[0.06] py-2.5 text-note text-krypt-muted">{m.label}</div>
                {vals.map((x, i) => (
                  <div
                    key={i}
                    className={cls(
                      'border-t border-white/[0.06] py-2.5 text-center text-note tabular-nums',
                      m.signed ? toneOf(x) : 'text-white',
                      best !== null && x === best && 'font-semibold',
                    )}
                  >
                    {m.fmt(x)}
                    {best !== null && x === best && <span className="ml-1 text-up">●</span>}
                  </div>
                ))}
              </div>
            );
          })}
          <div className="border-t border-white/[0.06] py-2.5 text-note text-krypt-muted">Score checks</div>
          {rows.map((r) => {
            const s = scoreOfRow(r, windowDays !== null && windowDays >= 3 ? windowDays : null);
            return (
              <div key={r.address} className="space-y-1.5 border-t border-white/[0.06] px-3 py-2.5">
                {s.checks.map((c) => (
                  <div key={c.id} title={c.note}>
                    <div className="flex justify-between text-body text-krypt-muted">
                      <span>{c.label}</span>
                      <span className="tabular-nums text-white">{c.value}</span>
                    </div>
                    <Meter value={c.points} tone={c.points === null ? 'accent' : c.points >= 60 ? 'up' : c.points >= 35 ? 'warn' : 'down'} />
                  </div>
                ))}
              </div>
            );
          })}
          <div />
          {rows.map((r) => (
            <div key={r.address} className="flex justify-center gap-2 pt-4">
              <button className={btn.secondary} onClick={() => onOpen(r.address)}>
                Profile
              </button>
              <button className={btn.primary} onClick={() => onFollow(r.address)}>
                <Plus className="h-4 w-4" /> Follow
              </button>
            </div>
          ))}
        </div>
        <p className="border-t border-white/8 px-6 py-3 text-body text-krypt-muted">The dot marks the better figure in each row. Past results only — none of it says who wins next.</p>
      </div>
    </div>
  );
}
