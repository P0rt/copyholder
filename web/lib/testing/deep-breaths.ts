// Test-only: the part of a headstart take around the three paced deep breaths (spec 7.4, 7.11):
// 30 Hz trace packets on the camera clock, their arrival samples on Deck's clock (a fixed latency
// plus a few ms of jitter) and Deck's step marks of the breaths.

import { SAMPLE_RATE_HZ } from '../units.ts';
import type { TapLine } from './tap-synth.ts';

export interface DeepBreathTakeOptions {
  /** Camera clock of the first packet, us. */
  startUs?: number;
  rateHz?: number;
  /** Length of the packet stream, s. */
  durationS?: number;
  /** Lowest arrival sample of a packet minus its camera time, s; the jitter comes on top (up to 4 ms). */
  latencyS?: number;
  /** Camera time of each inhale step's start, s; the inhale lasts 2 s and the exhale 4 s (spec 9.3). */
  inhaleAtS?: number[];
  /** Per breath: +1 when its inhale raises the raw trace, -1 when it lowers it. */
  signs?: number[];
  /** Per breath: how far the inhale moves the trace. */
  amps?: number[];
  /** The step after the last exhale (rest_1 in headstart); null leaves its mark out. */
  afterStep?: string | null;
}

export interface DeepBreathTake {
  /** /tap packet lines, one trace point each. */
  lines: TapLine[];
  nArrBySeq: Map<number, number>;
  /** Deck's step marks in order: deep_<i>_in, deep_<i>_out, then afterStep. */
  marks: Array<{ name: string; n: number }>;
  /** The inhale steps on the camera clock, us. */
  windowsUs: Array<{ startUs: number; endUs: number }>;
  /** Raw trace value at camera time t s from the first packet. */
  valueAt(tS: number): number;
  opts: Required<DeepBreathTakeOptions>;
}

const DEFAULTS: Required<DeepBreathTakeOptions> = {
  startUs: 1_794_935_100_000_000,
  rateHz: 30,
  durationS: 45,
  latencyS: 0.12,
  inhaleAtS: [20, 26, 32],
  signs: [1, 1, 1],
  amps: [1, 1, 1],
  afterStep: 'rest_1',
};

const INHALE_S = 2;
const EXHALE_S = 4;

/** One paced breath from u = 0: raised-cosine rise over the inhale, raised-cosine fall over the exhale. */
function breathShape(u: number): number {
  if (u < 0 || u >= INHALE_S + EXHALE_S) return 0;
  if (u < INHALE_S) return 0.5 - 0.5 * Math.cos((Math.PI * u) / INHALE_S);
  return 0.5 + 0.5 * Math.cos((Math.PI * (u - INHALE_S)) / EXHALE_S);
}

export function deepBreathTake(options: DeepBreathTakeOptions = {}): DeepBreathTake {
  const o: Required<DeepBreathTakeOptions> = { ...DEFAULTS, ...options };
  const valueAt = (tS: number): number => {
    // Quiet breathing, small next to the deep breaths.
    let v = 0.05 * Math.sin((2 * Math.PI * tS) / 4.4);
    o.inhaleAtS.forEach((at, i) => {
      v += (o.signs[i] ?? 1) * (o.amps[i] ?? 1) * breathShape(tS - at);
    });
    return v;
  };
  const toN = (cameraS: number) => Math.round((cameraS + o.latencyS) * SAMPLE_RATE_HZ);
  const lines: TapLine[] = [];
  const nArrBySeq = new Map<number, number>();
  const count = Math.round(o.durationS * o.rateHz);
  for (let i = 0; i < count; i++) {
    const tS = i / o.rateHz;
    const ts = o.startUs + Math.round(tS * 1e6);
    const seq = i + 1;
    lines.push({
      seq,
      k: 'm',
      tArrNs: String(812_345_678_901_234 + i * 33_333_333),
      tsCbUs: ts + 21_000,
      tr: [[ts, Math.fround(valueAt(tS))]],
      talk: [[ts, 0]],
      g: Math.fround(0.03),
      hm: Math.fround(0.002),
      lm: { ts, reset: 0, p: [[640.2, 402.1], [640.6, 409.8]] },
    });
    // Jitter of 0 to 4 ms; every 11th packet comes at the lowest latency.
    const jitterS = (0.004 * ((i * 7) % 11)) / 10;
    nArrBySeq.set(seq, toN(tS + jitterS));
  }
  const marks: Array<{ name: string; n: number }> = [];
  o.inhaleAtS.forEach((at, i) => {
    marks.push({ name: `deep_${i + 1}_in`, n: toN(at) });
    marks.push({ name: `deep_${i + 1}_out`, n: toN(at + INHALE_S) });
  });
  const lastAt = o.inhaleAtS[o.inhaleAtS.length - 1];
  if (o.afterStep !== null && lastAt !== undefined) marks.push({ name: o.afterStep, n: toN(lastAt + INHALE_S + EXHALE_S) });
  const windowsUs = o.inhaleAtS.map((at) => ({ startUs: o.startUs + at * 1e6, endUs: o.startUs + (at + INHALE_S) * 1e6 }));
  return { lines, nArrBySeq, marks, windowsUs, valueAt, opts: o };
}

/** Deck's sample n of camera time t s from the first packet, at the lowest latency. */
export function takeSampleAt(take: DeepBreathTake, cameraS: number): number {
  return Math.round((cameraS + take.opts.latencyS) * SAMPLE_RATE_HZ);
}
