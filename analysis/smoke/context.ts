// Everything the ten smoke answers share: the samples.jsonl lines by kind, the scenario steps of
// web/scenarios/smoke.ts on the audio clock, and the maps between the clocks (spec 6.3, 8.1).

import { SAMPLE_RATE_HZ, type PacketTime, type SampleLine, type Stamp } from '../../core/clock/index.ts';
import { medianCountPerSecond } from './numbers.ts';
import type { SessionFolder } from './read.ts';
import { streamSpan, type StreamSpan, type TimedStamp } from './span.ts';
import { tapSmokeOutput, type TapSmokeOutput } from './tap-output.ts';
import {
  cameraSamplesMap,
  tapClock,
  tapNsToSamplesMap,
  tapNsToWallUsMap,
  type CameraSamplesMap,
  type TapClock,
  type TapSamplesMap,
} from './timebase.ts';

/** Step names of web/scenarios/smoke.ts and blocks.ts; analysis/smoke.test.ts checks they still exist there. */
export const SMOKE_STEPS = {
  sdkStart: 'sdk_start',
  signalOk: 'signal_ok',
  breatheNormally: 'breathe_normally',
  deepIn: (i: number) => `deep_${i}_in`,
  deepOut: (i: number) => `deep_${i}_out`,
  rest: 'rest_1',
  screenRecording: 'screen_recording',
  quiet: 'quiet',
  lensReady: 'lens_ready',
  lensCover: 'lens_cover',
  lensUncover: 'lens_uncover',
  end: 'end',
} as const;

export const DEEP_BREATHS = 3;

/** One scenario step on the audio clock: its mark, and the next step's mark as its end. */
export interface StepSpan {
  name: string;
  n: number;
  /** Start of the next step; null for the last mark of the run. */
  endN: number | null;
}

export type TracePair = [tsUs: number, value: number];

/** An `m` line with the times the answers need. */
export interface Packet {
  line: SampleLine;
  seq: number | null;
  /** tap clock, ns since the earliest tArrNs. */
  relNs: number | null;
  /** Arrival in Deck (stamps.jsonl `arr`), samples. */
  nArr: number | null;
  /** Newest camera timestamp the packet carries (trace or landmark frame, inside their runs). */
  newestTsUs: number | null;
}

/** The camera-time streams of a run, each cut to its own run (analysis/smoke/span.ts). */
export interface SmokeStreams {
  /** Trace sample timestamps (tr of `m` lines). */
  trace: StreamSpan;
  /** Talking flag timestamps (talk of `m` lines). */
  talk: StreamSpan;
  /** Landmark frame timestamps (lm.ts of `m` lines). */
  landmarks: StreamSpan;
  /** frameSentThrough timestamps (tsCbUs of `f` lines): one per frame given to the SDK. */
  frames: StreamSpan;
  /** timestampUs of the metrics callback (tsCbUs of `m` lines). */
  callback: StreamSpan;
}

export const STREAM_LABELS: Readonly<Record<keyof SmokeStreams, string>> = {
  trace: 'trace',
  talk: 'talking flag',
  landmarks: 'landmark frames',
  frames: 'frameSentThrough',
  callback: 'metrics timestampUs',
};

