// In-memory view of a session folder (spec 8.1) as far as the clock module reads it,
// and the objects it writes into calib.json and clock_report.json (spec 8.1).
// File shapes come from core/schemas (type-only import: nothing of it is bundled).

import type { Calib, ClockReport as SchemaClockReport } from '../schemas/reports.ts';

/** One stamps.jsonl line (spec 8.1). Only the fields the clock module reads are typed. */
export interface Stamp {
  n: number;
  /** chunk | click | mark | arr | hold | state | voice | resume | ignored */
  k: string;
  /** chunk: block length; `n` is its first sample (`n0` on the socket). */
  frames?: number;
  /** click: index within its loop check, 0-9. */
  i?: number;
  /** arr, hold, ignored: SDK callback counter of the packet. */
  seq?: number;
  /** hold: chest | voice | key */
  cause?: string;
  /** hold: first silent sample, nCmd + 384. `n` of a hold stamp is nCmd. */
  nSilent?: number;
  word?: number | null;
  /** state: narrating | hold_wait | listening | resume */
  s?: string;
  /** voice: edge direction; mark `cue`: dot filled or emptied. */
  on?: boolean;
  /** mark: step | cue | key; ignored: hold | key */
  what?: string;
  name?: string;
}

/** One samples.jsonl line (spec 7.1, 8.1). */
export interface SampleLine {
  /** SDK callback counter; `l` lines have none. */
  seq?: number;
  /** m packet | v validationStatus | s processingStatus | f frameSentThrough | e error | l event-loop delay */
  k: string;
  tArrNs?: string;
  tsCbUs?: number;
  /** Trace samples [ts in us, value]. */
  tr?: ReadonlyArray<readonly [number, number]>;
  /** talking flag samples [ts in us, 0 | 1]. */
  talk?: ReadonlyArray<readonly [number, number]>;
  /** Lip gap (spec 7.5); null on a reset frame. */
  g?: number | null;
  hm?: number | null;
  lm?: { ts: number; reset: number; p: ReadonlyArray<readonly [number, number]> } | null;
  /** v, s, e: status or error code. */
  code?: number;
  name?: string;
  /** v: the SDK's hint text. */
  hint?: string;
  /** f: false when the frame was not sent through (spec 7.12 question 5). */
  sent?: boolean;
  /** e: error text and the SDK's retryable flag. */
  message?: string;
  retryable?: boolean;
  /** l: number of event-loop delay samples in the second. */
  n?: number;
  /** l: event-loop delay of tap over the last second, ms (core/schemas names). */
  p50_ms?: number;
  p99_ms?: number;
  max_ms?: number;
  /** l: the same, as live/tap.cjs writes them. */
  p50Ms?: number;
  p99Ms?: number;
  maxMs?: number;
}

/** One events.jsonl line (spec 8.1, docs/protocol.md). */
export interface EventLine {
  /** Sample number; null when no sample clock existed yet. */
  n?: number | null;
  e: string;
  [key: string]: unknown;
}

/** Microphone settings as logged from getSettings() (spec 7.3), plus what the page adds. */
export interface MicSettings {
  sampleRate?: number;
  channelCount?: number;
  echoCancellation?: boolean;
  noiseSuppression?: boolean;
  autoGainControl?: boolean;
  deviceId?: string;
  /** AudioContext sample rate, added by the page (docs/protocol.md `hello`). */
  contextSampleRate?: number;
  [key: string]: unknown;
}

/** A recorded session in memory: audio.wav channels plus the parsed journals. */
export interface SessionData {
  /** audio.wav sample rate. */
  sampleRateHz: number;
  /** Channel 0: microphone. Index i is the i-th recorded sample, not sample number n (they differ after a gap). */
  ch0: Float32Array;
  /** Channel 1: Deck output after gain. */
  ch1: Float32Array;
  stamps: readonly Stamp[];
  samples: readonly SampleLine[];
  events: readonly EventLine[];
  /** Logged getSettings() of the microphone track; null when missing. */
  micSettings: MicSettings | null;
}

export type LrtRule = 'mean' | 'both' | 'void';

/** calib.json `L_rt_ms` (spec 8.1). Every field is present (core/schemas allows them optional). */
export interface CalibLrt {
  A: number | null;
  B: number | null;
  spread: [number | null, number | null];
  rule: LrtRule;
  /** The mean under rule `mean`; null under `both` (every value applies) and `void`. */
  used: number | null;
}

/** calib.json `camera_clock` (spec 8.1). */
export type CalibCameraClock = NonNullable<Calib['camera_clock']>;

/** calib.json `sniff_lag_ms` (spec 8.1), gate recordings only. */
export type CalibSniffLag = NonNullable<Calib['sniff_lag_ms']>;

/** clock_report.json (spec 7.12, 8.1): measured numbers only. The shape of core/schemas. */
export type ClockReport = SchemaClockReport;

/** clock_report.json `onset` block, written by the label step (spec 7.12, 8.1). */
export type OnsetErrorBlock = NonNullable<ClockReport['onset']>;
