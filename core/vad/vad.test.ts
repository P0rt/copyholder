import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import {
  DEFAULT_VAD_PARAMS,
  createVad,
  measureFloorDb,
  readVadFrozenBlock,
  resolveVadParams,
  tuneVadThreshold,
  vadEdges,
  vadFrozenBlock,
  vadParamsFromFrozen,
  vadStepFeatures,
  voiceIntervalsFromEdges,
  type VadEdge,
  type VadParams,
} from './index.ts';
import { bandNoise, breath, createRng, msToSamples, narratorLeak, Scene, voice, type Rng } from './synth.ts';

const MS = 48; // samples per millisecond at 48 kHz
const FLOOR_DB = -68;

/** Background floor plus a quiet stretch, like doctor measures (spec 7.12). */
function paramsFor(signalForFloor: Float32Array): VadParams {
  return { ...DEFAULT_VAD_PARAMS, floorDb: measureFloorDb(signalForFloor) };
}

function quietScene(durMs: number, rng: Rng): Scene {
  return new Scene(durMs).background(FLOOR_DB, rng);
}

/**
 * Splits `signal` into consecutive blocks of the given sizes (cycled) and pushes them. Where
 * `empties` (cycled) is true, an empty block goes in before the block.
 */
function pushInBlocks(
  signal: Float32Array,
  params: VadParams,
  sizes: readonly number[],
  n0: number,
  empties: readonly boolean[] = [false],
): VadEdge[] {
  const vad = createVad(params);
  const edges: VadEdge[] = [];
  let at = 0;
  let i = 0;
  while (at < signal.length) {
    if (empties[i % empties.length]!) edges.push(...vad.push(new Float32Array(0), n0 + at));
    const size = Math.min(sizes[i % sizes.length]!, signal.length - at);
    edges.push(...vad.push(signal.subarray(at, at + size), n0 + at));
    at += size;
    i++;
  }
  return edges;
}

/** Loud inhale, short pause, voiced tone (spec 7.3 / 13.4 test case). */
function inhaleThenTone(seed: number, gapMs: number): { signal: Float32Array; toneStart: number; toneEnd: number; quiet: Float32Array } {
  const rng = createRng(seed);
  const sc = quietScene(5000, rng);
  sc.add(breath({ durMs: 600, levelDb: -36, releaseMs: gapMs === 0 ? 5 : 80 }, rng), 1000);
  const toneStart = sc.add(voice({ durMs: 700, f0Hz: [140, 120], levelDb: -24 }, rng), 1600 + gapMs);
  const signal = sc.toFloat32();
  return { signal, toneStart, toneEnd: toneStart + msToSamples(700), quiet: signal.subarray(0, msToSamples(900)) };
}

describe('DEFAULT_VAD_PARAMS', () => {
  it('carries the numbers of spec 7.3 and the frozen.json vad block (spec 8.4)', () => {
    const p = DEFAULT_VAD_PARAMS;
    expect([p.sampleRateHz, p.highpassHz, p.hopMs, p.overFloorDb, p.periodicity, p.offMs]).toEqual([
      48000, 150, 5, 15, 0.5, 1200,
    ]);
    expect(p.onMs).toEqual([30, 50]);
    expect(p.decimateToHz).toBe(8000);
    expect(p.lagMs).toEqual([2.5, 12.5]);
    expect(Object.isFrozen(p)).toBe(true);
  });

  it('accepts a partial set (defaults fill the rest) and rejects unknown keys', () => {
    expect(resolveVadParams({ floorDb: -60 })).toEqual({ ...DEFAULT_VAD_PARAMS, floorDb: -60 });
    expect(resolveVadParams()).toBe(DEFAULT_VAD_PARAMS);
    const { signal, quiet } = inhaleThenTone(40, 100);
    const floorDb = measureFloorDb(quiet);
    expect(vadEdges(signal, { floorDb })).toEqual(vadEdges(signal, { ...DEFAULT_VAD_PARAMS, floorDb }));
    // The stand-in shape of web/ or the snake_case frozen block must not run silently on defaults.
    expect(() => createVad({ highPassHz: 150 } as unknown as Partial<VadParams>)).toThrow(/unknown parameter "highPassHz"/);
    expect(() => createVad({ over_floor_db: 15 } as unknown as Partial<VadParams>)).toThrow(RangeError);
  });

  it('rejects inconsistent parameters at construction', () => {
    expect(() => createVad({ ...DEFAULT_VAD_PARAMS, hopMs: 5.01 })).toThrow(RangeError);
    expect(() => createVad({ ...DEFAULT_VAD_PARAMS, decimateToHz: 7000 })).toThrow(RangeError);
    expect(() => createVad({ ...DEFAULT_VAD_PARAMS, onMs: [60, 50] })).toThrow(RangeError);
    expect(() => createVad({ ...DEFAULT_VAD_PARAMS, lagMs: [2.5, 40] })).toThrow(RangeError);
    expect(() => createVad({ ...DEFAULT_VAD_PARAMS, periodicity: 0 })).toThrow(RangeError);
  });
});

