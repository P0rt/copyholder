// Property tests of D1 and D3 with fast-check (spec 7.4 list, 13.4 "Свойства D1") and the replay
// identity (spec 7.4, 13.4 "Тождество повтора").

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { initDetector, runDetectorFile, step, stepMut, type DetectorRun, type FireRecord } from './d1.ts';
import { formatDetectorInLine, nArrMapFromStamps, parseDetectorIn } from './io.ts';
import { INVALID_VALIDATION_CODES, K_GRID, L_RETUNE_GRID, M_RETUNE_GRID, type D1ParamsInput } from './params.ts';
import { runPosthoc } from './posthoc.ts';
import { scaleTrace, synthSession, type SynthOptions } from './synth.ts';
import type { BatchInput, DetectorInput, Fire, Sign, Variant } from './types.ts';

/** What step() answered to one input. */
interface Answer {
  hold: boolean;
  fire?: Fire;
  armed?: boolean;
}

/** Feeds step() one input at a time, as the live worker does; the state is never shared. */
function answersPure(inputs: readonly DetectorInput[], params: D1ParamsInput, sign: Sign, variant: Variant): Answer[] {
  let s = initDetector(params, sign, variant);
  const out: Answer[] = [];
  for (const input of inputs) {
    const r = step(s, input);
    s = r.state;
    const a: Answer = { hold: r.hold };
    if (r.fire !== undefined) a.fire = r.fire;
    if (r.armed !== undefined) a.armed = r.armed;
    out.push(a);
  }
  return out;
}

/** Same with one state updated in place. */
function answersMut(inputs: readonly DetectorInput[], params: D1ParamsInput, sign: Sign, variant: Variant): Answer[] {
  const s = initDetector(params, sign, variant);
  return inputs.map((input) => {
    const r = stepMut(s, input);
    const a: Answer = { hold: r.hold };
    if (r.fire !== undefined) a.fire = r.fire;
    if (r.armed !== undefined) a.armed = r.armed;
    return a;
  });
}

const frac = fc.double({ min: 0.3, max: 0.97, noNaN: true });

/**
 * Random sessions: breathing at 12-20 per minute with jitter, steep inhales with and without a
 * reply, early breaths, codes, gaps, voices and a pause. D1 arms 45-65 s after reading starts,
 * so sessions run 120-170 s and most of them have a steep inhale after that.
 */
const sessionArb = fc
  .record({
    seed: fc.integer({ min: 1, max: 0x7fffffff }),
    durationS: fc.integer({ min: 120, max: 170 }),
    ratePerMin: fc.double({ min: 12, max: 20, noNaN: true }),
    polarity: fc.constantFrom<Sign>(1, -1),
    scale: fc.double({ min: 0.05, max: 5, noNaN: true }),
    offset: fc.double({ min: -1, max: 1, noNaN: true }),
    tsJitterUs: fc.integer({ min: 0, max: 4000 }),
    dropProb: fc.double({ min: 0, max: 0.05, noNaN: true }),
    burstProb: fc.double({ min: 0, max: 0.2, noNaN: true }),
    narratingFromS: fc.integer({ min: 0, max: 10 }),
    objections: fc.array(
      fc.record({
        at: frac,
        voice: fc.boolean(),
        depth: fc.double({ min: 0.8, max: 2, noNaN: true }),
        inhaleS: fc.double({ min: 0.3, max: 0.8, noNaN: true }),
      }),
      { minLength: 1, maxLength: 4 },
    ),
    early: fc.array(
      fc.record({
        at: frac,
        inhaleS: fc.double({ min: 0.6, max: 1.2, noNaN: true }),
        depth: fc.double({ min: 0.5, max: 1, noNaN: true }),
      }),
      { maxLength: 2 },
    ),
    gaps: fc.array(fc.record({ at: frac, durS: fc.double({ min: 0.05, max: 1.2, noNaN: true }) }), { maxLength: 2 }),
    vals: fc.array(fc.record({ at: frac, code: fc.constantFrom(0, 0, 1, 2, 3, 7, 12) }), { maxLength: 3 }),
    voices: fc.array(fc.record({ at: frac, durS: fc.double({ min: 0.3, max: 4, noNaN: true }) }), { maxLength: 2 }),
    pause: fc.option(fc.record({ at: frac, durS: fc.double({ min: 1, max: 8, noNaN: true }) }), { nil: null }),
  })
  .map((r): SynthOptions => {
    const t = (f: number): number => Math.round(f * r.durationS * 100) / 100;
    return {
      seed: r.seed,
      durationS: r.durationS,
      ratePerMin: r.ratePerMin,
      polarity: r.polarity,
      scale: r.scale,
      offset: r.offset,
      tsJitterUs: r.tsJitterUs,
      dropProb: r.dropProb,
      burstProb: r.burstProb,
      narratingFromS: r.narratingFromS,
      objections: r.objections.map((o) => ({ atS: t(o.at), voice: o.voice, depth: o.depth, inhaleS: o.inhaleS })),
      early: r.early.map((e) => ({ atS: t(e.at), inhaleS: e.inhaleS, depth: e.depth })),
      gaps: r.gaps.map((g) => ({ atS: t(g.at), durS: g.durS })),
      vals: r.vals.map((v) => ({ atS: t(v.at), code: v.code })),
      voices: r.voices.map((v) => ({ onS: t(v.at), offS: t(v.at) + v.durS })),
      states:
        r.pause === null
          ? []
          : [
              { atS: t(r.pause.at), s: 'idle' as const },
              { atS: t(r.pause.at) + r.pause.durS, s: 'narrating' as const },
            ],
    };
  });

