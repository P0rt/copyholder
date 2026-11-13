// Special functions behind the interval and test code of core/stats.
// Pure TypeScript, no dependencies, deterministic for a given JS engine.
//
// Methods:
// - logGamma: Lanczos approximation, g = 7, 9 coefficients (relative error ~1e-15),
//   reflection formula below 0.5, series -ln x - gamma x below 1e-8 (finite down to
//   the smallest subnormal).
// - regularizedGammaP / Q: power series for x < a + 1, continued fraction
//   (modified Lentz) otherwise (Numerical Recipes, 3rd ed., section 6.2).
// - gammaQuantile: Halley iteration on P(a, x) = p from the Numerical Recipes
//   initial guess (Wilson-Hilferty for a > 1), kept inside a bracket with a bisection
//   fallback, so it always converges.
// - normalQuantile: Wichura (1988), algorithm AS 241 (PPND16), relative error ~1e-16.

import { assertFiniteNumber, assertProbability } from './validate.ts';

const LANCZOS_G = 7;
const LANCZOS_COEFFICIENTS = [
  0.99999999999980993, 676.5203681218851, -1259.1392167224028, 771.32342877765313,
  -176.61502916214059, 12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6,
  1.5056327351493116e-7,
] as const;
const HALF_LOG_TWO_PI = 0.91893853320467274178; // 0.5 * ln(2 pi)

const MAX_SERIES_TERMS = 100_000;
const SERIES_EPS = Number.EPSILON;
const TINY = 1e-300;

const EULER_GAMMA = 0.57721566490153286061;
// Below this, ln Gamma(x) = -ln x - gamma x to double precision (next term pi^2 x^2 / 12),
// and the reflection formula would overflow: pi / sin(pi x) is Infinity for x < ~6e-309.
const TINY_X_SERIES_MAX = 1e-8;

/** Natural log of the gamma function for x > 0. */
export function logGamma(x: number): number {
  assertFiniteNumber(x, 'x');
  if (x <= 0) throw new RangeError(`logGamma needs x > 0, got ${x}`);
  if (x < TINY_X_SERIES_MAX) return -Math.log(x) - EULER_GAMMA * x;
  if (x < 0.5) {
    // Reflection: Gamma(x) Gamma(1 - x) = pi / sin(pi x)
    return Math.log(Math.PI / Math.sin(Math.PI * x)) - logGamma(1 - x);
  }
  const z = x - 1;
  let a = LANCZOS_COEFFICIENTS[0];
  for (let i = 1; i < LANCZOS_COEFFICIENTS.length; i++) {
    a += (LANCZOS_COEFFICIENTS[i] as number) / (z + i);
  }
  const t = z + LANCZOS_G + 0.5;
  return HALF_LOG_TWO_PI + (z + 0.5) * Math.log(t) - t + Math.log(a);
}

/** Both regularized incomplete gamma tails, one computed directly, the other as its complement. */
interface GammaTails {
  lower: number; // P(a, x)
  upper: number; // Q(a, x) = 1 - P(a, x)
}

function checkGammaArgs(a: number, x: number): void {
  assertFiniteNumber(a, 'a');
  if (a <= 0) throw new RangeError(`shape a must be > 0, got ${a}`);
  if (Number.isNaN(x)) throw new RangeError('x is NaN');
  if (x < 0) throw new RangeError(`x must be >= 0, got ${x}`);
}

// exp(-x + a ln x - lnGamma(a)): the common prefactor of both expansions.
function gammaPrefactor(a: number, x: number): number {
  return Math.exp(-x + a * Math.log(x) - logGamma(a));
}

function lowerBySeries(a: number, x: number): number {
  let ap = a;
  let del = 1 / a;
  let sum = del;
  for (let n = 1; n <= MAX_SERIES_TERMS; n++) {
    ap += 1;
    del *= x / ap;
    sum += del;
    if (Math.abs(del) < Math.abs(sum) * SERIES_EPS) {
      return sum * gammaPrefactor(a, x);
    }
  }
  throw new RangeError(`incomplete gamma series did not converge for a=${a}, x=${x}`);
}

