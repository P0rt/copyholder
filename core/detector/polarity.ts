// Sign s of the chest trace from the three cued deep breaths (spec 7.4, 9.4 condition 9, 10.4).
// The method and the margin are assumptions of the spec ("Способ счёта и запас это допущения").

import { median } from './math.ts';
import { POLARITY_BREATHS, POLARITY_MARGIN_RATIO, POLARITY_WINDOW_MS } from './params.ts';
import type { Sign, TracePair } from './types.ts';

/** One inhale cue (2 s in the scenario), on the same clock as the samples, microseconds. */
export interface CueWindow {
  startUs: number;
  endUs: number;
}

export interface PolarityResult {
  /** +1 when the inhale raises the trace, -1 when it lowers it; null when the breaths disagree. */
  sign: Sign | null;
  /** Per cue: median around the end of the inhale cue minus median around its start. */
  d: number[];
  /** Exactly three finite d of one sign. */
  agree: boolean;
  /** The smallest |d| is at least a third of the largest (all d finite). */
  margin: boolean;
}

function medianAround(samples: readonly TracePair[], centerUs: number, halfUs: number): number {
  const vals: number[] = [];
  for (const [t, v] of samples) {
    if (t >= centerUs - halfUs && t <= centerUs + halfUs && Number.isFinite(v)) vals.push(v);
  }
  return vals.length > 0 ? median(vals) : Number.NaN;
}

/**
 * d = median of the trace over 0.5 s around the end of the inhale cue minus the median over
 * 0.5 s around its start, for each cue. The sign is defined when all three d agree (spec 7.4).
 * Samples and windows must share one clock; the caller maps cue marks onto it.
 */
export function polaritySign(
  samples: readonly TracePair[],
  cueWindows: readonly CueWindow[],
  windowMs: number = POLARITY_WINDOW_MS,
): PolarityResult {
  const halfUs = (windowMs * 1000) / 2;
  const d = cueWindows.map((w) => medianAround(samples, w.endUs, halfUs) - medianAround(samples, w.startUs, halfUs));
  const finite = d.length > 0 && d.every((x) => Number.isFinite(x));
  const agree = finite && d.length === POLARITY_BREATHS && (d.every((x) => x > 0) || d.every((x) => x < 0));
  const abs = d.map((x) => Math.abs(x));
  const margin = finite && Math.min(...abs) >= POLARITY_MARGIN_RATIO * Math.max(...abs);
  return { sign: agree ? (d[0]! > 0 ? 1 : -1) : null, d, agree, margin };
}
