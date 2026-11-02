// "Backtest these settings" (2026-11-01) — on the Follow page, under the
// settings it tests. A user asked for "a copy backtest that replays a
// wallet's past trades with my settings, delay and fees": the replay's read
// and pricing (ReplayPanel), run through this follow's own lag, sizing,
// rules and exits, priced with paper's model (shared/copyBacktest.ts).
//
// The page's draft is what is tested — saved or not — and a result run
// before the settings changed says so instead of passing for theirs.

import { useEffect, useMemo, useRef, useState } from 'react';
import { FlaskConical, Square } from 'lucide-react';
import { REPLAY_MAX_TRIPS, REPLAY_NEWEST_CREDITS_MAX, REPLAY_WEEK_CREDITS_MAX, REPLAY_WEEK_MAX_TRIPS, type CopyReplayStatus, type ReplaySpan } from '@shared/copyReplay';
import { BACKTEST_MIN_COPIES, backtestVerdict, type BacktestResult } from '@shared/copyBacktest';
import { SCOUT_TRIMMED_DROP } from '@shared/walletScout';
import type { CopyConfig } from '@shared/copytrade';
import { openTokenExternally } from '../../utils/links';
import { DASH, Fact, Panel, Segmented, btn, fmtAmt, fmtHold, fmtPctS, short, toneOf } from '../../ui/kit';
import { cls, fmtAgo } from '../../utils/format';
import { DayStrip } from './ReplayPanel';

const VERDICT_TONE = { loss: 'text-down', oneCopy: 'text-warn', tail: 'text-warn', positive: 'text-up' } as const;

/** The settings a result was run with, to tell when the page has moved on. */
const keyOf = (c: Partial<CopyConfig>, span: ReplaySpan): string => JSON.stringify([span, c]);

