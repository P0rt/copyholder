// Parameters of the voice-onset reference (spec 7.6) and their derived sample counts.

import { butterworthSos, concatSos, lowpassFir, type Sos } from '../vad/dsp.ts';

/** Half-open interval of sample numbers [start, end). */
export type SampleSpan = readonly [start: number, end: number];

export interface OnsetParams {
  readonly sampleRateHz: number;
  /** Pre-filter: high-pass, applied forward and backward (spec 7.6: 80 Hz, 4th order). */
  readonly highpassHz: number;
  readonly highpassOrder: number;
  /** Energy band (spec 7.6: 150 Hz-8 kHz); Butterworth edges of this order, zero phase (assumption). */
  readonly bandLowHz: number;
  readonly bandHighHz: number;
  readonly bandOrder: number;
  /** Feature step and energy window (spec 7.6: 1 ms and 10 ms). */
  readonly hopMs: number;
  readonly energyWindowMs: number;
  /** Periodicity window, centred on the energy window (spec 7.6: 30 ms; centring is an assumption). */
  readonly corrWindowMs: number;
  /**
   * Periodicity is computed on the same 150 Hz-8 kHz band as E, decimated to this rate
   * (assumption: 16 kHz). Same band for both, so a fricative above 4 kHz cannot borrow the
   * periodicity of a quiet narrator leak below it.
   */
  readonly corrRateHz: number;
  /** Anti-alias FIR before that decimation: odd number of taps and cutoff (assumption). */
  readonly antiAliasTaps: number;
  readonly antiAliasHz: number;
  /** Lag range (spec 7.6: 2.5-12.5 ms). */
  readonly lagMs: readonly [minMs: number, maxMs: number];
  /** A voiced window: c >= periodicity and E >= N + anchorOverFloorDb (spec 7.6: 0.5 and 15 dB). */
  readonly periodicity: number;
  readonly anchorOverFloorDb: number;
  /** Anchor: voiced in at least [0] of [1] consecutive windows (spec 7.6: 40 of 60). */
  readonly anchorWindows: readonly [hits: number, of: number];
  /** Walk back while E >= N + max(walkOverFloorDb, walkSpreadFactor * s_N) (spec 7.6: 6 dB, 3). */
  readonly walkOverFloorDb: number;
  readonly walkSpreadFactor: number;
  /** Dips up to this long do not stop the walk (spec 7.6: 20 ms). */
  readonly walkGapMs: number;
  /** Walk limit (spec 7.6: 250 ms). */
  readonly walkLimitMs: number;
  /** A non-periodic segment longer than this is an audible inhale (spec 7.6: 250 ms). */
  readonly breathMinMs: number;
  /** A dip separating the inhale from the voice: >= dipDb below the inhale level for >= dipMinMs (spec 7.6: 6 dB, 20 ms). */
  readonly dipDb: number;
  readonly dipMinMs: number;
  /**
   * A dip ("провал") also falls toward the background: its lowest window is at most this far
   * above the walk threshold (assumption: 6 dB). A quieter sound that stays higher, such as a
   * voiceless consonant right after the inhale, is not a dip.
   */
  readonly dipNearWalkDb: number;
  /** An audible inhale must end within this long before t_v (assumption: W = 1.5 s). */
  readonly breathLookbackMs: number;
  /** How far back the sound region before an anchor is followed (assumption). */
  readonly regionLookbackMs: number;
  /** A segment is periodic when at least this share of its frames above the walk threshold has c >= periodicity (assumption). */
  readonly periodicShare: number;
  /** Floor N: median E from floorFromMs to floorToMs before the search start or the candidate (spec 7.6: 10 s to 1 s). */
  readonly floorFromMs: number;
  readonly floorToMs: number;
  /** s_N = madScale * MAD (spec 7.6: 1.4826). */
  readonly madScale: number;
  /** Fewer floor frames than this widen the floor window (assumption). */
  readonly minFloorMs: number;
  /** Session variant: the floor is recomputed on this grid (assumption: 100 ms). */
  readonly floorGridMs: number;
  /** Gate variant: the anchor must appear within this long after the search start (spec 7.12: 10 s). */
  readonly searchMs: number;
  /** Voiced segments with a pause shorter than this form one reply (spec 7.6, 4.2: 1.0 s). */
  readonly replyMergeGapMs: number;
  /** Gate variant: the reply after the anchor is followed at most this far past the search end (assumption). */
  readonly replyMaxMs: number;
}

export const DEFAULT_ONSET_PARAMS: OnsetParams = Object.freeze({
  sampleRateHz: 48000,
  highpassHz: 80,
  highpassOrder: 4,
  bandLowHz: 150,
  bandHighHz: 8000,
  bandOrder: 4,
  hopMs: 1,
  energyWindowMs: 10,
  corrWindowMs: 30,
  corrRateHz: 16000,
  antiAliasTaps: 31,
  antiAliasHz: 7000,
  lagMs: Object.freeze([2.5, 12.5] as const),
  periodicity: 0.5,
  anchorOverFloorDb: 15,
  anchorWindows: Object.freeze([40, 60] as const),
  walkOverFloorDb: 6,
  walkSpreadFactor: 3,
  walkGapMs: 20,
  walkLimitMs: 250,
  breathMinMs: 250,
  dipDb: 6,
  dipMinMs: 20,
  dipNearWalkDb: 6,
  breathLookbackMs: 1500,
  regionLookbackMs: 2000,
  periodicShare: 0.5,
  floorFromMs: 10000,
  floorToMs: 1000,
  madScale: 1.4826,
  minFloorMs: 1000,
  floorGridMs: 100,
  searchMs: 10000,
  replyMergeGapMs: 1000,
  replyMaxMs: 20000,
});

