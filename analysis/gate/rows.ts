// The five rows of spec 9.6, pure. Outcomes are read off the printed values (0.1 ms, 0.1/min).

import { comparePairedStops } from '../../core/detector.ts';
import { GATE_HITS_THRESHOLDS, classifyCount, median } from '../../core/stats/index.ts';
import type { GateOutcome } from '../../core/schemas/index.ts';
import { AFTER_MS, SMALL_LEAD_MS, W_MS, isBeforeVoice, leadMs, msToN, nToMs, round1, stopOnMicN, type LrtUse } from './common.ts';
import type { RunStop } from './runs.ts';

/** One valid objection as the rows see it. */
export interface ObjectionPoint {
  cue: number;
  /** Voice onset n_v (automatic; manual for the sensitivity line). */
  nV: number;
  /** The window [t_v - W, t_v) lies in D1's active time by the rule of spec 4.3. */
  armed: boolean;
  /** An audible in-breath was found before the voice (spec 7.6). */
  breath: boolean;
}

/** Thresholds of rows 2, 3 and 5 (spec 9.6). */
export const ROW_LIMITS = {
  leadPassMs: 200,
  leadKillBelowMs: 100,
  falsePassPerMin: 2,
  falseKillAbovePerMin: 5,
  winMargin: 3,
  leadDiffPassMs: 100,
  leadDiffMinEvents: 5,
} as const;

/** Earliest stop before voice (t_v - W <= t_s < t_v under every L_rt value), or null. */
export function beforeVoiceStop(stops: readonly RunStop[], nV: number, lrt: LrtUse): RunStop | null {
  let best: RunStop | null = null;
  for (const s of stops) if (isBeforeVoice(s.nSilent, nV, lrt) && (best === null || s.nSilent < best.nSilent)) best = s;
  return best;
}

/** Earliest stop with t_s in [t_v - W, t_v + 0.5 s] (less favourable L_rt), as a mic-scale sample, or null. */
export function windowStopN(stops: readonly RunStop[], nV: number, lrt: LrtUse): number | null {
  const lo = nV - msToN(W_MS);
  const hi = nV + msToN(AFTER_MS);
  let best: number | null = null;
  for (const s of stops) {
    const t = stopOnMicN(s.nSilent, lrt.worstMs);
    if (t >= lo && t <= hi && (best === null || t < best)) best = t;
  }
  return best;
}

export interface HitsRow {
  hits: number;
  armedHits: number;
  valid: number;
  armed: number;
  /** Leads of the hits, ms (less favourable L_rt). */
  leadsMs: number[];
  leads0to50: number;
  outcome: GateOutcome;
}

/** Row 1: valid objections with a D1 stop before voice, absolute count (spec 9.6). */
export function hitsRow(points: readonly ObjectionPoint[], d1: readonly RunStop[], lrt: LrtUse): HitsRow {
  let hits = 0;
  let armedHits = 0;
  const leadsMs: number[] = [];
  for (const p of points) {
    const s = beforeVoiceStop(d1, p.nV, lrt);
    if (s === null) continue;
    hits++;
    if (p.armed) armedHits++;
    leadsMs.push(leadMs(s.nSilent, p.nV, lrt));
  }
  return {
    hits,
    armedHits,
    valid: points.length,
    armed: points.filter((p) => p.armed).length,
    leadsMs,
    leads0to50: leadsMs.filter((l) => round1(l) <= SMALL_LEAD_MS).length,
    outcome: classifyCount(hits, GATE_HITS_THRESHOLDS),
  };
}

export interface LeadRow {
  medianHitsMs: number | null;
  /** Median lead over every valid objection with a stop in [t_v - W, t_v + 0.5 s]. */
  medianAllStopsMs: number | null;
  outcome: GateOutcome;
}

/** Row 2 on a printed median: PASS >= 200 ms, BETWEEN 100-199, KILL < 100 or no hit (assumption). */
export function leadOutcome(medianMs: number | null): GateOutcome {
  if (medianMs === null) return 'KILL';
  const m = round1(medianMs);
  if (m >= ROW_LIMITS.leadPassMs) return 'PASS';
  if (m >= ROW_LIMITS.leadKillBelowMs) return 'BETWEEN';
  return 'KILL';
}

export function leadRow(points: readonly ObjectionPoint[], d1: readonly RunStop[], lrt: LrtUse, hits: HitsRow): LeadRow {
  const all: number[] = [];
  for (const p of points) {
    const t = windowStopN(d1, p.nV, lrt);
    if (t !== null) all.push(nToMs(p.nV - t));
  }
  const medianHitsMs = median(hits.leadsMs);
  return { medianHitsMs, medianAllStopsMs: median(all), outcome: leadOutcome(medianHitsMs) };
}

