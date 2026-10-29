# Roadmap status audit (code), Krypto Copy @ c4f3e1c

Angle: roadmap status audit. Date: 2026-10-23. Repo `C:\Users\Krypt\Desktop\Krypto Copy`, branch main, HEAD `c4f3e1c` (2026-10-23 00:40 −0700), clean at start.

Labels: **measured** (I ran it; command and date given), **code** (file:line at c4f3e1c, re-found by grep, not copied from the docs), **estimate**. Nothing here is a vendor or paper claim.

Statuses: **BUILT** (the item's substance is in the code), **PARTIAL** (some of it), **MISSING**, **SUPERSEDED** (overtaken by a later decision or design), **N/A** (depends on a feature that doesn't exist), **UNKNOWN** (not checked).

---

## 0. Headline

1. **Typecheck and the whole offline suite pass** (measured, 2026-10-23 02:53–03:01 PDT). `npm run typecheck` exited 0. `npm test` printed **"175 suites passed in 481 s"** and exited 0. Copy-related suites: copytrade 166/166, copylatency 11/11, walletswap 14/14, walletwatcher "all tests passed", wallethistory 3/3, walletscout 18/18, copysimple 3/3, walletscore 6/6, walletfinder 15/15. Nothing failed, so no suite had to be re-run on its own.
2. **New money bug, measured: the 10-22 double-mirror fix under-sells.** `mirroredSells` acts on whichever delivery of a leader sell arrives first, and never tops up. On the pump rail the first delivery is the firehose (default commitment `processed`, `shared/types.ts:1111`). Its fraction is recovered from a leader balance read at `confirmed` (`electron/chain/rpcClient.ts:1235-1238`, `electron/engine/copyTrade.ts:1540-1566`). If that read still shows the pre-sell balance, a **100% leader exit is mirrored as 50%**, and a 40% trim as 29%. The watcher's exact fraction then arrives and is ignored (`copyTrade.ts:2307-2318`). Repro: `scratchpad/swarm/status/repro.mjs` against the test bundle. The existing test pins only the case where the balance read already sees the post-sell state (`test/copytrade.test.mjs:2878-2903`, `leaderHolding: 600`). How often the read sees pre-sell state live is **unknown**. My estimate is often, since the read runs at once on a `processed` event.
3. **New money bug, measured: open copies drop out of the book after 2,000 newer rows.** `record()` keeps the newest 2,000 rows, skipped rows included, with no exemption for open ones (`copyTrade.ts:53, 954-958`; the same truncation is at `:2416`). After 2,000 newer rows, an open **live** copy disappears. The leader's full exit then places **0** sell orders, and the tokens stay in the wallet with no manager. With 1,998 or 1,999 newer rows, the sell is placed (measured, `repro2.mjs`). Every leader trade refused by a filter writes a row, so a busy leader with strict filters reaches 2,000 rows (estimate: hours to days per config).
4. **None of the Krypto Bot 10-23 audit fixes reached the fork** (code; memory audit-2026-10-23 lists them as fixed in KryptSniper):
   - exact-in buys: no `buy_exact_sol_in` or `buy_exact_quote_in` in `electron/`, and the curve buy still sets `amount = quote×(1−slip)` (`txBuilder.ts:1484-1487`);
   - loss-guard pre-balance at `processed`: still `confirmed` (`liveSigner.ts:957-960` → `rpcClient.ts:774`);
   - nav-guard prefix hole: still `startsWith('http://localhost')` (`electron/system/webSecurity.ts:96-99`);
   - `placedBy` tags on script orders: absent;
   - main-owned `exitsOnly`: not needed here, because `managesExits` already covers it (`copyTrade.ts:527-529`).

   The walletscout clock fix *is* in (`test/walletscout.test.mjs:53-57`).
5. **Side effect of running `npm test`, which the task required:** the tracked file `.tmp` in the repo root was rewritten (one `at` timestamp changed; `git status` shows ` M .tmp`). Cause (code): the debounced `persist()` timer reads module `filePath` when it fires (`copyTrade.ts:339-341`). The test-only `_reset()` sets `filePath = ''` without clearing `saveTimer` (`:3661`), so a pending save writes `${''}.tmp` into the working directory. `.tmp` was committed by accident in `c4f3e1c`. There is no production impact (prod never resets `filePath`). I did not revert it, because of the no-edit rule. `git checkout -- .tmp` restores it.

Of the roughly 120 items audited below: about 30 BUILT, about 25 PARTIAL, about 55 MISSING, and the rest N/A, SUPERSEDED or UNKNOWN (my count).

---

## 1. Test and typecheck results (measured)

| Command (from repo root) | Started | Result |
|---|---|---|
| `npm run typecheck` | 2026-10-23 02:53:04 PDT | `TYPECHECK_EXIT=0`, no diagnostics |
| `npm test` (`scripts/test.mjs`, 175 steps) | 02:53:23 | **175 suites passed in 481 s**, `TEST_EXIT=0`, ended 03:01:25 |