describe('measureFloorDb', () => {
  it('reads the level of background noise (the energy the detector compares)', () => {
    const rng = createRng(1);
    const floor = measureFloorDb(quietScene(3000, rng).toFloat32());
    expect(floor).toBeGreaterThan(FLOOR_DB - 0.5);
    expect(floor).toBeLessThan(FLOOR_DB + 0.2);
  });

  it('is NaN for a signal shorter than one energy window', () => {
    expect(measureFloorDb(new Float32Array(100))).toBeNaN();
  });
});

describe('voice detector (spec 7.3, 13.4)', () => {
  it('a loud inhale before a voiced tone gives no voice_on; the tone does, 30-60 ms in', () => {
    for (const seed of [1, 2, 3]) {
      const { signal, toneStart, toneEnd, quiet } = inhaleThenTone(seed, 100);
      const edges = vadEdges(signal, paramsFor(quiet));
      expect(edges).toHaveLength(2);
      const [on, off] = edges as [VadEdge, VadEdge];
      expect(on.on).toBe(true);
      expect(on.n - toneStart).toBeGreaterThanOrEqual(30 * MS);
      expect(on.n - toneStart).toBeLessThanOrEqual(60 * MS);
      expect(off.on).toBe(false);
      expect(off.n - toneEnd).toBeGreaterThanOrEqual(1200 * MS);
      expect(off.n - toneEnd).toBeLessThanOrEqual(1250 * MS);
    }
  });

  it('an inhale running straight into the tone switches on only after the tone starts', () => {
    for (const seed of [4, 5, 6]) {
      const { signal, toneStart, quiet } = inhaleThenTone(seed, 0);
      const on = vadEdges(signal, paramsFor(quiet)).filter((e) => e.on);
      expect(on).toHaveLength(1);
      expect(on[0]!.n - toneStart).toBeGreaterThanOrEqual(30 * MS);
      expect(on[0]!.n - toneStart).toBeLessThanOrEqual(60 * MS);
    }
  });

  it('three loud inhales alone, like the doctor recording, give no edges', () => {
    const rng = createRng(7);
    const sc = quietScene(10000, rng);
    for (const at of [1000, 4000, 7000]) sc.add(breath({ durMs: 800, levelDb: -32 }, rng), at);
    const signal = sc.toFloat32();
    expect(vadEdges(signal, paramsFor(signal.subarray(0, 900 * MS)))).toEqual([]);
  });

  it('narrator leak at a low level gives no edges', () => {
    const rng = createRng(8);
    const sc = quietScene(10000, rng);
    sc.add(narratorLeak(10000, -63, rng), 0);
    expect(vadEdges(sc.toFloat32(), { ...DEFAULT_VAD_PARAMS, floorDb: FLOOR_DB })).toEqual([]);
  });

  it('voice_on needs 30 ms of voicing: a 20 ms blip stays off, 40 ms switches on', () => {
    const run = (durMs: number): VadEdge[] => {
      const rng = createRng(durMs);
      const sc = quietScene(2000, rng);
      sc.add(voice({ durMs, f0Hz: 130, levelDb: -24, attackMs: 2, releaseMs: 2 }, rng), 500);
      return vadEdges(sc.toFloat32(), { ...DEFAULT_VAD_PARAMS, floorDb: FLOOR_DB });
    };
    expect(run(20)).toEqual([]);
    expect(run(40).map((e) => e.on)).toEqual([true, false]);
  });

  it('voice_off comes 1.2 s after the last voiced step; a 1.0 s pause keeps voice on', () => {
    const run = (pauseMs: number): VadEdge[] => {
      const rng = createRng(20);
      const sc = quietScene(5000, rng);
      sc.add(voice({ durMs: 300, f0Hz: 120, levelDb: -24 }, rng), 500);
      sc.add(voice({ durMs: 300, f0Hz: 125, levelDb: -24 }, rng), 800 + pauseMs);
      return vadEdges(sc.toFloat32(), { ...DEFAULT_VAD_PARAMS, floorDb: FLOOR_DB });
    };
    expect(run(1000).map((e) => e.on)).toEqual([true, false]);
    expect(run(1500).map((e) => e.on)).toEqual([true, false, true, false]);
  });

  it('a clipped loud vowel still switches on in time', () => {
    const rng = createRng(9);
    const sc = quietScene(3000, rng);
    const t = sc.add(voice({ durMs: 600, f0Hz: 130, levelDb: 0 }, rng), 1000);
    const edges = vadEdges(sc.toFloat32(0.3), { ...DEFAULT_VAD_PARAMS, floorDb: FLOOR_DB });
    expect(edges.map((e) => e.on)).toEqual([true, false]);
    expect(edges[0]!.n - t).toBeLessThanOrEqual(60 * MS);
  });

  it('a DC offset changes nothing; a DC step gives no edges', () => {
    const { signal, quiet } = inhaleThenTone(10, 100);
    const p = paramsFor(quiet);
    const shifted = signal.map((v) => v + 0.2);
    expect(vadEdges(shifted, p)).toEqual(vadEdges(signal, p));

    const rng = createRng(11);
    const sc = quietScene(3000, rng);
    const s = sc.samples;
    for (let i = msToSamples(1000); i < s.length; i++) s[i] = s[i]! + 0.5;
    expect(vadEdges(sc.toFloat32(), { ...DEFAULT_VAD_PARAMS, floorDb: FLOOR_DB })).toEqual([]);
  });

  it('silence only gives no edges', () => {
    expect(vadEdges(new Float32Array(48000), DEFAULT_VAD_PARAMS)).toEqual([]);
  });

  it('a non-finite sample counts as 0 and does not stall the detector', () => {
    const { signal, toneStart, quiet } = inhaleThenTone(12, 100);
    const p = paramsFor(quiet);
    const broken = signal.slice();
    broken[0] = Number.NaN;
    broken[toneStart - 1000] = Number.POSITIVE_INFINITY;
    broken[toneStart - 2000] = Number.NaN;
    const zeroed = signal.slice();
    zeroed[0] = 0;
    zeroed[toneStart - 1000] = 0;
    zeroed[toneStart - 2000] = 0;
    expect(vadEdges(broken, p)).toEqual(vadEdges(zeroed, p));
    expect(vadEdges(broken, p).map((e) => e.on)).toEqual([true, false]);
  });
});

