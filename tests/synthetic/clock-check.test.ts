// Spec 13.4, "synthetic sessions": known truth and injected faults; the clock check (6.3)
// catches each fault and passes the clean session.

import { beforeAll, describe, expect, it } from 'vitest';
import {
  cameraClock,
  clockCalib,
  clockCheck,
  clockCheckDetails,
  hardFailures,
  lipFrames,
  loopRule,
  lrtValuesMs,
  measureLoopBlocks,
  packetTimes,
  sniffLag,
  sniffLrtMs,
  tracePackets,
  type ClockReport,
} from '../../core/clock/index.ts';
import { validateCalib, validateClockReport } from '../../core/schemas/index.ts';
import { calibSniffLagBlock } from '../../analysis/clocks/compute.ts';
import { makeSyntheticSession, type HardEventKind, type SyntheticFaults, type SyntheticSession } from './session.ts';

const R = 48_000;

/** validateCalib on core/clock's sniff block without the clocks step's two fields (PREREG §4). */
const SNIFF_PART_REFUSED = [
  'sniff_lag_ms.no_arrival: missing: the found sniffs whose trace never arrived are counted beside n (PREREG §4)',
  'sniff_lag_ms.median_over_ms: missing: null, or the bound of medians that fall on sniffs without an arrival (PREREG §4)',
];

function check(faults: SyntheticFaults): { report: ClockReport; failures: string[]; truth: SyntheticSession['truth'] } {
  const { session, truth } = makeSyntheticSession({ narrationS: 16, faults });
  const report = clockCheck(session);
  expect(validateClockReport(report)).toEqual([]);
  return { report, failures: hardFailures(report), truth };
}

