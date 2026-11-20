// The one place the page code imports core/ from (pure modules shared with analysis and tests).

export { createVad, DEFAULT_VAD_PARAMS, resolveVadParams, vadEdges, vadFrozenBlock, vadParamsFromFrozen } from '../../core/vad/index.ts';
export type { Vad, VadEdge, VadFrozenBlock, VadParams } from '../../core/vad/index.ts';
export { LOOP_CLICK_PEAK, clickSchedule, clickWaveform } from '../../core/clock/clicks.ts';
export { lowerEnvelope } from '../../core/clock/camera.ts';
export type { Envelope, PacketTime } from '../../core/clock/camera.ts';
export { initDetector, polaritySign, POLARITY_BREATHS, runDetectorFile, step } from '../../core/detector.ts';
export type { CueWindow, DetectorInput, DetectorState, PolarityResult, StepResult } from '../../core/detector.ts';
export { orderKeys } from '../../core/schemas/jsonl.ts';
export { validateDetectorInLine, validateEventLine, validateStampLine } from '../../core/schemas/session.ts';
