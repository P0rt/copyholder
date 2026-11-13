import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { createSeededRng } from './rng.ts';

describe('createSeededRng', () => {
  it('is pinned: the stream for a seed never changes (published numbers depend on it)', () => {
    const rng = createSeededRng(1);
    expect([rng(), rng(), rng()]).toEqual([0.4256499295588583, 0.79042171058245, 0.6910148127935827]);
  });

  it('repeats for the same seed and differs between seeds', () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 2 ** 32 - 1 }), (seed) => {
        const a = createSeededRng(seed);
        const b = createSeededRng(seed);
        const c = createSeededRng(seed + 1);
        const xs = Array.from({ length: 8 }, () => a());
        expect(Array.from({ length: 8 }, () => b())).toEqual(xs);
        expect(Array.from({ length: 8 }, () => c())).not.toEqual(xs);
      }),
    );
  });

  it('draws from [0, 1) with the moments of a uniform distribution', () => {
    const rng = createSeededRng(12345);
    const n = 200_000;
    let sum = 0;
    let sumSq = 0;
    const bins = new Array<number>(10).fill(0);
    let outside = 0;
    for (let i = 0; i < n; i++) {
      const u = rng();
      if (!(u >= 0 && u < 1)) outside++;
      sum += u;
      sumSq += u * u;
      bins[Math.floor(u * 10)] = (bins[Math.floor(u * 10)] as number) + 1;
    }
    expect(outside).toBe(0);
    const mean = sum / n;
    expect(Math.abs(mean - 0.5)).toBeLessThan(4 * Math.sqrt(1 / 12 / n));
    expect(Math.abs(sumSq / n - mean * mean - 1 / 12)).toBeLessThan(0.002);
    // Chi-square goodness of fit on 10 bins, 9 df: far below the 0.999 quantile (27.88).
    const chi2 = bins.reduce((acc, count) => acc + (count - n / 10) ** 2 / (n / 10), 0);
    expect(chi2).toBeLessThan(27.88);
  });

  it('rejects seeds that are not safe integers', () => {
    expect(() => createSeededRng(1.5)).toThrow(RangeError);
    expect(() => createSeededRng(Number.NaN)).toThrow(RangeError);
  });
});
