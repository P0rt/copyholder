import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import {
  butterworthSos,
  concatSos,
  lowpassFir,
  madInPlace,
  maxNormalizedAutocorrelation,
  medianInPlace,
  selectInPlace,
  sosFiltFiltInPlace,
  sosFilterInPlace,
} from './dsp.ts';
import { createRng, gaussian } from './synth.ts';

const FS = 48000;

/** Steady-state gain of a causal filter on a sinusoid, dB. */
function gainDb(apply: (x: Float64Array) => void, freqHz: number): number {
  const n = FS;
  const x = new Float64Array(n);
  for (let i = 0; i < n; i++) x[i] = Math.sin((2 * Math.PI * freqHz * i) / FS);
  apply(x);
  let s = 0;
  for (let i = n / 2; i < n; i++) s += x[i]! * x[i]!;
  return 10 * Math.log10(s / (n / 2) / 0.5);
}

describe('butterworthSos', () => {
  it('high-pass 150 Hz, 4th order: -3 dB at the corner, flat above, steep below', () => {
    const sos = butterworthSos('highpass', 4, 150, FS);
    const g = (f: number): number => gainDb((x) => sosFilterInPlace(sos, x), f);
    expect(g(150)).toBeCloseTo(-3.01, 1);
    expect(Math.abs(g(1000))).toBeLessThan(0.01);
    expect(g(50)).toBeLessThan(-37);
  });

  it('low-pass 8 kHz, 4th order: -3 dB at the corner', () => {
    const sos = butterworthSos('lowpass', 4, 8000, FS);
    const g = (f: number): number => gainDb((x) => sosFilterInPlace(sos, x), f);
    expect(g(8000)).toBeCloseTo(-3.01, 1);
    expect(Math.abs(g(1000))).toBeLessThan(0.01);
    expect(g(16000)).toBeLessThan(-20);
  });

  it('rejects odd orders and cutoffs outside (0, fs/2)', () => {
    expect(() => butterworthSos('highpass', 3, 150, FS)).toThrow(RangeError);
    expect(() => butterworthSos('lowpass', 2, 24000, FS)).toThrow(RangeError);
    expect(() => butterworthSos('lowpass', 2, 0, FS)).toThrow(RangeError);
  });

  it('forward-backward filtering has zero phase: a symmetric pulse stays centred', () => {
    const sos = concatSos(butterworthSos('highpass', 4, 80, FS), butterworthSos('lowpass', 4, 2000, FS));
    const x = new Float64Array(9601);
    for (let i = -200; i <= 200; i++) x[4800 + i] = Math.exp(-((i / 60) ** 2));
    sosFiltFiltInPlace(sos, x);
    let peak = 0;
    for (let i = 1; i < x.length; i++) if (x[i]! > x[peak]!) peak = i;
    expect(peak).toBe(4800);
    for (let i = 1; i < 300; i++) expect(x[4800 + i]).toBeCloseTo(x[4800 - i]!, 9);
  });
});

describe('lowpassFir', () => {
  it('has unity DC gain and stops aliasing above 4 kHz', () => {
    const h = lowpassFir(95, 3200, FS);
    const g = (f: number): number =>
      gainDb((x) => {
        const y = new Float64Array(x.length);
        for (let i = h.length; i < x.length; i++) {
          let a = 0;
          for (let k = 0; k < h.length; k++) a += h[k]! * x[i - k]!;
          y[i] = a;
        }
        x.set(y);
      }, f);
    let sum = 0;
    for (const v of h) sum += v;
    expect(sum).toBeCloseTo(1, 12);
    expect(Math.abs(g(500))).toBeLessThan(0.1);
    expect(g(4500)).toBeLessThan(-40);
  });

  it('rejects even lengths', () => {
    expect(() => lowpassFir(64, 3200, FS)).toThrow(RangeError);
  });
});

describe('maxNormalizedAutocorrelation', () => {
  const prefix = new Float64Array(241);

  it('is near 1 for a periodic window and 0 for silence', () => {
    const x = new Float64Array(240);
    for (let i = 0; i < 240; i++) x[i] = Math.sin((2 * Math.PI * i) / 40) + 0.5 * Math.sin((2 * Math.PI * 3 * i) / 40);
    expect(maxNormalizedAutocorrelation(x, 240, 20, 100, prefix)).toBeGreaterThan(0.999);
    expect(maxNormalizedAutocorrelation(new Float64Array(240), 240, 20, 100, prefix)).toBe(0);
  });

  it('stays low on white noise', () => {
    const rng = createRng(3);
    const x = new Float64Array(240);
    for (let i = 0; i < 240; i++) x[i] = gaussian(rng);
    expect(maxNormalizedAutocorrelation(x, 240, 20, 100, prefix)).toBeLessThan(0.4);
  });

  it('always returns a value in [0, 1]', () => {
    fc.assert(
      fc.property(fc.array(fc.double({ min: -1, max: 1, noNaN: true }), { minLength: 120, maxLength: 240 }), (values) => {
        const x = Float64Array.from(values);
        const c = maxNormalizedAutocorrelation(x, x.length, 20, 100, prefix);
        expect(c).toBeGreaterThanOrEqual(0);
        expect(c).toBeLessThanOrEqual(1);
      }),
    );
  });
});

describe('median, select and MAD', () => {
  const sortedMedian = (v: number[]): number => {
    const s = [...v].sort((a, b) => a - b);
    const n = s.length;
    return n % 2 === 1 ? s[(n - 1) / 2]! : (s[n / 2 - 1]! + s[n / 2]!) / 2;
  };

  it('agree with sorting', () => {
    fc.assert(
      fc.property(
        fc.array(fc.double({ min: -1e6, max: 1e6, noNaN: true }), { minLength: 1, maxLength: 300 }),
        fc.nat(),
        (values, kRaw) => {
          const k = kRaw % values.length;
          const sorted = [...values].sort((a, b) => a - b);
          expect(selectInPlace(Float64Array.from(values), values.length, k)).toBe(sorted[k]);
          const med = medianInPlace(Float64Array.from(values), values.length);
          expect(med).toBe(sortedMedian(values));
          const mad = madInPlace(Float64Array.from(values), values.length, med);
          expect(mad).toBe(sortedMedian(values.map((v) => Math.abs(v - med))));
        },
      ),
    );
  });

  it('median of nothing is NaN', () => {
    expect(medianInPlace(new Float64Array(0), 0)).toBeNaN();
  });
});
