// Spec 9.9 forecast table and the averaged forecasts quoted in spec 4.6.
import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { binomialCdf, signTestMinWins, signTestPower } from './binomial.ts';
import {
  GATE_FORECAST_VALID_OBJECTIONS,
  GATE_HITS_THRESHOLDS,
  NARROW_RATE_RANGE,
  classifyCount,
  countRuleProbabilities,
  countRuleProbabilitiesOverRates,
  integralOfUpperTail,
} from './forecast.ts';
import { createSeededRng } from './rng.ts';

const pct = (x: number): number => Math.round(x * 100);

describe('gate row 1 rule (spec 9.6)', () => {
  it('8 or more is PASS, 5-7 BETWEEN, under 5 KILL', () => {
    expect(GATE_HITS_THRESHOLDS).toEqual({ passAtLeast: 8, killBelow: 5 });
    expect([14, 8].map((c) => classifyCount(c))).toEqual(['PASS', 'PASS']);
    expect([7, 6, 5].map((c) => classifyCount(c))).toEqual(['BETWEEN', 'BETWEEN', 'BETWEEN']);
    expect([4, 0].map((c) => classifyCount(c))).toEqual(['KILL', 'KILL']);
  });

  it('rejects inconsistent thresholds and bad counts', () => {
    expect(() => classifyCount(3, { passAtLeast: 4, killBelow: 6 })).toThrow(RangeError);
    expect(() => classifyCount(-1)).toThrow(RangeError);
  });
});

describe('binomial model of spec 9.9', () => {
  it('reproduces the forecast table at 14 valid objections', () => {
    expect(GATE_FORECAST_VALID_OBJECTIONS).toBe(14);
    const table: [rate: number, pass: number, between: number, kill: number][] = [
      [0.15, 0, 5, 95],
      [0.25, 1, 25, 74],
      [0.3, 3, 38, 58],
      [0.4, 15, 57, 28],
      [0.46, 28, 57, 15],
      [0.53, 49, 46, 6],
      [0.6, 69, 29, 2],
      [0.7, 91, 9, 0],
    ];
    for (const [rate, pass, between, kill] of table) {
      const p = countRuleProbabilities(14, rate);
      expect([pct(p.pass), pct(p.between), pct(p.kill)]).toEqual([pass, between, kill]);
    }
  });

  it('reproduces the averages quoted in spec 4.6: 15-45% gives about 6/36/58%', () => {
    const p = countRuleProbabilitiesOverRates(14, 0.15, 0.45);
    expect([pct(p.pass), pct(p.between), pct(p.kill)]).toEqual([6, 36, 58]);
    expect(Math.abs(p.pass * 100 - 6)).toBeLessThan(1);
    expect(Math.abs(p.between * 100 - 36)).toBeLessThan(1);
    expect(Math.abs(p.kill * 100 - 58)).toBeLessThan(1);
  });

  it('reproduces the averages quoted in spec 4.6: 15-35% gives about 2/26/72%', () => {
    const p = countRuleProbabilitiesOverRates(14, 0.15, 0.35);
    expect([pct(p.pass), pct(p.between), pct(p.kill)]).toEqual([2, 26, 72]);
  });

  it('the three probabilities add up to 1', () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 40 }), fc.double({ min: 0, max: 1, noNaN: true }), (n, r) => {
        const p = countRuleProbabilities(n, r);
        expect(Math.abs(p.pass + p.between + p.kill - 1)).toBeLessThan(1e-12);
        expect(p.kill).toBeCloseTo(binomialCdf(4, n, r), 12);
      }),
    );
  });

  it('with 12 or 13 valid objections PASS is harder to get (spec 9.9)', () => {
    for (let r = 0.05; r < 1; r += 0.05) {
      const p12 = countRuleProbabilities(12, r).pass;
      const p13 = countRuleProbabilities(13, r).pass;
      const p14 = countRuleProbabilities(14, r).pass;
      expect(p12).toBeLessThan(p13);
      expect(p13).toBeLessThan(p14);
    }
  });
});

