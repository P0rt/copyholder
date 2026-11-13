// Detector D1 (spec 7.4): the one step() used by the live worker, replay, analysis and tests.
// Input: one detector_in.jsonl line (spec 8.1). Output: new state, hold, and on a fire v and theta.
// Implementation lives in core/detector/; this file is the public entry point.

export {
  initDetector,
  step,
  stepMut,
  cloneDetectorState,
  runDetectorFile,
  memoryStats,
  thetaFrom,
} from './detector/d1.ts';
export type {
  ArmedRecord,
  Breath,
  DetectorRun,
  DetectorState,
  FireRecord,
  FrozenParamsLike,
  GridSteps,
  MemoryStats,
  StepResult,
} from './detector/d1.ts';

export type {
  BatchInput,
  DetectorInput,
  Fire,
  NarratorState,
  Sign,
  StateInput,
  TracePair,
  ValInput,
  Variant,
  VoiceInput,
} from './detector/types.ts';

export * from './detector/params.ts';

export { polaritySign } from './detector/polarity.ts';
export type { CueWindow, PolarityResult } from './detector/polarity.ts';

export { d1Posthoc, firesPerActiveMinute, runPosthoc } from './detector/posthoc.ts';
export type {
  PosthocArmed,
  PosthocDetector,
  PosthocFire,
  PosthocOptions,
  PosthocResult,
  PosthocStepOutput,
  PosthocStop,
} from './detector/posthoc.ts';

export { formatDetectorInLine, nArrMapFromStamps, parseDetectorIn, parseDetectorInLine, parseStream } from './detector/io.ts';
export type { StampLike, StreamRead } from './detector/io.ts';

export { STAGE_A_MAX_FIRES_PER_MIN, chooseK, kStepDown, kStepUp, stageAChooseK } from './detector/tune.ts';
export type { KChoice, KTrial, StageAOptions } from './detector/tune.ts';

export {
  COMPARE_AFTER_MS,
  COMPARE_BEFORE_MS,
  COMPARE_MIN_LEAD_MS,
  comparePair,
  comparePairedStops,
  firstStopInWindow,
  stopOnMicScale,
} from './detector/compare.ts';
export type { CompareOptions, PairInput, PairOutcome, PairResult } from './detector/compare.ts';
