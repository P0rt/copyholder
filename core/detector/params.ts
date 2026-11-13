// Detector parameters: spec 7.4 table and the "d1" block of params/frozen.json (spec 8.4).
// Only k is tuned (stage A, spec 7.4 and 9.5). L and M change only in the bounded retune (spec 9.8).

/** Session clock: one AudioContext at 48 kHz (spec 6.3). */
export const SAMPLE_RATE_HZ = 48_000;

/** Trace grid, Hz (spec 7.4 table). */
export const GRID_HZ = 30;
/** Least-squares slope window, grid points (spec 7.4 table: L). */
export const SLOPE_WINDOW_L = 5;
/** Consecutive grid points with v >= theta (spec 7.4 table: M). */
export const CONSECUTIVE_M = 2;
/** Grid of k tried by stage A, smallest first (spec 7.4 table). */
export const K_GRID: readonly number[] = Object.freeze([1.5, 2.0, 2.5, 3.0, 3.5]);
/** k used until stage A writes params/frozen.json: the spec 8.4 example value. */
export const K_PRELIMINARY = 2.5;
/** Retune ladder step 2 grids (spec 9.8). */
export const L_RETUNE_GRID: readonly number[] = Object.freeze([4, 5, 7]);
export const M_RETUNE_GRID: readonly number[] = Object.freeze([1, 2, 3]);

/** theta = med_q + k * s_q, clamped to [1.3, 3.0] * med_q (spec 7.4 table). */
export const THETA_CLAMP_MED_Q: readonly [number, number] = Object.freeze([1.3, 3.0]) as readonly [number, number];
/** Minimum rise: >= 0.15 A within 200 ms (spec 7.4 table). */
export const MIN_RISE_A = 0.15;
export const MIN_RISE_MS = 200;
/** Breaths in memory needed to be active (spec 7.4 table). */
export const ARM_BREATHS = 10;
/** Post-fire period, ms (spec 7.4 table), and not before the end of the stop. */
export const REFRACTORY_MS = 2_000;
/** Post-voice period, ms after voice_off, plus one full ordinary breath (spec 7.4 table). */
export const REARM_MS = 4_000;

/** Gap between trace samples: > 100 ms makes the grid points between them unusable (spec 7.4 table). */
export const GAP_UNUSABLE_MS = 100;
/** Gap > 500 ms empties the slope window and deactivates D1 for 3 s (spec 7.4 table). */
export const GAP_RESET_MS = 500;
export const GAP_INACTIVE_MS = 3_000;

/** Amplitude A: last 30 s of usable samples, none older than 120 s, at least 15 s (spec 7.4 table). */
export const AMP_WINDOW_MS = 30_000;
export const AMP_MAX_AGE_MS = 120_000;
export const AMP_MIN_MS = 15_000;
/** A = P90 - P10 (spec 7.4 rule 3). */
export const AMP_P_LOW = 0.1;
export const AMP_P_HIGH = 0.9;

/** Segmenter: extrema differ by >= 0.25 A (spec 7.4 table). */
export const SEGMENT_STEP_A = 0.25;
/** Ordinary-breath memory: the last 20 (spec 7.4 table). */
export const MEMORY_BREATHS = 20;
/** A breath enters memory 2 s after its maximum (spec 7.4 table). */
export const MEMORY_ENTRY_MS = 2_000;
/** s_q = 1.4826 * MAD (spec 7.4 rule 7). */
export const MAD_SCALE = 1.4826;

/** validationStatus codes that keep D1 inactive (spec 7.1, 7.4). */
export const VALIDATION_CODES = Object.freeze({
  kOk: 0,
  kNoFaceFound: 1,
  kMultipleFacesFound: 2,
  kChestNotVisible: 7,
  kExcessiveMotion: 12,
});
export const INVALID_VALIDATION_CODES: readonly number[] = Object.freeze([
  VALIDATION_CODES.kNoFaceFound,
  VALIDATION_CODES.kMultipleFacesFound,
  VALIDATION_CODES.kChestNotVisible,
  VALIDATION_CODES.kExcessiveMotion,
]);

/** D3 numbers, fixed in advance (spec 7.4, "Детектор D3"). */
export const D3_K = 1.0;
export const D3_EARLY_INTERVAL = 0.6;
export const D3_HIGH_START_A = 0.25;
export const D3_START_V_MED_Q = 0.35;
export const D3_START_POINTS = 3;

/** Hold wait H = W = 1.5 s, counted in samples from nSilent (spec 4.2, 6.4). */
export const HOLD_WAIT_MS = 1_500;
export const HOLD_WAIT_SAMPLES = 72_000;
/** Linear fade of 384 samples (8 ms): nSilent = nCmd + 384 (spec 6.2, 6.3). */
export const RAMP_SAMPLES = 384;

/** Three cued deep breaths set the sign s (spec 7.4); medians over 0.5 s around each cue edge. */
export const POLARITY_BREATHS = 3;
export const POLARITY_WINDOW_MS = 500;
/** Margin: the smallest |d| is at least a third of the largest (spec 7.4). */
export const POLARITY_MARGIN_RATIO = 1 / 3;