describe('average over a uniform range of true rates', () => {
  // Composite Simpson rule on the point probabilities, as an independent check.
  function simpson(f: (x: number) => number, a: number, b: number, intervals = 2000): number {
    const h = (b - a) / intervals;
    let s = f(a) + f(b);
    for (let i = 1; i < intervals; i++) s += f(a + i * h) * (i % 2 === 1 ? 4 : 2);
    return (s * h) / 3;
  }

  it('closed form equals numerical integration', () => {
    for (const [a, b] of [
      [0.15, 0.45],
      [0.15, 0.35],
      [0, 1],
      [0.3, 0.31],
    ] as const) {
      const exact = countRuleProbabilitiesOverRates(14, a, b);
      const pass = simpson((r) => countRuleProbabilities(14, r).pass, a, b) / (b - a);
      const kill = simpson((r) => countRuleProbabilities(14, r).kill, a, b) / (b - a);
      expect(exact.pass).toBeCloseTo(pass, 10);
      expect(exact.kill).toBeCloseTo(kill, 10);
    }
  });

  it('over all rates [0, 1] every count is equally likely', () => {
    // Uniform prior: the count is uniform on 0..n, so PASS = 7/15 and KILL = 5/15 for n = 14.
    const p = countRuleProbabilitiesOverRates(14, 0, 1);
    expect(p.pass).toBeCloseTo(7 / 15, 12);
    expect(p.between).toBeCloseTo(3 / 15, 12);
    expect(p.kill).toBeCloseTo(5 / 15, 12);
  });

  it('agrees with a seeded Monte Carlo simulation', () => {
    const rng = createSeededRng(20261113);
    const draws = 100_000;
    let pass = 0;
    let kill = 0;
    for (let i = 0; i < draws; i++) {
      const rate = 0.15 + 0.3 * rng();
      let hits = 0;
      for (let j = 0; j < 14; j++) if (rng() < rate) hits++;
      const word = classifyCount(hits);
      if (word === 'PASS') pass++;
      else if (word === 'KILL') kill++;
    }
    const exact = countRuleProbabilitiesOverRates(14, 0.15, 0.45);
    const se = (p: number): number => Math.sqrt((p * (1 - p)) / draws);
    expect(Math.abs(pass / draws - exact.pass)).toBeLessThan(4 * se(exact.pass));
    expect(Math.abs(kill / draws - exact.kill)).toBeLessThan(4 * se(exact.kill));
  });

  it('a zero-width range gives the point probabilities, not NaN', () => {
    expect(countRuleProbabilitiesOverRates(14, 0.3, 0.3)).toEqual(countRuleProbabilities(14, 0.3));
  });

  it('keeps its accuracy on very narrow ranges', () => {
    // The closed form divided a difference of tails by the width: 0.3875 instead of 0.3843 here.
    const point = countRuleProbabilities(14, 0.3);
    const narrow = countRuleProbabilitiesOverRates(14, 0.3, 0.3 + 1e-15);
    expect(narrow.between).toBeCloseTo(point.between, 12);
    expect(narrow.pass).toBeCloseTo(point.pass, 12);
    expect(narrow.kill).toBeCloseTo(point.kill, 12);
  });

  it('agrees with the value at the middle of the range for every narrow width, either side of the switch', () => {
    fc.assert(
      fc.property(
        fc.double({ min: 0, max: 0.99, noNaN: true }),
        fc.constantFrom(1e-16, 1e-13, 1e-10, 1e-7, 0.5 * NARROW_RATE_RANGE, 2 * NARROW_RATE_RANGE, 5e-4),
        fc.integer({ min: 5, max: 40 }),
        (a, w, n) => {
          const p = countRuleProbabilitiesOverRates(n, a, a + w);
          const mid = countRuleProbabilities(n, a + w / 2);
          // |average - value at the middle| <= w^2 max|f''| / 24, and |f''| < n^2 for these tails.
          const tolerance = (w * w * n * n) / 24 + 1e-9;
          expect(Math.abs(p.pass - mid.pass)).toBeLessThanOrEqual(tolerance);
          expect(Math.abs(p.kill - mid.kill)).toBeLessThanOrEqual(tolerance);
          expect(Math.abs(p.pass + p.between + p.kill - 1)).toBeLessThan(1e-9);
        },
      ),
      { numRuns: 200 },
    );
  });

  it('integralOfUpperTail handles k <= 0 and k > n', () => {
    expect(integralOfUpperTail(0, 14, 0.2, 0.5)).toBeCloseTo(0.3, 15);
    expect(integralOfUpperTail(15, 14, 0.2, 0.5)).toBe(0);
  });

  it('rejects reversed or out-of-range rates', () => {
    expect(() => countRuleProbabilitiesOverRates(14, 0.45, 0.15)).toThrow(RangeError);
    expect(() => countRuleProbabilitiesOverRates(14, -0.1, 0.15)).toThrow(RangeError);
    expect(() => countRuleProbabilities(14, 1.2)).toThrow(RangeError);
  });
});

describe('sign-test power quoted in spec 4.4', () => {
  it('20 pairs: the test sees the difference only if the chest wins about 80% of pairs', () => {
    expect(signTestMinWins(20)).toBe(15);
    // P(Bin(20, 0.8) >= 15) = 0.804: 80% power is reached between 79% and 80% wins.
    expect(Math.round(signTestPower(20, 0.8) * 1000) / 1000).toBe(0.804);
    expect(signTestPower(20, 0.8)).toBeGreaterThanOrEqual(0.8);
    expect(signTestPower(20, 0.79)).toBeLessThan(0.8);
    // At 75% wins the test misses the difference almost two times in five.
    expect(Math.round(signTestPower(20, 0.75) * 100)).toBe(62);
  });
});
