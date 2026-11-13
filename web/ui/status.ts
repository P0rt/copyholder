// Status line of the numbers session (spec 7.3): "Passage 2 of 3    04:12    CHEST".
import { SAMPLE_RATE_HZ } from '../scenarios/format.ts';

export type StopCause = 'chest' | 'voice' | 'key';

const GAP = '    ';

/** mm:ss from a sample count at 48 kHz, rounded down to the second; minutes grow past 99. */
export function formatClock(samples: number): string {
  const total = Math.max(0, Math.floor(samples / SAMPLE_RATE_HZ));
  const mm = Math.floor(total / 60);
  const ss = total % 60;
  return `${String(mm).padStart(2, '0')}:${String(ss).padStart(2, '0')}`;
}

/** Label, clock and the stop cause in capitals (spec 6.4), separated by four spaces. */
export function formatStatusLine(label: string, elapsedSamples: number | null, cause: StopCause | null): string {
  const parts = [label];
  if (elapsedSamples !== null) parts.push(formatClock(elapsedSamples));
  if (cause) parts.push(cause.toUpperCase());
  return parts.filter((p) => p !== '').join(GAP);
}

/** Stop cause from a Deck state message; only stopped states show one. */
export function causeOfState(state: string, cause: unknown): StopCause | null {
  if (state !== 'hold_wait' && state !== 'listening') return null;
  return cause === 'chest' || cause === 'voice' || cause === 'key' ? cause : null;
}
