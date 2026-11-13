// Synthetic sessions with known truth and injectable faults (spec 13.4). Tests only.
// Deterministic for a given seed. See README.md in this folder for the options.

import {
  CHUNK_SAMPLES,
  FADE_SAMPLES,
  QUANTUM_SAMPLES,
  SAMPLE_RATE_HZ,
  clickSchedule,
  clickWaveform,
  type EventLine,
  type MicSettings,
  type SampleLine,
  type SessionData,
  type Stamp,
} from '../../core/clock/index.ts';
import {
  addCoupledClick,
  addNoise,
  addPa,
  addSniff,
  addVoiceReply,
  exponential,
  gaussian,
  mulberry32,
  narratorSignal,
  type Rng,
} from './signals.ts';

const R = SAMPLE_RATE_HZ;

export type Scenario = 'session' | 'gate';
export type HardEventKind = 'hidden' | 'devicechange' | 'track_ended' | 'track_mute';

export interface SyntheticFaults {
  /** Loop check B runs through L_rt + shift (7 gives rule `both`, 20 gives `void`). */
  lrtShiftMs?: number;
  /** One audio block is lost: its chunk stamp and its samples are missing (in the deep-breath step). */
  dropChunk?: boolean;
  /** SDK frames (trace samples and packets) per second instead of 30. */
  traceRateHz?: number;
  /**
   * One SDK `error` line in samples.jsonl and host's `sdk_error` event, mid narration. Host would
   * abort the recording there (spec 7.2); here it is not cut short, so the check sees the rest.
   */
  sdkError?: boolean;
  /** One `tap_lost` event from host mid narration. Not cut short either (see sdkError). */
  tapLost?: boolean;
  /** One hard window or device event mid narration. */
  hardEvent?: HardEventKind;
  /** echoCancellation and autoGainControl on in the logged settings. */
  micProcessing?: boolean;
  /** Microphone sampleRate in the logged settings. */
  micSampleRateHz?: number;
  /** The first live stop fades to 2 % instead of 0 and the narrator keeps reading. */
  stopNotSilent?: boolean;
}

export interface SyntheticOptions {
  /** PRNG seed (default 1). */
  seed?: number;
  /** 'session' (numbers session, live stops) or 'gate' (gate recording: sniffs, cues, no stops). Default 'session'. */
  scenario?: Scenario;
  /** True round-trip latency of loop check A, ms (default 23.4). */
  lrtMs?: number;
  /** Narration length, s (default 30). In 'gate', half listening and half objections. */
  narrationS?: number;
  /** Voice replies during the narration (default 3). */
  replies?: number;
  /** Delay of the trace behind the chest inside the SDK, ms (default 100). */
  traceLagMs?: number;
  /** false: no SDK at all (spacebar block, listening without camera). Default true. */
  camera?: boolean;
  faults?: SyntheticFaults;
}

export interface SyntheticStop {
  seq: number | null;
  cause: 'chest' | 'voice';
  nCmd: number;
  nSilent: number;
  nResume: number;
}

export interface SyntheticTruth {
  scenario: Scenario;
  /** True L_rt of loop checks A and B, ms. */
  lrtMs: { A: number; B: number };
  /** Input part of L_rt (microphone path), ms: sounds made at real time t appear at n = (t + L_in) * 48000. */
  lInMs: number;
  /** Click starts in channel 1 (sample numbers). */
  clicks: { A: number[]; B: number[] };
  /** 'pa' release bursts in channel 0. */
  paBursts: { start: number[]; end: number[] };
  /** True lip openings on the camera clock, us. */
  lipOpeningsUs: { start: number[]; end: number[] };
  /** Sniff sound onsets in channel 0 ('gate' only). */
  sniffOnsets: number[];
  /** Cue marks, the dot filling ('gate' only). */
  cues: number[];
  /** Voice onsets n_v of the replies in channel 0. */
  voiceOnsets: number[];
  replyDurationS: number;
  stops: SyntheticStop[];
  /** First sample of each scenario step, by mark name. */
  steps: Record<string, number>;
  /** Narrator playback [start, end) in sample numbers. */
  narration: [number, number];
  /** End of the listening block ('gate'), sample number. */
  listeningEnd: number | null;
  /** Drift of the camera clock: the lower envelope of nArr/48000 - ts rises this much, ppm. */
  cameraSlopePpm: number;
  /** Shortest frame-to-tap latency, ms (before Deck's quantum). */
  minLatencyMs: number;
  traceLagMs: number;
  /** P90 - P10 of plain breathing (the A_ref of a listening block), trace units. */
  aRef: number;
  sign: 1;
  /** n0 of the dropped block, or null. */
  droppedChunkN0: number | null;
  /** Recorded sample numbers before any drop: [0, totalSamples). */
  totalSamples: number;
}

