// Discover, Check and the wallet profile. The checked wallet is the board's
// first ranked one on the day of the take; its replay runs for real
// (chain-priced, nothing traded), so the take waits for it.

import { addressOnProfile, btn, go, heading, opt } from './_app.mjs';

let address = '';

async function clickNth(ui, container, n) {
  const spec = `${container} button:nth-of-type(${n})`;
  if (await ui.exists(spec)) await ui.click(spec);
}

export default {
  posterAt: 5,
  async prepare(ui) {
    await go(ui, 'discover', /Discover/);
    await ui.waitFor({ expr: `document.querySelectorAll('[data-testid=scout-row]').length > 0` }, 30_000);
    await ui.click('[data-testid=scout-row]');
    address = await addressOnProfile(ui);
    await go(ui, 'home', /Good (morning|afternoon|evening)/);
  },
  steps: [
    {
      line: 0,
      do: async (ui) => {
        await go(ui, 'discover', /Discover/);
        await ui.waitFor({ expr: `document.querySelectorAll('[data-testid=scout-row]').length > 0` }, 25_000);
        await ui.point(btn('Best to copy', '[data-testid=discover-views]'), { hold: 1400 });
        await opt(ui.hover('[data-testid=scout-row]', { hold: 1000 }));
        await opt(ui.hover('[data-testid=scout-row]:nth-of-type(3)', { hold: 900 }));
      },
    },
    {
      line: 1,
      do: async (ui) => {
        await ui.point({ testid: 'discover-window' }, { hold: 700 });
        await clickNth(ui, '[data-testid=discover-window]', 2);
        await ui.pause(900);
        await clickNth(ui, '[data-testid=discover-window]', 1);
        await ui.point({ testid: 'discover-size' }, { hold: 600 });
        await clickNth(ui, '[data-testid=discover-size]', 2);
        await ui.pause(900);
        await opt(ui.point({ text: 'floor', sel: 'span, div, th' }, { hold: 1600, glow: 1600 }));
        await clickNth(ui, '[data-testid=discover-size]', 1);
      },
    },
    {
      line: 2,
      do: async (ui) => {
        for (const t of ['Copier return', 'Week total', 'Most profitable', 'Most active', 'Saved', 'pump\\.fun top', 'The test']) {
          await opt(ui.hover({ text: `^${t}`, sel: 'button', within: '[data-testid=discover-views]' }, { hold: 800 }));
        }
        await opt(ui.click({ text: '^Most profitable$', sel: 'button', within: '[data-testid=discover-views]' }));
        await ui.pause(1400);
        await opt(ui.click(btn('Best to copy', '[data-testid=discover-views]')));
        await ui.pause(600);
      },
    },
    {
      line: 3,
      do: async (ui) => {
        const chip = { text: 'bot|creator|bundle|wash|fast|sniper|shared', flags: 'i', sel: '[data-testid=scout-row] span' };
        if (await ui.exists(chip)) await ui.point(chip, { hold: 2400, glow: 2400 });
        else await opt(ui.hover('[data-testid=scout-row]:nth-of-type(2)', { hold: 2400 }));
      },
    },
    {
      line: 4,
      do: async (ui) => {
        const rec = (await ui.exists({ testid: 'discover-record-line' })) ? { testid: 'discover-record-line' } : { text: 'own record', sel: 'div, span, h2, h3' };
        await opt(ui.point(rec, { hold: 2600, glow: 2600 }));
        await opt(ui.point({ testid: 'discover-scorecard' }, { hold: 1600 }));
      },
    },
    {
      line: 5,
      do: async (ui) => {
        await go(ui, 'check', /Check a wallet/);
        await ui.type({ testid: 'check-input' }, address, { perChunk: 35 });
        await ui.click({ testid: 'check-go' });
        await ui.waitFor({ testid: 'check-wallet' }, 10_000);
        await ui.point({ testid: 'check-sizing' }, { hold: 1400 });
      },
    },
    {
      line: 6,
      do: async (ui) => {
        // Points at the switch only: a whole-week check spends up to 8,500 credits.
        await ui.point({ testid: 'check-span' }, { hold: 1400, glow: 1600 });
        await opt(ui.hover({ text: '^Newest 30 trades$', sel: 'button', within: '[data-testid=check-span]' }, { hold: 1600 }));
        await opt(ui.point({ text: '^Whole week$', sel: 'button', within: '[data-testid=check-span]' }, { hold: 2600, glow: 2600 }));
      },
    },
    {
      line: 7,
      do: async (ui) => {
        await opt(ui.hover({ testid: 'profile-replay-status' }, { hold: 600 }));
        // Until the replay is priced, then its figures. With a Helius key in
        // the tutorial profile that is seconds; without one the public RPC
        // rate-limits the read, so the take moves on after a short wait
        // rather than filming a spinner.
        await opt(ui.waitFor({ expr: `!!document.querySelector('[data-testid=profile-replay-trips]') || /no trades|nothing to replay|0 trades/i.test(document.querySelector('[data-testid=profile-replay-status]')?.textContent || '')` }, 25_000));
        await opt(ui.point({ testid: 'profile-replay-status' }, { hold: 2000, glow: 2000 }));
        await opt(ui.point({ testid: 'profile-replay-trips' }, { hold: 1400 }));
      },
    },
    {
      line: 8,
      do: async (ui) => {
        await opt(ui.waitFor({ testid: 'replay-week-verdict' }, 20_000));
        await opt(ui.point({ testid: 'replay-week-verdict' }, { hold: 3600, glow: 3800 }));
      },
    },
    {
      line: 9,
      do: async (ui) => {
        await ui.point({ testid: 'book-edit' }, { hold: 900, glow: 1100 });
        await ui.click({ testid: 'book-edit' });
        await ui.waitFor({ testid: 'book-form' }, 4000);
        await ui.point({ testid: 'book-form' }, { hold: 2400 });
        await ui.click({ text: '^Cancel$', sel: 'button', within: '[data-testid=book-form]' });
      },
    },
    {
      line: 10,
      do: async (ui) => {
        await ui.click({ testid: 'check-profile' });
        await ui.waitFor({ testid: 'wallet-profile' }, 10_000);
        await ui.pause(700);
        await ui.point({ testid: 'profile-verdict' }, { hold: 2400, glow: 2600 });
        await opt(ui.point('[data-testid^=profile-copy-]', { hold: 1600 }));
        await opt(ui.point({ testid: 'profile-feed-saw' }, { hold: 1600 }));
      },
    },
    {
      line: 11,
      do: async (ui) => {
        await opt(ui.point({ testid: 'profile-cautions' }, { hold: 2200, glow: 2200 }));
        // "Follow on paper", or "Manage follow" when the profile is already followed.
        const follow = (await ui.exists({ testid: 'profile-follow' })) ? { testid: 'profile-follow' } : { text: '^Manage follow$', sel: 'button' };
        await ui.hover(follow, { hold: 1800 });
      },
    },
  ],
};
