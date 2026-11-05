// Speed with your own RPC: Settings › Solana RPC, endpoint by endpoint, in
// the order a copy meets them. The execution URL typed here is a made-up
// one: it is cleared again in the same step and never saved, so "Measure"
// times the profile's own saved (public) endpoints. Nothing is saved; no
// switch is flipped.

import { closeAdvanced, go, openAdvanced, opt } from './_app.mjs';

const EXEC_INPUT = '[data-testid=rpc-exec] input';
const FAKE_EXEC = 'https://your-provider.example.com/?api-key=your-key';
const HELIUS = '[data-testid=rpc-helius]';

export default {
  posterAt: 66,
  async prepare(ui) {
    await go(ui, 'home', /Good (morning|afternoon|evening)/);
  },
  steps: [
    {
      line: 0,
      do: async (ui) => {
        await ui.click({ testid: 'nav-settings' });
        await ui.waitFor({ testid: 'settings-advanced' }, 10_000);
        await ui.point({ testid: 'settings-advanced' }, { hold: 1400, glow: 1400 });
        await openAdvanced(ui);
        await ui.waitFor({ text: '^Solana RPC$', sel: 'h2' }, 10_000);
        await ui.pause(600);
        await ui.point({ text: '^Solana RPC$', sel: 'h2' }, { hold: 2600, glow: 2600 });
      },
    },
    {
      line: 1,
      do: async (ui) => {
        await opt(ui.point({ text: 'free public endpoints', sel: 'p' }, { hold: 3000, glow: 3000 }));
        await ui.hover('[data-testid=rpc-wss] input', { hold: 2200 });
      },
    },
    { line: 2, do: async (ui) => ui.point('[data-testid=rpc-wss]', { hold: 3600, glow: 4000 }) },
    { line: 3, do: async (ui) => ui.point('[data-testid=rpc-extra-wss]', { hold: 3400, glow: 3800 }) },
    { line: 4, do: async (ui) => ui.point('[data-testid=rpc-http]', { hold: 3000, glow: 3400 }) },
    { line: 5, do: async (ui) => ui.point('[data-testid=rpc-exec]', { hold: 3800, glow: 4200 }) },
    {
      line: 6,
      do: async (ui) => {
        await ui.type(EXEC_INPUT, FAKE_EXEC, { perChunk: 70, clear: true });
        await ui.pause(2600);
        await clearExec(ui);
      },
    },
    {
      line: 7,
      do: async (ui) => {
        await ui.point('[data-testid=rpc-save]', { hold: 1400, glow: 1600 });
        await ui.click({ text: '^Measure$', sel: 'button', within: '[data-testid=rpc-probe]' });
        await ui.waitFor('[data-testid=rpc-probe-rows]', 30_000);
        await ui.pause(500);
        await ui.point('[data-testid=rpc-probe-rows]', { hold: 1600, glow: 2400 });
      },
    },
    {
      line: 8,
      do: async (ui) => {
        await ui.point('[data-testid=rpc-probe-rows] > div:first-child .text-label', { hold: 2600, glow: 2800 });
        await opt(ui.point('[data-testid=rpc-probe-rows] > div:nth-child(2) .text-label', { hold: 2200, glow: 2400 }));
      },
    },
    {
      line: 9,
      do: async (ui) => ui.point({ text: '^Watch followed wallets on Parsed Streams', sel: 'label', within: HELIUS }, { hold: 4200, glow: 4600 }),
    },
    {
      line: 10,
      do: async (ui) => ui.point({ text: '^Helius feed socket', sel: 'label', within: HELIUS }, { hold: 4200, glow: 4600 }),
    },
    {
      line: 11,
      do: async (ui) => {
        await ui.point('[data-testid=rpc-save]', { hold: 2400, glow: 2600 });
        await ui.pause(1500);
      },
    },
  ],
  async cleanup(ui) {
    // The made-up endpoint must never reach a save: if the step stopped
    // half way, empty the field (it was empty in the tutorial profile).
    if (await ui.exists(EXEC_INPUT)) {
      const v = await ui.evaluate(`document.querySelector(${JSON.stringify(EXEC_INPUT)})?.value || ''`);
      if (v.includes('example.com')) await clearExec(ui);
    }
    await closeAdvanced(ui).catch(() => {});
  },
};

async function clearExec(ui) {
  await ui.click(EXEC_INPUT, { after: 100 });
  await ui.press('a', { ctrl: true });
  await ui.press('Backspace');
  await ui.pause(300);
  const v = await ui.evaluate(`document.querySelector(${JSON.stringify(EXEC_INPUT)})?.value || ''`);
  if (v) throw new Error(`the made-up execution endpoint is still in the field: ${v}`);
}
