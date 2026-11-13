// detector_in.jsonl lines, stamps.jsonl "arr" lines (spec 8.1) and stream.jsonl (spec 8.7).
// Pure: strings in, values out.

import type { BatchInput, DetectorInput, NarratorState, TracePair } from './types.ts';

function fail(what: string, line: string): never {
  const shown = line.length > 120 ? `${line.slice(0, 117)}...` : line;
  throw new Error(`detector_in: ${what}: ${shown}`);
}

const isNum = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x);
const isPair = (x: unknown): x is TracePair => Array.isArray(x) && x.length === 2 && isNum(x[0]) && typeof x[1] === 'number';

/**
 * Parses one detector_in.jsonl line. Values are read back exactly as JSON.stringify wrote them
 * (spec 8.1). Unknown extra fields are kept out of the result; a state string outside the four
 * known states is accepted and treated by the detector as "not reading".
 */
export function parseDetectorInLine(line: string): DetectorInput {
  let o: unknown;
  try {
    o = JSON.parse(line);
  } catch {
    return fail('not JSON', line);
  }
  if (typeof o !== 'object' || o === null || Array.isArray(o)) return fail('not an object', line);
  const r = o as Record<string, unknown>;
  switch (r['k']) {
    case 'batch': {
      const seq = r['seq'];
      const tr = r['tr'];
      if (!isNum(seq)) return fail('batch without seq', line);
      if (!Array.isArray(tr) || !tr.every(isPair)) return fail('batch tr must be [[ts, value], ...]', line);
      const out: BatchInput = { k: 'batch', seq, tr: tr as TracePair[] };
      const talk = r['talk'];
      if (talk !== undefined) {
        if (!Array.isArray(talk) || !talk.every(isPair)) return fail('batch talk must be [[ts, flag], ...]', line);
        out.talk = talk as [number, number][];
      }
      for (const key of ['g', 'hm'] as const) {
        const v = r[key];
        if (v === undefined) continue;
        if (v !== null && typeof v !== 'number') return fail(`batch ${key} must be a number or null`, line);
        out[key] = v;
      }
      return out;
    }
    case 'val': {
      const seq = r['seq'];
      const code = r['code'];
      if (!isNum(seq) || !isNum(code)) return fail('val needs seq and code', line);
      return { k: 'val', seq, code };
    }
    case 'voice': {
      const n = r['n'];
      const on = r['on'];
      if (!isNum(n) || typeof on !== 'boolean') return fail('voice needs n and on', line);
      return { k: 'voice', n, on };
    }
    case 'state': {
      const n = r['n'];
      const s = r['s'];
      if (!isNum(n) || typeof s !== 'string') return fail('state needs n and s', line);
      return { k: 'state', n, s: s as NarratorState };
    }
    default:
      return fail('unknown k', line);
  }
}

/** Parses a whole detector_in.jsonl text; blank lines are skipped. */
export function parseDetectorIn(text: string): DetectorInput[] {
  const out: DetectorInput[] = [];
  for (const line of text.split('\n')) {
    const t = line.trim();
    if (t.length > 0) out.push(parseDetectorInLine(t));
  }
  return out;
}

/** One detector_in.jsonl line, without rounding (spec 8.1). */
export function formatDetectorInLine(input: DetectorInput): string {
  return JSON.stringify(input);
}

/** A stamps.jsonl line, as far as this module needs it (spec 8.1). */
export interface StampLike {
  n: number;
  k: string;
  seq?: number;
}

/** seq -> nArr from the "arr" lines of stamps.jsonl (spec 8.1); the first stamp of a seq wins. */
export function nArrMapFromStamps(lines: Iterable<StampLike>): Map<number, number> {
  const m = new Map<number, number>();
  for (const l of lines) {
    if (l.k === 'arr' && typeof l.seq === 'number' && typeof l.n === 'number' && !m.has(l.seq)) m.set(l.seq, l.n);
  }
  return m;
}

/** A stream.jsonl text read back: the detector inputs and seq -> nArr (spec 8.7). */
export interface StreamRead {
  inputs: DetectorInput[];
  nArrBySeq: Map<number, number>;
}

/**
 * Parses stream.jsonl: detector_in.jsonl lines whose batch and val lines carry the nArr of their
 * packet, null when stamps.jsonl had none (spec 8.7). The first nArr of a seq wins.
 */
export function parseStream(text: string): StreamRead {
  const inputs: DetectorInput[] = [];
  const nArrBySeq = new Map<number, number>();
  for (const line of text.split('\n')) {
    const t = line.trim();
    if (t.length === 0) continue;
    const input = parseDetectorInLine(t);
    inputs.push(input);
    if (input.k !== 'batch' && input.k !== 'val') continue;
    const n = (JSON.parse(t) as { nArr?: unknown }).nArr;
    if (n === undefined || n === null) continue;
    if (typeof n !== 'number' || !Number.isFinite(n)) fail('nArr must be a number or null', t);
    if (!nArrBySeq.has(input.seq)) nArrBySeq.set(input.seq, n);
  }
  return { inputs, nArrBySeq };
}
