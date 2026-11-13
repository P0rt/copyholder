// Clock check and clock_report.json (spec 6.3, 7.12, 8.1). Prints measured numbers only.

import { CLICK_SAMPLES } from './clicks.ts';
import { LRT_BOTH_MAX_MS, QUANTUM_SAMPLES, SAMPLE_RATE_HZ, TRACE_RATE_MIN_PER_S, quantumMs } from './constants.ts';
import {
  LOOP_MAX_LAG_MS,
  loopRule,
  measureLoopLatency,
  type LoopMeasurement,
  type LoopOptions,
  type LrtThresholds,
} from './loop.ts';
import {
  arrivalsBySeq,
  audioIndex,
  chunkLayout,
  loopClickBlocks,
  recordedSpan,
  traceRunTimestamps,
  type ChunkLayout,
} from './session.ts';
import { medianWithZeros, quantile, round1, round3 } from './stats.ts';
import type {
  CalibLrt,
  ClockReport,
  EventLine,
  LrtRule,
  MicSettings,
  OnsetErrorBlock,
  SampleLine,
  SessionData,
  Stamp,
} from './types.ts';

/**
 * Hard device events, counted in `device_events` (spec 7.3, 8.1: devicechange and the microphone
 * track's ended and mute; names of docs/protocol.md and core/schemas).
 */
export const DEVICE_EVENTS: ReadonlySet<string> = new Set(['devicechange', 'track_ended', 'track_mute']);
/**
 * Events that end the recording page: host's page_reload and page_lost, and the page's deck_error
 * (Deck's processor failed; docs/protocol.md). Spec 6.3: a reload or a new track cancels the session.
 * They are not device events (spec 8.1), and clock_report.json has no field for them: they make
 * the audio invalid through a failure of their own.
 */
export const PAGE_LOSS_EVENTS: ReadonlySet<string> = new Set(['page_reload', 'page_lost', 'deck_error']);
/** Window events that only warn (spec 6.3, 7.12), counted in `window_warnings`. */
export const WINDOW_WARNING_EVENTS: ReadonlySet<string> = new Set(['blur', 'resize']);
/** Host events saying audio blocks were lost, damaged or not written (live/lib/session-store.cjs). */
export const AUDIO_GAP_EVENTS: ReadonlySet<string> = new Set(['audio_gap', 'audio_bad_block', 'audio_full']);

/**
 * A hidden page (spec 7.3). Reads `hidden` (core/schemas), else `state` or `visibilityState`
 * (the page), else `hard`. A visibilitychange that says none of these counts as hidden.
 */
export function isPageHiddenEvent(ev: EventLine): boolean {
  if (ev.e !== 'visibilitychange') return false;
  if (typeof ev['hidden'] === 'boolean') return ev['hidden'];
  const state = ev['state'] ?? ev['visibilityState'];
  if (typeof state === 'string') return state !== 'visible';
  if (typeof ev['hard'] === 'boolean') return ev['hard'];
  return true;
}

/** A hard device event of spec 8.1 `device_events`: a name of DEVICE_EVENTS. */
export function isDeviceEvent(ev: EventLine): boolean {
  return DEVICE_EVENTS.has(ev.e);
}

/**
 * A lost recording page: a name of PAGE_LOSS_EVENTS, or any other event marked `hard: true`
 * that is neither a device event nor a visibilitychange.
 */
export function isPageLossEvent(ev: EventLine): boolean {
  if (ev.e === 'visibilitychange' || isDeviceEvent(ev)) return false;
  return PAGE_LOSS_EVENTS.has(ev.e) || ev['hard'] === true;
}

/** Any hard window, device or page event (spec 6.3, 7.3): one during a recording voids its audio. */
export function isHardEvent(ev: EventLine): boolean {
  return isDeviceEvent(ev) || isPageHiddenEvent(ev) || isPageLossEvent(ev);
}