describe('clean sessions pass the clock check', () => {
  let clean: SyntheticSession;
  let report: ClockReport;
  beforeAll(() => {
    clean = makeSyntheticSession();
    report = clockCheck(clean.session);
  });

  it('numbers session: audio and trace valid, rule mean, every stop confirmed', () => {
    expect(hardFailures(report)).toEqual([]);
    expect(report.audio_valid).toBe(true);
    expect(report.trace_valid).toBe(true);
    expect(report.chain).toMatchObject({ rule: 'mean', quantum_ms: 2.7, stops: 3, stops_match_ch1: 3, nCmd_minus_nArr: 0 });
    expect(report.hard).toEqual({
      chunks_contiguous: true,
      sample_rate: 48_000,
      mic_flags_off: true,
      device_events: 0,
      visibility_events: 0,
      trace_rate_median: 30,
      sdk_errors: 0,
      tap_lost: 0,
    });
    expect(report.onset).toBeNull();
    expect(report.warn.window_warnings).toBe(0);
    expect(report.warn.status_ok_share).toBe(1);
    expect(report.warn.not_sent_share!).toBeLessThan(0.02);
    expect(report.warn.tap_loop_p99_ms!).toBeGreaterThan(0);
  });

  it('measures the known L_rt in both loop checks', () => {
    const loop = measureLoopBlocks(clean.session);
    for (const block of [loop.A!, loop.B!]) {
      expect(block.found).toBe(10);
      expect(Math.abs(block.L_rt_ms! - clean.truth.lrtMs.A)).toBeLessThan(0.15);
      expect(block.spread_ms!).toBeLessThan(0.6);
    }
    const lrt = loopRule(loop.A, loop.B);
    expect(report.chain.L_rt_ms).toEqual([lrt.A, lrt.B]);
    expect(report.chain.spread_ms).toEqual(lrt.spread);
    expect(Math.abs(lrt.used! - 23.4)).toBeLessThanOrEqual(0.1);
  });

  it('prints measured numbers only, never proven or met, in the core/schemas shape', () => {
    expect(JSON.stringify(report)).not.toMatch(/\b(proven|met)\b/i);
    expect(validateClockReport(report)).toEqual([]);
  });

  it('gives the same report through clockCheckDetails, with the calib.json L_rt block beside it', () => {
    const d = clockCheckDetails(clean.session);
    expect(d.report).toEqual(report);
    expect(d.failures).toEqual([]);
    expect(d.lrt.rule).toBe(report.chain.rule);
    expect(d.stops.map((s) => s.nSilent)).toEqual(clean.truth.stops.map((s) => s.nSilent));
  });

  it('only warns on blur and resize', () => {
    const events = [...clean.session.events, { n: 10 * R, e: 'blur' }, { n: 11 * R, e: 'resize' }];
    const r = clockCheck({ ...clean.session, events });
    expect(r.warn.window_warnings).toBe(2);
    expect(r.audio_valid).toBe(true);
  });

  it('gate recording passes with no stops', () => {
    const gate = makeSyntheticSession({ scenario: 'gate', narrationS: 20 });
    const r = clockCheck(gate.session);
    expect(hardFailures(r)).toEqual([]);
    expect(r.chain).toMatchObject({ stops: 0, stops_match_ch1: 0, nCmd_minus_nArr: null });
  });

  it('clockCalib writes the calib.json clock blocks of a gate recording (spec 7.12, 8.1)', () => {
    const gate = makeSyntheticSession({ scenario: 'gate', narrationS: 20 });
    const { truth } = gate;
    const { calib, camera, sniff } = clockCalib(gate.session, {
      bursts: truth.paBursts,
      sniff: { onsets: truth.sniffOnsets, aRef: truth.aRef, sign: truth.sign },
    });
    // The clocks step writes the sniff block with the count of sniffs without an arrival (PREREG §4).
    const lag = calibSniffLagBlock(sniff!);
    expect(lag).toMatchObject({ n: 5, no_arrival: 0, median_over_ms: null });
    expect(validateCalib({ schema: 'calib/1', ...calib, sniff_lag_ms: lag })).toEqual([]);
    // clockCalib's own sniff block is only the measured part (n and the medians): calib.json
    // refuses it as it is, so no writer may put clockCalib().calib into the file unchanged.
    expect(calib.sniff_lag_ms).toEqual({ n: 5, lo_median: lag.lo_median, hi_median: lag.hi_median });
    expect(validateCalib({ schema: 'calib/1', ...calib })).toEqual(SNIFF_PART_REFUSED);
    expect(calib.L_rt_ms).toMatchObject({ rule: 'mean', used: expect.any(Number) });
    expect(Math.abs(calib.L_rt_ms.used! - truth.lrtMs.A)).toBeLessThanOrEqual(0.2);
    expect(calib.camera_clock).toMatchObject({ ok: true });
    expect(Math.abs(calib.camera_clock!.slope_ppm! - truth.cameraSlopePpm)).toBeLessThan(10);
    expect(calib.sniff_lag_ms).toMatchObject({ n: 5 });
    expect(calib.sniff_lag_ms!.hi_median! - calib.sniff_lag_ms!.lo_median!).toBeCloseTo(calib.L_rt_ms.used!, 0);
    expect(camera!.start.found).toBe(5);
    expect(sniff!.reading).toBe('BETWEEN');
    // A numbers session has no sniffs: no sniff block; without bursts no camera block.
    const plain = clockCalib(makeSyntheticSession({ narrationS: 16 }).session);
    expect(plain.calib).toMatchObject({ camera_clock: null, sniff_lag_ms: null, L_rt_ms: { rule: 'mean' } });
  });

  it('a recording without the camera has no trace conditions', () => {
    const nc = makeSyntheticSession({ camera: false, narrationS: 16 });
    const r = clockCheck(nc.session, { camera: false });
    expect(r.audio_valid).toBe(true);
    expect(r.trace_valid).toBeNull();
    expect(r.chain).toMatchObject({ stops: 3, stops_match_ch1: 3, nCmd_minus_nArr: null });
  });

  it('the camera clock agrees at start and end, and the slope is the drift', () => {
    const { session, truth } = clean;
    const c = cameraClock({ packets: packetTimes(session), frames: lipFrames(session), bursts: truth.paBursts });
    expect(c.ok).toBe(true);
    expect(c.start.found).toBe(5);
    expect(c.end.found).toBe(5);
    expect(Math.abs(c.calib.offset_ms[0]! - c.calib.offset_ms[1]!)).toBeLessThan(5);
    expect(Math.abs(c.calib.slope_ppm! - truth.cameraSlopePpm)).toBeLessThan(10);
    for (const [i, o] of c.start.openings.entries()) {
      expect(Math.abs(o.tsOpenUs! - truth.lipOpeningsUs.start[i]!) / 1000).toBeLessThan(8);
    }
    const late = { start: truth.paBursts.start, end: truth.paBursts.end.map((n) => n + 0.03 * R) };
    expect(cameraClock({ packets: packetTimes(session), frames: lipFrames(session), bursts: late }).ok).toBe(false);
  });

  it('the sniff lag lies where the synthetic trace delay puts it', () => {
    const gate = makeSyntheticSession({ scenario: 'gate', narrationS: 20 });
    const { truth } = gate;
    const loop = measureLoopBlocks(gate.session);
    const lrt = loopRule(loop.A, loop.B);
    const r = sniffLag({
      onsets: truth.sniffOnsets,
      packets: tracePackets(gate.session),
      aRef: truth.aRef,
      lrtMs: Math.max(...lrtValuesMs(lrt)),
    });
    expect(r.n).toBe(5);
    // Trace delay + rise to 0.15 A_ref (83 ms) + frame wait (0-33 ms) + latency (>= 40 ms) - L_in.
    const low = truth.traceLagMs + 83 + truth.minLatencyMs - truth.lInMs;
    for (const s of r.sniffs) {
      expect(s.loMs!).toBeGreaterThan(low);
      expect(s.loMs!).toBeLessThan(low + 33 + 80);
      expect(s.bestCaseMs!).toBeLessThan(s.loMs!);
    }
    expect(r.calib.hi_median! - r.calib.lo_median!).toBeCloseTo(lrt.used!, 0);
    expect(r.reading).toBe('BETWEEN');
  });
});

