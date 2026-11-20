// Recomputes the numbers of one published gate set with stage B's own functions (spec 9.6, 9.7):
// analysis/gate/score.ts scoreGate on the detector inputs of stream.jsonl, the cues and the step
// marks laid out by analysis/gate/view.ts, onsets.json with its blind hand marks, L_rt of
// calib.json and the params of params.ts; where the params hold stage A's tuning, also that tuning
// (analysis/gate/tune.ts tuneStageA) on the listening block. Each value of verdict.json then reads
// MATCH, DIFFERS, "not recomputable from the set" with the unpublished file it would need, or "an
// input of the replay" for params_sha256 (replay finds the params by it) and for a tuning replay
// rebuilt the params with. A value that cannot be recomputed is never skipped and never counts as
// a difference.
// verdict.md is checked against the text stage B writes from verdict.json.
//
// What stage B reads that a set as pack writes it does not carry (spec 8.7 leaves the files out):
// - the cue and step marks: "mark" lines of stamps.jsonl (view.ts gateLayout, scoredCues); replay
//   reads them from set.ts MARKS_FILE when the set has it;
// - which packets with g null are reset frames of G: lm of the "m" lines of samples.jsonl (rivals
//   gResetSeqs); replay reads them from set.ts RESETS_FILE when the set has it, else it scores two
//   readings, every null a reset and none (gReadings);
// - the sniff onsets of row 4: audio.wav channel 0 after the sniff_<i> step marks
//   (clocks/compute.ts recountSniffLag), for best_case_ms and d1_on_sniffs_ms, for every number of
//   row 4 when calib.json has no sniff block, and for its grade when a median of calib.json sits
//   on a threshold (sniffSides).
// A value that differs between those readings MATCHes when one reading gives every such value of
// verdict.json at once, and the line names that condition; analysis/replay.ts counts the verdict
// as verified only when it and the row outcomes match without one.

import { chunkLayout, SNIFF_KILL_MIN_MS, SNIFF_PASS_MAX_MS, type Stamp } from '../../core/clock/index.ts';
import { d1ParamsFromFrozen, type FrozenParamsLike, type Sign } from '../../core/detector.ts';
import { combineGateVerdict, GATE_OUTCOMES, VERDICT_ROWS, type GateOutcome, type Verdict } from '../../core/schemas/index.ts';
import { GateRefusal, RATE, lrtUseFrom, round1, type LrtUse } from '../gate/common.ts';
import { gSettingsOf, sameJson, variantOf, withoutStageAKeys } from '../gate/frozen.ts';
import { scoreGate, type GateScore, type GateScoreInput } from '../gate/score.ts';
import { calibSniffBlockOf } from '../gate/sniffs.ts';
import { signOf } from '../gate/stage-a.ts';
import { tuneStageA } from '../gate/tune.ts';
import { verdictMarkdown } from '../gate/verdict-text.ts';
import { detectorInBefore, gateLayout, scoredCues, type GateLayout } from '../gate/view.ts';
import { onsetErrorBlock, onsetsLabelsSha256 } from '../label/marks.ts';
import { objectionBlockEnd } from '../lib/conditions.ts';
import { sha256Hex } from '../lib/ledger.ts';
import type { LoadedSession } from '../lib/session.ts';
import { tunedByStageA, tunedStepOf, type ParamsMatch } from './params.ts';
import { MARKS_FILE, RESETS_FILE, ReplayRefusal, type PublishedSet } from './set.ts';

/** INPUT: a value replay takes from the set to find what stage B scored with, so it is no result. */
export type CheckStatus = 'MATCH' | 'DIFFERS' | 'NOT_RECOMPUTABLE' | 'INPUT';

export interface Check {
  /** A field of verdict.json (rows.hits.hits), or "<file> <field>" for a value of another file of the set. */
  name: string;
  /** The file of the set that holds the published value. */
  against: string;
  /** Undefined when nothing was recomputed. */
  recomputed: unknown;
  /** The values the readings of the set give, when they differ (printed "a or b"); null otherwise. */
  candidates: unknown[] | null;
  published: unknown;
  status: CheckStatus;
  /** Why the value is not recomputable from the set, or why it is an input; null otherwise. */
  why: string | null;
  /** A MATCH that holds only under this condition, which the set does not show; null otherwise. */
  condition: string | null;
}

/** The values that make the verdict (spec 9.6): the outcome of each row and the verdict word. */
export const KEY_VALUES: readonly string[] = [...VERDICT_ROWS.map((r) => `rows.${r}.outcome`), 'verdict'];

/** A key value counts as verified when it matches without a condition. */
export function verifies(c: Check): boolean {
  return c.status === 'MATCH' && c.condition === null;
}

/** One reading of the packets of stream.jsonl with g null: which of them restart G's baseline. */
export interface GReading {
  resets: ReadonlySet<number>;
  /** The reading as a condition; null when the set says which packets are reset frames. */
  text: string | null;
}

