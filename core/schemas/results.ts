// results/results.json (spec 8.6): the only source of numbers for the article and video.
// The file is open: it stores keys beyond the 83 post keys. Known keys are type-checked,
// numbers in ms are rounded to 0.1, and listPostKeyProblems tells what the article lacks.

import { fail, isPlainObject, makeValidator, obj, lit, describe, isMsOrDbKey, type Spec, type Validator } from './check.ts';
import { HEX64, SESSION_ID } from './common.ts';
import { isRound1 } from './precision.ts';

export const RESULTS_FAMILIES = [
  'commits', 'setup', 'timing', 'gate', 'sessions', 'planted', 'review', 'rivals', 'paired', 'detector',
] as const;
export type ResultsFamily = (typeof RESULTS_FAMILIES)[number];

/** int: non-negative integer; num: finite number; ms: number rounded to 0.1; str: non-empty string. */
export type ResultsValueType = 'int' | 'num' | 'ms' | 'str';

const t = (type: ResultsValueType, keys: string): [string, ResultsValueType][] =>
  keys.split(/\s+/).filter(Boolean).map((k) => [k, type]);

/** The 83 substitutions of the article template, "family.key" -> type (spec 8.6 table). */
export const RESULTS_POST_KEYS: Readonly<Record<string, ResultsValueType>> = Object.fromEntries([
  ...t('num', 'sessions.active_min sessions.chance_used_pct sessions.false_holds_per_min sessions.narration_min'),
  ...t('num', 'sessions.p_binomial sessions.wilson_high_pct sessions.wilson_low_pct'),
  ...t('int', 'sessions.audible_inbreath sessions.chest_stops_outside_windows sessions.chest_stops_outside_windows_then_speech'),
  ...t('int', 'sessions.count sessions.false_holds sessions.hits sessions.hits_all_objections sessions.hits_lead_under_300'),
  ...t('int', 'sessions.hits_with_head_motion_first sessions.leads_0_50 sessions.matched sessions.misses'),
  ...t('int', 'sessions.misses_inbreath_present sessions.misses_no_inbreath sessions.objections sessions.signal_only_hits'),
  ...t('int', 'sessions.signal_only_n sessions.voice_stops'),
  ...t('ms', 'sessions.lead_ms_ci_high sessions.lead_ms_ci_low sessions.lead_ms_median_hits'),
  ...t('int', 'planted.by_class.negation.caught planted.by_class.negation.presented planted.by_class.number.caught'),
  ...t('int', 'planted.by_class.number.presented planted.by_class.referent.caught planted.by_class.referent.presented'),
  ...t('int', 'planted.by_class.sense.caught planted.by_class.sense.presented planted.caught planted.caught_late'),
  ...t('int', 'planted.per_session planted.presented planted.total'),
  ...t('num', 'planted.share_pct planted.wilson_high_pct planted.wilson_low_pct'),
  ...t('int', 'review.unplanted_finds'),
  ...t('ms', 'rivals.audio_250.delay_after_voice_ms rivals.chest.stop_after_span_onset_ms_median rivals.lips.lead_ms_median_hits'),
  ...t('ms', 'rivals.space_bar.stop_after_span_onset_ms_median rivals.talking_flag.lead_ms_median_hits'),
  ...t('int', 'rivals.chest.n rivals.lips.hits rivals.space_bar.n rivals.talking_flag.hits'),
  ...t('num', 'rivals.lips.false_per_min rivals.talking_flag.false_per_min'),
  ...t('int', 'paired.chest_vs_audio250.losses paired.chest_vs_audio250.wins paired.chest_vs_lips.losses'),
  ...t('int', 'paired.chest_vs_lips.n paired.chest_vs_lips.ties paired.chest_vs_lips.wins'),
  ...t('num', 'paired.chest_vs_audio250.p_holm paired.chest_vs_lips.p_holm'),
  ...t('int', 'gate.hits gate.valid'),
  ...t('ms', 'gate.lead_ms_median_hits'),
  ...t('ms', 'timing.L_rt_max_ms timing.L_rt_min_ms timing.onset_abs_diff_p90_ms timing.sniff_lag_hi_ms timing.sniff_lag_lo_ms'),
  ...t('int', 'timing.sniff_n'),
  ...t('str', 'setup.camera setup.machine setup.narrator setup.planter_model setup.sdk_version'),
  ...t('int', 'setup.min_days_since_last_read'),
  ...t('num', 'detector.k'),
  ...t('str', 'commits.freeze_1_short commits.gate_prereg_short commits.params_sha256_short'),
]);

/** Post keys that may be absent: head motion is dropped if rival M is cut (spec 8.6, 14.4). */
export const RESULTS_OPTIONAL_POST_KEYS: readonly string[] = ['sessions.hits_with_head_motion_first'];

