# Tape science: exits and negative filters for copies

Angle report, research swarm 2026-10-23. Covers 10-21 M5/M6, H3, H4, H7 (exit discipline as the follower experiences it), and the 10-22 skeptic item S2.16 (missed-sell backstop).

Labels: **measured** (run by me on 2026-10-23, script named), **code** (file:line in `C:\Users\Krypt\Desktop\Krypto Copy`, commit c4f3e1c plus working tree), **estimate**. No vendor or paper claims are made here.

All scripts and raw outputs are in `C:\Users\Krypt\AppData\Local\Temp\claude\C--Users-Krypt-Desktop-Krypto-Copy\3421ff98-6701-4574-b1b5-db19809e5c8b\scratchpad\swarm\exits\`:
- `PREREG.md`: thresholds, written before any test-split run.
- `amm-extract.mjs`: PumpSwap swaps for the 483 pools that migrated during 09-16.
- `exits.mjs`: the simulator. Run as `node --max-old-space-size=6000 exits.mjs P1|P2|P3 out/Px all|quick|std|diag`.
- `summarize.mjs`: the cross-pair tables (`out/summary.md`).
- `classcheck.cjs`: a read-only on-chain check of the curve class.
- Logs: `out/P1.log`, `P2.log`, `P3.log`, `*-std.txt`, `*-diag.txt`, and the JSON for each pair.

---

## 0. Bottom line

1. **Exit rules barely move the follower result. The biggest "exit" gain is a fee effect.**
   - "First leader sell = full exit" beat pure mirroring in every pair: **+1.6 / +2.0 / +2.5 points** of mean per copy at 0.05 SOL, with every CI above 0 (**measured**).
   - With fixed fees removed, the price effect is **−0.5 / +0.2 / +0.2 points** (**measured**, DECOMP rows).
   - So the gain is the sell transactions it saves. A mirrored copy sends 1.27–1.47 sell transactions on average, and each costs 0.002443 SOL. That is 4.9% of a 0.05 SOL copy (**code**: `shared/copytrade.ts:993-996` charges the full sell fee on every slice; `copyTrade.ts:1741` mirrors any slice of 1% or more).
2. **Fixed fees are about half of the follower's loss at 0.05 SOL.**
   - Mirror mean: −16.1 / −29.7 / −14.4% with fees, and −6.9 / −20.9 / −5.1% without (**measured**, the "Δ +8.7 to +9.3" DECOMP rows).
   - Medians for every ≥10-trip leader at 0.05 SOL under paper model 2: **−21.9 / −22.6 / −16.0%**. The shrunk-median top 30% gives **−14.3 / −13.1 / −13.0%** (**measured**, test splits).
   - The 10-21/10-22 line "mirroring both legs loses −4 to −7%" came from a different cost model. It should not be quoted against today's paper model.
3. **Stops cut the tail, not the loss.**
   - A −30% stop (filled at the next print) roughly halves the share of copies losing more than half. Pair by pair (P1 / P2 / P3): 19.3 → 4.8%, 29.4 → 20.8% and 14.2 → 7.0%.
   - It adds +0.5 to +1.9 points of mean, but the median gets 1–2 points worse. With a realistic +2 s fill, half the gain goes (**measured**).
   - TP rungs, graduation exits and long max-holds are within ±0.7 points. A TP rung *hurts* the better leaders (U2: −0.70 [−0.92, −0.50] in P1) (**measured**).
4. **Missed sells: a 30-minute max-hold is the right backstop. 24 h is not a backstop.**
   - Dropping 15% of leader sells costs **−4.2 / −4.6 / −5.5 points** of mean when dead coins are priced at −100%.
   - Mirror plus 30 minutes recovers 40–60% of that: −1.7 / −2.0 / −3.5.
   - Mirror plus 24 h recovers **none of it** in our windows. Coins die long before 24 h (**measured**). This corrects 10-22 skeptic S2.16 ("for example, 24 h").
   - Without any misses, 30 minutes still costs nothing: +0.09 to +0.23 points at last-print marks, +0.45 to +0.78 at −100% (**measured**).
5. **The hoped-for negative filters (H3 crowding, H4 cohort) fail the pre-registered test.**
   - Their sign flips between day-pairs, including within standard curves only. "Crowded" leaders' copies did *better* on 09-16 (+3.4 points [+0.7, +6.2]) (**measured**).
6. **What did hold out of sample:**
   - (a) The shrunk follower median, tested on two new day-pairs. Removed copies were 4.8–30.9 points worse.
   - (b) "Large size" leaders (median first buy ≥ 2 SOL).
   - (c) A new finding: **pump mayhem-mode coins** are 5–27% of copies, and their copy median runs 9–90 points below standard coins (exploratory, not pre-registered).
   - (d) "Creator of a coin", but only when dead coins are priced at −100%.
7. **Two 10-22 warning labels do not replicate.** "Bot" leaders copied as well as or *better than* the rest in all three pairs. "Long holder" flips sign. "Entry curvePct > X" removes *better* copies.

---

## 1. Data and follower model

| Pair | Train → test | Rows | ≥10-trip leaders (U1) | Test copies (reachable) | Notes |
|---|---|---|---|---|---|
| P1 | 2026-07-26 → 07-27 | 5,035,333 curve | 9,881 | 317,067 (313,793) | curve only; 2,399 graduations |
| P2 | 2026-09-10 → 09-11 | 5,340,280 curve | 5,910 | 200,663 (197,143) | curve only; 2,568 graduations |
| P3 | 09-16 H1 → H2 (split 05:19:37 UTC) | 1,273,991 curve + 2,865,710 PumpSwap | 4,372 | 41,387 (41,148) | creator from create events; PumpSwap prints for the 483 pools that migrated in-file |

All **measured** (`exits.mjs` header lines; `amm-extract.mjs`: 9.55M AMM swaps decoded, 483 migrations, 2.4 min over the 8.4 GB raw file).

**Follower model.** This is the prereg in `PREREG.md`; the code is in `simCopy`.
- **Entry.** A copy is a leader's opening buy on a mint, on the curve. The follower enters at the first print at or after the leader's buy + 2,000 ms. If there is none within 10 minutes, the copy is unreachable and excluded. Leader add-on buys are not copied.
- **Exit.**
  - The follower mirrors each leader sell by fraction, at the first print at or after the sell + 2 s.
  - When sells were missed, a later episode's sells on the same (leader, mint) apply to the leftover. This is the "sold hours late" behaviour from the copy-late-exits memory.
- **Costs.** Paper model 2:
  - 1.75% per side (**code**: `shared/copytrade.ts:966-975`);
  - 0.001061 SOL per buy tx and 0.002443 SOL per sell tx (**code**: `shared/exitBudget.ts:163, 234, 242-246`);
  - curve impact from the price-implied virtual SOL.

  The curvePct formula `(sqrt(price·30·1.073e9) − 30)/85` reproduces the tape column with a median error of 0.000 points over 90,395 rows (**measured**). That validates computing curvePct for 09-16.
- **Open at data end.** Marked at the last print (MARK). In the DEAD100 sensitivity, a non-graduated mint with no print in the last 30 minutes counts as −100%.
- **Universes.**
  - U1 = leaders with ≥ 10 closed curve trips in train.
  - U2 = the top 30% of U1 by shrunk follower median, (n·med + 10·pop)/(n + 10), on train.
  - Each leader is capped at 200 copies per split (seeded), so a few bots don't dominate.
- **CIs.**
  - Policy differences use a paired bootstrap clustered by mint.
  - Filter differences use a bootstrap clustered by leader.
  - Both use 200 resamples.

**Proxies, validated.**
- **Creator on 07/09 days.** "First print of a mint is a buy at curvePct < 0.5, more than 10 minutes into the file." Checked against 09-16 create events: recall 52.5%, precision 83.8% (**measured**). So creator-based rules are weaker evidence on P1/P2.
- **Mayhem class.** "A curve print below the standard start price, 30/1.073e9 SOL, before entry." A standard curve can never trade there. An on-chain read of bonding-curve byte 81 (`classcheck.cjs`, one `getMultipleAccounts` to the public RPC) gave:
  - 25 of 25 below-start mints are `is_mayhem_mode = 1`;
  - 7 of 25 standard-priced samples were *also* mayhem.

  So the proxy has high precision and partial recall (**measured**). 15–23% of all tape rows on the 07/09 days are this class (**measured**, awk count). Krypto Copy already parses the flag: `electron/engine/txBuilder.ts:306-336` (`mayhem: d[81] !== 0`), and from the create event at `engine.ts:6440-6448` (**code**). The copy engine has no mayhem reference (grep, **code**).

**Leader sell shape.** The median leader exits a copied position in one sell: 80–86% exactly one, mean 1.27–1.43, 5.9–7.4% with three or more (**measured**). Leaders who never closed in-data: 3.3% / 6.2% / 7.8% of reachable copies (**measured**).

**Survivorship of earlier models.** Earlier models counted only leader-closed trips: −23.3 / −21.4 / −15.7% median. All copies at last-print marks: −21.9 / −22.6 / −16.0%. All copies with dead coins at −100%: −23.4 / −24.3 / −16.9% (**measured**). The sign is mixed under MARK, because P1's open copies include graduated coins marked at the graduation print. The sign is consistent under DEAD100. The prior "closed trips only" numbers were roughly right at the median, but they understate the trimmed mean by up to 2.6 points.

---

## 2. A. Exit-policy counterfactuals (TEST U1, 0.05 SOL, dead coins at last print)

Cells: median / 1%-trimmed mean / share of copies losing > 50% / Δ mean vs mirror [95% CI]. All **measured** (`out/summary.md`).

| Policy | P1 07-27 | P2 09-11 | P3 09-16 H2 |
|---|---|---|---|
| **Mirror (default)** | −21.9 / −19.9 / 19.3% | −22.6 / −32.3 / 29.4% | −16.0 / −16.8 / 14.2% |
| + max-hold 30 min | −21.5 / −19.6 / 18.9% / +0.23 [−0.01, +0.54] | −22.3 / −32.1 / 29.2% / +0.09 [−0.06, +0.22] | −15.8 / −16.7 / 14.1% / +0.14 [+0.02, +0.28] |
| + max-hold 2 h | +0.14 [−0.05, +0.42] | +0.06 [+0.02, +0.09] | −0.01 [−0.14, +0.07] |
| + max-hold 24 h | ±0.00 (never fires in-window) | ±0.00 | ±0.00 |
| **First leader sell = full exit** | −19.3 / −17.4 / 17.5% / **+1.62 [+0.34, +2.68]** | −20.4 / −30.6 / 28.4% / **+1.95 [+1.79, +2.09]** | −14.4 / −14.7 / 12.8% / **+2.46 [+2.13, +2.79]** |
| + TP 50% at +50% | −19.0 / −18.6 / 16.4% / +0.55 [−0.72, +3.09] | +0.00 [−0.27, +0.26] | +0.29 [−0.14, +0.83] |
| + stop −30%, next print | −23.8 / −18.2 / **4.8%** / +1.89 [+1.57, +2.24] | −24.4 / −30.8 / 20.8% / +1.27 [+1.04, +1.49] | −17.1 / −15.9 / 7.0% / +0.47 [−0.05, +0.95] |
| + stop −50%, next print | −22.3 / −19.5 / 20.4% / +0.54 [+0.43, +0.66] | +0.53 [+0.42, +0.64] | +0.23 [−0.23, +0.63] |
| + stop −30%, fill +2 s | −22.9 / −19.2 / 12.9% / +0.86 [+0.56, +1.22] | +0.76 [+0.55, +0.93] | +0.38 [−0.12, +0.86] |
| + dev-sold exit | −21.5 / −19.5 / 18.7% / +0.35 [+0.22, +0.49] | +0.35 [+0.25, +0.46] | +0.56 [+0.21, +0.93] |
| + graduation exit | +0.02 [−0.07, +0.09] | +0.07 [−0.02, +0.14] | +0.38 [−0.23, +0.95] |
| Mirror, ignore leader slices < 25% | +0.55 [−0.62, +1.35] | +0.83 [+0.75, +0.92] | +1.47 [+1.12, +1.86] |
| Mirror, ignore leader slices < 50% | +0.51 [−0.69, +1.60] | +1.29 [+1.12, +1.52] | +1.74 [+1.32, +2.21] |
| First sell full + dev-sold | −18.9 / −17.0 / 17.0% / +1.89 [+0.67, +2.96] | +1.98 [+1.78, +2.14] | +2.52 [+2.08, +3.06] |
| DECOMP: price effect of "first sell full" (no fixed fees, Δ vs mirror with no fixed fees) | **−0.51** | **+0.22** | **+0.17** |

**Sensitivities** (all **measured**, full tables in `out/summary.md`):
- **Dead coins at −100%.**
  - Every own-exit gains a little, because exits run before the coin dies.
  - Max-hold 30 min goes to +0.78 / +0.59 / +0.45, with all CIs above 0.
  - Stop −30% goes to +2.26 / +1.81 / +1.21.
  - Dev-sold goes to +0.45 / +0.57 / +1.30.
  - Rankings don't change.
- **0.1 SOL.** "First sell full" halves to +0.93 / +1.07 / +1.29. That matches a per-transaction fee effect: the fixed fee is half the share of the position. DECOMP gains halve to +4.4 to +4.8.
- **U2, the shrunk top 30%.**
  - Everything shrinks. First-sell-full: +1.33 / +0.72 / +0.44. Stop −30%: +0.70 / +0.62 / +0.07.
  - The TP rung turns negative in two pairs: −0.70 [−0.92, −0.50] and −0.23 [−0.42, −0.05].
  - Better leaders' later sells are worth more than our rung.
- **TRAIN U1 on P3** (in-sample). The pattern is the same: first-sell +2.62, dev-sold +1.29, and graduation +1.40 [+0.60, +2.10]. **The graduation exit's in-sample +1.4 fell to +0.38 (CI spans 0) on test.** It is the one exit that looked better in-sample than held out.

**What this means (estimate, from the above).**
- No exit rule turns copying positive. The best combination, "first sell full + dev-sold", is still −14% median per copy on the best day.
- The exit-side lever that matters is **how many sell transactions a copy pays for**. Mirroring a 10% trim at 0.05 SOL costs 4.9% of the whole position in fees, to sell 10% of it.

---

## 3. A-miss. Missed leader sells (S2.16)

A share of all leader sell events is dropped at random (3 seeds). The table shows the Δ mean vs no-miss mirror, TEST U1, 0.05 SOL. All **measured**.

| Miss rate · policy | P1 MARK | P2 MARK | P3 MARK | P1 DEAD100 | P2 DEAD100 | P3 DEAD100 |
|---|---|---|---|---|---|---|
| 5% · mirror | −0.12 | −0.36 | −0.75 | −1.31 | −1.44 | −1.87 |
| 5% · + 30 min | +0.07 | −0.24 | −0.49 | +0.02 | −0.23 | −0.85 |
| 5% · + 2 h | −0.02 | −0.30 | −0.74 | −0.44 | −0.64 | −1.64 |
| 5% · + 24 h | −0.12 | −0.36 | −0.75 | −1.31 | −1.44 | −1.87 |
| 5% · + stop −50% | +0.45 | +0.27 | −0.33 | −0.17 | −0.20 | −0.92 |
| 15% · mirror | −0.56 | −1.28 | −2.08 | **−4.18** | **−4.58** | **−5.50** |
| 15% · + 30 min | −0.43 | −1.05 | −1.69 | **−1.70** | **−2.02** | **−3.49** |
| 15% · + 2 h | −0.55 | −1.21 | −2.24 | −2.54 | −2.92 | −5.12 |
| 15% · + 24 h | −0.56 | −1.28 | −2.08 | −4.18 | −4.58 | −5.50 |
| 15% · + stop −50% | +0.06 | −0.42 | −1.23 | −2.18 | −2.43 | −3.65 |

At a 15% miss rate, copies still open at data end rise to 21.0% / 22.9% / 17.3% (from 9 / 13 / 7% with no misses, including graduated marks). A 30-minute backstop brings that to 11.9% / 14.0% / 9.1% (**measured**).

**Reading.**
- What a missed sell costs depends on what the bag is worth afterwards. At last-print marks it is small. If those coins die, it is 1.3–1.9 points per 5% of sells missed (**measured**).
- 30 minutes recovers 40–100% of it and never hurts when nothing is missed (§2). 2 h recovers about half as much. 24 h recovers nothing: P1/P2's test days are 24 h and P3's is 5.3 h, and a dead pump coin is dead long before then (**measured** within the window; that it still holds over a longer window is an **estimate**).
- Caveat: real misses cluster in socket gaps (copy-late-exits memory), and a random 5–15% is a stand-in. The miss rate in the live app is **unknown**. The 10-21 doc measured 8–25% feed loss in one night on the public WSS, but that was feed events, not sells, and the copy watcher has `recoverGap` since 09-15.
- The exact fix is not a timer. It is reading the leader's token balance for open copies, as 10-21 #7 proposed, and treating a balance near 0 as a sell. The timer is the fallback that needs no RPC.

---

## 4. B. Negative filters (TEST U1, mirror exits, 0.05 SOL)

Cells: share of copies removed · removed median/mean vs kept median/mean · Δmean (removed − kept) [leader-clustered 95% CI] · share of winning copies hidden. A filter helps when Δ is negative. All **measured**. The full table, including DEAD100, TRAIN and U2, is in `out/summary.md`.

| Filter (PREREG unless EXPL) | P1 | P2 | P3 |
|---|---|---|---|
| H3 crowded leader (≥ 3 shadows on ≥ 30%) | 78% · −23.0/−16.5 vs −18.9/−14.7 · −1.8 [−3.3, +0.5] · 80% | 65% · −16.9/−14.8 vs −82.5/−57.3 · **+42.5** [+38.9, +46.9] · 78% | 73% · −15.5/−13.5 vs −17.5/−16.9 · **+3.4** [+0.7, +6.2] · 74% |
| H3 excess over pre-window | 28% · −2.4 [−5.4, +2.3] | 24% · +20.8 [+18.4, +23.8] | 21% · +1.7 [+0.1, +3.4] |
| H3 real-time (≥ 3 buyers 0.4–1.5 s) | 34% · −3.9 [−6.1, −2.2] | 27% · +18.3 [+16.3, +21.0] | 25% · +1.7 [+0.3, +3.1] |
| H4 cohort partner ≥ 3 mints (400 ms) | 73% · −0.9 [−3.0, +1.6] | 73% · −18.3 [−20.9, −15.6] | 79% · +1.0 [−1.0, +3.0] |
| H4 same slot ≥ 3 mints (P3 only) | — | — | 72% · −1.5 [−3.6, +1.1] |
| Creator of a coin (train) | 5.2% · −21.7/−16.5 vs −21.9/−16.0 · −0.4 [−2.9, +2.2] | 10.3% · −65.9/−48.8 vs −21.2/−27.5 · **−21.3** [−29.0, −12.2] | 5.6% · −23.3/−16.4 vs −15.7/−14.3 · −2.1 [−6.0, +3.0] |
| Bot (median hold < 10 s) | 20% · −16.8/−14.4 vs −23.7/−16.5 · +2.1 [−1.9, +8.6] | 26% · +3.7 [−1.1, +8.2] | 33% · −0.3 [−2.1, +1.6] |
| Long holder (median hold ≥ 5 min) | 8.6% · **+5.3 [+3.5, +6.9]** | 4.6% · −1.8 [−9.6, +5.8] | 3.6% · −2.1 [−6.5, +1.8] |
| **Large size (median first buy ≥ 2 SOL)** | 6.1% · −30.6/−23.7 vs −21.4/−15.6 · −8.1 [−13.8, +2.5] · 4% | 1.9% · −29.6/−34.7 vs −22.4/−29.6 · −5.2 [−15.8, +4.4] · 1% | 1.9% · −23.9/−23.2 vs −15.8/−14.2 · −8.9 [−14.1, −1.7] · 1% |
| **Not in shrunk top 30%** | 64% · −29.2/−18.2 vs −14.3/−12.3 · **−5.9 [−7.7, −3.4]** · 61% | 59% · −39.7/−42.2 vs −13.1/−11.3 · **−30.9 [−33.6, −27.9]** · 53% | 50% · −21.8/−16.8 vs −13.0/−12.0 · **−4.8 [−6.4, −3.1]** · 51% |
| Entry curvePct > 50 | 13% · −14.9 vs −22.8 med · +3.8 [+2.0, +5.0] | 7.8% · +17.1 [+15.4, +19.6] | 9.8% · −1.0 [−4.0, +1.1] |
| Entry curvePct > 70 / > 90 | +4.4 / +5.1 (removed better) | +17.7 / +18.4 | −2.0 / −3.1 |
| Leader is this coin's creator | 0.7% · +5.5 [+1.1, +9.7] | 2.3% · +21.6 [+4.9, +39.2] | 2.7% · −23.3 vs −16.1 med · +8.9 [−4.7, +26.0] |
| Dev sold before our entry | 4.7% · **−6.6 [−8.7, −4.5]** | 13.2% · −2.9 [−7.6, +2.0] | 42% · −0.5 [−1.9, +0.9] |
| EXPL mayhem-class coin | 4.9% · −30.9/−13.5 vs −21.7/−16.2 · +2.7 [−0.1, +5.5] · 7% | 26.7% · −107.0/−70.4 vs −16.4/−14.8 · **−55.6** [−59.8, −50.3] · 18% | 22.0% · −26.8/−16.8 vs −15.0/−13.7 · **−3.1** [−5.8, −0.4] · 28% |
| EXPL leader entry ≤ 10 s after mint's first print | 32% · +0.3 [−3.1, +4.7] | 32% · −10.0 [−12.9, −6.7] | 25% · +2.6 [+1.0, +4.6] |
| EXPL creator OR large OR long holder | 19% · −0.1 [−2.8, +4.0] | 16% · −12.4 [−18.0, −5.6] | 10% · −3.2 [−5.8, +0.3] |

**Pre-registered verdict.** The rule: removed median AND trimmed mean below kept, in every pair, at both sizes, under MARK. Only two filters pass (**measured**, `summary.md` end):
- "not in shrunk top 30%";
- "dev sold before our entry", but by margins under 0.5 points in P2/P3.

The composite "creator OR large OR long" also passes, but it is post hoc. Every H3 and H4 variant fails.

**DEAD100 changes one verdict.** The creator label then holds in all three pairs: −8.5 [−11.0, −6.0], −25.6 [−32.5, −16.9], −12.7 [−20.9, −3.5] (**measured**). Its effect is that the creator's coins die.

**Standard curves only** (mayhem-class copies removed, `out/*-std.txt`, **measured**):
- H3 real-time is −4.1 [−6.6, −1.8], −2.3 [−3.5, −1.0], **+2.3 [+0.6, +3.7]**. It still flips.
- H4 ≥ 3 mints is −0.7, +1.7, +0.8, i.e. nothing.
- Bot leaders copy *better*: +2.1, +3.5 [+1.8, +5.4], +2.0 [+0.2, +4.6].
- Large size stays negative: −8.0 [−14.6, +1.9], −9.5 [−11.9, −6.7], −11.4 [−15.6, −7.2].
- The shrunk gate stays strong: −6.0, −7.4, −5.7.

**H3 descriptive: does the crowded leader sell into the shadows?** Their first sell is faster:
- within 10 s: 36–40% of crowded leaders' copies against 20–31% for the rest;
- median time to first sell: 16–19 s against 24–60 s.

Those 10-second sells are at a higher price than the leader's buy only 50–60% of the time, the same as for uncrowded leaders (**measured**). The mechanism the hypothesis needs, profitably dumping into followers, is not visible at this resolution.

**Overlap.** 1,967 of 3,500 crowded leaders are also cohort-flagged on P3, and 4,016 of 7,592 on P1 (**measured**). H3 partly collapses into H4, as 10-21 asked.

**Why H3 is confounded.** Shadows count *everyone* who buys the coin in the next 3 s, and on pump that measures how busy the coin is. Busy coins die less. The pre-window control (buyers in the 3 s *before* the leader) has the same median as the post-window: 2–3 buyers before, 2–3 after (**measured**). On average there is no excess inflow that follows the leader specifically.

**The P2 anomaly (diagnosed).** On 09-10/11:
- 627–1,151 leaders (18–19% of copies) had a copy median below −60% (**measured**, `P2-diag.txt`).
- 97–99% of their copies are on fresh mints, at a recorded curvePct of 0.0 and a median 0.03 SOL buy.
- 92% of these leaders carry the cohort flag, and their median shadow count is 0.
- 25 of 25 sampled coins of that price class are mayhem-mode on chain (§1).
- This one population makes P2's mirror trimmed mean −32.3 and decides the sign of most P2 filter rows. "Crowded = better" on P2 really means "not a mayhem farm".
- The same class is 22% of P3 copies and 4.9% of P1 copies.

---

## 5. C. The three rules that most cut follower losses, held out

Ranked by held-out effect × consistency. All numbers are **measured** on test splits.

1. **Gate on the shrunk follower median: copy only the top 30% of ≥ 10-trip leaders (already built, 10-22).**
   - The rule now holds on two day-pairs it was never fitted to:
     - removed − kept mean: −5.9 [−7.7, −3.4] (P1), −30.9 [−33.6, −27.9] (P2), −4.8 [−6.4, −3.1] (P3);
     - kept median: −14.3 / −13.1 / −13.0% against a U1 baseline of −21.9 / −22.6 / −16.0%.
   - Cost: it removes 50–64% of copies and hides 51–61% of winning copies. That is about in proportion: it does not "hide most good trips" more than it hides everything else.
   - It stays the strongest single rule.
2. **Fee-aware sell mirroring: on a small copy, the first leader sell exits the whole copy, or slices under 50% are not mirrored.** This is an exit rule, so it hides no trips.
   - "First sell = full" gains +1.62 [+0.34, +2.68], +1.95 [+1.79, +2.09], +2.46 [+2.13, +2.79] at 0.05 SOL, and +0.9 to +1.3 at 0.1 SOL.
   - Combined with the dev-sold exit: +1.89 / +1.98 / +2.52.
   - The price effect is about 0. It is purely fewer 0.0024 SOL sell transactions.
   - Ship it as "below 0.1 SOL a copy, partial sells are merged into one exit", stated in plain words. It is not an edge.
3. **Skip, or warn on, leaders whose median first buy is ≥ 2 SOL ("large size"). Pair it with a mayhem-coin skip as a pending candidate.**
   - Large size removes only 1.9–6.1% of copies and hides 1–4% of winners. Removed medians are 7–9 points worse in all three pairs.
   - Mean Δ: −8.1 [−13.8, +2.5], −5.2 [−15.8, +4.4], −8.9 [−14.1, −1.7]. On standard curves only, two of the three CIs exclude 0.
   - Small population, consistent sign, cheap (the median buy is already in the Scout record).
   - **The mayhem skip has the larger upside** (P2: removes 27% of copies at −55.6 points; P3: 22% at −3.1 [−5.8, −0.4]). It was found *after* looking at P2, and in P1 its mean has the wrong sign (+2.7 [−0.1, +5.5]): mayhem coins have a fat right tail. It must pass a fresh pre-registered pair before it becomes a default skip. A warning chip ("mayhem-mode coin: copies of these lost a median 27–107%") is honest now.

Runner-up: **a 30-minute max-hold as the missed-sell backstop** (§3). It is free when nothing is missed, and under DEAD100 its CIs are above 0 in every pair. It is a safety default, not a loss cutter.

### Looks good in-sample, flips held out

| Rule | In-sample (train) | Held out (test) | Label |
|---|---|---|---|
| H3 crowded leader | P1 −4.4 [−5.4, −3.2], P3 −2.1 [−3.4, −0.9] | P3 **+3.4 [+0.7, +6.2]**; P2 opposite on both | measured |
| H3 real-time shadows | P1 −5.4, P3 −4.5 [−5.1, −3.7] | P3 **+1.7 [+0.3, +3.1]** | measured |
| H3 excess over pre-window | P3 −3.8 [−4.7, −2.9] | P3 **+1.7 [+0.1, +3.4]** | measured |
| Long holder (10-22 "warn") | P1 +3.9, P3 +5.3 (removed better) | P1 +5.3 [+3.5, +6.9]; P3 −2.1 | measured, sign unstable |
| Bot (10-22 "warn", −11.1 vs −9.5) | +3.0 / +4.2 / +0.1 | +2.1 / +3.7 / −0.3 (removed better or equal) | measured, **does not replicate** |
| Graduation exit | P3 train +1.40 [+0.60, +2.10] | P3 test +0.38 [−0.23, +0.95]; P1/P2 +0.02/+0.07 | measured |
| TP rung 50% at +50% | P3 train ±0.00 | U2 P1 **−0.70 [−0.92, −0.50]**, P2 −0.23 | measured |
| "Entry curvePct > X" (skip late entries) | removed worse on P3 train tmean | removed **better** in P1/P2 at every X; P3 mixed | measured, don't build |
| Creator of a coin (10-22 "warn strongly") | P1 train **+3.0 [+1.6, +4.5]** | MARK: P1 −0.4, P3 −2.1 (ns), P2 −21.3. DEAD100: all three negative, CIs exclude 0 | measured: keep the warning, but it is about coins dying |

---

## 6. What the prior docs got wrong or need to change

| Prior claim | Finding | Label |
|---|---|---|
| 10-22 §6: "Mirror sells on: mirroring both legs (−4 to −7%) beat a 60-min hold (−15%)" | Under paper model 2 at 0.05 SOL, mirroring is −16 to −23% median (U1), −13 to −14% (U2). Max-hold 30 min / 2 h on top of mirroring changes it by under 0.3 points. The −4 to −7% was a different cost model, as the 10-22 skeptic (S2.3) already said. These are the replacement numbers. | measured |
| 10-22 skeptic S2.16: "a long max-hold backstop… for example 24 h" | 24 h recovers 0 of the missed-sell loss in our windows; 30 min recovers 40–60% (DEAD100) and is free otherwise | measured |
| 10-22 labels: Bot → warn; Long holder → warn | Bot: copies equal or better in all 3 pairs, including standard-only (+2.0 to +3.5). Long holder: sign flips (P1 +5.3 [+3.5, +6.9]). Neither predicts follower loss. Bot friction can still be justified by reachability and unmodelled slippage, but not by a measured loss. | measured |
| 10-22: Creator → warn strongly (−16.2 vs −9.5) | Replicates on P2 (−65.9 vs −21.2 median), and on all three pairs when dead coins are priced at −100%. Not on P1 at last-print marks. Keep the warning; the evidence is "their coins die". | measured |
| 10-22: Large size → warn, "thin" | Replicates in sign on all three pairs and both strata. Upgrade from thin to consistent; it is still small | measured |
| 10-21 H3 prior 55–60% (relative) | Fails the prereg in all variants; sign flips; confounded by coin activity and the mayhem class | measured |
| 10-21 H4 prior 35–40% | Fails; on standard curves the effect is about 0 | measured |
| 10-21 #4 / breakeven: "fixed fees ≈ 7.0% of a 0.05 SOL round trip" | Per mirrored copy it is about 9.1% (1.43 sell txs on average, each charged in full by `paperExitPnl`); the DECOMP measures +8.7 to +9.3 points | measured + code |
| 10-21 M5: "dev sell / migration exits" as candidates | Dev-sold exit: +0.35 to +0.56, CIs > 0 in all pairs (U1); about 0 for U2. Migration exit: about 0 held out. | measured |

---

## 7. Recommendations

| # | Item | Impact | Effort | Why (evidence) | Files |
|---|---|---|---|---|---|
| 1 | **Fee-aware sell mirroring for small copies.** Below a size where the sell fee exceeds about 2% of the copy (0.002443 SOL ÷ size), the first leader sell exits the whole copy (option: mirror only slices ≥ 50%). Show it in the follow drawer as one sentence. Paper and live get the same rule. | High | S | +1.6 to +2.5 points of mean per copy at 0.05 SOL, every CI > 0; price effect about 0 (measured). Today every 1% slice is mirrored and each pays a full sell fee (code). | `electron/engine/copyTrade.ts:1741, 2146`; `shared/copytrade.ts:993-996` |
| 2 | **30-minute max-hold backstop in every Simple preset**, replacing the 24 h proposal. Exits only, never blocks a sell. Show "closed by backstop, leader sell not seen". | Medium | S | Recovers 40–60% of missed-sell losses (DEAD100). Costs nothing without misses (+0.09 to +0.78). 24 h does nothing (measured). | `shared/copytrade.ts:762-775` (`simpleConfig` sets no exit), `:786-788` |
| 3 | **Leader-balance check for open copies** (the exact missed-sell fix): on the existing sweep, read the leader's token balance for mints we still hold; a balance about 0 is a synthetic full exit labelled "leader balance 0". | Medium–High | M | The missed-sell cost is −1.3 to −1.9 points per 5% of sells missed under DEAD100 (measured). The live miss rate is unknown. Counting `notSwap` and transfer-out (10-21 #7) gives it. | `copyTrade.ts` sweep (`sweepBalances` reads only our balances, per 10-21 skeptic) |
| 4 | **Mayhem-coin warning chip now; a default skip only after a fresh prereg pair.** The flag is already parsed (`txBuilder.ts:336`) on the local buy path. | High in P2-like days | S | Removed medians are 9–90 points worse in all pairs; mean sign flips in P1 (measured, exploratory) | `electron/engine/txBuilder.ts:306-336`; copy filter block near `copyTrade.ts:2770-2795` |
| 5 | **Large-size warning** on the Scout row and in the follow wizard (median first buy ≥ 2 SOL). | Medium | S | Consistent sign, 3/3 pairs; small coverage (measured) | `shared/walletScout.ts` labels; `src/components/copy/WalletTags.tsx` |
| 6 | **Retire the "Bot" and "Long holder" warnings as loss predictors.** If the bot friction stays, word it as reachability ("they are often out before you land"), not loss. | Medium (honesty) | S | Neither replicates (measured) | label rules in `shared/walletScout.ts:402-404` |
| 7 | **Optional own stop, opt-in, labelled "tail control".** A −30% stop halves the share of copies losing > 50%. The median gets worse by 1–2 points; the mean gains +0.5 to +1.9 (half that with a realistic +2 s fill). | Low–Medium | S (exists: `exitStopLossPct`) | measured | `shared/copytrade.ts:240-258`; `copyTrade.ts:3442-3487` |
| 8 | **Don't build:** H3 "farms copiers" flags, H4 cohort exclusion, "entry curvePct > X" skips, TP rungs as a default, a graduation exit as a default | — | — | All fail held out or are about 0 (measured) | — |
| 9 | **The counterfactual exit panel (M6)** should show "fees paid in sell transactions" per follow. That is the largest exit-side number a user can change. | Medium | M | DECOMP: 8.7–9.3 points at 0.05 SOL are fixed fees (measured) | — |

---

## 8. Limits of this study

- **Fill model.** Fixed 2 s lag; next print; no failed or landed-late transactions; no sandwich; no impact of our own buy on later prints. Short holds are the most exposed to all of this (**estimate**: it flatters bot and scalper copies, which is one reason not to read rec. 6 as "bots are good").
- **Curve-only tape on P1/P2.** About 4% of P1 copies are "open-graduated-unmarked" and marked at the graduation print. A leader's PumpSwap sells after migration are invisible there. P3 has the PumpSwap prints, and its graduation-exit result is the trustworthy one.
- **Missed sells are simulated uniformly.** Real misses cluster. The live miss rate is unknown.
- **The 24 h backstop is untestable past the window.** Test windows are 24 h (P1/P2) and 5.3 h (P3).
- **Creator on P1/P2 is a proxy** (52.5% recall, 83.8% precision on 09-16). **Mayhem is a proxy** (25/25 precision on a sample; partial recall).
- **The mayhem and composite filters are exploratory.** They were added after seeing P2, so they need a fresh pre-registered pair. So does every threshold here before it becomes a default (10-21 protocol).
- **The 200-copies-per-leader cap** changes the weighting toward leaders and away from trades. Uncapped results are not computed.
- **Unknown:** whether the app's 12 s orders poll or the firehose gives own-exit prices as fine-grained as "next print". Own-exit checks fire on firehose prints for the mint (`copyTrade.ts:3425`, **code**), so for curve coins it is likely close (**estimate**).
