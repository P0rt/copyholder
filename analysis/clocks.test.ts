// clocks (spec 6.3, 7.12, 8.1, 8.5) on synthetic recordings of tests/synthetic: every fault of
// spec 6.3 is a hard failure, a clean recording passes, the camera clock agrees within 25 ms when
// the camera time is consistent and not when it drifts, and the ledger order is kept.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { LoopMeasurement, SampleLine, SessionData } from '../core/clock/index.ts';
import {
  canAppendStep,
  sampleToDetectorIn,
  validateCalib,
  validateClockReport,
  verifyLedger,
  type DetectorInLine,
  type Manifest,
  type RecordKind,
  type SampleLine as SchemaSampleLine,
} from '../core/schemas/index.ts';
import { makeSyntheticSession, type SyntheticOptions } from '../tests/synthetic/session.ts';
import { CLOCK_REPORT_FILE, EXIT_CLOCK_CHECK_FAILED, EXIT_OK, EXIT_REFUSED, SIGN_NOTE, runClocks, type ClocksRun } from './clocks.ts';
import { calibSniffLagBlock, clocksPlan, computeClocks, mergeCalib, recountSniffLag, type ClocksComputation } from './clocks/compute.ts';
import { coreLrtOf } from './gate/common.ts';
import { samplesFromDetectorIn } from './clocks/inputs.ts';
import { readLedger } from './clocks/ledger-io.ts';
import { makeGateFolder, type GateFolder } from './label/fixture.ts';
import { inMemorySession, writeSessionFolder } from './lib/fixtures.ts';
import { appendLedgerStep, sha256Hex } from './lib/ledger.ts';
import { loadSession, stepSpan } from './lib/session.ts';
import { LOOP_STEPS, gateSteps } from './lib/steps.ts';

const R = 48_000;
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'clocks-test-'));
afterAll(() => fs.rmSync(ROOT, { recursive: true, force: true }));

const quiet = { out: () => undefined, now: () => new Date('2026-11-13T18:20:00Z'), commit: () => 'abc1234' };

function manifestOf(data: SessionData, kind: RecordKind, id: string): Manifest {
  return { schema: 'session/1', id, kind, pack: kind === 'gate' ? 'A' : null, scenario: kind === 'gate' ? 'gate-A' : kind, audio: { settings: data.micSettings } } as unknown as Manifest;
}

/** Clock computation of a synthetic recording in memory (no files). */
function computeFor(data: SessionData, kind: RecordKind, detectorIn: DetectorInLine[] = []): ClocksComputation {
  const manifest = manifestOf(data, kind, 'mem-1');
  const plan = clocksPlan(manifest);
  if ('refuse' in plan) throw new Error(plan.refuse);
  return computeClocks({ ...inMemorySession(data, manifest), detectorIn }, plan);
}

function sessionWith(opts: SyntheticOptions): SessionData {
  return makeSyntheticSession({ narrationS: 16, replies: 2, seed: 11, ...opts }).session;
}

/** Camera timestamps of the packets (trace, talking flag, landmarks, callback time) mapped by f. */
function warpCameraTime(samples: readonly SampleLine[], f: (ts: number) => number): SampleLine[] {
  return samples.map((l) => {
    if (l.k !== 'm') return l;
    const out: SampleLine = { ...l };
    if (l.tr) out.tr = l.tr.map(([t, v]) => [f(t), v] as const);
    if (l.talk) out.talk = l.talk.map(([t, v]) => [f(t), v] as const);
    if (l.lm) out.lm = { ...l.lm, ts: f(l.lm.ts) };
    if (typeof l.tsCbUs === 'number') out.tsCbUs = f(l.tsCbUs);
    return out;
  });
}

