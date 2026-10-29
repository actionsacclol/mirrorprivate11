// Following someone (2026-10-22): Home is where the app opens, and the
// Follow page (a pop-up wizard until 2026-10-24) is the one way in — from
// Home, Discover, a profile or Following, and Edit on a card opens it too.
// Read from source: the routes must be reachable, the page must save through
// copy:save on the shared derivation, offer sizing by their trade, never
// construct a live config, and the live switches on a follow's card must keep
// their rules.

import assert from 'node:assert';
import fs from 'node:fs';

let passed = 0;
const ok = (label) => {
  console.log(`  ok   ${label}`);
  passed += 1;
};
const read = (rel) => fs.readFileSync(new URL(rel, import.meta.url), 'utf8');

{
  const nav = read('../src/state/nav.tsx');
  assert.match(nav, /export type RouteId = 'home' \| 'discover' \| 'check' \| 'following' \| 'activity' \| 'wallet' \| 'ai' \| 'settings' \| 'follow' \| 'book';/, 'eight places (AI joined 2026-10-28), the Follow page and the address book');
  assert.match(nav, /export const ROUTES: RouteId\[\] = \['home', 'discover', 'check', 'following', 'activity', 'wallet', 'ai', 'settings'\];/, 'the Follow page is not a place on the bar');
  const app = read('../src/App.tsx');
  assert.match(app, /import \{ HomePage \} from '\.\/pages\/Home';/, 'Home is in the entry bundle');
  assert.match(app, /route: 'home'/, 'and the app opens on it');
  for (const r of ['discover', 'check', 'following', 'activity', 'wallet', 'ai', 'settings', 'follow', 'book']) {
    assert.match(read('../src/routeLoaders.ts'), new RegExp(`${r}: \\(\\) => import\\(`), `${r} has a loader`);
    assert.match(app, new RegExp(`route === '${r}' && <`), `${r} is rendered`);
  }
  const top = read('../src/shell/TopNav.tsx');
  for (const r of ['home', 'discover', 'check', 'following', 'activity', 'wallet', 'ai']) assert.match(top, new RegExp(`id: '${r}'`), `the bar links ${r}`);
  ok('Home is the landing page and every place is reachable from the bar');
}

