// Detector D1 (and its D3 variant): one pure step() for live mode, replay, analysis and tests (spec 7.4).
// All D1 timing is on the 30 Hz grid of the trace timestamps, never wall time (spec 7.4).

import {
  AMP_P_HIGH,
  AMP_P_LOW,
  MAD_SCALE,
  d1ParamsFromFrozen,
  msToGridSteps,
  resolveD1Params,
  type D1Params,
  type D1ParamsInput,
} from './params.ts';
import {
  gridIndexAtOrAfter,
  gridIndexAtOrBefore,
  gridOffsetUs,
  insertSorted,
  lsSlopeWeights,
  mad,
  median,
  percentileSorted,
  removeSorted,
} from './math.ts';
import type { DetectorInput, Fire, NarratorState, Sign, Variant } from './types.ts';

/** A breath from the segmenter (spec 7.4 rule 4): trough to peak, in grid indices. */
export interface Breath {
  readonly troughIdx: number;
  readonly troughX: number;
  readonly peakIdx: number;
  readonly peakX: number;
  /** Largest v over the inhale (trough, peak], 1/s: the breath's maximum slope (spec 7.4 rule 7). */
  readonly maxV: number;
  /** Grid steps from the previous breath start to this breath's start (D3), when known. */
  readonly startInterval: number | null;
}

/** Statistics of the breath memory (spec 7.4 rule 7 and D3). */
export interface MemoryStats {
  readonly medQ: number | null;
  readonly sQ: number | null;
  readonly theta: number | null;
  readonly thetaD3: number | null;
  readonly medStartInterval: number | null;
  readonly medTroughX: number | null;
}

/** The 7.4 table periods in whole grid steps. */
export interface GridSteps {
  readonly refractory: number;
  readonly rearm: number;
  readonly gapInactive: number;
  readonly ampCap: number;
  readonly ampMin: number;
  readonly ampMaxAge: number;
  readonly memoryEntry: number;
  readonly rise: number;
  /** Interior points of one long gap processed one by one before the rest is skipped. */
  readonly maxFill: number;
}

/**
 * How a grid point lies among the samples (spec 7.4 table, gaps between samples):
 * ok   - its samples are <= 100 ms apart, or it lies on a sample;
 * gap  - inside a 100-500 ms gap: unusable, but it stays in the slope window and the segmenter;
 * void - inside a gap over 500 ms: unusable, and the slope window restarts after it.
 */
export type PointKind = 'ok' | 'gap' | 'void';

/**
 * Detector state. Callers treat it as opaque and read-only: step() returns a fresh copy,
 * stepMut() updates it in place. Indices (…Idx) are grid indices from the first trace sample.
 */
export interface DetectorState {
  readonly params: D1Params;
  readonly sign: Sign;
  readonly variant: Variant;
  readonly steps: GridSteps;
  readonly slopeWeights: Float64Array;
  readonly invalidCodes: ReadonlySet<number>;
  // Grid (spec 7.4 rule 1)
  originUs: number | null;
  lastTsUs: number;
  lastX: number;
  nextIdx: number;
  ring: Float64Array;
  /** Grid points in the slope window since it was last emptied (start, gap over 500 ms). */
  winRun: number;
  /** Whether the last grid point was a usable sample (spec 7.4 rule 2). */
  lastUsable: boolean;
  // Facts from val, voice and state lines; each acts from the next grid point (spec 7.4)
  narr: NarratorState | null;
  everNarrated: boolean;
  memoryResetPending: boolean;
  voiceOn: boolean;
  voiceOnEdge: boolean;
  voiceOffPending: boolean;
  code: number;
  codeInvalid: boolean;
  // Periods (spec 7.4 table). stopPhase: 0 no own stop, 1 hold sent and no narrator line yet,
  // 2 the narrator left "narrating" after the fire. The stop ends with the next "narrating".
  stopPhase: 0 | 1 | 2;
  inputCount: number;
  fireInput: number;
  fireIdx: number;
  postVoiceOpen: boolean;
  postVoiceStartIdx: number;
  postVoiceBreathDone: boolean;
  lastVoiceIdx: number;
  inactiveUntilIdx: number;
  // Amplitude window (spec 7.4 rule 3)
  ampIdx: Float64Array;
  ampX: Float64Array;
  ampSorted: Float64Array;
  ampHead: number;
  ampCount: number;
  A: number | null;
  lastA: number | null;
  // Segmenter (spec 7.4 rule 4)
  segDir: -1 | 0 | 1;
  hasMin: boolean;
  minIdx: number;
  minX: number;
  minUsable: boolean;
  maxIdx: number;
  maxX: number;
  maxVSinceMin: number;
  runMaxV: number;
  maxVAtMax: number;
  troughKnown: boolean;
  troughIdx: number;
  troughX: number;
  troughUsable: boolean;
  // Ordinary-breath memory (spec 7.4 rules 4-5)
  pending: Breath[];
  memory: Breath[];
  stats: MemoryStats;
  // Breath starts for D3 (spec 7.4, "Детектор D3"). startArmed: v came down to zero since the
  // last start, so the breath of startIdx has ended its inhale and the next start is awaited.
  startArmed: boolean;
  startRun: number;
  startIdx: number | null;
  startX: number;
  startInterval: number | null;
  // Fire rules (spec 7.4 rule 7)
  runD1: number;
  runD3: number;
  active: boolean;
  lastV: number | null;
}

