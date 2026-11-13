import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import {
  DEFAULT_ONSET_PARAMS,
  computeFeatures,
  findOnset,
  findPaBursts,
  findSessionOnsets,
  findSniffOnset,
  onsetAutoRecord,
  onsetEventFields,
  resolveOnsetConfig,
  type GateOnsetResult,
  type OnsetResult,
} from './index.ts';
import {
  bandNoise,
  breath,
  createRng,
  fricative,
  msToSamples,
  narratorLeak,
  Scene,
  voice,
  type Rng,
} from '../vad/synth.ts';

const MS = 48;
const CUE_MS = 11000; // the dot signal: the search starts here (spec 7.6, gate variant)
const CUE = msToSamples(CUE_MS);
const TOLERANCE = 5 * MS; // spec 7.6: t_v within 5 ms of the truth (assumption)

/** Gate-like channel 0: background at -68 dBFS and the narrator leaking at a low level. */
function gateScene(seed: number, leakDb = -70): { rng: Rng; sc: Scene } {
  const rng = createRng(seed);
  const sc = new Scene(14000).background(-68, rng);
  sc.add(narratorLeak(14000, leakDb, rng), 0);
  return { rng, sc };
}

function mustFind(signal: Float32Array, opts: Parameters<typeof findOnset>[2] = {}): GateOnsetResult {
  const r = findOnset(signal, CUE, opts);
  expect(r).not.toBeNull();
  return r!;
}

describe('DEFAULT_ONSET_PARAMS', () => {
  it('carries the numbers of spec 7.6', () => {
    const p = DEFAULT_ONSET_PARAMS;
    expect([p.highpassHz, p.highpassOrder, p.bandLowHz, p.bandHighHz]).toEqual([80, 4, 150, 8000]);
    expect([p.hopMs, p.energyWindowMs, p.corrWindowMs]).toEqual([1, 10, 30]);
    expect(p.lagMs).toEqual([2.5, 12.5]);
    expect([p.periodicity, p.anchorOverFloorDb]).toEqual([0.5, 15]);
    expect(p.anchorWindows).toEqual([40, 60]);
    expect([p.walkOverFloorDb, p.walkSpreadFactor, p.walkGapMs, p.walkLimitMs]).toEqual([6, 3, 20, 250]);
    expect([p.breathMinMs, p.dipDb, p.dipMinMs]).toEqual([250, 6, 20]);
    expect([p.floorFromMs, p.floorToMs, p.madScale, p.replyMergeGapMs]).toEqual([10000, 1000, 1.4826, 1000]);
  });

  it('rejects inconsistent parameters', () => {
    expect(() => resolveOnsetConfig({ hopMs: 0.7 })).toThrow(RangeError);
    expect(() => resolveOnsetConfig({ anchorWindows: [70, 60] })).toThrow(RangeError);
    expect(() => resolveOnsetConfig({ lagMs: [2.5, 40] })).toThrow(RangeError);
  });
});

describe('features', () => {
  it('frames sit on absolute multiples of the 1 ms step and E reads the band level', () => {
    const rng = createRng(1);
    const sc = new Scene(3000).background(-68, rng);
    const track = computeFeatures(sc.toFloat32(), 0, 1000, 100000, resolveOnsetConfig());
    expect(track.firstEnd).toBe(1008);
    expect(track.frameEnd(10)).toBe(1488);
    // White noise at -68 dBFS keeps (8000 - 150) / 24000 of its power in the 150 Hz-8 kHz band.
    const expected = -68 + 10 * Math.log10(7850 / 24000);
    const mid = track.energyDb[1000]!;
    expect(Math.abs(mid - expected)).toBeLessThan(1.5);
  });
});