Copy-path suite lines from the same log: `copytrade: 166/166 tests passed`, `copylatency: 11/11 passed`, `walletswap: 14/14 tests passed`, `walletwatcher: all tests passed`, `wallethistory: 3/3 passed`, `walletscout: 18/18 passed`, `copysimple: 3/3 passed`, `walletscore: 6/6 passed`, `walletfinder: 15/15 passed`. Logs: `scratchpad/swarm/status/typecheck.log`, `test.log`.

Repro scripts (read-only; they import the gitignored `test/.copytrade.mjs` that `npm test` builds; no network, no keys):

```
node scratchpad/swarm/status/repro.mjs  "C:/Users/Krypt/Desktop/Krypto Copy"
R1 full exit, pre-sell balance 1000: leader sold 100% → sell orders [50], copy remainingPct 50 state open
R1 40% trim, pre-sell balance 1000: leader sold 40% → sell orders [29], copy remainingPct 71.43 state open
R1 control: read already post-sell (600 left): leader sold 40% → sell orders [40], copy remainingPct 60
node scratchpad/swarm/status/repro2.mjs ...
R2 live N=2000 newer skipped rows → sell orders placed 0 (open row evicted)
R2 live N=1998 / 1999            → sell orders placed 1
```

The `R2` print says "2,000 skipped rows" on every line; that text is stale. `N` is the real count.

---

## 2. Status table

### 2a. 10-21 doc, Build now #1–#14

| # | Item | Status | Proof at c4f3e1c |
|---|---|---|---|
| 1 | Exits independent of `enabled` | **BUILT** (gaps remain) | `managesExits` `copyTrade.ts:527-529`. Watch list `:538-547`, router `:1239`, own exits not gated `:3441-3447`, FOMO `:3548, 3586`. Live disarm on load `:309-320`. Peak reset `:307`. `checkLeadersAfterBoot` `:1445`, called from `main.ts:836-847`. Card: "Paused — … still following N open copies out" `Following.tsx:336-338`. **Missing:** the per-config "stop managing exits" switch. The boot check is only logged (`main.ts:843`), never shown to the user |
| 2 | Close the double mirror | **PARTIAL: new bug** | `mirroredSells` `:1183-1190`; first delivery wins `:2307-2318`; no top-up. Under-sells when the recovered fraction is low (R1, measured) |
| 3 | Price from own fills; split paper/live | **BUILT** | Entry rewrite `entryBasis 'fill'` `:1656-1660`; `priceLiveExit` `:2456`, `:2422, 2496, 2539`; stats per mode `:554-556`; `todayFor` mode filter `:893`; pending exits in the daily limit `:944-948`; "Awaiting fill" `Following.tsx:440-445`. Paper exit = min(leader, spot) at detection `:2333`, not "first print after the delay" |
| 4 | Paper fidelity | **BUILT** | `PAPER_MODEL` `:1999, 2864`; fixed fees `shared/copytrade.ts:982` (fast lane, which is the only lane copies use) |
| 5 | Leader fill + premium guard | **PARTIAL** | Storage BUILT: `leaderPriceSol` `copyTrade.ts:2568`. Guard SUPERSEDED (moved to measure-first by the 10-21 skeptic) |
| 6 | Mint-safety check on copy buys | **MISSING** | `checkMint`/`hasHardReject` are called only in `engine.ts:6530-6542, 6917` (scanner). The copy host's `tokenFacts` returns no safety field (`engine.ts:911-939`). `liveSigner.ts:625-637` reads extensions only to explain a route failure |
| 7 | Classify transfer-out and stable-sell exits | **MISSING** | `walletSwap.ts:152-157` returns null without a SOL leg; one `notSwap` counter `walletWatcher.ts:529, 586` |
| 8 | Slots + realised slippage | **PARTIAL** | `leaderSlot`/`slotGap` `copyTrade.ts:1676-1679, 2831`; "entry +x % vs theirs" (10-22 table). **Missing:** the tx-transport `tradeAt` (`walletWatcher.ts:534-545`, null on push), so the stale gate is off on the paid transport |
| 9 | Free latency fixes (a–d) | **MISSING** | (a) keyless Sender `broadcast.ts:39`, no `/ping` in `prewarm.ts`. (b) `BLOCKHASH_TTL_MS = 20_000` `txBuilder.ts:66`. (c) facts still serial before the buy `copyTrade.ts:2707`. (d) BNB poll `evm/scanner.ts:79` (6 s), no WSS subscribe |
| 10 | Bankroll model and breakers | **PARTIAL** | Copy Simple default 0.05 `FollowWizard.tsx:37` and the live minimum are BUILT. **Missing:** bankroll, max open, exposure, per-leader drawdown and cross-config dedupe. `CopyConfig` has none of these fields (`shared/copytrade.ts:87-202`), and `limitHit` uses realised PnL only (`copyTrade.ts:934-951`) |
| 11 | Honest Copy score | **PARTIAL** | Repricing to the paper model `walletScore.ts:70`; shrunk median `:88-92`. **Missing:** dead coins left unpriced (`walletScout.ts:318-322, 545-558`); no own impact; fixed 2 s lag `walletScore.ts:30`; no leader, cluster or WT1 exclusion (any print fills, `walletScout.ts:330-339`) |
| 12 | Watch-only + alerts via `engine.notify` | **MISSING** | No `notify` in `copyTrade.ts` (grep); `engine.notify` exists (`engine.ts:730, 1355`). No watch-only direction (grep) |
| 13 | UX/honesty batch | **PARTIAL** | Win rate ×100, "—" before close and "Won (of N)" BUILT (`Following.tsx:442`, `Home.tsx:359`). **Missing:** "too few to judge" on the follow card; a Remove that keeps managing exits (`copyTrade.ts:420-445` deletes rows); sort by follower return (no sort in `Following.tsx`); `copy:resetStats` 0x (`ipc.ts:5895`); in-flight clobber (`copyTrade.ts:1322, 2598, 2603`) |
| 14 | Referrer ≠ leader | **MISSING** | `liveSigner.ts:740-746` checks treasury and owner only |

