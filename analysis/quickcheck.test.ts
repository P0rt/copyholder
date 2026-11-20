// quickcheck on synthetic sessions written in the real file formats (spec 7.12, 9.4, 13.4):
// a clean recording passes, each injected fault gives RE-RECORD NOW with its reason.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { SessionData, Stamp } from '../core/clock/index.ts';
import { appendLedger, parseJson, validateQuickcheck, verifyLedger, type GatePack, type LedgerStep, type RecordKind } from '../core/schemas/index.ts';
import { DEFAULT_VAD_PARAMS, vadFrozenBlock } from '../core/vad/index.ts';
import { makeSyntheticSession, type SyntheticOptions } from '../tests/synthetic/session.ts';
import { addNoise, addVoiceReply, mulberry32 } from '../tests/synthetic/signals.ts';
import { chooseVadParams, frozenDetectorVariant } from './lib/calib-io.ts';
import { isMainModule } from './lib/cli.ts';
import { DRY_RUN_NOTE } from './lib/dry-run.ts';
import { confirmingDetector } from './lib/conditions.ts';
import { classifyMicrophone } from './lib/devices.ts';
import { inMemorySession, sessionManifest, writeSessionFolder } from './lib/fixtures.ts';
import { appendLedgerStep, sha256Hex } from './lib/ledger.ts';
import { measureLoops, packetEnvelope, sampleToCameraUs, type LoopPair } from './lib/measure.ts';
import { SessionLoadError, loadSession, stepSpan, type LoadedSession } from './lib/session.ts';
import { gateSteps } from './lib/steps.ts';
import { encodeStereoFloatWav, readStereoFloatWav } from './lib/wav.ts';
import { nextRecordingAdvice } from './gate/inputs.ts';
import {
  EXIT_GOOD,
  EXIT_RERECORD,
  detectorComputed,
  dryRunLine,
  evaluateQuickcheck,
  ledgerLinesOf,
  main,
  planFor,
  runQuickcheck,
  technicalWords,
  writeQuickcheckFile,
  type QuickcheckDeps,
  type QuickcheckRun,
} from './quickcheck.ts';

let root = '';

beforeAll(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'copyholder-quickcheck-'));
});

