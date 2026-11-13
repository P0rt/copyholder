// The stretch of channel 0 the label page shows for one event (spec 7.6): channel 0 only, by sample
// number through the chunk layout, zeros where nothing was recorded (before the start, in a gap,
// after the end).

import type { LoadedSession } from '../lib/session.ts';

export function channel0Window(s: Pick<LoadedSession, 'layout' | 'ch0'>, start: number, length: number): Float32Array {
  const out = new Float32Array(length);
  const end = start + length;
  for (const r of s.layout.runs) {
    const a = Math.max(start, r.n0);
    const b = Math.min(end, r.n1);
    if (b <= a) continue;
    const i0 = r.index0 + (a - r.n0);
    const i1 = Math.min(s.ch0.length, r.index0 + (b - r.n0));
    if (i1 > i0) out.set(s.ch0.subarray(i0, i1), a - start);
  }
  return out;
}
