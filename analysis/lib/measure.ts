// Measurements shared by quickcheck and doctor (spec 6.3, 7.3, 7.12, 9.4). Pure: sessions in memory.

import {
  CLICK_SAMPLES,
  LOOP_MAX_LAG_MS,
  QUANTUM_SAMPLES,
  audioIndex,
  isDeviceEvent,
  isPageHiddenEvent,
  lowerEnvelope,
  loopClickBlocks,
  measureLoopLatency,
  packetTimes,
  recordedSpan,
  type Envelope,
  type EventLine,
  type LoopMeasurement,
  type LoopOptions,
} from '../../core/clock/index.ts';
import { DEFAULT_VAD_PARAMS, measureFloorDb, vadEdges, vadStepFeatures, type VadEdge, type VadParams } from '../../core/vad/index.ts';
import type { TracePair } from '../../core/detector.ts';
import { audioView, stampsOfKind, stepMarks, stepSpan, type LoadedSession } from './session.ts';
import { LOOP_STEPS } from './steps.ts';

/** The in-memory parts of a session the measurements read. */
export type SessionView = Pick<
  LoadedSession,
  'sampleRateHz' | 'ch0' | 'ch1' | 'stamps' | 'samples' | 'events' | 'micSettings' | 'layout'
>;

/** Recording time of a sample number as m:ss.s, for messages. */
export function formatSampleTime(n: number, sampleRateHz: number): string {
  const s = Math.max(0, n / sampleRateHz);
  const m = Math.floor(s / 60);
  const rest = s - 60 * m;
  return `${m}:${rest < 10 ? '0' : ''}${rest.toFixed(1)}`;
}

/** Rounds to 0.1 (report values in ms and dB, spec 8.1). */
export function round1(x: number): number {
  return Math.round(x * 10) / 10;
}

/** Rounds a share to 0.001. */
export function round3(x: number): number {
  return Math.round(x * 1000) / 1000;
}

// ---- loop checks -------------------------------------------------------------------------

/** Click stamps inside a step's span; null when the step was never entered. */
export function clicksInStep(s: SessionView, step: string): number[] | null {
  const span = stepSpan(s, step);
  if (!span) return null;
  return stampsOfKind(s, 'click')
    .filter((c) => c.n >= span.n0 && c.n < span.n1)
    .map((c) => c.n);
}

/**
 * Click starts of loop checks A and B: the clicks inside the loop_a and loop_b steps. Without
 * those step marks, the click groups of core/clock (first and last full group of 10).
 */
export function loopClickStarts(s: SessionView): { A: number[] | null; B: number[] | null } {
  const a = clicksInStep(s, LOOP_STEPS.A);
  const b = clicksInStep(s, LOOP_STEPS.B);
  if (a === null && b === null) return loopClickBlocks(s.stamps);
  return { A: a && a.length > 0 ? a : null, B: b && b.length > 0 ? b : null };
}

/**
 * L_rt of one loop check at the given click stamps (core/clock measureLoopLatency), reading the
 * audio through the chunk layout as core/clock measureLoopBlocks does: a click in a gap is not found.
 */
export function measureLoopAtClicks(s: SessionView, clickNs: readonly number[] | null, opts: LoopOptions = {}): LoopMeasurement | null {
  if (!clickNs || clickNs.length === 0) return null;
  const rate = opts.sampleRateHz ?? s.sampleRateHz;
  const maxLag = Math.round(((opts.maxLagMs ?? LOOP_MAX_LAG_MS) * rate) / 1000);
  const span = 2 * QUANTUM_SAMPLES + CLICK_SAMPLES + maxLag;
  const starts = clickNs.map((n) => {
    const idx = audioIndex(s.layout, n - QUANTUM_SAMPLES, span);
    return idx === null ? Number.NaN : idx + QUANTUM_SAMPLES;
  });
  return measureLoopLatency(s.ch0, s.ch1, starts, { ...opts, sampleRateHz: rate });
}

export interface LoopPair {
  A: LoopMeasurement | null;
  B: LoopMeasurement | null;
  clicks: { A: number[] | null; B: number[] | null };
}

/** Both loop checks of a recording. */
export function measureLoops(s: SessionView, opts: LoopOptions = {}): LoopPair {
  const clicks = loopClickStarts(s);
  return { A: measureLoopAtClicks(s, clicks.A, opts), B: measureLoopAtClicks(s, clicks.B, opts), clicks };
}

// ---- events inside the recording --------------------------------------------------------------

/** True for an event inside the recorded span; an event without a sample number counts (core/clock rule). */
export function duringRecording(s: SessionView): (ev: EventLine) => boolean {
  const span = recordedSpan(s.layout);
  return (ev) => typeof ev.n !== 'number' || span === null || (ev.n >= span.n0 && ev.n <= span.n1);
}

