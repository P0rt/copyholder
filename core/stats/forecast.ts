// Binomial model of the gate forecast (spec 9.9, quoted again in spec 4.6).
// Row 1 of the gate rules (spec 9.6) counts valid objections with a stop before the
// voice: >= 8 PASS, 5-7 BETWEEN, < 5 KILL, on 14 valid objections. With a true hit
// rate r the count is Binomial(14, r). Averaging "over a range of rates" is read as a
// uniform distribution of r on [low, high]; that reading reproduces the spec numbers
// (15-45%: 6/36/58%, 15-35%: 2/26/72%).
//
// Exact average, no quadrature: d/dp P(Bin(n + 1, p) >= j + 1) = (n + 1) P(Bin(n, p) = j), so
//   integral_a^b P(Bin(n, p) >= k) dp = sum_{j=k..n} [S(j + 1; b) - S(j + 1; a)] / (n + 1),
// where S(r; p) = P(Bin(n + 1, p) >= r). On ranges narrower than NARROW_RATE_RANGE that
// difference of tails, divided by the width, loses digits; Simpson's rule takes over there.

import { binomialUpperTail } from './binomial.ts';
import { assertCount, assertProbability } from './validate.ts';

/** Words of the gate verdict (spec 9.7). */
export type GateWord = 'PASS' | 'BETWEEN' | 'KILL';

/** A count rule: PASS at `passAtLeast` or more, KILL below `killBelow`, BETWEEN otherwise. */
export interface CountThresholds {
  passAtLeast: number;
  killBelow: number;
}

/** Spec 9.6, row 1: stops before the voice, absolute count. */
export const GATE_HITS_THRESHOLDS: Readonly<CountThresholds> = Object.freeze({ passAtLeast: 8, killBelow: 5 });

/** Spec 9.9: the forecast table assumes 14 valid objections. */
export const GATE_FORECAST_VALID_OBJECTIONS = 14;

function checkThresholds(t: CountThresholds): void {
  assertCount(t.passAtLeast, 'passAtLeast');
  assertCount(t.killBelow, 'killBelow');
  if (t.killBelow > t.passAtLeast) {
    throw new RangeError(`killBelow (${t.killBelow}) must be <= passAtLeast (${t.passAtLeast})`);
  }
}

/** Word for an observed count under a count rule. */
export function classifyCount(count: number, thresholds: CountThresholds = GATE_HITS_THRESHOLDS): GateWord {
  assertCount(count, 'count');
  checkThresholds(thresholds);
  if (count >= thresholds.passAtLeast) return 'PASS';
  if (count < thresholds.killBelow) return 'KILL';
  return 'BETWEEN';
}

export interface GateWordProbabilities {
  pass: number;
  between: number;
  kill: number;
}

/** Probability of each word when the count is Binomial(trials, trueRate). */
export function countRuleProbabilities(
  trials: number,
  trueRate: number,
  thresholds: CountThresholds = GATE_HITS_THRESHOLDS,
): GateWordProbabilities {
  assertCount(trials, 'trials');
  assertProbability(trueRate, 'trueRate');
  checkThresholds(thresholds);
  const atLeastPass = binomialUpperTail(thresholds.passAtLeast, trials, trueRate);
  const atLeastBetween = binomialUpperTail(thresholds.killBelow, trials, trueRate);
  return {
    pass: atLeastPass,
    between: Math.max(0, atLeastBetween - atLeastPass),
    kill: 1 - atLeastBetween,
  };
}

/** Integral over p in [a, b] of P(Bin(n, p) >= k), exact. */
export function integralOfUpperTail(k: number, n: number, a: number, b: number): number {
  assertCount(n, 'n');
  if (!Number.isSafeInteger(k)) throw new RangeError(`k must be an integer, got ${String(k)}`);
  assertProbability(a, 'a');
  assertProbability(b, 'b');
  if (b < a) throw new RangeError(`need a <= b, got a=${a}, b=${b}`);
  if (k <= 0) return b - a;
  if (k > n) return 0;
  let sum = 0;
  for (let j = k; j <= n; j++) {
    sum += binomialUpperTail(j + 1, n + 1, b) - binomialUpperTail(j + 1, n + 1, a);
  }
  return sum / (n + 1);
}

/**
 * Below this width of the rate range the closed form loses digits: it divides a difference
 * of tails (absolute error ~n^2 eps) by the width. Simpson's rule on three point values is
 * used instead: its error shrinks with the fourth power of the width.
 */
export const NARROW_RATE_RANGE = 1e-4;

/**
 * Probability of each word averaged over a true rate uniform on [rateLow, rateHigh]
 * (spec 4.6 and 9.9). A zero-width range gives the point probabilities.
 */
export function countRuleProbabilitiesOverRates(
  trials: number,
  rateLow: number,
  rateHigh: number,
  thresholds: CountThresholds = GATE_HITS_THRESHOLDS,
): GateWordProbabilities {
  assertCount(trials, 'trials');
  assertProbability(rateLow, 'rateLow');
  assertProbability(rateHigh, 'rateHigh');
  if (rateHigh < rateLow) throw new RangeError(`need rateLow <= rateHigh, got ${rateLow} > ${rateHigh}`);
  checkThresholds(thresholds);
  if (rateHigh === rateLow) return countRuleProbabilities(trials, rateLow, thresholds);
  const width = rateHigh - rateLow;
  if (width < NARROW_RATE_RANGE) return simpsonAverage(trials, rateLow, rateHigh, thresholds);
  const atLeastPass = integralOfUpperTail(thresholds.passAtLeast, trials, rateLow, rateHigh) / width;
  const atLeastBetween = integralOfUpperTail(thresholds.killBelow, trials, rateLow, rateHigh) / width;
  return wordsFromAverageTails(atLeastPass, atLeastBetween);
}

// Simpson's rule for a narrow range: the tails are polynomials in the rate, smooth on a
// scale of 1/n, so three point values give the average to rounding error.
function simpsonAverage(trials: number, a: number, b: number, t: CountThresholds): GateWordProbabilities {
  const mid = a + (b - a) / 2;
  const average = (k: number): number =>
    (binomialUpperTail(k, trials, a) + 4 * binomialUpperTail(k, trials, mid) + binomialUpperTail(k, trials, b)) / 6;
  return wordsFromAverageTails(average(t.passAtLeast), average(t.killBelow));
}

function wordsFromAverageTails(atLeastPass: number, atLeastBetween: number): GateWordProbabilities {
  const clamp = (v: number): number => Math.min(1, Math.max(0, v));
  return {
    pass: clamp(atLeastPass),
    between: clamp(atLeastBetween - atLeastPass),
    kill: clamp(1 - atLeastBetween),
  };
}
