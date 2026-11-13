// Voice detector of the Deck (spec 7.3): high-pass 150 Hz, 5 ms steps; a step is voiced when
// its energy is >= floor + 15 dB and its periodicity (normalized autocorrelation at 2.5-12.5 ms
// lags on the signal decimated to 8 kHz) is >= 0.5. voice_on: 30 of the last 50 ms voiced;
// voice_off: 1.2 s without a voiced step. The same streaming code runs live inside the
// AudioWorklet and after the recording (spec 7.3: "тот же код пересчитывает фронты").
//
// Block-size independence: every computation is per sample in stream order, and decimation
// and step boundaries sit on absolute sample numbers (multiples of 6 and of 240), so any split
// of the same samples into blocks gives the same edges.

import {
  butterworthSos,
  dbToPower,
  lowpassFir,
  maxNormalizedAutocorrelation,
  medianInPlace,
  nextPow2,
  powerToDb,
  type Sos,
} from './dsp.ts';

export interface VadParams {
  /** Audio sample rate (spec 7.3: one AudioContext at 48 000 Hz). */
  readonly sampleRateHz: number;
  /** High-pass corner (spec 7.3: 150 Hz). */
  readonly highpassHz: number;
  /** Butterworth order of the high-pass (assumption: 4, the order spec 7.6 uses). */
  readonly highpassOrder: number;
  /** Decision step (spec 7.3: 5 ms). */
  readonly hopMs: number;
  /** Energy window ending at each step boundary (assumption: 10 ms, the window of spec 7.6). */
  readonly energyWindowMs: number;
  /** Rate of the signal the periodicity is computed on (spec 7.3: 8 kHz). */
  readonly decimateToHz: number;
  /** Anti-alias FIR before decimation: odd number of taps (assumption). */
  readonly antiAliasTaps: number;
  /** Anti-alias FIR cutoff (assumption). */
  readonly antiAliasHz: number;
  /** Periodicity window ending at each step boundary (assumption: 30 ms, the window of spec 7.6). */
  readonly corrWindowMs: number;
  /** Lag range of the autocorrelation (spec 7.3: 2.5-12.5 ms). */
  readonly lagMs: readonly [minMs: number, maxMs: number];
  /** Noise floor, dB re full-scale mean square; `doctor` measures it with measureFloorDb (spec 7.12). */
  readonly floorDb: number;
  /** A voiced step needs energy >= floorDb + overFloorDb (spec 7.3: 15 dB). */
  readonly overFloorDb: number;
  /** A voiced step needs periodicity >= this (spec 7.3: 0.5; `doctor` may raise it to 0.7, spec 7.12). */
  readonly periodicity: number;
  /** voice_on when onMs[0] of the last onMs[1] ms are voiced (spec 7.3: 30 of 50). */
  readonly onMs: readonly [voicedMs: number, windowMs: number];
  /** voice_off after this long without a voiced step (spec 7.3: 1.2 s). */
  readonly offMs: number;
}

/**
 * Defaults. `floorDb` is a placeholder until `doctor` measures the floor; the tag
 * `gate-prereg` freezes the measured value with the rest (spec 7.3, 8.4).
 */
export const DEFAULT_VAD_PARAMS: VadParams = Object.freeze({
  sampleRateHz: 48000,
  highpassHz: 150,
  highpassOrder: 4,
  hopMs: 5,
  energyWindowMs: 10,
  decimateToHz: 8000,
  antiAliasTaps: 95,
  antiAliasHz: 3200,
  corrWindowMs: 30,
  lagMs: Object.freeze([2.5, 12.5] as const),
  floorDb: -70,
  overFloorDb: 15,
  periodicity: 0.5,
  onMs: Object.freeze([30, 50] as const),
  offMs: 1200,
});

const PARAM_KEYS: ReadonlySet<string> = new Set(Object.keys(DEFAULT_VAD_PARAMS));

/**
 * Full parameters from a partial set: missing fields take DEFAULT_VAD_PARAMS. Unknown keys throw
 * a RangeError, so a parameter block of another shape (e.g. the snake_case `vad` block of
 * params/frozen.json, see vadParamsFromFrozen) fails loudly instead of running on defaults.
 */
