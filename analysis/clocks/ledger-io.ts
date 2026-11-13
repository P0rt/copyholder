// Ledger and file helpers shared by `clocks` and `label` (spec 8.5): read and verify ledger.jsonl,
// say why a step may not run now, append note lines, and write a validated JSON file with its hash.

import fs from 'node:fs';
import path from 'node:path';
import {
  LedgerError,
  appendLedger,
  canAppendStep,
  findSteps,
  isLedgerKind,
  isNoteLine,
  splitJsonlLines,
  toJsonText,
  verifyLedger,
  type LedgerKind,
  type LedgerLine,
  type LedgerNoteLine,
  type LedgerStep,
  type LedgerStepLine,
  type OrderedJsonFile,
  type Validator,
} from '../../core/schemas/index.ts';
import { sha256Hex } from '../lib/ledger.ts';

export const LEDGER_FILE = 'ledger.jsonl';

export interface LedgerState {
  kind: LedgerKind;
  /** Lines without terminators. */
  lines: string[];
  records: LedgerLine[];
}

/** The ledger of a session folder, verified (chain and step order); throws LedgerRefusal on a problem. */
export function readLedger(dir: string, kind: string): LedgerState {
  if (!isLedgerKind(kind)) throw new LedgerRefusal(`a ${kind} record has no ledger (spec 8.5)`);
  let text: string;
  try {
    text = fs.readFileSync(path.join(dir, LEDGER_FILE), 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new LedgerRefusal(`${LEDGER_FILE} is missing: the record step was never written (spec 8.5)`);
    }
    throw e;
  }
  const lines = splitJsonlLines(text).filter((l) => l.length > 0);
  const v = verifyLedger(lines, sha256Hex, { kind });
  if (!v.ok) throw new LedgerRefusal(`${LEDGER_FILE} is broken:\n  ${v.errors.join('\n  ')}`);
  return { kind, lines, records: v.records };
}

/** A command may not run now: the ledger says so (spec 8.5). */
export class LedgerRefusal extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LedgerRefusal';
  }
}

/** Why `step` cannot be appended to this ledger now, or null (core/schemas canAppendStep). */
export function refusalFor(state: LedgerState, step: LedgerStep): string | null {
  return canAppendStep(state.records, state.kind, step);
}

/** Confirmatory lines of a step, in order. */
export function stepLines(state: LedgerState, step: LedgerStep): LedgerStepLine[] {
  return findSteps(state.records, step);
}

/** Note lines with this `what`, in order. */
export function noteLines(state: LedgerState, what: string): LedgerNoteLine[] {
  return state.records.filter((r): r is LedgerNoteLine => isNoteLine(r) && r.what === what);
}

export interface LedgerStamp {
  utc: string;
  commit: string | null;
}

/** Appends a note line `{"step":"note","what":...}` (spec 8.5: notes may stand anywhere). */
export function appendLedgerNote(dir: string, kind: LedgerKind, what: string, detail: string | null, stamp: LedgerStamp): string {
  const file = path.join(dir, LEDGER_FILE);
  const text = fs.readFileSync(file, 'utf8');
  const lines = splitJsonlLines(text).filter((l) => l.length > 0);
  const fields = detail === null ? { utc: stamp.utc, commit: stamp.commit, what } : { utc: stamp.utc, commit: stamp.commit, what, detail };
  let line: string;
  try {
    line = appendLedger(lines, 'note', fields, sha256Hex, { kind });
  } catch (e) {
    if (e instanceof LedgerError) throw new LedgerRefusal(e.problems.join('; '));
    throw e;
  }
  const sep = text.length > 0 && !text.endsWith('\n') ? '\n' : '';
  fs.appendFileSync(file, `${sep}${line}\n`);
  return line;
}

/**
 * Writes `value` as <dir>/<name> after checking it with `validate`: to a temporary file first,
 * then renamed over the old one, so a crash leaves either the old or the new file. Returns the
 * SHA-256 of the bytes written.
 */
export function writeJsonFile<T extends object>(dir: string, name: OrderedJsonFile | string, value: T, validate: Validator<T> | null): string {
  if (validate) {
    const problems = validate(value);
    if (problems.length > 0) throw new Error(`${name} would be invalid:\n  ${problems.join('\n  ')}`);
  }
  const ordered = (['calib.json', 'clock_report.json', 'onsets.json'] as const).find((f) => f === name) ?? null;
  const text = toJsonText(value, ordered);
  const file = path.join(dir, name);
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, text);
  fs.renameSync(tmp, file);
  return sha256Hex(Buffer.from(text, 'utf8'));
}

/** Reads and parses a JSON file; null when it does not exist. */
export function readJsonFile(dir: string, name: string): unknown {
  let text: string;
  try {
    text = fs.readFileSync(path.join(dir, name), 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw e;
  }
  return JSON.parse(text) as unknown;
}
