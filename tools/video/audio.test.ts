// The sound of the video (spec 15.4): the narrator channel moved L_rt later, both channels at one
// speech level, the sum at -1 dBFS without clipping.

import { describe, expect, it } from 'vitest';
import { channelSpan, encodeMonoFloatWav, mixTrack, PEAK_TARGET, speechLevel, toDb } from './audio.ts';

const RATE = 48_000;

/** Low noise with a cosine burst (it starts at full height, so its first sample marks it). */
function channel(length: number, burstAt: number, burstS: number, amp: number, hz: number, noise: number, seed: number): Float32Array {
  const x = new Float32Array(length);
  let s = seed;
  for (let i = 0; i < length; i++) {
    s = (s * 1_103_515_245 + 12_345) % 2_147_483_648;
    x[i] = noise * (2 * (s / 2_147_483_648) - 1);
  }
  const n = Math.round(burstS * RATE);
  for (let i = 0; i < n && burstAt + i < length; i++) x[burstAt + i] = (x[burstAt + i] as number) + amp * Math.cos((2 * Math.PI * hz * i) / RATE);
  return x;
}

const whole = { runs: [{ n0: 0, n1: 4 * RATE, index0: 0 }] };

describe('mixTrack', () => {
  // A quiet microphone (voice at 0.01) and a loud narrator channel (0.5), 4 s.
  const mic = channel(4 * RATE, 2 * RATE, 0.4, 0.01, 220, 1e-4, 7);
  const narrator = channel(4 * RATE, RATE, 0.4, 0.5, 440, 0, 11);
  const lrt = 1_440; // 30 ms

  it('moves the narrator channel L_rt later', () => {
    const m = mixTrack(mic, narrator, whole, 0, 4 * RATE, lrt);
    const first = m.samples.findIndex((v) => Math.abs(v) > 0.3);
    expect(first).toBe(RATE + lrt);
    const later = mixTrack(mic, narrator, whole, 10_000, 4 * RATE, lrt);
    expect(later.samples.findIndex((v) => Math.abs(v) > 0.3)).toBe(RATE + lrt - 10_000);
    expect(later.samples).toHaveLength(4 * RATE - 10_000);
  });

  it('brings both channels to one level and the sum to -1 dBFS without clipping', () => {
    const m = mixTrack(mic, narrator, whole, 0, 4 * RATE, lrt);
    const peakOf = (a: number, b: number): number => m.samples.subarray(a, b).reduce((p, v) => Math.max(p, Math.abs(v)), 0);
    const voice = peakOf(2 * RATE, 2 * RATE + 0.4 * RATE);
    const played = peakOf(RATE + lrt, RATE + lrt + 0.4 * RATE);
    expect(Math.abs(toDb(voice / played))).toBeLessThan(1);
    expect(m.micGainDb).toBeGreaterThan(20);
    expect(m.narratorGainDb).toBeLessThan(0);
    expect(m.peakDbfs).toBeCloseTo(-1, 6);
    expect(peakOf(0, m.samples.length)).toBeLessThanOrEqual(PEAK_TARGET + 1e-6);
  });

  it('gives silence for silence', () => {
    const z = new Float32Array(RATE);
    const m = mixTrack(z, z, { runs: [{ n0: 0, n1: RATE, index0: 0 }] }, 0, RATE, 100);
    expect(m.peakDbfs).toBe(Number.NEGATIVE_INFINITY);
    expect(m.samples.every((v) => v === 0)).toBe(true);
    expect(speechLevel(z)).toBeNull();
  });
});

describe('channelSpan', () => {
  it('reads session samples through the chunk layout and leaves gaps silent', () => {
    const ch = Float32Array.from({ length: 300 }, (_, i) => i + 1);
    // Session samples 0-99 at audio 0-99, 200-399 at audio 100-299 (a gap at 100-199).
    const layout = { runs: [{ n0: 0, n1: 100, index0: 0 }, { n0: 200, n1: 400, index0: 100 }] };
    const out = channelSpan(ch, layout, 90, 210);
    expect(Array.from(out.subarray(0, 10))).toEqual([91, 92, 93, 94, 95, 96, 97, 98, 99, 100]);
    expect(out.subarray(10, 110).every((v) => v === 0)).toBe(true);
    expect(Array.from(out.subarray(110))).toEqual([101, 102, 103, 104, 105, 106, 107, 108, 109, 110]);
    expect(channelSpan(ch, layout, -20, 5).slice(0, 20).every((v) => v === 0)).toBe(true);
  });
});

describe('encodeMonoFloatWav', () => {
  it('writes a 32-bit float mono WAV', () => {
    const b = encodeMonoFloatWav(Float32Array.from([0.5, -0.25]), RATE);
    expect(b.toString('ascii', 0, 4)).toBe('RIFF');
    expect(b.readUInt16LE(20)).toBe(3);
    expect(b.readUInt16LE(22)).toBe(1);
    expect(b.readUInt32LE(24)).toBe(RATE);
    expect(b.readUInt32LE(40)).toBe(8);
    expect(b.readFloatLE(44)).toBe(0.5);
    expect(b.readFloatLE(48)).toBe(-0.25);
  });
});