/** Hard window and device events inside the recording (spec 6.3): device events and hidden pages. */
export function hardWindowEvents(s: SessionView): EventLine[] {
  const during = duringRecording(s);
  return s.events.filter((ev) => during(ev) && (isDeviceEvent(ev) || isPageHiddenEvent(ev)));
}

// ---- voice detector ---------------------------------------------------------------------------

/**
 * Noise floor of the voice detector over one step (spec 7.3, 7.12): core/vad measureFloorDb on
 * channel 0 of the step, dB re full-scale mean square. Null when the step was not recorded.
 */
export function stepFloorDb(s: SessionView, step: string, params: Partial<VadParams> = DEFAULT_VAD_PARAMS): number | null {
  const span = stepSpan(s, step);
  if (!span) return null;
  const view = audioView(s, 0, span.n0, span.n1);
  if (!view) return null;
  const db = measureFloorDb(view.signal, params);
  return Number.isFinite(db) ? db : null;
}

/**
 * voice_on edges of core/vad on channel 0 over [n0, n1), recomputed from the audio (spec 7.3).
 * The detector starts fresh at n0, so a voice already running at n0 gives an edge there; use
 * voiceEdgesOver from earlier when that must not count.
 */
export function voiceOnsIn(s: SessionView, n0: number, n1: number, params: Partial<VadParams>): number[] {
  const view = audioView(s, 0, n0, n1);
  if (!view) return [];
  return vadEdges(view.signal, params, view.n0)
    .filter((e) => e.on)
    .map((e) => e.n);
}

/**
 * Voice edges of core/vad on channel 0 over [n0, n1), one detector per recorded run (an audio
 * gap restarts it). Edges alternate, so a voice_on inside the stretch always follows silence:
 * a voice already running at a cue gives no new edge there.
 */
export function voiceEdgesOver(s: SessionView, n0: number, n1: number, params: Partial<VadParams>): VadEdge[] {
  const out: VadEdge[] = [];
  const runs = [...s.layout.runs].sort((a, b) => a.n0 - b.n0);
  for (const run of runs) {
    const a = Math.max(Math.round(n0), run.n0);
    const b = Math.min(Math.round(n1), run.n1);
    if (b <= a) continue;
    const view = audioView(s, 0, a, b);
    if (view) out.push(...vadEdges(view.signal, params, view.n0));
  }
  return out;
}

// ---- leak ---------------------------------------------------------------------------------------

export interface LeakMeasurement {
  /** Median channel 0 level while the narrator plays, dB re full-scale mean square. */
  leakDb: number;
  /** Steps (5 ms) where the narrator played. */
  activeSteps: number;
}

/** Channel 1 counts as playing when its step energy is within this of its 90th percentile. */
const LEAK_ACTIVE_BELOW_P90_DB = 20;

/**
 * Channel 0 level during the narrator, in the voice detector's measure: dB re full-scale mean
 * square of the 150 Hz high-passed signal over 10 ms windows every 5 ms (core/vad step energy).
 * Only steps where channel 1, delayed by L_rt, plays (energy within 20 dB of its 90th percentile)
 * count; the median of those steps is the level. The first 100 ms are skipped (filter start).
 */
export function narratorLeakDb(
  s: SessionView,
  n0: number,
  n1: number,
  lrtMs: number,
  params: Partial<VadParams> = DEFAULT_VAD_PARAMS,
): LeakMeasurement | null {
  const v0 = audioView(s, 0, n0, n1);
  const v1 = audioView(s, 1, n0, n1);
  if (!v0 || !v1) return null;
  const f0 = vadStepFeatures(v0.signal, params, v0.n0);
  const f1 = vadStepFeatures(v1.signal, params, v1.n0);
  const lagSteps = Math.round(lrtMs / (params.hopMs ?? DEFAULT_VAD_PARAMS.hopMs));
  const skip = Math.round(100 / (params.hopMs ?? DEFAULT_VAD_PARAMS.hopMs));
  const e1 = Array.from(f1.energyDb).filter((x) => Number.isFinite(x));
  if (e1.length === 0) return null;
  const sorted = [...e1].sort((a, b) => a - b);
  const p90 = sorted[Math.min(sorted.length - 1, Math.floor(0.9 * (sorted.length - 1)))]!;
  const values: number[] = [];
  for (let i = skip; i < f0.energyDb.length; i++) {
    const j = i - lagSteps;
    if (j < skip || j >= f1.energyDb.length) continue;
    if (f1.energyDb[j]! >= p90 - LEAK_ACTIVE_BELOW_P90_DB && Number.isFinite(f0.energyDb[i]!)) values.push(f0.energyDb[i]!);
  }
  if (values.length === 0) return null;
  values.sort((a, b) => a - b);
  const mid = values.length >> 1;
  const leakDb = values.length % 2 === 1 ? values[mid]! : (values[mid - 1]! + values[mid]!) / 2;
  return { leakDb, activeSteps: values.length };
}