/**
 * Median count of unique trace samples per 1 s of camera time, full windows only (spec 6.3).
 * Windows run from the first to the last sample of the recording's trace, strays left out
 * (traceRunTimestamps); a window without samples counts 0. Counted sparsely: the cost follows
 * the samples, never the time span.
 */
export function traceRateMedian(samples: readonly SampleLine[]): number | null {
  const ts = traceRunTimestamps(samples);
  if (ts.length < 2) return null;
  const t0 = ts[0]!;
  const windows = Math.floor((ts[ts.length - 1]! - t0) / 1e6);
  if (!(windows >= 1)) return null;
  const counts = new Map<number, number>();
  for (const t of ts) {
    const w = Math.floor((t - t0) / 1e6);
    if (w < windows) counts.set(w, (counts.get(w) ?? 0) + 1);
  }
  return medianWithZeros([...counts.values()], windows);
}

/** Share of `f` lines with sent false (spec 7.12 warning); null without `f` lines. */
export function notSentShare(samples: readonly SampleLine[]): number | null {
  const f = samples.filter((l) => l.k === 'f' && typeof l.sent === 'boolean');
  return f.length === 0 ? null : f.filter((l) => l.sent === false).length / f.length;
}

/**
 * Share of camera time under validationStatus kOk (code 0, spec 7.1). Each `v` line holds
 * until the next one, the last until the last trace sample (strays left out); without
 * timestamps, the share of lines. Null without `v` lines.
 */
export function statusOkShare(samples: readonly SampleLine[]): number | null {
  const v = samples.filter((l) => l.k === 'v' && typeof l.code === 'number');
  if (v.length === 0) return null;
  const byLines = v.filter((l) => l.code === 0).length / v.length;
  if (!v.every((l) => typeof l.tsCbUs === 'number' && Number.isFinite(l.tsCbUs))) return byLines;
  const sorted = [...v].sort((a, b) => a.tsCbUs! - b.tsCbUs!);
  const ts = traceRunTimestamps(samples);
  const end = Math.max(sorted[sorted.length - 1]!.tsCbUs!, ts.length > 0 ? ts[ts.length - 1]! : Number.NEGATIVE_INFINITY);
  let total = 0;
  let ok = 0;
  sorted.forEach((l, i) => {
    const dt = (i + 1 < sorted.length ? sorted[i + 1]!.tsCbUs! : end) - l.tsCbUs!;
    total += dt;
    if (l.code === 0) ok += dt;
  });
  return total > 0 ? ok / total : byLines;
}

/**
 * 99th percentile of tap's event-loop delay (spec 7.1, 7.12 warning): tap writes the P99 of
 * each second, and the report takes the P99 of those (assumption). Reads core/schemas names
 * (`p99_ms`) and tap's (`p99Ms`), falling back to the maximum of the second.
 */
export function tapLoopP99Ms(samples: readonly SampleLine[]): number | null {
  const values = samples
    .filter((l) => l.k === 'l')
    .map((l) => l.p99_ms ?? l.p99Ms ?? l.max_ms ?? l.maxMs)
    .filter((v): v is number => typeof v === 'number' && Number.isFinite(v));
  return quantile(values, 0.99);
}

/** Three browser processing flags all false in the logged settings (spec 7.3). */
export function micFlagsOff(mic: MicSettings | null): boolean {
  return mic !== null && mic.echoCancellation === false && mic.noiseSuppression === false && mic.autoGainControl === false;
}

/**
 * Sample rate for the hard condition (spec 6.3): audio.wav, the AudioContext and the microphone
 * track as logged. The first of them that is not 48000 Hz, else 48000.
 */
export function recordingSampleRateHz(session: SessionData): number {
  const mic = session.micSettings;
  const rates = [session.sampleRateHz, mic?.contextSampleRate, mic?.sampleRate].filter(
    (r): r is number => typeof r === 'number' && Number.isFinite(r) && r > 0,
  );
  return Math.round(rates.find((r) => r !== SAMPLE_RATE_HZ) ?? SAMPLE_RATE_HZ);
}

