import { describe, expect, it } from 'vitest';
import { synthSession } from '../../core/detector/synth.ts';
import { DEEP_BREATH_SIGN_ERROR } from './deep-breath-sign.ts';
import { replayFires } from './detector-adapter.ts';
import type { DetectorInput } from './core.ts';
import type { PktMessage, TracePair, WorkerToMain } from './messages.ts';
import { deepBreathTake, takeSampleAt, type DeepBreathTake } from './testing/deep-breaths.ts';
import { TAP_URL, wiredWorker, type WiredWorker } from './testing/fake-io.ts';
import { lineProblems } from './testing/spec-lines.ts';
import { tapLinesOf } from './testing/tap-synth.ts';
import { LIVE_TRACE_STEP_US, newTraceThinning, thinTrace } from './worker-core.ts';

const D1_SETUP = { params: {}, sign: 1, variant: 'D1' } as const;

function stamp(w: WiredWorker, line: Record<string, unknown>): void {
  w.deck({ k: 'stamp', line });
}

function pkts(w: WiredWorker): PktMessage[] {
  return w.port.posted as PktMessage[];
}

function errors(w: WiredWorker): string[] {
  return w.toMain.filter((m): m is Extract<WorkerToMain, { k: 'error' }> => m.k === 'error').map((m) => m.message);
}

function ofKind<K extends WorkerToMain['k']>(w: WiredWorker, k: K): Array<Extract<WorkerToMain, { k: K }>> {
  return w.toMain.filter((m): m is Extract<WorkerToMain, { k: K }> => m.k === k);
}

function events(w: WiredWorker, e: string): Array<Record<string, unknown>> {
  return w.session.lines('event').filter((l) => l.e === e);
}

function expectSpecLines(w: WiredWorker): void {
  expect(lineProblems('stamps.jsonl', w.session.lines('stamp'))).toEqual([]);
  expect(lineProblems('detector_in.jsonl', w.session.lines('det'))).toEqual([]);
  expect(lineProblems('events.jsonl', w.session.lines('event'))).toEqual([]);
}

/**
 * A headstart take through the worker as Deck and tap deliver it: each packet, then its arr stamp;
 * Deck's step marks in sample order; the narrator reads from camera time readAtS (null: never).
 */
function runTake(w: WiredWorker, take: DeepBreathTake, opts: { readAtS?: number | null; before?: (name: string) => void } = {}): { readN: number | null } {
  const readN = opts.readAtS === null || opts.readAtS === undefined ? null : takeSampleAt(take, opts.readAtS);
  const marks: Array<{ name: string; n: number; state?: string }> = [...take.marks];
  if (readN !== null) marks.push({ name: 'opening', n: readN, state: 'narrating' });
  marks.sort((a, b) => a.n - b.n);
  stamp(w, { n: 0, k: 'state', s: 'idle' });
  const deliver = (m: { name: string; n: number; state?: string }) => {
    opts.before?.(m.name);
    if (m.state) stamp(w, { n: m.n, k: 'state', s: m.state });
    stamp(w, { n: m.n, k: 'mark', what: 'step', name: m.name });
  };
  for (const line of take.lines) {
    const nArr = take.nArrBySeq.get(line.seq) as number;
    while (marks.length > 0 && marks[0]!.n <= nArr) deliver(marks.shift()!);
    w.tap?.receive(line);
    stamp(w, { n: nArr, k: 'arr', seq: line.seq });
  }
  for (const m of marks) deliver(m);
  return { readN };
}

function markN(take: DeepBreathTake, name: string): number {
  const m = take.marks.find((x) => x.name === name);
  if (!m) throw new Error(`no mark ${name}`);
  return m.n;
}

/** The d of each deep breath in a detector_sign line: three finite numbers of one sign. */
function expectD(line: Record<string, unknown> | undefined, sign: 1 | -1): void {
  const d = line?.d as number[];
  expect(d).toHaveLength(3);
  for (const x of d) expect(Math.sign(x)).toBe(sign);
}

