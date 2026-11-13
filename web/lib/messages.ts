// Messages between the page, Deck, the worker and host (docs/protocol.md) and the file lines
// Deck and the worker produce (spec 8.1). Objects are built in the key order of the 8.1 examples
// (core/schemas KEY_ORDERS), because host writes them with JSON.stringify as they arrive.

import type { Step } from '../scenarios/format.ts';
import type { VadFrozenBlock } from './core.ts';

/**
 * Narrator states of spec 6.4, lower case as in the files (spec 8.1), plus `idle` while no clip
 * plays (core/schemas NARRATOR_STATES; the detector reads it as "not reading").
 */
export type NarratorState = 'idle' | 'narrating' | 'hold_wait' | 'listening' | 'resume';
export type HoldCause = 'chest' | 'voice' | 'key';

/**
 * How Deck treats stops (spec 6.4, 6.5, 10.2):
 * live:  chest holds and the audio safety act (session, rehearsal, demo, headstart, live-from);
 * key:   the space bar and the audio safety act (spacebar: the block without camera);
 * voice: only the audio safety acts (live-sim: a flat synthetic trace, D1 not active, spec 10.2);
 * gate:  Deck never stops the narrator (day-one check, short probe, doctor, smoke).
 */
export type DeckMode = 'live' | 'gate' | 'key' | 'voice';

const LIVE_MODES: ReadonlySet<string> = new Set(['live', 'session', 'rehearsal', 'demo', 'headstart', 'live-from']);
const KEY_MODES: ReadonlySet<string> = new Set(['key', 'spacebar']);
const VOICE_MODES: ReadonlySet<string> = new Set(['voice', 'live-sim']);

/** Deck mode for the /api/config `mode` (live/lib/args.cjs names). Unknown modes never stop. */
export function deckModeOf(configMode: unknown): DeckMode {
  if (typeof configMode !== 'string') return 'gate';
  if (LIVE_MODES.has(configMode)) return 'live';
  if (KEY_MODES.has(configMode)) return 'key';
  if (VOICE_MODES.has(configMode)) return 'voice';
  return 'gate';
}

/** True when something can stop the narrator in this mode, so HOLD_WAIT and LISTENING occur (spec 6.4). */
export function narratorStops(mode: DeckMode): boolean {
  return mode !== 'gate';
}

/** Click blocks of a clicks step: the loop checks A and B (spec 6.3), the demo take's sync clicks (spec 7.3, 15.4). */
export type ClickBlock = 'A' | 'B' | 'demo';
export const CLICK_BLOCKS: readonly ClickBlock[] = ['A', 'B', 'demo'];

/**
 * Where Deck's voice detector parameters come from: processorOptions.vadParams, DEFAULT_VAD_PARAMS
 * (none given, or unusable), or a {k:'vad'} message from the page during the run.
 */
export type VadSource = 'options' | 'default' | 'message';

// ---- stamps.jsonl (spec 8.1). Deck writes every kind except `chunk` (host writes that one). ----
export interface ArrStamp { n: number; k: 'arr'; seq: number }
export interface ChestHoldStamp { n: number; k: 'hold'; cause: 'chest'; seq: number; nSilent: number; word: number | null }
export interface OtherHoldStamp { n: number; k: 'hold'; cause: 'voice' | 'key'; nSilent: number; word: number | null }
export type HoldStamp = ChestHoldStamp | OtherHoldStamp;
export interface StateStamp { n: number; k: 'state'; s: NarratorState }
export interface VoiceStamp { n: number; k: 'voice'; on: boolean }
export interface ResumeStamp { n: number; k: 'resume'; word: number | null }
export interface IgnoredHoldStamp { n: number; k: 'ignored'; what: 'hold'; seq: number; s: NarratorState }
export interface IgnoredKeyStamp { n: number; k: 'ignored'; what: 'key'; s: NarratorState }
export interface ClickStamp { n: number; k: 'click'; i: number }
export interface StepMarkStamp { n: number; k: 'mark'; what: 'step'; name: string }
/** Cue number first: key order of core/schemas KEY_ORDERS['stamps.jsonl']. */
export interface CueMarkStamp { n: number; k: 'mark'; i: number; what: 'cue'; on: boolean }
export interface KeyMarkStamp { n: number; k: 'mark'; what: 'key' }
export type DeckStamp =
  | ArrStamp
  | HoldStamp
  | StateStamp
  | VoiceStamp
  | ResumeStamp
  | IgnoredHoldStamp
  | IgnoredKeyStamp
  | ClickStamp
  | StepMarkStamp
  | CueMarkStamp
  | KeyMarkStamp;

// ---- detector_in.jsonl (spec 8.1) ----
export type TracePair = [number, number];
export interface DetBatch { k: 'batch'; seq: number; tr: TracePair[]; talk: TracePair[]; g: number | null; hm: number | null }
export interface DetVal { k: 'val'; seq: number; code: number }
export interface DetVoice { k: 'voice'; n: number; on: boolean }
export interface DetState { k: 'state'; n: number; s: NarratorState }
export type DetectorLine = DetBatch | DetVal | DetVoice | DetState;

