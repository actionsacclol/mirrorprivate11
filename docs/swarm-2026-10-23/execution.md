# Execution-path unknowns and leader-exit coverage

Swarm angle: execution. Date: 2026-10-23. Repo state: Krypto Copy `main` at `c4f3e1c`, clean.

Every claim carries a label:

- **measured**: I ran it on 2026-10-23. The script is named; all scripts are in `scratchpad/swarm/execution/`.
- **code**: `file:line` in `C:\Users\Krypt\Desktop\Krypto Copy`.
- **vendor**: a company describing its own product, with a URL.
- **estimate**: my inference.

Method: I bundled the app's own modules with the repo's esbuild into `appmods.cjs`, read-only: `txBuilder`, `pumpSwapBuilder`, `walletSwap`, `pumpDecoder`, `mintExtensions`, `addresses` and `rpcClient.resolveAccountKeys`. So every decode and every build below is the app's real code, not a re-implementation.

- Network: public RPC only (`api.mainnet-beta.solana.com`, `solana-rpc.publicnode.com`).
- Simulations: unsigned, `sigVerify:false`, `replaceRecentBlockhash:true`.
- Nothing was signed or sent.
- Fee payers are public wallets, used in simulation only.

---

## Headline

1. **NEW P1: the PumpSwap builder mis-sizes buys on about 12% of graduated pools (measured 6 of 51), live ones included.**
   - What goes wrong: `parsePool` reads pool byte 245 as `u64` (`electron/engine/pumpSwapBuilder.ts:156`). On 6 of 51 canonical pools the field has its top bit set. Read as `i64` it is a small negative number (−0.0000025 to −0.0195 SOL). Read as `u64` it is about 1.8e10 SOL.
   - Effect on a buy: Krypto Copy's legacy `buy` then asks for **4, 13, 190 or 704 raw token units** instead of the budget's worth. The simulation "succeeds" after spending a few lamports (measured, `ps_debug.cjs`, `ps_exact_fit.cjs`). The loss guard and the advisory receipt check both pass, because tokens arrived (`liveSigner.ts:1031-1040`). So a live copy buy reports success and holds nothing.
   - The affected pools are not only dead ones. `9cRCn9…pump` has an 8,404 SOL quote vault and `69LjZU…pump` has 1,796 SOL.
   - Effect on a sell: the sell asks for an impossible `min_quote_out` (77,545 SOL for 57.8 tokens), reverts `ExceededSlippage 6004`, and falls through to Jupiter (`liveSigner.ts:591-597`). So exits are slower, not lost.
   - The same `virtualQuote` also feeds `poolPriceSol` (`electron/data/pumpChain.ts:151-153, 287-288`). Those coins' chain price and market cap are therefore absurd (**code**; not observed in the UI).
2. **Krypto Copy never received the 10-23 exact-in fix.**
   - The memory note `audit-2026-10-23` says local buys are now `buy_exact_sol_in` / `buy_exact_quote_in`. That change exists only as uncommitted edits in the KryptSniper tree (`KryptSniper/electron/engine/txBuilder.ts:264`).
   - Krypto Copy still sends legacy `buy` (`txBuilder.ts:250, 414, 1484-1487`; `pumpSwapBuilder.ts` `PUMP_SWAP_BUY_DISC`).
   - Measured today with 0.01 SOL asked: the curve's legacy buy spends 0.008836 SOL at 12% slippage and 0.008034 SOL at 20%. Exact-in spends 0.010015 (`sim_spend.cjs`).
   - Porting exact-in also neutralises finding 1 for buys: exact-quote-in bought correctly on all four negative-virtual pools.
3. **jitodontfront fits anywhere except the memo.** An extra read-only `jitodontfront111…` account was accepted on:
   - the pump curve `buy`, `buy_exact_sol_in` and `sell`;
   - the PumpSwap `buy`, `buy_exact_quote_in` and `sell`;
   - ComputeBudget `setComputeUnitLimit`;
   - a Jito tip transfer.

   It costs +258 CU. The SPL Memo variant fails with `MissingRequiredSignature`, so the 10-21 doc's fallback "put it on a memo" is wrong.
