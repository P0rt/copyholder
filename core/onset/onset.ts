// Voice-onset reference (spec 7.6): anchor t_a, walk back to t_v, audible inhale, no_dip.
// All sample numbers in and out are absolute numbers of channel 0 (ch0[0] is sample n0).

import { computeFeatures, type FeatureTrack, type Floor } from './features.ts';
import { checkSamples, resolveOnsetConfig, type OnsetParams, type SampleSpan } from './params.ts';
import { replyFrom, type ReplyExtent } from './replies.ts';

export type OnsetFlag = 'no_dip';

export interface OnsetResult {
  /** n_v: voice onset in channel 0 (t_v = n_v / 48000, spec 6.3, 7.6). */
  readonly nV: number;
  /** n_a: the anchor t_a. */
  readonly nA: number;
  /** Audible inhale [start, end) in samples, or null when there is none. */
  readonly breath: SampleSpan | null;
  /** 'no_dip': inhale noise runs into the voice without a dip, so t_v = t_a (spec 7.6). */
  readonly flags: readonly OnsetFlag[];
  /** Floor N and its spread s_N, dB re full-scale mean square. */
  readonly floorDb: number;
  readonly floorSpreadDb: number;
  /** The walk-back threshold N + max(6 dB, 3 s_N). */
  readonly thresholdDb: number;
  /** The walk back reached the 250 ms limit with sound still above threshold (diagnostic). */
  readonly walkLimited: boolean;
}

/** The `auto` object of an onsets.json event (spec 8.1). */
export interface OnsetAutoRecord {
  n_v: number;
  n_a: number;
  breath: [number, number] | null;
  flags: string[];
}

export function onsetAutoRecord(r: OnsetResult): OnsetAutoRecord {
  return { n_v: r.nV, n_a: r.nA, breath: r.breath === null ? null : [r.breath[0], r.breath[1]], flags: [...r.flags] };
}

/** The automatic fields of one onsets.json event (spec 8.1); id, kind, label and manual are the caller's. */
export interface OnsetEventFields {
  voiced_ms: number;
  floor_db: number;
  /** Last sample of the reply (the schema's optional `n_end`). */
  n_end: number;
  auto: OnsetAutoRecord;
}

const round1 = (x: number): number => Math.round(x * 10) / 10;

/** onsets.json fields of an onset and its reply; voiced_ms and floor_db to 0.1 as the schema wants. */
export function onsetEventFields(onset: OnsetResult, reply: { readonly voicedMs: number; readonly end: number }): OnsetEventFields {
  return { voiced_ms: round1(reply.voicedMs), floor_db: round1(onset.floorDb), n_end: reply.end - 1, auto: onsetAutoRecord(onset) };
}

/**
 * First frame k in [kFrom, kTo) that is voiced and starts a run of `of` consecutive frames
 * with at least `hits` voiced ones (spec 7.6: 40 of 60). -1 when there is none.
 */
export function findAnchorFrame(
  track: FeatureTrack,
  kFrom: number,
  kTo: number,
  isVoiced: (k: number) => boolean,
): number {
  const { anchorHits, anchorOf } = track.cfg;
  const a = Math.max(0, kFrom);
  const b = Math.min(track.count, kTo);
  if (a >= b) return -1;
  const top = Math.min(track.count, b + anchorOf);
  const flags = new Int8Array(top - a).fill(-1);
  const v = (k: number): number => {
    if (k >= top) return 0;
    let f = flags[k - a]!;
    if (f < 0) {
      f = isVoiced(k) ? 1 : 0;
      flags[k - a] = f;
    }
    return f;
  };
  let count = 0;
  for (let j = a; j < Math.min(top, a + anchorOf); j++) count += v(j);
  for (let k = a; k < b; k++) {
    const vk = v(k);
    if (vk === 1 && count >= anchorHits) return k;
    count += v(k + anchorOf) - vk;
  }
  return -1;
}

/** Share of frames in [k0, k1) above `thrDb` whose periodicity reaches the threshold. */
function periodicShare(track: FeatureTrack, k0: number, k1: number, thrDb: number): number {
  const e = track.energyDb;
  const cMin = track.cfg.p.periodicity;
  let above = 0;
  let periodic = 0;
  for (let k = Math.max(0, k0); k < Math.min(track.count, k1); k++) {
    if (e[k]! >= thrDb) {
      above++;
      if (track.periodicity(k) >= cMin) periodic++;
    }
  }
  return above === 0 ? 0 : periodic / above;
}

