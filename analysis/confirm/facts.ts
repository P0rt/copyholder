// The facts of one gate pack that the pooled numbers of PREREG.md section 11 add up, from the
// runs stage B made (analysis/gate/score.ts scoreGate): the valid objections, the stops before
// the voice and their leads, the false holds and active minutes of the objection block, the
// pairs against the lips (G) and the 250 ms rule (A250), G at every theta_G of the grid for the
// exploratory line of section 6.5, the circle of the circular shifts, and the sensitivity lines
// of section 5. Every count comes from the functions stage B uses (analysis/gate/rows.ts,
// objections.ts, runs.ts, rivals); nothing here finds an onset or a stop. Pure: no I/O.

import { THETA_G_GRID, type OnsetEvent, type Verdict } from '../../core/schemas/index.ts';
import { buildShiftSession, isWindowArmed, median, type ChestFireMs, type IntervalMs, type ShiftSession } from '../../core/stats/index.ts';
import { audioRuleStops, type SpanSamples } from '../rivals/index.ts';
import { W_MS, msToN, nToMs, round1, round1OrNull, stopOnMicN, type LrtUse } from '../gate/common.ts';
import { isObjection, scoreCues, type CueReply, type ValidityContext } from '../gate/objections.ts';
import { falseRate, hitsRow, missesOf, pairTally, windowStopN, type FalseRate, type HitsRow, type ObjectionPoint, type PairTally } from '../gate/rows.ts';
import { activeMinutesIn, stopsIn, type DetectorRun, type RunStop } from '../gate/runs.ts';
import { ConfirmRefusal, EARLIER_MS, OBJECTION_400_MS } from './common.ts';
import { packCircleInput } from './stats.ts';

/** What stage B's computation gives for one pack (scoreGate's runs and replies, and its inputs). */
export interface PackRuns {
  id: string;
  pack: 'A' | 'B' | 'C';
  lrt: LrtUse;
  /** The objection block (stage B's scored block). */
  scored: SpanSamples;
  /** Cue starts inside the block. */
  cues: readonly number[];
  /** Every event of onsets.json, as label left it. */
  onsets: readonly OnsetEvent[];
  /** Trace and validationStatus timelines: what makes an objection valid (section 7.5). */
  ctx: ValidityContext;
  /** One reply per cue, as stage B found them. */
  replies: readonly CueReply[];
  /** The trace detector (D1, or D3 after the ladder) with its own stop model. */
  d1: DetectorRun;
  /** The lips rival at the pack's own stage A theta_G. */
  g: DetectorRun;
  /** The lips rival at another theta_G, run as scoreGate runs it for its exploratory line. */
  gAt: (thetaG: number) => DetectorRun;
  thetaG: number;
}

/** The sensitivity lines of section 5, beside the main line on automatic onsets. */
export const SENSITIVITY_KEYS = ['manual', 'earlier_25ms', 't_a', 'objection_400ms', 'non_speech_included'] as const;
export type SensitivityKey = (typeof SENSITIVITY_KEYS)[number];

/** Labels as printed, in their final form: a symbol such as t_a keeps its case. */
export const SENSITIVITY_LABELS: Readonly<Record<SensitivityKey, string>> = {
  manual: 'Blind manual onsets instead of automatic ones',
  earlier_25ms: `All onsets ${EARLIER_MS} ms earlier`,
  t_a: 'Anchor t_a instead of t_v',
  objection_400ms: `Objections need ${OBJECTION_400_MS} ms of voiced sound, not 250 ms`,
  non_speech_included: 'Non-speech (cough, laugh, throat, other) counted as objections',
};

/** G at one theta_G of the grid (section 6.4): its false fires in the objection block, and the pairs of section 6.5. */
export interface LipsAtTheta {
  thetaG: number;
  lipsFalse: FalseRate;
  /** Chest first: wins are the chest's. */
  vsLips: PairTally;
}

/**
 * The exploratory line of section 6.5 as stage B draws it (analysis/gate/score.ts equalRateTheta):
 * the smallest theta_G of the grid at which the lips' false rate, rounded to 0.1 per minute as
 * printed, is at most the chest's. Without a chest rate there is no line; when no theta_G
 * qualifies, `thetaG` is null and `lipsPerMin` is the rate at the largest one.
 */
