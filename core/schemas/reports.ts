// Report files of the session folder (spec 8.1, 7.12, 9.7): calib.json, quickcheck.json,
// clock_report.json, onsets.json, verdict.json, review.json.

import {
  arrayOf, bool, describe, fail, indexPath, int, isPlainObject, jsonValue, keyPath, lit, makeValidator, nullable, num, obj,
  oneOf, primitive, reportPrecision, str, tuple, type Spec, type Validator,
} from './check.ts';
import {
  LRT_RULES, RECORD_KINDS, count, report1, sampleN, sessionId, sha256Hex, share,
  type LrtRule, type RecordKind,
} from './common.ts';

const withPrecision =
  (spec: Spec): Spec =>
  (v, p, out) => {
    const before = out.length;
    spec(v, p, out);
    if (out.length === before) reportPrecision(v, p, out);
  };

const ms: Spec = report1;
const msOrNull: Spec = nullable(report1);

// ---- calib.json ---------------------------------------------------------------

export interface CalibLrt {
  A?: number | null;
  B?: number | null;
  /** Spread of the 10 clicks of block A and of block B. */
  spread?: [number | null, number | null];
  rule?: LrtRule | null;
  /** L_rt used for leads; null under rule "both" or "void". */
  used?: number | null;
}

/**
 * calib.json `sniff_lag_ms`: the sniff lag interval [lo, lo + L_rt] over the found sniffs (spec
 * 6.3, 8.1; PREREG §4). The file needs `no_arrival` and `median_over_ms` (validateCalib): a writer
 * types the block as CalibSniffLagBlock. This type leaves them optional only because core/clock
 * sniffLag (and so clockCalib's `calib`) gives the measured part without them; the clocks step
 * adds them (analysis/clocks/compute.ts calibSniffLagBlock). Spec 8.1's example predates them.
 */
export interface CalibSniffLagMs {
  /** Found sniffs, with or without an arrival (PREREG §4). */
  n: number;
  /** Found sniffs whose trace never arrived, counted beside n (PREREG §4). */
  no_arrival?: number;
  /** Medians over all found sniffs, those without an arrival ranked above every measured lag; null when they fall on such sniffs. */
  lo_median: number | null;
  /** Also null without a valid L_rt (rule void). */
  hi_median: number | null;
  /** The medians fall on sniffs without an arrival: both are over this many ms (PREREG §4); else null. */
  median_over_ms?: number | null;
}

/** calib.json sniff_lag_ms as the file holds it: every field present (validateCalib requires them). */
export type CalibSniffLagBlock = Required<CalibSniffLagMs>;

export interface Calib {
  schema: 'calib/1';
  L_rt_ms?: CalibLrt;
  polarity?: { sign: 1 | -1 | null; breaths_agree: number } | null;
  /** Median breath amplitude of the listening block; day-1 gate only. */
  A_ref?: number | null;
  camera_clock?: { offset_ms: [number | null, number | null]; slope_ppm: number | null; ok: boolean } | null;
  /** Sniff lag interval [lo, lo + L_rt]; day-1 gate only. */
  sniff_lag_ms?: CalibSniffLagMs | null;
  leak_db_over_floor?: number | null;
  output_gain?: number;
  /** Other facts a writer merges in; ms and dB values among them are rounded to 0.1. */
  [extra: string]: unknown;
}

/**
 * True when the found sniffs whose trace never arrived hold the medians: ranked above every
 * measured lag, they fill the middle once they are at least half of the n found, rounded up
 * (PREREG §4; core/clock medianOverFound). Then both medians are null and over median_over_ms.
 */
export function sniffMediansNotArrived(n: number, noArrival: number): boolean {
  return n > 0 && noArrival >= n - Math.floor(n / 2);
}

/** The sniff block of calib.json or row 4 of verdict.json, with the names of its median fields. */
interface SniffNumbers {
  n: number;
  noArrival: number | undefined;
  lo: number | null;
  hi: number | null;
  overMs: number | null | undefined;
  loKey: string;
  hiKey: string;
}

/**
 * PREREG §4 for the sniff numbers of calib.json and verdict.json: the sniffs without an arrival
 * are counted beside n; the medians fall on them exactly when they are at least half of n
 * (sniffMediansNotArrived), and then both medians are null and median_over_ms bounds them.
 */