afterAll(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

const env = (): NodeJS.ProcessEnv => ({ COPYHOLDER_SESSIONS_DIR: root, COPYHOLDER_PARAMS_FILE: path.join(root, 'no-params.json') });

/** Pack 0 needs 2 cues, 2 'pa' and 2 sniffs; the synthetic gate has 5 of each, so its first ones serve. */
const PACK0: SyntheticOptions = { scenario: 'gate', replies: 2, narrationS: 12, seed: 3 };
/** Pack A: 14 cues, 2.6 s apart in the synthetic objection block. */
const PACKA: SyntheticOptions = { scenario: 'gate', replies: 14, narrationS: 74, seed: 3 };

/** Pack-0 probe wording (spec 9.4): the probe spends no pack, whatever failed. */
const PROBE_TECHNICAL = '[technical failure; fix it and repeat the short probe until it gives GOOD RECORDING (spec 9.4)]';
const PROBE_NOT_TECHNICAL = '[not technical; the probe spends no pack: repeat the short probe until it gives GOOD RECORDING (spec 9.4)]';

/** The stdout line before the verdict of a gate run with the mock tap (PREREG.md section 11), up to what comes next. */
const MOCK_REHEARSAL =
  'This run is a rehearsal, not data: manifest.json says tap: "mock" (the mock tap made up the chest trace), so no SDK measured the chest, and clocks, label and analyze:gate refuse it (PREREG.md section 11).';

/** What comes next for a mock run of pack A, B or C that played the planted errors (PREREG.md section 7.1). */
const keepFolder = (pack: string): string =>
  `It played the planted errors of pack ${pack} (its objection block, from 4:15, began), and the participant does not hear a pack before it is recorded (PREREG.md section 7.1): keep this folder as the record of that, and do not record pack ${pack} with a participant who heard this run.`;

/** An SDK error line as host writes it into events.jsonl (live/host.cjs onSdkError). */
const sdkErrorEvent = (code: number, name: string) => ({ n: null, e: 'sdk_error', by: 'host', code, name, message: 'The SDK stopped.' });

interface Recorded {
  run: QuickcheckRun;
  /** stdout: exactly the verdict line. */
  out: string[];
  /** stderr: the report. */
  log: string[];
  session: LoadedSession;
  dir: string;
}

async function record(
  id: string,
  synth: SyntheticOptions,
  folder: { kind?: RecordKind; pack?: GatePack | null; headerDataBytes?: number; tap?: 'real' | 'mock' } = {},
  mutate?: (s: ReturnType<typeof makeSyntheticSession>) => void,
  over: Partial<QuickcheckDeps> = {},
): Promise<Recorded> {
  const made = makeSyntheticSession(synth);
  mutate?.(made);
  const kind = folder.kind ?? 'gate';
  const dir = writeSessionFolder(root, made.session, {
    id,
    kind,
    pack: kind === 'gate' ? (folder.pack ?? '0') : null,
    ...(folder.headerDataBytes === undefined ? {} : { headerDataBytes: folder.headerDataBytes }),
    ...(folder.tap === undefined ? {} : { tap: folder.tap }),
  });
  const session = loadSession(dir, { env: env() });
  const out: string[] = [];
  const log: string[] = [];
  const run = await runQuickcheck(session, {
    out: (l) => out.push(l),
    log: (l) => log.push(l),
    env: env(),
    vad: null,
    now: () => new Date('2026-11-13T18:20:00Z'),
    commit: () => 'abc1234',
    ...over,
  });
  return { run, out, log, session, dir };
}

const last = (out: readonly string[]): string => out[out.length - 1] ?? '';

function quickcheckJson(dir: string) {
  const parsed = parseJson(fs.readFileSync(path.join(dir, 'quickcheck.json'), 'utf8'), validateQuickcheck);
  expect(parsed.errors).toEqual([]);
  return parsed.value!;
}

/** Copy of ch0 with each [a, b) replaced by the synthetic noise floor (the sound there removed). */
function quieted(ch0: Float32Array, spans: ReadonlyArray<readonly [number, number]>): Float32Array {
  const out = ch0.slice();
  spans.forEach(([a, b], i) => {
    out.fill(0, a, b);
    addNoise(out, 0.0005, mulberry32(100 + i), a, b);
  });
  return out;
}

/** A few seconds of silent audio in 4 blocks: enough for a manifest and calib.json. */
function tinyData(): SessionData {
  const n = 4 * 9600;
  return {
    sampleRateHz: 48_000,
    ch0: new Float32Array(n),
    ch1: new Float32Array(n),
    stamps: [0, 1, 2, 3].map((i) => ({ n: i * 9600, k: 'chunk', frames: 9600 })),
    samples: [],
    events: [],
    micSettings: null,
  };
}

describe('quickcheck on a gate recording', () => {
  it('a clean pack-A recording gives GOOD RECORDING, quickcheck.json and the ledger step', async () => {
    const r = await record('gate-a', PACKA, { pack: 'A' });
    expect(r.run.code).toBe(EXIT_GOOD);
    expect(r.out).toEqual(['GOOD RECORDING']);
    expect(r.log[0]).toBe('Quickcheck gate-a (gate, pack A)');
    expect(r.log).toContain('Ledger: step quickcheck appended.');
    const q = quickcheckJson(r.dir);
    expect(q.result).toBe('GOOD RECORDING');
    expect(q.technical).toBeNull();
    expect(q.checks.filter((c) => c.hard).map((c) => c.name)).toEqual([
      'audio_continuous', 'loop_checks', 'cues_marked', 'trace_rate', 'no_sdk_error', 'voice_after_cues',
      'pa_bursts', 'sniffs', 'polarity', 'mic_flags_off', 'sample_rate', 'no_hard_window_events',
    ]);
    expect(q.checks.find((c) => c.name === 'cues_marked')?.value).toBe(14);
    expect(q.checks.find((c) => c.name === 'voice_after_cues')?.value).toBe(14);

    const lines = ledgerLinesOf(r.dir);
    expect(lines).toHaveLength(2);
    const v = verifyLedger(lines, (t) => sha256Hex(t), { kind: 'gate' });
    expect(v.errors).toEqual([]);
    const step = JSON.parse(lines[1]!) as { step: string; commit: string; utc: string; out_sha256: Record<string, string> };
    expect(step.step).toBe('quickcheck');
    expect(step.commit).toBe('abc1234');
    expect(step.utc).toBe('2026-11-13T18:20:00Z');
    expect(step.out_sha256['quickcheck.json']).toBe(sha256Hex(fs.readFileSync(path.join(r.dir, 'quickcheck.json'))));
    fs.rmSync(r.dir, { recursive: true, force: true });
  });

  // PREREG.md section 11: no SDK measured the chest of a mock-tap run, so it is a rehearsal. host
  // and the page read the last stdout line as the verdict, which stays as it is; the line before it
  // says what to do with the folder (section 7.1 for a run that played the planted errors).
  it('a gate run with the mock tap keeps its verdict, and one stdout line before it says it is a rehearsal and what comes next', async () => {
    const r = await record('gate-a-mock', PACKA, { pack: 'A', tap: 'mock' });
    expect(r.run.code).toBe(EXIT_GOOD);
    expect(r.out).toEqual([`${MOCK_REHEARSAL} ${keepFolder('A')}`, 'GOOD RECORDING']);
    expect(r.run.lines).toEqual(r.out);
    expect(r.log.some((l) => l.startsWith(MOCK_REHEARSAL))).toBe(false);
    expect(quickcheckJson(r.dir).result).toBe('GOOD RECORDING');
    expect(ledgerLinesOf(r.dir).map((l) => (JSON.parse(l) as { step: string }).step)).toEqual(['record', 'quickcheck']);
    fs.rmSync(r.dir, { recursive: true, force: true });

    // The probe, failed: still one verdict line, the last, with the probe's own words (spec 9.4).
    const probe = await record('gate-0-mock', { ...PACK0, faults: { sdkError: true } }, { tap: 'mock' });
    expect(probe.run.code).toBe(EXIT_RERECORD);
    expect(probe.out).toHaveLength(2);
    expect(probe.out[0]).toBe(
      `${MOCK_REHEARSAL} Delete it with npm run purge -- gate-0-mock --yes, and record the probe with the real tap (npm run gate -- --pack 0, without --tap mock).`,
    );
    expect(probe.out.filter((l) => /^(GOOD RECORDING|RE-RECORD NOW: .*)$/.test(l))).toEqual([last(probe.out)]);
    expect(last(probe.out).startsWith('RE-RECORD NOW: the SDK reported 1 error(s) (code 5 kNetworkError)')).toBe(true);
    expect(last(probe.out).endsWith(` ${PROBE_TECHNICAL}`)).toBe(true);
    fs.rmSync(probe.dir, { recursive: true, force: true });

    // The real tap gets no such line.
    const real = await record('gate-a-real', PACKA, { pack: 'A', tap: 'real' });
    expect(real.out).toEqual(['GOOD RECORDING']);
    fs.rmSync(real.dir, { recursive: true, force: true });
  });

  // A failed run of pack A, B or C that no SDK measured is no recording of the pack: none of what
  // spec 9.4 and PREREG.md section 11 say about a failed recording (recorded again, lost, kept in the
  // pooled numbers, the next unused pack) applies, and analyze:gate refuses it in the same words.
  describe('a failed rehearsal of pack A, B or C (PREREG.md sections 7.1 and 11)', () => {
    /** Three replies quieted, so condition 6 alone fails: voice after 11 of 14 cues. */
    const elevenReplies = (s: ReturnType<typeof makeSyntheticSession>): void => {
      const ch0 = s.session.ch0;
      s.truth.voiceOnsets.slice(0, 3).forEach((n, i) => {
        ch0.fill(0, n - 2400, n + Math.round(1.2 * 48_000));
        addNoise(ch0, 0.0005, mulberry32(100 + i), n - 2400, n + Math.round(1.2 * 48_000));
      });
    };
    /** The objection block never began: its step mark is gone from stamps.jsonl. */
    const brokeOff = (s: ReturnType<typeof makeSyntheticSession>): void => {
      const objections = gateSteps('A').objections;
      s.session.stamps = s.session.stamps.filter((st) => !(st.k === 'mark' && st.what === 'step' && st.name === objections));
    };
    const expectNoFailedRecordingWords = (r: Recorded): void => {
      for (const l of [...r.out, ...r.log]) expect(l).not.toMatch(/lost|not recorded again|cannot be recorded again|next unused pack|pooled numbers|re-record is free|confirm/);
    };
    const words = (pack: string): string =>
      `[rehearsal, not a recording of pack ${pack}: it does not count, and the rules for a failed recording of pack ${pack} do not apply (PREREG.md section 11)]`;
    const advice = (pack: string): string =>
      `This run is a rehearsal, not a recording of pack ${pack}, so what PREREG.md sections 7.4 and 11 say about a failed recording of pack ${pack} does not apply to it.`;

    it('pack B with fewer than 12 replies: not kept in the pooled numbers, and the folder is kept as the record of what was played', async () => {
      const r = await record('mock-few-b', PACKA, { pack: 'B', tap: 'mock' }, elevenReplies);
      expect(r.run.code).toBe(EXIT_RERECORD);
      expect(quickcheckJson(r.dir).technical).toBe(false);
      expect(r.out).toEqual([
        `${MOCK_REHEARSAL} ${keepFolder('B')}`,
        `RE-RECORD NOW: a voice was found within 10 s after only 11 of 14 cues (needs 12) ${words('B')}`,
      ]);
      expect(r.log).toContain(`${advice('B')} ${keepFolder('B')}`);
      expectNoFailedRecordingWords(r);
      fs.rmSync(r.dir, { recursive: true, force: true });
    });

    it('pack C, a technical failure after 4:15: not lost, and the numbers do not fall back to pack B alone', async () => {
      const r = await record('mock-fail-c', { ...PACKA, faults: { sdkError: true } }, { pack: 'C', tap: 'mock' });
      expect(r.run.code).toBe(EXIT_RERECORD);
      expect(quickcheckJson(r.dir).technical).toBe(true);
      expect(r.out).toEqual([`${MOCK_REHEARSAL} ${keepFolder('C')}`, `RE-RECORD NOW: the SDK reported 1 error(s) (code 5 kNetworkError) ${words('C')}`]);
      expect(r.log).toContain(`${advice('C')} ${keepFolder('C')}`);
      expect([...r.out, ...r.log].join('\n')).not.toMatch(/pack B alone/);
      expectNoFailedRecordingWords(r);
      fs.rmSync(r.dir, { recursive: true, force: true });
    });

    it('pack A, a technical failure after 4:15 and one before it: the same pack stays to be recorded, with the real tap', async () => {
      const after = await record('mock-fail-a', { ...PACKA, faults: { sdkError: true } }, { pack: 'A', tap: 'mock' });
      expect(last(after.out)).toBe(`RE-RECORD NOW: the SDK reported 1 error(s) (code 5 kNetworkError) ${words('A')}`);
      expect(after.log).toContain(`${advice('A')} ${keepFolder('A')}`);
      expectNoFailedRecordingWords(after);
      fs.rmSync(after.dir, { recursive: true, force: true });

      // Before 4:15 no planted error was played: the folder is deleted and pack A recorded with the real tap.
      const before = await record('mock-early-a', { ...PACKA, faults: { sdkError: true } }, { pack: 'A', tap: 'mock' }, brokeOff);
      const next =
        'It stopped before the objection block (4:15), so it played no planted error of pack A: delete it with npm run purge -- mock-early-a --yes, and record pack A with the real tap (npm run gate -- --pack A, without --tap mock).';
      expect(before.out[0]).toBe(`${MOCK_REHEARSAL} ${next}`);
      expect(last(before.out)).toMatch(new RegExp(` ${words('A').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`));
      expect(before.log).toContain(`${advice('A')} ${next}`);
      expect(before.out.filter((l) => /^(GOOD RECORDING|RE-RECORD NOW: .*)$/.test(l))).toEqual([last(before.out)]);
      expectNoFailedRecordingWords(before);
      fs.rmSync(before.dir, { recursive: true, force: true });
    });

    it('a mock kCreditExhausted spends no SDK credit: the run is a rehearsal, not a lost pack', async () => {
      const credit = (s: ReturnType<typeof makeSyntheticSession>): void => {
        (s.session.events as object[]).push(sdkErrorEvent(4, 'kCreditExhausted'));
      };
      const r = await record('mock-credit-b', PACKA, { pack: 'B', tap: 'mock' }, credit);
      expect(last(r.out)).toBe(`RE-RECORD NOW: the SDK reported 1 error(s) (code 4 kCreditExhausted) ${words('B')}`);
      expect([...r.out, ...r.log].join('\n')).not.toMatch(/credits are used up/);
      expectNoFailedRecordingWords(r);
      fs.rmSync(r.dir, { recursive: true, force: true });
    });
  });

  it('a clean pack-0 recording passes; a re-run appends again, but not after clocks, and then keeps quickcheck.json', async () => {
    const r = await record('gate-0', PACK0);
    expect(last(r.out)).toBe('GOOD RECORDING');
    const q = quickcheckJson(r.dir);
    expect(q.checks.find((c) => c.name === 'cues_marked')?.limit).toBe(2);
    expect(q.checks.find((c) => c.name === 'sniffs')?.limit).toBe(2);
    const again = await runQuickcheck(r.session, { out: () => {}, log: () => {}, env: env(), vad: null, commit: () => null });
    expect(again.code).toBe(EXIT_GOOD);
    expect(ledgerLinesOf(r.dir).map((l) => (JSON.parse(l) as { step: string }).step)).toEqual(['record', 'quickcheck', 'quickcheck']);

    // After clocks the ledger refuses quickcheck (spec 8.5): the file the ledger hashed stays.
    const clocks = appendLedgerStep(r.dir, 'gate', 'clocks', { utc: '2026-11-13T18:40:00Z', commit: null, outSha256: { 'calib.json': sha256Hex('{}') } });
    expect(clocks.appended).toBe(true);
    const before = fs.readFileSync(path.join(r.dir, 'quickcheck.json'));
    const out: string[] = [];
    const log: string[] = [];
    const refused = await runQuickcheck(r.session, {
      out: (l) => out.push(l),
      log: (l) => log.push(l),
      env: env(),
      vad: { params: { floorDb: -60 }, source: 'a floor that changes the report' },
      commit: () => null,
    });
    expect(out).toHaveLength(1);
    expect(refused.evaluation?.quickcheck.checks.find((c) => c.name === 'voice_after_cues')?.detail).toContain('a floor that changes the report');
    expect(last(log)).toMatch(/^Ledger: not appended \(step "quickcheck" out of order: .*\); quickcheck\.json left as it was, so it still matches the ledger\.$/);
    const after = fs.readFileSync(path.join(r.dir, 'quickcheck.json'));
    expect(after.equals(before)).toBe(true);
    const lines = ledgerLinesOf(r.dir);
    expect(lines.map((l) => (JSON.parse(l) as { step: string }).step)).toEqual(['record', 'quickcheck', 'quickcheck', 'clocks']);
    expect(verifyLedger(lines, (t) => sha256Hex(t), { kind: 'gate' }).errors).toEqual([]);
    const lastQc = JSON.parse(lines[2]!) as { out_sha256: Record<string, string> };
    expect(lastQc.out_sha256['quickcheck.json']).toBe(sha256Hex(after));
    fs.rmSync(r.dir, { recursive: true, force: true });
  });

  const faults: Array<{
    name: string;
    synth?: SyntheticOptions['faults'];
    mutate?: (s: ReturnType<typeof makeSyntheticSession>) => void;
    check: string;
    reason: RegExp;
    technical: boolean;
  }> = [
    { name: 'a dropped audio block', synth: { dropChunk: true }, check: 'audio_continuous', reason: /the audio has a gap: 200(\.0)? ms lost/, technical: true },
    { name: 'L_rt of loop check B shifted 20 ms', synth: { lrtShiftMs: 20 }, check: 'loop_checks', reason: /loop checks A and B differ by 20\.0 ms, more than 15 ms/, technical: true },
    { name: 'a breathing trace at 15 samples per second', synth: { traceRateHz: 15 }, check: 'trace_rate', reason: /15\.0 samples per second, below 25/, technical: true },
    { name: 'an SDK error', synth: { sdkError: true }, check: 'no_sdk_error', reason: /the SDK reported 1 error\(s\) \(code 5 kNetworkError\)/, technical: true },
    { name: 'a lost tap connection', synth: { tapLost: true }, check: 'no_sdk_error', reason: /the connection to tap was lost 1 time\(s\): the SDK stopped sending/, technical: true },
    { name: 'a hard device event', synth: { hardEvent: 'devicechange' }, check: 'no_hard_window_events', reason: /the audio devices changed at \d+:\d+\.\d during the recording/, technical: true },
    { name: 'a hidden page', synth: { hardEvent: 'hidden' }, check: 'no_hard_window_events', reason: /the page was hidden at \d+:\d+\.\d during the recording(?! \()/, technical: true },
    { name: 'microphone processing on', synth: { micProcessing: true }, check: 'mic_flags_off', reason: /microphone processing is on: echo cancellation, auto gain control/, technical: true },
    {
      name: 'a microphone track at 44.1 kHz',
      synth: { micSampleRateHz: 44_100 },
      check: 'sample_rate',
      reason: /the microphone track runs at 44100 Hz, not 48000 Hz: set 48 000 Hz in Audio MIDI Setup \(spec 5\.2\)/,
      technical: true,
    },
    {
      name: 'a missing cue mark',
      mutate: ({ session }) => {
        const i = session.stamps.findIndex((s) => s.k === 'mark' && s.what === 'cue' && s.on === true);
        (session.stamps as unknown[]).splice(i, 1);
      },
      check: 'cues_marked',
      reason: /only 1 of 2 cue marks are in stamps\.jsonl/,
      technical: true,
    },
    {
      name: 'too few voices after the cues',
      mutate: ({ session, truth }) => {
        const n = truth.voiceOnsets[0]!;
        session.ch0.fill(0, n - 2400, n + 48_000);
      },
      check: 'voice_after_cues',
      reason: /a voice was found within 10 s after only 1 of 2 cues \(needs 2\)/,
      technical: false,
    },
  ];

  it.each(faults)('$name gives RE-RECORD NOW with its reason', async (f) => {
    const id = `gate-fault-${faults.indexOf(f)}`;
    const r = await record(id, { ...PACK0, faults: f.synth ?? {} }, { pack: '0' }, f.mutate);
    expect(r.run.code).toBe(EXIT_RERECORD);
    expect(r.out).toHaveLength(1);
    const line = last(r.out);
    expect(line.startsWith('RE-RECORD NOW: ')).toBe(true);
    expect(line).toMatch(f.reason);
    // The pack-0 probe spends no pack: whatever failed, the probe is repeated (spec 9.4).
    expect(line.endsWith(` ${f.technical ? PROBE_TECHNICAL : PROBE_NOT_TECHNICAL}`)).toBe(true);
    expect(line).not.toContain('content re-record');
    expect(r.log).toContain('Fix the cause and repeat the probe (npm run gate -- --pack 0) until it gives GOOD RECORDING (spec 9.4).');
    const q = quickcheckJson(r.dir);
    expect(q.result).toBe('RE-RECORD NOW');
    expect(q.technical).toBe(f.technical);
    const failed = q.checks.filter((c) => c.hard && !c.ok).map((c) => c.name);
    expect(failed).toEqual([f.check]);
    expect(q.reasons[0]).toMatch(f.reason);
    fs.rmSync(r.dir, { recursive: true, force: true });
  });

  it('flags a recording whose loop checks differ by 3-15 ms but keeps it', async () => {
    const r = await record('gate-flag', { ...PACK0, faults: { lrtShiftMs: 7 } });
    expect(r.run.code).toBe(EXIT_GOOD);
    expect(last(r.out)).toBe('GOOD RECORDING (flagged: loop checks A and B differ by 7.0 ms)');
    expect(quickcheckJson(r.dir).checks.find((c) => c.name === 'L_rt_diff')?.ok).toBe(false);
    fs.rmSync(r.dir, { recursive: true, force: true });
  });

  it('a crashed audio.wav with a zero data length still loads and passes', async () => {
    const r = await record('gate-crash', PACK0, { headerDataBytes: 0 });
    const raw = readStereoFloatWav(path.join(r.dir, 'audio.wav'));
    expect(raw.info.dataBytes).toBe(0);
    expect(raw.info.lengthFrom).toBe('file size');
    expect(r.session.ch0.length).toBe(r.session.layout.frames);
    expect(r.session.ch0.length).toBeGreaterThan(48_000 * 60);
    expect(r.session.problems.some((p) => p.includes('header says 0 bytes'))).toBe(true);
    expect(last(r.out)).toBe('GOOD RECORDING');
    fs.rmSync(r.dir, { recursive: true, force: true });
  });
});

describe('pack A counts and failure order, in memory (spec 9.4)', () => {
  let made: ReturnType<typeof makeSyntheticSession>;
  let base: LoadedSession;
  let loops: LoopPair;

  beforeAll(() => {
    made = makeSyntheticSession(PACKA);
    base = inMemorySession(made.session, sessionManifest(made.session, { id: 'gate-a-mem', kind: 'gate', pack: 'A' }));
    loops = measureLoops(base);
  });

  const evalA = (change: Partial<LoadedSession>, opts: { detectorComputed?: boolean } = {}) =>
    evaluateQuickcheck({ ...base, ...change }, { set: 'gate', pack: 'A' }, { loops }, opts);
  const around = (n: number, afterS: number): readonly [number, number] => [n - 2400, n + Math.round(afterS * 48_000)];
  const condition = (e: ReturnType<typeof evalA>, name: string) => e.conditions.find((c) => c.name === name);

  it('condition 6 passes with 12 of 14 answered cues and fails with 11, and that failure is not technical', () => {
    const reply = (i: number) => around(made.truth.voiceOnsets[i]!, 1.2);
    const twelve = evalA({ ch0: quieted(base.ch0, [reply(0), reply(1)]) });
    expect(twelve.line).toBe('GOOD RECORDING');
    expect(condition(twelve, 'voice_after_cues')).toMatchObject({ ok: true, value: 12, limit: 12 });

    const eleven = evalA({ ch0: quieted(base.ch0, [reply(0), reply(1), reply(2)]) });
    expect(eleven.line).toBe(
      'RE-RECORD NOW: a voice was found within 10 s after only 11 of 14 cues (needs 12) [not technical: the next recording is the one content re-record (spec 9.6)]',
    );
    expect(eleven.quickcheck.technical).toBe(false);
    expect(eleven.report).toContain(
      'quickcheck marks the failure as not technical (fewer than 12 replies, spec 9.4): record the next unused pack (B, then C), which is the one re-record for content (spec 9.6).',
    );
  });

  it("'pa' bursts: 4 of 5 in a block pass, 3 of 5 fail", () => {
    const pa = (i: number) => around(made.truth.paBursts.start[i]!, 0.4);
    const four = evalA({ ch0: quieted(base.ch0, [pa(0)]) });
    expect(four.line).toBe('GOOD RECORDING');
    expect(condition(four, 'pa_bursts')?.value).toBe('4/5, 5/5');
    const three = evalA({ ch0: quieted(base.ch0, [pa(0), pa(1)]) });
    expect(three.line).toBe(
      "RE-RECORD NOW: only 3 of 5 'pa' bursts were found in the start block (needs 4): say 'pa' clearly from closed lips [technical failure; this re-record is free (spec 9.4)]",
    );
    expect(three.quickcheck.technical).toBe(true);
  });

  it('sniffs: 4 of 5 pass, 3 of 5 fail', () => {
    const sniff = (i: number) => around(made.truth.sniffOnsets[i]!, 0.6);
    const four = evalA({ ch0: quieted(base.ch0, [sniff(0)]) });
    expect(four.line).toBe('GOOD RECORDING');
    expect(condition(four, 'sniffs')?.value).toBe(4);
    const three = evalA({ ch0: quieted(base.ch0, [sniff(0), sniff(1)]) });
    expect(three.line).toBe(
      "RE-RECORD NOW: only 3 of 5 sniffs were heard (needs 4): sniff sharply through the nose on 'Sniff' [technical failure; this re-record is free (spec 9.4)]",
    );
  });

  it('a deep breath that moves the trace the other way fails the trace sign', () => {
    const env = packetEnvelope(base)!;
    const span = stepSpan(base, 'deep_2_in')!;
    const from = sampleToCameraUs(env, span.n0, 48_000) - 1e6;
    const to = sampleToCameraUs(env, span.n1, 48_000) + 1e6;
    const samples = base.samples.map((l) =>
      l.k === 'm' && l.tr ? { ...l, tr: l.tr.map(([t, v]): [number, number] => [t, t >= from && t <= to ? -v : v]) } : l,
    );
    const r = evalA({ samples });
    expect(r.line).toBe(
      'RE-RECORD NOW: the three cued deep breaths do not move the breathing trace the same way: breathe in fully on each cue and sit still [technical failure; this re-record is free (spec 9.4)]',
    );
    expect(condition(r, 'polarity')?.detail).toMatch(/^d = [\d.]+, -[\d.]+, [\d.]+$/);
  });

  it('a technical failure beside condition 6 makes the recording technical and is named first', () => {
    // The microphone track was muted during the objections: no answers were heard.
    const from = made.truth.steps['objections']!;
    const to = made.truth.steps['pa_end_1_closed']!;
    const ch0 = base.ch0.slice();
    ch0.fill(0, from, to);
    const events = [...base.events, { n: Math.round((from + to) / 2), e: 'track_mute', hard: true }].sort((p, q) => (p.n ?? 0) - (q.n ?? 0));
    const r = evalA({ ch0, events });
    expect(r.quickcheck.technical).toBe(true);
    expect(r.quickcheck.reasons).toHaveLength(2);
    expect(r.quickcheck.reasons[0]).toMatch(/^the microphone track was muted at \d+:\d+\.\d during the recording$/);
    expect(r.quickcheck.reasons[1]).toBe('a voice was found within 10 s after only 0 of 14 cues (needs 12)');
    expect(r.line).toMatch(/^RE-RECORD NOW: the microphone track was muted at \d+:\d+\.\d during the recording \(and 1 more\) \[technical failure; this re-record is free \(spec 9\.4\)\]$/);
    expect(r.report).toContain('Failed hard conditions, technical ones first: no_hard_window_events, voice_after_cues.');

    const computed = evalA({ ch0, events }, { detectorComputed: true });
    expect(computed.line.endsWith('[technical failure, but a detector was already computed, so it uses up the one re-record (spec 9.4)]')).toBe(true);
  });

  // PREREG.md §7.4 for pack A and section 11 for packs B and C: what comes after a technical
  // failure depends on the pack, on whether the objection block (4:15) began, and on whether the
  // SDK ended the recording with kCreditExhausted. The report line is analyze:gate's advice.
  describe('what comes next, by pack (PREREG.md section 11)', () => {
    const objections = gateSteps('A').objections;
    const brokeOff = (): LoadedSession['stamps'] => base.stamps.filter((st) => !(st.k === 'mark' && st.what === 'step' && st.name === objections));
    const failed = (pack: 'A' | 'B' | 'C', o: { reached: boolean; credits?: boolean }) => {
      const error = o.credits === true ? sdkErrorEvent(4, 'kCreditExhausted') : sdkErrorEvent(5, 'kError');
      const r = evaluateQuickcheck({ ...base, stamps: o.reached ? base.stamps : brokeOff(), events: [...base.events, error] }, { set: 'gate', pack }, { loops });
      expect(r.quickcheck.technical).toBe(true);
      expect(r.quickcheck.reasons[0]).toBe(o.credits === true ? 'the SDK reported 1 error(s) (code 4 kCreditExhausted)' : 'the SDK reported 1 error(s) (code 5 kError)');
      return { bracket: /\[([^\]]*)\]$/.exec(r.line)?.[1], advice: r.report[r.report.length - 1] };
    };
    const advice = (pack: 'A' | 'B' | 'C', reached: boolean, creditsUsedUp = false): string =>
      nextRecordingAdvice({ technical: true, pack, objectionsReached: reached, detectorComputed: false, creditsUsedUp });

    it('pack A: the same pack before 4:15, the next unused pack after it (spec 9.4)', () => {
      const before = failed('A', { reached: false });
      expect(before.bracket).toBe('technical failure; this re-record is free (spec 9.4)');
      expect(before.advice).toBe(
        'The failure is technical. Remove the cause, repeat pack 0 until it says GOOD RECORDING, then record pack A again: the recording broke off before the objection block (4:15), so its errors were not heard (spec 9.4). A technical failure with no detector computed does not spend the one re-record for content (spec 9.4).',
      );
      const after = failed('A', { reached: true });
      expect(after.bracket).toBe('technical failure; this re-record is free (spec 9.4)');
      expect(after.advice).toBe(advice('A', true));
      expect(after.advice).toMatch(/then record the next unused pack \(B, then C\): the objection block \(from 4:15\) was heard, so pack A cannot be recorded again \(spec 9\.4\)\./);
    });

    it('pack B: recorded again before 4:15; lost and not replaced after it, then one demo take and pack C', () => {
      const before = failed('B', { reached: false });
      expect(before.bracket).toBe('technical failure before 4:15: pack B is recorded again (PREREG.md section 11)');
      expect(before.advice).toBe(
        'The failure is technical. Remove the cause, repeat pack 0 until it says GOOD RECORDING, then record pack B again: the recording broke off before the objection block (4:15), so its errors were not heard (PREREG.md section 11).',
      );
      expect(before.advice).toBe(advice('B', false));
      const after = failed('B', { reached: true });
      expect(after.bracket).toBe('technical failure after 4:15: pack B is lost and not replaced; next come one demo take and pack C (PREREG.md section 11)');
      expect(after.advice).toBe(
        'The failure is technical, but the objection block (from 4:15) was heard, so pack B is lost, reported with its reason and not replaced (PREREG.md section 11). Go on in the order of section 11, with one demo take, then pack C; npm run confirm -- <idB> <idC> takes this recording as <idB> and reports it as lost.',
      );
      expect(after.advice).toBe(advice('B', true));
      expect(`${before.advice} ${after.advice}`).not.toMatch(/re-record|next unused pack/);
    });

    it('pack C: recorded again before 4:15; lost after it, and the numbers are those of pack B alone', () => {
      const before = failed('C', { reached: false });
      expect(before.bracket).toBe('technical failure before 4:15: pack C is recorded again (PREREG.md section 11)');
      expect(before.advice).toBe(advice('C', false));
      expect(before.advice).toMatch(/then record pack C again: the recording broke off before the objection block \(4:15\)/);
      const after = failed('C', { reached: true });
      expect(after.bracket).toBe('technical failure after 4:15: pack C is lost and not replaced; the confirmatory numbers are those of pack B alone, flagged (PREREG.md section 11)');
      expect(after.advice).toBe(
        'The failure is technical, but the objection block (from 4:15) was heard, so pack C is lost, reported with its reason and not replaced (PREREG.md section 11). The confirmatory numbers are those of pack B alone, flagged: npm run confirm -- <idB> <idC> takes this recording as <idC> and reports it as lost.',
      );
      expect(after.advice).toBe(advice('C', true));
    });

    it('kCreditExhausted loses the recording on every pack, before 4:15 too, and it is never a free re-record', () => {
      for (const pack of ['A', 'B', 'C'] as const) {
        for (const reached of [false, true]) {
          const r = failed(pack, { reached, credits: true });
          expect(r.bracket).toBe(
            `the SDK credits are used up (kCreditExhausted): pack ${pack} is lost and not replaced${pack === 'C' ? '; the confirmatory numbers are those of pack B alone, flagged' : ''} (PREREG.md section 11)`,
          );
          expect(r.advice).toBe(advice(pack, reached, true));
          expect(r.advice).toMatch(new RegExp(`^The SDK ended the recording with kCreditExhausted, so its credits are used up: pack ${pack} is lost, reported with its reason and not replaced \\(PREREG\\.md section 11\\)\\. `));
          expect(`${r.bracket} ${r.advice}`).not.toMatch(/free|record pack [ABC] again|next unused pack/);
        }
      }
      expect(failed('C', { reached: false, credits: true }).advice).toBe(
        'The SDK ended the recording with kCreditExhausted, so its credits are used up: pack C is lost, reported with its reason and not replaced (PREREG.md section 11). The confirmatory numbers are those of pack B alone, flagged: npm run confirm -- <idB> <idC> takes this recording as <idC> and reports it as lost.',
      );
      expect(failed('B', { reached: true, credits: true }).advice).toBe(
        'The SDK ended the recording with kCreditExhausted, so its credits are used up: pack B is lost, reported with its reason and not replaced (PREREG.md section 11). The demo take and pack C need credits too, so neither can start until the SDK has credits again; without pack C there are no confirmatory numbers, and npm run confirm -- <idB> reports this recording as lost.',
      );
      expect(failed('A', { reached: false, credits: true }).advice).toBe(
        'The SDK ended the recording with kCreditExhausted, so its credits are used up: pack A is lost, reported with its reason and not replaced (PREREG.md section 11). Packs B, then C need credits too, so none can be recorded until the SDK has credits again.',
      );
    });

    it('reads the credit loss by the code or by the name alone, as npm run confirm does', () => {
      const byName = { n: null, e: 'sdk_error', by: 'host', code: null, name: 'kCreditExhausted', message: '' };
      const r = evaluateQuickcheck({ ...base, events: [...base.events, byName] }, { set: 'gate', pack: 'B' }, { loops });
      expect(r.line).toMatch(/\[the SDK credits are used up \(kCreditExhausted\): pack B is lost and not replaced \(PREREG\.md section 11\)\]$/);
      // The probe: nothing can follow until the SDK has credits again.
      const probe = evaluateQuickcheck({ ...base, events: [...base.events, sdkErrorEvent(4, 'kCreditExhausted')] }, { set: 'gate', pack: '0' }, { loops });
      expect(probe.line.endsWith('[the SDK credits are used up (kCreditExhausted): nothing can be recorded until the SDK has credits again (PREREG.md section 11)]')).toBe(true);
      expect(probe.report).toContain(
        'The SDK ended the probe with kCreditExhausted, so its credits are used up: neither the probe nor a pack can be recorded until the SDK has credits again (PREREG.md section 11).',
      );
      expect(probe.report).not.toContain('Fix the cause and repeat the probe (npm run gate -- --pack 0) until it gives GOOD RECORDING (spec 9.4).');
    });
  });
});

describe('pack 0 voice and cue timing, in memory (spec 9.4, 9.6)', () => {
  let made: ReturnType<typeof makeSyntheticSession>;
  let base: LoadedSession;
  let loops: LoopPair;

  beforeAll(() => {
    made = makeSyntheticSession(PACK0);
    base = inMemorySession(made.session, sessionManifest(made.session, { id: 'gate-0-mem', kind: 'gate', pack: '0' }));
    loops = measureLoops(base);
  });

  const eval0 = (change: Partial<LoadedSession>, ctx: Parameters<typeof evaluateQuickcheck>[2] = {}) =>
    evaluateQuickcheck({ ...base, ...change }, { set: 'gate', pack: '0' }, { loops, ...ctx });
  const condition = (e: ReturnType<typeof eval0>, name: string) => e.conditions.find((c) => c.name === name);

  it('a voice already running at a cue does not answer it', () => {
    const [cue1] = made.truth.cues;
    const reply1 = made.truth.voiceOnsets[0]!;
    // The first answer is gone; a voice runs from 1 s before the first cue to 1 s after it.
    const ch0 = quieted(base.ch0, [[reply1 - 2400, reply1 + 57_600]]);
    addVoiceReply(ch0, cue1! - 48_000, 2, mulberry32(8), 48_000);
    const r = eval0({ ch0 });
    expect(condition(r, 'voice_after_cues')).toMatchObject({ ok: false, value: 1, limit: 2 });
    expect(r.line).toBe(`RE-RECORD NOW: a voice was found within 10 s after only 1 of 2 cues (needs 2) ${PROBE_NOT_TECHNICAL}`);
  });

  it("cue steps without Deck's cue marks fail condition 3; condition 6 still times the answers from the steps", () => {
    const cueOn = gateSteps('0').cueOn;
    const stamps: Stamp[] = base.stamps.filter((m) => !(m.k === 'mark' && m.what === 'cue'));
    made.truth.cues.forEach((n, i) => {
      const at = stamps.findIndex((m) => m.n > n);
      stamps.splice(at < 0 ? stamps.length : at, 0, { n, k: 'mark', what: 'step', name: cueOn[i]! });
    });
    const r = eval0({ stamps });
    expect(condition(r, 'cues_marked')).toMatchObject({
      ok: false,
      value: 0,
      technical: true,
      reason: "only 0 of 2 cue marks are in stamps.jsonl (the scenario entered 2 cue steps, but Deck's cue marks are missing)",
    });
    const voice = condition(r, 'voice_after_cues');
    expect(voice).toMatchObject({ ok: true, value: 2 });
    expect(voice?.detail).toMatch(/; cue times from the cue steps \(Deck cue marks missing\)$/);
    expect(r.quickcheck.technical).toBe(true);
    expect(r.line.endsWith(PROBE_TECHNICAL)).toBe(true);
  });

  it('frozen voice parameters without a floor get the floor measured on the recording', () => {
    const r = eval0({}, { vad: { periodicity: 0.5, overFloorDb: 15 }, vadSource: 'params/frozen.json (periodicity 0.5; it has no floor_db and no doctor floor exists)' });
    const voice = condition(r, 'voice_after_cues');
    expect(voice).toMatchObject({ ok: true, value: 2 });
    expect(voice?.detail).toMatch(
      /^voice detector: params\/frozen\.json \(periodicity 0\.5; it has no floor_db and no doctor floor exists\); floor -\d+\.\d dB measured on step rest_2$/,
    );
  });
});

describe('voice detector parameters (spec 7.3, 7.12, 8.4)', () => {
  let doctorRoot = '';
  let emptyRoot = '';
  const params = (name: string, body: unknown): string => {
    const file = path.join(root, name);
    fs.writeFileSync(file, JSON.stringify(body));
    return file;
  };
  /** The vad block of the spec 8.4 example: no floor_db. */
  const SPEC_VAD = { highpass_hz: 150, hop_ms: 5, over_floor_db: 15, periodicity: 0.5, on_ms: [30, 50], off_ms: 1200 };
  const calib = (floor: number) => ({ L_rt_ms: { A: 23.4, B: 23.5, rule: 'mean', used: 23.5 }, vad: { floor_db: floor, periodicity: 0.45 } });

  beforeAll(() => {
    doctorRoot = path.join(root, 'vad-sessions');
    emptyRoot = path.join(root, 'vad-empty');
    fs.mkdirSync(emptyRoot, { recursive: true });
    writeSessionFolder(doctorRoot, tinyData(), { id: 'doctor-2', kind: 'doctor', scenario: 'doctor', startedUtc: '2026-11-12T10:00:00Z', calib: calib(-65.5) });
    // A level run copies the vad block of its full run (analysis/doctor.ts); a failed run wrote no
    // calib.json; a later full run without the quiet step wrote no vad block. The page gets the
    // block of the highest doctor-<n> that has one (live/lib/calib.cjs), and so does analysis.
    writeSessionFolder(doctorRoot, tinyData(), { id: 'doctor-3', kind: 'doctor', scenario: 'doctor-level', startedUtc: '2026-11-13T09:00:00Z', calib: calib(-65.5) });
    writeSessionFolder(doctorRoot, tinyData(), { id: 'doctor-4', kind: 'doctor', scenario: 'doctor', startedUtc: '2026-11-13T10:00:00Z' });
    const { vad: _none, ...noVad } = calib(-50);
    writeSessionFolder(doctorRoot, tinyData(), { id: 'doctor-5', kind: 'doctor', scenario: 'doctor', startedUtc: '2026-11-13T11:00:00Z', calib: noVad });
  });

  const vadEnv = (sessions: string, paramsFile: string): NodeJS.ProcessEnv => ({ COPYHOLDER_SESSIONS_DIR: sessions, COPYHOLDER_PARAMS_FILE: paramsFile });

  it('takes a frozen floor, else the floor and the threshold of doctor, else leaves the floor to be measured', () => {
    const full = params('frozen-full.json', { vad: vadFrozenBlock({ floorDb: -61.5 }) });
    const spec = params('frozen-spec.json', { vad: SPEC_VAD });
    const none = path.join(root, 'frozen-missing.json');

    const frozen = chooseVadParams(vadEnv(doctorRoot, full));
    expect(frozen?.params.floorDb).toBe(-61.5);
    expect(frozen?.source).toMatch(/^params\/frozen\.json \(floor -61\.5 dB, periodicity [\d.]+\)$/);

    // A block without floor_db was frozen before doctor: doctor's threshold replaces its 0.5 too.
    const withDoctor = chooseVadParams(vadEnv(doctorRoot, spec));
    expect(withDoctor?.params).toMatchObject({ floorDb: -65.5, periodicity: 0.45, overFloorDb: 15, offMs: 1200 });
    expect(withDoctor?.source).toBe('params/frozen.json (it has no floor_db) with the floor -65.5 dB and the periodicity 0.45 of doctor doctor-3');

    const noFloor = chooseVadParams(vadEnv(emptyRoot, spec));
    expect(noFloor?.params.floorDb).toBeUndefined();
    expect(noFloor?.params.periodicity).toBe(0.5);
    expect(noFloor?.source).toBe('params/frozen.json (periodicity 0.5; it has no floor_db and no doctor floor exists)');

    expect(chooseVadParams(vadEnv(doctorRoot, none))).toEqual({
      params: { ...DEFAULT_VAD_PARAMS, floorDb: -65.5, periodicity: 0.45 },
      source: 'doctor doctor-3 (floor -65.5 dB, periodicity 0.45)',
    });
    expect(chooseVadParams(vadEnv(emptyRoot, none))).toBeNull();
  });

  it('quickcheck uses the doctor floor with a frozen block that has none', async () => {
    const spec = params('frozen-spec-2.json', { vad: SPEC_VAD });
    const r = await record('gate-vad', PACK0, {}, undefined, { vad: undefined, env: vadEnv(doctorRoot, spec) });
    expect(last(r.out)).toBe('GOOD RECORDING');
    const voice = quickcheckJson(r.dir).checks.find((c) => c.name === 'voice_after_cues');
    expect(voice?.value).toBe(2);
    expect(voice?.detail).toMatch(/; voice detector: params\/frozen\.json \(it has no floor_db\) with the floor -65\.5 dB and the periodicity 0\.45 of doctor doctor-3$/);
    fs.rmSync(r.dir, { recursive: true, force: true });
  });
});

describe('quickcheck on other record kinds', () => {
  it('a numbers session checks D1 activity and fails without armed events', async () => {
    const good = await record('s1', { scenario: 'session', seed: 4 }, { kind: 'numbers' });
    expect(last(good.out)).toBe('GOOD RECORDING');
    const names = quickcheckJson(good.dir).checks.filter((c) => c.hard).map((c) => c.name);
    expect(names).toEqual(['audio_continuous', 'loop_checks', 'trace_rate', 'no_sdk_error', 'polarity', 'mic_flags_off', 'sample_rate', 'no_hard_window_events', 'd1_active_share']);
    fs.rmSync(good.dir, { recursive: true, force: true });

    const bad = await record('s2', { scenario: 'session', seed: 4 }, { kind: 'numbers' }, ({ session }) => {
      (session.events as unknown[]).splice(0, session.events.length, ...session.events.filter((e) => e.e !== 'armed'));
    });
    expect(bad.run.code).toBe(EXIT_RERECORD);
    expect(last(bad.out)).toMatch(/^RE-RECORD NOW: D1 was active for only 0% of the reading time \(needs 50%\)/);
    expect(last(bad.out).endsWith('[technical failure; spec 10.6 decides on a replacement]')).toBe(true);
    fs.rmSync(bad.dir, { recursive: true, force: true });
  });

  it('a session confirmed by D3 after the retune counts D3 activity (spec 4, 9.8)', async () => {
    const d3 = await record('s3', { scenario: 'session', seed: 4 }, { kind: 'numbers' }, ({ session }) => {
      session.events.forEach((e, i) => {
        if (e.e === 'armed') (session.events as unknown[])[i] = { ...e, det: 'D3' };
      });
    });
    expect(last(d3.out)).toBe('GOOD RECORDING');
    const check = quickcheckJson(d3.dir).checks.find((c) => c.name === 'd1_active_share');
    expect(check?.ok).toBe(true);
    expect(check?.detail).toMatch(/^D3 active for \d+% of the reading time; detector D3$/);
    fs.rmSync(d3.dir, { recursive: true, force: true });
  });

  it('the confirming detector comes from the armed events, then from params/frozen.json', () => {
    const ev = (det: string) => ({ n: 0, e: 'armed', det, on: true });
    expect(confirmingDetector({ events: [ev('D3')] })).toBe('D3');
    expect(confirmingDetector({ events: [ev('D1'), ev('D3')] }, 'D3')).toBe('D3');
    expect(confirmingDetector({ events: [ev('D1'), ev('D3')] })).toBe('D1');
    expect(confirmingDetector({ events: [] }, 'D3')).toBe('D3');
    expect(confirmingDetector({ events: [] })).toBe('D1');

    const paramsEnv = (body: unknown | undefined): NodeJS.ProcessEnv => {
      const file = path.join(root, `frozen-variant-${Math.random().toString(36).slice(2)}.json`);
      if (body !== undefined) fs.writeFileSync(file, JSON.stringify(body));
      return { COPYHOLDER_PARAMS_FILE: file, COPYHOLDER_SESSIONS_DIR: root };
    };
    expect(frozenDetectorVariant(paramsEnv({ variant: 'D3' }))).toBe('D3');
    expect(frozenDetectorVariant(paramsEnv({ d1: { variant: 'D3' } }))).toBe('D3');
    expect(frozenDetectorVariant(paramsEnv({ d1: { variant: 'D1' } }))).toBe('D1');
    expect(frozenDetectorVariant(paramsEnv({}))).toBe('D1');
    expect(frozenDetectorVariant(paramsEnv(undefined))).toBe('D1');
  });

  it('a smoke recording goes to analysis/smoke.ts runSmoke, a headstart recording has no conditions', async () => {
    const made = makeSyntheticSession({ ...PACK0 });
    const dir = writeSessionFolder(root, made.session, { id: 'smoke-1', kind: 'smoke', scenario: 'smoke' });
    const session = loadSession(dir);
    const fakeRepo = path.join(root, 'fake-repo');
    const out: string[] = [];
    const missing = await runQuickcheck(session, { out: (l) => out.push(l), log: () => {}, env: env(), repoRoot: fakeRepo });
    expect(missing.code).toBe(EXIT_GOOD);
    expect(last(out)).toMatch(/^The smoke report is not built yet/);

    fs.mkdirSync(path.join(fakeRepo, 'analysis'), { recursive: true });
    fs.writeFileSync(
      path.join(fakeRepo, 'analysis', 'smoke.ts'),
      "export function runSmoke(session, o) { o.out('SMOKE FAIL: stub for ' + session.id); return { code: 2 }; }\n",
    );
    const stub = await runQuickcheck(session, { out: (l) => out.push(l), log: () => {}, env: env(), repoRoot: fakeRepo });
    expect(stub.code).toBe(EXIT_RERECORD);
    expect(last(out)).toBe('SMOKE FAIL: stub for smoke-1');

    const headstartDir = writeSessionFolder(root, made.session, { id: 'headstart-1', kind: 'headstart' });
    const skipped = await runQuickcheck(loadSession(headstartDir), { out: (l) => out.push(l), log: () => {}, env: env() });
    expect(skipped.code).toBe(EXIT_GOOD);
    expect(last(out)).toBe('No quickcheck for headstart-1: spec 7.12 sets no quickcheck conditions for a headstart recording.');
    for (const d of [dir, headstartDir, fakeRepo]) fs.rmSync(d, { recursive: true, force: true });
  });

  it('chooses the condition set from manifest kind', () => {
    const m = (kind: RecordKind, extra: Record<string, unknown> = {}) =>
      ({ kind, ...extra }) as unknown as Parameters<typeof planFor>[0];
    expect(planFor(m('gate', { pack: 'B' }))).toEqual({ set: 'gate', pack: 'B' });
    expect(planFor(m('gate', { pack: null, scenario: 'gate-0' }))).toEqual({ set: 'gate', pack: '0' });
    expect(planFor(m('numbers'))).toEqual({ set: 'session', d1: true });
    expect(planFor(m('rehearsal'))).toEqual({ set: 'session', d1: true });
    expect(planFor(m('demo'))).toEqual({ set: 'session', d1: false });
    expect(planFor(m('spacebar'))).toEqual({ set: 'listening' });
    expect(planFor(m('pilot'))).toEqual({ set: 'listening' });
    expect(planFor(m('doctor'))).toEqual({ set: 'doctor' });
    expect(planFor(m('smoke'))).toEqual({ set: 'smoke' });
    expect(planFor(m('headstart')).set).toBe('none');
  });

  it('the CLI reads COPYHOLDER_SESSIONS_DIR and returns the exit code', async () => {
    const made = makeSyntheticSession({ ...PACK0, faults: { sdkError: true } });
    writeSessionFolder(root, made.session, { id: 'gate-cli', kind: 'gate', pack: '0' });
    const saved = { dir: process.env['COPYHOLDER_SESSIONS_DIR'], params: process.env['COPYHOLDER_PARAMS_FILE'] };
    const logs: string[] = [];
    const { log, error } = console;
    process.env['COPYHOLDER_SESSIONS_DIR'] = root;
    process.env['COPYHOLDER_PARAMS_FILE'] = path.join(root, 'no-params.json');
    console.log = (...a: unknown[]) => void logs.push(a.join(' '));
    console.error = () => {};
    try {
      expect(await main(['gate-cli'])).toBe(EXIT_RERECORD);
      expect(logs).toHaveLength(1);
      expect(last(logs)).toMatch(/^RE-RECORD NOW: the SDK reported/);
      expect(await main(['no-such-session'])).toBe(1);
      expect(last(logs)).toMatch(/^QUICKCHECK DID NOT RUN: No session folder/);
    } finally {
      console.log = log;
      console.error = error;
      for (const [k, v] of [['COPYHOLDER_SESSIONS_DIR', saved.dir], ['COPYHOLDER_PARAMS_FILE', saved.params]] as const) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
      fs.rmSync(path.join(root, 'gate-cli'), { recursive: true, force: true });
    }
  });
});

describe("dry runs: tap's stand-in SDK (spec 6.5)", () => {
  const DRY = "RE-RECORD NOW: dry run (tap's stand-in SDK), this folder never counts";

  async function runOn(dir: string): Promise<{ run: QuickcheckRun; out: string[]; log: string[] }> {
    const out: string[] = [];
    const log: string[] = [];
    const run = await runQuickcheck(loadSession(dir, { env: env() }), {
      out: (l) => out.push(l),
      log: (l) => log.push(l),
      env: env(),
      vad: null,
      now: () => new Date('2026-11-13T18:20:00Z'),
      commit: () => null,
    });
    return { run, out, log };
  }

  it('refuses the folder before any check, with one verdict line, and writes nothing into it', async () => {
    const made = makeSyntheticSession({ ...PACK0 });
    const dir = writeSessionFolder(root, made.session, { id: 'gate-dry', kind: 'gate', pack: '0', dry: true });
    const files = fs.readdirSync(dir).sort();
    const ledger = ledgerLinesOf(dir);
    const r = await runOn(dir);
    expect(r.run.code).toBe(EXIT_RERECORD);
    expect(r.out).toEqual([DRY]);
    expect(r.log).toEqual([DRY_RUN_NOTE]);
    expect(r.run.evaluation).toBeUndefined();
    expect(fs.readdirSync(dir).sort()).toEqual(files);
    expect(ledgerLinesOf(dir)).toEqual(ledger);

    // The same recording with dry false, as host writes it for the real SDK, is checked as usual.
    const real = writeSessionFolder(root, made.session, { id: 'gate-not-dry', kind: 'gate', pack: '0', dry: false });
    expect((await runOn(real)).out).toEqual(['GOOD RECORDING']);
    for (const d of [dir, real]) fs.rmSync(d, { recursive: true, force: true });
  });

  it('answers in the format each kind gets: DOCTOR FAIL for doctor, SMOKE FAIL from the smoke report', async () => {
    const doctor = writeSessionFolder(root, tinyData(), { id: 'doctor-dry', kind: 'doctor', scenario: 'doctor', dry: true });
    const d = await runOn(doctor);
    expect(d.run.code).toBe(EXIT_RERECORD);
    expect(d.out).toEqual(["DOCTOR FAIL: dry run (tap's stand-in SDK), this folder never counts"]);
    expect(fs.existsSync(path.join(doctor, 'calib.json'))).toBe(false);

    const made = makeSyntheticSession({ ...PACK0 });
    const smoke = writeSessionFolder(root, made.session, { id: 'smoke-dry', kind: 'smoke', scenario: 'smoke', dry: true });
    const s = await runOn(smoke);
    expect(s.run.code).toBe(EXIT_RERECORD);
    expect(last(s.out)).toBe("SMOKE FAIL: dry run (tap's stand-in SDK)");
    expect(fs.existsSync(path.join(smoke, 'smoke_report.json'))).toBe(false);

    // A kind without conditions is refused too: a dry folder never counts, whatever it is.
    const headstart = writeSessionFolder(root, made.session, { id: 'headstart-dry', kind: 'headstart', dry: true });
    expect((await runOn(headstart)).out).toEqual([DRY]);

    expect(dryRunLine({ set: 'doctor' })).toBe("DOCTOR FAIL: dry run (tap's stand-in SDK), this folder never counts");
    expect(dryRunLine({ set: 'gate', pack: 'A' })).toBe(DRY);
    for (const dir of [doctor, smoke, headstart]) fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe('verdict words and the ledger (spec 8.5, 9.4, 9.6, 10.6)', () => {
  it('names what a failure costs, by pack (spec 9.4, PREREG.md section 11)', () => {
    const zero = { set: 'gate', pack: '0' } as const;
    const a = { set: 'gate', pack: 'A' } as const;
    const b = { set: 'gate', pack: 'B' } as const;
    const c = { set: 'gate', pack: 'C' } as const;
    const before = { objectionsReached: false, creditsUsedUp: false };
    const after = { objectionsReached: true, creditsUsedUp: false };
    const credits = { objectionsReached: false, creditsUsedUp: true };
    expect(technicalWords(zero, true, true, before)).toBe('technical failure; fix it and repeat the short probe until it gives GOOD RECORDING (spec 9.4)');
    expect(technicalWords(zero, false, false, before)).toBe('not technical; the probe spends no pack: repeat the short probe until it gives GOOD RECORDING (spec 9.4)');
    expect(technicalWords(zero, true, false, credits)).toBe('the SDK credits are used up (kCreditExhausted): nothing can be recorded until the SDK has credits again (PREREG.md section 11)');
    // Pack A: spec 9.4, as section 11 says.
    expect(technicalWords(a, false, false, after)).toBe('not technical: the next recording is the one content re-record (spec 9.6)');
    expect(technicalWords(a, true, false, after)).toBe('technical failure; this re-record is free (spec 9.4)');
    expect(technicalWords(a, true, true, before)).toBe('technical failure, but a detector was already computed, so it uses up the one re-record (spec 9.4)');
    expect(technicalWords(a, true, false, credits)).toBe('the SDK credits are used up (kCreditExhausted): pack A is lost and not replaced (PREREG.md section 11)');
    // Packs B and C: section 11.
    expect(technicalWords(b, false, false, after)).toBe('not technical: pack B is not recorded again and stays in the pooled numbers, flagged (PREREG.md section 11)');
    expect(technicalWords(c, false, false, before)).toBe('not technical: pack C is not recorded again and stays in the pooled numbers, flagged (PREREG.md section 11)');
    expect(technicalWords(b, true, false, before)).toBe('technical failure before 4:15: pack B is recorded again (PREREG.md section 11)');
    expect(technicalWords(b, true, true, after)).toBe('technical failure after 4:15: pack B is lost and not replaced; next come one demo take and pack C (PREREG.md section 11)');
    expect(technicalWords(c, true, false, after)).toBe(
      'technical failure after 4:15: pack C is lost and not replaced; the confirmatory numbers are those of pack B alone, flagged (PREREG.md section 11)',
    );
    expect(technicalWords(b, true, false, credits)).toBe('the SDK credits are used up (kCreditExhausted): pack B is lost and not replaced (PREREG.md section 11)');
    expect(technicalWords(c, true, false, { objectionsReached: true, creditsUsedUp: true })).toBe(
      'the SDK credits are used up (kCreditExhausted): pack C is lost and not replaced; the confirmatory numbers are those of pack B alone, flagged (PREREG.md section 11)',
    );
    expect(technicalWords({ set: 'session', d1: true }, true, false, before)).toBe('technical failure; spec 10.6 decides on a replacement');
  });

  it('knows when a detector was computed from the ledger', () => {
    const hash = (t: string) => sha256Hex(t);
    const lines: string[] = [];
    // Every step lists the SHA-256 of what it wrote (spec 7.10).
    const add = (step: LedgerStep, out: Record<string, string>) =>
      lines.push(appendLedger(lines, step, { utc: '2026-11-13T18:00:00Z', commit: null, out_sha256: out }, hash, { kind: 'gate' }));
    add('record', { 'audio.wav': hash('a') });
    add('quickcheck', { 'quickcheck.json': hash('q') });
    add('clocks', { 'calib.json': hash('c'), 'clock_report.json': hash('r') });
    add('onsets', { 'onsets.json': hash('o') });
    add('label', { 'clock_report.json': hash('r'), 'onsets.json': hash('o') });
    expect(detectorComputed(lines)).toBe(false);
    expect(detectorComputed(null)).toBe(false);
    add('stage_a', { 'params/frozen.json': hash('p') });
    expect(detectorComputed(lines)).toBe(true);
  });

  it('writes quickcheck.json only when the ledger takes the step or holds no quickcheck hash yet', () => {
    const dir = fs.mkdtempSync(path.join(root, 'qc-ledger-'));
    const file = path.join(dir, 'quickcheck.json');
    const deps = { now: () => new Date('2026-11-13T18:20:00.123Z'), commit: () => null };

    // No ledger at all (host wrote no record step): the report is still written.
    expect(writeQuickcheckFile({ dir, kind: 'gate' }, 'first\n', deps)).toMatch(/^Ledger: not appended \(step "quickcheck" out of order: a gate ledger starts with "record"\)\.$/);
    expect(fs.readFileSync(file, 'utf8')).toBe('first\n');

    fs.writeFileSync(path.join(dir, 'ledger.jsonl'), `${appendLedger([], 'record', { utc: '2026-11-13T18:12:00Z', commit: null, out_sha256: { 'audio.wav': sha256Hex('a') } }, (t) => sha256Hex(t))}\n`);
    expect(writeQuickcheckFile({ dir, kind: 'gate' }, 'second\n', deps)).toBe('Ledger: step quickcheck appended.');
    expect(fs.readFileSync(file, 'utf8')).toBe('second\n');
    const step = JSON.parse(ledgerLinesOf(dir)[1]!) as { utc: string; out_sha256: Record<string, string> };
    expect(step.utc).toBe('2026-11-13T18:20:00Z');
    expect(step.out_sha256['quickcheck.json']).toBe(sha256Hex('second\n'));

    expect(appendLedgerStep(dir, 'gate', 'clocks', { utc: '2026-11-13T18:30:00Z', commit: null, outSha256: { 'calib.json': sha256Hex('c') } }).appended).toBe(true);
    expect(writeQuickcheckFile({ dir, kind: 'gate' }, 'third\n', deps)).toMatch(/quickcheck\.json left as it was, so it still matches the ledger\.$/);
    expect(fs.readFileSync(file, 'utf8')).toBe('second\n');
    expect(fs.readdirSync(dir).sort()).toEqual(['ledger.jsonl', 'quickcheck.json']);

    expect(writeQuickcheckFile({ dir, kind: 'live_sim' }, 'fourth\n', deps)).toBe('quickcheck.json written (this record kind has no ledger).');
    expect(fs.readFileSync(file, 'utf8')).toBe('fourth\n');
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe('session folder helpers', () => {
  it('step spans run from a step mark to the next one', () => {
    const made = makeSyntheticSession({ ...PACK0 });
    const dir = writeSessionFolder(root, made.session, { id: 'gate-spans', kind: 'gate', pack: '0' });
    const s = loadSession(dir);
    const span = stepSpan(s, 'loop_a');
    expect(span?.n0).toBe(made.truth.steps['loop_a']);
    expect(span?.n1).toBe(made.truth.steps['headset']);
    expect(s.detectorIn.length).toBeGreaterThan(0);
    expect(s.problems).toEqual([]);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('reads crashed WAV headers from the file size and trims a partial frame', () => {
    const ch0 = Float32Array.from({ length: 1000 }, (_, i) => Math.sin(i / 10));
    const ch1 = Float32Array.from({ length: 1000 }, (_, i) => i / 1000);
    const file = path.join(root, 'crash.wav');
    for (const [headerDataBytes, headerRiffBytes, extra, lengthFrom] of [
      [0xffffffff, 0xffffffff, 0, 'file size'],
      [0, 36, 0, 'file size'],
      [80_000, undefined, 0, 'file size'],
      [8000, undefined, 0, 'header'],
      [0xffffffff, 0xffffffff, 5, 'file size'],
    ] as const) {
      const wav = encodeStereoFloatWav(ch0, ch1, { headerDataBytes, ...(headerRiffBytes === undefined ? {} : { headerRiffBytes }) });
      fs.writeFileSync(file, Buffer.concat([wav, Buffer.alloc(extra)]));
      const r = readStereoFloatWav(file);
      expect(r.info.lengthFrom).toBe(lengthFrom);
      expect(r.ch0.length).toBe(1000);
      expect(r.ch0[123]).toBeCloseTo(Math.sin(12.3), 6);
      expect(r.ch1[999]).toBeCloseTo(0.999, 6);
    }
    fs.rmSync(file);
  });

  it('skips bad lines with readable problems and refuses a folder without a valid manifest', () => {
    const dir = writeSessionFolder(root, tinyData(), { id: 'tiny', kind: 'spacebar' });
    fs.appendFileSync(path.join(dir, 'stamps.jsonl'), '{"n":5,"k":"hold","cause":"key","nSilent":6,"word":null}\n{"n":7,"k":"cli');
    fs.appendFileSync(path.join(dir, 'events.jsonl'), '{"n":1,"e":"armed","det":"D2","on":true}\n');
    const s = loadSession(dir);
    expect(s.stamps).toHaveLength(4);
    expect(s.problems).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/^stamps\.jsonl line 5: .*nSilent/),
        expect.stringMatching(/^stamps\.jsonl line 6: not valid JSON .*\(last line cut short\)$/),
        expect.stringMatching(/^events\.jsonl line 1: /),
      ]),
    );
    expect(s.micSettings).toBeNull();
    fs.writeFileSync(path.join(dir, 'manifest.json'), '{"schema":"session/1"}');
    expect(() => loadSession(dir)).toThrow(/manifest\.json of .* is not valid:\n  .*id/);
    fs.rmSync(path.join(dir, 'manifest.json'));
    expect(() => loadSession(dir)).toThrow(SessionLoadError);
    expect(() => loadSession(path.join(root, 'nothing-here'))).toThrow(/No session folder/);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('classifies microphone names by spec 5.1: the built-in microphone is the accepted last fallback', () => {
    expect(classifyMicrophone('External Microphone (Built-in)').verdict).toBe('headset');
    expect(classifyMicrophone('Default - Jabra EVOLVE 20 MS (0b0e:0300)').verdict).toBe('headset');
    expect(classifyMicrophone('MacBook Pro Microphone (Built-in)')).toMatchObject({ verdict: 'builtin', ok: true });
    expect(classifyMicrophone('AirPods Pro (Bluetooth)')).toMatchObject({ verdict: 'bluetooth', ok: false });
    expect(classifyMicrophone('C922 Pro Stream Webcam (046d:085c)')).toMatchObject({ verdict: 'webcam', ok: false });
    expect(classifyMicrophone(null).ok).toBe(false);
    expect(classifyMicrophone('Mystery Input').ok).toBe(true);
  });

  it('runs main() when started through a symlink (isMainModule)', () => {
    const dir = fs.mkdtempSync(path.join(root, 'cli-'));
    const real = path.join(dir, 'real.ts');
    const other = path.join(dir, 'other.ts');
    fs.writeFileSync(real, '');
    fs.writeFileSync(other, '');
    fs.symlinkSync(real, path.join(dir, 'link.ts'));
    fs.symlinkSync(dir, path.join(root, 'cli-linked-folder'));
    const url = pathToFileURL(real).href;
    expect(isMainModule(url, real)).toBe(true);
    expect(isMainModule(url, path.join(dir, 'link.ts'))).toBe(true);
    expect(isMainModule(url, path.join(root, 'cli-linked-folder', 'real.ts'))).toBe(true);
    expect(isMainModule(url, other)).toBe(false);
    expect(isMainModule(url, path.join(dir, 'missing.ts'))).toBe(false);
    fs.rmSync(path.join(root, 'cli-linked-folder'));
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
