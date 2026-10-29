# Copy candidates, week of 2026-10-20 to 2026-10-27

The question: find one wallet on Solana whose trades, copied by Krypto Mirror this week, would have made money. The copy is the app's: 2 s lag (9 slots), 0.1 SOL a copy, pump venue 1.25 % plus Krypt 0.5 % a side, fixed fees, which together set a floor of −7.00 % a round trip at 0.1 SOL.

**Answer:** two wallets came out net positive for the whole week when copied under the app’s rules, and both are thin. `CyrZnTp2MAHeqQSBk4jg9RMcpteFGZRYaHSLB1QHbonF` made +0.57 SOL on 59 copies of 0.1 SOL (+9.6 % a copy, median −4.4 %), with five trips and one evening of launches carrying the week. `DxBphjLCycinZ9i2RybyGbguTxmxX8krReQZr8TD59w8` made +0.18 SOL on 14 copies. The first search, across 165 wallets picked from the app’s records, found nothing better than break-even (`Fr4Bi81w…`, −1.2 % a copy at 0.1 SOL, +1.6 % at 0.5 SOL). The second search, which priced a lagged copy of every one of the 7,828 traders on the week’s 21 winner coins and then replayed the best 47 across their whole week, is where the two came from. No wallet in either search has a copy median above zero. Paper them first. Nothing was signed or sent.

Of the 165 wallets of the first search, 96 were judged: no copy median above zero, one confidence interval clearing the fee floor, and the eight positive means all owed to one or two lottery wins. Leaders that made money for themselves are common (47 made over 5 SOL this week); leaders whose edge survives a 2 s lag and a 7 % floor are not.

## Method

Every number is read from the chain, not from the app's feed. A wallet's swaps come from Helius `getTransactionsForAddress` decoded by `decodeWalletSwap` (the wallet must be a signer), trips from `buildTrips`. Each copy leg is priced at the last trade on the mint at or before the leader's slot plus 9 (pump curve reserves or PumpSwap executed price, `chainPrice.priceTrip`), recorded at 1.5 % a side, then repriced to a 0.1 SOL copy with the paper cost model. Confidence intervals are mint-clustered bootstraps of the median. Copies closed on the four days the app's feed was watching (10-22, 10-23, 10-25, 10-26) are split from copies on the other days; the second set is the out-of-sample test. Scripts and outputs live in the session scratchpad (`research.entry.ts`, `research2.entry.ts`, `research3.mjs`, `coins.entry.ts`, `coins2.entry.ts`, `reprice.entry.ts`), bundled with esbuild against `@shared` and `@app`.

Where the candidates came from:

1. **Pass 1, 51 wallets.** The Scout board (`wallet-scout.json`), the Scout record with loose filters, the pump.fun PnL leaderboard as frozen on Saturday in the pre-registered test's LEAD arm (today's leaderboard could not be fetched: pump.fun's API is Cloudflare-gated from Node and the Electron route was not allowed), and the TOP arm.
2. **Pass 1b, 40 wallets.** Early buyers of the 16 hottest launches of the week from Jupiter's top-traded lists: signers who bought into three or more of them inside the first 1,500 transactions, not in the launch bundle, median buy at least 0.03 SOL.
3. **Pass 3, 80 wallets (74 read).** Slow traders: 11 coins from this month with a market cap of at least 150 k and 100 k of daily volume, sampled at eight points through the week, every signing trader recorded; wallets with a median trade of at least 0.1 SOL across two or more of the coins, or one coin with 1 SOL in and a sell. Pricing credits were spent only on wallets with a median hold over two minutes and under 400 trips in the week.
4. **Pass 2 and 2b.** The least-bad from the passes above, 120 random copies each or every trip, with every rule the app applies: sell at the leader's first sell of half or more, at most three copies open, births read for every coin (sniper and bundle flags), wash and shared-payer checks.
5. **Pass 4.** The named wallet's last 30 days, every trip.

## The one wallet

`Fr4Bi81wbD1bzjMTWPqzQ3Zi6EqmLNUdPrH5mF7VyJg`, found in the slow scan (two of the eleven coins). First swap in its history 2026-10-17; 21 trips in 30 days, 14 this week, 11 of them priced (three were on a non-pump mint the pricer does not cover). Median trade 5.1 SOL, median hold 59 min, at most 2 trades a minute, 7 active days. No snipes, no bundle buys, no wash trips, no shared payers. Own result this week +1.83 SOL on 76.7 SOL turned over (+2.4 %); 30 days +2.61 SOL on 131 SOL. Its SOL balance was 0 when checked, so it is funded from elsewhere per trade; 16 token accounts still hold positions.

Copies at the app's rules, this week (11 priced) and 30 days (17 priced):

| Copy size | Fee floor | Week median | Week mean | Week win | Week CI (median) | 30-day median | 30-day mean | 30-day win |
|---|---|---|---|---|---|---|---|---|
| 0.05 SOL | −10.5 % | −5.7 % | −4.7 % | 27 % | −11.0 … −0.6 | −9.0 % | −6.1 % | 24 % |
| 0.1 SOL | −7.0 % | −2.2 % | −1.2 % | 45 % | −7.5 … 2.9 | −5.5 % | −2.6 % | 41 % |
| 0.25 SOL | −4.9 % | −0.1 % | +0.9 % | 45 % | −5.4 … 5.0 | −3.4 % | −0.5 % | 41 % |
| 0.5 SOL | −4.2 % | +0.6 % | +1.6 % | 55 % | −4.7 … 5.7 | −2.7 % | +0.2 % | 47 % |
| 1 SOL | −3.85 % | +1.0 % | +2.0 % | 55 % | −4.3 … 6.0 | −2.3 % | +0.6 % | 47 % |

The week, trip by trip (copy return at 0.1 SOL and 0.5 SOL):

