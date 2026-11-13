// Constants of the time chain (spec 6.2, 6.3, 7.3, 7.12). No imports: safe in an AudioWorklet.

/** Sample rate of the AudioContext and of audio.wav (spec 6.3). */
export const SAMPLE_RATE_HZ = 48_000;

/** Render quantum. Deck stamps each message with the sample of the quantum that handled it (spec 6.2, 7.3). */
export const QUANTUM_SAMPLES = 128;

/** Linear fade from nCmd; nSilent = nCmd + 384, 8 ms (spec 6.3, 7.3). */
export const FADE_SAMPLES = 384;

/** Recording block, 200 ms; its first sample is the `n` of a `chunk` stamp (spec 7.3, 8.1; assumption). */
export const CHUNK_SAMPLES = 9_600;

/** L_rt rule of spec 6.3: blocks A and B within 3 ms give `mean`, within 15 ms give `both`, else `void`. */
export const LRT_MEAN_MAX_MS = 3;
export const LRT_BOTH_MAX_MS = 15;

/** Camera clock: start and end offsets must agree within 25 ms (spec 6.3). */
export const CAMERA_OFFSET_AGREE_MS = 25;

/** Trace hard condition: median rate of at least 25 samples per second (spec 6.3). */
export const TRACE_RATE_MIN_PER_S = 25;

/**
 * A trace sample whose timestamp disagrees with the arrival of its line on tap's clock by more
 * than this is a stray, not part of the recording's trace (assumption: 60 s).
 */
export const TRACE_STRAY_TOLERANCE_S = 60;

/** Sniff lag reading (spec 6.3, 9.6 row 4): PASS when the median upper bound is <= 150 ms, KILL when the median lower bound is > 350 ms. */
export const SNIFF_PASS_MAX_MS = 150;
export const SNIFF_KILL_MIN_MS = 350;

/**
 * The thresholds above judge measured, unrounded values; reports print them rounded to 0.1 (spec 8.1).
 * A difference this close to a threshold counts as on it: floating-point noise only (26.4 - 23.4 is
 * 3.0000000000000036).
 */
export const THRESHOLD_TOLERANCE_MS = 1e-9;

export function samplesToMs(samples: number, sampleRateHz: number = SAMPLE_RATE_HZ): number {
  return (samples * 1000) / sampleRateHz;
}

export function msToSamples(ms: number, sampleRateHz: number = SAMPLE_RATE_HZ): number {
  return (ms * sampleRateHz) / 1000;
}

/** Stamp quantization of Deck, in ms: 128 samples at 48 kHz is 2.7 ms (spec 6.3, 7.12). */
export function quantumMs(sampleRateHz: number = SAMPLE_RATE_HZ): number {
  return samplesToMs(QUANTUM_SAMPLES, sampleRateHz);
}
