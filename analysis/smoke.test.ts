// Smoke report (spec 7.12) on synthetic smoke sessions written in the formats of live/tap.cjs
// (lines made by reduce.cjs, sdk_raw.jsonl.gz, tap.log) and live/mock-tap.cjs.

import fc from 'fast-check';
import { appendFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DRY_RUN_NOTE } from './lib/dry-run.ts';
import { loadSession } from './lib/session.ts';
import { smokeStepNames } from './lib/steps.ts';
import { traceRateMedian, type SampleLine } from '../core/clock/index.ts';
import { main, runSmoke, SMOKE_EXIT, type SmokeOptions } from './smoke.ts';
import { parseCreditBalances, watchdogWouldFire } from './smoke/answers-run.ts';
import { DEEP_BREATHS, SMOKE_STEPS } from './smoke/context.ts';
import { medianCountPerSecond, medianWithEmptyWindows } from './smoke/numbers.ts';
import { accessorPaths, longJsonToNumber, REDUCE_PATH, timestampToUs } from './smoke/reduce-adapter.ts';
import { QUESTION_KEYS, verdictLine } from './smoke/report.ts';
import { streamSpan } from './smoke/span.ts';
import { writeSmokeSession, type SynthOptions } from './smoke/synth.ts';
import { readSessionFolder } from './smoke/read.ts';
import { runLines, tapSmokeOutput } from './smoke/tap-output.ts';

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

let root = '';
beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'copyholder-smoke-'));
});
afterAll(() => {
  if (root) rmSync(root, { recursive: true, force: true });
});

interface Run {
  dir: string;
  ok: boolean;
  code: number;
  verdict: string;
  lines: string[];
  report: Json;
}

function smoke(name: string, synth: SynthOptions = {}, opts: SmokeOptions = {}): Run {
  const dir = join(root, name);
  writeSmokeSession(dir, { id: name, ...synth });
  const lines: string[] = [];
  const r = runSmoke(dir, { out: (l) => lines.push(l), ...opts });
  const report = JSON.parse(readFileSync(join(dir, 'smoke_report.json'), 'utf8')) as Json;
  return { dir, ok: r.ok, code: r.code, verdict: r.verdict, lines, report };
}

const verdictLines = (lines: readonly string[]) => lines.filter((l) => /^SMOKE (OK|FAIL)/.test(l));

