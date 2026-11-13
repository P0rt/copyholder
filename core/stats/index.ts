// core/stats: statistics for the gate verdict, the session numbers and the article
// (spec 4.3, 4.4, 7.10, 9.6, 9.9). Pure functions, no I/O, no dependencies.

export {
  logGamma,
  regularizedGammaP,
  regularizedGammaQ,
  gammaQuantile,
  chiSquareQuantile,
  chiSquareCdf,
  erf,
  erfc,
  normalCdf,
  normalQuantile,
} from './special.ts';

export {
  logBinomialCoefficient,
  binomialPmf,
  binomialCdf,
  binomialUpperTail,
  binomialTestGreaterPValue,
  binomialTestPower,
  minSuccessesForSignificance,
  signTest,
  signTestMinWins,
  signTestPower,
} from './binomial.ts';
export type { SignTestResult } from './binomial.ts';

export { wilsonInterval } from './proportion.ts';
export type { ProportionInterval } from './proportion.ts';

export {
  CHANCE_WINDOW_MS,
  poissonMeanUpperBound,
  poissonMeanLowerBound,
  ratePerMin,
  poissonRateUpperBoundPerMin,
  poissonRateLowerBoundPerMin,
  chanceLevelFromRatePerMin,
  poissonChanceLevel,
} from './poisson.ts';
export type { PoissonChanceLevel } from './poisson.ts';

export {
  MAD_TO_SIGMA,
  median,
  medianOfSorted,
  quantile,
  quantileOfSorted,
  medianAbsoluteDeviation,
  robustSpread,
  medianIntervalRanks,
  medianWithInterval,
} from './descriptive.ts';
export type { MedianRanks, MedianWithInterval } from './descriptive.ts';

export { holmAdjustedPValues, holmRejects } from './holm.ts';

export {
  GATE_HITS_THRESHOLDS,
  GATE_FORECAST_VALID_OBJECTIONS,
  NARROW_RATE_RANGE,
  classifyCount,
  countRuleProbabilities,
  countRuleProbabilitiesOverRates,
  integralOfUpperTail,
} from './forecast.ts';
export type { GateWord, CountThresholds, GateWordProbabilities } from './forecast.ts';

export { createSeededRng } from './rng.ts';
export type { Rng } from './rng.ts';

export { normalizeIntervalsMs, isSpanCoveredMs } from './intervals.ts';
export type { IntervalMs } from './intervals.ts';

export {
  CIRCULAR_SHIFT_COUNT,
  CIRCULAR_SHIFT_SEED,
  SHIFT_CUT_BEFORE_ONSET_MS,
  buildShiftSession,
  hasStopInWindowBefore,
  compareShiftSessions,
  circularShiftChanceLevel,
  circleCoverage,
  circularShiftExpectedShare,
} from './shift.ts';
export type { ShiftSession, ShiftTimelineInput, CircularShiftOptions, CircularShiftResult } from './shift.ts';

export { armedCheckEndMs, isWindowArmed } from './armed.ts';
export type { ChestFireMs } from './armed.ts';

export { CATCH_CLOSE_AFTER_SPAN_END_MS, pseudoOnsetPoints, pseudoOnsetChanceLevel } from './pseudo.ts';
export type {
  PseudoOnsetSession,
  PseudoOnsetOptions,
  PseudoOnsetOutcome,
  PseudoOnsetPoint,
  PseudoOnsetResult,
} from './pseudo.ts';

export { largestChanceLevel } from './chance.ts';
export type { ChanceEstimates, ChanceLevelChoice } from './chance.ts';