### 2b. 10-21 doc, Measure first M1–M9

| # | Item | Status | Proof |
|---|---|---|---|
| M1 | Lag replay | **MISSING** in repo | No lag-curve script in `scripts/analysis/` (listed 10-23); none in `docs/` |
| M2 | jitodontfront + sandwich detector | **MISSING** | grep `jitodontfront` → 0 |
| M3 | preprocessedSubscribe prebuild | **MISSING** | grep → 0. `transactionSubscribe` exists (`walletWatcher.ts`, `leaderFeedFrames.ts`) |
| M4 | Crowding / cohort flags | **MISSING** | no shadow/crowd metric in Scout files (grep) |
| M5 | Copy exit ladder (dev sell, migration…) | **MISSING** | `CopyConfig` has only TP/SL/trailing/max-hold (`shared/copytrade.ts:115-118, 167`). Dev-sell exists for scripts only (`engine.ts:6663`) |
| M6 | Counterfactual exit/skip panel | **MISSING** | grep → only `migShadow.ts` (unrelated) |
| M7 | R1–R4 "skip dead launches" | **MISSING** | grep → 0 |
| M8 | Leader import | **MISSING** | no import path in Following or Discover |
| M9 | EVM honeypot sim, `maxTaxPct`, EVM live cap | **MISSING** | EVM copy `maxLive: () => null` (`ipc.ts:3050, 5749`); facts carry no `createdAt` or `creator` (`ipc.ts:5752-5755`) |

### 2c. 10-21 doc §7 correctness gaps

| Sev | Gap | Status | Proof |
|---|---|---|---|
| P1 | Unmanaged after restart or pause | **BUILT** | see #1 |
| P1 | Double mirror | **BUILT, over-corrected** | see #2 and R1 |
| P1 | Record at the leader's exit | **BUILT** | see #3 |
| P1 | Paper fixed fees / 1.25% | **BUILT** | see #4 |
| P1 | Paper/live mixed | **BUILT** | `copyTrade.ts:554-556, 893` |
| P1 | Transfer-out / stable-sell invisible | **MISSING** | see #7 |
| P1 | No mint safety | **MISSING** | see #6 |
| P2 | `buysInFlight` clobbered by same-mint add-on buys | **MISSING** | `copyTrade.ts:2597-2603`: a second `set` overwrites, and the first `finally` deletes the second's flight |
| P2 | Recovered fraction biased low | **MISSING, now worse** | `:1538` (3 s cache), `:1540-1566`; `rpcClient.ts:1238` confirmed; feed `types.ts:1111` processed; R1 |
| P2 | Unreadable signature never retried; sell before buy dropped | **MISSING** | `walletWatcher.ts:622-630` (logged, kept in `seen`, no row); `copyTrade.ts:2261-2264` → `parkExit` returns false with no flight (`:1350-1352`), and the buy is copied later |
| P2 | Parked exits keep only the newest | **MISSING** | `pendingExits.set(key, t)` `:1353`, comment "newest wins" `:1323` |
| P2 | No premium guard | **SUPERSEDED** | measure first; storage built `:2568` |
| P2 | Copy Simple 0.1 above the cap | **BUILT** | `FollowWizard.tsx:37`; cap-fit prompt `Following.tsx:98-112` |
| P2 | No exposure cap or drawdown stop | **MISSING** | see #10 |
| P2 | EVM: curve only, no cap, facts missing | **MISSING** | `ipc.ts:3050, 5749, 5752-5755` |
| P2 | Remove deletes open live rows | **PARTIAL** | Warning text BUILT `Following.tsx:118-128`; rows still deleted `copyTrade.ts:425` |
| P2 | Blockhash TTL 20 s; keyless Sender | **MISSING** | `txBuilder.ts:66`; `broadcast.ts:39` |
| P3 | Win rate ×100; "+0.0000" | **BUILT** | `Following.tsx:438-442` |
| P3 | Followed leaders sorted by their own PnL | **SUPERSEDED** | The new Following page has no sort at all. Follower-return ordering is still missing |
| P3 | Slow catch-up; no boot check | **PARTIAL** | Boot check BUILT (log only). `RECOVER_LIMIT = 25` `walletWatcher.ts:161`; one wallet per tick `:674-690` unchanged |
| P3 | Per-trade full scans | **PARTIAL** | `activeWallets` and `openConfigIds` cached (`copyTrade.ts:516-547`); `markToMarket` still loops all rows on every tracked-mint print `:3410-3420` |
| P3 | `resetStats` rejects 0x; one config per leader per chain | **MISSING** | `ipc.ts:5895`; `copyTrade.ts:403` |
| Doc | "harsh fills" claim | **MISSING** | `docs/copy-trade-competitors-2026-09-21.md:171` unchanged |
| ? | Token-2022 fee/hook in local builders | **UNKNOWN** | not checked |
| ? | `copySells` × own TP/SL interplay | **UNKNOWN** | not checked |