export interface GReadings {
  readings: GReading[];
  /** True when the readings cover every case: the set lists the reset frames, or one packet has g null. */
  exhaustive: boolean;
  /** Packets of stream.jsonl with g null. */
  gNull: number;
  source: 'file' | 'no null' | 'both';
}

/**
 * The reset frames of G as replay can read them (spec 7.5, 8.1). live/reduce.cjs writes g null on
 * a reset frame and on a packet without a landmark frame; only lm of samples.jsonl tells them apart
 * (rivals gResetSeqs), so the reset frames lie among the packets with g null. RESETS_FILE lists
 * them; without it replay scores both extremes, every null a reset and none. With one packet with
 * g null these are the only cases; with more, a mix of them is not scored (assumption: a value both
 * extremes give alike is the one stage B found).
 */
export function gReadings(set: Pick<PublishedSet, 'inputs' | 'resets'>): GReadings {
  const nulls = new Set(set.inputs.flatMap((r) => (r.k === 'batch' && r.g === null ? [r.seq] : [])));
  if (set.resets !== null) return { readings: [{ resets: set.resets, text: null }], exhaustive: true, gNull: nulls.size, source: 'file' };
  if (nulls.size === 0) return { readings: [{ resets: nulls, text: null }], exhaustive: true, gNull: 0, source: 'no null' };
  return {
    readings: [
      { resets: nulls, text: 'if every packet with g null was a reset frame' },
      { resets: new Set<number>(), text: 'if no packet with g null was a reset frame' },
    ],
    exhaustive: nulls.size === 1,
    gNull: nulls.size,
    source: 'both',
  };
}

/**
 * The median of row 4 that sits on a threshold once rounded to 0.1 ms (spec 9.6: PASS while the hi
 * median is at most 150 ms, KILL when the lo median is above 350 ms): there the grade of the
 * unrounded medians (sniffs.ts gradingOf) may differ from the grade of the printed ones. Null when
 * no median sits there, or the row has no measured medians.
 */
export function sniffEdgeOf(r: { lo: number | null; hi: number | null; over: number | null; n: number }): 'hi' | 'lo' | null {
  if (r.n <= 0 || r.over !== null || r.lo === null || r.hi === null) return null;
  if (r.hi === round1(SNIFF_PASS_MAX_MS)) return 'hi';
  if (r.lo === round1(SNIFF_KILL_MIN_MS)) return 'lo';
  return null;
}

/** One way row 4 may have been graded: its outcome (null: as replay grades calib.json) and the condition. */
interface SniffSide {
  outcome: GateOutcome | null;
  text: string | null;
}

/**
 * The outcomes row 4 may have had. Replay grades the sniff block of calib.json as written
 * (sniffs.ts blockGrading); stage B grades it on the unrounded medians of its recount from
 * audio.wav when the recount agrees, so at a threshold the other side is possible too, and without
 * a sniff block every outcome is.
 */
function sniffSides(calib: PublishedSet['calib']): SniffSide[] {
  const block = calibSniffBlockOf(calib);
  if (block === null) return GATE_OUTCOMES.map((o) => ({ outcome: o, text: `if row 4 read ${o} on the recount from audio.wav` }));
  const edge = sniffEdgeOf({ lo: block.lo_median, hi: block.hi_median, over: block.median_over_ms, n: block.n });
  if (edge === 'hi') {
    return [
      { outcome: null, text: `if the hi median before rounding is at most ${SNIFF_PASS_MAX_MS} ms` },
      { outcome: 'BETWEEN', text: `if the hi median before rounding is above ${SNIFF_PASS_MAX_MS} ms` },
    ];
  }
  if (edge === 'lo') {
    return [
      { outcome: null, text: `if the lo median before rounding is at most ${SNIFF_KILL_MIN_MS} ms` },
      { outcome: 'KILL', text: `if the lo median before rounding is above ${SNIFF_KILL_MIN_MS} ms` },
    ];
  }
  return [{ outcome: null, text: null }];
}

/** The verdict with row 4 graded `outcome`, and the verdict word combined anew (spec 9.6). */
function onSide(v: Verdict, outcome: GateOutcome | null): Verdict {
  if (outcome === null || v.rows.sniff_lag.outcome === null) return v;
  const rows = { ...v.rows, sniff_lag: { ...v.rows.sniff_lag, outcome } };
  return { ...v, rows, verdict: combineGateVerdict(VERDICT_ROWS.map((r) => rows[r].outcome), v.events.valid) };
}

/** Stage B's score of a set with its cues: one score per reading of the packets with g null. */
export interface ScoredSet {
  layout: GateLayout;
  lrt: LrtUse;
  readings: GReading[];
  /** Where the reset frames come from (GReadings source). */
  gSource: GReadings['source'];
  /** scoreGate under each reading, in the order of `readings`; D1 is the same in each. */
  scores: GateScore[];
}

