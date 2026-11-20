// Shared constants and the refusal of npm run confirm: the pooled confirmation of PREREG.md
// section 11 (packs B and C), computed with the functions stage B of analyze:gate uses.

import path from 'node:path';
import { CIRCULAR_SHIFT_COUNT, CIRCULAR_SHIFT_SEED } from '../../core/stats/index.ts';
import { REPO_ROOT, isSessionId, shownPath } from '../lib/paths.ts';

/** One-sided level of the H1 test and of H3 and H4 after Holm's correction (PREREG §9.1, §11). */
export const ALPHA = 0.05;
/** Level of every interval: Wilson, order statistics, Poisson (PREREG §9.1). */
export const CONFIDENCE = 0.95;
/** Sensitivity line of PREREG §5: all onsets this much earlier. */
export const EARLIER_MS = 25;
/** Sensitivity line of PREREG §3.2 and §5: an objection needs this much voiced sound. */
export const OBJECTION_400_MS = 400;
/** The separate count of PREREG §3.2: only leads under 300 ms. */
export const UNDER_MS = 300;
/** Circular shifts and their seed (PREREG §9.2 item 2), fixed in core/stats before any data. */
export const SHIFT_COUNT = CIRCULAR_SHIFT_COUNT;
export const SHIFT_SEED = CIRCULAR_SHIFT_SEED;
/** The paired-comparison margin of PREREG §6.5, as core/detector compares stops. */
export const WIN_MARGIN_MS = 33;

/** A refusal: npm run confirm prints the message and exits 1 without writing anything. */
export class ConfirmRefusal extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfirmRefusal';
  }
}

/**
 * The refusal of a recording of pack B or C that failed for a technical reason before its objection
 * block began (4:15), the SDK credits aside: by section 11 the pack is recorded again, so this
 * recording is not the pack's.
 */
export class RecordAgainRefusal extends ConfirmRefusal {
  constructor(message: string) {
    super(message);
    this.name = 'RecordAgainRefusal';
  }
}

/**
 * The refusal of a recording whose manifest.json says closed but that has no ledger.jsonl: host did
 * not finish saving it, or its ledger.jsonl was removed later (load.ts inspectPack). No later
 * recording of its pack can be judged against it either.
 */
export class UnsavedRefusal extends ConfirmRefusal {
  constructor(message: string) {
    super(message);
    this.name = 'UnsavedRefusal';
  }
}

/** A file system error: an Error with a string code (ENOENT, EISDIR, EACCES, ...). */
export function isFsError(e: unknown): e is NodeJS.ErrnoException {
  return e instanceof Error && typeof (e as NodeJS.ErrnoException).code === 'string';
}

/** What to do about a file confirm cannot read, as the end of a sentence. */
export const MAKE_READABLE = 'make it readable to this user (where a folder stands in place of the file, put the file back), then run npm run confirm again';

/**
 * The refusal of a file confirm cannot read: a folder stands in its place, this user may not read
 * it, or the disk failed. It names the file and the error and says what to do.
 */
export class UnreadableFileRefusal extends ConfirmRefusal {
  /** The file as messages show it, or "a file of <folder>" when the error names no file. */
  readonly where: string;
  /** The message of the file system error. */
  readonly error: string;
  constructor(where: string, error: string) {
    super(`${where} cannot be read (${error}): ${MAKE_READABLE} (PREREG.md section 11)`);
    this.name = 'UnreadableFileRefusal';
    this.where = where;
    this.error = error;
  }

  /** The message without its reference, to go inside another sentence. */
  get bare(): string {
    return `${this.where} cannot be read (${this.error}): ${MAKE_READABLE}`;
  }
}

/**
 * The refusal of the file system error `e`, met while reading the folder `dir`: it names the file
 * the error names, else the folder (reading a folder in place of a file gives an error with no path).
 */
export function unreadableFile(e: NodeJS.ErrnoException, dir: string): UnreadableFileRefusal {
  return new UnreadableFileRefusal(typeof e.path === 'string' ? shownPath(e.path) : `a file of ${shownPath(dir)}`, e.message);
}

/**
 * How to name a recording that is to be given on the command line: its id, or, when its folder
 * has another name (an operator renamed it, and host may then give the old name to a later
 * recording), the folder with the id, "gate-c-failed (the folder of gate-c)". `folder` is the folder
 * as the command line takes it (folderArg), or its name in a report.
 */
export function givenName(id: string, folder: string): string {
  return folder === id ? id : `${folder} (the folder of ${id})`;
}

/**
 * The folder `dir` as npm run confirm, npm run quickcheck and npm run analyze:gate take it on the
 * command line: its name when that is a session id, which they look for in the sessions folder, and
 * else its path as messages show it, which they take as a folder path (analysis/lib/paths.ts
 * sessionDirOf). npm run runs them from the repository root, where that path leads to the folder.
 */
export function folderArg(dir: string): string {
  const name = path.basename(dir);
  return isSessionId(name) ? name : shownPath(dir);
}

/** How a report names a recording: its id, or its id and folder when an operator renamed the folder, "gate-c in the folder gate-c-failed". */
export function namedIn(id: string, folder: string): string {
  return folder === id ? id : `${id} in the folder ${folder}`;
}

/** results/ of the repository, or COPYHOLDER_RESULTS_DIR when set (tests write to temporary folders). */
export function resultsDir(env: NodeJS.ProcessEnv = process.env): string {
  const v = env['COPYHOLDER_RESULTS_DIR'];
  return v ? path.resolve(v) : path.join(REPO_ROOT, 'results');
}

/** Rounds to `digits` decimals for confirm.json; null stays null. */
export function roundTo(x: number, digits: number): number {
  const f = 10 ** digits;
  return Math.round(x * f) / f;
}

export function roundOrNull(x: number | null, digits: number): number | null {
  return x === null ? null : roundTo(x, digits);
}