export interface SmokeContext {
  folder: SessionFolder;
  tap: TapSmokeOutput;
  sampleRateHz: number;
  byKind: Record<'m' | 'v' | 's' | 'f' | 'e' | 'l', SampleLine[]>;
  packets: Packet[];
  clock: TapClock;
  /** seq -> nArr from the `arr` stamps (first stamp of a seq wins). */
  arrBySeq: Map<number, number>;
  steps: StepSpan[];
  /** tap clock <-> audio samples (median offset over packets with an `arr` stamp). */
  tapToSamples: TapSamplesMap | null;
  /** camera µs <-> audio samples (lower envelope over packets with an `arr` stamp). */
  camera: CameraSamplesMap | null;
  /** tap clock -> wall µs (sdk_raw tWallMs). */
  tapToWallUs: ((relNs: number) => number) | null;
  /** Camera-time streams with their runs; timestamps outside a run are left out everywhere below. */
  streams: SmokeStreams;
  /** Unique trace samples inside the trace's run, sorted by camera time. */
  trace: TracePair[];
  /** Median trace rate per s (the rule of core/clock traceRateMedian, spec 6.3) over `trace`. */
  traceRateMedian: number | null;
  /** samples.jsonl lines for core/clock: `tr` of `m` lines cut to the finite pairs inside the run, `talk` an array. */
  coreSamples: SampleLine[];
}

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/** [ts, value] pairs of a samples.jsonl list that are both finite numbers. */
export function finitePairs(list: unknown): TracePair[] {
  if (!Array.isArray(list)) return [];
  const out: TracePair[] = [];
  for (const p of list) {
    if (Array.isArray(p) && isNum(p[0]) && isNum(p[1])) out.push([p[0], p[1]]);
  }
  return out;
}

/** Step marks of stamps.jsonl ({k:'mark', what:'step', name}) in sample order; a repeated name keeps its first mark. */
export function stepSpans(stamps: readonly Stamp[]): StepSpan[] {
  const marks = stamps
    .filter((s) => s.k === 'mark' && s.what === 'step' && typeof s.name === 'string' && isNum(s.n))
    .map((s) => ({ name: s.name as string, n: s.n }))
    .sort((a, b) => a.n - b.n);
  const seen = new Set<string>();
  const kept = marks.filter((m) => (seen.has(m.name) ? false : (seen.add(m.name), true)));
  return kept.map((m, i) => ({ name: m.name, n: m.n, endN: kept[i + 1]?.n ?? null }));
}

export function findStep(steps: readonly StepSpan[], name: string): StepSpan | null {
  return steps.find((s) => s.name === name) ?? null;
}

/** The step running at sample n (the last mark at or before n); null before the first mark. */
export function stepAt(steps: readonly StepSpan[], n: number): StepSpan | null {
  let found: StepSpan | null = null;
  for (const s of steps) {
    if (s.n <= n) found = s;
    else break;
  }
  return found;
}

/** Unique trace samples of the run sorted by timestamp; a repeated timestamp keeps its first value. */
export function uniqueTrace(mLines: readonly SampleLine[]): TracePair[] {
  const byTs = new Map<number, number>();
  for (const l of mLines) for (const [ts, v] of finitePairs(l.tr)) if (!byTs.has(ts)) byTs.set(ts, v);
  return [...byTs.entries()].sort((a, b) => a[0] - b[0]);
}

/** Timestamps of each camera-time stream with the arrival of their line, for streamSpan(). */
function streamStamps(byKind: SmokeContext['byKind'], clock: TapClock): Record<keyof SmokeStreams, TimedStamp[]> {
  const out: Record<keyof SmokeStreams, TimedStamp[]> = { trace: [], talk: [], landmarks: [], frames: [], callback: [] };
  for (const line of byKind.m) {
    const relNs = clock.relNs(line.tArrNs);
    for (const [tsUs] of finitePairs(line.tr)) out.trace.push({ tsUs, relNs });
    for (const [tsUs] of finitePairs(line.talk)) out.talk.push({ tsUs, relNs });
    if (line.lm && isNum(line.lm.ts)) out.landmarks.push({ tsUs: line.lm.ts, relNs });
    if (isNum(line.tsCbUs)) out.callback.push({ tsUs: line.tsCbUs, relNs });
  }
  for (const line of byKind.f) if (isNum(line.tsCbUs)) out.frames.push({ tsUs: line.tsCbUs, relNs: clock.relNs(line.tArrNs) });
  return out;
}