/** Answer of step(): hold is true when the rule fired on this input (spec 6.2, 7.4). */
export interface StepResult {
  state: DetectorState;
  hold: boolean;
  fire?: Fire;
  /** Present when activity changed on this input: the new value, for the events.jsonl "armed" line. */
  armed?: boolean;
}

/** A parsed params/frozen.json (spec 8.4): initDetector reads its "d1" block. */
export interface FrozenParamsLike {
  d1: Record<string, unknown>;
  [key: string]: unknown;
}

const EMPTY_STATS: MemoryStats = Object.freeze({
  medQ: null,
  sQ: null,
  theta: null,
  thetaD3: null,
  medStartInterval: null,
  medTroughX: null,
});

function isFrozenParams(x: unknown): x is FrozenParamsLike {
  if (typeof x !== 'object' || x === null || Array.isArray(x)) return false;
  const d1 = (x as Record<string, unknown>)['d1'];
  return typeof d1 === 'object' && d1 !== null && !Array.isArray(d1);
}

/**
 * A new detector. params: any subset of the d1 fields (defaults from the 7.4 table) or a whole
 * parsed params/frozen.json (spec 8.4). sign is s from the cued deep breaths (spec 7.4);
 * variant 'D3' adds the early-breath rule.
 */
export function initDetector(
  params: D1ParamsInput | FrozenParamsLike = {},
  sign: Sign = 1,
  variant: Variant = 'D1',
): DetectorState {
  if (sign !== 1 && sign !== -1) throw new Error(`sign must be 1 or -1, got ${String(sign)}`);
  if (variant !== 'D1' && variant !== 'D3') throw new Error(`unknown variant ${String(variant)}`);
  const p = isFrozenParams(params) ? d1ParamsFromFrozen(params) : resolveD1Params(params as D1ParamsInput);
  Object.freeze(p.d3);
  Object.freeze(p);
  const hz = p.grid_hz;
  const base = {
    refractory: msToGridSteps(p.refractory_ms, hz),
    rearm: msToGridSteps(p.rearm_ms, hz),
    gapInactive: msToGridSteps(p.gap_inactive_ms, hz),
    ampCap: Math.max(1, msToGridSteps(p.amp_window_ms, hz)),
    ampMin: Math.max(1, msToGridSteps(p.amp_min_ms, hz)),
    ampMaxAge: msToGridSteps(p.amp_max_age_ms, hz),
    memoryEntry: msToGridSteps(p.memory_entry_ms, hz),
    rise: Math.max(1, msToGridSteps(p.min_rise_ms, hz)),
  };
  const steps: GridSteps = Object.freeze({
    ...base,
    maxFill: base.ampMaxAge + base.memoryEntry + base.refractory + base.rearm + base.gapInactive + 16,
  });
  const ringSize = Math.max(p.L, steps.rise + 1, p.d3.start_points) + 1;
  return {
    params: p,
    sign,
    variant,
    steps,
    slopeWeights: lsSlopeWeights(p.L, hz),
    invalidCodes: new Set(p.invalid_codes),
    originUs: null,
    lastTsUs: 0,
    lastX: 0,
    nextIdx: 0,
    ring: new Float64Array(ringSize),
    winRun: 0,
    lastUsable: false,
    narr: null,
    everNarrated: false,
    memoryResetPending: false,
    voiceOn: false,
    voiceOnEdge: false,
    voiceOffPending: false,
    code: 0,
    codeInvalid: false,
    stopPhase: 0,
    inputCount: 0,
    fireInput: -1,
    fireIdx: Number.NEGATIVE_INFINITY,
    postVoiceOpen: false,
    postVoiceStartIdx: 0,
    postVoiceBreathDone: false,
    lastVoiceIdx: Number.NEGATIVE_INFINITY,
    inactiveUntilIdx: Number.NEGATIVE_INFINITY,
    ampIdx: new Float64Array(steps.ampCap),
    ampX: new Float64Array(steps.ampCap),
    ampSorted: new Float64Array(steps.ampCap),
    ampHead: 0,
    ampCount: 0,
    A: null,
    lastA: null,
    segDir: 0,
    hasMin: false,
    minIdx: 0,
    minX: 0,
    minUsable: false,
    maxIdx: 0,
    maxX: 0,
    maxVSinceMin: Number.NEGATIVE_INFINITY,
    runMaxV: Number.NEGATIVE_INFINITY,
    maxVAtMax: Number.NEGATIVE_INFINITY,
    troughKnown: false,
    troughIdx: 0,
    troughX: 0,
    troughUsable: false,
    pending: [],
    memory: [],
    stats: EMPTY_STATS,
    startArmed: false,
    startRun: 0,
    startIdx: null,
    startX: 0,
    startInterval: null,
    runD1: 0,
    runD3: 0,
    active: false,
    lastV: null,
  };
}

