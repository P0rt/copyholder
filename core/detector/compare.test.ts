// Paired comparison of stops (spec 4.4, 9.6 row 5) and the rival test of spec 7.5 and 13.4: a
// rival that would fire 50 ms after D1 gets a tie or a narrow loss, not "no stop".

import { describe, expect, it } from 'vitest';
import { comparePair, comparePairedStops, firstStopInWindow, stopOnMicScale } from './compare.ts';
import { initDetector, stepMut, type DetectorState } from './d1.ts';
import { d1Posthoc, runPosthoc, type PosthocDetector } from './posthoc.ts';
import { synthSession } from './synth.ts';
import type { DetectorInput, Fire, TracePair } from './types.ts';

const L_RT_MS = 23.5;
const MS = 48; // samples per millisecond

describe('paired comparison (spec 4.4, 9.6 row 5)', () => {
  it('puts a stop on the microphone scale: nSilent + L_rt', () => {
    expect(stopOnMicScale(8_640_384, L_RT_MS)).toBe(8_640_384 + 23.5 * MS);
  });

  it('takes the earliest stop from t_v - W to t_v + 0.5 s, both ends included', () => {
    const nV = 10_000_000;
    expect(firstStopInWindow([nV - 1500 * MS - 1, nV + 500 * MS + 1], nV)).toBeNull();
    expect(firstStopInWindow([nV + 500 * MS, nV - 1500 * MS], nV)).toBe(nV - 1500 * MS);
    expect(firstStopInWindow([nV + 100, nV - 2000, nV - 5000 * MS], nV)).toBe(nV - 2000);
  });

  it('the stop earlier by at least 33 ms wins, no stop loses, the rest ties', () => {
    const n = 5_000_000;
    expect(comparePairedStops(n, n + 50 * MS)).toBe('win');
    expect(comparePairedStops(n + 50 * MS, n)).toBe('loss');
    expect(comparePairedStops(n, n + 33 * MS)).toBe('win');
    expect(comparePairedStops(n, n + 33 * MS - 1)).toBe('tie');
    expect(comparePairedStops(n + 20 * MS, n)).toBe('tie');
    expect(comparePairedStops(null, n)).toBe('loss');
    expect(comparePairedStops(n, null)).toBe('win');
    expect(comparePairedStops(null, null)).toBe('tie');
  });

  it('a stop 50 ms after D1 is a narrow loss, 20 ms after it a tie; without a stop a plain loss', () => {
    const nV = 9_000_000;
    const d1 = nV - 400 * MS;
    const late = comparePair({ nV, lRtMs: L_RT_MS, nSilentA: [d1 + 50 * MS], nSilentB: [d1] });
    expect(late).toEqual({
      a: d1 + 50 * MS + L_RT_MS * MS,
      b: d1 + L_RT_MS * MS,
      outcome: 'loss',
      leadOfAms: -50,
    });
    expect(comparePair({ nV, lRtMs: L_RT_MS, nSilentA: [d1 + 20 * MS], nSilentB: [d1] }).outcome).toBe('tie');
    const none = comparePair({ nV, lRtMs: L_RT_MS, nSilentA: [], nSilentB: [d1] });
    expect(none).toEqual({ a: null, b: d1 + L_RT_MS * MS, outcome: 'loss', leadOfAms: null });
  });
});

interface ScriptState {
  narr: string | null;
}

/** A rival that fires on one packet if the narrator reads then, as the lines it saw say. */
function rivalAt(seq: number): PosthocDetector<ScriptState, string> {
  return {
    name: 'rival',
    init: () => ({ narr: null }),
    step: (s, input) => {
      if (input.k === 'state') return { state: { narr: input.s }, hold: false };
      return { state: s, hold: input.k === 'batch' && input.seq === seq && s.narr === 'narrating' };
    },
  };
}

interface DelayedState {
  inner: DetectorState;
  hist: TracePair[];
}

