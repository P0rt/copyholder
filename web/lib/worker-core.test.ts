import { describe, expect, it } from 'vitest';
import { synthSession } from '../../core/detector/synth.ts';
import { decodeChunkFrame } from './chk1.ts';
import { DEFAULT_VAD_PARAMS, vadFrozenBlock, type DetectorInput } from './core.ts';
import { DeckCore } from './deck-core.ts';
import { PRELIMINARY_DETECTOR, batchFromTapLine, detectorChoice, replayFires } from './detector-adapter.ts';
import type { DeckToWorker, PktMessage } from './messages.ts';
import { TAP_SOCKET_CLOSED_NOTE, isRunningStatus } from './sdk-ready.ts';
import { TAP_URL, wiredWorker, type WiredWorker } from './testing/fake-io.ts';
import { playThenEnd } from './testing/deck-sim.ts';
import { lineProblems } from './testing/spec-lines.ts';
import { evenWords, synthPassage } from './testing/synth.ts';
import { packetLines, statusLine, tapLinesOf, validationLine } from './testing/tap-synth.ts';
import { END_WAIT_MS } from './worker-core.ts';

const D1_SETUP = { params: {}, sign: 1, variant: 'D1' } as const;

function stamp(w: WiredWorker, line: Record<string, unknown>): void {
  w.deck({ k: 'stamp', line });
}

function chunk(w: WiredWorker, n0: number, frames = 9_600): void {
  w.deck({ k: 'chunk', n0, frames, ch0: new Float32Array(frames), ch1: new Float32Array(frames) });
}

function pkts(w: WiredWorker): PktMessage[] {
  return w.port.posted as PktMessage[];
}

function expectSpecLines(w: WiredWorker): void {
  expect(lineProblems('stamps.jsonl', w.session.lines('stamp'))).toEqual([]);
  expect(lineProblems('detector_in.jsonl', w.session.lines('det'))).toEqual([]);
  expect(lineProblems('events.jsonl', w.session.lines('event'))).toEqual([]);
}