export function resolveVadParams(params: Partial<VadParams> = DEFAULT_VAD_PARAMS): VadParams {
  if (params === DEFAULT_VAD_PARAMS) return DEFAULT_VAD_PARAMS;
  if (params === null || typeof params !== 'object') throw new RangeError('vad: params must be an object');
  for (const key of Object.keys(params)) {
    if (!PARAM_KEYS.has(key)) throw new RangeError(`vad: unknown parameter "${key}"`);
  }
  const out: Record<string, unknown> = { ...DEFAULT_VAD_PARAMS };
  for (const [key, value] of Object.entries(params)) if (value !== undefined) out[key] = value;
  return out as unknown as VadParams;
}

/** A voice edge: `n` is the sample number of the step boundary where the decision is made
 * (the decision uses samples < n). */
export interface VadEdge {
  readonly n: number;
  readonly on: boolean;
}

export interface Vad {
  /**
   * Feeds the next block. `n0` is the sample number of block[0]; blocks must be contiguous.
   * Returns the edges decided inside this block, in order. When there are none it returns
   * one shared frozen empty array (no allocation per audio quantum): do not mutate it.
   */
  push(block: Float32Array, n0: number): VadEdge[];
  /** Current state: true between voice_on and voice_off. */
  readonly on: boolean;
}

/** Called once per step with its boundary sample, mean square, periodicity and decision. */
type StepObserver = (n: number, meanSquare: number, periodicity: number, voiced: boolean) => void;

interface VadConfig {
  readonly hop: number;
  readonly winE: number;
  readonly decim: number;
  readonly winC: number;
  readonly lagMin: number;
  readonly lagMax: number;
  readonly onVoiced: number;
  readonly onWindow: number;
  readonly offSteps: number;
  readonly energyThresholdSum: number;
  readonly periodicity: number;
  readonly sos: Sos;
  readonly fir: Float64Array;
}

const NO_EDGES: VadEdge[] = Object.freeze([]) as unknown as VadEdge[];

function wholeSamples(ms: number, rateHz: number, what: string): number {
  const v = (ms * rateHz) / 1000;
  const r = Math.round(v);
  if (!(r > 0) || Math.abs(v - r) > 1e-6) {
    throw new RangeError(`vad: ${what} = ${ms} ms is not a positive whole number of samples at ${rateHz} Hz`);
  }
  return r;
}

function wholeSteps(ms: number, hopMs: number, what: string): number {
  const v = ms / hopMs;
  const r = Math.round(v);
  if (!(r > 0) || Math.abs(v - r) > 1e-6) {
    throw new RangeError(`vad: ${what} = ${ms} ms is not a positive whole number of ${hopMs} ms steps`);
  }
  return r;
}

function configure(p: VadParams): VadConfig {
  const fs = p.sampleRateHz;
  const decimF = fs / p.decimateToHz;
  const decim = Math.round(decimF);
  if (!(decim >= 1) || Math.abs(decimF - decim) > 1e-9) {
    throw new RangeError(`vad: ${fs} Hz is not a whole multiple of ${p.decimateToHz} Hz`);
  }
  const hop = wholeSamples(p.hopMs, fs, 'hopMs');
  if (hop % decim !== 0) throw new RangeError('vad: the step must hold a whole number of decimated samples');
  const winE = wholeSamples(p.energyWindowMs, fs, 'energyWindowMs');
  const winC = wholeSamples(p.corrWindowMs, p.decimateToHz, 'corrWindowMs');
  const lagMin = Math.ceil((p.lagMs[0] * p.decimateToHz) / 1000 - 1e-9);
  const lagMax = Math.floor((p.lagMs[1] * p.decimateToHz) / 1000 + 1e-9);
  if (!(lagMin >= 1 && lagMin <= lagMax && lagMax < winC)) {
    throw new RangeError(`vad: lag range [${p.lagMs[0]}, ${p.lagMs[1]}] ms does not fit the ${p.corrWindowMs} ms window`);
  }
  const onVoiced = wholeSteps(p.onMs[0], p.hopMs, 'onMs[0]');
  const onWindow = wholeSteps(p.onMs[1], p.hopMs, 'onMs[1]');
  if (onVoiced > onWindow) throw new RangeError('vad: onMs[0] must not exceed onMs[1]');
  const offSteps = wholeSteps(p.offMs, p.hopMs, 'offMs');
  if (!(p.periodicity > 0 && p.periodicity <= 1)) throw new RangeError('vad: periodicity must be in (0, 1]');
  if (!Number.isFinite(p.floorDb) || !Number.isFinite(p.overFloorDb)) {
    throw new RangeError('vad: floorDb and overFloorDb must be finite');
  }
  return {
    hop,
    winE,
    decim,
    winC,
    lagMin,
    lagMax,
    onVoiced,
    onWindow,
    offSteps,
    energyThresholdSum: dbToPower(p.floorDb + p.overFloorDb) * winE,
    periodicity: p.periodicity,
    sos: butterworthSos('highpass', p.highpassOrder, p.highpassHz, fs),
    fir: lowpassFir(p.antiAliasTaps, p.antiAliasHz, fs),
  };
}

