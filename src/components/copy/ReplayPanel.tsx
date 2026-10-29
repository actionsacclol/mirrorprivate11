// "Replay copying them" (2026-10-23; its own file 2026-10-25, when the Check
// page became its second home): a wallet's newest finished trades, each
// copied 2 s behind both legs and priced at the market it would have met.
// The profile shows it under the record; Check runs it the moment a wallet
// is entered. Sized at a fixed amount, or by their trade like a follow.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { History, Square } from 'lucide-react';
import { FOLLOWER_LAG_MS, SCORE_MIN_F_TRIPS } from '@shared/walletScore';
import {
  REPLAY_MAX_TRIPS,
  REPLAY_MIN_COPY_SOL,
  REPLAY_WEEK_MAX_TRIPS,
  replayCopySol,
  replaySummary,
  replayVerdict,
  type CopyReplayStatus,
  type ReplayDay,
  type ReplaySizing,
  type ReplaySpan,
  type ReplaySummary,
  type ReplayTrip,
  type ReplayVerdict,
} from '@shared/copyReplay';
import { SCOUT_TRIMMED_DROP, SCOUT_TRIMMED_MIN_COPIES } from '@shared/walletScout';
import { openTokenExternally } from '../../utils/links';
import { DASH, Fact, Panel, btn, fmtAmt, fmtHold, fmtPctS, short, toneOf } from '../../ui/kit';
import { cls, fmtAgo } from '../../utils/format';

const REPLAY_NOTE: Record<ReplayTrip['note'], string> = {
  filled: '',
  'too-fast': 'over before a copy could land',
  unpriced: 'not priced — pump.fun has no trades for it then',
};

/**
 * "What would copying them have done?" for any Solana wallet (2026-10-23,
 * shared/copyReplay.ts): their newest finished trades, each mirrored 2 s
 * behind both legs and priced at the market it would have met. Works for a
 * wallet the feed never saw — a pasted address, a pump.fun username — which
 * is what the record above cannot price.
 */
const NO_SYMBOLS: Record<string, string> = {};

const VERDICT_TONE: Record<ReplayVerdict['kind'], string> = { loss: 'text-down', tail: 'text-warn', oneDay: 'text-warn', positive: 'text-up' };

/** A finished replay, summed at the panel's size — what the profile's verdict
 *  leads with once it exists (2026-10-25). */
export interface ReplayResult {
  status: CopyReplayStatus;
  summary: ReplaySummary;
}

