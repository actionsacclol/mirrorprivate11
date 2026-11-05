// The window a password is typed into. Main owns it, it has its own preload, and
// it is the ONLY place a password enters the app: no channel from the normal app
// window accepts one, so a compromised page has no way to supply or read it.
//
// One screen at a time, from a chain of steps. One window at a time: a second
// request is refused rather than queued, so nothing can stack up prompts until
// someone types into the wrong one.

import { app, BrowserWindow, ipcMain } from 'electron';
import path from 'node:path';
import type { PromptSpec } from '@shared/vault';
import { logger } from './logger';

export type StepReply<T> = { error: string } | { next: Step<T> } | { done: T };

export interface Step<T> {
  spec: PromptSpec;
  submit: (values: Record<string, string>) => Promise<StepReply<T>> | StepReply<T>;
  /** A link on the screen, such as "Use my recovery key". */
  link?: (id: string) => Promise<StepReply<T>> | StepReply<T>;
}

interface Running {
  win: BrowserWindow;
  step: Step<unknown>;
  finish: (value: unknown) => void;
}
let running: Running | null = null;
/** True while a step is doing slow work: closing now would abandon a key change. */
let working = false;
/** That work. The window can still be destroyed under it (the app window closing
 *  takes a child with it, with no chance to refuse), and the caller's secrets must
 *  outlive it, so the prompt does not report closed until it ends. */
let inFlight: Promise<unknown> | null = null;

const PAGE = `<!doctype html><html><head><meta charset="utf-8"><title>Krypto Mirror</title>
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'">
<style>
*{box-sizing:border-box}html,body{margin:0;background:#0f1016;color:#e8e9f0;font:14px/1.5 'Segoe UI',system-ui,-apple-system,sans-serif}
.box{padding:22px 24px 20px;display:flex;flex-direction:column;gap:10px}
h1{font-size:17px;font-weight:600;margin:0 0 2px;color:#fff}h1.danger{color:#fca5a5}
p{margin:0;color:#a7aabb}p.warn{color:#fcd34d}p.error{color:#fca5a5;min-height:0}p.error:empty{display:none}
.code{font:600 16px/1.7 Consolas,Menlo,monospace;background:#05060a;border:1px solid #2b2d3a;border-radius:8px;padding:10px 12px;color:#fff;text-align:center;user-select:all;letter-spacing:.5px}
label{display:flex;flex-direction:column;gap:5px;font-size:12px;color:#a7aabb}
input{background:#05060a;color:#fff;border:1px solid #2b2d3a;border-radius:8px;padding:9px 11px;font:inherit;font-size:14px;outline:none}
input:focus{border-color:#5b8cff}
.buttons{display:flex;justify-content:flex-end;gap:8px;margin-top:6px}
button{font:inherit;border:0;border-radius:8px;padding:8px 16px;cursor:pointer}
button:disabled{opacity:.55;cursor:default}
.primary{background:#3b6ff5;color:#fff;font-weight:600}.danger-button{background:#c2353b}
.ghost{background:transparent;color:#c8cad6;border:1px solid #2b2d3a}
.links{display:flex;flex-wrap:wrap;gap:14px;justify-content:center;margin-top:2px}
.link{background:none;color:#8fa6e8;padding:0;font-size:12px}.link:hover{color:#fff}
</style></head><body></body></html>`;

const WIDTH = 460;

