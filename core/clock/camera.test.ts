import { describe, expect, it } from 'vitest';
import {
  QUANTUM_SAMPLES,
  SAMPLE_RATE_HZ,
  cameraClock,
  cameraTsToMicSeconds,
  lipOpening,
  lowerEnvelope,
  type LipFrame,
  type PacketTime,
} from './index.ts';
import { exponential, gaussian, mulberry32 } from '../../tests/synthetic/signals.ts';

const R = SAMPLE_RATE_HZ;
const EPOCH_US = 1_794_935_000_000_000;
const L_IN_S = 0.01;

interface StreamOptions {
  seconds: number;
  ppm: number;
  seed?: number;
  g?: (t: number) => number;
}

// 30 frames per second from t = 1 s; the camera clock runs `ppm` slow against the audio clock.
function stream(o: StreamOptions): { packets: PacketTime[]; frames: LipFrame[]; tsOf: (t: number) => number } {
  const rng = mulberry32(o.seed ?? 3);
  const tsOf = (t: number): number => EPOCH_US + t * 1e6 * (1 - o.ppm * 1e-6);
  const packets: PacketTime[] = [];
  const frames: LipFrame[] = [];
  for (let k = 0; k < o.seconds * 30; k++) {
    const t = 1 + k / 30;
    const tsUs = Math.round(tsOf(t) + 500 * gaussian(rng));
    const nArr = Math.ceil(((t + 0.04 + exponential(rng, 0.01)) * R) / QUANTUM_SAMPLES) * QUANTUM_SAMPLES;
    packets.push({ nArr, tsUs });
    if (o.g) frames.push({ tsUs, g: Math.max(0, o.g(t) + 0.001 * gaussian(rng)), nArr });
  }
  return { packets, frames, tsOf };
}

// Closed lips (0.01) around each opening; linear opening to 0.2 over 80 ms, held, closed again.
function lipGap(openings: readonly number[]): (t: number) => number {
  return (t) => {
    for (const o of openings) {
      if (t >= o && t < o + 0.08) return 0.01 + (0.19 * (t - o)) / 0.08;
      if (t >= o + 0.08 && t < o + 0.3) return 0.2;
    }
    return 0.01;
  };
}

describe('lowerEnvelope (spec 6.3)', () => {
  it('gives the drift of the camera clock as its slope', () => {
    for (const ppm of [40, -25, 0]) {
      const env = lowerEnvelope(stream({ seconds: 120, ppm }).packets)!;
      expect(env.windows).toBeGreaterThanOrEqual(11);
      expect(Math.abs(env.slope * 1e6 - ppm)).toBeLessThan(5);
    }
  });

  it('needs at least two windows', () => {
    expect(lowerEnvelope(stream({ seconds: 5, ppm: 0 }).packets)).toBeNull();
    expect(lowerEnvelope([])).toBeNull();
  });
});

describe('lipOpening (spec 6.3)', () => {
  const openings = [10.013, 12.027, 14.004, 16.019, 18.031];
  const s = stream({ seconds: 30, ppm: 40, g: lipGap(openings) });

  it('finds each opening within 4 ms from a line through the rising frames', () => {
    for (const o of openings) {
      const r = lipOpening(s.frames, Math.round((o + L_IN_S) * R));
      expect(r.tsOpenUs).not.toBeNull();
      expect(Math.abs(r.tsOpenUs! - s.tsOf(o)) / 1000).toBeLessThan(4);
      expect(r.gClosed!).toBeCloseTo(0.01, 2);
      expect(r.amplitude!).toBeCloseTo(0.19, 1);
      expect(r.riseFrames).toBeGreaterThanOrEqual(2);
    }
  });

  it('finds nothing without an opening or without frames', () => {
    const flat = stream({ seconds: 30, ppm: 0, g: () => 0.03 });
    expect(lipOpening(flat.frames, 12 * R).tsOpenUs).toBeNull();
    expect(lipOpening([], 12 * R).tsOpenUs).toBeNull();
  });
});

