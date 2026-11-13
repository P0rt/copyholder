// Published set data/<id>/ (spec 8.7, 12.4): stream.jsonl and its converter from
// detector_in.jsonl, audio_env.json, sentence_ends.json, planted_times.json, the public
// manifest.json, and the lists of what may be published or committed (spec 13.4 "Чистота").

import {
  arrayOf, bool, byKind, fail, int, isPlainObject, lit, makeValidator, nullable, num, obj, oneOf, str,
  type Spec, type Validator,
} from './check.ts';
import {
  GATE_PACKS, NARRATOR_STATES, RECORD_KINDS, sampleN, type GatePack, type RecordKind, type TimedFlag, type TimedValue,
} from './common.ts';
import { parseJson, parseJsonl, splitTruncatedTail, toJsonlText, type JsonlRows } from './jsonl.ts';
import {
  LANDMARK_FIELDS, talkPairs, tracePairs, validateDetectorInLine, validateEventLine, validateManifest,
  validateStampLine, type DetState, type DetVoice, type DetectorInLine, type Manifest, type StampLine,
} from './session.ts';
import { validateCalib, validateClockReport, validateOnsets, validateVerdict } from './reports.ts';
import { validateReceipt } from './receipt.ts';
import { validateSealedPlan, validateTexts } from './plan.ts';

// ---- stream.jsonl ----------------------------------------------------------------

/** A detector_in "batch" line with the arrival sample nArr of its packet (null: no arr stamp). */
export interface StreamBatch {
  k: 'batch';
  seq: number;
  nArr: number | null;
  tr: TimedValue[];
  talk: TimedFlag[];
  g: number | null;
  hm: number | null;
}

/** A detector_in "val" line; nArr only when stamps.jsonl has an arr stamp for its seq. */
export interface StreamVal {
  k: 'val';
  seq: number;
  nArr?: number;
  code: number;
}

export type StreamLine = StreamBatch | StreamVal | DetVoice | DetState;

/** Every field a stream.jsonl line may hold. Nothing else, so no face landmark can get in. */
export const STREAM_FIELDS: Readonly<Record<StreamLine['k'], readonly string[]>> = {
  batch: ['k', 'seq', 'nArr', 'tr', 'talk', 'g', 'hm'],
  val: ['k', 'seq', 'nArr', 'code'],
  voice: ['k', 'n', 'on'],
  state: ['k', 'n', 's'],
};

const seqN: Spec = int({ min: 0, what: 'an SDK callback number (non-negative integer)' });
const numOrNull: Spec = nullable(num());

const streamSpecs: Record<StreamLine['k'], Spec> = {
  batch: obj({
    required: { k: lit('batch'), seq: seqN, nArr: nullable(sampleN), tr: tracePairs, talk: talkPairs, g: numOrNull, hm: numOrNull },
    forbidden: LANDMARK_FIELDS,
  }),
  val: obj({ required: { k: lit('val'), seq: seqN, code: int({ min: 0 }) }, optional: { nArr: sampleN }, forbidden: LANDMARK_FIELDS }),
  voice: obj({ required: { k: lit('voice'), n: sampleN, on: bool }, forbidden: LANDMARK_FIELDS }),
  state: obj({ required: { k: lit('state'), n: sampleN, s: oneOf(NARRATOR_STATES) }, forbidden: LANDMARK_FIELDS }),
};

export const validateStreamLine: Validator<StreamLine> = makeValidator(byKind('k', streamSpecs, 'stream kind'));

/** Paths of keys that would carry face landmark coordinates (lm, p, landmarks, points), at any depth. */
export function findFaceLandmarkFields(value: unknown, path = ''): string[] {
  const found: string[] = [];
  if (Array.isArray(value)) {
    value.forEach((x, i) => found.push(...findFaceLandmarkFields(x, `${path}[${i}]`)));
  } else if (isPlainObject(value)) {
    for (const [k, x] of Object.entries(value)) {
      const here = path === '' ? k : `${path}.${k}`;
      if (Object.hasOwn(LANDMARK_FIELDS, k)) found.push(here);
      found.push(...findFaceLandmarkFields(x, here));
    }
  }
  return found;
}

