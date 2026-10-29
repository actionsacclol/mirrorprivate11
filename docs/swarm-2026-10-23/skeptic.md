# Skeptic review of the 2026-10-23 angle reports

Angle: an adversarial review of status, lag, exits, external, probe and execution. Date: 2026-10-23, 11:00–11:35 UTC. Repo: Krypto Copy `main` at `c4f3e1c`. Nothing in the repo was edited; `git diff --stat` still shows only the ` M .tmp` that the status angle's `npm test` left.

Labels:
- **measured**: I ran it today; the script is named. My scripts are in `scratchpad\swarm\skeptic\` (`scripts\pool245.cjs`, `scripts\readback.mjs`, `lagcheck\`).
- **code**: file:line in `C:\Users\Krypt\Desktop\Krypto Copy` that I re-read today.
- **vendor**, **paper**, **estimate**: as in the brief.

Verdicts: **holds** / **weakened** / **refuted** / **unverifiable**.

---

## 0. Bottom line

1. **The three new money-path bugs reproduce.**
   - **Open copies evicted at 2,000 rows.** Re-run of `status/repro2.mjs`: 0 sells after 2,000 newer rows, 1 sell at 1,998 or 1,999 (measured). It is worse than status said: `trades` is one module-level array shared by **every** config (`copyTrade.ts:53, 954-958`), so 25 configs share 2,000 rows. It is not 2,000 per config.
   - **Under-sell on the firehose rail.** Re-run of `status/repro.mjs`: [50] for a 100% exit and [29] for a 40% trim (measured).
   - **PumpSwap negative virtual reserve.** 6 of 51 canonical pools are negative (measured, `pool245.cjs`, 11:26 UTC). The status angle did not see this one; execution and external did.
2. **Probe's headline "97% of read-backs fail" is mostly self-inflicted. Weakened.**
   - In probe's own raw data (`probe/d_reads_raw.json`), the **first 10 mainnet-beta reads all succeeded (in the first 6 s), and every one after that failed**. That is exactly one 10-per-window budget, used up by the probe's own load: 0.89 reads/s × up to 6 attempts, against a 1/s budget.
   - The "IP already 18–35 over" reading (10:06 UTC) overlaps the execution angle's own `getTransaction` bulk fetch (`leaders_fetch.cjs`, about 2,460 signatures, file times 02:59–03:12 PDT = 09:59–10:12 UTC).
   - At 11:29 UTC, one call showed `x-ratelimit-method-remaining: 9` of 10 (measured, `readback.mjs`).
   - What holds: the 10-per-window budget, the absence of a keyless fallback (code `engine.ts:454-458`), and publicnode serving `getTransaction` (I measured 9/9 at a 119 ms median).
3. **Cross-angle conflicts change the build order.**
   - **Exact-in after the sign fix.** Porting exact-in buys before fixing Pool@245 turns the dust buy into a buy with **no slippage bound** on negative pools: `min_base_out` comes from the corrupted quote, so it is close to 0 (code + estimate).
   - **Firehose-first after the under-sell fix.** Execution's "deliver every followed-wallet curve trade from the firehose" widens the exact rail that under-sells (code `engine.ts:6667-6690` feeds `recoverFraction`).
   - **Parsed Streams sell reads.** External's Parsed Streams plan repeats the same race: it reads the leader's balance after the push to get the sold fraction.
4. **Two "held out" claims are overstated.**
   - **Large size.** It **fails** exits' own pre-registered rule (P2 at 0.1 SOL: "no", `exits/out/summary.md:259`), and 2 of 3 mean CIs span 0.
   - **Lag's "top decile is no better than random".** This holds only by median. By trimmed mean, on the 09-16 pair I re-ran, the top decile beats the hold-matched random control by **4.4 points at 0.4 s and 8.3 points at 2 s** (measured).
5. **Lag's "−100% is physically impossible on a live curve" is refuted for one coin class.** Exits measured mayhem-class copies with a **median of −107%** on 09-11 (at 0.05 SOL, with fixed fees), on coins that print below the standard start price. Lag's recommendation to use last-print pricing (LAST) still stands; its stated reason does not.
6. **Exits' 30-minute backstop is still worth shipping, but it is worth less than claimed.**
   - The "recovers 40–60%" figure needs dead coins at −100%. Under last-print marks (MARK), which lag and physics both favour, it recovers about 18–23%: 0.13 / 0.23 / 0.39 of 0.56 / 1.28 / 2.08 points.
   - "24 h recovers nothing" is guaranteed by the test windows (24 h and 5.3 h), so it is not a measurement.
7. **Nothing found breaks an order-safety rule as written.** Four recommendations need guard rails, listed in §7.

---

## 1. status: roadmap status audit

| # | Claim | Re-check | Verdict |
|---|---|---|---|
| S1 | Under-sell: the first delivery wins and is never topped up. A 100% exit is mirrored as 50%. | Re-ran `status/repro.mjs` from my scratch folder as cwd, so the test-only `.tmp` write could not touch the repo: `[50]`, `[29]`, control `[40]` (measured). Code: `closeOpen` returns on `mirroredSells.get(actKey)` (`copyTrade.ts:2307-2317`). `recoverFraction` reads `getTokenAccountsByOwner` at **confirmed** (`rpcClient.ts:1235-1238`) behind a **3 s cache** (`copyTrade.ts:1538-1555`). The cache is a second under-sell path the report did not name: a leader who sells 50% then the rest within 3 s gets `after` from the cached first read, so the second sell recovers 50%, not 100% (code + arithmetic). Frequency: still **unknown**. | **holds**, and is wider than stated |
| S2 | Open live copies are evicted after 2,000 newer rows. | Re-ran `repro2.mjs`: N=2000 gives 0 sells; N=1998/1999 gives 1 (measured). The R2 rows come from a real filter path (`minLeaderSol`). `trades` is global across configs (`copyTrade.ts:53, 954-958`; the same truncation at `:2416`). | **holds, worse than stated**: 2,000 rows across all configs, not per config |
| S3 | Expiry reports "did not land" when the final status read fails. | `broadcast.ts:680-687`: `fin` not ok → `s = null` → `expired: true`. `liveSigner.ts:1133-1148` reports a pending tx only when `!expired`. The fix is incomplete, though. A **successful** read that returns `null` from a lagging load-balanced node (the height comes from one node and the status from another) also books "expired". The fix should also re-read the status once from a second host before declaring the tx expired (estimate). | **holds** (fix needs widening) |
| S4 | The nav guard has a prefix hole. | `webSecurity.ts:96-99`: `url.startsWith('http://localhost')` accepts `http://localhost.evil.tld`. Exploitability needs an in-app navigable link: **unknown**. | **holds** |
| S5 | KryptSniper's 10-23 fixes were not ported. | `grep 38fc7408\|c62e1552\|buy_exact` in `electron/` returns 0. `txBuilder.ts:1484-1488` still sets `amount = quote×(1−slip)` and `limit = budget`. | **holds** |