describe('params/frozen.json vad block (spec 8.4)', () => {
  it('reads the spec example and fills the keys it leaves out with defaults', () => {
    const example = { highpass_hz: 150, hop_ms: 5, over_floor_db: 15, periodicity: 0.5, on_ms: [30, 50], off_ms: 1200 };
    expect(vadParamsFromFrozen(example)).toEqual(DEFAULT_VAD_PARAMS);
  });

  it("tells a frozen floor from the -70 dB placeholder: doctor's floor must be in the block (spec 7.3, 7.12)", () => {
    const example = { highpass_hz: 150, hop_ms: 5, over_floor_db: 15, periodicity: 0.5, on_ms: [30, 50], off_ms: 1200 };
    expect(readVadFrozenBlock(example)).toEqual({ params: DEFAULT_VAD_PARAMS, floorMeasured: false });
    expect(() => vadParamsFromFrozen(example, { requireFloor: true })).toThrow(/floor_db is missing/);
    const frozen = { ...example, floor_db: -63.4 };
    expect(readVadFrozenBlock(frozen)).toEqual({ params: { ...DEFAULT_VAD_PARAMS, floorDb: -63.4 }, floorMeasured: true });
    expect(vadParamsFromFrozen(frozen, { requireFloor: true })).toEqual({ ...DEFAULT_VAD_PARAMS, floorDb: -63.4 });
    // A floor of the wrong type is an error, never a missing floor.
    expect(() => readVadFrozenBlock({ ...example, floor_db: null })).toThrow(RangeError);
    expect(() => vadParamsFromFrozen({ ...example, floor_db: '-63' }, { requireFloor: true })).toThrow(/finite number/);
  });

  it('round-trips a doctor-tuned parameter set', () => {
    const tuned: VadParams = { ...DEFAULT_VAD_PARAMS, floorDb: -63.4, periodicity: 0.6 };
    const block = vadFrozenBlock(tuned);
    expect(block).toMatchObject({ floor_db: -63.4, periodicity: 0.6, on_ms: [30, 50], lag_ms: [2.5, 12.5] });
    expect(vadParamsFromFrozen(JSON.parse(JSON.stringify(block)) as Record<string, unknown>)).toEqual(tuned);
  });

  it('ignores keys it does not know and rejects wrong types and inconsistent values', () => {
    expect(vadParamsFromFrozen({ floor_db: -60, note: 'measured by doctor' }).floorDb).toBe(-60);
    expect(() => vadParamsFromFrozen({ floor_db: '-60' })).toThrow(RangeError);
    expect(() => vadParamsFromFrozen({ on_ms: [30] })).toThrow(RangeError);
    expect(() => vadParamsFromFrozen({ on_ms: [60, 50] })).toThrow(RangeError);
  });
});