export interface D3Params {
  /** v >= med_q + k * s_q on an early breath. */
  k: number;
  /** Early: since the previous breath start <= 0.6 median start interval. */
  early_interval: number;
  /** Early: started >= 0.25 A above the median trough level. */
  high_start_A: number;
  /** Breath start: v >= 0.35 med_q ... */
  start_v: number;
  /** ... on 3 grid points in a row. */
  start_points: number;
}

/**
 * The "d1" block of params/frozen.json (spec 8.4). Keys shown in the 8.4 example keep their names;
 * the rest of the 7.4 table uses the same snake_case style.
 */
export interface D1Params {
  grid_hz: number;
  L: number;
  M: number;
  k: number;
  theta_clamp: readonly [number, number];
  min_rise_A: number;
  min_rise_ms: number;
  arm_breaths: number;
  refractory_ms: number;
  rearm_ms: number;
  gap_unusable_ms: number;
  gap_reset_ms: number;
  gap_inactive_ms: number;
  amp_window_ms: number;
  amp_max_age_ms: number;
  amp_min_ms: number;
  segment_step_A: number;
  memory_breaths: number;
  memory_entry_ms: number;
  invalid_codes: readonly number[];
  d3: D3Params;
}

/** The "hold" block of params/frozen.json (spec 8.4), used by the post-hoc stop model (spec 7.5). */
export interface HoldParams {
  H_ms: number;
  ramp_frames: number;
}

export const DEFAULT_D3_PARAMS: Readonly<D3Params> = Object.freeze({
  k: D3_K,
  early_interval: D3_EARLY_INTERVAL,
  high_start_A: D3_HIGH_START_A,
  start_v: D3_START_V_MED_Q,
  start_points: D3_START_POINTS,
});

export const DEFAULT_D1_PARAMS: Readonly<D1Params> = Object.freeze({
  grid_hz: GRID_HZ,
  L: SLOPE_WINDOW_L,
  M: CONSECUTIVE_M,
  k: K_PRELIMINARY,
  theta_clamp: THETA_CLAMP_MED_Q,
  min_rise_A: MIN_RISE_A,
  min_rise_ms: MIN_RISE_MS,
  arm_breaths: ARM_BREATHS,
  refractory_ms: REFRACTORY_MS,
  rearm_ms: REARM_MS,
  gap_unusable_ms: GAP_UNUSABLE_MS,
  gap_reset_ms: GAP_RESET_MS,
  gap_inactive_ms: GAP_INACTIVE_MS,
  amp_window_ms: AMP_WINDOW_MS,
  amp_max_age_ms: AMP_MAX_AGE_MS,
  amp_min_ms: AMP_MIN_MS,
  segment_step_A: SEGMENT_STEP_A,
  memory_breaths: MEMORY_BREATHS,
  memory_entry_ms: MEMORY_ENTRY_MS,
  invalid_codes: INVALID_VALIDATION_CODES,
  d3: DEFAULT_D3_PARAMS,
});

export const DEFAULT_HOLD_PARAMS: Readonly<HoldParams> = Object.freeze({
  H_ms: HOLD_WAIT_MS,
  ramp_frames: RAMP_SAMPLES,
});

export type D1ParamsInput = Partial<Omit<D1Params, 'd3'>> & { d3?: Partial<D3Params> };

/** Defaults overlaid with the given fields, then validated. */
export function resolveD1Params(input: D1ParamsInput = {}): D1Params {
  const p: D1Params = {
    ...DEFAULT_D1_PARAMS,
    ...input,
    d3: { ...DEFAULT_D3_PARAMS, ...(input.d3 ?? {}) },
  };
  validateD1Params(p);
  return p;
}

function req(cond: boolean, what: string): void {
  if (!cond) throw new Error(`invalid detector params: ${what}`);
}

const isPos = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x) && x > 0;
const isNonNeg = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x) && x >= 0;
const isInt = (x: unknown, min: number): x is number => typeof x === 'number' && Number.isInteger(x) && x >= min;