function medianOf(values: Float32Array, k0: number, k1: number): number {
  const a = Array.from(values.subarray(k0, k1)).sort((x, y) => x - y);
  const n = a.length;
  if (n === 0) return Number.NaN;
  return n % 2 === 1 ? a[(n - 1) / 2]! : (a[n / 2 - 1]! + a[n / 2]!) / 2;
}

/**
 * The dip closest to frame `ka` inside (r0, ka) (spec 7.6), as [first, last] frames: the
 * segment after it starts at last + 1. The level falls >= 6 dB below the inhale (E <= dipThr)
 * at `first` and is near the background (E <= reachDb) at least minRun frames later, at `near`.
 * `last` is the last frame below the walk threshold `walkDb` in [first, near] (the segment
 * starts where E is back above it, as in the walk back), else `near`. So a quieter sound after
 * a real dip, such as a voiceless consonant, belongs to that segment, while a run that never
 * comes near the background is a quieter sound, not a dip, and the search goes on before it.
 * A run still open at r0 is the inhale's own soft start, not a dip after it.
 */
function lastDip(
  e: Float32Array,
  r0: number,
  ka: number,
  dipThr: number,
  reachDb: number,
  walkDb: number,
  minRun: number,
): [number, number] | null {
  // Scanning back, `near` is the first near-background frame met inside the current run.
  let inRun = false;
  let near = -1;
  for (let k = ka - 1; k > r0; k--) {
    const v = e[k]!;
    if (v <= dipThr) {
      inRun = true;
      if (near < 0 && v <= reachDb) near = k;
    } else if (inRun) {
      if (near >= 0 && near - k >= minRun) {
        let last = near;
        while (last > k && !(e[last]! < walkDb)) last--;
        return [k + 1, last > k ? last : near];
      }
      inRun = false;
      near = -1;
    }
  }
  return null;
}

/**
 * Start frame of the sound region that ends at `kEnd`: walking back from kEnd while E >= thr,
 * gaps of up to walkGap frames below thr are bridged. Stops at kLow.
 */
export function regionStart(track: FeatureTrack, kEnd: number, kLow: number, thr: number): number {
  const e = track.energyDb;
  const maxGap = track.cfg.walkGap;
  let start = kEnd;
  let gap = 0;
  for (let k = kEnd - 1; k >= kLow; k--) {
    if (e[k]! >= thr) {
      start = k;
      gap = 0;
    } else if (++gap > maxGap) {
      break;
    }
  }
  return start;
}

/** The latest audible inhale before frame `kv`: a non-periodic segment above threshold, longer
 * than 250 ms, ending within the look-back. Earlier speech (a long periodic segment) stops the search. */
function precedingBreath(track: FeatureTrack, kv: number, kMin: number, thr: number): [number, number] | null {
  const cfg = track.cfg;
  const e = track.energyDb;
  const kLow = Math.max(kMin, 0, kv - cfg.breathLookback - cfg.regionLookback);
  const endLimit = kv - cfg.breathLookback;
  let k = kv - 1;
  while (k >= kLow) {
    while (k >= kLow && e[k]! < thr) k--;
    if (k < kLow || k < endLimit) return null;
    const segEnd = k;
    const segStart = regionStart(track, segEnd, kLow, thr);
    if (segEnd - segStart + 1 > cfg.breathMin) {
      return periodicShare(track, segStart, segEnd + 1, thr) < cfg.p.periodicShare ? [segStart, segEnd] : null;
    }
    k = segStart - 1;
  }
  return null;
}

/**
 * Onset from an anchor frame (spec 7.6): walk back while E >= N + max(6 dB, 3 s_N), bridging
 * dips up to 20 ms, at most 250 ms. A non-periodic region longer than 250 ms before t_a is an
 * audible inhale; t_v is then the start of the segment after the last dip of >= 6 dB and
 * >= 20 ms that falls toward the background (lastDip), or t_a with the flag no_dip. Frames
 * before kMin are never used.
 */
