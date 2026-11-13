// JSON and JSONL reading and writing with stable key order (spec 8.1).
// Values are written with JSON.stringify and never rounded: a written number reads back
// to the same number, so replay matches live mode (spec 8.1, first precision rule).

import { isPlainObject, type Validator } from './check.ts';

/** JSONL files with a fixed key order taken from the spec examples. */
export type JsonlFile =
  | 'stamps.jsonl'
  | 'samples.jsonl'
  | 'detector_in.jsonl'
  | 'stream.jsonl'
  | 'events.jsonl'
  | 'ledger.jsonl'
  | 'sdk_raw.jsonl';

/** JSON files whose spec example fixes a key order. */
export type OrderedJsonFile =
  | 'manifest.json'
  | 'calib.json'
  | 'clock_report.json'
  | 'onsets.json'
  | 'params/frozen.json'
  | 'freeze_manifest.json'
  | 'audio_env.json';

export type OrderedFile = JsonlFile | OrderedJsonFile;

const DETECTOR_ORDER = ['k', 'seq', 'nArr', 'n', 'tr', 'talk', 'g', 'hm', 'code', 'on', 's'] as const;

/**
 * Key order per file, read off the spec examples. One rank list per file, applied at
 * every nesting level. Keys not listed follow the listed ones in insertion order.
 */
export const KEY_ORDERS: Readonly<Record<OrderedFile, readonly string[]>> = {
  'stamps.jsonl': ['n', 'k', 'frames', 'i', 'what', 'name', 'on', 'cause', 'seq', 'nSilent', 'word', 's'],
  'samples.jsonl': [
    'seq', 'k', 'tArrNs', 'tsCbUs', 'tr', 'talk', 'g', 'hm', 'lm', 'ts', 'reset', 'p',
    'code', 'name', 'hint', 'sent', 'message', 'retryable', 'p50Ms', 'p99Ms', 'maxMs', 'n',
  ],
  'detector_in.jsonl': DETECTOR_ORDER,
  'stream.jsonl': DETECTOR_ORDER,
  'events.jsonl': [
    'n', 'e', 'by', 'det', 'cause', 'seq', 'nCmd', 'nSilent', 'word', 'why', 'v', 'theta', 'on',
    'state', 'w', 'h', 'value', 'db', 'final', 'status', 'expected', 'got', 'missing', 'silent_ms',
    'code', 'signal', 'name', 'message', 'page_loads', 'hard', 'reason', 'detail', 'checks',
  ],
  'ledger.jsonl': ['i', 'step', 'utc', 'commit', 'what', 'detail', 'out_sha256', 'exploratory', 'prev'],
  'sdk_raw.jsonl': ['seq', 'kind', 'tArrNs', 'tWallMs', 'tsCbUs', 'b64', 'args'],
  'manifest.json': [
    'schema', 'id', 'kind', 'started_utc', 'app_commit', 'tree_clean', 'plan_commitment',
    'sdk', 'version', 'metrics', 'launcher', 'machine', 'camera', 'name', 'requested',
    'audio', 'microphone', 'output', 'sample_rate', 'mic_flags_off', 'output_gain', 'settings',
    // host's own fields (live/lib/manifest.cjs), then the file hashes last as in the spec example
    'mode', 'scenario', 'pack', 'plan', 'source', 'tap', 'browser', 'state', 'consent_utc', 'ended_utc', 'end',
    'unusable', 'unusable_reasons', 'page_loads', 'narrator',
    'files', 'paths',
  ],
  'calib.json': [
    'schema', 'L_rt_ms', 'A', 'B', 'spread', 'rule', 'used', 'polarity', 'sign', 'breaths_agree', 'A_ref',
    'camera_clock', 'offset_ms', 'slope_ppm', 'ok', 'sniff_lag_ms', 'n', 'no_arrival', 'lo_median', 'hi_median',
    'median_over_ms', 'leak_db_over_floor', 'output_gain',
  ],
  'clock_report.json': [
    'schema', 'audio_valid', 'trace_valid',
    'chain', 'L_rt_ms', 'spread_ms', 'quantum_ms', 'stops', 'stops_match_ch1', 'nCmd_minus_nArr',
    'onset', 'p90_abs_auto_minus_manual_ms', 'events', 'soft_first_sounds',
    'hard', 'chunks_contiguous', 'sample_rate', 'mic_flags_off', 'device_events', 'visibility_events',
    'trace_rate_median', 'sdk_errors', 'tap_lost',
    'warn', 'not_sent_share', 'tap_loop_p99_ms', 'status_ok_share', 'window_warnings',
  ],
  'onsets.json': [
    'schema', 'labels_sha256', 'events', 'id', 'kind', 'label', 'voiced_ms', 'floor_db', 'cue', 'n_end',
    'auto', 'n_v', 'n_a', 'breath', 'flags', 'manual', 'blind',
  ],
  'params/frozen.json': [
    'schema', 'd1', 'grid_hz', 'L', 'M', 'k', 'theta_clamp', 'min_rise_A', 'min_rise_ms', 'arm_breaths',
    'refractory_ms', 'rearm_ms', 'hold', 'H_ms', 'ramp_frames', 'audio_pause_ms',
    'g', 'theta_G', 'frames', 'baseline_s',
    'vad', 'highpass_hz', 'hop_ms', 'over_floor_db', 'periodicity', 'on_ms', 'off_ms',
    'tuned', 'step', 'criterion_met', 'rehearsal_step_up',
  ],
  'freeze_manifest.json': [
    'schema', 'tag', 'prereg_sha256', 'params_sha256', 'scoring_rules_sha256', 'prompts_sha256',
    'planter', 'model', 'digest', 'ollama_version',
    'plans', 'id', 'role', 'plan_commitment', 'draft_sha256', 'audio_sha256', 'state',
  ],
  'audio_env.json': ['schema', 'step_ms', 'mic_db', 'narrator_db'],
};

