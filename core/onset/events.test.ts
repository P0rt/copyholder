import { describe, expect, it } from 'vitest';
import { DEFAULT_SNIFF_PARAMS, findPaBursts, findSniffOnset } from './index.ts';
import { bandNoise, breath, createRng, gaussian, msToSamples, narratorLeak, paSyllable, Scene, sniff, type Rng } from '../vad/synth.ts';

const MS = 48;
const BACKGROUND_DB = -68;

/** A 3 ms click (lips parting, a tongue click): decaying noise with RMS `levelDb` dB re full scale. */
function click(levelDb: number, rng: Rng): Float64Array {
  const x = new Float64Array(msToSamples(3));
  for (let i = 0; i < x.length; i++) x[i] = gaussian(rng) * Math.exp(-i / (0.8 * MS));
  let s = 0;
  for (const v of x) s += v * v;
  const g = Math.pow(10, levelDb / 20) / Math.sqrt(s / x.length);
  return x.map((v) => v * g);
}

/** `signal` with NaN and infinite samples at `at`, and the same signal with zeros there. */
function withBadSamples(signal: Float32Array, at: readonly number[]): { broken: Float32Array; zeroed: Float32Array } {
  const broken = signal.slice();
  const zeroed = signal.slice();
  at.forEach((n, i) => {
    broken[n] = [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY][i % 3]!;
    zeroed[n] = 0;
  });
  return { broken, zeroed };
}