function sniffNumberProblems(s: SniffNumbers, p: string, out: string[]): void {
  const at = (k: string): string => keyPath(p, k);
  const why = 'the found sniffs whose trace never arrived are counted beside n (PREREG §4)';
  if (s.noArrival === undefined) fail(out, at('no_arrival'), `missing: ${why}`);
  if (s.overMs === undefined) fail(out, at('median_over_ms'), 'missing: null, or the bound of medians that fall on sniffs without an arrival (PREREG §4)');
  if (s.noArrival === undefined || s.overMs === undefined) return;
  if (s.noArrival > s.n) {
    fail(out, at('no_arrival'), `${s.noArrival} is more than the ${s.n} found sniffs: ${why}`);
    return;
  }
  const notArrived = `${s.noArrival} of the ${s.n} found sniffs never arrived`;
  if (sniffMediansNotArrived(s.n, s.noArrival)) {
    if (s.overMs === null) fail(out, at('median_over_ms'), `missing: ${notArrived}, so the medians fall on them and are over a bound (PREREG §4)`);
    else if (!(s.overMs > 0)) fail(out, at('median_over_ms'), `expected a bound above 0 ms, got ${s.overMs}`);
    for (const [k, v] of [[s.loKey, s.lo], [s.hiKey, s.hi]] as const) {
      if (v !== null) fail(out, at(k), `expected null: ${notArrived}, so the median falls on them, over median_over_ms (PREREG §4)`);
    }
    return;
  }
  if (s.overMs !== null) fail(out, at('median_over_ms'), `expected null: ${s.n - s.noArrival} of the ${s.n} found sniffs arrived, so the medians are measured (PREREG §4)`);
  if (s.n > 0 && s.lo === null) fail(out, at(s.loKey), `missing: ${s.n - s.noArrival} of the ${s.n} found sniffs arrived, so the median is measured (PREREG §4)`);
  if (s.n === 0 && (s.lo !== null || s.hi !== null)) fail(out, p, 'medians without a found sniff: expected null');
}

/** calib.json sniff_lag_ms (spec 8.1, PREREG §4). */
const calibSniffLag: Spec = obj({
  required: { n: count, lo_median: msOrNull, hi_median: msOrNull },
  // Required too; checked below, with a message that says why.
  optional: { no_arrival: count, median_over_ms: msOrNull },
  check: (o, p, out) =>
    sniffNumberProblems(
      {
        n: o['n'] as number,
        noArrival: o['no_arrival'] as number | undefined,
        lo: o['lo_median'] as number | null,
        hi: o['hi_median'] as number | null,
        overMs: o['median_over_ms'] as number | null | undefined,
        loKey: 'lo_median',
        hiKey: 'hi_median',
      },
      p,
      out,
    ),
});

/**
 * calib.json is filled by host, clocks and doctor at different times, so every block is
 * optional; what is present must have the right form (spec 8.1). host merges what the
 * page sends, so unknown top-level fields are allowed (JSON values).
 */
export const validateCalib: Validator<Calib> = makeValidator(
  withPrecision(
    obj({
      required: { schema: lit('calib/1') },
      optional: {
        L_rt_ms: obj({
          optional: {
            A: msOrNull,
            B: msOrNull,
            spread: tuple([msOrNull, msOrNull], '[spread A, spread B]'),
            rule: nullable(oneOf(LRT_RULES)),
            used: msOrNull,
          },
        }),
        polarity: nullable(obj({ required: { sign: nullable(oneOf([1, -1])), breaths_agree: int({ min: 0, max: 3 }) } })),
        A_ref: nullable(num({ min: 0 })),
        camera_clock: nullable(
          obj({
            required: {
              offset_ms: tuple([msOrNull, msOrNull], '[offset at start, offset at end]'),
              slope_ppm: nullable(num()),
              ok: bool,
            },
          }),
        ),
        sniff_lag_ms: nullable(calibSniffLag),
        leak_db_over_floor: nullable(report1),
        output_gain: num({ min: 0 }),
      },
      open: jsonValue,
    }),
  ),
);

// ---- quickcheck.json ----------------------------------------------------------------

export const QUICKCHECK_RESULTS = ['GOOD RECORDING', 'RE-RECORD NOW'] as const;
export type QuickcheckResult = (typeof QUICKCHECK_RESULTS)[number];