describe('streaming', () => {
  const { signal, quiet } = inhaleThenTone(30, 100);
  const params = paramsFor(quiet);

  it('edges do not depend on the block split (fast-check)', () => {
    fc.assert(
      fc.property(
        fc.array(fc.integer({ min: 1, max: 20000 }), { minLength: 1, maxLength: 12 }),
        fc.integer({ min: 0, max: 50_000_000 }),
        fc.array(fc.boolean(), { minLength: 1, maxLength: 5 }),
        (sizes, n0, empties) => {
          expect(pushInBlocks(signal, params, sizes, n0, empties)).toEqual(vadEdges(signal, params, n0));
        },
      ),
      { numRuns: 40 },
    );
  });

  it('the stream starts at its first sample: empty blocks before it change nothing', () => {
    // A DC offset makes the start visible: the high-pass is primed with the first sample.
    const shifted = signal.map((v) => v + 0.4);
    const vad = createVad(params);
    expect(vad.push(new Float32Array(0), 0)).toHaveLength(0);
    expect(vad.push(new Float32Array(0), 77)).toHaveLength(0);
    const edges = [...vad.push(shifted.subarray(0, 1000), 480), ...vad.push(shifted.subarray(1000), 1480)];
    expect(edges).toEqual(vadEdges(shifted, params, 480));
  });

  it('128-sample quanta, as in the AudioWorklet, give the same edges as one call', () => {
    const whole = vadEdges(signal, params);
    expect(whole.length).toBe(2);
    expect(pushInBlocks(signal, params, [128], 0)).toEqual(whole);
  });

  it('edges follow absolute sample numbers', () => {
    const base = vadEdges(signal, params, 0);
    const shifted = vadEdges(signal, params, 240 * 1000);
    expect(shifted).toEqual(base.map((e) => ({ n: e.n + 240 * 1000, on: e.on })));
  });

  it('returns one shared frozen empty array for quanta without edges (no allocation)', () => {
    const vad = createVad(params);
    const quantum = new Float32Array(128);
    const first = vad.push(quantum, 0);
    expect(first).toHaveLength(0);
    expect(Object.isFrozen(first)).toBe(true);
    for (let q = 1; q < 50; q++) expect(vad.push(quantum, q * 128)).toBe(first);
    expect(vad.on).toBe(false);
  });

  it('rejects a block that does not continue the stream', () => {
    const vad = createVad(params);
    vad.push(new Float32Array(128), 1000);
    expect(() => vad.push(new Float32Array(128), 1000)).toThrow(RangeError);
    expect(() => vad.push(new Float32Array(128), 1.5)).toThrow(RangeError);
  });

  it('vadStepFeatures marks the same voiced steps that drive the edges', () => {
    const f = vadStepFeatures(signal, params);
    expect(f.n.length).toBe(Math.floor(signal.length / 240));
    expect(f.n[0]).toBe(240);
    const firstVoiced = f.voiced.indexOf(1);
    const on = vadEdges(signal, params)[0]!;
    expect(firstVoiced).toBeGreaterThan(0);
    expect(on.n).toBeGreaterThan(f.n[firstVoiced]!);
    let count = 0;
    for (let i = 0; i < f.n.length && f.n[i]! <= on.n; i++) if (f.n[i]! > on.n - 50 * MS) count += f.voiced[i]!;
    expect(count).toBe(6);
  });
});

