// The pre-registered test (2026-10-25, shared/prereg.ts): the experiment that
// settles whether copying the board's picks is worth anything, shown as it
// runs. Each week's rule and arms are frozen and hashed before the week
// begins; when it ends, every arm is replayed from the chain and compared
// with the same-week random draw, pump.fun's leaderboard, the fee floor and
// copying nobody. The page never re-ranks and never hides a bad week.

import { useEffect, useState } from 'react';
import { Loader2, Lock, Play, Square } from 'lucide-react';
import { PREREG_ARM_N, PREREG_FUTILITY_WEEKS, PREREG_LAGS, PREREG_MAX_TRIPS, PREREG_SIZE_SOL, type PreregArmResult, type PreregSettled, type PreregStatus, type PreregWeek } from '@shared/prereg';
import { useToast } from '../../state/ToastProvider';
import { DASH, Tag, btn, fmtPctS } from '../../ui/kit';
import { cls, fmtAgo } from '../../utils/format';

const OUTCOME_LABEL: Record<PreregStatus['verdict']['outcome'], { text: string; tone: 'neutral' | 'up' | 'down' | 'warn' | 'accent' }> = {
  running: { text: 'Running', tone: 'accent' },
  futile: { text: 'Stopped for futility', tone: 'down' },
  pass: { text: 'Pass', tone: 'up' },
  'fail-latency': { text: 'Fail — latency', tone: 'down' },
  'fail-selection': { text: 'Fail — selection', tone: 'down' },
  inconclusive: { text: 'Fail — inconclusive', tone: 'warn' },
};

const fmtDate = (ms: number): string => new Date(ms).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
const fmtWhen = (ms: number): string => new Date(ms).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });

/** An arm's cell: median, interval, copies. */
function ArmCell({ a, floorPct }: { a: PreregArmResult | null | undefined; floorPct: number }) {
  if (!a || a.copies === 0) return <span className="text-right tabular-nums text-krypt-muted">{DASH}</span>;
  const tone = a.medianPct === null ? 'text-krypt-muted' : a.medianPct > 0 ? 'text-up' : a.medianPct > floorPct ? 'text-warn' : 'text-down';
  return (
    <span className="text-right tabular-nums" title={`${a.copies} copies from ${a.walletsPriced} of ${a.wallets} wallets, ${a.skipped} skipped (too fast or unpriced); ${fmtPctS(a.winRatePct, { digits: 0 })} won; 1 %-trimmed mean ${fmtPctS(a.trimmedMeanPct, { signed: true })}; ${a.netSol === null ? '—' : `${a.netSol >= 0 ? '+' : ''}${a.netSol.toFixed(3)} SOL`} net at ${PREREG_SIZE_SOL} SOL a copy`}>
      <span className={cls('font-semibold', tone)}>{fmtPctS(a.medianPct, { signed: true })}</span>
      <span className="block text-label text-krypt-muted">
        {a.ci ? `${fmtPctS(a.ci.lo, { signed: true })} to ${fmtPctS(a.ci.hi, { signed: true })}` : 'no interval'} · {a.copies}
      </span>
    </span>
  );
}

function DiffCell({ d }: { d: { diff: number; lo: number; hi: number } | null }) {
  if (!d) return <span className="text-right tabular-nums text-krypt-muted">{DASH}</span>;
  const tone = d.lo > 0 ? 'text-up' : d.hi < 0 ? 'text-down' : 'text-krypt-muted';
  return (
    <span className="text-right tabular-nums" title="TOP minus the other arm, median per copy, with a mint-clustered bootstrap 90 % interval. Green only when the whole interval is above zero.">
      <span className={cls('font-semibold', tone)}>{d.diff >= 0 ? '+' : ''}{d.diff.toFixed(1)}</span>
      <span className="block text-label text-krypt-muted">
        {d.lo >= 0 ? '+' : ''}{d.lo.toFixed(1)} to {d.hi >= 0 ? '+' : ''}{d.hi.toFixed(1)}
      </span>
    </span>
  );
}

