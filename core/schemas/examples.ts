// Complete, valid examples of every file format of spec section 8, built from the spec
// examples (the spec shows only part of some files). Values are made up: they show the form,
// not a forecast (spec 8). Every function returns a fresh copy, so tests may change it.

import type { Manifest, StampLine, SampleLine, DetectorInLine, EventLine } from './session.ts';
import type { Calib, ClockReport, Onsets, Quickcheck, Review, Verdict } from './reports.ts';
import type { FrozenParams, ScoringRules } from './params.ts';
import type { FreezeManifest, PlanError, SealedPlan, Texts, Timings } from './plan.ts';
import type { Receipt } from './receipt.ts';
import type { Results } from './results.ts';
import type { AudioEnv, PlantedTimes, SentenceEnds, StreamLine } from './published.ts';
import type { LedgerLine } from './ledger.ts';

/** The seal of the spec 8.3 screen example. */
export const EXAMPLE_SEAL = '9f2c41d7a05be3186c0d2e9b17f4a8530b7e55c21d9a3f64e81c07b2d4f6a935';

/** A distinct SHA-256-looking value per letter: hex('a') = 'aaaa…' (64 characters). */
export function exampleHex(c: string): string {
  return c.repeat(64).slice(0, 64);
}

export function exampleManifest(): Manifest {
  return {
    schema: 'session/1',
    id: 's1',
    kind: 'numbers',
    started_utc: '2026-11-17T17:02:11Z',
    app_commit: '3f2c9ab',
    tree_clean: true,
    plan_commitment: EXAMPLE_SEAL,
    sdk: { version: '3.5.0', metrics: ['CHEST_BREATHING', 'BREATHING_RATE', 'FACE_LANDMARKS', 'TALKING'], launcher: 'node' },
    machine: 'MacBook Pro (14-inch, M3)',
    camera: { name: 'FaceTime HD Camera', requested: [1280, 720, 30] },
    audio: { microphone: 'USB Headset Microphone', sample_rate: 48000, mic_flags_off: true, output_gain: 0.35 },
    files: { 'audio.wav': `sha256:${exampleHex('1')}`, 'detector_in.jsonl': `sha256:${exampleHex('2')}` },
  };
}

/** One stamps.jsonl line per kind k (spec 8.1 example). */
export function exampleStamps(): StampLine[] {
  return [
    { n: 0, k: 'chunk', frames: 9600 },
    { n: 384000, k: 'click', i: 3 },
    { n: 2880000, k: 'mark', what: 'step', name: 'opening' },
    { n: 8640000, k: 'arr', seq: 5417 },
    { n: 8640000, k: 'hold', cause: 'chest', seq: 5417, nSilent: 8640384, word: 57 },
    { n: 8640000, k: 'state', s: 'hold_wait' },
    { n: 8659200, k: 'voice', on: true },
    { n: 8774400, k: 'resume', word: 57 },
    { n: 8790000, k: 'ignored', what: 'hold', seq: 5431, s: 'listening' },
  ];
}

/** 16 face points [x, y] in the order of LANDMARK_IDS (spec 8.1 shows two). */
export function exampleLandmarkPoints(): [number, number][] {
  return Array.from({ length: 16 }, (_, i): [number, number] => [640.2 + i * 1.5, 402.1 + i * 2.25]);
}

/** samples.jsonl: a packet with all 16 points, a validation status and a loop-delay line. */
export function exampleSamples(): SampleLine[] {
  return [
    {
      seq: 5417,
      k: 'm',
      tArrNs: '812345678901234',
      tsCbUs: 1794935111156789,
      tr: [[1794935111123456, -0.4000000059604645]],
      talk: [[1794935111123456, 0]],
      g: 0.031746031746031744,
      hm: 0.0021,
      lm: { ts: 1794935111123456, reset: 0, p: exampleLandmarkPoints() },
    },
    { seq: 5418, k: 'v', tArrNs: '812345712345678', tsCbUs: 1794935111190000, code: 0, name: 'kOk' },
    { k: 'l', tArrNs: '812346000000000', p50Ms: 0.4, p99Ms: 3.1, maxMs: 4.2 },
  ];
}

