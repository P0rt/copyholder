// Smoke questions 3 to 6 (spec 7.12): the trace sign on the cued deep breaths, the SDK time fields,
// the stream rates, and the trace rate with and without the macOS screen recording (spec 15.5).

import { notSentShare, TRACE_RATE_MIN_PER_S } from '../../core/clock/index.ts';
import { polaritySign, type CueWindow } from '../../core/detector.ts';
import { median } from '../../core/stats/index.ts';
import { DEEP_BREATHS, finitePairs, findStep, SMOKE_STEPS, STREAM_LABELS, type SmokeContext, type SmokeStreams, type StepSpan } from './context.ts';
import {
  finite,
  fmtMs,
  fmtPct,
  fmtPerS,
  fmtS,
  fmtSpreadMs,
  meanRatePerSecond,
  medianCountPerSecond,
  r1,
  r3,
  r4,
  roundSpread,
  spanRatePerSecond,
  spreadOf,
  type Spread,
} from './numbers.ts';
import { requestedFormat } from './answers-start.ts';
import { timestampTypeName } from './reduce-adapter.ts';
import type { Answer } from './sdk-events.ts';
import { SAME_UNIT_RATE } from './span.ts';
import { consoleNote, probesWithSamples } from './tap-output.ts';
import { tapAbsoluteUs } from './timebase.ts';

const sig3 = (x: number): string => String(Number(x.toPrecision(3)));
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

// ---- 3. Trace sign -------------------------------------------------------------------------

export function answerSign(ctx: SmokeContext): Answer {
  const steps: { name: string; span: StepSpan | null }[] = [];
  for (let i = 1; i <= DEEP_BREATHS; i++) steps.push({ name: SMOKE_STEPS.deepIn(i), span: findStep(ctx.steps, SMOKE_STEPS.deepIn(i)) });
  const missing = steps.filter((s) => s.span === null || s.span.endN === null).map((s) => s.name);
  const base = { sign: null, agree: false, margin: false, d: [] as number[], windows: [] as unknown[], clock_map: ctx.camera?.method ?? null };
  const fail = (why: string): Answer => ({ n: 3, title: 'Trace sign', lines: [`Trace sign: cannot tell: ${why}.`], data: { ...base, why } });
  if (missing.length > 0) return fail(`no step mark for ${missing.join(', ')} in stamps.jsonl`);
  if (ctx.trace.length === 0) return fail('no trace sample arrived');
  if (ctx.camera === null) return fail('no packet has an `arr` stamp, so the cues cannot be put on the camera clock');
  const cam = ctx.camera;
  const windows: CueWindow[] = steps.map((s) => ({ startUs: cam.samplesToTsUs(s.span!.n), endUs: cam.samplesToTsUs(s.span!.endN!) }));
  const res = polaritySign(ctx.trace, windows);
  const dText = res.d.map((x) => (Number.isFinite(x) ? sig3(x) : 'n/a')).join(', ');
  const lines: string[] = [];
  if (res.sign === 1) lines.push(`Trace sign: +1, the inhale raises the trace: all ${DEEP_BREATHS} cued breaths agree (d = ${dText}).`);
  else if (res.sign === -1) lines.push(`Trace sign: -1, the inhale lowers the trace: all ${DEEP_BREATHS} cued breaths agree (d = ${dText}).`);
  else lines.push(`Trace sign: none: the ${DEEP_BREATHS} cued breaths disagree or a window had no samples (d = ${dText}).`);
  lines.push(
    `Margin (smallest |d| at least a third of the largest): ${res.margin ? 'yes' : 'no'}. d = median 0.5 s around the end of each 2 s inhale cue minus around its start (spec 7.4); cues mapped to camera time by the ${cam.method === 'envelope' ? 'lower envelope of arrivals' : 'median arrival offset'}.`,
  );
  return {
    n: 3,
    title: 'Trace sign',
    lines,
    data: {
      sign: res.sign,
      agree: res.agree,
      margin: res.margin,
      d: res.d.map((x) => r4(x)),
      windows: steps.map((s, i) => ({ step: s.name, start_s: r3(s.span!.n / ctx.sampleRateHz), end_s: r3(s.span!.endN! / ctx.sampleRateHz), start_ts_us: Math.round(windows[i]!.startUs) })),
      clock_map: cam.method,
    },
  };
}

