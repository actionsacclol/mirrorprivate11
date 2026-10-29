// Your wallet and going live. Generates a throwaway hot wallet IN THE
// TUTORIAL PROFILE (never funded), shows the two Live switches and cancels
// each confirmation, so nothing is ever armed. It points at New wallet +
// account but never presses it: that makes a pump.fun account.

import { btn, go, heading, opt } from './_app.mjs';

const CARD = '[data-testid=follow-card]';

export default {
  posterAt: 12,
  async prepare(ui) {
    // The card must be running on paper when the take reaches it.
    await go(ui, 'following', /Following/);
    await ui.waitFor(CARD, 10_000);
    await resumeCard(ui);
    await go(ui, 'home', /Good (morning|afternoon|evening)/);
  },
  steps: [
    {
      line: 0,
      do: async (ui) => {
        await go(ui, 'wallet', /Wallet/);
        await opt(ui.click({ testid: 'tab-solana' }));
        if (await ui.exists(btn('Generate wallet'))) {
          await ui.point(heading('Generate a dedicated hot wallet'), { hold: 1200 });
          await ui.click(btn('Generate wallet'));
          await ui.waitFor({ text: 'Deposit address', sel: 'h2, h3, div, span' }, 15_000);
          await ui.pause(800);
        }
        await ui.point(heading('Trading wallet'), { hold: 1800, glow: 2000 });
      },
    },
    {
      line: 1,
      do: async (ui) => {
        await ui.point(heading('Backup & removal'), { hold: 1600, glow: 2200 });
        await opt(ui.hover({ text: 'Export all', sel: 'button' }, { hold: 1800 }));
      },
    },
    { line: 2, do: async (ui) => ui.point(heading('Deposit address'), { hold: 2600, glow: 2600 }) },
    {
      line: 3,
      do: async (ui) => {
        // The chip opens the switcher once it knows a wallet exists.
        await ui.waitFor({ expr: `/switch wallets/.test(document.querySelector('[data-testid=nav-balance]')?.title || '')` }, 10_000);
        await ui.point({ testid: 'nav-balance' }, { hold: 900, glow: 1200 });
        await ui.click({ testid: 'nav-balance' });
        await ui.waitFor({ testid: 'nav-wallets' }, 5000);
        await ui.point({ testid: 'nav-wallet-row' }, { hold: 2600, glow: 2800 });
        await opt(ui.hover({ text: 'Active wallet', sel: 'p', within: '[data-testid=nav-wallets]' }, { hold: 3200 }));
        await opt(ui.hover({ testid: 'nav-wallets-pump' }, { hold: 1200 }));
        await ui.click({ testid: 'nav-balance' });
        await ui.pause(400);
      },
    },
    {
      line: 4,
      do: async (ui) => {
        await ui.point(heading('Safety rails'), { hold: 1200, glow: 2400 });
        for (const t of ['Max SOL / trade', 'Max balance cap', 'Session loss cap', 'Losses in a row']) await opt(ui.hover({ text: `^${t}$`, sel: 'div, span, label' }, { hold: 900 }));
      },
    },
    {
      line: 5,
      do: async (ui) => {
        await ui.click(btn('Live', '[data-testid=mode-switch]'));
        await ui.waitFor(heading('Switch to Live'), 6000);
        await ui.point(heading('Switch to Live'), { dy: 60, hold: 2600, glow: 2600 });
        await ui.click(btn('Cancel'));
        await ui.pause(500);
      },
    },
    {
      line: 6,
      do: async (ui) => {
        await go(ui, 'following', /Following/);
        await ui.waitFor(CARD, 10_000);
        await ui.click(btn('Live', CARD));
        // A follow over the live cap asks to be capped first.
        if (await ui.exists({ text: 'above your live cap', sel: 'h2, h3, div' })) await ui.click({ text: 'per trade$|^Cap at', sel: 'button' });
        await ui.pause(1200);
        await ui.click({ testid: 'follow-toggle' });
        await ui.waitFor(heading('Arm live copying'), 6000);
        await ui.point(heading('Arm live copying'), { dy: 70, hold: 3000, glow: 3000 });
        await ui.click(btn('Cancel'));
        await ui.pause(400);
      },
    },
    {
      line: 7,
      do: async (ui) => {
        await ui.point('[data-testid=mode-switch]', { hold: 3200, glow: 3400 });
        await ui.point(CARD, { hold: 3600, glow: 3600 });
      },
    },
    {
      line: 8,
      do: async (ui) => {
        await ui.point(CARD, { hold: 2400, glow: 2400 });
        await ui.click(btn('Paper', CARD));
        await ui.pause(500);
        // Switching to Live pauses the follow until it is armed; back on
        // paper it stays paused, so resume it: the card should end running.
        await resumeCard(ui);
        await ui.pause(400);
      },
    },
    {
      line: 9,
      do: async (ui) => {
        await go(ui, 'wallet', /Wallet/);
        await ui.click({ testid: 'tab-pump' });
        await ui.waitFor({ expr: `/Callout rewards/.test(document.querySelector('main')?.textContent || '')` }, 10_000);
        await ui.pause(500);
        await opt(ui.point({ testid: 'copy-callouts' }, { hold: 1800, glow: 2000 }));
        await opt(ui.point({ testid: 'pump-new-wallet' }, { hold: 2600, glow: 2600 }));
        await opt(ui.point({ text: 'Callout rewards', sel: 'h2, h3, div, span' }, { hold: 1800 }));
      },
    },
  ],
  async cleanup(ui) {
    // Every follow back on paper, whatever the take did.
    await go(ui, 'following', /Following/).catch(() => {});
    for (let i = 0; i < 4; i++) {
      const live = { text: '^live$', sel: `${CARD} span` };
      if (!(await ui.exists(live))) break;
      await ui.click(btn('Paper', CARD)).catch(() => {});
      await ui.pause(500);
    }
    await resumeCard(ui).catch(() => {});
  },
};

/** A paused card shows Resume (the toggle); press it so the follow runs on paper again. */
async function resumeCard(ui) {
  const resume = { text: '^Resume$', sel: 'button', within: CARD };
  if (await ui.exists(resume)) {
    await ui.click(resume);
    await ui.pause(500);
  }
}
