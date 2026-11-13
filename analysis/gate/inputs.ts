// What analyze:gate reads must be whole (spec 8.1, 8.5, 9.4): the recording files it scores from,
// and the files earlier steps wrote, which must still have the hashes the step journal holds.
// Stage A checks the lines before the cut only: it reads nothing after 4:15 (spec 9.5 step 4).

import fs from 'node:fs';
import path from 'node:path';
import { hardFailures } from '../../core/clock/index.ts';
import type { DetectorInput } from '../../core/detector.ts';
import {
  isNoteLine,
  parseJson,
  quickcheckLine,
  validateClockReport,
  validateQuickcheck,
  type ClockReport,
  type LedgerLine,
  type LedgerNoteLine,
  type Onsets,
  type Quickcheck,
  type Validator,
} from '../../core/schemas/index.ts';
import { onsetsLabelsSha256 } from '../label/marks.ts';
import { sha256Hex } from '../lib/ledger.ts';
import { SESSION_FILES, stepStart, type LoadedSession } from '../lib/session.ts';
import { gateSteps } from '../lib/steps.ts';
import { GateRefusal, RATE } from './common.ts';
import { detectorInPrefixLength, gatePackOfSession, maxSeqOf } from './view.ts';

/** Files the label step writes (spec 8.5): the onsets and the clock report with its onset block. */
export const ONSETS_FILE = 'onsets.json';
export const CLOCK_REPORT_FILE = 'clock_report.json';
/** The file the quickcheck step writes (spec 7.12, 8.1). */
export const QUICKCHECK_FILE = SESSION_FILES.quickcheck;
/** Ledger note of the label step with the seed, the order and labels_sha256 (analysis/label.ts ORDER_NOTE). */
export const LABEL_ORDER_NOTE = 'label_order';

/** Recording files the gate scores from (spec 8.1): each must be present, every line valid. */
export const GATE_INPUT_FILES: readonly string[] = [SESSION_FILES.stamps, SESSION_FILES.detectorIn, SESSION_FILES.samples, SESSION_FILES.calib];

/** A stamp line is written within 1 s of its sample number (assumption): the slack of the cut in stamps.jsonl. */
export const STAMP_ORDER_SLACK_SAMPLES = RATE;

const WHY = 'a lost or broken input is a technical failure, not a reading of the gate (spec 8.1, 9.4)';

function isMissing(s: Pick<LoadedSession, 'dir' | 'missing'>, file: string): boolean {
  return file === SESSION_FILES.calib ? !fs.existsSync(path.join(s.dir, file)) : s.missing.includes(file);
}

/** Problems the session loader listed for `file` ("<file> line N: ..." or "<file>: ..."), in file order. */
export function problemsOfFile(problems: readonly string[], file: string): string[] {
  return problems.filter((p) => p.startsWith(`${file} line `) || p.startsWith(`${file}: `));
}

/**
 * Problems of `file` that may lie before its valid row `endRow` (-1: there is no such row, so all
 * count). The valid rows before the first bad line B are lines 1 to B - 1, so row endRow comes
 * before every bad line exactly when endRow < B - 1.
 */
export function problemsBeforeRow(problems: readonly string[], file: string, endRow: number): string[] {
  const own = problemsOfFile(problems, file);
  if (own.length === 0) return [];
  const prefix = `${file} line `;
  const first = own[0]!.startsWith(prefix) ? Number.parseInt(own[0]!.slice(prefix.length), 10) : 1;
  return endRow >= 0 && Number.isFinite(first) && endRow < first - 1 ? [] : own;
}

/** Stage B: every input file present and every line of it valid. */
export function requireInputsWhole(s: Pick<LoadedSession, 'dir' | 'missing' | 'problems'>): void {
  const out: string[] = [];
  for (const f of GATE_INPUT_FILES) {
    if (isMissing(s, f)) out.push(`${f} is missing`);
    else out.push(...problemsOfFile(s.problems, f));
  }
  if (out.length > 0) throw new GateRefusal(`stage B reads every line of ${GATE_INPUT_FILES.join(', ')}; ${WHY}:\n  ${out.join('\n  ')}`);
}

/**
 * Stage A: every input file present, calib.json valid, and no broken line where a line before the
 * cut could be: in stamps.jsonl before the first stamp 1 s past the cut, in detector_in.jsonl
 * before the first line known to lie after it, in samples.jsonl before the first seq that arrived
 * after it. Lines after those are not read.
 */