export function registerPromptIpc(): void {
  const isCurrent = (e: Electron.IpcMainInvokeEvent | Electron.IpcMainEvent): boolean =>
    running !== null && !running.win.isDestroyed() && e.sender === running.win.webContents;

  const apply = (r: StepReply<unknown>): { error?: string; next?: PromptSpec; done?: boolean } => {
    if (!running) return { done: true };
    if ('error' in r) return { error: r.error };
    if ('next' in r) {
      running.step = r.next;
      return { next: r.next.spec };
    }
    const { finish, win } = running;
    running = null;
    finish(r.done);
    if (!win.isDestroyed()) win.destroy();
    return { done: true };
  };
  const run = async (work: () => Promise<StepReply<unknown>> | StepReply<unknown>): Promise<ReturnType<typeof apply>> => {
    working = true;
    const doing = (async () => {
      try {
        return apply(await work());
      } catch (err) {
        logger.warn(`password window: a step failed: ${(err as Error).message}`);
        return { error: (err as Error).message };
      } finally {
        working = false;
        inFlight = null;
      }
    })();
    inFlight = doing;
    return doing;
  };

  ipcMain.handle('prompt:init', (e) => (isCurrent(e) ? running!.step.spec : null));
  ipcMain.handle('prompt:submit', (e, values: unknown) => {
    if (!isCurrent(e) || working) return { error: 'This window is busy.' };
    const clean: Record<string, string> = {};
    for (const [k, v] of Object.entries((values ?? {}) as Record<string, unknown>)) if (typeof v === 'string') clean[k] = v;
    const step = running!.step;
    return run(() => step.submit(clean));
  });
  ipcMain.handle('prompt:link', (e, id: unknown) => {
    if (!isCurrent(e) || working || typeof id !== 'string') return { error: 'This window is busy.' };
    const step = running!.step;
    return step.link ? run(() => step.link!(id)) : {};
  });
  ipcMain.on('prompt:cancel', (e) => {
    if (isCurrent(e) && !working && running!.step.spec.cancel !== null) running!.win.close();
  });
  ipcMain.on('prompt:size', (e, height: unknown) => {
    if (!isCurrent(e) || typeof height !== 'number') return;
    running!.win.setContentSize(WIDTH, Math.max(160, Math.min(720, Math.ceil(height))));
  });
}

export function promptIsOpen(): boolean {
  return running !== null || working;
}

/** Show the chain of steps. Null when it was cancelled or closed. */
export function runPrompt<T>(parent: BrowserWindow | null, first: Step<T>): Promise<T | null> {
  if (running) {
    if (!running.win.isDestroyed()) running.win.focus();
    return Promise.resolve(null);
  }
  if (working) return Promise.resolve(null);
  const usable = parent && !parent.isDestroyed() ? parent : null;
  // A window hidden in the tray can still be asked for something. The question
  // must not wait where nobody can see it.
  if (usable && !usable.isVisible()) usable.show();
  return new Promise<T | null>((resolve) => {
    const win = new BrowserWindow({
      width: WIDTH,
      height: 300,
      useContentSize: true,
      resizable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      autoHideMenuBar: true,
      show: false,
      title: 'Krypto Mirror',
      backgroundColor: '#0f1016',
      parent: usable ?? undefined,
      modal: usable !== null,
      webPreferences: {
        preload: path.join(__dirname, 'promptPreload.js'),
        // Its own in-memory session, so the prompt shares nothing with the app
        // and nothing about it is written to disk.
        partition: 'vault-prompt',
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        webSecurity: true,
        webviewTag: false,
        spellcheck: false,
        devTools: !app.isPackaged,
      },
    });
    win.removeMenu();
    // Keeps the recovery key and typed text out of screen capture where the OS
    // supports it (Windows and macOS).
    if (process.platform !== 'linux') win.setContentProtection(true);
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    win.webContents.on('will-navigate', (e) => e.preventDefault());
    win.once('ready-to-show', () => {
      if (!win.isDestroyed()) win.show();
    });
    win.on('close', (e) => {
      // Mid-change: stay until the keys have finished moving.
      if (running?.win === win && working) e.preventDefault();
    });
    win.on('closed', () => {
      if (running?.win === win) {
        running = null;
        void Promise.resolve(inFlight).finally(() => resolve(null));
      }
    });
    running = { win, step: first as Step<unknown>, finish: resolve as (v: unknown) => void };
    void win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(PAGE)}`);
  });
}
