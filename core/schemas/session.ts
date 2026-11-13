// Live-recording files of the session folder (spec 8.1): manifest.json, stamps.jsonl,
// samples.jsonl, sdk_raw.jsonl.gz lines, detector_in.jsonl, events.jsonl.
// Field sets follow the spec examples; where the spec leaves a field to its writer
// (host, tap, Deck, worker), the validators accept what those writers produce today.

import {
  arrayOf, bool, describe, fail, int, isPlainObject, jsonValue, lit, makeValidator, mapOf, nullable, num,
  obj, oneOf, primitive, str, tuple, type Spec, type Validator,
} from './check.ts';
import {
  GATE_PACKS, HOLD_CAUSES, NARRATOR_STATES, RELATIVE_FILE, commitOrNull, microsUs, nsString, recordKind, sampleN,
  sessionId, sha256Hex, sha256Prefixed, utcTime,
  type GatePack, type HoldCause, type NarratorState, type RecordKind, type TimedFlag, type TimedValue,
} from './common.ts';
import { FADE_SAMPLES, LANDMARK_COUNT, plusZero } from './precision.ts';

// ---- shared pieces -----------------------------------------------------------

/** [ts, value] pairs of the breathing trace: ts in integer µs, value written unrounded. */
export const tracePairs: Spec = arrayOf(tuple([microsUs, num()], 'a pair [ts, value]'));

/** [ts, flag] pairs of the SDK `talking` flag, flag 0 or 1. */
export const talkPairs: Spec = arrayOf(tuple([microsUs, oneOf([0, 1])], 'a pair [ts, 0 or 1]'));

/** Lip gap g and head motion hm: unrounded numbers, null on a reset frame (spec 7.1, 8.1). */
const numOrNull: Spec = nullable(num());

const LANDMARK_REASON = 'face landmark coordinates stay in samples.jsonl (spec 8.1, 8.7, 12.3)';

/** Field names that would carry face landmark coordinates; never allowed outside samples.jsonl. */
export const LANDMARK_FIELDS: Readonly<Record<string, string>> = {
  lm: LANDMARK_REASON,
  p: LANDMARK_REASON,
  landmarks: LANDMARK_REASON,
  points: LANDMARK_REASON,
};

const seqN: Spec = int({ min: 0, what: 'an SDK callback number (non-negative integer)' });
const sdkCode: Spec = int({ min: 0, what: 'an SDK status or error code (non-negative integer)' });
const narratorState: Spec = oneOf(NARRATOR_STATES);
/** Word number of the passage; null when the passage has no word timings (Deck, assumption). */
const wordOrNull: Spec = nullable(int({ min: 0, what: 'a word number (non-negative integer)' }));

// ---- manifest.json -------------------------------------------------------------

export interface ManifestSdk {
  /** SDK version pinned in live/package.json (spec 13.6); null when host could not read it. */
  version: string | null;
  /** Metrics asked from the SDK; null until tap reports them. */
  metrics: string[] | null;
  launcher: 'node' | 'electron';
}

export interface ManifestCamera {
  /** Name from availableCameras(); null when tap did not report it. */
  name: string | null;
  /** [width, height, fps] asked from the SDK. */
  requested: [number, number, number];
}

export interface ManifestAudio {
  /** Microphone name as the system shows it; null when the page did not report it. */
  microphone: string | null;
  /** Measured sample rate of the track; null when unknown. */
  sample_rate: number | null;
  mic_flags_off: boolean;
  /** Deck output gain from the latest doctor (spec 7.7); null before any doctor run. */
  output_gain: number | null;
  /** Output device name, when the page reports it. */
  output?: string | null;
  /** getSettings() of the microphone track, plain values only (spec 7.3). */
  settings?: Record<string, string | number | boolean | null> | null;
  /** Further audio facts host adds (block counts, gaps). */
  [extra: string]: unknown;
}

/**
 * manifest.json: mode, versions, devices, seal, file hashes (spec 8.1). The spec example's
 * fields are typed; host adds more (mode, scenario, state, end, ...), which are allowed.
 * Values host cannot know are null (no git checkout, no device label).
 */
