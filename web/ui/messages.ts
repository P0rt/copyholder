// Messages between the main thread, Deck and the worker (docs/protocol.md).
import type { Step } from '../scenarios/format.ts';

/** Microphone settings for the hello frame: getSettings() plus what the page knows of the output. */
export interface HelloSettings extends MediaTrackSettings {
  label: string;
  contextSampleRate: number;
  baseLatency: number | null;
  outputLatency: number | null;
  output: { name: string; sinkId: string; accepted: boolean };
}

export type PageEventName = 'visibilitychange' | 'blur' | 'resize' | 'devicechange' | 'track_ended' | 'track_mute' | 'gain' | 'deck_error';

export interface PageEvent {
  e: PageEventName;
  /**
   * Hard events make a recording unusable (spec 7.3): hidden page, devicechange, track ended or
   * muted; also deck_error, Deck's processor failing (no audio is recorded after it).
   */
  hard: boolean;
  [field: string]: unknown;
}

/**
 * Why the page ends a run: the scenario's end, Stop, host's abort, or a failure the page found itself:
 * Deck's processor failed (deck_error) or the worker lost /session (session_lost).
 */
export type EndReason = 'done' | 'stop' | 'abort' | 'deck_error' | 'session_lost';
export type FailReason = Extract<EndReason, 'deck_error' | 'session_lost'>;

export type ToWorker =
  /** config is the /api/config JSON as host served it (PageConfig.raw). */
  | { k: 'init'; config: Record<string, unknown>; port: MessagePort }
  | { k: 'hello'; ua: string; settings: HelloSettings }
  | { k: 'consent'; at: string }
  | ({ k: 'event' } & PageEvent)
  | { k: 'end'; reason: EndReason };

export type TapState = 'starting' | 'running' | 'stopped';

export type FromWorker =
  | { k: 'sdk'; tap: TapState; ok: boolean; note?: string }
  | { k: 'abort'; reason: string }
  | { k: 'closed' }
  | { k: 'error'; message: string }
  /** host's quickcheck line after the recording: GOOD RECORDING or RE-RECORD NOW: <reason> (spec 7.12, 9.3); text null when none ran. */
  | { k: 'quickcheck'; ok: boolean | null; text: string | null }
  /**
   * Live mode only, for the live view (spec 15.2; web/lib/messages.ts TraceToMain): one packet's trace
   * at its arrival sample n, pts [camera ts in us, value times sign], count the samples it carried.
   */
  | { k: 'trace'; n: number; sign: 1 | -1; count: number; pts: Array<[number, number]> }
  /** Live mode only: a D1 fire at its packet's arrival sample n (spec 7.4). */
  | { k: 'fire'; n: number; v: number; theta: number }
  /** Live mode only: D1 active (on) or not from sample n (spec 7.4). */
  | { k: 'armed'; n: number; on: boolean };

export type ToDeck =
  | { k: 'port'; port: MessagePort }
  | { k: 'load'; name: string; pcm: Float32Array; timings: unknown }
  | { k: 'scenario'; steps: Step[] }
  | { k: 'go' }
  | { k: 'gain'; value: number }
  | { k: 'key' }
  | { k: 'stop' };

export type FromDeck =
  | { k: 'step'; n: number; name: string; text: string }
  | { k: 'cue'; n: number; on: boolean }
  /** A click starts at sample n; i counts within its block A, B or demo (the flash square, spec 15.4). */
  | { k: 'click'; n: number; i: number; block: string }
  | { k: 'state'; n: number; s: string; cause?: string | null }
  | { k: 'level'; ch0Db: number; ch1Db: number }
  | { k: 'done'; n: number }
  /** A message or scenario Deck cannot use (web/lib/messages.ts DeckToMain). */
  | { k: 'error'; message: string };

/** Options of the `deck` AudioWorkletNode: mono microphone in, mono narrator out (docs/protocol.md). */
export const DECK_NODE_OPTIONS: AudioWorkletNodeOptions = {
  numberOfInputs: 1,
  numberOfOutputs: 1,
  outputChannelCount: [1],
  channelCount: 1,
  channelCountMode: 'explicit',
  channelInterpretation: 'speakers',
};

export const DECK_PROCESSOR_NAME = 'deck';
