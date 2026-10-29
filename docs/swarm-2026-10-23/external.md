# External delta since 2026-10-21 (web research + live probes)

Angle: what changed outside Krypto Copy since the 10-21 and 10-22 swarms, and which open questions the outside world now answers. Written 2026-10-23.

Labels: **measured** (I ran it; script and UTC time given), **code** (file:line in `C:\Users\Krypt\Desktop\Krypto Copy`, HEAD `c4f3e1c`), **vendor** (a company about its own product, URL), **paper** (arXiv id), **press** (news or third-party write-up, URL and date), **estimate**. Unknown is stated as unknown.

Scripts and raw output are in `C:\Users\Krypt\AppData\Local\Temp\claude\C--Users-Krypt-Desktop-Krypto-Copy\3421ff98-6701-4574-b1b5-db19809e5c8b\scratchpad\swarm\external\`:
- `chainprobe.mjs`: slot time, blockhash window, rent, commitment lag, WS race. Output: `probe-publicnode.json`, and `probe-mainnetbeta.json`, where api.mainnet-beta answered 429 to this IP.
- `slotlag.mjs`: batched getSlot at the three commitments. Output: `slotlag-publicnode.json`.
- `wsrace.mjs`: pump-program `logsSubscribe` at processed against confirmed, matched by signature. Output: `wsrace-mainnetbeta.json`, `wsrace-publicnode.json`.
- `poolprobe.mjs`: live PumpSwap `Pool` accounts decoded two ways. Output: `poolprobe.json`.
- `ixmix.mjs`: pump instruction-name mix. Output: `ixmix-publicnode.json`.
- `dl/`: downloaded vendor docs (pump-public-docs README, TRADE_V3, SYNTHETIC_MIGRATION, VIRTUAL_QUOTE_RESERVES_FEE_ADJUSTMENT, pump_amm IDL, pump.fun terms and fees text, GMGN skills).

Everything was read-only. Nothing was signed, sent, or created. Other swarm agents shared this machine's IP, and api.mainnet-beta returned `429 Connection rate limits exceeded` twice, with its pubsub budget showing `x-ratelimit-pubsub-remaining: 3` of 10. That is itself the shared-budget risk the 10-22 skeptic raised (S2.24).

---

## 0. Headline

1. **A money-path bug from a pump.fun change (P1, new, code plus measured).** PumpSwap `Pool.virtual_quote_reserves` is an **i128** that can be **negative since 2026-09-30** (vendor). Krypto Copy reads it as an unsigned u64 (`electron/engine/pumpSwapBuilder.ts:156`) and adds it to the vault for every quote (`:501`, `electron/data/pumpChain.ts:153,290`).
   - On a live sample at 10:01 UTC, **5 of 16 pools were negative**, including **1 of 9 SOL-paired pools** (measured). The app would read that pool's reserve as **18,446,744,073.7 SOL**.
   - On such a pool a PumpSwap **sell** asks for an impossible minimum out, so it can't land. A buy sizes to about zero tokens, and the displayed price is absurd. Section 3.2 has the derivation.
   - Fix: read 16 bytes signed. Effort S.
2. **Alpenglow (Votor) is live (vendor, solana.com):** epoch 1064, about 13:36 UTC on 2026-10-21, Alpenglow consensus from slot 459,653,000.
   - `confirmed` now equals `finalized` (vendor). Measured: they matched in 60 of 60 samples.
   - Confirmed arrives a **median 154 ms** after processed (p90 349, p99 516) on api.mainnet-beta (measured, one 90 s run).
   - Slot time is **211–216 ms** (measured).
   - Vote transactions are gone from blocks (measured: `numTransactions == numNonVoteTransactions`).
3. **A free push of the leader's decoded transaction now exists.** Helius **Parsed Streams** (`parsedTransactionSubscribe`) is listed for **all plans, free included, at 1 credit per delivered event**, at confirmed only (vendor).
   - It allows up to 100 `accounts.include` per filter, 25 subscriptions per connection, and 5 connections on Free (vendor).
   - It removes the getTransaction read-back for buys. Sells still need the leader's remaining balance to compute the sold fraction, because the push carries transfers, not pre/post balances (vendor plus estimate).
   - Its latency is unknown: there is no published figure, and I had no key to test it.
4. **pump.fun shipped a new program surface on 10-07 to 10-13 (vendor, GitHub).**
   - New instructions: v3 curve trades, PumpSwap v2 trades, `multi_hop_swap`.
   - New pairings: pump coins as quote mints, up to depth 2.
   - Fees now stay on the curve or pool until swept.
   - **Synthetic migration:** the buy that completes the curve fills its remainder at the future pool price, then the coin is untradeable until `migrate_v2` runs.
   - Measured in a 30 s sample: **64% of successful pump trades carry no plain `Buy`/`Sell` log line**, and 46% are V3.
5. **pump.fun's own app now charges a 0.45% Platform Fee** (0.40% with a referral code) from 2026-10-17. Trades through other interfaces don't pay it (vendor). Krypto Copy's 0.5% is now about the same as pump.fun's own app fee.
6. **pump.fun Terms, last updated 17 Oct 2026 (vendor), restrict automated access.**
   - §6.1: bots only "as we expressly permit".
   - §21(h)(i): no bots or scripts that "access, obtain, copy or monitor any part of the Pump Platform and/or Pump Services".
   - §21(h)(iv): no tracking of "any information of any other users".
   - §21(c): no commercial exploitation of access without written agreement.
   - Krypto Copy's swap-api, frontend-api and `/home-feed` reads fall within the plain text. Section 3.4 quotes the clauses. This is a legal reading for the user, not advice.
7. **The evidence still says copying loses.** White Whale Labs (2026-10-20, X thread via ChainCatcher/TokenPost) found:
   - entries 2 min behind wallet clusters lost **41% per token** (n=93);
   - following clusters with positive records lost 11%;
   - following a single wallet lost 20% per trade;
   - "no monetizable advantage was found".

   The only positive claim, arXiv 2601.08641 (WWW'26, +3% copier return), models a **zero-latency** copier filling at the reserve right after the leader. Its own ablations go negative.
8. **Prior docs that were wrong or are now stale:**
   - "GMGN has no public API": it has an OpenAPI with a Free tier.
   - "publicnode delivered 0 pump logs": today it delivered 23,182 in 90 s at confirmed. Its processed stream was flaky.
   - "`x-ratelimit-method-limit: 10`, window unknown": the limit is per method; getSlot is 150.
   - "Fomo held 46% share": by routed volume today, Axiom leads.

   Section 7 has the details.

---

## 1. Solana chain

### 1.1 Alpenglow / Votor

| Claim | Label | Source |
|---|---|---|
| Live. "It activated in epoch 1064", which began Wed 2026-10-21 at about 13:36 UTC. TowerBFT kept the first 5,000 slots (about 18 min). "Alpenglow consensus from slot 459,652,999 was the last TowerBFT block … from slot 459,653,000." Handoff about 900 ms. | vendor | https://solana.com/upgrades/alpenglow (fetched 2026-10-23) |
| **Rotor is not live**: "planned for a later release … not yet scheduled". | vendor | same |
| "`confirmed` and `finalized` now describe the same state"; `confirmed` "is removed in a later release"; point new code at `finalized`. `processed` unchanged. | vendor | same; Chainstack https://docs.chainstack.com/docs/solana-alpenglow-consensus (undated) |
| `getSignatureStatuses` "stays at `0` until the transaction is final and then becomes `null`". Code that counts confirmations should use `confirmationStatus`. | vendor (Chainstack) | same |
| During the migration window, "transactions sent in this period did not land", and confirmed/finalized subscriptions paused. "Streams at `processed` showed vote-only blocks that the network then dropped." | vendor (Chainstack) | same |
| Observed finality: the dashboard showed 202 ms on 10-21 and 10-22, "a single reading, not a sustained average". | press | altcoinbuzz, 2026-10-22, https://www.altcoinbuzz.io/solana-activates-alpenglow-targeting-150ms-finality |
| Genesis certificate signed by 446 of 654 validators; 151 validators with about 20.3% of stake were flagged not ready pre-activation. Stake that actually stopped voting afterwards is **unknown**. One source mentions a failed migration attempt that was rolled back; its timing is unclear. | press | same; Solana Compass pre-activation note |
| No post-activation outage reported as of 10-23. | press (absence of reports) | searches 2026-10-23 |
| Node version on publicnode: `solana-core 4.3.2`, epoch 1065, slot about 460.40M at 09:58 UTC. | measured | `chainprobe.mjs`, `probe-publicnode.json` |
| Votes are no longer in blocks. In the last 3 performance samples, `numTransactions` equals `numNonVoteTransactions` (114,205; 124,854; 118,620 per sample). | measured | same |
| **Slot time**: `getRecentPerformanceSamples` × 10 gave 209.8–215.8 ms, mean 212.6 ms. | measured, 09:58 UTC | same |
| **confirmed == finalized**: in a batched getSlot (one node answers all three), processed−confirmed was 1 slot in 45 of 60 samples, 0 in 7 and 2 in 8; confirmed−finalized was **0 in 60 of 60**. | measured, 10:02–10:03 UTC | `slotlag.mjs`, `slotlag-publicnode.json` |
| **Processed → confirmed on the pump `logsSubscribe` stream** (two sockets, api.mainnet-beta, 90 s, 15,774 matched signatures): median **154 ms**, p10 −50, p90 349, p99 516. Confirmed arrived first 14% of the time (two different sockets). | measured, 10:08 UTC | `wsrace.mjs`, `wsrace-mainnetbeta.json` |
| **Processed-only signatures** (never seen at confirmed, excluding the last 3 s): 114 of 15,910, which is **0.72%**. 100 of the 136 processed-only signatures carried an `err` in their processed notification. Processed also used **2.0× the bytes** (49.9 MB vs 25.3 MB in 90 s) for about the same unique signatures, so it delivers duplicate notifications. | measured | same |
| The second run against api.mainnet-beta could not open a socket (pubsub cap shared with other local agents). Treat the 154 ms as one sample. | measured | `wsrace-mainnetbeta-2.json` |

**Verdict on the 10-21 doc**: "confirmed expected about 150 ms after processed" holds (measured 154 ms median, one run). "Keep the watcher at confirmed" is reinforced: processed buys about 1 slot, costs 2× bandwidth, and carries about 0.7% signatures that never confirm.

### 1.2 Blockhash validity

- `getLatestBlockhash(finalized).lastValidBlockHeight − getBlockHeight(processed)` = **145 blocks** at fetch, so the window is still 150 blocks (measured, `probe-publicnode.json`).
- At 212 ms that is about **31–32 s** when no slots are skipped, and less in wall time if fewer blocks are produced (estimate).
- `BLOCKHASH_TTL_MS = 20_000` (`electron/engine/txBuilder.ts:66`) leaves about 11 s of margin (code plus estimate). There is no Alpenglow change to blockhash rules: none was documented by solana.com or Chainstack (vendor, absence).

### 1.3 Transaction format, rent, fees (activated before 10-21, but not in the prior docs)

| Change | Label | Source | Krypto Copy |
|---|---|---|---|
| **Transaction v1** (SIMD-0385 plus SIMD-0296), live on mainnet since 2026-09-10.<br>• Up to 4,096 bytes; version byte 129; signatures at the end.<br>• Compute budget moves into the header, and "a ComputeBudget instruction in a v1 transaction is ignored".<br>• In v1, `priorityFee` is "the total in lamports".<br>• RPC needs `maxSupportedTransactionVersion: 1` or fails with -32015. | press (OrbitFlare dev.to, 2026-09-10) | https://dev.to/orbitflarerpc/agave-42-transaction-v1-breaking-changes-checklist-50h | Handled: `MAX_SUPPORTED_TX_VERSION = 1` (`electron/chain/rpcClient.ts:1075`, used at `:1080,1098`, `feed.ts:547`, `leaderFeedFrames.ts:52`) (code). In my 30-transaction PumpSwap sample, **6 of 30 were v1** (12 legacy, 12 v0) (measured, `poolprobe.json`). Anything that infers a leader's priority fee from ComputeBudget instructions reads 0 on v1. |
| **Rent reduction SIMD-0437, steps 1–2** (mainnet 09-03 and 09-11).<br>• 5,080 lamports per byte.<br>• Steps 3–5 follow with Agave 4.4, "expected November 2026". | press (Solana Compass, Chainstack) | https://solana.com/upgrades/reduced-rent | Measured `getMinimumBalanceForRentExemption`:<br>• 165 B = **1,488,440** lamports (was 2,039,280)<br>• 170 B = 1,513,840<br>• 182 B = 1,574,800<br>• 0 B = 650,240<br>(`probe-publicnode.json`, 09:58 UTC). The code still hard-codes 2,039,280 or 0.00203928 at `electron/engine/send.ts:27`, `rentSweep.ts:28`, `tokenWithdraw.ts:29`, and the `walletSwap.ts:33` comment (code). These are cosmetic or over-reserving now. They will be 10× off after step 5 (estimate). Read rent from RPC. |
| Agave 4.2 stops writing write-locked but unchanged accounts: "treat a missing update as unchanged". | press (OrbitFlare) | same | Matters for any `accountSubscribe` staleness watchdog (estimate). |
| Priority fees: no new SIMD changing landing found. SIMD-0096 (100% of priority fee to the leader) is unchanged. | press | Supanode / Figment pages | — |

### 1.4 Jito

| Claim | Label | Source |
|---|---|---|
| Before activation, Jito put all mainnet BAM nodes into Maintenance Mode. Validators "revert to ordinary Jito-Agave Block Engine mode"; "Validators, FullSend users and standard bundle senders have no action to take". Direct Bundle Ingest (DBI) and Maker Priority Plugin are unavailable while in maintenance. BAM comes back "gradually"; no date was given. | press (Solana Compass, 2026-10-10) | https://solanacompass.com/news/jito-details-bams-alpenglow-plan-maintenance-mode-for-all-mainnet-nodes-no-firebam-during-the-transition |
| Jito-Solana v4.3.0-jito.1 (pre-release 10-08) has "Alpenglow-aware transaction and bundle buffering". | press (same) | same |
| BAM upgrade: 25 ms batch auctions; DBI skips the block engine's about 50 ms hop. | press | https://www.tokenpost.com/news/technology/31530 ; https://solanacompass.com/news/jito-announces-bam-direct-bundle-ingest-routing-solana-bundles-past-the-block-engines-50ms-hop |
| **Tip floor now**: landed p25 1.0e-6, p50 **1.9e-6**, p75 **9.5e-6**, p95 1.0e-4, p99 1.7e-4 SOL; EMA p50 3.2e-6. | measured, 10:06 UTC | `curl https://bundles.jito.wtf/api/v1/bundles/tip_floor` |
| `jitodontfront`: no change found in any Jito or Helius doc or news. Still unknown whether pump instructions tolerate the extra read-only account (10-21 M2 stands). | — | searches 2026-10-23 |