// ---- 4. Time -------------------------------------------------------------------------------

/** Index of the sorted value nearest to x. */
function nearestIndex(sorted: readonly number[], x: number): number {
  let lo = 0;
  let hi = sorted.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (sorted[mid]! < x) lo = mid + 1;
    else hi = mid;
  }
  if (lo > 0 && Math.abs(sorted[lo - 1]! - x) <= Math.abs(sorted[lo]! - x)) return lo - 1;
  return lo;
}

function typeCounts(values: readonly unknown[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const v of values) {
    const t = timestampTypeName(v);
    out[t] = (out[t] ?? 0) + 1;
  }
  return out;
}

const countsText = (c: Record<string, number>): string =>
  Object.entries(c)
    .map(([t, k]) => `${k} ${t}`)
    .join(', ');

export interface ArrivalLatency {
  /** 'wall': Date.now() at arrival vs µs since the epoch; 'tap': tap's hrtime; 'relative': neither fits. */
  clock: 'wall' | 'tap' | 'relative' | null;
  spread: Spread | null;
  /** Median arrival minus timestamp before choosing a clock, s (for a surprise: not the epoch). */
  wallOffsetS: number | null;
}

const PLAUSIBLE_LATENCY_MS = 3_600_000;

/** Arrival minus timestamp, ms, for every [packet arrival, timestamp] pair (spec 7.12 question 4). */
export function arrivalLatency(
  ctx: SmokeContext,
  pairs: readonly { relNs: number | null; tArrNs: string | null | undefined; tsUs: number }[],
): ArrivalLatency {
  const toWall = ctx.tapToWallUs;
  const wall = toWall === null ? [] : finite(pairs.map((p) => (p.relNs === null ? null : (toWall(p.relNs) - p.tsUs) / 1000)));
  const wallMedian = wall.length > 0 ? median(wall) : null;
  if (wallMedian !== null && Math.abs(wallMedian) <= PLAUSIBLE_LATENCY_MS) {
    return { clock: 'wall', spread: spreadOf(wall), wallOffsetS: wallMedian / 1000 };
  }
  const tap = finite(pairs.map((p) => {
    const us = tapAbsoluteUs(p.tArrNs);
    return us === null ? null : (us - p.tsUs) / 1000;
  }));
  const tapMedian = tap.length > 0 ? median(tap) : null;
  if (tapMedian !== null && Math.abs(tapMedian) <= PLAUSIBLE_LATENCY_MS) {
    return { clock: 'tap', spread: spreadOf(tap), wallOffsetS: wallMedian === null ? null : wallMedian / 1000 };
  }
  const base = wall.length > 0 ? wall : tap;
  if (base.length === 0) return { clock: null, spread: null, wallOffsetS: null };
  const m = median(base)!;
  return { clock: 'relative', spread: spreadOf(base.map((x) => x - m)), wallOffsetS: wallMedian === null ? null : wallMedian / 1000 };
}

const STREAM_KEYS = Object.keys(STREAM_LABELS) as (keyof SmokeStreams)[];

/** "trace 1 (0), frameSentThrough 1 (-1)": streams with timestamps outside their run; null when none. */
export function strayText(streams: SmokeStreams): string | null {
  const parts = STREAM_KEYS.filter((k) => streams[k].outside > 0).map((k) => {
    const s = streams[k];
    const more = s.outside > s.examples.length ? ', ...' : '';
    return `${STREAM_LABELS[k]} ${s.outside} (${s.examples.join(', ')}${more})`;
  });
  return parts.length === 0 ? null : parts.join(', ');
}