/** Keys stored for checks beyond the post keys (spec 8.6). gate.verdict and commits.plans are checked apart. */
export const RESULTS_EXTRA_KEYS: Readonly<Record<string, ResultsValueType>> = Object.fromEntries([
  ...t('num', 'gate.false_holds_per_min sessions.chance_poisson_pct sessions.chance_shift_pct sessions.chance_pseudo_pct'),
  ...t('int', 'gate.chest_vs_lips.wins gate.chest_vs_lips.losses gate.chest_vs_lips.ties gate.chest_vs_lips.both_before_n'),
  ...t('int', 'paired.chest_vs_audio250.ties'),
  ...t('ms', 'gate.chest_vs_lips.lead_diff_ms_median rivals.lips.stop_after_span_onset_ms_median'),
  ...t('ms', 'rivals.audio_250.stop_after_span_onset_ms_median'),
]);

/**
 * commits.ledger_heads: session id -> SHA-256 of the last line of its ledger.jsonl, for every
 * ledger results reads (spec 8.5: the head goes into the receipt and into results.json; the
 * key name is an assumption). Checked here when present.
 */
export const LEDGER_HEADS_KEY = 'commits.ledger_heads';

/**
 * Counts that must agree across families (checked when all are counts): [total, parts, why].
 * One part means equality.
 */
export const RESULTS_SUMS: readonly (readonly [string, readonly string[], string])[] = [
  ['planted.caught', ['sessions.matched'], 'each caught error answers one matched objection (spec 8.6)'],
  ['sessions.matched', ['paired.chest_vs_lips.n'], 'one pair per objection of the main share (spec 4.4, 8.6)'],
  ['sessions.matched', ['sessions.hits', 'sessions.misses'], 'a matched objection without a stop before the voice is a miss, a late stop too (spec 4.2, 8.6)'],
  ['sessions.misses', ['sessions.misses_no_inbreath', 'sessions.misses_inbreath_present'], 'misses fall into two groups by the audible in-breath (spec 4.1)'],
  ['paired.chest_vs_lips.n', ['paired.chest_vs_lips.wins', 'paired.chest_vs_lips.losses', 'paired.chest_vs_lips.ties'], 'every pair is a win, a loss or a tie (spec 7.10)'],
];

export const PLAN_FATES = ['used', 'voided', 'aborted', 'unused'] as const;
export type PlanFate = (typeof PLAN_FATES)[number];

export const GATE_VERDICT_WORDS = ['PASS', 'BETWEEN', 'KILL', 'NOT EVALUABLE'] as const;

/** Families are open objects; see RESULTS_POST_KEYS for the keys the article reads. */
export type Results = { schema: 'results/1' } & { [F in ResultsFamily]?: Record<string, unknown> } & Record<string, unknown>;

/** Value at a dotted key like "planted.by_class.negation.caught"; undefined when absent. */
export function getResultsValue(results: unknown, dottedKey: string): unknown {
  let cur: unknown = results;
  for (const part of dottedKey.split('.')) {
    if (!isPlainObject(cur) || !Object.hasOwn(cur, part)) return undefined;
    cur = cur[part];
  }
  return cur;
}

function checkTyped(type: ResultsValueType, v: unknown, path: string, out: string[]): void {
  switch (type) {
    case 'int':
      if (typeof v !== 'number' || !Number.isSafeInteger(v) || v < 0) fail(out, path, `expected a count (non-negative integer), got ${describe(v)}`);
      return;
    case 'num':
      if (typeof v !== 'number' || !Number.isFinite(v)) fail(out, path, `expected a finite number, got ${describe(v)}`);
      return;
    case 'ms':
      if (typeof v !== 'number' || !Number.isFinite(v)) fail(out, path, `expected a number of ms, got ${describe(v)}`);
      else if (!isRound1(v)) fail(out, path, `expected a report value rounded to 0.1 (spec 8.1), got ${v}`);
      return;
    case 'str':
      if (typeof v !== 'string' || v === '') fail(out, path, `expected a non-empty string, got ${describe(v)}`);
  }
}

const familySpec: Spec = (v, p, out) => {
  if (!isPlainObject(v)) fail(out, p, `expected an object, got ${describe(v)}`);
};

