# Copy guardrails, 2026-10-23 (Batch 1 of "simple bot, power features")

These are the limits a copy bot needs before it can be left running, and the alerts that tell a person when one trips. The spec is `docs/wallet-finder-research-2026-10-22.md` §6 (defaults) and §7 (guardrails).

The house rules hold throughout. Every rule here blocks entries only, and exits are managed whatever state a follow is in. Each rule is a recorded refusal or a pause the card shows, never a silent stop. Nothing retries a failed order.

| Rule | What it does | Where |
|---|---|---|
| **Max open copies** (app-wide) | `execution.maxOpenCopies`, default 5, 0 = off. Paper and live are counted apart. A copy that would open one more position across every follow is skipped with the reason "limit: N copies open across all follows". A buy that adds to a coin the follow already holds opens nothing new, so it passes. Buys still in flight count. It is set on the Wallet page next to Max SOL / trade. | `copyTrade.ts` `openCeilingHit`; `shared/types.ts`; `settingsValidation.ts`; `Wallet.tsx` |
| **Per-wallet stop** | `walletLossStopSol` per follow. Once the follow's closed copies, in its current mode, have lost this much since it was last switched on (`lossStopFrom`), the follow pauses itself. This is judged at the next buy and on the 15 s clock (`checkMaxHolds`). Switching the follow back on clears the pause and restarts the count. Simple follows get 4× their size; on the full page it is "Pause this wallet after losing", blank = off. | `walletStopHit`, `autoPause`, `clearPause`; `ConfigEditor.tsx` |
| **Pause after failed copies** | `COPY_FAIL_PAUSE = 3`, always on. Three live buys in a row that were sent and failed (not filter skips) pause the follow, and the card shows the last error. A copy that lands resets the count. | `failStreak` in the live-buy result |
| **Daily stop at 3×** | `SIMPLE_LOSS_MULTIPLE` goes from 10 to 3. A median mirrored copy loses 4–7 %, so 3× trips on a bad day, not a normal one. Follows already saved keep their own number. | `shared/copytrade.ts` |
| **Alerts** | `alertUser` covers: a pause (wallet stop or failures), a day's stop (once per follow per day), a copy sell that failed, a sell that came too late to mirror, and a sell made while the app was closed. Each is toasted in the app and sent through the engine's `notify`: the desktop pop-up, paired chat bots and webhook, each behind its own switch. At most 6 an hour; past that they are logged. A single failed buy stays a toast. | `alertUser`; host `notify` in `engine.ts` |

The card says "Paused by the app 2 m ago — down 0.42 since it was switched on, past its 0.4 stop" in amber until the user switches the follow back on, and its rules line shows "pauses after −0.4 SOL in all".

Already in place before Batch 1, and left alone: every skipped leader trade is a row with its reason on Activity; the live minimum size; no auto-arm on wallet creation; the daily copy and per-minute limits.

**Tests** (`test/copytrade.test.mjs`):
- per-wallet stop: pause, reason, notification, no copy while paused, re-enable resets;
- three failures pause;
- fail, fail, land, fail, fail never pauses;
- the max-open ceiling: refused, an add to a held coin passes, the exit goes through, a freed slot copies;
- the 6-an-hour alert cap;
- the Simple preset's 3× and 4×.

**Not exercised live:** nothing here was run against a real wallet. The first live check is a 0.03 SOL follow made to fail three times, for example with an empty wallet: it should pause and notify.
