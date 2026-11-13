// Medians, quantiles, robust spread and the order-statistic interval of the median.
//
// The spec never says how to take the median of an even count or which percentile
// rule to use. Here (assumption): the median of an even count is the mean of the two
// middle values, and quantile(p) interpolates linearly between order statistics
// (Hyndman-Fan type 7, the R and NumPy default), so quantile(0.5) equals median().
// Empty input gives null, never NaN; a non-finite value throws.

import { binomialPmf } from './binomial.ts';
import { assertCount, assertOpenUnit, at, sortedFiniteCopy } from './validate.ts';

/** Scale of MAD to the normal standard deviation, as written in spec 7.4 and 7.6. */
export const MAD_TO_SIGMA = 1.4826;

/** Median of finite values already sorted ascending (not checked; use median() otherwise); null if empty. */
export function medianOfSorted(sorted: readonly number[]): number | null {
  const n = sorted.length;
  if (n === 0) return null;
  const mid = n >> 1;
  if (n % 2 === 1) return at(sorted, mid);
  return (at(sorted, mid - 1) + at(sorted, mid)) / 2;
}

/** Median; mean of the two middle values for an even count; null for no values. */
export function median(values: readonly number[]): number | null {
  return medianOfSorted(sortedFiniteCopy(values, 'values'));
}

/** Type 7 quantile of finite values already sorted ascending (not checked; use quantile() otherwise). */
export function quantileOfSorted(sorted: readonly number[], prob: number): number | null {
  if (typeof prob !== 'number' || Number.isNaN(prob) || prob < 0 || prob > 1) {
    throw new RangeError(`prob must be in [0, 1], got ${String(prob)}`);
  }
  const n = sorted.length;
  if (n === 0) return null;
  if (prob === 0.5) return medianOfSorted(sorted); // same rounding as median()
  const h = (n - 1) * prob;
  const lo = Math.floor(h);
  const hi = Math.min(lo + 1, n - 1);
  const frac = h - lo;
  const a = at(sorted, lo);
  if (frac === 0) return a;
  return a + frac * (at(sorted, hi) - a);
}

/** Quantile, type 7: quantile(values, 0.9) is the P90 of spec 6.3 and 7.12. */
export function quantile(values: readonly number[], prob: number): number | null {
  return quantileOfSorted(sortedFiniteCopy(values, 'values'), prob);
}

/** Median absolute deviation from the median (unscaled). */
export function medianAbsoluteDeviation(values: readonly number[]): number | null {
  const sorted = sortedFiniteCopy(values, 'values');
  const m = medianOfSorted(sorted);
  if (m === null) return null;
  return median(sorted.map((v) => Math.abs(v - m)));
}

/** Robust spread s = 1.4826 * MAD (spec 7.4 s_q, spec 7.6 s_N). */
export function robustSpread(values: readonly number[]): number | null {
  const mad = medianAbsoluteDeviation(values);
  return mad === null ? null : MAD_TO_SIGMA * mad;
}

export interface MedianRanks {
  /** 1-based rank of the lower bound, counted from the bottom. */
  lowerRank: number;
  /** 1-based rank of the upper bound, counted from the bottom (n - lowerRank + 1). */
  upperRank: number;
  /** Exact coverage 1 - 2 P(B <= lowerRank - 1), B ~ Binomial(n, 1/2). */
  coverage: number;
}

/**
 * Ranks of the order-statistic interval of the median (spec 7.10): the narrowest
 * symmetric pair [x_(r), x_(n-r+1)] whose exact coverage is at least `confidence`.
 * Null when no such pair exists: for 95% that is n <= 5 (spec 7.10 prints the range then).
 * Spec 7.10: with 14 leads the interval runs from the 3rd value from the bottom
 * to the 3rd from the top.
 */
export function medianIntervalRanks(n: number, confidence = 0.95): MedianRanks | null {
  assertCount(n, 'n');
  assertOpenUnit(confidence, 'confidence');
  const alphaHalf = (1 - confidence) / 2;
  let best: MedianRanks | null = null;
  let cdf = 0; // P(B <= r - 1)
  for (let r = 1; 2 * r <= n + 1; r++) {
    cdf += binomialPmf(r - 1, n, 0.5);
    if (cdf > alphaHalf) break;
    best = { lowerRank: r, upperRank: n - r + 1, coverage: 1 - 2 * cdf };
  }
  return best;
}

export interface MedianWithInterval {
  n: number;
  median: number;
  low: number;
  high: number;
  /**
   * 'order-statistics' when an interval with the asked coverage exists;
   * 'range' (min to max) when it does not, as spec 7.10 prescribes for n <= 5 at 95%.
   */
  kind: 'order-statistics' | 'range';
  lowerRank: number;
  upperRank: number;
  /** Exact coverage of [low, high] for a continuous distribution. */
  coverage: number;
  confidence: number;
}

/** Median with its order-statistic interval (spec 7.10, "Медиана опережения"); null for no values. */
export function medianWithInterval(values: readonly number[], confidence = 0.95): MedianWithInterval | null {
  assertOpenUnit(confidence, 'confidence');
  const sorted = sortedFiniteCopy(values, 'values');
  const n = sorted.length;
  const m = medianOfSorted(sorted);
  if (m === null) return null;
  const ranks = medianIntervalRanks(n, confidence);
  if (ranks === null) {
    return {
      n,
      median: m,
      low: at(sorted, 0),
      high: at(sorted, n - 1),
      kind: 'range',
      lowerRank: 1,
      upperRank: n,
      coverage: 1 - 2 * Math.pow(0.5, n),
      confidence,
    };
  }
  return {
    n,
    median: m,
    low: at(sorted, ranks.lowerRank - 1),
    high: at(sorted, ranks.upperRank - 1),
    kind: 'order-statistics',
    lowerRank: ranks.lowerRank,
    upperRank: ranks.upperRank,
    coverage: ranks.coverage,
    confidence,
  };
}
