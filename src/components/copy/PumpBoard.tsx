// pump.fun's leaderboard on Discover (2026-10-25) — their top 100 by their
// own profit over a day, a week or a month, next to what COPYING each one
// would have done.
//
// The user: "what about scanning the pumpfun learderboards. it had top
// wallets by week, by day, and by month." pump ranks what the wallet made —
// the weekly #1 that day was +362,824 % on one coin — and a list ranked that
// way is mostly luck and speed a copier never gets. So the board is shown as
// pump sends it, flagged where its own figures say to be wary, and "Replay
// the top N" runs the same copy replay as Check on each wallet in turn (the
// chain first through the Helius key, pump.fun's history as the fallback),
// filling a "copying them" column you can sort by.

import { useEffect, useMemo, useRef, useState } from 'react';
import { ExternalLink, Loader2, Play, Plus, RefreshCw, ScanSearch, Square } from 'lucide-react';
import { pumpLeaderCautions, pumpUnsoldCount, type PumpLeader, type PumpLeaderboard, type PumpLeaderPeriod } from '@shared/pumpLookup';
import { replaySummary, type CopyReplayStatus } from '@shared/copyReplay';
import { useNav } from '../../state/nav';
import { Avatar, DASH, Segmented, Tag, btn, fmtAmt, fmtPctS, short, toneOf } from '../../ui/kit';
import { cls, fmtAgo } from '../../utils/format';

/** Wallets replayed at once: two, so a batch moves without crowding the RPC. */
const BATCH_PARALLEL = 2;
const TOP_NS = [10, 25, 50] as const;
type Order = 'pump' | 'copy';

/** Finished and not stopped: a batch does not run it again. */
const done = (s: CopyReplayStatus | undefined): boolean => !!s && !s.running && s.finishedAt !== null && !s.cancelled;