export function buildContext(folder: SessionFolder, sampleRateHz: number = SAMPLE_RATE_HZ): SmokeContext {
  const byKind: SmokeContext['byKind'] = { m: [], v: [], s: [], f: [], e: [], l: [] };
  for (const line of folder.samples) {
    const k = line.k as keyof SmokeContext['byKind'];
    if (k in byKind) byKind[k].push(line);
  }
  const clock = tapClock([...folder.samples.map((l) => l.tArrNs), ...folder.raw.map((r) => r.tArrNs)]);
  const stamps = streamStamps(byKind, clock);
  const streams: SmokeStreams = {
    trace: streamSpan(stamps.trace),
    talk: streamSpan(stamps.talk),
    landmarks: streamSpan(stamps.landmarks),
    frames: streamSpan(stamps.frames),
    callback: streamSpan(stamps.callback),
  };
  const traceKept = streams.trace.keptSet;
  const lmKept = streams.landmarks.keptSet;
  const arrBySeq = new Map<number, number>();
  for (const s of folder.stamps) {
    if (s.k === 'arr' && isNum(s.seq) && isNum(s.n) && !arrBySeq.has(s.seq)) arrBySeq.set(s.seq, s.n);
  }
  const packets: Packet[] = byKind.m.map((line) => {
    let newest: number | null = null;
    for (const [ts] of finitePairs(line.tr)) if (traceKept.has(ts) && (newest === null || ts > newest)) newest = ts;
    const lmTs = line.lm && isNum(line.lm.ts) && lmKept.has(line.lm.ts) ? line.lm.ts : null;
    if (lmTs !== null && (newest === null || lmTs > newest)) newest = lmTs;
    const seq = isNum(line.seq) ? line.seq : null;
    return { line, seq, relNs: clock.relNs(line.tArrNs), nArr: seq === null ? null : (arrBySeq.get(seq) ?? null), newestTsUs: newest };
  });
  const arrived = packets.filter((p): p is Packet & { nArr: number } => p.nArr !== null);
  const tapToSamples = tapNsToSamplesMap(
    arrived.filter((p): p is Packet & { nArr: number; relNs: number } => p.relNs !== null),
    sampleRateHz,
  );
  const camPackets: PacketTime[] = arrived
    .filter((p): p is Packet & { nArr: number; newestTsUs: number } => p.newestTsUs !== null)
    .map((p) => ({ nArr: p.nArr, tsUs: p.newestTsUs }));
  const wallLines = folder.raw
    .map((r) => ({ relNs: clock.relNs(r.tArrNs), tWallMs: r.tWallMs }))
    .filter((r): r is { relNs: number; tWallMs: number } => r.relNs !== null && r.tWallMs !== null);
  const trace = uniqueTrace(byKind.m).filter(([ts]) => traceKept.has(ts));
  return {
    folder,
    tap: tapSmokeOutput(folder),
    sampleRateHz,
    byKind,
    packets,
    clock,
    arrBySeq,
    steps: stepSpans(folder.stamps),
    tapToSamples,
    camera: cameraSamplesMap(camPackets, sampleRateHz),
    tapToWallUs: tapNsToWallUsMap(wallLines),
    streams,
    trace,
    traceRateMedian: medianCountPerSecond(trace.map((p) => p[0])),
    coreSamples: folder.samples.map((l) =>
      l.k === 'm' ? { ...l, tr: finitePairs(l.tr).filter(([ts]) => traceKept.has(ts)), talk: Array.isArray(l.talk) ? l.talk : [] } : l,
    ) as SampleLine[],
  };
}

/** Audio sample number of any samples.jsonl line: its `arr` stamp for a packet, else its tArrNs mapped. */
export function lineSamples(ctx: SmokeContext, line: { k?: string; seq?: number; tArrNs?: string | null }): number | null {
  if (line.k === 'm' && isNum(line.seq)) {
    const nArr = ctx.arrBySeq.get(line.seq);
    if (nArr !== undefined) return nArr;
  }
  const rel = ctx.clock.relNs(line.tArrNs);
  return rel === null || ctx.tapToSamples === null ? null : ctx.tapToSamples.toSamples(rel);
}

/** Wall clock (µs since the epoch) of audio sample n, through the tap clock; null without both maps. */
export function samplesToWallUs(ctx: SmokeContext, n: number): number | null {
  if (ctx.tapToSamples === null || ctx.tapToWallUs === null) return null;
  return ctx.tapToWallUs(ctx.tapToSamples.toRelNs(n));
}