/** kProcessingFailed: before the first packet tap answers it with reset() and one restart (spec 7.1). */
export const SDK_RESTART_CODE = 8;

/**
 * SDK errors of the recording (spec 6.3): `e` lines of samples.jsonl and host's `sdk_error` events,
 * whichever count is larger (they repeat each other; an exception from start() gives only the event).
 * One code-8 error before the first packet is left out of each count: tap restarts once on it
 * (spec 7.1, live/reduce.cjs errorAction). An event is before the first packet when it has no
 * sample number or one at or before the first `arr` stamp.
 *
 * `e` lines count up to the last packet Deck stamped (`arr`): tap logs every SDK callback, also
 * one during stopAsync() after the recording, when the worker no longer reads tap and host no
 * longer writes events (spec 7.2). An error inside the recording that no packet follows still
 * counts through host's event. Without any stamped packet every `e` line counts.
 */
export function sdkErrorCount(session: SessionData, during: (ev: EventLine) => boolean = () => true): number {
  const arrivals = arrivalsBySeq(session.stamps);
  let lastStamped = -1;
  session.samples.forEach((l, i) => {
    if (l.k === 'm' && typeof l.seq === 'number' && arrivals.has(l.seq)) lastStamped = i;
  });
  const linesEnd = lastStamped < 0 ? session.samples.length : lastStamped;
  let packetSeen = false;
  let restartLine = false;
  let lines = 0;
  session.samples.forEach((l, i) => {
    if (l.k === 'm') packetSeen = true;
    else if (l.k === 'e') {
      if (!packetSeen && !restartLine && l.code === SDK_RESTART_CODE) restartLine = true;
      else if (i < linesEnd) lines++;
    }
  });
  let firstArr = Number.POSITIVE_INFINITY;
  for (const s of session.stamps) if (s.k === 'arr' && s.n < firstArr) firstArr = s.n;
  let restartEvent = false;
  let events = 0;
  for (const ev of session.events) {
    if (ev.e !== 'sdk_error' || !during(ev)) continue;
    const beforeFirstPacket = typeof ev.n !== 'number' || ev.n <= firstArr;
    if (!restartEvent && beforeFirstPacket && ev['code'] === SDK_RESTART_CODE) restartEvent = true;
    else events++;
  }
  return Math.max(lines, events);
}

/** L_rt of loop checks A and B, read through the chunk layout (clicks inside a gap are not found). */
export function measureLoopBlocks(
  session: SessionData,
  opts: LoopOptions = {},
  layout: ChunkLayout = chunkLayout(session.stamps, session.ch0.length),
): { A: LoopMeasurement | null; B: LoopMeasurement | null } {
  const rate = opts.sampleRateHz ?? session.sampleRateHz;
  const maxLag = Math.round(((opts.maxLagMs ?? LOOP_MAX_LAG_MS) * rate) / 1000);
  const span = 2 * QUANTUM_SAMPLES + CLICK_SAMPLES + maxLag;
  const blocks = loopClickBlocks(session.stamps);
  const measure = (ns: number[] | null): LoopMeasurement | null => {
    if (!ns) return null;
    const starts = ns.map((n) => {
      const idx = audioIndex(layout, n - QUANTUM_SAMPLES, span);
      return idx === null ? Number.NaN : idx + QUANTUM_SAMPLES;
    });
    return measureLoopLatency(session.ch0, session.ch1, starts, { ...opts, sampleRateHz: rate });
  };
  return { A: measure(blocks.A), B: measure(blocks.B) };
}

export interface StopCheck {
  /** `n` of the hold stamp: the sample where the fade started. */
  nCmd: number;
  nSilent: number | null;
  /**
   * End of the checked range: the first stamp after the hold that lets Deck play again (a
   * `resume`, a `state` narrating or resume, as at a passage start) or a `click`; else the end of the recording.
   */
  nEnd: number;
  cause: string | null;
  seq: number | null;
  nArr: number | null;
  /** Channel 1 is zero on [nSilent, nEnd). */
  silent: boolean;
}

