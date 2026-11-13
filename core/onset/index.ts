// core/onset: the voice-onset reference of spec 7.6 (n_v, n_a, audible inhale, no_dip, floor),
// its session variant with replies (spec 4.2), and the audio events of the clocks (spec 6.3):
// sniff onset and 'pa' bursts. Pure: no I/O; sample numbers are absolute (ch0[0] is n0).

export { DEFAULT_ONSET_PARAMS, resolveOnsetConfig } from './params.ts';
export type { OnsetConfig, OnsetParams, SampleSpan } from './params.ts';

export { computeFeatures, FeatureTrack } from './features.ts';
export type { Floor } from './features.ts';

export { findOnset, findAnchorFrame, onsetFromAnchor, onsetAutoRecord, onsetEventFields } from './onset.ts';
export type { FindOnsetOptions, GateOnsetResult, OnsetAutoRecord, OnsetEventFields, OnsetFlag, OnsetResult } from './onset.ts';

export { groupReplies, replyFrom, voicedSegments } from './replies.ts';
export type { ReplyExtent, ReplyGroup } from './replies.ts';

export { findSessionOnsets } from './session.ts';
export type { Reply, SessionOnsetOptions } from './session.ts';

export { DEFAULT_SNIFF_PARAMS, findPaBursts, findSniffOnset } from './events.ts';
export type { PaBurst, PaBurstOptions, PaBurstsResult, SniffOnset, SniffOptions, SniffParams } from './events.ts';

export { narratorSoundSpans } from './narrator.ts';
export type { NarratorSoundOptions } from './narrator.ts';
