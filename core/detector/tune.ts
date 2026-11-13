// Tuning k (spec 7.4 "Порядок настройки", 9.5 step 4) and the k steps of the retune rules
// (spec 9.8, 10.2). Pure: the caller runs the detector, this module only applies the rules.

import type { FrozenParamsLike } from './d1.ts';
import { K_GRID, type D1ParamsInput } from './params.ts';
import { d1Posthoc, runPosthoc } from './posthoc.ts';
import type { DetectorInput, Sign, Variant } from './types.ts';

/** Stage A allows at most 1.0 fire per minute of active time on the listening block (spec 7.4). */
export const STAGE_A_MAX_FIRES_PER_MIN = 1.0;

export interface KTrial {
  k: number;
  fires: number;
  activeMinutes: number;
  /** Fires per active minute; null with no active time. */
  rate: number | null;
}

export interface KChoice {
  k: number;
  /** False when no k of the grid met the rule and the largest was taken ("criterion not met"). */
  criterionMet: boolean;
  trials: KTrial[];
}

/**
 * The smallest k with at most maxRate fires per active minute; if none, the largest k of the grid
 * with criterionMet false (spec 7.4 steps 3-4). A k without any active time does not meet the
 * rule: a rate cannot be shown for it (assumption).
 */
export function chooseK(
  trials: readonly { k: number; fires: number; activeMinutes: number }[],
  maxRate: number = STAGE_A_MAX_FIRES_PER_MIN,
  grid: readonly number[] = K_GRID,
): KChoice {
  const byK = new Map(trials.map((t) => [t.k, t]));
  const out: KTrial[] = [];
  for (const k of [...grid].sort((a, b) => a - b)) {
    const t = byK.get(k);
    if (t === undefined) throw new Error(`chooseK: no trial for k = ${k}`);
    out.push({ k, fires: t.fires, activeMinutes: t.activeMinutes, rate: t.activeMinutes > 0 ? t.fires / t.activeMinutes : null });
  }
  const met = out.find((t) => t.rate !== null && t.rate <= maxRate);
  if (met !== undefined) return { k: met.k, criterionMet: true, trials: out };
  return { k: out[out.length - 1]!.k, criterionMet: false, trials: out };
}

export interface StageAOptions {
  /** Arrival samples of the packets (stamps.jsonl "arr" lines). */
  nArrBySeq: ReadonlyMap<number, number>;
  sign: Sign;
  /** Fields other than k: the d1 block of params/frozen.json as written before stage A. */
  params?: D1ParamsInput | FrozenParamsLike;
  variant?: Variant;
  grid?: readonly number[];
}

/**
 * Stage A for D1: the same step() runs the recording up to 4:15 for every k of the grid, each
 * with its own stop model (spec 7.4, 7.5); only reading counts as active time, so only the
 * listening block contributes. Every fire there is false (spec 7.4 step 2).
 */
export function stageAChooseK(inputs: readonly DetectorInput[], opts: StageAOptions): KChoice {
  const grid = opts.grid ?? K_GRID;
  const base = opts.params ?? {};
  const trials = grid.map((k) => {
    const params = withK(base, k);
    const r = runPosthoc(inputs, { detector: d1Posthoc(params, opts.sign, opts.variant ?? 'D1'), nArrBySeq: opts.nArrBySeq });
    return { k, fires: r.fires.length, activeMinutes: r.activeMinutes };
  });
  return chooseK(trials, STAGE_A_MAX_FIRES_PER_MIN, grid);
}

function withK(params: D1ParamsInput | FrozenParamsLike, k: number): D1ParamsInput | FrozenParamsLike {
  const d1 = (params as { d1?: unknown }).d1;
  if (typeof d1 === 'object' && d1 !== null && !Array.isArray(d1)) {
    return { ...(params as FrozenParamsLike), d1: { ...(d1 as Record<string, unknown>), k } };
  }
  return { ...(params as D1ParamsInput), k };
}

/** The next k of the grid up (spec 9.8 row 3, 10.2), or null at the top. */
export function kStepUp(k: number, grid: readonly number[] = K_GRID): number | null {
  const up = [...grid].sort((a, b) => a - b).find((x) => x > k);
  return up ?? null;
}

/** The next k of the grid down (spec 9.8 ladder step 1), or null at the bottom. */
export function kStepDown(k: number, grid: readonly number[] = K_GRID): number | null {
  const down = [...grid].sort((a, b) => b - a).find((x) => x < k);
  return down ?? null;
}
