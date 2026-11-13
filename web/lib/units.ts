// Sample-clock constants shared by Deck and the worker (spec 6.2-6.4, 7.1, 7.3).
// Every duration in Deck is counted in samples of one 48 kHz AudioContext.

export const SAMPLE_RATE_HZ = 48_000;
export const QUANTUM_SAMPLES = 128;

/** Linear fade at a stop: 8 ms (spec 6.2 step 8, 7.3). nSilent = nCmd + FADE_OUT_SAMPLES. */
export const FADE_OUT_SAMPLES = 384;
/** Fade-in on resume: 10 ms (spec 6.4). */
export const FADE_IN_SAMPLES = 480;
/** Hold wait H = 1.5 s counted from nSilent (spec 6.4). */
export const HOLD_WAIT_SAMPLES = 72_000;
/** Audio safety: voice_on held for another 250 ms (spec 6.4). */
export const VOICE_SAFETY_SAMPLES = 12_000;
/** Resume from the next word when at least 80% of the interrupted word played (spec 6.4). */
export const RESUME_NEXT_WORD_FRACTION = 0.8;
/** Recording block: 9600 frames = 200 ms (spec 7.3; the size is an assumption there). */
export const CHUNK_SAMPLES = 9_600;
/** Level meters about 10 times per second. */
export const LEVEL_WINDOW_SAMPLES = 4_800;
/** SDK readiness: Running with kOk held 5 s (spec 7.1, protocol `{k:'sdk', ok}`). */
export const SDK_OK_HOLD_SAMPLES = 240_000;

export function msToSamples(ms: number, rateHz: number = SAMPLE_RATE_HZ): number {
  return Math.round((ms * rateHz) / 1000);
}

export function samplesToMs(samples: number, rateHz: number = SAMPLE_RATE_HZ): number {
  return (samples * 1000) / rateHz;
}