export function exampleDetectorIn(): DetectorInLine[] {
  return [
    { k: 'batch', seq: 5417, tr: [[1794935111123456, -0.4000000059604645]], talk: [[1794935111123456, 0]], g: 0.031746031746031744, hm: 0.0021 },
    { k: 'val', seq: 5418, code: 0 },
    { k: 'voice', n: 8659200, on: true },
    { k: 'state', n: 8659200, s: 'listening' },
  ];
}

/** stream.jsonl of exampleDetectorIn with the arr stamp of exampleStamps (spec 8.7). */
export function exampleStream(): StreamLine[] {
  return [
    { k: 'batch', seq: 5417, nArr: 8640000, tr: [[1794935111123456, -0.4000000059604645]], talk: [[1794935111123456, 0]], g: 0.031746031746031744, hm: 0.0021 },
    { k: 'val', seq: 5418, code: 0 },
    { k: 'voice', n: 8659200, on: true },
    { k: 'state', n: 8659200, s: 'listening' },
  ];
}

export function exampleEvents(): EventLine[] {
  return [
    { n: 8640000, e: 'fire', det: 'D1', seq: 5417, v: 2.3125, theta: 1.875 },
    { n: 8640000, e: 'hold', cause: 'chest', nCmd: 8640000, nSilent: 8640384, word: 57 },
    { n: 8774400, e: 'resume', word: 57, why: 'voice_off' },
    { n: 8966400, e: 'armed', det: 'D1', on: true },
  ];
}

/** calib.json of the day-1 gate (spec 8.1 example, with the count of sniffs without an arrival of PREREG §4). */
export function exampleCalib(): Calib {
  return {
    schema: 'calib/1',
    L_rt_ms: { A: 23.4, B: 23.6, spread: [0.3, 0.2], rule: 'mean', used: 23.5 },
    polarity: { sign: 1, breaths_agree: 3 },
    A_ref: 0.84,
    camera_clock: { offset_ms: [41, 47], slope_ppm: 38, ok: true },
    sniff_lag_ms: { n: 5, no_arrival: 0, lo_median: 148, hi_median: 171.5, median_over_ms: null },
    leak_db_over_floor: 2.9,
    output_gain: 0.35,
  };
}

/** quickcheck.json of a good day-1 gate recording (layout: assumption, spec 7.12). */
export function exampleQuickcheck(): Quickcheck {
  return {
    schema: 'quickcheck/1',
    id: 'gate-a',
    kind: 'gate',
    result: 'GOOD RECORDING',
    reasons: [],
    technical: null,
    checks: [
      { name: 'audio_continuous', ok: true, hard: true },
      { name: 'loop_checks', ok: true, hard: true, value: 0.2, limit: 15 },
      { name: 'cues_marked', ok: true, hard: true, value: 14, limit: 14 },
      { name: 'trace_rate', ok: true, hard: true, value: 29.7, limit: 25 },
      { name: 'no_sdk_error', ok: true, hard: true, value: 0 },
      { name: 'voice_after_cues', ok: true, hard: true, value: 13, limit: 12 },
      { name: 'pa_bursts', ok: true, hard: true, value: '5/5, 5/5' },
      { name: 'sniffs', ok: true, hard: true, value: 5, limit: 4 },
      { name: 'polarity', ok: true, hard: true, value: 1 },
      { name: 'mic_flags_off', ok: true, hard: true },
      { name: 'sample_rate', ok: true, hard: true, value: 48000 },
      { name: 'no_hard_window_events', ok: true, hard: true, value: 0 },
      { name: 'not_sent_share', ok: true, hard: false, value: 0.004 },
      { name: 'tap_loop_delay', ok: true, hard: false, value: 3.1 },
      { name: 'status_ok_share', ok: true, hard: false, value: 0.97 },
    ],
  };
}

