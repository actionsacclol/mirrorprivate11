// Quickstart: first run → Home → Discover → a profile → Follow on paper →
// Following → Activity. Needs the first-run onboarding ON SCREEN, i.e. a
// tutorial profile reset to its first run (README: "Resetting for the
// quickstart"). Lines: shared/guides/videos.ts → quickstart.

import { btn, go, opt } from './_app.mjs';

const OB = '[data-testid=onboarding]';

export default {
  posterAt: 32,
  async prepare(ui) {
    if (!(await ui.exists(OB))) {
      throw new Error('the quickstart needs the first-run onboarding on screen — reset the tutorial profile and relaunch (scripts/tutorials/README.md)');
    }
    await ui.waitFor(btn('Continue', OB), 10_000);
  },
  steps: [
    {
      line: 0,
      do: async (ui) => {
        await ui.hover({ text: 'Welcome to', sel: 'div', within: OB }, { dy: 30, hold: 1800 });
        await opt(ui.hover({ text: '^English', sel: 'button, label, div', within: OB }, { hold: 1200 }));
      },
    },
    {
      line: 1,
      do: async (ui) => {
        await ui.click(btn('Continue', OB));
        await ui.waitFor({ text: 'Before you use', sel: 'p', within: OB }, 8000);
        await ui.hover({ text: 'Before you use', sel: 'p', within: OB }, { dy: 120, hold: 600 });
        await ui.wheel(360, 5);
        await ui.pause(900);
        await ui.wheel(420, 5);
        await ui.pause(700);
        await ui.click(`${OB} input[type=checkbox]`);
        await ui.click({ text: 'I agree', sel: 'button', within: OB });
        await ui.waitFor({ text: 'referred you', sel: 'div', within: OB }, 8000);
      },
    },
    {
      line: 2,
      do: async (ui) => {
        await ui.hover(`${OB} input`, { hold: 1600 });
        await ui.click(btn('Continue', OB));
        await ui.waitFor({ text: 'Connect your data', sel: 'div', within: OB }, 8000);
      },
    },
    {
      line: 3,
      do: async (ui) => {
        await ui.hover({ text: 'Helius API key', sel: 'label, div, span', within: OB }, { hold: 1800 });
        await ui.hover({ text: 'Jupiter API key', sel: 'label, div, span', within: OB }, { hold: 1400 });
        await ui.click(btn('Skip for now', OB));
        await ui.waitFor({ text: 'Your trading wallet', sel: 'div', within: OB }, 8000);
      },
    },
    {
      line: 4,
      do: async (ui) => {
        await ui.hover({ text: 'Use a dedicated hot wallet', sel: 'span, p', within: OB }, { hold: 2000 });
        await ui.click(btn('Later', OB));
        await ui.waitFor({ text: 'Paper first, always', sel: 'div', within: OB }, 8000);
      },
    },
    {
      line: 5,
      do: async (ui) => {
        await ui.point({ text: 'Paper first, always', sel: 'div', within: OB }, { hold: 2200, glow: 2200 });
        await ui.click(btn('Start following', OB));
        await ui.waitFor({ expr: `!document.querySelector('${OB}')` }, 8000);
      },
    },
    {
      line: 6,
      do: async (ui) => {
        await ui.point({ testid: 'home-setup' }, { hold: 2400, glow: 2400 });
        await ui.point({ testid: 'home-paper' }, { hold: 1500 });
      },
    },
    {
      line: 7,
      do: async (ui) => {
        await go(ui, 'discover', /Discover/);
        await ui.waitFor({ expr: `document.querySelectorAll('[data-testid=scout-row]').length > 0 || !!document.querySelector('[data-testid=discover-verdict]')` }, 25_000);
        await ui.hover({ testid: 'discover-views' }, { hold: 1200 });
        await opt(ui.hover('[data-testid=scout-row]', { hold: 1200 }));
      },
    },
    {
      line: 8,
      do: async (ui) => {
        await ui.point({ testid: 'discover-verdict' }, { hold: 2600, glow: 2600 });
        await opt(ui.hover({ text: 'floor', sel: 'span, div, th' }, { hold: 1400 }));
      },
    },
    {
      line: 9,
      do: async (ui) => {
        await ui.click('[data-testid=scout-row]');
        await ui.waitFor({ testid: 'wallet-profile' }, 10_000);
        await ui.pause(700);
        await ui.point({ testid: 'profile-verdict' }, { hold: 2600, glow: 2600 });
        await opt(ui.point({ testid: 'profile-cautions' }, { hold: 1600 }));
      },
    },
    {
      line: 10,
      do: async (ui) => {
        await ui.click({ testid: 'profile-follow' });
        await ui.waitFor({ testid: 'follow-page' }, 8000);
        await ui.point({ testid: 'follow-sizing' }, { hold: 1600 });
        await ui.point({ testid: 'follow-summary' }, { hold: 1800 });
        await ui.click({ testid: 'follow-start' });
        await ui.waitFor({ testid: 'follow-card' }, 10_000);
      },
    },
    {
      line: 11,
      do: async (ui) => {
        await ui.point({ testid: 'follow-card' }, { hold: 1600, glow: 2400 });
        await ui.hover({ testid: 'follow-toggle' }, { hold: 1300 });
        await opt(ui.hover({ text: '^Live$', sel: 'button', within: '[data-testid=follow-card]' }, { hold: 1300 }));
      },
    },
    {
      line: 12,
      do: async (ui) => {
        await go(ui, 'activity', /Activity/);
        await ui.hover({ testid: 'tab-copies' }, { hold: 1300 });
        await ui.hover({ testid: 'tab-positions' }, { hold: 900 });
        await ui.hover({ testid: 'tab-history' }, { hold: 900 });
      },
    },
    {
      line: 13,
      do: async (ui) => {
        await go(ui, 'home', /Good (morning|afternoon|evening)/);
        await ui.hover({ text: '^Your follows$', sel: 'h2, h3, div' }, { hold: 2200 });
        await ui.moveTo(1120, 720);
      },
    },
  ],
};