describe('findOnset (spec 7.6 tests)', () => {
  it('tone after inhale noise: t_v within 5 ms, the inhale is recorded', () => {
    for (const seed of [1, 2, 3]) {
      const { rng, sc } = gateScene(seed);
      const b0 = sc.add(breath({ durMs: 500, levelDb: -38 }, rng), CUE_MS + 400);
      const truth = sc.add(voice({ durMs: 600, f0Hz: [130, 115], levelDb: -24, attackMs: 3 }, rng), CUE_MS + 1000);
      const r = mustFind(sc.toFloat32());
      expect(Math.abs(r.nV - truth)).toBeLessThanOrEqual(TOLERANCE);
      expect(r.flags).toEqual([]);
      expect(r.breath).not.toBeNull();
      const [bs, be] = r.breath!;
      // The inhale fades in over 60 ms and out over 80 ms.
      expect(bs - b0).toBeGreaterThanOrEqual(0);
      expect(bs - b0).toBeLessThanOrEqual(60 * MS);
      expect(b0 + msToSamples(500) - be).toBeGreaterThanOrEqual(0);
      expect(b0 + msToSamples(500) - be).toBeLessThanOrEqual(80 * MS);
      expect(r.nA).toBeGreaterThanOrEqual(r.nV);
    }
  });

  it('tone without a dip after the inhale: t_v = t_a, flag no_dip, within 5 ms', () => {
    for (const seed of [4, 5, 6]) {
      const { rng, sc } = gateScene(seed);
      const b0 = sc.add(breath({ durMs: 520, levelDb: -38, releaseMs: 5 }, rng), CUE_MS + 480);
      const truth = sc.add(voice({ durMs: 600, f0Hz: [140, 125], levelDb: -24, attackMs: 3 }, rng), CUE_MS + 1000);
      const r = mustFind(sc.toFloat32());
      expect(r.flags).toEqual(['no_dip']);
      expect(r.nV).toBe(r.nA);
      expect(Math.abs(r.nV - truth)).toBeLessThanOrEqual(TOLERANCE);
      expect(r.breath).toEqual([expect.any(Number), r.nA]);
      expect(Math.abs(r.breath![0] - b0)).toBeLessThanOrEqual(60 * MS);
    }
  });

  it('voiceless consonant before the vowel: t_v at the consonant, the anchor in the vowel', () => {
    for (const seed of [7, 8, 9]) {
      const { rng, sc } = gateScene(seed);
      const truth = sc.add(fricative({ durMs: 120, levelDb: -42, attackMs: 3 }, rng), CUE_MS + 1000);
      const vowel = sc.add(voice({ durMs: 500, f0Hz: [150, 130], levelDb: -24, attackMs: 3 }, rng), CUE_MS + 1120);
      const r = mustFind(sc.toFloat32());
      expect(Math.abs(r.nV - truth)).toBeLessThanOrEqual(TOLERANCE);
      expect(r.nA).toBeGreaterThanOrEqual(vowel - TOLERANCE);
      expect(r.breath).toBeNull();
      expect(r.flags).toEqual([]);
    }
  });

  it('an inhale that fades out shortly before the voice is separated by that dip', () => {
    // The fade and a 10-28 ms pause, shorter than the 20 ms the walk back bridges once the
    // windows smear them, fall more than 6 dB under the inhale for 20 ms and reach the background.
    for (const [seed, pauseMs] of [
      [10, 10],
      [11, 20],
      [12, 28],
    ] as const) {
      const { rng, sc } = gateScene(seed);
      const b0 = sc.add(breath({ durMs: 500, levelDb: -38, releaseMs: 60 }, rng), CUE_MS + 500 - pauseMs);
      const truth = sc.add(voice({ durMs: 600, f0Hz: [130, 115], levelDb: -24, attackMs: 3 }, rng), CUE_MS + 1000);
      const r = mustFind(sc.toFloat32());
      expect(Math.abs(r.nV - truth)).toBeLessThanOrEqual(TOLERANCE);
      expect(r.flags).toEqual([]);
      expect(r.breath).not.toBeNull();
      expect(Math.abs(r.breath![0] - b0)).toBeLessThanOrEqual(60 * MS);
      expect(r.breath![1]).toBeLessThan(truth);
    }
  });

  it('a quieter sound glued to the inhale is no dip: t_v = t_a and the flag no_dip', () => {
    // More than 6 dB under the inhale for over 20 ms, but never down toward the background:
    // a soft inhale tail, or a voiceless consonant right after the inhale (spec 7.6).
    for (const seed of [10, 12]) {
      const tail = gateScene(seed);
      const tail0 = tail.sc.add(breath({ durMs: 450, levelDb: -38, releaseMs: 40 }, tail.rng), CUE_MS + 450);
      tail.sc.add(breath({ durMs: 120, levelDb: -52, attackMs: 5, releaseMs: 5 }, tail.rng), CUE_MS + 880);
      const tailVowel = tail.sc.add(voice({ durMs: 600, f0Hz: [130, 115], levelDb: -24, attackMs: 3 }, tail.rng), CUE_MS + 1000);
      const cons = gateScene(seed);
      const cons0 = cons.sc.add(breath({ durMs: 600, levelDb: -43, releaseMs: 5 }, cons.rng), CUE_MS + 300);
      cons.sc.add(fricative({ durMs: 92, levelDb: -50, attackMs: 3, releaseMs: 3 }, cons.rng), CUE_MS + 900);
      const consVowel = cons.sc.add(voice({ durMs: 500, f0Hz: [140, 120], levelDb: -24, attackMs: 3 }, cons.rng), CUE_MS + 992);
      for (const [signal, b0, vowel] of [
        [tail.sc.toFloat32(), tail0, tailVowel],
        [cons.sc.toFloat32(), cons0, consVowel],
      ] as const) {
        const r = mustFind(signal);
        expect(r.flags).toEqual(['no_dip']);
        expect(r.nV).toBe(r.nA);
        expect(Math.abs(r.nA - vowel)).toBeLessThanOrEqual(TOLERANCE);
        expect(Math.abs(r.breath![0] - b0)).toBeLessThanOrEqual(60 * MS);
        expect(r.breath![1]).toBe(r.nA);
      }
    }
  });

  it('a voiceless consonant after the inhale and a short pause: t_v at the consonant', () => {
    // The pause reaches the background, so the dip ends there; the consonant, 8 dB under the
    // inhale, starts the segment after it.
    for (const seed of [10, 11, 12]) {
      const { rng, sc } = gateScene(seed);
      const b0 = sc.add(breath({ durMs: 600, levelDb: -40, releaseMs: 20 }, rng), CUE_MS + 280);
      const truth = sc.add(fricative({ durMs: 100, levelDb: -48, attackMs: 3, releaseMs: 3 }, rng), CUE_MS + 900);
      const vowel = sc.add(voice({ durMs: 500, f0Hz: [140, 120], levelDb: -24, attackMs: 3 }, rng), CUE_MS + 1000);
      const r = mustFind(sc.toFloat32());
      expect(Math.abs(r.nV - truth)).toBeLessThanOrEqual(TOLERANCE);
      expect(r.flags).toEqual([]);
      expect(r.nA).toBeGreaterThanOrEqual(vowel - TOLERANCE);
      expect(Math.abs(r.breath![0] - b0)).toBeLessThanOrEqual(60 * MS);
      expect(r.breath![1]).toBeLessThan(truth);
    }
  });

  it('inhale noise under 400 Hz, then a pause and the voice: within 5 ms at a raised c threshold', () => {
    // Narrow low-frequency noise has few degrees of freedom in a 30 ms window, so its c reaches
    // 0.5 by chance: at the spec's 0.5, 4 of 60 such inhales (seeds 41-100, -36 dBFS) gave an
    // anchor inside the noise, seed 41 at -30 dBFS among them; at 0.55-0.7 none did. A raised
    // threshold like doctor's tuned one (spec 7.12) is passed as params.periodicity.
    for (const levelDb of [-30, -36]) {
      for (const seed of [41, 42, 43, 44, 45, 46]) {
        const { rng, sc } = gateScene(seed);
        const b0 = sc.add(bandNoise({ durMs: 600, levelDb, lowHz: 20, highHz: 400, attackMs: 60, releaseMs: 60 }, rng), CUE_MS + 360);
        const truth = sc.add(voice({ durMs: 600, f0Hz: [130, 115], levelDb: -24, attackMs: 3 }, rng), CUE_MS + 1000);
        const r = mustFind(sc.toFloat32(), { params: { periodicity: 0.6 } });
        expect(Math.abs(r.nV - truth)).toBeLessThanOrEqual(TOLERANCE);
        expect(r.flags).toEqual([]);
        expect(r.breath).not.toBeNull();
        expect(Math.abs(r.breath![0] - b0)).toBeLessThanOrEqual(80 * MS);
      }
    }
  });

  it('noise shorter than 250 ms right before the vowel counts as a consonant, not an inhale', () => {
    const { rng, sc } = gateScene(11);
    const truth = sc.add(breath({ durMs: 200, levelDb: -40, attackMs: 3, releaseMs: 5 }, rng), CUE_MS + 800);
    sc.add(voice({ durMs: 500, f0Hz: 130, levelDb: -24, attackMs: 3 }, rng), CUE_MS + 1000);
    const r = mustFind(sc.toFloat32());
    expect(Math.abs(r.nV - truth)).toBeLessThanOrEqual(TOLERANCE);
    expect(r.breath).toBeNull();
    expect(r.flags).toEqual([]);
  });

  it('a clean tone after silence: within 5 ms, over the 100-200 Hz range of fundamentals', () => {
    for (const f0 of [100, 140, 200]) {
      const { rng, sc } = gateScene(f0);
      const truth = sc.add(voice({ durMs: 500, f0Hz: f0, levelDb: -26, attackMs: 3 }, rng), CUE_MS + 1000);
      const r = mustFind(sc.toFloat32());
      expect(Math.abs(r.nV - truth)).toBeLessThanOrEqual(TOLERANCE);
      expect(r.walkLimited).toBe(false);
    }
  });

  it('soft onsets read late by the time E needs to rise 6 dB over N (documented bias)', () => {
    // A raised-cosine attack starts from 0: the slower the attack and the quieter the voice, the
    // later the 10 ms window crosses the walk threshold. Bound for the tests (assumption): never
    // early, at most 5 ms plus 30 % of the attack late.
    for (const levelDb of [-24, -40]) {
      for (const attackMs of [10, 20, 30]) {
        const { rng, sc } = gateScene(1000 * attackMs - levelDb);
        const f0 = 100 + rng() * 100;
        const truth = sc.add(voice({ durMs: 500, f0Hz: [f0 * 1.05, f0 * 0.92], levelDb, attackMs }, rng), CUE_MS + 1000);
        const r = mustFind(sc.toFloat32());
        expect(r.nV - truth).toBeGreaterThanOrEqual(0);
        expect(r.nV - truth).toBeLessThanOrEqual((5 + 0.3 * attackMs) * MS);
      }
    }
  });

  it('a strong narrator leak (6 dB over background, the doctor limit) still gives voice onsets within 5 ms', () => {
    for (const seed of [13, 14]) {
      const { rng, sc } = gateScene(seed, -63);
      sc.add(breath({ durMs: 500, levelDb: -38 }, rng), CUE_MS + 400);
      const truth = sc.add(voice({ durMs: 600, f0Hz: [125, 110], levelDb: -24, attackMs: 3 }, rng), CUE_MS + 1000);
      const r = mustFind(sc.toFloat32());
      expect(Math.abs(r.nV - truth)).toBeLessThanOrEqual(TOLERANCE);
    }
  });
});