export function PumpBoard({ period, size }: { period: PumpLeaderPeriod; size: number }) {
  const nav = useNav();
  const [board, setBoard] = useState<PumpLeaderboard | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [results, setResults] = useState<Record<string, CopyReplayStatus>>({});
  const [followed, setFollowed] = useState<string[]>([]);
  const [topN, setTopN] = useState<number>(TOP_NS[0]);
  const [order, setOrder] = useState<Order>('pump');
  const [batch, setBatch] = useState<{ running: boolean; done: number; total: number } | null>(null);
  const stop = useRef(false);

  const load = async (fresh = false): Promise<void> => {
    setLoading(true);
    setError('');
    try {
      const r = await window.krypt.scout.pumpLeaderboard(period, fresh);
      if (!r.ok || !r.data) {
        setBoard(null);
        return void setError(r.message);
      }
      setBoard(r.data);
      // Replays already run this session (here, on Check or a profile) show
      // at once — they are read from memory, not run again.
      const known = await Promise.all(r.data.entries.map((e) => window.krypt.scout.replayStatus(e.wallet)));
      setResults((prev) => {
        const next = { ...prev };
        known.forEach((k) => k.ok && k.data && k.data.startedAt !== null && (next[k.data.address] = k.data));
        return next;
      });
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [period]);
  useEffect(() => {
    void window.krypt.copy.list().then((r) => r.ok && r.data && setFollowed(r.data.configs.map((c) => c.wallet.toLowerCase())));
    return () => {
      stop.current = true;
    };
  }, []);

  /** One wallet's replay, start to finish; the result lands in `results`. */
  const replayOne = async (wallet: string): Promise<void> => {
    let st = (await window.krypt.scout.replayStatus(wallet)).data;
    if (!st?.running) {
      const r = await window.krypt.scout.replay(wallet, { checks: true });
      if (!r.ok || !r.data) {
        setResults((p) => ({ ...p, [wallet]: { ...(p[wallet] ?? emptyStatus(wallet)), message: r.message } }));
        return;
      }
      st = r.data;
    }
    while (st?.running && !stop.current) {
      setResults((p) => ({ ...p, [wallet]: st as CopyReplayStatus }));
      await new Promise((res) => setTimeout(res, 1_000));
      st = (await window.krypt.scout.replayStatus(wallet)).data;
    }
    if (stop.current && st?.running) await window.krypt.scout.replayCancel(wallet);
    if (st) setResults((p) => ({ ...p, [wallet]: st as CopyReplayStatus }));
  };

  const runBatch = async (): Promise<void> => {
    if (!board) return;
    const todo = board.entries.slice(0, topN).map((e) => e.wallet).filter((w) => !done(results[w]));
    if (!todo.length) return;
    stop.current = false;
    let finished = 0;
    setBatch({ running: true, done: 0, total: todo.length });
    const queue = [...todo];
    const worker = async (): Promise<void> => {
      for (let w = queue.shift(); w && !stop.current; w = queue.shift()) {
        await replayOne(w);
        finished += 1;
        setBatch((b) => (b ? { ...b, done: finished } : b));
      }
    };
    await Promise.all(Array.from({ length: BATCH_PARALLEL }, worker));
    setBatch((b) => (b ? { ...b, running: false } : b));
  };

  const summaries = useMemo(() => {
    const out: Record<string, ReturnType<typeof replaySummary>> = {};
    for (const [w, s] of Object.entries(results)) if (s.trips.length) out[w] = replaySummary(s.trips, size);
    return out;
  }, [results, size]);

  const rows = useMemo(() => {
    const es = board?.entries ?? [];
    if (order === 'pump') return es;
    // Replayed wallets first, best result per copy first; a wallet with too
    // few copies for a median sorts after those with one.
    const key = (e: PumpLeader): number => {
      const s = summaries[e.wallet];
      return s?.medianPct ?? (s ? -1e9 : -2e9);
    };
    return [...es].sort((a, b) => key(b) - key(a) || a.rank - b.rank);
  }, [board, order, summaries]);

  const replayed = board ? board.entries.filter((e) => done(results[e.wallet])).length : 0;
  const pending = board ? board.entries.slice(0, topN).filter((e) => !done(results[e.wallet])).length : 0;

  return (
    <div data-testid="pump-board">
      <div className="mt-4 flex flex-wrap items-center gap-3 rounded-xl border border-white/8 bg-card px-4 py-3 shadow-soft">
        <div className="min-w-0 flex-1 text-note text-krypt-muted">
          {board ? (
            <>
              pump.fun&rsquo;s top {board.entries.length} by their own profit over the last {board.label}, read {fmtAgo(board.fetchedAt)}.{' '}
              <span className={pumpUnsoldCount(board.entries) >= board.entries.length / 2 ? 'text-warn' : undefined}>
                {pumpUnsoldCount(board.entries)} of them have most of that profit in coins not sold yet.
              </span>
              {replayed > 0 && <span className="text-white"> {replayed} replayed.</span>}
            </>
          ) : loading ? (
            'Reading the leaderboard from pump.fun…'
          ) : (
            ''
          )}
        </div>
        {batch?.running ? (
          <>
            <span className="inline-flex items-center gap-2 text-note text-white">
              <Loader2 className="h-4 w-4 animate-spin" /> Replaying {Math.min(batch.done + 1, batch.total)} of {batch.total}…
            </span>
            <button className={btn.secondary} onClick={() => (stop.current = true)} data-testid="pump-board-stop">
              <Square className="h-4 w-4" /> Stop
            </button>
          </>
        ) : (
          <>
            <span className="text-body text-krypt-muted">Replay copying the top</span>
            <Segmented<number> size="sm" value={topN} onChange={setTopN} options={TOP_NS.map((n) => ({ value: n, label: String(n) }))} />
            <button
              className={btn.primary}
              disabled={!board || pending === 0}
              onClick={() => void runBatch()}
              data-testid="pump-board-replay"
              title={`Their newest finished trades, each copied 2 s behind them at ${size} SOL. From the chain through your Helius key first — about 300 credits a wallet from the backtest allowance — and pump.fun's trade history for anything left. Wallets already replayed this session are not run again.`}
            >
              <Play className="h-4 w-4" /> {pending === 0 && board ? 'All replayed' : `Replay ${pending}`}
            </button>
          </>
        )}
        <button className={btn.ghost} onClick={() => void load(true)} disabled={loading} title="Read the board from pump.fun again">
          <RefreshCw className={cls('h-4 w-4', loading && 'animate-spin')} />
        </button>
      </div>
      {error && <p className="mt-2 text-body text-warn">{error}</p>}

      <div className="mt-4 overflow-hidden rounded-xl border border-white/8 bg-card shadow-soft">
        <div className="grid grid-cols-[36px_minmax(200px,1.6fr)_repeat(3,minmax(84px,1fr))_minmax(150px,1.3fr)_132px] items-center gap-3 border-b border-white/8 px-4 py-2.5 text-body text-krypt-muted">
          <span>#</span>
          <span>Wallet</span>
          <span className="text-right">They made</span>
          <span className="text-right" title="Their profit as a share of what they spent buying">Return</span>
          <span className="text-right">Spent · coins</span>
          <button
            className={cls('text-right hover:text-white', order === 'copy' && 'text-white')}
            onClick={() => setOrder((o) => (o === 'pump' ? 'copy' : 'pump'))}
            title={`Median result per copy at ${size} SOL, from the replay. Click to sort by it.`}
            data-testid="pump-board-sort"
          >
            Copying them {order === 'copy' ? '↓' : ''}
          </button>
          <span />
        </div>
        {loading && !board ? (
          <div className="flex items-center justify-center gap-2 py-16 text-note text-krypt-muted">
            <Loader2 className="h-4 w-4 animate-spin" /> Reading pump.fun&rsquo;s leaderboard…
          </div>
        ) : !board ? (
          <div className="px-6 py-14 text-center text-note text-krypt-muted">{error || 'No leaderboard.'}</div>
        ) : (
          rows.map((e) => (
            <PumpRow
              key={e.wallet}
              e={e}
              st={results[e.wallet]}
              sum={summaries[e.wallet]}
              following={followed.includes(e.wallet.toLowerCase())}
              onCheck={() => nav.checkWallet(e.wallet)}
              onFollow={() => nav.follow(e.wallet)}
              onOpen={() => nav.openWallet(e.wallet)}
            />
          ))
        )}
      </div>
      <p className="mt-6 max-w-3xl text-body leading-relaxed text-krypt-muted">
        pump.fun ranks by what each wallet made itself, including coins it has not sold. A copy buys after them and sells after them, so the top of this list —
        one lucky coin, or trades over in seconds — is usually what a copier keeps least of. The &ldquo;Copying them&rdquo; column is the replay&rsquo;s median
        result per copy, after every fee; compare it with that, not with their profit.
      </p>
    </div>
  );
}

function PumpRow({
  e,
  st,
  sum,
  following,
  onCheck,
  onFollow,
  onOpen,
}: {
  e: PumpLeader;
  st: CopyReplayStatus | undefined;
  sum: ReturnType<typeof replaySummary> | undefined;
  following: boolean;
  onCheck: () => void;
  onFollow: () => void;
  onOpen: () => void;
}) {
  const warn = pumpLeaderCautions(e);
  return (
    <div
      className="grid grid-cols-[36px_minmax(200px,1.6fr)_repeat(3,minmax(84px,1fr))_minmax(150px,1.3fr)_132px] items-center gap-3 border-b border-white/[0.05] px-4 py-2.5 text-note last:border-b-0 hover:bg-white/[0.02]"
      data-testid="pump-row"
    >
      <span className="tabular-nums text-krypt-muted">{e.rank}</span>
      <button onClick={onOpen} className="flex min-w-0 items-center gap-2.5 text-left">
        <Avatar address={e.wallet} size={30} label={e.username ?? undefined} />
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="truncate font-medium text-white">{e.username ? `@${e.username}` : short(e.wallet, 5)}</span>
            {e.verified && <Tag tone="accent">verified</Tag>}
            {following && <Tag tone="up">following</Tag>}
            {warn.map((w) => (
              <Tag key={w} tone="warn" title={WARN_WHY[w]}>
                {w}
              </Tag>
            ))}
          </div>
          <div className="truncate text-body text-krypt-muted">
            {short(e.wallet, 4)}
            {e.topCoins.length ? ` · ${e.topCoins.map((c) => c.symbol ?? short(c.mint, 3)).join(', ')}` : ''}
          </div>
        </div>
      </button>
      <span className={cls('text-right tabular-nums', toneOf(e.pnlSol))} title={e.unrealizedSol !== null ? `${fmtAmt(e.realizedSol ?? 0, { signed: true })} sold, ${fmtAmt(e.unrealizedSol, { signed: true })} still held` : undefined}>
        {fmtAmt(e.pnlSol, { signed: true })}
      </span>
      <span className={cls('text-right tabular-nums', toneOf(e.pnlPct))}>{e.pnlPct === null ? DASH : fmtPctS(e.pnlPct, { signed: true, digits: 0 })}</span>
      <span className="text-right tabular-nums text-white">
        {e.spentSol === null ? DASH : fmtAmt(e.spentSol)}
        <span className="text-krypt-muted"> · {e.positions ?? DASH}</span>
      </span>
      <CopyCell st={st} sum={sum} />
      <div className="flex justify-end gap-1">
        <button className={btn.ghost} onClick={onCheck} title="Check this wallet: the full replay" data-testid="pump-row-check">
          <ScanSearch className="h-4 w-4" />
        </button>
        <a className={btn.ghost} href={`https://pump.fun/profile/${encodeURIComponent(e.username ?? e.wallet)}`} target="_blank" rel="noreferrer" title="Their pump.fun profile">
          <ExternalLink className="h-4 w-4" />
        </a>
        {!following && (
          <button className={btn.ghost} onClick={onFollow} title="Follow on paper">
            <Plus className="h-4 w-4" />
          </button>
        )}
      </div>
    </div>
  );
}

const WARN_WHY: Record<string, string> = {
  'one coin': 'The whole result is one coin — one call, not a record.',
  'one huge win': 'Over 10,000 % on what they spent: one early entry nobody copying them would have got.',
  'nothing sold': 'Nothing sold at a profit yet: all of it is coins still held, at today’s price.',
};

function CopyCell({ st, sum }: { st: CopyReplayStatus | undefined; sum: ReturnType<typeof replaySummary> | undefined }) {
  if (!st) return <span className="text-right text-body text-krypt-muted">{DASH}</span>;
  if (st.running)
    return (
      <span className="inline-flex items-center justify-end gap-1.5 text-right text-body text-krypt-muted">
        <Loader2 className="h-3.5 w-3.5 animate-spin" /> {st.phase === 'pricing' ? `${st.priced}/${st.toPrice}` : 'reading'}
      </span>
    );
  if (st.message && !sum) return <span className="truncate text-right text-body text-warn" title={st.message}>{st.message}</span>;
  if (!sum || sum.trips === 0) return <span className="text-right text-body text-krypt-muted">no finished trades</span>;
  return (
    <span className="text-right" title={`${sum.copied} copies priced of ${sum.trips} trades; ${sum.tooFast} over before a copy could land. Won ${fmtPctS(sum.winRatePct, { digits: 0 })}.`}>
      <span className={cls('tabular-nums', sum.medianPct === null ? 'text-krypt-muted' : toneOf(sum.medianPct))}>
        {sum.medianPct === null ? 'too few' : fmtPctS(sum.medianPct, { signed: true })}
      </span>
      <span className="text-body text-krypt-muted"> · {sum.copied} cop{sum.copied === 1 ? 'y' : 'ies'}</span>
    </span>
  );
}

function emptyStatus(address: string): CopyReplayStatus {
  return { address, running: false, phase: 'idle', startedAt: null, finishedAt: null, swaps: 0, tripsFound: 0, toPrice: 0, priced: 0, open: 0, calls: 0, cancelled: false, message: '', waitingUntil: null, trips: [] };
}
