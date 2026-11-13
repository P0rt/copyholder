import { describe, expect, it } from 'vitest';
import { runPosthoc, type BatchInput, type DetectorInput } from '../../core/detector.ts';
import {
  AUDIO_RULE_DELAYS_MS,
  activeSpansSamples,
  audioRuleLeadMs,
  audioRuleStops,
  gPosthoc,
  gResetSeqs,
  headMotionThreshold,
  lipBaselines,
  mPosthoc,
  overlapSamples,
  tPosthoc,
} from './index.ts';

const RATE = 48_000;
const FRAME = 1_600; // 30 Hz on the sample clock

interface Frame {
  g?: number | null;
  hm?: number | null;
  talk?: 0 | 1;
}

/** Packets every 1/30 s from sample `start`; extra lines are merged in by position. */
function timeline(
  seconds: number,
  frame: (tS: number) => Frame,
  extra: { n: number; line: DetectorInput }[] = [],
  start = RATE,
): { inputs: DetectorInput[]; nArrBySeq: Map<number, number> } {
  const nArrBySeq = new Map<number, number>();
  const lines: { n: number; order: number; line: DetectorInput }[] = [];
  const count = Math.round((seconds * RATE) / FRAME);
  for (let i = 0; i < count; i++) {
    const n = start + i * FRAME;
    const tS = (n - start) / RATE;
    const f = frame(tS);
    const b: BatchInput = { k: 'batch', seq: i + 1, tr: [[1_000_000 + i * 33_333, 0]] };
    if (f.g !== undefined) b.g = f.g;
    if (f.hm !== undefined) b.hm = f.hm;
    if (f.talk !== undefined) b.talk = [[1_000_000 + i * 33_333, f.talk]];
    nArrBySeq.set(i + 1, n);
    lines.push({ n, order: 1, line: b });
  }
  for (const e of extra) lines.push({ n: e.n, order: 0, line: e.line });
  lines.sort((a, b) => a.n - b.n || a.order - b.order);
  return { inputs: [{ k: 'state', n: 0, s: 'narrating' }, ...lines.map((l) => l.line)], nArrBySeq };
}

const at = (tS: number): number => RATE + Math.round(tS * RATE);

