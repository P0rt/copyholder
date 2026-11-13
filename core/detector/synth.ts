// Synthetic sessions with known truth for detector tests and simulations (spec 13.4).
// Pure and seeded: the same options give the same detector_in.jsonl lines and nArr stamps.

import { gaussian, mulberry32 } from './math.ts';
import { SAMPLE_RATE_HZ } from './params.ts';
import type { BatchInput, DetectorInput, NarratorState, Sign, TracePair } from './types.ts';

/** A steep pre-speech inhale followed by a spoken reply. */
export interface SynthObjection {
  /** Session time the inhale starts, s. */
  atS: number;
  /** Inhale duration, s (default 0.5). */
  inhaleS?: number;
  /** Rise of the inhale, in ordinary depths (default 1.3). */
  depth?: number;
  /** Voiced reply length, s (default 2.0). */
  speechS?: number;
  /** Voice onset after the inhale peak, s (default 0.1). */
  voiceDelayS?: number;
  /** False for a steep inhale with no reply (default true). */
  voice?: boolean;
}

/** A breath that starts before the exhale has ended (for D3). */
export interface SynthEarlyBreath {
  atS: number;
  inhaleS: number;
  /** Rise of this inhale, in ordinary depths. */
  depth: number;
}

export interface SynthOptions {
  seed: number;
  durationS: number;
  /** Breaths per minute (default 15). */
  ratePerMin?: number;
  /** Relative std of the cycle length (default 0.05). */
  rateJitter?: number;
  /** Relative std of the depth (default 0.05). */
  depthJitter?: number;
  /** Inhale share of a cycle (default 0.4). */
  inhaleFraction?: number;
  /** White noise std, in depths (default 0.005). */
  noise?: number;
  /** Slow baseline drift amplitude, in depths (default 0). */
  driftAmp?: number;
  driftPeriodS?: number;
  /** Trace units per depth (default 0.8) and offset (default -0.4). */
  scale?: number;
  offset?: number;
  /** Raw polarity of the trace: -1 makes an inhale a fall (default 1). */
  polarity?: Sign;
  /** Uniform jitter of SDK timestamps, +/- microseconds (default 2000). */
  tsJitterUs?: number;
  /** Probability that a frame is missing (default 0.01). */
  dropProb?: number;
  /** Probability that a packet carries two samples (default 0.05). */
  burstProb?: number;
  /** SDK-to-Deck arrival latency range, ms (default [60, 110]). */
  latencyMs?: readonly [number, number];
  /** No trace samples in [atS, atS + durS). */
  gaps?: readonly { atS: number; durS: number }[];
  objections?: readonly SynthObjection[];
  early?: readonly SynthEarlyBreath[];
  /** Session time of the first "narrating" line (default 0; null for none). */
  narratingFromS?: number | null;
  /** More narrator state lines. */
  states?: readonly { atS: number; s: NarratorState }[];
  /** More voice segments: voice_on at onS, voice_off at offS. */
  voices?: readonly { onS: number; offS: number }[];
  /** validationStatus codes. */
  vals?: readonly { atS: number; code: number }[];
  /** Camera clock of session time 0, microseconds. */
  t0Us?: number;
}

export interface SynthObjectionTruth {
  inhaleStartS: number;
  peakS: number;
  voiceOnS: number;
  voiceOnN: number;
  voiceOffN: number;
}

export interface SynthSession {
  inputs: DetectorInput[];
  nArrBySeq: Map<number, number>;
  objections: SynthObjectionTruth[];
  t0Us: number;
  /** Audio sample number of a session time. */
  nOf(tS: number): number;
  /** Camera timestamp of a session time, microseconds. */
  tsOf(tS: number): number;
  /** Clean breathing level at a session time, in depths. */
  level(tS: number): number;
}

const AUDIO_LEAD_S = 20;
const FRAME_S = 1 / 30;

function cosStep(a: number, b: number, u: number): number {
  return a + ((b - a) * (1 - Math.cos(Math.PI * u))) / 2;
}

interface Knots {
  t: number[];
  y: number[];
}

function levelAt(k: Knots, tS: number): number {
  const t = k.t;
  if (tS <= t[0]!) return k.y[0]!;
  if (tS >= t[t.length - 1]!) return k.y[k.y.length - 1]!;
  let lo = 0;
  let hi = t.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (t[mid]! <= tS) lo = mid;
    else hi = mid;
  }
  const u = (tS - t[lo]!) / (t[hi]! - t[lo]!);
  return cosStep(k.y[lo]!, k.y[hi]!, u);
}

