import { describe, expect, it } from 'vitest';
import {
  initDetector,
  memoryStats,
  runDetectorFile,
  step,
  stepMut,
  thetaFrom,
  type Breath,
  type DetectorRun,
  type DetectorState,
} from './d1.ts';
import { resolveD1Params, type D1ParamsInput } from './params.ts';
import { synthSession, type SynthOptions, type SynthSession } from './synth.ts';
import type { BatchInput, DetectorInput, Fire, Variant } from './types.ts';

const T0 = 1_794_935_000_000_000;
const FRAME_US = 1e6 / 30;

const batch = (seq: number, tr: [number, number][]): BatchInput => ({ k: 'batch', seq, tr });

/** Trace f(t) sampled on exact 30 Hz timestamps from fromS to toS. */
function traceInputs(f: (tS: number) => number, fromS: number, toS: number, seq0 = 1): BatchInput[] {
  const out: BatchInput[] = [];
  for (let k = Math.ceil(fromS * 30); k <= Math.floor(toS * 30); k++) {
    out.push(batch(seq0 + k, [[T0 + Math.round(k * FRAME_US), f(k / 30)]]));
  }
  return out;
}

/** One packet per value on exact 30 Hz timestamps: value k is the trace at grid point k. */
function frameInputs(values: readonly number[]): BatchInput[] {
  return values.map((v, k) => batch(k + 1, [[T0 + Math.round(k * FRAME_US), v]]));
}

const triangle = (tS: number): number => {
  const ph = (tS % 4) / 4;
  return ph < 0.5 ? 2 * ph : 2 - 2 * ph;
};

const fireS = (ses: SynthSession, tsUs: number): number => (tsUs - ses.t0Us) / 1e6;
/** Camera time of a sample or fire on the exact traces below, s. */
const camS = (tsUs: number): number => (tsUs - T0) / 1e6;

function run(o: SynthOptions, params: D1ParamsInput = {}, variant: Variant = 'D1'): { ses: SynthSession; r: DetectorRun } {
  const ses = synthSession(o);
  return { ses, r: runDetectorFile(ses.inputs, params, 1, variant) };
}

const reading: DetectorInput = { k: 'state', n: 0, s: 'narrating' };
const voiceEdge = (on: boolean): DetectorInput => ({ k: 'voice', n: 0, on });

/**
 * One clean breath: cosine inhale from `from` (default 0) up by depth, cosine exhale down to `to`
 * (default 0), then flat for holdS (default 0).
 */
interface Cycle {
  inS: number;
  exS: number;
  depth: number;
  from?: number;
  to?: number;
  holdS?: number;
}

/** Clean breathing on exact 30 Hz timestamps from the given cycles; flat after the last one. */
function breathing(cycles: readonly Cycle[]): (tS: number) => number {
  const starts: number[] = [];
  let t = 0;
  for (const c of cycles) {
    starts.push(t);
    t += c.inS + c.exS + (c.holdS ?? 0);
  }
  return (tS) => {
    let k = starts.length - 1;
    while (k > 0 && starts[k]! > tS) k--;
    const c = cycles[k]!;
    const u = tS - starts[k]!;
    const from = c.from ?? 0;
    const peak = from + c.depth;
    const to = c.to ?? 0;
    if (u < c.inS) return from + ((peak - from) * (1 - Math.cos((Math.PI * u) / c.inS))) / 2;
    if (u < c.inS + c.exS) return to + ((peak - to) * (1 + Math.cos((Math.PI * (u - c.inS)) / c.exS))) / 2;
    return to;
  };
}

/** Ordinary 4 s cycles; depths vary by +-2% from breath to breath so that s_q is small but not zero. */
const ordinary = (n: number): Cycle[] =>
  Array.from({ length: n }, (_, k) => ({ inS: 1.6, exS: 2.4, depth: 1 + 0.02 * Math.sin(k * 2.3) }));

/** Puts each line right before the first packet whose first sample is at or after atS. */
function insertBefore(inputs: readonly DetectorInput[], lines: readonly { atS: number; input: DetectorInput }[]): DetectorInput[] {
  const rest = [...lines].sort((a, b) => a.atS - b.atS);
  const out: DetectorInput[] = [];
  for (const r of inputs) {
    if (r.k === 'batch') {
      const t = camS(r.tr[0]![0]);
      while (rest.length > 0 && rest[0]!.atS <= t) out.push(rest.shift()!.input);
    }
    out.push(r);
  }
  return [...out, ...rest.map((l) => l.input)];
}

/** Every breath that entered memory, in order. */
function admittedBreaths(inputs: readonly DetectorInput[], params: D1ParamsInput = {}, variant: Variant = 'D1'): Breath[] {
  const s = initDetector(params, 1, variant);
  const out: Breath[] = [];
  for (const input of inputs) {
    stepMut(s, input);
    const last = s.memory[s.memory.length - 1];
    if (last !== undefined && last !== out[out.length - 1]) out.push(last);
  }
  return out;
}

/** The detector state after the given inputs. */
function stateAfter(inputs: readonly DetectorInput[], params: D1ParamsInput = {}, variant: Variant = 'D1'): DetectorState {
  const s = initDetector(params, 1, variant);
  for (const input of inputs) stepMut(s, input);
  return s;
}

