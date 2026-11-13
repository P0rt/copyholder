import { describe, expect, it } from 'vitest';
import { validateClockReport } from '../schemas/index.ts';
import {
  CHUNK_SAMPLES,
  SDK_RESTART_CODE,
  audioIndex,
  chunkLayout,
  clockCheck,
  clockCheckDetails,
  hardFailures,
  isDeviceEvent,
  isHardEvent,
  isPageHiddenEvent,
  isPageLossEvent,
  loopClickBlocks,
  onsetBlock,
  sdkErrorCount,
  stopChecks,
  traceRateMedian,
  type ClockReport,
  type EventLine,
  type SampleLine,
  type SessionData,
  type Stamp,
} from './index.ts';

const chunk = (n: number): Stamp => ({ n, k: 'chunk', frames: CHUNK_SAMPLES });

function session(over: Partial<SessionData> & { chunks?: number }): SessionData {
  const chunks = over.chunks ?? 10;
  const length = chunks * CHUNK_SAMPLES;
  return {
    sampleRateHz: 48_000,
    ch0: new Float32Array(length),
    ch1: new Float32Array(length),
    stamps: Array.from({ length: chunks }, (_, i) => chunk(i * CHUNK_SAMPLES)),
    samples: [],
    events: [],
    micSettings: { sampleRate: 48_000, echoCancellation: false, noiseSuppression: false, autoGainControl: false },
    ...over,
  };
}

describe('chunkLayout (spec 6.3, 7.2)', () => {
  it('accepts blocks that follow each other from sample 0', () => {
    const l = chunkLayout([chunk(0), chunk(9600), chunk(19200)], 28_800);
    expect(l.contiguous).toBe(true);
    expect(l.runs).toEqual([{ n0: 0, n1: 28_800, index0: 0 }]);
  });

  it('finds a gap, a late first block and a length mismatch', () => {
    expect(chunkLayout([chunk(0), chunk(19200)], 19_200).contiguous).toBe(false);
    expect(chunkLayout([chunk(9600), chunk(19200)], 19_200).contiguous).toBe(false);
    expect(chunkLayout([chunk(0), chunk(9600)], 19_000).contiguous).toBe(false);
    expect(chunkLayout([], 0).contiguous).toBe(false);
    expect(chunkLayout([{ n: 0, k: 'chunk', frames: 0 }], 0).contiguous).toBe(false);
  });

  it('maps sample numbers to audio indices across a gap', () => {
    const l = chunkLayout([chunk(0), chunk(9600), chunk(28_800), chunk(38_400)], 38_400);
    expect(audioIndex(l, 30_000)).toBe(19_200 + 1_200);
    expect(audioIndex(l, 20_000)).toBeNull();
    expect(audioIndex(l, 18_000, 2_000)).toBeNull();
    expect(audioIndex(l, 28_800, 19_200)).toBe(19_200);
  });
});

describe('loopClickBlocks', () => {
  const clicks = (from: number, count: number): Stamp[] =>
    Array.from({ length: count }, (_, i) => ({ n: from + i * 50_000, k: 'click', i }));

  it('takes A first and B last, skipping the demo double sync clicks between', () => {
    const b = loopClickBlocks([...clicks(48_000, 10), ...clicks(2_000_000, 3), ...clicks(5_000_000, 10)]);
    expect(b.A).toHaveLength(10);
    expect(b.A![0]).toBe(48_000);
    expect(b.B![0]).toBe(5_000_000);
  });

  it('takes only full checks of 10 clicks: sync clicks anywhere and a check cut short are ignored', () => {
    const b = loopClickBlocks([...clicks(0, 3), ...clicks(1_000_000, 10), ...clicks(5_000_000, 10), ...clicks(9_000_000, 3)]);
    expect(b.A![0]).toBe(1_000_000);
    expect(b.B![0]).toBe(5_000_000);
    const cut = loopClickBlocks([...clicks(1_000_000, 10), ...clicks(5_000_000, 6)]);
    expect(cut.A).toHaveLength(10);
    expect(cut.B).toBeNull();
  });

  it('has no B with one block, and splits on a 3 s gap when i is missing', () => {
    expect(loopClickBlocks(clicks(0, 10)).B).toBeNull();
    const noIndex = [...clicks(0, 10), ...clicks(1_000_000, 10)].map(({ n, k }) => ({ n, k }));
    const b = loopClickBlocks(noIndex);
    expect(b.A).toHaveLength(10);
    expect(b.B).toHaveLength(10);
  });
});

