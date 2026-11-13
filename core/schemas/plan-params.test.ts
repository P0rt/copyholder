// Sealed plan and seal text (spec 8.2, 8.3), freeze_manifest.json, params/frozen.json and
// scoring_rules.json (spec 8.4), the sealed timings.json and texts.json (spec 8.2).
import { describe, expect, it } from 'vitest';
import {
  K_GRID, THETA_G_GRID, formatSealScreen, paramsAreTuned, parseCommitmentText, sealGroups, validateFreezeManifest,
  validateFrozenParams, validateScoringRules, validateSealedPlan, validateTexts, validateTimings, type FrozenParams,
} from './index.ts';
import {
  EXAMPLE_SEAL, exampleFreezeManifest, exampleFrozenParams, exampleScoringRules, exampleSealedPlan, exampleTexts,
  exampleTimings,
} from './examples.ts';

describe('plan.json (sealed-plan/1, spec 8.3)', () => {
  it('accepts the opening and three passages with nine errors', () => {
    const plan = exampleSealedPlan();
    expect(validateSealedPlan(plan)).toEqual([]);
    expect(plan.errors).toHaveLength(9);
  });

  it('numbers in a plan are integers only, wherever they are', () => {
    const plan = exampleSealedPlan();
    const p0 = plan.passages[0];
    if (p0 === undefined) throw new Error('example has passages');
    p0.duration_ms = 75200.5;
    expect(validateSealedPlan(plan)).toEqual(['passages[0].duration_ms: expected an integer, got 75200.5']);
    expect(validateSealedPlan({ ...exampleSealedPlan(), hunter: { found: 2, score: 0.5 } })).toEqual([
      'hunter.score: plan numbers are integers only (spec 8.3), got 0.5',
    ]);
  });

  it('the opening has no errors and error counts add up', () => {
    const plan = exampleSealedPlan();
    const opening = plan.passages[0];
    if (opening === undefined) throw new Error('example has passages');
    opening.error_count = 1;
    expect(validateSealedPlan(plan)).toEqual([
      'the opening has no planted errors (spec 8.3)',
      'error_count adds up to 10, errors lists 9',
      'passage opening: error_count 1, errors lists 0',
    ]);
  });

  it('each error points into its sentence and into a listed passage', () => {
    const plan = exampleSealedPlan();
    const e0 = plan.errors[0];
    const e1 = plan.errors[1];
    if (e0 === undefined || e1 === undefined) throw new Error('example has errors');
    e0.original_span = '41';
    e1.passage_id = 'p4';
    e1.span_end_ms = e1.span_start_ms - 1;
    expect(validateSealedPlan(plan)).toEqual([
      'errors[0]: original_span is not original_sentence[char_start, char_end)',
      'errors[1]: span_end_ms must not be before span_start_ms',
    ]);
    e0.original_span = '40';
    e1.span_end_ms = e1.span_start_ms + 280;
    expect(validateSealedPlan(plan)).toEqual([
      'errors: s1-e2 names passage "p4" that is not in passages',
      'passage p1: error_count 3, errors lists 2',
    ]);
  });

  it('the salt is 32 random bytes in hex; ids are unique', () => {
    expect(validateSealedPlan({ ...exampleSealedPlan(), salt: '5b0e' })).toEqual([
      'salt: expected a SHA-256 as 64 lowercase hex characters, got "5b0e"',
    ]);
    const plan = exampleSealedPlan();
    const e1 = plan.errors[1];
    if (e1 === undefined) throw new Error('example has errors');
    e1.error_id = 's1-e1';
    expect(validateSealedPlan(plan)).toEqual(['errors: error_id "s1-e1" appears twice']);
  });
});

describe('the seal as text (spec 8.2, 8.3)', () => {
  it('formats the screen before narration as in the spec', () => {
    expect(formatSealScreen('s1', EXAMPLE_SEAL)).toBe(
      ['SEALED PLAN  s1', '9f2c41d7a05be318 6c0d2e9b17f4a853', '0b7e55c21d9a3f64 e81c07b2d4f6a935'].join('\n'),
    );
    expect(sealGroups(EXAMPLE_SEAL).join('')).toBe(EXAMPLE_SEAL);
    expect(() => sealGroups('9f2c')).toThrow(/64 lowercase hex/);
  });

  it('reads commitment.txt as host does: trimmed, lower case, optional sha256: prefix', () => {
    expect(parseCommitmentText(`${EXAMPLE_SEAL}\n`)).toBe(EXAMPLE_SEAL);
    expect(parseCommitmentText(`  sha256:${EXAMPLE_SEAL.toUpperCase()}\r\n`)).toBe(EXAMPLE_SEAL);
    expect(parseCommitmentText(EXAMPLE_SEAL.slice(1))).toBeNull();
    expect(parseCommitmentText(`${EXAMPLE_SEAL} ${EXAMPLE_SEAL}`)).toBeNull();
  });
});