describe('grid (spec 7.4 rule 1)', () => {
  it('interpolates on a 30 Hz grid; a point comes out with the first sample at or after it', () => {
    const s = initDetector();
    const size = s.ring.length;
    stepMut(s, batch(1, [[T0, 1]]));
    expect(s.nextIdx).toBe(1);
    expect(s.ring[0]).toBe(1);
    stepMut(s, batch(2, [[T0 + 20_000, 2]]));
    expect(s.nextIdx).toBe(1);
    stepMut(s, batch(3, [[T0 + 40_000, 4]]));
    expect(s.nextIdx).toBe(2);
    expect(s.ring[1 % size]).toBeCloseTo(2 + (2 * (FRAME_US - 20_000)) / 20_000, 9);
    stepMut(s, batch(4, [[T0 + 100_000, 10]]));
    expect(s.nextIdx).toBe(4);
    expect(s.ring[3 % size]).toBe(10);
    expect(s.ring[2 % size]).toBeCloseTo(4 + (6 * (2 * FRAME_US - 40_000)) / 60_000, 9);
  });

  it('drops repeated or older timestamps and non-finite samples', () => {
    const s = initDetector();
    stepMut(s, batch(1, [[T0, 1], [T0 + 40_000, 2]]));
    const idx = s.nextIdx;
    stepMut(s, batch(2, [[T0 + 40_000, 99], [T0 + 10_000, 99], [T0 + 50_000, Number.NaN]]));
    expect(s.nextIdx).toBe(idx);
    expect(s.lastX).toBe(2);
  });

  it('applies the sign so that an inhale is a rise', () => {
    const s = initDetector({}, -1);
    stepMut(s, batch(1, [[T0, 0.25]]));
    expect(s.ring[0]).toBe(-0.25);
  });

  it('a gap over 100 ms makes the points inside unusable; only a gap over 500 ms empties the slope window', () => {
    const s = initDetector();
    stepMut(s, { k: 'state', n: 0, s: 'narrating' });
    for (const b of traceInputs(() => 0, 0, 1)) stepMut(s, b);
    // Usable points enter the amplitude window; the slope window counts every point.
    expect(s.ampCount).toBe(31);
    expect(s.winRun).toBe(31);
    stepMut(s, batch(100, [[T0 + 1_090_000, 0]])); // 90 ms: points 31, 32 usable
    expect(s.ampCount).toBe(33);
    expect(s.winRun).toBe(33);
    stepMut(s, batch(101, [[T0 + 1_340_000, 0]])); // 250 ms: points 33..40 inside, unusable
    expect(s.ampCount).toBe(33);
    expect(s.lastUsable).toBe(false);
    expect(s.winRun).toBe(41); // the slope window keeps them (spec 7.4 table)
    expect(s.inactiveUntilIdx).toBe(Number.NEGATIVE_INFINITY);
    stepMut(s, batch(102, [[T0 + 1_940_000, 0]])); // 600 ms: points 41..58 inside
    expect(s.ampCount).toBe(33);
    expect(s.winRun).toBe(0); // emptied
    const gapEndIdx = Math.ceil((1_940_000 * 30) / 1e6);
    expect(s.inactiveUntilIdx).toBe(gapEndIdx + 90);
    stepMut(s, batch(103, [[T0 + 1_970_000, 0]])); // point 59, 30 ms after the gap: usable again
    expect(s.ampCount).toBe(34);
    expect(s.lastUsable).toBe(true);
    expect(s.winRun).toBe(1);
  });

  it('a grid point that lies on the sample after a gap is usable', () => {
    const s = initDetector();
    stepMut(s, { k: 'state', n: 0, s: 'narrating' });
    stepMut(s, batch(1, [[T0, 0]]));
    stepMut(s, batch(2, [[T0 + 300_000, 1]])); // exactly on point 9
    expect(s.nextIdx).toBe(10);
    expect(s.ampCount).toBe(2); // points 0 and 9; 1..8 are inside the gap
    expect(s.ring[9 % s.ring.length]).toBe(1);
  });
});

describe('amplitude and slope (spec 7.4 rule 3)', () => {
  const reading: DetectorInput = { k: 'state', n: 0, s: 'narrating' };

  it('needs 15 s of usable samples, keeps the last 30 s and none older than 120 s', () => {
    const s = initDetector();
    stepMut(s, reading);
    const inputs = traceInputs(triangle, 0, 45);
    for (const b of inputs) {
      stepMut(s, b);
      const t = (b.tr[0]![0] - T0) / 1e6;
      if (t < 14.9) expect(s.A).toBeNull();
      if (t > 15.1) expect(s.A).not.toBeNull();
    }
    expect(s.ampCount).toBe(900);
    // A triangle wave between 0 and 1 is uniform: P90 - P10 = 0.8.
    expect(s.A).toBeCloseTo(0.8, 2);
    stepMut(s, { k: 'state', n: 1, s: 'listening' }); // nothing is usable from here on
    const later = traceInputs(triangle, 45 + 1 / 30, 160, 10_000);
    for (const b of later) {
      stepMut(s, b);
      const t = (b.tr[0]![0] - T0) / 1e6;
      // Usable samples span 15..45 s; fewer than 15 s remain once those before 30 s are older than 120 s.
      if (t < 149.5) expect(s.A).not.toBeNull();
      if (t > 150.5) expect(s.A).toBeNull();
    }
    expect(s.lastA).not.toBeNull();
  });

  it('divides the least-squares slope over L points by A', () => {
    const s = initDetector();
    stepMut(s, reading);
    for (const b of traceInputs(triangle, 0, 41)) stepMut(s, b); // 41 s: rising part, slope 0.5/s
    expect(s.lastV).not.toBeNull();
    // Timestamps are whole microseconds, so the grid values carry ~1e-6 relative error.
    expect(s.lastV!).toBeCloseTo(0.5 / s.A!, 5);
  });
});

