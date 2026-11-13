// Half-open time intervals on a session clock, in ms (sample index / 48 at 48 kHz).
// Shared by the chance-level estimates of spec 4.3 (shift.ts, pseudo.ts) and the
// "window lies in active time" rule (armed.ts).

import { assertFiniteNumber } from './validate.ts';

/** Half-open interval [startMs, endMs) on a session clock. */
export interface IntervalMs {
  startMs: number;
  endMs: number;
}

/**
 * Checked, sorted and merged copy: empty intervals dropped, overlapping or touching ones
 * joined, so a span lies in the union exactly when it lies in one interval of the result.
 */
export function normalizeIntervalsMs(intervals: readonly IntervalMs[], name: string): IntervalMs[] {
  intervals.forEach((iv, i) => {
    assertFiniteNumber(iv.startMs, `${name}[${i}].startMs`);
    assertFiniteNumber(iv.endMs, `${name}[${i}].endMs`);
    if (iv.endMs < iv.startMs) throw new RangeError(`${name}[${i}] ends before it starts`);
  });
  const sorted = intervals
    .filter((iv) => iv.endMs > iv.startMs)
    .map((iv) => ({ startMs: iv.startMs, endMs: iv.endMs }))
    .sort((a, b) => a.startMs - b.startMs);
  const merged: IntervalMs[] = [];
  for (const iv of sorted) {
    const last = merged[merged.length - 1];
    if (last !== undefined && iv.startMs <= last.endMs) last.endMs = Math.max(last.endMs, iv.endMs);
    else merged.push(iv);
  }
  return merged;
}

/** a minus b; both normalized (sorted, disjoint). */
export function subtractIntervalsMs(a: readonly IntervalMs[], b: readonly IntervalMs[]): IntervalMs[] {
  const out: IntervalMs[] = [];
  let j = 0;
  for (const iv of a) {
    let start = iv.startMs;
    while (j < b.length && (b[j] as IntervalMs).endMs <= start) j++;
    let k = j;
    while (k < b.length && (b[k] as IntervalMs).startMs < iv.endMs) {
      const cut = b[k] as IntervalMs;
      if (cut.startMs > start) out.push({ startMs: start, endMs: cut.startMs });
      start = Math.max(start, cut.endMs);
      k++;
    }
    if (start < iv.endMs) out.push({ startMs: start, endMs: iv.endMs });
  }
  return out;
}

/** Index of the last interval starting at or before t, or -1; intervals sorted by start. */
export function lastIntervalStartingAtOrBefore(intervals: readonly IntervalMs[], t: number): number {
  let lo = 0;
  let hi = intervals.length - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if ((intervals[mid] as IntervalMs).startMs <= t) {
      found = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return found;
}

/**
 * Whether [startMs, endMs) lies inside the union of normalized intervals.
 * An empty span (endMs <= startMs) always does.
 */
export function isSpanCoveredMs(normalized: readonly IntervalMs[], startMs: number, endMs: number): boolean {
  if (endMs <= startMs) return true;
  const i = lastIntervalStartingAtOrBefore(normalized, startMs);
  return i >= 0 && endMs <= (normalized[i] as IntervalMs).endMs;
}

/** Index of the first value >= t in an ascending array (length when none). */
export function firstIndexAtOrAfter(sorted: readonly number[], t: number): number {
  let lo = 0;
  let hi = sorted.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if ((sorted[mid] as number) < t) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}
