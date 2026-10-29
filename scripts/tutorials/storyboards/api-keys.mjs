// Getting your API keys: Settings › API keys, row by row. The Helius key
// typed here is a made-up one in the tutorial profile; it is removed at the
// end of the take, and "Check the key" is pointed at, never pressed.

import { btn, go, opt } from './_app.mjs';

const H = '[data-testid=apikey-helius]';
const FAKE_HELIUS = '3f9c2a1e-7b4d-4c8e-9a21-5d6e7f8a9b0c';

export default {
  posterAt: 7,
  async prepare(ui) {
    await go(ui, 'home', /Good (morning|afternoon|evening)/);
  },
  steps: [
    {
      line: 0,
      do: async (ui) => {
        await ui.click({ testid: 'nav-settings' });
        await ui.waitFor({ text: '^API keys$', sel: 'h2' }, 10_000);
        await ui.pause(900);
        await ui.point({ text: '^API keys$', sel: 'h2' }, { hold: 2600, glow: 2600 });
      },
    },
    { line: 1, do: async (ui) => ui.point(H, { hold: 2400, glow: 2800 }) },
    { line: 2, do: async (ui) => ui.hover({ text: 'helius\\.dev', sel: 'a, button', within: H }, { hold: 3200 }) },
    {
      line: 3,
      do: async (ui) => {
        await ui.type({ testid: 'apikey-helius-input' }, FAKE_HELIUS, { perChunk: 60 });
        await ui.click(btn('Save', H));
        await ui.waitFor({ expr: `/ends/.test(document.querySelector('[data-testid=apikey-helius-state]')?.textContent || '')` }, 6000);
        await ui.point({ testid: 'apikey-helius-state' }, { hold: 1600 });
      },
    },
    { line: 4, do: async (ui) => ui.point({ text: 'Check the key', sel: 'button', within: H }, { hold: 2600, glow: 2600 }) },
    { line: 5, do: async (ui) => opt(ui.point({ text: 'credits', sel: 'div, p, span', within: H }, { hold: 2600, glow: 2600 })) },
    {
      line: 6,
      do: async (ui) => {
        await ui.point('[data-testid=apikey-jupiter]', { hold: 2200, glow: 2800 });
        await opt(ui.hover({ text: 'portal\\.jup\\.ag', sel: 'a, button', within: '[data-testid=apikey-jupiter]' }, { hold: 1600 }));
      },
    },
    { line: 7, do: async (ui) => ui.point('[data-testid=apikey-birdeye]', { hold: 2600, glow: 2800 }) },
    {
      line: 8,
      do: async (ui) => {
        await ui.point('[data-testid=apikey-giphy]', { hold: 1300 });
        await ui.point('[data-testid=apikey-tenor]', { hold: 1100 });
        await ui.point('[data-testid=apikey-evm]', { hold: 1600 });
      },
    },
    {
      line: 9,
      do: async (ui) => {
        await opt(ui.point({ text: 'never sent', sel: 'p' }, { hold: 2000 }));
        await removeKey(ui);
        await ui.pause(900);
      },
    },
  ],
  async cleanup(ui) {
    // Belt and braces: the made-up key must not outlive the take.
    if (await ui.exists(btn('Remove', H))) await removeKey(ui);
  },
};

const NOT_SET = { expr: `/not set/.test(document.querySelector('[data-testid=apikey-helius-state]')?.textContent || '')` };

/** Click Remove and make sure the row reads "not set" (one more try if not). */
async function removeKey(ui) {
  for (let attempt = 0; attempt < 2; attempt++) {
    await ui.click(btn('Remove', H));
    if (await ui.waitFor(NOT_SET, 4000).then(() => true, () => false)) return;
  }
  throw new Error('the made-up Helius key is still set');
}
