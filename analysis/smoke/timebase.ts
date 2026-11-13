// Clocks of a smoke run (spec 6.3, 8.1) and the maps between them:
// - audio: sample numbers n at 48 kHz (stamps.jsonl; scenario steps, packet arrivals nArr);
// - tap: process.hrtime of tap in ns (tArrNs of every samples.jsonl and sdk_raw line);
// - camera: SDK timestamps in µs (trace, talk and landmark ts, timestampUs);
// - wall: Date.now() at the callback (tWallMs of sdk_raw lines).
// Each map is fitted from the lines that carry both clocks; null when there are too few.

import { envelopeAt, lowerEnvelope, SAMPLE_RATE_HZ, type PacketTime } from '../../core/clock/index.ts';
import { median } from '../../core/stats/index.ts';

/** tArrNs strings as numbers relative to the earliest one (exact: bigint subtraction first). */
export interface TapClock {
  baseNs: bigint | null;
  /** ns since the earliest tArrNs of the run; null for a missing or malformed value. */
  relNs(tArrNs: unknown): number | null;
}

function parseNs(v: unknown): bigint | null {
  if (typeof v === 'string' && /^\d+$/.test(v)) return BigInt(v);
  if (typeof v === 'number' && Number.isSafeInteger(v) && v >= 0) return BigInt(v);
  return null;
}

export function tapClock(values: Iterable<unknown>): TapClock {
  let base: bigint | null = null;
  for (const v of values) {
    const ns = parseNs(v);
    if (ns !== null && (base === null || ns < base)) base = ns;
  }
  return {
    baseNs: base,
    relNs(v: unknown): number | null {
      const ns = parseNs(v);
      return ns === null || base === null ? null : Number(ns - base);
    },
  };
}

/** Absolute tap time in µs (hrtime / 1000), for comparing with SDK timestamps on one clock. */
export function tapAbsoluteUs(tArrNs: unknown): number | null {
  const ns = parseNs(tArrNs);
  return ns === null ? null : Number(ns / 1000n) + Number(ns % 1000n) / 1000;
}

export function finite(values: readonly (number | null | undefined)[]): number[] {
  return values.filter((v): v is number => typeof v === 'number' && Number.isFinite(v));
}

/** Median of (y - x) over pairs: the constant offset that best maps x onto y. */
function medianOffset(pairs: readonly (readonly [number, number])[]): number | null {
  return median(finite(pairs.map(([x, y]) => y - x)));
}

/** tap clock <-> audio samples. */
export interface TapSamplesMap {
  toSamples(relNs: number): number;
  toRelNs(n: number): number;
}

/**
 * tap clock -> audio samples, from packets with both tArrNs and an `arr` stamp: n = rate * t + c,
 * c the median offset (unit slope: over a two-minute run the clocks drift by milliseconds at most).
 */
export function tapNsToSamplesMap(
  packets: readonly { relNs: number; nArr: number }[],
  sampleRateHz: number = SAMPLE_RATE_HZ,
): TapSamplesMap | null {
  const offsetSamples = medianOffset(packets.map((p) => [(p.relNs / 1e9) * sampleRateHz, p.nArr] as const));
  if (offsetSamples === null) return null;
  return {
    toSamples: (relNs: number) => (relNs / 1e9) * sampleRateHz + offsetSamples,
    toRelNs: (n: number) => ((n - offsetSamples) / sampleRateHz) * 1e9,
  };
}

/**
 * tap clock -> wall clock in µs, from sdk_raw lines (tArrNs with tWallMs = Date.now()).
 * Date.now() is floored to the ms, so the true wall time is on average 0.5 ms later.
 */
export function tapNsToWallUsMap(lines: readonly { relNs: number; tWallMs: number }[]): ((relNs: number) => number) | null {
  const offsetUs = medianOffset(lines.map((l) => [l.relNs / 1000, l.tWallMs * 1000 + 500] as const));
  if (offsetUs === null) return null;
  return (relNs: number) => relNs / 1000 + offsetUs;
}

/** Camera timestamps <-> audio samples. */
export interface CameraSamplesMap {
  /** 'envelope': lower envelope of arrival minus timestamp (core/clock); 'median': median offset. */
  method: 'envelope' | 'median';
  tsUsToSamples(tsUs: number): number;
  samplesToTsUs(n: number): number;
}

/**
 * Camera clock -> audio clock from packet arrivals (nArr) and their newest camera timestamp.
 * The lower envelope (core/clock/camera.ts) maps a timestamp to the earliest arrival seen for it,
 * so a cue at sample n maps to the frame that could arrive first at n (assumption: the shortest
 * SDK latency is the best stand-in for the capture moment). With fewer than two 10 s windows the
 * median offset is used instead.
 */
export function cameraSamplesMap(packets: readonly PacketTime[], sampleRateHz: number = SAMPLE_RATE_HZ): CameraSamplesMap | null {
  const env = lowerEnvelope(packets, { sampleRateHz });
  if (env !== null && Math.abs(env.slope) < 0.01) {
    return {
      method: 'envelope',
      tsUsToSamples: (tsUs) => ((tsUs - env.x0Us) / 1e6 + envelopeAt(env, tsUs)) * sampleRateHz,
      samplesToTsUs: (n) => env.x0Us + ((n / sampleRateHz - env.intercept) / (1 + env.slope)) * 1e6,
    };
  }
  const offsetS = medianOffset(packets.map((p) => [p.tsUs / 1e6, p.nArr / sampleRateHz] as const));
  if (offsetS === null) return null;
  return {
    method: 'median',
    tsUsToSamples: (tsUs) => (tsUs / 1e6 + offsetS) * sampleRateHz,
    samplesToTsUs: (n) => (n / sampleRateHz - offsetS) * 1e6,
  };
}

export function samplesToSeconds(n: number, sampleRateHz: number = SAMPLE_RATE_HZ): number {
  return n / sampleRateHz;
}
