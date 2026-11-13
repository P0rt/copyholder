// Reference semantics of the step format on sample numbers alone (spec 6.1, 7.3: no timers): advance()
// once per render quantum returns every step that starts inside it, with its exact start sample.
// The stand-in Deck and the tests run it; the real Deck runs the same rules (docs/protocol.md).
// Pure: no I/O, no clocks; the caller passes every sample number.
import { assertScenario, type Step, type WaitStep } from './format.ts';

export interface StepStart {
  index: number;
  step: Step;
  /** Absolute sample number at which the step starts. */
  n: number;
}

type Block = 'go' | 'clip_end' | null;

export class ScenarioRunner {
  readonly steps: readonly Step[];
  private nextIndex = 0;
  /** Start of steps[nextIndex]; null while a wait, a clip end or the end blocks it. */
  private nextStartN: number | null = null;
  private blockedBy: Block = null;
  private started = false;
  private stopped = false;
  private lastStart: StepStart | null = null;
  private readonly startByName = new Map<string, number>();

  constructor(steps: readonly Step[]) {
    assertScenario(steps);
    this.steps = steps;
  }

  /** The first step starts at sample n (it is returned by the next advance() that covers n). */
  start(n: number): void {
    if (this.started) throw new Error('scenario already started');
    this.started = true;
    this.nextStartN = n;
  }

  /** Every step that starts before nEnd (exclusive), in order. Stops at a wait until go(). */
  advance(nEnd: number): StepStart[] {
    const out: StepStart[] = [];
    while (!this.stopped && this.nextStartN !== null && this.nextStartN < nEnd) {
      const step = this.steps[this.nextIndex];
      if (!step) break;
      const n = this.nextStartN;
      const start: StepStart = { index: this.nextIndex, step, n };
      out.push(start);
      this.lastStart = start;
      this.startByName.set(step.name, n);
      this.nextIndex += 1;
      this.nextStartN = this.nextStartAfter(step, n);
    }
    return out;
  }

  private nextStartAfter(step: Step, n: number): number | null {
    switch (step.k) {
      case 'wait':
        this.blockedBy = 'go';
        return null;
      case 'end':
        this.blockedBy = null;
        return null;
      case 'play':
        if (step.untilClipEnd) {
          this.blockedBy = 'clip_end';
          return null;
        }
        return n + step.lenSamples;
      case 'align': {
        // start(anchor) + offsetSamples, or at once when that sample has passed
        const anchorN = this.startByName.get(step.anchor);
        return anchorN === undefined ? n : Math.max(n, anchorN + step.offsetSamples);
      }
      default:
        return n + step.lenSamples;
    }
  }

  /** Releases the current wait step at sample n (the quantum where {k:'go'} is handled). False if nothing waits. */
  go(n: number): boolean {
    return this.release('go', n);
  }

  /** Releases a play step with untilClipEnd at sample n, where its clip ended. */
  clipEnded(n: number): boolean {
    return this.release('clip_end', n);
  }

  private release(what: Exclude<Block, null>, n: number): boolean {
    if (this.stopped || this.blockedBy !== what || !this.lastStart) return false;
    this.blockedBy = null;
    this.nextStartN = Math.max(n, this.lastStart.n);
    return true;
  }

  /** Stops the scenario (Stop button, abort): no further steps start. */
  stop(): void {
    this.stopped = true;
    this.nextStartN = null;
    this.blockedBy = null;
  }

  /** The wait step currently holding the scenario, if any. */
  get waiting(): WaitStep | null {
    const s = this.lastStart?.step;
    return this.blockedBy === 'go' && s?.k === 'wait' ? s : null;
  }

  /** The step that started last. */
  get current(): StepStart | null {
    return this.lastStart;
  }

  /** True once the end step has started or the scenario was stopped. */
  get finished(): boolean {
    return this.stopped || this.lastStart?.step.k === 'end';
  }

  /** Absolute start sample of a step that has started. */
  startOf(name: string): number | undefined {
    return this.startByName.get(name);
  }
}
