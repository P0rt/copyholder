// Blind labels of the label step (spec 7.6, 8.1, 8.5): the random order, the marks, their hash,
// the final onsets.json and the clock report's onset block. Pure: the hash function is passed in.

import { onsetBlock, type OnsetErrorBlock } from '../../core/clock/index.ts';
import { ONSET_LABELS, validateOnsets, type HashFn, type OnsetEvent, type OnsetLabel, type Onsets } from '../../core/schemas/index.ts';
import { createSeededRng } from '../../core/stats/rng.ts';
import { CUE_SEARCH_MS } from './gate-onsets.ts';

/**
 * Shown window: 1 s before the cue to 1 s past the end of the 10 s search (spec 4.5 item 3), so
 * every reply the automatic search can accept starts inside it. Anchored on the cue (or the
 * search start), never on the automatic onset: the page stays blind (spec 7.6).
 */
export const WINDOW_BEFORE_MS = 1000;
export const WINDOW_AFTER_MS = CUE_SEARCH_MS + 1000;

/** What the page sends for "No reply". */
export const NO_REPLY = 'none';
/**
 * "No reply" is stored as label `other` without a first-sound mark: the found sound is not a
 * reply, so it never counts as an objection (spec 4.2, 8.1 labels; assumption).
 */
export const NO_REPLY_LABEL: OnsetLabel = 'other';

/**
 * A soft first sound (spec 6.3, 7.12 name the count, not the rule; assumption): a speech event
 * whose first sound is no clear voiced attack. Its automatic onset has the flag no_dip (inhale
 * noise runs into the voice), or its first sound starts at least 50 ms before the voiced anchor
 * t_a (an unvoiced, breathy or aspirated start). Signal only: not the hand mark's distance.
 */
export const SOFT_FIRST_SOUND_MIN_LEAD_MS = 50;

/** One page item: a cue (gate) or a reply (sessions), with the sample its window hangs on. */
export interface LabelItem {
  id: string;
  /** Cue (gate) or search start (sessions): the window is [anchor - 1 s, anchor + 11 s). */
  anchor: number;
  /** false: the automatic search found no voice here, so onsets.json has no event to hold the mark. */
  hasEvent: boolean;
}

/** A blind mark: a sound type with its first-sound sample; no reply is `other` with n_v null. */
export interface LabelMark {
  id: string;
  label: OnsetLabel;
  n_v: number | null;
}

export function windowSamples(sampleRateHz: number): { before: number; after: number; length: number } {
  const before = Math.round((WINDOW_BEFORE_MS * sampleRateHz) / 1000);
  const after = Math.round((WINDOW_AFTER_MS * sampleRateHz) / 1000);
  return { before, after, length: before + after };
}

