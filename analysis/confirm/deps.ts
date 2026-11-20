// Side effects of npm run confirm behind one object, so tests can fix them: those of analyze:gate
// (analysis/gate/deps.ts: clock, commit, output, files under a git tag), the bytes of a file under
// a git tag, and the time a tag was made.

import { execFileSync } from 'node:child_process';
import { defaultGateDeps, type GateDeps } from '../gate/deps.ts';
import { REPO_ROOT } from '../lib/paths.ts';

export interface ConfirmDeps extends GateDeps {
  /**
   * The bytes of a file under a git tag, by its repository path (read-only `git show`); null when
   * the tag or the file is missing. The pooled analysis code is compared with it byte for byte.
   */
  tagBytes: (tag: string, file: string) => Buffer | null;
  /** When a git tag was made, ISO 8601 (read-only `git for-each-ref`); null when it is missing. */
  tagTime: (tag: string) => string | null;
}

/** The environment of a read-only git command in `root`: no optional locks, and no repository named by the caller's environment. */
function gitEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, GIT_OPTIONAL_LOCKS: '0', LC_ALL: 'C' };
  for (const k of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE']) delete env[k];
  return env;
}

/**
 * `git show <tag>:<file>` in the repository at `root`, as bytes, with no text conversion; `file` is
 * a repository path with forward slashes. Null when the tag or the file is missing, or git cannot
 * be read.
 */
export function gitTagBytes(tag: string, file: string, root: string = REPO_ROOT): Buffer | null {
  try {
    return execFileSync('git', ['show', '--no-textconv', `${tag}:${file}`], {
      cwd: root,
      timeout: 10_000,
      maxBuffer: 256 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'ignore'],
      env: gitEnv(),
    });
  } catch {
    return null;
  }
}

/**
 * The time of a tag in the repository at `root`: the tagger date of an annotated tag, as npm run
 * freeze makes them, else the date of the tagged commit. Null when the tag is missing or git cannot
 * be read.
 */
export function gitTagTime(tag: string, root: string = REPO_ROOT): string | null {
  try {
    const out = execFileSync('git', ['for-each-ref', '--format=%(creatordate:iso-strict)', `refs/tags/${tag}`], {
      cwd: root,
      encoding: 'utf8',
      timeout: 10_000,
      stdio: ['ignore', 'pipe', 'ignore'],
      env: gitEnv(),
    }).trim();
    return out === '' || out.includes('\n') || Number.isNaN(Date.parse(out)) ? null : out;
  } catch {
    return null;
  }
}

export function defaultConfirmDeps(): ConfirmDeps {
  return { ...defaultGateDeps(), tagBytes: (tag, file) => gitTagBytes(tag, file), tagTime: (tag) => gitTagTime(tag) };
}