/** Deep copy of the parts step() changes; immutable parts are shared. */
export function cloneDetectorState(s: DetectorState): DetectorState {
  return {
    ...s,
    ring: s.ring.slice(),
    ampIdx: s.ampIdx.slice(),
    ampX: s.ampX.slice(),
    ampSorted: s.ampSorted.slice(),
    pending: s.pending.slice(),
    memory: s.memory.slice(),
  };
}

/** Pure step: the input state is left untouched (spec 7.4). */
export function step(state: DetectorState, input: DetectorInput): StepResult {
  return stepMut(cloneDetectorState(state), input);
}

/** Same as step() but updates `s` in place; for loops that own the state (post-hoc runs, tuning). */
export function stepMut(s: DetectorState, input: DetectorInput): StepResult {
  const wasActive = s.active;
  s.inputCount++;
  let fire: Fire | undefined;
  switch (input.k) {
    case 'batch': {
      for (const pair of input.tr) {
        const ts = pair[0];
        const raw = pair[1];
        if (typeof ts !== 'number' || typeof raw !== 'number' || !Number.isFinite(ts) || !Number.isFinite(raw)) continue;
        if (s.originUs !== null && ts <= s.lastTsUs) continue; // repeated ts (spec 7.1)
        const f = ingestSample(s, ts, s.sign * raw); // s makes an inhale a rise (spec 7.4 rule 1)
        if (f !== undefined && fire === undefined) fire = f;
      }
      break;
    }
    case 'val':
      s.code = input.code;
      s.codeInvalid = s.invalidCodes.has(input.code);
      break;
    case 'voice':
      if (input.on) {
        s.voiceOn = true;
        s.voiceOnEdge = true;
      } else {
        s.voiceOn = false;
        s.voiceOffPending = true;
      }
      break;
    case 'state':
      s.narr = input.s;
      if (input.s === 'narrating') {
        if (!s.everNarrated) {
          s.everNarrated = true;
          s.memoryResetPending = true; // spec 7.4 rule 4
        }
        s.stopPhase = 0; // the stop has ended (spec 7.4 table, post-fire period)
      } else if (s.stopPhase === 1) {
        s.stopPhase = 2;
      }
      break;
    default:
      break;
  }
  const out: StepResult = { state: s, hold: fire !== undefined };
  if (fire !== undefined) out.fire = fire;
  if (s.active !== wasActive) out.armed = s.active;
  return out;
}

