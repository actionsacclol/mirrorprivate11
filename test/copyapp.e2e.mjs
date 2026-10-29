// Krypto Mirror shell smoke test (2026-10-22 redesign). Attaches to a RUNNING
// dev app and walks the whole UI: the top navigation's five places and
// Settings, every tab inside Activity and Settings, the Follow page
// (typing an address, sizing by their trade, never saving), a wallet
// profile, and light mode.
// Fails on any page that renders the error boundary or nothing at all.
// Screenshots every screen. Nothing is saved and no setting is changed —
// light mode is put back the way it was found.
//
//   KRYPT_DEBUG_PORT=9333 npm run dev
//   node test/copyapp.e2e.mjs
import { createRequire } from 'node:module';
import fs from 'node:fs';
const require = createRequire(import.meta.url);
const WebSocket = require('ws');

const PORT = process.env.PORT || '9333';
const OUT = process.env.OUT || 'C:/Users/Krypt/AppData/Local/Temp/krypto-mirror-e2e';
fs.mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const out = (...a) => console.log(...a);

const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
const page = list.find((t) => t.type === 'page' && /localhost|127\.0\.0\.1|index\.html/.test(t.url)) ?? list.find((t) => t.type === 'page');
if (!page) throw new Error('no page target');
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((res, rej) => {
  ws.once('open', res);
  ws.once('error', rej);
});
let id = 0;
const pending = new Map();
ws.on('message', (raw) => {
  const m = JSON.parse(String(raw));
  if (m.id && pending.has(m.id)) {
    pending.get(m.id)(m);
    pending.delete(m.id);
  }
});
const call = (method, params = {}) =>
  new Promise((res) => {
    const mid = ++id;
    pending.set(mid, res);
    ws.send(JSON.stringify({ id: mid, method, params }));
  });
const evaluate = async (expression) => {
  const r = await call('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (r.error) throw new Error(JSON.stringify(r.error));
  if (r.result.exceptionDetails) throw new Error(r.result.exceptionDetails.exception?.description ?? JSON.stringify(r.result.exceptionDetails));
  return r.result.result.value;
};
const shot = async (name) => {
  await sleep(350);
  const r = await call('Page.captureScreenshot', { format: 'png' });
  const file = `${OUT}/${name}.png`;
  fs.writeFileSync(file, Buffer.from(r.result.data, 'base64'));
  out('screenshot', file);
};
const waitFor = async (expr, ms = 15_000) => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (await evaluate(expr)) return true;
    await sleep(250);
  }
  return false;
};
const mainText = () => evaluate(`document.querySelector('main')?.textContent || ''`);
const click = (sel) => evaluate(`(() => { const el = document.querySelector(${JSON.stringify(sel)}); if (!el) return false; el.click(); return true; })()`);
const type = (selector, value) =>
  evaluate(
    `(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return false; const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set; set.call(el, ${JSON.stringify(value)}); el.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`,
  );
const broken = () => evaluate(`/Something went wrong|Unexpected Application Error/i.test(document.body.textContent || '')`);

let failures = 0;
const check = (name, cond, detail = '') => {
  if (cond) out(`ok   ${name}${detail ? ` — ${detail}` : ''}`);
  else {
    failures++;
    out(`FAIL ${name}${detail ? ` — ${detail}` : ''}`);
  }
};

