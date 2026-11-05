// Checklist: get SOL and go live. Optional, and only a guide: nothing in the app
// asks for it. The exchange steps are drawn cards with no real exchange's look.
// Needs the fresh paper follow a follow-settings take just made: an older one
// carries old limits, which contradicts the narration. Makes
// the throwaway tutorial wallet if there is none (never funded). It points at the
// Live switches and never presses them.

import { btn, go, heading, hideCard, opt, showCard } from './_app.mjs';

const CARD = '[data-testid=follow-card]';

const row = (n, t) => `<div style="display:flex;gap:18px;align-items:baseline;padding:9px 0;font-size:27px"><span style="width:34px;color:#7d8798;text-align:right">${n}</span><span>${t}</span></div>`;
const list = '<div style="width:1120px;"><div style="font-size:40px;font-weight:600">Your first real money</div><div style="font-size:24px;color:#9aa4b4;margin:10px 0 24px">Optional. You never have to go live.</div>' +
  ['Practice on Paper', 'Make a wallet just for this app', 'Back it up', 'Buy SOL', 'Copy your address', 'Send SOL to it', 'Set your limits, if you want any', 'Go live', 'Keep watch at first'].map((t, i) => row(i + 1, t)).join('') + '</div>';

const buy = '<div style="width:1120px;"><div style="font-size:40px;font-weight:600;margin-bottom:30px">Where to buy SOL</div><div style="display:flex;gap:24px"><div style="flex:1;background:#14181f;border-radius:14px;padding:32px"><div style="font-size:29px;font-weight:600">An exchange</div><div style="font-size:25px;color:#9aa4b4;margin-top:14px;line-height:1.5">Coinbase, Kraken or Binance, for example. Which ones you can use depends on your country.</div></div><div style="flex:1;background:#14181f;border-radius:14px;padding:32px"><div style="font-size:29px;font-weight:600">A wallet app</div><div style="font-size:25px;color:#9aa4b4;margin-top:14px;line-height:1.5">Phantom, for example. Buy inside the app, then send it to your address.</div></div></div><div style="font-size:24px;color:#f0b90b;margin-top:30px">Some make you wait a few days before you can send what you bought.</div></div>';

const field = (l, v, id) => `<div style="margin-top:20px"><div style="font-size:21px;color:#9aa4b4;margin-bottom:7px">${l}</div><div ${id ? `id="${id}" ` : ''}style="background:#1d222b;border:1px solid #333b48;border-radius:9px;padding:14px 18px;font-size:25px">${v}</div></div>`;
const withdraw = '<div style="width:820px;background:#14181f;padding:40px 46px;border-radius:18px"><div style="font-size:33px;font-weight:600">Withdraw or Send</div>' +
  field('Coin', 'SOL') + field('Network', 'Solana', 'g-net') + field('Address', 'The address you copied from the wallet card', 'g-addr') + field('Amount', 'A small amount first') + '</div>' +
  "<div style=\"position:absolute;left:0;right:0;bottom:40px;text-align:center;font-size:17px;color:#7d8798\">A drawing. Every exchange looks a little different</div>";

export default {
  posterAt: 4,
  async prepare(ui) {
    await go(ui, 'following', /Following/);
    await ui.waitFor(CARD, 10_000);
    await showCard(ui, list);
  },
  steps: [
    { line: 0, do: async (ui) => ui.pause(1500) },
    {
      line: 1,
      do: async (ui) => {
        await hideCard(ui);
        await ui.point(CARD, { hold: 2600, glow: 3000 });
        await opt(ui.hover({ text: '^Paper$', sel: 'button, span', within: CARD }, { hold: 1800 }));
      },
    },
    {
      line: 2,
      do: async (ui) => {
        await go(ui, 'wallet', /Wallet/);
        await opt(ui.click({ testid: 'tab-solana' }));
        if (await ui.exists(btn('Create wallet'))) {
          await ui.point(heading('Make a new wallet for this app'), { hold: 250, glow: 800 });
          await ui.click(btn('Create wallet'));
          await ui.waitFor({ text: 'Deposit address', sel: 'h2, h3, div, span' }, 15_000);
        }
        await ui.pause(500);
      },
    },
    {
      line: 3,
      do: async (ui) => {
        await ui.point(heading('Backup & removal'), { hold: 1500, glow: 2000 });
        await opt(ui.point({ text: 'Export all', sel: 'button' }, { hold: 3000, glow: 3000 }));
      },
    },
    { line: 4, do: async (ui) => { await showCard(ui, buy); await ui.pause(3000); } },
    {
      line: 5,
      do: async (ui) => {
        await hideCard(ui);
        await ui.waitFor({ expr: `/wallet card/.test(document.querySelector('[data-testid=nav-balance]')?.title || '')` }, 10_000);
        await ui.click({ testid: 'nav-balance' });
        await ui.waitFor({ testid: 'wallet-card' }, 5000);
        await ui.point({ testid: 'wallet-card-address' }, { hold: 1500, glow: 1500 });
      },
    },
    {
      line: 6,
      do: async (ui) => {
        await showCard(ui, withdraw);
        await ui.pause(700);
        await ui.point('#g-net', { hold: 1500, glow: 1500 });
        await ui.point('#g-addr', { hold: 2000, glow: 2000 });
      },
    },
    {
      line: 7,
      do: async (ui) => {
        await hideCard(ui);
        await ui.pause(1600);
        await ui.point({ testid: 'wallet-card-refresh' }, { hold: 2000, glow: 2000 });
      },
    },
    {
      line: 8,
      do: async (ui) => {
        await ui.click({ testid: 'wallet-card-close' });
        await opt(ui.point({ text: '^Max SOL / trade$', sel: 'div, span, label' }, { hold: 1200, glow: 1400 }));
        await go(ui, 'following', /Following/);
        await ui.point(CARD, { hold: 1800 });
      },
    },
    {
      line: 9,
      do: async (ui) => {
        await ui.point('[data-testid=mode-switch]', { hold: 3000, glow: 3000 });
        await opt(ui.point({ text: '^Live$', sel: 'button', within: CARD }, { hold: 3000, glow: 3000 }));
      },
    },
    {
      line: 10,
      do: async (ui) => {
        await go(ui, 'activity', /Activity/);
        await ui.hover({ testid: 'tab-copies' }, { hold: 2200 });
      },
    },
    {
      line: 11,
      do: async (ui) => {
        await ui.click({ testid: 'nav-balance' });
        await ui.waitFor({ testid: 'wallet-card' }, 5000);
        await ui.point({ testid: 'wallet-card-send' }, { hold: 3400, glow: 3400 });
        await ui.click({ testid: 'wallet-card-close' });
      },
    },
  ],
  async cleanup(ui) {
    await hideCard(ui).catch(() => {});
    if (await ui.exists({ testid: 'wallet-card-close' })) await ui.click({ testid: 'wallet-card-close' }).catch(() => {});
  },
};
