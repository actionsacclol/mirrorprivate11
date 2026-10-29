// Finding a wallet by its pump.fun username (2026-10-23).
//
// pump.fun's public `GET /users/{id}` (shared/pumpProfile.ts, "Does this
// address already have an account?") answers for a USERNAME as well as an
// address — measured 2026-10-23 through the app's own transport. It is also
// a catch-all: `/users/search` is not a search route but the profile of a
// user called "search". So an answer is believed only when it is the profile
// asked for — the same username (case-insensitive) or the same wallet — and
// anything else is "no such user".
//
// The wallet is the one the account signs in with. Someone can trade from
// other wallets too; the page says it is copying THIS one.

/** What the user typed, understood. */
export type PumpHandle = { kind: 'address'; value: string } | { kind: 'username'; value: string };

const BASE58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
/** pump.fun usernames seen: letters, digits, underscores ("The__Solstice"),
 *  the odd dot or dash. Generous on purpose — pump is the judge — but never
 *  only dots: `..` would make the read `/users/..`, a different route. */
const USERNAME = /^(?=.*[A-Za-z0-9])[A-Za-z0-9_.-]{1,32}$/;

/**
 * A wallet address, `@name`, `name`, or a pump.fun profile link
 * (`https://pump.fun/profile/<name or wallet>`, scheme optional). Null for
 * anything else. A base58 string of wallet length is always an address:
 * pump's usernames are at most 15 characters, and an address read as a name
 * would look up the wrong thing.
 */
export function parsePumpHandle(input: string): PumpHandle | null {
  let s = String(input ?? '').trim();
  if (!s) return null;
  const link = /^(?:https?:\/\/)?(?:www\.)?pump\.fun\/profile\/([^/?#\s]+)/i.exec(s);
  if (link) {
    try {
      s = decodeURIComponent(link[1]);
    } catch {
      return null;
    }
  } else if (/[/\s]/.test(s)) return null;
  if (s.startsWith('@')) s = s.slice(1);
  if (BASE58.test(s)) return { kind: 'address', value: s };
  if (USERNAME.test(s)) return { kind: 'username', value: s };
  return null;
}

export interface PumpUser {
  username: string;
  /** The Solana wallet the account signs in with. */
  wallet: string;
  followers: number | null;
  xUsername: string | null;
  verified: boolean;
  banned: boolean;
  /** False: a record pump made for an address nobody signed in to. */
  isPumpUser: boolean;
}

const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null);

/** pump's answer, believed only when it is the profile asked for. Null when
 *  it is someone else (the catch-all above), or has no name or wallet. */
export function pumpUserFrom(raw: unknown, asked: PumpHandle): PumpUser | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  const username = str(o.username);
  const address = str(o.address);
  const wallet = str(o.canonical_svm_wallet) ?? address;
  if (!username || !wallet || !BASE58.test(wallet)) return null;
  if (asked.kind === 'username' && username.toLowerCase() !== asked.value.toLowerCase()) return null;
  if (asked.kind === 'address' && wallet !== asked.value && address !== asked.value) return null;
  return {
    username,
    wallet,
    followers: typeof o.followers === 'number' && Number.isFinite(o.followers) ? o.followers : null,
    xUsername: str(o.x_username),
    verified: o.is_verified === true || o.isVerified === true,
    banned: o.is_banned === true,
    isPumpUser: o.is_pump_user !== false,
  };
}

/** The path a handle is read at. */
export function pumpUserPath(h: PumpHandle): string {
  return `/users/${encodeURIComponent(h.value)}`;
}

// ─── pump.fun's PnL leaderboard (2026-10-25) ─────────────────────────────
//
// `GET /pnl-leaderboard?period=daily|weekly|monthly` — public, measured
// 2026-10-25 through the app's Chromium transport (Node's fetch gets
// Cloudflare's challenge): the top 100 wallets of the last 24 h / 7 d / 30 d
// by THEIR OWN profit, each with its username, SOL spent, positions and top
// coins. 100 is all there is (`limit`/`offset` are ignored); any other period
// is a 400. It ranks what they made, not what a copier would have — the
// weekly #1 that day was +362,824 % on one coin — so the app shows it next
// to a replay of copying them, never as a score.