/** Camera µs per µs of tap's clock for each stream that has enough arrivals. */
export function clockRatesText(streams: SmokeStreams): { text: string | null; offUnit: string[] } {
  const rated = STREAM_KEYS.filter((k) => streams[k].clockRate !== null);
  const offUnit = rated
    .filter((k) => streams[k].clockRate! < SAME_UNIT_RATE[0] || streams[k].clockRate! > SAME_UNIT_RATE[1])
    .map((k) => STREAM_LABELS[k]);
  if (rated.length === 0) return { text: null, offUnit };
  return { text: rated.map((k) => `${STREAM_LABELS[k]} ${Number(streams[k].clockRate!.toPrecision(4))}`).join(', '), offUnit };
}

export function answerTime(ctx: SmokeContext): Answer {
  const probes = probesWithSamples(ctx.tap.probes).map((p) => p.value);
  const sampleTypes = [...new Set(probes.map((p) => p.tsType))];
  const cbTypes = [...new Set(ctx.tap.probes.map((p) => p.value.tsCbType).filter((t): t is string => typeof t === 'string'))];
  const kept = {
    trace: ctx.streams.trace.keptSet,
    frames: ctx.streams.frames.keptSet,
    callback: ctx.streams.callback.keptSet,
    landmarks: ctx.streams.landmarks.keptSet,
  };
  const rawArg = (kind: string) => ctx.folder.raw.filter((r) => r.kind === kind && r.args !== null).map((r) => r.args![1]);
  const rawTypes = { validationStatus: typeCounts(rawArg('validationStatus')), frameSentThrough: typeCounts(rawArg('frameSentThrough')) };
  const rawNonNumber = Object.values(rawTypes).some((c) => Object.keys(c).some((t) => t !== 'number'));

  // Trace timestamps against frameSentThrough timestamps (both camera clock).
  const fFirstRel = new Map<number, number | null>();
  for (const l of ctx.byKind.f) {
    if (isNum(l.tsCbUs) && kept.frames.has(l.tsCbUs) && !fFirstRel.has(l.tsCbUs)) fFirstRel.set(l.tsCbUs, ctx.clock.relNs(l.tArrNs));
  }
  const fSorted = [...fFirstRel.keys()].sort((a, b) => a - b);
  const traceTs = ctx.trace.map((p) => p[0]);
  const equalShare = traceTs.length > 0 && fSorted.length > 0 ? traceTs.filter((t) => fFirstRel.has(t)).length / traceTs.length : null;
  const nearestMs = fSorted.length === 0 ? null : spreadOf(traceTs.map((t) => (t - fSorted[nearestIndex(fSorted, t)]!) / 1000));
  const handoff: number[] = [];
  const cbMinusTrace: number[] = [];
  let cbEqual = 0;
  let lmEqual = 0;
  let lmBoth = 0;
  const latencyPairs: { relNs: number | null; tArrNs: string | null | undefined; tsUs: number }[] = [];
  const cbLatencyPairs: typeof latencyPairs = [];
  for (const p of ctx.packets) {
    const tr = finitePairs(p.line.tr).filter(([ts]) => kept.trace.has(ts));
    let newestTrace: number | null = null;
    for (const [ts] of tr) {
      if (newestTrace === null || ts > newestTrace) newestTrace = ts;
      latencyPairs.push({ relNs: p.relNs, tArrNs: p.line.tArrNs, tsUs: ts });
      const fRel = fFirstRel.get(ts);
      if (fRel !== undefined && fRel !== null && p.relNs !== null) handoff.push((p.relNs - fRel) / 1e6);
    }
    const cb = p.line.tsCbUs;
    if (isNum(cb) && kept.callback.has(cb)) {
      cbLatencyPairs.push({ relNs: p.relNs, tArrNs: p.line.tArrNs, tsUs: cb });
      if (newestTrace !== null) {
        cbMinusTrace.push((cb - newestTrace) / 1000);
        if (cb === newestTrace) cbEqual++;
      }
    }
    const lmTs = p.line.lm?.ts;
    if (isNum(lmTs) && kept.landmarks.has(lmTs) && newestTrace !== null) {
      lmBoth++;
      if (lmTs === newestTrace) lmEqual++;
    }
  }
  const handoffMs = spreadOf(handoff);
  const cbMs = spreadOf(cbMinusTrace);
  const latency = arrivalLatency(ctx, latencyPairs);
  const cbLatency = arrivalLatency(ctx, cbLatencyPairs);

  const fileTypes = ctx.folder.sampleTimeTypes;
  const fileLongs = (fileTypes['Long'] ?? 0) + (fileTypes['string'] ?? 0);

  const stray = strayText(ctx.streams);
  const rates = clockRatesText(ctx.streams);

  const lines: string[] = [];
  const typeText = sampleTypes.length > 0 ? sampleTypes.join(' and ') : fileLongs > 0 ? 'Long (samples.jsonl holds them as objects or strings)' : null;
  const cbText = cbTypes.length > 0 ? cbTypes.join(' and ') : null;
  if (typeText === null && cbText === null) {
    lines.push(`Timestamp type (number or Long): unknown for the decoded samples and for timestampUs (${consoleNote(ctx.tap, "tap's console has no probe line")}).`);
  } else {
    lines.push(
      `Timestamp type: ${typeText ?? 'unknown (no probe saw a sample)'} in the decoded samples; ${cbText ?? 'unknown'} for the timestampUs argument of the metrics callback.`,
    );
  }
  lines.push(
    stray === null
      ? "Stray timestamps: none; every camera timestamp lies within its stream's run on tap's clock."
      : `Stray timestamps outside their stream's run on tap's clock (SURPRISE; left out of every rate and comparison): ${stray}.`,
  );
  if (rates.text !== null) {
    lines.push(
      `Camera clock against tap's clock, µs per µs: ${rates.text}${rates.offUnit.length > 0 ? `. NOT µs for ${rates.offUnit.join(', ')}: the per-second rates of those streams are not per second` : ' (the timestamps are µs)'}.`,
    );
  }
  if (fileLongs > 0) lines.push(`samples.jsonl camera times: ${countsText(fileTypes)}; read as numbers (reduce.cjs toUs converts them in tap).`);
  if (rawNonNumber) {
    lines.push(`Logged event timestamps: validationStatus ${countsText(rawTypes.validationStatus) || 'none'}; frameSentThrough ${countsText(rawTypes.frameSentThrough) || 'none'}.`);
  }
  if (fSorted.length === 0) {
    lines.push('Trace ts vs frameSentThrough: no frameSentThrough timestamp to compare.');
  } else {
    lines.push(
      `Trace ts vs frameSentThrough: ${fmtPct(equalShare)} of trace timestamps equal a frameSentThrough timestamp; trace minus nearest frameSentThrough ts ${fmtSpreadMs(nearestMs)}.`,
    );
    if (handoffMs !== null) lines.push(`frameSentThrough to the packet with that frame: ${fmtSpreadMs(handoffMs)}.`);
  }
  lines.push(
    cbMs === null
      ? 'timestampUs vs trace ts: no packet has both.'
      : `timestampUs minus the newest trace ts of its packet: ${fmtSpreadMs(cbMs)}; equal in ${fmtPct(cbEqual / cbMs.n)} of packets.`,
  );
  if (lmBoth > 0) lines.push(`Landmark frame ts equals the newest trace ts in ${fmtPct(lmEqual / lmBoth)} of packets with both.`);
  lines.push(latencyLine('Arrival minus trace ts', latency));
  lines.push(latencyLine('Arrival minus timestampUs', cbLatency));

  return {
    n: 4,
    title: 'Time',
    lines,
    data: {
      sample_ts_types: sampleTypes,
      callback_ts_types: cbTypes,
      logged_arg_types: rawTypes,
      samples_time_types: fileTypes,
      trace_ts_equal_frame_ts_share: r3(equalShare),
      trace_minus_nearest_frame_ts_ms: roundSpread(nearestMs),
      frame_to_packet_ms: roundSpread(handoffMs),
      timestamp_us_minus_newest_trace_ts_ms: roundSpread(cbMs),
      timestamp_us_equal_share: cbMs === null ? null : r3(cbEqual / cbMs.n),
      landmark_ts_equal_trace_ts_share: lmBoth > 0 ? r3(lmEqual / lmBoth) : null,
      streams: Object.fromEntries(
        STREAM_KEYS.map((k) => {
          const sp = ctx.streams[k];
          return [
            k,
            {
              timestamps: sp.kept.length,
              outside_run: sp.outside,
              outside_examples: sp.examples,
              run_method: sp.method,
              clock_rate_us_per_us: sp.clockRate === null ? null : Number(sp.clockRate.toPrecision(6)),
              offset_s: sp.offsetUs === null ? null : r3(sp.offsetUs / 1e6),
            },
          ];
        }),
      ),
      arrival_minus_trace_ts_ms: { clock: latency.clock, wall_offset_s: r3(latency.wallOffsetS), ...roundSpread(latency.spread) },
      arrival_minus_timestamp_us_ms: { clock: cbLatency.clock, wall_offset_s: r3(cbLatency.wallOffsetS), ...roundSpread(cbLatency.spread) },
    },
  };
}