describe('rival G (spec 7.5)', () => {
  const rest = 0.035;

  it('fires on the second frame in a row over g0 + theta_G, with stop nArr + 384', () => {
    const { inputs, nArrBySeq } = timeline(20, (t) => ({ g: t >= 12 && t < 12.5 ? rest + 0.05 : rest }));
    const r = runPosthoc(inputs, { detector: gPosthoc({ inputs, nArrBySeq, thetaG: 0.03 }), nArrBySeq });
    expect(r.fires).toHaveLength(1);
    const fire = r.fires[0]!;
    // The opening starts on the frame at 12.0 s; the second frame in a row fires.
    expect(fire.nArr).toBe(at(12) + FRAME);
    expect(fire.accepted).toBe(true);
    expect(r.stops[0]!.nSilent).toBe(fire.nArr! + 384);
  });

  it('does not fire on a single frame', () => {
    const { inputs, nArrBySeq } = timeline(20, (t) => ({ g: Math.abs(t - 12) < 0.01 ? rest + 0.05 : rest }));
    const r = runPosthoc(inputs, { detector: gPosthoc({ inputs, nArrBySeq, thetaG: 0.03 }), nArrBySeq });
    expect(r.fires).toHaveLength(0);
  });

  it('keeps silent for 1 s of frames after a reset frame', () => {
    const open = (t: number): boolean => (t >= 10.2 && t < 10.6) || (t >= 14 && t < 14.4);
    const { inputs, nArrBySeq } = timeline(20, (t) => ({ g: Math.abs(t - 10) < 0.01 ? null : open(t) ? rest + 0.05 : rest }));
    const pts = lipBaselines(inputs, nArrBySeq);
    const resetSeq = [...pts.entries()].find(([, p]) => p.g === null)![0];
    expect(pts.get(resetSeq + 3)!.g0).toBeNull(); // 0.1 s after the reset
    const r = runPosthoc(inputs, { detector: gPosthoc({ points: pts, nArrBySeq, thetaG: 0.03 }), nArrBySeq });
    // The opening 0.2 s after the reset is not seen; the one at 14 s is.
    expect(r.fires.map((f) => f.nArr)).toEqual([at(14) + FRAME]);
  });

  it('is inactive while the voice is on and for 4.0 s after voice_off', () => {
    const open = (t: number): boolean => (t >= 13 && t < 13.4) || (t >= 17 && t < 17.4);
    const { inputs, nArrBySeq } = timeline(25, (t) => ({ g: open(t) ? rest + 0.05 : rest }), [
      { n: at(10), line: { k: 'voice', n: at(10), on: true } },
      { n: at(11), line: { k: 'voice', n: at(11), on: false } },
    ]);
    const r = runPosthoc(inputs, { detector: gPosthoc({ inputs, nArrBySeq, thetaG: 0.03 }), nArrBySeq });
    // 13 s is only 2 s after voice_off; 17 s is 6 s after.
    expect(r.fires.map((f) => f.nArr)).toEqual([at(17) + FRAME]);
  });

  it('keeps its own 2.0 s post-fire period and its own hold wait', () => {
    const open = (t: number): boolean => (t >= 12 && t < 12.3) || (t >= 13 && t < 13.3) || (t >= 15 && t < 15.3);
    const { inputs, nArrBySeq } = timeline(20, (t) => ({ g: open(t) ? rest + 0.05 : rest }));
    const r = runPosthoc(inputs, { detector: gPosthoc({ inputs, nArrBySeq, thetaG: 0.03 }), nArrBySeq });
    // 13 s is inside the post-fire period of the 12 s fire; 15 s is after it and after the 1.5 s wait.
    expect(r.fires.map((f) => f.nArr)).toEqual([at(12) + FRAME, at(15) + FRAME]);
    expect(r.stops[0]!.why).toBe('timeout');
    expect(r.stops[0]!.nResume).toBe(r.stops[0]!.nSilent + 72_000);
  });

  it('never sees the live stops of D1: recorded hold_wait lines are dropped', () => {
    const { inputs, nArrBySeq } = timeline(20, (t) => ({ g: t >= 12 && t < 12.3 ? rest + 0.05 : rest }), [
      { n: at(11.9), line: { k: 'state', n: at(11.9), s: 'hold_wait' } },
      { n: at(13.5), line: { k: 'state', n: at(13.5), s: 'narrating' } },
    ]);
    const r = runPosthoc(inputs, { detector: gPosthoc({ inputs, nArrBySeq, thetaG: 0.03 }), nArrBySeq });
    expect(r.fires.map((f) => f.nArr)).toEqual([at(12) + FRAME]);
  });

  it('counts active time from its own armed changes', () => {
    const { inputs, nArrBySeq } = timeline(20, () => ({ g: rest }));
    const r = runPosthoc(inputs, { detector: gPosthoc({ inputs, nArrBySeq, thetaG: 0.03 }), nArrBySeq });
    // Ready after 1 s of frames; active to the last packet.
    expect(r.activeMinutes * 60).toBeGreaterThan(18.5);
    expect(r.activeMinutes * 60).toBeLessThan(19.1);
    const spans = activeSpansSamples(r.armed, at(20));
    expect(overlapSamples(spans, at(5), at(6))).toBe(RATE);
  });
});

describe('resets of G from samples.jsonl (spec 7.5, 8.1)', () => {
  const rest = 0.035;

  it('reads lm.reset 1 as a reset, lm null as no frame, and a null g it cannot explain as a reset', () => {
    const b = (seq: number, g: number | null): BatchInput => ({ k: 'batch', seq, tr: [], g });
    const inputs: DetectorInput[] = [b(1, rest), b(2, null), b(3, null), b(4, null), b(5, rest), b(6, null), { k: 'val', seq: 7, code: 0 }];
    const samples = [
      { k: 'm', seq: 1, lm: { reset: 0 } },
      { k: 'm', seq: 2, lm: { reset: 1 } },
      { k: 'm', seq: 3, lm: null },
      { k: 'm', seq: 5, lm: { reset: 1 } }, // a reset frame that still gave a g
      { k: 'm', seq: 6 }, // no lm field
      { k: 'a', seq: 4, lm: null }, // not a packet line
    ];
    const r = gResetSeqs(inputs, samples);
    expect([...r.seqs].sort((x, y) => x - y)).toEqual([2, 4, 5, 6]);
    expect(r).toMatchObject({ flagged: 2, noFrame: 1, unknown: 2 });
  });

  it('a packet without a landmark frame does not restart the baseline', () => {
    const open = (t: number): boolean => t >= 12.3 && t < 12.7;
    const { inputs, nArrBySeq } = timeline(20, (t) => ({ g: Math.abs(t - 12) < 0.01 ? null : open(t) ? rest + 0.05 : rest }));
    const batches = inputs.filter((r): r is BatchInput => r.k === 'batch');
    const samples = batches.map((r) => ({ k: 'm', seq: r.seq, lm: r.g === null ? null : { reset: 0 } }));
    const resets = gResetSeqs(inputs, samples);
    expect(resets).toMatchObject({ flagged: 0, noFrame: 1, unknown: 0 });
    const known = runPosthoc(inputs, { detector: gPosthoc({ inputs, nArrBySeq, thetaG: 0.03, resetSeqs: resets.seqs }), nArrBySeq });
    expect(known.fires.map((f) => f.nArr)).toEqual([at(12.3) + FRAME]);
    // Read from stream.jsonl alone, every null g is a reset: G is blind for 1 s and misses the opening.
    const asReset = runPosthoc(inputs, { detector: gPosthoc({ inputs, nArrBySeq, thetaG: 0.03 }), nArrBySeq });
    expect(asReset.fires).toHaveLength(0);
  });
});