### 2d. 10-22 doc, Build now #1–#18

| # | Item | Status | Proof |
|---|---|---|---|
| 1 | Feed the Scout outside the recorder gate | **BUILT** | `scout.note` `engine.ts:6152`, outside `recordTape` `:6138` |
| 2 | Replay-safe saved dedupe | **BUILT** | `wallet-scout-seen.bin`, 500k hashes `walletScout.ts:52-53, 93, 447` |
| 3 | Score honesty | **PARTIAL** | No score without a follower return `walletScore.ts:283`; "low confidence" under 10 `Discover.tsx:397`; history unpriced `walletScout.ts:505-508, 546-558`. **Missing:** a fill arriving after the 10-minute stale window is still taken. The stale test sits behind `at >= due` (`walletScout.ts:336-341`), and the sweep runs every 1,000 notes (`:104, 460`), which a scan's few hundred trades never reach. The survivorship gap is §2f S4.1 |
| 4 | Observed-span window | **BUILT** | `shared/walletScout.ts:197, 555, 601` |
| 5 | One cost model | **BUILT** | `walletScore.ts:70`; `shared/walletScout.ts:522-530` |
| 6 | Shrunk-median ranking | **BUILT** | `walletScore.ts:88-92`; label "Least bad to copy" `shared/walletScout.ts:442` |
| 7 | Suggestions obey the board | **BUILT** | `shortlist` `shared/walletScout.ts:215`; `FollowWizard.tsx:57`; `Home.tsx:68` |
| 8 | Honest empty board + status line | **PARTIAL** | The filter that hides the most `Discover.tsx:84-98`. **Missing:** "Watching live · N h", the 3 closest, remembered board state |
| 9 | Bot rule on trade rate + LRU | **PARTIAL** | Candidate LRU `walletScout.ts:477-480`. **Missing:** the trade-rate rule (`shared/walletScout.ts:490-492`, still hold + trips) |
| 10 | Warning labels (Creator, Long holder, Large size, bottom decile) | **MISSING** | `WalletTags.tsx:8-14` has only bot/thin/unreachable/concentrated/partial |
| 11 | Scan honesty | **PARTIAL** | The first failure is surfaced (`scoutScanSources.ts:88`; `scoutScan.ts:161-163`). **Missing:** "N of M not read", `complete` carried into the batch, seek. Still picks coins by column (`:50`) |
| 12 | Live minimum per lane + fee share | **BUILT** | `shared/copytrade.ts:738`; `copyTrade.ts:2906-2910`; fee share `FollowWizard.tsx:27` |
| 13 | No auto-arm; presets with max open and per-wallet stop | **PARTIAL** | `liveEnabled: false` `types.ts:1183`. `syncLiveMode` still arms once the user enables Live (`ipc.ts:6156-6164`), which is intended. **Missing:** presets, max open, per-wallet stop; `SIMPLE_LOSS_MULTIPLE = 10` `shared/copytrade.ts:745` |
| 14 | Skip reasons, notifications, auto-pause | **PARTIAL** | Skip rows with reasons `Activity.tsx:54`; `CopyRow.tsx:22`. **Missing:** notifications and auto-pause after 3 failures (grep → 0) |
| 15 | Simple screens S1–S8 | **PARTIAL** | Home and wizard exist. **Missing:** the S5 paper review and the S6 Go-live sheet (grep "review" → 0 in `Home.tsx`) |
| 16 | Advanced switch, kit editor, rule chips | **MISSING** | No setting (grep). `ConfigEditor.tsx:27` still imports `../common`. Card rules `Following.tsx:350-360` omit blocklists, buy-once and age |
| 17 | PumpSwap swaps into the Scout | **MISSING** (S3 moved it to measure-first) | `engine.ts:5906` `ammDecodeWanted` gate |
| 18 | Display fixes | **PARTIAL** | Burst caution `WalletProfile.tsx:108-109`. **Missing:** 0x profile opens as Robinhood `Discover.tsx:106`; sightings counted as "recorded" (`walletScout.ts:471` returns `'noted'` → `scoutScan.ts:168-169` `fed += 1`) |

