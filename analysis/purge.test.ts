// npm run purge (analysis/purge.ts) on temporary sessions/ and data/ folders: every mode, the
// refusals, and the path checks that keep it inside sessions/.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { EXAMPLE_SEAL, exampleManifest } from '../core/schemas/examples.ts';
import { toJsonText, type GatePack, type RecordKind } from '../core/schemas/index.ts';
import { idProblem, main, parsePurgeArgs } from './purge.ts';

interface Env {
  root: string;
  sessions: string;
  data: string;
  /** A folder beside sessions/ that purge must never touch. */
  outside: string;
  env: NodeJS.ProcessEnv;
}

let e: Env;

beforeEach(() => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'copyholder-purge-'));
  const sessions = path.join(root, 'sessions');
  const data = path.join(root, 'data');
  const outside = path.join(root, 'outside');
  fs.mkdirSync(sessions);
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(outside, 'keep.txt'), 'not a session\n');
  fs.writeFileSync(path.join(outside, 'sdk_raw.jsonl.gz'), 'raw elsewhere\n');
  e = { root, sessions, data, outside, env: { COPYHOLDER_SESSIONS_DIR: sessions, COPYHOLDER_DATA_DIR: data } };
});

afterEach(() => {
  fs.rmSync(e.root, { recursive: true, force: true });
});

const RAW_BYTES = 1234;

/** A session folder with a manifest, a few files and, unless `raw` is false, sdk_raw.jsonl.gz. */
function session(id: string, kind: RecordKind, o: { pack?: GatePack | null; raw?: boolean; manifest?: Record<string, unknown> } = {}): string {
  const dir = path.join(e.sessions, id);
  fs.mkdirSync(dir);
  const m = {
    ...exampleManifest(),
    id,
    kind,
    plan_commitment: kind === 'numbers' || kind === 'demo' ? EXAMPLE_SEAL : null,
    ...(kind === 'gate' ? { pack: o.pack ?? 'B' } : {}),
    ...o.manifest,
  };
  fs.writeFileSync(path.join(dir, 'manifest.json'), toJsonText(m, 'manifest.json', 2));
  fs.writeFileSync(path.join(dir, 'audio.wav'), Buffer.alloc(4000));
  fs.writeFileSync(path.join(dir, 'samples.jsonl'), '{"k":"m"}\n');
  if (o.raw !== false) fs.writeFileSync(path.join(dir, 'sdk_raw.jsonl.gz'), Buffer.alloc(RAW_BYTES));
  return dir;
}

function publish(id: string): void {
  fs.mkdirSync(path.join(e.data, id), { recursive: true });
  fs.writeFileSync(path.join(e.data, id, 'manifest.json'), '{}\n');
}

interface Run {
  code: number;
  out: string[];
  err: string[];
}

async function purge(argv: string[], env: NodeJS.ProcessEnv = e.env): Promise<Run> {
  const out: string[] = [];
  const err: string[] = [];
  const code = await main(argv, { env, log: (l) => out.push(l), error: (l) => err.push(l) });
  return { code, out, err };
}

function exists(...p: string[]): boolean {
  return fs.existsSync(path.join(...p));
}

/** Nothing outside sessions/ was touched. */
function expectOutsideIntact(): void {
  expect(fs.readdirSync(e.outside).sort()).toEqual(['keep.txt', 'sdk_raw.jsonl.gz']);
}

