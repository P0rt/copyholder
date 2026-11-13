import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { wilsonInterval } from './proportion.ts';

describe('Wilson score interval', () => {
  const counts = fc.integer({ min: 1, max: 5000 }).chain((n) => fc.tuple(fc.integer({ min: 0, max: n }), fc.constant(n)));

  it('matches 40-digit references', () => {
    const refs: [k: number, n: number, low: number, high: number][] = [
      [8, 14, 0.325906445796507, 0.786192010955259],
      [11, 20, 0.342085342450342, 0.741802141744376],
      [20, 27, 0.553214286854469, 0.868296254380928],
      [5, 17, 0.132799896102952, 0.531331100665398],
      [3, 14, 0.075713867126932, 0.475892305866003],
      [1, 2, 0.094531205734231, 0.905468794265769],
      [0, 10, 0, 0.277532799862889],
      [10, 10, 0.722467200137111, 1],
      [1, 1, 0.206549314377237, 1],
    ];
    for (const [k, n, low, high] of refs) {
      const w = wilsonInterval(k, n);
      expect(w.low).toBeCloseTo(low, 13);
      expect(w.high).toBeCloseTo(high, 13);
      expect(w.estimate).toBe(k / n);
      expect(w.confidence).toBe(0.95);
    }
  });

  it('0 of n starts exactly at 0 and n of n ends exactly at 1', () => {
    for (const n of [1, 2, 7, 14, 1000]) {
      expect(wilsonInterval(0, n).low).toBe(0);
      expect(wilsonInterval(0, n).high).toBeGreaterThan(0);
      expect(wilsonInterval(n, n).high).toBe(1);
      expect(wilsonInterval(n, n).low).toBeLessThan(1);
    }
  });

  it('0 trials: no estimate (null), interval [0, 1], never NaN', () => {
    const w = wilsonInterval(0, 0);
    expect(w.estimate).toBeNull();
    expect(w.low).toBe(0);
    expect(w.high).toBe(1);
  });

  it('stays finite for a confidence level next to 1 (z from the lower tail)', () => {
    // 0.5 + c / 2 rounds to 1 here: the z of the upper tail would be Infinity.
    const c = 0.9999999999999999;
    expect(0.5 + c / 2).toBe(1);
    for (const [k, n] of [
      [5, 10],
      [0, 10],
      [10, 10],
      [1, 1],
    ] as const) {
      const w = wilsonInterval(k, n, c);
      expect(Number.isFinite(w.low) && Number.isFinite(w.high)).toBe(true);
      expect(w.low).toBeGreaterThanOrEqual(0);
      expect(w.high).toBeLessThanOrEqual(1);
      expect(w.low).toBeLessThanOrEqual(k / n);
      expect(w.high).toBeGreaterThanOrEqual(k / n);
    }
    expect(wilsonInterval(5, 10, c).low).toBeLessThan(wilsonInterval(5, 10, 0.9999).low);
  });

  it('never returns NaN for any confidence level in (0, 1)', () => {
    fc.assert(
      fc.property(counts, fc.double({ min: Number.MIN_VALUE, max: 1, maxExcluded: true, noNaN: true }), ([k, n], c) => {
        const w = wilsonInterval(k, n, c);
        expect(Number.isNaN(w.low) || Number.isNaN(w.high)).toBe(false);
        expect(w.low).toBeLessThanOrEqual(w.high);
      }),
    );
  });

  it('rejects impossible counts and confidence levels', () => {
    expect(() => wilsonInterval(5, 4)).toThrow(RangeError);
    expect(() => wilsonInterval(-1, 4)).toThrow(RangeError);
    expect(() => wilsonInterval(1.5, 4)).toThrow(RangeError);
    expect(() => wilsonInterval(Number.NaN, 4)).toThrow(RangeError);
    expect(() => wilsonInterval(1, 4, 1)).toThrow(RangeError);
    expect(() => wilsonInterval(1, 4, 0)).toThrow(RangeError);
  });

  it('contains the point estimate and stays inside [0, 1]', () => {
    fc.assert(
      fc.property(counts, fc.double({ min: 0.5, max: 0.999, noNaN: true }), ([k, n], confidence) => {
        const w = wilsonInterval(k, n, confidence);
        expect(w.low).toBeGreaterThanOrEqual(0);
        expect(w.high).toBeLessThanOrEqual(1);
        expect(w.low).toBeLessThanOrEqual(k / n);
        expect(w.high).toBeGreaterThanOrEqual(k / n);
        expect(w.low).toBeLessThan(w.high);
      }),
    );
  });

  it('is monotonic in the counts', () => {
    fc.assert(
      fc.property(counts, ([k, n]) => {
        const w = wilsonInterval(k, n);
        if (k < n) {
          // One more success out of the same trials moves both bounds up.
          const up = wilsonInterval(k + 1, n);
          expect(up.low).toBeGreaterThan(w.low);
          expect(up.high).toBeGreaterThan(w.high);
        }
        // One more failure moves both bounds down (or keeps 0 at 0).
        const more = wilsonInterval(k, n + 1);
        expect(more.low).toBeLessThanOrEqual(w.low);
        expect(more.high).toBeLessThan(w.high);
      }),
    );
  });

  it('is symmetric under swapping successes and failures, and widens with confidence', () => {
    fc.assert(
      fc.property(counts, ([k, n]) => {
        const w = wilsonInterval(k, n);
        const mirror = wilsonInterval(n - k, n);
        expect(Math.abs(w.low - (1 - mirror.high))).toBeLessThan(1e-12);
        const wide = wilsonInterval(k, n, 0.99);
        expect(wide.low).toBeLessThanOrEqual(w.low);
        expect(wide.high).toBeGreaterThanOrEqual(w.high);
      }),
    );
  });
});