// ---- events.jsonl lines the worker writes (spec 8.1) ----
export type DetectorVariant = 'D1' | 'D3';
export interface FireEvent { n: number; e: 'fire'; det: DetectorVariant; seq: number; v: number; theta: number }
export interface HoldEvent { n: number; e: 'hold'; cause: HoldCause; nCmd: number; nSilent: number; word: number | null }
export interface ResumeEvent { n: number; e: 'resume'; word: number | null; why: 'voice_off' | 'timeout' }
export interface ArmedEvent { n: number; e: 'armed'; det: DetectorVariant; on: boolean }
/**
 * The voice detector parameters Deck runs with from sample n on (spec 7.3: the same code and
 * parameters recompute the edges after the recording): the whole params/frozen.json `vad` block.
 */
export interface VadEvent { n: number; e: 'vad'; source: VadSource; note?: string; params: VadFrozenBlock }
/** The trace sign step() runs with from here on, set before reading starts (spec 7.4, 7.11). */
export interface DetectorSignEvent { n: number | null; e: 'detector_sign'; det: DetectorVariant; sign: 1 | -1 }
/** Page events (window, device, gain, preflight_ok, ...) with the worker's sample number; null before any audio. */
export interface PageEventLine { n: number | null; e: string; [field: string]: unknown }
export type EventLine = FireEvent | HoldEvent | ResumeEvent | ArmedEvent | VadEvent | DetectorSignEvent | PageEventLine;

// ---- Deck <-> worker (direct MessagePort) ----
export interface PktMessage { k: 'pkt'; seq: number; hold: boolean }
export type WorkerToDeck = PktMessage;
export interface ChunkMessage { k: 'chunk'; n0: number; frames: number; ch0: Float32Array; ch1: Float32Array }
/** Voice detector parameters from sample n on; the worker writes them to events.jsonl as a VadEvent. */
export interface VadMessage { k: 'vad'; n: number; source: VadSource; note?: string; params: VadFrozenBlock }
export type DeckToWorker =
  | ChunkMessage
  | { k: 'stamp'; line: DeckStamp }
  | VadMessage
  /** After the last chunk and stamp of the run (docs/protocol.md): the worker may end /session. */
  | { k: 'done'; n: number };

// ---- main thread <-> Deck (AudioWorkletNode.port) ----
export type MainToDeck =
  | { k: 'port'; port: MessagePort }
  | { k: 'load'; name: string; pcm: Float32Array; timings: unknown }
  | { k: 'scenario'; steps: Step[] }
  | { k: 'go' }
  | { k: 'gain'; value: number }
  | { k: 'key' }
  | { k: 'stop' }
  /**
   * New voice detector parameters, resolved like processorOptions.vadParams; they must name the
   * floor (a floor measured during the run, spec 7.11). Applied from the first quantum where the
   * detector reports no voice; `source` describes them for events.jsonl.
   */
  | { k: 'vad'; params: Record<string, unknown>; source?: string };
export type DeckToMain =
  | { k: 'step'; n: number; name: string; text: string }
  | { k: 'cue'; n: number; on: boolean }
  /** A click starts at sample n (i counts within its block): the page flashes the square (spec 15.4). */
  | { k: 'click'; n: number; i: number; block: ClickBlock }
  | { k: 'state'; n: number; s: NarratorState; cause: HoldCause | null }
  | { k: 'level'; ch0Db: number; ch1Db: number }
  | { k: 'done'; n: number }
  /** A message or scenario Deck cannot use (docs/protocol.md). */
  | { k: 'error'; message: string };

/** processorOptions of `new AudioWorkletNode(ctx, 'deck', {processorOptions})`. */
export interface DeckProcessorOptions {
  /** /api/config `mode` (host mode name) or a DeckMode. */
  mode?: string;
  /** Output gain before the first {k:'gain'} (spec 7.7). Default 1. */
  gain?: number;
  /** Voice detector parameters: Partial<VadParams>, or the `vad` block of params/frozen.json. Default DEFAULT_VAD_PARAMS. */
  vadParams?: Record<string, unknown>;
  /** Where the page took vadParams from, for the `vad` line of events.jsonl. */
  vadSource?: string;
}

// ---- main thread <-> worker ----
/** D1 setup: params/frozen.json (or its `d1` fields), the trace sign and the variant (spec 7.4, 8.4). */
export interface DetectorSetup {
  params?: unknown;
  sign?: number;
  variant?: string;
}

/** /api/config as the worker reads it (docs/protocol.md "HTTP (host)"). */
export interface WorkerConfig {
  mode?: string;
  tapUrl?: string | null;
  sessionUrl?: string | null;
  calib?: { polarity?: { sign?: number } | null; [key: string]: unknown } | null;
  /** step() setup (docs/protocol.md); absent: preliminary parameters, sign from calib.polarity, D1. */
  detector?: DetectorSetup | null;
  [key: string]: unknown;
}

export type EndReason = 'done' | 'stop' | 'abort';
export type MainToWorker =
  | { k: 'init'; config: WorkerConfig; port: MessagePort }
  | { k: 'hello'; ua: string; settings: unknown }
  | { k: 'consent'; at: string }
  | { k: 'event'; e: string; hard?: boolean; [field: string]: unknown }
  /** The trace sign from the three cued deep breaths, before reading starts (spec 7.4, 7.11). */
  | { k: 'detector'; sign: number }
  | { k: 'end'; reason: EndReason | string };
export type TapState = 'starting' | 'running' | 'stopped';
export type WorkerToMain =
  | { k: 'sdk'; tap: TapState; ok: boolean; note?: string }
  | { k: 'abort'; reason: string }
  /** host's {t:'quickcheck'} after the recording, passed on (docs/protocol.md). */
  | { k: 'quickcheck'; ok: boolean | null; text: string | null }
  | { k: 'closed' }
  | { k: 'error'; message: string };