export interface SyntheticSession {
  session: SessionData;
  truth: SyntheticTruth;
}

// Fixed parameters of the synthetic world.
const L_IN_SHARE = 0.4;
const CAMERA_EPOCH_US = 1_794_935_000_000_000;
const CAMERA_SLOPE_PPM = 40;
const TS_JITTER_US = 800;
const FRAME_JITTER_S = 0.0003;
const MIN_LATENCY_S = 0.04;
const LATENCY_TAIL_S = 0.012;
const HRTIME_BASE_NS = 812_345_678_901_234n;
const BREATH_AMP = 0.5;
const BREATH_PERIOD_S = 4.2;
const REPLY_S = 0.9;
const STOP_LEAD_S = 0.35;
const VOICE_OFF_S = 1.2;
const RESUME_RAMP_SAMPLES = 480;
const NOISE_FLOOR = 0.0005;
const LEAK_GAIN = 0.01;
const COUPLING_GAIN = 0.3;
const CLICK_JITTER_MS = 0.08;
const BLEND_S = 0.8;
/** The cue dot stays filled 1.5 s (spec 9.3). */
const CUE_SAMPLES = 72_000;
/** 'pa' cycle of web/scenarios/blocks.ts: 1.5 s 'Lips closed', then 'pa'; the lips open 0.4 s after the prompt. */
const PA_CYCLE_S = 3;
const PA_CLOSED_S = 1.5;
const PA_REACTION_S = 0.4;
/** Recording runs this far past the timeline end, so the last block is a short one (2400 samples). */
const LAST_BLOCK_S = 0.05;

const quantumCeil = (n: number): number => Math.ceil(n / QUANTUM_SAMPLES) * QUANTUM_SAMPLES;
const toN = (tS: number): number => Math.round(tS * R);

interface Timeline {
  steps: Array<{ name: string; t: number }>;
  loopA: number;
  loopB: number;
  deepBreaths: number;
  sniffs: number[];
  paStart: number[];
  paEnd: number[];
  narration: [number, number];
  listeningEnd: number | null;
  replies: number[];
  cues: number[];
  preflight: number | null;
  end: number;
}

/** Five 'pa' every 3 s: 'Lips closed', then 'pa' 1.5 s later, the lips open 0.4 s after that (web/scenarios/blocks.ts). */
function paBlock(steps: Timeline['steps'], tag: 'pa_start' | 'pa_end', t: number): number[] {
  const openings: number[] = [];
  for (let i = 1; i <= 5; i++) {
    const c = t + PA_CYCLE_S * (i - 1);
    steps.push({ name: `${tag}_${i}_closed`, t: c });
    steps.push({ name: `${tag}_${i}`, t: c + PA_CLOSED_S });
    openings.push(c + PA_CLOSED_S + PA_REACTION_S);
  }
  return openings;
}