describe('purge command line', () => {
  it('parses the three forms', () => {
    expect(parsePurgeArgs(['gate-b', '--raw'])).toEqual({ id: 'gate-b', raw: true, all: false, yes: false, force: false });
    expect(parsePurgeArgs(['--raw', '--all', '--yes'])).toEqual({ id: null, raw: true, all: true, yes: true, force: false });
    expect(parsePurgeArgs(['doctor-1', '--yes', '--force'])).toEqual({ id: 'doctor-1', raw: false, all: false, yes: true, force: true });
  });

  it.each([
    [[], 'the session id is required'],
    [['--all'], '--all goes with --raw only'],
    [['gate-b', '--raw', '--all'], '--all takes no session id'],
    [['gate-b', '--raw', '--force'], '--force is for deleting a whole folder'],
    [['gate-b', '--now'], 'unknown option --now'],
    [['gate-b', 'gate-c'], 'unexpected argument gate-c'],
  ])('usage error for %j: exit 2, nothing deleted', async (argv, message) => {
    session('gate-b', 'gate');
    const r = await purge(argv as string[]);
    expect(r.code).toBe(2);
    expect(r.err.join('\n')).toContain(message);
    expect(r.err.join('\n')).toContain('usage: npm run purge -- <id> --raw [--yes]');
    expect(exists(e.sessions, 'gate-b', 'sdk_raw.jsonl.gz')).toBe(true);
  });

  it.each([
    ['../outside', 'holds a slash'],
    ['gate/b', 'holds a slash'],
    ['gate\\b', 'holds a slash'],
    ['..', 'holds a dot'],
    ['.', 'holds a dot'],
    ['gate.b', 'holds a dot'],
    ['Gate-B', 'is not a session id'],
  ])('refuses the id %j (exit 1)', async (id, message) => {
    expect(idProblem(id)).toContain(message);
    for (const argv of [[id, '--raw', '--yes'], [id, '--yes', '--force']]) {
      const r = await purge(argv);
      expect(r.code).toBe(1);
      expect(r.err.join('\n')).toContain(message);
    }
    expectOutsideIntact();
  });
});

describe('purge <id> --raw: sdk_raw.jsonl.gz only', () => {
  it('without --yes prints what it would delete and deletes nothing (exit 0)', async () => {
    session('gate-b', 'gate');
    const r = await purge(['gate-b', '--raw']);
    expect(r.code).toBe(0);
    expect(r.out).toEqual([
      `purge: would delete ${path.join(e.sessions, 'gate-b')}/sdk_raw.jsonl.gz (1,234 bytes)`,
      'nothing deleted: run again with --yes to delete it',
    ]);
    expect(exists(e.sessions, 'gate-b', 'sdk_raw.jsonl.gz')).toBe(true);
  });

  it('with --yes deletes only that file and prints the bytes freed', async () => {
    session('gate-b', 'gate');
    const r = await purge(['gate-b', '--raw', '--yes']);
    expect(r.code).toBe(0);
    expect(r.out).toEqual([`purge: deleted ${path.join(e.sessions, 'gate-b')}/sdk_raw.jsonl.gz: 1,234 bytes freed`]);
    expect(fs.readdirSync(path.join(e.sessions, 'gate-b')).sort()).toEqual(['audio.wav', 'manifest.json', 'samples.jsonl']);
  });

  it('a folder without the file: nothing to delete (exit 0)', async () => {
    session('gate-b', 'gate', { raw: false });
    const r = await purge(['gate-b', '--raw', '--yes']);
    expect(r.code).toBe(0);
    expect(r.out[0]).toContain('has no sdk_raw.jsonl.gz: nothing to delete');
  });

  it('refuses when sdk_raw.jsonl.gz is a link or no file, and a missing folder', async () => {
    const dir = session('gate-b', 'gate', { raw: false });
    fs.symlinkSync(path.join(e.outside, 'sdk_raw.jsonl.gz'), path.join(dir, 'sdk_raw.jsonl.gz'));
    let r = await purge(['gate-b', '--raw', '--yes']);
    expect(r.code).toBe(1);
    expect(r.err.join('\n')).toContain('sdk_raw.jsonl.gz is a link: purge deletes real files only');
    expect(fs.lstatSync(path.join(dir, 'sdk_raw.jsonl.gz')).isSymbolicLink()).toBe(true);
    const other = session('gate-c', 'gate', { raw: false });
    fs.mkdirSync(path.join(other, 'sdk_raw.jsonl.gz'));
    r = await purge(['gate-c', '--raw', '--yes']);
    expect(r.code).toBe(1);
    expect(r.err.join('\n')).toContain('sdk_raw.jsonl.gz is not a file');
    r = await purge(['gate-x', '--raw', '--yes']);
    expect(r.code).toBe(1);
    expect(r.err.join('\n')).toContain('no session folder');
    expectOutsideIntact();
  });
});

