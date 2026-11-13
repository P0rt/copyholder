import { describe, expect, it } from 'vitest';
import { gaussian, mulberry32 } from './math.ts';
import { polaritySign, type CueWindow } from './polarity.ts';
import type { TracePair } from './types.ts';

const T0 = 1_794_935_000_000_000;

/**
 * Three cued deep breaths as in the scenario (spec 7.4 table, 10.4): 2 s inhale, 4 s exhale,
 * the first cue at 5 s. raw = polarity * depth * level + noise, sampled at 30 Hz with jitter.
 */
function cuedBreaths(depths: readonly number[], polarity: 1 | -1, seed = 1): { samples: TracePair[]; cues: CueWindow[] } {
  const rng = mulberry32(seed);
  const cues: CueWindow[] = depths.map((_, i) => ({ startUs: T0 + (5 + 6 * i) * 1e6, endUs: T0 + (7 + 6 * i) * 1e6 }));
  const level = (tS: number): number => {
    for (const [i, d] of depths.entries()) {
      const u = tS - (5 + 6 * i);
      if (u >= 0 && u < 2) return (d * (1 - Math.cos((Math.PI * u) / 2))) / 2;
      if (u >= 2 && u < 6) return (d * (1 + Math.cos((Math.PI * (u - 2)) / 4))) / 2;
    }
    return 0;
  };
  const samples: TracePair[] = [];
  for (let f = 0; f < 30 * 26; f++) {
    const ts = T0 + Math.round((f * 1e6) / 30 + (rng() * 2 - 1) * 2000);
    const tS = (ts - T0) / 1e6;
    samples.push([ts, polarity * level(tS) - 0.4 + 0.01 * gaussian(rng)]);
  }
  return { samples, cues };
}

describe('trace sign from the cued deep breaths (spec 7.4)', () => {
  it('is +1 when the inhale raises the trace and -1 when it lowers it', () => {
    for (const polarity of [1, -1] as const) {
      const { samples, cues } = cuedBreaths([1, 0.8, 1.2], polarity);
      const r = polaritySign(samples, cues);
      expect(r.sign).toBe(polarity);
      expect(r.agree).toBe(true);
      expect(r.margin).toBe(true);
      expect(r.d).toHaveLength(3);
      // d is the median 0.5 s around the end of the cue minus the median around its start.
      [1, 0.8, 1.2].forEach((depth, i) => {
        expect(polarity * r.d[i]!).toBeGreaterThan(0.8 * depth);
        expect(polarity * r.d[i]!).toBeLessThan(1.05 * depth);
      });
    }
  });

  it('has no margin when the smallest |d| is under a third of the largest', () => {
    const { samples, cues } = cuedBreaths([1, 0.25, 1], 1);
    const r = polaritySign(samples, cues);
    expect(r.sign).toBe(1);
    expect(r.agree).toBe(true);
    expect(r.margin).toBe(false);
  });

  it('has a margin from a third of the largest |d| up, not below it', () => {
    const cues: CueWindow[] = [0, 1, 2].map((i) => ({ startUs: T0 + (5 + 6 * i) * 1e6, endUs: T0 + (7 + 6 * i) * 1e6 }));
    // Level 0 around each cue start and d_i around its end: the medians give d exactly.
    const steps = (d: readonly number[]): TracePair[] =>
      Array.from({ length: 30 * 26 }, (_, f): TracePair => {
        const ts = T0 + Math.round((f * 1e6) / 30);
        const i = cues.findIndex((c) => Math.abs(ts - c.endUs) <= 500_000);
        return [ts, i >= 0 ? d[i]! : 0];
      });
    expect(polaritySign(steps([1, 1, 0.34]), cues)).toEqual({ sign: 1, d: [1, 1, 0.34], agree: true, margin: true });
    expect(polaritySign(steps([1, 1, 0.3]), cues)).toEqual({ sign: 1, d: [1, 1, 0.3], agree: true, margin: false });
    expect(polaritySign(steps([-0.34, -1, -1]), cues)).toEqual({ sign: -1, d: [-0.34, -1, -1], agree: true, margin: true });
    expect(polaritySign(steps([-0.3, -1, -1]), cues).margin).toBe(false);
  });

  it('is undefined when the three breaths disagree', () => {
    const { samples, cues } = cuedBreaths([1, 1, 1], 1);
    // The second cue is marked where the trace falls: its d has the other sign.
    const shifted: CueWindow[] = cues.map((c, i) => (i === 1 ? { startUs: c.endUs, endUs: c.endUs + 2e6 } : c));
    const r = polaritySign(samples, shifted);
    expect(r.d[1]!).toBeLessThan(0);
    expect(r.agree).toBe(false);
    expect(r.sign).toBeNull();
  });

  it('is undefined when a window has no samples or a cue is missing', () => {
    const { samples, cues } = cuedBreaths([1, 1, 1], 1);
    const gap = samples.filter(([t]) => t < cues[2]!.startUs - 300_000 || t > cues[2]!.startUs + 300_000);
    const r = polaritySign(gap, cues);
    expect(Number.isNaN(r.d[2]!)).toBe(true);
    expect(r).toMatchObject({ sign: null, agree: false, margin: false });
    const two = polaritySign(samples, cues.slice(0, 2));
    expect(two).toMatchObject({ sign: null, agree: false });
  });
});