describe('breath memory (spec 7.4 rules 4-5)', () => {
  it('fills from ordinary breaths, arms within the calibration minute and keeps the last 20', () => {
    for (const ratePerMin of [12, 15, 20]) {
      const ses = synthSession({ seed: 11, durationS: 200, ratePerMin });
      const s = initDetector();
      let armedAtS: number | null = null;
      let lastLen = 0;
      for (const input of ses.inputs) {
        const out = stepMut(s, input);
        if (out.armed === true && armedAtS === null && input.k === 'batch') armedAtS = (input.tr[0]![0] - T0) / 1e6;
        if (s.memory.length !== lastLen) {
          const b = s.memory[s.memory.length - 1]!;
          // A breath enters 2 s after its maximum (60 grid steps), not earlier.
          expect(s.nextIdx - 1).toBeGreaterThanOrEqual(b.peakIdx + 60);
          lastLen = s.memory.length;
        }
      }
      expect(armedAtS).not.toBeNull();
      expect(armedAtS!).toBeLessThan(75);
      expect(s.memory.length).toBe(20);
      for (const b of s.memory) {
        expect(b.peakIdx).toBeGreaterThan(b.troughIdx);
        expect(b.maxV).toBeGreaterThan(0);
      }
      const st = s.stats;
      expect(st.theta!).toBeGreaterThanOrEqual(1.3 * st.medQ! - 1e-12);
      expect(st.theta!).toBeLessThanOrEqual(3.0 * st.medQ! + 1e-12);
    }
  });

  it('counts only breaths after the narrator first reads', () => {
    const ses = synthSession({ seed: 3, durationS: 160, narratingFromS: 60 });
    const s = initDetector();
    let armedAtS: number | null = null;
    for (const input of ses.inputs) {
      const out = stepMut(s, input);
      if (input.k === 'batch' && (input.tr[0]![0] - T0) / 1e6 < 60) expect(s.memory.length).toBe(0);
      if (out.armed === true && armedAtS === null && input.k === 'batch') armedAtS = (input.tr[0]![0] - T0) / 1e6;
    }
    expect(armedAtS!).toBeGreaterThan(60 + 15 + 10 * 3);
  });

  it('keeps the breath of a false stop and leaves out recovery breaths after a reply', () => {
    // 120 s: steep inhale, no voice (a false stop); 150 s: an objection with a reply.
    const { r } = run({ seed: 5, durationS: 185, objections: [{ atS: 120, voice: false }, { atS: 150 }] });
    expect(r.fires.length).toBe(2);
    const first = r.fires[0]!;
    const fireIdx = Math.round(((first.tsUs - T0) / 1e6) * 30);
    const mem = r.state.memory;
    const steep = mem.find((b: Breath) => b.troughIdx <= fireIdx && b.peakIdx >= fireIdx);
    expect(steep).toBeDefined();
    expect(steep!.maxV).toBeGreaterThanOrEqual(first.theta);
    // Reply: voice from ~150.6 s to ~153.8 s; post-voice period is at least 4 s after that.
    const replyFrom = Math.round(150 * 30);
    const quietFrom = Math.round((153.8 + 4) * 30);
    expect(mem.some((b) => b.troughIdx >= replyFrom && b.troughIdx < quietFrom)).toBe(false);
  });
});

