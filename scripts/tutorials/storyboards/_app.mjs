// Shared moves for the storyboards: the app's places and a few target shapes.

export const MAIN = `document.querySelector('main')`;

/** Open the Advanced fold on Settings, if it is closed. */
export async function openAdvanced(ui) {
  if (!(await ui.exists({ testid: 'settings-advanced-body' }))) await ui.click({ testid: 'settings-advanced' });
  await ui.waitFor({ testid: 'settings-advanced-body' }, 5000);
}

/** Close it, so the next take opens Settings as a new user does. */
export async function closeAdvanced(ui) {
  if (await ui.exists({ testid: 'settings-advanced-body' })) await ui.click({ testid: 'settings-advanced' });
}

const CARD_LAYER = '__guide-card';

/**
 * A full-screen card over the app, for what happens outside it: an installer's
 * warning, an exchange's form. These are plain drawings and say so on screen.
 */
export const showCard = (ui, html) =>
  ui.evaluate(`(()=>{
    let d=document.getElementById('${CARD_LAYER}');
    if(!d){d=document.createElement('div');d.id='${CARD_LAYER}';d.style.cssText='position:fixed;inset:0;z-index:2147483000;display:flex;align-items:center;justify-content:center;background:#0b0e14;color:#e8ecf3;font-family:Inter,system-ui,sans-serif';document.body.appendChild(d);}
    d.innerHTML=${JSON.stringify(html)};
  })()`);
export const hideCard = (ui) => ui.evaluate(`document.getElementById('${CARD_LAYER}')?.remove()`);

/** waitFor spec: the main area's text matches `re` (a RegExp). */
export const mainSays = (re) => ({ expr: `${re}.test((${MAIN})?.textContent || '')` });

/** Click a place on the bar and wait for its page. */
export async function go(ui, id, re, ms = 12_000) {
  await ui.click({ testid: `nav-${id}` });
  if (re) await ui.waitFor(mainSays(re), ms);
  await ui.pause(500);
}

/** A button by its exact text, optionally inside a container selector. */
export const btn = (text, within) => ({ text: `^${text}$`, sel: 'button', ...(within ? { within } : {}) });

/** A heading-ish element by exact text. */
export const heading = (text, within) => ({ text: `^${text}$`, sel: 'h1, h2, h3, h4, div, span, label', ...(within ? { within } : {}) });

/** A "look at this" that may be missing on a given day's data: never fails the take. */
export const opt = (p) => p.catch(() => undefined);

/**
 * The full base58 address on an open profile page. The page shows it
 * shortened; the address chip's title carries the whole of it.
 */
export async function addressOnProfile(ui) {
  await ui.waitFor({ testid: 'wallet-profile' }, 10_000);
  const titles = await ui.evaluate(
    `Array.from(document.querySelectorAll('[data-testid=wallet-profile] [title]')).map((e) => e.getAttribute('title')).join('\\n')`,
  );
  const m = /\b[1-9A-HJ-NP-Za-km-z]{32,44}\b/.exec(titles);
  if (!m) throw new Error('no address found on the profile page');
  return m[0];
}

/** Open Discover and the first ranked wallet's profile; returns its address. */
export async function firstBoardWallet(ui) {
  await go(ui, 'discover', /Discover/);
  await ui.waitFor({ expr: `document.querySelectorAll('[data-testid=scout-row]').length > 0` }, 30_000);
  await ui.click('[data-testid=scout-row]');
  return addressOnProfile(ui);
}
