# Skeptic's position: is weekly selection of copyable Solana memecoin wallets achievable from a desktop at ~2 s lag? Ceiling, loss decomposition, and a falsification protocol (as of 2026-10-25)

Grading used throughout: **measured** = the team's own replay on its tape or a live probe it ran (file cited); **published** = peer-reviewed or arXiv paper, or a vendor/third-party dataset with stated method; **press** = journalism or a secondary write-up of someone else's data; **asserted** = vendor or advocacy claim with no method; **estimate** = arithmetic or inference made in this note. Internal docs are cited by repo path (read-only; nothing was changed). No API key was used; all web reads were public pages.

Scope note: the brief says to build on `docs/best-copy-trader-research-2026-10-21.md`, `docs/wallet-convergence-2026-09-14.md`, `docs/copy-candidates-2026-10-24.md`, `docs/wallet-finder-research-2026-10-22.md` §4 and `docs/swarm-2026-10-23/external.md`. I also read `docs/swarm-2026-10-23/lag.md` (the pre-registered lag replay) and `docs/swarm-2026-10-23/skeptic.md` (its adversarial re-run), because they contain the only lag-curve and survivorship measurements that exist and the brief's questions cannot be answered without them.

---

## Q1. What is the realistic ceiling for follower return at a desktop lag, from the best public and internal data?

### Takeaway
On every measurement that exists, the ceiling for a 2 s desktop follower on pump.fun curve trades is the **fee floor, not zero**: the best train-selected decile tests at −7.5 to −9.2 % median per copy at 0.1 SOL (floor −7.60 %) and −10.8 to −13.6 % at 0.05 SOL (floor −10.79 %), on three independent day-pairs and 630 decile-lag-model cells, with zero cells ≥ 0. No outside source shows a positive follower return with a non-zero lag and a stated cost model; the one positive published number (+3 %/coin) assumes a zero-latency copier.