describe('findOnset edge cases', () => {
  it('returns null for silence only, background only, and inhales only', () => {
    expect(findOnset(new Float32Array(msToSamples(14000)), CUE)).toBeNull();
    const { sc } = gateScene(20);
    expect(findOnset(sc.toFloat32(), CUE)).toBeNull();
    const inhales = gateScene(21);
    for (const at of [400, 2500, 5000]) inhales.sc.add(breath({ durMs: 800, levelDb: -32 }, inhales.rng), CUE_MS + at);
    expect(findOnset(inhales.sc.toFloat32(), CUE)).toBeNull();
  });

  it('returns null when the voice comes after the search window', () => {
    const { rng, sc } = gateScene(22);
    sc.add(voice({ durMs: 500, f0Hz: 130, levelDb: -24 }, rng), CUE_MS + 1000);
    expect(findOnset(sc.toFloat32(), CUE, { searchToSample: CUE + 900 * MS })).toBeNull();
    expect(findOnset(sc.toFloat32(), CUE)).not.toBeNull();
  });

  it('a reply that only paused at the dot signal began before it (spec 4.2, 4.5)', () => {
    for (const [pauseMs, before] of [
      [700, true],
      [1500, false],
    ] as const) {
      const { rng, sc } = gateScene(28);
      const early = sc.add(voice({ durMs: 300, f0Hz: 125, levelDb: -26, attackMs: 3 }, rng), CUE_MS + 400 - pauseMs - 300);
      const truth = sc.add(voice({ durMs: 500, f0Hz: 130, levelDb: -24, attackMs: 3 }, rng), CUE_MS + 400);
      const r = mustFind(sc.toFloat32());
      expect(Math.abs(r.nV - truth)).toBeLessThanOrEqual(TOLERANCE);
      expect(r.beganBeforeSearch).toBe(before);
      if (before) {
        // The earlier word joins the reply: its start and voiced time count.
        expect(Math.abs(r.reply.start - early)).toBeLessThanOrEqual(TOLERANCE);
        expect(r.reply.segments).toHaveLength(2);
        expect(r.reply.voicedMs).toBeGreaterThan(760);
      } else {
        expect(r.reply.start).toBeGreaterThanOrEqual(r.nV);
        expect(r.reply.voicedMs).toBeLessThan(520);
      }
    }
  });

  it('a voice going on at the dot signal gives n_v before it', () => {
    const { rng, sc } = gateScene(29);
    sc.add(voice({ durMs: 2000, f0Hz: [130, 110], levelDb: -24, attackMs: 3 }, rng), CUE_MS - 1000);
    const r = mustFind(sc.toFloat32());
    expect(r.nV).toBeLessThan(CUE);
    expect(r.beganBeforeSearch).toBe(true);
  });

  it('the 10 s limit applies to n_v, not to the anchor', () => {
    const run = (consonantAtMs: number): GateOnsetResult | null => {
      const rng = createRng(30);
      const sc = new Scene(CUE_MS + 13000).background(-68, rng);
      sc.add(narratorLeak(CUE_MS + 13000, -70, rng), 0);
      sc.add(fricative({ durMs: 150, levelDb: -42, attackMs: 3 }, rng), consonantAtMs);
      sc.add(voice({ durMs: 500, f0Hz: [150, 130], levelDb: -24, attackMs: 3 }, rng), consonantAtMs + 150);
      return findOnset(sc.toFloat32(), CUE);
    };
    // The consonant starts 30 ms before the limit, the vowel and its anchor after it.
    const inTime = run(CUE_MS + 10000 - 30);
    expect(inTime).not.toBeNull();
    expect(Math.abs(inTime!.nV - msToSamples(CUE_MS + 10000 - 30))).toBeLessThanOrEqual(TOLERANCE);
    expect(inTime!.nA).toBeGreaterThan(CUE + msToSamples(10000));
    expect(run(CUE_MS + 10000 + 30)).toBeNull();
  });

  it('copes with clipping and with a DC offset', () => {
    const { rng, sc } = gateScene(23);
    const truth = sc.add(voice({ durMs: 600, f0Hz: [130, 115], levelDb: -3, attackMs: 3 }, rng), CUE_MS + 1000);
    const clipped = mustFind(sc.toFloat32(0.25));
    expect(Math.abs(clipped.nV - truth)).toBeLessThanOrEqual(TOLERANCE);

    const plain = mustFind(sc.toFloat32());
    const withDc = mustFind(sc.dc(0.3).toFloat32());
    expect(withDc.nV).toBe(plain.nV);
    expect(withDc.nA).toBe(plain.nA);
  });

  it('does not depend on the recording gain (fast-check)', () => {
    const { rng, sc } = gateScene(24);
    sc.add(breath({ durMs: 500, levelDb: -38 }, rng), CUE_MS + 400);
    sc.add(voice({ durMs: 600, f0Hz: 130, levelDb: -24, attackMs: 3 }, rng), CUE_MS + 1000);
    const signal = sc.toFloat32();
    const base = mustFind(signal);
    fc.assert(
      fc.property(fc.double({ min: 0.05, max: 12, noNaN: true }), (gain) => {
        const r = mustFind(signal.map((v) => v * gain));
        expect(r.nV).toBe(base.nV);
        expect(r.nA).toBe(base.nA);
        expect(r.breath).toEqual(base.breath);
        expect(r.floorDb - base.floorDb).toBeCloseTo(20 * Math.log10(gain), 3);
      }),
      { numRuns: 8 },
    );
  });

  it('works on absolute sample numbers: n0 shifts the answer', () => {
    const { rng, sc } = gateScene(25);
    sc.add(voice({ durMs: 500, f0Hz: 130, levelDb: -24, attackMs: 3 }, rng), CUE_MS + 1000);
    const signal = sc.toFloat32();
    const base = mustFind(signal);
    const offset = 48 * 123456;
    const shifted = findOnset(signal, CUE + offset, { n0: offset });
    const r = base.reply;
    expect(shifted).toEqual({
      ...base,
      nV: base.nV + offset,
      nA: base.nA + offset,
      reply: {
        ...r,
        start: r.start + offset,
        end: r.end + offset,
        segments: r.segments.map(([a, b]) => [a + offset, b + offset]),
      },
    });
  });

  it('measures the floor only where the narrator reads and nobody speaks', () => {
    const { rng, sc } = gateScene(26);
    const loudFrom = sc.add(voice({ durMs: 5000, f0Hz: [120, 100], levelDb: -30, attackMs: 20 }, rng), CUE_MS - 7000);
    const truth = sc.add(voice({ durMs: 500, f0Hz: 130, levelDb: -24, attackMs: 3 }, rng), CUE_MS + 1000);
    const signal = sc.toFloat32();
    // Without the reply mask the earlier speech fills most of the floor window and lifts N.
    const unmasked = findOnset(signal, CUE);
    expect(unmasked === null || unmasked.floorDb > -50).toBe(true);
    const masked = mustFind(signal, { replies: [[loudFrom, loudFrom + msToSamples(5000)]] });
    expect(masked.floorDb).toBeLessThan(-60);
    expect(Math.abs(masked.nV - truth)).toBeLessThanOrEqual(TOLERANCE);
    // Reading mask that excludes the speech gives the same floor.
    const reading = mustFind(signal, { reading: [[0, loudFrom], [loudFrom + msToSamples(5000), signal.length]] });
    expect(reading.floorDb).toBeCloseTo(masked.floorDb, 6);
  });

  it('rejects positions that are not finite sample numbers, in every finder', () => {
    const signal = new Float32Array(msToSamples(3000));
    expect(() => findOnset(signal, Number.NaN)).toThrow(/findOnset: searchFromSample/);
    expect(() => findOnset(signal, 0, { n0: 0.5 })).toThrow(/findOnset: n0/);
    expect(() => findSniffOnset(signal, Number.NaN)).toThrow(/findSniffOnset: searchFromSample/);
    expect(() => findSniffOnset(signal, 1000, { floorToSample: Number.POSITIVE_INFINITY })).toThrow(RangeError);
    expect(() => findPaBursts(signal, 0, Number.NaN)).toThrow(/findPaBursts: toSample/);
    expect(() => findSessionOnsets(signal, { fromSample: Number.NaN })).toThrow(/findSessionOnsets: fromSample/);
  });

  it('a NaN or infinite sample counts as 0: in the floor window, before the voice and at the ends', () => {
    const { rng, sc } = gateScene(31);
    sc.add(breath({ durMs: 500, levelDb: -38 }, rng), CUE_MS + 400);
    const truth = sc.add(voice({ durMs: 600, f0Hz: [130, 115], levelDb: -24, attackMs: 3 }, rng), CUE_MS + 1000);
    const signal = sc.toFloat32();
    const bad = [0, msToSamples(5000), truth - msToSamples(500), truth + msToSamples(100), signal.length - 1];
    const broken = signal.slice();
    const zeroed = signal.slice();
    bad.forEach((n, i) => {
      broken[n] = [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY][i % 3]!;
      zeroed[n] = 0;
    });
    const r = mustFind(broken);
    expect(r).toEqual(mustFind(zeroed));
    expect(Number.isFinite(r.floorDb)).toBe(true);
    expect(Math.abs(r.nV - truth)).toBeLessThanOrEqual(TOLERANCE);
  });

  it('accepts a fixed floor', () => {
    const { rng, sc } = gateScene(27);
    const truth = sc.add(voice({ durMs: 500, f0Hz: 130, levelDb: -24, attackMs: 3 }, rng), CUE_MS + 1000);
    const r = mustFind(sc.toFloat32(), { floorDb: -72, floorSpreadDb: 1 });
    expect(r.floorDb).toBe(-72);
    expect(r.thresholdDb).toBe(-66);
    expect(Math.abs(r.nV - truth)).toBeLessThanOrEqual(TOLERANCE);
  });
});