describe('clocks on a clean gate recording', () => {
  let folder: GateFolder;
  let run: ClocksRun;
  beforeAll(() => {
    folder = makeGateFolder(ROOT, { id: 'gate-clean', narrationS: 40, through: 'quickcheck' });
    run = runClocks(loadSession(folder.dir), quiet);
  }, 60_000);

  it('passes the clock check and writes valid clock_report.json and calib.json', () => {
    expect(run.code).toBe(EXIT_OK);
    expect(run.computation!.failures).toEqual([]);
    const report = JSON.parse(fs.readFileSync(path.join(folder.dir, CLOCK_REPORT_FILE), 'utf8')) as unknown;
    const calib = JSON.parse(fs.readFileSync(path.join(folder.dir, 'calib.json'), 'utf8')) as Record<string, unknown>;
    expect(validateClockReport(report)).toEqual([]);
    expect(validateCalib(calib)).toEqual([]);
    expect(report).toMatchObject({ audio_valid: true, trace_valid: true, onset: null, chain: { rule: 'mean', quantum_ms: 2.7, stops: 0 } });
    const lrt = calib['L_rt_ms'] as { A: number; B: number; rule: string };
    expect(Math.abs(lrt.A - folder.truth.lrtMs.A)).toBeLessThan(1);
    expect(Math.abs(lrt.B - folder.truth.lrtMs.B)).toBeLessThan(1);
    expect(lrt.rule).toBe('mean');
  });

  it('puts the camera clock on the audio scale: start and end offsets agree within 25 ms', () => {
    const cam = run.computation!.calib.camera_clock!;
    expect(cam.ok).toBe(true);
    const [s, e] = cam.offset_ms;
    expect(Math.abs(s! - e!)).toBeLessThanOrEqual(25);
    expect(run.computation!.pa!.start.bursts).toHaveLength(5);
    expect(run.computation!.pa!.end.bursts).toHaveLength(5);
    for (const [found, truth] of [
      [run.computation!.pa!.start.bursts, folder.truth.paBursts.start],
      [run.computation!.pa!.end.bursts, folder.truth.paBursts.end],
    ] as const) {
      found.forEach((n, i) => expect(Math.abs(n - truth[i]!)).toBeLessThanOrEqual(5 * 48));
    }
  });

  it('writes the trace sign of the three deep breaths, A_ref and the sniff lag interval', () => {
    const g = run.computation!.gate!;
    const calib = run.computation!.calib;
    expect(calib.polarity).toEqual({ sign: 1, breaths_agree: 3 });
    expect(calib.A_ref).toBeCloseTo(folder.truth.aRef, 1);
    expect(g.sniffs.map((x) => x.n)).toHaveLength(5);
    g.sniffs.forEach((x, i) => expect(Math.abs(x.n! - folder.truth.sniffOnsets[i]!)).toBeLessThanOrEqual(10 * 48));
    const lag = calib.sniff_lag_ms!;
    expect(lag.n).toBe(5);
    // All five arrived: the count beside n is 0 and the medians are measured (PREREG §4).
    expect([lag.no_arrival, lag.median_over_ms]).toEqual([0, null]);
    expect(lag).toEqual(calibSniffLagBlock(g.lag!));
    // [lo, lo + L_rt]: the upper bound is the lower one plus L_rt.
    expect(lag.hi_median! - lag.lo_median!).toBeCloseTo(run.computation!.check.lrt.used!, 0);
    expect(lag.lo_median!).toBeGreaterThan(folder.truth.traceLagMs);
    expect(g.signDisagrees).toBe(false);
  });

  it('lets analyze:gate recompute the sniff lag exactly from the files and calib.json (spec 9.6, PREREG §4)', () => {
    const session = loadSession(folder.dir);
    const calib = session.calib!;
    const recount = recountSniffLag(session, gateSteps('A'), coreLrtOf(calib.L_rt_ms!), calib.polarity!.sign!);
    // The same block to 0.1 ms, and the same unrounded medians and count of sniffs without arrival.
    expect(calibSniffLagBlock(recount.lag!)).toEqual(calib.sniff_lag_ms);
    expect(recount.lag).toEqual(run.computation!.gate!.lag);
    expect(recount.onsets).toEqual(run.computation!.gate!.sniffs.map((x) => x.n));
  });

  it('appends the ledger step clocks with the hashes of the files it wrote', () => {
    const ledger = readLedger(folder.dir, 'gate');
    const last = ledger.records[ledger.records.length - 1]!;
    expect(last.step).toBe('clocks');
    if (last.step === 'note') throw new Error('unexpected note');
    expect(last.out_sha256).toEqual({
      'calib.json': sha256Hex(fs.readFileSync(path.join(folder.dir, 'calib.json'))),
      [CLOCK_REPORT_FILE]: sha256Hex(fs.readFileSync(path.join(folder.dir, CLOCK_REPORT_FILE))),
    });
    expect(last.commit).toBe('abc1234');
    expect(verifyLedger(ledger.lines, sha256Hex, { kind: 'gate' }).ok).toBe(true);
  });

  it('prints measured numbers in plain words, never "proven" or "met"', () => {
    const text = run.lines.join('\n');
    expect(text).not.toMatch(/\b(proven|met)\b/i);
    expect(text).toContain('L_rt loop check A: 23.');
    expect(text).toContain('stamp quantum: 2.7 ms');
    expect(text).toContain('CLOCKS: audio valid, trace valid');
  });

  it('keeps calib.json keys of other writers and replaces only its own blocks', () => {
    const merged = mergeCalib({ schema: 'calib/1', output_gain: 0.25, leak_db_over_floor: 2.5, L_rt_ms: { A: 1 } }, run.computation!.calib);
    expect(merged.output_gain).toBe(0.25);
    expect(merged.leak_db_over_floor).toBe(2.5);
    expect(merged.L_rt_ms).toEqual(run.computation!.calib.L_rt_ms);
    expect(validateCalib(merged)).toEqual([]);
  });
});