export function requireInputsBeforeCut(s: LoadedSession, nCut: number, nArrBefore: ReadonlyMap<number, number>): void {
  const out: string[] = [];
  for (const f of GATE_INPUT_FILES) if (isMissing(s, f)) out.push(`${f} is missing`);
  out.push(...problemsOfFile(s.problems, SESSION_FILES.calib));
  out.push(...problemsBeforeRow(s.problems, SESSION_FILES.stamps, s.stamps.findIndex((x) => x.n >= nCut + STAMP_ORDER_SLACK_SAMPLES)));
  const inputs = s.detectorIn as unknown as DetectorInput[];
  const keep = detectorInPrefixLength(inputs, nArrBefore, nCut);
  out.push(...problemsBeforeRow(s.problems, SESSION_FILES.detectorIn, keep < inputs.length ? keep : -1));
  const maxSeq = maxSeqOf(nArrBefore);
  out.push(...problemsBeforeRow(s.problems, SESSION_FILES.samples, s.samples.findIndex((l) => typeof l.seq === 'number' && l.seq > maxSeq)));
  if (out.length > 0) throw new GateRefusal(`stage A reads every line before the objection block; ${WHY}:\n  ${out.join('\n  ')}`);
}

/** Runs `f`; a refusal from it also names the broken lines of stamps.jsonl, which may be the reason. */
export function withStampProblems<T>(s: Pick<LoadedSession, 'problems'>, f: () => T): T {
  try {
    return f();
  } catch (e) {
    const own = problemsOfFile(s.problems, SESSION_FILES.stamps);
    if (e instanceof GateRefusal && own.length > 0) throw new GateRefusal(`${e.message}; stamps.jsonl has broken lines:\n  ${own.join('\n  ')}`);
    throw e;
  }
}

/** The hash the last step line of the journal holds for `file`, with that step; null when none lists it. */
export function recordedHash(records: readonly LedgerLine[], file: string): { step: string; sha256: string } | null {
  for (let i = records.length - 1; i >= 0; i--) {
    const r = records[i]!;
    if (isNoteLine(r)) continue;
    const sha = r.out_sha256[file];
    if (sha !== undefined) return { step: r.step, sha256: sha };
  }
  return null;
}

/**
 * Files earlier steps wrote must still have the hash the journal holds for them (spec 8.5):
 * calib.json from clocks, onsets.json and clock_report.json from label.
 */
export function requireRecordedHashes(records: readonly LedgerLine[], dir: string, files: readonly string[]): void {
  const out: string[] = [];
  for (const f of files) {
    const want = recordedHash(records, f);
    let bytes: Buffer | null = null;
    try {
      bytes = fs.readFileSync(path.join(dir, f));
    } catch {
      bytes = null;
    }
    if (want === null) {
      out.push(`${f}: no step line of ledger.jsonl holds its hash`);
    } else if (bytes === null) {
      out.push(`${f} is missing (step ${want.step} wrote it with hash ${want.sha256.slice(0, 8)})`);
    } else {
      const sha = sha256Hex(bytes);
      if (sha !== want.sha256) out.push(`${f} changed after step ${want.step} wrote it (ledger ${want.sha256.slice(0, 8)}, file ${sha.slice(0, 8)})`);
    }
  }
  if (out.length > 0) throw new GateRefusal(`a file of an earlier step does not match ledger.jsonl, so nothing is scored (spec 8.5):\n  ${out.join('\n  ')}`);
}

/** A JSON file of the session folder, valid by its schema; a refusal otherwise. */
export function readValidJson<T>(dir: string, file: string, validate: Validator<T>): T {
  let text: string;
  try {
    text = fs.readFileSync(path.join(dir, file), 'utf8');
  } catch {
    throw new GateRefusal(`${file} is missing; ${WHY}`);
  }
  const parsed = parseJson(text, validate, { file });
  if (parsed.value === null) throw new GateRefusal(`${file} is not valid:\n  ${parsed.errors.join('\n  ')}`);
  return parsed.value;
}

/**
 * Why the recording does not count (spec 9.4, 6.3, PREREG §4 and §7.4): quickcheck said
 * RE-RECORD NOW, or the clock check found the audio or the trace not valid. Empty when it counts.
 */
