# Adversarial patterns that make Solana memecoin wallets look copyable, and how to detect them (as of 2026-10-25)

Scope: pump.fun curve, PumpSwap, Raydium, Meteora. Labels used on every bullet: **[measured]** = the source counted it on-chain or in a dataset and states the method; **[asserted]** = stated without a method or sample; **[vendor]** = a company or tool describing its own product; **[press]** = a secondary write-up of someone else's work. "No precision/recall reported" is stated wherever it applies, because almost no detector in this space publishes one.

Already established internally and not re-argued here: the 40-trades-per-minute bot rule, crowd convergence hurting followers, Scout survivorship bias, the luck-dominated pump.fun PnL board, and the existing Creator/dev, Long holder, Large size, Bot, Sniper, Bundle chips. The CCS'26 "Meme Coin Factories" WT1/DP1/funder-cluster results and the Bitquery 6.85M-sandwich figure are already in `docs/best-copy-trader-research-2026-10-21.md` §6; they are restated below only where the exact definition or a new number matters.

---

## Q1. How are pump.fun launches bundled, and how can a wallet's bundle participation be detected after the fact?

### Takeaway
A bundle is detectable after the fact from block position alone: Bitquery validated against the public Jito record that 185 of 186 buys landing in the four transactions immediately after the create transaction were in the creator's bundle, and none of 139 later ones were. The practical test for a scout is "creation slot, transaction index within 4 of the create, or same transaction, or fee paid by the creator"; funding-graph links add almost nothing on top (0.4% more launches) because bundle wallets are funded by the dev and already sit next to the create.

### Cited Findings

