// Krypto Mirror's look (2026-10-22) — the things about it that can silently rot.
//
// 1. Every surface, text and money colour is a VARIABLE, defined for dark
//    and for light. A class that names a literal colour renders the same in
//    both modes and breaks one of them.
// 2. Up, down and caution are data, not decoration: light mode may deepen
//    them for contrast on white, never re-assign them.
// 3. The look is pinned: a settings file carried over from Krypto Bot can
//    not put its accents and looks back, and nothing is fetched to draw it.
// 4. Tailwind's opacity scale carries the in-between steps the look uses
//    (/8, /12): an unknown one silently falls back to the default border
//    colour, which is how every card got a bright white edge on day one.

import assert from 'node:assert';
import fs from 'node:fs';

let passed = 0;
const ok = (label) => {
  console.log(`  ok   ${label}`);
  passed += 1;
};
const read = (rel) => fs.readFileSync(new URL(rel, import.meta.url), 'utf8');
const css = read('../src/index.css');
const tw = read('../tailwind.config.js');

/** The custom properties set inside the first block whose selector matches. */
function block(selector) {
  const at = css.indexOf(selector);
  assert.ok(at >= 0, `index.css has ${selector}`);
  const body = css.slice(css.indexOf('{', at) + 1, css.indexOf('}', at));
  return Object.fromEntries([...body.matchAll(/--([\w-]+):\s*([^;]+);/g)].map((m) => [m[1], m[2].trim()]));
}

const NEEDED = ['krypt-text', 'krypt-ink', 'krypt-void', 'krypt-surface', 'krypt-panel', 'krypt-muted', 'up', 'down', 'warn', 'shadow-card', 'shadow-pop'];

{
  const dark = block("html[data-skin='classic'] {");
  const light = block('html.light {');
  for (const v of NEEDED) {
    assert.ok(dark[v], `dark defines --${v}`);
    assert.ok(light[v], `light defines --${v}`);
  }
  for (const v of ['krypt-text', 'krypt-void', 'krypt-panel', 'up', 'down', 'warn']) {
    assert.match(dark[v], /^\d{1,3} \d{1,3} \d{1,3}$/, `dark --${v} is RGB channels, so alpha modifiers work`);
    assert.match(light[v], /^\d{1,3} \d{1,3} \d{1,3}$/, `light --${v} is RGB channels`);
  }
  const lum = (rgb) => rgb.split(' ').map(Number).reduce((a, x) => a + x, 0);
  assert.ok(lum(light['krypt-void']) > lum(dark['krypt-void']) + 400, 'light really is light');
  assert.ok(lum(light['krypt-text']) < lum(dark['krypt-text']) - 400, 'and its text really is dark');
  ok('every surface, text and money colour is a variable, set for dark and for light');
}

{
  // Light mode deepens the inherited literal greens and reds to the money
  // colours — it never swaps them.
  const light = css.slice(css.indexOf('html.light {'));
  assert.match(light, /\[class\*='text-emerald-'\]\s*\{\s*color:\s*rgb\(var\(--up\)\)/, 'emerald becomes the up colour');
  assert.match(light, /\[class\*='text-rose-'\],\s*html\.light \[class\*='text-red-'\]\s*\{\s*color:\s*rgb\(var\(--down\)\)/, 'rose becomes the down colour');
  assert.match(light, /\[class\*='text-amber-'\]/, 'amber becomes the caution colour');
  for (const [name, v] of [['up', '--up'], ['down', '--down'], ['warn', '--warn'], ['accent', '--krypt-accent']]) {
    assert.match(tw, new RegExp(`${name}: 'rgb\\(var\\(${v}\\) \\/ <alpha-value>\\)'`), `Tailwind ${name} reads ${v}`);
  }
  ok('up, down and caution are fixed meanings in both modes');
}

{
  const host = read('../src/components/LiteModeHost.tsx');
  assert.match(host, /setTheme\('purple'\);\s*setSkin\('classic'\);/, 'the accent and the look are pinned at mount');
  assert.ok(!/setSkin\(skin\)|setTheme\(theme\)/.test(host), 'and never follow the settings file');
  const settings = read('../src/pages/Settings.tsx');
  assert.ok(!/ThemePicker/.test(settings), 'Settings offers no accent or look picker');
  assert.ok(/AppearancePicker/.test(settings), 'it offers dark / light');
  const main = read('../src/main.tsx');
  assert.ok(/initAppearance\(\)/.test(main) && main.indexOf('initAppearance()') < main.indexOf('createRoot'), 'dark/light is applied before React mounts');
  for (const f of ['inter', 'jetbrains-mono']) assert.ok(main.includes(`@fontsource/${f}/`), `${f} is bundled locally`);
  const code = main.split('\n').filter((l) => !/^\s*\/\//.test(l)).join('\n');
  assert.ok(!/fonts\.googleapis|fonts\.gstatic/.test(code), 'no remote font request');
  ok('the look is pinned, dark/light is seeded before the first frame, fonts are local');
}

{
  const scale = tw.slice(tw.indexOf('opacity: {'), tw.indexOf('}', tw.indexOf('opacity: {')));
  const used = new Set();
  for (const f of ['src/ui/kit.tsx', 'src/pages/Home.tsx', 'src/pages/Discover.tsx', 'src/pages/Following.tsx', 'src/pages/WalletProfile.tsx', 'src/shell/TopNav.tsx', 'src/pages/Follow.tsx', 'src/pages/Check.tsx', 'src/components/copy/ReplayPanel.tsx', 'src/components/copy/PumpBoard.tsx', 'src/components/common.tsx']) {
    for (const m of read(`../${f}`).matchAll(/(?:border|bg|text|ring)-[a-z-]+\/(\d+)\b/g)) used.add(m[1]);
  }
  const builtIn = new Set(['0', '5', '10', '15', '20', '25', '30', '35', '40', '45', '50', '55', '60', '65', '70', '75', '80', '85', '90', '95', '100']);
  for (const n of used) {
    if (builtIn.has(n)) continue;
    assert.match(scale, new RegExp(`\\b${n}: '0\\.`), `opacity /${n} is on the Tailwind scale`);
  }
  ok(`every opacity step the new pages use resolves (${[...used].sort((a, b) => a - b).join(', ')})`);
}

console.log(`\ntheme: ${passed}/${passed} passed`);
