// The whole time chain of a gate recording on synthetic data (spec 6.3, 7.12): core/onset finds
// the 'pa' bursts and the sniff onsets in channel 0, core/clock turns them into calib.json.

import { beforeAll, describe, expect, it } from 'vitest';
import { clockCalib, clockCheck, hardFailures, type ClockCalib } from '../../core/clock/index.ts';
import { findPaBursts, findSniffOnset } from '../../core/onset/events.ts';
import { validateCalib } from '../../core/schemas/index.ts';
import { calibSniffLagBlock } from '../../analysis/clocks/compute.ts';
import { makeSyntheticSession, type SyntheticSession } from './session.ts';

const R = 48_000;
const PA_BLOCK_SAMPLES = 15 * R;

describe('gate recording: onset finders into the clock module', () => {
  let gate: SyntheticSession;
  let bursts: { start: number[]; end: number[] };
  let sniffs: number[];
  let result: ClockCalib;

  beforeAll(() => {
    gate = makeSyntheticSession({ scenario: 'gate', narrationS: 20 });
    const { session, truth } = gate;
    const block = (first: string): number[] => {
      const from = truth.steps[first]!;
      return findPaBursts(session.ch0, from, from + PA_BLOCK_SAMPLES).bursts.map((b) => b.n);
    };
    bursts = { start: block('pa_start_1_closed'), end: block('pa_end_1_closed') };
    sniffs = [1, 2, 3, 4, 5].flatMap((i) => {
      const o = findSniffOnset(session.ch0, truth.steps[`sniff_${i}`]!);
      return o ? [o.n] : [];
    });
    result = clockCalib(session, { bursts, sniff: { onsets: sniffs, aRef: truth.aRef, sign: truth.sign } });
  });

  it('finds every burst and every sniff where the generator put them', () => {
    const { truth } = gate;
    expect(bursts.start).toHaveLength(5);
    expect(bursts.end).toHaveLength(5);
    [...bursts.start, ...bursts.end].forEach((n, i) => {
      const want = [...truth.paBursts.start, ...truth.paBursts.end][i]!;
      expect(Math.abs(n - want) / 48).toBeLessThan(3);
    });
    expect(sniffs).toHaveLength(5);
    sniffs.forEach((n, i) => expect(Math.abs(n - truth.sniffOnsets[i]!) / 48).toBeLessThan(10));
  });

  it('gives a valid calib.json: L_rt, a camera clock that agrees, and the sniff lag interval', () => {
    const { truth } = gate;
    const { calib } = result;
    // As the clocks step writes it: the sniff block with the count of sniffs without an arrival (PREREG §4).
    expect(validateCalib({ schema: 'calib/1', ...calib, sniff_lag_ms: calibSniffLagBlock(result.sniff!) })).toEqual([]);
    expect(calib.L_rt_ms.rule).toBe('mean');
    const [a, b] = calib.camera_clock!.offset_ms;
    expect(calib.camera_clock!.ok).toBe(true);
    expect(Math.abs(a! - b!)).toBeLessThan(5);
    expect(Math.abs(calib.camera_clock!.slope_ppm! - truth.cameraSlopePpm)).toBeLessThan(10);
    // The offset is the shortest frame-to-Deck latency less L_in, plus the onset finder's bias.
    expect(a!).toBeGreaterThan(truth.minLatencyMs - truth.lInMs - 5);
    expect(a!).toBeLessThan(truth.minLatencyMs - truth.lInMs + 15);
    expect(calib.sniff_lag_ms!.n).toBe(5);
    expect(calib.sniff_lag_ms!.hi_median! - calib.sniff_lag_ms!.lo_median!).toBeCloseTo(calib.L_rt_ms.used!, 0);
    expect(result.sniff!.reading).toBe('BETWEEN');
    expect(hardFailures(clockCheck(gate.session))).toEqual([]);
  });
});
