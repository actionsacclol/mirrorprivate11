// © 2026 Krypt (krypt.cc). Proprietary and confidential — see LICENSE. This is
// a closed-source, privately owned application; its source is not public. Do
// not redistribute, reverse engineer, deobfuscate, or remove/alter the
// platform fee or any integrity check. Unauthorized use is prohibited.
//
// Tamper guards (2026-10-28). Two independent, NON-DESTRUCTIVE checks that run
// in PACKAGED builds only:
//
//   A. Self-inspector guard — a debugger/inspector attached to THIS process.
//      Response: drop to paper (the caller disarms live). Open positions can
//      still be closed; nothing is deleted. In a fused release these flags are
//      never set, so if one IS set the fuses were stripped — a cracked build —
//      and live trading stops. A legit user never trips it.
//
//   B. Analysis-tool guard — a known reverse-engineering / traffic-inspection
//      tool is running on the machine. Response: the caller CLOSES the app.
//      Nothing is uninstalled, deleted, or modified — the app simply will not
//      stay open alongside these tools. Reopenable the moment the tool is
//      closed.
//
// The honest ceiling (same as shared/feeIntegrity.ts): these are speed bumps,
// not walls. Process-name matching is defeated by renaming, a VM, or a kernel
// debugger, and the check itself can be patched out of the bytecode. The point
// is to add cost and catch the casual case — never to harm a real user, which
// is why neither guard ever destroys anything and both are packaged-only.
//
// Deliberately NOT here: no self-uninstall, no file deletion, no wallet/key
// touching, no silent data loss. Those would risk a legit user's funds on a
// false positive and would read as malware to antivirus/EDR.

import { spawn } from 'node:child_process';
import inspector from 'node:inspector';
import { logger } from './logger';

/**
 * A debugger/inspector attached to THIS Node process, or null. Specific to our
 * own process — it never enumerates or inspects anything else.
 *
 * `inspector.url()` is defined only when the inspector is actually listening.
 * The flags are the launch switches that open it (or the renderer's CDP port);
 * a fused release build carries none of them, so any hit means the build was
 * launched in a way a shipped build never is.
 */
export function selfInspectorPresent(): string | null {
  try {
    if (typeof inspector.url === 'function' && inspector.url()) return 'the V8 inspector is attached';
  } catch {
    /* inspector module unavailable — treat as not present */
  }
  const flags = [...process.execArgv, ...process.argv.slice(1)].map((a) => a.toLowerCase());
  const hit = flags.find(
    (a) =>
      a.startsWith('--inspect') || // --inspect, --inspect-brk, --inspect-port
      a.startsWith('--remote-debugging-port') ||
      a === '--remote-debugging-pipe',
  );
  if (hit) return `the process was launched with ${hit.split('=')[0]}`;
  return null;
}

/**
 * Known reverse-engineering, memory-editing and traffic-inspection tools, by
 * executable name. Matched case-insensitively against the basename of each
 * running process. Edit this ONE list to change what trips guard B.
 *
 * Only DISTINCTIVE executable names are listed. Java-based tools (Ghidra, Burp
 * Suite, JADX, JD-GUI) run as `java`/`javaw` and are deliberately omitted —
 * matching those would close the app for every unrelated Java program, exactly
 * the false-positive this file is careful to avoid.
 */
const BLOCKED_TOOLS: Array<{ re: RegExp; label: string }> = [
  // Debuggers / disassemblers
  { re: /^x(64|32)dbg\.exe$/, label: 'x64dbg' },
  { re: /^ollydbg\.exe$/, label: 'OllyDbg' },
  { re: /^windbgx?\.exe$/, label: 'WinDbg' },
  { re: /^ida(64|q|q64)?\.exe$/, label: 'IDA' },
  { re: /^binaryninja\.exe$/, label: 'Binary Ninja' },
  { re: /^(radare2|r2|rizin)\.exe$/, label: 'radare2' },
  { re: /^cutter\.exe$/, label: 'Cutter' },
  { re: /^immunitydebugger\.exe$/, label: 'Immunity Debugger' },
  // Memory editors / runtime manipulation
  { re: /^cheatengine(-x86_64|-i386)?\.exe$/, label: 'Cheat Engine' },
  { re: /^(processhacker|systeminformer)\.exe$/, label: 'Process Hacker / System Informer' },
  { re: /^reclass(\.net)?\.exe$/, label: 'ReClass.NET' },
  { re: /^(frida|frida-server|frida-trace)(\.exe)?$/, label: 'Frida' },
  { re: /^artmoney\.exe$/, label: 'ArtMoney' },
  // .NET / decompilers
  { re: /^dnspy(ex|-x86)?\.exe$/, label: 'dnSpy' },
  { re: /^ilspy\.exe$/, label: 'ILSpy' },
  { re: /^dotpeek(32|64)?\.exe$/, label: 'dotPeek' },
  { re: /^de4dot\.exe$/, label: 'de4dot' },
  { re: /^jeb\.exe$/, label: 'JEB' },
  // Network / API inspection
  { re: /^wireshark\.exe$/, label: 'Wireshark' },
  { re: /^(fiddler|fiddler everywhere)\.exe$/, label: 'Fiddler' },
  { re: /^charles\.exe$/, label: 'Charles Proxy' },
  { re: /^(mitmproxy|mitmdump|mitmweb)\.exe$/, label: 'mitmproxy' },
  { re: /^http ?toolkit\.exe$/, label: 'HTTP Toolkit' },
  { re: /^apimonitor(-x64|-x86)?\.exe$/, label: 'API Monitor' },
  { re: /^procmon(64)?\.exe$/, label: 'Process Monitor' },
  // Binary patching / unpacking / PE analysis
  { re: /^die\.exe$/, label: 'Detect It Easy' },
  { re: /^pe-?bear\.exe$/, label: 'PE-bear' },
  { re: /^pestudio\.exe$/, label: 'PEStudio' },
  { re: /^(resourcehacker|reshacker)\.exe$/, label: 'Resource Hacker' },
  { re: /^scylla(hide)?.*\.exe$/, label: 'Scylla' },
  { re: /^010editor\.exe$/, label: '010 Editor' },
  { re: /^hxd\.exe$/, label: 'HxD' },
];