describe('worker, headstart: the trace sign from the three deep breaths (spec 7.4, 7.11)', () => {
  it('sets the sign at the step after the last exhale; step() then runs with it', () => {
    const take = deepBreathTake({ signs: [-1, -1, -1] });
    const w = wiredWorker({ mode: 'headstart', tapUrl: TAP_URL, detector: D1_SETUP });
    runTake(w, take, { readAtS: 40 });
    const signs = events(w, 'detector_sign');
    expect(signs).toEqual([{ n: markN(take, 'rest_1'), e: 'detector_sign', det: 'D1', sign: -1, d: expect.any(Array) }]);
    // Each breath's change of the raw trace over its inhale (core/detector polaritySign), for the record.
    expectD(signs[0], -1);
    expect(w.worker.detector).toEqual({ params: {}, sign: -1, variant: 'D1' });
    expect(errors(w)).toEqual([]);
    // Replaying detector_in.jsonl with the sign of the run gives the answers the run kept.
    const det = w.session.lines('det') as unknown as DetectorInput[];
    const fired = events(w, 'fire').map((f) => ({ seq: f.seq, v: f.v, theta: f.theta }));
    expect(replayFires({ params: {}, sign: -1, variant: 'D1' }, det)).toEqual(fired);
    expectSpecLines(w);
  });

  it('finds +1 for a trace that rises on the inhale', () => {
    const take = deepBreathTake();
    const w = wiredWorker({ mode: 'headstart', tapUrl: TAP_URL, detector: D1_SETUP });
    runTake(w, take, { readAtS: 40 });
    const signs = events(w, 'detector_sign');
    expect(signs).toEqual([{ n: markN(take, 'rest_1'), e: 'detector_sign', det: 'D1', sign: 1, d: expect.any(Array) }]);
    expectD(signs[0], 1);
    expect(errors(w)).toEqual([]);
    expectSpecLines(w);
  });

  it('no clear sign: the page gets the error once and D1 never stops the narrator', () => {
    const take = deepBreathTake({ signs: [1, -1, 1] });
    const w = wiredWorker({ mode: 'headstart', tapUrl: TAP_URL, detector: D1_SETUP });
    runTake(w, take, { readAtS: 40 });
    // The error comes at rest_1; reading later adds no second one.
    expect(errors(w)).toEqual([DEEP_BREATH_SIGN_ERROR]);
    // events.jsonl keeps that D1 was off in this run, why, and each breath's d (spec 7.11: the folder stays with the run).
    const signs = events(w, 'detector_sign');
    expect(signs).toEqual([
      { n: markN(take, 'rest_1'), e: 'detector_sign', det: 'D1', why: 'the deep breaths do not move the trace the same way', sign: null, d: expect.any(Array) },
    ]);
    expect((signs[0]?.d as number[]).map(Math.sign)).toEqual([1, -1, 1]);
    // In the key order of the spec 8.1 examples, as host writes it.
    expectSpecLines(w);
    expect(pkts(w)).toHaveLength(take.lines.length);
    expect(pkts(w).every((p) => p.hold === false)).toBe(true);
    expect(events(w, 'fire')).toEqual([]);
    expect(events(w, 'armed')).toEqual([]);
    expect(ofKind(w, 'fire')).toEqual([]);
    expect(ofKind(w, 'armed')).toEqual([]);
  });

  it('the breaths too small for the margin of spec 7.4 give the same error', () => {
    const w = wiredWorker({ mode: 'headstart', tapUrl: TAP_URL, detector: D1_SETUP });
    runTake(w, deepBreathTake({ amps: [1, 0.2, 1] }), { readAtS: 40 });
    expect(errors(w)).toEqual([DEEP_BREATH_SIGN_ERROR]);
    const signs = events(w, 'detector_sign');
    expect(signs).toMatchObject([{ e: 'detector_sign', det: 'D1', sign: null, why: 'the smallest change on a deep breath is under a third of the largest (spec 7.4)' }]);
    expectD(signs[0], 1);
    expectSpecLines(w);
  });

  it('a breath window without a trace sample gives d null in the record, not NaN', () => {
    const take = deepBreathTake();
    // The packets around the end of the second inhale (camera time 27.6 s to 28.4 s) never come.
    const gap = (l: Record<string, unknown>) => {
      const ts = ((l.tr as TracePair[])[0]![0] - take.opts.startUs) / 1e6;
      return ts > 27.6 && ts < 28.4;
    };
    const kept: DeepBreathTake = { ...take, lines: take.lines.filter((l) => !gap(l)) };
    const w = wiredWorker({ mode: 'headstart', tapUrl: TAP_URL, detector: D1_SETUP });
    runTake(w, kept, { readAtS: 40 });
    expect(errors(w)).toEqual([DEEP_BREATH_SIGN_ERROR]);
    const signs = events(w, 'detector_sign');
    expect(signs).toHaveLength(1);
    expect(signs[0]).toMatchObject({ sign: null, why: 'the deep breaths do not move the trace the same way' });
    expect((signs[0]?.d as Array<number | null>)[1]).toBeNull();
    expect(w.session.lineTexts('event').every((t) => !t.includes('NaN'))).toBe(true);
    expectSpecLines(w);
  });

  it('reading starts before any deep breath: the error, and detector_sign with sign null', () => {
    const take = deepBreathTake();
    const w = wiredWorker({ mode: 'headstart', tapUrl: TAP_URL, detector: D1_SETUP });
    const { readN } = runTake(w, take, { readAtS: 10 });
    expect(errors(w)).toEqual([expect.stringMatching(/^worker: no trace sign before reading started/)]);
    expect(events(w, 'detector_sign')).toEqual([{ n: readN, e: 'detector_sign', det: 'D1', why: 'reading started before any deep breath', sign: null }]);
    expect(pkts(w).every((p) => p.hold === false)).toBe(true);
    expectSpecLines(w);
  });

  it('reading starts before the step after the last exhale: the breaths seen so far decide', () => {
    const take = deepBreathTake({ signs: [-1, -1, -1], afterStep: null });
    const w = wiredWorker({ mode: 'headstart', tapUrl: TAP_URL, detector: D1_SETUP });
    const { readN } = runTake(w, take, { readAtS: 38.5 });
    const signs = events(w, 'detector_sign');
    expect(signs).toEqual([{ n: readN, e: 'detector_sign', det: 'D1', sign: -1, d: expect.any(Array) }]);
    expectD(signs[0], -1);
    expect(errors(w)).toEqual([]);
  });

  it('a sign from the page before the breaths end is kept; the worker does not look again', () => {
    const take = deepBreathTake({ signs: [-1, -1, -1] });
    const w = wiredWorker({ mode: 'headstart', tapUrl: TAP_URL, detector: D1_SETUP });
    runTake(w, take, {
      readAtS: 40,
      before: (name) => {
        if (name === 'deep_2_in') w.worker.onMainMessage({ k: 'detector', sign: 1 });
      },
    });
    // The page's sign carries no d: the worker did not measure the breaths.
    expect(events(w, 'detector_sign')).toEqual([{ n: expect.any(Number), e: 'detector_sign', det: 'D1', sign: 1 }]);
    expect(w.worker.detector?.sign).toBe(1);
    expect(errors(w)).toEqual([]);
  });

  it('session mode takes its sign from the setup and never looks at the breaths', () => {
    const w = wiredWorker({ mode: 'session', tapUrl: TAP_URL, detector: { params: {}, sign: -1, variant: 'D1' } });
    runTake(w, deepBreathTake(), { readAtS: 40 });
    expect(events(w, 'detector_sign')).toEqual([]);
    expect(w.worker.detector?.sign).toBe(-1);
    expect(errors(w)).toEqual([]);
  });
});