Status's recommendation #4 suggested a 1,440-minute max-hold. Exits' 30-minute evidence supersedes it (see §3). The status report lists most items as BUILT/PARTIAL/MISSING by grep. I did not re-audit the roughly 120 rows; that table is **unverifiable** at row level by this review.

## 2. lag: lag curve and an honest follower model

| # | Claim | Re-check | Verdict |
|---|---|---|---|
| L1 | No decile reaches breakeven at any lag, size or model. | Re-ran `lag.mjs 0916` with B=100 into `skeptic/lagcheck/` (3 min 7 s). The point estimates are **identical** to `lag/out/0916.txt`: STATE-F, 0.4 s, 0.1 SOL, D1 −7.77, all ranked −12.78; at 2 s, D1 −8.67. CIs differ only in bootstrap noise. Every decile median at 0.05 and 0.1 SOL is below 0 (measured). July and September were not re-run (35 + 21 min); their files are consistent. | **holds** (09-16 reproduced) |
| L2 | The fee floor is −10.79% at 0.05 SOL and −7.60% at 0.1 SOL. | Arithmetic: (1−0.0175)² = −3.47%, plus own impact at 30 SOL depth (−0.33% / −0.66%), plus 0.003504 SOL fixed (7.01% / 3.50%), gives −10.81 / −7.63. The constants match the code: `shared/exitBudget.ts:163, 233-246` (priority floors 0.001/0.002 plus the mean tip plus the base fee) and `shared/copytrade.ts:966-983`. These are real live costs on the fast lane, not paper inventions. | **holds** |
| L3 | The top decile is no better than a random buy with the same hour, band and exit schedule; the ranker avoids harm rather than finding skill. | My re-run, STATE-F 0.1 SOL. At 0.4 s, the top decile is −7.77 median / **−7.74 trimmed mean**; its control is −8.19 / **−12.13**. At 2 s: −8.67 / **−8.56** against −11.76 / **−16.83**. By median the top decile is at or near random. By trimmed mean, which is closer to money, it is 4.4–8.3 points better than random. The report's own "18 of 27 cells explained by mix (tmean)" refers to the P4 *difference-of-differences* test, not to top against control. | **weakened**: true for medians only |
| L4 | −100% is "physically impossible on a live bonding curve". | Exits measured mayhem-class copies (prints below the standard start price; 25/25 on-chain `is_mayhem_mode` in its sample) at a median of −107% on P2 (`exits.md` §4). The curve floor argument assumes standard supply. LAST is still the correct default, because it prices whatever the curve last printed. | **refuted** as stated; the LAST recommendation stands |
| L5 | The Scout's fill rule is dishonest: next print at or after due, `native/tokens`, and the leader's own later prints count. | Code `walletScout.ts:330-342, 455-459`: the entry fills at the first print with `at >= followerDue`, priced `native / tokens`, from any trader. The stale test at `:341` sits on the `at < due` path, so `at − due` is negative and the test can never fire. | **holds** |

