import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import {
  binomialCdf,
  binomialPmf,
  binomialTestGreaterPValue,
  binomialTestPower,
  binomialUpperTail,
  logBinomialCoefficient,
  minSuccessesForSignificance,
  signTest,
  signTestMinWins,
  signTestPower,
} from './binomial.ts';

function expectRelClose(actual: number, expected: number, rel: number): void {
  expect(Math.abs(actual - expected)).toBeLessThanOrEqual(rel * Math.abs(expected));
}

describe('binomial coefficients', () => {
  it('are exact for small n', () => {
    expect(Math.exp(logBinomialCoefficient(14, 3))).toBeCloseTo(364, 9);
    expect(Math.round(Math.exp(logBinomialCoefficient(20, 10)))).toBe(184756);
    expectRelClose(Math.exp(logBinomialCoefficient(60, 30)), 118264581564861424, 1e-14);
    expect(logBinomialCoefficient(7, 0)).toBe(0);
    expect(logBinomialCoefficient(7, 7)).toBe(0);
  });

  it('agree between the exact product and the logGamma route (n > 1000)', () => {
    const bySum = (n: number, k: number): number => {
      let s = 0;
      for (let i = 1; i <= k; i++) s += Math.log((n - k + i) / i);
      return s;
    };
    for (const [n, k] of [
      [1200, 600],
      [5000, 17],
      [100000, 50],
    ] as const) {
      expectRelClose(logBinomialCoefficient(n, k), bySum(n, k), 1e-12);
    }
  });

  it('reject k > n and bad counts', () => {
    expect(() => logBinomialCoefficient(3, 4)).toThrow(RangeError);
    expect(() => logBinomialCoefficient(-1, 0)).toThrow(RangeError);
    expect(() => logBinomialCoefficient(3.5, 1)).toThrow(RangeError);
  });
});

