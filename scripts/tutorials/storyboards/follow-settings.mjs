// Following a wallet: every setting on the Follow page, then the card on
// Following. The wallet is the board's first ranked one on the day of the
// take (a public address).
//
// 2026-10-28: Convergence replaced the "FOMO" label, and the take now shows
// Watch only, the creator-sell and graduation exits, following them out
// another way, one position per coin and trading hours. Later that day:
// Your AI decides, the per-follow AI gate.

import { btn, firstBoardWallet, go, heading, opt } from './_app.mjs';

let address = '';
const PAGE = '[data-testid=follow-page]';
const CARD = '[data-testid=follow-card]';

export default {
  posterAt: 30,
  async prepare(ui) {
    address = await firstBoardWallet(ui);
    await go(ui, 'home', /Good (morning|afternoon|evening)/);
  },
  steps: [
    {
      line: 0,
      do: async (ui) => {
        await ui.click({ testid: 'home-follow' });
        await ui.waitFor({ testid: 'follow-page' }, 8000);
        await ui.hover(`${PAGE} h1`, { hold: 1800 });
      },
    },
    {
      line: 1,
      do: async (ui) => {
        await ui.type({ testid: 'follow-address' }, address, { perChunk: 35 });
        await ui.click({ testid: 'follow-use' });
        await ui.waitFor({ testid: 'follow-wallet' }, 8000);
        await ui.point({ testid: 'follow-wallet' }, { hold: 2200, glow: 2400 });
      },
    },
    {
      line: 2,
      do: async (ui) => {
        await ui.point({ testid: 'follow-sizing' }, { hold: 1200 });
        await opt(ui.click({ text: '% of their trade', sel: 'button', within: '[data-testid=follow-sizing]' }));
        await opt(ui.point({ testid: 'follow-pct' }, { hold: 1200 }));
        await opt(ui.point({ testid: 'follow-cap' }, { hold: 1200 }));
        await opt(ui.point({ testid: 'follow-preview' }, { hold: 1800, glow: 1800 }));
        await opt(ui.click({ text: '^Fixed amount$', sel: 'button', within: '[data-testid=follow-sizing]' }));
      },
    },
    { line: 3, do: async (ui) => ui.point({ testid: 'follow-summary' }, { hold: 2600, glow: 2800 }) },
    {
      line: 4,
      do: async (ui) => {
        await ui.point(heading('Limits', PAGE), { hold: 1200 });
        await opt(ui.point({ testid: 'follow-daily-loss' }, { hold: 1400 }));
        await opt(ui.hover(heading('Pause this wallet after losing', PAGE), { hold: 1200 }));
        await opt(ui.hover(heading('At most this many copies a day', PAGE), { hold: 1200 }));
      },
    },
    {
      line: 5,
      do: async (ui) => {
        // Advanced remembers whether it was left open; open it only if shut.
        if (!(await ui.exists(heading('Direction', PAGE)))) await ui.click({ testid: 'follow-advanced' });
        await ui.waitFor(heading('Direction', PAGE), 6000);
        await ui.pause(600);
      },
    },
    {
      line: 6,
      do: async (ui) => {
        await ui.point(heading('Direction', PAGE), { hold: 1200 });
        await opt(ui.hover(btn('Copy', PAGE), { hold: 900 }));
        await opt(ui.hover(btn('Reverse', PAGE), { hold: 1100 }));
        await opt(ui.hover(btn('Convergence', PAGE), { hold: 1600 }));
        await opt(ui.hover(btn('Watch only', PAGE), { hold: 2200 }));
      },
    },
    {
      line: 7,
      do: async (ui) => {
        await ui.point(heading('Your own exits', PAGE), { hold: 1100 });
        for (const t of ['Take profit', 'Stop loss', 'Trailing stop', 'Sell after holding']) await opt(ui.hover(heading(t, PAGE), { hold: 1000 }));
      },
    },
    {
      line: 8,
      do: async (ui) => {
        await opt(ui.point(heading('Sell if the creator sells', PAGE), { hold: 2600, glow: 2600 }));
        await opt(ui.point(heading('Sell when it graduates', PAGE), { hold: 2400, glow: 2400 }));
      },
    },
    {
      line: 9,
      do: async (ui) => {
        await ui.point(heading('Your AI decides', PAGE), { hold: 1400, glow: 2000 });
        for (const t of ['Your AI decides each buy', 'Your AI decides each sell']) await opt(ui.hover(heading(t, PAGE), { hold: 1500 }));
        await opt(ui.hover({ testid: 'follow-ai-open' }, { hold: 1500 }));
      },
    },
    {
      line: 10,
      do: async (ui) => {
        await ui.point(heading('Their sells', PAGE), { hold: 1200 });
        await opt(ui.point(heading('Ignore small trims', PAGE), { hold: 2000 }));
      },
    },
    { line: 11, do: async (ui) => opt(ui.point(heading('Follow them out another way', PAGE), { hold: 4200, glow: 4400 })) },
    {
      line: 12,
      do: async (ui) => {
        await ui.point(heading('Which trades', PAGE), { hold: 1000 });
        await opt(ui.hover(heading('Buy each coin only so many times', PAGE), { hold: 1000 }));
        await opt(ui.point(heading('One position per coin', PAGE), { hold: 1800, glow: 1800 }));
        await opt(ui.point(heading('Trading hours', PAGE), { hold: 2400, glow: 2400 }));
      },
    },
    {
      line: 13,
      do: async (ui) => {
        await ui.point(heading('Which coins', PAGE), { hold: 1000 });
        for (const t of ['Minimum liquidity', 'Market cap', 'Coin age when they buy', 'Minimum Krypt score', 'pump\\.fun coins only']) {
          await opt(ui.hover({ text: `^${t}$`, sel: 'div, span, label', within: PAGE }, { hold: 800 }));
        }
      },
    },
    {
      line: 14,
      do: async (ui) => {
        await ui.point(heading('Execution', PAGE), { hold: 1100 });
        for (const t of ['Wait before copying', 'Maximum slippage', 'At most this many copies a minute', 'Copy with']) await opt(ui.hover(heading(t, PAGE), { hold: 1000 }));
      },
    },
    { line: 15, do: async (ui) => opt(ui.point(heading('Never copy these', PAGE), { hold: 2000, glow: 2000 })) },
    {
      line: 16,
      do: async (ui) => {
        await ui.point({ testid: 'follow-start' }, { hold: 900, glow: 1200 });
        await ui.click({ testid: 'follow-start' });
        await ui.waitFor(CARD, 10_000);
        await ui.pause(500);
      },
    },
    {
      line: 17,
      do: async (ui) => {
        await ui.point(CARD, { hold: 1500, glow: 2400 });
        await ui.hover({ testid: 'follow-toggle' }, { hold: 1200 });
        await opt(ui.hover(btn('Edit', CARD), { hold: 1000 }));
        await opt(ui.hover(btn('Live', CARD), { hold: 1600 }));
      },
    },
  ],
};
