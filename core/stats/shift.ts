// Second chance-level estimate of spec 4.3 (spec 7.10: "10 000 круговых сдвигов").
// Objection onsets are shifted round a circle made of each session's active time, with
// the objections themselves cut out beforehand, so that only false stops remain on it.
// One random shift per session per round, common to all its objections (gaps are kept).
// Per round, the share of onsets with a stop in [t - W, t) is pooled over all sessions;
// the estimate is the mean of that share over the rounds.
//
// Reproducible bit for bit (results.json chance_shift_pct is recomputed by npm run verify
// and by the browser, spec 7.11): the shifts come from sfc32 with a seed fixed in code
// before any data exist (CIRCULAR_SHIFT_SEED), the sessions draw their shifts in a
// canonical order by content (compareShiftSessions), so the order they are passed in
// does not matter, and hits are summed as integers, so the mean is one exact division.
// circularShiftExpectedShare gives the exact limit for infinitely many rounds: with a
// uniform shift every onset lands uniformly on the circle, so its hit chance is the
// fraction of the circle covered by the arcs (s, s + W] of the stops.

import {
  type IntervalMs,
  lastIntervalStartingAtOrBefore,
  normalizeIntervalsMs,
  subtractIntervalsMs,
} from './intervals.ts';
import { CHANCE_WINDOW_MS } from './poisson.ts';
import { createSeededRng } from './rng.ts';
import { assertCount, assertFiniteNumber, at } from './validate.ts';

/** Number of circular shifts (spec 4.3). */
export const CIRCULAR_SHIFT_COUNT = 10_000;

/**
 * Seed of the published shift estimate. Spec 4.3 leaves it open; it is fixed here, before
 * any data exist, so that it cannot be picked after seeing the result. Changing it changes
 * chance_shift_pct.
 */
export const CIRCULAR_SHIFT_SEED = 43;

/** Each objection is cut from this long before its voice onset (spec 4.3, an assumption there). */
export const SHIFT_CUT_BEFORE_ONSET_MS = 3_000;

/** One session on its circle. */
export interface ShiftSession {
  /** Circumference: active time with the objection spans cut out. */
  lengthMs: number;
  /** False stops on the circle, sorted, each in [0, lengthMs). */
  stopsMs: readonly number[];
  /** Objection voice onsets on the circle, each in [0, lengthMs). */
  onsetsMs: readonly number[];
}

export interface ShiftTimelineInput {
  /** Active time of the session (spec 4.2), session clock. */
  activeMs: readonly IntervalMs[];
  /** One span per objection: from t_v - 3 s to the end of the period after the voice (spec 4.3). */
  cutMs: readonly IntervalMs[];
  /** Chest stops t_s, session clock. Stops inside a cut span belong to an objection and are dropped. */
  stopsMs: readonly number[];
  /** Voice onsets t_v of the objections, session clock. */
  onsetsMs: readonly number[];
}

/**
 * Lays one session out on its circle: active time minus the objection spans, with every
 * time mapped to the amount of kept time before it. A time inside a removed stretch maps
 * to the point where that stretch collapsed, so an onset sits where its cut span was, and
 * a stop just after the end of an active stretch sits at the end of that stretch.
 */
export function buildShiftSession(input: ShiftTimelineInput): ShiftSession {
  const active = normalizeIntervalsMs(input.activeMs, 'activeMs');
  const cuts = normalizeIntervalsMs(input.cutMs, 'cutMs');
  const kept = subtractIntervalsMs(active, cuts);
  const cumulative: number[] = [];
  let total = 0;
  for (const iv of kept) {
    cumulative.push(total);
    total += iv.endMs - iv.startMs;
  }
  const position = (t: number): number => {
    const i = lastIntervalStartingAtOrBefore(kept, t);
    if (i < 0) return 0;
    const iv = kept[i] as IntervalMs;
    const pos = at(cumulative, i) + Math.min(t, iv.endMs) - iv.startMs;
    return total > 0 && pos >= total ? pos - total : pos;
  };
  const insideCut = (t: number): boolean => {
    const i = lastIntervalStartingAtOrBefore(cuts, t);
    return i >= 0 && t < (cuts[i] as IntervalMs).endMs;
  };
  input.stopsMs.forEach((t, i) => assertFiniteNumber(t, `stopsMs[${i}]`));
  input.onsetsMs.forEach((t, i) => assertFiniteNumber(t, `onsetsMs[${i}]`));
  const stopsMs = input.stopsMs
    .filter((t) => !insideCut(t))
    .map(position)
    .sort((a, b) => a - b);
  const onsetsMs = input.onsetsMs.map(position);
  return { lengthMs: total, stopsMs, onsetsMs };
}