export interface Manifest {
  schema: 'session/1';
  id: string;
  kind: RecordKind;
  /** Day-1 pack (spec 9.4), only for kind "gate". */
  pack?: GatePack | null;
  started_utc: string;
  app_commit: string | null;
  tree_clean: boolean | null;
  /** 64 hex of the sealed plan, null when the record has no plan. */
  plan_commitment: string | null;
  /** null without the SDK (space-bar block, doctor, listening without camera). */
  sdk: ManifestSdk | null;
  machine: string;
  camera: ManifestCamera | null;
  audio: ManifestAudio;
  /** File name to "sha256:<hex>". */
  files: Record<string, string>;
  /** Local paths: only in the session folder, removed by pack (assumption). */
  paths?: Record<string, string>;
  /**
   * host's marker: true when tap ran its stand-in SDK (tap --dry, tests only; docs/protocol.md).
   * Such a folder is no recording and never counts (spec 6.5): quickcheck and smoke refuse it.
   */
  dry?: boolean;
  [extra: string]: unknown;
}

/**
 * Record kinds that narrate a sealed plan: the page shows its seal and host writes all 64
 * characters into manifest.json before the narration; reveal checks them (spec 8.3 items 3, 4).
 */
export const SEALED_PLAN_KINDS: readonly RecordKind[] = ['numbers', 'spacebar', 'rehearsal', 'demo', 'pilot'];

/**
 * Record kinds without a sealed plan: plan_commitment is null. The day-1 gate reads fixed
 * packs; doctor and smoke read no draft. The development runs (headstart, live_from,
 * live_sim) may carry the seal of what they read or null (assumption).
 */
export const PLANLESS_KINDS: readonly RecordKind[] = ['gate', 'doctor', 'smoke'];

export const manifestSpec: Spec = obj({
  required: {
    schema: lit('session/1'),
    id: sessionId,
    kind: recordKind,
    started_utc: utcTime,
    app_commit: commitOrNull,
    tree_clean: nullable(bool),
    plan_commitment: nullable(sha256Hex),
    sdk: nullable(
      obj({
        required: {
          version: nullable(str()),
          metrics: nullable(
            arrayOf(str({ pattern: /^[A-Z][A-Z0-9_]*$/, what: 'an SDK metric name like "CHEST_BREATHING"' }), { min: 1 }),
          ),
          launcher: oneOf(['node', 'electron']),
        },
      }),
    ),
    machine: str(),
    camera: nullable(
      obj({
        required: {
          name: nullable(str()),
          requested: tuple([int({ min: 1 }), int({ min: 1 }), int({ min: 1 })], '[width, height, fps]'),
        },
      }),
    ),
    audio: obj({
      required: {
        microphone: nullable(str()),
        sample_rate: nullable(int({ min: 1, what: 'a sample rate in Hz' })),
        mic_flags_off: bool,
        output_gain: nullable(num({ min: 0 })),
      },
      optional: {
        output: nullable(str()),
        settings: nullable(mapOf(primitive)),
      },
      open: jsonValue,
    }),
    files: mapOf(sha256Prefixed, { key: RELATIVE_FILE, keyWhat: 'a relative file name' }),
  },
  optional: {
    pack: nullable(oneOf(GATE_PACKS)),
    paths: mapOf(str()),
    dry: bool,
  },
  open: jsonValue,
  check: (o, p, out) => {
    const at = (k: string): string => (p === '' ? k : `${p}.${k}`);
    const kind = o['kind'] as RecordKind;
    if (o['pack'] !== undefined && o['pack'] !== null && kind !== 'gate') {
      fail(out, at('pack'), `only a "gate" record has a pack, this one is "${String(kind)}"`);
    }
    if (SEALED_PLAN_KINDS.includes(kind) && o['plan_commitment'] === null) {
      fail(out, at('plan_commitment'), `a ${kind} record narrates a sealed plan: host writes its 64-character seal here before the narration (spec 8.3)`);
    }
    if (PLANLESS_KINDS.includes(kind) && o['plan_commitment'] !== null) {
      fail(out, at('plan_commitment'), `a ${kind} record narrates no sealed plan: expected null (spec 8.3)`);
    }
  },
});

