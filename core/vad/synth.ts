// Seeded synthetic microphone audio with known truth, for the tests of spec 7.3, 7.6 and 13.4:
// harmonic voice (100-200 Hz fundamental, glottal tilt, formant resonators, lip radiation),
// breath noise as band-filtered noise, fricatives, plosive bursts, background noise and a
// low-level narrator leak. Pure and deterministic: a seeded PRNG, never Math.random().
// Not imported by the detector itself; tests (and e2e fixtures) import it directly.

import { butterworthSos, concatSos, sosFilterInPlace } from './dsp.ts';

export const SYNTH_RATE_HZ = 48000;

/** Uniform numbers in [0, 1). */
export type Rng = () => number;

/** mulberry32: small seeded generator, integer arithmetic only. */
export function createRng(seed: number): Rng {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Standard normal value (Box-Muller). */
export function gaussian(rng: Rng): number {
  let u = rng();
  while (u <= 1e-300) u = rng();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rng());
}

export function msToSamples(ms: number): number {
  return Math.round((ms * SYNTH_RATE_HZ) / 1000);
}

/** Scales x so that its RMS over [from, to) is `levelDb` dB re full scale. */
function setRms(x: Float64Array, levelDb: number, from = 0, to = x.length): void {
  let s = 0;
  for (let i = from; i < to; i++) s += x[i]! * x[i]!;
  const rms = Math.sqrt(s / Math.max(1, to - from));
  if (!(rms > 0)) return;
  const g = Math.pow(10, levelDb / 20) / rms;
  for (let i = 0; i < x.length; i++) x[i] = x[i]! * g;
}

/** Raised-cosine fade in over `attack` samples and fade out over `release` samples. */
function applyEdges(x: Float64Array, attack: number, release: number): void {
  const n = x.length;
  for (let i = 0; i < Math.min(attack, n); i++) x[i] = x[i]! * 0.5 * (1 - Math.cos((Math.PI * i) / attack));
  for (let i = 0; i < Math.min(release, n); i++) {
    const k = n - 1 - i;
    x[k] = x[k]! * 0.5 * (1 - Math.cos((Math.PI * i) / release));
  }
}

export interface VoiceOptions {
  readonly durMs: number;
  /** Fundamental, constant or a linear glide [start, end]. */
  readonly f0Hz: number | readonly [number, number];
  /** RMS of the part between attack and release, dB re full scale. */
  readonly levelDb: number;
  /** Formant frequencies; default /a/ (730, 1090, 2440 Hz). */
  readonly formantsHz?: readonly number[];
  readonly bandwidthsHz?: readonly number[];
  readonly attackMs?: number;
  readonly releaseMs?: number;
  /** Relative period-to-period jitter (default 0.005). */
  readonly jitter?: number;
  /** Relative pulse amplitude jitter (default 0.04). */
  readonly shimmer?: number;
}

/**
 * Voiced sound: glottal pulse train -> two one-pole low-passes (spectral tilt) -> cascade of
 * formant resonators -> lip radiation (first difference). Sample 0 is the first sample of the
 * sound (the attack starts there), so it is the truth for an onset.
 */
export function voice(opts: VoiceOptions, rng: Rng): Float64Array {
  const fs = SYNTH_RATE_HZ;
  const n = msToSamples(opts.durMs);
  const pre = msToSamples(60);
  const total = pre + n;
  const [f0a, f0b] = typeof opts.f0Hz === 'number' ? [opts.f0Hz, opts.f0Hz] : opts.f0Hz;
  const jitter = opts.jitter ?? 0.005;
  const shimmer = opts.shimmer ?? 0.04;
  const src = new Float64Array(total);
  let phase = 0.5;
  let local = 1;
  for (let i = 0; i < total; i++) {
    const t = Math.max(0, i - pre) / Math.max(1, n);
    const f0 = (f0a + (f0b - f0a) * t) * local;
    phase += f0 / fs;
    if (phase >= 1) {
      phase -= 1;
      src[i] = 1 + shimmer * gaussian(rng);
      local = 1 + jitter * gaussian(rng);
    }
  }
  // Glottal tilt: two one-pole low-passes at 150 Hz (-12 dB/octave above it).
  const a = Math.exp((-2 * Math.PI * 150) / fs);
  for (let pass = 0; pass < 2; pass++) {
    let y = 0;
    for (let i = 0; i < total; i++) {
      y = (1 - a) * src[i]! + a * y;
      src[i] = y;
    }
  }
  const formants = opts.formantsHz ?? [730, 1090, 2440];
  const bws = opts.bandwidthsHz ?? [80, 90, 120];
  for (let k = 0; k < formants.length; k++) {
    const f = formants[k]!;
    const bw = bws[k] ?? 100;
    const c = -Math.exp((-2 * Math.PI * bw) / fs);
    const b = 2 * Math.exp((-Math.PI * bw) / fs) * Math.cos((2 * Math.PI * f) / fs);
    const g = 1 - b - c;
    let y1 = 0;
    let y2 = 0;
    for (let i = 0; i < total; i++) {
      const y = g * src[i]! + b * y1 + c * y2;
      y2 = y1;
      y1 = y;
      src[i] = y;
    }
  }
  const out = new Float64Array(n);
  for (let i = 0; i < n; i++) out[i] = src[pre + i]! - src[pre + i - 1]!;
  const attack = msToSamples(opts.attackMs ?? 5);
  const release = msToSamples(opts.releaseMs ?? 15);
  setRms(out, opts.levelDb, attack, Math.max(attack + 1, n - release));
  applyEdges(out, attack, release);
  return out;
}