function mod(a: number, m: number): number {
  const r = a % m;
  return r < 0 ? r + m : r;
}

class VoiceDetector implements Vad {
  private readonly cfg: VadConfig;
  private readonly observer: StepObserver | null;
  private readonly alwaysPeriodicity: boolean;
  private readonly z: Float64Array;
  private readonly ring48: Float64Array;
  private readonly mask48: number;
  private readonly ring8: Float64Array;
  private readonly mask8: number;
  private readonly win: Float64Array;
  private readonly prefix: Float64Array;
  private readonly hist: Uint8Array;
  private w48 = 0;
  private w8 = 0;
  private started = false;
  private nNext = 0;
  private phDec = 0;
  private phHop = 0;
  private histPos = 0;
  private histCount = 0;
  private isOn = false;
  private quietSteps = 0;

  constructor(params: VadParams, observer: StepObserver | null, alwaysPeriodicity: boolean) {
    this.cfg = configure(resolveVadParams(params));
    this.observer = observer;
    this.alwaysPeriodicity = alwaysPeriodicity;
    this.z = new Float64Array((this.cfg.sos.length / 5) * 2);
    const size48 = nextPow2(Math.max(this.cfg.winE, this.cfg.fir.length));
    this.ring48 = new Float64Array(size48);
    this.mask48 = size48 - 1;
    const size8 = nextPow2(this.cfg.winC);
    this.ring8 = new Float64Array(size8);
    this.mask8 = size8 - 1;
    this.win = new Float64Array(this.cfg.winC);
    this.prefix = new Float64Array(this.cfg.winC + 1);
    this.hist = new Uint8Array(this.cfg.onWindow);
  }

  get on(): boolean {
    return this.isOn;
  }

  push(block: Float32Array, n0: number): VadEdge[] {
    const cfg = this.cfg;
    if (!Number.isSafeInteger(n0)) throw new RangeError(`vad: n0 must be an integer, got ${n0}`);
    if (!this.started) {
      // The stream starts at its first sample: an empty block before it changes nothing.
      if (block.length === 0) return NO_EDGES;
      this.started = true;
      this.phDec = mod(n0, cfg.decim);
      this.phHop = mod(n0, cfg.hop);
      const x0 = block[0]!;
      this.primeHighpass(x0 > -3.4e38 && x0 < 3.4e38 ? x0 : 0);
    } else if (n0 !== this.nNext) {
      throw new RangeError(`vad: block starts at ${n0}, expected ${this.nNext} (blocks must be contiguous)`);
    }
    this.nNext = n0 + block.length;

    const sos = cfg.sos;
    const sections = sos.length / 5;
    const z = this.z;
    const ring48 = this.ring48;
    const mask48 = this.mask48;
    const ring8 = this.ring8;
    const mask8 = this.mask8;
    const fir = cfg.fir;
    const taps = fir.length;
    let edges = NO_EDGES;

    for (let j = 0; j < block.length; j++) {
      let y = block[j]!;
      // A non-finite sample would poison the filter state for the rest of the stream: count it as 0.
      if (!(y > -3.4e38 && y < 3.4e38)) y = 0;
      for (let s = 0; s < sections; s++) {
        const o = s * 5;
        const zo = s * 2;
        const out = sos[o]! * y + z[zo]!;
        z[zo] = sos[o + 1]! * y - sos[o + 3]! * out + z[zo + 1]!;
        z[zo + 1] = sos[o + 2]! * y - sos[o + 4]! * out;
        y = out;
      }
      const w48 = (this.w48 + 1) & mask48;
      this.w48 = w48;
      ring48[w48] = y;

      if (++this.phDec === cfg.decim) {
        this.phDec = 0;
        let acc = 0;
        for (let k = 0; k < taps; k++) acc += fir[k]! * ring48[(w48 - k) & mask48]!;
        const w8 = (this.w8 + 1) & mask8;
        this.w8 = w8;
        ring8[w8] = acc;
      }

      if (++this.phHop === cfg.hop) {
        this.phHop = 0;
        const edge = this.step(n0 + j + 1);
        if (edge !== null) {
          if (edges === NO_EDGES) edges = [];
          edges.push(edge);
        }
      }
    }
    return edges;
  }