export const validateManifest: Validator<Manifest> = makeValidator(manifestSpec);

// ---- stamps.jsonl -------------------------------------------------------------

export interface StampChunk { n: number; k: 'chunk'; frames: number }
export interface StampClick { n: number; k: 'click'; i: number }
export interface StampMark {
  n: number;
  k: 'mark';
  what: 'step' | 'cue' | 'key';
  /** Step name (required for "step"). */
  name?: string;
  /** Cue dot filled (true) or emptied (false). */
  on?: boolean;
  i?: number;
}
export interface StampArr { n: number; k: 'arr'; seq: number }
export interface StampHold {
  /** nCmd: the quantum where the hold was handled. */
  n: number;
  k: 'hold';
  cause: HoldCause;
  /** SDK packet, present for cause "chest". */
  seq?: number;
  /** n + 384. */
  nSilent: number;
  /** Interrupted word; null when the passage has no word timings. */
  word: number | null;
}
export interface StampState { n: number; k: 'state'; s: NarratorState }
export interface StampVoice { n: number; k: 'voice'; on: boolean }
export interface StampResume { n: number; k: 'resume'; word: number | null }
export interface StampIgnored {
  n: number;
  k: 'ignored';
  what: 'hold' | 'key';
  /** SDK packet, present for a "hold". */
  seq?: number;
  s: NarratorState;
}
export type StampLine =
  | StampChunk | StampClick | StampMark | StampArr | StampHold
  | StampState | StampVoice | StampResume | StampIgnored;

export const STAMP_KINDS = ['chunk', 'click', 'mark', 'arr', 'hold', 'state', 'voice', 'resume', 'ignored'] as const;
export type StampKind = (typeof STAMP_KINDS)[number];

const stampSpecs: Record<StampKind, Spec> = {
  chunk: obj({ required: { n: sampleN, k: lit('chunk'), frames: int({ min: 1, what: 'a frame count (positive integer)' }) } }),
  click: obj({ required: { n: sampleN, k: lit('click'), i: int({ min: 0 }) } }),
  mark: obj({
    required: { n: sampleN, k: lit('mark'), what: oneOf(['step', 'cue', 'key']) },
    optional: { name: str(), on: bool, i: int({ min: 0 }) },
    check: (o, p, out) => {
      if (o['what'] === 'step' && o['name'] === undefined) fail(out, p === '' ? 'name' : `${p}.name`, 'missing (a "step" mark names its step)');
    },
  }),
  arr: obj({ required: { n: sampleN, k: lit('arr'), seq: seqN } }),
  hold: obj({
    required: { n: sampleN, k: lit('hold'), cause: oneOf(HOLD_CAUSES), nSilent: sampleN, word: wordOrNull },
    optional: { seq: seqN },
    check: (o, p, out) => {
      if (o['cause'] === 'chest' && o['seq'] === undefined) fail(out, p === '' ? 'seq' : `${p}.seq`, 'missing (a "chest" hold names its SDK packet)');
      const n = o['n'] as number;
      const nSilent = o['nSilent'] as number;
      if (nSilent !== n + FADE_SAMPLES) {
        fail(out, p === '' ? 'nSilent' : `${p}.nSilent`, `must be n + ${FADE_SAMPLES} = ${n + FADE_SAMPLES}, got ${nSilent} (spec 6.2, 13.4)`);
      }
    },
  }),
  state: obj({ required: { n: sampleN, k: lit('state'), s: narratorState } }),
  voice: obj({ required: { n: sampleN, k: lit('voice'), on: bool } }),
  resume: obj({ required: { n: sampleN, k: lit('resume'), word: wordOrNull } }),
  // A hold message or key press that changes nothing: outside "narrating" (spec 8.1), or a
  // press in a mode where the space bar does not stop, or while the scenario ends (Deck).
  ignored: obj({
    required: { n: sampleN, k: lit('ignored'), what: oneOf(['hold', 'key']), s: narratorState },
    optional: { seq: seqN },
    check: (o, p, out) => {
      if (o['what'] === 'hold' && o['seq'] === undefined) fail(out, p === '' ? 'seq' : `${p}.seq`, 'missing (an ignored "hold" names its SDK packet)');
    },
  }),
};