/** One condition of spec 7.12 / 9.4. Names are snake_case, e.g. "audio_continuous". */
export interface QuickcheckCheck {
  name: string;
  ok: boolean;
  /** Hard condition (fails the recording) or warning only. */
  hard: boolean;
  value?: string | number | boolean | null;
  limit?: string | number | boolean | null;
  detail?: string;
}

/** quickcheck.json (assumption: the spec names only "verdict on the recording and reasons"). */
export interface Quickcheck {
  schema: 'quickcheck/1';
  id: string;
  kind: RecordKind;
  result: QuickcheckResult;
  /** One reason per failed hard check; printed after "RE-RECORD NOW: ". Empty when good. */
  reasons: string[];
  /** Every failed hard check is technical (spec 9.4: does not use up the re-record). null when good. */
  technical: boolean | null;
  checks: QuickcheckCheck[];
}

/** Suggested check names for the conditions of spec 7.12 and 9.4 (not enforced). */
export const QUICKCHECK_NAMES = [
  'audio_continuous', 'loop_checks', 'cues_marked', 'trace_rate', 'no_sdk_error', 'voice_after_cues',
  'pa_bursts', 'sniffs', 'polarity', 'mic_flags_off', 'sample_rate', 'no_hard_window_events',
  'd1_active_share', 'not_sent_share', 'tap_loop_delay', 'status_ok_share', 'window_warnings', 'L_rt_diff',
] as const;

export const validateQuickcheck: Validator<Quickcheck> = makeValidator(
  obj({
    required: {
      schema: lit('quickcheck/1'),
      id: sessionId,
      kind: oneOf(RECORD_KINDS),
      result: oneOf(QUICKCHECK_RESULTS),
      reasons: arrayOf(str()),
      technical: nullable(bool),
      checks: arrayOf(
        obj({
          required: { name: str({ pattern: /^[A-Za-z][A-Za-z0-9_]*$/, what: 'a check name like "audio_continuous"' }), ok: bool, hard: bool },
          optional: { value: primitive, limit: primitive, detail: str({ nonEmpty: false }) },
        }),
      ),
    },
    check: (o, p, out) => {
      const checks = o['checks'] as QuickcheckCheck[];
      const reasons = o['reasons'] as string[];
      const failedHard = checks.filter((c) => c.hard && !c.ok);
      const names = new Set<string>();
      for (const c of checks) {
        if (names.has(c.name)) fail(out, p, `checks: "${c.name}" appears twice`);
        names.add(c.name);
      }
      if (o['result'] === 'GOOD RECORDING') {
        if (failedHard.length > 0) fail(out, p, `result is GOOD RECORDING but hard check "${failedHard[0]?.name}" failed`);
        if (reasons.length > 0) fail(out, p, 'reasons must be empty for GOOD RECORDING');
        if (o['technical'] !== null) fail(out, p, 'technical must be null for GOOD RECORDING');
      } else {
        if (failedHard.length === 0) fail(out, p, 'result is RE-RECORD NOW but no hard check failed');
        if (reasons.length === 0) fail(out, p, 'reasons: RE-RECORD NOW needs at least one reason');
        if (o['technical'] === null) fail(out, p, 'technical: say whether the failure is technical (spec 9.4)');
      }
    },
  }),
);

/** The one line quickcheck prints (spec 7.12): GOOD RECORDING or RE-RECORD NOW: <reason>. */
export function quickcheckLine(q: Pick<Quickcheck, 'result' | 'reasons'>): string {
  return q.result === 'GOOD RECORDING' ? 'GOOD RECORDING' : `RE-RECORD NOW: ${q.reasons.join('; ')}`;
}

// ---- clock_report.json -----------------------------------------------------------------

export interface ClockReport {
  schema: 'clock-report/1';
  audio_valid: boolean;
  /** null in records without the camera (space-bar block, listening without camera). */
  trace_valid: boolean | null;
  chain: {
    /** L_rt of loop checks A and B. */
    L_rt_ms: [number | null, number | null];
    spread_ms: [number | null, number | null];
    /** Outcome of the L_rt rule of spec 6.3 (spec 7.12 lists it; the 8.1 example omits it). */
    rule?: LrtRule;
    quantum_ms: number;
    stops: number;
    stops_match_ch1: number;
    /** Samples; 0 for live D1 stops (spec 6.3). */
    nCmd_minus_nArr: number | null;
  };
  /** Written by the label step; null before it (spec 8.1). */
  onset: { p90_abs_auto_minus_manual_ms: number | null; events: number; soft_first_sounds: number } | null;
  hard: {
    chunks_contiguous: boolean;
    /** null when neither audio.wav nor the track settings tell it. */
    sample_rate: number | null;
    mic_flags_off: boolean;
    device_events: number;
    visibility_events: number;
    trace_rate_median: number | null;
    sdk_errors: number;
    tap_lost: number;
  };
  warn: {
    not_sent_share: number | null;
    tap_loop_p99_ms: number | null;
    status_ok_share: number | null;
    window_warnings: number;
  };
}

