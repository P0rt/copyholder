// Rivals of D1 computed after the recording (spec 7.5): G (lips), T (talking flag), M (head
// motion, descriptive) on SDK data, and the audio rules A100, A250, A500 from the voice onsets.

export {
  DEFAULT_RIVAL_TIMING,
  activeSpansSamples,
  linePositionSamples,
  overlapSamples,
  sdkRivalPosthoc,
  sharedActive,
} from './activity.ts';
export type { PacketRule, PacketVerdict, RivalFire, RivalState, RivalTiming, SdkRivalOptions, SpanSamples } from './activity.ts';
export { DEFAULT_G_PARAMS, G_GRID, gPosthoc, gResetSeqs, gRule, lipBaselines, resetSeqsOf } from './g.ts';
export type { GParams, GPosthocOptions, GResets, LipPoint, SampleLmLike } from './g.ts';
export { T_RULE, packetTalks, tPosthoc } from './t.ts';
export type { SdkRivalRunOptions } from './t.ts';
export { M_SPREADS, headMotionThreshold, mPosthoc, mRule } from './m.ts';
export type { HeadMotionThreshold } from './m.ts';
export { AUDIO_RULE_DELAYS_MS, audioRuleLeadMs, audioRuleStops } from './audio-rules.ts';
export type { AudioRuleOnset, AudioRuleStop } from './audio-rules.ts';
