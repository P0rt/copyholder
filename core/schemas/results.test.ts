// results/results.json (spec 8.6): the 83 post keys by family, missing and null keys the
// article cannot fill, value types, report precision and the chance level rule.
import { describe, expect, it } from 'vitest';
import {
  LEDGER_HEADS_KEY, RESULTS_EXTRA_KEYS, RESULTS_FAMILIES, RESULTS_OPTIONAL_POST_KEYS, RESULTS_POST_KEYS, RESULTS_SUMS,
  getResultsValue, listPostKeyProblems, validateResults, type Results,
} from './index.ts';
import { exampleResults } from './examples.ts';

/** Sets a dotted key in a results object. */
function setKey(r: Results, dotted: string, value: unknown): Results {
  const parts = dotted.split('.');
  let cur = r as Record<string, unknown>;
  for (const p of parts.slice(0, -1)) cur = cur[p] as Record<string, unknown>;
  cur[parts[parts.length - 1] as string] = value;
  return r;
}

describe('results.json post keys (spec 8.6 table)', () => {
  it('has the 83 substitutions of the article template, family by family', () => {
    const keys = Object.keys(RESULTS_POST_KEYS);
    expect(keys).toHaveLength(83);
    const perFamily: Record<string, number> = {};
    for (const k of keys) {
      const family = k.split('.')[0] as string;
      expect(RESULTS_FAMILIES).toContain(family);
      perFamily[family] = (perFamily[family] ?? 0) + 1;
    }
    expect(perFamily).toEqual({
      sessions: 28, planted: 16, review: 1, rivals: 11, paired: 8, gate: 3, timing: 6, setup: 6, detector: 1, commits: 3,
    });
    // The keys kept for checks are not post keys.
    for (const k of Object.keys(RESULTS_EXTRA_KEYS)) expect(keys).not.toContain(k);
  });

  it('the complete example fills every post key; the spec example validates too (spec-examples.test.ts)', () => {
    expect(validateResults(exampleResults())).toEqual([]);
    expect(listPostKeyProblems(exampleResults())).toEqual([]);
  });

  it('npm run article fails on a missing key and on null (spec 8.6)', () => {
    const r = exampleResults();
    delete (r['sessions'] as Record<string, unknown>)['hits'];
    setKey(r, 'timing.sniff_n', null);
    expect(listPostKeyProblems(r)).toEqual(['sessions.hits: missing', 'timing.sniff_n: null']);
    // The file itself may hold null: only the article refuses it.
    expect(validateResults(r)).toEqual([]);
  });

  it('head motion first may be absent when rival M is cut (spec 8.6, 14.4)', () => {
    expect(RESULTS_OPTIONAL_POST_KEYS).toEqual(['sessions.hits_with_head_motion_first']);
    const r = exampleResults();
    delete (r['sessions'] as Record<string, unknown>)['hits_with_head_motion_first'];
    expect(listPostKeyProblems(r)).toEqual([]);
  });

  it('checks each known key by type: counts, numbers, ms rounded to 0.1, strings', () => {
    const r = exampleResults();
    setKey(r, 'sessions.hits', 5.5);
    setKey(r, 'timing.L_rt_min_ms', 23.14);
    setKey(r, 'setup.camera', '');
    setKey(r, 'detector.k', 'two');
    setKey(r, 'gate.chest_vs_lips.lead_diff_ms_median', 41.25);
    expect(validateResults(r)).toEqual([
      'sessions.hits: expected a count (non-negative integer), got 5.5',
      'timing.L_rt_min_ms: expected a report value rounded to 0.1 (spec 8.1), got 23.14',
      'setup.camera: expected a non-empty string, got ""',
      'detector.k: expected a finite number, got "two"',
      'gate.chest_vs_lips.lead_diff_ms_median: expected a report value rounded to 0.1 (spec 8.1), got 41.25',
    ]);
  });

  it('any other ms value in the file is a report value too (spec 8.1)', () => {
    const r = exampleResults();
    setKey(r, 'sessions.by_session', [{ id: 's1', lead_ms_median_hits: 231.04, habituation_slope: 0.123456 }]);
    expect(validateResults(r)).toEqual([
      'sessions.by_session[0].lead_ms_median_hits: expected a report value rounded to 0.1 (spec 8.1), got 231.04',
    ]);
  });

  it('chance_used_pct is the largest of the three estimates (spec 8.6)', () => {
    const r = setKey(exampleResults(), 'sessions.chance_used_pct', 6.2);
    expect(validateResults(r)).toEqual(['sessions.chance_used_pct: must be the largest of the three estimates, 7.4 (spec 8.6)']);
  });

  it('gate.verdict and the plan fates take their fixed words (spec 8.4, 9.7)', () => {
    const r = exampleResults();
    setKey(r, 'gate.verdict', 'MAYBE');
    setKey(r, 'commits.plans', { s1: 'used', s2: 'lost', r1: 'voided', k1: 'aborted' });
    expect(validateResults(r)).toEqual([
      'gate.verdict: expected PASS, BETWEEN, KILL or NOT EVALUABLE, got "MAYBE"',
      'commits.plans.s2: expected used, voided, aborted or unused, got "lost"',
    ]);
  });

  it('counts agree across families: matched = caught = pairs, hits + misses, the miss groups, the pair outcomes (spec 4.1, 4.4, 8.6)', () => {
    expect(RESULTS_SUMS.map(([total]) => total)).toEqual([
      'planted.caught', 'sessions.matched', 'sessions.matched', 'sessions.misses', 'paired.chest_vs_lips.n',
    ]);
    // The review probe: sessions.matched 99, planted.caught 17, paired n 3.
    const r = exampleResults();
    setKey(r, 'sessions.matched', 99);
    setKey(r, 'paired.chest_vs_lips.n', 3);
    expect(validateResults(r)).toEqual([
      'sessions.matched: 99 must equal planted.caught, 17: each caught error answers one matched objection (spec 8.6)',
      'paired.chest_vs_lips.n: 3 must equal sessions.matched, 99: one pair per objection of the main share (spec 4.4, 8.6)',
      'sessions.matched: 99 must equal sessions.hits + sessions.misses = 5 + 12 = 17: a matched objection without a stop before the voice is a miss, a late stop too (spec 4.2, 8.6)',
      'paired.chest_vs_lips.n: 3 must equal paired.chest_vs_lips.wins + paired.chest_vs_lips.losses + paired.chest_vs_lips.ties = 7 + 4 + 6 = 17: every pair is a win, a loss or a tie (spec 7.10)',
    ]);
    const m = setKey(exampleResults(), 'sessions.misses_inbreath_present', 5);
    expect(validateResults(m)).toEqual([
      'sessions.misses: 12 must equal sessions.misses_no_inbreath + sessions.misses_inbreath_present = 8 + 5 = 13: misses fall into two groups by the audible in-breath (spec 4.1)',
    ]);
    // A count that is absent or of the wrong type skips its sum (the type check reports it).
    const partial = exampleResults();
    delete (partial['paired'] as Record<string, unknown>)['chest_vs_lips'];
    expect(validateResults(partial)).toEqual([]);
  });

  it('commits.ledger_heads holds the last-line hash of each ledger (spec 8.5)', () => {
    expect(LEDGER_HEADS_KEY).toBe('commits.ledger_heads');
    expect(getResultsValue(exampleResults(), 'commits.ledger_heads.k1')).toMatch(/^[0-9a-f]{64}$/);
    const r = setKey(exampleResults(), 'commits.ledger_heads', { s1: 'f'.repeat(64), s2: 'abc', 'S 3': 'f'.repeat(64) });
    expect(validateResults(r)).toEqual([
      'commits.ledger_heads.s2: expected a SHA-256 as 64 lowercase hex characters, got "abc"',
      'commits.ledger_heads: "S 3" is not a session id like "s1"',
    ]);
    expect(validateResults(setKey(exampleResults(), 'commits.ledger_heads', ['f'.repeat(64)]))).toEqual([
      'commits.ledger_heads: expected an object of session id -> SHA-256 of the last ledger line, got a list of 1',
    ]);
  });

  it('refuses another schema and a family that is not an object', () => {
    expect(validateResults({ ...exampleResults(), schema: 'results/2' })).toEqual(['schema: expected "results/1", got "results/2"']);
    expect(validateResults({ ...exampleResults(), gate: 'BETWEEN' })).toEqual(['gate: expected an object, got "BETWEEN"']);
  });

  it('getResultsValue reads dotted keys and returns undefined for absent ones', () => {
    const r = exampleResults();
    expect(getResultsValue(r, 'planted.by_class.negation.caught')).toBe(6);
    expect(getResultsValue(r, 'rivals.audio_250.delay_after_voice_ms')).toBe(281.5);
    expect(getResultsValue(r, 'planted.by_class.connective.caught')).toBeUndefined();
    expect(getResultsValue(null, 'gate.hits')).toBeUndefined();
  });
});