export interface SetReplay {
  set: PublishedSet;
  params: ParamsMatch;
  checks: Check[];
  notes: string[];
  /** Null without the cues: no cue can be scored. */
  scored: ScoredSet | null;
}

/** Why a value may not be recomputable from the set. */
type Need = 'cues' | 'cut' | 'sniffBlock' | 'sniffAudio';

interface Field {
  path: string;
  /** Not recomputable whenever one of these is missing. */
  needs?: readonly Need[];
}

const C: readonly Need[] = ['cues'];

/** Every value of verdict.json but schema, id and pack (checked when the set is read), in file order. */
export const VERDICT_FIELDS: readonly Field[] = [
  { path: 'run' },
  { path: 'exploratory' },
  { path: 'params_sha256' },
  { path: 'clock.L_rt_ms' },
  { path: 'clock.diff_ms' },
  { path: 'clock.rule' },
  { path: 'clock.onset_p90_ms' },
  { path: 'tuning.k' },
  { path: 'tuning.criterion_met' },
  { path: 'tuning.theta_G' },
  { path: 'events.cued', needs: C },
  { path: 'events.valid', needs: C },
  { path: 'events.armed', needs: C },
  { path: 'events.audible_inbreath', needs: C },
  { path: 'rows.hits.outcome', needs: C },
  { path: 'rows.hits.hits', needs: C },
  { path: 'rows.hits.armed_hits', needs: C },
  { path: 'rows.hits.leads_0_50', needs: C },
  { path: 'rows.lead.outcome', needs: C },
  { path: 'rows.lead.median_hits_ms', needs: C },
  { path: 'rows.lead.median_all_stops_ms', needs: C },
  { path: 'rows.false_holds.outcome', needs: C },
  { path: 'rows.false_holds.per_min', needs: C },
  { path: 'rows.false_holds.armed_min', needs: C },
  { path: 'rows.false_holds.in_sample_chest_per_min', needs: ['cut'] },
  { path: 'rows.false_holds.in_sample_lips_per_min', needs: ['cut'] },
  { path: 'rows.sniff_lag.outcome', needs: ['cues', 'sniffBlock'] },
  { path: 'rows.sniff_lag.lo_median_ms', needs: ['sniffBlock'] },
  { path: 'rows.sniff_lag.hi_median_ms', needs: ['sniffBlock'] },
  { path: 'rows.sniff_lag.median_over_ms', needs: ['sniffBlock'] },
  { path: 'rows.sniff_lag.n', needs: ['sniffBlock'] },
  { path: 'rows.sniff_lag.no_arrival', needs: ['sniffBlock'] },
  { path: 'rows.sniff_lag.best_case_ms', needs: ['sniffAudio'] },
  { path: 'rows.sniff_lag.d1_on_sniffs_ms', needs: ['sniffAudio'] },
  { path: 'rows.chest_vs_lips.outcome', needs: C },
  { path: 'rows.chest_vs_lips.wins', needs: C },
  { path: 'rows.chest_vs_lips.losses', needs: C },
  { path: 'rows.chest_vs_lips.ties', needs: C },
  { path: 'rows.chest_vs_lips.both_before_n', needs: C },
  { path: 'rows.chest_vs_lips.lead_diff_ms_median', needs: C },
  { path: 'rows.chest_vs_lips.chest_false_per_min', needs: C },
  { path: 'rows.chest_vs_lips.lips_false_per_min', needs: C },
  { path: 'rows.chest_vs_lips.exploratory_equal_rate', needs: C },
  { path: 'misses.no_inbreath', needs: C },
  { path: 'misses.inbreath_audible', needs: C },
  { path: 'other', needs: C },
  { path: 'manual_changes', needs: C },
  { path: 'verdict', needs: C },
];

/** The value at a dotted path of a JSON object. */
export function valueAt(value: unknown, dotted: string): unknown {
  let at: unknown = value;
  for (const key of dotted.split('.')) {
    if (typeof at !== 'object' || at === null || Array.isArray(at)) return undefined;
    at = (at as Record<string, unknown>)[key];
  }
  return at;
}

function refusing<T>(f: () => T, prefix = ''): T {
  try {
    return f();
  } catch (e) {
    if (e instanceof GateRefusal) throw new ReplayRefusal(`${prefix}${e.message}`);
    throw e;
  }
}

/**
 * What gateLayout and scoredCues read of a loaded session: kind and manifest (the pack, and
 * whether an SDK measured the run, which set.ts has checked), the folder (named in the refusal of
 * a run no SDK measured), the stamps (here the mark lines alone) and the chunk layout of audio.wav
 * (none: the set has no audio, so a scored block that runs to the end of the recording cannot be
 * found; see marksOf).
 */
function markSession(set: PublishedSet, marks: readonly Stamp[]): LoadedSession {
  const view: Pick<LoadedSession, 'kind' | 'manifest' | 'dir' | 'stamps' | 'layout'> = {
    kind: set.manifest.kind,
    manifest: set.manifest,
    dir: set.dir,
    stamps: [...marks],
    layout: chunkLayout([], 0),
  };
  return view as LoadedSession;
}

