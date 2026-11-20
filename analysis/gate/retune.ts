// Tuning on pack A (PREREG §11, spec 9.8). With PASS the stage A set stays. Otherwise the ladder of
// PREREG §7.7 runs whatever rows are BETWEEN or KILL: rung 1 is k one grid step down with stage A's
// limit of 1.0 fire per minute lifted (none at k = 1.5, where rungs 2 and 3 keep stage A's k);
// rung 2 the nine pairs of L and M at that k; rung 3 D3 there with the L and M of the pair with the
// highest row 1 count. The first rung with PASS on all five rows of pack A sets the parameters; if
// none does, step 3 of §11 picks among the stage A set and every set the ladder tried. Each set gets
// its own theta_G by the budget of PREREG §6.4 on the listening block, computed with its own
// detector, and its rows are graded by stage B's own scoreGate: automatic onsets, virtual stops,
// and BETWEEN for a row whose grade changes with the blind manual onsets (PREREG §7.6).
// When the stage A set wins (step 1, or step 3) params/frozen.json stays as stage A wrote it.
// Pure: analysis/retune.ts loads the recording. Pack A is development data after its verdict.

import {
  CONSECUTIVE_M,
  L_RETUNE_GRID,
  M_RETUNE_GRID,
  SLOPE_WINDOW_L,
  d1ParamsFromFrozen,
  kStepDown,
  type DetectorInput,
  type FrozenParamsLike,
  type Variant,
} from '../../core/detector.ts';
import { THETA_G_GRID, type FrozenParams, type GateOutcome, type GateVerdict, type Verdict, type VerdictRow } from '../../core/schemas/index.ts';
import { lipBaselines, type SpanSamples } from '../rivals/index.ts';
import { sha256Hex } from '../lib/ledger.ts';
import { criterionMetOf, frozenParamsText, frozenWithTuning, gSettingsOf, variantOf } from './frozen.ts';
import { ROW_LIMITS } from './rows.ts';
import { activeMinutesIn, runD1, runG, stopsIn, type RunSetup } from './runs.ts';
import { scoreGate, type GateScoreInput } from './score.ts';
import { gBudget, type GTrial } from './tune.ts';
import { ROW_LABELS } from './verdict-text.ts';

/** One detector parameter set the tuning can try (PREREG §6.1-6.3, §7.7). */
export interface RetuneSet {
  k: number;
  /** Slope window, grid points. */
  L: number;
  /** Consecutive grid points over the threshold. */
  M: number;
  variant: Variant;
}

/** Where a set was tried: the stage A set, or a rung of the ladder of PREREG §7.7. */
export type RetuneSource = 'stage_a' | 'rung_1' | 'rung_2' | 'rung_3';

/** theta_G of one set by the budget of PREREG §6.4 on the listening block, with that set's detector. */
export interface ThetaGChoice {
  thetaG: number;
  /** False when no grid value kept G within the budget and the largest was taken (assumption, §6.4). */
  criterionMet: boolean;
  /** The set's detector in the listening block: its fires and active minutes give the budget. */
  d1Fires: number;
  d1ActiveMinutes: number;
  gLimit: number;
  /** G in the listening block for each theta_G tried, ascending, up to the one taken. */
  trials: GTrial[];
}

/** A set with its theta_G and the verdict stage B's scoring gives it on pack A (development data). */
export interface Candidate {
  set: RetuneSet;
  /** Every rung that tried this set, the first one first. */
  sources: RetuneSource[];
  /** 0 for the stage A set, then the order in which the ladder first tried each set. */
  order: number;
  thetaG: ThetaGChoice;
  /** scoreGate's verdict object for this set: the five rows as stage B grades them. */
  verdict: Verdict;
}

/** What grading one set gives: its theta_G and stage B's verdict object. */
export interface Graded {
  thetaG: ThetaGChoice;
  verdict: Verdict;
}

export type Grader = (set: RetuneSet) => Graded;

/**
 * Which rule of PREREG §11 chose the set: step 1 (pack A passed), step 2 (the first rung with PASS
 * on all five rows), or step 3 (no rung did: the sets with row 3 at most 2, or else the lowest row 3).
 */
export type RetuneStep = 'pass' | 'rung_1' | 'rung_2' | 'rung_3' | 'row3_at_most_2' | 'lowest_row3';