### Cited Findings
- **Internal, measured.** "No decile reaches breakeven at any lag on any pair, under any of the three fill models, at 0.05 or 0.1 SOL … 630 decile-lag-model cells per size; 0 have a median ≥ 0 and 0 are credible." Train-selected top decile test median at 0.1 SOL is −7.5 to −9.2 % on every pair and model; a copied round trip with no price move costs −10.79 % at 0.05 SOL and −7.60 % at 0.1 SOL (1.75 %/side, 0.003504 SOL fixed, own impact at 30 SOL depth). — [docs/swarm-2026-10-23/lag.md §1, §4.1](../../docs/swarm-2026-10-23/lag.md)
- **Internal, measured (independent re-run).** The skeptic angle re-ran the 09-16 pair with B=100 and got identical point estimates (STATE-F, 0.4 s, 0.1 SOL: D1 −7.77, all ranked −12.78; at 2 s D1 −8.67); "Every decile median at 0.05 and 0.1 SOL is below 0." The fee-floor arithmetic was verified against `shared/exitBudget.ts:163, 233-246` and `shared/copytrade.ts:966-983`: "These are real live costs on the fast lane, not paper inventions." — [docs/swarm-2026-10-23/skeptic.md §2 L1–L2](../../docs/swarm-2026-10-23/skeptic.md)
- **Internal, measured.** Earlier two-period replay (9.3M curve trades, 07-26→27 and 09-10→11, 1.5 %/side, no fixed fees): best decile is decile 9 at −1.2 %/−1.3 %; "Deleting our fee entirely leaves it negative"; gross follower return of the top decile −2.6 %/−3.3 %. — [docs/wallet-convergence-2026-09-14.md, addendum](../../docs/wallet-convergence-2026-09-14.md)
- **Internal, measured.** Full-week chain-priced re-check of the 12 best Scout wallets (2026-10-24): "no wallet. None of the 12 shortlisted wallets survives a full-week check." The one 30-trip sample that read +0.81 SOL was −9.80 SOL over its 2,027 priced trips; every one of 5 days negative. — [docs/copy-candidates-2026-10-24.md](../../docs/copy-candidates-2026-10-24.md)
- **Internal, measured.** The ranked top decile is no better than a random buy matched on hour, curve band and exact exit schedule (medians −0.9 to +3.3 pts); "the shrunk median works by avoiding wallets that are worse than a random buy, not by finding ones that beat it." The skeptic re-run weakens this to "true for medians only": by 1 %-trimmed mean the top decile beats its random control by 4.4 pts (0.4 s) and 8.3 pts (2 s) on 09-16. — [lag.md §4.2](../../docs/swarm-2026-10-23/lag.md); [skeptic.md §2 L3](../../docs/swarm-2026-10-23/skeptic.md)
- **Published (arXiv, WWW'26).** arXiv 2601.08641 reports "an average copier return of 3% per meme coin investment" under "realistic market frictions" (undefined in the abstract). — [arXiv:2601.08641](https://arxiv.org/abs/2601.08641). The internal external-research angle read the paper and found the copier is "modelled by Lemma 1 as trading immediately after the leader at the post-leader reserve: zero latency … Fee treatment unclear, no slippage value"; ablations without the wallet or coin agent give copier gross 0.933 and 0.942 (negative). — [docs/swarm-2026-10-23/external.md §5](../../docs/swarm-2026-10-23/external.md)
- **Press (secondary report of an X thread).** White Whale Labs, "The Audit Of The Memecoin Casino" (2026-10-20; >1M pools, 7.7M wallets, 384M swaps since late Aug 2026): backtesting a single wallet lost 20 % per transaction; entering 2 minutes after large clusters lost 41 % per coin (n=93, median drop 95 %); following clusters with positive records lost 11 %; "no monetizable edge." Cost and slippage modelling are not described. — [ChainCatcher](https://www.chaincatcher.com/en/article/2297445)
- **Vendor (code, published formula).** GMGN's copy-tradeability backtest subtracts an assumed drift from the leader's own ROI: copy% = wallet% − LATENCY_S·0.015·(0.3 + 0.7·under_100k) − 2·slippage − gas/avg_buy (default 3 s). At 3 s the drift is only 1.35–4.5 points, against the team's measured ~26 % between a signal and the next fillable print. — [external.md §4 (GMGN gmgn-skills repo)](../../docs/swarm-2026-10-23/external.md)

### Inferences
- **Estimate.** The ceiling is bounded above by the fee floor at the follower's size: ≈ −7.6 % per round trip at 0.1 SOL on a fresh curve, ≈ −10.8 % at 0.05 SOL. Size trades fixed fee for impact: at 1 SOL the fixed 0.0035 SOL is 0.35 % but constant-product impact against a 30 SOL virtual reserve is roughly 6–7 % round trip, so the floor is minimised somewhere around 0.1–0.3 SOL on fresh curves and only falls materially in deep PumpSwap pools (where pump's tiered fee also drops from 1.25 % to 1.00 % above ~4,420 SOL mcap, per the vendor fee page cited in external.md §3.3). Even there the floor at 0.1 SOL is ≈ −6.8 % (2 × 1.5 % + 3.5 % fixed), which the price move must beat.
- **Estimate.** Everything a better scout can do is already visible in the gap between "all ranked" (−13 to −16 %) and "top decile" (−7.8 to −9.2 %): about 5–7 pts, which ends exactly at the floor. There is no measured population of wallets whose copies move price in the follower's favour by more than the floor.
- The honest ceiling statement for the product: "the best wallets we can find lose about the fees; everyone else loses more." That is a loss-minimisation ranking, not an edge.

### Gaps
- No tape covers PumpSwap/Raydium-stage leaders, so the ceiling for post-migration copying is unmeasured (see Q5).
- The tape predates 200 ms slots (316.8 ms/slot on 09-16); a 2 s lag today is ≈ 9 slots. Whether finer slots change fills is unknown.
- 2–6.5 % of pump rows were undecodable (V3 instructions), hiding some leader sells; the direction of that bias is unknown.

---

## Q2. What do independent sources report about realised returns of memecoin copy traders as a population? Does any platform publish follower outcomes?

### Takeaway
No copy-trading platform publishes follower outcomes. The only population-level numbers are third-party: 6.16 % of 292,000 Fomo wallets profitable over three months (DWF Ventures, method unpublished); on eToro in 2013, mirrored trades averaged −61 bps against −7 bps for the same users' own trades (peer-reviewed data); and population base rates for memecoin buyers generally are 30–51 % of active pump.fun wallets profitable per month through 2025 (realised, bots unfiltered). Nothing independent shows copiers as a group making money.

### Cited Findings
- **Press (study by a VC, method not published).** DWF Ventures (2026-08-28): of 292,000 wallets on the Fomo social-trading app over three months, **6.16 % finished in profit on realised gains**; 25 wallets earned more than $10,000; "Everyone else lost money." DWF attributes losses to structure: callers profit when followers buy in after them and followers absorb the drop when the caller sells. Fees, unrealised positions and medians are not reported. — [Yellow.com](https://yellow.com/news/fomo-copy-trading-94-percent-wallet-losses)
- **Published (arXiv 2025, eToro data).** 164,634 eToro traders, Apr–Oct 2013; 73 % mirror-traded. Average return per trade: all traders −7.67 ± 0.41 bps; non-mirror traders +1.15 ± 0.94 bps; mirror traders −10.98 ± 0.41 bps; **mirrored trades −61.24 ± 0.98 bps** vs the same users' self-initiated trades −6.88 ± 0.43 bps. Correlation between 30-day performance and popularity 0.11 ± 0.01; mirror choice is driven by popularity (β_pop 15.68 vs β_perf 0.34). Performance is "highly volatile and uncorrelated over time"; its autocorrelation "closely matches the null model." — [arXiv:2507.01817](https://arxiv.org/html/2507.01817)
- **Published (lab experiment).** Apesteguia, Oechssler, Weidenholzer, "Copy Trading," *Management Science* 66(12), 2020: information about others' success increased risk-taking, more so when direct copying was possible; "copy trading leads to excessive risk taking." No return comparison. — [BSE](https://bse.eu/research/publications/copy-trading)
- **Press (Dune data, realised only).** Pump.fun population, Jan 2025: 55,012 of 13.4M wallets (0.4 %) with ≥ $10k realised profit; 294 (0.002 %) ≥ $1M. Excludes post-graduation purchases; bump bots inflate the denominator; pump.fun's co-founder argued the true profitable count is "an order of magnitude LARGER" and that ~30 % of wallets placed a single sell order. — [Decrypt](https://decrypt.co/300403/pump-fun-traders-millionaires)
- **Press (CoinGecko on Dune, realised only, bots unfiltered).** Share of active pump.fun wallets with positive realised PnL per calendar month: 47.6 % (Apr 2024) falling to **30.1 % (Jun 2025)**, 36–45 % through Dec 2025, then 50.1 % (Jan 2026), 56.8 % (Feb), 70.0 % (Mar), 73.3 % (Apr 2026); 2.0–5.3M active wallets per month. In Apr 2026, 65 % of wallets made between $1 and $500. — [CoinGecko Research](https://www.coingecko.com/research/publications/pump-fun-traders-are-making-a-comeback)
- **Press (secondary of Solidus Labs 2025 Rug Pull Report).** 98.6 % of >7M pump.fun tokens launched Jan 2024–Mar 2025 showed pump-and-dump or rug-pull patterns; only ~97,000 kept ≥ $1,000 liquidity; 93 % of ~361–388k Raydium pools showed soft-rug patterns. — [Bitcoin.com](https://news.bitcoin.com/report-exposes-98-6-of-solana-meme-coins-on-pump-fun-as-fraudulent/); [The Defiant](https://thedefiant.io/news/defi/alarming-99-of-memecoin-launches-on-pumpfun-are-pump-and-dumps-or-rug-pulls-report)
- **Press (Chainalysis / Nansen on single tokens).** TRUMP: >77 % of holding wallets had losses or <$100 gains (Jan 2025), later 764,000 losing wallets vs 58 wallets >$10M each. LIBRA: 86 % of traders (>$1k) lost, $251M total. These are buyer base rates, not copier outcomes. — [The Block (Chainalysis)](https://www.theblock.co/post/336584/trump-melania-memecoin-holders); [The Block (Nansen)](https://www.theblock.co/post/342266/traders-of-solana-based-libra-memecoin-lost-251-million-nansen)
- **Vendor (self-published dataset, no return figures).** MadeOnSol tracked 1,069 KOL wallets, 831,012 trades and 1.47M SOL volume in 30 days; typical copy-trade lag "two to fifteen seconds"; "Follower count and trade volume do not correlate." Win rates, PnL distribution and follower outcomes are not reported. — [MadeOnSol](https://madeonsol.com/blog/solana-kol-tracking-methodology-1069-wallets)
- **Press / vendor.** pump.fun bought Kolscan (a KOL PnL leaderboard) on 2025-07-10 and said it would "make the leaderboard reward real traders again," implying the leaderboard had been gamed. — [Blockworks](https://blockworks.co/news/pump-fun-kolscan); [The Block](https://www.theblock.co/post/362119/pump-fun-makes-first-acquisition-purchases-solana-based-copy-trading-wallet-tracker-kolscan)
- **Asserted (advocacy).** A Change.org petition alleges Kolscan's leaderboard lets KOLs "farm" copy traders; no data or named cases. — [Change.org](https://www.change.org/p/ban-kolscan-io)
- **Internal, published survey.** Across 16 products surveyed (GMGN, Bloom, Trojan, Axiom, Fomo, Maestro, …), none publishes a follower-side outcome or a checkable copy latency; all rank leaders by leader PnL. — [docs/best-copy-trader-research-2026-10-21.md §2](../../docs/best-copy-trader-research-2026-10-21.md); [docs/copy-candidates-2026-10-24.md, Competitors](../../docs/copy-candidates-2026-10-24.md)

### Inferences
- The eToro result is the cleanest external analogue: on liquid equities/FX with no bonding-curve impact, copying still turned a roughly break-even population (−7 bps own trades) into a −61 bps-per-mirrored-trade population. The mechanism the paper identifies (popularity, not performance, drives following; performance has no autocorrelation) is the same one the team measured on pump.fun (leader-PnL ranking is worse than random; crowd convergence inverts the signal).
- The 2026 regime matters: the share of profitable pump.fun wallets roughly doubled between Jun 2025 and Apr 2026. A one-week copy result is heavily confounded by regime, which is why the protocol in Q8 needs a same-week random control.

### Gaps
- No platform discloses follower outcomes; DWF's Fomo method (fees? unrealised?) is unpublished and the primary report was not retrieved.
- No Chainalysis or Nansen report on memecoin copy traders as a population was found (only single-token studies).
- The CoinGecko monthly series ends Apr 2026; the regime during the team's Jul and Sep 2026 tapes is not covered by that source.
- The White Whale primary thread was not fetched; its cost model is unspecified.

---

## Q3. Decomposition of the follower's loss: lag, fees, adverse selection, dead coins. Which can a better scout reduce?

### Takeaway
At 0.1 SOL and 2 s on the honest (STATE-F) model the pooled median is −15.6 to −20.4 %; of that, ≈ 7.6 pts is the fee floor (fixed fees 3.5, venue+Krypt 3.5, own impact 0.7), ≈ 1.1–1.6 pts is the increment from 0.4 s to 2 s of lag, ≈ 0.3–0.4 pts is dead-coin accounting on the pooled figure, and the remaining ≈ 7–11 pts is the leader's own impact plus adverse selection and coin bleed over the hold. A scout can only touch the adverse-selection slice (worth 3–7 pts, which is exactly what the shrunk median already captures); fees, impact and lag it cannot.

### Cited Findings
- **Internal, measured.** Fee floor components at 0.1 SOL: (1−0.0175)² → −3.47 %; own impact at 30 SOL depth −0.66 %; fixed 0.003504 SOL → −3.50 %; total −7.63 %. At 0.05 SOL the fixed share doubles to 7.01 % (floor −10.81 %). — [skeptic.md §2 L2](../../docs/swarm-2026-10-23/skeptic.md)
- **Internal, measured.** STATE-F pooled median, 0.1 SOL, 2 s: −20.4 / −18.6 / −20.2 / −18.9 / −16.6 / −15.6 across the six day files. — [lag.md §3](../../docs/swarm-2026-10-23/lag.md)
- **Internal, measured.** Speed increment: STATE-F pooled median is 1.1–1.6 pts better at 0.4 s than at 2 s, 0.4–0.8 pts better at 1 s than at 2 s, on all six files; "No lag comes within 11 pts of zero." — [lag.md §1.3, §3](../../docs/swarm-2026-10-23/lag.md)
- **Internal, measured.** Dead-coin accounting: pricing dead slices at the last print instead of dropping them moves all-ranked by 0.33–0.41 pts and D1–D8 by ≤ 0.9 pts, but D9/D10 by 0.2–11.6 pts. Dead slice share 3.1–4.0 % at 0.4–2 s; leader never closed 7.9–11.9 %; too-fast (leader out before our buy) 6.9–11.3 % at 2 s. — [lag.md §3, §5](../../docs/swarm-2026-10-23/lag.md)
- **Internal, measured.** Mayhem-class coins (2× supply) copied at a median of −107 % at 0.05 SOL: a class where −100 % is possible. — [skeptic.md §0.5, §2 L4](../../docs/swarm-2026-10-23/skeptic.md)
- **Internal, measured.** Hold-matched random control (same hour, curve band, exact exit schedule) at 0.1 SOL STATE-F: −7.8 to −12.0 median; all-ranked wallets are 1–7 pts worse than their control; top decile −0.9 to +3.3 pts vs its control. — [lag.md §4.2](../../docs/swarm-2026-10-23/lag.md)
- **Internal, measured.** "about 26% of price is gone between a leader's print and the next print a follower could fill at" (first print after any signal, tape-audit); the convergence study's honest-fill rule moved one cell from +6.7 % to −15.6 %. — [best-copy-trader-research §4 and Skeptic review](../../docs/best-copy-trader-research-2026-10-21.md); [wallet-convergence §Method notes](../../docs/wallet-convergence-2026-09-14.md)
- **Internal, measured.** Median leader hold is six seconds; mirrored both-leg positions have a median hold of 0.1 min; "the leaders' edge is latency." — [wallet-convergence](../../docs/wallet-convergence-2026-09-14.md)
- **Internal, measured.** Leaders in the "least bad" decile have a median first buy of 0.010–0.034 SOL in September (follower at 0.1 SOL is 3–20× their size) and 14–24 % of their trips are exact no-move round trips. — [lag.md §4.1](../../docs/swarm-2026-10-23/lag.md)
- **Published (Bitquery via CryptoSlate, 2026-10-12).** 6,850,144 sandwiches, 2025-10-30 to 2026-10-07, 2,154,994 wallets affected, $29.7M gross; 96 % of attacks on pump.fun curve or PumpSwap. Victims per 10k Jupiter-routed pump swaps by slippage: 1–3 % → 8; 3–10 % → 44; 10–20 % → 87; **20–50 % → 148**; ≥ 50 % → 33. Mean gross per attack ≈ $4.34 (derived). — [CryptoSlate](https://cryptoslate.com/solana-sandwich-bots-took-29-7-million-before-costs-bitquery-estimates/)
- **Press.** Base rate for the asset: 98.6 % of pump.fun launches pump-and-dump/rug (Solidus Labs). — [The Defiant](https://thedefiant.io/news/defi/alarming-99-of-memecoin-launches-on-pumpfun-are-pump-and-dumps-or-rug-pulls-report)

### Inferences
- **Estimate (decomposition at 0.1 SOL, 2 s, STATE-F, pooled ≈ −18 %):** fees + fixed + impact −7.6 (≈ 42 %); lag increment 0.4→2 s −1.1 to −1.6 (≈ 8 %); dead-coin accounting −0.3 to −0.4 on the pooled median (but 3–4 % of trips are total or near-total losses, and mayhem coins can exceed −100 %); leader impact + adverse selection + coin bleed over the hold ≈ −8 to −11 (≈ 50 %). The random control at −8 to −12 says the coin's own bleed over a six-second-to-minutes hold is 0.4–4 pts beyond the floor; the wallet-specific adverse-selection slice (all-ranked minus control) is 1–7 pts.
- **Which a scout can reduce:** only the 1–7 pt adverse-selection slice, and the shrunk median already captures most of it (top decile ≈ its control). **Which it cannot:** the 7.6 pt floor (needs size or venue change), the lag increment (needs co-location; the free fixes buy 0.4–0.8 pts), and the leader's own impact (structural: a follower always buys after the leader's print).
- Sandwich exposure is a cost the follower controls through slippage, not wallet choice: a 15 % default sits in the 10–20 % band (87 per 10k) versus 8 per 10k at 1–3 %. On 300 copies a week that is ≈ 2.6 vs 0.24 expected sandwiches; at ≈ $4 gross each this is small next to fees, but at 20–50 % slippage it is 148 per 10k.

### Gaps
- Live realised slippage and sandwich rate on the app's own fills are unmeasured (no `copy timing` lines exist; item 8 shipped 10-22 but no live copies since).
- The lag increment is measured on a 316.8 ms/slot tape; on 212 ms slots the same wall-clock lag is more slots, direction of change unknown.
- The split between "leader's own impact" and "adverse selection" is not separately measured; the random control with the leader's exit schedule bundles them.

---

## Q4. The lag curve: follower return at 0.4, 1, 2, 4, 30, 120 s. Is there any lag a desktop can reach where copying works, for any leader class?

### Takeaway
The only measured lag curve (six day files, three pairs) is monotone under the honest model: pooled median −14.5 to −19.1 % at 0.4 s, −15.6 to −20.4 % at 2 s, −16.9 to −24.9 % at 30 s, −17.2 to −32.9 % at 120 s at 0.1 SOL; the top decile moves from −7.8/−8.5 at 0.4 s to −8.2/−9.2 at 2 s. No lag, including 0.4 s (below what a desktop reaches), brings any decile to zero. The apparent "slower is better" in the first-print convention is an artefact of too-fast and no-move trips piling at the fee floor.

### Cited Findings
- **Internal, measured.** STATE-F pooled lag curve (median/trimmed mean) at 0.1 SOL, e.g. 09-11: −17.3/−16.9 (0.4 s), −18.1/−17.5 (1 s), −18.9/−18.2 (2 s), −19.5/−18.9 (4 s), −21.7/−22.0 (30 s), −23.2/−23.8 (120 s); n at 2 s 648,648. — [lag.md §3](../../docs/swarm-2026-10-23/lag.md)
- **Internal, measured.** Best decile (train-selected, tested) at 0.1 SOL STATE-F: July −8.52 (0.4 s) → −9.20 (2 s) → −10.28 (30 s); Sept −7.80 → −8.19 → −8.99; 09-16 −7.77 → −8.67 → −9.50. Zero of 10 deciles ≥ 0 in every cell; 0 credible. — [lag.md §4.1](../../docs/swarm-2026-10-23/lag.md)
- **Internal, measured.** SPEC (first-print) convention shows the median rising to the −7.60 floor at 120 s because 62–68 % of trips become too-fast and 22–28 % exact no-move; "Reading the SPEC median as 'slower is better' would be wrong." — [lag.md §3](../../docs/swarm-2026-10-23/lag.md)
- **Internal, measured.** By hold class: for 10–60 s leader holds the follower median barely moved between a 1 s and an 8 s lag (−14.5 → −13.4); for 0–10 s holds reach collapsed from 82 % to 11 %. "Too fast bites under 10 s, not under 60 s." — [wallet-finder-research §4 Labels](../../docs/wallet-finder-research-2026-10-22.md)
- **Internal, measured.** Earlier 24-cell lag/hold grid (fixed holds, 4.5 % cost floor): lost in all 24 configs including 500 ms; least-bad cell was 2,000 ms at −2.47 % (also the top-25 % selection), so lag was not monotone there. — [best-copy-trader-research, Skeptic review "Latency claims"](../../docs/best-copy-trader-research-2026-10-21.md)
- **Internal, measured (chain).** Slot time 211–216 ms after Alpenglow (2026-10-21); confirmed arrives a median 154 ms after processed; "Same slot: Not reachable from a desktop (vendor: Helius: latency tests must run co-located)". Today's end-to-end desktop path is estimated at 2–4 s, with the probe measuring detect-plus-read at 0.4–0.5 s before build/send/land. — [external.md §1.1](../../docs/swarm-2026-10-23/external.md); [best-copy-trader-research §4](../../docs/best-copy-trader-research-2026-10-21.md); [skeptic.md §2 "Lags below what the app can achieve"](../../docs/swarm-2026-10-23/skeptic.md)
- **Internal, measured.** $49/mo prebuild would buy 0.3–1.1 pts of loss reduction (2 s → 0.6–1.0 s) and "never reaches 0"; pre-registered P2/P3 fail. — [lag.md §7](../../docs/swarm-2026-10-23/lag.md)
- **Press.** White Whale: a 2-minute delay behind clusters lost 41 %/coin (n=93) — the only external lag-specific number found, and only at one lag. — [ChainCatcher](https://www.chaincatcher.com/en/article/2297445)
- **Vendor.** GMGN assumes ≤ 1.5 %/s of drift (3 s default → 1.35–4.5 pts), far flatter than the measured curve. — [external.md §4](../../docs/swarm-2026-10-23/external.md)
- **Published (zero-lag bound).** arXiv 2601.08641's +3 %/coin copier fills at the post-leader reserve with no delay. — [arXiv:2601.08641](https://arxiv.org/abs/2601.08641); [external.md §5](../../docs/swarm-2026-10-23/external.md)

### Inferences
- **Estimate.** Interpolating the measured curve, even an impossible 0 s desktop fill would land the top decile around −7.5 % (the floor) and the population around −14 to −18 %; the published zero-lag +3 % is not reproduced by any print-level replay and sits ≈ 10 pts above the team's 0.4 s top-decile figure.
- No identifiable leader class on the curve tape is positive at any lag. The one class where lag does not bite (10–60 s holds, −14.5 → −13.4 from 1 s to 8 s) is also deeply negative, so being lag-insensitive is not the same as being copyable.
- The lag curve is the strongest single argument against spending on speed: the entire 0.4 → 120 s span moves the top decile by ~2 pts, and the follower's problem is the other ~8 pts.

### Gaps
- No external source gives a follower-return-by-lag curve for memecoins; the only points are White Whale's 2-min (−41 %) and GMGN's assumed drift.
- No tape at 212 ms slots; H8 (low-competition venues) remains unmeasured.
- No live measurement of the app's own slot gap (telemetry shipped 10-22, no live copies since).

---

## Q5. Conditions under which copying has been shown or argued to work: slow leaders, large caps, post-migration pools, specific lags/sizes, low crowding, regime

### Takeaway
Nothing measured or published shows positive follower returns after costs at a desktop lag. The candidates are: (a) slow leaders, which test *worse* at the median and show only an inconsistent positive trimmed mean on 194–452 positions (internal); (b) zero-latency copying (published, unreachable); (c) White Whale's "a few tight groups +10 % on 16 coins" (press, tiny n); (d) low-crowding and PumpSwap/Raydium leaders, which are argued but not measured anywhere. Evidence quality for every "it works when…" condition is weak or absent.

### Cited Findings
- **Internal, measured (slow leaders).** Follower median net by leader hold bucket: <1 m −3.72/−6.22; 1–10 m −5.72/−9.10; 10–60 m −10.94/−15.16; >60 m −17.11/−2.28 (Sept/July), win rates 19 %/44 %; the >60 m bucket's trimmed mean is +9.0/+7.7 on 194/452 positions. "That is two big winners, not an edge, and it is exactly the shape this project has twice mistaken for a signal." — [wallet-convergence, "Slow leaders do not rescue it"](../../docs/wallet-convergence-2026-09-14.md)
- **Internal, measured (labels, H1→H2 on 09-16).** "Long holder (median hold ≥ 5 min)": −14.6 vs −9.7 for others, κ 0.65 → **warn**. "Large size (median first buy ≥ 2 SOL)": −13.6 vs −9.8, thin (120 wallets) → warn. Scalper (<60 s): −9.4 vs −11.7, "possibly an artefact of unmodelled slippage." Bundle buyers −7.3 vs −10.3, confounded with short holds. — [wallet-finder-research §4 Labels](../../docs/wallet-finder-research-2026-10-22.md)
- **Internal, measured (crowding).** Convergence of K top wallets inverts the signal monotonically: K=1 −14.9 % → K=4 −32.1 % at 60 min (Sept; July same shape), 8,016 four-wallet events in a day. — [wallet-convergence](../../docs/wallet-convergence-2026-09-14.md). H3 "crowding is a negative filter" carries a 55–60 % relative prior and ~3 % absolute prior; untested. — [best-copy-trader-research §5](../../docs/best-copy-trader-research-2026-10-21.md)
- **Internal, measured (exits/filters held out).** Only "not in shrunk top 30 %" and "dev sold before our entry" pass the pre-registered hold-out; large size fails (P2 at 0.1 SOL "no", 2 of 3 mean CIs span 0). Fee-aware mirroring (ignore sell slices < 50 %) gains +0.5 to +1.7 pts; "first sell = full exit" +1.6 to +2.5, "all from fees." — [skeptic.md §3 E1, E3](../../docs/swarm-2026-10-23/skeptic.md)
- **Internal, measured (follower-side ranking vs leader PnL).** Top-N by follower-realisable return: −3.42 %/−4.11 % vs −6.52 %/−10.99 % for leader-PnL ranking, win rate +10 pts, both periods. Still negative. — [wallet-convergence addendum](../../docs/wallet-convergence-2026-09-14.md)
- **Press.** White Whale: "A few tight-knit groups: about 10% profit across 16 coins"; clusters of 450–2,000 wallets doubled 28–46 % of their coins vs 10 % base, but copying them 2 min late lost 41 %. — [ChainCatcher](https://www.chaincatcher.com/en/article/2297445)
- **Published (equities analogue).** Barber, Lee, Liu, Odean (JFM 2014, Taiwan 1992–2006): the top 500 day traders ranked in year y earn 37.9 bps/day after fees in year y+1; "less than 1% of the day trader population is able to predictably and reliably earn positive abnormal returns net of fees." — [IDEAS/RePEc](https://ideas.repec.org/a/eee/finmar/v18y2014icp1-24.html)
- **Published (eToro).** "Trading explorers" who frequently revise whom they mirror outperform static keepers (performance-vs-γ slope 2.06 ± 0.28); in simulation, weighting performance over popularity by 10 % more raises platform performance 6.6 %. Even so, mirror trades average −61 bps. — [arXiv:2507.01817](https://arxiv.org/html/2507.01817)
- **Vendor.** PumpSwap fee tiers fall from 1.25 % (0–420 SOL mcap) to 1.00 % (4,420–9,820 SOL), so deeper pools have both lower fee and lower impact. — [external.md §3.3](../../docs/swarm-2026-10-23/external.md)
- **Internal, measured (tape scope).** "The evidence is curve-only: no PumpSwap or other AMM leaders." The 10-24 chain replay now prices PumpSwap legs at executed price (~5 legs/s), so measurement is possible. — [lag.md §7 caveats](../../docs/swarm-2026-10-23/lag.md); [copy-candidates §Pricing](../../docs/copy-candidates-2026-10-24.md)

### Inferences
- The "slow leader" hypothesis is the most tested and it fails: slower holds expose the follower to more coin bleed (random control −59.7 % at 60 min) and the leader's informational edge, if any, is not large enough to cover it. The positive trimmed means are the heavy-tail artefact the team has already caught twice.
- Larger-cap / PumpSwap copying is the only condition with a mechanical reason to be better (fee 1.00–1.25 %, impact ≈ 0, fewer dead coins, longer holds so 2 s matters less) and zero evidence either way. It should be the first thing the Q8 protocol runs on, as a separate pre-registered arm.
- Barber et al. is the right calibration for "skill exists but is rare": the persistent-skill group was <1 % of day traders and was identified with a full year of ranking data, not a week — and even then, no one copied them at a lag.

### Gaps
- No measurement of PumpSwap/Raydium-stage leaders (internal or external).
- No measurement of H3 (crowding count per leader) or H4 (cohort/twin) on held-out data.
- Regime/time-of-week effects on follower return are unmeasured; CoinGecko's series shows the population win rate swinging 30 → 73 % across months, so regime is probably the largest unmeasured covariate.
- White Whale's +10 %/16 coins has no CI, no cost model and no primary text.

---

## Q6. "Every week we have to find a new wallet": feature or sign of noise?

### Takeaway
It is the signature of noise plus selection. Style traits persist strongly (Spearman 0.83–0.98) and follower-return deciles persist in order, but what persists is "least bad near the fee floor," never "positive." Any wallet that reads positive on 8–30 Scout trips is a draw from a heavy right tail; the winner's curse guarantees the top of a 263-wallet list reads +20 to +40 pts above its true value, and regression to the −15.5 % prior is what "needing a new wallet" looks like from the inside. Decile 9 beating decile 10 in three periods is the same phenomenon.

### Cited Findings
- **Internal, measured.** Split-half persistence (H1 vs H2, 09-16): median first-buy size ρ 0.94–0.98; share of trips under 60 s 0.84–0.93; median hold 0.83–0.90; **follower median return 0.48–0.49**; own return % 0.37–0.28 (falls with more trips). "Style is nearly a fixed trait. Outcomes persist only moderately." Split-half reliability of the follower median never reaches 0.7 (0.31 at 3 trips → 0.55 at 40). — [wallet-finder-research §4](../../docs/wallet-finder-research-2026-10-22.md)
- **Internal, measured.** Training-day deciles carry to the test day monotonically in both periods (D1 −57/−61 … D9 −1.3/−1.2, D10 −3.5/−4.2); "Followability is a persistent wallet property, not noise" — but no decile is positive and "Decile 9 beating decile 10 in both periods … the extreme top of the ranking is fitted to the training day." The 09-16 pair makes it three periods. — [wallet-convergence addendum](../../docs/wallet-convergence-2026-09-14.md); [wallet-finder-research §4](../../docs/wallet-finder-research-2026-10-22.md)
- **Internal, measured.** 2026-10-24: 263 eligible Scout wallets, "15 come out above zero, about what luck alone produces in a sample that size"; all 12 re-checked over the full week were negative; the +0.81 SOL / +26.9 % mean 30-trip sample was −9.80 SOL over 2,027 trips; the Scout record also "leans toward its coins that survived." — [copy-candidates](../../docs/copy-candidates-2026-10-24.md)
- **Internal, measured.** 85.0 %/85.1 % of a training day's profitable wallets traded again the next day (persistence of activity, not of profit). — [wallet-convergence](../../docs/wallet-convergence-2026-09-14.md)
- **Published.** On eToro, trader performance "is highly volatile and uncorrelated over time," its autocorrelation "closely matches the null model," while popularity is slow-moving; frequent switchers ("explorers") do better than keepers. — [arXiv:2507.01817](https://arxiv.org/html/2507.01817)
- **Published.** Carhart (1997): persistence in mutual-fund returns is almost entirely momentum and expenses; the only robust persistence is among the worst funds. Choi & Zhao (CFR 2021) find no significant persistence 1994–2018. — [NBER w26707](https://www.nber.org/papers/w26707); [AFA Top 50](https://www.afajof.org/page/Top50Cited)
- **Published.** Barber et al.: the <1 % with persistent skill were identified from a full year of day-trading records. — [IDEAS/RePEc](https://ideas.repec.org/a/eee/finmar/v18y2014icp1-24.html)
- **Published.** Bailey, Borwein, López de Prado, Zhu (Notices AMS, 2014): "The higher the number of configurations tried, the greater is the probability that the backtest is overfit"; "Under memory effects, backtest overfitting leads to negative expected returns out-of-sample, rather than zero performance." — [WMU ScholarWorks](https://scholarworks.wmich.edu/math_pubs/40/). Harvey, Liu, Zhu (RFS 2016): a newly claimed effect should clear t ≈ 3.0, not 2.0, once multiple testing is counted. — [NBER w20592](https://nber.org/papers/w20592)

### Inferences
- **Estimate (winner's curse arithmetic).** With per-copy returns having roughly 1 % of their mass per percentage point near the median (an IQR of ~50 pts, consistent with the 10-24 wallets' 30-trip medians ranging −85 to +1), the SE of a 30-trip median is ≈ 50/√30 ≈ 9 pts and of a 10-trip median ≈ 16 pts. The expected maximum of 263 such estimates is ≈ √(2 ln 263) ≈ 3.3 SE above the mean, i.e. the top wallet reads ≈ +15 to +35 pts above its true value. A true −15.5 % wallet therefore reads around +0 to +20 % on the week it is picked, and ≈ −15 % the next week. "Needing a new wallet each week" is this regression, observed weekly.
- **Estimate.** Under the shrunk median with k=10 and a −15.5 % prior, pure noise predicts roughly 2–10 % of wallets above zero depending on dispersion (≈ 5–25 of 263); the observed 15 (5.7 %) is inside that band, so the list carries no evidence of positive skill. The empirical confirmation is 12 of 12 reverting on the full week.
- Weekly re-selection is the right cadence for a **style/least-bad filter** (styles persist day to day; harmful wallets stay harmful) and the wrong cadence for finding a **positive** wallet (there is no measured positive class to persist). If a positive class existed, the correct cadence would be months with hundreds of trips, as in Barber et al., not weeks with 8–30 trips.
- The internal "decile 9 beats decile 10" in three periods is textbook overfitting of the extreme top; the honest product selection is the shrunk estimate or decile 9, labelled "least bad".

### Gaps
- The Scout record's survivorship bias is identified but not yet quantified at board level (how many points the recorded median overstates the chain median per wallet).
- No measurement yet of how fast a week-W top-10's rank decays over W+1, W+2, W+3 (the direct test of noise vs trait; added to the protocol in Q8).

---

## Q7. Base-rate arithmetic: how many copies and weeks to show a top-N is positive at 95 %? Minimum detectable effect with the tape available

### Takeaway
Using the asymptotic median variance and dispersion consistent with the internal tape, one week of a 10-wallet top-N paper follow (~300 copies) can only detect a true median of ≥ +7 pts; four weeks ≈ 3.6 pts; eight weeks ≈ 2.5 pts. Proving a mean weekly P&L > 0 at the 95 % lower bound needs ≈ 8 weeks if the true mean is +5 %/copy and ≈ 50 weeks if it is +2 %, because the per-copy SD is on the order of 100 pts. The existing 9.3M-trade tape has already resolved deciles to ±0.2–0.6 pts and found none ≥ 0, so the tape is not the constraint; the effect is.

### Cited Findings
- **Published.** Asymptotic variance of the sample median is 1/(4 n f(m)²); for normal data the median's SE is ~25 % larger than the mean's. — [Wikipedia: Median](https://en.wikipedia.org/wiki/Median)
- **Internal, measured (dispersion anchors).** Mint-clustered bootstrap 95 % CIs: July top decile STATE-F 0.4 s, n=78,100, −8.52 [−8.69] (half-width 0.17 pts); 09-16 top decile 2 s −8.67 [−9.22] (half-width 0.55 on ~13k trips); 09-16 H1 pooled n=244,338, −15.26 [−16.08, −14.39]. — [lag.md §3, §4.1](../../docs/swarm-2026-10-23/lag.md)
- **Internal, measured.** 30-trip wallet medians on 10-24 ranged from −85.1 % to +1.0 %, means from −42.6 % to +26.9 %; one wallet's top 10 of 2,027 copies (up to +1,461 %) were worth +6.6 SOL at 0.1 SOL size; without them −16.4 SOL instead of −9.8. — [copy-candidates](../../docs/copy-candidates-2026-10-24.md)
- **Internal, measured.** Shrunk top decile H1→H2: −4.7 [−5.3, −4.2], "CI about 4× tighter than the raw median's" [−8.7, −3.9]. — [wallet-finder-research §4](../../docs/wallet-finder-research-2026-10-22.md)
- **Internal, measured.** Weekly Scout volume: 263 wallets with ≥ 8 copyable trips in a 7-day window; the shortlisted wallets had 97–2,160 trips per week. — [copy-candidates](../../docs/copy-candidates-2026-10-24.md)
- **Internal, pre-registered.** "With 10 deciles × 3 lags × 3 pairs = 90 cells, about 2 one-sided false positives are expected by chance, so a single positive cell is not evidence." — [lag.md §0](../../docs/swarm-2026-10-23/lag.md)
- **Published.** Multiple-testing hurdle t ≈ 3.0 (Harvey, Liu, Zhu). — [NBER w20592](https://nber.org/papers/w20592)

### Inferences (all **estimate**, arithmetic from the anchors above)
- **Median, per copy.** Take f(m) ≈ 0.01 per pt (IQR ≈ 50 pts) for a real wallet's copies (decile pools are tighter because they pile at the fee floor). SE(median) ≈ 50/√n: n=30 → 9.1 pts; 100 → 5.0; 300 → 2.9; 1,000 → 1.6; 4,000 → 0.8. One-sided test of median ≤ 0 at α=0.05 with 80 % power needs n ≈ (124/δ)²: δ=+2 pts → ≈ 3,900 copies; +5 → ≈ 620; +7.5 → ≈ 275; +10 → ≈ 155.
- **Minimum detectable effect per week.** A top-10 at ~30 trips each ≈ 300 copies/week → MDE ≈ 7.2 pts on the median; 4 weeks ≈ 3.6; 8 weeks ≈ 2.5; 12 weeks ≈ 2.1 (independence across weeks assumed; mint/week clustering widens these).
- **Mean weekly P&L.** Per-copy SD ≈ 60–120 pts (from the +1,461 % tail: 10 of 2,027 copies at ≈ +660 % add ≈ 2,150 pts² to a ≈ 40-pt body). At SD=100 and 300 copies/week of 0.1 SOL (30 SOL notional), the weekly P&L SD ≈ 1.7 SOL. Weeks to show mean > 0 at the 95 % lower bound (80 % power): true +2 %/copy (0.6 SOL/wk) ≈ 50 weeks; +5 % (1.5 SOL/wk) ≈ 8 weeks; +10 % ≈ 3 weeks. Because the mean is tail-driven, pre-register a 1 %-trimmed mean alongside it.
- **The tape is not the limiter.** 9.3M trades resolve deciles to ±0.2–0.6 pts; the finding is a point estimate 7.5–9 pts below zero with upper CI bounds below −6.3 on every pair. A new selection rule would need to move the top decile ≈ 8 pts to reach zero, which is more than the entire 0.4 → 120 s lag span or the entire fee floor.
- Multiplicity: if more than one selection rule, size or venue is tried, either Bonferroni across arms or demand t ≈ 3 (99.7 % one-sided) for the headline, per Harvey-Liu-Zhu and Bailey et al.

### Gaps
- The per-copy return density near the median for a real followed wallet (f(m)) is not reported in the internal docs; the 50-pt IQR is inferred from the 10-24 spread. The protocol should publish it from week 1.
- Week-to-week correlation of copy returns (regime) is unmeasured; it inflates the effective number of weeks needed.

---

## Q8. A pre-registered falsification protocol runnable with the existing tape and tools

### Takeaway
Freeze one selection rule on Sunday, paper-follow its top-10 for the next week at 0.1 SOL and the measured slot gap, price every leg from the chain (the 10-24 chain replay, ~5 legs/s), run three comparators in the same week (random eligible wallets, Kolscan/leader-PnL top-10, and the fee-floor line), and judge on a pooled 8-week mint-clustered median with a futility stop at 4 weeks. Add a 0 s-lag ablation on the same trips to separate "latency barrier" from "selection barrier," and a rank-decay track to settle whether weekly re-selection is a trait or noise.

### Cited Findings (tools and precedents the protocol relies on)
- **Internal, measured.** Chain-priced replay: one Helius `getTransactionsForAddress` on the mint with `filters.slot.lte = leader slot + 9`, price after the last trade at or before that slot (pump `TradeEvent` reserves or PumpSwap executed price); 4,320 legs in 14 min; ~10 credits per call; median difference to swap-API pricing 0.0 pts (16 of 26 within 10 pts). — [copy-candidates §Pricing](../../docs/copy-candidates-2026-10-24.md)
- **Internal, measured.** Honest fill model (STATE-F): trade against the curve state after the last print strictly before the due time; skip too-fast trips as the live engine does; price dead slices at the last print (LAST); mirror sell fractions; costs 1.25 % + 0.5 %/side + 0.003504 SOL fixed + own impact. — [lag.md §2.2](../../docs/swarm-2026-10-23/lag.md)
- **Internal, pre-registration precedent.** lag.md §0 set P1–P5 thresholds before computing; exits' PREREG.md was written before its first output (file times) and the skeptic verified it. — [lag.md §0](../../docs/swarm-2026-10-23/lag.md); [skeptic.md §3 E3](../../docs/swarm-2026-10-23/skeptic.md)
- **Internal, code.** Slot telemetry exists: `CopyTiming.leaderSlot/ourSlot/slotGap`; every row stores `leaderPriceSol`; paper model 2 charges both legs. — [best-copy-trader-research, "Built 2026-10-22"](../../docs/best-copy-trader-research-2026-10-21.md)
- **Internal, measured.** Hold-matched random control design (3 random buys per trip, same UTC hour and curve band, copied with the trip's exact exit schedule). — [lag.md §4.2](../../docs/swarm-2026-10-23/lag.md)
- **Press.** Kolscan (pump.fun-owned) is a public leader-PnL leaderboard usable as the "what everyone else copies" comparator. — [Blockworks](https://blockworks.co/news/pump-fun-kolscan)
- **Internal, measured.** Known biases to control: Scout record survivorship (recorded trips skew to survivors); the app's DROP rule compresses the spread; `native/tokens` fill pricing is wrong for multi-trade transactions. — [copy-candidates §Scout bias](../../docs/copy-candidates-2026-10-24.md); [lag.md §5, §6](../../docs/swarm-2026-10-23/lag.md)

### Inferences — the protocol (**estimate**: design, not yet run)
1. **Freeze (Sunday 00:00 UTC, week W).** Write `PREREG-W.md` with a hash before any W+1 data exists. Selection rule: shrunk follower median (k=10, prior −15.5 %), STATE-F fill at the Scout's measured lag, ≥ 10 copyable trips in the trailing 7 days, bot rule (< 40 trades/min), no coin creators. Pick top-10 ("TOP"). Also freeze: **RAND** = 10 wallets drawn at random from the 263-ish eligible set, stratified on trip count and median first-buy size; **LEAD** = top-10 of Kolscan (or GMGN wallet_stats) by 7-day leader PnL; **FLOOR** = −7.60 % at 0.1 SOL, and **NONE** = 0 %.
2. **Follow (week W+1), paper only, never re-ranked.** Size 0.1 SOL per copy; lag = the session's measured slot gap (report its median; if no live telemetry exists use 9 slots ≈ 2 s); mirrored sells with `minLeaderSellPct` 50; max 3 open per wallet; every leg chain-priced with the slot rule; dead and never-closed trips at LAST; too-fast trips recorded as skipped (count them). Do this for TOP, RAND and LEAD identically. Record per copy: wallet, mint, venue (curve/PumpSwap), leader slot, our slot, leader fill, our fill, exit schedule, net return, and whether the Scout had seen the mint.
3. **Primary endpoint.** Pooled median net return per copy of TOP over the pre-registered horizon (8 consecutive weeks), with a mint-clustered bootstrap 95 % CI. **Success**: lower bound > 0 (net, so above the fee floor by construction). **Secondary**: (a) mean and 1 %-trimmed mean weekly P&L in SOL, 95 % lower bound > 0; (b) TOP − RAND difference CI excludes 0 and is positive; (c) TOP − LEAD likewise; (d) win rate vs cost > 50 %.
4. **Sample size and stopping.** ≈ 300 copies/week → 8 weeks ≈ 2,400 copies → MDE ≈ 2.5 pts on the median (Q7). **Futility stop** at 4 weeks if the pooled TOP upper CI bound is < 0. **No early success stop** (optional stopping inflates false positives). If more than one arm or rule is tested, demand the equivalent of t ≈ 3 for the headline or Bonferroni across arms.
5. **Ablation that settles "desktop" vs "selection".** Re-price every TOP trip at 0 slots (the leader's own fill) and at 1, 2, 4 and 9 slots. If 0-slot copying is positive and 9-slot is negative, the barrier is latency and the honest claim is "not achievable from a desktop." If even 0-slot is ≤ 0, the barrier is selection, and co-location would not help either.
6. **Weekly re-selection test (noise vs trait).** Track each week's TOP for W+1, W+2, W+3 and compute Spearman ρ of their shrunk medians against the W ranking. ρ ≥ 0.4 that holds at W+3 = trait (like style metrics); ρ → 0 by W+2 = noise. Also record how many of TOP read > 0 on the Scout vs on the full-week chain replay (the survivorship gap).
7. **Second arm (separate pre-registration): PumpSwap/Raydium-stage leaders.** Same design, eligible set restricted to wallets whose trips are ≥ 80 % post-migration, size 0.1 and 0.5 SOL, since it is the one condition with a mechanical reason to differ and no evidence either way.
8. **What convinces a sceptic.** Eight pre-registered weeks, a hashed rule, chain pricing, a same-week random control, the lag ablation, a published number of rules tried, and a TOP median lower bound > 0 on the pooled sample **and** positive in ≥ 6 of 8 individual weeks. **What settles "not achievable from a desktop"**: pooled TOP upper CI bound < 0 at the measured slot gap while the 0-slot ablation on the same trips is ≥ 0. **What settles "not achievable at all"**: the 0-slot ablation is also < 0 and RAND is statistically indistinguishable from TOP.
9. **Cost.** ≈ 600 credits per 30-trip replay → ≈ 60k credits for 3 arms × 10 wallets × ~100 trips, inside a free 1M Helius budget (vendor limits per external.md §2.1); no funds, no signing.

### Gaps
- Live slot gap has never been recorded on this machine; week 1 must either run a few 0.01 SOL live copies to measure it or state the 9-slot assumption.
- Kolscan/GMGN terms for programmatic reads are unknown; pump.fun Terms §21(h) may restrict the swap-API path (external.md §3.4), so the LEAD arm may need manual weekly snapshots.
- The protocol has not been run; everything in this section is design.

---

## Q9. If the honest answer is "not achievable as framed," which adjacent positions are defensible and evidence-backed?

### Takeaway
The evidence supports four positions and rules out one: (1) a follower-scored board that can recommend nobody and shows the fee floor beside every number (measured: halves the loss vs leader-PnL ranking, still negative); (2) a wallet-vetting/warning tool built on labels with measured stability (κ 0.65–1.0) and measured harm (−4 to −7 pts); (3) a paper-first trainer whose value is the counterfactual record itself (eToro evidence that performance-weighted selection beats popularity; DWF's structural explanation); (4) a post-migration slower-leader arm, defensible only as "measure first." Not defensible: any "profitable copy" claim, speed spend, or convergence/FOMO as a default.

### Cited Findings
- **Internal, measured.** Follower-realisable ranking vs leader PnL: −3.42/−4.11 % vs −6.52/−10.99 %, win rate +10 pts, both periods; "framed as least-bad to follow, never as an edge." — [wallet-convergence addendum](../../docs/wallet-convergence-2026-09-14.md)
- **Internal, measured.** STATE-F ranking beats today's 2 s DROP ranking by 1.3–3.2 pts on every pair; "Show the floor … every follower number should sit next to 'a copy that does nothing loses −10.8 % at 0.05 SOL and −7.6 % at 0.1 SOL'." — [lag.md §4.1, §8](../../docs/swarm-2026-10-23/lag.md)
- **Internal, measured.** Warning labels with stability and harm: creator of a coin today κ 1.00, −16.2 vs −9.5; long holder κ 0.65, −14.6 vs −9.7; large size κ 0.80, −13.6 vs −9.8; bot κ 0.61, −11.1 vs −9.5. Bottom decile by follower median −38.0 vs baseline −9.9. — [wallet-finder-research §4](../../docs/wallet-finder-research-2026-10-22.md)
- **Internal, measured.** Fee-aware mirroring default (+0.5 to +1.7 pts), 30-min wall-clock backstop (+0.1–0.4 under MARK), "chips not skips" for large size and mayhem. — [skeptic.md §8](../../docs/swarm-2026-10-23/skeptic.md)
- **Internal, measured.** Convergence/FOMO as a default is ruled out (−14.9 → −32.1 % as K rises); speed spend ruled out (P2/P3 fail; $49 buys 0.3–1.1 pts). — [wallet-convergence](../../docs/wallet-convergence-2026-09-14.md); [lag.md §7](../../docs/swarm-2026-10-23/lag.md)
- **Published.** eToro: ranking by performance rather than popularity "noticeably improves both individual and collective outcomes" in the authors' model (+6.6 % platform performance for a 10 % reweighting); followers choose on popularity (β 15.68 vs 0.34). — [arXiv:2507.01817](https://arxiv.org/html/2507.01817)
- **Press.** DWF's structural explanation of Fomo losses (callers profit from follower inflow and sell into it) is the mechanism a vetting tool would surface (H3 crowding flag; GMGN's own new "callout score" checks whether a caller "sell[s] into the attention his own call created"). — [Yellow.com](https://yellow.com/news/fomo-copy-trading-94-percent-wallet-losses); [external.md §4](../../docs/swarm-2026-10-23/external.md)
- **Published.** Slippage guidance has hard numbers: 8 victims per 10k at 1–3 % slippage vs 148 at 20–50 %. — [CryptoSlate/Bitquery](https://cryptoslate.com/solana-sandwich-bots-took-29-7-million-before-costs-bitquery-estimates/)
- **Internal, survey.** No competitor publishes follower outcomes or a checkable latency; local custody and paper-first are real differentiators after the TradeWiz drain (20,932 wallets, ~$459k) and the Axiom insider allegation. — [best-copy-trader-research §2](../../docs/best-copy-trader-research-2026-10-21.md); [external.md §4, §6](../../docs/swarm-2026-10-23/external.md)

### Inferences
- The defensible product sentence is: "We show you what *you* would have made copying this wallet, after our fees and yours, and we will tell you when the answer is nobody." That is unique in the surveyed field and fully measured.
- "Loses less than the alternatives" is true (−3.4 % vs −6.5 % vs −59.7 % random 60-min hold) but is not a reason to copy; it is a reason to paper-trade first, which is the position the evidence actually supports.
- The post-migration arm is the only growth hypothesis with a mechanism and no disconfirming data; it should be sold internally as a measurement, not a feature, until Q8's second arm reports.

### Gaps
- No user-outcome data on whether a paper-first/vetting product changes behaviour (eToro's result is a simulation of ranking, not a field test).
- Reddit/user sentiment remains unreadable to the research agents (blocked), so demand for a "most honest copy tool" is unmeasured.
