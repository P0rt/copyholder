// Automatic voice onsets of a day-1 gate recording, ledger step `onsets` (spec 4.2, 4.5, 7.6, 8.1):
// one search per cue, from the dot signal, giving the first reply after it. The reference knows
// nothing about detectors (spec 7.6): the floor mask and the previous reply come from channel 0
// alone, never from Deck's voice edges. Pure: a session in memory.

import { findOnset, findSessionOnsets, onsetAutoRecord, onsetEventFields, type GateOnsetResult, type OnsetAutoRecord } from '../../core/onset/index.ts';
import { SCORING_RULES_FIXED, type OnsetEvent, type OnsetKind } from '../../core/schemas/index.ts';
import { readingIntervals, round1, type Interval, type SessionView } from '../lib/measure.ts';
import { runView, stepMarks, type AudioView } from '../lib/session.ts';
import type { GateSteps } from '../lib/steps.ts';

/** The voice must begin within 10 s after the dot signal (spec 4.5, 7.12). */
export const CUE_SEARCH_MS = 10_000;
/** Channel 0 is scanned for replies from 30 s before the first cue to 30 s after the last (assumption). */
export const REPLY_SCAN_MARGIN_MS = 30_000;

export interface GateCue {
  /** Cue index, 1-based (the stamp's `i`, else the position). */
  i: number;
  /** Sample where the dot filled. */
  n: number;
}

/**
 * Cue starts of the objection block (spec 9.2, docs/protocol.md): `mark` `cue` stamps with on
 * true, with their `i` when they carry one. A recording without them gives the cue_<i>_on step
 * marks. Sorted by sample; a repeated index keeps its first stamp.
 */
export function gateCues(s: Pick<SessionView, 'stamps'>, gate: Pick<GateSteps, 'cueOn'>): GateCue[] {
  const marks = s.stamps.filter((m) => m.k === 'mark' && m.what === 'cue' && m.on !== false).sort((p, q) => p.n - q.n);
  let cues: GateCue[];
  if (marks.length > 0) {
    cues = marks.map((m, idx) => ({ i: typeof m.i === 'number' && Number.isInteger(m.i) && m.i >= 1 ? m.i : idx + 1, n: m.n }));
  } else {
    const order = new Map(gate.cueOn.map((name, idx) => [name, idx + 1]));
    cues = stepMarks(s)
      .filter((m) => order.has(m.name))
      .map((m) => ({ i: order.get(m.name)!, n: m.n }))
      .sort((p, q) => p.n - q.n);
  }
  const seen = new Set<number>();
  return cues.filter((c) => (seen.has(c.i) ? false : (seen.add(c.i), true)));
}

const inside = (n: number, spans: readonly Interval[]): boolean => spans.some(([a, b]) => n >= a && n < b);

/**
 * Replies in channel 0 around the cues (spec 4.2, 7.6): core/onset findSessionOnsets on each
 * recorded run that holds a cue, from 30 s before its first cue to 30 s after its last, with the
 * floor taken where the narrator reads. A window is voiced when both anchor conditions hold, and
 * pauses under 1.0 s merge. Channel 0 alone: no detector edge goes in. [start, end) in samples.
 */
export function channelReplies(s: SessionView, cues: readonly GateCue[], reading: readonly Interval[]): Interval[] {
  const margin = Math.round((REPLY_SCAN_MARGIN_MS * s.sampleRateHz) / 1000);
  const runs = new Map<number, { view: AudioView; first: number; last: number }>();
  for (const c of cues) {
    const view = runView(s, 0, c.n);
    if (!view) continue;
    const r = runs.get(view.n0);
    if (r) {
      r.first = Math.min(r.first, c.n);
      r.last = Math.max(r.last, c.n);
    } else {
      runs.set(view.n0, { view, first: c.n, last: c.n });
    }
  }
  const out: Interval[] = [];
  for (const { view, first, last } of runs.values()) {
    const from = Math.max(view.n0, first - margin);
    const to = Math.min(view.n1, last + margin);
    if (to <= from) continue;
    for (const r of findSessionOnsets(view.signal, { n0: view.n0, fromSample: from, toSample: to, reading })) out.push([r.start, r.end]);
  }
  return out.sort((p, q) => p[0] - q[0]);
}

/** End of the last reply that ended by sample `startN` (spec 4.2: any reply, not only a cue's), or null. */
export function previousReplyEnd(startN: number, replies: readonly Interval[]): number | null {
  let end: number | null = null;
  for (const [, b] of replies) if (b <= startN && (end === null || b > end)) end = b;
  return end;
}

/**
 * Kind of a reply (spec 4.2): a continuation when it began less than 4.0 s after the end of the
 * previous reply; otherwise an objection with at least 250 ms voiced that began while the narrator
 * read; otherwise other. The gate has no hold pauses (no stops, spec 9.3).
 */