export function onsetFromAnchor(track: FeatureTrack, ka: number, floor: Floor, kMin = 0): OnsetResult {
  const cfg = track.cfg;
  const p = cfg.p;
  const e = track.energyDb;
  const thr = floor.db + Math.max(p.walkOverFloorDb, p.walkSpreadFactor * floor.spreadDb);
  const kLow = Math.max(0, kMin, ka - cfg.regionLookback);
  const r0 = regionStart(track, ka, kLow, thr);
  const firstAboveFrom = (k0: number): number => {
    for (let k = Math.max(k0, r0); k < ka; k++) if (e[k]! >= thr) return k;
    return ka;
  };

  let kv: number;
  let breath: [number, number] | null = null;
  let noDip = false;
  let walkLimited = false;
  let breathToAnchor = false;

  if (ka - r0 <= cfg.walkLimit) {
    kv = r0;
    breath = precedingBreath(track, kv, kMin, thr);
  } else if (periodicShare(track, r0, ka, thr) >= p.periodicShare) {
    kv = firstAboveFrom(ka - cfg.walkLimit);
    walkLimited = true;
  } else {
    // Audible inhale before the anchor: find the last dip separating it from the voice. A
    // voiceless consonant glued to the inhale is no dip, so such an event gets no_dip (counted).
    const dip = lastDip(e, r0, ka, medianOf(e, r0, ka) - p.dipDb, thr + p.dipNearWalkDb, thr, cfg.dipMin);
    if (dip !== null && ka - (dip[1] + 1) <= cfg.walkLimit && dip[0] - r0 > cfg.breathMin) {
      kv = dip[1] + 1;
      breath = [r0, dip[0] - 1];
    } else if (dip !== null && ka - (dip[1] + 1) <= cfg.walkLimit) {
      // The noise before the dip is too short for an inhale: plain walk-back result.
      kv = firstAboveFrom(ka - cfg.walkLimit);
      walkLimited = true;
    } else {
      kv = ka;
      noDip = true;
      breath = [r0, ka];
      breathToAnchor = true;
    }
  }

  const nA = track.frameEnd(ka);
  let span: SampleSpan | null = null;
  if (breath !== null) {
    const start = track.frameEnd(breath[0]);
    const end = breathToAnchor ? nA : track.frameEnd(breath[1]) - cfg.winE + cfg.hop;
    span = [start, Math.max(start, end)];
  }
  return {
    nV: track.frameEnd(kv),
    nA,
    breath: span,
    flags: noDip ? ['no_dip'] : [],
    floorDb: floor.db,
    floorSpreadDb: floor.spreadDb,
    thresholdDb: thr,
    walkLimited,
  };
}

/** The first floor with enough frames, else the one with the most frames. */
export function pickFloor(candidates: ReadonlyArray<() => Floor | null>, minFrames: number): Floor | null {
  let best: Floor | null = null;
  for (const make of candidates) {
    const f = make();
    if (f === null) continue;
    if (f.frames >= minFrames) return f;
    if (best === null || f.frames > best.frames) best = f;
  }
  return best;
}

/** Frame mask for the floor: inside `reading` (everywhere when absent) and outside `replies`. */
export function floorMask(
  track: FeatureTrack,
  reading: readonly SampleSpan[] | undefined,
  replies: readonly SampleSpan[] | undefined,
): Uint8Array | null {
  if (reading === undefined && (replies === undefined || replies.length === 0)) return null;
  const mask = reading === undefined ? new Uint8Array(track.count).fill(1) : track.maskFromSpans(reading);
  if (replies !== undefined) track.maskFromSpans(replies, mask, 0);
  return mask;
}

export interface FindOnsetOptions {
  readonly params?: Partial<OnsetParams>;
  /** Absolute sample number of ch0[0] (default 0). */
  readonly n0?: number;
  /**
   * The voice must begin by this sample: an onset with n_v > searchTo is not returned. Default
   * searchFrom + 10 s (spec 4.5, 7.12: voice found within 10 s after the dot signal).
   */
  readonly searchToSample?: number;
  /**
   * Where the narrator reads: floor frames must lie inside (default: everywhere). Spans of the
   * narrator's sound (narratorSoundSpans of channel 1, moved by L_rt) keep its leak in N, as
   * spec 7.6 assumes; Deck's `narrating` spans also hold its pauses, and with a sparse narrator
   * N then sits under the leak, so the walk back can run into a leak syllable.
   */
  readonly reading?: readonly SampleSpan[];
  /** Known replies: floor frames must lie outside (default: none). */
  readonly replies?: readonly SampleSpan[];
  /** Fixed floor N in dB instead of measuring it, and its spread s_N (default 0). */
  readonly floorDb?: number;
  readonly floorSpreadDb?: number;
}

