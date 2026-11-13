// The step journal around analyze:gate (spec 8.5, 9.5): a step does not start without the hash of
// the previous one; stage B runs once, and every later run is exploratory and says so.

import fs from 'node:fs';
import path from 'node:path';
import {
  LedgerError,
  appendLedger,
  canAppendStep,
  findSteps,
  isNoteLine,
  splitJsonlLines,
  verifyLedger,
  type LedgerLine,
  type LedgerStep,
} from '../../core/schemas/index.ts';
import { sha256Hex } from '../lib/ledger.ts';
import { SESSION_FILES } from '../lib/session.ts';
import { GateRefusal } from './common.ts';

export interface GateLedger {
  dir: string;
  lines: string[];
  records: LedgerLine[];
}

/** ledger.jsonl of a gate recording, verified (chain and step order); refuses when missing or broken. */
export function readGateLedger(dir: string, lines: readonly string[] | null): GateLedger {
  if (lines === null) throw new GateRefusal(`${path.join(dir, SESSION_FILES.ledger)} does not exist: the recording has no step journal (spec 8.5)`);
  const v = verifyLedger(lines, (t) => sha256Hex(t), { kind: 'gate' });
  if (!v.ok) throw new GateRefusal(`ledger.jsonl is broken, nothing is run:\n  ${v.errors.join('\n  ')}`);
  return { dir, lines: [...lines], records: v.records };
}

/** True once the confirmatory stage B is in the journal. */
export function stageBDone(l: Pick<GateLedger, 'records'>): boolean {
  return findSteps(l.records, 'stage_b').length > 0;
}

/** Stage B runs so far, confirmatory and exploratory. */
export function stageBRuns(l: Pick<GateLedger, 'records'>): number {
  return l.records.filter((r) => !isNoteLine(r) && r.step === 'stage_b').length;
}

/** Stage A runs so far, confirmatory and exploratory. */
export function stageARuns(l: Pick<GateLedger, 'records'>): number {
  return l.records.filter((r) => !isNoteLine(r) && r.step === 'stage_a').length;
}

/**
 * Refuses unless `step` may be appended now. After the confirmatory stage B every run needs
 * --exploratory (spec 9.5); an exploratory run needs that stage B before it (spec 8.5).
 */
export function requireStep(l: GateLedger, step: LedgerStep, exploratory: boolean): void {
  if (!exploratory && stageBDone(l)) {
    throw new GateRefusal(`stage B has already run on this recording: any later analyze:gate run needs --exploratory, which marks every output (spec 9.5)`);
  }
  const why = canAppendStep(l.records, 'gate', step, { exploratory });
  if (why !== null) throw new GateRefusal(`cannot run ${step}: ${why}`);
}

export interface GateStepFields {
  utc: string;
  commit: string | null;
  exploratory: boolean;
}

/**
 * The journal lines of one run, each checked on a copy of the journal (chain, order, once-steps,
 * spec 8.5) before anything is written; a refusal when any of them may not be appended.
 */
export function prepareGateSteps(l: GateLedger, steps: readonly { step: LedgerStep; outSha256: Record<string, string> }[], f: GateStepFields): string[] {
  const lines = [...l.lines];
  const out: string[] = [];
  for (const s of steps) {
    let line: string;
    try {
      line = appendLedger(lines, s.step, { utc: f.utc, commit: f.commit, out_sha256: s.outSha256, exploratory: f.exploratory }, (t) => sha256Hex(t), { kind: 'gate' });
    } catch (e) {
      if (e instanceof LedgerError) throw new GateRefusal(`ledger.jsonl: ${e.problems.join('; ')}`);
      throw e;
    }
    lines.push(line);
    out.push(line);
  }
  return out;
}

/** Suffix of an output written before its journal line (writeGateRun). */
export const PARTIAL_SUFFIX = '.partial';

export interface GateOutput {
  /** Final path of the file. */
  file: string;
  text: string;
}

function readTextOrEmpty(file: string): string {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return '';
    throw e;
  }
}

/**
 * Writes one run (spec 8.5): the outputs as <file>.partial; then, if a fresh read shows the journal
 * as it was when the run began, all its lines in one append; then the outputs under their names.
 * A stop before the append leaves no step and no output; one after it is completed by
 * finishInterruptedRun on the next run.
 */
export function writeGateRun(l: GateLedger, lines: readonly string[], outputs: readonly GateOutput[]): void {
  for (const o of outputs) {
    fs.mkdirSync(path.dirname(o.file), { recursive: true });
    fs.writeFileSync(`${o.file}${PARTIAL_SUFFIX}`, o.text);
  }
  const file = path.join(l.dir, SESSION_FILES.ledger);
  const text = readTextOrEmpty(file);
  const now = splitJsonlLines(text).filter((x) => x.length > 0);
  if (now.length !== l.lines.length || now.some((x, i) => x !== l.lines[i])) {
    for (const o of outputs) fs.rmSync(`${o.file}${PARTIAL_SUFFIX}`, { force: true });
    throw new GateRefusal('ledger.jsonl changed while analyze:gate ran: nothing was written; run the command again (spec 8.5)');
  }
  const sep = text.length > 0 && !text.endsWith('\n') ? '\n' : '';
  fs.appendFileSync(file, `${sep}${lines.map((x) => `${x}\n`).join('')}`);
  for (const o of outputs) fs.renameSync(`${o.file}${PARTIAL_SUFFIX}`, o.file);
  l.lines.push(...lines);
  l.records = verifyLedger(l.lines, (t) => sha256Hex(t), { kind: 'gate' }).records;
}

/**
 * Completes a run that stopped between its journal lines and the renames of writeGateRun: when the
 * last step line is stage_a or verdict, each of its outputs whose <file>.partial has the hash the
 * line holds takes its name. `fileOf` maps a journal name to its path. Returns the files renamed.
 */
export function finishInterruptedRun(l: Pick<GateLedger, 'records'>, fileOf: (name: string) => string): string[] {
  let last: LedgerLine | undefined;
  for (const r of l.records) if (!isNoteLine(r)) last = r;
  if (last === undefined || isNoteLine(last) || (last.step !== 'stage_a' && last.step !== 'verdict')) return [];
  const done: string[] = [];
  for (const [name, sha] of Object.entries(last.out_sha256)) {
    const file = fileOf(name);
    const partial = `${file}${PARTIAL_SUFFIX}`;
    if (!fs.existsSync(partial)) continue;
    if (fs.existsSync(file) && sha256Hex(fs.readFileSync(file)) === sha) continue;
    if (sha256Hex(fs.readFileSync(partial)) !== sha) continue;
    fs.renameSync(partial, file);
    done.push(file);
  }
  return done;
}