/** Picks the spec by the string in `field`; unknown values give one readable message. */
function byField(field: string, specs: Record<string, Spec>, what: string): Spec {
  const names = Object.keys(specs).join(', ');
  return (v, p, out) => {
    if (!isPlainObject(v)) {
      fail(out, p, `expected an object, got ${describe(v)}`);
      return;
    }
    const at = p === '' ? field : `${p}.${field}`;
    const kind = v[field];
    if (kind === undefined) {
      fail(out, at, `missing (expected one of ${names})`);
      return;
    }
    const spec = typeof kind === 'string' && Object.hasOwn(specs, kind) ? specs[kind] : undefined;
    if (spec === undefined) fail(out, at, `unknown ${what} ${describe(kind)} (expected one of ${names})`);
    else spec(v, p, out);
  };
}

export const validateStampLine: Validator<StampLine> = makeValidator(byField('k', stampSpecs, 'stamp kind'));

// ---- samples.jsonl (written by tap) ---------------------------------------------

export interface SampleLandmarks {
  /** SDK timestamp of the landmark frame, integer µs. */
  ts: number;
  reset: 0 | 1;
  /** 16 points [x, y] in the order of LANDMARK_IDS; null for a point the frame lacks. */
  p: ([number, number] | null)[];
}
export interface SamplePacket {
  seq: number;
  k: 'm';
  tArrNs: string;
  tsCbUs: number;
  tr: TimedValue[];
  talk: TimedFlag[];
  g: number | null;
  hm: number | null;
  /** Last landmark frame of the packet; null when the packet had none. */
  lm?: SampleLandmarks | null;
}
/** validationStatus. tap adds `name` and `hint`. */
export interface SampleValidation { seq: number; k: 'v'; tArrNs: string; tsCbUs: number; code: number; name?: string; [extra: string]: unknown }
/** processingStatus. */
export interface SampleStatus { seq: number; k: 's'; tArrNs: string; code: number; name?: string; [extra: string]: unknown }
/** frameSentThrough. */
export interface SampleFrameSent { seq: number; k: 'f'; tArrNs: string; tsCbUs: number; sent: boolean; [extra: string]: unknown }
/** SDK error. tap adds `name`, `message` and `retryable`. */
export interface SampleError { seq: number; k: 'e'; tArrNs: string; code: number; name?: string; message?: string; [extra: string]: unknown }
/** Event-loop delay of tap, once a second (spec 7.1): ms values such as p50Ms, p99Ms, maxMs (tap's names). */
export interface SampleLoop { k: 'l'; tArrNs: string; [stat: string]: unknown }
export type SampleLine = SamplePacket | SampleValidation | SampleStatus | SampleFrameSent | SampleError | SampleLoop;

const point: Spec = nullable(tuple([num(), num()], 'a point [x, y]'));