function latencyLine(label: string, l: ArrivalLatency): string {
  if (l.clock === null) return `${label}: no arrival time to compare (tArrNs or sdk_raw.jsonl.gz missing).`;
  if (l.clock === 'wall') return `${label} (wall clock at the callback, timestamps in µs since the epoch): ${fmtSpreadMs(l.spread)}.`;
  const off = l.wallOffsetS === null ? '' : ` (against the wall clock it is ${sig3(l.wallOffsetS)} s: the timestamps are not µs since the epoch)`;
  if (l.clock === 'tap') return `${label} (tap's monotonic clock, process.hrtime)${off}: ${fmtSpreadMs(l.spread)}.`;
  return `${label}: on no known clock${off}; around its median: ${fmtSpreadMs(l.spread)}.`;
}

// ---- 5. Rates ------------------------------------------------------------------------------

/** "1280x720"-like sizes in the logged SDK lines, with where they were seen; lines that echo the request are left out. */
export function loggedFrameSizes(ctx: SmokeContext): { size: string; where: string }[] {
  const out: { size: string; where: string }[] = [];
  for (const l of ctx.tap.logLines) {
    if (/request/i.test(l.text)) continue;
    for (const m of l.text.matchAll(/\b(\d{3,4})\s*[x×]\s*(\d{3,4})\b/g)) {
      if (out.length < 10) out.push({ size: `${m[1]}x${m[2]}`, where: `${l.file}:${l.lineNo}` });
    }
  }
  return out;
}