export interface RetuneOutcome {
  step: RetuneStep;
  chosen: Candidate;
  /** Every set graded, in the order first tried; the stage A set first. */
  candidates: Candidate[];
  /** The ladder's k (rung 1's, or stage A's at k = 1.5); null when pack A passed and no ladder ran. */
  ladderK: number | null;
  /** Rung 1's k; null at k = 1.5 or when no ladder ran. */
  rung1K: number | null;
  /** The pair rung 3 took, when rung 3 ran. */
  rung3Pair: { L: number; M: number } | null;
  /** The criterion that set the chosen one apart from the next best; null when it had no rival. */
  decidedBy: string | null;
  /** How many sets the deciding rule chose among (step 2 rung 2 and step 3). */
  among: number;
}

// ---- reading a candidate -------------------------------------------------------------------

/** PASS on all five rows of pack A (PREREG §7.6): combineGateVerdict gives PASS only then. */
export function passesAll(c: Pick<Candidate, 'verdict'>): boolean {
  return c.verdict.verdict === 'PASS';
}

/** Row 1: valid objections with a stop before the voice, automatic onsets. */
export function row1Count(c: Pick<Candidate, 'verdict'>): number {
  return c.verdict.rows.hits.hits;
}

/**
 * Row 3: false holds per active minute of the objection block, as verdict.json prints it (0.1/min,
 * the precision rows are graded at); null without active time.
 */
export function row3Rate(c: Pick<Candidate, 'verdict'>): number | null {
  return c.verdict.rows.false_holds.per_min;
}

/** Row 3 at most 2 false holds per active minute (PREREG §11 step 3), on the printed rate. */
export function row3AtMost2(c: Pick<Candidate, 'verdict'>): boolean {
  const r = row3Rate(c);
  return r !== null && r <= ROW_LIMITS.falsePassPerMin;
}

// ---- orders of PREREG §7.7 and §11 ------------------------------------------------------------

export interface Criterion {
  name: string;
  /** Negative when a goes first. */
  cmp: (a: Candidate, b: Candidate) => number;
}

const cmpNum = (x: number, y: number): number => (x < y ? -1 : x > y ? 1 : 0);
/** A rate without active time ranks after every number (assumption). */
const rateKey = (r: number | null): number => (r === null ? Number.POSITIVE_INFINITY : r);

const HIGHER_ROW1: Criterion = { name: 'the higher row 1 count', cmp: (a, b) => cmpNum(row1Count(b), row1Count(a)) };
const LOWER_ROW3: Criterion = { name: 'the lower row 3 rate', cmp: (a, b) => cmpNum(rateKey(row3Rate(a)), rateKey(row3Rate(b))) };
const L_NEARER: Criterion = {
  name: `L nearer ${SLOPE_WINDOW_L}`,
  cmp: (a, b) => cmpNum(Math.abs(a.set.L - SLOPE_WINDOW_L), Math.abs(b.set.L - SLOPE_WINDOW_L)),
};
const M_NEARER: Criterion = {
  name: `M nearer ${CONSECUTIVE_M}`,
  cmp: (a, b) => cmpNum(Math.abs(a.set.M - CONSECUTIVE_M), Math.abs(b.set.M - CONSECUTIVE_M)),
};
const LARGER_M: Criterion = { name: 'the larger M', cmp: (a, b) => cmpNum(b.set.M, a.set.M) };
const D1_FIRST: Criterion = { name: 'D1 before D3', cmp: (a, b) => cmpNum(a.set.variant === 'D1' ? 0 : 1, b.set.variant === 'D1' ? 0 : 1) };
const TRIED_FIRST: Criterion = { name: 'the set tried first', cmp: (a, b) => cmpNum(a.order, b.order) };

/**
 * Rung 2 (PREREG §7.7): the higher row 1 count, then the lower row 3 rate, L nearer 5, M nearer 2,
 * the larger M. The nine pairs differ in L or M, so the last step never decides.
 */
export const RUNG2_ORDER: readonly Criterion[] = [HIGHER_ROW1, LOWER_ROW3, L_NEARER, M_NEARER, LARGER_M, TRIED_FIRST];

/**
 * Step 3 of PREREG §11: the highest row 1 count, then the lower row 3 rate, L nearer 5, M nearer 2,
 * D1 before D3. Two sets can still tie there: M = 1 against M = 3, which goes to the larger M as in
 * rung 2, and the stage A set against rung 1's set with the same L and M, which goes to the set
 * tried first, so the stage A parameters stay (assumption: §11 names no further step).
 */
export const FALLBACK_ORDER: readonly Criterion[] = [HIGHER_ROW1, LOWER_ROW3, L_NEARER, M_NEARER, D1_FIRST, LARGER_M, TRIED_FIRST];

