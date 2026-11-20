// The statistics of PREREG.md section 11 that core/stats does not give in one call: the
// two-sided Poisson interval of the false-hold rate, the larger of the two chance estimates
// (estimate 3 of section 9.2 is not computed for gate packs), and the circle on which one gate
// pack's objections are shifted (section 9.2 item 2, "within the two objection blocks").
// Pure: no I/O.

import {
  SHIFT_CUT_BEFORE_ONSET_MS,
  binomialTestGreaterPValue,
  circularShiftChanceLevel,
  poissonChanceLevel,
  poissonMeanLowerBound,
  poissonMeanUpperBound,
  type CircularShiftResult,
  type IntervalMs,
  type PoissonChanceLevel,
  type ShiftSession,
  type ShiftTimelineInput,
} from '../../core/stats/index.ts';
import type { SpanSamples } from '../rivals/index.ts';
import { W_MS, nToMs } from '../gate/common.ts';
import { ALPHA, CONFIDENCE, SHIFT_COUNT, SHIFT_SEED } from './common.ts';

// ---- false holds: rate and its two-sided interval (PREREG §11) --------------------------

export interface RateInterval {
  /** Events per minute of exposure; null without exposure. */
  perMin: number | null;
  /** Exact two-sided interval (Garwood), per minute; null without exposure. */
  low: number | null;
  high: number | null;
  confidence: number;
}

/**
 * A Poisson rate with its exact two-sided interval: each bound is the one-sided exact bound at
 * 1 - (1 - confidence) / 2, from the chi-square quantiles core/stats uses for the one-sided
 * bound of the chance level (section 9.2). 10 events in 10 minutes give 0.48 to 1.84 per minute.
 */
export function poissonRateInterval(count: number, minutes: number, confidence: number = CONFIDENCE): RateInterval {
  if (!(minutes > 0)) return { perMin: null, low: null, high: null, confidence };
  const side = 1 - (1 - confidence) / 2;
  return {
    perMin: count / minutes,
    low: poissonMeanLowerBound(count, side) / minutes,
    high: poissonMeanUpperBound(count, side) / minutes,
    confidence,
  };
}

// ---- the chance level of H1 (PREREG §9.2, §11) -------------------------------------------

/** Estimate 1: the Poisson formula fed with the one-sided 95% upper bound of the false-hold rate; null without active time. */
export function poissonEstimate(falseHolds: number, activeMinutes: number): PoissonChanceLevel | null {
  return activeMinutes > 0 ? poissonChanceLevel(falseHolds, activeMinutes, W_MS, CONFIDENCE) : null;
}

export interface ShiftEstimate extends CircularShiftResult {
  /** Circumference summed over the packs whose objections were shifted, minutes. */
  circleMinutes: number;
  /** Packs left out: valid objections but no active time to shift them along. */
  leftOut: string[];
}

/**
 * Estimate 2: circular shifts within the objection blocks, one shift per pack and round, the
 * share pooled over the packs per round, its mean over the rounds (section 9.2 item 2). A pack
 * with objections but no active time cannot be shifted: it is left out and named. Null when no
 * objection is left to shift.
 */
export function shiftEstimate(packs: readonly { name: string; session: ShiftSession }[], o: { seed?: number; shifts?: number } = {}): ShiftEstimate | null {
  const leftOut = packs.filter((p) => p.session.onsetsMs.length > 0 && p.session.lengthMs === 0).map((p) => p.name);
  const kept = packs.filter((p) => p.session.onsetsMs.length > 0 && p.session.lengthMs > 0).map((p) => p.session);
  if (kept.length === 0) return null;
  const r = circularShiftChanceLevel(kept, { seed: o.seed ?? SHIFT_SEED, shifts: o.shifts ?? SHIFT_COUNT, windowMs: W_MS });
  if (r.share === null) return null;
  const circleMinutes = kept.reduce((sum, s) => sum + s.lengthMs, 0) / 60_000;
  return { ...r, circleMinutes, leftOut };
}