describe('stopChecks (spec 6.3, 10.6)', () => {
  // Channel 1 plays everywhere except [nSilent, resume).
  function withStop(gapAt?: number): SessionData {
    const s = session({});
    s.ch1.fill(0.1);
    s.ch1.fill(0, 20_384, 60_000);
    const stamps: Stamp[] = [
      ...s.stamps,
      { n: 19_968, k: 'arr', seq: 41 },
      { n: 20_000, k: 'hold', cause: 'chest', seq: 41, nSilent: 20_384, word: 3 },
      { n: 60_000, k: 'resume', word: 3 },
    ];
    if (gapAt !== undefined) s.ch1[gapAt] = 0.001;
    return { ...s, stamps };
  }

  it('confirms zeros from nSilent to the resume and reads nCmd - nArr', () => {
    const [c] = stopChecks(withStop());
    expect(c).toEqual({ nCmd: 20_000, nSilent: 20_384, nEnd: 60_000, cause: 'chest', seq: 41, nArr: 19_968, silent: true });
    expect(clockCheck(withStop()).chain).toMatchObject({ stops: 1, stops_match_ch1: 1, nCmd_minus_nArr: 32 });
  });

  it('rejects one non-zero sample, and a stop without nSilent', () => {
    expect(stopChecks(withStop(59_999))[0]!.silent).toBe(false);
    expect(stopChecks(withStop(20_383))[0]!.silent).toBe(true);
    const s = withStop();
    const noSilent = { ...s, stamps: s.stamps.map((x) => (x.k === 'hold' ? { n: x.n, k: 'hold' } : x)) };
    expect(stopChecks(noSilent)[0]!.silent).toBe(false);
  });

  it('ends the range where Deck plays again without a resume stamp: a passage start', () => {
    const s = withStop();
    const stamps = s.stamps.map((x): Stamp => (x.k === 'resume' ? { n: x.n, k: 'state', s: 'narrating' } : x));
    const [c] = stopChecks({ ...s, stamps });
    expect(c).toMatchObject({ nEnd: 60_000, silent: true });
    // Without any such stamp the range runs to the end of the recording, where channel 1 plays.
    const open = stopChecks({ ...s, stamps: s.stamps.filter((x) => x.k !== 'resume') })[0]!;
    expect(open).toMatchObject({ nEnd: 10 * CHUNK_SAMPLES, silent: false });
  });

  it('does not confirm a stop that resumed before nSilent', () => {
    const s = withStop();
    const stamps = s.stamps.map((x): Stamp => (x.k === 'resume' ? { n: 20_200, k: 'resume', word: 3 } : x));
    expect(stopChecks({ ...s, stamps })[0]).toMatchObject({ nEnd: 20_200, silent: false });
  });

  it('cannot confirm a stop whose silence crosses a lost block', () => {
    const s = withStop();
    const stamps = s.stamps.filter((x) => !(x.k === 'chunk' && x.n === 4 * CHUNK_SAMPLES));
    const short = { ...s, stamps, ch0: s.ch0.slice(CHUNK_SAMPLES), ch1: s.ch1.slice(CHUNK_SAMPLES) };
    expect(stopChecks(short)[0]!.silent).toBe(false);
  });
});

