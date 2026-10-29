// The live feed's loss, where the record it feeds is read (2026-10-25).
//
// The engine measures what share of the market's events the feed pool
// missed over the last 15 minutes (continuity, `status.feedLossPct`) and
// logs a warning above FEED_LOSS_WARN_PCT. Until now that number lived at
// the bottom of Settings → Solana RPC, while the pages built on the feed —
// the board, a wallet's profile — said nothing. A wallet the feed saw 12
// trades of over a week the chain read 508 for; the user met the two
// figures side by side and asked why. This line stands beside the record
// while the loss is live, and says which figures it reaches.

import { useAppState } from '../../state/AppStateProvider';
import { cls } from '../../utils/format';

/** The engine warns above this share; the pages say so at the same line. */
export const FEED_LOSS_WARN_PCT = 5;

export function FeedLossNote({ className = 'mt-3', where = 'these records' }: { className?: string; where?: string }) {
  const { status } = useAppState();
  const pct = status.feedLossPct;
  if (!status.running || pct === null || pct <= FEED_LOSS_WARN_PCT) return null;
  return (
    <div className={cls('rounded-lg border border-warn/30 bg-warn/[0.08] px-4 py-2.5 text-body leading-relaxed text-white', className)} data-testid="feed-loss-note">
      <span className="font-semibold">The live feed is dropping about {Math.round(pct)}% of the market&rsquo;s events right now.</span>{' '}
      <span className="text-krypt-muted">
        A trade it misses never reaches {where}, so the live-feed figures run thin and lean toward the coins that survived. Reads from the chain
        and the copy replay see every trade and are not affected.
      </span>
    </div>
  );
}
