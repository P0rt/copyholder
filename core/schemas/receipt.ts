// Receipt of one session (spec 8.6, 7.9): receipt.json, schema receipt/1.

import {
  arrayOf, bool, fail, lit, makeValidator, nullable, num, obj, oneOf, reportPrecision, str, tuple,
  type Spec, type Validator,
} from './check.ts';
import {
  ERROR_CLASSES, LRT_RULES, commitSha, count, report1, sampleN, sessionId, sha256Hex, share, utcTime,
  type ErrorClass, type LrtRule,
} from './common.ts';
import { scoringRulesSpec, type ScoringRules } from './params.ts';
import { REVIEW_LABELS, type ReviewLabel } from './reports.ts';

export const RECEIPT_MODES = ['live_camera', 'replay', 'no_camera_spacebar', 'no_camera_microphone'] as const;
export type ReceiptMode = (typeof RECEIPT_MODES)[number];

/** Modes without camera: stops, chance and rivals are null (spec 8.6). */
export const NO_CAMERA_MODES: readonly ReceiptMode[] = ['no_camera_spacebar', 'no_camera_microphone'];

/**
 * Commitments that npm run receipt takes from the Mac's git tree and ledger (spec 8.5, 8.6).
 * In mode live_camera they are required. The judge's page (spec 7.11: replay, no camera) has
 * neither a ledger nor a git tree, so in the other modes they are all set or all null
 * (assumption: the browser writes receipt/1 too).
 */
export const GIT_COMMITMENTS = ['analysis_commit', 'ledger_head', 'working_tree_clean'] as const;

export const PLANTED_OUTCOMES = ['caught', 'caught_late', 'missed', 'not_presented'] as const;
export type PlantedOutcome = (typeof PLANTED_OUTCOMES)[number];

export const RIVALS = ['G', 'T', 'M', 'A100', 'A250', 'A500'] as const;
export type Rival = (typeof RIVALS)[number];

export interface PlantedEvent {
  error_id: string;
  class: ErrorClass;
  outcome: PlantedOutcome;
  interrupted: boolean;
  /** Span end to voice onset (assumption: name). */
  response_delay_ms: number | null;
  /** t_v - t_s of the chest stop (assumption: name). */
  lead_ms: number | null;
}

export interface ReceiptReviewItem {
  n_on: number;
  n_off: number;
  label: ReviewLabel;
  /** Inside a catch window (assumption). */
  in_window?: boolean | null;
}

export interface RivalStats {
  hits: number | null;
  median_lead_ms: number | null;
  false_per_min: number | null;
}

export interface LeadBlock {
  median_lead_ms: number | null;
  lead_interval_ms: [number, number] | null;
  median_lead_all_stops_ms: number | null;
}