4. **Leader exits we can't see depend on who the leader is.**
   - SOL-native pump traders (30 wallets): **34 of 765 exits (4.4%) are not mirrored**. They are concentrated in 5 wallets: 13 swaps to stable, 12 token-for-token, 9 transfer-outs, 0 burns.
   - Fomo (fomo.family) users: **148 of 150 transactions decode as nothing**. Fomo users hold USDC, so buys are USDC→token (67) and sells are token→USDC (58). `walletSwap` needs a SOL leg.
5. **Pump instruction drift does not break copying today.** Every one of 238 trades in 300 recent pump transactions carried a decodable `Program data:` TradeEvent **and** the emit_cpi copy. `walletSwap` agreed with the event on every swap it decoded (111/111, 0 mismatches).
   - Only 31% (74/238) of trades carry a plain `Instruction: Buy|Sell` line, down from the audit's 44%. That line is the input to the drift watchdog and to the held-mint fill request.
6. **Token-2022 risk is real but small, and lives on the Jupiter path only.**
   - The local builders cannot meet a transfer-fee or transfer-hook mint: the curve exists only for mints pump created, and the PumpSwap builder demands the canonical migration pool.
   - Measured: 3 of 986 leader buys (0.3%) were 1–3% transfer-fee mints (Raydium LaunchLab and Meteora). The copier would buy them through Jupiter with no mint check and no warning.

---

## 1. Token-2022: transfer-fee and transfer-hook handling

**Verdict.** The local curve and PumpSwap builders handle Token-2022 correctly for every mint they can be given:

- the token program and ATAs follow the mint's owner;
- WSOL stays classic;
- the ATA create passes the right token program.

They structurally never receive a transfer-fee or transfer-hook mint. A copy of such a mint goes to Jupiter, unchecked.

**Evidence: code**

- The curve builder takes the token program from the mint account's owner, caches it, and refuses anything that is not Token or Token-2022 (`txBuilder.ts:1441-1455`).
- ATAs: `userAta = ataFor(p.owner, p.mint, tokenProgram)` (`txBuilder.ts:1483`). Curve ATA via `fillSlots`: `txBuilder.ts:459-462`. The idempotent ATA create passes `tokenProgram` (`txBuilder.ts:1572-1584`). Sell close uses `programId: tokenProgram` (`txBuilder.ts:1594-1603`).
- No extra-account support for hooks. The account list is fixed: 18 accounts for a buy, 16/17 for a sell (`txBuilder.ts:361-423`).
- Amount math ignores transfer fees: `buyQuote` × (1−slip) (`txBuilder.ts:1485-1487`).
- A curve exists only for mints the pump program created. Its absence fails the build: "bonding curve account is missing" (`txBuilder.ts:1460`).
- PumpSwap: the base token program comes from the mint owner (`pumpSwapBuilder.ts:454-461`); user and pool base ATAs use it (`:331, :337, :481, :484`). The builder refuses any pool that is not the canonical migration pool, `state.creator !== pumpPoolAuthorityFor(mint)` (`pumpSwapBuilder.ts:451`). So only mints that came out of the pump curve reach it.
- `liveSigner` simulates against both the classic and the Token-2022 ATA (`liveSigner.ts:947-958`). The token receipt check is advisory only (`liveSigner.ts:1031-1040`).

**Evidence: measured** (`mintext.cjs`, `buymints.cjs`, 2026-10-23)

- In 108 mints from the pump and Fomo samples, every pump-suffixed Token-2022 mint (67) carries only `MetadataPointer+TokenMetadata`.
- 16 non-pump mints carried risky extensions:
  - 7 `TransferFeeConfig`, at 100 or 300 bps;
  - 9 with `PermanentDelegate+DefaultAccountState+Pausable+TransferHook+…`, which are xStocks-style tokenized-stock mints such as `Xs3oZw…`, `CASHx9…`, `MRNAzX…`.
- Of 986 decoded leader buys (318 mints) in the 30-wallet sample, 3 buys (0.3%) on 2 mints carried a transfer fee:
  - `2afA6z…` at 1%, via Jupiter → LaunchLab/DLMM;
  - `39HqgQ…` at 3%, via a router → LaunchLab/CPMM.
