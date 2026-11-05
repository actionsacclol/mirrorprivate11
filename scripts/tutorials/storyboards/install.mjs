// Install the app. What happens before the app opens cannot be filmed from
// inside it, so those lines are drawn cards (each says it is a drawing); from
// the first run on it is the real app. Needs the first-run onboarding on screen
// (README: "instance.ps1 firstrun").

import { btn, go, hideCard, opt, showCard } from './_app.mjs';

const OB = '[data-testid=onboarding]';
const NOTE = "<div style=\"position:absolute;left:0;right:0;bottom:40px;text-align:center;font-size:17px;color:#7d8798\">A drawing, to show what to look for</div>";

const download = '<div style="text-align:center"><div style="font-size:30px;color:#9aa4b4;margin-bottom:18px">Download only from</div><div id="g-url" style="font-size:84px;font-weight:700;letter-spacing:-1px">krypt.cc/mirror</div><div style="font-size:26px;color:#f0b90b;margin-top:34px">A copy from anywhere else could steal your money.</div></div>';

const smartscreen = (second) => '<div style="width:1120px;background:#0a5ea8;color:#fff;padding:60px 64px;border-radius:6px;font-family:Segoe UI,system-ui,sans-serif"><div style="font-size:50px;font-weight:300">Windows protected your PC</div><div style="font-size:24px;margin-top:26px;line-height:1.45">An unrecognized app was stopped from starting.</div>' +
  (second
    ? '<div style="font-size:24px;margin-top:22px;line-height:1.5">App: Krypto Mirror Setup<br>Publisher: Unknown publisher</div><div style="margin-top:56px;text-align:right"><span id="g-run" style="display:inline-block;background:#fff;color:#0a5ea8;padding:14px 40px;font-size:24px;margin-right:14px">Run anyway</span><span style="display:inline-block;border:2px solid #fff;padding:12px 40px;font-size:24px">Don\'t run</span></div>'
    : '<div id="g-more" style="display:inline-block;font-size:24px;margin-top:22px;text-decoration:underline">More info</div><div style="margin-top:56px;text-align:right"><span style="display:inline-block;border:2px solid #fff;padding:12px 40px;font-size:24px">Don\'t run</span></div>') +
  '</div>' + NOTE;

const mac = '<div style="width:1120px;background:#23262d;padding:48px 56px;border-radius:16px"><div style="font-size:24px;color:#9aa4b4">System Settings &rsaquo; Privacy &amp; Security</div><div style="font-size:30px;font-weight:600;margin-top:26px">Security</div><div style="display:flex;align-items:center;justify-content:space-between;gap:30px;margin-top:22px;background:#2e323b;border-radius:12px;padding:26px 30px"><div style="font-size:24px;line-height:1.4">&ldquo;Krypto Mirror&rdquo; was blocked to protect your Mac.</div><span id="g-open" style="flex-shrink:0;background:#4b5160;padding:12px 28px;border-radius:9px;font-size:24px">Open Anyway</span></div></div>' + NOTE;

const linux = '<div style="width:1120px;"><div style="font-size:40px;font-weight:600;margin-bottom:34px">On Linux, either one</div><div style="background:#14181f;border-radius:12px;padding:30px 36px;font-size:27px;line-height:1.5;margin-bottom:22px"><b>The deb file</b>: open it with your software installer.</div><div style="background:#14181f;border-radius:12px;padding:30px 36px;font-size:27px;line-height:1.5"><b>The AppImage file</b>: right-click it, Properties, allow it to run as a program, then open it.</div></div>';

export default {
  posterAt: 5,
  async prepare(ui) {
    if (!(await ui.exists(OB))) throw new Error('this take needs the first-run onboarding on screen: instance.ps1 firstrun');
    await ui.waitFor(btn('Continue', OB), 10_000);
    await showCard(ui, download);
  },
  steps: [
    { line: 0, do: async (ui) => ui.point('#g-url', { hold: 2000, glow: 2600 }) },
    { line: 1, do: async (ui) => { await showCard(ui, smartscreen(false)); await ui.pause(2000); } },
    {
      line: 2,
      do: async (ui) => {
        await ui.point('#g-more', { hold: 450, glow: 900 });
        await showCard(ui, smartscreen(true));
        await ui.pause(400);
        await ui.point('#g-run', { hold: 1500, glow: 1500 });
      },
    },
    { line: 3, do: async (ui) => { await showCard(ui, mac); await ui.pause(2400); await ui.point('#g-open', { hold: 2600, glow: 2600 }); } },
    { line: 4, do: async (ui) => { await showCard(ui, linux); await ui.pause(2000); } },
    {
      line: 5,
      do: async (ui) => {
        await hideCard(ui);
        await ui.hover({ text: 'Welcome to', sel: 'div', within: OB }, { dy: 30, hold: 900 });
        await ui.click(btn('Continue', OB));
        await ui.waitFor({ text: 'Before you use', sel: 'p', within: OB }, 8000);
        await ui.pause(1200);
        await ui.click(`${OB} input[type=checkbox]`);
        await ui.click({ text: 'I agree', sel: 'button', within: OB });
        await ui.waitFor({ text: 'referred you', sel: 'div', within: OB }, 8000);
      },
    },
    {
      line: 6,
      do: async (ui) => {
        await ui.click(btn('Continue', OB));
        await ui.waitFor({ text: 'Free API keys', sel: 'div', within: OB }, 8000);
        await ui.click(btn('Skip for now', OB));
        await ui.waitFor({ text: 'Your trading wallet', sel: 'div', within: OB }, 8000);
        await ui.click(btn('Later', OB));
        await ui.waitFor({ text: 'Press your balance', sel: 'div', within: OB }, 8000);
      },
    },
    {
      line: 7,
      do: async (ui) => {
        await ui.point({ text: 'Stuck\\? Press the book button', sel: 'div', within: OB }, { hold: 800, glow: 1400 });
        await ui.click(btn('Start following', OB));
        await ui.waitFor({ expr: `!document.querySelector('${OB}')` }, 8000);
        await ui.point({ testid: 'nav-guides' }, { hold: 1200, glow: 2000 });
      },
    },
    { line: 8, do: async (ui) => ui.point({ testid: 'nav-balance' }, { hold: 3000, glow: 3200 }) },
    {
      line: 9,
      do: async (ui) => {
        await ui.click({ testid: 'nav-guides' });
        await ui.pause(900);
        await opt(ui.hover({ text: 'Start here', sel: 'button, span' }, { hold: 1400 }));
        await opt(ui.point({ text: '^Checklist: get SOL', sel: 'button, span' }, { hold: 2000, glow: 2000 }));
        await go(ui, 'home', /Good (morning|afternoon|evening)/);
      },
    },
  ],
  async cleanup(ui) {
    await hideCard(ui).catch(() => {});
  },
};
