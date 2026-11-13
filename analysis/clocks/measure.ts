// The audio and trace events the clocks command measures (spec 6.3, 7.4, 7.12): 'pa' bursts per
// prompt, sniff onsets, A_ref of the listening block, the trace sign from the three cued deep
// breaths, and the direction the sniffs move the trace. Pure: sessions in memory.

import { tracePackets, type TracePacket } from '../../core/clock/index.ts';
import { median, percentileSorted } from '../../core/detector/math.ts';
import { AMP_MIN_MS, AMP_P_HIGH, AMP_P_LOW, AMP_WINDOW_MS, polaritySign, type CueWindow, type PolarityResult } from '../../core/detector.ts';
import { findPaBursts, findSniffOnset } from '../../core/onset/index.ts';
import { packetEnvelope, sampleToCameraUs, traceSamples, type SessionView } from '../lib/measure.ts';
import { runView, stepSpan, stepStart } from '../lib/session.ts';
import { deepInSteps, paClosedSteps, paSteps } from '../lib/steps.ts';

/** Most 'pa' prompts looked for in one block (the scenarios have 5; spec 6.3). */
export const PA_PROMPTS_MAX = 20;
/** Cued deep breaths of the trace sign (spec 7.4). */
export const DEEP_BREATHS = 3;
/** A sniff onset is searched up to 2 s after its prompt (core/onset default; spec 9.3 timing). */
export const SNIFF_SEARCH_MS = 2000;

export interface PaBlock {
  /** Prompts found in the recording ('Lips closed' marks). */
  prompts: number;
  /** One plosive burst per prompt window, the first one in it (sample numbers). */
  bursts: number[];
}

/**
 * 'pa' bursts of one block (spec 6.3): core/onset findPaBursts over the block, from the first
 * 'Lips closed' mark to the end of the last 'pa' step, then the first burst inside each prompt
 * window [its 'Lips closed' mark, the next one). A window without a burst gives none.
 */
export function paBlockBursts(s: SessionView, tag: 'pa_start' | 'pa_end'): PaBlock {
  const closedNames = paClosedSteps(tag, PA_PROMPTS_MAX);
  const paNames = paSteps(tag, PA_PROMPTS_MAX);
  const starts = closedNames.map((name) => stepStart(s, name)).filter((n): n is number => n !== null);
  if (starts.length === 0) return { prompts: 0, bursts: [] };
  starts.sort((a, b) => a - b);
  let lastPa: { n0: number; n1: number } | null = null;
  for (const name of paNames) {
    const span = stepSpan(s, name);
    if (span && (lastPa === null || span.n1 > lastPa.n1)) lastPa = span;
  }
  const first = starts[0]!;
  const view = runView(s, 0, first);
  if (!view) return { prompts: starts.length, bursts: [] };
  const blockEnd = Math.min(view.n1, lastPa ? lastPa.n1 : view.n1);
  if (blockEnd <= first) return { prompts: starts.length, bursts: [] };
  const found = findPaBursts(view.signal, first, blockEnd, { n0: view.n0 }).bursts;
  const bursts: number[] = [];
  starts.forEach((n0, i) => {
    const n1 = starts[i + 1] ?? blockEnd;
    const b = found.find((x) => x.n >= n0 && x.n < n1);
    if (b) bursts.push(b.n);
  });
  return { prompts: starts.length, bursts };
}

/** 'pa' bursts at the start and at the end of a recording (spec 6.3: 5 and 5). */
export function paBursts(s: SessionView): { start: PaBlock; end: PaBlock } {
  return { start: paBlockBursts(s, 'pa_start'), end: paBlockBursts(s, 'pa_end') };
}

export interface SniffOnsetAt {
  step: string;
  /** Sample of the 'Sniff' prompt; null when the step is not in the recording. */
  prompt: number | null;
  /** n_sniff, or null when no onset was heard. */
  n: number | null;
}

/**
 * Sniff onsets n_sniff (spec 6.3): core/onset findSniffOnset from each 'Sniff' prompt, at most 2 s
 * and not past the step's end (as quickcheck searches them).
 */
export function sniffOnsets(s: SessionView, sniffSteps: readonly string[]): SniffOnsetAt[] {
  return sniffSteps.map((step): SniffOnsetAt => {
    const n = stepStart(s, step);
    if (n === null) return { step, prompt: null, n: null };
    const view = runView(s, 0, n);
    if (!view) return { step, prompt: n, n: null };
    const span = stepSpan(s, step);
    const limit = n + Math.round((SNIFF_SEARCH_MS * s.sampleRateHz) / 1000);
    const searchTo = Math.min(span ? span.n1 : limit, limit, view.n1 - 1);
    if (searchTo <= n) return { step, prompt: n, n: null };
    const onset = findSniffOnset(view.signal, n, { n0: view.n0, searchToSample: searchTo });
    return { step, prompt: n, n: onset ? onset.n : null };
  });
}

/** Unique trace samples [ts us, value] of the packets that arrived in [n0, n1), by timestamp. */
export function traceArrivedIn(packets: readonly TracePacket[], n0: number, n1: number): Array<readonly [number, number]> {
  const byTs = new Map<number, number>();
  for (const p of packets) {
    if (p.nArr < n0 || p.nArr >= n1) continue;
    for (const [t, v] of p.tr) if (!byTs.has(t) && Number.isFinite(v)) byTs.set(t, v);
  }
  return [...byTs.entries()].sort((a, b) => a[0] - b[0]);
}