- No bought mint had a hook program, a permanent delegate or default-frozen state.

**What happens to a copy of a transfer-fee or transfer-hook mint today (code):**

1. `copyOnce` runs no mint-safety check. Its filters are only liquidity, market cap, Krypt score, age, creator and `onlyPumpfun` (`copyTrade.ts:2664-2790`), and `onlyPumpfun` defaults to false (`shared/copytrade.ts:802`). Then `h.buy` (`copyTrade.ts:2935`) → `engine.hostBuy` → `testTrade` (`engine.ts:7225`).
2. The route order is local → pumpswap → jupiter → relayer (`liveSigner.ts:389`). Local fails (no curve) and PumpSwap fails (no canonical pool), costing two RPC reads. Jupiter builds.
3. The SOL loss guard passes. Tokens arrive minus the transfer fee, and the fee is paid again on the mirrored sell.
4. `mintWarning` is only consulted after every route fails (`liveSigner.ts:546, 622-640`). `risk.checkMint` / `hasHardReject` run only on the launch path (`engine.ts:6530-6547`).
5. For a hook mint, Jupiter either includes the hook accounts or the simulation reverts and the copy fails closed. Which happens is **unknown** (not measured).
6. Paper copies of a fee mint understate cost by 2 × fee bps (**estimate**; the paper model has no transfer-fee term).

**Minor inconsistency (code).** `risk.ts:107-109` hard-rejects any `TransferHook` extension. `mintExtensions.ts:87-91` treats a hook whose program id is all zeros as no hook. Measured: the xStocks mints carry a `TransferHook` with a zero program.

**Code change implied**

- **Mint check on the Jupiter buy branch only:**
  - In `liveSigner.ts` at the `source === 'jupiter'` buy branch (`:460`), read the mint account (one `getAccountInfo`, which can run alongside the Jupiter quote).
  - Hard-refuse: `nonTransferable`, `defaultFrozen`, `permanentDelegate`, or a non-zero `transferHook`.
  - For `transferFeeBps > 0`: refuse above a per-config `maxTransferFeeBps` (default 0 for live). Otherwise add `2 × bps` to the paper side cost.
  - Skip the read for local and PumpSwap builds, which cannot be such mints. That keeps an RPC outage from blocking pump copies, as the 10-21 skeptic asked.
- **Align the two parsers.** Make `risk.ts:107` ignore a zero hook program, or drop it in favour of `parseMintExtensions`.

---

## 2. jitodontfront: where the account can go

**The rule.** Jito's docs say to add "any valid Solana public key that starts with `jitodontfront` to any of the instructions"; examples given are `jitodontfront111111111111111111111111111111` and `jitodontfront111111111111111111111111111123`. The account need not exist on chain and should be read-only. "Any bundle containing a transaction with the `jitodontfront` account will be rejected by the block engine unless that transaction appears first (at index 0) in the bundle." It "works with Jito's sendBundle and sendTransaction endpoints" and "applies only to the block engine". (**vendor**, https://docs.jito.wtf/lowlatencytxnsend/, fetched 2026-10-23.) The page does not say whether a plain `sendTransaction` is checked outside a bundle (**unknown**).

**Test setup.** `sim_dontfront.cjs` and `sim_ps_sell.cjs`, 2026-10-23 10:09 UTC, on `solana-rpc.publicnode.com`, against the app's own builders.

| Item | Value |
|---|---|
| Curve coin | `7PZ6fUqXF9kp5JoEGsX1owFavjRv3tUH2SScmMbJaHgV`, "local buy built (18-slot derived layout)" |
| PumpSwap coin | `5JjjSZG84ph5QHcRSaut9SZzc786wJwd2A8B1sPJpump`, "PumpSwap buy built locally (26-account layout)" |
| Buy fee payer (simulation only) | `G3LhfjYeShCVYQ8r7Q6tZmiYPaWQPEsUPujddZRTdUU6`, 10.373 SOL |
| Sell owners (holders) | curve `6pqCP7g6…` on `EPFs1Shv…pump`; PumpSwap `9YtzMiy1…` on `GgyziLAz…pump` |

