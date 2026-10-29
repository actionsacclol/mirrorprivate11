# Probe: live mainnet measurements, 2026-10-23 (read-only)

Angle: what the free Solana path actually does today, measured from this machine (Windows 10, residential IP), 09:54–10:27 UTC.
Scripts and raw JSON are in `C:\Users\Krypt\AppData\Local\Temp\claude\C--Users-Krypt-Desktop-Krypto-Copy\3421ff98-6701-4574-b1b5-db19809e5c8b\scratchpad\swarm\probe\` (`a_chain.js`, `b_firehose.js`, `b2_firehose.js`, `b3_firehose.js`, `c_wsdiag.js`, `d_slots.js`, `d_wallets.js`, `e_ratelimit.js`, `f_subcap.js`, `f2_pnspacing.js`, each with a `.json` result). Nothing was signed or sent; only public endpoints were used; no settings files were opened.

**Confounder on every mainnet-beta number:** Krypto Bot was running on this machine throughout. It had 8 processes and **5 established TCP connections to api.mainnet-beta** (208.115.249.134), plus 3 to publicnode (measured, `Get-NetTCPConnection`, 10:01 UTC). The public endpoint budgets per IP, so this is exactly what a user running Krypto Bot and Krypto Copy side by side gets. It is not a clean-IP baseline.

---

## Headline

1. **Alpenglow looks live.**
   - Blocks carry **zero vote transactions**: 30 of 30 perf samples, plus one block read directly.
   - The finalized root sits **2 slots** behind the tip (TowerBFT kept it around 32).
   - processed→confirmed is a **median of 148 ms**, always in the same slot.
   - Slots average **211.6 ms**. (measured)
2. **The app's default copy read-back is broken on this IP today.** api.mainnet-beta grants `getTransaction` **10 per window** per IP, and this IP was already 18–35 over it. Of 321 sampled read-backs using the app's exact backoff, **311 (97%) failed all 6 attempts with 429**. publicnode served **94/94** at a **122 ms median**, and the app never uses it as an HTTP fallback when no key is set. (measured + code)
3. **publicnode cannot be trusted with per-wallet subscriptions.** Only 9 of 30 `logsSubscribe {mentions:[wallet]}` requests got any reply (the rest got nothing at all), and some acked subscriptions never deliver. Program-level subscriptions (pump) work fine. (measured)
4. **M12 resolved in part.** publicnode **does** deliver pump logs today: 99.93% coverage, and first on 73% of confirmed events. It delivers **0 PumpSwap logs**, filtering by either the program id or the global-config account. (measured)
5. **No phantoms.** 0 of about 39.5k processed signatures failed to land. But every processed signature arrives **twice** (about 97%), and publicnode's processed stream ran 8–35 s late or went silent in all three runs. (measured)

---

## 1. Slot time and Alpenglow (09:54 UTC, `a_chain.js`, `d_slots.js`)

| Measure | Value | Label |
|---|---|---|
| `getRecentPerformanceSamples(30)`, api.mainnet-beta | 30 × 60 s samples (slots 460,390,940–460,399,164): min 206.2, median 211.3, max 220.6, **pooled 211.6 ms/slot** | measured |
| Same, publicnode | pooled 211.6 ms, median 212.0 | measured |
| `getBlockTime` over 600 slots (460,398,643→460,399,243) | 127 s / 600 = **211.7 ms** | measured |
| `slotSubscribe` on publicnode, 30 s, 09:59:51 | 143 slots, 209.8 ms/slot; inter-arrival p50 205.6, p90 285.8 ms | measured |
| Blockhash lifetime | 150 × 0.2116 s ≈ **31.7 s** | estimate (from measured slot time) |
| `getVersion` (both hosts) | solana-core 4.3.2, feature-set 3383571666 | measured |
| `getEpochInfo` | epoch **1065**, slotIndex 319,234 / 432,000 (epoch ≈ 25.4 h at 211.6 ms) | measured |
| `getClusterNodes` | 3,906 nodes; 2,562 on 4.3.2, 457 on 4.3.0, 192 on 2.3.8, 111 on "26.10.4" (likely a Firedancer build string; not verified) | measured |
| Vote transactions | `numTransactions == numNonVoteTransactions` in **30/30** samples; finalized slot 460,399,241 has 295 txs, **0** touching Vote111… | measured |
| Root distance | `slotSubscribe`: slot − root = **2** (p99 3, n = 143) | measured |

**Verdict:** Alpenglow (Votor) is consistent with being live. Votes have left the block and finalization trails the tip by about 2 slots (about 420 ms), where TowerBFT kept about 32. It also fits the 10-21 doc's epoch-1064 activation report. I did not read a feature-gate account, because I do not have its id. "TowerBFT root ≈ 32 slots" and "votes were a large share of transactions" are general knowledge (estimate), not measured today.

## 2. processed → confirmed gap and phantoms (`b3_firehose.js`, 10:06:44 UTC, 120 s window + 30 s)

The clean run is B3. Every socket carried only `logsSubscribe {mentions:[pump]}` plus `slotSubscribe`, at equal volume. Event-loop lag on the client was p50 1.1 ms, p99 13.6 ms, so the client was not the bottleneck.

| Pair (same host) | Matched n | Gap p10 / p25 / **p50** / p75 / p90 / p99 (ms) | Slot delta |
|---|---|---|---|
| api.mainnet-beta processed → confirmed | 19,125 | −100 / 43 / **148** / 260 / 381 / 632 | 0 in 100% |
| publicnode processed → confirmed | 17,215 | −7,677 / −6,164 / −707 / 134 / 228 / 427 (processed stream backlogged; see below) | 0 in 100% |

- Negative gaps (about 10–25% on mainnet-beta) mean the confirmed notification reached us before the processed one. The two sockets are scheduled independently, and the gap is now smaller than socket jitter. (measured)
- **Phantoms: 0.**
  - mainnet-beta: 23 of 19,148 processed signatures were never seen on its own confirmed socket. All 23 were seen confirmed on publicnode, so these were feed drops, not phantoms.
  - publicnode: 57 unmatched; `getSignatureStatuses(searchTransactionHistory)` found all 57 landed (44 with a tx error).
  - Run B1 (09:55): 3,072 / 3,072 unmatched landed (finalized).
  - Total: 0 phantoms in about 39.5k processed signatures. A 95% upper bound is about 0.008% (estimate, rule of three).
- **Duplicate processed notifications:** mainnet-beta 18,527 duplicates over 19,148 signatures, publicnode 16,791 over 17,272. Nearly every processed signature arrives twice, the second copy p50 112 ms (mainnet-beta) / 137 ms (publicnode) later. At confirmed: 40 duplicates in 19,085. (measured) Cause unknown.
- **publicnode processed is unreliable.**
  - B1 (09:55): every processed notification arrived 15–35 s *after* its confirmed twin (gap p50 −30.7 s).
  - B2 (10:02): 0 notifications in 2 minutes, though the subscription was acked.
  - B3: on time for about 70 s (10-s bucket medians 36–183 ms), then backlogged to −8 s by 120 s.
  - publicnode confirmed on the same process and same host was fine each time, so this is the server. (measured)
- About **68%** of pump-mentioning transactions failed (13,050 / 19,085 confirmed in B3; 77% in B1). (measured)

## 3. The copy detection path the app uses (`d_wallets.js`, 10:17:55–10:23:55 UTC, 6 min)

**Setup**
- Wallets: 8 pump traders with 6–40 trades in B3's 2-minute window, at least one buy, and the hyper-bots excluded. They are still bot-like: 19–289 notifications each in 6 minutes.
- App path, replicated: one socket, `logsSubscribe {mentions:[wallet]}` at confirmed (`leaderFeedFrames.ts:57`). On each notification without `err`: `getTransaction(sig, {encoding json, commitment confirmed, maxSupportedTransactionVersion 1})` (`rpcClient.ts:1077-1081`). FETCH_BACKOFF_MS [120, 300, 800, 2000, 5000], 6 attempts, first attempt immediate (`walletWatcher.ts:141,574-621`).
- Version 1, not 0 as the task said: tx v1 has been live since 09-15 and the app uses `MAX_SUPPORTED_TX_VERSION = 1` (`rpcClient.ts:1075`). Version 0 returns -32015 on v1 transactions; 1 of 104 reads today was v1.
- The mainnet-beta read-back was sampled on every 2nd notification so I did not starve the running Krypto Bot further. publicnode got the read-back on every notification.
- Block-time reference: **both** methods are reported. (a) The app's own `detectMs` = arrival − `blockTime`×1000 (`walletWatcher.ts:549,606`). (b) Arrival − the local arrival time of the same slot on a `slotSubscribe` on the same socket ("slot clock").

| Stage | api.mainnet-beta | publicnode | Label |
|---|---|---|---|
| Subscriptions live | 8/8 acked | **1/8 acked**, 7 requests got no reply | measured |
| Notifications (6 min) | 856 (178 failed tx) | 107 (wallet 1 only) | measured |
| Notification − same-host slot clock | p10 143, **p50 347**, p90 579, p99 746 ms (n = 678) | p50 390, p90 535 ms (n = 94) | measured |
| App-style `detectMs` (vs `blockTime`) | p50 1,797 ms (n = 10) | p50 **1,412**, p10 923, p90 1,816, p99 2,743 ms (n = 94) | measured |
| Slot clock − `blockTime`×1000 | p50 **1,046 ms**, range 471–2,268 (n = 104) | | measured |
| Read-back success | **10 / 321 (3%)**; 311 failed all 6 attempts; 1,866 attempts, all `429 Too many requests for a specific RPC call` | **94 / 94**; 91 on try 1, 3 on try 2 (first answer `null`) | measured |
| Notification → first successful read (incl. backoff) | p50 62 ms, p90 194 ms (the 10 that worked, all try 1) | **p50 122**, p90 197, p99 569 ms | measured |
| Same signature, which socket first (wallet 1) | first 14/107 | **first 93/107**; mainnet-beta behind p50 195, p90 979, max 3,765 ms | measured |

**Reading this**
- The app's `detectMs` overstates detection by about 0.5–1 s. `blockTime` is whole seconds, and the slot clock sits a median 1,046 ms after `blockTime`×1000. The slot-clock figure (about 350–390 ms) is the better number. Local clock skew against chain time is **unknown**.
- Neither method sees how long the slot notification itself trails the leader producing the block (turbine plus our network leg); that is **unknown**.
- When the read budget is there, a leader trade is decoded about **0.4–0.5 s** after this node's slot clock (350 ms notification + 60–120 ms read). (measured)
- When the budget is gone (today, on this IP), the trade is almost never read. In the real app, `rpcClient` parks `api.mainnet-beta#getTransaction` for max(retry-after 10 s, strike backoff), capped at 10 s, and waits out the park *inside* the call (`rpcClient.ts:187-229`). So a 429'd read costs 10 s or more per attempt rather than failing fast, and no HTTP fallback exists without a key (`engine.ts:454-458`: the fallback is set only when `execHttpUrl` differs from `httpUrl`). (code)