describe('purge --raw --all', () => {
  it('lists and deletes sdk_raw.jsonl.gz of every session folder, nothing else', async () => {
    session('gate-a', 'gate', { pack: 'A' });
    session('gate-b', 'gate');
    session('doctor-1', 'doctor', { raw: false });
    fs.writeFileSync(path.join(e.sessions, 'notes.txt'), 'kept\n');
    fs.mkdirSync(path.join(e.sessions, '.cache'));
    fs.writeFileSync(path.join(e.sessions, '.cache', 'sdk_raw.jsonl.gz'), 'not a session\n');
    let r = await purge(['--raw', '--all']);
    expect(r.code).toBe(0);
    expect(r.out).toEqual([
      'purge: would delete 2 files (2,468 bytes):',
      `  ${path.join(e.sessions, 'gate-a')}/sdk_raw.jsonl.gz (1,234 bytes)`,
      `  ${path.join(e.sessions, 'gate-b')}/sdk_raw.jsonl.gz (1,234 bytes)`,
      'nothing deleted: run again with --yes to delete them',
    ]);
    expect(exists(e.sessions, 'gate-a', 'sdk_raw.jsonl.gz')).toBe(true);
    r = await purge(['--raw', '--all', '--yes']);
    expect(r.code).toBe(0);
    expect(r.out[r.out.length - 1]).toBe('purge: deleted 2 files: 2,468 bytes freed');
    expect(exists(e.sessions, 'gate-a', 'sdk_raw.jsonl.gz')).toBe(false);
    expect(exists(e.sessions, 'gate-b', 'sdk_raw.jsonl.gz')).toBe(false);
    expect(exists(e.sessions, 'gate-a', 'samples.jsonl')).toBe(true);
    expect(exists(e.sessions, '.cache', 'sdk_raw.jsonl.gz')).toBe(true);
    expect(exists(e.sessions, 'notes.txt')).toBe(true);
    r = await purge(['--raw', '--all', '--yes']);
    expect(r.out).toEqual(['purge: no session folder holds sdk_raw.jsonl.gz: nothing to delete']);
  });

  it('refuses the whole run when a folder of sessions/ is a link to a place outside it', async () => {
    session('gate-b', 'gate');
    fs.symlinkSync(e.outside, path.join(e.sessions, 'gate-z'));
    const r = await purge(['--raw', '--all', '--yes']);
    expect(r.code).toBe(1);
    expect(r.err.join('\n')).toContain('gate-z is a link to a place outside sessions/');
    expect(exists(e.sessions, 'gate-b', 'sdk_raw.jsonl.gz')).toBe(true);
    expectOutsideIntact();
  });

  it('skips a link to another folder inside sessions/ and a dangling link', async () => {
    session('gate-b', 'gate');
    fs.symlinkSync(path.join(e.sessions, 'gate-b'), path.join(e.sessions, 'gate-y'));
    fs.symlinkSync(path.join(e.root, 'gone'), path.join(e.sessions, 'gate-w'));
    const r = await purge(['--raw', '--all', '--yes']);
    expect(r.code).toBe(0);
    expect(r.out.filter((l) => l.startsWith('note: '))).toEqual([
      `note: ${path.join(e.sessions, 'gate-w')} is a link to nothing: skipped`,
      `note: ${path.join(e.sessions, 'gate-y')} is a link inside sessions/: skipped, its folder is purged under its own name`,
    ]);
    expect(r.out[r.out.length - 1]).toBe('purge: deleted 1 file: 1,234 bytes freed');
    expect(fs.lstatSync(path.join(e.sessions, 'gate-y')).isSymbolicLink()).toBe(true);
  });
});