### 2e. 10-22 doc, Measure first M1–M15

| # | Item | Status | Proof |
|---|---|---|---|
| M1 | Find wallets by activity | **MISSING** | `scoutScanSources.ts:50` (columns) |
| M2 | Backfill + follower prints by seek | **MISSING** | `walletHistory.ts:24` (200 signatures), no seek |
| M3 | Scout-only recorder with cost stated | **MISSING** | "Record live" calls full `engine.start()` `Discover.tsx:474`, which opens the AMM firehose `engine.ts:1672-1683`; no cost text `Discover.tsx:499-506` |
| M4 | Two-tier book | **BUILT** | ranked + thin tier, `walletScout.ts:18-19, 57-58, 477-480` |
| M5 | "Try it at your size" replay | **MISSING** | — |
| M6 | Helius backfill depth | **MISSING** | — |
| M7 | "Too fast" at 10–15 s | **MISSING** | `SCOUT_SLOW_ENOUGH_MS = 60_000` `shared/walletScout.ts:134` |
| M8 | Replicate on 3+ tape days | **MISSING** in repo | — |
| M9 | Loss tail and concentration | **MISSING** | — |
| M10 | Per-follow lane / MEV | **MISSING** | copies are fast-lane only `shared/copytrade.ts:982` |
| M11 | Who bought early, funder view | **MISSING** (IPC exists) | `preload.ts:507, 509, 510`, unused by pages |
| M12 | publicnode delivering 0 pump logs | **UNKNOWN** | still listed `types.ts:1105` |
| M13 | Lists + GMGN import | **MISSING** | — |
| M14 | Discover power table | **MISSING** | — |
| M15 | "Trades like this one" | **MISSING** | — |

### 2f. 10-22 skeptic S2 / S3 / S4

| Ref | Item | Status | Proof |
|---|---|---|---|
| S2.1 | Cap fills in 52–95 min | **BUILT** (via M4) | two-tier book |
| S2.2 / S4.3 | Record live costs ~8 GB/h, unstated | **MISSING** | `Discover.tsx:474, 499-506` |
| S2.3 | Daily stop basis wrong | **MISSING** (pending the user) | `SIMPLE_LOSS_MULTIPLE = 10` |
| S2.8 | Nothing starts before Terms | **BUILT** (by absence) | Onboarding calls no `engine.start` (grep) |
| S2.9 | `maxLiveSol` raise needs its own confirm | **SUPERSEDED** | No Go-live sheet; `setMode` lowers the size to the cap instead (`Following.tsx:98-112`) |
| S2.10 | No "High" confidence | **BUILT** | only "low confidence" `Discover.tsx:267, 397` |
| S2.11 / S2.12 / S2.14 / S2.18 / S2.20 / S2.21 / S2.22 | Guards on features not built | **N/A** | — |
| S2.13 | `app:openExternal` takes any https URL | **MISSING** | `ipc.ts:789-795` |
| S2.15 | Default 0.1 SOL raises SOL lost | **BUILT** (kept 0.05) | `FollowWizard.tsx:37` |
| S2.16 | Max-hold backstop in every preset | **MISSING** | `simpleConfig` leaves copy exits null `shared/copytrade.ts:762-777, 786-788` |
| S2.17 | Go-live waits for the review | **MISSING** | no review |
| S2.19 | Typed confirm above ~20% slippage | **MISSING** | `shared/copytrade.ts:866` (≤ 50, no friction) |
| S2.23 | Read pump.fun ToS on automated access | **MISSING** (research) | — |
| S2.24 | Scout and copy share the public pubsub budget | **MISSING** | the watcher uses `host.wssUrl()` `walletWatcher.ts:299, 312`; no shared budget |
| S3 | Re-rank: #12 and #13 first, M4 with #1, #17 to measure, "least bad" label | **BUILT** (as ordered) | see rows above |
| S4.1 | Survivorship in the score (dead coins dropped) | **MISSING** | `walletScout.ts:318-322, 545-558` |
| S4.2 | Start M11 from `market:traderScan` | **N/A** | `preload.ts:509` |
| S4.4 | `regular` survives eviction | **UNKNOWN** | `observedDays` persists (`walletScout.ts:159`); whether saved wallets are exempt from eviction was not checked |
| S4.5 | Degraded mode across installs | **MISSING** | — |
| S4.6 | Copy-text test banning "−15% vs −60%" | **MISSING** | no such test (grep) |
| S4.7 | Uncommitted tree | **RESOLVED** | clean at `c4f3e1c` |

### 2g. Memory audit-2026-10-23, copy-path items "still open"

