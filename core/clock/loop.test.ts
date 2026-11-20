import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import {
  LOOP_AGREE_MS,
  LOOP_BLOCK_SAMPLES,
  LOOP_CLICK_PEAK,
  LOOP_MIN_CLICKS_FOUND,
  SAMPLE_RATE_HZ,
  clickSchedule,
  clickWaveform,
  loopRule,
  lrtValuesMs,
  measureClickLag,
  measureLoopLatency,
} from './index.ts';
import { addCoupledClick, addNoise, mulberry32 } from '../../tests/synthetic/signals.ts';

const R = SAMPLE_RATE_HZ;

interface BlockOptions {
  lrtMs: number;
  gain?: number;
  noise?: number;
  seed?: number;
  invert?: boolean;
  missing?: number[];
  /** Clicks that reach channel 0 at another lag (ms), as a knock that noise made look like a click. */
  shifted?: Record<number, number>;
}

// One loop check block: the click in channel 1, through a pressed earcup into channel 0.
function loopBlock(o: BlockOptions): { ch0: Float32Array; ch1: Float32Array; starts: number[] } {
  const ch0 = new Float32Array(LOOP_BLOCK_SAMPLES);
  const ch1 = new Float32Array(LOOP_BLOCK_SAMPLES);
  const click = clickWaveform();
  const starts = clickSchedule();
  starts.forEach((s, i) => {
    ch1.set(click, s);
    if (!(o.missing ?? []).includes(i)) {
      const lrtMs = o.shifted?.[i] ?? o.lrtMs;
      addCoupledClick(ch0, click, s + (lrtMs * R) / 1000, (o.invert ? -1 : 1) * (o.gain ?? 0.3), R);
    }
  });
  addNoise(ch0, o.noise ?? 0.0005, mulberry32(o.seed ?? 7));
  return { ch0, ch1, starts };
}