/** Random display order: Fisher-Yates with the seeded generator of core/stats. */
export function shuffledOrder<T>(items: readonly T[], seed: number): T[] {
  const rng = createSeededRng(seed);
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

export function isOnsetLabel(x: unknown): x is OnsetLabel {
  return typeof x === 'string' && (ONSET_LABELS as readonly string[]).includes(x);
}

export function isNoReply(m: Pick<LabelMark, 'n_v'>): boolean {
  return m.n_v === null;
}

/**
 * A mark from the page: `label` one of the sound types with `offset` a whole sample inside the
 * window, or "none" (no reply) without an offset. Returns the mark or why it is not one.
 */
export function markFromPage(item: LabelItem, body: { label?: unknown; offset?: unknown }, sampleRateHz: number): LabelMark | string {
  const w = windowSamples(sampleRateHz);
  if (body.label === NO_REPLY) {
    if (body.offset !== null && body.offset !== undefined) return 'no reply takes no first-sound mark';
    return { id: item.id, label: NO_REPLY_LABEL, n_v: null };
  }
  if (!isOnsetLabel(body.label)) return `label must be one of ${ONSET_LABELS.join(', ')} or ${NO_REPLY}`;
  const offset = body.offset;
  if (typeof offset !== 'number' || !Number.isInteger(offset) || offset < 0 || offset >= w.length) {
    return `a ${body.label} mark needs its first sound: a whole sample from 0 to ${w.length - 1}`;
  }
  const n = item.anchor - w.before + offset;
  if (n < 0) return 'the mark lies before the recording';
  return { id: item.id, label: body.label, n_v: n };
}

/** A saved mark as the page shows it again: its kind ("none" for no reply) and its offset in the window. */
export function pageMarkOf(item: LabelItem, m: LabelMark, sampleRateHz: number): { label: string; offset: number | null } {
  if (isNoReply(m)) return { label: NO_REPLY, offset: null };
  return { label: m.label, offset: m.n_v! - (item.anchor - windowSamples(sampleRateHz).before) };
}

const byId = (p: { id: string }, q: { id: string }): number => (p.id < q.id ? -1 : p.id > q.id ? 1 : 0);

/**
 * labels_sha256 (spec 8.1, 8.6): SHA-256 of {"schema":"labels/2","marks":[...]} as compact JSON,
 * the marks of the onsets.json events sorted by id as {"id","label","n_v"}. Only what onsets.json
 * publishes goes in, so anyone can recompute it from that file (onsetsLabelsSha256). The seed,
 * the order and marks without an automatic event go to ledger notes, which the chain fixes too.
 */
export function labelsSha256(marks: readonly LabelMark[], hash: HashFn): string {
  const sorted = [...marks].sort(byId).map((m) => ({ id: m.id, label: m.label, n_v: m.n_v }));
  return hash(JSON.stringify({ schema: 'labels/2', marks: sorted }));
}

/** labels_sha256 recomputed from onsets.json alone; null while an event has no blind label. */
export function onsetsLabelsSha256(onsets: Onsets, hash: HashFn): string | null {
  const marks: LabelMark[] = [];
  for (const e of onsets.events) {
    if (e.label === null || e.manual === null) return null;
    marks.push({ id: e.id, label: e.label, n_v: e.manual.n_v });
  }
  return labelsSha256(marks, hash);
}

/** The marks of items with an onsets.json event, and those without one (spec 9.5: every cue is labelled). */
export function splitMarks(items: readonly LabelItem[], marks: readonly LabelMark[]): { eventMarks: LabelMark[]; withoutEvent: LabelMark[] } {
  const hasEvent = new Map(items.map((i) => [i.id, i.hasEvent]));
  const eventMarks: LabelMark[] = [];
  const withoutEvent: LabelMark[] = [];
  for (const m of marks) {
    const h = hasEvent.get(m.id);
    if (h === undefined) throw new Error(`mark for unknown item ${m.id}`);
    (h ? eventMarks : withoutEvent).push(m);
  }
  return { eventMarks, withoutEvent };
}

/** Marks as words for a ledger note: "o05 speech n_v 1234567; o09 no reply". */
export function marksText(marks: readonly LabelMark[]): string {
  return [...marks]
    .sort(byId)
    .map((m) => (isNoReply(m) ? `${m.id} no reply` : `${m.id} ${m.label} n_v ${m.n_v}`))
    .join('; ');
}

/** A soft first sound: speech with a hand mark whose automatic onset has no_dip or starts >= 50 ms before t_a. */
export function isSoftFirstSound(e: Pick<OnsetEvent, 'label' | 'auto' | 'manual'>, sampleRateHz: number): boolean {
  if (e.label !== 'speech' || !e.manual || e.manual.n_v === null) return false;
  if (e.auto.flags.includes('no_dip')) return true;
  return e.auto.n_a - e.auto.n_v >= (SOFT_FIRST_SOUND_MIN_LEAD_MS * sampleRateHz) / 1000;
}

/** onsets.json after the label step: every event gets its label and manual mark, plus the labels hash. */
export function applyMarks(onsets: Onsets, marks: readonly LabelMark[], labelsHash: string): Onsets {
  const byEvent = new Map(marks.map((m) => [m.id, m]));
  const missing = onsets.events.filter((e) => !byEvent.has(e.id)).map((e) => e.id);
  if (missing.length > 0) throw new Error(`no mark for event(s) ${missing.join(', ')}`);
  const ids = new Set(onsets.events.map((e) => e.id));
  const extra = marks.filter((m) => !ids.has(m.id)).map((m) => m.id);
  if (extra.length > 0) throw new Error(`mark(s) for ${extra.join(', ')}, which onsets.json has no event for`);
  return {
    ...onsets,
    labels_sha256: labelsHash,
    events: onsets.events.map((e) => {
      const m = byEvent.get(e.id)!;
      return { ...e, label: m.label, manual: { n_v: m.n_v, blind: true } };
    }),
  };
}

/**
 * clock_report.json `onset` (spec 6.3, 7.12): P90 of |auto - manual| over the events labelled
 * speech with a hand mark (core/clock onsetBlock), and the soft first sounds among them.
 */
export function onsetErrorBlock(onsets: Onsets, sampleRateHz: number): OnsetErrorBlock {
  const pairs = onsets.events
    .filter((e) => e.label === 'speech' && e.manual !== null && e.manual.n_v !== null)
    .map((e) => ({ autoNv: e.auto.n_v, manualNv: e.manual!.n_v!, soft: isSoftFirstSound(e, sampleRateHz) }));
  return onsetBlock(pairs, sampleRateHz);
}

/**
 * Whether core/schemas accepts `label_order` {seed, order} in onsets.json. The task asks for the
 * seed in onsets.json, but the schema is closed today: until it accepts the key, seed and order
 * go to the ledger note `label_order`.
 */
export function onsetsAcceptLabelOrder(): boolean {
  return validateOnsets({ schema: 'onsets/1', labels_sha256: null, events: [], label_order: { seed: 1, order: [] } }).length === 0;
}

/** onsets.json with `label_order` when the schema takes it. */
export function withLabelOrder(onsets: Onsets, seed: number, order: readonly string[]): Onsets {
  return onsetsAcceptLabelOrder() ? ({ ...onsets, label_order: { seed, order: [...order] } } as Onsets) : onsets;
}