Other lag points:
- **Lags below what the app can achieve.** 0.4–0.6 s is below the app's path. Probe measured detect plus read at 0.4–0.5 s after the slot clock, before any build, send or land. The realistic band is 1–2 s, where the measured gain is +0.4 to +0.8 points. This only strengthens "don't buy speed".
- **Pre-registration.** The pre-registration lives inside `lag.md`, last written 04:20 PDT. Its "09:58 UTC" timestamp is **unverifiable**. The added STATE/STATE-F models are disclosed as post-hoc.

## 3. exits: exit and negative-filter replay

| # | Claim | Re-check | Verdict |
|---|---|---|---|
| E1 | "First leader sell = full exit" gains +1.6 to +2.5 points, all from fees. | The sell fee per slice is real: `paperExitPnl` charges `paperFixedCost('sell')` on every slice (`shared/copytrade.ts:993-996`), and live pays the 0.002 SOL sell priority floor per transaction (`exitBudget.ts:163`). Code `copyTrade.ts:1741` rounds any slice **up** to at least 1%. Missed by the report: a per-config **`minLeaderSellPct`** already exists (`shared/copytrade.ts:163, 811, 913`; enforced at `copyTrade.ts:2322-2326`, default null). Exits' "ignore slices < 50%" policy (+0.5 / +1.3 / +1.7) is therefore a **default change, not new code**. "First sell = full" turns a trim into a dump, against the copy-trade rule that a trim must not become a dump, so it should be opt-in. | **holds**; the effort is lower than stated |
| E2 | A 30-minute max-hold recovers 40–60% of the missed-sell loss, while 24 h recovers nothing. | Both rest on DEAD100. Under MARK, the 15% miss row is −0.56 / −1.28 / −2.08, and +30 min brings it to −0.43 / −1.05 / −1.69, i.e. **18–23% recovered**. A 24 h hold cannot fire inside 24 h and 5.3 h test windows by construction. The report admits this in §8, yet calls it measured in §0 and §6. One code fact matters for the design: max-hold is judged only on a **price tick** (`checkOwnExits` is called only from `markToMarket`, `copyTrade.ts:3410-3425`). A dead coin with no print and no Jupiter summary never fires its backstop, which is exactly the bag the backstop is for. Restart safety is already right: resumed rows count their hold from boot (`copyTrade.ts:3462-3463`). | **weakened** (smaller gain; 24 h half **unverifiable**; needs a wall-clock trigger) |
| E3 | Held out: the shrunk gate, large size, and creator under DEAD100. | `exits/out/summary.md:249-270`: only "not in shrunk top 30%" and "dev sold before our entry" **PASS** the pre-registered rule. Large size **fails** (P2 at 0.1 SOL "no"), and its mean CIs span 0 in P1 and P2. PREREG.md was written at 02:57:36 PDT, before the first output at 03:18 (file times), so the pre-registration is genuine. Exits' fill model is the "first print at or after +2 s" convention that lag shows is flattering in quiet coins. The filter Δs compare kept against removed under one model, so the sign is probably robust; the absolute medians are not STATE-F numbers. | **weakened**: only the shrunk gate is a clean pre-registered hold-out; large size and mayhem are chips, not skips |

