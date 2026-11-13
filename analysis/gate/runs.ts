// Post-hoc runs of D1 and its rivals over one recording, each with its own stop model
// (spec 7.5, 9.6), and the counts the gate rows need: fires and active time inside a block.

import {
  d1Posthoc,
  holdParamsFromFrozen,
  msToSamples,
  runPosthoc,
  stepMut,
  type DetectorInput,
  type DetectorState,
  type FrozenParamsLike,
  type PosthocDetector,
  type PosthocResult,
  type Sign,
  type Variant,
} from '../../core/detector.ts';
import {
  activeSpansSamples,
  gPosthoc,
  mPosthoc,
  overlapSamples,
  tPosthoc,
  type LipPoint,
  type SpanSamples,
} from '../rivals/index.ts';
import { RATE } from './common.ts';
import { lastPositionSamples } from './view.ts';

/** A stop of an own-stop-model run: fire at nFire (nArr), silence at nSilent = nArr + 384. */
export interface RunStop {
  seq: number;
  nFire: number;
  nSilent: number;
}

export interface DetectorRun {
  name: string;
  /** Stops of accepted fires, in order. */
  stops: RunStop[];
  /** Active spans from the run's armed changes (spec 4.2). */
  spans: SpanSamples[];
  result: PosthocResult<unknown>;
}

export interface RunSetup {
  /** The whole parsed params/frozen.json (d1, hold, g blocks). */
  frozen: FrozenParamsLike;
  sign: Sign;
  variant: Variant;
}

function runOptions(setup: RunSetup): { holdWaitSamples: number; rampSamples: number } {
  const hold = holdParamsFromFrozen(setup.frozen);
  return { holdWaitSamples: msToSamples(hold.H_ms), rampSamples: hold.ramp_frames };
}

function toRun<S, F>(name: string, inputs: readonly DetectorInput[], nArrBySeq: ReadonlyMap<number, number>, det: PosthocDetector<S, F>, setup: RunSetup): DetectorRun {
  const result = runPosthoc(inputs, { detector: det, nArrBySeq, ...runOptions(setup) });
  const end = lastPositionSamples(inputs, nArrBySeq);
  return {
    name,
    stops: result.stops.map((s) => ({ seq: s.seq, nFire: s.nCmd, nSilent: s.nSilent })),
    spans: activeSpansSamples(result.armed, end),
    result: result as PosthocResult<unknown>,
  };
}

/** The frozen params with another k (stage A trials). */
export function withK(frozen: FrozenParamsLike, k: number): FrozenParamsLike {
  return { ...frozen, d1: { ...frozen.d1, k } };
}

/** D1 with its own stop model; `last` gives the detector state after the last line. */
export function runD1(inputs: readonly DetectorInput[], nArrBySeq: ReadonlyMap<number, number>, setup: RunSetup): DetectorRun & { last: DetectorState | null } {
  const base = d1Posthoc(setup.frozen, setup.sign, setup.variant);
  let last: DetectorState | null = null;
  const det: PosthocDetector<DetectorState> = {
    name: base.name,
    ownPostFirePeriod: true,
    init: base.init,
    step: (s, input) => {
      const out = stepMut(s, input);
      last = out.state;
      return out;
    },
  };
  return { ...toRun(setup.variant, inputs, nArrBySeq, det, setup), last };
}

export interface GSetup {
  thetaG: number;
  frames: number;
  points: ReadonlyMap<number, LipPoint>;
  invalidCodes?: readonly number[];
}

export function runG(inputs: readonly DetectorInput[], nArrBySeq: ReadonlyMap<number, number>, setup: RunSetup, g: GSetup): DetectorRun {
  const det = gPosthoc({ nArrBySeq, thetaG: g.thetaG, frames: g.frames, points: g.points, ...(g.invalidCodes ? { invalidCodes: g.invalidCodes } : {}) });
  return toRun('G', inputs, nArrBySeq, det, setup);
}

export function runT(inputs: readonly DetectorInput[], nArrBySeq: ReadonlyMap<number, number>, setup: RunSetup, invalidCodes?: readonly number[]): DetectorRun {
  return toRun('T', inputs, nArrBySeq, tPosthoc({ nArrBySeq, ...(invalidCodes ? { invalidCodes } : {}) }), setup);
}

export function runM(
  inputs: readonly DetectorInput[],
  nArrBySeq: ReadonlyMap<number, number>,
  setup: RunSetup,
  threshold: number,
  invalidCodes?: readonly number[],
): DetectorRun {
  return toRun('M', inputs, nArrBySeq, mPosthoc({ nArrBySeq, threshold, ...(invalidCodes ? { invalidCodes } : {}) }), setup);
}

/** Stops whose fire lies in [n0, n1). */
export function stopsIn(run: Pick<DetectorRun, 'stops'>, span: SpanSamples): RunStop[] {
  return run.stops.filter((s) => s.nFire >= span.n0 && s.nFire < span.n1);
}

/** Active minutes of a run inside a span (spec 4.2). */
export function activeMinutesIn(run: Pick<DetectorRun, 'spans'>, span: SpanSamples): number {
  return overlapSamples(run.spans, span.n0, span.n1) / RATE / 60;
}
