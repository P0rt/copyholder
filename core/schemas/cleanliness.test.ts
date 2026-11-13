// Spec 13.4 "Чистота": the git tree and history hold no .env, settings.env, sdk_raw.jsonl.gz,
// samples.jsonl or video files (whyNotInGit decides). Where .env holds the key, on the Mac, the
// test also looks for the key's value there (assumption). Skipped outside a git work tree.
// The key never goes into a command line or a message: git reads it on stdin, and the history
// is scanned in this process.
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { whyNotInGit } from './index.ts';

const REPO_ROOT = realpathSync(fileURLToPath(new URL('../..', import.meta.url)));
/** The .env variable that holds the SDK key; only tap reads it (spec 13.6, .env.example). */
const KEY_NAME = 'SMARTSPECTRA_API_KEY';
/** A shorter value is a placeholder, not a key: searching for it would match ordinary text. */
const MIN_KEY_LENGTH = 8;
const GIT_ENV = { ...process.env, GIT_OPTIONAL_LOCKS: '0', LC_ALL: 'C' };

function git(args: readonly string[], input?: string): { status: number | null; stdout: string } {
  const r = spawnSync('git', ['-c', 'core.quotepath=off', ...args], {
    cwd: REPO_ROOT, env: GIT_ENV, input, encoding: 'utf8', maxBuffer: 512 * 1024 * 1024,
  });
  return { status: r.error === undefined ? r.status : null, stdout: r.stdout ?? '' };
}

/** Why the git checks cannot run here, or null when the repository is the top of a git work tree. */
function whyNoGit(): string | null {
  const top = git(['rev-parse', '--show-toplevel']);
  if (top.status !== 0) return 'not a git work tree: the git tree and history cannot be checked here (spec 13.4)';
  if (realpathSync(top.stdout.trim()) !== REPO_ROOT) return 'the repository folder is not the top of its git work tree (spec 13.4)';
  return null;
}

/** Every path in the tree (tracked files) and every path any commit of any ref touched. */
function pathsInTreeAndHistory(): string[] {
  const tree = git(['ls-files', '-z']).stdout.split('\0');
  const history = git(['log', '--all', '-m', '--name-only', '--pretty=format:', '-z']).stdout.split(/[\0\n]/);
  return [...new Set([...tree, ...history].filter((p) => p !== ''))].sort();
}

/** The key value from .env in the repository root, read as tap reads it; null without one. */
function keyFromDotEnv(): string | null {
  const file = join(REPO_ROOT, '.env');
  if (!existsSync(file)) return null;
  for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
    if (m === null || m[1] !== KEY_NAME) continue;
    const value = m[2] ?? '';
    const quoted = /^(["'])(.*?)\1\s*(?:#.*)?$/.exec(value);
    return quoted !== null ? (quoted[2] ?? '') : value.replace(/(^|\s+)#.*$/, '');
  }
  return null;
}

/** True when a tracked file in the work tree holds `needle` (git grep reads it on stdin). */
function treeHolds(needle: string): boolean {
  const r = git(['grep', '-q', '-F', '-f', '-'], `${needle}\n`);
  if (r.status !== 0 && r.status !== 1) throw new Error(`git grep failed with status ${String(r.status)}`);
  return r.status === 0;
}

/** True when any object reachable from a ref holds `needle`: file contents of every version, trees, commit messages. */
async function historyHolds(needle: string): Promise<boolean> {
  const ids = git(['rev-list', '--all', '--objects'])
    .stdout.split('\n')
    .map((line) => line.split(' ')[0] ?? '')
    .filter((id) => id !== '');
  if (ids.length === 0) return false;
  const want = Buffer.from(needle, 'utf8');
  return new Promise<boolean>((resolve, reject) => {
    const child = spawn('git', ['cat-file', '--batch'], { cwd: REPO_ROOT, env: GIT_ENV, stdio: ['pipe', 'pipe', 'ignore'] });
    let carry = Buffer.alloc(0);
    let found = false;
    child.stdout.on('data', (chunk: Buffer) => {
      if (found) return;
      const hay = Buffer.concat([carry, chunk]);
      if (hay.includes(want)) {
        found = true;
        child.kill();
        return;
      }
      carry = Buffer.from(hay.subarray(Math.max(0, hay.length - want.length + 1)));
    });
    child.stdin.on('error', () => undefined); // git stops reading once it is killed
    child.on('error', reject);
    child.on('close', (code) => {
      if (found || code === 0) resolve(found);
      else reject(new Error(`git cat-file failed with status ${String(code)}`));
    });
    child.stdin.end(`${ids.join('\n')}\n`);
  });
}

describe('the git tree and history are clean (spec 13.4 "Чистота", 13.6)', () => {
  const noGit = whyNoGit();

  it('no tracked file and no file in the history is one that never goes into git', (ctx) => {
    if (noGit !== null) return ctx.skip(noGit);
    const found = pathsInTreeAndHistory().flatMap((path) => {
      const why = whyNotInGit(path);
      return why === null ? [] : [`${path}: ${why}`];
    });
    expect(found).toEqual([]);
  });

  it('the key from .env is in no tracked file and nowhere in the history (on the Mac)', { timeout: 120_000 }, async (ctx) => {
    if (noGit !== null) return ctx.skip(noGit);
    const key = keyFromDotEnv();
    if (key === null || key.length < MIN_KEY_LENGTH) {
      return ctx.skip(`no ${KEY_NAME} in .env here: the key search runs where .env holds the key, on the Mac (spec 13.4, assumption)`);
    }
    expect(treeHolds(key), `the ${KEY_NAME} value from .env is in a tracked file`).toBe(false);
    expect(await historyHolds(key), `the ${KEY_NAME} value from .env is in the git history`).toBe(false);
  });
});
