// The copy size Discover and the wallet page price a copier's figures at
// (2026-10-22). A viewing convenience — which size to show the numbers for —
// so it lives in localStorage, not in settings; nothing trades on it. Every
// read and write is guarded: storage can be missing or refuse, and the page
// then shows the default.

import { useEffect, useState } from 'react';
import { SCOUT_DEFAULT_SIZE_SOL } from '@shared/walletScout';
import { SIMPLE_SIZES } from '@shared/copytrade';

const KEY = 'kc.boardSizeSol';
const EVENT = 'kc:board-size';

/** The sizes offered: the follow wizard's. */
export const BOARD_SIZES: readonly number[] = SIMPLE_SIZES;

function read(): number {
  try {
    const v = Number(localStorage.getItem(KEY));
    return BOARD_SIZES.includes(v) ? v : SCOUT_DEFAULT_SIZE_SOL;
  } catch {
    return SCOUT_DEFAULT_SIZE_SOL;
  }
}

/** The size, and a setter every open page hears. */
export function useBoardSize(): [number, (v: number) => void] {
  const [size, setSize] = useState(read);
  useEffect(() => {
    const on = (): void => setSize(read());
    window.addEventListener(EVENT, on);
    return () => window.removeEventListener(EVENT, on);
  }, []);
  const set = (v: number): void => {
    try {
      localStorage.setItem(KEY, String(v));
    } catch {
      /* the page still changes for this visit */
    }
    setSize(v);
    window.dispatchEvent(new Event(EVENT));
  };
  return [size, set];
}
