# Copy trader swarm, 2026-10-23: what was still open, and what got built

Third swarm in three days. It builds on `docs/best-copy-trader-research-2026-10-21.md` and `docs/wallet-finder-research-2026-10-22.md` and does not repeat them. Six angles ran in parallel (roadmap status, lag curve, exits and filters, external changes, live probes, execution unknowns), then one skeptic tried to refute the three load-bearing claims of each. The angle reports are kept beside this file in `docs/swarm-2026-10-23/`.

Labels as before: **measured** (run on 2026-10-23, script named), **code** (file:line at `c4f3e1c`), **vendor**, **paper**, **estimate**.

---

## 1. Bottom line

1. **Still no edge.** Three held-out day-pairs, 3.03M leader trips, lags 0.4–120 s, two sizes, three fill models: 0 of 630 decile cells reach breakeven at the median, and none has a CI lower bound at or above 0 (**measured**, `lag.mjs`). The best decile sits on the fee floor: a copy whose price does not move costs −10.8 % at 0.05 SOL and −7.6 % at 0.1 SOL. "Best copy trader" stays defined as: honest numbers, no money lost to our own bugs, safety, and filters that cut losses.
2. **Speed is not worth buying.** Under the honest fill model, 1 s instead of 2 s improves the pooled median by only 0.4–0.8 points. The realistic band for this app is 1–2 s (detect + read is already 0.4–0.5 s before build/send). The $49/month Helius prebuild path is a **don't build** (**measured**).
3. **Three money bugs that nobody had found** were reproduced by two separate agents and are now fixed: PumpSwap's signed virtual reserve, open copies evicted from the book, and the firehose under-sell (§3).
4. **The chain and pump.fun moved this week** (§2): Alpenglow is live, slots are ~212 ms, pump shipped v2/v3 instructions and a signed reserve field, and pump.fun's own Terms now restrict bots that watch its services. The last one is a decision for the user (§6).
5. **What the ranking can do** is warn and avoid harm. By trimmed mean, the top decile beats a hold-matched random buy by 4.4–8.3 points. By median it is no better than random (**measured**, skeptic re-run). Ranking on the honest model beats today's ranking by 1.3–3.2 points on all three pairs.

---

## 2. What changed outside since 10-21