/** Field names beyond seq, k, tArrNs and tsCbUs are tap's choice (spec 8.1): extra primitives are allowed. */
const sampleSpecs: Record<SampleLine['k'], Spec> = {
  m: obj({
    required: { seq: seqN, k: lit('m'), tArrNs: nsString, tsCbUs: microsUs, tr: tracePairs, talk: talkPairs, g: numOrNull, hm: numOrNull },
    optional: {
      lm: nullable(obj({ required: { ts: microsUs, reset: oneOf([0, 1]), p: arrayOf(point, { len: LANDMARK_COUNT }) } })),
    },
    check: (o, p, out) => {
      const lm = o['lm'];
      if (isPlainObject(lm) && lm['reset'] === 1 && (o['g'] !== null || o['hm'] !== null)) {
        fail(out, p, 'g and hm must be null on a frame with reset 1 (spec 8.1)');
      }
    },
  }),
  v: obj({ required: { seq: seqN, k: lit('v'), tArrNs: nsString, tsCbUs: microsUs, code: sdkCode }, optional: { name: str() }, open: primitive }),
  s: obj({ required: { seq: seqN, k: lit('s'), tArrNs: nsString, code: sdkCode }, optional: { name: str() }, open: primitive }),
  f: obj({ required: { seq: seqN, k: lit('f'), tArrNs: nsString, tsCbUs: microsUs, sent: bool }, open: primitive }),
  e: obj({
    required: { seq: seqN, k: lit('e'), tArrNs: nsString, code: sdkCode },
    optional: { name: str(), message: str({ nonEmpty: false }), retryable: bool },
    open: primitive,
  }),
  l: obj({ required: { k: lit('l'), tArrNs: nsString }, open: nullable(num({ min: 0, what: 'a delay statistic (number >= 0)' })) }),
};

export const validateSampleLine: Validator<SampleLine> = makeValidator(byField('k', sampleSpecs, 'samples kind'));

// ---- sdk_raw.jsonl.gz lines (written by tap, never published) ----------------------

export const SDK_EVENTS = ['metrics', 'validationStatus', 'processingStatus', 'frameSentThrough', 'error'] as const;
export type SdkEvent = (typeof SDK_EVENTS)[number];

export interface SdkRawLine {
  seq: number;
  kind: SdkEvent;
  tArrNs: string;
  tWallMs: number;
  /** timestampUs of metrics, validationStatus and frameSentThrough. */
  tsCbUs?: number;
  /** Buffer of the event, base64. */
  b64?: string;
  /** Arguments of an event without a buffer. */
  args?: unknown[];
}

export const validateSdkRawLine: Validator<SdkRawLine> = makeValidator(
  obj({
    required: { seq: seqN, kind: oneOf(SDK_EVENTS), tArrNs: nsString, tWallMs: int({ min: 0 }) },
    optional: {
      tsCbUs: microsUs,
      b64: str({ pattern: /^[A-Za-z0-9+/]*={0,2}$/, what: 'base64 text', nonEmpty: false }),
      args: arrayOf(jsonValue),
    },
    check: (o, p, out) => {
      const hasB64 = o['b64'] !== undefined;
      const hasArgs = o['args'] !== undefined;
      if (hasB64 === hasArgs) fail(out, p, 'expected exactly one of b64 and args (spec 8.1)');
      const kind = o['kind'];
      if (kind === 'metrics' && o['tsCbUs'] === undefined) fail(out, p === '' ? 'tsCbUs' : `${p}.tsCbUs`, 'missing (metrics has timestampUs)');
    },
  }),
);

// ---- detector_in.jsonl (worker: every detector input in processing order) ----------

export interface DetBatch {
  k: 'batch';
  seq: number;
  tr: TimedValue[];
  talk: TimedFlag[];
  g: number | null;
  hm: number | null;
}
export interface DetVal { k: 'val'; seq: number; code: number }
export interface DetVoice { k: 'voice'; n: number; on: boolean }
export interface DetState { k: 'state'; n: number; s: NarratorState }
export type DetectorInLine = DetBatch | DetVal | DetVoice | DetState;

const detectorSpecs: Record<DetectorInLine['k'], Spec> = {
  batch: obj({
    required: { k: lit('batch'), seq: seqN, tr: tracePairs, talk: talkPairs, g: numOrNull, hm: numOrNull },
    forbidden: LANDMARK_FIELDS,
  }),
  val: obj({ required: { k: lit('val'), seq: seqN, code: sdkCode }, forbidden: LANDMARK_FIELDS }),
  voice: obj({ required: { k: lit('voice'), n: sampleN, on: bool }, forbidden: LANDMARK_FIELDS }),
  state: obj({ required: { k: lit('state'), n: sampleN, s: narratorState }, forbidden: LANDMARK_FIELDS }),
};

