// Reads a smoke session folder (spec 8.1) as it is on disk: manifest.json, samples.jsonl,
// sdk_raw.jsonl.gz, stamps.jsonl, events.jsonl, plus any text log and any other JSONL file that
// may hold tap's smoke output (camera list, readiness, first-frame probe, enum checks).
// analysis/lib/session.ts skips every line that fails core/schemas and reads neither sdk_raw nor
// logs; smoke has to see lines whose SDK layout differs, so it keeps any JSON object with a kind.
// A broken or truncated line is counted and skipped: the machine may have stopped mid-write.

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';
import { constants, gunzipSync } from 'node:zlib';
import type { EventLine, SampleLine, Stamp } from '../../core/clock/index.ts';
import { isLongJson, longJsonToNumber } from './reduce-adapter.ts';

export type JsonObject = Record<string, unknown>;

/** One sdk_raw.jsonl.gz line (spec 7.1, 8.1) without its base64 payload. */
export interface RawSdkLine {
  seq: number | null;
  kind: string;
  tArrNs: string | null;
  tWallMs: number | null;
  /** timestampUs of the callback after tap's conversion; null when absent. */
  tsCbUs: number | null;
  /** Size of the metrics buffer in bytes (b64 decoded length); null without b64. */
  bufferBytes: number | null;
  /** Arguments of an event without a buffer, as logged. */
  args: unknown[] | null;
  /** A decoded message, if a tap version logs one (`decoded` or `msg`); null otherwise. */
  decoded: unknown;
}

export interface TextLog {
  file: string;
  lines: string[];
}

export interface InputFile {
  file: string;
  present: boolean;
  /** Lines (or records) read. */
  lines: number;
  /** Lines that were not a JSON object of the expected kind. */
  badLines: number;
  note: string | null;
}

export interface SessionFolder {
  dir: string;
  id: string;
  manifest: JsonObject | null;
  samples: SampleLine[];
  stamps: Stamp[];
  events: EventLine[];
  raw: RawSdkLine[];
  textLogs: TextLog[];
  /** Objects of JSONL files other than the five known ones (a tap or IPC log, if any). */
  otherJsonl: { file: string; rows: JsonObject[] }[];
  /** smoke_report.json of an earlier run of this report (typed-in credit balances survive). */
  previousReport: JsonObject | null;
  inputs: InputFile[];
  /** How the camera times of samples.jsonl were written: number, Long ({low, high}) or string; read as numbers. */
  sampleTimeTypes: Record<string, number>;
}

export const KNOWN_JSONL = ['samples.jsonl', 'stamps.jsonl', 'events.jsonl', 'detector_in.jsonl', 'ledger.jsonl'];
const MAX_TEXT_BYTES = 64 * 1024 * 1024;

function isObject(v: unknown): v is JsonObject {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/** JSONL text to objects; `accept` says whether a parsed object is a line of this file. */
export function parseJsonlObjects(
  text: string,
  accept: (o: JsonObject) => boolean = () => true,
): { rows: JsonObject[]; lines: number; badLines: number } {
  const rows: JsonObject[] = [];
  let lines = 0;
  let badLines = 0;
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (line === '') continue;
    lines++;
    try {
      const o: unknown = JSON.parse(line);
      if (isObject(o) && accept(o)) rows.push(o);
      else badLines++;
    } catch {
      badLines++;
    }
  }
  return { rows, lines, badLines };
}

/** Gunzips a possibly truncated gzip file (tap flushes it once a second, spec 7.1). */
export function gunzipTolerant(buf: Buffer): { text: string; truncated: boolean } {
  try {
    return { text: gunzipSync(buf).toString('utf8'), truncated: false };
  } catch {
    try {
      return { text: gunzipSync(buf, { finishFlush: constants.Z_SYNC_FLUSH }).toString('utf8'), truncated: true };
    } catch {
      return { text: '', truncated: true };
    }
  }
}

const finiteOrNull = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/** A camera time as a number when it was logged as a Long ({low, high}) or a decimal string; counted by type. */
function timeOf(v: unknown, types: Record<string, number>): unknown {
  const t = isLongJson(v) ? 'Long' : typeof v === 'string' && /^\d+$/.test(v) ? 'string' : typeof v === 'number' ? 'number' : null;
  if (t !== null) types[t] = (types[t] ?? 0) + 1;
  if (isLongJson(v)) return longJsonToNumber(v);
  return t === 'string' ? Number(v) : v;
}

/**
 * samples.jsonl line with its camera times (tsCbUs, tr and talk timestamps, lm.ts) as numbers.
 * tap converts them (reduce.cjs toUs); a writer that does not leaves Longs as {low, high} (spec 7.1).
 */
export function normalizeSampleTimes(o: JsonObject, types: Record<string, number> = {}): JsonObject {
  const out: JsonObject = { ...o };
  if (o['tsCbUs'] !== undefined) out['tsCbUs'] = timeOf(o['tsCbUs'], types);
  for (const key of ['tr', 'talk']) {
    const list = o[key];
    if (Array.isArray(list)) out[key] = list.map((p: unknown) => (Array.isArray(p) && p.length > 0 ? [timeOf(p[0], types), ...p.slice(1)] : p));
  }
  const lm = o['lm'];
  if (isObject(lm) && lm['ts'] !== undefined) out['lm'] = { ...lm, ts: timeOf(lm['ts'], types) };
  return out;
}

