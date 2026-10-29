# Copy trading against the field (2026-09-21)

The ask: "I really want our whole copy trade system to be the best in the
world — research the competitors and see how to improve", plus "when I run
Scan it works for about two minutes then we get limited."

Three researchers surveyed sixteen products and the feed/landing vendors on
2026-09-21 (web terminals, Telegram bots, wallet-intelligence tools, gRPC and
shred vendors). Every claim below carries its source class — (a) the vendor's
own docs or pricing page, (b) a third-party review, (c) a user post — and a
number that no fetched page states is written as "not published", never
guessed. Raw reports are in the session scratchpad; the digest is here.

## 1. The scan limit, measured

`swap-api.pump.fun` (the Wallet Scout's history source) answers
`x-ratelimit-limit: 1000` per minute and that is NOT the limit that bites.
A Cloudflare rule in front of it (HTTP 429, body `error code: 1015`,
`Retry-After: 34`) blocks the IP for about 35 s, and every request made
during the block extends it. Measured from this machine with the app closed:

| pacing | result |
|---|---|
| 40 calls, no gap | 11 answered, then 429 |
| 60 calls at 100 ms | 12 answered |
| 20 calls at 500 ms | all 20 answered |
| 40 calls at 500 ms | 35 answered, 36th refused |
| 30 calls at 1 s | 22 answered, 23rd refused |
| 40 calls at 2 s | all 40 answered (121 s) |
| 30 calls at 2.5 s / 3 s | all answered |
| recovery after a block | first 200 at +35 s |

The app's `pumpswap` gap was 300 ms. A scan tripped the rule a dozen calls
in, http.ts parked the provider for the `Retry-After`, the slow start halved
the rate for a minute (which happened to fit), then the full rate tripped it
again — "works for two minutes, then limited". Fixed: the gap is 2 s
(`electron/data/http.ts`, pinned in `test/http.test.mjs`), the page says
"one request every 2 s … usually about two minutes", and the pace constant
the page prints is pinned equal to the provider gap (`SOLANA_SCAN_GAP_MS`,
`test/walletscout.test.mjs`).

The PumpSwap builder is a different thing: it builds graduated pump coins'
transactions locally so EXECUTION never asks Jupiter or PumpPortal. The scan
reads HISTORY from pump's HTTP API, which the builder does not touch. The
answer to "history without pump's API" is the chain itself — see §4.

## 2. What the competitors ship

### 2.1 Web terminals

**GMGN** (a, docs.gmgn.ai + gitbook): buy modes fixed / max-follow /
ratio+cap; filters min–max market cap, min–max liquidity, token creation age
("10s" to "1D"), min pool-burnt ratio, min/max copy amount (their size),
min holders, "% of supply per buy", platform (Pump / Raydium), **Skip
Holdings**, **Increase Times** (max adds to one token 0–2). Sells: proportional
follow-sell ("only the tokens bought by the copy trade will be sold"), no
follow-sell, single or ladder TP/SL, **Dev Sell** (auto-sell when the dev
dumps ≥ X %), **Migrated Sell**, trailing stop ("drawdown from peak"). Speed:
"Lightning Mode" ≈ 2 s faster at the cost of "rollbacks and duplicates"; retry
1–3 times, auto-pause after 3 consecutive failures. Ten copy tasks max,
blacklist of 20 tokens. Fee 1 %. Wallet tags: Smart Money, Pump Smart Money,
KOL/VC, Fresh, Sniper, Insider, Bundler, Whale, Dev — method "statistically
demonstrated, profitable track record", thresholds not published. The two
official pages disagree on the recommended priority fee by 10×.

**Axiom**: official copy page unreachable (docs.axiom.trading DNS failed);
third party (b, 2026-09-15) lists SOL or % per copied buy, max per token,
daily cap, slippage, "Secure MEV", a **delay** knob, ticker blacklist, a
copy-sells toggle. Fee 0.95 %→0.75 % with cashback. A reviewer: "doesn't
integrate with relay networks, isn't designed for slot-level trades".

**Photon**: no copy module in its own GitBook; reviews say "not recommended
for copy trading". **Terminal/Padre** (pump.fun's): docs redirect into the
app; third party: per-trade limits, max buys, presets with priority/tip/
slippage/MEV, "Inferno Mode" auto-adjusting fees. **Nova** (a): sizing
Exact / Percentage / Fixed, max buy, market-cap range ($5K–$150K defaults),
min/max buy trigger (their size), Buy Once, Follow Sells, TP/SL per copy,
Practice Mode. **Bloom** (a): Exact / Fixed / Percentage (> 100 % allowed),
min/max mcap, token age in seconds, **Max Dev Holdings %**, first-interaction
only, skip deployer purchases, Buy Tokens Once, max trades per token, deployer
black/whitelist, platform selection, UTC time windows, Follow Sells mirroring
the %, Fixed Sell, **Minimum Threshold** (the % they must sell to trigger),
Sell Only Copied Buys, **Sell on Transfer**, **Reverse Mode**, copy by
pump.fun / fomo.family username. Fee 1 % (0.9 % referred). **Vector**: shut
down (Coinbase acquisition, 2025-12). **Dexcelerate**: copies Telegram
callers/groups by win rate, not wallets; only a 2024 source.

### 2.2 Telegram bots

**Trojan** (a): % of leader's buy or fixed; per-config execution wallet;
priority fee, **bribe**, slippage, MEV toggle; market-cap range, min
liquidity, max spend per buy, exclude launchpads, Prevent Duplicate Buys
(any held token), Only Renounced, Min Buy (their size), blacklist, retries,
Pause All. Copy Sell = same %; or Auto Sell limit orders. Wallet tracker with
typed alerts: First Buy, Buy More, Sell Partial, Sell All, Transfer, Token
Launch; KOL groups. Fee 1 %/0.9 % (b).

**TradeWiz** (a): Buy Percentage, max/min buy, SOL spending limit per leader,
Buy Limit per Token 0–3 with reset-after-sold, leader-size band, min LP,
mcap band, **token age band per platform**, platforms, unrenounced/unburned
inclusion, no duplicate buys, Buy Dip, Anti-PVP pause, Turbo Mode, start/end
time; sells: Copy Sell, proportional, **First Sell Copy Percentage**, Auto
Sell on Transfer, TP/SL/trailing. **Reverse Copy** is a named mode. Claims
"within 1 second and trade in the same block" on one page and "within 0
seconds" on another. Fee 1 %.

**Maestro** (a): Max Buy + Buy % up to 1000 %, mcap/liquidity/tax caps, Smart
Slippage, **Frontrun** (ETH/BSC mempool: your gas vs theirs +5 gwei), **Track
Only** (notify, never trade), Blind Follow; Solana is post-mine detection,
"next block after the copytrade wallet". Fee 1 %; Premium $200/mo lifts the
wallet cap 5→12. **Banana Gun** (a): Buy Exact/Percent/Fixed, Max Buy,
spending limit, Buy Only Once (7-day block), mcap band, Anti-MEV + tip,
time-boxed copy sessions, named presets; Sell Exact/Percentage/Relative;
Base "Flashblock … 200 ms granularity", Solana latency not published.
**BONKbot, Fasol**: no copy trading. **Pepeboost, Sol Trading Bot, Unibot,
Sigma**: fixed/% sizing, proportional copy-sell, buy-once, mcap/liquidity
filters, tax caps; Unibot has an "Emergency mode" full exit when the leader
exits.

### 2.3 Wallet intelligence

Cielo (Pro $59, Whale $199/mo): win rate, profit, volume, trading frequency
in 1d/7d/30d/max; labels High Win Rate (> 75 %), Gem Finder, Human-Operated;
flags hold < 2 min as sniping; ranks by the wallet's own realised PnL.
Kolscan / Solana Tracker: KOL leaderboard by PnL, ROI, win rate; windows
1d–90d; `transaction:kol` datastream. Nansen: Smart Trader labels over
rolling windows with "consistency criteria" (thresholds not published);
credits-based API. Arkham: entity labels and an illicit-exposure score, no
trader metrics. GMGN: "65+ fields" per wallet, all the tags above. RayBot:
free tier 10 Solana wallets / 15 notifications a minute, live PnL,
webhooks. Birdeye: top traders per token by PnL/volume, 2d–90d.

**Nobody publishes a follower-realisable metric.** Every board ranks wallets
by their OWN PnL — which on pump selects for snipers, the wallets least
worth following (docs/wallet-convergence-2026-09-14.md). The only leader-vs-
follower dataset found is a CEX study (b, 2025-11, 100,236 copy outcomes):
97.04 % of leaders had positive personal PnL, **43.61 % delivered positive
follower returns**. That is the number this app's Copy score was built to
measure on-chain, and it remains unique.

### 2.4 Speed and feeds

No terminal or bot publishes a millisecond latency, a transport, or a
same-slot hit rate for copies. The published facts are vendors':

| feed | cheapest tier with an account-filtered stream | price | latency claim |
|---|---|---|---|
| Helius LaserStream gRPC | Business | $499/mo | "~8 ms before processed" |
| Helius Enhanced WS `transactionSubscribe` | Developer | $49/mo | not published |
| Helius webhooks | Free | 1 credit/push | not published; retries duplicate |
| Chainstack Yellowstone gRPC | 2 streams, ≤ 50 accounts | $49/mo | not published |
| Shyft gRPC | Build | $199/mo | not published |
| Triton Dragon's Mouth | prepaid + $0.08/GB | $125+ | "~100 ms" (b) |
| Jito ShredStream | — | **shut down 2026-09-05** | — |
| OrbitFlare / bloXroute shreds | per region | $500–1,000/mo | vendor-only benchmarks |
| public RPC `logsSubscribe` | — | $0 | 100 req/10 s/IP, "not for production" |

Landing is per-transaction tips everywhere (Nozomi, 0slot, Helius Sender
Max ≥ 0.001 SOL; Jito lower). Shred feeds need a co-located box running a
UDP proxy — a desktop app on a home connection cannot consume them. "Same
slot" is described consistently as observe-from-shreds + build-and-send in
< 20 ms from the same region; nobody publishes a hit rate. The realistic
floor from any websocket or gRPC feed is one to a few slots behind the
leader — exactly the lag that turned 97 % profitable leaders into 43.61 %
profitable-for-followers.

## 3. Where this app stood this morning

Already shipped and, in the union of everything surveyed, unique:
paper-first with harsh fills (the price AFTER your delay, 1.5 %/side),
skipped rows on the record, mirrored sells settled in base units from
confirmed fills, the in-flight-buy park, late-entry and late-exit refusal
with clock-skew correction, daily loss / daily trade / per-minute walls (no
competitor publishes any of the three), a wallet per config on three chains,
reverse and FOMO directions, the follower-realisable Copy score, the
too-fast flag, and Copy Simple. Also unique: it says on the form that
copying loses on average.

Missing, against the union (§2): a min market cap; a leader-size band; a
token-age band; buy-once / max entries per token; token and creator
blocklists; a mirror threshold on small trims; a trailing stop; sell on
transfer-out; dev-sell / migration exits; a notify-only direction; time
windows; presets; per-copy fee/tip overrides; wallet labels beyond the
Scout's four flags; and any way to read a pasted wallet that the feed had
never seen.

## 4. Shipped today

1. **Scan pacing** (§1). Two minutes for sixty tokens, and it finishes.
2. **Ten filters** on `CopyConfig` (`shared/copytrade.ts`), all off unless
   set, every refusal recorded as a skip, every unknown fact failing closed:
   `minMarketCapUsd`, `minLeaderSol`/`maxLeaderSol` (their size band),
   `minTokenAgeSec`/`maxTokenAgeSec` (age at THEIR buy, from the feed's
   launch time or the market layer's), `maxBuysPerToken` (1 = buy once;
   in-flight buys count, skips do not), `blockedMints`, `blockedCreators`
   (exact for Solana, case-insensitive for EVM), `minLeaderSellPct` (a trim
   under it is recorded, not mirrored; synthetic exits pass), and
   `exitTrailingPct` (from the peak since entry, armed from entry, on any
   direction, never defaulted). Engine: `prefilter` runs before a slot is
   reserved; the fact-based ones after `tokenFacts`, which now carries
   `createdAt` and `creator`. IPC `copy:save` reads all ten (the contract
   test refuses a field the rebuild forgets). Editor: "More filters" rows on
   the Copy Trading page, token age in minutes, blocklists one address per
   line. Eight new cases in `test/copytrade.test.mjs` (146 total).
3. **Read a wallet from the chain** (`electron/engine/walletHistory.ts`):
   for an address the feed never saw. `getSignaturesForAddress` (200, one
   week), `getTransactions` in batches of ten through rpcClient's per-method
   budget, `decodeWalletSwap` — the copier's own decoder — fed oldest-first
   into `walletScout.note` with the signature as the trade id, so a second
   read and the live feed are duplicates, never double counts. Fills in
   "what they did" (trips, profit, win rate, median hold, too-fast); the
   Copy score stays unmeasured until the feed or a scan brings the coins'
   other prints, and the drawer says so. Scout page: "Look up a wallet"
   opens any address; drawer: "Read from the chain" with live progress and
   a plain-words result. Solana only (the EVM Scouts read whole-chain logs
   by block range). `test/wallethistory.test.mjs`.

## 4b. The Scout's board and its controls (same day, second round)

User: "how can we improve the wallet scanning and wallet scout UI in general,
to really help people find good wallets" and "the wallet scan shit is tiny and
the buttons on left of the wallet list very small … remember retards are the
users." Both halves of that are one problem: the page was built for someone
who already knew what every column meant.

**The board ranked but never filtered.** Sorting cannot remove a three-trade
record, a bot that was out in six seconds, or a wallet whose trips a follower
could never have been inside — only a filter can, and there was none. Five
switches now sit above the table, each one a chip that says what it hides and
why in its tooltip, plus one button that turns on all five:

| switch | hides | threshold |
|---|---|---|
| No bots | holds seconds, trades constantly | `looksAutomated` |
| Enough trades | too small a sample to rank | `MIN_TRIPS_FOR_RANK` (5) |
| You could have copied | a follower was locked out of most trips | reachable < 25 % |
| Holds over a minute | over before a follower could land | `SCOUT_SLOW_ENOUGH_MS` (60 s) |
| Trades most days | traded once and vanished | `SCOUT_REGULAR_DAYS` (3) |

Measured on this machine's own record: **200 wallets → 28** with all five on.

Three rules the filters keep, pinned in `test/walletscout.test.mjs`:

1. **Every switch is off by default.** The board shows what was recorded;
   hiding rows is the user's choice, and the line under the chips always says
   how many were hidden and by what.
2. **An unknown number never hides a wallet.** A record whose reachable share
   or median hold was never measured is not one that failed the test — it is
   one the test could not be run on. Hiding it would claim a fact nobody has.
3. **`SCOUT_SLOW_ENOUGH_MS` equals `COPY_LATENCY_FLOOR_MS`.** One fact, two
   readers: the Scout cannot call a wallet followable while the copy page
   calls the same wallet too fast to follow. Pinned equal across the two
   shared modules.

The board also fetches the handler's ceiling (200) rather than 50, because
hiding rows after ranking a short list is a screen that looks empty while the
record is not; and the empty state now tells the difference between "nothing
recorded" and "your five switches hid everything", with a button to undo it.

**Sizes.** Nothing on the page is under 30 px tall any more, pinned by a live
check in `test/scout.e2e.mjs` that walks the panel and the rows and fails on
anything smaller. What changed: the chain and list buttons (26 px rows → 42 px
with borders), the scan block (now a card with a heading, full-width hour
pills, a 45 px button and — since it runs about two minutes — a progress bar,
indeterminate until a total is known rather than a bar at 100 % that has done
nothing), the lookup field, the record/clear buttons, and the row actions.

**The row actions were the worst of it**: a 12 px icon in a 2 px box, and with
nine columns they sat off screen behind a horizontal scrollbar nobody found.
They are now 34 px, they carry the words Save and Follow, and the column is
**pinned to the right edge** so it stays on screen however far the table
scrolls. Verified against the running app, screenshots in the session
scratchpad.

Not built this round, and still the ranked next step for discovery: the
simulator that replays a wallet's trips through the user's own copy config
(size, delay, the ten filters, TP/SL/trailing/max-hold, daily loss limit) and
draws the curve. It needs the price path between each entry and exit, which
the store does not keep — the local tape supplies it when recording is on, and
pump's swap API a page or two per trip otherwise (about two minutes for forty
trips at the pace §1 now respects). Also not built: the sniper, creator and
fresh-wallet flags, which need new data in the Scout store rather than UI.

