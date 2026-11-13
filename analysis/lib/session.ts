// One recorded session folder in memory (spec 8.1): manifest.json, audio.wav, stamps.jsonl,
// samples.jsonl, detector_in.jsonl, events.jsonl, calib.json, ledger.jsonl. Every file is
// checked with core/schemas; lines that fail are skipped and listed in `problems`.

import fs from 'node:fs';
import path from 'node:path';
import {
  audioIndex,
  chunkLayout,
  recordedSpan,
  type ChunkLayout,
  type ChunkRun,
  type EventLine,
  type MicSettings,
  type SampleLine,
  type SessionData,
  type Stamp,
} from '../../core/clock/index.ts';
import {
  parseJson,
  parseJsonl,
  splitJsonlLines,
  validateCalib,
  validateDetectorInLine,
  validateEventLine,
  validateManifest,
  validateSampleLine,
  validateStampLine,
  type Calib,
  type DetectorInLine,
  type Manifest,
  type RecordKind,
  type Validator,
} from '../../core/schemas/index.ts';
import { sessionDirOf, sessionsDir } from './paths.ts';
import { readStereoFloatWav, type WavInfo } from './wav.ts';

export const SESSION_FILES = {
  manifest: 'manifest.json',
  audio: 'audio.wav',
  stamps: 'stamps.jsonl',
  samples: 'samples.jsonl',
  detectorIn: 'detector_in.jsonl',
  events: 'events.jsonl',
  calib: 'calib.json',
  ledger: 'ledger.jsonl',
  quickcheck: 'quickcheck.json',
} as const;

/** A session folder in memory. It is a core/clock SessionData, so clock functions take it as is. */
export interface LoadedSession extends SessionData {
  id: string;
  dir: string;
  manifest: Manifest;
  kind: RecordKind;
  wav: WavInfo;
  ch0: Float32Array;
  ch1: Float32Array;
  stamps: Stamp[];
  samples: SampleLine[];
  events: EventLine[];
  detectorIn: DetectorInLine[];
  /** calib.json of this folder; null when absent or broken (see problems). */
  calib: Calib | null;
  /** ledger.jsonl lines without terminators; null when the file does not exist. */
  ledgerLines: string[] | null;
  /** Readable problems found while reading; the lines they name were skipped. */
  problems: string[];
  /** Optional files that are not in the folder. */
  missing: string[];
  /** Layout of audio.wav from the chunk stamps (core/clock). */
  layout: ChunkLayout;
}

export class SessionLoadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SessionLoadError';
  }
}

export interface LoadOptions {
  env?: NodeJS.ProcessEnv;
  /** Read detector_in.jsonl (default true). quickcheck does not need it. */
  detectorIn?: boolean;
  /** Problems listed per file before a summary line (default 20). */
  maxProblemsPerFile?: number;
}

function readText(file: string): string | null {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw e;
  }
}

/**
 * Valid rows of a JSONL file. A last line without its newline that is not JSON is the tail of a
 * write cut short by a crash: it is skipped like any bad line, and named as such.
 */
function readJsonl<T>(
  dir: string,
  file: string,
  validate: Validator<T>,
  out: { problems: string[]; missing: string[] },
  maxProblems: number,
): T[] {
  const text = readText(path.join(dir, file));
  if (text === null) {
    out.missing.push(file);
    return [];
  }
  const parsed = parseJsonl(text, validate, { file, maxErrors: maxProblems });
  if (parsed.errors.length > 0) {
    const cutTail = text.length > 0 && !text.endsWith('\n');
    out.problems.push(...parsed.errors.map((e) => (cutTail && e.includes('not valid JSON') && e.includes(`line ${splitJsonlLines(text).length}:`) ? `${e} (last line cut short)` : e)));
  }
  return parsed.rows;
}

/** Microphone settings for core/clock from the hello settings host stored in manifest.json. */
export function micSettingsOf(manifest: Manifest): MicSettings | null {
  const s = manifest.audio.settings;
  return s && typeof s === 'object' ? ({ ...s } as MicSettings) : null;
}

/**
 * Reads sessions/<id>/ (or a folder path). Throws SessionLoadError when the folder, manifest.json
 * or audio.wav is missing or unreadable, or the manifest is invalid; other files are optional.
 */