describe('purge <id>: the whole folder', () => {
  it('a development record: lists the files without --yes, deletes the folder with it', async () => {
    session('doctor-1', 'doctor');
    let r = await purge(['doctor-1']);
    expect(r.code).toBe(0);
    expect(r.out[0]).toBe(`purge: would delete ${path.join(e.sessions, 'doctor-1')}/ (4 files, ${(4000 + 10 + RAW_BYTES + fs.statSync(path.join(e.sessions, 'doctor-1', 'manifest.json')).size).toLocaleString('en-US')} bytes):`);
    expect(r.out.slice(1, 5).map((l) => l.trim().split(/\s+/)[0])).toEqual(['audio.wav', 'manifest.json', 'samples.jsonl', 'sdk_raw.jsonl.gz']);
    expect(r.out[5]).toBe('nothing deleted: run again with --yes to delete it');
    expect(exists(e.sessions, 'doctor-1')).toBe(true);
    r = await purge(['doctor-1', '--yes']);
    expect(r.code).toBe(0);
    expect(r.out[0]).toMatch(/^purge: deleted .*doctor-1\/ \(4 files\): [\d,]+ bytes freed$/);
    expect(exists(e.sessions, 'doctor-1')).toBe(false);
    expect(fs.readdirSync(e.sessions)).toEqual([]);
  });

  it.each([
    ['gate', 'B', 'a gate pack B recording'],
    ['gate', 'A', 'a gate pack A recording'],
    ['headstart', null, 'a headstart take'],
  ] as const)('refuses a %s record (pack %s) whose set data/<id>/ does not exist, unless --force', async (kind, p, what) => {
    session('r1', kind, { pack: p });
    for (const argv of [['r1'], ['r1', '--yes']]) {
      const r = await purge(argv);
      expect(r.code).toBe(1);
      expect(r.err.join('\n')).toContain(`r1 is ${what} and its set ${path.join(e.data, 'r1')}/ does not exist yet`);
      expect(exists(e.sessions, 'r1')).toBe(true);
    }
    const r = await purge(['r1', '--yes', '--force']);
    expect(r.code).toBe(0);
    expect(r.out[0]).toContain('note: --force: r1 is');
    expect(exists(e.sessions, 'r1')).toBe(false);
  });

  it.each([
    [{ tap: 'mock', sdk: null }, 'tap: "mock" (the mock tap made up the chest trace)'],
    [{ sdk: null }, 'sdk: null (no SDK ran)'],
    [{ dry: true }, 'dry: true (tap ran its stand-in SDK)'],
  ] as const)('a gate pack or headstart folder that no SDK measured (%j) waits for no set: deleted without --force, with a note', async (change, says) => {
    session('gate-a', 'gate', { pack: 'A', manifest: change });
    session('headstart-1', 'headstart', { manifest: change });
    for (const id of ['gate-a', 'headstart-1']) {
      let r = await purge([id]);
      expect(r.code, id).toBe(0);
      expect(r.out[0]).toBe(`note: manifest.json of ${id} says ${says}: no SDK measured this folder, so pack gives it no set and none waits for it`);
      expect(r.out[1]).toContain(`purge: would delete ${path.join(e.sessions, id)}/`);
      expect(r.out[r.out.length - 1]).toBe('nothing deleted: run again with --yes to delete it');
      expect(exists(e.sessions, id)).toBe(true);
      r = await purge([id, '--yes']);
      expect(r.code, id).toBe(0);
      expect(r.out[0]).toContain('note: manifest.json of');
      expect(exists(e.sessions, id)).toBe(false);
    }
    expect((await purge(['gate-a', '--yes'])).err.join('\n')).toContain('no session folder');
  });

  it('a folder of the real tap is still held back while its set does not exist', async () => {
    session('gate-a', 'gate', { pack: 'A', manifest: { tap: 'real', dry: false } });
    const r = await purge(['gate-a', '--yes']);
    expect(r.code).toBe(1);
    expect(r.err.join('\n')).toContain(`gate-a is a gate pack A recording and its set ${path.join(e.data, 'gate-a')}/ does not exist yet`);
    expect(exists(e.sessions, 'gate-a')).toBe(true);
  });

  it('deletes a gate pack folder once its set is published', async () => {
    session('gate-b', 'gate');
    publish('gate-b');
    const r = await purge(['gate-b', '--yes']);
    expect(r.code).toBe(0);
    expect(exists(e.sessions, 'gate-b')).toBe(false);
    expect(exists(e.data, 'gate-b', 'manifest.json')).toBe(true);
  });

  it('pack 0, the replaced kinds and the development records get no set, so their folders go without --force', async () => {
    session('gate-0', 'gate', { pack: '0' });
    session('s1', 'numbers');
    // PREREG section 11 dropped the rehearsal, and no reveal step exists: these are development data.
    session('rehearsal-1', 'rehearsal');
    session('pilot-1', 'pilot');
    for (const id of ['gate-0', 's1', 'rehearsal-1', 'pilot-1']) {
      const r = await purge([id, '--yes']);
      expect(r.code, id).toBe(0);
      expect(exists(e.sessions, id)).toBe(false);
    }
  });

  it('refuses a folder whose manifest.json cannot be read, unless --force', async () => {
    const dir = session('gate-b', 'gate');
    fs.writeFileSync(path.join(dir, 'manifest.json'), '{"kind":');
    let r = await purge(['gate-b', '--yes']);
    expect(r.code).toBe(1);
    expect(r.err.join('\n')).toContain('manifest.json of gate-b cannot be read');
    r = await purge(['gate-b', '--yes', '--force']);
    expect(r.code).toBe(0);
    expect(exists(e.sessions, 'gate-b')).toBe(false);
  });

  it('refuses a folder that is a link, to outside sessions/ or inside it, and one that is a file', async () => {
    fs.symlinkSync(e.outside, path.join(e.sessions, 'gate-z'));
    let r = await purge(['gate-z', '--yes', '--force']);
    expect(r.code).toBe(1);
    expect(r.err.join('\n')).toContain('gate-z is a link to a place outside sessions/');
    session('gate-b', 'gate');
    publish('gate-b');
    fs.symlinkSync(path.join(e.sessions, 'gate-b'), path.join(e.sessions, 'gate-y'));
    r = await purge(['gate-y', '--yes', '--force']);
    expect(r.code).toBe(1);
    expect(r.err.join('\n')).toContain('gate-y is a link to another folder in sessions/');
    expect(exists(e.sessions, 'gate-b', 'audio.wav')).toBe(true);
    fs.writeFileSync(path.join(e.sessions, 'gate-f'), 'a file\n');
    r = await purge(['gate-f', '--yes', '--force']);
    expect(r.code).toBe(1);
    expect(r.err.join('\n')).toContain('gate-f is not a folder');
    expectOutsideIntact();
  });

  it('a link inside the folder is deleted as a link; what it points to stays', async () => {
    const dir = session('doctor-1', 'doctor');
    fs.symlinkSync(e.outside, path.join(dir, 'elsewhere'));
    fs.mkdirSync(path.join(dir, 'clips'));
    fs.writeFileSync(path.join(dir, 'clips', 'o07.wav'), Buffer.alloc(10));
    let r = await purge(['doctor-1']);
    expect(r.out.some((l) => l.includes('elsewhere') && l.includes('(a link; only the link is deleted)'))).toBe(true);
    expect(r.out.some((l) => l.includes('clips/o07.wav'))).toBe(true);
    r = await purge(['doctor-1', '--yes']);
    expect(r.code).toBe(0);
    expect(exists(e.sessions, 'doctor-1')).toBe(false);
    expectOutsideIntact();
  });

  it('works when sessions/ itself is reached through a link (COPYHOLDER_SESSIONS_DIR)', async () => {
    session('doctor-1', 'doctor');
    const link = path.join(e.root, 'sessions-link');
    fs.symlinkSync(e.sessions, link);
    const r = await purge(['doctor-1', '--yes'], { ...e.env, COPYHOLDER_SESSIONS_DIR: link });
    expect(r.code).toBe(0);
    expect(exists(e.sessions, 'doctor-1')).toBe(false);
    expect(fs.lstatSync(link).isSymbolicLink()).toBe(true);
  });

  it('refuses a missing sessions/ folder', async () => {
    const r = await purge(['doctor-1', '--yes'], { ...e.env, COPYHOLDER_SESSIONS_DIR: path.join(e.root, 'none') });
    expect(r.code).toBe(1);
    expect(r.err.join('\n')).toContain('no sessions folder');
  });
});
