// Rival M, head motion (spec 7.5), descriptive only: fires when hm is above its median plus
// 4 spreads, both taken over the listening block (assumption of the spec). Spread is the
// MAD-based sigma of core/stats.

import { median, robustSpread } from '../../core/stats/index.ts';
import type { BatchInput, DetectorInput, PosthocDetector } from '../../core/detector.ts';
import { linePositionSamples, sdkRivalPosthoc, type PacketRule, type PacketVerdict, type RivalFire, type RivalState } from './activity.ts';
import type { SdkRivalRunOptions } from './t.ts';

/** Spreads above the median (spec 7.5). */
export const M_SPREADS = 4;

export interface HeadMotionThreshold {
  median: number;
  spread: number;
  threshold: number;
  /** Packets the statistics came from. */
  n: number;
}

/** hm statistics of the packets that arrived in [n0, n1); null without values. */
export function headMotionThreshold(
  inputs: readonly DetectorInput[],
  nArrBySeq: ReadonlyMap<number, number>,
  n0: number,
  n1: number,
): HeadMotionThreshold | null {
  const values: number[] = [];
  for (const r of inputs) {
    if (r.k !== 'batch') continue;
    const hm = r.hm;
    if (typeof hm !== 'number' || !Number.isFinite(hm)) continue;
    const n = linePositionSamples(r, nArrBySeq);
    if (n === null || n < n0 || n >= n1) continue;
    values.push(hm);
  }
  const med = median(values);
  const spread = robustSpread(values);
  if (med === null || spread === null) return null;
  return { median: med, spread, threshold: med + M_SPREADS * spread, n: values.length };
}

/**
 * The M rule: fires on a packet whose hm exceeds the threshold. Packets without a value (no
 * landmark frame, or a reset frame: hm null) cannot fire; the threshold is fixed, so M is ready.
 */
export function mRule(threshold: number): PacketRule<null> {
  return {
    init: () => null,
    onPacket(_st: null, input: BatchInput, active: boolean): PacketVerdict {
      const hm = input.hm;
      if (active && typeof hm === 'number' && Number.isFinite(hm) && hm > threshold) {
        return { ready: true, fire: { rule: 'head_motion', value: hm, threshold } };
      }
      return { ready: true, fire: null };
    },
  };
}

/** M as a post-hoc detector with its own stop model (spec 7.5). */
export function mPosthoc(opts: SdkRivalRunOptions & { threshold: number }): PosthocDetector<RivalState<null>, RivalFire> {
  return sdkRivalPosthoc('M', mRule(opts.threshold), opts);
}
