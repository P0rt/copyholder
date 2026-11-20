import { describe, expect, it } from 'vitest';
import { DEEP_BREATH_SIGN_ERROR } from '../lib/deep-breath-sign.ts';
import { SdkReadiness } from '../lib/sdk-ready.ts';
import { SDK_OK_HOLD_SAMPLES } from '../lib/units.ts';
import { SAMPLE_RATE_HZ } from '../scenarios/format.ts';
import { parseConfig } from './config.ts';
import { LIVE_VIEW_LEVEL_WINDOW_SAMPLES } from './deck-options.ts';
import { detectorText, infoLine, LiveModel, normalise, percentile, SDK_WAITING_TEXT, sdkStatusText, stoppedCause } from './live-model.ts';

const N = (seconds: number) => Math.round(seconds * SAMPLE_RATE_HZ);

/** Trace packets at `rate` per second from t0 s to t1 s, `perPacket` samples each, arriving 0.1 s after their camera time. */
function feedTrace(m: LiveModel, t0: number, t1: number, rate: number, value: (tS: number) => number = () => 0, perPacket = 1): void {
  for (let k = Math.ceil(t0 * rate); k < t1 * rate; k++) {
    const tS = k / rate;
    const pts: Array<[number, number]> = [];
    for (let j = 0; j < perPacket; j++) pts.push([1e15 + Math.round(tS * 1e6) - (perPacket - 1 - j) * 1_000, value(tS)]);
    m.worker({ k: 'trace', n: N(tS + 0.1), sign: 1, count: perPacket, pts });
  }
}

describe('live view: pure parts (spec 15.1, 15.2)', () => {
  it('percentile interpolates between order statistics; normalise maps P10 to 0 and P90 to 1', () => {
    const vals = Array.from({ length: 11 }, (_, i) => 10 - i);
    expect(percentile(vals, 10)).toBe(1);
    expect(percentile(vals, 90)).toBe(9);
    expect(percentile(vals, 50)).toBe(5);
    expect(percentile([1, 2], 25)).toBe(1.25);
    expect(percentile([], 50)).toBeNaN();
    expect(normalise(1, 1, 9)).toBe(0);
    expect(normalise(9, 1, 9)).toBe(1);
    expect(normalise(5, 1, 9)).toBe(0.5);
    expect(normalise(13, 1, 9)).toBe(1.5);
    // A flat trace and an empty one sit in the middle of the lane.
    expect(normalise(3, 2, 2)).toBe(0.5);
    expect(normalise(3, Number.NaN, Number.NaN)).toBe(0.5);
  });

  it('only stopped states carry a cause', () => {
    expect(stoppedCause('hold_wait', 'chest')).toBe('chest');
    expect(stoppedCause('listening', 'voice')).toBe('voice');
    expect(stoppedCause('listening', 'key')).toBe('key');
    expect(stoppedCause('narrating', 'voice')).toBeNull();
    expect(stoppedCause('resume', null)).toBeNull();
    expect(stoppedCause('listening', 'other')).toBeNull();
  });

  it('the info line names the SDK version, the samples per second and the SDK status', () => {
    expect(infoLine('3.5.0', 29.6, { tap: 'running', ok: true })).toBe('SmartSpectra SDK 3.5.0 · 30 samples/s · kOk');
    expect(infoLine(null, 0, null)).toBe('SmartSpectra SDK version unknown · 0 samples/s · not running');
    expect(sdkStatusText({ tap: 'running', ok: false, note: 'kNoFaceFound' })).toBe('kNoFaceFound');
    expect(sdkStatusText({ tap: 'starting', ok: false })).toBe('starting');
    expect(sdkStatusText({ tap: 'stopped', ok: false })).toBe('not running');
    expect(sdkStatusText({ tap: 'stopped', ok: false, note: 'tap stopped' })).toBe('tap stopped');
  });

  it('says kOk only while the readiness of spec 7.1 holds, never while the SDK still waits for it', () => {
    // tap runs, but no validationStatus has come, processingStatus is not Running, or kOk is not held 5 s yet.
    expect(sdkStatusText({ tap: 'running', ok: false })).toBe(SDK_WAITING_TEXT);
    expect(SDK_WAITING_TEXT).toBe('waiting for kOk');
    expect(infoLine('3.5.0', 30, { tap: 'running', ok: false })).toBe('SmartSpectra SDK 3.5.0 · 30 samples/s · waiting for kOk');
    expect(sdkStatusText({ tap: 'running', ok: true })).toBe('kOk');
    // A code that is not kOk is named whatever the readiness says.
    expect(sdkStatusText({ tap: 'running', ok: false, note: 'kNoFaceFound' })).toBe('kNoFaceFound');
    expect(sdkStatusText({ tap: 'starting', ok: false, note: 'kNoFaceFound' })).toBe('kNoFaceFound');
  });

  it('follows the worker readiness through a run: waiting, kOk, a code, waiting again, kOk (web/lib/sdk-ready.ts)', () => {
    const ready = new SdkReadiness(SDK_OK_HOLD_SAMPLES);
    const shown: string[] = [];
    const show = () => {
      const t = sdkStatusText(ready.status());
      if (shown[shown.length - 1] !== t) shown.push(t);
    };
    show();
    ready.onTap('starting');
    show();
    ready.onTap('running');
    show();
    ready.onProcessing('kRunning', 3, 0);
    show();
    ready.onValidation(0, 'kOk', N(1));
    show();
    ready.onClock(N(5.9));
    show();
    ready.onClock(N(6));
    show();
    ready.onValidation(7, 'kNoFaceFound', N(20));
    show();
    ready.onValidation(0, 'kOk', N(22));
    show();
    ready.onClock(N(27));
    show();
    expect(shown).toEqual(['not running', 'starting', SDK_WAITING_TEXT, 'kOk', 'kNoFaceFound', SDK_WAITING_TEXT, 'kOk']);
  });

  it('takes the SDK version from /api/config; none or an empty one shows as unknown', () => {
    expect(parseConfig({ mode: 'headstart', sdkVersion: ' 3.5.0 ' }).sdkVersion).toBe('3.5.0');
    expect(parseConfig({ mode: 'headstart', sdkVersion: '' }).sdkVersion).toBeNull();
    expect(parseConfig({ mode: 'headstart', sdkVersion: null }).sdkVersion).toBeNull();
    expect(parseConfig({ mode: 'headstart' }).sdkVersion).toBeNull();
  });

  it('the detector line', () => {
    expect(detectorText('active')).toBe('chest detector: active');
    expect(detectorText('not_active')).toBe('chest detector: not active');
    expect(detectorText('not_yet')).toBe('chest detector: not active yet');
    expect(detectorText('off')).toBe('chest detector: off in this run');
  });
});

