// Small numeric helpers for the detector. Pure and deterministic.

/** Median of a non-empty list; the mean of the two middle values for an even count. */
export function median(values: readonly number[]): number {
  if (values.length === 0) throw new Error('median of an empty list');
  const s = [...values].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 === 1 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}

/** Median absolute deviation from the median (unscaled). */
export function mad(values: readonly number[], center: number = median(values)): number {
  return median(values.map((x) => Math.abs(x - center)));
}

/**
 * Percentile of the first `count` entries of an ascending array, linear interpolation between
 * order statistics (the common "type 7" definition). p in [0, 1].
 */
export function percentileSorted(sorted: ArrayLike<number>, count: number, p: number): number {
  if (count <= 0) throw new Error('percentile of an empty list');
  const h = (count - 1) * p;
  const lo = Math.floor(h);
  const hi = Math.min(lo + 1, count - 1);
  const a = sorted[lo]!;
  const b = sorted[hi]!;
  return a + (h - lo) * (b - a);
}

/** First index in sorted[0..count) whose value is > x. */
function upperBound(sorted: ArrayLike<number>, count: number, x: number): number {
  let lo = 0;
  let hi = count;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (sorted[mid]! <= x) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** First index in sorted[0..count) whose value is >= x. */
function lowerBound(sorted: ArrayLike<number>, count: number, x: number): number {
  let lo = 0;
  let hi = count;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (sorted[mid]! < x) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** Inserts x into ascending sorted[0..count); the array must have room for count + 1. */
export function insertSorted(sorted: Float64Array, count: number, x: number): void {
  const pos = upperBound(sorted, count, x);
  sorted.copyWithin(pos + 1, pos, count);
  sorted[pos] = x;
}

/** Removes one entry equal to x from ascending sorted[0..count). Returns false if absent. */
export function removeSorted(sorted: Float64Array, count: number, x: number): boolean {
  const pos = lowerBound(sorted, count, x);
  if (pos >= count || sorted[pos] !== x) return false;
  sorted.copyWithin(pos, pos + 1, count);
  return true;
}

/**
 * Least-squares slope weights for `points` equally spaced samples at `rateHz`: the slope (per
 * second) of the last `points` values x[0..points) is sum(w[j] * x[j]).
 */
export function lsSlopeWeights(points: number, rateHz: number): Float64Array {
  const w = new Float64Array(points);
  const mid = (points - 1) / 2;
  let ss = 0;
  for (let j = 0; j < points; j++) ss += (j - mid) * (j - mid);
  for (let j = 0; j < points; j++) w[j] = ((j - mid) * rateHz) / ss;
  return w;
}

/** Largest grid index i with i / rateHz seconds <= relUs microseconds (exact for integer relUs). */
export function gridIndexAtOrBefore(relUs: number, rateHz: number): number {
  const scaled = relUs * rateHz;
  let i = Math.floor(scaled / 1e6);
  while ((i + 1) * 1e6 <= scaled) i++;
  while (i * 1e6 > scaled) i--;
  return i;
}

/** Smallest grid index i with i / rateHz seconds >= relUs microseconds (exact for integer relUs). */
export function gridIndexAtOrAfter(relUs: number, rateHz: number): number {
  const i = gridIndexAtOrBefore(relUs, rateHz);
  return i * 1e6 === relUs * rateHz ? i : i + 1;
}

/** Grid time of index i, microseconds after the grid origin. */
export function gridOffsetUs(i: number, rateHz: number): number {
  return (i * 1e6) / rateHz;
}

/** Deterministic PRNG (mulberry32) for tests and simulations; core code never calls Math.random. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Standard normal draw from a uniform PRNG (Box-Muller). */
export function gaussian(rng: () => number): number {
  let u = rng();
  while (u <= 0) u = rng();
  const v = rng();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}