describe('calib.json sniff block without a valid L_rt (spec 6.3, 8.1)', () => {
  it('sniffLrtMs gives L_rt only under rules mean and both', () => {
    expect(sniffLrtMs({ A: 23.4, B: 23.6, spread: [0.1, 0.1], rule: 'mean', used: 23.5 })).toBe(23.5);
    expect(sniffLrtMs({ A: 23.4, B: 30.4, spread: [0.1, 0.1], rule: 'both', used: null })).toBe(30.4);
    expect(sniffLrtMs({ A: 20, B: 40, spread: [0.1, 0.1], rule: 'void', used: null })).toBeNull();
    expect(sniffLrtMs({ A: 23.4, B: null, spread: [0.1, null], rule: 'void', used: null })).toBeNull();
    expect(sniffLrtMs({ A: null, B: null, spread: [null, null], rule: 'void', used: null })).toBeNull();
  });

  it('a gate recording with L_rt shifted by 20 ms keeps n and lo_median; hi_median and the reading are null', () => {
    const gate = makeSyntheticSession({ scenario: 'gate', narrationS: 20, faults: { lrtShiftMs: 20 } });
    const { truth } = gate;
    const { calib, sniff } = clockCalib(gate.session, {
      bursts: truth.paBursts,
      sniff: { onsets: truth.sniffOnsets, aRef: truth.aRef, sign: truth.sign },
    });
    // The file's block: n and lo_median, the count beside n, no hi_median, no bound.
    const lag = calibSniffLagBlock(sniff!);
    expect(lag).toEqual({ n: 5, no_arrival: 0, lo_median: expect.any(Number), hi_median: null, median_over_ms: null });
    expect(validateCalib({ schema: 'calib/1', ...calib, sniff_lag_ms: lag })).toEqual([]);
    expect(calib.L_rt_ms.rule).toBe('void');
    // clockCalib's measured part, which the file refuses alone (see above).
    expect(calib.sniff_lag_ms).toEqual({ n: 5, lo_median: lag.lo_median, hi_median: null });
    expect(validateCalib({ schema: 'calib/1', ...calib })).toEqual(SNIFF_PART_REFUSED);
    expect(sniff!.reading).toBeNull();
    expect(sniff!.sniffs.every((s) => s.loMs !== null && s.hiMs === null)).toBe(true);
  });
});

