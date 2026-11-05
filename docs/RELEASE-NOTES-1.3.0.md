# Krypto Mirror 1.3.0: release notes

Windows installer, unsigned, so Windows shows "Windows protected your PC" on first
run (More info, then Run anyway; the Install guide shows it). Publish the SHA-256
beside it. Mac and Linux are not part of this build.

## Upgrading from 1.1.0

Install over the top. Wallets, follows and history stay; the `appId` is unchanged.

- Setup runs once more, so everyone sees where the guides and the wallet are. The
  terms already accepted are not asked again.
- **Numbers you saved stay.** Limits are now off for new follows, but a follow that
  already has a daily limit or loss stop keeps it until you clear it.
- Neither 1.1.0 nor 1.3.0 checks for updates, so people have to be told a new version exists.
- If you turn the wallet password on, do not go back to an older version: an older
  app that saves a wallet makes every wallet read as tampered until the password is
  turned off and on again. No key is lost.

## Runs for days

- **Sleep no longer stops copying.** After the computer slept, the wallet watcher
  never came back and nothing said so. This is in 1.1.0 too.
- **No limits unless you set them.** Copies a day, daily loss, max per trade, max
  open copies and the wallet loss stop all start off.
- **Auto re-arm.** Settings has a switch for each reason something stops: failed
  trades and pump.fun upgrades come back by themselves; loss limits, a follow's own
  loss stop and app restarts stay stopped unless you turn them on.
- **Failed sells keep trying until they sell**, from 30 seconds apart up to once an
  hour, and a restart no longer forgets them: after one, they wait for Live and go.
  Your own stop (Paper, kill switch, lock) ends one. A coin that can never be sold keeps
  trying hourly, and a try that reaches the chain can cost a network fee.
- **An unconfirmed sell is checked.** If it landed it is booked, and if it did not it
  goes again. If that cannot be read, or it was going out when the app stopped, a sell
  of part of a bag is left to you, and automatic exits turn off for that copy, since it
  could otherwise sell twice.
- **Slippage failures no longer stop copying.** Settings › Auto re-arm has a switch if
  you want them to count toward a pause.
- **A retry only sells the copy it is owed from:** not what another follow holds in the
  same wallet, not a re-buy made after the leader sold, and not a wallet you have since
  switched to.
- **Slow migrations.** A sell waiting on a coin's migration moves to that retry after
  10 minutes instead of stopping.
- **A stalled connection is noticed in under a minute.** If the stream goes quiet on
  an open connection, the app reconnects and catches up. If one wallet's feed misses
  a trade, the routine check finds it and resubscribes every wallet.
- **Totals stay whole.** The result, the win count, the chart and a follow's loss stop
  keep counting trades after old rows are trimmed, and the buy of a coin you still hold
  is never trimmed.
- **Keep this computer awake**, on by default while something is running. A closed
  lid or a manual Sleep still wins.
- **Close to tray**, with a notification when it happens.

## Wallet

- **Press your balance, top right,** for a card with the address, balance, refresh
  and send.
- **Fixed:** a stale balance in the top bar that could make a deposit look missing.
- **Wallet password (optional).** Encrypts your keys on disk and asks before sends,
  withdrawals, exports and raising your caps. Two costs: after a crash or restart
  nothing signs until you unlock, including exits, and if you lose both the password
  and the recovery key, those funds are gone for good. Krypt cannot recover them.

## Easier to use

- Settings shows the basics first; everything else is under Advanced.
- Plainer words on setup, Wallet and API keys.
- New guides: Install, and a Checklist from getting SOL to going live. The other
  guides were re-recorded to match.

## AI connection

- A new **Full control** level and research tools, inside a ceiling you set. It can
  never touch fees, keys, withdrawals or RPC settings.

## Known limits

- With Parsed Streams on, a stalled connection is only caught by the routine check,
  which can take several minutes.
- A single wallet's feed dying alone can still miss one trade before the routine check
  finds it. Buys that old are not copied.
- Whether a Solana sell landed is read from your RPC. If the RPC is more than two minutes
  behind, a sell that landed can read as not landed, and go again. On other chains a
  sent but unread sell of part of a bag is always left to you.
- A computer asleep for over an hour in the middle of a send wakes to that sell left to
  you, with an alert, even if nothing was wrong.
- Follows likely to buy the same coin are still safest on separate wallets.
- A retried sell goes out whenever it finally can, at that moment's price, without
  checking whether the leader has bought back in.
- A copy whose failed sell was handed back to you stays out of automatic exits until
  the tokens leave the wallet.
- Slippage failures are not capped. On a fast coin, each one that reaches the chain can
  cost a network fee, however many there are.