describe('freeze_manifest.json (freeze/1, spec 8.4)', () => {
  it('accepts every sealed plan, needed or spare', () => {
    expect(validateFreezeManifest(exampleFreezeManifest())).toEqual([]);
  });

  it('pilot and rehearsal plans are not frozen; the fate of a plan goes to results.json', () => {
    const f = exampleFreezeManifest() as unknown as { plans: Record<string, unknown>[] };
    const first = f.plans[0];
    if (first === undefined) throw new Error('example has plans');
    first['role'] = 'pilot';
    first['state'] = 'used';
    expect(validateFreezeManifest(f)).toEqual([
      'plans[0].role: expected numbers, reserve, spacebar or demo (pilot and rehearsal plans are not frozen, spec 8.4), got "pilot"',
      'plans[0].state: expected "sealed", got "used"',
    ]);
  });

  it('ids and seals are unique; at most three demo plans (spec 15.3)', () => {
    const f = exampleFreezeManifest();
    const s1 = f.plans[0];
    if (s1 === undefined) throw new Error('example has plans');
    f.plans.push({ ...s1 }, { ...s1, id: 'demo-4', role: 'demo', plan_commitment: 'f'.repeat(64) });
    expect(validateFreezeManifest(f)).toEqual([
      'plans: id "s1" appears twice',
      'plans: plan_commitment of "s1" appears twice',
      'plans: 4 demo plans, at most 3 (spec 15.3)',
    ]);
    expect(validateFreezeManifest({ ...exampleFreezeManifest(), tag: 'freeze-2' })).toEqual(['tag: expected "freeze-1", got "freeze-2"']);
  });
});

describe('params/frozen.json (params/1, spec 8.4)', () => {
  it('accepts the tuned file, and the gate-prereg file without k and theta_G', () => {
    expect(validateFrozenParams(exampleFrozenParams())).toEqual([]);
    expect(paramsAreTuned(exampleFrozenParams())).toBe(true);
    const prereg: FrozenParams = exampleFrozenParams();
    delete prereg.d1.k;
    delete prereg.g.theta_G;
    delete prereg.tuned;
    expect(validateFrozenParams(prereg)).toEqual([]);
    expect(paramsAreTuned(prereg)).toBe(false);
  });

  it('k and theta_G come from their grids (spec 7.4, 7.5)', () => {
    expect(K_GRID).toEqual([1.5, 2, 2.5, 3, 3.5]);
    expect(THETA_G_GRID).toHaveLength(21);
    expect([THETA_G_GRID[0], THETA_G_GRID[7], THETA_G_GRID[20]]).toEqual([0.01, 0.0275, 0.06]);
    const p = exampleFrozenParams();
    p.d1.k = 2.2;
    p.g.theta_G = 0.0276;
    expect(validateFrozenParams(p)).toEqual([
      'd1.k: expected k from the grid 1.5, 2, 2.5, 3, 3.5 (spec 7.4), got 2.2',
      'g.theta_G: expected theta_G from the grid 0.010 to 0.060 in steps of 0.0025 (spec 7.5), got 0.0276',
    ]);
  });

  it('criterion not met at stage A means k = 3.5; tuned needs k (spec 7.4)', () => {
    const p = exampleFrozenParams();
    if (p.tuned === undefined) throw new Error('example is tuned');
    expect(p.tuned.k.step).toBe('stage_a');
    p.tuned.k.criterion_met = false;
    expect(validateFrozenParams(p)).toEqual(['d1.k must be 3.5 when stage A did not meet the criterion (spec 7.4)']);
    p.d1.k = 3.5;
    expect(validateFrozenParams(p)).toEqual([]);
    delete p.d1.k;
    expect(validateFrozenParams(p)).toEqual(['d1.k: missing although tuned says it was set']);
  });

  it('a retune lowers k from 3.5 to 3.0 with the criterion still not met (spec 9.8, step 1)', () => {
    const p = exampleFrozenParams();
    if (p.tuned === undefined) throw new Error('example is tuned');
    p.d1.k = 3.0;
    p.tuned.k = { step: 'retune', criterion_met: false, rehearsal_step_up: false };
    expect(validateFrozenParams(p)).toEqual([]);
    // The ladder is the retune code's business; the grid still holds.
    p.d1.k = 2.75;
    expect(validateFrozenParams(p)).toEqual(['d1.k: expected k from the grid 1.5, 2, 2.5, 3, 3.5 (spec 7.4), got 2.75']);
    p.d1.k = 2.5;
    p.tuned.k.step = 'rehearsal';
    expect(validateFrozenParams(p)).toEqual([]);
  });

  it('the fade is 384 samples everywhere; theta clamp low below high', () => {
    const p = exampleFrozenParams();
    p.hold.ramp_frames = 400;
    p.d1.theta_clamp = [3.0, 1.3];
    expect(validateFrozenParams(p)).toEqual([
      'd1.theta_clamp: low must be below high',
      'hold.ramp_frames: expected 384: nSilent = nCmd + 384 everywhere (spec 6.2), got 400',
    ]);
  });

  it('keeps the detector parameters beyond the example and the retune ladder values (spec 9.8)', () => {
    const p = exampleFrozenParams();
    Object.assign(p.d1, { L: 7, M: 3, gap_unusable_ms: 100, invalid_codes: [3, 4], d3: { early_k: 1 }, variant: 'D3' });
    if (p.tuned === undefined) throw new Error('example is tuned');
    p.tuned.k.step = 'retune';
    expect(validateFrozenParams({ ...p, variant: 'D3' })).toEqual([]);
    expect(validateFrozenParams({ ...p, variant: 'D2' })).toEqual(['variant: expected one of "D1", "D3", got "D2"']);
    p.tuned.k.step = 'stage_b';
    expect(validateFrozenParams(p)).toEqual(['tuned.k.step: expected "stage_a", "retune" or "rehearsal", got "stage_b"']);
  });
});