describe('measureLoopLatency (spec 6.3)', () => {
  it('finds all 10 clicks and gives the median L_rt within 0.05 ms', () => {
    const { ch0, ch1, starts } = loopBlock({ lrtMs: 23.4 });
    const m = measureLoopLatency(ch0, ch1, starts);
    expect(m.found).toBe(10);
    expect(m.total).toBe(10);
    expect(m.L_rt_ms!).toBeCloseTo(23.4, 1);
    expect(Math.abs(m.L_rt_ms! - 23.4)).toBeLessThan(0.05);
    expect(m.spread_ms!).toBeLessThan(0.05);
    for (const c of m.clicks) expect(c.peakToNoise).toBeGreaterThan(100);
  });

  it('gives the same lag through an inverted path', () => {
    const { ch0, ch1, starts } = loopBlock({ lrtMs: 31.7, invert: true });
    const m = measureLoopLatency(ch0, ch1, starts);
    expect(m.found).toBe(10);
    expect(Math.abs(m.L_rt_ms! - 31.7)).toBeLessThan(0.05);
  });

  it('reports spread as the largest minus the smallest found lag', () => {
    const { ch0, ch1, starts } = loopBlock({ lrtMs: 20 });
    const m = measureLoopLatency(ch0, ch1, starts);
    const lags = m.clicks.map((c) => c.lagMs!);
    expect(m.spread_ms).toBeCloseTo(Math.max(...lags) - Math.min(...lags), 12);
  });

  it('does not find clicks buried in noise (peak-to-noise below 10)', () => {
    const { ch0, ch1, starts } = loopBlock({ lrtMs: 23.4, gain: 0.003, noise: 0.01 });
    const m = measureLoopLatency(ch0, ch1, starts);
    expect(m.found).toBe(0);
    expect(m.L_rt_ms).toBeNull();
    expect(m.spread_ms).toBeNull();
    for (const c of m.clicks) {
      expect(c.found).toBe(false);
      expect(c.peakToNoise).toBeLessThan(10);
    }
  });

  it('needs 8 of the 10 clicks found for an L_rt (7.12); minFound changes that', () => {
    expect(LOOP_MIN_CLICKS_FOUND).toBe(8);
    const { ch0, ch1, starts } = loopBlock({ lrtMs: 23.4, missing: [1, 4, 7] });
    const m = measureLoopLatency(ch0, ch1, starts);
    expect(m.found).toBe(7);
    expect(m.L_rt_ms).toBeNull();
    expect(m.spread_ms).toBeNull();
    expect(m.clicks.filter((c) => !c.found).map((c) => c.i)).toEqual([1, 4, 7]);
    const relaxed = measureLoopLatency(ch0, ch1, starts, { minFound: 5 });
    expect(Math.abs(relaxed.L_rt_ms! - 23.4)).toBeLessThan(0.05);
    // Two clicks lost to a knock still leave the check its L_rt.
    const two = loopBlock({ lrtMs: 23.4, missing: [6, 9] });
    const eight = measureLoopLatency(two.ch0, two.ch1, two.starts);
    expect(eight.found).toBe(8);
    expect(Math.abs(eight.L_rt_ms! - 23.4)).toBeLessThan(0.05);
    expect(eight.spread_ms!).toBeLessThan(0.05);
    expect(measureLoopLatency(two.ch0, two.ch1, two.starts, { minFound: 10 }).L_rt_ms).toBeNull();
  });

  it(`counts a click only when its lag agrees with the others within ${LOOP_AGREE_MS} ms`, () => {
    expect(LOOP_AGREE_MS).toBe(1);
    // Click 3 stands out of the noise but 40 ms off: not found, and the median stays put.
    const one = loopBlock({ lrtMs: 23.4, shifted: { 3: 63.4 } });
    const m = measureLoopLatency(one.ch0, one.ch1, one.starts);
    expect(m.clicks[3]).toMatchObject({ found: false, lagMs: null });
    expect(m.clicks[3]!.peakToNoise).toBeGreaterThan(10);
    expect(m.found).toBe(9);
    expect(Math.abs(m.L_rt_ms! - 23.4)).toBeLessThan(0.05);
    expect(m.spread_ms!).toBeLessThan(0.05);
    // Three such clicks leave 7 that agree: no L_rt.
    const three = loopBlock({ lrtMs: 23.4, shifted: { 0: 5, 4: 70, 8: 90 } });
    const n = measureLoopLatency(three.ch0, three.ch1, three.starts);
    expect(n.found).toBe(7);
    expect(n.L_rt_ms).toBeNull();
    // A lag 0.5 ms off still agrees.
    const near = loopBlock({ lrtMs: 23.4, shifted: { 2: 23.9 } });
    expect(measureLoopLatency(near.ch0, near.ch1, near.starts).found).toBe(10);
  });

  it('plays the loop-check clicks louder than the default click', () => {
    expect(LOOP_CLICK_PEAK).toBe(0.9);
    const w = clickWaveform(LOOP_CLICK_PEAK);
    expect(Math.max(...Array.from(w, Math.abs))).toBeLessThanOrEqual(LOOP_CLICK_PEAK);
    expect(Math.max(...Array.from(w, Math.abs))).toBeGreaterThan(0.85);
  });

  it('does not find a lag beyond the 100 ms search', () => {
    const { ch0, ch1, starts } = loopBlock({ lrtMs: 130 });
    expect(measureLoopLatency(ch0, ch1, starts).found).toBe(0);
  });

  it('does not find a click that channel 1 never played, or a non-finite start', () => {
    const { ch0, starts } = loopBlock({ lrtMs: 23.4 });
    const silent = new Float32Array(ch0.length);
    expect(measureClickLag(ch0, silent, starts[0]!).found).toBe(false);
    const { ch1 } = loopBlock({ lrtMs: 23.4 });
    expect(measureClickLag(ch0, ch1, Number.NaN).found).toBe(false);
  });

  it('measures any lag in 2-95 ms within 0.05 ms (property)', () => {
    const click = clickWaveform();
    fc.assert(
      fc.property(
        fc.double({ min: 2, max: 95, noNaN: true }),
        fc.double({ min: 0.02, max: 0.6, noNaN: true }),
        fc.boolean(),
        fc.integer({ min: 1, max: 1e6 }),
        (lrtMs, gain, invert, seed) => {
          const ch0 = new Float32Array(R / 4);
          const ch1 = new Float32Array(R / 4);
          const start = 1000;
          ch1.set(click, start);
          addCoupledClick(ch0, click, start + (lrtMs * R) / 1000, invert ? -gain : gain, R);
          addNoise(ch0, 0.0005, mulberry32(seed));
          const lag = measureClickLag(ch0, ch1, start);
          return lag.found && Math.abs(lag.lagMs! - lrtMs) < 0.05;
        },
      ),
      { numRuns: 60 },
    );
  });
});