export function exampleClockReport(): ClockReport {
  return {
    schema: 'clock-report/1',
    audio_valid: true,
    trace_valid: true,
    chain: { L_rt_ms: [23.4, 23.6], spread_ms: [0.3, 0.2], quantum_ms: 2.7, stops: 11, stops_match_ch1: 11, nCmd_minus_nArr: 0 },
    onset: { p90_abs_auto_minus_manual_ms: 12.5, events: 8, soft_first_sounds: 5 },
    hard: {
      chunks_contiguous: true, sample_rate: 48000, mic_flags_off: true, device_events: 0, visibility_events: 0,
      trace_rate_median: 29.7, sdk_errors: 0, tap_lost: 0,
    },
    warn: { not_sent_share: 0.004, tap_loop_p99_ms: 3.1, status_ok_share: 0.97, window_warnings: 0 },
  };
}

export function exampleOnsets(): Onsets {
  return {
    schema: 'onsets/1',
    labels_sha256: exampleHex('0'),
    events: [
      {
        id: 'o07',
        kind: 'objection',
        label: 'speech',
        voiced_ms: 640,
        floor_db: -57.9,
        auto: { n_v: 8656704, n_a: 8657664, breath: [8626560, 8651424], flags: [] },
        manual: { n_v: 8656944, blind: true },
      },
      {
        id: 'o08',
        kind: 'continuation',
        label: 'speech',
        voiced_ms: 1210.5,
        floor_db: -58.1,
        auto: { n_v: 9312000, n_a: 9313440, breath: null, flags: ['no_dip'] },
        manual: { n_v: 9312240, blind: true },
      },
    ],
  };
}

/** verdict.json of stage B, run 1 (spec 9.6, 9.7): the values of the results.json example. */
export function exampleVerdict(): Verdict {
  return {
    schema: 'verdict/1',
    id: 'gate-a',
    pack: 'A',
    run: 1,
    exploratory: false,
    params_sha256: exampleHex('7'),
    clock: { L_rt_ms: [23.4, 23.6], diff_ms: 0.2, rule: 'mean', onset_p90_ms: 12.5 },
    tuning: { k: 2.5, criterion_met: true, theta_G: 0.0275 },
    events: { cued: 14, valid: 13, armed: 12, audible_inbreath: 9 },
    rows: {
      hits: { outcome: 'BETWEEN', hits: 6, armed_hits: 6, leads_0_50: 1 },
      lead: { outcome: 'PASS', median_hits_ms: 230, median_all_stops_ms: 180.5 },
      false_holds: { outcome: 'PASS', per_min: 1.2, armed_min: 5.8, in_sample_chest_per_min: 0.9, in_sample_lips_per_min: 0.7 },
      sniff_lag: {
        outcome: 'BETWEEN', lo_median_ms: 148, hi_median_ms: 171.5, median_over_ms: null, n: 5, no_arrival: 0,
        best_case_ms: 148, d1_on_sniffs_ms: 205.5,
      },
      chest_vs_lips: {
        outcome: 'PASS', wins: 7, losses: 4, ties: 2, both_before_n: 5, lead_diff_ms_median: 41.5,
        chest_false_per_min: 1.2, lips_false_per_min: 0.9, exploratory_equal_rate: { wins: 6, losses: 5 },
      },
    },
    misses: { no_inbreath: 4, inbreath_audible: 3 },
    other: { talking_flag_hits: 1, head_motion_hits: 2 },
    manual_changes: [],
    verdict: 'BETWEEN',
  };
}

export function exampleReview(): Review {
  return {
    schema: 'review/1',
    id: 's1',
    items: [
      { n_on: 8656704, n_off: 8687424, label: 'real_error' },
      { n_on: 9312000, n_off: 9370080, label: 'unclear' },
    ],
  };
}