export function validateD1Params(p: D1Params): void {
  req(isPos(p.grid_hz), 'grid_hz > 0');
  req(isInt(p.L, 2), 'L integer >= 2');
  req(isInt(p.M, 1), 'M integer >= 1');
  req(isNonNeg(p.k), 'k >= 0');
  req(
    Array.isArray(p.theta_clamp) &&
      p.theta_clamp.length === 2 &&
      isPos(p.theta_clamp[0]) &&
      isPos(p.theta_clamp[1]) &&
      p.theta_clamp[0] <= p.theta_clamp[1],
    'theta_clamp [lo, hi] with 0 < lo <= hi',
  );
  req(isNonNeg(p.min_rise_A), 'min_rise_A >= 0');
  req(isNonNeg(p.min_rise_ms), 'min_rise_ms >= 0');
  req(isInt(p.arm_breaths, 0), 'arm_breaths integer >= 0');
  for (const key of [
    'refractory_ms',
    'rearm_ms',
    'gap_inactive_ms',
    'memory_entry_ms',
  ] as const) {
    req(isNonNeg(p[key]), `${key} >= 0`);
  }
  for (const key of ['gap_unusable_ms', 'gap_reset_ms', 'amp_window_ms', 'amp_max_age_ms', 'amp_min_ms'] as const) {
    req(isPos(p[key]), `${key} > 0`);
  }
  req(p.gap_unusable_ms <= p.gap_reset_ms, 'gap_unusable_ms <= gap_reset_ms');
  req(p.amp_min_ms <= p.amp_window_ms, 'amp_min_ms <= amp_window_ms');
  req(isPos(p.segment_step_A), 'segment_step_A > 0');
  req(isInt(p.memory_breaths, 1), 'memory_breaths integer >= 1');
  req(Array.isArray(p.invalid_codes) && p.invalid_codes.every((c) => Number.isInteger(c)), 'invalid_codes integers');
  req(isNonNeg(p.d3.k), 'd3.k >= 0');
  req(isPos(p.d3.early_interval), 'd3.early_interval > 0');
  req(isNonNeg(p.d3.high_start_A), 'd3.high_start_A >= 0');
  req(isPos(p.d3.start_v), 'd3.start_v > 0');
  req(isInt(p.d3.start_points, 1), 'd3.start_points integer >= 1');
}

function pickNumbers<T extends object>(src: Record<string, unknown>, keys: readonly (keyof T & string)[]): Partial<T> {
  const out: Record<string, unknown> = {};
  for (const key of keys) {
    const v = src[key];
    if (v === undefined || v === null) continue;
    if (typeof v !== 'number') throw new Error(`invalid detector params: ${key} must be a number`);
    out[key] = v;
  }
  return out as Partial<T>;
}

const D1_NUMBER_KEYS = [
  'grid_hz',
  'L',
  'M',
  'k',
  'min_rise_A',
  'min_rise_ms',
  'arm_breaths',
  'refractory_ms',
  'rearm_ms',
  'gap_unusable_ms',
  'gap_reset_ms',
  'gap_inactive_ms',
  'amp_window_ms',
  'amp_max_age_ms',
  'amp_min_ms',
  'segment_step_A',
  'memory_breaths',
  'memory_entry_ms',
] as const satisfies readonly (keyof D1Params)[];

const D3_NUMBER_KEYS = ['k', 'early_interval', 'high_start_A', 'start_v', 'start_points'] as const satisfies readonly (keyof D3Params)[];

function isRecord(x: unknown): x is Record<string, unknown> {
  return typeof x === 'object' && x !== null && !Array.isArray(x);
}

/**
 * Detector params from a parsed params/frozen.json object (spec 8.4). Missing fields take the
 * spec defaults; a missing k (the gate-prereg file has none) takes K_PRELIMINARY.
 */
export function d1ParamsFromFrozen(frozen: unknown): D1Params {
  const d1 = isRecord(frozen) && isRecord(frozen['d1']) ? frozen['d1'] : {};
  const input: D1ParamsInput = pickNumbers<D1Params>(d1, D1_NUMBER_KEYS);
  const clamp = d1['theta_clamp'];
  if (clamp !== undefined) {
    if (!Array.isArray(clamp) || clamp.length !== 2 || !clamp.every((x) => typeof x === 'number')) {
      throw new Error('invalid detector params: theta_clamp must be [lo, hi]');
    }
    input.theta_clamp = [clamp[0] as number, clamp[1] as number];
  }
  const codes = d1['invalid_codes'];
  if (codes !== undefined) {
    if (!Array.isArray(codes) || !codes.every((x) => typeof x === 'number')) {
      throw new Error('invalid detector params: invalid_codes must be numbers');
    }
    input.invalid_codes = codes as number[];
  }
  if (isRecord(d1['d3'])) input.d3 = pickNumbers<D3Params>(d1['d3'], D3_NUMBER_KEYS);
  return resolveD1Params(input);
}

/** Hold params from a parsed params/frozen.json object (spec 8.4 "hold"); defaults when absent. */
export function holdParamsFromFrozen(frozen: unknown): HoldParams {
  const hold = isRecord(frozen) && isRecord(frozen['hold']) ? frozen['hold'] : {};
  const p: HoldParams = { ...DEFAULT_HOLD_PARAMS, ...pickNumbers<HoldParams>(hold, ['H_ms', 'ramp_frames']) };
  req(isNonNeg(p.H_ms), 'hold.H_ms >= 0');
  req(isInt(p.ramp_frames, 0), 'hold.ramp_frames integer >= 0');
  return p;
}

/** Milliseconds to whole grid steps (all D1 timing is on the grid, spec 7.4). */
export function msToGridSteps(ms: number, gridHz: number): number {
  return Math.round((ms * gridHz) / 1000);
}

/** Milliseconds to whole audio samples at 48 kHz. */
export function msToSamples(ms: number, sampleRateHz: number = SAMPLE_RATE_HZ): number {
  return Math.round((ms * sampleRateHz) / 1000);
}
