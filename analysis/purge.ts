// npm run purge -- <id> --raw [--yes]        deletes only sessions/<id>/sdk_raw.jsonl.gz
// npm run purge -- --raw --all [--yes]       the same for every session folder
// npm run purge -- <id> [--yes] [--force]    deletes the whole sessions/<id>/ folder
//
// sdk_raw.jsonl.gz holds the full face mesh of a recording, and the session folder holds the
// voice; spec 8.7 says to delete them once the sets are published (flag --raw: assumption).
// Without --yes purge only prints what it would delete. It deletes inside sessions/ only
// (COPYHOLDER_SESSIONS_DIR moves it): an id is a folder name, never a path, a link is never
// followed, and every folder must resolve to a real folder directly inside sessions/. Deleting the
// folder of a gate pack A, B or C or of a headstart take is refused while its set data/<id>/ does
// not exist (COPYHOLDER_DATA_DIR moves data/): without the folder the set cannot be built. --force
// deletes it anyway. A folder that no SDK measured (a dry run, the mock tap, a run without the SDK:
// pack/rules.ts whyNotMeasured) gets no set from pack, so it waits for none and is not held back.
// Exit codes: 0 deleted, nothing to delete, or only printed (no --yes); 1 refused (nothing
// deleted); 2 usage.

import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { SESSION_ID } from '../core/schemas/index.ts';
import { dataDir, sessionsDir, shownPath } from './lib/paths.ts';
import { PackRefusal, formatBytes, groupDigits, manifestKindOf, whyNoSet } from './pack/rules.ts';

export const USAGE = [
  'usage: npm run purge -- <id> --raw [--yes]        deletes only sessions/<id>/sdk_raw.jsonl.gz',
  '       npm run purge -- --raw --all [--yes]       the same for every session folder',
  '       npm run purge -- <id> [--yes] [--force]    deletes the whole sessions/<id>/ folder',
].join('\n');

/** The raw SDK output: never published, deleted by --raw (spec 8.7, 13.4). */
export const RAW_FILE = 'sdk_raw.jsonl.gz';

export interface PurgeArgs {
  /** Session id; null with --all. */
  id: string | null;
  raw: boolean;
  all: boolean;
  yes: boolean;
  force: boolean;
}

/** Parses the command line; returns a message for a usage error. */
export function parsePurgeArgs(argv: readonly string[]): PurgeArgs | string {
  let id: string | null = null;
  const o = { raw: false, all: false, yes: false, force: false };
  for (const a of argv) {
    if (a === '--raw') o.raw = true;
    else if (a === '--all') o.all = true;
    else if (a === '--yes') o.yes = true;
    else if (a === '--force') o.force = true;
    else if (a.startsWith('-')) return `unknown option ${a}`;
    else if (id === null) id = a;
    else return `unexpected argument ${a}: purge takes one session id`;
  }
  if (o.all && !o.raw) return '--all goes with --raw only: npm run purge -- --raw --all';
  if (o.all && id !== null) return '--all takes no session id';
  if (!o.all && id === null) return 'the session id is required (or --raw --all)';
  if (o.force && o.raw) return '--force is for deleting a whole folder; --raw deletes sdk_raw.jsonl.gz only';
  return { id, ...o };
}

export interface PurgeDeps {
  env: NodeJS.ProcessEnv;
  log: (line: string) => void;
  /** Refusals (stderr). */
  error: (line: string) => void;
}

export function defaultPurgeDeps(): PurgeDeps {
  return {
    env: process.env,
    log: (line) => process.stdout.write(`${line}\n`),
    error: (line) => process.stderr.write(`${line}\n`),
  };
}

/** Why an id cannot name a folder of sessions/, or null. */
export function idProblem(id: string): string | null {
  if (id.includes('/') || id.includes('\\')) return `"${id}" holds a slash: purge takes the name of a folder in sessions/, never a path`;
  if (id.includes('.')) return `"${id}" holds a dot: purge takes the name of a folder in sessions/ (like gate-b), never . or ..`;
  if (!SESSION_ID.test(id)) return `"${id}" is not a session id (like gate-b or headstart-1)`;
  return null;
}

function lstatOrNull(p: string): fs.Stats | null {
  try {
    return fs.lstatSync(p);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw e;
  }
}

function realpathOrNull(p: string): string | null {
  try {
    return fs.realpathSync(p);
  } catch {
    return null;
  }
}

/** True when `p` lies strictly inside `root` (both real paths). */
function isInside(root: string, p: string): boolean {
  const rel = path.relative(root, p);
  return rel !== '' && rel.split(path.sep)[0] !== '..' && !path.isAbsolute(rel);
}

interface Roots {
  /** sessions/ as configured, for printing. */
  shown: string;
  /** Its real path: everything purge deletes lies directly inside it. */
  real: string;
}