/** findOnset's answer: the onset and the reply it opens. */
export interface GateOnsetResult extends OnsetResult {
  /**
   * The reply n_v belongs to: voiced windows, pauses < 1.0 s merged (spec 4.2, 7.6), giving
   * `voiced_ms` and the reply end. Voice less than 1.0 s before n_v belongs to it too, so
   * `reply.start` can lie before n_v.
   */
  readonly reply: ReplyExtent;
  /**
   * The reply's voice began before the search start: n_v or an earlier voiced part of the same
   * reply lies before searchFromSample (spec 4.5: unusable in the gate check).
   */
  readonly beganBeforeSearch: boolean;
}

/**
 * Voice onset after `searchFromSample` (spec 7.6, gate variant: the search starts at the dot
 * signal). The floor N is the median E from 10 s to 1 s before the search start, on frames where
 * the narrator reads and nobody speaks when those masks are given. The first anchor after the
 * search start gives the onset; null when there is none or its n_v lies after searchToSample (the
 * voice did not begin in time). n_v may lie before the search start: the walk back is not stopped
 * there, so a voice that began before the signal shows (spec 4.5 rejects it), and so does a reply
 * that only paused at the signal (`beganBeforeSearch`).
 */
export function findOnset(ch0: Float32Array, searchFromSample: number, opts: FindOnsetOptions = {}): GateOnsetResult | null {
  const cfg = resolveOnsetConfig(opts.params);
  const p = cfg.p;
  const n0 = checkSamples('findOnset', opts.n0 ?? 0, {
    searchFromSample,
    searchToSample: opts.searchToSample,
    floorDb: opts.floorDb,
    floorSpreadDb: opts.floorSpreadDb,
  });
  const searchTo = opts.searchToSample ?? searchFromSample + cfg.search;
  if (!(searchTo >= searchFromSample)) return null;
  const backFrames = Math.max(cfg.floorFrom, cfg.regionLookback + cfg.breathLookback + cfg.walkLimit);
  // t_v >= t_a - 250 ms, so an onset by searchTo has its anchor by searchTo + 250 ms.
  const anchorTo = searchTo + cfg.walkLimit * cfg.hop;
  const track = computeFeatures(
    ch0,
    n0,
    searchFromSample - backFrames * cfg.hop,
    anchorTo + (cfg.anchorOf + 1) * cfg.hop + cfg.replyMax,
    cfg,
  );
  if (track.count === 0) return null;

  let floor: Floor | null;
  if (opts.floorDb !== undefined) {
    floor = { db: opts.floorDb, spreadDb: opts.floorSpreadDb ?? 0, frames: 0 };
  } else {
    const mask = floorMask(track, opts.reading, opts.replies);
    const k0 = track.frameAtOrAfter(searchFromSample - cfg.floorFrom * cfg.hop);
    const k1 = track.frameAtOrAfter(searchFromSample - cfg.floorTo * cfg.hop);
    const kSearch = track.frameAtOrAfter(searchFromSample);
    const scratch = new Float64Array(track.count);
    floor = pickFloor(
      [
        () => track.floorOver(k0, k1, mask, scratch),
        () => track.floorOver(k0, k1, null, scratch),
        () => track.floorOver(0, kSearch, null, scratch),
        () => track.floorOver(0, track.count, null, scratch),
      ],
      cfg.minFloor,
    );
  }
  if (floor === null) return null;

  const e = track.energyDb;
  const thrVoice = floor.db + p.anchorOverFloorDb;
  const isVoiced = (k: number): boolean => e[k]! >= thrVoice && track.periodicity(k) >= p.periodicity;
  const kFrom = track.frameAtOrAfter(searchFromSample);
  const kTo = track.frameAtOrAfter(anchorTo + 1);
  const ka = findAnchorFrame(track, kFrom, kTo, isVoiced);
  if (ka < 0) return null;
  const onset = onsetFromAnchor(track, ka, floor, 0);
  if (onset.nV > searchTo) return null;
  // The anchor frame is voiced, so the reply is never empty.
  const reply = replyFrom(track, track.frameAtOrAfter(onset.nV), isVoiced, n0 + ch0.length)!;
  return { ...onset, reply, beganBeforeSearch: Math.min(onset.nV, reply.start) < searchFromSample };
}
