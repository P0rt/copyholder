// npm run freeze -- <gate-prereg|gate-retune|freeze-1> [--check]
// Tag, OpenTimestamps stamp and push (spec 8.4, 13.3, 13.6, 14.2); the steps are in tools/freeze/run.ts.
// git takes the author from the repository's config; COPYHOLDER_OTS_COMMAND replaces the ots command.

import { realpathSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runFreeze } from './freeze/run.ts';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function isEntryPoint(): boolean {
  try {
    return process.argv[1] !== undefined && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isEntryPoint()) {
  process.exit(runFreeze(process.argv.slice(2), { repoDir: REPO_ROOT, env: process.env, log: (line) => console.log(line) }));
}
