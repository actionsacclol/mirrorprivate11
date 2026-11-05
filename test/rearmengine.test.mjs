// Auto re-arm in the live engine, run for real: the loss limit that comes back
// only when asked, and only for the wallet that hit it.
//
// Run through `npm test`, which builds test/.engine.test.mjs first.

import assert from 'node:assert/strict';
import { SniperEngine } from './.engine.test.mjs';
import { DEFAULT_SETTINGS } from './.sharedtypes.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let passed = 0;
const ok = (name) => {
  passed += 1;
  console.log(`  ok - ${name}`);
};

function make(rearm = {}, execution = {}) {
  const settings = {
    ...structuredClone(DEFAULT_SETTINGS),
    recorderEnabled: false,
    autoStartEngine: false,
  };
  settings.execution = { ...settings.execution, liveEnabled: false, maxLiveConsecutiveLosses: 3, ...execution, rearm: { ...settings.execution.rearm, ...rearm } };
  const engine = new SniperEngine(() => settings, () => {});
  engine.notify = () => {};
  const armCalls = [];
  engine.onRearmAfterUpgrade = () => {
    armCalls.push(Date.now());
    engine.armed = true;
    engine.armedAt = Date.now();
    engine.lossRearmTries = 0; // what arm() does, as the real callback goes through it
    return { ok: true, message: 'Armed' };
  };
  return { engine, settings, armCalls };
}

// ── The loss limit ─────────────────────────────────────────────────────────
const tripLoss = (engine) => {
  engine.armed = true;
  engine.armedAt = Date.now();
  engine.liveConsecutiveLosses = 3;
  engine.updateLiveBreakers();
};

{
  const { engine, armCalls } = make();
  tripLoss(engine);
  assert.equal(engine.armed, false, 'it disarms');
  assert.equal(engine.lastDisarmReason, 'loss_limit');
  assert.equal(engine.rearmPending().length, 0, 'and by default stays off');
  await sleep(20);
  assert.equal(armCalls.length, 0);
  ok('a loss limit stays off by default');
}

{
  const { engine, armCalls } = make({ lossLimits: true });
  const before = Date.now();
  tripLoss(engine);
  assert.equal(engine.armed, false);
  const [p] = engine.rearmPending();
  assert.equal(p.id, 'loss');
  assert.ok(p.at >= before + 59 * 60_000, 'after the full hour');
  assert.equal(engine.lossRearmTries, 1);
  engine.scheduleLossRearm(Date.now() + 10, 'test');
  await sleep(40);
  assert.equal(armCalls.length, 1, 'it re-arms');
  assert.equal(engine.armed, true);
  assert.equal(engine.lossRearmTries, 1, 'and keeps the count: this was not the user arming');
  ok('asked for, a loss limit comes back after the hour and keeps its count');
}

for (const [reason, label] of [['user', 'the Paper switch'], ['kill_switch', 'the kill switch'], ['debugger', 'a debugger'], ['no_wallet', 'removing the wallet'], ['decoder_drift', 'a format change']]) {
  const { engine, armCalls } = make({ lossLimits: true });
  tripLoss(engine);
  engine.disarm(reason);
  assert.equal(engine.rearmPending().length, 0, `${label} ends the plan`);
  await sleep(20);
  assert.equal(armCalls.length, 0, `${label}: not re-armed`);
}
ok('any other stop ends a planned comeback, including when live is already off');

{
  const { engine, armCalls, settings } = make({ lossLimits: true });
  tripLoss(engine);
  engine.scheduleLossRearm(Date.now() + 10, 'test');
  settings.execution.rearm.lossLimits = false;
  await sleep(40);
  assert.equal(armCalls.length, 0, 'turning the switch off during the wait keeps it off');
  ok('the loss switch is read again when the wait ends');
}