const variantArb = fc.constantFrom<Variant>('D1', 'D3');

/** k from the stage A grid, L and M from the retune ladder (spec 7.4, 9.8); mostly the defaults. */
const paramsArb: fc.Arbitrary<D1ParamsInput> = fc.oneof(
  { weight: 1, arbitrary: fc.constant({}) },
  {
    weight: 2,
    arbitrary: fc.record({
      k: fc.constantFrom(...K_GRID),
      L: fc.constantFrom(...L_RETUNE_GRID),
      M: fc.constantFrom(...M_RETUNE_GRID),
    }),
  },
);

const RUNS = 20;

/** Total fires seen by a property, so that no property passes on sessions where nothing fires. */
function fireCounter(): { add(n: number): void; total(): number } {
  let n = 0;
  return { add: (k) => void (n += k), total: () => n };
}

describe('D1 properties (spec 7.4, 13.4)', () => {
  it('causality: the answer to an input does not depend on the inputs after it', () => {
    const fires = fireCounter();
    fc.assert(
      fc.property(sessionArb, variantArb, paramsArb, fc.double({ min: 0.5, max: 1, noNaN: true }), sessionArb, (o, variant, params, cutFrac, other) => {
        const inputs = synthSession(o).inputs;
        const cut = Math.floor(cutFrac * inputs.length);
        const full = answersMut(inputs, params, o.polarity ?? 1, variant);
        const prefix = answersMut(inputs.slice(0, cut), params, o.polarity ?? 1, variant);
        // A different future: another session's inputs after the cut.
        const junk = answersMut([...inputs.slice(0, cut), ...synthSession(other).inputs], params, o.polarity ?? 1, variant);
        expect(prefix).toEqual(full.slice(0, cut));
        expect(junk.slice(0, cut)).toEqual(full.slice(0, cut));
        fires.add(prefix.filter((a) => a.hold).length);
      }),
      { numRuns: RUNS, seed: 7401 },
    );
    expect(fires.total()).toBeGreaterThanOrEqual(3);
  });

  it('scaling the trace does not change the answer', () => {
    const fires = fireCounter();
    const factor = fc.oneof(
      fc.constantFrom(0.25, 2, 1024, 2 ** -10),
      fc.double({ min: 0.01, max: 100, noNaN: true }),
    );
    fc.assert(
      fc.property(sessionArb, variantArb, paramsArb, factor, (o, variant, params, c) => {
        const inputs = synthSession(o).inputs;
        const sign = o.polarity ?? 1;
        const a = runDetectorFile(inputs, params, sign, variant);
        const b = runDetectorFile(scaleTrace(inputs, c), params, sign, variant);
        expect(b.fires.map((f) => [f.index, f.seq, f.rule, f.tsUs])).toEqual(a.fires.map((f) => [f.index, f.seq, f.rule, f.tsUs]));
        b.fires.forEach((f, k) => {
          expect(f.v).toBeCloseTo(a.fires[k]!.v, 9);
          expect(f.theta).toBeCloseTo(a.fires[k]!.theta, 9);
        });
        expect(b.armed).toEqual(a.armed);
        if (Number.isInteger(Math.log2(c))) {
          // A power of two scales every float exactly: the answers are bit-identical.
          expect(b.fires).toEqual(a.fires);
        }
        fires.add(a.fires.length);
      }),
      { numRuns: RUNS, seed: 7402 },
    );
    expect(fires.total()).toBeGreaterThanOrEqual(5);
  });

  it('flipping the trace sign together with s does not change the answer', () => {
    const fires = fireCounter();
    fc.assert(
      fc.property(sessionArb, variantArb, paramsArb, (o, variant, params) => {
        const inputs = synthSession(o).inputs;
        const sign = o.polarity ?? 1;
        const a = answersMut(inputs, params, sign, variant);
        const b = answersMut(scaleTrace(inputs, -1), params, sign === 1 ? -1 : 1, variant);
        expect(b).toEqual(a);
        fires.add(a.filter((x) => x.hold).length);
      }),
      { numRuns: RUNS, seed: 7403 },
    );
    expect(fires.total()).toBeGreaterThanOrEqual(5);
  });

  it('feeding one input at a time equals feeding the file', () => {
    const fires = fireCounter();
    fc.assert(
      fc.property(sessionArb, variantArb, paramsArb, (o, variant, params) => {
        const inputs = synthSession(o).inputs;
        const sign = o.polarity ?? 1;
        const live = answersPure(inputs, params, sign, variant);
        const text = inputs.map(formatDetectorInLine).join('\n');
        const file = answersMut(parseDetectorIn(text), params, sign, variant);
        expect(file).toEqual(live);
        fires.add(live.filter((x) => x.hold).length);
      }),
      { numRuns: 12, seed: 7404 },
    );
    expect(fires.total()).toBeGreaterThanOrEqual(3);
  });

  it('an inactive detector never fires', () => {
    const fires = fireCounter();
    fc.assert(
      fc.property(sessionArb, variantArb, paramsArb, (o, variant, params) => {
        const inputs = synthSession(o).inputs;
        const run = runDetectorFile(inputs, params, o.polarity ?? 1, variant);
        expect(inactiveFires(inputs, run)).toEqual([]);
        for (const f of run.fires) expect(f.v).toBeGreaterThanOrEqual(f.theta);
        fires.add(run.fires.length);
      }),
      { numRuns: 40, seed: 7405 },
    );
    expect(fires.total()).toBeGreaterThanOrEqual(5);
  });

  it('a detector that can never fill its memory is never active and never fires', () => {
    fc.assert(
      fc.property(sessionArb, variantArb, (o, variant) => {
        const run = runDetectorFile(synthSession(o).inputs, { arm_breaths: 21 }, o.polarity ?? 1, variant);
        expect(run.fires).toEqual([]);
        expect(run.armed).toEqual([]);
      }),
      { numRuns: RUNS, seed: 7406 },
    );
  });
});