describe('traceRateMedian', () => {
  const trace = (rate: number, seconds: number): Array<SampleLine & { seq: number }> =>
    Array.from({ length: rate * seconds }, (_, k) => ({ seq: k, k: 'm', tr: [[1e15 + Math.round((k * 1e6) / rate), 0]] }));

  it('counts unique trace samples per second of camera time', () => {
    expect(traceRateMedian(trace(30, 20))).toBe(30);
    expect(traceRateMedian(trace(15, 20))).toBe(15);
    const repeated = trace(30, 20).flatMap((l) => [l, { ...l, seq: l.seq + 1e6 }]);
    expect(traceRateMedian(repeated)).toBe(30);
    expect(traceRateMedian(trace(30, 1).slice(0, 20))).toBeNull();
  });

  // As tap writes them: tArrNs on tap's clock (ns), the trace on the camera clock (us).
  const timed = (rate: number, seconds: number): SampleLine[] =>
    Array.from({ length: rate * seconds }, (_, k): SampleLine => {
      const dtUs = Math.round((k * 1e6) / rate);
      return { seq: k, k: 'm', tArrNs: String((5e9 + dtUs + 40_000) * 1000), tr: [[1e15 + dtUs, 0]] };
    });
  const stray = (seq: number, ts: number): SampleLine => ({ seq, k: 'm', tArrNs: String((5e9 + 10e6) * 1000), tr: [[ts, 0]] });

  it('leaves out a trace sample far from its arrival time: an old buffer, a zero, a ns timestamp', () => {
    const run = timed(30, 20);
    expect(traceRateMedian(run)).toBe(30);
    const withStrays = [...run.slice(0, 300), stray(9_001, 1e15 - 1e13), stray(9_002, 0), stray(9_003, 1.79e18), ...run.slice(300)];
    expect(traceRateMedian(withStrays)).toBe(30);
  });

  it('never allocates per second of span: a far stray without arrival times gives 0, not a RangeError', () => {
    const lines = [...trace(30, 20), { seq: 9_003, k: 'm', tr: [[1.79e18, 0]] } as SampleLine];
    expect(traceRateMedian(lines)).toBe(0);
  });

  it('counts an empty second as 0 inside the run', () => {
    // 10 s at 30/s, 12 s without samples, 10 s at 30/s: 31 full windows, 12 of them empty.
    const head = timed(30, 10);
    const tail = timed(30, 10).map((l, k): SampleLine => {
      const dtUs = 22e6 + Math.round((k * 1e6) / 30);
      return { ...l, seq: 1_000 + k, tArrNs: String((5e9 + dtUs + 40_000) * 1000), tr: [[1e15 + dtUs, 0]] };
    });
    expect(traceRateMedian([...head, ...tail])).toBe(30);
    const tail2 = tail.map((l): SampleLine => {
      const dtUs = l.tr![0]![0] - 1e15 + 20e6;
      return { ...l, tArrNs: String((5e9 + dtUs + 40_000) * 1000), tr: [[1e15 + dtUs, 0]] };
    });
    // 10 s at 30/s, 32 s empty, 10 s at 30/s: the median window is empty.
    expect(traceRateMedian([...head, ...tail2])).toBe(0);
  });
});

describe('window and device events (spec 7.3, 8.1)', () => {
  it('counts a hidden page unless the event says visible', () => {
    expect(isPageHiddenEvent({ e: 'visibilitychange', state: 'hidden' })).toBe(true);
    expect(isPageHiddenEvent({ e: 'visibilitychange' })).toBe(true);
    expect(isPageHiddenEvent({ e: 'visibilitychange', state: 'visible' })).toBe(false);
    expect(isPageHiddenEvent({ e: 'visibilitychange', hidden: false })).toBe(false);
    expect(isPageHiddenEvent({ e: 'blur' })).toBe(false);
  });

  it('counts hard events inside the recording or without a sample, and blur/resize as warnings', () => {
    const events: EventLine[] = [
      { n: 1_000, e: 'devicechange' },
      { e: 'track_mute' },
      { n: 10 * CHUNK_SAMPLES + 50_000, e: 'devicechange' },
      { n: 2_000, e: 'visibilitychange', state: 'hidden' },
      { n: 3_000, e: 'visibilitychange', state: 'visible' },
      { n: 4_000, e: 'blur' },
      { n: 5_000, e: 'resize' },
      { n: 6_000, e: 'focus' },
    ];
    const r = clockCheck(session({ events }));
    expect(r.hard.device_events).toBe(2);
    expect(r.hard.visibility_events).toBe(1);
    expect(r.warn.window_warnings).toBe(2);
  });
});

