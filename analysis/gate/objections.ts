// Cues, replies and valid objections of the scored block (spec 4.5 point 3, 9.6): one reply per
// cue, the first after it; it is valid when it is an objection, its voice began after the cue and
// within 10 s, and the trace was usable for 2 s before t_v.

import { INVALID_VALIDATION_CODES, type DetectorInput } from '../../core/detector.ts';
import type { OnsetEvent } from '../../core/schemas/index.ts';
import { linePositionSamples } from '../rivals/index.ts';
import { RATE, TRACE_BEFORE_MS, TRACE_GAP_MS, VOICE_AFTER_CUE_MS, msToN } from './common.ts';

/** Labels that make a reply non-speech (spec 4.2): it is never an objection. */
const NON_SPEECH = new Set(['cough', 'laugh', 'throat', 'other']);

export interface CueReply {
  /** Cue number in the block, from 1. */
  cue: number;
  cueN: number;
  /** The first reply after the cue (one still going at the cue counts), or null. */
  reply: OnsetEvent | null;
  valid: boolean;
  /** Why the cue has no valid objection; null when valid. */
  why: string | null;
}

/** True for an onsets.json event that counts as an objection (kind objection, not non-speech). */
export function isObjection(e: OnsetEvent): boolean {
  return e.kind === 'objection' && (e.label === null || !NON_SPEECH.has(e.label));
}

/**
 * The reply of each cue: the first event, by its voice onset, that is still going at the cue or
 * starts after it, before the next cue (or the end of the block). A reply already going at the cue
 * began before it and so is not valid (spec 4.5 point 3).
 */
export function repliesOfCues(cues: readonly number[], events: readonly OnsetEvent[], blockEndN: number): { cue: number; cueN: number; reply: OnsetEvent | null }[] {
  const sorted = [...events].sort((a, b) => a.auto.n_v - b.auto.n_v);
  return cues.map((c, i) => {
    const next = cues[i + 1] ?? blockEndN;
    const reply = sorted.find((e) => (e.n_end ?? e.auto.n_v) >= c && e.auto.n_v < next) ?? null;
    return { cue: i + 1, cueN: c, reply };
  });
}

// ---- trace usability (spec 4.5 point 2) ---------------------------------------------------

export interface TraceTimeline {
  /** Unique trace sample timestamps, ascending, us. */
  ts: Float64Array;
  /** Packets by arrival: nArr and the newest sample timestamp. */
  arr: Float64Array;
  tsMax: Float64Array;
}

export function traceTimeline(inputs: readonly DetectorInput[], nArrBySeq: ReadonlyMap<number, number>): TraceTimeline {
  const seen = new Set<number>();
  const pk: [number, number][] = [];
  for (const r of inputs) {
    if (r.k !== 'batch') continue;
    let max = Number.NEGATIVE_INFINITY;
    for (const [t, v] of r.tr) {
      if (typeof t !== 'number' || !Number.isFinite(t) || typeof v !== 'number' || !Number.isFinite(v)) continue;
      seen.add(t);
      if (t > max) max = t;
    }
    const n = nArrBySeq.get(r.seq);
    if (n !== undefined && Number.isFinite(max)) pk.push([n, max]);
  }
  pk.sort((a, b) => a[0] - b[0]);
  return {
    ts: Float64Array.from([...seen].sort((a, b) => a - b)),
    arr: Float64Array.from(pk.map((p) => p[0])),
    tsMax: Float64Array.from(pk.map((p) => p[1])),
  };
}