describe('fire rule (spec 7.4 rules 6-7)', () => {
  it('does not fire on ordinary breaths at 12 to 20 per minute', () => {
    for (const seed of [1, 2, 3]) {
      for (const ratePerMin of [12, 15, 18, 20]) {
        const { r } = run({ seed, durationS: 300, ratePerMin, tsJitterUs: 3000, dropProb: 0.02, burstProb: 0.1 });
        expect(r.fires).toEqual([]);
        expect(r.armed.some((a) => a.on)).toBe(true);
      }
    }
  });

  it('fires once on a steep pre-speech inhale, before the voice', () => {
    for (const seed of [1, 2, 3, 4]) {
      const { ses, r } = run({ seed, durationS: 140, objections: [{ atS: 120 }] });
      expect(r.fires.length).toBe(1);
      const f = r.fires[0]!;
      expect(f.rule).toBe('d1');
      expect(f.v).toBeGreaterThanOrEqual(f.theta);
      expect(fireS(ses, f.tsUs)).toBeGreaterThanOrEqual(120);
      expect(fireS(ses, f.tsUs)).toBeLessThanOrEqual(120.5);
      const nArr = ses.nArrBySeq.get(f.seq)!;
      expect(nArr + 384).toBeLessThan(ses.objections[0]!.voiceOnN);
    }
  });

  it('does not fire before 10 breaths are in memory', () => {
    const { ses, r } = run({ seed: 2, durationS: 160, objections: [{ atS: 35 }, { atS: 140 }] });
    expect(r.fires.length).toBe(1);
    expect(fireS(ses, r.fires[0]!.tsUs)).toBeGreaterThan(140);
  });

  it('never fires when the memory can never hold enough breaths', () => {
    const { r } = run({ seed: 4, durationS: 200, objections: [{ atS: 120 }, { atS: 160 }] }, { arm_breaths: 21 });
    expect(r.fires).toEqual([]);
    expect(r.armed).toEqual([]);
  });

  it('a gap over 500 ms deactivates D1 for 3 s; memory and A stay', () => {
    const gaps = [{ atS: 100, durS: 0.7 }];
    const near = synthSession({ seed: 6, durationS: 130, gaps, objections: [{ atS: 102 }] });
    const s = initDetector();
    let lastTs = Number.NEGATIVE_INFINITY;
    let gapEndS: number | null = null;
    let before: { mem: number; A: number } | null = null;
    for (const input of near.inputs) {
      const ts = input.k === 'batch' ? input.tr[0]![0] : null;
      // The first packet after the gap (its sample may sit just before 100.7 s: SDK jitter).
      const afterGap = ts !== null && gapEndS === null && Number.isFinite(lastTs) && ts - lastTs > 500_000;
      const wasActive = s.active;
      if (afterGap) before = { mem: s.memory.length, A: s.A! };
      const out = stepMut(s, input);
      if (afterGap) {
        gapEndS = fireS(near, ts);
        // Active up to the gap; the packet after it reports the change (the events.jsonl "armed" line).
        expect(wasActive).toBe(true);
        expect(out.armed).toBe(false);
      }
      if (gapEndS !== null && ts !== null && fireS(near, ts) < gapEndS + 0.3) {
        expect(s.memory.length).toBe(before!.mem);
        expect(s.A).toBeCloseTo(before!.A, 2);
        expect(s.active).toBe(false);
      }
      if (input.k === 'batch' && input.tr.length > 0) lastTs = input.tr[input.tr.length - 1]![0];
      expect(out.hold).toBe(false);
    }
    expect(gapEndS).toBeCloseTo(100.7, 1);
    expect(before!.mem).toBeGreaterThanOrEqual(10);
    const far = run({ seed: 6, durationS: 130, gaps, objections: [{ atS: 104.5 }] });
    expect(far.r.fires.length).toBe(1);
  });

  it('a gap between 100 and 500 ms does not deactivate D1', () => {
    const { r } = run({ seed: 6, durationS: 130, gaps: [{ atS: 100, durS: 0.3 }], objections: [{ atS: 101 }] });
    expect(r.fires.length).toBe(1);
    expect(r.state.inactiveUntilIdx).toBe(Number.NEGATIVE_INFINITY);
  });

  it('stays inactive while kNoFaceFound, kMultipleFacesFound, kChestNotVisible or kExcessiveMotion holds', () => {
    for (const code of [1, 2, 7, 12]) {
      const { r } = run({
        seed: 7,
        durationS: 140,
        vals: [
          { atS: 118, code },
          { atS: 123, code: 0 },
        ],
        objections: [{ atS: 120 }],
      });
      expect(r.fires).toEqual([]);
    }
    const other = run({ seed: 7, durationS: 140, vals: [{ atS: 118, code: 3 }], objections: [{ atS: 120 }] });
    expect(other.r.fires.length).toBe(1);
  });

  it('stays inactive during voice and for 4 s after voice_off plus one full breath', () => {
    const voices = [{ onS: 110, offS: 113 }];
    const soon = run({ seed: 8, durationS: 140, voices, objections: [{ atS: 115 }] });
    expect(soon.r.fires).toEqual([]);
    const during = run({ seed: 8, durationS: 140, voices: [{ onS: 110, offS: 125 }], objections: [{ atS: 120 }] });
    expect(during.r.fires).toEqual([]);
    const later = run({ seed: 8, durationS: 140, voices, objections: [{ atS: 123 }] });
    expect(later.r.fires.length).toBe(1);
  });

  it('stays inactive while the narrator is not reading', () => {
    const states = [
      { atS: 118, s: 'listening' as const },
      { atS: 123, s: 'resume' as const },
      { atS: 123, s: 'narrating' as const },
    ];
    const { r } = run({ seed: 9, durationS: 140, states, objections: [{ atS: 120, voice: false }] });
    expect(r.fires).toEqual([]);
  });

  it('keeps a 2.0 s post-fire period and waits for the end of the stop', () => {
    const steep = (atS: number) => ({ atS, voice: false });
    // Deck stops at once and resumes after 0.4 s: the second inhale is inside the 2.0 s.
    const quick = run({
      seed: 10,
      durationS: 140,
      objections: [steep(120), steep(121.5), steep(124.5)],
      states: [
        { atS: 120.35, s: 'hold_wait' },
        { atS: 120.75, s: 'resume' },
        { atS: 120.75, s: 'narrating' },
      ],
    });
    expect(quick.r.fires.map((f) => Math.round(fireS(quick.ses, f.tsUs)))).toEqual([120, 125]);
    // A stop that lasts past 2.0 s: nothing until the narrator reads again.
    const long = run({
      seed: 10,
      durationS: 140,
      objections: [steep(120), steep(123), steep(127.5)],
      states: [
        { atS: 120.35, s: 'hold_wait' },
        { atS: 126, s: 'resume' },
        { atS: 126, s: 'narrating' },
      ],
    });
    expect(long.r.fires.map((f) => Math.round(fireS(long.ses, f.tsUs)))).toEqual([120, 128]);
  });

  it('tracks its own stop through the narrator lines', () => {
    const ses = synthSession({ seed: 12, durationS: 125, objections: [{ atS: 120, voice: false }] });
    const s = initDetector();
    let fired = false;
    for (const input of ses.inputs) {
      const out = stepMut(s, input);
      if (out.hold) {
        fired = true;
        expect(s.stopPhase).toBe(1);
        stepMut(s, { k: 'state', n: 0, s: 'hold_wait' });
        expect(s.stopPhase).toBe(2);
        stepMut(s, { k: 'state', n: 0, s: 'resume' });
        expect(s.stopPhase).toBe(2);
        stepMut(s, { k: 'state', n: 0, s: 'narrating' });
        expect(s.stopPhase).toBe(0);
      }
    }
    expect(fired).toBe(true);
  });

  it('with no narrator reaction the hold counts as no stop after 2.0 s', () => {
    const steep = (atS: number) => ({ atS, voice: false });
    const { ses, r } = run({ seed: 10, durationS: 140, objections: [steep(120), steep(123)] });
    expect(r.fires.map((f) => Math.round(fireS(ses, f.tsUs)))).toEqual([120, 123]);
  });

  it('reports armed when activity changes', () => {
    const { r } = run({ seed: 13, durationS: 140, objections: [{ atS: 120 }] });
    expect(r.armed[0]!.on).toBe(true);
    for (let k = 1; k < r.armed.length; k++) expect(r.armed[k]!.on).toBe(!r.armed[k - 1]!.on);
    const fireIndex = r.fires[0]!.index;
    expect(r.armed.some((a) => a.index === fireIndex && !a.on)).toBe(true);
  });
});

