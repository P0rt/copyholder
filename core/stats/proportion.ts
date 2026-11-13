// Shares with a Wilson score interval (spec 4.4: "Доли приводятся с интервалом Уилсона 95%";
// spec 7.10, row "Доли"). Control value, spec 13.4: 8 of 14 gives 33-79%.

import { normalQuantile } from './special.ts';
import { assertCount, assertOpenUnit } from './validate.ts';

export interface ProportionInterval {
  successes: number;
  trials: number;
  /** successes / trials; null when trials = 0 (no share exists). */
  estimate: number | null;
  /** Lower bound in [0, 1]. */
  low: number;
  /** Upper bound in [0, 1]. */
  high: number;
  /** Two-sided confidence level, e.g. 0.95. */
  confidence: number;
}

/**
 * Two-sided Wilson score interval for a binomial proportion.
 * With 0 trials there is no estimate (null) and the interval is the whole of [0, 1],
 * the limit of the Wilson formula as n goes to 0.
 */
export function wilsonInterval(successes: number, trials: number, confidence = 0.95): ProportionInterval {
  assertCount(successes, 'successes');
  assertCount(trials, 'trials');
  if (successes > trials) throw new RangeError(`successes (${successes}) > trials (${trials})`);
  assertOpenUnit(confidence, 'confidence');
  if (trials === 0) {
    return { successes, trials, estimate: null, low: 0, high: 1, confidence };
  }
  // z from the lower tail: 0.5 + c / 2 rounds to 1 (z = Infinity, NaN bounds) for c near 1,
  // while (1 - c) / 2 stays positive for every c < 1, so z is always finite.
  const z = -normalQuantile((1 - confidence) / 2);
  const z2 = z * z;
  const n = trials;
  const p = successes / n;
  const denom = 1 + z2 / n;
  const center = (p + z2 / (2 * n)) / denom;
  const half = (z / denom) * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n));
  const low = successes === 0 ? 0 : Math.max(0, Math.min(p, center - half));
  const high = successes === trials ? 1 : Math.min(1, Math.max(p, center + half));
  return { successes, trials, estimate: p, low, high, confidence };
}
