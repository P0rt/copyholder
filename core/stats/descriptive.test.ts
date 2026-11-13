import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { binomialCdf } from './binomial.ts';
import {
  MAD_TO_SIGMA,
  median,
  medianAbsoluteDeviation,
  medianIntervalRanks,
  medianOfSorted,
  medianWithInterval,
  quantile,
  robustSpread,
} from './descriptive.ts';

// `+ 0` turns -0 into 0, so that toBe() comparisons with Math.min/max are not about signed zeros.
const finiteArray = (minLength: number) =>
  fc.array(
    fc.double({ min: -1e6, max: 1e6, noNaN: true }).map((v) => v + 0),
    { minLength, maxLength: 60 },
  );

describe('median', () => {
  it('takes the middle value of an odd count and the mean of the two middle values of an even count', () => {
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 3, 2])).toBe(2.5);
    expect(median([7])).toBe(7);
    expect(median([-5, 5])).toBe(0);
    expect(medianOfSorted([1, 2, 10, 20])).toBe(6);
  });

  it('is null for no values and throws on non-finite values', () => {
    expect(median([])).toBeNull();
    expect(() => median([1, Number.NaN])).toThrow(RangeError);
    expect(() => median([1, Infinity])).toThrow(RangeError);
  });

  it('does not reorder its input', () => {
    const values = [5, 3, 9, 1];
    median(values);
    expect(values).toEqual([5, 3, 9, 1]);
  });

  it('splits the values in half', () => {
    fc.assert(
      fc.property(finiteArray(1), (values) => {
        const m = median(values) as number;
        const below = values.filter((v) => v < m).length;
        const above = values.filter((v) => v > m).length;
        expect(below).toBeLessThanOrEqual(values.length / 2);
        expect(above).toBeLessThanOrEqual(values.length / 2);
      }),
    );
  });
});

describe('quantile (type 7, linear interpolation)', () => {
  it('matches the R / NumPy default', () => {
    expect(quantile([1, 2, 3, 4], 0.9)).toBeCloseTo(3.7, 12);
    expect(quantile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 0.9)).toBeCloseTo(9.1, 12);
    expect(quantile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 0.1)).toBeCloseTo(1.9, 12);
    expect(quantile([15, 20, 35, 40, 50], 0.4)).toBeCloseTo(29, 12);
    expect(quantile([2.5, 7.0, 1.0, 9.5], 0.25)).toBeCloseTo(2.125, 12);
  });

  it('gives the median at 1/2, the extremes at 0 and 1, and grows with the probability', () => {
    fc.assert(
      fc.property(finiteArray(1), fc.double({ min: 0, max: 1, noNaN: true }), fc.double({ min: 0, max: 1, noNaN: true }), (values, a, b) => {
        expect(quantile(values, 0.5)).toBe(median(values));
        expect(quantile(values, 0)).toBe(Math.min(...values));
        expect(quantile(values, 1)).toBe(Math.max(...values));
        const [lo, hi] = a <= b ? [a, b] : [b, a];
        expect(quantile(values, lo) as number).toBeLessThanOrEqual((quantile(values, hi) as number) + 1e-9);
      }),
    );
  });

  it('is null for no values and rejects probabilities outside [0, 1]', () => {
    expect(quantile([], 0.9)).toBeNull();
    expect(() => quantile([1, 2], 1.5)).toThrow(RangeError);
    expect(() => quantile([1, 2], Number.NaN)).toThrow(RangeError);
  });
});

describe('robust spread (spec 7.4, 7.6: s = 1.4826 MAD)', () => {
  it('computes MAD around the median', () => {
    expect(medianAbsoluteDeviation([1, 1, 2, 2, 4, 6, 9])).toBe(1);
    expect(robustSpread([1, 1, 2, 2, 4, 6, 9])).toBe(MAD_TO_SIGMA);
    expect(MAD_TO_SIGMA).toBe(1.4826);
    expect(medianAbsoluteDeviation([5, 5, 5])).toBe(0);
    expect(robustSpread([])).toBeNull();
  });

  it('ignores a shift and scales with the data', () => {
    fc.assert(
      fc.property(finiteArray(1), fc.double({ min: -1e3, max: 1e3, noNaN: true }), fc.double({ min: 0.1, max: 10, noNaN: true }), (values, shift, scale) => {
        const base = medianAbsoluteDeviation(values) as number;
        const moved = medianAbsoluteDeviation(values.map((v) => v * scale + shift)) as number;
        expect(Math.abs(moved - base * scale)).toBeLessThanOrEqual(1e-6 * Math.max(1, base * scale));
      }),
    );
  });
});

describe('order-statistic interval of the median (spec 7.10)', () => {
  it('follows the standard 95% table of ranks', () => {
    const lowerRankByN: Record<number, number> = {
      6: 1, 7: 1, 8: 1, 9: 2, 10: 2, 11: 2, 12: 3, 13: 3, 14: 3, 15: 4, 16: 4, 17: 5, 18: 5, 19: 5, 20: 6,
      21: 6, 22: 6, 23: 7, 24: 7, 25: 8, 26: 8, 27: 8, 28: 9, 29: 9, 30: 10,
    };
    for (const [n, r] of Object.entries(lowerRankByN)) {
      const ranks = medianIntervalRanks(Number(n));
      expect(ranks?.lowerRank).toBe(r);
      expect(ranks?.upperRank).toBe(Number(n) - r + 1);
    }
    for (const n of [0, 1, 2, 3, 4, 5]) expect(medianIntervalRanks(n)).toBeNull();
  });

  it('reports the exact coverage, at least the confidence asked for', () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 400 }), fc.constantFrom(0.8, 0.9, 0.95, 0.99), (n, confidence) => {
        const ranks = medianIntervalRanks(n, confidence);
        if (ranks === null) {
          // Not even [min, max] reaches the confidence.
          expect(1 - 2 * Math.pow(0.5, n)).toBeLessThan(confidence);
          return;
        }
        const coverage = 1 - 2 * binomialCdf(ranks.lowerRank - 1, n, 0.5);
        expect(ranks.coverage).toBeCloseTo(coverage, 12);
        expect(ranks.coverage).toBeGreaterThanOrEqual(confidence - 1e-12);
        // One rank further in would fall below the confidence.
        if (ranks.lowerRank + 1 <= ranks.upperRank - 1) {
          expect(1 - 2 * binomialCdf(ranks.lowerRank, n, 0.5)).toBeLessThan(confidence);
        }
      }),
    );
  });

  it('brackets the median with order statistics, or prints the range for n <= 5', () => {
    fc.assert(
      fc.property(finiteArray(1), (values) => {
        const m = medianWithInterval(values);
        expect(m).not.toBeNull();
        if (m === null) return;
        const sorted = [...values].sort((a, b) => a - b);
        expect(m.median).toBe(median(values));
        expect(m.low).toBeLessThanOrEqual(m.median);
        expect(m.high).toBeGreaterThanOrEqual(m.median);
        expect(m.low).toBe(sorted[m.lowerRank - 1]);
        expect(m.high).toBe(sorted[m.upperRank - 1]);
        expect(m.kind).toBe(values.length <= 5 ? 'range' : 'order-statistics');
      }),
    );
  });

  it('handles 0 and 1 values without NaN', () => {
    expect(medianWithInterval([])).toBeNull();
    expect(medianWithInterval([42])).toEqual({
      n: 1,
      median: 42,
      low: 42,
      high: 42,
      kind: 'range',
      lowerRank: 1,
      upperRank: 1,
      coverage: 0,
      confidence: 0.95,
    });
  });
});