describe('onsetAutoRecord', () => {
  it('maps a result to the auto object of onsets.json (spec 8.1)', () => {
    const r: OnsetResult = {
      nV: 8656704,
      nA: 8657664,
      breath: [8626560, 8651424],
      flags: ['no_dip'],
      floorDb: -57.9,
      floorSpreadDb: 1.2,
      thresholdDb: -51.9,
      walkLimited: false,
    };
    expect(onsetAutoRecord(r)).toEqual({ n_v: 8656704, n_a: 8657664, breath: [8626560, 8651424], flags: ['no_dip'] });
    expect(onsetAutoRecord({ ...r, breath: null, flags: [] })).toEqual({ n_v: 8656704, n_a: 8657664, breath: null, flags: [] });
  });

  it('onsetEventFields rounds voiced_ms and floor_db to 0.1 and gives the last sample of the reply', () => {
    const r: OnsetResult = {
      nV: 8656704,
      nA: 8657664,
      breath: null,
      flags: [],
      floorDb: -57.9349,
      floorSpreadDb: 1.2,
      thresholdDb: -51.9,
      walkLimited: false,
    };
    expect(onsetEventFields(r, { voicedMs: 640.02, end: 8700000 })).toEqual({
      voiced_ms: 640,
      floor_db: -57.9,
      n_end: 8699999,
      auto: { n_v: 8656704, n_a: 8657664, breath: null, flags: [] },
    });
  });
});