export function recordingVoidReasons(q: Pick<Quickcheck, 'result' | 'reasons'>, report: ClockReport): string[] {
  const out: string[] = [];
  if (q.result !== 'GOOD RECORDING') out.push(`${QUICKCHECK_FILE} says ${quickcheckLine(q)}`);
  const audio = hardFailures(report, { camera: false });
  if (!report.audio_valid) out.push(`${CLOCK_REPORT_FILE} says the audio is not valid${audio.length > 0 ? `: ${audio.join('; ')}` : ''}`);
  if (report.trace_valid !== true) {
    const trace =
      report.trace_valid === null
        ? ['it has no trace verdict, as for a recording without the camera']
        : hardFailures(report, { camera: true }).filter((f) => !audio.includes(f));
    out.push(`${CLOCK_REPORT_FILE} says the trace is not valid${trace.length > 0 ? `: ${trace.join('; ')}` : ''}`);
  }
  return out;
}

/** What the refusal of a recording that does not count needs to know about it (spec 9.4). */
export interface RecordingAt {
  dir: string;
  pack: 'A' | 'B' | 'C';
  /** The objection block began: its step mark (4:15) is in stamps.jsonl, so its errors were heard. */
  objectionsReached: boolean;
}

/** The pack and how far a gate recording ran, from manifest.json and the step marks (spec 9.3, 9.4). */
export function recordingAt(s: Pick<LoadedSession, 'dir' | 'kind' | 'manifest' | 'stamps'>): RecordingAt {
  const pack = gatePackOfSession(s);
  return { dir: s.dir, pack, objectionsReached: stepStart(s, gateSteps(pack).objections) !== null };
}

/** Packs after `pack` in the order of spec 9.4 (B, then C). */
const LATER_PACKS: Readonly<Record<RecordingAt['pack'], string>> = { A: 'B, then C', B: 'C', C: '' };

/**
 * What to record next after a recording that does not count (spec 9.4, PREREG §7.4). A failure is
 * technical unless the only one is quickcheck condition 6 (fewer than 12 replies) with the clock
 * check passed. A technical failure: remove the cause, repeat pack 0 until GOOD RECORDING, then the
 * same pack if the recording broke off before the objection block (4:15), else the next unused
 * one; with no detector computed yet it does not spend the one content re-record. A failure on
 * condition 6 alone: the next unused pack is the one content re-record.
 */
export function nextRecordingAdvice(a: { technical: boolean; pack: RecordingAt['pack']; objectionsReached: boolean; detectorComputed: boolean }): string {
  const later = LATER_PACKS[a.pack];
  const none = 'no unused pack is left, so the gate does not take place this weekend (spec 9.4, 14.3)';
  if (!a.technical) {
    return `quickcheck marks the failure as not technical (fewer than 12 replies, spec 9.4): ${
      later === '' ? none : `record the next unused pack (${later}), which is the one re-record for content (spec 9.6)`
    }.`;
  }
  if (a.objectionsReached && later === '') return `The failure is technical, but the objection block (from 4:15) was heard, so pack ${a.pack} cannot be recorded again: ${none}.`;
  const then = a.objectionsReached
    ? `record the next unused pack (${later}): the objection block (from 4:15) was heard, so pack ${a.pack} cannot be recorded again`
    : `record pack ${a.pack} again: the recording broke off before the objection block (4:15), so its errors were not heard`;
  const cost = a.detectorComputed
    ? 'Stage A already computed detectors on this recording, so it spends the one re-record for content (spec 9.4).'
    : 'A technical failure with no detector computed does not spend the one re-record for content (spec 9.4).';
  return `The failure is technical. Remove the cause, repeat pack 0 until it says GOOD RECORDING, then ${then} (spec 9.4). ${cost}`;
}

/**
 * Stage A and stage B score only a recording that counts (spec 9.4, 9.5, 8.5): quickcheck.json,
 * as the quickcheck step wrote it, says GOOD RECORDING, and clock_report.json, as label left it,
 * finds the audio and the trace valid. Otherwise the run is refused, with what to record next,
 * unless it is exploratory: then the reasons come back, to be printed as marked notes. Both files
 * must still have the hashes ledger.jsonl holds for them, exploratory or not. Stage A reads only
 * these verdicts of the whole recording and the step mark of the objection block, nothing of the
 * block itself (spec 9.5 step 4).
 */