/** Step 3 when no set has row 3 at most 2: the lowest row 3 rate, then the order above (assumption). */
export const LOWEST_ROW3_ORDER: readonly Criterion[] = [LOWER_ROW3, HIGHER_ROW1, L_NEARER, M_NEARER, D1_FIRST, LARGER_M, TRIED_FIRST];

export function compareBy(order: readonly Criterion[]): (a: Candidate, b: Candidate) => number {
  return (a, b) => {
    for (const c of order) {
      const d = c.cmp(a, b);
      if (d !== 0) return d;
    }
    return 0;
  };
}

/** The candidates sorted by the order, best first. */
export function ranked(cands: readonly Candidate[], order: readonly Criterion[]): Candidate[] {
  return [...cands].sort(compareBy(order));
}

/** The criterion of the order that sets the first of `sorted` apart from the second; null with one. */
export function decidingCriterion(sorted: readonly Candidate[], order: readonly Criterion[]): string | null {
  const [a, b] = sorted;
  if (a === undefined || b === undefined) return null;
  for (const c of order) if (c.cmp(a, b) !== 0) return c.name;
  return null;
}

// ---- the ladder --------------------------------------------------------------------------------

export function setKey(s: RetuneSet): string {
  return `${s.variant} k=${s.k} L=${s.L} M=${s.M}`;
}

/**
 * PREREG §11 on pack A: `stageA` is the set stage A froze; `grade` gives a set its theta_G and its
 * rows. A set the ladder meets twice (rung 1's set is rung 2's pair with stage A's L and M; at
 * k = 1.5 rung 2 meets the stage A set) is graded once. A rung runs only when the one before it gave
 * no PASS on all five rows (PREREG §7.7).
 */
export function runRetune(stageA: RetuneSet, grade: Grader): RetuneOutcome {
  const byKey = new Map<string, Candidate>();
  const candidates: Candidate[] = [];
  const attempt = (set: RetuneSet, source: RetuneSource): Candidate => {
    const known = byKey.get(setKey(set));
    if (known !== undefined) {
      if (!known.sources.includes(source)) known.sources.push(source);
      return known;
    }
    const g = grade(set);
    const c: Candidate = { set, sources: [source], order: candidates.length, thetaG: g.thetaG, verdict: g.verdict };
    byKey.set(setKey(set), c);
    candidates.push(c);
    return c;
  };
  const base = attempt(stageA, 'stage_a');
  const done = (o: Omit<RetuneOutcome, 'candidates'>): RetuneOutcome => ({ ...o, candidates });
  if (passesAll(base)) return done({ step: 'pass', chosen: base, ladderK: null, rung1K: null, rung3Pair: null, decidedBy: null, among: 1 });

  // Rung 1: k one grid step down, the 1.0/min limit of stage A lifted (row 3 keeps false holds in check).
  const rung1K = kStepDown(stageA.k);
  const ladderK = rung1K ?? stageA.k;
  const ladder = { ladderK, rung1K };
  if (rung1K !== null) {
    const c1 = attempt({ k: rung1K, L: stageA.L, M: stageA.M, variant: 'D1' }, 'rung_1');
    if (passesAll(c1)) return done({ step: 'rung_1', chosen: c1, ...ladder, rung3Pair: null, decidedBy: null, among: 1 });
  }

  // Rung 2: the nine pairs of L and M at rung 1's k.
  const pairs = L_RETUNE_GRID.flatMap((L) => M_RETUNE_GRID.map((M) => attempt({ k: ladderK, L, M, variant: 'D1' }, 'rung_2')));
  const passing = ranked(pairs.filter(passesAll), RUNG2_ORDER);
  if (passing.length > 0) {
    return done({ step: 'rung_2', chosen: passing[0]!, ...ladder, rung3Pair: null, decidedBy: decidingCriterion(passing, RUNG2_ORDER), among: passing.length });
  }

  // Rung 3: D3 with the L and M of the pair with the highest row 1 count, ties as in rung 2.
  const best = ranked(pairs, RUNG2_ORDER)[0]!;
  const rung3Pair = { L: best.set.L, M: best.set.M };
  const c3 = attempt({ k: ladderK, ...rung3Pair, variant: 'D3' }, 'rung_3');
  if (passesAll(c3)) return done({ step: 'rung_3', chosen: c3, ...ladder, rung3Pair, decidedBy: null, among: 1 });

  // Step 3 of §11: among the stage A set and every set the ladder tried.
  const kept = ranked(candidates.filter(row3AtMost2), FALLBACK_ORDER);
  if (kept.length > 0) {
    return done({ step: 'row3_at_most_2', chosen: kept[0]!, ...ladder, rung3Pair, decidedBy: decidingCriterion(kept, FALLBACK_ORDER), among: kept.length });
  }
  const all = ranked(candidates, LOWEST_ROW3_ORDER);
  return done({ step: 'lowest_row3', chosen: all[0]!, ...ladder, rung3Pair, decidedBy: decidingCriterion(all, LOWEST_ROW3_ORDER), among: all.length });
}