## 4. M12: publicnode pump / PumpSwap delivery (`b2_firehose.js` 10:02:48, `b3_firehose.js` 10:06:44, 120 s each)

| Same 120 s window, confirmed | api.mainnet-beta | publicnode | Label |
|---|---|---|---|
| pump (B3) | 19,111 of union 19,159 (**99.75%**) | 19,146 (**99.93%**) | measured |
| pump: delivered first | 5,073 (pn behind p50 68 ms, p90 358) | **14,025 (73%)** (mb behind p50 112 ms, p90 321) | measured |
| pump (B1, 09:55) | socket never opened (429) | 30,259 | measured |
| PumpSwap `mentions:[pAMMBay6…]` (B2) | 90,913 | **0** (acked) | measured |
| PumpSwap global config `mentions:[ADyA8hde…]` (B2) | 90,786 | **0** (acked) | measured |

**Verdict on M12**
- The 10-22 finding "publicnode delivered 0 pump logs" is **not reproduced**: three runs today all delivered.
- "0 PumpSwap" **is reproduced**, now also for the global-config account the block feed uses (`ammDecoder.ts:30-33`). That is policy-like and stable today. Not a transient.

**Side finding (B2):** with PumpSwap on the same mainnet-beta sockets (about 8× pump's volume), the mainnet-beta confirmed socket fell behind publicnode by p50 1,070 ms, p90 7.0 s, max 9.9 s. Its slot clock fell up to 17 s behind publicnode's, and the mainnet-beta processed socket was **dropped by the server (1006) after 40 s**. Client event-loop lag was not the cause: the publicnode sockets in the same process were on time. A socket's volume decides its latency. (measured)

## 5. Rate-limit headers on api.mainnet-beta (`e_ratelimit.js`, 10:06:42–10:07:49; curl at 09:59)

| Header (free tier) | Value seen | Label |
|---|---|---|
| `x-ratelimit-method-limit` for **getTransaction** | **10**; `method-remaining` −18 → −35 → −23 over 55 s; every call 429, `retry-after: 10` | measured |
| …for getSlot | 150 | measured |
| `x-ratelimit-rps-limit` / remaining | 250 / 194–233 | measured |
| `conn-limit` / `connrate-limit` | 40 / 40 (remaining 34) | measured |
| `pubsub-limit` / remaining | 10 / **3–5** (Krypto Bot holds 5) | measured |
| `endpoint-limit` | "unlimited", remaining −15,819 … −17,059 | measured |
| WSS handshake refusals | `429 {"message":"Connection rate limits exceeded"}` on **4 of 6** spaced tries (09:59–10:01), 2/3 (B2), 1/2 (B3), 0/1 (D), 0/1 (F), while `pubsub-remaining` showed 3–4 free | measured |
| HTTP getSlot | one `429 Connection rate limits exceeded` at 09:59:13; 200 at 09:59:19 and :26 | measured |

**The window.** I could not observe it cleanly, because Krypto Bot kept the IP over budget the whole time. Two observations bound it: (a) a rejected call still decrements `remaining` (−18 → −19 → −20 on back-to-back calls), and (b) `remaining` recovered from −35 to −28 within 9 s while calls kept arriving. Both fit a sliding window of about 10 s, matching `retry-after: 10` and the code's `METHOD_WINDOW_S = 10` (`rpcClient.ts:297`). A 60 s window would have pushed `remaining` toward −150 at the implied background rate of about 3 calls/s. Label: **measured bounds; the exact window is unknown.**

Implications:
- At 10 per 10 s, the free path supports **about 1 getTransaction per second per IP**, for *all* followed wallets combined plus anything else on the IP using that method. The 8 bot wallets produced about 1.9 successful notifications/s on their own. (measured + estimate)
- `PUBLIC_METHOD_BUDGET` (`rpcClient.ts:298-313`) has no `getTransaction` entry. A cold start therefore paces it at the default 4/s, 4× the budget, until the first header teaches it. (code)
- Since 429s count against the budget, the watcher's 6 attempts per trade keep the window saturated. (measured + code)
- The 6 `maxSupportedTransactionVersion: 0` checks were all 429 too, so v0-vs-v1 refusal was not re-measured today.

## 6. Subscriptions per socket (`f_subcap.js` 10:24:49, `f2_pnspacing.js` 10:26:10)

| Host | Sent | Answered | Delivered within 60 s | Label |
|---|---|---|---|---|
| api.mainnet-beta | 30 `logsSubscribe` (distinct busy wallets), 150 ms apart, one socket | **30/30** acked | 25 (5 silent wallets probably idle; no refusal of any kind) | measured |
| publicnode | same 30, 150 ms apart | **9/30**; 21 got no reply at all (no error) | 4 | measured |
| publicnode | 10, **1,000 ms apart** | 4/10 | 3 | measured |

- On mainnet-beta, no per-socket cap was reached at 30. That fits the code's verified 16 and guard of 64 (`walletWatcher.ts:96-106`). The scarce resource there is connections (`pubsub-limit 10` per IP, see §5).
- On publicnode, the most active wallet (BwWK17…, about 1,200 trades / 2 min) was acked yet delivered **0**, while mainnet-beta delivered 808 for it in the same minute.
- **publicnode silently ignores most per-wallet subscriptions**, and spacing does not fix it. Its program-level subscriptions are fine. Mechanism unknown.

---

## What changes in the 10-21 doc §4 latency table

| 10-21 row / claim | Today | Change |
|---|---|---|
| "200 ms slots since epoch 1053; first epoch 218 ms" | **211.6 ms** (n = 30 min of samples) | Holds; a bit faster. Blockhash ≈ 31.7 s, not 33 s. |
| "Alpenglow activates today… whether it activated is unknown" | Votes gone from blocks, root 2 slots behind, p→c median 148 ms | **Now: very likely live.** The "150 ms after processed" target is **met** on public WSS. |
| "Public WSS logsSubscribe at confirmed, 150–578 ms behind Helius, 8–25% loss" | Not re-measurable against Helius (no key used). Confirmed coverage 99.75% (mb) / 99.93% (pn) over 2 min. **publicnode now first 73%** (08-24: last, 578 ms behind). | The 8–25% loss was not seen in this window. The mb/pn ordering **reversed**. mainnet-beta lags by seconds when a socket carries PumpSwap volume. |
| "Read-back: 120 ms sleep plus 2 round trips, about 250–600 ms" | The code's first attempt has **no sleep** (`walletWatcher.ts:574-621`). Measured on 1 try: 62 ms (mb, n = 10) / 122 ms (pn, n = 94); 97% one try. | **Wrong shape, and too pessimistic when the budget exists.** **Far too optimistic when it doesn't**: 97% failure on mb on this IP today. |
| "Leader block → our inclusion ≈ 2–4 s (estimate)" | Detect + read ≈ 0.4–0.5 s after the node's slot clock (budget available). The order half was not measured. | Detection half shrinks. The real risk is the read budget, not speed. |
| `FEED_COMMITMENT` comment "processed is worth ~400 ms" (`leaderFeedFrames.ts:30-34`) | Worth about **148 ms** median, 0 phantoms in 39.5k, but every processed tx arrives twice | The trade is now small. Keep confirmed; update the comment. |
| M12 "publicnode delivered 0 pump/PumpSwap logs" (10-22 doc) | pump: delivered (3 runs). PumpSwap: 0 (program id and global config) | Half wrong today. |

## Recommendations (ranked)

1. **Use publicnode HTTP for the copy read-back when no key is set**, at least as a `getTransaction` fallback. Today it served 94/94 at a 122 ms median, while mainnet-beta served 10/321. Today `setRpcFallback` returns '' without a key (`engine.ts:454-458`). Impact critical, effort S. (Do not route indexed methods there: it refuses `getTokenAccountsByOwner` and similar, per public-rpc-limits.)
2. **Add `getTransaction: 10` to `PUBLIC_METHOD_BUDGET`** (`rpcClient.ts:298-313`). On a 429 for a read-back, switch host instead of retrying the same host, because rejected calls still burn the window. High / S.
3. **Tell the user about the shared-IP budget.** Krypto Bot and Krypto Copy on one IP share 10 getTransaction per ~10 s and 10 pubsub connections. Krypto Bot alone held 5 sockets and drove the method 2–3× over budget. Surface "N unreadable" prominently and add a Settings note. High / S.
4. **Never put wallet subscriptions on publicnode, and time out unacked subscribes.** A `logsSubscribe` with no reply within about 3 s should be retried on another socket and counted as unwatched. Check whether the watcher already treats a missing ack as failure; I did not verify that code path. High / S–M.
5. **Replace `blockTime`-based `detectMs` with a slot-clock measure** on the latency panel: `slotSubscribe` on the watcher socket, arrival − slot arrival. `blockTime` overstates detection by about 1 s (n = 104). Medium / S.
6. **Drop publicnode from the *processed* firehose pool, or run it at confirmed.** The default is `commitment: 'processed'` with `extraWssUrls: [publicnode]` (`shared/types.ts:1100-1112`). Its processed stream was 8–35 s late or silent in 3/3 runs, while at confirmed it wins 73%. Keep PumpSwap on its own mainnet-beta socket, since one mixed socket backlogged by seconds and got dropped. Medium / S.
7. **Update the 400 ms-slot assumptions** (`broadcast.ts:566` comment, `txBuilder.ts:66` TTL) to 211.6 ms / ~31.7 s blockhash, and update the `leaderFeedFrames.ts` "~400 ms" comment to about 150 ms. Low / S.

## Open questions

- The exact getTransaction window on a clean IP (needs Krypto Bot closed for 1 minute).
- Slot-notification lag behind leader production (turbine plus network) and local clock skew: both unknown.
- Why publicnode ignores most per-wallet subscribe requests, and why it sends PumpSwap logs nowhere.
- Cause of the duplicate processed notifications, about 110–140 ms apart (Alpenglow replay? RPC implementation?).
- The order half (build → land) under Alpenglow was not measured here (that needs a funded wallet).
- Helius versus the public sockets today was not measured (no key used by rule).
