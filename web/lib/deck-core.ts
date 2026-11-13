// Deck logic without the AudioWorklet shell, so Node tests can drive it quantum by quantum.
// Clock: n counts samples since the processor started. A message is stamped with the first sample
// of the quantum in which it is handled (spec 7.3); timed rules (H, the audio safety, voice edges,
// scenario steps, clicks) act on their exact sample. No timers anywhere (spec 6.1).

import { demoClicks, loopCheckClicks } from './clicks.ts';
import { DEFAULT_VAD_PARAMS, createVad, resolveVadParams, vadFrozenBlock, vadParamsFromFrozen, type VadParams } from './core.ts';
import type { Step } from '../scenarios/format.ts';
import { Timeline, scenarioProblems, type StepStart } from './deck-scenario.ts';
import {
  deckModeOf,
  narratorStops,
  type ClickBlock,
  type DeckMode,
  type DeckProcessorOptions,
  type DeckStamp,
  type DeckToMain,
  type DeckToWorker,
  type HoldCause,
  type MainToDeck,
  type NarratorState,
  type VadMessage,
  type VadSource,
  type WorkerToDeck,
} from './messages.ts';
import { NO_WORDS, normalizeWordTimings, stopPlan, type WordTimes } from './timings.ts';
import {
  CHUNK_SAMPLES,
  FADE_IN_SAMPLES,
  FADE_OUT_SAMPLES,
  HOLD_WAIT_SAMPLES,
  LEVEL_WINDOW_SAMPLES,
  QUANTUM_SAMPLES,
  SAMPLE_RATE_HZ,
  VOICE_SAFETY_SAMPLES,
} from './units.ts';

export interface VoiceEdge {
  readonly n: number;
  readonly on: boolean;
}
export interface VoiceDetector {
  /** core/vad contract: blocks are contiguous; returns the edges decided in this block (n0 < n <= n0 + length). */
  push(block: Float32Array, n0: number): readonly VoiceEdge[];
}

export interface DeckOptions {
  mode?: DeckMode;
  /** Partial<VadParams>, or the `vad` block of params/frozen.json (spec 7.3, 8.4). */
  vadParams?: unknown;
  /** Where the page took vadParams from (the note of the `vad` record). */
  vadSource?: string;
  /** Output gain chosen by `doctor` (spec 7.7); the page may change it with {k:'gain'}. */
  gain?: number;
  chunkSamples?: number;
  levelWindowSamples?: number;
  /** Tests only: replace the voice detector (Deck then records no parameters) or the clicks. */
  makeVad?: () => VoiceDetector;
  clickOffsetsSamples?: readonly number[];
  demoClickOffsetsSamples?: readonly number[];
  clickWaveform?: Float32Array;
}

export interface DeckSinks {
  toMain(msg: DeckToMain): void;
  toWorker(msg: DeckToWorker, transfer?: Transferable[]): void;
}

interface Clip {
  name: string;
  pcm: Float32Array;
  words: WordTimes;
}

/** DeckOptions from AudioWorkletNode processorOptions (docs/protocol.md). */
export function deckOptionsFrom(po: DeckProcessorOptions | undefined): DeckOptions {
  const o = po ?? {};
  return {
    mode: deckModeOf(o.mode),
    ...(typeof o.gain === 'number' ? { gain: o.gain } : {}),
    ...(o.vadParams !== undefined ? { vadParams: o.vadParams } : {}),
    ...(typeof o.vadSource === 'string' && o.vadSource !== '' ? { vadSource: o.vadSource } : {}),
  };
}

/**
 * Full voice detector parameters from processorOptions.vadParams or a {k:'vad'} message: the
 * snake_case `vad` block of params/frozen.json, or (Partial) VadParams. Missing fields take
 * DEFAULT_VAD_PARAMS. Throws a RangeError on parameters core/vad cannot use.
 */
export function resolveDeckVadParams(raw: unknown): VadParams {
  if (raw === undefined || raw === null) return DEFAULT_VAD_PARAMS;
  if (typeof raw !== 'object' || Array.isArray(raw)) throw new RangeError('vadParams must be an object');
  const o = raw as Record<string, unknown>;
  if (Object.keys(o).some((k) => k.includes('_'))) return vadParamsFromFrozen(o);
  const params = resolveVadParams(o as Partial<VadParams>);
  // The record (a frozen block) has no sample rate: Deck runs at 48 kHz only (spec 7.3).
  if (params.sampleRateHz !== SAMPLE_RATE_HZ) throw new RangeError(`vadParams: sampleRateHz must be ${SAMPLE_RATE_HZ}`);
  createVad(params); // inconsistent values throw here, not in the audio thread later
  return params;
}