// ---- params of a set ----------------------------------------------------------------------------

/** The set params/frozen.json holds: d1.k, d1.L, d1.M and the variant (D1 unless the file names D3). */
export function setOfParams(frozen: Readonly<Record<string, unknown>>): RetuneSet {
  const d1 = d1ParamsFromFrozen(frozen);
  return { k: d1.k, L: d1.L, M: d1.M, variant: variantOf(frozen) };
}

/**
 * The params with a set: d1.k, d1.L and d1.M, the top-level variant (which host and analysis both
 * read first, spec 8.4), d1.variant too when the file has one, and theta_G when given.
 */
export function paramsWithSet(base: Readonly<Record<string, unknown>>, set: RetuneSet, thetaG: number | null): Record<string, unknown> {
  const d1: Record<string, unknown> = { ...(base['d1'] as Record<string, unknown>), k: set.k, L: set.L, M: set.M };
  if (Object.hasOwn(d1, 'variant')) d1['variant'] = set.variant;
  const g: Record<string, unknown> = { ...(base['g'] as Record<string, unknown>) };
  if (thetaG !== null) g['theta_G'] = thetaG;
  return { ...base, d1, g, variant: set.variant };
}

/**
 * params/frozen.json after the tuning: the set, its theta_G and the tuned block with step "retune"
 * (analysis/gate/frozen.ts). In this record criterion_met says whether the set gave PASS on all five
 * rows of pack A (step 2 of §11); false when step 3 chose it (assumption: the retune's criterion is
 * that PASS, criterionMeaning). Only for a set other than the stage A set (chosenParams).
 */
export function retuneParams(base: Readonly<Record<string, unknown>>, c: Pick<Candidate, 'set' | 'thetaG' | 'verdict'>): FrozenParams {
  return frozenWithTuning(paramsWithSet(base, c.set, c.thetaG.thetaG), { k: c.set.k, criterionMet: passesAll(c), thetaG: c.thetaG.thetaG, step: 'retune' });
}

/**
 * True when the stage A set won, by PASS (§11 step 1) or by step 3: params/frozen.json then stays as
 * stage A wrote it, with stage A's own tuned block, and params/retune.json is its copy. Rungs 1 to 3
 * choose a set only on PASS on all five rows, which the stage A set lacks once the ladder runs.
 */
export function keepsStageAFile(o: Pick<RetuneOutcome, 'chosen'>): boolean {
  return o.chosen.order === 0;
}

/** The tuned.k record of a params file (spec 8.4): the step that set k, and its criterion_met. */
export interface TunedRecord {
  step: string;
  criterionMet: boolean;
}

export function tunedRecordOf(params: Readonly<Record<string, unknown>>): TunedRecord {
  const tuned = params['tuned'];
  const k = typeof tuned === 'object' && tuned !== null ? (tuned as Record<string, unknown>)['k'] : undefined;
  const step = typeof k === 'object' && k !== null ? (k as Record<string, unknown>)['step'] : undefined;
  return { step: typeof step === 'string' ? step : 'unknown', criterionMet: criterionMetOf(params, 'params/frozen.json') };
}

/**
 * The criterion that criterion_met refers to in the record of a step: stage A's limit on the
 * listening block (PREREG §6.2), or in a retune record PASS on all five rows of pack A (assumption,
 * retuneParams). verdict.md of packs B and C prints it on its TUNING line as "criterion met" or
 * "criterion not met".
 */
export function criterionMeaning(step: string): string | null {
  if (step === 'stage_a') return "stage A's limit of 1.0 fire per active minute in the listening block (PREREG §6.2)";
  if (step === 'retune') return 'PASS on all five rows of pack A (PREREG §11 step 2)';
  return null;
}

/** What --write puts in params/frozen.json and its copy params/retune.json. */
export interface ChosenParams {
  text: string;
  /** True when that is the stage A file as it is (keepsStageAFile). */
  stageAFile: boolean;
  /** Its tuned.k record. */
  tuned: TunedRecord;
}