describe('binomial distribution', () => {
  it('matches exact rational references', () => {
    expectRelClose(binomialPmf(3, 14, 0.049), 0.024641963505167255, 1e-13);
    const tails: [k: number, n: number, p: number, upper: number][] = [
      [3, 14, 0.049, 0.028522885058882903],
      [2, 14, 0.049, 0.14808669778038322],
      [15, 20, 0.5, 0.020694732666015625],
      [14, 20, 0.5, 0.057659149169921875],
      [7, 11, 0.5, 0.2744140625],
      [6, 17, 0.5, 0.9282684326171875],
      [5, 17, 0.074, 0.006451867064427445],
      [8, 14, 0.3, 0.03146853243564],
      [30, 100, 0.2, 0.011248978720991634],
      [60, 100, 0.2, 2.51581919953345e-18],
      [700, 1000, 0.5, 8.832839003975068e-38],
      [1, 60, 0.001, 0.0582637377768318],
    ];
    for (const [k, n, p, upper] of tails) expectRelClose(binomialUpperTail(k, n, p), upper, 1e-12);
    expectRelClose(binomialCdf(4, 14, 0.3), 1 - 0.41579881378065, 1e-12);
  });

  it('pmf sums to 1 and the two tails are complementary', () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 300 }), fc.double({ min: 0, max: 1, noNaN: true }), (n, p) => {
        let sum = 0;
        for (let k = 0; k <= n; k++) sum += binomialPmf(k, n, p);
        expect(Math.abs(sum - 1)).toBeLessThan(1e-12);
        const k = Math.floor(n / 3);
        expect(Math.abs(binomialCdf(k, n, p) + binomialUpperTail(k + 1, n, p) - 1)).toBeLessThan(1e-12);
      }),
    );
  });

  it('upper tail falls with k and grows with p', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 200 }),
        fc.double({ min: 0, max: 0.99, noNaN: true }),
        fc.double({ min: 0.001, max: 0.01, noNaN: true }),
        (n, p, dp) => {
          const k = Math.ceil(n / 2);
          expect(binomialUpperTail(k + 1, n, p)).toBeLessThanOrEqual(binomialUpperTail(k, n, p));
          expect(binomialUpperTail(k, n, p + dp)).toBeGreaterThanOrEqual(binomialUpperTail(k, n, p) - 1e-15);
        },
      ),
    );
  });

  it('at p = 1/2 gives exact dyadic fractions for n <= 53 (checked with BigInt)', () => {
    const exactCoefficient = (n: number, k: number): bigint => {
      let c = 1n;
      for (let i = 1; i <= k; i++) c = (c * BigInt(n - k + i)) / BigInt(i);
      return c;
    };
    for (let n = 0; n <= 53; n++) {
      const scale = 2 ** -n;
      let upper = 0n;
      for (let k = n; k >= 0; k--) {
        const c = exactCoefficient(n, k);
        upper += c;
        expect(binomialPmf(k, n, 0.5)).toBe(Number(c) * scale);
        expect(binomialUpperTail(k, n, 0.5)).toBe(Number(upper) * scale);
      }
    }
  });

  it('handles p = 0, p = 1, n = 0 and k outside [0, n]', () => {
    expect(binomialPmf(0, 10, 0)).toBe(1);
    expect(binomialPmf(1, 10, 0)).toBe(0);
    expect(binomialPmf(10, 10, 1)).toBe(1);
    expect(binomialPmf(9, 10, 1)).toBe(0);
    expect(binomialPmf(0, 0, 0.3)).toBe(1);
    expect(binomialPmf(-1, 5, 0.3)).toBe(0);
    expect(binomialPmf(6, 5, 0.3)).toBe(0);
    expect(binomialUpperTail(0, 5, 0.3)).toBe(1);
    expect(binomialUpperTail(-2, 5, 0.3)).toBe(1);
    expect(binomialUpperTail(6, 5, 0.3)).toBe(0);
    expect(binomialUpperTail(1, 10, 0)).toBe(0);
    expect(binomialUpperTail(10, 10, 1)).toBe(1);
    expect(binomialCdf(-1, 5, 0.3)).toBe(0);
    expect(binomialCdf(5, 5, 0.3)).toBe(1);
  });

  it('rejects bad arguments instead of returning NaN', () => {
    expect(() => binomialPmf(1, 5, 1.5)).toThrow(RangeError);
    expect(() => binomialPmf(1, 5, Number.NaN)).toThrow(RangeError);
    expect(() => binomialPmf(1.5, 5, 0.5)).toThrow(RangeError);
    expect(() => binomialCdf(1, -5, 0.5)).toThrow(RangeError);
    expect(() => binomialUpperTail(1, 2.5, 0.5)).toThrow(RangeError);
  });
});

describe('exact one-sided binomial test (spec 4.4, H1)', () => {
  it('p-value is the upper tail at p0, from 0 of n to n of n', () => {
    expect(binomialTestGreaterPValue(3, 14, 0.049)).toBe(binomialUpperTail(3, 14, 0.049));
    expect(binomialTestGreaterPValue(0, 14, 0.049)).toBe(1);
    expectRelClose(binomialTestGreaterPValue(14, 14, 0.049), 0.049 ** 14, 1e-13);
    expect(binomialTestGreaterPValue(1, 14, 0)).toBe(0);
    expect(binomialTestGreaterPValue(14, 14, 1)).toBe(1);
    expect(minSuccessesForSignificance(14, 0)).toBe(1);
    expect(minSuccessesForSignificance(14, 1)).toBeNull();
  });

  it('0 trials give p = 1 (no evidence), not NaN', () => {
    expect(binomialTestGreaterPValue(0, 0, 0.05)).toBe(1);
  });

  it('rejects successes > trials', () => {
    expect(() => binomialTestGreaterPValue(5, 4, 0.1)).toThrow(RangeError);
  });

  it('minSuccessesForSignificance is the first count with p <= alpha', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 120 }),
        fc.double({ min: 0.001, max: 0.6, noNaN: true }),
        fc.constantFrom(0.01, 0.05, 0.1),
        (n, p0, alpha) => {
          const k = minSuccessesForSignificance(n, p0, alpha);
          if (k === null) {
            expect(binomialUpperTail(n, n, p0)).toBeGreaterThan(alpha);
          } else {
            expect(binomialUpperTail(k, n, p0)).toBeLessThanOrEqual(alpha);
            expect(binomialUpperTail(k - 1, n, p0)).toBeGreaterThan(alpha);
          }
        },
      ),
    );
    expect(minSuccessesForSignificance(0, 0.2)).toBeNull();
    expect(() => minSuccessesForSignificance(10, 0.2, 0)).toThrow(RangeError);
  });
});

