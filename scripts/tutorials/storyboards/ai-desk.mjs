// Your AI on the desk (2026-10-28): the AI page, then the per-follow gate.
// It switches the connection on at Paper trading (a port on 127.0.0.1 of the
// tutorial instance), never shows the token (the snippet on screen is
// masked; "Show token" is never pressed), never allows Live trading, and
// turns the connection off again at the end. The follow the earlier takes
// made gets "Your AI decides each buy" on paper, so the AI page has a row.

import { btn, go, heading, opt } from './_app.mjs';

const PAGE = '[data-testid=follow-page]';
const CARD = '[data-testid=follow-card]';
const AI = '[data-testid=ai-page]';
const sw = (label) => `${PAGE} [role=switch][aria-label="${label}"]`;
const isOn = (label) => ({ expr: `document.querySelector('${sw(label)}')?.getAttribute('aria-checked') === 'true'` });

async function setSwitch(ui, label, want) {
  const on = await ui.evaluate(`document.querySelector('${sw(label)}')?.getAttribute('aria-checked') === 'true'`);
  if (on !== want) await ui.click(sw(label));
  await ui.pause(300);
}

async function connectionOn(ui) {
  return ui.evaluate(`document.querySelector('[data-testid=ai-enabled]')?.getAttribute('aria-checked') === 'true'`);
}