type BreathEvent =
  | { kind: 'obj'; atS: number; inhaleS: number; depth: number; speechS: number | null }
  | { kind: 'early'; atS: number; inhaleS: number; depth: number };

function buildKnots(o: SynthOptions, rng: () => number): Knots {
  const rate = o.ratePerMin ?? 15;
  const period0 = 60 / rate;
  const fr0 = o.inhaleFraction ?? 0.4;
  const rj = o.rateJitter ?? 0.05;
  const dj = o.depthJitter ?? 0.05;
  const events: BreathEvent[] = [
    ...(o.objections ?? []).map(
      (e): BreathEvent => ({
        kind: 'obj',
        atS: e.atS,
        inhaleS: e.inhaleS ?? 0.5,
        depth: e.depth ?? 1.3,
        speechS: e.voice === false ? null : (e.voiceDelayS ?? 0.1) + (e.speechS ?? 2.0),
      }),
    ),
    ...(o.early ?? []).map((e): BreathEvent => ({ kind: 'early', ...e })),
  ].sort((a, b) => a.atS - b.atS);
  const k: Knots = { t: [-10], y: [0] };
  const push = (t: number, y: number): void => {
    if (t <= k.t[k.t.length - 1]!) return;
    k.t.push(t);
    k.y.push(y);
  };
  const end = o.durationS + 10;
  const exhaleS = (1 - fr0) * period0;
  const planned: { t: number; y: number }[] = [];
  let ev = 0;
  for (;;) {
    const lastT = k.t[k.t.length - 1]!;
    const lastY = k.y[k.y.length - 1]!;
    if (planned.length === 0) {
      if (lastT >= end) break;
      const P = Math.max(0.5 * period0, period0 * (1 + rj * gaussian(rng)));
      const f = Math.min(0.6, Math.max(0.25, fr0 * (1 + 0.05 * gaussian(rng))));
      const d = Math.max(0.3, 1 + dj * gaussian(rng));
      planned.push({ t: lastT + f * P, y: d }, { t: lastT + P, y: 0 });
    }
    const next = planned[0]!;
    const e = events[ev];
    if (e !== undefined && e.atS < next.t) {
      // The event interrupts whatever segment is in progress.
      ev++;
      planned.length = 0;
      const at = Math.max(e.atS, lastT);
      const yCut = at > lastT ? cosStep(lastY, next.y, (at - lastT) / (next.t - lastT)) : lastY;
      push(at, yCut);
      const peakT = at + e.inhaleS;
      if (e.kind === 'obj' && e.speechS !== null) {
        // Speaking exhales slowly down to a little under the usual trough.
        planned.push({ t: peakT, y: yCut + e.depth }, { t: peakT + e.speechS + 0.3, y: -0.1 });
      } else {
        planned.push({ t: peakT, y: yCut + e.depth }, { t: peakT + exhaleS, y: 0 });
      }
      continue;
    }
    planned.shift();
    push(next.t, next.y);
  }
  return k;
}

interface Timed {
  at: number;
  order: number;
  input: DetectorInput;
}

