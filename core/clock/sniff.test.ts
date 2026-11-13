import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { QUANTUM_SAMPLES, SAMPLE_RATE_HZ, sniffLag, sniffReading, type TracePacket } from './index.ts';
import { censoredMedianOverMs, medianOverFound } from './sniff.ts';

const R = SAMPLE_RATE_HZ;

// One trace sample per frame at 30 frames per second; each packet arrives `latencyS` later.
function packets(chest: (t: number) => number, seconds: number, latencyS = 0.05): TracePacket[] {
  const out: TracePacket[] = [];
  for (let k = 0; k < seconds * 30; k++) {
    const t = k / 30;
    const nArr = Math.ceil(((t + latencyS) * R) / QUANTUM_SAMPLES) * QUANTUM_SAMPLES;
    out.push({ nArr, tr: [[1_000_000_000 + Math.round(t * 1e6), chest(t)]] });
  }
  return out;
}

// The chest steps up by 1.0 at each sniff time plus the trace delay.
function steps(sniffs: readonly number[], delayS: number): (t: number) => number {
  return (t) => (sniffs.some((s) => t >= s + delayS && t < s + delayS + 1) ? 1 : 0);
}

describe('sniffLag (spec 6.3)', () => {
  it('takes the first packet after the onset whose trace rose 0.15 A_ref above the reference', () => {
    const sniffs = [5, 9, 13, 17, 21];
    const p = packets(steps(sniffs, 0.1), 25);
    const onsets = sniffs.map((s) => Math.round(s * R));
    const r = sniffLag({ onsets, packets: p, aRef: 1, lrtMs: 23.4 });
    expect(r.n).toBe(5);
    for (const [i, s] of r.sniffs.entries()) {
      const first = p.find((q) => q.nArr >= onsets[i]! && q.tr[0]![1] >= 0.15)!;
      expect(s.nArr).toBe(first.nArr);
      expect(s.loMs).toBeCloseTo(((first.nArr - onsets[i]!) * 1000) / R, 9);
      expect(s.hiMs).toBeCloseTo(s.loMs! + 23.4, 9);
      expect(s.refLevel).toBe(0);
    }
    expect(r.loMedianMs!).toBeGreaterThan(150);
    expect(r.loMedianMs!).toBeLessThan(190);
    expect(r.calib).toEqual({ n: 5, lo_median: Math.round(r.loMedianMs! * 10) / 10, hi_median: Math.round(r.hiMedianMs! * 10) / 10 });
    expect(r.reading).toBe('BETWEEN');
  });

  it('reads PASS for a fast trace and KILL for a slow one', () => {
    const sniffs = [5, 9, 13];
    const onsets = sniffs.map((s) => Math.round(s * R));
    expect(sniffLag({ onsets, packets: packets(steps(sniffs, 0.02), 17, 0.03), aRef: 1, lrtMs: 20 }).reading).toBe('PASS');
    expect(sniffLag({ onsets, packets: packets(steps(sniffs, 0.4), 17), aRef: 1, lrtMs: 20 }).reading).toBe('KILL');
  });

  it('follows the trace sign', () => {
    const sniffs = [5, 9];
    const onsets = sniffs.map((s) => Math.round(s * R));
    const falling = packets((t) => -steps(sniffs, 0.1)(t), 13);
    // Read with the wrong sign, the trace never rises: both sniffs are found, neither arrives.
    expect(sniffLag({ onsets, packets: falling, aRef: 1, lrtMs: 20 })).toMatchObject({ n: 2, noArrival: 2 });
    expect(sniffLag({ onsets, packets: falling, aRef: 1, lrtMs: 20, sign: -1 })).toMatchObject({ n: 2, noArrival: 0 });
  });

  it('takes the reference from the trace that arrived in the 500 ms before the onset', () => {
    // High until 4.4 s, low from 4.4 s, rise again at 5.1 s.
    const chest = (t: number): number => (t < 4.4 || t >= 5.1 ? 1 : 0);
    const r = sniffLag({ onsets: [5 * R], packets: packets(chest, 8), aRef: 1, lrtMs: 20 });
    expect(r.sniffs[0]!.refLevel).toBe(0);
    expect(r.n).toBe(1);
  });

  it('counts a sniff without a rise within 2 s as found, with no arrival (PREREG §4)', () => {
    const sniffs = [5, 9, 13];
    const p = packets(steps([5, 13], 0.1), 17);
    const r = sniffLag({ onsets: sniffs.map((s) => s * R), packets: p, aRef: 1, lrtMs: 20 });
    expect(r.n).toBe(3);
    expect(r.noArrival).toBe(1);
    expect(r.sniffs.map((s) => s.arrived)).toEqual([true, false, true]);
    expect(r.sniffs[1]!.nArr).toBeNull();
    expect(r.sniffs[1]!.loMs).toBeNull();
    expect(r.sniffs[1]!.refLevel).toBe(0);
  });

  it('extrapolates a linear rise back to its start for the best case', () => {
    // Rises 2 per second from 5.1 s; the 0.15 crossing is seen on the 5.2 s frame.
    const chest = (t: number): number => (t < 5.1 ? 0 : Math.min(1.5, 2 * (t - 5.1)));
    const s = sniffLag({ onsets: [5 * R], packets: packets(chest, 8), aRef: 1, lrtMs: 20 }).sniffs[0]!;
    expect(s.bestCaseMs!).toBeCloseTo(s.loMs! - 100, 3);
  });
});

