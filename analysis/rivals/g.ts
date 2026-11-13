// Rival G, the lip detector (spec 7.5): g - g0 >= theta_G on two frames in a row, where g0 is
// the median g of the previous 10 s. After a frame with the reset flag (g null) g0 builds up
// again, and G stays silent until it holds 1 s of frames (assumption of the spec).

import { insertSorted, removeSorted } from '../../core/detector/math.ts';
import { THETA_G_GRID } from '../../core/schemas/index.ts';
import type { BatchInput, DetectorInput, PosthocDetector } from '../../core/detector.ts';
import { linePositionSamples, sdkRivalPosthoc, type PacketRule, type PacketVerdict, type RivalFire, type RivalState, type RivalTiming } from './activity.ts';

/** g block of params/frozen.json beyond theta_G (spec 8.4 example: frames 2, baseline_s 10). */
export interface GParams {
  theta_G: number;
  /** Frames in a row that must meet the threshold. */
  frames: number;
  /** Length of the g0 window, s. */
  baseline_s: number;
  /** Frames g0 needs after a reset, s (assumption of spec 7.5). */
  reset_wait_s: number;
}

export const DEFAULT_G_PARAMS: Readonly<Omit<GParams, 'theta_G'>> = Object.freeze({ frames: 2, baseline_s: 10, reset_wait_s: 1 });

/** g and its baseline on one lip frame; g0 null while the baseline is not ready. */
export interface LipPoint {
  /** null on a frame with the reset flag. */
  g: number | null;
  g0: number | null;
}

/**
 * g0 for every packet that carries a lip frame, by seq. The window holds the frames that arrived
 * in the previous baseline_s seconds since the last reset (arrival clock, assumption); frames
 * count whatever the detector does, so the baseline does not depend on any detector.
 *
 * detector_in.jsonl writes g null both on a reset frame and on a packet without a landmark frame
 * (spec 8.1). With `resetSeqs` (packets whose samples.jsonl frame has reset 1) only those reset
 * the baseline and other null values are packets without a frame; without it every null is a reset.
 */
export function lipBaselines(
  inputs: readonly DetectorInput[],
  nArrBySeq: ReadonlyMap<number, number>,
  opts: { baselineS?: number; resetWaitS?: number; sampleRateHz?: number; resetSeqs?: ReadonlySet<number> } = {},
): Map<number, LipPoint> {
  const rate = opts.sampleRateHz ?? 48_000;
  const span = (opts.baselineS ?? DEFAULT_G_PARAMS.baseline_s) * rate;
  const wait = (opts.resetWaitS ?? DEFAULT_G_PARAMS.reset_wait_s) * rate;
  const out = new Map<number, LipPoint>();
  // Window of [n, g] in arrival order and a sorted copy of its values.
  let winN: number[] = [];
  let winG: number[] = [];
  let head = 0;
  let sorted = new Float64Array(1024);
  let count = 0;
  let since: number | null = null; // first frame position after the last reset
  let lastPos = Number.NEGATIVE_INFINITY;
  const clear = (): void => {
    winN = [];
    winG = [];
    head = 0;
    count = 0;
  };
  for (const r of inputs) {
    if (r.k !== 'batch') continue;
    const g = (r as BatchInput).g;
    const known = linePositionSamples(r, nArrBySeq);
    if (known !== null && known > lastPos) lastPos = known;
    const n = known ?? lastPos;
    const isReset = opts.resetSeqs !== undefined ? opts.resetSeqs.has(r.seq) : g === null;
    if (!isReset && (typeof g !== 'number' || !Number.isFinite(g))) continue;
    if (isReset || typeof g !== 'number') {
      clear();
      since = null;
      out.set(r.seq, { g: null, g0: null });
      continue;
    }
    if (!Number.isFinite(n)) {
      out.set(r.seq, { g, g0: null });
      continue;
    }
    if (since === null) since = n;
    while (head < winN.length && winN[head]! < n - span) {
      removeSorted(sorted, count, winG[head]!);
      count--;
      head++;
    }
    let g0: number | null = null;
    if (count > 0 && n - since >= wait) g0 = medianOfSorted(sorted, count);
    out.set(r.seq, { g, g0 });
    if (count === sorted.length) {
      const bigger = new Float64Array(sorted.length * 2);
      bigger.set(sorted);
      sorted = bigger;
    }
    insertSorted(sorted, count, g);
    count++;
    winN.push(n);
    winG.push(g);
    if (head > 4096) {
      winN = winN.slice(head);
      winG = winG.slice(head);
      head = 0;
    }
  }
  return out;
}

