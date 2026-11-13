import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import {
  chiSquareCdf,
  chiSquareQuantile,
  erf,
  erfc,
  gammaQuantile,
  logGamma,
  normalCdf,
  normalQuantile,
  regularizedGammaP,
  regularizedGammaQ,
} from './special.ts';

function expectRelClose(actual: number, expected: number, rel: number): void {
  const tol = rel * Math.max(Math.abs(expected), Number.MIN_VALUE);
  expect(Math.abs(actual - expected)).toBeLessThanOrEqual(tol);
}

describe('logGamma (Lanczos)', () => {
  it('matches exact and reference values', () => {
    expect(Math.abs(logGamma(1))).toBeLessThan(1e-15);
    expect(Math.abs(logGamma(2))).toBeLessThan(1e-15);
    expectRelClose(logGamma(0.5), 0.5 * Math.log(Math.PI), 1e-14);
    expectRelClose(logGamma(1.5), 0.5 * Math.log(Math.PI) - Math.LN2, 1e-13);
    expectRelClose(logGamma(10), Math.log(362880), 1e-14);
    // Python math.lgamma
    expectRelClose(logGamma(3.7), 1.4280723266653883, 1e-14);
    expectRelClose(logGamma(33), 81.55795945611503, 1e-14);
    expectRelClose(logGamma(100), 359.1342053695754, 1e-14);
    expectRelClose(logGamma(1000), 5905.220423209181, 1e-14);
    expectRelClose(logGamma(0.001), 6.907178885383854, 1e-14);
    expectRelClose(logGamma(0.1), 2.2527126517342055, 1e-14);
  });

  it('satisfies lnGamma(x + 1) = lnGamma(x) + ln x', () => {
    fc.assert(
      fc.property(fc.double({ min: 0.01, max: 200, noNaN: true }), (x) => {
        expect(Math.abs(logGamma(x + 1) - logGamma(x) - Math.log(x))).toBeLessThan(1e-12 * Math.max(1, logGamma(x + 1)));
      }),
    );
  });

  it('stays finite for tiny and subnormal x: ln Gamma(x) = -ln x - gamma x + O(x^2)', () => {
    // 60-digit Decimal references from the series -ln x - gamma x + zeta(2) x^2 / 2 - ...
    expectRelClose(logGamma(1e-310), 713.801378828154162, 1e-15);
    expectRelClose(logGamma(Number.MIN_VALUE), 744.440071921381262, 1e-15);
    expectRelClose(logGamma(1e-8), 18.4206807381802089, 1e-15);
    expectRelClose(logGamma(2e-9), 20.0301186552320345, 1e-15);
    expectRelClose(logGamma(1e-12), 27.6310211159279710, 1e-15);
  });

  it('is continuous across the small-x branches (checked through lnGamma(1 + x) - ln x)', () => {
    fc.assert(
      fc.property(fc.double({ min: 1e-12, max: 1e-6, noNaN: true }), (x) => {
        // logGamma(1 + x) takes the Lanczos branch, an independent route.
        const viaRecurrence = logGamma(1 + x) - Math.log(x);
        expect(Math.abs(logGamma(x) - viaRecurrence)).toBeLessThan(1e-14 * Math.abs(viaRecurrence));
      }),
      { numRuns: 200 },
    );
  });

  it('rejects x <= 0 and non-finite x', () => {
    expect(() => logGamma(0)).toThrow(RangeError);
    expect(() => logGamma(-1)).toThrow(RangeError);
    expect(() => logGamma(Number.NaN)).toThrow(RangeError);
    expect(() => logGamma(Infinity)).toThrow(RangeError);
  });
});

