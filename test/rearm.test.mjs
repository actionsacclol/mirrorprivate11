// Auto re-arm's rules (shared/rearm.ts). The engine tests pin the wiring; these
// pin the decisions, above all the ones that keep something switched off.

import assert from 'node:assert';
import fs from 'node:fs';
import { DEFAULT_REARM, nextRearm, readRearm, rearmLoosened, REARM_MAX_WAIT_MIN } from './.rearm.mjs';

let passed = 0;
const ok = (name, fn) => {
  fn();
  passed += 1;
  console.log(`  ok - ${name}`);
};
const MIN = 60_000;
const on = { ...DEFAULT_REARM, lossLimits: true, followStops: true };

ok('the defaults: failures come back, losses and restarts do not', () => {
  assert.equal(DEFAULT_REARM.failedTrades, true);
  assert.equal(DEFAULT_REARM.lossLimits, false);
  assert.equal(DEFAULT_REARM.followStops, false);
  assert.equal(DEFAULT_REARM.restart, false);
});

ok('an older save reads as the defaults, and junk never turns a safety off', () => {
  assert.deepEqual(readRearm(undefined), DEFAULT_REARM);
  assert.deepEqual(readRearm('nonsense'), DEFAULT_REARM);
  const junk = readRearm({ lossLimits: 'yes', followStops: 1, restart: {}, failsInARow: -1, firstWaitMin: 0, maxInARow: 1.5 });
  assert.deepEqual(junk, DEFAULT_REARM, 'only exactly true switches on a loss comeback, and a bad number is the default');
  assert.equal(readRearm({ failedTrades: false }).failedTrades, false, 'off stays off');
  assert.equal(readRearm({ maxInARow: 0 }).maxInARow, 0, '0 is a real value: no limit');
});

ok('the wait doubles from the first wait, up to an hour', () => {
  const waits = [0, 1, 2, 3, 4, 5, 20].map((t) => (nextRearm(DEFAULT_REARM, 'fails', t, 0).at) / MIN);
  assert.deepEqual(waits, [5, 10, 20, 40, 60, 60, 60]);
  assert.equal(nextRearm({ ...DEFAULT_REARM, firstWaitMin: 1 }, 'fails', 0, 0).at, MIN);
  assert.equal(nextRearm(DEFAULT_REARM, 'fails', 3, 1000).tries, 4, 'the count includes this comeback');
});

ok('a loss waits the full hour every time, whatever the first wait says', () => {
  for (const cause of ['loss', 'stop']) {
    assert.equal(nextRearm({ ...on, firstWaitMin: 1 }, cause, 0, 0).at, REARM_MAX_WAIT_MIN * MIN, cause);
    assert.equal(nextRearm({ ...on, firstWaitMin: 1 }, cause, 7, 0).at, REARM_MAX_WAIT_MIN * MIN, cause);
  }
});

ok('each switch governs its own cause only', () => {
  assert.equal(readRearm({}).slippagePauses, false, 'off unless asked for');
  assert.equal(readRearm({ slippagePauses: 'yes' }).slippagePauses, false);
  assert.equal(readRearm({ slippagePauses: true }).slippagePauses, true);
  assert.equal(nextRearm({ ...on, failedTrades: false }, 'fails', 0, 0), null);
  assert.ok(nextRearm({ ...on, failedTrades: false }, 'loss', 0, 0));
  assert.ok(nextRearm({ ...on, lossLimits: false }, 'fails', 0, 0));
  assert.equal(nextRearm(DEFAULT_REARM, 'loss', 0, 0), null, 'a loss limit stays off by default');
  assert.equal(nextRearm(DEFAULT_REARM, 'stop', 0, 0), null, "a follow's stop stays off by default");
});

ok('the comeback limit stops it, and 0 means no limit', () => {
  const s = { ...DEFAULT_REARM, maxInARow: 2 };
  assert.ok(nextRearm(s, 'fails', 1, 0));
  assert.equal(nextRearm(s, 'fails', 2, 0), null);
  assert.equal(nextRearm(s, 'fails', 99, 0), null);
  assert.ok(nextRearm({ ...DEFAULT_REARM, maxInARow: 0 }, 'fails', 10_000, 0));
  assert.ok(nextRearm(DEFAULT_REARM, 'fails', Number.NaN, 0), 'a bad count reads as none');
});