export interface StreamBuild {
  lines: StreamLine[];
  /** seq of batch lines at the end of the file whose packet has no arr stamp (Deck had stopped). */
  batchesWithoutArr: number[];
  errors: string[];
}

/**
 * stream.jsonl = detector_in.jsonl in the same order, with nArr from the `arr` stamps of
 * stamps.jsonl (spec 8.7). Each line is rebuilt from an allow-list of fields, so whatever
 * else an input object holds (face landmarks included) never reaches the output.
 */
export function detectorInToStream(detectorIn: readonly DetectorInLine[], stamps: readonly StampLine[]): StreamBuild {
  const errors: string[] = [];
  const nArrBySeq = new Map<number, number>();
  for (const s of stamps) {
    if (s.k !== 'arr') continue;
    if (nArrBySeq.has(s.seq)) errors.push(`stamps.jsonl: packet seq ${s.seq} has more than one arr stamp`);
    else nArrBySeq.set(s.seq, s.n);
  }
  const lines: StreamLine[] = [];
  const missing: { seq: number; index: number }[] = [];
  let lastBatchWithArr = -1;
  let lastNArr = -1;
  detectorIn.forEach((d, index) => {
    switch (d.k) {
      case 'batch': {
        const nArr = nArrBySeq.get(d.seq) ?? null;
        if (nArr === null) missing.push({ seq: d.seq, index });
        else lastBatchWithArr = index;
        lines.push({
          k: 'batch',
          seq: d.seq,
          nArr,
          tr: d.tr.map(([t, v]): TimedValue => [t, v]),
          talk: d.talk.map(([t, f]): TimedFlag => [t, f]),
          g: d.g,
          hm: d.hm,
        });
        if (nArr !== null) {
          if (nArr < lastNArr) errors.push(`detector_in.jsonl line ${index + 1}: nArr ${nArr} of seq ${d.seq} is before the previous packet's ${lastNArr}`);
          lastNArr = nArr;
        }
        break;
      }
      case 'val': {
        const nArr = nArrBySeq.get(d.seq);
        lines.push(nArr === undefined ? { k: 'val', seq: d.seq, code: d.code } : { k: 'val', seq: d.seq, nArr, code: d.code });
        break;
      }
      case 'voice':
        lines.push({ k: 'voice', n: d.n, on: d.on });
        break;
      case 'state':
        lines.push({ k: 'state', n: d.n, s: d.s });
        break;
      default:
        errors.push(`detector_in.jsonl line ${index + 1}: unknown kind ${JSON.stringify((d as { k?: unknown }).k)}`);
    }
  });
  for (const m of missing) {
    if (m.index < lastBatchWithArr) {
      errors.push(`detector_in.jsonl line ${m.index + 1}: packet seq ${m.seq} has no arr stamp in stamps.jsonl, but later packets do`);
    }
  }
  lines.forEach((l, i) => {
    for (const p of validateStreamLine(l)) errors.push(`stream.jsonl line ${i + 1}: ${p}`);
  });
  return { lines, batchesWithoutArr: missing.filter((m) => m.index > lastBatchWithArr).map((m) => m.seq), errors };
}

/** The detector input of a stream line: the same line without nArr (replay feeds this to step()). */
export function streamToDetectorIn(line: StreamLine): DetectorInLine {
  switch (line.k) {
    case 'batch':
      return { k: 'batch', seq: line.seq, tr: line.tr, talk: line.talk, g: line.g, hm: line.hm };
    case 'val':
      return { k: 'val', seq: line.seq, code: line.code };
    default:
      return line;
  }
}

