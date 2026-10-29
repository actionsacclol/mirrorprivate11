# Finding wallets, simple copying, and a power-user layer

Research swarm, 2026-10-22. Six angles: data sources, a competitor survey of wallet discovery, an audit of the hunter (Wallet Scout) and the Discover page, a ranking test on our own tape, a simple mode for beginners, and an advanced layer for power users. This file is the synthesis. Every claim is labelled **measured** (ours, with the date), **code** (read from our source, file:line, Krypto Copy unless it says KB for the old Krypto Bot tree), **vendor** (a company describing its own product, fetched 2026-10-22 unless marked), or **estimate** (our inference). Where something is not known, it says unknown.

It builds on `docs/best-copy-trader-research-2026-10-21.md` and does not repeat it. Items that were built on 10-22 (paper model 2, record from fills, exits after restart, the double mirror) are treated as done.

**Spot-checked by the synthesis lead on 2026-10-22** (code read, not run):

1. The hunter's only Solana input sits behind the disk recorder. `electron/engine/engine.ts:6138` calls `recordTape()` only `if (recorder.wantsTape())`. `scout.note` at `:6370` is inside `recordTape` (defined at `:6353`). `wantsTape()` is `enabled && dir !== ''` (`electron/engine/recorder.ts:55-57`). The EVM rails call `scout.note` with no such gate (`electron/evm/scanner.ts:628, 661`). **Confirmed.**
2. "Trades most days" needs 3 active days (`shared/walletScout.ts:118, 165`), and "Best to copy" turns all five filters on (`src/pages/Discover.tsx:51`). **Confirmed.**
3. A Copy score needs any 3 resolved checks (`SCORE_MIN_RESOLVED = 3`, `shared/walletScore.ts:114, 217`). The follower-return check is not required. **Confirmed.**
4. The wizard and Home suggest from `ranked && !looksAutomated && copyScore !== null` only (`src/components/copy/FollowWizard.tsx:55`, `src/pages/Home.tsx:65`). **Confirmed.**
5. `syncLiveMode()` arms the app whenever `liveEnabled` is on and a wallet exists (`electron/ipc.ts:6152-6160`). **Confirmed.**
6. Copies have no live minimum. `validateConfig` checks only `sizeValue > 0` (`shared/copytrade.ts:834`). `minUnattendedBuySol` (`shared/exitBudget.ts:229`) is called only by scripts (`electron/engine/automation.ts:1463`). **Confirmed.**
7. Two cost models. The Scout prices at 1.5% per side with no fixed fees (`shared/walletScore.ts:37`). Paper charges 1.25% venue + Krypt's fee per side plus fast-lane fixed fees (`shared/copytrade.ts:945-975`). **Confirmed.**
8. The bot rule is a median hold under 10 s **and** 10 or more trips (`shared/walletScout.ts:402-404`). **Confirmed.** The audit cited it as `walletScout.ts`; it is the `shared/` file.
9. The dedupe ring is 40,000 trade ids. Its comment says that "covers well over an hour" (`electron/engine/walletScout.ts:59-67`). Two angles measured 10–20 minutes. **Confirmed that the comment is wrong.**
10. `copyTrade.ts` has no `notify(` call (grep). **Confirmed.**
11. **A citation correction.** The audit's B8/B9 cite `scoutScanSources.ts:277-297` and `:279`, but the file is 195 lines long. The behaviour is real, in other places. The scan lists 3 Discover columns × 40 rows (`electron/engine/scoutScanSources.ts:50`), keeps at most 60 pump mints (`:67`, `SOLANA_SCAN_MAX_TOKENS = 60` at `shared/walletScout.ts:84`), and reads 3 pages each (`:71`, `SOLANA_SCAN_MAX_PAGES = 3` at `shared/walletScout.ts:85`). `recentTrades` stops on the first failed page (`electron/data/providers/pumpswap.ts:123-157`). It returns `complete`, but the `ScanBatch` built at `scoutScanSources.ts:72-89` never carries it, so a truncated read is not marked. This table uses the corrected lines.
12. The Discover reachable cell shows a percentage whenever the value is not null, with no trip floor of its own (`src/pages/Discover.tsx:349`). **Confirmed.**

Not checked by the lead: the PumpSwap decode path at `engine.ts:~5885`, the profile chart (`WalletProfile.tsx:213-217`), and the follower-fill stale branch (`walletScout.ts:262-270`).

---

## 1. Bottom line

1. **The scanner page looks finished, but its default view cannot show a row.**
   - "Best to copy" needs 3 active days. A scan reaches back at most 24 h. In the live record, 0 of 137 wallets had 3 or more active days, and 126 had exactly one (**measured**, 10-22).
   - "Show every wallet" lists 137 rows. Of those, 92 show `0.0000 SOL` instead of a dash. 39 show "Copyable" as a percentage on fewer than 5 trips, and 37 of the 39 read 100% (**measured**).
   - There are 12 toggles before any content. A green score sits next to a green "+0.9%", and that reads as "profitable" (**measured**, screenshots).
2. **The hunter today reads about 0.1–0.8% of the market each hour, and live recording adds nothing.**
   - A 1-hour scan read 618 trades from 27 tokens (**measured**, 10-22). The pump curve alone ran 80k–241k trades an hour on the 09-16 tape, and PumpSwap 550k–1.04M swaps (**measured**).
   - After the first 429, the scan failed on 11 of 27 tokens and still said "27/27" (**measured**, logs).
   - "Record live" ran 6 minutes at 33–69 events/s and added **0 wallets, 0 sightings and 0 trades** (**measured**), because of the recorder gate (spot-check 1).
   - The #1 wallet's record is 11 trips made in 3 minutes 40 seconds (**measured**).
3. **The first fix is one line, and it is the biggest lever.** Calling `scout.note` outside the recorder gate turns a 618-trade scan into the whole curve feed: about 100k trades an hour. After that fix, a one-hour window holds about 40–157 wallets that can honestly be ranked (10 or more copied trips, strict filters) (**measured**, 09-16 tape replay). Cost: nothing extra while the engine already runs, and 1.26 GB/h when it is started only for the Scout (**measured**).
4. **No ranking makes copying profitable.** What the ranking does well is warn.
   - On held-out data, the Copy score's top decile was −6.5% median per copy. The baseline was −9.9%, and the bottom deciles ran from −20% to −38% (**measured**, 09-16 H1→H2).
   - A **shrunk follower median** was the best ranker in every pool: −4.7% [−5.3, −4.2]. Ranking by the leader's own return % was *worse* than baseline (−14.3%).
   - So the scanner's most defensible job is "who not to copy".
5. **The simple path contradicts the board, and the score contradicts the paper.**
   - The wizard recommends wallets the board hides, including one whose every priced copy lost 33–56% (score 63) (**measured**).
   - The profile's "+0.9% per trade" is about −6.6% under the paper cost model at 0.05 SOL (**estimate**, arithmetic on code constants).
   - Creating a wallet arms Live mode for the whole app (spot-check 5).
6. **Simple and advanced can share one engine.**
   - Beginners get 3 onboarding screens, a shortlist, paper first, an automatic review, and one Go-live sheet.
   - Power users get one remembered "Show advanced controls" switch. It opens the existing 37-field config, a sortable Discover table, lists with import, and a replay at their own size.
   - Ten guardrails never turn off. One of them, a live minimum size on copies, does not exist yet and comes first.

---

## 2. What the hunter sees today, and why

### Coverage

| Source | What it reads | Trades per hour | Label |
|---|---|---|---|
| Market, pump curve (09-16 tape, 00–10 UTC) | Every curve trade | 96,627–240,975 | measured |
| Market, PumpSwap (same tape) | Every AMM swap | 776,535–1,041,982 | measured |
| Market, live 10-22 ~12:25 UTC (30–120 s windows) | pump curve; PumpSwap | ~118k–203k; ~682k | measured window, estimate per hour |
| Today's 1-hour scan | 3 swap-api pages for each of 27 pump mints from the Discover columns | 618 | measured |
| "Record live" today | Nothing reaches the Scout unless Settings › Recorder is on | 0 | measured + code |

Two angles give different shares, and both are right. 618 trades is 0.27–0.77% of the curve hour (the science angle's figure) and about 0.1% of curve plus PumpSwap (the sources angle's figure).

**Why the scan is thin (code).**
- It picks coins by Discover column, not by activity (`scoutScanSources.ts:50`).
- It reads at most 300 trades per coin (3 pages × 100, `:71`), and those are the newest. On a busy coin that is only the last slice, so it mostly records short trips.
- swap-api blocks for about 35 s after about 22 rapid calls (memory, **measured** 09-21). The app spaces calls 2 s apart.

**A synthetic scan of the same size reproduces the live board.** On the tape, the 27 most-traded mints × 23 latest trades = 621 trades (at 03:00 UTC). That gave 3 wallets with any closed trip, 0 with 5 or more, and 2 at "reachable 100%" on one trip (**measured**).

**Why "Record live" adds nothing (code).** The button starts the whole Solana engine (`src/pages/Discover.tsx:416-419`). But the Scout's call at `engine.ts:6370` runs only inside `recordTape()`, which needs the disk recorder. The recorder is off by default and was off in this profile. The page meanwhile says "Recording live trades as they happen". Only Solana is affected; Robinhood and BNB feed the Scout directly.

### Record-live versus scan, measured 10-22

| t | events/s | launches seen | wallets on record | sightings | trades today | trips today |
|---|---|---|---|---|---|---|
| before | 0 | 0 | 137 | 149 | 342 | 19 |
| +30 s | 37.9 | 12 | 137 | 149 | 342 | 19 |
| +120 s | 57.7 | 55 | 137 | 149 | 342 | 19 |
| +240 s | 46.8 | 116 | 137 | 149 | 342 | 19 |
| +360 s | 32.6 | 192 | 137 | 149 | 342 | 19 |

