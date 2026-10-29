// The Scout board's sort keys, on their own (2026-10-28) so that
// shared/copytrade.ts can name one — a convergence follow's crowd can be
// "the top N by Week total" — without importing shared/walletScout.ts, which
// imports copytrade.ts for the paper cost model. walletScout.ts re-exports
// these, so every existing import still works.

export type ScoutSort = 'fLowerPct' | 'fShrunkPct' | 'copyScore' | 'pnl' | 'returnPct' | 'winRatePct' | 'roundTrips' | 'volume' | 'fMedianReturnPct' | 'fSumPct' | 'fTrimmedMeanPct';

export const SCOUT_SORT_LABEL: Record<ScoutSort, string> = {
  fLowerPct: 'Least bad to copy',
  fShrunkPct: 'Shrunk median',
  copyScore: 'Copy score',
  fMedianReturnPct: 'Follower return',
  fSumPct: 'Week total, copied',
  fTrimmedMeanPct: 'Mean without best 5',
  pnl: 'Their profit',
  returnPct: 'Their return',
  winRatePct: 'Their win rate',
  roundTrips: 'Round trips',
  volume: 'Volume',
};
export const SCOUT_SORTS: ScoutSort[] = ['fLowerPct', 'fShrunkPct', 'copyScore', 'fMedianReturnPct', 'fSumPct', 'fTrimmedMeanPct', 'pnl', 'returnPct', 'winRatePct', 'roundTrips', 'volume'];
/** The ranking the board, the picks and the suggestions all use. */
export const SCOUT_RANK_SORT: ScoutSort = 'fLowerPct';
