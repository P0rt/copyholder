// Second chance-level estimate of spec 4.3: circular shifts with a seeded generator.
import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { chanceLevelFromRatePerMin } from './poisson.ts';
import {
  CIRCULAR_SHIFT_COUNT,
  CIRCULAR_SHIFT_SEED,
  SHIFT_CUT_BEFORE_ONSET_MS,
  buildShiftSession,
  circleCoverage,
  circularShiftChanceLevel,
  circularShiftExpectedShare,
  compareShiftSessions,
  hasStopInWindowBefore,
  type ShiftSession,
} from './shift.ts';

describe('constants of spec 4.3', () => {
  it('10 000 shifts, objections cut from 3 s before the voice', () => {
    expect(CIRCULAR_SHIFT_COUNT).toBe(10_000);
    expect(SHIFT_CUT_BEFORE_ONSET_MS).toBe(3_000);
  });
});

describe('buildShiftSession', () => {
  it('cuts the objections out of the active time and maps times onto the circle', () => {
    const s = buildShiftSession({
      activeMs: [{ startMs: 0, endMs: 100_000 }],
      cutMs: [{ startMs: 40_000, endMs: 50_000 }],
      stopsMs: [10_000, 45_000, 60_000],
      onsetsMs: [43_000],
    });
    expect(s.lengthMs).toBe(90_000);
    // The stop at 45 s lies inside the objection and is dropped; 60 s moves to 50 s.
    expect(s.stopsMs).toEqual([10_000, 50_000]);
    // The onset sits where its cut span collapsed.
    expect(s.onsetsMs).toEqual([40_000]);
  });

  it('collapses inactive stretches; a stop just after an active stretch sits at its end', () => {
    const s = buildShiftSession({
      activeMs: [
        { startMs: 30_000, endMs: 40_000 },
        { startMs: 0, endMs: 10_000 },
        { startMs: 5_000, endMs: 20_000 }, // overlaps the second one
      ],
      cutMs: [],
      stopsMs: [20_150, 35_000, 2_000],
      onsetsMs: [25_000],
    });
    expect(s.lengthMs).toBe(30_000);
    expect(s.stopsMs).toEqual([2_000, 20_000, 25_000]);
    expect(s.onsetsMs).toEqual([20_000]);
  });

  it('merges overlapping cuts and wraps a time at the very end to 0', () => {
    const s = buildShiftSession({
      activeMs: [{ startMs: 0, endMs: 60_000 }],
      cutMs: [
        { startMs: 50_000, endMs: 70_000 },
        { startMs: 45_000, endMs: 52_000 },
      ],
      stopsMs: [10_000, 47_000],
      onsetsMs: [48_000],
    });
    expect(s.lengthMs).toBe(45_000);
    expect(s.stopsMs).toEqual([10_000]);
    expect(s.onsetsMs).toEqual([0]);
  });

  it('gives an empty circle when nothing is active', () => {
    const s = buildShiftSession({ activeMs: [], cutMs: [], stopsMs: [5], onsetsMs: [] });
    expect(s).toEqual({ lengthMs: 0, stopsMs: [0], onsetsMs: [] });
  });

  it('rejects reversed intervals and non-finite times', () => {
    expect(() => buildShiftSession({ activeMs: [{ startMs: 5, endMs: 1 }], cutMs: [], stopsMs: [], onsetsMs: [] })).toThrow(RangeError);
    expect(() =>
      buildShiftSession({ activeMs: [{ startMs: 0, endMs: 10 }], cutMs: [], stopsMs: [Number.NaN], onsetsMs: [] }),
    ).toThrow(RangeError);
  });

  it('keeps every mapped time on the circle and the length equal to the kept time', () => {
    const interval = fc
      .tuple(fc.integer({ min: 0, max: 500_000 }), fc.integer({ min: 0, max: 60_000 }))
      .map(([startMs, len]) => ({ startMs, endMs: startMs + len }));
    fc.assert(
      fc.property(
        fc.array(interval, { minLength: 1, maxLength: 8 }),
        fc.array(interval, { maxLength: 5 }),
        fc.array(fc.integer({ min: 0, max: 600_000 }), { maxLength: 20 }),
        (activeMs, cutMs, times) => {
          const s = buildShiftSession({ activeMs, cutMs, stopsMs: times, onsetsMs: times });
          // Kept time, measured independently over the elementary segments between all endpoints.
          const edges = [...new Set([...activeMs, ...cutMs].flatMap((iv) => [iv.startMs, iv.endMs]))].sort((a, b) => a - b);
          let kept = 0;
          for (let i = 0; i + 1 < edges.length; i++) {
            const a = edges[i] as number;
            const b = edges[i + 1] as number;
            const mid = (a + b) / 2;
            const isActive = activeMs.some((iv) => mid >= iv.startMs && mid < iv.endMs);
            const isCut = cutMs.some((iv) => mid >= iv.startMs && mid < iv.endMs);
            if (isActive && !isCut) kept += b - a;
          }
          expect(s.lengthMs).toBe(kept);
          for (const t of [...s.stopsMs, ...s.onsetsMs]) {
            expect(t).toBeGreaterThanOrEqual(0);
            if (s.lengthMs > 0) expect(t).toBeLessThan(s.lengthMs);
          }
          expect([...s.stopsMs].sort((a, b) => a - b)).toEqual(s.stopsMs);
        },
      ),
      { numRuns: 60 },
    );
  });
});

