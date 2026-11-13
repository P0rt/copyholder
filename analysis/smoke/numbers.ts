// Small numeric and text helpers of the smoke report. Report values in ms are rounded to 0.1
// (spec 8.1); rates to 0.1 per second; shares to 0.001.

import { median, quantile } from '../../core/stats/index.ts';
import { round1 } from '../../core/schemas/precision.ts';
import { finite } from './timebase.ts';

export { finite };

export interface Spread {
  n: number;
  median: number;
  p5: number;
  p95: number;
  /** p95 - p5: the spread of the middle 90 %. */
  spread: number;
  min: number;
  max: number;
}

/** Median, 5th and 95th percentiles (type 7), their spread, min and max; null for no values. */
export function spreadOf(values: readonly (number | null | undefined)[]): Spread | null {
  const v = finite(values);
  if (v.length === 0) return null;
  const p5 = quantile(v, 0.05)!;
  const p95 = quantile(v, 0.95)!;
  let min = v[0]!;
  let max = v[0]!;
  for (const x of v) {
    if (x < min) min = x;
    if (x > max) max = x;
  }
  return { n: v.length, median: median(v)!, p5, p95, spread: p95 - p5, min, max };
}

/** A Spread rounded to 0.1 for the JSON report (ms or per-second values). */
export function roundSpread(s: Spread | null): Record<string, number> | null {
  if (s === null) return null;
  return { n: s.n, median: round1(s.median), p5: round1(s.p5), p95: round1(s.p95), spread: round1(s.spread), min: round1(s.min), max: round1(s.max) };
}

export const r1 = (x: number | null | undefined): number | null => (typeof x === 'number' && Number.isFinite(x) ? round1(x) : null);
export const r3 = (x: number | null | undefined): number | null =>
  typeof x === 'number' && Number.isFinite(x) ? Math.round(x * 1000) / 1000 : null;
export const r4 = (x: number | null | undefined): number | null =>
  typeof x === 'number' && Number.isFinite(x) ? Math.round(x * 10000) / 10000 : null;

/**
 * Median of `windows` counts of which only `nonEmpty` are above zero; the other windows count 0.
 * Same rule as core/stats median (mean of the two middle values), without an array per window.
 */
export function medianWithEmptyWindows(nonEmpty: readonly number[], windows: number): number | null {
  if (!Number.isFinite(windows) || windows < 1 || nonEmpty.length > windows) return null;
  const sorted = [...nonEmpty].sort((a, b) => a - b);
  const zeros = windows - sorted.length;
  const at = (i: number): number => (i < zeros ? 0 : sorted[i - zeros]!);
  const mid = Math.floor(windows / 2);
  return windows % 2 === 1 ? at(mid) : (at(mid - 1) + at(mid)) / 2;
}

/**
 * Median count of unique timestamps per full 1 s window of camera time, windows from `startUs`
 * (default: the first timestamp) up to `endUs` (default: the last); the rule of traceRateMedian
 * in core/clock/check.ts (spec 6.3), for any stream and any window. Null without a full window.
 * Windows are counted sparsely: a stray timestamp years away costs nothing (callers still pass
 * the stream cut to its run, analysis/smoke/span.ts, or the empty windows decide the median).
 */
export function medianCountPerSecond(tsUs: readonly number[], startUs?: number, endUs?: number): number | null {
  const ts = [...new Set(finite(tsUs))].sort((a, b) => a - b);
  if (ts.length === 0) return null;
  const t0 = startUs ?? ts[0]!;
  const t1 = endUs ?? ts[ts.length - 1]!;
  const windows = Math.floor((t1 - t0) / 1e6);
  if (!Number.isFinite(windows) || windows < 1) return null;
  const counts = new Map<number, number>();
  for (const t of ts) {
    if (t < t0) continue;
    const w = Math.floor((t - t0) / 1e6);
    if (w < windows) counts.set(w, (counts.get(w) ?? 0) + 1);
  }
  return medianWithEmptyWindows([...counts.values()], windows);
}

/** Unique timestamps in [startUs, endUs) divided by the window length in s; null for an empty window. */
export function meanRatePerSecond(tsUs: readonly number[], startUs: number, endUs: number): number | null {
  if (!(endUs > startUs)) return null;
  const n = new Set(finite(tsUs).filter((t) => t >= startUs && t < endUs)).size;
  return n / ((endUs - startUs) / 1e6);
}

/** Unique timestamps over their own span: (count - 1) / (last - first). */
export function spanRatePerSecond(tsUs: readonly number[]): number | null {
  const ts = [...new Set(finite(tsUs))].sort((a, b) => a - b);
  if (ts.length < 2) return null;
  return (ts.length - 1) / ((ts[ts.length - 1]! - ts[0]!) / 1e6);
}

// ---- text ----------------------------------------------------------------------------------

export const fmtMs = (x: number | null | undefined): string => (r1(x) === null ? 'n/a' : `${r1(x)} ms`);
export const fmtPerS = (x: number | null | undefined): string => (r1(x) === null ? 'n/a' : `${r1(x)} per s`);
export const fmtS = (x: number | null | undefined): string => (r1(x) === null ? 'n/a' : `${r1(x)} s`);
export const fmtPct = (share: number | null | undefined): string =>
  typeof share === 'number' && Number.isFinite(share) ? `${round1(share * 100)} %` : 'n/a';
export const quoted = (names: readonly string[]): string => names.map((s) => `"${s}"`).join(', ');

/** "median 12.3 ms, p95 20.1 ms, spread (p95 - p5) 8.0 ms, min 9.9 ms, max 31.0 ms". */
export function fmtSpreadMs(s: Spread | null): string {
  if (s === null) return 'no values';
  return `median ${fmtMs(s.median)}, p95 ${fmtMs(s.p95)}, spread (p95 - p5) ${fmtMs(s.spread)}, min ${fmtMs(s.min)}, max ${fmtMs(s.max)} (n = ${s.n})`;
}

/**
 * Logged text for one report line: whitespace runs become one space, and long secrets never reach
 * the report (any run of 32+ key-like characters is blanked, assumption); cut to maxLength.
 */
export function redactLogText(text: string, maxLength = 200): string {
  const red = text.replace(/\s+/g, ' ').trim().replace(/[A-Za-z0-9_\-+/=]{32,}/g, '[redacted]');
  return red.length > maxLength ? `${red.slice(0, maxLength - 3)}...` : red;
}

/** Copy with every non-finite number replaced by null, so JSON never writes NaN silently. */
export function finiteJson(value: unknown): unknown {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (Array.isArray(value)) return value.map(finiteJson);
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) if (v !== undefined) out[k] = finiteJson(v);
    return out;
  }
  return value;
}