| Item | Status in Krypto Copy | Proof |
|---|---|---|
| Copy exits off after restart | **BUILT** (differently) | `managesExits` `copyTrade.ts:527-529` |
| Buys exact-out at quote×(1−slip), fee on the full budget | **MISSING** (not ported) | `txBuilder.ts:1484-1488`; PumpSwap `pumpSwapBuilder.ts:279-286, 509` |
| Loss-guard pre-balance at confirmed vs sim at processed | **MISSING** (not ported) | `liveSigner.ts:957-960`; `rpcClient.ts:774` default `'confirmed'` |
| `broadcast.ts` expiry says "did not land" when the status read fails | **MISSING** | `broadcast.ts:680-687`: `fin` not ok → `s = null` → `expired: true`; `liveSigner.ts:1133-1148` reports definitive failure |
| Pump V3 log lines blind the watchdog | **MISSING** | `pumpDecoder.ts:168-173` matches only plain Buy/Sell |
| Nav-guard prefix hole | **MISSING** (not ported) | `webSecurity.ts:96-99` |
| `wallet:remove` confirmed in the renderer only | **MISSING** | `ipc.ts:1569-1572` |
| Referrer dropped for the session on one failed probe; redaction gaps; asar fuse; priority-feed resubscribe; Helius budget socket; `blockFeedAmm` double count; Boop allowlist | **UNKNOWN** (not re-verified) | reviewer-reported only, in the memory note |

---

## 3. Corrections to the prior docs

- **10-22 "Built" table, #2 double mirror.** The fix is not "acted on once, whichever arrives first" at no cost. It trades an over-sell for an under-sell when the firehose's recovered fraction is low (R1, measured). The 10-21 doc asked for "a later upgrade only tops up the difference". That top-up was not built.
- **10-22 §3 P2 stale-fill bug is still there.** Memory says "wins judged on the whole trip" etc. were built, but `walletScout.ts:336-341` still checks staleness only on a branch where `at < due`. So it can never be true, as the 10-22 audit said.
- **10-21 §7 P3 "per-firehose-trade full scans"** is half fixed. `markToMarket` still walks every row on each print (`copyTrade.ts:3412`).
- **Doc line numbers.** Most 10-21 `copyTrade.ts` citations have drifted by +200 to +900 lines (for example `routeSell`/`closeOpen` are now around `:2257`, and the live buy gate is at `:2893-2925`). Use the table above.

---

## 4. Top 15 open items, ranked by money at risk for a live user, then honesty of the record

Every fix below must keep the order-safety rules: exactly once, breakers block buys and never sells, restart means paused, no retry after an unknown broadcast, and partial sells never go through `buildLocalTrade`. It must also keep the honest-null rule: unknown is null, never 0, and numeric filters fail closed.

**1. The first-delivery-wins mirror under-sells (R1).** Files: `electron/engine/copyTrade.ts` (`mirroredSells` `:1183-1190`, `closeOpen` `:2303-2318`, `recoverFraction` `:1540-1575`), `test/copytrade.test.mjs` (the double-mirror block `:2870-2930`).
*Sketch.* Keep `mirroredSells` keyed by `config:signature`, and store the fraction acted on and its source (`'recovered' | 'exact'`). When a later delivery carries an exact `soldFraction` greater than the recovered one, act once more for the difference only. Compute it against what is left: `topUp = (exact − done) / (1 − done)`, as its own exit slice with the note "top-up after the exact size arrived". Then mark the key `'exact'`, so nothing acts a third time. If `exact ≤ done`, record nothing; a sell can't be undone. Never top up from a second *recovered* value. Separately, have the leader-balance read in `recoverFraction` ask at `processed`, which `getTokenBalanceForMint` doesn't take today, or skip the 3 s cache for a sell. Pin with R1's three cases: 100% → [50, 100], 40% → [29, 16], control → [40].

**2. Open copies drop out of the book at 2,000 rows (R2).** Files: `copyTrade.ts:53, 954-958, 2416`; persist `:348`.
*Sketch.* Truncate only what is safe to forget. When over the cap, drop the oldest `skipped` rows first, then closed rows. Never drop an `open` row, or an `exit` slice whose parent is open. If open rows alone exceed the cap, keep them all and log once. Persist the same filtered list. Pin with R2: 2,000 skips after an open live copy, then a leader sell places exactly one order.

**3. An unreadable final status is reported as "did not land".** Files: `electron/engine/broadcast.ts:677-687`, `electron/engine/liveSigner.ts:1133-1148`.
*Sketch.* In the expiry branch, if `getSignatureStatuses` failed (`!fin.ok`), return `{ landed: false, expired: false }`. That makes the signer report `stage: 'pending'` (`liveSigner.ts:1133`), and the copy already opens a row on `res.pending === true`, reconciled later by the ledger. Only a successful read with a null status means expired. This keeps rule 4 (no retry against unknown state): the tx is never re-sent, only booked as maybe-landed. Test: a mocked failing status read past `lastValidBlockHeight` returns pending.