describe('post-voice period: 4.0 s after voice_off and one full ordinary breath (spec 7.4 table, rule 5)', () => {
  it('lasts the 4.0 s even when a full breath came sooner', () => {
    // Voice 110-113 s; one ordinary breath completes before 116 s, so at 116 s only the 4.0 s are left.
    const ses = synthSession({ seed: 8, durationS: 140, voices: [{ onS: 110, offS: 113 }], objections: [{ atS: 116 }] });
    const s = initDetector();
    let checked = false;
    let fired = false;
    for (const input of ses.inputs) {
      if (!checked && input.k === 'batch' && fireS(ses, input.tr[0]![0]) >= 116) {
        checked = true;
        expect(s.postVoiceOpen).toBe(true);
        expect(s.postVoiceBreathDone).toBe(true);
        expect(s.nextIdx - 1 - s.postVoiceStartIdx).toBeLessThan(120);
      }
      if (stepMut(s, input).hold) fired = true;
    }
    expect(checked).toBe(true);
    expect(fired).toBe(false);
    // Control: with a 2.0 s period the same inhale fires.
    for (const rearm_ms of [0, 2000]) {
      const short = runDetectorFile(ses.inputs, { rearm_ms });
      expect(short.fires.length).toBe(1);
      expect(fireS(ses, short.fires[0]!.tsUs)).toBeGreaterThan(116);
      expect(fireS(ses, short.fires[0]!.tsUs)).toBeLessThan(116.5);
    }
  });

  // A reply (voice 100.5-103 s) inside a flat end-expiratory pause that lasts until 108 s, then a
  // steep 0.5 s inhale: the first full breath after the reply.
  const pauseCycles = [
    ...ordinary(24),
    { inS: 1.6, exS: 2.4, depth: 1, holdS: 8 },
    { inS: 0.5, exS: 2.4, depth: 1.3 },
    ...ordinary(8),
  ];
  const pauseTrace = [reading, ...traceInputs(breathing(pauseCycles), 0, 135)];
  const reply = [
    { atS: 100.5, input: voiceEdge(true) },
    { atS: 103, input: voiceEdge(false) },
  ];

  it('the first full breath after the reply only closes the period, even after the 4.0 s', () => {
    // Without the reply the steep inhale fires.
    const quiet = runDetectorFile(pauseTrace);
    expect(quiet.fires.map((f) => Math.round(camS(f.tsUs) * 10) / 10)).toEqual([108.2]);
    const s = initDetector();
    let checked = false;
    let armedAtS: number | null = null;
    for (const input of insertBefore(pauseTrace, reply)) {
      const out = stepMut(s, input);
      expect(out.hold).toBe(false);
      const i = s.nextIdx - 1;
      if (!checked && i >= Math.round(108.2 * 30)) {
        // The 4.0 s are over, the breath is not done yet: the period is still open.
        checked = true;
        expect(s.postVoiceOpen).toBe(true);
        expect(i - s.postVoiceStartIdx).toBeGreaterThanOrEqual(120);
        expect(s.active).toBe(false);
      }
      if (out.armed === true && armedAtS === null && i > 100 * 30) armedAtS = i / 30;
    }
    expect(checked).toBe(true);
    // The 108 s breath begins where the inhale starts, at the end of the flat trough, so it is the
    // first full breath after voice_off and re-arms D1 right after it, not one breath later (113.4 s).
    expect(armedAtS).not.toBeNull();
    expect(armedAtS!).toBeGreaterThan(108.5);
    expect(armedAtS!).toBeLessThan(110);
    // A recovery breath does not enter memory.
    expect(s.memory.some((b) => b.troughIdx >= 100 * 30 && b.troughIdx < 109 * 30)).toBe(false);
  });

  it('a voice_on and voice_off between two grid points still count as voice', () => {
    // Both edges arrive between the packets of 100.77 s and 100.8 s, mid-inhale of the breath that
    // starts at 100 s; that breath would enter memory at 103.6 s.
    const trace = [reading, ...traceInputs(breathing(ordinary(30)), 0, 106)];
    const troughIdx = 100 * 30;
    expect(stateAfter(trace).memory.some((b) => b.troughIdx === troughIdx)).toBe(true);
    const s = initDetector();
    let checked = false;
    for (const input of insertBefore(trace, [
      { atS: 100.8, input: voiceEdge(true) },
      { atS: 100.8, input: voiceEdge(false) },
    ])) {
      stepMut(s, input);
      if (!checked && input.k === 'batch' && camS(input.tr[0]![0]) >= 100.8) {
        checked = true;
        expect(s.lastVoiceIdx).toBe(3024);
        expect(s.postVoiceOpen).toBe(true);
        expect(s.postVoiceStartIdx).toBe(3024);
      }
    }
    expect(checked).toBe(true);
    expect(s.memory.some((b) => b.troughIdx === troughIdx)).toBe(false);
  });
});