/**
 * Fires that an oracle built from the input facts alone says must not happen (spec 7.4 rules 2
 * and 6, table periods). Conservative bounds, in camera-clock microseconds of the grid point:
 * - while the last narrator line is not "narrating", a listed code holds or voice is on;
 * - grid points emitted after a voice_off line, up to 4 s after the last sample before it;
 * - grid points inside a gap over 500 ms and up to 3 s after its end;
 * - within 2 s of the previous fire;
 * - before 15 s of reading (A needs 15 s of usable samples).
 */
function inactiveFires(inputs: readonly DetectorInput[], run: DetectorRun): string[] {
  const bad: string[] = [];
  const fireAt = new Map<number, FireRecord>(run.fires.map((f) => [f.index, f]));
  let narr: string | null = null;
  let codeBad = false;
  let voiceOn = false;
  let lastTs = Number.NEGATIVE_INFINITY;
  let readFromTs: number | null = null;
  let quietUntil = Number.NEGATIVE_INFINITY;
  const longGaps: [number, number][] = [];
  let prevFire = Number.NEGATIVE_INFINITY;
  inputs.forEach((r, k) => {
    switch (r.k) {
      case 'state':
        narr = r.s;
        if (r.s === 'narrating' && readFromTs === null) readFromTs = lastTs;
        return;
      case 'val':
        codeBad = INVALID_VALIDATION_CODES.includes(r.code);
        return;
      case 'voice':
        voiceOn = r.on;
        if (!r.on) quietUntil = Math.max(quietUntil, lastTs + 4e6);
        return;
      default:
        break;
    }
    const before = { narr, codeBad, voiceOn, quietUntil };
    for (const [ts] of (r as BatchInput).tr) {
      if (ts <= lastTs) continue;
      if (Number.isFinite(lastTs) && ts - lastTs > 500_000) longGaps.push([lastTs, ts]);
      lastTs = ts;
    }
    const f = fireAt.get(k);
    if (f === undefined) return;
    const t = f.tsUs;
    const why: string[] = [];
    if (before.narr !== 'narrating') why.push(`narrator ${String(before.narr)}`);
    if (before.codeBad) why.push('validation code');
    if (before.voiceOn) why.push('voice on');
    if (t <= before.quietUntil) why.push('post-voice period');
    if (longGaps.some(([a, b]) => t > a && t < b + 3e6)) why.push('long gap');
    if (t - prevFire < 2e6 - 1) why.push('post-fire period');
    if (readFromTs === null || t < readFromTs + 14.9e6) why.push('no amplitude yet');
    if (why.length > 0) bad.push(`input ${k} seq ${f.seq} at ${t}: ${why.join(', ')}`);
    prevFire = t;
  });
  return bad;
}