export function BacktestPanel({
  config,
  wallet,
  runSignal = 0,
  className = '',
}: {
  /** The page's draft, exactly as it would be saved. */
  config: Partial<CopyConfig>;
  wallet: string;
  /** Bumped by the page's own "Backtest these settings" button. */
  runSignal?: number;
  className?: string;
}) {
  const [span, setSpan] = useState<ReplaySpan>('newest');
  const [st, setSt] = useState<CopyReplayStatus | null>(null);
  const [ranWith, setRanWith] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [symbols, setSymbols] = useState<Record<string, string>>({});
  const running = st?.running === true;

  // What this session already has for the wallet (an earlier run, or one still going).
  useEffect(() => {
    setSt(null);
    setRanWith(null);
    setError('');
    let alive = true;
    void window.krypt.copy.backtestStatus(wallet).then((r) => {
      if (alive && r.ok && r.data && r.data.startedAt !== null) setSt(r.data);
    });
    return () => {
      alive = false;
    };
  }, [wallet]);
  useEffect(() => {
    if (!running) return;
    const id = setInterval(() => void window.krypt.copy.backtestStatus(wallet).then((r) => r.ok && r.data && setSt(r.data)), 1_000);
    return () => clearInterval(id);
  }, [running, wallet]);

  const run = async (): Promise<void> => {
    setError('');
    if (running) {
      const r = await window.krypt.copy.backtestCancel(wallet);
      if (r.ok && r.data) setSt(r.data);
      return;
    }
    const r = await window.krypt.copy.backtest({ config }, { week: span === 'week' });
    if (r.ok && r.data) {
      setSt(r.data);
      setRanWith(keyOf(config, span));
    } else if (!r.ok) setError(r.message);
  };
  // The page's button: start (never stop) a run.
  const lastSignal = useRef(runSignal);
  useEffect(() => {
    if (runSignal === lastSignal.current) return;
    lastSignal.current = runSignal;
    if (!running) void run();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runSignal]);

  const bt: BacktestResult | null = st?.backtest ?? null;
  const mintsKey = (bt?.copiesList ?? []).map((c) => c.mint).join(',');
  useEffect(() => {
    const mints = [...new Set(mintsKey ? mintsKey.split(',') : [])];
    if (!mints.length) return;
    void window.krypt.market.summaries(mints).then((r) => {
      if (!r.ok || !r.data) return;
      const out: Record<string, string> = {};
      for (const [m, s] of Object.entries(r.data as Record<string, { symbol?: string }>)) if (s?.symbol) out[m] = s.symbol;
      setSymbols(out);
    });
  }, [mintsKey]);
  const stale = !!bt && !running && ranWith !== null && ranWith !== keyOf(config, span);
  const unknownRun = !!bt && !running && ranWith === null;
  const verdict = useMemo(() => (bt ? backtestVerdict(bt) : null), [bt]);
  const sym = (m: string): string => symbols[m] ?? short(m, 4);
  const week = (st?.span ?? span) === 'week';

  return (
    <Panel
      className={className}
      title="Backtest these settings"
      subtitle={`${week ? `Every finished trade they opened in the last 7 days (the newest ${REPLAY_WEEK_MAX_TRIPS} at most)` : `Their newest ${REPLAY_MAX_TRIPS} finished trades`}, copied with this page’s size, limits, delay and exits, and priced with paper’s fees and price impact. Trades nothing.`}
      action={
        <>
          <Segmented<ReplaySpan>
            size="sm"
            value={span}
            onChange={setSpan}
            options={[
              { value: 'newest', label: `Newest ${REPLAY_MAX_TRIPS}`, title: `At most ${REPLAY_NEWEST_CREDITS_MAX.toLocaleString()} Helius credits from the backtest allowance` },
              { value: 'week', label: 'Whole week', title: `At most ${REPLAY_WEEK_CREDITS_MAX.toLocaleString()} Helius credits from the backtest allowance, usually half that` },
            ]}
          />
          <button onClick={() => void run()} className={running ? btn.secondary : btn.primary} data-testid="follow-backtest-run">
            {running ? <Square className="h-4 w-4" /> : <FlaskConical className="h-4 w-4" />}
            {running ? 'Stop' : bt ? 'Run again' : 'Backtest'}
          </button>
        </>
      }
    >
      <div data-testid="follow-backtest">
        {error && <p className="mb-2 text-body text-warn">{error}</p>}
        {!st ? (
          <p className="text-note text-krypt-muted">
            Reads their recent trades from the chain, then copies each one the way this follow would: behind them by your delay plus the follower’s latency, sized
            as above, refused by every limit and filter that the trades alone can judge, and sold on their sell or your max hold. Each refusal is counted by the rule
            that made it, and the rules it cannot judge are listed, never guessed. Prices from the chain through your Helius key first (inside the backtest
            allowance), pump.fun’s trade history for the rest.
          </p>
        ) : (
          <>
            <p className="text-body text-krypt-muted" data-testid="follow-backtest-status">
              {st.phase === 'reading'
                ? 'Reading their recent swaps from the chain…'
                : st.phase === 'pricing' && running
                  ? st.waitingUntil
                    ? `Pricing ${st.priced} of ${st.toPrice} trades… pump.fun asked us to slow down, waiting ${Math.max(1, Math.ceil((st.waitingUntil - Date.now()) / 1000))} s`
                    : `Pricing ${st.priced} of ${st.toPrice} trades…`
                  : st.finishedAt
                    ? `${st.cancelled ? 'Stopped' : 'Done'} ${fmtAgo(st.finishedAt)} · ${st.swaps} swaps read, ${st.tripsFound} finished trades${
                        (st.viaChain ?? 0) + (st.viaPump ?? 0) > 0 ? ` · ${st.viaChain ?? 0} priced from the chain (${(st.credits ?? 0).toLocaleString()} Helius credits), ${st.viaPump ?? 0} from pump.fun’s history` : ''
                      }`
                    : ''}
              {st.fallbackWhy ? <span> · the slower path was used because {st.fallbackWhy}</span> : null}
              {st.message ? <span className="text-warn"> · {st.message}</span> : null}
            </p>
            {week && st.weekShort && !running && <p className="mt-1 text-body text-warn">{st.weekShort}</p>}
            {(stale || unknownRun) && (
              <p className="mt-2 text-body text-warn" data-testid="follow-backtest-stale">
                {stale ? 'The settings have changed since this backtest — run it again to test them.' : 'This is an earlier backtest of this wallet, maybe with other settings — run it again to test these.'}
              </p>
            )}
            {bt && !running && <Result bt={bt} sym={sym} />}
            {verdict && !running && <p className={cls('mt-3 text-note leading-relaxed', VERDICT_TONE[verdict.kind])}>{verdict.text}</p>}
          </>
        )}
      </div>
    </Panel>
  );
}