export const validateDetectorInLine: Validator<DetectorInLine> = makeValidator(byField('k', detectorSpecs, 'detector input kind'));

/**
 * detector_in.jsonl line for an SDK line of samples.jsonl: "m" becomes "batch" (landmarks,
 * tArrNs and tsCbUs dropped), "v" becomes "val". Other kinds are no detector input: null.
 * tr values, g and hm keep every bit except the sign of zero: -0 becomes 0 (plusZero, spec 8.1).
 */
export function sampleToDetectorIn(line: SampleLine): DetBatch | DetVal | null {
  if (line.k === 'm') {
    const m = line as SamplePacket;
    return {
      k: 'batch',
      seq: m.seq,
      tr: m.tr.map(([t, v]): TimedValue => [t, plusZero(v)]),
      talk: m.talk.map(([t, f]): TimedFlag => [t, f]),
      g: m.g === null ? null : plusZero(m.g),
      hm: m.hm === null ? null : plusZero(m.hm),
    };
  }
  if (line.k === 'v') {
    const v = line as SampleValidation;
    return { k: 'val', seq: v.seq, code: v.code };
  }
  return null;
}

// ---- events.jsonl -------------------------------------------------------------------

/** Detector variants: D1, and D3 only if the retune ladder reaches it (spec 7.4, 9.8). */
export const DETECTORS = ['D1', 'D3'] as const;
export type DetectorName = (typeof DETECTORS)[number];

/** Events whose fields the spec example fixes (spec 8.1). */
export const SPEC_EVENT_NAMES = ['fire', 'hold', 'resume', 'armed'] as const;
export type SpecEventName = (typeof SPEC_EVENT_NAMES)[number];

interface EventCommon {
  /** Sample number on the 48 kHz clock. */
  n: number;
  /** Writer, when it is not the worker: host writes "host" (assumption). */
  by?: string;
}
export interface EventFire extends EventCommon { e: 'fire'; det: DetectorName; seq: number; v: number; theta: number }
export interface EventHold extends EventCommon {
  e: 'hold';
  cause: HoldCause;
  /** SDK packet of a chest stop. */
  seq?: number;
  nCmd: number;
  nSilent: number;
  word: number | null;
}
export interface EventResume extends EventCommon { e: 'resume'; word: number | null; why: 'voice_off' | 'timeout' }
export interface EventArmed extends EventCommon { e: 'armed'; det: DetectorName; on: boolean }

/**
 * Any other event: working names of spec 8.1 (preflight_ok, tap_lost), window and device
 * events of the page (spec 7.3), host events. `n` is null before the first audio block.
 */
export interface EventOther {
  n: number | null;
  e: string;
  by?: string;
  /** Page events say whether they make the recording unusable (docs/protocol.md). */
  hard?: boolean;
  [field: string]: unknown;
}
export type EventLine = EventFire | EventHold | EventResume | EventArmed | EventOther;

interface SpecEventMap { fire: EventFire; hold: EventHold; resume: EventResume; armed: EventArmed }

/** Type guard for the events of the spec example. */
export function isEvent<E extends SpecEventName>(ev: EventLine, e: E): ev is SpecEventMap[E] {
  return ev.e === e;
}

/** Event names in use besides the spec ones (spec 8.1 working names, docs/protocol.md, host). */
export const EVENT_NAMES = [
  ...SPEC_EVENT_NAMES, 'preflight_ok', 'tap_lost', 'sdk_error', 'audio_gap', 'consent', 'gain', 'tap',
  'visibilitychange', 'blur', 'resize', 'devicechange', 'track_ended', 'track_mute', 'page_reload', 'page_lost',
] as const;
export type EventName = (typeof EVENT_NAMES)[number];

/** Hard device events (spec 6.3, 8.1: counted in clock_report device_events). */
export const HARD_WINDOW_EVENTS: readonly string[] = ['devicechange', 'track_ended', 'track_mute'];
/** Window events that only warn (spec 8.1: counted in window_warnings). */
export const WARNING_WINDOW_EVENTS: readonly string[] = ['blur', 'resize'];

