// Put candidate wallets on the Follow page as PAPER configs, and on the
// smart-wallet watchlist, by editing the app's data files.
//
// Run this with the app CLOSED. The app holds both files in memory and
// rewrites copytrade.json on every paper trade, so an edit made while it runs
// is overwritten within minutes. The script refuses when it sees the app.
//
// Usage:
//   node scripts/analysis/copy-candidates-follow.mjs --wallets Addr1,Addr2 [--label "copy-candidate 10-27"] [--size 0.1]
//
// Every config is born paper, 0.1 SOL a copy, half-sell exit at 50 %, the
// shipped loss stops; change anything on the Follow page afterwards. Nothing
// here can arm a live follower.
import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';

const args = process.argv.slice(2);
const argOf = (k, d) => {
  const i = args.indexOf(k);
  return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : d;
};
const wallets = (argOf('--wallets', '') || '').split(',').map((s) => s.trim()).filter(Boolean);
const labelPrefix = argOf('--label', 'copy-candidate');
const size = Number(argOf('--size', '0.1'));
if (!wallets.length) {
  console.error('need --wallets Addr1,Addr2');
  process.exit(2);
}
const dataDir = path.join(process.env.APPDATA ?? '', 'Krypto Copy');

function appRunning() {
  try {
    const out = process.platform === 'win32' ? execSync('tasklist', { encoding: 'utf8' }) : execSync('ps -A', { encoding: 'utf8' });
    return /Krypto (Bot|Mirror|Copy)/i.test(out);
  } catch {
    return false;
  }
}
if (appRunning()) {
  console.error('The app is running. Close Krypto Mirror first, then run this again; it would overwrite the edit otherwise.');
  process.exit(1);
}

const writeAtomic = (file, data) => {
  fs.writeFileSync(`${file}.tmp`, data, 'utf8');
  fs.renameSync(`${file}.tmp`, file);
};

// Follow page: paper configs cloned from the shipped defaults.
const copyFile = path.join(dataDir, 'copytrade.json');
const book = JSON.parse(fs.readFileSync(copyFile, 'utf8'));
let added = 0;
for (const wallet of wallets) {
  if (book.configs.some((c) => c.wallet === wallet && (c.chain ?? 'solana') === 'solana')) {
    console.log(`${wallet.slice(0, 8)}: already followed`);
    continue;
  }
  const now = Date.now();
  book.configs.unshift({
    id: `cp_${now.toString(36)}_${book.configs.length + 1}`,
    chain: 'solana',
    walletId: null,
    wallet,
    label: `${labelPrefix} ${wallet.slice(0, 8)}`,
    enabled: true,
    mode: 'paper',
    sizing: 'fixed',
    sizeValue: size,
    maxTradeSol: size,
    minLiquidityUsd: null,
    maxMarketCapUsd: null,
    minKryptScore: null,
    onlyPumpfun: false,
    minMarketCapUsd: null,
    minLeaderSol: null,
    maxLeaderSol: null,
    minTokenAgeSec: null,
    maxTokenAgeSec: null,
    maxBuysPerToken: null,
    blockedMints: null,
    blockedCreators: null,
    minLeaderSellPct: 50,
    exitTrailingPct: null,
    delayMs: 0,
    maxSlippagePct: 15,
    copySells: true,
    dailyLossLimitSol: 0.3,
    dailyTradeLimit: 20,
    maxCopiesPerMinute: 10,
    walletLossStopSol: 0.4,
    direction: 'copy',
    exitTakeProfitPct: null,
    exitStopLossPct: null,
    exitMaxHoldMin: 30,
    fomoSource: null,
    fomoMinWallets: null,
    fomoWindowSec: null,
    fomoTopN: null,
    fomoCrowdExitPct: null,
    fomoTopSort: null,
    fomoWallets: null,
    createdAt: now,
    lossStopFrom: now,
    pausedReason: null,
    pausedAt: null,
  });
  added += 1;
  console.log(`${wallet.slice(0, 8)}: paper follow added (${size} SOL a copy, half-sell exit)`);
}
if (added) writeAtomic(copyFile, JSON.stringify(book, null, 2));

// Watchlist: the same wallets as smart-money pins.
const watchFile = path.join(dataDir, 'watchlist.json');
let list = [];
try {
  list = JSON.parse(fs.readFileSync(watchFile, 'utf8'));
} catch {
  list = [];
}
let pinned = 0;
for (const wallet of wallets) {
  if (list.some((w) => w.address === wallet)) continue;
  list.push({ address: wallet, label: `${labelPrefix} ${wallet.slice(0, 8)}`, addedAt: Date.now() });
  pinned += 1;
}
if (pinned) writeAtomic(watchFile, JSON.stringify(list, null, 2));
console.log(`done: ${added} follow configs added, ${pinned} watchlist pins added. Start the app to see them.`);