const SAMPLE_KINDS = new Set(['m', 'v', 's', 'f', 'e', 'l']);
const DETECTOR_KINDS = new Set(['batch', 'val']);

/**
 * Guesses the file of a JSONL line from its discriminator. `voice` and `state` lines
 * exist in both stamps.jsonl and detector_in.jsonl with the same fields: they are taken
 * as stamps lines, so detector_in and stream writers must name their file.
 */
export function guessJsonlFile(line: Record<string, unknown>): JsonlFile | null {
  if ('step' in line && 'prev' in line) return 'ledger.jsonl';
  if ('e' in line) return 'events.jsonl';
  if ('kind' in line && 'tArrNs' in line) return 'sdk_raw.jsonl';
  const k = line['k'];
  if (typeof k !== 'string') return null;
  if (SAMPLE_KINDS.has(k) && ('tArrNs' in line || k === 'l')) return 'samples.jsonl';
  if (DETECTOR_KINDS.has(k)) return 'nArr' in line ? 'stream.jsonl' : 'detector_in.jsonl';
  return 'stamps.jsonl';
}

function where(path: string): string {
  return path === '' ? 'value' : path;
}

function orderValue(value: unknown, rank: ReadonlyMap<string, number> | null, path: string): unknown {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new Error(`${where(path)} is ${value}: JSON would write null (spec 8.1)`);
    }
    return value;
  }
  if (typeof value === 'bigint') {
    throw new Error(`${where(path)} is a bigint: write it as a decimal string, like tArrNs (spec 8.1)`);
  }
  if (Array.isArray(value)) {
    return value.map((x, i) => {
      if (x === undefined) throw new Error(`${path}[${i}] is undefined: JSON would write null`);
      return orderValue(x, rank, `${path}[${i}]`);
    });
  }
  if (isPlainObject(value)) {
    const keys = Object.keys(value).filter((k) => value[k] !== undefined);
    if (rank !== null) {
      const r = (k: string): number => rank.get(k) ?? Number.MAX_SAFE_INTEGER;
      keys.sort((a, b) => r(a) - r(b)); // stable: unknown keys keep insertion order
    }
    const out: Record<string, unknown> = {};
    for (const k of keys) {
      const child = path === '' ? k : `${path}.${k}`;
      Object.defineProperty(out, k, {
        value: orderValue(value[k], rank, child),
        enumerable: true,
        writable: true,
        configurable: true,
      });
    }
    return out;
  }
  const kind = typeof value === 'object' ? (value.constructor?.name ?? 'object') : typeof value;
  throw new Error(`${where(path)} is a ${kind}: only plain objects, arrays, strings, finite numbers, booleans and null can be written`);
}

const rankCache = new Map<string, ReadonlyMap<string, number>>();

function rankFor(file: OrderedFile | null): ReadonlyMap<string, number> | null {
  if (file === null) return null;
  let rank = rankCache.get(file);
  if (rank === undefined) {
    rank = new Map(KEY_ORDERS[file].map((k, i) => [k, i]));
    rankCache.set(file, rank);
  }
  return rank;
}

/**
 * Deep copy with keys in the file's order (spec examples). Throws on values JSON cannot
 * hold exactly: NaN, Infinity, bigint, undefined list items, class instances.
 * Properties set to undefined are dropped, as JSON.stringify does.
 */
export function orderKeys<T>(value: T, file?: OrderedFile | null): T {
  return orderValue(value, rankFor(file ?? null), '') as T;
}

/**
 * One JSONL line, without the newline. The key order follows the file's spec example;
 * without `file` it is guessed from the line (see guessJsonlFile).
 */
export function toJsonlLine(value: object, file?: JsonlFile): string {
  if (!isPlainObject(value)) throw new Error('toJsonlLine: expected a plain object');
  const f = file ?? guessJsonlFile(value);
  return JSON.stringify(orderKeys(value, f));
}