describe('cameraClock (spec 6.3, calib.json camera_clock)', () => {
  const startT = [10, 12, 14, 16, 18].map((t) => t + 0.011);
  const endT = [110, 112, 114, 116, 118].map((t) => t + 0.017);
  const s = stream({ seconds: 125, ppm: 40, g: lipGap([...startT, ...endT]) });
  const bursts = {
    start: startT.map((t) => Math.round((t + L_IN_S) * R)),
    end: endT.map((t) => Math.round((t + L_IN_S) * R)),
  };

  it('agrees at start and end when the slope is right', () => {
    const c = cameraClock({ packets: s.packets, frames: s.frames, bursts });
    expect(c.ok).toBe(true);
    expect(c.start.found).toBe(5);
    expect(c.end.found).toBe(5);
    const [a, b] = c.calib.offset_ms;
    expect(Math.abs(a! - b!)).toBeLessThan(5);
    // Offset = shortest arrival latency minus L_in: about 40 ms + quantum - 10 ms.
    expect(a!).toBeGreaterThan(20);
    expect(a!).toBeLessThan(45);
    expect(Math.abs(c.calib.slope_ppm! - 40)).toBeLessThan(5);
    expect(Number.isInteger(c.calib.offset_ms[0]! * 10)).toBe(true);
  });

  it('is not ok when the end disagrees by more than 25 ms', () => {
    const late = { start: bursts.start, end: bursts.end.map((n) => n + 0.04 * R) };
    const c = cameraClock({ packets: s.packets, frames: s.frames, bursts: late });
    expect(c.ok).toBe(false);
    expect(c.calib.offset_ms[0]! - c.calib.offset_ms[1]!).toBeGreaterThan(30);
    expect(cameraClock({ packets: s.packets, frames: s.frames, bursts: late }, { agreeMs: 60 }).ok).toBe(true);
  });

  it('judges the measured offsets against the limit, not the offsets printed to 0.1 ms', () => {
    const c = cameraClock({ packets: s.packets, frames: s.frames, bursts });
    const d = Math.abs(c.start.offsetMs! - c.end.offsetMs!);
    expect(cameraClock({ packets: s.packets, frames: s.frames, bursts }, { agreeMs: d }).ok).toBe(true);
    expect(cameraClock({ packets: s.packets, frames: s.frames, bursts }, { agreeMs: d - 1e-6 }).ok).toBe(false);
  });

  it('takes a block offset from the syllables found in it; minFoundPerBlock can ask for more', () => {
    // The third end burst lies where the lips stay closed: no opening there.
    const few = { start: bursts.start, end: [bursts.end[0]!, bursts.end[1]!, 125.5 * R] };
    const c = cameraClock({ packets: s.packets, frames: s.frames, bursts: few });
    expect(c.end.found).toBe(2);
    expect(c.end.offsetsMs[2]).toBeNull();
    expect(c.ok).toBe(true);
    const strict = cameraClock({ packets: s.packets, frames: s.frames, bursts: few }, { minFoundPerBlock: 3 });
    expect(strict.end.offsetMs).toBeNull();
    expect(strict.calib).toMatchObject({ offset_ms: [expect.any(Number), null], ok: false });
  });

  it('works with one syllable per block, as in pack 0, and fails a block with none found', () => {
    const one = { start: [bursts.start[2]!], end: [bursts.end[2]!] };
    const c = cameraClock({ packets: s.packets, frames: s.frames, bursts: one });
    expect(c.ok).toBe(true);
    expect(Math.abs(c.calib.offset_ms[0]! - c.calib.offset_ms[1]!)).toBeLessThan(6);
    const none = cameraClock({ packets: s.packets, frames: s.frames, bursts: { start: bursts.start, end: [125.5 * R] } });
    expect(none.end.found).toBe(0);
    expect(none.calib.offset_ms).toEqual([expect.any(Number), null]);
    expect(none.ok).toBe(false);
    const empty = cameraClock({ packets: s.packets, frames: s.frames, bursts: { start: [], end: [] } });
    expect(empty.calib).toEqual({ offset_ms: [null, null], slope_ppm: expect.any(Number), ok: false });
  });

  it('maps a camera timestamp onto the microphone scale only when ok', () => {
    const c = cameraClock({ packets: s.packets, frames: s.frames, bursts });
    for (const [i, t] of startT.entries()) {
      const mic = cameraTsToMicSeconds(c, s.tsOf(t))!;
      expect(Math.abs(mic - bursts.start[i]! / R) * 1000).toBeLessThan(5);
    }
    const bad = cameraClock({ packets: s.packets, frames: [], bursts });
    expect(bad.ok).toBe(false);
    expect(cameraTsToMicSeconds(bad, s.tsOf(startT[0]!))).toBeNull();
  });
});