export function exampleFrozenParams(): FrozenParams {
  return {
    schema: 'params/1',
    d1: {
      grid_hz: 30, L: 5, M: 2, k: 2.5, theta_clamp: [1.3, 3.0], min_rise_A: 0.15, min_rise_ms: 200, arm_breaths: 10,
      refractory_ms: 2000, rearm_ms: 4000,
    },
    hold: { H_ms: 1500, ramp_frames: 384, audio_pause_ms: 250 },
    g: { theta_G: 0.0275, frames: 2, baseline_s: 10 },
    vad: { highpass_hz: 150, hop_ms: 5, over_floor_db: 15, periodicity: 0.5, on_ms: [30, 50], off_ms: 1200 },
    tuned: { k: { step: 'stage_a', criterion_met: true, rehearsal_step_up: false }, theta_G: { step: 'stage_a' } },
  };
}

/** scoring_rules.json (spec 8.4 values). */
export function exampleScoringRules(): ScoringRules {
  return {
    catch_open_after_span_start_ms: 200,
    catch_close_after_span_end_ms: 5000,
    late_close_after_span_end_ms: 12000,
    objection_merge_gap_ms: 1000,
    min_voiced_ms: 250,
    min_gap_ms: 4000,
    W_ms: 1500,
  };
}

/** The spec 8.3 error, as error `index` (0-8) of passage p1..p3, three per passage. */
function examplePlanError(index: number): PlanError {
  const passage = `p${Math.floor(index / 3) + 1}`;
  const shift = (index % 3) * 30000;
  return {
    error_id: `s1-e${index + 1}`,
    passage_id: passage,
    sentence_index: 4 + (index % 3) * 6,
    class_requested: 'number',
    class_planted: 'number',
    original_sentence: 'It took about 40 minutes.',
    planted_sentence: 'It took about 4 minutes.',
    original_span: '40',
    replacement: '4',
    char_start: 14,
    char_end: 16,
    word_start: 3,
    word_end: 3,
    span_start_ms: 21340 + shift,
    span_end_ms: 21620 + shift,
    sentence_end_ms: 22410 + shift,
    wrong_at_span: true,
    attempts: 2,
    judge: { relation: 'contradiction', more_likely_original_correct: 'yes' },
  };
}

/** plan.json (sealed-plan/1): the opening and three passages, nine errors (spec 8.3). */
export function exampleSealedPlan(): SealedPlan {
  const passage = (id: string, n: number, errors: number) => ({
    passage_id: id,
    original_text_sha256: exampleHex(String(n)),
    planted_text_sha256: exampleHex(String(n + 4)),
    audio_sha256: exampleHex('abcd'[n] ?? 'f'),
    duration_ms: id === 'opening' ? 75200 : 110400,
    word_count: id === 'opening' ? 194 : 286,
    error_count: errors,
  });
  return {
    schema: 'sealed-plan/1',
    session_id: 's1',
    salt: `5b0e${'3'.repeat(60)}`,
    created_utc: '2026-11-16T20:12:40Z',
    draft: { sha256: `c1a7${'9'.repeat(60)}`, word_count: 1184, days_since_last_read: 21 },
    planter: {
      master_seed: 1839201177,
      proposer_model: 'gemma3:12b',
      proposer_digest: `sha256:${exampleHex('e')}`,
      judge_model: 'gemma3:12b',
      judge_digest: `sha256:${exampleHex('e')}`,
      ollama_version: '0.12.6',
      params_sha256: exampleHex('5'),
      prompts_sha256: exampleHex('6'),
    },
    narrator: { engine: 'kokoro-82m', voice: 'af_heart', nominal_wpm: 155, measured_wpm_x10: 1524, licence: 'Apache-2.0' },
    passages: [passage('opening', 0, 0), passage('p1', 1, 3), passage('p2', 2, 3), passage('p3', 3, 3)],
    errors: Array.from({ length: 9 }, (_, i) => examplePlanError(i)),
  };
}