// PREREG §4: a found sniff whose trace never arrived has a lag over 2 000 ms and enters both
// medians above every measured value; n counts all found sniffs; no arrival at all reads KILL.
describe('sniffLag when the trace never arrives (PREREG §4, spec 9.6 row 4)', () => {
  const sniffs = [5, 9, 13, 17, 21];
  const onsets = sniffs.map((s) => Math.round(s * R));
  const lrtMs = 20;
  // The trace of sniff i rises delays[i] s after its onset; null: it never rises. Packets arrive 0.03 s after the frame.
  const chestOf =
    (delays: ReadonlyArray<number | null>) =>
    (t: number): number =>
      sniffs.some((s, i) => delays[i] != null && t >= s + delays[i]! && t < s + delays[i]! + 1) ? 1 : 0;
  const lagOf = (delays: ReadonlyArray<number | null>, lrt: number | null = lrtMs, count = sniffs.length) =>
    sniffLag({ onsets: onsets.slice(0, count), packets: packets(chestOf(delays), 25, 0.03), aRef: 1, lrtMs: lrt });

  it('all arrive: n 5, none without arrival, the medians of the measured values', () => {
    const r = lagOf([0.03, 0.06, 0.09, 0.04, 0.05]);
    expect([r.n, r.noArrival, r.medianNotArrived, r.medianOverMs]).toEqual([5, 0, false, null]);
    expect(r.sniffs.every((s) => s.arrived)).toBe(true);
    const los = r.sniffs.map((s) => s.loMs!).sort((a, b) => a - b);
    expect(r.loMedianMs).toBe(los[2]);
    expect(r.hiMedianMs).toBeCloseTo(los[2]! + lrtMs, 9);
    expect(r.reading).toBe('PASS');
    expect(r.calib).toEqual({ n: 5, lo_median: Math.round(r.loMedianMs! * 10) / 10, hi_median: Math.round(r.hiMedianMs! * 10) / 10 });
  });

  it('some never arrive, the median still measured: they rank above every measured value and n counts them', () => {
    // Two of five without arrival: the median is the largest of the three measured lags, not their middle one.
    const r = lagOf([0.03, null, 0.25, null, 0.05]);
    expect([r.n, r.noArrival, r.medianNotArrived]).toEqual([5, 2, false]);
    expect(r.sniffs.map((s) => s.arrived)).toEqual([true, false, true, false, true]);
    const los = r.sniffs.filter((s) => s.arrived).map((s) => s.loMs!).sort((a, b) => a - b);
    expect(los[1]).toBeLessThan(los[2]! - 50);
    expect(r.loMedianMs).toBe(los[2]);
    expect(r.hiMedianMs).toBeCloseTo(los[2]! + lrtMs, 9);
    expect(r.reading).toBe('BETWEEN');
    // Dropped, as before, they would have left the middle lag and a PASS.
    expect(sniffReading(los[1]!, los[1]! + lrtMs)).toBe('PASS');
    expect(r.calib).toEqual({ n: 5, lo_median: Math.round(r.loMedianMs! * 10) / 10, hi_median: Math.round(r.hiMedianMs! * 10) / 10 });
  });

  it('some never arrive and the median falls on them: over 2 s, KILL, medians null in calib.json', () => {
    // Three of five without arrival, although every measured lag would PASS.
    const r = lagOf([0.03, null, 0.05, null, null]);
    expect([r.n, r.noArrival, r.medianNotArrived, r.medianOverMs]).toEqual([5, 3, true, 2000]);
    expect(r.sniffs.filter((s) => s.arrived).every((s) => s.hiMs! <= 150)).toBe(true);
    expect([r.loMedianMs, r.hiMedianMs]).toEqual([null, null]);
    expect(r.reading).toBe('KILL');
    expect(r.calib).toEqual({ n: 5, lo_median: null, hi_median: null });
  });

  it('none arrive: KILL with n 5 and all five counted beside it', () => {
    const r = lagOf([null, null, null, null, null]);
    expect([r.n, r.noArrival, r.medianNotArrived, r.medianOverMs]).toEqual([5, 5, true, 2000]);
    expect(r.sniffs.every((s) => !s.arrived && s.loMs === null && s.hiMs === null && s.refLevel === 0)).toBe(true);
    expect(r.reading).toBe('KILL');
    expect(r.bestCaseMedianMs).toBeNull();
    expect(r.calib).toEqual({ n: 5, lo_median: null, hi_median: null });
  });

  it('a rise later than 2 s after the onset is no arrival', () => {
    const r = lagOf([0.03, 2.2, 0.05, 0.04, 0.06]);
    expect(r.sniffs[1]).toMatchObject({ arrived: false, nArr: null });
    expect([r.n, r.noArrival]).toEqual([5, 1]);
  });

  it('an even count: the median falls on a sniff without arrival when the upper middle one does', () => {
    const one = lagOf([0.03, 0.06, 0.09, null], lrtMs, 4);
    expect([one.n, one.noArrival, one.medianNotArrived, one.reading]).toEqual([4, 1, false, 'PASS']);
    const los = one.sniffs.filter((s) => s.arrived).map((s) => s.loMs!).sort((a, b) => a - b);
    expect(one.loMedianMs).toBeCloseTo((los[1]! + los[2]!) / 2, 9);
    const two = lagOf([0.03, null, 0.09, null], lrtMs, 4);
    expect([two.n, two.noArrival, two.medianNotArrived, two.reading]).toEqual([4, 2, true, 'KILL']);
    // The lower middle lag is measured: the median is only known to be over half of 2 s.
    expect([one.medianOverMs, two.medianOverMs]).toEqual([null, 1000]);
    const three = lagOf([0.03, null, null, null], lrtMs, 4);
    expect([three.noArrival, three.medianOverMs]).toEqual([3, 2000]);
  });

  it('a sniff with no trace in the 500 ms before its onset has no arrival either', () => {
    // No packet arrives from 4 s to 6 s: the first sniff has no reference level.
    const p = packets(chestOf([0.03, 0.06, 0.09, 0.04, 0.05]), 25, 0.03).filter((q) => q.nArr < 4 * R || q.nArr >= 6 * R);
    const r = sniffLag({ onsets, packets: p, aRef: 1, lrtMs });
    expect(r.sniffs[0]).toMatchObject({ arrived: false, refLevel: null, nArr: null });
    expect([r.n, r.noArrival]).toEqual([5, 1]);
  });

  it('without a valid L_rt the reading stays null, also when the median did not arrive', () => {
    const r = lagOf([0.03, null, null, null, null], null);
    expect([r.n, r.noArrival, r.medianNotArrived, r.reading]).toEqual([5, 4, true, null]);
    expect(r.calib).toEqual({ n: 5, lo_median: null, hi_median: null });
  });

  it('no sniff found: n 0 and no reading', () => {
    const r = lagOf([], lrtMs, 0);
    expect([r.n, r.noArrival, r.medianNotArrived, r.reading, r.loMedianMs]).toEqual([0, 0, false, null, null]);
    expect(r.calib).toEqual({ n: 0, lo_median: null, hi_median: null });
  });

  it('needs A_ref above 0', () => {
    expect(() => sniffLag({ onsets, packets: [], aRef: 0, lrtMs })).toThrow(/A_ref/);
    expect(() => sniffLag({ onsets, packets: [], aRef: Number.NaN, lrtMs })).toThrow(/A_ref/);
  });
});

