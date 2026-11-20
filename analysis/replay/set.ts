// A published gate set data/<id>/ as replay reads it (spec 8.7, 12.4). Replay reads ten of its
// files, each checked with its own validator from core/schemas: manifest.json (the public copy),
// stream.jsonl, marks.jsonl, g_resets.json, sniff_onsets.json, onsets.json, calib.json,
// clock_report.json, verdict.json, and verdict.md, which recompute.ts checks against the text
// stage B writes from verdict.json. It reads nothing else: stage B scores neither events.jsonl nor
// audio_env.json.
//
// Three things stage B reads come from files that are never published (spec 8.7): the cues and the
// step marks of its layout, from the "mark" lines of stamps.jsonl (analysis/gate/view.ts gateLayout
// and scoredCues); which packets with g null are reset frames of G, from lm of the "m" lines of
// samples.jsonl (analysis/rivals/g.ts gResetSeqs); and the sniff onsets of row 4, which it finds in
// audio.wav channel 0 after the sniff_<i> step marks (analysis/clocks/compute.ts recountSniffLag).
// stream.jsonl keeps only the "arr" stamps, as nArr, and events.jsonl holds no mark. So pack writes
// them into a gate set (analysis/pack.ts): MARKS_FILE, the mark lines as they are, RESETS_FILE, the
// packets gResetSeqs finds, and SNIFFS_FILE, the onsets recountSniffLag finds (with the verdict
// only). A set without them (from an earlier pack, or with a file taken out) still replays, and
// every value that needs them is then "not recomputable from the set". Like stream.jsonl, they are
// trusted as published: nothing else in the set ties them to the recording, beyond the checks here.
//
// A gate set without verdict.json is the set of a recording that never reached its verdict, for
// which pack writes no verdict files (PREREG sections 7 and 11): replay reads and checks its files
// and has no verdict to recompute (readSetFolder, VerdictlessSet).
//
// Replay reads the files of the set folder only: a file that leads out of it through a link is
// refused, and so is any path inside gate/ or sample/ (unreadPathWhy).

import fs from 'node:fs';
import path from 'node:path';
import { parseStream, type DetectorInput } from '../../core/detector.ts';
import {
  parseJson,
  parseJsonl,
  SESSION_ID,
  validateCalib,
  validateClockReport,
  validateGResets,
  validateMarkLine,
  validateSniffOnsets,
  inexactJsonlLines,
  inexactLineProblem,
  validateOnsets,
  validatePublishedManifest,
  validateStreamLine,
  validateVerdict,
  whyNoPublishedSet,
  type Calib,
  type ClockReport,
  type Manifest,
  type MarkLine,
  type Onsets,
  type Validator,
  type Verdict,
} from '../../core/schemas/index.ts';
import type { Stamp } from '../../core/clock/index.ts';
import { RATE } from '../gate/common.ts';
import { CUE_SEARCH_MS, gateCues } from '../label/gate-onsets.ts';
import { REPO_ROOT, dataDir } from '../lib/paths.ts';
import { gateSteps } from '../lib/steps.ts';
import { whyNotMeasured } from '../pack/rules.ts';
import { sniffOnsetsProblems } from './sniffs.ts';

/** The files of the set replay reads (spec 8.7). */
export const SET_FILES = {
  manifest: 'manifest.json',
  stream: 'stream.jsonl',
  onsets: 'onsets.json',
  calib: 'calib.json',
  clockReport: 'clock_report.json',
  verdict: 'verdict.json',
  verdictMd: 'verdict.md',
} as const;

/**
 * The "mark" lines of stamps.jsonl ({"k":"mark","what":"step"|"cue"|"key"}) as they are, in file
 * order (core/schemas validateMarkLine). Pack writes it into a gate set (analysis/pack.ts marksJsonl).
 */
export const MARKS_FILE = 'marks.jsonl';

/**
 * The packets of stream.jsonl that stage B read as reset frames of G: {"schema":"g-resets/1",
 * "seqs":[...]}, the seqs of rivals gResetSeqs(detector_in.jsonl, samples.jsonl) in ascending
 * order (core/schemas validateGResets). Pack writes it into a gate set (analysis/pack.ts gResetsJson).
 */
export const RESETS_FILE = 'g_resets.json';

/**
 * The sniff onsets of row 4: {"schema":"sniff-onsets/1","onsets":[...]}, n_sniff of each sniff
 * stage B heard in audio.wav channel 0, in prompt order (core/schemas validateSniffOnsets). Pack
 * writes it into a gate set with a verdict (analysis/pack.ts sniffOnsetsJson); replay recounts the
 * sniff lag from it (sniffs.ts sniffRecountFrom).
 */