**Results (measured, quoted from the run)**

| Transaction | Accounts in trade ix | err | unitsConsumed |
|---|---|---|---|
| CURVE `buy` 66063d, baseline | 18 | `null` | 79235 |
| CURVE `buy` + dontfront on the trade ix (last) | 19 | `null` | 79493 |
| CURVE `buy` + dontfront on ComputeBudget `setComputeUnitLimit` | 18 | `null` | 79235 |
| CURVE `buy` + dontfront on a 1000-lamport Jito tip transfer | 18 | `null` | 79385 |
| CURVE `buy` + dontfront on SPL Memo (MemoSq4…) | 18 | `{"InstructionError":[4,"MissingRequiredSignature"]}` | 79801 |
| CURVE `buy_exact_sol_in` 38fc74, baseline | 18 | `null` | 80565 |
| CURVE `buy_exact_sol_in` + dontfront on the trade ix | 19 | `null` | 80823 |
| CURVE `sell` 50%, baseline | 16 | `null` | 52436 |
| CURVE `sell` 50% + dontfront on the trade ix | 17 | `null` | 52694 |
| PumpSwap `buy`, baseline | 26 | `null` | 117192 |
| PumpSwap `buy` + dontfront on the trade ix | 27 | `null` | 117450 |
| PumpSwap `buy` + dontfront on ComputeBudget | 26 | `null` | 117192 |
| PumpSwap `buy_exact_quote_in` c62e15, baseline | 26 | `null` | 118612 |
| PumpSwap `buy_exact_quote_in` + dontfront on the trade ix | 27 | `null` | 118870 |
| PumpSwap `sell` 50%, baseline | 24 | `null` | 93335 |
| PumpSwap `sell` 50% + dontfront on the trade ix | 25 | `null` | 93593 |

Program log lines in the dontfront runs were identical to the baseline: `Instruction: Buy` / `BuyExactSolIn` / `Sell`, `GetFeesWithQuoteMint`, `TransferChecked`. The memo failure, verbatim: `Program MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr failed: missing required signature for instruction`. The memo program treats every account it is given as a required signer.

**Verdict.** Both programs tolerate the extra read-only account as a remaining account, at +258 CU and +32 bytes. The tip transfer and ComputeBudget also accept it. **Memo does not.**

**Placement**

- The tip transfer is the right place: dontfront matters only on the Jito lane, and the tip is injected for every route (local, PumpSwap, Jupiter, relayer).
- The signer reads a system transfer's destination from `accountKeyIndexes[1]` only (`electron/system/signPolicy.ts:955-962`), so a third key should pass. That needs a signer test (**code**, not run).
- The account must stay a static key, never behind a lookup table (**estimate**). The app's injection already keeps transfer keys static (`broadcast.ts:274-300`).

**Code change implied**

