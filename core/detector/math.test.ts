import { describe, expect, it } from 'vitest';
import {
  gridIndexAtOrAfter,
  gridIndexAtOrBefore,
  insertSorted,
  lsSlopeWeights,
  mad,
  median,
  mulberry32,
  percentileSorted,
  removeSorted,
} from './math.ts';

describe('median and MAD', () => {
  it('takes the middle value, or the mean of the two middle values', () => {
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 3, 2])).toBe(2.5);
    expect(() => median([])).toThrow();
  });

  it('MAD is the median absolute deviation from the median', () => {
    expect(mad([1, 2, 3, 4, 100])).toBe(1);
    expect(mad([5, 5, 5])).toBe(0);
  });
});

describe('percentileSorted', () => {
  it('interpolates between order statistics', () => {
    const s = Float64Array.from([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(percentileSorted(s, 11, 0.1)).toBeCloseTo(1, 12);
    expect(percentileSorted(s, 11, 0.9)).toBeCloseTo(9, 12);
    expect(percentileSorted(s, 2, 0.5)).toBeCloseTo(0.5, 12);
    expect(percentileSorted(s, 1, 0.9)).toBe(0);
  });
});

describe('sorted insert and remove', () => {
  it('keeps the array sorted through random inserts and removals', () => {
    const rng = mulberry32(7);
    const arr = new Float64Array(200);
    const ref: number[] = [];
    let count = 0;
    for (let k = 0; k < 2000; k++) {
      if (count < 200 && (count === 0 || rng() < 0.6)) {
        const x = Math.round(rng() * 50) / 10;
        insertSorted(arr, count++, x);
        ref.push(x);
      } else {
        const x = ref.splice(Math.floor(rng() * ref.length), 1)[0]!;
        expect(removeSorted(arr, count--, x)).toBe(true);
      }
      ref.sort((a, b) => a - b);
      expect(Array.from(arr.subarray(0, count))).toEqual(ref);
    }
    expect(removeSorted(arr, count, 123.456)).toBe(false);
  });
});

describe('least-squares slope weights', () => {
  it('recover the slope of a line for any window length', () => {
    for (const L of [2, 3, 4, 5, 7]) {
      const w = lsSlopeWeights(L, 30);
      let slope = 0;
      for (let j = 0; j < L; j++) slope += w[j]! * (0.7 * (j / 30) - 3);
      expect(slope).toBeCloseTo(0.7, 10);
    }
    expect(Array.from(lsSlopeWeights(5, 30))).toEqual([-6, -3, 0, 3, 6]);
  });
});

describe('grid indices', () => {
  it('are exact on grid points of a 30 Hz grid', () => {
    expect(gridIndexAtOrBefore(0, 30)).toBe(0);
    expect(gridIndexAtOrBefore(33_333, 30)).toBe(0);
    expect(gridIndexAtOrBefore(33_334, 30)).toBe(1);
    expect(gridIndexAtOrBefore(100_000, 30)).toBe(3);
    expect(gridIndexAtOrAfter(100_000, 30)).toBe(3);
    expect(gridIndexAtOrAfter(100_001, 30)).toBe(4);
    expect(gridIndexAtOrAfter(1, 30)).toBe(1);
    for (let i = 0; i < 100_000; i += 997) {
      const us = Math.round((i * 1e6) / 30);
      expect(gridIndexAtOrBefore(us + 1, 30)).toBe(i);
      expect(gridIndexAtOrAfter(us - 1, 30)).toBe(i);
    }
  });
});