describe('clockCheck on a bare recording', () => {
  it('fails without loop checks and reports the camera trace as missing', () => {
    const r = clockCheck(session({}));
    expect(r.chain.rule).toBe('void');
    expect(r.audio_valid).toBe(false);
    expect(r.trace_valid).toBe(false);
    expect(r.hard.trace_rate_median).toBeNull();
    expect(hardFailures(r)).toEqual(['loop check A or B not found', 'trace rate median unknown per s, below 25']);
    expect(r.warn).toEqual({ not_sent_share: null, tap_loop_p99_ms: null, status_ok_share: null, window_warnings: 0 });
  });

  it('sets trace_valid to null without the camera', () => {
    const r = clockCheck(session({}), { camera: false });
    expect(r.trace_valid).toBeNull();
    expect(r.hard.trace_rate_median).toBeNull();
    expect(hardFailures(r)).toEqual(['loop check A or B not found']);
  });

  it('reads the logged microphone settings', () => {
    const on = clockCheck(session({ micSettings: { sampleRate: 48_000, echoCancellation: true, noiseSuppression: false, autoGainControl: false } }));
    expect(on.hard.mic_flags_off).toBe(false);
    expect(clockCheck(session({ micSettings: null })).hard.mic_flags_off).toBe(false);
    const rate = clockCheck(session({ micSettings: { sampleRate: 44_100, echoCancellation: false, noiseSuppression: false, autoGainControl: false } }));
    expect(rate.hard.sample_rate).toBe(44_100);
    expect(hardFailures(rate)).toContain('sample rate 44100 Hz, not 48000');
  });

  it('computes the warning shares', () => {
    const samples: SampleLine[] = [
      ...Array.from({ length: 200 }, (_, i): SampleLine => ({ seq: i, k: 'f', sent: i !== 7 })),
      ...Array.from({ length: 10 }, (_, i): SampleLine => ({ seq: 300 + i, k: 'v', code: i < 9 ? 0 : 1 })),
      ...Array.from({ length: 100 }, (_, i): SampleLine => ({ seq: 400 + i, k: 'l', p99Ms: i < 99 ? 1 : 9 })),
    ];
    expect(clockCheck(session({ samples })).warn).toEqual({
      not_sent_share: 0.005,
      tap_loop_p99_ms: 1.1,
      status_ok_share: 0.9,
      window_warnings: 0,
    });
  });
});