## 4. external: what changed outside

| # | Claim | Re-check | Verdict |
|---|---|---|---|
| X1 | `virtual_quote_reserves` is an i128 and can be negative. The code reads a u64. A sell "cannot land" and a buy sizes to about zero. | Vendor doc in `external/dl/VIRTUAL_QUOTE_RESERVES_FEE_ADJUSTMENT.md:37` ("signed `i128` addition"). Code `pumpSwapBuilder.ts:156` reads `readBigUInt64LE(245)`. Re-measured with `pool245.cjs`: 51 canonical pools, all 301 bytes, **6 negative**, and on **51/51 the i64 read equals the i128 read**: bytes 253–260 are pure sign extension (`ffffffffffffffff` on every negative pool). So the i64-vs-i128 disagreement with execution is immaterial; read i128 to match the spec. **"Exit cannot land" is overstated**: a PumpSwap build that fails at simulate falls through to Jupiter (`liveSigner.ts:591-597`). Execution's "slower, not lost" is correct. | **holds** on the bug; **weakened** on the sell effect |
| X2 | Helius Parsed Streams is free on every plan at 1 credit per event, confirmed only. | Re-fetched `helius.dev/docs/api-reference/parsed-streams/parsedtransactionsubscribe.md` (11:30 UTC): "available on all plans", "Only `confirmed`", 5 connections on Free, 25 subscriptions per connection, endpoint `wss://beta.helius-rpc.com`. The **per-event credit cost is not on that page**; external cites a second page. No pre/post balances are listed. Its value is not speed. It would remove the 1-per-second `getTransaction` budget from the copy path, which matters more (§5). | **holds** (vendor, cost unconfirmed on the primary page) |
| X3 | 64% of pump trades lack a plain Buy/Sell line, so detect from TradeEvent. | Consistent with execution's 69% (164/238). But `logsMentionPumpTrade` feeds only the watchdog and the held-mint fill request (`engine.ts:6091, 6118`; `pumpDecoder.ts:169-174`). Trades are already decoded from `Program data:` events (execution measured 238/238). The "high impact" rating is wrong; it is a low-impact watchdog fix. | **weakened** (impact) |
| X4 | Processed carries 0.72% of signatures that never confirm. | Conflicts with probe: 0 phantoms in about 39.5k, checked with `getSignatureStatuses`. External matched one processed socket against one confirmed socket and did not check statuses. Its 0.72% is socket drops. | **refuted** |
| X5 | pump.fun Terms §6.1 and §21(h)(iv), and the 0.45% Platform Fee. | `external/dl/terms.txt`: "Last Updated: 17 October 2026"; §6.1 and §21(h)(iv) text present verbatim. `fees.txt`: "0.45% of the trade"; "Platform Fee does not apply" to other interfaces. | **holds** (vendor; a legal reading is out of scope) |