describe('stop in the window before an onset', () => {
  it('uses t_v - W <= t_s < t_v (spec 4.2), wrapping round the circle', () => {
    const L = 100_000;
    expect(hasStopInWindowBefore([10_000], 11_500, 1500, L)).toBe(true); // exactly W before
    expect(hasStopInWindowBefore([10_000], 11_501, 1500, L)).toBe(false);
    expect(hasStopInWindowBefore([10_000], 10_000, 1500, L)).toBe(false); // at the onset: not before it
    expect(hasStopInWindowBefore([10_000, 10_500], 10_500, 1500, L)).toBe(true);
    expect(hasStopInWindowBefore([99_500], 500, 1500, L)).toBe(true); // wraps
    expect(hasStopInWindowBefore([], 500, 1500, L)).toBe(false);
  });

  it('covered fraction of the circle', () => {
    expect(circleCoverage([], 1500, 60_000)).toBe(0);
    expect(circleCoverage([1000], 1500, 60_000)).toBe(0.025);
    expect(circleCoverage([1000, 2000], 1500, 60_000)).toBe(2500 / 60_000); // arcs overlap
    expect(circleCoverage([0, 59_000], 1500, 60_000)).toBe(2500 / 60_000); // overlap across 0
    expect(circleCoverage([0, 20_000, 40_000], 30_000, 60_000)).toBe(1);
  });
});

