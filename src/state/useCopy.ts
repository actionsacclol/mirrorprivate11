// The copy book, live (2026-10-22). Every Krypto Mirror page reads the same
// snapshot: fetched once on mount, then replaced by each `copy` event the
// engine pushes, so Home, Following and Activity never disagree.

import { useCallback, useEffect, useState } from 'react';
import type { CopySnapshot } from '@shared/copytrade';

let last: CopySnapshot | null = null;

export function useCopySnapshot(): { snap: CopySnapshot | null; reload: () => Promise<void>; set: (s: CopySnapshot) => void } {
  const [snap, setSnap] = useState<CopySnapshot | null>(last);
  const set = useCallback((s: CopySnapshot) => {
    last = s;
    setSnap(s);
  }, []);
  const reload = useCallback(async () => {
    const r = await window.krypt.copy.list();
    if (r.ok && r.data) set(r.data);
  }, [set]);
  useEffect(() => {
    void reload();
    return window.krypt.engine.onEvent((ev) => {
      if (ev.kind === 'copy') set(ev.snapshot);
    });
  }, [reload, set]);
  return { snap, reload, set };
}
