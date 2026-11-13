// Camera clock (spec 6.3, 7.12, 8.1): 'pa' syllables put camera timestamps on the audio scale.
// Secondary: no stop or lead depends on it. A failure drops "camera vs sound" positions only.

import { CAMERA_OFFSET_AGREE_MS, SAMPLE_RATE_HZ, THRESHOLD_TOLERANCE_MS } from './constants.ts';
import { leastSquaresLine, median, round1, theilSenLine } from './stats.ts';
import type { CalibCameraClock } from './types.ts';

/** Arrival of one SDK packet: nArr (stamps.jsonl `arr`) and the newest camera timestamp it carries. */
export interface PacketTime {
  nArr: number;
  tsUs: number;
}

/** Lip gap g of one frame (spec 7.5) at its landmark timestamp, with its packet's nArr. */
export interface LipFrame {
  tsUs: number;
  g: number;
  nArr: number;
}

/**
 * Lower envelope of d = nArr / 48000 - (ts - x0) / 1e6 over camera time x = (ts - x0) / 1e6 s:
 * d(x) = intercept + slope * x. The slope is the drift of the audio clock against the camera
 * clock; the level is the clock offset plus the shortest arrival latency.
 */
export interface Envelope {
  x0Us: number;
  slope: number;
  intercept: number;
  windows: number;
}

export interface CameraClockOptions {
  sampleRateHz?: number;
  /** Window of the envelope minima, s (assumption: 10 s). */
  windowS?: number;
  /** Start and end offsets must agree within this, ms (spec 6.3: 25 ms). */
  agreeMs?: number;
  /** Syllables needed in a block for its offset (default 1: pack 0 has one 'pa' per block, spec 9.4). */
  minFoundPerBlock?: number;
}

export const ENVELOPE_WINDOW_S = 10;
/** A block gives an offset from one found syllable on (pack 0 has one per block, web/scenarios/gate.ts). */
export const CAMERA_MIN_SYLLABLES = 1;
/** Frames whose packet arrived from 0.4 s before to 1.0 s after the burst belong to the syllable. */
const LIP_WINDOW_BEFORE_S = 0.4;
const LIP_WINDOW_AFTER_S = 1.0;
/** The closed level is taken from frames at least 250 ms before the gap peak. */
const LIP_CLOSED_GUARD_S = 0.25;
/** The rise is fitted between 10 % and 90 % of the opening. */
const RISE_LOW = 0.1;
const RISE_HIGH = 0.9;
/** The opening must stand 5 noise widths above the closed level. */
const MIN_OPENING_IN_NOISE = 5;

/**
 * Envelope of nArr / 48000 - ts over the session: the minimum of d in each window, then a
 * Theil-Sen line through those minima. Windows with fewer than half the median packet count
 * (the ragged ends) are left out. Null with fewer than two windows.
 */
export function lowerEnvelope(packets: readonly PacketTime[], opts: CameraClockOptions = {}): Envelope | null {
  const rate = opts.sampleRateHz ?? SAMPLE_RATE_HZ;
  const windowS = opts.windowS ?? ENVELOPE_WINDOW_S;
  const valid = packets.filter((p) => Number.isFinite(p.nArr) && Number.isFinite(p.tsUs));
  if (valid.length < 2) return null;
  let x0Us = valid[0]!.tsUs;
  for (const p of valid) if (p.tsUs < x0Us) x0Us = p.tsUs;
  const minima = new Map<number, { x: number; d: number; count: number }>();
  for (const p of valid) {
    const x = (p.tsUs - x0Us) / 1e6;
    const d = p.nArr / rate - x;
    const w = Math.floor(x / windowS);
    const cur = minima.get(w);
    if (!cur) minima.set(w, { x, d, count: 1 });
    else {
      cur.count++;
      if (d < cur.d) {
        cur.x = x;
        cur.d = d;
      }
    }
  }
  const all = [...minima.values()];
  const typical = median(all.map((m) => m.count)) ?? 0;
  const kept = all.filter((m) => m.count >= typical / 2);
  if (kept.length < 2) return null;
  const line = theilSenLine(
    kept.map((m) => m.x),
    kept.map((m) => m.d),
  );
  if (!line) return null;
  return { x0Us, slope: line.slope, intercept: line.intercept, windows: kept.length };
}

