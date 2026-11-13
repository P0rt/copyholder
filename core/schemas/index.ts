// core/schemas: types and hand-written validators for every file format of spec section 8,
// JSON/JSONL helpers with the spec's precision rules, and the ledger hash chain of 8.5.
// Pure: no I/O, no clock, no randomness, no dependencies.
//
// Every validator takes an unknown value and returns readable problems (empty = valid).
// parseJsonl/parseJson add file names and line numbers; toJsonlLine writes the spec's key order.
// validateFileText picks the validator by file name. Rules that span a whole file or several
// files: eventLogProblems (events.jsonl per record kind), verifyLedger (chain and step order),
// numbersBatchProblems (ledgers of the numbers batch), detectorInToStream (stream.jsonl).
// ledger-steps.json holds the ledger rules for CommonJS code; examples.ts holds a complete,
// valid example of every format for tests.

export {
  makeValidator, describe, isPlainObject, reportPrecision, isMsOrDbKey,
} from './check.ts';
export type { Spec, Validator } from './check.ts';

export {
  SAMPLE_RATE_HZ, FADE_SAMPLES, HOLD_WAIT_SAMPLES, LANDMARK_IDS, LANDMARK_COUNT, round1, isRound1, samplesToSeconds, plusZero,
} from './precision.ts';

export {
  KEY_ORDERS, guessJsonlFile, orderKeys, toJsonlLine, toJsonlText, toJsonText, splitJsonlLines, splitTruncatedTail, parseJsonl,
  parseJson,
} from './jsonl.ts';
export type { JsonlFile, OrderedJsonFile, OrderedFile, ParseOptions, JsonlRows, JsonParse, JsonlTail } from './jsonl.ts';

export {
  LEDGER_KINDS, RECORD_KINDS, NARRATOR_STATES, HOLD_CAUSES, LRT_RULES, ERROR_CLASSES, GATE_PACKS, SESSION_ID, HEX64,
  RELATIVE_FILE, isLedgerKind,
} from './common.ts';
export type {
  LedgerKind, RecordKind, NarratorState, HoldCause, LrtRule, ErrorClass, GatePack, TimedValue, TimedFlag,
} from './common.ts';

export {
  validateManifest, validateStampLine, validateSampleLine, validateSdkRawLine, validateDetectorInLine,
  validateEventLine, sampleToDetectorIn, isEvent, isPageHiddenEvent, isHardWindowEvent, countWindowEvents,
  eventLogProblems, HOLD_CAUSES_BY_KIND, SEALED_PLAN_KINDS, PLANLESS_KINDS,
  STAMP_KINDS, SDK_EVENTS, DETECTORS, SPEC_EVENT_NAMES, EVENT_NAMES, HARD_WINDOW_EVENTS, WARNING_WINDOW_EVENTS,
  LANDMARK_FIELDS,
} from './session.ts';
export type {
  Manifest, ManifestSdk, ManifestCamera, ManifestAudio,
  StampLine, StampKind, StampChunk, StampClick, StampMark, StampArr, StampHold, StampState, StampVoice, StampResume,
  StampIgnored,
  SampleLine, SamplePacket, SampleLandmarks, SampleValidation, SampleStatus, SampleFrameSent, SampleError, SampleLoop,
  SdkRawLine, SdkEvent,
  DetectorInLine, DetBatch, DetVal, DetVoice, DetState,
  EventLine, EventName, SpecEventName, DetectorName, EventFire, EventHold, EventResume, EventArmed, EventOther,
} from './session.ts';

export {
  validateCalib, validateQuickcheck, quickcheckLine, validateClockReport, validateOnsets, validateVerdict,
  validateReview, combineGateVerdict, sniffMediansNotArrived,
  QUICKCHECK_RESULTS, QUICKCHECK_NAMES, CLOCK_REPORT_BANNED_WORDS, ONSET_KINDS, ONSET_LABELS, ONSET_FLAGS, ONSET_NO_REPLY_LABEL,
  GATE_OUTCOMES, GATE_VERDICTS, GATE_MIN_VALID, VERDICT_ROWS, REVIEW_LABELS,
} from './reports.ts';
export type {
  Calib, CalibLrt, CalibSniffLagBlock, CalibSniffLagMs, Quickcheck, QuickcheckCheck, QuickcheckResult, ClockReport, Onsets, OnsetEvent, OnsetKind,
  OnsetLabel, Verdict, VerdictRow, GateOutcome, GateVerdict, Review, ReviewSegment, ReviewLabel,
} from './reports.ts';

