// Side effects of analyze:gate behind one object, so tests can fix the clock, the commit and git.

import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { gitShortCommit } from '../lib/git.ts';
import { REPO_ROOT } from '../lib/paths.ts';

export interface GateDeps {
  env: NodeJS.ProcessEnv;
  now: () => Date;
  /** Short commit for ledger lines; null outside a checkout. */
  commit: () => string | null;
  log: (line: string) => void;
  /** Refusals and failures (stderr). */
  error: (line: string) => void;
  /** A file's text under a git tag (read-only `git show`); null when the tag or file is missing. */
  tagFile: (tag: string, file: string) => string | null;
}

/** `git show <tag>:<path>` for a file inside the repository; null otherwise. */
export function gitTagFile(tag: string, file: string): string | null {
  const rel = path.relative(REPO_ROOT, path.resolve(file));
  if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) return null;
  try {
    return execFileSync('git', ['show', `${tag}:${rel.split(path.sep).join('/')}`], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      timeout: 10_000,
      stdio: ['ignore', 'pipe', 'ignore'],
      env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', LC_ALL: 'C' },
    });
  } catch {
    return null;
  }
}

export function defaultGateDeps(): GateDeps {
  return {
    env: process.env,
    now: () => new Date(),
    commit: () => gitShortCommit(REPO_ROOT),
    log: (line) => process.stdout.write(`${line}\n`),
    error: (line) => process.stderr.write(`${line}\n`),
    tagFile: gitTagFile,
  };
}