/**
 * The params of the chosen set: the stage A file byte for byte when the stage A set won (§11 step 1:
 * the parameters stay; step 3 the same), so its tuned block stays stage A's and verdict.md of packs
 * B and C reads stage A's criterion; else the set with a tuned block of step "retune" (retuneParams).
 */
export function chosenParams(o: Pick<RetuneOutcome, 'chosen'>, base: Readonly<Record<string, unknown>>, baseText: string): ChosenParams {
  if (keepsStageAFile(o)) return { text: baseText, stageAFile: true, tuned: tunedRecordOf(base) };
  const value = retuneParams(base, o.chosen) as unknown as Record<string, unknown>;
  return { text: frozenParamsText(value), stageAFile: false, tuned: tunedRecordOf(value) };
}

// ---- grading a set on the recording -------------------------------------------------------------

/** The recording before the objection block, as stage A sees it (stage-a.ts stageAView). */
export interface ListeningView {
  inputs: readonly DetectorInput[];
  nArrBySeq: ReadonlyMap<number, number>;
  /** Packets that reset the baseline of G, before the cut. */
  resetSeqs: ReadonlySet<number>;
  /** The listening block [its mark, the cut). */
  span: SpanSamples;
}

/** Everything stage B's scoreGate takes but the params, as stage B builds it (analysis/retune.ts). */
export type ScoreBase = Omit<GateScoreInput, 'frozen' | 'paramsSha256' | 'criterionMet' | 'run' | 'skipOther'>;

export interface RetuneContext {
  /** params/frozen.json as stage A wrote it. */
  base: Readonly<Record<string, unknown>>;
  /** tuned.k.criterion_met of that file; scoreGate carries it into the verdict object only. */
  criterionMet: boolean;
  score: ScoreBase;
  listening: ListeningView;
}

/**
 * Grades sets on the recording. theta_G: the budget of PREREG §6.4 as stage A applies it (tune.ts),
 * the larger of the set's fires and its active minutes (rounded down) in the listening block, with
 * the smallest grid value whose G fires there stay within it, else 0.0600 (criterion not met). G
 * itself does not depend on the set, so its fires per grid value are counted once. The rows: stage
 * B's scoreGate with the set and its theta_G in the params; T and M, descriptive only, are left out.
 */
export function makeGrader(ctx: RetuneContext): Grader {
  const v = ctx.listening;
  const gs = gSettingsOf(ctx.base);
  const invalidCodes = d1ParamsFromFrozen(ctx.base).invalid_codes;
  const points = lipBaselines(v.inputs, v.nArrBySeq, { baselineS: gs.baselineS, resetWaitS: gs.resetWaitS, resetSeqs: v.resetSeqs });
  // runG reads only the hold block of the params, which no set changes.
  const gSetup: RunSetup = { frozen: ctx.base as FrozenParamsLike, sign: ctx.score.sign, variant: 'D1' };
  const grid = [...THETA_G_GRID].sort((a, b) => a - b);
  const gTrials = new Map<number, GTrial>();
  const gTrial = (thetaG: number): GTrial => {
    let t = gTrials.get(thetaG);
    if (t === undefined) {
      const run = runG(v.inputs, v.nArrBySeq, gSetup, { thetaG, frames: gs.frames, points, invalidCodes });
      t = { thetaG, fires: stopsIn(run, v.span).length, activeMinutes: activeMinutesIn(run, v.span) };
      gTrials.set(thetaG, t);
    }
    return t;
  };
  return (set) => {
    const d1Run = runD1(v.inputs, v.nArrBySeq, { frozen: paramsWithSet(ctx.base, set, null) as FrozenParamsLike, sign: ctx.score.sign, variant: set.variant });
    const d1Fires = stopsIn(d1Run, v.span).length;
    const d1ActiveMinutes = activeMinutesIn(d1Run, v.span);
    const gLimit = gBudget(d1Fires, d1ActiveMinutes);
    const trials: GTrial[] = [];
    let thetaG: number | null = null;
    for (const theta of grid) {
      const t = gTrial(theta);
      trials.push(t);
      if (t.fires <= gLimit) {
        thetaG = theta;
        break;
      }
    }
    const thetaChoice: ThetaGChoice = { thetaG: thetaG ?? grid[grid.length - 1]!, criterionMet: thetaG !== null, d1Fires, d1ActiveMinutes, gLimit, trials };
    const frozen = paramsWithSet(ctx.base, set, thetaChoice.thetaG);
    const score = scoreGate({
      ...ctx.score,
      frozen,
      paramsSha256: sha256Hex(frozenParamsText(frozen)),
      criterionMet: ctx.criterionMet,
      run: 1,
      skipOther: true,
    });
    return { thetaG: thetaChoice, verdict: score.verdict };
  };
}