describe('breath start at a flat trough (spec 7.4 rules 4-5)', () => {
  it('a breath begins at the end of a flat minimum, where the inhale starts', () => {
    // A 3 s end-expiratory pause from 100 s; kExcessiveMotion holds over its first half only. The
    // breath after the pause begins at 103 s on a usable sample, so it enters memory.
    const cycles = [...ordinary(24), { inS: 1.6, exS: 2.4, depth: 1, holdS: 3 }, ...ordinary(6)];
    const trace = [reading, ...traceInputs(breathing(cycles), 0, 110)];
    const inputs = insertBefore(trace, [
      { atS: 99.9, input: { k: 'val', seq: 0, code: 12 } },
      { atS: 101.5, input: { k: 'val', seq: 0, code: 0 } },
    ]);
    const after = admittedBreaths(inputs).filter((b) => b.troughIdx >= 99 * 30);
    expect(after.map((b) => [b.troughIdx, b.peakIdx])).toEqual([[103 * 30, Math.round(104.6 * 30)]]);
  });
});

describe('minimum rise (spec 7.4 rule 7)', () => {
  it('a one-sample spike that lifts v over theta on two points does not fire without the rise', () => {
    const f0 = breathing(ordinary(40));
    // 0.1 s into the inhale of the breath that starts at 100 s: the trace itself rises only
    // about 0.02 in 200 ms, so after the spike the rise is positive but under 0.15 A.
    const spikeS = 100.1;
    const f = (tS: number): number => f0(tS) + (Math.abs(tS - spikeS) < 1e-6 ? 1 : 0);
    const inputs: DetectorInput[] = [{ k: 'state', n: 0, s: 'narrating' }, ...traceInputs(f, 0, 140)];
    const withRise = runDetectorFile(inputs);
    expect(withRise.armed[0]?.on).toBe(true);
    expect(withRise.fires).toEqual([]);
    // Without the minimum rise the spike fires on the second point of v >= theta.
    const noRise = runDetectorFile(inputs, { min_rise_A: 0 });
    expect(noRise.fires.map((x) => Math.round(((x.tsUs - T0) / 1e6) * 30))).toEqual([Math.round(spikeS * 30) + 1]);
    // With M = 1 it fires on the spike itself, where the rise is large.
    const m1 = runDetectorFile(inputs, { M: 1 });
    expect(m1.fires.map((x) => Math.round(((x.tsUs - T0) / 1e6) * 30))).toEqual([Math.round(spikeS * 30)]);
  });

  it('is measured over 200 ms: a fast bump that rose 0.15 A only over 400 ms does not fire', () => {
    // A flat pause after 25 ordinary breaths. Before grid point i the trace creeps up by 0.3 A,
    // drops, and jumps back: v >= theta on i - 1 and i, yet at i it is only 0.06 A above the point
    // 200 ms back (i - 6), while 0.26 A above the point 400 ms back (i - 12). Values in A.
    const f0 = breathing(ordinary(25));
    const i = 3060;
    const base = Array.from({ length: i + 60 }, (_, k) => (k < 3000 ? f0(k / 30) : 0));
    const s0 = stateAfter([reading, ...frameInputs(base.slice(0, i - 17))]);
    expect(s0.active).toBe(true);
    expect(s0.stats.theta!).toBeLessThan(2);
    const shape: [number, number][] = [
      ...Array.from({ length: 6 }, (_, j): [number, number] => [j - 17, (0.1 * (j + 1)) / 6]),
      ...Array.from({ length: 6 }, (_, j): [number, number] => [j - 11, 0.1 + (0.2 * (j + 1)) / 6]),
      [-5, 0],
      [-4, 0],
      [-3, 0.08],
      [-2, 0.2],
      [-1, 0.3],
      [0, 0.36],
      [1, 0.12],
      [2, 0.1],
      ...Array.from({ length: 15 }, (_, j): [number, number] => [j + 3, 0.1 - (0.1 * (j + 1)) / 15]),
    ];
    const values = base.slice();
    for (const [r, x] of shape) values[i + r] = x * s0.A!;
    const inputs = [reading, ...frameInputs(values)];
    expect(runDetectorFile(inputs).fires).toEqual([]);
    // Controls: a 400 ms or a 100 ms window fires on the bump, and so does no minimum rise.
    for (const p of [{ min_rise_ms: 400 }, { min_rise_ms: 100 }, { min_rise_A: 0 }]) {
      const r = runDetectorFile(inputs, p);
      expect(r.fires.map((f) => Math.round(camS(f.tsUs) * 30))).toEqual([i]);
      expect(r.fires[0]!.v).toBeGreaterThanOrEqual(r.fires[0]!.theta);
    }
  });
});

describe('segmenter (spec 7.4 rule 4 and table)', () => {
  it('splits a breath at extrema that differ by 0.25 A or more', () => {
    // The breath at 100 s rises to 0.55 by 100.9 s, dips by d until 101.3 s, then rises on to 1.0
    // by 102.5 s: a dip of 0.3 A makes two breaths, a dip of 0.2 A one.
    const A = stateAfter([reading, ...traceInputs(breathing(ordinary(25)), 0, 100)]).A!;
    const dipped = (dA: number): DetectorInput[] => {
      const d = dA * A;
      const cycles = [
        ...ordinary(25),
        { inS: 0.9, exS: 0.4, depth: 0.55, to: 0.55 - d },
        { inS: 1.2, exS: 2.4, from: 0.55 - d, depth: 0.45 + d },
        ...ordinary(5),
      ];
      return [reading, ...traceInputs(breathing(cycles), 0, 110)];
    };
    const spans = (inputs: readonly DetectorInput[], params: D1ParamsInput = {}): number[][] =>
      admittedBreaths(inputs, params)
        .filter((b) => b.troughIdx >= 100 * 30 && b.troughIdx < 104 * 30)
        .map((b) => [b.troughIdx, b.peakIdx]);
    const two = [
      [3000, 3027],
      [3039, 3075],
    ];
    const one = [[3000, 3075]];
    expect(spans(dipped(0.3))).toEqual(two);
    expect(spans(dipped(0.2))).toEqual(one);
    // Controls: a 0.15 A step splits the smaller dip too, a 0.35 A step merges the larger one.
    expect(spans(dipped(0.2), { segment_step_A: 0.15 })).toEqual(two);
    expect(spans(dipped(0.3), { segment_step_A: 0.35 })).toEqual(one);
  });
});