/** Derived counts: samples at the audio rate, frames at the feature step. */
export interface OnsetConfig {
  readonly p: OnsetParams;
  readonly fs: number;
  readonly hop: number;
  readonly winE: number;
  readonly decim: number;
  readonly winC: number;
  /** Samples from a frame's end back to the start of its periodicity window. */
  readonly cBack: number;
  /** Samples of the periodicity window at the audio rate. */
  readonly cSpan: number;
  readonly lagMin: number;
  readonly lagMax: number;
  readonly hpSos: Sos;
  readonly bandSos: Sos;
  readonly fir: Float64Array;
  readonly anchorHits: number;
  readonly anchorOf: number;
  readonly walkGap: number;
  readonly walkLimit: number;
  readonly breathMin: number;
  readonly dipMin: number;
  readonly breathLookback: number;
  readonly regionLookback: number;
  readonly floorFrom: number;
  readonly floorTo: number;
  readonly minFloor: number;
  readonly floorGrid: number;
  readonly search: number;
  readonly mergeGapSamples: number;
  readonly replyMax: number;
}

/**
 * Checks the sample numbers a finder gets: `n0` (the number of ch0[0]) must be a safe integer,
 * the others finite. Returns n0. A NaN position (say, a missing scenario step) throws here
 * instead of failing deep inside.
 */
export function checkSamples(fn: string, n0: number, positions: Readonly<Record<string, number | undefined>>): number {
  if (!Number.isSafeInteger(n0)) throw new RangeError(`${fn}: n0 must be an integer sample number, got ${n0}`);
  for (const [name, v] of Object.entries(positions)) {
    if (v !== undefined && !Number.isFinite(v)) throw new RangeError(`${fn}: ${name} must be a finite sample number, got ${v}`);
  }
  return n0;
}

function whole(v: number, what: string): number {
  const r = Math.round(v);
  if (!(r > 0) || Math.abs(v - r) > 1e-6) throw new RangeError(`onset: ${what} must be a positive whole number, got ${v}`);
  return r;
}

export function resolveOnsetConfig(partial: Partial<OnsetParams> = {}): OnsetConfig {
  const p: OnsetParams = { ...DEFAULT_ONSET_PARAMS, ...partial };
  const fs = p.sampleRateHz;
  const hop = whole((p.hopMs * fs) / 1000, 'hop in samples');
  const winE = whole((p.energyWindowMs * fs) / 1000, 'energy window in samples');
  if (winE % hop !== 0) throw new RangeError('onset: the energy window must be a whole number of steps');
  const decim = whole(fs / p.corrRateHz, 'decimation factor');
  if (hop % decim !== 0) throw new RangeError('onset: the step must be a whole number of decimated samples');
  const cSpan = whole((p.corrWindowMs * fs) / 1000, 'periodicity window in samples');
  const cBack = winE / 2 + cSpan / 2;
  if (cBack % decim !== 0 || cSpan % decim !== 0) {
    throw new RangeError('onset: the periodicity window must align with the decimated signal');
  }
  const winC = cSpan / decim;
  const lagMin = Math.ceil((p.lagMs[0] * p.corrRateHz) / 1000 - 1e-9);
  const lagMax = Math.floor((p.lagMs[1] * p.corrRateHz) / 1000 + 1e-9);
  if (!(lagMin >= 1 && lagMin <= lagMax && lagMax < winC)) throw new RangeError('onset: lag range does not fit the window');
  const frames = (ms: number, what: string): number => whole(ms / p.hopMs, what);
  const [hits, of] = p.anchorWindows;
  if (!(Number.isInteger(hits) && Number.isInteger(of) && hits >= 1 && hits <= of)) {
    throw new RangeError('onset: anchorWindows must be integers with 1 <= hits <= of');
  }
  return {
    p,
    fs,
    hop,
    winE,
    decim,
    winC,
    cBack,
    cSpan,
    lagMin,
    lagMax,
    hpSos: butterworthSos('highpass', p.highpassOrder, p.highpassHz, fs),
    bandSos: concatSos(
      butterworthSos('highpass', p.bandOrder, p.bandLowHz, fs),
      butterworthSos('lowpass', p.bandOrder, p.bandHighHz, fs),
    ),
    fir: lowpassFir(p.antiAliasTaps, p.antiAliasHz, fs),
    anchorHits: hits,
    anchorOf: of,
    walkGap: frames(p.walkGapMs, 'walkGapMs'),
    walkLimit: frames(p.walkLimitMs, 'walkLimitMs'),
    breathMin: frames(p.breathMinMs, 'breathMinMs'),
    dipMin: frames(p.dipMinMs, 'dipMinMs'),
    breathLookback: frames(p.breathLookbackMs, 'breathLookbackMs'),
    regionLookback: frames(p.regionLookbackMs, 'regionLookbackMs'),
    floorFrom: frames(p.floorFromMs, 'floorFromMs'),
    floorTo: frames(p.floorToMs, 'floorToMs'),
    minFloor: frames(p.minFloorMs, 'minFloorMs'),
    floorGrid: frames(p.floorGridMs, 'floorGridMs'),
    search: whole((p.searchMs * fs) / 1000, 'searchMs in samples'),
    mergeGapSamples: whole((p.replyMergeGapMs * fs) / 1000, 'replyMergeGapMs in samples'),
    replyMax: whole((p.replyMaxMs * fs) / 1000, 'replyMaxMs in samples'),
  };
}