/** Stamps after which Deck may play again: the end of a stop's silent range (spec 6.4, 7.3). */
function playsAgain(s: Stamp): boolean {
  return s.k === 'resume' || s.k === 'click' || (s.k === 'state' && (s.s === 'narrating' || s.s === 'resume'));
}

/**
 * Each live stop (stamps.jsonl `hold`) against zeros in channel 1 from nSilent to the resume
 * (spec 6.3, 10.6). A stop whose range is empty (Deck played again before nSilent) or crosses a
 * lost block is not confirmed.
 */
export function stopChecks(
  session: SessionData,
  layout: ChunkLayout = chunkLayout(session.stamps, session.ch0.length),
  silenceAbsMax = 0,
): StopCheck[] {
  const recEnd = recordedSpan(layout)?.n1 ?? 0;
  const ends = session.stamps.filter(playsAgain).map((s) => s.n).sort((a, b) => a - b);
  const arrivals = arrivalsBySeq(session.stamps);
  return session.stamps
    .filter((s) => s.k === 'hold')
    .map((h): StopCheck => {
      const nSilent = typeof h.nSilent === 'number' ? h.nSilent : null;
      const seq = typeof h.seq === 'number' ? h.seq : null;
      let nEnd = h.n;
      let silent = false;
      if (nSilent !== null) {
        nEnd = ends.find((n) => n > h.n) ?? recEnd;
        const length = nEnd - nSilent;
        const idx = length > 0 ? audioIndex(layout, nSilent, length) : null;
        if (idx !== null && idx + length <= session.ch1.length) {
          silent = true;
          for (let i = idx; i < idx + length; i++) {
            if (Math.abs(session.ch1[i]!) > silenceAbsMax) {
              silent = false;
              break;
            }
          }
        }
      }
      return {
        nCmd: h.n,
        nSilent,
        nEnd,
        cause: h.cause ?? null,
        seq,
        nArr: seq === null ? null : (arrivals.get(seq) ?? null),
        silent,
      };
    });
}

export interface ClockCheckOptions {
  /** false for recordings without the camera (space-bar block, listening without camera): no trace conditions. */
  camera?: boolean;
  /** Precomputed loop checks (for example to reuse them for calib.json). */
  loop?: { A: LoopMeasurement | null; B: LoopMeasurement | null };
  loopOptions?: LoopOptions;
  lrt?: LrtThresholds;
  traceRateMinPerS?: number;
  /** Largest |sample| still counted as zero in channel 1 (default 0: exact zeros). */
  silenceAbsMax?: number;
}

export interface ClockCheckDetails {
  /** clock_report.json */
  report: ClockReport;
  /** calib.json `L_rt_ms` (spec 8.1): A, B, spreads, the rule of spec 6.3 and the value used. */
  lrt: CalibLrt;
  loop: { A: LoopMeasurement | null; B: LoopMeasurement | null };
  stops: StopCheck[];
  layout: ChunkLayout;
  /** Page loss events during the recording (PAGE_LOSS_EVENTS); the report has no field for them. */
  pageLosses: EventLine[];
  /** Failed hard conditions in words; empty when the recording passes. */
  failures: string[];
}

/** Start of the failure line for a lost recording page (spec 6.3: a reload cancels the session). */
const PAGE_LOSS_WORDS = 'page reloaded or lost, or Deck failed, during the recording';

/**
 * The clock check of one recording (spec 6.3, 7.12) with everything it measured: the report,
 * the L_rt rule for calib.json, the loop checks and the stop checks.
 */