/** freeze_manifest.json with every plan of spec 8.4. */
export function exampleFreezeManifest(): FreezeManifest {
  const ids: [string, FreezeManifest['plans'][number]['role']][] = [
    ['s1', 'numbers'], ['s2', 'numbers'], ['s3', 'numbers'], ['r1', 'reserve'], ['k1', 'spacebar'],
    ['demo-1', 'demo'], ['demo-2', 'demo'], ['demo-3', 'demo'],
  ];
  return {
    schema: 'freeze/1',
    tag: 'freeze-1',
    prereg_sha256: exampleHex('4'),
    params_sha256: `77c0${'1'.repeat(60)}`,
    scoring_rules_sha256: `a41d${'2'.repeat(60)}`,
    prompts_sha256: exampleHex('6'),
    planter: { model: 'gemma3:12b', digest: `sha256:${exampleHex('e')}`, ollama_version: '0.12.6' },
    plans: ids.map(([id, role], i) => ({
      id,
      role,
      plan_commitment: i === 0 ? EXAMPLE_SEAL : `${i.toString(16)}${'c'.repeat(63)}`,
      draft_sha256: i === 0 ? `c1a7${'9'.repeat(60)}` : `${i.toString(16)}${'d'.repeat(63)}`,
      audio_sha256: [exampleHex('a'), exampleHex('b'), exampleHex('c'), exampleHex('d')],
      state: 'sealed' as const,
    })),
  };
}

/** receipt.json of a numbers session with the camera (spec 8.6, 7.9). */
export function exampleReceipt(): Receipt {
  const outcome = ['caught', 'caught', 'missed', 'caught', 'caught_late', 'caught', 'missed', 'caught', 'missed'] as const;
  return {
    schema: 'receipt/1',
    id: 's1',
    mode: 'live_camera',
    commitments: {
      plan_commitment: EXAMPLE_SEAL,
      plan_verified: true,
      freeze_commit: '9d41e07',
      analysis_commit: '9d41e07',
      detector_params_sha256: `77c0${'1'.repeat(60)}`,
      scoring_rules_sha256: `a41d${'2'.repeat(60)}`,
      onset_labels_sha256: exampleHex('0'),
      review_labels_sha256: exampleHex('8'),
      ledger_head: exampleHex('9'),
      working_tree_clean: true,
      revealed_utc: '2026-11-18T20:40:00Z',
    },
    clock: { L_rt_ms: [23.4, 23.6], rule: 'mean', onset_p90_ms: 12.5, audio_valid: true, trace_valid: true },
    narration: { passages: 4, narration_ms: 406400, measured_wpm_x10: 1524, days_since_last_read: 21 },
    planted: {
      planted: 9,
      presented: 9,
      caught: 5,
      caught_late: 1,
      missed: 3,
      share: 5 / 9,
      wilson95: [0.267, 0.811],
      by_class: { negation: { presented: 3, caught: 2 }, number: { presented: 2, caught: 1 }, referent: { presented: 2, caught: 1 }, sense: { presented: 2, caught: 1 } },
      events: outcome.map((o, i) => ({
        error_id: `s1-e${i + 1}`,
        class: (['negation', 'number', 'referent', 'sense'] as const)[i % 4] ?? 'negation',
        outcome: o,
        interrupted: i === 3,
        response_delay_ms: o === 'missed' ? null : 1420.5 + i,
        lead_ms: o === 'caught' && i < 2 ? 230.5 : null,
      })),
    },
    objections: { total: 8, matched: 5, continuations: 1, non_speech: 1, no_signal: 1, matched_no_signal: 0, audible_inbreath: 4 },
    stops: {
      primary_n: 5, primary_hits: 2, signal_only_hits: 2, hits_lead_under_300: 1, hits_all: 2, leads_0_50: 0, late: 1,
      missed_no_inbreath: 2, missed_inbreath: 1, median_lead_ms: 230.5, lead_interval_ms: [120, 410.5],
      median_lead_all_stops_ms: 180, audio_pause_stops: 3,
    },
    chance: {
      false_holds: 5, active_min: 4.4, per_min: 1.1, p0_poisson_upper: 0.074, p0_shift: 0.05, p0_pseudo: 0.061,
      p0_used: 0.074, r_prompt: 0.2,
    },
    review: {
      unplanted_finds: 1,
      false_alarms: 0,
      unclear: 1,
      reviewed_before_reveal: true,
      items: [
        { n_on: 8656704, n_off: 8687424, label: 'real_error', in_window: true },
        { n_on: 12000000, n_off: 12048000, label: 'real_error', in_window: false },
        { n_on: 9312000, n_off: 9370080, label: 'unclear', in_window: null },
      ],
    },
    rivals: {
      G: { hits: 1, median_lead_ms: 150.5, false_per_min: 0.9 },
      T: { hits: 0, median_lead_ms: null, false_per_min: 0.2 },
      M: { hits: 1, median_lead_ms: 90, false_per_min: 0.5 },
      A100: { hits: 0, median_lead_ms: -131.5, false_per_min: 0 },
      A250: { hits: 0, median_lead_ms: -281.5, false_per_min: 0 },
      A500: { hits: 0, median_lead_ms: -531.5, false_per_min: 0 },
    },
    scoring_rules: exampleScoringRules(),
  };
}

