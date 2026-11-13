// Temporary git repositories for the freeze tests: a work clone with a bare remote named origin,
// git config that ignores the machine's, and a stand-in ots command. Nothing is stamped for real.
// A helper, not a test file (vitest collects *.test.ts only).

import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { OTS_ENV } from './ots.ts';

/** Writes <file>.ots with the header ots writes and the file's SHA-256; appends its argv to STUB_OTS_LOG. */
export const STUB_OTS = `
import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
const [cmd, file] = process.argv.slice(2);
if (process.env.STUB_OTS_LOG) appendFileSync(process.env.STUB_OTS_LOG, JSON.stringify(process.argv.slice(2)) + '\\n');
if (cmd !== 'stamp' || !file) { console.error('stub ots: usage'); process.exit(2); }
if (process.env.STUB_OTS_FAIL) { console.error('stub ots: no calendar answered'); process.exit(1); }
if (existsSync(file + '.ots')) { console.error('stub ots: exists'); process.exit(1); }
const magic = Buffer.from([0x00, ...Buffer.from('OpenTimestamps'), 0x00, 0x00, ...Buffer.from('Proof'), 0x00, 0xbf, 0x89, 0xe2, 0xe8, 0x84, 0xe8, 0x92, 0x94]);
const digest = createHash('sha256').update(readFileSync(file)).digest();
writeFileSync(file + '.ots', Buffer.concat([magic, Buffer.from([0x01, 0x08]), digest, Buffer.from([0xf0, 0x10]), Buffer.alloc(16, 7)]), { flag: 'wx' });
console.log('stub ots: submitted');
`;

export interface TempRepo {
  root: string;
  work: string;
  remote: string;
  env: NodeJS.ProcessEnv;
  otsLog: string;
  git(args: string[], cwd?: string): string;
  /** Writes a file of the work clone; null deletes it. */
  write(rel: string, content: string | Uint8Array | null): void;
  read(rel: string): Buffer;
  /** git add -A and commit; returns the new HEAD. */
  commitAll(message: string): string;
  /** ots calls the stand-in saw, as argv lists. */
  otsCalls(): string[][];
  remove(): void;
}

/** A work clone on main with origin, a bare repository; nothing committed yet. */
export function makeTempRepo(prefix: string): TempRepo {
  const root = mkdtempSync(join(tmpdir(), prefix));
  const work = join(root, 'work');
  const remote = join(root, 'remote.git');
  const stub = join(root, 'stub-ots.mjs');
  const otsLog = join(root, 'ots.log');
  writeFileSync(stub, STUB_OTS);
  writeFileSync(join(root, 'gitconfig'), '');
  // Hermetic git: no machine-wide signing or identity; the work clone's own config names the author.
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    GIT_CONFIG_GLOBAL: join(root, 'gitconfig'),
    GIT_CONFIG_NOSYSTEM: '1',
    [OTS_ENV]: JSON.stringify([process.execPath, stub]),
    STUB_OTS_LOG: otsLog,
  };
  for (const k of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_AUTHOR_NAME', 'GIT_AUTHOR_EMAIL', 'GIT_COMMITTER_NAME', 'GIT_COMMITTER_EMAIL']) delete env[k];
  const git = (args: string[], cwd = work): string => {
    const r = spawnSync('git', args, { cwd, env, encoding: 'utf8' });
    if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
    return r.stdout.trim();
  };
  git(['init', '--quiet', '--bare', '-b', 'main', remote], root);
  git(['init', '--quiet', '-b', 'main', work], root);
  git(['config', 'user.name', 'Freeze Test']);
  git(['config', 'user.email', 'freeze-test@example.invalid']);
  git(['remote', 'add', 'origin', remote]);
  return {
    root,
    work,
    remote,
    env,
    otsLog,
    git,
    write(rel, content) {
      const file = join(work, rel);
      if (content === null) {
        rmSync(file, { force: true });
        return;
      }
      mkdirSync(join(file, '..'), { recursive: true });
      writeFileSync(file, content);
    },
    read: (rel) => readFileSync(join(work, rel)),
    commitAll(message) {
      git(['add', '-A']);
      git(['commit', '--quiet', '-m', message]);
      return git(['rev-parse', 'HEAD']);
    },
    otsCalls() {
      try {
        return readFileSync(otsLog, 'utf8')
          .trim()
          .split('\n')
          .filter((l) => l !== '')
          .map((l) => JSON.parse(l) as string[]);
      } catch {
        return [];
      }
    },
    remove: () => rmSync(root, { recursive: true, force: true }),
  };
}
