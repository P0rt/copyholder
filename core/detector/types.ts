// Inputs and outputs of the detector: one detector_in.jsonl line in, one answer out (spec 7.4, 8.1).

/** Polarity of the chest trace: s flips it so that an inhale is a rise (spec 7.4). */
export type Sign = 1 | -1;

/** D1 is the planned detector; D3 exists only if the retune ladder reaches it (spec 7.4, 9.8). */
export type Variant = 'D1' | 'D3';

/**
 * Narrator states owned by Deck, lower case as in the files (spec 6.4, 8.1), plus "idle", which
 * Deck writes while no passage plays (core/schemas NARRATOR_STATES). Only "narrating" is reading.
 */
export type NarratorState = 'narrating' | 'hold_wait' | 'listening' | 'resume' | 'idle';

/** One trace sample: SDK timestamp in microseconds and the value (spec 8.1 "tr"). */
export type TracePair = readonly [tsUs: number, value: number];

/** An SDK packet as written to detector_in.jsonl (spec 8.1). D1 reads only tr. */
export interface BatchInput {
  k: 'batch';
  seq: number;
  tr: readonly TracePair[];
  talk?: readonly (readonly [tsUs: number, flag: number])[];
  g?: number | null;
  hm?: number | null;
}

/** A validationStatus code (spec 7.1, 8.1). */
export interface ValInput {
  k: 'val';
  seq: number;
  code: number;
}

/** A voice edge from the voice detector in Deck, with its sample number (spec 6.4, 8.1). */
export interface VoiceInput {
  k: 'voice';
  n: number;
  on: boolean;
}

/** A narrator state change reported by Deck, with its sample number (spec 6.4, 8.1). */
export interface StateInput {
  k: 'state';
  n: number;
  s: NarratorState;
}

/** One line of detector_in.jsonl; the line order is the processing order (spec 8.1). */
export type DetectorInput = BatchInput | ValInput | VoiceInput | StateInput;

/** What the detector reports when it fires: v and theta go to events.jsonl (spec 7.4, 8.1). */
export interface Fire {
  /** Slope over A at the firing grid point, 1/s. */
  v: number;
  /** Threshold that v met: theta for the D1 rule, med_q + 1.0 s_q for the D3 early-breath rule. */
  theta: number;
  /** Camera-clock time of the firing grid point, microseconds (never the fire time: that is nArr). */
  tsUs: number;
  /** Which rule fired. */
  rule: 'd1' | 'd3';
}