describe('replay identity over random sessions (spec 7.4, 13.4)', () => {
  it('the live run and the replay of its detector_in.jsonl fire on the same packets', () => {
    const fires = fireCounter();
    fc.assert(
      fc.property(sessionArb, variantArb, paramsArb, (o, variant, params) => {
        const ses = synthSession(o);
        const sign = o.polarity ?? 1;
        // Live: one step() per input; Deck answers each hold with its state lines.
        const live = runPosthoc(ses.inputs, {
          detector: { name: variant, init: () => initDetector(params, sign, variant), step },
          nArrBySeq: ses.nArrBySeq,
          keepInputs: true,
        });
        const text = live.inputs!.map(formatDetectorInLine).join('\n');
        const replay = runDetectorFile(parseDetectorIn(text), params, sign, variant);
        expect(replay.fires.map((f) => [f.seq, ses.nArrBySeq.get(f.seq), f.v, f.theta, f.rule])).toEqual(
          live.fires.map((f) => [f.seq, f.nArr, f.fire!.v, f.fire!.theta, f.fire!.rule]),
        );
        fires.add(live.fires.length);
      }),
      { numRuns: 12, seed: 7407 },
    );
    expect(fires.total()).toBeGreaterThanOrEqual(3);
  });
});

describe('replay identity (spec 7.4, 13.4)', () => {
  it('detector_in.jsonl gives the same fires on the same packets as the live run', () => {
    for (const variant of ['D1', 'D3'] as const) {
      for (const seed of [21, 22, 23]) {
        const ses = synthSession({
          seed,
          durationS: 200,
          objections: [{ atS: 100 }, { atS: 125, voice: false }, { atS: 150 }, { atS: 170, inhaleS: 0.35, depth: 1.6 }],
          early: [{ atS: 140.3, inhaleS: 1.0, depth: 0.75 }],
          vals: [
            { atS: 60, code: 12 },
            { atS: 61, code: 0 },
          ],
          gaps: [{ atS: 80, durS: 0.3 }],
          tsJitterUs: 3000,
        });
        // The live run: the worker feeds step() one input at a time and Deck answers each hold
        // with its state lines (hold_wait, then listening or resume and narrating).
        const live = runPosthoc(ses.inputs, {
          detector: { name: variant, init: () => initDetector({}, 1, variant), step },
          nArrBySeq: ses.nArrBySeq,
          keepInputs: true,
        });
        expect(live.fires.length).toBeGreaterThan(0);
        // What the worker and Deck wrote, read back from text.
        const detectorIn = live.inputs!.map(formatDetectorInLine).join('\n') + '\n';
        const stamps = [...ses.nArrBySeq].map(([seq, n]) => JSON.stringify({ n, k: 'arr', seq })).join('\n');
        const nArr = nArrMapFromStamps(stamps.split('\n').map((l) => JSON.parse(l) as { n: number; k: string; seq: number }));
        const replay = runDetectorFile(parseDetectorIn(detectorIn), {}, 1, variant);
        expect(replay.fires.map((f) => ({ seq: f.seq, nArr: nArr.get(f.seq), v: f.v, theta: f.theta, rule: f.rule }))).toEqual(
          live.fires.map((f) => ({ seq: f.seq, nArr: f.nArr, v: f.fire!.v, theta: f.fire!.theta, rule: f.fire!.rule })),
        );
      }
    }
  });
});