The feed carried about 2,800 events a minute, while the scan read 618 trades in an hour. Fixing the gate is worth roughly 100–200 times what a scan reads per hour (**estimate**, audit).

### What the fixed feed would produce (09-16 tape, hourly, from an empty book)

| Figure | Per hour | Label |
|---|---|---|
| Wallets with 5 or more closed trips | 596–2,445 | measured |
| … with 10 or more copied trips | 200–1,011 | measured |
| Strict "followable" (not bot, reachable ≥ 25% of ≥ 5 judged, median hold ≥ 60 s) | 136–490 | measured |
| Strict and 10 or more copied trips | **40–157** | measured |
| Book growth, wallets reaching 5+ curve trips over the day ÷ hours | ~1,150 | measured total ÷ hours |

These measure different things. The last row is how fast the book fills over a day: 12,308 wallets in 10.7 h. The 40–157 row is what one hour alone can honestly rank. Use 40–157 for product promises.

Two cautions:
- The promote-after-3 rule (`walletScout.ts:49`) cuts about 20% of rankable wallets an hour, for example 2,895 → 2,445 (**measured**).
- The strict passers still lose out of sample: −11.3% over the next hour (n 22,389) (**measured**).

### What the book does at scale

- **Size.** 393 B per wallet (54,001 B / 137 wallets in `wallet-scout.json`, **measured**), so 6,000 is 2.4 MB.
- **The cap fills fast.** With the gate fixed, the 6,000-wallet cap is reached in about 5 h (**estimate**).
- **Eviction.** Thin wallets go first (fewer than 5 trips), least recently active first. Today 98% of tracked wallets are thin (**measured**). At the cap this becomes first-in-first-out over thin wallets. A slow human trader is pushed out before reaching 5 trips, so the cap favours high-frequency wallets, the ones a follower can't copy (code + **estimate**).
- **Dedupe.** The 40k-id ring holds about 10–20 minutes of curve trades, and about 3 minutes once PumpSwap is fed too (**estimate**, two angles agree). It is not saved, so a rescan after a restart double-counts (code, `walletScout.ts:59-67`).

---

## 3. Bugs and inconsistencies on Discover and the profile

Severity follows the audit: P1 means the board or the score tells the user something false; P2 is wrong data; P3 is display. The file:line column uses the corrected citations from the spot-checks.

| Sev | Bug | File:line | Fix |
|---|---|---|---|
| P1 | The Solana live feed reaches the Scout only when the disk recorder is on | `electron/engine/engine.ts:6138, 6353, 6370`; `electron/engine/recorder.ts:55-57` | Call `scout.note` for every decoded trade outside `recordTape()`. Add a test with the recorder off |
| P1 | The default view is structurally empty: `regular` needs 3 days, and consistency divides by 7 days even after 7 hours of watching | `shared/walletScout.ts:118, 165`; `electron/engine/walletScout.ts:437, 448`; `shared/walletScore.ts:181` | Track a per-chain `observedSince`. While the record spans less than 3 days, `regular` is unknown and does not hide |
| P1 | A score is issued with no follower return (BwWK1: score 63; 4 priced copies at −46.2%, −32.8%, −45.8%, −56.1%) | `shared/walletScore.ts:208-217` | Score is null until the follower-return check resolves |
| P1 | "Copyable" has two meanings: a 2 s lag in the score, 60 s in the filter and the "fast" count (sssss…: reachable 100%, 91% under a minute) | `electron/engine/walletScout.ts:416, 448, 455`; `shared/walletScore.ts:163-178` | One fact per label, pinned by a test (see §4) |
| P1 | "Read from chain" invents follower prices from the leader's own trades, though its comment says they stay unmeasured | `electron/engine/walletHistory.ts:14-19, 175`; `electron/engine/walletScout.ts:375` | A no-follower mode for chain reads. Trips show "not priced" |
| P1 | The wizard and Home suggest wallets the board hides | `src/components/copy/FollowWizard.tsx:53-55`; `src/pages/Home.tsx:64-65` vs `src/pages/Discover.tsx:51` | Suggestions run the same filters and the shortlist rule (§6) |
| P1 | The profile's green "+0.9%" uses the old cost model; under paper model 2 it is about −6.6% at 0.05 SOL | `shared/walletScore.ts:37` vs `shared/copytrade.ts:945-975` | One cost model, at the user's copy size |
| P2 | Waiting follower fills never go stale when a print arrives; the stale check sits on a branch where it can't be true | `electron/engine/walletScout.ts:262-270` | Check `at − due > 10 min` before filling |
| P2 | The dedupe memory isn't saved, and 40k ids is 10–20 min, not "well over an hour" | `electron/engine/walletScout.ts:59-67, 659-697` | Save a per-mint high-water mark of fed trade time, or the covered time span |
| P2 | After a 429 the remaining tokens return nothing, and the scan still "completes"; the truncated flag is dropped | `electron/engine/scoutScanSources.ts:67-89`; `electron/data/providers/pumpswap.ts:123-157` | Wait out the park, or report "11 of 27 not read". Carry `complete` into the batch |
| P2 | 300 trades per token keeps only the newest slice, so only short trips are recorded | `electron/engine/scoutScanSources.ts:71`; `shared/walletScout.ts:85` | Seek to the window start with the cursor, then page forward |
| P2 | The bot rule misses partial-selling scalpers (BwWK1: 156 trades in 87 s, 6 closed trips, shown as human); after a restart the median is pinned as `[m,m,m,m]` | `shared/walletScout.ts:402-404`; `electron/engine/walletScout.ts:642` | Also flag on trade rate. Keep hold times per window |
| P2 | Win or loss is judged on the last sell, not the whole trip | `electron/engine/walletScout.ts:442-443` | Use `p.realised` |
| P2 | "Coins" counts lifetime coins, including coins only bought, against windowed trips (6 shown, trips on 3) | `electron/engine/walletScout.ts:525`; `shared/walletScore.ts:196` | Count the coins of closed trips per day bucket |
| P2 | "Days active" counts a buy-only day (sssss…: "2 of 7", one day was 3 buys and no sells) | `electron/engine/walletScout.ts:402-406` (day buckets) | Count days with a closed trip |
| P3 | "Copyable" shows a % on fewer than 5 judged trips (39 of 137 rows) | `src/pages/Discover.tsx:349` | Em dash below 5; "low confidence" from 5 to 9 |
| P3 | Profit and volume print 0 instead of a dash (92 of 137 rows) | `src/pages/Discover.tsx:354`; `src/pages/WalletProfile.tsx:327-334` | Dash unless a trip closed |
| P3 | The profit chart is a solid block: x spaced by index, no zero start | `src/pages/WalletProfile.tsx:213-217`; `src/components/kit.tsx:383-389` | Time axis from 0; bars below 3 points |
| P3 | The scan-hours picker and the board's view, window and filters reset on every visit | `src/pages/Discover.tsx:93, 383` | Seed from the last scan; keep the board state |
| P3 | Every 0x profile opens as Robinhood | `src/pages/Discover.tsx:83` | Pass the board's chain |
| P3 | The verdict turns green at 0% or above | `src/pages/WalletProfile.tsx:68-80` | Never green; amber at best |
| P3 | "Copy score 63" above "not enough measured"; "Return" divides by buy volume that includes coins still held | `src/pages/WalletProfile.tsx:82-86, 308`; `shared/walletScout.ts:465` | Goes with the null-score fix; return over closed trips only |
| P3 | "Recorded" counts sightings too (618 read = 618 recorded) | `electron/engine/scoutScan.ts:168` | Count sightings separately |
| P3 | At the cap, each new wallet sorts all 6,000; the sightings map is wiped whole at 60k | `electron/engine/walletScout.ts:385, 467-485` | An LRU list; drop the oldest sightings |
| P3 | The profile hides the record's time span, which is the headline warning for sssss… (3 min 40 s) | `src/pages/WalletProfile.tsx` | Show "all trips within N min" near the score |

**Visual verdict** (from the 10-22 screenshots). The order of the page is upside down:
- The record/scan strip comes first, then 12 toggles (5 views, 4 windows, 3 chains). The board's chain switch repeats the one in the header.
- The empty state says "Widen the window, or loosen the filters", which can't help (P1, `regular`).
- Rows are about 70 px tall, so about 9 fit on screen, all with the same weight.
- On the profile, a green verdict sits over amber warnings, and "Least bad, not an edge" is small muted text at the foot of the page.
- Light mode is readable, but the selected segment and card borders are faint.
- The profile's structure is good.

---

## 4. What the data says about ranking

**Setup** (measured, `E:/data/2026-09-16.jsonl`):
- 10.65 h; 1,273,991 Solana curve trades; 54,790 wallets.
- Split into H1 (00:00–05:20 UTC) and H2 (05:20–10:39).
- The app's own model: 2 s lag, 1.5% per side, medians, and wallet-clustered bootstrap CIs.
- It is one partial day, and activity halved between the halves, so every persistence figure also includes a change of session.
- Slippage, survivorship and lag variance are not modelled. All three flatter the results.

### Persistence (Spearman ρ, H1 vs H2, wallets with 5 or more trips in each half)

