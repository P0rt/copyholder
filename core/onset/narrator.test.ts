import { describe, expect, it } from 'vitest';
import { findOnset, narratorSoundSpans, type SampleSpan } from './index.ts';
import { measureFloorDb, vadStepFeatures } from '../vad/index.ts';
import { createRng, msToSamples, Scene, voice, type Rng } from '../vad/synth.ts';

const MS = 48;
const TOLERANCE = 5 * MS; // spec 7.6: t_v within 5 ms of the truth (assumption)

/** A tone of amplitude `amp` over [fromMs, toMs) of a buffer `durMs` long. */
function toneBursts(durMs: number, bursts: ReadonlyArray<readonly [fromMs: number, toMs: number, amp: number]>): Float32Array {
  const x = new Float32Array(msToSamples(durMs));
  for (const [a, b, amp] of bursts) {
    for (let i = msToSamples(a); i < msToSamples(b); i++) x[i] = amp * Math.sin((2 * Math.PI * 200 * i) / 48000);
  }
  return x;
}

describe('narratorSoundSpans (spec 7.6: N while the narrator sounds)', () => {
  it('gives the 10 ms windows, every 5 ms, where channel 1 sounds, merged', () => {
    const ch1 = toneBursts(3000, [
      [1000, 1300, 0.1],
      [2300, 2500, 0.05],
    ]);
    // A window counts when it holds any tone: the one starting 5 ms before it, to the one
    // starting just before its end.
    expect(narratorSoundSpans(ch1)).toEqual([
      [msToSamples(995), msToSamples(1305)],
      [msToSamples(2295), msToSamples(2505)],
    ]);
  });

  it('moves the spans by n0 and the loop delay L_rt onto the channel 0 scale', () => {
    const ch1 = toneBursts(2000, [[500, 800, 0.1]]);
    const base = narratorSoundSpans(ch1);
    const n0 = 48000 * 600;
    const delay = 23 * MS;
    expect(narratorSoundSpans(ch1, { n0, delaySamples: delay })).toEqual(base.map(([a, b]) => [a + n0 + delay, b + n0 + delay]));
  });

  it('a hiss more than 20 dB under the narrator is not narrator sound; digital silence never is', () => {
    const rng = createRng(1);
    const ch1 = toneBursts(3000, [[1000, 1500, 0.1]]);
    // Dither at about -90 dBFS over the whole buffer.
    for (let i = 0; i < ch1.length; i++) ch1[i] = ch1[i]! + 3e-5 * (rng() - 0.5);
    expect(narratorSoundSpans(ch1)).toEqual([[msToSamples(995), msToSamples(1505)]]);
    expect(narratorSoundSpans(new Float32Array(48000))).toEqual([]);
    expect(narratorSoundSpans(new Float32Array(100))).toEqual([]);
  });

  it('a NaN or infinite sample counts as 0', () => {
    const ch1 = toneBursts(2000, [[500, 800, 0.1]]);
    const broken = ch1.slice();
    broken[msToSamples(200)] = Number.NaN;
    broken[msToSamples(600)] = Number.POSITIVE_INFINITY;
    const zeroed = ch1.slice();
    zeroed[msToSamples(200)] = 0;
    zeroed[msToSamples(600)] = 0;
    expect(narratorSoundSpans(broken)).toEqual(narratorSoundSpans(zeroed));
    expect(narratorSoundSpans(broken)).toEqual([[msToSamples(495), msToSamples(805)]]);
  });

  it('rejects sample numbers that are not integers and windows that are empty', () => {
    const ch1 = toneBursts(1000, [[200, 400, 0.1]]);
    expect(() => narratorSoundSpans(ch1, { n0: 0.5 })).toThrow(RangeError);
    expect(() => narratorSoundSpans(ch1, { delaySamples: Number.NaN })).toThrow(RangeError);
    expect(() => narratorSoundSpans(ch1, { windowMs: 0 })).toThrow(RangeError);
  });
});

/** A sparse reader on channel 1: syllables of 140-260 ms with pauses of 220-600 ms. */
function sparseNarrator(durMs: number, rng: Rng): { ch1: Float64Array; spans: SampleSpan[] } {
  const ch1 = new Float64Array(msToSamples(durMs));
  const spans: SampleSpan[] = [];
  const vowels = [
    [730, 1090, 2440],
    [530, 1840, 2480],
    [270, 2290, 3010],
    [570, 840, 2410],
  ];
  let t = msToSamples(100);
  while (t < ch1.length) {
    const f0 = 170 + rng() * 60;
    const syl = voice(
      {
        durMs: 140 + rng() * 120,
        f0Hz: [f0, f0 * 0.95],
        levelDb: -20 + (rng() - 0.5) * 6,
        formantsHz: vowels[Math.floor(rng() * vowels.length)]!,
        attackMs: 15,
        releaseMs: 25,
      },
      rng,
    );
    for (let i = 0; i < syl.length && t + i < ch1.length; i++) ch1[t + i] = syl[i]!;
    spans.push([t, Math.min(ch1.length, t + syl.length)]);
    t += syl.length + msToSamples(220 + rng() * 380);
  }
  return { ch1, spans };
}

