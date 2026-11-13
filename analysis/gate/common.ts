// Shared constants, types and helpers of analyze:gate (spec 9.5-9.7).

import type { CalibLrt as ClockCalibLrt } from '../../core/clock/index.ts';
import { SAMPLE_RATE_HZ } from '../../core/detector.ts';
import type { CalibLrt, LrtRule } from '../../core/schemas/index.ts';

/** W = H = 1.5 s: the window before the voice onset, and the false-stop window (spec 4.2). */
export const W_MS = 1_500;
/** Paired comparisons count stops up to 0.5 s after the voice onset (spec 4.4, 9.6). */
export const AFTER_MS = 500;
/** A valid objection starts within 10 s after its cue (spec 9.6). */
export const VOICE_AFTER_CUE_MS = 10_000;
/** The trace must be usable 2 s before t_v (spec 4.5, 9.6). */
export const TRACE_BEFORE_MS = 2_000;
/** A gap over 100 ms between trace samples makes the trace unusable (spec 4.5). */
export const TRACE_GAP_MS = 100;
/** Leads up to 50 ms are counted but shown on their own line (spec 4.2). */
export const SMALL_LEAD_MS = 50;

export const RATE = SAMPLE_RATE_HZ;

/** A refusal: analyze:gate prints the message and exits 1 without writing anything. */
export class GateRefusal extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GateRefusal';
  }
}

/** The console tag of an exploratory run (spec 9.5: such a run marks every output). */
export function exploratoryTag(stage: 'A' | 'B', run: number, exploratory: boolean): string {
  return exploratory ? `EXPLORATORY stage ${stage} run ${run}: ` : '';
}

export function msToN(ms: number): number {
  return (ms * RATE) / 1000;
}

export function nToMs(n: number): number {
  return (n * 1000) / RATE;
}

/** Rounds to 0.1, the precision of report values in ms (spec 8.1). */
export function round1(x: number): number {
  return Math.round(x * 10) / 10;
}

export function round1OrNull(x: number | null): number | null {
  return x === null ? null : round1(x);
}

/**
 * L_rt values a stop must satisfy (spec 6.3): one value under rule "mean", both A and B under
 * rule "both"; leads, windows and comparisons use the less favourable (larger) one.
 */
export interface LrtUse {
  rule: LrtRule;
  /** Values the before-voice test must hold for. */
  values: number[];
  /** The less favourable value: leads, comparison windows, false stops. */
  worstMs: number;
  A: number | null;
  B: number | null;
  diffMs: number | null;
}

/** L_rt from calib.json; a refusal when the clock rule voids the leads or the values are missing. */
export function lrtUseFrom(l: CalibLrt | undefined): LrtUse {
  if (l === undefined) throw new GateRefusal('calib.json has no L_rt_ms: run `npm run clocks -- <id>` first (spec 9.5)');
  const A = typeof l.A === 'number' ? l.A : null;
  const B = typeof l.B === 'number' ? l.B : null;
  const diffMs = A !== null && B !== null ? round1(Math.abs(A - B)) : null;
  const rule = l.rule ?? null;
  if (rule === 'void' || rule === null) {
    throw new GateRefusal(`calib.json L_rt_ms rule is ${String(rule)}: the two loop checks differ by more than 15 ms, so no lead can be scored (spec 6.3)`);
  }
  if (rule === 'mean') {
    const used = typeof l.used === 'number' ? l.used : A !== null && B !== null ? (A + B) / 2 : (A ?? B);
    if (used === null) throw new GateRefusal('calib.json L_rt_ms has no value to use');
    return { rule, values: [used], worstMs: used, A, B, diffMs };
  }
  const values = [A, B].filter((v): v is number => v !== null);
  if (values.length === 0) throw new GateRefusal('calib.json L_rt_ms rule "both" without A and B');
  return { rule, values, worstMs: Math.max(...values), A, B, diffMs };
}

/** calib.json L_rt_ms with every field, as core/clock reads it (a missing rule reads void). */
export function coreLrtOf(l: CalibLrt): ClockCalibLrt {
  return { A: l.A ?? null, B: l.B ?? null, spread: l.spread ?? [null, null], rule: l.rule ?? 'void', used: l.used ?? null };
}

/** Stop time t_s on the microphone scale, samples: nSilent + L_rt (spec 4.2, 6.3). */
export function stopOnMicN(nSilent: number, lrtMs: number): number {
  return nSilent + msToN(lrtMs);
}

/** A stop before voice: t_v - W <= t_s < t_v, for every L_rt value of the rule (spec 4.2, 6.3). */
export function isBeforeVoice(nSilent: number, nV: number, lrt: Pick<LrtUse, 'values'>): boolean {
  const w = msToN(W_MS);
  return lrt.values.every((l) => {
    const ts = stopOnMicN(nSilent, l);
    return ts >= nV - w && ts < nV;
  });
}

/** Lead t_v - t_s in ms with the less favourable L_rt (spec 4.2, 9.6). */
export function leadMs(nSilent: number, nV: number, lrt: Pick<LrtUse, 'worstMs'>): number {
  return nToMs(nV - stopOnMicN(nSilent, lrt.worstMs));
}