export interface StreamText {
  /** stream.jsonl text, or null when an input file or the conversion has a problem. */
  text: string | null;
  errors: string[];
  /** Partial last lines dropped from an input that a crash or power loss cut short; pack records them. */
  warnings: string[];
  batchesWithoutArr: number[];
}

/** Drops a last line that a crash cut short and says so; any other bad line stays an error. */
function withoutPartialLastLine(text: string, file: string, warnings: string[]): string {
  const cut = splitTruncatedTail(text);
  if (cut.tail !== null) {
    warnings.push(`${file} line ${String(cut.tailLine)}: partial last line dropped (no newline, not valid JSON: the recording was cut off)`);
  }
  return cut.complete;
}

/**
 * Builds stream.jsonl from the texts of detector_in.jsonl and stamps.jsonl (for pack). An
 * interrupted session is published too (spec 8.7, 10.6), so a last line cut short by a crash
 * is dropped with a warning; a bad line anywhere else refuses the build.
 */
export function buildStreamJsonl(detectorInText: string, stampsText: string): StreamText {
  const warnings: string[] = [];
  const detText = withoutPartialLastLine(detectorInText, 'detector_in.jsonl', warnings);
  const stText = withoutPartialLastLine(stampsText, 'stamps.jsonl', warnings);
  const det: JsonlRows<DetectorInLine> = parseJsonl(detText, validateDetectorInLine, { file: 'detector_in.jsonl' });
  const st: JsonlRows<StampLine> = parseJsonl(stText, validateStampLine, { file: 'stamps.jsonl' });
  const inputErrors = [...det.errors, ...st.errors];
  if (inputErrors.length > 0) return { text: null, errors: inputErrors, warnings, batchesWithoutArr: [] };
  const built = detectorInToStream(det.rows, st.rows);
  if (built.errors.length > 0) return { text: null, errors: built.errors, warnings, batchesWithoutArr: built.batchesWithoutArr };
  return { text: toJsonlText(built.lines, 'stream.jsonl'), errors: [], warnings, batchesWithoutArr: built.batchesWithoutArr };
}

// ---- audio_env.json, sentence_ends.json, planted_times.json -------------------------

/** Loudness of both channels every 10 ms; not audio (spec 8.7). */
export interface AudioEnv {
  schema: 'audio-env/1';
  step_ms: 10;
  mic_db: number[];
  narrator_db: number[];
}

const db: Spec = num({ round1: true, what: 'a level in dB (finite; clamp silence, e.g. -90.0)' });

export const validateAudioEnv: Validator<AudioEnv> = makeValidator(
  obj({
    required: { schema: lit('audio-env/1'), step_ms: lit(10), mic_db: arrayOf(db), narrator_db: arrayOf(db) },
    check: (o, p, out) => {
      const a = (o['mic_db'] as number[]).length;
      const b = (o['narrator_db'] as number[]).length;
      if (a !== b) fail(out, p, `mic_db has ${a} values, narrator_db ${b}: both cover the same steps`);
    },
  }),
);

/** Sample at which each narrator sentence ended; no text, no word times (spec 8.7). Layout is an assumption. */
export interface SentenceEnds {
  schema: 'sentence-ends/1';
  ends: { passage_id: string; sentence_index: number; n: number }[];
}

const passageId: Spec = str({ pattern: /^(opening|p[1-9])$/, what: '"opening" or "p1".."p9"' });

export const validateSentenceEnds: Validator<SentenceEnds> = makeValidator(
  obj({
    required: {
      schema: lit('sentence-ends/1'),
      ends: arrayOf(obj({ required: { passage_id: passageId, sentence_index: int({ min: 0 }), n: sampleN } })),
    },
    forbidden: { text: 'no text in the published set (spec 8.7)', words: 'no word times in the published set (spec 8.7)' },
  }),
);

