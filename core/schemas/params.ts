// Frozen parameters and scoring rules (spec 8.4): params/frozen.json (also its copy
// params/retune.json) and scoring_rules.json.

import {
  arrayOf, bool, fail, int, isPlainObject, jsonValue, lit, makeValidator, nullable, num, obj, oneOf, tuple,
  type Spec, type Validator,
} from './check.ts';
import { FADE_SAMPLES } from './precision.ts';

/** Grid for k (spec 7.4); 3.5 is also the fallback with "criterion not met". */
export const K_GRID: readonly number[] = [1.5, 2.0, 2.5, 3.0, 3.5];

/** Grid for theta_G: 0.010 to 0.060 in steps of 0.0025 (spec 7.5). */
export const THETA_G_GRID: readonly number[] = Array.from({ length: 21 }, (_, i) => (40 + 10 * i) / 4000);

export interface FrozenParams {
  schema: 'params/1';
  d1: {
    grid_hz: number;
    L: number;
    M: number;
    /** Written by stage A; absent or null under gate-prereg (spec 8.4). */
    k?: number | null;
    theta_clamp: [number, number];
    min_rise_A: number;
    min_rise_ms: number;
    arm_breaths: number;
    refractory_ms: number;
    rearm_ms: number;
    [other: string]: unknown;
  };
  hold: { H_ms: number; ramp_frames: number; audio_pause_ms: number; [other: string]: unknown };
  g: { theta_G?: number | null; frames: number; baseline_s: number; [other: string]: unknown };
  vad: {
    highpass_hz: number;
    hop_ms: number;
    over_floor_db: number;
    periodicity: number;
    on_ms: [number, number];
    off_ms: number;
    [other: string]: unknown;
  };
  /** Detector variant for live runs: D3 only after the retune ladder reached it (spec 7.4, 9.8). Absent: D1. */
  variant?: 'D1' | 'D3';
  /** Which step set k and theta_G; absent before stage A. */
  tuned?: {
    k: { step: string; criterion_met: boolean; rehearsal_step_up: boolean };
    theta_G: { step: string };
  };
  [other: string]: unknown;
}

const posInt: Spec = int({ min: 1 });
const nonNegInt: Spec = int({ min: 0 });
const posNum: Spec = num({ min: 0 });
/** Further parameters exist beyond the spec example ("часть полей"): any JSON value. */
const more: Spec = jsonValue;

const kSpec: Spec = (v, p, out) => {
  if (typeof v !== 'number' || !K_GRID.includes(v)) fail(out, p, `expected k from the grid ${K_GRID.join(', ')} (spec 7.4), got ${String(v)}`);
};
const thetaGSpec: Spec = (v, p, out) => {
  if (typeof v !== 'number' || !THETA_G_GRID.includes(v)) {
    fail(out, p, `expected theta_G from the grid 0.010 to 0.060 in steps of 0.0025 (spec 7.5), got ${String(v)}`);
  }
};

const stepName: Spec = oneOf(['stage_a', 'retune', 'rehearsal'], '"stage_a", "retune" or "rehearsal"');

