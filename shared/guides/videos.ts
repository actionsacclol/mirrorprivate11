// ───────────────────────────────────────────────────────────
// The tutorial videos (2026-10-25): pure data, no window, no fs.
//
// Each guide is one short narrated screen recording of THIS app, made by
// scripts/tutorials/record.mjs from a storyboard that drives a clean
// profile, with the narration spoken by Krypt Voice (Krypt Studio's local
// Kokoro-82M engine). The files ship outside the asar as
// resources/guides/videos/<id>.mp4 (H.264/AAC 1080p), <id>.vtt (captions)
// and <id>.jpg (poster), served to the renderer at
// krypt-guide://v/<id>.<mp4|jpg> (electron/system/guideVideos.ts, with
// range requests so seeking works).
//
// `lines` is the narration, in order: it is what the voice says, what the
// captions show, and the written guide under the player. `cues` are the
// seconds each line starts and ends in the finished video, written by the
// recorder; a video with durationSec null is not recorded yet, and the
// Guides page shows it as "Coming soon" with its written steps.
// ───────────────────────────────────────────────────────────

export interface GuideVideo {
  /** File stem: resources/guides/videos/<id>.mp4 / .vtt / .jpg */
  id: string;
  title: string;
  /** One line under the title on the cards. */
  description: string;
  /** Whole seconds; null = not recorded yet (no player, "Coming soon"). */
  durationSec: number | null;
  /** [startSec, endSec] per line, in the video. Empty until recorded. */
  cues: Array<[number, number]>;
  /** The narration, one caption per entry. */
  lines: string[];
}

export type ReadyGuideVideo = GuideVideo & { durationSec: number };

/** The scheme + host the main process serves the videos folder under. */
export const GUIDE_VIDEO_SCHEME = 'krypt-guide';
export const GUIDE_VIDEO_HOST = 'v';
export const GUIDE_VIDEO_ORIGIN = `${GUIDE_VIDEO_SCHEME}://${GUIDE_VIDEO_HOST}`;
/** Files the protocol will serve: <id>.<ext>, nothing else (no folders, no other types). */
export const GUIDE_VIDEO_FILE = /^([a-z0-9][a-z0-9-]{0,63})\.(mp4|vtt|jpg)$/;

/** The guide a new install is pointed at first. */
export const QUICKSTART_VIDEO = 'quickstart';

/** Shown under the videos and on About: the voice is Kokoro-82M (Apache-2.0) through Krypt Voice. */
export const VIDEO_CREDIT = 'Narration: Krypt Voice (Kokoro-82M, Apache-2.0), recorded with Krypt Studio.';

export function videoUrls(id: string): { video: string; poster: string; captions: string } {
  return {
    video: `${GUIDE_VIDEO_ORIGIN}/${id}.mp4`,
    poster: `${GUIDE_VIDEO_ORIGIN}/${id}.jpg`,
    captions: `${GUIDE_VIDEO_ORIGIN}/${id}.vtt`,
  };
}

export function isReady(v: GuideVideo): v is ReadyGuideVideo {
  return v.durationSec !== null && v.durationSec > 0;
}

