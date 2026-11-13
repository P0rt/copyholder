'use strict';
// SDK codes and what the host says and does about them (spec 7.1 table).
// The name tables are the ones of live/reduce.cjs (tap); tests/live keeps them equal.

const PROCESSING_NAMES = Object.freeze({
  0: 'kUninitialized', 1: 'kIdle', 2: 'kStarting', 3: 'kRunning', 4: 'kStopping', 5: 'kError',
});
const VALIDATION_NAMES = Object.freeze({
  0: 'kOk', 1: 'kNoFaceFound', 2: 'kMultipleFacesFound', 3: 'kFaceNotCentered', 4: 'kFaceSizeOutOfRange',
  5: 'kTooDark', 6: 'kTooBright', 7: 'kChestNotVisible', 10: 'kCameraTuning', 11: 'kFrameRateTooLow',
  12: 'kExcessiveMotion', 13: 'kFaceTooClose', 14: 'kFaceTooFar', 15: 'kFaceTooHigh', 16: 'kFaceTooLow',
  17: 'kFaceNotForward',
});
const ERROR_NAMES = Object.freeze({
  0: 'kOk', 1: 'kInvalidState', 2: 'kAuthenticationFailed', 3: 'kConfigurationFailed', 4: 'kCreditExhausted',
  5: 'kNetworkError', 6: 'kServerError', 7: 'kInputUnavailable', 8: 'kProcessingFailed',
  9: 'kFrameConversionFailed', 10: 'kNonMonotonicTimestamp', 11: 'kTimestampGap', 13: 'kMetricNotAuthorized',
  14: 'kSustainedLowFrameRate',
});

/** Text the spec fixes for code 2 (spec 7.1). */
const KEY_MESSAGE = 'Check SMARTSPECTRA_API_KEY in .env';

const nameOf = (table, code) => table[code] ?? `code_${code}`;
const processingName = (code) => nameOf(PROCESSING_NAMES, code);
const validationName = (code) => nameOf(VALIDATION_NAMES, code);
const errorName = (code) => nameOf(ERROR_NAMES, code);

/**
 * The SDK call of an sdk_error ('call', docs/protocol.md) was the camera request: useCamera() or the
 * CameraSelection. kConfigurationFailed from it may be about the camera selector or the capture options
 * (SDK migration guide), so the camera name is checked first.
 */
function isCameraCall(call) {
  return typeof call === 'string' && /^(useCamera|CameraSelection)/.test(call);
}

/** The step of spec 6.7 and 7.12 question 1, in the words of the smoke report (analysis/smoke). */
const ELECTRON_HINT = 'If the camera does not open in plain Node, run it again with: npm run live:electron -- smoke (spec 6.7).';

/**
 * An sdk_error that may mean the camera did not open (spec 7.12 question 1): kInputUnavailable, code 3 from
 * the camera request, or a failure without an SDK code in a camera call or in start(), where the camera
 * turns on. Key, metric, network and credit errors are not.
 */
function isCameraFailure(code, call) {
  if (code === 7) return true;
  if (code === 3) return isCameraCall(call);
  return code === null && typeof call === 'string' &&
    /^(useCamera|CameraSelection|SmartSpectraSDK\.availableCameras|start)\b/.test(call);
}

const SPARE_STEP = 'COPYHOLDER_METRICS=spare in settings.env and run smoke again.';

/** One plain line about an SDK error; `call` picks the hint for code 3 (spec 7.1 table). */
function sdkErrorText(code, name, { smoke = false, call = null } = {}) {
  const label = name || (Number.isInteger(code) ? errorName(code) : 'unknown');
  switch (code) {
    case 2: return KEY_MESSAGE;
    case 3:
      if (isCameraCall(call)) {
        // the action stays the one of the table (spec 7.1: "same action"): in smoke, the spare set comes next
        const camera = `The SDK refused the camera request (${label}): the camera selection or its 1280x720, 30 fps format. Check COPYHOLDER_CAMERA_NAME in settings.env.`;
        return smoke ? `${camera} If the name is right, put ${SPARE_STEP}` : camera;
      }
    // falls through: from start(), the metric set or an error event, code 3 is about the metrics
    case 13:
      return smoke
        ? `The SDK did not accept the requested metrics (${label}). Put ${SPARE_STEP}`
        : `The SDK did not accept the requested metrics (${label}).`;
    case 4: return `The SDK credits are used up (${label}).`;
    case 5: return `The network connection to Presage failed (${label}).`;
    case 6: return `The Presage server reported an error (${label}).`;
    case 7: return `The camera is not available (${label}).`;
    case 8: return `The SDK could not process the camera frames (${label}).`;
    case 14: return `The camera frame rate stayed too low (${label}).`;
    default:
      return Number.isInteger(code)
        ? `The SDK reported error code ${code} (${label}).`
        : `The camera process failed (${label}).`;
  }
}

/**
 * What tap does with an error (spec 7.1 table), as tap reports it in `action`. canRestart: no packet
 * arrived yet and no restart was made (tap's reading of "before the recording").
 */
function errorAction(code, canRestart) {
  switch (code) {
    case 2: return 'exit_key';
    case 3: case 13: return 'exit_metrics';
    case 7: return 'exit_cameras';
    case 8: return canRestart ? 'reset_restart' : 'abort';
    default: return 'abort';
  }
}

/** processingStatus names that mean the SDK is running ('kRunning' from tap, 'Running' accepted too). */
function isRunningStatus(name) {
  return typeof name === 'string' && name.replace(/^k(?=[A-Z])/, '').toLowerCase() === 'running';
}

module.exports = {
  PROCESSING_NAMES, VALIDATION_NAMES, ERROR_NAMES, KEY_MESSAGE, ELECTRON_HINT,
  processingName, validationName, errorName, isCameraCall, isCameraFailure, sdkErrorText, errorAction, isRunningStatus,
};
