// core/vad: the voice detector of the Deck (spec 7.3), shared by the live AudioWorklet and the
// recomputation after recording. Pure: no Node APIs, safe inside an AudioWorklet.

export {
  DEFAULT_VAD_PARAMS,
  createVad,
  vadEdges,
  vadStepFeatures,
  measureFloorDb,
  resolveVadParams,
  tuneVadThreshold,
  voiceIntervalsFromEdges,
} from './vad.ts';
export type { Vad, VadEdge, VadParams, VadStepFeatures, VadTuneResult, VadTuneTrial } from './vad.ts';

export { readVadFrozenBlock, vadFrozenBlock, vadParamsFromFrozen } from './frozen.ts';
export type { VadFrozenBlock, VadFrozenOptions, VadFrozenRead } from './frozen.ts';