describe('circularShiftChanceLevel', () => {
  // Three sessions of about 5 minutes with irregular false stops.
  const sessions: ShiftSession[] = [
    { lengthMs: 300_000, stopsMs: [12_000, 13_000, 95_000, 180_500, 250_000], onsetsMs: [20_000, 60_000, 140_000, 200_000] },
    { lengthMs: 280_000, stopsMs: [40_000, 41_200, 41_900, 200_000], onsetsMs: [10_000, 100_000, 150_000] },
    { lengthMs: 320_000, stopsMs: [], onsetsMs: [50_000, 250_000] },
  ];

  it('uses the fixed seed by default and converges to the exact expectation', () => {
    const a = circularShiftChanceLevel(sessions);
    expect(a).toEqual(circularShiftChanceLevel(sessions, { seed: CIRCULAR_SHIFT_SEED }));
    expect(a.seed).toBe(CIRCULAR_SHIFT_SEED);
    expect(a.shifts).toBe(10_000);
    expect(a.windowMs).toBe(1500);
    expect(a.onsets).toBe(9);
    expect(a.share).toBe(a.hits / (10_000 * 9));
    const expected = circularShiftExpectedShare(sessions) as number;
    // Covered arcs: 1000 + 4 x 1500 ms of 300 s, and 1200 + 700 + 2 x 1500 ms of 280 s.
    expect(expected).toBeCloseTo((4 * (7000 / 300_000) + 3 * (4900 / 280_000)) / 9, 15);
    expect(Math.abs((a.share as number) - expected)).toBeLessThan(4 * (a.standardError as number));
    expect(a.standardError).toBeGreaterThan(0);
  });

  it('is pinned: the published estimate for given data never changes silently', () => {
    // A change of seed, generator, session order or window rule shows up here.
    const r = circularShiftChanceLevel(sessions);
    expect(r.hits).toBe(1438);
    expect(r.share).toBe(1438 / 90_000);
  });

  it('does not depend on the order of the sessions or of the onsets inside one', () => {
    const a = circularShiftChanceLevel(sessions);
    const reordered: ShiftSession[] = [
      { ...(sessions[2] as ShiftSession), onsetsMs: [250_000, 50_000] },
      sessions[0] as ShiftSession,
      { ...(sessions[1] as ShiftSession), onsetsMs: [150_000, 10_000, 100_000] },
    ];
    expect(circularShiftChanceLevel(reordered)).toEqual(a);
    expect(circularShiftChanceLevel([...sessions].reverse())).toEqual(a);
    // Sessions without onsets draw no shifts and change nothing.
    expect(circularShiftChanceLevel([{ lengthMs: 90_000, stopsMs: [1000], onsetsMs: [] }, ...sessions])).toEqual(a);
  });

  it('orders sessions by content', () => {
    const s = (lengthMs: number, onsetsMs: number[], stopsMs: number[] = []): ShiftSession => ({ lengthMs, onsetsMs, stopsMs });
    expect(compareShiftSessions(s(100, [5]), s(200, [5]))).toBeLessThan(0);
    expect(compareShiftSessions(s(100, [5, 7]), s(100, [5]))).toBeGreaterThan(0);
    expect(compareShiftSessions(s(100, [7, 5]), s(100, [5, 8]))).toBeLessThan(0);
    expect(compareShiftSessions(s(100, [7, 5]), s(100, [5, 7]))).toBe(0);
    expect(compareShiftSessions(s(100, [5], [1, 2]), s(100, [5], [1, 3]))).toBeLessThan(0);
  });

  it('another seed gives another estimate of the same expectation (exploratory runs only)', () => {
    const a = circularShiftChanceLevel(sessions);
    const b = circularShiftChanceLevel(sessions, { seed: 8 });
    expect(b.seed).toBe(8);
    expect(b.share).not.toBe(a.share);
    const expected = circularShiftExpectedShare(sessions) as number;
    expect(Math.abs((b.share as number) - expected)).toBeLessThan(4 * (b.standardError as number));
  });

  it('matches the Poisson formula on an evenly spread stream of false stops', () => {
    // One false stop per minute for 16 minutes: the arcs never overlap, so the share is 1.5 s / 60 s.
    const stopsMs = Array.from({ length: 16 }, (_, i) => i * 60_000 + 17_000);
    const s: ShiftSession = { lengthMs: 16 * 60_000, stopsMs, onsetsMs: [100_000, 400_000, 700_000] };
    expect(circularShiftExpectedShare([s])).toBeCloseTo(0.025, 15);
    expect(Math.abs(0.025 - chanceLevelFromRatePerMin(1))).toBeLessThan(0.001);
    const r = circularShiftChanceLevel([s], { seed: 1, shifts: 20_000 });
    expect(Math.abs((r.share as number) - 0.025)).toBeLessThan(4 * (r.standardError as number));
  });

  it('with every onset covered the share is 1, with no stops it is 0', () => {
    const full: ShiftSession = { lengthMs: 3000, stopsMs: [0, 1000, 2000], onsetsMs: [500, 2500] };
    const r = circularShiftChanceLevel([full], { shifts: 200 });
    expect(r.share).toBe(1);
    expect(r.standardError).toBe(0);
    const none: ShiftSession = { lengthMs: 3000, stopsMs: [], onsetsMs: [500] };
    expect(circularShiftChanceLevel([none], { shifts: 200 }).share).toBe(0);
  });

  it('no onsets: null, not NaN', () => {
    const r = circularShiftChanceLevel([{ lengthMs: 60_000, stopsMs: [5], onsetsMs: [] }]);
    expect(r.share).toBeNull();
    expect(r.standardError).toBeNull();
    expect(r.hits).toBe(0);
    expect(circularShiftExpectedShare([])).toBeNull();
  });

  it('rejects onsets without active time, times off the circle and bad options', () => {
    expect(() => circularShiftChanceLevel([{ lengthMs: 0, stopsMs: [], onsetsMs: [0] }])).toThrow(RangeError);
    expect(() => circularShiftChanceLevel([{ lengthMs: 100, stopsMs: [100], onsetsMs: [5] }])).toThrow(RangeError);
    expect(() => circularShiftChanceLevel([{ lengthMs: 100, stopsMs: [50, 10], onsetsMs: [5] }])).toThrow(RangeError);
    expect(() => circularShiftChanceLevel([{ lengthMs: 100, stopsMs: [], onsetsMs: [5] }], { shifts: 0 })).toThrow(RangeError);
    expect(() => circularShiftChanceLevel([{ lengthMs: 100, stopsMs: [], onsetsMs: [5] }], { windowMs: 0 })).toThrow(RangeError);
    expect(() => circularShiftChanceLevel([{ lengthMs: 100, stopsMs: [], onsetsMs: [5] }], { seed: 1.5 })).toThrow(RangeError);
  });

  it('stays within [0, 1] and near its expectation for random sessions', () => {
    const sessionArb = fc
      .tuple(
        fc.integer({ min: 10_000, max: 600_000 }),
        fc.array(fc.double({ min: 0, max: 1, maxExcluded: true, noNaN: true }), { maxLength: 30 }),
        fc.array(fc.double({ min: 0, max: 1, maxExcluded: true, noNaN: true }), { minLength: 1, maxLength: 10 }),
      )
      .map(([lengthMs, stops, onsets]) => ({
        lengthMs,
        stopsMs: stops.map((u) => u * lengthMs).sort((a, b) => a - b),
        onsetsMs: onsets.map((u) => u * lengthMs),
      }));
    fc.assert(
      fc.property(fc.array(sessionArb, { minLength: 1, maxLength: 4 }), fc.integer({ min: 0, max: 1000 }), (ss, seed) => {
        const r = circularShiftChanceLevel(ss, { seed, shifts: 2000 });
        const e = circularShiftExpectedShare(ss) as number;
        const share = r.share as number;
        expect(share).toBeGreaterThanOrEqual(0);
        expect(share).toBeLessThanOrEqual(1);
        // The per-round share lies in [0, 1] with mean e, so its variance is at most e(1 - e).
        expect(Math.abs(share - e)).toBeLessThanOrEqual(6 * Math.sqrt((e * (1 - e)) / 2000) + 1e-12);
        // Same result whatever the order of the sessions.
        expect(circularShiftChanceLevel([...ss].reverse(), { seed, shifts: 2000 })).toEqual(r);
      }),
      { numRuns: 40 },
    );
  });
});
