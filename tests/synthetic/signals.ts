// Signal helpers for synthetic sessions (tests only). Every random draw comes from a seeded PRNG.

export type Rng = () => number;

/** mulberry32: small seeded PRNG, uniform in [0, 1). */
export function mulberry32(seed: number): Rng {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Standard normal draw (Box-Muller). */
export function gaussian(rng: Rng): number {
  const u = Math.max(rng(), 1e-12);
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rng());
}

export function exponential(rng: Rng, mean: number): number {
  return -mean * Math.log(Math.max(1 - rng(), 1e-12));
}

/** Adds white Gaussian noise of standard deviation sigma over [from, to). */
export function addNoise(buf: Float32Array, sigma: number, rng: Rng, from = 0, to = buf.length): void {
  for (let i = from; i < to; i += 2) {
    const r = sigma * Math.sqrt(-2 * Math.log(Math.max(rng(), 1e-12)));
    const phi = 2 * Math.PI * rng();
    buf[i] = buf[i]! + r * Math.cos(phi);
    if (i + 1 < to) buf[i + 1] = buf[i + 1]! + r * Math.sin(phi);
  }
}

/** RBJ cookbook biquad, transposed direct form II. */
export class Biquad {
  private z1 = 0;
  private z2 = 0;

  private constructor(
    private readonly b0: number,
    private readonly b1: number,
    private readonly b2: number,
    private readonly a1: number,
    private readonly a2: number,
  ) {}

  private static make(b0: number, b1: number, b2: number, a0: number, a1: number, a2: number): Biquad {
    return new Biquad(b0 / a0, b1 / a0, b2 / a0, a1 / a0, a2 / a0);
  }

  static highpass(fHz: number, q: number, rateHz: number): Biquad {
    const w = (2 * Math.PI * fHz) / rateHz;
    const c = Math.cos(w);
    const alpha = Math.sin(w) / (2 * q);
    return Biquad.make((1 + c) / 2, -(1 + c), (1 + c) / 2, 1 + alpha, -2 * c, 1 - alpha);
  }

  static peaking(fHz: number, q: number, gainDb: number, rateHz: number): Biquad {
    const w = (2 * Math.PI * fHz) / rateHz;
    const c = Math.cos(w);
    const alpha = Math.sin(w) / (2 * q);
    const A = Math.pow(10, gainDb / 40);
    return Biquad.make(1 + alpha * A, -2 * c, 1 - alpha * A, 1 + alpha / A, -2 * c, 1 - alpha / A);
  }

  process(buf: Float32Array, from = 0, to = buf.length): void {
    for (let i = from; i < to; i++) {
      const x = buf[i]!;
      const y = this.b0 * x + this.z1;
      this.z1 = this.b1 * x - this.a1 * y + this.z2;
      this.z2 = this.b2 * x - this.a2 * y;
      buf[i] = y;
    }
  }
}

function windowedSinc(x: number, halfWidth: number): number {
  if (x === 0) return 1;
  if (Math.abs(x) >= halfWidth) return 0;
  const px = Math.PI * x;
  const w = 0.42 + 0.5 * Math.cos((Math.PI * x) / halfWidth) + 0.08 * Math.cos((2 * Math.PI * x) / halfWidth);
  return (Math.sin(px) / px) * w;
}

/** dst += gain * src delayed to start at fractional index `at` (Blackman-windowed sinc). */
export function addDelayed(dst: Float32Array, src: ArrayLike<number>, at: number, gain: number, halfWidth = 24): void {
  const j0 = Math.max(0, Math.floor(at) - halfWidth);
  const j1 = Math.min(dst.length, Math.ceil(at + src.length) + halfWidth);
  for (let j = j0; j < j1; j++) {
    const kLo = Math.max(0, Math.ceil(j - at - halfWidth));
    const kHi = Math.min(src.length - 1, Math.floor(j - at + halfWidth));
    let s = 0;
    for (let k = kLo; k <= kHi; k++) s += src[k]! * windowedSinc(j - at - k, halfWidth);
    dst[j] = dst[j]! + gain * s;
  }
}