{
  assert.ok(!fs.existsSync(new URL('../src/components/copy/FollowWizard.tsx', import.meta.url)), 'the pop-up is gone');
  assert.ok(!fs.existsSync(new URL('../src/components/copy/ConfigEditor.tsx', import.meta.url)), 'and so is the second editor');
  const page = read('../src/pages/Follow.tsx');
  assert.match(page, /window\.krypt\.copy\.save\(out as Partial<CopyConfig>\)/, 'saves through copy:save');
  assert.match(page, /followConfig\(addr, label, chain, sizing, sizing === 'fixed' \? fixedSol : pct, cap\)/, 'the config is the shared derivation, not page-local numbers');
  assert.match(page, /useState<number>\(start\?\.sizing === 'fixed' \? start\.sizeValue : SIMPLE_SIZES\[0\]\)/, 'a new follow defaults to the smallest size — the default live cap');
  assert.match(page, /\{ value: 'proportional', label: fomo \? '% of the trigger buy' : '% of their trade' \}/, 'sizing by their trade is offered at the start');
  assert.match(page, /editing \? cfg : \{ \.\.\.cfg, mode: 'paper', enabled: true \}/, 'a new follow is saved on paper');
  assert.ok(!/mode: 'live'/.test(page), 'nothing on the page constructs a live config');
  assert.match(page, /'Start on paper'/, 'the button that saves a new follow says paper');
  // Every Follow button opens the page; none saves on its own.
  for (const f of ['../src/pages/Home.tsx', '../src/pages/Discover.tsx', '../src/pages/WalletProfile.tsx', '../src/pages/Following.tsx']) {
    const src = read(f);
    assert.ok(/nav\.follow\(/.test(src), `${f} follows through the Follow page`);
    assert.ok(!/copy\.save\(defaultConfig/.test(src), `${f} never saves a follow directly`);
  }
  const following = read('../src/pages/Following.tsx');
  assert.match(following, /onEdit=\{\(\) => nav\.editFollow\(c\)\}/, 'Edit on a card opens the same page');
  ok('the Follow page is the one way to follow: paper, % of their trade, shared derivation, same save');
}

{
  const page = read('../src/pages/Following.tsx');
  assert.match(page, /enabled: mode === 'live' \? false : c\.enabled/, 'switching a card to live disarms it first');
  assert.match(page, /title: 'Arm live copying'/, 'arming asks first');
  assert.match(page, /This follow is above your live cap/, 'a size over the live cap is caught at the switch');
  assert.match(page, /c\.sizing === 'proportional' \? \{ \.\.\.c, maxTradeSol: cap \}/, 'and a percentage follow keeps its percentage, capped');
  assert.match(page, /still following \$\{open\} open cop/, 'a paused card says it still follows its open copies out');
  ok('the live switches on a follow keep their rules');
}

{
  // Check (2026-10-25): any wallet, by address or pump.fun username, replayed
  // at once and sized like a follow.
  const page = read('../src/pages/Check.tsx');
  assert.match(page, /resolveWalletInput\(raw\)/, 'an address, a username or a link, resolved by the shared helper');
  // 2026-10-28: keyed by span too — "Newest 30 trades" or "Whole week".
  assert.match(page, /<ReplayPanel key=\{`\$\{wallet\.address\}:\$\{span\}`\} address=\{wallet\.address\} size=\{size\} sizing=\{replaySizing\} span=\{span\} autoStart/, 'the replay starts when a wallet is entered, sized as chosen, over the chosen span');
  assert.match(page, /nav\.editFollow\(followConfig\(address, name, 'solana', sizing/, 'Follow opens the Follow page on the same sizing');
  assert.ok(!/copy\.save\(/.test(page), 'Check never saves a follow itself');
  assert.match(read('../src/utils/walletInput.ts'), /window\.krypt\.scout\.pumpUser\(h\.value\)/, 'a username is looked up on pump.fun');
  assert.match(read('../src/pages/Discover.tsx'), /resolveWalletInput\(lookup\)/, "Discover's lookup resolves the same way");
  assert.match(read('../src/components/copy/ReplayPanel.tsx'), /replaySummary\(trips, size, sizing\)/, 'the summary is sized as chosen');
  assert.match(read('../src/pages/WalletProfile.tsx'), /import \{ ReplayPanel(?:, type ReplayResult)? \} from '\.\.\/components\/copy\/ReplayPanel';/, 'the profile shows the same replay');
  ok('Check: any wallet or pump.fun username, replayed at once, sized like a follow');
}

{
  // pump.fun's leaderboard on Discover (2026-10-25): day, week and month,
  // shown next to a replay of copying them — never ranked as a score.
  const d = read('../src/pages/Discover.tsx');
  assert.match(d, /value: 'pump',\s+label: 'pump\.fun top'/, 'a view on Discover');
  assert.match(d, /<PumpBoard period=\{win === 'day' \? 'daily' : win === 'month' \? 'monthly' : 'weekly'\} size=\{size\} \/>/, 'its window is Discover’s day, week or month');
  const b = read('../src/components/copy/PumpBoard.tsx');
  assert.match(b, /window\.krypt\.scout\.pumpLeaderboard\(period, fresh\)/, 'read through the main process');
  assert.match(b, /window\.krypt\.scout\.replay\(wallet, \{ checks: true \}\)/, 'the copy column is the same replay as Check, checks on');
  assert.match(b, /const BATCH_PARALLEL = 2;/, 'two wallets at a time');
  assert.match(b, /filter\(\(w\) => !done\(results\[w\]\)\)/, 'a wallet already replayed is not run (or billed) again');
  assert.ok(!/copy\.save\(/.test(b), 'the board never follows anyone itself');
  const ipc = read('../electron/ipc.ts');
  assert.match(ipc, /period !== 'daily' && period !== 'weekly' && period !== 'monthly'/, 'only the three periods pump answers');
  ok('pump.fun top: day, week and month, beside a replay of copying them');
}

{
  // P0 of the 10-25 research (reports → docs/wallet-scout-research-2026-10-25.md):
  // the board can recommend nobody, shows the fee floor beside every copier
  // figure, hides the hard exclusions, and is read back from the chain.
  const d = read('../src/pages/Discover.tsx');
  assert.match(d, /shortlistVerdict\(all, SCOUT_PICKS_N\)/, 'the verdict is computed from the same rows the board shows');
  assert.match(d, /Nobody to recommend this week\./, 'and said in those words');
  assert.match(d, /floor \{fmtPctS\(floorPct, \{ signed: true \}\)\}/, 'the fee floor stands in the copier column header');
  assert.match(d, /function copierTone\(r: ScoutRow\)/, 'the copier figure is toned against the floor, not zero');
  assert.match(d, /window\.krypt\.scout\.labelBoard\(\)/, 'the board can be checked on the chain from the page');
  assert.match(d, /<ChainLabelLine r=\{r\} l=\{r\.chainLabel\} \/>/, 'and each checked row shows what the chain said');
  // P1 (2026-10-25): the weeks come with the scorecard over them, in one read.
  assert.match(d, /window\.krypt\.scout\.scorecard\('solana', size\)/, 'the record is read by week, with the scorecard over it');
  assert.match(d, /data-testid="discover-scorecard"/, 'and the scorecard is shown under the record');
  assert.match(d, /<PreregPanel \/>/, 'the pre-registered test has its own view');
  assert.match(d, /bound \{fmtPctS\(/, 'each pick shows the bound it was ranked on');
  assert.match(d, /sort: 'fLowerPct'/, 'Best to copy ranks on the lower bound');
  const tags = read('../src/components/copy/WalletTags.tsx');
  assert.match(tags, /hardExclusions\(r\)/, 'the exclusions are chips on every row that carries one');
  const home = read('../src/pages/Home.tsx');
  assert.match(home, /Nobody to recommend this week/, 'Home says it too');
  const follow = read('../src/pages/Follow.tsx');
  assert.match(follow, /Nobody to recommend this week/, 'and the Follow page');
  const copy = read('../shared/copytrade.ts');
  assert.match(copy, /maxSlippagePct: 8,/, 'the slippage default is under the sandwiched band');
  assert.match(copy, /minLeaderSellPct: SIMPLE_SMALL_MIN_SELL_PCT,/, 'trims under half are skipped at every size');
  ok('P0: a board that can say nobody, the floor beside every figure, exclusions as chips, chain labels, a weekly record, and safer execution defaults');
}

console.log(`\ncopysimple: ${passed}/${passed} passed`);