export function loadSession(idOrDir: string, opts: LoadOptions = {}): LoadedSession {
  const dir = sessionDirOf(idOrDir, opts.env);
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) throw new SessionLoadError(`No session folder ${dir}`);
  const max = opts.maxProblemsPerFile ?? 20;

  const manifestText = readText(path.join(dir, SESSION_FILES.manifest));
  if (manifestText === null) throw new SessionLoadError(`${dir} has no ${SESSION_FILES.manifest}`);
  const m = parseJson(manifestText, validateManifest, { file: SESSION_FILES.manifest, maxErrors: max });
  if (m.value === null) throw new SessionLoadError(`${SESSION_FILES.manifest} of ${dir} is not valid:\n  ${m.errors.join('\n  ')}`);
  const manifest = m.value;

  const audioFile = path.join(dir, SESSION_FILES.audio);
  if (!fs.existsSync(audioFile)) throw new SessionLoadError(`${dir} has no ${SESSION_FILES.audio}`);
  let audio;
  try {
    audio = readStereoFloatWav(audioFile);
  } catch (e) {
    throw new SessionLoadError(`${SESSION_FILES.audio} of ${dir} cannot be read: ${(e as Error).message}`);
  }

  const acc = { problems: [] as string[], missing: [] as string[] };
  if (audio.info.headerNote !== null) acc.problems.push(`${SESSION_FILES.audio}: ${audio.info.headerNote}; length taken from the file size`);
  const stamps = readJsonl(dir, SESSION_FILES.stamps, validateStampLine, acc, max) as Stamp[];
  const samples = readJsonl(dir, SESSION_FILES.samples, validateSampleLine, acc, max) as unknown as SampleLine[];
  const events = readJsonl(dir, SESSION_FILES.events, validateEventLine, acc, max) as EventLine[];
  const detectorIn = opts.detectorIn === false ? [] : readJsonl(dir, SESSION_FILES.detectorIn, validateDetectorInLine, acc, max);

  let calib: Calib | null = null;
  const calibText = readText(path.join(dir, SESSION_FILES.calib));
  if (calibText !== null) {
    const c = parseJson(calibText, validateCalib, { file: SESSION_FILES.calib, maxErrors: max });
    calib = c.value;
    acc.problems.push(...c.errors);
  }
  const ledgerText = readText(path.join(dir, SESSION_FILES.ledger));

  return {
    id: manifest.id,
    dir,
    manifest,
    kind: manifest.kind,
    wav: audio.info,
    sampleRateHz: audio.info.sampleRateHz,
    ch0: audio.ch0,
    ch1: audio.ch1,
    stamps,
    samples,
    events,
    detectorIn,
    micSettings: micSettingsOf(manifest),
    calib,
    ledgerLines: ledgerText === null ? null : splitJsonlLines(ledgerText).filter((l) => l.length > 0),
    problems: acc.problems,
    missing: acc.missing,
    layout: chunkLayout(stamps, audio.ch0.length),
  };
}

// ---- stamps -----------------------------------------------------------------------

/** Stamps of one kind (chunk, click, mark, arr, hold, state, voice, resume, ignored), in file order. */
export function stampsOfKind(session: Pick<SessionData, 'stamps'>, k: string): Stamp[] {
  return session.stamps.filter((s) => s.k === k);
}

export interface StepMark {
  name: string;
  n: number;
}

/** Step marks {k:'mark', what:'step', name} in file order: one per step Deck entered. */
export function stepMarks(session: Pick<SessionData, 'stamps'>): StepMark[] {
  const out: StepMark[] = [];
  for (const s of session.stamps) {
    if (s.k === 'mark' && s.what === 'step' && typeof s.name === 'string') out.push({ name: s.name, n: s.n });
  }
  return out;
}

/** Sample number where a step started (its first mark), or null when Deck never entered it. */
export function stepStart(session: Pick<SessionData, 'stamps'>, name: string): number | null {
  return stepMarks(session).find((m) => m.name === name)?.n ?? null;
}

/** First and one-past-last recorded sample numbers; null without chunk stamps. */
export function recordedRange(session: Pick<LoadedSession, 'layout'>): { n0: number; n1: number } | null {
  return recordedSpan(session.layout);
}

/**
 * Sample span of a step: from its mark to the next step mark, or to the end of the recording
 * for the last step. Null when the step was never entered.
 */
