// The wallet password. Turns it on for the tutorial profile's throwaway wallet
// (made by wallet-live, never funded) and turns it off again at the end.
//
// The password window is its own window, which the recorder cannot see, so each
// time it opens the take grabs a picture of the real thing and lays it over the
// page for as long as it is on screen. The recovery key is blurred in the
// picture: nothing that opens a wallet goes in a video, throwaway or not.

import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { go, heading, opt } from './_app.mjs';

/** Press a button on one of the tutorial instance's native dialogs. */
const DIALOG = fileURLToPath(new URL('../lib/dialog.ps1', import.meta.url));
const pressNative = async (text) => {
  for (let i = 0; i < 40; i++) {
    const r = execFileSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', DIALOG, 'click', text], { encoding: 'utf8' });
    if (!/^(ERR|none|no )/i.test(r.trim())) return;
    await new Promise((d) => setTimeout(d, 150));
  }
  throw new Error('no native dialog to press: ' + text);
};

const PW = 'plum rocket velvet harbor 7';
const PORT = 9333;
const LAYER = '__tutPromptLayer';

async function promptTarget() {
  for (let i = 0; i < 60; i++) {
    const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
    const t = list.find((x) => x.url.startsWith('data:text/html'));
    if (t) return t;
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error('the password window did not open');
}

/** A connection to that window: lib/cdp.mjs only finds the main page. */
async function client(url) {
  const ws = new WebSocket(url);
  await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
  let id = 0;
  const wait = new Map();
  ws.onmessage = (m) => {
    const d = JSON.parse(m.data);
    const w = wait.get(d.id);
    if (w) { wait.delete(d.id); d.error ? w.j(new Error(d.error.message)) : w.r(d.result); }
  };
  ws.onclose = () => { for (const w of wait.values()) w.j(new Error('the password window closed')); wait.clear(); };
  const send = (method, params = {}) => new Promise((r, j) => {
    const my = ++id;
    wait.set(my, { r, j });
    ws.send(JSON.stringify({ id: my, method, params }));
  });
  const evaluate = async (expression) => (await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })).result?.value;
  return { send, evaluate, close: () => ws.close() };
}

/** The open password window, whichever screen it is on. */
async function openPrompt() {
  const t = await promptTarget();
  const cdp = await client(t.webSocketDebuggerUrl);
  await cdp.send('Page.enable');
  const title = () => cdp.evaluate(`document.querySelector('h1')?.textContent ?? ''`);
  for (let i = 0; i < 40 && !(await title()); i++) await new Promise((r) => setTimeout(r, 100));
  return {
    cdp,
    title,
    fill: (o) => cdp.evaluate(`(()=>{for(const [k,v] of Object.entries(${JSON.stringify(o)})){const e=document.querySelector('[data-field='+k+']');if(e)e.value=v}})()`),
    code: () => cdp.evaluate(`document.querySelector('.code')?.textContent ?? ''`),
    submit: () => cdp.evaluate(`void document.querySelector('[data-role=submit]').click()`),
    cancel: () => cdp.evaluate(`void document.querySelector('[data-role=cancel]').click()`),
    /** A picture of the window, with any recovery key blurred. */
    picture: async () => {
      await cdp.evaluate(`document.querySelectorAll('.code').forEach((e)=>{e.style.filter='blur(7px)'})`);
      const r = await cdp.send('Page.captureScreenshot', { format: 'png' });
      await cdp.evaluate(`document.querySelectorAll('.code').forEach((e)=>{e.style.filter=''})`);
      return r.data;
    },
    close: () => cdp.close(),
  };
}

const showPicture = (ui, png) =>
  ui.evaluate(`(()=>{
    let d=document.getElementById('${LAYER}');
    if(!d){d=document.createElement('div');d.id='${LAYER}';d.style.cssText='position:fixed;inset:0;z-index:2147483000;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,.55)';document.body.appendChild(d);}
    d.innerHTML='<img style="border-radius:14px;box-shadow:0 18px 60px rgba(0,0,0,.6);border:1px solid rgba(255,255,255,.14);zoom:1.35" src="data:image/png;base64,${png}">';
  })()`);
const hidePicture = (ui) => ui.evaluate(`document.getElementById('${LAYER}')?.remove()`);