describe('theta (spec 7.4 table)', () => {
  it('is med_q + k s_q within [1.3, 3.0] med_q', () => {
    expect(thetaFrom(1, 0, 2.5, [1.3, 3.0])).toBeCloseTo(1.3, 12);
    expect(thetaFrom(1, 0.2, 2.5, [1.3, 3.0])).toBeCloseTo(1.5, 12);
    expect(thetaFrom(1, 2, 2.5, [1.3, 3.0])).toBeCloseTo(3.0, 12);
  });

  it('uses the median and 1.4826 MAD of the maximum slopes in memory', () => {
    const p = resolveD1Params({ k: 2 });
    const mk = (maxV: number, i: number): Breath => ({
      troughIdx: i * 100,
      troughX: i % 2,
      peakIdx: i * 100 + 40,
      peakX: 1,
      maxV,
      startInterval: 120 + i,
    });
    const mem = [1.0, 1.1, 0.9, 1.2, 0.8, 1.0, 1.05, 0.95, 1.0, 1.3].map(mk);
    const st = memoryStats(mem, p);
    expect(st.medQ).toBeCloseTo(1.0, 12);
    expect(st.sQ).toBeCloseTo(1.4826 * 0.075, 12);
    expect(st.theta).toBeCloseTo(1.3, 12); // 1.0 + 2 * 0.111 is below the 1.3 med_q floor
    expect(st.thetaD3).toBeCloseTo(1.0 + 1.4826 * 0.075, 12);
    expect(st.medStartInterval).toBeCloseTo(124.5, 12);
    expect(st.medTroughX).toBeCloseTo(0.5, 12);
  });
});