function medianOfSorted(sorted: Float64Array, count: number): number {
  const mid = count >> 1;
  return count % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

interface GRuleState {
  run: number;
  ready: boolean;
}

/** The G rule over precomputed baselines (lipBaselines). */
export function gRule(points: ReadonlyMap<number, LipPoint>, thetaG: number, frames: number = DEFAULT_G_PARAMS.frames): PacketRule<GRuleState> {
  return {
    init: () => ({ run: 0, ready: false }),
    onPacket(st: GRuleState, input: BatchInput, active: boolean): PacketVerdict {
      const p = points.get(input.seq);
      // A packet without a lip frame changes nothing.
      if (p === undefined) return { ready: st.ready, fire: null };
      if (p.g === null || p.g0 === null) {
        st.ready = false;
        st.run = 0;
        return { ready: false, fire: null };
      }
      st.ready = true;
      const rise = p.g - p.g0;
      if (!active || !(rise >= thetaG)) {
        st.run = 0;
        return { ready: true, fire: null };
      }
      st.run++;
      if (st.run < frames) return { ready: true, fire: null };
      st.run = 0;
      const fire: RivalFire = { rule: 'g', value: rise, threshold: thetaG };
      return { ready: true, fire };
    },
  };
}

export interface GPosthocOptions {
  nArrBySeq: ReadonlyMap<number, number>;
  thetaG: number;
  frames?: number;
  /** Precomputed baselines; computed from `inputs` when absent. */
  points?: ReadonlyMap<number, LipPoint>;
  inputs?: readonly DetectorInput[];
  /** Packets whose landmark frame has the reset flag (samples.jsonl), see lipBaselines. */
  resetSeqs?: ReadonlySet<number>;
  timing?: RivalTiming;
  invalidCodes?: readonly number[];
}

/** G as a post-hoc detector with its own stop model (spec 7.5). */
export function gPosthoc(opts: GPosthocOptions): PosthocDetector<RivalState<GRuleState>, RivalFire> {
  const points = opts.points ?? lipBaselines(opts.inputs ?? [], opts.nArrBySeq, opts.resetSeqs ? { resetSeqs: opts.resetSeqs } : {});
  return sdkRivalPosthoc('G', gRule(points, opts.thetaG, opts.frames), {
    nArrBySeq: opts.nArrBySeq,
    ...(opts.timing ? { timing: opts.timing } : {}),
    ...(opts.invalidCodes ? { invalidCodes: opts.invalidCodes } : {}),
  });
}

/** theta_G grid of spec 7.5, ascending: 0.010 to 0.060 in steps of 0.0025. */
export const G_GRID: readonly number[] = THETA_G_GRID;

/** The fields of a samples.jsonl line that tell a reset frame from a packet without a frame. */
export type SampleLmLike = { k: string; seq?: number; lm?: { reset?: number } | null };

/** Packets whose landmark frame carries the reset flag, from samples.jsonl lines (spec 8.1). */
export function resetSeqsOf(samples: readonly SampleLmLike[]): Set<number> {
  const out = new Set<number>();
  for (const l of samples) {
    if (l.k === 'm' && typeof l.seq === 'number' && l.lm && l.lm.reset === 1) out.add(l.seq);
  }
  return out;
}

/** How each packet with a null g in detector_in.jsonl reads against samples.jsonl (spec 7.5, 8.1). */
export interface GResets {
  /** Packets that reset the baseline of G (lipBaselines `resetSeqs`). */
  seqs: Set<number>;
  /** Frames with the reset flag. */
  flagged: number;
  /** Null g on a packet without a landmark frame (lm null), or a frame that gave no g: not a reset. */
  noFrame: number;
  /** Null g that samples.jsonl does not explain (no "m" line, no lm field): taken as a reset. */
  unknown: number;
}

/**
 * Resets of G (spec 7.5). detector_in.jsonl writes g null both on a frame with the reset flag and
 * on a packet without a landmark frame (live/reduce.cjs); samples.jsonl tells them apart: lm.reset 1
 * is a reset, lm null is no frame. A null g it does not explain counts as a reset, as every null
 * does for a reader of stream.jsonl alone (assumption).
 */
export function gResetSeqs(inputs: readonly DetectorInput[], samples: readonly SampleLmLike[]): GResets {
  const lmBySeq = new Map<number, SampleLmLike['lm']>();
  for (const l of samples) {
    if (l.k === 'm' && typeof l.seq === 'number' && Object.hasOwn(l, 'lm')) lmBySeq.set(l.seq, l.lm ?? null);
  }
  const out: GResets = { seqs: new Set<number>(), flagged: 0, noFrame: 0, unknown: 0 };
  for (const r of inputs) {
    if (r.k !== 'batch') continue;
    const lm = lmBySeq.get(r.seq);
    if (lm?.reset === 1) {
      out.seqs.add(r.seq);
      out.flagged++;
    } else if (r.g === null) {
      if (lm !== undefined) {
        out.noFrame++;
      } else {
        out.seqs.add(r.seq);
        out.unknown++;
      }
    }
  }
  return out;
}