/** A hidden page (spec 6.3, 7.3): a visibilitychange that does not say the page became visible. */
export function isPageHiddenEvent(ev: EventLine): boolean {
  if (ev.e !== 'visibilitychange') return false;
  const o = ev as EventOther;
  return !(o['state'] === 'visible' || o['hidden'] === false);
}

/** True for a hard window or device event: device change, track ended or muted, hidden page. */
export function isHardWindowEvent(ev: EventLine): boolean {
  return HARD_WINDOW_EVENTS.includes(ev.e) || isPageHiddenEvent(ev);
}

/** Counts for clock_report hard.device_events, hard.visibility_events and warn.window_warnings (spec 8.1). */
export function countWindowEvents(events: readonly EventLine[]): { device: number; visibility: number; warnings: number } {
  let device = 0;
  let visibility = 0;
  let warnings = 0;
  for (const e of events) {
    if (isPageHiddenEvent(e)) visibility++;
    else if (HARD_WINDOW_EVENTS.includes(e.e)) device++;
    else if (WARNING_WINDOW_EVENTS.includes(e.e)) warnings++;
  }
  return { device, visibility, warnings };
}

const eventName: Spec = str({ pattern: /^[a-z][a-z0-9_]*$/, what: 'an event name in lower case, like "preflight_ok"' });
const detName: Spec = oneOf(DETECTORS);
const common = { by: str() };

/** Spec events: exactly the example's fields (plus `by`). */
const strictEvents: Record<SpecEventName, Spec> = {
  fire: obj({
    required: { n: sampleN, e: lit('fire'), det: detName, seq: seqN, v: num(), theta: num() },
    optional: common,
    forbidden: LANDMARK_FIELDS,
  }),
  // seq is optional: the spec example has none; the fire line at the same n names the packet.
  hold: obj({
    required: { n: sampleN, e: lit('hold'), cause: oneOf(HOLD_CAUSES), nCmd: sampleN, nSilent: sampleN, word: wordOrNull },
    optional: { ...common, seq: seqN },
    forbidden: LANDMARK_FIELDS,
    check: (o, p, out) => {
      const nCmd = o['nCmd'] as number;
      const nSilent = o['nSilent'] as number;
      if (nSilent !== nCmd + FADE_SAMPLES) {
        fail(out, p === '' ? 'nSilent' : `${p}.nSilent`, `must be nCmd + ${FADE_SAMPLES} = ${nCmd + FADE_SAMPLES}, got ${nSilent} (spec 6.2, 13.4)`);
      }
    },
  }),
  resume: obj({
    required: { n: sampleN, e: lit('resume'), word: wordOrNull, why: oneOf(['voice_off', 'timeout']) },
    optional: common,
    forbidden: LANDMARK_FIELDS,
  }),
  armed: obj({
    required: { n: sampleN, e: lit('armed'), det: detName, on: bool },
    optional: common,
    forbidden: LANDMARK_FIELDS,
  }),
};

const eventN: Spec = nullable(sampleN);

/** Typed fields of other known events; any further field is a JSON value. */
const otherEventFields: Record<string, { required?: Record<string, Spec>; optional?: Record<string, Spec> }> = {
  visibilitychange: { required: { state: oneOf(['visible', 'hidden']) } },
  resize: { optional: { w: int({ min: 0 }), h: int({ min: 0 }) } },
  gain: { required: { value: num({ min: 0 }) }, optional: { db: num(), final: bool } },
  sdk_error: { optional: { code: nullable(int({ min: 0 })), name: nullable(str()), message: str({ nonEmpty: false }) } },
  audio_gap: { optional: { expected: sampleN, got: sampleN, missing: int() } },
};

function otherEvent(name: string): Spec {
  const f = otherEventFields[name] ?? {};
  return obj({
    required: { n: eventN, e: eventName, ...(f.required ?? {}) },
    optional: { by: str(), hard: bool, ...(f.optional ?? {}) },
    forbidden: LANDMARK_FIELDS,
    open: jsonValue,
  });
}

