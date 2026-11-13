// The gate verdict from one recording (spec 9.6, 9.7), pure: D1, G, T and M each run the whole
// recording with their own stop model; the valid objections of the scored block give the five rows.

import { d1ParamsFromFrozen, type DetectorInput, type FrozenParamsLike, type Sign } from '../../core/detector.ts';
import { combineGateVerdict, GATE_MIN_VALID, THETA_G_GRID, validateVerdict, type Calib, type GateOutcome, type OnsetEvent, type Verdict, type VerdictRow } from '../../core/schemas/index.ts';
import { isWindowArmed, type ChestFireMs, type IntervalMs } from '../../core/stats/index.ts';
import { AUDIO_RULE_DELAYS_MS, audioRuleLeadMs, audioRuleStops, headMotionThreshold, lipBaselines, type SpanSamples } from '../rivals/index.ts';
import { W_MS, nToMs, round1, round1OrNull, stopOnMicN, type LrtUse } from './common.ts';
import { gSettingsOf, variantOf } from './frozen.ts';
import { codeTimeline, isObjection, scoreCues, traceTimeline, type CueReply } from './objections.ts';
import {
  chestVsLipsOutcome,
  falseHoldsOutcome,
  falseRate,
  hitsOf,
  hitsRow,
  leadRow,
  missesOf,
  pairTally,
  type ObjectionPoint,
  type PairTally,
} from './rows.ts';
import { activeMinutesIn, runD1, runG, runM, runT, stopsIn, type DetectorRun, type RunSetup, type RunStop } from './runs.ts';
import type { SniffRecount } from '../clocks/compute.ts';
import { sniffRow, tracePacketsOf, type SniffRow } from './sniffs.ts';
import { detectorInBefore } from './view.ts';

export interface GateScoreInput {
  id: string;
  pack: 'A' | 'B' | 'C';
  /** Stage B run number: 1 is confirmatory, later runs are exploratory (spec 8.5). */
  run: number;
  paramsSha256: string;
  /** Parsed params/frozen.json with k and theta_G. */
  frozen: Readonly<Record<string, unknown>>;
  sign: Sign;
  lrt: LrtUse;
  inputs: readonly DetectorInput[];
  nArrBySeq: ReadonlyMap<number, number>;
  /** Packets that reset the baseline of G (rivals gResetSeqs). */
  resetSeqs: ReadonlySet<number>;
  nCut: number;
  listening: SpanSamples;
  scored: SpanSamples;
  /** Cue starts inside the scored block. */
  cues: readonly number[];
  onsets: readonly OnsetEvent[];
  calib: Calib | null;
  /** P90 of |auto - manual| from clock_report.json, as the label step wrote it (spec 6.3, 9.7). */
  onsetP90Ms: number | null;
  /** tuned.k.criterion_met of the params (spec 9.6: k 3.5 "criterion not met"). */
  criterionMet: boolean;
  /**
   * The sniff lag recomputed as the clocks step computes it (analysis/clocks/compute.ts
   * recountSniffLag): row 4 checks calib.json against it, and D1 on sniffs runs on its onsets.
   */
  sniffRecount: SniffRecount | null;
  /** Leave out T and M (spec 14.4: OTHER may move to a later exploratory run). */
  skipOther?: boolean;
}

export interface GateScore {
  verdict: Verdict;
  replies: CueReply[];
  runs: { d1: DetectorRun; g: DetectorRun; t: DetectorRun | null; m: DetectorRun | null };
  sniff: SniffRow;
  /** Descriptive lines for the console: audio rules, live-stop note. */
  notes: string[];
}

function spansMs(spans: readonly SpanSamples[]): IntervalMs[] {
  return spans.map((s) => ({ startMs: nToMs(s.n0), endMs: nToMs(s.n1) }));
}

function firesMs(stops: readonly RunStop[], lrtWorstMs: number): ChestFireMs[] {
  return stops.map((s) => ({ fireMs: nToMs(s.nFire), stopMs: nToMs(stopOnMicN(s.nSilent, lrtWorstMs)) }));
}

function f1(x: number | null): string {
  return x === null ? 'n/a' : x.toFixed(1);
}

