// The tutorial driver (2026-10-25): moves a drawn cursor around the page,
// clicks and types with REAL input events (Input.dispatchMouseEvent /
// dispatchKeyEvent, so hover and focus styles behave), and points at things.
//
// The cursor, the click ripple and the spotlight are DOM overlays injected
// into the page (a screencast never carries the OS pointer). They sit above
// everything, take no pointer events, and are removed by `uninstall()`.
//
// Targets: a CSS selector string, { testid }, or { text, sel?, within? }
// (text is a regex source; the tightest visible match wins).

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const CURSOR_SVG =
  '<svg width="28" height="28" viewBox="0 0 24 24"><path d="M5 3l14 9-6 1.5L16.5 20l-2.5 1-3.5-6.5L6 19z" fill="#fff" stroke="#111" stroke-width="1.6" stroke-linejoin="round"/></svg>';

/** Installed into the page once; idempotent. Everything lives on window.__tut. */
const PAGE_RUNTIME = `(() => {
  if (window.__tut && document.getElementById('__tut-cursor')) return 'present';
  const Z = 2147483647;
  const cur = document.createElement('div');
  cur.id = '__tut-cursor';
  cur.style.cssText = 'position:fixed;left:0;top:0;width:28px;height:28px;z-index:' + Z + ';pointer-events:none;filter:drop-shadow(0 1px 2px rgba(0,0,0,.6));will-change:transform;';
  cur.innerHTML = ${JSON.stringify(CURSOR_SVG)};
  document.documentElement.appendChild(cur);
  const style = document.createElement('style');
  style.id = '__tut-style';
  style.textContent = [
    '#__tut-ripple{position:fixed;width:40px;height:40px;margin:-20px 0 0 -20px;border-radius:50%;background:rgba(96,165,250,.45);border:2px solid rgba(147,197,253,.95);z-index:' + (Z - 1) + ';pointer-events:none;opacity:0;transform:scale(.3)}',
    '#__tut-ripple.go{animation:__tut-rip .5s ease-out forwards}',
    '@keyframes __tut-rip{0%{opacity:.9;transform:scale(.3)}100%{opacity:0;transform:scale(1.5)}}',
    '.__tut-spot{position:fixed;border-radius:12px;outline:2px solid rgba(96,165,250,.95);box-shadow:0 0 0 6px rgba(96,165,250,.22),0 0 24px rgba(96,165,250,.35);z-index:' + (Z - 2) + ';pointer-events:none;opacity:0;transition:opacity .25s}',
    '.__tut-spot.on{opacity:1}',
    // The tutorial profile's badge in the bar: not something every install has.
    'button[title^="Which profile this window is"]{display:none !important}',
    // No blinking caret / selection flicker in captures.
    '*{caret-color:transparent !important}',
  ].join('\\n');
  document.documentElement.appendChild(style);
  const rip = document.createElement('div');
  rip.id = '__tut-ripple';
  document.documentElement.appendChild(rip);

  const state = { x: 960, y: 540 };
  const place = () => { cur.style.transform = 'translate(' + (state.x - 5.8) + 'px,' + (state.y - 3.5) + 'px)'; };
  place();
  const ease = (t) => 1 - Math.pow(1 - t, 3);
  function moveTo(x, y, ms) {
    return new Promise((res) => {
      const sx = state.x, sy = state.y, t0 = performance.now();
      const step = (now) => {
        const t = Math.min(1, (now - t0) / ms);
        const k = ease(t);
        state.x = sx + (x - sx) * k;
        state.y = sy + (y - sy) * k;
        place();
        if (t < 1) requestAnimationFrame(step); else res();
      };
      requestAnimationFrame(step);
    });
  }
  function ripple(x, y) {
    rip.style.left = x + 'px';
    rip.style.top = y + 'px';
    rip.classList.remove('go');
    void rip.offsetWidth;
    rip.classList.add('go');
  }
  function visible(el) {
    if (!el) return false;
    const r = el.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) return false;
    const cs = getComputedStyle(el);
    return cs.visibility !== 'hidden' && cs.display !== 'none';
  }
  function find(spec) {
    if (typeof spec === 'string') return document.querySelector(spec);
    if (spec.testid) return document.querySelector('[data-testid="' + spec.testid + '"]');
    if (spec.text) {
      const re = new RegExp(spec.text, spec.flags || '');
      const sel = spec.sel || 'button, a, [role=button], label, h1, h2, h3, h4, p, span, div, td, th, li, summary';
      const root = spec.within ? document.querySelector(spec.within) : document;
      if (!root) return null;
      let best = null, bestLen = Infinity;
      for (const el of root.querySelectorAll(sel)) {
        const t = (el.textContent || '').trim();
        if (!t || !re.test(t) || !visible(el)) continue;
        if (t.length < bestLen) { best = el; bestLen = t.length; }
      }
      return best;
    }
    return null;
  }
  function rect(spec) {
    const el = find(spec);
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: r.left, y: r.top, w: r.width, h: r.height, cx: r.left + r.width / 2, cy: r.top + r.height / 2 };
  }
  // Something else under the element's centre — a sticky page header, a
  // toast — would take the click instead. (Our own overlay never hits:
  // it is pointer-events none.)
  function covered(el, r) {
    const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    if (!hit) return true;
    return !(hit === el || el.contains(hit) || hit.contains(el));
  }
  function reveal(spec, block) {
    const el = find(spec);
    if (!el) return false;
    const r = el.getBoundingClientRect();
    const inside = r.top >= 64 && r.bottom <= innerHeight - 24 && !covered(el, r);
    if (!inside) el.scrollIntoView({ behavior: 'smooth', block: block || 'center' });
    return !inside;
  }
  const spots = [];
  function spot(spec, ms) {
    const r = rect(spec);
    if (!r) return false;
    const d = document.createElement('div');
    d.className = '__tut-spot';
    const pad = 6;
    d.style.left = (r.x - pad) + 'px';
    d.style.top = (r.y - pad) + 'px';
    d.style.width = (r.w + pad * 2) + 'px';
    d.style.height = (r.h + pad * 2) + 'px';
    document.documentElement.appendChild(d);
    requestAnimationFrame(() => d.classList.add('on'));
    setTimeout(() => { d.classList.remove('on'); setTimeout(() => d.remove(), 300); }, ms);
    return true;
  }
  function uninstall() {
    for (const id of ['__tut-cursor', '__tut-style', '__tut-ripple']) document.getElementById(id)?.remove();
    document.querySelectorAll('.__tut-spot').forEach((e) => e.remove());
    delete window.__tut;
  }
  window.__tut = { state, moveTo, ripple, find, rect, reveal, spot, uninstall };
  return 'installed';
})()`;