const nextScreen = async (p, before) => {
  for (let i = 0; i < 100; i++) {
    const open = (await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()).some((x) => x.url.startsWith('data:text/html'));
    if (!open) return 'closed';
    if ((await p.title().catch(() => before)) !== before) return 'next';
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error('the password window did not move on');
};
const gone = async () => {
  for (let i = 0; i < 50; i++) {
    const open = (await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()).some((x) => x.url.startsWith('data:text/html'));
    if (!open) return;
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error('the password window did not close');
};

let prompt = null;
let recovery = '';

export default {
  posterAt: 6,
  async prepare(ui) {
    await go(ui, 'settings', /Settings/);
    await ui.waitFor({ testid: 'vault-section' }, 10_000);
  },
  steps: [
    {
      line: 0,
      do: async (ui) => {
        await ui.point(heading('Wallet password'), { hold: 3800, glow: 4200 });
        await ui.hover({ testid: 'vault-turn-on' }, { hold: 1400 });
      },
    },
    {
      line: 1,
      do: async (ui) => {
        await ui.click({ testid: 'vault-turn-on' });
        prompt = await openPrompt();
        await prompt.fill({ password: PW, repeat: PW });
        await showPicture(ui, await prompt.picture());
        await ui.pause(2800);
      },
    },
    {
      line: 2,
      do: async (ui) => {
        const before = await prompt.title();
        await prompt.submit();
        await nextScreen(prompt, before);
        recovery = await prompt.code();
        if (!recovery) throw new Error('no recovery key on screen');
        await showPicture(ui, await prompt.picture());
        await ui.pause(6000);
      },
    },
    {
      line: 3,
      do: async (ui) => {
        await prompt.fill({ check: recovery.split('-').pop() });
        await showPicture(ui, await prompt.picture());
        const before = await prompt.title();
        await ui.pause(1800);
        await prompt.submit();
        await nextScreen(prompt, before);
        await prompt.submit().catch(() => {});
        await gone();
        prompt.close();
        prompt = null;
        await hidePicture(ui);
        await ui.waitFor({ testid: 'vault-state' }, 12_000);
        await ui.pause(800);
      },
    },
    {
      line: 4,
      do: async (ui) => {
        await ui.point({ testid: 'vault-state' }, { hold: 1800, glow: 1800 });
        await ui.point({ text: '^Can auto-trade', sel: 'div', within: 'section, main' }, { hold: 4000, glow: 4000 });
      },
    },
    {
      line: 5,
      do: async (ui) => {
        await ui.hover({ text: '^Can auto-trade', sel: 'div', within: 'section, main' }, { hold: 6000 });
      },
    },
    {
      line: 6,
      do: async (ui) => {
        await ui.evaluate(`void window.krypt.settings.get().then((r)=>{const s=r.data??r;return window.krypt.settings.update({execution:{...s.execution,maxLiveSol:s.execution.maxLiveSol*2}})})`);
        prompt = await openPrompt();
        await showPicture(ui, await prompt.picture());
        await ui.pause(6000);
        await prompt.cancel();
        await gone();
        prompt.close();
        prompt = null;
        await hidePicture(ui);
      },
    },
    {
      line: 7,
      do: async (ui) => {
        await ui.point({ testid: 'vault-lock' }, { hold: 3200, glow: 3200 });
        await ui.click({ testid: 'vault-lock' });
        await pressNative('Stop trading and lock');
        await ui.waitFor({ testid: 'vault-chip' }, 10_000);
        await ui.point({ testid: 'vault-chip' }, { hold: 3400, glow: 3400 });
      },
    },
    {
      line: 8,
      do: async (ui) => {
        await ui.click({ testid: 'vault-unlock' });
        prompt = await openPrompt();
        await prompt.fill({ password: PW });
        await showPicture(ui, await prompt.picture());
        await ui.pause(5200);
        await prompt.submit();
        await gone();
        prompt.close();
        prompt = null;
        await hidePicture(ui);
        await opt(ui.waitFor({ testid: 'vault-lock' }, 6000));
        await ui.pause(1000);
      },
    },
  ],
  async cleanup(ui) {
    await hidePicture(ui).catch(() => {});
    if (prompt) {
      await prompt.cancel().catch(() => {});
      prompt.close();
      prompt = null;
      await gone().catch(() => {});
    }
    await ui.click({ testid: 'vault-turn-off' });
    const p = await openPrompt();
    await p.fill({ password: PW });
    await p.submit();
    await gone();
    p.close();
    await ui.waitFor({ testid: 'vault-turn-on' }, 10_000);
  },
};
