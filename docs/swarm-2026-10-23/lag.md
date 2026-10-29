# Tape science: the lag curve and an honest follower model (M1 + M8 + survivorship)

## 0. Pre-registration (written 2026-10-23 09:58 UTC, before any number below was computed)

Model (primary, "SPEC"): the follower enters at the first print by anyone other than the leader at or after leader first buy + lag; it sells the leader's sold fraction of its remaining bag at the first non-leader print at or after each leader sell + lag; the leader's closing sell sells everything left. Cost: 1.25 % venue + 0.5 % Krypt on the SOL side of each leg, 0.003504 SOL fixed per round trip, own curve impact from virtual reserves on both legs. Sizes 0.05 and 0.1 SOL. Survivorship variants: LAST (dead slice marked at the last print), ZERO (dead slice at -100 %), DROP (the app's current rule: trips with a dead exit, a never-closed leader, or a leader out before our entry are left out).

Thresholds, fixed now:

- **P1 (a decile "reaches breakeven").** Test-half pooled median per copied trip >= 0 at that lag, LAST model, at 0.05 SOL or 0.1 SOL. It is **credible** only if the mint-clustered bootstrap 95 % CI lower bound is also >= 0.
- **P2 (speed turns copying positive).** At least one train-selected decile is credible (P1) at a lag in 0.4-1.0 s, at 0.1 SOL, LAST model, on **all three** pairs (07-26 -> 07-27, 09-10 -> 09-11, 09-16 H1 -> H2). With 10 deciles x 3 lags x 3 pairs = 90 cells, about 2 one-sided false positives are expected by chance, so a single positive cell is not evidence.
- **P3 (Helius $49/month prebuild "pays for itself").** YES only if P2 holds. If P2 fails, I still report the loss reduction from 2.0 s to 0.6-1.0 s for the top decile at 0.1 SOL, and the break-even improvement it would need: $49 / (SOL price x monthly notional) x 100 pts; at 20 copies/day x 0.1 SOL (60 SOL/month) that is 0.54 pts at $150/SOL and 0.33 pts at $250/SOL. A loss reduction above that is reported as "loses less", and the answer stays NO, because not copying beats both.
- **P4 (the +5 pts is hold mix).** Hold-matched control: for every top-decile test trip, a random buy in the test half from the same UTC hour and leader-entry curve band, copied with that trip's exact exit schedule (offsets and fractions), same lag and costs. The same for the all-eligible baseline. "Explained by hold mix" if (top - top control) - (base - base control) is less than half of (top - base).
- **P5 (survivorship is material).** Switching DROP -> LAST moves a decile's test median by >= 1 pt, or moves the top decile out of the top three.

**Note added after the first run (09-16 only, about 10:05 UTC), before the July and September pairs were computed.** The pre-registered SPEC fill convention ("first non-leader print at or after the due time") produced a degenerate mass: in quiet coins both legs fill at the same later print, so the trip shows no price move and skips the leader's own impact (section 2.2). I added two models alongside SPEC. I did **not** change any threshold. P1-P5 are evaluated on every model, and SPEC stays in every table.

- **STATE (curve-physical).** Each leg trades against the curve state left by the last print, by anyone, strictly before the due time. A bonding curve always quotes, so the follower needs no counterparty print.
- **STATE-F.** STATE, but with "too-fast" trips skipped: the leader is fully out before our buy is due, so no buy is placed. This is what the live engine does with an unsent buy (`electron/engine/copyTrade.ts:1300-1325`, **code**).

---

## 1. Bottom line

1. **No decile reaches breakeven at any lag on any pair, under any of the three fill models, at 0.05 or 0.1 SOL** (**measured**). That is 630 decile-lag-model cells per size; 0 have a median >= 0 and 0 are credible. P1 fails everywhere, so P2 fails.
2. **The best decile sits on the fee floor, not above it.** A copied round trip with no price move costs **-10.79 % at 0.05 SOL and -7.60 % at 0.1 SOL** (1.75 %/side, the 0.003504 SOL fixed fee, and own impact at 30 SOL depth; **measured** as the exact modal value). The train-selected top decile's test median is -7.5 to -9.2 % at 0.1 SOL on every pair and model. The ranker finds wallets whose trades barely move the price, which is the closest thing to doing nothing.
3. **Speed helps a little and monotonically under the honest model.** STATE-F pooled median at 0.1 SOL is 1.1 to 1.6 pts better at 0.4 s than at 2 s on all six day files (**measured**), and 0.4 to 0.8 pts better at 1 s than at 2 s. The requested SPEC convention shows the opposite (longer lag looks better). That is an artefact: too-fast and no-move trips pile up at the fee floor as the lag grows.
4. **The 10-22 "+5 pts" is not hold mix, but it is not skill either.** Against random buys from the same hour and curve band, copied with the trip's exact exit schedule, the top decile is about as good as random in medians (-0.9 to +3.3 pts). The average ranked wallet is 1 to 7 pts **worse** than random. So the shrunk median works by avoiding wallets that are worse than a random buy, not by finding ones that beat it. In 1 %-trimmed means the picture is milder, and 18 of 27 cells read "explained by mix" (section 4.2).
5. **Survivorship matters at the bottom, not the top.** Pricing dead coins at their last curve print instead of dropping them moves D1-D8 by at most 0.9 pts. It moves D9/D10 by 0.2-11.6 pts and all-ranked by 0.33-0.41 pts. -100 % pricing is physically impossible on a live bonding curve (section 5).
6. **Helius $49 prebuild: NO** on this evidence (section 7). It buys about 0.3-1.1 pts of loss reduction and never reaches 0.

---

## 2. Data and method

### 2.1 Data (**measured**, `lag/lag.mjs`, run 2026-10-23)

| file | span h | Solana prints used | leader trips evaluated | closed | ranked wallets (>=10 trips, 0.4 s) |
|---|---|---|---|---|---|
| 2026-07-26 | 21.45 | 2,052,344 | 648,813 | 571,219 | 10,833 (train) |
| 2026-07-27 | 24.00 | 2,982,989 | 919,986 | 809,731 | test |
| 2026-09-10 | 8.67 | 1,166,209 | 350,512 | 313,553 | 5,123 (train) |
| 2026-09-11 | 24.00 | 2,606,974 | 743,790 | 658,598 | test |
| 2026-09-16 H1 | 5.33 | 805,110 | 252,649 | 220,535 | 4,352 (train) |
| 2026-09-16 H2 | 5.33 | 468,881 | 119,338 | 104,789 | test |

- **Rows skipped.** Rows without a positive sol, tokens or price were dropped. In September most of them are EVM rows (0x addresses). About 6.5 % of the pump rows in the first 1.5 M rows of 09-11 have sol = 0 and price = 0; in July the figure is about 2 % (**measured**, awk count). Some leader sells are therefore invisible, which inflates the "never closed" share. The pump V3 log change noted in the 10-23 audit memory is a candidate cause (**estimate**).
- **The price column.** On the CSV days it is the post-trade curve spot: price / (vSol²/k), with vSol = 30 + 0.85·curvePct, sits at 0.99-1.00 for nearly all pump rows (**measured**). sol/tokens is **not** a reliable fill price. On 09-16, small pump sells by one bot wallet show sol/tokens / price >= 1.3 on 4,649 rows (617 mints) in the first 400k lines, and the next print continues from `price`, so `price` is the true state (**measured**). The app's Scout fills at `native / tokens` (`electron/engine/walletScout.ts:459`, **code**).
- **Clock.** On 09-16 the tape advances **316.8 ms per slot** (121,049 slots over 10.65 h). Receive stamps within one slot spread 22 ms at p50, 99 ms at p90 and 432 ms at p99, and consecutive slots' first prints are 307 ms apart at the median (**measured**, `lag/slots.mjs`). So the tape is not a 400 ms tape. The 0.4 s and 0.6 s lags are about 1.3 and 1.9 slots, and sub-slot ordering comes from receive time. Solana moved to ~200 ms slots on 2026-10-09 (10-21 doc), so these lags would be about 2-3 slots today.

### 2.2 Follower model

- **Trips.** One leader trip runs per (wallet, mint) from the first buy. Later buys add to it. Each sell has fraction = tokens sold ÷ tokens held. The trip closes at a sell fraction >= 0.995 or when <= 0.5 % of the bought tokens remain. Sells with no tracked position are ignored. Trips opened in the last 30 min of a file are not evaluated.
- **Follower.** The follower buys once at the leader's first buy plus the lag, with size 0.05 or 0.1 SOL. It sells the same fraction of its remaining bag at each leader sell plus the lag, and sells everything at the closing sell.
- **Costs** (paper model 2, `shared/copytrade.ts:966-983`, `shared/exitBudget.ts:242-246`, **code**). 1.25 % + 0.5 % comes off the SOL side of each leg. The fixed fee of 0.003504 SOL per round trip (0.001 + 0.000056 + 0.000005 buy, 0.002 + 0.000438 + 0.000005 sell; `shared/exitBudget.ts:163, 233`) is charged on top of the size. Return = (proceeds − size − 0.003504) ÷ size.
- **Own impact.** Exact constant-product swaps against (vSol, vTok = vSol / price). vSol = 30 + 0.85·curvePct where curvePct > 0. On 09-16, which has no curvePct, vSol = sqrt(32.19e9 · price) for pump prints within the curve's price range. Otherwise vSol = 30, the shallowest depth and the largest impact. Both legs are charged against the tape's state, without our footprint persisting, which over-counts impact by up to about 2·size/vSol (<= 0.67 pts at 0.1 SOL; **estimate**). Mayhem (2× supply) coins get their impact overstated by sqrt(2), which is conservative.
- **SPEC** (as specified). Each leg fills at the post-trade state of the first print by **anyone other than the leader** at or after the due time, within 10 min. With no such print the slice is **dead**: LAST marks it at the last print up to due + 10 min, and ZERO marks it at -100 %. Mints that graduated are never zeroed: a max curvePct >= 99, or a `complete` event on 09-16 (490-1,872 mints a day). A never-closed leader is marked at the mint's last print. ZERO applies only when the coin printed nothing in the file's last 10 min and did not graduate. **DROP** is the app's current rule: no dead slice, leader closed, and not too-fast.
- **STATE.** Each leg trades against the state after the last print by anyone strictly before the due time. A real copy lands at its own time, after the leader, whether or not anyone else trades. In quiet coins this charges the leader's own impact on both legs, which SPEC skips.
- **STATE-F.** STATE without too-fast trips, where the leader closed before our buy was due.

**Why SPEC is not honest on a curve** (**measured**). Under SPEC, 3-6 % of all trips and 14-24 % of top-decile trips at 0.4-4 s are exact no-move round trips (section 4.1). In a quiet coin, the first other trader's print comes after both of the leader's legs. The tape then never shows the follower paying the leader's impact. The app's Scout uses the same "first print at or after due" rule (`electron/engine/walletScout.ts:330-366`, **code**). It also allows the leader's own later prints, and drops too-fast and no-exit trips as unreachable (`:545-558`, **code**).

**Statistics.** Each table gives the pooled median and the 1 %-trimmed mean per copied trip. 95 % CIs come from a bootstrap that resamples mints with replacement (B = 300 for deciles; B = 200 for pooled and control cells). Deciles rank wallets on the train half by shrunk median: (n·med + 10·pop) ÷ (n + 10), with >= 10 entered trips, at the same lag and model as the test, at 0.05 SOL, LAST. They are tested on the next file without re-ranking. "App-like" ranks once at 2 s under SPEC with the DROP filter, the way the board does today, and is tested at each lag.

---

## 3. Q1: the pooled lag curve (all leader trips, % per copied trip; median / 1 %-trimmed mean)

**STATE-F, 0.1 SOL** (curve-physical, too-fast skipped; the model closest to the live engine; **measured**)

| day | 0.4 s | 0.6 s | 1 s | 2 s | 4 s | 30 s | 120 s |
|---|---|---|---|---|---|---|---|
| 07-26 | -19.1 / -19.0 | -19.4 / -19.4 | -19.8 / -19.8 | -20.4 / -20.3 | -21.0 / -21.0 | -23.4 / -24.1 | -23.5 / -24.8 |
| 07-27 | -17.3 / -14.8 | -17.6 / -15.2 | -18.0 / -15.5 | -18.6 / -16.0 | -19.1 / -16.6 | -20.2 / -18.6 | -20.6 / -19.8 |
| 09-10 | -18.6 / -18.6 | -18.8 / -18.7 | -19.4 / -19.3 | -20.2 / -20.0 | -21.2 / -21.1 | -24.9 / -25.6 | -32.9 / -32.8 |
| 09-11 | -17.3 / -16.9 | -17.5 / -17.1 | -18.1 / -17.5 | -18.9 / -18.2 | -19.5 / -18.9 | -21.7 / -22.0 | -23.2 / -23.8 |
| 09-16 H1 | -15.3 / -11.5 | -15.4 / -11.7 | -15.9 / -12.1 | -16.6 / -12.5 | -17.2 / -13.1 | -18.7 / -13.8 | -20.1 / -15.4 |
| 09-16 H2 | -14.5 / -12.3 | -14.7 / -12.4 | -15.2 / -12.8 | -15.6 / -13.1 | -15.8 / -13.5 | -16.9 / -14.9 | -17.2 / -15.4 |

- n at 0.4 s: 628,598 / 884,740 / 337,311 / 714,224 / 244,338 / 114,295.
- n at 2 s: 587,720 / 817,874 / 308,619 / 648,648 / 225,889 / 102,776.
- n at 120 s: 207,901 / 268,535 / 95,762 / 206,771 / 66,605 / 30,416.
- 09-16 H1 median at 0.4 s: -15.26 [-16.08, -14.39]; tmean -11.55 [-13.13, -9.94].

**STATE-F, 0.05 SOL** (median): -22.4 / -20.6 / -21.9 / -20.6 / -18.5 / -17.8 at 0.4 s, against -23.8 / -21.9 / -23.6 / -22.2 / -19.8 / -18.9 at 2 s (same day order).

**SPEC-LAST, 0.1 SOL** (the requested convention; median / tmean)

| day | 0.4 s | 1 s | 2 s | 4 s | 30 s | 120 s |
|---|---|---|---|---|---|---|
| 07-26 | -18.4 / -19.0 | -18.2 / -19.4 | -17.6 / -19.4 | -16.4 / -19.3 | -10.4 / -17.9 | -7.6 / -14.9 |
| 07-27 | -16.5 / -14.9 | -16.3 / -15.1 | -15.8 / -15.3 | -14.8 / -15.3 | -9.2 / -14.4 | -7.6 / -12.7 |
| 09-10 | -17.4 / -18.4 | -17.3 / -18.6 | -16.9 / -18.8 | -16.0 / -18.9 | -9.8 / -17.8 | -7.6 / -16.7 |
| 09-11 | -15.9 / -16.7 | -15.8 / -16.9 | -15.4 / -17.0 | -14.4 / -17.0 | -9.1 / -15.9 | -7.6 / -14.2 |
| 09-16 H1 | -14.6 / -11.6 | -14.5 / -11.9 | -14.4 / -12.2 | -13.8 / -12.3 | -9.7 / -11.7 | -7.6 / -11.0 |
| 09-16 H2 | -13.1 / -12.2 | -13.1 / -12.2 | -12.8 / -12.4 | -12.2 / -12.2 | -8.8 / -12.1 | -7.6 / -10.7 |

Under SPEC (and STATE with too-fast trips kept), the median rises with lag to the -7.60 floor at 120 s. The trimmed mean is nearly flat. The reason is in the shares below: at 120 s, 62-68 % of trips are too-fast (bought and sold at once), and 22-28 % are exact no-move trips. **Reading the SPEC median as "slower is better" would be wrong.**

**Shares at 0.4 s → 2 s → 120 s** (all days, **measured**): dead slice (not graduated) 3.1-3.8 % → 3.2-4.0 % → 4.1-5.8 %. Leader never closed in the file: 7.9-11.9 % throughout. Too-fast: 0.7-1.7 % → 6.9-11.3 % → 61.8-68.2 %.

**Speed gain, STATE-F 0.1 SOL pooled median** (**measured**, from the table above):
- 2 s → 1 s: +0.4 to +0.8 pts.
- 2 s → 0.6 s: +0.9 to +1.4 pts.
- 4 s → 1 s: +0.6 to +1.8 pts.

Trimmed means move about the same. No lag comes within 11 pts of zero.

---

## 4. Q2 and Q3: deciles, train → test, every pair

### 4.1 Does any decile reach >= 0? No.

Every cell below is 0 of 10 deciles with a median >= 0, and 0 with a 95 % CI lower bound >= 0, at both 0.05 and 0.1 SOL. Cells give the best decile's test median at 0.1 SOL [CI low], and the all-ranked median (**measured**, `lag/out/summary.md` §B).

| pair, model | 0.4 s | 0.6 s | 1 s | 2 s | 4 s | 30 s | 120 s |
|---|---|---|---|---|---|---|---|
| 07-26→27 SPEC | D1 -7.78 [-7.93]; all -14.45 | D1 -7.73; -14.36 | D1 -7.60; -14.05 | D1 -7.60; -13.56 | D1 -7.60; -12.68 | D1 -7.60; -7.90 | D1 -7.48; -7.60 |
| 07-26→27 STATE-F | D1 -8.52 [-8.69]; -15.49 | -8.83; -15.71 | -8.94; -15.97 | -9.20 [-9.37]; -16.37 | -9.51; -16.67 | -10.28; -16.26 | -10.00; -14.83 |
| 09-10→11 SPEC | D1 -7.60; -11.00 | -7.60; -10.95 | -7.60; -10.84 | -7.60; -10.65 | -7.60; -10.06 | -7.60; -7.60 | -7.56; -7.60 |
| 09-10→11 STATE-F | D1 -7.80 [-7.93]; -13.24 | -7.95; -13.35 | -8.12; -13.67 | -8.19 [-8.32]; -14.11 | -8.45; -14.27 | -8.99; -14.04 | -9.43; -13.39 |
| 09-16 H1→H2 SPEC | D1 -7.60; -10.63 | -7.60; -10.65 | -7.60; -10.50 | -7.60; -10.48 | -7.60; -9.87 | -7.60; -7.60 | -7.50; -7.60 |
| 09-16 H1→H2 STATE-F | D1 -7.77 [-8.33]; -12.78 | -7.81; -12.94 | D2 -9.84; -13.48 | D1 -8.67 [-9.22]; -14.03 | -8.93; -13.98 | -9.50; -13.57 | -9.38; -12.58 |

- **Test-half n, 0.4 s, all ranked:** 478,599 trips (jul), 313,826 (sep), 59,598 (09-16). STATE-F top decile at 0.4 s: 78,100 / 54,180 / 13,873 trips.
- **At 0.05 SOL** the best decile median is -10.8 to -13.6 in every cell.
- **STATE without skipping too-fast** gives the same verdict: best -7.50 to -8.80.
- **Best 1 %-trimmed mean** at 0.4-1.0 s on every pair is -7.50 to -8.94 % at 0.1 SOL, and every upper CI is below -6.3.
- **Only two cells come near 0 by trimmed mean.** STATE-F at 30 s and 120 s on 09-16 show D9 -4.89 [-14.6, +9.2] (1,336 trips, 97 wallets) and D7 +14.4 [-7.7, +58.3] (460 trips, 36 wallets). Their medians are -27.6 and -21.2. These are tail noise in deciles of fewer than 100 wallets. They are not at a fast lag and they do not replicate.

**What the top decile is** (**measured**, `out/summary.md` §F). Under SPEC, the leader's median first buy in the top decile is 0.010-0.034 SOL in September (all ranked: 0.049-0.063), and 0.10-0.15 SOL in July (all: 0.31). 14-24 % of its trips are exact no-move round trips (all: 5-11 %). Its size-free basis median is exactly -3.47 % in 7 of 9 cells, which is the fee-only round trip, against -6.5 to -10.6 for all ranked. **The "least bad" wallets are the ones whose own trades barely move the price.** A follower at 0.1 SOL is 3-20× their size in September.

**Ranking on the honest model helps** (**measured**). Under STATE-F, the app-like top decile (ranked by today's 2 s SPEC/DROP rule) tests at -10.54 / -10.08 / -11.88 at 2 s. The STATE-F-ranked top decile tests at -9.20 / -8.19 / -8.67, a gain of 1.3-3.2 pts on every pair.

### 4.2 Hold-matched control (Q3, P4)

**Control design.** For every top-decile test trip: 3 random buys from the test half, matched on the same UTC hour and leader-entry curve band (unknown, <10, 10-25, 25-50, 50-75, >=75 %). Each is copied with **that trip's exact exit schedule** (sell offsets and fractions), at the same lag, model and costs. For the baseline: one draw for each of up to 30,000 all-ranked test trips. Values below are 0.1 SOL, median (**measured**, `out/summary.md` §C).

| pair | model | lag | top | top ctl | all ranked | all ctl | (top−ctl)−(all−ctl) | ½(top−all) | P4 explained? |
|---|---|---|---|---|---|---|---|---|---|
| jul | STATE-F | 0.4 | -8.52 | -7.81 | -15.49 | -8.66 | +6.13 | +3.49 | no |
| jul | STATE-F | 2 | -9.20 | -8.33 | -16.37 | -10.64 | +4.86 | +3.58 | no |
| sep | STATE-F | 0.4 | -7.80 | -7.89 | -13.24 | -8.98 | +4.36 | +2.72 | no |
| sep | STATE-F | 2 | -8.19 | -7.99 | -14.11 | -11.03 | +2.88 | +2.96 | yes (marginal) |
| 09-16 | STATE-F | 0.4 | -7.77 | -8.19 | -12.78 | -9.99 | +3.21 | +2.51 | no |
| 09-16 | STATE-F | 2 | -8.67 | -11.96 | -14.03 | -12.52 | +4.80 | +2.68 | no |
| jul | SPEC | 2 | -7.60 | -7.59 | -13.56 | -8.13 | +5.42 | +2.98 | no |
| sep | SPEC | 2 | -7.60 | -7.60 | -10.65 | -7.61 | +3.03 | +1.52 | no |
| 09-16 | SPEC | 2 | -7.60 | -7.60 | -10.48 | -7.83 | +2.65 | +1.44 | no |

- Control n per cell: 16,211-370,971.
- **Across all 27 cells** (3 models × 3 pairs × 0.4/1/2 s): medians say "not explained by mix" in 26 of 27. 1 %-trimmed means say "explained" in 18 of 27: 9/9 SPEC, 7/9 STATE, 2/9 STATE-F.

**Interpretation** (**measured**). The top decile beats the average ranked wallet by 3-7 pts at the median. Hold mix does not account for it. Even so, **the top decile is no better than a random buy** with the same hour, band and exit timing (-0.9 to +3.3 pts). The average ranked wallet is 1-7 pts **worse** than that random buy. So the shrunk median is a filter against harmful wallets, whose copies pay their impact or ride their exits, not a finder of good ones. That matches the 10-22 doc's own "mirroring the average wallet is 1.4 pts worse than random". The trimmed means are milder: heavy left tails in the random controls make the average wallet look slightly better than random.

---

## 5. Q4: survivorship (SPEC, 0.05 SOL, test-half median)

This compares four treatments: LAST (dead slices priced at the last print), dead dropped (dead and never-closed-dead trips removed), the app's DROP (also removes too-fast and every never-closed trip) and ZERO (**measured**, `out/summary.md` §D).

| pair, lag | D1: dead % / LAST / dead dropped / app DROP / ZERO | D2: LAST / dead dropped / DROP / ZERO | D9 | D10: dead % / LAST / dead dropped / DROP / ZERO | all ranked: dead % / LAST / dead dropped / DROP / ZERO |
|---|---|---|---|---|---|
| jul 0.4 s | 5.2 / -11.08 / -10.88 / -11.53 / -11.59 | -14.42 / -13.88 / -14.24 / -14.87 | -40.55 / -39.06 / -42.29 / -43.17 | 18.8 / -63.49 / -63.10 / -64.01 / -65.33 | 6.5 / -17.77 / -17.42 / -18.74 / -19.27 |
| sep 0.4 s | 8.9 / -10.79 / -10.79 / -10.79 / -10.79 | -12.32 / -12.16 / -12.52 / -12.71 | -32.16 / -30.04 / -32.38 / -35.72 | 23.2 / -48.75 / -45.57 / -47.15 / -60.20 | 7.7 / -14.28 / -13.91 / -14.88 / -15.92 |
| 09-16 0.4 s | 7.1 / -10.79 / -10.79 / -11.24 / -11.40 | -12.40 / -12.26 / -12.63 / -12.66 | -26.45 / -25.26 / -27.59 / -31.82 | 28.5 / -39.88 / -28.51 / -34.42 / -54.60 | 7.6 / -13.88 / -13.55 / -14.54 / -15.36 |
| 09-16 2 s | 9.6 / -10.79 / -10.79 / -12.95 / -10.79 | -11.98 / -11.87 / -12.70 / -12.12 | -25.11 / -24.48 / -27.61 / -30.70 | 28.9 / -38.83 / -27.27 / -33.96 / -55.44 | 7.7 / -13.74 / -13.33 / -16.22 / -15.24 |

**Findings (P5)**

- **Dead coins.** Pricing them instead of dropping them moves D1-D8 by -2.4 to +0.5 pts (D8 on 09-16 at 0.4 s is the -2.4; all others are within 0.9). D9 moves by 0.6-2.6 pts and D10 by 0.2-11.6 pts. All ranked moves 0.33-0.41 pts. **P5 is material for D8-D10 and for the honesty of the all-ranked figure, and immaterial for the top.** The top decile stays first everywhere.
- **The app's DROP rule is a different bias than "survivorship".** It drops too-fast trips as well, which under the first-print rule are near-flat. So it makes the top deciles and the all-ranked figure look **worse**, by 0.0-2.2 and 0.6-3.1 pts. Meanwhile it flatters D10 by up to 5.5 pts (09-16). The Scout's "least bad" ordering is right, but its spread is compressed.
- **ZERO versus LAST** costs D1 0-0.6 pts and D10 1.8-16.6 pts. On a live pump curve, -100 % cannot happen: the SOL stays in the curve and a sell always quotes at the post-last-print state, floored near the start price (**estimate**, constant-product mechanics; dead share 3-6 % **measured**). Only graduated coins, whose follow-on venue this tape does not price, and transfer-hook or freeze mints can do worse. **The 10-21 doc's "priced at -100 %" common model is wrong as a default; LAST is the curve's real fill.**
- **Never-closed leaders.** 7.9-11.9 % of all trips never close inside the file. The app never scores them. Marked at the last print, they are already inside the LAST and STATE figures.

---

## 6. Corrections to the prior docs

1. **10-22 "shrunk top decile −4.7 % vs −9.9 %".** The direction replicates on all three pairs: top 3-7 pts better than all ranked. But the top decile's median trip is **the fee-only round trip** (size-free basis exactly -3.47 % in 7/9 SPEC cells). It is not a wallet with information. Section 4.2 shows it is no better than random once the hour, band and exit schedule are held fixed (**measured**).
2. **10-22 §4 "Slippage, survivorship and lag variance are not modelled".** Survivorship is now measured: <= 0.6 pts on the ranked top, and up to 11.6 pts on D10. The app's DROP flatters D10 and penalises the top. Own impact at 0.1 SOL is now modelled.
3. **10-21 §5 common follower model, dead coins at -100 %.** As shown in section 5, this is not possible on a live bonding curve. Use the last curve state, and treat graduated coins separately.
4. **Tape era.** The task says 400 ms slots. The 09-16 tape runs at **316.8 ms per slot** (**measured**).
5. **The Scout's fill rule** (`walletScout.ts:330-366, 455-459`, **code**) has three problems. It uses `native / tokens` (wrong for multi-trade transactions, section 2.1). It waits for the next print (which skips the leader's impact in quiet coins, section 2.2). It lets the leader's own later prints fill. Each one flatters quiet-coin, small-size wallets.
6. **SPEC lag curve.** Under the 10-21 doc's convention (M1), a slower lag looks better. That is the no-move / too-fast artefact (section 3), not a property of copying.

---

## 7. Does speed money pay for itself? **No.**

The pre-registered P2 test fails: no decile, no pair, no lag, no model is >= 0, let alone credible on all three pairs. Under P3, the answer is therefore NO.

The loss reduction it would buy (**measured**, STATE-F, 0.1 SOL):
- **Top decile, 2 s → 1 s:** +0.26 (jul), +0.07 (sep), -1.6 (09-16, noisy).
- **Top decile, 2 s → 0.6 s:** +0.37 / +0.24 / +0.86.
- **All ranked, 2 s → 1 s:** +0.40 / +0.44 / +0.55.
- **All ranked, 2 s → 0.6 s:** +0.66 / +0.76 / +1.09.
- **From today's estimated 2-4 s path** (10-21 §4) the gains are larger: all ranked 4 s → 1 s is +0.70 / +0.60 / +0.50.

The break-even for $49/month at 60 SOL/month notional is 0.33-0.54 pts (at $250 or $150 per SOL; **estimate**, arithmetic). So for a heavy copier of average wallets, the subscription roughly pays for its own cost in reduced losses. For the top decile it mostly does not. In every case the copier still loses about 8-16 % per trip, and not copying beats both. The money is better spent on the honesty items below. **Do not fund M3 on this evidence.**

Caveats:
- The tape predates 200 ms slots.
- `at` is receive time.
- The evidence is curve-only: no PumpSwap or other AMM leaders.
- Graduated coins are marked at their last curve print.
- 2-6.5 % of pump rows were undecodable.

---

## 8. Recommendations

1. **Show the floor.** Every follower number should sit next to "a copy that does nothing loses -10.8 % at 0.05 SOL and -7.6 % at 0.1 SOL". The best wallets on every tape test at that floor. (S, high; the paper model constants already exist in `shared/copytrade.ts`.)
2. **Fix the Scout fill rule to the curve state.** Trade against the state after the last print before due (any wallet), priced from the tape's post-trade price or reserves, not `native / tokens`, with no "wait for the next print". Score too-fast trips as skipped, as the live engine abandons them. (M, high; `electron/engine/walletScout.ts:330-366, 455-459, 545-558`.)
3. **Rank on the honest model.** STATE-F ranking beats today's 2 s DROP ranking by 1.3-3.2 pts on every pair. Re-derive `RECORDED_POPULATION_MEDIAN_PCT` (`shared/walletScore.ts`) from it. (M, medium.)
4. **Price dead and never-closed trips at the last curve print** instead of calling them unreachable. Never use -100 % for a live curve. It matters most for "avoid" warnings: D9/D10 move by up to 11.6 pts. (S, medium.)
5. **Describe the top of the board honestly.** On September tapes, "least bad" wallets are small-size traders (median first buy 0.01-0.03 SOL) whose trades don't move price. Show the leader's median size beside the user's copy size. (S, medium.)
6. **Don't buy speed.** No Helius prebuild (M3) on this evidence. Keep the free latency fixes. (Decision.)
7. **Replicate on a 200 ms-slot tape (M8) and fix pump V3 decode coverage.** 2-6.5 % of pump rows lack sol and price, which hides leader sells. (M, medium.)

---

## 9. Reproduce

All under `C:\Users\Krypt\AppData\Local\Temp\claude\C--Users-Krypt-Desktop-Krypto-Copy\3421ff98-6701-4574-b1b5-db19809e5c8b\scratchpad\swarm\lag\`:
- `lag.mjs` (model): `node --max-old-space-size=14000 lag.mjs <jul|sep|0916> 300`, about 35 / 21 / 5 min on this machine.
- `summary.mjs`, which writes `out/summary.md`.
- `slots.mjs`, the clock check.
- Raw outputs: `out/{jul,sep,0916}.{json,txt,log}`.

The 09-16 input is the prior swarm's `science/out/trades.csv` and `completes.csv`, reused unchanged. Nothing in the Krypto Copy repo was edited. No network calls or transactions were made.