/** Median interval between consecutive sorted timestamps, ms; null under two. */
function medianIntervalMs(sorted: readonly number[]): number | null {
  return sorted.length >= 2 ? median(sorted.slice(1).map((t, i) => (t - sorted[i]!) / 1000)) : null;
}

export function answerRates(ctx: SmokeContext): Answer {
  const traceTs = ctx.trace.map((p) => p[0]);
  const traceMedian = ctx.traceRateMedian;
  const lmTs = ctx.streams.landmarks.kept;
  const talkTs = ctx.streams.talk.kept;
  const fTs = ctx.streams.frames.kept;
  const fCount = ctx.byKind.f.filter((l) => typeof l.sent === 'boolean').length;
  const notSent = notSentShare(ctx.coreSamples);
  const notSentCount = ctx.byKind.f.filter((l) => l.sent === false).length;
  const rel = finite(ctx.packets.map((p) => p.relNs)).sort((a, b) => a - b);
  const packetsPerS = rel.length >= 2 ? (rel[rel.length - 1]! > rel[0]! ? (rel.length - 1) / ((rel[rel.length - 1]! - rel[0]!) / 1e9) : null) : null;
  const fInterval = medianIntervalMs(fTs);
  const lmInterval = medianIntervalMs(lmTs);
  const fMedian = medianCountPerSecond(fTs);
  const lmMedian = medianCountPerSecond(lmTs);
  const [w, h, fps] = requestedFormat(ctx);
  const sizes = loggedFrameSizes(ctx);
  const rate = (ts: readonly number[]) => ({ median_per_s: r1(medianCountPerSecond(ts)), mean_per_s: r1(spanRatePerSecond(ts)) });
  const spanS = traceTs.length >= 2 ? (traceTs[traceTs.length - 1]! - traceTs[0]!) / 1e6 : null;
  // Frames per packet: the probe counts the decoded landmark frames; reduce.cjs keeps only the last one.
  const probed = ctx.tap.probes.filter((p) => p.value.frames > 0);
  const framesPerPacket = probed.length > 0 ? Math.max(...probed.map((p) => p.value.frames)) : null;
  const fPerPacket = ctx.packets.length > 0 && ctx.byKind.f.length > 0 ? ctx.byKind.f.length / ctx.packets.length : null;
  const batched = (framesPerPacket !== null && framesPerPacket > 1) || (fPerPacket !== null && fPerPacket >= 1.5);

  const lines: string[] = [];
  lines.push(
    traceTs.length === 0
      ? 'Trace: no sample within the run.'
      : `Trace: median ${fmtPerS(traceMedian)} (full 1 s windows of camera time; hard condition at least ${TRACE_RATE_MIN_PER_S}), mean ${fmtPerS(spanRatePerSecond(traceTs))} over ${fmtS(spanS)}.`,
  );
  lines.push(
    `Landmark frames: median ${fmtPerS(lmMedian)}; talking flag: median ${fmtPerS(medianCountPerSecond(talkTs))}; packets: ${fmtPerS(packetsPerS)} by arrival.`,
  );
  lines.push(`sent === false: ${fCount > 0 ? `${fmtPct(notSent)} (${notSentCount} of ${fCount} frameSentThrough events)` : 'no frameSentThrough event'}.`);
  if (fTs.length >= 2) {
    lines.push(
      `Real frame rate (frameSentThrough timestamps, one per frame given to the SDK): median ${fmtPerS(fMedian)}, median interval ${fmtMs(fInterval)}${fInterval ? ` (about ${r1(1000 / fInterval)} frames per s)` : ''}; requested ${w}x${h} at ${fps} fps.`,
    );
  } else {
    lines.push(
      `Real frame rate: no frameSentThrough timestamps; the landmark frames give median interval ${fmtMs(lmInterval)}, but they count packets, not frames (reduce.cjs keeps the last frame of a packet); requested ${w}x${h} at ${fps} fps.`,
    );
  }
  const perPacket: string[] = [];
  if (framesPerPacket !== null) perPacket.push(`up to ${framesPerPacket} landmark frame${framesPerPacket > 1 ? 's' : ''} per packet in tap's probe`);
  if (fPerPacket !== null) {
    const k = Number(fPerPacket.toPrecision(3));
    perPacket.push(`${k} frameSentThrough event${k === 1 ? '' : 's'} per metrics packet`);
  }
  if (perPacket.length > 0) {
    lines.push(
      `Frames per packet: ${perPacket.join('; ')}.${batched ? ' The SDK batches frames: reduce.cjs keeps only the last landmark frame of a packet, so the landmark rate counts packets, not frames.' : ''}`,
    );
  }
  lines.push(
    sizes.length > 0
      ? `Frame size in the logged SDK lines: ${[...new Set(sizes.map((s) => s.size))].join(', ')} (${sizes[0]!.where}).`
      : `Real frame size: no logged SDK line names it (${consoleNote(ctx.tap, 'no line with a size')}), and no session file carries it.`,
  );
  return {
    n: 5,
    title: 'Rates',
    lines,
    data: {
      trace: { median_per_s: r1(traceMedian), mean_per_s: r1(spanRatePerSecond(traceTs)), samples: traceTs.length, span_s: r1(spanS) },
      landmarks: { ...rate(lmTs), frames: lmTs.length, interval_ms_median: r1(lmInterval) },
      talking: rate(talkTs),
      frame_sent_through: { ...rate(fTs), events: fCount },
      packets_per_s: r1(packetsPerS),
      not_sent_share: r3(notSent),
      not_sent_count: notSentCount,
      frame_rate_source: fTs.length >= 2 ? 'frameSentThrough' : null,
      frame_interval_ms_median: r1(fInterval),
      frame_rate_from_interval: fInterval ? r1(1000 / fInterval) : null,
      landmark_frames_per_packet_probe: framesPerPacket,
      frame_events_per_packet: fPerPacket === null ? null : r3(fPerPacket),
      frames_batched: batched,
      requested: [w, h, fps],
      logged_frame_sizes: sizes,
    },
  };
}