function Result({ bt, sym }: { bt: BacktestResult; sym: (m: string) => string }) {
  const few = bt.priced > 0 && bt.priced < BACKTEST_MIN_COPIES;
  return (
    <>
      <div className="mt-4 grid grid-cols-2 gap-x-6 gap-y-4 sm:grid-cols-3 lg:grid-cols-4" data-testid="follow-backtest-facts">
        <Fact
          label="Copies taken"
          value={`${bt.copies} of ${bt.trips}`}
          hint={`${bt.skippedTotal} refused by your rules (below)${bt.unpriced ? `, ${bt.unpriced} taken but not priced — in the limits, in no SOL figure` : ''}.`}
        />
        <Fact
          label="All copies together"
          value={bt.totalSol === null ? DASH : fmtAmt(bt.totalSol, { signed: true, unit: 'SOL' })}
          tone={toneOf(bt.totalSol)}
          hint={bt.spentSol === null ? undefined : `${bt.priced} priced copies, ${fmtAmt(bt.spentSol)} SOL put in across them.`}
        />
        <Fact
          label="Without the best copy"
          value={bt.withoutBestSol === null ? DASH : fmtAmt(bt.withoutBestSol, { signed: true, unit: 'SOL' })}
          tone={toneOf(bt.withoutBestSol)}
          hint="The total with the single best copy left out — one lucky trade should not carry the result."
        />
        <Fact
          label="Best copy"
          value={bt.best?.pnlSol == null ? DASH : fmtAmt(bt.best.pnlSol, { signed: true, unit: 'SOL' })}
          tone={toneOf(bt.best?.pnlSol)}
          hint={bt.best ? `${sym(bt.best.mint)}, ${fmtPctS(bt.best.pct, { signed: true })} on ${fmtAmt(bt.best.sol)} SOL.` : undefined}
        />
        <Fact label="Median per copy" value={fmtPctS(bt.medianPct, { signed: true })} tone={toneOf(bt.medianPct)} hint={`Over the priced copies. Under ${BACKTEST_MIN_COPIES}, no median.`} />
        <Fact label="Mean per copy" value={fmtPctS(bt.meanPct, { signed: true })} tone={toneOf(bt.meanPct)} hint={bt.meanSol === null ? undefined : `${fmtAmt(bt.meanSol, { signed: true })} SOL a copy.`} />
        <Fact label="Copies that won" value={fmtPctS(bt.winRatePct, { digits: 0 })} />
        <Fact
          label={`Best ${SCOUT_TRIMMED_DROP} / every other`}
          value={bt.bestFewSol === null || bt.restSol === null ? DASH : `${fmtAmt(bt.bestFewSol, { signed: true })} / ${fmtAmt(bt.restSol, { signed: true })}`}
          tone={toneOf(bt.restSol)}
          hint="What the five best copies made together, and every other copy, SOL."
        />
      </div>
      {few && <p className="mt-3 text-body text-warn">Only {bt.priced} cop{bt.priced === 1 ? 'y' : 'ies'} priced — too few to say much; a handful of trades swings a lot.</p>}
      {bt.days.length >= 2 && <DayStrip days={bt.days} />}

      <div className="mt-5 grid grid-cols-1 gap-5 lg:grid-cols-2">
        <div data-testid="follow-backtest-skipped">
          <div className="mb-1.5 text-note font-medium text-white">Refused by your rules</div>
          {bt.skipped.length === 0 ? (
            <p className="text-body text-krypt-muted">None — every trade passed the rules the backtest could judge.</p>
          ) : (
            <ul className="space-y-1">
              {bt.skipped.map((s) => (
                <li key={s.rule} className="flex justify-between gap-3 text-body">
                  <span className="text-krypt-muted">{s.label}</span>
                  <span className="tabular-nums text-white">{s.count}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
        <div data-testid="follow-backtest-not-applied">
          <div className="mb-1.5 text-note font-medium text-white">Not applied — the trades cannot judge these</div>
          <ul className="space-y-1">
            {bt.notApplied.map((n) => (
              <li key={n.key} className="text-body text-krypt-muted">
                <span className="text-white">{n.label}</span> — {n.why}.
              </li>
            ))}
          </ul>
        </div>
      </div>

      <div className="mt-4">
        <div className="mb-1.5 text-note font-medium text-white">Assumed</div>
        <ul className="list-disc space-y-1 pl-5 text-body text-krypt-muted" data-testid="follow-backtest-assumptions">
          {bt.assumptions.map((a) => (
            <li key={a}>{a}</li>
          ))}
        </ul>
      </div>

      {bt.copiesList.length > 0 && (
        <div className="mt-4 max-h-[320px] overflow-auto rounded-lg border border-white/8" data-testid="follow-backtest-copies">
          <div className="grid grid-cols-[minmax(110px,1.4fr)_repeat(5,minmax(64px,1fr))] gap-3 border-b border-white/8 px-4 py-2 text-body text-krypt-muted">
            <span>Coin</span>
            <span className="text-right">Bought</span>
            <span className="text-right">Held</span>
            <span className="text-right">They bought</span>
            <span className="text-right">Your copy</span>
            <span className="text-right">It made</span>
          </div>
          {bt.copiesList.map((c, i) => (
            <div key={`${c.mint}${c.at}${i}`} className="grid grid-cols-[minmax(110px,1.4fr)_repeat(5,minmax(64px,1fr))] items-center gap-3 border-b border-white/[0.05] px-4 py-2 text-note last:border-b-0">
              <button onClick={() => openTokenExternally(c.mint, 'solana')} className="truncate text-left font-medium text-white hover:underline" title={c.mint}>
                {sym(c.mint)}
              </button>
              <span className="text-right text-krypt-muted">{fmtAgo(c.at)}</span>
              <span className="text-right tabular-nums text-white" title={c.exitBy === 'maxHold' ? 'Sold by your max hold, before their sell' : 'Sold on their sell'}>
                {fmtHold(c.exitAt - c.at)}
                {c.exitBy === 'maxHold' ? <span className="text-body text-krypt-muted"> max</span> : null}
              </span>
              <span className="text-right tabular-nums text-white">{fmtAmt(c.theirSol)}</span>
              <span className="text-right tabular-nums text-white">{fmtAmt(c.sol)}</span>
              <span className={cls('text-right tabular-nums', toneOf(c.pnlSol))} title={c.pct === null ? 'Not priced — no trade to price it at then' : `${fmtPctS(c.pct, { signed: true })} after fees and impact`}>
                {c.pnlSol === null ? <span className="text-body text-krypt-muted">not priced</span> : fmtAmt(c.pnlSol, { signed: true })}
              </span>
            </div>
          ))}
        </div>
      )}
      <p className="mt-3 text-body leading-relaxed text-krypt-muted">
        Past trades, not a forecast. A copy fills at the price the market stood at when it landed, plus its own impact; a real fill can do worse.
      </p>
    </>
  );
}