/** Words the clock report never contains (spec 6.3, 8.1). */
export const CLOCK_REPORT_BANNED_WORDS = ['proven', 'met'] as const;

const noClaimWords: Spec = (v, p, out) => {
  const re = /\b(proven|met)\b/i;
  const walk = (x: unknown, path: string): void => {
    if (typeof x === 'string' && re.test(x)) fail(out, path, `the clock report holds only measured numbers: no "proven" or "met" (spec 8.1), got ${describe(x)}`);
    else if (Array.isArray(x)) x.forEach((y, i) => walk(y, `${path}[${i}]`));
    else if (isPlainObject(x)) {
      for (const [k, y] of Object.entries(x)) {
        if (re.test(k)) fail(out, path === '' ? k : `${path}.${k}`, 'the clock report has no "proven" or "met" (spec 8.1)');
        walk(y, path === '' ? k : `${path}.${k}`);
      }
    }
  };
  walk(v, p);
};

export const validateClockReport: Validator<ClockReport> = makeValidator((v, p, out) => {
  withPrecision(
    obj({
      required: {
        schema: lit('clock-report/1'),
        audio_valid: bool,
        trace_valid: nullable(bool),
        chain: obj({
          required: {
            L_rt_ms: tuple([msOrNull, msOrNull], '[L_rt A, L_rt B]'),
            spread_ms: tuple([msOrNull, msOrNull], '[spread A, spread B]'),
            quantum_ms: ms,
            stops: count,
            stops_match_ch1: count,
            nCmd_minus_nArr: nullable(int()),
          },
          optional: { rule: oneOf(LRT_RULES) },
        }),
        onset: nullable(
          obj({ required: { p90_abs_auto_minus_manual_ms: msOrNull, events: count, soft_first_sounds: count } }),
        ),
        hard: obj({
          required: {
            chunks_contiguous: bool,
            sample_rate: nullable(int({ min: 1 })),
            mic_flags_off: bool,
            device_events: count,
            visibility_events: count,
            trace_rate_median: nullable(num({ min: 0, round1: true })),
            sdk_errors: count,
            tap_lost: count,
          },
        }),
        warn: obj({
          required: {
            not_sent_share: nullable(share),
            tap_loop_p99_ms: msOrNull,
            status_ok_share: nullable(share),
            window_warnings: count,
          },
        }),
      },
      check: (o, path, errs) => {
        const chain = o['chain'] as ClockReport['chain'];
        if (chain.stops_match_ch1 > chain.stops) fail(errs, path, 'chain.stops_match_ch1 cannot exceed chain.stops');
      },
    }),
  )(v, p, out);
  noClaimWords(v, p, out);
});

// ---- onsets.json -----------------------------------------------------------------------

export const ONSET_KINDS = ['objection', 'continuation', 'other'] as const;
export type OnsetKind = (typeof ONSET_KINDS)[number];
export const ONSET_LABELS = ['speech', 'cough', 'laugh', 'throat', 'other'] as const;
export type OnsetLabel = (typeof ONSET_LABELS)[number];
export const ONSET_FLAGS = ['no_dip'] as const;

export interface OnsetEvent {
  id: string;
  kind: OnsetKind;
  /** Blind label; null before the label step and for records without it. */
  label: OnsetLabel | null;
  voiced_ms: number;
  floor_db: number;
  /** Cue index in the day-1 gate (assumption). */
  cue?: number;
  /** Last sample of the reply (assumption). */
  n_end?: number;
  auto: {
    /** Voice onset, channel 0 sample. */
    n_v: number;
    /** Anchor t_a (spec 7.6). */
    n_a: number;
    /** Audible in-breath [start, end] in samples, null when there is none. */
    breath: [number, number] | null;
    flags: string[];
  };
  manual: { n_v: number | null; blind: boolean } | null;
}

