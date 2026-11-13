import { describe, expect, it } from 'vitest';
import { secondsToSamples, type Step } from '../scenarios/format.ts';
import { buildDoctorLevelScenario } from '../scenarios/doctor.ts';
import { scenarioFor, timingsNameFor } from '../scenarios/index.ts';
import { dbToGain } from './levels.ts';
import type { ToDeck, ToWorker } from './messages.ts';
import { FailureLatch, isFatalWorkerError, processorErrorText, RunController, sdkNote, type RunView } from './run.ts';

const S = secondsToSamples;

/** A view that records what it was asked to show. */
function fakeView() {
  const shown = {
    prompt: [] as string[],
    note: '' as string,
    dot: false,
    bar: null as string | null,
    button: null as string | null,
    levels: false,
    status: null as string | null,
    recording: false,
  };
  const view: RunView = {
    prompt: (t) => shown.prompt.push(t),
    bar: (m) => void (shown.bar = m),
    dot: (on) => void (shown.dot = on),
    note: (t) => void (shown.note = t),
    waitButton: (label) => void (shown.button = label),
    levels: (visible) => void (shown.levels = visible),
    status: (t) => void (shown.status = t),
    meters: () => {},
    recording: (on) => void (shown.recording = on),
  };
  return { shown, view };
}

function setup(steps: Step[], clockS: () => number = () => 0) {
  const { shown, view } = fakeView();
  const deck: ToDeck[] = [];
  const worker: ToWorker[] = [];
  const hooks = {
    done: [] as number[],
    aborted: [] as string[],
    failed: [] as Array<[string, string]>,
    closed: 0,
    verdicts: [] as Array<[boolean | null, string | null]>,
  };
  const c = new RunController(
    steps,
    view,
    { toDeck: (m) => deck.push(m), toWorker: (m) => worker.push(m) },
    {
      done: (n) => hooks.done.push(n),
      aborted: (r) => hooks.aborted.push(r),
      failed: (reason, detail) => hooks.failed.push([reason, detail]),
      closed: () => void (hooks.closed += 1),
      verdict: (ok, text) => hooks.verdicts.push([ok, text]),
    },
    -12,
    clockS,
  );
  return { c, shown, deck, worker, hooks };
}

const GATE_HEAD: Step[] = [
  { k: 'wait', name: 'sdk_start', text: 'Starting camera...', lenSamples: 0, until: 'sdk_ok' },
  { k: 'prompt', name: 'deep_1_in', text: 'Breathe in', lenSamples: S(2), bar: 'grow' },
  { k: 'cue', name: 'cue_1_on', text: '', lenSamples: S(1.5), i: 1, on: true },
  { k: 'cue', name: 'cue_1_off', text: '', lenSamples: 0, i: 1, on: false },
  { k: 'end', name: 'end', text: 'Recording finished', lenSamples: 0 },
];