describe('clocks and the ledger order (spec 8.5)', () => {
  it('refuses before quickcheck is in the ledger and writes nothing', () => {
    const { dir } = makeGateFolder(ROOT, { id: 'gate-no-qc', through: 'record' });
    const before = fs.readFileSync(path.join(dir, 'ledger.jsonl'), 'utf8');
    const run = runClocks(loadSession(dir), quiet);
    expect(run.code).toBe(EXIT_REFUSED);
    expect(run.refused).toMatch(/quickcheck/);
    expect(fs.existsSync(path.join(dir, CLOCK_REPORT_FILE))).toBe(false);
    expect(fs.existsSync(path.join(dir, 'calib.json'))).toBe(false);
    expect(fs.readFileSync(path.join(dir, 'ledger.jsonl'), 'utf8')).toBe(before);
  });

  it('may run again right after itself, but not once onsets is written', () => {
    const { dir } = makeGateFolder(ROOT, { id: 'gate-rerun' });
    expect(runClocks(loadSession(dir), quiet).code).toBe(EXIT_OK);
    expect(readLedger(dir, 'gate').records.filter((r) => r.step === 'clocks')).toHaveLength(2);
    appendLedgerStep(dir, 'gate', 'onsets', { utc: '2026-11-13T18:30:00Z', commit: null, outSha256: { 'onsets.json': sha256Hex('x') } });
    const run = runClocks(loadSession(dir), quiet);
    expect(run.code).toBe(EXIT_REFUSED);
    expect(run.refused).toMatch(/out of order/);
  });

  it('refuses record kinds without a ledger or without the clocks step', () => {
    const { session } = makeSyntheticSession({ narrationS: 16, replies: 2, seed: 3 });
    const doctor = writeSessionFolder(ROOT, session, { id: 'doctor-9', kind: 'doctor', scenario: 'doctor' });
    expect(runClocks(loadSession(doctor), quiet).refused).toMatch(/has no ledger/);
    const pilot = writeSessionFolder(ROOT, session, { id: 'pilot-1', kind: 'pilot' });
    expect(appendLedgerStep(pilot, 'pilot', 'quickcheck', { utc: '2026-11-13T18:13:00Z', commit: null, outSha256: { 'quickcheck.json': sha256Hex('q') } }).appended).toBe(true);
    expect(runClocks(loadSession(pilot), quiet).refused).toMatch(/not in the pilot order/);
  });
});