| Fact | Label | Consequence |
|---|---|---|
| Alpenglow is live (about 13:36 UTC 10-21). 0 vote transactions per block; root trails the tip by 2 slots; confirmed equals finalized on 60/60 samples | measured (probe) + vendor | Slot comments and blockhash TTLs that assume 400 ms are stale |
| Slot time is 211.6 ms (n = 30 one-minute samples) | measured | Blockhash life is about 31.7 s |
| Processed to confirmed: median 148 ms, p90 349 ms, n = 19,125. **0 phantoms** in about 39.5k processed signatures | measured | Processed is now worth about 150 ms, not 400. The leader watcher stays at confirmed |
| api.mainnet-beta grants `getTransaction` **10 per ~10 s per IP**, shared with every app on the machine. 429s count against the window | measured (twice) | The keyless copy read-back can starve when Krypto Bot runs on the same machine. Fixed (§3 #5) |
| publicnode serves `getTransaction` (94/94, median 122 ms) and delivers pump logs at confirmed (99.93 %), but **0 PumpSwap logs**, and ignores most per-wallet subscriptions (9/30) | measured | Use it for reads only. Never put wallet subscriptions there |
| Helius Parsed Streams: on **all plans incl. Free**, confirmed only, 5 connections × 25 subscriptions on Free | vendor | The keyless answer to the read budget, not a speed play. Sells still need one balance read, at the push's slot |
| pump v2/v3 instructions (`BuyExactQuoteInV3`, `SellV3`, multi-hop, synthetic migration) shipped 10-07..13. 64–69 % of trades carry no plain Buy/Sell log line | vendor + measured | Trade **decoding** is unaffected (238/238 from events and CPI). Only the drift watchdog regex is blind |
| PumpSwap `virtual_quote_reserves` is a **signed i128** and negative on 6 of 51 canonical pools | vendor + measured | Fixed (§3 #1) |
| pump.fun's own app charges a 0.45 % Platform Fee from 10-17. Terms (updated 10-17) §6.1, §21(c), §21(h)(iv) restrict bots that monitor the services or track other users | vendor (quoted in `swarm-2026-10-23/external.md`) | A decision for the user (§6) |
| Token-account rent is 0.00148844 SOL; the code hard-codes 0.00203928 | vendor | Low; read it from the RPC (not built) |
| GMGN has a public API with a Free tier, and its copy-score formula is documented (it starts from the leader's own return with an assumed drift) | vendor | Only a seed source, never a score |
| Research: White Whale Labs (press, 10-20): copying 2 min behind clusters lost 41 % per token. arXiv 2601.08641's +3 % assumes **zero latency** | paper / press | Nothing contradicts "copying loses after costs" |

Corrections to the 10-21/10-22 docs: the jitodontfront account works on pump, PumpSwap, compute-budget and tip instructions (+258 CU) but **fails on SPL Memo** (`MissingRequiredSignature`), so the memo fallback in 10-21 M2 is wrong; put it on the Jito tip. The "0.72 % processed phantoms" seen by one angle were socket drops, not phantoms (refuted with status reads).

---

## 3. Built 2026-10-23

Ordered as the skeptic re-ranked them: money safety, then record honesty, then loss-cutting with held-out support. Everything is pinned by a test, and `npm test` passes the full suite (§7).

| # | Item | What changed | Pinned by |
|---|---|---|---|
| 1 | **PumpSwap reserve read as signed i128** | `parsePool` reads Pool@245 as i128 (`readVirtualQuote`). Read as u64, a negative reserve looked like about 1.8e10 SOL: a buy asked for a few hundred raw units of a 1,796 SOL pool, landed for almost nothing and was booked as a fill. If vault + virtual ≤ 0, the builder refuses and the signer hands the order to Jupiter (a builder refusal, never a sell block). `pumpSwapBuilder.ts` | `test/pumpswap.test.mjs`, against real negative pools captured in `test/fixtures/pumpswap-negative-pool.json` |
| 2 | **Open copies never evicted** | The 2,000-row book is shared by **every** config, and blind truncation pushed open live copies out: the leader's exit then placed **0 sells**. `trimTrades()` drops the oldest skipped rows first, then closed rows, and never an open row, a slice of one, or a row whose fill is pending. `copyTrade.ts` | copytrade "an open copy is never pushed out of the book…" (2,005 skip rows, then a full exit still sells 100 %) |
| 3 | **Firehose under-sell** | The leader's balance is read at `processed` with `minContextSlot` = the sell's slot (the firehose now carries `slot`), so "after" can't be the pre-sell balance. The 3 s holding cache is keyed **per sell signature**; it was per wallet+mint, which sized the second rung of a ladder from the first rung's balance. If a recovered fraction was too small, the watcher's exact fraction tops it up **once** (`${actKey}:exact`). A too-large one is never undone. The `minLeaderSellPct` threshold is judged on what the leader sold. `copyTrade.ts`, `engine.ts`, `rpcClient.ts` | Three copytrade tests: 100 % exit recovered as 50 % then topped up to 100 % exactly once; a 40 % trim (29 % + 16 % of the rest = 40 %); a two-rung ladder reads twice |
| 4 | **Expiry is not "did not land" on a failed read** | When the height crosses, a failed status read keeps polling to the deadline (reported as pending). A `null` status is re-read with `searchTransactionHistory`. Expired only on two answered "not found" reads. `broadcast.ts` | `test/broadcast.test.mjs` (two new cases) |
| 5 | **Keyless read-back budget** | `getTransaction: 10` in the public method budget. The watcher gets a **getTransaction-only** fallback to publicnode: it alternates after a refused read, and starts there when the primary's window is already spent (`budgetWaitMs`). Only when the primary is Solana's own public RPC. `rpcClient.ts`, `walletWatcher.ts`, `engine.ts` | walletwatcher "a refused read-back is retried on the fallback endpoint, for getTransaction only" |
| 6 | **Exact-in buys** (ported from KryptSniper, after #1) | Pump curve `buy_exact_sol_in` and PumpSwap `buy_exact_quote_in`: spend is exact, slippage moves onto the token minimum. Before, 0.01 SOL at 12 % spent 0.008836 and was billed the fee on 0.01. Loss-guard pre-balance read at `processed`. | `test/txbuilder.test.mjs`, `test/pumpswap.test.mjs` (byte-identical to a mainnet sample) |
| 7 | **Navigation guard** (ported) | `shared/appUrl.ts` `isAppUrl`: an exact app page or dev origin, never a prefix. `http://localhost.evil.tld`, other local HTML and `file://` shares were let in. Drops can no longer navigate the window. | `test/appurl.test.mjs` |
| 8 | **Mint guard on Jupiter copy buys** | `LiveTradeParams.mintGuard`: a copy buy routed through Jupiter refuses freeze authority, permanent delegate, non-transferable, transfer hook, transfer fee and default-frozen mints. It fails closed on an unreadable mint and does not fall through to the relayer. Pump-built buys never wait on this read. Both copy buy paths set it. `liveSigner.ts`, `engine.ts` | `test/mintguard.test.mjs` (real permanent-delegate and real create_v2 fixtures) |
| 9 | **Missed-sell backstop** | Simple follows get `exitMaxHoldMin: 30`. Max hold now also runs on a **15 s clock** (`checkMaxHolds`), because a coin that stops printing never delivered the price tick it used to wait for. Rows held across a restart still count from boot. `shared/copytrade.ts`, `copyTrade.ts`, `engine.ts` | copytrade "the max-hold backstop fires on the clock for a coin that stopped printing"; the simpleConfig test |
| 10 | **Honest follower fill in the Scout** | A copy leg now fills at the market **as it stood when due**: the mark the last print before the due time left. On pump that is the curve's post-trade price. It used to fill at the first print after the due time, at that trade's own price. A coin that stops printing settles at its last mark instead of "unreachable", so riding coins to zero no longer scores well. Only too-fast trips stay unreachable. Prior re-derived (below). The profile shows **"A copy that goes nowhere"**, the fee floor at the chosen size, and Discover's tooltip shows it too. `walletScout.ts`, `walletScore.ts`, `WalletProfile.tsx`, `Discover.tsx` | walletscout: fill rule, dead-coin settlement, the 12-trip consistency case |
| 11 | **Fee-aware mirroring default** | Simple follows under 0.12 SOL get `minLeaderSellPct: 50`. A trim costs more in its own sell transaction (about 0.0024 SOL) than it saves; the leader's last sell is always 100 % of what is left, so the exit is never skipped. The card shows the rule ("mirrors their sells of 50 %+ of their bag"). | the simpleConfig test |
| 12 | **Unmirrorable exits counted (measure first)** | `classifyUnseenExit`: stable sale, token-for-token, transfer out. Counted per followed wallet, logged once each, and shown on the card next to "N trades could not be read". Nothing is mirrored from it yet. | walletswap classifier test |
| — | Test hygiene | `copyTrade._reset` cleared the path but not the save timer, so `npm test` rewrote the tracked `.tmp` file at the repo root. | — |

**The prior, re-derived (measured, `swarm-2026-10-23/prior.mjs`).** The shrinkage prior is the median of per-wallet follower medians, for wallets with five or more copied trips, at a 2 s lag in the recorded 1.5 %/side model. The old −9.9 % **could not be reproduced** from the app's own rule. The old rule gives −16.0 % on the same 09-16 tape and −12.9 % pooled, which matches the 10-22 "every closed trip −13.0 %". A prior well above the population pulls thin, lucky records up the ranking.

| Tape | Old rule, wallet medians | New rule, wallet medians | New rule, pooled |
|---|---|---|---|
| 09-16 | −16.04 | **−15.54** | −12.32 |
| 09-10 | −18.04 | −18.16 | −14.07 |
| 09-11 | −19.68 | −19.46 | −14.39 |
| 07-26 | −19.98 | −19.03 | −15.03 |
| 07-27 | −19.16 | −17.99 | −14.49 |

The constant is now −15.5 %, the 09-16 figure (the tape the original came from). The CSV tapes carry average trade prices, not reserves. So the replay's new rule is slightly kinder to big leader buys than the live engine, which uses the curve's post-trade price.

---

## 4. What the tape said about exits and filters (held out, three pairs)

- **Mirror medians at 0.05 SOL:** −21.9 / −22.6 / −16.0 %. For the shrunk-median top 30 %: −14.3 / −13.1 / −13.0 %.
- **"First leader sell = full exit"** adds 1.6–2.5 points, all of it saved sell fees (price effect −0.5 to +0.2). It turns a trim into a dump, so it stays **opt-in**. The fee-aware threshold (#11) gets +0.5 to +1.7 without that.
- **Stops at −30 %** halve the share of copies losing more than 50 %, but cost 1–2 points of median. Opt-in "tail control" only. **TP rungs, graduation exits and 2 h / 24 h max holds** are within ±0.7 points; a TP rung hurts the better leaders.
- **Missed sells:** missing 15 % of leader sells costs 0.6–2.1 points per copy at last-print marks. The 30-min backstop recovers about a fifth of that. The exits angle said 40–60 %, but that assumed −100 % dead coins; the skeptic corrected it.
- **Filters:** only the **shrunk-median gate** passed its pre-registered held-out rule cleanly. H3 crowding and H4 cohort flags **flip sign** across pairs. Bot and long-holder warnings don't replicate as loss predictors. "Entry at curvePct > X" removes better copies. Large size and **mayhem-mode coins** (−9 to −90 points; 25/25 verified on chain) are **chips, not skips**, until a fresh pre-registered pair confirms them.

---

## 5. Next, in order

| # | Item | Why / evidence | Effort |
|---|---|---|---|
| 1 | Run one live copy at 0.03 SOL with the latency panel open, and read `slotGap`, `readTries`, and recovered against exact for a week | No live copy timing exists anywhere on this machine; every latency number is still a component | S (a user action) |
| 2 | Mayhem-coin and large-size **chips** on Scout rows and the follow wizard | Exits angle; skeptic: chips only | S |
| 3 | Mirror stable-sale and token-for-token exits by fraction, after a week of #12's counters; USDC-derived prices labelled derived | 4.4 % of SOL traders' exits; about 99 % of Fomo users' transactions | M |
| 4 | Drift watchdog regex for V2/V3/ExactIn lines; `BondingCurveComplete` handled as "migrating" with exits queued for PumpSwap | External + execution | S / M |
| 5 | Helius Parsed Streams as the keyed-free leader transport, racing logsSubscribe with slot telemetry. Its sell read must use the push's slot (same race as #3) | Removes the read budget, not latency | M |
| 6 | jitodontfront on the Jito tip transfer, with a sandwich detector on our own fills | Simulation only so far; benefit unmeasured | S + measure |
| 7 | Exposure / max-open / per-config drawdown caps; EVM live cap (`ipc.ts` maxLive returns null) | From the 10-21 list, still missing | M |
| 8 | Rent from `getMinimumBalanceForRentExemption`; 400 ms-era comments and the 20 s blockhash TTL | External, probe | S |
| 9 | Replicate the ranking and the new prior on a fresh 200 ms-slot tape with reserves (09-16 jsonl or a new recording) | Every tape so far predates Alpenglow | M |

**Don't build:** Helius $49 prebuild for speed, H3/H4 flags, curvePct skips, TP rungs or graduation exits as defaults, any "fastest" or "profitable" claim.

---

## 6. Decisions for the user (not built)

1. **pump.fun Terms §6.1 / §21(c) / §21(h)(iv)** (updated 10-17) restrict automated monitoring and tracking of other users. The Scout's swap-api scans, `/home-feed` seeds and the `pumpBrowser` reads are in scope. The live feed comes from the chain, not pump.fun. Options: keep as is; seek written permission; or move the Scout to chain-only data and build a degraded mode for a pump API block. Not a legal opinion.
2. **Positioning text:** don't say "cheaper than pump.fun". Its own app is 0.45 %, below our 0.5 % per side. Never cite the +3 % paper without "assumes zero delay".
3. **The Simple defaults changed in #9 and #11** (30-min backstop, 50 % trim threshold under 0.12 SOL). Both are on the evidence above and visible on the card, and both can be cleared on the full page. Say if either should be opt-in instead.

---

## 7. Verification

- `npm run typecheck`: clean.
- `npm test`: the full suite passes, with the summary line read rather than just the exit code. New or changed suites: copytrade 171, walletscout 19, walletswap 15, walletwatcher, broadcast, pumpswap 28, txbuilder 37, appurl 4, mintguard 4.
- Not exercised live: everything in §3 is offline-tested; nothing was signed or sent. Item 1 in §5 is the first live check.
- Line endings: four of the edited files are CRLF and were kept CRLF.
