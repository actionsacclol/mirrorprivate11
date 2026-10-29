// Convergence: following a crowd (2026-10-28). Discover's "Follow the
// crowd" on the Week total ranking, the crowd panel on the Follow page, the
// crowd's card on Following, then the two ways to pick the crowd yourself:
// "Converge on these" from Discover's compare bar, and "Converge on #tag"
// from the address book.
//
// Run from a profile with no follows (`instance.ps1 unfollow`): the take
// starts one crowd follow on paper. It never clicks "Scan the week's
// winners" (that spends Helius credits) and never opens a second draft. The
// address-book tag it shows is seeded in `prepare` with three public board
// wallets and removed again in `cleanup`.

import { btn, go, heading, mainSays, opt } from './_app.mjs';

const PAGE = '[data-testid=follow-page]';
const CARD = '[data-testid=follow-card]';
const VIEWS = '[data-testid=discover-views]';
const TAG = 'tutorial-crowd';
let seeded = [];

/** Mark the n-th (0-based) Discover row's compare box so it can be clicked. */
const markCompare = (ui, n) =>
  ui.evaluate(`(() => { const b = document.querySelectorAll('[data-testid=scout-row] button[title=Compare]')[${n}]; if (b) b.setAttribute('data-tut', 'cmp${n}'); return !!b; })()`);

export default {
  posterAt: 22,
  async prepare(ui) {
    // Three public wallets off the board, into the address book under one tag.
    const r = await ui.evaluate(
      `window.krypt.scout.top('solana', 'week', 'fLowerPct', 6, 0.05).then((r) => (r.ok && r.data ? r.data.rows.map((x) => x.address) : []))`,
    );
    seeded = (Array.isArray(r) ? r : []).slice(0, 3);
    if (seeded.length < 2) throw new Error('the board has fewer than two wallets to seed the address book with');
    for (const [i, a] of seeded.entries()) {
      await ui.evaluate(`window.krypt.book.save(${JSON.stringify({ address: a, name: `Crowd pick ${i + 1}`, note: '', tags: [TAG] })}).then((r) => r.ok)`);
    }
    await go(ui, 'home', /Good (morning|afternoon|evening)/);
  },
  async cleanup(ui) {
    for (const a of seeded) await opt(ui.evaluate(`window.krypt.book.remove(${JSON.stringify(a)}).then((r) => r.ok)`));
  },
  steps: [
    {
      line: 0,
      do: async (ui) => {
        await go(ui, 'discover', /Discover/);
        await ui.waitFor({ expr: `document.querySelectorAll('[data-testid=scout-row]').length > 0` }, 30_000);
        await opt(ui.hover('[data-testid=scout-row]', { hold: 1100 }));
        await opt(ui.hover('[data-testid=scout-row]:nth-of-type(2)', { hold: 900 }));
        await opt(ui.hover('[data-testid=scout-row]:nth-of-type(3)', { hold: 900 }));
      },
    },
    {
      line: 1,
      do: async (ui) => {
        await ui.point(VIEWS, { hold: 900 });
        await ui.click({ text: '^Week total$', sel: 'button', within: VIEWS });
        await ui.pause(1200);
        await opt(ui.point({ text: '^Week total$', sel: 'button', within: VIEWS }, { hold: 1600, glow: 1800 }));
      },
    },
    { line: 2, do: async (ui) => opt(ui.point({ testid: 'scout-scan-winners' }, { hold: 3200, glow: 3400 })) },
    {
      line: 3,
      do: async (ui) => {
        await ui.point({ testid: 'discover-crowd' }, { hold: 1300, glow: 1500 });
        await ui.click({ testid: 'discover-crowd' });
        await ui.waitFor({ testid: 'follow-page' }, 8000);
        await ui.hover(`${PAGE} h1`, { hold: 1400 });
      },
    },
    {
      line: 4,
      do: async (ui) => {
        await ui.point(heading('The crowd', PAGE), { hold: 1000 });
        await opt(ui.point(heading('Which wallets count', PAGE), { hold: 1400, glow: 1600 }));
        for (const t of ['Followed wallets', 'Saved Scout wallets', 'Tracked wallets', 'Top Scout wallets', 'Wallets I pick']) await opt(ui.hover(btn(t, PAGE), { hold: 650 }));
        await opt(ui.point({ testid: 'crowd-sort' }, { hold: 1200 }));
      },
    },
    { line: 5, do: async (ui) => opt(ui.point(heading('Buy when', PAGE), { hold: 3200, glow: 3400 })) },
    { line: 6, do: async (ui) => opt(ui.point(heading('Get out when', PAGE), { hold: 3000, glow: 3200 })) },
    { line: 7, do: async (ui) => ui.point({ testid: 'follow-summary' }, { hold: 2800, glow: 3000 }) },
    {
      line: 8,
      do: async (ui) => {
        // Advanced remembers whether it was left open; open it only if shut.
        if (!(await ui.exists(heading('Direction', PAGE)))) await ui.click({ testid: 'follow-advanced' });
        await opt(ui.waitFor({ text: '9\\.3 million', sel: 'p, div, span', within: PAGE }, 5000));
        await opt(ui.point({ text: '9\\.3 million', sel: 'p, div, span', within: PAGE }, { hold: 4200, glow: 4400 }));
        await ui.point({ testid: 'follow-start' }, { hold: 1000, glow: 1200 });
      },
    },
    {
      line: 9,
      do: async (ui) => {
        await ui.click({ testid: 'follow-start' });
        await ui.waitFor(CARD, 10_000);
        await opt(ui.waitFor(mainSays(/Listening to/), 5000));
        await ui.point(CARD, { hold: 1400, glow: 2000 });
        await opt(ui.point({ text: '^Listening to', sel: 'span, div', within: CARD }, { hold: 1600 }));
        await opt(ui.hover(heading('Rules', CARD), { hold: 1400 }));
      },
    },
    {
      line: 10,
      do: async (ui) => {
        await go(ui, 'discover', /Discover/);
        await ui.waitFor({ expr: `document.querySelectorAll('[data-testid=scout-row] button[title=Compare]').length > 2` }, 25_000);
        for (const n of [0, 1, 2]) {
          if (await markCompare(ui, n)) await ui.click(`[data-tut=cmp${n}]`);
          await ui.pause(250);
        }
        await ui.waitFor({ testid: 'compare-crowd' }, 5000);
        await ui.point({ testid: 'compare-crowd' }, { hold: 2600, glow: 2800 });
        await opt(ui.click(btn('Clear')));
      },
    },
    {
      line: 11,
      do: async (ui) => {
        await go(ui, 'following', /Following/);
        await ui.point({ testid: 'following-book' }, { hold: 700, glow: 900 });
        await ui.click({ testid: 'following-book' });
        await ui.waitFor({ testid: 'book-page' }, 8000);
        await opt(ui.hover({ testid: 'book-list' }, { hold: 900 }));
        await ui.click({ text: `^#${TAG}`, sel: 'button', within: '[data-testid=book-tags-filter]' });
        await ui.waitFor({ testid: 'book-converge' }, 5000);
        await ui.point({ testid: 'book-converge' }, { hold: 2400, glow: 2600 });
      },
    },
    {
      line: 12,
      do: async (ui) => {
        await go(ui, 'following', /Following/);
        await ui.point(CARD, { hold: 2400, glow: 2600 });
      },
    },
  ],
};