export function requireCountedRecording(records: readonly LedgerLine[], at: RecordingAt, exploratory: boolean): string[] {
  requireRecordedHashes(records, at.dir, [QUICKCHECK_FILE, CLOCK_REPORT_FILE]);
  const q = readValidJson(at.dir, QUICKCHECK_FILE, validateQuickcheck);
  const report = readValidJson(at.dir, CLOCK_REPORT_FILE, validateClockReport);
  const reasons = recordingVoidReasons(q, report);
  if (reasons.length > 0 && !exploratory) {
    // quickcheck's technical flag is false only when condition 6 is its one failure (analysis/quickcheck.ts).
    const contentOnly = q.result !== 'GOOD RECORDING' && q.technical === false && report.audio_valid && report.trace_valid === true;
    const next = nextRecordingAdvice({
      technical: !contentOnly,
      pack: at.pack,
      objectionsReached: at.objectionsReached,
      detectorComputed: records.some((r) => !isNoteLine(r) && r.step === 'stage_a'),
    });
    throw new GateRefusal(['this recording does not count, so analyze:gate does not score it (spec 9.4, 9.6):', ...reasons.map((r) => `  ${r}`), next].join('\n'));
  }
  return reasons;
}

/** labels_sha256 in the detail of a label_order note ("seed S; order ...; labels_sha256 H"); null without one. */
export function labelsHashOfNote(note: Pick<LedgerNoteLine, 'detail'>): string | null {
  const m = /(?:^|;\s*)labels_sha256 ([0-9a-f]{64})(?:;|$)/.exec(note.detail ?? '');
  return m ? m[1]! : null;
}

/** The last label_order note before the last label step line; null when there is none. */
export function labelOrderNote(records: readonly LedgerLine[]): LedgerNoteLine | null {
  let labelAt = -1;
  records.forEach((r, i) => {
    if (!isNoteLine(r) && r.step === 'label') labelAt = i;
  });
  for (let i = labelAt - 1; i >= 0; i--) {
    const r = records[i]!;
    if (isNoteLine(r) && r.what === LABEL_ORDER_NOTE) return r;
  }
  return null;
}

/**
 * The blind labels stage B uses are the ones whose hash the label step put in the ledger (spec 9.5
 * step 3, 8.5): onsets.json carries labels_sha256, the hash its own labels and hand marks give
 * (analysis/label/marks.ts), and the same hash stands in the ledger note label_order. Only when
 * onsets.json holds label_order itself (a schema that takes it) may the note be absent.
 */
export function requireLabelsHash(onsets: Onsets, records: readonly LedgerLine[]): void {
  const fileHash = onsets.labels_sha256;
  if (fileHash === null) {
    throw new GateRefusal(`${ONSETS_FILE} has no labels_sha256: the blind labels of the label step are missing (spec 9.5 step 3); run npm run label -- <id>`);
  }
  const own = onsetsLabelsSha256(onsets, sha256Hex);
  if (own !== fileHash) {
    throw new GateRefusal(
      `${ONSETS_FILE}: its blind labels and hand marks give labels_sha256 ${own === null ? 'none' : own.slice(0, 8)}, not the ${fileHash.slice(0, 8)} it holds: they are not the labels the label step hashed (spec 8.5)`,
    );
  }
  const note = labelOrderNote(records);
  if (note === null) {
    if (Object.hasOwn(onsets, 'label_order')) return;
    throw new GateRefusal(`ledger.jsonl has no ${LABEL_ORDER_NOTE} note before the label step, so the labels hash of ${ONSETS_FILE} cannot be checked against the ledger (spec 8.5, 9.5 step 3)`);
  }
  const noted = labelsHashOfNote(note);
  if (noted === null) throw new GateRefusal(`the ${LABEL_ORDER_NOTE} note on ledger.jsonl line ${note.i + 1} holds no labels_sha256 (spec 8.5)`);
  if (noted !== fileHash) {
    throw new GateRefusal(
      `${ONSETS_FILE} labels_sha256 ${fileHash.slice(0, 8)} differs from the ${LABEL_ORDER_NOTE} note on ledger.jsonl line ${note.i + 1} (${noted.slice(0, 8)}): these are not the labels whose hash the label step put in the ledger (spec 8.5, 9.5 step 3)`,
    );
  }
}