export interface Receipt {
  schema: 'receipt/1';
  /** Session id (assumption: the spec prints it in receipt.txt). */
  id: string;
  mode: ReceiptMode;
  commitments: {
    plan_commitment: string;
    plan_verified: boolean;
    /** null before freeze-1 (rehearsal). */
    freeze_commit: string | null;
    /** analysis_commit, ledger_head, working_tree_clean: set by npm run receipt; all null in a browser mode (GIT_COMMITMENTS). */
    analysis_commit: string | null;
    detector_params_sha256: string | null;
    scoring_rules_sha256: string | null;
    onset_labels_sha256: string | null;
    review_labels_sha256: string | null;
    ledger_head: string | null;
    working_tree_clean: boolean | null;
    revealed_utc: string | null;
  };
  clock: {
    L_rt_ms: [number | null, number | null];
    rule: LrtRule;
    onset_p90_ms: number | null;
    audio_valid: boolean;
    /** null without the camera, as in clock_report.json. */
    trace_valid: boolean | null;
  };
  narration: { passages: number; narration_ms: number; measured_wpm_x10: number; days_since_last_read: number | null };
  planted: {
    planted: number;
    presented: number;
    caught: number;
    caught_late: number;
    missed: number;
    share: number | null;
    wilson95: [number, number] | null;
    by_class: Partial<Record<ErrorClass, { presented: number; caught: number }>>;
    events: PlantedEvent[];
  };
  objections: {
    total: number;
    matched: number;
    continuations: number;
    non_speech: number;
    no_signal: number;
    matched_no_signal: number;
    audible_inbreath: number;
  };
  stops: {
    primary_n: number;
    primary_hits: number;
    signal_only_hits: number;
    hits_lead_under_300: number;
    hits_all: number;
    leads_0_50: number;
    late: number;
    missed_no_inbreath: number;
    missed_inbreath: number;
    median_lead_ms: number | null;
    lead_interval_ms: [number, number] | null;
    median_lead_all_stops_ms: number | null;
    audio_pause_stops: number;
    /** Leads with L_rt of block A and of block B, when rule is "both" (assumption). */
    lead_by_block?: { A: LeadBlock; B: LeadBlock };
  } | null;
  chance: {
    false_holds: number;
    active_min: number;
    per_min: number;
    p0_poisson_upper: number;
    p0_shift: number | null;
    p0_pseudo: number | null;
    /** The largest of the three (spec 4.3). */
    p0_used: number;
    r_prompt: number | null;
  } | null;
  review: {
    unplanted_finds: number;
    false_alarms: number;
    unclear: number;
    reviewed_before_reveal: boolean;
    items: ReceiptReviewItem[];
  };
  rivals: Partial<Record<Rival, RivalStats>> | null;
  scoring_rules: ScoringRules;
  /** Space-bar block only (spec 8.6, name an assumption there; field names assumptions here). */
  key?: {
    presses: number;
    span_onset_to_stop_ms_median: number | null;
    outside_windows_per_min: number | null;
    /** lead_K, printed only as "pressed, then spoke". */
    lead_K_ms_median: number | null;
    lead_K_label: 'pressed, then spoke';
    spoke_without_pressing: number;
  };
}

const msOrNull: Spec = nullable(report1);
const interval: Spec = nullable(tuple([report1, report1], '[low, high]'));
const leadBlock: Spec = obj({ required: { median_lead_ms: msOrNull, lead_interval_ms: interval, median_lead_all_stops_ms: msOrNull } });

const rivalStats: Spec = obj({ required: { hits: nullable(count), median_lead_ms: msOrNull, false_per_min: nullable(num({ min: 0 })) } });