interface MarkView {
  /** The layout of the marks; null without them. */
  layout: GateLayout | null;
  /** The scored cues; null when the set does not give the end of the scored block. */
  cues: number[] | null;
  /** Why the values that need the cues are not recomputable; null when they are. */
  whyNoCues: string | null;
  /** Why the values that need the listening block (stage A, the in-sample rates) are not; null when they are. */
  whyNoCut: string | null;
}

/** The layout and the scored cues as stage B finds them, or why the set cannot give them. */
function marksOf(set: PublishedSet): MarkView {
  if (set.marks === null) {
    const why = `needs the cue and step marks of stamps.jsonl ("mark" lines), which the set does not carry (no ${MARKS_FILE})`;
    return { layout: null, cues: null, whyNoCues: why, whyNoCut: why };
  }
  const s = markSession(set, set.marks as unknown as Stamp[]);
  const layout = refusing(() => gateLayout(s), `${MARKS_FILE}: `);
  if (!Number.isFinite(objectionBlockEnd(s, layout.gate))) {
    return {
      layout,
      cues: null,
      whyNoCues: `${MARKS_FILE} has no step mark after the cues, so stage B ended the scored block at the last stamp or audio chunk of stamps.jsonl, which the set does not hold`,
      whyNoCut: null,
    };
  }
  return { layout, cues: scoredCues(s, layout), whyNoCues: null, whyNoCut: null };
}

type Tuning = Verdict['tuning'];

/**
 * Stage A's tuning on the listening block, as analysis/gate/stage-a.ts runs it: every input sliced
 * at the objections mark (view.ts detectorInBefore with the arrivals before it), the params without
 * what stage A writes (frozen.ts withoutStageAKeys: the gate-prereg file), the reset frames of G
 * under one reading.
 */
function stageATuning(set: PublishedSet, layout: GateLayout, params: ParamsMatch, sign: Sign, resets: ReadonlySet<number>): Tuning {
  const nCut = layout.nCut;
  const before = new Map([...set.nArrBySeq].filter(([, n]) => n < nCut));
  const base = withoutStageAKeys(params.value);
  const g = gSettingsOf(base);
  const t = tuneStageA({
    inputs: detectorInBefore(set.inputs, before, nCut),
    nArrBySeq: before,
    resetSeqs: resets,
    listening: layout.listening,
    frozen: base as FrozenParamsLike,
    sign,
    variant: variantOf(base),
    gFrames: g.frames,
    gBaselineS: g.baselineS,
    gResetWaitS: g.resetWaitS,
    invalidCodes: d1ParamsFromFrozen(base as FrozenParamsLike).invalid_codes,
  });
  return { k: t.k, criterion_met: t.criterionMet, theta_G: t.thetaG };
}

function tuningText(t: Tuning): string {
  return `k ${t.k}, criterion_met ${t.criterion_met} and theta_G ${t.theta_G}`;
}

/** The printed form of a value: hashes by their first 8 hex digits, the rest as JSON. */
export function shownValue(v: unknown): string {
  if (v === undefined) return '-';
  if (typeof v === 'string') return /^[0-9a-f]{64}$/.test(v) ? v.slice(0, 8) : v;
  return JSON.stringify(v);
}

function distinct(values: readonly unknown[]): unknown[] {
  const out: unknown[] = [];
  for (const v of values) if (!out.some((o) => sameJson(o, v))) out.push(v);
  return out;
}

/** One scored case: a reading of the packets with g null and a way row 4 was graded. */
interface Scenario {
  reading: number;
  side: number;
  verdict: Verdict;
  tuning: Tuning;
}