| Opened (UTC) | Coin | Hold | Leader in | Leader | Copy 0.1 | Copy 0.5 |
|---|---|---|---|---|---|---|
| 10-21 04:07 | DzMwAr…pump | 57 min | 5.05 SOL | −5.7 % | −11.1 % | −8.3 % |
| 10-22 01:50 | HsprHx…pump | 113 min | 4.76 SOL | +0.7 % | −5.5 % | −2.7 % |
| 10-22 16:36 | JAFqCQ… | 66 min | 5.07 SOL | +9.5 % | unpriced | unpriced |
| 10-22 21:01 | JAFqCQ… | 391 min | 5.80 SOL | −15.2 % | unpriced | unpriced |
| 10-23 03:31 | 33jENU…pump | 527 min | 4.92 SOL | +25.1 % | +18.8 % | +21.6 % |
| 10-23 13:52 | 33jENU…pump | 331 min | 6.15 SOL | +7.3 % | +0.9 % | +3.7 % |
| 10-23 19:25 | CTPoyC…pump | 58 min | 6.61 SOL | +9.1 % | +2.9 % | +5.7 % |
| 10-23 20:25 | JAFqCQ… | 61 min | 7.20 SOL | −3.3 % | unpriced | unpriced |
| 10-23 21:31 | Ez7eEs…pump | 11 min | 6.97 SOL | +4.2 % | −2.2 % | +0.6 % |
| 10-24 14:05 | 3w67qw…pump | 51 min | 4.65 SOL | −3.3 % | −7.4 % | −4.6 % |
| 10-24 14:56 | 2TKDNL…pump | 9 min | 4.50 SOL | +11.1 % | +16.3 % | +19.1 % |
| 10-24 15:47 | Buttcoin | 1330 min | 5.00 SOL | +1.8 % | −4.8 % | −2.0 % |
| 10-26 05:38 | 7SL2Vn…pump | 6 min | 5.15 SOL | +12.1 % | +3.6 % | +6.4 % |
| 10-27 06:58 | HACHI | 24 min | 4.90 SOL | −18.7 % | −24.3 % | −21.5 % |

What this says. The leader's edge is about 2 % a trip. At 0.1 SOL the app's costs are 7 % a round trip, so the copy loses what the leader wins; at 0.5 SOL and up the fixed part of the fee stops mattering and the copy is slightly positive. The confidence interval spans zero at every size. The previous week (9 trips, 8 priced) copied at about −9 % at 0.1 SOL and −6 % at 1 SOL. Two weeks, one flat and one losing, is not evidence of an edge. It is the best wallet found, which is a statement about the search, not a recommendation to fund it.