/** Planted error number and its start and end samples as it sounded; no text (spec 8.7). Layout is an assumption. */
export interface PlantedTimes {
  schema: 'planted-times/1';
  errors: { error_id: string; n_start: number | null; n_end: number | null; interrupted: boolean }[];
}

export const validatePlantedTimes: Validator<PlantedTimes> = makeValidator(
  obj({
    required: {
      schema: lit('planted-times/1'),
      errors: arrayOf(
        obj({
          required: { error_id: str(), n_start: nullable(sampleN), n_end: nullable(sampleN), interrupted: bool },
          forbidden: {
            original_sentence: 'no text in the published set (spec 8.7)',
            planted_sentence: 'no text in the published set (spec 8.7)',
            replacement: 'no text in the published set (spec 8.7)',
            original_span: 'no text in the published set (spec 8.7)',
          },
          check: (e, p, out) => {
            const a = e['n_start'];
            const b = e['n_end'];
            if (typeof a === 'number' && typeof b === 'number' && b < a) fail(out, p, 'n_end lies before n_start');
          },
        }),
      ),
    },
  }),
);

// ---- public manifest.json ------------------------------------------------------------

const LOCAL_PATH = /^(\/|~\/|[A-Za-z]:[\\/])|\/Users\/|\/home\/|\\Users\\/;

/** Paths of strings (keys or values) that look like local file system paths. */
export function findLocalPaths(value: unknown, path = ''): string[] {
  const found: string[] = [];
  if (typeof value === 'string') {
    if (LOCAL_PATH.test(value)) found.push(path === '' ? '(value)' : path);
  } else if (Array.isArray(value)) {
    value.forEach((x, i) => found.push(...findLocalPaths(x, `${path}[${i}]`)));
  } else if (isPlainObject(value)) {
    for (const [k, x] of Object.entries(value)) {
      const here = path === '' ? k : `${path}.${k}`;
      if (LOCAL_PATH.test(k)) found.push(here);
      found.push(...findLocalPaths(x, here));
    }
  }
  return found;
}

/** The public copy: no `paths`, no local path anywhere (spec 8.7). */
export const validatePublishedManifest: Validator<Manifest> = (value: unknown): string[] => {
  const problems = validateManifest(value);
  if (isPlainObject(value)) {
    if (Object.hasOwn(value, 'paths')) problems.push('paths: not allowed in the published manifest (spec 8.7: local paths removed)');
    for (const p of findLocalPaths(value)) {
      if (p !== 'paths' && !p.startsWith('paths.')) problems.push(`${p}: looks like a local path (spec 8.7)`);
    }
  }
  return problems;
};

/** Device identifiers dropped from the public copy of the microphone settings (assumption). */
export const PRIVATE_TRACK_SETTINGS = ['deviceId', 'groupId'] as const;

/** Applies `pack --alias "<name>=<replacement>"` pairs to every string inside a value; keys stay. */
function aliasStrings(value: unknown, aliases: readonly (readonly [string, string])[]): unknown {
  if (typeof value === 'string') return aliases.reduce((acc, [from, to]) => acc.split(from).join(to), value);
  if (Array.isArray(value)) return value.map((x) => aliasStrings(x, aliases));
  if (isPlainObject(value)) {
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(value)) {
      Object.defineProperty(out, k, { value: aliasStrings(x, aliases), enumerable: true, writable: true, configurable: true });
    }
    return out;
  }
  return value;
}

function withoutPrivateSettings(settings: unknown): unknown {
  if (!isPlainObject(settings)) return settings;
  const out: Record<string, unknown> = { ...settings };
  for (const k of PRIVATE_TRACK_SETTINGS) delete out[k];
  return out;
}

/** Top-level manifest fields that identify the record or hash something: never aliased. */
const UNALIASED_FIELDS = ['schema', 'id', 'kind', 'started_utc', 'app_commit', 'plan_commitment'] as const;