export const validateReceipt: Validator<Receipt> = makeValidator((v, p, out) => {
  const before = out.length;
  obj({
    required: {
      schema: lit('receipt/1'),
      id: sessionId,
      mode: oneOf(RECEIPT_MODES),
      commitments: obj({
        required: {
          plan_commitment: sha256Hex,
          plan_verified: bool,
          freeze_commit: nullable(commitSha),
          analysis_commit: nullable(commitSha),
          detector_params_sha256: nullable(sha256Hex),
          scoring_rules_sha256: nullable(sha256Hex),
          onset_labels_sha256: nullable(sha256Hex),
          review_labels_sha256: nullable(sha256Hex),
          ledger_head: nullable(sha256Hex),
          working_tree_clean: nullable(lit(true)),
          revealed_utc: nullable(utcTime),
        },
      }),
      clock: obj({
        required: {
          L_rt_ms: tuple([msOrNull, msOrNull], '[L_rt A, L_rt B]'),
          rule: oneOf(LRT_RULES),
          onset_p90_ms: msOrNull,
          audio_valid: bool,
          trace_valid: nullable(bool),
        },
      }),
      narration: obj({
        required: { passages: count, narration_ms: count, measured_wpm_x10: count, days_since_last_read: nullable(count) },
      }),
      planted: obj({
        required: {
          planted: count,
          presented: count,
          caught: count,
          caught_late: count,
          missed: count,
          share: nullable(share),
          wilson95: nullable(tuple([share, share], '[low, high]')),
          by_class: obj({ optional: Object.fromEntries(ERROR_CLASSES.map((c) => [c, obj({ required: { presented: count, caught: count } })])) }),
          events: arrayOf(
            obj({
              required: {
                error_id: str(),
                class: oneOf(ERROR_CLASSES),
                outcome: oneOf(PLANTED_OUTCOMES),
                interrupted: bool,
                response_delay_ms: msOrNull,
                lead_ms: msOrNull,
              },
            }),
          ),
        },
        check: (o, path, errs) => {
          const pl = o as Receipt['planted'];
          if (pl.caught + pl.caught_late + pl.missed !== pl.presented) {
            fail(errs, path, `caught + caught_late + missed must equal presented (${pl.caught} + ${pl.caught_late} + ${pl.missed} != ${pl.presented})`);
          }
          if (pl.presented > pl.planted) fail(errs, path, 'presented cannot exceed planted');
          if (pl.events.length > 0) {
            const n = (x: PlantedOutcome): number => pl.events.filter((e) => e.outcome === x).length;
            if (pl.events.length !== pl.planted) fail(errs, path, `events lists ${pl.events.length} errors, planted says ${pl.planted}`);
            else if (n('caught') !== pl.caught || n('caught_late') !== pl.caught_late || n('missed') !== pl.missed) {
              fail(errs, path, 'events outcomes do not add up to caught, caught_late and missed');
            }
          }
        },
      }),
      objections: obj({
        required: {
          total: count,
          matched: count,
          continuations: count,
          non_speech: count,
          no_signal: count,
          matched_no_signal: count,
          audible_inbreath: count,
        },
      }),
      stops: nullable(
        obj({
          required: {
            primary_n: count,
            primary_hits: count,
            signal_only_hits: count,
            hits_lead_under_300: count,
            hits_all: count,
            leads_0_50: count,
            late: count,
            missed_no_inbreath: count,
            missed_inbreath: count,
            median_lead_ms: msOrNull,
            lead_interval_ms: interval,
            median_lead_all_stops_ms: msOrNull,
            audio_pause_stops: count,
          },
          optional: { lead_by_block: obj({ required: { A: leadBlock, B: leadBlock } }) },
          check: (o, path, errs) => {
            const s = o as NonNullable<Receipt['stops']>;
            if (s.primary_hits > s.primary_n) fail(errs, path, 'primary_hits cannot exceed primary_n');
            if (s.hits_lead_under_300 > s.primary_hits) fail(errs, path, 'hits_lead_under_300 cannot exceed primary_hits');
          },
        }),
      ),
      chance: nullable(
        obj({
          required: {
            false_holds: count,
            active_min: num({ min: 0 }),
            per_min: num({ min: 0 }),
            p0_poisson_upper: share,
            p0_shift: nullable(share),
            p0_pseudo: nullable(share),
            p0_used: share,
            r_prompt: nullable(share),
          },
          check: (o, path, errs) => {
            const c = o as NonNullable<Receipt['chance']>;
            const largest = Math.max(c.p0_poisson_upper, c.p0_shift ?? 0, c.p0_pseudo ?? 0);
            if (Math.abs(c.p0_used - largest) > 1e-12) fail(errs, path, `p0_used must be the largest of the three estimates, ${largest} (spec 4.3)`);
          },
        }),
      ),
      review: obj({
        required: {
          unplanted_finds: count,
          false_alarms: count,
          unclear: count,
          reviewed_before_reveal: bool,
          items: arrayOf(
            obj({
              required: { n_on: sampleN, n_off: sampleN, label: oneOf(REVIEW_LABELS) },
              optional: { in_window: nullable(bool) },
            }),
          ),
        },
      }),
      rivals: nullable(
        obj({
          required: { G: rivalStats, T: rivalStats, A100: rivalStats, A250: rivalStats, A500: rivalStats },
          optional: { M: rivalStats },
        }),
      ),
      scoring_rules: scoringRulesSpec,
    },
    optional: {
      key: obj({
        required: {
          presses: count,
          span_onset_to_stop_ms_median: msOrNull,
          outside_windows_per_min: nullable(num({ min: 0 })),
          lead_K_ms_median: msOrNull,
          lead_K_label: lit('pressed, then spoke'),
          spoke_without_pressing: count,
        },
      }),
    },
    check: (o, path, errs) => {
      const r = o as unknown as Receipt;
      const at = (k: string): string => (path === '' ? k : `${path}.${k}`);
      const noCamera = NO_CAMERA_MODES.includes(r.mode);
      const unset = GIT_COMMITMENTS.filter((k) => r.commitments[k] === null);
      if (r.mode === 'live_camera') {
        for (const k of unset) fail(errs, at(`commitments.${k}`), 'required in mode live_camera: npm run receipt takes it from the git tree and the ledger (spec 8.5, 8.6)');
      } else if (unset.length > 0 && unset.length < GIT_COMMITMENTS.length) {
        fail(errs, at('commitments'), `${GIT_COMMITMENTS.join(', ')} are all set (npm run receipt) or all null (the judge's page, spec 7.11); null here: ${unset.join(', ')}`);
      }
      // Spec 8.6: each caught error answers one matched objection; the main share is primary_hits of primary_n, the matched objections.
      const ob = r.objections;
      if (ob.matched !== r.planted.caught) {
        fail(errs, at('objections.matched'), `${ob.matched} must equal planted.caught, ${r.planted.caught}: each caught error answers one objection (spec 8.6)`);
      }
      if (ob.matched > ob.total) fail(errs, at('objections.matched'), `${ob.matched} cannot exceed objections.total, ${ob.total}`);
      for (const k of ['audible_inbreath', 'matched_no_signal'] as const) {
        if (ob[k] > ob.matched) fail(errs, at(`objections.${k}`), `${ob[k]} counts among the matched objections, ${ob.matched} (spec 8.6)`);
      }
      if (r.stops !== null) {
        const st = r.stops;
        if (st.primary_n !== ob.matched) {
          fail(errs, at('stops.primary_n'), `${st.primary_n} must equal objections.matched, ${ob.matched}: the main share is primary_hits of the matched objections (spec 8.6)`);
        }
        if (st.hits_all > ob.total) fail(errs, at('stops.hits_all'), `${st.hits_all} cannot exceed objections.total, ${ob.total} (spec 8.6, H1 row 3)`);
        const signalN = st.primary_n - ob.matched_no_signal;
        if (st.signal_only_hits > signalN) {
          fail(errs, at('stops.signal_only_hits'), `${st.signal_only_hits} cannot exceed primary_n minus matched_no_signal, ${signalN} (spec 8.6, H1 row 4)`);
        }
      }
      for (const block of ['stops', 'chance', 'rivals'] as const) {
        if (noCamera && r[block] !== null) fail(errs, path, `${block} must be null in mode ${r.mode} (spec 8.6)`);
        if (!noCamera && r[block] === null) fail(errs, path, `${block}: missing in mode ${r.mode}`);
      }
      if (!noCamera && r.clock.trace_valid === null) fail(errs, path, `clock.trace_valid: true or false in mode ${r.mode}`);
      if (r.mode === 'no_camera_spacebar' && r.key === undefined) fail(errs, path, 'key: missing (the space-bar block carries it, spec 8.6)');
      if (r.mode !== 'no_camera_spacebar' && r.key !== undefined) fail(errs, path, 'key: only in mode no_camera_spacebar (spec 8.6)');
      if (r.stops !== null && r.stops.lead_by_block !== undefined && r.clock.rule !== 'both') {
        fail(errs, path, 'stops.lead_by_block only when clock.rule is "both"');
      }
    },
  })(v, p, out);
  if (out.length === before) reportPrecision(v, p, out);
});