describe('medianOverFound (PREREG §4)', () => {
  it('is the plain median without sniffs that never arrived', () => {
    expect(medianOverFound([3, 1, 2], 0)).toBe(2);
    expect(medianOverFound([4, 1, 3, 2], 0)).toBe(2.5);
    expect(medianOverFound([], 0)).toBeNull();
  });

  it('ranks the sniffs that never arrived above every measured value', () => {
    expect(medianOverFound([100, 300, 200], 2)).toBe(300);
    expect(medianOverFound([100, 200], 2)).toBe(Number.POSITIVE_INFINITY);
    expect(medianOverFound([100, 200, 300], 1)).toBe(250);
    expect(medianOverFound([], 3)).toBe(Number.POSITIVE_INFINITY);
    expect(sniffReading(Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY)).toBe('KILL');
  });

  it('never gives a smaller median than leaving those sniffs out', () => {
    fc.assert(
      fc.property(fc.array(fc.double({ min: 0, max: 2000, noNaN: true }), { minLength: 1, maxLength: 9 }), fc.nat({ max: 9 }), (xs, k) => {
        const withThem = medianOverFound(xs, k)!;
        const without = medianOverFound(xs, 0)!;
        return withThem >= without && (2 * k >= xs.length + k) === (withThem === Number.POSITIVE_INFINITY);
      }),
      { numRuns: 200 },
    );
  });
});