// ---- the session report: retune-report.json and retune-report.md -------------------------------

/** What the report says beyond the outcome. */
export interface RetuneMeta {
  id: string;
  /** The confirmatory verdict of pack A (verdict.json of stage B). */
  verdict: GateVerdict;
  /** SHA-256 of params/frozen.json as stage A wrote it. */
  stageAParamsSha256: string;
  /** SHA-256 of the text --write puts in params/frozen.json and params/retune.json. */
  chosenParamsSha256: string;
  /** True when that text is the stage A file as it is (chosenParams). */
  stageAFile: boolean;
  /** The tuned.k record of that text. */
  tuned: TunedRecord;
  /** True when params/frozen.json and its copy params/retune.json hold the chosen set. */
  written: boolean;
}

export const DEVELOPMENT_NOTE =
  'Development data: pack A tunes the detector for packs B and C (PREREG §11). None of these numbers is confirmatory, and none is pooled with packs B and C.';

const SOURCE_LABEL: Readonly<Record<RetuneSource, string>> = { stage_a: 'stage A', rung_1: 'rung 1', rung_2: 'rung 2', rung_3: 'rung 3' };

export function sourcesText(c: Pick<Candidate, 'sources'>): string {
  return c.sources.map((s) => SOURCE_LABEL[s]).join(', ');
}

export function setText(s: RetuneSet): string {
  return `k=${s.k.toFixed(1)} L=${s.L} M=${s.M} ${s.variant}`;
}

const f1 = (x: number | null): string => (x === null ? 'n/a' : x.toFixed(1));
const f4 = (x: number): string => x.toFixed(4);

/** One sentence: which rule of PREREG §11 chose the set, and how. */
export function ruleText(o: RetuneOutcome): string {
  const n = o.chosen.order + 1;
  const by = o.decidedBy === null ? '' : `, set apart by ${o.decidedBy}`;
  switch (o.step) {
    case 'pass':
      return 'step 1: pack A gave PASS on all five rows, so the stage A set stays (PREREG §11)';
    case 'rung_1':
      return `step 2, rung 1: k one grid step down (${o.chosen.set.k.toFixed(1)}), stage A's limit of 1.0 fire per minute lifted, gives PASS on all five rows (PREREG §7.7, §11)`;
    case 'rung_2':
      return `step 2, rung 2: ${o.among} of the nine pairs of L and M at k=${o.chosen.set.k.toFixed(1)} give PASS on all five rows; set ${n} wins${by} (PREREG §7.7, §11)`;
    case 'rung_3':
      return `step 2, rung 3: D3 at k=${o.chosen.set.k.toFixed(1)} with L=${o.chosen.set.L} and M=${o.chosen.set.M}, the pair with the highest row 1 count, gives PASS on all five rows (PREREG §6.3, §7.7, §11)`;
    case 'row3_at_most_2':
      return `step 3: no rung gave PASS on all five rows; of the ${o.among} sets with row 3 at most 2 false holds per active minute, set ${n} wins${by} (PREREG §11)`;
    case 'lowest_row3':
      return `step 3: no rung gave PASS on all five rows and no set has row 3 at most 2 false holds per active minute; set ${n} has the lowest row 3 rate${by} (PREREG §11)`;
  }
}

/** The ladder as it ran, in one line. */
export function ladderText(o: RetuneOutcome, stageA: RetuneSet): string {
  if (o.ladderK === null) return 'not run: pack A passed (PREREG §11 step 1)';
  const parts = [o.rung1K === null ? `rung 1 none at k=${stageA.k.toFixed(1)}` : `rung 1 at k=${o.rung1K.toFixed(1)}`];
  const tried = (s: RetuneSource): boolean => o.candidates.some((c) => c.sources.includes(s));
  parts.push(tried('rung_2') ? `rung 2 at k=${o.ladderK.toFixed(1)}` : 'rung 2 not run');
  parts.push(o.rung3Pair !== null && tried('rung_3') ? `rung 3 D3 at k=${o.ladderK.toFixed(1)} L=${o.rung3Pair.L} M=${o.rung3Pair.M}` : 'rung 3 not run');
  return parts.join('; ');
}