function upperByContinuedFraction(a: number, x: number): number {
  // Modified Lentz evaluation of the continued fraction for Q(a, x).
  let b = x + 1 - a;
  let c = 1 / TINY;
  let d = 1 / b;
  let h = d;
  for (let i = 1; i <= MAX_SERIES_TERMS; i++) {
    const an = -i * (i - a);
    b += 2;
    d = an * d + b;
    if (Math.abs(d) < TINY) d = TINY;
    c = b + an / c;
    if (Math.abs(c) < TINY) c = TINY;
    d = 1 / d;
    const del = d * c;
    h *= del;
    if (Math.abs(del - 1) < SERIES_EPS) {
      return gammaPrefactor(a, x) * h;
    }
  }
  throw new RangeError(`incomplete gamma continued fraction did not converge for a=${a}, x=${x}`);
}

function gammaTails(a: number, x: number): GammaTails {
  checkGammaArgs(a, x);
  if (x === 0) return { lower: 0, upper: 1 };
  if (x === Infinity) return { lower: 1, upper: 0 };
  if (x < a + 1) {
    const lower = clampUnit(lowerBySeries(a, x));
    return { lower, upper: 1 - lower };
  }
  const upper = clampUnit(upperByContinuedFraction(a, x));
  return { lower: 1 - upper, upper };
}