describe('censoredMedianOverMs (PREREG §4)', () => {
  it('is 2000 ms when the middle value is a sniff without arrival, 1000 ms when only the upper middle one is', () => {
    expect(censoredMedianOverMs(5, 3)).toBe(2000);
    expect(censoredMedianOverMs(5, null)).toBe(2000);
    expect(censoredMedianOverMs(4, 3)).toBe(2000);
    expect(censoredMedianOverMs(4, 2)).toBe(1000);
    // An even count without the count of sniffs without arrival: only the safe half is known.
    expect(censoredMedianOverMs(4, null)).toBe(1000);
    expect(censoredMedianOverMs(3, 2, 1500)).toBe(1500);
  });

  it('is a lower bound of the median whatever lags the sniffs without arrival had', () => {
    fc.assert(
      fc.property(
        fc.array(fc.double({ min: 0, max: 2000, noNaN: true }), { maxLength: 8 }),
        fc.array(fc.double({ min: 2000.001, max: 1e6, noNaN: true }), { minLength: 1, maxLength: 8 }),
        fc.boolean(),
        (measured, late, countKnown) => {
          if (medianOverFound(measured, late.length) !== Number.POSITIVE_INFINITY) return true;
          const all = [...measured, ...late].sort((a, b) => a - b);
          const mid = all.length >> 1;
          const truth = all.length % 2 === 1 ? all[mid]! : (all[mid - 1]! + all[mid]!) / 2;
          return truth > censoredMedianOverMs(all.length, countKnown ? late.length : null);
        },
      ),
      { numRuns: 200 },
    );
  });
});

describe('sniffReading (spec 9.6 row 4)', () => {
  it('compares the measured medians with the 150 and 350 ms thresholds', () => {
    expect(sniffReading(100, 150)).toBe('PASS');
    // 150.04 prints as 150.0 in calib.json, but the measured hi is above 150 ms.
    expect(sniffReading(100, 150.001)).toBe('BETWEEN');
    expect(sniffReading(100, 150.04)).toBe('BETWEEN');
    expect(sniffReading(100, 150.1)).toBe('BETWEEN');
    expect(sniffReading(350, 380)).toBe('BETWEEN');
    expect(sniffReading(350.001, 380)).toBe('KILL');
    expect(sniffReading(350.1, 380)).toBe('KILL');
    // Float noise (a few 1e-14 ms) is not a crossing.
    expect(sniffReading(100, 150.00000000000003)).toBe('PASS');
    expect(sniffReading(350.00000000000006, 380)).toBe('BETWEEN');
  });
});

describe('sniffLag without a valid L_rt (rule void, spec 6.3)', () => {
  it('keeps n and the lower bounds, and leaves the upper bounds and the reading null', () => {
    const sniffs = [5, 9, 13];
    const onsets = sniffs.map((s) => Math.round(s * R));
    const p = packets(steps(sniffs, 0.1), 17);
    const r = sniffLag({ onsets, packets: p, aRef: 1, lrtMs: null });
    const withLrt = sniffLag({ onsets, packets: p, aRef: 1, lrtMs: 20 });
    expect(r.n).toBe(3);
    expect(r.loMedianMs).toBe(withLrt.loMedianMs);
    expect(r.hiMedianMs).toBeNull();
    expect(r.reading).toBeNull();
    for (const s of r.sniffs) {
      expect(s.loMs).not.toBeNull();
      expect(s.hiMs).toBeNull();
    }
    expect(r.calib).toEqual({ n: 3, lo_median: withLrt.calib.lo_median, hi_median: null });
    expect(withLrt.reading).toBe('BETWEEN');
  });
});
