// Shared constants and precision rules of spec 8.1.

/** Sample rate of every audio stream and of all sample numbers (spec 6.3). */
export const SAMPLE_RATE_HZ = 48_000;

/** Linear fade before silence: nSilent = nCmd + 384 (spec 6.2, 13.4 "Время остановки"). */
export const FADE_SAMPLES = 384;

/** Hold wait H = 1.5 s counted from nSilent (spec 6.4). */
export const HOLD_WAIT_SAMPLES = 72_000;

/** Face mesh points kept by tap, in this order (spec 7.1, 8.1). */
export const LANDMARK_IDS: readonly number[] = [13, 14, 82, 87, 312, 317, 81, 178, 311, 402, 78, 308, 33, 263, 133, 362];

/** Number of [x, y] points in a samples.jsonl `lm.p` list. */
export const LANDMARK_COUNT = 16;

/**
 * Rounds a report value (ms, dB) to 0.1 (spec 8.1), half away from zero, on the decimal
 * that JSON prints: 23.45 gives 23.5 and 0.15 gives 0.2, not the binary neighbour below.
 * Never returns -0. Non-finite input is returned unchanged.
 */
export function round1(x: number): number {
  if (!Number.isFinite(x)) return x;
  const a = Math.abs(x);
  const s = String(a);
  // Exponent forms (below 1e-6 or from 1e21) are 0 or already integral after rounding.
  const r = s.includes('e') ? Math.round(a * 10) / 10 : Number(`${Math.round(Number(`${s}e1`))}e-1`);
  const signed = x < 0 ? -r : r;
  return signed === 0 ? 0 : signed;
}

/**
 * A detector input value with -0 turned into 0. JSON writes -0 as "0", the one number it does
 * not read back (spec 8.1): where a detector input is formed, -0 becomes 0, so the live run and
 * the replay of detector_in.jsonl feed the detector the same value. Other values are unchanged.
 */
export function plusZero(x: number): number {
  return x === 0 ? 0 : x;
}

/** True when x is finite and already has at most one decimal. */
export function isRound1(x: number): boolean {
  return Number.isFinite(x) && round1(x) === x;
}

/** Seconds on the sample clock: t = n / 48000 (spec 6.3). */
export function samplesToSeconds(n: number): number {
  return n / SAMPLE_RATE_HZ;
}
