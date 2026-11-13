// Test page: one AudioContext at 48 kHz, the fake microphone into Deck, Deck into the destination,
// wired as web/ui/session.ts does it (docs/protocol.md). worker 'real' runs web/worker.ts against the
// fake host; worker 'page' lets this page play the worker's part on the direct port (forwarding to
// /session), so a test can time holds itself. Test code may use timers; the app code under test does not.

import type { Step } from '../../../web/scenarios/format.ts';
import { encodeChunkFrame } from '../../../web/lib/chk1.ts';
import type { DeckStamp, DeckToMain, DeckToWorker, DetectorSetup, VadMessage, WorkerToMain } from '../../../web/lib/messages.ts';
import { synthPassage, type SynthWord } from '../../../web/lib/testing/synth.ts';
import { msToSamples } from '../../../web/lib/units.ts';

export interface HarnessConfig {
  /** /api/config `mode` (host mode name). */
  mode: string;
  worker: 'page' | 'real';
  sessionUrl: string;
  tapUrl?: string | null;
  detector?: DetectorSetup | null;
  gain?: number;
  /** processorOptions.vadParams and vadSource (docs/protocol.md). */
  vadParams?: Record<string, unknown> | null;
  vadSource?: string;
  passages: Array<{ name: string; words: SynthWord[]; totalMs: number }>;
  steps: Step[];
  /** worker 'page': send pkt hold:true as soon as these voice_on stamps arrive (0-based count). */
  chestOnVoiceOn?: number[];
  /** worker 'page': probe with pkt hold:true this long after the audio safety stopped the narrator. */
  probeAfterSafetyMs?: number | null;
  /** worker 'page': release a button wait ({k:'go'}) this long after the first voice_on stamp. */
  goAfterVoiceOnMs?: number | null;
}

export interface HarnessResult {
  main: DeckToMain[];
  stamps: DeckStamp[];
  fromWorker: WorkerToMain[];
  sentPkts: Array<{ seq: number; hold: boolean; why: string }>;
  /** worker 'page': Deck's voice detector records, as the worker gets them. */
  vads: VadMessage[];
  errors: string[];
  settings: unknown;
}

class Harness {
  readonly main: DeckToMain[] = [];
  readonly stamps: DeckStamp[] = [];
  readonly fromWorker: WorkerToMain[] = [];
  readonly sentPkts: Array<{ seq: number; hold: boolean; why: string }> = [];
  readonly vads: VadMessage[] = [];
  readonly errors: string[] = [];
  done = false;
  doneN = -1;
  closed = false;
  settings: unknown = null;
  private ctx: AudioContext | null = null;
  private node: AudioWorkletNode | null = null;
  private port2: MessagePort | null = null;
  private ws: WebSocket | null = null;
  private worker: Worker | null = null;
  private seq = 1_000_000;
  private voiceOns = 0;
  private cfg: HarnessConfig | null = null;
  private clockOffset = Infinity;
  private readonly words = new Map<string, SynthWord[]>();
  private current: Step | null = null;
  private sdkOk = false;
  private goSent = false;
  private goAfterVoiceScheduled = false;
  private currentPassage: string | null = null;
  private ptrBase: { n: number; ptr: number } | null = null;
  private pendingResumeWord: number | null = null;

