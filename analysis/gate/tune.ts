// Stage A tuning on the listening block (spec 7.4 "Порядок настройки", 7.5 "Бюджет G", 9.5 step 4):
// k is the smallest grid value with at most 1.0 D1 fire per active minute, else 3.5 with
// "criterion not met"; theta_G is the smallest grid value whose G fires stay within the budget:
// the larger of the D1 count and the D1 active minutes, rounded down. Pure: inputs come sliced.

import { K_GRID, chooseK, type DetectorInput, type FrozenParamsLike, type KTrial, type Sign, type Variant } from '../../core/detector.ts';
import { THETA_G_GRID } from '../../core/schemas/index.ts';
import { lipBaselines, type SpanSamples } from '../rivals/index.ts';
import { activeMinutesIn, runD1, runG, stopsIn, withK, type RunSetup } from './runs.ts';

export interface GTrial {
  thetaG: number;
  fires: number;
  activeMinutes: number;
}

export interface StageATuning {
  k: number;
  criterionMet: boolean;
  kTrials: KTrial[];
  /** D1 at the chosen k in the listening block: the budget of G (spec 7.5). */
  d1Fires: number;
  d1ActiveMinutes: number;
  gLimit: number;
  thetaG: number;
  /** False when no grid value kept G within the budget and the largest was taken (assumption). */
  thetaGCriterionMet: boolean;
  gTrials: GTrial[];
}

export interface StageAInputs {
  /** detector_in.jsonl lines before the cut (view.ts detectorInBefore). */
  inputs: readonly DetectorInput[];
  /** nArr by seq from the stamps before the cut. */
  nArrBySeq: ReadonlyMap<number, number>;
  /** Packets that reset the baseline of G (rivals gResetSeqs on samples.jsonl before the cut). */
  resetSeqs: ReadonlySet<number>;
  /** The listening block [its mark, nCut). */
  listening: SpanSamples;
  /** params/frozen.json as before stage A (k and theta_G are tried here). */
  frozen: FrozenParamsLike;
  sign: Sign;
  variant?: Variant;
  /** G settings other than theta_G (frozen g block). */
  gFrames: number;
  gBaselineS: number;
  gResetWaitS: number;
  invalidCodes?: readonly number[];
}

/** Budget of G in the tuning block (spec 7.5): max(D1 fires, floor(D1 active minutes)). */
export function gBudget(d1Fires: number, d1ActiveMinutes: number): number {
  return Math.max(d1Fires, Math.floor(d1ActiveMinutes));
}

/** Stage A: k for D1, then theta_G for G, on the listening block only. */
export function tuneStageA(a: StageAInputs): StageATuning {
  const setup = (k: number): RunSetup => ({ frozen: withK(a.frozen, k), sign: a.sign, variant: a.variant ?? 'D1' });
  const runs = new Map<number, ReturnType<typeof runD1>>();
  const trials = K_GRID.map((k) => {
    const run = runD1(a.inputs, a.nArrBySeq, setup(k));
    runs.set(k, run);
    return { k, fires: stopsIn(run, a.listening).length, activeMinutes: activeMinutesIn(run, a.listening) };
  });
  const choice = chooseK(trials);
  const chosen = runs.get(choice.k)!;
  const d1Fires = stopsIn(chosen, a.listening).length;
  const d1ActiveMinutes = activeMinutesIn(chosen, a.listening);
  const gLimit = gBudget(d1Fires, d1ActiveMinutes);

  const points = lipBaselines(a.inputs, a.nArrBySeq, { baselineS: a.gBaselineS, resetWaitS: a.gResetWaitS, resetSeqs: a.resetSeqs });
  const gTrials: GTrial[] = [];
  let thetaG: number | null = null;
  for (const theta of [...THETA_G_GRID].sort((x, y) => x - y)) {
    const run = runG(a.inputs, a.nArrBySeq, setup(choice.k), {
      thetaG: theta,
      frames: a.gFrames,
      points,
      ...(a.invalidCodes ? { invalidCodes: a.invalidCodes } : {}),
    });
    const fires = stopsIn(run, a.listening).length;
    gTrials.push({ thetaG: theta, fires, activeMinutes: activeMinutesIn(run, a.listening) });
    if (fires <= gLimit) {
      thetaG = theta;
      break;
    }
  }
  const largest = THETA_G_GRID[THETA_G_GRID.length - 1]!;
  return {
    k: choice.k,
    criterionMet: choice.criterionMet,
    kTrials: choice.trials,
    d1Fires,
    d1ActiveMinutes,
    gLimit,
    thetaG: thetaG ?? largest,
    thetaGCriterionMet: thetaG !== null,
    gTrials,
  };
}
