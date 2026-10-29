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
    title: 'Start here: Krypto Mirror in three minutes',
    description: 'First run, the Home checklist, Discover, a wallet profile, your first follow on paper, and where the record shows up.',
    durationSec: 113,
    cues: [[0.97, 6.81], [7.53, 12.07], [15.05, 20.23], [20.95, 29.69], [30.41, 35.6], [36.32, 41.83], [42.74, 49.27], [52.16, 58.59], [59.31, 66.04], [67.25, 73.66], [75.18, 79.81], [85.79, 92.44], [93.48, 98.7], [100.19, 110.78]],
    lines: [
      'Welcome to Krypto Mirror. In the next three minutes you will set it up, find a wallet, and follow it on paper.',
      'On first run, pick your language, then read the short summary of the terms and agree.',
      'If a friend referred you, paste their Solana address here. Otherwise leave it blank and continue.',
      'API keys are optional. The app works with no keys at all, and a free Helius key makes it faster. There is a separate guide for keys, so skip for now.',
      'You do not need a wallet to follow on paper. Choose Later; the wallet guide covers going live.',
      'Every follow starts on paper, with every fee charged, so the record is honest. Start following.',
      'This is Home. The checklist walks you through setup, and your paper and live results appear here once copies close.',
      'Discover ranks wallets by what a follower would have kept, after the delay and the fees, not by what the trader made.',
      'The board is allowed to say nobody this week. That is honest: on average, copying loses, and the score ranks the least bad.',
      'Open a wallet to read its profile. The verdict leads with what the chain says about copying them, and the cautions say why.',
      'Follow opens the Follow page. Pick a size, read what will happen, and start on paper.',
      'Following shows every follow as a card: pause it, edit it, or switch it to Live later, when the paper record earns it.',
      'Activity lists every copy and every skip, with its reason. Nothing here cost real money.',
      'That is the whole loop: discover, follow on paper, watch the record. The other guides cover API keys, every follow setting, checking any wallet, going live, and connecting your own AI.',
    ],
  },
  {
    id: 'api-keys',
    title: 'Getting your API keys',
    description: 'Helius, Jupiter and Birdeye: where each key comes from, what it changes, and the one place in Settings they all live.',
    durationSec: 89,
    cues: [[0.97, 9.99], [10.69, 18], [18.73, 28.11], [28.82, 33.15], [35.8, 41.59], [42.41, 49.36], [50.07, 61.52], [62.24, 68.6], [69.37, 76.75], [79.52, 86.42]],
    lines: [
      'Krypto Mirror runs with no keys at all. Keys make it faster and unlock a little more data. Every key lives in one place: Settings, under API keys.',
      'Helius first. It is the biggest speed upgrade: trades are heard sooner and copies land faster, and the free plan is enough.',
      'Get a free key at helius.dev: create an account, open the dashboard, and copy the API key. You can paste the key itself or the whole RPC URL.',
      'Paste it here and save. The app shows only the last four characters afterwards.',
      'Check the key asks Helius directly and tells you whether it works. The key goes to Helius and nowhere else.',
      'The meter under it tracks this month’s credits and the share the app may spend on chain reads. The free plan gives a million a month.',
      'Jupiter is free too. A key moves every quote off lite-api.jup.ag, which Jupiter is retiring, onto api.jup.ag. Make one at portal.jup.ag.',
      'Birdeye is optional: sub-minute price candles, holder lists and trade history. Everything else works without it.',
      'GIPHY and Tenor only matter for callout GIFs on pump.fun. Alchemy, for Robinhood Chain, is set under EVM chains.',
      'Keys are stored on this machine only, never sent to Krypt, and stripped from recordings. Replace or remove one any time.',
    ],
  },
  {
    id: 'follow-settings',
    title: 'Following a wallet: every setting',
    description: 'The Follow page from top to bottom: sizing, limits, strategy and watch-only, your own exits including creator sells and graduation, which trades and coins to copy, trading hours, execution, and the card on Following.',
    durationSec: 165,
    cues: [[0.96, 7.6], [8.32, 14.95], [16.17, 23.48], [31.7, 35.62], [37.96, 45.59], [47.87, 49.38], [50.09, 61.91], [62.63, 68.91], [71, 78.3], [83.11, 92.5], [93.23, 100.9], [101.61, 110.86], [111.8, 121.78], [125.14, 131.4], [134.47, 141.53], [143.35, 146.76], [148.42, 154.37], [155.08, 162.6]],
    lines: [
      'Follow a wallet opens the Follow page. Every control is on this one page; the advanced ones unfold further down.',
      'Paste a Solana address, a pump.fun username or a profile link. The page shows what the Scout has on record for them.',
      'How much per copy: a fixed amount, or a share of each of their trades with a cap. Their buys too small for a live copy are skipped.',
      'What will happen says it in words, from the exact settings that will be saved.',
      'Limits: stop for the day after losing this much, pause the wallet after a run of losses, and at most this many copies a day.',
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
      'On Following, the card pauses, edits or stops the follow. The Live switch asks before arming, and it is capped per trade and per day.',
    ],
  },
  {
    id: 'discover-check',
    title: 'Discover, Check and the wallet profile',
    description: 'Reading the board, the fee floor, Week total and the chips, checking any wallet or pump.fun username over its newest trades or a whole week, naming it, and what a profile’s verdict means.',
    durationSec: 137,
    cues: [[0.96, 8.25], [9.16, 15.64], [22.42, 33.91], [34.63, 41.77], [42.47, 49.22], [52.8, 60.04], [61.04, 69.38], [72.37, 77.54], [81.89, 88.86], [102.62, 107.84], [112.83, 118.42], [128, 133.43]],
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
    id: 'convergence',
    title: 'Convergence: following a crowd',
    description: 'Buying when several wallets buy the same coin: building the crowd from a Discover ranking, wallets you pick or an address-book tag, its rules, and why it starts on paper.',
    durationSec: 132,
    cues: [[0.96, 9.62], [10.33, 18.67], [19.39, 27.5], [28.21, 36.16], [36.88, 44.47], [50.4, 57.75], [58.47, 64.5], [65.47, 69.39], [72.43, 83.75], [85.42, 91.51], [95.52, 102.39], [109.79, 116.77], [122.87, 127.33]],
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
    id: 'wallet-live',
    title: 'Your wallet and going live',
    description: 'A dedicated hot wallet, its backup, the wallet switcher, safety rails, the two switches that make a follow live, and pump.fun accounts.',
    durationSec: 128,
    cues: [[0.97, 9.68], [13.07, 20.41], [21.14, 27.1], [28.71, 40.8], [45.54, 53.83], [57.41, 62.49], [67.38, 74.36], [81.22, 93.54], [97.25, 105.05], [106.19, 118.05]],
    lines: [
      'You only need a wallet to go live. Open Wallet and generate a dedicated hot wallet. Its key is encrypted by Windows and never leaves this computer.',
      'Back up the key before you fund it. Nobody, including Krypt, can recover it for you. Fund it with lunch money, never your main wallet.',
      'Send SOL to the deposit address. 0.1 to 0.5 SOL is plenty to test with.',
      'Your balance on the bar opens the wallet switcher: every wallet, its balance and its pump.fun name. Follows set to Active wallet copy with the ticked one, and a switch waits until their live copies have closed.',
      'Safety rails cap every live copy: a maximum per trade, a balance cap, a session loss cap, and a stop after losses in a row.',
      'Going live is two switches. First the top bar, Paper to Live, which asks you to confirm.',
      'Then the follow itself: on its card, switch it to Live and arm it. It asks first, and a size above your live cap is caught here.',
      'If a safety rail trips, Live turns off, but open copies still sell on their exits, so nothing is stranded. If you switch to Paper yourself, exits stop too: the card says so, and you can sell from the Wallet page.',
      'Live copies pay Krypt’s fee on every buy and every sell, on-chain in the same transaction. Start small; most memecoins go to zero.',
      'pump.fun accounts are optional. New wallet plus account makes a fresh wallet with its own pump.fun account in one step. Live copies can call out what they buy, and pump pays callers USDC rewards.',
    ],
  },
  {
    id: 'ai-desk',
    title: 'Your AI on the desk',
    description: 'Connect Claude Code, Codex, Cursor or another MCP app, choose how far it reaches, and let it decide a follow’s buys and sells.',
    durationSec: 148,
    cues: [[0.96, 11.89], [13.79, 18.59], [22.83, 32.89], [34.35, 43.14], [51.2, 61.48], [62.2, 71.19], [71.91, 79.55], [83.84, 90.19], [96.06, 103.11], [108.6, 115.63], [120.18, 127.71], [137.7, 143.27]],
    lines: [
      'The AI page connects an AI app you already use, such as Claude Code, Codex or Cursor, over MCP. It sees what your follows see, and on the follows you choose, it has the final say.',
      'Switch the connection on. It opens a port on this computer only, and starts read only.',
      'Choose how far it reaches: read only, paper trading, or live trading. Deciding a follow’s trades needs paper trading for paper follows, and live trading for live ones.',
      'Pick your AI app, then copy the command or the config into it. It carries a token, a password for this app, so the screen masks it. Never paste it into a chat.',
      'Then paste this prompt into the AI app. It starts the loop that hears your follows and answers their questions. The AI app has to keep running, and each event it reads costs its own tokens.',
      'Limits cap what the AI may spend on its own buys. A follow’s copies keep the follow’s own size: the AI can only shrink or skip them, and sells are never capped.',
      'Whatever you allow, the AI can never withdraw, change a setting, arm a follow, or see your key. It asks; the app checks and builds every trade.',
      'Choose which follows it decides on the Follow page, under Advanced: Your AI decides each buy, each sell, or both.',
      'Set how long it has to answer. Past that, the follow’s own rule decides, and for a buy you choose: skip it, or copy anyway.',
      'Stop-losses do not wait for the AI unless you say so. An AI that is thinking, or offline, never holds you in a falling coin.',
      'Back on the AI page: the follows it decides, the questions waiting on it, and every decision, with the answer and how long it took.',
      'Start it on paper trading, and read its decisions for a week before an AI ever touches a live follow.',
    ],
  },
];