function median(values: number[]): number {
  const s = [...values].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 === 1 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}

/** Steps (5 ms, core/vad) where channel 1 plays: within 20 dB of its 90th percentile, as doctor counts them. */
function playingSteps(ch1: Float32Array): Uint8Array {
  const e1 = vadStepFeatures(ch1).energyDb;
  const sorted = [...e1].sort((a, b) => a - b);
  const p90 = sorted[Math.floor(0.9 * (sorted.length - 1))]!;
  return Uint8Array.from(e1, (v) => (v >= p90 - 20 ? 1 : 0));
}

/**
 * Channel 0 level while the narrator plays, as doctor measures the leak (spec 7.6, 7.12;
 * analysis/lib/measure.ts): median core/vad step energy over the playing steps of channel 1,
 * moved by `lagSteps`, without the first 100 ms.
 */
function levelWhilePlayingDb(ch0: Float32Array, playing: Uint8Array, lagSteps: number): number {
  const e0 = vadStepFeatures(ch0).energyDb;
  const values: number[] = [];
  for (let i = 20; i < e0.length; i++) {
    const j = i - lagSteps;
    if (j >= 20 && j < playing.length && playing[j] === 1) values.push(e0[i]!);
  }
  return median(values);
}

describe('narrator sound as the reading mask of findOnset (spec 7.6: a weak leak is in N)', () => {
  const TOTAL_MS = 14000;
  const CUE = msToSamples(11000);
  const LRT = 23 * MS; // channel 1 to its leak in channel 0 (spec 6.3)

  it('a sparse narrator leaking at the 6 dB limit: N over its sound keeps t_v off the leak syllables', () => {
    for (const seed of [1, 2]) {
      const rng = createRng(seed);
      const { ch1, spans } = sparseNarrator(TOTAL_MS, rng);
      const ch1f = Float32Array.from(ch1);
      const background = new Scene(TOTAL_MS).background(-61, rng);
      const floorDb = measureFloorDb(background.toFloat32());
      // Leak gain for 6 dB over the background in doctor's measure, on the first 5 s.
      const head = msToSamples(5000);
      const playing = playingSteps(ch1f.subarray(0, head));
      const mixHead = (gain: number): Float32Array =>
        Float32Array.from(background.samples.subarray(0, head), (v, i) => v + (i >= LRT ? gain * ch1[i - LRT]! : 0));
      let lo = 1e-4;
      let hi = 1;
      for (let step = 0; step < 14; step++) {
        const mid = Math.sqrt(lo * hi);
        if (levelWhilePlayingDb(mixHead(mid), playing, Math.round(LRT / (5 * MS))) - floorDb > 6) hi = mid;
        else lo = mid;
      }
      const sc = new Scene(TOTAL_MS);
      sc.samples.set(background.samples);
      sc.addAt(ch1, LRT, lo);
      // The voice starts within 10 ms of the end of a leak syllable after the dot signal.
      const after = spans.filter(([, b]) => b + LRT > CUE + msToSamples(500) && b + LRT < CUE + msToSamples(2000));
      const pick = after[Math.floor(rng() * after.length)]!;
      const truth = pick[1] + LRT + Math.round((rng() * 20 - 10) * MS);
      sc.addAt(voice({ durMs: 600, f0Hz: [130, 115], levelDb: -24, attackMs: 3 }, rng), truth);
      const ch0 = sc.toFloat32();

      const sound = findOnset(ch0, CUE, { reading: narratorSoundSpans(ch1f, { delaySamples: LRT }) });
      expect(sound).not.toBeNull();
      expect(Math.abs(sound!.nV - truth)).toBeLessThanOrEqual(TOLERANCE);
      // Over the narrator's pauses too (Deck's `narrating` spans) N sits at the background, far
      // under the leak syllables, and the walk back can run into one.
      const narrating = findOnset(ch0, CUE, { reading: [[0, CUE]] });
      expect(narrating).not.toBeNull();
      expect(sound!.floorDb - narrating!.floorDb).toBeGreaterThan(6);
    }
  });
});
