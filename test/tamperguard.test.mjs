// Tamper guards: the match logic and the self-inspector probe. The process
// scan and the "close the app" action are integration glue tested by hand; what
// matters here is that the blocklist matches the right names and NOT the wrong
// ones (false positives close a legit user's app), and that a plain run reports
// no inspector attached.

import assert from 'node:assert/strict';
import { matchAnalysisTool, selfInspectorPresent } from './.tamperguard.mjs';

let passed = 0;
const ok = (m) => {
  console.log(`ok  ${m}`);
  passed += 1;
};

// ── Windows names that MUST trip ──────────────────────────────────────
{
  const hits = [
    ['x64dbg.exe', 'x64dbg'],
    ['x32dbg.exe', 'x64dbg'],
    ['ida64.exe', 'IDA'],
    ['dnSpy.exe', 'dnSpy'],
    ['dnSpyEx.exe', 'dnSpy'],
    ['Wireshark.exe', 'Wireshark'],
    ['Charles.exe', 'Charles Proxy'],
    ['Fiddler.exe', 'Fiddler'],
    ['mitmproxy.exe', 'mitmproxy'],
    ['cheatengine-x86_64.exe', 'Cheat Engine'],
    ['ProcessHacker.exe', 'Process Hacker / System Informer'],
    ['SystemInformer.exe', 'Process Hacker / System Informer'],
    ['frida.exe', 'Frida'],
    ['Procmon64.exe', 'Process Monitor'],
    ['HxD.exe', 'HxD'],
  ];
  for (const [name, label] of hits) {
    assert.equal(matchAnalysisTool(name, 'win32'), label, `${name} should match ${label}`);
  }
  // Case does not matter.
  assert.equal(matchAnalysisTool('WIRESHARK.EXE', 'win32'), 'Wireshark');
  ok(`${hits.length} known Windows analysis tools are detected (case-insensitively)`);
}

// ── Names that MUST NOT trip (false positives close the app) ──────────
{
  const safe = [
    'chrome.exe',
    'msedge.exe',
    'explorer.exe',
    'Code.exe', // VS Code
    'node.exe',
    'java.exe', // Ghidra/Burp/JADX run on the JVM — never matched by design
    'javaw.exe',
    'electron.exe',
    'Krypto Mirror.exe',
    'svchost.exe',
    'python.exe',
    'Discord.exe',
    'steam.exe',
    'notepad.exe',
    '', // empty line from the lister
  ];
  for (const name of safe) {
    assert.equal(matchAnalysisTool(name, 'win32'), null, `${name || '(empty)'} must NOT be flagged`);
  }
  ok(`${safe.length} everyday processes (incl. java, the app, browsers) are NOT flagged`);
}

// ── Unix twins ────────────────────────────────────────────────────────
{
  assert.equal(matchAnalysisTool('wireshark', 'linux'), 'Wireshark');
  assert.equal(matchAnalysisTool('gdb', 'linux'), 'GDB');
  assert.equal(matchAnalysisTool('lldb', 'darwin'), 'LLDB');
  assert.equal(matchAnalysisTool('mitmdump', 'linux'), 'mitmproxy');
  assert.equal(matchAnalysisTool('node', 'linux'), null);
  assert.equal(matchAnalysisTool('bash', 'linux'), null);
  assert.equal(matchAnalysisTool('Krypto Mirror', 'darwin'), null);
  // A Windows-only name is not matched on Unix (different list).
  assert.equal(matchAnalysisTool('x64dbg.exe', 'linux'), null);
  ok('Unix process names match their own list, not the Windows one');
}

// ── Self-inspector probe: a plain test run has no debugger attached ────
{
  // node test/... with no --inspect flag: the inspector is not listening.
  const why = selfInspectorPresent();
  assert.equal(why, null, `a normal run reports no inspector, got: ${why}`);
  ok('selfInspectorPresent() is null in a normal (undebugged) run');
}

console.log(`\ntamperguard: ${passed}/4 passed`);