Krypto Copy reads the live floor (`electron/engine/jitoTips.ts:6,58-60`). Its fallback constants (p50 10,000 lamports, p75 100,000, p95 1,000,000) are 5–10× today's floor, so they only overpay when the fetch fails (code plus measured).

---

## 2. Infrastructure pricing and limits

### 2.1 Helius (vendor pages fetched 2026-10-23; none carry a date)

Sources: https://www.helius.dev/docs/billing/rate-limits, https://www.helius.dev/docs/billing/credits, https://www.helius.dev/pricing, https://www.helius.dev/docs/sending-transactions/sender.

| Item | Free | Developer $49 | Notes |
|---|---|---|---|
| Credits per month | 1M | 10M | Business $499 = 100M; Professional $999 = 200M |
| RPC | 10 rps | 50 rps | |
| sendTransaction | 1/s | 5/s | |
| **Sender** | keyless: "1 request per second per egress IP, per region", 429s count, `/ping` doesn't; keyed: 50/s per key per region; 0 credits | same | **Unchanged from 10-21.** Sender Max min tip 0.001 SOL; `?swqos_only=true` min 0.000005 SOL. Tips in between are "best-effort … fewer pathways". "Every Sender transaction must include a tip and a priority fee" (set with `setComputeUnitPrice`, so legacy/v0 only). Regional HTTP hosts: slc, ewr, lon, fra, ams, sg, tyo. |
| Standard WebSockets ("LaserStream WSS") | yes, 2 credits per 0.1 MB uncompressed; 5 concurrent connections, 1,000 subscriptions per connection | yes; 150 connections | |
| **transactionSubscribe** (Enhanced, now under LaserStream WSS) | **No** | yes, 2 credits per 0.1 MB | pricing page: "transactionSubscribe … Free: No" |
| **preprocessedSubscribe** | **No** | 0.1 credit per message | "Paid only" (credits page) |
| **Parsed Streams `parsedTransactionSubscribe`** | **Yes: "available on all plans at 1 credit per delivered event"** | yes | Section 2.2 |
| **getTransactionsForAddress** | **No plan restriction is stated on the credits page.** The pricing page doesn't mention it. Wallet API runs at 2/s on Free, with no batch requests. | 10/s | 10 credits per 100 full transactions (10-credit minimum); signatures-only 10 flat; failed calls free. **Free-plan access is still unverified without a key.** |
| LaserStream gRPC | No | Devnet only | Business+ mainnet |