function clampUnit(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

/** Regularized lower incomplete gamma P(a, x) = gamma(a, x) / Gamma(a). */
export function regularizedGammaP(a: number, x: number): number {
  return gammaTails(a, x).lower;
}

/** Regularized upper incomplete gamma Q(a, x) = 1 - P(a, x), computed without cancellation in its own tail. */
export function regularizedGammaQ(a: number, x: number): number {
  return gammaTails(a, x).upper;
}

/** Density of the standard gamma distribution with shape a (scale 1). */
function gammaDensity(a: number, x: number): number {
  if (x <= 0) return 0;
  return Math.exp(-x + (a - 1) * Math.log(x) - logGamma(a));
}

/**
 * Quantile of the standard gamma distribution (scale 1): the x with P(shape, x) = p.
 * Returns 0 for p = 0 and Infinity for p = 1.
 */
export function gammaQuantile(p: number, shape: number): number {
  assertProbability(p, 'p');
  assertFiniteNumber(shape, 'shape');
  if (shape <= 0) throw new RangeError(`shape must be > 0, got ${shape}`);
  if (p === 0) return 0;
  if (p === 1) return Infinity;

  const useUpper = p > 0.5;
  const q = 1 - p;
  // f(x) = P(a, x) - p, evaluated in whichever tail is smaller for accuracy.
  const f = (x: number): number => {
    const t = gammaTails(shape, x);
    return useUpper ? q - t.upper : t.lower - p;
  };

  let x = initialGammaQuantileGuess(p, shape);
  let lo = 0;
  let hi = Infinity;

  for (let iter = 0; iter < 100; iter++) {
    const err = f(x);
    if (err === 0) return x;
    if (err < 0) lo = x;
    else hi = x;

    const density = gammaDensity(shape, x);
    let next = NaN;
    if (density > 0 && Number.isFinite(density)) {
      const u = err / density;
      // Halley correction: f''/f' = (a - 1)/x - 1 for the gamma density.
      const step = u / (1 - 0.5 * Math.min(1, u * ((shape - 1) / x - 1)));
      next = x - step;
    }
    if (!(next > lo && next < hi)) {
      next = Number.isFinite(hi) ? 0.5 * (lo + hi) : Math.max(2 * x, x + 1);
    }
    if (Math.abs(next - x) <= 4 * Number.EPSILON * Math.max(next, TINY)) return next;
    x = next;
  }

  // Halley did not settle: finish by bisection inside the bracket.
  if (!Number.isFinite(hi)) {
    hi = Math.max(1, 2 * x);
    while (f(hi) < 0) hi *= 2;
  }
  for (let iter = 0; iter < 2000; iter++) {
    const mid = 0.5 * (lo + hi);
    if (mid <= lo || mid >= hi) return mid;
    if (f(mid) < 0) lo = mid;
    else hi = mid;
  }
  return 0.5 * (lo + hi);
}

// Initial guess from Numerical Recipes (3rd ed.), invgammp.
function initialGammaQuantileGuess(p: number, a: number): number {
  if (a > 1) {
    const pp = p < 0.5 ? p : 1 - p;
    const t = Math.sqrt(-2 * Math.log(pp));
    // w approximates -z_p, the negated normal quantile (Abramowitz and Stegun 26.2.22).
    let w = (2.30753 + t * 0.27061) / (1 + t * (0.99229 + t * 0.04481)) - t;
    if (p < 0.5) w = -w;
    // Wilson-Hilferty cube approximation.
    return Math.max(1e-3, a * Math.pow(1 - 1 / (9 * a) - w / (3 * Math.sqrt(a)), 3));
  }
  const t = 1 - a * (0.253 + a * 0.12);
  if (p < t) return Math.pow(p / t, 1 / a);
  return 1 - Math.log(1 - (p - t) / (1 - t));
}

/** Quantile of the chi-square distribution with df degrees of freedom: 2 * gammaQuantile(p, df / 2). */
export function chiSquareQuantile(p: number, df: number): number {
  assertFiniteNumber(df, 'df');
  if (df <= 0) throw new RangeError(`df must be > 0, got ${df}`);
  return 2 * gammaQuantile(p, df / 2);
}

/** CDF of the chi-square distribution: P(df / 2, x / 2). */
export function chiSquareCdf(x: number, df: number): number {
  assertFiniteNumber(df, 'df');
  if (df <= 0) throw new RangeError(`df must be > 0, got ${df}`);
  if (Number.isNaN(x)) throw new RangeError('x is NaN');
  if (x <= 0) return 0;
  return regularizedGammaP(df / 2, x / 2);
}

/** Error function, via erf(x) = sign(x) P(1/2, x^2). */
export function erf(x: number): number {
  if (Number.isNaN(x)) throw new RangeError('x is NaN');
  const v = regularizedGammaP(0.5, x * x);
  return x < 0 ? -v : v;
}

/** Complementary error function, accurate in the upper tail: erfc(x) = Q(1/2, x^2) for x >= 0. */
export function erfc(x: number): number {
  if (Number.isNaN(x)) throw new RangeError('x is NaN');
  if (x >= 0) return regularizedGammaQ(0.5, x * x);
  return 1 + regularizedGammaP(0.5, x * x);
}

/** Standard normal CDF. */
export function normalCdf(z: number): number {
  return 0.5 * erfc(-z / Math.SQRT2);
}

// AS 241 (PPND16) coefficients, Wichura (1988).
const AS241_A = [
  3.387132872796366608, 133.14166789178437745, 1971.5909503065514427, 13731.693765509461125,
  45921.953931549871457, 67265.770927008700853, 33430.575583588128105, 2509.0809287301226727,
] as const;
const AS241_B = [
  1, 42.313330701600911252, 687.1870074920579083, 5394.1960214247511077, 21213.794301586595867,
  39307.89580009271061, 28729.085735721942674, 5226.495278852854561,
] as const;
const AS241_C = [
  1.42343711074968357734, 4.6303378461565452959, 5.7694972214606914055, 3.64784832476320460504,
  1.27045825245236838258, 0.24178072517745061177, 0.0227238449892691845833, 7.7454501427834140764e-4,
] as const;
const AS241_D = [
  1, 2.05319162663775882187, 1.6763848301838038494, 0.68976733498510000455, 0.14810397642748007459,
  0.0151986665636164571966, 5.475938084995344946e-4, 1.05075007164441684324e-9,
] as const;
const AS241_E = [
  6.6579046435011037772, 5.4637849111641143699, 1.7848265399172913358, 0.29656057182850489123,
  0.026532189526576123093, 0.0012426609473880784386, 2.71155556874348757815e-5,
  2.01033439929228813265e-7,
] as const;
const AS241_F = [
  1, 0.59983220655588793769, 0.13692988092273580531, 0.0148753612908506148525,
  7.868691311456132591e-4, 1.8463183175100546818e-5, 1.4215117583164458887e-7,
  2.04426310338993978564e-15,
] as const;

function polynomial(coefficients: readonly number[], r: number): number {
  let acc = 0;
  for (let i = coefficients.length - 1; i >= 0; i--) {
    acc = acc * r + (coefficients[i] as number);
  }
  return acc;
}

/** Quantile of the standard normal distribution (AS 241). -Infinity at 0, Infinity at 1. */
export function normalQuantile(p: number): number {
  assertProbability(p, 'p');
  if (p === 0) return -Infinity;
  if (p === 1) return Infinity;
  const q = p - 0.5;
  if (Math.abs(q) <= 0.425) {
    const r = 0.180625 - q * q;
    return (q * polynomial(AS241_A, r)) / polynomial(AS241_B, r);
  }
  let r = Math.sqrt(-Math.log(q < 0 ? p : 1 - p));
  let x: number;
  if (r <= 5) {
    r -= 1.6;
    x = polynomial(AS241_C, r) / polynomial(AS241_D, r);
  } else {
    r -= 5;
    x = polynomial(AS241_E, r) / polynomial(AS241_F, r);
  }
  return q < 0 ? -x : x;
}