| Metric | ρ at k=5 | ρ at k=20 | Use |
|---|---|---|---|
| Median first-buy size | 0.94 | 0.98 | Label |
| Share of trips under 60 s | 0.84 | 0.93 | Label |
| Median hold | 0.83 | 0.90 | Label |
| Reachable % | 0.63 | 0.79 | Persistent, useless as a ranker |
| Own win rate | 0.53 | 0.73 | Persistent, its top decile copies no better than baseline |
| **Follower median return** | **0.48** | 0.49 | Ranking key, noisy |
| **Copy score** | **0.47** | 0.54 | Same signal, adds nothing over follower return + follower win |
| Own PnL (SOL) | 0.42 | 0.49 | Context only |
| Own return % | 0.37 | 0.28 | Weakest, and falls as k grows |

Style is nearly a fixed trait. Outcomes persist only moderately.

### Selections, H1 top decile → H2 follower median per copy

| H1 ranking | H2 median [95% CI] | vs baseline −9.9% |
|---|---|---|
| **Shrunk follower median**, (n·med + 10·popmed)/(n + 10) | **−4.7 [−5.3, −4.2]** | +5.2 pts, CI about 4× tighter than the raw median's |
| 25th percentile of follower returns | −4.8 [−5.6, −4.2] | +5.1 |
| Raw follower median | −6.3 [−8.7, −3.9] | +3.6 |
| Copy score | −6.5 [−8.6, −4.0] | +3.4 |
| Own PnL | −7.5 [−8.7, −6.5] | +2.4 |
| Most trips | −8.6 | +1.3 |
| Reachable % | −9.9 | 0 |
| Own win rate | −10.5 | −0.6 |
| Longest median hold | −14.2 | −4.3 |
| **Own return %** | **−14.3** | **−4.4, worse than baseline** |
| Copy score, **bottom** decile | −20.7 | −10.8 |
| Follower median, **bottom** decile | −38.0 | −28.1 |

Control (b), a random buy held as long as the selection's own copied trips, was −8.5% (**measured**). Mirroring the average active wallet is about 1.4 points worse than buying at random with the same hold.

**Decile 9 beat decile 10 again** (−4.8 vs −6.3). That is the third period running (09-10/11, 07-26/27, 09-16). The extreme top is fitted to its own sample.

### Minimum trips

Split-half reliability of the follower median:

| Trips per half | 3 | 5 | 8 | 10 | 20 | 40 |
|---|---|---|---|---|---|---|
| ρ | 0.31 | 0.35 | 0.42 | 0.40 | 0.45 | 0.55 |

It never reaches 0.7 on this tape, and the gain flattens after about 8–10 trips (**measured**). Reachable share is steadier: 0.44 at 5 trips, 0.57 at 10, 0.70 at 20.

**Decision** (estimate from these numbers):
- **Show** a number at 5 or more trips, tagged "low confidence" from 5 to 9.
- **Rank** in a "best" list only at 10 or more copied trips, sorted on the shrunk median.
- Never call a figure "reliable" below 20.
- Style labels can show from 5 trips.

### Labels

Stability is H1 vs H2 kappa; the outcome is H2 follower median.

| Label (detector) | κ | Labelled vs not | Decision |
|---|---|---|---|
| **Creator of any coin today** | 1.00 | −16.2 vs −9.5 | **Warn**, strongly |
| **Long holder** (median hold ≥ 5 min) | 0.65 | −14.6 vs −9.7 | **Warn** |
| **Large size** (median first buy ≥ 2 SOL) | 0.80 | −13.6 vs −9.8 | **Warn**, thin (120 wallets) |
| **Bot** (engine rule) | 0.61 | −11.1 vs −9.5 | **Warn** |
| Small size (< 0.1 SOL) | 0.87 | −11.3 vs −9.0 | Show, descriptive |
| Scalper (median hold < 60 s) | 0.66 | −9.4 vs −11.7 | Show, descriptive; *better* in absolute terms, possibly an artefact of unmodelled slippage |
| **Sniper** (≥ 50% of known-create trips opened within 10 s) | 0.82 | −9.1 vs −10.2 | **Descriptive only**: not worse here, but its trips are 74% reachable against 88–92% for later entries |
| Bundle (≥ 2 buys in the create slot, not the creator) | 0.80 | −7.3 vs −10.3 | Descriptive only (confounded with short holds) |
| High frequency (≥ 50 trips per half) | 0.39 | — | **Don't show**: a session effect, not a trait |
| Concentrated (≥ 4 trips per coin) | 0.51 | — | Too thin (25 wallets) |

**Two consequences for the current filters** (measured):
- **"Holds over a minute" costs money in absolute terms on this tape.** "Best to copy" without `regular` came to −11.7%, against −8.5% for its sub-minute complement. It still beat its own hold-matched control by 5.6 points.
- **"Too fast" bites under 10 s, not under 60 s.** For 10–60 s holds the follower median barely moved between a 1 s and an 8 s lag (−14.5 → −13.4). For 0–10 s holds, reach collapsed from 82% to 11%.

**Score ≥ 70 favours scalpers by construction.** 913 of the 1,540 wallets scoring ≥ 70 have a median hold under 60 s, and 1,282 are ≥ 90% reachable (**measured**). The live sssss… case, a green headline on a row the default filters hide, is the score and the filter disagreeing by design.

---

## 5. Data-source plan

### Sources, condensed

| Source | Names the trader | Cost / limit | Use |
|---|---|---|---|
| Own engine, pump curve (`logsSubscribe`, api.mainnet-beta) | yes | free; 1.26 GB/h (**measured**); 10 pubsub connections per IP (header) | **Primary**, once the gate is fixed |
| Own engine, PumpSwap | yes | firehose ~7 GB/h (**estimate**, 5.6× the notifications); per-pool subscriptions are cheap | Only for pools where a book wallet holds an open position |
| swap-api `/v2/coins/{mint}/trades` | yes (`userAddress`), covers curve and `pump_amm` | ~22 rapid calls → ~35 s block; app gap 2 s, so ~1,800 calls/h | Scan fallback and follower prints by seek |
| `/home-feed` | yes, with username, X and PnL | 60 per 60 s; one call = 144 rows, 138 wallets (**measured**) | Seed candidates, tagged "Posts callouts" |
| Wallet signatures + `getTransaction` (`electron/engine/walletHistory.ts`) | yes, every rail | free on public RPC, `x-ratelimit-method-limit: 10` (window unknown); ~201 Helius credits per wallet (**estimate**) | Backfill of top candidates |
| Helius `getTransactionsForAddress` | yes | 10 credits per 100 full transactions (**vendor**); free-plan access **unknown** | The biggest lever for users with a key |
| publicnode `logsSubscribe` | — | delivered **0** pump/PumpSwap/Raydium logs on 10-22 while delivering LaunchLab and DBC (**measured**) | Investigate; it is listed as a free extra feed (`shared/types.ts:1105`) |
| LaunchLab / DBC / Raydium logs | **no**, needs a `getTransaction` per trade | low volume | Not now |
| GMGN, Kolscan, Birdeye, Cielo, Bitquery, Dune, Solscan Pro | — | no public API (GMGN, Kolscan); key-gated or paid (Birdeye Standard 1 rps "Limited", Starter $99; Solscan $49; Bitquery one-month trial) (**vendor**) | Never a score: they rank by the leader's own PnL. Hand-checked seeds at most |

### Recommended architecture

1. **Live first.** Whenever the engine runs, every decoded pump trade goes to `scout.note` (fix B1).
   - For users who don't trade on Solana, add an opt-in **Scout-only recorder**: one socket, decode, `note()` only. Its switch states the cost: "About 1.3 GB downloaded per hour while open."
   - PumpSwap swaps already decoded by the engine (`engine.ts:~5885`, not spot-checked) feed `scout.note` **only for wallets already in the book**. That closes trips that cross graduation without a firehose.
2. **"Find wallets" replaces "Scan".** It has three stages with a visible budget and an ETA.
   - **Stage 1, pick coins by activity, not by column.** About 120 coins × 1 page at the 2 s gap is about 4 minutes and about 12k trades (**estimate**). That is about 20× today's scan, and still only 5–15% of a curve hour. This is the fallback when the live feed was off, not the main source.
   - **Stage 2, rank candidates with no calls.**
     - Keep wallets seen on 3 or more coins with both buys and sells.
     - Drop wallets with 500 or more trades an hour.
     - Add `/home-feed` callers and pasted or saved wallets, scored the same way as everyone else.
   - **Stage 3, backfill the top N with `walletHistory`.**
     - Paginate to 7 days or 300 trades, not a fixed 200 signatures.
     - Fill **follower prints** with one swap-api seek per trip (cursor `'0'.repeat(22)+'-'+(openedAt+2000)`). Backfilled wallets then get a measured Copy score instead of the invented one (P1, chain reads).
     - N is 10–20 on public RPC and 100–300 with a Helius key (**estimate**). The page says so: "Read 18 of 40 candidates — add a Helius key to read more."
3. **Two books.**
   - A candidates book of up to 50k rows of about 150 B each, tagged by source (feed, scan, callout, pasted).
   - The scored book: today's, raised to 6–20k.
   - Sightings rise from 60k to 200k counters, about 8 MB (**estimate**).
   - Past about 10k scored wallets, move off the whole-file JSON rewrite (**estimate**).
4. **Replay-safe dedupe.** Record which time spans the live feed covered, and have a scan skip them. Save it across restarts.

### Expected wallets scored per hour (5 or more closed trips)

