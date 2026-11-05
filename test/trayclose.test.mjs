// What pressing X does, and what the notification promises. Offline.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { closeAction, trayNotice } from './.trayclose.mjs';

let passed = 0;
const ok = (name, fn) => {
  fn();
  passed += 1;
  console.log(`  ok   ${name}`);
};
const base = { platform: 'win32', enabled: true, onboarded: true, quitting: false, visible: true };

ok('the X on a set-up Windows install goes to the tray', () => {
  assert.equal(closeAction(base), 'hide');
});
ok('a quit under way is never turned back into a hide', () => {
  assert.equal(closeAction({ ...base, quitting: true }), 'close');
  assert.equal(closeAction({ ...base, quitting: true, visible: false }), 'close');
});
ok('switched off, the X quits as it always did', () => {
  assert.equal(closeAction({ ...base, enabled: false }), 'close');
});
ok('during setup the X still quits, so backing out leaves nothing running', () => {
  assert.equal(closeAction({ ...base, onboarded: false }), 'close');
});
ok('other systems keep their own behaviour, even with the switch on', () => {
  assert.equal(closeAction({ ...base, platform: 'linux' }), 'close');
  assert.equal(closeAction({ ...base, platform: 'darwin' }), 'close');
});
ok('a close request to a hidden window came from outside the app: a real quit', () => {
  assert.equal(closeAction({ ...base, visible: false }), 'quit');
});
ok('the notification says live trading is on when it is', () => {
  assert.match(trayNotice(true).body, /Live trading is ON/);
  assert.match(trayNotice(true).body, /real money/);
});
ok('the notification never claims live is on when it is off, or the reverse', () => {
  assert.match(trayNotice(false).body, /live trading off/);
  assert.match(trayNotice(false, '12:05').body, /comes back on by itself at 12:05/);
  assert.match(trayNotice(true, '12:05').body, /Live trading is ON/);
  assert.doesNotMatch(trayNotice(false).body, /real money/);
  assert.doesNotMatch(trayNotice(true).body, /live trading off/);
});
ok('both wordings say how to get back and how to quit', () => {
  for (const live of [true, false]) {
    const { title, body } = trayNotice(live);
    assert.match(title, /still running/);
    assert.match(body, /right-click/);
    assert.match(body, /open/);
  }
});

// Main-process wiring that cannot run outside Electron.
const main = readFileSync(new URL('../electron/main.ts', import.meta.url), 'utf8');
ok('before-quit marks the quit first, or the tray would swallow it', () => {
  const handler = main.slice(main.indexOf("app.on('before-quit'"));
  assert.ok(handler.indexOf('quitting = true') !== -1, 'before-quit sets the flag');
  assert.ok(handler.indexOf('quitting = true') < handler.indexOf('automation.shutdown'), 'before anything else');
});
ok('a window that went to the tray cannot be brought back by a stale reveal', () => {
  assert.ok(main.includes('revealed = true'), 'reveal runs once');
});
const ipc = readFileSync(new URL('../electron/ipc.ts', import.meta.url), 'utf8');
ok('a confirmation raises a hidden window, so it cannot wait where nobody can see it', () => {
  const fn = ipc.slice(ipc.indexOf('function confirmNative'), ipc.indexOf('function solanaAddressOfSecret'));
  assert.ok(fn.includes('isVisible()') && fn.includes('.show()'));
});

ok('keeping the computer awake follows the switch and what is running, and lets go', () => {
  const main = readFileSync(new URL('../electron/main.ts', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
  const fn = main.slice(main.indexOf('function syncKeepAwake'), main.indexOf('function trayIcon'));
  assert.match(fn, /store\.load\(\)\.keepAwake && \(copyTrade\.keepsRunning\(\) \|\| liveArmedAnywhere\(\)\)/);
  assert.match(fn, /powerSaveBlocker\.start\('prevent-app-suspension'\)/, 'the system stays up, the screen may still turn off');
  assert.match(fn, /powerSaveBlocker\.stop\(awakeBlock\)/);
});

console.log(`\ntrayclose: ${passed}/${passed} passed`);