function sessionsRoots(env: NodeJS.ProcessEnv): Roots {
  const root = sessionsDir(env);
  const real = realpathOrNull(root);
  if (real === null || !fs.statSync(real).isDirectory()) throw new PackRefusal(`no sessions folder ${shownPath(root)}`);
  return { shown: root, real };
}

/**
 * The real path of sessions/<id>/, refused unless it is a real folder directly inside sessions/:
 * a link (to anywhere) is refused, so nothing outside sessions/ is ever reached through one.
 */
function sessionFolder(roots: Roots, id: string): string {
  const given = path.join(roots.real, id);
  const shown = shownPath(path.join(roots.shown, id));
  const st = lstatOrNull(given);
  if (st === null) throw new PackRefusal(`no session folder ${shown}`);
  if (st.isSymbolicLink()) {
    const real = realpathOrNull(given);
    if (real !== null && isInside(roots.real, real)) {
      throw new PackRefusal(`${shown} is a link to another folder in sessions/: purge deletes real folders only, under their own names`);
    }
    throw new PackRefusal(`${shown} is a link to ${real === null ? 'nothing' : 'a place outside sessions/'}: purge deletes inside sessions/ only and never follows a link`);
  }
  if (!st.isDirectory()) throw new PackRefusal(`${shown} is not a folder`);
  const real = realpathOrNull(given);
  if (real === null || path.dirname(real) !== roots.real || path.basename(real) !== id) {
    throw new PackRefusal(`${shown} does not resolve to the folder ${id} directly inside sessions/`);
  }
  return real;
}

interface RawFile {
  file: string;
  shown: string;
  bytes: number;
}

/** sdk_raw.jsonl.gz of a session folder; null when there is none; a problem when it is a link or no file. */
function rawFileOf(folder: string, shownFolder: string): RawFile | string | null {
  const file = path.join(folder, RAW_FILE);
  const shown = `${shownFolder}/${RAW_FILE}`;
  const st = lstatOrNull(file);
  if (st === null) return null;
  if (st.isSymbolicLink()) return `${shown} is a link: purge deletes real files only (the raw data would stay where the link points)`;
  if (!st.isFile()) return `${shown} is not a file`;
  return { file, shown, bytes: st.size };
}

