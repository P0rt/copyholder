// core/clock: the time chain (spec 6.3, 7.12, 8.1). Pure functions, no I/O.
// Deck may import ./clicks.ts directly inside the AudioWorklet; every file here is worklet-safe.

export {
  SAMPLE_RATE_HZ,
  QUANTUM_SAMPLES,
  FADE_SAMPLES,
  CHUNK_SAMPLES,
  LRT_MEAN_MAX_MS,
  LRT_BOTH_MAX_MS,
  CAMERA_OFFSET_AGREE_MS,
  TRACE_RATE_MIN_PER_S,
  SNIFF_PASS_MAX_MS,
  SNIFF_KILL_MIN_MS,
  TRACE_STRAY_TOLERANCE_S,
  THRESHOLD_TOLERANCE_MS,
  samplesToMs,
  msToSamples,
  quantumMs,
} from './constants.ts';

export {
  CLICK_COUNT,
  CLICK_SAMPLES,
  CLICK_PEAK,
  CLICK_START_HZ,
  CLICK_END_HZ,
  LOOP_BLOCK_SAMPLES,
  clickSchedule,
  clickWaveform,
} from './clicks.ts';

export {
  LOOP_MAX_LAG_MS,
  LOOP_MIN_PEAK_TO_NOISE,
  LOOP_MIN_CLICKS_FOUND,
  measureClickLag,
  measureLoopLatency,
  loopRule,
  lrtValuesMs,
} from './loop.ts';
export type { ClickLag, LoopMeasurement, LoopOptions, LoopSummary, LrtThresholds } from './loop.ts';

export {
  ENVELOPE_WINDOW_S,
  CAMERA_MIN_SYLLABLES,
  lowerEnvelope,
  envelopeAt,
  lipOpening,
  cameraClock,
  cameraTsToMicSeconds,
} from './camera.ts';
export type {
  CameraClock,
  CameraClockInput,
  CameraClockOptions,
  Envelope,
  LipFrame,
  LipOpening,
  PacketTime,
  SyllableBlock,
} from './camera.ts';

export { sniffLag, sniffReading } from './sniff.ts';
export type {
  SniffLag,
  SniffLagInput,
  SniffLagOptions,
  SniffMeasurement,
  SniffReading,
  TracePacket,
} from './sniff.ts';

export {
  DEVICE_EVENTS,
  PAGE_LOSS_EVENTS,
  WINDOW_WARNING_EVENTS,
  AUDIO_GAP_EVENTS,
  SDK_RESTART_CODE,
  isPageHiddenEvent,
  isDeviceEvent,
  isPageLossEvent,
  isHardEvent,
  traceRateMedian,
  notSentShare,
  statusOkShare,
  tapLoopP99Ms,
  micFlagsOff,
  recordingSampleRateHz,
  sdkErrorCount,
  measureLoopBlocks,
  stopChecks,
  clockCheck,
  clockCheckDetails,
  hardFailures,
  onsetBlock,
} from './check.ts';
export type { ClockCheckDetails, ClockCheckOptions, OnsetPair, StopCheck } from './check.ts';

export { clockCalib, sniffLrtMs } from './calib.ts';
export type { ClockCalib, ClockCalibInput, ClockCalibOptions } from './calib.ts';

export {
  chunkLayout,
  audioIndex,
  recordedSpan,
  loopClickBlocks,
  arrivalsBySeq,
  packetTimes,
  lipFrames,
  tracePackets,
  traceTimestamps,
  traceRunTimestamps,
} from './session.ts';
export type { ChunkLayout, ChunkRun } from './session.ts';

export type {
  CalibCameraClock,
  CalibLrt,
  CalibSniffLag,
  ClockReport,
  EventLine,
  LrtRule,
  MicSettings,
  OnsetErrorBlock,
  SampleLine,
  SessionData,
  Stamp,
} from './types.ts';
