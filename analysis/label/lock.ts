// One label run per session folder at a time (spec 8.5: one confirmatory labelling). An exclusive
// lock file, created with O_EXCL, is held from before the step `onsets` until the run ends. A lock
// whose process is gone is taken over; any other lock refuses the run.

import fs from 'node:fs';
import path from 'node:path';

export const LOCK_FILE = 'label.lock';

export interface LabelLock {
  file: string;
  /** Removes the lock file (once; later calls do nothing). */
  release: () => void;
}

interface Holder {
  pid: number;
  utc: string;
}

function readHolder(file: string): Holder | null {
  try {
    const v = JSON.parse(fs.readFileSync(file, 'utf8')) as Partial<Holder>;
    return typeof v.pid === 'number' && Number.isInteger(v.pid) && v.pid > 0 ? { pid: v.pid, utc: String(v.utc ?? '?') } : null;
  } catch {
    return null;
  }
}

/** True when a process with this id runs (EPERM: it runs under another user). */
export function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** Takes <dir>/label.lock for this process, or says why not. */
export function acquireLabelLock(dir: string, utc: string, alive: (pid: number) => boolean = processAlive): LabelLock | { refused: string } {
  const file = path.join(dir, LOCK_FILE);
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      fs.writeFileSync(file, `${JSON.stringify({ pid: process.pid, utc })}\n`, { flag: 'wx' });
      let held = true;
      return {
        file,
        release: () => {
          if (!held) return;
          held = false;
          fs.rmSync(file, { force: true });
        },
      };
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
    }
    const holder = readHolder(file);
    if (holder === null) {
      return { refused: `${file} exists but names no process. If no label run is going, delete it and run again` };
    }
    if (alive(holder.pid)) {
      return { refused: `another label run (process ${holder.pid}, started ${holder.utc}) is labelling this recording: finish or stop it first` };
    }
    // Left by a run that died: take it over.
    fs.rmSync(file, { force: true });
  }
  return { refused: `${file} could not be taken. If no label run is going, delete it and run again` };
}