export function ReplayPanel({
  address,
  size,
  sizing = null,
  symbols: known = NO_SYMBOLS,
  autoStart = false,
  className = 'mt-6',
  onResult,
  span = 'newest',
}: {
  address: string;
  /** The fixed copy size, SOL; ignored while `sizing` is set. */
  size: number;
  /** Sized by their trade instead. */
  sizing?: ReplaySizing | null;
  symbols?: Record<string, string>;
  /** Start a replay on open unless this session already ran one for them. */
  autoStart?: boolean;
  className?: string;
  /** Told the finished replay's figures, and null while none is finished
   *  (a new wallet, a run in progress). */
  onResult?: (r: ReplayResult | null) => void;
  /** Which trades to replay (2026-10-28): the newest thirty, or every
   *  trade of the last seven days. */
  span?: ReplaySpan;
}) {
  const [st, setSt] = useState<CopyReplayStatus | null>(null);
  const [symbols, setSymbols] = useState<Record<string, string>>({});
  const started = useRef<string | null>(null);
  // A span asked for while a run of the other span was still going: it
  // starts when that run ends (2026-10-28 — switching to "Whole week"
  // mid-run used to show the newest-30 run and never start the week).
  const [queued, setQueued] = useState<string | null>(null);
  const begin = useCallback(
    (key: string, alive: () => boolean) => {
      started.current = key;
      void window.krypt.scout.replay(address, { checks: true, week: span === 'week' }).then((x) => {
        if (!alive()) return;
        if (x.ok && x.data) setSt(x.data);
        else if (!x.ok) setSt({ ...emptyReplay(address), message: x.message });
      });
    },
    [address, span],
  );
  useEffect(() => {
    setSt(null);
    setQueued(null);
    let alive = true;
    void window.krypt.scout.replayStatus(address).then((r) => {
      if (!alive) return;
      const have = r.ok && r.data && r.data.startedAt !== null ? r.data : null;
      // A run of the same span (or any run, when nothing is to start, or one
      // still going) is shown as it is.
      const key = `${address}:${span}`;
      if (have && ((have.span ?? 'newest') === span || !autoStart)) return void setSt(have);
      if (have?.running) {
        // The other span is still going: show it, and start this one after.
        setSt(have);
        if (started.current !== key) setQueued(key);
        return;
      }
      // Nothing run for them yet this session, or a run of the other span:
      // Check asked for this one. Once per wallet and span, never on a
      // re-render.
      if (autoStart && started.current !== key) begin(key, () => alive);
    });
    return () => {
      alive = false;
    };
  }, [address, autoStart, span, begin]);
  const running = st?.running === true;
  useEffect(() => {
    if (running || !queued || queued !== `${address}:${span}`) return;
    setQueued(null);
    begin(queued, () => true);
  }, [running, queued, address, span, begin]);
  useEffect(() => {
    if (!running) return;
    const id = setInterval(() => void window.krypt.scout.replayStatus(address).then((r) => r.ok && r.data && setSt(r.data)), 1_000);
    return () => clearInterval(id);
  }, [running, address]);
  const mintsKey = (st?.trips ?? []).map((t) => t.mint).join(',');
  useEffect(() => {
    const mints = [...new Set(mintsKey ? mintsKey.split(',') : [])].filter((m) => !known[m]);
    if (!mints.length) return;
    void window.krypt.market.summaries(mints).then((r) => {
      if (!r.ok || !r.data) return;
      const out: Record<string, string> = {};
      for (const [m, s] of Object.entries(r.data as Record<string, { symbol?: string }>)) if (s?.symbol) out[m] = s.symbol;
      setSymbols(out);
    });
  }, [mintsKey, known]);
  const toggle = async (): Promise<void> => {
    const r = running ? await window.krypt.scout.replayCancel(address) : await window.krypt.scout.replay(address, { checks: true, week: span === 'week' });
    if (r.ok && r.data) setSt(r.data);
    else if (!r.ok) setSt((s) => ({ ...(s ?? emptyReplay(address)), message: r.message }));
  };
  const trips = useMemo(() => st?.trips ?? [], [st]);
  const sum = useMemo(() => replaySummary(trips, size, sizing), [trips, size, sizing]);
  // The page above hears the result once the run is over — the same figures
  // this panel shows, so the verdict and the panel cannot disagree.
  useEffect(() => {
    if (!onResult) return;
    onResult(st && !st.running && st.finishedAt !== null && trips.length > 0 ? { status: st, summary: sum } : null);
  }, [onResult, st, sum, trips.length]);
  // Two calls a trade at the swap API's 2 s pace — the slow path only; the
  // chain prices the lot in seconds (2026-10-24).
  const slow = !!st?.fallbackWhy;
  const left = st && st.toPrice > st.priced ? (st.toPrice - st.priced) * 4 : 0;
  const via =
    st && ((st.viaChain ?? 0) > 0 || (st.viaPump ?? 0) > 0)
      ? ` · ${st.viaChain ?? 0} priced from the chain (${(st.credits ?? 0).toLocaleString()} Helius credits), ${st.viaPump ?? 0} from pump.fun’s history`
      : '';
  const sym = (m: string): string => known[m] ?? symbols[m] ?? short(m, 4);
  // What the shown run covers: its own span once it exists, else the asked one.
  const week = (st?.span ?? span) === 'week';
  // A week check that could not read the whole week draws no week verdict
  // (2026-10-28): its figures are for the part that was read.
  const weekShort = week ? (st?.weekShort ?? null) : null;
  const verdict = replayVerdict(sum, week && !weekShort);

  return (
    <Panel
      className={className}
      title={week ? (weekShort ? 'Replay part of their week' : 'Replay their whole week') : 'Replay copying them'}
      subtitle={`${week ? `Every finished trade they opened in the last 7 days (the newest ${REPLAY_WEEK_MAX_TRIPS} at most)` : `Their newest ${REPLAY_MAX_TRIPS} finished trades`}, each copied ${FOLLOWER_LAG_MS / 1000} s behind their buy and their sell, at the price the market stood at then. ${
        sizing ? `Each copy ${sizing.share}% of what they put in, up to ${sizing.cap} SOL` : `Priced at ${size} SOL a copy`
      }, with paper's fees.`}
      action={
        <button
          onClick={() => void toggle()}
          className={running ? btn.secondary : btn.primary}
          data-testid="profile-replay"
          title="Reads their recent trades from the chain, then prices each copy: from the chain through your Helius key first (seconds, about 300 credits from the backtest allowance), pump.fun's trade history for anything left (slow, free). Trades nothing."
        >
          {running ? <Square className="h-4 w-4" /> : <History className="h-4 w-4" />}
          {running ? 'Stop' : st?.finishedAt && (st.span ?? 'newest') === span ? 'Replay again' : span === 'week' ? 'Replay the week' : 'Replay'}
        </button>
      }
    >
      {!st ? (
        <p className="text-note text-krypt-muted">
          Works for any Solana wallet, including one this app never watched. It reads their recent swaps from the chain, pairs them into finished trades, and
          prices a copy of each. With a Helius key in Settings, both happen on the chain in seconds: the copy fills at the coin’s price nine slots (2 s)
          after theirs, about 300 credits a replay from the backtest allowance. Without a key, or once the allowance is spent, it falls back to pump.fun’s
          trade history: up to four minutes for the read on Solana’s free RPC, and two to five more for {REPLAY_MAX_TRIPS} trades, because pump.fun pauses
          its history about once every fifty requests. Trades nothing.
        </p>
      ) : (
        <>
          <p className="text-body text-krypt-muted" data-testid="profile-replay-status">
            {st.phase === 'reading'
              ? 'Reading their recent swaps from the chain…'
              : st.phase === 'pricing' && running
                ? st.waitingUntil
                  ? `Pricing ${st.priced} of ${st.toPrice} trades… pump.fun asked us to slow down, waiting ${Math.max(1, Math.ceil((st.waitingUntil - Date.now()) / 1000))} s`
                  : `Pricing ${st.priced} of ${st.toPrice} trades…${slow ? ` about ${left} s left` : ''}`
                : st.finishedAt
                  ? `${st.cancelled ? 'Stopped' : 'Done'} ${fmtAgo(st.finishedAt)} · ${st.swaps} swaps read, ${st.tripsFound} finished trades${st.open ? `, ${st.open} still open` : ''}${via}`
                  : ''}
            {st.fallbackWhy ? <span className="text-krypt-muted"> · the slower path was used because {st.fallbackWhy}</span> : null}
            {st.message ? <span className="text-warn"> · {st.message}</span> : null}
            {queued && running ? (
              <span className="text-krypt-text" data-testid="replay-queued">
                {' '}
                · {span === 'week' ? 'The whole week' : 'The newest trades'} start{span === 'week' ? 's' : ''} as soon as this run ends.
              </span>
            ) : null}
          </p>
          {st.checks && !running && (
            <p
              className={cls('mt-1 text-body', st.checks.bundleTrips > 0 || st.checks.washTrips >= 2 || st.checks.sharedPayers >= 2 ? 'text-down' : 'text-krypt-muted')}
              data-testid="profile-replay-checks"
              title="Launch bundle: bought inside a coin's launch transaction or the four right after it in the same slot (185 of 186 such buys were the launcher's). Snipe: opened within five slots of the coin's first trade. Wash: bought and sold one coin inside one transaction. Shared payer: another wallet paid this one's fees."
            >
              Checks: {st.checks.bundleTrips} launch-bundle buy{st.checks.bundleTrips === 1 ? '' : 's'}, {st.checks.sniperTrips} snipe{st.checks.sniperTrips === 1 ? '' : 's'} over {st.checks.mintsChecked} checked · {st.checks.washTrips} same-transaction round trip
              {st.checks.washTrips === 1 ? '' : 's'} · {st.checks.sharedPayers} other fee payer{st.checks.sharedPayers === 1 ? '' : 's'}.
              {st.checks.mintsChecked === 0 && st.toPrice > 0 ? ' The coins were not read (no Helius key, or the allowance is spent): only the swaps were checked.' : ''}
            </p>
          )}
          {trips.length > 0 && (
            <>
              <div className="mt-4 grid grid-cols-2 gap-x-6 gap-y-4 sm:grid-cols-3 lg:grid-cols-6">
                <Fact
                  label="Result per copy"
                  value={fmtPctS(sum.medianPct, { signed: true })}
                  tone={sum.medianPct !== null && sum.medianPct < 0 ? 'text-down' : undefined}
                  hint="Median over the copies that could be priced. Under five, no median."
                />
                <Fact label="Copies that won" value={fmtPctS(sum.winRatePct, { digits: 0 })} />
                <Fact
                  label="All copies together"
                  value={sum.totalSol === null ? DASH : fmtAmt(sum.totalSol, { signed: true, unit: 'SOL' })}
                  tone={toneOf(sum.totalSol)}
                  hint={
                    sizing
                      ? `${sum.copied} copies, each sized by their trade${sum.spentSol === null ? '' : ` — ${fmtAmt(sum.spentSol)} SOL put in across them`}.`
                      : `${sum.copied} copies of ${size} SOL each.`
                  }
                />
                <Fact
                  label="Copies priced"
                  value={`${sum.copied} of ${sum.trips}`}
                  hint={`${sum.tooFast} over before a copy could land, ${sum.unpriced} not priced${
                    sum.skippedSmall ? `, ${sum.skippedSmall} too small to copy (their share came under ${REPLAY_MIN_COPY_SOL} SOL)` : ''
                  }.`}
                />
                <Fact label="Too fast to copy" value={String(sum.tooFast)} tone={sum.tooFast > sum.copied ? 'text-warn' : undefined} />
                <Fact
                  label="A copy that goes nowhere"
                  value={fmtPctS(sum.feeFloorPct, { signed: true })}
                  hint={`Fees alone, price unchanged, at ${sizing ? `the ${sizing.cap} SOL cap (a smaller copy loses more)` : 'this size'}. Compare the result per copy with this, not with zero.`}
                />
              </div>
              {sum.meanPct !== null && (week || sum.copied >= SCOUT_TRIMMED_MIN_COPIES) && (
                <div className="mt-4 grid grid-cols-2 gap-x-6 gap-y-4 border-t border-white/[0.06] pt-4 sm:grid-cols-4" data-testid="replay-week-facts">
                  <Fact
                    label="Mean per copy"
                    value={fmtPctS(sum.meanPct, { signed: true })}
                    tone={toneOf(sum.meanPct)}
                    hint="What the total is made of. Next to the median: a mean far above it means a few big copies carry the rest."
                  />
                  <Fact
                    label={`Mean without best ${SCOUT_TRIMMED_DROP}`}
                    value={fmtPctS(sum.trimmedMeanPct, { signed: true })}
                    tone={toneOf(sum.trimmedMeanPct)}
                    hint={`The same mean with the ${SCOUT_TRIMMED_DROP} best copies left out — whether anything is left once the tail is gone. Needs ${SCOUT_TRIMMED_MIN_COPIES} copies.`}
                  />
                  <Fact
                    label={`Best ${SCOUT_TRIMMED_DROP} copies made`}
                    value={sum.bestSol === null ? DASH : fmtAmt(sum.bestSol, { signed: true, unit: 'SOL' })}
                    tone={toneOf(sum.bestSol)}
                  />
                  <Fact
                    label="Every other copy"
                    value={sum.restSol === null ? DASH : fmtAmt(sum.restSol, { signed: true, unit: 'SOL' })}
                    tone={toneOf(sum.restSol)}
                    hint={sum.restSol === null ? undefined : `${Math.max(0, sum.copied - SCOUT_TRIMMED_DROP)} copies.`}
                  />
                </div>
              )}
              {weekShort && !running && (
                <p className="mt-3 text-note leading-relaxed text-warn" data-testid="replay-week-short">
                  {weekShort}
                </p>
              )}
              {sum.days.length >= 2 && <DayStrip days={sum.days} />}
              {verdict && !running && (
                <p className={cls('mt-3 text-note leading-relaxed', VERDICT_TONE[verdict.kind])} data-testid="replay-week-verdict">
                  {verdict.text}
                </p>
              )}
              {sum.copied > 0 && sum.copied < SCORE_MIN_F_TRIPS && (
                <p className="mt-3 text-body text-warn">
                  Only {sum.copied} cop{sum.copied === 1 ? 'y' : 'ies'} priced — too few to say much; a handful of trades swings a lot.
                </p>
              )}
              <div className="mt-4 max-h-[320px] overflow-auto rounded-lg border border-white/8" data-testid="profile-replay-trips">
                <div className="grid grid-cols-[minmax(110px,1.4fr)_repeat(6,minmax(64px,1fr))] gap-3 border-b border-white/8 px-4 py-2 text-body text-krypt-muted">
                  <span>Coin</span>
                  <span className="text-right">Closed</span>
                  <span className="text-right">Held</span>
                  <span className="text-right">They put in</span>
                  <span className="text-right">Your copy</span>
                  <span className="text-right">They made</span>
                  <span className="text-right">A copy made</span>
                </div>
                {trips.map((t, i) => {
                  const mine = sizing ? replayCopySol(t, sizing) : size;
                  return (
                  <div
                    key={`${t.mint}${t.closedAt}${i}`}
                    className="grid grid-cols-[minmax(110px,1.4fr)_repeat(6,minmax(64px,1fr))] items-center gap-3 border-b border-white/[0.05] px-4 py-2 text-note last:border-b-0"
                  >
                    <button onClick={() => openTokenExternally(t.mint, 'solana')} className="truncate text-left font-medium text-white hover:underline" title={t.mint}>
                      {sym(t.mint)}
                    </button>
                    <span className="text-right text-krypt-muted">{fmtAgo(t.closedAt)}</span>
                    <span className={cls('text-right tabular-nums', t.holdMs < 60_000 ? 'text-warn' : 'text-white')}>{fmtHold(t.holdMs)}</span>
                    <span className="text-right tabular-nums text-white">{fmtAmt(t.cost)}</span>
                    <span className={cls('text-right tabular-nums', mine === null ? 'text-krypt-muted' : 'text-white')} title={mine === null ? `Their share came under ${REPLAY_MIN_COPY_SOL} SOL — not copied` : undefined}>
                      {mine === null ? 'too small' : fmtAmt(mine)}
                    </span>
                    <span className={cls('text-right tabular-nums', toneOf(t.pnl))}>{fmtAmt(t.pnl, { signed: true })}</span>
                    <span className={cls('text-right tabular-nums', toneOf(t.returnPct))} title={
                        REPLAY_NOTE[t.note] ||
                        `Swap fees included; your size’s network fees are in the figures above. Priced from ${t.source === 'chain' ? 'the chain, to the slot' : 'pump.fun’s trade history, to the second'}.`
                      }>
                      {t.returnPct !== null && mine === null ? (
                        <span className="text-body text-krypt-muted">not copied</span>
                      ) : t.returnPct !== null ? (
                        fmtPctS(t.returnPct, { signed: true })
                      ) : (
                        <span className="text-body text-krypt-muted">{running && i >= st.priced ? '…' : REPLAY_NOTE[t.note] || DASH}</span>
                      )}
                    </span>
                  </div>
                  );
                })}
              </div>
              <p className="mt-3 text-body leading-relaxed text-krypt-muted">
                A copy buys after them at the price their buy left behind, and sells after them the same way. Slippage past that price is not modelled, so a real copy
                does a little worse. Each row includes the swap fees; the figures above also take your size’s network fees. Past trades, not a forecast — and this is
                the wallet the account signs in with; they may trade from others too.
              </p>
            </>
          )}
        </>
      )}
    </Panel>
  );
}

