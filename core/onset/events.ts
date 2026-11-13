// Audio events the clocks need from channel 0 (spec 6.3): the onset of a sharp nasal sniff and
// the plosive bursts of 'pa' syllables spoken from closed lips.

import { butterworthSos, dbToPower, powerToDb, selectInPlace, sosFiltFiltInPlace } from '../vad/dsp.ts';
import { computeFeatures, extractReflected, type FeatureTrack, type Floor } from './features.ts';
import { findAnchorFrame, onsetFromAnchor, regionStart } from './onset.ts';
import { checkSamples, resolveOnsetConfig, type OnsetParams } from './params.ts';

export interface SniffParams {
  readonly sampleRateHz: number;
  /** spec 6.3: high-pass 1 kHz (4th order Butterworth, zero phase: assumption). */
  readonly highpassHz: number;
  readonly highpassOrder: number;
  /** spec 6.3: 5 ms envelope (mean square over the 5 ms that end at each sample: assumption). */
  readonly envelopeMs: number;
  /** spec 6.3: threshold noise floor + 12 dB, held 20 ms. */
  readonly overFloorDb: number;
  readonly holdMs: number;
  /**
   * The noise floor is this quantile of the envelope (dB) over the floor window (assumption:
   * 0.1). A low quantile, not the median, because the window holds the exhale that
   * `Breathe out and wait` asks for (spec 9.3); on steady noise it sits within 1 dB of the median.
   */
  readonly floorQuantile: number;
  /**
   * Floor window before the search start (assumption: 4 s). Longer than the 1.5 s wait before
   * `Sniff` (spec 9.3), so an exhale that fills the whole wait does not become the floor.
   */
  readonly floorWindowMs: number;
  /** Search length after the search start (assumption). */
  readonly searchMs: number;
}

export const DEFAULT_SNIFF_PARAMS: SniffParams = Object.freeze({
  sampleRateHz: 48000,
  highpassHz: 1000,
  highpassOrder: 4,
  envelopeMs: 5,
  overFloorDb: 12,
  holdMs: 20,
  floorQuantile: 0.1,
  floorWindowMs: 4000,
  searchMs: 2000,
});

export interface SniffOnset {
  /** n_sniff: first sample of the first 20 ms in which the envelope stays >= floor + 12 dB. */
  readonly n: number;
  /** Noise floor of the envelope, dB re full-scale mean square. */
  readonly floorDb: number;
  /** Highest envelope level within the 20 ms hold. */
  readonly peakDb: number;
}

export interface SniffOptions {
  readonly params?: Partial<SniffParams>;
  /** Absolute sample number of ch0[0] (default 0). */
  readonly n0?: number;
  /** End of the search: the onset must lie in [searchFromSample, searchToSample] (default search start + 2 s). */
  readonly searchToSample?: number;
  /** Floor window [from, to) (default: the 4 s before the search start). */
  readonly floorFromSample?: number;
  readonly floorToSample?: number;
  /** Fixed floor in dB instead of measuring it. */
  readonly floorDb?: number;
}

/**
 * Onset of a sharp nasal sniff (spec 6.3): high-pass 1 kHz, 5 ms envelope, threshold noise
 * floor + 12 dB held for 20 ms. Searches from `searchFromSample` (the `Sniff` prompt, spec 9.3).
 * Only a crossing counts: a sound already above the threshold at the search start must fall
 * below it first. Returns null when no crossing is held within the search.
 */