/**
 * A false stop (spec 4.2): no objection started within W after t_s. A late stop (t_v <= t_s <= t_v
 * + 0.5 s) is not false either. Under rule "both" the stop is false when it is for either value.
 */
export function isFalseStop(stop: RunStop, objectionStartsN: readonly number[], lrt: LrtUse): boolean {
  const w = msToN(W_MS);
  const late = msToN(AFTER_MS);
  return lrt.values.some((l) => {
    const t = stopOnMicN(stop.nSilent, l);
    // Before voice: t < t_v <= t + W; late: t - 0.5 s <= t_v <= t.
    return !objectionStartsN.some((nV) => nV >= t - late && nV <= t + w);
  });
}

export interface FalseRate {
  stops: number;
  falseStops: number;
  activeMinutes: number;
  /** Per active minute; null without active time. */
  perMin: number | null;
}

export function falseRate(stops: readonly RunStop[], objectionStartsN: readonly number[], lrt: LrtUse, activeMinutes: number): FalseRate {
  const falseStops = stops.filter((s) => isFalseStop(s, objectionStartsN, lrt)).length;
  return { stops: stops.length, falseStops, activeMinutes, perMin: activeMinutes > 0 ? falseStops / activeMinutes : null };
}

/** Row 3 on a printed rate: PASS <= 2/min, BETWEEN up to 5, KILL above; no active time is KILL (assumption). */
export function falseHoldsOutcome(perMin: number | null): GateOutcome {
  if (perMin === null) return 'KILL';
  const r = round1(perMin);
  if (r <= ROW_LIMITS.falsePassPerMin) return 'PASS';
  if (r <= ROW_LIMITS.falseKillAbovePerMin) return 'BETWEEN';
  return 'KILL';
}

export interface PairTally {
  /** Wins of the first detector (chest), losses = wins of the second (lips). */
  wins: number;
  losses: number;
  ties: number;
  /** Events where both stopped before voice. */
  bothBeforeN: number;
  /** Median of lead_first - lead_second over those events, ms. */
  leadDiffMedianMs: number | null;
}

/**
 * Paired comparison on each valid objection (spec 4.4, 9.6 row 5): window [t_v - W, t_v + 0.5 s];
 * the stop earlier by at least 33 ms wins, no stop loses, the rest are ties.
 */
export function pairTally(points: readonly ObjectionPoint[], first: readonly RunStop[], second: readonly RunStop[], lrt: LrtUse): PairTally {
  let wins = 0;
  let losses = 0;
  let ties = 0;
  const diffs: number[] = [];
  for (const p of points) {
    const a = windowStopN(first, p.nV, lrt);
    const b = windowStopN(second, p.nV, lrt);
    const o = comparePairedStops(a, b);
    if (o === 'win') wins++;
    else if (o === 'loss') losses++;
    else ties++;
    const sa = beforeVoiceStop(first, p.nV, lrt);
    const sb = beforeVoiceStop(second, p.nV, lrt);
    if (sa !== null && sb !== null) diffs.push(leadMs(sa.nSilent, p.nV, lrt) - leadMs(sb.nSilent, p.nV, lrt));
  }
  return { wins, losses, ties, bothBeforeN: diffs.length, leadDiffMedianMs: median(diffs) };
}

/** Row 5 (spec 9.6): KILL when lips win at least as often (checked first); PASS on a margin of 3 or a 100 ms median on >= 5 events. */
export function chestVsLipsOutcome(t: PairTally): GateOutcome {
  if (t.losses >= t.wins) return 'KILL';
  if (t.wins - t.losses >= ROW_LIMITS.winMargin) return 'PASS';
  if (t.bothBeforeN >= ROW_LIMITS.leadDiffMinEvents && t.leadDiffMedianMs !== null && round1(t.leadDiffMedianMs) >= ROW_LIMITS.leadDiffPassMs) return 'PASS';
  return 'BETWEEN';
}

/** Valid objections with a stop before voice: the hits of a rival (OTHER line). */
export function hitsOf(points: readonly ObjectionPoint[], stops: readonly RunStop[], lrt: LrtUse): number {
  return points.filter((p) => beforeVoiceStop(stops, p.nV, lrt) !== null).length;
}

/** MISSES: valid objections without a D1 stop before voice, by audible in-breath. */
export function missesOf(points: readonly ObjectionPoint[], d1: readonly RunStop[], lrt: LrtUse): { noInbreath: number; inbreathAudible: number } {
  let noInbreath = 0;
  let inbreathAudible = 0;
  for (const p of points) {
    if (beforeVoiceStop(d1, p.nV, lrt) !== null) continue;
    if (p.breath) inbreathAudible++;
    else noInbreath++;
  }
  return { noInbreath, inbreathAudible };
}