describe('SDK errors (spec 6.3, 7.1)', () => {
  const packet = (seq: number): SampleLine => ({ seq, k: 'm', tArrNs: '1', tsCbUs: 1, tr: [[1e15 + seq, 0]] });
  const error = (seq: number, code: number): SampleLine => ({ seq, k: 'e', tArrNs: '1', code });

  it('leaves out one code-8 error before the first packet: tap restarts on it', () => {
    const restart = session({ samples: [error(0, 8), packet(1), packet(2)] });
    expect(sdkErrorCount(restart)).toBe(0);
    expect(SDK_RESTART_CODE).toBe(8);
  });

  it('counts a second code-8 error, code 8 after the first packet, and any other code before it', () => {
    expect(sdkErrorCount(session({ samples: [error(0, 8), error(1, 8), packet(2)] }))).toBe(1);
    expect(sdkErrorCount(session({ samples: [packet(0), error(1, 8)] }))).toBe(1);
    expect(sdkErrorCount(session({ samples: [error(0, 4), packet(1)] }))).toBe(1);
  });

  it('reads host sdk_error events the same way, and takes the larger of the two counts', () => {
    const stamps = [...session({}).stamps, { n: 50_000, k: 'arr', seq: 1 }];
    const ev = (n: number | null, code: number): EventLine => ({ n, e: 'sdk_error', code, name: 'x', message: '' });
    expect(sdkErrorCount(session({ stamps, events: [ev(null, 8)] }))).toBe(0);
    expect(sdkErrorCount(session({ stamps, events: [ev(40_000, 8)] }))).toBe(0);
    expect(sdkErrorCount(session({ stamps, events: [ev(60_000, 8)] }))).toBe(1);
    expect(sdkErrorCount(session({ stamps, events: [ev(null, 5)] }))).toBe(1);
    // An exception from start() reaches host only: no e line.
    expect(sdkErrorCount(session({ stamps, samples: [packet(1)], events: [ev(60_000, 5), ev(70_000, 5)] }))).toBe(2);
    expect(clockCheck(session({ stamps, events: [ev(60_000, 5)] })).hard.sdk_errors).toBe(1);
  });

  it('counts e lines up to the last packet Deck stamped: an error during stopAsync() is after the recording', () => {
    const stamps = [...session({}).stamps, { n: 50_000, k: 'arr', seq: 1 }, { n: 60_000, k: 'arr', seq: 3 }];
    expect(sdkErrorCount(session({ stamps, samples: [packet(1), packet(3), error(4, 5)] }))).toBe(0);
    expect(sdkErrorCount(session({ stamps, samples: [packet(1), error(2, 5), packet(3), error(4, 5)] }))).toBe(1);
    // A packet tap read but Deck never stamped (the worker had stopped) does not extend the range.
    expect(sdkErrorCount(session({ stamps, samples: [packet(1), packet(3), error(4, 5), packet(5)] }))).toBe(0);
    // Host's event still counts an error inside the recording that no packet follows.
    const ev: EventLine = { n: 70_000, e: 'sdk_error', code: 5, name: 'x', message: '' };
    expect(sdkErrorCount(session({ stamps, samples: [packet(1), packet(3), error(4, 5)], events: [ev] }))).toBe(1);
  });
});

describe('host events that end the recording (spec 6.3, 7.2)', () => {
  it('voids the audio on page_reload and page_lost without counting them as device events (spec 8.1)', () => {
    const events: EventLine[] = [
      { n: 9_600, e: 'page_reload', by: 'host', page_loads: 2 },
      { n: 19_200, e: 'page_lost', by: 'host' },
    ];
    const d = clockCheckDetails(session({ events }));
    expect(d.report.hard.device_events).toBe(0);
    expect(d.report.audio_valid).toBe(false);
    expect(d.pageLosses.map((ev) => ev.e)).toEqual(['page_reload', 'page_lost']);
    expect(d.failures).toContain('page reloaded or lost, or Deck failed, during the recording (page_reload, page_lost)');
    expect(validateClockReport(d.report)).toEqual([]);
  });

  it('names a lost page from the report alone when no field explains invalid audio', () => {
    const report: ClockReport = { ...clockCheck(session({})), audio_valid: false };
    report.chain = { ...report.chain, L_rt_ms: [23.4, 23.5], spread_ms: [0.1, 0.1], rule: 'mean' };
    expect(hardFailures(report, { camera: false })).toEqual(['page reloaded or lost, or Deck failed, during the recording (see events.jsonl)']);
    expect(hardFailures({ ...report, audio_valid: true }, { camera: false })).toEqual([]);
    // Other thresholds judge the fields again; audio_valid was set with the check's own.
    expect(hardFailures(report, { camera: false, lrt: { bothMaxMs: 20 } })).toEqual([]);
  });

  it("treats Deck's deck_error and any other hard event as a lost page, after the recording as nothing", () => {
    const d = clockCheckDetails(session({ events: [{ n: 9_600, e: 'deck_error', message: 'x' }, { n: 9_700, e: 'worker_died', hard: true }] }));
    expect(d.pageLosses).toHaveLength(2);
    expect(d.failures).toContain('page reloaded or lost, or Deck failed, during the recording (deck_error, worker_died)');
    const after = clockCheckDetails(session({ events: [{ n: 10 * CHUNK_SAMPLES + 50_000, e: 'page_lost', by: 'host' }] }));
    expect(after.pageLosses).toEqual([]);
    expect(after.failures.join('\n')).not.toMatch(/page reloaded/);
  });

  it('counts audio_gap events against contiguity even when the stamps look whole', () => {
    const gap: EventLine = { n: 9_600, e: 'audio_gap', by: 'host', expected: 9_600, got: 19_200, missing: 9_600 };
    const r = clockCheck(session({ events: [gap] }));
    expect(r.hard.chunks_contiguous).toBe(false);
  });
});