export function equalRateOf(grid: readonly { thetaG: number; perMin: number | null }[], chestPerMin: number | null): { index: number | null; thetaG: number | null; lipsPerMin: number | null; lastThetaG: number } | null {
  if (chestPerMin === null || grid.length === 0) return null;
  let lipsPerMin: number | null = null;
  for (const [index, g] of grid.entries()) {
    lipsPerMin = g.perMin;
    if (g.perMin !== null && round1(g.perMin) <= round1(chestPerMin)) return { index, thetaG: g.thetaG, lipsPerMin, lastThetaG: g.thetaG };
  }
  return { index: null, thetaG: null, lipsPerMin, lastThetaG: grid[grid.length - 1]!.thetaG };
}

export interface SensitivityFacts {
  /** Valid objections of the line. */
  valid: number;
  hits: HitsRow;
}

export interface PackFacts {
  id: string;
  pack: 'A' | 'B' | 'C';
  cued: number;
  /** Valid objections on the automatic onsets, as stage B scores them. */
  points: ObjectionPoint[];
  hits: HitsRow;
  /** Valid objections without a stop before the voice, by audible in-breath (section 7.6). */
  misses: { noInbreath: number; inbreathAudible: number };
  /** Leads of every valid objection with a stop from t_v - W to t_v + 0.5 s, ms. */
  leadsAllMs: number[];
  /** The trace detector's false holds over its active minutes in the objection block. */
  chestFalse: FalseRate;
  /** The lips' false fires over their own active minutes in the objection block. */
  lipsFalse: FalseRate;
  vsLips: PairTally;
  vsA250: PairTally;
  /** A250 stops made (one per valid objection, less those inside its own wait). */
  a250Stops: number;
  thetaG: number;
  /** G at every theta_G of the grid, ascending (section 6.4), for the exploratory line of section 6.5. */
  lipsGrid: LipsAtTheta[];
  /** The circle of the circular shifts (section 9.2 item 2). */
  circle: ShiftSession;
  sensitivity: Record<SensitivityKey, SensitivityFacts>;
}

/** The pack's own exploratory line (section 6.5), as stage B prints it in verdict.json; null without one. */
export function ownEqualRate(f: Pick<PackFacts, 'lipsGrid' | 'chestFalse'>): { wins: number; losses: number } | null {
  const e = equalRateOf(
    f.lipsGrid.map((g) => ({ thetaG: g.thetaG, perMin: g.lipsFalse.perMin })),
    f.chestFalse.perMin,
  );
  if (e === null || e.index === null) return null;
  const t = f.lipsGrid[e.index]!.vsLips;
  return { wins: t.wins, losses: t.losses };
}

/** The armed rule of section 3.2 as stage B applies it: [t_v - W, t_v) in active time, fires excepted. */
export function armedRule(d1: Pick<DetectorRun, 'spans' | 'stops'>, lrt: LrtUse): (nV: number) => boolean {
  const activeMs: IntervalMs[] = d1.spans.map((s) => ({ startMs: nToMs(s.n0), endMs: nToMs(s.n1) }));
  const fires: ChestFireMs[] = d1.stops.map((s) => ({ fireMs: nToMs(s.nFire), stopMs: nToMs(stopOnMicN(s.nSilent, lrt.worstMs)) }));
  return (nV) => isWindowArmed(nToMs(nV), activeMs, fires, W_MS);
}

/** Valid replies of the cues (stage B: valid and with a reply). */
export function validReplies(replies: readonly CueReply[]): (CueReply & { reply: OnsetEvent })[] {
  return replies.filter((r): r is CueReply & { reply: OnsetEvent } => r.valid && r.reply !== null);
}

/** Objection points as stage B builds them, with the voice onset `nvOf` gives (automatic, manual, shifted). */
export function pointsOf(valid: readonly (CueReply & { reply: OnsetEvent })[], nvOf: (e: OnsetEvent) => number, armedAt: (nV: number) => boolean): ObjectionPoint[] {
  return valid.map((r) => {
    const nV = nvOf(r.reply);
    return { cue: r.cue, nV, armed: armedAt(nV), breath: r.reply.auto.breath !== null };
  });
}