export {
  validateFrozenParams, paramsAreTuned, validateScoringRules, K_GRID, THETA_G_GRID, SCORING_RULES_FIXED,
} from './params.ts';
export type { FrozenParams, ScoringRules } from './params.ts';

export {
  LEDGER_STEPS, NOTE_STEP, GENESIS_PREV, LEDGER_ORDERS, ONCE_STEPS, EXPLORATORY_STEPS, REQUIRED_OUTPUTS, VERDICT_FILE,
  NOTE_WHATS, LEDGER_LINE_KEYS, LEDGER_NOTE_KEYS, validateLedgerLine, isNoteLine, hashLine, assertSha256, ledgerHead, checkStepOrder,
  canAppendStep, nextStep, findSteps, stageAParamsHash, verifyLedger, verifyLedgerText, appendLedger, LedgerError,
  BATCH_KINDS, AFTER_BATCH_STEPS, BEFORE_REVEAL_STEPS, numbersBatchProblems,
} from './ledger.ts';
export type {
  LedgerStep, LedgerLine, LedgerStepLine, LedgerNoteLine, HashFn, LedgerVerification, VerifyOptions, StepFields,
  NoteFields, AppendOptions, BatchLedger, BatchOptions,
} from './ledger.ts';

export { validateReceipt, RECEIPT_MODES, NO_CAMERA_MODES, GIT_COMMITMENTS, PLANTED_OUTCOMES, RIVALS } from './receipt.ts';
export type { Receipt, ReceiptMode, PlantedEvent, PlantedOutcome, Rival, RivalStats, ReceiptReviewItem, LeadBlock } from './receipt.ts';

export {
  validateResults, listPostKeyProblems, getResultsValue, RESULTS_FAMILIES, RESULTS_POST_KEYS,
  RESULTS_OPTIONAL_POST_KEYS, RESULTS_EXTRA_KEYS, RESULTS_SUMS, LEDGER_HEADS_KEY, PLAN_FATES, GATE_VERDICT_WORDS,
} from './results.ts';
export type { Results, ResultsFamily, ResultsValueType, PlanFate } from './results.ts';

export {
  validateSealedPlan, validateFreezeManifest, validateTimings, validateTexts, integersOnly, PLAN_ROLES, MAX_DEMO_PLANS,
  parseCommitmentText, sealGroups, formatSealScreen,
} from './plan.ts';
export type { SealedPlan, PlanPassage, PlanError, FreezeManifest, FreezePlan, PlanRole, Timings, WordTiming, Texts } from './plan.ts';

export {
  validateStreamLine, detectorInToStream, streamToDetectorIn, buildStreamJsonl, findFaceLandmarkFields,
  validateAudioEnv, validateSentenceEnds, validatePlantedTimes, validatePublishedManifest, toPublishedManifest,
  findLocalPaths, listDeviceNames, checkPublishedNames, validatePublishedFolder, whyNotInGit, whyNoPublishedSet,
  STREAM_FIELDS, PUBLISHED_FILES, OPT_IN_FILES, NEVER_PUBLISHED, NEVER_IN_GIT, NEVER_IN_GIT_PREFIXES, VIDEO_EXTENSIONS,
  PRIVATE_TRACK_SETTINGS, PUBLISHED_KINDS, GATE_ONLY_FILES,
} from './published.ts';
export type {
  StreamLine, StreamBatch, StreamVal, StreamBuild, StreamText, AudioEnv, SentenceEnds, PlantedTimes, DeviceName, PublishOptions,
} from './published.ts';

export {
  WAV_FORMAT_PCM, WAV_FORMAT_IEEE_FLOAT, WAV_FILES, wavEncoding, checkWavFormat, CLIP_BEFORE_SAMPLES, CLIP_AFTER_SAMPLES,
  ENC_NONCE_BYTES, ENC_TAG_BYTES, SEAL_KEY_BYTES, SEAL_KEYCHAIN_NAME, SEALED_FOLDER_FILES, HOST_DECRYPTABLE,
  hostMayDecrypt, splitEncBytes, joinEncParts,
} from './binary.ts';
export type { WavFormat, WavEncoding, WavExpectation, WavKind, EncParts } from './binary.ts';

export { FILE_FORMATS, validateFileText, formatForPath } from './registry.ts';
export type { FileFormat } from './registry.ts';