describe('findSniffOnset (spec 6.3)', () => {
  it('carries the numbers of spec 6.3', () => {
    const p = DEFAULT_SNIFF_PARAMS;
    expect([p.highpassHz, p.envelopeMs, p.overFloorDb, p.holdMs]).toEqual([1000, 5, 12, 20]);
  });

  /**
   * Five sniffs as in the gate (spec 9.3): `Breathe out and wait` at P, an audible exhale, then
   * `Sniff` 1.5 s after P and the sniff 0.3-0.7 s later.
   */
  function sniffBlock(seed: number): { signal: Float32Array; prompts: number[]; truths: number[] } {
    const rng = createRng(seed);
    const sc = new Scene(25000).background(BACKGROUND_DB, rng);
    const prompts: number[] = [];
    const truths: number[] = [];
    for (let i = 0; i < 5; i++) {
      const p = 1000 + i * 4400;
      sc.add(breath({ durMs: 1000, levelDb: -48, attackMs: 80, releaseMs: 200 }, rng), p + 300);
      prompts.push(msToSamples(p + 1500));
      truths.push(sc.add(sniff({ levelDb: -36 - rng() * 8 }, rng), p + 1800 + rng() * 400));
    }
    return { signal: sc.toFloat32(), prompts, truths };
  }

  it('finds each sniff within 5 ms; the exhale in the floor window does not lift the floor', () => {
    for (const seed of [1, 2, 3]) {
      const { signal, prompts, truths } = sniffBlock(seed);
      prompts.forEach((prompt, i) => {
        const r = findSniffOnset(signal, prompt);
        expect(r).not.toBeNull();
        expect(r!.n - truths[i]!).toBeGreaterThanOrEqual(0);
        expect(r!.n - truths[i]!).toBeLessThanOrEqual(5 * MS);
        // White noise at -68 dBFS keeps 23/24 of its power above 1 kHz.
        expect(Math.abs(r!.floorDb - BACKGROUND_DB)).toBeLessThan(1.5);
        expect(r!.peakDb).toBeGreaterThan(r!.floorDb + 12);
      });
    }
  });

  it('a median floor would sit on the exhale: why the floor is a low quantile (assumption)', () => {
    const { signal, prompts } = sniffBlock(4);
    // The 1.5 s wait alone, where the exhale fills 1 s.
    const median = findSniffOnset(signal, prompts[0]!, { params: { floorQuantile: 0.5, floorWindowMs: 1500 } });
    const quantile = findSniffOnset(signal, prompts[0]!);
    expect(quantile).not.toBeNull();
    expect(median === null || median.floorDb > quantile!.floorDb + 10).toBe(true);
  });

  it('an exhale that fills the whole wait and runs past the prompt does not become the floor', () => {
    for (const seed of [1, 2, 3]) {
      const rng = createRng(seed);
      const sc = new Scene(9000).background(BACKGROUND_DB, rng);
      // Exhale from 0.2 s after `Breathe out and wait` to 0.2 s after `Sniff`, then the sniff.
      sc.add(breath({ durMs: 1500, levelDb: -44, attackMs: 80, releaseMs: 150 }, rng), 4200);
      const truth = sc.add(sniff({ levelDb: -40 }, rng), 5800 + rng() * 300);
      const r = findSniffOnset(sc.toFloat32(), msToSamples(5500));
      expect(r).not.toBeNull();
      expect(r!.n - truth).toBeGreaterThanOrEqual(0);
      expect(r!.n - truth).toBeLessThanOrEqual(5 * MS);
      expect(Math.abs(r!.floorDb - BACKGROUND_DB)).toBeLessThan(1.5);
    }
  });

  it('a sound already going at the search start is not an onset: the next crossing is', () => {
    const rng = createRng(5);
    const sc = new Scene(6000).background(BACKGROUND_DB, rng);
    sc.add(breath({ durMs: 700, levelDb: -42, attackMs: 50, releaseMs: 60 }, rng), 2500);
    const truth = sc.add(sniff({ levelDb: -36 }, rng), 3800);
    const r = findSniffOnset(sc.toFloat32(), msToSamples(3000), { floorFromSample: msToSamples(1000), floorToSample: msToSamples(2400) });
    expect(r).not.toBeNull();
    expect(r!.n - truth).toBeGreaterThanOrEqual(0);
    expect(r!.n - truth).toBeLessThanOrEqual(5 * MS);
  });

  it('needs the threshold held 20 ms: a click is not a sniff', () => {
    const rng = createRng(6);
    const sc = new Scene(5000).background(BACKGROUND_DB, rng);
    const click = new Float64Array(msToSamples(3));
    for (let i = 0; i < click.length; i++) click[i] = 0.05 * Math.sin(i) * Math.exp(-i / 20);
    sc.add(click, 2500);
    const truth = sc.add(sniff({ levelDb: -38 }, rng), 3200);
    const r = findSniffOnset(sc.toFloat32(), msToSamples(2000));
    expect(Math.abs(r!.n - truth)).toBeLessThanOrEqual(5 * MS);
  });

  it('returns null for silence only, background only, and a sniff after the search window', () => {
    expect(findSniffOnset(new Float32Array(msToSamples(5000)), msToSamples(2000))).toBeNull();
    const rng = createRng(7);
    const sc = new Scene(6000).background(BACKGROUND_DB, rng);
    expect(findSniffOnset(sc.toFloat32(), msToSamples(2000))).toBeNull();
    sc.add(sniff({ levelDb: -36 }, rng), 4500);
    expect(findSniffOnset(sc.toFloat32(), msToSamples(2000))).toBeNull();
    expect(findSniffOnset(sc.toFloat32(), msToSamples(2000), { searchToSample: msToSamples(5000) })).not.toBeNull();
  });

  it('copes with clipping, a DC offset and absolute sample numbers', () => {
    const rng = createRng(8);
    const sc = new Scene(6000).background(BACKGROUND_DB, rng);
    const truth = sc.add(sniff({ levelDb: -6 }, rng), 3300);
    const plain = findSniffOnset(sc.toFloat32(), msToSamples(3000))!;
    expect(Math.abs(plain.n - truth)).toBeLessThanOrEqual(5 * MS);
    const clipped = findSniffOnset(sc.toFloat32(0.2), msToSamples(3000))!;
    expect(Math.abs(clipped.n - truth)).toBeLessThanOrEqual(5 * MS);
    const withDc = findSniffOnset(sc.dc(0.25).toFloat32(), msToSamples(3000))!;
    expect(withDc.n).toBe(plain.n);
    const offset = 48000 * 600;
    const shifted = findSniffOnset(sc.toFloat32(), msToSamples(3000) + offset, { n0: offset })!;
    expect(shifted.n).toBe(withDc.n + offset);
  });

  it('accepts a fixed floor', () => {
    const rng = createRng(9);
    const sc = new Scene(6000).background(BACKGROUND_DB, rng);
    const truth = sc.add(sniff({ levelDb: -40 }, rng), 3300);
    const r = findSniffOnset(sc.toFloat32(), msToSamples(3000), { floorDb: -70 })!;
    expect(r.floorDb).toBe(-70);
    expect(Math.abs(r.n - truth)).toBeLessThanOrEqual(5 * MS);
  });

  it('a NaN or infinite sample counts as 0, in the floor window and in the search', () => {
    const rng = createRng(10);
    const sc = new Scene(6000).background(BACKGROUND_DB, rng);
    const truth = sc.add(sniff({ levelDb: -38 }, rng), 3300);
    const signal = sc.toFloat32();
    const { broken, zeroed } = withBadSamples(signal, [0, msToSamples(1500), msToSamples(3100), truth + 100, signal.length - 1]);
    const r = findSniffOnset(broken, msToSamples(3000));
    expect(r).toEqual(findSniffOnset(zeroed, msToSamples(3000)));
    expect(Math.abs(r!.n - truth)).toBeLessThanOrEqual(5 * MS);
    expect(Math.abs(r!.floorDb - BACKGROUND_DB)).toBeLessThan(1.5);
  });
});

