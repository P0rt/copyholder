// The run of one camera-time stream (spec 7.1: SDK times are µs, number or Long). A stray
// timestamp such as 0 or -1 (a protobuf default or a sentinel) must not stretch a 1 s rate
// window over decades: each stream keeps the timestamps that fall within its own run, judged
// against tap's clock, and the report counts the rest as a surprise (spec 7.12 questions 4, 5).

import { median, quantile } from '../../core/stats/index.ts';

/** Slack beyond the first and last arrival, µs: a backlog at the start or a late batch (assumption). */
export const SPAN_MARGIN_US = 30_000_000;
/** Camera µs per µs of tap's clock taken as the same unit: drift is ppm, this only catches ms or ns. */
export const SAME_UNIT_RATE: readonly [number, number] = [0.9, 1.1];
/** Without usable arrival times: the quartiles widened by this many interquartile ranges. */
export const QUARTILE_FENCE = 3;
/** Arrivals must cover at least this much of tap's clock to estimate the clock rate, ns. */
const MIN_RATE_SPAN_NS = 1e9;
const EXAMPLES = 3;

/** One camera timestamp with the arrival of the line that carried it. */
export interface TimedStamp {
  tsUs: number;
  /** Arrival on tap's clock, ns from the run's earliest tArrNs; null when unknown. */
  relNs: number | null;
}

export interface StreamSpan {
  /** Unique timestamps inside the run, ascending. */
  kept: number[];
  keptSet: ReadonlySet<number>;
  /** Unique timestamps outside the run. */
  outside: number;
  /** Up to three of them, ascending. */
  examples: number[];
  startUs: number | null;
  endUs: number | null;
  /** 'arrival': tap's clock; 'quartiles': the fence without usable arrivals; 'empty': no timestamp. */
  method: 'arrival' | 'quartiles' | 'empty';
  /** Camera µs per µs of tap's clock (1 when the timestamps are µs); null with too few arrivals. */
  clockRate: number | null;
  /** Median timestamp minus arrival, µs: the camera clock against tap's, less the latency. */
  offsetUs: number | null;
}

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/**
 * Camera µs per µs of tap's clock: medians of the last third against the first third of the
 * stream in arrival order (robust to a few stray values). Null under 1 s of arrivals.
 */
export function clockRateOf(items: readonly { tsUs: number; relNs: number }[]): number | null {
  const sorted = [...items].sort((a, b) => a.relNs - b.relNs);
  const k = Math.floor(sorted.length / 3);
  if (k < 1) return null;
  const first = sorted.slice(0, k);
  const last = sorted.slice(sorted.length - k);
  const relA = median(first.map((p) => p.relNs))!;
  const relB = median(last.map((p) => p.relNs))!;
  if (!(relB - relA >= MIN_RATE_SPAN_NS)) return null;
  const tsA = median(first.map((p) => p.tsUs))!;
  const tsB = median(last.map((p) => p.tsUs))!;
  return (tsB - tsA) / ((relB - relA) / 1000);
}

/**
 * The run of a stream. With arrivals on tap's clock and µs timestamps: from the first arrival to
 * the last, shifted by the median offset of timestamp minus arrival, plus SPAN_MARGIN_US on each
 * side. Otherwise the quartile fence. Non-finite timestamps are dropped before.
 */
export function streamSpan(items: readonly TimedStamp[]): StreamSpan {
  const valid = items.filter((p) => isNum(p.tsUs));
  const unique = [...new Set(valid.map((p) => p.tsUs))].sort((a, b) => a - b);
  if (unique.length === 0) {
    return { kept: [], keptSet: new Set(), outside: 0, examples: [], startUs: null, endUs: null, method: 'empty', clockRate: null, offsetUs: null };
  }
  const timed = valid.filter((p): p is { tsUs: number; relNs: number } => isNum(p.relNs));
  const clockRate = clockRateOf(timed);
  const offsetUs = timed.length > 0 ? median(timed.map((p) => p.tsUs - p.relNs / 1000)) : null;
  let startUs: number;
  let endUs: number;
  let method: StreamSpan['method'];
  const sameUnit = clockRate === null || (clockRate >= SAME_UNIT_RATE[0] && clockRate <= SAME_UNIT_RATE[1]);
  if (offsetUs !== null && sameUnit) {
    let minRel = Number.POSITIVE_INFINITY;
    let maxRel = Number.NEGATIVE_INFINITY;
    for (const p of timed) {
      if (p.relNs < minRel) minRel = p.relNs;
      if (p.relNs > maxRel) maxRel = p.relNs;
    }
    startUs = offsetUs + minRel / 1000 - SPAN_MARGIN_US;
    endUs = offsetUs + maxRel / 1000 + SPAN_MARGIN_US;
    method = 'arrival';
  } else {
    const q1 = quantile(unique, 0.25)!;
    const q3 = quantile(unique, 0.75)!;
    startUs = q1 - QUARTILE_FENCE * (q3 - q1);
    endUs = q3 + QUARTILE_FENCE * (q3 - q1);
    method = 'quartiles';
  }
  const kept = unique.filter((t) => t >= startUs && t <= endUs);
  const outsideList = unique.filter((t) => t < startUs || t > endUs);
  return {
    kept,
    keptSet: new Set(kept),
    outside: outsideList.length,
    examples: outsideList.slice(0, EXAMPLES),
    startUs,
    endUs,
    method,
    clockRate,
    offsetUs,
  };
}
