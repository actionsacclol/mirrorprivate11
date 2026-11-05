import { useEffect, useState } from 'react';
import type { AppSettings } from '@shared/types';
import { REARM_LIMITS, readRearm, rearmClock, type RearmPending, type RearmSettings } from '@shared/rearm';
import { Card, GhostButton, NumberInput, Section, Switch } from './common';

/**
 * What stops live trading, and what comes back by itself. Each switch answers
 * one question: when this happens, does it come back on, or stay off until the
 * user turns it back on? Settings › Auto re-arm.
 */
export function RearmSection({
  settings,
  updateSettings,
}: {
  settings: AppSettings;
  updateSettings: (patch: Partial<AppSettings>) => Promise<unknown> | void;
}) {
  const r = readRearm(settings.execution.rearm);
  const set = (patch: Partial<RearmSettings>) => void updateSettings({ execution: { ...settings.execution, rearm: { ...r, ...patch } } });

  const [pending, setPending] = useState<RearmPending[]>([]);
  useEffect(() => {
    let live = true;
    const read = () => void window.krypt.rearm.pending().then((p) => { if (live) setPending(p); }).catch(() => undefined);
    read();
    const t = setInterval(read, 5_000);
    return () => {
      live = false;
      clearInterval(t);
    };
  }, []);
  const keepOff = (p: RearmPending) =>
    void window.krypt.rearm.cancel(p.kind, p.id).then(() => setPending((list) => list.filter((x) => x !== p)));

  const limit = settings.execution.maxLiveSessionLossSol;
  const lossWarning =
    r.maxInARow === 0
      ? 'Each comeback starts the loss count again, and with no limit on comebacks there is no ceiling on what this can lose.'
      : limit > 0
        ? `Each comeback starts the loss count again, so with your ${limit} SOL limit and ${r.maxInARow} comebacks this can lose about ${Math.round(limit * (r.maxInARow + 1) * 1000) / 1000} SOL or more before it stays off.`
        : `Each comeback starts the loss count again, so this can lose your limit about ${r.maxInARow + 1} times before it stays off.`;

  return (
    <Section
      title="Auto re-arm"
      description="When something stops live trading, does it come back on by itself or stay off until you turn it back on? A pause, a loss limit or an upgrade never stops selling. Your own switch to Paper, the kill switch and locking do stop automatic exits."
    >
      <Card className="space-y-4">
        <div data-testid="rearm-section" className="space-y-3">
          <Switch
            checked={r.failedTrades}
            onChange={(v) => set({ failedTrades: v })}
            label="Failed trades"
            description={`After ${r.failsInARow} failed copies in a row, a follow pauses, then comes back on by itself. The wait starts at ${r.firstWaitMin} minutes and doubles up to an hour.`}
          />
          <Switch
            checked={r.slippagePauses}
            onChange={(v) => set({ slippagePauses: v })}
            label="Slippage failures can pause a follow"
            description="Off: a copy that fails because the price moved past your slippage is recorded, and copying carries on. On: it counts as a failed trade. Each failure that reaches the chain can still cost a network fee."
          />
          <Switch
            checked={settings.execution.rearmAfterVerifiedUpgrade !== false}
            onChange={(v) => void updateSettings({ execution: { ...settings.execution, rearmAfterVerifiedUpgrade: v } })}
            label="pump.fun upgrades"
            description="When pump.fun upgrades its program, live switches off while the app re-checks it against real launches, usually within seconds. It comes back on if that check passes, and never if it fails. The app only watches for upgrades while the Solana scanner is on (the record switch on Discover), which is off by default."
          />
          <Switch
            checked={r.lossLimits}
            onChange={(v) => set({ lossLimits: v })}
            label="Live loss limits"
            description={`The session loss limit and the losing streak. Off is the safe setting: live stays off until you turn it back on. On: it comes back after an hour. ${lossWarning}`}
          />
          <Switch
            checked={r.followStops}
            onChange={(v) => set({ followStops: v })}
            label="A follow's own loss stop"
            description={`Only for a follow with a loss stop. A new follow has none unless you set one. Off is the safe setting: the follow stays off until you switch it on. On: it comes back after an hour with the count at zero, so it can lose its stop again, about ${r.maxInARow === 0 ? 'any number of' : r.maxInARow + 1} times. A follow's daily loss limit, if you set one, lifts by itself the next day.`}
          />
          <Switch
            checked={r.restart}
            onChange={(v) => set({ restart: v })}
            label="App restarts"
            description="Live follows switch off when the app closes. On: the ones that were running come back on when the app opens, however long it was closed. With a wallet password, not until you unlock. BNB and Robinhood always open in Paper, so their follows wait until you switch that chain to Live."
          />
        </div>

        <div className="grid gap-3 sm:grid-cols-3">
          <label className="block text-body">
            <span className="mb-1 block text-krypt-muted">Failures before a pause</span>
            <NumberInput
              value={r.failsInARow}
              min={REARM_LIMITS.failsInARow.min}
              max={REARM_LIMITS.failsInARow.max}
              onChange={(v) => {
                if (Number.isInteger(v) && v >= REARM_LIMITS.failsInARow.min && v <= REARM_LIMITS.failsInARow.max) set({ failsInARow: v });
              }}
            />
          </label>
          <label className="block text-body">
            <span className="mb-1 block text-krypt-muted">First wait</span>
            <NumberInput
              value={r.firstWaitMin}
              min={REARM_LIMITS.firstWaitMin.min}
              max={REARM_LIMITS.firstWaitMin.max}
              suffix="min"
              onChange={(v) => {
                if (Number.isInteger(v) && v >= REARM_LIMITS.firstWaitMin.min && v <= REARM_LIMITS.firstWaitMin.max) set({ firstWaitMin: v });
              }}
            />
          </label>
          <label className="block text-body">
            <span className="mb-1 block text-krypt-muted">Comebacks in a row (0 = no limit)</span>
            <NumberInput
              value={r.maxInARow}
              min={REARM_LIMITS.maxInARow.min}
              max={REARM_LIMITS.maxInARow.max}
              onChange={(v) => {
                if (Number.isInteger(v) && v >= REARM_LIMITS.maxInARow.min && v <= REARM_LIMITS.maxInARow.max) set({ maxInARow: v });
              }}
            />
          </label>
        </div>
        <p className="text-body text-krypt-muted">
          A copy that lands starts the failed-trades count again. A failed sell keeps trying by itself until it sells, unless you switch to Paper, press the kill switch or lock your wallets.{' '}
          {r.maxInARow === 0
            ? 'Failed sends can cost network fees, and with no limit set a route that stays broken keeps retrying.'
            : `Failed sends can cost network fees, so a route that stays broken stops after ${r.maxInARow} comebacks.`}{' '}
          The default is 0, no limit.
        </p>
        <p className="text-body text-krypt-muted" data-testid="rearm-always">
          These always stay off until you turn them back on: your own switch to Paper, the kill switch, locking your wallets, a debugger
          attaching and, while the Solana scanner is on, pump.fun's data format changing. Choosing Paper or locking also cancels any follow
          that was waiting to come back. Closing the app ends a wait for Live, and for follows too unless App restarts is on.
        </p>

        {pending.length > 0 && (
          <div className="space-y-2 border-t border-white/10 pt-3" data-testid="rearm-pending">
            <div className="text-body font-medium">Waiting to come back on</div>
            {pending.map((p) => (
              <div key={`${p.kind}:${p.id}`} className="flex flex-wrap items-center justify-between gap-2 text-body">
                <span>
                  <span className="font-medium">{p.name}</span> {p.at <= Date.now() ? 'as soon as Live is on' : `at ${rearmClock(p.at)}`}
                  <span className="text-krypt-muted"> · {p.why}</span>
                </span>
                <GhostButton onClick={() => keepOff(p)}>Keep it off</GhostButton>
              </div>
            ))}
          </div>
        )}
      </Card>
    </Section>
  );
}