/** A synthetic session: breathing trace, SDK timestamp jitter and packets, Deck lines (spec 8.1). */
export function synthSession(o: SynthOptions): SynthSession {
  const rng = mulberry32(o.seed);
  const knots = buildKnots(o, mulberry32(o.seed ^ 0x9e3779b9));
  const t0Us = o.t0Us ?? 1_794_935_000_000_000;
  const nOf = (tS: number): number => Math.round((tS + AUDIO_LEAD_S) * SAMPLE_RATE_HZ);
  const tsOf = (tS: number): number => t0Us + Math.round(tS * 1e6);
  const scale = o.scale ?? 0.8;
  const offset = o.offset ?? -0.4;
  const pol = o.polarity ?? 1;
  const noise = o.noise ?? 0.005;
  const driftAmp = o.driftAmp ?? 0;
  const driftPeriod = o.driftPeriodS ?? 47;
  const jitter = o.tsJitterUs ?? 2000;
  const drop = o.dropProb ?? 0.01;
  const burst = o.burstProb ?? 0.05;
  const [latLo, latHi] = o.latencyMs ?? [60, 110];
  const gaps = o.gaps ?? [];
  const inGap = (tS: number): boolean => gaps.some((g) => tS >= g.atS && tS < g.atS + g.durS);
  const level = (tS: number): number => levelAt(knots, tS);

  // Trace samples with SDK timestamps.
  const samples: { tS: number; pair: TracePair }[] = [];
  let lastTs = Number.NEGATIVE_INFINITY;
  const frames = Math.floor(o.durationS / FRAME_S);
  for (let f = 0; f <= frames; f++) {
    const nominal = f * FRAME_S;
    let ts = tsOf(nominal) + Math.round((rng() * 2 - 1) * jitter);
    const skip = rng() < drop;
    const g = gaussian(rng);
    if (skip || inGap(nominal)) continue;
    if (ts <= lastTs) ts = lastTs + 1;
    lastTs = ts;
    const tS = (ts - t0Us) / 1e6;
    const drift = driftAmp * Math.sin((2 * Math.PI * tS) / driftPeriod);
    const value = pol * (scale * (level(tS) + drift + noise * g) + offset);
    samples.push({ tS, pair: [ts, value] });
  }

  const timed: Timed[] = [];
  let order = 0;
  const callbacks: { at: number; make: (seq: number) => { input: DetectorInput; arrS: number } }[] = [];
  for (let i = 0; i < samples.length; ) {
    const count = rng() < burst && i + 1 < samples.length ? 2 : 1;
    const group = samples.slice(i, i + count);
    i += count;
    const lastS = group[group.length - 1]!.tS;
    const arrS = lastS + (latLo + rng() * (latHi - latLo)) / 1000;
    callbacks.push({
      at: lastS,
      make: (seq) => ({ input: { k: 'batch', seq, tr: group.map((g) => g.pair) }, arrS }),
    });
  }
  for (const v of o.vals ?? []) {
    const arrS = v.atS + (latLo + rng() * (latHi - latLo)) / 1000;
    callbacks.push({ at: v.atS, make: (seq) => ({ input: { k: 'val', seq, code: v.code }, arrS }) });
  }
  callbacks.sort((a, b) => a.at - b.at);
  const nArrBySeq = new Map<number, number>();
  let lastArr = 0;
  let seq = 1000;
  for (const cb of callbacks) {
    seq++;
    const { input, arrS } = cb.make(seq);
    if (input.k === 'batch') {
      const n = Math.max(lastArr, Math.ceil(nOf(arrS) / 128) * 128);
      lastArr = n;
      nArrBySeq.set(seq, n);
      timed.push({ at: n - 100, order: order++, input });
    } else {
      timed.push({ at: nOf(arrS), order: order++, input });
    }
  }

  const deckLine = (tS: number, input: DetectorInput): void => {
    timed.push({ at: nOf(tS) + 100, order: order++, input });
  };
  if (o.narratingFromS !== null) {
    const at = o.narratingFromS ?? 0;
    deckLine(at, { k: 'state', n: nOf(at), s: 'narrating' });
  }
  for (const s of o.states ?? []) deckLine(s.atS, { k: 'state', n: nOf(s.atS), s: s.s });
  for (const v of o.voices ?? []) {
    deckLine(v.onS, { k: 'voice', n: nOf(v.onS), on: true });
    deckLine(v.offS, { k: 'voice', n: nOf(v.offS), on: false });
  }
  const objections: SynthObjectionTruth[] = [];
  for (const e of o.objections ?? []) {
    const inhaleS = e.inhaleS ?? 0.5;
    const peakS = e.atS + inhaleS;
    const voiceOnS = peakS + (e.voiceDelayS ?? 0.1) + 0.03; // VAD needs 30 ms voiced (spec 7.3)
    const voiceOffS = peakS + (e.voiceDelayS ?? 0.1) + (e.speechS ?? 2.0) + 1.2; // 1.2 s of no voice
    if (e.voice !== false) {
      deckLine(voiceOnS, { k: 'voice', n: nOf(voiceOnS), on: true });
      deckLine(voiceOffS, { k: 'voice', n: nOf(voiceOffS), on: false });
    }
    objections.push({ inhaleStartS: e.atS, peakS, voiceOnS, voiceOnN: nOf(voiceOnS), voiceOffN: nOf(voiceOffS) });
  }
  timed.sort((a, b) => a.at - b.at || a.order - b.order);
  return { inputs: timed.map((x) => x.input), nArrBySeq, objections, t0Us, nOf, tsOf, level };
}

/** Same session with every trace value multiplied by c. */
export function scaleTrace(inputs: readonly DetectorInput[], c: number): DetectorInput[] {
  return inputs.map((r) => (r.k === 'batch' ? ({ ...r, tr: r.tr.map(([t, v]) => [t, v * c] as const) } as BatchInput) : r));
}
