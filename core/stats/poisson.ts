// False-stop rates and the first chance-level estimate (spec 4.3, spec 7.10 row
// "Уровень случайных совпадений").
//
// Rate bound: exact (Garwood) one-sided Poisson bound from the chi-square quantile,
//   upper = chi2_{c}(2(x + 1)) / 2,  lower = chi2_{1-c}(2x) / 2  (0 when x = 0),
// computed here as gammaQuantile(c, x + 1) and gammaQuantile(1 - c, x).
// This is the method that gives the spec 13.4 control value: 32 false stops in
// 16 minutes -> upper bound 42.98 / 16 = 2.686 -> 2.7 per minute. A two-sided 95%
// bound would give 2.8, a normal approximation 2.6.

import { gammaQuantile } from './special.ts';
import { assertCount, assertFiniteNumber, assertOpenUnit } from './validate.ts';

/** W = H = 1.5 s, the window before voice onset (spec 4.2). */
export const CHANCE_WINDOW_MS = 1500;

function checkExposure(exposureMin: number): void {
  assertFiniteNumber(exposureMin, 'exposureMin');
  if (exposureMin <= 0) throw new RangeError(`exposureMin must be > 0, got ${exposureMin}`);
}

/** Exact one-sided upper confidence bound for a Poisson mean, given an observed count. */
export function poissonMeanUpperBound(count: number, confidence = 0.95): number {
  assertCount(count, 'count');
  assertOpenUnit(confidence, 'confidence');
  return gammaQuantile(confidence, count + 1);
}

/** Exact one-sided lower confidence bound for a Poisson mean; 0 when the count is 0. */
export function poissonMeanLowerBound(count: number, confidence = 0.95): number {
  assertCount(count, 'count');
  assertOpenUnit(confidence, 'confidence');
  if (count === 0) return 0;
  return gammaQuantile(1 - confidence, count);
}

/** Point estimate of a rate: events per minute of exposure. Throws on zero exposure. */
export function ratePerMin(count: number, exposureMin: number): number {
  assertCount(count, 'count');
  checkExposure(exposureMin);
  return count / exposureMin;
}

/** Exact one-sided upper bound of a Poisson rate, in events per minute (spec 4.3). */
export function poissonRateUpperBoundPerMin(count: number, exposureMin: number, confidence = 0.95): number {
  checkExposure(exposureMin);
  return poissonMeanUpperBound(count, confidence) / exposureMin;
}

/** Exact one-sided lower bound of a Poisson rate, in events per minute. */
export function poissonRateLowerBoundPerMin(count: number, exposureMin: number, confidence = 0.95): number {
  checkExposure(exposureMin);
  return poissonMeanLowerBound(count, confidence) / exposureMin;
}

/**
 * Chance that a random stream of false stops at `ratePerMinute` puts at least one stop
 * into a window of `windowMs` (spec 4.3): p0 = 1 - exp(-lambda * W / 60), lambda per minute,
 * W in seconds. Spec table: 1/min -> 2.5%, 2 -> 4.9%, 3 -> 7.2%, 5 -> 11.8% at W = 1.5 s.
 */
export function chanceLevelFromRatePerMin(ratePerMinute: number, windowMs = CHANCE_WINDOW_MS): number {
  assertFiniteNumber(ratePerMinute, 'ratePerMinute');
  assertFiniteNumber(windowMs, 'windowMs');
  if (ratePerMinute < 0) throw new RangeError(`ratePerMinute must be >= 0, got ${ratePerMinute}`);
  if (windowMs < 0) throw new RangeError(`windowMs must be >= 0, got ${windowMs}`);
  return -Math.expm1((-ratePerMinute * windowMs) / 60_000);
}

export interface PoissonChanceLevel {
  falseStops: number;
  activeMin: number;
  /** Observed rate, false stops per active minute. */
  ratePerMin: number;
  /** Exact one-sided upper bound of the rate at `confidence`. */
  rateUpperPerMin: number;
  /** First chance-level estimate, from the upper bound: 1 - exp(-upper * W / 60). */
  p0: number;
  confidence: number;
  windowMs: number;
}

/**
 * First chance-level estimate of spec 4.3: the Poisson formula fed with the exact
 * one-sided upper bound of the false-stop rate. Spec example: 32 false stops in
 * 16 active minutes -> 2.0 per minute, bound 2.7, p0 = 6.5%.
 */
export function poissonChanceLevel(
  falseStops: number,
  activeMin: number,
  windowMs = CHANCE_WINDOW_MS,
  confidence = 0.95,
): PoissonChanceLevel {
  const rate = ratePerMin(falseStops, activeMin);
  const upper = poissonRateUpperBoundPerMin(falseStops, activeMin, confidence);
  return {
    falseStops,
    activeMin,
    ratePerMin: rate,
    rateUpperPerMin: upper,
    p0: chanceLevelFromRatePerMin(upper, windowMs),
    confidence,
    windowMs,
  };
}
