import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { DetectorInput, FrozenParamsLike } from '../../core/detector.ts';
import { sniffLag, type TracePacket } from '../../core/clock/index.ts';
import { exampleClockReport, exampleOnsets, exampleQuickcheck, exampleVerdict } from '../../core/schemas/examples.ts';
import { toJsonText, validateFrozenParams, validateVerdict, type Calib, type LedgerLine, type LedgerStep, type OnsetEvent, type Verdict } from '../../core/schemas/index.ts';
import { ORDER_NOTE } from '../label.ts';
import { onsetsLabelsSha256 } from '../label/marks.ts';
import { sha256Hex } from '../lib/ledger.ts';
import { GateRefusal, RATE, isBeforeVoice, leadMs, lrtUseFrom, msToN, stopOnMicN } from './common.ts';
import {
  PREREG_TAG,
  checkPrereg,
  checkRetune,
  criterionMetOf,
  frozenParamsText,
  frozenWithTuning,
  jsonDiffPaths,
  sameJson,
  withoutStageAKeys,
} from './frozen.ts';
import {
  LABEL_ORDER_NOTE,
  labelOrderNote,
  labelsHashOfNote,
  nextRecordingAdvice,
  problemsBeforeRow,
  problemsOfFile,
  recordedHash,
  recordingVoidReasons,
  requireCountedRecording,
  requireLabelsHash,
} from './inputs.ts';
import { codeTimeline, invalidCodeDuring, repliesOfCues, scoreCues, traceGapFree, traceTimeline } from './objections.ts';
import {
  beforeVoiceStop,
  chestVsLipsOutcome,
  falseHoldsOutcome,
  falseRate,
  hitsRow,
  isFalseStop,
  leadOutcome,
  pairTally,
  windowStopN,
  type ObjectionPoint,
} from './rows.ts';
import { runD1, runG, type DetectorRun, type RunStop } from './runs.ts';
import { equalRateTheta, sniffNotes } from './score.ts';
import { calibSniffBlockOf, ruleDelaysMs, sniffRow, type RuleOnly } from './sniffs.ts';
import { buildGateSynth, preregParamsText, type ReplyPlan } from './synth.ts';
import { gBudget } from './tune.ts';
import { sniffLagMore, sniffLagText, verdictMarkdown } from './verdict-text.ts';
import { detectorInBefore, maxSeqOf, samplesBefore } from './view.ts';
import { lipBaselines } from '../rivals/index.ts';
import { calibSniffLagBlock, type SniffRecount } from '../clocks/compute.ts';

const MEAN = lrtUseFrom({ A: 23.4, B: 23.6, rule: 'mean', used: 23.5 });
const stop = (nFire: number): RunStop => ({ seq: 1, nFire, nSilent: nFire + 384 });
const at = (ms: number): number => msToN(ms);
/** params/frozen.json as frozen under gate-prereg, without k and theta_G (spec 8.4). */
const prereg = (): Record<string, unknown> => JSON.parse(preregParamsText()) as Record<string, unknown>;

describe('L_rt rule (spec 6.3)', () => {
  it('uses the mean, both values, or refuses a void clock', () => {
    expect(MEAN).toMatchObject({ rule: 'mean', values: [23.5], worstMs: 23.5, diffMs: 0.2 });
    const both = lrtUseFrom({ A: 20, B: 30, rule: 'both', used: null });
    expect(both).toMatchObject({ values: [20, 30], worstMs: 30, diffMs: 10 });
    expect(() => lrtUseFrom({ A: 10, B: 40, rule: 'void', used: null })).toThrow(GateRefusal);
    expect(() => lrtUseFrom(undefined)).toThrow(/clocks/);
  });

  it('counts a stop before voice only when it holds for both values', () => {
    const both = lrtUseFrom({ A: 20, B: 30, rule: 'both', used: null });
    const nV = at(10_000);
    // t_s = nSilent + L: with L = 20 ms before voice, with 30 ms 5 ms after it.
    const nSilent = nV - at(25);
    expect(isBeforeVoice(nSilent, nV, { values: [20] })).toBe(true);
    expect(isBeforeVoice(nSilent, nV, both)).toBe(false);
    expect(leadMs(nV - at(330), nV, both)).toBeCloseTo(300, 9);
  });
});

describe('rows of spec 9.6', () => {
  const nV = at(60_000);
  const point = (n = nV, armed = true): ObjectionPoint => ({ cue: 1, nV: n, armed, breath: false });

  it('row 1 counts valid objections with a stop in [t_v - W, t_v)', () => {
    const d1 = [stop(nV - at(1600)), stop(nV + at(400))];
    expect(beforeVoiceStop(d1, nV, MEAN)).toBeNull(); // 1.6 s early: outside W; the other is late
    const hit = stop(nV - at(331.5)); // lead = 331.5 - 8 - 23.5 = 300 ms
    const row = hitsRow([point(), point(nV + at(20_000), false)], [hit, stop(nV + at(20_000) - at(40))], MEAN);
    expect(row).toMatchObject({ hits: 2, armedHits: 1, valid: 2, armed: 1, leads0to50: 1 });
    expect(row.leadsMs[0]).toBeCloseTo(300, 9);
  });

  it('row 2 and row 3 thresholds on printed values', () => {
    expect(leadOutcome(199.96)).toBe('PASS');
    expect(leadOutcome(199.9)).toBe('BETWEEN');
    expect(leadOutcome(100)).toBe('BETWEEN');
    expect(leadOutcome(99.94)).toBe('KILL');
    expect(leadOutcome(null)).toBe('KILL');
    expect(falseHoldsOutcome(2.04)).toBe('PASS');
    expect(falseHoldsOutcome(2.1)).toBe('BETWEEN');
    expect(falseHoldsOutcome(5)).toBe('BETWEEN');
    expect(falseHoldsOutcome(5.06)).toBe('KILL');
    expect(falseHoldsOutcome(null)).toBe('KILL');
  });

  it('a stop is false unless an objection starts within W after it; a late stop is not false', () => {
    const starts = [nV];
    expect(isFalseStop(stop(nV - at(800)), starts, MEAN)).toBe(false); // before voice
    expect(isFalseStop(stop(nV + at(300)), starts, MEAN)).toBe(false); // late: t_v <= t_s <= t_v + 0.5 s
    expect(isFalseStop(stop(nV - at(1700)), starts, MEAN)).toBe(true);
    expect(isFalseStop(stop(nV + at(700)), starts, MEAN)).toBe(true);
    const r = falseRate([stop(nV - at(800)), stop(nV + at(5000))], starts, MEAN, 2);
    expect(r).toEqual({ stops: 2, falseStops: 1, activeMinutes: 2, perMin: 0.5 });
    expect(falseRate([], starts, MEAN, 0).perMin).toBeNull();
  });

  it('row 5: wins need 33 ms, no stop loses, lips winning as often is KILL (checked first)', () => {
    const pts = [point()];
    const d1 = [stop(nV - at(400))];
    expect(pairTally(pts, d1, [stop(nV - at(380))], MEAN)).toMatchObject({ wins: 0, losses: 0, ties: 1 });
    expect(pairTally(pts, d1, [stop(nV - at(360))], MEAN)).toMatchObject({ wins: 1, losses: 0, ties: 0, bothBeforeN: 1 });
    expect(pairTally(pts, d1, [], MEAN)).toMatchObject({ wins: 1, losses: 0 });
    expect(pairTally(pts, [], [stop(nV + at(200))], MEAN)).toMatchObject({ wins: 0, losses: 1 });
    expect(pairTally(pts, [], [], MEAN)).toMatchObject({ ties: 1 });
    const t = (wins: number, losses: number, bothBeforeN = 0, leadDiffMedianMs: number | null = null) => ({ wins, losses, ties: 0, bothBeforeN, leadDiffMedianMs });
    expect(chestVsLipsOutcome(t(0, 0))).toBe('KILL');
    expect(chestVsLipsOutcome(t(4, 4))).toBe('KILL');
    expect(chestVsLipsOutcome(t(7, 4))).toBe('PASS');
    expect(chestVsLipsOutcome(t(6, 4))).toBe('BETWEEN');
    expect(chestVsLipsOutcome(t(6, 4, 5, 100))).toBe('PASS');
    expect(chestVsLipsOutcome(t(6, 4, 4, 150))).toBe('BETWEEN');
  });

  it('a rival stopping 50 ms after D1 gets a narrow loss, not "no stop" (spec 7.5 test)', () => {
    const d1 = [stop(nV - at(300))];
    const rival = [stop(nV - at(250))];
    expect(windowStopN(rival, nV, MEAN)).not.toBeNull();
    expect(pairTally([point()], rival, d1, MEAN)).toMatchObject({ wins: 0, losses: 1, ties: 0, bothBeforeN: 1 });
    expect(pairTally([point()], rival, d1, MEAN).leadDiffMedianMs).toBeCloseTo(-50, 9);
    expect(stopOnMicN(rival[0]!.nSilent, 23.5) - stopOnMicN(d1[0]!.nSilent, 23.5)).toBe(at(50));
  });

  it('the G budget is the larger of the D1 count and its whole active minutes (spec 7.5)', () => {
    expect(gBudget(0, 2.9)).toBe(2);
    expect(gBudget(3, 2.9)).toBe(3);
  });
});