export function clockCheckDetails(session: SessionData, opts: ClockCheckOptions = {}): ClockCheckDetails {
  const camera = opts.camera ?? true;
  const layout = chunkLayout(session.stamps, session.ch0.length);
  const loop = opts.loop ?? measureLoopBlocks(session, opts.loopOptions, layout);
  const lrt = loopRule(loop.A, loop.B, opts.lrt);

  // Window, device and tap events count inside the recorded span; an event without a sample
  // number cannot be placed outside it, so it counts too (assumption).
  const span = recordedSpan(layout);
  const during = (ev: EventLine): boolean =>
    typeof ev.n !== 'number' || span === null || (ev.n >= span.n0 && ev.n <= span.n1);
  const count = (pred: (ev: EventLine) => boolean): number => session.events.filter((ev) => pred(ev) && during(ev)).length;
  const gapEvents = session.events.filter((ev) => AUDIO_GAP_EVENTS.has(ev.e)).length;
  const pageLosses = session.events.filter((ev) => isPageLossEvent(ev) && during(ev));

  const traceRate = camera ? traceRateMedian(session.samples) : null;
  const stops = stopChecks(session, layout, opts.silenceAbsMax);
  const chestDiffs = stops.filter((s) => s.cause === 'chest' && s.nArr !== null).map((s) => s.nCmd - s.nArr!);
  const notSent = notSentShare(session.samples);
  const okShare = statusOkShare(session.samples);
  const loopP99 = tapLoopP99Ms(session.samples);

  const report: ClockReport = {
    schema: 'clock-report/1',
    audio_valid: false,
    trace_valid: false,
    chain: {
      L_rt_ms: [lrt.A, lrt.B],
      spread_ms: lrt.spread,
      // Spec 7.12 lists the rule's outcome in the report; calib.json holds the same (spec 8.1).
      rule: lrt.rule,
      quantum_ms: round1(quantumMs(session.sampleRateHz)),
      stops: stops.length,
      stops_match_ch1: stops.filter((s) => s.silent).length,
      // Chest stops only (voice and key stops have no packet); the difference farthest from 0
      // (spec 6.3: 0 for live D1, one message).
      nCmd_minus_nArr:
        chestDiffs.length === 0 ? null : chestDiffs.reduce((a, b) => (Math.abs(b) > Math.abs(a) ? b : a)),
    },
    onset: null,
    hard: {
      chunks_contiguous: layout.contiguous && session.ch0.length === session.ch1.length && gapEvents === 0,
      sample_rate: recordingSampleRateHz(session),
      mic_flags_off: micFlagsOff(session.micSettings),
      device_events: count(isDeviceEvent),
      visibility_events: count(isPageHiddenEvent),
      trace_rate_median: traceRate === null ? null : round1(traceRate),
      sdk_errors: sdkErrorCount(session, during),
      tap_lost: count((ev) => ev.e === 'tap_lost'),
    },
    warn: {
      not_sent_share: notSent === null ? null : round3(notSent),
      tap_loop_p99_ms: loopP99 === null ? null : round1(loopP99),
      status_ok_share: okShare === null ? null : round3(okShare),
      window_warnings: count((ev) => WINDOW_WARNING_EVENTS.has(ev.e)),
    },
  };
  const audio = audioFailures(report, opts, lrt.rule);
  if (pageLosses.length > 0) audio.push(`${PAGE_LOSS_WORDS} (${[...new Set(pageLosses.map((ev) => ev.e))].join(', ')})`);
  const trace = camera ? traceFailures(report, opts) : [];
  report.audio_valid = audio.length === 0;
  // Without the camera there is no trace to judge (spec 7.12): null, as core/schemas defines it.
  report.trace_valid = camera ? trace.length === 0 : null;
  return { report, lrt, loop, stops, layout, pageLosses, failures: [...audio, ...trace] };
}

/** clock_report.json of one recording (spec 6.3, 7.12, 8.1). `onset` stays null until the label step. */
export function clockCheck(session: SessionData, opts: ClockCheckOptions = {}): ClockReport {
  return clockCheckDetails(session, opts).report;
}

interface FailureOptions {
  camera?: boolean;
  lrt?: LrtThresholds;
  traceRateMinPerS?: number;
}

/**
 * The L_rt rule of a report: the one the check decided on the measured values (`chain.rule`);
 * with other thresholds, or without a rule, it is judged again on the printed values.
 */