describe('D3 (spec 7.4, "Детектор D3")', () => {
  const early = { seed: 1, durationS: 160, early: [{ atS: 120.3, inhaleS: 1.0, depth: 0.75 }], noise: 0.003, rateJitter: 0.03, depthJitter: 0.03 };

  it('fires on an early breath that D1 lets pass', () => {
    for (const seed of [1, 2, 3]) {
      const d1 = run({ ...early, seed }, {}, 'D1');
      const d3 = run({ ...early, seed }, {}, 'D3');
      expect(d1.r.fires).toEqual([]);
      expect(d3.r.fires.length).toBe(1);
      const f = d3.r.fires[0]!;
      expect(f.rule).toBe('d3');
      expect(fireS(d3.ses, f.tsUs)).toBeGreaterThan(120.3);
      expect(fireS(d3.ses, f.tsUs)).toBeLessThan(121.3);
      expect(f.theta).toBeCloseTo(d3.r.state.stats.thetaD3 ?? f.theta, 1);
    }
  });

  it('fires whenever D1 fires', () => {
    const o = { seed: 4, durationS: 140, objections: [{ atS: 120 }] };
    const d1 = run(o, {}, 'D1');
    const d3 = run(o, {}, 'D3');
    expect(d1.r.fires.length).toBe(1);
    expect(d3.r.fires.map((f) => f.seq)).toEqual(d1.r.fires.map((f) => f.seq));
  });

  it('does not fire on ordinary breaths without drift', () => {
    for (const seed of [1, 2]) {
      const { r } = run({ seed, durationS: 240 }, {}, 'D3');
      expect(r.fires).toEqual([]);
    }
  });

  it('an early start by interval alone: from the trough, sooner than 0.6 of the median interval', () => {
    // 25 ordinary 4 s cycles, then one with a 0.5 s exhale: the next breath starts from the usual
    // trough 2.1 s after the last start (0.53 of 4 s), 14% steeper than usual.
    const at = (restS: number) => [
      ...ordinary(25),
      { inS: 1.6, exS: 0.5 + restS, depth: 1 },
      { inS: 1.4, exS: 2.6, depth: 1 },
      ...ordinary(5),
    ];
    const reading: DetectorInput = { k: 'state', n: 0, s: 'narrating' };
    const early = [reading, ...traceInputs(breathing(at(0)), 0, 125)];
    const d3 = runDetectorFile(early, {}, 1, 'D3');
    expect(runDetectorFile(early, {}, 1, 'D1').fires).toEqual([]);
    expect(d3.fires.map((x) => x.rule)).toEqual(['d3']);
    const fireS = (d3.fires[0]!.tsUs - T0) / 1e6;
    expect(fireS).toBeGreaterThan(100 + 2.1);
    expect(fireS).toBeLessThan(100 + 2.1 + 1.4);
    // The same breath 1.2 s later is not early (3.3 s after the last start): no fire.
    const late = [reading, ...traceInputs(breathing(at(1.2)), 0, 125)];
    expect(runDetectorFile(late, {}, 1, 'D3').fires).toEqual([]);
  });

  it('an early start by level alone: on time, from 0.25 A or more above the median trough', () => {
    // 25 ordinary 4 s cycles; the 26th exhales only down to h, and the next breath starts there on
    // time (1.0 of the median interval), 18% steeper than usual.
    const at = (h: number): Cycle[] => [
      ...ordinary(25),
      { inS: 1.6, exS: 2.4, depth: 1, to: h },
      { inS: 1.35, exS: 2.65, depth: 1, from: h },
      ...ordinary(5),
    ];
    const probe = (h: number) => {
      const inputs = [reading, ...traceInputs(breathing(at(h)), 0, 125)];
      const s = initDetector({}, 1, 'D3');
      let level: number | null = null;
      let interval: number | null = null;
      const fires: Fire[] = [];
      for (const input of inputs) {
        const out = stepMut(s, input);
        if (level === null && s.startIdx !== null && s.startIdx >= 104 * 30) {
          // Start level over the median trough of memory, in A; start interval over the median.
          level = (s.startX - s.stats.medTroughX!) / s.A!;
          interval = s.startInterval! / s.stats.medStartInterval!;
        }
        if (out.fire !== undefined) fires.push(out.fire);
      }
      return { level: level!, interval: interval!, fires, d1: runDetectorFile(inputs, {}, 1, 'D1').fires };
    };
    const high = probe(0.23);
    expect(high.level).toBeGreaterThan(0.27);
    expect(high.level).toBeLessThan(0.33);
    expect(high.interval).toBeGreaterThan(0.9);
    expect(high.fires.map((f) => f.rule)).toEqual(['d3']);
    expect(camS(high.fires[0]!.tsUs)).toBeGreaterThan(104);
    expect(camS(high.fires[0]!.tsUs)).toBeLessThan(104 + 1.35);
    expect(high.d1).toEqual([]);
    // Control: the same breath from about 0.2 A above the troughs is not early.
    const low = probe(0.135);
    expect(low.level).toBeGreaterThan(0.17);
    expect(low.level).toBeLessThan(0.23);
    expect(low.interval).toBeGreaterThan(0.9);
    expect(low.fires).toEqual([]);
    expect(low.d1).toEqual([]);
  });

  it('a breath starts where v >= 0.35 med_q holds on three grid points in a row', () => {
    // A flat pause after 25 ordinary breaths. One step lifts v over 0.35 med_q on two grid points
    // only (v = 0.8, 1.2, 1.2, 0.8 of it); two half steps lift it on three (0.6, 1.5, 1.8, 1.5, 0.6).
    const f0 = breathing(ordinary(25));
    const s0 = stateAfter([reading, ...traceInputs(f0, 0, 101)], {}, 'D3');
    expect(s0.startArmed).toBe(true);
    const thr = 0.35 * s0.stats.medQ!;
    const s1 = 3045;
    const s2 = 3090;
    const values = Array.from({ length: 3150 }, (_, k) => (k < 3000 ? f0(k / 30) : 0));
    for (let k = s1; k < values.length; k++) values[k] = values[k]! + (thr / 7.5) * s0.A!;
    for (let k = s2; k < values.length; k++) values[k] = values[k]! + ((k === s2 ? 0.5 : 1) * thr * s0.A!) / 5;
    const inputs = [reading, ...frameInputs(values)];
    const starts = (params: D1ParamsInput): number[] => {
      const s = initDetector(params, 1, 'D3');
      const out: number[] = [];
      for (const input of inputs) {
        stepMut(s, input);
        if (s.startIdx !== null && s.startIdx >= 3000 && s.startIdx !== out[out.length - 1]) out.push(s.startIdx);
      }
      return out;
    };
    // The start is the first of the three points.
    expect(starts({})).toEqual([s2 + 1]);
    // Controls: two points in a row would count the single step too; four would count neither.
    expect(starts({ d3: { start_points: 2 } })).toEqual([s1 + 1, s2 + 1]);
    expect(starts({ d3: { start_points: 4 } })).toEqual([]);
  });

  it('records an open risk of the level rule: a slow drift alone makes ordinary breaths early', () => {
    // The level rule compares a start with the median trough of the last 20 breaths (about 80 s),
    // so a slow baseline drift lifts ordinary starts over it; D3 then needs only med_q + 1.0 s_q,
    // which k does not raise. This pins the rule as the spec writes it (an open question for the
    // spec owner): a change to the rule must change this test on purpose.
    const sessions = (driftAmp: number) =>
      [1, 2, 3, 4].map((seed) => synthSession({ seed, durationS: 300, driftAmp, driftPeriodS: 120 }).inputs);
    const count = (all: DetectorInput[][], params: D1ParamsInput, variant: Variant): number =>
      all.reduce((n, inputs) => n + runDetectorFile(inputs, params, 1, variant).fires.length, 0);
    expect(count(sessions(0), {}, 'D3')).toBe(0);
    const drift = sessions(0.3);
    expect(count(drift, {}, 'D1')).toBe(0);
    expect(count(drift, {}, 'D3')).toBeGreaterThanOrEqual(3);
    // Every one of those fires comes from the level rule.
    expect(count(drift, { d3: { high_start_A: 1e6 } }, 'D3')).toBe(0);
  });
});

describe('step() is pure', () => {
  it('leaves the given state untouched and answers the same twice', () => {
    const ses = synthSession({ seed: 14, durationS: 130, objections: [{ atS: 120 }] });
    let s = initDetector();
    for (const [k, input] of ses.inputs.entries()) {
      if (k % 500 === 0 || input.k !== 'batch') {
        const snapshot = structuredClone(s);
        const a = step(s, input);
        const b = step(s, input);
        expect(s).toEqual(snapshot);
        expect(b.hold).toBe(a.hold);
        expect(b.fire).toEqual(a.fire);
        expect(b.state).toEqual(a.state);
        s = a.state;
      } else {
        s = step(s, input).state;
      }
    }
  });
});