describe('a lips detector firing about 50 ms after D1 on a synthetic recording (spec 7.5)', () => {
  it('ties or loses narrowly on every such objection, with its stop inside the window', () => {
    const replies: ReplyPlan[] = Array.from({ length: 14 }, () => ({ kind: 'inhale', lipLeadS: -5 }));
    const first = buildGateSynth({ replies, seed: 5 });
    const frozen = frozenWithTuning(prereg(), { k: 1.5, criterionMet: true, thetaG: 0.01, step: 'stage_a' }) as unknown as FrozenParamsLike;
    const setup = { frozen, sign: 1 as const, variant: 'D1' as const };
    const d1 = runD1(first.inputs, first.nArrBySeq, setup);
    const batches = first.inputs.filter((r) => r.k === 'batch').map((r) => ({ seq: r.seq, nArr: first.nArrBySeq.get(r.seq)! }));
    // G fires on its second open frame: per objection, the packet arriving nearest 50 ms after
    // D1's fire is that frame, and the lips open one packet before it.
    const plans: { seq0: number; seq1: number; nFire: number; nQ: number; truth: (typeof first.truth)[number] }[] = [];
    for (const t of first.truth) {
      const s = d1.stops.find((x) => x.nFire > t.nV! - at(1000) && x.nFire < t.nV!);
      if (!s) continue;
      const i = batches.findIndex((b) => b.seq === s.seq);
      expect(batches[i]!.nArr).toBe(s.nFire);
      let q = i + 1;
      for (let j = i + 1; j < batches.length && batches[j]!.nArr < s.nFire + at(150); j++) {
        if (Math.abs(batches[j]!.nArr - s.nFire - at(50)) < Math.abs(batches[q]!.nArr - s.nFire - at(50))) q = j;
      }
      const end = batches.find((b) => b.nArr >= t.nV! + at(2000))!;
      plans.push({ seq0: batches[q - 1]!.seq, seq1: end.seq, nFire: s.nFire, nQ: batches[q]!.nArr, truth: t });
    }
    expect(plans.length).toBeGreaterThanOrEqual(12);
    // Same recording; only the lips change.
    const second = buildGateSynth({
      replies,
      seed: 5,
      gOverride: (seq) => (plans.some((p) => seq >= p.seq0 && seq < p.seq1) ? 0.095 : 0.035),
    });
    const d1b = runD1(second.inputs, second.nArrBySeq, setup);
    expect(d1b.stops).toEqual(d1.stops);
    const g = runG(second.inputs, second.nArrBySeq, setup, { thetaG: 0.01, frames: 2, points: lipBaselines(second.inputs, second.nArrBySeq) });
    const lates: number[] = [];
    for (const p of plans) {
      const nV = p.truth.nV!;
      const pt: ObjectionPoint = { cue: p.truth.cue, nV, armed: true, breath: true };
      const gStop = windowStopN(g.stops, nV, MEAN);
      expect(gStop).not.toBeNull(); // a stop inside the window, not "no stop"
      expect(beforeVoiceStop(g.stops, nV, MEAN)).not.toBeNull();
      const lateByMs = (gStop! - windowStopN(d1.stops, nV, MEAN)!) / 48;
      expect(lateByMs).toBeCloseTo((p.nQ - p.nFire) / 48, 9);
      expect(lateByMs).toBeGreaterThan(0);
      expect(lateByMs).toBeLessThan(110);
      lates.push(lateByMs);
      const tally = pairTally([pt], g.stops, d1.stops, MEAN);
      expect(tally.wins).toBe(0);
      expect(tally.losses + tally.ties).toBe(1);
      expect(tally.bothBeforeN).toBe(1);
      if (lateByMs >= 33) expect(tally.losses).toBe(1);
    }
    const meanLate = lates.reduce((a, b) => a + b, 0) / lates.length;
    expect(meanLate).toBeGreaterThan(35);
    expect(meanLate).toBeLessThan(65);
  });
});

describe('cues and valid objections (spec 4.5, 9.6)', () => {
  const ev = (id: string, nV: number, extra: Partial<OnsetEvent> = {}): OnsetEvent => ({
    id,
    kind: 'objection',
    label: 'speech',
    voiced_ms: 900,
    floor_db: -60,
    n_end: nV + at(2000),
    auto: { n_v: nV, n_a: nV + 2400, breath: null, flags: [] },
    manual: null,
    ...extra,
  });

  it('takes the first reply after each cue; one still going at the cue counts and is invalid', () => {
    const cues = [at(10_000), at(30_000), at(50_000)];
    const events = [ev('a', at(9_000), { n_end: at(10_500) }), ev('b', at(12_000)), ev('c', at(33_000)), ev('d', at(36_000))];
    const r = repliesOfCues(cues, events, at(70_000));
    expect(r.map((x) => x.reply?.id ?? null)).toEqual(['a', 'c', null]);
  });

  it('checks the voice window, the kind, the label and the trace', () => {
    const inputs: DetectorInput[] = [];
    const nArrBySeq = new Map<number, number>();
    // 30 Hz trace from 0 to 60 s with a 300 ms hole at 40 s; packets arrive 80 ms after their sample.
    let seq = 0;
    for (let t = 0; t < 60_000; t += 1000 / 30) {
      if (t > 40_000 && t < 40_300) continue;
      seq++;
      inputs.push({ k: 'batch', seq, tr: [[1_000_000_000 + Math.round(t * 1000), 0]] });
      nArrBySeq.set(seq, Math.round(at(t + 80)));
    }
    inputs.push({ k: 'val', seq: 99_999, code: 2 });
    nArrBySeq.set(99_999, at(50_000));
    inputs.push({ k: 'val', seq: 99_998, code: 0 });
    nArrBySeq.set(99_998, at(50_500));
    inputs.sort((a, b) => nArrBySeq.get((a as { seq: number }).seq)! - nArrBySeq.get((b as { seq: number }).seq)!);
    const trace = traceTimeline(inputs, nArrBySeq);
    const codes = codeTimeline(inputs, nArrBySeq);
    expect(traceGapFree(trace, at(20_000), at(22_000))).toBe(true);
    expect(traceGapFree(trace, at(39_000), at(41_000))).toBe(false);
    expect(invalidCodeDuring(codes, at(49_000), at(51_000))).toBe(true);
    expect(invalidCodeDuring(codes, at(51_000), at(53_000))).toBe(false);

    const cues = [at(5_000), at(12_000), at(25_000), at(35_000), at(45_000), at(52_000)];
    const events = [
      ev('ok', at(7_000)),
      ev('late', at(12_000 + 10_500)),
      ev('cough', at(27_000), { label: 'cough' }),
      ev('gap', at(40_900)),
      ev('code', at(50_900), { n_end: at(51_800) }), // over before cue 6
      ev('cont', at(53_000), { kind: 'continuation' }),
    ];
    const r = scoreCues(cues, events, at(60_000), { trace, codes });
    expect(r.map((x) => [x.cue, x.valid, x.why])).toEqual([
      [1, true, null],
      [2, false, 'the voice began more than 10 s after the cue'],
      [3, false, 'the first reply is non-speech (cough)'],
      [4, false, 'a gap over 100 ms in the trace 2 s before t_v'],
      [5, false, 'an invalid validation code 2 s before t_v'],
      [6, false, 'the first reply is a continuation'],
    ]);
  });
});

