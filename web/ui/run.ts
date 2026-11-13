// The recording screen's logic: it shows what Deck reports (steps, the cue dot, states, meters) and
// releases wait steps with {k:'go'}. It times nothing itself (spec 6.1, 7.3).
import type { BarMotion, Step } from '../scenarios/format.ts';
import { SAMPLE_RATE_HZ } from '../scenarios/format.ts';
import { dbToGain } from './levels.ts';
import type { EndReason, FailReason, FromDeck, FromWorker, TapState, ToDeck, ToWorker } from './messages.ts';
import { causeOfState, formatStatusLine, type StopCause } from './status.ts';

export interface RunView {
  prompt(text: string): void;
  /** Deep-breath bar: grow or shrink over `seconds`; null hides it. */
  bar(motion: BarMotion | null, seconds: number): void;
  dot(on: boolean): void;
  /** Small line under the prompt ('' clears it). */
  note(text: string): void;
  /** Button that releases a wait step; null hides it. */
  waitButton(label: string | null): void;
  levels(visible: boolean, selectedDb: number): void;
  status(text: string | null): void;
  meters(ch0Db: number, ch1Db: number): void;
  recording(on: boolean): void;
}

export interface RunHooks {
  done(n: number): void;
  aborted(reason: string): void;
  /** The page ended the run itself: Deck's processor failed, or the worker lost /session. */
  failed(reason: FailReason, detail: string): void;
  closed(): void;
  /** host's quickcheck line (spec 7.12, 9.3); text null when none ran. */
  verdict?(ok: boolean | null, text: string | null): void;
  log?(message: string, data?: unknown): void;
}

export interface RunPorts {
  toDeck(msg: ToDeck): void;
  toWorker(msg: ToWorker): void;
}

/**
 * Hints for the SDK status codes that are not kOk, for the waiting screen (spec 5.3, 7.1, 9.3).
 * Matched on the code name, so the list also covers the codes the SDK adds later.
 */
const SDK_HINTS: ReadonlyArray<readonly [RegExp, string]> = [
  [/NoFace/, 'No face found. Check the framing and the light.'],
  [/MultipleFaces/, 'More than one face in the picture. Only you may be in the frame.'],
  [/ChestNotVisible/, 'Chest not visible. Sit back so the camera sees the top of your chest.'],
  [/Motion$/, 'Too much movement. Sit still.'],
  [/TooDark|FrameRateTooLow|LowFrameRate/, 'Too dark. Add steady light from the front.'],
  [/TooBright/, 'Too bright. Turn the light down or away from the camera.'],
  [/FaceTooClose/, 'Too close. Sit back a little.'],
  [/FaceTooFar/, 'Too far. Move a little closer.'],
  [/FaceNotCentered|FaceToo(?:High|Low)|FaceSizeOutOfRange/, 'Centre your face under the camera.'],
  [/FaceNotForward/, 'Face the camera and look at the dot.'],
  [/CameraTuning/, 'The camera is adjusting.'],
];

/**
 * Worker errors after which nothing reaches host. The worker reports a closed /session only with
 * this text (web/lib/worker-core.ts); its other errors leave the recording going.
 */
export function isFatalWorkerError(message: string): boolean {
  return /\/session closed/.test(message);
}

/** The message of a processor failure (in Chromium an ErrorEvent, "Uncaught Error: ..."), or a plain line. */
export function processorErrorText(e: Event): string {
  const m = (e as Event & { message?: unknown }).message;
  return typeof m === 'string' && m !== '' ? m : 'the Deck processor stopped with an error';
}

/**
 * Holds the first failure until a listener is set: Deck's processorerror can fire between the node's
 * creation and the run screen, and must not be lost.
 */
export class FailureLatch {
  private pending: string | null = null;
  private listener: ((detail: string) => void) | null = null;

  fire(detail: string): void {
    if (this.listener) this.listener(detail);
    else if (this.pending === null) this.pending = detail;
  }

