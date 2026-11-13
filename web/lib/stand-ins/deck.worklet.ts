// Stand-in for web/deck.worklet.ts, for page tests only (vite --mode standins): an AudioWorkletProcessor
// named 'deck' that follows the main-thread side of docs/protocol.md. It runs the scenario with
// ScenarioRunner, reports steps, cues, levels and done (also after stop, as Deck does), plays loaded
// clips at speed 1 and stamps the worker's packets. processorOptions.standinSpeed (tests only) moves
// the sample count that many times faster than real time; the output is then silent.
import { ScenarioRunner } from '../../scenarios/runner.ts';
import type { FromDeck, ToDeck } from '../../ui/messages.ts';

// AudioWorkletGlobalScope names (not in the TypeScript DOM library).
declare function registerProcessor(name: string, ctor: new (options?: AudioWorkletNodeOptions) => StandInProcessorBase): void;
declare class StandInProcessorBase {
  readonly port: MessagePort;
  constructor(options?: AudioWorkletNodeOptions);
}
const Base: typeof StandInProcessorBase = (globalThis as unknown as { AudioWorkletProcessor: typeof StandInProcessorBase }).AudioWorkletProcessor;

const QUANTUM = 128;
const LEVEL_EVERY_QUANTA = 38; // about 10 level reports per second of real time

function db(sumSquares: number, count: number): number {
  return count > 0 && sumSquares > 0 ? 10 * Math.log10(sumSquares / count) : -120;
}

class StandInDeck extends Base {
  private n = 0;
  private readonly speed: number;
  private runner: ScenarioRunner | null = null;
  private readonly clips = new Map<string, Float32Array>();
  private playing: { pcm: Float32Array; at: number } | null = null;
  private gain = 1;
  private stopped = false;
  private quanta = 0;
  private worker: MessagePort | null = null;

  constructor(options?: AudioWorkletNodeOptions) {
    super(options);
    const speed = Number((options?.processorOptions as { standinSpeed?: unknown } | undefined)?.standinSpeed ?? 1);
    this.speed = Number.isFinite(speed) && speed >= 1 ? Math.floor(speed) : 1;
    this.port.onmessage = (e: MessageEvent<ToDeck>) => this.onMain(e.data);
  }

  private post(msg: FromDeck): void {
    this.port.postMessage(msg);
  }

  private onMain(msg: ToDeck): void {
    switch (msg.k) {
      case 'port':
        this.worker = msg.port;
        this.worker.onmessage = (e: MessageEvent<{ k: string; seq?: number }>) => {
          if (e.data.k === 'pkt') this.worker?.postMessage({ k: 'stamp', line: { n: this.n, k: 'arr', seq: e.data.seq } });
        };
        break;
      case 'load':
        this.clips.set(msg.name, msg.pcm);
        break;
      case 'scenario':
        this.runner = new ScenarioRunner(msg.steps);
        this.runner.start(this.n);
        break;
      case 'go':
        this.runner?.go(this.n);
        break;
      case 'gain':
        this.gain = msg.value;
        break;
      case 'stop':
        if (this.stopped) break;
        this.stopped = true;
        this.playing = null;
        this.runner?.stop();
        this.post({ k: 'done', n: this.n });
        break;
      default:
        break;
    }
  }

  process(inputs: Float32Array[][], outputs: Float32Array[][]): boolean {
    const out = outputs[0]?.[0];
    const mic = inputs[0]?.[0];
    const span = QUANTUM * this.speed;
    for (const s of this.runner?.advance(this.n + span) ?? []) {
      const step = s.step;
      this.post({ k: 'step', n: s.n, name: step.name, text: step.text });
      this.worker?.postMessage({ k: 'stamp', line: { n: s.n, k: 'mark', what: 'step', name: step.name } });
      if (step.k === 'cue') this.post({ k: 'cue', n: s.n, on: step.on });
      if (step.k === 'play') {
        const pcm = this.clips.get(step.clip);
        this.playing = pcm ? { pcm, at: 0 } : null;
      }
      if (step.k === 'end') {
        this.playing = null;
        this.post({ k: 'done', n: s.n });
      }
    }
    let outSq = 0;
    if (out) {
      out.fill(0);
      if (this.playing && this.speed === 1 && !this.stopped) {
        const { pcm } = this.playing;
        for (let i = 0; i < out.length && this.playing.at < pcm.length; i += 1, this.playing.at += 1) {
          const v = (pcm[this.playing.at] ?? 0) * this.gain;
          out[i] = v;
          outSq += v * v;
        }
      }
    }
    let micSq = 0;
    for (const v of mic ?? []) micSq += v * v;
    this.quanta += 1;
    if (this.quanta % LEVEL_EVERY_QUANTA === 0) this.post({ k: 'level', ch0Db: db(micSq, mic?.length ?? 0), ch1Db: db(outSq, out?.length ?? 0) });
    this.n += span;
    return true;
  }
}

registerProcessor('deck', StandInDeck);
