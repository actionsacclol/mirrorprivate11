// Chain first on the profile, and one home for the API keys (2026-10-25).
//
// A wallet the live feed saw 12 trades of in a week read +17 % on the feed's
// marks; the chain held 508 trades and a replay of the newest 30 read −21 %.
// The user met the two figures side by side and called it a contradiction.
// Read from source: the verdict and the copy panel lead with the chain once
// it has spoken, the feed's figure is stated as what the feed saw, a Solana
// profile reads the wallet from the chain on open, the feed-loss warning
// stands on the board and the profile, and every API key is managed in one
// Settings section with a check that the saved key works.

import assert from 'node:assert';
import fs from 'node:fs';

let passed = 0;
const ok = (label) => {
  console.log(`  ok   ${label}`);
  passed += 1;
};
const read = (rel) => fs.readFileSync(new URL(rel, import.meta.url), 'utf8');

{
  const page = read('../src/pages/WalletProfile.tsx');
  assert.match(page, /function verdict\(r: ReturnType<typeof summarise>, cv: ChainView \| null\)/, 'the verdict takes the chain’s view');
  const chainAt = page.indexOf('if (cv && cv.medianPct !== null)');
  const tooFewAt = page.indexOf("head: 'Too few trades to judge'");
  const botAt = page.indexOf('if (r.looksAutomated)');
  assert.ok(chainAt > 0 && tooFewAt > 0 && botAt > 0, 'the three branches exist');
  assert.ok(botAt < chainAt && chainAt < tooFewAt, 'a bot is still a bot; otherwise the chain’s figure beats the record’s sample size');
  assert.match(page, /head: `Read from the chain: copies would have lost \$\{fmtPctS\(Math\.abs\(v\)\)\} per trade`/, 'the chain’s loss leads');
  assert.match(page, /head: `Read from the chain: copies would have kept \$\{fmtPctS\(v, \{ signed: true \}\)\} per trade`/, 'and its gain');
  assert.match(page, /function feedSawLine\(r: ReturnType<typeof summarise>\): string/, 'the feed’s own figure is stated beside it');
  assert.match(page, /set aside: it misses trades and fills at the last mark it carried/, 'as what the feed saw, not as a second verdict');
  assert.match(page, /if \(r\.fastWallet\) \{\s*return \{\s*head: 'Too fast for the live feed to price — the chain can'/, 'a fast wallet gets no live figure, and says why');
  // The chain view comes from this session's replay first, the board's check second.
  assert.match(page, /if \(replay\) \{\s*const s = replay\.summary;\s*return \{ source: 'replay'/, 'the replay’s own summary is the view');
  assert.match(page, /medianPct: l\.medianPct === null \? null : repriceReturn\(l\.medianPct, copyCostModel\(chain, row\.sizeSol\)\)/, 'the board’s label is repriced to the page’s size');
  assert.match(page, /<ReplayPanel address=\{address\} size=\{size\} symbols=\{symbols\} onResult=\{setReplay\} \/>/, 'the panel hands its result up');
  assert.match(page, /data-testid=\{chainView \? 'profile-copy-chain' : 'profile-copy-feed'\}/, 'the copy panel says which source it shows');
  assert.match(page, /What the live feed saw:<\/span> \{row\.fTrips\} of their \{row\.roundTrips\} finished trades/, 'coverage is stated as a count, not a verdict');
  ok('the profile leads with the chain once it has spoken, and states what the feed saw');
}

{
  const page = read('../src/pages/WalletProfile.tsx');
  assert.match(page, /const autoRead = useRef<string \| null>\(null\);/, 'the open-read is guarded per wallet');
  assert.match(page, /if \(r\.data\.startedAt !== null\) return void setRead\(r\.data\);\s*if \(autoRead\.current === address\) return;\s*autoRead\.current = address;\s*void window\.krypt\.scout\.readWallet\(chain, address\)/, 'a wallet not read this session is read when the profile opens, once');
  assert.match(page, /runs on its own the first time a profile opens in a session/, 'the button says so');
  assert.match(page, /<FeedLossNote where="this record" \/>/, 'the feed-loss warning stands on the profile');
  assert.match(read('../src/pages/Discover.tsx'), /<FeedLossNote where="this board" \/>/, 'and on the board');
  const note = read('../src/components/copy/FeedLossNote.tsx');
  assert.match(note, /export const FEED_LOSS_WARN_PCT = 5;/, 'the same share the engine warns at');
  assert.match(read('../electron/engine/engine.ts'), /snap\.lossPct !== null && snap\.lossPct > 5 && snap\.checked >= 500/, 'the engine warns above five percent');
  assert.match(note, /if \(!status\.running \|\| pct === null \|\| pct <= FEED_LOSS_WARN_PCT\) return null;/, 'nothing is shown while the feed is whole, or off');
  ok('the chain read runs on open, and the feed-loss warning stands where the record is read');
}

{
  const panel = read('../src/components/copy/ReplayPanel.tsx');
  assert.match(panel, /onResult\?: \(r: ReplayResult \| null\) => void;/, 'the panel offers its result');
  assert.match(panel, /onResult\(st && !st\.running && st\.finishedAt !== null && trips\.length > 0 \? \{ status: st, summary: sum \} : null\);/, 'only a finished run with trips counts; a new wallet or a run in progress clears it');
  const shared = read('../shared/walletScout.ts');
  assert.match(shared, /export const SCOUT_FAST_WALLET_PCT = 50;/, 'the fast-wallet share is one constant');
  assert.match(shared, /const fastWallet = fastPct !== null && measured >= MIN_TRIPS_FOR_RANK && fastPct >= SCOUT_FAST_WALLET_PCT;/, 'judged on a sample the rank would accept');
  assert.match(shared, /const enough = !fastWallet && fTrips >= MIN_TRIPS_FOR_RANK && rs\.length > 0;/, 'no follower figure for a fast wallet');
  assert.match(shared, /return r\.fastPct < SCOUT_FAST_WALLET_PCT;/, 'the slowEnough filter reads the same constant');
  ok('the replay panel reports up, and the fast-wallet rule is one constant in the shared model');
}

{
  const keys = read('../src/components/terminal/ApiKeysSection.tsx');
  for (const id of ['helius', 'jupiter', 'birdeye', 'giphy', 'tenor']) assert.match(keys, new RegExp(`testId="apikey-${id}"`), `${id} has a row`);
  assert.match(keys, /data-testid="apikey-evm"/, 'the Alchemy key is pointed at, where it lives beside its URL');
  assert.match(keys, /type="password"/, 'keys are pasted into a password field');
  assert.match(keys, /set · ends …\$\{value\.slice\(-4\)\}/, 'a set key shows its last four characters only');
  assert.match(keys, /if \(\/\\s\/\.test\(key\)\) return `The \$\{name\} key has a space or a line break in it/, 'whitespace is refused before the boundary refuses it');
  assert.match(keys, /normalise=\{extractHeliusKey\}/, 'a pasted Helius URL yields its key');
  assert.match(keys, /window\.krypt\.market\.testKey\(id\)/, 'Jupiter and Birdeye keys are checked with one call');
  assert.match(keys, /window\.krypt\.rpc\.probe\(\)/, 'the Helius key is checked through the endpoint probe');
  assert.match(keys, /onSave=\{\(key\) => saveData\(\{ birdeyeApiKey: key, providers: \{ \.\.\.settings\.data\.providers, birdeye: key\.length > 0 \} \}\)\}/, 'saving a Birdeye key switches the provider on, removing it off');
  assert.match(keys, /host in use: <span className=\{jup\.host === 'api\.jup\.ag' \? 'text-emerald-300' : 'text-arc-gold'\}>\{jup\.host\}<\/span>/, 'the Jupiter row shows which host the key selected');
  assert.match(keys, /<CreditMeter/, 'the credit meter lives with the Helius key');
  assert.ok(!/toast\.(success|error|info)\(`[^`]*\$\{(key|draft|value)\}/.test(keys), 'no toast carries a key');
  const settings = read('../src/pages/Settings.tsx');
  assert.match(settings, /<ApiKeysSection settings=\{settings\} updateSettings=\{updateSettings\} \/>/, 'Settings shows the section');
  assert.ok(!/heliusKey/.test(settings), 'the RPC card no longer edits the Helius key');
  assert.ok(!/CreditMeter/.test(settings), 'nor shows a second credit meter');
  const market = read('../src/components/terminal/MarketDataSettings.tsx');
  assert.ok(!/birdeyeApiKey: birdeyeKey|jupiterApiKey: jupiterKey|giphyApiKey: giphyKey/.test(market), 'Market data no longer has its own key fields');
  assert.match(market, /are managed under <span className="text-white\/80">API keys<\/span> above/, 'it points at the one home');
  // Main side: the check is one cheap call, and the key never reaches the message.
  const m = read('../electron/data/market.ts');
  assert.match(m, /export async function testProviderKey\(id: 'jupiter' \| 'birdeye'\): Promise<ProviderKeyTest>/, 'the key test exists');
  assert.match(m, /getJson<Record<string, unknown>>\('jupiter', `\/price\/v3\?ids=\$\{SOL\}`, \{ priority: true, timeoutMs: 10_000 \}\)/, 'Jupiter: SOL’s price on the host the key selects');
  assert.match(m, /headers: \{ 'X-API-KEY': birdeyeKey, 'x-chain': 'solana' \}/, 'Birdeye: the saved key in its header');
  assert.ok(!/message[^;]*birdeyeKey/.test(m.slice(m.indexOf('export async function testProviderKey'), m.indexOf('export function providerStatuses'))), 'the message never carries the key');
  assert.match(read('../electron/ipc.ts'), /ipcMain\.handle\('market:testKey', async \(_e, id: unknown\) => \{\s*if \(id !== 'jupiter' && id !== 'birdeye'\) return fail\('Unknown provider'\);/, 'the channel takes the two keyed providers only');
  assert.match(read('../electron/preload.ts'), /testKey: \(id: string\) => ipcRenderer\.invoke\('market:testKey', id\),/, 'the bridge exposes it');
  const secrets = read('../electron/system/settingsValidation.ts');
  for (const f of ['data.birdeyeApiKey', 'data.jupiterApiKey', 'data.giphyApiKey', 'data.tenorApiKey', 'rpc.heliusApiKey', 'evm.robinhood.apiKey']) {
    assert.ok(secrets.includes(`'${f}'`), `${f} is a secret field at the boundary`);
  }
  ok('API keys: one Settings section, masked, checked with one call, every field a secret at the boundary');
}

console.log(`\nprofilechain: ${passed}/${passed} passed`);