describe('every fault of spec 6.3 is a hard failure', () => {
  it('a clean session recording passes', () => {
    const c = computeFor(sessionWith({}), 'numbers');
    expect(c.failures).toEqual([]);
    expect(c.report.audio_valid).toBe(true);
    expect(c.report.trace_valid).toBe(true);
    expect(c.report.chain.stops).toBe(2);
    expect(c.report.chain.stops_match_ch1).toBe(2);
    expect(c.report.chain.nCmd_minus_nArr).toBe(0);
  });

  const cases: Array<[string, SyntheticOptions['faults'], RegExp, 'audio' | 'trace']> = [
    ['L_rt of A and B 20 ms apart', { lrtShiftMs: 20 }, /differs by more than 15 ms/, 'audio'],
    ['a lost audio block', { dropChunk: true }, /audio blocks not contiguous/, 'audio'],
    ['microphone processing on', { micProcessing: true }, /microphone processing not off/, 'audio'],
    ['a 44.1 kHz microphone', { micSampleRateHz: 44_100 }, /sample rate 44100 Hz, not 48000/, 'audio'],
    ['a hidden page', { hardEvent: 'hidden' }, /page hidden 1 time/, 'audio'],
    ['a device change', { hardEvent: 'devicechange' }, /device event/, 'audio'],
    ['a microphone track that ended', { hardEvent: 'track_ended' }, /device event/, 'audio'],
    ['a muted microphone track', { hardEvent: 'track_mute' }, /device event/, 'audio'],
    ['a stop with sound in channel 1', { stopNotSilent: true }, /channel 1 not silent after 1 of 2 stops/, 'audio'],
    ['a trace at 15 per second', { traceRateHz: 15 }, /trace rate median 15/, 'trace'],
    ['an SDK error', { sdkError: true }, /1 SDK error event/, 'trace'],
    ['a lost tap', { tapLost: true }, /tap lost 1 time/, 'trace'],
  ];
  it.each(cases)('%s', (_name, faults, message, part) => {
    const c = computeFor(sessionWith({ faults }), 'numbers');
    expect(c.failures.some((f) => message.test(f))).toBe(true);
    if (part === 'audio') expect(c.report.audio_valid).toBe(false);
    else expect(c.report.trace_valid).toBe(false);
    expect(validateClockReport(c.report)).toEqual([]);
  });

  it.each(['A', 'B'] as const)('no clicks in loop check %s: rule void and a hard failure', (which) => {
    const data = sessionWith({});
    const span = stepSpan(inMemorySession(data, manifestOf(data, 'numbers', 'mem-1')), LOOP_STEPS[which]);
    if (span === null) throw new Error(`no ${LOOP_STEPS[which]} step`);
    const clicks = data.stamps.filter((s) => s.k === 'click' && s.n >= span.n0 && s.n < span.n1);
    expect(clicks.length).toBeGreaterThan(0);
    // Deck played no click in this loop check.
    const c = computeFor({ ...data, stamps: data.stamps.filter((s) => !clicks.includes(s)) }, 'numbers');
    expect(c.loops[which]).toBeNull();
    expect(c.loops[which === 'A' ? 'B' : 'A']).not.toBeNull();
    expect(c.report.chain.L_rt_ms[which === 'A' ? 0 : 1]).toBeNull();
    expect(c.report.chain.rule).toBe('void');
    expect(c.calib.L_rt_ms).toMatchObject({ rule: 'void', used: null });
    expect(c.failures).toContain('loop check A or B not found');
    expect(c.report.audio_valid).toBe(false);
    expect(validateClockReport(c.report)).toEqual([]);
  });

  it('a 7 ms spread between A and B is flagged with rule both, not a failure', () => {
    const c = computeFor(sessionWith({ faults: { lrtShiftMs: 7 } }), 'numbers');
    expect(c.failures).toEqual([]);
    expect(c.report.chain.rule).toBe('both');
    expect(c.calib.L_rt_ms?.used).toBeNull();
  });

  it('blur and resize only warn', () => {
    const data = sessionWith({});
    const mid = Math.round(data.ch0.length / 2);
    const c = computeFor({ ...data, events: [...data.events, { n: mid, e: 'blur' }, { n: mid + 10, e: 'resize' }] }, 'numbers');
    expect(c.failures).toEqual([]);
    expect(c.report.warn.window_warnings).toBe(2);
  });

  it('a recording without the camera has no trace conditions and no camera clock', () => {
    const data = makeSyntheticSession({ narrationS: 16, replies: 2, seed: 4, camera: false }).session;
    const c = computeFor(data, 'spacebar');
    expect(c.failures).toEqual([]);
    expect(c.report.trace_valid).toBeNull();
    expect(c.calib.camera_clock).toBeNull();
  });
});