**4. A missed exit leaves a bag with no backstop and no alert.** Files: `shared/copytrade.ts:762-777` (`simpleConfig`), `electron/main.ts:836-847`, `electron/engine/copyTrade.ts` (late-sell record path, `checkLeadersAfterBoot` `:1445`), `electron/engine/engine.ts` (`notify`).
*Sketch.* (a) Give `simpleConfig` a long `exitMaxHoldMin` backstop (for example 1,440 min). It is an own exit, so it already re-arms from boot under rule 3. The user decides the exact value. (b) Route four copy events through `engine.notify`, off for fills but on for these: "leader left while closed" (from `checkLeadersAfterBoot().gone`), "sell too old to mirror, you still hold it", "trade unreadable, not copied", "mirrored sell failed". Notifications are not toasts, which respects the no-engine-toasts rule. Rate-limit them at 6 an hour.

**5. Unreadable leader transactions and a sell read before its buy.** Files: `electron/engine/walletWatcher.ts:622-630`, `electron/engine/copyTrade.ts:1350-1363, 2257-2264, 2575-2590`.
*Sketch.* (a) When an unreadable signature exhausts its tries, schedule one delayed re-read (for example at +20 s and +60 s, inside `LATE_EXIT_MAX_AGE_MS`), and remove it from `seen` only for that retry. It is a read, not a trade, so rule 4 doesn't apply. Then record a `skipped` copy row "their trade could not be read". (b) When `closeOpen` finds no row and no flight, remember the sell in a short `recentSells` map (`config:mint` → `tradeAt`, 60 s). The buy gate refuses a buy whose `tradeAt` is before a remembered sell, the same way `staleBuys` does, and records the reason.

**6. Concurrent same-mint buys and parked exits overwrite each other.** Files: `copyTrade.ts:1322-1323, 1350-1363, 1492-1499, 2597-2604`.
*Sketch.* Make `buysInFlight` a counter per key (`n`, `submitted` per entry), or key it by `config:mint:seq`. `parkExit` then sees any in-flight buy, and the `finally` decrements instead of deleting. Make `pendingExits` a list: on drain, apply the fractions in order (30% then 30% → 51% of the original, as two slices). Each still passes through `mirroredSells` by signature, so it stays exactly once. Persist the list (it is already in `persist` `:354`).

**7. Nav guard accepts `http://localhost.evil…`.** Files: `electron/system/webSecurity.ts:94-104`; port KryptSniper's `shared/appUrl.ts` and `test/appurl.test.mjs`.
*Sketch.* Parse the URL and allow only the exact packaged `file://…/index.html` and the exact dev origin (`http://localhost:5273`). Everything else gets `preventDefault` and an `https:` hand-off. Add `drop`/`dragover` `preventDefault` in `src/main.tsx`. Why it ranks here: a remote page in the top frame would get the preload's `window.krypt`, which includes copy save and arm. Exploitability is unknown (estimate: needs a navigable link in app content).

**8. No mint-safety check on non-pump copy buys.** Files: `electron/engine/engine.ts:911-939` (copy `tokenFacts`), `electron/engine/copyTrade.ts` (filter block near `:2707`, `needsFacts` `:2664`), `electron/engine/risk.ts`, `electron/engine/mintExtensions.ts`.
*Sketch.* Add `safety: { hardReject: string | null } | null` to the facts the host returns. Read it with `checkMint` only when the mint is not pump-created (`isPumpfun` false), and in parallel with the summary. Hard reject → `skipped: unsafe mint — <reason>`. Unreadable → fail closed for non-pump mints only, recorded as "safety unknown". Pump mints skip the read, so an RPC outage doesn't block the pump rail (10-21 skeptic). Add `safety` to `needsFacts`' derived list, so the existing test catches a missing entry. Buys only, never sells (rule 5).

**9. No exposure, max-open or per-leader stop.** Files: `shared/copytrade.ts` (`CopyConfig` `:87-202`, `validateConfig` `:834-866`, `simpleConfig`), `shared/types.ts` (execution settings), `electron/engine/copyTrade.ts` (`limitHit` `:934-951`), `src/pages/Following.tsx` (rule chips).
*Sketch.* Add `maxOpen` per config, plus `copyMaxOpenTotal` and `copyMaxExposureSol` per chain in settings. `limitHit` refuses a buy when open copies or open cost at entry (live rows only, unpriced counted at cost, never 0) would exceed either. A per-config drawdown stop on realised plus marked PnL sets `enabled = false` and records an "auto-paused" row. Exits keep running through `managesExits` (rule 5). Defaults come from the user's preset decision; the doc's numbers are estimates.

**10. EVM live copies have no per-trade cap and no minimum.** Files: `electron/ipc.ts:3050, 5749-5755`, `shared/evm.ts` or settings, `electron/engine/copyTrade.ts:2897-2910`.
*Sketch.* Give each EVM chain a `maxLiveNative` setting and return it from `maxLive(chain)`. The existing refusal at `:2898` then applies. A null cap on a live EVM config refuses with "set a live max for BNB", instead of passing. Add an EVM minimum (gas-share based, labelled an estimate until measured). Return `createdAt`/`creator` from the EVM summary when known, null otherwise (they already fail closed).