describe('one-sided sign test (spec 4.4, H3 and H4)', () => {
  it('leaves ties out of the test and carries their count', () => {
    const r = signTest(7, 4, 6);
    expect(r).toEqual({ wins: 7, losses: 4, ties: 6, nPairs: 17, nUntied: 11, pValue: 0.2744140625 });
  });

  it('all ties: 0 untied pairs and p = 1', () => {
    expect(signTest(0, 0, 9)).toEqual({ wins: 0, losses: 0, ties: 9, nPairs: 9, nUntied: 0, pValue: 1 });
  });

  it('counts every pair in nPairs and only wins and losses in nUntied', () => {
    fc.assert(
      fc.property(fc.nat(60), fc.nat(60), fc.nat(60), (wins, losses, ties) => {
        const r = signTest(wins, losses, ties);
        expect(r.nPairs).toBe(wins + losses + ties);
        expect(r.nUntied).toBe(wins + losses);
        // Ties never change the p-value.
        expect(r.pValue).toBe(signTest(wins, losses).pValue);
      }),
    );
  });

  it('needs 15 of 20, 5 of 5, and cannot succeed with 4 pairs', () => {
    expect(signTestMinWins(20)).toBe(15);
    expect(signTestMinWins(5)).toBe(5);
    expect(signTestMinWins(4)).toBeNull();
    expect(signTestMinWins(0)).toBeNull();
  });

  it('more wins for the same pairs never raise the p-value', () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 60 }), fc.integer({ min: 1, max: 60 }), (wins, losses) => {
        expect(signTest(wins + 1, losses - 1).pValue).toBeLessThanOrEqual(signTest(wins, losses).pValue);
      }),
    );
  });

  it('rejects negative or fractional counts', () => {
    expect(() => signTest(-1, 3)).toThrow(RangeError);
    expect(() => signTest(1, 3, 0.5)).toThrow(RangeError);
  });
});

describe('power of the exact tests', () => {
  it('is the chance of reaching the critical count under the true rate', () => {
    // 20 pairs need 15 wins: power = P(Bin(20, q) >= 15). Exact rationals.
    expect(signTestPower(20, 0.8)).toBeCloseTo(76695231004672 / 95367431640625, 14);
    expect(signTestPower(20, 0.75)).toBeCloseTo(169647127461 / 274877906944, 14);
    // At q = 1/2 the power is the size of the test, below alpha.
    expect(signTestPower(20, 0.5)).toBe(5425 / 262144);
    expect(signTestPower(20, 0.5)).toBeLessThanOrEqual(0.05);
    // H1 setting of spec 7.10: 14 events at p0 = 4.9% need 3.
    expect(binomialTestPower(14, 0.049, 0.3)).toBe(binomialUpperTail(3, 14, 0.3));
  });

  it('is 0 when no count can be significant, and at the extremes of the true rate', () => {
    expect(signTestPower(4, 0.99)).toBe(0);
    expect(signTestPower(0, 0.9)).toBe(0);
    expect(signTestPower(20, 0)).toBe(0);
    expect(signTestPower(20, 1)).toBe(1);
  });

  it('grows with the true rate and never exceeds 1', () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 80 }), fc.double({ min: 0, max: 0.99, noNaN: true }), (n, q) => {
        const p = signTestPower(n, q);
        expect(p).toBeGreaterThanOrEqual(0);
        expect(p).toBeLessThanOrEqual(1);
        expect(signTestPower(n, q + 0.01)).toBeGreaterThanOrEqual(p - 1e-15);
      }),
    );
  });

  it('rejects a true rate outside [0, 1]', () => {
    expect(() => signTestPower(20, 1.2)).toThrow(RangeError);
    expect(() => binomialTestPower(20, 0.1, Number.NaN)).toThrow(RangeError);
  });
});