describe('rival T (spec 7.5)', () => {
  it('fires on the first packet with the flag set while active', () => {
    const { inputs, nArrBySeq } = timeline(20, (t) => ({ talk: (t >= 8 && t < 9) || (t >= 15 && t < 16) ? 1 : 0 }), [
      { n: at(7.5), line: { k: 'voice', n: at(7.5), on: true } },
      { n: at(9.5), line: { k: 'voice', n: at(9.5), on: false } },
    ]);
    const r = runPosthoc(inputs, { detector: tPosthoc({ nArrBySeq }), nArrBySeq });
    // During the voice T is inactive; at 15 s it fires on the first flagged packet.
    expect(r.fires.map((f) => f.nArr)).toEqual([at(15)]);
  });

  it('is inactive while the validation code makes the signal unusable', () => {
    const { inputs, nArrBySeq } = timeline(20, (t) => ({ talk: t >= 8 && t < 9 ? 1 : 0 }), [
      { n: at(7), line: { k: 'val', seq: 9999, code: 2 } },
      { n: at(8.5), line: { k: 'val', seq: 9998, code: 0 } },
    ]);
    // Codes without an arr stamp take the last known position.
    const r = runPosthoc(inputs, { detector: tPosthoc({ nArrBySeq }), nArrBySeq });
    expect(r.fires.map((f) => f.nArr)).toEqual([at(8.5)]);
  });
});

describe('rival M (spec 7.5)', () => {
  it('takes median plus 4 spreads over the block and fires above it', () => {
    const { inputs, nArrBySeq } = timeline(20, (t) => ({ hm: t >= 15 && t < 15.1 ? 0.05 : 0.002 + 0.001 * Math.sin(t * 7) }));
    const th = headMotionThreshold(inputs, nArrBySeq, at(0), at(10))!;
    expect(th.n).toBe(300);
    expect(th.threshold).toBeCloseTo(th.median + 4 * th.spread, 12);
    expect(th.threshold).toBeLessThan(0.05);
    const r = runPosthoc(inputs, { detector: mPosthoc({ nArrBySeq, threshold: th.threshold }), nArrBySeq });
    expect(r.fires.map((f) => f.nArr)).toEqual([at(15)]);
  });
});

describe('audio rules A100, A250, A500 (spec 7.5)', () => {
  it('stop at n_v + delay + 384, lead -(delay + 8 ms + L_rt)', () => {
    expect(AUDIO_RULE_DELAYS_MS).toEqual([100, 250, 500]);
    const stops = audioRuleStops([{ nV: 480_000 }, { nV: 1_440_000 }], 250);
    expect(stops).toEqual([
      { nV: 480_000, nFire: 492_000, nSilent: 492_384 },
      { nV: 1_440_000, nFire: 1_452_000, nSilent: 1_452_384 },
    ]);
    expect(audioRuleLeadMs(250, 23.5)).toBeCloseTo(-281.5, 9);
  });

  it('keeps its own post-fire period and waits for the end of the reply', () => {
    const stops = audioRuleStops([{ nV: 480_000, nEnd: 700_000 }, { nV: 560_000 }, { nV: 900_000 }], 100);
    expect(stops.map((s) => s.nV)).toEqual([480_000, 900_000]);
  });
});
