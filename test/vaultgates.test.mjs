// Which actions ask for the password, and the wiring that makes that true. Reads
// the real handlers from source, so a new money channel cannot be added without
// a decision about it.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { VAULT_CONDITIONAL_GATES, VAULT_GATES, VAULT_NEVER_GATED, capRaised, followCapsRaised, settingsCapsRaised } from './.vaultshared.mjs';
import { MCP_IPC_CHANNELS, MCP_NEVER_CHANNELS } from './.vaultmcp.mjs';

let passed = 0;
const ok = (name, fn) => {
  fn();
  passed += 1;
  console.log(`  ok   ${name}`);
};
const src = (rel) => readFileSync(new URL(rel, import.meta.url), 'utf8');
const ipc = src('../electron/ipc.ts');
const channels = [...ipc.matchAll(/ipcMain\.handle\('([^']+)'/g)].map((m) => m[1]);
const gated = new Set([...Object.keys(VAULT_GATES), ...VAULT_CONDITIONAL_GATES]);

ok('every conditional gate has its rule in main, and every rule is listed', () => {
  const block = ipc.slice(ipc.indexOf('const CONDITIONAL_GATES'), ipc.indexOf('function gateChannel'));
  const rules = [...block.matchAll(/^ {2}'([a-zA-Z:]+)': /gm)].map((m) => m[1]);
  assert.deepEqual([...rules].sort(), [...VAULT_CONDITIONAL_GATES].sort());
});
ok('every gate names a channel that exists', () => {
  for (const c of gated) assert.ok(channels.includes(c), c);
  for (const c of VAULT_NEVER_GATED) assert.ok(channels.includes(c), c);
});
ok('nothing is both gated and never gated', () => {
  for (const c of VAULT_NEVER_GATED) assert.ok(!gated.has(c), c);
});
ok('a channel that moves money or keys has to be classified', () => {
  const risky = /export|backup|reveal|import|remove|withdraw|send|fund|collect|sethome|refuel|compress|moveSend|golive|claim|sell|sweep|disarm|kill/i;
  const missing = channels.filter((c) => risky.test(c) && !gated.has(c) && !VAULT_NEVER_GATED.includes(c));
  assert.deepEqual(missing, []);
});
ok('exits and stops never ask', () => {
  for (const c of ['live:sellToken', 'live:sellAll', 'evm:sell', 'evm:sellAll', 'live:disarm', 'evm:disarm', 'engine:kill']) {
    assert.ok(VAULT_NEVER_GATED.includes(c), c);
    assert.ok(!gated.has(c), c);
  }
});
ok('what you asked for asks: export, send, withdraw', () => {
  for (const c of ['wallet:export', 'wallet:backup', 'evm:wallet:export', 'aio:reveal', 'send:execute', 'wallet:withdraw', 'wallet:setHome', 'wallet:import', 'wallet:remove']) assert.ok(VAULT_GATES[c], c);
});
ok('the AI connection can reach no always-gated channel', () => {
  for (const c of Object.keys(VAULT_GATES)) assert.ok(!MCP_IPC_CHANNELS.includes(c), c);
});
ok('no password channel is open to the AI connection', () => {
  for (const c of channels.filter((x) => x.startsWith('vault:'))) assert.ok(MCP_NEVER_CHANNELS.includes(c), c);
  for (const c of ['vault:status', 'vault:turnOn', 'vault:unlock', 'prompt:submit']) assert.ok(MCP_NEVER_CHANNELS.includes(c), c);
});
ok('every handler is registered through the gate', () => {
  const fn = ipc.slice(ipc.indexOf('function captureMcpHandlers'), ipc.indexOf('/** Run a captured handler'));
  assert.ok(fn.includes('gateChannel(channel, raw)'));
  assert.ok(fn.indexOf('gateChannel') < fn.indexOf('mcpHandlers.set'), 'the AI gets the gated handler too');
  assert.ok(ipc.indexOf('captureMcpHandlers();') < ipc.indexOf("ipcMain.handle('settings:update'"));
});
ok('no channel from the app window can carry a password', () => {
  const flows = src('../electron/system/vaultFlows.ts');
  for (const m of flows.matchAll(/ipcMain\.handle\('vault:[^']+', (?:async )?\(([^)]*)\)/g)) assert.ok(!/password|secret|key/i.test(m[1]), m[0]);
  const preload = src('../electron/preload.ts');
  const block = preload.slice(preload.indexOf('vault: {'), preload.indexOf('// The All-in-One wallet'));
  assert.ok(!/password/i.test(block.replace(/\/\/.*/g, '')), 'the app preload never passes one');
  assert.ok(!src('../electron/promptPreload.ts').includes('exposeInMainWorld'), 'the prompt exposes nothing to its page');
});
ok('the prompt only listens to its own window', () => {
  const p = src('../electron/system/passwordPrompt.ts');
  assert.ok(p.includes('e.sender === running.win.webContents'));
  for (const c of ['prompt:init', 'prompt:submit', 'prompt:link', 'prompt:cancel', 'prompt:size']) {
    const at = p.indexOf(`'${c}'`);
    assert.ok(at > 0 && p.slice(at, at + 90).includes('isCurrent(e)'), c);
  }
  assert.ok(p.includes("partition: 'vault-prompt'") && p.includes('sandbox: true') && p.includes('contextIsolation: true'));
});
ok('nothing is resumed on the strength of an unchecked marker', () => {
  const o = src('../electron/system/vaultOps.ts').replace(/\r\n/g, '\n');
  const fn = o.slice(o.indexOf('export function resumeIfInterrupted'));
  assert.ok(fn.indexOf('restoreMigrating') < fn.indexOf('vault.migrating()'));
  assert.ok(!/writeNew\(password, root, vault\.migrating\(\)\)/.test(o), 'a new file never signs an unchecked marker');
});
ok('a closed window does not end a flow while its step is still running', () => {
  const p = src('../electron/system/passwordPrompt.ts');
  assert.ok(p.includes('void Promise.resolve(inFlight).finally(() => resolve(null))'), 'its secrets outlive the work');
  assert.ok(p.includes('if (working) return Promise.resolve(null)'), 'and no new prompt starts on top of it');
});
ok('the signer checks the lock before anything else, and before spending a send approval', () => {
  const w = src('../electron/system/wallet.ts').replace(/\r\n/g, '\n');
  const fn = w.slice(w.indexOf('function signWith('));
  assert.ok(fn.indexOf('vault.cannotOpen(w.secretEnc)') < fn.indexOf('takeSendApproval'));
  assert.ok(fn.indexOf('detailsOk(w)') < fn.indexOf('checkOutflow'));
});
ok('the key decrypt sites all go through the vault', () => {
  for (const [file, count] of [['../electron/system/wallet.ts', 1], ['../electron/evm/evmWallet.ts', 1], ['../electron/system/aioWallet.ts', 1]]) {
    const body = src(file);
    const n = body.split('safeStorage.decryptString').length - 1;
    assert.equal(n, count, file);
    assert.ok(body.includes('vault.cannotOpen') || body.includes('vault.open'), file);
  }
});
ok('a key file gets a system dialog and a neutral name', () => {
  for (const c of ['wallet:backup', 'wallet:export', 'evm:wallet:export']) {
    const at = ipc.indexOf(`ipcMain.handle('${c}'`);
    assert.ok(at > 0 && ipc.slice(at, at + 260).includes('confirmKeyFile('), c);
  }
  assert.ok(!/PRIVATE\.txt|krypto-mirror-wallet\.json/.test(ipc), 'no name that a file grabber looks for');
  const names = ipc.slice(ipc.indexOf('const KEY_FILE_NAMES'), ipc.indexOf('const KEY_FILE_NAMES') + 120);
  assert.ok(!/wallet|private|key|seed/i.test(names.replace('KEY_FILE_NAMES', '')), names);
});
ok('a withdrawal shows its address in a system dialog', () => {
  const at = ipc.indexOf("ipcMain.handle('wallet:withdraw'");
  const body = ipc.slice(at, ipc.indexOf('// ── Send: any coin', at));
  assert.ok(body.includes('confirmNative(e.sender') && body.includes('${home}'));
  assert.ok(body.indexOf('confirmNative') < body.indexOf('getEngine().withdraw'));
});

ok('raising a cap asks; lowering one never does', () => {
  assert.equal(capRaised(0.05, 0.1), true);
  assert.equal(capRaised(0.1, 0.05), false);
  assert.equal(capRaised(0.1, 0.1), false);
  assert.equal(capRaised(5, 0, true), true, '0 means no limit, which is looser');
  assert.equal(capRaised(0, 5, true), false, 'adding a limit is tighter');
  assert.equal(capRaised(undefined, 5), false);
  assert.equal(capRaised(5, undefined), false);
});
const stored = { execution: { maxLiveSol: 0.05, maxOpenCopies: 5, maxLiveSessionLossSol: 1, maxLiveConsecutiveLosses: 3 }, evm: { bnb: { maxLiveNative: 0.02 }, robinhood: { maxLiveNative: 0.003 } } };
ok('settings: every cap is seen, in words, and unrelated saves are silent', () => {
  assert.deepEqual(settingsCapsRaised(stored, { execution: { ...stored.execution } }), []);
  assert.deepEqual(settingsCapsRaised(stored, { closeToTray: true }), []);
  assert.match(settingsCapsRaised(stored, { execution: { ...stored.execution, maxLiveSol: 1 } })[0], /0\.05 to 1 SOL/);
  assert.match(settingsCapsRaised(stored, { execution: { ...stored.execution, maxOpenCopies: 0 } })[0], /no limit/);
  assert.match(settingsCapsRaised(stored, { execution: { ...stored.execution, maxLiveSessionLossSol: 0 } })[0], /off/);
  assert.match(settingsCapsRaised(stored, { execution: { ...stored.execution, maxLiveConsecutiveLosses: 9 } })[0], /streak/);
  assert.match(settingsCapsRaised(stored, { evm: { bnb: { maxLiveNative: 1 } } })[0], /bnb/);
  // Taking a cap off is the biggest raise there is, not a lower number.
  assert.match(settingsCapsRaised(stored, { execution: { maxLiveSol: 0 } })[0], /to no cap/);
  assert.match(settingsCapsRaised({ evm: { bnb: { maxLiveNative: 0.02 } } }, { evm: { bnb: { maxLiveNative: 0 } } })[0], /bnb trade can spend, to no cap/);
  assert.deepEqual(settingsCapsRaised({ execution: { maxLiveSol: 0 } }, { execution: { maxLiveSol: 0.05 } }), [], 'setting one where there was none is tighter');
  assert.equal(settingsCapsRaised(stored, { execution: { ...stored.execution, maxLiveSol: 1, maxOpenCopies: 9 } }).length, 2);
});
ok('settings: making things safer never asks', () => {
  assert.deepEqual(settingsCapsRaised(stored, { execution: { ...stored.execution, maxLiveSol: 0.01, maxOpenCopies: 1, maxLiveSessionLossSol: 0.5 } }), []);
});
ok('settings: the other doors to the same power ask too', () => {
  const b = { ...stored, mcp: { budget: { maxBuySol: 0.1 } }, bots: { telegram: { enabled: false, token: '', ownerId: null }, discord: { enabled: false, token: '', ownerId: null }, trading: { enabled: false, allowBuys: false, requireConfirm: true, maxBuySol: 0.1, hourlyCapSol: 0.5 } } };
  assert.match(settingsCapsRaised(b, { mcp: { budget: { maxBuySol: 5 } } })[0], /AI connection/);
  assert.deepEqual(settingsCapsRaised(b, { mcp: { budget: { maxBuySol: 0.01 } } }), []);
  assert.match(settingsCapsRaised(b, { bots: { ...b.bots, telegram: { ...b.bots.telegram, token: 'abc' } } })[0], /telegram/);
  assert.match(settingsCapsRaised(b, { bots: { ...b.bots, telegram: { ...b.bots.telegram, ownerId: '42' } } })[0], /telegram/);
  assert.match(settingsCapsRaised(b, { bots: { ...b.bots, discord: { ...b.bots.discord, enabled: true } } })[0], /discord/);
  for (const t of [{ enabled: true }, { allowBuys: true }, { requireConfirm: false }, { maxBuySol: 1 }, { hourlyCapSol: 9 }]) {
    assert.match(settingsCapsRaised(b, { bots: { ...b.bots, trading: { ...b.bots.trading, ...t } } })[0], /chat bots/, JSON.stringify(t));
  }
  const on = { bots: { ...b.bots, telegram: { enabled: true, token: 'abc', ownerId: '42' }, trading: { ...b.bots.trading, enabled: true, allowBuys: true } } };
  assert.deepEqual(settingsCapsRaised(on, { bots: { ...on.bots, telegram: { enabled: false, token: 'abc', ownerId: null }, trading: { ...on.bots.trading, enabled: false, allowBuys: false, maxBuySol: 0.01 } } }), [], 'switching off never asks');
  assert.deepEqual(settingsCapsRaised(on, { bots: on.bots }), [], 'a save that changes nothing');
});
ok('settings: coming back on by itself asks like raising a cap', () => {
  const re = { failedTrades: true, lossLimits: false, followStops: false, restart: false, failsInARow: 3, firstWaitMin: 5, maxInARow: 24 };
  const before = { execution: { ...stored.execution, rearm: re } };
  assert.deepEqual(settingsCapsRaised(before, { execution: { ...before.execution } }), []);
  assert.match(settingsCapsRaised(before, { execution: { ...before.execution, rearm: { ...re, lossLimits: true } } })[0], /after a loss limit/);
  assert.match(settingsCapsRaised(before, { execution: { ...before.execution, rearm: { ...re, restart: true } } })[0], /after a restart/);
  assert.deepEqual(settingsCapsRaised(before, { execution: { ...before.execution, rearm: { ...re, failedTrades: false } } }), []);
  assert.match(settingsCapsRaised({ execution: { rearmAfterVerifiedUpgrade: false } }, { execution: { rearmAfterVerifiedUpgrade: true } })[0], /pump\.fun upgrade/);
  assert.deepEqual(settingsCapsRaised({ execution: { rearmAfterVerifiedUpgrade: true } }, { execution: { rearmAfterVerifiedUpgrade: false } }), []);
});

const follow = { mode: 'live', sizing: 'fixed', sizeValue: 0.01, maxTradeSol: 0.05, dailyLossLimitSol: 0.2 };
ok('follows: only a live one, and only a raise', () => {
  assert.deepEqual(followCapsRaised(null, { ...follow, mode: 'paper' }), [], 'a new paper follow spends nothing');
  assert.deepEqual(followCapsRaised({ ...follow, mode: 'paper' }, { ...follow, mode: 'paper', maxTradeSol: 9 }), [], 'paper spends nothing');
  assert.deepEqual(followCapsRaised(follow, { ...follow, maxTradeSol: 0.01 }), []);
  assert.match(followCapsRaised(follow, { ...follow, maxTradeSol: 1 })[0], /most per copy/);
  assert.match(followCapsRaised(follow, { ...follow, dailyLossLimitSol: 0 })[0], /to off/);
  assert.match(followCapsRaised(follow, { ...follow, sizeValue: 0.03 })[0], /copy size/);
  assert.match(followCapsRaised({ ...follow, mode: 'paper' }, follow)[0], /paper to live/);
});

ok('follows: every limit asks, and a new live follow does too', () => {
  const full = { ...follow, dailyTradeLimit: 20, maxCopiesPerMinute: 5, walletLossStopSol: 0.5 };
  assert.match(followCapsRaised(null, full)[0], /adding a live follow/);
  assert.deepEqual(followCapsRaised(full, { ...full }), [], 'no change, no question');
  assert.match(followCapsRaised(full, { ...full, walletLossStopSol: null })[0], /loss stop, to off/);
  assert.match(followCapsRaised(full, { ...full, walletLossStopSol: 0.9 })[0], /loss stop, from 0.5 to 0.9/);
  assert.deepEqual(followCapsRaised(full, { ...full, walletLossStopSol: 0.1 }), [], 'tighter never asks');
  assert.match(followCapsRaised(full, { ...full, dailyTradeLimit: 0 })[0], /daily copy limit, to off/);
  assert.match(followCapsRaised(full, { ...full, dailyTradeLimit: 500 })[0], /daily copy limit, from 20 to 500/);
  assert.match(followCapsRaised(full, { ...full, maxCopiesPerMinute: 0 })[0], /copies a minute limit, to off/);
  assert.match(followCapsRaised(full, { ...full, maxCopiesPerMinute: 9 })[0], /copies a minute limit, to 9/);
  assert.deepEqual(followCapsRaised({ ...full, maxCopiesPerMinute: null }, { ...full, maxCopiesPerMinute: 9 }), [], 'stored null runs at 10');
  assert.match(followCapsRaised({ ...full, maxCopiesPerMinute: null }, { ...full, maxCopiesPerMinute: 11 })[0], /copies a minute/);
  assert.match(followCapsRaised(full, { ...full, sizing: 'proportional' })[0], /how it sizes a copy/);
});
ok('follows: the gate reads what the handler will store', () => {
  const ipc = readFileSync('electron/ipc.ts', 'utf8');
  const gate = ipc.slice(ipc.indexOf("'copy:save': ([raw])"), ipc.indexOf("'automation:setEnabled': ([id"));
  assert.match(gate, /maxTradeSol: Number\(r\.maxTradeSol\)/);
  assert.match(gate, /dailyLossLimitSol: Number\(r\.dailyLossLimitSol\)/);
  assert.doesNotMatch(gate, /raw as Parameters/, 'never the raw request');
});

console.log(`\nvaultgates: ${passed}/${passed} passed`);