export default {
  posterAt: 14,
  async prepare(ui) {
    await go(ui, 'ai', /Connect Claude Code/);
    if (await connectionOn(ui)) {
      await ui.click({ testid: 'ai-enabled' });
      await ui.pause(800);
    }
    await go(ui, 'home', /Good (morning|afternoon|evening)/);
  },
  steps: [
    {
      line: 0,
      do: async (ui) => {
        await go(ui, 'ai', /Connect Claude Code/);
        await ui.point({ text: '^AI$', sel: 'h1' }, { hold: 1200, glow: 1600 });
        await ui.point({ text: 'Connect Claude Code', sel: 'p', within: AI }, { hold: 3600 });
      },
    },
    {
      line: 1,
      do: async (ui) => {
        await ui.point(heading('Connect', AI), { hold: 900 });
        await ui.click({ testid: 'ai-enabled' });
        await ui.waitFor({ testid: 'ai-access-read' }, 8000);
        await ui.pause(500);
        await ui.point({ text: 'Listening on 127\.0\.0\.1', sel: 'div, p, span', within: AI }, { hold: 2200 });
      },
    },
    {
      line: 2,
      do: async (ui) => {
        await ui.hover({ testid: 'ai-access-read' }, { hold: 1200 });
        await ui.hover({ testid: 'ai-access-live' }, { hold: 1400 });
        await ui.click({ testid: 'ai-access-paper' });
        await ui.pause(500);
        await ui.point({ text: '^Deciding a follow', sel: 'p', within: AI }, { hold: 3000 });
      },
    },
    {
      line: 3,
      do: async (ui) => {
        await ui.point({ testid: 'ai-client' }, { hold: 1600, glow: 1600 });
        await ui.point({ testid: 'ai-client-snippet' }, { hold: 2400, glow: 2400 });
        await ui.hover({ testid: 'ai-copy-connect' }, { hold: 1200 });
        await ui.point({ text: 'holds a token', sel: 'p', within: AI }, { hold: 2600 });
      },
    },
    {
      line: 4,
      do: async (ui) => {
        await ui.point({ testid: 'ai-prompt' }, { hold: 3200, glow: 3400 });
        await ui.hover({ testid: 'ai-prompt-copy' }, { hold: 1600 });
      },
    },
    {
      line: 5,
      do: async (ui) => {
        await ui.point(heading('Limits', AI), { hold: 1200, glow: 1600 });
        for (const t of ['Max per buy', 'Max an hour', 'Trades a minute']) await opt(ui.hover(heading(t, AI), { hold: 900 }));
        await opt(ui.point({ text: 'Sells are never capped', sel: 'p', within: AI }, { hold: 2000 }));
      },
    },
    { line: 6, do: async (ui) => ui.point({ text: '^Whatever you allow', sel: 'p', within: AI }, { hold: 5200, glow: 5200 }) },
    {
      line: 7,
      do: async (ui) => {
        await go(ui, 'following', /Following/);
        await ui.waitFor(CARD, 10_000);
        await ui.click(btn('Edit', CARD));
        await ui.waitFor(PAGE, 10_000);
        if (!(await ui.exists(heading('Direction', PAGE)))) await ui.click({ testid: 'follow-advanced' });
        await ui.waitFor(heading('Your AI decides', PAGE), 6000);
        await ui.point(heading('Your AI decides', PAGE), { hold: 1600, glow: 2000 });
        await setSwitch(ui, 'Your AI decides each buy', true);
        await ui.waitFor(isOn('Your AI decides each buy'), 3000);
        await ui.hover(heading('Your AI decides each sell', PAGE), { hold: 1400 });
      },
    },
    {
      line: 8,
      do: async (ui) => {
        await ui.point(heading('Answer within', PAGE), { hold: 2400, glow: 2400 });
        await ui.point(heading('If the AI does not answer a buy', PAGE), { hold: 2600, glow: 2600 });
        await opt(ui.hover(btn('Skip it', PAGE), { hold: 1000 }));
      },
    },
    {
      line: 9,
      do: async (ui) => {
        // Shown only with the sell gate on: point at it, then put it back.
        await setSwitch(ui, 'Your AI decides each sell', true);
        await opt(ui.point(heading('Stop-losses wait for the AI too', PAGE), { hold: 3800, glow: 3800 }));
        await setSwitch(ui, 'Your AI decides each sell', false);
      },
    },
    {
      line: 10,
      do: async (ui) => {
        await ui.click({ testid: 'follow-start' });
        await ui.waitFor(CARD, 10_000);
        await ui.pause(400);
        await go(ui, 'ai', /Connect Claude Code/);
        await opt(ui.point({ testid: 'ai-status' }, { hold: 1400 }));
        await opt(ui.point({ testid: 'ai-follows' }, { hold: 2600, glow: 2600 }));
        await opt(ui.point(heading('Decisions', AI), { hold: 2000, glow: 2000 }));
      },
    },
    { line: 11, do: async (ui) => ui.point({ testid: 'ai-access-paper' }, { hold: 3600, glow: 3600 }) },
  ],
  async cleanup(ui) {
    // The follow's gate back off, and the connection off: the next takes
    // show a follow with no AI on it.
    await go(ui, 'following', /Following/).catch(() => {});
    try {
      await ui.click(btn('Edit', CARD));
      await ui.waitFor(PAGE, 10_000);
      if (!(await ui.exists(heading('Direction', PAGE)))) await ui.click({ testid: 'follow-advanced' });
      await ui.waitFor(heading('Your AI decides', PAGE), 6000);
      await ui.waitFor({ expr: `!!document.querySelector('${sw('Your AI decides each buy')}')` }, 6000);
      await setSwitch(ui, 'Your AI decides each buy', false);
      await setSwitch(ui, 'Your AI decides each sell', false);
      await ui.click({ testid: 'follow-start' });
      await ui.waitFor(CARD, 10_000);
      // Later takes film this card: it must not still say the AI decides.
      await ui.waitFor({ expr: `!/your AI decides/.test(document.querySelector('${CARD}')?.textContent || '')` }, 6000);
    } catch (e) {
      throw new Error(`ai-desk cleanup left the follow's AI gate on: ${e.message}`);
    }
    await go(ui, 'ai', /Connect Claude Code/).catch(() => {});
    if (await connectionOn(ui).catch(() => false)) {
      await ui.click({ testid: 'ai-access-read' }).catch(() => {});
      await ui.pause(400);
      await ui.click({ testid: 'ai-enabled' }).catch(() => {});
    }
  },
};
