// Third chance-level estimate of spec 4.3: pseudo onsets after sentence ends without an objection.
import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { type ChestFireMs, isWindowArmed } from './armed.ts';
import type { IntervalMs } from './intervals.ts';
import {
  CATCH_CLOSE_AFTER_SPAN_END_MS,
  type PseudoOnsetSession,
  pseudoOnsetChanceLevel,
  pseudoOnsetPoints,
} from './pseudo.ts';

// Hand-computed session. Active time has two holes that start at a fire (the detector is
// inactive after it, spec 7.4). Latency 1.2 s, W = 1.5 s, objection look-ahead 5 s.
//
// end     point   window            outcome
// 5000    6200    [4700, 6200)      miss: armed, no stop
// 18000   19200   [17700, 19200)    miss: the stop at 20011 is after the point
// 19000   20200   [18700, 20200)    hit: stop 20011; time from the fire at 19980 is exempt
// 21000   22200   [20700, 22200)    not armed: hole [19980, 22000), the fire's stop is before the window
// 30000   -       -                 objection at 31000, within 5 s
// 38900   40100   [38600, 40100)    hit: stop 40031; time from the fire at 40000 is exempt
// 41000   42200   [40700, 42200)    not armed: hole [40000, 42500), no stop at or after 40700
// 50000   51200   [49700, 51200)    miss: the objection at 48000 began before the end
// 52000   -       -                 objection at 57000, exactly 5 s after: still follows
const sessionA: PseudoOnsetSession = {
  sentenceEndsMs: [41_000, 5_000, 18_000, 19_000, 21_000, 30_000, 38_900, 50_000, 52_000],
  objectionOnsetsMs: [31_000, 48_000, 57_000],
  activeMs: [
    { startMs: 0, endMs: 19_980 },
    { startMs: 22_000, endMs: 40_000 },
    { startMs: 42_500, endMs: 60_000 },
  ],
  fires: [
    { fireMs: 19_980, stopMs: 20_011 },
    { fireMs: 40_000, stopMs: 40_031 },
  ],
};

// Three armed points, no fires: three misses.
const sessionB: PseudoOnsetSession = {
  sentenceEndsMs: [4_000, 10_000, 20_000],
  objectionOnsetsMs: [],
  activeMs: [{ startMs: 0, endMs: 30_000 }],
  fires: [],
};

describe('pseudo onsets of one session (spec 4.3)', () => {
  it('classifies the hand-computed case', () => {
    const points = pseudoOnsetPoints(sessionA, { responseLatencyMs: 1200 });
    expect(points).toEqual([
      { sentenceEndMs: 5_000, pointMs: 6_200, outcome: 'miss' },
      { sentenceEndMs: 18_000, pointMs: 19_200, outcome: 'miss' },
      { sentenceEndMs: 19_000, pointMs: 20_200, outcome: 'hit' },
      { sentenceEndMs: 21_000, pointMs: 22_200, outcome: 'not-armed' },
      { sentenceEndMs: 30_000, pointMs: 31_200, outcome: 'objection' },
      { sentenceEndMs: 38_900, pointMs: 40_100, outcome: 'hit' },
      { sentenceEndMs: 41_000, pointMs: 42_200, outcome: 'not-armed' },
      { sentenceEndMs: 50_000, pointMs: 51_200, outcome: 'miss' },
      { sentenceEndMs: 52_000, pointMs: 53_200, outcome: 'objection' },
    ]);
  });

  it('counts the hand-computed case: 2 hits of 5 kept points', () => {
    const r = pseudoOnsetChanceLevel([sessionA], { responseLatencyMs: 1200 });
    expect(r).toEqual({
      share: 0.4,
      sentenceEnds: 9,
      followedByObjection: 2,
      notArmed: 2,
      points: 5,
      hits: 2,
      responseLatencyMs: 1200,
      noObjectionMs: 5000,
      windowMs: 1500,
    });
  });

  it('a stop exactly W before the point counts, a stop at the point does not (t_v - W <= t_s < t_v)', () => {
    const session: PseudoOnsetSession = {
      sentenceEndsMs: [10_500, 29_000],
      objectionOnsetsMs: [],
      activeMs: [{ startMs: 0, endMs: 100_000 }],
      fires: [
        { fireMs: 9_969, stopMs: 10_000 },
        { fireMs: 29_969, stopMs: 30_000 },
      ],
    };
    const outcomes = pseudoOnsetPoints(session, { responseLatencyMs: 1000 }).map((p) => p.outcome);
    expect(outcomes).toEqual(['hit', 'miss']);
  });

  it('a longer catch window turns more sentence ends into "followed by an objection"', () => {
    const r = pseudoOnsetChanceLevel([sessionA], { responseLatencyMs: 1200, noObjectionMs: 8000 });
    // Now also followed: 41000 by the objection at 48000 and 50000 by the one at 57000,
    // both 7 s later. 41000 was a point that was not armed, 50000 a miss.
    expect(r.followedByObjection).toBe(4);
    expect(r.notArmed).toBe(1);
    expect(r.points).toBe(4);
    expect(r.share).toBe(0.5);
    expect(CATCH_CLOSE_AFTER_SPAN_END_MS).toBe(5000);
  });
});