export function findSniffOnset(ch0: Float32Array, searchFromSample: number, opts: SniffOptions = {}): SniffOnset | null {
  const p: SniffParams = { ...DEFAULT_SNIFF_PARAMS, ...opts.params };
  const fs = p.sampleRateHz;
  const n0 = checkSamples('findSniffOnset', opts.n0 ?? 0, {
    searchFromSample,
    searchToSample: opts.searchToSample,
    floorFromSample: opts.floorFromSample,
    floorToSample: opts.floorToSample,
    floorDb: opts.floorDb,
  });
  if (!(p.floorQuantile >= 0 && p.floorQuantile <= 1)) throw new RangeError('findSniffOnset: floorQuantile must be in [0, 1]');
  const envN = Math.max(1, Math.round((p.envelopeMs * fs) / 1000));
  const holdN = Math.max(1, Math.round((p.holdMs * fs) / 1000));
  const searchTo = opts.searchToSample ?? searchFromSample + Math.round((p.searchMs * fs) / 1000);
  const floorTo = opts.floorToSample ?? searchFromSample;
  const floorFrom = opts.floorFromSample ?? floorTo - Math.round((p.floorWindowMs * fs) / 1000);

  const lo = Math.max(n0, Math.min(floorFrom, searchFromSample) - envN);
  const hi = Math.min(n0 + ch0.length, searchTo + holdN);
  if (hi - lo < envN + holdN) return null;
  const pad = Math.round(0.5 * fs);
  const origin = lo - pad;
  const buf = new Float64Array(hi - lo + 2 * pad);
  extractReflected(ch0, n0, origin, buf);
  sosFiltFiltInPlace(butterworthSos('highpass', p.highpassOrder, p.highpassHz, fs), buf);
  const prefix = new Float64Array(buf.length + 1);
  for (let i = 0; i < buf.length; i++) prefix[i + 1] = prefix[i]! + buf[i]! * buf[i]!;
  // Mean square over [n - envN, n) for absolute sample n.
  const env = (n: number): number => {
    const i = n - origin;
    return Math.max(0, prefix[i]! - prefix[i - envN]!) / envN;
  };

  let floorDb = opts.floorDb;
  if (floorDb === undefined) {
    const a = Math.max(floorFrom, lo + envN);
    const b = Math.min(floorTo, hi);
    if (b <= a) return null;
    const values = new Float64Array(b - a);
    for (let n = a; n < b; n++) values[n - a] = powerToDb(env(n));
    floorDb = selectInPlace(values, values.length, Math.floor(p.floorQuantile * (values.length - 1)));
  }
  const thr = dbToPower(floorDb + p.overFloorDb);

  let armed = false;
  let runStart = -1;
  for (let n = Math.max(searchFromSample, lo + envN); n < hi; n++) {
    if (env(n) >= thr) {
      if (runStart < 0) {
        if (!armed) continue;
        if (n > searchTo) break;
        runStart = n;
      }
      if (n - runStart + 1 >= holdN) {
        let peak = 0;
        for (let m = runStart; m <= n; m++) peak = Math.max(peak, env(m));
        return { n: runStart, floorDb, peakDb: powerToDb(peak) };
      }
    } else {
      armed = true;
      runStart = -1;
      if (n > searchTo) break;
    }
  }
  return null;
}

export interface PaBurst {
  /** Burst onset: t_v of the syllable by the walk back of spec 7.6 (sample number). */
  readonly n: number;
  /** Anchor in the vowel. */
  readonly nA: number;
  /** Voiced time of the syllable, ms. */
  readonly voicedMs: number;
}

export interface PaBurstsResult {
  readonly bursts: readonly PaBurst[];
  /** Voiced syllables found, accepted or not. */
  readonly syllables: number;
  readonly floorDb: number;
  readonly floorSpreadDb: number;
}

export interface PaBurstOptions {
  readonly params?: Partial<OnsetParams>;
  /** Absolute sample number of ch0[0] (default 0). */
  readonly n0?: number;
  /** Fixed floor instead of the median E of the block. */
  readonly floorDb?: number;
  readonly floorSpreadDb?: number;
  /** Voiced parts closer than this belong to one syllable (assumption: 300 ms). */
  readonly syllableGapMs?: number;
  /** Longest burst-to-anchor time accepted for a plosive syllable (assumption: 150 ms). */
  readonly maxBurstToAnchorMs?: number;
  /**
   * Shortest burst-to-anchor time (assumption: 5 ms). A walk back that never left the vowel
   * (e.g. when 3 s_N lifts the threshold over the aspiration) gives no burst, not a wrong one.
   */
  readonly minBurstToAnchorMs?: number;
}

/** Closure silence lasts at least this long inside a gap (assumption: 10 ms of 1 ms frames). */
const CLOSURE_MIN_MS = 10;

/** True when frames [a, b) hold `minRun` consecutive frames with E below `silenceDb`. */
function holdsSilence(e: Float32Array, a: number, b: number, silenceDb: number, minRun: number): boolean {
  let run = 0;
  for (let k = a; k < b; k++) {
    if (e[k]! < silenceDb) {
      if (++run >= minRun) return true;
    } else {
      run = 0;
    }
  }
  return false;
}

/**
 * First sound after the closure silence (spec 6.3: the burst of a 'pa' from closed lips). The
 * walk back of spec 7.6 bridges dips of 20 ms only, so aspiration that hovers around the walk
 * threshold can stop it inside the aspiration, after the burst. From the walk-back onset `kv`
 * this steps back to an earlier sound segment (same threshold and bridging) that starts within
 * `kWin..kv` only while the gap between them is aspiration: a gap that falls to closure silence
 * (`silenceRun` frames below `silenceDb`) means the lips were closed there, so the sound after
 * it is the burst and anything before it (a click, a nasal breath) is not. A segment that runs
 * in from before `kWin` (an inhale tail, say) is not a burst either and ends the search.
 */