export const SNIFFS_FILE = 'sniff_onsets.json';

/** A set replay cannot read or score: the message says what is wrong and what to do. */
export class ReplayRefusal extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ReplayRefusal';
  }
}

export interface PublishedSet {
  /** The folder as resolved. */
  dir: string;
  /** How the published set is named in tables and figures: data/<id>/ of its manifest. */
  name: string;
  id: string;
  pack: 'A' | 'B' | 'C';
  manifest: Manifest;
  /** stream.jsonl read back into detector inputs, and the nArr of each packet (core/detector parseStream). */
  inputs: DetectorInput[];
  nArrBySeq: Map<number, number>;
  onsets: Onsets;
  calib: Calib;
  clockReport: ClockReport;
  verdict: Verdict;
  /** The text of verdict.md. */
  verdictMd: string;
  /** The mark lines of MARKS_FILE; null when the set has no such file. */
  marks: MarkLine[] | null;
  /** The reset frames RESETS_FILE lists; null when the set has no such file. */
  resets: Set<number> | null;
  /** The sniff onsets SNIFFS_FILE lists; null when the set has no such file. */
  sniffOnsets: number[] | null;
}

/**
 * A gate set without verdict.json. Pack writes one for a recording that never reached its verdict,
 * because it does not count or stage B has not run on it (PREREG sections 7 and 11); pack A's set
 * of such a recording ends at the step mark of the objection block, without onsets.json (PREREG
 * section 7.5). Each file it holds is read and checked as in a set with a verdict; there is no
 * verdict to recompute.
 */
export interface VerdictlessSet {
  dir: string;
  name: string;
  id: string;
  pack: 'A' | 'B' | 'C';
  manifest: Manifest;
  verdict: null;
  onsets: Onsets | null;
  clockReport: ClockReport | null;
  /** The files of the set replay read and checked, in the order pack writes them. */
  read: string[];
}

/**
 * The folder of a command-line argument, as analysis/lib/paths.ts sessionDirOf reads one: a bare
 * id (gate-a) is <id>/ in the folder where pack writes the published sets (analysis/lib/paths.ts
 * dataDir: COPYHOLDER_DATA_DIR, else data/ under the repository root); anything else is a folder path.
 */
export function setFolderOf(arg: string, env: NodeJS.ProcessEnv = process.env): string {
  return SESSION_ID.test(arg) ? path.join(dataDir(env), arg) : path.resolve(arg);
}

/**
 * The real path of `p`; for a path that does not exist yet (an output file), the real path of its
 * nearest existing folder with the rest appended, so a link on the way is followed too.
 */
export function realPathOf(p: string): string {
  const abs = path.resolve(p);
  const rest: string[] = [];
  let at = abs;
  for (;;) {
    try {
      return path.join(fs.realpathSync(at), ...rest);
    } catch {
      const up = path.dirname(at);
      if (up === at) return abs;
      rest.unshift(path.basename(at));
      at = up;
    }
  }
}

function isInside(root: string, p: string): boolean {
  const rel = path.relative(root, p);
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

/**
 * Why replay must not read or write a path, or null. gate/ holds the day-1 packs, which nobody
 * opens before the recording (spec 9.2), and sample/ the sample passages with their texts, plan
 * and timings: replay reads published sets and params only, so it refuses both trees outright,
 * also when a link leads there. `what` names the path in the message.
 */
export function unreadPathWhy(p: string, what = p): string | null {
  const root = realPathOf(REPO_ROOT);
  const real = realPathOf(p);
  const rel = path.relative(root, real);
  if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) return null;
  const top = rel.split(path.sep)[0];
  if (top === 'gate') return `${what} lies inside gate/, whose pack files stay unopened before the day-1 recording (spec 9.2): name a published set, data/<id>/, and files outside gate/`;
  if (top === 'sample') return `${what} lies inside sample/, whose texts, plan and timings stay unopened: name a published set, data/<id>/, and files outside sample/`;
  return null;
}

/** Why replay must not read a set folder, or null (unreadPathWhy). */
export function unreadFolderWhy(dir: string): string | null {
  return unreadPathWhy(dir);
}

/** The first problems of a file, as one message. */
function problemList(problems: readonly string[], max = 6): string {
  const shown = problems.slice(0, max);
  const more = problems.length > max ? [`and ${problems.length - max} more`] : [];
  return [...shown, ...more].join('\n  ');
}

