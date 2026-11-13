// Where the narrator's sound reaches channel 0 (spec 7.6): the floor N is meant to be measured
// while the narrator reads, so that a weak leak is already in it. Deck's `narrating` state also
// holds the narrator's pauses; when they fill more than half of it, the median sits at the
// background, and leak syllables up to ~10 dB over it in the 150 Hz-8 kHz band (still within
// doctor's 6 dB limit, measured over the whole band) pass the walk threshold N + 6 dB. Spans
// from channel 1 keep N on the leak. Pass them as `reading` to findOnset and findSessionOnsets.

import { selectInPlace } from '../vad/dsp.ts';
import type { SampleSpan } from './params.ts';

export interface NarratorSoundOptions {
  /** Absolute sample number of ch1[0] (default 0). */
  readonly n0?: number;
  /** Delay from channel 1 to its leak in channel 0, in samples: L_rt of the loop check (spec 6.3); default 0. */
  readonly delaySamples?: number;
  readonly sampleRateHz?: number;
  /** Level window and step (assumption: 10 ms every 5 ms, the step energy doctor's leak measure uses). */
  readonly windowMs?: number;
  readonly hopMs?: number;
  /** A window is narrator sound when its level is within this of the 90th percentile (assumption: 20 dB, as doctor). */
  readonly belowP90Db?: number;
}

/**
 * Spans of channel 0 samples where the narrator's sound arrives: 10 ms windows of channel 1
 * (Deck's own output after the gain, spec 7.3) whose mean square is within 20 dB of the 90th
 * percentile of its non-silent windows, merged, and moved by `delaySamples` onto the channel 0
 * scale. Digital silence never counts; a silent channel 1 gives no spans. Non-finite samples
 * read as 0. Sorted, disjoint, half-open.
 */
export function narratorSoundSpans(ch1: Float32Array, opts: NarratorSoundOptions = {}): SampleSpan[] {
  const n0 = opts.n0 ?? 0;
  const delay = opts.delaySamples ?? 0;
  const fs = opts.sampleRateHz ?? 48000;
  if (!Number.isSafeInteger(n0) || !Number.isSafeInteger(delay)) {
    throw new RangeError('narratorSoundSpans: n0 and delaySamples must be integer sample numbers');
  }
  const win = Math.round(((opts.windowMs ?? 10) * fs) / 1000);
  const hop = Math.round(((opts.hopMs ?? 5) * fs) / 1000);
  const below = opts.belowP90Db ?? 20;
  if (!(win >= 1 && hop >= 1 && Number.isFinite(below))) throw new RangeError('narratorSoundSpans: bad window, step or level');
  if (ch1.length < win) return [];

  const count = Math.floor((ch1.length - win) / hop) + 1;
  const ms = new Float64Array(count);
  // Each window summed on its own (no running sum), so digital silence stays exactly 0.
  for (let w = 0; w < count; w++) {
    let acc = 0;
    for (let i = w * hop; i < w * hop + win; i++) {
      const v = ch1[i]!;
      if (v - v === 0) acc += v * v;
    }
    ms[w] = acc / win;
  }

  const levels = new Float64Array(count);
  let audible = 0;
  for (let w = 0; w < count; w++) if (ms[w]! > 1e-20) levels[audible++] = ms[w]!;
  if (audible === 0) return [];
  const p90 = selectInPlace(levels, audible, Math.floor(0.9 * (audible - 1)));
  const thr = p90 * Math.pow(10, -below / 10);

  const out: Array<[number, number]> = [];
  for (let w = 0; w < count; w++) {
    if (!(ms[w]! > 1e-20 && ms[w]! >= thr)) continue;
    const a = n0 + delay + w * hop;
    const b = a + win;
    const prev = out[out.length - 1];
    if (prev !== undefined && a <= prev[1]) prev[1] = Math.max(prev[1], b);
    else out.push([a, b]);
  }
  return out;
}
