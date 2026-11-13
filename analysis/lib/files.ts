// Writing report files of a session folder so a crash never leaves half a file.

import fs from 'node:fs';
import path from 'node:path';

/** Writes `text` to a temporary file next to `file`, then renames it over `file`. */
export function writeFileAtomic(file: string, text: string): void {
  const tmp = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.tmp`);
  try {
    fs.writeFileSync(tmp, text);
    fs.renameSync(tmp, file);
  } catch (e) {
    fs.rmSync(tmp, { force: true });
    throw e;
  }
}
