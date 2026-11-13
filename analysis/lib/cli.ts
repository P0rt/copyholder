// Small CLI helpers shared by quickcheck and doctor.

import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * True when the module at `metaUrl` is the script node was started with. Both paths go through
 * realpath, so a repository reached through a symlink still runs main() (tools/tts/run.ts does
 * the same): import.meta.url holds the real path, process.argv[1] the path that was typed.
 */
export function isMainModule(metaUrl: string, argv1: string | undefined = process.argv[1]): boolean {
  if (argv1 === undefined) return false;
  try {
    return fs.realpathSync(argv1) === fs.realpathSync(fileURLToPath(metaUrl));
  } catch {
    return false;
  }
}
