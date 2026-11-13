// Where analysis finds session folders: the rule of live/lib/paths.cjs (spec 8.1).
// COPYHOLDER_SESSIONS_DIR moves the folder, so tests run against temporary folders.

import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** Repository root: two levels above analysis/lib/. */
export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/** Session id as host names folders (core/schemas SESSION_ID): gate-a, doctor-3, s1. */
const SESSION_ID = /^[a-z0-9][a-z0-9_-]{0,63}$/;

/** sessions/ of the repository, or COPYHOLDER_SESSIONS_DIR when set (live/lib/paths.cjs). */
export function sessionsDir(env: NodeJS.ProcessEnv = process.env): string {
  const v = env['COPYHOLDER_SESSIONS_DIR'];
  return v ? path.resolve(v) : path.join(REPO_ROOT, 'sessions');
}

/**
 * Folder of a session: a bare id (gate-a) lives in sessionsDir(); anything else (a path with a
 * slash, an absolute path, a name that is not an id) is taken as a folder path.
 */
export function sessionDirOf(idOrDir: string, env: NodeJS.ProcessEnv = process.env): string {
  if (SESSION_ID.test(idOrDir)) return path.join(sessionsDir(env), idOrDir);
  return path.resolve(idOrDir);
}

/** Path for messages: relative to the repository root when inside it (live/lib/paths.cjs shownPath). */
export function shownPath(p: string): string {
  const rel = path.relative(REPO_ROOT, p);
  return rel && !rel.startsWith('..') && !path.isAbsolute(rel) ? rel : p;
}