describe('findPaBursts (spec 6.3, 7.12 condition 7)', () => {
  /** A 15 s block of 5 'pa' from closed lips (spec 9.3), some after an audible inhale. */
  function paBlock(
    rng: Rng,
    sc: Scene,
    startMs: number,
    syllables = 5,
  ): number[] {
    const truths: number[] = [];
    for (let i = 0; i < syllables; i++) {
      const t = startMs + 1500 + i * 3000 + rng() * 400;
      if (i % 2 === 0) sc.add(breath({ durMs: 400, levelDb: -42 }, rng), t - 900);
      const f0 = 100 + rng() * 100;
      const votMs = [15, 40, 60, 25, 50][i % 5]!;
      truths.push(sc.add(paSyllable({ levelDb: -26 + rng() * 6, f0Hz: [f0, f0 * 0.9], votMs }, rng), t));
    }
    return truths;
  }

  it('counts the 5 bursts of each block and places them within 2 ms', () => {
    for (const seed of [1, 2, 3]) {
      const rng = createRng(seed);
      const sc = new Scene(50000).background(BACKGROUND_DB, rng);
      const start = paBlock(rng, sc, 0);
      const end = paBlock(rng, sc, 33000);
      const signal = sc.toFloat32();
      for (const [from, truths] of [
        [0, start],
        [33000, end],
      ] as const) {
        const r = findPaBursts(signal, msToSamples(from), msToSamples(from + 17000));
        expect(r.syllables).toBe(5);
        expect(r.bursts).toHaveLength(5);
        r.bursts.forEach((b, i) => {
          expect(Math.abs(b.n - truths[i]!)).toBeLessThanOrEqual(2 * MS);
          expect(b.nA).toBeGreaterThan(b.n);
          expect(b.voicedMs).toBeGreaterThan(150);
        });
      }
    }
  });

  it('finds the burst when weak aspiration around the walk threshold separates it from the vowel', () => {
    // Aspiration 45 dB under the vowel sits near N + 6 dB: the 7.6 walk back alone stops
    // inside it, up to the VOT after the burst.
    for (const seed of [1, 2, 3]) {
      const rng = createRng(seed);
      const sc = new Scene(17000).background(BACKGROUND_DB, rng);
      const truths: number[] = [];
      for (let i = 0; i < 5; i++) {
        const f0 = 100 + rng() * 100;
        const pa = paSyllable({ levelDb: -26 + rng() * 4, f0Hz: [f0, f0 * 0.9], votMs: [60, 80, 70][i % 3]!, aspirationRelDb: -45, burstRelDb: -10 }, rng);
        truths.push(sc.add(pa, 1500 + i * 3000 + rng() * 400));
      }
      const r = findPaBursts(sc.toFloat32(), 0, msToSamples(17000));
      expect(r.bursts).toHaveLength(5);
      r.bursts.forEach((b, i) => expect(Math.abs(b.n - truths[i]!)).toBeLessThanOrEqual(2 * MS));
    }
  });

  it('an inhale that ends just before the closure is not taken for the burst', () => {
    for (const seed of [1, 2]) {
      const rng = createRng(seed);
      const sc = new Scene(8000).background(BACKGROUND_DB, rng);
      sc.add(breath({ durMs: 500, levelDb: -40, releaseMs: 10 }, rng), 1450);
      const truth = sc.add(paSyllable({ levelDb: -24, f0Hz: 120, votMs: 50 }, rng), 2000);
      const r = findPaBursts(sc.toFloat32(), 0, msToSamples(8000));
      expect(r.syllables).toBe(1);
      expect(r.bursts).toHaveLength(1);
      expect(Math.abs(r.bursts[0]!.n - truth)).toBeLessThanOrEqual(2 * MS);
    }
  });

  it('a click or a nasal breath before the closure is never taken for the burst', () => {
    // The closure silence between them stops the step back over the aspiration, so the burst
    // stays the first sound after the closure (spec 6.3), with strong and with weak aspiration.
    for (const seed of [1, 2, 3]) {
      for (const before of ['click', 'nasal'] as const) {
        for (const weak of [false, true]) {
          const rng = createRng(seed);
          const sc = new Scene(17000).background(BACKGROUND_DB, rng);
          const truths: number[] = [];
          for (let i = 0; i < 5; i++) {
            const t = 1500 + i * 3000 + rng() * 400;
            const f0 = 100 + rng() * 100;
            // 40-120 ms before the burst, inside the 150 ms the burst may lead the anchor.
            const leadMs = 40 + 20 * i;
            if (before === 'click') sc.add(click(-40, rng), t - leadMs);
            else sc.add(bandNoise({ durMs: 60, levelDb: -48, lowHz: 300, highHz: 3000, attackMs: 5, releaseMs: 10 }, rng), t - leadMs - 60);
            const pa = weak
              ? paSyllable({ levelDb: -26 + rng() * 4, f0Hz: [f0, f0 * 0.9], votMs: [60, 80, 70][i % 3]!, aspirationRelDb: -45, burstRelDb: -10 }, rng)
              : paSyllable({ levelDb: -26 + rng() * 6, f0Hz: [f0, f0 * 0.9], votMs: [15, 40, 60, 25, 50][i]! }, rng);
            truths.push(sc.add(pa, t));
          }
          const r = findPaBursts(sc.toFloat32(), 0, msToSamples(17000));
          expect(r.syllables).toBe(5);
          expect(r.bursts).toHaveLength(5);
          r.bursts.forEach((b, i) => expect(Math.abs(b.n - truths[i]!)).toBeLessThanOrEqual(2 * MS));
        }
      }
    }
  });

  it('a NaN or infinite sample counts as 0', () => {
    const rng = createRng(9);
    const sc = new Scene(17000).background(BACKGROUND_DB, rng);
    const truths = paBlock(rng, sc, 0);
    const signal = sc.toFloat32();
    const { broken, zeroed } = withBadSamples(signal, [0, msToSamples(1000), truths[1]! - msToSamples(200), truths[3]! + msToSamples(100), signal.length - 1]);
    const r = findPaBursts(broken, 0, msToSamples(17000));
    expect(r).toEqual(findPaBursts(zeroed, 0, msToSamples(17000)));
    expect(r.bursts).toHaveLength(5);
    r.bursts.forEach((b, i) => expect(Math.abs(b.n - truths[i]!)).toBeLessThanOrEqual(2 * MS));
  });

  it('reports a block with a missing syllable as 4 bursts', () => {
    const rng = createRng(4);
    const sc = new Scene(17000).background(BACKGROUND_DB, rng);
    const truths = paBlock(rng, sc, 0, 4);
    const r = findPaBursts(sc.toFloat32(), 0, msToSamples(17000));
    expect(r.syllables).toBe(4);
    expect(r.bursts).toHaveLength(4);
    r.bursts.forEach((b, i) => expect(Math.abs(b.n - truths[i]!)).toBeLessThanOrEqual(2 * MS));
  });

  it("a vowel that rises out of inhale noise without a closure has no burst: syllable, not burst", () => {
    const rng = createRng(5);
    const sc = new Scene(8000).background(BACKGROUND_DB, rng);
    const truth = sc.add(paSyllable({ levelDb: -24, f0Hz: 120 }, rng), 2000);
    sc.add(breath({ durMs: 600, levelDb: -40, releaseMs: 5 }, rng), 4400);
    sc.add(paSyllable({ levelDb: -24, f0Hz: 120, votMs: 0, burstRelDb: -60, aspirationRelDb: -60 }, rng), 5000);
    const r = findPaBursts(sc.toFloat32(), 0, msToSamples(8000));
    expect(r.syllables).toBe(2);
    expect(r.bursts).toHaveLength(1);
    expect(Math.abs(r.bursts[0]!.n - truth)).toBeLessThanOrEqual(2 * MS);
  });

  it('finds nothing in silence or background, and survives clipping and a DC offset', () => {
    expect(findPaBursts(new Float32Array(msToSamples(15000)), 0, msToSamples(15000)).bursts).toEqual([]);
    const rng = createRng(6);
    const sc = new Scene(17000).background(BACKGROUND_DB, rng);
    expect(findPaBursts(sc.toFloat32(), 0, msToSamples(17000)).bursts).toEqual([]);
    const truths = paBlock(rng, sc, 0);
    const plain = findPaBursts(sc.toFloat32(), 0, msToSamples(17000));
    const clipped = findPaBursts(sc.toFloat32(0.02), 0, msToSamples(17000));
    expect(clipped.bursts).toHaveLength(5);
    clipped.bursts.forEach((b, i) => expect(Math.abs(b.n - truths[i]!)).toBeLessThanOrEqual(2 * MS));
    const withDc = findPaBursts(sc.dc(-0.3).toFloat32(), 0, msToSamples(17000));
    expect(withDc.bursts.map((b) => b.n)).toEqual(plain.bursts.map((b) => b.n));
  });

  it('ignores a weak narrator leak', () => {
    const rng = createRng(7);
    const sc = new Scene(17000).background(BACKGROUND_DB, rng);
    sc.add(narratorLeak(17000, -72, rng), 0);
    const truths = paBlock(rng, sc, 0);
    const r = findPaBursts(sc.toFloat32(), 0, msToSamples(17000));
    expect(r.bursts).toHaveLength(5);
    r.bursts.forEach((b, i) => expect(Math.abs(b.n - truths[i]!)).toBeLessThanOrEqual(2 * MS));
  });

  it('gives no burst rather than a wrong one when the walk back cannot leave the vowel', () => {
    const rng = createRng(8);
    const sc = new Scene(17000).background(BACKGROUND_DB, rng);
    const truths = paBlock(rng, sc, 0);
    const signal = sc.toFloat32();
    const floorDb = findPaBursts(signal, 0, msToSamples(17000)).floorDb;
    // s_N = 10 dB: the walk threshold N + 30 dB is above the aspirations, so the walk back stops
    // in the vowel; the burst above that threshold is still found as the first sound after the
    // closure, and every burst reported is right.
    const some = findPaBursts(signal, 0, msToSamples(17000), { floorDb, floorSpreadDb: 10 });
    expect(some.syllables).toBe(5);
    expect(some.bursts.length).toBeGreaterThanOrEqual(4);
    // The higher threshold is crossed a little later into the burst.
    for (const b of some.bursts) expect(Math.min(...truths.map((t) => Math.abs(b.n - t)))).toBeLessThanOrEqual(5 * MS);
    // s_N = 14 dB: N + 42 dB is above the bursts and the aspiration: no burst, never the vowel onset.
    const high = findPaBursts(signal, 0, msToSamples(17000), { floorDb, floorSpreadDb: 14 });
    expect(high.syllables).toBe(5);
    for (const b of high.bursts) expect(Math.min(...truths.map((t) => Math.abs(b.n - t)))).toBeLessThanOrEqual(5 * MS);
    // s_N = 20 dB: the threshold is above the vowel itself, so the walk back never starts.
    const none = findPaBursts(signal, 0, msToSamples(17000), { floorDb, floorSpreadDb: 20 });
    expect(none.syllables).toBe(5);
    expect(none.bursts).toEqual([]);
  });
});