describe('event classes (spec 7.3, 8.1)', () => {
  it('keeps device, hidden-page and lost-page events apart; each is hard', () => {
    const cases: Array<[EventLine, boolean, boolean, boolean]> = [
      [{ e: 'devicechange' }, true, false, false],
      [{ e: 'track_ended', hard: true }, true, false, false],
      [{ e: 'track_mute' }, true, false, false],
      [{ e: 'visibilitychange', hidden: true }, false, true, false],
      [{ e: 'page_reload' }, false, false, true],
      [{ e: 'page_lost' }, false, false, true],
      [{ e: 'deck_error' }, false, false, true],
      [{ e: 'something_new', hard: true }, false, false, true],
    ];
    for (const [ev, device, hidden, lost] of cases) {
      expect([isDeviceEvent(ev), isPageHiddenEvent(ev), isPageLossEvent(ev), isHardEvent(ev)]).toEqual([device, hidden, lost, true]);
    }
    for (const ev of [{ e: 'blur', hard: false }, { e: 'resize' }, { e: 'visibilitychange', hidden: false, hard: true }, { e: 'audio_gap' }]) {
      expect(isHardEvent(ev)).toBe(false);
    }
  });
});

describe('hardFailures', () => {
  it('skips trace conditions for a report without the camera unless told otherwise', () => {
    const r = clockCheck(session({}), { camera: false });
    expect(hardFailures(r)).toEqual(['loop check A or B not found']);
    expect(hardFailures(r, { camera: true })).toContain('trace rate median unknown per s, below 25');
  });
});

describe('report shape (core/schemas)', () => {
  it('passes validateClockReport, with and without the camera, and with faults', () => {
    const faulty = session({
      chunks: 3,
      micSettings: null,
      events: [{ n: 5, e: 'devicechange', hard: true }, { n: 6, e: 'tap_lost' }, { n: 7, e: 'blur', hard: false }],
    });
    for (const r of [clockCheck(session({})), clockCheck(session({}), { camera: false }), clockCheck(faulty)]) {
      expect(validateClockReport(r)).toEqual([]);
    }
  });
});

describe('report words (spec 6.3, 7.12)', () => {
  it('never prints proven or met', () => {
    const bad: ClockReport = clockCheck(session({ chunks: 3, events: [{ n: 5, e: 'devicechange' }, { n: 6, e: 'tap_lost' }] }));
    const text = JSON.stringify(bad) + hardFailures(bad).join('\n');
    expect(text).not.toMatch(/\b(proven|met)\b/i);
  });
});

describe('onsetBlock (spec 7.12)', () => {
  it('gives the 90th percentile of |auto - manual| in ms and counts soft first sounds', () => {
    const pairs = Array.from({ length: 10 }, (_, i) => ({ autoNv: 1000, manualNv: 1000 + 48 * (i + 1), soft: i < 3 }));
    expect(onsetBlock(pairs)).toEqual({ p90_abs_auto_minus_manual_ms: 9.1, events: 10, soft_first_sounds: 3 });
    expect(onsetBlock([])).toEqual({ p90_abs_auto_minus_manual_ms: null, events: 0, soft_first_sounds: 0 });
  });
});