export const validateFrozenParams: Validator<FrozenParams> = makeValidator(
  obj({
    required: {
      schema: lit('params/1'),
      d1: obj({
        required: {
          grid_hz: posInt,
          L: posInt,
          M: posInt,
          theta_clamp: tuple([posNum, posNum], '[low, high]'),
          min_rise_A: posNum,
          min_rise_ms: nonNegInt,
          arm_breaths: posInt,
          refractory_ms: nonNegInt,
          rearm_ms: nonNegInt,
        },
        // host also reads the variant here (live/lib/calib.cjs).
        optional: { k: nullable(kSpec), variant: oneOf(['D1', 'D3']) },
        open: more,
        check: (d, p, out) => {
          const [lo, hi] = d['theta_clamp'] as [number, number];
          if (!(lo < hi)) fail(out, `${p}.theta_clamp`, 'low must be below high');
        },
      }),
      hold: obj({
        required: {
          H_ms: posInt,
          ramp_frames: (v, p, out) => {
            if (v !== FADE_SAMPLES) fail(out, p, `expected ${FADE_SAMPLES}: nSilent = nCmd + ${FADE_SAMPLES} everywhere (spec 6.2), got ${String(v)}`);
          },
          audio_pause_ms: nonNegInt,
        },
        open: more,
      }),
      g: obj({
        required: { frames: posInt, baseline_s: posNum },
        optional: { theta_G: nullable(thetaGSpec) },
        open: more,
      }),
      vad: obj({
        required: {
          highpass_hz: posNum,
          hop_ms: posNum,
          over_floor_db: num(),
          periodicity: num({ min: 0, max: 1 }),
          on_ms: tuple([posNum, posNum], '[voiced ms, out of ms]'),
          off_ms: posNum,
        },
        open: more,
      }),
    },
    optional: {
      variant: oneOf(['D1', 'D3']),
      tuned: obj({
        required: {
          k: obj({ required: { step: stepName, criterion_met: bool, rehearsal_step_up: bool } }),
          theta_G: obj({ required: { step: stepName } }),
        },
      }),
    },
    open: more,
    check: (o, p, out) => {
      const d1 = o['d1'] as Record<string, unknown>;
      const tuned = o['tuned'];
      if (isPlainObject(tuned)) {
        const tk = tuned['k'] as { step: string; criterion_met: boolean };
        if (typeof d1['k'] !== 'number') fail(out, p, 'd1.k: missing although tuned says it was set');
        // The 3.5 fallback is stage A's (spec 7.4). Step 1 of the retune ladder lowers k by one
        // grid step with the 1.0/min rule waived (spec 9.8): its k only has to be on the grid.
        else if (tk.step === 'stage_a' && !tk.criterion_met && d1['k'] !== 3.5) {
          fail(out, p, 'd1.k must be 3.5 when stage A did not meet the criterion (spec 7.4)');
        }
      }
    },
  }),
);

/** True once stage A has written k and theta_G (spec 8.4: absent at gate-prereg). */
export function paramsAreTuned(p: FrozenParams): boolean {
  return typeof p.d1.k === 'number' && typeof p.g.theta_G === 'number';
}

// ---- scoring_rules.json ------------------------------------------------------------

export interface ScoringRules {
  /** Optional marker (assumption: the spec lists the keys only). */
  schema?: 'scoring-rules/1';
  catch_open_after_span_start_ms: 200;
  /** 5000, or up to 8000 in whole seconds after the listening run (spec 4.2). */
  catch_close_after_span_end_ms: number;
  late_close_after_span_end_ms: 12000;
  objection_merge_gap_ms: 1000;
  min_voiced_ms: 250;
  min_gap_ms: 4000;
  W_ms: 1500;
  /** Clarifications made before freeze-1 (spec 8.4). */
  notes?: string[];
}

/** The fixed values of spec 8.4; only the catch window close may grow. */
export const SCORING_RULES_FIXED = {
  catch_open_after_span_start_ms: 200,
  late_close_after_span_end_ms: 12000,
  objection_merge_gap_ms: 1000,
  min_voiced_ms: 250,
  min_gap_ms: 4000,
  W_ms: 1500,
} as const;

export const scoringRulesSpec: Spec = obj({
  required: {
    catch_open_after_span_start_ms: lit(SCORING_RULES_FIXED.catch_open_after_span_start_ms),
    catch_close_after_span_end_ms: (v, p, out) => {
      if (typeof v !== 'number' || !Number.isInteger(v) || v < 5000 || v > 8000 || v % 1000 !== 0) {
        fail(out, p, `expected 5000, 6000, 7000 or 8000 (spec 4.2), got ${String(v)}`);
      }
    },
    late_close_after_span_end_ms: lit(SCORING_RULES_FIXED.late_close_after_span_end_ms),
    objection_merge_gap_ms: lit(SCORING_RULES_FIXED.objection_merge_gap_ms),
    min_voiced_ms: lit(SCORING_RULES_FIXED.min_voiced_ms),
    min_gap_ms: lit(SCORING_RULES_FIXED.min_gap_ms),
    W_ms: lit(SCORING_RULES_FIXED.W_ms),
  },
  optional: { schema: lit('scoring-rules/1'), notes: arrayOf((v, p, out) => {
    if (typeof v !== 'string' || v === '') fail(out, p, 'expected a non-empty string');
  }) },
});

export const validateScoringRules: Validator<ScoringRules> = makeValidator(scoringRulesSpec);