export function stepSpan(session: Pick<LoadedSession, 'stamps' | 'layout'>, name: string): { n0: number; n1: number } | null {
  const marks = stepMarks(session);
  const i = marks.findIndex((m) => m.name === name);
  if (i < 0) return null;
  const n0 = marks[i]!.n;
  const next = marks.slice(i + 1).find((m) => m.n >= n0);
  const end = next?.n ?? recordedRange(session)?.n1 ?? n0;
  return { n0, n1: Math.max(n0, end) };
}

/** Step starts by name (first mark of each name). */
export function stepStarts(session: Pick<SessionData, 'stamps'>): Map<string, number> {
  const out = new Map<string, number>();
  for (const m of stepMarks(session)) if (!out.has(m.name)) out.set(m.name, m.n);
  return out;
}

// ---- audio by sample number ------------------------------------------------------------

/** A stretch of one channel addressed by sample number: signal[i] is sample n0 + i. */
export interface AudioView {
  signal: Float32Array;
  n0: number;
  n1: number;
}

function runOf(layout: ChunkLayout, n: number): ChunkRun | null {
  for (const r of layout.runs) if (n >= r.n0 && n < r.n1) return r;
  return null;
}

/**
 * Channel `ch` over [n0, n1), cut to the recorded run that holds n0 (audio after a gap is not
 * joined on). Null when n0 was not recorded or the range is empty.
 */
export function audioView(session: Pick<LoadedSession, 'layout' | 'ch0' | 'ch1'>, ch: 0 | 1, n0: number, n1: number): AudioView | null {
  const a = Math.round(n0);
  const run = runOf(session.layout, a);
  if (!run) return null;
  const b = Math.min(Math.round(n1), run.n1);
  if (b <= a) return null;
  const idx = audioIndex(session.layout, a, b - a);
  if (idx === null) return null;
  const src = ch === 0 ? session.ch0 : session.ch1;
  return { signal: src.subarray(idx, idx + (b - a)), n0: a, n1: b };
}

/** The whole recorded run around sample n of channel `ch`; for finders that take absolute sample numbers. */
export function runView(session: Pick<LoadedSession, 'layout' | 'ch0' | 'ch1'>, ch: 0 | 1, n: number): AudioView | null {
  const run = runOf(session.layout, Math.round(n));
  if (!run) return null;
  const src = ch === 0 ? session.ch0 : session.ch1;
  return { signal: src.subarray(run.index0, run.index0 + (run.n1 - run.n0)), n0: run.n0, n1: run.n1 };
}

// ---- finding sessions --------------------------------------------------------------------

export interface LatestOptions {
  env?: NodeJS.ProcessEnv;
  /** Only manifests with this scenario (e.g. 'doctor' for a full doctor run, not 'doctor-level'). */
  scenario?: string;
  /** Leave this id out (the folder being analysed). */
  exceptId?: string;
  /** Only folders whose files pass this test. */
  accept?: (dir: string, manifest: Manifest) => boolean;
}

/**
 * Newest session folder of a record kind (manifest `kind`: doctor, gate, smoke, ...): the latest
 * started_utc, then the highest folder number (doctor-<n>). Null when there is none.
 */
export function latestSession(kind: RecordKind, opts: LatestOptions = {}): string | null {
  const root = sessionsDir(opts.env);
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return null;
  }
  let best: { id: string; t: number; num: number } | null = null;
  for (const d of entries) {
    if (!d.isDirectory() || d.name === opts.exceptId) continue;
    const dir = path.join(root, d.name);
    const text = readText(path.join(dir, SESSION_FILES.manifest));
    if (text === null) continue;
    const m = parseJson(text, validateManifest);
    if (m.value === null || m.value.kind !== kind) continue;
    if (opts.scenario !== undefined && m.value['scenario'] !== opts.scenario) continue;
    if (opts.accept && !opts.accept(dir, m.value)) continue;
    const num = Number(/-(\d+)$/.exec(d.name)?.[1] ?? -1);
    const cand = { id: d.name, t: Date.parse(m.value.started_utc), num };
    const later = best === null || cand.t > best.t || (cand.t === best.t && cand.num > best.num);
    if (later) best = cand;
  }
  return best?.id ?? null;
}