/** True when the parameters name the noise floor (floorDb, or floor_db of a frozen block). */
export function vadParamsNameFloor(raw: unknown): boolean {
  if (typeof raw !== 'object' || raw === null) return false;
  const o = raw as Record<string, unknown>;
  return typeof o['floorDb'] === 'number' || typeof o['floor_db'] === 'number';
}

/** dB of a mean square, 0.1 dB steps, floor -120 dB (meters). */
export function levelDb(meanSquare: number): number {
  if (!(meanSquare > 0)) return -120;
  return Math.max(-120, Math.round(100 * Math.log10(meanSquare)) / 10);
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export class DeckCore {
  readonly mode: DeckMode;
  private readonly sinks: DeckSinks;
  private readonly chestStops: boolean;
  private readonly keyStops: boolean;
  private readonly audioSafety: boolean;
  private readonly chunkSamples: number;
  private readonly levelWindow: number;
  private readonly clickOffsets: Readonly<Record<ClickBlock, readonly number[]>>;
  private readonly clickWave: Float32Array;

  /** First sample of the next quantum. */
  private nNext = 0;

  // Narrator (spec 6.4, 7.3)
  private state: NarratorState = 'idle';
  private cause: HoldCause | null = null;
  private readonly clips = new Map<string, Clip>();
  private clip: Clip | null = null;
  private ptr = 0;
  /** The read pointer advances while t < freezeAt; a stop sets it to nSilent. */
  private freezeAt = Infinity;
  private fadeOutStart = -1;
  private fadeOutFrom = 1;
  private fadeInStart = -1;
  private holdDeadline = Infinity;
  private resumeFrom: number | null = null;
  private resumeWord: number | null = null;
  private gain: number;

  // Voice detector (core/vad) and its edges, applied at their own sample
  private vad: VoiceDetector;
  /** False with a test detector (makeVad): there are no parameters to record or replace. */
  private readonly realVad: boolean;
  private vadNext: { params: VadParams; note: string | null } | null = null;
  private readonly edges: VoiceEdge[] = [];
  private edgeHead = 0;
  private voiceOn = false;
  private voiceOnN = 0;

  // Scenario
  private timeline: Timeline | null = null;
  private cueOn: number | null = null;
  private clickAt: number[] = [];
  private clickNext = 0;
  private clickStart = -1;
  private clickBlock: ClickBlock = 'A';

  // End
  private finishing = false;
  private doneAt = Infinity;
  private finished = false;

  // Recording and meters
  private rec0: Float32Array;
  private rec1: Float32Array;
  private recPos = 0;
  private recN0 = 0;
  private lvlSum0 = 0;
  private lvlSum1 = 0;
  private lvlCount = 0;
  private outScratch = new Float32Array(QUANTUM_SAMPLES);
  private zeroScratch = new Float32Array(QUANTUM_SAMPLES);

  constructor(opts: DeckOptions, sinks: DeckSinks) {
    this.mode = opts.mode ?? 'gate';
    this.sinks = sinks;
    this.chestStops = this.mode === 'live';
    this.keyStops = this.mode === 'key';
    this.audioSafety = narratorStops(this.mode);
    this.chunkSamples = opts.chunkSamples ?? CHUNK_SAMPLES;
    this.levelWindow = opts.levelWindowSamples ?? LEVEL_WINDOW_SAMPLES;
    this.gain = typeof opts.gain === 'number' && Number.isFinite(opts.gain) && opts.gain >= 0 ? opts.gain : 1;
    const loop = opts.clickOffsetsSamples ? [...opts.clickOffsetsSamples].sort((a, b) => a - b) : loopCheckClicks().offsetsSamples;
    const demo = opts.demoClickOffsetsSamples ? [...opts.demoClickOffsetsSamples].sort((a, b) => a - b) : demoClicks().offsetsSamples;
    this.clickOffsets = { A: loop, B: loop, demo };
    this.clickWave = opts.clickWaveform ?? loopCheckClicks().waveform;
    this.rec0 = new Float32Array(this.chunkSamples);
    this.rec1 = new Float32Array(this.chunkSamples);
    this.realVad = !opts.makeVad;
    this.vad = opts.makeVad ? opts.makeVad() : this.firstVad(opts.vadParams, opts.vadSource);
  }

  /** The detector of processorOptions, recorded from sample 0 (spec 7.3: analysis recomputes with these). */
  private firstVad(raw: unknown, note: string | undefined): VoiceDetector {
    let params = DEFAULT_VAD_PARAMS;
    let source: VadSource = 'default';
    let why: string | null = null;
    if (raw !== undefined && raw !== null) {
      try {
        params = resolveDeckVadParams(raw);
        source = 'options';
      } catch (err) {
        why = `unusable vadParams: ${errText(err)}`;
        this.error(`${why}; the voice detector runs on DEFAULT_VAD_PARAMS`);
      }
    }
    const vad = createVad(params);
    this.recordVad(0, source, params, why ?? note ?? null);
    return vad;
  }

  /** First sample of the quantum that will be processed next. */
  get n(): number {
    return this.nNext;
  }
  get narratorState(): NarratorState {
    return this.state;
  }
  get readPointer(): number {
    return this.ptr;
  }
  get isDone(): boolean {
    return this.finished;
  }

  // ---------------------------------------------------------------- messages

  onMainMessage(msg: MainToDeck): void {
    if (!msg || typeof msg !== 'object' || this.finished) return;
    const t = this.nNext;
    this.tick(t);
    if (this.finished) return;
    switch (msg.k) {
      case 'load':
        this.load(msg.name, msg.pcm, msg.timings);
        break;
      case 'scenario':
        this.setScenario(msg.steps, t);
        break;
      case 'go':
        this.timeline?.go(t);
        break;
      case 'gain':
        if (typeof msg.value === 'number' && Number.isFinite(msg.value) && msg.value >= 0) this.gain = msg.value;
        else this.error('gain: value must be a finite number >= 0');
        break;
      case 'key':
        this.key(t);
        break;
      case 'stop':
        this.beginFinish(t);
        break;
      case 'vad':
        this.requestVad(msg.params, msg.source, t);
        break;
      default:
        break;
    }
  }

  onWorkerMessage(msg: WorkerToDeck): void {
    if (!msg || typeof msg !== 'object' || this.finished || msg.k !== 'pkt') return;
    if (!Number.isSafeInteger(msg.seq) || msg.seq < 0) {
      this.error('pkt: seq must be a non-negative integer');
      return;
    }
    const t = this.nNext;
    this.tick(t);
    if (!this.finished) this.packet(msg.seq, msg.hold === true, t);
  }

  // ---------------------------------------------------------------- audio

  /** One render quantum: input channel 0 is the microphone; the narrator goes to every output channel. */
  process(input: Float32Array | undefined, outputs: readonly Float32Array[], frames?: number): void {
    const N = frames ?? outputs[0]?.length ?? input?.length ?? QUANTUM_SAMPLES;
    const n0 = this.nNext;
    if (this.outScratch.length < N) {
      this.outScratch = new Float32Array(N);
      this.zeroScratch = new Float32Array(N);
    }
    const out = this.outScratch;
    if (!this.finished && this.vadNext !== null) {
      this.tick(n0); // edges up to n0 decide whether the voice is off
      if (!this.finished) this.switchVadIfQuiet(n0);
    }
    if (this.finished) {
      for (const ch of outputs) ch.fill(0);
      this.nNext = n0 + N;
      return;
    }
    const mic = input && input.length >= N ? input : this.zeroScratch;
    const block = mic.length === N ? mic : mic.subarray(0, N);
    for (const e of this.vad.push(block, n0)) this.edges.push(e);
    for (let i = 0; i < N; i++) {
      const t = n0 + i;
      this.tick(t);
      if (this.finished) {
        out[i] = 0;
        continue;
      }
      out[i] = this.render(t);
      const x0 = block[i] as number;
      const x1 = out[i] as number;
      this.rec0[this.recPos] = x0;
      this.rec1[this.recPos] = x1;
      if (++this.recPos === this.chunkSamples) this.postChunk();
      this.lvlSum0 += x0 * x0;
      this.lvlSum1 += x1 * x1;
      if (++this.lvlCount === this.levelWindow) {
        this.sinks.toMain({ k: 'level', ch0Db: levelDb(this.lvlSum0 / this.lvlCount), ch1Db: levelDb(this.lvlSum1 / this.lvlCount) });
        this.lvlSum0 = 0;
        this.lvlSum1 = 0;
        this.lvlCount = 0;
      }
    }
    for (const ch of outputs) ch.set(N === out.length ? out : out.subarray(0, N));
    this.nNext = n0 + N;
  }

  // ---------------------------------------------------------------- timed rules (idempotent for one t)

  private tick(t: number): void {
    if (this.finished) return;
    // H expired without voice (spec 6.4). Before the edges: voice_on must come before nSilent + 72000.
    if (this.state === 'hold_wait' && t >= this.holdDeadline) this.resume(t);
    while (this.edgeHead < this.edges.length && (this.edges[this.edgeHead] as VoiceEdge).n <= t) {
      this.applyEdge(this.edges[this.edgeHead++] as VoiceEdge, t);
    }
    if (this.edgeHead === this.edges.length && this.edgeHead > 0) {
      this.edges.length = 0;
      this.edgeHead = 0;
    }
    if (this.state === 'narrating' && this.clip !== null && this.ptr >= this.clip.pcm.length) this.clipEnded(t);
    const tl = this.timeline;
    if (tl !== null) {
      for (let next = tl.nextStart; next !== null && t >= next; next = tl.nextStart) {
        const start = tl.enter(t);
        if (start === null) break;
        this.onStep(start, t);
      }
    }
    // Audio safety: voice_on and another 250 ms while narrating (spec 6.4). After the steps, so a
    // clip that starts while the voice has held 250 ms stops in its first sample.
    if (this.audioSafety && this.state === 'narrating' && this.voiceOn && t >= this.voiceOnN + VOICE_SAFETY_SAMPLES) {
      this.startStop(t, 'voice', null);
    }
    while (this.clickNext < this.clickAt.length && (this.clickAt[this.clickNext] as number) <= t) {
      const i = this.clickNext++;
      this.stamp({ n: t, k: 'click', i });
      this.sinks.toMain({ k: 'click', n: t, i, block: this.clickBlock });
      this.clickStart = t;
    }
    if (t >= this.doneAt) this.finalize(t);
  }

  private applyEdge(e: VoiceEdge, t: number): void {
    this.stamp({ n: e.n, k: 'voice', on: e.on });
    if (e.on) {
      this.voiceOn = true;
      this.voiceOnN = e.n;
      if (this.state === 'hold_wait') this.setState('listening', t);
    } else {
      this.voiceOn = false;
      if (this.state === 'listening') this.resume(t);
    }
  }

  // ---------------------------------------------------------------- voice detector parameters

  /** {k:'vad'}: checked now, applied from the first quantum without voice (switchVadIfQuiet). */
  private requestVad(raw: unknown, source: unknown, t: number): void {
    if (!this.realVad) {
      this.error('vad: this Deck runs a test voice detector');
      return;
    }
    if (!vadParamsNameFloor(raw)) {
      this.error('vad: the parameters must name the floor (floorDb or floor_db)');
      return;
    }
    let params: VadParams;
    try {
      params = resolveDeckVadParams(raw);
    } catch (err) {
      this.error(`vad: unusable parameters (${errText(err)}); the voice detector keeps its parameters`);
      return;
    }
    this.vadNext = { params, note: typeof source === 'string' && source !== '' ? source : null };
    this.switchVadIfQuiet(t);
  }

  /**
   * A new detector starts at quantum boundary n, only while no voice is on: a voice_on of the old
   * detector would otherwise never get its voice_off. Offline, the edges are vadEdges() of the
   * samples before n with the old parameters, then of the samples from n with the new ones.
   */
  private switchVadIfQuiet(n: number): void {
    const next = this.vadNext;
    if (next === null || this.voiceOn) return;
    this.vadNext = null;
    this.vad = createVad(next.params);
    this.recordVad(n, 'message', next.params, next.note);
  }

  private recordVad(n: number, source: VadSource, params: VadParams, note: string | null): void {
    const msg: VadMessage =
      note === null
        ? { k: 'vad', n, source, params: vadFrozenBlock(params) }
        : { k: 'vad', n, source, note, params: vadFrozenBlock(params) };
    this.sinks.toWorker(msg);
  }

  // ---------------------------------------------------------------- narrator (spec 6.4)

  private packet(seq: number, hold: boolean, t: number): void {
    this.stamp({ n: t, k: 'arr', seq });
    if (!hold) return;
    if (this.chestStops && this.state === 'narrating' && !this.finishing) this.startStop(t, 'chest', seq);
    else this.stamp({ n: t, k: 'ignored', what: 'hold', seq, s: this.state });
  }

  private key(t: number): void {
    this.stamp({ n: t, k: 'mark', what: 'key' });
    if (this.keyStops && this.state === 'narrating' && !this.finishing) this.startStop(t, 'key', null);
    else this.stamp({ n: t, k: 'ignored', what: 'key', s: this.state });
  }

  /** Stop at nCmd = t: linear fade over 384 samples; the read pointer freezes at nSilent (spec 6.2, 7.3). */
  private startStop(t: number, cause: HoldCause, seq: number | null): void {
    const clip = this.clip as Clip;
    const plan = stopPlan(clip.words, this.ptr);
    this.resumeFrom = plan.resumeFrom;
    this.resumeWord = plan.resumeWord;
    this.fadeOutFrom = this.envelope(t);
    this.fadeOutStart = t;
    this.fadeInStart = -1;
    const nSilent = t + FADE_OUT_SAMPLES;
    this.freezeAt = nSilent;
    this.cause = cause;
    if (cause === 'chest') this.stamp({ n: t, k: 'hold', cause, seq: seq as number, nSilent, word: plan.word });
    else this.stamp({ n: t, k: 'hold', cause, nSilent, word: plan.word });
    if (cause === 'voice') {
      this.holdDeadline = Infinity;
      this.setState('listening', t);
      return;
    }
    this.holdDeadline = nSilent + HOLD_WAIT_SAMPLES;
    this.setState('hold_wait', t);
    if (this.voiceOn) this.setState('listening', t); // voice already going: wait for the end of the reply
  }

  /** RESUME, then NARRATING at t: from the start of the interrupted (or next) word, 10 ms fade-in (spec 6.4). */
  private resume(t: number): void {
    this.setState('resume', t);
    this.stamp({ n: t, k: 'resume', word: this.resumeWord });
    if (this.resumeFrom !== null) this.ptr = this.resumeFrom;
    this.freezeAt = Infinity;
    this.fadeOutStart = -1;
    this.fadeInStart = t;
    this.holdDeadline = Infinity;
    this.cause = null;
    this.setState('narrating', t);
  }

  private envelope(t: number): number {
    if (this.fadeOutStart >= 0) {
      const j = t - this.fadeOutStart;
      return j >= FADE_OUT_SAMPLES ? 0 : (this.fadeOutFrom * (FADE_OUT_SAMPLES - j)) / FADE_OUT_SAMPLES;
    }
    if (this.fadeInStart >= 0) {
      const j = t - this.fadeInStart;
      return j >= FADE_IN_SAMPLES ? 1 : (j + 1) / FADE_IN_SAMPLES;
    }
    return 1;
  }

  private render(t: number): number {
    let x = 0;
    const clip = this.clip;
    if (clip !== null && t < this.freezeAt) {
      if (this.ptr < clip.pcm.length) x = (clip.pcm[this.ptr] as number) * this.envelope(t);
      this.ptr++;
    }
    if (this.clickStart >= 0) {
      const j = t - this.clickStart;
      if (j < this.clickWave.length) x += this.clickWave[j] as number;
      else this.clickStart = -1;
    }
    return x * this.gain;
  }

  private setState(s: NarratorState, t: number): void {
    this.state = s;
    this.stamp({ n: t, k: 'state', s });
    this.sinks.toMain({ k: 'state', n: t, s, cause: s === 'hold_wait' || s === 'listening' ? this.cause : null });
  }

  private clipEnded(t: number): void {
    this.clip = null;
    this.freezeAt = Infinity;
    this.fadeInStart = -1;
    this.fadeOutStart = -1;
    this.cause = null;
    this.setState('idle', t);
    if (this.timeline?.waitsForClip) this.timeline.clipEnded(t);
  }

  private load(name: unknown, pcm: unknown, timings: unknown): void {
    if (typeof name !== 'string' || name === '' || !(pcm instanceof Float32Array)) {
      this.error('load: a name and a Float32Array pcm are required');
      return;
    }
    let words: WordTimes = NO_WORDS;
    if (timings !== undefined && timings !== null) {
      try {
        words = normalizeWordTimings(timings);
      } catch (err) {
        this.error(`load ${name}: ${errText(err)}; the clip resumes where it froze`);
      }
    }
    this.clips.set(name, { name, pcm, words });
  }

  // ---------------------------------------------------------------- scenario (docs/protocol.md)

  private setScenario(steps: unknown, t: number): void {
    if (this.timeline !== null || this.finishing) {
      this.error('scenario: Deck runs one scenario');
      return;
    }
    const problems = scenarioProblems(steps, { narratorStops: narratorStops(this.mode) });
    if (problems.length > 0) {
      this.error(`scenario: ${problems.join('; ')}`);
      return;
    }
    this.timeline = new Timeline(steps as Step[], t);
  }

  private onStep(start: StepStart, t: number): void {
    const st = start.step;
    this.stamp({ n: t, k: 'mark', what: 'step', name: st.name });
    this.sinks.toMain({ k: 'step', n: t, name: st.name, text: st.text });
    switch (st.k) {
      case 'cue':
        this.setCue(st.i, st.on, t);
        break;
      case 'play':
        this.startClip(st.clip, st.untilClipEnd === true, t);
        break;
      case 'clicks': {
        // scenarioProblems admitted only CLICK_BLOCKS; the demo block is not in the page's step type yet.
        const block = st.block as ClickBlock;
        this.clickBlock = block;
        this.clickAt = this.clickOffsets[block].map((o) => t + o);
        this.clickNext = 0;
        break;
      }
      case 'end':
        this.beginFinish(t);
        break;
      default:
        break;
    }
  }

  /**
   * A play step: the clip starts at its first sample; it plays to its end, a later play or the end.
   * Where something can stop the narrator, play steps wait for the clip's end (scenarioProblems),
   * so a clip never starts in HOLD_WAIT or LISTENING.
   */
  private startClip(name: string, untilEnd: boolean, t: number): void {
    const clip = this.clips.get(name);
    if (!clip) {
      this.error(`play: clip ${name} is not loaded`);
      if (untilEnd) this.timeline?.clipEnded(t);
      return;
    }
    this.clip = clip;
    this.ptr = 0;
    this.freezeAt = Infinity;
    this.fadeOutStart = -1;
    this.fadeInStart = -1;
    this.holdDeadline = Infinity;
    this.cause = null;
    if (this.state !== 'narrating') this.setState('narrating', t);
  }

  private setCue(i: number, on: boolean, t: number): void {
    this.cueOn = on ? i : null;
    this.stamp({ n: t, k: 'mark', i, what: 'cue', on });
    this.sinks.toMain({ k: 'cue', n: t, on });
  }

  /** End step, Stop or abort: no further steps or clicks, the narrator fades out over 8 ms, then done. */
  private beginFinish(t: number): void {
    if (this.finishing) return;
    this.finishing = true;
    this.timeline?.stop();
    let quietAt = t;
    if (this.clip !== null && t < this.freezeAt) {
      if (this.fadeOutStart < 0) {
        this.fadeOutFrom = this.envelope(t);
        this.fadeOutStart = t;
        this.fadeInStart = -1;
        this.freezeAt = t + FADE_OUT_SAMPLES;
      }
      quietAt = this.freezeAt;
    }
    this.holdDeadline = Infinity;
    this.clickAt = [];
    this.clickNext = 0;
    if (this.state !== 'idle') {
      this.cause = null;
      this.setState('idle', t);
    }
    if (this.cueOn !== null) this.setCue(this.cueOn, false, t);
    const clickEnd = this.clickStart >= 0 ? this.clickStart + this.clickWave.length : t;
    this.doneAt = Math.max(quietAt, clickEnd, t);
    if (this.doneAt <= t) this.finalize(t);
  }

  /** Last partial chunk, then done to the worker (after its last frame) and to the page. */
  private finalize(t: number): void {
    if (this.finished) return;
    this.finished = true;
    if (this.recPos > 0) {
      const ch0 = this.rec0.slice(0, this.recPos);
      const ch1 = this.rec1.slice(0, this.recPos);
      this.sinks.toWorker({ k: 'chunk', n0: this.recN0, frames: this.recPos, ch0, ch1 }, [ch0.buffer, ch1.buffer]);
      this.recN0 += this.recPos;
      this.recPos = 0;
    }
    this.sinks.toWorker({ k: 'done', n: t });
    this.sinks.toMain({ k: 'done', n: t });
  }

  // ---------------------------------------------------------------- output

  private postChunk(): void {
    const ch0 = this.rec0;
    const ch1 = this.rec1;
    this.sinks.toWorker({ k: 'chunk', n0: this.recN0, frames: this.chunkSamples, ch0, ch1 }, [ch0.buffer, ch1.buffer]);
    this.recN0 += this.chunkSamples;
    this.recPos = 0;
    this.rec0 = new Float32Array(this.chunkSamples);
    this.rec1 = new Float32Array(this.chunkSamples);
  }

  private stamp(line: DeckStamp): void {
    this.sinks.toWorker({ k: 'stamp', line });
  }

  private error(message: string): void {
    this.sinks.toMain({ k: 'error', message });
  }
}