// Step order and names of web/scenarios/gate.ts (spec 9.3) and spec 10.4. Waits that nothing
// measures (earcup prompt, headset, rests, preflight) are shorter than in the real scenarios.
function buildTimeline(scenario: Scenario, narrationS: number, replies: number): Timeline {
  const steps: Timeline['steps'] = [];
  let t = 0.5;
  steps.push({ name: 'loop_a_ready', t });
  t += 0.5;
  const loopA = t;
  steps.push({ name: 'loop_a', t });
  t += 12;
  steps.push({ name: 'headset', t });
  t += 2;
  if (scenario === 'gate') {
    steps.push({ name: 'breathe_normally', t });
    t += 4;
  }
  const deepBreaths = t;
  for (let i = 1; i <= 3; i++) {
    steps.push({ name: `deep_${i}_in`, t: t + 6 * (i - 1) });
    steps.push({ name: `deep_${i}_out`, t: t + 6 * (i - 1) + 2 });
  }
  t += 18;
  const sniffs: number[] = [];
  if (scenario === 'gate') {
    // 'Breathe out and wait', 'Sniff' 1.5 s later, the sniff 0.3 s after the prompt; every 4.4 s.
    for (let i = 1; i <= 5; i++) {
      const c = t + 4.4 * (i - 1);
      steps.push({ name: `sniff_${i}_wait`, t: c });
      steps.push({ name: `sniff_${i}`, t: c + 1.5 });
      sniffs.push(c + 1.8);
    }
    t += 22;
    steps.push({ name: 'rest_1', t });
    t += 2;
  }
  const paStart = paBlock(steps, 'pa_start', t);
  t += 5 * PA_CYCLE_S;
  let preflight: number | null = null;
  if (scenario === 'session') {
    preflight = t;
    steps.push({ name: 'preflight', t });
    t += 2;
  } else {
    steps.push({ name: 'rest_2', t });
    t += 2;
  }
  const narration: [number, number] = [t, t + narrationS];
  const replyTimes: number[] = [];
  const cues: number[] = [];
  let listeningEnd: number | null = null;
  if (scenario === 'session') {
    steps.push({ name: 'opening', t });
    const spacing = narrationS / (replies + 1);
    if (replies > 0 && spacing < 2.6) throw new RangeError('narrationS too short for the replies');
    for (let k = 0; k < replies; k++) replyTimes.push(t + (k + 1) * spacing);
  } else {
    steps.push({ name: 'listening', t });
    listeningEnd = t + narrationS / 2;
    steps.push({ name: 'objections', t: listeningEnd });
    const spacing = narrationS / 2 / Math.max(replies, 1);
    if (replies > 0 && spacing < 2.6) throw new RangeError('narrationS too short for the replies');
    for (let k = 0; k < replies; k++) {
      cues.push(listeningEnd + (k + 0.25) * spacing);
      replyTimes.push(listeningEnd + (k + 0.25) * spacing + 1.2);
    }
  }
  t += narrationS;
  const paEnd = paBlock(steps, 'pa_end', t);
  t += 5 * PA_CYCLE_S;
  steps.push({ name: 'loop_b_ready', t });
  t += 0.5;
  const loopB = t;
  steps.push({ name: 'loop_b', t });
  t += 12;
  steps.push({ name: 'end', t });
  return {
    steps,
    loopA,
    loopB,
    deepBreaths,
    sniffs,
    paStart,
    paEnd,
    narration,
    listeningEnd,
    replies: replyTimes,
    cues,
    preflight,
    end: t + 1,
  };
}

interface Segment {
  t0: number;
  t1: number;
  f: (t: number) => number;
}

const ramp =
  (t0: number, t1: number, a: number, b: number) =>
  (t: number): number =>
    a + (b - a) * (0.5 - 0.5 * Math.cos(Math.PI * Math.min(1, Math.max(0, (t - t0) / (t1 - t0)))));