describe('the spec 13.4 faults on other seeds', () => {
  it.each([2, 3])('seed %i: clean passes; L_rt +7 ms flags, +20 ms voids, a lost block and 15 per second fail', (seed) => {
    const run = (faults: SyntheticFaults): ClockReport => clockCheck(makeSyntheticSession({ seed, narrationS: 16, faults }).session);
    expect(hardFailures(run({}))).toEqual([]);
    const shift7 = run({ lrtShiftMs: 7 });
    expect([shift7.chain.rule, hardFailures(shift7)]).toEqual(['both', []]);
    expect(run({ lrtShiftMs: 20 }).chain.rule).toBe('void');
    expect(hardFailures(run({ dropChunk: true }))).toEqual(['audio blocks not contiguous']);
    expect(hardFailures(run({ traceRateHz: 15 }))).toEqual(['trace rate median 15 per s, below 25']);
  });
});

describe('the clock check catches each injected fault (spec 13.4)', () => {
  it('L_rt shifted by 7 ms between A and B: rule both, recording flagged but valid', () => {
    const { report, failures, truth } = check({ lrtShiftMs: 7 });
    expect(report.chain.rule).toBe('both');
    expect(Math.abs(report.chain.L_rt_ms[1]! - truth.lrtMs.B)).toBeLessThanOrEqual(0.2);
    expect(report.audio_valid).toBe(true);
    expect(failures).toEqual([]);
  });

  it('L_rt shifted by 20 ms: rule void, audio invalid', () => {
    const { report, failures } = check({ lrtShiftMs: 20 });
    expect(report.chain.rule).toBe('void');
    expect(report.audio_valid).toBe(false);
    expect(failures).toEqual(['L_rt of loop checks A and B differs by more than 15 ms']);
  });

  it('a dropped audio block', () => {
    const { report, failures } = check({ dropChunk: true });
    expect(report.hard.chunks_contiguous).toBe(false);
    expect(report.audio_valid).toBe(false);
    expect(report.chain.rule).toBe('mean');
    expect(failures).toEqual(['audio blocks not contiguous']);
  });

  it('a trace at 15 samples per second', () => {
    const { report, failures } = check({ traceRateHz: 15 });
    expect(report.hard.trace_rate_median).toBe(15);
    expect(report.trace_valid).toBe(false);
    expect(report.audio_valid).toBe(true);
    expect(failures).toEqual(['trace rate median 15 per s, below 25']);
  });

  it('an SDK error', () => {
    const { report, failures } = check({ sdkError: true });
    expect(report.hard.sdk_errors).toBe(1);
    expect(report.trace_valid).toBe(false);
    expect(failures).toEqual(['1 SDK error event(s)']);
  });

  it('a lost tap', () => {
    const { report, failures } = check({ tapLost: true });
    expect(report.hard.tap_lost).toBe(1);
    expect(report.trace_valid).toBe(false);
    expect(failures).toEqual(['tap lost 1 time(s)']);
  });

  it.each<[HardEventKind, 'device_events' | 'visibility_events']>([
    ['devicechange', 'device_events'],
    ['track_ended', 'device_events'],
    ['track_mute', 'device_events'],
    ['hidden', 'visibility_events'],
  ])('a hard event: %s', (kind, field) => {
    const { report, failures } = check({ hardEvent: kind });
    expect(report.hard[field]).toBe(1);
    expect(report.audio_valid).toBe(false);
    expect(report.trace_valid).toBe(true);
    expect(failures).toHaveLength(1);
  });

  it('microphone processing left on, and a 44.1 kHz microphone', () => {
    expect(check({ micProcessing: true }).failures).toEqual(['microphone processing not off']);
    expect(check({ micSampleRateHz: 44_100 }).failures).toEqual(['sample rate 44100 Hz, not 48000']);
  });

  it('a live stop that channel 1 does not confirm', () => {
    const { report, failures } = check({ stopNotSilent: true });
    expect(report.chain).toMatchObject({ stops: 3, stops_match_ch1: 2 });
    expect(report.audio_valid).toBe(false);
    expect(failures).toEqual(['channel 1 not silent after 1 of 3 stops']);
  });
});