/**
 * A file of the set folder, or null when it is not there. Read only when its real path lies inside
 * the folder: a link that leads elsewhere (into gate/, sample/ or another set) is refused before
 * anything is opened.
 */
function readSetFile(dir: string, realDir: string, file: string): string | null {
  const p = path.join(dir, file);
  if (!fs.existsSync(p)) {
    let link = false;
    try {
      link = fs.lstatSync(p).isSymbolicLink();
    } catch {
      // Neither a file nor a link: missing.
    }
    if (!link) return null;
    throw new ReplayRefusal(`${p} is a link to nothing: copy the file itself into the set folder`);
  }
  const real = fs.realpathSync(p);
  if (!isInside(realDir, real)) {
    throw new ReplayRefusal(`${p} leads out of the set folder (to ${real}): replay reads only the files of the set itself; copy the file into the folder`);
  }
  if (!fs.statSync(real).isFile()) throw new ReplayRefusal(`${p} is not a file`);
  return fs.readFileSync(real, 'utf8');
}

/** The seqs of RESETS_FILE (core/schemas validateGResets), checked against stream.jsonl; a refusal says what is wrong. */
function resetsOf(text: string, where: string, inputs: readonly DetectorInput[]): Set<number> {
  const p = parseJson(text, validateGResets, { file: RESETS_FILE });
  if (p.value === null) throw new ReplayRefusal(`${where} is not valid (core/schemas):\n  ${problemList(p.errors)}`);
  const gNull = new Set(inputs.flatMap((r) => (r.k === 'batch' && r.g === null ? [r.seq] : [])));
  const other = p.value.seqs.find((seq) => !gNull.has(seq));
  if (other !== undefined) {
    throw new ReplayRefusal(
      `${where} lists seq ${other}, which is no packet of stream.jsonl with g null: live/reduce.cjs writes g null on every reset frame, so the file is not the one of this set; fetch the whole folder again`,
    );
  }
  return new Set(p.value.seqs);
}

/**
 * The lines of MARKS_FILE (core/schemas validateMarkLine), each as JSON.stringify writes it, as pack
 * copies them from stamps.jsonl (core/schemas inexactJsonlLines); a refusal says what is wrong.
 */
function marksOf(text: string, where: string): MarkLine[] {
  const m = parseJsonl(text, validateMarkLine, { file: MARKS_FILE });
  if (m.errors.length > 0) throw new ReplayRefusal(`${where} is not valid (core/schemas):\n  ${problemList(m.errors)}`);
  const inexact = inexactJsonlLines(text).map((line) => inexactLineProblem(MARKS_FILE, line));
  if (inexact.length > 0) throw new ReplayRefusal(`${where} is not as pack writes it:\n  ${problemList(inexact)}\n  Fetch the whole folder again`);
  return m.rows;
}

/** The onsets of SNIFFS_FILE (core/schemas validateSniffOnsets); a refusal says what is wrong. */
function sniffOnsetsOf(text: string, where: string): number[] {
  const p = parseJson(text, validateSniffOnsets, { file: SNIFFS_FILE });
  if (p.value === null) throw new ReplayRefusal(`${where} is not valid (core/schemas):\n  ${problemList(p.errors)}`);
  return p.value.onsets;
}

/**
 * Checks MARKS_FILE against onsets.json, the one published file that the cues place (spec 7.6):
 * the cues, as the onsets step found them in the marks (analysis/label/gate-onsets.ts gateCues),
 * carry rising numbers in time order, and each reply of onsets.json answers a cue that is there,
 * as the onsets step searched it: going at the cue or starting after it, its voice onset at most
 * 10 s after it. Problems in plain words; none for marks that fit.
 */
export function marksProblems(marks: readonly MarkLine[], onsets: Onsets, pack: 'A' | 'B' | 'C'): string[] {
  const out: string[] = [];
  const cues = gateCues({ stamps: marks as unknown as Stamp[] }, gateSteps(pack));
  if (cues.length === 0) out.push('it holds no cue: neither a cue mark ({"what":"cue","on":true}) nor a cue_<i>_on step mark');
  if (cues.some((c, idx) => idx > 0 && c.i <= cues[idx - 1]!.i)) out.push(`its cues in time order are numbered ${cues.map((x) => x.i).join(', ')}: the numbers do not rise`);
  const searchN = (CUE_SEARCH_MS * RATE) / 1000;
  for (const e of onsets.events) {
    if (typeof e.cue !== 'number') continue;
    const cue = cues.find((c) => c.i === e.cue);
    if (cue === undefined) {
      out.push(`${e.id} answers cue ${e.cue}, which has no cue mark`);
      continue;
    }
    if ((e.n_end ?? e.auto.n_v) < cue.n) out.push(`${e.id} ends at sample ${e.n_end ?? e.auto.n_v}, before the mark of cue ${e.cue} at ${cue.n}`);
    else if (e.auto.n_v > cue.n + searchN) out.push(`${e.id} begins at sample ${e.auto.n_v}, more than 10 s after the mark of cue ${e.cue} at ${cue.n}`);
  }
  return out;
}