/** Chest position over real time: plain breathing, blended into the scripted segments. */
function chestModel(tl: Timeline): (t: number) => number {
  const base = (t: number): number => BREATH_AMP * Math.sin((2 * Math.PI * (t - 0.3)) / BREATH_PERIOD_S);
  const segs: Segment[] = [];
  for (let k = 0; k < 3; k++) {
    const t = tl.deepBreaths + 6 * k;
    segs.push({ t0: t, t1: t + 2, f: ramp(t, t + 2, -0.5, 1.0) });
    segs.push({ t0: t + 2, t1: t + 6, f: ramp(t + 2, t + 6, 1.0, -0.5) });
  }
  // Sniffs 4.4 s apart: exhaled and still for 1.5 s, sharp rise, hold, slow fall into the next wait.
  for (const s of tl.sniffs) {
    segs.push({ t0: s - 1.5, t1: s, f: () => -0.5 });
    segs.push({ t0: s, t1: s + 0.3, f: ramp(s, s + 0.3, -0.5, 0.3) });
    segs.push({ t0: s + 0.3, t1: s + 0.8, f: () => 0.3 });
    segs.push({ t0: s + 0.8, t1: s + 2.9, f: ramp(s + 0.8, s + 2.9, 0.3, -0.5) });
  }
  for (const v of tl.replies) {
    segs.push({ t0: v - 0.5, t1: v, f: ramp(v - 0.5, v, -0.2, 0.3) });
    segs.push({ t0: v, t1: v + REPLY_S, f: ramp(v, v + REPLY_S, 0.3, -0.3) });
  }
  segs.sort((p, q) => p.t0 - q.t0);
  return (t: number): number => {
    let nearest: { d: number; v: number } | null = null;
    for (const s of segs) {
      if (t >= s.t0 && t <= s.t1) return s.f(t);
      const d = t < s.t0 ? s.t0 - t : t - s.t1;
      if (d < BLEND_S && (!nearest || d < nearest.d)) nearest = { d, v: s.f(t < s.t0 ? s.t0 : s.t1) };
    }
    if (!nearest) return base(t);
    const w = 0.5 - 0.5 * Math.cos((Math.PI * nearest.d) / BLEND_S);
    return (1 - w) * nearest.v + w * base(t);
  };
}

/** Lip gap g over real time: rest 0.035, closed 0.008 in the 'pa' blocks, linear openings. */
function lipModel(tl: Timeline): { g: (t: number) => number; talking: (t: number) => boolean } {
  const blocks = [tl.paStart, tl.paEnd].map((o) => ({ t0: o[0]! - 1.0, t1: o[o.length - 1]! + 0.6, openings: o }));
  const g = (t: number): number => {
    for (const v of tl.replies) {
      if (t >= v && t <= v + REPLY_S) return 0.035 + 0.06 * (0.5 - 0.5 * Math.cos(2 * Math.PI * 4 * (t - v)));
    }
    for (const b of blocks) {
      if (t < b.t0 - 0.3 || t > b.t1 + 0.3) continue;
      let closed = 0.008;
      for (const o of b.openings) {
        if (t >= o && t < o + 0.09) closed = 0.008 + ((0.16 - 0.008) * (t - o)) / 0.09;
        else if (t >= o + 0.09 && t < o + 0.25) closed = 0.16;
        else if (t >= o + 0.25 && t < o + 0.5) closed = 0.16 - ((0.16 - 0.008) * (t - o - 0.25)) / 0.25;
      }
      if (t < b.t0) return 0.035 + ((closed - 0.035) * (t - (b.t0 - 0.3))) / 0.3;
      if (t > b.t1) return closed + ((0.035 - closed) * (t - b.t1)) / 0.3;
      return closed;
    }
    return 0.035;
  };
  const talking = (t: number): boolean => tl.replies.some((v) => t >= v && t <= v + REPLY_S);
  return { g, talking };
}

// 16 face points in the order of spec 8.1 for a lip gap g (eye corners 120 px apart).
function facePoints(g: number): Array<[number, number]> {
  const half = (g * 120) / 2;
  const lip = (x: number): Array<[number, number]> => [
    [x, 420 - half],
    [x, 420 + half],
  ];
  const fixed: Array<[number, number]> = [
    [605, 420], // 78
    [675, 420], // 308
    [580, 330], // 33
    [700, 330], // 263
    [620, 330], // 133
    [660, 330], // 362
  ];
  const r = (v: number): number => Math.round(v * 10) / 10;
  return [...lip(640), ...lip(628), ...lip(652), ...lip(618), ...lip(662), ...fixed].map(([x, y]) => [r(x), r(y)]);
}

interface Packet {
  seq: number;
  nArr: number;
  tReal: number;
}

