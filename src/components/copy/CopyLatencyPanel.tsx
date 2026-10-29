// The copy-speed panel on Following (split out of ConfigEditor.tsx on
// 2026-10-24, when the full config editor became the Follow page).

import type { CopyLatency } from '@shared/copytrade';
import { Card, Section } from '../common';
import { cls } from '../../utils/format';

function Tot({ label, value, tone }: { label: string; value: string; tone?: 'good' | 'bad' }) {
  return (
    <div>
      <div className="text-label uppercase tracking-wide text-krypt-muted">{label}</div>
      <div className={cls('font-mono text-note', tone === 'good' ? 'text-emerald-300' : tone === 'bad' ? 'text-rose-300' : 'text-white')}>{value}</div>
    </div>
  );
}

/**
 * Where the time goes between a leader's fill and ours.
 *
 * A tester timed ~5–6 s from outside and could not tell which half was
 * which (2026-09-21). Every stage is a median over this session's copies,
 * and a stage nothing measured shows an em dash rather than a zero — "did
 * not happen" and "took no time" are different facts.
 */
export function CopyLatencyPanel({ l }: { l: CopyLatency }) {
  const ms = (n: number | null): string =>
    n === null ? '—' : n >= 1000 ? `${(n / 1000).toFixed(2)}s` : `${Math.round(n)}ms`;
  // The delivery half is the chain, the RPC and the transport; the rest is
  // this app. Splitting them is the whole question.
  const heard = (l.detectMs ?? 0) + (l.readMs ?? 0) + (l.decodeMs ?? 0);
  const ours = (l.checkMs ?? 0) + (l.delayMs ?? 0) + (l.sendMs ?? 0);
  const mixed = [l.feeds.logs, l.feeds.tx, l.feeds.parsed].filter((n) => n > 0).length > 1;
  return (
    <Section
      title="Where a copy's time goes"
      description="Median across this session's copies, paper and live. Measured from the leader's own block time, so it is the same stopwatch you would hold watching two wallets side by side."
    >
      <Card>
        <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-7 gap-3">
          <Tot label="Their fill → ours" value={ms(l.totalMs)} />
          <Tot label="Heard about it" value={ms(l.detectMs)} />
          <Tot label="Read the tx" value={ms(l.readMs)} />
          <Tot label="Decode" value={ms(l.decodeMs)} />
          <Tot label="Checks" value={ms(l.checkMs)} />
          <Tot label="Your delay" value={ms(l.delayMs)} />
          <Tot label="Our order" value={ms(l.sendMs)} />
        </div>
        {/* Slots, from the chain's own record of both transactions — not
            rounded to a second like block times are. Live only. */}
        <div className="mt-3 text-body text-krypt-muted">
          Landed after the leader:{' '}
          {l.slotGap === null ? (
            <span className="text-white">—</span>
          ) : (
            <>
              <span className="text-white font-mono">
                {l.slotGap} slot{l.slotGap === 1 ? '' : 's'}
              </span>{' '}
              median over {l.slotSamples} live cop{l.slotSamples === 1 ? 'y' : 'ies'} (0 = the same block)
            </>
          )}
          {l.slotGap === null && ' — measured on live copies, once each buy has been read back from the chain.'}
        </div>
        <p className="mt-3 text-body leading-relaxed text-krypt-muted">
          {l.samples < 5 ? (
            <>
              <span className="text-arc-gold">{l.samples} copy{l.samples === 1 ? '' : ' copies'} so far</span> — too few
              to read as a measurement yet.{' '}
            </>
          ) : (
            <>Over {l.samples} copies. </>
          )}
          {heard > 0 && ours > 0 && (
            <>
              Roughly <span className="text-white">{ms(heard)}</span> of it is hearing about the trade and{' '}
              <span className="text-white">{ms(ours)}</span> is placing yours.{' '}
            </>
          )}
          {l.factsMs !== null && l.checkMs !== null && l.factsMs > l.checkMs / 2 && (
            <>
              Most of the checks is one token lookup ({ms(l.factsMs)}), which is a network call on a mint nothing has
              seen before.{' '}
            </>
          )}
          {mixed ? (
            <>
              Mixed transports this session ({l.feeds.logs} by signature, {l.feeds.tx} delivered whole,{' '}
              {l.feeds.parsed} by Parsed Streams).
            </>
          ) : l.feeds.parsed > 0 ? (
            <>
              Heard through Helius Parsed Streams, about 120 ms before a signature would arrive. A plain pump buy is
              decoded from the push with no read-back; sells and routed trades are still read back, because the push
              does not say how much of their bag the leader sold.
            </>
          ) : l.feeds.tx > 0 ? (
            <>Delivered whole by transactionSubscribe — no read-back at all.</>
          ) : l.feeds.logs > 0 ? (
            <>
              Delivered as a signature, so every trade costs a read-back — the &ldquo;read the tx&rdquo; column above. A
              Helius key on a plan that serves transactionSubscribe removes that stage entirely, because the
              transaction arrives with the notification.
            </>
          ) : null}
        </p>
      </Card>
    </Section>
  );
}