// ---- 6. Screen recording -------------------------------------------------------------------

export interface WindowRate {
  label: string;
  fromStep: string;
  toStep: string;
  seconds: number;
  medianPerS: number | null;
  meanPerS: number | null;
  samples: number;
}

/** Trace rate between two sample numbers, on camera time (the window edges mapped by ctx.camera). */
export function windowRate(ctx: SmokeContext, label: string, fromStep: string, toStep: string, startN: number, endN: number): WindowRate | null {
  if (ctx.camera === null || !(endN > startN)) return null;
  const startUs = ctx.camera.samplesToTsUs(startN);
  const endUs = ctx.camera.samplesToTsUs(endN);
  const ts = ctx.trace.map((p) => p[0]);
  return {
    label,
    fromStep,
    toStep,
    seconds: (endN - startN) / ctx.sampleRateHz,
    medianPerS: medianCountPerSecond(ts, startUs, endUs),
    meanPerS: meanRatePerSecond(ts, startUs, endUs),
    samples: ts.filter((t) => t >= startUs && t < endUs).length,
  };
}

const windowData = (w: WindowRate | null) =>
  w && { from_step: w.fromStep, to_step: w.toStep, seconds: r1(w.seconds), median_per_s: r1(w.medianPerS), mean_per_s: r1(w.meanPerS), samples: w.samples };