/**
 * Public manifest for data/<id>/ (spec 8.7): drops `paths` and the microphone's device
 * identifiers, and applies the `pack --alias "<name>=<replacement>"` pairs to every string
 * (the camera and microphone names can carry a person's name). Ids, commits, the seal and the
 * file hashes are kept as they are.
 * Check the result with validatePublishedManifest: other local paths are reported there.
 */
export function toPublishedManifest(m: Manifest, aliases: Readonly<Record<string, string>> = {}): Manifest {
  const pairs = Object.entries(aliases).filter(([from]) => from !== '');
  const { paths: _paths, files, ...rest } = m;
  const audio: Record<string, unknown> = { ...m.audio };
  for (const key of ['settings', 'track_settings']) {
    if (audio[key] !== undefined) audio[key] = withoutPrivateSettings(audio[key]);
  }
  const aliased = aliasStrings({ ...rest, audio }, pairs) as Record<string, unknown>;
  for (const k of UNALIASED_FIELDS) {
    if (Object.hasOwn(m, k)) aliased[k] = m[k];
  }
  return { ...aliased, files: { ...files } } as Manifest;
}

/** A device or machine name in a manifest, with where it sits. */
export interface DeviceName {
  path: string;
  value: string;
}

/**
 * The names pack prints and waits to have confirmed before it writes data/<id>/ (spec 8.7):
 * camera, microphone and output device as the system shows them, the track label and the
 * machine. Any of them can hold a person's name; `pack --alias` replaces it.
 */
export function listDeviceNames(m: Manifest): DeviceName[] {
  const out: DeviceName[] = [];
  const add = (path: string, v: unknown): void => {
    if (typeof v === 'string' && v !== '') out.push({ path, value: v });
  };
  add('camera.name', m.camera?.name);
  add('audio.microphone', m.audio.microphone);
  add('audio.output', m.audio.output);
  const settings = m.audio.settings;
  if (isPlainObject(settings)) add('audio.settings.label', settings['label']);
  add('machine', m.machine);
  return out;
}

// ---- what may be published and committed ----------------------------------------------

/** Files of data/<id>/ (spec 8.7). Not every record has every file. */
export const PUBLISHED_FILES = [
  'manifest.json', 'stream.jsonl', 'events.jsonl', 'onsets.json', 'calib.json', 'clock_report.json',
  'receipt.json', 'receipt.txt', 'verdict.md', 'verdict.json', 'sentence_ends.json', 'planted_times.json',
  'audio_env.json', 'plan.json',
] as const;

/** Published only with a switch, one session at a time (spec 8.7). */
export const OPT_IN_FILES: Readonly<Record<string, string>> = {
  'audio.wav': '--with-audio',
  'clips/': '--with-clips',
  'texts.json': '--with-texts',
};

/** Never published (spec 8.1, 8.7, 12.3). */
export const NEVER_PUBLISHED = [
  'sdk_raw.jsonl.gz', 'samples.jsonl', 'stamps.jsonl', 'detector_in.jsonl', 'quickcheck.json', 'review.json',
  'ledger.jsonl', 'timings.json',
] as const;

/** Never in the git tree or history (spec 13.4 "Чистота", 13.6). */
export const NEVER_IN_GIT = ['.env', 'settings.env', 'sdk_raw.jsonl.gz', 'samples.jsonl'] as const;

/** Raw SDK data and samples stay out of git in any form: sdk_raw.jsonl, samples.jsonl.gz and so on (spec 13.4). */
export const NEVER_IN_GIT_PREFIXES = ['sdk_raw.jsonl', 'samples.jsonl'] as const;

/** Video files: never in git (spec 13.4). */
export const VIDEO_EXTENSIONS = ['.mp4', '.mov', '.m4v', '.webm', '.mkv', '.avi'] as const;

function baseName(path: string): string {
  const parts = path.split(/[\\/]/);
  return parts[parts.length - 1] ?? path;
}

/**
 * Why a repository path must not be in git, or null when it may. Names compare without case
 * (the Mac's file system ignores it). Example files (.env.example, settings.env.example) are fine.
 */