describe('regularized incomplete gamma', () => {
  it('reduces to the exponential distribution for a = 1', () => {
    for (const x of [1e-6, 0.1, 1, 5, 30]) {
      expectRelClose(regularizedGammaP(1, x), -Math.expm1(-x), 1e-13);
      expectRelClose(regularizedGammaQ(1, x), Math.exp(-x), 1e-13);
    }
  });

  it('reduces to the Poisson tail for integer a', () => {
    const poissonTail = (a: number, x: number): number => {
      let term = 1;
      let sum = 1;
      for (let i = 1; i < a; i++) {
        term *= x / i;
        sum += term;
      }
      return Math.exp(-x) * sum; // Q(a, x)
    };
    for (const a of [2, 3, 10, 33]) {
      for (const x of [0.5, 2, 10, 25, 60]) {
        expectRelClose(regularizedGammaQ(a, x), poissonTail(a, x), 1e-12);
      }
    }
  });

  it('gives erf and erfc for a = 1/2 (40-digit references)', () => {
    expectRelClose(erf(0.5), 0.520499877813046537683, 1e-14);
    expectRelClose(erf(1), 0.842700792949714869341, 1e-14);
    expectRelClose(erf(-1), -0.842700792949714869341, 1e-14);
    expectRelClose(erfc(2), 4.67773498104726583793e-3, 1e-13);
    expectRelClose(erfc(4), 1.54172579002800188522e-8, 1e-12);
    expect(erf(0)).toBe(0);
    expect(erfc(0)).toBe(1);
  });

  it('P + Q = 1 and P grows with x', () => {
    fc.assert(
      fc.property(
        fc.double({ min: 0.05, max: 300, noNaN: true }),
        fc.double({ min: 0, max: 500, noNaN: true }),
        fc.double({ min: 0, max: 50, noNaN: true }),
        (a, x, dx) => {
          const p = regularizedGammaP(a, x);
          expect(p).toBeGreaterThanOrEqual(0);
          expect(p).toBeLessThanOrEqual(1);
          expect(Math.abs(p + regularizedGammaQ(a, x) - 1)).toBeLessThan(1e-14);
          expect(regularizedGammaP(a, x + dx)).toBeGreaterThanOrEqual(p - 1e-15);
        },
      ),
    );
  });

  it('handles the ends of the range and rejects bad input', () => {
    expect(regularizedGammaP(2.5, 0)).toBe(0);
    expect(regularizedGammaQ(2.5, 0)).toBe(1);
    expect(regularizedGammaP(2.5, Infinity)).toBe(1);
    expect(() => regularizedGammaP(0, 1)).toThrow(RangeError);
    expect(() => regularizedGammaP(1, -1)).toThrow(RangeError);
    expect(() => regularizedGammaP(1, Number.NaN)).toThrow(RangeError);
  });
});

describe('chi-square and gamma quantiles', () => {
  it('reproduces textbook table values (4 decimals)', () => {
    const table: [p: number, df: number, x: number][] = [
      [0.95, 1, 3.8415],
      [0.99, 1, 6.6349],
      [0.95, 2, 5.9915],
      [0.95, 5, 11.0705],
      [0.95, 10, 18.307],
      [0.99, 10, 23.2093],
      [0.05, 10, 3.9403],
      [0.975, 10, 20.4832],
      [0.025, 10, 3.247],
      [0.95, 20, 31.4104],
      [0.95, 30, 43.773],
      [0.95, 100, 124.3421],
    ];
    for (const [p, df, x] of table) {
      expect(Math.abs(chiSquareQuantile(p, df) - x)).toBeLessThan(5e-5);
    }
  });

  it('matches high-precision references (independent 40-digit computation)', () => {
    const refs: [p: number, df: number, x: number][] = [
      [0.95, 1, 3.84145882069412595836],
      [0.5, 1, 0.45493642311957275194],
      [0.95, 66, 85.96490744123095872718],
      [0.975, 66, 90.3489041588409325127],
      [0.05, 64, 46.59490522481396380718],
      [0.999, 3, 16.26623619623813091239],
      [0.001, 3, 0.02429758581569273319],
      [0.95, 100, 124.34211340400408172548],
    ];
    for (const [p, df, x] of refs) expectRelClose(chiSquareQuantile(p, df), x, 1e-13);
  });

  it('has the closed form -2 ln(1 - p) at df = 2 and -ln(1 - p) for gamma shape 1', () => {
    for (const p of [1e-9, 0.01, 0.5, 0.95, 0.999999]) {
      expectRelClose(chiSquareQuantile(p, 2), -2 * Math.log1p(-p), 1e-13);
      expectRelClose(gammaQuantile(p, 1), -Math.log1p(-p), 1e-13);
    }
  });

  it('inverts the CDF (round trip in the smaller tail)', () => {
    fc.assert(
      fc.property(
        fc.double({ min: 0.05, max: 300, noNaN: true }),
        fc.double({ min: 1e-10, max: 1 - 1e-10, noNaN: true }),
        (shape, p) => {
          const x = gammaQuantile(p, shape);
          fc.pre(x > 0); // the exact quantile can underflow for tiny shapes
          const err = p <= 0.5 ? Math.abs(regularizedGammaP(shape, x) - p) / p : Math.abs(regularizedGammaQ(shape, x) - (1 - p)) / (1 - p);
          expect(err).toBeLessThan(1e-10);
        },
      ),
    );
  });

  it('grows with p and with df', () => {
    fc.assert(
      fc.property(
        fc.double({ min: 0.1, max: 200, noNaN: true }),
        fc.double({ min: 0.001, max: 0.998, noNaN: true }),
        fc.double({ min: 1e-4, max: 0.001, noNaN: true }),
        (df, p, dp) => {
          expect(chiSquareQuantile(p + dp, df)).toBeGreaterThan(chiSquareQuantile(p, df));
          expect(chiSquareQuantile(p, df + 1)).toBeGreaterThan(chiSquareQuantile(p, df));
          expect(chiSquareCdf(chiSquareQuantile(p, df), df)).toBeCloseTo(p, 10);
        },
      ),
    );
  });

  it('handles p = 0 and p = 1 and rejects bad input', () => {
    expect(chiSquareQuantile(0, 4)).toBe(0);
    expect(chiSquareQuantile(1, 4)).toBe(Infinity);
    expect(() => chiSquareQuantile(-0.1, 4)).toThrow(RangeError);
    expect(() => chiSquareQuantile(1.1, 4)).toThrow(RangeError);
    expect(() => chiSquareQuantile(Number.NaN, 4)).toThrow(RangeError);
    expect(() => chiSquareQuantile(0.5, 0)).toThrow(RangeError);
    expect(() => gammaQuantile(0.5, -1)).toThrow(RangeError);
  });
});