- In `electron/engine/broadcast.ts:356-366` (`injectTransfersFit`'s `SystemProgram.transfer` factory), append `{pubkey: jitodontfront…, isSigner:false, isWritable:false}` to a transfer whose destination is in `JITO_TIP_ACCOUNTS`.
- Gate it with a setting: default on for copy buys sent with `useJito` or `mevMode:'private'`.
- Add a signPolicy test with a three-account tip transfer.
- Do NOT use a memo.
- Pair it with the M2 sandwich detector to measure whether it changes anything. Protection is "not guaranteed" (**vendor**).

---

## 3. Leader exits the app can't see

**Sample (measured).** `leaders_fetch.cjs` and `classify_exits.cjs`, sampled 2026-10-23 10:12 UTC.

- 30 wallets: every distinct pump TradeEvent `user` that signed its trade with ≥ 0.02 SOL, from the 300-transaction pump sample.
- Up to 100 signatures each: 2,460 successful signatures, of which 2,104 were readable. The rest were refused after mainnet-beta 429s, which is not selective by content (**estimate**).
- Each (transaction, mint) where the wallet's own non-SOL, non-stable balance fell counts as one exit.
- The app's `decodeWalletSwap` was run on every transaction.
- **Bias:** selecting on signed SOL-legged pump trades picks SOL-native traders. Fomo users are measured separately in §5. Five of the wallets (`G3Lhfj…`, `9QCSDD…`, `BXTyp9…`, `xrxVfp…`, `5yd6tw…`) have identical shapes and look like one bot cluster.

| Exit class | Count | Share | Full exits |
|---|---|---|---|
| A. Swap for SOL, decoded as a sell (mirrored) | 731 | 95.6% | 624 |
| C. Swap for stable (USDC/USD1/USDT): notSwap | 13 | 1.7% | 13 |
| D. Token-for-token: notSwap | 12 | 1.6% | 7 |
| E. Transfer-out to another owner (no SOL leg): notSwap | 9 | 1.2% | 9 |
| B. Swap for SOL that the decoder dropped | 0 | 0% | 0 |
| G. Burn / close / vanished | 0 | 0% | 0 |
| H. Wallet did not sign | 0 | 0% | 0 |
| **Total** | **765** | | **653** |

In the E row, 2 of the 9 had a SOL leg under the 0.0005 dust floor.

**Share not mirrored: 34 of 765 = 4.4%** (measured). It is concentrated:

- 25 of 30 wallets: 0 or 1 unmirrored exit.
- `F7zY5L…`: 14 of 48 exits, of which 12 are token-for-token rotations. It sells coin A for coin B through router `B3111yJC…` in one transaction, so the app misses the exit **and** the entry.
- `5Yh3rN…`: 10 of 28, of which 7 are sells for USDC.
- `4Cuw2G…`: 5 of 36.

What the transfer-outs are (measured, `exdetail.cjs`):

- Plain moves to another wallet, e.g. `5Yh3rN` → `D4oAq8`, and `23fnUN…` with a memo.
- One move into a trading program's custody account: `He45KZ…` sent tokens via `term9Y…` to `HLnpSz…`, which is also the custody owner the `King7ki…` bot sells from. The sale then happens from that custody account and is invisible to the wallet watcher.

**The `notSwap` counter is mostly not exits (measured).** 384 of 2,104 leader transactions (18.3%) decode as notSwap, and only about 34 of those are exits. The rest are rent, transfers in, account maintenance, dust and stable-legged buys. A per-cause split is required before the counter means anything. This confirms the 10-21 skeptic.

**Also measured (`rentinflate.cjs`).** On 92 of 734 decoded sells (12.5%), the leader closed the token account in the same transaction. `walletSwap` counts the rent refund as proceeds: median +0.56%, p90 +0.73%, max +1.71% of the reported `sol`. That inflates the leader's record (`trackLeader`) slightly. It does not affect mirroring, which uses `soldFraction`.

**Verdict.** For SOL-native pump leaders, the 10-21 "High" impact for roadmap #7 is too strong: it is 4.4% of exits, mostly in a few wallets. For leaders who use stable-coin apps (Fomo, §5) it is close to 100%.

**Code change implied**

- **A mirrored exit needs a fraction, not a price.** Replace the `null` returns in `walletSwap.ts:152-160` with a classified result: `{kind: 'stableSell' | 'tokenForToken' | 'transferOut' | 'burn', mint, soldFraction}`.
  - `soldFraction` comes from `preTokenBalances` exactly as today (`walletSwap.ts:190-191`).
  - The price is null, or a USD price via a cached SOL/USD rate when the leg is a stable.
- `walletWatcher.ts:583-587` (and `:526-529` on the transactionSubscribe path) splits `notSwap` into those counters plus `other`.
- `copyTrade` mirrors `stableSell` and `tokenForToken` exits as ordinary proportional sells. `transferOut` follows the per-config switch the 10-21 doc resolved (default on, labelled, never priced).
- Subtract the rent of the leader's token account closed in the same transaction (post lamports 0) from `solDelta` (`walletSwap.ts:128-135`).

---

## 4. Pump instruction drift: does copying still see every pump trade?

**Sample (measured).** `sample_pump.cjs`, `analyze_pump.cjs` and `cpicount.cjs`: 300 recent successful pump-program transactions (2026-10-23 09:56 UTC), 142 of them transaction v1. 238 contain a TradeEvent.

| Check | Result |
|---|---|
| Trades decodable from `Program data:` logs (`decodeLogsEx`, the firehose's input) | **238/238** |
| Trades also present as emit_cpi inner events (`decodeCpiEventData`) | 238/238 (both present in every transaction; 0 log-only, 0 CPI-only) |
| Layout errors | 0 |
| Truncated logs | 8 transactions; 7 had no trade; 1 had a trade in both logs and CPI |
| Plain `Instruction: Buy`/`Sell` line present (`logsMentionPumpTrade`) | **74/238 = 31%** |
| Instruction names logged by pump | `SellV3` 109, `Sell` 45, `Buy` 29, `BuyExactQuoteInV3` 24, `BuyExactQuoteInV2` 11, `BuyExactSolIn` 8, `SellV2` 8, `BuyV2` 3, `BuyV3` 1, plus non-trade names (`DistributeFeeToHolders` 50, `CloseUserVolumeAccumulator` 7, …) |
| `walletSwap` on the event's `user` | 111 decoded, **all 111 match the event's mint and side**, 0 mismatches |

Why `walletSwap` returned null on the other 127:

- 70: the SOL leg was under 0.0005 SOL (bot dust).
- 40: the event's `user` did not sign. A program-derived address trades for signer `Gygj9Q…` via `MAyhSm…`; the tokens sit with the address, not the signer.
- 7: buys under the 0.005 SOL floor.
- 10 other:
  - USDC-legged buys through Jupiter, one of them a Fomo transaction (`61swrb…`: fee payer `AgmLJB…`, user `Fb4jcw…` paid 4.04 USDC);
  - `King7ki…` bot sells where the tokens and SOL sit in custody accounts owned by others.

**Verdict.**

- **The walletSwap balance-delta path does not care about instruction names**: 111/111 agree with the event.
- **The firehose path still decodes every trade**: pump emits the log and CPI events in parallel.
- Drift so far affects only the watchdog's view:
  - `logsMentionPumpTrade` (`pumpDecoder.ts:169-174`) recognises 31% of trades.
  - The undecoded-ratio watchdog (`engine.ts:6118-6125, 6346`) still trips on a total emit loss, since the ratio among recognised trades would go to 100%.
  - It is blind to drift that hits only the V2/V3/ExactIn variants, which are 69% of trades.
  - The held-mint fill request (`engine.ts:6091, 6122`) fires only on plain lines.

**One structural gap that is not about drift (code).** The firehose delivers a leader's curve trade to the copier only if the mint is in the engine's session token map. `onTrade` returns at `if (!t)` (`engine.ts:6571-6580`) before the `copyTrade.activeWallets().has(ev.user)` check (`engine.ts:6667`). The map holds launches seen this session, capped at `LAUNCH_LIST_CAP = 300` (`engine.ts:185`). Every other leader curve trade waits for the wallet watcher's `getTransaction` read-back. That is a latency loss, and for USDC-legged leaders (§5) a coverage loss.

**Code change implied**

- `pumpDecoder.ts:169-174`: match `^Program log: Instruction: (Buy|Sell)(V\d+|ExactSolIn|ExactQuoteIn(V\d+)?)?$`, scoped to lines logged while pump is the executing program. Re-pin the watchdog test with V3 fixtures.
- `engine.ts:6571-6580`: run the `activeWallets()` / `onWalletTrade` delivery (a Set lookup, priced from the event's reserves) **before** the `if (!t) return`. Followed wallets on any curve mint then get the firehose path.

---

## 5. Fomo (fomo.family) leaders on Solana

**What a Fomo trade is (measured, `fomo.cjs`).** I took 150 recent successful transactions of `AgmLJBMDCqWynYnQiPCuj9ewsNNsBJXyzoUhD9LJzN51`, which Bitquery identifies as FOMO's signer and fee payer (**vendor/secondary**: https://docs.bitquery.io/docs/blockchain/Solana/fomo-api/ says "Bitquery identified these addresses from on-chain activity. FOMO has not published or confirmed them"). The 150 span 25 seconds and 133 distinct users; 132 are transaction v1.

- **Fee payer:** `AgmLJB…` in 150/150.
- **Signers:** exactly two in 150/150, FOMO plus the user. The user is a normal signing wallet: a Privy embedded wallet per Privy's case study (**vendor**, https://privy.io/blog/turning-trading-into-a-social-experience-with-fomo). It is **not a smart account or program-derived address on Solana**. This contradicts Bitquery's line that Signer "always show[s] FOMO": FOMO is signer 0, the user is signer 1.
- **Top-level programs:**
  - DFlow `DF1ow4tspfHX9JwWJsAb9epbkA8hmpSEAtxXy1V27QBH`: 78
  - Jupiter v6: 28
  - `proVF4pMXVaYqmy4NjniPh4pqKNfMmsihgd4wdkCX3u`: 26 (identity **unknown**)
  - `Memo4c2p…`: 15
  - other: 3
- **The user's legs:**
  - `USDC → TOKEN`: 67
  - `TOKEN → USDC`: 58
  - `USDC → nothing`: 18 (fees or transfers)
  - the remaining 7 are SOL/USDC mixes
- **Fee:** paid in USDC to owner `R4rNJH…`, seen in transaction `61swrb…` from the pump sample (0.1 USDC).
- 95 of the users' 157 token legs are pump-suffixed mints. 87 of 150 transactions touch PumpSwap.
- 19 of 150 are pump-curve trades. In 19/19 the pump TradeEvent's `user` **is the Fomo user**.

**What the app does with one (measured with the app's decoder).**

- `decodeWalletSwap(tx, user)`: 1 buy, 1 sell, **148 null**.
- The user signs, so `idx < signers` passes. Because `idx ≠ 0`, the fee is correctly not added back (`walletSwap.ts:117-127`).
- The null comes from the USDC leg: `Math.abs(solDelta) < MIN_SOL` (`walletSwap.ts:153`).
- A Krypto Copy config following a Fomo user therefore sees their transactions on `logsSubscribe` (they are mentioned and signing), counts almost all of them as `notSwap`, and copies essentially nothing.
- The exception: curve trades on a mint the session's firehose is tracking, which arrive via the pump event (`engine.ts:6667`).
- PumpSwap trades are not delivered by any AMM feed to the copier. `onWalletTrade` callers are `engine.ts:515` (watcher), `:6670` (curve) and `evm/scanner.ts:577` only.

**Correction to the 10-21 doc.** It says Bloom requires "Sell on Transfer" for Fomo profiles (**vendor**, docs.bloombot.app). On Solana, Fomo exits are token→USDC **swaps** (58/150), not transfers. What our decoder lacks is a stable leg, not transfer handling. Why Bloom needs sell-on-transfer is **unknown**: perhaps its decoder sees the DFlow route's temporary account.

Resolving a Fomo **profile name** to a wallet was not attempted. The Bitquery page says Fomo has no public API. **Unknown.**

**Code change implied**

- **walletSwap stable legs** (`walletSwap.ts:121-160`):
  - Treat USDC, USD1 and USDT owned-account deltas as a quote leg alongside SOL and WSOL.
  - Convert to SOL with a cached SOL/USD rate, labelled `quote: 'USDC'` on the record.
  - Report `soldFraction` exactly as today.
  - This one change makes Fomo leaders copyable: entries priced, exits mirrored.
- **Copier:** a USDC-quoted leader entry is copied in SOL. The record should state that the leader's fill was USDC-priced (honest-null: the SOL price is derived, flagged as derived).
- **Label (optional, S):** fee payer `AgmLJB…` with the user as signer 1 means a "Fomo user". Show a chip on the wallet page. The address is Bitquery's attribution, so it is a heuristic, not a fact.

---

## Prior docs: what this finds wrong

| Prior claim | Status | Evidence |
|---|---|---|
| Memory `audit-2026-10-23`: "local buys now EXACT-IN … verified" | **Not in Krypto Copy.** It is uncommitted in KryptSniper only. | **code:** Krypto Copy has no `38fc7408`/`c62e1552` anywhere in `electron/engine`; `KryptSniper/electron/engine/txBuilder.ts:264` has it. **measured:** Krypto Copy spends 0.008836 of 0.01 at 12% slippage. |
| Memory `pumpswap-builder`: "virtual quote reserve (u64 @245)" | **Wrong type.** | **measured:** 6 of 51 canonical pools have the top bit set. Read signed, they fit the program's pricing (e.g. `5Jjj…`: vault 0.022583 + i64 −0.011750 = 0.010833 SOL, against an effective quote of 0.010968 fitted from the exact-in event). Read unsigned, about 1.8e10 SOL. |
| 10-21 M2: "otherwise put it on a memo or tip instruction" | **The memo half is wrong.** | **measured:** `MissingRequiredSignature` |
| 10-21 #7: transfer-out and stable exits "High" | **Population-dependent.** | **measured:** 4.4% of exits for SOL-native pump traders; about 99% of Fomo-user transactions invisible |
| 10-21: Bloom "Sell on Transfer" required for Fomo, implying Fomo exits are transfers | **Not on Solana.** | **measured:** 58/150 Fomo transactions are token→USDC swaps |
| 10-21 §6: non-pump risky-mint frequency among leader buys "unknown" | **Resolved.** | **measured:** 3/986 buys (0.3%), all 1–3% transfer fees; 0 hooks or delegates |
| 10-23 audit: "56% of trades lack a plain Buy/Sell line" | **Now 69%.** | **measured:** 164/238 |
| 10-21: "Whether a Fomo profile can be resolved to a wallet is unknown. First decode a real Fomo exit (ERC-4337 on EVM, DFlow routing)" | **Solana half resolved.** The user is a plain signer; FOMO pays the fee; DFlow or Jupiter route. EVM/ERC-4337 not examined. | **measured** (`fomo.cjs`) |

## Side notes (measured, minor)

- `solana-rpc.publicnode.com` now refuses `getMultipleAccounts` above 10 keys: "A maximum of 10 accounts is allowed" (-32602). The app's default HTTP is mainnet-beta (`shared/types.ts:1110`), and its builders batch ≤ 7 keys. A user who points HTTP at publicnode loses the 100-key batches, such as `engine.ts:4760-4770`.
- mainnet-beta returned whole-host 429 with `retry-after: 10` and `x-ratelimit-method-limit: 150` after a ~4-way-parallel `getTransaction` burst.

## Open questions

- Does Jito's block engine apply `jitodontfront` to a plain (non-bundle) `sendTransaction`?
- Does `jitodontfront` measurably reduce sandwiches on our fills? This needs the M2 detector.
- What is pump-amm's actual definition of Pool @245? Signed i64 fits the data; the IDL was not fetched.
- Does Jupiter route Token-2022 transfer-hook mints, or does the copy fail closed?
- What is `proVF4pMXVaYqmy4NjniPh4pqKNfMmsihgd4wdkCX3u` (26/150 Fomo transactions)?
- Can a Fomo profile username be resolved to a Solana wallet?
- Are the 4.4% unmirrored exits stable over a week of followed leaders, rather than a 30-wallet snapshot? The roadmap's split `notSwap` counters would answer it.

## Scripts (all in `scratchpad/swarm/execution/`)

| Script | What it does |
|---|---|
| `appmods.ts` → `appmods.cjs` | The app's modules bundled read-only by the repo's esbuild |
| `rpc.cjs` | Paced JSON-RPC helper |
| `sample_pump.cjs`, `analyze_pump.cjs`, `cpicount.cjs`, `inspect.cjs`, `deltas.cjs` | Q4 |
| `sim_dontfront.cjs`, `sim_ps_sell.cjs` | Q2; `sim_dontfront.log` holds the run output |
| `sim_spend.cjs` | Legacy vs exact-in spend |
| `ps_debug.cjs`, `ps_virtual.cjs`, `ps_census.cjs`, `ps_exact_fit.cjs`, `ps_sell_neg.cjs` | Pool @245 finding |
| `leaders_fetch.cjs`, `classify_exits.cjs`, `exdetail.cjs`, `rentinflate.cjs` | Q3; `exits_v1.json` |
| `fomo.cjs` | Q5; `fomo_sample.json` |
| `mintext.cjs`, `buymints.cjs` | Q1 |