export interface Onsets {
  schema: 'onsets/1';
  /** SHA-256 of the blind labels; null before the label step. */
  labels_sha256: string | null;
  events: OnsetEvent[];
}

/** The label that marks "no reply": the only one whose hand mark has no first sound (analysis/label convention). */
export const ONSET_NO_REPLY_LABEL: OnsetLabel = 'other';

/**
 * Blind marks (spec 7.6, 8.5): the label step gives every event its label and a hand mark made
 * blind, and writes labels_sha256 with them; before it, and in records without it (demo,
 * pilot), events carry neither. A hand mark without a first sound (n_v null) means "no reply"
 * and goes with the label other (assumption, as analysis/label writes it).
 */
function blindMarkProblems(o: Onsets, p: string, out: string[]): void {
  const labelled = o.labels_sha256 !== null;
  o.events.forEach((e, i) => {
    const at = (k: string): string => keyPath(indexPath(keyPath(p, 'events'), i), k);
    if (!labelled) {
      if (e.label !== null) fail(out, at('label'), 'a blind label without labels_sha256: labels come with their hash from the label step (spec 8.5)');
      if (e.manual !== null) fail(out, at('manual'), 'a hand mark without labels_sha256: hand marks come with their hash from the label step (spec 8.5)');
      return;
    }
    if (e.label === null) fail(out, at('label'), 'missing: labels_sha256 is set, so the label step gave every event its blind label (spec 7.6, 8.5)');
    if (e.manual === null) {
      fail(out, at('manual'), 'missing: labels_sha256 is set, so every event has its blind hand mark (spec 7.6, 8.5)');
      return;
    }
    if (!e.manual.blind) fail(out, `${at('manual')}.blind`, 'expected true: hand marks are made with the onsets hidden (spec 7.6)');
    if (e.manual.n_v === null && e.label !== null && e.label !== ONSET_NO_REPLY_LABEL) {
      fail(out, `${at('manual')}.n_v`, `a ${e.label} event needs its first-sound mark: only "${ONSET_NO_REPLY_LABEL}" (no reply) has none (spec 7.6)`);
    }
  });
}

export const validateOnsets: Validator<Onsets> = makeValidator(
  withPrecision(
    obj({
      required: {
        schema: lit('onsets/1'),
        labels_sha256: nullable(sha256Hex),
        events: arrayOf(
          obj({
            required: {
              id: str({ pattern: /^[A-Za-z0-9_-]+$/, what: 'an event id like "o07"' }),
              kind: oneOf(ONSET_KINDS),
              label: nullable(oneOf(ONSET_LABELS)),
              voiced_ms: num({ min: 0, round1: true }),
              floor_db: report1,
              auto: obj({
                required: {
                  n_v: sampleN,
                  n_a: sampleN,
                  breath: nullable(tuple([sampleN, sampleN], '[start, end] in samples')),
                  flags: arrayOf(oneOf(ONSET_FLAGS)),
                },
                check: (a, p, out) => {
                  if ((a['n_v'] as number) > (a['n_a'] as number)) fail(out, p, 'n_v lies after n_a: the onset is found stepping back from the anchor (spec 7.6)');
                  const b = a['breath'] as [number, number] | null;
                  if (b !== null && b[0] > b[1]) fail(out, `${p}.breath`, 'start after end');
                },
              }),
              manual: nullable(obj({ required: { n_v: nullable(sampleN), blind: bool } })),
            },
            optional: { cue: int({ min: 0 }), n_end: sampleN },
          }),
        ),
      },
      check: (o, p, out) => {
        const ids = new Set<string>();
        for (const e of o['events'] as OnsetEvent[]) {
          if (ids.has(e.id)) fail(out, p, `events: id "${e.id}" appears twice`);
          ids.add(e.id);
        }
        blindMarkProblems(o as unknown as Onsets, p, out);
      },
    }),
  ),
);

// ---- verdict.json (day-1 gate, stage B) --------------------------------------------

export const GATE_OUTCOMES = ['PASS', 'BETWEEN', 'KILL'] as const;
export type GateOutcome = (typeof GATE_OUTCOMES)[number];
export const GATE_VERDICTS = [...GATE_OUTCOMES, 'NOT EVALUABLE'] as const;
export type GateVerdict = (typeof GATE_VERDICTS)[number];

/** Fewer valid objections than this: NOT EVALUABLE (spec 9.6). */
export const GATE_MIN_VALID = 12;