// ---- cues ---------------------------------------------------------------------------------------

/** Cue starts from Deck's own `mark` `cue` stamps (on true) only: what condition 3 counts (spec 9.4). */
export function cueMarkStarts(s: Pick<SessionView, 'stamps'>): number[] {
  return s.stamps.filter((m) => m.k === 'mark' && m.what === 'cue' && m.on !== false).map((m) => m.n);
}

/**
 * Cue starts for measuring (the dot fills, spec 9.2): `mark` `cue` stamps with on true. When the
 * recording has none, the starts of the cue_<i>_on steps (Deck stamps both at the same sample).
 */
export function cueStarts(s: SessionView, cueOnSteps: readonly string[]): number[] {
  const marks = cueMarkStarts(s);
  if (marks.length > 0) return marks;
  const wanted = new Set(cueOnSteps);
  return stepMarks(s)
    .filter((m) => wanted.has(m.name))
    .map((m) => m.n);
}

// ---- trace and camera clock -----------------------------------------------------------------------

/** Unique trace samples [ts us, value] of the `m` lines, by timestamp. */
export function traceSamples(s: Pick<SessionView, 'samples'>): TracePair[] {
  const byTs = new Map<number, number>();
  for (const l of s.samples) {
    if (l.k !== 'm') continue;
    for (const [t, v] of l.tr ?? []) if (!byTs.has(t)) byTs.set(t, v);
  }
  return [...byTs.entries()].sort((a, b) => a[0] - b[0]).map(([t, v]) => [t, v] as const);
}

/** Lower envelope of packet arrivals (core/clock), for putting sample numbers on the camera clock. */
export function packetEnvelope(s: SessionView): Envelope | null {
  return lowerEnvelope(packetTimes(s), { sampleRateHz: s.sampleRateHz });
}

/**
 * Camera timestamp (us) of the moment at sample n: inverts the envelope d(x) = n/rate - x. It is
 * early by the shortest arrival latency, which a 0.5 s median window does not feel (assumption).
 */
export function sampleToCameraUs(env: Envelope, n: number, sampleRateHz: number): number {
  const x = (n / sampleRateHz - env.intercept) / (1 + env.slope);
  return env.x0Us + x * 1e6;
}

// ---- intervals -----------------------------------------------------------------------------------

export type Interval = readonly [start: number, end: number];

/** Total length of intervals. */
export function totalLength(intervals: readonly Interval[]): number {
  return intervals.reduce((acc, [a, b]) => acc + Math.max(0, b - a), 0);
}

/** Length of the overlap of two sets of disjoint intervals. */
export function overlapLength(a: readonly Interval[], b: readonly Interval[]): number {
  let sum = 0;
  for (const [a0, a1] of a) for (const [b0, b1] of b) sum += Math.max(0, Math.min(a1, b1) - Math.max(a0, b0));
  return sum;
}

/**
 * Reading time (spec 7.12): the spans in Deck state `narrating`, from each `state` narrating
 * stamp to the next state stamp of another value, or to the end of the recording.
 */
export function readingIntervals(s: SessionView): Interval[] {
  const end = recordedSpan(s.layout)?.n1 ?? 0;
  const states = s.stamps.filter((m) => m.k === 'state' && typeof m.s === 'string');
  const out: Interval[] = [];
  let start: number | null = null;
  for (const st of states) {
    if (st.s === 'narrating') {
      if (start === null) start = st.n;
    } else if (start !== null) {
      out.push([start, st.n]);
      start = null;
    }
  }
  if (start !== null && end > start) out.push([start, end]);
  return out;
}

/** Detector names of the worker's `armed` events (it writes its live variant, D1 or D3), in order of first appearance. */
export function armedDetectors(s: Pick<SessionView, 'events'>): string[] {
  const out: string[] = [];
  for (const ev of s.events) {
    const det = ev['det'];
    if (ev.e === 'armed' && typeof det === 'string' && !out.includes(det)) out.push(det);
  }
  return out;
}

/** Spans where detector `det` was armed, from the worker's `armed` events (spec 8.1). */
export function armedIntervals(s: SessionView, det = 'D1'): Interval[] {
  const end = recordedSpan(s.layout)?.n1 ?? 0;
  const out: Interval[] = [];
  let start: number | null = null;
  const armed = s.events
    .filter((ev) => ev.e === 'armed' && ev['det'] === det && typeof ev.n === 'number')
    .sort((p, q) => (p.n as number) - (q.n as number));
  for (const ev of armed) {
    const n = ev.n as number;
    if (ev['on'] === true) {
      if (start === null) start = n;
    } else if (start !== null) {
      out.push([start, n]);
      start = null;
    }
  }
  if (start !== null && end > start) out.push([start, end]);
  return out;
}
