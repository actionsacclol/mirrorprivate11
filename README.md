# Krypto Mirror

**A local-first copy trading app for Solana, Robinhood Chain and BNB Smart Chain.**
Free to download. No ads, no telemetry, no subscription, no Krypt account.
Krypt takes a **flat 0.5% of each buy and each sell** a copy makes — the same for everyone,
no holder discount. A referrer named at onboarding gets 20% of that fee, out of Krypt's share,
paid in the same transaction; it never costs the user more.

Krypto Mirror is the copy-trading half of [Krypto Bot](https://krypt.cc/tools/terminal), on
its own: find a wallet worth following, follow it on paper, and only then let it spend real
money — from a wallet whose key never leaves your machine. Underneath it is the same
engine, signer and RPC layer as Krypto Bot, including its speed work.

Part of the [Krypt](https://krypt.cc) free tools suite · [Discord](https://discord.gg/muzFKR657F)

---

## Read this first

Measured over two separate periods on our own recorded data, **copying memecoin wallets
loses money on average**. Leaders' real profits are earned in the seconds a follower is
not yet in. The Copy score therefore ranks wallets by what a FOLLOWER would have kept —
entering two seconds late and paying fees on both legs — and it ranks the least bad, not a
winner. Nothing in this app predicts what a wallet will do next.

That is why every follow starts on **paper**, and why paper is deliberately harsh: fills
at the price after your configured delay (never the leader's price), fees on both sides,
and every skipped copy recorded with its reason.

## What's in it

| Page | What it does |
|---|---|
| **Home** | Where you start: follow a wallet, your follows at a glance, the guides. |
| **Discover** | Top traders per chain over a window you pick, ranked by Copy score; winner-coin scans and wallets that converge on the same coins. |
| **Check** | Paste a wallet or a pump.fun username: its record and a whole-week copy replay before you follow it. |
| **Following** | Every follow and its record. The Follow page sets sizing, caps, daily loss limit, filters, delay, own exits, reverse / watch / crowd directions and the AI gate. |
| **Activity** | What your copies hold, every round trip they closed, and the live log (one timing line per copy). |
| **Wallet** | Solana wallets (any one can be a follow's signer) and one EVM key for Robinhood + BNB; pump.fun accounts; Paper/Live, send, back up. |
| **AI** | Connect Claude Code, Codex, Cursor or another MCP app: it sees your follows and Scout scans, and can decide each copy's buy and sell. |
| **Settings** | RPC endpoints and API keys, market-data providers, EVM chains, display, guides, logs. |

## How a copy happens

1. A followed wallet trades. Solana leaders are watched by their own `logsSubscribe`
   (Helius `transactionSubscribe` when the key serves it, which removes the read-back);
   EVM leaders through that chain's trade feed, which the app keeps running while you
   follow someone there.
2. The trade is decoded from the wallet's own balance deltas, so any DEX counts.
3. Your filters run (they fail closed — an unknown fact refuses the copy).
4. Paper: a simulated fill at the price after your delay. Live: the same order pipeline
   as Krypto Bot — local builder, simulate, loss guard, Jito / Helius Sender lanes,
   prewarmed blockhash and sockets — with Krypt's 0.5% injected into the same
   transaction.
5. Their sells are mirrored by the share they sold, settled in base units from your own
   confirmed fills. A sell missed while a socket was down is recovered (30 min window);
   anything older is recorded, never traded hours late.

## Safety rules that do not bend

- A config starts on paper. Switching it to Live disarms it; arming is a separate,
  confirmed act, and the top bar must be on Live too.
- A live config never comes back armed after a restart.
- An exit is never blocked by a fee, a breaker or anti-tamper.
- A budget is a refusal, not a clamp.

## Data and keys

Everything lives in `%APPDATA%\Krypto Mirror` (its own folder: Krypto Mirror never opens
Krypto Bot's data or wallets, so both apps can run side by side). An install that ran under
the app's earlier name keeps using `%APPDATA%\Krypto Copy` in place: the app finds its
wallet or settings there and never copies or moves them. Keys are encrypted with the OS key
store. A Helius key is the biggest single speed upgrade; it never leaves this machine.

## Building

```bash
npm install            # this machine's npm gate skips the electron binary:
cd node_modules/electron && node install.js && cd ../..
npm run typecheck
npm test               # offline suites (scripts/test-steps.json)
npm run dist           # installer in release/
```

Electron is pinned exactly (43.4.1): the main process ships as V8 bytecode compiled for
that runtime.

## Legal

Terms, privacy policy and risk disclosure are in the app (Legal) and must be accepted
before first use. Software provided as-is, without warranty. © Krypt.
