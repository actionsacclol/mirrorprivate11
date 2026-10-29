// $KRYPTO — Krypt's own token, shown on the Hub.
//
// The mint is pinned HERE, in the bundle, never fetched: the Hub's buy button
// points wherever this says, and a buy target that arrived over the network
// (the update manifest is TLS-only and unsigned) would be one CDN or DNS
// swap away from sending every user to a look-alike. Pinned in code it is
// covered by the same tamper layers as the treasury address.
//
// While `mint` is null the card does not render at all, so the build can
// ship before the launch and the launch can slip without a stale link.
//
// Honesty rules for the card, because this is the one place the app shows a
// token its maker has a stake in: it says who issued it, that showing it is
// not a recommendation, and what the issuer earns from it. Its numbers come
// from the same market summary every other token gets — nothing is scored
// or ranked differently for being ours, and the Wallet Scout already keeps
// the user's own wallets (the launch wallet included) off its board.

/** Solana mint, 32–44 base58 characters. */
const MINT_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

export interface KryptoToken {
  /** Null until the token exists. Set once, from the launch, then shipped. */
  mint: string | null;
  symbol: string;
  name: string;
  chain: 'solana';
}

/**
 * Verified 2026-09-12 against pump.fun's coin record and the chain before it
 * was pinned: name "Krypto Bot", ticker KRYPTO, created 2026-09-12 09:38:39
 * UTC by Ff4Mw51MqPt6wgcY1TsLFdHp94Cqx9Bris9EapMyvNkm; a Token-2022 mint,
 * 6 decimals, 1,000,000,000 supply, mint authority revoked; bonding curve
 * B51N7SrnxnwX36nuLJRdyAXdohAudABXu8Q7DhTdoxC4.
 */
export const KRYPTO_TOKEN: KryptoToken = {
  mint: '2qEubd7GwtZbCqDu1uQwNC4kNaJLBdRUcWKpckTypump',
  symbol: 'KRYPTO',
  name: 'Krypto Bot',
  chain: 'solana',
};

// ── The holder rate (2026-09-16 as a waiver; halved 2026-09-20) ───────
//
// Hold this much of $KRYPTO, across ANY wallet this install holds keys for,
// and Krypt's own 0.5 %/side becomes 0.25 %/side on your trades — and the
// referrer's share halves with it rather than vanishing, so a referral
// still pays. It was a full waiver for four days; a waived trade paid the
// referrer 20 % of nothing, which broke the referral programme for exactly
// the users most likely to be referred (Krypt's call, 2026-09-20).
// pump.fun's 1 % and the network's fees are not ours to discount and are
// untouched.
//
// Denominated in TOKENS, not dollars. A dollar threshold on a memecoin moves
// under the holder: the number of tokens it takes changes with every candle,
// and someone who qualified yesterday stops qualifying today without having
// sold anything. A token count is a promise that stays put, and the holder
// controls both sides of it.
//
// It also removes a way to be wrong. A dollar rule needs a PRICE, which is a
// second thing that can be unreadable — and an unreadable price means
// charging someone who does hold enough. With a token count the rate rests
// on one balance read and nothing else.
//
// 1,000,000 of a 1,000,000,000 supply: 0.1 %.
//
// It is checked across every wallet in the app, not the active signer alone:
// a user who keeps their bag in one wallet and trades from another is one
// user, and charging them because of how they organise their keys would be a
// rule about filing rather than about holding.

export const KRYPTO_HOLDER_TOKENS = 1_000_000;

/**
 * What a holder pays, as basis points OF THE ORDINARY FEE. 5000 = half: the
 * 0.5 % fee becomes 0.25 %, and because the referrer's cut is a share of
 * the fee, it halves with it (0.1 % of the trade → 0.05 %) instead of
 * disappearing. Pinned by the canary: a build that sets this to 0 has
 * quietly restored the full waiver — and cut every referrer out.
 */
export const KRYPTO_HOLDER_FEE_SHARE_BPS = 5000;

/**
 * Does this holding earn the holder rate?
 *
 * NEVER, in Krypto Mirror. This app charges one flat rate to everyone — 0.5 %
 * a side, no holder discount and no referral share — so no balance, however
 * large, qualifies. The function stays because every fee path (Solana
 * signer, swap, bridge, EVM trade) asks it; answering here is the one place
 * the rule can be set without any of them drifting.
 */
export function holderRateApplies(_holdingTokens: number | null): boolean {
  return false;
}

/**
 * The fee rate to charge, in basis points of the trade: `baseBps`, for
 * everyone. Flat in Krypto Mirror — `qualifies` is accepted and ignored, so a
 * caller that still passes a holder flag cannot discount a trade.
 */
export function holderFeeBps(baseBps: number, _qualifies: boolean): number {
  return baseBps;
}

/** What the user is shown: the live holding, and what it would take. */
export interface KryptoHolding {
  /** Whole tokens across every wallet this install holds keys for. */
  tokens: number;
  /** USD value — SHOWN, never load-bearing. The holder rate is decided by
   *  `tokens` alone, so an unpriceable token costs a line of display and
   *  never a fee. */
  usd: number | null;
  /** Wallets counted — a user with one wallet should not be told "3 wallets". */
  wallets: number;
  /** When this was last read successfully, ms. 0 until a read has landed.
   *  Stale is shown as stale, never as fresh. */
  at: number;
  /** Why the value is unknown, when it is — set by a read that ran and
   *  failed, cleared by the next one that works. Null with `at` 0 means
   *  "not read yet", which is a different thing from a read that broke. */
  problem: string | null;
}

export function isValidMint(mint: string | null): mint is string {
  return typeof mint === 'string' && MINT_RE.test(mint);
}

/** The card renders only for a real, well-formed mint. */
export function kryptoTokenLive(): boolean {
  return isValidMint(KRYPTO_TOKEN.mint);
}

export function kryptoPumpUrl(mint: string): string {
  return `https://pump.fun/coin/${mint}`;
}

/**
 * Shown under the card, always. Every clause is a fact about the issuer:
 * who made it, that this is not a recommendation, and how the issuer earns
 * from it. Edit `LAUNCH_HOLDING` to the share the launch wallet actually
 * bought, once it has.
 */
/** The creator's first buy, read from the launch trades: 0.464 SOL for
 *  16,349,813.52 of 1,000,000,000 tokens (2026-09-12 09:38:39 UTC). */
export const KRYPTO_LAUNCH_HOLDING: string | null = '1.6%';

export function kryptoDisclosure(): string {
  const holding = KRYPTO_LAUNCH_HOLDING ? ` Krypt's launch wallet bought ${KRYPTO_LAUNCH_HOLDING} of the supply at launch.` : '';
  return (
    `$${KRYPTO_TOKEN.symbol} is issued by Krypt, the maker of this app. Showing it here is not a recommendation to buy, sell or hold it, ` +
    `and nothing in this app is financial advice. Krypt earns pump.fun creator fees on every trade of it.${holding} ` +
    // Krypto Mirror charges one flat fee, so the stake buys a holder nothing
    // here — said outright, because Krypto Bot's version of this paragraph
    // promises a discount and someone may have read it there.
    `Holding it changes nothing about what Krypto Mirror charges: its fee is the same flat rate for everyone. ` +
    `It is a memecoin: it can go to zero.`
  );
}
