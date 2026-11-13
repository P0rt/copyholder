// Loop check clicks (spec 6.3, 7.3). Deck imports this file inside the AudioWorklet:
// it must stay free of Node APIs and of imports other than ./constants.ts.

import { SAMPLE_RATE_HZ } from './constants.ts';

/** Clicks in one loop check (spec 6.3). */
export const CLICK_COUNT = 10;

/** One loop check block: about 12 s (spec 6.3, 9.3, 10.4). */
export const LOOP_BLOCK_SAMPLES = 12 * SAMPLE_RATE_HZ;

/** Click length: 5 ms. */
export const CLICK_SAMPLES = 240;

/** Chirp band. 1-8 kHz passes a headset driver and a headset microphone with margin. */
export const CLICK_START_HZ = 1_000;
export const CLICK_END_HZ = 8_000;

/** Default peak amplitude of the click in Deck output (before Deck's own gain, if any). */
export const CLICK_PEAK = 0.5;

// Click starts in ms from the block start. All nine intervals differ (0.95-1.36 s), every one
// is far longer than the 100 ms lag search, and 0.98 s of tail follows the last click (spec 6.3).
const CLICK_STARTS_MS: readonly number[] = [500, 1550, 2830, 3800, 5120, 6250, 7610, 8560, 9870, 11020];

/** Click start offsets in samples from the start of a loop check block. Deterministic. */
export function clickSchedule(): number[] {
  return CLICK_STARTS_MS.map((ms) => Math.round((ms * SAMPLE_RATE_HZ) / 1000));
}

/**
 * The click Deck plays: a 5 ms linear chirp from 1 to 8 kHz under a Hann window.
 * A 7 kHz band gives a correlation main lobe of about 0.15 ms with low side lobes; spreading
 * the energy over 5 ms keeps the peak level modest when an earcup is pressed on the
 * microphone, and a resonance or notch of the earcup removes only part of the band.
 */
export function clickWaveform(peak: number = CLICK_PEAK): Float32Array {
  const out = new Float32Array(CLICK_SAMPLES);
  const durationS = CLICK_SAMPLES / SAMPLE_RATE_HZ;
  const sweepHzPerS = (CLICK_END_HZ - CLICK_START_HZ) / durationS;
  for (let i = 0; i < CLICK_SAMPLES; i++) {
    const t = i / SAMPLE_RATE_HZ;
    const phase = 2 * Math.PI * (CLICK_START_HZ * t + 0.5 * sweepHzPerS * t * t);
    const taper = 0.5 - 0.5 * Math.cos((2 * Math.PI * (i + 0.5)) / CLICK_SAMPLES);
    out[i] = peak * taper * Math.sin(phase);
  }
  return out;
}