/** Builds one synthetic session. */
export function makeSyntheticSession(options: SyntheticOptions = {}): SyntheticSession {
  const scenario = options.scenario ?? 'session';
  const seed = options.seed ?? 1;
  const lrtA = options.lrtMs ?? 23.4;
  const narrationS = options.narrationS ?? 30;
  const replyCount = options.replies ?? 3;
  const traceLagS = (options.traceLagMs ?? 100) / 1000;
  const camera = options.camera ?? true;
  const faults = options.faults ?? {};
  const lrtB = lrtA + (faults.lrtShiftMs ?? 0);
  const lInS = (L_IN_SHARE * lrtA) / 1000;

  const rng: Rng = mulberry32(seed);
  const tl = buildTimeline(scenario, narrationS, replyCount);
  // Deck posts full 9600-sample blocks and a shorter last one when it finishes (web/lib/deck-core.ts).
  const total = toN(tl.end + LAST_BLOCK_S);
  let ch0: Float32Array = new Float32Array(total);
  let ch1: Float32Array = new Float32Array(total);
  const stamps: Stamp[] = [];
  const events: EventLine[] = [];
  const samples: SampleLine[] = [];
  const steps: Record<string, number> = {};

  for (const s of tl.steps) {
    const n = quantumCeil(toN(s.t));
    stamps.push({ n, k: 'mark', what: 'step', name: s.name });
    if (!(s.name in steps)) steps[s.name] = n;
  }
  // The dot fills for 1.5 s at each cue (spec 9.3); Deck stamps both edges. Deck's marks also
  // carry the cue index i (docs/protocol.md); these leave it out, so readers number cues by order.
  const cueNs = tl.cues.map((t) => quantumCeil(toN(t)));
  for (const n of cueNs) {
    stamps.push({ n, k: 'mark', what: 'cue', on: true }, { n: n + CUE_SAMPLES, k: 'mark', what: 'cue', on: false });
  }

  // Loop checks: the click in channel 1, through the pressed earcup into channel 0.
  const click = clickWaveform();
  const clicks = { A: [] as number[], B: [] as number[] };
  for (const [block, startS, lrtMs] of [
    ['A', tl.loopA, lrtA],
    ['B', tl.loopB, lrtB],
  ] as const) {
    clickSchedule().forEach((offset, i) => {
      const n = toN(startS) + offset;
      for (let j = 0; j < click.length; j++) ch1[n + j] = ch1[n + j]! + click[j]!;
      const delayMs = lrtMs + CLICK_JITTER_MS * gaussian(rng);
      addCoupledClick(ch0, click, n + (delayMs * R) / 1000, COUPLING_GAIN, R);
      stamps.push({ n, k: 'click', i });
      clicks[block].push(n);
    });
  }

  // SDK callbacks as tap writes them (spec 7.1, 8.1, live/reduce.cjs): every line has tArrNs, lines
  // are in arrival order, seq counts the SDK callbacks in that order, `l` lines have no seq.
  const chest = chestModel(tl);
  const lips = lipModel(tl);
  const fps = faults.traceRateHz ?? 30;
  const packets: Packet[] = [];
  const midS = (tl.narration[0] + tl.narration[1]) / 2;
  const midN = quantumCeil(toN(midS));
  if (camera) {
    const sdk0 = 0.5;
    const sdk1 = tl.end - 0.5;
    const sigma = CAMERA_SLOPE_PPM * 1e-6;
    const tapLines: Array<{ tTap: number; line: SampleLine; tReal?: number }> = [];
    tapLines.push({ tTap: sdk0 - 0.3, line: { k: 's', code: 3, name: 'kRunning' } });
    let prevTs = 0;
    let prevTap = 0;
    let prevSent = 0;
    for (let k = 0; ; k++) {
      const tReal = sdk0 + k / fps + FRAME_JITTER_S * gaussian(rng);
      if (tReal > sdk1) break;
      let ts = Math.round(CAMERA_EPOCH_US + tReal * 1e6 * (1 - sigma) + TS_JITTER_US * gaussian(rng));
      if (ts <= prevTs) ts = prevTs + 1;
      prevTs = ts;
      const latency = MIN_LATENCY_S + exponential(rng, LATENCY_TAIL_S) + (rng() < 0.02 ? 0.02 + 0.06 * rng() : 0);
      const tTap = Math.max(tReal + latency, prevTap + 0.0002);
      prevTap = tTap;
      // frameSentThrough fires when the frame leaves for processing, well before its metrics.
      const tSent = Math.max(tReal + 0.003 + 0.002 * rng(), prevSent + 0.0001);
      prevSent = tSent;
      tapLines.push({ tTap: tSent, line: { k: 'f', tsCbUs: ts, sent: rng() >= 0.004 } });
      if (k % fps === 0) tapLines.push({ tTap, line: { k: 'v', tsCbUs: ts, code: 0, name: 'kOk', hint: '' } });
      const g = Math.max(0, lips.g(tReal) + 0.0015 * gaussian(rng));
      tapLines.push({
        tTap,
        tReal,
        line: {
          k: 'm',
          tsCbUs: ts + Math.round((latency - 0.002) * 1e6),
          tr: [[ts, chest(tReal - traceLagS) + 0.004 * gaussian(rng)]],
          talk: [[ts, lips.talking(tReal) ? 1 : 0]],
          g,
          hm: Math.abs(0.0004 * gaussian(rng)),
          lm: { ts, reset: 0, p: facePoints(g) },
        },
      });
    }
    if (faults.sdkError) {
      tapLines.push({
        tTap: midS,
        line: { k: 'e', code: 5, name: 'kNetworkError', message: 'synthetic fault', retryable: false },
      });
    }
    for (let t = sdk0 + 1; t < sdk1; t += 1) {
      const p99 = 1.2 + exponential(rng, 0.6);
      tapLines.push({ tTap: t, line: { k: 'l', p50Ms: 0.4 + 0.2 * rng(), p99Ms: p99, maxMs: p99 + exponential(rng, 1.5), n: 50 } });
    }
    tapLines.sort((p, q) => p.tTap - q.tTap);
    let seq = 0;
    let prevN = 0;
    for (const { tTap, line, tReal } of tapLines) {
      const { k, ...rest } = line;
      const tArrNs = (HRTIME_BASE_NS + BigInt(Math.round(tTap * 1e9))).toString();
      if (k === 'l') {
        samples.push({ k, tArrNs, ...rest });
        continue;
      }
      const lineSeq = seq++;
      samples.push({ seq: lineSeq, k, tArrNs, ...rest });
      if (k === 'm' && tReal !== undefined) {
        // The worker steps D1, then Deck stamps the packet in the quantum that handles it (spec 6.3, 7.3).
        const nArr = Math.max(quantumCeil((tTap + 0.0015 + 0.001 * rng()) * R), prevN);
        prevN = nArr;
        stamps.push({ n: nArr, k: 'arr', seq: lineSeq });
        packets.push({ seq: lineSeq, nArr, tReal });
      }
    }
  }

  // Passages: Deck stamps `narrating` at a passage start and `idle` at its end (web/lib/deck-core.ts).
  const narrationN: [number, number] = [toN(tl.narration[0]), toN(tl.narration[1])];
  const passageStarts = tl.listeningEnd === null ? [narrationN[0]] : [narrationN[0], toN(tl.listeningEnd)];
  passageStarts.forEach((n, i) => {
    if (i > 0) stamps.push({ n, k: 'state', s: 'idle' });
    stamps.push({ n, k: 'state', s: 'narrating' });
  });
  stamps.push({ n: narrationN[1], k: 'state', s: 'idle' });

  // Replies, live stops and voice edges.
  const voiceOnsets = tl.replies.map((t) => toN(t + lInS));
  const stops: SyntheticStop[] = [];
  voiceOnsets.forEach((nV, k) => {
    const nOn = quantumCeil(nV + toN(0.03));
    const nOff = quantumCeil(nV + toN(REPLY_S + VOICE_OFF_S));
    stamps.push({ n: nOn, k: 'voice', on: true }, { n: nOff, k: 'voice', on: false });
    if (scenario !== 'session') return;
    let stop: SyntheticStop;
    if (camera) {
      const target = nV - toN(STOP_LEAD_S);
      const p = packets.find((q) => q.nArr >= target)!;
      stop = { seq: p.seq, cause: 'chest', nCmd: p.nArr, nSilent: p.nArr + FADE_SAMPLES, nResume: nOff };
    } else {
      const nCmd = quantumCeil(nOn + toN(0.25));
      stop = { seq: null, cause: 'voice', nCmd, nSilent: nCmd + FADE_SAMPLES, nResume: nOff };
    }
    const word = Math.floor((stop.nCmd - narrationN[0]) / toN(0.4));
    stops.push(stop);
    if (stop.cause === 'chest') {
      events.push({ n: stop.nCmd, e: 'fire', det: 'D1', seq: stop.seq, v: 2.3125, theta: 1.875 });
    }
    events.push(
      { n: stop.nCmd, e: 'hold', cause: stop.cause, nCmd: stop.nCmd, nSilent: stop.nSilent, word },
      { n: nOff, e: 'resume', word, why: 'voice_off' },
    );
    const hold: Stamp = { n: stop.nCmd, k: 'hold', cause: stop.cause, nSilent: stop.nSilent, word };
    if (stop.seq !== null) hold.seq = stop.seq;
    stamps.push(
      hold,
      { n: stop.nCmd, k: 'state', s: stop.cause === 'chest' ? 'hold_wait' : 'listening' },
      { n: nOff, k: 'state', s: 'resume' },
      { n: nOff, k: 'resume', word },
      { n: nOff, k: 'state', s: 'narrating' },
    );
    if (stop.cause === 'chest') stamps.push({ n: nOn, k: 'state', s: 'listening' });
  });

  // Narrator: Deck playback with fades, a frozen read pointer while silent, a 10 ms ramp on resume.
  const src = narratorSignal(narrationN[1] - narrationN[0] + R, rng, R);
  let ptr = 0;
  let h = 0;
  for (let n = narrationN[0]; n < narrationN[1]; n++) {
    while (h < stops.length && n >= stops[h]!.nResume + RESUME_RAMP_SAMPLES) h++;
    const stop = stops[h] && n >= stops[h]!.nCmd ? stops[h]! : null;
    let gain = 1;
    let advance = true;
    if (stop) {
      if (n < stop.nSilent) gain = 1 - (n - stop.nCmd) / FADE_SAMPLES;
      else if (n < stop.nResume) {
        const leaky = faults.stopNotSilent === true && h === 0;
        gain = leaky ? 0.02 : 0;
        advance = leaky;
      } else gain = (n - stop.nResume) / RESUME_RAMP_SAMPLES;
    }
    ch1[n] = gain * src[ptr]!;
    if (advance) ptr++;
  }
  const leakDelay = Math.round((lrtA * R) / 1000);
  for (let n = narrationN[0]; n < narrationN[1] && n + leakDelay < total; n++) {
    ch0[n + leakDelay] = ch0[n + leakDelay]! + LEAK_GAIN * ch1[n]!;
  }

  // Microphone: replies, 'pa' syllables, sniffs, noise floor.
  for (const nV of voiceOnsets) addVoiceReply(ch0, nV, REPLY_S, rng, R);
  const paBursts = { start: tl.paStart.map((t) => toN(t + lInS)), end: tl.paEnd.map((t) => toN(t + lInS)) };
  for (const n of [...paBursts.start, ...paBursts.end]) addPa(ch0, n, rng, R);
  const sniffOnsets = tl.sniffs.map((t) => toN(t + lInS));
  for (const n of sniffOnsets) addSniff(ch0, n, rng, R);
  addNoise(ch0, NOISE_FLOOR, rng);

  // Events of the scenario and the faults.
  if (scenario === 'session' && tl.preflight !== null) {
    events.push({ n: quantumCeil(toN(tl.preflight + 1)), e: 'preflight_ok' });
    if (camera) {
      events.push({ n: quantumCeil(toN(tl.narration[0] + 10)), e: 'armed', det: 'D1', on: true });
      events.push({ n: quantumCeil(narrationN[1]), e: 'armed', det: 'D1', on: false });
    }
  }
  // Host events as live/host.cjs writes them (live/lib/session-store.cjs writeHostEvent: by 'host',
  // n = lastN(), the sample after the last stored block); page events as web/ui/page-events.ts sends them.
  const hostN = Math.floor(midN / CHUNK_SAMPLES) * CHUNK_SAMPLES;
  if (faults.sdkError) {
    events.push({ n: hostN, e: 'sdk_error', by: 'host', code: 5, name: 'kNetworkError', message: 'synthetic fault' });
  }
  if (faults.tapLost) events.push({ n: hostN, e: 'tap_lost', by: 'host', why: 'silence', silent_ms: 3012 });
  switch (faults.hardEvent) {
    case 'hidden':
      events.push(
        { n: midN, e: 'visibilitychange', state: 'hidden', hard: true },
        { n: midN + R, e: 'visibilitychange', state: 'visible', hard: false },
      );
      break;
    case 'devicechange':
    case 'track_ended':
    case 'track_mute':
      events.push({ n: midN, e: faults.hardEvent, hard: true });
      break;
    default:
      break;
  }

  // Recording blocks; a dropped block loses its stamp and its samples, and host writes audio_gap
  // when the next block arrives: n = lastN() = the expected n0 (live/lib/session-store.cjs).
  let droppedChunkN0: number | null = null;
  if (faults.dropChunk) {
    const n0 = Math.floor(toN(tl.deepBreaths + 9) / CHUNK_SAMPLES) * CHUNK_SAMPLES;
    droppedChunkN0 = n0;
    const keep = (a: Float32Array): Float32Array => {
      const out = new Float32Array(total - CHUNK_SAMPLES);
      out.set(a.subarray(0, n0), 0);
      out.set(a.subarray(n0 + CHUNK_SAMPLES), n0);
      return out;
    };
    ch0 = keep(ch0);
    ch1 = keep(ch1);
    events.push({ n: n0, e: 'audio_gap', by: 'host', expected: n0, got: n0 + CHUNK_SAMPLES, missing: CHUNK_SAMPLES });
  }
  const chunkStamps: Stamp[] = [];
  for (let n0 = 0; n0 < total; n0 += CHUNK_SAMPLES) {
    if (n0 !== droppedChunkN0) chunkStamps.push({ n: n0, k: 'chunk', frames: Math.min(CHUNK_SAMPLES, total - n0) });
  }

  // stamps.jsonl order: Deck's stamps by sample; host writes a chunk stamp when the block arrives,
  // after the stamps of the block's samples (docs/protocol.md). Ties keep their order.
  const keyed = [
    ...stamps.map((s) => ({ s, key: s.n })),
    ...chunkStamps.map((s) => ({ s, key: s.n + (s.frames ?? 0) - 0.5 })),
  ];
  keyed.sort((p, q) => p.key - q.key);
  stamps.splice(0, stamps.length, ...keyed.map((x) => x.s));
  events.sort((p, q) => (p.n ?? 0) - (q.n ?? 0));

  const micSettings: MicSettings = {
    deviceId: 'synthetic-headset',
    groupId: 'synthetic',
    label: 'Synthetic headset microphone',
    sampleRate: faults.micSampleRateHz ?? R,
    sampleSize: 16,
    channelCount: 1,
    echoCancellation: faults.micProcessing === true,
    noiseSuppression: false,
    autoGainControl: faults.micProcessing === true,
    latency: 0.01,
    contextSampleRate: R,
    baseLatency: 0.0027,
    outputLatency: 0.012,
  };

  const truth: SyntheticTruth = {
    scenario,
    lrtMs: { A: lrtA, B: lrtB },
    lInMs: lInS * 1000,
    clicks,
    paBursts,
    lipOpeningsUs: {
      start: tl.paStart.map((t) => CAMERA_EPOCH_US + t * 1e6 * (1 - CAMERA_SLOPE_PPM * 1e-6)),
      end: tl.paEnd.map((t) => CAMERA_EPOCH_US + t * 1e6 * (1 - CAMERA_SLOPE_PPM * 1e-6)),
    },
    sniffOnsets,
    cues: cueNs,
    voiceOnsets,
    replyDurationS: REPLY_S,
    stops,
    steps,
    narration: narrationN,
    listeningEnd: tl.listeningEnd === null ? null : toN(tl.listeningEnd),
    cameraSlopePpm: CAMERA_SLOPE_PPM,
    minLatencyMs: MIN_LATENCY_S * 1000,
    traceLagMs: traceLagS * 1000,
    aRef: 2 * BREATH_AMP * Math.sin(0.4 * Math.PI),
    sign: 1,
    droppedChunkN0,
    totalSamples: total,
  };

  return {
    session: { sampleRateHz: R, ch0, ch1, stamps, samples, events, micSettings },
    truth,
  };
}