If it is copied at all: 0.5 SOL or more a copy (the leader's 5 SOL trips on coins with 150 k+ market caps can absorb that), the app's half-sell exit, and a paper week first. The unpriced coin (`JAFqCQ…`) is on a venue the app does not trade, so those three trips would not have been copied.

## Why the other 164 are not it

Aggregate over the 96 judged wallets (at least 10 priced copies, 0.1 SOL, 2 s lag):

| | |
|---|---|
| Median wallet's copy median | −10.6 % |
| Median wallet's copy mean | −8.1 % |
| Wallets with copy median above the −7 % floor | 13 |
| Wallets with copy median above zero | 0 |
| Wallets with copy mean above zero | 8 (every one driven by one to three trips) |
| Wallets with CI lower bound above the floor | 1 (7FPqg7Mp; its mean is −12.4 %) |
| Wallets with CI lower bound above zero | 0 |
| Leaders with own PnL over 5 SOL this week | 47; their copies' median of medians −10.3 % |

The best self-traders are the worst copies: 9keCU8mg made +71 SOL and copies at −19.9 %; EqiFgyNw +64 SOL, copies −28.8 %; DQMqCjCi +60 SOL, copies −28.6 %. Their trades are first-block entries and sub-minute exits, which the 2 s lag turns into buying the top.

The pass-2 finalists, with every app rule applied (120 random copies each):

| Wallet | Week trips | Hold | Median trade | App rules median / mean / win | CI | Days negative | Snipes | Own PnL |
|---|---|---|---|---|---|---|---|---|
| 7FPqg7Mp | 3790+ | 196 s | 0.24 SOL | −3.3 / −10.8 / 41 % (70) | −5.8 … 1.7 | 5/5 | 5/107 | −2.6 SOL |
| HL9rRBGS | 1434 | 91 s | 0.012 SOL | −7.3 / −7.8 / 36 % (112) | −10.0 … −3.0 | 5/6 | 24/116 | +2.3 SOL |
| NUTN33YP | 997+ | 63 s | 1.04 SOL | −10.0 / −16.6 / 5 % (20) | −14.9 … −6.7 | 2/2 | 0/111 | +20.4 SOL |
| 72NWWbch | 3932+ | 23 s | 0.56 SOL | −7.1 / −7.5 / 30 % (116) | −11.5 … −5.2 | 6/6 | 0/115 | +4.4 SOL |
| 34VJYaeq | 3944+ | 79 s | 0.20 SOL | −10.9 / −9.4 / 22 % (105) | −15.8 … −8.3 | 7/7 | 20/118 | +6.3 SOL |
| E6rUq5Bt | 1498 | 13 s | 0.30 SOL | −8.2 / −6.5 / 23 % (113) | −9.6 … −6.7 | 7/7 | 0/108 | +4.8 SOL |
| 8ZwGubL4 | 223 | 58 s | 0.017 SOL | −1.0 / −7.4 / 47 % (76) | −14.1 … 3.9 | 2/2 | 0/75 | −0.6 SOL |
| 6CT7cjJu | 62 | 38 s | 0.10 SOL | −3.2 / +19.2 / 48 % (60) | −26.3 … 30.7 | 0/2 | 30/60 | +0.0 SOL |

6CT7cjJu is the only positive mean and it is a coin creator buying its own launches inside the bundle (30 of 60), which the app's exclusions already reject. 7FPqg7Mp's median is the best of the fast traders but its mean is −10.8 % and every one of its five days is negative.

The slow-trader pass (pass 3) priced 26 wallets. Three besides the named one had a positive mean: 9sg8xipr (+17.6 % on 59 sampled copies, but −0.1 % without its top three, and −5.8 % with every trip and the app's rules), FixukbsK (+1.4 %, −5.3 % without the top three, −4.1 % under app rules; own PnL +31.9 SOL over 433 trips of 2 SOL, a strong trader whose edge is in the entries the copy misses), and 3zkT8Y22 (+7.3 % from one +420 % trip; −19.8 % without the top three). 31 of the pool were busier than 400 trips a week or faster than two minutes and were not priced; 23 had too few trips or none the pricer covers.

Full per-pass tables are in the appendix.

## Second search: every trader on the week's winner coins

The first search read 165 wallets picked from the app's own records and from launch sniping, and the objection to its result was fair: thousands of wallets trade every week and the sample was tiny and skewed to fast pump bots. The second search inverted the method. Instead of picking wallets and pricing their trips one by one, it read the whole week of trades on the coins that went up and kept a market, and priced a lagged copy of every signing trader's trips on them from that one stream. One coin read prices every wallet on it, so 21 coin reads (42,070 credits) judged 7,828 wallets on those coins.

Coins: from Jupiter's eight token lists on 10-27, pump-launched coins younger than 14 days with a market cap of at least 150 k and 20 k of liquidity (14), plus pump coins 14 to 90 days old with a market cap over 1 M and 500 k of daily volume (7): Kimchi, REMUS, Macca, ███, DacityCoin, McRib, XD, Nothing, HACHI, NIO, FTR, PMUP, Pokémon, ANT, BTC, GATO, Dacity, CLAUDIA, baton, HOTBOT, DOPE. Each was read to a cap of 20,000 transactions, which every one of them hit, so a coin younger than a week is covered from launch and an older coin for its newest two or three days. Copy entry is the price nine slots after the trader's first buy, exit nine slots after the first sell of half or more (the app's rule) or the last sell.

On those coins, 3,156 of the 7,828 traders (40 %) are copy-positive, and 100 of the 284 with five or more trips. That is the honest version of "there must be profitable traders": on a coin that went up, most people who bought and sold made money, and a lagged copy of them did too. The test is the rest of their week.

Candidates for that test: at least two priced trips on the scanned coins, median copy return above zero, at least half winners, median buy at least 0.1 SOL, median hold at least 30 s, not sniper-led. 50 qualified; five had already been judged in the first search (7FPqg7Mp, 34VJYaeq, DpmnqVgC, MriyaNN8, GkZbaqoF: all of them look good on the winner coins and lose across their week, which is the selection effect in one line) and three were copies of one bot trading the same slots. The 47 others had 50 random trips of their whole week priced with the app's pricer (pass 5, 41,570 credits); copy returns were checked trip by trip against the leader's own return, which caught the scan's own top entries (three 15 SOL arbitrage round trips on the BTC pool printed as +1,839 %) and nothing else.

Of the 41 with at least five clean priced copies, 37 lose over the week and four come out ahead on the sample, every one with a negative median: FTiA4rws, Cv5GgkpX, CyrZnTp2, DxBphjLC. Those four were then priced with every app rule, 150 trips each or all of them (pass 6, 9,040 credits):

| Wallet | Week trips | Priced | Hold | Median trade | Median | Mean | Win | Week total at 0.1 SOL | CI (median) | Unseen days mean | Mean without top 5 | Own PnL |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| FTiA4rws | 548 | 85 | 29 s | 0.20 SOL | −20.3 % | −12.3 % | 19 % | −1.04 SOL | −25.5 … −11.7 | −17.7 % (32) | −15.3 % | +10.8 SOL |
| Cv5GgkpX | 1402 | 107 | 68 s | 1.30 SOL | −21.2 % | −8.7 % | 29 % | −0.93 SOL | −29.8 … −13.0 | −18.4 % (49) | −12.6 % | −34.8 SOL |
| CyrZnTp2 | 107 | 59 | 45 s | 0.54 SOL | −4.4 % | +9.6 % | 44 % | +0.57 SOL | −13.2 … 6.6 | +20.9 % (39) | −0.3 % | +3.2 SOL |
| DxBphjLC | 31 | 14 | 232 s | 2.00 SOL | −0.3 % | +12.8 % | 43 % | +0.18 SOL | −7.3 … 17.4 | +25.4 % (9) | −12.8 % | +4.4 SOL |

The two busy wallets fall apart once more than 35 of their trips are priced. The two small ones hold up, and they are what the week has to offer.

**`CyrZnTp2MAHeqQSBk4jg9RMcpteFGZRYaHSLB1QHbonF`** is the one wallet whose whole week, copied under the app's rules, nets positive: +0.57 SOL on 59 copies of 0.1 SOL (5.9 SOL turned over), +9.6 % a copy on average. Every one of its 107 trips was read; 48 could not be priced (25 on coins outside pump.fun and PumpSwap, 22 pump coins with no trade near the copy slot, 1 faster than two seconds), and the app would not have copied most of those either. Trades of 0.3 to 1 SOL, holds of 17 s to 2.5 min (median 45 s), at most 8 trades a minute, 98 coins over 5 active days, one snipe and one bundle buy in 59. Balance 6.1 SOL, active since February. The caveats are the whole story: five trips make the week (+357, +196, +103, +80, +77 %; without the top five the mean is −0.3 %), the median copy loses 4.4 %, and 34 of the 59 copies and all of the profit are from one day, 10-26, when three of the week's big launches happened in one evening. Its 10-22 was −0.18 SOL on 20 copies. The confidence interval on the median spans zero. Out-of-sample by day it is positive (+20.9 % on the 39 copies on days the feed was not watching), which is better than every other wallet in both searches managed.

**`DxBphjLCycinZ9i2RybyGbguTxmxX8krReQZr8TD59w8`** is the slower cousin: 2 SOL trades, four-minute holds, 3 trades a minute at most, 26 coins, 48 SOL in the wallet, +0.18 SOL on 14 copies. Only 14 of 31 trips could be priced and three of them carry the result (without the top three the mean is −7.4 %). Too thin to say more than "not negative".

What to do with them: paper both on the Follow page at 0.1 SOL, CyrZnTp2 with the half-sell exit, and look at the day split after a week. A wallet whose week was made by one evening of launches is a bet on that evening repeating. If it does repeat, the numbers above are what it pays; if it does not, the median says −4 % a copy.

Credits for this second search: 92,680 (scan 42,070; pass 5 41,570; pass 6 9,040). Both searches together: 304,060, none of it counted in the app's meter.

## How to rerun this

The whole pipeline is in the repo as `scripts/analysis/copy-candidates.mjs` (stages: coins, scan, pool, replay, split, rules, size; `all` runs them in order). It bundles the stage files beside it with esbuild against `@shared` and `@app`, reads the Helius key from `HELIUS_API_KEY` or the app’s settings, and writes everything under `test/.copy-candidates/<date>`. A full run is about 90,000 credits at the defaults (21 coins, 50 wallets replayed); the log prints the spend, which the app’s meter does not count.

```
node scripts/analysis/copy-candidates.mjs all --observed "[20747,20748,20750,20751]"
node scripts/analysis/copy-candidates.mjs replay --wallets <addr1>,<addr2>     # judge given wallets
node scripts/analysis/copy-candidates-follow.mjs --wallets <addr1>,<addr2>     # paper-follow them (app closed)
```

What to look at in the output: `replay-analysis.json` gives every replayed wallet’s week split into in-scan and out-of-scan trips with the bad-print count; `rules-summary.json` gives the finalists under the app’s rules with the day split and the sniper and bundle counts; the size stage prints the fee floor and the return at each copy size. A wallet is worth a paper week when its rules total is positive, its out-of-scan trips are not negative, and the mean without its top five trips is near zero or better. Nothing so far has had a copy median above zero; do not expect one.

## In the app

The same search is a Scout scan since 2026-10-27. On Discover, next to **Scan**, **Scan the week’s winners** (Solana only) lists this week’s coins from Jupiter — pump-launched, up to 16 younger than 14 days with a market cap of 150 k and 20 k of liquidity, by cap, plus up to 8 runners of 14 to 90 days with a 1 M cap and 500 k of daily volume, by volume (`pickWinnerCoins` in `shared/walletScout.ts`) — and reads each one’s whole week from the chain, 200 pages at most, two coins at a time. Every wallet that **signed** a trade on them is fed through the same record as the live feed, so one coin’s week prices a lagged copy of every wallet on it. Chain only (no pump.fun fallback): about 2,000 credits a coin from the backtest allowance, 48,000 at most, reserved a coin at a time; the status line says when the allowance stopped it. The scan strip shows the backtest allowance as a bar (used, left, and what each scan costs: Scan at most 1,800 credits, the winners scan 2,000 a coin and 48,000 for all 24, with how many coins the remaining allowance covers) and what the last scan took; the prices on the buttons come from the same constants the sources reserve against, and the page price is pinned to the RPC client’s bill by test. The signer rule applies to the recent scan too: a trade the pump event credits to an account that did not sign (a program’s vault, the ARu4n5mF case) is dropped by both chain-read sources. The live feed still cannot check this — its log notifications carry no account keys.

The board then has the figure the search ranked on. The **Week total** view sorts on every copied trade at the chosen size added up over the window (`fSumPct`, shown in SOL as `fTotalSol`), with the mean without the best five copies beside it (`fTrimmedMeanPct`, needs ten copies); both are on every row under the bound. Read them the way the table above is read: a positive total over a negative median is a wallet carried by a few trades, and the trimmed mean says what is left without them. The view keeps the bot, enough-trades, reachable and clean filters; the shrunk lower bound and the copy score are unchanged and still the default ranking.

What the app does not do that the pipeline does: price a wallet’s trips on coins the scan did not read (the pipeline’s replay stage), check copies against the leader’s own return trip by trip (the bad-print test), split the week by day, or reprice at other sizes in one table. For a wallet the board turns up, read it with the profile page (the chain reader, all of its week) before following it.

## Limits

- The feed watched four of the seven days, so Scout candidates are biased toward wallets active on those days; the out-of-sample split handles the in-sample bias but not the selection.
- Pricing covers pump.fun and PumpSwap pools only. Raydium, Meteora and Orca trips are unpriced; a wallet that trades those well is invisible here.
- Busy wallets were read to a cap of 6,000 transactions (8,000 in pass 2, 3,000 in pass 3), so their weeks are the newest part only (marked "+").
- The slow scan sampled 11 coins at 8 points, 300 transactions each, so it sees traders who were active at those moments on those coins. The 31 slow-but-busy wallets it skipped (hour-long holds, 600 to 1,300 trips a week) are the next place to look.
- The pump.fun leaderboard used is Saturday's frozen copy, not today's.
- Jupiter's lite-api rate-limited two of its lists; the others sufficed.
- Credits: the passes spent about 211,000 Helius credits (pass 1 67,320; pass 1b 60,310; pass 2 22,100; pass 3 40,250; pass 2b 16,100; pass 4 230; coin scans about 5,070). This spend is not in the app's credit meter (`helius-credits.json`), which only counts the app's own calls.

## Bugs found on the way

- **Scout credits trades to non-signers.** The live feed's pump TradeEvent handling (`electron/engine/engine.ts`, the curve handler near line 6250 and the AMM handler near line 6025) takes the event's `user` as the trader without checking that it signed the transaction. The Parsed Streams path has the signer rule; these two do not. Result: `ARu4n5mF…`, a system-owned account with thousands of transactions a minute and no swaps of its own, sits at the top of the TOP arm of the pre-registered test with a fictional record. Fix: require `user` to be within the first `numRequiredSignatures` account keys, as `decodeWalletSwap` and the slow scan do.
- **PumpSwap pricing on non-pump pools.** `chainPrice.priceTrip` decodes some PumpSwap pools with base and quote inverted and returns figures like +153,782,147 % (mint `33jENUQn…` in pass 1). Pass 2 discards any return over 10,000 % in magnitude; the board should do the same, or check the pool's token order before trusting the executed price.
- **The fixed fee is half the floor at 0.1 SOL.** The paper cost model charges 3.5 mSOL a round trip in fixed fees, which is 3.5 % of a 0.1 SOL copy and 0.35 % of a 1 SOL copy. Any wallet whose edge is under 7 % a trip cannot be copied at 0.1 SOL whatever the lag. The Follow page's % sizing or a minimum copy size would say this to the user before they start.

## Appendix: every judged wallet

### Pass 1: the board, the Scout record and pump.fun’s top 10 (51 wallets, 80 random copies each)

Floor -7 % (fees alone at 0.1 SOL). Sorted by the lower bound of the median. "+" after the trip count: only the newest 6,000 transactions were read. "Unseen days": copies closed on days the app’s feed was not watching.

| Wallet | Found by | Week trips | Hold | Copies priced | Median | Mean | Win | CI (median) | Unseen days median | Own PnL | Trades/min peak |
|---|---|---|---|---|---|---|---|---|---|---|---|
| HL9rRBGS | scout | 1421 | 91 s | 79 | -0.2 % | -3.6 % | 49 % | -7.2 … 4.4 | 0 % (35) | 2.3 SOL | 8 |
| 72NWWbch | scout | 2935+ | 24 s | 78 | -5.8 % | -8.6 % | 32 % | -9.8 … -2.8 | -6.5 % (47) | 2.8 SOL | 14 |
| HVE8996r | scout, pnl | 2457+ | 88 s | 78 | -8.5 % | -7.8 % | 22 % | -11.1 … -7.5 | -10.4 % (33) | 1 SOL | 10 |
| 34VJYaeq | scout, pnl | 2956+ | 83 s | 77 | -9.5 % | -0.9 % | 31 % | -11.1 … -6.5 | -9.7 % (44) | 6.9 SOL | 10 |
| omegoMAe | scout | 2393+ | 31 s | 59 | -9 % | -5.1 % | 34 % | -11.5 … -0.6 | -9 % (59) | 66.2 SOL | 42 |
| 2tgUbS9U | scout | 892+ | 205 s | 76 | -9.4 % | -3.9 % | 28 % | -12 … -4.7 | -9.4 % (76) | 9.3 SOL | 59 |
| EprLoV21 | scout | 2872+ | 9 s | 77 | -10.3 % | -9.2 % | 19 % | -12.4 … -9.1 | -10.3 % (22) | 5.1 SOL | 29 |
| GKd5EMzR | scout | 1125+ | 8 s | 68 | -9.5 % | -9.2 % | 9 % | -12.5 … -8.6 | -9.5 % (68) | 0.8 SOL | 35 |
| 84o1aRcp | scout, pnl | 2339+ | 91 s | 51 | -9.1 % | -8.1 % | 24 % | -12.7 … -6.6 | -6.6 % (3) | 13.6 SOL | 12 |
| 4oN18efp | scout | 2875+ | 8 s | 78 | -11.6 % | -10.4 % | 15 % | -12.7 … -9.6 | -7.9 % (22) | -2.5 SOL | 32 |
| sssssDdM | scout | 2879+ | 18 s | 73 | -11 % | -8.6 % | 21 % | -12.8 … -9.6 | -11 % (73) | 39.2 SOL | 52 |
| DpmnqVgC | scout, pnl | 2148 | 30 s | 80 | -9.2 % | -6.2 % | 24 % | -13.1 … -8.3 | -10.4 % (26) | -9.8 SOL | 13 |
| 2zMj6wNq | scout | 2897+ | 15 s | 79 | -9.9 % | -4.3 % | 19 % | -13.1 … -9.2 | -12.2 % (29) | -3.9 SOL | 14 |
| 6SFc4bF5 | scout, pnl, prereg TOP | 2678+ | 64 s | 80 | -10.4 % | -6.3 % | 19 % | -13.9 … -8.2 | -10.8 % (31) | 5.8 SOL | 12 |
| ABbi258T | scout | 2909+ | 15 s | 76 | -11 % | -5.1 % | 22 % | -14.2 … -6.8 | -7.4 % (17) | -3.9 SOL | 20 |
| 2TZonxx5 | board, scout, pnl | 2653+ | 300 s | 79 | -11.7 % | -5.2 % | 25 % | -14.5 … -6.9 | -9.9 % (52) | 5.3 SOL | 13 |
| haqqiUUX | scout | 1635+ | 7 s | 62 | -10 % | -7 % | 26 % | -14.5 … -6.1 | -10 % (62) | 11.3 SOL | 88 |
| GjKjTmzu | board, scout, pnl | 2927+ | 322 s | 80 | -12.2 % | -3.4 % | 30 % | -15.9 … -7.2 | -9.2 % (37) | -0.7 SOL | 9 |
| H6obhoSN | scout, pnl | 2494+ | 90 s | 79 | -10.5 % | -9.5 % | 20 % | -16 … -6.9 | -10.9 % (41) | 2.1 SOL | 9 |
| 5HVzdFQ4 | scout | 375+ | 42 s | 53 | -11.4 % | -1.2 % | 36 % | -16 … -8.2 | -12.5 % (19) | -1.1 SOL | 25 |
| BUkpShoE | scout | 2950+ | 26 s | 79 | -12.5 % | -8.8 % | 28 % | -17.5 … -10.1 | -12.5 % (79) | 2.7 SOL | 36 |
| 8ZwGubL4 | scout, pnl | 223 | 58 s | 56 | -6.2 % | -8.1 % | 45 % | -18.2 … 4.5 | -7.3 % (44) | -0.6 SOL | 10 |
| Bpv3GFKY | scout | 2954+ | 13 s | 78 | -13.9 % | -11.1 % | 22 % | -18.5 … -9.4 | -9.8 % (40) | 8.6 SOL | 20 |
| HFqqybUh | board, scout, pnl | 2262+ | 117 s | 76 | -13.9 % | -7.1 % | 13 % | -18.6 … -11.5 | -14.4 % (38) | -6.9 SOL | 14 |
| 47du2vFg | scout | 1412+ | 82 s | 54 | -15.5 % | -12.2 % | 20 % | -19 … -8.6 | -13.1 % (21) | -28.1 SOL | 23 |
| 9bwHbhAE | scout | 2987+ | 21 s | 79 | -14.7 % | -10 % | 22 % | -20.7 … -9.6 | -19.8 % (32) | 2.2 SOL | 10 |
| J6YEG5cm | scout | 2265+ | 19 s | 80 | -11.5 % | -11.8 % | 31 % | -21.2 … -5.4 | -11.5 % (70) | 64.1 SOL | 23 |
| 3iawEZGf | scout | 1700+ | 26 s | 76 | -16.2 % | -9.8 % | 29 % | -23.5 … -9.6 | -16.2 % (76) | 0 SOL | 30 |
| Bck5r87K | scout | 1294+ | 82 s | 52 | -17 % | -7.3 % | 21 % | -26.1 … -11.3 | -17.1 % (11) | -10.4 SOL | 19 |
| 6CT7cjJu | scout | 62 | 38 s | 60 | -3.2 % | 19.2 % | 48 % | -26.3 … 31.1 | -5.3 % (25) | 0 SOL | 5 |
| 9keCU8mg | board, scout, pnl | 875+ | 80 s | 59 | -19.9 % | -15.3 % | 22 % | -28.8 … -17.2 | -21.6 % (25) | 71.1 SOL | 9 |
| EUiwrgJY | scout | 321 | 48 s | 58 | -19.7 % | 5.7 % | 26 % | -29.7 … -14.4 | -20.1 % (39) | -23.1 SOL | 20 |
| 2NWQUKUg | pnl | 83 | 355 s | 79 | -15.5 % | -11.9 % | 29 % | -29.8 … -7.7 | -19.3 % (32) | 0 SOL | 2 |
| Hz1PRata | scout | 284 | 66 s | 52 | -15 % | -17.4 % | 19 % | -30.8 … -9.5 | -18.9 % (23) | -3.3 SOL | 110 |
| EqiFgyNw | board, scout, pnl | 718+ | 42 s | 60 | -28.8 % | -18.2 % | 15 % | -32.5 … -25 | -32.3 % (28) | 64.1 SOL | 30 |
| Dbw2puFE | scout | 155 | 95 s | 64 | -24.1 % | -23.9 % | 17 % | -32.7 … -15.4 | -38.1 % (8) | -1.5 SOL | 7 |
| 5Voxqwa8 | scout | 679+ | 9 s | 69 | -7.6 % | -14.7 % | 38 % | -34.6 … -4.7 | -24.7 % (39) | -7.5 SOL | 58 |
| 4BYjXY3R | pump top-10 | 140 | 78 s | 57 | -24.5 % | -3.7 % | 37 % | -48.4 … -1.4 | -25.8 % (27) | 4.3 SOL | 7 |
| EnPjBjzy | pump top-10 | 61 | 203 s | 35 | -41.7 % | -41.7 % | 3 % | -59.4 … -39.6 | -47.6 % (21) | -660.4 SOL | 5 |

Not judged (under 20 priced copies):

- 2VpmFNar (pump top-10): 6000 transactions read, 313 swaps, 16 trips in the week, 5 priced
- 3vXNqvra (pump top-10): 5660 transactions read, 220 swaps, 25 trips in the week, 10 priced
- 8whS3YkN (pump top-10): 6000 transactions read, 418 swaps, 16 trips in the week, 7 priced
- Crg4yePL (pump top-10): 655 transactions read, 60 swaps, 10 trips in the week, 6 priced
- DQMqCjCi (pump top-10): 5173 transactions read, 341 swaps, 24 trips in the week, 15 priced
- ARu4n5mF (board, scout, pnl, prereg TOP): 6000 transactions read, 0 swaps, 0 trips in the week, 0 priced
- 3PBV7Duz (scout): 210 transactions read, 68 swaps, 0 trips in the week, 0 priced
- 77shyvx7 (scout): 5263 transactions read, 1318 swaps, 0 trips in the week, 0 priced
- qPxNSutg (scout): 78 transactions read, 32 swaps, 0 trips in the week, 0 priced
- 3kYukWCD (pump top-10): 4868 transactions read, 67 swaps, 2 trips in the week, 1 priced
- 4UrFSCrG (pump top-10): 1093 transactions read, 0 swaps, 0 trips in the week, 0 priced

### Pass 1b: early buyers of this week’s 16 hottest launches (40 wallets, 80 random copies each)

Wallets that bought, as the signer, into three or more of the 16 inside the first 1,500 transactions, not in the launch bundle, median buy at least 0.03 SOL.

| Wallet | Found by | Week trips | Hold | Copies priced | Median | Mean | Win | CI (median) | Unseen days median | Own PnL | Trades/min peak |
|---|---|---|---|---|---|---|---|---|---|---|---|
| 7FPqg7Mp | launch scan (8 coins) | 2845+ | 190 s | 72 | -3.9 % | -7.9 % | 43 % | -6 … 5.1 | -3.9 % (42) | -0.7 SOL | 19 |
| 7Segg5fr | launch scan (3 coins) | 2354+ | 4 s | 62 | -7 % | -5.1 % | 21 % | -9 … -5.8 | -7 % (34) | -6 SOL | 20 |
| NUTN33YP | launch scan (5 coins) | 826+ | 62 s | 70 | -6.1 % | -1.1 % | 33 % | -9.1 … -3.1 | -6.1 % (70) | 20.2 SOL | 16 |
| E6rUq5Bt | launch scan (4 coins) | 1502 | 13 s | 78 | -7.4 % | -4 % | 27 % | -9.4 … -4.5 | -9 % (36) | 4.7 SOL | 9 |
| 67LwNGru | launch scan (3 coins) | 2261+ | 14 s | 71 | -7.4 % | -8.8 % | 18 % | -9.9 … -7.1 | -7.8 % (36) | -3.9 SOL | 41 |
| 2Dd3TRSd | launch scan (6 coins) | 2976+ | 5 s | 59 | -7.5 % | -5.9 % | 27 % | -10.1 … -6.3 | -7.5 % (59) | 7 SOL | 27 |
| 2k6aaxsz | launch scan (3 coins) | 1919+ | 1 s | 20 | -6.8 % | -7 % | 20 % | -10.1 … -4 | -6.7 % (3) | 7.8 SOL | 14 |
| 3MHgGwdL | launch scan (6 coins) | 2857+ | 4 s | 64 | -8.1 % | -4.9 % | 27 % | -10.4 … -6.3 | -8.1 % (64) | 4.2 SOL | 49 |
| AFrSqSLk | launch scan (5 coins) | 2858+ | 48 s | 73 | -7.4 % | -4.4 % | 25 % | -10.8 … -6.9 | -7.4 % (73) | 43.7 SOL | 28 |
| 8PgC4ngp | launch scan (5 coins) | 2974+ | 14 s | 73 | -10.5 % | -6 % | 23 % | -11.8 … -6 | -10.5 % (73) | -3.2 SOL | 33 |
| EMKY7r6U | launch scan (5 coins) | 2725+ | 8 s | 77 | -10.6 % | -8.1 % | 22 % | -12.2 … -8.3 | -10.6 % (77) | 3.1 SOL | 52 |
| 8ZdLGkVb | launch scan (4 coins) | 2142+ | 41 s | 68 | -8.7 % | -10.5 % | 15 % | -12.3 … -8 | -8.3 % (32) | 7.5 SOL | 24 |
| SQHK48QT | launch scan (6 coins) | 2655+ | 16 s | 78 | -10.6 % | -9.6 % | 21 % | -12.5 … -7.6 | -9.6 % (51) | -0.7 SOL | 13 |
| ocBBRKb1 | launch scan (3 coins) | 2654+ | 4 s | 73 | -10.1 % | -7.4 % | 21 % | -12.7 … -8.3 | -10.3 % (36) | 3.4 SOL | 21 |
| H6Q4HhDm | launch scan (3 coins) | 2388 | 15 s | 70 | -9.6 % | -7.2 % | 21 % | -12.9 … -6.2 | -9.6 % (70) | 0.4 SOL | 25 |
| ssssswdk | launch scan (7 coins) | 2319+ | 14 s | 72 | -10.4 % | -9.5 % | 21 % | -13 … -6.2 | -10.4 % (72) | 15.8 SOL | 74 |
| 64hP97Bw | launch scan (5 coins) | 2521+ | 11 s | 77 | -10.4 % | -4.2 % | 29 % | -13.4 … -5.5 | -10.6 % (40) | 1.2 SOL | 15 |
| Eiqnyiiv | launch scan (3 coins) | 325 | 6 s | 62 | -7.3 % | -4.1 % | 24 % | -13.6 … -3.7 | -7.1 % (61) | -1.6 SOL | 11 |
| 9pQQc1xy | launch scan (7 coins) | 2550+ | 32 s | 69 | -11.4 % | -7.4 % | 25 % | -13.7 … -8.4 | -11.4 % (69) | 19.5 SOL | 41 |
| 7PedQZmc | launch scan (6 coins) | 794+ | 9 s | 71 | -11 % | -11.3 % | 14 % | -13.7 … -7.9 | -11 % (71) | 6.3 SOL | 15 |
| 6anjqMeW | launch scan (3 coins) | 1823+ | 5 s | 35 | -10 % | 9.2 % | 29 % | -16.4 … -3.4 | -7 % (22) | 40.9 SOL | 30 |
| 9qz7cWBq | launch scan (6 coins) | 214+ | 11 s | 69 | -10.8 % | -10.9 % | 25 % | -16.8 … -7.3 | -10.8 % (69) | 12.1 SOL | 28 |
| mwamTohZ | launch scan (4 coins) | 1568+ | 27 s | 34 | -12.2 % | -2.8 % | 32 % | -16.9 … -6.7 | -3.3 % (13) | 4.5 SOL | 21 |
| Bcn2qwBC | launch scan (6 coins) | 2955+ | 3 s | 51 | -13.6 % | -10.4 % | 27 % | -17.7 … -5.9 | -16.9 % (26) | -0.1 SOL | 32 |
| 7JVQMwRj | launch scan (4 coins) | 724+ | 33 s | 41 | -13.8 % | -10.3 % | 20 % | -18.8 … -9.5 | -13.8 % (37) | 5.5 SOL | 22 |
| GpFgPBsb | launch scan (3 coins) | 2203+ | 120 s | 79 | -13.3 % | -9.2 % | 25 % | -19 … -9 | -9.7 % (32) | -7.1 SOL | 12 |
| 9Co41DEs | launch scan (4 coins) | 617 | 66 s | 55 | -12.5 % | -9.7 % | 27 % | -20.8 … -8.3 | -9.4 % (26) | -20.2 SOL | 25 |
| 9bvyLrMz | launch scan (3 coins) | 809 | 25 s | 55 | -13.7 % | -5.1 % | 27 % | -24 … -7.9 | -3.4 % (14) | -0.4 SOL | 13 |
| B4BgVAZ6 | launch scan (4 coins) | 469 | 23 s | 47 | -17.2 % | -10.1 % | 32 % | -24.2 … -2.1 | -3 % (33) | -3.1 SOL | 6 |
| 6Nn8eqym | launch scan (7 coins) | 1020+ | 18 s | 41 | -19.5 % | -11.6 % | 22 % | -25.8 … -9.3 | -20.3 % (36) | -8.1 SOL | 46 |
| 5dcHmDFv | launch scan (4 coins) | 416 | 86 s | 46 | -19.4 % | -13.1 % | 20 % | -26.8 … -13.1 | -17.9 % (31) | 14.3 SOL | 24 |
| 6rLEsC8f | launch scan (4 coins) | 336 | 28 s | 52 | -13.7 % | -12 % | 35 % | -27.4 … -1.5 | -14.4 % (23) | -12.3 SOL | 15 |
| AjwfW8Bu | launch scan (4 coins) | 2509+ | 270 s | 80 | -16.8 % | -16.2 % | 35 % | -32.8 … -3.9 | -25.4 % (36) | 5.2 SOL | 7 |
| FZU56d9i | launch scan (7 coins) | 966+ | 86 s | 67 | -30.1 % | -20.3 % | 9 % | -34 … -24.7 | -25 % (30) | -10.2 SOL | 20 |
| 2TiWXDkt | launch scan (3 coins) | 487 | 31 s | 53 | -23.9 % | -21.6 % | 17 % | -35.9 … -17.7 | -28.3 % (29) | -4.2 SOL | 6 |

Not judged:

- FaNaUysv: 6000 transactions, 3849 swaps, 950 trips, 15 priced — cap
- G9gmk9ms: 6000 transactions, 240 swaps, 48 trips, 5 priced
- Eu1KU118: 6000 transactions, 913 swaps, 187 trips, 0 priced
- 7iVCXQn4: 6000 transactions, 3 swaps, 0 trips, 0 priced
- 5MTFCNHt: 4790 transactions, 3435 swaps, 1006 trips, 0 priced — cap

### Pass 3: slow traders from this week’s coins that still hold a market (pricing only wallets with a median hold over 2 min and under 400 trips)

Candidates: signing traders with a median trade of at least 0.1 SOL seen in two or more of 11 coins (sampled at 8 points through the week), or in one with at least 1 SOL in and a sell.

| Wallet | Found by | Week trips | Hold | Copies priced | Median | Mean | Win | CI (median) | Unseen days median | Own PnL | Trades/min peak |
|---|---|---|---|---|---|---|---|---|---|---|---|
| Fr4Bi81w | slow scan (2 coins) | 14 | 3556 s | 11 | -2.2 % | -1.2 % | 45 % | -7.4 … 3.1 | -0.6 % (6) | 1.8 SOL | 2 |
| 7KyEvScK | slow scan (2 coins) | 39+ | 2158 s | 21 | -6.4 % | -12 % | 14 % | -8.1 … -5 | -6.4 % (21) | 13.1 SOL | 32 |
| A6WvvXgd | slow scan (2 coins) | 325 | 4586 s | 50 | -5.3 % | -6.6 % | 20 % | -8.4 … -3.2 | -5.5 % (24) | 8.2 SOL | 7 |
| 2E5K1Nvi | slow scan (2 coins) | 205 | 445 s | 41 | -8.4 % | -7.7 % | 15 % | -10.7 … -7.7 | -8.7 % (31) | 6.3 SOL | 4 |
| AyosUDBq | slow scan (2 coins) | 45+ | 53549 s | 42 | -8.3 % | -4.8 % | 26 % | -11.2 … -6.1 | -8 % (15) | 14.9 SOL | 3 |
| 3YDtJ3dG | slow scan (3 coins) | 311 | 24842 s | 44 | -6.5 % | -6.6 % | 39 % | -11.5 … 2 | -7.1 % (40) | 0.4 SOL | 123 |
| BJSYLfPj | slow scan (2 coins) | 301 | 18002 s | 37 | -6.5 % | -4.8 % | 32 % | -11.6 … -3 | -9.7 % (19) | 0 SOL | 22 |
| AqpVFSGt | slow scan (2 coins) | 245 | 6004 s | 40 | -8.5 % | -15 % | 8 % | -12.6 … -6.7 | -8.5 % (12) | -0.7 SOL | 13 |
| ebZRtCmG | slow scan (2 coins) | 175 | 247 s | 48 | -9.2 % | -10.6 % | 10 % | -13.1 … -7.9 | -12 % (16) | 10.2 SOL | 7 |
| 9sg8xipr | slow scan (2 coins) | 273+ | 43554 s | 59 | -1 % | 17.6 % | 49 % | -13.9 … 9.4 | -15.2 % (18) | 1.7 SOL | 5 |
| 9WqWDvDf | slow scan (2 coins) | 144 | 23535 s | 41 | -9.4 % | -10.9 % | 20 % | -14.7 … -5.5 | -9.3 % (38) | -1.9 SOL | 32 |
| FixukbsK | slow scan (2 coins) | 224+ | 43200 s | 60 | -10.9 % | 1.4 % | 38 % | -16.2 … 0.5 | -9.4 % (21) | 14.3 SOL | 8 |
| 6xNvj6YP | slow scan (2 coins) | 66 | 2474 s | 42 | -14.8 % | -23.8 % | 21 % | -26.3 … -6.3 | -10.2 % (27) | -19.8 SOL | 4 |
| 6bCT7cH4 | slow scan (2 coins) | 12+ | 10040 s | 10 | -12.7 % | -15 % | 10 % | -27.7 … -5.7 | — | 5.6 SOL | 12 |
| EXM2ng4h | slow scan (2 coins) | 326+ | 806 s | 42 | -12.9 % | 225.7 % | 21 % | -28.9 … -6.8 | -6.7 % (13) | -5.9 SOL | 9 |
| 3zkT8Y22 | slow scan (2 coins) | 201 | 444 s | 22 | -9.9 % | 7.3 % | 32 % | -29.1 … 0.1 | 0.3 % (8) | -8.8 SOL | 15 |
| Eio1qitH | slow scan (2 coins) | 34 | 4136 s | 27 | -33.7 % | 92.6 % | 15 % | -51.5 … -19.6 | -32.7 % (16) | -2.3 SOL | 3 |
| 3uojoDz6 | slow scan (2 coins) | 324+ | 2656 s | 38 | -32.9 % | -31.6 % | 18 % | -67.2 … -23.3 | -30.5 % (17) | -19.3 SOL | 10 |
| 6kQts6bF | slow scan (2 coins) | 24 | 871 s | 20 | -19.2 % | -26.3 % | 30 % | -89 … -3.6 | -89.2 % (5) | -1.6 SOL | 3 |

Read but not priced (54):

- 31 were faster than the rule or busier than 400 trips: Eb3ZjJ2o (median hold 23 s, 1192 trips); 3byvsa7Y (median hold 4377 s, 1054 trips); FkmdS2zQ (median hold 95 s, 1090 trips); Dk9vfrCw (median hold 4371 s, 865 trips); GkZbaqoF (median hold 4437 s, 616 trips); 3AoQmpHa (median hold 4501 s, 1043 trips); 3K7XMbqv (median hold 297 s, 1383 trips); Aud2Dfp4 (median hold 4199 s, 1289 trips); Go8dMup1 (median hold 3570 s, 431 trips); 4MPfjjYm (median hold 15186 s, 673 trips); 7PHcywr9 (median hold 46 s, 944 trips); E6sa493z (median hold 240 s, 991 trips); 498SWfPJ (median hold 305 s, 440 trips); 6Qt8a3Y6 (median hold 301 s, 804 trips); kEFiAX3j (median hold 55 s, 1370 trips); Guy19bLQ (median hold 2978 s, 1163 trips); 7BNaxx6K (median hold 454 s, 594 trips); 7Js5gmq5 (median hold 272 s, 964 trips); CdeT4gc7 (median hold 4263 s, 1112 trips); 93mHHYnW (median hold 4260 s, 1099 trips); 4ETcnpXZ (median hold 4250 s, 879 trips); F4cUjuWk (median hold 113 s, 1445 trips); GQF2GsnY (median hold 113 s, 1122 trips); 99pSD2T5 (median hold 48 s, 528 trips); 3XZefEdB (median hold 795 s, 1454 trips); 4vgKuikt (median hold 63 s, 404 trips); 8BKWiAym (median hold 3570 s, 401 trips); DTMAARNm (median hold 3067 s, 685 trips); B2pxhqmA (median hold 14706 s, 498 trips); BVdBJZLx (median hold 3342 s, 668 trips); DM2uKaqe (median hold 1170 s, 595 trips)
- 23 had too few trips in the week, or none the chain could price: 9nXDunV8 (12 trips, 2 priced); 5BABZtHS (7 trips, 6 priced); 2DCbA4Z1 (4 trips, 2 priced); G9qMaCNr (190 trips, 3 priced); 3ZfvcUSN (102 trips, 7 priced); 4JFVYJGZ (0 trips, 0 priced); MriyaNN8 (1 trips, 0 priced); Em8J3gBW (0 trips, 0 priced); 7JCe3GHw (0 trips, 0 priced); DaEVnhsn (0 trips, 0 priced); C39ohmu1 (0 trips, 0 priced); 23jptmsq (0 trips, 0 priced); DAqCpTpQ (0 trips, 0 priced); 58aRapHf (0 trips, 0 priced); ChVbuY6z (0 trips, 0 priced); E8stNkrZ (0 trips, 0 priced); CyaE1Vxv (0 trips, 0 priced); Aqytbp8o (0 trips, 0 priced); Gf1RfYoE (0 trips, 0 priced); 5NMNn5pG (0 trips, 0 priced); 8ysRQfr5 (267 trips, 1 priced); FfLL5VZ2 (0 trips, 0 priced); CpUmEpLd (0 trips, 0 priced)

### Pass 2: the eight least-bad, 120 random copies each, every rule the app applies

"Final sell": the copy sells after the leader’s last sell. "App rules": the copy sells at the leader’s first sell of half or more of the position and at most three copies are open at once. Births read for every priced coin (sniper: bought within 5 slots of the coin’s first trade; bundle: inside the launch transaction or the four after it).

| Wallet | Week trips | Hold | Median trade | Priced | Final sell median / mean / win | App rules median / mean / win | CI (app rules) | Unseen days mean | Days negative | Snipes | Bundle | Own PnL |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 7FPqg7Mp | 3790+ | 196 s | 0.243 SOL | 108 | -3.7 / -12.4 / 41 % | -3.3 / -10.8 / 41 % (70) | -5.8 … 1.7 | -23 % (20) | 5/5 | 5/107 | 0 | -2.6 SOL |
| HL9rRBGS | 1434 | 91 s | 0.012 SOL | 118 | -7.8 / -8.3 / 35 % | -7.3 / -7.8 / 36 % (112) | -10 … -3 | -7.3 % (65) | 5/6 | 24/116 | 0 | 2.3 SOL |
| NUTN33YP | 997+ | 63 s | 1.044 SOL | 111 | -10 / -10.2 / 24 % | -10 / -16.6 / 5 % (20) | -14.9 … -6.7 | -16.6 % (20) | 2/2 | 0/111 | 0 | 20.4 SOL |
| 72NWWbch | 3932+ | 23 s | 0.564 SOL | 116 | -7.1 / -7.5 / 30 % | -7.1 / -7.5 / 30 % (116) | -11.5 … -5.2 | -7.3 % (54) | 6/6 | 0/115 | 0 | 4.4 SOL |
| 34VJYaeq | 3944+ | 79 s | 0.204 SOL | 119 | -10.1 / -9.2 / 24 % | -10.9 / -9.4 / 22 % (105) | -15.8 … -8.3 | -10.4 % (52) | 7/7 | 20/118 | 0 | 6.3 SOL |
| E6rUq5Bt | 1498 | 13 s | 0.302 SOL | 113 | -8.2 / -6.5 / 23 % | -8.2 / -6.5 / 23 % (113) | -9.6 … -6.7 | -4.8 % (51) | 7/7 | 0/108 | 0 | 4.8 SOL |
| 8ZwGubL4 | 223 | 58 s | 0.017 SOL | 77 | -0.9 / -7.2 / 48 % | -1 / -7.4 / 47 % (76) | -14.1 … 3.9 | -8 % (61) | 2/2 | 0/75 | 0 | -0.6 SOL |
| 6CT7cjJu | 62 | 38 s | 0.103 SOL | 60 | -3.2 / 19.2 / 48 % | -3.2 / 19.2 / 48 % (60) | -26.3 … 30.7 | 30.5 % (25) | 0/2 | 30/60 | 30 | 0 SOL |

Helius credits spent by the passes: 211,380 in all (passes 1, 1b, 2, 2b, 3, 4 and the two coin scans).
