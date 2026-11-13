import { describe, expect, it } from 'vitest';
import { binomialTestGreaterPValue } from './binomial.ts';
import { largestChanceLevel } from './chance.ts';
import { poissonChanceLevel } from './poisson.ts';
import { pseudoOnsetChanceLevel } from './pseudo.ts';
import { buildShiftSession, circularShiftChanceLevel } from './shift.ts';

describe('chance level used by H1 (spec 4.3: the largest of three estimates)', () => {
  it('takes the largest estimate and names it', () => {
    expect(largestChanceLevel({ poisson: 0.065, shift: 0.05, pseudo: 0.074 })).toEqual({ p0: 0.074, source: 'pseudo' });
    expect(largestChanceLevel({ poisson: 0.065, shift: 0.07, pseudo: 0.01 })).toEqual({ p0: 0.07, source: 'shift' });
  });

  it('breaks ties in spec order: Poisson, shifts, pseudo onsets', () => {
    expect(largestChanceLevel({ poisson: 0.05, shift: 0.05, pseudo: 0.05 }).source).toBe('poisson');
    expect(largestChanceLevel({ poisson: 0.04, shift: 0.05, pseudo: 0.05 }).source).toBe('shift');
  });

  it('refuses a missing or invalid estimate instead of quietly using fewer', () => {
    expect(() => largestChanceLevel({ poisson: 0.05, shift: Number.NaN, pseudo: 0.02 })).toThrow(RangeError);
    expect(() => largestChanceLevel({ poisson: 0.05, shift: 0.03, pseudo: 1.5 })).toThrow(RangeError);
  });

  it('feeds the exact binomial test of H1', () => {
    // Spec 4.3 example rate (32 in 16 min) as the Poisson estimate: p0 = 6.5%.
    const { p0 } = largestChanceLevel({ poisson: poissonChanceLevel(32, 16).p0, shift: 0.05, pseudo: 0.04 });
    expect(Math.round(p0 * 1000) / 10).toBe(6.5);
    expect(binomialTestGreaterPValue(3, 14, p0)).toBeLessThan(0.07);
    expect(binomialTestGreaterPValue(4, 14, p0)).toBeLessThan(0.05);
  });

  it('takes the three estimates from the functions of this module (spec 8.6: chance_*_pct)', () => {
    // One 20-minute session: 30 false stops, two objections.
    const activeMs = [{ startMs: 0, endMs: 1_200_000 }];
    const stopsMs = Array.from({ length: 30 }, (_, i) => 20_000 + i * 39_000);
    const fires = stopsMs.map((stopMs) => ({ fireMs: stopMs - 31, stopMs }));
    const onsetsMs = [300_000, 900_000];
    const poisson = poissonChanceLevel(30, 20).p0;
    const shift = circularShiftChanceLevel([
      buildShiftSession({ activeMs, cutMs: onsetsMs.map((t) => ({ startMs: t - 3000, endMs: t + 4000 })), stopsMs, onsetsMs }),
    ]).share as number;
    const pseudo = pseudoOnsetChanceLevel(
      [{ sentenceEndsMs: Array.from({ length: 200 }, (_, i) => 3_000 + i * 5_900), objectionOnsetsMs: onsetsMs, activeMs, fires }],
      { responseLatencyMs: 1400 },
    ).share as number;
    const used = largestChanceLevel({ poisson, shift, pseudo });
    expect(used.p0).toBe(Math.max(poisson, shift, pseudo));
    // The exact Poisson upper bound is the most cautious here: 30 stops in 20 min give 2.07/min at most.
    expect(used.source).toBe('poisson');
    for (const p of [poisson, shift, pseudo]) expect(p).toBeLessThan(0.06);
  });
});