**Mechanics**
- A Jito bundle holds at most five transactions; dev bundles pack the create plus up to four buys, and larger operations "chain multiple bundles into the same slot or stuff several buys into one transaction" **[vendor/press]** — [Bitquery, Oct 2026](https://bitquery.io/investigations/pump-fun-snipers-bundles); [Raiden bundle-checker guide](https://terminal.raiden.wtf/blog/pump-fun-bundle-checker)
- Bundler products are sold openly ("Create + Bundle Buy", "Jito Bundle First Buy & Multiple Instructions"), so this is commodity tooling, not an exploit **[vendor]** — [j.tools](https://j.tools/en/tools/pumpfun-create-and-bundle-buy); [Alphecca bundler guide](https://alphecca.io/en/blog/pump-fun-bundler)
- On launches with creation records (Nov 2025–early Jul 2026), the payer of the first purchase was the creator 98% of the time **[measured]** — [Bitquery](https://bitquery.io/investigations/pump-fun-snipers-bundles)

**Scale (Bitquery, 8,212,568 launches, 30 Oct 2025–7 Oct 2026) [measured]** — [Bitquery](https://bitquery.io/investigations/pump-fun-snipers-bundles)
- Someone other than the dev bought in block 0 on 38% of coins, within the first three blocks on 50%. Dev's own wallets were in block 0 on 21%, sniper bots on 28%, both on 12%, unlinked early buyers on 2%.
- On bundled launches the dev's wallets bought a median 10% of supply in the first blocks; on 2% they took more than half.
- Devs plus bundled wallets made at least $579M after fees on sold tokens ($529M counting unsold as worthless); they were ahead together on 71% of bundled launches; the best 1% of bundled launches produced 65% of total profit.
- Bundled wallets' purchases rose from $56.4M in June 2026 to $1.2B in September 2026; 61% of September's came from single purchases of 1,000 SOL or more.
- The dev's first sale came within a minute on 65% of launches and within a day on 90%.
- Wallets that paid for the first purchase of 100 or more coins accounted for 49% of launches (serial deployers).
- WWW'26 paper, different sample (6,000 projects): "Bundle bots appear in roughly one quarter of projects" where bundle bot = a non-creator wallet buying in the token's creation block **[measured]** — [arXiv 2601.08641v3](https://arxiv.org/html/2601.08641v3)
- MemeTrans (41,470 graduated coins, Dec 2024–Mar 2025): 36.5% of supply held by bundled accounts, where bundles are built from three identifiers: "a transaction ID, a funder address, or a Jito bundle ID" **[measured]** — [arXiv 2602.13480v1](https://arxiv.org/html/2602.13480v1)

**Detection heuristics and their validation**
- Bitquery's bundle test: a block-0 buyer is a dev wallet "if it bought inside the dev's launch transaction, if the dev paid its fee, or if its purchase came in the four transactions after the launch." Validation: 325 random early purchases checked against the public Jito bundle explorer; "Of the 186 in those four positions, 185 were in the launch's bundle. None of the 139 further down were." **[measured; this is the only validated bundle heuristic found]** — [Bitquery](https://bitquery.io/investigations/pump-fun-snipers-bundles)
- Position separates bundles from snipers: 90% of purchases by wallets that bought from fewer than 10 devs sat in positions 1–4; 69% of purchases by wallets that bought from 10 or more devs came 21 or more transactions later **[measured]** — same
- Funding test not worth running for bundles: SOL links between buyer and dev in the prior day "would have added 0.4% to bundled launches in the first three months, so the authors left it out" **[measured]** — same
- Not every launch goes through Jito: "Some launches, most of the ones we sampled on 15 April, did not go through Jito at all" — the position test still works because it does not need the bundle record **[measured]** — same
- Open-source checker `opsec-bot/pump-bundle-check` weights: created the token 1.0; bought inside the creation transaction 0.9; first SOL came from the creator 0.9; same Jito bundle as the creation 0.8; shared a transaction with other buying wallets 0.7; first SOL from the same address as other launch buyers up to 0.9; bought in the creation slot 0.3 ("snipers do too, so never enough alone"); wallet first appeared under an hour before buying 0.2. Score = 1 − Π(1 − w); insider at ≥ 0.5; verdict by insider supply share: < 5% low, < 20% medium, ≥ 20% high. Needs only an RPC (`--rpc`), default window 10 slots, `--max-signatures` 3000. No accuracy stated. **[vendor/open source, asserted weights]** — [GitHub opsec-bot/pump-bundle-check](https://github.com/opsec-bot/pump-bundle-check)
- Its stated blind spots: router buys where the buyer signs nothing are not seen; "Insiders who fund each wallet from a separate exchange withdrawal and wait a few slots mostly appear only as fresh wallets"; tokens with more than `--max-signatures` transactions cannot be traced back to creation — same
- Raiden's definition: independent snipers also land in the creation block, so a bundle is "consecutive block positions from wallets with a common origin"; bundled supply under 5% is "background noise" **[vendor, asserted]** — [Raiden](https://terminal.raiden.wtf/blog/pump-fun-bundle-checker)
- Rugburn's fix for relay-funded bundles: group early buyers by the **funding transaction signature**, not the funder address. In their case, grouping by address gave six groups of one; grouping by transaction gave one group of five. Rule proposed: trigger bundling when five or more buyers trace to one funding transaction; a clean pump.fun launch with five such buyers drops from score 71 to 35 **[measured on one case; rule asserted]** — [Rugburn](https://rugburn.io/blog/funded-before-the-token-existed)
- The WWW'26 Algorithm 1 flags any non-creator wallet buying in the creation block as a bundle bot; the paper admits "gradual bundles" are not reliably detected by this rule **[asserted]** — [arXiv 2601.08641v3](https://arxiv.org/html/2601.08641v3)

**Jito data needed and where to get it after the fact**
- Bitquery used "the public Jito bundle explorer" for validation; the Jito Bundle Explorer is at explorer.jito.wtf **[vendor]** — [Bitquery](https://bitquery.io/investigations/pump-fun-snipers-bundles); [docs.rs jito-bundle](https://docs.rs/jito-bundle)
- A third-party Go client exposes `RetrieveBundleIDfromTransactionSignature` ("returns the bundleID associated with the transaction signature provided, if existing") with slot, tippers, landed tip and transaction signatures **[vendor, unverified against Jito docs]** — [jito-go API](https://beta.pkg.go.dev/github.com/weeaa/jito-go/api)
- `getBundleStatuses` (Helius Sender / Jito JSON-RPC) takes up to 5 bundle IDs, not signatures, and returns null when not found; it is a status check, not a historical index **[vendor]** — [Helius getBundleStatuses](https://www.helius.dev/docs/api-reference/sender/getbundlestatuses.md)
- Bitquery's historical Jito API identifies bundle activity through transfers to the Jito Tip Payment Program's static tip accounts, and positions itself for "historical Jito bundle data older than ~30 days"; the page does not document a bundle-by-wallet or bundle-by-mint filter **[vendor]** — [Bitquery Jito Bundle API](https://docs.bitquery.io/docs/blockchain/Solana/Solana-Jito-Bundle-api/)
- Bitquery's own caveat: "A bundle shows that the purchases were packed together with the dev's signed launch transaction. It does not show who owns the wallets. A launch service that sends bundles for its customers would look the same." **[measured study's stated limit]** — [Bitquery](https://bitquery.io/investigations/pump-fun-snipers-bundles)

### Inferences
- For a scout, the cheapest sufficient test per (wallet, mint) is: fetch the creation slot with `getBlock`, find the create transaction's index, and flag the wallet if its buy is (a) in the same transaction, (b) at index +1..+4, or (c) paid for by the creator. This needs no Jito API and Bitquery's 185/186 validation applies to exactly this rule. A Jito tip transfer in the same transaction is a corroborating signal, not a requirement (April launches skipped Jito).
- The creation-slot-only signal (opsec weight 0.3) is what the existing `Sniper` chip should map to; the +1..+4 position or same-tx signal is what `Bundle` should map to. They are different populations with different profit profiles (Q5).
- A wallet that appears in position 1–4 on launches by two or more different creators is more likely a launch service's or a bundler-for-hire's wallet than the dev's; both are uncopyable because their buy precedes any public print.
- Group-by-funding-transaction (Rugburn) is the one cheap extension that defeats single-use relay wallets; group-by-funder-address does not.

### Gaps
- No public dataset of labelled bundle wallets with precision/recall exists; Bitquery's 325-sample check is the only validation and it was of the position rule against Jito, not of ownership.
- Whether explorer.jito.wtf has a documented public lookup-by-signature API was not confirmed from Jito's own docs.
- How often bundles are now chained across several Jito bundles in one slot (positions 5–9) was not quantified by anyone; Bitquery's rule would miss them and classify them as snipers.

---

## Q2. Wash trading, volume and bump bots on pump.fun: how do they inflate apparent PnL or win rate, and how are they detected?

### Takeaway
Intra-transaction buy-and-sell (WT1) is on 8.26% of coins and 21.4% of pre-migration transactions depending on the sample, and is near-zero false positive because a bonding curve admits no arbitrage; everything looser (same-coin round trips within seconds, same-day near-identical amounts, flip-count scores) is unvalidated and the authors who tried wide windows say the counts explode into false positives. No source reports precision/recall for any wash detector; the WWW'26 paper is the only one with a wallet-level bump-bot rule (flips ÷ net position ≥ 50).

### Cited Findings

**Mechanics and why it inflates a wallet record**
- Bump mode "sends many small buys from rotating wallets"; volume mode "fewer, larger trades"; vendors say pump.fun trending weights transaction count, recency, unique buyer count and total volume, so bots rotate fresh wallets and advertise that they "avoid being clustered together on on-chain analysis tools like bubble-map trackers" **[vendor marketing, not fetched individually; see result set]** — [Jumpbit bump bot](https://jumpbit.io/en/solana/pumpfun-tools/pumpfun-bump-bot); [OpenLiquid volume bot](https://openliquid.io/tools/pump-fun-volume-bot/); [Smithii market maker](https://tools.smithii.io/pump-market-maker/solana)
- Wash trading raises graduation odds: graduation 2.0% for wash-traded coins vs 0.90% for others; logistic regression gives ~19% higher graduation odds per doubling of wash-trading transactions (p ≈ 3×10⁻⁵⁹) **[measured, 1% sample]** — [arXiv 2609.10246v1](https://arxiv.org/html/2609.10246v1)
- Wash ratio rises with coin activity: 0.41% of transactions on coins with 1–10 tx, 21.65% on 1,001–10,000, 50.31% on 10,001+ (n=27) **[measured]** — same
- Attention bots (bump and comment) are "associated with improved performance metrics" of the coin in the WWW'26 sample, so a leader who buys bumped coins looks better than one who does not **[measured, association only]** — [arXiv 2601.08641v3](https://arxiv.org/html/2601.08641v3)
- PnL-tracker inflation path: GMGN's own docs define PnL as realized_profit / total_cost and say transfer rows "are airdrops and internal moves, not trades — exclude them from any ratio" **[vendor]** — [GMGN skills, gmgn-portfolio](https://github.com/GMGNAI/gmgn-skills/blob/main/skills/gmgn-portfolio/SKILL.md). A competitor claims GMGN "does not document any filtering mechanism for transfers, airdrops, dust attacks, or MEV" in PnL and that most tools count a transferred-in token as "buy at zero cost" **[competitor, asserted]** — [Wallet Master vs GMGN](https://www.walletmaster.tools/blog/wallet-master-vs-gmgn/)
- An education site says GMGN "does not detect traders who inflate their stats by buying their own scam tokens" **[asserted]** — [bytwork GMGN playbook](https://bytwork.com/en/companies/gmgn)

**Detectors**
- **WT1 (CCS'26):** an address "buys and sells the same amount CC within a single transaction against the same bonding curve." 2,221,734 transactions on 8.26% of coins, 66,636 SOL (1.32% of volume) in a 1% sample. Authors argue false positives are very rare because "MEV and cross-token arbitrage are not possible inside a bonding curve." No measured FP rate. Data: full transaction-level pump trades (Chainstack, Syndica) **[measured; FP claim asserted]** — [arXiv 2609.10246v1](https://arxiv.org/html/2609.10246v1)
- **WT2 (CCS'26):** same address "buys and sells the same coin amount at approximately the same price within a finite time window" (tolerance = fees). 1-s window: 12.38% of coins; 5-s: 44.05%; 1-day: 88.5% "which the authors read as evidence of false positives." Searched for A→B→sell patterns and "found none." **[measured]** — same
- **MemeTrans wash label:** a transaction whose token flow "involves buy and sell swaps within the single transaction." 6,599,095 of 30,833,503 pre-migration transactions = 21.4%. Data: parsed net balance changes per account per transaction; dataset public **[measured]** — [arXiv 2602.13480v1](https://arxiv.org/html/2602.13480v1); [github.com/git-disl/MemeTrans](https://github.com/git-disl/MemeTrans)
- **Bump-bot wallet rule (WWW'26 Algorithm 3):** count "repetitive flips" = consecutive opposite trades of identical quantity; score = flips ÷ (|net position change| + 1); flag at ≥ 50. Bump bots "occur less frequently than comment bots, likely due to their higher operational cost." No accuracy reported **[asserted rule, applied]** — [arXiv 2601.08641v3](https://arxiv.org/html/2601.08641v3)
- **Multi-chain daily heuristics (Midsummer Meme's Dream, 34,988 coins, 4 chains):** screen = day volume +500% with |price change| < 5% (3,266 candidate days, 379 tokens); then (i) Zero-Risk Position: makers who bought and sold near-identical amounts the same day, 2% tolerance (989 events, 276 tokens); (ii) Circular Volume: "at least 99% of daily trading volume is generated solely by makers who both bought and sold the token on the same day" (223 events, 131 tokens); (iii) Coordinated Manipulator Network: makers present on every detected wash day for a token (42 events, 17 tokens, 178 makers). Combined 1,043 events on 287 tokens, 183 of them Solana. Median volume increase in an event 1,772%; 49.28% of events by a single actor; median first event 85 days after creation. Data: Dune maker-level swaps plus daily OHLCV. No precision/recall; authors say conservative thresholds "likely underestimate manipulation" **[measured]** — [arXiv 2507.01963v2](https://arxiv.org/html/2507.01963v2)
- **Pump-and-dump rule (same paper):** RSI > 80 peak; pump = price +50% and volume +500% within 24 h; dump = −30% after peak with post-dump volume < 50% of pump volume; 91 operations on 60 tokens, 54 on Solana; 61.67% of P&D tokens had earlier wash activity **[measured]** — same
- **MemeTrans post-migration manipulation detector:** TCN on 1-hour, 5-channel series, trained on 1,555 hand-labelled coins (599 manipulated); test AUC 0.9320, accuracy 0.8785, F1 0.8649. Label = "recurring, structured sell-buy cycles" **[measured, the only wash/manipulation detector with a reported score]** — [arXiv 2602.13480v1](https://arxiv.org/html/2602.13480v1)
- **Bot fingerprints (Demystifying Solana Bots, 200 bot addresses, 44M tx, Oct 2025):** HDBSCAN on tx frequency, volume, success rate, fee, asset diversity (silhouette 0.6588). Pump.fun-centric trading cluster: 9.82×10⁻⁴ tx/s (≈85 tx/day), success 0.995, 43% of addresses at 100% success, >80% of tx inside the pump.fun ecosystem, WSOL share 10.9%. MEV clusters: 0.032–1.36 tx/s with 72.7–84.9% of addresses below a 0.2 success rate and 80–100% of SOL transfers going to Jito tip accounts. No classifier metrics; the 200 addresses were Trojan's and SolanaMevBot's top-100 leaderboard wallets **[measured, small labelled set]** — [arXiv 2607.28424v2](https://arxiv.org/html/2607.28424v2)
- **Practitioner thresholds (MadeOnSol):** failure rate > 15–20% yellow, > 40% red; "bot transactions fail about 73.4% of the time versus about 6.22% for human traders" (no sample given); round-trip cycles under 10 minutes across tokens = flag; > 35–40% of volume in one token = suspicious; win rate above 70–80% over 50+ trades "worth scrutinising"; bundler cluster = 5–20 wallets entering the same low-cap in a 30–60 s window **[vendor, asserted]** — [MadeOnSol](https://madeonsol.com/blog/how-to-filter-bot-wallets-kol-list-solana)

### Inferences
- The WT1 test is cheap (one transaction's balance deltas) and defensible; it should exclude a print from the Scout's fill model and mark the wallet, but it cannot catch a cluster that holds price for 2 s with separate wallets, which is the threat the Copy score faces. For that, the Midsummer "Circular Volume" idea (share of a coin's volume during the leader's hold window that comes from wallets that both bought and sold inside the window) is the transferable statistic; it needs every trade on the mint, not only the leader's.
- The failure-rate fingerprint cuts the other way from the 40-tpm rule: MEV bots fail most of their transactions, but the pump.fun trading cluster had near-perfect success. A low failure rate therefore does not clear a wallet of being a bot; a high failure rate strongly suggests one.
- PnL inflation via transfers is a tracker artefact, not a chain fact: the scout's own cost basis must treat tokens received by transfer as unknown cost (and the leader's later sale of them as not a trip), which is what GMGN's own docs recommend and what Bitquery did by excluding transferred tokens.
- A leader whose winners are disproportionately bumped/wash-traded coins has a record that is partly bought attention; measuring the WT1 share of volume on each of the leader's winning mints is a direct test.

### Gaps
- No source gives precision or recall for any wash-trade rule on pump.fun; the only scored detector (MemeTrans TCN) is post-migration and coin-level, not wallet-level.
- No published measurement of how much a bump/volume bot inflates a specific wallet's PnL or win rate; the mechanism is asserted by vendors and competitors only.
- Vendor claims of "invisible on Bubblemaps" were not tested by anyone found.

---

## Q3. Copy-trade farming: leaders who build a record then exit onto followers, or trade their own cluster's coins. Documented cases and detection.

### Takeaway
The pattern now has named, on-chain-traced cases (Bubblemaps on Anglio, Oct 2026: 61% of 534 calls pre-bought by five side wallets 20 s before the post, dumped ~4 min after; 0xEthan, ~$125K), but they are KOL-call front-running, not copy-bot farming specifically; nobody has published a measurement of a leader selling into copier inflow. The detection heuristics with the clearest definitions are "pre-signal frequency, post-call sell rate, early-buyer rank, and precision = share of the wallet's buys that were later called" (moneyleavesclues) and GMGN's callout score "does he sell into the attention his own call created."

### Cited Findings

**Documented cases**
- **Anglio (Bubblemaps, reported 15 Oct 2026):** 534 token recommendations in ~2 weeks (~38/day); in 61%, five side wallets bought "within 20 seconds before his public tweets"; funding for the side wallets "originated directly from Anglio's personal wallet"; after selling, profits went to exchange deposit addresses matching his main wallet; selling began ~4 minutes after each tweet; ~$130,000 cumulative; the public wallet made small follow-up buys "to make the portfolio look legitimate." Bubblemaps' caveat: holding multiple wallets "does not directly constitute evidence of actual control" **[measured by Bubblemaps; press write-up]** — [TechFlow](https://www.techflowpost.com/en-US/article/34592); [KuCoin flash](https://www.kucoin.com/news/flash/kol-anglio-accused-of-using-linked-wallets-to-front-run-token-promotions-gaining-130k)
- **0xEthan (pump.fun KOL, ~88k followers):** Bubblemaps alleged ~$125,000 from buying before public recommendations and "selling through linked secondary accounts" **[press]** — [Phemex](https://phemex.com/news/article/pumpfun-kol-0xethan-allegedly-profits-125k-through-coordinated-pumpanddump-scheme-99368)
- **Kimchi / TRUMP:** Bubblemaps traced linked wallets to ~$6M profit vs a repeated $40M figure and said its trace covers only part of the cluster **[press]** — [news.bitcoin.com](https://news.bitcoin.com/market-updates/kimchi-x-account-hacked-project-kimchi-token-crash)
- **Call-channel economics (770 pump.fun calls, Jan–Mar 2025, 2.4M trade records):** wallet dc5d…6X2K bought before 146 calls with median lead 99.5 s and sold after the same call in 72.6% of cases; o7RY…Wcvc was among the first ten non-creator buyers of 132 called tokens ("looks like a sniper rather than a vip wallet"). With a 30-s entry delay the share of calls reaching +20% fell from 56.4% to 31.4%; median returns at fixed exits were −6.2% (1 min), −10.5% (5 min), −10.7% (10 min); mean at 30 s was +552.2% vs median −4.0%. The authors say this "does not prove that the group intentionally uses public subscribers as exit liquidity" but "demonstrates the economic structure that can produce the same outcome" **[measured, gross returns]** — [moneyleavesclues](https://moneyleavesclues.substack.com/p/inside-the-economics-of-pumpfun-call)
- White Whale Labs (Oct 2026): entries 2 min behind clusters of 450–2,000 wallets lost 41% per token (n=93); clusters with positive records −11%; "no monetizable advantage was found" **[press of an unpublished X thread; already in docs]** — [ChainCatcher](https://www.chaincatcher.com/en/article/2297445)
- The "farmer" pattern (buy large, hold briefly while copiers enter, sell into them) is described by vendors with no named case or count **[vendor, asserted]** — [MadeOnSol](https://madeonsol.com/blog/how-to-filter-bot-wallets-kol-list-solana); [MoonHydra guide](https://moonhydra.com/blog/copy-trading-solana-guide/); [Trojan guide](https://trojan.com/blog/solana-copy-trading-guide-2026)

**Detection heuristics proposed or used**
- moneyleavesclues ranking: how often a wallet anticipated calls; whether it sold after the same call; whether it was among the first ten non-creator buyers; lead time within 10–120 s; and the missing metric they propose: "Of every token purchased by the wallet, how many were subsequently called by the group?" plus a matched control of uncalled tokens and "transaction-level labeling of fee payers to separate shared infrastructure from direct relationships" **[proposed]** — [moneyleavesclues](https://moneyleavesclues.substack.com/p/inside-the-economics-of-pumpfun-call)
- Bubblemaps' linking evidence in the Anglio case was (a) side wallets funded from the known public wallet and (b) proceeds sent to the same exchange deposit addresses; timing was reconstructed "to the second" for all 534 events **[measured method]** — [TechFlow](https://www.techflowpost.com/en-US/article/34592)
- GMGN callout-score skill (16 Oct 2026) scores a caller on "post-call conduct: does he sell into the attention his own call created", from the caller's per-trade ledger (first buy, call time, every later sell) **[vendor; already in docs/swarm-2026-10-23/external.md §4]** — [GMGNAI/gmgn-skills](https://github.com/GMGNAI/gmgn-skills)
- TrenchScanner (open source) added "Possible KOL side wallets: wallet label and bubble map ties" in Oct 2026 **[open source, not fetched]** — [TrenchScanner PR #491](https://github.com/sollama58/TrenchScanner/pull/491)
- WWW'26's "imitation penalty": "the copier necessarily trades at a worse point on the curve"; copier +3% vs smart-money +14% per coin with zero latency **[measured in-model]** — [arXiv 2601.08641v3](https://arxiv.org/html/2601.08641v3)

### Inferences
- The on-chain signature of a copier-farming leader, generalising the Anglio pattern to copy bots: (1) a burst of buys by other wallets within 0.4–5 s after the leader's buy on a large share of its mints (the internal H3 shadow count); (2) the leader's sell timed inside that inflow (minutes, not seconds, in the KOL cases); (3) linked side wallets (shared funder or shared exchange deposit) that buy before the leader's public wallet and sell after. A scout can compute (1) and (2) from the mint's full trade tape; (3) needs the funding graph plus the leader's outbound transfer targets.
- Follower-dependence test (not in any source, but follows from the data above): for each leader win, compute the share of the volume between the leader's buy and sell that came from wallets whose first buy on the mint was within N seconds of the leader's. A leader whose profit concentrates in mints with high "shadow share" is farming, whether intentionally or not.
- Precision as defined by moneyleavesclues (called-later ÷ all buys) transfers directly: for a leader, "share of its buys that attracted ≥ k shadows" is the base rate against which any single mint's shadow count should be judged.

### Gaps
- No published measurement of a leader selling into copy-bot (as opposed to Telegram-call) inflow; the Anglio and 0xEthan cases are KOL posts with 20-s leads.
- No source reports precision/recall for any front-running or farming detector; Bubblemaps has not published a methodology for its insider score ("users cannot independently audit how the weighting is calculated") **[press]** — [CryptoTimes](https://www.cryptotimes.io/2026/09/16/bubblemaps-adds-pre-screened-token-feed-insider-score-in-app-swap-in-platform-overhaul/)
- Whether Kolscan-listed wallets specifically have dumped on copiers was not found.

---

## Q4. Wallet clustering on Solana: funding graph, exchange withdrawals, co-timing, shared signers. Tools, papers, reported precision.

### Takeaway
The only cluster method with a published robustness number is the CCS'26 first-funder graph (1–3 hops, Arkham service labels removed): under adversarial leave-one-address-out the largest component kept a median 80.4% of addresses; at 3 hops the apparent creator count drops ~11×. No Solana clustering paper reports precision against ground truth; Elliptic says Solana has no co-spend heuristic at all. The practical consensus is: first funder (strongest), shared funding transaction (beats single-use relays), shared fee payer / signer (proof-grade), exchange funders excluded unless you also match the deposit side.

### Cited Findings

**Why Solana clustering differs**
- Elliptic: Solana's model "doesn't produce those same signals" as Bitcoin co-spend; "Blockchain analytics solutions can't rely on transaction patterns alone to cluster cryptoasset addresses"; Elliptic maintains "an association table" mapping token accounts to owning main accounts and updates clusters when token-account ownership changes. No accuracy numbers **[vendor]** — [Elliptic](https://www.elliptic.co/insights/solanas-architecture-requires-a-different-approach-to-blockchain-analytics/)
- The 2025 EPJ Data Science Solana network paper only cites clustering in passing; no 2024–2026 academic paper on Solana address-clustering heuristics with precision was found; the account-model clustering literature says UTXO heuristics do not transfer **[academic]** — [Alizadeh & Khabbazian 2025](https://link.springer.com/article/10.1140/epjds/s13688-025-00561-x); [Thürkauf, Decentraland study](https://www.researchgate.net/publication/375122379_Address_Clustering_Heuristics_for_Account-Based_Blockchain_Networks_An_Analysis_Based_on_a_Decentraland_User_Set)

**Funding-graph method with validation (CCS'26, Meme Coin Factories)**
- Funder F(A) = "the first address to send any SOL or any tokens to the creator"; clusters at 1, 2, 3 hops (F, F∘F, F∘F∘F); each node has at most one incoming edge; nodes labelled by Arkham as exchanges, bridges, contracts removed. Data: Chainstack, Syndica, Arkham labels **[measured]** — [arXiv 2609.10246v1](https://arxiv.org/html/2609.10246v1)
- Validation: "adversarial leave-one-address-out"; the largest remaining component retains a median 80.4% of addresses and 89.4% of coin output for the top 1% of clusters **[measured robustness, not precision]** — same
- 5,826,346 creator addresses; 322,620 multi-address clusters at 1 hop; 3,203,502 addresses in multi-address clusters; at 3 hops the creator count drops ~11×; median 1-hop cluster size 3, largest 10,531; multi-address clusters create 62.99% of coins with 48.02% of addresses; top 1% of 3-hop clusters create 58.57% of coins **[measured]** — same
- DP1 (coordinated dump): multiple senders transfer tokens to one dumper that sells everything in a single transaction; 4,402 dumps, median 7 senders; DP2 within 24 h: 88,730 dumps, max 17 senders; "the same senders and dumpers recur across manipulations" **[measured]** — same

**Exchange funding: exclude or use?**
- MemeTrans excludes it: "A notable exception arises when the funder is a centralized exchange ... Such cases are therefore excluded" from bundle clustering **[academic rule]** — [arXiv 2602.13480v1](https://arxiv.org/html/2602.13480v1)
- Bitquery found top sandwich-bot wallets "funded from Bitstamp, Coinbase, and Kraken hot wallets" and that a dev funding bundle wallets from an exchange "would be missed by the SOL-link test" **[measured]** — [Bitquery sandwiches](https://bitquery.io/investigations/solana-sandwich-attacks); [Bitquery bundles](https://bitquery.io/investigations/pump-fun-snipers-bundles)
- Bubblemaps' Anglio link used the deposit side instead: proceeds "sent to exchange deposit addresses that match those linked to Anglio's main wallet" **[measured]** — [TechFlow](https://www.techflowpost.com/en-US/article/34592)
- Ethereum sybil work notes funding signals "become weaker when value flows pass through centralized exchanges, disperser contracts, or other intermediates" **[academic, EVM]** — [arXiv 2607.27370](https://arxiv.org/pdf/2607.27370)

**Relay wallets and the group-by-transaction fix**
- Rugburn case: 22 wallets, 85 mints in 30 days; six buyers funded in one transaction 2 m 41 s before the mint existed; 265 SOL moved through five single-use intermediaries "used once and never again"; across 66 hops the funder-address engine "found almost no shared funders"; grouping by funding **transaction signature** recovered the cluster; later, one funder sent 48 transactions each paying five recipients in 10 slots — "a machine provisioning a buyer population." Rule: exclude shared exchanges, bridges and launchpad programs, since linking through them "manufactures findings out of infrastructure" **[measured, single case]** — [Rugburn](https://rugburn.io/blog/funded-before-the-token-existed)

**Tools**
- **Wallet Sleuth (open source, EVM+Solana):** 14 signals in 5 categories: Control (token-account ownership, shared transaction signer, contract deployment, gas sponsorship: "the only category that can prove a link on its own"); Funding (first funder is the peer, shared first funder, shared funder, batch funding); Flow (direct transfers, shared payout target, cross-chain stablecoin handoff); Coactivity (counterparty-set overlap); Behavioral (activity-hour profile, asset mix: "corroboration only"). Noisy-OR combination, repeated signals decay, "no amount of weak evidence ever reaches certainty"; first-funding signals "withheld entirely unless the sample provably reaches the account's first transaction." Runs on public RPC; Helius key makes it ~10× faster. Labelled services and high-degree counterparties removed before counting. No accuracy numbers **[open source]** — [GitHub nirholas/wallet-sleuth](https://github.com/nirholas/wallet-sleuth)
- **Helius `funded-by`:** returns the sender of "the first SOL transfer to this wallet", timestamp, amount, `funderName`/`funderType` (e.g. exchange) from Helius' identity database; **paid plan only** (Free returns 403); immediate funder only; wallets created by airdrop or program init without a SOL transfer have no data; history exists "only for wallets created after the feature was deployed" **[vendor]** — [Helius docs](https://www.helius.dev/docs/wallet-api/funded-by)
- **Bubblemaps Magic Nodes:** expands the holder map to intermediaries that hold none of the token; funding chains ("If Wallet A sent ... SOL to Wallet B, and Wallet B then bought a token, those wallets are behaviorally linked") and synchronized trading are the stated signals; third parties describe outputs as "probabilistic leads"; no methodology paper for the insider score **[vendor/press]** — [Bubblemaps wiki](https://wiki.bubblemaps.io/bubblemaps-v2/magic-nodes); [Bubblemaps blog](https://blog.bubblemaps.io/what-is-bubblemaps-the-visual-onchain-analytics-tool-explained/); [CryptoTimes](https://www.cryptotimes.io/2026/09/16/bubblemaps-adds-pre-screened-token-feed-insider-score-in-app-swap-in-platform-overhaul/)
- **Co-timing union-find (RED-COHORT, arXiv 2607.02795):** "intra-launch first-buyer-window extraction" then "cross-launch persistent-cohort surfacing via union-find on co-occurrence graphs"; cohorts of 2–12 wallets; code and catalogue CC-BY-4.0; "CORRECTION (Oct 2026): buyer records include sells and miss many buys ... all numerical results below are withdrawn" **[method only]** — [arXiv 2607.02795](https://arxiv.org/abs/2607.02795)
- Sybil-detection practice (EVM, transferable): funding-source clustering is treated as the strongest signal; Connext's post-airdrop review reportedly found ~85% of sybil activity involved wallets connected by transactions **[press, EVM]** — [Sybil Check guide](https://sybil.agoraiq.net/guides/sybil-farming-analyst-guide)

### Inferences
- A scout's minimum viable cluster test, orderable by cost: (1) shared fee payer or shared signer on any transaction (proof-grade, from the leader's own transactions); (2) first inbound SOL transfer's sender and **transaction signature** (one `getSignaturesForAddress` walk to the oldest signature plus one `getTransaction`); (3) shared first funder across the leader and the early buyers of its winning mints; (4) outbound transfer targets shared with other wallets (the Anglio deposit-side link). Exclude any funder labelled exchange/bridge/launchpad; without a label source, treat funders with very high out-degree as infrastructure.
- Helius `funded-by` is paid-only and immediate-funder-only, so it does not replace the RPC walk; the RPC walk is also what makes group-by-funding-transaction possible.
- Precision is unknown for all of these. The honest product wording is "linked" with the specific evidence shown (as Bubblemaps and Wallet Sleuth do), never "same owner."

### Gaps
- No Solana clustering method has a published precision against ground-truth ownership; the 80.4% CCS'26 figure is robustness to deletion, not correctness.
- Arkham/Nansen label coverage and accuracy for Solana memecoin wallets was not found in any public document.
- How far back `getSignaturesForAddress` can walk on busy wallets under public-RPC limits (the Wallet Sleuth "truncated history" problem) was not quantified.

---

## Q5. Sniper and insider detection: features of informed early buyers, and whether they are copyable at a 2-second lag

### Takeaway
Snipers are a different population from bundles and far less profitable: Bitquery's 25,882 sniper wallets (bought in the first blocks of coins from 10+ devs) spent $440M for $31.5M after fees, 54% ahead, versus devs-plus-bundles at $579M+. Deployer-funded snipers exit fast (Pine: 55% fully out in under one minute, 85% within five, 87% profitable) and devs sell within a minute on 65% of launches, so at a 2-s lag a copier buys after the informed seller has started selling; no source claims such wallets are copyable.

### Cited Findings

**Definitions and scale**
- Bitquery sniper = "wallets that bought in the first blocks of coins from 10 or more different devs"; 25,882 wallets; $440M spent; $31.5M profit after fees on sold tokens, $15.2M counting unsold as zero; 54% of sniper wallets ahead on the zero-holdings measure; top 10 wallets $6.7M, top 100 $13.1M; sniper presence fell from 39% of launches (Nov 2025) to 22% (Sep 2026) **[measured]** — [Bitquery](https://bitquery.io/investigations/pump-fun-snipers-bundles)
- Block 0 lands "within about 0.4 seconds of the launch"; unlinked early buyers (neither dev nor sniper) were on only 2% of coins and made $22.7M **[measured]** — same
- Pine Analytics (deployer-funded snipers, Mar–Apr 2025): same-block buy plus "a direct SOL transfer between the deployer and the sniping wallet" (one hop); 15,000+ tokens, 4,600+ sniper wallets, 10,400+ deployers; "~1.75% of launch activity"; separately "over 50% of tokens are now sniped in the exact block they're created"; 87% of snipes profitable; ">55% of snipes are fully exited in under one minute", ~85% within five; >90% of sniper wallets exit in one or two swaps; multi-hop chains "often 5 to 7 hops deep" were not captured **[measured; the 15,000 vs 1.75% figures are not reconciled by the author]** — [Pine Analytics](https://pineanalytics.substack.com/p/exit-liquidity-machines)
- WWW'26 sniper rule: non-creator wallet buying within the first K=5 blocks (~0.4–2 s); "position bots mostly redistribute profit rather than change project performance"; bundle bots "weakly associated with lower returns and shorter dump durations" **[measured association]** — [arXiv 2601.08641v3](https://arxiv.org/html/2601.08641v3)
- 2023–2025 reporting of "internal sniping" at pump.fun issuance described the same deployer-funded pattern **[press]** — [ChainCatcher](https://www.chaincatcher.com/en/article/2185070)

**Features that distinguish informed early buyers**
- Pre-launch funding: buyers funded "2m41s before the mint existed" from one transaction (Rugburn); deployer→sniper direct SOL transfer (Pine); first SOL from creator weight 0.9 (opsec-bot) **[measured cases / asserted weights]** — [Rugburn](https://rugburn.io/blog/funded-before-the-token-existed); [Pine](https://pineanalytics.substack.com/p/exit-liquidity-machines); [opsec-bot](https://github.com/opsec-bot/pump-bundle-check)
- Block position: positions 1–4 = bundle; 21+ = sniper (Bitquery, Q1) **[measured]** — [Bitquery](https://bitquery.io/investigations/pump-fun-snipers-bundles)
- Cross-launch persistence: Bitquery's 10-dev threshold; RED-COHORT's union-find over first-buyer windows surfacing cohorts of 2–12 wallets that "systematically co-fire as early buyers" **[measured / method]** — same; [arXiv 2607.02795](https://arxiv.org/abs/2607.02795)
- Pine's proposed scout features: SOL bought in the first 10 blocks, priority and Jito fees, top-wallet volume share; soft flags "50% of volume in first 10 blocks", "top 3 wallets hold 80% of supply", top wallet exiting under 30 s, early buys from repeat-funded wallets; hard flag for wallets with a history of same-block sniping linked to deployers; trust scores on age, cross-app activity, sell behaviour, hold duration, clustering with known extractors (no thresholds) **[proposed]** — [Pine](https://pineanalytics.substack.com/p/exit-liquidity-machines)
- Infrastructure tell: same-block entry "typically requires pre-signed transactions, off-chain coordination, or shared infrastructure" **[asserted]** — same
- MemeTrans tracks `sniper_hold_pct` and `dev_hold_pct` as holding-concentration features and `early_top10_hold_pct` after bundle clustering **[measured features, formulas not given]** — [arXiv 2602.13480v1](https://arxiv.org/html/2602.13480v1)

### Inferences
- A wallet whose record is built from block-0/early-block buys on many creators' coins is a sniper; its edge is latency and (for the funded subset) information, neither of which survives a 2-s lag: 55% of Pine's snipes were fully exited before a 60-s mark, and the dev sells within a minute on 65% of launches. The copier's expected fill is after the first sell wave. Such wallets should be excluded from recommendation regardless of PnL, which is consistent with the existing `Sniper` chip but argues for making it a hard exclusion rather than a warning.
- Separating sniper from bundle matters for the message, not the verdict: bundles are the dev (uncopyable by construction, often rug exposure); snipers are competitors (uncopyable by speed).
- Share of a wallet's trips that start within 5 slots of the mint's first trade, and the number of distinct creators among those mints, are the two features every source converges on; both are computable from the Scout's trip records plus the mint's creation slot.

### Gaps
- RED-COHORT's numerical lifts are withdrawn; only its method is citable.
- No source measures copier returns on sniper wallets at any lag; the non-copyability conclusion is an inference from exit-speed distributions.
- Pine's two headline figures (15,000 tokens; 1.75% of launches) are unreconciled.

---

## Q6. MEV against copy traders on Solana: sandwiching of copy buys, Jito tip dynamics, leader patterns that make followers systematic victims

### Takeaway
Sandwiching is overwhelmingly a pump.fun phenomenon (96% of Bitquery's 6.85M sandwiches; 62% PumpSwap, 34% curve) and is driven by victims' slippage: Jupiter swaps into pump coins at 20–50% tolerance were sandwiched 148 per 10,000 versus 8 at 1–3%, 14× on the same coins. Copy traders are structurally exposed because they trade predictable, fast, wide-slippage buys in thin pools; `jitodontfront` does not protect them (Axiom set it on 98.5% of its 21.5M sandwiched victim transactions). No study isolates copy-bot victims as a class.

### Cited Findings

**Scale and venue**
- Bitquery (30 Oct 2025–7 Oct 2026): 6,850,144 sandwiches, 2,545 bot wallets, 2,154,994 victim wallets; $29.7M gross (309,010 SOL); daily count from ~3,400 (Nov–Dec 2025) to 51,900 (Sep 2026); 96% hit pump.fun coins; venue split PumpSwap 62%, launch curve 34%, Meteora 3.1%, Raydium 1.0%; median sandwich $2.33; victims' loss 1.3× the bots' take on PumpSwap and 1.2× on the curve; "The count is a floor" **[measured]** — [Bitquery](https://bitquery.io/investigations/solana-sandwich-attacks)
- No Place to Hide (1 Jul 2023–30 Jun 2026, six chains): 28,042,725 Solana sandwiches by 8,631 bots; 88.0% profitable; gross $383.4M, net $345.2M; daily average 25,586, peak 125,169 just before Jito shut its public mempool; 36.0% of Solana sandwiches enclose more than one victim; data covers Raydium, Orca, Meteora and the Pump.fun AMM **[measured]** — [arXiv 2609.28115v1](https://arxiv.org/html/2609.28115v1)
- Helius (Dec 2024–Jan 2025): one program ("Vpe") did "nearly half of all sandwich attacks on Solana": 1.55M sandwiches in 30 days, 65,880 SOL profit, 22,760 SOL in Jito tips, 88.9% success, average 0.0425 SOL per sandwich; "Of the top 20 sandwiched tokens, 16 were created on Pump Fun" **[measured by Jito, reported by Helius]** — [Helius MEV report](https://www.helius.dev/blog/solana-mev-report)
- Jito-linked Accelerate 2025 talk: $370–500M extracted over 16 months **[press]** — [Solana Compass](https://solanacompass.com/learn/accelerate-25/scale-or-die-at-accelerate-2025-the-state-of-solana-mev)

**Detection rules used by the measurers (reusable for an own-fill detector)**
- Bitquery: round trip = a wallet buys and later sells 99–101% of it in the same pool within about three validator turns (~5 s); victim = another wallet trading the same coin, same direction, at least 1% of the bot's buy, at a worse price, not itself round-tripping; bot = ≥100 sandwiches, ≥60% profitable, ≥25% of its swaps; round trips starting in a coin's first 10 slots excluded (sniping). Only 6% of attacks had buy and sell in the same slot; 44% were 1–3 slots apart, 37% 4–7, 13% 8–11 **[measured]** — [Bitquery](https://bitquery.io/investigations/solana-sandwich-attacks)
- No Place to Hide: back leg within two leader rotations (one leader controls four consecutive slots); bot thresholds ≥100 sandwiches, ≥60% profitable, ≥25% density (Appendix C: "every entity we verified by hand clears it with a wide margin"); evasive two-wallet sandwiches linked by a token transfer between front and back wallets, "split legs ... reach around 6% of sandwiches"; "96.2% of unprofitable attacks have a swap in the attacked pool between their legs" **[measured]** — [arXiv 2609.28115v1](https://arxiv.org/html/2609.28115v1)
- Helius' three-trait example: middle transaction has a different signer; token bought in the first two is sold in the third; token is an illiquid pump.fun coin **[illustrative]** — [Helius](https://www.helius.dev/blog/solana-mev-report)
- Bot wallets rotate: "Sandwich bot wallets do not last long ... Bot owners switch wallets often, which makes them hard to block one address at a time"; top 1,000 wallets took 95% **[measured]** — [Bitquery](https://bitquery.io/investigations/solana-sandwich-attacks)

**Slippage and victim behaviour**
- Jupiter swaps into pump.fun coins caught in a sandwich, per 10,000, by slippage band: exact quote 36; <0.5% 27; 0.5–1% 17; 1–3% 8; 3–10% 44; 10–20% 87; 20–50% 148; ≥50% 33. Same-coin comparison: 20–50% hit 14× as often as <3%. Share of Jupiter wallets whose typical swap allowed ≥10%: 21% (Nov 2025) → 36% (first week Oct 2026) **[measured; Jupiter-routed only]** — [Bitquery](https://bitquery.io/investigations/solana-sandwich-attacks)
- "Attackers push the price to the worst level the victim's slippage allows"; memecoin traders "set high slippage to ensure fast execution" and mostly use Telegram bots that "do not enable MEV protection" **[asserted]** — [Helius](https://www.helius.dev/blog/solana-mev-report)
- 39% of Bitquery's take came from bot-wallet victims (other bots, incl. copy and sniper bots) and 61% from other wallets **[measured]** — [Bitquery](https://bitquery.io/investigations/solana-sandwich-attacks)

**Application-level exposure and jitodontfront**
- Victims concentrate by app: Axiom 41.4% of victims in Q2 2025 and above 37% afterwards, excess ratio 13.6–20.9; Photon, GMGN, BullX smaller excess; restricting to single-victim sandwiches "roughly halved Axiom's ratio but left it well above one" **[measured]** — [arXiv 2609.28115v1](https://arxiv.org/html/2609.28115v1)
- `jitodontfront`: a pubkey starting with `jitodontfront` added as a read-only account forces the transaction to index 0 of any bundle containing it **[vendor]** — [Jacob Creech, May 2025](https://x.com/jacobvcreech/status/1920225234906406953); [Solana cookbook](https://solana.com/developers/cookbook/transactions/mev-protection). The guarantee "applies specifically to front-running within the Jito bundle"; Axiom set it on 98.5% of its 21.5M sandwiched victim transactions, and only 16.5% of the 5.02M sandwiches involving flagged victims carried a Jito tip, so the attack went around the bundle; the authors conclude these settings "do not provide end-to-end protection" and that "multi-path submission should therefore be treated as a composition risk" **[measured]** — [arXiv 2609.28115v1](https://arxiv.org/html/2609.28115v1)
- Jito mempool era: the relayer held transactions up to 200 ms where subscribed searchers could see them; after its closure attacks became mostly cross-block; validator delistings (Foundation Jun 2024, Marinade Feb 2025, JitoSOL Oct 2025) weakened the validator-side signal, and the share of attacks in over-represented leaders' slots fell toward 1.01× **[measured]** — same
- Predictability: "Although users may in principle avoid such patterns, doing so consistently is often impractical"; recommendation to avoid disclosure for "trades in tokens with no alternative liquid trading pool" **[authors' view]** — same
- Tip floor measured internally 2026-10-23: landed p50 1.9e-6 SOL, p95 1.0e-4; Helius Sender Max minimum tip 0.001 SOL **[measured; docs/swarm-2026-10-23/external.md §1.4, §2.1]**

### Inferences
- A copy buy is a near-ideal victim: it is large relative to a thin curve (it mirrors a leader who moved the price), it is sent 0.4–2 s after a public print (so bots already know the pool is active), it uses wide slippage (15% default internally; Bitquery's worst band starts at 10%), and 61% of Bitquery's take came from non-bot wallets like it. Leaders whose buys are large relative to curve depth therefore impose a systematic sandwich tax on followers over and above the entry premium; the Scout's "Large size" chip is also a sandwich-exposure chip.
- Since only 6% of sandwiches are same-slot, an own-fill detector that checks only our slot will miss ~94%; it should look ±2 leader rotations (8 slots) for a same-signer (or token-transfer-linked) buy before and sell after on the same pool, which is Bitquery's and the paper's rule.
- `jitodontfront` is worth adding but must not be marketed as protection; the measured evidence is that it did not protect Axiom's users.

### Gaps
- No study isolates copy-trading bots as a victim class or measures the sandwich tax per leader size band; the inference above is from victim-app and slippage-band data.
- Jupiter-routed data only for the slippage bands; pump.fun-direct and PumpSwap-direct slippage distributions are not published.
- Whether pump and PumpSwap instructions tolerate the extra `jitodontfront` read-only account is still untested (internal M2).

---

## Q7. Recycled identities: dormant-then-refunded wallets, airdrop-funded fresh wallets, and telling a new skilled wallet from a laundered one

### Takeaway
This is the thinnest area: no Solana-specific study of dormancy/reactivation or wallet-age thresholds was found. What exists is (a) fresh-wallet behaviour as a weak insider signal (opsec weight 0.2 for "first appeared under an hour before buying"), (b) the observation that sandwich and bump operators rotate wallets constantly and fund them from exchanges or single-use relays, and (c) the Helius/first-funder caveats that airdrop- or program-created wallets have no funding record at all. The defensible scout rule is "a fresh wallet is unrated, not clean."

### Cited Findings
- opsec-bot signal "Wallet first appeared under an hour before buying" weight 0.2, and the blind spot that insiders who "fund each wallet from a separate exchange withdrawal and wait a few slots mostly appear only as fresh wallets" **[vendor]** — [opsec-bot](https://github.com/opsec-bot/pump-bundle-check)
- Bitquery: sandwich "Bot owners switch wallets often"; some top wallets "funded from Bitstamp, Coinbase, and Kraken hot wallets"; a sniper using a new wallet per coin "counts as an unlinked early buyer" **[measured]** — [Bitquery sandwiches](https://bitquery.io/investigations/solana-sandwich-attacks); [Bitquery bundles](https://bitquery.io/investigations/pump-fun-snipers-bundles)
- Rugburn: single-use relays "used once and never again"; a funder that "was a pump.fun token creator that existed for about one day" provisioned 48×5 buyer wallets in 10 slots **[measured case]** — [Rugburn](https://rugburn.io/blog/funded-before-the-token-existed)
- Helius `funded-by`: wallets "created through an airdrop or program initialization without a SOL transfer have no funding data"; only the first SOL transfer is tracked; "reflects the immediate funder, not necessarily the ultimate source" **[vendor]** — [Helius](https://www.helius.dev/docs/wallet-api/funded-by)
- Wallet Sleuth withholds first-funding evidence unless the sample "provably reaches the account's first transaction", because on a truncated history "the earliest transfer visible is an artefact of the budget" **[open source]** — [Wallet Sleuth](https://github.com/nirholas/wallet-sleuth)
- A "fresh" wallet "funded by an address tied to bad launches may only be cosmetic" so the funder's history matters **[vendor, asserted]** — [memeassist](https://memeassist.com/blog/risk-indicators-examples)
- MadeOnSol: a wallet created recently "with already-sophisticated trading is more likely a bot" (qualitative) **[vendor]** — [MadeOnSol](https://madeonsol.com/blog/how-to-filter-bot-wallets-kol-list-solana)
- EVM sybil literature (transferable): scripted wallets "repeat the same sequence at nearly the same times", "thin, uniform histories score poorly"; compression-based behavioural similarity used for open-world sybil discovery on Ethereum **[academic/analyst, EVM]** — [arXiv 2607.27370](https://arxiv.org/pdf/2607.27370); [Sybil Check guide](https://sybil.agoraiq.net/guides/sybil-farming-analyst-guide)
- WWW'26 smart-money filter requires history: trade count above the training set's 25th percentile, return standard deviation below 1, t-statistic above 1.645 — a fresh wallet cannot pass **[academic rule]** — [arXiv 2601.08641v3](https://arxiv.org/html/2601.08641v3)
- GMGN's wallet-score skill discounts dev wallets ×0.45 and has a "feasible" term that falls with trade count **[vendor; already in docs/swarm-2026-10-23/external.md §4]** — [GMGNAI/gmgn-skills](https://github.com/GMGNAI/gmgn-skills)

### Inferences
- Three reproducible checks for a candidate: (1) wallet age at first observed trade and whether the first inbound transfer is reachable (if not, mark "history truncated", as Wallet Sleuth does); (2) the first funder's own profile: a creator, a one-day-old relay, or a high-out-degree disperser means "provisioned"; an exchange hot wallet means "unknown" (per MemeTrans) not "clean"; (3) a dormancy gap followed by a refund and an immediate change in trading style (venue, size, tpm) is a hand-off; it is testable from the signature timeline but no source has validated it.
- For a copy scout the practical defence is the internally planned one: live arming gated on the scout's own observed trips over D days, which no laundering of past identity can shortcut.

### Gaps
- No Solana study of dormant-wallet reactivation, wallet-age thresholds, or airdrop-funded trading wallets was found; everything above is transferred from bundle/sandwich studies or EVM sybil work.
- Whether exchange-funded fresh wallets are over-represented among profitable leaders (which would make the exclusion rule costly) is unmeasured.

---

## Q8. Rug and dead-coin exposure: features of wallets that keep buying tokens that die, creator reputation, and whether a leader's rug rate persists

### Takeaway
Coin-level early rug prediction works moderately (XGBoost AUCPRC 0.80 on fused pump.fun+Raydium data; MemeTrans MLP precision 0.846 / recall 0.833 on high-risk graduates) but transfers badly across venues (pump.fun→Raydium AUCPRC 0.58). Creator reputation as a predictor is contested: one paper finds the top-10 creators' graduation odds beat breakeven on small samples but concludes "conditioning on prolific token creators does not improve predictive performance." No source measures whether a **leader's** rug rate persists; it must be measured on the scout's own trips.

### Cited Findings

**Base rates**
- Solidus Labs (reported): 98.6% of >7M pump.fun tokens (Jan 2024–Mar 2025, ≥5 trades) were rug pulls or pump-and-dumps; ~97,000 kept >$1,000 liquidity **[press of a vendor report; original not fetched]** — [rugpullnews](https://rugpullnews.org/article/135)
- Graduation 0.63% of 655,770 tokens created in Sep 2025 by 243,123 creators **[measured]** — [arXiv 2602.14860v1](https://arxiv.org/html/2602.14860v1)
- Copycat coins (same name, symbol, description, image) graduate at 0.86% vs originals 9.20% **[measured]** — [arXiv 2609.10246v1](https://arxiv.org/html/2609.10246v1)
- Dev's first sale within a minute on 65% of launches; 24% of launches saw only the dev trade in the first three days **[measured]** — [Bitquery](https://bitquery.io/investigations/pump-fun-snipers-bundles)

**Coin-level predictors**
- Catching the Rug (6,304,235 pump.fun + 97,965 Raydium tokens, Nov 2024–Jun 2025): label = "TVL falls below 99% or whose idle time exceeds 80% of its lifetime"; features from the first minutes of trading (count_tx, purchase_percentage, unique_buyers, buy_sell_value_ratio, price_change_first_to_3_blocks, max_price, first_price) plus unlisted "token creator-specific attributes"; XGBoost on fused data predicting pump.fun: AUCPRC 0.8011, F1 0.7885, MCC 0.3947; pump.fun-trained → Raydium: AUCPRC 0.5792 (near-useless); no feature importance reported; the paper says "5 minutes" in one place and "the first hour" in another **[measured]** — [arXiv 2608.20271v1](https://arxiv.org/html/2608.20271v1)
- MemeTrans: high risk = min price within 20 min after migration < 0.3× migration price, or manipulation score ≥ 0.7; MLP on 122 pre-migration features (contextual, holding concentration incl. dev_hold_pct/sniper_hold_pct, market activity, bundle statistics, time series): high-risk precision 0.8459, recall 0.8325, F1 0.8391, AUPRC 0.5729; top-100 picks cut simulated loss 56.1% **[measured]** — [arXiv 2602.13480v1](https://arxiv.org/html/2602.13480v1)
- Mechanism note: on pump.fun "creators cannot directly extract value through liquidity-removal mechanisms such as rug pulls" since the protocol holds liquidity; the exit is selling (often bundled supply) **[academic]** — [arXiv 2602.14860v1](https://arxiv.org/html/2602.14860v1); Flintr describes bundled buys inflating price then a sell-off **[vendor]** — [Flintr](https://www.flintr.io/articles/anatomy-of-a-rug-pull-identify-scams-on-pumpfun)

**Creator reputation**
- Predicting success (Sep 2025): "successful creators" defined by graduation ratio > 0.001 with ≥50 tokens and ≥10 trades per token; "In the case of the top 10 creators, the conditional probability even exceeds the economic breakeven curve", but "the number of eligible tokens created by these highly selective groups of creators is relatively small", and the conclusion states "conditioning on prolific token creators does not improve predictive performance relative to the baseline" **[measured; internally mixed]** — [arXiv 2602.14860v1](https://arxiv.org/html/2602.14860v1)
- Serial creation is the norm: wallets paying for the first purchase of 100+ coins account for 49% of launches (Bitquery); multi-address creator clusters make 62.99% of coins (CCS'26); one wallet minted ~18,000 tokens for ~$3.8M with a 55.57% win rate **[measured / press]** — [Bitquery](https://bitquery.io/investigations/pump-fun-snipers-bundles); [arXiv 2609.10246v1](https://arxiv.org/html/2609.10246v1); [CryptoSlate](https://cryptoslate.com/user-mints-18000-tokens-on-pumpfun-nets-3-8-million-in-profits/)
- A Medium analysis claims twelve Arkham clusters averaged 320 launches each and 82% of liquidity drained Jan–Apr 2025 **[unverified, low confidence]** — [Medium](https://medium.com/@abubakarabdulfattah120/serial-rug-deployers-on-pump-fun-a-deep-dive-into-solanas-meme-coin-laundromat-a57ddda190cc)
- GMGN discounts dev wallets ×0.45 in its copy score **[vendor]** — [GMGNAI/gmgn-skills](https://github.com/GMGNAI/gmgn-skills)

**Leader-level**
- MadeOnSol (1,058 KOL wallets, 1.6M trades): "most buys go to zero and are never sold"; win rates only, no returns **[vendor-ish blog; already in docs]** — [CoinStats re-post](https://coinstats.app/news/07f38ebd47e8d820af3eb96b00c42a84b9b856c602626e3e4a71afbbd79014d6_KOL-Wallet-Tracking-on-Solana-What-the-Data-Actually-Shows-After-16-Million-Trades/)

### Inferences
- A leader's "rug exposure" is best measured as the share of its buys on mints whose creator (or creator cluster at 1 hop) had ≥ N prior launches with no graduation, plus the share of its buys where bundled supply at launch exceeded 20% (opsec "high"). Both are computable from the scout's existing creator link and the Q1 position test; neither has a published validation at the wallet level, so they are descriptive chips until the scout's own held-out trips show whether they predict follower loss.
- The coin-level models' cross-venue failure (AUCPRC 0.58) warns that a rug filter trained on curve data will not transfer to PumpSwap/Raydium trips; venue must be a feature or the model split.
- Because the dev sells within a minute on 65% of launches, a leader who repeatedly buys in the first minute of launches by serial creators is buying the dev's exit; that is the same population as Q5 and should be flagged under creator-link rather than scored.

### Gaps
- No longitudinal study measures whether a flagged creator or a leader with a high past rug rate repeats; the only creator-history test is coin-level and inconclusive.
- Catching the Rug's creator features are referenced but never listed, and no importance ranking exists.
- The Solidus Labs primary report was not fetched; the 98.6% figure is from a secondary.

---

## Q9 (synthesis). Detector catalogue for a scout filter layer: rule, data needed, reported accuracy

### Takeaway
Of 17 detectors catalogued, only four have any published number: Bitquery's bundle-position rule (185/186 validated against Jito), MemeTrans's high-risk model (precision 0.85/recall 0.83) and manipulation TCN (AUC 0.93), and Catching the Rug (AUCPRC 0.80 in-venue). Everything else is a definition with counts but no ground truth. Most detectors need only RPC data the scout already pulls (creation slot block, the leader's signatures, the mint's trade tape, first inbound transfer); Jito bundle data and label databases are corroboration, not prerequisites.

### Cited Findings

| # | Pattern | Rule as published | Data needed | Reported accuracy | Source |
|---|---|---|---|---|---|
| 1 | Dev bundle | Buy in create tx, or fee paid by creator, or tx index +1..+4 after create in creation slot | `getBlock` of creation slot (tx order, fee payers) | 185/186 in Jito bundle; 0/139 beyond pos 4 [measured] | [Bitquery](https://bitquery.io/investigations/pump-fun-snipers-bundles) |
| 2 | Bundle via funder | First SOL from creator (0.9); shared first funder with other launch buyers (≤0.9); score 1−Π(1−w) ≥ 0.5 | First inbound transfer per early buyer (RPC walk) | none | [opsec-bot](https://github.com/opsec-bot/pump-bundle-check) |
| 3 | Relay-funded bundle | ≥5 early buyers trace to one funding **transaction** | First inbound tx signature per buyer | 1 case | [Rugburn](https://rugburn.io/blog/funded-before-the-token-existed) |
| 4 | Sniper | Non-creator buy within first 5 blocks (WWW'26) / first blocks of coins from ≥10 devs (Bitquery) | Mint creation slot + leader trip slots + creator per mint | none; 69% of such buys land ≥21 tx after create [measured] | [arXiv 2601.08641v3](https://arxiv.org/html/2601.08641v3); [Bitquery](https://bitquery.io/investigations/pump-fun-snipers-bundles) |
| 5 | Sniper cohort | Union-find over first-buyer windows across launches; cohorts 2–12 | All early buyers per launch | numbers withdrawn | [arXiv 2607.02795](https://arxiv.org/abs/2607.02795) |
| 6 | Wash WT1 | Same address buys and sells same amount in one tx on one curve | Per-tx balance deltas | "extremely small" FP asserted; 8.26% of coins | [arXiv 2609.10246v1](https://arxiv.org/html/2609.10246v1) |
| 7 | Wash WT2 | Same coin amount, ~same price, within window | Mint trade tape | 1 s → 12.4% coins, 1 d → 88.5% (FP) | same |
| 8 | Bump bot wallet | flips ÷ (|net position|+1) ≥ 50 | Wallet trade list per mint | none | [arXiv 2601.08641v3](https://arxiv.org/html/2601.08641v3) |
| 9 | Circular volume | ≥99% of day volume from makers who bought and sold same day; ±2% size tolerance | Maker-level daily trades | none; 1,043 events / 287 tokens | [arXiv 2507.01963v2](https://arxiv.org/html/2507.01963v2) |
| 10 | Post-migration manipulation | TCN on 1-h 5-channel series | Post-migration minute series | AUC 0.932, F1 0.865 (1,555 labelled) | [arXiv 2602.13480v1](https://arxiv.org/html/2602.13480v1) |
| 11 | Bot fingerprint | HDBSCAN on tx freq, volume, success rate, fee, asset diversity | Wallet tx history incl. failures | silhouette 0.66; no labels | [arXiv 2607.28424v2](https://arxiv.org/html/2607.28424v2) |
| 12 | Call front-runner | Pre-signal buys 10–120 s before call; sells after; first-10 buyer rank; precision = called ÷ all buys | Leader trips + call/attention timestamps | none | [moneyleavesclues](https://moneyleavesclues.substack.com/p/inside-the-economics-of-pumpfun-call) |
| 13 | Side-wallet cluster | Side wallets funded from public wallet; exits to same exchange deposit address; buy 20 s before, sell ~4 min after | Funding graph + outbound transfer targets | 1 case, 534 events | [TechFlow](https://www.techflowpost.com/en-US/article/34592) |
| 14 | Coordinated dump DP1 | Many senders → one dumper that sells all in one tx | Token transfer + sell in same tx | FP "unlikely" asserted; 4,402 dumps | [arXiv 2609.10246v1](https://arxiv.org/html/2609.10246v1) |
| 15 | Creator cluster | First funder, 1–3 hops, service labels removed | First inbound transfer chain + labels | leave-one-out retains 80.4% | same |
| 16 | Sandwich on own fill | Same signer buy before and sell after on same pool within 2 leader rotations (8 slots), 99–101% round trip | Pool tape ±8 slots around fill | only 6% same-slot [measured] | [Bitquery](https://bitquery.io/investigations/solana-sandwich-attacks); [arXiv 2609.28115v1](https://arxiv.org/html/2609.28115v1) |
| 17 | Early rug | Gradient boosting on first-minutes trade features | Mint tape first 5–60 min | AUCPRC 0.80 in-venue, 0.58 cross-venue | [arXiv 2608.20271v1](https://arxiv.org/html/2608.20271v1) |

Supporting data-source facts:
- Helius `funded-by` is paid-plan only, immediate funder only **[vendor]** — [Helius](https://www.helius.dev/docs/wallet-api/funded-by)
- Public RPC per-method limits measured internally: getTransaction 10, getSignaturesForAddress 10 (api.mainnet-beta), publicnode getMultipleAccounts capped at 10 **[measured; docs/swarm-2026-10-23/external.md §2.3]**
- Wallet Sleuth and opsec-bot both run on public RPC alone **[open source]** — [Wallet Sleuth](https://github.com/nirholas/wallet-sleuth); [opsec-bot](https://github.com/opsec-bot/pump-bundle-check)

### Inferences
- Rows 1, 4, 6, 8, 16 are computable from data the scout already touches (creation slot, leader trips, mint tape) and should be the first filter layer. Rows 2, 3, 13, 15 need one extra RPC walk per wallet (to the first inbound transfer) and give the Creator/dev and cluster chips teeth. Rows 9, 10, 17 need the mint's full tape or a trained model and are better as coin-level skip filters than as wallet scores.
- Every row lacks wallet-level ground truth, so the honest product posture is: hard-exclude on the proof-grade signals (same tx as create, creator-paid fee, shared signer/fee payer, WT1), warn on the rest, and let the scout's own held-out follower returns decide which warnings become exclusions.

### Gaps
- No public labelled dataset of adversarial **wallets** (as opposed to coins) exists for pump.fun; MemeTrans and RED-COHORT are the closest and are coin-level or withdrawn.
- No source measures the follower-return cost of any one pattern in isolation; White Whale's cluster-following losses are the only pattern-to-return link and are unpublished.