describe('worker -> page: the live view messages (spec 15.2)', () => {
  it('trace: each packet at its arr stamp, with nArr, the sign step() ran it with and its sample count', () => {
    const take = deepBreathTake({ signs: [-1, -1, -1] });
    const w = wiredWorker({ mode: 'headstart', tapUrl: TAP_URL, detector: D1_SETUP });
    runTake(w, take, { readAtS: 40 });
    const traces = ofKind(w, 'trace');
    expect(traces).toHaveLength(take.lines.length);
    const signAt = markN(take, 'rest_1');
    traces.forEach((t, i) => {
      const line = take.lines[i]!;
      const [ts, v] = (line.tr as TracePair[])[0]!;
      const nArr = take.nArrBySeq.get(line.seq) as number;
      const sign = nArr < signAt ? 1 : -1;
      expect(t).toEqual({ k: 'trace', n: nArr, sign, count: 1, pts: [[ts, v * sign]] });
    });
  });

  it('trace: a packet that Deck never stamped is never sent', () => {
    const take = deepBreathTake();
    const w = wiredWorker({ mode: 'headstart', tapUrl: TAP_URL, detector: D1_SETUP });
    for (const line of take.lines.slice(0, 30)) w.tap?.receive(line);
    for (const line of take.lines.slice(0, 30)) if (line.seq % 2 === 0) stamp(w, { n: take.nArrBySeq.get(line.seq), k: 'arr', seq: line.seq });
    expect(ofKind(w, 'trace').map((t) => t.n)).toEqual(take.lines.slice(0, 30).filter((l) => l.seq % 2 === 0).map((l) => take.nArrBySeq.get(l.seq)));
  });

  it('fire and armed: as written to events.jsonl, in live mode', () => {
    const ses = synthSession({ seed: 2, durationS: 80, ratePerMin: 20, objections: [{ atS: 70, voice: false }], vals: [{ atS: 30, code: 0 }] });
    const w = wiredWorker({ mode: 'session', tapUrl: TAP_URL, detector: D1_SETUP });
    stamp(w, { n: 0, k: 'state', s: 'narrating' });
    for (const line of tapLinesOf(ses.inputs)) {
      w.tap?.receive(line);
      if (line.k === 'm') stamp(w, { n: ses.nArrBySeq.get(line.seq) as number, k: 'arr', seq: line.seq });
    }
    const fires = events(w, 'fire');
    expect(fires).toHaveLength(1);
    expect(ofKind(w, 'fire')).toEqual(fires.map((f) => ({ k: 'fire', n: f.n, v: f.v, theta: f.theta })));
    const armed = events(w, 'armed');
    expect(armed.length).toBeGreaterThan(0);
    expect(ofKind(w, 'armed')).toEqual(armed.map((a) => ({ k: 'armed', n: a.n, on: a.on })));
    // Every packet's trace went out too.
    expect(ofKind(w, 'trace').length).toBe(tapLinesOf(ses.inputs).filter((l) => l.k === 'm').length);
  });

  it('gate and smoke runs send none of them', () => {
    for (const mode of ['gate', 'smoke', 'live-sim']) {
      const w = wiredWorker({ mode, tapUrl: TAP_URL, detector: D1_SETUP });
      runTake(w, deepBreathTake({ signs: [-1, -1, -1] }), { readAtS: 40 });
      expect(w.toMain.filter((m) => m.k === 'trace' || m.k === 'fire' || m.k === 'armed')).toEqual([]);
      expect(errors(w)).toEqual([]);
      expect(events(w, 'detector_sign')).toEqual([]);
    }
  });
});

