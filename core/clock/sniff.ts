// Trace lag on a sharp sniff, gate recording only (spec 6.3, 9.6 row 4, 7.12, 8.1; PREREG.md §4).

import { SAMPLE_RATE_HZ, SNIFF_KILL_MIN_MS, SNIFF_PASS_MAX_MS, THRESHOLD_TOLERANCE_MS } from './constants.ts';
import { leastSquaresLine, median, round1 } from './stats.ts';
import type { CalibSniffLag } from './types.ts';

/** One SDK packet: its arrival sample and the trace samples it carries [ts us, value]. */
export interface TracePacket {
  nArr: number;
  tr: ReadonlyArray<readonly [number, number]>;
}

export interface SniffLagInput {
  /** Sound onsets n_sniff in channel 0 (from the sniff onset finder): the found sniffs (PREREG §4). */
  onsets: readonly number[];
  /** Packets in arrival order (sorted by nArr here; ties keep their order). */
  packets: readonly TracePacket[];
  /** Median amplitude of the listening block (spec 6.3); must be > 0. */
  aRef: number;
  /**
   * L_rt for the upper bound, ms. Under rule `both` pass the larger of A and B (PREREG §4: the
   * larger L_rt for the sniff lag's upper bound). Null without a valid L_rt (rule `void`): the
   * lower bounds stay, the upper bounds and the reading are null.
   */
  lrtMs: number | null;
  /** Trace sign: +1 when an in-breath raises the trace (spec 7.4). */
  sign?: 1 | -1;
}

export interface SniffLagOptions {
  sampleRateHz?: number;
  /** Rise that counts as arrival, in A_ref (spec 6.3: 0.15). */
  riseFraction?: number;
  /** Reference: median of the trace that arrived in this window before the onset (spec 6.3: 500 ms). */
  refWindowMs?: number;
  /** No arrival within this after the onset: the trace never arrived (PREREG §4: 2 s). */
  maxSearchMs?: number;
}

export type SniffReading = 'PASS' | 'BETWEEN' | 'KILL';

export interface SniffMeasurement {
  nSniff: number;
  refLevel: number | null;
  /**
   * False when the trace never arrived: no rise within 2 s of the onset, or no trace sample in the
   * 500 ms before it. Such a sniff has a lag over 2 000 ms (PREREG §4).
   */
  arrived: boolean;
  /** nArr of the first packet whose trace rose >= riseFraction * A_ref above the reference. */
  nArr: number | null;
  /** lo = (nArr - n_sniff) / 48000, ms; the true lag lies in [lo, lo + L_rt]. */
  loMs: number | null;
  /** lo + L_rt; null without a valid L_rt or without an arrival. */
  hiMs: number | null;
  /** Descriptive best case: the rise extrapolated back to the reference level, ms. */
  bestCaseMs: number | null;
}

export interface SniffLag {
  sniffs: SniffMeasurement[];
  /** Found sniffs: every sound onset given, with or without an arrival (PREREG §4). */
  n: number;
  /** Found sniffs whose trace never arrived, counted beside n (PREREG §4). */
  noArrival: number;
  /**
   * True when the medians fall on sniffs without an arrival: they lie above every measured value
   * and over `medianOverMs`, so the reading is KILL and the medians print as null (PREREG §4).
   */
  medianNotArrived: boolean;
  /** With medianNotArrived, what both medians are known to exceed, ms (censoredMedianOverMs); else null. */
  medianOverMs: number | null;
  /** Medians over all found sniffs, those without an arrival ranked above every measured value. */
  loMedianMs: number | null;
  hiMedianMs: number | null;
  /** Median of the descriptive best cases (verdict `best_case_ms`); null when none was computable. */
  bestCaseMedianMs: number | null;
  /** Row 4 of spec 9.6; null when no sniff was found or without a valid L_rt. */
  reading: SniffReading | null;
  /**
   * calib.json sniff_lag_ms: n found; lo_median and hi_median null when no sniff was found, or,
   * with n > 0, when the medians fall on sniffs without an arrival (then row 4 reads KILL).
   */
  calib: CalibSniffLag;
}

const RISE_FRACTION = 0.15;
const REF_WINDOW_MS = 500;
const MAX_SEARCH_MS = 2000;
/** Back-extrapolation uses the rise from the crossing up to half of A_ref, at most 6 samples. */
const BEST_CASE_TOP = 0.5;
const BEST_CASE_MAX_POINTS = 6;

/**
 * Spec 9.6 row 4 on the values given (sniffLag passes the measured medians; calib.json prints
 * them rounded to 0.1 ms): PASS if hi <= 150 ms, KILL if lo > 350 ms, else BETWEEN. A median
 * that falls on a sniff without an arrival is +Infinity here (medianOverFound), so it reads KILL.
 */
export function sniffReading(loMedianMs: number, hiMedianMs: number): SniffReading {
  if (hiMedianMs <= SNIFF_PASS_MAX_MS + THRESHOLD_TOLERANCE_MS) return 'PASS';
  if (loMedianMs > SNIFF_KILL_MIN_MS + THRESHOLD_TOLERANCE_MS) return 'KILL';
  return 'BETWEEN';
}

/**
 * Median over `measured.length + notArrived` found sniffs, the `notArrived` ones ranked above every
 * measured value (PREREG §4). +Infinity when the median falls on one of them (with an even count,
 * when the upper middle one does); null without any sniff.
 */
export function medianOverFound(measured: readonly number[], notArrived: number): number | null {
  const n = measured.length + notArrived;
  if (n === 0) return null;
  if (notArrived === 0) return median(measured);
  const sorted = [...measured].sort((a, b) => a - b);
  const at = (i: number): number => (i < sorted.length ? sorted[i]! : Number.POSITIVE_INFINITY);
  const mid = n >> 1;
  return n % 2 === 1 ? at(mid) : (at(mid - 1) + at(mid)) / 2;
}