describe('smoke report: verdict', () => {
  it('a clean run in the tap format is SMOKE OK, the verdict printed once and last', () => {
    const r = smoke('clean');
    expect(r.verdict).toBe('SMOKE OK');
    expect(r.ok).toBe(true);
    expect(r.code).toBe(SMOKE_EXIT.ok);
    expect(r.lines.at(-1)).toBe('SMOKE OK');
    expect(verdictLines(r.lines)).toEqual(['SMOKE OK']);
    expect(r.report['schema']).toBe('smoke-report/1');
    expect(r.report['verdict']).toBe('SMOKE OK');
    expect(Object.keys(r.report['questions'])).toEqual([...QUESTION_KEYS]);
    // Ten answers, numbered 1 to 10.
    for (let i = 1; i <= 10; i++) expect(r.lines.some((l) => l.startsWith(`${i}. `))).toBe(true);
  });

  it('answers every question with its numbers on a clean run', () => {
    const { report } = smoke('clean-answers', { sdkLogLines: ['I1112 10:00:00.100 camera opened at 1280x720, 30 fps'] });
    const q = report['questions'] as Json;
    expect(q['q1_start']).toMatchObject({ camera_opened: true, launcher: 'node', camera_name: 'FaceTime HD Camera' });
    expect(q['q1_start']['cameras']).toEqual(['FaceTime HD Camera', 'Desk View Camera']);
    expect(q['q1_start']['readiness']).toMatchObject({ verdict: 'ready' });
    expect(q['q2_data']).toMatchObject({ metrics_accepted: true });
    expect(q['q2_data']['first_frame']).toMatchObject({
      mesh_points: 478,
      y13_below_y14: true,
      x78_below_x308: true,
      units: 'pixels',
      inside_requested_frame: true,
    });
    // Every accessor returned data; talkingFlag stays unjudged: nobody talks, and a wrong field gives 0 too.
    const layout = q['q2_data']['layout'] as Json[];
    expect(layout.filter((f) => f['status'] !== 'ok').map((f) => [f['accessor'], f['status']])).toEqual([['talkingFlag', 'unknown']]);
    expect(layout.map((f) => f['accessor'])).toContain('decodeMetrics');
    expect(q['q2_data']['enums']).toHaveLength(3);
    expect(q['q3_trace_sign']).toMatchObject({ sign: 1, agree: true, margin: true, clock_map: 'envelope' });
    expect(q['q4_time']['sample_ts_types']).toEqual(['number']);
    expect(q['q4_time']['trace_ts_equal_frame_ts_share']).toBe(1);
    expect(q['q4_time']['arrival_minus_trace_ts_ms']['clock']).toBe('wall');
    expect(q['q4_time']['arrival_minus_trace_ts_ms']['median']).toBeGreaterThan(55);
    expect(q['q4_time']['arrival_minus_trace_ts_ms']['median']).toBeLessThan(80);
    expect(q['q5_rates']['trace']['median_per_s']).toBe(30);
    expect(q['q5_rates']['not_sent_share']).toBeGreaterThan(0);
    expect(q['q5_rates']['not_sent_share']).toBeLessThan(0.02);
    expect(q['q5_rates']['logged_frame_sizes'][0]).toMatchObject({ size: '1280x720' });
    expect(q['q6_screen_recording']['median_change_per_s']).toBe(0);
    expect(q['q7_lens_cover']['validation_changes'].map((c: Json) => c['name'])).toEqual(['kNoFaceFound', 'kOk']);
    expect(q['q7_lens_cover']['errors']).toEqual([]);
    expect(q['q8_watchdog']).toMatchObject({ watchdog_ms: 3000, watchdog_would_fire: false, tap_lost_events: 0 });
    expect(q['q8_watchdog']['loop_p99_ms']).toBe(1.8);
    expect(q['q9_credits']['camera_minutes']).toBeGreaterThan(1.8);
    expect(q['q9_credits']['balance']).toEqual({ before: null, after: null });
    expect(q['q9_credits']).toMatchObject({ pauses: [], not_measured: ['checkDeviceReadiness()', 'run stopped after 5 s'] });
    expect(q['q10_insights']).toMatchObject({ answered: true, match_count: 0 });
    expect(report['hard']).toMatchObject({
      running: { ok: true },
      trace_rate: { ok: true, median_per_s: 30, stray_timestamps: 0 },
      sdk_errors: { ok: true, count: 0, core_count: 0 },
    });
    expect(q['q5_rates']).toMatchObject({ frame_rate_source: 'frameSentThrough', frames_batched: false });
    expect(report['tap_console']).toMatchObject({ found: true });
    expect(report['reduce_cjs']).toMatchObject({ changed: false });
  });

  it('never Running: SMOKE FAIL naming the last processingStatus', () => {
    const r = smoke('never', { running: false });
    expect(r.ok).toBe(false);
    expect(r.code).toBe(SMOKE_EXIT.fail);
    expect(r.verdict).toBe('SMOKE FAIL: the SDK never reached Running (processingStatus: kStarting); no trace samples (no metrics packet arrived)');
    expect(r.lines.at(-1)).toBe(r.verdict);
    expect(verdictLines(r.lines)).toHaveLength(1);
    expect(r.report['hard']['running']).toMatchObject({ ok: false, statuses: ['kStarting'] });
    expect(r.report['questions']['q1_start']['camera_opened']).toBe(false);
  });

  it('15 trace samples per second: SMOKE FAIL on the median trace rate', () => {
    const r = smoke('slow', { traceRateHz: 15 });
    expect(r.verdict).toBe('SMOKE FAIL: median trace rate 15 per s is below 25');
    expect(r.report['hard']['trace_rate']).toMatchObject({ ok: false, median_per_s: 15, min_per_s: 25 });
    expect(r.report['hard']['running']['ok']).toBe(true);
  });

  it('an SDK error event: SMOKE FAIL naming the error', () => {
    const r = smoke('sdk-error', { sdkError: { code: 5, atS: 60 } });
    expect(r.verdict).toBe('SMOKE FAIL: 1 SDK error event: 5 kNetworkError: synthetic SDK error');
    const errors = r.report['hard']['sdk_errors'] as Json;
    // One rule (core/clock sdkErrorCount per source): the count the verdict uses is core's.
    expect(errors).toMatchObject({ count: 1, core_count: 1 });
    expect(errors['errors'][0]).toMatchObject({ code: 5, name: 'kNetworkError', message: 'synthetic SDK error', step: 'quiet', counted: true });
    // The same error seen in three files is one error.
    expect(errors['errors']).toHaveLength(1);
    expect(errors['errors'][0]['sources']).toEqual(['samples.jsonl', 'sdk_raw.jsonl.gz', 'events.jsonl']);
    // host aborted the run before the lens steps.
    expect(r.report['questions']['q7_lens_cover']['covered']).toBe(false);
  });

  it("one kProcessingFailed before the first packet is tap's restart, not a failure", () => {
    const r = smoke('restart', { sdkError: { code: 8, atS: 2 } });
    expect(r.verdict).toBe('SMOKE OK');
    expect(r.report['hard']['sdk_errors']).toMatchObject({ ok: true, count: 0, core_count: 0 });
    expect(r.report['hard']['sdk_errors']['errors'][0]).toMatchObject({ code: 8, counted: false, restart: true });
  });

  it('Long timestamps: the probe says Long and the run passes', () => {
    const r = smoke('long', { longTimestamps: true });
    expect(r.verdict).toBe('SMOKE OK');
    const time = r.report['questions']['q4_time'] as Json;
    expect(time['sample_ts_types']).toEqual(['Long']);
    expect(time['callback_ts_types']).toEqual(['Long']);
    expect(r.lines).toContain('   Timestamp type: Long in the decoded samples; Long for the timestampUs argument of the metrics callback.');
  });

  it('Long timestamps written as {low, high} objects are read as numbers', () => {
    const r = smoke('long-json', { longJson: true });
    expect(r.verdict).toBe('SMOKE OK');
    const time = r.report['questions']['q4_time'] as Json;
    expect(time['samples_time_types']['Long']).toBeGreaterThan(10_000);
    expect(time['logged_arg_types']['frameSentThrough']['Long']).toBeGreaterThan(3000);
    expect(r.report['questions']['q5_rates']['trace']['median_per_s']).toBe(30);
    expect(r.report['questions']['q3_trace_sign']['sign']).toBe(1);
    const samples = (r.report['inputs'] as Json[]).find((f) => f['file'] === 'samples.jsonl')!;
    expect(samples['note']).toMatch(/Long objects or strings, read as numbers/);
  });

  it('the mock tap format: no sdk_raw.jsonl.gz, no log; the run passes and Insights stays open', () => {
    const r = smoke('mock', { format: 'mock' });
    expect(r.verdict).toBe('SMOKE OK');
    const q = r.report['questions'] as Json;
    expect(q['q2_data']['first_frame']['source']).toMatch(/16 kept points/);
    expect(q['q2_data']['first_frame']).toMatchObject({ mesh_points: null, y13_below_y14: true, x78_below_x308: true });
    expect(q['q3_trace_sign']['sign']).toBe(1);
    expect(q['q10_insights']['answered']).toBe(false);
    expect(r.lines.join('\n')).toMatch(/Insights: cannot be answered \(tap's console is not in the session folder/);
    // The note at the top says what is missing and how to add it.
    const note = r.lines.find((l) => l.startsWith("tap's console is not in the session folder: host does not save it."));
    expect(note).toContain('npm run smoke 2>&1 | tee smoke.log');
    expect(r.lines.indexOf(note!)).toBeLessThan(r.lines.indexOf('1. Start'));
    expect(r.report['tap_console']).toMatchObject({ found: false, text_lines: 0 });
    expect((r.report['inputs'] as Json[]).find((f) => f['file'] === 'sdk_raw.jsonl.gz')).toMatchObject({ present: false });
  });

  it('a trace under a field reduce.cjs does not read: the report names chestSamples', () => {
    const r = smoke('layout', { traceFieldMissing: true });
    expect(r.verdict).toBe('SMOKE FAIL: no trace samples (reduce.cjs chestSamples returned nothing)');
    expect(r.lines.some((l) => l.includes('Layout: chestSamples (reads msg.breathing.upperTrace) returned nothing'))).toBe(true);
    const layout = r.report['questions']['q2_data']['layout'] as Json[];
    expect(layout.find((f) => f['accessor'] === 'chestSamples')).toMatchObject({ status: 'empty', reads: 'msg.breathing.upperTrace' });
    expect(layout.find((f) => f['accessor'] === 'landmarkFrames')).toMatchObject({ status: 'ok' });
    expect(r.report['questions']['q2_data']['probes'][0]['fields']).toEqual(['breathing', 'face']);
  });

  it('times under another field: the report names stampOf', () => {
    const r = smoke('stamp-field', { stampFieldMissing: true });
    expect(r.verdict).toBe('SMOKE FAIL: no trace samples (reduce.cjs stampOf returned nothing)');
    const layout = r.report['questions']['q2_data']['layout'] as Json[];
    expect(layout.find((f) => f['accessor'] === 'stampOf')).toMatchObject({ status: 'empty', reads: 's.timestamp' });
    expect(layout.find((f) => f['accessor'] === 'chestSamples')).toMatchObject({ status: 'ok' });
    expect(r.lines).toContain('   Layout: stampOf (reads s.timestamp) returned nothing: the probe of packet 1 sees samples whose timestamp is undefined.');
  });

  it('mesh points as [x, y] arrays: the report names pointXY and cannot judge the lips', () => {
    const r = smoke('point-arrays', { pointsAsArrays: true });
    expect(r.verdict).toBe('SMOKE OK');
    const q2 = r.report['questions']['q2_data'] as Json;
    expect((q2['layout'] as Json[]).find((f) => f['accessor'] === 'pointXY')).toMatchObject({ status: 'empty', reads: 'p.x, p.y' });
    expect(q2['first_frame']).toMatchObject({ mesh_points: 478, y13_below_y14: null, units: 'unknown' });
    expect(r.lines.some((l) => l.includes('Layout: pointXY (reads p.x, p.y) returned nothing'))).toBe(true);
  });

  it('an inverted trace and a slower trace under the screen recording', () => {
    const r = smoke('inverted', { polarity: -1, screenRecordingRateHz: 20 });
    const q = r.report['questions'] as Json;
    expect(q['q3_trace_sign']).toMatchObject({ sign: -1, agree: true });
    expect(q['q6_screen_recording']['with_recording']['median_per_s']).toBe(20);
    expect(q['q6_screen_recording']['without_recording']['median_per_s']).toBe(30);
    expect(q['q6_screen_recording']['median_change_per_s']).toBe(-10);
    // The quiet minute is most of the run, so the median falls with it.
    expect(r.verdict).toBe('SMOKE FAIL: median trace rate 20 per s is below 25');
  });

  it('lens cover: the status change, kOk back, and a packet gap the watchdog would catch', () => {
    const r = smoke('lens-gap', { lensGapMs: 4500 });
    const q = r.report['questions'] as Json;
    expect(q['q7_lens_cover']).toMatchObject({ covered: true, cover_s: 2, status_before: { code: 0, name: 'kOk' } });
    expect(q['q7_lens_cover']['validation_changes'].map((c: Json) => c['code'])).toEqual([1, 0]);
    expect(q['q7_lens_cover']['ok_back_ms_after_uncover']).toBeCloseTo(800, -1);
    expect(q['q8_watchdog']).toMatchObject({ watchdog_would_fire: true, host_silence_method: 'pulses', host_silence_from: 'pulse' });
    expect(q['q8_watchdog']['host_silence_ms']).toBe(4000);
    expect(q['q8_watchdog']['longest_packet_gap_ms']).toBeGreaterThan(4500);
    expect(q['q8_watchdog']['longest_gap_step']).toBe('lens_uncover');
    expect(r.lines.some((l) => l.includes('host WOULD fire tap_lost on this run'))).toBe(true);
    // The watchdog answer is evidence, not a hard condition.
    expect(r.verdict).toBe('SMOKE OK');
  });

  it('an Insights line in the SDK log is found and quoted', () => {
    const r = smoke('insights', { sdkLogLines: ['I1112 10:00:02.000 Insights: sending session summary'] });
    const q10 = r.report['questions']['q10_insights'] as Json;
    expect(q10['answered']).toBe(true);
    expect(q10['match_count']).toBe(1);
    // tap.log: camera list (3 lines), enum checks (3), readiness, then the SDK line.
    expect(q10['matches'][0]).toMatchObject({ where: 'tap.log:8' });
    expect(q10['matches'][0]['labels']).toEqual(['insight', 'send']);
  });

  it('keeps face point coordinates out of smoke_report.json (spec 12.5)', () => {
    const { report } = smoke('no-points');
    const text = JSON.stringify(report);
    expect(text).not.toMatch(/xRange|yRange/);
    const pointLists: string[] = [];
    const walk = (v: unknown, path: string) => {
      if (Array.isArray(v)) {
        if (v.some((x) => Array.isArray(x) && x.length === 2 && x.every((y) => typeof y === 'number'))) pointLists.push(path);
        v.forEach((x, i) => walk(x, `${path}[${i}]`));
      } else if (v && typeof v === 'object') {
        for (const [k, x] of Object.entries(v)) walk(x, `${path}.${k}`);
      }
    };
    walk(report, '');
    expect(pointLists).toEqual([]);
  });

  it('throws for a folder that does not exist', () => {
    expect(() => runSmoke(join(root, 'no-such-session'), { print: false })).toThrow(/No session folder/);
  });
});

describe('smoke report: session object and command line', () => {
  it('runSmoke takes the session of analysis/lib/session.ts and shows its schema problems', () => {
    const dir = join(root, 'loaded');
    writeSmokeSession(dir, { id: 'loaded' });
    appendFileSync(join(dir, 'samples.jsonl'), '{"k":"m","seq":"x"}\n');
    const session = loadSession(dir, { detectorIn: false });
    expect(session.problems.length).toBeGreaterThan(0);
    const r = runSmoke(session, { print: false });
    expect(r.ok).toBe(true);
    expect(r.code).toBe(0);
    expect(r.report['schema_problems']).toMatchObject({ count: session.problems.length });
    expect(r.text).toMatch(/Schema check: \d+ problems?, first: samples\.jsonl line \d+: seq/);
    expect(r.text.split('\n').at(-1)).toBe('SMOKE OK');
    expect(r.reportPath).toBe(join(dir, 'smoke_report.json'));
  });

  it('the command line: newest smoke session by default, exit codes, credit balances kept', () => {
    const sessions = join(root, 'cli');
    writeSmokeSession(join(sessions, 'smoke-1'), { id: 'smoke-1', cutRawBytes: 3000, audio: false });
    writeSmokeSession(join(sessions, 'smoke-2'), { id: 'smoke-2', traceRateHz: 15 });
    const env = { ...process.env, COPYHOLDER_SESSIONS_DIR: sessions };
    const out: string[] = [];
    const err: string[] = [];
    const cli = (...argv: string[]) => {
      out.length = 0;
      err.length = 0;
      return main(argv, env, (l) => out.push(l), (l) => err.push(l));
    };

    expect(cli()).toBe(SMOKE_EXIT.fail);
    expect(out[0]).toMatch(/^Smoke report for smoke-2 /);
    expect(out.at(-1)).toBe('SMOKE FAIL: median trace rate 15 per s is below 25');

    // More than two balances: the run has no balance pauses to price (spec 11.5 item 4).
    expect(cli('smoke-1', '--credits', '100,99.6,99.4,95.2')).toBe(SMOKE_EXIT.error);
    expect(err.join('\n')).toMatch(/give two balances, before and after the run/);

    expect(cli('smoke-1', '--credits', '100,95.2')).toBe(SMOKE_EXIT.ok);
    expect(out.at(-1)).toBe('SMOKE OK');
    // No audio.wav: the shared loader refuses the folder, the report still runs.
    expect(out.join('\n')).toMatch(/analysis\/lib\/session\.ts could not load the folder \(.*audio\.wav/);
    expect(out.join('\n')).toMatch(/sdk_raw\.jsonl\.gz \d+ lines, 1 unreadable \(gzip stream truncated/);
    const read = () => JSON.parse(readFileSync(join(sessions, 'smoke-1', 'smoke_report.json'), 'utf8')) as Json;
    expect(read()['questions']['q9_credits']['balance']).toEqual({ before: 100, after: 95.2 });
    expect(read()['questions']['q9_credits']['cost']).toEqual({ total: 4.8 });

    // A run without --credits keeps the typed balances; a blank keeps one, a value replaces it.
    expect(cli('smoke-1')).toBe(SMOKE_EXIT.ok);
    expect(read()['questions']['q9_credits']['balance']['before']).toBe(100);
    expect(cli('smoke-1', '--credits=,95')).toBe(SMOKE_EXIT.ok);
    expect(read()['questions']['q9_credits']['balance']).toEqual({ before: 100, after: 95 });

    expect(cli('smoke-1', '--credits', 'lots')).toBe(SMOKE_EXIT.error);
    expect(err.join('\n')).toMatch(/"lots" is not a credit balance/);
    expect(cli('missing-1')).toBe(SMOKE_EXIT.error);
    expect(err.join('\n')).toMatch(/No session folder/);
    expect(cli('--what')).toBe(SMOKE_EXIT.error);

    const empty = join(root, 'cli-empty');
    expect(main([], { ...process.env, COPYHOLDER_SESSIONS_DIR: empty }, () => {}, (l) => err.push(l))).toBe(SMOKE_EXIT.error);
    expect(err.at(-1)).toMatch(/No smoke session in/);
  });
});

describe("smoke report: tap.log against tap's IPC events (spec 7.12)", () => {
  const HEADER = 'tap: cameras (copy one name into settings.env as COPYHOLDER_CAMERA_NAME=...):';
  const LIST = [{ name: 'FaceTime HD Camera' }, { name: 'Desk View Camera' }];
  /** A smoke folder with this tap.log and these host events (tap_* lines, as host writes them in smoke). */
  const folderWith = (name: string, log: readonly string[], events: SynthOptions['events'] = []) => {
    const dir = join(root, name);
    writeSmokeSession(dir, { id: name, tapLog: false, events });
    writeFileSync(join(dir, 'tap.log'), `${log.join('\n')}\n`);
    return dir;
  };

  it('an enum line that tap.log redacted gives way to tap_enums; without the event it still says the enum differs', () => {
    const log = [
      'ProcessingStatus: matches reduce.cjs',
      'ValidationCode: differs from reduce.cjs: kOk=0, [redacted]',
      'SmartSpectraErrorCode: matches reduce.cjs',
      'checkDeviceReadiness(): ready (camera ok)',
    ];
    const checks = [
      { label: 'ProcessingStatus', differences: [] },
      { label: 'ValidationCode', differences: ['kOk=0', 'kFaceNotCentered2D=9'] },
      { label: 'SmartSpectraErrorCode', differences: [] },
    ];
    const dir = folderWith('enums-redacted', log, [{ atS: 1.2, e: 'tap_enums', fields: { checks } }]);
    const tap = tapSmokeOutput(readSessionFolder(dir));
    expect(tap.enums.map((e) => [e.value.label, e.value.matches, e.value.differences, e.source])).toEqual([
      ['ProcessingStatus', true, [], 'tap.log:1'],
      ['ValidationCode', false, ['kOk=0', 'kFaceNotCentered2D=9'], expect.stringMatching(/^events\.jsonl:\d+$/)],
      ['SmartSpectraErrorCode', true, [], 'tap.log:3'],
    ]);
    const lines: string[] = [];
    runSmoke(dir, { out: (l) => lines.push(l), write: false });
    expect(lines).toContain(
      '   Enums: ProcessingStatus matches reduce.cjs; ValidationCode DIFFERS from reduce.cjs: kOk=0, kFaceNotCentered2D=9; SmartSpectraErrorCode matches reduce.cjs.',
    );

    const alone = tapSmokeOutput(readSessionFolder(folderWith('enums-redacted-alone', log)));
    expect(alone.enums.map((e) => [e.value.label, e.value.matches, e.value.differences, e.source])).toEqual([
      ['ProcessingStatus', true, [], 'tap.log:1'],
      ['ValidationCode', false, ['kOk=0', '[redacted]'], 'tap.log:2'],
      ['SmartSpectraErrorCode', true, [], 'tap.log:3'],
    ]);
  });

  it('a camera header that tap.log holds after the names opens no block: tap_cameras gives the list', () => {
    // stderr (the header) and stdout (the names) reach tap.log in no fixed order.
    const late = ['FaceTime HD Camera', 'Desk View Camera', 'ProcessingStatus: matches reduce.cjs', HEADER, 'camera warm-up done', 'checkDeviceReadiness(): ready (camera ok)'];
    const tap = tapSmokeOutput(readSessionFolder(folderWith('cameras-late', late, [{ atS: 1.1, e: 'tap_cameras', fields: { list: LIST } }])));
    expect(tap.cameras).toEqual({ value: ['FaceTime HD Camera', 'Desk View Camera'], source: expect.stringMatching(/^events\.jsonl:\d+$/) });
    // The names before their header are no SDK log lines; the line after it is no camera name.
    expect(tap.logLines.map((l) => l.text)).toEqual(['camera warm-up done']);
    // Without the event the late header still takes no line after it for a camera.
    const bare = tapSmokeOutput(readSessionFolder(folderWith('cameras-late-bare', late)));
    expect(bare.cameras).toBeNull();
    expect(bare.logLines.map((l) => l.text)).toContain('camera warm-up done');
  });

  it("tap_cameras decides the names; a console list in order that says the same stays the source shown", () => {
    const inOrder = [HEADER, 'FaceTime HD Camera', 'Desk View Camera', 'ProcessingStatus: matches reduce.cjs'];
    const same = tapSmokeOutput(readSessionFolder(folderWith('cameras-same', inOrder, [{ atS: 1.1, e: 'tap_cameras', fields: { list: LIST } }])));
    expect(same.cameras).toEqual({ value: ['FaceTime HD Camera', 'Desk View Camera'], source: 'tap.log:1' });
    // The header came between the names: the console holds half the list, the event all of it.
    const split = ['FaceTime HD Camera', HEADER, 'Desk View Camera', 'ProcessingStatus: matches reduce.cjs'];
    const event = tapSmokeOutput(readSessionFolder(folderWith('cameras-split', split, [{ atS: 1.1, e: 'tap_cameras', fields: { list: LIST } }])));
    expect(event.cameras).toEqual({ value: ['FaceTime HD Camera', 'Desk View Camera'], source: expect.stringMatching(/^events\.jsonl:\d+$/) });
    // Without the event, the console's list in order is all there is.
    expect(tapSmokeOutput(readSessionFolder(folderWith('cameras-console', inOrder))).cameras).toEqual({ value: ['FaceTime HD Camera', 'Desk View Camera'], source: 'tap.log:1' });
  });
});

describe('smoke report: dry runs (spec 6.5)', () => {
  const DRY = "SMOKE FAIL: dry run (tap's stand-in SDK)";

  it("refuses a folder from tap's stand-in SDK with SMOKE FAIL and writes nothing into it", () => {
    const dir = join(root, 'dry-run');
    writeSmokeSession(dir, { id: 'dry-run', dry: true });
    const lines: string[] = [];
    const r = runSmoke(dir, { out: (l) => lines.push(l) });
    expect(r).toMatchObject({ ok: false, code: SMOKE_EXIT.fail, verdict: DRY, reasons: ["dry run (tap's stand-in SDK)"], reportPath: null });
    expect(lines).toEqual([DRY_RUN_NOTE, DRY]);
    expect(verdictLines(lines)).toEqual([DRY]);
    expect(existsSync(join(dir, 'smoke_report.json'))).toBe(false);

    // The command line loads the folder through the shared loader first: the same refusal.
    const out: string[] = [];
    expect(main(['dry-run'], { ...process.env, COPYHOLDER_SESSIONS_DIR: root }, (l) => out.push(l), () => {})).toBe(SMOKE_EXIT.fail);
    expect(out.at(-1)).toBe(DRY);
    expect(existsSync(join(dir, 'smoke_report.json'))).toBe(false);
  });

  it('reports on the same run as usual when manifest.json says dry: false', () => {
    const r = smoke('not-dry', { dry: false });
    expect(r.verdict).toBe('SMOKE OK');
    expect(r.lines.at(-1)).toBe('SMOKE OK');
  });
});

describe('smoke report: review findings', () => {
  it('a stray camera time (0 or -1) in each stream is reported and left out, without a window per second since 1970', () => {
    const r = smoke('stray', { strayTimestamps: { trace: 0, talk: -1, landmarks: 0, frames: 0, callback: -1 } });
    expect(r.verdict).toBe('SMOKE OK');
    expect(r.report['hard']['trace_rate']).toMatchObject({ ok: true, median_per_s: 30, stray_timestamps: 1 });
    const streams = r.report['questions']['q4_time']['streams'] as Json;
    for (const [k, v] of [['trace', 0], ['talk', -1], ['landmarks', 0], ['frames', 0], ['callback', -1]] as const) {
      expect(streams[k]).toMatchObject({ outside_run: 1, outside_examples: [v], run_method: 'arrival' });
      expect(streams[k]['clock_rate_us_per_us']).toBeCloseTo(1, 2);
    }
    expect(r.lines).toContain(
      "   Stray timestamps outside their stream's run on tap's clock (SURPRISE; left out of every rate and comparison): trace 1 (0), talking flag 1 (-1), landmark frames 1 (0), frameSentThrough 1 (0), metrics timestampUs 1 (-1).",
    );
    const q5 = r.report['questions']['q5_rates'] as Json;
    expect(q5['trace']['median_per_s']).toBe(30);
    expect(q5['frame_rate_from_interval']).toBeCloseTo(30, 0);
  });

  it("without tap's console the report names the candidate accessors, never one it cannot prove", () => {
    const stamp = smoke('stamp-no-log', { stampFieldMissing: true, tapLog: false });
    expect(stamp.verdict).toBe(
      "SMOKE FAIL: no trace samples (one of decodeMetrics(), chestSamples, talkSamples, landmarkFrames or stampOf returned nothing; save tap's console as tap.log to tell which)",
    );
    const stampLayout = stamp.report['questions']['q2_data']['layout'] as Json[];
    expect(stampLayout.filter((f) => f['status'] === 'suspect').map((f) => f['accessor'])).toEqual([
      'decodeMetrics',
      'chestSamples',
      'talkSamples',
      'landmarkFrames',
      'stampOf',
    ]);
    expect(stampLayout.some((f) => f['status'] === 'empty')).toBe(false);

    for (const [name, synth] of [
      ['trace-no-log', { traceFieldMissing: true }],
      ['value-no-log', { traceValueMissing: true }],
    ] as const) {
      const r = smoke(name, { ...synth, tapLog: false });
      expect(r.verdict).toBe("SMOKE FAIL: no trace samples (one of chestSamples or traceValue returned nothing; save tap's console as tap.log to tell which)");
      const layout = r.report['questions']['q2_data']['layout'] as Json[];
      expect(layout.filter((f) => f['status'] === 'suspect').map((f) => f['accessor'])).toEqual(['chestSamples', 'traceValue']);
      expect(layout.find((f) => f['accessor'] === 'stampOf')).toMatchObject({ status: 'ok' });
    }
  });

  it('with the probe, a trace value under another field is pinned on traceValue', () => {
    const r = smoke('value-log', { traceValueMissing: true });
    expect(r.verdict).toBe('SMOKE FAIL: no trace samples (reduce.cjs traceValue returned nothing)');
    const layout = r.report['questions']['q2_data']['layout'] as Json[];
    expect(layout.find((f) => f['accessor'] === 'traceValue')).toMatchObject({ status: 'empty', reads: 's.value' });
    expect(layout.find((f) => f['accessor'] === 'chestSamples')).toMatchObject({ status: 'ok' });
  });

  it("a first packet without samples: stampOf and the timestamp type come from tap's second probe", () => {
    const r = smoke('first-empty', { firstPacketEmpty: true });
    expect(r.verdict).toBe('SMOKE OK');
    const q = r.report['questions'] as Json;
    expect(q['q2_data']['probes'].map((p: Json) => p['packet'])).toEqual([1, 2]);
    expect((q['q2_data']['layout'] as Json[]).find((f) => f['accessor'] === 'stampOf')).toMatchObject({ status: 'ok' });
    expect(q['q4_time']['sample_ts_types']).toEqual(['number']);
    expect(q['q2_data']['first_frame']['source']).toMatch(/probe of packet 2/);
  });

  it("the watchdog is replayed as host runs it: from Running, on tap's 1 s pulses", () => {
    const late = smoke('late-first-packet', { firstPacketDelayS: 3.5 });
    const q8 = late.report['questions']['q8_watchdog'] as Json;
    expect(q8).toMatchObject({ watchdog_would_fire: true, host_silence_from: 'running', host_silence_method: 'pulses' });
    expect(q8['host_silence_ms']).toBeGreaterThan(3500);
    expect(q8['first_packet_after_running_ms']).toBeGreaterThan(3400);
    // A packet gap of 3.5 s shows up as 3 s or 4 s of pulses, depending on their phase.
    const edge = smoke('lens-gap-edge', { lensGapMs: 3500 });
    expect(edge.report['questions']['q8_watchdog']).toMatchObject({ host_silence_ms: 3000, watchdog_would_fire: null });
    expect(edge.lines.some((l) => l.includes('it MAY fire: within host'))).toBe(true);
  });

  it("tap's own failure (code null) is named with its message in the verdict and in question 1", () => {
    const r = smoke('tap-exception', {
      running: false,
      events: [{ atS: 3, e: 'sdk_error', fields: { code: null, name: 'tap', message: 'start() failed: camera access was denied' } }],
    });
    expect(r.verdict).toBe(
      'SMOKE FAIL: the SDK never reached Running (processingStatus: kStarting); no trace samples (no metrics packet arrived); 1 SDK error event: tap: start() failed: camera access was denied',
    );
    expect(r.report['hard']['sdk_errors']).toMatchObject({ count: 1, core_count: 1 });
    expect(r.lines).toContain(
      '   Camera opened: no (in plain Node): no frame arrived; error: tap: start() failed: camera access was denied. If the camera does not open in plain Node, run it again with: npm run live:electron -- smoke (spec 6.7).',
    );
    expect(r.report['hard']['sdk_errors']['errors'][0]).toMatchObject({ code: null, name: 'tap', message: 'start() failed: camera access was denied' });
  });

  it('a missing samples.jsonl is named as the reason, not an accessor the probe saw working', () => {
    const dir = join(root, 'no-samples');
    writeSmokeSession(dir, { id: 'no-samples' });
    rmSync(join(dir, 'samples.jsonl'));
    const r = runSmoke(dir, { print: false });
    expect(r.verdict).toBe('SMOKE FAIL: no trace samples (samples.jsonl is missing)');
    const layout = (r.report as Json)['questions']['q2_data']['layout'] as Json[];
    expect(layout.filter((f) => f['status'] === 'empty' || f['status'] === 'suspect')).toEqual([]);
    // sdk_raw.jsonl.gz still shows that the camera opened.
    expect((r.report as Json)['questions']['q1_start']).toMatchObject({ camera_opened: true, counted_in: 'sdk_raw.jsonl.gz' });
  });

  it('checkDeviceReadiness() that fails or never settles is reported, not left unknown', () => {
    const failed = smoke('readiness-failed', { readiness: 'failed' });
    expect(failed.report['questions']['q1_start']['readiness']).toMatchObject({ verdict: null, failed: true, reason: 'checkDeviceReadiness() failed: the camera is busy' });
    expect(failed.lines).toContain('   checkDeviceReadiness(): NO VERDICT: checkDeviceReadiness() failed: the camera is busy (tap.log:7).');
    const timeout = smoke('readiness-timeout', { readiness: 'timeout' });
    expect(timeout.lines).toContain('   checkDeviceReadiness(): NO VERDICT: checkDeviceReadiness() did not settle in 30 s (tap.log:7).');
    // tap keeps waiting after its 30 s note: a verdict that follows replaces it.
    const late = smoke('readiness-late', { readiness: 'timeout', sdkLogLines: ['checkDeviceReadiness(): ready (camera ok)'] });
    expect(late.report['questions']['q1_start']['readiness']).toMatchObject({ verdict: 'ready', reason: 'camera ok', failed: false });
    expect(late.lines).toContain('   checkDeviceReadiness(): ready (camera ok) (tap.log:8).');
  });


  it("a saved console with an earlier report and another run: only this run's lines are read", () => {
    const dir = join(root, 'echo');
    writeSmokeSession(dir, { id: 'echo', tapLog: false });
    const header = 'tap: cameras (copy one name into settings.env as COPYHOLDER_CAMERA_NAME=...):';
    writeFileSync(
      join(dir, 'smoke.log'),
      [
        '> copyholder@0.1.0 smoke',
        '',
        'Recording folder: sessions/smoke-old',
        header,
        'Old Camera',
        'I1111 09:00:00.000 Insights: uploading the old session',
        'I1111 09:00:00.100 camera opened at 640x480, 30 fps',
        'Running the quick check...',
        'Smoke report for smoke-old (sessions/smoke-old)',
        '   Lines about sending data (1): tap.log:3 [insight, upload] "Insights: uploading".',
        'SMOKE OK',
        'Recording folder: sessions/echo',
        header,
        'FaceTime HD Camera',
        'Desk View Camera',
        'checkDeviceReadiness(): ready (camera ok)',
        'I1112 10:00:00.100 camera opened at 1280x720, 30 fps',
        'I1112 10:00:00.200 requested 1920x1080 at 30 fps',
        'Camera running.',
        'Running the quick check...',
        'Smoke report for echo (sessions/echo)',
        '   Frame size in the logged SDK lines: 1920x1080; Insights: upload of 3 snapshots',
        'SMOKE OK',
        '',
      ].join('\n'),
    );
    const lines: string[] = [];
    const r = runSmoke(dir, { out: (l) => lines.push(l) });
    const q = r.report['questions'] as Json;
    expect(q['q1_start']['cameras']).toEqual(['FaceTime HD Camera', 'Desk View Camera']);
    expect(q['q1_start']['readiness']).toMatchObject({ verdict: 'ready', reason: 'camera ok' });
    expect(q['q5_rates']['logged_frame_sizes']).toEqual([{ size: '1280x720', where: 'smoke.log:17' }]);
    expect(q['q10_insights']).toMatchObject({ answered: true, match_count: 0 });
    expect(q['q10_insights']['left_out']).toMatchObject({ other_runs: ['sessions/smoke-old'] });
    expect(q['q10_insights']['left_out']['report_lines']).toBe(6);
    expect(r.report['tap_console']).toMatchObject({ found: true, foreign_runs: [] });
    expect(lines.join('\n')).toMatch(/Left out: .*the runs of sessions\/smoke-old/);
  });

  it('keeps the reduce.cjs of the first report and says when it changed since', () => {
    const r1 = smoke('reduce-edit');
    expect(r1.report['reduce_cjs']['first']['sha256']).toMatch(/^[0-9a-f]{64}$/);
    const file = join(r1.dir, 'smoke_report.json');
    const earlier = JSON.parse(readFileSync(file, 'utf8')) as Json;
    earlier['reduce_cjs']['first']['sha256'] = '0'.repeat(64);
    earlier['reduce_cjs']['first']['paths']['chestSamples'] = 'msg.breathing.oldTrace';
    writeFileSync(file, JSON.stringify(earlier));
    const lines: string[] = [];
    const r2 = runSmoke(r1.dir, { out: (l) => lines.push(l) });
    expect(r2.report['reduce_cjs']).toMatchObject({ changed: true, first: { sha256: '0'.repeat(64) } });
    expect(lines.some((l) => l.includes('Note: live/reduce.cjs changed since this session was first reported'))).toBe(true);
    const layout = (r2.report as Json)['questions']['q2_data']['layout'] as Json[];
    expect(layout.find((f) => f['accessor'] === 'chestSamples')).toMatchObject({ reads: 'msg.breathing.oldTrace' });
  });
});

describe('smoke report: parts', () => {
  it('looks for step names that web/scenarios/smoke.ts has', () => {
    const names = smokeStepNames();
    const wanted = [
      ...Object.values(SMOKE_STEPS).flatMap((v): string[] => (typeof v === 'string' ? [v] : [])),
      ...Array.from({ length: DEEP_BREATHS }, (_, i) => [SMOKE_STEPS.deepIn(i + 1), SMOKE_STEPS.deepOut(i + 1)]).flat(),
    ];
    for (const name of wanted) expect(names).toContain(name);
  });

  it('parses typed credit balances', () => {
    expect(parseCreditBalances('100,94')).toEqual({ before: 100, after: 94 });
    expect(parseCreditBalances(' 12.5 ')).toEqual({ before: 12.5, after: null });
    expect(parseCreditBalances(',94')).toEqual({ before: null, after: 94 });
    expect(parseCreditBalances('100,99,94')).toMatch(/give two balances/);
    expect(parseCreditBalances('1,-2')).toMatch(/not a credit balance/);
  });

  it('counts trace samples per second sparsely, as core/clock traceRateMedian does densely (property)', () => {
    expect(medianWithEmptyWindows([], 3)).toBe(0);
    expect(medianWithEmptyWindows([5, 7], 3)).toBe(5);
    expect(medianWithEmptyWindows([5, 7], 4)).toBe(2.5);
    expect(medianWithEmptyWindows([1, 2, 3], 2)).toBeNull();
    // Two timestamps 50 years apart: one window each, no array of 1.6e9 seconds.
    expect(medianCountPerSecond([0, 1.6e15])).toBe(0);
    fc.assert(
      fc.property(fc.array(fc.integer({ min: 0, max: 20_000_000 }), { minLength: 2, maxLength: 300 }), (ts) => {
        const lines = [{ k: 'm', tr: ts.map((t) => [t, 0]) }] as unknown as SampleLine[];
        return medianCountPerSecond(ts) === traceRateMedian(lines);
      }),
      { numRuns: 200 },
    );
  });

  it("finds a stream's run on tap's clock, or by quartiles without arrivals", () => {
    const items = Array.from({ length: 300 }, (_, i) => ({ tsUs: 5e12 + i * 33_333, relNs: 1e9 + i * 33_333_000 }));
    const span = streamSpan([...items, { tsUs: 0, relNs: 2e9 }, { tsUs: -1, relNs: null }]);
    expect(span).toMatchObject({ method: 'arrival', outside: 2, examples: [-1, 0] });
    expect(span.kept).toHaveLength(300);
    expect(span.clockRate).toBeCloseTo(1, 6);
    // A camera clock in ms: not µs, so the run falls back to the quartile fence.
    const ms = streamSpan(items.map((p) => ({ tsUs: p.tsUs / 1000, relNs: p.relNs })));
    expect(ms.method).toBe('quartiles');
    expect(ms.clockRate).toBeCloseTo(0.001, 6);
    expect(streamSpan([]).method).toBe('empty');
  });

  it("judges host's watchdog with its 200 ms check period", () => {
    expect(watchdogWouldFire({ method: 'pulses', ms: 3201 })).toBe(true);
    expect(watchdogWouldFire({ method: 'pulses', ms: 3000 })).toBeNull();
    expect(watchdogWouldFire({ method: 'pulses', ms: 2799 })).toBe(false);
    expect(watchdogWouldFire({ method: 'packets', ms: 3500 })).toBeNull();
    expect(watchdogWouldFire({ method: 'packets', ms: 4300 })).toBe(true);
    expect(watchdogWouldFire({ method: 'packets', ms: 1700 })).toBe(false);
  });

  it("splits a saved console into runs and leaves out report blocks and the quick check's output", () => {
    const text = [
      'a line before any run',
      'Recording folder: sessions/other',
      'other run',
      'Recording folder: /home/me/sessions/mine/',
      'my line',
      'Smoke report for mine (sessions/mine)',
      'quoted line',
      'SMOKE FAIL: something',
      'my second line',
      'Running the quick check...',
      'quick check output',
    ];
    const r = runLines('smoke.log', text, ['mine']);
    expect(r.lines.map((l) => [l.text, l.lineNo])).toEqual([
      ['my line', 5],
      ['my second line', 9],
    ]);
    expect(r).toMatchObject({ reportLines: 3, quickcheckLines: 1, otherRuns: ['sessions/other'], foreignRuns: [] });
    // No run names this session: every segment is read, and the report says whose runs they were.
    const foreign = runLines('smoke.log', text, ['someone-else']);
    expect(foreign.lines.map((l) => l.text)).toContain('other run');
    expect(foreign.foreignRuns).toEqual(['sessions/other', '/home/me/sessions/mine/']);
  });

  it('writes the verdict line', () => {
    expect(verdictLine([])).toBe('SMOKE OK');
    expect(verdictLine(['a', 'b'])).toBe('SMOKE FAIL: a; b');
  });

  it('reads the field paths of the accessors from reduce.cjs', () => {
    const paths = accessorPaths();
    expect(paths.chestSamples).toBe('msg.breathing.upperTrace');
    expect(paths.landmarkFrames).toBe('msg.face.landmarks');
    expect(paths.pointXY).toBe('p.x, p.y');
    const edited = accessorPaths('const chestSamples = (msg) => list(msg?.breathing?.upper_trace);\n');
    expect(edited.chestSamples).toBe('msg.breathing.upper_trace');
    expect(edited.talkSamples).toBe('msg.face.talking');
  });

  it('a Long logged as JSON gives back its number (property)', () => {
    const R = createRequire(import.meta.url)(REDUCE_PATH) as { longLike(n: number): object };
    fc.assert(
      fc.property(fc.integer({ min: 0, max: Number.MAX_SAFE_INTEGER }), (n) => {
        const logged: unknown = JSON.parse(JSON.stringify(R.longLike(n)));
        return longJsonToNumber(logged as { low: number; high: number }) === n && timestampToUs(logged) === n;
      }),
      { numRuns: 200 },
    );
    expect(timestampToUs('1794935111123456')).toBe(1794935111123456);
    expect(timestampToUs({ low: 1, high: 0, unsigned: true })).toBe(1);
    expect(timestampToUs('soon')).toBeNull();
  });
});
