# Copy candidates and competitors, 2026-10-24

The question: is there a wallet that copying would have made money on over the past week? And how does Krypto Copy compare with the other copy-trading bots?

**Answer:** no wallet. None of the 12 shortlisted wallets survives a full-week check. The one that looked profitable on a 30-trip sample loses −9.8 SOL over its whole week. Nothing was signed or sent.

## Method

1. **Shortlist from the Scout record** (`wallet-scout.json`, 7-day window). Kept: wallets with ≥ 8 copyable trips, under the 40 trades/min bot rule. Ranked by the board's shrunk follower median (k = 10, prior −15.5 %). 263 were eligible and **15 come out above zero**, about what luck alone produces in a sample that size. The top 12 went forward.
2. **Re-check each from the chain, over the whole week.** Their swaps come from Helius `getTransactionsForAddress` decoded by `decodeWalletSwap`, and their trips from `buildTrips`. Each copy leg is priced at the board's 2 s lag in the recorded 1.5 %/side model, then repriced to a 0.1 SOL copy with the paper cost model. Each result is split into trips closed on days the Scout saw the wallet versus days it did not; the second set is the out-of-sample test.

## Results (0.1 SOL copies, 2 s lag, after costs)

First pass: swap-API prices, 30 trips sampled across the week (60 for the first two).