/** Decoded byte length of a base64 string, without decoding it. */
export function base64Bytes(b64: string): number {
  const s = b64.replace(/\s/g, '');
  const pad = s.endsWith('==') ? 2 : s.endsWith('=') ? 1 : 0;
  return Math.max(0, Math.floor((s.length * 3) / 4) - pad);
}

export function toRawSdkLine(o: JsonObject): RawSdkLine {
  const tArr = o['tArrNs'];
  const decoded = o['decoded'] ?? o['msg'] ?? null;
  return {
    seq: finiteOrNull(o['seq']),
    kind: String(o['kind']),
    tArrNs: typeof tArr === 'string' || typeof tArr === 'number' ? String(tArr) : null,
    tWallMs: finiteOrNull(o['tWallMs']),
    tsCbUs: finiteOrNull(timeOf(o['tsCbUs'], {})),
    bufferBytes: typeof o['b64'] === 'string' ? base64Bytes(o['b64']) : null,
    args: Array.isArray(o['args']) ? (o['args'] as unknown[]) : null,
    decoded: isObject(decoded) ? decoded : null,
  };
}

function readText(file: string): string | null {
  try {
    return readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

function readJsonObject(file: string): JsonObject | null {
  const text = readText(file);
  if (text === null) return null;
  try {
    const v: unknown = JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
    return isObject(v) ? v : null;
  } catch {
    return null;
  }
}

/** Reads one session folder. Missing files give empty lists and an `inputs` entry saying so. */
export function readSessionFolder(dir: string): SessionFolder {
  const inputs: InputFile[] = [];
  const note = (file: string, present: boolean, lines: number, badLines: number, why: string | null = null) =>
    inputs.push({ file, present, lines, badLines, note: why });

  const manifestPath = join(dir, 'manifest.json');
  const manifest = readJsonObject(manifestPath);
  note('manifest.json', existsSync(manifestPath), manifest ? 1 : 0, manifest || !existsSync(manifestPath) ? 0 : 1);

  const jsonl = (file: string, accept: (o: JsonObject) => boolean): JsonObject[] => {
    const text = readText(join(dir, file));
    if (text === null) {
      note(file, false, 0, 0);
      return [];
    }
    const r = parseJsonlObjects(text, accept);
    note(file, true, r.lines, r.badLines);
    return r.rows;
  };
  const sampleTimeTypes: Record<string, number> = {};
  const samples = jsonl('samples.jsonl', (o) => typeof o['k'] === 'string').map((o) =>
    normalizeSampleTimes(o, sampleTimeTypes),
  ) as unknown as SampleLine[];
  const converted = (sampleTimeTypes['Long'] ?? 0) + (sampleTimeTypes['string'] ?? 0);
  const samplesInput = inputs.find((f) => f.file === 'samples.jsonl');
  if (converted > 0 && samplesInput) samplesInput.note = `${converted} camera times were Long objects or strings, read as numbers`;
  const stamps = jsonl('stamps.jsonl', (o) => typeof o['k'] === 'string' && typeof o['n'] === 'number') as unknown as Stamp[];
  const events = jsonl('events.jsonl', (o) => typeof o['e'] === 'string') as unknown as EventLine[];

  let raw: RawSdkLine[] = [];
  const rawPath = join(dir, 'sdk_raw.jsonl.gz');
  if (existsSync(rawPath)) {
    const { text, truncated } = gunzipTolerant(readFileSync(rawPath));
    const r = parseJsonlObjects(text, (o) => typeof o['kind'] === 'string');
    raw = r.rows.map(toRawSdkLine);
    note('sdk_raw.jsonl.gz', true, r.lines, r.badLines, truncated ? 'gzip stream truncated: read up to the cut' : null);
  } else {
    note('sdk_raw.jsonl.gz', false, 0, 0);
  }

  const textLogs: TextLog[] = [];
  const otherJsonl: { file: string; rows: JsonObject[] }[] = [];
  let names: string[] = [];
  try {
    names = readdirSync(dir).sort();
  } catch {
    names = [];
  }
  for (const name of names) {
    const file = join(dir, name);
    let size = 0;
    try {
      const st = statSync(file);
      if (!st.isFile()) continue;
      size = st.size;
    } catch {
      continue;
    }
    if (/\.log$/i.test(name) && size <= MAX_TEXT_BYTES) {
      const text = readText(file) ?? '';
      textLogs.push({ file: name, lines: text.split(/\r?\n/) });
      note(name, true, text === '' ? 0 : text.split(/\r?\n/).filter((l) => l !== '').length, 0);
    } else if (/\.jsonl$/i.test(name) && !KNOWN_JSONL.includes(name) && size <= MAX_TEXT_BYTES) {
      const r = parseJsonlObjects(readText(file) ?? '');
      otherJsonl.push({ file: name, rows: r.rows });
      note(name, true, r.lines, r.badLines);
    }
  }

  return {
    dir,
    id: typeof manifest?.['id'] === 'string' ? manifest['id'] : basename(dir),
    manifest,
    samples,
    stamps,
    events,
    raw,
    textLogs,
    otherJsonl,
    previousReport: readJsonObject(join(dir, 'smoke_report.json')),
    inputs,
    sampleTimeTypes,
  };
}