| Design | Per hour | Label |
|---|---|---|
| A. Today's scan | ~0–5; "Best to copy" empty | measured |
| B. Live curve feed (gate fixed) | ~1,150 book growth; 40–157 honestly rankable in one hour | measured tape; loss to promote rule and cap timing estimated |
| C. B + PumpSwap firehose | +~2,600 (~2,100 non-bot, slow) | measured tape; ~7 GB/h, so **not a default** |
| C'. B + per-pool PumpSwap for book wallets | B plus trips that graduate | share **unknown** |
| D. Keyless "Find wallets", stages 1–2 | ~10–40 per run (~50–200 candidates) | estimate |
| E. D + public-RPC backfill | ~20–60, with a Copy score | estimate |
| F. D + free Helius key | 180–600 rate; ~5k a month on 1M credits; ~47k a month if `getTransactionsForAddress` is free | vendor prices + estimate; free access unknown |
| G. Helius Developer ($49/mo) | ~50k a month on standard RPC, ~470k with `getTransactionsForAddress` | vendor |

The keyless ceiling on **follower-scored** wallets is swap-api's 2 s gap: about 1,800 calls an hour, so roughly 180–360 wallets an hour (**estimate**).

---

## 6. Simple mode

Simple is the default. Every screen uses the same engine and the same `simpleConfig` (the 09-20 Copy Simple rule).

**Clicks** (code-traced, not timed with users):

| Goal | Today | Proposed |
|---|---|---|
| Install → 3-wallet shortlist on paper | about 25 | 5 |
| Paper → live, wallet created and funded | about 16 | 7 |

Funding happens outside the app in both cases.

### Screens

| Screen | What it does | Key sentence |
|---|---|---|
| **S1 Onboarding: 3 screens, not 6** | Language, Terms, then Start: pick a preset, plus an optional collapsed referral field. The live feed and a 1-hour "Find wallets" run in the background while the user reads the terms. API keys and pump.fun leave onboarding. Fix the stale "Find wallets" text and the Krypto Bot video link (`src/components/Onboarding.tsx:52, 614, 652`). "Start following" opens the wizard (`:667`). Remove the line saying a wallet turns Live on (`:572`) together with the auto-arm. | "We measured 9.3 million trades. On average, copying memecoin wallets lost money, even copying the best-ranked tenth. This app shows what copying would really have kept, on paper first, so you see the cost before you spend anything." |
| **S2 Home: one card whose state decides what it shows** | Building the shortlist ("Watching live · 2 h of data · 412 wallets") → nobody qualifies yet → shortlist ready ("Follow these 3 on paper") → paper trial ("7 of 20 closed") → review ready → live, with paper and live shown side by side, never added together. No fallback to "Most profitable". | "Nobody passes yet. We've watched for 2 hours; a fair record needs at least 10 copied trades. Here are the 3 closest, and what each is missing." |
| **S3 Shortlist rule** | The same filters as "Best to copy". `regular` is unknown while the record spans less than 3 days, and the row says "thin". At least 10 copied trips, ranked on the shrunk follower median. Take 3 from the top group, not #1 alone. No creators, bots or bottom-three-decile wallets. | "Ranked by what you'd have kept, not what they made." |
| **S4 Wallet page** | The headline is shown at the user's size with paper costs, next to its sample count, typical hold, record span, and a Low/Medium/High confidence chip. No green anywhere. Histograms and the score breakdown are folded away. For an unknown wallet, "Read from chain" is the main button. | "At 0.1 SOL a copy, copying them would have kept −3.1% per copy, over 14 trades in 2 days." (example figures) |
| **S5 Automatic paper review** | At 20 closed copies and at least 2 days. What you kept, what they made, the gap, the fee breakdown, and the spread of results. | "The gap between what they made and what you'd have kept is what copying costs: arriving 2 seconds late, and fees. 50 copies say more than 20." |
| **S6 Go live: one sheet** | Wallet, a required backup, funding detection, and Arm with one confirm. It offers to raise `maxLiveSol` to the preset size, with a sentence saying so. It replaces the top-bar switch, the card's Live segment and Arm (`src/pages/Following.tsx:96-116`, `src/components/TopNav.tsx:96-108`). | "Each copy spends real SOL: 0.1 SOL a copy, at most 4 open, paused for the day after losing 0.3 SOL. Only put in what you'd be fine losing entirely." |
| **S7 Following** | One row per wallet with Pause and Stop following. Stop asks "Stop and keep managing exits" or "Stop and sell now". The preset is set for the whole page. | — |
| **S8 Activity** | Plain sentences, including a reason for every leader trade that was not copied ("market cap above your max", "too late: 9 s behind"). | — |
| **S9 Hidden in Simple** | Discover's other views, filters, window picker, Compare and the data controls (behind a "Data" button). The top-bar master switch becomes a status pill. API keys, pump.fun, Reverse, FOMO and the config editor are hidden. | — |
| **S10 Notifications** | Through `engine.notify` (desktop + paired read-only bots): shortlist ready, first copy, review ready, daily summary, live fills, daily stop, wallet stop, "now too fast to copy", quiet wallet, failed sells. Only errors pop; capped at 6 an hour. | — |

### Defaults

| | Careful | **Balanced (default)** | Active |
|---|---|---|---|
| Size per copy | 0.05 SOL | **0.1 SOL** | 0.25 SOL |
| Fixed fees as a share of the copy | 7.0% | 3.5% | 1.4% |
| Max open (all follows) | 3 | 4 | 6 |
| Daily stop | −0.15 SOL | −0.3 SOL | −0.75 SOL |
| Per-wallet stop (auto-pause) | −0.2 SOL | −0.4 SOL | −1.0 SOL |
| Suggested bankroll (shown, not enforced) | 1 SOL | 2 SOL | 5 SOL |
| Copies per day | 10 | 20 | 40 |

All three presets mirror sells and leave their own take-profit and stop-loss off.