export interface ChanceChoice {
  p0: number;
  source: 'poisson' | 'shift';
}

/**
 * The larger of the two estimates of section 11 (Poisson and circular shifts); a tie goes to
 * the earlier one in section 9.2 order, as core/stats largestChanceLevel breaks ties. Both must
 * exist: taking the larger of one would quietly change the rule, so the test is then not run.
 */
export function largerChanceLevel(poisson: number | null, shift: number | null): ChanceChoice | null {
  if (poisson === null || shift === null) return null;
  return shift > poisson ? { p0: shift, source: 'shift' } : { p0: poisson, source: 'poisson' };
}

export interface BinomialTest {
  k: number;
  n: number;
  p0: number;
  /** P(X >= k), X ~ Binomial(n, p0): the exact one-sided test of H1 (section 9.1). */
  pValue: number;
  alpha: number;
  belowAlpha: boolean;
}

export function h1Test(k: number, n: number, p0: number): BinomialTest {
  const pValue = binomialTestGreaterPValue(k, n, p0);
  return { k, n, p0, pValue, alpha: ALPHA, belowAlpha: pValue <= ALPHA };
}

// ---- the circle of one pack (section 9.2 item 2) ------------------------------------------

/**
 * The end of the post-voice period after an utterance that ends at nEnd, on the sample scale.
 * The trace detector is inactive from the voice through its post-voice period (section 6.1), so
 * the period ends where the detector is next active (its armed spans); a detector already active
 * at nEnd never saw the voice and has no such period. Inactive time after the true end is not on
 * the circle either, so the circle is the same (assumption: the detector's own state marks the
 * end). Without a later active span the period runs to blockEndN.
 */
export function postVoiceEndN(spans: readonly SpanSamples[], nEnd: number, blockEndN: number): number {
  const sorted = [...spans].sort((a, b) => a.n0 - b.n0);
  if (sorted.some((s) => s.n0 <= nEnd && nEnd < s.n1)) return nEnd;
  const next = sorted.find((s) => s.n0 > nEnd);
  return Math.max(nEnd, next === undefined ? blockEndN : next.n0);
}

export interface PackCircleInput {
  /** The trace detector's active spans over the whole recording (samples). */
  spans: readonly SpanSamples[];
  /** The objection block (samples). */
  block: SpanSamples;
  /** Stops t_s of the block's fires, on the microphone scale (samples). */
  stopsN: readonly number[];
  /** Every objection of the block: its voice onset and the last sample of the utterance. */
  objections: readonly { nV: number; nEnd: number }[];
  /** Voice onsets of the valid objections: the ones shifted (samples). */
  onsetsN: readonly number[];
}

/**
 * The time line of one pack for the circular shifts, in ms: the detector's active time inside
 * the objection block, with every objection cut out from 3 s before its voice onset to the end
 * of its post-voice period (section 9.2 item 2, assumption there); stops inside a cut belong to
 * an objection and leave the circle (core/stats buildShiftSession).
 */
export function packCircleInput(c: PackCircleInput): ShiftTimelineInput {
  const activeMs: IntervalMs[] = [];
  for (const s of c.spans) {
    const n0 = Math.max(s.n0, c.block.n0);
    const n1 = Math.min(s.n1, c.block.n1);
    if (n1 > n0) activeMs.push({ startMs: nToMs(n0), endMs: nToMs(n1) });
  }
  const cutMs: IntervalMs[] = c.objections.map((o) => ({
    startMs: nToMs(o.nV) - SHIFT_CUT_BEFORE_ONSET_MS,
    endMs: Math.max(nToMs(o.nV) - SHIFT_CUT_BEFORE_ONSET_MS, nToMs(postVoiceEndN(c.spans, o.nEnd, c.block.n1))),
  }));
  return { activeMs, cutMs, stopsMs: c.stopsN.map(nToMs), onsetsMs: c.onsetsN.map(nToMs) };
}