describe('thinTrace: the live trace at about 30 points per second (spec 15.2)', () => {
  const T0 = 1_794_935_100_000_000;

  it('keeps every point of a 30 Hz trace, jitter and rounding included', () => {
    const state = newTraceThinning();
    let kept = 0;
    for (let i = 0; i < 300; i++) {
      const ts = T0 + Math.round((i * 1e6) / 30) + ((i * 7919) % 9) * 1_000 - 4_000;
      kept += thinTrace([[ts, i]], 1, state).length;
    }
    expect(kept).toBe(300);
  });

  it('thins a 90 Hz trace to one point per 1/30 s step and applies the sign', () => {
    const state = newTraceThinning();
    const tr: TracePair[] = Array.from({ length: 270 }, (_, i) => [T0 + Math.round((i * 1e6) / 90), i + 1]);
    const pts = thinTrace(tr, -1, state);
    // 3 s of camera time: steps 0 to 90 of the grid from the first point.
    expect(pts).toHaveLength(91);
    expect(pts[0]).toEqual([T0, -1]);
    expect(pts[1]).toEqual([tr[2]![0], -3]);
    expect(pts[2]).toEqual([tr[5]![0], -6]);
    for (let i = 1; i < pts.length; i++) expect(pts[i]![0] - pts[i - 1]![0]).toBeGreaterThan(LIVE_TRACE_STEP_US / 2);
  });

  it('drops values that are not finite, repeats and points older than the last kept', () => {
    const state = newTraceThinning();
    expect(thinTrace([[T0, Number.NaN], [Number.NaN, 1], [T0, 2]], 1, state)).toEqual([[T0, 2]]);
    expect(thinTrace([[T0, 3], [T0 - 40_000, 4], [T0 + 10_000, 5]], 1, state)).toEqual([]);
    expect(thinTrace([[T0 + 33_000, 6]], 1, state)).toEqual([[T0 + 33_000, 6]]);
  });

  it('starts again when the camera clock goes back by more than 5 s', () => {
    const state = newTraceThinning();
    thinTrace([[T0, 1]], 1, state);
    expect(thinTrace([[T0 - 2e6, 2]], 1, state)).toEqual([]);
    expect(thinTrace([[T0 - 60e6, 3]], 1, state)).toEqual([[T0 - 60e6, 3]]);
    expect(thinTrace([[T0 - 60e6 + 33_334, 4]], 1, state)).toEqual([[T0 - 60e6 + 33_334, 4]]);
  });
});