Cost note (estimate): at 2 credits per 0.1 MB, a Helius pump firehose at confirmed costs about **20k credits per hour**. That uses 1.0 GB/h, measured on api.mainnet-beta today at 25.3 MB per 90 s; Helius payload size may differ. The free 1M credits last about 2 days, and Developer's 10M about 3 weeks. The 08-25 memory note ("1M credits gone in ~1.3 hours", per-push billing) is outdated if billing is now per MB for standard sockets. Verify with a key before relying on it.

### 2.2 Helius Parsed Streams: the free push the 10-21 doc asked for

Sources: https://www.helius.dev/docs/api-reference/parsed-streams/parsedtransactionsubscribe.md and https://www.helius.dev/docs/parsed-streams/quickstart.md (vendor, undated). Solana Compass says it went GA on 2026-09-24, with metering from that day and 10-01 for existing users (press, 2026-09-25, https://solanacompass.com/news/helius-takes-parsed-streams-and-the-parsed-events-api-out-of-beta-decoding).

- **Endpoint:** `wss://beta.helius-rpc.com/?api-key=…`. One doc says `fs-beta`, another says closed beta with a whitelisted endpoint. The docs disagree, so check the dashboard.
- **Commitment and access:** "Only `confirmed` is supported." Access "available on all plans".
- **Filter:** at least one of `programs` (≤10) or `accounts.include` (≤100). `accounts.include` "matches if any listed address appears in the instruction's accounts". `accounts.roles` (≤20), `instructionNames` (≤50), `includeFailed` (default false), `includeCpi` (default true). Unknown fields are rejected with -32602.
- **Limits:**
  - connections per project: 5 Free, 10 Developer, 50 Business and up;
  - 25 subscriptions per connection;
  - client messages 10/s (burst 20);
  - outbound buffer of 2,048 notifications, after which the connection closes.