/** D1 on the trace delayed by delayUs: the same rule, holding about delayUs later. */
function delayedD1(delayUs: number): PosthocDetector<DelayedState, Fire> {
  return {
    name: 'D1, trace 50 ms late',
    ownPostFirePeriod: true,
    init: () => ({ inner: initDetector(), hist: [] }),
    step: (st, input) => {
      if (input.k !== 'batch') return { ...stepMut(st.inner, input), state: st };
      const tr: TracePair[] = [];
      for (const [ts, v] of input.tr) {
        const prev = st.hist[st.hist.length - 1];
        if (prev !== undefined && ts <= prev[0]) continue;
        st.hist.push([ts, v]);
        const at = ts - delayUs;
        let j = st.hist.length - 1;
        while (j > 0 && st.hist[j - 1]![0] > at) j--;
        if (j === 0) continue;
        const [t0, v0] = st.hist[j - 1]!;
        const [t1, v1] = st.hist[j]!;
        tr.push([ts, v0 + ((v1 - v0) * (at - t0)) / (t1 - t0)]);
      }
      if (st.hist.length > 64) st.hist.splice(0, st.hist.length - 64);
      return { ...stepMut(st.inner, { ...input, tr }), state: st };
    },
  };
}

/** Feeds the recorded lines as they are, live stops included: what the own stop model avoids. */
function holdsSeeingLiveStops<S, F>(det: PosthocDetector<S, F>, inputs: readonly DetectorInput[]): number[] {
  let s = det.init();
  const seqs: number[] = [];
  for (const input of inputs) {
    const out = det.step(s, input);
    s = out.state;
    if (out.hold && input.k === 'batch') seqs.push(input.seq);
  }
  return seqs;
}

describe('rival with its own stop model (spec 7.5, 13.4)', () => {
  it('a rival that would fire 50 ms after D1 gets a tie or a narrow loss, not "no stop"', () => {
    for (const seed of [1, 2, 3, 4]) {
      const ses = synthSession({ seed, durationS: 135, objections: [{ atS: 120 }], latencyMs: [80, 80] });
      // The live session: D1 holds, Deck stops and writes its state lines into detector_in.jsonl.
      const live = runPosthoc(ses.inputs, { detector: d1Posthoc(), nArrBySeq: ses.nArrBySeq, keepInputs: true });
      expect(live.stops).toHaveLength(1);
      const recorded = live.inputs!;
      expect(recorded.some((r) => r.k === 'state' && r.s === 'hold_wait')).toBe(true);
      const d1Fire = live.fires[0]!;
      const d1Stop = live.stops[0]!;
      const nV = ses.objections[0]!.voiceOnN;
      expect(stopOnMicScale(d1Stop.nSilent, L_RT_MS)).toBeLessThan(nV); // D1 stopped before the voice

      const rivals: PosthocDetector<unknown, unknown>[] = [
        // Fires on the first packet that arrives at least 50 ms after D1's.
        rivalAt([...ses.nArrBySeq].find(([, n]) => n >= d1Fire.nArr! + 50 * MS)![0]) as PosthocDetector<unknown, unknown>,
        delayedD1(50_000) as PosthocDetector<unknown, unknown>,
      ];
      for (const rival of rivals) {
        // Seeing D1's live stop, the rival would never fire: "no stop".
        expect(holdsSeeingLiveStops(rival, recorded)).toEqual([]);
        // With its own stop model it fires and stops on its own.
        const own = runPosthoc(recorded, { detector: rival, nArrBySeq: ses.nArrBySeq });
        expect(own.stops).toHaveLength(1);
        const stop = own.stops[0]!;
        const delayMs = (stop.nCmd - d1Fire.nArr!) / MS;
        expect(delayMs).toBeGreaterThan(0);
        expect(delayMs).toBeLessThan(100);
        const pair = comparePair({ nV, lRtMs: L_RT_MS, nSilentA: [stop.nSilent], nSilentB: [d1Stop.nSilent] });
        expect(pair.a).not.toBeNull();
        expect(['tie', 'loss']).toContain(pair.outcome);
        expect(pair.leadOfAms!).toBeCloseTo(-delayMs, 9);
      }
    }
  });
});
