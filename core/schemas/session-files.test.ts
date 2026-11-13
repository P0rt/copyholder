// Live-recording files of spec 8.1: what the real writers produce validates (Deck, worker, tap,
// host, core/clock), and corrupted lines fail with readable, line-numbered messages.
import { describe, expect, it } from 'vitest';
import {
  PLANLESS_KINDS,
  SEALED_PLAN_KINDS,
  countWindowEvents,
  isEvent,
  isHardWindowEvent,
  parseJson,
  parseJsonl,
  sampleToDetectorIn,
  toJsonlLine,
  validateCalib,
  validateClockReport,
  validateDetectorInLine,
  validateEventLine,
  validateManifest,
  validateOnsets,
  validateSampleLine,
  validateStampLine,
  type EventLine,
  type SampleLine,
} from './index.ts';

const HEX = (c: string): string => c.repeat(64);
const POINTS = Array.from({ length: 16 }, (_, i) => [640 + i, 400 + i]);

describe('stamps.jsonl', () => {
  it('accepts what Deck writes, including idle and a word of null (no word timings)', () => {
    const lines = [
      { n: 0, k: 'chunk', frames: 9600 },
      { n: 100, k: 'mark', what: 'step', name: 'opening' },
      { n: 110, k: 'mark', what: 'cue', on: true },
      { n: 120, k: 'mark', what: 'key' },
      { n: 130, k: 'state', s: 'idle' },
      { n: 140, k: 'ignored', what: 'key', s: 'narrating' },
      { n: 150, k: 'ignored', what: 'hold', seq: 9, s: 'idle' },
      { n: 42_000, k: 'hold', cause: 'voice', nSilent: 42_384, word: null },
      { n: 50_000, k: 'resume', word: null },
    ];
    for (const l of lines) expect(validateStampLine(l)).toEqual([]);
  });

  it('names the field and the rule that a corrupted line breaks', () => {
    expect(validateStampLine({ n: 8640000, k: 'hold', cause: 'chest', seq: 5417, nSilent: 8640000, word: 57 })).toEqual([
      'nSilent: must be n + 384 = 8640384, got 8640000 (spec 6.2, 13.4)',
    ]);
    expect(validateStampLine({ n: 8640000, k: 'hold', cause: 'chest', nSilent: 8640384, word: 57 })).toEqual([
      'seq: missing (a "chest" hold names its SDK packet)',
    ]);
    expect(validateStampLine({ n: 8640000, k: 'hold', cause: 'CHEST', seq: 1, nSilent: 8640384, word: 57 })).toEqual([
      'cause: expected one of "chest", "voice", "key", got "CHEST"',
    ]);
    expect(validateStampLine({ n: -1, k: 'arr', seq: 5 })).toEqual(['n: expected a sample number (non-negative integer) >= 0, got -1']);
    expect(validateStampLine({ n: 1.5, k: 'arr', seq: 5 })).toEqual(['n: expected a sample number (non-negative integer), got 1.5']);
    expect(validateStampLine({ n: 1, k: 'state', s: 'HOLD_WAIT' })).toEqual([
      's: expected one of "narrating", "hold_wait", "listening", "resume", "idle", got "HOLD_WAIT"',
    ]);
    expect(validateStampLine({ n: 1, k: 'beep' })).toEqual([
      'k: unknown stamp kind "beep" (expected one of chunk, click, mark, arr, hold, state, voice, resume, ignored)',
    ]);
    expect(validateStampLine({ n: 1 })).toEqual(['k: missing (expected one of chunk, click, mark, arr, hold, state, voice, resume, ignored)']);
    expect(validateStampLine({ n: 1, k: 'mark', what: 'step' })).toEqual(['name: missing (a "step" mark names its step)']);
    expect(validateStampLine({ n: 1, k: 'voice', on: true, extra: 1 })).toEqual(['extra: unexpected field']);
    expect(validateStampLine([1, 2])).toEqual(['expected an object, got a list of 2']);
  });

  it('parseJsonl puts the file name and line number in front of every problem', () => {
    const text = [
      '{"n":0,"k":"chunk","frames":9600}',
      '{"n":9600,"k":"chunk","frames":0}',
      '{"n":8640000,"k":"arr","seq":5417}',
      '{"n":8640000,"k":"hold","cause":"chest","seq":5417,"nSilent":8640385,"word":57}',
      'not json',
    ].join('\n');
    const parsed = parseJsonl(text, validateStampLine, { file: 'stamps.jsonl' });
    expect(parsed.lineNumbers).toEqual([1, 3]);
    expect(parsed.errors).toEqual([
      'stamps.jsonl line 2: frames: expected a frame count (positive integer) >= 1, got 0',
      'stamps.jsonl line 4: nSilent: must be n + 384 = 8640384, got 8640385 (spec 6.2, 13.4)',
      expect.stringMatching(/^stamps\.jsonl line 5: not valid JSON \(/),
    ]);
  });
});

describe('samples.jsonl', () => {
  const packet = {
    seq: 5417, k: 'm', tArrNs: '812345678901234', tsCbUs: 1794935111156789,
    tr: [[1794935111123456, -0.4000000059604645]], talk: [[1794935111123456, 0]],
    g: 0.031746031746031744, hm: 0.0021, lm: { ts: 1794935111123456, reset: 0, p: POINTS },
  };

  it('accepts the lines tap writes (field names beyond seq, k, tArrNs, tsCbUs are tap\'s choice)', () => {
    const lines = [
      packet,
      { ...packet, lm: null, g: null, hm: null },
      { ...packet, lm: { ts: 1, reset: 0, p: [null, ...POINTS.slice(1)] } },
      { seq: 1, k: 'v', tArrNs: '1', tsCbUs: 2, code: 0, name: 'kOk', hint: '' },
      { seq: 2, k: 's', tArrNs: '1', code: 3, name: 'kRunning' },
      { seq: 3, k: 'f', tArrNs: '1', tsCbUs: 2, sent: false },
      { seq: 4, k: 'e', tArrNs: '1', code: 8, name: 'kProcessingFailed', message: 'x', retryable: false },
      { k: 'l', tArrNs: '1', p50Ms: 0.4, p99Ms: 3.1, maxMs: 7.25, n: 98 },
    ];
    for (const l of lines) expect(validateSampleLine(l)).toEqual([]);
  });

  it('enforces the precision rules: tArrNs a string, SDK times integer µs', () => {
    expect(validateSampleLine({ ...packet, tArrNs: 812345678901234 })).toEqual([
      'tArrNs: expected nanoseconds as a decimal string (spec 8.1), got 812345678901234',
    ]);
    expect(validateSampleLine({ ...packet, tsCbUs: 1794935111156789.5 })).toEqual([
      'tsCbUs: expected an SDK timestamp in integer microseconds, got 1794935111156789.5',
    ]);
    expect(validateSampleLine({ ...packet, tr: [[1794935111.123456, 0.1]] })).toEqual([
      'tr[0][0]: expected an SDK timestamp in integer microseconds, got 1794935111.123456',
    ]);
    expect(validateSampleLine({ ...packet, talk: [[1, 2]] })).toEqual(['talk[0][1]: expected one of 0, 1, got 2']);
    expect(validateSampleLine({ ...packet, lm: { ts: 1, reset: 1, p: POINTS } })).toEqual([
      'g and hm must be null on a frame with reset 1 (spec 8.1)',
    ]);
    expect(validateSampleLine({ ...packet, lm: { ts: 1, reset: 0, p: POINTS.slice(0, 15) } })).toEqual(['lm.p: expected 16 items, got 15']);
    expect(validateSampleLine({ k: 'l', tArrNs: '1', p99Ms: 'slow' })).toEqual([
      'p99Ms: expected a delay statistic (number >= 0), got "slow"',
    ]);
  });

  it('sampleToDetectorIn keeps the detector values and drops landmarks and arrival times', () => {
    const det = sampleToDetectorIn(packet as SampleLine);
    expect(det).toEqual({ k: 'batch', seq: 5417, tr: packet.tr, talk: packet.talk, g: packet.g, hm: packet.hm });
    expect(validateDetectorInLine(det)).toEqual([]);
    expect(sampleToDetectorIn({ seq: 1, k: 'v', tArrNs: '1', tsCbUs: 2, code: 7 } as SampleLine)).toEqual({ k: 'val', seq: 1, code: 7 });
    expect(sampleToDetectorIn({ seq: 3, k: 'f', tArrNs: '1', tsCbUs: 2, sent: true } as SampleLine)).toBeNull();
  });
});

describe('detector_in.jsonl', () => {
  it('accepts the worker lines and refuses face landmarks with the reason', () => {
    expect(validateDetectorInLine({ k: 'state', n: 0, s: 'idle' })).toEqual([]);
    expect(validateDetectorInLine({ k: 'batch', seq: 1, tr: [], talk: [], g: null, hm: null, lm: { p: POINTS } })).toEqual([
      'lm: not allowed: face landmark coordinates stay in samples.jsonl (spec 8.1, 8.7, 12.3)',
    ]);
    expect(validateDetectorInLine({ k: 'batch', seq: 1, tr: [[1, 'x']], talk: [], g: null, hm: null })).toEqual([
      'tr[0][1]: expected a finite number, got "x"',
    ]);
    expect(validateDetectorInLine({ k: 'val', seq: 1 })).toEqual(['code: missing']);
    expect(validateDetectorInLine({ k: 'voice', n: 1, on: 'yes' })).toEqual(['on: expected true or false, got "yes"']);
  });
});

describe('events.jsonl', () => {
  it('accepts the worker, page and host lines', () => {
    const lines = [
      { n: 8640000, e: 'fire', det: 'D1', seq: 5417, v: 2.3125, theta: 1.875 },
      { n: 8640000, e: 'hold', cause: 'chest', nCmd: 8640000, nSilent: 8640384, word: 57 },
      { n: 42000, e: 'hold', cause: 'voice', nCmd: 42000, nSilent: 42384, word: null },
      { n: 8774400, e: 'resume', word: 57, why: 'timeout' },
      { n: 8966400, e: 'armed', det: 'D3', on: false },
      { n: 1000, e: 'visibilitychange', state: 'hidden', hard: true },
      { n: 1000, e: 'resize', w: 1280, h: 720, hard: false },
      { n: 1000, e: 'gain', value: 0.35, db: -9.1, final: true },
      { n: null, e: 'tap', by: 'host', status: 'running' },
      { n: 96000, e: 'audio_gap', by: 'host', expected: 96000, got: 105600, missing: 9600 },
      { n: 2000, e: 'tap_lost', by: 'host', why: 'silence', silent_ms: 3012 },
      { n: 2000, e: 'sdk_error', by: 'host', code: null, name: 'tap', message: 'camera busy' },
      { n: 3000, e: 'preflight_ok' },
    ];
    for (const l of lines) expect(validateEventLine(l)).toEqual([]);
  });

  it('keeps the spec events exact and explains each problem', () => {
    expect(validateEventLine({ n: 8640000, e: 'hold', cause: 'chest', nCmd: 8640000, nSilent: 8640000, word: 57 })).toEqual([
      'nSilent: must be nCmd + 384 = 8640384, got 8640000 (spec 6.2, 13.4)',
    ]);
    expect(validateEventLine({ n: 1, e: 'fire', det: 'D2', seq: 1, v: 1, theta: 1 })).toEqual(['det: expected one of "D1", "D3", got "D2"']);
    expect(validateEventLine({ n: 1, e: 'resume', word: 3, why: 'done' })).toEqual([
      'why: expected one of "voice_off", "timeout", got "done"',
    ]);
    expect(validateEventLine({ n: 1, e: 'armed', det: 'D1', on: true, note: 'x' })).toEqual(['note: unexpected field']);
    expect(validateEventLine({ n: null, e: 'fire', det: 'D1', seq: 1, v: 1, theta: 1 })).toEqual([
      'n: expected a sample number (non-negative integer), got null',
    ]);
    expect(validateEventLine({ n: 1, e: 'visibilitychange', hard: true })).toEqual(['state: missing']);
    expect(validateEventLine({ n: 1.5, e: 'blur' })).toEqual(['n: expected a sample number (non-negative integer), got 1.5']);
    expect(validateEventLine({ n: 1, e: 'Blur!' })).toEqual(['e: expected an event name in lower case, like "preflight_ok", got "Blur!"']);
    expect(validateEventLine({ n: 1 })).toEqual(['e: missing (the event name, like "hold")']);
    expect(validateEventLine({ n: 1, e: 'blur', p: [[1, 2]] })).toEqual([
      'p: not allowed: face landmark coordinates stay in samples.jsonl (spec 8.1, 8.7, 12.3)',
    ]);
  });

  it('counts hard device events, hidden pages and warnings as clock_report does (spec 8.1)', () => {
    const events = [
      { n: 1, e: 'devicechange', hard: true },
      { n: 2, e: 'track_ended', hard: true },
      { n: 3, e: 'track_mute', hard: true },
      { n: 4, e: 'visibilitychange', state: 'hidden', hard: true },
      { n: 5, e: 'visibilitychange', state: 'visible', hard: false },
      { n: 6, e: 'blur', hard: false },
      { n: 7, e: 'resize', w: 1, h: 1, hard: false },
      { n: 8, e: 'page_reload', by: 'host', page_loads: 2 },
      { n: 9, e: 'armed', det: 'D1', on: true },
    ] as EventLine[];
    expect(countWindowEvents(events)).toEqual({ device: 3, visibility: 1, warnings: 2 });
    expect(events.filter(isHardWindowEvent).map((e) => e.n)).toEqual([1, 2, 3, 4]);
    const armed = events[8] as EventLine;
    expect(isEvent(armed, 'armed') && armed.det).toBe('D1');
  });

  it('writes the spec key order for host and page events too', () => {
    expect(toJsonlLine({ hard: true, state: 'hidden', e: 'visibilitychange', n: 5 }, 'events.jsonl')).toBe(
      '{"n":5,"e":"visibilitychange","state":"hidden","hard":true}',
    );
    expect(toJsonlLine({ word: 57, nSilent: 8640384, nCmd: 8640000, cause: 'chest', e: 'hold', n: 8640000 })).toBe(
      '{"n":8640000,"e":"hold","cause":"chest","nCmd":8640000,"nSilent":8640384,"word":57}',
    );
  });
});

describe('manifest.json', () => {
  /** The manifest host writes (live/lib/manifest.cjs): the spec fields plus its own. */
  const hostManifest = {
    schema: 'session/1', id: 'gate-a', kind: 'gate', started_utc: '2026-11-13T20:01:02Z', app_commit: '3f2c9ab', tree_clean: true,
    plan_commitment: null, sdk: { version: '3.5.0', metrics: ['CHEST_BREATHING', 'FACE_LANDMARKS', 'TALKING'], launcher: 'node' },
    machine: 'Mac15,6', camera: { name: 'Mock camera (no SDK)', requested: [1280, 720, 30] },
    audio: {
      microphone: 'Test headset microphone', output: 'Test headset', sample_rate: 48000, mic_flags_off: true, output_gain: null,
      first_n0: 0, frames: 96000, blocks: 10, contiguous: true, gaps: 0, bad_blocks: 0, dropped_before_consent: 0,
      settings: { sampleRate: 48000, echoCancellation: false, deviceId: 'abc', label: 'Test headset microphone' },
    },
    mode: 'gate', scenario: 'gate-A', pack: 'A', tap: 'mock', state: 'closed', end: { reason: 'done', by: 'page' },
    unusable: false, unusable_reasons: [], page_loads: 1, narrator: { names: ['listen.wav'], sealed_served: [] },
    files: { 'audio.wav': `sha256:${HEX('1')}`, 'detector_in.jsonl': `sha256:${HEX('2')}` },
  };

  it('accepts the host manifest, extra host fields included', () => {
    expect(validateManifest(hostManifest)).toEqual([]);
    expect(validateManifest({ ...hostManifest, app_commit: null, tree_clean: null, sdk: null, camera: null })).toEqual([]);
  });

  it("dry, host's marker of tap's stand-in SDK, is true or false (spec 6.5)", () => {
    expect(validateManifest({ ...hostManifest, dry: false })).toEqual([]);
    expect(validateManifest({ ...hostManifest, dry: true })).toEqual([]);
    expect(validateManifest({ ...hostManifest, dry: 'yes' })).toHaveLength(1);
    expect(validateManifest({ ...hostManifest, dry: 'yes' })[0]).toMatch(/^dry: /);
  });

  it('reports wrong hashes, kinds and file names', () => {
    expect(validateManifest({ ...hostManifest, files: { 'audio.wav': HEX('1') } })).toEqual([
      `files["audio.wav"]: expected "sha256:" and 64 lowercase hex characters, got "${HEX('1').slice(0, 45)}..."`,
    ]);
    expect(validateManifest({ ...hostManifest, files: { '/Users/me/audio.wav': `sha256:${HEX('1')}` } })).toEqual([
      'files["/Users/me/audio.wav"]: unexpected key (expected a relative file name)',
    ]);
    expect(validateManifest({ ...hostManifest, kind: 'session' })).toEqual([
      'kind: expected one of "gate", "numbers", "spacebar", "rehearsal", "demo", "pilot", "doctor", "smoke", "headstart", "live_from", "live_sim", got "session"',
    ]);
    expect(validateManifest({ ...hostManifest, kind: 'numbers', plan_commitment: HEX('9') })).toEqual([
      'pack: only a "gate" record has a pack, this one is "numbers"',
    ]);
    expect(validateManifest({ ...hostManifest, plan_commitment: '9f2c41d7' })).toEqual([
      'plan_commitment: expected a SHA-256 as 64 lowercase hex characters, got "9f2c41d7"',
    ]);
    const { files: _f, ...noFiles } = hostManifest;
    expect(validateManifest(noFiles)).toEqual(['files: missing']);
    expect(validateManifest({ ...hostManifest, camera: { name: 'x', requested: [1280, 720] } })).toEqual([
      'camera.requested: expected [width, height, fps], got a list of 2',
    ]);
  });

  it('a record that narrates a sealed plan carries its seal; the gate, doctor and smoke none (spec 8.3)', () => {
    const plan = { ...hostManifest, pack: null };
    for (const kind of SEALED_PLAN_KINDS) {
      expect(validateManifest({ ...plan, kind, plan_commitment: HEX('9') })).toEqual([]);
      // The review probe: a numbers manifest without its seal.
      expect(validateManifest({ ...plan, kind, plan_commitment: null })).toEqual([
        `plan_commitment: a ${kind} record narrates a sealed plan: host writes its 64-character seal here before the narration (spec 8.3)`,
      ]);
    }
    expect(SEALED_PLAN_KINDS).toEqual(['numbers', 'spacebar', 'rehearsal', 'demo', 'pilot']);
    for (const kind of PLANLESS_KINDS) {
      expect(validateManifest({ ...plan, kind, plan_commitment: null })).toEqual([]);
      expect(validateManifest({ ...plan, kind, plan_commitment: HEX('9') })).toEqual([`plan_commitment: a ${kind} record narrates no sealed plan: expected null (spec 8.3)`]);
    }
    // Development runs may carry the seal of what they read, or none.
    for (const kind of ['headstart', 'live_from', 'live_sim'] as const) {
      expect(validateManifest({ ...plan, kind, plan_commitment: null })).toEqual([]);
      expect(validateManifest({ ...plan, kind, plan_commitment: HEX('9') })).toEqual([]);
    }
  });
});

describe('calib.json, clock_report.json and onsets.json', () => {
  it('calib.json from host, clocks and doctor, merged; ms and dB values rounded to 0.1', () => {
    expect(validateCalib({ schema: 'calib/1', output_gain: 0.35 })).toEqual([]);
    expect(validateCalib({ schema: 'calib/1', output_gain: 0.35, doctor_note: 'level -9 dB' })).toEqual([]);
    expect(validateCalib({ schema: 'calib/1', L_rt_ms: { A: 23.45 } })).toEqual([
      'L_rt_ms.A: expected a report value rounded to 0.1 (spec 8.1), got 23.45',
    ]);
    expect(validateCalib({ schema: 'calib/1', extra_ms: 1.25 })).toEqual(['extra_ms: expected a report value rounded to 0.1 (spec 8.1), got 1.25']);
    expect(validateCalib({ schema: 'calib/1', polarity: { sign: 0, breaths_agree: 3 } })).toEqual(['polarity.sign: expected one of 1, -1, got 0']);
  });

  it('clock_report.json as core/clock writes it: rule in chain, trace_valid null without camera', () => {
    const report = {
      schema: 'clock-report/1', audio_valid: true, trace_valid: null,
      chain: { L_rt_ms: [23.4, 23.6], spread_ms: [0.3, 0.2], rule: 'mean', quantum_ms: 2.7, stops: 0, stops_match_ch1: 0, nCmd_minus_nArr: null },
      onset: null,
      hard: {
        chunks_contiguous: true, sample_rate: null, mic_flags_off: true, device_events: 0, visibility_events: 0,
        trace_rate_median: null, sdk_errors: 0, tap_lost: 0,
      },
      warn: { not_sent_share: null, tap_loop_p99_ms: null, status_ok_share: null, window_warnings: 1 },
    };
    expect(validateClockReport(report)).toEqual([]);
    expect(validateClockReport({ ...report, chain: { ...report.chain, quantum_ms: 2.6667 } })).toEqual([
      'chain.quantum_ms: expected a report value rounded to 0.1 (spec 8.1), got 2.6667',
    ]);
    expect(validateClockReport({ ...report, chain: { ...report.chain, stops: 1, stops_match_ch1: 2 } })).toEqual([
      'chain.stops_match_ch1 cannot exceed chain.stops',
    ]);
    expect(validateClockReport({ ...report, note: 'timing proven' })).toEqual([
      'note: unexpected field',
      'note: the clock report holds only measured numbers: no "proven" or "met" (spec 8.1), got "timing proven"',
    ]);
  });

  it('onsets.json: sample numbers are integers, n_v before n_a, ids unique', () => {
    const ev = {
      id: 'o07', kind: 'objection', label: 'speech', voiced_ms: 640, floor_db: -57.9,
      auto: { n_v: 8656704, n_a: 8657664, breath: [8626560, 8651424], flags: [] }, manual: { n_v: 8656944, blind: true },
    };
    const doc = { schema: 'onsets/1', labels_sha256: HEX('0'), events: [ev] };
    expect(validateOnsets(doc)).toEqual([]);
    expect(validateOnsets({ ...doc, events: [{ ...ev, auto: { ...ev.auto, n_v: 8656704.5 } }] })).toEqual([
      'events[0].auto.n_v: expected a sample number (non-negative integer), got 8656704.5',
    ]);
    expect(validateOnsets({ ...doc, events: [{ ...ev, auto: { ...ev.auto, n_v: 8657665 } }] })).toEqual([
      'events[0].auto: n_v lies after n_a: the onset is found stepping back from the anchor (spec 7.6)',
    ]);
    expect(validateOnsets({ ...doc, events: [ev, ev] })).toEqual(['events: id "o07" appears twice']);
    const parsed = parseJson('{"schema":"onsets/1","labels_sha256":null,"events":[{"id":"o1"}]}', validateOnsets, { file: 'onsets.json' });
    expect(parsed.value).toBeNull();
    expect(parsed.errors).toEqual([
      'onsets.json: events[0].kind: missing',
      'onsets.json: events[0].label: missing',
      'onsets.json: events[0].voiced_ms: missing',
      'onsets.json: events[0].floor_db: missing',
      'onsets.json: events[0].auto: missing',
      'onsets.json: events[0].manual: missing',
    ]);
  });

  it('onsets.json: after the label step every event has its blind label and hand mark; before it none (spec 7.6, 8.5)', () => {
    const auto = { n_v: 8656704, n_a: 8657664, breath: null, flags: [] };
    const ev = { id: 'o07', kind: 'objection', label: 'speech', voiced_ms: 640, floor_db: -57.9, auto, manual: { n_v: 8656944, blind: true } };
    const labelled = (events: object[]): unknown => ({ schema: 'onsets/1', labels_sha256: HEX('0'), events });
    const before = (events: object[]): unknown => ({ schema: 'onsets/1', labels_sha256: null, events });
    // "No reply": label other without a first sound.
    const noReply = { ...ev, id: 'o08', label: 'other', manual: { n_v: null, blind: true } };
    expect(validateOnsets(labelled([ev, noReply]))).toEqual([]);
    expect(validateOnsets(before([{ ...ev, label: null, manual: null }]))).toEqual([]);
    // The review probes: marks partly lost, a speech label without its mark, a mark made with the onsets visible.
    expect(validateOnsets(labelled([ev, { ...ev, id: 'o08', manual: null }]))).toEqual([
      'events[1].manual: missing: labels_sha256 is set, so every event has its blind hand mark (spec 7.6, 8.5)',
    ]);
    expect(validateOnsets(labelled([{ ...ev, label: null }]))).toEqual([
      'events[0].label: missing: labels_sha256 is set, so the label step gave every event its blind label (spec 7.6, 8.5)',
    ]);
    expect(validateOnsets(labelled([{ ...ev, manual: { n_v: null, blind: true } }]))).toEqual([
      'events[0].manual.n_v: a speech event needs its first-sound mark: only "other" (no reply) has none (spec 7.6)',
    ]);
    expect(validateOnsets(labelled([{ ...ev, manual: { n_v: 8656944, blind: false } }]))).toEqual([
      'events[0].manual.blind: expected true: hand marks are made with the onsets hidden (spec 7.6)',
    ]);
    // Without labels_sha256 nothing of the label step may stand in the file.
    expect(validateOnsets(before([ev]))).toEqual([
      'events[0].label: a blind label without labels_sha256: labels come with their hash from the label step (spec 8.5)',
      'events[0].manual: a hand mark without labels_sha256: hand marks come with their hash from the label step (spec 8.5)',
    ]);
  });
});
