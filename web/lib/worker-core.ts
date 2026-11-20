// Worker logic without the Worker shell (spec 6.1, 6.2, 7.1, 7.3, 8.1), so Node tests can drive it:
// - /tap lines -> detector_in lines -> step() -> {k:'pkt', seq, hold} to Deck on the direct port;
// - Deck stamps and audio blocks -> /session; voice edges and state changes -> detector_in -> step();
// - events.jsonl: fire, armed, hold, resume, Deck's voice detector parameters, the trace sign and
//   the page's events; only live mode keeps step() answers;
// - SDK readiness -> {k:'sdk', tap, ok, note} to the page;
// - live mode: the trace, D1 fires and D1 activity to the page for the live view (spec 15.2);
//   headstart: the trace sign from the three paced deep breaths (spec 7.11, deep-breath-sign.ts).

import { encodeChunkFrame } from './chk1.ts';
import { orderKeys, type DetectorInput } from './core.ts';
import { DEEP_BREATH_SIGN_ERROR, DeepBreathSign } from './deep-breath-sign.ts';
import { DetectorRunner, PRELIMINARY_DETECTOR, batchFromTapLine, detectorChoice, type DetectorChoice } from './detector-adapter.ts';
import {
  deckModeOf,
  type DeckMode,
  type DeckStamp,
  type DetBatch,
  type DetVal,
  type DetectorLine,
  type DetectorSignEvent,
  type DetectorVariant,
  type EventLine,
  type MainToWorker,
  type NarratorState,
  type TapState,
  type TracePair,
  type VadEvent,
  type WorkerConfig,
  type WorkerToDeck,
  type WorkerToMain,
} from './messages.ts';
import { SdkReadiness } from './sdk-ready.ts';