export function whyNotInGit(path: string): string | null {
  const name = baseName(path);
  const lower = name.toLowerCase();
  if ((NEVER_IN_GIT as readonly string[]).includes(lower)) return `${name} never goes into git (spec 13.4, 13.6)`;
  const prefix = NEVER_IN_GIT_PREFIXES.find((p) => lower === p || lower.startsWith(`${p}.`));
  if (prefix !== undefined) return `${name}: ${prefix} never goes into git, in any form (spec 13.4, 13.6)`;
  const video = VIDEO_EXTENSIONS.find((ext) => lower.endsWith(ext));
  if (video !== undefined) return `video files (${video}) never go into git (spec 13.4)`;
  return null;
}

/**
 * Record kinds whose records get a published set: the day-1 gate, every started numbers
 * session (cancelled and interrupted ones too), the space-bar block and every demo take.
 * Development records get none: doctor, smoke, the probe before the gate (pack 0), pilot,
 * rehearsal (spec 8.7), and the development runs headstart, live_from and live_sim (assumption).
 */
export const PUBLISHED_KINDS: readonly RecordKind[] = ['gate', 'numbers', 'spacebar', 'demo'];

/** Files only the set of the day-1 gate has (spec 8.7). */
export const GATE_ONLY_FILES = ['verdict.md', 'verdict.json'] as const;

/** Why a record gets no published set, or null when it gets one (spec 8.7). */
export function whyNoPublishedSet(kind: RecordKind, pack?: GatePack | null): string | null {
  if (kind === 'gate' && pack === '0') {
    return 'the probe before the gate (pack 0) is a development record and gets no published set (spec 8.7, 9.4)';
  }
  if (!PUBLISHED_KINDS.includes(kind)) {
    return `a ${kind} record is a development record and gets no published set: only ${PUBLISHED_KINDS.join(', ')} records do (spec 8.7)`;
  }
  return null;
}

/** What pack was told for one data/<id>/ folder. */
export interface PublishOptions {
  /** --with-audio, --with-clips, --with-texts (spec 8.7). */
  audio?: boolean;
  clips?: boolean;
  texts?: boolean;
  /** Kind of the record (its manifest.json); with it the per-kind rules of spec 8.7 apply. */
  kind?: RecordKind;
  /** Pack of a gate record (its manifest.json); pack "0" is the probe. */
  pack?: GatePack | null;
}

/**
 * Problems with the file names of one data/<id>/ folder (relative names, "clips/x.wav" for
 * clips). With `kind`, also whether the record gets a set at all and whether it may carry
 * verdict.md and verdict.json (only the day-1 gate, spec 8.7).
 */
export function checkPublishedNames(names: readonly string[], opts: PublishOptions = {}): string[] {
  const problems: string[] = [];
  if (opts.kind !== undefined) {
    const noSet = whyNoPublishedSet(opts.kind, opts.pack);
    if (noSet !== null) problems.push(noSet);
  }
  for (const name of names) {
    if ((GATE_ONLY_FILES as readonly string[]).includes(name) && opts.kind !== undefined && opts.kind !== 'gate') {
      problems.push(`${name}: only the set of the day-1 gate has it, this record is "${opts.kind}" (spec 8.7)`);
      continue;
    }
    if ((PUBLISHED_FILES as readonly string[]).includes(name)) continue;
    if (name === 'audio.wav' && opts.audio === true) continue;
    if (name.startsWith('clips/') && opts.clips === true) continue;
    if (name === 'texts.json' && opts.texts === true) continue;
    const base = baseName(name);
    if ((NEVER_PUBLISHED as readonly string[]).includes(base)) problems.push(`${name}: never published (spec 8.7)`);
    else if (name === 'audio.wav' || name.startsWith('clips/') || name === 'texts.json') {
      const flag = name.startsWith('clips/') ? OPT_IN_FILES['clips/'] : OPT_IN_FILES[name];
      problems.push(`${name}: published only with ${String(flag)} (spec 8.7)`);
    } else problems.push(`${name}: not part of data/<id>/ (spec 8.7)`);
  }
  return problems;
}