/**
 * @param {import('./cdp.mjs').connect extends (...a: any) => Promise<infer T> ? T : never} cdp
 */
export function driver(cdp, opts = {}) {
  const log = opts.log ?? (() => {});
  const specJson = (t) => JSON.stringify(typeof t === 'string' ? t : t.text instanceof RegExp ? { ...t, text: t.text.source, flags: t.text.flags } : t);

  const ui = {
    sleep,
    cdp,
    /** Put the overlays in (again, after a reload). */
    async install() {
      const r = await cdp.evaluate(PAGE_RUNTIME);
      log(`overlay ${r}`);
    },
    async uninstall() {
      await cdp.evaluate(`window.__tut ? (window.__tut.uninstall(), 'removed') : 'absent'`).catch(() => {});
    },
    async evaluate(expr) {
      return cdp.evaluate(expr);
    },
    async exists(target) {
      return cdp.evaluate(`!!window.__tut.find(${specJson(target)})`);
    },
    async text(target) {
      return cdp.evaluate(`(window.__tut.find(${specJson(target)})?.textContent || '').trim()`);
    },
    /** Wait until a target exists (or an expression is truthy). */
    async waitFor(target, ms = 15_000) {
      const expr = typeof target === 'object' && target.expr ? target.expr : `!!window.__tut.find(${specJson(target)})`;
      const t0 = Date.now();
      while (Date.now() - t0 < ms) {
        if (await cdp.evaluate(expr)) return true;
        await sleep(150);
      }
      throw new Error(`timed out waiting for ${typeof target === 'object' && target.expr ? target.expr.slice(0, 80) : specJson(target)}`);
    },
    async rect(target) {
      const r = await cdp.evaluate(`window.__tut.rect(${specJson(target)})`);
      if (!r) throw new Error(`not found: ${specJson(target)}`);
      return r;
    },
    /** Scroll the target into view (smoothly) if it is off screen. */
    async reveal(target, block) {
      const moved = await cdp.evaluate(`window.__tut.reveal(${specJson(target)}, ${JSON.stringify(block ?? 'center')})`);
      if (moved) {
        // A smooth scroll takes longer the further it goes (a page-length one
        // runs past a second): wait until the target's box stops moving, or a
        // click measured mid-scroll lands on whatever slid under the cursor.
        let last = null;
        for (let i = 0; i < 30; i++) {
          await sleep(80);
          const r = await ui.rect(target);
          const key = `${Math.round(r.cx)},${Math.round(r.cy)}`;
          if (key === last) break;
          last = key;
        }
        await sleep(150);
      }
      return moved;
    },
    /** Move the drawn cursor to a point (css px). Duration scales with distance. */
    async moveTo(x, y, ms) {
      const cur = await cdp.evaluate(`[window.__tut.state.x, window.__tut.state.y]`);
      const dist = Math.hypot(x - cur[0], y - cur[1]);
      const dur = ms ?? Math.max(260, Math.min(900, dist * 0.8));
      await cdp.evaluate(`window.__tut.moveTo(${x}, ${y}, ${dur})`);
      await cdp.call('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
    },
    /** Move to a target's centre (with a little offset so it reads as a pointer, not a crosshair). */
    async hover(target, opts = {}) {
      await ui.reveal(target);
      const r = await ui.rect(target);
      const x = Math.round(r.cx + (opts.dx ?? 0));
      const y = Math.round(r.cy + (opts.dy ?? 0));
      await ui.moveTo(x, y, opts.ms);
      if (opts.hold) await sleep(opts.hold);
      return { x, y };
    },
    /** Hover, then a real left click. */
    async click(target, opts = {}) {
      const { x, y } = await ui.hover(target, opts);
      await sleep(opts.before ?? 140);
      await cdp.evaluate(`window.__tut.ripple(${x}, ${y})`);
      await cdp.call('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
      await sleep(60);
      await cdp.call('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
      log(`click ${specJson(target)}`);
      await sleep(opts.after ?? 350);
    },
    /** Click a target and glow it for a moment (a "look here"). */
    async spot(target, ms = 1600) {
      await ui.reveal(target);
      await cdp.evaluate(`window.__tut.spot(${specJson(target)}, ${ms})`);
    },
    /** Hover a target and glow it: the standard "this is X" beat. */
    async point(target, opts = {}) {
      await ui.hover(target, opts);
      await cdp.evaluate(`window.__tut.spot(${specJson(target)}, ${opts.glow ?? 1600})`);
      await sleep(opts.hold ?? 900);
    },
    /** Type into a field: click it, optionally clear, then keys (short) or pasted chunks (long). */
    async type(target, text, opts = {}) {
      await ui.click(target, { after: 120 });
      if (opts.clear) {
        await ui.press('a', { ctrl: true });
        await ui.press('Backspace');
      }
      if (text.length <= (opts.keysUpTo ?? 32)) {
        for (const ch of text) {
          await cdp.call('Input.dispatchKeyEvent', { type: 'keyDown', text: ch, key: ch, unmodifiedText: ch });
          await cdp.call('Input.dispatchKeyEvent', { type: 'keyUp', key: ch });
          await sleep(opts.perChar ?? 45);
        }
      } else {
        const chunk = opts.chunk ?? 5;
        for (let i = 0; i < text.length; i += chunk) {
          await cdp.call('Input.insertText', { text: text.slice(i, i + chunk) });
          await sleep(opts.perChunk ?? 40);
        }
      }
      log(`type ${JSON.stringify(text.slice(0, 24))}…`);
      await sleep(opts.after ?? 300);
    },
    async press(key, mods = {}) {
      const KEYS = {
        Enter: { code: 'Enter', vk: 13, text: '\r' },
        Escape: { code: 'Escape', vk: 27 },
        Tab: { code: 'Tab', vk: 9 },
        Backspace: { code: 'Backspace', vk: 8 },
        a: { code: 'KeyA', vk: 65 },
      };
      const k = KEYS[key] ?? { code: key, vk: key.toUpperCase().charCodeAt(0) };
      const modifiers = (mods.ctrl ? 2 : 0) | (mods.shift ? 8 : 0) | (mods.alt ? 1 : 0);
      const base = { key, code: k.code, windowsVirtualKeyCode: k.vk, nativeVirtualKeyCode: k.vk, modifiers };
      await cdp.call('Input.dispatchKeyEvent', { type: k.text && !mods.ctrl ? 'keyDown' : 'rawKeyDown', ...base, ...(k.text && !mods.ctrl ? { text: k.text } : {}) });
      await cdp.call('Input.dispatchKeyEvent', { type: 'keyUp', ...base });
      await sleep(120);
    },
    /** Scroll with the wheel at the cursor's position (the page's own scroll containers respond). */
    async wheel(dy, steps = 6) {
      const [x, y] = await cdp.evaluate(`[window.__tut.state.x, window.__tut.state.y]`);
      for (let i = 0; i < steps; i++) {
        await cdp.call('Input.dispatchMouseEvent', { type: 'mouseWheel', x: Math.round(x), y: Math.round(y), deltaX: 0, deltaY: dy / steps });
        await sleep(45);
      }
      await sleep(400);
    },
    async pause(ms) {
      await sleep(ms);
    },
  };
  return ui;
}