describe('normal distribution (AS 241)', () => {
  it('matches known quantiles', () => {
    expectRelClose(normalQuantile(0.975), 1.95996398454005423552, 1e-15);
    expectRelClose(normalQuantile(0.95), 1.64485362695147271486, 1e-15);
    expectRelClose(normalQuantile(0.995), 2.57582930354890076098, 1e-15);
    expectRelClose(normalQuantile(0.9), 1.28155156554460046697, 1e-15);
    expectRelClose(normalQuantile(0.999), 3.09023230616781354154, 1e-15);
    expectRelClose(normalQuantile(0.6), 0.2533471031357997988, 1e-14);
    expectRelClose(normalQuantile(1e-10), -6.3613409024040562047, 1e-14);
    expect(normalQuantile(0.5)).toBe(0);
  });

  it('matches known CDF values', () => {
    expectRelClose(normalCdf(1.96), 0.975002104851779565863, 1e-15);
    expectRelClose(normalCdf(-1.96), 0.0249978951482204341366, 1e-13);
    expectRelClose(normalCdf(3), 0.998650101968369905473, 1e-15);
    expectRelClose(normalCdf(-5), 2.86651571879193911674e-7, 1e-12);
    expect(normalCdf(0)).toBe(0.5);
  });

  it('round-trips with the CDF built on the incomplete gamma', () => {
    fc.assert(
      fc.property(fc.double({ min: 1e-12, max: 0.5, noNaN: true }), (p) => {
        expectRelClose(normalCdf(normalQuantile(p)), p, 1e-12);
      }),
    );
  });

  it('is antisymmetric about 1/2', () => {
    // 1 - p carries a rounding error of up to 2^-54, which moves z by up to ~1.4e-16:
    // hence the small absolute floor next to the relative tolerance.
    fc.assert(
      fc.property(fc.double({ min: 1e-4, max: 0.5, noNaN: true }), (p) => {
        const z = normalQuantile(p);
        expect(Math.abs(normalQuantile(1 - p) + z)).toBeLessThanOrEqual(1e-11 * Math.abs(z) + 1e-15);
      }),
    );
  });

  it('agrees with an independent route: z^2 is chi-square with 1 df', () => {
    fc.assert(
      fc.property(fc.double({ min: 0.55, max: 0.999999, noNaN: true }), (p) => {
        expectRelClose(normalQuantile(p), Math.sqrt(chiSquareQuantile(2 * p - 1, 1)), 1e-11);
      }),
    );
  });

  it('maps 0 and 1 to infinities and rejects bad input', () => {
    expect(normalQuantile(0)).toBe(-Infinity);
    expect(normalQuantile(1)).toBe(Infinity);
    expect(() => normalQuantile(2)).toThrow(RangeError);
    expect(() => normalQuantile(Number.NaN)).toThrow(RangeError);
  });
});