- **Notification fields:** `signature`, `slot`, `blockTime`, `feePayer`, `fee`, `accountKeys`, `status`, `error`, `summary`, `nativeTransfers`, and `tokenTransfers` (from/to user and token account, `rawTokenAmount`, `decimals`, `mint`). Instructions come with `decoded.args` and `decoded.accounts`, and pump.fun and PumpSwap are in the catalogue (press, Solana Compass). **There are no pre/post balances.**
- **For Krypto Copy (estimate):**
  - Filter `accounts.include` = up to 100 followed wallets per subscription, so 5 × 25 × 100 = 12,500 wallets on Free.
  - Credits = 1 per matching transaction. 30 leaders at 300 transactions a day is about 270k credits a month, inside the free 1M.
  - A buy is fully described by `nativeTransfers` plus `tokenTransfers`. A sell's fraction needs `heldBefore`. Get it with one `getTokenAccountBalance`/`getMultipleAccounts` on the leader's ATA right after the push (balance after the sell, so fraction = sold / (sold + after)), or from the decoded `sell` args plus our own tracked position. That is one account read instead of a getTransaction with an indexing wait (`walletWatcher.ts` 120 ms sleep plus backoff, per the 10-21 doc).
  - Latency against `logsSubscribe` plus read-back is **unknown**. Test it with a key before building on it.

### 2.3 Public RPCs (measured 2026-10-23 from this machine)

| Endpoint | Finding |
|---|---|
| api.mainnet-beta | Headers: `x-ratelimit-rps-limit: 250`, `conn-limit: 40`, `connrate-limit: 40`, `pubsub-limit: 10`. **Per-method** `x-ratelimit-method-limit`: **10** for getTransaction and getSignaturesForAddress, **150** for getSlot. It answered **429 "Connection rate limits exceeded"** twice while other local processes used it, and refused a WS open once. |
| solana-rpc.publicnode.com | **getMultipleAccounts capped at 10 accounts**: "-32602 A maximum of 10 accounts is allowed" (poolprobe, 10:00 UTC). Pump `logsSubscribe` at **confirmed delivered 23,182 signatures in 90 s** (09:58 UTC). At **processed** it delivered **0 in 90 s** (09:58), then 8,256 in 40 s (10:11). In that second run its processed stream **trailed its own confirmed stream** (median −615 ms; confirmed first 69%), with 8% processed-only and 310 confirmed-only signatures. |
| solana.drpc.org | "chain is not available on free plan" |

Krypto Copy's default pump feed is `commitment: 'processed'` with `extraWssUrls: ['wss://solana-rpc.publicnode.com']` (`shared/types.ts:1104,1110`) (code). In today's runs that second socket was either silent or behind at processed. The comment "more sockets = less loss" (`:1102-1103`) is not supported for it (measured, two runs).

### 2.4 Other vendors

| Vendor | Claim | Label |
|---|---|---|
| Chainstack | Free Developer plan: 3M request units per month at 25 RPS, WebSockets included. Yellowstone gRPC from $49/mo. | vendor-authored comparison: https://chainstack.com/best-free-tier-rpcs-web3-builders-2026/ |
| QuickNode | Sources conflict: a free tier, or a 30-day trial that deactivates. | press / vendor-comparison pages (Chainstack, RPC Fast) |
| Triton One | No free tier; $125 minimum prepaid. | press (RPC Fast comparison) |
| Shyft | Free 1M volume, 10 RPS. | press (one source) |

No free option other than Helius Parsed Streams was found that pushes a whole transaction to a desktop (searches 2026-10-23).

---

## 3. pump.fun

### 3.1 Program changes (vendor: https://github.com/pump-fun/pump-public-docs, commits via the GitHub API)

| Date (commit) | Change |
|---|---|
| 2026-09-12 | Holder-rewards coins. **Cashback deprecated**: `create_v2` rejects `is_cashback_enabled=[true]`, and existing cashback coins still trade. `TradeEvent`/`BuyEvent`/`SellEvent` gain holder-reward fields. |
| 2026-09-29 (effective 09-30) | `Pool::virtual_quote_reserves` **"can be negative … has been an `i128` since it was introduced … always treat it as a signed value"**. Effective quote = vault + virtual, never negative. |
| 2026-10-07 | **New instructions:**<br>• `buy_v3`, `sell_v3`, `buy_exact_quote_in_v3` (curve, 17 accounts; "Same prices, same fees"; v3 on a cashback coin fails with 6094);<br>• PumpSwap `buy_v2`, `sell_v2`, `buy_exact_quote_in_v2`;<br>• `multi_hop_swap` (SOL → A → B, no ATA for the middle coin);<br>• pump coins as quote mints;<br>• **fees kept on curve and pool** until `sweep_protocol_fee`/`sweep_creator_fee`;<br>• **synthetic migration**. "All existing trade instructions keep working." |
| 2026-10-08 / 10-13 | SDKs pump-sdk 4.0 → 4.1.0, pump-swap-sdk 2.1.0, pump-rust-client 0.4.1. Depth-2 pump-coin quotes (SOL → A → B → C). |

**Synthetic migration** (vendor, `docs/SYNTHETIC_MIGRATION.md`):
- "the buy that empties the curve has no max size". It fills the remainder from the future pool's tokens at that pool's price.
- "after it, no buys or sells are possible on the curve until the migration happens"; every trade fails with `BondingCurveComplete`.
- The completing buy emits `TradeEvent` (curve part only), then `CompleteEvent`, then **`PostCompleteBuyEvent`** (pool part). "the buyer's total is the `TradeEvent` amounts plus the `PostCompleteBuyEvent` amounts."
- Krypto Copy has **no reference** to `PostCompleteBuyEvent`, `post_complete`, `BondingCurveComplete` or `ix_name` (grep, code). So:
  - (a) a leader who completes a curve has their buy under-counted on the firehose tape and in the Scout's prints (estimate);
  - (b) a copy buy or sell sent between the completing buy and `migrate_v2` fails with an unclassified error. How long that window lasts is **unknown**.

**Instruction mix (measured, 10:14 UTC, publicnode confirmed, 30 s, `ixmix.mjs`):**
- 11,916 pump-mentioning transactions, of which only **2,555 (21%) succeeded**.
- Among the successes, pump-level trade lines: BuyExactQuoteInV3 315, Sell 282, SellV3 267, Buy 208, BuyExactQuoteInV2 87, SellV2 76, BuyExactSolIn 44, BuyV3 31, BuyV2 23, **MultiHopCurveSwap 10**.
- Successful transactions with a plain `Buy` or `Sell` line: 490, about **36% of trade transactions**, so **about 64% lack one**.
- V3 alone is about 46%.
- This extends the 10-23 audit's reviewer figure (56%) (memory audit-2026-10-23). Any detector keyed on `Instruction: Buy|Sell` misses most trades.

**PumpSwap sample (measured, 10:01 UTC, `poolprobe.mjs`, 30 recent successful transactions):**
- Log names seen: `BuyExactQuoteIn`, `Sell`, `Buy`, `Swap`.
- 16 pools decoded; **8 of 16 had a non-SOL quote mint**. These are pump-coin-quoted pairs, which `walletSwap` (needs a SOL leg) counts as not a swap (code: `walletSwap.ts`, 10-21 doc §7).