export interface SocketLike {
  binaryType: string;
  readonly readyState: number;
  send(data: string | ArrayBuffer): void;
  close(code?: number, reason?: string): void;
  onopen: ((ev: unknown) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onclose: ((ev: unknown) => void) | null;
  onerror: ((ev: unknown) => void) | null;
}

export interface PortLike {
  postMessage(msg: unknown): void;
  onmessage: ((ev: { data: unknown }) => void) | null;
}

export interface WorkerEnv {
  postToMain(msg: WorkerToMain): void;
  openSocket(url: string): SocketLike;
  /**
   * Calls fn once after ms. Used only to stop waiting for Deck's last block when the audio thread
   * is gone; nothing recorded depends on it (spec 6.1).
   */
  later?(ms: number, fn: () => void): void;
}

/** How long the worker waits for Deck's {k:'done'} after the page's end before it ends /session. */
export const END_WAIT_MS = 3_000;

const OPEN = 1;
const TAP_STATES: ReadonlySet<string> = new Set(['starting', 'running', 'stopped']);
/** Events only the worker writes (spec 8.1); the page cannot send them. */
const WORKER_EVENTS: ReadonlySet<string> = new Set(['fire', 'armed', 'hold', 'resume', 'vad', 'detector_sign']);
/** Host mode whose trace sign comes from three cued deep breaths in the run, never from a stored calib (spec 7.11). */
const SIGN_IN_RUN_MODE = 'headstart';
const VAD_SOURCES: ReadonlySet<string> = new Set(['options', 'default', 'message']);
/** Live view: at most one trace point per 1/30 s step of camera time (spec 15.2: the SDK gives about 30). */
export const LIVE_TRACE_STEP_US = 1e6 / 30;
/** Live view: a trace point this far before the last one kept starts the grid of steps again. */
const LIVE_TRACE_RESTART_US = 5e6;
/** Live view: trace of packets waiting for their arr stamp; older ones are dropped beyond this. */
const LIVE_TRACE_PENDING_MAX = 256;

type Frame = string | ArrayBuffer;
interface LiveTrace {
  sign: 1 | -1;
  count: number;
  pts: TracePair[];
}
type EventDraft = { e: 'fire'; det: DetectorVariant; seq: number; v: number; theta: number } | { e: 'armed'; det: DetectorVariant; on: boolean };

function isRecord(x: unknown): x is Record<string, unknown> {
  return typeof x === 'object' && x !== null && !Array.isArray(x);
}

function isSeq(x: unknown): x is number {
  return typeof x === 'number' && Number.isSafeInteger(x) && x >= 0;
}

function nonEmpty(x: unknown): string | null {
  return typeof x === 'string' && x.length > 0 ? x : null;
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Numbers as JSON can hold them: a value that is not finite becomes null (spec 8.1). */
function jsonNumbers(xs: readonly number[]): Array<number | null> {
  return xs.map((x) => (Number.isFinite(x) ? x : null));
}

/** Camera timestamp of a /tap packet's landmarks (`lm.ts`), null without one. */
function landmarkTs(line: Record<string, unknown>): number | null {
  const lm = line.lm;
  return isRecord(lm) && typeof lm.ts === 'number' && Number.isFinite(lm.ts) ? lm.ts : null;
}

/** Where the thinning of the live trace stands: a grid of LIVE_TRACE_STEP_US from the first point kept. */
export interface TraceThinning {
  /** Camera time of the grid's step 0, us; null before the first point. */
  originUs: number | null;
  /** Grid step of the last point kept. */
  lastStep: number;
  /** Camera time of the last point kept, us. */
  lastUs: number;
}

export function newTraceThinning(): TraceThinning {
  return { originUs: null, lastStep: Number.NEGATIVE_INFINITY, lastUs: Number.NEGATIVE_INFINITY };
}

/**
 * Trace points for the live view: finite pairs, value times sign, at most one per step of the grid
 * that starts at the first point kept (so a 30 Hz trace keeps every point, a denser one is thinned to
 * about 30 per second). Points of a step at or before the last one kept are dropped; a point far
 * before it (a camera clock that started again) starts a new grid. Updates `state`.
 */
export function thinTrace(tr: readonly TracePair[], sign: 1 | -1, state: TraceThinning): TracePair[] {
  const pts: TracePair[] = [];
  for (const [t, v] of tr) {
    if (!Number.isFinite(t) || !Number.isFinite(v)) continue;
    if (state.originUs === null || t < state.lastUs - LIVE_TRACE_RESTART_US) {
      state.originUs = t;
      state.lastStep = Number.NEGATIVE_INFINITY;
    }
    const step = Math.round((t - state.originUs) / LIVE_TRACE_STEP_US);
    if (step <= state.lastStep) continue;
    state.lastStep = step;
    state.lastUs = t;
    pts.push([t, v * sign]);
  }
  return pts;
}

/** Sends frames in order; frames sent before the socket opens wait in a queue. */
class OrderedSender {
  private readonly queue: Frame[] = [];
  private open = false;

  constructor(private readonly sock: SocketLike | null) {}

  markOpen(): void {
    this.open = true;
    for (const f of this.queue.splice(0)) this.sock?.send(f);
  }

  markClosed(): void {
    this.open = false;
  }

  send(frame: Frame): void {
    if (!this.sock) return;
    if (this.open) {
      if (this.sock.readyState === OPEN) this.sock.send(frame);
    } else this.queue.push(frame);
  }
}

export class WorkerCore {
  private inited = false;
  private mode: DeckMode = 'gate';
  private configMode: string | null = null;
  /** False in headstart until the sign of this run is set (spec 7.11). */
  private signKnown = true;
  /** headstart: collects the deep breaths until the sign is found or reading starts (spec 7.11); null otherwise. */
  private signFinder: DeepBreathSign | null = null;
  /** headstart: the deep breaths gave no sign and the page was told (DEEP_BREATH_SIGN_ERROR). */
  private signFailed = false;
  /** Live view: trace of packets that wait for their arr stamp, by seq (live mode only). */
  private readonly liveTrace = new Map<number, LiveTrace>();
  private readonly liveThinning = newTraceThinning();
  private logInputs = false;
  private runner: DetectorRunner | null = null;
  private variant: DetectorVariant = 'D1';
  /**
   * Inputs step() has seen while the narrator has not read yet (live mode): a new sign re-feeds
   * them, so the detector stands where a replay of detector_in.jsonl with that sign stands.
   * Null once reading started.
   */
  private beforeReading: DetectorInput[] | null = null;
  private deck: PortLike | null = null;
  private session = new OrderedSender(null);
  private sessionSock: SocketLike | null = null;
  private tapSock: SocketLike | null = null;
  /** host drops lines and audio before consent: everything but hello waits for it. */
  private consentSent = false;
  private readonly beforeConsent: Frame[] = [];
  /** Sample clock as far as Deck reported it (stamps and audio blocks); null before any. */
  private nKnown: number | null = null;
  private readonly pending = new Map<number, EventDraft[]>();
  private state: NarratorState = 'idle';
  private prevState: NarratorState = 'idle';
  private readonly sdk = new SdkReadiness();
  private lastSdk = JSON.stringify(this.sdk.status());
  private endReason: string | null = null;
  private deckDone = false;
  private aborted = false;
  /** host said {t:'tap', status:'stopped'}: tap ended on purpose, so its socket closing is no error. */
  private tapStoppedByHost = false;
  private finished = false;

  constructor(private readonly env: WorkerEnv) {}

  /** step() answers go to Deck and events.jsonl only in live mode, with a known sign (spec 6.5, 7.3, 7.11). */
  private get keepAnswers(): boolean {
    return this.mode === 'live' && this.signKnown;
  }

  /** The setup step() runs with; null without /tap. */
  get detector(): DetectorChoice | null {
    return this.runner ? this.runner.choice : null;
  }

  /** For tests: the sockets this worker opened. */
  get sockets(): { session: SocketLike | null; tap: SocketLike | null } {
    return { session: this.sessionSock, tap: this.tapSock };
  }

  // ---------------------------------------------------------------- main thread

  onMainMessage(msg: MainToWorker): void {
    if (!isRecord(msg)) return;
    switch (msg.k) {
      case 'init':
        this.init(isRecord(msg.config) ? (msg.config as WorkerConfig) : {}, msg.port as unknown as PortLike);
        break;
      case 'hello':
        this.session.send(JSON.stringify({ t: 'hello', ua: typeof msg.ua === 'string' ? msg.ua : '', settings: msg.settings ?? null }));
        break;
      case 'consent':
        this.onConsent(msg.at);
        break;
      case 'event':
        this.onPageEvent(msg as Record<string, unknown>);
        break;
      case 'detector':
        this.onSign(msg.sign);
        break;
      case 'end':
        this.onEnd(typeof msg.reason === 'string' && msg.reason ? msg.reason : 'stop');
        break;
      default:
        break;
    }
  }

  private init(config: WorkerConfig, port: PortLike | undefined): void {
    if (this.inited) {
      this.error('worker: init twice');
      return;
    }
    this.inited = true;
    this.mode = deckModeOf(config.mode);
    this.configMode = typeof config.mode === 'string' ? config.mode : null;
    if (port && typeof port.postMessage === 'function') {
      this.deck = port;
      port.onmessage = (ev) => this.onDeckMessage(ev.data);
    } else this.error('worker: init without the Deck port');

    const tapUrl = nonEmpty(config.tapUrl);
    this.logInputs = tapUrl !== null;
    if (this.logInputs) this.setUpDetector(config);

    const sessionUrl = nonEmpty(config.sessionUrl);
    if (sessionUrl) {
      const sock = this.env.openSocket(sessionUrl);
      sock.binaryType = 'arraybuffer';
      this.sessionSock = sock;
      this.session = new OrderedSender(sock);
      sock.onopen = () => this.session.markOpen();
      sock.onmessage = (ev) => {
        if (typeof ev.data === 'string') this.handleSessionText(ev.data);
      };
      sock.onclose = () => {
        this.session.markClosed();
        if (!this.finished) this.error('worker: /session closed before the end of the run');
      };
    }
    if (tapUrl) {
      const sock = this.env.openSocket(tapUrl);
      this.tapSock = sock;
      sock.onmessage = (ev) => {
        if (typeof ev.data === 'string') this.handleTapText(ev.data);
      };
      // A refused or dropped /tap (token, Origin) would leave the page waiting for the SDK.
      sock.onerror = () => {};
      sock.onclose = () => this.onTapClosed();
    }
  }

  /**
   * Live: config.detector; headstart takes the sign from the run (spec 7.11) and runs step() with
   * sign 1 until then, answers dropped. Other modes: preliminary parameters, answers dropped (spec 7.3).
   */
  private setUpDetector(config: WorkerConfig): void {
    let choice: DetectorChoice = PRELIMINARY_DETECTOR;
    try {
      if (this.mode === 'live') {
        choice = detectorChoice(config);
        if (this.configMode === SIGN_IN_RUN_MODE) {
          choice = { ...choice, sign: 1 };
          this.signKnown = false;
          this.signFinder = new DeepBreathSign();
        }
        this.beforeReading = [];
      }
      this.runner = new DetectorRunner(choice);
      this.variant = choice.variant;
    } catch (err) {
      // No detector: inputs are still logged, no chest stop is sent.
      this.runner = null;
      this.beforeReading = null;
      this.error(`worker: detector setup failed: ${errText(err)}`);
    }
  }

  /**
   * {k:'detector', sign} from the page: the sign of the three cued deep breaths (spec 7.4, 7.11).
   * Only before the narrator first reads: step() then starts again with the new sign on every input
   * so far (nothing is active before reading, spec 7.4), so replaying detector_in.jsonl with this
   * sign gives the same answers. Written to events.jsonl.
   */
  private onSign(sign: unknown): void {
    if (this.finished) return;
    if (sign !== 1 && sign !== -1) {
      this.error(`worker: the trace sign must be 1 or -1, got ${JSON.stringify(sign)}`);
      return;
    }
    if (this.mode !== 'live' || this.runner === null) {
      this.error('worker: a trace sign needs a live run with a detector');
      return;
    }
    if (this.beforeReading === null) {
      this.error('worker: the trace sign must come before reading starts');
      return;
    }
    this.applySign(sign);
  }

  /**
   * step() starts again with `sign` on every input so far (nothing is active before reading, spec 7.4),
   * so a replay of detector_in.jsonl with this sign gives the same answers; written to events.jsonl,
   * with the deep breaths' d when they gave it. Only before reading, with a detector. A sign set here
   * ends the search of the deep breaths.
   */
  private applySign(sign: 1 | -1, d?: readonly number[]): void {
    const runner = this.runner;
    if (runner === null || this.beforeReading === null) return;
    let next: DetectorRunner;
    try {
      next = new DetectorRunner({ ...runner.choice, sign });
      for (const x of this.beforeReading) next.feed(x);
    } catch (err) {
      this.error(`worker: the trace sign was not applied: ${errText(err)}`);
      return;
    }
    this.runner = next;
    this.signKnown = true;
    this.signFinder = null;
    const line: DetectorSignEvent = { n: this.nKnown, e: 'detector_sign', det: this.variant, sign };
    if (d !== undefined) line.d = jsonNumbers(d);
    this.writeEvent(line);
  }

  /**
   * headstart (spec 7.4, 7.11): the sign from the three paced deep breaths, with the agreement and the
   * margin of spec 7.4. Without one the page shows DEEP_BREATH_SIGN_ERROR and D1 never stops the
   * narrator in this run (its answers stay dropped); the voice still does (the audio safety). Either
   * way events.jsonl says so: detector_sign with the sign, or with sign null and why (spec 7.11: the
   * session folder stays on the computer of the run).
   */
  private findSign(): void {
    const finder = this.signFinder;
    this.signFinder = null;
    if (finder === null || this.signKnown || this.runner === null || this.beforeReading === null || this.finished) return;
    const r = finder.result();
    if (r.use !== null) {
      this.applySign(r.use, r.d);
      return;
    }
    this.noSign(r.why ?? 'no clear direction on the deep breaths', r.d);
    this.error(DEEP_BREATH_SIGN_ERROR);
  }

  /** headstart without a sign of the run: D1's answers stay dropped; events.jsonl gets detector_sign with sign null. */
  private noSign(why: string, d?: readonly number[]): void {
    this.signFailed = true;
    const line: DetectorSignEvent = { n: this.nKnown, e: 'detector_sign', det: this.variant, sign: null, why };
    if (d !== undefined) line.d = jsonNumbers(d);
    // why is a key of the spec 8.1 order and sign is not: write them in the order a reader of the file expects.
    this.writeEvent(orderKeys(line, 'events.jsonl'));
  }

  /**
   * The /tap socket closed or was refused (token, Origin, a second client): an error plus
   * {k:'sdk', ok:false}, unless the run is ending or host already said tap stopped.
   */
  private onTapClosed(): void {
    if (this.finished || this.endReason !== null || this.deckDone || this.aborted || this.tapStoppedByHost) return;
    this.sdk.onSocketClosed();
    this.postSdk();
    this.error('worker: /tap closed before the end of the run');
  }

  private onConsent(at: unknown): void {
    if (this.consentSent) return;
    this.session.send(JSON.stringify({ t: 'consent', at: typeof at === 'string' || typeof at === 'number' ? at : null }));
    this.consentSent = true;
    for (const f of this.beforeConsent.splice(0)) this.session.send(f);
  }

  /** {k:'event', e, hard, ...fields} from the page: one events.jsonl line at the worker's sample. */
  private onPageEvent(msg: Record<string, unknown>): void {
    if (this.finished) return;
    const e = msg.e;
    if (typeof e !== 'string' || !/^[a-z][a-z0-9_]*$/.test(e) || WORKER_EVENTS.has(e)) {
      this.error(`worker: ${JSON.stringify(e)} is not a page event name`);
      return;
    }
    const fields: Record<string, unknown> = { ...msg };
    delete fields.k;
    delete fields.e;
    delete fields.n;
    this.writeEvent(orderKeys({ n: this.nKnown, e, ...fields }, 'events.jsonl') as EventLine);
  }

  private onEnd(reason: string): void {
    if (this.endReason !== null) return;
    this.endReason = reason;
    if (this.deckDone || !this.deck) this.finish();
    else this.env.later?.(END_WAIT_MS, () => this.finish());
  }

  /**
   * After Deck's last block and stamp (or the fallback wait): {t:'end'} as the last frame, then
   * {k:'closed'}. Fire and armed lines of a packet Deck never stamped are dropped: a detector's
   * time is the packet's nArr, and that packet has none (spec 6.3).
   */
  private finish(): void {
    if (this.finished || this.endReason === null) return;
    this.finished = true;
    this.pending.clear();
    this.liveTrace.clear();
    this.sendSession(JSON.stringify({ t: 'end', reason: this.endReason }));
    this.env.postToMain({ k: 'closed' });
  }

  // ---------------------------------------------------------------- /tap

  /** One samples.jsonl line from tap (docs/protocol.md /tap). Lines after Deck's last sample are no input. */
  handleTapText(text: string): void {
    if (this.deckDone || this.finished) return;
    let line: unknown;
    try {
      line = JSON.parse(text);
    } catch {
      this.error('tap: a line is not JSON');
      return;
    }
    if (!isRecord(line)) return;
    switch (line.k) {
      case 'm':
        this.onPacket(line);
        break;
      case 'v':
        this.onValidation(line);
        break;
      case 's':
        this.sdk.onProcessing(line.name, line.code, this.nKnown ?? 0);
        this.postSdk();
        break;
      default:
        break; // f, e and l: tap writes them to samples.jsonl itself; host handles SDK errors.
    }
  }

  /** spec 7.3: step() first, then one {seq, hold} to Deck; logging after, off the stop path. */
  private onPacket(line: Record<string, unknown>): void {
    const batch = batchFromTapLine(line);
    if (!batch) {
      this.error('tap: a packet line without a valid seq');
      return;
    }
    const out = this.feed(batch);
    const hold = this.keepAnswers && out !== null && out.hold;
    const pkt: WorkerToDeck = { k: 'pkt', seq: batch.seq, hold };
    this.deck?.postMessage(pkt);
    this.sendDet(batch);
    if (this.mode === 'live') this.observePacket(batch, line);
    if (!out || !this.keepAnswers) return;
    // Events of a packet wait for its arrival sample nArr, which Deck stamps (spec 6.2, 8.1).
    if (out.fire) this.pend(batch.seq, { e: 'fire', det: this.variant, seq: batch.seq, v: out.fire.v, theta: out.fire.theta });
    if (out.armed !== undefined) this.pend(batch.seq, { e: 'armed', det: this.variant, on: out.armed });
  }

  /**
   * Live mode, off the stop path: the packet's trace for the live view (sent at its arr stamp, with
   * the sign step() runs with) and, in headstart before reading, for the sign of the deep breaths.
   */
  private observePacket(batch: DetBatch, line: Record<string, unknown>): void {
    this.signFinder?.packet(batch.seq, batch.tr, landmarkTs(line));
    const sign = this.runner?.choice.sign ?? 1;
    this.liveTrace.set(batch.seq, { sign, count: batch.tr.length, pts: thinTrace(batch.tr, sign, this.liveThinning) });
    if (this.liveTrace.size > LIVE_TRACE_PENDING_MAX) {
      const oldest = this.liveTrace.keys().next();
      if (!oldest.done) this.liveTrace.delete(oldest.value);
    }
  }

  private onValidation(line: Record<string, unknown>): void {
    const { seq, code } = line;
    if (!isSeq(seq) || typeof code !== 'number' || !Number.isInteger(code)) {
      this.error('tap: a validationStatus line without a valid seq or code');
      return;
    }
    const val: DetVal = { k: 'val', seq, code };
    this.input(val, this.nKnown ?? 0);
    this.sdk.onValidation(code, line.name, this.nKnown ?? 0);
    this.postSdk();
  }

  // ---------------------------------------------------------------- Deck

  onDeckMessage(msg: unknown): void {
    if (this.finished || !isRecord(msg)) return;
    if (msg.k === 'chunk') {
      const { n0, ch0, ch1 } = msg;
      if (typeof n0 !== 'number' || !(ch0 instanceof Float32Array) || !(ch1 instanceof Float32Array)) return;
      this.clock(n0 + ch0.length);
      this.sendSession(encodeChunkFrame(n0, ch0, ch1));
    } else if (msg.k === 'stamp' && isRecord(msg.line)) {
      this.onStamp(msg.line as unknown as DeckStamp);
    } else if (msg.k === 'vad') {
      this.onVad(msg);
      return;
    } else if (msg.k === 'done') {
      if (typeof msg.n === 'number') this.clock(msg.n);
      this.deckDone = true;
      if (this.endReason !== null) this.finish();
      return;
    } else return;
    this.sdk.onClock(this.nKnown ?? 0);
    this.postSdk();
  }

  private onStamp(line: DeckStamp): void {
    this.sendSession(JSON.stringify({ t: 'stamp', line }));
    this.clock(line.n);
    switch (line.k) {
      case 'arr':
        this.signFinder?.arrival(line.seq, line.n);
        this.flushPending(line.seq, line.n);
        this.flushLiveTrace(line.seq, line.n);
        break;
      case 'mark':
        // headstart: the step after the last exhale has started, so the sign of the breaths is due (spec 7.11).
        if (line.what === 'step' && this.signFinder?.step(line.name, line.n) === true) this.findSign();
        break;
      case 'voice':
        this.input({ k: 'voice', n: line.n, on: line.on }, line.n);
        break;
      case 'state':
        this.prevState = this.state;
        this.state = line.s;
        this.input({ k: 'state', n: line.n, s: line.s }, line.n);
        if (line.s === 'narrating') this.readingStarted();
        break;
      case 'hold':
        this.writeEvent({ n: line.n, e: 'hold', cause: line.cause, nCmd: line.n, nSilent: line.nSilent, word: line.word });
        break;
      case 'resume':
        // Deck stamps state `resume` just before; the state before that tells why (spec 6.4, 8.1).
        this.writeEvent({ n: line.n, e: 'resume', word: line.word, why: this.prevState === 'listening' ? 'voice_off' : 'timeout' });
        break;
      default:
        break;
    }
  }

  /** Deck's voice detector parameters from sample n on: one events.jsonl line (spec 7.3). */
  private onVad(msg: Record<string, unknown>): void {
    const { n, source, note, params } = msg;
    if (typeof n !== 'number' || typeof source !== 'string' || !VAD_SOURCES.has(source) || !isRecord(params)) return;
    // Key order of the record: n, e, source, note, params.
    const line = { n, e: 'vad', source, ...(typeof note === 'string' ? { note } : {}), params } as unknown as VadEvent;
    this.writeEvent(line);
  }

  /** The narrator reads for the first time: no new sign from here on (spec 7.4, 7.11). */
  private readingStarted(): void {
    if (this.beforeReading === null) return;
    // The step after the last exhale never came (a scenario that reads at once): the breaths seen so far decide.
    if (this.signFinder?.sawBreaths === true) this.findSign();
    this.signFinder = null;
    if (!this.signKnown && this.runner !== null && !this.signFailed && !this.finished) {
      this.noSign('reading started before any deep breath');
      this.error('worker: no trace sign before reading started (headstart takes it from three deep breaths, spec 7.11); D1 does not stop the narrator in this run');
    }
    this.beforeReading = null;
  }

  // ---------------------------------------------------------------- host

  handleSessionText(text: string): void {
    let msg: unknown;
    try {
      msg = JSON.parse(text);
    } catch {
      return;
    }
    if (!isRecord(msg)) return;
    switch (msg.t) {
      case 'abort':
        // The page sends Deck {k:'stop'} and ends the run (docs/protocol.md).
        this.aborted = true;
        this.env.postToMain({ k: 'abort', reason: typeof msg.reason === 'string' ? msg.reason : 'abort' });
        break;
      case 'tap':
        if (typeof msg.status === 'string' && TAP_STATES.has(msg.status)) {
          this.tapStoppedByHost = msg.status === 'stopped';
          this.sdk.onTap(msg.status as TapState);
          this.postSdk();
        }
        break;
      case 'quickcheck':
        this.env.postToMain({
          k: 'quickcheck',
          ok: typeof msg.ok === 'boolean' ? msg.ok : null,
          text: typeof msg.text === 'string' ? msg.text : null,
        });
        break;
      default:
        break; // saved
    }
  }

  // ---------------------------------------------------------------- helpers

  private feed(input: DetectorInput) {
    if (!this.runner) return null;
    try {
      const out = this.runner.feed(input);
      this.beforeReading?.push(input);
      return out;
    } catch (err) {
      this.runner = null;
      this.beforeReading = null;
      this.error(`worker: step() failed, detector off: ${errText(err)}`);
      return null;
    }
  }

  /** Logs one detector input, feeds it to step() and writes a change of activity at sample n. */
  private input(d: DetectorLine, n: number): void {
    if (!this.logInputs) return;
    const out = this.feed(d);
    this.sendDet(d);
    if (out && this.keepAnswers && out.armed !== undefined) this.writeEvent({ n, e: 'armed', det: this.variant, on: out.armed });
  }

  private pend(seq: number, draft: EventDraft): void {
    const list = this.pending.get(seq);
    if (list) list.push(draft);
    else this.pending.set(seq, [draft]);
  }

  private flushPending(seq: number, n: number): void {
    const list = this.pending.get(seq);
    if (!list) return;
    this.pending.delete(seq);
    for (const d of list) this.writeEvent({ n, ...d });
  }

  /** Live view: the trace of packet seq at its arrival sample n. */
  private flushLiveTrace(seq: number, n: number): void {
    const t = this.liveTrace.get(seq);
    if (!t) return;
    this.liveTrace.delete(seq);
    this.env.postToMain({ k: 'trace', n, sign: t.sign, count: t.count, pts: t.pts });
  }

  private clock(n: number): void {
    if (Number.isFinite(n) && (this.nKnown === null || n > this.nKnown)) this.nKnown = n;
  }

  private postSdk(): void {
    const status = this.sdk.status();
    const json = JSON.stringify(status);
    if (json === this.lastSdk) return;
    this.lastSdk = json;
    this.env.postToMain({ k: 'sdk', ...status });
  }

  private writeEvent(line: EventLine): void {
    this.sendSession(JSON.stringify({ t: 'event', line }));
    if (this.mode === 'live') this.showEvent(line);
  }

  /** Live view: D1 fires and activity as written to events.jsonl (only live mode keeps them, spec 7.3). */
  private showEvent(line: EventLine): void {
    if (line.e === 'fire' && typeof line.n === 'number') {
      const f = line as { n: number; v: number; theta: number };
      this.env.postToMain({ k: 'fire', n: f.n, v: f.v, theta: f.theta });
    } else if (line.e === 'armed' && typeof line.n === 'number') {
      this.env.postToMain({ k: 'armed', n: line.n, on: (line as { on: boolean }).on });
    }
  }

  private sendDet(line: DetectorLine): void {
    this.sendSession(JSON.stringify({ t: 'det', line }));
  }

  private sendSession(frame: Frame): void {
    if (this.consentSent) this.session.send(frame);
    else this.beforeConsent.push(frame);
  }

  private error(message: string): void {
    this.env.postToMain({ k: 'error', message });
  }
}