function checkSessions(sessions: readonly ShiftSession[], windowMs: number): void {
  assertFiniteNumber(windowMs, 'windowMs');
  if (windowMs <= 0) throw new RangeError(`windowMs must be > 0, got ${windowMs}`);
  sessions.forEach((s, i) => {
    assertFiniteNumber(s.lengthMs, `sessions[${i}].lengthMs`);
    if (s.lengthMs < 0) throw new RangeError(`sessions[${i}].lengthMs must be >= 0`);
    if (s.onsetsMs.length > 0 && s.lengthMs === 0) {
      throw new RangeError(`sessions[${i}] has objections but no active time to shift them along`);
    }
    const inCircle = (t: number): boolean => Number.isFinite(t) && t >= 0 && t < s.lengthMs;
    s.onsetsMs.forEach((t, j) => {
      if (!inCircle(t)) throw new RangeError(`sessions[${i}].onsetsMs[${j}] = ${t} is outside [0, lengthMs)`);
    });
    s.stopsMs.forEach((t, j) => {
      if (!inCircle(t)) throw new RangeError(`sessions[${i}].stopsMs[${j}] = ${t} is outside [0, lengthMs)`);
      if (j > 0 && t < at(s.stopsMs, j - 1)) throw new RangeError(`sessions[${i}].stopsMs must be sorted`);
    });
  });
}