## 4c. Shipped 2026-10-28 — roadmap items 2, 3, 4 and 6

Built after the user asked for the missing features by name ("dev sell,
migration, sell on transfer"). Every one is a config field on `CopyConfig`
(`shared/copytrade.ts`), absent = off on every config saved before, carried
by the `copy:save` rebuild (the ipccontract test pins it), set on the
Follow page under Advanced, shown on the Following card's rules, and tested
in `test/copytrade.test.mjs` (the last ten tests).

- **Watch-only direction** (`direction: 'watch'`, item 3). A follow that
  never trades. The wallet is watched like any other, its record builds
  (`trackLeader`), and every trade is told — "First buy: 1.000 SOL of X",
  "Bought more", "Sold 40 % of X for …", "Sold ALL of X", "Moved out: they
  sent it to another wallet" — as an info toast and through the engine's
  notify (desktop, Telegram, Discord), capped at 30 notifications an hour
  on its own counter so a busy wallet cannot spend the failure alerts'
  budget. No copy rows, not even skips. It cannot be live (validation), so
  its card has no paper/live switch. Template "Watch only" under More ways
  to follow.
- **Dev-sell exit** (`exitOnCreatorSellPct`, item 4). The curve feed names
  the creator on every pump trade (`PumpTradeEvent.creator`, else the
  tracked create event). When the creator sells a coin some follow holds
  (`copyTrade.holdsMint` is the firehose pre-check), the copier reads the
  creator's balance after the sell (`host.leaderHolding`, at or past the
  sell's slot) and sizes the share as sold / (after + sold) — the same
  recovery an unreadable leader sell uses. At or over the rule's share the
  whole copy is sold as a synthetic exit ("the creator sold 60 % of their
  bag — dev-sell exit"); under it, a log line. An UNREADABLE share fires the
  rule: a creator dump is the one sell this rule exists for, and "could not
  read it" must not become "so it was small". 0 = any creator sell. Pump
  curve only today (the AMM feed carries no creator).
- **Migration exit** (`exitOnMigration`, item 4). The engine's
  `onComplete` calls `copyTrade.noteMigration(mint)` alongside the
  migration orders, alerts and scripts. The exit is the ordinary queued
  100 % sell, so a live one meets the existing PumpSwap wait (retried every
  15 s for up to the wait's maximum) and paper closes at the spot.
- **Follow them out another way** (`copyOtherExits`, item 2). The wallet
  watcher already classified a leader leaving a coin without a SOL sale
  (`classifyUnseenExit`: transfer out, stablecoin sale, token-for-token);
  it now carries the token count that left and forwards the event
  (`WalletWatcherHost.onUnseenExit` → `copyTrade.onLeaderOtherExit`). A
  copy follow with the rule on (and "copy their sells" on) mirrors it as a
  sell whose size the transaction could not say: their balance after it
  sizes the share (1,000 moved with 0 left = 100 %; 500 with 500 left =
  50 %). Unreadable stays unreadable — the row says so, the position stays
  open, the user is told. Off by default: it is an exit the user did not
  see the leader take, so it is opted into.
- **Trading hours** (`activeFromMin` / `activeToMin`, item 6). Minutes
  after local midnight, both set = on, wrapping past midnight. An entry
  outside them is refused in `prefilter` and recorded ("outside your
  trading hours (09:00–17:00)"); exits never look at the clock. Four preset
  chips (Day 08–22, Work hours 09–17, Evening 17–01, Overnight 22–08) and
  two time inputs.
- **One position per coin** (`onePositionPerCoin`). A buy of a coin any
  follow already holds, or has a buy in flight for, is refused and recorded
  naming the holder ("already held through Sharky — one position per coin is
  on"). Per follow, off by default: two leaders in one coin is one bet
  taken twice, but a convergence follow is built on exactly that.

Item 1 (Helius `transactionSubscribe`) and the free Parsed Streams rail
shipped on 10-24. The address book and the whole-week check followed the
same day (§4d).

## 4d. Shipped 2026-10-28 (second round): the whole-week check and the address book

A correction first: this section's first draft said copy figures for a
pasted wallet were unbuilt. They were not: the Check page (10-24) already
read any pasted wallet from the chain and priced a copy of its newest 30
trips, chain first and pump's swap API as the fallback. That is item 5
below. What was missing was a whole week, plus names.

**Whole week on Check.** A "Replay" switch on the Check page: "Newest 30
trades", or "Whole week".
- A week check reads up to 5,000 transactions over 7 days through Helius
  (`walletHistory.start` with `{limit, days}`). It refuses to call the
  week covered unless the read reached back past the start of the week, or
  stopped short of its limit (`walletHistory.covers`).
- It then prices every closed trip of the week, up to 400. Each trip is
  priced from the chain first (at most 20 credits a trip, taken from the
  backtest allowance), so the ceiling is 8,500 credits, shown before the
  run starts. The slow swap-API fallback stops after 30 trips, and the
  trips left unpriced are counted and said.
- The figures it adds:
  - the mean copy, and the mean without the best 5 copies (the board's
    trimmed mean)
  - what the best 5 made, set against every other copy
  - a strip with one cell per day
  - a verdict from `shared/copyReplay.replayVerdict`, one of four: a
    loss; "positive only because of the best 5"; "one day made the
    week"; or positive. There is no verdict under 10 copies.
- This is the measurement that killed every candidate on 10-24 and 10-27.
  It is now one button.

**Address book.** A page reached from Following, not a place on the bar.
- **Each wallet:** a name, up to 8 tags and a note.
- **Where the name shows:** Discover rows and Compare, the Check header,
  a profile's header, Following cards (when the follow has no label of its
  own), the Follow page's default label, and a coin's trades and holders.
  The engine's `walletLabel` now asks the book first, then the watchlist.
- **The smart tag:** a coin holder's "smart" tag now asks the smart-money
  watchlist alone, through `isSmartWallet`. Being named by you does not
  make a wallet smart money.
- **Naming a wallet:** in place, with no pop-up. Use "Name this wallet" on a
  profile or on Check, or "Edit" on a row of the book.
- **Import:** paste text or pick a file. It reads a tracker's CSV in any
  column order (`wallet`, `label` and `group` headers included),
  headerless lines with the name before or after the address, tabs, a bare
  list of addresses, or JSON arrays and maps. A line without an address is
  counted, never guessed. Wallets already in the book are left as they
  were unless "update" is ticked. Even then the import only adds tags, and
  an empty cell never blanks a name or note you wrote.
- **Export:** CSV or JSON. Both read back unchanged (pinned by test).
- **Converge on a tag:** a tag's Solana wallets, two or more, open a
  convergence follow (`fomoSource: 'list'`) on paper.
- **The file:** `address-book.json` in the profile folder, written
  atomically. A file that cannot be read is never overwritten. The book is
  read-only for that session, and the page says why.
- **Tests:** `test/addressbook.test.mjs` (5 blocks); `copyreplay` and
  `wallethistory` gained the week cases.

Still not built: the follower prints model's own seek-by-timestamp in item
5 (the Check replay prices copies, but not the extra "a follower lands N
slots later" prints).

## 4e. Release check 2026-10-28: what a hands-on pass found

A scripted pass in the tutorial profile (real Helius key, real board) drove
every new feature. The address book, the new follow rules (watch only,
creator-sell and graduation exits, follow them out, one position per coin,
trading hours) and persistence across a restart all held. Five defects
were found and fixed:

1. **The board's #1 wallet never signed a trade.** Its tokens moved inside
   other wallets' transactions (an account a pool or market maker uses), so
   the live feed credited it trades that were not its own. A chain read now
   counts transactions where the wallet's tokens moved under someone else's
   signature; with 20+ read, 10+ such and no swap of its own, the record is
   marked **Never signs**, a hard exclusion on the board, and the read and
   the replay say why. A later read with a swap it signed clears the mark.
2. **One mistyped address turned the Helius deep read off for an hour.** An
   "Invalid params" answer (-32602) was taken as the plan refusing the
   method. Only a refusal of the method parks it now.
3. **A rate-limited read was still called "the whole week".** `covers()`
   now refuses a read with unreadable transactions, a deep read whose page
   failed part-way, and a standard read whose 200-signature listing filled
   before reaching the window. A week check on such a read goes on with what
   it has, titles itself "Replay part of their week", says how far back it
   reached and why, and draws no week verdict.
4. **The deep read stopped on the first 429.** A rate-limited page is now
   waited out (the host's park time, 1.5 s per try, at most 15 s) and asked
   again up to five times before keeping what was read.
5. **Choosing "Whole week" while the newest-30 replay was running did
   nothing.** The panel kept the old run and never started the week. The
   asked-for span is now queued, the status line says it starts when this
   run ends, and it does.

Seen in the pass, not changed: a very busy wallet (4,440 swaps in two days)
fills the week check's 5,000-transaction read in about two days; the check
says so. Live exits were not fired: nothing traded live.

## 5. Roadmap, ranked

Ranked by (competitor coverage × honesty × cost). Each item names what it
needs and what it must not claim. Items 2, 3, 4 and 6 shipped 2026-10-28
(§4c); item 1 shipped 2026-10-24.

1. **Leader feed transport: Helius `transactionSubscribe`** for keyed users.
   The watcher today: public-wss `logsSubscribe` (150–578 ms behind Helius
   on the same events, drops constantly, 8–25 % feed loss in last night's
   log), then a `getTransaction` round trip with up to six retries on a
   rate-limited endpoint. Enhanced WebSockets push the PARSED transaction
   in the notification — no read-back, `commitment: processed` allowed,
   `accountInclude: [wallet]`. It is the Developer plan ($49/mo), so the
   free key gets an error and must fall back to today's path with nothing
   changed. Scaffold: a transport interface in the watcher (`logs` |
   `helius-tx`), the subscribe frame and notification parser as pure
   functions with fixtures, a probe-once-then-fall-back rule pinned by test.
   This is the one speed change that costs users nothing on the free tier
   and removes a whole round trip on the paid one.
2. **Sell on transfer-out.** Bloom and TradeWiz name it; the pattern is real
   (a leader "hides" the dump by moving tokens to a fresh wallet).
   `walletSwap` already sees the token delta with no SOL leg and drops it
   as "not a swap"; classify it as `transferOut` with the fraction, and the
   copier raises a synthetic sell with a note, exactly like an own exit.
3. **Watch-only direction** (Maestro "Track Only", Trojan's typed alerts).
   A config that never trades: it records the leader's record, pushes
   First Buy / Buy More / Sell Partial / Sell All to the toast and the chat
   bots, and nothing else. It fits this app's stance better than any other
   competitor feature: it lets a user watch a wallet for a week before
   risking paper, let alone SOL.
4. **Dev-sell and migration exits** (GMGN). The feed knows every pump
   creator and every graduation; a copy-level "exit if the creator sells ≥
   X %" is a synthetic exit off data already decoded.
5. **Follower prints for a pasted wallet.** (Partly shipped: the Check
   page prices copies of a pasted wallet's newest 30 trips or whole week,
   §4d.) After a chain read, one
   swap-api page per trip seeks to the buy's timestamp (the cursor is a
   seek key) and supplies the prints the follower model needs. At the 2 s
   pace forty trips take eighty seconds — "paste any wallet, get a Copy
   score in two minutes" — and it is the one thing no competitor can show.
6. **Time windows and presets.** Cheap, cosmetic, expected.
7. **gRPC** (Chainstack $49 for two streams, Shyft $199) as a second
   transport behind the same interface as (1), for users who pay. Not
   before (1).
8. **Not worth building**: per-copy priority-fee overrides (the execution
   presets already govern it), "Lightning Mode" style at-most-once
   trade-offs, frontrunning on BNB (the rail polls confirmed logs; a mempool
   stream is $300/mo at bloXroute), shred feeds (co-location).

## 6. What must stay true

- Every filter fails closed on an unknown fact. A fact the engine cannot
  read refuses the copy and says so on the record.
- Every refusal is a row with a reason. Hiding skips measures only the
  trades you liked.
- No speed claim without a measurement in this repo. The competitors'
  "fastest" lines are marketing; ours must be a number from
  `test/orderlatency` or nothing.
- The Copy score ranks least-bad to follow. No decile was positive in two
  periods, and the only external follower dataset (43.61 %) agrees.
