// Binomial distribution, the exact one-sided binomial test (H1, spec 4.4 and 7.10)
// and the one-sided sign test (H3 and H4, spec 4.4 and 7.10).
//
// Method: tails are direct sums of the probability mass function. Each term is
// exp(ln C(n, k) + k ln p + (n - k) ln(1 - p)); C(n, k) is a running product for
// n <= 1000 and comes from logGamma beyond. At p = 1/2 (the sign test) a term is
// C(n, k) * 2^-n; for n <= 53 every term and every partial sum is a multiple of 2^-n
// below 1 that fits in 53 bits, so sign-test p-values are exact dyadic fractions (beyond
// that, within a few ulps). Both tails are summed over their own range, so neither is
// computed as 1 minus the other (no cancellation in small p-values).

import { logGamma } from './special.ts';
import { assertCount, assertOpenUnit, assertProbability } from './validate.ts';

const EXACT_PRODUCT_MAX_N = 1000;

function checkIntegerK(k: number, name: string): void {
  if (!Number.isSafeInteger(k)) throw new RangeError(`${name} must be an integer, got ${String(k)}`);
}

function checkCoefficientArgs(n: number, k: number): void {
  assertCount(n, 'n');
  assertCount(k, 'k');
  if (k > n) throw new RangeError(`k must be <= n, got k=${k}, n=${n}`);
}

// C(n, k) as a running product; C(n - m + i, i) is an integer at every step.
function coefficientByProduct(n: number, k: number): number {
  const m = Math.min(k, n - k);
  let c = 1;
  for (let i = 1; i <= m; i++) c = (c * (n - m + i)) / i;
  return c;
}

/** ln C(n, k) for integers 0 <= k <= n. */
export function logBinomialCoefficient(n: number, k: number): number {
  checkCoefficientArgs(n, k);
  const m = Math.min(k, n - k);
  if (m === 0) return 0;
  if (n <= EXACT_PRODUCT_MAX_N) return Math.log(coefficientByProduct(n, k));
  return logGamma(n + 1) - logGamma(m + 1) - logGamma(n - m + 1);
}

/** P(X = k) for X ~ Binomial(n, p). */
export function binomialPmf(k: number, n: number, p: number): number {
  assertCount(n, 'n');
  checkIntegerK(k, 'k');
  assertProbability(p, 'p');
  if (k < 0 || k > n) return 0;
  if (p === 0) return k === 0 ? 1 : 0;
  if (p === 1) return k === n ? 1 : 0;
  if (p === 0.5 && n <= EXACT_PRODUCT_MAX_N) return coefficientByProduct(n, k) * Math.pow(2, -n);
  return Math.exp(logBinomialCoefficient(n, k) + k * Math.log(p) + (n - k) * Math.log1p(-p));
}

function sumPmf(from: number, to: number, n: number, p: number): number {
  let sum = 0;
  for (let j = to; j >= from; j--) sum += binomialPmf(j, n, p);
  return sum > 1 ? 1 : sum;
}

/** P(X <= k) for X ~ Binomial(n, p). */
export function binomialCdf(k: number, n: number, p: number): number {
  assertCount(n, 'n');
  checkIntegerK(k, 'k');
  assertProbability(p, 'p');
  if (k < 0) return 0;
  if (k >= n) return 1;
  return sumPmf(0, k, n, p);
}

/** P(X >= k) for X ~ Binomial(n, p). */
export function binomialUpperTail(k: number, n: number, p: number): number {
  assertCount(n, 'n');
  checkIntegerK(k, 'k');
  assertProbability(p, 'p');
  if (k <= 0) return 1;
  if (k > n) return 0;
  return sumPmf(k, n, n, p);
}

/**
 * Exact one-sided binomial test against the chance level p0 (spec 4.4, H1):
 * p-value = P(X >= successes) for X ~ Binomial(trials, p0).
 * With 0 trials the tail is P(X >= 0) = 1: no evidence.
 */
export function binomialTestGreaterPValue(successes: number, trials: number, p0: number): number {
  assertCount(successes, 'successes');
  assertCount(trials, 'trials');
  if (successes > trials) throw new RangeError(`successes (${successes}) > trials (${trials})`);
  assertProbability(p0, 'p0');
  return binomialUpperTail(successes, trials, p0);
}

/**
 * Smallest success count that the one-sided exact test calls significant (p-value <= alpha),
 * or null when even trials of trials is not enough.
 * Spec 7.10: 14 events and p0 = 4.9% need 3.
 */
export function minSuccessesForSignificance(trials: number, p0: number, alpha = 0.05): number | null {
  assertCount(trials, 'trials');
  assertProbability(p0, 'p0');
  assertOpenUnit(alpha, 'alpha');
  for (let k = 0; k <= trials; k++) {
    if (binomialUpperTail(k, trials, p0) <= alpha) return k;
  }
  return null;
}

/**
 * Power of the exact one-sided binomial test: P(X >= k*) for X ~ Binomial(trials, trueRate),
 * where k* is the smallest count significant at alpha against p0. 0 when no count is.
 */
export function binomialTestPower(trials: number, p0: number, trueRate: number, alpha = 0.05): number {
  assertProbability(trueRate, 'trueRate');
  const k = minSuccessesForSignificance(trials, p0, alpha);
  return k === null ? 0 : binomialUpperTail(k, trials, trueRate);
}

/** Outcome of a one-sided sign test; ties are left out of the test and only reported. */
export interface SignTestResult {
  wins: number;
  losses: number;
  ties: number;
  /**
   * All pairs, ties included: wins + losses + ties. This is the `n` of results.json
   * `paired.*` (spec 8.6: n 17 = 7 wins + 4 losses + 6 ties, one pair per matched objection).
   */
  nPairs: number;
  /** Pairs that enter the test: wins + losses (spec 7.10, ties stay out). */
  nUntied: number;
  /** P(W >= wins) for W ~ Binomial(nUntied, 1/2); 1 when nUntied = 0. */
  pValue: number;
}

/**
 * One-sided sign test: does the chest win more often than chance? (spec 4.4, H3 and H4).
 * Ties do not enter the test (spec 7.10); their count is carried through for printing.
 */
export function signTest(wins: number, losses: number, ties = 0): SignTestResult {
  assertCount(wins, 'wins');
  assertCount(losses, 'losses');
  assertCount(ties, 'ties');
  const nUntied = wins + losses;
  return {
    wins,
    losses,
    ties,
    nPairs: nUntied + ties,
    nUntied,
    pValue: binomialUpperTail(wins, nUntied, 0.5),
  };
}

/**
 * Smallest number of wins out of `pairs` untied pairs that the one-sided sign test
 * calls significant at alpha, or null if none. Spec 7.10: 20 pairs need 15.
 */
export function signTestMinWins(pairs: number, alpha = 0.05): number | null {
  return minSuccessesForSignificance(pairs, 0.5, alpha);
}

/**
 * Power of the one-sided sign test on `pairs` untied pairs when the chest wins each pair
 * with probability `winRate`. Spec 4.4: with 20 pairs the test sees the difference only
 * if the chest is earlier in about 80% of pairs (P(Bin(20, 0.8) >= 15) = 0.804).
 */
export function signTestPower(pairs: number, winRate: number, alpha = 0.05): number {
  return binomialTestPower(pairs, 0.5, winRate, alpha);
}
