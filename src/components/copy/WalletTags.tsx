// A wallet's flags as plain-language badges (2026-10-22): the same words on
// the leaderboard, the compare sheet and the profile.

import { BOT_TRADES_PER_MIN, HARD_EXCLUSION_TEXT, MIN_TRIPS_FOR_RANK, SCOUT_WARNING_TEXT, hardExclusions, type ScoutRow } from '@shared/walletScout';
import type { WalletFlag } from '@shared/walletScore';
import { Tag } from '../../ui/kit';

export const FLAG_LABEL: Record<WalletFlag, { label: string; tone: 'warn' | 'neutral'; why: string }> = {
  bot: { label: 'Bot', tone: 'warn', why: `Holds for seconds and trades constantly, or made ${BOT_TRADES_PER_MIN}+ trades inside one minute. A bot wins on speed you do not have.` },
  thin: { label: 'Few trades', tone: 'neutral', why: `Fewer than ${MIN_TRIPS_FOR_RANK} finished trades in this window — luck, not a record.` },
  unreachable: { label: 'Too fast to copy', tone: 'warn', why: 'Under a quarter of their trades could be copied at all: they were out before a copy could land.' },
  concentrated: { label: 'Same few coins', tone: 'neutral', why: 'Most trades are on the same few coins — a relationship with those coins, not a knack for the next one.' },
  partial: { label: 'Partly measured', tone: 'neutral', why: 'The copy figures cover under half of their trades in this window.' },
};

/**
 * The row's hard exclusions from the chain check (2026-10-25 — launch
 * bundle, sniper, wash trades, shared payer; the creator is already a
 * warning) first, then its warnings (2026-10-23 — creates coins, mayhem
 * coins, large size), since they are the measured "who not to copy", then
 * its flags. `max` counts all three. Each carries its rule and evidence in
 * the tooltip (HARD_EXCLUSION_TEXT and SCOUT_WARNING_TEXT, pinned by
 * test/walletscout.test.mjs).
 */
export function RowTags({ r, max = 3 }: { r: ScoutRow; max?: number }) {
  const warnings = r.warnings ?? [];
  const excluded = hardExclusions(r).filter((x) => x !== 'creator');
  const shown = excluded.length + warnings.length;
  return (
    <>
      {excluded.slice(0, max).map((x) => (
        <Tag key={x} tone="down" title={HARD_EXCLUSION_TEXT[x].why}>
          {HARD_EXCLUSION_TEXT[x].label}
        </Tag>
      ))}
      {warnings.slice(0, Math.max(0, max - excluded.length)).map((w) => (
        <Tag key={w} tone="warn" title={SCOUT_WARNING_TEXT[w].why}>
          {SCOUT_WARNING_TEXT[w].label}
        </Tag>
      ))}
      {r.flags.slice(0, Math.max(0, max - shown)).map((f) => (
        <Tag key={f} tone={FLAG_LABEL[f].tone} title={FLAG_LABEL[f].why}>
          {FLAG_LABEL[f].label}
        </Tag>
      ))}
    </>
  );
}
