// Rival T, the SDK talking flag (spec 7.5): fires on the first packet with the flag set while T
// is active. No setting.

import type { BatchInput, PosthocDetector } from '../../core/detector.ts';
import { sdkRivalPosthoc, type PacketRule, type PacketVerdict, type RivalFire, type RivalState, type RivalTiming } from './activity.ts';

/** True when any talking flag of the packet is set. */
export function packetTalks(input: BatchInput): boolean {
  return (input.talk ?? []).some((pair) => pair[1] === 1);
}

/** The T rule: always ready; fires on a packet that carries a set flag. */
export const T_RULE: PacketRule<null> = {
  init: () => null,
  onPacket(_st: null, input: BatchInput, active: boolean): PacketVerdict {
    if (active && packetTalks(input)) return { ready: true, fire: { rule: 'talking', value: 1, threshold: 1 } };
    return { ready: true, fire: null };
  },
};

export interface SdkRivalRunOptions {
  nArrBySeq: ReadonlyMap<number, number>;
  timing?: RivalTiming;
  invalidCodes?: readonly number[];
}

/** T as a post-hoc detector with its own stop model (spec 7.5). */
export function tPosthoc(opts: SdkRivalRunOptions): PosthocDetector<RivalState<null>, RivalFire> {
  return sdkRivalPosthoc('T', T_RULE, opts);
}
