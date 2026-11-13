// Scenario timeline of Deck on sample numbers alone (docs/protocol.md "Scenario steps"; spec 6.1:
// no timers). Same rules as web/scenarios/runner.ts (ScenarioRunner, the reference the page tests
// use; lib.test.ts checks that both give the same starts), shaped for a per-sample check in the
// audio thread: `nextStart` is a plain number, and entering a step allocates nothing.

import { scenarioErrors, type Step } from '../scenarios/format.ts';
import { CLICK_BLOCKS } from './messages.ts';

export interface StepStart {
  index: number;
  step: Step;
  /** Sample at which the step starts. */
  n: number;
}

export interface ScenarioRules {
  /**
   * Something can stop the narrator (Deck modes live, key, voice). A stop lengthens the passage by
   * the hold, so a play step must play its clip to the end (untilClipEnd): a timed step could start
   * the next clip in HOLD_WAIT or LISTENING, where only H or voice_off may end the stop (spec 6.4).
   */
  narratorStops?: boolean;
}

/** Problems that keep Deck from running a step list (web/scenarios/format.ts rules and ScenarioRules); [] when it can run. */
export function scenarioProblems(steps: unknown, rules: ScenarioRules = {}): string[] {
  if (!Array.isArray(steps)) return ['scenario: steps must be an array'];
  for (const [i, s] of steps.entries()) {
    if (typeof s !== 'object' || s === null || typeof (s as { k?: unknown }).k !== 'string') return [`step ${i}: not a step`];
  }
  let errors: string[];
  try {
    errors = scenarioErrors(steps as Step[]);
  } catch (err) {
    return [`scenario: ${(err as Error).message}`];
  }
  (steps as Step[]).forEach((s, i) => {
    const at = `step ${i} (${s.name || '?'})`;
    if (s.k === 'clicks' && !(CLICK_BLOCKS as readonly string[]).includes(s.block)) {
      errors.push(`${at}: clicks block must be ${CLICK_BLOCKS.join(', ')}`);
    }
    if (rules.narratorStops === true && s.k === 'play' && s.untilClipEnd !== true) {
      errors.push(`${at}: a stop can lengthen the passage in this mode, so a play step needs untilClipEnd (spec 6.4)`);
    }
  });
  return errors;
}

export class Timeline {
  private readonly steps: readonly Step[];
  private index = -1;
  /** Start sample of steps[index + 1]; null while a wait, a clip end or the end holds it. */
  private nextAt: number | null;
  private blocked: 'go' | 'clip' | 'end' | null = null;
  private readonly starts = new Map<string, number>();
  private last: StepStart | null = null;

  /** The first step starts at sample n. */
  constructor(steps: readonly Step[], n: number) {
    this.steps = steps;
    this.nextAt = n;
  }

  /** Start sample of the next step, or null while it is blocked or the list has ended. */
  get nextStart(): number | null {
    return this.nextAt;
  }

  get current(): StepStart | null {
    return this.last;
  }

  /** True after the end step, after the last step of a list without one, or after stop(). */
  get ended(): boolean {
    return this.blocked === 'end';
  }

  /** The play step that is waiting for its clip to end, if any. */
  get waitsForClip(): boolean {
    return this.blocked === 'clip';
  }

  startOf(name: string): number | undefined {
    return this.starts.get(name);
  }

  /** Enters the next step at sample n (n >= nextStart). Null when nothing is due or the list ran out. */
  enter(n: number): StepStart | null {
    if (this.nextAt === null || n < this.nextAt) return null;
    const index = this.index + 1;
    const step = this.steps[index];
    if (step === undefined) {
      this.stop();
      return null;
    }
    this.index = index;
    this.starts.set(step.name, n);
    switch (step.k) {
      case 'wait':
        this.block('go');
        break;
      case 'end':
        this.block('end');
        break;
      case 'play':
        if (step.untilClipEnd === true) this.block('clip');
        else this.nextAt = n + step.lenSamples;
        break;
      case 'align': {
        // The next step starts at start(anchor) + offsetSamples, or at once if that has passed.
        const a = this.starts.get(step.anchor);
        this.nextAt = a === undefined ? n : Math.max(n, a + step.offsetSamples);
        break;
      }
      default:
        this.nextAt = n + step.lenSamples;
        break;
    }
    this.last = { index, step, n };
    return this.last;
  }

  /** Releases a wait step at sample n (where {k:'go'} is handled). False when nothing waits. */
  go(n: number): boolean {
    return this.release('go', n);
  }

  /** Releases a play step with untilClipEnd at sample n, where its clip ended. */
  clipEnded(n: number): boolean {
    return this.release('clip', n);
  }

  /** No further step starts (Stop, abort). */
  stop(): void {
    this.block('end');
  }

  private block(what: 'go' | 'clip' | 'end'): void {
    this.blocked = what;
    this.nextAt = null;
  }

  private release(what: 'go' | 'clip', n: number): boolean {
    if (this.blocked !== what) return false;
    this.blocked = null;
    this.nextAt = Math.max(n, this.last?.n ?? n);
    return true;
  }
}
