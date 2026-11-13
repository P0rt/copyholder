import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { holmAdjustedPValues, holmRejects } from './holm.ts';

describe('Holm step-down correction (spec 4.4: H3 and H4)', () => {
  it('reproduces the results.json example of spec 8.6', () => {
    // One-sided sign tests: chest vs lips 7:4, chest vs 250 ms rule 6:11.
    const adjusted = holmAdjustedPValues([0.2744140625, 0.9282684326171875]);
    expect(adjusted[0]).toBeCloseTo(0.548828125, 15);
    expect(adjusted[1]).toBeCloseTo(0.9282684326171875, 15);
  });

  it('multiplies by the number of remaining hypotheses and keeps the input order', () => {
    expect(holmAdjustedPValues([0.01, 0.04])).toEqual([0.02, 0.04]);
    expect(holmAdjustedPValues([0.04, 0.01])).toEqual([0.04, 0.02]);
  });

  it('enforces monotonicity and caps at 1', () => {
    expect(holmAdjustedPValues([0.03, 0.02])).toEqual([0.04, 0.04]);
    expect(holmAdjustedPValues([0.6, 0.7])).toEqual([1, 1]);
    expect(holmAdjustedPValues([0.3])).toEqual([0.3]);
    expect(holmAdjustedPValues([])).toEqual([]);
  });

  it('rejects step by step at the family-wise level', () => {
    expect(holmRejects([0.01, 0.04])).toEqual([true, true]);
    expect(holmRejects([0.03, 0.04])).toEqual([false, false]);
    expect(holmRejects([0.02, 0.3])).toEqual([true, false]);
  });

  it('never lowers a p-value, stays in [0, 1] and preserves the order of the raw values', () => {
    fc.assert(
      fc.property(fc.array(fc.double({ min: 0, max: 1, noNaN: true }), { minLength: 1, maxLength: 8 }), (ps) => {
        const adj = holmAdjustedPValues(ps);
        ps.forEach((p, i) => {
          const a = adj[i] as number;
          expect(a).toBeGreaterThanOrEqual(p);
          expect(a).toBeLessThanOrEqual(1);
          ps.forEach((q, j) => {
            if (p < q) expect(a).toBeLessThanOrEqual(adj[j] as number);
          });
        });
      }),
    );
  });

  it('rejects invalid p-values', () => {
    expect(() => holmAdjustedPValues([0.1, 1.2])).toThrow(RangeError);
    expect(() => holmAdjustedPValues([Number.NaN])).toThrow(RangeError);
    expect(() => holmRejects([0.1], 0)).toThrow(RangeError);
  });
});
