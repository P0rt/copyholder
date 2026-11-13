// Test-only synthetic signals shared by unit tests and the Playwright harness.

import { SAMPLE_RATE_HZ, msToSamples } from '../units.ts';

export interface SynthWord {
  startMs: number;
  endMs: number;
}

/**
 * Narrator stand-in: a tone inside each word with 5 ms raised-cosine edges, exact zeros in the pauses.
 * Same input always gives the same Float32 samples.
 */
export function synthPassage(words: readonly SynthWord[], totalMs: number, freqHz = 220, amp = 0.3): Float32Array {
  const pcm = new Float32Array(msToSamples(totalMs));
  const ramp = msToSamples(5);
  for (const w of words) {
    const a = msToSamples(w.startMs);
    const b = Math.min(pcm.length, msToSamples(w.endMs));
    for (let j = a; j < b; j++) {
      const edge = Math.min(j - a + 1, b - j, ramp) / ramp;
      const env = edge >= 1 ? 1 : 0.5 - 0.5 * Math.cos(Math.PI * edge);
      pcm[j] = amp * env * Math.sin((2 * Math.PI * freqHz * j) / SAMPLE_RATE_HZ) + amp * 0.05 * env;
    }
  }
  return pcm;
}

/** Evenly spaced words: `count` words of `wordMs`, separated by `gapMs`, starting at `leadMs`. */
export function evenWords(count: number, wordMs: number, gapMs: number, leadMs = 200): SynthWord[] {
  const out: SynthWord[] = [];
  for (let i = 0; i < count; i++) {
    const startMs = leadMs + i * (wordMs + gapMs);
    out.push({ startMs, endMs: startMs + wordMs });
  }
  return out;
}

/** Voiced stand-in for speech: harmonic complex with fundamental f0 (periodic, so the VAD calls it voiced). */
export function voicedTone(lengthSamples: number, f0 = 140, amp = 0.2, phase0 = 0): Float32Array {
  const out = new Float32Array(lengthSamples);
  for (let j = 0; j < lengthSamples; j++) {
    const t = (j + phase0) / SAMPLE_RATE_HZ;
    let x = 0;
    for (let h = 1; h <= 6; h++) x += Math.sin(2 * Math.PI * f0 * h * t) / h;
    out[j] = (amp * x) / 2.45;
  }
  return out;
}

/** Deterministic white noise (xorshift32), for breath-like aperiodic sound. */
export function noise(lengthSamples: number, amp = 0.05, seed = 12345): Float32Array {
  const out = new Float32Array(lengthSamples);
  let s = seed >>> 0 || 1;
  for (let j = 0; j < lengthSamples; j++) {
    s ^= s << 13;
    s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5;
    s >>>= 0;
    out[j] = amp * ((s / 4294967296) * 2 - 1);
  }
  return out;
}

/** 16-bit PCM mono WAV bytes, for --use-file-for-fake-audio-capture. */
export function wavBytes(samples: Float32Array, rateHz = SAMPLE_RATE_HZ): Uint8Array {
  const data = samples.length * 2;
  const buf = new ArrayBuffer(44 + data);
  const dv = new DataView(buf);
  const ascii = (off: number, s: string) => {
    for (let i = 0; i < s.length; i++) dv.setUint8(off + i, s.charCodeAt(i));
  };
  ascii(0, 'RIFF');
  dv.setUint32(4, 36 + data, true);
  ascii(8, 'WAVE');
  ascii(12, 'fmt ');
  dv.setUint32(16, 16, true);
  dv.setUint16(20, 1, true);
  dv.setUint16(22, 1, true);
  dv.setUint32(24, rateHz, true);
  dv.setUint32(28, rateHz * 2, true);
  dv.setUint16(32, 2, true);
  dv.setUint16(34, 16, true);
  ascii(36, 'data');
  dv.setUint32(40, data, true);
  for (let i = 0; i < samples.length; i++) {
    const v = Math.max(-1, Math.min(1, samples[i] as number));
    dv.setInt16(44 + 2 * i, Math.round(v * 32767), true);
  }
  return new Uint8Array(buf);
}