describe('LiveModel', () => {
  it('counts trace samples per second over the last 5 s, a younger trace over its own age', () => {
    const m = new LiveModel(LIVE_VIEW_LEVEL_WINDOW_SAMPLES);
    expect(m.samplesPerSecond()).toBe(0);
    feedTrace(m, 0, 3, 30);
    // 3 s of trace: 90 samples over its age of about 2.97 s.
    expect(m.samplesPerSecond()).toBeCloseTo(30, 0);
    feedTrace(m, 3, 20, 30);
    expect(m.samplesPerSecond()).toBeCloseTo(30, 0);
    // The SDK slows to 15 per second: after 5 s the count shows it.
    feedTrace(m, 20, 26, 15);
    expect(m.samplesPerSecond()).toBeCloseTo(15, 0);
    // Several samples per packet count as samples, not packets.
    const dense = new LiveModel(LIVE_VIEW_LEVEL_WINDOW_SAMPLES);
    feedTrace(dense, 0, 10, 10, () => 0, 3);
    expect(dense.samplesPerSecond()).toBeCloseTo(30, 0);
    // No packet for 5 s: 0.
    expect(m.samplesPerSecond(N(40))).toBe(0);
  });

  it('normalises the trace by its 10th and 90th percentiles over the last 30 s', () => {
    const m = new LiveModel(LIVE_VIEW_LEVEL_WINDOW_SAMPLES);
    // A slow ramp from 0 to 100 over 40 s: the last 30 s hold 25 to 100.
    feedTrace(m, 0, 40, 30, (tS) => 2.5 * tS);
    const r = m.traceRange();
    expect(r.low).toBeCloseTo(25 + 0.1 * 75, 0);
    expect(r.high).toBeCloseTo(25 + 0.9 * 75, 0);
    expect(normalise(r.high, r.low, r.high)).toBe(1);
  });

  it('places the points of a packet back from its arrival by their camera time', () => {
    const m = new LiveModel(LIVE_VIEW_LEVEL_WINDOW_SAMPLES);
    m.worker({ k: 'trace', n: 96_000, sign: 1, count: 3, pts: [[1e15, 1], [1e15 + 50_000, 2], [1e15 + 100_000, 3]] });
    expect(m.trace.map((p) => [p.n, p.v])).toEqual([
      [96_000 - 4_800, 1],
      [96_000 - 2_400, 2],
      [96_000, 3],
    ]);
    expect(m.latestN).toBe(96_000);
  });

  it('flips what it holds when the sign of the run changes, so the trace keeps one direction', () => {
    const m = new LiveModel(LIVE_VIEW_LEVEL_WINDOW_SAMPLES);
    m.worker({ k: 'trace', n: 1_000, sign: 1, count: 1, pts: [[1e15, 0.5]] });
    m.worker({ k: 'trace', n: 2_600, sign: -1, count: 1, pts: [[1e15 + 33_333, -0.7]] });
    expect(m.trace.map((p) => p.v)).toEqual([-0.5, -0.7]);
    m.worker({ k: 'trace', n: 4_200, sign: -1, count: 1, pts: [[1e15 + 66_667, -0.9]] });
    expect(m.trace.map((p) => p.v)).toEqual([-0.5, -0.7, -0.9]);
  });

  it('shows the cause of a stop while the narrator is stopped and keeps the spans by cause', () => {
    const m = new LiveModel(LIVE_VIEW_LEVEL_WINDOW_SAMPLES);
    expect(m.badge).toBeNull();
    m.deck({ k: 'state', n: N(10), s: 'narrating', cause: null });
    expect(m.badge).toBeNull();
    // A voice stop goes straight to listening, then resume.
    m.deck({ k: 'state', n: N(12), s: 'listening', cause: 'voice' });
    expect(m.badge).toBe('voice');
    m.deck({ k: 'state', n: N(14), s: 'resume', cause: null });
    expect(m.badge).toBeNull();
    m.deck({ k: 'state', n: N(14.2), s: 'narrating', cause: null });
    // A chest stop: hold_wait, then listening while the user speaks, then resume.
    m.deck({ k: 'state', n: N(20), s: 'hold_wait', cause: 'chest' });
    expect(m.badge).toBe('chest');
    m.deck({ k: 'state', n: N(21), s: 'listening', cause: 'chest' });
    expect(m.badge).toBe('chest');
    m.deck({ k: 'state', n: N(23), s: 'resume', cause: null });
    m.deck({ k: 'state', n: N(23.1), s: 'narrating', cause: null });
    expect(m.stops).toEqual([
      { cause: 'voice', n0: N(12), n1: N(14) },
      { cause: 'chest', n0: N(20), n1: N(23) },
    ]);
    // A stop still open at the end of the run is closed by done.
    m.deck({ k: 'state', n: N(30), s: 'hold_wait', cause: 'chest' });
    m.deck({ k: 'done', n: N(31) });
    expect(m.badge).toBeNull();
    expect(m.stops.at(-1)).toEqual({ cause: 'chest', n0: N(30), n1: N(31) });
    expect(m.stopCounts()).toEqual({ chest: 2, voice: 1, key: 0 });
    expect(m.summaryLines()).toEqual(['CHEST stops: 2', 'VOICE stops: 1']);
    m.deck({ k: 'state', n: N(40), s: 'hold_wait', cause: 'key' });
    expect(m.summaryLines()).toEqual(['CHEST stops: 2', 'VOICE stops: 1', 'KEY stops: 1']);
  });

  it('puts the k-th level message at the end of its window, counted from sample 0', () => {
    const m = new LiveModel(LIVE_VIEW_LEVEL_WINDOW_SAMPLES);
    m.deck({ k: 'level', ch0Db: -30, ch1Db: -20 });
    m.deck({ k: 'level', ch0Db: -31, ch1Db: -21 });
    expect(m.levels).toEqual([
      { n: 2_400, ch0Db: -30, ch1Db: -20 },
      { n: 4_800, ch0Db: -31, ch1Db: -21 },
    ]);
    expect(m.latestN).toBe(4_800);
  });

  it('keeps the current step for the summary; fires and the detector line from the worker', () => {
    const m = new LiveModel(LIVE_VIEW_LEVEL_WINDOW_SAMPLES);
    m.deck({ k: 'step', n: N(100), name: 'summary', text: 'Summary of this take' });
    expect(m.currentStep).toBe('summary');
    expect(m.worker({ k: 'fire', n: N(101), v: 2.5, theta: 1.9 })).toBe(true);
    expect(m.fires).toEqual([{ n: N(101), v: 2.5, theta: 1.9 }]);
    expect(m.detectorShown).toBe('not_yet');
    // armed off before it was ever on keeps "not active yet".
    expect(m.worker({ k: 'armed', n: N(101), on: false })).toBe(true);
    expect(m.detectorShown).toBe('not_yet');
    m.worker({ k: 'armed', n: N(102), on: true });
    expect(m.detectorShown).toBe('active');
    m.worker({ k: 'armed', n: N(103), on: false });
    expect(m.detectorShown).toBe('not_active');
    // The page's other worker messages stay with the controller.
    expect(m.worker({ k: 'sdk', tap: 'running', ok: true })).toBe(false);
    expect(m.sdk).toEqual({ tap: 'running', ok: true });
    expect(m.worker({ k: 'error', message: DEEP_BREATH_SIGN_ERROR })).toBe(false);
    expect(m.worker({ k: 'closed' })).toBe(false);
  });

  it('after the deep breaths gave no sign the detector line stays off', () => {
    const m = new LiveModel(LIVE_VIEW_LEVEL_WINDOW_SAMPLES);
    m.signFailed();
    m.worker({ k: 'armed', n: 10, on: true });
    expect(m.detectorShown).toBe('off');
  });

  it('drops what is older than the lanes and the 30 s of the percentiles need', () => {
    const m = new LiveModel(LIVE_VIEW_LEVEL_WINDOW_SAMPLES);
    feedTrace(m, 0, 100, 30);
    for (let k = 0; k < 2_000; k++) m.deck({ k: 'level', ch0Db: -40, ch1Db: -40 });
    const oldest = m.trace[0]!.n;
    expect(m.latestN - oldest).toBeLessThanOrEqual(N(35));
    expect(m.latestN - oldest).toBeGreaterThan(N(30));
    expect(m.levels.length).toBeLessThanOrEqual(35 * 20 + 1);
  });
});