/** Rows of spec 9.6, in order. */
export const VERDICT_ROWS = ['hits', 'lead', 'false_holds', 'sniff_lag', 'chest_vs_lips'] as const;
export type VerdictRow = (typeof VERDICT_ROWS)[number];

export interface Verdict {
  schema: 'verdict/1';
  id: string;
  pack: 'A' | 'B' | 'C';
  /** Stage B run: 1 is the confirmatory run, later runs are exploratory (spec 8.5). */
  run: number;
  exploratory: boolean;
  params_sha256: string;
  clock: { L_rt_ms: [number | null, number | null]; diff_ms: number | null; rule: LrtRule; onset_p90_ms: number | null };
  tuning: { k: number; criterion_met: boolean; theta_G: number };
  events: { cued: number; valid: number; armed: number; audible_inbreath: number };
  rows: {
    hits: { outcome: GateOutcome | null; hits: number; armed_hits: number; leads_0_50: number };
    lead: { outcome: GateOutcome | null; median_hits_ms: number | null; median_all_stops_ms: number | null };
    false_holds: {
      outcome: GateOutcome | null;
      per_min: number | null;
      armed_min: number;
      in_sample_chest_per_min: number | null;
      in_sample_lips_per_min: number | null;
    };
    sniff_lag: {
      outcome: GateOutcome | null;
      lo_median_ms: number | null;
      hi_median_ms: number | null;
      /** The medians fall on sniffs without an arrival: both are over this many ms (PREREG §4); else null. */
      median_over_ms: number | null;
      /** Found sniffs, with or without an arrival (PREREG §4). */
      n: number;
      /** Found sniffs whose trace never arrived, counted beside n: calib.json's count (PREREG §4). */
      no_arrival: number;
      best_case_ms: number | null;
      d1_on_sniffs_ms: number | null;
    };
    chest_vs_lips: {
      outcome: GateOutcome | null;
      wins: number;
      losses: number;
      ties: number;
      both_before_n: number;
      lead_diff_ms_median: number | null;
      chest_false_per_min: number | null;
      lips_false_per_min: number | null;
      /** Lips at the chest rate; never part of the verdict. */
      exploratory_equal_rate: { wins: number; losses: number } | null;
    };
  };
  misses: { no_inbreath: number; inbreath_audible: number };
  /** Rivals T and M, descriptive; null when left for a later exploratory run (spec 14.4). */
  other: { talking_flag_hits: number; head_motion_hits: number } | null;
  /** Rows whose outcome changes with manual onsets; they read BETWEEN (spec 9.6). */
  manual_changes: VerdictRow[];
  verdict: GateVerdict;
}

/** Spec 9.6: any KILL gives KILL, five PASS give PASS, else BETWEEN; under 12 valid: NOT EVALUABLE. */
export function combineGateVerdict(outcomes: readonly (GateOutcome | null)[], valid: number): GateVerdict {
  if (valid < GATE_MIN_VALID) return 'NOT EVALUABLE';
  if (outcomes.some((o) => o === 'KILL')) return 'KILL';
  if (outcomes.length === VERDICT_ROWS.length && outcomes.every((o) => o === 'PASS')) return 'PASS';
  return 'BETWEEN';
}

const outcome: Spec = nullable(oneOf(GATE_OUTCOMES));
const perMin: Spec = nullable(num({ min: 0 }));