ok('anything that comes back more readily asks for the password; nothing tighter does', () => {
  const b = { ...DEFAULT_REARM, maxInARow: 24 };
  assert.deepEqual(rearmLoosened(b, undefined), [], 'a save without it changes nothing');
  assert.deepEqual(rearmLoosened(b, { ...b }), []);
  assert.deepEqual(rearmLoosened(undefined, { ...b }), [], 'an older save is the defaults');
  for (const patch of [{ lossLimits: true }, { followStops: true }, { restart: true }, { failsInARow: 5 }, { firstWaitMin: 1 }, { maxInARow: 25 }, { maxInARow: 0 }]) {
    assert.equal(rearmLoosened(b, { ...b, ...patch }).length, 1, JSON.stringify(patch));
  }
  assert.equal(rearmLoosened({ ...b, failedTrades: false }, b).length, 1, 'switching the default back on asks too');
  for (const patch of [{ failedTrades: false }, { failsInARow: 2 }, { firstWaitMin: 30 }, { maxInARow: 3 }]) {
    assert.deepEqual(rearmLoosened(b, { ...b, ...patch }), [], JSON.stringify(patch));
  }
  assert.deepEqual(rearmLoosened({ ...b, maxInARow: 0 }, { ...b, maxInARow: 5 }), [], 'adding a limit is tighter');
  assert.deepEqual(rearmLoosened({ ...b, maxInARow: 0 }, { ...b, maxInARow: 0 }), []);
});

ok('the AI connection cannot move any of it', () => {
  const mcp = fs.readFileSync(new URL('../shared/mcp.ts', import.meta.url), 'utf8');
  const start = mcp.indexOf('export const MCP_SETTINGS_AI_MAY_SET');
  const list = mcp.slice(start, mcp.indexOf('] as const', start));
  assert.ok(start > 0 && list.length > 0);
  assert.ok(!/rearm/i.test(list), 'not on the list of settings it may write');
});

ok('the engine wiring keeps the choices that stop it', () => {
  const eng = fs.readFileSync(new URL('../electron/engine/engine.ts', import.meta.url), 'utf8');
  assert.match(eng, /if \(reason !== 'loss_limit'\) this\.clearLossRearm\(\);/, 'any other stop ends a planned comeback');
  assert.match(eng, /wallet\.publicKey\(\) !== this\.lossRearmOwner/, 'a comeback never arms a different wallet');
  assert.match(eng, /syncWatch: \(\) => this\.syncCopyWatch\(\)/, 'a follow that comes back is heard');
  const arm = eng.slice(eng.indexOf('  arm(hasWallet: boolean,'), eng.indexOf('private async captureLiveBaseline'));
  assert.match(arm, /this\.clearLossRearm\(\);[\s\S]*?if \(!\(opts\.keepSession[\s\S]*?this\.lossRearmTries = 0;/, 'arming by hand starts the count again; only the automatic comeback keeps it');
  const ipc = fs.readFileSync(new URL('../electron/ipc.ts', import.meta.url), 'utf8');
  const kill = ipc.slice(ipc.indexOf("ipcMain.handle('engine:kill'"), ipc.indexOf("ipcMain.handle('engine:kill'") + 300);
  assert.match(kill, /copyTrade\.cancelRearm\(\)/, 'and every follow');
  assert.match(ipc, /if \(restartRestored \|\| vault\.isLocked\(\)\) return;/, 'a locked app restores nothing');
  for (const stop of ["ipcMain.handle('live:disarm'", "ipcMain.handle('evm:disarm'", 'stopTrading: () => {']) {
    const at = ipc.indexOf(stop);
    assert.ok(at > 0, stop);
    assert.match(ipc.slice(at, at + 400), /copyTrade\.cancelLiveRearms\(/, `${stop} ends a follow's wait`);
  }
  assert.doesNotMatch(ipc.slice(ipc.indexOf('function restoreAfterRestartOnce'), ipc.indexOf('export function syncLiveMode')), /automation\.|kryptoTrader\./, 'scripts and sessions never come back: this build has no page for them');
});

console.log(`\nrearm: ${passed}/${passed} passed`);