describe('the L_rt rule at its limits (spec 6.3, 7.12: mean up to 3 ms, both up to 15 ms)', () => {
  const data = sessionWith({});
  const manifest = manifestOf(data, 'numbers', 'mem-lrt');
  const plan = clocksPlan(manifest);
  if ('refuse' in plan) throw new Error(plan.refuse);
  const view = { ...inMemorySession(data, manifest), detectorIn: [] };
  const loop = (ms: number): LoopMeasurement => ({ L_rt_ms: ms, spread_ms: 0.2, found: 10, total: 10, clicks: [] });

  it.each([
    [26.4, 'mean', 24.9],
    [26.5, 'both', null],
    [38.4, 'both', null],
    [38.5, 'void', null],
  ] as const)('A 23.4 ms, B %s ms: rule %s', (b, rule, used) => {
    const c = computeClocks(view, plan, { loops: { A: loop(23.4), B: loop(b), clicks: { A: null, B: null } } });
    expect(c.report.chain.L_rt_ms).toEqual([23.4, b]);
    expect(c.report.chain.rule).toBe(rule);
    expect(c.calib.L_rt_ms).toMatchObject({ A: 23.4, B: b, rule, used });
    if (rule === 'void') {
      expect(c.failures).toContain('L_rt of loop checks A and B differs by more than 15 ms');
      expect(c.report.audio_valid).toBe(false);
    } else {
      expect(c.failures).toEqual([]);
      expect(c.report.audio_valid).toBe(true);
    }
    expect(validateClockReport(c.report)).toEqual([]);
  });
});

describe('camera clock (spec 6.3)', () => {
  const made = makeSyntheticSession({ scenario: 'gate', narrationS: 24, replies: 3, seed: 5 });
  const firstTs = made.session.samples.find((l) => l.k === 'm')!.tr![0]![0];
  // tests/synthetic: the SDK starts 0.5 s into the recording; camera time runs with real time.
  const tsAt = (n: number): number => firstTs + (n / R - 0.5) * 1e6;
  const midTs = tsAt((made.truth.narration[0] + made.truth.narration[1]) / 2);

  it('agrees within 25 ms when the camera clock runs at another but steady rate', () => {
    const data = { ...made.session, samples: warpCameraTime(made.session.samples, (t) => t + (t - firstTs) * 1.5e-3) };
    const c = computeFor(data, 'gate');
    expect(c.calib.camera_clock!.ok).toBe(true);
    const [s, e] = c.calib.camera_clock!.offset_ms;
    expect(Math.abs(s! - e!)).toBeLessThanOrEqual(25);
  });

  it('fails when the camera clock drifts during the recording, and only the camera positions go', () => {
    const data = { ...made.session, samples: warpCameraTime(made.session.samples, (t) => (t >= midTs ? t + (t - midTs) * 3e-3 : t)) };
    const c = computeFor(data, 'gate');
    expect(c.calib.camera_clock!.ok).toBe(false);
    const [s, e] = c.calib.camera_clock!.offset_ms;
    expect(Math.abs(s! - e!)).toBeGreaterThan(25);
    // Secondary clock: the recording itself still passes (spec 6.3).
    expect(c.failures).toEqual([]);
    expect(c.report.audio_valid).toBe(true);
    expect(c.report.trace_valid).toBe(true);
  });

  it('reads the lip gap from detector_in.jsonl when samples.jsonl has no packets', () => {
    const packets = made.session.samples.filter((l) => l.k === 'm' || l.k === 'v');
    const detectorIn = packets
      .map((l) => sampleToDetectorIn(l as unknown as SchemaSampleLine))
      .filter((x): x is NonNullable<typeof x> => x !== null);
    const rebuilt = samplesFromDetectorIn(detectorIn);
    expect(rebuilt.filter((l) => l.k === 'm')).toHaveLength(made.session.samples.filter((l) => l.k === 'm').length);
    const data = { ...made.session, samples: made.session.samples.filter((l) => l.k !== 'm') };
    const c = computeFor(data, 'gate', detectorIn);
    expect(c.sampleSource).toBe('detector_in.jsonl');
    expect(c.report.trace_valid).toBe(true);
    expect(c.calib.camera_clock!.ok).toBe(true);
  });
});