export interface NoiseOptions {
  readonly durMs: number;
  /** RMS of the part between attack and release, dB re full scale. */
  readonly levelDb: number;
  readonly lowHz?: number;
  readonly highHz?: number;
  /** Butterworth order of each band edge (even). */
  readonly order?: number;
  readonly attackMs?: number;
  readonly releaseMs?: number;
}

/** Band-filtered Gaussian noise with raised-cosine edges; sample 0 is its first sample. */
export function bandNoise(opts: NoiseOptions, rng: Rng): Float64Array {
  const n = msToSamples(opts.durMs);
  const pre = msToSamples(50);
  const x = new Float64Array(pre + n);
  for (let i = 0; i < x.length; i++) x[i] = gaussian(rng);
  const order = opts.order ?? 2;
  const parts = [];
  if (opts.lowHz !== undefined) parts.push(butterworthSos('highpass', order, opts.lowHz, SYNTH_RATE_HZ));
  if (opts.highHz !== undefined) parts.push(butterworthSos('lowpass', order, opts.highHz, SYNTH_RATE_HZ));
  if (parts.length > 0) sosFilterInPlace(concatSos(...parts), x);
  const out = x.slice(pre);
  const attack = msToSamples(opts.attackMs ?? 5);
  const release = msToSamples(opts.releaseMs ?? 5);
  setRms(out, opts.levelDb, attack, Math.max(attack + 1, n - release));
  applyEdges(out, attack, release);
  return out;
}

/** Audible inhale: broadband turbulence 400 Hz-4 kHz with slow edges (defaults). */
export function breath(opts: { durMs: number; levelDb: number; attackMs?: number; releaseMs?: number }, rng: Rng): Float64Array {
  return bandNoise(
    {
      durMs: opts.durMs,
      levelDb: opts.levelDb,
      lowHz: 400,
      highHz: 4000,
      order: 2,
      attackMs: opts.attackMs ?? 60,
      releaseMs: opts.releaseMs ?? 80,
    },
    rng,
  );
}

/** Voiceless fricative like /s/: noise 4-9 kHz. */
export function fricative(opts: { durMs: number; levelDb: number; attackMs?: number; releaseMs?: number }, rng: Rng): Float64Array {
  return bandNoise(
    {
      durMs: opts.durMs,
      levelDb: opts.levelDb,
      lowHz: 4000,
      highHz: 9000,
      order: 4,
      attackMs: opts.attackMs ?? 8,
      releaseMs: opts.releaseMs ?? 5,
    },
    rng,
  );
}

/**
 * Plosive release: an abrupt broadband transient decaying with `decayMs`, followed by
 * aspiration noise (1-5 kHz) lasting `aspirationMs`. Sample 0 is the burst onset.
 */
export function plosive(
  opts: { burstDb: number; aspirationDb: number; decayMs?: number; burstMs?: number; aspirationMs?: number },
  rng: Rng,
): Float64Array {
  const burstN = msToSamples(opts.burstMs ?? 6);
  const decay = msToSamples(opts.decayMs ?? 1.5);
  const burst = new Float64Array(burstN);
  for (let i = 0; i < burstN; i++) burst[i] = gaussian(rng) * Math.exp(-i / decay);
  sosFilterInPlace(butterworthSos('highpass', 2, 500, SYNTH_RATE_HZ), burst);
  setRms(burst, opts.burstDb, 0, Math.min(burstN, msToSamples(2)));
  const asp = bandNoise(
    { durMs: opts.aspirationMs ?? 15, levelDb: opts.aspirationDb, lowHz: 1000, highHz: 5000, attackMs: 1, releaseMs: 4 },
    rng,
  );
  const out = new Float64Array(Math.max(burstN, msToSamples(1)) + asp.length);
  out.set(burst, 0);
  const at = msToSamples(1);
  for (let i = 0; i < asp.length; i++) out[at + i] = out[at + i]! + asp[i]!;
  return out;
}

/** Sharp nasal sniff: turbulence 700 Hz-7 kHz with a fast rise and a slower fall (defaults). */
export function sniff(
  opts: { durMs?: number; levelDb: number; attackMs?: number; releaseMs?: number },
  rng: Rng,
): Float64Array {
  return bandNoise(
    {
      durMs: opts.durMs ?? 300,
      levelDb: opts.levelDb,
      lowHz: 700,
      highHz: 7000,
      order: 2,
      attackMs: opts.attackMs ?? 8,
      releaseMs: opts.releaseMs ?? 120,
    },
    rng,
  );
}