### 3.2 The negative virtual reserve bug (code plus measured)

- **IDL** (`idl/pump_amm.json`, vendor): `Pool` = … `coin_creator` (211), `is_mayhem_mode` bool (243), `is_cashback_coin` bool (244), **`virtual_quote_reserves` i128 (245–260)**, then `creator_fee_bps` u64, `can_edit_creator_fee`, `is_holder_reward`, `protocol_fees` u64, `creator_fees` u64.
- **Krypto Copy** (code): `virtualQuote: d.length >= 253 ? d.readBigUInt64LE(245) : 0n` (`electron/engine/pumpSwapBuilder.ts:156`). That reads only the low 8 bytes, unsigned. The doc comment calls 243–244 "two bytes (0 on every pool seen)" and 245 a "u64" (`:103-107`).
- **Use sites** (code):
  - `poolQuote = vault + state.virtualQuote` in the PumpSwap builder (`pumpSwapBuilder.ts:501`), feeding `baseOutForBudget` (`:279-287`) and `netQuoteForSell` (`:292-297`);
  - `poolPriceSol(quote, pool.virtualQuote, …)` for the coin's price (`electron/data/pumpChain.ts:153,290`).

**Measured** (16 live pools):

| Pool | Quote | Vault | i128 (IDL) | What the code reads | Price ratio (code ÷ IDL) |
|---|---|---|---|---|---|
| 26Cw9VBM | SOL | 0.0403 SOL | −0.0128 SOL | **18,446,744,073.70 SOL** | 6.7e11 |
| gfe44P1N, GyUo6Z7P, DrDjSYxh, BLu3d8m4 | pump coin | 190k–216k units | −0.00002 to −0.0001 | about 1.8e10 units | 8.5e4–9.7e4 |
| 8 SOL pools | SOL | 0.9–490 SOL | +17.26 to +23.61 SOL | same (positive values read correctly) | 1 |

Failure mode on an affected pool (code read, not run; arithmetic from `pumpSwapBuilder.ts:279-297`):
- **Sell:** `netQuoteForSell` returns roughly the whole 1.8e19 lamports, so `min_quote_amount_out` is impossible and the program refuses. **An exit cannot land through this builder.**
- **Buy:** `baseOutForBudget` = poolBase·quoteNet/(1.8e19 + quoteNet), which is about 0. That gives a local "buy quote is zero tokens" refusal, or a dust buy.
- **Mark:** price inflated by up to 10^11, which flows into marks and filters.

How often a pool the copier trades is negative is **unknown**: 1 of 9 SOL pools in a 30-transaction sample. Positive values below the about 17.58 SOL boost (for example 17.26) show waiting fees being subtracted, so a pool with fees above its boost goes negative (vendor arithmetic in `VIRTUAL_QUOTE_RESERVES_FEE_ADJUSTMENT.md`).

Also from that vendor doc: "**Do not read the raw vault balance as liquidity.** It now includes fees waiting to be swept." `pumpChain.ts:291` sets `liquiditySol = Number(quote) / 1e9` from the raw vault (code). That overstates liquidity slightly; it is minor next to the sign bug.

### 3.3 Fees (vendor: https://pump.fun/docs/fees, "Last Updated: 17 October 2026", fetched by curl)

- **Bonding curve:** creator 0.300% + protocol 0.95% + LP 0% = **1.25%**, for both SOL and USDC coins.
- **PumpSwap canonical SOL pools:**
  - 0–420 SOL mcap: 1.25%;
  - 420–1,470: 1.20%;
  - 1,470–2,460: 1.15%;
  - 2,460–3,440: 1.10%;
  - 3,440–4,420: 1.05%;
  - 4,420–9,820: 1.00%;
  - higher tiers continue (truncated in my extract).
- **Graduation:** 0.015 SOL, paid by the user if their trade triggers the migration.
- **Platform Fee from 2026-10-17:** **0.45%** of the trade (0.40% with a referral code), on the pump.fun web and mobile app only. "If you access the pump.fun platform or smart contracts via another interface or platform, the Platform Fee does not apply."
- **Multi-hop:** the app charges protocol fee once (first pool) and creator/LP once (last pool). "Trading interfaces that have not adopted the current pump.fun program may charge Protocol, Creator and LP fees on every pool in the route."
- **EVM (incl. Robinhood Chain):** 0.10–0.15% plus the Platform Fee.

### 3.4 Terms of Use (vendor: https://pump.fun/docs/terms-and-conditions, "Last Updated: 17 October 2026", fetched by curl, text extracted)

- **§6.1:** "You may access the Pump Platform and Pump Services through such automated means (including bots) as we expressly permit from time to time, provided that such access complies with these Terms, including Section 21(h)."
- **§21(h)**, you may not:
  - "(i) except as expressly permitted under Section 6.1, use any deep linking, web crawlers, bots, spiders or other automatic devices, programs, scripts, algorithms or methods … to access, obtain, copy or monitor any part of the Pump Platform and/or Pump Services … in order to obtain or attempt to obtain any materials, documents or information in any manner not purposely provided by the Pump Platform and/or Pump Services;"
  - "(iii) … violate any security or authentication measures …";
  - "(iv) track or seek to track any information of any other users or visitors of the Pump Platform and/or Pump Services;"
  - "(v) take any actions that impose an unreasonable or disproportionately large load …";
  - "(vii) forge headers, impersonate, or otherwise manipulate identification, to disguise your identi[ty]".
- **§21(c):** "… resell or otherwise commercially exploit access to the Pump Platform or Pump Services, unless expressly agreed by us in writing".
- **§21(i):** "… combine or incorporate the Pump Platform into another programme or application".
- **Definitions (§32):** "Pump Platform: The digital interface and system through which users access Pump Services." "Pump Services: Tools and services provided or created by Pump Entities … to allow users to create, trade, and discuss …".

What this means (estimate, not legal advice):
- Reading pump's HTTP APIs (swap-api, frontend-api-v3, `/home-feed`) from a paid app plausibly falls under 21(h)(i), (iv) and 21(c).
- Reading the chain through Solana RPC is not pump's server, and whether "Pump Services" covers the on-chain program is unclear.
- The `pumpBrowser` hidden window that waits out the Cloudflare challenge (memory audit-2026-10-23; the user kept it) is the piece most exposed to 21(h)(iii) and (vii).

### 3.5 API and Cloudflare posture (measured 10:10 UTC)