describe('stage A cut (spec 9.5 step 4)', () => {
  it('keeps the lines before the first one known to lie at or after the cut', () => {
    const map = new Map([[1, 100], [2, 200], [4, 400]]);
    const lines: DetectorInput[] = [
      { k: 'state', n: 50, s: 'narrating' },
      { k: 'batch', seq: 1, tr: [] },
      { k: 'batch', seq: 3, tr: [] }, // no stamp, seq below a stamped one: kept
      { k: 'batch', seq: 2, tr: [] },
      { k: 'batch', seq: 4, tr: [] },
      { k: 'voice', n: 450, on: true },
      { k: 'batch', seq: 5, tr: [] }, // after the cut
      { k: 'voice', n: 300, on: false },
    ];
    expect(detectorInBefore(lines, map, 500)).toHaveLength(6);
    expect(detectorInBefore(lines, map, 420)).toHaveLength(5);
    // Without the stamp of seq 4, seq 3 is the newest packet and has no stamp before the cut.
    expect(detectorInBefore(lines, new Map([[1, 100], [2, 200]]), 500)).toHaveLength(2);
  });
});

describe('params/frozen.json (spec 8.4, 9.8)', () => {
  it('fills k, theta_G and tuned into the gate-prereg params and stays valid', () => {
    const base = prereg();
    expect(validateFrozenParams(base)).toEqual([]);
    expect((base['d1'] as Record<string, unknown>)['k']).toBeUndefined();
    const f = frozenWithTuning(base, { k: 3.5, criterionMet: false, thetaG: 0.0275, step: 'stage_a' });
    const text = frozenParamsText(f);
    expect(text.startsWith('{"schema":"params/1",\n "d1":{"grid_hz":30,"L":5,"M":2,"k":3.5,')).toBe(true);
    expect(validateFrozenParams(JSON.parse(text))).toEqual([]);
    expect(() => frozenWithTuning(base, { k: 2, criterionMet: false, thetaG: 0.0275, step: 'stage_a' })).toThrow(/3\.5/);
    expect(() => frozenWithTuning(base, { k: 2, criterionMet: true, thetaG: 0.011, step: 'stage_a' })).toThrow(/theta_G/);
  });

  it('after a retune only compares frozen.json with the tagged retune.json', () => {
    const text = frozenParamsText(frozenWithTuning(prereg(), { k: 2, criterionMet: true, thetaG: 0.02, step: 'retune' }));
    expect(sameJson(checkRetune({ frozenText: text, retuneText: text, taggedText: text, tag: 'gate-retune' }), JSON.parse(text))).toBe(true);
    const other = text.replace('"k":2', '"k":2.5');
    expect(() => checkRetune({ frozenText: other, retuneText: text, taggedText: text, tag: 'gate-retune' })).toThrow(/differs from params\/retune\.json/);
    expect(() => checkRetune({ frozenText: text, retuneText: text, taggedText: null, tag: 'gate-retune' })).toThrow(/not under the git tag/);
    expect(() => checkRetune({ frozenText: text, retuneText: text, taggedText: other, tag: 'gate-retune' })).toThrow(/differs from its copy/);
  });
});

describe('verdict.md (spec 9.7)', () => {
  it('prints n/a for missing values and marks an exploratory run', () => {
    const v: Verdict = {
      schema: 'verdict/1',
      id: 'gate-b',
      pack: 'B',
      run: 2,
      exploratory: true,
      params_sha256: 'c'.repeat(64),
      clock: { L_rt_ms: [20, 30], diff_ms: 10, rule: 'both', onset_p90_ms: null },
      tuning: { k: 3.5, criterion_met: false, theta_G: 0.06 },
      events: { cued: 14, valid: 12, armed: 9, audible_inbreath: 5 },
      rows: {
        hits: { outcome: 'BETWEEN', hits: 6, armed_hits: 5, leads_0_50: 1 },
        lead: { outcome: 'BETWEEN', median_hits_ms: 150.2, median_all_stops_ms: 90 },
        false_holds: { outcome: 'KILL', per_min: 5.5, armed_min: 3.2, in_sample_chest_per_min: 1, in_sample_lips_per_min: null },
        sniff_lag: { outcome: 'BETWEEN', lo_median_ms: null, hi_median_ms: null, median_over_ms: null, n: 0, no_arrival: 0, best_case_ms: null, d1_on_sniffs_ms: null },
        chest_vs_lips: {
          outcome: 'BETWEEN',
          wins: 5,
          losses: 3,
          ties: 4,
          both_before_n: 2,
          lead_diff_ms_median: 40,
          chest_false_per_min: 5.5,
          lips_false_per_min: 0.3,
          exploratory_equal_rate: null,
        },
      },
      misses: { no_inbreath: 4, inbreath_audible: 2 },
      other: null,
      manual_changes: ['lead'],
      verdict: 'KILL',
    };
    const md = verdictMarkdown(v, 2).split('\n');
    expect(md[0]).toBe('GATE VERDICT gate-b pack B | stage B run 2 of 2 | params cccccccc | EXPLORATORY');
    expect(md[1]).toBe('CLOCK   L_rt A 20.0 / B 30.0 ms, diff 10.0 ms | onset P90 |auto-manual| n/a ms');
    expect(md[2]).toBe('TUNING  k=3.5 (criterion not met) | theta_G=0.0600 | listening block only');
    expect(md[8]).toBe(`3 FALSE HOLDS  ${'5.5/min on 3.2 armed min, scored block'.padEnd(38)} KILL`);
    expect(md[10]).toBe(`4 SNIFF LAG    ${'median [n/a, n/a] ms, n=0'.padEnd(38)} BETWEEN`);
    expect(md[15]).toBe('               exploratory, lips at the chest rate: wins n/a');
    expect(md[17]).toBe('OTHER   not computed (descriptive)');
    expect(md[18]).toBe('MANUAL  lines that change with manual onsets: 2 LEAD');
    expect(md[19]).toBe('VERDICT KILL (EXPLORATORY: not the verdict of the gate)');
  });
});