  async start(cfg: HarnessConfig): Promise<void> {
    this.cfg = cfg;
    window.addEventListener('error', (e) => this.errors.push(`error: ${e.message}`));
    window.addEventListener('unhandledrejection', (e) => this.errors.push(`rejection: ${String(e.reason)}`));
    const ctx = new AudioContext({ sampleRate: 48_000, latencyHint: 'interactive' });
    this.ctx = ctx;
    await ctx.audioWorklet.addModule(new URL('../../../web/deck.worklet.ts', import.meta.url));
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, echoCancellation: false, noiseSuppression: false, autoGainControl: false },
    });
    this.settings = stream.getAudioTracks()[0]?.getSettings() ?? null;
    const src = ctx.createMediaStreamSource(stream);
    const node = new AudioWorkletNode(ctx, 'deck', {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      outputChannelCount: [1],
      channelCount: 1,
      channelCountMode: 'explicit',
      processorOptions: {
        mode: cfg.mode,
        gain: cfg.gain ?? 1,
        ...(cfg.vadParams ? { vadParams: cfg.vadParams } : {}),
        ...(cfg.vadSource ? { vadSource: cfg.vadSource } : {}),
      },
    });
    this.node = node;
    node.port.onmessage = (ev: MessageEvent) => this.onDeckMain(ev.data as DeckToMain);
    const ch = new MessageChannel();
    node.port.postMessage({ k: 'port', port: ch.port1 }, [ch.port1]);
    const at = new Date().toISOString();
    if (cfg.worker === 'page') {
      const ws = new WebSocket(cfg.sessionUrl);
      ws.binaryType = 'arraybuffer';
      this.ws = ws;
      await new Promise<void>((resolve, reject) => {
        ws.onopen = () => resolve();
        ws.onerror = () => reject(new Error('session socket'));
      });
      ws.send(JSON.stringify({ t: 'hello', ua: navigator.userAgent, settings: this.settings }));
      ws.send(JSON.stringify({ t: 'consent', at }));
      this.port2 = ch.port2;
      ch.port2.onmessage = (ev: MessageEvent) => this.onDeckWorker(ev.data as DeckToWorker);
    } else {
      const worker = new Worker(new URL('../../../web/worker.ts', import.meta.url), { type: 'module' });
      this.worker = worker;
      worker.onerror = (e) => this.errors.push(`worker: ${e.message}`);
      worker.onmessage = (ev: MessageEvent) => this.onWorker(ev.data as WorkerToMain);
      const config = { mode: cfg.mode, tapUrl: cfg.tapUrl ?? null, sessionUrl: cfg.sessionUrl, detector: cfg.detector ?? null };
      worker.postMessage({ k: 'init', config, port: ch.port2 }, [ch.port2]);
      worker.postMessage({ k: 'hello', ua: navigator.userAgent, settings: this.settings });
      worker.postMessage({ k: 'consent', at });
    }
    for (const p of cfg.passages) {
      const pcm = synthPassage(p.words, p.totalMs);
      this.words.set(p.name, p.words);
      node.port.postMessage({ k: 'load', name: p.name, pcm, timings: p.words }, [pcm.buffer]);
    }
    node.port.postMessage({ k: 'scenario', steps: cfg.steps });
    src.connect(node);
    node.connect(ctx.destination);
  }

  /** Deck's sample clock against AudioContext.currentTime: the smallest offset seen (least delay). */
  private seeN(n: number): void {
    if (this.ctx) this.clockOffset = Math.min(this.clockOffset, this.ctx.currentTime * 48_000 - n);
  }

  private onWorker(m: WorkerToMain): void {
    this.fromWorker.push(m);
    if (m.k === 'sdk') {
      this.sdkOk = m.ok;
      this.maybeGo();
    }
    if (m.k === 'error') this.errors.push(`worker: ${m.message}`);
    if (m.k === 'closed') this.closed = true;
  }

  /** As web/ui/run.ts: a wait sdk_ok step is released when the worker reports ok. */
  private maybeGo(): void {
    const s = this.current;
    if (this.goSent || !this.sdkOk || !s || s.k !== 'wait' || s.until !== 'sdk_ok') return;
    this.goSent = true;
    this.node?.port.postMessage({ k: 'go' });
  }

  private onDeckMain(m: DeckToMain): void {
    this.main.push(m);
    if ('n' in m) this.seeN(m.n);
    if (m.k === 'step') {
      this.current = this.cfg?.steps.find((s) => s.name === m.name) ?? null;
      this.goSent = false;
      if (this.current?.k === 'play') this.currentPassage = this.current.clip;
      this.maybeGo();
    }
    if (m.k === 'state' && m.s === 'listening' && m.cause === 'voice' && this.cfg?.probeAfterSafetyMs != null) {
      setTimeout(() => this.pkt(true, 'probe'), this.cfg.probeAfterSafetyMs);
    }
    if (m.k === 'error') this.errors.push(`deck: ${m.message}`);
    if (m.k === 'done') {
      this.done = true;
      this.doneN = m.n;
      this.worker?.postMessage({ k: 'end', reason: 'done' });
    }
  }

  /** worker 'page': what the worker forwards to /session. */
  private onDeckWorker(m: DeckToWorker): void {
    if (m.k === 'chunk') {
      this.ws?.send(encodeChunkFrame(m.n0, m.ch0, m.ch1));
      return;
    }
    if (m.k === 'done') {
      // Deck's last block and stamp came before this on the same port.
      this.ws?.send(JSON.stringify({ t: 'end', reason: 'done' }));
      this.closed = true;
      return;
    }
    if (m.k === 'vad') {
      // As the worker: one events.jsonl line with the parameters from sample n on.
      this.vads.push(m);
      const line = { n: m.n, e: 'vad', source: m.source, ...(m.note !== undefined ? { note: m.note } : {}), params: m.params };
      this.ws?.send(JSON.stringify({ t: 'event', line }));
      return;
    }
    const line = m.line;
    this.seeN(line.n);
    this.stamps.push(line);
    this.ws?.send(JSON.stringify({ t: 'stamp', line }));
    if (line.k === 'voice' && line.on) {
      if (this.cfg?.chestOnVoiceOn?.includes(this.voiceOns)) this.pkt(true, 'chest-after-voice');
      this.voiceOns++;
      const goMs = this.cfg?.goAfterVoiceOnMs;
      if (goMs != null && !this.goAfterVoiceScheduled) {
        this.goAfterVoiceScheduled = true;
        setTimeout(() => this.node?.port.postMessage({ k: 'go' }), goMs);
      }
    }
    if (line.k === 'resume') this.pendingResumeWord = line.word;
    if (line.k === 'state' && line.s === 'narrating') {
      const words = this.words.get(this.currentPassage ?? '') ?? [];
      const w = this.pendingResumeWord === null ? undefined : words[this.pendingResumeWord];
      this.ptrBase = { n: line.n, ptr: w ? msToSamples(w.startMs) : 0 };
      this.pendingResumeWord = null;
    }
    if (line.k === 'state' && line.s !== 'narrating') this.ptrBase = null;
  }

  /** worker 'page' only: one SDK packet message to Deck. */
  pkt(hold: boolean, why = 'test'): number {
    const seq = this.seq++;
    this.sentPkts.push({ seq, hold, why });
    this.port2?.postMessage({ k: 'pkt', seq, hold });
    return seq;
  }

  /** Estimated Deck clock now (test timing only). */
  nowN(): number {
    if (!this.ctx || !Number.isFinite(this.clockOffset)) return -1;
    return this.ctx.currentTime * 48_000 - this.clockOffset;
  }

  /** worker 'page' only: waits until the read pointer passes `ptr` while narrating, then sends a hold. */
  async holdAtPtr(ptr: number, why = 'test'): Promise<number> {
    for (;;) {
      await new Promise((r) => setTimeout(r, 2));
      const base = this.ptrBase;
      const now = this.nowN();
      if (base && now >= 0 && base.ptr + (now - base.n) >= ptr) return this.pkt(true, why);
      if (this.done) throw new Error('scenario ended before the hold');
    }
  }

  result(): HarnessResult {
    return {
      main: this.main, stamps: this.stamps, fromWorker: this.fromWorker, sentPkts: this.sentPkts,
      vads: this.vads, errors: this.errors, settings: this.settings,
    };
  }
}

declare global {
  interface Window {
    H: Harness;
  }
}

window.H = new Harness();