export const validateVerdict: Validator<Verdict> = makeValidator(
  withPrecision(
    obj({
      required: {
        schema: lit('verdict/1'),
        id: sessionId,
        pack: oneOf(['A', 'B', 'C']),
        run: int({ min: 1 }),
        exploratory: bool,
        params_sha256: sha256Hex,
        clock: obj({
          required: { L_rt_ms: tuple([msOrNull, msOrNull], '[L_rt A, L_rt B]'), diff_ms: msOrNull, rule: oneOf(LRT_RULES), onset_p90_ms: msOrNull },
        }),
        tuning: obj({ required: { k: num({ min: 0 }), criterion_met: bool, theta_G: num({ min: 0 }) } }),
        events: obj({ required: { cued: count, valid: count, armed: count, audible_inbreath: count } }),
        rows: obj({
          required: {
            hits: obj({ required: { outcome, hits: count, armed_hits: count, leads_0_50: count } }),
            lead: obj({ required: { outcome, median_hits_ms: msOrNull, median_all_stops_ms: msOrNull } }),
            false_holds: obj({
              required: { outcome, per_min: perMin, armed_min: num({ min: 0 }), in_sample_chest_per_min: perMin, in_sample_lips_per_min: perMin },
            }),
            sniff_lag: obj({
              required: {
                outcome,
                lo_median_ms: msOrNull,
                hi_median_ms: msOrNull,
                median_over_ms: msOrNull,
                n: count,
                no_arrival: count,
                best_case_ms: msOrNull,
                d1_on_sniffs_ms: msOrNull,
              },
              check: (o, p, out) => {
                const s = o as unknown as Verdict['rows']['sniff_lag'];
                const before = out.length;
                sniffNumberProblems(
                  { n: s.n, noArrival: s.no_arrival, lo: s.lo_median_ms, hi: s.hi_median_ms, overMs: s.median_over_ms, loKey: 'lo_median_ms', hiKey: 'hi_median_ms' },
                  p,
                  out,
                );
                if (out.length === before && s.median_over_ms !== null && s.outcome !== null && s.outcome !== 'KILL') {
                  fail(out, keyPath(p, 'outcome'), `expected KILL: the medians fall on sniffs whose trace never arrived, over ${s.median_over_ms} ms (PREREG §4, spec 9.6)`);
                }
              },
            }),
            chest_vs_lips: obj({
              required: {
                outcome,
                wins: count,
                losses: count,
                ties: count,
                both_before_n: count,
                lead_diff_ms_median: msOrNull,
                chest_false_per_min: perMin,
                lips_false_per_min: perMin,
                exploratory_equal_rate: nullable(obj({ required: { wins: count, losses: count } })),
              },
            }),
          },
        }),
        misses: obj({ required: { no_inbreath: count, inbreath_audible: count } }),
        other: nullable(obj({ required: { talking_flag_hits: count, head_motion_hits: count } })),
        manual_changes: arrayOf(oneOf(VERDICT_ROWS)),
        verdict: oneOf(GATE_VERDICTS),
      },
      check: (o, p, out) => {
        const v = o as unknown as Verdict;
        if (v.exploratory !== v.run > 1) {
          fail(out, p, `run ${v.run} must have exploratory ${v.run > 1}: stage B runs once, later runs are exploratory (spec 8.5)`);
        }
        for (const r of v.manual_changes) {
          if (v.rows[r].outcome !== 'BETWEEN') fail(out, `${p === '' ? '' : `${p}.`}rows.${r}.outcome`, 'a row that changes with manual onsets reads BETWEEN (spec 9.6)');
        }
        if (v.events.valid >= GATE_MIN_VALID) {
          for (const r of VERDICT_ROWS) {
            if (v.rows[r].outcome === null) fail(out, `${p === '' ? '' : `${p}.`}rows.${r}.outcome`, `missing although ${v.events.valid} objections are valid`);
          }
        }
        const expected = combineGateVerdict(VERDICT_ROWS.map((r) => v.rows[r].outcome), v.events.valid);
        if (v.verdict !== expected) fail(out, p, `verdict ${v.verdict} does not follow from the rows: expected ${expected} (spec 9.6)`);
        if (v.rows.hits.hits > v.events.valid) fail(out, p, 'rows.hits.hits cannot exceed events.valid');
      },
    }),
  ),
);

// ---- review.json -------------------------------------------------------------------

export const REVIEW_LABELS = ['real_error', 'false_alarm', 'unclear'] as const;
export type ReviewLabel = (typeof REVIEW_LABELS)[number];

/** One stretch of voice from the recorded voice edges, labelled blind (spec 7.9, 10.5). */
export interface ReviewSegment {
  n_on: number;
  n_off: number;
  /** null while the labelling is still open. */
  label: ReviewLabel | null;
}

/** review.json (assumption: the spec gives the labels, not the file layout). */
export interface Review {
  schema: 'review/1';
  id: string;
  items: ReviewSegment[];
}

export const validateReview: Validator<Review> = makeValidator(
  obj({
    required: {
      schema: lit('review/1'),
      id: sessionId,
      items: arrayOf(
        obj({
          required: { n_on: sampleN, n_off: sampleN, label: nullable(oneOf(REVIEW_LABELS)) },
          check: (s, p, out) => {
            if ((s['n_off'] as number) < (s['n_on'] as number)) fail(out, p, 'n_off lies before n_on');
          },
        }),
      ),
    },
  }),
);