describe('worker: /session frames (docs/protocol.md)', () => {
  it('sends hello, then consent, then the rest; frames wait for the socket and for consent', () => {
    const w = wiredWorker({ mode: 'gate', tapUrl: TAP_URL }, { open: false, consent: false });
    stamp(w, { n: 0, k: 'mark', what: 'step', name: 'a' });
    w.deck({ k: 'chunk', n0: 0, frames: 2, ch0: new Float32Array([1, 2]), ch1: new Float32Array([3, 4]) });
    expect(w.session.sent).toEqual([]);
    w.session.open();
    expect(w.session.json().map((f) => f.t)).toEqual(['hello']);
    w.worker.onMainMessage({ k: 'consent', at: '2026-11-12T10:00:00.000Z' });
    expect(w.session.binaryType).toBe('arraybuffer');
    expect(w.session.json()).toEqual([
      { t: 'hello', ua: 'test-agent', settings: { sampleRate: 48_000 } },
      { t: 'consent', at: '2026-11-12T10:00:00.000Z' },
      { t: 'stamp', line: { n: 0, k: 'mark', what: 'step', name: 'a' } },
    ]);
    expect(w.session.sent[3]).toBeInstanceOf(ArrayBuffer);
    expect(decodeChunkFrame(w.session.sent[3] as ArrayBuffer)).toEqual({ frames: 2, n0: 0, ch0: new Float32Array([1, 2]), ch1: new Float32Array([3, 4]) });
  });

  it('a packet line becomes a batch line with the same digits, after one pkt to Deck; other tap lines are no input', () => {
    const w = wiredWorker({ mode: 'session', tapUrl: TAP_URL, detector: D1_SETUP });
    const raw =
      '{"seq":5417,"k":"m","tArrNs":"812345678901234","tsCbUs":1794935111156789,"tr":[[1794935111123456,-0.4000000059604645]],' +
      '"talk":[[1794935111123456,0]],"g":0.031746031746031744,"hm":0.0021,"lm":{"ts":1794935111123456,"reset":0,"p":[[640.2,402.1]]}}';
    w.tap?.receive(raw);
    w.tap?.receive({ seq: 5418, k: 'f', tArrNs: '1', tsCbUs: 1, sent: true });
    w.tap?.receive({ seq: 5419, k: 'e', tArrNs: '1', code: 5, name: 'kNetworkError', message: 'x', retryable: true });
    w.tap?.receive({ k: 'l', tArrNs: '1', p50Ms: 0.1, p99Ms: 0.4, maxMs: 1 });
    w.tap?.receive({ seq: 5420, k: 'm', tr: [[1794935111156789, 0.25]] });
    w.tap?.receive('not json');
    w.tap?.receive({ seq: -3, k: 'm', tr: [] });
    expect(pkts(w)).toEqual([{ k: 'pkt', seq: 5417, hold: false }, { k: 'pkt', seq: 5420, hold: false }]);
    expect(w.session.lineTexts('det')).toEqual([
      '{"k":"batch","seq":5417,"tr":[[1794935111123456,-0.4000000059604645]],"talk":[[1794935111123456,0]],"g":0.031746031746031744,"hm":0.0021}',
      '{"k":"batch","seq":5420,"tr":[[1794935111156789,0.25]],"talk":[],"g":null,"hm":null}',
    ]);
    expect(w.toMain.filter((m) => m.k === 'error')).toHaveLength(2);
    expectSpecLines(w);
  });

  it('keeps detector inputs in arrival order: val, voice, batch, state', () => {
    const w = wiredWorker({ mode: 'session', tapUrl: TAP_URL, detector: D1_SETUP });
    w.tap?.receive(validationLine(1, 0));
    stamp(w, { n: 128, k: 'voice', on: true });
    w.tap?.receive(packetLines(0, 1, 2)[0]);
    stamp(w, { n: 256, k: 'state', s: 'listening' });
    expect(w.session.lines('det')).toEqual([
      { k: 'val', seq: 1, code: 0 },
      { k: 'voice', n: 128, on: true },
      batchFromTapLine(packetLines(0, 1, 2)[0] as Record<string, unknown>),
      { k: 'state', n: 256, s: 'listening' },
    ]);
    expectSpecLines(w);
  });

  it('turns hold and resume stamps into events; why comes from the state before resume', () => {
    const w = wiredWorker({ mode: 'spacebar' });
    expect(w.tap).toBeUndefined();
    const s = (n: number, st: string) => stamp(w, { n, k: 'state', s: st });
    s(0, 'narrating');
    stamp(w, { n: 100, k: 'hold', cause: 'key', nSilent: 484, word: 0 });
    s(100, 'hold_wait');
    s(72_484, 'resume');
    stamp(w, { n: 72_484, k: 'resume', word: 0 });
    s(72_484, 'narrating');
    stamp(w, { n: 80_000, k: 'voice', on: true });
    stamp(w, { n: 92_000, k: 'hold', cause: 'voice', nSilent: 92_384, word: 4 });
    s(92_000, 'listening');
    stamp(w, { n: 150_000, k: 'voice', on: false });
    s(150_000, 'resume');
    stamp(w, { n: 150_000, k: 'resume', word: 4 });
    s(150_000, 'narrating');
    expect(w.session.lines('event')).toEqual([
      { n: 100, e: 'hold', cause: 'key', nCmd: 100, nSilent: 484, word: 0 },
      { n: 72_484, e: 'resume', word: 0, why: 'timeout' },
      { n: 92_000, e: 'hold', cause: 'voice', nCmd: 92_000, nSilent: 92_384, word: 4 },
      { n: 150_000, e: 'resume', word: 4, why: 'voice_off' },
    ]);
    // Key mode has no camera: no detector inputs.
    expect(w.session.lines('det')).toEqual([]);
    expectSpecLines(w);
  });

  it('writes page events at the worker sample (null before audio) in the 8.1 key order', () => {
    const w = wiredWorker({ mode: 'gate' });
    w.worker.onMainMessage({ k: 'event', e: 'devicechange', hard: true });
    stamp(w, { n: 4_096, k: 'mark', what: 'step', name: 'x' });
    w.worker.onMainMessage({ k: 'event', e: 'gain', hard: false, value: 0.5, db: -6, final: true });
    w.worker.onMainMessage({ k: 'event', e: 'visibilitychange', hard: true, state: 'hidden', n: 1 });
    w.worker.onMainMessage({ k: 'event', e: 'preflight_ok', hard: false });
    w.worker.onMainMessage({ k: 'event', e: 'fire', hard: false });
    w.worker.onMainMessage({ k: 'event', e: 'vad', hard: false });
    w.worker.onMainMessage({ k: 'event', e: 'detector_sign', hard: false });
    w.worker.onMainMessage({ k: 'event', e: 'Bad Name', hard: false });
    expect(w.session.lineTexts('event')).toEqual([
      '{"n":null,"e":"devicechange","hard":true}',
      '{"n":4096,"e":"gain","value":0.5,"db":-6,"final":true,"hard":false}',
      '{"n":4096,"e":"visibilitychange","state":"hidden","hard":true}',
      '{"n":4096,"e":"preflight_ok","hard":false}',
    ]);
    expect(w.toMain.filter((m) => m.k === 'error')).toHaveLength(4);
    expectSpecLines(w);
  });

  it('passes host abort, tap status and quickcheck to the page', () => {
    const w = wiredWorker({ mode: 'gate', tapUrl: TAP_URL });
    w.session.receive({ t: 'tap', status: 'starting' });
    w.session.receive({ t: 'tap', status: 'starting' });
    w.session.receive({ t: 'tap', status: 'bogus' });
    w.session.receive({ t: 'abort', reason: 'tap_lost' });
    w.session.receive({ t: 'saved', sessionId: 's1', unusable: true, reasons: ['tap_lost'] });
    w.session.receive({ t: 'quickcheck', ok: false, text: 'RE-RECORD NOW: tap_lost' });
    w.session.receive({ t: 'quickcheck', ok: null, text: null });
    w.session.receive('not json');
    expect(w.toMain).toEqual([
      { k: 'sdk', tap: 'starting', ok: false },
      { k: 'abort', reason: 'tap_lost' },
      { k: 'quickcheck', ok: false, text: 'RE-RECORD NOW: tap_lost' },
      { k: 'quickcheck', ok: null, text: null },
    ]);
    // The worker never stops Deck itself: the page sends {k:'stop'} (docs/protocol.md).
    expect(w.port.posted).toEqual([]);
  });

  it('ends /session after Deck reports its last block: {t:end}, then {k:closed}', () => {
    const w = wiredWorker({ mode: 'gate' });
    w.worker.onMainMessage({ k: 'end', reason: 'stop' });
    expect(w.session.json().some((f) => f.t === 'end')).toBe(false);
    expect(w.timers.map((t) => t.ms)).toEqual([END_WAIT_MS]);
    chunk(w, 0, 3);
    stamp(w, { n: 3, k: 'state', s: 'idle' });
    w.deck({ k: 'done', n: 3 });
    const frames = w.session.sent.map((f) => (typeof f === 'string' ? (JSON.parse(f) as { t: string }).t : 'audio'));
    expect(frames).toEqual(['hello', 'consent', 'audio', 'stamp', 'end']);
    expect(w.session.json().at(-1)).toEqual({ t: 'end', reason: 'stop' });
    expect(w.toMain.at(-1)).toEqual({ k: 'closed' });
    w.worker.onMainMessage({ k: 'end', reason: 'stop' });
    w.timers[0]?.fn();
    expect(w.session.json().filter((f) => f.t === 'end')).toHaveLength(1);
    expect(w.toMain.filter((m) => m.k === 'closed')).toHaveLength(1);
    // {t:'end'} stays the last frame.
    chunk(w, 3, 3);
    w.worker.onMainMessage({ k: 'event', e: 'blur', hard: false });
    expect(w.session.sent.length).toBe(frames.length);
  });

  it('takes no tap line as input after Deck reported its last sample', () => {
    const w = wiredWorker({ mode: 'session', tapUrl: TAP_URL, detector: D1_SETUP });
    w.tap?.receive(packetLines(0, 1, 1)[0]);
    w.deck({ k: 'done', n: 9_600 });
    w.tap?.receive(packetLines(1, 2, 2)[0]);
    w.tap?.receive(validationLine(3, 0));
    expect(pkts(w).map((p) => p.seq)).toEqual([1]);
    expect(w.session.lines('det').map((d) => d.seq)).toEqual([1]);
  });

  it('ends at once when Deck finished first, and after the fallback wait when Deck is gone', () => {
    const a = wiredWorker({ mode: 'gate' });
    a.deck({ k: 'done', n: 0 });
    a.worker.onMainMessage({ k: 'end', reason: 'done' });
    expect(a.session.json().at(-1)).toEqual({ t: 'end', reason: 'done' });
    expect(a.timers).toEqual([]);
    const b = wiredWorker({ mode: 'gate' });
    b.worker.onMainMessage({ k: 'end', reason: 'abort' });
    expect(b.toMain).toEqual([]);
    b.timers[0]?.fn();
    expect(b.session.json().at(-1)).toEqual({ t: 'end', reason: 'abort' });
    expect(b.toMain).toEqual([{ k: 'closed' }]);
  });

  it("writes Deck's voice detector parameters as a vad line of events.jsonl (spec 7.3)", () => {
    const w = wiredWorker({ mode: 'session' });
    const params = vadFrozenBlock({ floorDb: -45 });
    w.deck({ k: 'vad', n: 0, source: 'options', note: 'frozen + doctor floor', params });
    w.deck({ k: 'vad', n: 96_000, source: 'message', params: vadFrozenBlock(DEFAULT_VAD_PARAMS) });
    w.deck({ k: 'vad', n: 1, source: 'bogus', params });
    w.deck({ k: 'vad', n: 2, source: 'default' });
    expect(w.session.lines('event')).toEqual([
      { n: 0, e: 'vad', source: 'options', note: 'frozen + doctor floor', params },
      { n: 96_000, e: 'vad', source: 'message', params: vadFrozenBlock(DEFAULT_VAD_PARAMS) },
    ]);
    expect(w.session.lineTexts('event')[0]).toMatch(/^\{"n":0,"e":"vad","source":"options","note":"frozen \+ doctor floor","params":\{"highpass_hz":150,/);
    expectSpecLines(w);
  });

  it('a /tap socket that closes or is refused during the run: an error and sdk ok:false with the note', () => {
    const w = wiredWorker({ mode: 'session', tapUrl: TAP_URL, detector: D1_SETUP }, { open: false });
    w.tap?.close(); // refused before it opened (token, Origin, a second client)
    expect(w.toMain).toEqual([
      { k: 'sdk', tap: 'stopped', ok: false, note: TAP_SOCKET_CLOSED_NOTE },
      { k: 'error', message: 'worker: /tap closed before the end of the run' },
    ]);
    // Running with kOk can no longer make it ok.
    const v = wiredWorker({ mode: 'session', tapUrl: TAP_URL, detector: D1_SETUP });
    v.session.receive({ t: 'tap', status: 'running' });
    v.tap?.receive(statusLine(1, 'kRunning'));
    v.tap?.receive(validationLine(2, 0));
    v.tap?.close();
    for (let n0 = 0; n0 < 9_600 * 30; n0 += 9_600) chunk(v, n0);
    expect(v.toMain.filter((m) => m.k === 'sdk').at(-1)).toEqual({ k: 'sdk', tap: 'running', ok: false, note: TAP_SOCKET_CLOSED_NOTE });
    expect(v.toMain.filter((m) => m.k === 'sdk' && m.ok)).toEqual([]);
  });

  it('no /tap error once the run ends, after Deck is done, after host abort, or after host said tap stopped', () => {
    const cases: Array<(w: WiredWorker) => void> = [
      (w) => w.worker.onMainMessage({ k: 'end', reason: 'stop' }),
      (w) => w.deck({ k: 'done', n: 0 }),
      (w) => w.session.receive({ t: 'abort', reason: 'tap_lost' }),
      (w) => {
        w.session.receive({ t: 'tap', status: 'running' });
        w.session.receive({ t: 'tap', status: 'stopped' });
      },
    ];
    for (const before of cases) {
      const w = wiredWorker({ mode: 'session', tapUrl: TAP_URL, detector: D1_SETUP });
      before(w);
      w.tap?.close();
      expect(w.toMain.filter((m) => m.k === 'error')).toEqual([]);
      expect(w.toMain.some((m) => m.k === 'sdk' && m.note === TAP_SOCKET_CLOSED_NOTE)).toBe(false);
    }
  });

  it('reports /session closing before the end of the run', () => {
    const w = wiredWorker({ mode: 'gate' });
    w.session.close();
    expect(w.toMain).toEqual([{ k: 'error', message: 'worker: /session closed before the end of the run' }]);
  });
});

describe('worker: SDK readiness (spec 7.1)', () => {
  it('ok once Running with kOk held 5 s on the sample clock; another code restarts the hold and names the note', () => {
    const w = wiredWorker({ mode: 'gate', tapUrl: TAP_URL });
    w.session.receive({ t: 'tap', status: 'starting' });
    chunk(w, 0); // clock 9600
    w.tap?.receive(statusLine(1, 'kStarting'));
    w.tap?.receive(validationLine(2, 0));
    w.tap?.receive(statusLine(3, 'kRunning')); // Running with kOk since 9600
    w.session.receive({ t: 'tap', status: 'running' });
    for (let n0 = 9_600; n0 < 9_600 * 25; n0 += 9_600) chunk(w, n0); // clock 240000
    expect(w.toMain.filter((m) => m.k === 'sdk' && m.ok)).toEqual([]);
    chunk(w, 240_000); // clock 249600 = 9600 + 240000
    expect(w.toMain.at(-1)).toEqual({ k: 'sdk', tap: 'running', ok: true });
    w.tap?.receive(validationLine(4, 1));
    expect(w.toMain.at(-1)).toEqual({ k: 'sdk', tap: 'running', ok: false, note: 'kNoFaceFound' });
    w.tap?.receive(validationLine(5, 0)); // kOk again since 249600
    expect(w.toMain.at(-1)).toEqual({ k: 'sdk', tap: 'running', ok: false });
    for (let n0 = 249_600; n0 < 489_600; n0 += 9_600) chunk(w, n0); // clock 489600
    expect(w.toMain.at(-1)).toEqual({ k: 'sdk', tap: 'running', ok: true });
    expect(w.toMain).toEqual([
      { k: 'sdk', tap: 'starting', ok: false },
      { k: 'sdk', tap: 'running', ok: false },
      { k: 'sdk', tap: 'running', ok: true },
      { k: 'sdk', tap: 'running', ok: false, note: 'kNoFaceFound' },
      { k: 'sdk', tap: 'running', ok: false },
      { k: 'sdk', tap: 'running', ok: true },
    ]);
  });

  it('reads Running from the name or, without one, from code 3', () => {
    expect(['kRunning', 'Running'].map((n) => isRunningStatus(n))).toEqual([true, true]);
    expect(['kStarting', 'kRunningX', ''].map((n) => isRunningStatus(n))).toEqual([false, false, false]);
    expect([isRunningStatus(undefined, 3), isRunningStatus(undefined, 2), isRunningStatus('kIdle', 3)]).toEqual([true, false, false]);
  });
});

// A session whose D1 fires once, at the steep inhale at 70 s (core/detector/synth.ts).
const SYNTH = { seed: 2, durationS: 80, ratePerMin: 20, objections: [{ atS: 70, voice: false }], vals: [{ atS: 30, code: 0 }] };

function runSynthWithFakeDeck(config: Parameters<typeof wiredWorker>[0]) {
  const ses = synthSession(SYNTH);
  const w = wiredWorker(config);
  stamp(w, { n: 0, k: 'state', s: 'narrating' });
  for (const line of tapLinesOf(ses.inputs)) {
    w.tap?.receive(line);
    if (line.k === 'm') stamp(w, { n: ses.nArrBySeq.get(line.seq) as number, k: 'arr', seq: line.seq });
  }
  return { ses, w };
}

describe('worker: step() on every input (spec 7.3, 7.4)', () => {
  it('live: the fired packet gets hold:true; fire and armed carry nArr; replay gives the same fires', () => {
    const { ses, w } = runSynthWithFakeDeck({ mode: 'session', tapUrl: TAP_URL, detector: D1_SETUP });
    const held = pkts(w).filter((p) => p.hold);
    expect(held).toHaveLength(1);
    const events = w.session.lines('event');
    const fires = events.filter((e) => e.e === 'fire');
    expect(fires.map((f) => f.seq)).toEqual(held.map((p) => p.seq));
    const fire = fires[0] as { n: number; seq: number; v: number; theta: number; det: string };
    expect(fire.n).toBe(ses.nArrBySeq.get(fire.seq));
    expect(fire.det).toBe('D1');
    expect(fire.v).toBeGreaterThanOrEqual(fire.theta);
    const armed = events.filter((e) => e.e === 'armed');
    expect(armed[0]).toMatchObject({ e: 'armed', det: 'D1', on: true });
    for (const a of armed) expect([...ses.nArrBySeq.values()]).toContain(a.n);
    const det = w.session.lines('det') as unknown as DetectorInput[];
    expect(det.filter((d) => d.k === 'val')).toEqual([{ k: 'val', seq: expect.any(Number), code: 0 }]);
    expect(replayFires(D1_SETUP, det)).toEqual(fires.map((f) => ({ seq: f.seq, v: f.v, theta: f.theta })));
    expectSpecLines(w);
  });

  it('gate and live-sim: step() runs with preliminary parameters; hold stays false and no answer is written', () => {
    for (const mode of ['gate', 'live-sim']) {
      const { w } = runSynthWithFakeDeck({ mode, tapUrl: TAP_URL, detector: { params: { k: 9 }, sign: -1, variant: 'D3' } });
      expect(w.worker.detector).toEqual(PRELIMINARY_DETECTOR);
      expect(pkts(w).length).toBeGreaterThan(2_000);
      expect(pkts(w).every((p) => p.hold === false)).toBe(true);
      expect(w.session.lines('event')).toEqual([]);
      // The answers existed: the same inputs replayed do fire.
      expect(replayFires(PRELIMINARY_DETECTOR, w.session.lines('det') as unknown as DetectorInput[])).toHaveLength(1);
      expectSpecLines(w);
    }
  });

  it('takes the sign from calib.polarity when config.detector has none; rejects a bad setup', () => {
    expect(detectorChoice({ calib: { polarity: { sign: -1 } } })).toEqual({ params: {}, sign: -1, variant: 'D1' });
    expect(detectorChoice({ detector: { sign: 1, variant: 'D3' }, calib: { polarity: { sign: -1 } } })).toEqual({ params: {}, sign: 1, variant: 'D3' });
    expect(() => detectorChoice({ detector: { sign: 2 } })).toThrow(/sign/);
    expect(() => detectorChoice({ detector: { variant: 'D2' } })).toThrow(/variant/);
    expect(() => detectorChoice({ detector: { params: 'frozen' } })).toThrow(/params/);
    const w = wiredWorker({ mode: 'session', tapUrl: TAP_URL, detector: { sign: 0 } });
    expect(w.toMain).toEqual([{ k: 'error', message: expect.stringMatching(/detector setup failed/) }]);
    w.tap?.receive(packetLines(0, 1, 7)[0]);
    expect(pkts(w)).toEqual([{ k: 'pkt', seq: 7, hold: false }]);
    expect(w.session.lines('det')).toHaveLength(1);
  });
});

/**
 * The synthetic session through a worker with arr stamps from a fake Deck; the narrator first
 * reads at readFromN (`beforeReading` runs just before). Packets from skipArrFrom on get no arr.
 */
function runSynth(w: WiredWorker, opts: { readFromN: number; beforeReading?: () => void; skipArrFrom?: number }) {
  const ses = synthSession(SYNTH);
  let reading = false;
  let nKnown: number | null = null;
  for (const line of tapLinesOf(ses.inputs)) {
    const nArr = line.k === 'm' ? (ses.nArrBySeq.get(line.seq) as number) : null;
    if (!reading && nArr !== null && nArr >= opts.readFromN) {
      reading = true;
      opts.beforeReading?.();
      stamp(w, { n: opts.readFromN, k: 'state', s: 'narrating' });
      nKnown = opts.readFromN;
    }
    w.tap?.receive(line);
    if (nArr !== null && (opts.skipArrFrom === undefined || nArr < opts.skipArrFrom)) {
      stamp(w, { n: nArr, k: 'arr', seq: line.seq });
      nKnown = nArr;
    }
  }
  return { ses, nKnown };
}

describe('worker: the trace sign of the run (spec 7.4, 7.11)', () => {
  const READ_FROM = 20 * 48_000;
  const fired = (w: WiredWorker) => w.session.lines('event').filter((e) => e.e === 'fire').map((f) => ({ seq: f.seq, v: f.v, theta: f.theta }));

  it('{k:detector, sign} before reading restarts step() on the inputs so far: replay with that sign gives the same fires', () => {
    const w = wiredWorker({ mode: 'session', tapUrl: TAP_URL, detector: { params: {}, sign: -1, variant: 'D1' } });
    let nAtSign: number | null = null;
    runSynth(w, {
      readFromN: READ_FROM,
      beforeReading: () => {
        nAtSign = (w.session.lines('stamp').at(-1)?.n as number | undefined) ?? null;
        w.worker.onMainMessage({ k: 'detector', sign: 1 });
      },
    });
    expect(w.worker.detector).toEqual({ params: {}, sign: 1, variant: 'D1' });
    const det = w.session.lines('det') as unknown as DetectorInput[];
    const live = fired(w);
    expect(live).toHaveLength(1);
    expect(replayFires({ params: {}, sign: 1, variant: 'D1' }, det)).toEqual(live);
    // With the stored sign the same inputs would not give these fires.
    expect(replayFires({ params: {}, sign: -1, variant: 'D1' }, det)).not.toEqual(live);
    expect(w.session.lines('event').filter((e) => e.e === 'detector_sign')).toEqual([{ n: nAtSign, e: 'detector_sign', det: 'D1', sign: 1 }]);
    expect(pkts(w).filter((p) => p.hold).map((p) => p.seq)).toEqual(live.map((f) => f.seq));
    expect(w.toMain.filter((m) => m.k === 'error')).toEqual([]);
    expectSpecLines(w);
  });

  it('refuses a sign after reading started, a sign other than 1 or -1, and a sign without a live detector', () => {
    const w = wiredWorker({ mode: 'session', tapUrl: TAP_URL, detector: D1_SETUP });
    w.worker.onMainMessage({ k: 'detector', sign: 2 });
    stamp(w, { n: 0, k: 'state', s: 'narrating' });
    w.worker.onMainMessage({ k: 'detector', sign: -1 });
    const g = wiredWorker({ mode: 'gate', tapUrl: TAP_URL, detector: D1_SETUP });
    g.worker.onMainMessage({ k: 'detector', sign: -1 });
    expect([...w.toMain, ...g.toMain].filter((m) => m.k === 'error').map((m) => (m as { message: string }).message)).toEqual([
      'worker: the trace sign must be 1 or -1, got 2',
      'worker: the trace sign must come before reading starts',
      'worker: a trace sign needs a live run with a detector',
    ]);
    expect(w.worker.detector?.sign).toBe(1);
    expect(w.session.lines('event').filter((e) => e.e === 'detector_sign')).toEqual([]);
  });

  it('headstart: no stop and no answer until the page sets the sign; reading without one is an error', () => {
    // The stored sign is not used in headstart (spec 7.11): without the page's sign, nothing stops the narrator.
    const a = wiredWorker({ mode: 'headstart', tapUrl: TAP_URL, detector: D1_SETUP });
    runSynth(a, { readFromN: READ_FROM });
    expect(pkts(a).length).toBeGreaterThan(2_000);
    expect(pkts(a).every((p) => p.hold === false)).toBe(true);
    expect(a.session.lines('event')).toEqual([]);
    expect(a.toMain.filter((m) => m.k === 'error')).toEqual([{ k: 'error', message: expect.stringMatching(/^worker: no trace sign before reading started/) }]);
    // With the page's sign before reading, the run is a live one.
    const b = wiredWorker({ mode: 'headstart', tapUrl: TAP_URL, detector: D1_SETUP });
    runSynth(b, { readFromN: READ_FROM, beforeReading: () => b.worker.onMainMessage({ k: 'detector', sign: 1 }) });
    const live = fired(b);
    expect(live).toHaveLength(1);
    expect(replayFires(D1_SETUP, b.session.lines('det') as unknown as DetectorInput[])).toEqual(live);
    expect(pkts(b).filter((p) => p.hold).map((p) => p.seq)).toEqual(live.map((f) => f.seq));
    expect(b.toMain.filter((m) => m.k === 'error')).toEqual([]);
    expectSpecLines(b);
  });
});

describe('worker: events of packets Deck never stamped (spec 6.3, 8.1)', () => {
  it('drops fire and armed lines of a packet without arr at the end of the run', () => {
    const ref = wiredWorker({ mode: 'session', tapUrl: TAP_URL, detector: D1_SETUP });
    runSynth(ref, { readFromN: 0 });
    const fire = ref.session.lines('event').find((e) => e.e === 'fire') as { seq: number; n: number };
    expect(fire).toBeDefined();
    // Deck's last quantum came before the fired packet: no arr from that packet on.
    const w = wiredWorker({ mode: 'session', tapUrl: TAP_URL, detector: D1_SETUP });
    const { nKnown } = runSynth(w, { readFromN: 0, skipArrFrom: fire.n });
    expect(pkts(w).filter((p) => p.hold).map((p) => p.seq)).toEqual([fire.seq]);
    w.deck({ k: 'done', n: nKnown });
    w.worker.onMainMessage({ k: 'end', reason: 'done' });
    const events = w.session.lines('event');
    expect(events.filter((e) => e.e === 'fire')).toEqual([]);
    // Every armed line carries the nArr of its packet (or the n of a Deck line), never the end sample.
    const arrNs = new Set(w.session.lines('stamp').map((s) => s.n));
    for (const a of events.filter((e) => e.e === 'armed')) expect(arrNs.has(a.n)).toBe(true);
    expect(events).toEqual(ref.session.lines('event').filter((e) => (e.n as number) < fire.n));
    expect(w.session.json().at(-1)).toEqual({ t: 'end', reason: 'done' });
    expectSpecLines(w);
  });
});

describe('worker + Deck: a live run (spec 6.2, 7.3, 7.4)', () => {
  it('the fire stops the narrator at nCmd = nArr; replaying detector_in gives the same fires; audio blocks are contiguous', () => {
    const ses = synthSession(SYNTH);
    const words = evenWords(105, 500, 300);
    const pcm = synthPassage(words, 84_500);
    const w = wiredWorker({ mode: 'session', tapUrl: TAP_URL, detector: D1_SETUP });
    // Asynchronous ports: messages wait for the next turn between quanta.
    const fromDeck: DeckToWorker[] = [];
    const deck = new DeckCore(
      { mode: 'live', makeVad: () => ({ push: () => [] }), clickOffsetsSamples: [0], clickWaveform: new Float32Array(1) },
      { toMain: () => {}, toWorker: (m) => fromDeck.push(m) },
    );
    deck.onMainMessage({ k: 'load', name: 'p', pcm, timings: words });
    deck.onMainMessage({ k: 'scenario', steps: playThenEnd('p', { untilClipEnd: true }) });
    // Packets arrive in the order of the session at their recorded nArr, moved 19.8 s earlier.
    const lead = 20 * 48_000 - 9_600;
    const lines = tapLinesOf(ses.inputs);
    const at = lines.map((l) => (l.k === 'm' ? (ses.nArrBySeq.get(l.seq) as number) - lead : -1));
    for (let i = 1; i < at.length; i++) if ((at[i] as number) < 0) at[i] = at[i - 1] as number;
    let next = 0;
    let doneN = -1;
    const input = new Float32Array(128);
    const out = new Float32Array(128);
    while (!deck.isDone) {
      for (const m of w.port.posted.splice(0)) deck.onWorkerMessage(m as PktMessage);
      deck.process(input, [out], 128);
      for (const m of fromDeck.splice(0)) {
        if (m.k === 'done') doneN = m.n;
        w.deck(m);
      }
      while (next < lines.length && (at[next] as number) <= deck.n) w.tap?.receive(lines[next++]);
    }
    w.worker.onMainMessage({ k: 'end', reason: 'done' });

    const stamps = w.session.lines('stamp');
    const events = w.session.lines('event');
    const det = w.session.lines('det') as unknown as DetectorInput[];
    const fires = events.filter((e) => e.e === 'fire');
    expect(fires).toHaveLength(1);
    expect(replayFires(D1_SETUP, det)).toEqual(fires.map((f) => ({ seq: f.seq, v: f.v, theta: f.theta })));
    const fire = fires[0] as { n: number; seq: number };
    const arr = new Map(stamps.filter((s) => s.k === 'arr').map((s) => [s.seq as number, s.n as number]));
    expect(fire.n).toBe(arr.get(fire.seq));
    // Every packet reached Deck once; the fired one stopped it in the quantum it was handled.
    const batches = det.filter((d) => d.k === 'batch').map((d) => (d as { seq: number }).seq);
    expect(batches.length).toBe(lines.filter((l) => l.k === 'm').length);
    expect(batches.every((s) => arr.has(s))).toBe(true);
    expect(stamps.filter((s) => s.k === 'hold')).toEqual([{ n: fire.n, k: 'hold', cause: 'chest', seq: fire.seq, nSilent: fire.n + 384, word: expect.any(Number) }]);
    const hold = events.find((e) => e.e === 'hold') as { word: number };
    expect(events.filter((e) => e.e === 'hold' || e.e === 'resume')).toEqual([
      { n: fire.n, e: 'hold', cause: 'chest', nCmd: fire.n, nSilent: fire.n + 384, word: hold.word },
      { n: fire.n + 384 + 72_000, e: 'resume', word: hold.word, why: 'timeout' },
    ]);
    // Deck's states reached step() in order.
    const states = det.filter((d) => d.k === 'state').map((d) => (d as { s: string }).s);
    expect(states).toEqual(['narrating', 'hold_wait', 'resume', 'narrating', 'idle']);
    // Audio: contiguous blocks up to Deck's last sample, then the end frame.
    const blocks = w.session.binary().map((b) => decodeChunkFrame(b));
    let n0 = 0;
    for (const b of blocks) {
      expect(b.n0).toBe(n0);
      n0 += b.frames;
    }
    expect(n0).toBe(doneN);
    expect(w.session.json().at(-1)).toEqual({ t: 'end', reason: 'done' });
    expect(w.toMain.at(-1)).toEqual({ k: 'closed' });
    expectSpecLines(w);
  });
});