export interface PaOptions {
  /** RMS of the vowel, dB re full scale. */
  readonly levelDb: number;
  readonly f0Hz: number | readonly [number, number];
  /** Voice onset time: burst to vowel (default 40 ms, an aspirated /p/). */
  readonly votMs?: number;
  readonly vowelMs?: number;
  /** Burst level relative to the vowel (default -4 dB) and aspiration level (default -20 dB). */
  readonly burstRelDb?: number;
  readonly aspirationRelDb?: number;
}

/**
 * 'pa' spoken from closed lips (spec 6.3): plosive release burst, aspiration up to the voice
 * onset, then the vowel /a/. Sample 0 is the burst, the truth for the burst finder.
 */
export function paSyllable(opts: PaOptions, rng: Rng): Float64Array {
  const vot = opts.votMs ?? 40;
  const burst = plosive(
    {
      burstDb: opts.levelDb + (opts.burstRelDb ?? -4),
      aspirationDb: opts.levelDb + (opts.aspirationRelDb ?? -20),
      aspirationMs: Math.max(5, vot),
    },
    rng,
  );
  const vowel = voice({ durMs: opts.vowelMs ?? 250, f0Hz: opts.f0Hz, levelDb: opts.levelDb, attackMs: 10, releaseMs: 40 }, rng);
  const at = msToSamples(vot);
  const out = new Float64Array(Math.max(burst.length, at + vowel.length));
  out.set(burst, 0);
  for (let i = 0; i < vowel.length; i++) out[at + i] = out[at + i]! + vowel[i]!;
  return out;
}

/**
 * Narrator leaking into the headset microphone: syllables of a voice with a 170-230 Hz
 * fundamental and changing vowels, short gaps between them and sentence pauses. `levelDb` is
 * the RMS while it speaks.
 */
export function narratorLeak(durMs: number, levelDb: number, rng: Rng): Float64Array {
  const out = new Float64Array(msToSamples(durMs));
  const vowels: ReadonlyArray<readonly number[]> = [
    [730, 1090, 2440],
    [530, 1840, 2480],
    [270, 2290, 3010],
    [570, 840, 2410],
    [300, 870, 2240],
  ];
  let t = Math.floor(rng() * msToSamples(150));
  while (t < out.length) {
    const dur = 120 + rng() * 200;
    const f0 = 170 + rng() * 60;
    const syl = voice(
      {
        durMs: dur,
        f0Hz: [f0, f0 * (0.9 + rng() * 0.15)],
        levelDb,
        formantsHz: vowels[Math.floor(rng() * vowels.length)]!,
        bandwidthsHz: [90, 110, 150],
        attackMs: 15,
        releaseMs: 25,
      },
      rng,
    );
    for (let i = 0; i < syl.length && t + i < out.length; i++) out[t + i] = out[t + i]! + syl[i]!;
    t += syl.length + msToSamples(rng() < 0.15 ? 300 + rng() * 300 : 30 + rng() * 120);
  }
  return out;
}

/** A buffer under construction: background noise plus sounds placed at known samples. */
export class Scene {
  readonly samples: Float64Array;

  constructor(durMs: number) {
    this.samples = new Float64Array(msToSamples(durMs));
  }

  /** Adds a sound starting at `atMs`; returns its first sample (the truth for its onset). */
  add(sound: Float64Array, atMs: number, gain = 1): number {
    const at = msToSamples(atMs);
    this.addAt(sound, at, gain);
    return at;
  }

  addAt(sound: Float64Array, at: number, gain = 1): void {
    const s = this.samples;
    for (let i = 0; i < sound.length; i++) {
      const k = at + i;
      if (k >= 0 && k < s.length) s[k] = s[k]! + gain * sound[i]!;
    }
  }

  /** White background noise over the whole buffer, RMS `levelDb` dB re full scale. */
  background(levelDb: number, rng: Rng): this {
    const g = Math.pow(10, levelDb / 20);
    const s = this.samples;
    for (let i = 0; i < s.length; i++) s[i] = s[i]! + g * gaussian(rng);
    return this;
  }

  /** Adds a constant offset to every sample. */
  dc(offset: number): this {
    const s = this.samples;
    for (let i = 0; i < s.length; i++) s[i] = s[i]! + offset;
    return this;
  }

  /** Float32 copy, optionally hard-clipped to [-limit, limit]. */
  toFloat32(clipAt = Infinity): Float32Array {
    const out = new Float32Array(this.samples.length);
    for (let i = 0; i < out.length; i++) {
      const v = this.samples[i]!;
      out[i] = v > clipAt ? clipAt : v < -clipAt ? -clipAt : v;
    }
    return out;
  }
}