/** Stage B's manual onset: the blind hand mark, or the automatic onset where the mark has no first sound. */
export function manualNv(e: OnsetEvent): number {
  return e.manual?.n_v ?? e.auto.n_v;
}

/** Events as the 400 ms line reads them: an objection with less voiced sound is an "other" utterance (section 3.2). */
export function withObjectionThreshold(events: readonly OnsetEvent[], minVoicedMs: number): OnsetEvent[] {
  return events.map((e) => (e.kind === 'objection' && e.voiced_ms < minVoicedMs ? { ...e, kind: 'other' } : e));
}

/** Events with non-speech read as speech: the "non-speech included" line of section 3.2 and 5. */
export function withNonSpeechIncluded(events: readonly OnsetEvent[]): OnsetEvent[] {
  return events.map((e) => (e.kind === 'objection' && !isObjection(e) ? { ...e, label: 'speech' } : e));
}

/** A250 with its own stop model on the valid objections, as stage B pairs it (section 6.4, 6.5). */
export function a250StopsOf(valid: readonly (CueReply & { reply: OnsetEvent })[]): RunStop[] {
  const onsets = valid.map((r) => ({ nV: r.reply.auto.n_v, nEnd: r.reply.n_end ?? null }));
  return audioRuleStops(onsets, 250).map((s) => ({ seq: -1, nFire: s.nFire, nSilent: s.nSilent }));
}

/**
 * Where the facts of a pack differ from the counts of its verdict (verdict.json as stage B wrote
 * it, or scoreGate's verdict on the same runs): the pooled numbers are sums of these facts, so they
 * must be the verdict's counts. Empty when they agree.
 */
export function factsDifferences(f: PackFacts, v: Verdict): string[] {
  const out: string[] = [];
  const same = (name: string, written: unknown, own: unknown): void => {
    const text = (x: unknown): string => (typeof x === 'object' && x !== null ? JSON.stringify(x) : String(x));
    if (text(written) !== text(own)) out.push(`${name}: verdict ${text(written)}, recomputed ${text(own)}`);
  };
  same('events.cued', v.events.cued, f.cued);
  same('events.valid', v.events.valid, f.hits.valid);
  same('events.armed', v.events.armed, f.hits.armed);
  same('events.audible_inbreath', v.events.audible_inbreath, f.points.filter((p) => p.breath).length);
  same('rows.hits.hits', v.rows.hits.hits, f.hits.hits);
  same('rows.hits.armed_hits', v.rows.hits.armed_hits, f.hits.armedHits);
  same('rows.hits.leads_0_50', v.rows.hits.leads_0_50, f.hits.leads0to50);
  same('rows.lead.median_hits_ms', v.rows.lead.median_hits_ms, round1OrNull(median(f.hits.leadsMs)));
  same('rows.lead.median_all_stops_ms', v.rows.lead.median_all_stops_ms, round1OrNull(median(f.leadsAllMs)));
  same('rows.false_holds.per_min', v.rows.false_holds.per_min, round1OrNull(f.chestFalse.perMin));
  same('rows.false_holds.armed_min', v.rows.false_holds.armed_min, round1(f.chestFalse.activeMinutes));
  same('rows.chest_vs_lips.wins', v.rows.chest_vs_lips.wins, f.vsLips.wins);
  same('rows.chest_vs_lips.losses', v.rows.chest_vs_lips.losses, f.vsLips.losses);
  same('rows.chest_vs_lips.ties', v.rows.chest_vs_lips.ties, f.vsLips.ties);
  same('rows.chest_vs_lips.both_before_n', v.rows.chest_vs_lips.both_before_n, f.vsLips.bothBeforeN);
  same('rows.chest_vs_lips.lips_false_per_min', v.rows.chest_vs_lips.lips_false_per_min, round1OrNull(f.lipsFalse.perMin));
  const eq = v.rows.chest_vs_lips.exploratory_equal_rate;
  same('rows.chest_vs_lips.exploratory_equal_rate', eq === null ? null : { wins: eq.wins, losses: eq.losses }, ownEqualRate(f));
  same('misses.no_inbreath', v.misses.no_inbreath, f.misses.noInbreath);
  same('misses.inbreath_audible', v.misses.inbreath_audible, f.misses.inbreathAudible);
  same('tuning.theta_G', v.tuning.theta_G, f.thetaG);
  return out;
}

