// Loop check: L_rt from the clicks, and the A/B rule (spec 6.3, 7.12, 8.1).

import { CLICK_COUNT, CLICK_SAMPLES } from './clicks.ts';
import {
  LRT_BOTH_MAX_MS,
  LRT_MEAN_MAX_MS,
  QUANTUM_SAMPLES,
  SAMPLE_RATE_HZ,
  THRESHOLD_TOLERANCE_MS,
} from './constants.ts';
import { median, round1 } from './stats.ts';
import type { CalibLrt } from './types.ts';

/** Lag search range: 0-100 ms (spec 6.3). */
export const LOOP_MAX_LAG_MS = 100;
/** A click is found when its correlation peak stands this far above the correlation noise. */
export const LOOP_MIN_PEAK_TO_NOISE = 10;
/**
 * A loop check gives L_rt only when all 10 of its clicks are found: L_rt is the median over the
 * 10 clicks (spec 6.3), and doctor's hard condition is that the clicks of both checks are found (7.12).
 */
export const LOOP_MIN_CLICKS_FOUND = CLICK_COUNT;
/** Lags this close to the peak are left out of the noise estimate (side lobes, earcup reflections). */
const PEAK_EXCLUSION_MS = 2;
/** Channel 1 is read from one quantum before the click stamp to one quantum after the click. */
const TEMPLATE_MARGIN_SAMPLES = QUANTUM_SAMPLES;

export interface LoopOptions {
  sampleRateHz?: number;
  maxLagMs?: number;
  minPeakToNoise?: number;
  minFound?: number;
}

export interface ClickLag {
  i: number;
  /** Click start in channel 1, as an index into the arrays. */
  startSample: number;
  /** Delay of channel 0 behind channel 1, sub-sample (parabolic peak); null when not found. */
  lagSamples: number | null;
  lagMs: number | null;
  /** |peak| / (1.4826 * median |r|) away from the peak; 0 when not computable. */
  peakToNoise: number;
  found: boolean;
}

export interface LoopMeasurement {
  /** Median lag of the found clicks; null when fewer than minFound (default all 10) were found. */
  L_rt_ms: number | null;
  /** Largest minus smallest lag of the found clicks (assumption); null with L_rt_ms. */
  spread_ms: number | null;
  found: number;
  total: number;
  clicks: ClickLag[];
}

type Lag = Omit<ClickLag, 'i' | 'startSample'>;

const NOT_FOUND: Lag = { lagSamples: null, lagMs: null, peakToNoise: 0, found: false };

/**
 * Lag of one click: cross-correlation of channel 0 against the click in channel 1 over lags
 * 0..maxLag. Not found when the template is empty, the search runs off the recording, the
 * peak sits on the edge of the range, or the peak-to-noise ratio is below the threshold.
 * Polarity is free: an inverted path gives a negative peak at the same lag.
 */
export function measureClickLag(
  ch0: Float32Array,
  ch1: Float32Array,
  startSample: number,
  opts: LoopOptions = {},
): Lag {
  const rate = opts.sampleRateHz ?? SAMPLE_RATE_HZ;
  const maxLag = Math.round(((opts.maxLagMs ?? LOOP_MAX_LAG_MS) * rate) / 1000);
  const minPnr = opts.minPeakToNoise ?? LOOP_MIN_PEAK_TO_NOISE;
  if (!Number.isFinite(startSample)) return NOT_FOUND;

  // Template: channel 1 around the click, trimmed to its non-zero part.
  const s0 = Math.floor(startSample);
  let a = Math.max(0, s0 - TEMPLATE_MARGIN_SAMPLES);
  let b = Math.min(ch1.length, s0 + CLICK_SAMPLES + TEMPLATE_MARGIN_SAMPLES);
  while (a < b && ch1[a] === 0) a++;
  while (b > a && ch1[b - 1] === 0) b--;
  const m = b - a;
  if (m <= 0) return NOT_FOUND;
  const lagCount = Math.min(maxLag, ch0.length - m - a) + 1;
  if (lagCount < 3) return NOT_FOUND;

  let mean = 0;
  for (let i = 0; i < m; i++) mean += ch1[a + i]!;
  mean /= m;
  const t = new Float64Array(m);
  for (let i = 0; i < m; i++) t[i] = ch1[a + i]! - mean;

  const r = new Float64Array(lagCount);
  let best = 0;
  for (let tau = 0; tau < lagCount; tau++) {
    let s = 0;
    const base = a + tau;
    for (let i = 0; i < m; i++) s += t[i]! * ch0[base + i]!;
    r[tau] = s;
    if (Math.abs(s) > Math.abs(r[best]!)) best = tau;
  }

  const exclusion = Math.round((PEAK_EXCLUSION_MS * rate) / 1000);
  const away: number[] = [];
  for (let tau = 0; tau < lagCount; tau++) {
    if (Math.abs(tau - best) > exclusion) away.push(Math.abs(r[tau]!));
  }
  const peak = Math.abs(r[best]!);
  const noise = 1.4826 * (median(away) ?? 0);
  const peakToNoise = noise > 0 ? peak / noise : peak > 0 ? Number.POSITIVE_INFINITY : 0;
  if (best === 0 || best === lagCount - 1 || !(peakToNoise >= minPnr)) {
    return { ...NOT_FOUND, peakToNoise };
  }

  // Parabolic interpolation on the signed peak.
  const sign = r[best]! >= 0 ? 1 : -1;
  const y0 = sign * r[best - 1]!;
  const y1 = sign * r[best]!;
  const y2 = sign * r[best + 1]!;
  const den = y0 - 2 * y1 + y2;
  const delta = den < 0 ? Math.min(0.5, Math.max(-0.5, (0.5 * (y0 - y2)) / den)) : 0;
  const lagSamples = best + delta;
  return { lagSamples, lagMs: (lagSamples * 1000) / rate, peakToNoise, found: true };
}