describe('tuneVadThreshold (spec 7.12)', () => {
  /** Three inhales with a whistle: a 1.2 kHz tone `ratioDb` relative to the breath noise. */
  function whistlyInhales(ratioDb: number): Float32Array {
    const rng = createRng(11);
    const sc = quietScene(10000, rng);
    for (const at of [1000, 4000, 7000]) {
      sc.add(breath({ durMs: 700, levelDb: -38 }, rng), at);
      const n = msToSamples(700);
      const w = new Float64Array(n);
      let phase = 0;
      for (let i = 0; i < n; i++) {
        phase += (2 * Math.PI * (1200 + 40 * Math.sin((2 * Math.PI * 3 * i) / 48000))) / 48000;
        w[i] = Math.sin(phase) * Math.min(1, i / 2880, (n - i) / 3840);
      }
      let s = 0;
      for (const v of w) s += v * v;
      const g = Math.pow(10, (-38 + ratioDb) / 20) / Math.sqrt(s / n);
      sc.add(w.map((v) => v * g), at);
    }
    return sc.toFloat32();
  }
  const params = { ...DEFAULT_VAD_PARAMS, floorDb: FLOOR_DB };

  it('keeps 0.5 when broadband inhales do not switch voice_on', () => {
    const rng = createRng(12);
    const sc = quietScene(10000, rng);
    for (const at of [1000, 4000, 7000]) sc.add(breath({ durMs: 800, levelDb: -32 }, rng), at);
    const r = tuneVadThreshold(sc.toFloat32(), params);
    expect(r).toMatchObject({ periodicity: 0.5, inhaleTriggered: false, ok: true });
    expect(r.trials).toEqual([{ periodicity: 0.5, onEdges: 0 }]);
  });

  it('raises the threshold in 0.05 steps to the first value without voice_on', () => {
    const r = tuneVadThreshold(whistlyInhales(-3), params);
    expect(r.inhaleTriggered).toBe(true);
    expect(r.ok).toBe(true);
    expect(r.periodicity).toBeGreaterThan(0.5);
    expect(r.periodicity).toBeLessThanOrEqual(0.7);
    expect(r.params.periodicity).toBe(r.periodicity);
    expect(r.trials.map((t) => t.periodicity)).toEqual(
      [0.5, 0.55, 0.6, 0.65, 0.7].filter((v) => v <= r.periodicity),
    );
    expect(r.trials.slice(0, -1).every((t) => t.onEdges > 0)).toBe(true);
    expect(vadEdges(whistlyInhales(-3), r.params).filter((e) => e.on)).toEqual([]);
  });

  it('low-frequency inhale noise that switches voice_on at 0.5 is tuned out, and the voice still switches on in time', () => {
    // Breath noise under 400 Hz keeps little bandwidth after the 150 Hz high-pass, so its
    // periodicity reaches 0.5 by chance on a few steps.
    const lowBreath = (rng: Rng): Float64Array =>
      bandNoise({ durMs: 800, levelDb: -30, lowHz: 20, highHz: 400, attackMs: 60, releaseMs: 80 }, rng);
    const rng = createRng(1);
    const sc = quietScene(10000, rng);
    for (const at of [1000, 4000, 7000]) sc.add(lowBreath(rng), at);
    const signal = sc.toFloat32();
    const p = paramsFor(signal.subarray(0, 900 * MS));
    const r = tuneVadThreshold(signal, p);
    expect(r).toMatchObject({ inhaleTriggered: true, ok: true });
    expect(r.periodicity).toBeGreaterThan(0.5);
    expect(r.periodicity).toBeLessThanOrEqual(0.7);
    // Other low inhales of the same kind, 100 ms before a tone: at 0.5 some switch on in the
    // inhale; at the tuned threshold each gives one voice_on, 30-60 ms into the tone.
    let earlyAtDefault = 0;
    for (const seed of [1011, 1012, 1013, 1014]) {
      const r2 = createRng(seed);
      const sc2 = quietScene(5000, r2);
      sc2.add(lowBreath(r2), 1000);
      const tone = sc2.add(voice({ durMs: 700, f0Hz: [140, 120], levelDb: -24 }, r2), 1900);
      const x = sc2.toFloat32();
      const on = vadEdges(x, r.params).filter((e) => e.on);
      expect(on).toHaveLength(1);
      expect(on[0]!.n - tone).toBeGreaterThanOrEqual(30 * MS);
      expect(on[0]!.n - tone).toBeLessThanOrEqual(60 * MS);
      if (vadEdges(x, p).some((e) => e.on && e.n < tone)) earlyAtDefault++;
    }
    expect(earlyAtDefault).toBeGreaterThan(0);
  });

  it('stops at 0.7 and reports failure when even 0.7 switches voice_on', () => {
    const r = tuneVadThreshold(whistlyInhales(6), params);
    expect(r).toMatchObject({ periodicity: 0.7, inhaleTriggered: true, ok: false });
    expect(r.trials.map((t) => t.periodicity)).toEqual([0.5, 0.55, 0.6, 0.65, 0.7]);
  });
});

describe('voiceIntervalsFromEdges', () => {
  it('pairs on and off edges and closes an open interval when asked', () => {
    const edges: VadEdge[] = [
      { n: 100, on: true },
      { n: 900, on: false },
      { n: 2000, on: true },
    ];
    expect(voiceIntervalsFromEdges(edges)).toEqual([[100, 900]]);
    expect(voiceIntervalsFromEdges(edges, 5000)).toEqual([
      [100, 900],
      [2000, 5000],
    ]);
  });
});