  listen(fn: (detail: string) => void): void {
    this.listener = fn;
    const pending = this.pending;
    this.pending = null;
    if (pending !== null) fn(pending);
  }
}

/** The line under 'Starting camera...' while the scenario waits for the SDK signal. */
export function sdkNote(tap: TapState, ok: boolean, note: string | undefined): string {
  if (ok) return '';
  if (note) {
    const hit = SDK_HINTS.find(([re]) => re.test(note));
    return hit ? hit[1] : `Waiting for a steady signal (${note}).`;
  }
  return tap === 'running' ? 'Waiting for a steady signal.' : '';
}

export class RunController {
  private readonly byName = new Map<string, Step>();
  private current: Step | null = null;
  private goSent = false;
  private sdk: { tap: TapState; ok: boolean; note?: string } = { tap: 'stopped', ok: false };
  private micOn = true;
  private ended: EndReason | null = null;
  private originN: number | null = null;
  private lastN = 0;
  private lastClockS = 0;
  private cause: StopCause | null = null;
  private levelDb: number;

  constructor(
    steps: readonly Step[],
    private readonly view: RunView,
    private readonly ports: RunPorts,
    private readonly hooks: RunHooks,
    startLevelDb: number,
    /** Audio clock in seconds (AudioContext.currentTime), only to move the status-line clock between reports. */
    private readonly audioClockS: () => number = () => 0,
  ) {
    for (const s of steps) this.byName.set(s.name, s);
    this.levelDb = startLevelDb;
    this.view.recording(true);
  }

  get currentStep(): Step | null {
    return this.current;
  }

  get selectedLevelDb(): number {
    return this.levelDb;
  }

  handleDeck(msg: FromDeck): void {
    if ('n' in msg && typeof msg.n === 'number') {
      this.lastN = msg.n;
      this.lastClockS = this.audioClockS();
    }
    switch (msg.k) {
      case 'step':
        this.onStep(msg.name, msg.text, msg.n);
        break;
      case 'cue':
        this.view.dot(msg.on);
        break;
      case 'state':
        this.cause = causeOfState(msg.s, msg.cause);
        this.showStatus();
        break;
      case 'level':
        this.view.meters(msg.ch0Db, msg.ch1Db);
        this.showStatus();
        break;
      case 'done':
        this.view.dot(false);
        this.view.bar(null, 0);
        this.view.waitButton(null);
        this.view.levels(false, this.levelDb);
        this.finish();
        this.hooks.done(msg.n);
        break;
      case 'error':
        // Shown, not acted on: a scenario Deck refuses never starts, and Stop still ends the run.
        this.hooks.log?.('deck error', msg.message);
        this.view.note(`Deck: ${msg.message}`);
        break;
      default:
        break;
    }
  }

  handleWorker(msg: FromWorker): void {
    switch (msg.k) {
      case 'sdk':
        this.sdk = { tap: msg.tap, ok: msg.ok, ...(msg.note ? { note: msg.note } : {}) };
        this.view.recording(this.recordingOn());
        if (this.current?.k === 'wait' && this.current.until === 'sdk_ok') {
          this.view.note(sdkNote(msg.tap, msg.ok, msg.note));
          if (msg.ok) this.go();
        }
        break;
      case 'abort':
        this.end('abort');
        this.hooks.aborted(msg.reason);
        break;
      case 'closed':
        this.hooks.closed();
        break;
      case 'quickcheck':
        this.hooks.verdict?.(msg.ok, msg.text);
        break;
      case 'error': {
        this.hooks.log?.('worker error', msg.message);
        const fatal = isFatalWorkerError(msg.message);
        if (fatal && !this.ended) this.fail('session_lost', msg.message);
        // After the end only a lost /session is news: host's quickcheck line will not come.
        else if (fatal || !this.ended) this.view.note(`Worker: ${msg.message}`);
        break;
      }
      default:
        break;
    }
  }