| Wallet | Week trips | Median hold | Copies | Median | Mean | Win | Total | Unseen days total |
|---|---|---|---|---|---|---|---|---|
| 2zaAtsk4 (Scout #1) | 386 | 432 s | 60 | −14.1 % | −20.4 % | 13 % | −1.23 SOL | −1.01 |
| 6CT7cjJu (#2) | 97 | 38 s | 60 | −7.1 | −4.2 | 35 | −0.25 | −0.20 |
| 3hjz69zC | 577 | 7 s | 25 | −40.2 | −29.6 | 24 | −0.74 | — |
| AS8UtAqa | 544 | 34 s | 18 | −85.1 | −42.6 | 22 | −0.77 | −0.72 |
| 5Voxqwa8 | 287* | 7 s | 30 | −7.1 | +26.9 | 43 | **+0.81** | +0.26 |
| BJTjUV3P | 1402 | 21 s | 24 | −23.5 | −30.0 | 17 | −0.72 | −0.33 |
| 9bwHbhAE | 1497 | 21 s | 30 | −13.7 | −10.3 | 20 | −0.31 | −0.32 |
| 5TBZXUhx | 1325 | 46 s | 29 | −21.2 | −18.8 | 14 | −0.55 | −0.28 |
| HmEswNzS | 205 | 13 s | 30 | −27.9 | −20.9 | 23 | −0.63 | — |
| H181j6Hs | 1184 | 37 s | 30 | −16.5 | +3.7 | 37 | +0.11 | −0.14 |
| 9SswQHto | 805 | 2 s | 18 | +1.0 | +7.1 | 50 | +0.13 | −0.15 |
| k8Xcsz12 | 113 | 116 s | 4 | — | — | — | −0.05 | — |

\* 287 is what a 3,000-transaction read reached. The wallet made 2,160 trips that week.

**5Voxqwa8, the whole week, chain-priced** (see the next section):
- 2,160 trips, 2,027 priced, 29 too fast to copy.
- Copies: median −22.5 %, mean −4.8 %, 36 % win, **total −9.80 SOL**. Every one of the 5 days was negative.
- Without its 10 best copies (up to +1,461 %): −16.4 SOL.
- The leader itself lost −9.05 SOL on 448 SOL traded, with a median hold of 11 s. The +0.81 SOL sample was a lucky draw from a heavy tail.

**Scout bias found.** The Scout records only the trades its live feed carried. On 6CT7cjJu's one Scout day:
- Its 10 recorded trips reappear in the chain replay.
- The replay found 23 trips that day, and most of the 13 extra are −85 to −100 % dead coins.

So a wallet's Scout record leans toward its coins that survived, and the board ranks such wallets too high. The fix belongs in the board, not in this note.

## Pricing: swap API against the chain

The app's copy replay prices each leg with pump's swap API (`pumpswap.priceAt`).
- That API is Chromium-only (Cloudflare challenges Node's fetch), paced at one call every 2 s, and parks callers for 60–90 s on a 429.
- The 12-wallet pass took about 2.5 h. A full week of one busy wallet did not finish in 2 h.

A chain-priced replay was prototyped instead.
- **How it prices a leg:** one Helius `getTransactionsForAddress` on the mint, with `filters.slot.lte = leader's slot + 9` (2 s at 211.6 ms slots), newest first. The price is the coin's price after the last trade at or before that slot:
  - pump `TradeEvent`: virtual reserves;
  - PumpSwap swap: executed price.
- **Speed:** 4,320 legs in 14 min, about 5 a second, in plain Node. A 30-trip in-app replay would take about 12 s.
- **Cost:** about 10 credits per call, so about 600 credits for a 30-trip replay.
- **Validation** on the 26 trips both methods priced:
  - median difference 0.0 points, and 16 of 26 within 10 points;
  - the rest differ by up to ±60, because "2 s later" is a moment in time to the API but an exact slot here, and a pump coin can move hard within one second.

The slot definition is the one the live engine measures copies by (`slotGap`).

Prototype: `test/.chainreplay.mjs` (git-ignored; its entry was deleted).

## Competitors (research agent, 2026-10-24)

Labels: V = vendor docs, T = third-party review, often affiliate. No product publishes a measured copy latency, and no independent test of one was found.

| | Copy fee | Custody | Notes |
|---|---|---|---|
| **Krypto Copy** | 0.5 %/side | Local, encrypted | Follower-scored board, replay, paper first, guardrails, Parsed Streams feed |
| GMGN | 1 % (V) | Bot wallet | Proportional sells; copied sells stop once TP/SL is set (V); advises 30–50 % slippage |
| Trojan | 1 % (T) | Bot wallet | Copy sell at the same %; reviewer timed 2–5 s behind the leader (T) |
| Bloom | 1 % (V) | nf | Sells when the leader moves tokens out; reverse mode; Max Slot Diff; 8 chains |
| Axiom | 0.75–0.95 % (V) | Turnkey (T) | No automatic copying in its docs, tracker only |
| Maestro / Banana Gun / Nova / BonkBot / Photon / BullX | ~1 % | Bot wallet | Details thin or disputed. Nova's docs domain is parked |
| pump.fun app (Terminal) | 0.45 % (V) | Turnkey (claim) | Cheaper than us on fee; copy trading not established |

- **Ahead:** fee (except pump's own app), local custody, scoring wallets on what a follower gets (everyone else ranks by leader profit), paper first, published guardrails.
- **At par:** sizing, proportional sells, filters, TP/SL, trailing stop and max hold.
- **Behind:** sell when the leader moves tokens out (Bloom), exit when the creator sells, dev-holdings and liquidity filters, MEV toggles on copies, chain count. No live copy has been timed yet.

**General evidence** (as reported; the primary studies were not all retrieved):
- White Whale Labs via ChainCatcher, 10-20: delayed copying lost 11–41 % per coin, and they found "no monetizable advantage".
- Bitquery: 6.85M Solana sandwiches in a year, 96 % on pump.fun coins. 20–50 % slippage was sandwiched 14× more often than under 3 %.

These agree with the −15.5 % prior here.

## Conclusion

- Over the past week, copying any of the strongest Scout wallets at a realistic 2 s delay would have lost money.
- The one wallet that looked positive was a 30-trip sample from a heavy tail, and its full week is clearly negative.
- What would help the product:
  1. chain pricing for the replay, so a week takes seconds, not hours;
  2. fixing the board's survivorship bias;
  3. letting the board recommend nobody, rather than its least bad wallet.