export function answerScreenRecording(ctx: SmokeContext): Answer {
  const quiet = findStep(ctx.steps, SMOKE_STEPS.quiet);
  const rec = findStep(ctx.steps, SMOKE_STEPS.screenRecording);
  const first = findStep(ctx.steps, SMOKE_STEPS.signalOk) ?? findStep(ctx.steps, SMOKE_STEPS.breatheNormally);
  const missing = ([
    quiet === null || quiet.endN === null ? SMOKE_STEPS.quiet : null,
    rec === null ? SMOKE_STEPS.screenRecording : null,
    first === null ? SMOKE_STEPS.signalOk : null,
  ] as (string | null)[]).filter((x): x is string => x !== null);
  const withRec = quiet && quiet.endN !== null ? windowRate(ctx, 'with', quiet.name, 'next step', quiet.n, quiet.endN) : null;
  const without = first && rec ? windowRate(ctx, 'without', first.name, rec.name, first.n, rec.n) : null;
  const lines: string[] = [];
  const show = (w: WindowRate | null, what: string, steps: string) =>
    w === null
      ? `${what}: cannot tell (${missing.length ? `no step mark for ${missing.join(', ')}` : 'no packet has an `arr` stamp'}).`
      : `${what} (${steps}, ${fmtS(w.seconds)}): median ${fmtPerS(w.medianPerS)}, mean ${fmtPerS(w.meanPerS)}, ${w.samples} samples.`;
  lines.push(show(withRec, 'Trace rate with the screen recording', `step ${SMOKE_STEPS.quiet}`));
  lines.push(show(without, 'Trace rate without it', `${first?.name ?? SMOKE_STEPS.signalOk} to ${SMOKE_STEPS.screenRecording}`));
  const diff = withRec?.medianPerS != null && without?.medianPerS != null ? withRec.medianPerS - without.medianPerS : null;
  if (diff !== null) {
    const low = withRec!.medianPerS! < TRACE_RATE_MIN_PER_S ? ` The rate with the recording is below ${TRACE_RATE_MIN_PER_S}: a demo take would not start (spec 15.5).` : '';
    lines.push(`Change with the recording: ${diff >= 0 ? '+' : ''}${r1(diff)} per s (median).${low}`);
  }
  lines.push('The recording runs from the screen_recording prompt to the end; the lens steps are left out of both windows.');
  return {
    n: 6,
    title: 'Screen recording',
    lines,
    data: { with_recording: windowData(withRec), without_recording: windowData(without), median_change_per_s: r1(diff), missing_steps: missing },
  };
}