/**
 * The exploratory equal-rate line (spec 7.5, 9.7): the smallest theta_G of the grid at which G's
 * false rate in the scored block, rounded as printed, is at most the chest's; null when none is.
 */
export function equalRateTheta(
  gRun: (thetaG: number) => DetectorRun,
  scored: SpanSamples,
  starts: readonly number[],
  lrt: LrtUse,
  chestPerMin: number | null,
): { thetaG: number | null; perMin: number | null; lastThetaG: number } {
  const grid = [...THETA_G_GRID].sort((a, b) => a - b);
  let perMin: number | null = null;
  if (chestPerMin === null) return { thetaG: null, perMin, lastThetaG: grid[grid.length - 1]! };
  for (const theta of grid) {
    const run = gRun(theta);
    perMin = falseRate(stopsIn(run, scored), starts, lrt, activeMinutesIn(run, scored)).perMin;
    if (perMin !== null && round1(perMin) <= round1(chestPerMin)) return { thetaG: theta, perMin, lastThetaG: theta };
  }
  return { thetaG: null, perMin, lastThetaG: grid[grid.length - 1]! };
}

const f2 = (x: number): string => x.toFixed(2);

/** Console notes on row 4 (PREREG §4, spec 9.6): where its numbers come from when that is not plain. */
export function sniffNotes(sniff: SniffRow, recount: SniffRecount | null): string[] {
  const out: string[] = [];
  if (sniff.source === 'none') {
    const why = recount ? 'and the listening block gives no A_ref to recompute it' : 'and none was recomputed';
    out.push(`row 4: calib.json has no sniff lag, ${why}: BETWEEN (spec 9.6 "the rest")`);
    return out;
  }
  if (sniff.source === 'recomputed') out.push(`row 4: calib.json has no sniff lag; recomputed as the clocks step computes it, on ${sniff.n} sniffs found`);
  if (sniff.mismatch !== null) out.push(`row 4: ${sniff.mismatch}`);
  // Whose numbers these are: calib.json's whenever it has a sniff block, even one without a reading.
  const found = sniff.source === 'calib.json' ? 'calib.json counts no sniff found' : 'no sniff was found';
  if (sniff.n === 0) out.push(`row 4: ${found} in channel 0: BETWEEN (spec 9.6 "the rest")`);
  else if (sniff.overMs === null && sniff.hiMedianMs === null) out.push('row 4: no hi median without L_rt: BETWEEN (spec 9.6 "the rest")');
  if (sniff.outcome === 'KILL' && sniff.loMedianMs === null && sniff.overMs !== null) {
    // The count is calib.json's (the recount's only when calib.json has no sniff block), as verdict.json holds it.
    out.push(
      `row 4: ${sniff.noArrival} of the ${sniff.n} sniffs found never reached the trace within 2 s; ranked above every measured lag, they hold the medians, which are over ${sniff.overMs} ms: KILL (PREREG §4)`,
    );
  }
  if (sniff.gradedUnrounded && sniff.gradedOn !== null) {
    out.push(
      `row 4: graded on the measured medians lo ${f2(sniff.gradedOn.loMs)} ms and hi ${f2(sniff.gradedOn.hiMs)} ms (thresholds 150 and 350 ms, spec 9.6), which verdict.json holds to 0.1 ms: ${sniff.outcome}`,
    );
  }
  return out;
}

interface RowOutcomes {
  hits: GateOutcome;
  lead: GateOutcome;
  false_holds: GateOutcome;
  chest_vs_lips: GateOutcome;
}

function rowOutcomes(points: readonly ObjectionPoint[], starts: readonly number[], d1: DetectorRun, g: DetectorRun, scored: SpanSamples, lrt: LrtUse): RowOutcomes {
  const hits = hitsRow(points, d1.stops, lrt);
  const lead = leadRow(points, d1.stops, lrt, hits);
  const fr = falseRate(stopsIn(d1, scored), starts, lrt, activeMinutesIn(d1, scored));
  return {
    hits: hits.outcome,
    lead: lead.outcome,
    false_holds: falseHoldsOutcome(fr.perMin),
    chest_vs_lips: chestVsLipsOutcome(pairTally(points, d1.stops, g.stops, lrt)),
  };
}

