// Adapter to live/reduce.cjs, the pure half of tap (spec 7.1): its SDK name tables, its one time
// conversion and its first-frame probe. live/ is CommonJS outside tsconfig, so the module is
// loaded with createRequire and typed here; nothing in it loads the SDK.
// reduce.cjs does not export the accessors that read a decoded SDK message, so their bodies are
// read from its source text: the smoke report names the exact field that came back empty (spec 7.12).

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';

export const REDUCE_PATH = join(import.meta.dirname, '..', '..', 'live', 'reduce.cjs');

/** What reduce.cjs probeMetrics() returns for one decoded packet; tap adds tsCbType (spec 7.12). */
export interface FirstFrameProbe {
  /** Top-level keys of the decoded message. */
  fields: string[];
  /** Type of the first sample or frame timestamp: 'Long', 'number', 'undefined', ... */
  tsType: string;
  tr: number;
  talk: number;
  frames: number;
  /** Points in the last landmark frame (478 expected). */
  points: number;
  lipsY13BelowY14: boolean | null;
  cornersX78BelowX308: boolean | null;
  xRange: [number, number] | null;
  yRange: [number, number] | null;
  /** Type of the timestampUs argument of the metrics callback (tap.cjs adds it). */
  tsCbType?: string;
}

interface ReduceModule {
  PROCESSING_NAMES: Readonly<Record<string, string>>;
  VALIDATION_NAMES: Readonly<Record<string, string>>;
  ERROR_NAMES: Readonly<Record<string, string>>;
  toUs(t: unknown): number;
  typeName(t: unknown): string;
  processingName(code: number): string;
  validationName(code: number): string;
  errorName(code: number): string;
  probeMetrics(msg: unknown): FirstFrameProbe;
}

let loaded: ReduceModule | null = null;

/** live/reduce.cjs, loaded on first use so that importing this module never fails on it. */
export function reduceModule(): ReduceModule {
  if (loaded === null) loaded = createRequire(import.meta.url)(REDUCE_PATH) as ReduceModule;
  return loaded;
}

export const processingName = (code: number): string => reduceModule().processingName(code);
export const validationName = (code: number): string => reduceModule().validationName(code);
export const errorName = (code: number): string => reduceModule().errorName(code);

/** The accessors of reduce.cjs that read a decoded SDK message, in the order the report lists them. */
export const ACCESSOR_NAMES = [
  'chestSamples',
  'talkSamples',
  'landmarkFrames',
  'stampOf',
  'traceValue',
  'talkingFlag',
  'framePoints',
  'frameReset',
  'pointXY',
] as const;
export type AccessorName = (typeof ACCESSOR_NAMES)[number];

/** Field paths as reduce.cjs reads them today; used when its source text cannot be read. */
const FALLBACK_PATHS: Readonly<Record<AccessorName, string>> = {
  chestSamples: 'msg.breathing.upperTrace',
  talkSamples: 'msg.face.talking',
  landmarkFrames: 'msg.face.landmarks',
  stampOf: 's.timestamp',
  traceValue: 's.value',
  talkingFlag: 's.detected',
  framePoints: 'f.value',
  frameReset: 'f.reset',
  pointXY: 'p.x, p.y',
};

/**
 * Field paths read by each accessor, taken from `const <name> = (<arg>) => <body>;` in the
 * reduce.cjs source ("msg?.breathing?.upperTrace" becomes "msg.breathing.upperTrace").
 * An accessor whose line is not found keeps the path known when this file was written.
 */
export function accessorPaths(sourceText?: string): Record<AccessorName, string> {
  let text = sourceText;
  if (text === undefined) {
    try {
      text = readFileSync(REDUCE_PATH, 'utf8');
    } catch {
      text = '';
    }
  }
  const out = { ...FALLBACK_PATHS };
  for (const name of ACCESSOR_NAMES) {
    const m = new RegExp(`^const ${name} = \\((\\w+)\\) =>\\s*(.+?);?\\s*$`, 'm').exec(text);
    if (!m) continue;
    const arg = m[1]!;
    const paths = new Set<string>();
    for (const p of m[2]!.matchAll(new RegExp(`\\b${arg}(?:\\??\\.[A-Za-z_$][\\w$]*)+`, 'g'))) {
      paths.add(p[0].replace(/\?/g, ''));
    }
    if (paths.size > 0) out[name] = [...paths].join(', ');
  }
  return out;
}

/** live/reduce.cjs as it is now: its sha256 and the field paths of its accessors. */
export interface ReduceSource {
  sha256: string | null;
  paths: Record<AccessorName, string>;
}

/** Reads live/reduce.cjs once for its hash and accessor paths (the report keeps them, spec 7.12). */
export function reduceSource(file: string = REDUCE_PATH): ReduceSource {
  let text: string | null = null;
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    text = null;
  }
  return {
    sha256: text === null ? null : createHash('sha256').update(text).digest('hex'),
    paths: accessorPaths(text ?? ''),
  };
}

// ---- SDK time fields: number, Long, or Long after a JSON round trip ---------------------------

/** A protobufjs Long as JSON.stringify writes it: {low, high, unsigned}. */
export interface LongJson {
  low: number;
  high: number;
  unsigned?: boolean;
}

export function isLongJson(v: unknown): v is LongJson {
  if (v === null || typeof v !== 'object') return false;
  const o = v as Record<string, unknown>;
  return Number.isInteger(o['low']) && Number.isInteger(o['high']);
}

/** Value of a Long given as words: high * 2^32 + low, low taken unsigned. */
export function longJsonToNumber(v: LongJson): number {
  const high = v.unsigned ? v.high >>> 0 : v.high | 0;
  return high * 4294967296 + (v.low >>> 0);
}

/**
 * An SDK time field in microseconds: number, live Long (toNumber, through reduce.cjs toUs),
 * Long after JSON ({low, high}), bigint or a decimal string (tap writes bigint as a string).
 * Null when it is none of these or not finite.
 */
export function timestampToUs(v: unknown): number | null {
  let us: number;
  if (typeof v === 'number') us = v;
  else if (isLongJson(v) && typeof (v as { toNumber?: unknown }).toNumber !== 'function') us = longJsonToNumber(v);
  else if (typeof v === 'string') us = /^-?\d+$/.test(v.trim()) ? Number(v.trim()) : Number.NaN;
  else if (v !== null && v !== undefined) us = reduceModule().toUs(v);
  else us = Number.NaN;
  return Number.isFinite(us) ? us : null;
}

/** Type name of an SDK time field as it was before logging: a JSON Long counts as 'Long'. */
export function timestampTypeName(v: unknown): string {
  if (v === null) return 'null';
  if (isLongJson(v)) return 'Long';
  if (typeof v === 'string' && /^-?\d+$/.test(v.trim())) return 'bigint (logged as a string)';
  return reduceModule().typeName(v);
}

/** Deep copy in which every JSON Long gets back a toNumber(), so reduce.cjs sees a Long again. */
export function reviveLongs(value: unknown, depth = 0): unknown {
  if (depth > 32 || value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((x) => reviveLongs(x, depth + 1));
  if (isLongJson(value)) {
    const n = longJsonToNumber(value);
    return { ...value, toNumber: () => n };
  }
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value)) out[k] = reviveLongs(v, depth + 1);
  return out;
}

/** reduce.cjs probeMetrics() on a decoded message logged as JSON (Longs revived first). */
export function probeDecodedMessage(msg: unknown): FirstFrameProbe {
  return reduceModule().probeMetrics(reviveLongs(msg));
}