const SOL = '7Ngr8xZ2bRwMwnX6zYJpKZrY4o8fQ4Rk3wq2cTRuQ9Ue';
const wasLight = await evaluate(`document.documentElement.classList.contains('light')`);
try {
  await waitFor(`!!document.querySelector('[data-testid=nav-home]')`);
  // The onboarding overlay is hidden, never accepted on the user's behalf.
  await evaluate(`(() => { const o = document.querySelector('[data-testid=onboarding]'); if (o) o.style.display = 'none'; [...document.querySelectorAll('[inert]')].forEach((e) => e.removeAttribute('inert')); return true; })()`);

  const nav = await evaluate(`[...document.querySelectorAll('header nav button')].map((b) => (b.textContent || '').trim())`);
  check('the top navigation has the five places', nav.join('|') === 'Home|Discover|Following|Activity|Wallet', nav.join(' | '));
  check('no sidebar', !(await evaluate(`!!document.querySelector('aside nav')`)));
  check('the wordmark says Krypto Mirror', await evaluate(`/Krypto Mirror/.test(document.querySelector('header')?.textContent || '')`));
  check('Paper/Live is in the bar', await evaluate(`!!document.querySelector('[data-testid=mode-switch]')`));

  const PAGES = [
    ['home', /Good (morning|afternoon|evening)/],
    ['discover', /Discover/],
    ['check', /Check a wallet/],
    ['following', /Following/],
    ['activity', /Activity/],
    ['wallet', /Wallet/],
    ['settings', /Settings/],
  ];
  for (const [idName, must] of PAGES) {
    check(`${idName}: opens`, await click(`[data-testid=nav-${idName}]`));
    await waitFor(`${must}.test(document.querySelector('main')?.textContent || '')`, 10_000);
    const text = await mainText();
    check(`${idName}: renders`, must.test(text) && !(await broken()), text.slice(0, 90).replace(/\s+/g, ' '));
    await shot(`page-${idName}`);
  }

  // Tabs inside the tabbed pages.
  for (const [route, tabs] of [
    ['activity', ['copies', 'positions', 'history']],
    ['settings', ['general', 'console', 'about', 'legal']],
    ['wallet', ['solana', 'pump']],
  ]) {
    await click(`[data-testid=nav-${route}]`);
    await sleep(400);
    for (const t of tabs) {
      check(`${route} › ${t}: opens`, await click(`[data-testid=tab-${t}]`));
      await sleep(700);
      check(`${route} › ${t}: renders`, !(await broken()) && (await mainText()).length > 40);
      await shot(`tab-${route}-${t}`);
    }
  }
  await click('[data-testid=nav-settings]');
  await sleep(500);
  check('settings keeps the fee and referral section', /Refer someone else|referrer/i.test(await mainText()));
  check('settings offers Dark / Light', await evaluate(`!!document.querySelector('[data-testid=appearance]')`));
  // Wallet › pump.fun: accounts (with the kryptcc disclosure), automatic callouts on copies, rewards.
  await click('[data-testid=nav-wallet]');
  await sleep(400);
  await click('[data-testid=tab-pump]');
  await sleep(900);
  const pumpText = await mainText();
  check('pump.fun tab says accounts are referred by kryptcc', /kryptcc/.test(pumpText));
  check('pump.fun tab has the copy callout switch', await evaluate(`!!document.querySelector('[data-testid=copy-callouts]')`));
  check('pump.fun tab shows callout rewards', /Callout rewards/.test(pumpText));
  await shot('tab-wallet-pump-full');

  // The Follow page: open, pick a wallet, size by their trade, never save.
  await click('[data-testid=nav-home]');
  await sleep(400);
  check('Home has a Follow button', await click('[data-testid=home-follow]'));
  check('the Follow page opens', await waitFor(`!!document.querySelector('[data-testid=follow-page]')`, 6_000));
  check('it is a page, not a pop-up', !(await evaluate(`!!document.querySelector('[data-testid=follow-page]').closest('.fixed')`)));
  await shot('follow-who');
  check('a Solana address is typed', await type('[data-testid=follow-address]', SOL));
  await sleep(200);
  check('the address is accepted', await click('[data-testid=follow-use]'));
  await sleep(500);
  check('the chosen wallet is shown', await evaluate(`!!document.querySelector('[data-testid=follow-wallet]')`));
  const pageText = () => evaluate(`document.querySelector('[data-testid=follow-page]').textContent`);
  let t = await pageText();
  check('a fixed size defaults to 0.05', /Every copy spends 0\.05 SOL/.test(t), t.match(/Every copy spends [^,]+/)?.[0]);
  check('it says what network fees take at that size', /network fees alone take about/.test(t));
  await shot('follow-fixed');
  // Size by their trade.
  await evaluate(`(() => { const b = [...document.querySelectorAll('[data-testid=follow-sizing] button')].find((x) => /% of their trade/.test(x.textContent)); b?.click(); return !!b; })()`);
  await sleep(300);
  t = await pageText();
  check('% of their trade is offered, at 25% up to 0.1', /A copy is 25% of what they spent, up to 0\.1 SOL/.test(t), t.match(/A copy is [^.]+\.[^.]*/)?.[0]);
  const preview = await evaluate(`document.querySelector('[data-testid=follow-preview]').textContent`);
  check('the preview sizes a 0.2 buy at 0.05 and caps a 1 buy at 0.1', /0\.2 SOL0\.05 SOL/.test(preview) && /1 SOL0\.1 SOL \(cap\)/.test(preview), preview.slice(0, 160));
  check('their buys too small for a live copy are skipped', /skipped — under 0\.12/.test(preview));
  await shot('follow-pct');
  await click('[data-testid=follow-advanced]');
  await sleep(300);
  t = await pageText();
  check('Advanced has its toggles', /Take profit/.test(t) && /Copy their sells/.test(t) && /Minimum liquidity/.test(t) && (await evaluate(`document.querySelectorAll('[data-testid=follow-page] [role=switch]').length`)) >= 8);
  await shot('follow-advanced');
  check('the save button says paper', /Start on paper/.test(await evaluate(`document.querySelector('[data-testid=follow-start]').textContent`)));
  check('Back leaves without saving', await click('[data-testid=follow-back]'));
  await sleep(500);
  check('and returns to Home', !(await evaluate(`!!document.querySelector('[data-testid=follow-page]')`)) && (await evaluate(`!!document.querySelector('[data-testid=home-follow]')`)));

  // A wallet profile, by lookup — opens even for a wallet with no record.
  await click('[data-testid=nav-discover]');
  await sleep(500);
  await type('[data-testid=discover-lookup]', SOL);
  await evaluate(`(() => { const f = document.querySelector('[data-testid=discover-lookup]').closest('form'); f.requestSubmit(); return true; })()`);
  check('a looked-up wallet opens its profile', await waitFor(`!!document.querySelector('[data-testid=wallet-profile]')`, 6_000));
  await waitFor(`!!document.querySelector('[data-testid=profile-verdict]')`, 6_000);
  check('the profile states a verdict', await evaluate(`!!document.querySelector('[data-testid=profile-verdict]')`));
  await shot('profile');
  // Any ranked wallet on the board opens too.
  await click('[data-testid=nav-discover]');
  await sleep(1_500);
  const rows = await evaluate(`document.querySelectorAll('[data-testid=scout-row]').length`);
  out(`board rows: ${rows}`);
  if (rows > 0) {
    await click('[data-testid=scout-row]');
    check('a board row opens its profile', await waitFor(`!!document.querySelector('[data-testid=profile-verdict]')`, 6_000));
    await shot('profile-ranked');
  }

  // Light mode, then back.
  await evaluate(`document.documentElement.classList.add('light')`);
  for (const p of ['home', 'discover', 'following']) {
    await click(`[data-testid=nav-${p}]`);
    await sleep(600);
    await shot(`light-${p}`);
  }
} finally {
  await evaluate(`document.documentElement.classList.toggle('light', ${wasLight})`);
  await evaluate(`(() => { const o = document.querySelector('[data-testid=onboarding]'); if (o) o.style.display = ''; return true; })()`);
  ws.close();
}
out(failures ? `\n${failures} check(s) FAILED` : '\nall Krypto Mirror shell checks passed');
process.exit(failures ? 1 : 0);