const resultsSpec: Spec = (v, p, out) => {
  obj({
    required: { schema: lit('results/1') },
    optional: Object.fromEntries(RESULTS_FAMILIES.map((f) => [f, familySpec])),
    open: true,
  })(v, p, out);
  if (!isPlainObject(v)) return;
  const typed = { ...RESULTS_POST_KEYS, ...RESULTS_EXTRA_KEYS };
  for (const [key, type] of Object.entries(typed)) {
    const value = getResultsValue(v, key);
    // null is reported by listPostKeyProblems: article fails on it (spec 8.6), the file may hold it.
    if (value !== undefined && value !== null) checkTyped(type, value, key, out);
  }
  const verdict = getResultsValue(v, 'gate.verdict');
  if (verdict !== undefined && !(GATE_VERDICT_WORDS as readonly unknown[]).includes(verdict)) {
    fail(out, 'gate.verdict', `expected PASS, BETWEEN, KILL or NOT EVALUABLE, got ${describe(verdict)}`);
  }
  const plans = getResultsValue(v, 'commits.plans');
  if (plans !== undefined) {
    if (!isPlainObject(plans)) fail(out, 'commits.plans', `expected an object of plan id -> fate, got ${describe(plans)}`);
    else {
      for (const [id, fate] of Object.entries(plans)) {
        if (!(PLAN_FATES as readonly unknown[]).includes(fate)) fail(out, `commits.plans.${id}`, `expected used, voided, aborted or unused, got ${describe(fate)}`);
      }
    }
  }
  // Any other number under an ms or dB key is a report value too (spec 8.1).
  const walk = (x: unknown, path: string, inMs: boolean): void => {
    if (typeof x === 'number') {
      if (inMs && !Object.hasOwn(typed, path) && Number.isFinite(x) && !isRound1(x)) {
        fail(out, path, `expected a report value rounded to 0.1 (spec 8.1), got ${x}`);
      }
    } else if (Array.isArray(x)) x.forEach((y, i) => walk(y, `${path}[${i}]`, inMs));
    else if (isPlainObject(x)) for (const [k, y] of Object.entries(x)) walk(y, path === '' ? k : `${path}.${k}`, inMs || isMsOrDbKey(k));
  };
  walk(v, '', false);
  const used = getResultsValue(v, 'sessions.chance_used_pct');
  const three = ['sessions.chance_poisson_pct', 'sessions.chance_shift_pct', 'sessions.chance_pseudo_pct'].map((k) => getResultsValue(v, k));
  if (typeof used === 'number' && three.every((x) => typeof x === 'number')) {
    const largest = Math.max(...(three as number[]));
    if (Math.abs(used - largest) > 1e-9) fail(out, 'sessions.chance_used_pct', `must be the largest of the three estimates, ${largest} (spec 8.6)`);
  }
  ledgerHeadsProblems(getResultsValue(v, LEDGER_HEADS_KEY), out);
  for (const [total, parts, why] of RESULTS_SUMS) {
    // Only whole counts: a value of the wrong type is reported by its own check above.
    const t = getResultsValue(v, total);
    const xs = parts.map((k) => getResultsValue(v, k));
    const isCount = (x: unknown): x is number => typeof x === 'number' && Number.isSafeInteger(x) && x >= 0;
    if (!isCount(t) || !xs.every(isCount)) continue;
    const sum = xs.reduce((a, b) => a + b, 0);
    if (sum === t) continue;
    if (parts.length === 1) fail(out, parts[0] as string, `${sum} must equal ${total}, ${t}: ${why}`);
    else fail(out, total, `${t} must equal ${parts.join(' + ')} = ${xs.join(' + ')} = ${sum}: ${why}`);
  }
};

function ledgerHeadsProblems(heads: unknown, out: string[]): void {
  if (heads === undefined) return;
  if (!isPlainObject(heads)) {
    fail(out, LEDGER_HEADS_KEY, `expected an object of session id -> SHA-256 of the last ledger line, got ${describe(heads)}`);
    return;
  }
  for (const [id, h] of Object.entries(heads)) {
    if (!SESSION_ID.test(id)) fail(out, LEDGER_HEADS_KEY, `${describe(id)} is not a session id like "s1"`);
    else if (typeof h !== 'string' || !HEX64.test(h)) fail(out, `${LEDGER_HEADS_KEY}.${id}`, `expected a SHA-256 as 64 lowercase hex characters, got ${describe(h)}`);
  }
}

export const validateResults: Validator<Results> = makeValidator(resultsSpec);

/**
 * Post keys the article cannot fill: missing or null (spec 8.6: npm run article fails on
 * both). Optional keys are skipped.
 */
export function listPostKeyProblems(results: unknown): string[] {
  const problems: string[] = [];
  for (const key of Object.keys(RESULTS_POST_KEYS)) {
    if (RESULTS_OPTIONAL_POST_KEYS.includes(key)) continue;
    const v = getResultsValue(results, key);
    if (v === undefined) problems.push(`${key}: missing`);
    else if (v === null) problems.push(`${key}: null`);
  }
  return problems;
}