  /**
   * Deck's processor failed (processorerror): it records nothing more and sends no done, so the run
   * ends now, with a deck_error line in events.jsonl, instead of the camera running on (spec 7.2, 12.2).
   */
  deckFailed(detail: string): void {
    if (this.ended) return;
    this.ports.toWorker({ k: 'event', e: 'deck_error', hard: true, message: detail });
    this.fail('deck_error', detail);
  }

  private fail(reason: FailReason, detail: string): void {
    if (this.ended) return;
    this.end(reason);
    this.hooks.failed(reason, detail);
  }

  private onStep(name: string, text: string, n: number): void {
    const step: Step = this.byName.get(name) ?? { k: 'prompt', name, text, lenSamples: 0 };
    this.current = step;
    this.goSent = false;
    if (step.origin && this.originN === null) this.originN = n;
    this.view.prompt(text);
    this.view.bar(step.k === 'prompt' && step.bar ? step.bar : null, step.lenSamples / SAMPLE_RATE_HZ);
    this.view.levels(step.levels === true, this.levelDb);
    this.view.waitButton(step.k === 'wait' && step.until === 'button' ? (step.button ?? 'Continue') : null);
    this.view.note(step.k === 'wait' && step.until === 'sdk_ok' ? sdkNote(this.sdk.tap, this.sdk.ok, this.sdk.note) : '');
    if (step.k === 'wait' && step.until === 'sdk_ok' && this.sdk.ok) this.go();
    this.showStatus();
  }

  private showStatus(): void {
    const label = this.current?.status;
    if (!label) {
      this.view.status(null);
      return;
    }
    const nowN = this.lastN + Math.max(0, this.audioClockS() - this.lastClockS) * SAMPLE_RATE_HZ;
    const elapsed = this.originN === null ? null : nowN - this.originN;
    this.view.status(formatStatusLine(label, elapsed, this.cause));
  }

  private go(): void {
    if (this.goSent || this.ended) return;
    this.goSent = true;
    this.ports.toDeck({ k: 'go' });
  }

  /**
   * The wait step's button. On the level choice it sends the gain event with final: true, from which
   * host writes output_gain into calib.json (spec 7.7, docs/protocol.md).
   */
  pressWaitButton(): void {
    const step = this.current;
    if (!step || step.k !== 'wait' || step.until !== 'button' || this.goSent) return;
    if (step.levels) this.ports.toWorker({ k: 'event', e: 'gain', hard: false, value: dbToGain(this.levelDb), db: this.levelDb, final: true });
    this.view.waitButton(null);
    this.go();
  }

  /** A level notch in the doctor chooser (spec 7.7). */
  chooseLevel(db: number): void {
    if (!this.current?.levels || this.ended) return;
    this.levelDb = db;
    const value = dbToGain(db);
    this.ports.toDeck({ k: 'gain', value });
    this.ports.toWorker({ k: 'event', e: 'gain', hard: false, value, db, final: false });
    this.view.levels(true, db);
  }

  /** Stop button (spec 12.2): Deck mutes, the worker ends the run and host stops the SDK. */
  stop(): void {
    if (this.ended) return;
    this.end('stop');
  }

  /** The scenario finished: the worker sends its last frames and ends the run. */
  finish(): void {
    if (this.ended) return;
    this.ended = 'done';
    this.ports.toWorker({ k: 'end', reason: 'done' });
  }

  private end(reason: EndReason): void {
    if (this.ended) return;
    this.ended = reason;
    this.ports.toDeck({ k: 'stop' });
    this.ports.toWorker({ k: 'end', reason });
    this.view.dot(false);
    this.view.bar(null, 0);
    this.view.waitButton(null);
    this.view.levels(false, this.levelDb);
  }

  /** The page turned the microphone off. */
  microphoneOff(): void {
    this.micOn = false;
    this.view.recording(this.recordingOn());
  }

  private recordingOn(): boolean {
    return this.micOn || this.sdk.tap === 'starting' || this.sdk.tap === 'running';
  }

  get endedBy(): EndReason | null {
    return this.ended;
  }
}