{
  const { engine, armCalls } = make({ lossLimits: true });
  tripLoss(engine);
  engine.scheduleLossRearm(Date.now() + 10, 'test');
  engine.cancelRearm();
  await sleep(40);
  assert.equal(armCalls.length, 0, 'Keep it off');
  ok('Keep it off keeps it off');
}

{
  const { engine } = make({ lossLimits: true, maxInARow: 1 });
  tripLoss(engine);
  engine.cancelRearm();
  tripLoss(engine);
  assert.equal(engine.rearmPending().length, 0, 'one comeback used, none left');
  ok('the comeback limit applies to loss limits too');
}

{
  const { engine, armCalls } = make({ lossLimits: true });
  tripLoss(engine);
  engine.scheduleLossRearm(Date.now() + 10, 'test');
  engine.lossRearmOwner = 'SomeOtherWallet111111111111111111111111111';
  await sleep(40);
  assert.equal(armCalls.length, 0, 'the wallet changed during the wait');
  ok('a comeback never arms a wallet that did not hit the limit');
}

// ── The upgrade comeback: a person's stop ends it ──
{
  for (const reason of ['user', 'kill_switch', 'debugger', 'loss_limit', 'no_wallet']) {
    const { engine } = make();
    engine.armed = false;
    engine.armedWhenUpgradeHit = true;
    engine.lastDisarmReason = 'program_upgrade';
    engine.disarm(reason);
    assert.equal(engine.armedWhenUpgradeHit, false, reason);
  }
  const { engine } = make();
  engine.armed = true;
  engine.armedWhenUpgradeHit = true;
  engine.disarm('program_upgrade');
  assert.equal(engine.armedWhenUpgradeHit, true, 'the upgrade itself keeps it');
  ok('a stop while the upgrade is being re-checked keeps Live off');
}
{
  const { engine } = make();
  engine.armed = false;
  engine.lastDisarmReason = 'user';
  engine.disarm('kill_switch');
  assert.equal(engine.liveState().lastDisarmReason, 'kill_switch', 'an AI must see it even with Live already off');
  ok('the kill switch is remembered when Live was already off');
}
{
  // The automatic comeback does not hand the session a fresh loss allowance.
  const { engine } = make();
  engine.walletBalanceLamports = 500;
  engine.liveBaselineLamports = 1000;
  engine.liveConsecutiveLosses = 2;
  const keep = engine.arm(true, { keepSession: true });
  assert.equal(keep.ok, true, keep.message);
  assert.equal(engine.liveBaselineLamports, 1000);
  assert.equal(engine.liveConsecutiveLosses, 2);
  engine.armed = false;
  const fresh = engine.arm(true);
  assert.equal(fresh.ok, true);
  assert.equal(engine.liveBaselineLamports, 500, 'a person arming starts a new session');
  assert.equal(engine.liveConsecutiveLosses, 0);
  ok('a checked upgrade coming back keeps the loss count');
}
{
  // Overlapping buys see what the ones before them committed.
  const { engine } = make();
  engine.commitBuy('me', 200);
  const held = engine.commitBuy('me', 300);
  const other = engine.commitBuy('other', 50);
  assert.equal(engine.committedLamports('me'), 500);
  engine.settleCommit('me', held, false, null);
  assert.equal(engine.committedLamports('me'), 200, 'a failed send gives it back');
  const sent = engine.commitBuy('me', 100);
  engine.settleCommit('me', sent, true, 'sig1');
  assert.equal(engine.committedLamports('me'), 300, 'a sent one stays held');
  engine.releaseSettled('sig1');
  assert.equal(engine.committedLamports('me'), 200, 'until the ledger settles it');
  void other;
  assert.equal(engine.committedLamports('other'), 50, 'per wallet');
  const old = engine.commitBuy('late', 70);
  old.until = Date.now() - 1;
  assert.equal(engine.committedLamports('late'), 0, 'one the ledger never reads expires');
  ok('the sell reserve counts buys already sent');
}

console.log(`\nrearmengine: ${passed}/${passed} passed`);
process.exit(0);