/** Whole JSONL text: one line per row, each ending with a newline. */
export function toJsonlText(rows: readonly object[], file?: JsonlFile): string {
  return rows.map((r) => `${toJsonlLine(r, file)}\n`).join('');
}

/** A JSON file's text with a trailing newline. Keys follow the file's order when one is known. */
export function toJsonText(value: object, file?: OrderedJsonFile | null, indent = 0): string {
  return `${JSON.stringify(orderKeys(value, file ?? null), null, indent > 0 ? indent : undefined)}\n`;
}

/**
 * Splits JSONL text into lines without terminators. A final newline does not make an
 * extra empty line; "\r\n" endings and a leading byte order mark are tolerated.
 */
export function splitJsonlLines(text: string): string[] {
  if (text === '') return [];
  const body = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const parts = body.split('\n');
  if (parts[parts.length - 1] === '') parts.pop();
  return parts.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

/** A JSONL text split into its complete lines and a last line that a crash cut short. */
export interface JsonlTail {
  /** The text up to and including its last newline, or the whole text when nothing was cut. */
  complete: string;
  /** The partial last line (no newline after it, not valid JSON), or null. */
  tail: string | null;
  /** 1-based line number of the partial line, or null. */
  tailLine: number | null;
}

/**
 * Finds a last line cut short by a crash or power loss: no newline after it and not valid
 * JSON. Writers end every line with a newline, so only the last line can be partial; a bad
 * line in the middle, or a whole last line without its newline, is left to the parser.
 */
export function splitTruncatedTail(text: string): JsonlTail {
  if (text === '' || text.endsWith('\n')) return { complete: text, tail: null, tailLine: null };
  const cut = text.lastIndexOf('\n') + 1;
  const last = text.slice(cut);
  const json = last.charCodeAt(0) === 0xfeff ? last.slice(1) : last;
  if (json.trim() === '') return { complete: text, tail: null, tailLine: null };
  try {
    JSON.parse(json);
    return { complete: text, tail: null, tailLine: null };
  } catch {
    const complete = text.slice(0, cut);
    return { complete, tail: last, tailLine: splitJsonlLines(complete).length + 1 };
  }
}

export interface ParseOptions {
  /** File name used as a prefix in messages, e.g. "stamps.jsonl line 3: ...". */
  file?: string;
  /** Stop listing problems after this many (default 100); a summary line follows. */
  maxErrors?: number;
}

export interface JsonlRows<T> {
  /** Valid rows in file order. */
  rows: T[];
  /** 1-based line number of each row in `rows`. */
  lineNumbers: number[];
  /** Readable problems, each with its line number. Empty when the file is valid. */
  errors: string[];
}

function capErrors(errors: string[], max: number, label: string): string[] {
  if (errors.length <= max) return errors;
  const kept = errors.slice(0, max);
  kept.push(`${label}... ${errors.length - max} more problems`);
  return kept;
}

/** Parses and validates JSONL text line by line. */
export function parseJsonl<T>(text: string, validate: Validator<T>, opts: ParseOptions = {}): JsonlRows<T> {
  const prefix = opts.file !== undefined ? `${opts.file} line` : 'line';
  const rows: T[] = [];
  const lineNumbers: number[] = [];
  const errors: string[] = [];
  splitJsonlLines(text).forEach((line, idx) => {
    const lineNo = idx + 1;
    if (line.trim() === '') {
      errors.push(`${prefix} ${lineNo}: empty line`);
      return;
    }
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch (e) {
      errors.push(`${prefix} ${lineNo}: not valid JSON (${(e as Error).message})`);
      return;
    }
    const problems = validate(value);
    if (problems.length > 0) {
      for (const p of problems) errors.push(`${prefix} ${lineNo}: ${p}`);
      return;
    }
    rows.push(value as T);
    lineNumbers.push(lineNo);
  });
  const label = opts.file !== undefined ? `${opts.file}: ` : '';
  return { rows, lineNumbers, errors: capErrors(errors, opts.maxErrors ?? 100, label) };
}

export interface JsonParse<T> {
  value: T | null;
  errors: string[];
}

/** Parses and validates a JSON file. */
export function parseJson<T>(text: string, validate: Validator<T>, opts: ParseOptions = {}): JsonParse<T> {
  const prefix = opts.file !== undefined ? `${opts.file}: ` : '';
  let value: unknown;
  try {
    value = JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
  } catch (e) {
    return { value: null, errors: [`${prefix}not valid JSON (${(e as Error).message})`] };
  }
  const problems = validate(value).map((p) => `${prefix}${p}`);
  const errors = capErrors(problems, opts.maxErrors ?? 100, prefix);
  return { value: problems.length === 0 ? (value as T) : null, errors };
}
