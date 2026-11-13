// Test-only driver for DeckCore: runs quanta, scripts voice edges, collects every output.

import { DeckCore, type DeckOptions, type VoiceEdge } from '../deck-core.ts';
import type { DeckStamp, DeckToMain, DeckToWorker, MainToDeck, WorkerToDeck } from '../messages.ts';
import type { Step } from '../../scenarios/format.ts';
import { QUANTUM_SAMPLES } from '../units.ts';

export interface ChunkMsg {
  n0: number;
  frames: number;
  ch0: Float32Array;
  ch1: Float32Array;
}

export interface SimOptions extends DeckOptions {
  /** Voice edges reported by a scripted detector in the quantum whose push covers their n (as core/vad does). */
  edges?: VoiceEdge[];
  /** Microphone samples by absolute sample number; zeros when absent. */
  mic?: (n: number) => number;
}

export class DeckSim {
  readonly deck: DeckCore;
  readonly main: DeckToMain[] = [];
  readonly stamps: DeckStamp[] = [];
  readonly chunks: ChunkMsg[] = [];
  /** Everything Deck sent to the worker, in order. */
  readonly toWorker: DeckToWorker[] = [];
  /** Rendered output, index = sample number. */
  readonly out: number[] = [];
  private readonly mic: ((n: number) => number) | undefined;

  constructor(opts: SimOptions = {}) {
    const script = (opts.edges ?? []).slice().sort((a, b) => a.n - b.n);
    this.mic = opts.mic;
    const vad = {
      push(block: Float32Array, n0: number): VoiceEdge[] {
        const end = n0 + block.length;
        const due: VoiceEdge[] = [];
        while (script.length && (script[0] as VoiceEdge).n <= end) due.push(script.shift() as VoiceEdge);
        return due;
      },
    };
    this.deck = new DeckCore(
      {
        ...opts,
        mode: opts.mode ?? 'live',
        makeVad: opts.makeVad ?? (() => vad),
        clickOffsetsSamples: opts.clickOffsetsSamples ?? [4800, 14400, 30000],
        clickWaveform: opts.clickWaveform ?? new Float32Array([0.5, -0.5, 0.25, -0.25]),
      },
      {
        toMain: (m) => this.main.push(m),
        toWorker: (m) => {
          this.toWorker.push(m);
          if (m.k === 'stamp') this.stamps.push(m.line);
          else if (m.k === 'chunk') this.chunks.push({ n0: m.n0, frames: m.frames, ch0: m.ch0, ch1: m.ch1 });
        },
      },
    );
  }

  get n(): number {
    return this.deck.n;
  }

  quantum(frames = QUANTUM_SAMPLES): void {
    const n0 = this.deck.n;
    const input = new Float32Array(frames);
    if (this.mic) for (let i = 0; i < frames; i++) input[i] = this.mic(n0 + i);
    const out = new Float32Array(frames);
    this.deck.process(input, [out], frames);
    for (let i = 0; i < frames; i++) this.out[n0 + i] = out[i] as number;
  }

  /** Runs whole quanta until the clock reaches at least n. */
  runTo(n: number): void {
    while (this.deck.n < n) this.quantum();
  }

  send(msg: MainToDeck): void {
    this.deck.onMainMessage(msg);
  }

  /** load + scenario, as the page sends them. */
  start(clips: Array<{ name: string; pcm: Float32Array; timings?: unknown }>, steps: Step[]): void {
    for (const c of clips) this.send({ k: 'load', name: c.name, pcm: c.pcm.slice(), timings: c.timings ?? null });
    this.send({ k: 'scenario', steps });
  }

  worker(msg: WorkerToDeck): void {
    this.deck.onWorkerMessage(msg);
  }

  pkt(seq: number, hold: boolean): void {
    this.worker({ k: 'pkt', seq, hold });
  }

  of<K extends DeckStamp['k']>(k: K): Extract<DeckStamp, { k: K }>[] {
    return this.stamps.filter((s) => s.k === k) as Extract<DeckStamp, { k: K }>[];
  }

  states(): Array<[number, string]> {
    return this.of('state').map((s) => [s.n, s.s]);
  }

  mainOf<K extends DeckToMain['k']>(k: K): Extract<DeckToMain, { k: K }>[] {
    return this.main.filter((m) => m.k === k) as Extract<DeckToMain, { k: K }>[];
  }
}

/** A play step for one clip and the end step (lenSamples of the play step: long enough by default). */
export function playThenEnd(clip: string, opts: { untilClipEnd?: boolean; lenSamples?: number } = {}): Step[] {
  const play: Step = opts.untilClipEnd
    ? { k: 'play', name: `play_${clip}`, text: '', lenSamples: 0, clip, untilClipEnd: true }
    : { k: 'play', name: `play_${clip}`, text: '', lenSamples: opts.lenSamples ?? 48_000 * 600, clip };
  return [play, { k: 'end', name: 'end', text: '', lenSamples: 0 }];
}