- `curl` on `pump.fun/docs/terms-and-conditions`, `/terms` and `/docs/fees`: all **200**, no `cf-mitigated`. WebFetch got 403 on `/docs/fees`, so the posture depends on the client.
- `frontend-api-v3.pump.fun/coins?…`: 200, **`x-ratelimit-limit: 60`, reset 60** (60 per minute on this route).
- `swap-api.pump.fun/v2/coins/{mint}/trades?limit=3`: 200, `x-ratelimit-limit: 1000`, remaining 836, so other local processes were using it. Trade rows now carry **`fillPriceSol` / `fillPriceUsd`** alongside `priceSol`. Whether these are new since 08-24 is unknown, but they are not in memory `pump-swap-api-seek`. They give the trade's own fill, useful for follower-fill pricing.

### 3.6 Terminal (ex-Padre), Kolscan, Vyper, official copy trading

- Nothing dated Sept–Oct 2026 was found for Kolscan, Vyper or Terminal (searches 2026-10-23).
- Terminalpedia, a third party that says it reviewed production code in August 2026, says Terminal's copy trading "survives only as an order tag" (press, https://terminalpedia.com/ecosystem/what-is-terminal).
- The pump.fun fee page lists "Terminal" with the web and mobile app for multi-hop fee rules (vendor).
- Official pump.fun copy trading: **none found**.

---

## 4. Competitors

| Item | Claim | Label / source |
|---|---|---|
| Routed volume, 24 h to 2026-10-23 09:31 UTC | Axiom $80.45M, Fomo $60.39M, pump.fun $35.49M, GMGN $33.11M, Terminal $13.04M, Trojan $2.13M, Photon $0.74M. Method: "tehcscreener /bots endpoint … volume routed through each terminal's own interface". It switched from DeFiLlama on 10-07. BullX and Bloom are not listed. | third-party benchmark: https://openchainbench.com/benchmarks/solana-dex-volume |
| GMGN OpenAPI | **Exists, with a Free tier.** Keys at gmgn.ai/ai (Ed25519 public key; IP whitelist for swaps). Leaky bucket Free 5/5, Plus 20/20, Pro 50/50. `wallet_activity`/`wallet_stats` weight 3, so about 1.7 req/s on Free. Measured single-call latency 520–780 ms. Claims order "end-to-end latency under 0.3 seconds". | vendor: https://github.com/GMGNAI/gmgn-skills (`Readme.md`, `skills/gmgn-callout-score/SKILL.md`) |
| GMGN copy-tradeability score (the formula the 10-22 doc asked for) | **Copy score** = 100 × Σ w·f, with:<br>• `entry` = clamp(0.12 + (1 − share of entries under $100k mcap)), w 0.22<br>• `profit` = clamp(avg trade USD / 80), w 0.22<br>• `hold` = clamp((1 − 1.6·fast_flip_rate) · clamp(avg_hold_s/172,800 + 0.15)), w 0.20<br>• `feasible` = clamp(1 − trades/2,500), w 0.18<br>• `edge` = clamp(1 − 0.6·under_100k − 0.6·fast_flip_rate), w 0.18<br>Dev wallets are discounted ×0.45.<br>**Backtest:** copy% = wallet% − LATENCY_S·0.015·(0.3 + 0.7·under_100k) − 2·slippage − gas/avg_buy, with defaults 3.0 s, 5% one-sided, $0.20.<br>The base is **the leader's own realised ROI**, clamped to [−0.9, 3.0]. At 3 s the drift is only 1.35–4.5 points. Our tape measured about 26% between a signal and the next fillable print (`wallet-identity-2026-07-25.md`). So GMGN's backtest is far more generous than a print-level replay. | vendor code, `skills/gmgn-wallet-score/SKILL.md` §6–7 (repo HEAD b0f4ac7, 2026-10-23) |
| GMGN callout-score skill (new 10-16) | Scores a caller on selection and on **post-call conduct**: "does he sell into the attention his own call created", proved from the caller's per-trade ledger (first buy, call time, every later sell). | vendor, commit 2f68285 (2026-10-16) |
| GMGN CLI | PR #245 (merged 2026-10-21): "remove TTY confirmation and confirmed-request digest gates from financial CLI commands … remove the obsolete `--yes` / `GMGN_ALLOW_AUTOMATED_TRADES` flow". The README: "`swap` … submit immediately after validating their options". | vendor, GitHub PR 245 |
| GMGN | ToS updated 2026-10-02 (403 to our fetch; date from search snippet). Play Store update 2026-10-20. Trustpilot 1.9/5 from 26 reviews, only 3 in the last 12 months. | press / review site |
| Banana Gun | Copy trading on Solana and Robinhood Chain, citing an 08-10 company blog. Min/max mcap filters. | press release 2026-10-21, https://www.crypto-reporter.com/press-releases/best-crypto-trading-bot-for-meme-coins-banana-gun-and-6-rivals-compared-132613/ |
| Axiom | No dated Sept–Oct 2026 feature or incident news found. Third-party guides describe auto-copy with per-trade max, daily spend limit and blacklist, still unconfirmed against docs.axiom.trade. Trustpilot 1.8/5 from 32 reviews (21 in the last 12 months), with complaints about stuck withdrawals, exits, SL/TP failing, and drains (Oct 13, Oct 2, Aug 28 …). | press; https://www.trustpilot.com/review/axiom.trade |
| Fomo | DWF Ventures: of 292,000 Fomo wallets over three months, **6.16% finished in profit on realised gains**, and only 25 cleared $10k. Method not published; fees unknown. | press, Yellow 2026-08-28, https://yellow.com/news/fomo-copy-trading-94-percent-wallet-losses |
| TradeWiz | Incident 09-30, about 20,933 wallets and about $459k (known). Update: TradeWiz says the first refund batch was issued, claims still need verification, and EVM services were suspended. | press, https://news.bitcoin.com/the-459000-bot-hacker-was-a-customer-first-researchers-say/ |
| Trojan, Bloom, Maestro, OdinBot, Photon, BullX, Nansen, Kolscan | No dated Sept–Oct 2026 copy feature, speed number or incident found. BullX is reported inactive (sources conflict). | searches 2026-10-23 |
| Cielo simulation panel | **Not found.** No Cielo doc or page describing a 1/3/7-day simulation turned up. The 10-22 claim rests on the earlier competitor angle's fetch; unverified today. | — |
| Published speed numbers | Nothing new and checkable. GMGN claims "<0.3 s" end to end (vendor, unverified). | — |

---

## 5. Research (2025–2026)