const eventSpec: Spec = (v, p, out) => {
  if (!isPlainObject(v)) {
    fail(out, p, `expected an object, got ${describe(v)}`);
    return;
  }
  const e = v['e'];
  if (e === undefined) {
    fail(out, p === '' ? 'e' : `${p}.e`, 'missing (the event name, like "hold")');
    return;
  }
  const strict = typeof e === 'string' && Object.hasOwn(strictEvents, e) ? strictEvents[e as SpecEventName] : undefined;
  (strict ?? otherEvent(typeof e === 'string' ? e : ''))(v, p, out);
};

export const validateEventLine: Validator<EventLine> = makeValidator(eventSpec);

/**
 * Stop causes allowed per record kind: chest stops need live D1 (camera records), the space
 * bar stops only in the space-bar block (spec 10.7), the listening run without camera stops
 * only by the audio safety (spec 10.2). The day-1 gate never stops the narrator (spec 8.1).
 * Kinds not listed get only the generic rules of eventLogProblems.
 */
export const HOLD_CAUSES_BY_KIND: Readonly<Partial<Record<RecordKind, readonly HoldCause[]>>> = {
  gate: [],
  numbers: ['chest', 'voice'],
  rehearsal: ['chest', 'voice'],
  demo: ['chest', 'voice'],
  headstart: ['chest', 'voice'],
  spacebar: ['key', 'voice'],
  pilot: ['voice'],
};

/**
 * Problems of a whole events.jsonl for a record kind, each with its line number: stops and
 * fires the kind cannot have (spec 8.1, 10.2, 10.7), a chest stop without a detector fire at
 * its nCmd, a resume without a stop before it. Run it on lines that passed validateEventLine;
 * pass parseJsonl's lineNumbers so messages name the file's lines even when some were dropped
 * (without them, row k is line k + 1).
 */
export function eventLogProblems(kind: RecordKind, events: readonly EventLine[], lineNumbers?: readonly number[]): string[] {
  if (lineNumbers !== undefined && lineNumbers.length !== events.length) {
    throw new Error(`eventLogProblems: ${lineNumbers.length} line numbers for ${events.length} events`);
  }
  const problems: string[] = [];
  const allowed = HOLD_CAUSES_BY_KIND[kind];
  const at = (i: number): string => `events.jsonl line ${lineNumbers?.[i] ?? i + 1}`;
  const fireAt = new Set<number>();
  let openHold = false;
  events.forEach((ev, i) => {
    if (isEvent(ev, 'fire')) {
      if (kind === 'gate') problems.push(`${at(i)}: no "fire" lines in the day-1 gate: the narrator does not stop there (spec 8.1)`);
      else if (allowed !== undefined && !allowed.includes('chest')) problems.push(`${at(i)}: no live detector in a ${kind} record, so no "fire" line (spec 10.2, 10.7)`);
      fireAt.add(ev.n);
    } else if (isEvent(ev, 'hold')) {
      if (kind === 'gate') problems.push(`${at(i)}: no "hold" lines in the day-1 gate: the narrator does not stop there (spec 8.1)`);
      else if (allowed !== undefined && !allowed.includes(ev.cause)) {
        problems.push(`${at(i)}: a ${kind} record stops only by ${allowed.join(' or ')}, not by ${ev.cause} (spec 6.4, 10.2, 10.7)`);
      }
      if (ev.cause === 'chest' && !fireAt.has(ev.nCmd)) {
        problems.push(`${at(i)}: chest stop at nCmd ${ev.nCmd} without a detector "fire" line at that sample before it`);
      }
      openHold = true;
    } else if (isEvent(ev, 'resume')) {
      if (kind === 'gate') problems.push(`${at(i)}: no "resume" lines in the day-1 gate: the narrator does not stop there (spec 8.1)`);
      else if (!openHold) problems.push(`${at(i)}: "resume" without a "hold" before it`);
      openHold = false;
    }
  });
  return problems;
}
