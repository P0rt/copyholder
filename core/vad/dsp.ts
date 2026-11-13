// Small DSP toolkit shared by core/vad and core/onset (spec 7.3, 7.6).
// Pure: typed arrays and Math only. Nothing here touches Node or browser APIs, so the
// voice detector can run inside the AudioWorklet `Deck`.

/** Second-order sections, flattened as [b0, b1, b2, a1, a2] per section (a0 = 1). */
export type Sos = Float64Array;

/** Mean-square floor for dB conversion: digital silence reads -200 dB. */
export const DB_EPS = 1e-20;

/** Mean square (power) to dB. */
export function powerToDb(meanSquare: number): number {
  return 10 * Math.log10(meanSquare + DB_EPS);
}

/** dB to mean square (power). */
export function dbToPower(db: number): number {
  return Math.pow(10, db / 10);
}

/**
 * Digital Butterworth filter as cascaded biquads (bilinear transform, prewarped at the
 * cutoff). Only even orders: every section is second order.
 */
export function butterworthSos(
  kind: 'lowpass' | 'highpass',
  order: number,
  cutoffHz: number,
  sampleRateHz: number,
): Sos {
  if (!Number.isInteger(order) || order < 2 || order % 2 !== 0) {
    throw new RangeError(`butterworthSos: order must be an even integer >= 2, got ${order}`);
  }
  if (!(cutoffHz > 0 && cutoffHz < sampleRateHz / 2)) {
    throw new RangeError(`butterworthSos: cutoff ${cutoffHz} Hz outside (0, ${sampleRateHz / 2})`);
  }
  const sections = order / 2;
  const sos = new Float64Array(sections * 5);
  const w0 = (2 * Math.PI * cutoffHz) / sampleRateHz;
  const cosW = Math.cos(w0);
  const sinW = Math.sin(w0);
  for (let k = 0; k < sections; k++) {
    // Pole pair k of the analog prototype has Q = 1 / (2 cos(pi (2k + 1) / (2 order))).
    const q = 1 / (2 * Math.cos((Math.PI * (2 * k + 1)) / (2 * order)));
    const alpha = sinW / (2 * q);
    const a0 = 1 + alpha;
    const b0 = kind === 'lowpass' ? (1 - cosW) / 2 : (1 + cosW) / 2;
    const b1 = kind === 'lowpass' ? 1 - cosW : -(1 + cosW);
    const o = k * 5;
    sos[o] = b0 / a0;
    sos[o + 1] = b1 / a0;
    sos[o + 2] = b0 / a0;
    sos[o + 3] = (-2 * cosW) / a0;
    sos[o + 4] = (1 - alpha) / a0;
  }
  return sos;
}