| Work | Method | Headline | Supports "copying loses after costs"? |
|---|---|---|---|
| **White Whale Labs, "The Audit Of The Memecoin Casino"** (X, 2026-10-20; reported by ChainCatcher https://www.chaincatcher.com/en/article/2297445 and TokenPost https://www.tokenpost.com/news/investing/35409) | All pump.fun and Stonk new-coin trades since late August: >1M pools, 7.7M wallets, 384M swaps. Doubling-TP / −40% SL rules. Costs "accounted for", amounts not stated. Not peer-reviewed. | 2-min-delayed entries behind clusters of 450–2,000 wallets: **−41% per token** (n=93, median −95%). Clusters with positive records: −11%. Single wallet: −20% per trade. A few tight groups: +10% on 16 tokens (small n). Neural-net picks: −11% per pick, negative every day over 771 picks in 8 days. "no monetizable advantage was found." | **Supports** (press; original thread https://x.com/WhiteWhaleLabs/status/2112213836098908460, not fetched) |
| **arXiv 2601.08641** v3 (WWW'26), Luo, Feng, Xu, Liu | 6,000 pump.fun projects (Flipside plus scraped comments); 70/15/15 split by first-buy time. LLM multi-agent wallet and coin selection. **Copier modelled by Lemma 1 as trading immediately after the leader at the post-leader reserve: zero latency.** Fee treatment unclear, no slippage value. "Realistic market frictions" never defined. | Selected smart money +14%; **copier +3% per coin**. Ablations without the wallet or coin agent give copier gross 0.933 and 0.942, i.e. **negative**. | **Contradicts on its face, but not comparable**: zero latency and an undefined cost model. Our honest-fill rule moved a cell from +6.7% to −15.6% (memory wallet-followability). Treat it as an upper bound with no lag. |
| **arXiv 2606.08232** v4 (2026-10-08) | 15-day **paper-traded** autonomous memecoin bot, 190 trades. | +0.62% mean per trade, win 40.5%; "Removing the top three trades (1.6 percent of sample) flips cumulative return unprofitable." | Neutral; it shows how fragile small positive samples are. |
| **arXiv 2609.05663** (2026-09-04) | 3,505 user-funded LLM agent vaults on Base memecoins plus a Hyperliquid fleet. | "neither fleet shows a directional edge". A leaderboard render boundary routes selection (RD 1.75× at the top-3 cut). | Indirectly supports: leaderboard placement drives following, not skill. |
| **arXiv 2609.18975** v2 (2026-09-23) | Two pump.fun collection pipelines from one programme. | Overlap 5 of 623 vs 1,742 mints. "Collector configuration … shapes which tokens an on-chain study observes." | Method warning: our Scout and tape coverage choices bias any score (relevant to the 10-22 S2.6 count mismatch). |
| arXiv 2607.02795 v4 | Sniper cohorts. | **Still withdrawn** (correction dated Oct 2026). | Cite the method only (unchanged). |
| arXiv 2608.20271 (2026-08-20) | 6.4M Solana tokens over 7 months; XGBoost on the first 5 minutes. | Most tokens show rug traits within 1 hour. | Context for skip filters (R1–R4). |
| MadeOnSol, "KOL Wallet Tracking … 1.6 Million Trades" (2026-05-26, https://coinstats.app/news/07f38ebd47e8d820af3eb96b00c42a84b9b856c602626e3e4a71afbbd79014d6_KOL-Wallet-Tracking-on-Solana-What-the-Data-Actually-Shows-After-16-Million-Trades/) | 1,058 KOL wallets via gRPC. | No return numbers; win rates only. "Following every trade from a popular KOL is a losing strategy." | Supports (vendor-ish blog). |
| SSRN, 2026 | No 2026 SSRN copy-trading paper found. | — | — |

Net: nothing published since 10-21 shows a positive follower return with realistic lag and costs. The one positive (2601.08641) assumes zero lag.

---

## 6. User sentiment

- **Reddit is blocked**: WebFetch refuses reddit.com, and curl to `www.reddit.com/…/search.json` returns 403 (measured 10:05 UTC). It stays unknown, as on 10-21 and 10-22.
- **Trustpilot** (small samples; users' claims, unverified):
  - GMGN 1.9/5 (n=26): drained burner wallets via a Telegram bot (GMGN says it was a phishing impersonator), "couldn't sell … money was trapped", scam tokens past filters.
  - Axiom 1.8/5 (n=32): pending withdrawals, "doesn't allow you to exit the position", SL/TP "suddenly didn't work anymore", fees on small trades, unexplained drains, bot-like support.
- **Recurring themes across reviews and press (press):**
  1. Can't exit, or a sell fails while price falls.
  2. Drains and key exposure on custodial bots: TradeWiz 09-30, GMGN-impersonating Telegram bots.
  3. Fees on small trades, including failed-transaction fees.
  4. Copy entries late or slipped.
  5. KOL and "farmer" wallets dumping on copiers (MadeOnSol guide: https://madeonsol.com/blog/how-to-filter-bot-wallets-kol-list-solana).
- **Fomo:** DWF found 93.8% of wallets not profitable over three months (press).

---

## 7. Where the prior docs are now wrong or stale

| Prior claim (doc) | Now | Evidence |
|---|---|---|
| "GMGN … no public API" (`wallet-finder-research-2026-10-22.md` §5 table) | **Wrong.** The GMGN OpenAPI has Free, Plus and Pro tiers and per-route weights. Its terms of use for third-party apps are unknown. | vendor, GitHub GMGNAI/gmgn-skills |
| "publicnode delivered **0** pump/PumpSwap/Raydium logs on 10-22" (§5 table, open question) | **Not reproducible at confirmed:** 23,182 pump signatures in 90 s. At processed: 0 in one run, 8,256 in 40 s in the next, lagging its own confirmed stream. Flaky, not a policy block. | measured (§2.3) |
| "`x-ratelimit-method-limit: 10` (window unknown)" | **Per method:** getTransaction 10, getSignaturesForAddress 10, getSlot 150. Also rps 250, conn 40, connrate 40, pubsub 10. Window still unknown. | measured headers |
| "Helius `getTransactionsForAddress` free-plan access **unknown**" | Narrowed: the credits page states no plan restriction (other features are marked "Paid only"). Still needs a key to confirm. | vendor |
| M3: "$49/mo Helius Developer path … preprocessedSubscribe" | preprocessedSubscribe is paid-only (confirmed). The read-back removal no longer needs $49: Parsed Streams is on Free. | vendor |
| 10-21 §4: Alpenglow "scheduled … unknown whether it activated"; "confirmed expected about 150 ms after processed" | Activated 10-21 about 13:36 UTC; measured median 154 ms. | vendor, measured |
| 10-21 §2: "Fomo held 46% … Axiom fell … under 30%" (08-24, Blockworks) | On routed volume today Axiom $80.45M is ahead of Fomo $60.39M. Different source and method, so not a like-for-like trend. | third-party benchmark |
| 10-21 §2 fee table and "lowest fee" framing | pump.fun's own app now charges 0.45%, close to Krypto Copy's 0.5%. Direct program trades pay neither. | vendor fee page |
| 10-22 D8 "GMGN's skill has an assumed-drift copy-tradeability score" | Formula now documented (§4). Its backtest starts from the **leader's** ROI with a linear drift of 1.5%/s at most, not a print replay. "Ours replays prints; theirs subtracts an assumed drift" is a fair, checkable distinction. | vendor code |
| Code comment "pump-amm Pool … 243 two bytes (0 on every pool seen) · 245 virtual quote reserve u64" (`pumpSwapBuilder.ts:103-107`) | **Wrong:** bytes 243 and 244 are `is_mayhem_mode` and `is_cashback_coin`, and 245 is a signed i128. | vendor IDL; measured |
| Rent 0.00203928 SOL per token account (`send.ts:27`, `rentSweep.ts:28`, `walletSwap.ts:33`) | 0.00148844 (165 B) today, with a further 3 steps in Nov. | measured RPC |

---

## 8. What this changes for Krypto Copy

Ordered by money at risk. Effort: S = days, M = 1–2 weeks.

1. **Fix the PumpSwap virtual reserve read now (P1, S).**
   - Read `virtual_quote_reserves` as a signed i128 at 245–260 in `parsePool` (`electron/engine/pumpSwapBuilder.ts:156`), and carry it signed through `:501` and `electron/data/pumpChain.ts:153,290`.
   - Fail closed if the effective quote is ≤ 0, and never price from the raw vault.
   - Add a fixture test with a negative pool (26Cw9VBM-style bytes) for buy sizing, sell min-out and `poolPriceSol`.
   - While there, decode `protocol_fees`/`creator_fees` and the `is_mayhem_mode`/`is_cashback_coin` flags.
   - Evidence: vendor (pump-public-docs, IDL), measured (5 of 16 pools negative), code.
2. **Handle synthetic migration (S–M).**
   - Classify `BondingCurveComplete` as "migrating: retry on PumpSwap after `migrate_v2`". Don't count it as a failure, and keep exits queued instead of dropping them.
   - Sum `TradeEvent` and `PostCompleteBuyEvent` in the firehose decoder, the Scout prints and the tape.
   - The no-trade window is unknown: measure it on the next few graduations from the tape.
3. **Stop depending on `Instruction: Buy|Sell` log lines (S).** 64% of successful pump trades lack them (measured). Detect trades from the `TradeEvent` data plus `ix_name`. This overlaps the 10-23 audit item.
4. **Prototype Helius Parsed Streams as the keyed watcher transport, free tier (M; measure first).**
   - Filter `accounts.include` = followed wallets (≤100 per subscription).
   - Buys need no read-back. Sells need one ATA balance read for the fraction.
   - Race it against the current `logsSubscribe` plus getTransaction path with the existing `CopyTiming` slot-gap telemetry before switching any default.
   - Cost is about 1 credit per leader transaction (vendor), so the free 1M covers a typical follow list (estimate).
5. **Commitment and feed defaults (S).**
   - Keep the leader watcher at `confirmed`: confirmed == finalized now, and it costs about 154 ms median over processed (measured).
   - Reconsider the pump firehose default `commitment: 'processed'` (`shared/types.ts:1110`): processed doubled the bytes and carried 0.72% signatures that never confirmed (measured).
   - The publicnode extra socket gave nothing or lagged at processed in today's runs. Either run it at confirmed (where it delivered fully) or stop counting it as a racing peer.
   - Code reading `getSignatureStatuses().confirmations` must use `confirmationStatus`. No such code was found by grep; keep it that way.
6. **Leader decode coverage of the new pump surface (M; measure first).** Count `notSwap` leader transactions that are pump-coin-quoted, `multi_hop_swap` or USDC-quoted. 8 of 16 sampled PumpSwap pools were pump-coin-quoted (measured). If followed leaders trade them, copies are silently skipped. Record them as a named skip ("pair not supported") before deciding whether to build a multi-hop builder.
7. **Read rent from RPC, not constants (S).** Use `getMinimumBalanceForRentExemption` (cached) in `send.ts`, `rentSweep.ts`, `tokenWithdraw.ts` and any paper cost line. Three more reduction steps land with Agave 4.4, expected November (press).
8. **pump.fun Terms decision for the user (no code until decided).** §6.1, §21(c), §21(h)(i)/(iii)/(iv)/(vii) are quoted in §3.4.
   - Exposed pieces: the keyless Scout scan (swap-api), `/home-feed` seeding, frontend-api reads, and the Cloudflare-waiting `pumpBrowser` window.
   - Options: keep, ask pump.fun for written permission, or move scoring to chain-only data (RPC or Helius Parsed Streams).
   - The 10-22 S4.5 "degraded mode when pump blocks us" becomes more important.
9. **Positioning and copy text (S).**
   - Fees: pump.fun's own app costs 0.45% plus protocol, and Krypto Copy costs 0.5% with no Platform Fee. Don't market "cheaper than pump.fun".
   - Speed: no competitor published a checkable number this month. Keep publishing our slot gap only.
   - Scoring: say "our score replays the prints a follower would have filled; GMGN's subtracts an assumed drift from the leader's own ROI", with the formula cited.
   - Never cite arXiv 2601.08641's +3% without "assumes zero delay".
10. **Data sources to evaluate (M; measure first).**
    - The GMGN OpenAPI Free tier (`wallet_stats`/`wallet_activity`, about 1.7 req/s) as a **seed** for candidates. Never use it as a score, since it is leader-PnL based. Read GMGN's API terms first.
    - swap-api's new `fillPriceSol` field for follower-fill pricing in the Copy score.
11. **Safety posture worth stating (S, copy text).** GMGN's agent CLI removed trade confirmations on 10-21 (vendor), and TradeWiz is still refunding a key-exposure drain (press). Krypto Copy's local keys, paper default and per-trade confirmations for arming are a real difference. Say it plainly, without naming rivals in-app.

**Open after this pass:**
- Parsed Streams latency, and whether its `accounts.include` fires on the leader's pump buy instruction (the leader is the `user` account, so it should, but this is unverified).
- Free-plan access to `getTransactionsForAddress`.
- How long the synthetic-migration no-trade window lasts.
- How often pools the copier trades carry negative virtual reserves.
- Whether Jito's tolerance of `jitodontfront` on pump instructions changed.
- Reddit sentiment.
- Cielo's simulation panel.
- Whether the WhiteWhale numbers hold up: the thread was not fetched, and costs and lag are only partly specified.
