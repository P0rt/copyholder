// Rivals A100, A250 and A500 (spec 7.5, 6.3): computed from the automatic voice onset n_v of
// each objection. Stop nSilent = n_v + delay * 48 + 384, so the lead is -(delay + 8 ms + L_rt).
// Each keeps its own 2.0 s post-fire period and waits for the end of the reply it stopped on.

import { RAMP_SAMPLES, REFRACTORY_MS, SAMPLE_RATE_HZ, msToSamples } from '../../core/detector.ts';

/** The three audio rules; A250 is the main one (spec 7.5). */
export const AUDIO_RULE_DELAYS_MS: readonly number[] = Object.freeze([100, 250, 500]);

export interface AudioRuleOnset {
  /** Automatic voice onset, channel 0 sample. */
  nV: number;
  /** Last sample of the reply, when known. */
  nEnd?: number | null;
}

export interface AudioRuleStop {
  nV: number;
  /** Sample where the rule holds: n_v + delay. */
  nFire: number;
  /** nFire + 384 (spec 6.3). */
  nSilent: number;
}

/** Stops of one audio rule over objections, in onset order (spec 7.5). */
export function audioRuleStops(onsets: readonly AudioRuleOnset[], delayMs: number): AudioRuleStop[] {
  const delay = msToSamples(delayMs);
  const refractory = msToSamples(REFRACTORY_MS);
  const out: AudioRuleStop[] = [];
  let busyUntil = Number.NEGATIVE_INFINITY;
  for (const o of [...onsets].sort((a, b) => a.nV - b.nV)) {
    const nFire = o.nV + delay;
    if (nFire < busyUntil) continue;
    out.push({ nV: o.nV, nFire, nSilent: nFire + RAMP_SAMPLES });
    // Own wait: the narrator waits for the end of the reply, and 2.0 s pass after the fire.
    busyUntil = Math.max(nFire + refractory, o.nEnd ?? nFire);
  }
  return out;
}

/** Lead of an audio rule, ms: -(delay + 8 ms + L_rt) (spec 7.5). */
export function audioRuleLeadMs(delayMs: number, lRtMs: number): number {
  return -(delayMs + (RAMP_SAMPLES * 1000) / SAMPLE_RATE_HZ + lRtMs);
}