**Why these numbers:**
- **Size.** Fixed fees are 0.0035 SOL per round trip on the fast lane (code). The best follower decile is still about −4% median (measured).
- **Daily stop at 3×, not today's 10×** (`SIMPLE_LOSS_MULTIPLE`, `shared/copytrade.ts:737`). A median mirrored copy loses 4–7%, so 20 copies cost about 1–1.4 sizes on an ordinary day (estimate). A 3× stop trips on bad days, not normal ones.
- **Mirror sells on.** Mirroring both legs (−4 to −7%) beat a 60-minute hold (−15%) (measured).
- **Max open and the per-wallet stop.** Neither field exists today; both are engine work (roadmap #13).

---

## 7. Advanced mode

### Placement

- **One app-wide switch, "Show advanced controls", in Settings › General, off by default.** It is stored per profile in settings, not in `localStorage`.
- The "Advanced" toggles in the Discover and Following headers flip the same setting.
- **Advanced never adds a second editor or a second store.** If beginners need a setting, change `simpleConfig`.
- With Advanced off, the edit drawer still shows sections 3–6 as read-only summary lines ("Entry filters · 4 on"). Nothing that changes behaviour is ever invisible. This answers GMGN's documented problem of hidden filters silently blocking copies (**vendor**).

### Capability matrix (condensed)

| Capability | Engine has it | KC UI today | Placement |
|---|---|---|---|
| All 37 `CopyConfig` fields (`shared/copytrade.ts:87-202`) | yes | yes, old KB-styled flat grid (`src/components/copy/ConfigEditor.tsx:197-570`) | Edit drawer rebuilt in the kit: Basics, Exits, Entry filters, Limits, Execution, Direction |
| Active filters visible on the card | — | **no**: 9 rules shown; blocklists, buy-once and age bands are missing (`src/pages/Following.tsx:350-360`) | A chip for every non-default rule, generated from the config |
| Directions: copy / reverse / FOMO | yes | yes, under "More ways to follow" | Advanced › New follow, measured warnings kept on the form |
| Watch-only follow with alerts | **no** | no | **Simple** too: a "Just watch" choice in the wizard |
| Execution lane, MEV mode, Jito, Sender | global settings only; copies always use the fast lane (`electron/engine/engine.ts:2266`) | no | Advanced › Execution, per follow; paper charged at that lane |
| Auto-pause after failed copies | no | no | Always on after 3 failed copies; optional after N losing copies |
| Discover: sort any column, all 7 sorts, range filters, column chooser, saved searches, CSV | data in `ScoutRow` (25 fields) | 5 views, 5 switches, no click-sort (`src/pages/Discover.tsx:46-75, 195`) | Advanced Discover table; unknowns export as empty cells, never 0 |
| Lists, labels separate from following, import/export (`[{address,name,emoji}]` JSON and CSV) | Saved + Watchlist stores | partial | Discover › Lists; imports land as watch or paper only |
| "Who bought this early" (token → wallets) | `launchIntel` over IPC, unused (`electron/preload.ts:507`) | no | Advanced Discover |
| Funder view | `holderGraph.ts`, over IPC (`electron/preload.ts:510`) | no | Profile, on demand, call count on the button |
| Wallet checks: tokens transferred in, sold more than bought, in and out within 10 s | partly (`src/components/WalletTags.tsx:8-14`) | partly | Profile, each with its denominator |
| "Try it at your size" replay with a lag picker (1/2/5/10 s) | no; the score is fixed at 2 s and 1.5% (`shared/walletScore.ts:30, 37`); 12 recent trips stored (`walletScout.ts:69`) | no | Profile; no competitor found that ships one (**vendor** survey) |
| Following sort, reset a wallet's record, Scout "Start over" | `rankLeaders` (`shared/copytrade.ts:688, 707`), `copy:resetStats` (`electron/ipc.ts:5890`), `scout:clear` (`:2173`) | no (KB had them) | Card menu and Following header |
| Latency panel incl. slot gap | yes | yes (`src/pages/Following.tsx:240`) | Advanced only; Simple sees one line |

**Not in Krypto Copy** (§8, Don't build): the spaced multi-wallet Copier, Scripts, and copying on unconfirmed data.

### Guardrails that never turn off

1. New follows start on paper. Switching to Live disarms the follow, and arming asks first, with the measured-loss sentence (`src/pages/Following.tsx:76-95`).
2. The live per-trade cap `maxLiveSol` refuses any automatic copy above it. The refusal is recorded; the size is never clamped (`electron/engine/copyTrade.ts:2893-2900`).
3. **A live minimum size on copies** (`minUnattendedBuySol` for the follow's lane: 0.03 SOL fast, 0.0025 SOL lean). **Not built yet** (spot-check 6).
4. A daily loss limit above 0 is required (`shared/copytrade.ts:848`). The copies-per-minute limit always applies.
5. Breakers block buys, never sells. Exits are managed whether or not a follow is enabled. After a restart, live entries stay disarmed. Exits fire exactly once.
6. A filter that can't read a fact fails closed, and the unknown shows as an em dash.
7. The fee interlock and referral rules are untouched.
8. Paper charges what the chosen lane costs (`paperFixedFeeSol(lane, side)`).
9. Imported or bulk-created follows are paper or watch-only.
10. Friction where the danger is measured. Following a wallet with a median hold under 10 s needs a typed confirmation ("I understand I land after them"). A wallet with a 10–60 s median hold gets a plain warning. A wallet flagged Creator or Bot gets the warning in Simple too.

---

## 8. Ranked roadmap

Impact is what the user ends up with (an honest board, money not lost to our own bugs), not engagement. Effort: S = days, M = 1–2 weeks, L = several weeks.

### Build now

| # | Item | Impact | Effort | Risk | Evidence | How we'd know it worked |
|---|---|---|---|---|---|---|
| 1 | **Feed the Scout outside the recorder gate.** Every decoded pump trade calls `scout.note`. `electron/engine/engine.ts:6138, 6353-6370` | Critical: 0 → ~100k trades/h | S | The 6k cap fills in ~5 h; ship with #2 and #9 | code (spot-check 1); measured 0 in 6 min | Test with the recorder off: a decoded trade reaches the book. One hour of recording adds hundreds of wallets |
| 2 | **Replay-safe, saved dedupe** (covered time spans or a per-mint high-water mark). `electron/engine/walletScout.ts:59-67, 659-697` | High: no double-counted trips | S | Low | code; ring measured at 10–20 min | Record 1 h, restart, scan the same hour: trips unchanged |
| 3 | **Score honesty.** No score without a follower return. One fact per "copyable" label. Chain reads never price copies. Em dash and "low confidence" under 5 / 5–9 trips. Dashes, not 0. The verdict is never green. `shared/walletScore.ts:163-217`; `electron/engine/walletScout.ts:416, 448, 455`; `electron/engine/walletHistory.ts:14-19, 175`; `src/pages/Discover.tsx:349, 354`; `src/pages/WalletProfile.tsx:68-86, 327-334` | High | S | Fewer wallets have a score. That is the point | measured BwWK1 / sssss…; science §5E | Tests: no row has a score with a dash for copier/trade; no row under 5 trips shows a %; reachable ≤ 100 − (sub-2 s share) |
| 4 | **Observed-span window.** `regular` is unknown until the record spans 3 days; consistency divides by the observed span. `shared/walletScout.ts:118, 165`; `electron/engine/walletScout.ts:437, 448`; `shared/walletScore.ts:181` | High: "Best to copy" can show rows | S | Thin records look better; mitigated by #6's floor | code (spot-check 2); measured 0/137 | After one live hour, Best is non-empty or shows "watched N h, needs 10 copied trades" |
| 5 | **One cost model at the user's size** for the Scout, the profile and the wizard. `shared/walletScore.ts:37` → `shared/copytrade.ts:945-975` | High: the headline matches paper | M | Every number on the board drops; old screenshots disagree | code (spot-check 7) | Scout and paper agree within 0.5 points on a replayed day |
| 6 | **Rank "best" on a shrunk follower median** (k=10 toward the population median). Rank floor of 10 copied trips. Demote own return % out of the default sorts. `shared/walletScore.ts`; `shared/walletScout.ts:58`; `src/pages/Discover.tsx:46-75` | High | S | One tape only; thresholds are not frozen until M8 | measured: −4.7 [−5.3, −4.2] vs −6.5 [−8.6, −4.0] | Re-run `persist.mjs` on each new tape day; shrunk top decile ≥ Copy-score top decile |
| 7 | **Suggestions obey the board.** Wizard and Home use the §6 S3 rule. `src/components/copy/FollowWizard.tsx:53-55`; `src/pages/Home.tsx:64-65` | High | S | The suggestion list is often empty, so it needs #8's text | code (spot-check 4); measured wizard-who.png | Test: no suggestion fails a default board filter |
| 8 | **Honest empty board and status line.** "Watching live · N h · M wallets", per-filter counts ("Trades most days hid 134"), and the 3 closest wallets with what each is missing. Data controls behind one button. Board state remembered. `src/pages/Discover.tsx:93, 383`; `src/pages/Home.tsx` | High | S | Low | measured 0 rows with no explanation | No Discover visit ends on a blank board without a reason |
| 9 | **Bot rule on trade rate, and eviction by LRU.** `shared/walletScout.ts:402-404`; `electron/engine/walletScout.ts:385, 467-485, 642` | Medium–High after #1 | S | Labels a fast human a bot; show the rule in a tooltip | measured BwWK1: 156 trades in 87 s, unflagged | BwWK1-type wallets flagged. At the cap, ranked wallets keep growing |
| 10 | **Warning labels:** Creator/dev (strong), Long holder, Large size, Bot; Sniper and Bundle descriptive only; a bottom-three-decile badge. Every tag carries its rule in a tooltip, pinned by a test. `src/components/WalletTags.tsx:8-14`; `shared/walletScout.ts` | High: "who not to copy" is the measured value | M | One tape; sign could flip on another day | measured: κ ≥ 0.6; creator −16.2 vs −9.5; bottom deciles −20 to −38% | Re-measured on a second tape: same sign, κ ≥ 0.6. A test fails if a threshold changes without its text |
| 11 | **Scan honesty.** Wait out the park or report "N of M not read". Carry `complete`. Seek to the window start, then page forward. `electron/engine/scoutScanSources.ts:67-89`; `electron/data/providers/pumpswap.ts:123-157` | Medium | M | Scans take longer | measured: 11 of 27 lost after one 429 | Tokens read = tokens listed, or the gap is shown |
| 12 | **Live minimum size on copies**, per lane; the editor shows the fee share. `shared/copytrade.ts:834`; `electron/engine/copyTrade.ts` (the live buy gate near `:2893`); `shared/exitBudget.ts:229` | High: stops fee-eaten live copies | S | Existing 0.01 SOL live follows start refusing; say why on the card | code (spot-check 6) | Test: a live 0.01 SOL copy is refused with the reason |
| 13 | **No auto-arm on wallet creation; presets with max-open and per-wallet stop.** `electron/ipc.ts:6152-6160`; `src/components/Onboarding.tsx:572`; `shared/copytrade.ts:733-737`; `electron/engine/copyTrade.ts` | High | M | Users who expect Live after creating a wallet; the Go-live sheet covers it | code (spot-check 5); simple §4 | A new wallet leaves the top bar on Paper. Test: max-open holds; auto-pause events are logged |
| 14 | **Skip reasons on Activity, copy notifications, and auto-pause after 3 failed copies.** `electron/engine/copyTrade.ts`; `src/pages/Activity.tsx`; via `engine.notify` | High | M | Notification noise; cap at 6/h, only errors pop | code (spot-check 10); GMGN pauses after 3 failures (vendor) | Every leader trade in the watcher log has a copy row or a reason row. Test pinned for auto-pause |
| 15 | **Simple mode screens S1–S8** (3-screen onboarding, the Home card, the review at 20, the one-sheet Go live). `src/components/Onboarding.tsx`; `src/pages/Home.tsx`; `src/pages/Following.tsx:96-116`; `src/components/TopNav.tsx:96-108` | High | M | Raising `maxLiveSol` from the sheet must keep its own confirmation | simple angle click trace | e2e: install → 3 paper follows in ≤ 5 clicks; paper → live in ≤ 7 |
| 16 | **Advanced switch, kit-rebuilt `ConfigEditor` with summary lines, and rule chips on cards.** `src/components/copy/ConfigEditor.tsx:197-570`; `src/pages/Following.tsx:350-360`; settings store | High: set rules become visible | M | Low | code | e2e: every non-default field appears as a chip |
| 17 | **Feed already-decoded PumpSwap swaps to `scout.note` for wallets in the book.** `electron/engine/engine.ts:~5885` (`onAmmLogs`) | Medium–High: trips that cross graduation close | S | More writes per second; book wallets only | measured: 24,381 of 27,642 AMM wallets with 5+ trips hold ≥ 60 s; code not spot-checked | Fewer "no-exit" trips per day |
| 18 | **Display fixes:** profit chart on a time axis, 0x profiles open on the board's chain, sightings counted apart, record span on the profile. `src/pages/WalletProfile.tsx:213-217`; `src/components/kit.tsx:383-389`; `src/pages/Discover.tsx:83`; `electron/engine/scoutScan.ts:168` | Low–Medium | S | Low | measured screenshots | e2e screenshot shows bars; sssss… shows "all trips within 4 min" |

### Measure first (don't ship as a default until the number is in)

| # | Item | Impact | Effort | Risk | Evidence | How we'd know it worked |
|---|---|---|---|---|---|---|
| M1 | **"Find wallets" by activity** (~120 coins × 1 page) instead of the Discover columns. `electron/engine/scoutScanSources.ts:45-71` | High when the feed was off | S | swap-api's burst block while Discover traffic runs (header read 776 of 1000 mid-test) | estimate: ~12k trades per run | ≥ 10k trades per 1-h run with no 429 |
| M2 | **Wallet-first backfill + follower prints by seek** (7 days / 300 trades; one swap-api seek per trip). `electron/engine/walletHistory.ts`; `electron/data/providers/pumpswap.ts` | High: a measured Copy score for pasted, seeded and backfilled wallets | M | The seek price may differ from the live-recorded price | memory: pump swap-api seek; code `walletHistory.ts:14-19` | On an overlap sample, the backfilled score matches the live-recorded score |
| M3 | **Opt-in Scout-only recorder**, cost stated (1.3 GB/h). `src/pages/Discover.tsx:414-421`; `electron/engine/engine.ts` | Medium–High for opt-in users | M | CPU, RAM, metered connections | measured bandwidth | Wallets per hour; CPU and RAM while recording; opt-in rate counted locally |
| M4 | **Two-tier book** (50k candidates / 6–20k scored), promotion rule, off whole-file JSON. `electron/engine/walletScout.ts:45-70` | Medium | M | Promoting at 5 trips throws away the first trades unless candidates keep positions; the promote-after-3 rule already costs ~20% of rankable wallets | measured 393 B per wallet; science §5B | Cap messages rare; persist < 50 ms; rankable wallets per hour not lower than today's rule |
| M5 | **"Try it at your size" replay** with a lag picker. Profile; `shared/walletScore.ts`; `electron/engine/walletHistory.ts` | High and unique | M–L | A 30-trip replay is ~1–2 min of swap-api calls (estimate) | no competitor found (vendor) | Replay at 2 s matches the stored score on the same trips, within noise; then replay vs the first week of paper |
| M6 | **Helius key raises backfill depth and N**, with a credit estimate before the run. Settings; `electron/engine/walletHistory.ts` | Medium for power users | S | Free-plan `getTransactionsForAddress` access is unknown | vendor credit table | Credits used within 20% of the estimate |
| M7 | **Change "too fast" to 10–15 s and recast "Holds over a minute" as a robustness choice.** `shared/walletScout.ts:113-145`; `electron/engine/walletScout.ts:455` | Medium | S | Slippage and lag variance are unmodelled, and short holds are the most exposed | measured lag curve; 60 s filter −11.7 vs −8.5 | A replay with slippage and lag jitter keeps the sub-minute advantage; if not, keep 60 s |
| M8 | **Replicate the ranking test on 3 or more full tape days, both sessions**, before freezing #6 and #10 thresholds | High | M | — | one 10.65 h tape with a session change | Same signs, ρ within ±0.1 across days |
| M9 | **Loss tail and concentration on the card** (share of coins lost > 50%; share of profit from the best coin) | Medium | M | May not predict the follower result | GMGN weights stop-loss discipline 34% (vendor); unmeasured by us | In the next replay, they predict H2 follower return beyond the shrunk median |
| M10 | **Per-follow execution lane** (fast/lean), MEV mode, with the fee share at size. `electron/engine/engine.ts:2266`; ConfigEditor Execution section | Medium | M | Lean-lane copy latency is unmeasured | code; lean halved script fee losses (memory) | Paper-vs-live gap on lean follows ≈ 0; slot gap per lane on the latency panel |
| M11 | **"Who bought this early" and the funder view.** `electron/preload.ts:507, 510`; `electron/engine/holderGraph.ts` | Medium / Low–Medium | M | swap-api bursts; free RPCs refuse holder lookups (memory) | GMGN Wallet Radar, Nansen First Funder (vendor) | Follows that start here have a copier result no worse than follows from the board |
| M12 | **Why publicnode delivered 0 pump/PumpSwap logs.** `shared/types.ts:1105`; the feed race in `electron/engine/engine.ts` | Medium: feed coverage beyond the Scout | S | — | measured 10-22 | Both sockets deliver in a two-host race, or publicnode is dropped from the pump feed |
| M13 | **Lists + GMGN-compatible import/export**, imports as watch or paper only. Saved and Watchlist merged without losing an entry | Medium–High | S–M | Migration of two stores | vendor: GMGN `{address,name,emoji}`, 2,000 cap | A GMGN export imports with nothing lost (fixture); zero live configs from imports |
| M14 | **Discover power table** (click-sort, all 7 sorts, ranges, column chooser, saved searches, CSV). `src/pages/Discover.tsx:46-75, 195` | High for power users | M | Lets users sort by own return %, which measured worse than baseline; that sort carries a note | code | e2e on fixture rows; CSV round-trips with unknowns blank |
| M15 | **"Trades like this one"** (overlap score) | Unknown | L | When followed wallets converge on a coin, follower results get worse (measured, 09-14) | — | Held-out: similar wallets' follower returns correlate. If not, drop it |

M13 and M14 are low-risk builds. They are under Measure first only because they should follow #3–#6: a power table over today's numbers would sort false figures faster.

### Don't build

| # | Item | Why | Evidence |
|---|---|---|---|
| D1 | A PumpSwap firehose as a default | ~7 GB/h on a mass-market desktop; repeat connections refused after one run | estimate from measured notification ratio; measured refusals |
| D2 | Third-party boards (GMGN, Kolscan, Birdeye, Cielo, Bitquery, Dune) as a score | Key-gated or no API, ToS risk, and they rank by leader PnL | vendor |
| D3 | Own return % or own PnL as a default sort or "top" view | Own return % top decile −14.3%, worse than baseline | measured |
| D4 | "Sniper = bad" as a predictive warning | Not worse on this tape; confounded with hold | measured |
| D5 | The spaced multi-wallet Copier, Scripts and copying on unconfirmed data in Krypto Copy | Read as wash trading; a 2,408-line surface; phantom and duplicate fills against exactly-once | code; vendor (GMGN Lightning docs) |
| D6 | DBC / LaunchLab / Raydium trader decoding for the Scout | Trader not in logs; low volume. Revisit only if those rails exceed 10% of followed-wallet trades | measured counts |
| D7 | Copier count and AUM on cards | No copier population; a popularity number that can be gamed | estimate |
| D8 | Any claim that "only we grade the follower side" | GMGN's open-source skill now has an assumed-drift copy-tradeability score (commit 2026-10-15). Say "from trade-level replay" instead | vendor |

---

## 9. Conflicts between angles and open questions

### Conflicts and how they were resolved

1. **Does "Record live" feed the hunter?** The sources angle said curve trades reach the Scout when it is on. The audit measured 0 in 6 minutes. **Resolved: the audit is right.** The code gates `scout.note` on the disk recorder (spot-check 1). The sources angle's design-B numbers describe the state after fix #1.
2. **How many wallets an hour after the fix?** Three figures: ~1,150/h (sources: day total ÷ hours), 40–157/h strict and rankable (science: hourly from an empty book), 100–200× the scan (audit, estimate). **Resolved: they measure different things.** Product text uses 40–157 for "rankable in one hour". ~1,150/h is book growth.
3. **The 60 s floor.** The competitor and simple angles want friction under 60 s. The science angle measured that reach collapses under 10 s, while the 60 s filter costs about 3 points absolute. **Resolved:** "Holds over a minute" stays on by default in Simple, as a robustness filter with honest text. Its own text already says longer holds aren't more profitable. Slippage and lag variance are unmodelled, and they hit short holds hardest. Typed-confirmation friction moves to under 10 s, where the harm is measured. M7 decides whether the default moves.
4. **Sniper warning.** The competitor angle cites Trojan's "exit liquidity" text. The science angle found snipers did not copy worse. **Resolved: descriptive only.** Use the Trojan-style mechanics ("a copy enters 2 s later at a different price") and no claim about outcomes.
5. **Minimum trips for the shortlist.** Simple asked for 20 copyable trades. Science says show at 5, rank at 10, and nothing is "reliable" below 20. **Resolved: 10 plus the shrunk median.** Reliability flattens after 8–10, and shrinkage takes most of the remaining gain. A floor of 20 would leave the first-run shortlist empty. The paper review stays at 20 closed copies, which is a separate number.
6. **Where the advanced switch lives.** Competitors suggested a Discover view remembered in `localStorage`; the audit an app-remembered switch; the advanced angle a per-profile setting. **Resolved: the per-profile setting.** One switch is easier to support, and the house rule keeps `localStorage` for conveniences only.
7. **Default size.** On 10-22 Copy Simple moved to 0.05 SOL to fit the 0.05 SOL live cap. Simple now proposes 0.1 SOL Balanced. **Resolved: 0.1 SOL**, because fixed fees are 7% at 0.05 and 3.5% at 0.1. The Go-live sheet offers to raise `maxLiveSol` with its own confirmation, so the cap refusal that motivated 0.05 doesn't come back. This reverses a decision made yesterday, and the user should confirm it.
8. **Scan versus live as the main source.** Sources proposed a wider scan (~12k trades per run). Science says a ranked hour needs a market-wide read of about 100k trades. **Resolved: live first, scan as fallback** (§5). Both are cheap; only live reaches the numbers in §2.
9. **The promotion rule.** Sources proposed promoting at 5 closed trips into a scored book. Science measured that today's promote-after-3 already loses ~20% of rankable wallets. **Unresolved, so it is M4.** Candidates must keep position state from the first trade, or a higher bar loses more.
10. **The Copy score's extra checks.** Science found reachable and focus add nothing over follower return plus follower win. The audit and simple angles keep the score as the headline. **Resolved:** keep the score's breakdown in Advanced, rank on the shrunk median (#6), and show the copier figure at your size as the headline.
11. **"Only we grade the follower side."** The 10-21 doc said so; the competitor angle found GMGN's skill. **Resolved: reworded** (D8).

### Open questions

- Does Helius's free plan serve `getTransactionsForAddress`? That decides whether design F is ~5k or ~47k wallets a month. It needs a user key to test.
- What window sits behind the public RPC's `x-ratelimit-method-limit: 10`: per second or per 10 s?
- Why did publicnode deliver no pump or PumpSwap logs on 10-22, and why were repeat PumpSwap connections refused? Policy or a transient fault?
- What share of a slow wallet's trips cross graduation (curve buy, AMM sell)? The tape can answer it with a pool→mint join.
- Live hourly rates come from 30–120 s windows; no full live hour was measured. After fix #1, measure one hour: wallets promoted, and how long a thin wallet survives at the cap.
- After #3, #4 and #5, how many wallets in a 24 h record still get a score? If almost none, the beginner view needs a multi-day plan.
- Persistence comes from one partial day with a session change. The day-to-day ρ of the shrunk median is unknown (M8).
- Whether persistence belongs to the wallet or to the coins and hours it trades is unseparated.
- Do loss tail and concentration predict the follower result? Unmeasured (M9).
- Does the $5k minimum-liquidity default refuse most pump copies and stall the paper trial? No copy records exist on this machine.
- Should going live be allowed before a review exists? This spec says yes, but not as the highlighted button. That is the user's call.
- Do the presets need EVM equivalents? EVM gas is not modelled.
- Does gmgn.ai's web UI show its copy-tradeability score, or only the agent skill? Unknown without a logged-in look.
- Can the replay price trips off pump's swap-api (PumpSwap after graduation, Raydium, EVM)? Unknown.
- Reddit and other user forums were unreachable, so user opinion on rival UXs is unknown.

---

Angle reports, scripts and raw outputs:
- Reports: `C:/Users/Krypt/AppData/Local/Temp/claude/C--Users-Krypt-Desktop-kryptware-KryptSniper/5e01d7bb-1231-4dc5-835e-645f377974b2/scratchpad/swarm/` (`sources.md`, `competitors.md`, `audit.md`, `science.md`, `simple.md`, `advanced.md`).
- Screenshots: `audit-shots/` in that folder.
- Tape scripts: `science/extract.mjs`, `science/persist.mjs`, `science/oneoff.mjs`, with output in `science/results.txt`.

---

## Skeptic review

Adversarial pass, 2026-10-22. I read this file, all six angle reports and the 10-21 doc. I checked about 85 file:line citations against the Krypto Copy working tree and ran one new tape count: `scratchpad/skeptic/promote.mjs` over `science/out/trades.csv`, which replays the engine's promote-after-3 rule with the 60k sightings clear. Labels are the same as above. I edited nothing except this section.

### S1. Citation check

Most citations hold. These confirmed exactly: all 12 lead spot-checks; `engine.ts:6138/6353/6370`; `recorder.ts:55-57`; `evm/scanner.ts:628, 661`; `walletScore.ts:30, 37, 114, 217`; `FollowWizard.tsx:55`; `Home.tsx:65`; `ipc.ts:6152-6160, 2173, 5890`; `copytrade.ts:672, 688, 707, 733-737, 834, 848, 945-975`; `exitBudget.ts:229`; `automation.ts:1463`; `copyTrade.ts:2893-2900`; `engine.ts:2266`; `engine/walletScout.ts:49, 59-67, 262-270, 375, 385, 416, 442-443, 448, 455, 467-485, 525, 642`; `scoutScanSources.ts:50, 67, 71, 72-89`; `pumpswap.ts:123-157`; `walletHistory.ts:14-19, 175`; `scoutScan.ts:168`; `types.ts:1105, 1181, 1186, 1245`; `Discover.tsx:51, 83, 93, 220, 349, 354, 383, 416-419, 445`; `Following.tsx:76-95, 96-116, 240, 350-360`; `Onboarding.tsx:52, 572, 614, 652, 667`; `WalletProfile.tsx:68-86, 103, 213-217, 327-334`.

**Wrong or misleading (7):**

| Where in this doc | Cited | Actual |
|---|---|---|
| §7 matrix, M11 | `launchIntel` at `electron/preload.ts:507`, `holderGraph` at `:510` | Swapped. `holderGraph` is `:507` and `launchIntel` is `:510`. `market:traderScan`, a token → traders read that already exists, sits at `:509` and goes unmentioned |
| §6 S6, #15 | `src/components/TopNav.tsx:96-108` | The file is `src/shell/TopNav.tsx`. The lines are right |
| §3 P3, #18 | `src/components/kit.tsx:383-389` | The file is `src/ui/kit.tsx` |
| §7 matrix, #10 | `src/components/WalletTags.tsx:8-14` | The file is `src/components/copy/WalletTags.tsx` |
| §3 P1 row 2, #4 | `electron/engine/walletScout.ts:437, 448` | Those engine lines are a comment and the `fast` counter. The window logic is `shared/walletScout.ts:437` (`windowDays`) and `:448` (the `>= 3` gate) |
| §3 P2 "Days active" | `electron/engine/walletScout.ts:402-406` | The rule is `shared/walletScout.ts:435`: `activeDays = days.filter(d => d.buys + d.sells > 0)` |
| #17, §5 arch. 1 | "PumpSwap swaps already decoded by the engine (`engine.ts:~5885`)" | The line is right, but the claim is false by default. `onAmmLogs` returns before decoding unless `ammDecodeWanted` (`engine.ts:5906`) sees a shadow module, a tape subscription, an armed order or a script that wants ticks. A Scout-only user has none of these. Swaps are also mapped to a mint only for pools already in `ammPoolToMint` (`:5931`) |

### S2. Unsupported or overstated claims

**Numbers**

1. **"The 6,000 cap fills in about 5 h" is wrong by 3–6×.** That figure divides 5-trip wallets by hours, but the cap counts *promoted* wallets: 3 sightings, `engine/walletScout.ts:49, 383-392`. Replayed on the 09-16 tape, pump mints only, from an empty book, the cap fills in **95 minutes**. Over all Solana curve rails it fills in **52 minutes**. Promotions then run at **~1,100–2,800 an hour** (pump only, hours 1–10) (**measured**, this review). At that rate a thin wallet that goes quiet is pushed out within roughly 2–5 hours (**estimate**). A slow human almost never reaches 5 trips, let alone 3 active days. So fix #1 without M4 gives the "high-frequency FIFO" failure within the first session, not after 5 h.
2. **"Cost: nothing extra while the engine already runs, and 1.26 GB/h when it is started only for the Scout."** Today, "Record live" calls `engine.start()`, and that opens the PumpSwap firehose socket unconditionally (`engine.ts:1672-1683`; memory recorder-off-by-default, "still open"). The real cost of Record live is curve plus AMM, about 8 GB/h by the doc's own 5.6× ratio (**estimate**). The 1.26 GB/h figure applies only to the proposed Scout-only recorder (M3). It also comes from a 30 s window ×120, so it is a measured window with an estimated hour, like the live trade rates.
3. **The cost basis behind the Simple daily stop is from a different model.** "A median mirrored copy loses 4–7%" and "mirroring (−4 to −7%) beat a 60-min hold (−15%)" come from the 09-14 study: 800 ms lag and 0.85% round trip. The science angle says those levels "are not comparable" with the app's own model. Under the app's model (2 s, 1.5%/side), mirroring every ≥5-trip wallet was **−9.9%**, and mirroring every closed trip **−13.0%**. Adding paper model 2 (+0.5 pts) and fixed fees at 0.1 SOL (+3.5 pts) gives about **−13.9%** per copy for an average wallet and **−8.7%** for the shrunk top decile (**estimate**, arithmetic). At 20 copies a day that is **0.17–0.28 SOL, or 1.7–2.8 sizes, on an ordinary day**, not 1–1.4. The proposed 3× stop (0.3 SOL) would trip on ordinary days. The 2 SOL suggested bankroll would last roughly 7–12 such days (**estimate**). These are medians; losses have a fat left tail (S5's own example has a −61% copy), so the mean is likely worse.
4. **"Shrunk follower median was the best ranker in every pool."** In the ≥20-trip pool the raw median's point estimate (−3.8) beat the shrunk one (−4.3), with overlapping CIs. Science says "best or tied-best". There are two further caveats.
   - The shrunk selection carries 3× the trips (8,551 against 2,607). That alone narrows the CI, so "CI 4× tighter" is partly sample size, not ranker quality.
   - It has no hold-matched control. High-trip wallets are shorter-hold, and short holds bleed less (scalper −9.4 against −11.7). Part of the +5.2 points may be hold mix.
   - Picking the best of about 12 rankers on one tape is itself a selection: winner's curse.
5. **"Bottom deciles ran from −20% to −38%."** These are the bottom deciles of two different rankers: Copy score −20.7, follower median −38.0. For the Copy score, the bottom three deciles were −20.6, −21.7 and −25.4.
6. **The volume ranges disagree inside this doc.** §1 says curve 80k–241k and PumpSwap 550k–1.04M per hour. The §2 table says 96,627–240,975 and 776,535–1,041,982. 80k comes from science (a different filter) and 550k from the partial hour 10. The two angles also count different curve totals for the same file: 1,273,991 (science) against 1,435,570 (sources). The 161k gap is unexplained.
7. **"No competitor found that ships one [a replay]" and "M5: High and unique."** The competitors angle documents **Cielo's Simulation panel**: "how it would have performed over the last 1, 3, or 7 days" before you run it (vendor). It also documents GMGN's skill backtest with assumed drift. The advanced angle missed both, and the synthesis took the advanced angle's word. This is a D8-type claim: say "replayed from trades at your size", never "unique".

**House rules**

8. **Paper-first and recorder-off, against S1.** S1 starts "the live feed and a 1-hour Find wallets run in the background while the user reads the terms". That means:
   - network reads against pump.fun's undocumented APIs before the Terms are accepted (legal baseline: acceptance gates the app);
   - a full `engine.start()`, about 8 GB/h with the AMM socket (S2.2), with no consent and no stated cost.

   It also contradicts §5 of this same doc, where the Scout-only recorder is **opt-in** with its cost on the switch. Start nothing before acceptance. After it, ask once, stating the cost.
9. **Order-safety amendment: `maxLiveSol` is the unattended cap.** S6 raises it "with a sentence" inside the same sheet as Arm with one confirm. The competitors angle (§4.2) says the opposite: rails are raised only on the Wallet page with their own confirmation. Keep the raise as a separate, explicit confirm, capped at the preset size and logged. The #15 risk column says this, but S6's text does not.
10. **Honest null and "never call a figure reliable".** A **High** confidence chip (S4) has no measured basis: split-half ρ never reached 0.7, even at 40 trips. Ship Low and Medium only, or define High as ≥ 20 trips, with "still noisy" beside it.
11. **"Suggestions obey the board" (#7), against S2.** In the empty state S2 offers "the 3 closest, and what each is missing". On Simple Home, that list is a back door to the wallets the filters rejected. Show them with Watch only, never Follow.
12. **Advanced range filters break the honest-null filter rule.** The advanced angle specifies "Unknown never hides a row, same as `passesScoutFilter`". The house rule says a NUMERIC bound skips an unknown. With today's semantics, a filter of "follower median ≥ −3%" would list every unpriced wallet. Numeric ranges must exclude nulls, with a count: "hid 212 with no figure".
13. **No URL over IPC.** New links come from the `/home-feed` X handles, list import names and the video link fix (S1). They must not go through `app:openExternal` (`ipc.ts:789`), which accepts any `https://` URL from the renderer. Build them in main from a handle or a constant, with the host pinned, the same pattern as the runner webhooks and the notification click.
14. **No engine toasts.** The copy engine's `warn` toasts are already logged and never pop (`AppStateProvider.tsx:238`), so no conflict there. S10's desktop notifications are a separate switch (`alerts.desktopNotifications`). Defaulting "live buy or sell" to on recreates the pop-up noise the user removed on 09-29. Default fills off, and keep the stops, failures and review on.

**Simple defaults that cost a beginner money**

15. **0.1 SOL Balanced lowers the fee *share* and raises the SOL *lost*.** On the S2.3 arithmetic, an average wallet loses about 0.0087 SOL per copy at 0.05 and 0.0139 at 0.1. The best decile loses about 0.0061 and 0.0087. Every size loses, so a bigger default loses 40–60% more SOL per day. Conflict 7 picks 0.1 on fee share, which is the wrong objective for a negative-EV default. Before the user decides, the Go-live sheet and S1 should show expected SOL per day from the user's own paper record.
16. **Mirror sells, with no TP, SL or max hold, has no backstop for a missed sell.** `logsSubscribe` has no catch-up (memory copy-late-exits), and some sells can't be mirrored (copy trade audit 09-13). A missed mirror leaves the bag open indefinitely. Add a long max-hold backstop in every preset (for example, 24 h), or at least the "you still hold it" alert. A stop-loss is a weaker answer, since stops filled at 0.53×.
17. **Going live before the review exists.** In Simple, block Go live until the S5 review has fired, with an Advanced override. "Never blocked, just not highlighted" is the softer choice, and it is the user's call. Raise it as a decision, not a default.

**Advanced features with no guardrail**

18. **Lean-lane minimum of 0.0025 SOL.** At that size ATA rent (about 0.002 SOL, refunded only when the account is closed) and the venue fee dominate. Memory scorenow says live PnL reads −17% on landing from rent alone, and lean copy latency is unmeasured. Set the copy minimum from total round-trip cost, rent included, not from priority fees alone.
19. **Slippage up to 50% and a delay up to 60 s, with no friction.** The competitors angle wanted friction for slippage above the cap. Guardrail 10 dropped it. Add a typed confirmation above about 20%.
20. **"Reset a wallet's record" (`copy:resetStats`) can launder a bad paper record** into a fresh one before going live. The S5 review must use the full history, or a reset must restart the paper requirement.
21. **The replay's lag picker offers 1 s,** which is faster than the app lands: about 1.4 s plus feed latency (`walletScore.ts:25-30`). Floor it at 2 s, or label anything lower "faster than this app can copy".
22. **Scout "Start over" (`scout:clear`) wipes a multi-day book** that takes days to rebuild. It needs a typed confirmation.

**Data sources whose ToS or rate-limit risk is understated**

23. **swap-api, `/home-feed` and `/mint-positions` are undocumented pump.fun routes.** Stage 1, the stage 3 follower seeks (up to about 1,800 calls an hour per install) and M5 replays would make them the keyless scoring backbone for every install. Two risks follow.
    - A burst block parks the same IP the user's charts and Discover read from (memory: swap-api candles, the `/coins` route park). A scan can blind trading data.
    - No angle read pump.fun's Terms on automated access. Its Callout Terms 7.1 already ban scripted callouts (memory 09-26). "Undocumented, unofficial" understates this. Read the Terms before building on them.
24. **api.mainnet-beta as the primary Scout feed for a mass-market fleet.** It has 10 pubsub connections per IP, and repeat connections were refused after one 60 s run (**measured**). Solana's own docs describe the public endpoints as not for production use (from prior knowledge, not fetched here).
    - The proposed per-pool PumpSwap subscriptions (C', #17) and a Scout-only socket (M3) share that budget with the copy `walletWatcher`. Its subscriptions use the same primary public WSS, capped at 10 per socket and shown as `over-cap` (memory copytrade-paper-first).
    - A Scout feature that pushes a copy watcher over the cap makes a copy miss trades, which costs real money. The doc never mentions this.

### S3. Items to re-rank

| Item | Move | Reason |
|---|---|---|
| #12 live minimum, #13 no auto-arm | To the top, with #1 | §1.6 says the live minimum "comes first", but the table ranks it 12th. Both are money-safety items; everything else in Build now is information |
| M4 two-tier book / cap | Measure first → **Build now, shipped with #1** | The cap fills in 52–95 min (S2.1). Without it, #1 turns the book into a FIFO of high-frequency wallets within one session |
| #9 | Split | The rate-based bot rule stays S. "Eviction by LRU" does not fix capacity; it belongs with M4 |
| #17 PumpSwap into the Scout | Build now → Measure first | Swaps are not decoded by default (`engine.ts:5906`). Measure the decode CPU at ~700 notifications/s (42,568 in 60 s, measured) and the effect on the pubsub budget first |
| #6 shrunk-median ranking | Keep S, but ship as a sort labelled "least bad", with thresholds unfrozen | Needs a hold-matched control and M8's replication. It won a 12-way contest on one partial day |
| #15 Simple screens | Keep, with S1 changed | Nothing starts before Terms; recording is opt-in with its cost; the `maxLiveSol` raise gets its own confirm; Go live waits for the review |
| Simple defaults (§6) | Hold pending the user | Rebase the daily stop and bankroll on the app's own cost model (S2.3). Show SOL per day, not fee share. Add a max-hold backstop |
| M5 replay | "High and unique" → "High" | Cielo ships a 1/3/7-day simulation (S2.7) |
| M14 power table | Keep after #3–#6 | Make numeric ranges exclude nulls first (S2.12) |
| M10 per-follow lane | Keep in Measure first | Raise the lean minimum to total cost with rent (S2.18) before it ships |

### S4. Anything missed

1. **The app's own follower score has survivorship bias.** No-exit trips (dead coins, no print within 10 min) are unreachable and left out of follower return (`engine/walletScout.ts:262-282`; the audit §1 "Unreachable"). A wallet that rides coins to zero scores better. #3, "score honesty", should price a dead coin at its last print, or at −100% once its pool is drained. This is 10-21 item #11, still open, and not on this roadmap.
2. **`market:traderScan` already exists over IPC** (`preload.ts:509`). M11 and "Who bought this early" should start from it, not from new code.
3. **The "40–157 rankable an hour" promise needs the full engine running for that hour.** On a beginner's laptop that is about 8 GB/h today (S2.2), or 1.3 GB/h with M3. The Simple Home line "Watching live · 2 h" should say what it is downloading.
4. **Multi-day `regular` cannot survive eviction** unless saved, followed or non-thin wallets are exempt. With the cap at about 1.5 h (S2.1), the observed-span fix (#4) will see almost no wallet reach 3 days. The after-#3–#5 open question ("how many still get a score in 24 h?") is likely "almost none" until M4 lands.
5. **There is no aggregate rate budget across installs.** Every keyless design multiplies per-install calls by the install count against one vendor. One pump.fun block by User-Agent would empty every board at once. Plan a degraded mode: live feed only, with a "scan unavailable" reason.
6. **Ban the "−15% vs −60%" sentence.** The simple angle's optional line ("following a ranked wallet lost far less than buying new coins at random, −15% vs −60%") uses the non-hold-matched control. Against the hold-matched control (b) of −8.5%, mirroring was *worse* (−9.9%). The synthesis rightly dropped it. Pin that with a copy-text test, so it never ships as an implied edge.
7. **The 10-22 working tree is partly uncommitted** (`git status`: `copyTrade.ts`, `walletScout.ts`, `scoutScanSources.ts`, `shared/copytrade.ts` all modified). Line numbers in this doc, and in this review, will drift on the next commit. Re-verify before turning roadmap items into tickets.
