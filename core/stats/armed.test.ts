// The "window lies in active time" rule of spec 4.3 (also spec 4.5 and the `armed` of 9.7).
import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { type ChestFireMs, armedCheckEndMs, isWindowArmed } from './armed.ts';
import type { IntervalMs } from './intervals.ts';

const W = 1500;

describe('window [t - W, t) in active time, no fires', () => {
  const active: IntervalMs[] = [
    { startMs: 0, endMs: 10_000 },
    { startMs: 12_000, endMs: 20_000 },
  ];

  it('is armed inside one active stretch, with both ends on its edges (half-open)', () => {
    expect(isWindowArmed(5_000, active, [])).toBe(true);
    expect(isWindowArmed(13_500, active, [])).toBe(true); // window starts at 12 000
    expect(isWindowArmed(10_000, active, [])).toBe(true); // window ends at 10 000, exclusive
    expect(isWindowArmed(20_000, active, [])).toBe(true);
  });

  it('is not armed across a gap or outside active time', () => {
    expect(isWindowArmed(10_001, active, [])).toBe(false);
    expect(isWindowArmed(13_499, active, [])).toBe(false);
    expect(isWindowArmed(30_000, active, [])).toBe(false);
    expect(isWindowArmed(1_000, active, [])).toBe(false); // window starts at -500
    expect(isWindowArmed(5_000, [], [])).toBe(false);
  });

  it('merges touching and overlapping stretches given in any order', () => {
    const pieces: IntervalMs[] = [
      { startMs: 9_000, endMs: 9_600 },
      { startMs: 8_000, endMs: 9_000 },
      { startMs: 9_500, endMs: 11_000 },
    ];
    expect(isWindowArmed(10_000, pieces, [])).toBe(true);
  });
});

describe('time after a fire whose stop falls in the window or later is not checked', () => {
  // The detector is inactive for 2.0 s after the fire at 45 000 (spec 7.4).
  const active: IntervalMs[] = [
    { startMs: 0, endMs: 45_000 },
    { startMs: 47_000, endMs: 60_000 },
  ];

  it('fire and stop inside the window: the inactive time after the fire is exempt', () => {
    const fires: ChestFireMs[] = [{ fireMs: 45_000, stopMs: 45_031 }];
    expect(armedCheckEndMs(46_000, fires, W)).toBe(45_000);
    expect(isWindowArmed(46_000, active, fires)).toBe(true);
    expect(isWindowArmed(46_000, active, [])).toBe(false);
  });

  it('fire inside the window, stop after it ("or later"): exempt as well', () => {
    const fires: ChestFireMs[] = [{ fireMs: 45_000, stopMs: 46_031 }];
    expect(isWindowArmed(46_000, active, fires)).toBe(true);
  });

  it('fire before the window, stop inside it: the whole window is exempt', () => {
    const fires: ChestFireMs[] = [{ fireMs: 44_480, stopMs: 44_511 }];
    expect(armedCheckEndMs(46_000, fires, W)).toBe(44_480);
    expect(isWindowArmed(46_000, [], fires)).toBe(true);
  });

  it('a stop before the window exempts nothing', () => {
    const fires: ChestFireMs[] = [{ fireMs: 44_000, stopMs: 44_031 }];
    expect(armedCheckEndMs(46_000, fires, W)).toBe(46_000);
    expect(isWindowArmed(46_000, active, fires)).toBe(false);
  });

  it('inactive time before the fire still drops the window', () => {
    const gappy: IntervalMs[] = [
      { startMs: 0, endMs: 44_700 },
      { startMs: 44_800, endMs: 45_000 },
      { startMs: 47_000, endMs: 60_000 },
    ];
    expect(isWindowArmed(46_000, gappy, [{ fireMs: 45_000, stopMs: 45_031 }])).toBe(false);
  });

  it('the earliest qualifying fire sets the end of the check', () => {
    const fires: ChestFireMs[] = [
      { fireMs: 45_900, stopMs: 45_931 },
      { fireMs: 45_000, stopMs: 45_031 },
      { fireMs: 50_000, stopMs: 50_031 },
    ];
    expect(armedCheckEndMs(46_000, fires, W)).toBe(45_000);
  });

  it('rejects a stop before its fire, non-finite times and a bad window', () => {
    expect(() => isWindowArmed(46_000, active, [{ fireMs: 45_000, stopMs: 44_000 }])).toThrow(RangeError);
    expect(() => isWindowArmed(46_000, active, [{ fireMs: Number.NaN, stopMs: 1 }])).toThrow(RangeError);
    expect(() => isWindowArmed(Number.NaN, active, [])).toThrow(RangeError);
    expect(() => isWindowArmed(46_000, active, [], 0)).toThrow(RangeError);
    expect(() => isWindowArmed(46_000, [{ startMs: 5, endMs: 1 }], [])).toThrow(RangeError);
  });
});

describe('properties of the rule', () => {
  const interval = fc
    .tuple(fc.integer({ min: 0, max: 60_000 }), fc.integer({ min: 0, max: 8_000 }))
    .map(([startMs, len]): IntervalMs => ({ startMs, endMs: startMs + len }));
  const fire = fc
    .tuple(fc.integer({ min: 0, max: 60_000 }), fc.integer({ min: 0, max: 100 }))
    .map(([fireMs, lag]): ChestFireMs => ({ fireMs, stopMs: fireMs + lag }));

  // Independent check: the window is covered when the active length inside it equals W.
  function coveredLength(active: readonly IntervalMs[], startMs: number, endMs: number): number {
    const edges = [...new Set([startMs, endMs, ...active.flatMap((iv) => [iv.startMs, iv.endMs])])]
      .filter((e) => e >= startMs && e <= endMs)
      .sort((a, b) => a - b);
    let covered = 0;
    for (let i = 0; i + 1 < edges.length; i++) {
      const a = edges[i] as number;
      const b = edges[i + 1] as number;
      const mid = (a + b) / 2;
      if (active.some((iv) => mid >= iv.startMs && mid < iv.endMs)) covered += b - a;
    }
    return covered;
  }

  it('without fires, armed exactly when active time covers the whole window', () => {
    fc.assert(
      fc.property(fc.array(interval, { maxLength: 8 }), fc.integer({ min: 0, max: 70_000 }), (active, t) => {
        expect(isWindowArmed(t, active, [])).toBe(coveredLength(active, t - W, t) === W);
      }),
      { numRuns: 200 },
    );
  });

  it('adding fires never drops a window that was armed', () => {
    fc.assert(
      fc.property(
        fc.array(interval, { maxLength: 8 }),
        fc.array(fire, { maxLength: 4 }),
        fc.array(fire, { maxLength: 4 }),
        fc.integer({ min: 0, max: 70_000 }),
        (active, some, more, t) => {
          if (isWindowArmed(t, active, some)) expect(isWindowArmed(t, active, [...some, ...more])).toBe(true);
        },
      ),
      { numRuns: 200 },
    );
  });
});
