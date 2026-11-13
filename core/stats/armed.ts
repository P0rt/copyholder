// The "window lies in active time" rule of spec 4.3. It drops pseudo onsets of the third
// chance-level estimate (4.3), marks an objection "detector was inactive" (4.5) and gives
// the `armed` count of the gate verdict (9.7). The window [t - W, t) must lie in active
// time (spec 4.2), except that time from a fire whose stop falls in the window or later
// is not checked: after a fire the detector is inactive by construction (spec 7.4, 2.0 s),
// so without this exception every window holding a stop would be dropped.

import { type IntervalMs, isSpanCoveredMs, normalizeIntervalsMs } from './intervals.ts';
import { CHANCE_WINDOW_MS } from './poisson.ts';
import { assertFiniteNumber } from './validate.ts';

/** One chest-detector fire, session clock in ms. */
export interface ChestFireMs {
  /** Fire time t_f: arrival of the packet on which the rule first held (spec 4.2). */
  fireMs: number;
  /** Its stop t_s on the microphone clock (spec 4.2); never before the fire. */
  stopMs: number;
}

/** Throws unless every fire has finite times and a stop at or after its fire. */
export function checkChestFires(fires: readonly ChestFireMs[], name = 'fires'): void {
  fires.forEach((f, i) => {
    assertFiniteNumber(f.fireMs, `${name}[${i}].fireMs`);
    assertFiniteNumber(f.stopMs, `${name}[${i}].stopMs`);
    if (f.stopMs < f.fireMs) throw new RangeError(`${name}[${i}] stops before it fires`);
  });
}

export function checkWindowMs(windowMs: number): void {
  assertFiniteNumber(windowMs, 'windowMs');
  if (windowMs <= 0) throw new RangeError(`windowMs must be > 0, got ${windowMs}`);
}

/**
 * End of the part of [t - W, t) that must lie in active time: t, or the earliest fire
 * whose stop falls at or after t - W, whichever comes first. At or before t - W the
 * whole window is exempt.
 */
export function armedCheckEndMs(tMs: number, fires: readonly ChestFireMs[], windowMs: number = CHANCE_WINDOW_MS): number {
  const startMs = tMs - windowMs;
  let endMs = tMs;
  for (const f of fires) {
    if (f.stopMs >= startMs && f.fireMs < endMs) endMs = f.fireMs;
  }
  return endMs;
}

/** Whether [t - W, t) lies in active time by the rule of spec 4.3 (the `armed` of spec 9.7). */
export function isWindowArmed(
  tMs: number,
  activeMs: readonly IntervalMs[],
  fires: readonly ChestFireMs[],
  windowMs: number = CHANCE_WINDOW_MS,
): boolean {
  assertFiniteNumber(tMs, 'tMs');
  checkWindowMs(windowMs);
  checkChestFires(fires);
  const active = normalizeIntervalsMs(activeMs, 'activeMs');
  return isSpanCoveredMs(active, tMs - windowMs, armedCheckEndMs(tMs, fires, windowMs));
}