/** Envelope value at a camera timestamp, s. */
export function envelopeAt(env: Envelope, tsUs: number): number {
  return env.intercept + env.slope * ((tsUs - env.x0Us) / 1e6);
}

export interface LipOpening {
  nBurst: number;
  /** Camera time of the lip opening, us (fractional); null when not found. */
  tsOpenUs: number | null;
  gClosed: number | null;
  amplitude: number | null;
  riseFrames: number;
}

/**
 * Lip opening of the 'pa' whose plosive burst is at sample nBurst of channel 0 (spec 6.3):
 * a least-squares line through the frames where the gap grows (strictly between 10 % and
 * 90 % of the opening) intersected with the closed level (median gap at least 250 ms before
 * the peak). Frames belong to the syllable when their packet arrived from 0.4 s before to
 * 1.0 s after the burst. `frames` must be sorted by tsUs.
 */
export function lipOpening(frames: readonly LipFrame[], nBurst: number, opts: CameraClockOptions = {}): LipOpening {
  const rate = opts.sampleRateHz ?? SAMPLE_RATE_HZ;
  const fail: LipOpening = { nBurst, tsOpenUs: null, gClosed: null, amplitude: null, riseFrames: 0 };
  const lo = nBurst - LIP_WINDOW_BEFORE_S * rate;
  const hi = nBurst + LIP_WINDOW_AFTER_S * rate;
  const w = frames.filter((f) => f.nArr >= lo && f.nArr <= hi && Number.isFinite(f.g));
  if (w.length < 5) return fail;

  let jp = 0;
  for (let j = 1; j < w.length; j++) if (w[j]!.g > w[jp]!.g) jp = j;
  const guardUs = w[jp]!.tsUs - LIP_CLOSED_GUARD_S * 1e6;
  const closed: number[] = [];
  for (let j = 0; j < jp; j++) if (w[j]!.tsUs <= guardUs) closed.push(w[j]!.g);
  if (closed.length < 3) return fail;
  const gClosed = median(closed)!;
  const noise = 1.4826 * median(closed.map((g) => Math.abs(g - gClosed)))!;
  const amplitude = w[jp]!.g - gClosed;
  if (!(amplitude > 0) || amplitude < MIN_OPENING_IN_NOISE * noise) return { ...fail, gClosed, amplitude };

  const low = gClosed + RISE_LOW * amplitude;
  const high = gClosed + RISE_HIGH * amplitude;
  let jl = -1;
  for (let j = jp - 1; j >= 0; j--) {
    if (w[j]!.g <= low) {
      jl = j;
      break;
    }
  }
  if (jl < 0) return { ...fail, gClosed, amplitude };
  let jh = jp;
  for (let j = jl + 1; j <= jp; j++) {
    if (w[j]!.g >= high) {
      jh = j;
      break;
    }
  }
  // Frames where the gap grows: strictly inside 10-90 %. A frame on either plateau would
  // flatten the line, so the boundary frames join only when fewer than two lie inside.
  const [from, to] = jh - jl - 1 >= 2 ? [jl + 1, jh - 1] : [jl, jh];
  const t0 = w[from]!.tsUs;
  const xs: number[] = [];
  const ys: number[] = [];
  for (let j = from; j <= to; j++) {
    xs.push((w[j]!.tsUs - t0) / 1e6);
    ys.push(w[j]!.g);
  }
  const line = leastSquaresLine(xs, ys);
  if (!line || !(line.slope > 0)) return { ...fail, gClosed, amplitude };
  const xOpen = (gClosed - line.intercept) / line.slope;
  return { nBurst, tsOpenUs: t0 + xOpen * 1e6, gClosed, amplitude, riseFrames: to - from + 1 };
}