/** receipt.json of the space-bar block: no camera, so stops, chance and rivals are null (spec 8.6). */
export function exampleSpacebarReceipt(): Receipt {
  const r = exampleReceipt();
  return {
    ...r,
    id: 'k1',
    mode: 'no_camera_spacebar',
    clock: { ...r.clock, trace_valid: null },
    stops: null,
    chance: null,
    rivals: null,
    key: {
      presses: 9,
      span_onset_to_stop_ms_median: 980,
      outside_windows_per_min: 0.3,
      lead_K_ms_median: 410.5,
      lead_K_label: 'pressed, then spoke',
      spoke_without_pressing: 1,
    },
  };
}

/** results.json with all 83 post keys and the keys kept for checks (spec 8.6). */
export function exampleResults(): Results {
  return {
    schema: 'results/1',
    commits: {
      gate_prereg_short: '1a2b3c4',
      freeze_1_short: '9d41e07',
      params_sha256_short: '77c0a1b2',
      plans: { s1: 'used', s2: 'used', s3: 'used', r1: 'unused', k1: 'used', 'demo-1': 'used', 'demo-2': 'unused', 'demo-3': 'unused' },
      ledger_heads: { s1: exampleHex('1'), s2: exampleHex('2'), s3: exampleHex('3'), k1: exampleHex('4') },
    },
    setup: {
      sdk_version: '3.5.0', machine: 'MacBook Pro (14-inch, M3)', camera: 'FaceTime HD Camera', planter_model: 'gemma3:12b',
      narrator: 'Kokoro-82M, af_heart', min_days_since_last_read: 16,
    },
    timing: { L_rt_min_ms: 23.1, L_rt_max_ms: 24.0, sniff_n: 5, sniff_lag_lo_ms: 148, sniff_lag_hi_ms: 171.5, onset_abs_diff_p90_ms: 12.5 },
    gate: {
      verdict: 'BETWEEN', valid: 13, hits: 6, lead_ms_median_hits: 230, false_holds_per_min: 1.2,
      chest_vs_lips: { wins: 7, losses: 4, ties: 2, both_before_n: 5, lead_diff_ms_median: 41.5 },
    },
    sessions: {
      count: 3, objections: 21, matched: 17, hits: 5, misses: 12, misses_no_inbreath: 8, misses_inbreath_present: 4,
      wilson_low_pct: 13, wilson_high_pct: 53, chance_used_pct: 7.4, chance_poisson_pct: 7.4, chance_shift_pct: 5.1,
      chance_pseudo_pct: 6.2, false_holds: 14, active_min: 13.2, false_holds_per_min: 1.1, audible_inbreath: 9,
      chest_stops_outside_windows: 10, chest_stops_outside_windows_then_speech: 2, hits_all_objections: 6,
      hits_lead_under_300: 3, hits_with_head_motion_first: 1, lead_ms_ci_low: 120, lead_ms_ci_high: 410.5,
      lead_ms_median_hits: 230.5, leads_0_50: 1, narration_min: 28.6, p_binomial: 0.031, signal_only_hits: 5,
      signal_only_n: 16, voice_stops: 7,
    },
    planted: {
      total: 27, presented: 27, caught: 17, caught_late: 2, per_session: 9, share_pct: 63, wilson_low_pct: 44.2,
      wilson_high_pct: 78.8,
      by_class: {
        negation: { caught: 6, presented: 7 }, number: { caught: 4, presented: 7 }, referent: { caught: 4, presented: 7 },
        sense: { caught: 3, presented: 6 },
      },
    },
    review: { unplanted_finds: 4 },
    rivals: {
      chest: { n: 9, stop_after_span_onset_ms_median: 1420 },
      lips: { hits: 4, false_per_min: 0.9, lead_ms_median_hits: 150.5, stop_after_span_onset_ms_median: 1510 },
      talking_flag: { hits: 1, false_per_min: 0.2, lead_ms_median_hits: 40 },
      audio_250: { delay_after_voice_ms: 281.5, stop_after_span_onset_ms_median: 1700.5 },
      space_bar: { n: 8, stop_after_span_onset_ms_median: 980 },
    },
    paired: {
      chest_vs_lips: { n: 17, wins: 7, losses: 4, ties: 6, p_holm: 0.55 },
      chest_vs_audio250: { wins: 6, losses: 11, ties: 0, p_holm: 0.93 },
    },
    detector: { k: 2.5 },
  };
}

