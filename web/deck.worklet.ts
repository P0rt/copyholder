// Audio worklet `deck` (spec 6.1, 7.3): the AudioWorkletProcessor shell around DeckCore, which holds
// the player, the fades, the narrator states, the recording, the clicks, the voice detector and the
// scenario clock. Input 0 channel 0 is the microphone; output 0 is the narrator.
// The page loads it with `import deckUrl from './deck.worklet.ts?worker&url'` and `audioWorklet.addModule(deckUrl)`.

import { DeckCore, deckOptionsFrom } from './lib/deck-core.ts';
import type { DeckProcessorOptions, DeckToWorker, MainToDeck, WorkerToDeck } from './lib/messages.ts';
import { QUANTUM_SAMPLES, SAMPLE_RATE_HZ } from './lib/units.ts';

// AudioWorkletGlobalScope names (TypeScript ships no lib for them).
declare const sampleRate: number;
declare class AudioWorkletProcessor {
  readonly port: MessagePort;
  constructor(options?: unknown);
}
declare function registerProcessor(name: string, ctor: new (options: { processorOptions?: unknown }) => AudioWorkletProcessor): void;

/** Messages kept for the worker until the page hands over the port (it does so first, docs/protocol.md). */
const MAX_QUEUED_FOR_WORKER = 4_096;

class DeckProcessor extends AudioWorkletProcessor {
  private readonly core: DeckCore;
  private workerPort: MessagePort | null = null;
  private readonly queued: Array<[DeckToWorker, Transferable[]]> = [];
  private overflowReported = false;

  constructor(options: { processorOptions?: unknown }) {
    super(options);
    this.core = new DeckCore(deckOptionsFrom(options?.processorOptions as DeckProcessorOptions | undefined), {
      toMain: (msg) => this.port.postMessage(msg),
      toWorker: (msg, transfer) => this.toWorker(msg, transfer ?? []),
    });
    if (sampleRate !== SAMPLE_RATE_HZ) {
      this.port.postMessage({ k: 'error', message: `Deck: sample rate ${sampleRate} Hz, expected ${SAMPLE_RATE_HZ}` });
    }
    this.port.onmessage = (ev: MessageEvent) => {
      const msg = ev.data as MainToDeck | null;
      if (!msg || typeof msg !== 'object') return;
      if (msg.k === 'port') this.attachWorker(msg.port);
      else this.core.onMainMessage(msg);
    };
  }

  private attachWorker(port: MessagePort): void {
    if (this.workerPort) return;
    this.workerPort = port;
    port.onmessage = (ev: MessageEvent) => this.core.onWorkerMessage(ev.data as WorkerToDeck);
    for (const [msg, transfer] of this.queued.splice(0)) port.postMessage(msg, transfer);
  }

  private toWorker(msg: DeckToWorker, transfer: Transferable[]): void {
    if (this.workerPort) this.workerPort.postMessage(msg, transfer);
    else if (this.queued.length < MAX_QUEUED_FOR_WORKER) this.queued.push([msg, transfer]);
    else if (!this.overflowReported) {
      this.overflowReported = true;
      this.port.postMessage({ k: 'error', message: 'Deck: no worker port; recording blocks are lost' });
    }
  }

  process(inputs: Float32Array[][], outputs: Float32Array[][]): boolean {
    const out = outputs[0] ?? [];
    this.core.process(inputs[0]?.[0], out, out[0]?.length ?? inputs[0]?.[0]?.length ?? QUANTUM_SAMPLES);
    return true;
  }
}

registerProcessor('deck', DeckProcessor);
