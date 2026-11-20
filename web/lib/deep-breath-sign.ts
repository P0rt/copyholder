// The trace sign of a headstart take from its three paced deep breaths (spec 7.4, 7.11), found in the
// worker before the narrator reads. The method is that of quickcheck condition 9 (analysis/lib/
// conditions.ts polarity): the 'Breathe in' steps (Deck step marks) are put on the camera clock through
// the lower envelope of packet arrivals (core/clock lowerEnvelope; analysis/lib/measure.ts
// sampleToCameraUs), and polaritySign of core/detector takes, for each breath, the median of the trace
// around the end of the inhale minus the median around its start. headstart uses the sign only when
// the three breaths agree and the margin of spec 7.4 holds (spec 7.11). Pure: no I/O, no timers.

import { lowerEnvelope, polaritySign, POLARITY_BREATHS, type CueWindow, type Envelope, type PacketTime, type PolarityResult } from './core.ts';
import type { TracePair } from './messages.ts';
import { SAMPLE_RATE_HZ } from './units.ts';

/** What the page shows when the deep breaths give no sign: D1 then never stops the narrator in the run. */
export const DEEP_BREATH_SIGN_ERROR = 'The chest trace gave no clear direction on the deep breaths, so in this run only the voice stops the narrator.';

/** Step names of the paced deep breaths (web/scenarios/blocks.ts deepBreaths). */
export function inhaleStep(i: number): string {
  return `deep_${i}_in`;
}

export function exhaleStep(i: number): string {
  return `deep_${i}_out`;
}

export interface DeepBreathSignResult extends PolarityResult {
  /** The sign the run takes: polaritySign's sign when the breaths agree and the margin holds, else null. */
  use: 1 | -1 | null;
  /** Why there is none (for the console); null when there is a sign. */
  why: string | null;
  /** The inhale windows on the camera clock, us. */
  windows: CueWindow[];
}

/** Camera timestamp (us) of the moment at Deck sample n: analysis/lib/measure.ts sampleToCameraUs. */
export function sampleToCameraUs(env: Envelope, n: number, sampleRateHz: number = SAMPLE_RATE_HZ): number {
  const x = (n / sampleRateHz - env.intercept) / (1 + env.slope);
  return env.x0Us + x * 1e6;
}

/**
 * Collects what the sign needs while the worker runs: the trace samples of every packet, the newest
 * camera timestamp of each packet with its arrival sample nArr (Deck's arr stamp), and the step marks.
 */
export class DeepBreathSign {
  /** Newest camera timestamp of packets that wait for their arr stamp, by seq. */
  private readonly waiting = new Map<number, number>();
  private readonly arrivals: PacketTime[] = [];
  /** Trace value by camera timestamp; the first value of a timestamp stays (analysis traceSamples). */
  private readonly trace = new Map<number, number>();
  private readonly marks: Array<{ name: string; n: number }> = [];

  constructor(private readonly breaths: number = POLARITY_BREATHS) {}

  /** A packet line of /tap: its trace pairs and, when it has landmarks, their camera timestamp. */
  packet(seq: number, tr: readonly TracePair[], landmarkTsUs: number | null = null): void {
    let newest = Number.NEGATIVE_INFINITY;
    for (const [t, v] of tr) {
      if (!Number.isFinite(t)) continue;
      if (t > newest) newest = t;
      if (Number.isFinite(v) && !this.trace.has(t)) this.trace.set(t, v);
    }
    if (landmarkTsUs !== null && Number.isFinite(landmarkTsUs) && landmarkTsUs > newest) newest = landmarkTsUs;
    if (Number.isFinite(newest)) this.waiting.set(seq, newest);
  }

  /** Deck's arr stamp: packet seq reached Deck at sample n. */
  arrival(seq: number, n: number): void {
    const ts = this.waiting.get(seq);
    if (ts === undefined) return;
    this.waiting.delete(seq);
    this.arrivals.push({ nArr: n, tsUs: ts });
  }

  /**
   * A step mark at sample n. True when the step after the last exhale starts: every inhale has ended
   * and the trace around its end has had a whole exhale (4 s) to arrive.
   */
  step(name: string, n: number): boolean {
    const prev = this.marks[this.marks.length - 1];
    this.marks.push({ name, n });
    return prev !== undefined && prev.name === exhaleStep(this.breaths) && name !== prev.name;
  }

  /** True once the first inhale step has started. */
  get sawBreaths(): boolean {
    return this.marks.some((m) => m.name === inhaleStep(1));
  }

  /** Each inhale step from its mark to the next mark, in Deck samples (analysis/lib/session.ts stepSpan). */
  inhaleSpans(): Array<{ n0: number; n1: number }> {
    const spans: Array<{ n0: number; n1: number }> = [];
    for (let i = 1; i <= this.breaths; i++) {
      const at = this.marks.findIndex((m) => m.name === inhaleStep(i));
      if (at < 0) continue;
      const n0 = this.marks[at]!.n;
      const next = this.marks.slice(at + 1).find((m) => m.n >= n0);
      if (next) spans.push({ n0, n1: next.n });
    }
    return spans;
  }

  /** The sign from what has arrived so far (spec 7.4, 7.11). */
  result(): DeepBreathSignResult {
    const none = (why: string, p: PolarityResult = { sign: null, d: [], agree: false, margin: false }, windows: CueWindow[] = []): DeepBreathSignResult => ({
      ...p,
      use: null,
      why,
      windows,
    });
    const spans = this.inhaleSpans();
    if (spans.length < this.breaths) return none(`only ${spans.length} of ${this.breaths} deep breaths have both marks`);
    const env = lowerEnvelope(this.arrivals, { sampleRateHz: SAMPLE_RATE_HZ });
    if (env === null) return none('too few trace packets to put the deep breaths on the camera clock');
    const windows = spans.map((s) => ({ startUs: sampleToCameraUs(env, s.n0), endUs: sampleToCameraUs(env, s.n1) }));
    const samples: TracePair[] = [...this.trace.entries()].sort((a, b) => a[0] - b[0]);
    const p = polaritySign(samples, windows);
    if (!p.agree || p.sign === null) return none('the deep breaths do not move the trace the same way', p, windows);
    if (!p.margin) return none('the smallest change on a deep breath is under a third of the largest (spec 7.4)', p, windows);
    return { ...p, use: p.sign, why: null, windows };
  }
}