/** Files under a folder with their sizes, relative names, links listed as links and never followed. */
function listTree(dir: string, rel = ''): { name: string; bytes: number; link: boolean }[] {
  const out: { name: string; bytes: number; link: boolean }[] = [];
  for (const e of fs.readdirSync(path.join(dir, rel), { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
    const name = rel === '' ? e.name : `${rel}/${e.name}`;
    if (e.isDirectory()) out.push(...listTree(dir, name));
    else out.push({ name, bytes: fs.lstatSync(path.join(dir, name)).size, link: e.isSymbolicLink() });
  }
  return out;
}

function hasPublishedSet(env: NodeJS.ProcessEnv, id: string): boolean {
  try {
    return fs.statSync(path.join(dataDir(env), id, 'manifest.json')).isFile();
  } catch {
    return false;
  }
}

function purgeRawOne(roots: Roots, id: string, yes: boolean, deps: PurgeDeps): number {
  const folder = sessionFolder(roots, id);
  const shownFolder = shownPath(path.join(roots.shown, id));
  const raw = rawFileOf(folder, shownFolder);
  if (typeof raw === 'string') throw new PackRefusal(raw);
  if (raw === null) {
    deps.log(`purge: ${shownFolder} has no ${RAW_FILE}: nothing to delete`);
    return 0;
  }
  if (!yes) {
    deps.log(`purge: would delete ${raw.shown} (${formatBytes(raw.bytes)})`);
    deps.log('nothing deleted: run again with --yes to delete it');
    return 0;
  }
  fs.unlinkSync(raw.file);
  deps.log(`purge: deleted ${raw.shown}: ${formatBytes(raw.bytes)} freed`);
  return 0;
}

function purgeRawAll(roots: Roots, yes: boolean, deps: PurgeDeps): number {
  const found: RawFile[] = [];
  const problems: string[] = [];
  const skipped: string[] = [];
  const entries = fs.readdirSync(roots.real, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  for (const e of entries) {
    if (!SESSION_ID.test(e.name)) continue;
    const shownFolder = shownPath(path.join(roots.shown, e.name));
    if (e.isSymbolicLink()) {
      const real = realpathOrNull(path.join(roots.real, e.name));
      if (real === null) skipped.push(`${shownFolder} is a link to nothing: skipped`);
      else if (isInside(roots.real, real)) skipped.push(`${shownFolder} is a link inside sessions/: skipped, its folder is purged under its own name`);
      else problems.push(`${shownFolder} is a link to a place outside sessions/: purge deletes inside sessions/ only and never follows a link`);
      continue;
    }
    if (!e.isDirectory()) continue;
    const raw = rawFileOf(path.join(roots.real, e.name), shownFolder);
    if (typeof raw === 'string') problems.push(raw);
    else if (raw !== null) found.push(raw);
  }
  if (problems.length > 0) throw new PackRefusal(`nothing deleted:\n  ${problems.join('\n  ')}`);
  for (const s of skipped) deps.log(`note: ${s}`);
  if (found.length === 0) {
    deps.log(`purge: no session folder holds ${RAW_FILE}: nothing to delete`);
    return 0;
  }
  const total = found.reduce((s, f) => s + f.bytes, 0);
  const files = `${found.length} ${found.length === 1 ? 'file' : 'files'}`;
  if (!yes) {
    deps.log(`purge: would delete ${files} (${formatBytes(total)}):`);
    for (const f of found) deps.log(`  ${f.shown} (${formatBytes(f.bytes)})`);
    deps.log('nothing deleted: run again with --yes to delete them');
    return 0;
  }
  for (const f of found) {
    fs.unlinkSync(f.file);
    deps.log(`purge: deleted ${f.shown} (${formatBytes(f.bytes)})`);
  }
  deps.log(`purge: deleted ${files}: ${formatBytes(total)} freed`);
  return 0;
}

function purgeFolder(roots: Roots, id: string, yes: boolean, force: boolean, deps: PurgeDeps): number {
  const folder = sessionFolder(roots, id);
  const shownFolder = shownPath(path.join(roots.shown, id));
  const record = manifestKindOf(folder);
  const setDir = shownPath(path.join(dataDir(deps.env), id));
  if (record === null) {
    if (!force) {
      throw new PackRefusal(`manifest.json of ${id} cannot be read or names no known kind, so purge cannot tell whether the folder still waits for its set ${setDir}/; add --force to delete it anyway`);
    }
    deps.log(`note: --force: manifest.json of ${id} cannot be read; the folder is deleted without that check`);
  } else if (whyNoSet(record.kind, record.pack) === null && record.notMeasured !== null) {
    // pack refuses such a folder (spec 6.5), so no set waits for it.
    deps.log(`note: manifest.json of ${id} says ${record.notMeasured}: no SDK measured this folder, so pack gives it no set and none waits for it`);
  } else if (whyNoSet(record.kind, record.pack) === null && !hasPublishedSet(deps.env, id)) {
    const what = record.kind === 'gate' ? `a gate pack ${String(record.pack)} recording` : 'a headstart take';
    if (!force) {
      throw new PackRefusal(
        `${id} is ${what} and its set ${setDir}/ does not exist yet: without the folder the set cannot be built. Run npm run pack -- ${id} first, or add --force to delete it anyway`,
      );
    }
    deps.log(`note: --force: ${id} is ${what} without its set ${setDir}/, which can no longer be built once the folder is gone`);
  }
  const files = listTree(folder);
  const total = files.reduce((s, f) => s + f.bytes, 0);
  const count = `${files.length} ${files.length === 1 ? 'file' : 'files'}`;
  if (!yes) {
    deps.log(`purge: would delete ${shownFolder}/ (${count}, ${formatBytes(total)}):`);
    const width = Math.max(0, ...files.map((f) => f.name.length));
    const sizeWidth = Math.max(0, ...files.map((f) => groupDigits(f.bytes).length));
    for (const f of files) {
      deps.log(`  ${f.name.padEnd(width)}  ${groupDigits(f.bytes).padStart(sizeWidth)} ${f.bytes === 1 ? 'byte' : 'bytes'}${f.link ? ' (a link; only the link is deleted)' : ''}`);
    }
    deps.log('nothing deleted: run again with --yes to delete it');
    return 0;
  }
  // rmSync removes links inside the folder without following them.
  fs.rmSync(folder, { recursive: true });
  deps.log(`purge: deleted ${shownFolder}/ (${count}): ${formatBytes(total)} freed`);
  return 0;
}

/** Runs purge; throws PackRefusal when nothing may be deleted. */
export function runPurge(args: PurgeArgs, deps: PurgeDeps): number {
  if (args.id !== null) {
    const bad = idProblem(args.id);
    if (bad !== null) throw new PackRefusal(bad);
  }
  const roots = sessionsRoots(deps.env);
  if (args.raw && args.all) return purgeRawAll(roots, args.yes, deps);
  const id = args.id!;
  if (args.raw) return purgeRawOne(roots, id, args.yes, deps);
  return purgeFolder(roots, id, args.yes, args.force, deps);
}

export async function main(argv: readonly string[], deps: PurgeDeps = defaultPurgeDeps()): Promise<number> {
  const args = parsePurgeArgs(argv);
  if (typeof args === 'string') {
    deps.error(`${args}\n${USAGE}`);
    return 2;
  }
  try {
    return runPurge(args, deps);
  } catch (e) {
    if (e instanceof PackRefusal) {
      deps.error(`purge refused: ${e.message}`);
      return 1;
    }
    throw e;
  }
}

const invokedDirectly = process.argv[1] !== undefined && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (invokedDirectly) {
  main(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (e: unknown) => {
      process.stderr.write(`purge failed: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}\n`);
      process.exitCode = 1;
    },
  );
}
