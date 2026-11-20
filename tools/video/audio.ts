// The sound of the video (spec 15.4): the app's own two-channel recording, never the screen
// recording's. Channel 1 (the narrator as Deck played it) is moved L_rt later, so both channels
// lie on the microphone's time scale (spec 6.3) and the viewer hears the same gap between the
// narrator's silence and the voice as the participant did in the headset. Each channel is
// brought to the same speech level, so the voice and the narrator are both clearly audible,
// and the sum is peak-normalised to -1 dBFS: nothing clips. Pure, except encodeMonoFloatWav.

import type { ChunkLayout } from '../../core/clock/index.ts';

/** Channel `ch` over session samples [n0, n1); samples audio.wav does not hold are 0. */
export function channelSpan(ch: Float32Array, layout: Pick<ChunkLayout, 'runs'>, n0: number, n1: number): Float32Array {
  const out = new Float32Array(Math.max(0, n1 - n0));
  for (const r of layout.runs) {
    const a = Math.max(n0, r.n0);
    const b = Math.min(n1, r.n1);
    if (b <= a) continue;
    const src = r.index0 + (a - r.n0);
    out.set(ch.subarray(src, Math.min(ch.length, src + (b - a))), a - n0);
  }
  return out;
}

/** Window of the level measurement: 50 ms at 48 kHz. */
const LEVEL_WINDOW = 2_400;
/** Speech is a window this far above the quiet floor of its channel (dB). */
const ACTIVE_OVER_FLOOR_DB = 15;
/** Each channel's speech level is brought to this RMS before the sum (-20 dBFS). */
export const TARGET_RMS = 0.1;
/** Channel gains stay within -20 dB and +40 dB. */
const GAIN_MIN = 0.1;
const GAIN_MAX = 100;
/** The mix peaks at -1 dBFS. */
export const PEAK_TARGET = 10 ** (-1 / 20);

function percentile(sorted: readonly number[], q: number): number {
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.round(q * (sorted.length - 1))))] as number;
}

/**
 * Speech level of a channel: the 75th percentile of the 50 ms RMS over windows at least 15 dB
 * above the channel's quiet floor (its 10th percentile). Null for a silent channel.
 */
export function speechLevel(x: Float32Array, window = LEVEL_WINDOW): number | null {
  const rms: number[] = [];
  for (let i = 0; i < x.length; i += window) {
    const end = Math.min(x.length, i + window);
    let s = 0;
    for (let k = i; k < end; k++) s += (x[k] as number) * (x[k] as number);
    const r = Math.sqrt(s / (end - i));
    if (r > 1e-6) rms.push(r);
  }
  if (rms.length === 0) return null;
  rms.sort((a, b) => a - b);
  const floor = percentile(rms, 0.1);
  const active = rms.filter((r) => r >= floor * 10 ** (ACTIVE_OVER_FLOOR_DB / 20));
  return active.length >= 3 ? percentile(active, 0.75) : (rms[rms.length - 1] as number);
}

/** Gain that brings a channel's speech level to TARGET_RMS, within -20 and +40 dB; 1 for silence. */
export function levelGain(x: Float32Array): number {
  const level = speechLevel(x);
  if (level === null) return 1;
  return Math.min(GAIN_MAX, Math.max(GAIN_MIN, TARGET_RMS / level));
}

export function toDb(gain: number): number {
  return 20 * Math.log10(gain);
}

export interface MixResult {
  /** Mono, session samples [nFrom, nTo) on the microphone's time scale. */
  samples: Float32Array;
  micGainDb: number;
  narratorGainDb: number;
  /** Gain applied to the sum to bring its peak to -1 dBFS. */
  normDb: number;
  /** Peak of the result, dBFS (-1, or -Infinity for silence). */
  peakDbfs: number;
}

/**
 * The sound over session samples [nFrom, nTo): microphone + narrator delayed by lrtSamples, each
 * at the same speech level, the sum peak-normalised.
 */
export function mixTrack(
  ch0: Float32Array,
  ch1: Float32Array,
  layout: Pick<ChunkLayout, 'runs'>,
  nFrom: number,
  nTo: number,
  lrtSamples: number,
): MixResult {
  const mic = channelSpan(ch0, layout, nFrom, nTo);
  const narrator = channelSpan(ch1, layout, nFrom - lrtSamples, nTo - lrtSamples);
  const g0 = levelGain(mic);
  const g1 = levelGain(narrator);
  const out = new Float32Array(mic.length);
  let peak = 0;
  for (let i = 0; i < out.length; i++) {
    const x = g0 * (mic[i] as number) + g1 * (narrator[i] as number);
    out[i] = x;
    const a = Math.abs(x);
    if (a > peak) peak = a;
  }
  const norm = peak > 0 ? PEAK_TARGET / peak : 1;
  let peakAfter = 0;
  for (let i = 0; i < out.length; i++) {
    const y = Math.max(-1, Math.min(1, (out[i] as number) * norm));
    out[i] = y;
    peakAfter = Math.max(peakAfter, Math.abs(y));
  }
  return {
    samples: out,
    micGainDb: toDb(g0),
    narratorGainDb: toDb(g1),
    normDb: toDb(norm),
    peakDbfs: peakAfter > 0 ? toDb(peakAfter) : Number.NEGATIVE_INFINITY,
  };
}

/** A mono 32-bit float WAV (format 3). */
export function encodeMonoFloatWav(samples: Float32Array, sampleRateHz: number): Buffer {
  const dataBytes = samples.length * 4;
  const out = Buffer.alloc(44 + dataBytes);
  out.write('RIFF', 0, 'ascii');
  out.writeUInt32LE(36 + dataBytes, 4);
  out.write('WAVE', 8, 'ascii');
  out.write('fmt ', 12, 'ascii');
  out.writeUInt32LE(16, 16);
  out.writeUInt16LE(3, 20);
  out.writeUInt16LE(1, 22);
  out.writeUInt32LE(sampleRateHz, 24);
  out.writeUInt32LE(sampleRateHz * 4, 28);
  out.writeUInt16LE(4, 32);
  out.writeUInt16LE(32, 34);
  out.write('data', 36, 'ascii');
  out.writeUInt32LE(dataBytes, 40);
  for (let i = 0; i < samples.length; i++) out.writeFloatLE(samples[i] as number, 44 + 4 * i);
  return out;
}
