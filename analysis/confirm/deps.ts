// Side effects of npm run confirm behind one object, so tests can fix them: those of analyze:gate
// (analysis/gate/deps.ts: clock, commit, output, files under a git tag) and the time a tag was made.

import { execFileSync } from 'node:child_process';
import { defaultGateDeps, type GateDeps } from '../gate/deps.ts';
import { REPO_ROOT } from '../lib/paths.ts';

export interface ConfirmDeps extends GateDeps {
  /** When a git tag was made, ISO 8601 (read-only `git for-each-ref`); null when it is missing. */
  tagTime: (tag: string) => string | null;
}

/**
 * The time of a tag: the tagger date of an annotated tag, as npm run freeze makes them, else the
 * date of the tagged commit. Null when the tag is missing or git cannot be read.
 */
export function gitTagTime(tag: string): string | null {
  try {
    const out = execFileSync('git', ['for-each-ref', '--format=%(creatordate:iso-strict)', `refs/tags/${tag}`], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      timeout: 10_000,
      stdio: ['ignore', 'pipe', 'ignore'],
      env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', LC_ALL: 'C' },
    }).trim();
    return out === '' || out.includes('\n') || Number.isNaN(Date.parse(out)) ? null : out;
  } catch {
    return null;
  }
}

export function defaultConfirmDeps(): ConfirmDeps {
  return { ...defaultGateDeps(), tagTime: gitTagTime };
}
