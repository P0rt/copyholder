// Appending a step to ledger.jsonl (spec 8.5) with the core/schemas rules and node:crypto SHA-256.

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {
  LedgerError,
  appendLedger,
  isLedgerKind,
  splitJsonlLines,
  validateLedgerLine,
  type LedgerLine,
  type LedgerStep,
} from '../../core/schemas/index.ts';

/** SHA-256 of a text's UTF-8 bytes or of a file's bytes, 64 lowercase hex characters. */
export function sha256Hex(data: string | Uint8Array): string {
  return createHash('sha256').update(data).digest('hex');
}

/** UTC time without milliseconds, as host writes it: 2026-11-14T09:12:40Z. */
export function utcSeconds(date: Date): string {
  return date.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

export interface LedgerAppendResult {
  appended: boolean;
  /** The new line, when appended (or, from prepareLedgerStep, when it may be appended). */
  line: string | null;
  /** Why nothing was appended (a kind without a ledger, an order or chain problem). */
  reason: string | null;
}

function ledgerFile(dir: string): string {
  return path.join(dir, 'ledger.jsonl');
}

function readLedgerText(dir: string): string {
  try {
    return fs.readFileSync(ledgerFile(dir), 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
    return '';
  }
}

/** Valid lines of ledger.jsonl, parsed; a missing file or a broken line gives nothing for that line. */
export function ledgerRecords(lines: readonly string[] | null): LedgerLine[] {
  const out: LedgerLine[] = [];
  for (const line of lines ?? []) {
    try {
      const v = JSON.parse(line) as unknown;
      if (validateLedgerLine(v).length === 0) out.push(v as LedgerLine);
    } catch {
      // a broken line records nothing
    }
  }
  return out;
}

/**
 * The line `step` would get in <dir>/ledger.jsonl now, without writing anything (spec 8.5): the
 * chain and the step order are checked. `appended` is always false; `line` is null with the
 * reason when the ledger refuses the step. Lets a command check the ledger before it writes its
 * outputs, so a refused step never leaves a file whose hash the ledger does not hold.
 */
export function prepareLedgerStep(
  dir: string,
  kind: string,
  step: LedgerStep,
  fields: { utc: string; commit: string | null; outSha256: Record<string, string> },
): LedgerAppendResult {
  if (!isLedgerKind(kind)) return { appended: false, line: null, reason: `a ${kind} record has no ledger (spec 8.5)` };
  const lines = splitJsonlLines(readLedgerText(dir)).filter((l) => l.length > 0);
  try {
    const line = appendLedger(lines, step, { utc: fields.utc, commit: fields.commit, out_sha256: fields.outSha256 }, (s) => sha256Hex(s), { kind });
    return { appended: false, line, reason: null };
  } catch (e) {
    if (e instanceof LedgerError) return { appended: false, line: null, reason: e.problems.join('; ') };
    throw e;
  }
}

/** Appends one prepared line to <dir>/ledger.jsonl (a newline first when the file lacks its last one). */
export function writeLedgerLine(dir: string, line: string): void {
  const text = readLedgerText(dir);
  const sep = text.length > 0 && !text.endsWith('\n') ? '\n' : '';
  fs.appendFileSync(ledgerFile(dir), `${sep}${line}\n`);
}

/**
 * Appends `step` to <dir>/ledger.jsonl for a record kind with a ledger (spec 8.5). The chain and
 * the step order are checked first; on a problem nothing is written and the reason is returned.
 */
export function appendLedgerStep(
  dir: string,
  kind: string,
  step: LedgerStep,
  fields: { utc: string; commit: string | null; outSha256: Record<string, string> },
): LedgerAppendResult {
  const prepared = prepareLedgerStep(dir, kind, step, fields);
  if (prepared.line === null) return prepared;
  writeLedgerLine(dir, prepared.line);
  return { appended: true, line: prepared.line, reason: null };
}