/** Recomputes one set and compares it with its verdict.json; a ReplayRefusal when it cannot be scored at all. */
export function replaySet(set: PublishedSet, params: ParamsMatch): SetReplay {
  const notes: string[] = [];
  const lrt = refusing(() => lrtUseFrom(set.calib.L_rt_ms));
  const sign = refusing(() => signOf({ calib: set.calib }));
  // The label step's P90 of |auto - manual| (analysis/label.ts writes it to clock_report.json, stage B reads it there).
  const onsetBlock = onsetErrorBlock(set.onsets, RATE);
  const g = gReadings(set);
  const mv = marksOf(set);
  const nCut = mv.layout?.nCut ?? 0;
  const base: Omit<GateScoreInput, 'resetSeqs'> = {
    id: set.id,
    pack: set.pack,
    // Stage B writes verdict.json on its confirmatory run, run 1: the ledger refuses an exploratory
    // stage_b before it and a second confirmatory one after it (spec 8.5, core/schemas ledger.ts).
    run: 1,
    paramsSha256: params.sha256,
    frozen: params.value,
    sign,
    lrt,
    inputs: set.inputs,
    nArrBySeq: set.nArrBySeq,
    nCut,
    listening: mv.layout?.listening ?? { n0: 0, n1: 0 },
    // Without the cues no cue is scored: an empty block gives the values that need none of them.
    scored: mv.cues !== null && mv.layout !== null ? mv.layout.scored : { n0: nCut, n1: nCut },
    cues: mv.cues ?? [],
    onsets: set.onsets.events,
    calib: set.calib,
    onsetP90Ms: onsetBlock.p90_abs_auto_minus_manual_ms,
    criterionMet: params.criterionMet,
    // Row 4 from calib.json alone: the recount needs audio.wav (see the head of this file).
    sniffRecount: null,
    skipOther: false,
  };
  const scores = g.readings.map((r) => scoreGate({ ...base, resetSeqs: r.resets }));

  // Stage A's tuning, tuned again on the listening block when the marks give it and the params hold
  // stage A's tuning. Stage A tunes on the gate recording: pack A (PREREG §11), whose tuning must
  // then come back. Packs B and C are scored with pack A's params once the retune froze them, unless
  // one was recorded as the gate after a lost pack A (PREREG §7.4); the set does not say which, so
  // there the tuning counts as recomputed only where tuning again gives the values of the params.
  const byStageA = tunedByStageA(params);
  const retuned = byStageA && mv.layout !== null ? g.readings.map((r) => stageATuning(set, mv.layout!, params, sign, r.resets)) : null;
  const ofParams = scores[0]!.verdict.tuning;
  const tunedHere = byStageA && (set.pack === 'A' || (retuned !== null && retuned.every((t) => sameJson(t, ofParams))));
  const tunings = tunedHere ? retuned : null;

  const sides = sniffSides(set.calib);
  const scenarios: Scenario[] = scores.flatMap((score, reading) =>
    sides.map((side, s) => ({ reading, side: s, verdict: onSide(score.verdict, side.outcome), tuning: tunings?.[reading] ?? score.verdict.tuning })),
  );
  const valueOf = (sc: Scenario, path: string): unknown => (path.startsWith('tuning.') ? valueAt({ tuning: sc.tuning }, path) : valueAt(sc.verdict, path));
  const published = set.verdict;

  const block = calibSniffBlockOf(set.calib);
  const why = (need: Need): string | null => {
    switch (need) {
      case 'cues':
        return mv.whyNoCues;
      case 'cut':
        return mv.whyNoCut;
      case 'sniffBlock':
        return block === null
          ? 'calib.json has no sniff_lag_ms, so stage B recounted the sniff lag from audio.wav channel 0 after the sniff_<i> step marks, with the arrivals of samples.jsonl and the chunk stamps of stamps.jsonl (analysis/clocks/compute.ts recountSniffLag); samples.jsonl and stamps.jsonl are never published, and replay reads no audio'
          : null;
      case 'sniffAudio':
        return 'needs the sniff onsets stage B finds in audio.wav channel 0 after the sniff_<i> step marks, placed by the chunk stamps of stamps.jsonl (analysis/clocks/compute.ts recountSniffLag); stamps.jsonl is never published, and replay reads no audio';
    }
  };

  const checks: Check[] = [];
  const result = (f: Field, c: Partial<Check> & Pick<Check, 'recomputed' | 'status'>): Check => ({
    name: f.path,
    against: 'verdict.json',
    published: valueAt(published, f.path),
    candidates: null,
    condition: null,
    why: null,
    ...c,
  });
  /** Values that differ between the scenarios and that the set lets replay compute: settled together below. */
  const pending: { f: Field; index: number }[] = [];
  /** Values whose only gap is the sniff block: they still constrain which side of row 4 holds. */
  const constraining: Field[] = [];
  for (const f of VERDICT_FIELDS) {
    if (f.path === 'params_sha256') {
      checks.push(
        result(f, {
          recomputed: undefined,
          status: 'INPUT',
          why: 'replay finds the params by this hash (see "params" above), so it is the input that names them, not a result',
        }),
      );
      continue;
    }
    const missing = (f.needs ?? []).map((n) => [n, why(n)] as const).filter(([, w]) => w !== null);
    const values = scenarios.map((sc) => valueOf(sc, f.path));
    const varies = distinct(values).length > 1;
    if (missing.length > 0) {
      if (varies && missing.every(([n]) => n === 'sniffBlock')) constraining.push(f);
      checks.push(result(f, { recomputed: undefined, status: 'NOT_RECOMPUTABLE', why: missing[0]![1] }));
      continue;
    }
    if (f.path.startsWith('tuning.') && tunings === null) {
      checks.push(tuningCheck(f, values[0], valueAt(published, f.path), params, tunedHere, mv.whyNoCut));
      continue;
    }
    if (varies) {
      pending.push({ f, index: checks.length });
      checks.push(result(f, { recomputed: undefined, status: 'NOT_RECOMPUTABLE' }));
      continue;
    }
    const mine = values[0];
    const theirs = valueAt(published, f.path);
    if (sameJson(mine, theirs)) checks.push(result(f, { recomputed: mine, status: 'MATCH' }));
    else if (f.path === 'other' && theirs === null && mine !== null) {
      checks.push(
        result(f, {
          recomputed: mine,
          status: 'NOT_RECOMPUTABLE',
          why: 'verdict.json has no OTHER line: stage B leaves it out with --no-other (spec 14.4), and the set does not say whether it did',
        }),
      );
    } else checks.push(result(f, { recomputed: mine, status: 'DIFFERS' }));
  }

  // The values that differ between the readings: one scenario must give every one of them at once.
  const fits = (sc: Scenario, f: Field): boolean => sameJson(valueOf(sc, f.path), valueAt(published, f.path));
  const joint = scenarios.filter((sc) => [...pending.map((p) => p.f), ...constraining].every((f) => fits(sc, f)));
  const conditionOf = (f: Field, among: readonly Scenario[]): string => {
    const at = (r: number, s: number): unknown => valueOf(scenarios.find((x) => x.reading === r && x.side === s)!, f.path);
    const byReading = scenarios.some((x) => scenarios.some((y) => y.side === x.side && !sameJson(at(x.reading, x.side), at(y.reading, y.side))));
    const bySide = scenarios.some((x) => scenarios.some((y) => y.reading === x.reading && !sameJson(at(x.reading, x.side), at(y.reading, y.side))));
    const readingsIn = [...new Set(among.map((x) => x.reading))];
    const sidesIn = [...new Set(among.map((x) => x.side))];
    const readingText = readingsIn.length === 1 ? g.readings[readingsIn[0]!]!.text : null;
    const sideText = sidesIn.length === 1 ? sides[sidesIn[0]!]!.text : null;
    const own = [byReading ? readingText : null, bySide ? sideText : null].filter((t): t is string => t !== null);
    const all = [readingText, sideText].filter((t): t is string => t !== null);
    return (own.length > 0 ? own : all).join(' and ') || 'under one of the readings replay scores';
  };
  for (const p of pending) {
    const values = scenarios.map((sc) => valueOf(sc, p.f.path));
    const candidates = distinct(values);
    const theirs = valueAt(published, p.f.path);
    if (joint.length > 0) {
      checks[p.index] = result(p.f, { recomputed: theirs, candidates, status: 'MATCH', condition: conditionOf(p.f, joint) });
    } else if (g.exhaustive) {
      checks[p.index] = result(p.f, { recomputed: undefined, candidates, status: 'DIFFERS' });
    } else {
      const alone = scenarios.filter((sc) => fits(sc, p.f));
      checks[p.index] = result(p.f, {
        recomputed: undefined,
        candidates,
        status: 'NOT_RECOMPUTABLE',
        why:
          alone.length > 0
            ? `verdict.json holds the value replay finds ${conditionOf(p.f, alone)}, but no one reading gives every value of verdict.json that differs between them; stream.jsonl does not say which of its ${g.gNull} packets with g null were reset frames (lm of samples.jsonl, which is never published), and a mix of them is not scored`
            : `neither reading of the ${g.gNull} packets of stream.jsonl with g null gives it, every one a reset frame or none; which were is in lm of samples.jsonl, which is never published, and a mix of them is not scored`,
      });
    }
  }
  if (pending.length > 0 && joint.length === 0 && g.exhaustive) {
    notes.push(
      `no one reading of the packets with g null and of row 4 gives every value of verdict.json that differs between the readings (${pending.map((p) => p.f.path).join(', ')}); since the readings cover every case, those values read DIFFERS`,
    );
  }

  // Files of the set beside verdict.json.
  const labels = onsetsLabelsSha256(set.onsets, sha256Hex);
  checks.push(plain('onsets.json labels_sha256', 'onsets.json', labels, set.onsets.labels_sha256));
  checks.push(plain('clock_report.json onset.p90_abs_auto_minus_manual_ms', 'clock_report.json', onsetBlock.p90_abs_auto_minus_manual_ms, set.clockReport.onset?.p90_abs_auto_minus_manual_ms ?? null));
  const md = verdictMdCheck(set);
  checks.push(md.check);
  if (md.note !== null) notes.push(md.note);

  if (mv.whyNoCues !== null && set.marks === null) {
    notes.push(
      `stage B takes the cues and the step marks (listening, objections, the first step after the cues) from the "mark" lines of stamps.jsonl (analysis/gate/view.ts); stamps.jsonl is not published (spec 8.7), and neither stream.jsonl nor events.jsonl holds them, so every value that needs them is not recomputable from this set`,
    );
  }
  if (g.source === 'file') {
    notes.push(`G: the reset frames are the ${g.readings[0]!.resets.size} packets ${RESETS_FILE} lists (rivals gResetSeqs on samples.jsonl), of the ${g.gNull} packets of stream.jsonl with g null`);
  } else if (g.source === 'both') {
    const one = g.gNull === 1;
    notes.push(
      `G: ${one ? '1 packet of stream.jsonl carries g null; it is' : `${g.gNull} packets of stream.jsonl carry g null, each`} a reset frame of G or a packet without a landmark frame; lm of samples.jsonl tells ${
        one ? 'which' : 'them apart'
      } and is never published (spec 8.1, 8.7), and the set has no ${RESETS_FILE}. Replay scores ${one ? 'it as a reset, and as none' : 'every null as a reset, and none'}: a value both give alike counts as recomputed${
        g.exhaustive ? '' : ' (assumption: a mix of the two gives it too)'
      }, and one they give differently matches only under the reading that gives every such value of verdict.json`,
    );
  }
  if (tunings !== null && set.pack === 'A') {
    notes.push('tuning: stage A tuned k and theta_G on the listening block of this recording; replay tunes them again there (analysis/gate/tune.ts tuneStageA)');
  } else if (tunings !== null) {
    notes.push(
      `tuning: replay tunes k and theta_G again on the listening block of this recording (analysis/gate/tune.ts tuneStageA) and gets the values of the params, as stage A does when pack ${set.pack} is the gate recording after a lost pack A (PREREG §7.4)`,
    );
  } else if (byStageA && set.pack !== 'A') {
    const again = distinct(retuned ?? []).map((t) => tuningText(t as Tuning));
    notes.push(
      `tuning: packs B and C are scored with pack A's params once the retune froze them (PREREG §11), so tuning holds the values of the params, which the replay of pack A's set recomputes; ${
        again.length > 0
          ? `tuned again on the listening block of this recording they would be ${again.join(' or ')}, so stage A did not tune them here (it would have, had pack ${set.pack} been recorded as the gate after a lost pack A, PREREG §7.4)`
          : 'without the marks replay cannot tune this recording again to compare'
      }`,
    );
  } else if (!byStageA) {
    const step = tunedStepOf(params);
    notes.push(
      `tuning: the params stage B scored with were set by ${step === 'retune' ? 'the retune on pack A (PREREG §11)' : step === null ? 'no step of stage A' : `the ${step} step`}, not by stage A on this recording, so tuning holds the values of the params`,
    );
  }

  const first = scores[0]!;
  if (mv.cues !== null && mv.layout !== null) {
    const scored = mv.layout.scored;
    const inBlock = (stops: readonly { nFire: number }[]): number => stops.filter((s) => s.nFire >= scored.n0 && s.nFire < scored.n1).length;
    const lips = distinct(scores.map((sc) => `${sc.runs.g.stops.length} in the recording (${inBlock(sc.runs.g.stops)} in the scored block)`));
    notes.push(`stops of the replayed runs: chest D1 ${first.runs.d1.stops.length} in the recording (${inBlock(first.runs.d1.stops)} in the scored block), lips G ${lips.join(' or ')}`);
    for (const r of first.replies) if (!r.valid) notes.push(`cue ${r.cue} has no valid objection: ${r.why}`);
  } else {
    notes.push(
      `stops of the replayed runs: chest D1 ${first.runs.d1.stops.length}, lips G ${distinct(scores.map((sc) => sc.runs.g.stops.length)).join(' or ')} in the recording; without the cues no stop can be placed in the scored block`,
    );
  }

  return {
    set,
    params,
    checks,
    notes,
    scored: mv.cues !== null && mv.layout !== null ? { layout: mv.layout, lrt, readings: g.readings, gSource: g.source, scores } : null,
  };
}