describe('trace sign against the sniffs (spec 7.4, 9.5)', () => {
  it('a disagreement is only a warning: a ledger note after the clocks step', () => {
    const folder = makeGateFolder(ROOT, {
      id: 'gate-sniff-sign',
      narrationS: 40,
      through: 'quickcheck',
      edit: (data, truth) => {
        // Mirror the trace around each sniff: the sniffs now lower it, the deep breaths still raise it.
        const arr = new Map<number, number>();
        for (const s of data.stamps) if (s.k === 'arr' && typeof s.seq === 'number') arr.set(s.seq, s.n);
        const near = (n: number): boolean => truth.sniffOnsets.some((x) => n >= x - 0.6 * R && n < x + 1.5 * R);
        const samples = data.samples.map((l) => {
          const nArr = l.seq === undefined ? undefined : arr.get(l.seq);
          if (l.k !== 'm' || nArr === undefined || !near(nArr) || !l.tr) return l;
          return { ...l, tr: l.tr.map(([t, v]) => [t, -v] as const) };
        });
        return { ...data, samples };
      },
    });
    const run = runClocks(loadSession(folder.dir), quiet);
    expect(run.code).toBe(EXIT_OK);
    const g = run.computation!.gate!;
    expect(g.deep.calib.sign).toBe(1);
    expect(g.sniffSign.sign).toBe(-1);
    expect(g.signDisagrees).toBe(true);
    const ledger = readLedger(folder.dir, 'gate');
    const tail = ledger.records.slice(-2);
    expect(tail[0]!.step).toBe('clocks');
    expect(tail[1]).toMatchObject({ step: 'note', what: SIGN_NOTE });
    expect(run.lines.join('\n')).toContain('warning written to the ledger');
    // The note does not block the next step.
    expect(canAppendStep(ledger.records, 'gate', 'onsets')).toBeNull();
  });
});

describe('exit code', () => {
  it('is 2 when the clock check fails, with the files and the ledger step still written', () => {
    const { dir } = makeGateFolder(ROOT, { id: 'gate-fault', through: 'quickcheck', faults: { micProcessing: true } });
    const run = runClocks(loadSession(dir), quiet);
    expect(run.code).toBe(EXIT_CLOCK_CHECK_FAILED);
    expect(run.lines[run.lines.length - 1]).toMatch(/^CLOCKS: microphone processing not off/);
    expect(readLedger(dir, 'gate').records.at(-1)!.step).toBe('clocks');
  });
});

describe('calib.json sniff_lag_ms as the clocks step writes it (spec 8.1, PREREG §4)', () => {
  it('counts the found sniffs whose trace never arrived beside n, and bounds medians that fall on them', () => {
    const measured = { calib: { n: 5, lo_median: 148, hi_median: 171.5 }, noArrival: 2, medianOverMs: null };
    expect(calibSniffLagBlock(measured)).toEqual({ n: 5, no_arrival: 2, lo_median: 148, hi_median: 171.5, median_over_ms: null });
    const half = { calib: { n: 4, lo_median: null, hi_median: null }, noArrival: 2, medianOverMs: 1000 };
    expect(calibSniffLagBlock(half)).toEqual({ n: 4, no_arrival: 2, lo_median: null, hi_median: null, median_over_ms: 1000 });
    // ms values of calib.json hold 0.1 ms (spec 8.1).
    expect(calibSniffLagBlock({ ...half, medianOverMs: 1000.04 }).median_over_ms).toBe(1000);
    for (const b of [calibSniffLagBlock(measured), calibSniffLagBlock(half)]) expect(validateCalib({ schema: 'calib/1', sniff_lag_ms: b })).toEqual([]);
  });
});
