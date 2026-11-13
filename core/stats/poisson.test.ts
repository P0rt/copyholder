import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { logGamma } from './special.ts';
import {
  CHANCE_WINDOW_MS,
  chanceLevelFromRatePerMin,
  poissonChanceLevel,
  poissonMeanLowerBound,
  poissonMeanUpperBound,
  poissonRateLowerBoundPerMin,
  poissonRateUpperBoundPerMin,
  ratePerMin,
} from './poisson.ts';

function expectRelClose(actual: number, expected: number, rel: number): void {
  expect(Math.abs(actual - expected)).toBeLessThanOrEqual(rel * Math.abs(expected));
}

describe('exact (Garwood) Poisson bounds', () => {
  it('match the one-sided 95% table (40-digit references)', () => {
    const table: [x: number, upper: number, lower: number][] = [
      [0, 2.995732273553991, 0],
      [1, 4.743864518390578, 0.051293294387551],
      [2, 6.29579362187199, 0.355361510698662],
      [3, 7.753656527932727, 0.817691447163953],
      [4, 9.153519026637573, 1.366318396749831],
      [5, 10.513034908741533, 1.97014956805953],
      [10, 16.962219235721901, 5.425405697091293],
      [14, 21.886485912871094, 8.463937522211247],
      [32, 42.982453720615479, 23.297452612406982],
    ];
    for (const [x, upper, lower] of table) {
      expectRelClose(poissonMeanUpperBound(x), upper, 1e-12);
      if (x === 0) expect(poissonMeanLowerBound(x)).toBe(0);
      else expectRelClose(poissonMeanLowerBound(x), lower, 1e-11);
    }
    // x = 0: the bound has the closed form -ln(0.05).
    expectRelClose(poissonMeanUpperBound(0), -Math.log(0.05), 1e-14);
  });

  it('have exact coverage: P(upper bound < true mean) <= 5% for every mean', () => {
    const pmf = (x: number, mu: number): number => Math.exp(-mu + x * Math.log(mu) - logGamma(x + 1));
    const uppers = Array.from({ length: 200 }, (_, x) => poissonMeanUpperBound(x));
    let worst = 0;
    for (let mu = 0.05; mu <= 60; mu += 0.05) {
      let miss = 0; // the bound misses mu when the observed count is small
      for (let x = 0; x < uppers.length && (uppers[x] as number) < mu; x++) miss += pmf(x, mu);
      expect(miss).toBeLessThanOrEqual(0.05 + 1e-12);
      worst = Math.max(worst, miss);
    }
    // ... and the bound is tight: the 5% is reached just below some bound.
    expect(worst).toBeGreaterThan(0.049);
  });

  it('grow with the count, bracket it, and grow with the confidence', () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 2000 }), fc.double({ min: 0.5, max: 0.99, noNaN: true }), (x, c) => {
        const up = poissonMeanUpperBound(x, c);
        const lo = poissonMeanLowerBound(x, c);
        expect(poissonMeanUpperBound(x + 1, c)).toBeGreaterThan(up);
        expect(poissonMeanLowerBound(x + 1, c)).toBeGreaterThan(lo);
        expect(lo).toBeLessThanOrEqual(x);
        expect(up).toBeGreaterThan(x);
        expect(poissonMeanUpperBound(x, Math.min(0.999, c + 0.005))).toBeGreaterThan(up);
      }),
    );
  });
});

describe('false-stop rates per minute (spec 4.3)', () => {
  it('divide by the exposure', () => {
    expect(ratePerMin(32, 16)).toBe(2);
    expectRelClose(poissonRateUpperBoundPerMin(32, 16), 42.982453720615479 / 16, 1e-12);
    expectRelClose(poissonRateLowerBoundPerMin(32, 16), 23.297452612406982 / 16, 1e-11);
    // 0 false stops still have a finite upper bound.
    expectRelClose(poissonRateUpperBoundPerMin(0, 10), 2.995732273553991 / 10, 1e-12);
  });

  it('upper bound falls as exposure grows', () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 500 }), fc.double({ min: 0.1, max: 600, noNaN: true }), (x, t) => {
        expect(poissonRateUpperBoundPerMin(x, t * 1.5)).toBeLessThan(poissonRateUpperBoundPerMin(x, t));
      }),
    );
  });

  it('zero or negative exposure throws instead of returning Infinity or NaN', () => {
    expect(() => ratePerMin(3, 0)).toThrow(RangeError);
    expect(() => poissonRateUpperBoundPerMin(3, 0)).toThrow(RangeError);
    expect(() => poissonRateUpperBoundPerMin(3, -2)).toThrow(RangeError);
    expect(() => poissonRateUpperBoundPerMin(3, Number.NaN)).toThrow(RangeError);
    expect(() => poissonMeanUpperBound(-1)).toThrow(RangeError);
    expect(() => poissonMeanUpperBound(2.5)).toThrow(RangeError);
    expect(() => poissonMeanUpperBound(2, 1)).toThrow(RangeError);
  });
});

describe('first chance-level estimate (spec 4.3)', () => {
  it('uses W = 1.5 s by default', () => {
    expect(CHANCE_WINDOW_MS).toBe(1500);
    expect(chanceLevelFromRatePerMin(2)).toBe(chanceLevelFromRatePerMin(2, 1500));
  });

  it('is 1 - exp(-lambda W / 60)', () => {
    expectRelClose(chanceLevelFromRatePerMin(1), 1 - Math.exp(-0.025), 1e-14);
    expectRelClose(chanceLevelFromRatePerMin(5, 3000), 1 - Math.exp(-0.25), 1e-14);
    expect(chanceLevelFromRatePerMin(0)).toBe(0);
  });

  it('grows with the rate and the window and stays below 1', () => {
    fc.assert(
      fc.property(fc.double({ min: 0, max: 100, noNaN: true }), fc.double({ min: 1, max: 10_000, noNaN: true }), (rate, w) => {
        const p = chanceLevelFromRatePerMin(rate, w);
        expect(p).toBeGreaterThanOrEqual(0);
        expect(p).toBeLessThan(1);
        expect(chanceLevelFromRatePerMin(rate + 0.5, w)).toBeGreaterThan(p);
        expect(chanceLevelFromRatePerMin(rate + 0.5, w + 100)).toBeGreaterThan(chanceLevelFromRatePerMin(rate + 0.5, w));
      }),
    );
  });

  it('reports the inputs with the result', () => {
    const c = poissonChanceLevel(14, 13.2);
    expect(c).toMatchObject({ falseStops: 14, activeMin: 13.2, confidence: 0.95, windowMs: 1500 });
    expectRelClose(c.rateUpperPerMin, 21.886485912871094 / 13.2, 1e-12);
    expect(c.p0).toBe(chanceLevelFromRatePerMin(c.rateUpperPerMin, 1500));
  });

  it('rejects negative rates and windows', () => {
    expect(() => chanceLevelFromRatePerMin(-1)).toThrow(RangeError);
    expect(() => chanceLevelFromRatePerMin(1, -5)).toThrow(RangeError);
    expect(() => chanceLevelFromRatePerMin(Number.NaN)).toThrow(RangeError);
    expect(() => poissonChanceLevel(3, 0)).toThrow(RangeError);
  });
});