function lowerBound(a: Float64Array, x: number): number {
  let lo = 0;
  let hi = a.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (a[mid]! < x) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** Camera clock minus mic clock near sample n: the smallest arrival delay of the packets within 10 s, s. */
function offsetNear(tl: TraceTimeline, n: number): number | null {
  const lo = lowerBound(tl.arr, n - 10 * RATE);
  const hi = lowerBound(tl.arr, n + 10 * RATE);
  let best: number | null = null;
  for (let i = lo; i < hi; i++) {
    const d = tl.arr[i]! / RATE - tl.tsMax[i]! / 1e6;
    if (best === null || d < best) best = d;
  }
  return best;
}

/**
 * No gap over 100 ms between trace samples in [n0, n1] (spec 4.5 point 2). The span goes to the
 * camera clock through the smallest arrival delay nearby (early by the shortest latency,
 * assumption); a gap that overlaps the span counts, as does one at either end.
 */
export function traceGapFree(tl: TraceTimeline, n0: number, n1: number, gapMs: number = TRACE_GAP_MS): boolean {
  const off = offsetNear(tl, (n0 + n1) / 2);
  if (off === null || tl.ts.length === 0) return false;
  const t0 = (n0 / RATE - off) * 1e6;
  const t1 = (n1 / RATE - off) * 1e6;
  const gap = gapMs * 1000;
  let i = lowerBound(tl.ts, t0 + 1e-6); // first sample after t0
  let prev = i > 0 ? tl.ts[i - 1]! : t0;
  for (; i < tl.ts.length && tl.ts[i]! <= t1; i++) {
    if (tl.ts[i]! - prev > gap) return false;
    prev = tl.ts[i]!;
  }
  return t1 - prev <= gap;
}

/** validationStatus changes in file order, with positions (nArr; the last known one without a stamp). */
export interface CodeChange {
  n: number;
  invalid: boolean;
}

export function codeTimeline(
  inputs: readonly DetectorInput[],
  nArrBySeq: ReadonlyMap<number, number>,
  invalidCodes: readonly number[] = INVALID_VALIDATION_CODES,
): CodeChange[] {
  const bad = new Set(invalidCodes);
  const out: CodeChange[] = [];
  let last = Number.NEGATIVE_INFINITY;
  for (const r of inputs) {
    const known = linePositionSamples(r, nArrBySeq);
    if (known !== null && known > last) last = known;
    if (r.k === 'val') out.push({ n: known ?? last, invalid: bad.has(r.code) });
  }
  return out;
}

/** True when one of the invalid codes held at any time in [n0, n1] (spec 4.5 point 2). */
export function invalidCodeDuring(changes: readonly CodeChange[], n0: number, n1: number): boolean {
  let atStart = false;
  for (const c of changes) {
    if (c.n <= n0) atStart = c.invalid;
    else if (c.n <= n1 && c.invalid) return true;
  }
  return atStart;
}

export interface ValidityContext {
  trace: TraceTimeline;
  codes: readonly CodeChange[];
}

/** Valid objections of the scored block (spec 9.6). */
export function scoreCues(cues: readonly number[], events: readonly OnsetEvent[], blockEndN: number, ctx: ValidityContext): CueReply[] {
  const after = msToN(VOICE_AFTER_CUE_MS);
  const before = msToN(TRACE_BEFORE_MS);
  return repliesOfCues(cues, events, blockEndN).map(({ cue, cueN, reply }): CueReply => {
    const no = (why: string): CueReply => ({ cue, cueN, reply, valid: false, why });
    if (reply === null) return no('no reply');
    if (!isObjection(reply)) return no(reply.kind !== 'objection' ? `the first reply is ${reply.kind === 'other' ? 'an' : 'a'} ${reply.kind}` : `the first reply is non-speech (${String(reply.label)})`);
    const nV = reply.auto.n_v;
    if (nV < cueN) return no('the voice began before the cue');
    if (nV > cueN + after) return no('the voice began more than 10 s after the cue');
    if (!traceGapFree(ctx.trace, nV - before, nV)) return no('a gap over 100 ms in the trace 2 s before t_v');
    if (invalidCodeDuring(ctx.codes, nV - before, nV)) return no('an invalid validation code 2 s before t_v');
    return { cue, cueN, reply, valid: true, why: null };
  });
}