  /** Starts the high-pass in its steady state for a constant input equal to the first sample,
   * so a DC offset at stream start gives no transient. */
  private primeHighpass(x0: number): void {
    const sos = this.cfg.sos;
    this.z[0] = (sos[1]! + sos[2]!) * x0;
    this.z[1] = sos[2]! * x0;
  }

  private step(n: number): VadEdge | null {
    const cfg = this.cfg;
    const ring48 = this.ring48;
    const mask48 = this.mask48;
    const w48 = this.w48;
    let sumSq = 0;
    for (let k = 0; k < cfg.winE; k++) {
      const v = ring48[(w48 - k) & mask48]!;
      sumSq += v * v;
    }
    const loud = sumSq >= cfg.energyThresholdSum;
    let c = 0;
    if (loud || this.alwaysPeriodicity) {
      const win = this.win;
      const ring8 = this.ring8;
      const mask8 = this.mask8;
      const first = this.w8 - cfg.winC + 1;
      for (let k = 0; k < cfg.winC; k++) win[k] = ring8[(first + k) & mask8]!;
      c = maxNormalizedAutocorrelation(win, cfg.winC, cfg.lagMin, cfg.lagMax, this.prefix);
    }
    const voiced = loud && c >= cfg.periodicity;
    if (this.observer !== null) this.observer(n, sumSq / cfg.winE, c, voiced);

    const v = voiced ? 1 : 0;
    this.histCount += v - this.hist[this.histPos]!;
    this.hist[this.histPos] = v;
    this.histPos = this.histPos + 1 === cfg.onWindow ? 0 : this.histPos + 1;

    if (!this.isOn) {
      if (this.histCount >= cfg.onVoiced) {
        this.isOn = true;
        this.quietSteps = 0;
        return { n, on: true };
      }
    } else if (voiced) {
      this.quietSteps = 0;
    } else if (++this.quietSteps >= cfg.offSteps) {
      this.isOn = false;
      return { n, on: false };
    }
    return null;
  }
}

/**
 * Creates a streaming voice detector (spec 7.3). Missing params take DEFAULT_VAD_PARAMS; unknown
 * keys and inconsistent values throw a RangeError. Allocates only here: push() is safe to call
 * on every 128-sample quantum of an AudioWorklet.
 */
export function createVad(params: Partial<VadParams> = DEFAULT_VAD_PARAMS): Vad {
  return new VoiceDetector(resolveVadParams(params), null, false);
}

/**
 * Edges over a whole signal, by the same streaming code as createVad(). Reproduces the live
 * edges exactly when the live detector saw the same samples starting at the same n0.
 */
export function vadEdges(signal: Float32Array, params: Partial<VadParams> = DEFAULT_VAD_PARAMS, n0 = 0): VadEdge[] {
  return Array.from(createVad(params).push(signal, n0));
}

/** Per-step features, for doctor and diagnostics. Periodicity is computed on every step here. */
export interface VadStepFeatures {
  /** Step boundary sample numbers. */
  readonly n: Float64Array;
  /** Energy of the window ending at n, dB re full-scale mean square. */
  readonly energyDb: Float32Array;
  readonly periodicity: Float32Array;
  readonly voiced: Uint8Array;
}

export function vadStepFeatures(
  signal: Float32Array,
  partial: Partial<VadParams> = DEFAULT_VAD_PARAMS,
  n0 = 0,
): VadStepFeatures {
  const params = resolveVadParams(partial);
  const hop = wholeSamples(params.hopMs, params.sampleRateHz, 'hopMs');
  const max = Math.floor(signal.length / hop) + 1;
  const n = new Float64Array(max);
  const energyDb = new Float32Array(max);
  const periodicity = new Float32Array(max);
  const voiced = new Uint8Array(max);
  let i = 0;
  const det = new VoiceDetector(
    params,
    (nb, ms, c, v) => {
      n[i] = nb;
      energyDb[i] = powerToDb(ms);
      periodicity[i] = c;
      voiced[i] = v ? 1 : 0;
      i++;
    },
    true,
  );
  det.push(signal, n0);
  return {
    n: n.subarray(0, i),
    energyDb: energyDb.subarray(0, i),
    periodicity: periodicity.subarray(0, i),
    voiced: voiced.subarray(0, i),
  };
}