/** What a gate set with a verdict holds: said when one of its files is missing. */
const WITH_VERDICT = 'every published gate set with a verdict holds it (spec 8.7); fetch the whole folder again';

/** The files a set without verdict.json may hold that replay reads, in the order pack writes them (analysis/pack.ts SET_ORDER). */
const VERDICTLESS_READ = [SET_FILES.manifest, SET_FILES.stream, MARKS_FILE, RESETS_FILE, SNIFFS_FILE, SET_FILES.onsets, SET_FILES.calib, SET_FILES.clockReport] as const;

/**
 * Reads one published gate set: a PublishedSet when it holds verdict.json, a VerdictlessSet when it
 * does not. A ReplayRefusal names the file and what is wrong with it.
 */
export function readSetFolder(dir: string): PublishedSet | VerdictlessSet {
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) {
    throw new ReplayRefusal(`${dir} is not a folder: name a published set, data/<id>/, or its id`);
  }
  const realDir = fs.realpathSync(dir);
  const where = (file: string): string => path.join(dir, file);
  const optional = (file: string): string | null => readSetFile(dir, realDir, file);
  const text = (file: string, missing = WITH_VERDICT): string => {
    const t = optional(file);
    if (t === null) throw new ReplayRefusal(`${where(file)} is missing: ${missing}`);
    return t;
  };
  const valid = <T>(file: string, t: string, validate: Validator<T>): T => {
    const p = parseJson(t, validate, { file });
    if (p.value === null) throw new ReplayRefusal(`${where(file)} is not valid (core/schemas):\n  ${problemList(p.errors)}`);
    return p.value;
  };
  const json = <T>(file: string, validate: Validator<T>, missing?: string): T => valid(file, text(file, missing), validate);
  const optionalJson = <T>(file: string, validate: Validator<T>): T | null => {
    const t = optional(file);
    return t === null ? null : valid(file, t, validate);
  };
  const streamOf = (t: string): ReturnType<typeof parseStream> => {
    const rows = parseJsonl(t, validateStreamLine, { file: SET_FILES.stream });
    if (rows.errors.length > 0) throw new ReplayRefusal(`${where(SET_FILES.stream)} is not valid (core/schemas):\n  ${problemList(rows.errors)}`);
    return parseStream(t);
  };

  const manifest = json(SET_FILES.manifest, validatePublishedManifest, 'every published set holds it (spec 8.7); fetch the whole folder again');
  if (manifest.kind !== 'gate') {
    throw new ReplayRefusal(`${where(SET_FILES.manifest)} names a ${manifest.kind} record: replay recomputes the verdict of a day-1 gate set (spec 9.6, 9.7)`);
  }
  const pack = manifest.pack;
  if (pack !== 'A' && pack !== 'B' && pack !== 'C') {
    throw new ReplayRefusal(whyNoPublishedSet('gate', pack ?? null) ?? `${where(SET_FILES.manifest)} names no gate pack A, B or C: only those have a verdict (spec 9.4)`);
  }
  // A real recording names the real tap and its SDK; a run no SDK measured is a rehearsal, which
  // stage B does not score and pack does not publish (spec 6.5, PREREG section 11).
  const notMeasured = whyNotMeasured(manifest as unknown as Record<string, unknown>);
  if (notMeasured !== null) {
    throw new ReplayRefusal(
      `${where(SET_FILES.manifest)} says ${notMeasured}: no SDK measured this run, so it is a rehearsal and no recording of pack ${pack}; stage B scores no such run and pack publishes none (spec 6.5, PREREG section 11). Name the set of a recording`,
    );
  }
  const name = `data/${manifest.id}/`;
  const verdict = optionalJson(SET_FILES.verdict, validateVerdict);

  if (verdict === null) {
    // The set of a recording that never reached its verdict: each file it holds is checked.
    if (optional(SET_FILES.verdictMd) !== null) {
      throw new ReplayRefusal(`${where(SET_FILES.verdictMd)} is here, but verdict.json is not: pack copies the two together (spec 8.7); fetch the whole folder again`);
    }
    const streamText = optional(SET_FILES.stream);
    const stream = streamText === null ? null : streamOf(streamText);
    const marksText = optional(MARKS_FILE);
    // Not checked against onsets.json: replay scores nothing with them here.
    if (marksText !== null) marksOf(marksText, where(MARKS_FILE));
    const resetsText = optional(RESETS_FILE);
    if (resetsText !== null) {
      if (stream === null) {
        throw new ReplayRefusal(`${where(RESETS_FILE)} names packets of stream.jsonl, which the set does not hold: pack writes the two together; fetch the whole folder again`);
      }
      resetsOf(resetsText, where(RESETS_FILE), stream.inputs);
    }
    // Not checked against marks.jsonl: replay recounts nothing with them here.
    const sniffsText = optional(SNIFFS_FILE);
    if (sniffsText !== null) sniffOnsetsOf(sniffsText, where(SNIFFS_FILE));
    const onsets = optionalJson(SET_FILES.onsets, validateOnsets);
    optionalJson(SET_FILES.calib, validateCalib);
    const clockReport = optionalJson(SET_FILES.clockReport, validateClockReport);
    const read = VERDICTLESS_READ.filter((f) => fs.existsSync(where(f)));
    return { dir, name, id: manifest.id, pack, manifest, verdict: null, onsets, clockReport, read };
  }

  if (verdict.id !== manifest.id || verdict.pack !== pack) {
    throw new ReplayRefusal(
      `${where(SET_FILES.verdict)} is the verdict of ${verdict.id} pack ${verdict.pack}, but manifest.json names ${manifest.id} pack ${pack}: the files come from different sets`,
    );
  }
  const verdictMd = text(SET_FILES.verdictMd, 'pack copies it with verdict.json, which is here (spec 8.7); fetch the whole folder again');

  const { inputs, nArrBySeq } = streamOf(text(SET_FILES.stream));
  if (!inputs.some((r) => r.k === 'batch')) {
    throw new ReplayRefusal(
      `${where(SET_FILES.stream)} holds no packet (no "batch" line), yet verdict.json holds a verdict stage B scored on the camera data: the file is cut short or not the one pack wrote; fetch the whole folder again`,
    );
  }
  const onsets = json(SET_FILES.onsets, validateOnsets, 'pack copies it with verdict.json, which is here (spec 8.7); fetch the whole folder again');

  let marks: MarkLine[] | null = null;
  const marksText = optional(MARKS_FILE);
  if (marksText !== null) {
    marks = marksOf(marksText, where(MARKS_FILE));
    const problems = marksProblems(marks, onsets, pack);
    if (problems.length > 0) {
      throw new ReplayRefusal(
        `${where(MARKS_FILE)} does not fit onsets.json, so its marks are not the ones of this recording:\n  ${problemList(problems)}\n  Fetch the set again, or take ${MARKS_FILE} out of the folder to replay it without the marks`,
      );
    }
  }
  const resetsText = optional(RESETS_FILE);
  let sniffOnsets: number[] | null = null;
  const sniffsText = optional(SNIFFS_FILE);
  if (sniffsText !== null) {
    sniffOnsets = sniffOnsetsOf(sniffsText, where(SNIFFS_FILE));
    const problems = marks === null ? [] : sniffOnsetsProblems(sniffOnsets, marks, gateSteps(pack).sniffs);
    if (problems.length > 0) {
      throw new ReplayRefusal(
        `${where(SNIFFS_FILE)} does not fit ${MARKS_FILE}, so its onsets are not the ones of this recording:\n  ${problemList(problems)}\n  Fetch the set again, or take ${SNIFFS_FILE} out of the folder to replay it without the sniff onsets`,
      );
    }
  }

  return {
    dir,
    name,
    id: manifest.id,
    pack,
    manifest,
    inputs,
    nArrBySeq,
    onsets,
    calib: json(SET_FILES.calib, validateCalib),
    clockReport: json(SET_FILES.clockReport, validateClockReport),
    verdict,
    verdictMd,
    marks,
    resets: resetsText === null ? null : resetsOf(resetsText, where(RESETS_FILE), inputs),
    sniffOnsets,
  };
}

/** Reads one published set with its verdict; a ReplayRefusal names the file and what is wrong with it. */
export function readPublishedSet(dir: string): PublishedSet {
  const set = readSetFolder(dir);
  if (set.verdict === null) {
    throw new ReplayRefusal(`${path.join(dir, SET_FILES.verdict)} is missing: the set holds no verdict to replay, as pack writes none for a recording that never reached its verdict (PREREG sections 7 and 11)`);
  }
  return set;
}
