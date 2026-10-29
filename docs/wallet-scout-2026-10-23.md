# Wallet Scout, 2026-10-23: the board grades itself, graduated trips close, warnings, pump.fun usernames, copy replay

This continues `docs/copy-trader-swarm-2026-10-23.md` and `docs/wallet-finder-research-2026-10-22.md`. It covers the three Scout items ranked next on 10-23, plus two the user asked for: copying a pump.fun user by username, and seeing what copying a wallet would have done before following it.

The ranking still cannot find a wallet that is profitable to copy. Everything here serves one of two jobs: numbers the user can trust, and warnings about who not to copy.

## Built

| # | Item | What changed | Pinned by |
|---|---|---|---|
| 1 | **The board's own record** | Every 10 minutes the Scout writes down the top 10 of "Best to copy" (same rule: week window, default size, all five filters, the shrunk median). It keeps each pick for 14 days whether or not the wallet stays on the list, so the board is never graded only on its survivors. Only copies of trades a pick **opens after** being picked count. The comparison is every copy the record priced over the same span, a reservoir sample of 500 per day. Discover shows a line: "copies of its N picks made X % per copy, against Y % for every wallet on record", plus the fee floor. Below 20 copies it says it is too early to read. `walletScout.ts` (`refreshPicks`, `picks`, `baseline`), `shared/walletScout.ts` (`boardRecord`), `engine.ts` (10-min timer), `Discover.tsx` | walletscout "the board's picks are written down once, graded only on later trades, saved, and let go after two weeks" |
| 2 | **Graduated trips close** | `onAmmLogs` now decodes PumpSwap swaps for the Scout even when nothing else wants them. It feeds `scout.note` only for coins the book is in (`wantsMint`: a tracked wallet opened there, or a copy leg is waiting there). Before this, a trip bought on the curve and sold on the pool never closed, and those are the slow wallets' trips, the copyable kind. Scout-only decoding does nothing else: migrations are remembered and the loop continues. | walletscout "…the PumpSwap feed knows which coins the book needs" |
| 3 | **Warning chips** | **Creates coins** (any create in the window; the strongest label on the 09-16 tape: −16.2 % a copy against −9.5 %). **Mayhem coins** (at least 2 trips and 25 % or more of them on mayhem-mode coins; −9 to −90 points held out). **Large size** (median first buy of 2 SOL or more; −13.6 % against −9.8 %, from only 120 wallets). Each tooltip states its rule and evidence, and a test fails if a threshold moves without its text. They are chips, not filters, because each rests on one tape. Bot and long-holder were left out: neither replicated on 10-23. They show on the board, the profile and the wizard's suggestions. Creates come from the create events the feed already decodes, including creates made before the wallet was promoted. | walletscout "warnings: …", "creates fold in on promotion…" |
| 4 | **pump.fun username → wallet** | `GET frontend-api-v3.pump.fun/users/{name}` answers for a username as well as an address (measured 10-23). It is a catch-all: `/users/search` returns a user called "search". So `pumpUserFrom` believes an answer only when it is the profile asked for. The input accepts `name`, `@name`, a `pump.fun/profile/…` link or an address. A name made only of dots is refused, since `/users/..` would be a different route. Lookups go through the existing Chromium `pumpFetch`, one per click, cached 10 min, never polled. Discover's lookup box and the follow wizard both accept it. The profile shows "pump.fun @name · N followers" when the wallet has an account. The UI says the app copies the wallet the account signs in with, and that the person may trade from others. `shared/pumpLookup.ts`, `system/pumpProfile.ts` (`findPumpUser`) | `test/pumplookup.test.mjs` |
| 5 | **Copy replay** | "Replay copying them" on the profile works for any Solana wallet, including one the feed never saw. It reads their recent swaps from the chain (the existing `walletHistory` read, reused if under 10 min old). It pairs them into finished trips by the Scout's rules. For the newest 30, it prices a copy 2 s behind each leg at the price the last trade before that moment left the coin at (swap-api `priceSol`, one call per leg, with the timestamp seek in the cursor). That is the same fill rule as the Scout. Too-fast trips cost no calls, and a coin pump has no trades for stays unpriced. The summary is priced at the user's size with paper's costs, next to the fee floor. The follow wizard links to it ("See how copying them would have gone first"). `shared/copyReplay.ts`, `electron/engine/copyReplay.ts`, `pumpswap.ts` (`priceAt`), `WalletProfile.tsx` | `test/copyreplay.test.mjs` |
| 6 | **swap-api through Chromium** (found while testing #5) | `swap-api.pump.fun` now answers Node's fetch with Cloudflare's challenge: 403 `cf-mitigated: challenge` from undici, 200 from curl and from Electron's `net`, measured 10-23. Only `pumpfun` was routed through Chromium, so the Scout's **Scan**, launch reads and the replay were all getting the challenge page in the app. `main.ts` now registers `pumpFetch` for `pumpswap` too. | live check below |

## Live check (read-only, 10-23)

The replay ran under Electron with the app's transport, on sambati's wallet (8MpJ…rbN5, 46k pump.fun followers, found by username):

- The chain read took **225 s** on the free RPC for 200 signatures: 82 swaps. That is the `getTransaction` budget, 10 per ~10 s. The panel says "up to four minutes".
- 10 finished trips were priced in 20 swap-api calls.
- At 0.1 SOL a copy: median **−42 % per copy**, 1 of 10 won, −0.14 SOL in total, against a fee floor of −7.0 %.
- On one trip they made +107 % (2.7 SOL on 2.5) and the copy made +2 %. On another they made +0.31 SOL and the copy lost 38 %. Their 1.3–8 SOL buys move the curve before a copy lands, which is the Large size chip's reason.
- The same run through Node's fetch got 403 on every price, which is how #6 was found.

## Deeper wallet reads with a Helius key (later on 10-23)

- **The key path was already right.** With a Helius key, the wallet read and the replay go to `mainnet.helius-rpc.com` (`execUrlOf` → `resolveRpc`). A URL typed in the fast-RPC field wins over a derived one.
- **The deep read.** `rpcClient.getTransactionsForAddress` uses Helius's own method: full transactions, 100 per page, `status: succeeded` and `blockTime ≥ now − 30 d` filtered on the server, v1 transactions included. `walletHistory` uses it whenever the endpoint is Helius. The read is capped at 1,000 transactions or 30 days (`DEEP_READ_LIMIT`, `DEEP_DAYS`), metered at 10 credits per 100, so about 100 credits at the cap.
- **When the method is refused.** Helius's docs don't say consistently which plans serve the method, so a refusal is treated as an answer. The request goes out on its own, not through `call()`: `call()` would read a 401/403 as a bad key and route every other read to the public endpoint. If the method is refused, the standard read runs on the same key, and the deep read is not tried again for an hour. The profile says which read ran.
- **Live check, with the user's Helius key from Krypt Terminal, never printed:**

  | | Free RPC | Helius deep read |
  |---|---|---|
  | Swaps | 82 | 758 |
  | Trips | 10 | 148 |
  | Time | 225 s | under 5 s |

  One page of 100 came back in 252 ms. That key's plan does serve the method.
- **swap-api pauses.** It parked about 48 calls in (around 100 s at the 2 s pace) for about 60 s. The first version then left 17 of 30 trades unpriced. The replay now waits out a park (`cooldownRemainingMs`), up to 3 waits per leg and 6 per replay, and shows "pump.fun asked us to slow down, waiting N s". On the rerun 29 of 30 were priced, in 295 s.
- **Rerun result** for sambati at 0.1 SOL: median −37 % per copy, 17 % of copies won, total +0.14 SOL. One +689 % coin carried the total. The median is the figure to trust, and the panel shows both.
- **Tests:** wallethistory "with a Helius endpoint the deep read pages the full transactions; a refusing plan falls back and is not asked again"; copyreplay "a rate-limited price is waited out and asked again".

## Not built, and why

- **pump.fun's PnL leaderboard** (`/pnl-leaderboard?period=weekly`, public) as a seed list. It ranks by the leader's own PnL; the #1 entry on 10-23 was +368,940 % on 9 SOL. Seeding candidates from it is allowed by the 10-22 plan (D2 forbids it only as a score), but it sits under the pump.fun Terms decision in `docs/copy-trader-swarm-2026-10-23.md` §6, and so does every username lookup and replay call.
- Bot rule on trade rate and scan honesty (`complete` not carried): still open, from the 10-23 list.

## Decisions for the user

1. **pump.fun Terms §6.1/§21.** Username lookups, the profile's pump.fun line and the replay's price calls are all requests to pump.fun's API about other users. Each is one request per click, never polled. They still fall under the same decision as the Scan.
2. Whether the profile should look up the pump.fun account automatically on every Solana profile (it does now: one cached read per profile) or only on request.