## 5. probe: live mainnet measurements

| # | Claim | Re-check | Verdict |
|---|---|---|---|
| P1 | The app's default copy read-back is failing today: 311/321 failed because the IP was already over budget (Krypto Bot). | Bucketing `d_reads_raw.json` by 30 s: bucket 0 is 10 ok of 25, and every later bucket is 0 ok. The 10 successes are at t = 0.0–6.3 s, so the run **started with a full budget** and its own demand drained it (0.89 reads/s plus retries). The 10:06 "−18 to −35 remaining" overlaps the execution angle's `getTransaction` bulk read. At 11:29 UTC, `method-remaining` was 9/10 and pubsub-remaining 8/10 (measured, `readback.mjs`). Probe also cites a park "capped at 10 s". The code waits at most **2.5 s** (`PARK_WAIT_CAP_MS`, `rpcClient.ts:191, 251`) and then sends anyway. So the app also keeps a saturated window saturated: rejected calls count. | **weakened**: the mechanism holds (1 read/s per IP shared across apps; no keyless fallback; retries self-saturate); "97% today" is a probe artefact |
| P2 | publicnode serves `getTransaction` (94/94, 122 ms). | 9/9 ok, median 119 ms, 11:28 UTC (measured). External and execution both measured that publicnode caps `getMultipleAccounts` at 10 keys and refuses indexed methods (public-rpc-limits memory). A **host-level** fallback via `setRpcFallback` would route those calls there too. The fallback must be **method-scoped to `getTransaction`**. | **holds**, with a scope caveat |
| P3 | publicnode ignores most per-wallet subscriptions (9/30). | Not re-run: it opens 30 subscriptions on a shared IP. Code: the watcher uses `host.wssUrl()`, the primary socket (mainnet-beta by default, `shared/types.ts:1101`), so today no wallet subscription goes to publicnode. The recommendation is preventive. | **unverifiable** today; low urgency |

## 6. execution: execution-path unknowns

| # | Claim | Re-check | Verdict |
|---|---|---|---|
| C1 | On negative pools a legacy buy asks for 4–704 raw units, "succeeds", and passes the loss guard and receipt check. | Code: `baseOutForBudget` with poolQuote ≈ 1.8e19 gives poolBase·quoteNet/1.8e19, a few hundred raw units (`pumpSwapBuilder.ts:279-287, 501-512`). The receipt check is advisory (`liveSigner.ts:1031-1040`). The live census reproduced 6/51 (measured). Money per event is small: about 0.001 SOL in fixed fees plus Krypt's fee on the full budget (`liveSigner.ts:726-759` bills `solValueLamports = p.solLamports`), plus a dust sell later. What it really costs is a **false "filled" copy** and absurd marks (`pumpChain.ts:153, 287-291`). The marks could corrupt paper PnL if a paper copy is marked from `poolPriceSol` (estimate; not traced end to end). | **holds**; severity is record integrity more than SOL |
| C2 | Exact-in is not ported; a legacy buy spends 88% of the budget at 12% slippage. | Code confirmed (§1 S5). The 0.008836 figure was not re-run; it is consistent with `amount = q×(1−0.12)` given the 1% modelled fee against the 1.25% charged. **New conflict:** on a negative pool, exact-in's `min_base_out` comes from the same corrupted quote, so it is close to 0. Execution's "exact-in buys correctly on negative pools" means it buys with **no slippage protection**. Port exact-in only together with or after the sign fix. | **holds**; its ordering claim is **refuted** |
| C3 | jitodontfront is accepted everywhere except Memo; put it on the tip. | `execution/sim_dontfront.log` shows the Memo `missing required signature` line verbatim. This is simulation only. The vendor doc doesn't say whether plain `sendTransaction` (non-bundle) honours it, and the signPolicy three-key tip transfer is untested. | **holds** for simulation; benefit **unverifiable** |
| C4 | Firehose delivery skips any mint outside the session map. | `engine.ts:6571-6579` returns before `:6667` `activeWallets().has(ev.user)`. Confirmed. See §7: moving it earlier widens S1. | **holds** (must be sequenced) |