function candidateJson(c: Candidate, chosen: Candidate): Record<string, unknown> {
  const t = c.thetaG;
  return {
    set: c.order + 1,
    tried: c.sources,
    k: c.set.k,
    L: c.set.L,
    M: c.set.M,
    variant: c.set.variant,
    theta_G: t.thetaG,
    theta_G_budget: {
      d1_fires: t.d1Fires,
      d1_active_min: Math.round(t.d1ActiveMinutes * 100) / 100,
      limit: t.gLimit,
      criterion_met: t.criterionMet,
      g_fires: t.trials.map((x) => ({ theta_G: x.thetaG, fires: x.fires })),
    },
    verdict: c.verdict.verdict,
    pass_all_five: passesAll(c),
    row3_at_most_2: row3AtMost2(c),
    chosen: c === chosen,
    events: c.verdict.events,
    rows: c.verdict.rows,
    misses: c.verdict.misses,
    manual_changes: c.verdict.manual_changes,
  };
}

/** retune-report.json in the session folder: every set with its theta_G, its five rows and their grades. */
export function retuneReport(o: RetuneOutcome, stageA: RetuneSet, m: RetuneMeta): Record<string, unknown> {
  const c = o.chosen;
  return {
    schema: 'retune-report/1',
    id: m.id,
    pack: 'A',
    development_data: true,
    note: DEVELOPMENT_NOTE,
    verdict: m.verdict,
    valid_objections: c.verdict.events.valid,
    stage_a: { ...stageA, theta_G: o.candidates[0]!.thetaG.thetaG, params_sha256: m.stageAParamsSha256 },
    ladder: o.ladderK === null ? null : { k: o.ladderK, rung_1_k: o.rung1K, rung_3_pair: o.rung3Pair },
    step: o.step,
    rule: ruleText(o),
    decided_by: o.decidedBy,
    chosen: {
      set: c.order + 1,
      k: c.set.k,
      L: c.set.L,
      M: c.set.M,
      variant: c.set.variant,
      theta_G: c.thetaG.thetaG,
      stage_a_set: c.order === 0,
      // When the stage A set wins, params/frozen.json stays as stage A wrote it (keepsStageAFile).
      stage_a_file: m.stageAFile,
      // tuned.k of the params --write puts in place, which verdict.md of packs B and C prints.
      tuned: { step: m.tuned.step, criterion_met: m.tuned.criterionMet, criterion: criterionMeaning(m.tuned.step) },
      params_sha256: m.chosenParamsSha256,
    },
    // params/frozen.json and params/retune.json hold the chosen set (npm run retune -- <id> --write).
    params_in_place: m.written,
    candidates: o.candidates.map((x) => candidateJson(x, c)),
  };
}

function cell(value: string, outcome: GateOutcome | null, width: number): string {
  return `${value} ${outcome ?? 'n/a'}`.padEnd(width);
}

const ROWS_HEAD = ['1 HITS', '2 LEAD ms', '3 FALSE/min', '4 SNIFF', '5 CHEST:LIPS'];
const ROW_WIDTHS = [11, 15, 14, 9, 15];

function setRow(c: Candidate, chosen: Candidate): string {
  const r = c.verdict.rows;
  const cells = [
    cell(String(r.hits.hits), r.hits.outcome, ROW_WIDTHS[0]!),
    cell(f1(r.lead.median_hits_ms), r.lead.outcome, ROW_WIDTHS[1]!),
    cell(f1(r.false_holds.per_min), r.false_holds.outcome, ROW_WIDTHS[2]!),
    (r.sniff_lag.outcome ?? 'n/a').padEnd(ROW_WIDTHS[3]!),
    cell(`${r.chest_vs_lips.wins}:${r.chest_vs_lips.losses}`, r.chest_vs_lips.outcome, ROW_WIDTHS[4]!),
  ];
  const mark = c === chosen ? '*' : ' ';
  const head = `${mark}${String(c.order + 1).padStart(2)}  ${sourcesText(c).padEnd(16)} ${c.set.k.toFixed(1)}  ${String(c.set.L).padEnd(2)} ${c.set.M}  ${c.set.variant.padEnd(3)} ${f4(c.thetaG.thetaG).padEnd(7)}`;
  return `${head} | ${cells.join(' ')}| ${c.verdict.verdict}`.trimEnd();
}