/** Joins several cascades into one. */
export function concatSos(...parts: Sos[]): Sos {
  let n = 0;
  for (const p of parts) n += p.length;
  const out = new Float64Array(n);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

/** Causal filtering in place (direct form II transposed), zero initial state. */
export function sosFilterInPlace(sos: Sos, x: Float64Array | Float32Array): void {
  const sections = sos.length / 5;
  const n = x.length;
  for (let s = 0; s < sections; s++) {
    const o = s * 5;
    const b0 = sos[o]!;
    const b1 = sos[o + 1]!;
    const b2 = sos[o + 2]!;
    const a1 = sos[o + 3]!;
    const a2 = sos[o + 4]!;
    let z1 = 0;
    let z2 = 0;
    for (let i = 0; i < n; i++) {
      const xi = x[i]!;
      const y = b0 * xi + z1;
      z1 = b1 * xi - a1 * y + z2;
      z2 = b2 * xi - a2 * y;
      x[i] = y;
    }
  }
}

/** Zero-phase filtering in place: forward, then backward (spec 7.6, "вперёд и назад"). */
export function sosFiltFiltInPlace(sos: Sos, x: Float64Array): void {
  sosFilterInPlace(sos, x);
  x.reverse();
  sosFilterInPlace(sos, x);
  x.reverse();
}

/** Linear-phase low-pass FIR (Hamming-windowed sinc), odd length, unity gain at DC. */
export function lowpassFir(taps: number, cutoffHz: number, sampleRateHz: number): Float64Array {
  if (!Number.isInteger(taps) || taps < 3 || taps % 2 === 0) {
    throw new RangeError(`lowpassFir: taps must be an odd integer >= 3, got ${taps}`);
  }
  if (!(cutoffHz > 0 && cutoffHz < sampleRateHz / 2)) {
    throw new RangeError(`lowpassFir: cutoff ${cutoffHz} Hz outside (0, ${sampleRateHz / 2})`);
  }
  const h = new Float64Array(taps);
  const mid = (taps - 1) / 2;
  const fc = cutoffHz / sampleRateHz;
  let sum = 0;
  for (let i = 0; i < taps; i++) {
    const k = i - mid;
    const sinc = k === 0 ? 2 * fc : Math.sin(2 * Math.PI * fc * k) / (Math.PI * k);
    const w = 0.54 - 0.46 * Math.cos((2 * Math.PI * i) / (taps - 1));
    const v = sinc * w;
    h[i] = v;
    sum += v;
  }
  for (let i = 0; i < taps; i++) h[i] = h[i]! / sum;
  return h;
}

/**
 * Periodicity of one window: the largest normalized autocorrelation
 *   r(tau) = sum x[i] x[i+tau] / sqrt(sum x[i]^2 * sum x[i+tau]^2),  i in [0, len - tau),
 * over integer lags tau in [lagMin, lagMax] (spec 7.3, 7.6). Each lag is normalized by the
 * energy of the two overlapping parts, so a periodic signal scores near 1 at any lag in range.
 * Returns a value in [0, 1]; 0 for a silent window. `prefix` is scratch of length >= len + 1.
 */
export function maxNormalizedAutocorrelation(
  x: Float64Array,
  len: number,
  lagMin: number,
  lagMax: number,
  prefix: Float64Array,
): number {
  prefix[0] = 0;
  for (let i = 0; i < len; i++) {
    const v = x[i]!;
    prefix[i + 1] = prefix[i]! + v * v;
  }
  const top = Math.min(lagMax, len - 1);
  let best = 0;
  for (let tau = lagMin; tau <= top; tau++) {
    const m = len - tau;
    let num = 0;
    for (let i = 0; i < m; i++) num += x[i]! * x[i + tau]!;
    if (!(num > 0)) continue;
    const den = prefix[m]! * (prefix[len]! - prefix[tau]!);
    if (!(den > 0)) continue;
    const r = num / Math.sqrt(den);
    if (r > best) best = r;
  }
  return best > 1 ? 1 : best;
}

/** k-th smallest (0-based) of a[0..n), by quickselect. Reorders a[0..n). */
export function selectInPlace(a: Float64Array, n: number, k: number): number {
  if (!(n > 0) || k < 0 || k >= n) throw new RangeError(`selectInPlace: k=${k} outside [0, ${n})`);
  let lo = 0;
  let hi = n - 1;
  while (lo < hi) {
    // Median-of-three pivot keeps sorted and constant inputs fast.
    const mid = (lo + hi) >>> 1;
    let p = a[mid]!;
    const l = a[lo]!;
    const h = a[hi]!;
    if ((l <= p && p <= h) || (h <= p && p <= l)) {
      // p is the median of three
    } else if ((p <= l && l <= h) || (h <= l && l <= p)) {
      p = l;
    } else {
      p = h;
    }
    let i = lo;
    let j = hi;
    while (i <= j) {
      while (a[i]! < p) i++;
      while (a[j]! > p) j--;
      if (i <= j) {
        const t = a[i]!;
        a[i] = a[j]!;
        a[j] = t;
        i++;
        j--;
      }
    }
    if (k <= j) hi = j;
    else if (k >= i) lo = i;
    else return a[k]!;
  }
  return a[k]!;
}

/** Median of a[0..n) (mean of the two middle values when n is even). Reorders a[0..n). */
export function medianInPlace(a: Float64Array, n: number): number {
  if (!(n > 0)) return Number.NaN;
  const hi = selectInPlace(a, n, n >>> 1);
  if (n % 2 === 1) return hi;
  // After the select, a[0..n/2) holds the lower half: its maximum is the other middle value.
  let lo = -Infinity;
  for (let i = 0; i < n >>> 1; i++) if (a[i]! > lo) lo = a[i]!;
  return (lo + hi) / 2;
}

/** Median absolute deviation around `center`. Overwrites a[0..n). */
export function madInPlace(a: Float64Array, n: number, center: number): number {
  for (let i = 0; i < n; i++) a[i] = Math.abs(a[i]! - center);
  return medianInPlace(a, n);
}

/** Smallest power of two >= n. */
export function nextPow2(n: number): number {
  let p = 1;
  while (p < n) p *= 2;
  return p;
}
