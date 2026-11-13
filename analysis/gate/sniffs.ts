// Row 4 of spec 9.6, the trace lag on a sharp sniff: [lo, lo + L_rt], n and the count of sniffs
// without an arrival from calib.json (the clocks step, spec 7.12; PREREG §4), checked against a
// recount made the way clocks makes it, plus the descriptive best case and how late D1's rule
// would have held on each sniff ("D1 on sniffs", spec 9.7). D1 is not active during the sniffs
// (nobody reads), so its rule runs alone there, with theta and A as D1 had them at the end of the
// listening block (assumption).

import { sniffReading, type SniffLag, type TracePacket } from '../../core/clock/index.ts';
import { lsSlopeWeights } from '../../core/detector/math.ts';
import { msToGridSteps, type DetectorInput, type Sign } from '../../core/detector.ts';
import { median } from '../../core/stats/index.ts';
import type { Calib, GateOutcome } from '../../core/schemas/index.ts';
import { calibSniffLagBlock, type CalibSniffLagBlock, type SniffRecount } from '../clocks/compute.ts';
import { sniffOnsets as clocksSniffOnsets } from '../clocks/measure.ts';
import type { SessionView } from '../lib/measure.ts';
import { RATE, round1OrNull } from './common.ts';

/** Sound onsets of the sniffs heard, searched from each 'Sniff' prompt for 2 s, as clocks and quickcheck search them (spec 6.3). */
export function sniffOnsets(s: SessionView, sniffSteps: readonly string[]): number[] {
  return clocksSniffOnsets(s, sniffSteps)
    .map((x) => x.n)
    .filter((n): n is number => n !== null);
}

/** Packets with their arrival (detector_in.jsonl batches with an "arr" stamp). */
export function tracePacketsOf(inputs: readonly DetectorInput[], nArrBySeq: ReadonlyMap<number, number>): TracePacket[] {
  const out: TracePacket[] = [];
  for (const r of inputs) {
    if (r.k !== 'batch') continue;
    const n = nArrBySeq.get(r.seq);
    if (n !== undefined) out.push({ nArr: n, tr: r.tr });
  }
  return out;
}

export interface RuleOnly {
  theta: number;
  A: number;
  L: number;
  M: number;
  gridHz: number;
  minRiseA: number;
  minRiseMs: number;
  sign: Sign;
}