export function replyKind(
  startN: number,
  voicedMs: number,
  prevEndN: number | null,
  reading: readonly Interval[],
  sampleRateHz: number,
): OnsetKind {
  const minGap = (SCORING_RULES_FIXED.min_gap_ms * sampleRateHz) / 1000;
  if (prevEndN !== null && startN - prevEndN < minGap) return 'continuation';
  if (voicedMs < SCORING_RULES_FIXED.min_voiced_ms || !inside(startN, reading)) return 'other';
  return 'objection';
}

/** onsets.json id of the reply to cue i: o01, o02, ... (spec 8.1 example ids). */
export function cueEventId(i: number): string {
  return `o${String(i).padStart(2, '0')}`;
}

export interface CueOnset {
  cue: GateCue;
  /** core/onset findOnset; null when no voice began within 10 s. */
  onset: GateOnsetResult | null;
  event: OnsetEvent | null;
  /** The reply was already going at the dot: n_v of the event lies before it (spec 4.5 item 3). */
  beganBeforeCue: boolean;
}

export interface GateOnsets {
  events: OnsetEvent[];
  cues: CueOnset[];
  /** Replies channel 0 holds around the cues, cue replies included. */
  replies: Interval[];
}

interface SearchContext {
  reading: readonly Interval[];
  replies: readonly Interval[];
}

/**
 * The onset of a reply that only paused at the dot (spec 4.2: pauses under 1.0 s merge, so the
 * reply began before it): the first anchor from the reply's first voiced window, walked back as
 * usual. When that part has no anchor, its first voiced window stands for t_v (assumption).
 * Either way n_v lies before the dot, so the reply counts as begun before the signal (spec 4.5).
 */
export function replyStartOnset(view: AudioView, onset: GateOnsetResult, cueN: number, ctx: SearchContext): { auto: OnsetAutoRecord; floorDb: number } {
  const early =
    onset.reply.start < cueN
      ? findOnset(view.signal, onset.reply.start, { n0: view.n0, searchToSample: cueN - 1, reading: ctx.reading, replies: ctx.replies })
      : null;
  if (early !== null && early.nV < cueN) return { auto: onsetAutoRecord(early), floorDb: early.floorDb };
  return { auto: { n_v: Math.min(onset.reply.start, onset.nV), n_a: onset.nA, breath: null, flags: [] }, floorDb: onset.floorDb };
}

/**
 * The automatic part of onsets.json for the gate (spec 4.5 item 3, 7.6): for each cue, core/onset
 * findOnset from the dot signal to 10 s after it, with the floor taken while the narrator reads and
 * outside the replies channel 0 holds. One reply per cue: the first after it. A reply that was
 * already going at the dot gets the n_v of its first voiced part, before the dot. The previous
 * reply of the 4.0 s rule is any reply in channel 0. A cue without voice in time gives no event.
 * `label` and `manual` stay null until the label step.
 */
export function gateOnsetEvents(s: SessionView, gate: Pick<GateSteps, 'cueOn'>): GateOnsets {
  const rate = s.sampleRateHz;
  const reading = readingIntervals(s);
  const cues = gateCues(s, gate);
  const scanned = channelReplies(s, cues, reading);
  const found: Interval[] = [];
  const out: CueOnset[] = [];
  for (const cue of cues) {
    const none: CueOnset = { cue, onset: null, event: null, beganBeforeCue: false };
    const view = runView(s, 0, cue.n);
    if (!view) {
      out.push(none);
      continue;
    }
    const ctx: SearchContext = { reading, replies: [...scanned, ...found] };
    const searchTo = Math.min(cue.n + Math.round((CUE_SEARCH_MS * rate) / 1000), view.n1 - 1);
    const onset = searchTo > cue.n ? findOnset(view.signal, cue.n, { n0: view.n0, searchToSample: searchTo, ...ctx }) : null;
    if (onset === null) {
      out.push(none);
      continue;
    }
    const fields = onsetEventFields(onset, onset.reply);
    let auto = fields.auto;
    let floorDb = fields.floor_db;
    if (onset.beganBeforeSearch && onset.nV >= cue.n) {
      const early = replyStartOnset(view, onset, cue.n, ctx);
      auto = early.auto;
      floorDb = round1(early.floorDb);
    }
    const start = Math.min(auto.n_v, onset.reply.start);
    const event: OnsetEvent = {
      id: cueEventId(cue.i),
      kind: replyKind(start, onset.reply.voicedMs, previousReplyEnd(start, ctx.replies), reading, rate),
      label: null,
      voiced_ms: fields.voiced_ms,
      floor_db: floorDb,
      cue: cue.i,
      n_end: fields.n_end,
      auto,
      manual: null,
    };
    out.push({ cue, onset, event, beganBeforeCue: auto.n_v < cue.n });
    found.push([onset.reply.start, onset.reply.end]);
  }
  return {
    events: out.flatMap((c) => (c.event ? [c.event] : [])),
    cues: out,
    replies: [...scanned, ...found].sort((p, q) => p[0] - q[0]),
  };
}

/** Events whose automatic onset has the flag no_dip (spec 7.6: their number is printed). */
export function noDipCount(events: readonly Pick<OnsetEvent, 'auto'>[]): number {
  return events.filter((e) => e.auto.flags.includes('no_dip')).length;
}