describe('loopRule (spec 6.3 table, calib.json L_rt_ms)', () => {
  const at = (ms: number, spread = 0.3) => ({ L_rt_ms: ms, spread_ms: spread });

  it('takes the mean when A and B differ by at most 3 ms', () => {
    expect(loopRule(at(23.4, 0.3), at(23.6, 0.2))).toEqual({
      A: 23.4,
      B: 23.6,
      spread: [0.3, 0.2],
      rule: 'mean',
      used: 23.5,
    });
    // 26.4 - 23.4 is 3.0000000000000036 in floating point; the rule allows that float noise only.
    expect(loopRule(at(23.4), at(26.4)).rule).toBe('mean');
    expect(loopRule(at(23.4), at(23.5)).used).toBe(23.5);
  });

  it('marks both above 3 ms and up to 15 ms', () => {
    const r = loopRule(at(23.4), at(26.5));
    expect(r.rule).toBe('both');
    expect(r.used).toBeNull();
    expect(lrtValuesMs(r)).toEqual([23.4, 26.5]);
    expect(loopRule(at(23.4), at(38.4)).rule).toBe('both');
    expect(loopRule(at(38.4), at(23.4)).rule).toBe('both');
  });

  it('voids above 15 ms or when a block is missing', () => {
    expect(loopRule(at(23.4), at(38.5)).rule).toBe('void');
    expect(loopRule(at(23.4), null)).toEqual({ A: 23.4, B: null, spread: [0.3, null], rule: 'void', used: null });
    expect(loopRule(null, null).rule).toBe('void');
    expect(loopRule(at(23.4), { L_rt_ms: null, spread_ms: null }).rule).toBe('void');
    expect(lrtValuesMs(loopRule(at(23.4), at(43.4)))).toEqual([]);
  });

  it('judges the measured difference and prints A, B, the spreads and the mean rounded to 0.1 ms', () => {
    const r = loopRule(at(23.449, 0.26), at(26.449, 0.04));
    expect(r).toMatchObject({ A: 23.4, B: 26.4, spread: [0.3, 0], rule: 'mean', used: 24.9 });
    expect(lrtValuesMs(r)).toEqual([24.9]);
    // Printed 23.4 and 26.4, but measured 3.098 ms apart: above the 3 ms limit.
    expect(loopRule(at(23.351), at(26.449))).toMatchObject({ A: 23.4, B: 26.4, rule: 'both', used: null });
    // Printed 23.4 and 38.4, but measured 15.098 ms apart: above the 15 ms limit.
    expect(loopRule(at(23.351), at(38.449))).toMatchObject({ A: 23.4, B: 38.4, rule: 'void' });
  });

  it('keeps the 3 and 15 ms limits exact on measured values', () => {
    expect(loopRule(at(23.4), at(26.4)).rule).toBe('mean');
    expect(loopRule(at(23.4), at(26.401)).rule).toBe('both');
    expect(loopRule(at(26.401), at(23.4)).rule).toBe('both');
    expect(loopRule(at(23.4), at(38.4)).rule).toBe('both');
    expect(loopRule(at(23.4), at(38.401)).rule).toBe('void');
    expect(loopRule(at(23.4), at(38.401)).used).toBeNull();
  });

  it('takes other thresholds, as doctor may set them before gate-prereg', () => {
    expect(loopRule(at(20), at(22.5), { meanMaxMs: 2 }).rule).toBe('both');
    expect(loopRule(at(20), at(31), { bothMaxMs: 10 }).rule).toBe('void');
  });
});
