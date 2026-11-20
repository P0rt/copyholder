// Clicks Deck mixes into its output, in samples from the start of the clicks step: the 10
// loop-check clicks of core/clock (spec 6.3), at their own fixed level, and the demo take's three
// sync clicks (spec 7.3, 15.4), the same waveform at the narrator's level.

import { LOOP_CLICK_PEAK, clickSchedule, clickWaveform } from './core.ts';
import { msToSamples } from './units.ts';

export interface LoopClicks {
  offsetsSamples: number[];
  waveform: Float32Array;
}

/**
 * Starts of the demo take's three clicks, ms from the clicks step: the shown segment opens with
 * them 3 s before the passage (spec 15.1, 15.4). Unequal gaps, so the video aligns one way only;
 * the times are an assumption.
 */
export const DEMO_CLICK_STARTS_MS: readonly number[] = [250, 1_050, 2_150];

export function loopCheckClicks(): LoopClicks {
  const offsets = clickSchedule();
  if (!offsets.every((x) => Number.isSafeInteger(x) && x >= 0)) throw new Error('clickSchedule(): expected non-negative integer sample offsets');
  return { offsetsSamples: [...offsets].sort((a, b) => a - b), waveform: clickWaveform(LOOP_CLICK_PEAK) };
}

export function demoClicks(): LoopClicks {
  return { offsetsSamples: DEMO_CLICK_STARTS_MS.map((ms) => msToSamples(ms)), waveform: clickWaveform() };
}