function ingestSample(s: DetectorState, ts: number, x: number): Fire | undefined {
  const p = s.params;
  const hz = p.grid_hz;
  if (s.originUs === null) {
    s.originUs = ts;
    s.lastTsUs = ts;
    s.lastX = x;
    s.nextIdx = 1;
    return gridPoint(s, 0, x, 'ok');
  }
  const rel = ts - s.originUs;
  const prevRel = s.lastTsUs - s.originUs;
  const dt = ts - s.lastTsUs;
  // spec 7.4 table: > 100 ms makes the grid points between the samples unusable; > 500 ms also
  // empties the slope window and makes D1 inactive for 3 s, while memory and A stay.
  const unusableGap = dt > p.gap_unusable_ms * 1000;
  const resetGap = dt > p.gap_reset_ms * 1000;
  if (resetGap) {
    s.winRun = 0;
    resetSegmenter(s); // the breath across the gap is dropped (assumption)
    resetStarts(s);
    s.inactiveUntilIdx = Math.max(s.inactiveUntilIdx, gridIndexAtOrAfter(rel, hz) + s.steps.gapInactive);
  }
  const inner: PointKind = resetGap ? 'void' : unusableGap ? 'gap' : 'ok';
  const last = gridIndexAtOrBefore(rel, hz);
  const x0 = s.lastX;
  const first = s.nextIdx;
  let fire: Fire | undefined;
  for (let i = first; i <= last; i++) {
    if (resetGap && i === first + s.steps.maxFill && last - 1 > i) {
      skipVoidPoints(s, last - 1);
      i = last - 1;
      continue;
    }
    // A grid point comes out when the first sample at or after it arrives (spec 7.4 rule 1).
    const tI = gridOffsetUs(i, hz);
    const onSample = tI === rel;
    const xi = onSample ? x : x0 + (x - x0) * ((tI - prevRel) / dt);
    const f = gridPoint(s, i, xi, onSample ? 'ok' : inner);
    if (f !== undefined && fire === undefined) fire = f;
  }
  if (last + 1 > s.nextIdx) s.nextIdx = last + 1;
  s.lastTsUs = ts;
  s.lastX = x;
  return fire;
}

/**
 * Same effect as gridPoint() on void points up to index `to`, once maxFill points of a long gap
 * have run one by one: by then nothing but voice and the amplitude window changes.
 */
function skipVoidPoints(s: DetectorState, to: number): void {
  if (s.voiceOn) s.lastVoiceIdx = to;
  while (s.ampCount > 0) {
    const due = s.ampIdx[s.ampHead]! + s.steps.ampMaxAge + 1;
    if (due > to) break;
    ampEvict(s, due);
    const a = ampValue(s);
    if (a !== null) s.lastA = a;
  }
  s.A = ampValue(s);
  admit(s, to);
  s.winRun = 0;
  s.lastUsable = false;
  s.lastV = null;
  s.startRun = 0;
  s.runD1 = 0;
  s.runD3 = 0;
  s.active = false;
}