describe('params/frozen.json under the gate-prereg tag (spec 8.4, 9.1)', () => {
  const tuned = (k = 2, criterionMet = true): Record<string, unknown> =>
    frozenWithTuning(prereg(), { k, criterionMet, thetaG: 0.02, step: 'stage_a' }) as unknown as Record<string, unknown>;

  it('lets only k, theta_G and "tuned" differ from the tagged copy', () => {
    const tagged = preregParamsText();
    expect(() => checkPrereg({ frozen: prereg(), taggedText: tagged, tag: PREREG_TAG })).not.toThrow();
    expect(() => checkPrereg({ frozen: tuned(), taggedText: tagged, tag: PREREG_TAG })).not.toThrow(); // stage A run again
    const moved = prereg();
    (moved['d1'] as Record<string, unknown>)['L'] = 7;
    expect(() => checkPrereg({ frozen: moved, taggedText: tagged, tag: PREREG_TAG })).toThrow(/differs from its copy under the tag gate-prereg at d1\.L: only k, theta_G/);
  });

  it('refuses without the tagged copy and points to the freeze', () => {
    expect(() => checkPrereg({ frozen: prereg(), taggedText: null, tag: PREREG_TAG })).toThrow(/not under the git tag gate-prereg.*npm run freeze -- gate-prereg/);
    expect(() => checkPrereg({ frozen: prereg(), taggedText: '{', tag: PREREG_TAG })).toThrow(/not valid JSON/);
    expect(() => checkPrereg({ frozen: prereg(), taggedText: '[]', tag: PREREG_TAG })).toThrow(/not a JSON object/);
  });

  it('withoutStageAKeys drops what stage A writes and leaves its input alone', () => {
    const t: Record<string, unknown> = { ...tuned(), k: 2, theta_G: 0.02 };
    expect(sameJson(withoutStageAKeys(t), withoutStageAKeys(prereg()))).toBe(true);
    expect((t['d1'] as Record<string, unknown>)['k']).toBe(2);
    expect(t['tuned']).toBeDefined();
  });

  it('jsonDiffPaths names the differing paths, at most `max` of them', () => {
    expect(jsonDiffPaths({ a: 1, b: { c: 2 } }, { a: 1, b: { c: 3 }, d: [1] })).toEqual(['b.c', 'd']);
    expect(jsonDiffPaths({ a: 1, b: 2, c: 3 }, { a: 2, b: 3, c: 4 }, 2)).toEqual(['a', 'b']);
    expect(jsonDiffPaths([1], [2])).toEqual(['(the whole file)']);
    expect(jsonDiffPaths({ a: { b: [1, 2] } }, { a: { b: [1, 2] } })).toEqual([]);
  });

  it('criterion_met comes from tuned.k; params without it were never tuned', () => {
    expect(criterionMetOf(tuned(3.5, false), 'params/frozen.json')).toBe(false);
    expect(criterionMetOf(tuned(), 'params/frozen.json')).toBe(true);
    expect(() => criterionMetOf(prereg(), 'params/frozen.json')).toThrow(/params\/frozen\.json has no tuned\.k\.criterion_met: run stage A first/);
  });
});

describe('inputs of analyze:gate (spec 8.1, 8.5, 9.4)', () => {
  const problems = [
    'stamps.jsonl line 5: not valid JSON (Unexpected token)',
    'stamps.jsonl line 9: empty line',
    'detector_in.jsonl line 2: k: expected one of batch, val, voice, state',
    'calib.json: A_ref: expected a number > 0',
    'samples.jsonl: ... 3 more problems',
  ];

  it('a broken line counts for stage A only when it may lie before the last row stage A reads', () => {
    expect(problemsOfFile(problems, 'stamps.jsonl')).toHaveLength(2);
    expect(problemsOfFile(problems, 'samples.jsonl')).toEqual(['samples.jsonl: ... 3 more problems']);
    // Rows 0-3 are lines 1-4, before the first broken line 5; row 4 is line 6.
    expect(problemsBeforeRow(problems, 'stamps.jsonl', 3)).toEqual([]);
    expect(problemsBeforeRow(problems, 'stamps.jsonl', 4)).toHaveLength(2);
    expect(problemsBeforeRow(problems, 'stamps.jsonl', -1)).toHaveLength(2); // no row past the cut: every line is read
    expect(problemsBeforeRow(problems, 'detector_in.jsonl', 0)).toEqual([]);
    expect(problemsBeforeRow(problems, 'detector_in.jsonl', 1)).toHaveLength(1);
    expect(problemsBeforeRow(problems, 'calib.json', 100)).toHaveLength(1); // a problem of the whole file always counts
    expect(problemsBeforeRow(problems, 'ledger.jsonl', -1)).toEqual([]);
  });

  it('samples.jsonl lines up to the newest packet that arrived before the cut', () => {
    const map = new Map([[1, 100], [2, 200], [4, 400]]);
    expect(maxSeqOf(map)).toBe(4);
    expect(maxSeqOf(new Map())).toBe(Number.NEGATIVE_INFINITY);
    const samples = [{ k: 'm', seq: 1 }, { k: 'a', n: 5 }, { k: 'm', seq: 4 }, { k: 'm', seq: 5 }];
    expect(samplesBefore(samples, map)).toEqual([{ k: 'm', seq: 1 }, { k: 'm', seq: 4 }]);
  });

  it('the hash of a file is the one the last step line that wrote it holds', () => {
    const utc = '2026-11-14T10:00:00Z';
    const prev = '0'.repeat(64);
    const line = (i: number, step: LedgerStep, out: Record<string, string>): LedgerLine => ({ i, step, utc, commit: null, out_sha256: out, exploratory: false, prev });
    const records: LedgerLine[] = [
      line(0, 'clocks', { 'calib.json': 'a'.repeat(64), 'clock_report.json': 'b'.repeat(64) }),
      line(1, 'onsets', { 'onsets.json': 'c'.repeat(64) }),
      line(2, 'label', { 'onsets.json': 'd'.repeat(64), 'clock_report.json': 'e'.repeat(64) }),
      { i: 3, step: 'note', utc, commit: null, what: 'narrowed_claim', prev },
    ];
    expect(recordedHash(records, 'onsets.json')).toEqual({ step: 'label', sha256: 'd'.repeat(64) });
    expect(recordedHash(records, 'clock_report.json')).toEqual({ step: 'label', sha256: 'e'.repeat(64) });
    expect(recordedHash(records, 'calib.json')).toEqual({ step: 'clocks', sha256: 'a'.repeat(64) });
    expect(recordedHash(records, 'verdict.json')).toBeNull();
  });
});