function FreezeCard({ w, settled, bad, canSettle, onSettle, busy }: { w: PreregWeek; settled: PreregSettled | undefined; bad: boolean; canSettle: boolean; onSettle: () => void; busy: boolean }) {
  const top = w.arms.find((a) => a.name === 'TOP');
  const rand = w.arms.find((a) => a.name === 'RAND');
  const lead = w.arms.find((a) => a.name === 'LEAD');
  return (
    <div className="rounded-lg border border-white/8 bg-white/[0.02] px-3 py-2.5 text-body" data-testid="prereg-freeze">
      <div className="flex flex-wrap items-center gap-2">
        <Lock className="h-3.5 w-3.5 text-krypt-muted" />
        <span className="font-medium text-white">Week of {fmtDate(w.week)}</span>
        <span className="text-krypt-muted">frozen {fmtWhen(w.frozenAt)}</span>
        {w.late && (
          <Tag tone="warn" title="Written after the week had begun: its data existed when the rule did. The week counts, flagged.">
            late
          </Tag>
        )}
        {bad && (
          <Tag tone="down" title="The file on disk no longer hashes to the hash it carries. It was edited after the freeze.">
            hash mismatch
          </Tag>
        )}
        {settled ? (
          <Tag tone={settled.complete ? 'up' : 'warn'}>{settled.complete ? 'settled' : 'settled (incomplete)'}</Tag>
        ) : canSettle ? (
          <button className={cls(btn.secondary, '!px-2.5 !py-1 ml-auto')} onClick={onSettle} disabled={busy} data-testid="prereg-settle">
            <Play className="h-3.5 w-3.5" /> Settle
          </button>
        ) : (
          <Tag>in progress</Tag>
        )}
      </div>
      <div className="mt-1 font-mono text-label text-krypt-muted" title={`sha256 ${w.hash}`}>
        {w.hash.slice(0, 16)}…
      </div>
      <div className="mt-1 text-krypt-muted">
        Rule: lower bound of the shrunk median, μ {w.rule.muPct.toFixed(1)} %, k {w.rule.k.toFixed(0)}
        {w.rule.priorWallets ? ` (from ${w.rule.priorWallets} wallets)` : ' (fixed)'}, z {w.rule.z}, ≥ {w.rule.minTrips} copies, {w.rule.lagSlots} slots {w.rule.lagSource}. {w.eligible} of {w.universe} eligible; floor {fmtPctS(w.floorPct, { signed: true })}; rules tried before: {w.rulesTried}.
      </div>
      <div className="mt-1 text-krypt-muted">
        TOP {top?.wallets.length ?? 0} · RAND {rand?.wallets.length ?? 0} · LEAD {lead?.wallets.length ?? 0}
        {lead?.note ? ` — ${lead.note}` : ''}
        {top?.note ? ` — ${top.note}` : ''}
      </div>
    </div>
  );
}