/** Refuses when the facts of a pack are not the counts of its verdict (factsDifferences). */
export function requireFactsMatch(what: string, f: PackFacts, v: Verdict): void {
  const diff = factsDifferences(f, v);
  if (diff.length > 0) throw new ConfirmRefusal(`${what}: the counts added up here differ from the counts of its verdict:\n  ${diff.join('\n  ')}`);
}

/** The facts of one pack (section 11), from stage B's runs. */
export function packFacts(r: PackRuns): PackFacts {
  const { lrt, d1 } = r;
  const armedAt = armedRule(d1, lrt);
  const valid = validReplies(r.replies);
  const points = pointsOf(valid, (e) => e.auto.n_v, armedAt);
  const hits = hitsRow(points, d1.stops, lrt);
  const leadsAllMs: number[] = [];
  for (const p of points) {
    const t = windowStopN(d1.stops, p.nV, lrt);
    if (t !== null) leadsAllMs.push(nToMs(p.nV - t));
  }
  // False holds against every objection start of the recording, as stage B counts them (section 3.2).
  const objections = r.onsets.filter(isObjection);
  const starts = objections.map((e) => e.auto.n_v).sort((a, b) => a - b);
  const chestFalse = falseRate(stopsIn(d1, r.scored), starts, lrt, activeMinutesIn(d1, r.scored));
  const lipsFalse = falseRate(stopsIn(r.g, r.scored), starts, lrt, activeMinutesIn(r.g, r.scored));
  const lipsGrid: LipsAtTheta[] = [...THETA_G_GRID]
    .sort((a, b) => a - b)
    .map((thetaG) => {
      const g = r.gAt(thetaG);
      return { thetaG, lipsFalse: falseRate(stopsIn(g, r.scored), starts, lrt, activeMinutesIn(g, r.scored)), vsLips: pairTally(points, d1.stops, g.stops, lrt) };
    });
  const a250 = a250StopsOf(valid);
  const circle = buildShiftSession(
    packCircleInput({
      spans: d1.spans,
      block: r.scored,
      stopsN: stopsIn(d1, r.scored).map((s) => stopOnMicN(s.nSilent, lrt.worstMs)),
      objections: objections.map((e) => ({ nV: e.auto.n_v, nEnd: e.n_end ?? e.auto.n_a })),
      onsetsN: points.map((p) => p.nV),
    }),
  );

  // Section 5: the same stops against other onsets, or against other valid objections.
  const line = (pts: ObjectionPoint[]): SensitivityFacts => ({ valid: pts.length, hits: hitsRow(pts, d1.stops, lrt) });
  const revalidated = (events: readonly OnsetEvent[]): ObjectionPoint[] =>
    pointsOf(validReplies(scoreCues(r.cues, events, r.scored.n1, r.ctx)), (e) => e.auto.n_v, armedAt);
  const earlier = msToN(EARLIER_MS);
  const sensitivity: Record<SensitivityKey, SensitivityFacts> = {
    manual: line(pointsOf(valid, manualNv, armedAt)),
    earlier_25ms: line(pointsOf(valid, (e) => e.auto.n_v - earlier, armedAt)),
    t_a: line(pointsOf(valid, (e) => e.auto.n_a, armedAt)),
    objection_400ms: line(revalidated(withObjectionThreshold(r.onsets, OBJECTION_400_MS))),
    non_speech_included: line(revalidated(withNonSpeechIncluded(r.onsets))),
  };

  return {
    id: r.id,
    pack: r.pack,
    cued: r.cues.length,
    points,
    hits,
    misses: missesOf(points, d1.stops, lrt),
    leadsAllMs,
    chestFalse,
    lipsFalse,
    vsLips: pairTally(points, d1.stops, r.g.stops, lrt),
    vsA250: pairTally(points, d1.stops, a250, lrt),
    a250Stops: a250.length,
    thetaG: r.thetaG,
    lipsGrid,
    circle,
    sensitivity,
  };
}
