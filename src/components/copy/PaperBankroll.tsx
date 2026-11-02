// The paper bankroll (2026-11-01): Settings' switch and amount, and the
// balance chip the top bar shows while trading on Paper. The engine keeps
// the balance (electron/engine/copyTrade.ts); this only shows and sets it.

import { useEffect, useState } from 'react';
import type { PaperBankrollView } from '@shared/copytrade';
import { PAPER_BANKROLL_DEFAULT_USD, PAPER_BANKROLL_MAX_USD, PAPER_BANKROLL_MIN_USD } from '@shared/copytrade';
import { Card, GhostButton, NumberInput, Section, Switch } from '../common';
import { useCopySnapshot } from '../../state/useCopy';
import { useSolUsd } from '../../state/useSolUsd';
import { useToast } from '../../state/ToastProvider';
import { cls } from '../../utils/format';

const usdFmt = (v: number): string => `$${v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const solFmt = (v: number): string => `${v.toFixed(3)} SOL`;
const signed = (v: number): string => `${v >= 0 ? '+' : '−'}${Math.abs(v).toFixed(3)} SOL`;

export function PaperBankrollSection() {
  const { snap, set } = useCopySnapshot();
  const toast = useToast();
  const solUsd = useSolUsd();
  const pb: PaperBankrollView | null = snap?.paperBankroll ?? null;
  const [usd, setUsd] = useState<number>(pb?.usd ?? PAPER_BANKROLL_DEFAULT_USD);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (pb) setUsd(pb.usd);
  }, [pb?.usd]);

  const send = async (input: { enabled?: boolean; usd?: number; restart?: boolean }): Promise<void> => {
    setBusy(true);
    const r = await window.krypt.copy.paperBankroll(input);
    setBusy(false);
    if (!r.ok) return void toast.error(r.message);
    if (r.data) set(r.data);
    toast.success(r.message);
  };

  const on = pb?.enabled === true;
  const badAmount = !(usd >= PAPER_BANKROLL_MIN_USD && usd <= PAPER_BANKROLL_MAX_USD);
  const changed = pb !== null && usd !== pb.usd;

  return (
    <Section
      title="Paper bankroll"
      description="Give paper a wallet to spend from. Paper copies then draw from a fixed amount, sells pay it back with their result, and a copy the balance cannot cover is skipped — as a live one is when the wallet runs short."
    >
      <Card className="space-y-3" >
        <div data-testid="paper-bankroll">
          <Switch
            checked={on}
            disabled={busy || pb === null}
            onChange={(v) => void send(v ? { enabled: true, usd } : { enabled: false })}
            label="Paper trades from a set balance"
            description="Solana paper copies only; live copies spend the real wallet, and Robinhood and BNB paper copies are unaffected. The dollars become SOL at the price when the run starts, so the balance's dollar value moves with SOL, like a real wallet's."
          />
        </div>
        <div className="flex flex-wrap items-end gap-3">
          <div>
            <div className="mb-1.5 text-xs font-semibold uppercase tracking-wider text-krypt-muted">Starting balance</div>
            <NumberInput
              value={usd}
              onChange={setUsd}
              suffix="USD"
              className="w-44"
              warn={(n) => (n < PAPER_BANKROLL_MIN_USD ? `At least $${PAPER_BANKROLL_MIN_USD}` : n > PAPER_BANKROLL_MAX_USD ? 'Too large' : null)}
            />
          </div>
          {on && (
            <GhostButton onClick={() => void send({ enabled: true, usd, restart: true })} disabled={busy || badAmount}>
              {changed ? `Start over with ${usdFmt(usd)}` : 'Start over'}
            </GhostButton>
          )}
          {!on && <span className="pb-2 text-body text-krypt-muted/70">Switch it on to start with this amount.</span>}
        </div>
        {on && pb && pb.cashSol !== null && pb.startSol !== null && (
          <div className="space-y-1 rounded-lg border border-white/10 bg-black/20 p-3 font-mono text-body" data-testid="paper-bankroll-state">
            <Row label="Balance" value={`${solFmt(pb.cashSol)}${solUsd ? ` ≈ ${usdFmt(pb.cashSol * solUsd)}` : ''}`} tone={pb.cashSol < 0.0005 ? 'text-warn' : 'text-white'} />
            <Row label="In open copies" value={pb.openCopies > 0 ? `${solFmt(pb.heldSol)} in ${pb.openCopies} cop${pb.openCopies === 1 ? 'y' : 'ies'}, at cost` : 'none'} />
            <Row label="Realised so far" value={signed(pb.realizedSol)} tone={pb.realizedSol > 0 ? 'text-up' : pb.realizedSol < 0 ? 'text-down' : 'text-white'} />
            <Row
              label="Started"
              value={`${pb.startedAt ? new Date(pb.startedAt).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : '—'} with ${usdFmt(pb.usd)} = ${solFmt(pb.startSol)}${pb.startSolUsd ? ` (SOL at ${usdFmt(pb.startSolUsd)})` : ''}`}
            />
          </div>
        )}
        {on && changed && <p className="text-body text-warn">The new amount applies when you start over.</p>}
      </Card>
    </Section>
  );
}

function Row({ label, value, tone }: { label: string; value: string; tone?: string }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <span className="text-krypt-muted">{label}</span>
      <span className={cls('text-right tabular-nums', tone ?? 'text-white/85')}>{value}</span>
    </div>
  );
}

/** The top bar's paper balance, while Solana trades on Paper with the bankroll on. */
export function PaperBalanceChip({ onOpen }: { onOpen: () => void }) {
  const { snap } = useCopySnapshot();
  const solUsd = useSolUsd();
  const pb = snap?.paperBankroll;
  if (!pb?.enabled || pb.cashSol === null) return null;
  const cash = pb.cashSol;
  const text = solUsd ? usdFmt(cash * solUsd) : solFmt(cash);
  return (
    <button
      onClick={onOpen}
      className={cls(
        'flex h-9 items-center gap-1.5 whitespace-nowrap rounded-lg px-2.5 text-body font-semibold tabular-nums transition hover:bg-white/5',
        cash < 0.0005 ? 'text-warn' : 'text-white',
      )}
      title={`Paper balance: ${solFmt(cash)}${pb.openCopies > 0 ? `, plus ${solFmt(pb.heldSol)} in ${pb.openCopies} open paper cop${pb.openCopies === 1 ? 'y' : 'ies'}` : ''}. Set in Settings › Paper bankroll.`}
      data-testid="nav-paper-balance"
    >
      <span className="rounded bg-white/10 px-1.5 py-0.5 text-label font-medium text-krypt-muted">Paper</span>
      {text}
    </button>
  );
}