export function PreregPanel() {
  const toast = useToast();
  const [st, setSt] = useState<PreregStatus | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let alive = true;
    const read = (): void =>
      void window.krypt.scout.preregStatus().then((r) => {
        if (alive && r.ok && r.data) setSt(r.data);
      });
    read();
    const id = setInterval(read, 5_000);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, []);

  const act = async (fn: () => Promise<{ ok: boolean; message: string; data?: PreregStatus }>): Promise<void> => {
    setBusy(true);
    try {
      const r = await fn();
      if (!r.ok) return void toast.error(r.message);
      if (r.data) setSt(r.data);
      if (r.message && r.message !== 'ok') toast.info(r.message);
    } finally {
      setBusy(false);
    }
  };

  if (!st) {
    return (
      <div className="mt-4 flex items-center gap-2 py-10 text-note text-krypt-muted">
        <Loader2 className="h-4 w-4 animate-spin" /> Reading the test…
      </div>
    );
  }
  const now = Date.now();
  const settledBy = new Map(st.settled.map((s) => [s.week, s]));
  const outcome = OUTCOME_LABEL[st.verdict.outcome];
  const WEEK = 7 * 86_400_000;
  const freezes = [...st.freezes].sort((a, b) => b.week - a.week);
  const settled = [...st.settled].sort((a, b) => b.week - a.week);
  const floor = st.freezes[0]?.floorPct ?? settled[0]?.floorPct ?? null;

  return (
    <div className="mt-4 space-y-4" data-testid="prereg-panel">
      <div className="rounded-xl border border-white/8 bg-card px-4 py-4 shadow-soft">
        <div className="flex flex-wrap items-center gap-3">
          <h2 className="text-[16px] font-semibold text-white">The pre-registered test</h2>
          <span data-testid="prereg-outcome">
            <Tag tone={outcome.tone}>{outcome.text}</Tag>
          </span>
          <span className="text-body text-krypt-muted">
            {st.verdict.weeks} of {st.verdict.wanted} weeks settled
          </span>
          <div className="ml-auto flex items-center gap-2">
            {st.running && st.phase === 'settling' ? (
              <button className={btn.secondary} onClick={() => void act(() => window.krypt.scout.preregCancel())} data-testid="prereg-cancel">
                <Square className="h-4 w-4" /> Stop
              </button>
            ) : (
              <button
                className={btn.secondary}
                disabled={busy || st.running}
                onClick={() => void act(() => window.krypt.scout.preregFreeze())}
                data-testid="prereg-freeze-now"
                title={`Freezes the rule and the arms for the week of ${fmtDate(st.nextWeek)} now. Due ${fmtWhen(st.nextDue)}; the clock does it on its own then.`}
              >
                <Lock className="h-4 w-4" /> Freeze now
              </button>
            )}
          </div>
        </div>
        <p className="mt-2 max-w-3xl text-body leading-relaxed text-krypt-muted">
          Every Sunday the board’s rule and its top {PREREG_ARM_N} are written down and hashed before the week begins, beside {PREREG_ARM_N} wallets drawn at random from the
          same eligible set and the top {PREREG_ARM_N} of pump.fun’s own leaderboard. When the week ends, every arm is replayed from the chain over exactly that week — a
          random {PREREG_MAX_TRIPS} of each wallet’s trips at {PREREG_SIZE_SOL} SOL, priced at {PREREG_LAGS.join(', ')} slots behind — and compared with the fee floor and with copying
          nobody. Nothing is re-ranked; a bad week is kept. Eight weeks decide it; a TOP upper bound under zero at week {PREREG_FUTILITY_WEEKS} stops it for futility.
        </p>
        <div className="mt-3 space-y-1 text-body text-krypt-muted" data-testid="prereg-verdict">
          {st.verdict.text.map((t, i) => (
            <p key={i} className={i === 0 ? 'text-white' : ''}>
              {t}
            </p>
          ))}
        </div>
        <div className="mt-3 flex flex-wrap gap-x-5 gap-y-1 text-body text-krypt-muted">
          <span>
            Next freeze: week of {fmtDate(st.nextWeek)}, due {fmtWhen(st.nextDue)}
            {now >= st.nextDue ? ' — overdue, the clock runs hourly' : ''}
          </span>
          <span title="The lag every copy is judged at: the session's median slot gap when live copies have measured one, else the nine-slot assumption.">
            Lag: {st.slotGap === null ? 'assumed 9 slots (no live copy has measured one)' : `${Math.round(st.slotGap)} slots, measured`}
          </span>
          <span className={st.chainOk ? '' : 'text-warn'}>{st.chainOk ? 'Chain pricing on' : 'No Helius key — nothing can settle'}</span>
          {st.running && st.phase === 'settling' && (
            <span className="text-white">
              <Loader2 className="mr-1 inline h-3.5 w-3.5 animate-spin" />
              Settling the week of {st.settlingWeek === null ? '' : fmtDate(st.settlingWeek)}: {st.done} of {st.total} wallets, {st.credits.toLocaleString()} credits
            </span>
          )}
          {st.running && st.phase === 'freezing' && (
            <span className="text-white">
              <Loader2 className="mr-1 inline h-3.5 w-3.5 animate-spin" />
              Freezing…
            </span>
          )}
          {!st.running && st.message && <span>{st.message}</span>}
        </div>
        <p className="mt-3 text-label text-krypt-muted">
          Not measured here: the PumpSwap arm (the chain read does not say which venue a trade used) and random buys matched on hold time (the record keeps no
          hold-matched control). Both are named in the research as separate pre-registrations.
        </p>
      </div>

      {settled.length > 0 && (
        <div className="overflow-hidden rounded-xl border border-white/8 bg-card shadow-soft" data-testid="prereg-settled">
          <div className="grid grid-cols-[88px_repeat(8,minmax(86px,1fr))] gap-3 border-b border-white/8 px-4 py-2 text-label text-krypt-muted">
            <span>Week</span>
            <span className="text-right" title="The board's picks: median per copy, mint-clustered 95 % interval, copies">TOP</span>
            <span className="text-right" title="Wallets drawn at random from the same eligible set">RAND</span>
            <span className="text-right" title="pump.fun's weekly leaderboard, top of it">LEAD</span>
            <span className="text-right" title="A copy that goes nowhere: fees alone. NONE (copying nobody) is 0 %.">FLOOR · NONE</span>
            <span className="text-right">TOP − RAND</span>
            <span className="text-right">TOP − LEAD</span>
            <span className="text-right" title="TOP re-priced at 0 slots behind the leader (co-located) against the judged lag">0 slot · judged</span>
            <span className="text-right" title="Rank decay: Spearman of last week's and the week before's TOP, in their frozen order, against what they made this week. ≥ 0.4 that holds two weeks out is a trait; zero by the second week is noise.">
              decay ρ
            </span>
          </div>
          {settled.map((s) => {
            const arm = (n: string): PreregArmResult | undefined => s.arms.find((a) => a.name === n);
            const top = arm('TOP');
            const zero = top?.byLag['0'];
            const judged = top?.byLag[String(s.lagSlots)];
            return (
              <div key={s.week} className="grid grid-cols-[88px_repeat(8,minmax(86px,1fr))] items-center gap-3 border-b border-white/[0.05] px-4 py-2 text-body last:border-b-0" data-testid="prereg-week">
                <span className="text-white" title={`Settled ${fmtAgo(s.settledAt)}${s.complete ? '' : ' — incomplete: ' + s.message}; ${s.credits.toLocaleString()} credits`}>
                  {fmtDate(s.week)}
                  {!s.complete && <span className="block text-label text-warn">incomplete</span>}
                </span>
                <ArmCell a={top} floorPct={s.floorPct} />
                <ArmCell a={arm('RAND')} floorPct={s.floorPct} />
                <ArmCell a={arm('LEAD')} floorPct={s.floorPct} />
                <span className="text-right tabular-nums text-krypt-muted">
                  {fmtPctS(s.floorPct, { signed: true })}
                  <span className="block text-label">0.0%</span>
                </span>
                <DiffCell d={s.diffs.vsRand} />
                <DiffCell d={s.diffs.vsLead} />
                <span className="text-right tabular-nums text-white">
                  {zero && zero.copies ? fmtPctS(zero.medianPct, { signed: true }) : DASH}
                  <span className="block text-label text-krypt-muted">{judged && judged.copies ? `${fmtPctS(judged.medianPct, { signed: true })} at ${s.lagSlots}` : DASH}</span>
                </span>
                <span className="text-right tabular-nums text-white">
                  {s.decay.prev1 ? s.decay.prev1.rho.toFixed(2) : DASH}
                  <span className="block text-label text-krypt-muted">{s.decay.prev2 ? `${s.decay.prev2.rho.toFixed(2)} two weeks out` : s.tracks.prev1 ? 'one week out' : ''}</span>
                </span>
              </div>
            );
          })}
        </div>
      )}

      <div className="space-y-2" data-testid="prereg-freezes">
        {freezes.length === 0 ? (
          <p className="text-body text-krypt-muted">No week is frozen yet. The first freeze is written at the next tick of the clock, or now with the button above.</p>
        ) : (
          freezes.map((w) => (
            <FreezeCard
              key={w.week}
              w={w}
              settled={settledBy.get(w.week)}
              bad={st.badHash.includes(w.week)}
              canSettle={now >= w.week + WEEK && !settledBy.has(w.week)}
              busy={busy || st.running}
              onSettle={() => void act(() => window.krypt.scout.preregSettle(w.week))}
            />
          ))
        )}
      </div>
      {floor !== null && (
        <p className="text-label text-krypt-muted">
          The floor is {fmtPctS(floor, { signed: true })} at {PREREG_SIZE_SOL} SOL: what a copy returns when the price never moves. Every figure above the floor but under
          zero is still a loss; only a lower bound above zero passes.
        </p>
      )}
    </div>
  );
}