export function exampleAudioEnv(): AudioEnv {
  return { schema: 'audio-env/1', step_ms: 10, mic_db: [-58.2, -57.9, -31.4], narrator_db: [-22.5, -21.8, -90.0] };
}

export function exampleSentenceEnds(): SentenceEnds {
  return {
    schema: 'sentence-ends/1',
    ends: [
      { passage_id: 'opening', sentence_index: 0, n: 2985600 },
      { passage_id: 'p1', sentence_index: 4, n: 9168480 },
    ],
  };
}

export function examplePlantedTimes(): PlantedTimes {
  return {
    schema: 'planted-times/1',
    errors: [
      { error_id: 's1-e1', n_start: 9123840, n_end: 9137280, interrupted: false },
      { error_id: 's1-e2', n_start: null, n_end: null, interrupted: false },
    ],
  };
}

/** timings.json of a short clip, as tools/tts writes it (spec 7.7, 8.2). */
export function exampleTimings(): Timings {
  return {
    schema: 'timings/1',
    wordRule: 'copyholder-words/1',
    sampleRateHz: 48000,
    durationSamples: 96000,
    durationMs: 2000,
    wordCount: 4,
    sentenceCount: 2,
    engine: { name: 'kokoro', voice: 'af_heart', speed: 1 },
    correctedChunks: 0,
    words: [
      { index: 0, startMs: 275, endMs: 350, sentenceIndex: 0 },
      { index: 1, startMs: 350, endMs: 875, sentenceIndex: 0 },
      { index: 2, startMs: 1100, endMs: 1400, sentenceIndex: 1 },
      { index: 3, startMs: 1400, endMs: 1900, sentenceIndex: 1 },
    ],
  };
}

export function exampleTexts(): Texts {
  return {
    schema: 'texts/1',
    session_id: 's1',
    passages: [{ passage_id: 'p1', original: 'It took about 40 minutes.', planted: 'It took about 4 minutes.' }],
  };
}

/** A ledger line of spec 8.5 (prev and hashes are placeholders, not a chain). */
export function exampleLedgerLine(): LedgerLine {
  return {
    i: 4,
    step: 'label',
    utc: '2026-11-14T09:12:40Z',
    commit: '1a2b3c4',
    out_sha256: { 'clock_report.json': exampleHex('c'), 'onsets.json': exampleHex('0') },
    exploratory: false,
    prev: exampleHex('f'),
  };
}