/**
 * Earcup pressed on the microphone: fractional delay, a reflection 1.3 ms later, a +6 dB
 * cavity resonance at 2.5 kHz and the microphone's 300 Hz high-pass, then `gain`.
 */
export function addCoupledClick(dst: Float32Array, click: Float32Array, at: number, gain: number, rateHz: number): void {
  const halfWidth = 24;
  const reflectionAt = 0.0013 * rateHz;
  const base = Math.floor(at) - halfWidth;
  const tmp = new Float32Array(click.length + Math.ceil(reflectionAt) + 2 * halfWidth + Math.round(0.01 * rateHz));
  addDelayed(tmp, click, at - base, 1, halfWidth);
  addDelayed(tmp, click, at - base + reflectionAt, 0.35, halfWidth);
  Biquad.peaking(2500, 1.5, 6, rateHz).process(tmp);
  Biquad.highpass(300, Math.SQRT1_2, rateHz).process(tmp);
  for (let i = 0; i < tmp.length; i++) {
    const j = base + i;
    if (j >= 0 && j < dst.length) dst[j] = dst[j]! + gain * tmp[i]!;
  }
}

const TABLE_SIZE = 4096;

interface Vowel {
  f1: number;
  f2: number;
}

const VOWELS: readonly Vowel[] = [
  { f1: 800, f2: 1200 }, // a
  { f1: 450, f2: 1900 }, // e
  { f1: 300, f2: 2300 }, // i
  { f1: 500, f2: 900 }, // o
  { f1: 330, f2: 800 }, // u
];

// One period of a voiced sound: harmonics with a 1/h source and two formant resonances.
function vowelTable(v: Vowel, f0Hz: number): Float32Array {
  const table = new Float32Array(TABLE_SIZE);
  const harmonics = Math.floor(5000 / f0Hz);
  const res = (f: number, center: number, bw: number): number => 1 / Math.sqrt(1 + ((f - center) / (bw / 2)) ** 2);
  for (let h = 1; h <= harmonics; h++) {
    const f = h * f0Hz;
    const amp = (1 / h) * (res(f, v.f1, 120) + 0.6 * res(f, v.f2, 160) + 0.05);
    for (let i = 0; i < TABLE_SIZE; i++) table[i] = table[i]! + amp * Math.sin((2 * Math.PI * h * i) / TABLE_SIZE);
  }
  let peak = 0;
  for (let i = 0; i < TABLE_SIZE; i++) peak = Math.max(peak, Math.abs(table[i]!));
  for (let i = 0; i < TABLE_SIZE; i++) table[i] = table[i]! / peak;
  return table;
}

const tableCache = new Map<string, Float32Array>();

function tableFor(vowel: number, f0Hz: number): Float32Array {
  const key = `${vowel}:${f0Hz}`;
  let t = tableCache.get(key);
  if (!t) {
    t = vowelTable(VOWELS[vowel % VOWELS.length]!, f0Hz);
    tableCache.set(key, t);
  }
  return t;
}

/** Raised-cosine attack and release envelope over a segment of `durS`. */
function envelope(tS: number, durS: number, attackS: number, releaseS: number): number {
  if (tS < 0 || tS >= durS) return 0;
  if (tS < attackS) return 0.5 - 0.5 * Math.cos((Math.PI * tS) / attackS);
  if (tS > durS - releaseS) return 0.5 - 0.5 * Math.cos((Math.PI * (durS - tS)) / releaseS);
  return 1;
}