describe('pseudo-onset estimate over sessions', () => {
  it('pools hits and points over all sessions, not the mean of their shares', () => {
    const r = pseudoOnsetChanceLevel([sessionA, sessionB], { responseLatencyMs: 1200 });
    expect(r.points).toBe(8);
    expect(r.hits).toBe(2);
    expect(r.share).toBe(0.25);
  });

  it('no point left: null, not NaN', () => {
    expect(pseudoOnsetChanceLevel([], { responseLatencyMs: 1200 }).share).toBeNull();
    const allObjected: PseudoOnsetSession = { ...sessionB, objectionOnsetsMs: [4_500, 10_100, 21_000] };
    const r = pseudoOnsetChanceLevel([allObjected], { responseLatencyMs: 1200 });
    expect(r).toMatchObject({ share: null, sentenceEnds: 3, followedByObjection: 3, points: 0, hits: 0 });
  });

  it('rejects bad options and bad times', () => {
    expect(() => pseudoOnsetChanceLevel([sessionB], { responseLatencyMs: Number.NaN })).toThrow(RangeError);
    expect(() => pseudoOnsetChanceLevel([sessionB], { responseLatencyMs: 1200, windowMs: 0 })).toThrow(RangeError);
    expect(() => pseudoOnsetChanceLevel([sessionB], { responseLatencyMs: 1200, noObjectionMs: -1 })).toThrow(RangeError);
    expect(() =>
      pseudoOnsetChanceLevel([{ ...sessionB, sentenceEndsMs: [Number.POSITIVE_INFINITY] }], { responseLatencyMs: 1200 }),
    ).toThrow(RangeError);
    expect(() =>
      pseudoOnsetChanceLevel([{ ...sessionB, fires: [{ fireMs: 100, stopMs: 50 }] }], { responseLatencyMs: 1200 }),
    ).toThrow(RangeError);
  });
});

describe('properties of the pseudo-onset estimate', () => {
  const interval = fc
    .tuple(fc.integer({ min: 0, max: 120_000 }), fc.integer({ min: 0, max: 30_000 }))
    .map(([startMs, len]): IntervalMs => ({ startMs, endMs: startMs + len }));
  const fire = fc
    .tuple(fc.integer({ min: 0, max: 120_000 }), fc.integer({ min: 0, max: 60 }))
    .map(([fireMs, lag]): ChestFireMs => ({ fireMs, stopMs: fireMs + lag }));
  const time = fc.integer({ min: 0, max: 120_000 });
  const session = fc.record({
    sentenceEndsMs: fc.array(time, { maxLength: 30 }),
    objectionOnsetsMs: fc.array(time, { maxLength: 6 }),
    activeMs: fc.array(interval, { maxLength: 6 }),
    fires: fc.array(fire, { maxLength: 8 }),
  });
  const latency = fc.integer({ min: 0, max: 4000 });

  it('every outcome follows its definition (independent linear scans)', () => {
    fc.assert(
      fc.property(session, latency, (s, responseLatencyMs) => {
        for (const p of pseudoOnsetPoints(s, { responseLatencyMs })) {
          const followed = s.objectionOnsetsMs.some((o) => o >= p.sentenceEndMs && o <= p.sentenceEndMs + 5000);
          if (followed) {
            expect(p.outcome).toBe('objection');
            continue;
          }
          if (!isWindowArmed(p.pointMs, s.activeMs, s.fires)) {
            expect(p.outcome).toBe('not-armed');
            continue;
          }
          const hit = s.fires.some((f) => f.stopMs >= p.pointMs - 1500 && f.stopMs < p.pointMs);
          expect(p.outcome).toBe(hit ? 'hit' : 'miss');
        }
      }),
      { numRuns: 200 },
    );
  });

  it('the counts add up and the share stays in [0, 1]', () => {
    fc.assert(
      fc.property(fc.array(session, { maxLength: 3 }), latency, (ss, responseLatencyMs) => {
        const r = pseudoOnsetChanceLevel(ss, { responseLatencyMs });
        expect(r.sentenceEnds).toBe(ss.reduce((n, s) => n + s.sentenceEndsMs.length, 0));
        expect(r.followedByObjection + r.notArmed + r.points).toBe(r.sentenceEnds);
        expect(r.hits).toBeLessThanOrEqual(r.points);
        if (r.points === 0) expect(r.share).toBeNull();
        else expect(r.share).toBe(r.hits / r.points);
      }),
      { numRuns: 100 },
    );
  });

  it('does not change when the whole session moves along its clock', () => {
    fc.assert(
      fc.property(session, latency, fc.integer({ min: -50_000, max: 500_000 }), (s, responseLatencyMs, d) => {
        const moved: PseudoOnsetSession = {
          sentenceEndsMs: s.sentenceEndsMs.map((t) => t + d),
          objectionOnsetsMs: s.objectionOnsetsMs.map((t) => t + d),
          activeMs: s.activeMs.map((iv) => ({ startMs: iv.startMs + d, endMs: iv.endMs + d })),
          fires: s.fires.map((f) => ({ fireMs: f.fireMs + d, stopMs: f.stopMs + d })),
        };
        const outcomes = (x: PseudoOnsetSession): string[] => pseudoOnsetPoints(x, { responseLatencyMs }).map((p) => p.outcome);
        expect(outcomes(moved)).toEqual(outcomes(s));
      }),
      { numRuns: 100 },
    );
  });
});
