// Dark or light (2026-10-22) — one class on <html>, and src/index.css does
// the rest.
//
// Per machine, like Krypto Bot's accent: it is a property of the screen you
// are sitting at, so it lives in this window's storage rather than in the
// settings file. `system` follows the OS and changes with it.
//
// Applied before React mounts (main.tsx), so a light-mode user never sees a
// dark first frame.

import { useSyncExternalStore } from 'react';

export type Appearance = 'dark' | 'light' | 'system';
export const APPEARANCES: Appearance[] = ['system', 'dark', 'light'];

const KEY = 'kcopy.appearance';
let current: Appearance = 'dark';
const listeners = new Set<() => void>();

const media = (): MediaQueryList | null => {
  try {
    return typeof window === 'undefined' ? null : window.matchMedia('(prefers-color-scheme: light)');
  } catch {
    return null;
  }
};

function read(): Appearance {
  try {
    const v = localStorage.getItem(KEY);
    return v === 'light' || v === 'dark' || v === 'system' ? v : 'dark';
  } catch {
    return 'dark';
  }
}

/** What the screen actually shows once `system` is resolved. */
export function resolved(a: Appearance = current): 'dark' | 'light' {
  if (a !== 'system') return a;
  return media()?.matches ? 'light' : 'dark';
}

function apply(): void {
  try {
    document.documentElement.classList.toggle('light', resolved() === 'light');
  } catch {
    /* no document: nothing to style */
  }
}

export function initAppearance(): void {
  current = read();
  apply();
  media()?.addEventListener('change', () => {
    if (current !== 'system') return;
    apply();
    for (const l of listeners) l();
  });
}

export function setAppearance(next: Appearance): void {
  current = next;
  try {
    localStorage.setItem(KEY, next);
  } catch {
    /* the class is applied; it just will not survive a restart */
  }
  apply();
  for (const l of listeners) l();
}

export function useAppearance(): Appearance {
  return useSyncExternalStore(
    (fn) => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    () => current,
  );
}
