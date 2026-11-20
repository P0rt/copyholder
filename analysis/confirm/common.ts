// Shared constants and the refusal of npm run confirm: the pooled confirmation of PREREG.md
// section 11 (packs B and C), computed with the functions stage B of analyze:gate uses.

import path from 'node:path';
import { CIRCULAR_SHIFT_COUNT, CIRCULAR_SHIFT_SEED } from '../../core/stats/index.ts';
import { REPO_ROOT } from '../lib/paths.ts';

/** One-sided level of the H1 test and of H3 and H4 after Holm's correction (PREREG §9.1, §11). */
export const ALPHA = 0.05;
/** Level of every interval: Wilson, order statistics, Poisson (PREREG §9.1). */
export const CONFIDENCE = 0.95;
/** Sensitivity line of PREREG §5: all onsets this much earlier. */
export const EARLIER_MS = 25;
/** Sensitivity line of PREREG §3.2 and §5: an objection needs this much voiced sound. */
export const OBJECTION_400_MS = 400;
/** The separate count of PREREG §3.2: only leads under 300 ms. */
export const UNDER_MS = 300;
/** Circular shifts and their seed (PREREG §9.2 item 2), fixed in core/stats before any data. */
export const SHIFT_COUNT = CIRCULAR_SHIFT_COUNT;
export const SHIFT_SEED = CIRCULAR_SHIFT_SEED;
/** The paired-comparison margin of PREREG §6.5, as core/detector compares stops. */
export const WIN_MARGIN_MS = 33;

/** A refusal: npm run confirm prints the message and exits 1 without writing anything. */
export class ConfirmRefusal extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfirmRefusal';
  }
}

/** results/ of the repository, or COPYHOLDER_RESULTS_DIR when set (tests write to temporary folders). */
export function resultsDir(env: NodeJS.ProcessEnv = process.env): string {
  const v = env['COPYHOLDER_RESULTS_DIR'];
  return v ? path.resolve(v) : path.join(REPO_ROOT, 'results');
}

/** Rounds to `digits` decimals for confirm.json; null stays null. */
export function roundTo(x: number, digits: number): number {
  const f = 10 ** digits;
  return Math.round(x * f) / f;
}

export function roundOrNull(x: number | null, digits: number): number | null {
  return x === null ? null : roundTo(x, digits);
}