function gridPoint(s: DetectorState, i: number, x: number, kind: PointKind): Fire | undefined {
  const p = s.params;
  const st = s.steps;
  if (s.memoryResetPending) {
    s.memory = [];
    s.pending = [];
    s.stats = EMPTY_STATS;
    s.memoryResetPending = false;
  }
  if (s.voiceOffPending) {
    s.postVoiceOpen = true;
    s.postVoiceStartIdx = i;
    s.postVoiceBreathDone = false;
    s.voiceOffPending = false;
  }
  const voice = s.voiceOn || s.voiceOnEdge;
  s.voiceOnEdge = false;
  if (voice) s.lastVoiceIdx = i;
  s.ring[i % s.ring.length] = x;
  s.winRun = kind === 'void' ? 0 : s.winRun + 1;

  // Post-voice period: 4.0 s after voice_off and one full ordinary breath (spec 7.4 table).
  // Without any amplitude yet no breath can be segmented, so only the 4.0 s apply (assumption).
  if (s.postVoiceOpen && i >= s.postVoiceStartIdx + st.rearm && (s.postVoiceBreathDone || s.lastA === null)) {
    s.postVoiceOpen = false;
  }
  // A hold that no narrator line followed within the post-fire period (no Deck reaction, as in
  // the first-day check) leaves no stop to wait for (assumption).
  if (s.stopPhase === 1 && i >= s.fireIdx + st.refractory && s.inputCount > s.fireInput) s.stopPhase = 0;

  // Usable sample (spec 7.4 rule 2). The trace is usable outside gaps and while none of the
  // four validationStatus codes holds (spec 7.1, assumption: the codes make the trace unusable).
  const traceUsable = kind === 'ok' && !s.codeInvalid;
  const usable = traceUsable && s.narr === 'narrating' && s.stopPhase === 0 && !voice && !s.postVoiceOpen;
  s.lastUsable = usable;

  // A = P90 - P10 of usable samples (spec 7.4 rule 3).
  ampEvict(s, i);
  if (usable) ampPush(s, i, x);
  const A = ampValue(s);
  s.A = A;
  if (A !== null) s.lastA = A;

  // Least-squares slope over L grid points, divided by A (spec 7.4 rule 3).
  const v = A !== null && s.winRun >= p.L ? slope(s, i) / A : null;
  s.lastV = v;

  if (kind !== 'void') segment(s, i, x, v, usable);
  admit(s, i);
  if (v !== null) trackStart(s, i, v);
  else s.startRun = 0;

  // Activity (spec 7.4 rule 6).
  const periodsOver = i >= s.fireIdx + st.refractory && s.stopPhase === 0 && i >= s.inactiveUntilIdx;
  const active = usable && A !== null && s.memory.length >= p.arm_breaths && periodsOver;
  s.active = active;

  // Fire (spec 7.4 rule 7; D3 rule from "Детектор D3").
  const stats = s.stats;
  let fire: Fire | undefined;
  const theta = stats.theta;
  if (active && A !== null && v !== null && theta !== null && v >= theta) {
    s.runD1++;
    if (s.runD1 >= p.M && riseOk(s, i, A)) fire = makeFire(s, i, v, theta, 'd1');
  } else {
    s.runD1 = 0;
  }
  if (s.variant === 'D3') {
    const thetaD3 = stats.thetaD3;
    if (active && v !== null && thetaD3 !== null && v >= thetaD3 && isEarlyBreath(s)) {
      s.runD3++;
      if (fire === undefined && s.runD3 >= p.M) fire = makeFire(s, i, v, thetaD3, 'd3');
    } else {
      s.runD3 = 0;
    }
  }
  if (fire !== undefined) {
    // Post-fire period starts; it lasts 2.0 s and until the stop ends (spec 7.4 table).
    s.fireIdx = i;
    s.stopPhase = 1;
    s.fireInput = s.inputCount;
    s.runD1 = 0;
    s.runD3 = 0;
    s.active = false;
  }
  return fire;
}

function makeFire(s: DetectorState, i: number, v: number, theta: number, rule: Fire['rule']): Fire {
  return { v, theta, tsUs: (s.originUs ?? 0) + gridOffsetUs(i, s.params.grid_hz), rule };
}

function slope(s: DetectorState, i: number): number {
  const w = s.slopeWeights;
  const n = w.length;
  const r = s.ring;
  const size = r.length;
  let acc = 0;
  for (let j = 0; j < n; j++) acc += w[j]! * r[(i - n + 1 + j) % size]!;
  return acc;
}

/** The trace rose >= 0.15 A within the last 200 ms (spec 7.4 rule 7). */
function riseOk(s: DetectorState, i: number, A: number): boolean {
  const back = s.steps.rise;
  if (s.winRun < back + 1) return false;
  const r = s.ring;
  const rise = r[i % r.length]! - r[(i - back) % r.length]!;
  return rise >= s.params.min_rise_A * A;
}

function ampEvict(s: DetectorState, i: number): void {
  const cap = s.ampX.length;
  while (s.ampCount > 0 && i - s.ampIdx[s.ampHead]! > s.steps.ampMaxAge) {
    removeSorted(s.ampSorted, s.ampCount, s.ampX[s.ampHead]!);
    s.ampHead = (s.ampHead + 1) % cap;
    s.ampCount--;
  }
}

function ampPush(s: DetectorState, i: number, x: number): void {
  const cap = s.ampX.length;
  if (s.ampCount === cap) {
    removeSorted(s.ampSorted, s.ampCount, s.ampX[s.ampHead]!);
    s.ampHead = (s.ampHead + 1) % cap;
    s.ampCount--;
  }
  const tail = (s.ampHead + s.ampCount) % cap;
  s.ampIdx[tail] = i;
  s.ampX[tail] = x;
  insertSorted(s.ampSorted, s.ampCount, x);
  s.ampCount++;
}

function ampValue(s: DetectorState): number | null {
  if (s.ampCount < s.steps.ampMin) return null;
  const a = percentileSorted(s.ampSorted, s.ampCount, AMP_P_HIGH) - percentileSorted(s.ampSorted, s.ampCount, AMP_P_LOW);
  return a > 0 ? a : null;
}