describe('RunController: the page draws what Deck reports and only releases waits (spec 6.1, 7.3)', () => {
  it('holds the SDK wait until the worker reports Running with kOk held, then sends one go', () => {
    const { c, shown, deck } = setup(GATE_HEAD);
    expect(shown.recording).toBe(true);
    c.handleDeck({ k: 'step', n: 0, name: 'sdk_start', text: 'Starting camera...' });
    expect(shown.prompt.at(-1)).toBe('Starting camera...');
    c.handleWorker({ k: 'sdk', tap: 'running', ok: false, note: 'kChestNotVisible' });
    expect(shown.note).toMatch(/^Chest not visible/);
    expect(deck).toEqual([]);
    c.handleWorker({ k: 'sdk', tap: 'running', ok: true });
    c.handleWorker({ k: 'sdk', tap: 'running', ok: true });
    expect(deck).toEqual([{ k: 'go' }]);
    expect(shown.note).toBe('');
  });

  it('sends go at once when the SDK was ready before the wait step started', () => {
    const { c, deck } = setup(GATE_HEAD);
    c.handleWorker({ k: 'sdk', tap: 'running', ok: true });
    expect(deck).toEqual([]);
    c.handleDeck({ k: 'step', n: 0, name: 'sdk_start', text: 'Starting camera...' });
    expect(deck).toEqual([{ k: 'go' }]);
  });

  it('shows the deep-breath bar, the dot on cue, and ends the run on done', () => {
    const { c, shown, worker, hooks } = setup(GATE_HEAD);
    c.handleDeck({ k: 'step', n: 10, name: 'deep_1_in', text: 'Breathe in' });
    expect(shown.bar).toBe('grow');
    c.handleDeck({ k: 'cue', n: 20, on: true });
    expect(shown.dot).toBe(true);
    c.handleDeck({ k: 'cue', n: 30, on: false });
    expect(shown.dot).toBe(false);
    c.handleDeck({ k: 'step', n: 40, name: 'end', text: 'Recording finished' });
    c.handleDeck({ k: 'done', n: 40 });
    expect(worker).toEqual([{ k: 'end', reason: 'done' }]);
    expect(hooks.done).toEqual([40]);
    c.handleWorker({ k: 'closed' });
    c.handleWorker({ k: 'quickcheck', ok: false, text: 'RE-RECORD NOW: loop check B not found' });
    expect(hooks.closed).toBe(1);
    expect(hooks.verdicts).toEqual([[false, 'RE-RECORD NOW: loop check B not found']]);
  });

  it('Stop sends stop to Deck and end to the worker once; abort ends with abort', () => {
    const a = setup(GATE_HEAD);
    a.c.stop();
    a.c.stop();
    a.c.handleDeck({ k: 'done', n: 5 });
    expect(a.deck).toEqual([{ k: 'stop' }]);
    expect(a.worker).toEqual([{ k: 'end', reason: 'stop' }]);
    expect(a.c.endedBy).toBe('stop');
    const b = setup(GATE_HEAD);
    b.c.handleWorker({ k: 'abort', reason: 'tap_lost' });
    expect(b.deck).toEqual([{ k: 'stop' }]);
    expect(b.worker).toEqual([{ k: 'end', reason: 'abort' }]);
    expect(b.hooks.aborted).toEqual(['tap_lost']);
  });

  it('keeps the recording indicator while the microphone or the camera runs', () => {
    const { c, shown } = setup(GATE_HEAD);
    c.handleWorker({ k: 'sdk', tap: 'running', ok: true });
    c.microphoneOff();
    expect(shown.recording).toBe(true);
    c.handleWorker({ k: 'sdk', tap: 'stopped', ok: false });
    expect(shown.recording).toBe(false);
  });

  it('doctor level choice: each notch goes to Deck at once, the button confirms it (spec 7.7)', () => {
    const steps = buildDoctorLevelScenario();
    const { c, shown, deck, worker } = setup(steps);
    c.handleDeck({ k: 'step', n: 0, name: 'level_sample', text: 'x' });
    expect(shown.levels).toBe(true);
    c.chooseLevel(-15);
    expect(deck).toEqual([{ k: 'gain', value: dbToGain(-15) }]);
    expect(worker).toEqual([{ k: 'event', e: 'gain', hard: false, value: dbToGain(-15), db: -15, final: false }]);
    c.handleDeck({ k: 'step', n: S(40), name: 'level_choice', text: 'x' });
    expect(shown.button).toBe('Use this level');
    c.pressWaitButton();
    c.pressWaitButton();
    expect(deck.at(-1)).toEqual({ k: 'go' });
    expect(deck.filter((m) => m.k === 'go')).toHaveLength(1);
    expect(worker.at(-1)).toEqual({ k: 'event', e: 'gain', hard: false, value: dbToGain(-15), db: -15, final: true });
    c.handleDeck({ k: 'step', n: S(41), name: 'leak', text: 'x' });
    expect(shown.levels).toBe(false);
    c.chooseLevel(-3);
    expect(deck.filter((m) => m.k === 'gain')).toHaveLength(1);
  });

  it('prints the status line of a session step from Deck sample numbers (spec 7.3)', () => {
    const steps: Step[] = [
      { k: 'prompt', name: 'opening', text: '', lenSamples: S(75), status: 'Opening', origin: true },
      { k: 'play', name: 'p2', text: '', lenSamples: 0, clip: 'p2.wav', untilClipEnd: true, status: 'Passage 2 of 3' },
      { k: 'end', name: 'end', text: '', lenSamples: 0 },
    ];
    let clock = 0;
    const { c, shown } = setup(steps, () => clock);
    c.handleDeck({ k: 'step', n: 1000, name: 'opening', text: '' });
    expect(shown.status).toBe('Opening    00:00');
    c.handleDeck({ k: 'step', n: 1000 + S(250), name: 'p2', text: '' });
    c.handleDeck({ k: 'state', n: 1000 + S(252), s: 'hold_wait', cause: 'chest' });
    expect(shown.status).toBe('Passage 2 of 3    04:12    CHEST');
    clock = 1.5; // the audio clock moves the clock between Deck reports
    c.handleDeck({ k: 'level', ch0Db: -60, ch1Db: -30 });
    expect(shown.status).toBe('Passage 2 of 3    04:13    CHEST');
    c.handleDeck({ k: 'state', n: 1000 + S(254), s: 'narrating', cause: null });
    expect(shown.status).toBe('Passage 2 of 3    04:14');
  });

  it('shows a Deck error under the prompt and keeps Stop working', () => {
    const { c, shown, deck, worker } = setup(GATE_HEAD);
    c.handleDeck({ k: 'error', message: 'scenario: step 2 has no name' });
    expect(shown.note).toBe('Deck: scenario: step 2 has no name');
    c.stop();
    expect(deck).toEqual([{ k: 'stop' }]);
    expect(worker).toEqual([{ k: 'end', reason: 'stop' }]);
  });

  it('ends the run when Deck\'s processor fails: a hard deck_error line, then end with deck_error (spec 7.2, 12.2)', () => {
    const { c, shown, deck, worker, hooks } = setup(GATE_HEAD);
    c.handleDeck({ k: 'step', n: 10, name: 'deep_1_in', text: 'Breathe in' });
    c.handleDeck({ k: 'cue', n: 20, on: true });
    c.deckFailed('RangeError: offset is out of bounds');
    c.deckFailed('a second processorerror');
    c.stop();
    expect(worker).toEqual([
      { k: 'event', e: 'deck_error', hard: true, message: 'RangeError: offset is out of bounds' },
      { k: 'end', reason: 'deck_error' },
    ]);
    expect(deck).toEqual([{ k: 'stop' }]);
    expect(hooks.failed).toEqual([['deck_error', 'RangeError: offset is out of bounds']]);
    expect(c.endedBy).toBe('deck_error');
    expect(shown.dot).toBe(false);
    expect(shown.bar).toBeNull();
  });

  it('ignores a Deck failure after the run ended', () => {
    const { c, worker, hooks } = setup(GATE_HEAD);
    c.handleDeck({ k: 'done', n: 40 });
    c.deckFailed('late');
    expect(worker).toEqual([{ k: 'end', reason: 'done' }]);
    expect(hooks.failed).toEqual([]);
  });

  it('ends the run with session_lost when the worker loses /session; other worker errors only show', () => {
    const lost = 'worker: /session closed before the end of the run';
    expect(isFatalWorkerError(lost)).toBe(true);
    expect(isFatalWorkerError('tap: a line is not JSON')).toBe(false);

    const a = setup(GATE_HEAD);
    a.c.handleWorker({ k: 'error', message: 'tap: a line is not JSON' });
    expect(a.shown.note).toBe('Worker: tap: a line is not JSON');
    expect(a.c.endedBy).toBeNull();
    a.c.handleWorker({ k: 'error', message: lost });
    a.c.handleWorker({ k: 'error', message: lost });
    expect(a.deck).toEqual([{ k: 'stop' }]);
    expect(a.worker).toEqual([{ k: 'end', reason: 'session_lost' }]);
    expect(a.hooks.failed).toEqual([['session_lost', lost]]);

    // After the scenario's end the run is over; a lost /session still shows, since no verdict will come.
    const b = setup(GATE_HEAD);
    b.c.handleDeck({ k: 'done', n: 40 });
    b.c.handleWorker({ k: 'error', message: 'tap: a line is not JSON' });
    expect(b.shown.note).toBe('');
    b.c.handleWorker({ k: 'error', message: lost });
    expect(b.shown.note).toBe(`Worker: ${lost}`);
    expect(b.hooks.failed).toEqual([]);
    expect(b.worker).toEqual([{ k: 'end', reason: 'done' }]);
  });

  it('keeps a processorerror that fires before the run screen listens', () => {
    const latch = new FailureLatch();
    latch.fire('first');
    latch.fire('second');
    const got: string[] = [];
    latch.listen((d) => got.push(d));
    latch.fire('third');
    expect(got).toEqual(['first', 'third']);
    const quiet = new FailureLatch();
    const none: string[] = [];
    quiet.listen((d) => none.push(d));
    expect(none).toEqual([]);
  });

  it('reads the message of a processorerror event', () => {
    const withMessage = Object.assign(new Event('processorerror'), { message: 'TypeError: x is undefined' });
    expect(processorErrorText(withMessage)).toBe('TypeError: x is undefined');
    expect(processorErrorText(new Event('processorerror'))).toBe('the Deck processor stopped with an error');
  });

  it('explains SDK codes on the waiting screen', () => {
    expect(sdkNote('starting', false, undefined)).toBe('');
    expect(sdkNote('running', false, undefined)).toBe('Waiting for a steady signal.');
    expect(sdkNote('running', false, 'kNoFaceFound')).toMatch(/^No face found/);
    expect(sdkNote('running', false, 'kTooDark')).toMatch(/^Too dark/);
    expect(sdkNote('running', false, 'kSomethingNew')).toBe('Waiting for a steady signal (kSomethingNew).');
    expect(sdkNote('running', true, 'kNoFaceFound')).toBe('');
  });
});