/** Whether a stop lies in [t - W, t) on a circle; stops sorted ascending in [0, length). */
export function hasStopInWindowBefore(sortedStopsMs: readonly number[], tMs: number, windowMs: number, lengthMs: number): boolean {
  const n = sortedStopsMs.length;
  if (n === 0) return false;
  // Largest stop strictly before t; if none, wrap to the last stop.
  let lo = 0;
  let hi = n - 1;
  let idx = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (at(sortedStopsMs, mid) < tMs) {
      idx = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  const gap = idx >= 0 ? tMs - at(sortedStopsMs, idx) : tMs - at(sortedStopsMs, n - 1) + lengthMs;
  return gap > 0 && gap <= windowMs;
}

function compareNumberLists(a: readonly number[], b: readonly number[]): number {
  if (a.length !== b.length) return a.length - b.length;
  for (let i = 0; i < a.length; i++) {
    const d = at(a, i) - at(b, i);
    if (d !== 0) return d;
  }
  return 0;
}

/**
 * Canonical order in which sessions draw their shifts: by circumference, then by the
 * sorted onsets, then by the stops. Sessions that compare equal have the same content,
 * so which of them draws first does not change the result.
 */
export function compareShiftSessions(a: ShiftSession, b: ShiftSession): number {
  const byLength = a.lengthMs - b.lengthMs;
  if (byLength !== 0) return byLength;
  const byOnsets = compareNumberLists(
    [...a.onsetsMs].sort((x, y) => x - y),
    [...b.onsetsMs].sort((x, y) => x - y),
  );
  if (byOnsets !== 0) return byOnsets;
  return compareNumberLists(a.stopsMs, b.stopsMs);
}

export interface CircularShiftOptions {
  /** Seed of the shift stream; default CIRCULAR_SHIFT_SEED (the published estimate). */
  seed?: number;
  /** Window W before the onset; default 1500 ms (spec 4.2). */
  windowMs?: number;
  /** Number of rounds; default 10 000 (spec 4.3). */
  shifts?: number;
}

export interface CircularShiftResult {
  /** Mean pooled share over the rounds: the second chance-level estimate; null without onsets. */
  share: number | null;
  /** Monte Carlo standard error of that mean; null without onsets. */
  standardError: number | null;
  /** Onsets with a stop in their window, summed over all rounds: share = hits / (shifts * onsets). */
  hits: number;
  shifts: number;
  onsets: number;
  windowMs: number;
  seed: number;
}

/** Second chance-level estimate of spec 4.3, by seeded random circular shifts. */
export function circularShiftChanceLevel(
  sessions: readonly ShiftSession[],
  options: CircularShiftOptions = {},
): CircularShiftResult {
  const windowMs = options.windowMs ?? CHANCE_WINDOW_MS;
  const shifts = options.shifts ?? CIRCULAR_SHIFT_COUNT;
  const seed = options.seed ?? CIRCULAR_SHIFT_SEED;
  assertCount(shifts, 'shifts');
  if (shifts === 0) throw new RangeError('shifts must be >= 1');
  checkSessions(sessions, windowMs);
  const rng = createSeededRng(seed);
  const ordered = sessions.filter((s) => s.onsetsMs.length > 0).sort(compareShiftSessions);
  const onsets = ordered.reduce((sum, s) => sum + s.onsetsMs.length, 0);
  if (onsets === 0) return { share: null, standardError: null, hits: 0, shifts, onsets, windowMs, seed };

  // Integer sums: exact in any order, so the mean is a single correctly rounded division.
  let hits = 0;
  let sumOfSquares = 0;
  for (let round = 0; round < shifts; round++) {
    let roundHits = 0;
    for (const s of ordered) {
      const shift = rng() * s.lengthMs;
      for (const onset of s.onsetsMs) {
        let t = onset + shift;
        if (t >= s.lengthMs) t -= s.lengthMs;
        if (hasStopInWindowBefore(s.stopsMs, t, windowMs, s.lengthMs)) roundHits++;
      }
    }
    hits += roundHits;
    sumOfSquares += roundHits * roundHits;
  }
  const share = hits / (shifts * onsets);
  // Sample variance of the per-round hit count; the share per round is that count / onsets.
  const varianceOfHits = shifts > 1 ? Math.max(0, (sumOfSquares - (hits * hits) / shifts) / (shifts - 1)) : 0;
  const standardError = Math.sqrt(varianceOfHits / shifts) / onsets;
  return { share, standardError, hits, shifts, onsets, windowMs, seed };
}

/** Fraction of a session's circle covered by the arcs (s, s + W] of its stops. */
export function circleCoverage(sortedStopsMs: readonly number[], windowMs: number, lengthMs: number): number {
  const n = sortedStopsMs.length;
  if (n === 0 || lengthMs <= 0) return 0;
  let covered = 0;
  for (let i = 0; i < n; i++) {
    const s = at(sortedStopsMs, i);
    const next = i + 1 < n ? at(sortedStopsMs, i + 1) : at(sortedStopsMs, 0) + lengthMs;
    covered += Math.min(windowMs, next - s);
  }
  return Math.min(1, covered / lengthMs);
}

/** Exact limit of circularShiftChanceLevel as the number of rounds grows; null without onsets. */
export function circularShiftExpectedShare(
  sessions: readonly ShiftSession[],
  windowMs: number = CHANCE_WINDOW_MS,
): number | null {
  checkSessions(sessions, windowMs);
  let onsets = 0;
  let expectedHits = 0;
  for (const s of sessions) {
    if (s.onsetsMs.length === 0) continue;
    onsets += s.onsetsMs.length;
    expectedHits += s.onsetsMs.length * circleCoverage(s.stopsMs, windowMs, s.lengthMs);
  }
  return onsets === 0 ? null : expectedHits / onsets;
}