function resetSegmenter(s: DetectorState): void {
  s.segDir = 0;
  s.hasMin = false;
  s.troughKnown = false;
  s.maxVSinceMin = Number.NEGATIVE_INFINITY;
  s.runMaxV = Number.NEGATIVE_INFINITY;
  s.maxVAtMax = Number.NEGATIVE_INFINITY;
}

function resetStarts(s: DetectorState): void {
  s.startArmed = false;
  s.startRun = 0;
  s.startIdx = null;
  s.startInterval = null;
}

function setMin(s: DetectorState, i: number, x: number, usable: boolean): void {
  s.hasMin = true;
  s.minIdx = i;
  s.minX = x;
  s.minUsable = usable;
  s.maxVSinceMin = Number.NEGATIVE_INFINITY;
}

function confirmTroughAndRise(s: DetectorState, i: number, x: number): void {
  s.troughKnown = true;
  s.troughIdx = s.minIdx;
  s.troughX = s.minX;
  s.troughUsable = s.minUsable;
  s.segDir = 1;
  s.runMaxV = s.maxVSinceMin;
  s.maxIdx = i;
  s.maxX = x;
  s.maxVAtMax = s.runMaxV;
}

/**
 * Breath segmenter by extrema that differ by >= 0.25 A (spec 7.4 rule 4 and table). Runs on the
 * grid points outside long gaps, with the current A, or the last one when the window is short.
 * A flat minimum anchors at its last point, where the inhale starts: the breath begins there for
 * "began on a usable sample" and for the first full breath after voice_off (spec 7.4 rule 5).
 */
function segment(s: DetectorState, i: number, x: number, v: number | null, usable: boolean): void {
  const a = s.A ?? s.lastA;
  if (a === null) return;
  const stepX = s.params.segment_step_A * a;
  const vv = v ?? Number.NEGATIVE_INFINITY;
  if (s.segDir === 0) {
    if (!s.hasMin) {
      setMin(s, i, x, usable);
      s.maxIdx = i;
      s.maxX = x;
      return;
    }
    if (x <= s.minX) setMin(s, i, x, usable);
    else s.maxVSinceMin = Math.max(s.maxVSinceMin, vv);
    if (x > s.maxX) {
      s.maxIdx = i;
      s.maxX = x;
    }
    if (x >= s.minX + stepX) {
      confirmTroughAndRise(s, i, x);
    } else if (x <= s.maxX - stepX) {
      // A peak with no known trough before it: not a whole breath.
      s.segDir = -1;
      setMin(s, i, x, usable);
    }
    return;
  }
  if (s.segDir === 1) {
    s.runMaxV = Math.max(s.runMaxV, vv);
    if (x > s.maxX) {
      s.maxIdx = i;
      s.maxX = x;
      s.maxVAtMax = s.runMaxV;
    } else if (x <= s.maxX - stepX) {
      confirmPeak(s);
      s.segDir = -1;
      setMin(s, i, x, usable);
    }
    return;
  }
  if (x <= s.minX) {
    setMin(s, i, x, usable);
  } else {
    s.maxVSinceMin = Math.max(s.maxVSinceMin, vv);
    if (x >= s.minX + stepX) confirmTroughAndRise(s, i, x);
  }
}

function confirmPeak(s: DetectorState): void {
  if (!s.troughKnown) return;
  const troughIdx = s.troughIdx;
  const startInside = s.startIdx !== null && s.startIdx >= troughIdx && s.startIdx <= s.maxIdx;
  const b: Breath = {
    troughIdx,
    troughX: s.troughX,
    peakIdx: s.maxIdx,
    peakX: s.maxX,
    maxV: s.maxVAtMax,
    startInterval: startInside ? s.startInterval : null,
  };
  // The first full breath after voice_off closes the post-voice period (spec 7.4 rule 5).
  if (s.postVoiceOpen && troughIdx >= s.postVoiceStartIdx) s.postVoiceBreathDone = true;
  // Only a breath that began on a usable sample can enter memory (spec 7.4 rule 5).
  if (s.troughUsable && Number.isFinite(b.maxV)) s.pending.push(b);
}

/**
 * A breath enters memory 2 s after its maximum if there was no voice since it began (spec 7.4
 * rule 5; assumption: voice anywhere from its trough to its entry keeps it out).
 */