/**
 * Noise floor for the voice detector, as `doctor` measures it (spec 7.3, 7.12): the median
 * step energy (dB re full-scale mean square) of `signal`, on the same filtered energy the
 * detector compares with floor + 15 dB. Steps whose energy window starts before the signal
 * are skipped. Returns NaN when the signal is shorter than one energy window.
 */
export function measureFloorDb(signal: Float32Array, partial: Partial<VadParams> = DEFAULT_VAD_PARAMS): number {
  const params = resolveVadParams(partial);
  const winE = wholeSamples(params.energyWindowMs, params.sampleRateHz, 'energyWindowMs');
  const hop = wholeSamples(params.hopMs, params.sampleRateHz, 'hopMs');
  const values = new Float64Array(Math.floor(signal.length / hop) + 1);
  let count = 0;
  const det = new VoiceDetector(
    params,
    (n, ms) => {
      if (n >= winE) values[count++] = powerToDb(ms);
    },
    false,
  );
  det.push(signal, 0);
  return medianInPlace(values, count);
}

export interface VadTuneTrial {
  readonly periodicity: number;
  /** Number of voice_on edges on the inhale recording at this threshold. */
  readonly onEdges: number;
}

export interface VadTuneResult {
  /** The threshold to freeze. */
  readonly periodicity: number;
  /** `params` with that threshold. */
  readonly params: VadParams;
  /** True when the starting threshold gave voice_on on the inhales (doctor prints this). */
  readonly inhaleTriggered: boolean;
  /** True when the chosen threshold gives no voice_on; false when even the cap still does. */
  readonly ok: boolean;
  readonly trials: readonly VadTuneTrial[];
}

/**
 * Doctor's inhale check (spec 7.12): if a loud inhale switched voice_on, the periodicity
 * threshold rises in steps of 0.05 to the first value without voice_on, but not above 0.7.
 * When even the cap triggers, the cap is returned with ok = false.
 */
export function tuneVadThreshold(
  inhaleSignal: Float32Array,
  partial: Partial<VadParams> = DEFAULT_VAD_PARAMS,
  opts: { readonly stepPeriodicity?: number; readonly maxPeriodicity?: number; readonly n0?: number } = {},
): VadTuneResult {
  const params = resolveVadParams(partial);
  const step = opts.stepPeriodicity ?? 0.05;
  const cap = opts.maxPeriodicity ?? 0.7;
  const n0 = opts.n0 ?? 0;
  if (!(step > 0)) throw new RangeError('tuneVadThreshold: step must be positive');
  const trials: VadTuneTrial[] = [];
  let p = params.periodicity;
  for (;;) {
    const trial = { ...params, periodicity: p };
    const onEdges = vadEdges(inhaleSignal, trial, n0).filter((e) => e.on).length;
    trials.push({ periodicity: p, onEdges });
    const done = (ok: boolean): VadTuneResult => ({
      periodicity: p,
      params: trial,
      inhaleTriggered: trials[0]!.onEdges > 0,
      ok,
      trials,
    });
    if (onEdges === 0) return done(true);
    const next = Math.round((p + step) * 1e6) / 1e6;
    if (next > cap + 1e-9) return done(false);
    p = next;
  }
}

/**
 * Pairs edges into voice intervals [on.n, off.n). An interval still open at the end is closed
 * at `endSample` when given, otherwise dropped.
 */
export function voiceIntervalsFromEdges(
  edges: readonly VadEdge[],
  endSample?: number,
): Array<readonly [start: number, end: number]> {
  const out: Array<readonly [number, number]> = [];
  let start: number | null = null;
  for (const e of edges) {
    if (e.on && start === null) start = e.n;
    else if (!e.on && start !== null) {
      out.push([start, e.n]);
      start = null;
    }
  }
  if (start !== null && endSample !== undefined && endSample > start) out.push([start, endSample]);
  return out;
}