describe('scoring_rules.json (spec 8.4, 4.2)', () => {
  it('accepts the fixed values; the catch window may grow to 8000 ms in whole seconds', () => {
    expect(validateScoringRules(exampleScoringRules())).toEqual([]);
    expect(validateScoringRules({ ...exampleScoringRules(), catch_close_after_span_end_ms: 7000, schema: 'scoring-rules/1', notes: ['clarified'] })).toEqual([]);
    for (const bad of [4000, 5500, 9000]) {
      expect(validateScoringRules({ ...exampleScoringRules(), catch_close_after_span_end_ms: bad })).toEqual([
        `catch_close_after_span_end_ms: expected 5000, 6000, 7000 or 8000 (spec 4.2), got ${bad}`,
      ]);
    }
  });

  it('refuses a changed fixed value and unknown fields', () => {
    expect(validateScoringRules({ ...exampleScoringRules(), W_ms: 1000, content_window_ms: 1 })).toEqual([
      'W_ms: expected 1500, got 1000',
      'content_window_ms: unexpected field',
    ]);
  });
});

describe('timings.json and texts.json (spec 8.2)', () => {
  it('accepts the tools/tts layout', () => {
    expect(validateTimings(exampleTimings())).toEqual([]);
    expect(validateTexts(exampleTexts())).toEqual([]);
  });

  it('timings carry no text', () => {
    const t = exampleTimings() as unknown as { words: Record<string, unknown>[] };
    const w = t.words[0];
    if (w === undefined) throw new Error('example has words');
    w['word'] = 'It';
    expect(validateTimings(t)).toEqual(['words[0].word: not allowed: timings carry no text (spec 8.2)']);
  });

  it('words in order, counts and duration agree', () => {
    const t = exampleTimings();
    const [w0, w1, , w3] = t.words;
    if (w0 === undefined || w1 === undefined || w3 === undefined) throw new Error('example has 4 words');
    w1.startMs = 300;
    w3.sentenceIndex = 3;
    expect(validateTimings({ ...t, wordCount: 5, durationMs: 2001 })).toEqual([
      'wordCount is 5 but 4 words are listed',
      'durationMs 2001 does not match 96000 samples (2000 ms)',
      'words[1]: starts at 300 ms, before the previous word ends at 350 ms',
      'words[3]: jumps from sentence 1 to 3',
      'sentenceCount is 2 but the last word is in sentence 3',
    ]);
    expect(validateTimings({ ...exampleTimings(), sampleRateHz: 44100 })).toEqual(['sampleRateHz: expected 48000, got 44100']);
  });

  it('texts.json needs both versions of each passage', () => {
    expect(validateTexts({ schema: 'texts/1', session_id: 's1', passages: [{ passage_id: 'p1', original: 'x' }] })).toEqual([
      'passages[0].planted: missing',
    ]);
  });
});
