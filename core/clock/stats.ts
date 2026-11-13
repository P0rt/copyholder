// Small numeric helpers of the clock module. Pure.

import { round1 as round1Report } from '../schemas/precision.ts';

export function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const s = [...values].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 === 1 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}

/** Quantile with linear interpolation between order statistics (Hyndman-Fan type 7). */
export function quantile(values: readonly number[], p: number): number | null {
  if (values.length === 0) return null;
  const s = [...values].sort((a, b) => a - b);
  const h = (s.length - 1) * Math.min(1, Math.max(0, p));
  const lo = Math.floor(h);
  const hi = Math.min(lo + 1, s.length - 1);
  return s[lo]! + (h - lo) * (s[hi]! - s[lo]!);
}

/** Report rounding: ms and dB to 0.1, half away from zero on the printed decimal (spec 8.1, core/schemas). */
export function round1(x: number): number {
  return round1Report(x);
}

/** Shares to 0.001. */
export function round3(x: number): number {
  return Math.round(x * 1000) / 1000;
}

/**
 * Median over `slots` counts of which only `nonEmpty` are listed; the other slots hold 0. Costs
 * O(nonEmpty), whatever the number of slots. Null without a slot or with more counts than slots.
 */
export function medianWithZeros(nonEmpty: readonly number[], slots: number): number | null {
  if (!Number.isFinite(slots) || slots < 1 || nonEmpty.length > slots) return null;
  const sorted = [...nonEmpty].sort((a, b) => a - b);
  const zeros = slots - sorted.length;
  const at = (i: number): number => (i < zeros ? 0 : sorted[i - zeros]!);
  const mid = Math.floor(slots / 2);
  return slots % 2 === 1 ? at(mid) : (at(mid - 1) + at(mid)) / 2;
}

/** y = intercept + slope * x */
export interface Line {
  slope: number;
  intercept: number;
}

export function leastSquaresLine(xs: readonly number[], ys: readonly number[]): Line | null {
  const n = Math.min(xs.length, ys.length);
  if (n < 2) return null;
  let mx = 0;
  let my = 0;
  for (let i = 0; i < n; i++) {
    mx += xs[i]!;
    my += ys[i]!;
  }
  mx /= n;
  my /= n;
  let sxx = 0;
  let sxy = 0;
  for (let i = 0; i < n; i++) {
    const dx = xs[i]! - mx;
    sxx += dx * dx;
    sxy += dx * (ys[i]! - my);
  }
  if (sxx === 0) return null;
  const slope = sxy / sxx;
  return { slope, intercept: my - slope * mx };
}

/** Theil-Sen line: median of pairwise slopes, intercept the median of y - slope * x. */
export function theilSenLine(xs: readonly number[], ys: readonly number[]): Line | null {
  const n = Math.min(xs.length, ys.length);
  const slopes: number[] = [];
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const dx = xs[j]! - xs[i]!;
      if (dx !== 0) slopes.push((ys[j]! - ys[i]!) / dx);
    }
  }
  const slope = median(slopes);
  if (slope === null) return null;
  const rest: number[] = [];
  for (let i = 0; i < n; i++) rest.push(ys[i]! - slope * xs[i]!);
  return { slope, intercept: median(rest)! };
}
