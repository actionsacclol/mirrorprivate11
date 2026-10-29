# What "the best copy trader" means for Krypto Copy

Research swarm, 2026-10-21. Six angles: competitors, latency, where a follower edge could exist, an audit of our own engine, risk/exits/UX, and adversaries. This file is the synthesis. Every claim is labelled **measured** (ours or a peer-reviewed author's), **code** (read from our source, file:line), **vendor** (a company describing its own product), or **estimate** (our inference). Where something is not known, it says unknown.

Spot-checked by the synthesis lead on 2026-10-21 (code read, not run): the win-rate x100 bug (`src/pages/CopySimple.tsx:262` against `shared/copytrade.ts:864-867`), live configs disarmed on load (`electron/engine/copyTrade.ts:274-280`), watch list and own exits gated on `enabled` (`copyTrade.ts:460-462`, `:2975-2977`), `routeSell` "upgrade" with nothing writing a recovered fraction back to `handledSells` (`copyTrade.ts:1012-1033`, `:1978-1979`), paper side cost `0.01 + FEE_BPS` (`copyTrade.ts:1141`), exit priced at `t.priceSol` (`copyTrade.ts:2016`), keyless Sender URL (`electron/engine/broadcast.ts:40`), `BLOCKHASH_TTL_MS = 20_000` (`electron/engine/txBuilder.ts:66`), pump feed default commitment `processed` (`shared/types.ts:1110`). No `jitodontfront` and no `checkMint`/`hasHardReject` call in the copy engine (grep).

---

## 1. Bottom line

1. Copying memecoin wallets loses money on average. We measured that in two periods (9.3M curve trades). No decile of followable wallets was positive, even ranked by what a follower would get. No outside source, academic or vendor, shows the opposite after costs. "Best copy trader" can't mean "the one that makes followers money". Nobody can honestly claim that.
2. What we can win on: **an honest record** (every product grades leaders by the leader's own PnL; only our Copy score grades what a follower would get), **not losing money to our own bugs**, **safety** (local keys, mint checks, price caps, cluster flags) and **measured speed** (no one publishes a same-slot rate).
3. Today the honest record is not honest enough. Paper copies leave out about 7 points of fixed fees per 0.05 SOL trade. PnL is priced at the leader's exit, not our fill. Paper and live rows are mixed in one record. The Copy score drops dead coins. Fix these first: they are what users decide on.
4. There are correctness gaps that cost users money. Live copies stop managing exits after every restart, a partial sell can be mirrored twice on the pump path, and transfer-out exits are invisible. These come before any growth push.
5. What we can't win on: same-slot copying from a desktop (it needs a co-located box), and an edge that the data says isn't there. Before paying for any speed, run the free lag replay (H1 below). If 1 s of lag is still negative in every decile, speed only makes losses smaller.
6. On referrals: the user restated 20% of our 0.5% fee for the referrer named at onboarding. That is 0.1% of each trade, the lowest referrer payout we found (others pay about 0.25–0.47% of each trade). This report treats it as the user's decision, not a build item. Two notes are attached in §6.

---

## 2. Where we stand against competitors

Sources: vendor docs fetched 2026-10-21 unless marked. "—" means unknown or not documented.

| | Krypto Copy | GMGN | Bloom | Trojan | Axiom | Fomo | Maestro |
|---|---|---|---|---|---|---|---|
| Custody | Local, encrypted on the user's machine | Server-side bot wallet | Server-side bot wallet | Server-side bot wallet | Web app; an employee allegedly unmasked wallets via support tools (2026-02-26, news) | Mobile app | Server-side bot wallet |
| Chains | Solana, BNB, Robinhood | SOL only (copy) | SOL, Base, Robinhood, BSC (incl. Fomo profiles) | SOL | SOL | SOL, Base, BNB, Monad | ETH/BSC + others |
| Fee per side | 0.5% | 1% | 1% | 1% (0.9% referred) | 0.75–0.95% net | 0.5% | — |
| Referrer share per trade | 0.1% (20% of 0.5%) | — | — | 0.275–0.475% (27.5–47.5% of fees) | ~0.3% (third party) | — | — |
| Paper mode | Yes, default; every skip recorded | No | No | No | No | No | "Track only" |
| Follower-side wallet score | Yes (Copy score, 2 s lag, 1.5%/side) | No (leader-side radar) | No | No | No | Public profiles (leader-side) | No |
| Sell mirroring | By fraction, base units, from confirmed fills | Stops once TP/SL is set | Copy sell + copy limit orders | Copy sell (same %) or auto-sell | No copy (tracker + alerts only, per its docs) | — (unclear if copy is automatic) | Yes |
| Sell on transfer-out | **No** | — | Yes (required for Fomo profiles) | — | — | — | — |
| Dev-sell / migration / time exits | **No** (scripts only, `shared/automation.ts:2005`) | Dev sell, migrated sell | Dev sell, time, trailing, mcap, mcap change | Auto-sell limit orders | — | — | — |
| Staleness gate | Age only (60 s + delay) | — | Max Slot Diff | — | — | — | Next block after mined |
| Entry price guard vs leader | **No** | No | No | Max spend per buy | — | — | — |
| Mint-safety check on copy buys | **No** (scanner only, `engine.ts:32,6443`) | Burnt-ratio filter | — | — | — | — | — |
| Recommended slippage | 15% default, cap 50% (`shared/copytrade.ts:739-740,779`) | 30–35% auto, 50%+ new tokens | — | User-set | — | — | — |
| Published same-slot rate | No (no live timing on record) | No ("millisecond-level", no number) | No | No | No | No | No |
| Watch-only alerts | **No** | Alert bot | — | — | Yes (its whole offering) | — | Track only |
| Bulk import / username copy | **No** | — | Mass Create, Fomo usernames | — | Imports BullX lists | — | — |

Market context: Fomo held 46% of Solana trading-platform spot volume on 2026-08-24 (Blockworks dashboard, via Solana Compass). Axiom fell from about 44.6% to under 30%. pump.fun now owns Padre (now Terminal), Kolscan (a KOL leaderboard) and Vyper. Two 2026 trust incidents favour a local-first design: the Axiom insider allegation (2026-02-26), and TradeWiz's key exposure, which drained 20,932 wallets of about $459K (2026-09-30, Bitquery on-chain investigation).

Speed claims across the field are vendor-only. OdinBot went from "15% same-block" (sponsored article, 2025-04) to "up to 65%" (its own test), and its speed dashboard returned nothing to our fetch.

---

## 3. Ranked roadmap

Impact is about what the user ends up with (money kept, a record they can trust), not engagement. Effort: S = days, M = 1–2 weeks, L = several weeks, XL = a quarter.

### Build now

| # | Item | Impact | Effort | Risk | Evidence | How we know it worked |
|---|---|---|---|---|---|---|
| 1 | **Manage exits independently of `enabled`.** Keep watching every leader with an open row, and always run mirrored sells and own exits for it. `enabled` and the restart disarm gate entries only. The card says "Entries paused, exits still managed". | High | S | Exits fire on a config the user thinks is off. Mitigate with card text and a per-config "stop managing exits" switch. | code: `copyTrade.ts:274-280` (disarm on load), `:460-462` (watch list), `:1086` (router), `:2975-2977` (own exits). UI promises otherwise: `Wallets.tsx:1145-1149`. | Test: restart with an open live row, deliver a leader sell, and the row closes. Live counter: open rows that sat through a restart unmanaged = 0. |
| 2 | **Close the double-mirror.** When `closeOpen` recovers or acts on a fraction for signature S, write it into `handledSells`. A later "upgrade" only tops up the difference. Add a test with a firehose trade that carries `tokens`, followed by the watcher delivery. | High | S | Low | code: `copyTrade.ts:1028-1031` (upgrade), `:1978-1979` (recover and sell); nothing else writes `handledSells` (grep). Existing test `test/copytrade.test.mjs:1427-1447` passes no `tokens`. | The new test is pinned. Live: no signature with two mirrored exits in copytrade.json. |
| 3 | **Price the record from our own fills, and split paper from live.** The host's sell returns proceeds and soldRaw. Entry uses the reconciled fill. Paper exits use the first print after detection plus the delay, not the leader's fill. `statsFor`, `todayFor` and `limitHit` filter by `t.mode`. Pending PnL shows an em dash. | High | M | PnL is null more often while it reconciles. Older rows must be labelled with a model version. | code: `copyTrade.ts:2016` (exit = leader price), `:1687-1691`, `:64-87` (no proceeds); `engine.ts:777-791,824`; `copyTrade.ts:466-490,766-769,810-823` (no mode filter); `Wallets.tsx:77-93`. Contradicts the "harsh fills" claim in `docs/copy-trade-competitors-2026-09-21.md:171`. | Live: the gap between our realised PnL and the chain-ledger PnL for copy signatures is about 0 (pnl-from-chain rule). Test: a paper-to-live switch leaves live stats at zero. |
| 4 | **Paper fidelity.** Charge `paperFixedFeeSol('fast')` on both legs, use the venue's real side fee (pump curve 1.25%), add size-aware impact from curve or pool reserves, and fix the "1%/side protocol fee" wording. | High | S | Old paper records become non-comparable, so stamp the model version. | code: `copyTrade.ts:1141` (`SIDE_COST = 0.01 + FEE_BPS`); `shared/exitBudget.ts:163,234,242-246` used only at `engine.ts:2258,7154`. measured: about 0.0035 SOL per round trip, which is 7.0% of a 0.05 SOL copy (`docs/breakeven-swarm-2026-09-28.md`). The same fix was made for scripts on 09-28. | "Paper optimism" (paper PnL minus live PnL on the same leader trades) tends to 0 on users who run both. |
| 5 | **Store the leader's fill and add an entry-premium guard.** Put the leader's fill price on every copy row. Refuse when our send-time price is more than X% above it, and record the refusal with the premium. Show the median premium per leader. | High | M | Thresholds are guesses (see §8). Start in paper and tune from the recorded distribution. | code: no leader price on `CopyTrade` (`shared/copytrade.ts:298-360`); entry at the mark (`copyTrade.ts:2389`); only an age gate (`:2460-2465`). vendor: Binance and Matrixport skip copies more than 0.3–1.5% off the lead's price (figures differ by source). | First a premium distribution per venue (it doesn't exist today). Then, on paper, guarded configs have a median at or above unguarded ones on the same leaders. |
| 6 | **Mint-safety check on every Solana copy buy, on by default.** Reuse `risk.ts` `checkMint`/`hasHardReject`: freeze authority on a non-pump mint, permanent delegate, non-transferable, default-frozen, a transfer hook outside an allowlist, a transfer fee at or above X bp. Fetch it in parallel with the build. Fail closed. | High | S | One cached getAccountInfo per new mint. RPC outages become skips. | code: `risk.ts` is imported only by the scanner (`engine.ts:32,6443-6455`); no call in `copyTrade.ts` (grep). Incident: permanent-delegate burns about 7 s after purchase (Cointelegraph, 2024-09). | Skip reasons show `unsafe mint` rows. No live copy into a hard-reject mint. |
| 7 | **Classify non-swap leader exits.** `walletSwap` emits `transferOut` (token out, no SOL leg) and `stableSell` (token out, USDC/USD1 in). The copier raises a proportional exit with a note, as a per-config option. Accept USDC/USD1-legged buys through a cached SOL/USD rate. | High | M | A transfer to the leader's own cold wallet isn't a sale, but it is the leader leaving that wallet. Label it that way and never infer a price. | code: `walletSwap.ts:153-160` returns null; `walletWatcher.ts:580-582` counts it as notSwap. vendor: Bloom and TradeWiz ship sell-on-transfer, and Bloom requires it for Fomo profiles. CCS'26 documents many-to-one dumps (DP1). | Count of exits by cause (mirrored, transfer-out, stable-sell, own exit, hand sell). Open rows whose leader balance is 0 tend to 0 (90 s sweep). |
| 8 | **Measure in slots, plus realised slippage.** Add `leaderSlot` and `ourSlot` to `CopyTiming` and show the median slot gap. On the tx transport, stamp `tradeAt` from slot time so the stale guard stays on. Show our fill against the leader's fill as a %, labelled "derived" on routed swaps. A paper copy shows an em dash for slot gap. | High | S | One status read per landed copy. | code: `walletWatcher.ts:530-545` (detectMs null on tx push); `leaderFeedFrames.ts:90` (slot parsed but unused). No live "copy timing" line exists in any app log folder (grep, 2026-10-21). | We publish our own median slot gap, the number the whole field markets without measuring. |
| 9 | **Free latency fixes.** (a) Key the Sender lane with the user's Helius key when present (50 rps, not 1), warm it with GET /ping, and offer regional endpoints. Use a regional Jito endpoint. (b) Cut `BLOCKHASH_TTL_MS` to about 8–10 s for 200 ms slots and fix the "~400ms" comments. (c) Take `tokenFacts` off the serial path: run it in parallel with build and simulate, derive curve/PumpSwap liquidity from reserves, and drop the signed tx if filters refuse. (d) BNB: subscribe over the publicnode WSS that is already configured, and keep the 6 s poll as catch-up. | Medium | S–M | (a) The key must be redacted in logs. (c) A signed tx must never escape on refusal; pin with a test. (d) Public WSS drops, so keep gap recovery. | code: `broadcast.ts:40`, `prewarm.ts:69`, `jitoTips.ts:21-26`, `txBuilder.ts:66`, `copyTrade.ts:2254-2471`, `evm/scanner.ts:25-28,79`, `evm/chains.ts:170-174`. vendor: Helius Sender limits; Solana Compass reports 200 ms slots since epoch 1053 (2026-10-09). | Median slot gap (item 8) before and after. Sender 429 count = 0. BNB detection delay goes from about 3 s mean to about 1 block (estimate). |
| 10 | **Bankroll risk model and breakers.** The user declares a copy bankroll B per chain. Defaults derive from it: size 5% of B, max 3 open per config and 6 overall, open exposure 30% of B, daily loss 15% of B (live rows only), and a per-leader drawdown stop at 40% of that leader's allocation, realised plus marked. Unpriced exposure blocks new entries. Live breakers are required while any copy is armed. Apply the 0.03 SOL live minimum, or show the fee share. Add a cross-config "already holding" dedupe. **Fix Copy Simple's 0.1 SOL default against the 0.05 SOL live cap.** | High | M | Breakers that trip on ordinary losses annoy manual traders, so scope them to copy arming. Marks must fail closed. | code: `copyTrade.ts:820-823` (realised only), no exposure field (`shared/copytrade.ts:85-200`), `CopySimple.tsx:47` vs `shared/types.ts:1180`, breakers default 0 (`types.ts:1184-1185`). measured: stops fill at 0.53x entry on average (`docs/breakeven-swarm-2026-09-28.md`), so size is the only binding loss control. vendor: eToro's copy stop-loss defaults to 40%. | No live session loses more than its declared caps. A Copy Simple follow switched to live is not refused at the default size. |
| 11 | **Make the Copy score honest.** Price dead-coin trips at a loss, not "unreachable". Add own impact at the user's size. Count trips the leader never closed as marked open. Mirror partials. Use the session's measured lag instead of a fixed 2 s. Exclude prints by the leader, its cluster, and WT1 wash prints, and use a short VWAP. Use the same fill model in `walletScout.ts` and in the offline scripts. | High | M | Scores drop for many wallets. Update the wording so users don't read it as a bug. | code: `walletScout.ts:239-242,244-259,265-276,287-296,425-446`; `shared/walletScore.ts:30-37`. measured: the CCS'26 WT1 rule is near-zero false positives. | The offline replay and the in-app score agree on the same tape day. Score inflation (old minus new) is published once. |
| 12 | **Watch-only direction and alerts through `engine.notify`.** Typed events (first buy, buy more, partial sell, full sell, transfer out, config auto-paused, mirrored sell failed, daily summary per mode) go to desktop notifications and the paired read-only chat bots. Top-right toasts only for errors (no-engine-toasts rule). Watch-only is onboarding step 1. | Medium | S–M | Rate-limit. No addresses or keys beyond what `bots.push` allows. | code: no `notify(` in `copyTrade.ts` (grep); `main.ts:905-911`. vendor: Axiom's whole "copy" offering is tracking plus alerts; GMGN and Trojan have alert bots. | The share of users who watch before they paper, and paper before they go live. |
| 13 | **UX and honesty fixes.** Fix the win rate x100 (`CopySimple.tsx:262`). Show an em dash, not "+0.0000", when nothing has closed (`CopySimple.tsx:254-258`). Show n beside win rate, and "too few to judge" under 30. Remove must name open live positions and offer "keep managing exits" (`copyTrade.ts:383`, `Wallets.tsx:738-741`, `CopySimple.tsx:117-121`). Sort followed leaders by follower-realised return, not their PnL (`Wallets.tsx:654`). `copy:resetStats` should accept 0x (`ipc.ts:5888-5892`). Fix the in-flight map clobbering, count per (config, mint), so add-on buys don't orphan (`copyTrade.ts:2146,2150-2152,2468,1962-1966`). | Medium | S | Low | code as cited. | Tests per fix. |
| 14 | **Referrer cannot be the leader.** If the configured referrer equals the copied leader, or any wallet in a FOMO set, that copy's whole fee goes to the treasury. Onboarding says in plain words that the referrer sees each trade as it lands. | Medium | S | Touches the fee interlock and referral canaries, so re-pin the tests. Doesn't catch a referrer using a separate payout wallet; disclosure covers that. | code: `liveSigner.ts:742-746` checks only treasury and owner. | Test pinned. |

### Measure first (do not ship as a default until the number is in)

| # | Item | Effort | What decides it |
|---|---|---|---|
| M1 | **Lag replay (H1 plus the lag curve).** Re-run followability on the tape at 0.4, 0.6, 1.0, 2.0, 4.0, 30 and 120 s, with impact and dead-coin losses. **This gates all paid speed work.** | S | If no decile reaches breakeven at 0.6–1.0 s, don't fund M3. |
| M2 | **jitodontfront plus a sandwich detector on our own fills.** Check the same slot for a same-signer buy before us and sell after us on the pool. Record it per slippage setting. Then decide on `mevMode: 'private'` for copy buys. | S | Victim rate by slippage band. Test first whether the pump and PumpSwap instructions tolerate an extra read-only account; otherwise put it on a memo or tip instruction. |
| M3 | **$49/mo Helius Developer path: speculative prebuild.** On a `preprocessedSubscribe` hit for a followed wallet, decode, prefetch facts, then build and simulate. Send only on the confirmed `transactionSubscribe` push with a successful meta. Estimate: 0.5–1.0 s end to end, 3–5 slots. | L | Only if M1 shows a lag benefit. preprocessedSubscribe is in beta, and its phantom rate after Alpenglow is unknown. |
| M4 | **Crowding / "farms copiers" metric and cohort flags (H3, H4).** Count net buy inflow from other wallets 0.3–3 s after the leader, and whether the leader sells into it. Flag funder and co-buy clusters. | M | Held-out test in §5. Show descriptively as "N buys within K slots after theirs", never as "N copy bots". |
| M5 | **Copy-scoped exit ladder** (dev sell, migration, fixed mcap, multi-rung TP, first leader sell = full exit, leader-health breaker), run beside `copySells`. | M | A counterfactual exit panel on paper: each rung's result on the user's own leaders against pure mirroring. measured so far: mirroring both legs (−4% to −7% median) beats a 60-min hold (−15%). |
| M6 | **Counterfactual exit and skip panel.** For every copy, what the alternative exits and the skipped copies would have returned, from the same tape. | L | It is the measurement tool for M5 and for every filter. Coins that stop printing are unknown, not zero. |
| M7 | **R1–R4 "skip dead launches" switch** computed from tape already in memory. Show supply-share flags as warnings with both numbers, never as default skips. | M | measured at launch level: R1–R4 remove 70.5% of dead launches and hide 9.6% of graduations, while supply-share FAILs hide 57% of graduations and are worse than the base rate (`docs/rug-filter-2026-08-30.md`). The effect on leader-bought coins is unknown. |
| M8 | **Leader import** (pump/Fomo username, bulk paste) creating paper or watch-only configs. | M | Whether a Fomo profile can be resolved to a wallet at all is unknown. First decode a real Fomo exit (ERC-4337 on EVM, DFlow routing). |
| M9 | **EVM honeypot simulation and `maxTaxPct`.** Buy then sell in one `eth_call` with state overrides. Also: EVM live cap (`ipc.ts:5743` returns null), createdAt and creator from the scanner book, and post-graduation DEX trades for followed wallets. | M–L | Whether public BNB RPCs accept code overrides of that size is unknown. |

### Don't build

| Item | Why not |
|---|---|
| LaserStream gRPC ($499+/mo), shred feeds ($800–1,000 per IP per month, plus co-location and UDP), preconfirmations ($999 plan) | A desktop app can't co-locate. Jito ShredStream was sunset on 2026-09-05. For a few dozen wallets, Enhanced WS carries the same data. |
| Sender Max / Nozomi / Falcon as defaults (0.001 SOL tip) | That's about 1% per side on a 0.1 SOL copy, which is more than our whole fee, for about 1–2 slots (vendor-claimed). At most, offer an opt-in for copies of 1 SOL or more. |
| FOMO direction as a default, or promoting reverse copy | measured: FOMO goes from −14.9% to −32.1% as K rises (`docs/wallet-convergence-2026-09-14.md`). Reverse has never been measured (prior below 3%). Keep both paper-first and show the result in the editor. |
| Treasury rotation or deferred fees to hide the fingerprint | Bitquery attributed apps that rotate a dozen or more fee wallets. Copy timing alone identifies copiers anyway. Deferring fees would break the buy-side fee interlock. Disclose instead (§6). |
| Conviction-scaled sizing | Wait for H2. On a curve, a bigger leader buy also widens the follower's entry gap. |
| Any "fastest" or "profitable" marketing claim | No live copy timing exists on this machine. No decile is positive. Only measured slot-gap numbers (item 8). |

---

## 4. Latency budget: today and what is achievable

**Chain changed this month.** Solana has run 200 ms slots since epoch 1053 (2026-10-09; the first epoch averaged 218 ms, reported by Solana Compass), so a blockhash now lives about 33 s, not about 60 s. Alpenglow/Votor is scheduled to activate today (about 14:50–15:30 UTC). After that, confirmed is expected to arrive about 150 ms after processed. That is an expectation; whether it activated is unknown at time of writing. Our code still assumes 400 ms slots (`broadcast.ts:566` comment, `txBuilder.ts:66` TTL 20 s).

**Nothing end to end has been measured live.** No log folder on this machine has a single `copy timing` line. The only end-to-end figure is a tester's 5–6 s, timed by eye before the 09-21 backoff fix. The 900/740/620 ms line in `docs/copy-latency-2026-09-21.md` is illustrative.

| Stage | Today, default free path | Source | Achievable, free (items 8–9) | Achievable, $49/mo Helius Developer (M3) |
|---|---|---|---|---|
| Leader block → we hear it | Public WSS logsSubscribe at confirmed. Measured 150–578 ms behind Helius on the same events, with 8–25% feed loss in one night. | measured (`docs/copy-trade-competitors-2026-09-21.md:289-293`) | Same; race a second feed (estimate) | transactionSubscribe; preprocessedSubscribe for prebuild (0.1 credit per tx) |
| Read-back (getTransaction) | Common case: 120 ms sleep plus 2 round trips (about 57 ms public, 105 ms Helius each), so about 250–600 ms | code (`walletWatcher.ts:137,569-616`) plus measured round trips | Same | Removed (the push carries meta) |
| Checks / token facts | Unmeasured live; a cold `market.summary()` before the delay on the default $5k floor | code (`copyTrade.ts:2254-2259`) | Parallel with build, or reserves-derived: saves about 150–250 ms (estimate) | Prefetched on the preprocessed hit |
| User delay | 0 ms default | code (`shared/copytrade.ts:739`) | — | — |
| Build + simulate + sign | About 165 ms (warm build 63–76, sim 58–101, sign 1) | measured, 400 ms-slot era (order-latency-2026-09-18) | Same | Prebuilt before the confirmed push |
| Send → landed | Order to confirmed measured at 1.4–2.3 s; the land split was never recorded. Sender keyless at 1 rps. | measured total; code (`broadcast.ts:40`) | Keyed Sender, regional Jito; slot telemetry gives the real number | Same |
| **Leader block → our inclusion** | **About 2–4 s (estimate); tester 5–6 s (by eye, old)** | — | **About 1.5–3 s (estimate)** | **About 0.5–1.0 s, 3–5 slots (estimate)** |
| Same slot | Not reachable from a desktop | vendor (Helius: latency tests must run co-located) | No | No |

BNB: followed wallets are found by a getLogs poll every 6 s against 0.45 s blocks, so detection averages about 3 s and can take 6 s (code, `evm/scanner.ts:79`). A publicnode WSS is configured and was measured working on 09-09, but nothing subscribes to it. Fixing that needs no new vendor. 48Club and BlockRazor built over 96% of BNB blocks from May to Nov 2025 (arXiv 2602.15395), so their RPCs are a candidate broadcast option. Inclusion there is unmeasured.

| Cost option | Price | Worth it? |
|---|---|---|
| Helius Developer (transactionSubscribe, preprocessedSubscribe, keyed Sender 50 rps) | $49/mo; streams at 20 credits/MB | Yes as a documented upgrade; prebuild only after M1 |
| Chainstack Yellowstone / Triton Dragon's Mouth | from $49/mo add-on / $0.08/GB with a $125 minimum | No clear gain over Enhanced WS for a few dozen wallets |
| LaserStream gRPC | $499+/mo | No |
| Helius Shred Delivery | $800–1,000 per IP per month | No (desktop) |
| Paid landing lanes | 0.001 SOL per tx minimum | Opt-in for copies of 1 SOL or more only |

**What speed can and can't buy (measured).** In `docs/wallet-identity-2026-07-25.md`, about 26% of price is gone between a leader's print and the next print a follower could fill at, and copying lost money in all 24 lag/hold configs, including 500 ms. The leader's effect is price impact, not information. Speed cuts the loss; on present evidence it does not turn it positive. M1 is the free test that would overturn this.

---

## 5. Testable edge hypotheses, ranked by prior

Data available: curve-trade CSVs (`at,mint,user,isBuy,sol,tokens,price,curvePct,isSmart`) for 2026-07-26/27 and 2026-09-10/11 at `C:\Users\Krypt\Desktop\kryptware\KryptSniper\tape\trades\*.csv`. One raw day (`E:\data\2026-09-16.jsonl`, 8.4 GB, includes tape_amm). Whether the Raydium, Meteora, LaunchLab and Boop rails carry trader identity at scale is unknown.

**Common follower model** (fix it once, in `walletScout.ts` and in the scripts): entry is the first print at or after leader time plus lag. Cost is 1.25% pump side fee plus 0.5% Krypt plus fixed fees (`paperFixedFeeSol`), plus own curve impact at 0.05, 0.1 and 0.25 SOL from virtual reserves. A trip with no print for 10 min is priced at −100% (or at the last print, as a sensitivity check). Trips the leader never closed are marked at window end. Prints by the leader and its cluster, and WT1 wash prints, are excluded.

**Protocol for every hypothesis.** Pre-register thresholds. Train on day N, test frozen on day N+1 in both day-pairs, plus one fresh pair recorded after 2026-10-21. Use a control of random buys matched on curvePct and time of day. Report median, 1%-trimmed mean, win rate, and a block bootstrap by mint. Apply FDR across H1–H9. A result counts as positive only if it holds in every pair at 2 s lag, with impact and dead-coin losses included. (Why: the convergence study's first cut read +12.6% and was wrong three ways.)

Priors are the research angle's own estimates, not measurements. "Relative" means it beats today's ranking. "Absolute" means positive net returns.

| Rank | Hypothesis | Exact measurement | Prior (relative) | Prior (absolute positive) | Product use if true |
|---|---|---|---|---|---|
| 1 | **H3 Crowding is a negative filter** | Per leader: shadow wallets that buy the same mint 0.4–3 s after the leader on 30% or more of the leader's mints. Regress follower return on shadow count. Also: is the leader's sell within N s of the shadow buys? | 55–60% | about 3% | "Crowded: you'd be the exit" flag (M4) |
| 2 | **H6 Shrinkage / lower-bound ranking** | Rank by Bayesian-shrunk follower median, or the lower 80% bootstrap bound, instead of the raw median. Compare frozen test-day top-N with today's objective. Reuse `scripts/analysis/follower-rank.mjs`. Motive: decile 9 beat decile 10 in both periods. | about 40% | about 3% | Default Scout sort ("least bad", never "edge") |
| 3 | **H4 Cohort / twin exclusion** | Cluster by same-slot co-buys on K or more mints, identical trip records, or a shared funder within 1–2 hops. Compare follower return for cohort leaders vs solo leaders. | 35–40% | about 2% | Twin-wallet flag; exclude from score prints |
| 4 | **H5 Routine vs opportunistic** | Per wallet: trades per day and the CV of inter-trade intervals. Follower return by tercile. Needs 7-day windows, so likely more tape than we have. | about 25% | about 5% | Scout trait |
| 5 | **H2 Within-wallet conviction** | For wallets with 20 or more train buys, the size z-score against the wallet's own median and MAD. Top-quintile buys vs the same wallet's other buys, paired. Also check whether entry gap widens with leader size. | 15–20% | 3–5% | Conviction-scaled sizing (currently "don't build") |
| 6 | **H1 Lag-insensitivity (decisive)** | Per wallet, follower median at lags 0.4/0.8/2/5/30/120 s, and a lag-decay slope. Select the flattest on train, test frozen. Also report the pooled lag curve (M1). | — | 5–8% | The only kind of wallet that would carry copyable information. If none, say so in the product. |
| 7 | **H8 Low-competition venues** | First the entry gap (next print vs leader price) per venue: Raydium AMM v4/CPMM, Meteora DBC, LaunchLab, Boop. Then follower return. Prerequisite: identity in the tape, and 2 weeks recorded. | — | 5–10% (sample is the unknown; Boop is about 5 tx/day) | Venue preference |
| 8 | **H7 Exit discipline** | Disposition spread (PGR−PLR) and the loser/winner hold ratio on train, follower return on test. Does it decay for wallets that gain shadows? | — | about 5% | Scout trait |
| 9 | **H9 Reverse copy / own-exit** | Reverse: buy at the first print 2 s or more after a leader sell, exits +25% / −20% / 30 min. Own-exit: leader's buy as entry, 1.5x or 5 min. | — | below 3% (reverse), 3–5% (own-exit) | Show the result inside the reverse editor |

Expected outcome: mostly null on absolute returns, and a few negative filters that cut losses. That is the honest message to ship.

---

## 6. Adversarial defenses worth shipping

| Defense | Threat | Evidence | Cost of false positives | Ship |
|---|---|---|---|---|
| Mint-safety check on copy buys (roadmap #6) | Permanent-delegate burns, freeze authority, hostile transfer hooks | code gap: `engine.ts:32,6443`; incident: Cointelegraph 2024-09 | Low; `risk.ts` already treats pump create_v2 extensions as harmless | Now |
| Entry-premium guard (#5) | Buying the leader's exit; sandwich extraction up to 15% slippage | code: slippage is relative to our own quote | Fewer copies on fast coins, which likely lose anyway | Now (paper-tuned) |
| jitodontfront plus a sandwich detector (M2) | Sandwiching. 96% of 6.85M detected Solana sandwiches hit the pump curve or PumpSwap; at 20–50% tolerance, sandwiches are about 18x as frequent as at 1–3% (Bitquery via CryptoSlate; vendor data) | Protects only the Jito lane | Measure first |
| Cluster-resistant Copy score (#11) | A bait cluster pays fees to hold the price for 2 s and fake a good follower record | code: `walletScout.ts:244-259` takes the first print by any wallet. measured: WT1 wash is at least 8.26% of coins (CCS'26) | Fewer trips measured | Now |
| "Farms copiers" and creator-link flags (M4, H3/H4) | Leaders who sell into follower inflow; leaders trading their own cluster's coins | Bait wallets are described only in vendor guides; no independent named incident found. Creator funder clusters cut the creator count about 11x (CCS'26) | Overlaps fast momentum traders; descriptive wording only | After held-out test |
| Transfer-out exits (#7) | Dump hidden behind a fresh wallet (DP1: median 7 senders into one dumper) | CCS'26 §5 | Exits a bag the leader moved to its own cold wallet; labelled | Now |
| Live arming gated on our own observation | Imported "smart money" or KOL lists ranked by leader PnL (inflated by bump and comment bots, WWW'26); venue-owned leaderboards (pump.fun owns Kolscan) | — | Delays live use; low cost since no decile is positive | Now (K trips over D days; overridable, logged) |
| Referrer ≠ leader (#14) and disclosure | The referral leg tells a KOL-referrer, in real time, which buys of their coin come from their referred copiers | code: `liveSigner.ts:742-746` | Small revenue loss in the conflicted case | Now |
| Treasury fingerprint: **disclose, don't hide** | Every Solana trade pays `J7YraeWCWGJXYTsTGta1zSX7PS5BV2i4H4ogkR6ZZ13n` in the same tx (`shared/fees.ts:28`), so anyone can list or stream Krypt users (Bitquery's attribution method, Oct 2026) | Copy timing already identifies copiers without fee data | — | Docs and legal text |
| EVM honeypot sim and tax cap (M9) | BNB honeypots, four.meme creator buy tax (1/2/3/10% measured), Pons snipe tax | `docs/bnb-audit-2026-09-09.md:70-79` | Exotic tokens fall back to "unknown" and are skipped | Measure first |
| Custody/privacy claim | TradeWiz (20,932 wallets drained), Axiom insider allegation | news / on-chain | The claim must be exactly true. Audit every outbound call first (MCP, chat bots, log bundle, pump auth, referral attribution). Don't name competitors in app copy. | After audit |

Two notes on the referral split the user restated. (1) The referrer's 0.1% lands in the referrer's own wallet inside the user's trade, so it is visible on-chain. Users should be told. (2) A referrer who is also a copied leader has an incentive to bait their own referrals. #14 removes the payment in that case.

---

## 7. Correctness gaps to fix before any growth push

Ordered by money at risk. All code-read, none reproduced live.

| Sev | Gap | Where |
|---|---|---|
| P1 | Live copies unmanaged after restart or pause: no mirrored sells, no TP/SL/trailing/max-hold, while the UI promises they close on their own | `electron/engine/copyTrade.ts:274-280, 460-462, 1086, 2975-2977`; `engine.ts:3564`; `src/pages/Wallets.tsx:1145-1149` |
| P1 | Double mirror of a partial pump sell (firehose recovery, then watcher "upgrade"). A 40% trim becomes about 64%. | `copyTrade.ts:1012-1033, 1118-1120, 1978-1979`; `engine.ts:6583-6604`; test gap `test/copytrade.test.mjs:1427-1447` |
| P1 | Record and daily loss limit priced at the leader's exit and at spot, not our fills | `copyTrade.ts:2016, 1687-1691, 64-87, 2389`; `engine.ts:777-791, 824, 513, 902` |
| P1 | Paper leaves out fixed fees (7% of a 0.05 SOL round trip) and uses a 1% venue fee where the pump curve charges 1.25% | `copyTrade.ts:1141, 1690`; `shared/exitBudget.ts:163, 242-246` |
| P1 | Paper and live mixed per config, in stats and in the daily stop | `copyTrade.ts:466-490, 766-769, 810-823, 334-355`; `Wallets.tsx:77-93` |
| P1 | Transfer-out, stable-sell and token-for-token exits invisible; USDC/USD1 buys never copied | `electron/engine/walletSwap.ts:153-160`; `walletWatcher.ts:580-582` |
| P1 | No mint-safety check on copy buys | `engine.ts:32, 6443-6455` (only importer of `risk.ts`) |
| P2 | Concurrent same-mint buys clobber `buysInFlight`, so an add-on buy is orphaned after the leader leaves | `copyTrade.ts:2146, 2150-2152, 2468-2469, 1962-1966`; `shared/copytrade.ts:734` |
| P2 | Firehose recovered fraction biased low (processed feed against a confirmed balance read; 3 s holding cache) | `shared/types.ts:1110`; `rpcClient.ts:1232-1236`; `copyTrade.ts:1322-1350` |
| P2 | Unreadable signature never retried; a sell read before its buy is dropped, then the buy is copied | `walletWatcher.ts:564, 617-624, 648`; `copyTrade.ts:1963-1966, 1197-1200, 979-980` |
| P2 | Parked exits during an in-flight buy keep only the newest (30% + 30% becomes 43%, not 60%) | `copyTrade.ts:1170-1171, 1201` |
| P2 | No entry premium guard; leader fill price not stored | `shared/copytrade.ts:298-360`; `copyTrade.ts:2389, 2460-2465` |
| P2 | Copy Simple 0.1 SOL default above the 0.05 SOL live cap, so every live copy is refused | `src/pages/CopySimple.tsx:47`; `shared/types.ts:1180`; `copyTrade.ts:2441-2446` |
| P2 | No exposure cap, no drawdown stop; the daily stop ignores open losers; live breakers default off; the EVM rail has no entry breakers | `copyTrade.ts:820-823`; `shared/types.ts:1184-1185`; `engine.ts:837, 981` |
| P2 | EVM copies: curve trades only (post-graduation sells missed), no live cap, facts missing, so age/creator/score/onlyPumpfun filters refuse everything | `shared/copytrade.ts:89-93`; `ipc.ts:5719-5749`; `copyTrade.ts:2268-2338` |
| P2 | Remove deletes open live rows behind a "paper record" prompt | `copyTrade.ts:383`; `Wallets.tsx:738-741`; `CopySimple.tsx:117-121` |
| P2 | Blockhash TTL 20 s against a lifetime of about 33 s; keyless Sender at 1 rps | `electron/engine/txBuilder.ts:66`; `broadcast.ts:40, 564`; `prewarm.ts:51, 69` |
| P3 | Win rate shown x100; "+0.0000" instead of an em dash | `CopySimple.tsx:262, 254-258` |
| P3 | Followed leaders sorted by their own PnL | `Wallets.tsx:654` |
| P3 | Slow catch-up after a silent dead subscription (one wallet per 60 s, 25 signatures); no boot check for leaders who exited while the app was closed | `walletWatcher.ts:157-163, 416-420, 668-683` |
| P3 | Per-firehose-trade full scans of up to 2,000 rows in the main process; `activeWallets` builds a new Set per call | `copyTrade.ts:2943-2986, 460-462`; `engine.ts:6577-6580` |
| P3 | `copy:resetStats` rejects EVM addresses; one config per leader per chain | `ipc.ts:5888-5892`; `copyTrade.ts:359-362` |
| Doc | `docs/copy-trade-competitors-2026-09-21.md:171` claims "harsh fills (the price AFTER your delay)". The code prices exits at the leader's fill. Correct the doc once #3 lands. | — |
| Unknown | Token-2022 transfer-fee and transfer-hook handling in the local pump and PumpSwap builders | not covered |
| Unknown | Whether `copySells` and `exitTakeProfitPct`/`StopLoss` interplay correctly at runtime | not checked |

---

## 8. Conflicts between angles, and open questions

### Conflicts and how they were resolved

1. **Is the 590 ms token-facts figure measured?** The risk angle called it measured; the latency and audit angles called it illustrative. `docs/copy-latency-2026-09-21.md` presents it as a sample line, and no live `copy timing` line exists. **Resolved: illustrative.** factsMs is unmeasured.
2. **What is today's end-to-end latency?** Candidates: 5–6 s (tester, by eye, before the fix), about 3.7 s (illustrative doc line), 2–4 s (latency angle's estimate). **Resolved: unknown, likely 2–6 s.** Item 8 produces the real number. No figure goes in the product until then.
3. **arXiv 2607.02795 (sniper cohorts).** The edge angle quoted its numbers; the adversary angle reports that the author withdrew all numbers in Oct 2026. **Resolved: cite the method only.**
4. **The CEX study (97% of leaders profitable, 43.6% delivered positive follower returns).** Seen only through a competitor-authored secondary write-up, original not found. **Resolved: low confidence; not cited as measured.** Our own tape is the evidence.
5. **Slippage default.** Competitors: keep 15% and explain why it is lower than the usual advice. Risk: 15% curve / 10% AMM. Adversary: let a premium cap against the leader's fill replace 15% as the binding bound. **Resolved:** keep slippage as quote tolerance (15%), and add the premium guard as the binding bound. Exits are never blocked by price or premium checks.
6. **Premium threshold.** Proposals: audit 15–25%, risk 15% curve / 8% AMM, adversary 5–8%, exchanges 0.3–1.5%. **Resolved:** store the leader fill first, ship the guard in paper at 15% curve / 8% AMM, then set live defaults from the recorded distribution.
7. **Transfer-out default.** Proposals: per-config switch (competitors), default on (audit), default on only for live (adversary). **Resolved:** per-config, default on, a labelled synthetic exit, never a priced one. Fomo-specific exits stay unknown until a real Fomo exit is decoded.
8. **Is speed worth money?** The latency angle proposes the $49 tier plus prebuild; the edge angle measured that the effect is impact, not information. **Resolved:** the free fixes now, and paid prebuild gated on M1.
9. **Where copy alerts go.** Proposals: chat bots and webhooks only (competitors), toasts plus bots (audit), `engine.notify` (risk). House rule: no engine toasts except errors. **Resolved:** `engine.notify` to desktop notifications and the read-only bots; errors may pop.
10. **Hide or disclose the fee fingerprint.** **Resolved: disclose.** Rotation fails against Bitquery's method, and copy timing identifies copiers anyway.
11. **Two commitments.** The pump firehose defaults to `processed` (`shared/types.ts:1110`); the leader watcher uses `confirmed` (`leaderFeedFrames.ts:35`). This is not a conflict: they are two different feeds, and the mismatch causes the low-biased recovered fraction (§7 P2). After Alpenglow, keep the watcher at confirmed: processed gains a new phantom source (candidate blocks).
12. **Does Axiom copy-trade?** Its docs show only a tracker; third parties disagree. **Unresolved;** it is shown as "tracker + alerts, per its docs" in §2.

### Open questions (each needs a measurement or a decode, not an opinion)

- Did Alpenglow activate today? What is the processed-to-confirmed gap on Helius and public WSS afterwards?
- Real median slot gap and totalMs on the logs and tx transports, from live 0.01 SOL copies once item 8 ships.
- How long does a cold `tokenFacts` take? Does `market.summary()` return null liquidity for fresh curve coins? If so, the default $5k floor refuses most pump copies; check the skip reasons in a real copytrade.json. No copy records exist on this machine.
- How often does the double-mirror fire, i.e. firehose before watcher with a recovered fraction? And how often does a sell arrive before its buy?
- Follower entry premium distribution per venue (needs item 5).
- How often are our copy fills sandwiched? Do the pump and PumpSwap instructions tolerate an extra read-only account?
- Does any decile reach breakeven at 0.6–1.0 s lag (M1)? Can the tape resolve sub-second lag at 200 ms slots?
- How do Fomo exits appear on-chain? Can a Fomo profile be resolved to a wallet? Does our EVM scanner attribute ERC-4337 bundler swaps to the smart account?
- Do the tape_amm and the Raydium/Meteora/LaunchLab/Boop rails carry trader identity at scale (H8)?
- Are shadow wallets independent copiers or the leader's own keys (does H3 collapse into H4)?
- The Helius Developer per-connection subscription cap: 100 (blog text) or 1,000 (table)?
- Current inclusion latencies for the landing lanes at 200 ms slots. The Netticode leaderboard didn't render; there is no neutral benchmark.
- Reddit sentiment on copy trading: blocked for the research agents. A human skim is needed.
- OdinBot's speed dashboard contents (JS-rendered, empty to our fetch).
- Do the local builders handle Token-2022 transfer-fee and transfer-hook mints?
- The referral split: the user restated 20%. Whether to revisit it is the user's call. Any change means re-pinning the fee interlock and the referral canary tests.

---

## Skeptic review

Reviewer pass, 2026-10-21. I tried to refute each of the top 8 roadmap items and every latency, competitor and academic claim. Method: I read the cited file:line in `C:\Users\Krypt\Desktop\Krypto Copy` (code was read, not run), grepped every app-data log folder, and fetched or searched the outside sources. Verdicts: **holds** (the source checks out), **weakened** (true but over-generalised, mis-sourced or partly built), **refuted** (contradicted). When I couldn't verify a claim, it is marked unsupported.

### Top 8 roadmap items

| # | Verdict | Why |
|---|---|---|
| 1 Exits independent of `enabled` | **weakened** | The bug is real. `copyTrade.ts:274-280` disarms live configs on load. `activeWallets` (`:460-462`) and the router (`:1086`) filter on `c.enabled`, and so does `checkOwnExits` (`:2977`). The card at `Wallets.tsx:1145-1149` promises "Copies also close on their own when this wallet sells". **The proposed fix conflicts with house order-safety rule 3**: restart means paused, never armed, and a resumed trailing stop has its peak reset. Run exits unconditionally after a restart and three things go wrong. A max-hold that ran out while the app was closed dumps the bag at boot. A trailing stop fires off a peak nobody watched. A leader sell from the downtime is not caught either way. Amend: mirrored sells resume only for sells seen after boot. Own exits re-arm with the trailing peak reset to the boot mark, and max-hold counts from boot or asks first. Add a boot check for leaders who exited while the app was closed (§7 P3). Keep the item at #1–2. |
| 2 Close the double-mirror | **holds** | I traced the whole path. `engine.ts:6583-6604` delivers the firehose trade with `tokens` but no `soldFraction`. `routeSell` stores `null` (`copyTrade.ts:1020-1021`). `closeOpen` gets the fraction back through `recoverFraction` and sells it (`:1977-1979`), and nothing writes that fraction into `handledSells`. The watcher then delivers the same signature *with* the fraction, which takes the `'upgrade'` route (`:1028-1031`) and calls `queueExit` again (`:1118`). `closeOpen` has no check per signature; `supersededSkips` only removes *skip* rows. So 40% becomes 40% + 40% of the 60% left, which is 64%. It is the most clear-cut money bug in the list. Rank it #1. |
| 3 Price the record from our fills, split paper/live | **holds** (partly built) | Live exits are booked at the leader's price: `applyExit(..., exit, ...)` at `copyTrade.ts:1920`, with `exit = t.priceSol` at `:2016`. The live entry *is* already wired to take `fillPriceSol` (`copyTrade.ts:2484`, `engine.ts:784-791`). Its own comment says the reconciled fill is "usually still unknown here", so the entry falls back to the mark. The missing piece is a write-back after the fill reconciles, not new plumbing. The effort may be below M. |
| 4 Paper fidelity | **holds** | `SIDE_COST = 0.01 + FEE_BPS/10_000` (`copyTrade.ts:1141`). `paperFixedFeeSol` is used only at `engine.ts:2258,7154`. The arithmetic checks out: fast lane is buy 0.001 + 0.000056 + base and sell 0.002 + 0.000438 + base, about 0.0035 SOL, or 7.0% of a 0.05 SOL copy. Two corrections: charge the **config's** fee lane (`execution.feeLane`), not a hard-coded `'fast'`. And the pump fee is "tiered ~1.25%" by our own comment (`txBuilder.ts:1478`), so read it from the fee config instead of adding another constant. |
| 5 Leader-fill storage plus entry-premium guard | **weakened** | The code gap is real: `CopyTrade` has no leader price (`shared/copytrade.ts:297-360`) and entry is at the mark (`copyTrade.ts:2389`). But storing the leader's price is trivial, because `t.priceSol` is already on every `WalletTrade`; that half is S and belongs with #8. The guard's evidence is CEX futures. Binance figures conflict by source: 0.3%/0.5% in launch coverage, 0.5%/1.5% per Bitsgap. The Matrixport page I found gives other reasons for refusals (minimum size, total cap), not a price band. None of that carries over to a bonding curve, where our own tape puts the first print after a signal about 26% above it (`wallet-identity-2026-07-25.md:51-53`, from `tape-audit`). At 15%, the guard would refuse most curve copies. That turns it into a "don't copy fast coins" filter whose effect is unmeasured. Move the guard to Measure first and keep only the storage in Build now. |
| 6 Mint-safety check on copy buys | **weakened** | The code gap is real. `risk.ts` is imported only at `engine.ts:32`. The copy host's `tokenFacts` (`engine.ts:903-930`) returns no safety flags, and `copyTrade.ts` doesn't call `checkMint`/`hasHardReject`. The incident checks out: Cointelegraph, Sept 2024, the "RED" token burned about 7 s after the swap (permanent delegate). But **High impact is unsupported.** Mints created by the pump program (curve and PumpSwap, the bulk of copy flow) can't carry freeze authority or a permanent delegate. The risk is only on non-pump venues, and its frequency among leader buys is unknown. Also reuse `mintExtensions.ts`, which already parses permanent delegate, non-transferable, transfer hook, transfer-fee bps and default-frozen. Skip the read for mints the pump program created, so an RPC outage doesn't turn every pump copy into a skip. Cheap, so keep it, but drop it below #7. |
| 7 Classify non-swap exits | **weakened** | Code: `walletSwap.ts:151-155` returns null without a SOL leg, and `walletWatcher.ts:580-582` counts it as `notSwap`. Vendor: Bloom's Copy Trade docs say "Sell on Transfer" is turned on automatically and is required to copy sells from fomo.family profiles (docs.bloombot.app). Two problems. (a) How often our followed leaders exit by transfer is unmeasured, so "High" is a guess. Split the `notSwap` counter into transfer-out, stable-sell and token-for-token for a week first. (b) The success metric relies on "the 90 s sweep" for leader balances, but `sweepBalances` (`copyTrade.ts:2799`) reads **our** balances, not the leader's. Checking leaders means new reads under the `getTokenAccountsByOwner` budget. |
| 8 Measure in slots, plus realised slippage | **holds** | On the tx push, `tradeAt` is null and so is `detectMs` (`walletWatcher.ts:531-545`). The slot is parsed and never used (`leaderFeedFrames.ts:90`). I grepped every app-data log folder (Krypt Terminal, Krypto Copy, Krypto Terminal, krypt (dev), krypt-terminal, Krypto Bot Profiles, Krypt Trader): zero `copy timing` lines. The only `copytrade.json` (Krypt Terminal) is 68 bytes with 0 configs and 0 trades. One overclaim: "the number the whole field markets without measuring". OdinBot does publish vendor same-block rates (15% in a sponsored Decrypt piece, "up to 65%" on G2, and G2 also says about a third). Say "no independently checkable number". Note too that converting a slot to a time needs `getBlockTime` or an estimate at about 218 ms per slot. |

### Latency claims

| Claim | Verdict | Why |
|---|---|---|
| 200 ms slots since epoch 1053 (2026-10-09), first epoch 218.3 ms | **holds** | Solana Compass: Anza confirmed it at 14:42 UTC on 10-09; the epoch averaged 218.3 ms over 26.2 h. That is one epoch from one provider. |
| Blockhash now lives about 33 s; a 20 s TTL is a P2 gap | **weakened** | 33 s is right (150 blocks × about 0.218 s). But a 20 s-old hash still leaves about 13 s, and broadcast follows `lastValidBlockHeight`. It is a margin issue, not a defect. P3. |
| Alpenglow (Votor) activates today, with confirmed about 150 ms after processed | **holds as unknown** | Several reports put it at epoch 1064, about 15:00 UTC on 10-21 (CrowdfundInsider; CoinDesk via KuCoin). Solana Compass headlines a Nov 9 mainnet target for Agave v4.4. 150 ms is a target, not a measurement. |
| Keyless Sender at 1 rps; a key gives 50 rps; `/ping` warms for free | **holds** | helius.dev/docs/billing/rate-limits: keyless `/fast` is 1 req/s per egress IP per region, rejected 429s count, `/ping` doesn't, and a key gives 50/s per key per region. Some search snippets of translated pages show 15/s, so check again before hard-coding. |
| Helius per-connection cap: 100 or 1,000? (open question) | **partly resolved** | The rate-limits page gives 1,000 subscriptions per connection on every plan (LaserStream WebSocket); Enhanced WS is Developer and up. preprocessedSubscribe: public beta, 0.1 credit per message, paid plans, **10 concurrent connections/subscriptions per key**. That caps M3's design. |
| Jito ShredStream sunset 2026-09-05 | **weakened** | The only source I found is a blog by OrbitFlare, a competing shred vendor. I found no Jito primary. It is non-load-bearing, since it's in Don't build anyway. |
| Leader feed 150–578 ms behind Helius, 8–25% loss | **holds (one night)** | `copy-trade-competitors-2026-09-21.md:289-291`, one night's log. Don't generalise it. |
| About 165 ms of app code; the 900/740/620 ms line is illustrative | **holds** | `copy-latency-2026-09-21.md:17-18` is a sample line; the 165 ms comes from order-latency on 09-18, in the 400 ms-slot era. |
| Read-back: 120 ms sleep, then backoff | **holds** | `FETCH_BACKOFF_MS = [120, 300, 800, 2_000, 5_000]`, 6 attempts (`walletWatcher.ts:120,137`). |
| BNB: 6 s poll against 0.45 s blocks | **holds** | Fermi hard fork, 2026-01-14 (BNB Chain blog). `POLL_MS.bnb = 6_000` is in **`electron/evm/scanner.ts:79`**, not `electron/engine/evm/`. |
| "Copying lost in all 24 lag/hold configs including 500 ms; about 26% of price is gone" | **weakened** | The source table (`wallet-identity-2026-07-25.md:37-44`) uses **fixed holds** (60/180 s), a 4.5% cost floor and top 10/25% wallets, not mirrored exits. The 26% figure is "the first print after **any** signal" (tape-audit), not leader prints specifically. Lag wasn't monotone there either: the least-bad cell was 2,000 ms at −2.47%, which was also the top-25% selection. M1 must not assume speed helps. |

### Competitor claims

| Claim | Verdict | Why |
|---|---|---|
| Trojan referrer share 27.5–47.5% of fees, so "others pay about 0.25–0.47% per trade" | **unsupported** | No primary source found. Secondary sources say "up to 35%" (Solana Compass), 25–35% (MadeOnSol), or 45%/50% tiers (airdrops.io). Trojan's 1% fee, 0.9% when referred, does hold. "Lowest referrer payout we found" is directionally plausible (about 0.35% at Trojan), but the range quoted is not verified. |
| GMGN 1% fee; dev-sell and migrated-sell exits | **holds (third-party)** | Several reviews agree; I found no GMGN primary doc. |
| Bloom: sell-on-transfer, Fomo profiles | **holds** | docs.bloombot.app Copy Trade. "Max Slot Diff" is **unsupported**: no source found. |
| Axiom 0.75–0.95% net fee, about 0.3% referral | **unsupported** | Not checked; no source given. |
| Axiom insider allegation (2026-02-26) | **holds as allegation** | ZachXBT, reported by The Block, Decrypt and Forklog. Axiom pulled the employee's support-tool access. It is not adjudicated. |
| TradeWiz: 20,932 wallets, about $459K | **holds** | Bitquery: about 20,933 wallets, about $459K at $120/SOL. TradeWiz blamed key exposure in its SOL PVP export feature. Bitquery calls its attribution a starting point. |
| Fomo 46% share (08-24); Axiom from 44.6% to under 30% | **holds (secondary, dated)** | Solana Compass citing Blockworks; a daily figure, now 2 months old. It also says Fomo copying is one-tap manual, which answers the "unclear if copy is automatic" cell. |
| OdinBot 15% to 65% same-block | **holds as vendor claims** | The 15% is in a sponsored Decrypt article. The 65% is on G2, which on the same page also says about a third. |
| §1: "no one publishes a same-slot rate"; "every product grades leaders by the leader's own PnL" | **weakened** | Vendors do publish same-block rates (OdinBot; Leap and uwuu claim same-block). The second claim is a universal over a 16-product survey. Reword both to "none independently verifiable" and "none of the N we surveyed". |
| Binance/Matrixport skip copies 0.3–1.5% off the lead's price | **weakened** | Binance futures thresholds conflict by source (0.3/0.5% vs 0.5/1.5%). The Matrixport page lists other failure reasons. CEX perps, not curves. |
| eToro copy stop-loss defaults to 40% | **holds** | etoro.com CopyTrader "how it works": 40% default, settable from 5 to 95%. |

### Academic and incident evidence

| Claim | Verdict | Why |
|---|---|---|
| CCS'26 (arXiv 2609.10246, "Meme Coin Factories"): WT1 wash on 8.26% of coins | **holds, with scope** | That figure is from a **1% sample** of coins (§4.2). |
| CCS'26: "WT1 is near-zero false positives" | **weakened** | The authors only "believe WT1 introduces an extremely small number of false positives". No false-positive rate is measured. WT1 also means the same address buying and selling **in one transaction**. Excluding those prints does little against item 11's threat (a cluster holding the price for 2 s), which WT1 doesn't model. |
| CCS'26 DP1: median 7 senders into one dumper; funder clusters cut the creator count about 11x | **holds** | DP1 median 7 (its maximum is also 7, and DP2's is 17). The 11x applies to the addresses that fall in multi-address clusters, not to all creators. |
| arXiv 2602.15395: 48Club and BlockRazor built over 96% of BNB blocks | **holds** | From the abstract, May–Nov 2025. "Their RPCs are a candidate broadcast option" is an estimate. |
| arXiv 2607.02795 numbers withdrawn | **holds** | v4 (2026-10-05) correction: "all numerical results below are withdrawn pending a corrected analysis". |
| Bitquery: 96% of 6.85M sandwiches hit the pump curve or PumpSwap; 20–50% tolerance is "about 18x" | **weakened** | The 96% and 6,850,144 hold (CryptoSlate). The article's own text says **14x** versus *under 3%*. 18x is derived from its chart (148 vs 8 per 10k at 1–3%). It is observational, and covers Jupiter-routed trades only. |
| Cointelegraph 2024-09, permanent-delegate burn about 7 s after purchase | **holds** | The "RED" token, flagged by Slorg on 2024-09-03. |
| Internal: no decile positive, decile 9 best; FOMO −14.9% to −32.1%; R1–R4 70.5%/9.6%; supply-share hides 57% | **holds** | `wallet-convergence-2026-09-14.md:41-44,154-183`; `rug-filter-2026-08-30.md:119,236`. The deciles were scored at 1.5%/side with no fixed fees, so at 0.05 SOL the real loss is larger. That strengthens §1. |
| Internal: stops fill at 0.53x entry, so size is the only binding control | **weakened** | `breakeven-swarm-2026-09-28.md:39` measured script stops on a different strategy. Applying it to copy exits is extrapolation. |

### Missed or under-ranked

- **Copy Simple's 0.1 SOL default against the 0.05 SOL live cap** (`SIMPLE_SIZES[1] = 0.1`, `shared/copytrade.ts:667`; `maxLiveSol: 0.05`, `shared/types.ts:1180`; refusal at `copyTrade.ts:2441-2446`). Every default live follow on the landing page is refused unless the user raised the cap. It sits inside #10 (an M item). Pull it out as an S fix in the first batch.
- **Win rate x100** holds: `winRate` already returns a percentage (`shared/copytrade.ts:865`), and `CopySimple.tsx:262` multiplies it by 100 again. That is an hour's fix on the page users see first.

### Re-ranking

1. #2 double-mirror (S, deterministic money bug).
2. #1 exits after restart, amended to order-safety rule 3 (trailing peak reset, max-hold counted from boot, boot check for exits missed while closed).
3. Copy Simple default size against the cap, plus win rate x100 (S, hours).
4. #4 paper fidelity (S, using the config's lane), then #3 record from fills (the write-back, M or less).
5. #8 slot telemetry, plus storing the leader's fill price (absorbs the measurement half of #5).
6. #7 transfer-out exits, after one week of a split `notSwap` counter shows how often they happen.
7. #6 mint-safety, only for mints the pump program didn't create (S).
8. #5 premium guard: **moved to Measure first** (needs the distribution from step 5).

M1 (lag replay) still gates all paid speed work. Nothing in this review moves the bottom line: no source, ours or outside, shows a positive follower return after costs.

---

## Built 2026-10-22 (first batch)

| Item | What changed | Pinned by |
|---|---|---|
| #2 double mirror | `mirroredSells`: one leader signature is acted on once per config, whichever delivery arrives first. | `test/copytrade.test.mjs` "a sell recovered from the firehose is not mirrored again…" (fails with the guard removed: 2 sells) |
| #1 exits after restart | `managesExits(c)` = enabled, or holding an open copy, or a buy in flight. Watch list, router, own exits and the FOMO crowd exit use it; entries still need `enabled`. Rule 3: open rows lose their trailing peak at `init`, and max-hold counts from boot. `checkLeadersAfterBoot()` (main.ts, 15 s after boot) records, never trades, a leader who left while the app was closed. | the "A paused config still follows its open copies out" block |
| Copy Simple | Default 0.05 SOL (the default live cap). Switching to Live over the cap offers to fit it. Win rate no longer ×100. "—" before anything closes. Paused cards say they still manage N open copies. Remove names open copies. | `test/copysimple.e2e.mjs`, `test/copyapp.e2e.mjs` |
| #4 paper fidelity | `PAPER_MODEL = 2` (`shared/copytrade.ts`): 1.25 % venue + 0.5 % Krypt per side, plus fast-lane fixed fees per tx (0.003504 SOL round trip). A paper exit on a leader sell fills at min(their price, spot). Rows carry `paperModel`. | "a paper round trip pays BOTH sides…", "…harsher of their price and the spot" |
| #3 record from fills | Live entry is rewritten from the ledger's lamport/token delta (`entryBasis: 'fill'`). Live exits are `pending` until the sell's fill is read, then credited at that tx's price per token for the copy's own tokens (`priceLiveExit`); a hand-bought bag sold alongside is not credited. Stats and the daily limit are per mode; the limit counts pending exits at the model estimate. | the four "LIVE: … priced from OUR fills" tests, "paper and live are scored apart" |
| #8 slots + #5 storage | `CopyTiming.leaderSlot/ourSlot/slotGap` (watcher delivery + ledger `Fill.slot`), median `slotGap` on the latency panel. Every row stores `leaderPriceSol`; Recent copies shows "entry +x % vs theirs". The premium GUARD is not built (measure first). | `test/copylatency.test.mjs` slot case |

Not done in this batch: the tx-transport `tradeAt`-from-slot stamp. Recovered trades already go through the dated `logs` path; a live push is treated as now.