const PUBLISHED_VALIDATORS: Readonly<Record<string, { jsonl: boolean; validate: Validator<unknown> }>> = {
  'manifest.json': { jsonl: false, validate: validatePublishedManifest },
  'stream.jsonl': { jsonl: true, validate: validateStreamLine },
  'events.jsonl': { jsonl: true, validate: validateEventLine },
  'onsets.json': { jsonl: false, validate: validateOnsets },
  'calib.json': { jsonl: false, validate: validateCalib },
  'clock_report.json': { jsonl: false, validate: validateClockReport },
  'receipt.json': { jsonl: false, validate: validateReceipt },
  'verdict.json': { jsonl: false, validate: validateVerdict },
  'sentence_ends.json': { jsonl: false, validate: validateSentenceEnds },
  'planted_times.json': { jsonl: false, validate: validatePlantedTimes },
  'audio_env.json': { jsonl: false, validate: validateAudioEnv },
  'plan.json': { jsonl: false, validate: validateSealedPlan },
  'texts.json': { jsonl: false, validate: validateTexts },
};

/** Kind and gate pack named by a manifest.json text; undefined where it does not parse or name one. */
function manifestKindAndPack(text: string | null | undefined): { kind?: RecordKind; pack?: GatePack | null } {
  if (typeof text !== 'string') return {};
  let m: unknown;
  try {
    m = JSON.parse(text);
  } catch {
    return {};
  }
  if (!isPlainObject(m)) return {};
  const kind = m['kind'];
  const pack = m['pack'];
  return {
    ...(typeof kind === 'string' && (RECORD_KINDS as readonly string[]).includes(kind) ? { kind: kind as RecordKind } : {}),
    ...(pack === null || (typeof pack === 'string' && (GATE_PACKS as readonly string[]).includes(pack)) ? { pack: pack as GatePack | null } : {}),
  };
}

/**
 * Checks one data/<id>/ folder: file names, the schema of each text file, and no face
 * landmark field anywhere. `files` maps relative names to text; null for binary files.
 * Every set carries the public manifest.json; the kind and pack it names decide whether the
 * record gets a set and whether verdict.md and verdict.json belong to it (spec 8.7).
 */
export function validatePublishedFolder(
  files: Readonly<Record<string, string | null>>,
  optIn: { audio?: boolean; clips?: boolean; texts?: boolean } = {},
): string[] {
  const manifest = Object.hasOwn(files, 'manifest.json') ? files['manifest.json'] : undefined;
  const problems = Object.hasOwn(files, 'manifest.json') ? [] : ['manifest.json: missing: every published set carries the public manifest (spec 8.7)'];
  problems.push(...checkPublishedNames(Object.keys(files), { ...optIn, ...manifestKindAndPack(manifest) }));
  for (const [name, text] of Object.entries(files)) {
    const v = PUBLISHED_VALIDATORS[name];
    if (v === undefined || text === null) continue;
    if (v.jsonl) {
      const parsed = parseJsonl(text, v.validate, { file: name });
      problems.push(...parsed.errors);
      parsed.rows.forEach((row, i) => {
        for (const f of findFaceLandmarkFields(row)) problems.push(`${name} line ${parsed.lineNumbers[i] ?? i + 1}: ${f}: face landmark field (spec 8.7)`);
      });
    } else {
      const parsed = parseJson(text, v.validate, { file: name });
      problems.push(...parsed.errors);
      if (parsed.value !== null) for (const f of findFaceLandmarkFields(parsed.value)) problems.push(`${name}: ${f}: face landmark field (spec 8.7)`);
    }
  }
  return problems;
}