**11. Port exact-in buys and the processed pre-balance.** Files: `electron/engine/txBuilder.ts:1484-1488`, `electron/engine/pumpSwapBuilder.ts:279-286, 505-530`, `electron/engine/liveSigner.ts:957-960`; KryptSniper commits from 10-23 as the source.
*Sketch.* Port `buy_exact_sol_in` (curve) and `buy_exact_quote_in` (PumpSwap) with min-out = quote×(1−slip). The legacy `buy` stays only on the learned-template fallback. Pass `'processed'` to `getBalance` in the loss guard. Re-pin the fee interlock and canary tests: the fee is still computed on `solLamports`, which now equals the spend. Why: at the default 15% copy slippage, every live copy buys about 15% fewer tokens than sized while paying Krypt's fee on the full budget (code; KryptSniper measured 0.008836 spent of 0.01 asked at 12%).

**12. Remove still drops open live copies.** Files: `electron/engine/copyTrade.ts:420-445`, `electron/ipc.ts:5887-5891`, `src/pages/Following.tsx:118-133`.
*Sketch.* Give the confirm two choices when open rows exist: "Stop and keep managing exits" (`enabled = false` plus a `retiring: true` flag that hides the card; `remove()` then runs only when the last open row closes) and "Stop and sell now" (queue one exit per open row through `closeOpen` with a synthetic 100% sell, live rows only, exactly once). Plain Remove stays for configs with nothing open.

**13. Tx-transport trades are undated.** Files: `electron/engine/walletWatcher.ts:520-556`, `electron/engine/copyTrade.ts` (`ageOf`).
*Sketch.* On a push with a slot and no `blockTime`, read `getBlockTime(slot)`. Cache it per slot, run it in parallel with the hand-off, and don't let it block the copy. Stamp `tradeAt` when it returns. Until then, `ageOf` treats the trade as fresh, as today. A push delivered after a reconnect backlog (the first N after reconnect) waits for the time before buying, so the 60 s entry-age gate works on this transport. `detectMs` stays null unless a time is known (honest null).

**14. The Copy score drops dead coins, and scans take stale fills.** Files: `electron/engine/walletScout.ts:318-322, 330-362, 545-558`, `shared/walletScore.ts:98-101`.
*Sketch.* (a) In `resolvePending`, test `at − due > FOLLOWER_FILL_STALE_MS` *before* the `at >= due` fill, for both legs. Also sweep at the end of every scan batch, not only every 1,000 notes. (b) For a no-exit trip whose follower entry was filled, record a priced return at the last known print, or −100% when the pool is drained, flagged `deadCoin`. Show it in the score as "includes N dead coins", so the score stops rewarding wallets whose coins went to zero. Scores will fall; ship with wording so users don't read it as a bug.

**15. Transfer-out and stable-sell exits (split counter first).** Files: `electron/engine/walletSwap.ts:115-160`, `electron/engine/walletWatcher.ts:78-80, 529, 586`, `shared/copytrade.ts:510`.
*Sketch.* Step 1 (S): have `decodeWalletSwap` return a reason for null (`transferOut`, `stableSell`, `tokenForToken`, `dust`, `other`), and count each in the watcher stats shown on the card. Step 2, after a week of counts: as a per-config option defaulting to on, a `transferOut` of a mint we hold raises a proportional synthetic exit labelled "they moved the coins out", priced only from our own fill, never from theirs. It goes through `closeOpen` and `mirroredSells`, so it stays exactly once.

Just below the cut, in rank order:
- referrer ≠ leader (#14 of 10-21);
- `app:openExternal` URL pinning (S2.13);
- Record live: the cost unstated and the full engine started (S2.2/M3);
- "recorded" counting sightings, and the scan's dropped `complete` flag (#11, #18);
- the trade-rate bot rule and the warning labels (10-22 #9/#10);
- the test-only `.tmp` write (clear `saveTimer` in `_reset`).

---

## 5. Open questions

- How often does the firehose's leader-balance read see the pre-sell balance live? This needs a log line in `recoverFraction` (sold, after, final watcher fraction) for a day of real follows. R1 shows the consequence, not the frequency.
- How many rows a day does a typical config write, and so how soon does R2 bite? There is no `copytrade.json` with real records on this machine (10-21 doc).
- Are the Token-2022 fee and hook paths in the local builders correct? Does `copySells` interact correctly with own TP/SL? Both are still unchecked.
- Reviewer-reported 10-23 items not re-verified here: referrer dropped on one failed probe, redaction gaps, the asar integrity fuse, priority-feed `accountSubscribe` after reconnect, the Helius budget cut-off socket, the `blockFeedAmm` double count, the Boop allowlist.
