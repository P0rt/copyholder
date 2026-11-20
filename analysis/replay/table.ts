// The per-cue table of `npm run replay -- --json <out.json>`: one row per cue of the scored
// block, with times and counts only (no pack text, no word, nothing of the narrator, spec 8.7).
// Times are ms from the start of the objection block (its step mark, spec 9.3), to 0.1 ms.
// Leads keep stage B's sign (spec 4.2, 9.6): lead = t_v - t_s, positive when the stop came before
// the voice onset. The cells come from stage B's functions on the replayed runs (analysis/gate
// rows.ts, runs.ts); the armed test and the manual onset are those of analysis/confirm/facts.ts,
// which repeat stage B's (score.ts keeps its own private). tableProblems checks the rows against
// the counts of the recomputed verdict before anything is written.

import type { OnsetEvent } from '../../core/schemas/index.ts';
import { armedRule, manualNv } from '../confirm/facts.ts';
import { nToMs, round1, type LrtUse } from '../gate/common.ts';
import { isObjection } from '../gate/objections.ts';
import { beforeVoiceStop, falseRate, isFalseStop, windowStopN } from '../gate/rows.ts';
import { activeMinutesIn, stopsIn, type DetectorRun, type RunStop } from '../gate/runs.ts';
import { sameJson } from '../gate/frozen.ts';
import { RESETS_FILE } from './set.ts';
import type { ScoredSet, SetReplay } from './recompute.ts';

/** A detector's stop around one valid objection. */
export interface StopCell {
  /** t_s of the earliest stop in [t_v - 1.5 s, t_v + 0.5 s] (rows.ts windowStopN), ms; null: none. */
  stop_ms: number | null;
  /** t_v - t_s of that stop, ms; positive: the stop came before the voice. */
  lead_ms: number | null;
  /** A stop before voice by row 1's test (rows.ts beforeVoiceStop, every L_rt value of the rule). */
  before_voice: boolean;
}

export interface CueRow {
  pack: 'A' | 'B' | 'C';
  id: string;
  /** Cue number in the block, from 1. */
  cue: number;
  cue_ms: number;
  /** A valid objection (spec 9.6); why_not says why not. */
  valid: boolean;
  why_not: string | null;
  /** Automatic voice onset t_v of the cue's reply; null without a reply. */
  voice_onset_ms: number | null;
  /** The onset of stage B's manual line: the blind hand mark, or t_v where the mark has no first sound. */
  manual_onset_ms: number | null;
  /** True when the reply has a hand mark with a first sound. */
  manual_mark: boolean | null;
  /** Valid objections only; null otherwise. */
  chest: StopCell | null;
  /** Valid objections only; null otherwise, and null when the readings of the packets with g null place the stop differently (lips_why). */
  lips: StopCell | null;
  /** Why lips is null for a valid objection; null otherwise. */
  lips_why: string | null;
  /** Row 1: hit when the chest stopped before voice; null for a cue without a valid objection. */
  result: 'hit' | 'miss' | null;
  /** The window before t_v lies in D1's active time (spec 4.3); valid objections only. */
  armed: boolean | null;
  /** An audible in-breath before the reply (events.audible_inbreath counts them); valid objections only. */
  audible_inbreath: boolean | null;
  /**
   * False stops (rows.ts isFalseStop) whose fire lies between this cue and the next, or the end of
   * the block; lips null when the readings of the packets with g null count them differently.
   */
  false_stops: { chest: number; lips: number | null };
}

export interface SetSummary {
  id: string;
  pack: 'A' | 'B' | 'C';
  set: string;
  cues: number;
  valid: number;
  /** False stops of the scored block before its first cue (with the rows' they add up to row 3's count). */
  false_stops_before_first_cue: { chest: number; lips: number | null };
  /** Where the reset frames of G come from: RESETS_FILE, none (no packet with g null), or both readings (recompute.ts gReadings). */
  g_resets: string;
  /** Cues whose valid objection has no lips cell: its stop differs between the readings. */
  lips_unknown: number[];
}

export interface ReplayTable {
  schema: 'replay-table/2';
  times: string;
  lead: string;
  sets: SetSummary[];
  rows: CueRow[];
}

const ms = (n: number, nCut: number): number => round1(nToMs(n - nCut));

function cell(stops: readonly RunStop[], nV: number, lrt: LrtUse, nCut: number): StopCell {
  const t = windowStopN(stops, nV, lrt);
  return {
    stop_ms: t === null ? null : ms(t, nCut),
    lead_ms: t === null ? null : round1(nToMs(nV - t)),
    before_voice: beforeVoiceStop(stops, nV, lrt) !== null,
  };
}

/** False stops of a run in [n0, n1), as stage B counts them for row 3. */
function falseIn(stops: readonly RunStop[], n0: number, n1: number, starts: readonly number[], lrt: LrtUse): number {
  return stops.filter((s) => s.nFire >= n0 && s.nFire < n1 && isFalseStop(s, starts, lrt)).length;
}

/** The one value every reading gives, or null when they differ. */
function agreed<T>(values: readonly T[]): T | null {
  return values.every((v) => sameJson(v, values[0])) ? values[0]! : null;
}

function hasMark(e: OnsetEvent): boolean {
  return e.manual !== null && e.manual.n_v !== null;
}

function gResetsText(r: ScoredSet): string {
  if (r.gSource === 'file') return RESETS_FILE;
  if (r.gSource === 'no null') return 'no packet with g null';
  return 'both readings: every packet with g null a reset frame, and none';
}