/** Non-Windows twins, matched against the process `comm` basename. */
const BLOCKED_TOOLS_UNIX: Array<{ re: RegExp; label: string }> = [
  { re: /^wireshark$/, label: 'Wireshark' },
  { re: /^charles$/, label: 'Charles Proxy' },
  { re: /^(mitmproxy|mitmdump|mitmweb)$/, label: 'mitmproxy' },
  { re: /^(frida|frida-server|frida-trace)$/, label: 'Frida' },
  { re: /^(radare2|r2|rizin)$/, label: 'radare2' },
  { re: /^cutter$/, label: 'Cutter' },
  { re: /^lldb$/, label: 'LLDB' },
  { re: /^gdb$/, label: 'GDB' },
  { re: /^hopper$/, label: 'Hopper' },
  { re: /^ida(64)?$/, label: 'IDA' },
];

/**
 * The blocked-tool label for a process basename, or null. Exported so the
 * match logic is unit-tested without spawning real processes. Case-insensitive.
 */
export function matchAnalysisTool(basename: string, platform: NodeJS.Platform = process.platform): string | null {
  const list = platform === 'win32' ? BLOCKED_TOOLS : BLOCKED_TOOLS_UNIX;
  const n = basename.toLowerCase().trim();
  if (!n) return null;
  return list.find((t) => t.re.test(n))?.label ?? null;
}

/** Run a command and resolve its stdout, or '' on any failure. Never throws. */
function runList(cmd: string, args: string[]): Promise<string> {
  return new Promise((resolve) => {
    let out = '';
    try {
      const p = spawn(cmd, args, { windowsHide: true });
      p.stdout?.on('data', (d) => (out += d.toString()));
      p.on('error', () => resolve(''));
      p.on('close', () => resolve(out));
      // A hung lister must never wedge the guard.
      setTimeout(() => {
        try {
          p.kill();
        } catch {
          /* already gone */
        }
        resolve(out);
      }, 4_000).unref();
    } catch {
      resolve('');
    }
  });
}

/**
 * The label of the first blocked analysis tool found running, or null. Enumerates
 * the machine's own process list by NAME only — it reads no memory, opens no
 * handle, and inspects no other program.
 */
export async function scanAnalysisTools(): Promise<string | null> {
  if (process.platform === 'win32') {
    const out = await runList('tasklist', ['/fo', 'csv', '/nh']);
    if (!out) return null;
    const names = out
      .split(/\r?\n/)
      .map((line) => /^"([^"]+)"/.exec(line)?.[1]?.toLowerCase().trim())
      .filter((n): n is string => !!n);
    for (const name of names) {
      const hit = matchAnalysisTool(name, 'win32');
      if (hit) return hit;
    }
    return null;
  }
  // macOS / Linux: `comm` is the executable basename.
  const out = await runList('ps', ['-A', '-o', 'comm=']);
  if (!out) return null;
  const names = out
    .split(/\r?\n/)
    .map((line) => line.trim().split('/').pop()?.toLowerCase() ?? '')
    .filter(Boolean);
  for (const name of names) {
    const hit = matchAnalysisTool(name, process.platform);
    if (hit) return hit;
  }
  return null;
}

export interface TamperGuardHandlers {
  /** A debugger/inspector is on our process — drop to paper. Called repeatedly. */
  onInspector: (why: string) => void;
  /** A blocked analysis tool is running — close the app. Called once. */
  onAnalysisTool: (label: string) => void;
}

const INSPECTOR_EVERY_MS = 5_000;
const TOOLS_EVERY_MS = 12_000;
const TOOLS_FIRST_DELAY_MS = 6_000;

/**
 * Start both guards. PACKAGED builds only (gated by the caller). Returns a stop
 * function. The analysis-tool guard fires `onAnalysisTool` at most once — the
 * caller closes the app, so there is nothing to repeat.
 */
export function startTamperGuards(handlers: TamperGuardHandlers): () => void {
  let toolFired = false;

  const checkInspector = (): void => {
    const why = selfInspectorPresent();
    if (why) {
      logger.warn(`[tamper] ${why} — dropping to paper (a shipped build is never launched this way)`);
      try {
        handlers.onInspector(why);
      } catch {
        /* the engine may not be up yet; the next tick retries */
      }
    }
  };

  const checkTools = (): void => {
    if (toolFired) return;
    void scanAnalysisTools().then((label) => {
      if (label && !toolFired) {
        toolFired = true;
        logger.warn(`[tamper] analysis tool running: ${label} — closing`);
        try {
          handlers.onAnalysisTool(label);
        } catch {
          /* the caller handles the close */
        }
      }
    });
  };

  checkInspector();
  const t1 = setInterval(checkInspector, INSPECTOR_EVERY_MS);
  const t2 = setInterval(checkTools, TOOLS_EVERY_MS);
  const first = setTimeout(checkTools, TOOLS_FIRST_DELAY_MS);
  t1.unref();
  t2.unref();
  first.unref();

  return () => {
    clearInterval(t1);
    clearInterval(t2);
    clearTimeout(first);
  };
}
