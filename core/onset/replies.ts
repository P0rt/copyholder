// Replies (spec 4.2, 7.6): voiced windows form segments, and segments with a pause shorter than
// 1.0 s merge into one reply. A window is voiced when both anchor conditions hold: c >= 0.5 and
// E >= N + 15 dB (spec 7.6, assumption).

import type { FeatureTrack } from './features.ts';
import type { SampleSpan } from './params.ts';

export interface ReplyGroup {
  /** First voiced sample and end of the last voiced segment, [start, end). */
  readonly start: number;
  readonly end: number;
  /** Total voiced samples in the group. */
  readonly voicedSamples: number;
  readonly segments: readonly SampleSpan[];
}

/**
 * Groups voiced segments into replies: a pause shorter than `mergeGapSamples` (spec 4.2, 7.6:
 * 1.0 s) between two segments puts them in the same reply. Segments may come in any order.
 */
export function groupReplies(segments: readonly SampleSpan[], mergeGapSamples = 48000): ReplyGroup[] {
  const sorted = segments.filter((s) => s[1] > s[0]).sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const out: ReplyGroup[] = [];
  let cur: { start: number; end: number; voiced: number; segs: SampleSpan[] } | null = null;
  for (const s of sorted) {
    if (cur !== null && s[0] - cur.end < mergeGapSamples) {
      // Overlapping segments count their voiced samples once.
      cur.voiced += Math.max(0, s[1] - Math.max(s[0], cur.end));
      cur.end = Math.max(cur.end, s[1]);
      cur.segs.push(s);
    } else {
      if (cur !== null) out.push({ start: cur.start, end: cur.end, voicedSamples: cur.voiced, segments: cur.segs });
      cur = { start: s[0], end: s[1], voiced: s[1] - s[0], segs: [s] };
    }
  }
  if (cur !== null) out.push({ start: cur.start, end: cur.end, voicedSamples: cur.voiced, segments: cur.segs });
  return out;
}

/**
 * Runs of voiced frames in [k0, k1) as sample spans. Frame k stands for the hop that ends at its
 * window end, so a run of frames a..b covers [frameEnd(a) - hop, frameEnd(b)).
 */
export function voicedSegments(
  track: FeatureTrack,
  k0: number,
  k1: number,
  isVoiced: (k: number) => boolean,
): SampleSpan[] {
  const hop = track.cfg.hop;
  const out: SampleSpan[] = [];
  const end = Math.min(track.count, k1);
  for (let k = Math.max(0, k0); k < end; k++) {
    if (!isVoiced(k)) continue;
    const a = k;
    while (k + 1 < end && isVoiced(k + 1)) k++;
    out.push([track.frameEnd(a) - hop, track.frameEnd(k)]);
  }
  return out;
}

/** The reply a voice onset belongs to (gate variant of spec 7.6). */
export interface ReplyExtent extends ReplyGroup {
  /** Total voiced time, ms (spec 4.2: an objection needs >= 250 ms; onsets.json `voiced_ms`). */
  readonly voicedMs: number;
  /** The analysed range ended less than the merge gap after the last voiced window, before the
   * recording did: the reply may go on. */
  readonly truncated: boolean;
}

/**
 * The reply that frame `kStart` opens: voiced segments from there on, merged while the pause
 * stays shorter than the merge gap (spec 4.2). Voiced frames less than the merge gap before the
 * first voiced frame belong to the same reply too, so `start` can lie before kStart: the reply
 * began earlier. Frames before `kLow` are not looked at. Null when no frame from kStart on is voiced.
 */
export function replyFrom(
  track: FeatureTrack,
  kStart: number,
  isVoiced: (k: number) => boolean,
  recordingEnd: number,
  kLow = 0,
): ReplyExtent | null {
  const cfg = track.cfg;
  const gapFrames = Math.ceil(cfg.mergeGapSamples / cfg.hop);
  let first = -1;
  let last = -1;
  let k = Math.max(0, kStart);
  for (; k < track.count; k++) {
    if (last >= 0 && k - last > gapFrames) break;
    if (isVoiced(k)) {
      if (first < 0) first = k;
      last = k;
    }
  }
  if (last < 0) return null;
  // Pauses shorter than the merge gap also join earlier voice (spec 4.2).
  for (let j = first - 1; j >= Math.max(0, kLow) && first - j <= gapFrames; j--) if (isVoiced(j)) first = j;
  const group = groupReplies(voicedSegments(track, first, last + 1, isVoiced), cfg.mergeGapSamples)[0]!;
  const rangeEnd = track.frameEnd(track.count - 1);
  return {
    ...group,
    voicedMs: (group.voicedSamples * 1000) / cfg.fs,
    truncated: k >= track.count && rangeEnd < recordingEnd && rangeEnd - group.end < cfg.mergeGapSamples,
  };
}