describe('scenarioFor: the plan for /api/config', () => {
  const GATE_NAMES = ['pack.json', 'cues.json', 'listen.wav', 'objections.wav', 'listen.timings.json', 'objections.timings.json'];

  it('maps host scenario names to plans', () => {
    const plan = (mode: string, scenario: string, narrator: string[] = []) => {
      const p = scenarioFor({ mode, scenario, narrator });
      return typeof p === 'string' ? p : [p.id, p.kind, p.camera, p.deckMode, p.clips, p.cuesFile];
    };
    expect(plan('gate', 'gate-A', GATE_NAMES)).toEqual(['gate-A', 'gate', true, 'gate', ['listen.wav', 'objections.wav'], 'cues.json']);
    expect(plan('gate', 'gate-0', GATE_NAMES)).toEqual(['gate-0', 'gate', true, 'gate', ['listen.wav', 'objections.wav'], 'cues.json']);
    expect(plan('doctor', 'doctor', ['level.wav'])).toEqual(['doctor', 'doctor', false, 'gate', ['level.wav'], null]);
    expect(plan('doctor', 'doctor-level', ['level.wav'])).toEqual(['doctor-level', 'doctor', false, 'gate', ['level.wav'], null]);
    expect(plan('doctor', 'doctor', [])).toEqual(['doctor', 'doctor', false, 'gate', [], null]);
    expect(plan('smoke', 'smoke')).toEqual(['smoke', 'smoke', true, 'gate', [], null]);
    expect(plan('gate', 'gate-A', ['listen.wav'])).toMatch(/not ready: host does not serve objections\.wav, cues\.json/);
    expect(plan('doctor', 'doctor-level', [])).toMatch(/level\.wav/);
    expect(plan('session', 'session')).toMatch(/no scenario for mode "session"/);
  });

  it('builds the gate steps from the fetched cue list and clip lengths', () => {
    const p = scenarioFor({ mode: 'gate', scenario: 'gate-A', narrator: GATE_NAMES });
    if (typeof p === 'string') throw new Error(p);
    const cues = [15000, 31000, 55000, 71000, 92000, 110000, 130000, 147000, 167000, 185000, 205000, 223000, 244000, 262000];
    const steps = p.build({ cuesMs: cues, clipSamples: new Map([['listen.wav', S(181)]]) });
    expect(steps.find((s) => s.name === 'listening')?.lenSamples).toBe(S(181));
    expect(() => p.build({ cuesMs: cues.slice(1), clipSamples: new Map() })).toThrow(/14 cues/);
  });

  it('finds the word timings file of a clip', () => {
    expect(timingsNameFor('listen.wav', ['listen.wav', 'listen.timings.json'], 2)).toBe('listen.timings.json');
    expect(timingsNameFor('p1.wav', ['p1.wav', 'p1.json'], 2)).toBe('p1.json');
    expect(timingsNameFor('level.wav', ['level.wav', 'timings.json'], 1)).toBe('timings.json');
    expect(timingsNameFor('level.wav', ['level.wav'], 1)).toBeNull();
  });
});