/**
 * tuning.* when replay does not tune again. Params replay rebuilt with the tuning of verdict.json
 * make it an input. Params found as a file hold it, so verdict.json must give theirs; on the
 * recording stage A tuned them on, that agreement still leaves the tuning itself unchecked.
 */
function tuningCheck(f: Field, fromParams: unknown, published: unknown, params: ParamsMatch, tunedHere: boolean, whyNoCut: string | null): Check {
  const c = { name: f.path, against: 'verdict.json', published, candidates: null, condition: null };
  if (params.how === 'rebuilt') {
    return {
      ...c,
      recomputed: undefined,
      status: 'INPUT',
      why: 'replay rebuilt the params with this value of verdict.json (see "params" above), so it is an input of the replay, not a result',
    };
  }
  if (!sameJson(fromParams, published)) return { ...c, recomputed: fromParams, status: 'DIFFERS', why: null };
  if (tunedHere) {
    return {
      ...c,
      recomputed: undefined,
      status: 'NOT_RECOMPUTABLE',
      why: `verdict.json gives the value of the params, but stage A tuned it on the listening block of this recording, and the block ${whyNoCut ?? 'is not in the set'}`,
    };
  }
  return { ...c, recomputed: fromParams, status: 'MATCH', why: null };
}

/**
 * verdict.md against the text stage B writes from verdict.json (analysis/gate/verdict-text.ts
 * verdictMarkdown, run of runs as verdict.json numbers it). Only where a median of row 4 sits on
 * a threshold may the row also say that it was graded on the medians before rounding.
 */