export type PumpLeaderPeriod = 'daily' | 'weekly' | 'monthly';
export const PUMP_LEADER_PERIODS: readonly PumpLeaderPeriod[] = ['daily', 'weekly', 'monthly'];

export interface PumpLeader {
  rank: number;
  wallet: string;
  username: string | null;
  /** Their own result over the period, SOL and % of what they spent. */
  pnlSol: number;
  pnlPct: number | null;
  spentSol: number | null;
  realizedSol: number | null;
  unrealizedSol: number | null;
  positions: number | null;
  topCoins: Array<{ mint: string; symbol: string | null }>;
  verified: boolean;
  xUsername: string | null;
}

export interface PumpLeaderboard {
  period: PumpLeaderPeriod;
  /** pump's own label ("24h", "7d", "30d") and the window's start, ms. */
  label: string;
  windowStart: number | null;
  entries: PumpLeader[];
  fetchedAt: number;
}

export function pumpLeaderboardPath(period: PumpLeaderPeriod): string {
  return `/pnl-leaderboard?period=${period}`;
}

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/** The board as pump sent it, kept only where it is well formed: a row
 *  without a valid wallet or a numeric PnL is dropped, never guessed. */
export function pumpLeaderboardFrom(raw: unknown, period: PumpLeaderPeriod, now = Date.now()): PumpLeaderboard | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  if (!Array.isArray(o.entries)) return null;
  const seen = new Set<string>();
  const entries: PumpLeader[] = [];
  for (const e of o.entries as unknown[]) {
    if (!e || typeof e !== 'object') continue;
    const r = e as Record<string, unknown>;
    const wallet = str(r.walletAddress);
    const pnlSol = num(r.pnlSol);
    if (!wallet || !BASE58.test(wallet) || pnlSol === null || seen.has(wallet)) continue;
    seen.add(wallet);
    const top = Array.isArray(r.topPositions) ? (r.topPositions as unknown[]) : [];
    entries.push({
      rank: num(r.rank) ?? entries.length + 1,
      wallet,
      username: str(r.username),
      pnlSol,
      pnlPct: num(r.pnlPercent),
      spentSol: num(r.buySpendSol),
      realizedSol: num(r.realizedPnlSol),
      unrealizedSol: num(r.unrealizedPnlSol),
      positions: num(r.positionsCount),
      topCoins: top
        .map((p) => (p && typeof p === 'object' ? (p as Record<string, unknown>) : null))
        .filter((p): p is Record<string, unknown> => !!p && !!str(p.mint) && BASE58.test(str(p.mint) as string))
        .slice(0, 3)
        .map((p) => ({ mint: str(p.mint) as string, symbol: str(p.symbol) })),
      verified: r.isVerified === true,
      xUsername: str(r.xUsername),
    });
  }
  entries.sort((a, b) => a.rank - b.rank);
  const ws = num(o.windowStartSec);
  return { period, label: str(o.periodLabel) ?? period, windowStart: ws === null ? null : ws * 1000, entries, fetchedAt: now };
}

/** What the board's own figures say to be wary of, in words. */
export function pumpLeaderCautions(e: PumpLeader): string[] {
  const out: string[] = [];
  if (e.positions !== null && e.positions <= 1) out.push('one coin');
  if (e.pnlPct !== null && e.pnlPct >= 10_000) out.push('one huge win');
  // Measured 2026-10-25: on the daily board the median wallet's profit was
  // entirely unsold, so "mostly unsold" would tag nearly every row. Flagged
  // here only when nothing has been sold at a profit at all; the board-wide
  // share is stated once (pumpUnsoldShare).
  if (e.pnlSol > 0 && e.realizedSol !== null && e.realizedSol <= 0) out.push('nothing sold');
  return out;
}

/** How many of the board's wallets have most of their profit still unsold. */
export function pumpUnsoldCount(entries: readonly PumpLeader[]): number {
  return entries.filter((e) => e.pnlSol > 0 && e.unrealizedSol !== null && e.unrealizedSol / e.pnlSol >= 0.5).length;
}