/** Scores one recording; throws when the verdict object would not be valid (a bug, not a refusal). */
export function scoreGate(i: GateScoreInput): GateScore {
  const frozen = i.frozen as FrozenParamsLike;
  const setup: RunSetup = { frozen, sign: i.sign, variant: variantOf(i.frozen) };
  const invalidCodes = d1ParamsFromFrozen(frozen).invalid_codes;
  const gs = gSettingsOf(i.frozen);
  const k = frozen.d1['k'] as number;
  if (typeof k !== 'number' || gs.thetaG === null) throw new Error('scoreGate: params without k or theta_G');
  const thetaG = gs.thetaG;
  const lrt = i.lrt;

  // Runs over the whole recording, each with its own stop model (spec 7.5).
  const d1 = runD1(i.inputs, i.nArrBySeq, setup);
  const points = lipBaselines(i.inputs, i.nArrBySeq, { baselineS: gs.baselineS, resetWaitS: gs.resetWaitS, resetSeqs: i.resetSeqs });
  const gRun = (theta: number): DetectorRun => runG(i.inputs, i.nArrBySeq, setup, { thetaG: theta, frames: gs.frames, points, invalidCodes });
  const g = gRun(thetaG);
  const t = i.skipOther ? null : runT(i.inputs, i.nArrBySeq, setup, invalidCodes);
  const mTh = i.skipOther ? null : headMotionThreshold(i.inputs, i.nArrBySeq, i.listening.n0, i.listening.n1);
  const m = mTh === null ? null : runM(i.inputs, i.nArrBySeq, setup, mTh.threshold, invalidCodes);

  // D1 as it stood at the end of the listening block: theta and A for "D1 on sniffs".
  const before = new Map([...i.nArrBySeq].filter(([, n]) => n < i.nCut));
  const listenState = runD1(detectorInBefore(i.inputs, before, i.nCut), before, setup).last;

  // Cues, replies and valid objections (spec 9.6).
  const replies = scoreCues(i.cues, i.onsets, i.scored.n1, { trace: traceTimeline(i.inputs, i.nArrBySeq), codes: codeTimeline(i.inputs, i.nArrBySeq, invalidCodes) });
  const valid = replies.filter((r) => r.valid && r.reply !== null);
  const activeMs = spansMs(d1.spans);
  const fires = firesMs(d1.stops, lrt.worstMs);
  const armedAt = (nV: number): boolean => isWindowArmed(nToMs(nV), activeMs, fires, W_MS);
  const pointsAuto: ObjectionPoint[] = valid.map((r) => ({ cue: r.cue, nV: r.reply!.auto.n_v, armed: armedAt(r.reply!.auto.n_v), breath: r.reply!.auto.breath !== null }));
  const manualNv = (e: OnsetEvent): number => e.manual?.n_v ?? e.auto.n_v;
  const pointsManual: ObjectionPoint[] = valid.map((r) => ({ cue: r.cue, nV: manualNv(r.reply!), armed: armedAt(manualNv(r.reply!)), breath: r.reply!.auto.breath !== null }));
  const objections = i.onsets.filter(isObjection);
  const startsAuto = objections.map((e) => e.auto.n_v).sort((a, b) => a - b);
  const startsManual = objections.map(manualNv).sort((a, b) => a - b);

  // Rows on the automatic onsets (spec 9.6: they are the confirmatory ones).
  const hits = hitsRow(pointsAuto, d1.stops, lrt);
  const lead = leadRow(pointsAuto, d1.stops, lrt, hits);
  const d1Scored = falseRate(stopsIn(d1, i.scored), startsAuto, lrt, activeMinutesIn(d1, i.scored));
  const gScored = falseRate(stopsIn(g, i.scored), startsAuto, lrt, activeMinutesIn(g, i.scored));
  const d1Listen = falseRate(stopsIn(d1, i.listening), startsAuto, lrt, activeMinutesIn(d1, i.listening));
  const gListen = falseRate(stopsIn(g, i.listening), startsAuto, lrt, activeMinutesIn(g, i.listening));
  const tally = pairTally(pointsAuto, d1.stops, g.stops, lrt);
  const notes: string[] = [];
  const d1p = d1ParamsFromFrozen(frozen);
  const theta = listenState?.stats.theta ?? null;
  const ruleA = listenState?.A ?? listenState?.lastA ?? null;
  const sniff = sniffRow({
    calib: i.calib,
    recount: i.sniffRecount,
    packets: tracePacketsOf(i.inputs, i.nArrBySeq),
    rule:
      theta !== null && ruleA !== null
        ? { theta, A: ruleA, L: d1p.L, M: d1p.M, gridHz: d1p.grid_hz, minRiseA: d1p.min_rise_A, minRiseMs: d1p.min_rise_ms, sign: i.sign }
        : null,
  });
  notes.push(...sniffNotes(sniff, i.sniffRecount));

  // Exploratory line: lips with the theta_G that gives them the chest's false rate (spec 7.5, 9.7).
  const equal = equalRateTheta(gRun, i.scored, startsAuto, lrt, d1Scored.perMin);
  const equalRate: PairTally | null = equal.thetaG === null ? null : pairTally(pointsAuto, d1.stops, gRun(equal.thetaG).stops, lrt);
  if (d1Scored.perMin !== null) {
    const chest = round1(d1Scored.perMin).toFixed(1);
    notes.push(
      equal.thetaG !== null && equalRate !== null
        ? `exploratory line: lips at theta_G=${equal.thetaG.toFixed(4)} fire ${f1(equal.perMin)}/min against the chest's ${chest}/min; chest wins ${equalRate.wins}:${equalRate.losses}`
        : `exploratory line: no theta_G of the grid brings the lips down to the chest's ${chest}/min (${f1(equal.perMin)}/min at ${equal.lastThetaG.toFixed(4)}): wins n/a`,
    );
  }

  const outcomes: Record<VerdictRow, GateOutcome | null> = {
    hits: hits.outcome,
    lead: lead.outcome,
    false_holds: falseHoldsOutcome(d1Scored.perMin),
    sniff_lag: sniff.outcome,
    chest_vs_lips: chestVsLipsOutcome(tally),
  };
  // Spec 9.6: a row whose outcome changes on the manual onsets reads BETWEEN.
  const manual = rowOutcomes(pointsManual, startsManual, d1, g, i.scored, lrt);
  const manualChanges: VerdictRow[] = [];
  for (const row of ['hits', 'lead', 'false_holds', 'chest_vs_lips'] as const) {
    if (manual[row] !== outcomes[row]) {
      manualChanges.push(row);
      outcomes[row] = 'BETWEEN';
    }
  }
  const evaluable = valid.length >= GATE_MIN_VALID;
  const rowsOut = (row: VerdictRow): GateOutcome | null => (evaluable ? outcomes[row] : null);
  const verdictWord = combineGateVerdict(['hits', 'lead', 'false_holds', 'sniff_lag', 'chest_vs_lips'].map((r) => rowsOut(r as VerdictRow)), valid.length);

  const misses = missesOf(pointsAuto, d1.stops, lrt);
  // OTHER needs both T and M; the schema has no "n/a" for one of them (spec 9.7).
  const talkHits = t === null ? null : hitsOf(pointsAuto, t.stops, lrt);
  if (t !== null && m === null) {
    notes.push(`OTHER not computed: no head-motion threshold (the listening block has no hm values); talking flag ${talkHits} hits (descriptive)`);
  }
  const verdict: Verdict = {
    schema: 'verdict/1',
    id: i.id,
    pack: i.pack,
    run: i.run,
    exploratory: i.run > 1,
    params_sha256: i.paramsSha256,
    clock: {
      L_rt_ms: [round1OrNull(lrt.A), round1OrNull(lrt.B)],
      diff_ms: lrt.diffMs,
      rule: lrt.rule,
      onset_p90_ms: round1OrNull(i.onsetP90Ms),
    },
    tuning: { k, criterion_met: i.criterionMet, theta_G: thetaG },
    events: {
      cued: i.cues.length,
      valid: valid.length,
      armed: pointsAuto.filter((p) => p.armed).length,
      audible_inbreath: pointsAuto.filter((p) => p.breath).length,
    },
    rows: {
      hits: { outcome: rowsOut('hits'), hits: hits.hits, armed_hits: hits.armedHits, leads_0_50: hits.leads0to50 },
      lead: { outcome: rowsOut('lead'), median_hits_ms: round1OrNull(lead.medianHitsMs), median_all_stops_ms: round1OrNull(lead.medianAllStopsMs) },
      false_holds: {
        outcome: rowsOut('false_holds'),
        per_min: round1OrNull(d1Scored.perMin),
        armed_min: round1(d1Scored.activeMinutes),
        in_sample_chest_per_min: round1OrNull(d1Listen.perMin),
        in_sample_lips_per_min: round1OrNull(gListen.perMin),
      },
      // n, no_arrival, the medians and their bound as calib.json holds them (PREREG §4).
      sniff_lag: {
        outcome: rowsOut('sniff_lag'),
        lo_median_ms: sniff.loMedianMs,
        hi_median_ms: sniff.hiMedianMs,
        median_over_ms: sniff.overMs,
        n: sniff.n,
        no_arrival: sniff.noArrival,
        best_case_ms: sniff.bestCaseMs,
        d1_on_sniffs_ms: sniff.d1OnSniffsMs,
      },
      chest_vs_lips: {
        outcome: rowsOut('chest_vs_lips'),
        wins: tally.wins,
        losses: tally.losses,
        ties: tally.ties,
        both_before_n: tally.bothBeforeN,
        lead_diff_ms_median: round1OrNull(tally.leadDiffMedianMs),
        chest_false_per_min: round1OrNull(d1Scored.perMin),
        lips_false_per_min: round1OrNull(gScored.perMin),
        exploratory_equal_rate: equalRate === null ? null : { wins: equalRate.wins, losses: equalRate.losses },
      },
    },
    misses: { no_inbreath: misses.noInbreath, inbreath_audible: misses.inbreathAudible },
    other: talkHits === null || m === null ? null : { talking_flag_hits: talkHits, head_motion_hits: hitsOf(pointsAuto, m.stops, lrt) },
    manual_changes: evaluable ? manualChanges : [],
    verdict: verdictWord,
  };
  const problems = validateVerdict(verdict);
  if (problems.length > 0) throw new Error(`scoreGate built an invalid verdict.json:\n  ${problems.join('\n  ')}`);

  // Audio rules (spec 4.4, 7.5): console only, not in the 9.7 layout. A250 is paired as in H4,
  // with both false rates beside it; A100 and A500 are descriptive (share, median, false per min).
  const onsetsForRules = valid.map((r) => ({ nV: r.reply!.auto.n_v, nEnd: r.reply!.n_end ?? null }));
  const chestRate = f1(round1OrNull(d1Scored.perMin));
  for (const delay of AUDIO_RULE_DELAYS_MS) {
    const stops = audioRuleStops(onsetsForRules, delay).map((s) => ({ seq: -1, nFire: s.nFire, nSilent: s.nSilent }));
    const lead = audioRuleLeadMs(delay, lrt.worstMs).toFixed(1);
    if (delay === 250) {
      const vs = pairTally(pointsAuto, d1.stops, stops, lrt);
      notes.push(`A250: chest wins ${vs.wins}:${vs.losses}, ties ${vs.ties}; false stops/min: chest ${chestRate}, A250 0.0 by construction (descriptive on the gate)`);
    } else {
      notes.push(`A${delay}: stops before voice on ${hitsOf(pointsAuto, stops, lrt)} of ${valid.length} valid; lead ${lead} ms on each of its ${stops.length} stops; 0.0 false stops/min by construction (descriptive)`);
    }
  }
  if (!evaluable) notes.push(`only ${valid.length} valid objections (needs ${GATE_MIN_VALID}): NOT EVALUABLE, record the next unused pack (spec 9.6)`);
  return { verdict, replies, runs: { d1, g, t, m }, sniff, notes };
}
