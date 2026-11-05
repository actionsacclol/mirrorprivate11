// How a file holding keys reaches the disk. No Electron, so tests run it as is.
//
// The three key stores each wrote their own way, and two of them skipped the
// flush: a power cut in the seconds after creating a wallet could leave an
// empty file where the only copy of a key had been.

import fs from 'node:fs';
import path from 'node:path';

export interface DurableOptions {
  /** Keep the previous file beside it as `<name>.bak`. It is never read
   *  automatically; a person can recover keys from it if the new one is damaged. */
  backup?: boolean;
  /** Runs on the bytes as they came back off the disk, before they replace
   *  anything. Throw to stop the write and keep the old file. */
  verify?: (written: string) => void;
}

/** Owner-only, flushed, then renamed over the target in one step. */
export function writeDurable(target: string, text: string, opts: DurableOptions = {}): void {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const tmp = `${target}.tmp`;
  const fd = fs.openSync(tmp, 'w', 0o600);
  try {
    fs.writeFileSync(fd, text, 'utf8');
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  if (opts.verify) opts.verify(fs.readFileSync(tmp, 'utf8'));
  if (opts.backup) {
    try {
      if (fs.existsSync(target)) fs.copyFileSync(target, `${target}.bak`);
    } catch {
      /* a missing backup must not block saving the keys */
    }
  }
  fs.renameSync(tmp, target);
}
