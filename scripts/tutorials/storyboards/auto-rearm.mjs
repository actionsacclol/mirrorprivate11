// Auto re-arm. Reads the switches and never changes them. The follow's pause on
// screen is seeded before the instance starts, on the tutorial profile's paper
// follow: the recorder cannot make real sends fail. In copytrade.json set
// enabled:false, pausedBy:'fails', pausedReason, pausedAt and rearmAt 30 minutes
// out; it comes back by itself, or Keep it off ends it, which line 6 does.

import { closeAdvanced, go, heading, openAdvanced } from './_app.mjs';

const SEC = '[data-testid=rearm-section]';
const sw = (t) => heading(t, SEC);

export default {
  posterAt: 8,
  async prepare(ui) {
    await go(ui, 'settings', /Settings/);
    await ui.waitFor({ testid: 'settings-advanced' }, 10_000);
    await closeAdvanced(ui);
  },
  steps: [
    {
      line: 0,
      do: async (ui) => {
        await ui.point({ testid: 'settings-advanced' }, { hold: 1500, glow: 1500 });
        await openAdvanced(ui);
        await ui.waitFor({ testid: 'rearm-section' }, 10_000);
        await ui.point(heading('Auto re-arm'), { hold: 2000, glow: 2200 });
      },
    },
    {
      line: 1,
      do: async (ui) => {
        await ui.point(sw('Failed trades'), { hold: 4000, glow: 4400 });
        await ui.point(sw('Slippage failures can pause a follow'), { hold: 2400, glow: 2400 });
      },
    },
    {
      line: 2,
      do: async (ui) => {
        await ui.point(sw('pump.fun upgrades'), { hold: 3200, glow: 3200 });
      },
    },
    {
      line: 3,
      do: async (ui) => {
        await ui.point(sw('Live loss limits'), { hold: 5400, glow: 5800 });
      },
    },
    {
      line: 4,
      do: async (ui) => {
        await ui.point(sw("A follow's own loss stop"), { hold: 1500, glow: 1500 });
        await ui.point(sw('App restarts'), { hold: 2400, glow: 2400 });
      },
    },
    {
      line: 5,
      do: async (ui) => {
        await ui.point({ text: '^Failures before a pause$', sel: 'span' }, { hold: 1000, glow: 1000 });
        await ui.point({ text: '^First wait$', sel: 'span' }, { hold: 700, glow: 700 });
        await ui.point({ text: 'Comebacks in a row', sel: 'span' }, { hold: 1800, glow: 1800 });
      },
    },
    {
      line: 6,
      do: async (ui) => {
        await go(ui, 'following', /Following/);
        await ui.waitFor({ testid: 'follow-autopaused' }, 10_000);
        await ui.point({ testid: 'follow-autopaused' }, { hold: 1200, glow: 1200 });
        await ui.point({ testid: 'follow-keep-off' }, { hold: 500, glow: 500 });
        await ui.click({ testid: 'follow-keep-off' });
        await ui.pause(800);
      },
    },
    {
      line: 7,
      do: async (ui) => {
        await go(ui, 'settings', /Settings/);
        await ui.waitFor({ testid: 'rearm-section' }, 10_000);
        await ui.point(heading('Auto re-arm'), { hold: 800 });
        await ui.point({ testid: 'rearm-always' }, { hold: 1600, glow: 1600 });
      },
    },
    {
      line: 8,
      do: async (ui) => {
        await ui.point(heading('Leaving it running'), { hold: 2600, glow: 2600 });
        await ui.point({ text: '^Keep this computer awake$', sel: 'div, span, label' }, { hold: 3000, glow: 3000 });
      },
    },
  ],
  async cleanup(ui) {
    await closeAdvanced(ui).catch(() => {});
  },
};