export interface AmplitudeRef {
  /** Median of the window amplitudes; null with less than 15 s of trace. */
  aRef: number | null;
  windows: number;
}

/** Amplitudes are taken every second (assumption). */
const AMP_STEP_MS = 1000;

/**
 * A_ref, the median amplitude of the listening block (spec 6.3): the amplitude of spec 7.4,
 * P90 - P10 of the trace over the last 30 s with at least 15 s of it, taken every second over
 * the trace that arrived during the block (by nArr), and the median of those (assumption).
 */
export function listeningAmplitudeRef(s: SessionView, span: { n0: number; n1: number } | null): AmplitudeRef {
  if (!span) return { aRef: null, windows: 0 };
  const series = traceArrivedIn(tracePackets(s), span.n0, span.n1);
  if (series.length < 2) return { aRef: null, windows: 0 };
  const t0 = series[0]![0];
  const tEnd = series[series.length - 1]![0];
  const amps: number[] = [];
  const sorted = new Float64Array(series.length);
  let lo = 0;
  for (let t = t0 + AMP_MIN_MS * 1000; t <= tEnd; t += AMP_STEP_MS * 1000) {
    const from = Math.max(t0, t - AMP_WINDOW_MS * 1000);
    while (lo < series.length && series[lo]![0] < from) lo++;
    let count = 0;
    for (let j = lo; j < series.length && series[j]![0] <= t; j++) sorted[count++] = series[j]![1];
    if (count < 2) continue;
    const part = sorted.subarray(0, count).sort();
    amps.push(percentileSorted(part, count, AMP_P_HIGH) - percentileSorted(part, count, AMP_P_LOW));
  }
  return { aRef: amps.length > 0 ? median(amps) : null, windows: amps.length };
}

export interface DeepBreathSign {
  /** core/detector polaritySign over the cue windows; null without packets or cue steps. */
  result: PolarityResult | null;
  /** Cued deep breaths found in the recording. */
  cues: number;
  /** calib.json `polarity` (spec 8.1): the sign and how many of the three breaths moved the trace its way. */
  calib: { sign: 1 | -1 | null; breaths_agree: number };
}

/**
 * Trace sign from the three cued deep breaths (spec 7.4): each 'Breathe in' step span is put on
 * the camera clock with the packet arrival envelope (as quickcheck does) and core/detector
 * polaritySign gives the sign. `breaths_agree` counts the breaths whose d has the majority sign.
 */
export function deepBreathSign(s: SessionView): DeepBreathSign {
  const names = deepInSteps(DEEP_BREATHS);
  const env = packetEnvelope(s);
  const windows: CueWindow[] = [];
  if (env !== null) {
    for (const name of names) {
      const span = stepSpan(s, name);
      if (span) windows.push({ startUs: sampleToCameraUs(env, span.n0, s.sampleRateHz), endUs: sampleToCameraUs(env, span.n1, s.sampleRateHz) });
    }
  }
  if (env === null || windows.length === 0) return { result: null, cues: windows.length, calib: { sign: null, breaths_agree: 0 } };
  const result = polaritySign(traceSamples(s), windows);
  const up = result.d.filter((x) => Number.isFinite(x) && x > 0).length;
  const down = result.d.filter((x) => Number.isFinite(x) && x < 0).length;
  return { result, cues: windows.length, calib: { sign: result.sign, breaths_agree: Math.min(DEEP_BREATHS, Math.max(up, down)) } };
}

/** Trace after a sniff onset: packets arriving 0.2-1.0 s after it, against the 0.5 s before (assumption). */
const SNIFF_SIGN_AFTER_MS: readonly [number, number] = [200, 1000];
const SNIFF_SIGN_BEFORE_MS = 500;

export interface SniffSign {
  /** Per found sniff: median trace after minus median before (by arrival); NaN when either is empty. */
  d: number[];
  /** Median of the finite, non-zero d; null without one. */
  medianD: number | null;
  /** Sign of medianD; null without it. */
  sign: 1 | -1 | null;
}

/** Which way the sharp sniffs move the trace (spec 7.4: a disagreement with the deep breaths is only a warning). */
export function sniffTraceSign(s: SessionView, onsets: readonly number[]): SniffSign {
  const packets = tracePackets(s);
  const ms = (x: number): number => Math.round((x * s.sampleRateHz) / 1000);
  const med = (n0: number, n1: number): number => {
    const vals = traceArrivedIn(packets, n0, n1).map(([, v]) => v);
    return vals.length > 0 ? median(vals) : Number.NaN;
  };
  const d = onsets.map((n) => med(n + ms(SNIFF_SIGN_AFTER_MS[0]), n + ms(SNIFF_SIGN_AFTER_MS[1])) - med(n - ms(SNIFF_SIGN_BEFORE_MS), n));
  const finite = d.filter((x) => Number.isFinite(x) && x !== 0);
  if (finite.length === 0) return { d, medianD: null, sign: null };
  const m = median(finite);
  return { d, medianD: m, sign: m > 0 ? 1 : m < 0 ? -1 : null };
}