/** The rows of one scored set, in cue order. */
export function cueRows(r: SetReplay & { scored: ScoredSet }): { rows: CueRow[]; summary: SetSummary } {
  const { scores, layout, lrt } = r.scored;
  const d1 = scores[0]!.runs.d1;
  const gs = scores.map((s) => s.runs.g);
  const nCut = layout.nCut;
  const end = layout.scored.n1;
  const starts = r.set.onsets.events.filter(isObjection).map((e) => e.auto.n_v).sort((a, b) => a - b);
  const armedAt = armedRule(d1, lrt);
  const replies = scores[0]!.replies;
  const lipsWhy = `the readings of the packets with g null place this stop differently; stream.jsonl does not say which were reset frames (${RESETS_FILE} would)`;
  const rows = replies.map((c, i): CueRow => {
    const next = replies[i + 1]?.cueN ?? end;
    const e = c.reply;
    const nV = e?.auto.n_v ?? null;
    const valid = c.valid && e !== null && nV !== null;
    const chest = valid ? cell(d1.stops, nV, lrt, nCut) : null;
    const lips = valid ? agreed(gs.map((g) => cell(g.stops, nV, lrt, nCut))) : null;
    return {
      pack: r.set.pack,
      id: r.set.id,
      cue: c.cue,
      cue_ms: ms(c.cueN, nCut),
      valid,
      why_not: c.why,
      voice_onset_ms: nV === null ? null : ms(nV, nCut),
      manual_onset_ms: e === null ? null : ms(manualNv(e), nCut),
      manual_mark: e === null ? null : hasMark(e),
      chest,
      lips,
      lips_why: valid && lips === null ? lipsWhy : null,
      result: chest === null ? null : chest.before_voice ? 'hit' : 'miss',
      armed: valid ? armedAt(nV) : null,
      // Stage B counts the in-breaths of valid objections only (score.ts pointsAuto).
      audible_inbreath: valid ? e.auto.breath !== null : null,
      false_stops: { chest: falseIn(d1.stops, c.cueN, next, starts, lrt), lips: agreed(gs.map((g) => falseIn(g.stops, c.cueN, next, starts, lrt))) },
    };
  });
  const first = replies[0]?.cueN ?? end;
  return {
    rows,
    summary: {
      id: r.set.id,
      pack: r.set.pack,
      set: r.set.name,
      cues: replies.length,
      valid: rows.filter((x) => x.valid).length,
      false_stops_before_first_cue: {
        chest: falseIn(d1.stops, layout.scored.n0, first, starts, lrt),
        lips: agreed(gs.map((g) => falseIn(g.stops, layout.scored.n0, first, starts, lrt))),
      },
      g_resets: gResetsText(r.scored),
      lips_unknown: rows.filter((x) => x.valid && x.lips === null).map((x) => x.cue),
    },
  };
}

/** The table of every set, in the order given. */
export function replayTable(sets: readonly (SetReplay & { scored: ScoredSet })[]): ReplayTable {
  const parts = sets.map(cueRows);
  return {
    schema: 'replay-table/2',
    times: 'ms from the step mark that starts the objection block of each set, to 0.1 ms (spec 9.3)',
    lead: 'lead_ms = t_v - t_s with the less favorable L_rt: positive when the stop came before the voice onset (stage B, spec 4.2, 9.6)',
    sets: parts.map((p) => p.summary),
    rows: parts.flatMap((p) => p.rows),
  };
}

/**
 * Where the table does not add up to the recomputed verdict of its set (stage B's own counts:
 * cued, valid, hits, armed, audible in-breath, and the false stops of row 3 in the scored block);
 * empty when it does. A problem is a fault of replay, not of the set.
 */
export function tableProblems(table: ReplayTable, sets: readonly (SetReplay & { scored: ScoredSet })[]): string[] {
  const out: string[] = [];
  for (const r of sets) {
    const rows = table.rows.filter((x) => x.id === r.set.id);
    const summary = table.sets.find((s) => s.id === r.set.id);
    const { scores, layout, lrt } = r.scored;
    const v = scores[0]!.verdict;
    const starts = r.set.onsets.events.filter(isObjection).map((e) => e.auto.n_v).sort((a, b) => a - b);
    const falseCount = (run: DetectorRun): number => falseRate(stopsIn(run, layout.scored), starts, lrt, activeMinutesIn(run, layout.scored)).falseStops;
    const count = (f: (x: CueRow) => boolean): number => rows.filter(f).length;
    const pairs: [string, number, number][] = [
      ['cues', rows.length, v.events.cued],
      ['valid objections', count((x) => x.valid), v.events.valid],
      ['hits', count((x) => x.result === 'hit'), v.rows.hits.hits],
      ['armed objections', count((x) => x.armed === true), v.events.armed],
      ['audible in-breaths', count((x) => x.audible_inbreath === true), v.events.audible_inbreath],
      ['chest false stops', rows.reduce((a, x) => a + x.false_stops.chest, 0) + (summary?.false_stops_before_first_cue.chest ?? 0), falseCount(scores[0]!.runs.d1)],
    ];
    const lipsCounts = [...rows.map((x) => x.false_stops.lips), summary?.false_stops_before_first_cue.lips ?? null];
    if (lipsCounts.every((x) => x !== null)) {
      const lips = agreed(scores.map((s) => falseCount(s.runs.g)));
      if (lips !== null) pairs.push(['lips false stops', lipsCounts.reduce((a, x) => a + x!, 0), lips]);
    }
    for (const [what, inTable, inVerdict] of pairs) {
      if (inTable !== inVerdict) out.push(`${r.set.name}: ${inTable} ${what} in the table, ${inVerdict} in the recomputed verdict`);
    }
  }
  return out;
}