/**
 * L_rt of one loop check: per-click lag of channel 0 behind channel 1, the median over the
 * found clicks, and how many were found (spec 6.3). `clickStartSamples` index the arrays;
 * a non-finite entry (for example a click inside a recording gap) counts as not found.
 */
export function measureLoopLatency(
  ch0: Float32Array,
  ch1: Float32Array,
  clickStartSamples: readonly number[],
  opts: LoopOptions = {},
): LoopMeasurement {
  const clicks: ClickLag[] = clickStartSamples.map((startSample, i) => ({
    i,
    startSample,
    ...measureClickLag(ch0, ch1, startSample, opts),
  }));
  const lags = clicks.filter((c) => c.found).map((c) => c.lagMs!);
  const enough = lags.length > 0 && lags.length >= (opts.minFound ?? LOOP_MIN_CLICKS_FOUND);
  return {
    L_rt_ms: enough ? median(lags) : null,
    spread_ms: enough ? Math.max(...lags) - Math.min(...lags) : null,
    found: lags.length,
    total: clicks.length,
    clicks,
  };
}

export interface LrtThresholds {
  meanMaxMs?: number;
  bothMaxMs?: number;
}

/** The parts of a loop measurement the rule reads; a plain {L_rt_ms, spread_ms} also works. */
export type LoopSummary = Pick<LoopMeasurement, 'L_rt_ms' | 'spread_ms'>;

/**
 * Spec 6.3 table for blocks A and B, as calib.json `L_rt_ms`. The rule judges the measured
 * difference |A - B|; A, B, the spreads and the mean used are printed rounded to 0.1 ms (spec
 * 8.1), so printed values may differ by up to 0.1 ms from the difference judged. A missing
 * block gives `void`.
 */
export function loopRule(
  A: LoopSummary | null | undefined,
  B: LoopSummary | null | undefined,
  thresholds: LrtThresholds = {},
): CalibLrt {
  const a = A?.L_rt_ms ?? null;
  const b = B?.L_rt_ms ?? null;
  const printed = {
    A: a === null ? null : round1(a),
    B: b === null ? null : round1(b),
    spread: [
      A?.spread_ms == null ? null : round1(A.spread_ms),
      B?.spread_ms == null ? null : round1(B.spread_ms),
    ] as [number | null, number | null],
  };
  if (a === null || b === null) return { ...printed, rule: 'void', used: null };
  const diff = Math.abs(a - b);
  if (diff <= (thresholds.meanMaxMs ?? LRT_MEAN_MAX_MS) + THRESHOLD_TOLERANCE_MS) {
    return { ...printed, rule: 'mean', used: round1((a + b) / 2) };
  }
  if (diff <= (thresholds.bothMaxMs ?? LRT_BOTH_MAX_MS) + THRESHOLD_TOLERANCE_MS) {
    return { ...printed, rule: 'both', used: null };
  }
  return { ...printed, rule: 'void', used: null };
}

/**
 * The L_rt values every lead must be computed with: [used] under `mean`, [A, B] under `both`
 * (a stop counts as before the voice only when it does so with each), none under `void`.
 */
export function lrtValuesMs(lrt: CalibLrt): number[] {
  if (lrt.rule === 'mean' && lrt.used !== null) return [lrt.used];
  if (lrt.rule === 'both' && lrt.A !== null && lrt.B !== null) return [lrt.A, lrt.B];
  return [];
}