/** The copies by the day they closed: one cell a day, what that day made. */
function DayStrip({ days }: { days: ReplayDay[] }) {
  const up = days.filter((d) => d.totalSol !== null && d.totalSol > 0).length;
  return (
    <div className="mt-4" data-testid="replay-days">
      <div className="mb-1.5 text-body text-krypt-muted">
        By day · {up} of {days.length} day{days.length === 1 ? '' : 's'} positive
      </div>
      <div className="flex flex-wrap gap-1.5">
        {days.map((d) => (
          <div
            key={d.day}
            className={cls(
              'min-w-[84px] rounded-lg border px-2.5 py-1.5',
              d.totalSol === null ? 'border-white/8' : d.totalSol > 0 ? 'border-up/30 bg-up/[0.06]' : 'border-down/30 bg-down/[0.06]',
            )}
            title={`${d.copies} cop${d.copies === 1 ? 'y' : 'ies'} closed that day, ${d.wins} won`}
          >
            <div className="text-body text-krypt-muted">{new Date(d.day).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric' })}</div>
            <div className={cls('text-note font-medium tabular-nums', toneOf(d.totalSol))}>{d.totalSol === null ? DASH : fmtAmt(d.totalSol, { signed: true })}</div>
            <div className="text-body text-krypt-muted">{d.copies} cop{d.copies === 1 ? 'y' : 'ies'}</div>
          </div>
        ))}
      </div>
    </div>
  );
}

function emptyReplay(address: string): CopyReplayStatus {
  return { address, running: false, phase: 'idle', startedAt: null, finishedAt: null, swaps: 0, tripsFound: 0, toPrice: 0, priced: 0, open: 0, calls: 0, cancelled: false, message: '', waitingUntil: null, trips: [] };
}
