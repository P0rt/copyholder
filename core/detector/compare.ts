// Paired comparison of two detectors' stops on one objection (spec 4.4 H3/H4, 7.5, 7.10, 9.6 row 5):
// window t_v - W .. t_v + 0.5 s; the stop earlier by at least 33 ms wins; no stop loses; else a tie.

import { SAMPLE_RATE_HZ } from './params.ts';

/** W = H = 1.5 s before the voice onset (spec 4.2). */
export const COMPARE_BEFORE_MS = 1_500;
/** Up to 0.5 s after the voice onset (spec 4.4, 7.5). */
export const COMPARE_AFTER_MS = 500;
/** A win needs a lead of at least 33 ms (spec 4.4, 9.6). */
export const COMPARE_MIN_LEAD_MS = 33;

export type PairOutcome = 'win' | 'loss' | 'tie';

export interface CompareOptions {
  beforeMs?: number;
  afterMs?: number;
  minLeadMs?: number;
  sampleRateHz?: number;
}

/** Stop time t_s on the microphone scale, in samples: nSilent + L_rt (spec 6.3). */
export function stopOnMicScale(nSilent: number, lRtMs: number, sampleRateHz: number = SAMPLE_RATE_HZ): number {
  return nSilent + (lRtMs * sampleRateHz) / 1000;
}

/** Earliest stop (mic scale, samples) inside [n_v - W, n_v + 0.5 s], or null. */
export function firstStopInWindow(stops: readonly number[], nV: number, opts: CompareOptions = {}): number | null {
  const rate = opts.sampleRateHz ?? SAMPLE_RATE_HZ;
  const lo = nV - ((opts.beforeMs ?? COMPARE_BEFORE_MS) * rate) / 1000;
  const hi = nV + ((opts.afterMs ?? COMPARE_AFTER_MS) * rate) / 1000;
  let best: number | null = null;
  for (const t of stops) {
    if (t >= lo && t <= hi && (best === null || t < best)) best = t;
  }
  return best;
}

/** Outcome for A against B; arguments are stop times in the window (mic scale, samples) or null. */
export function comparePairedStops(a: number | null, b: number | null, opts: CompareOptions = {}): PairOutcome {
  if (a === null && b === null) return 'tie';
  if (a === null) return 'loss';
  if (b === null) return 'win';
  const minLead = ((opts.minLeadMs ?? COMPARE_MIN_LEAD_MS) * (opts.sampleRateHz ?? SAMPLE_RATE_HZ)) / 1000;
  const lead = b - a;
  if (lead >= minLead) return 'win';
  if (-lead >= minLead) return 'loss';
  return 'tie';
}

export interface PairInput {
  /** Voice onset n_v, channel 0 sample (spec 4.2). */
  nV: number;
  /** Sound path delay L_rt, ms (spec 6.3); the same for both detectors. */
  lRtMs: number;
  /** nSilent of every stop of A and of B (live or post-hoc). */
  nSilentA: readonly number[];
  nSilentB: readonly number[];
}

export interface PairResult {
  /** Stop of A in the window, mic scale samples, or null. */
  a: number | null;
  b: number | null;
  outcome: PairOutcome;
  /** How much earlier A stopped than B, ms; null unless both stopped in the window. */
  leadOfAms: number | null;
}

/** One paired comparison on one objection, from A's side. */
export function comparePair(input: PairInput, opts: CompareOptions = {}): PairResult {
  const rate = opts.sampleRateHz ?? SAMPLE_RATE_HZ;
  const onMic = (n: number): number => stopOnMicScale(n, input.lRtMs, rate);
  const a = firstStopInWindow(input.nSilentA.map(onMic), input.nV, opts);
  const b = firstStopInWindow(input.nSilentB.map(onMic), input.nV, opts);
  return {
    a,
    b,
    outcome: comparePairedStops(a, b, opts),
    leadOfAms: a !== null && b !== null ? ((b - a) * 1000) / rate : null,
  };
}
