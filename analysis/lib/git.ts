// Read-only git facts for ledger lines (spec 8.5): the short commit, as live/lib/repo-info.cjs reads it.

import { execFileSync } from 'node:child_process';
import { REPO_ROOT } from './paths.ts';

/** `git rev-parse --short=7 HEAD` in the repository; null outside a checkout. */
export function gitShortCommit(repoRoot: string = REPO_ROOT): string | null {
  try {
    const out = execFileSync('git', ['rev-parse', '--short=7', 'HEAD'], {
      cwd: repoRoot,
      encoding: 'utf8',
      timeout: 10_000,
      stdio: ['ignore', 'pipe', 'ignore'],
      env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', LC_ALL: 'C' },
    }).trim();
    return /^[0-9a-f]{7,40}$/.test(out) ? out : null;
  } catch {
    return null;
  }
}