describe('a recording that counts, and the labels it is scored with (spec 8.5, 9.4, 9.5)', () => {
  const utc = '2026-11-14T10:00:00Z';
  const prev = '0'.repeat(64);
  const step = (i: number, s: LedgerStep, out: Record<string, string> = {}): LedgerLine => ({ i, step: s, utc, commit: null, out_sha256: out, exploratory: false, prev });
  const note = (i: number, what: string, detail?: string): LedgerLine => ({ i, step: 'note', utc, commit: null, what, ...(detail === undefined ? {} : { detail }), prev });
  const report = exampleClockReport();
  const good = exampleQuickcheck();

  it('names why a recording does not count, in the words of quickcheck and the clock check', () => {
    expect(recordingVoidReasons(good, report)).toEqual([]);
    expect(recordingVoidReasons({ result: 'RE-RECORD NOW', reasons: ['3 SDK error event(s)', '3 sniffs found'] }, report)).toEqual([
      'quickcheck.json says RE-RECORD NOW: 3 SDK error event(s); 3 sniffs found',
    ]);
    expect(recordingVoidReasons(good, { ...report, audio_valid: false, hard: { ...report.hard, sample_rate: 44_100 } })).toEqual([
      'clock_report.json says the audio is not valid: sample rate 44100 Hz, not 48000',
    ]);
    // Invalid audio that no field explains: a lost page (core/clock hardFailures).
    expect(recordingVoidReasons(good, { ...report, audio_valid: false })).toEqual([expect.stringMatching(/^clock_report\.json says the audio is not valid: .+events\.jsonl/)]);
    expect(recordingVoidReasons(good, { ...report, trace_valid: false, hard: { ...report.hard, tap_lost: 2 } })).toEqual(['clock_report.json says the trace is not valid: tap lost 2 time(s)']);
    expect(recordingVoidReasons(good, { ...report, trace_valid: null })).toEqual([expect.stringMatching(/the trace is not valid: it has no trace verdict/)]);
    // Both at once: the audio reason is not repeated under the trace.
    const both = { ...report, audio_valid: false, trace_valid: false, hard: { ...report.hard, mic_flags_off: false, sdk_errors: 1 } };
    expect(recordingVoidReasons(good, both)).toEqual([
      'clock_report.json says the audio is not valid: microphone processing not off',
      'clock_report.json says the trace is not valid: 1 SDK error event(s)',
    ]);
  });

  it('refuses such a recording unless the run is exploratory, which gets the reasons back', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gate-counted-'));
    try {
      const q = { ...good, result: 'RE-RECORD NOW' as const, reasons: ['microphone processing not off'], technical: true, checks: good.checks.map((c) => (c.name === 'mic_flags_off' ? { ...c, ok: false } : c)) };
      const write = (file: string, text: string): string => {
        fs.writeFileSync(path.join(dir, file), text);
        return sha256Hex(text);
      };
      const records = [step(0, 'quickcheck', { 'quickcheck.json': write('quickcheck.json', toJsonText(q, null)) }), step(1, 'label', { 'clock_report.json': write('clock_report.json', toJsonText(report, 'clock_report.json')) })];
      const at = { dir, pack: 'A' as const, objectionsReached: true };
      expect(() => requireCountedRecording(records, at, false)).toThrow(GateRefusal);
      expect(() => requireCountedRecording(records, at, false)).toThrow(
        /does not score it[^\n]*\n  quickcheck\.json says RE-RECORD NOW: microphone processing not off\nThe failure is technical\. Remove the cause, repeat pack 0 until it says GOOD RECORDING, then record the next unused pack \(B, then C\)/,
      );
      expect(requireCountedRecording(records, at, true)).toEqual(['quickcheck.json says RE-RECORD NOW: microphone processing not off']);
      // The files must still be the ones the steps wrote, exploratory or not.
      fs.writeFileSync(path.join(dir, 'quickcheck.json'), toJsonText(good, null));
      expect(() => requireCountedRecording(records, at, true)).toThrow(/quickcheck\.json changed after step quickcheck wrote it/);
      const fixed = [step(0, 'quickcheck', { 'quickcheck.json': write('quickcheck.json', toJsonText(good, null)) }), records[1]!];
      expect(requireCountedRecording(fixed, at, false)).toEqual([]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  // Spec 9.4, PREREG §7.4: after RE-RECORD NOW, the same pack only if the recording broke off
  // before 4:15; a technical failure does not spend the one content re-record.
  it('says which pack to record next, and whether the content re-record is spent', () => {
    const advice = (technical: boolean, pack: 'A' | 'B' | 'C', objectionsReached: boolean, detectorComputed = false): string =>
      nextRecordingAdvice({ technical, pack, objectionsReached, detectorComputed });
    expect(advice(true, 'A', false)).toBe(
      'The failure is technical. Remove the cause, repeat pack 0 until it says GOOD RECORDING, then record pack A again: the recording broke off before the objection block (4:15), so its errors were not heard (spec 9.4). A technical failure with no detector computed does not spend the one re-record for content (spec 9.4).',
    );
    expect(advice(true, 'A', true)).toMatch(/then record the next unused pack \(B, then C\): the objection block \(from 4:15\) was heard, so pack A cannot be recorded again \(spec 9\.4\)\. A technical failure with no detector computed does not spend/);
    expect(advice(true, 'B', true)).toMatch(/record the next unused pack \(C\)/);
    expect(advice(true, 'C', false)).toMatch(/then record pack C again: the recording broke off before/);
    expect(advice(true, 'C', true)).toBe(
      'The failure is technical, but the objection block (from 4:15) was heard, so pack C cannot be recorded again: no unused pack is left, so the gate does not take place this weekend (spec 9.4, 14.3).',
    );
    expect(advice(true, 'A', true, true)).toMatch(/Stage A already computed detectors on this recording, so it spends the one re-record for content \(spec 9\.4\)\.$/);
    expect(advice(false, 'A', true)).toBe(
      'quickcheck marks the failure as not technical (fewer than 12 replies, spec 9.4): record the next unused pack (B, then C), which is the one re-record for content (spec 9.6).',
    );
    expect(advice(false, 'C', true)).toMatch(/not technical .*: no unused pack is left/);
  });

  it('gives the content re-record advice only when condition 6 alone failed and the clock check passed', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gate-content-'));
    try {
      const content = { ...good, result: 'RE-RECORD NOW' as const, reasons: ['voice after 11 cues, fewer than 12'], technical: false, checks: good.checks.map((c) => (c.name === 'voice_after_cues' ? { ...c, ok: false, value: 11 } : c)) };
      const write = (file: string, text: string): string => {
        fs.writeFileSync(path.join(dir, file), text);
        return sha256Hex(text);
      };
      const at = { dir, pack: 'A' as const, objectionsReached: true };
      const refusal = (r: typeof report): string => {
        const records = [
          step(0, 'quickcheck', { 'quickcheck.json': write('quickcheck.json', toJsonText(content, null)) }),
          step(1, 'label', { 'clock_report.json': write('clock_report.json', toJsonText(r, 'clock_report.json')) }),
        ];
        try {
          requireCountedRecording(records, at, false);
        } catch (e) {
          return (e as Error).message;
        }
        return 'not refused';
      };
      expect(refusal(report)).toMatch(/\nquickcheck marks the failure as not technical .*which is the one re-record for content/);
      // The clock check finds a technical fault too: the recording did not take place.
      const audio = refusal({ ...report, audio_valid: false, hard: { ...report.hard, mic_flags_off: false } });
      expect(audio).toMatch(/\n  clock_report\.json says the audio is not valid: microphone processing not off\nThe failure is technical\./);
      expect(audio).not.toMatch(/not technical/);
      expect(refusal({ ...report, trace_valid: false, hard: { ...report.hard, sdk_errors: 1 } })).toMatch(/\nThe failure is technical\..*does not spend the one re-record/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('reads labels_sha256 from the label_order note of the label step', () => {
    expect(LABEL_ORDER_NOTE).toBe(ORDER_NOTE);
    const h = 'c'.repeat(64);
    expect(labelsHashOfNote({ detail: `seed 7; order o02 o01; labels_sha256 ${h}` })).toBe(h);
    expect(labelsHashOfNote({ detail: `labels_sha256 ${h}; seed 7` })).toBe(h);
    expect(labelsHashOfNote({ detail: 'seed 7; order o01' })).toBeNull();
    expect(labelsHashOfNote({ detail: `seed 7; labels_sha256 ${h}0` })).toBeNull(); // 65 hex digits
    expect(labelsHashOfNote({})).toBeNull();

    const records = [step(0, 'onsets'), note(1, LABEL_ORDER_NOTE, `labels_sha256 ${'a'.repeat(64)}`), note(2, LABEL_ORDER_NOTE, `labels_sha256 ${h}`), note(3, 'no_event_marks'), step(4, 'label'), note(5, LABEL_ORDER_NOTE, 'later')];
    expect(labelOrderNote(records)?.i).toBe(2); // the last one before the label step
    expect(labelOrderNote(records.slice(0, 4))).toBeNull(); // no label step yet
    expect(labelOrderNote([step(0, 'onsets'), step(1, 'label')])).toBeNull();
  });

  it('refuses labels other than the ones whose hash the label step put in the ledger', () => {
    const base = exampleOnsets();
    const own = onsetsLabelsSha256(base, sha256Hex)!;
    const onsets = { ...base, labels_sha256: own };
    const withNote = (detail: string): LedgerLine[] => [step(0, 'onsets'), note(1, LABEL_ORDER_NOTE, detail), step(2, 'label')];
    const ok = withNote(`seed 7; order o08 o07; labels_sha256 ${own}`);
    expect(() => requireLabelsHash(onsets, ok)).not.toThrow();
    expect(() => requireLabelsHash({ ...onsets, labels_sha256: null }, ok)).toThrow(/onsets\.json has no labels_sha256/);
    expect(() => requireLabelsHash(base, ok)).toThrow(/its blind labels and hand marks give labels_sha256 [0-9a-f]{8}, not the 00000000 it holds/);
    const unmarked = { ...onsets, events: onsets.events.map((e, i) => (i === 0 ? { ...e, manual: null } : e)) };
    expect(() => requireLabelsHash(unmarked, ok)).toThrow(/give labels_sha256 none/);
    expect(() => requireLabelsHash(onsets, [step(0, 'onsets'), step(1, 'label')])).toThrow(/no label_order note before the label step/);
    expect(() => requireLabelsHash(onsets, withNote('seed 7; order o08 o07'))).toThrow(/note on ledger\.jsonl line 2 holds no labels_sha256/);
    expect(() => requireLabelsHash(onsets, withNote(`seed 7; labels_sha256 ${'f'.repeat(64)}`))).toThrow(
      new RegExp(`labels_sha256 ${own.slice(0, 8)} differs from the label_order note on ledger\\.jsonl line 2 \\(ffffffff\\)`),
    );
  });
});

describe('row 4 and D1 on sniffs (spec 6.3, 9.6, 9.7)', () => {
  const FRAME_N = 1_600; // 30 Hz on the sample clock
  const LATENCY_N = 2_400; // each frame arrives 50 ms after it was taken
  const N0 = 10 * RATE; // the sample of frame 0
  const I0 = 90; // the rise starts on frame 90, 3 s in
  const nSniff = N0 + I0 * FRAME_N;
  // One packet per frame: the trace is flat, then rises by `perS` per second from frame I0.
  const packets = (perS: number, sign: 1 | -1 = 1): TracePacket[] =>
    Array.from({ length: 240 }, (_, i) => ({
      nArr: N0 + i * FRAME_N + LATENCY_N,
      tr: [[Math.ceil(1e9 + (i * 1e6) / 30) + 1, (sign * Math.max(0, i - I0) * perS) / 30] as const],
    }));
  const rule: RuleOnly = { theta: 1.5, A: 1, L: 5, M: 2, gridHz: 30, minRiseA: 0.15, minRiseMs: 200, sign: 1 };
  /** calib.json with a sniff block as the clocks step writes it (no_arrival 0 unless given; the bound when censored). */
  const calibLag = (lo: number | null, hi: number | null, n = 5, noArrival = 0, overMs: number | null = null): Calib =>
    ({ sniff_lag_ms: { n, no_arrival: noArrival, lo_median: lo, hi_median: hi, median_over_ms: overMs } }) as unknown as Calib;

  it('D1 on sniffs: on a rise of 4 A/s the rule holds on its third frame, 150 ms after the onset', () => {
    // Slope over 5 points: 0.8, 2.0, 3.2 A/s on frames I0 + 1..3; M = 2 points over theta 1.5.
    expect(ruleDelaysMs([nSniff], packets(4), rule)[0]).toBeCloseTo(150, 6);
    expect(ruleDelaysMs([nSniff], packets(4, -1), { ...rule, sign: -1 })[0]).toBeCloseTo(150, 6);
    expect(ruleDelaysMs([nSniff], packets(4), { ...rule, M: 3 })[0]).toBeCloseTo(150 + 1000 / 30, 6);
  });

  it('D1 on sniffs is null when the rule never holds within 2 s', () => {
    expect(ruleDelaysMs([nSniff], packets(1), rule)).toEqual([null]); // slope 1 A/s < theta
    expect(ruleDelaysMs([nSniff], packets(4), { ...rule, minRiseA: 1 })).toEqual([null]); // 0.8 A in 200 ms < 1 A
    expect(ruleDelaysMs([nSniff], packets(4), { ...rule, A: 0 })).toEqual([null]);
    expect(ruleDelaysMs([N0 + 10_000 * FRAME_N], packets(4), rule)).toEqual([null]); // no packet after the onset
  });

  // The recount as analyze:gate makes it (clocks' code); aRef null: the listening block gave none.
  const recountOf = (onsets: readonly number[], p: readonly TracePacket[], aRef: number | null, lrtMs = 23.5): SniffRecount => ({
    onsets: [...onsets],
    aRef,
    lag: aRef === null ? null : sniffLag({ onsets, packets: p, aRef, lrtMs, sign: 1 }),
  });
  const row = (calib: Calib | null, aRef: number | null) => sniffRow({ calib, recount: recountOf([nSniff], packets(4), aRef), packets: packets(4), rule });

  it('reads n, the count and lo and hi from calib.json when the clocks step wrote them; a recount that differs is named', () => {
    // The recount found one sniff, calib.json five: graded on calib.json as written, its count kept.
    expect(row(calibLag(120, 143.5, 5, 1), 1)).toMatchObject({ outcome: 'PASS', loMedianMs: 120, hiMedianMs: 143.5, n: 5, noArrival: 1, source: 'calib.json', recount: 'differs', d1OnSniffsMs: 150 });
    expect(row(calibLag(140, 163.5), 1)).toMatchObject({ outcome: 'BETWEEN', source: 'calib.json', recount: 'differs' });
    expect(row(calibLag(360, 383.5), 1)).toMatchObject({ outcome: 'KILL', source: 'calib.json', recount: 'differs' });
    expect(row(calibLag(120, 143.5, 5, 1), 1).mismatch).toBe(
      'the recount of the sniff lag gives n=1, 0 without arrival, median [116.7, 140.2] ms, but calib.json holds n=5, 1 without arrival, median [120.0, 143.5] ms: row 4 is graded on calib.json as the clocks step wrote it, to 0.1 ms (PREREG §4)',
    );
    // No recount (no A_ref in the listening block): nothing to check, nothing named.
    expect(row(calibLag(120, 143.5, 5, 2), null)).toMatchObject({ outcome: 'PASS', noArrival: 2, recount: 'none', mismatch: null, bestCaseMs: null });
  });

  it('leaves out a calib.json block without the count (validateCalib refuses it) and recomputes', () => {
    const old = { sniff_lag_ms: { n: 5, lo_median: 120, hi_median: 143.5 } } as unknown as Calib;
    expect(calibSniffBlockOf(old)).toBeNull();
    expect(row(old, 1)).toMatchObject({ source: 'recomputed', n: 1, noArrival: 0, loMedianMs: 116.7 });
    expect(calibSniffBlockOf(calibLag(120, 143.5, 5, 1))).toEqual({ n: 5, no_arrival: 1, lo_median: 120, hi_median: 143.5, median_over_ms: null });
  });

  it('takes the count and the unrounded medians of a recount that agrees with calib.json', () => {
    const lag = recountOf([nSniff], packets(4), 1).lag!;
    expect(calibSniffLagBlock(lag)).toEqual({ n: 1, no_arrival: 0, lo_median: 116.7, hi_median: 140.2, median_over_ms: null });
    const r = row(calibLag(116.7, 140.2, 1), 1);
    expect(r).toMatchObject({ outcome: 'PASS', loMedianMs: 116.7, hiMedianMs: 140.2, n: 1, noArrival: 0, source: 'calib.json', recount: 'agrees', mismatch: null, gradedUnrounded: false });
    expect(r.gradedOn!.loMs).toBeCloseTo(5600 / 48, 9);
  });

  // Spec 9.6 row 4 thresholds judge the measured medians; calib.json holds them to 0.1 ms.
  it('grades a hi median of 150.04 ms BETWEEN and a lo median of 350.02 ms KILL, although they print as 150.0 and 350.0', () => {
    const lrtMs = 150.04 - 5600 / 48; // lo is 2 frames + 50 ms = 5600 samples
    const hi = recountOf([nSniff], packets(4), 1, lrtMs);
    expect(hi.lag!.hiMedianMs!).toBeGreaterThan(150.03);
    expect(hi.lag!.calib.hi_median).toBe(150);
    const between = sniffRow({ calib: calibLag(116.7, 150, 1), recount: hi, packets: packets(4), rule });
    expect(between).toMatchObject({ outcome: 'BETWEEN', hiMedianMs: 150, recount: 'agrees', gradedUnrounded: true });
    expect(between.gradedOn!.hiMs).toBeCloseTo(150.04, 9);
    // From calib.json alone the printed 150.0 would pass.
    expect(sniffRow({ calib: calibLag(116.7, 150, 1), recount: null, packets: packets(4), rule })).toMatchObject({ outcome: 'PASS', recount: 'none' });

    // The first rise of 0.15 A arrives on frame I0 + 2: put the onset 16801 samples (350.02 ms) before it.
    const onset = N0 + (I0 + 2) * FRAME_N + LATENCY_N - 16_801;
    const lo = recountOf([onset], packets(4), 1);
    expect(lo.lag!.loMedianMs!).toBeCloseTo(16_801 / 48, 9);
    expect(lo.lag!.calib).toEqual({ n: 1, lo_median: 350, hi_median: 373.5 });
    const kill = sniffRow({ calib: calibLag(350, 373.5, 1), recount: lo, packets: packets(4), rule });
    expect(kill).toMatchObject({ outcome: 'KILL', loMedianMs: 350, recount: 'agrees', gradedUnrounded: true });
    // From calib.json alone (no recount) the printed values are all there is.
    expect(sniffRow({ calib: calibLag(350, 373.5, 1), recount: null, packets: packets(4), rule })).toMatchObject({ outcome: 'BETWEEN', recount: 'none', gradedUnrounded: false });
  });

  it('recomputes them from the sniffs when calib.json has none', () => {
    // The trace first rises 0.15 A_ref on frame I0 + 2: lo = 2 frames + 50 ms, hi = lo + L_rt.
    const r = row(null, 1);
    expect(r).toMatchObject({ outcome: 'PASS', loMedianMs: 116.7, hiMedianMs: 140.2, n: 1, noArrival: 0, source: 'recomputed', recount: 'none', mismatch: null, d1OnSniffsMs: 150 });
    // The best case extrapolates the rise back to its start: the 50 ms latency.
    expect(r.bestCaseMs).toBeCloseTo(50, 1);
    expect(row({ schema: 'calib/1', sniff_lag_ms: null } as Calib, 1)).toMatchObject({ source: 'recomputed', loMedianMs: 116.7 });
    expect(sniffNotes(r, null)).toEqual(['row 4: calib.json has no sniff lag; recomputed as the clocks step computes it, on 1 sniffs found']);
  });

  // PREREG §4, item 1 of the polish pass: one source. A block without a reading is still the
  // clocks step's measurement; a recount that could grade it only shows up as a mismatch.
  it('keeps a calib.json block without a reading against a recount that has one', () => {
    // The clocks step found no sniff, the recount one that passes: calib.json's zeros, BETWEEN.
    const none = row(calibLag(null, null, 0), 1);
    expect(none).toMatchObject({ outcome: 'BETWEEN', loMedianMs: null, hiMedianMs: null, overMs: null, n: 0, noArrival: 0, source: 'calib.json', recount: 'differs', gradedOn: null });
    expect(none.mismatch).toBe(
      'the recount of the sniff lag gives n=1, 0 without arrival, median [116.7, 140.2] ms, but calib.json holds n=0, 0 without arrival, median [null, null] ms: row 4 is graded on calib.json as the clocks step wrote it, to 0.1 ms (PREREG §4)',
    );
    expect(sniffNotes(none, null)).toEqual([`row 4: ${none.mismatch}`, 'row 4: calib.json counts no sniff found in channel 0: BETWEEN (spec 9.6 "the rest")']);
    // The same zeros in both: they agree, nothing to name.
    const zeros = sniffRow({ calib: calibLag(null, null, 0), recount: recountOf([], packets(4), 1), packets: packets(4), rule });
    expect(zeros).toMatchObject({ outcome: 'BETWEEN', n: 0, source: 'calib.json', recount: 'agrees', mismatch: null });
    expect(sniffNotes(zeros, null)).toEqual(['row 4: calib.json counts no sniff found in channel 0: BETWEEN (spec 9.6 "the rest")']);
  });

  it('reads BETWEEN without lo and hi (spec 9.6: the rest)', () => {
    expect(row(null, null)).toMatchObject({ outcome: 'BETWEEN', loMedianMs: null, hiMedianMs: null, overMs: null, n: 0, noArrival: 0, bestCaseMs: null, source: 'none', d1OnSniffsMs: 150 });
    expect(sniffRow({ calib: null, recount: null, packets: packets(4), rule })).toMatchObject({ source: 'none', d1OnSniffsMs: null });
    // No sniff found: the zeros come from calib.json (or the recount) as they are.
    expect(row(calibLag(null, null, 0), null)).toMatchObject({ outcome: 'BETWEEN', n: 0, noArrival: 0, source: 'calib.json' });
    expect(sniffRow({ calib: null, recount: recountOf([], packets(4), 1), packets: packets(4), rule })).toMatchObject({ outcome: 'BETWEEN', n: 0, source: 'recomputed' });
    // Without L_rt there is no hi median: n, the count and lo still go into verdict.json.
    expect(row(calibLag(116.7, null, 1), null)).toMatchObject({ outcome: 'BETWEEN', n: 1, noArrival: 0, loMedianMs: 116.7, hiMedianMs: null, source: 'calib.json' });
  });

  // PREREG §4: n counts all found sniffs; one whose trace never arrived ranks above every measured
  // value; no arrival at all reads KILL.
  describe('sniffs whose trace never arrived (PREREG §4)', () => {
    // Five sniffs 4 s apart; at the onset of those listed the trace rises 4 A/s for 1 s, then stays.
    const onsets = [0, 1, 2, 3, 4].map((i) => N0 + I0 * FRAME_N + i * 4 * RATE);
    const fivePackets = (rises: readonly number[]): TracePacket[] =>
      Array.from({ length: 30 * 24 }, (_, i) => {
        const nFrame = N0 + i * FRAME_N;
        const v = rises.reduce((acc, k) => acc + Math.max(0, Math.min(30, (nFrame - onsets[k]!) / FRAME_N)) * (4 / 30), 0);
        return { nArr: nFrame + LATENCY_N, tr: [[Math.ceil(1e9 + (i * 1e6) / 30) + 1, v] as const] };
      });
    const rowOf = (calib: Calib | null, rises: readonly number[]) => sniffRow({ calib, recount: recountOf(onsets, fivePackets(rises), 1), packets: fivePackets(rises), rule });
    /** calib.json as the clocks step writes it for these sniffs. */
    const clocksCalib = (rises: readonly number[]): Calib => ({ sniff_lag_ms: calibSniffLagBlock(recountOf(onsets, fivePackets(rises), 1).lag!) }) as unknown as Calib;

    it('all arrive: five sniffs, none without arrival', () => {
      expect(rowOf(null, [0, 1, 2, 3, 4])).toMatchObject({ outcome: 'PASS', n: 5, noArrival: 0, source: 'recomputed', loMedianMs: 116.7, hiMedianMs: 140.2, overMs: null });
      expect(rowOf(clocksCalib([0, 1, 2, 3, 4]), [0, 1, 2, 3, 4])).toMatchObject({ outcome: 'PASS', n: 5, noArrival: 0, source: 'calib.json', recount: 'agrees' });
    });

    it('some never arrive: n counts them, the count stands beside it, the medians stay measured', () => {
      expect(rowOf(null, [0, 2, 4])).toMatchObject({ outcome: 'PASS', n: 5, noArrival: 2, source: 'recomputed', loMedianMs: 116.7, overMs: null });
      expect(rowOf(clocksCalib([0, 2, 4]), [0, 2, 4])).toMatchObject({ outcome: 'PASS', n: 5, noArrival: 2, source: 'calib.json', recount: 'agrees', loMedianMs: 116.7 });
    });

    it('none arrive: KILL with medians over 2000 ms, recomputed or read from calib.json', () => {
      expect(rowOf(null, [])).toMatchObject({ outcome: 'KILL', n: 5, noArrival: 5, source: 'recomputed', loMedianMs: null, hiMedianMs: null, overMs: 2000 });
      // The clocks step writes n > 0 with null medians over a bound when they fall on sniffs that never arrived.
      expect(clocksCalib([]).sniff_lag_ms).toEqual({ n: 5, no_arrival: 5, lo_median: null, hi_median: null, median_over_ms: 2000 });
      expect(rowOf(clocksCalib([]), [])).toMatchObject({ outcome: 'KILL', n: 5, noArrival: 5, source: 'calib.json', recount: 'agrees', loMedianMs: null, overMs: 2000 });
    });

    it('the medians on sniffs without arrival read KILL although every measured lag passes', () => {
      expect(rowOf(null, [1, 3])).toMatchObject({ outcome: 'KILL', n: 5, noArrival: 3, loMedianMs: null, hiMedianMs: null, overMs: 2000 });
    });

    it('calib.json wins over a recount that differs: its n, its count and its bound go into verdict.json', () => {
      expect(rowOf(calibLag(120, 143.5, 5, 1), [0, 2, 4])).toMatchObject({ outcome: 'PASS', n: 5, noArrival: 1, source: 'calib.json', recount: 'differs' });
      expect(rowOf(calibLag(120, 143.5, 4, 1), [0, 2, 4])).toMatchObject({ outcome: 'PASS', n: 4, noArrival: 1, source: 'calib.json', recount: 'differs' });
      // An even n with exactly half without an arrival: only half of 2 s is known (core/clock censoredMedianOverMs).
      expect(rowOf(calibLag(null, null, 4, 2, 1000), [0, 1, 2, 3, 4])).toMatchObject({ outcome: 'KILL', n: 4, noArrival: 2, overMs: 1000, source: 'calib.json', recount: 'differs' });
      expect(rowOf(calibLag(null, null, 5, 3, 2000), [0, 1, 2, 3, 4])).toMatchObject({ outcome: 'KILL', n: 5, noArrival: 3, overMs: 2000, recount: 'differs' });
      // A recount over a bound against a measured calib.json: graded on calib.json as written.
      const measured = rowOf(calibLag(120, 143.5, 5, 0), []);
      expect(measured).toMatchObject({ outcome: 'PASS', n: 5, noArrival: 0, overMs: null, recount: 'differs' });
      expect(measured.mismatch).toMatch(/^the recount of the sniff lag gives n=5, 5 without arrival, medians over 2000 ms, but calib\.json holds n=5, 0 without arrival, median \[120\.0, 143\.5\] ms: /);
    });

    it('verdict.md prints the bound for medians on sniffs without arrival, and the count beside n, from verdict.json alone', () => {
      const r = { outcome: 'KILL' as const, lo_median_ms: null, hi_median_ms: null, median_over_ms: 2000, n: 5, no_arrival: 5, best_case_ms: null, d1_on_sniffs_ms: null };
      expect(sniffLagText(r)).toBe('median [> 2000, > 2000] ms, n=5, 5 without arrival');
      expect(sniffLagText({ ...r, n: 4, no_arrival: 2, median_over_ms: 1000 })).toBe('median [> 1000, > 1000] ms, n=4, 2 without arrival');
      const measured = { ...r, outcome: 'PASS' as const, lo_median_ms: 118.5, hi_median_ms: 142, median_over_ms: null, no_arrival: 0 };
      expect(sniffLagText(measured)).toBe('median [118.5, 142.0] ms, n=5, 0 without arrival');
      expect(sniffLagText({ ...measured, no_arrival: 2 })).toBe('median [118.5, 142.0] ms, n=5, 2 without arrival');
      expect(sniffLagText({ ...measured, lo_median_ms: null, hi_median_ms: null, n: 0 })).toBe('median [n/a, n/a] ms, n=0');
      expect(sniffLagMore({ ...measured, best_case_ms: 61.2, d1_on_sniffs_ms: 150 }, { gradedUnrounded: true })).toBe(
        'best case 61.2 ms; D1 on sniffs 150.0 ms; graded on the medians before rounding',
      );
      expect(sniffLagMore(measured)).toBe('best case n/a ms; D1 on sniffs n/a ms');
    });

    it('a calib.json block without a hi median (no L_rt) wins over a recount over a bound', () => {
      // calib.json: 2 of 5 without arrival, lo measured, no hi. The recount finds 3 of 5: KILL over 2000 ms.
      const recount = recountOf(onsets, fivePackets([1, 3]), 1);
      expect(recount.lag).toMatchObject({ n: 5, noArrival: 3, medianOverMs: 2000, reading: 'KILL' });
      const sniff = sniffRow({ calib: calibLag(148, null, 5, 2), recount, packets: fivePackets([1, 3]), rule });
      expect(sniff).toMatchObject({ outcome: 'BETWEEN', loMedianMs: 148, hiMedianMs: null, overMs: null, n: 5, noArrival: 2, source: 'calib.json', recount: 'differs', gradedUnrounded: false, gradedOn: null });
      expect(sniff.mismatch).toBe(
        'the recount of the sniff lag gives n=5, 3 without arrival, medians over 2000 ms, but calib.json holds n=5, 2 without arrival, median [148.0, null] ms: row 4 is graded on calib.json as the clocks step wrote it, to 0.1 ms (PREREG §4)',
      );
      expect(sniffNotes(sniff, recount)).toEqual([`row 4: ${sniff.mismatch}`, 'row 4: no hi median without L_rt: BETWEEN (spec 9.6 "the rest")']);
      // verdict.json takes calib.json's numbers, and validates.
      const v = exampleVerdict();
      v.rows.sniff_lag = { ...v.rows.sniff_lag, outcome: sniff.outcome, lo_median_ms: sniff.loMedianMs, hi_median_ms: sniff.hiMedianMs, median_over_ms: sniff.overMs, n: sniff.n, no_arrival: sniff.noArrival };
      v.verdict = 'BETWEEN';
      expect(validateVerdict(v)).toEqual([]);
      expect(sniffLagText(v.rows.sniff_lag)).toBe('median [148.0, n/a] ms, n=5, 2 without arrival');
    });

    it('the row, verdict.json and verdict.md carry the one count calib.json holds', () => {
      // calib.json says 1 of 5 never arrived; the recount on these files finds 2: the file wins.
      const sniff = rowOf(calibLag(116.7, 140.2, 5, 1), [0, 2, 4]);
      expect(sniff).toMatchObject({ n: 5, noArrival: 1, recount: 'differs' });
      expect(sniffNotes(sniff, null)).toEqual([`row 4: ${sniff.mismatch}`]);
      const killed = rowOf(calibLag(null, null, 5, 4, 2000), [0, 2]); // the recount finds 3 without arrival
      expect(killed).toMatchObject({ outcome: 'KILL', n: 5, noArrival: 4, recount: 'differs' });
      expect(sniffNotes(killed, null)).toContain(
        'row 4: 4 of the 5 sniffs found never reached the trace within 2 s; ranked above every measured lag, they hold the medians, which are over 2000 ms: KILL (PREREG §4)',
      );
    });
  });
});

describe('the exploratory equal-rate line (spec 7.5, 9.7)', () => {
  const scored = { n0: 0, n1: 2 * 60 * RATE };
  const runWith = (count: number): DetectorRun => ({
    name: 'G',
    stops: Array.from({ length: count }, (_, i) => stop(at(5_000 + 10_000 * i))),
    spans: [{ n0: 0, n1: 2 * 60 * RATE }],
    result: {} as DetectorRun['result'],
  });
  // 3/min below theta_G 0.02, 1/min below 0.03, none from 0.03 on; no objection, so every stop is false.
  const gRun = (thetaG: number): DetectorRun => runWith(thetaG < 0.02 ? 6 : thetaG < 0.03 ? 2 : 0);

  it('takes the smallest theta_G of the grid at which the lips fire no more often than the chest', () => {
    expect(equalRateTheta(gRun, scored, [], MEAN, 1)).toEqual({ thetaG: 0.02, perMin: 1, lastThetaG: 0.02 });
    expect(equalRateTheta(gRun, scored, [], MEAN, 0.96)).toEqual({ thetaG: 0.02, perMin: 1, lastThetaG: 0.02 }); // printed 1.0 both
    expect(equalRateTheta(gRun, scored, [], MEAN, 0.4)).toEqual({ thetaG: 0.03, perMin: 0, lastThetaG: 0.03 });
  });

  it('is null when no theta_G of the grid gets there, with the rate at the largest one', () => {
    expect(equalRateTheta(() => runWith(6), scored, [], MEAN, 1)).toEqual({ thetaG: null, perMin: 3, lastThetaG: 0.06 });
    expect(equalRateTheta(gRun, scored, [], MEAN, null)).toEqual({ thetaG: null, perMin: null, lastThetaG: 0.06 });
  });
});