function verdictMdCheck(set: PublishedSet): { check: Check; note: string | null } {
  const v = set.verdict;
  const r = v.rows.sniff_lag;
  const edge = sniffEdgeOf({ lo: r.lo_median_ms, hi: r.hi_median_ms, over: r.median_over_ms, n: r.n });
  const texts = [false, ...(edge !== null ? [true] : [])].map((gradedUnrounded) => verdictMarkdown(v, v.run, { sniff: { gradedUnrounded } }));
  const hit = texts.find((t) => t === set.verdictMd);
  const check: Check = {
    name: 'verdict.md',
    against: 'verdict.md',
    recomputed: sha256Hex(hit ?? texts[0]!),
    candidates: null,
    published: sha256Hex(set.verdictMd),
    status: hit !== undefined ? 'MATCH' : 'DIFFERS',
    why: null,
    condition: null,
  };
  if (hit !== undefined) return { check, note: null };
  const mine = texts[0]!.split('\n');
  const theirs = set.verdictMd.split('\n');
  // The first line that differs; past the end of stage B's text when verdict.md only adds lines.
  const first = mine.findIndex((l, k) => l !== theirs[k]);
  const i = first >= 0 ? first : mine.length;
  return {
    check,
    note: `verdict.md line ${i + 1} reads ${JSON.stringify(theirs[i] ?? '')}, where stage B writes ${JSON.stringify(mine[i] ?? '')} from verdict.json (analysis/gate/verdict-text.ts)`,
  };
}