function admit(s: DetectorState, i: number): void {
  let changed = false;
  while (s.pending.length > 0) {
    const b = s.pending[0]!;
    if (i < b.peakIdx + s.steps.memoryEntry) break;
    s.pending.shift();
    if (s.lastVoiceIdx >= b.troughIdx) continue;
    s.memory.push(b);
    if (s.memory.length > s.params.memory_breaths) s.memory.shift();
    changed = true;
  }
  if (changed) s.stats = memoryStats(s.memory, s.params);
}

/** med_q, s_q and the thresholds from the breaths in memory (spec 7.4 rule 7, D3). */
export function memoryStats(memory: readonly Breath[], p: D1Params): MemoryStats {
  if (memory.length === 0) return EMPTY_STATS;
  const q = memory.map((b) => b.maxV);
  const medQ = median(q);
  const sQ = MAD_SCALE * mad(q, medQ);
  const ok = medQ > 0;
  const intervals = memory.map((b) => b.startInterval).filter((d): d is number => d !== null);
  return {
    medQ,
    sQ,
    theta: ok ? thetaFrom(medQ, sQ, p.k, p.theta_clamp) : null,
    thetaD3: ok ? medQ + p.d3.k * sQ : null,
    medStartInterval: intervals.length > 0 ? median(intervals) : null,
    medTroughX: median(memory.map((b) => b.troughX)),
  };
}

/** theta = med_q + k * s_q within [lo, hi] * med_q (spec 7.4 table). */
export function thetaFrom(medQ: number, sQ: number, k: number, clamp: readonly [number, number]): number {
  const raw = medQ + k * sQ;
  return Math.min(Math.max(raw, clamp[0] * medQ), clamp[1] * medQ);
}

/**
 * Breath start for D3: the first of 3 grid points in a row with v >= 0.35 med_q, after v has
 * come down to zero since the last maximum (spec 7.4, "Детектор D3").
 */
function trackStart(s: DetectorState, i: number, v: number): void {
  if (v <= 0) {
    s.startArmed = true;
    s.startRun = 0;
    return;
  }
  const medQ = s.stats.medQ;
  if (!s.startArmed || medQ === null || v < s.params.d3.start_v * medQ) {
    s.startRun = 0;
    return;
  }
  s.startRun++;
  if (s.startRun < s.params.d3.start_points) return;
  const idx = i - (s.params.d3.start_points - 1);
  s.startInterval = s.startIdx === null ? null : idx - s.startIdx;
  s.startIdx = idx;
  s.startX = s.ring[idx % s.ring.length]!;
  s.startArmed = false;
  s.startRun = 0;
}

/**
 * The current breath is early by interval or by starting level (spec 7.4, "Детектор D3"). A
 * breath is current from its start until v comes down to zero; before its start is found there
 * is no current breath, so a stale start of the previous breath is never used.
 */
function isEarlyBreath(s: DetectorState): boolean {
  if (s.startIdx === null || s.startArmed) return false;
  const st = s.stats;
  const d3 = s.params.d3;
  const byInterval =
    s.startInterval !== null && st.medStartInterval !== null && s.startInterval <= d3.early_interval * st.medStartInterval;
  const byLevel = st.medTroughX !== null && s.A !== null && s.startX - st.medTroughX >= d3.high_start_A * s.A;
  return byInterval || byLevel;
}

/** One fire of a file run, with its input line. */
export interface FireRecord extends Fire {
  index: number;
  seq: number;
}

/** One change of activity in a file run. */
export interface ArmedRecord {
  index: number;
  seq: number | null;
  on: boolean;
}

export interface DetectorRun {
  fires: FireRecord[];
  armed: ArmedRecord[];
  state: DetectorState;
}

/** Runs a whole detector_in.jsonl sequence; equals feeding step() one input at a time. */
export function runDetectorFile(
  inputs: readonly DetectorInput[],
  params: D1ParamsInput | FrozenParamsLike = {},
  sign: Sign = 1,
  variant: Variant = 'D1',
): DetectorRun {
  const s = initDetector(params, sign, variant);
  const fires: FireRecord[] = [];
  const armed: ArmedRecord[] = [];
  inputs.forEach((input, index) => {
    const out = stepMut(s, input);
    const seq = input.k === 'batch' || input.k === 'val' ? input.seq : null;
    if (out.fire !== undefined) fires.push({ ...out.fire, index, seq: seq ?? -1 });
    if (out.armed !== undefined) armed.push({ index, seq, on: out.armed });
  });
  return { fires, armed, state: s };
}