function firstSoundAfterClosure(
  track: FeatureTrack,
  kv: number,
  kWin: number,
  kMin: number,
  thr: number,
  silenceDb: number,
  silenceRun: number,
): number {
  const e = track.energyDb;
  const kLow = Math.max(0, kMin, kWin - track.cfg.walkGap - 1);
  let best = kv;
  let k = kv - 1;
  for (;;) {
    while (k >= kWin && e[k]! < thr) k--;
    if (k < kWin) return best;
    if (holdsSilence(e, k + 1, best, silenceDb, silenceRun)) return best;
    const start = regionStart(track, k + 1, kLow, thr);
    if (start < kWin || start <= kLow) return best;
    best = start;
    k = start - 1;
  }
}

/**
 * Plosive bursts of 'pa' syllables in [fromSample, toSample) (spec 6.3, 7.12: 5 per block,
 * at least 4 must be found). A syllable is a voiced vowel with a 40-of-60 anchor. Its burst is
 * the onset t_v of the walk back of spec 7.6, moved back to the first sound after the closure
 * when weak aspiration split the syllable (assumption): only across gaps that never fall to
 * closure silence, i.e. 10 ms below the midpoint between N and the walk threshold, so a click
 * or a breath before the closure is never the burst. It counts as a burst when the walk back
 * stopped at the closure silence (no inhale merged into it, no 250 ms limit) and the burst
 * lies 5-150 ms before the anchor. The floor is the median E of the block (assumption: the
 * syllables fill a small part of it; the narrator is silent in 'pa' blocks, spec 9.3).
 */
export function findPaBursts(
  ch0: Float32Array,
  fromSample: number,
  toSample: number,
  opts: PaBurstOptions = {},
): PaBurstsResult {
  const cfg = resolveOnsetConfig(opts.params);
  const p = cfg.p;
  const n0 = checkSamples('findPaBursts', opts.n0 ?? 0, { fromSample, toSample, floorDb: opts.floorDb });
  const gap = Math.round((opts.syllableGapMs ?? 300) / p.hopMs);
  const maxLead = Math.round((opts.maxBurstToAnchorMs ?? 150) / p.hopMs);
  const minLead = Math.round((opts.minBurstToAnchorMs ?? 5) / p.hopMs);
  const lead = (cfg.walkLimit + cfg.walkGap + cfg.breathLookback) * cfg.hop;
  const track = computeFeatures(ch0, n0, fromSample - lead, toSample + (cfg.anchorOf + gap + 1) * cfg.hop, cfg);
  const kFrom = track.frameAtOrAfter(fromSample);
  const kTo = track.frameAtOrAfter(toSample);

  let floor: Floor | null;
  if (opts.floorDb !== undefined) {
    floor = { db: opts.floorDb, spreadDb: opts.floorSpreadDb ?? 0, frames: 0 };
  } else {
    floor = track.floorOver(kFrom, kTo, null, new Float64Array(Math.max(0, kTo - kFrom)));
  }
  if (floor === null) return { bursts: [], syllables: 0, floorDb: Number.NaN, floorSpreadDb: Number.NaN };

  const e = track.energyDb;
  const thrVoice = floor.db + p.anchorOverFloorDb;
  const isVoiced = (k: number): boolean => e[k]! >= thrVoice && track.periodicity(k) >= p.periodicity;
  const silenceRun = Math.max(1, Math.round(CLOSURE_MIN_MS / p.hopMs));
  const bursts: PaBurst[] = [];
  let syllables = 0;
  let kMin = 0;
  let k = kFrom;
  while (k < kTo) {
    const ka = findAnchorFrame(track, k, kTo, isVoiced);
    if (ka < 0) break;
    // The syllable ends at its last voiced frame before a pause of `gap` frames.
    let last = ka;
    for (let j = ka + 1; j < track.count && j - last <= gap; j++) if (isVoiced(j)) last = j;
    const onset = onsetFromAnchor(track, ka, floor, kMin);
    // Closure silence: below the midpoint between N and the walk threshold (N + max(3 dB, 1.5 s_N)).
    const silenceDb = (floor.db + onset.thresholdDb) / 2;
    const kv = firstSoundAfterClosure(track, track.frameAtOrAfter(onset.nV), ka - maxLead, kMin, onset.thresholdDb, silenceDb, silenceRun);
    let voicedFrames = 0;
    for (let j = kv; j <= last; j++) if (isVoiced(j)) voicedFrames++;
    syllables++;
    if (!onset.walkLimited && onset.flags.length === 0 && ka - kv >= minLead && ka - kv <= maxLead) {
      bursts.push({ n: track.frameEnd(kv), nA: onset.nA, voicedMs: voicedFrames * p.hopMs });
    }
    kMin = last + 1;
    k = last + 1;
  }
  return { bursts, syllables, floorDb: floor.db, floorSpreadDb: floor.spreadDb };
}
