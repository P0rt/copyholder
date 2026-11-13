// The chance level used by the H1 test, the receipt and the article is the largest of
// the three estimates of spec 4.3 (decided in advance). All three must be present:
// taking the largest of fewer would quietly change the rule.

import { assertProbability } from './validate.ts';

export interface ChanceEstimates {
  /** First estimate: Poisson formula with the upper rate bound (poissonChanceLevel). */
  poisson: number;
  /** Second estimate: mean share over circular shifts (circularShiftChanceLevel). */
  shift: number;
  /** Third estimate: pseudo onsets after sentence ends without an objection (pseudoOnsetChanceLevel). */
  pseudo: number;
}

export interface ChanceLevelChoice {
  p0: number;
  source: keyof ChanceEstimates;
}

/** Largest of the three chance-level estimates; ties go to the earlier one in spec order. */
export function largestChanceLevel(estimates: ChanceEstimates): ChanceLevelChoice {
  const order: (keyof ChanceEstimates)[] = ['poisson', 'shift', 'pseudo'];
  let best: ChanceLevelChoice | null = null;
  for (const source of order) {
    const p0 = estimates[source];
    assertProbability(p0, source);
    if (best === null || p0 > best.p0) best = { p0, source };
  }
  return best as ChanceLevelChoice;
}