function lowerBound(a: readonly number[], x: number): number {
  let lo = 0;
  let hi = a.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (a[mid]! < x) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/**
 * For each onset: ms from the sound onset to the arrival of the packet that completed the first
 * grid point where D1's rule held (v >= theta on M points in a row and a rise of min_rise_A * A in
 * 200 ms, spec 7.4 rule 7), searched for 2 s; null when it never held. The grid point comes out
 * with the first sample at or after it (spec 7.4 rule 1); trace values are interpolated linearly.
 */
export function ruleDelaysMs(onsets: readonly number[], packets: readonly TracePacket[], r: RuleOnly, maxSearchMs = 2000): (number | null)[] {
  const byTs = new Map<number, { v: number; arr: number }>();
  for (const p of [...packets].sort((a, b) => a.nArr - b.nArr)) {
    for (const [ts, v] of p.tr) {
      if (!Number.isFinite(ts) || !Number.isFinite(v) || byTs.has(ts)) continue;
      byTs.set(ts, { v: r.sign * v, arr: p.nArr });
    }
  }
  const ts = [...byTs.keys()].sort((a, b) => a - b);
  if (ts.length < 2 || !(r.A > 0)) return onsets.map(() => null);
  const xs = ts.map((t) => byTs.get(t)!.v);
  const arrs = ts.map((t) => byTs.get(t)!.arr);
  const origin = ts[0]!;
  const stepUs = 1e6 / r.gridHz;
  const w = lsSlopeWeights(r.L, r.gridHz);
  const rise = Math.max(1, msToGridSteps(r.minRiseMs, r.gridHz));
  const xAt = (i: number): number | null => {
    const t = origin + i * stepUs;
    const j = lowerBound(ts, t);
    if (j >= ts.length) return null;
    if (ts[j] === t || j === 0) return xs[j]!;
    const t0 = ts[j - 1]!;
    const t1 = ts[j]!;
    return xs[j - 1]! + ((xs[j]! - xs[j - 1]!) * (t - t0)) / (t1 - t0);
  };
  const availAt = (i: number): number | null => {
    const j = lowerBound(ts, origin + i * stepUs);
    return j < ts.length ? arrs[j]! : null;
  };
  const maxSearch = (maxSearchMs * RATE) / 1000;
  return onsets.map((nSniff) => {
    // Camera time near the onset: the first sample delivered at or after it, 1.5 s back for context.
    let k = -1;
    for (let j = 0; j < arrs.length; j++) if (arrs[j]! >= nSniff && (k < 0 || ts[j]! < ts[k]!)) k = j;
    if (k < 0) return null;
    let i = Math.max(r.L + rise, Math.floor((ts[k]! - 1.5e6 - origin) / stepUs));
    let run = 0;
    for (;; i++) {
      const avail = availAt(i);
      if (avail === null || avail > nSniff + maxSearch) return null;
      let acc = 0;
      let ok = true;
      for (let j = 0; j < r.L; j++) {
        const x = xAt(i - r.L + 1 + j);
        if (x === null) {
          ok = false;
          break;
        }
        acc += w[j]! * x;
      }
      const v = ok ? acc / r.A : null;
      if (v === null || v < r.theta) {
        run = 0;
        continue;
      }
      run++;
      const xi = xAt(i);
      const xb = xAt(i - rise);
      const riseOk = xi !== null && xb !== null && xi - xb >= r.minRiseA * r.A;
      if (run >= r.M && riseOk && avail >= nSniff) return ((avail - nSniff) * 1000) / RATE;
    }
  });
}

export interface SniffRow {
  outcome: GateOutcome;
  /**
   * Medians as calib.json and verdict.json hold them, to 0.1 ms. Null when no lag was measured, or
   * when they fall on sniffs whose trace never arrived (then `overMs` bounds them, PREREG §4).
   */
  loMedianMs: number | null;
  hiMedianMs: number | null;
  /** The medians fall on sniffs without an arrival: both are over this many ms (PREREG §4); null otherwise. */
  overMs: number | null;
  /** Found sniffs, with or without an arrival (PREREG §4). */
  n: number;
  /** Found sniffs whose trace never arrived, counted beside n (PREREG §4): calib.json's count, never a recount of it. */
  noArrival: number;
  bestCaseMs: number | null;
  d1OnSniffsMs: number | null;
  /**
   * Where n, the count and the medians come from: calib.json whenever it has a sniff block, graded
   * or not; the recount only when it has none; else none.
   */
  source: 'calib.json' | 'recomputed' | 'none';
  /**
   * The recount against calib.json: `agrees` when it gives calib.json's block (n, count, medians to
   * 0.1 ms, bound), so a graded outcome comes from its unrounded medians (spec 9.6 thresholds);
   * `differs` when it does not, so the outcome comes from calib.json as written (`mismatch` says
   * how); `none` when there was no recount or calib.json had no block to check.
   */
  recount: 'agrees' | 'differs' | 'none';
  /** The outcome comes from unrounded medians and differs from the one the printed medians give. */
  gradedUnrounded: boolean;
  /** Unrounded medians the outcome came from; null when it came from calib.json as written or none was measured. */
  gradedOn: { loMs: number; hiMs: number } | null;
  /** Plain words on a recount that differs from calib.json; null otherwise. */
  mismatch: string | null;
}

export interface SniffRowInput {
  calib: Calib | null;
  /** The lag recomputed as clocks computes it (analysis/clocks/compute.ts recountSniffLag); null: none. */
  recount: SniffRecount | null;
  /** Trace packets of detector_in.jsonl, for D1 on sniffs. */
  packets: readonly TracePacket[];
  rule: RuleOnly | null;
}

/** calib.json sniff_lag_ms with all its fields (validateCalib requires them); null when it has none. */
export function calibSniffBlockOf(calib: Calib | null): CalibSniffLagBlock | null {
  const b = calib?.sniff_lag_ms ?? null;
  if (b === null || typeof b.no_arrival !== 'number' || b.median_over_ms === undefined) return null;
  return { n: b.n, no_arrival: b.no_arrival, lo_median: b.lo_median, hi_median: b.hi_median, median_over_ms: b.median_over_ms };
}

function sameBlock(a: CalibSniffLagBlock, b: CalibSniffLagBlock): boolean {
  return a.n === b.n && a.no_arrival === b.no_arrival && a.lo_median === b.lo_median && a.hi_median === b.hi_median && a.median_over_ms === b.median_over_ms;
}

function blockText(b: CalibSniffLagBlock): string {
  const f = (x: number | null): string => (x === null ? 'null' : x.toFixed(1));
  const medians = b.median_over_ms !== null ? `medians over ${b.median_over_ms} ms` : `median [${f(b.lo_median)}, ${f(b.hi_median)}] ms`;
  return `n=${b.n}, ${b.no_arrival} without arrival, ${medians}`;
}

/** Measured (lo and hi) or censored (over a bound, n > 0): a block clocks wrote with a reading. */
function graded(b: CalibSniffLagBlock | null): b is CalibSniffLagBlock {
  return b !== null && b.n > 0 && (b.median_over_ms !== null || (b.lo_median !== null && b.hi_median !== null));
}

/** The numbers of row 4 as a calib.json block holds them (PREREG §4). */
function numbersOf(b: CalibSniffLagBlock): Pick<SniffRow, 'loMedianMs' | 'hiMedianMs' | 'overMs' | 'n' | 'noArrival'> {
  return { loMedianMs: b.lo_median, hiMedianMs: b.hi_median, overMs: b.median_over_ms, n: b.n, noArrival: b.no_arrival };
}

/** How a lag with a reading grades row 4: on its unrounded medians (spec 9.6: 150.04 ms is above 150). */
function gradingOf(lag: SniffLag & { reading: GateOutcome }): Pick<SniffRow, 'outcome' | 'gradedUnrounded' | 'gradedOn'> {
  const lo = round1OrNull(lag.loMedianMs);
  const hi = round1OrNull(lag.hiMedianMs);
  return {
    outcome: lag.reading,
    gradedUnrounded: lo !== null && hi !== null && sniffReading(lo, hi) !== lag.reading,
    gradedOn: lag.loMedianMs !== null && lag.hiMedianMs !== null ? { loMs: lag.loMedianMs, hiMs: lag.hiMedianMs } : null,
  };
}

/** How a calib.json block grades row 4 as written: KILL over a bound, else its medians to 0.1 ms. */
function blockGrading(b: CalibSniffLagBlock): Pick<SniffRow, 'outcome' | 'gradedUnrounded' | 'gradedOn'> {
  const outcome = b.median_over_ms !== null ? 'KILL' : sniffReading(b.lo_median!, b.hi_median!);
  return { outcome, gradedUnrounded: false, gradedOn: null };
}

/** No reading: no sniff found, or no hi median without L_rt (spec 9.6 "the rest", assumption). */
const NOT_GRADED: Pick<SniffRow, 'outcome' | 'gradedUnrounded' | 'gradedOn'> = { outcome: 'BETWEEN', gradedUnrounded: false, gradedOn: null };

/** Plain words on a recount whose block differs from calib.json's. */
function mismatchText(recounted: CalibSniffLagBlock, block: CalibSniffLagBlock): string {
  return `the recount of the sniff lag gives ${blockText(recounted)}, but calib.json holds ${blockText(block)}: row 4 is graded on calib.json as the clocks step wrote it, to 0.1 ms (PREREG §4)`;
}

/**
 * Row 4. calib.json sniff_lag_ms is what the clocks step measured: n, the found sniffs whose
 * trace never arrived beside it (PREREG §4), the medians to 0.1 ms and the bound of medians that
 * fall on such sniffs. Whenever calib.json has this block, its numbers go into verdict.json as
 * they are, and row 4 is graded on it, also when it gives no reading. The recount (made as clocks
 * makes it, on the same files) only checks the block: when its block equals calib.json's, a
 * graded outcome comes from its unrounded medians (spec 9.6: 150.04 ms is above 150); when it
 * differs, the outcome comes from calib.json as written, and `mismatch` says so. A found sniff
 * whose trace never arrived ranks above every measured value (PREREG §4): when the medians fall
 * on such sniffs, as when none arrived, row 4 reads KILL and calib.json holds null medians over
 * median_over_ms. Only when calib.json has no sniff block does the recount stand in for it. No
 * sniff found at all, or a hi median missing without L_rt, reads BETWEEN (spec 9.6 "the rest",
 * assumption); quickcheck conditions 2 and 8 refuse such a recording first, so only an
 * exploratory run gets there.
 */
export function sniffRow(a: SniffRowInput): SniffRow {
  const lag = a.recount?.lag ?? null;
  const block = calibSniffBlockOf(a.calib);
  const delays = a.rule ? ruleDelaysMs(a.recount?.onsets ?? [], a.packets, a.rule).filter((d): d is number => d !== null) : [];
  const described = { bestCaseMs: round1OrNull(lag?.bestCaseMedianMs ?? null), d1OnSniffsMs: round1OrNull(median(delays)) };
  const readable = lag !== null && lag.reading !== null ? (lag as SniffLag & { reading: GateOutcome }) : null;
  const recounted = lag === null ? null : calibSniffLagBlock(lag);

  if (block !== null) {
    const agrees = recounted !== null && sameBlock(recounted, block);
    // Without L_rt the recount has no reading; a graded block it agrees with is then one over a bound: KILL.
    const grading = !graded(block) ? NOT_GRADED : agrees && readable !== null ? gradingOf(readable) : blockGrading(block);
    return {
      ...numbersOf(block),
      ...grading,
      ...described,
      source: 'calib.json',
      recount: recounted === null ? 'none' : agrees ? 'agrees' : 'differs',
      mismatch: recounted === null || agrees ? null : mismatchText(recounted, block),
    };
  }
  if (recounted !== null) {
    // calib.json has no sniff block: the recount stands in for it.
    const grading = !graded(recounted) ? NOT_GRADED : readable !== null ? gradingOf(readable) : blockGrading(recounted);
    return { ...numbersOf(recounted), ...grading, ...described, source: 'recomputed', recount: 'none', mismatch: null };
  }
  return { ...NOT_GRADED, loMedianMs: null, hiMedianMs: null, overMs: null, n: 0, noArrival: 0, ...described, source: 'none', recount: 'none', mismatch: null };
}