function budgetRow(c: Candidate): string {
  const t = c.thetaG;
  const g = t.trials.length === 0 ? 'n/a' : String(t.trials[t.trials.length - 1]!.fires);
  return ` ${String(c.order + 1).padStart(2)}  ${String(t.d1Fires).padEnd(8)} ${t.d1ActiveMinutes.toFixed(1).padEnd(10)} ${String(t.gLimit).padEnd(5)} ${f4(t.thetaG)}${t.criterionMet ? '  ' : '* '} ${g}`;
}

/** The TUNED line: the tuned.k record --write puts in place, and what its criterion is. */
export function tunedLine(m: Pick<RetuneMeta, 'stageAFile' | 'tuned'>): string {
  const t = m.tuned;
  const meaning = criterionMeaning(t.step);
  const step3 = !m.stageAFile && !t.criterionMet ? ', and step 3 chose this set' : '';
  return [
    `TUNED   tuned.k ${m.stageAFile ? 'as stage A wrote it' : 'of the retune'}: step ${t.step}, criterion ${t.criterionMet ? 'met' : 'not met'}`,
    meaning === null ? '' : `; in this record the criterion is ${meaning}${step3}`,
    '. Packs B and C print it on the TUNING line of verdict.md',
  ].join('');
}

/** The PARAMS line: what --write does, or did. After a win of the stage A set it writes only the copy. */
export function paramsLine(m: Pick<RetuneMeta, 'id' | 'stageAFile' | 'written'>): string {
  const freeze = 'npm run freeze -- gate-retune freezes them before pack B';
  if (m.written) {
    return m.stageAFile
      ? `PARAMS  params/frozen.json, as stage A wrote it, and its copy params/retune.json hold this set; ${freeze}`
      : `PARAMS  params/frozen.json and its copy params/retune.json hold this set; ${freeze}`;
  }
  return m.stageAFile
    ? `PARAMS  not written: npm run retune -- ${m.id} --write copies params/frozen.json, which stays as stage A wrote it, to params/retune.json`
    : `PARAMS  not written: npm run retune -- ${m.id} --write writes this set to params/frozen.json and its copy params/retune.json`;
}

/** retune-report.md: the same in plain text, development data marked on the first line. */
export function retuneMarkdown(o: RetuneOutcome, stageA: RetuneSet, m: RetuneMeta): string {
  const c = o.chosen;
  const a = o.candidates[0]!;
  const lines = [
    `RETUNE ${m.id} pack A | DEVELOPMENT DATA: pack A tunes, packs B and C confirm (PREREG §11)`,
    `VERDICT pack A, stage B: ${m.verdict} (${a.verdict.events.valid} valid objections, automatic onsets, virtual stops)`,
    `STAGE A ${setText(stageA)} theta_G=${f4(a.thetaG.thetaG)} | params ${m.stageAParamsSha256.slice(0, 8)}`,
    `LADDER  ${ladderText(o, stageA)}`,
    ...(m.verdict === 'NOT EVALUABLE'
      ? ['NOTE    fewer than 12 valid objections: no set can give PASS on all five rows, so step 3 of PREREG §11 decides on the row 1 counts and row 3 rates']
      : []),
    '',
    `SETS    each with its own theta_G; rows graded as stage B grades them (PREREG §7.6); * chosen`,
    `  #  tried            k    L  M  det theta_G | ${ROWS_HEAD.map((h, i) => h.padEnd(ROW_WIDTHS[i]!)).join(' ')}| verdict`,
    ...o.candidates.map((x) => setRow(x, c)),
  ];
  const manual = o.candidates.filter((x) => x.verdict.manual_changes.length > 0);
  for (const x of manual) {
    lines.push(`        set ${x.order + 1}: ${x.verdict.manual_changes.map((r: VerdictRow) => ROW_LABELS[r]).join(', ')} BETWEEN, the grade changes with the blind manual onsets`);
  }
  lines.push(
    '',
    'THETA_G budget of PREREG §6.4 on the listening block: max(fires, active minutes rounded down) of the set; * none kept G within it',
    '  #  fires    active min limit theta_G  G fires',
    ...o.candidates.map(budgetRow),
    '',
    `RULE    ${ruleText(o)}`,
    `CHOSEN  set ${c.order + 1}: ${setText(c.set)} theta_G=${f4(c.thetaG.thetaG)} | params ${m.chosenParamsSha256.slice(0, 8)}`,
    tunedLine(m),
    paramsLine(m),
    `NOTE    ${DEVELOPMENT_NOTE}`,
  );
  return `${lines.join('\n')}\n`;
}
