// Session variant of spec 7.6: voiced windows over the whole recording, grouped into replies
// (pauses < 1.0 s merge, spec 4.2), with the floor N computed per anchor candidate from the
// frames 10 s to 1 s before it where the narrator reads and nobody speaks.

import { computeFeatures, type Floor } from './features.ts';
import { findAnchorFrame, floorMask, onsetFromAnchor, pickFloor, type OnsetResult } from './onset.ts';
import { checkSamples, resolveOnsetConfig, type OnsetParams, type SampleSpan } from './params.ts';
import { groupReplies, voicedSegments, type ReplyGroup } from './replies.ts';

export interface Reply extends ReplyGroup {
  /** Total voiced time, ms (spec 4.2: an objection needs >= 250 ms; onsets.json `voiced_ms`). */
  readonly voicedMs: number;
  /** Onset from the first 40-of-60 anchor inside the reply; null when the reply has none. */
  readonly onset: OnsetResult | null;
  /** Whether n_v (or the reply start, without an onset) lies inside `search`; true without `search`. */
  readonly inSearch: boolean;
}

export interface SessionOnsetOptions {
  readonly params?: Partial<OnsetParams>;
  /** Absolute sample number of ch0[0] (default 0). */
  readonly n0?: number;
  /** Analysed range of absolute samples (default: the whole recording). */
  readonly fromSample?: number;
  readonly toSample?: number;
  /**
   * Narrator reading: floor frames must lie inside (default: everywhere). Spans of the narrator's
   * sound (narratorSoundSpans) keep its leak in N, as spec 7.6 assumes; Deck's `narrating` spans
   * also hold its pauses, and a sparse narrator then leaves the leak out of N.
   */
  readonly reading?: readonly SampleSpan[];
  /**
   * Known replies, e.g. the recorded voice edges: floor frames must lie outside (default: none).
   * The replies this function finds are kept out of the floor in any case (spec 7.6).
   */
  readonly replies?: readonly SampleSpan[];
  /** Search time, narrator reading or hold pause (spec 7.6); only sets `inSearch`. */
  readonly search?: readonly SampleSpan[];
}

function inSpans(n: number, spans: readonly SampleSpan[]): boolean {
  for (const [a, b] of spans) if (n >= a && n < b) return true;
  return false;
}

/**
 * Replies and their onsets over a session recording (spec 7.6, session variant). A frame is
 * voiced when c >= 0.5 and E >= N + 15 dB, with N recomputed every 100 ms (assumption) from
 * the frames 10 s to 1 s before, inside `reading`, outside `replies` and outside the replies
 * found so far: frames run in time order, and every voiced frame adds its reply's span (pauses
 * shorter than the merge gap included) to the frames the floor leaves out, so a long reply
 * never lifts the floor of its own later words or of the replies after it.
 */
export function findSessionOnsets(ch0: Float32Array, opts: SessionOnsetOptions = {}): Reply[] {
  const cfg = resolveOnsetConfig(opts.params);
  const p = cfg.p;
  const n0 = checkSamples('findSessionOnsets', opts.n0 ?? 0, { fromSample: opts.fromSample, toSample: opts.toSample });
  const from = opts.fromSample ?? n0;
  const to = opts.toSample ?? n0 + ch0.length;
  const track = computeFeatures(ch0, n0, from, to, cfg);
  const count = track.count;
  if (count === 0) return [];
  const e = track.energyDb;
  const hop = cfg.hop;
  // 1 = the frame may hold the floor: `use` follows reading, replies and the replies found here;
  // `quiet` only the replies found here (the fallback when the masks leave too few frames).
  const use = floorMask(track, opts.reading, opts.replies) ?? new Uint8Array(count).fill(1);
  const quiet = new Uint8Array(count).fill(1);
  const scratch = new Float64Array(count);

  // Floor for a candidate at frame kc: frames 10 s to 1 s before it, narrator reading, no reply.
  // Fallbacks when that leaves less than 1 s (assumption): 60 s back; then the same windows
  // without the reading and reply masks but still without the replies found here; last, the
  // first 10 s of the range as they are.
  const wideBack = Math.max(cfg.floorFrom, Math.round(60000 / p.hopMs));
  const floorBefore = (kc: number): Floor =>
    // The last fallback always has frames: count > 0.
    pickFloor(
      [
        () => track.floorOver(kc - cfg.floorFrom, kc - cfg.floorTo, use, scratch),
        () => track.floorOver(kc - wideBack, kc - cfg.floorTo, use, scratch),
        () => track.floorOver(kc - cfg.floorFrom, kc - cfg.floorTo, quiet, scratch),
        () => track.floorOver(kc - wideBack, kc - cfg.floorTo, quiet, scratch),
        () => track.floorOver(0, Math.min(count, cfg.floorFrom), null, scratch),
      ],
      cfg.minFloor,
    )!;
  /** Leaves the samples [a, b) of a reply out of the floor (frames whose window centre lies there). */
  const exclude = (a: number, b: number): void => {
    track.maskFromSpans([[a, b]], use, 0);
    track.maskFromSpans([[a, b]], quiet, 0);
  };

  // Voiced frames use the floor of their 100 ms grid cell (assumption); the anchor's own floor
  // is exact. A cell's floor ends 1 s before the cell, and a pause of 1 s ends a reply, so every
  // frame it reads has its final reply mask when the merge gap is at most floorToMs (defaults).
  const gridSamples = cfg.floorGrid * hop;
  const voiced = new Uint8Array(count);
  let cell = Number.NaN;
  let cellFloor: Floor | null = null;
  let lastVoiced = -1;
  for (let k = 0; k < count; k++) {
    const g = Math.floor(track.frameEnd(k) / gridSamples);
    if (g !== cell || cellFloor === null) {
      cell = g;
      cellFloor = floorBefore(track.frameAtOrAfter(g * gridSamples));
    }
    if (e[k]! < cellFloor.db + p.anchorOverFloorDb || track.periodicity(k) < p.periodicity) continue;
    voiced[k] = 1;
    // Frame k stands for the hop that ends at its window end (replies.ts voicedSegments).
    const pauseSamples = lastVoiced < 0 ? Infinity : (k - lastVoiced - 1) * hop;
    exclude(pauseSamples < cfg.mergeGapSamples ? track.frameEnd(lastVoiced) : track.frameEnd(k) - hop, track.frameEnd(k));
    lastVoiced = k;
  }

  const segments = voicedSegments(track, 0, count, (k) => voiced[k] === 1);

  const replies: Reply[] = [];
  let kMin = 0;
  for (const grp of groupReplies(segments, cfg.mergeGapSamples)) {
    const kStart = track.frameAtOrAfter(grp.start + hop);
    const kEnd = track.frameAtOrAfter(grp.end);
    const ka = findAnchorFrame(track, kStart, kEnd + 1, (k) => voiced[k] === 1);
    const onset = ka >= 0 ? onsetFromAnchor(track, ka, floorBefore(ka), kMin) : null;
    const startSample = onset !== null ? onset.nV : grp.start;
    replies.push({
      ...grp,
      voicedMs: (grp.voicedSamples * 1000) / cfg.fs,
      onset,
      inSearch: opts.search === undefined || inSpans(startSample, opts.search),
    });
    kMin = kEnd + 1;
  }
  return replies;
}