/**
 * What a median that falls on sniffs without an arrival is known to exceed, ms. Such a sniff has a
 * lag over `overMs` (PREREG §4: 2 000 ms). The bound is whole when the middle value is one of them
 * (odd n) or both middle values are (even n, more than half without an arrival); it is half when
 * only the upper middle value is one, or when the count is not known, because a measured lag is
 * at least 0.
 */
export function censoredMedianOverMs(n: number, noArrival: number | null, overMs: number = MAX_SEARCH_MS): number {
  return n % 2 === 1 || (noArrival !== null && 2 * noArrival > n) ? overMs : overMs / 2;
}

const finiteOrNull = (x: number | null): number | null => (x !== null && Number.isFinite(x) ? x : null);

export function sniffLag(input: SniffLagInput, opts: SniffLagOptions = {}): SniffLag {
  if (!(input.aRef > 0)) throw new RangeError(`sniffLag: A_ref must be above 0, got ${input.aRef} (spec 6.3)`);
  const rate = opts.sampleRateHz ?? SAMPLE_RATE_HZ;
  const sign = input.sign ?? 1;
  const rise = (opts.riseFraction ?? RISE_FRACTION) * input.aRef;
  const refWindow = ((opts.refWindowMs ?? REF_WINDOW_MS) * rate) / 1000;
  const maxSearchMs = opts.maxSearchMs ?? MAX_SEARCH_MS;
  const maxSearch = (maxSearchMs * rate) / 1000;
  const packets = [...input.packets].sort((p, q) => p.nArr - q.nArr);

  // All trace samples by camera time, once, for the back-extrapolation.
  const byTs = new Map<number, number>();
  for (const p of packets) for (const [ts, v] of p.tr) if (!byTs.has(ts)) byTs.set(ts, sign * v);
  const series = [...byTs.entries()].sort((p, q) => p[0] - q[0]);
  const indexOfTs = new Map<number, number>(series.map(([ts], j) => [ts, j]));

  const sniffs = input.onsets.map((nSniff): SniffMeasurement => {
    const none: SniffMeasurement = { nSniff, refLevel: null, arrived: false, nArr: null, loMs: null, hiMs: null, bestCaseMs: null };
    const ref: number[] = [];
    for (const p of packets) {
      if (p.nArr >= nSniff - refWindow && p.nArr < nSniff) for (const [, v] of p.tr) ref.push(sign * v);
    }
    const refLevel = median(ref);
    if (refLevel === null) return none;

    let hit: { nArr: number; ts: number } | null = null;
    for (const p of packets) {
      if (p.nArr < nSniff) continue;
      if (p.nArr > nSniff + maxSearch) break;
      for (const [ts, v] of p.tr) {
        if (sign * v - refLevel >= rise) {
          hit = { nArr: p.nArr, ts };
          break;
        }
      }
      if (hit) break;
    }
    if (!hit) return { ...none, refLevel };

    const loMs = ((hit.nArr - nSniff) * 1000) / rate;
    return {
      nSniff,
      refLevel,
      arrived: true,
      nArr: hit.nArr,
      loMs,
      hiMs: input.lrtMs === null ? null : loMs + input.lrtMs,
      bestCaseMs: bestCase(series, indexOfTs.get(hit.ts) ?? -1, refLevel, input.aRef, loMs),
    };
  });

  const arrived = sniffs.filter((s) => s.arrived);
  const noArrival = sniffs.length - arrived.length;
  const lo = medianOverFound(arrived.map((s) => s.loMs!), noArrival);
  const hi = input.lrtMs === null ? null : medianOverFound(arrived.map((s) => s.hiMs!), noArrival);
  const loMedianMs = finiteOrNull(lo);
  const hiMedianMs = finiteOrNull(hi);
  const bestCaseMedianMs = median(arrived.map((s) => s.bestCaseMs).filter((v): v is number => v !== null));
  const medianNotArrived = lo === Number.POSITIVE_INFINITY;
  return {
    sniffs,
    n: sniffs.length,
    noArrival,
    medianNotArrived,
    medianOverMs: medianNotArrived ? censoredMedianOverMs(sniffs.length, noArrival, maxSearchMs) : null,
    loMedianMs,
    hiMedianMs,
    bestCaseMedianMs,
    reading: lo === null || hi === null ? null : sniffReading(lo, hi),
    calib: {
      n: sniffs.length,
      lo_median: loMedianMs === null ? null : round1(loMedianMs),
      hi_median: hiMedianMs === null ? null : round1(hiMedianMs),
    },
  };
}

// The rise from the crossing sample, extrapolated back to the reference level; the lag of that
// moment assuming it would have arrived with the crossing sample's latency (spec 6.3, descriptive).
function bestCase(
  series: ReadonlyArray<readonly [number, number]>,
  jc: number,
  refLevel: number,
  aRef: number,
  loMs: number,
): number | null {
  if (jc < 0) return null;
  const tc = series[jc]![0];
  const xs: number[] = [];
  const ys: number[] = [];
  for (let j = jc; j < series.length && xs.length < BEST_CASE_MAX_POINTS; j++) {
    const [ts, v] = series[j]!;
    xs.push((ts - tc) / 1e6);
    ys.push(v);
    if (v - refLevel >= BEST_CASE_TOP * aRef && xs.length >= 2) break;
  }
  const line = leastSquaresLine(xs, ys);
  if (!line || !(line.slope > 0)) return null;
  const xStart = (refLevel - line.intercept) / line.slope;
  return loMs + xStart * 1000;
}