export interface SyllableBlock {
  openings: LipOpening[];
  /** Per syllable: envelope minus (burst time - opening time), ms. */
  offsetsMs: Array<number | null>;
  /** Median over found syllables; null with fewer than minFoundPerBlock. */
  offsetMs: number | null;
  found: number;
}

export interface CameraClockInput {
  packets: readonly PacketTime[];
  frames: readonly LipFrame[];
  /** Plosive burst samples in channel 0, from the burst finder; 5 at the start and 5 at the end. */
  bursts: { start: readonly number[]; end: readonly number[] };
}

export interface CameraClock {
  envelope: Envelope | null;
  slopePpm: number | null;
  start: SyllableBlock;
  end: SyllableBlock;
  ok: boolean;
  /** calib.json camera_clock */
  calib: CalibCameraClock;
}

/**
 * Camera clock of a recording (spec 6.3). Each syllable's offset is how far the arrival
 * envelope lies above the burst-to-opening pairing, i.e. the shortest arrival latency of a
 * lip movement on the microphone scale. Start and end offsets must agree within 25 ms, which
 * tests the slope as well. The comparison uses the measured offsets; calib.json prints them
 * rounded to 0.1 ms.
 */
export function cameraClock(input: CameraClockInput, opts: CameraClockOptions = {}): CameraClock {
  const rate = opts.sampleRateHz ?? SAMPLE_RATE_HZ;
  const minFound = opts.minFoundPerBlock ?? CAMERA_MIN_SYLLABLES;
  const envelope = lowerEnvelope(input.packets, opts);
  const frames = [...input.frames].sort((p, q) => p.tsUs - q.tsUs);

  const block = (bursts: readonly number[]): SyllableBlock => {
    const openings = bursts.map((nBurst) => lipOpening(frames, nBurst, opts));
    const offsetsMs = openings.map((o) => {
      if (!envelope || o.tsOpenUs === null) return null;
      const burstMinusOpenS = o.nBurst / rate - (o.tsOpenUs - envelope.x0Us) / 1e6;
      return (envelopeAt(envelope, o.tsOpenUs) - burstMinusOpenS) * 1000;
    });
    const found = offsetsMs.filter((v): v is number => v !== null);
    return {
      openings,
      offsetsMs,
      offsetMs: found.length > 0 && found.length >= minFound ? median(found) : null,
      found: found.length,
    };
  };

  const start = block(input.bursts.start);
  const end = block(input.bursts.end);
  const slopePpm = envelope ? envelope.slope * 1e6 : null;
  const s = start.offsetMs === null ? null : round1(start.offsetMs);
  const e = end.offsetMs === null ? null : round1(end.offsetMs);
  const agreeMs = opts.agreeMs ?? CAMERA_OFFSET_AGREE_MS;
  const ok =
    start.offsetMs !== null &&
    end.offsetMs !== null &&
    Math.abs(start.offsetMs - end.offsetMs) <= agreeMs + THRESHOLD_TOLERANCE_MS;
  return {
    envelope,
    slopePpm,
    start,
    end,
    ok,
    calib: { offset_ms: [s, e], slope_ppm: slopePpm === null ? null : round1(slopePpm), ok },
  };
}

/** Camera timestamp on the microphone scale (s), with the start/end mean offset; null unless ok. */
export function cameraTsToMicSeconds(clock: CameraClock, tsUs: number): number | null {
  if (!clock.ok || !clock.envelope || clock.start.offsetMs === null || clock.end.offsetMs === null) return null;
  const offsetS = (clock.start.offsetMs + clock.end.offsetMs) / 2000;
  return (tsUs - clock.envelope.x0Us) / 1e6 + envelopeAt(clock.envelope, tsUs) - offsetS;
}