/** A value of another file of the set: MATCH or DIFFERS. */
function plain(name: string, against: string, mine: unknown, theirs: unknown): Check {
  const same = sameJson(mine, theirs);
  return { name, against, recomputed: mine, candidates: null, published: theirs, status: same ? 'MATCH' : 'DIFFERS', why: null, condition: null };
}

/** The status column of a check. */
export function statusText(c: Check): string {
  switch (c.status) {
    case 'MATCH':
      return c.condition === null ? 'MATCH' : `MATCH ${c.condition}`;
    case 'DIFFERS':
      return 'DIFFERS';
    case 'NOT_RECOMPUTABLE':
      return `not recomputable from the set: ${c.why ?? ''}`;
    case 'INPUT':
      return `an input of the replay: ${c.why ?? ''}`;
  }
}

/**
 * The console lines of one set: a line per value with its name, the recomputed value (the values
 * of the readings, "a or b", where they differ and none fits), the published one and its status.
 * The values of verdict.json come first, then those of the other files of the set.
 */
export function checkLines(checks: readonly Check[]): string[] {
  const width = Math.max(...checks.map((c) => c.name.length));
  // Columns as wide as most values; a longer one (the OTHER object) pushes its own line only.
  const valueWidth = 12;
  const pad = (s: string, n: number): string => s + ' '.repeat(Math.max(0, n - s.length));
  const mine = (c: Check): string => (c.status !== 'MATCH' && c.candidates !== null ? c.candidates.map(shownValue).join(' or ') : shownValue(c.recomputed));
  const line = (c: Check): string => `  ${pad(c.name, width)}  ${pad(mine(c), valueWidth)}  ${pad(shownValue(c.published), valueWidth)}  ${statusText(c)}`;
  const head = (published: string): string => `  ${pad('value', width)}  ${pad('recomputed', valueWidth)}  ${pad(published, valueWidth)}  status`;
  const verdict = checks.filter((c) => c.against === 'verdict.json');
  const others = checks.filter((c) => c.against !== 'verdict.json');
  return [head('verdict.json'), ...verdict.map(line), ...(others.length > 0 ? [head('in the file'), ...others.map(line)] : [])];
}

export interface StatusCount {
  MATCH: number;
  /** MATCHes that hold only under a condition the set does not show. */
  conditional: number;
  DIFFERS: number;
  NOT_RECOMPUTABLE: number;
  INPUT: number;
}

export function countStatus(checks: readonly Check[]): StatusCount {
  const out: StatusCount = { MATCH: 0, conditional: 0, DIFFERS: 0, NOT_RECOMPUTABLE: 0, INPUT: 0 };
  for (const c of checks) {
    out[c.status]++;
    if (c.status === 'MATCH' && c.condition !== null) out.conditional++;
  }
  return out;
}

/** "12 MATCH (2 of them only under a condition), 1 DIFFERS, 3 not recomputable from the set, 1 input". */
export function countText(n: StatusCount): string {
  const cond = n.conditional > 0 ? ` (${n.conditional} of them only under a condition)` : '';
  return `${n.MATCH} MATCH${cond}, ${n.DIFFERS} DIFFERS, ${n.NOT_RECOMPUTABLE} not recomputable from the set, ${n.INPUT} ${n.INPUT === 1 ? 'input' : 'inputs'}`;
}