## 7. Order-safety, honest-null and paper-first checks on the recommendations

| Recommendation | Rule at risk | Verdict |
|---|---|---|
| status: mirror top-up | Exactly once | OK only if keyed `(config, signature, 'exact')`, never topped up from a second recovered value, and sent through the partial-sell path, never `buildLocalTrade` (rule 6). Better primary fix: read the leader balance with `minContextSlot` = the event's slot at `processed` and **no cache for sells**, so the first answer is right. |
| probe: "on a 429 switch host instead of retrying" | No retry on failure | Reads only. It must never be generalised to `sendTransaction` or the broadcast path. |
| status: delayed re-read of unreadable leader transactions | Stale-buy gate | A late-found **buy** must still pass the 60 s entry-age gate on `tradeAt`. Exits are fine. |
| exits: first sell = full exit | Copy-trade rule "a trim must not become a dump" | Opt-in only. Ship the existing `minLeaderSellPct` as the small-copy default instead. |
| exits/status: max-hold backstop | Restart → paused | Already safe: the hold counts from boot for resumed rows (`copyTrade.ts:3462-3463`). Needs a wall-clock trigger independent of price ticks; the sell is sized from our balance, so no price is needed. |
| external: fail closed when effective quote ≤ 0 | Breakers block buys, never sells | OK as a **builder refusal** that falls through to Jupiter (`liveSigner.ts:591-597`). It must not become a sell block. |
| status/execution: mint safety fails closed | Breakers | Buys only, and only on the Jupiter buy branch (execution's narrower version), so an RPC outage can't block pump copies. |
| execution: USDC legs converted to SOL | Honest-null | The SOL price must be flagged as derived. The leader's record must not mix USDC-derived and SOL fills without a label. |
| external: Parsed Streams sells | Under-sell | The same race as S1. Use the push's slot as `minContextSlot` on the balance read. |

No recommendation breaks the paper-first rule: every new behaviour applies equally to paper and live.

## 8. Re-ranked combined build list (top 12)

Order: money safety, then record honesty, then loss-cutting with held-out support, then speed. Confidence is mine, that the item is real and worth its effort.

| # | Item | Source | Effort | Confidence | Why |
|---|---|---|---|---|---|
| 1 | **Pool@245 signed (i128) read.** Effective quote = vault + virtual; refuse the local build (fall to Jupiter) when it is ≤ 0 or implausible; fix `poolPriceSol`; add a fixture from pool `8CDLER5m…`. | execution, external | S | **High** | 6/51 pools re-measured at 11:26 UTC. Dust buys are booked as fills, and marks are off by up to about 1e11. |
| 2 | **Never evict open rows (or slices of open rows) at MAX_TRADES.** Drop skipped rows first, then closed rows. | status | S | **High** | Reproduced. The cap is global across configs. |
| 3 | **Under-sell fix.** Read the leader balance at `processed` with `minContextSlot` = event slot and no 3 s cache on sells. Add the exact-fraction top-up as a backstop. Log recovered against exact for a week. | status (+ this review) | S | **High** (mechanism) / frequency unknown | Reproduced. Must land before #13 (firehose-first) and before any Parsed Streams work. |
| 4 | **Expiry → pending** when the final status read fails or returns null. Confirm "expired" only after a second host agrees. | status | S | **High** | Code confirmed. A landed buy booked as failed orphans tokens. |
| 5 | **Read-back budget.** `getTransaction: 10` in `PUBLIC_METHOD_BUDGET`; a method-scoped publicnode fallback for `getTransaction` only; show the "N unreadable" count on the card; a Settings note on sharing the IP with Krypto Bot. | probe | S | **Medium-high** | The 10-per-window budget was measured twice. The 97% headline is an artefact, but more than about 1 leader tx/s per IP saturates the window. |
| 6 | **Port exact-in buys** (after or with #1). | status, execution | S | **High** | Spend is exact and the fee is billed on what was spent. Never before #1, or negative pools buy without a slippage bound. |
| 7 | **Exact-URL nav guard** plus drop/dragover. | status | S | **Medium** | Real prefix hole; exploitability unknown; it guards the arm/save surface. |
| 8 | **Mint check on the Jupiter buy branch only.** Refuse permanentDelegate, defaultFrozen, nonTransferable and non-zero hooks, and transfer fees above the config max. | execution | S | **Medium** | 0.3% of leader buys. Narrow scope keeps pump copies free of RPC dependence. |
| 9 | **Missed-exit backstop.** A 30-min max-hold in Simple presets with a **wall-clock trigger**, labelled; `engine.notify` for "leader left while closed", "unreadable trade" and "mirrored sell failed". Later, a leader-balance sweep. | exits, status | S | **Medium** | Gain is +0.1–0.4 points under MARK, but it is free. Today the max-hold can't fire on a coin with no price. |
| 10 | **Score honesty.** Scout fill at the curve state at due time (STATE-F); price dead and never-closed trips at LAST; fix the dead stale test (`walletScout.ts:341`); show the fee floor (−10.8% at 0.05, −7.6% at 0.1) beside every follower number. | lag, status | M | **High** (direction) | Reproduced. STATE-F ranking beats today's ranking by 1.3–3.2 points on all three pairs. |
| 11 | **Fee-aware mirroring default.** For copies under about 0.12 SOL, set the existing `minLeaderSellPct` to 50 (slices under 50% are not mirrored, the closing sell still exits all). "First sell = full" stays opt-in. | exits | XS | **High** | +0.5 to +1.7 (skip under 50%) or +1.6 to +2.5 (first sell full), with CIs above 0 in 2 to 3 of 3 pairs held out. A fee effect, honestly labelled. |
| 12 | **Classify notSwap and add stable quote legs** in `walletSwap`. Split counters (stableSell, tokenForToken, transferOut, pairUnsupported), then mirror stable and token-for-token exits by fraction. | execution, external | M | **Medium** | 4.4% of exits for SOL traders, about 99% of transactions for Fomo users. Measure with counters first. |

Just below the cut:
- exposure / max-open / per-config drawdown caps (no evidence of a bug, but it is safety; M);
- EVM live cap;
- Remove that keeps managing exits;
- `BondingCurveComplete` handled as "migrating" (the window length is unknown);
- the watchdog regex for V2/V3 lines;
- rent from RPC.

Measure first:
- Parsed Streams as the keyless-budget answer, not as speed;
- jitodontfront with the sandwich detector;
- the mayhem skip on a fresh pre-registered pair.

Chips only, not filters: large size and mayhem-class coin.

Do not build: H3/H4 flags, curvePct skips, TP rungs, the graduation exit, or the Helius $49 prebuild.

**A decision for the user, not a build:** pump.fun Terms §6.1 and §21(h) against the swap-api, frontend-api and `pumpBrowser` reads (vendor text verified).

## 9. Open questions

- How often does the firehose balance read see pre-sell state live? A week of the recovered-vs-exact log from item #3 answers it.
- Real rows per day across all configs, i.e. how soon #2 bites.
- The `getTransaction` window on a clean IP with Krypto Bot closed. Today's 11:29 snapshot suggests the earlier overload was transient.
- Whether paper marks on negative PumpSwap pools already corrupted any stored paper record. No `copytrade.json` with real rows exists on this machine.
- Why mayhem-class coins print below the standard start price (an agent selling extra supply is a hypothesis, not verified). Any "dead coin" model needs that answer.