/** "2:35" */
export function fmtVideoDuration(sec: number | null): string {
  if (sec === null) return '';
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

/** The line being spoken at `t` seconds, or -1. */
export function cueAt(v: GuideVideo, t: number): number {
  for (let i = 0; i < v.cues.length; i++) {
    const [s, e] = v.cues[i];
    if (t >= s && t < e + 0.35) return i;
  }
  return -1;
}

export const GUIDE_VIDEOS: GuideVideo[] = [
  {
    id: 'quickstart',
    title: 'Start here: a quick tour of Krypto Mirror',
    description: 'First run, the Home checklist, Discover, a wallet profile, your first follow on paper, and where the record shows up.',
    durationSec: 127,
    cues: [[0.97, 9.4], [10.11, 14.32], [17.5, 22.68], [23.39, 32.13], [32.83, 38.02], [38.73, 48.38], [51.29, 57.82], [60.72, 67.15], [67.85, 74.58], [75.72, 82.13], [86.94, 91.56], [97.23, 103.88], [104.8, 110.02], [111.45, 124.87]],
    lines: [
      'Welcome to Krypto Mirror. In the next two minutes you will set it up, find a trader, and follow them on paper, which means practice with pretend money.',
      'On first run, pick your language, read the short summary of the terms and agree.',
      'If a friend referred you, paste their Solana address here. Otherwise leave it blank and continue.',
      'API keys are optional. The app works with no keys at all, and a free Helius key makes it faster. There is a separate guide for keys, so skip for now.',
      'You do not need a wallet to follow on paper. Choose Later; the wallet guide covers going live.',
      'Two things to remember. The book button at the top right opens these guides. Your balance, next to it, opens your wallet. Every follow starts on paper, so press Start following.',
      'This is Home. The checklist walks you through setup, and your paper and live results appear here once copies close.',
      'Discover ranks wallets by what a follower would have kept, after the delay and the fees, not by what the trader made.',
      'The board is allowed to say nobody this week. That is honest: on average, copying loses, and the score ranks the least bad.',
      'Open a wallet to read its profile. The verdict leads with what the chain says about copying them, and the cautions say why.',
      'Follow opens the Follow page. Pick a size, read what will happen, and start on paper.',
      'Following shows every follow as a card: pause it, edit it, or switch it to Live later, when the paper record earns it.',
      'Activity lists every copy and every skip, with its reason. Nothing here cost real money.',
      'That is the whole loop: discover, follow on paper, watch the record. Press the book button for the rest: the checklist for real money, every follow setting, checking any wallet, keys, the wallet password, leaving it running, and your own AI.',
    ],
  },
  {
    id: 'install',
    title: 'Install the app',
    description: 'Where to download it, the warning Windows or a Mac shows and how to get past it, and your first minute in the app.',
    durationSec: 85,
    cues: [[0.95, 8.64], [9.35, 20.51], [21.23, 24.68], [27.16, 38.83], [39.55, 44.18], [44.89, 48.26], [50.99, 56.54], [57.26, 62.95], [64.68, 71.89], [72.6, 80.05]],
    lines: [
      'This guide puts Krypto Mirror on your computer. Download it only from krypt.cc/mirror. A copy from anywhere else could steal your money.',
      'On Windows, open the file you downloaded. Windows may warn you: Windows protected your PC. It says this about apps without a paid publisher certificate, and this app does not have one yet.',
      'Press More info, then Run anyway. Then follow the installer.',
      'On a Mac, open the file and drag Krypto Mirror into Applications. The Mac refuses to open it the first time. Go to System Settings, then Privacy and Security, scroll down, and press Open Anyway.',
      'On Linux, install the deb file, or allow the AppImage file to run and open it.',
      'The first time it opens, pick your language and agree to the terms.',
      'The other screens are optional. You can skip the keys and the wallet, and practice first with pretend money.',
      'The last screen shows two things to remember. The book button at the top right opens these guides, any time.',
      'And your balance, beside it, opens your wallet: your address, your balance, and Send or Withdraw. It says No wallet until you make one.',
      'That is it. Next, watch Start here and practice on Paper. When you want to use real money, the Checklist guide shows how to get SOL.',
    ],
  },
  {
    id: 'checklist',
    title: 'Checklist: get SOL and go live',
    description: 'Optional. The steps for your first real money: practice, make a wallet, back it up, buy SOL, send it to the app, set limits and go live.',
    durationSec: 128,
    cues: [[0.96, 8.52], [9.22, 20.43], [21.13, 26.63], [27.34, 37.99], [38.81, 52.27], [52.98, 56.79], [59.27, 69.23], [69.94, 79.94], [80.65, 89.05], [91.82, 101.1], [105.83, 114.67], [115.37, 123.18]],
    lines: [
      'This checklist is optional. Nothing in the app asks for it, and you never have to go live. Use it the first time you want to put real money in.',
      'One. Practice first. Follow a trader on Paper and watch it for a week. Paper uses pretend money at real prices. If it loses on Paper, expect it to lose with real money too.',
      'Two. Make a wallet just for this app, never your main one. Open Wallet and press Create wallet.',
      'Three. Back it up before you add money. Export all saves your key in a file. Keep that file off this computer and show it to nobody. Nobody can get a lost key back, not even Krypt.',
      'Four. Buy SOL. It is the coin Solana runs on, and what your copies spend. Buy it on an exchange such as Coinbase, Kraken or Binance, or in a wallet app such as Phantom. Some make you wait a few days before you can send it.',
      'Five. Press your balance at the top right, then copy your address.',
      'Six. On the exchange, choose Withdraw or Send, then SOL, then the Solana network. Paste your address. The network matters: money sent on the wrong one can be lost.',
      'Send a small amount first. It usually arrives within a minute or two. Press refresh on the wallet card to see it. 0.1 to 0.5 SOL is plenty to test with.',
      'Seven. Set your limits, if you want any. They are all off unless you set them. Wallet has the most per trade, and each follow has its own loss stop.',
      'Eight. Go live. Switch the top bar to Live, then switch the follow to Live on its card. Each one asks you to confirm, and real money moves only when both are on.',
      'Nine. Keep watch at first. Activity shows every copy and every skip. Most memecoins go to zero, so only use money you can afford to lose.',
      'To take money out, press your balance, then Send / Withdraw. And nobody from Krypt will ever ask for your key. Anyone who does is trying to rob you.',
    ],
  },
  {
    id: 'follow-settings',
    title: 'Following a wallet: every setting',
    description: 'The Follow page from top to bottom: sizing, limits, strategy and watch-only, your own exits including creator sells and graduation, which trades and coins to copy, trading hours, execution, and the card on Following.',
    durationSec: 164,
    cues: [[0.95, 7.59], [8.3, 14.94], [15.87, 23.18], [31.32, 35.24], [37.57, 46.47], [47.17, 48.68], [49.39, 61.21], [61.91, 68.2], [70.91, 78.21], [82.17, 91.56], [92.27, 99.94], [100.69, 109.93], [110.63, 120.61], [124.61, 130.87], [133.67, 140.74], [141.93, 145.34], [146.92, 152.87], [153.58, 160.7]],
    lines: [
      'Follow a wallet opens the Follow page. Every control is on this one page; the advanced ones unfold further down.',
      'Paste a Solana address, a pump.fun username or a profile link. The page shows what the Scout has on record for them.',
      'How much per copy: a fixed amount, or a share of each of their trades with a cap. Their buys too small for a live copy are skipped.',
      'What will happen says it in words, from the exact settings that will be saved.',
      'Limits. Stop for the day after a loss, pause the wallet after a run of losses, or cap the copies a day. All of them stay off unless you switch them on.',
      'Open Advanced for the rest.',
      'Strategy: Copy mirrors them. Reverse sells what they buy. Convergence buys when several wallets buy one coin, and has its own guide. Watch only never trades: it tells you about every trade they make.',
      'Your own exits run on top of their sells: take profit, stop loss, a trailing stop, and a longest hold.',
      'Two more exits: sell if the coin’s creator sells a share of their own bag, and sell when the coin graduates from pump’s curve.',
      'Your AI decides: an AI app connected on the AI page can get the final say on each buy, each sell, or both. It can only narrow what the follow does, never buy more.',
      'Their sells: a trim under this share of their bag is not mirrored, because each trim pays its own fee. Their last sell is always copied.',
      'Follow them out another way: if they send the coin to another wallet, sell it for a stablecoin, or swap it for another token, the same share of your copy is sold.',
      'Which trades: size bounds, one entry per coin, one position per coin across all your follows, and trading hours, so copies only happen while you are around.',
      'Which coins: minimum liquidity, market cap, coin age, a minimum Krypt score, or pump.fun coins only.',
      'Execution: an optional delay, maximum slippage, a per-minute burst wall, and which of your wallets signs the copies.',
      'Never copy these: coins and creators this follow must skip.',
      'Start on paper. Nothing is bought, and every simulated trade pays what a real one would, both ways.',
      'On Following, the card pauses, edits or stops the follow. The Live switch asks before arming, and tells you which limits it has.',
    ],
  },
  {
    id: 'discover-check',
    title: 'Discover, Check and the wallet profile',
    description: 'Reading the board, the fee floor, Week total and the chips, checking any wallet or pump.fun username over its newest trades or a whole week, naming it, and what a profile’s verdict means.',
    durationSec: 122,
    cues: [[0.96, 8.25], [9.16, 15.64], [22.21, 33.71], [34.41, 41.55], [42.25, 49], [52.11, 59.36], [60.23, 68.56], [71.5, 76.67], [80.53, 87.5], [88.22, 93.44], [98.14, 103.72], [112.95, 118.37]],
    lines: [
      'Discover is the board. Best to copy ranks on the lower bound of what a follower kept, so one lucky week does not top the list.',
      'Change the window and the copy size. The fee floor moves with the size, and every copier figure is read against it.',
      'The other views: copier return, Week total, which adds up every copy of the week, most profitable for the trader, most active, pump.fun’s own leaderboard, your saved wallets, and the test.',
      'Chips flag what the chain says: bots, creators, bundles, wash trades, and wallets too fast for the live feed to price.',
      'This board’s own record shows how earlier picks actually did. Past results only; none of it says who wins next.',
      'Check takes any wallet: an address, a pump.fun username or a profile link. The replay starts at once, sized like a follow.',
      'Newest 30 trades is the quick read. Whole week prices every closed trade of the last seven days, and shows its credit ceiling before it starts.',
      'The replay copies their trades at chain prices, late and with every fee, and trades nothing.',
      'With ten copies or more it ends in a verdict: whether copying lost, or made money only through its best few copies.',
      'Name this wallet adds it to your address book, so your name for it shows everywhere the wallet does.',
      'A profile leads with the chain: what copies would have kept per trade, then what the live feed saw.',
      'Read the cautions before following anyone. Follow from here opens the Follow page at the same size.',
    ],
  },
  {
    id: 'wallet-live',
    title: 'Your wallet and going live',
    description: 'Making a wallet just for this app, its backup, the wallet card and switcher, safety rails, the two switches that make a follow live, and pump.fun accounts.',
    durationSec: 131,
    cues: [[0.95, 10.67], [12.76, 21.61], [22.32, 31.13], [31.85, 45.75], [49.67, 57.82], [60.98, 66.06], [70.78, 78.41], [84.53, 96.85], [100.51, 108.31], [109.35, 121.21]],
    lines: [
      'You only need a wallet to go live. Open Wallet and press Create wallet. This makes a new wallet just for this app. Its key is encrypted on this computer and never leaves it.',
      'Back up the key before you add money. Nobody, including Krypt, can get it back for you. Only put in money you can afford to lose, and keep your main wallet out of it.',
      'Send SOL to the deposit address. 0.1 to 0.5 SOL is plenty to test with. The Checklist guide shows how to buy SOL and send it.',
      'Your balance at the top right opens the wallet card: address, balance, refresh and send. From there, the switcher lists every wallet. Follows set to Active wallet copy with the ticked one, and a switch waits until their live copies have closed.',
      'Safety rails are yours to set, and they all start off: a maximum per trade, a session loss cap, and a stop after losses in a row.',
      'Going live is two switches. First the top bar, Paper to Live, which asks you to confirm.',
      'Then the follow itself: on its card, switch it to Live and arm it. It asks first, and if you set a live cap, a size above it is caught here.',
      'If a safety rail trips, Live turns off, but open copies still sell on their exits, so nothing is stranded. If you switch to Paper yourself, exits stop too: the card says so, and you can sell from the Wallet page.',
      'Live copies pay Krypt’s fee on every buy and every sell, on-chain in the same transaction. Start small; most memecoins go to zero.',
      'pump.fun accounts are optional. New wallet plus account makes a fresh wallet with its own pump.fun account in one step. Live copies can call out what they buy, and pump pays callers USDC rewards.',
    ],
  },
  {
    id: 'api-keys',
    title: 'Getting your API keys',
    description: 'What an API key is, where to get the free Helius and Jupiter keys, what each one changes, and where they all live in Settings.',
    durationSec: 90,
    cues: [[0.97, 11.79], [12.49, 19.8], [20.52, 28.96], [29.67, 34], [36.48, 42.26], [43.05, 50.01], [50.73, 61.15], [61.85, 69.74], [70.47, 78.67], [80.96, 88.03]],
    lines: [
      'Krypto Mirror runs with no keys at all. An API key is a free pass to a data service, and it makes the app faster. Every key lives in one place: Settings, under API keys.',
      'Helius first. It is the biggest speed upgrade: trades are heard sooner and copies land faster, and the free plan is enough.',
      'Get a free key at helius.dev: create an account, open the dashboard, and copy the API key. You can paste the key itself or the whole link.',
      'Paste it here and save. The app shows only the last four characters afterwards.',
      'Check the key asks Helius directly and tells you whether it works. The key goes to Helius and nowhere else.',
      'The meter under it tracks this month’s credits and the share the app may spend on chain reads. The free plan gives a million a month.',
      'Jupiter is free too. It gives the prices for your buys and sells. Without a key the app uses an old Jupiter address that is being shut down. Make a key at portal.jup.ag.',
      'More keys unfolds the optional ones. Birdeye adds charts shorter than a minute, holder lists and trade history. Everything else works without it.',
      'GIPHY and Tenor only matter for callout GIFs on pump.fun. Alchemy, for Robinhood Chain, is set under Advanced, in EVM chains.',
      'Keys stay on this computer, and each one goes only to its own service, never to Krypt. Replace or remove one any time.',
    ],
  },
  {
    id: 'wallet-password',
    title: 'The wallet password',
    description: 'Encrypt your keys with a password only you know: the recovery key, savings wallets, what asks for it, and locking up.',
    durationSec: 92,
    cues: [[0.96, 11.68], [12.38, 16.45], [17.16, 26.99], [27.69, 31.6], [32.34, 40.18], [46.09, 54.2], [54.9, 63.23], [63.94, 73.28], [80.81, 88.6]],
    lines: [
      'The wallet password encrypts your keys with a password only you know. A program that copies your wallet files gets nothing it can use without it. It is off until you turn it on, here in Settings.',
      'Set a password. Long beats clever: a few random words is best.',
      'You get a recovery key, shown once. Write it on paper and keep it away from this computer. Nobody can open your wallets without the password or this key, and that includes Krypt.',
      'Type the last group back to prove you saved it, and your keys are encrypted.',
      'Every wallet starts as Can auto-trade. It opens when you unlock at launch, and then your follows can sign, so a sell is never stranded.',
      'Switch a wallet to Savings and it stays locked even then. It opens only for the moment you type the password, so it cannot follow or auto-trade.',
      'Sends, withdrawals, exporting a key and raising a safety limit now ask for the password every time. Ordinary buys and sells do not.',
      'Stop trading and lock shuts everything at once. While locked nothing signs, and live positions have no exits, so unlock before you walk away from open trades.',
      'Unlocking asks for the password. If you forget it, the recovery key gets you back in. Lose both and the keys are gone, so keep that paper safe.',
    ],
  },
  {
    id: 'auto-rearm',
    title: 'Leaving it running: auto re-arm',
    description: 'What stops live trading, what comes back on by itself, the switches for each, how to keep something off, and keeping the computer awake.',
    durationSec: 100,
    cues: [[0.97, 12.01], [12.72, 25.11], [26.8, 33.13], [34.19, 45.33], [46.05, 53.89], [55.84, 64.29], [65.02, 69.14], [73.8, 83.17], [84.52, 96.27]],
    lines: [
      'Left running, a bot meets bad minutes: a busy network, a slow connection, a coin that will not trade. Auto re-arm, in Settings under Advanced, decides what comes back on by itself.',
      'Failed trades. After three in a row, a follow pauses, then comes back on. The wait starts at five minutes and doubles, up to an hour. This is on by default. Slippage failures do not count, unless you turn that on.',
      'pump.fun upgrades switch live off for a moment. It comes back once the app has checked the upgrade against real launches.',
      'Loss limits are different. By default they stay off until you turn live back on. You can change that, but read the warning: each comeback starts the loss count again, so it can lose your limit again.',
      'A follow’s own loss stop works the same way. App restarts are off by default too. Turned on, whatever was running comes back when the app opens.',
      'These set how many failures pause it, the first wait, and how many comebacks in a row before it stays off. A trade that lands starts that count again.',
      'A paused follow says why, and when it comes back. Keep it off cancels that.',
      'A pause, a loss limit or an upgrade never stops selling. Your own switch to Paper, the kill switch and locking do stop automatic exits, and they always win.',
      'Two more things for long runs. A failed sell keeps trying by itself until it sells. And Keep this computer awake stops it going to sleep by itself while something is running. Closing a laptop lid still sleeps it.',
    ],
  },
  {
    id: 'convergence',
    title: 'Convergence: following a crowd',
    description: 'Buying when several wallets buy the same coin: building the crowd from a Discover ranking, wallets you pick or an address-book tag, its rules, and why it starts on paper.',
    durationSec: 131,
    cues: [[0.95, 9.61], [10.32, 18.66], [19.37, 27.48], [28.18, 36.13], [36.84, 44.43], [50.32, 57.67], [58.37, 64.4], [65.36, 69.28], [72.3, 83.61], [85.2, 91.3], [95.27, 102.14], [109.01, 115.99], [122.1, 126.57]],
    lines: [
      'Convergence follows a crowd instead of one wallet. It buys when several wallets from a set buy the same coin within a few minutes. The crowd is the signal.',
      'Start on Discover. The ranking on screen is the crowd that Follow the crowd builds. Week total adds up what copies of every trade made this week.',
      'Scan the week’s winners first, so Week total has a full record to rank. It reads the coins that went up from the chain, inside your credit allowance.',
      'Follow the crowd opens a paper draft: the top twenty-five wallets of this ranking, re-read every thirty seconds as the record moves.',
      'The crowd panel sets which wallets count: the ones you follow, your saved wallets, tracked wallets, a Discover ranking, or a list you pick.',
      'Buy when: by default, three of them buy the same coin within three minutes. More wallets is a stronger signal, and a later entry.',
      'Get out when half of the wallets that triggered the buy have sold, or sooner, on your own exits under Advanced.',
      'What will happen says it in words, from the exact settings that will be saved.',
      'A warning: in this app’s measurements over 9.3 million trades, the crowd arrived late, and the more wallets had bought, the worse the coin did an hour later. So convergence starts on paper.',
      'On Following, a crowd’s card says how many wallets it is listening to, and lists its rules in plain words.',
      'To choose the crowd yourself, tick wallets on Discover, then Converge on these. The draft lists exactly the wallets you picked.',
      'Or tag wallets in your address book. Pick a tag, and Converge on that tag follows its Solana wallets as one crowd.',
      'However you build it, watch the paper record for a week before anything goes live.',
    ],
  },
  {
    id: 'rpc-speed',
    title: 'Speed: your own RPC',
    description: 'Where a copy waits on the network, and the endpoint for each step: the socket that hears your follows, the execution lane, extra feeds, measuring them, and the Helius switches.',
    durationSec: 136,
    cues: [[0.95, 10.23], [16.39, 26.91], [27.62, 37.43], [38.14, 46.1], [46.81, 55.8], [56.52, 66.87], [67.58, 76.78], [77.49, 84.05], [87.2, 97.25], [97.95, 110.07], [110.79, 121.87], [122.58, 133.5]],
    lines: [
      'Most people never need this guide. A copy is only as fast as the endpoints behind it, and they are set in Settings, under Advanced, in Solana RPC.',
      'Out of the box it all runs on free public endpoints. They work, but they are shared with everyone and rate limited, and one public socket loses about a fifth of its events under load.',
      'This WebSocket hears the wallets you follow. Without a Helius key, every copy starts with a message on this socket, so a private one from your provider is the first upgrade.',
      'Extra WebSockets race it on the launch feed. They all subscribe at once and the first to arrive wins, so every free one you add cuts the loss.',
      'The HTTP endpoint does the bulk reads: mint checks, balances and holders. Lots of calls, none of them on the clock, so a free one is usually fine.',
      'The one that matters most is the execution endpoint. Live buys and sells, their confirmations, fee estimates, and reading back each trade a followed wallet makes all go here.',
      'Paste any paid provider: QuickNode, Triton, Shyft, or your own validator. Set, it wins over a Helius key, and the bulk reads stay on the cheaper endpoint.',
      'Save, then press Measure. It makes five round trips to each saved endpoint, and the median is what an order will meet.',
      'Read the line under each one. An endpoint that is fast only because it is behind the chain says how many slots behind, so a quick, stale answer cannot pass for a good one.',
      'With a Helius key, Parsed Streams hears your followed wallets about 120 milliseconds sooner, with pump buys already decoded. It is free on every plan, at one credit per transaction they make.',
      'The Helius feed socket joins the race, and came first 92 percent of the time when measured. At firehose rates it costs about 800 thousand credits a day, so it is for paid plans.',
      'Changes apply the next time the engine starts. And speed narrows the gap behind the wallet you copy, it never closes it: a copy still fills after their trade, at the price that is left.',
    ],
  },
  {
    id: 'ai-desk',
    title: 'Your AI on the desk',
    description: 'Connect Claude Code, Codex, Cursor or another MCP app, choose how far it reaches — research, paper, live or full control — and let it decide a follow’s buys and sells.',
    durationSec: 185,
    cues: [[0.97, 12.02], [13.75, 18.55], [22.73, 35.75], [37.94, 46.86], [52.57, 61.36], [69.39, 82.33], [83.06, 92.69], [94.24, 104.65], [109.65, 119.99], [121.04, 127.39], [133.04, 140.09], [145.59, 152.61], [157.11, 164.64], [174.5, 180.47]],
    lines: [
      'The AI page connects an AI app you already use, such as Claude Code, Codex or Cursor, over MCP. It can research wallets, trade on paper, and, if you allow it, run your live follows.',
      'Switch the connection on. It opens a port on this computer only, and starts read only.',
      'Choose how far it reaches. Read only already runs the research tools: Scout scans, wallet checks, replays and backtests. Paper trading adds simulated trades, and live trading spends real funds within your limits.',
      'Full control goes further. The AI can switch live follows on and widen them, delete follows, sell everything, and switch the app between paper and live.',
      'Pick your AI app, then copy the command or the config into it. It carries a token, a password for this app, so the screen masks it. Never paste it into a chat.',
      'Then paste this prompt into the AI app. It starts the loop that hears your follows and answers their questions, and between them it can research wallets for you. The AI app has to keep running, and each event it reads costs its own tokens.',
      'Limits cap what the AI may spend on its own buys. Below full control, a follow’s copies keep their own size: the AI can only shrink or skip them. Sells are never capped.',
      'With full control, the follow ceiling bounds every live follow the AI switches on or widens: the most per copy, the most copies a day, and the loss that stops it for the day.',
      'Whatever you allow, the AI can never touch the fee, see or move your keys, send funds anywhere, or change its own access and limits. It asks; the app checks and builds every trade.',
      'Choose which follows it decides on the Follow page, under Advanced: Your AI decides each buy, each sell, or both.',
      'Set how long it has to answer. Past that, the follow’s own rule decides, and for a buy you choose: skip it, or copy anyway.',
      'Stop-losses do not wait for the AI unless you say so. An AI that is thinking, or offline, never holds you in a falling coin.',
      'Back on the AI page: the follows it decides, the questions waiting on it, and every decision, with the answer and how long it took.',
      'Start it on paper trading, and read its decisions for a week before you give an AI live trading or full control.',
    ],
  },
];