function reportRule(report: ClockReport, opts: FailureOptions): LrtRule {
  if (report.chain.rule !== undefined && opts.lrt === undefined) return report.chain.rule;
  const [a, b] = report.chain.L_rt_ms;
  const at = (ms: number | null) => (ms === null ? null : { L_rt_ms: ms, spread_ms: null });
  return loopRule(at(a), at(b), opts.lrt).rule;
}

function audioFailures(report: ClockReport, opts: FailureOptions, rule: LrtRule = reportRule(report, opts)): string[] {
  const out: string[] = [];
  const { hard: h, chain: c } = report;
  const [a, b] = c.L_rt_ms;
  if (!h.chunks_contiguous) out.push('audio blocks not contiguous');
  if (a === null || b === null) out.push('loop check A or B not found');
  else if (rule === 'void') {
    out.push(`L_rt of loop checks A and B differs by more than ${opts.lrt?.bothMaxMs ?? LRT_BOTH_MAX_MS} ms`);
  }
  if (h.sample_rate !== SAMPLE_RATE_HZ) out.push(`sample rate ${h.sample_rate} Hz, not ${SAMPLE_RATE_HZ}`);
  if (!h.mic_flags_off) out.push('microphone processing not off');
  if (h.device_events > 0) out.push(`${h.device_events} device event(s) during the recording`);
  if (h.visibility_events > 0) out.push(`page hidden ${h.visibility_events} time(s) during the recording`);
  if (c.stops_match_ch1 < c.stops) {
    out.push(`channel 1 not silent after ${c.stops - c.stops_match_ch1} of ${c.stops} stops`);
  }
  return out;
}

function traceFailures(report: ClockReport, opts: FailureOptions): string[] {
  const out: string[] = [];
  const h = report.hard;
  const min = opts.traceRateMinPerS ?? TRACE_RATE_MIN_PER_S;
  if (h.trace_rate_median === null || h.trace_rate_median < min) {
    out.push(`trace rate median ${h.trace_rate_median ?? 'unknown'} per s, below ${min}`);
  }
  if (h.sdk_errors > 0) out.push(`${h.sdk_errors} SDK error event(s)`);
  if (h.tap_lost > 0) out.push(`tap lost ${h.tap_lost} time(s)`);
  return out;
}

/**
 * Failed hard conditions of a clock report in words, empty when it passes (for RE-RECORD NOW
 * lines and logs). A report with `trace_valid: null` is from a recording without the camera:
 * its trace conditions are skipped unless `camera` says otherwise. Invalid audio that no field
 * explains is a lost page: only events.jsonl names it (ClockCheckDetails.failures does). With
 * other L_rt thresholds the fields are judged again and `audio_valid` is not read.
 */
export function hardFailures(report: ClockReport, opts: FailureOptions = {}): string[] {
  const camera = opts.camera ?? report.trace_valid !== null;
  const audio = audioFailures(report, opts);
  if (!report.audio_valid && audio.length === 0 && opts.lrt === undefined) audio.push(`${PAGE_LOSS_WORDS} (see events.jsonl)`);
  return [...audio, ...(camera ? traceFailures(report, opts) : [])];
}

/** One labelled event: automatic and manual voice onsets in channel 0 samples. */
export interface OnsetPair {
  autoNv: number;
  manualNv: number;
  /** A soft first sound, as flagged by the label step. */
  soft?: boolean;
}

/** The report's `onset` block after the label step (spec 6.3, 7.12): P90 of |auto - manual| (type 7). */
export function onsetBlock(pairs: readonly OnsetPair[], sampleRateHz: number = SAMPLE_RATE_HZ): OnsetErrorBlock {
  const diffs = pairs.map((p) => (Math.abs(p.autoNv - p.manualNv) * 1000) / sampleRateHz);
  const p90 = quantile(diffs, 0.9);
  return {
    p90_abs_auto_minus_manual_ms: p90 === null ? null : round1(p90),
    events: pairs.length,
    soft_first_sounds: pairs.filter((p) => p.soft === true).length,
  };
}