/** Adds one voiced syllable at index `at`: wavetable with a slowly moving f0. */
export function addSyllable(
  dst: Float32Array,
  at: number,
  durS: number,
  vowel: number,
  f0Hz: number,
  amp: number,
  rateHz: number,
  attackS = 0.02,
): void {
  const table = tableFor(vowel, f0Hz);
  const n = Math.round(durS * rateHz);
  let phase = 0;
  for (let i = 0; i < n; i++) {
    const t = i / rateHz;
    const j = at + i;
    if (j >= 0 && j < dst.length) {
      const pos = phase * TABLE_SIZE;
      const k = Math.floor(pos);
      const a = table[k % TABLE_SIZE]!;
      const b = table[(k + 1) % TABLE_SIZE]!;
      dst[j] = dst[j]! + amp * envelope(t, durS, attackS, 0.04) * (a + (pos - k) * (b - a));
    }
    phase += (f0Hz * (1 + 0.04 * Math.sin(2 * Math.PI * 3 * t))) / rateHz;
    if (phase >= 1) phase -= 1;
  }
}

/** Adds a short noise burst (plosive release or fricative) with exponential decay. */
export function addBurst(dst: Float32Array, at: number, durS: number, amp: number, decayS: number, rng: Rng, rateHz: number): void {
  const n = Math.round(durS * rateHz);
  for (let i = 0; i < n; i++) {
    const j = at + i;
    if (j >= 0 && j < dst.length) dst[j] = dst[j]! + amp * Math.exp(-i / (decayS * rateHz)) * (2 * rng() - 1);
  }
}

/** Speech-like narrator signal: syllables in words, words in phrases, pauses between. */
export function narratorSignal(lengthSamples: number, rng: Rng, rateHz: number): Float32Array {
  const out = new Float32Array(lengthSamples);
  const lengthS = lengthSamples / rateHz;
  let t = 0.15;
  while (t < lengthS - 0.5) {
    const words = 5 + Math.floor(rng() * 5);
    for (let w = 0; w < words && t < lengthS - 0.5; w++) {
      const syllables = 1 + Math.floor(rng() * 3);
      for (let s = 0; s < syllables; s++) {
        const dur = 0.16 + 0.1 * rng();
        const at = Math.round(t * rateHz);
        if (rng() < 0.4) addBurst(out, at, 0.025, 0.05, 0.01, rng, rateHz);
        addSyllable(out, at + Math.round(0.02 * rateHz), dur, Math.floor(rng() * 5), 150 - 20 * (w / words), 0.25, rateHz);
        t += dur + 0.02;
      }
      t += 0.05 + 0.1 * rng();
    }
    t += 0.3 + 0.3 * rng();
  }
  return out;
}

/** A spoken reply starting exactly at `at`: voiced syllables without gaps, f0 about 120 Hz. */
export function addVoiceReply(dst: Float32Array, at: number, durS: number, rng: Rng, rateHz: number): void {
  let t = 0;
  let first = true;
  while (t < durS - 0.1) {
    const dur = Math.min(0.18 + 0.08 * rng(), durS - t);
    addSyllable(dst, at + Math.round(t * rateHz), dur + 0.03, Math.floor(rng() * 5), 120, 0.15, rateHz, first ? 0.015 : 0.03);
    first = false;
    t += dur;
  }
}

/** 'pa' from closed lips: the release burst at `at`, then the vowel 15 ms later. */
export function addPa(dst: Float32Array, at: number, rng: Rng, rateHz: number): void {
  addBurst(dst, at, 0.008, 0.08, 0.002, rng, rateHz);
  addSyllable(dst, at + Math.round(0.015 * rateHz), 0.22, 0, 130, 0.15, rateHz);
}

/** Sharp nasal in-breath: noise above 1.5 kHz, 15 ms rise, about 0.4 s long. */
export function addSniff(dst: Float32Array, at: number, rng: Rng, rateHz: number): void {
  const n = Math.round(0.4 * rateHz);
  const tmp = new Float32Array(n);
  for (let i = 0; i < n; i++) tmp[i] = 0.03 * gaussian(rng) * envelope(i / rateHz, 0.4, 0.015, 0.12);
  Biquad.highpass(1500, Math.SQRT1_2, rateHz).process(tmp);
  for (let i = 0; i < n; i++) {
    const j = at + i;
    if (j >= 0 && j < dst.length) dst[j] = dst[j]! + tmp[i]!;
  }
}
