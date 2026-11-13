'use strict';
// Pure part of tap (spec 7.1, 8.1): SDK callbacks -> samples.jsonl lines, plus small pure helpers and the
// stand-in SDK of tap --dry. No SDK import, no I/O, no clock: tap.cjs passes every time value and timer in.

// ---------------------------------------------------------------------------------------------
// Decoded message layout: the spec does not fix it. Every field access is below. Source: the
// public proto (Measurement {value, stable, timestamp}, DetectionStatus {detected, stable,
// timestamp}, Landmarks {value: Point2dFloat[], stable, reset, timestamp}, timestamp int64 µs
// since the epoch) and the metrics guide (breathing.upperTrace, face.talking, face.landmarks:
// protobufjs camelCase). smoke prints probeMetrics() of the first frame (spec 7.12); if the real
// layout differs, fix it here and nowhere else.
// ---------------------------------------------------------------------------------------------
const list = (x) => (Array.isArray(x) ? x : []);
/** Chest trace (CHEST_BREATHING): Breathing.upper_trace, repeated Measurement. */
const chestSamples = (msg) => list(msg?.breathing?.upperTrace);
/** Talking flag (TALKING): Face.talking, repeated DetectionStatus. */
const talkSamples = (msg) => list(msg?.face?.talking);
/** Face mesh frames (FACE_LANDMARKS): Face.landmarks, repeated Landmarks (478 points each). */
const landmarkFrames = (msg) => list(msg?.face?.landmarks);
/** Timestamp of a sample or frame: int64 µs since the epoch, number or Long (spec 7.1). */
const stampOf = (s) => s?.timestamp;
const traceValue = (s) => s?.value;
const talkingFlag = (s) => (s?.detected ? 1 : 0);
const framePoints = (f) => list(f?.value);
const frameReset = (f) => (f?.reset ? 1 : 0);
/** Point2dFloat {x, y}, frame pixels per the docs (smoke checks) -> [x, y] or null. */
const pointXY = (p) => (p != null && Number.isFinite(p.x) && Number.isFinite(p.y) ? [p.x, p.y] : null);

/** The one conversion of SDK time fields (spec 7.1): number, Long (toNumber), bigint -> µs. */
function toUs(t) {
  if (typeof t === 'number') return t;
  if (t != null && typeof t.toNumber === 'function') return t.toNumber();
  if (typeof t === 'bigint' || typeof t === 'string') return Number(t);
  return NaN;
}

/** The 16 points kept from the mesh, in this order (spec 7.1, 8.1). */
const LANDMARKS = Object.freeze([13, 14, 82, 87, 312, 317, 81, 178, 311, 402, 78, 308, 33, 263, 133, 362]);
/** (upper, lower) lip pairs of g (spec 7.5). */
const LIP_PAIRS = Object.freeze([[13, 14], [82, 87], [312, 317], [81, 178], [311, 402]]);
const NOSE_TIP = 1; // hm uses point 1 of the full mesh (spec 7.1, 7.5)
const HM_FRAMES = 5;

/** Distance between points 33 and 263, px: the scale of g and hm (spec 7.5). */
function eyeSpanPx(pts) {
  const a = pointXY(pts[33]);
  const b = pointXY(pts[263]);
  if (!a || !b) return NaN;
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  return Math.sqrt(dx * dx + dy * dy);
}

/** Median of the five lower-minus-upper y differences, px (spec 7.5). */
function lipGapPx(pts) {
  const d = [];
  for (const [up, low] of LIP_PAIRS) {
    const u = pointXY(pts[up]);
    const l = pointXY(pts[low]);
    if (!u || !l) return NaN;
    d.push(l[1] - u[1]);
  }
  return d.sort((a, b) => a - b)[2];
}

/** Least-squares slope of v over time, per second; times in µs. */
function slopePerS(tsUs, v) {
  const n = tsUs.length;
  const t = tsUs.map((x) => (x - tsUs[0]) / 1e6);
  const mt = t.reduce((a, b) => a + b, 0) / n;
  const mv = v.reduce((a, b) => a + b, 0) / n;
  let num = 0;
  let den = 0;
  for (let i = 0; i < n; i++) {
    num += (t[i] - mt) * (v[i] - mv);
    den += (t[i] - mt) ** 2;
  }
  return den > 0 ? num / den : NaN;
}

/** Speed of the nose tip by least squares over the tracked frames, px/s (spec 7.5). */
function noseSpeedPxPerS(track) {
  const ts = track.map((p) => p.tsUs);
  const vx = slopePerS(ts, track.map((p) => p.x));
  const vy = slopePerS(ts, track.map((p) => p.y));
  return Math.sqrt(vx * vx + vy * vy);
}

const ratio = (a, b) => (b > 0 && Number.isFinite(a / b) ? a / b : null);
const isNew = (ts, last) => Number.isFinite(ts) && (last === null || ts > last);

/** Reducer state: last accepted ts per stream and the nose track of hm. */
function initialState() {
  return { lastTrUs: null, lastTalkUs: null, lastLmUs: null, nose: [] };
}
/** State for a start() after a pause: hm gets a new nose track, the duplicate rule keeps its last ts (assumption). */
const breakTrack = (state) => ({ ...state, nose: [] });

/**
 * One decoded metrics packet -> {state, line}; line is the 'm' line of samples.jsonl (spec 8.1).
 * A sample or frame with ts <= the last accepted one is dropped (spec 7.1). Several new frames in
 * one packet: all feed the nose track, the last one gives lm, g and hm; lm.reset is 1 if any had
 * reset. On reset g and hm are null and the nose track restarts at that frame (assumption).
 * meta: {seq, tArrNs: bigint|string, tsCbUs: number|Long}.
 */
function reduce(state, msg, meta) {
  let { lastTrUs, lastTalkUs, lastLmUs, nose } = state;
  const tr = [];
  for (const s of chestSamples(msg)) {
    const ts = toUs(stampOf(s));
    const v = traceValue(s);
    if (!isNew(ts, lastTrUs) || !Number.isFinite(v)) continue;
    tr.push([ts, v]);
    lastTrUs = ts;
  }
  const talk = [];
  for (const s of talkSamples(msg)) {
    const ts = toUs(stampOf(s));
    if (!isNew(ts, lastTalkUs)) continue;
    talk.push([ts, talkingFlag(s)]);
    lastTalkUs = ts;
  }
  let frame = null;
  let reset = 0;
  for (const f of landmarkFrames(msg)) {
    const ts = toUs(stampOf(f));
    if (!isNew(ts, lastLmUs)) continue;
    lastLmUs = ts;
    frame = f;
    if (frameReset(f)) {
      reset = 1;
      nose = [];
    }
    const tip = pointXY(framePoints(f)[NOSE_TIP]);
    if (tip) nose = [...nose, { tsUs: ts, x: tip[0], y: tip[1] }].slice(-HM_FRAMES);
  }
  let g = null;
  let hm = null;
  let lm = null;
  if (frame) {
    const pts = framePoints(frame);
    lm = { ts: lastLmUs, reset, p: LANDMARKS.map((i) => pointXY(pts[i])) };
    if (!reset) {
      const span = eyeSpanPx(pts);
      g = ratio(lipGapPx(pts), span);
      const full = nose.length === HM_FRAMES && nose[HM_FRAMES - 1].tsUs === lastLmUs;
      hm = full ? ratio(noseSpeedPxPerS(nose), span) : null;
    }
  }
  const line = { seq: meta.seq, k: 'm', tArrNs: String(meta.tArrNs), tsCbUs: toUs(meta.tsCbUs), tr, talk, g, hm, lm };
  return { state: { lastTrUs, lastTalkUs, lastLmUs, nose }, line };
}

/** Metric sets of spec 7.1 by MetricType name; spare = breathingMetrics plus SPARE_EXTRA. */
const METRICS = Object.freeze(['CHEST_BREATHING', 'BREATHING_RATE', 'FACE_LANDMARKS', 'TALKING']);
const SPARE_EXTRA = Object.freeze(['FACE_LANDMARKS', 'TALKING']);
/** MetricType values -> names for manifest.json (spec 8.1); a value without a name stays as text. */
const metricNames = (mt, values) =>
  values.map((v) => Object.keys(mt ?? {}).find((k) => mt[k] === v) ?? String(v));

/** An SDK export tap needs, or an Error that names it. */
function need(v, what) {
  if (v == null) throw new Error(`@smartspectra/node-sdk has no ${what} (tap is written for 3.5.0)`);
  return v;
}
/** requestedMetrics of spec 7.1 from the SDK module's exports; spare: breathingMetrics plus SPARE_EXTRA. */
function requestedMetrics(sdkModule, spare) {
  const mt = need(sdkModule?.MetricType, 'MetricType');
  const pick = (n) => need(mt[n], `MetricType.${n}`);
  if (!spare) return METRICS.map(pick);
  return [...need(sdkModule.breathingMetrics, 'breathingMetrics'), ...SPARE_EXTRA.map(pick)];
}
/** Constructor options of spec 7.1; smoke adds logLevel kInfo (spec 7.12). */
function sdkOptions(sdkModule, { apiKey, spare, smoke }) {
  const options = {
    apiKey, requestedMetrics: requestedMetrics(sdkModule, spare),
    enableTelemetry: false, enableAccumulatedOutput: false,
  };
  if (smoke) options.logLevel = need(sdkModule.SmartSpectraLogLevel?.kInfo, 'SmartSpectraLogLevel.kInfo');
  return options;
}

// Enum names from the public API reference of 3.5.0; smoke compares them with the SDK's own.
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
const nameOf = (table, code) => table[code] ?? `code_${code}`;
const processingName = (code) => nameOf(PROCESSING_NAMES, code);
const validationName = (code) => nameOf(VALIDATION_NAMES, code);
const errorName = (code) => nameOf(ERROR_NAMES, code);

/**
 * SDK code of an exception from useCamera(), start() and the like (spec 7.1: same action as the event).
 * Assumption for smoke: `code` holds the number, or the name such as 'kInputUnavailable'. Else null.
 */
function errorCodeOf(e) {
  const c = e?.code;
  if (Number.isInteger(c)) return c;
  const hit = Object.entries(ERROR_NAMES).find(([, name]) => name === c);
  return hit ? Number(hit[0]) : null;
}

/** Differences between a name table and an SDK enum object {name: code}; [] when they agree. */
function enumMismatches(table, sdkEnum) {
  if (sdkEnum == null || typeof sdkEnum !== 'object') return ['enum not exported'];
  return Object.entries(table).filter(([code, name]) => sdkEnum[name] !== Number(code)).map(([c, n]) => `${n}=${c}`);
}

/** smoke: each SDK enum export against the name tables above, as {label, differences} (IPC 'enums'). */
function enumChecks(sdkModule) {
  const tables = {
    ProcessingStatus: PROCESSING_NAMES, ValidationCode: VALIDATION_NAMES, SmartSpectraErrorCode: ERROR_NAMES,
  };
  const check = ([label, table]) => ({ label, differences: enumMismatches(table, sdkModule?.[label]) });
  return Object.entries(tables).map(check);
}
/** smoke's console line of one check. */
const enumLine = ({ label, differences: d }) =>
  `${label}: ${d.length ? `differs from reduce.cjs: ${d.join(', ')}` : 'matches reduce.cjs'}`;
/** smoke: one line per SDK enum export, saying whether it matches the name tables above. */
const enumReport = (sdkModule) => enumChecks(sdkModule).map(enumLine);

// Other samples.jsonl kinds (spec 8.1). Field names beyond seq, k, tArrNs, tsCbUs are tap's choice.
/** 'v': validationStatus(code, timestampUs, hint). */
const validationLine = (seq, tArrNs, tsCbUs, code, hint) => ({
  seq, k: 'v', tArrNs: String(tArrNs), tsCbUs: toUs(tsCbUs), code, name: validationName(code),
  hint: String(hint ?? ''),
});
/** 's': processingStatus(status). */
const processingLine = (seq, tArrNs, code) =>
  ({ seq, k: 's', tArrNs: String(tArrNs), code, name: processingName(code) });
/** 'f': frameSentThrough(sent, timestampUs). */
const frameLine = (seq, tArrNs, tsCbUs, sent) =>
  ({ seq, k: 'f', tArrNs: String(tArrNs), tsCbUs: toUs(tsCbUs), sent: Boolean(sent) });
/** 'e': error(code, message, retryable). */
const errorLine = (seq, tArrNs, code, message, retryable) => ({
  seq, k: 'e', tArrNs: String(tArrNs), code, name: errorName(code), message: String(message ?? ''),
  retryable: Boolean(retryable),
});
/** 'l': event-loop delay of tap over the last second, ms (spec 7.1); no seq: not an SDK call. */
const loopLine = (tArrNs, stats) => ({ k: 'l', tArrNs: String(tArrNs), ...stats });

/**
 * Stats of the 'l' line from a monitorEventLoopDelay histogram (ns). It records the intervals of a timer
 * that fires every resolutionMs, so the delay is the interval minus that period. null when it is empty.
 */
function loopStats(h, resolutionMs) {
  const ms = (ns) => (h.count > 0 ? Math.max(0, Math.round(ns / 1e3 - resolutionMs * 1e3) / 1e3) : null);
  return { p50Ms: ms(h.percentile(50)), p99Ms: ms(h.percentile(99)), maxMs: ms(h.max), n: h.count };
}

/** JSON for raw lines: bigint as a decimal string, a Long as its number. */
const rawValue = (_k, v) => (typeof v === 'bigint' ? String(v) : typeof v?.toNumber === 'function' ? v.toNumber() : v);
/**
 * One sdk_raw.jsonl.gz line (spec 7.1, 8.1): {seq, kind, tArrNs, tWallMs, tsCbUs?, b64 | args}. body holds
 * tsCbUs (metrics, validationStatus, frameSentThrough) and b64 (metrics) or args (the other events).
 */
const rawLine = (seq, kind, tArrNs, tWallMs, body) =>
  JSON.stringify({ seq, kind, tArrNs: String(tArrNs), tWallMs, ...body }, rawValue);

/**
 * The sdk_raw.jsonl.gz line and the samples.jsonl line of an event without a buffer (spec 7.1, 8.1). args as the
 * SDK passes them: validationStatus(code, timestampUs, hint), processingStatus(status), frameSentThrough(sent,
 * timestampUs), error(code, message, retryable).
 */
function eventRecord(kind, seq, tArrNs, tWallMs, args) {
  const [a, b, c] = args;
  const raw = (withTs) => rawLine(seq, kind, tArrNs, tWallMs, withTs ? { tsCbUs: toUs(b), args } : { args });
  switch (kind) {
    case 'validationStatus': return { raw: raw(true), line: validationLine(seq, tArrNs, b, a, c) };
    case 'processingStatus': return { raw: raw(false), line: processingLine(seq, tArrNs, a) };
    case 'frameSentThrough': return { raw: raw(true), line: frameLine(seq, tArrNs, b, a) };
    default: return { raw: raw(false), line: errorLine(seq, tArrNs, a, b, c) };
  }
}

/**
 * Action of tap for an SDK error code (table of spec 7.1). canRestart: no packet arrived yet and
 * no restart was made (reading of "before the recording", assumption).
 */
function errorAction(code, canRestart) {
  switch (code) {
    case 2: return 'exit_key';
    case 3: case 13: return 'exit_metrics';
    case 7: return 'exit_cameras';
    case 8: return canRestart ? 'reset_restart' : 'abort';
    default: return 'abort'; // 4, 5, 6, 14 and any other code: the trace is unusable (spec 6.3)
  }
}

/**
 * tap's stop inside host's wait for its exit (spec 7.2; TAP_STOP_BUDGET_MS of live/lib/tap-timing.cjs), in this
 * order: stopAsync() 60 %, closing the files 15 %, destroy() 15 %, 10 % to spare. envText is host's test hook
 * COPYHOLDER_TAP_STOP_BUDGET_MS, read as host reads it; else totalMs.
 */
function stopBudget(envText, totalMs) {
  const v = Number(envText);
  const total = envText && Number.isSafeInteger(v) && v > 0 ? v : totalMs;
  const part = (share) => Math.round(total * share);
  return { stopAsyncMs: part(0.6), filesMs: part(0.15), destroyMs: part(0.15) };
}

/** Age in ms of the last packet (hrtime ns, bigint) at nowNs, for the pulse (docs/protocol.md); null before one. */
const agoMs = (nowNs, thenNs) => (thenNs == null ? null : Math.max(0, Math.round(Number(nowNs - thenNs) / 1e6)));

/** The text of spec 7.1 for code 2 (tap prints it as it is). */
const KEY_HINT = 'Check SMARTSPECTRA_API_KEY in .env';
/**
 * Advice for an SDK code by the call it came from (spec 7.1 table), or null. kConfigurationFailed from the camera
 * selection is about the selector or capture options (SDK migration guide), so the camera name is checked first;
 * code 3 keeps its action (spec 7.1), so in smoke the spare metric set is the step after, as host says it
 * (live/lib/sdk-codes.cjs sdkErrorText).
 */
function errorHint(code, from, smoke) {
  if (code === 3 && /^(useCamera|CameraSelection)/.test(from ?? '')) {
    const camera = 'the camera selection or its capture options (1280x720, 30 fps) were refused: check COPYHOLDER_CAMERA_NAME';
    return smoke ? `${camera}; if the name is right, set COPYHOLDER_METRICS=spare in settings.env` : camera;
  }
  return (code === 3 || code === 13) && smoke ? 'metrics refused: set COPYHOLDER_METRICS=spare in settings.env' : null;
}

/** Camera whose name contains `want`; without a name, the only camera (spec 7.1). */
function pickCamera(cams, want) {
  if (want) return cams.find((c) => String(c?.name ?? '').includes(want));
  return cams.length === 1 ? cams[0] : undefined;
}

/** KEY=VALUE lines of .env and settings.env: '#' comments, optional quotes and `export`. */
function parseEnvText(text) {
  const out = {};
  for (const line of String(text).split(/\r?\n/)) {
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
    if (!m) continue;
    const quoted = /^(["'])(.*?)\1\s*(?:#.*)?$/.exec(m[2]); // "a b" # note -> a b
    out[m[1]] = quoted ? quoted[2] : m[2].replace(/(^|\s+)#.*$/, '');
  }
  return out;
}

const typeName = (t) => (t != null && typeof t.toNumber === 'function' ? 'Long' : typeof t);
const range = (v) => (v.length ? [Math.min(...v), Math.max(...v)] : null);

/** What smoke needs to confirm the accessors above on one decoded packet (spec 7.5, 7.12). */
function probeMetrics(msg) {
  const tr = chestSamples(msg);
  const talk = talkSamples(msg);
  const frames = landmarkFrames(msg);
  const pts = framePoints(frames[frames.length - 1]).map(pointXY);
  const at = (i) => pts[i] ?? null;
  const below = (a, b, axis) => (a && b ? a[axis] < b[axis] : null);
  return {
    fields: msg != null && typeof msg === 'object' ? Object.keys(msg) : [],
    tsType: typeName(stampOf(tr[0] ?? talk[0] ?? frames[0])),
    tr: tr.length,
    talk: talk.length,
    frames: frames.length,
    points: pts.length,
    lipsY13BelowY14: below(at(13), at(14), 1),
    cornersX78BelowX308: below(at(78), at(308), 0),
    xRange: range(pts.filter(Boolean).map((p) => p[0])),
    yRange: range(pts.filter(Boolean).map((p) => p[1])),
  };
}

/** Long-like value as protobufjs decodes int64 (low/high words, toNumber). */
function longLike(n) {
  const high = Math.floor(n / 4294967296);
  return {
    low: (n - high * 4294967296) | 0,
    high: high | 0,
    unsigned: false,
    toNumber() { return this.high * 4294967296 + (this.low >>> 0); },
  };
}

/**
 * Synthetic decoded packet number i at 30 Hz (tap --dry, tests): chest trace at 15 breaths/min,
 * talking off, a 478-point mesh with moving lips and nose, Long timestamps; packet 0 has reset and
 * every 100th packet repeats the previous trace sample (a duplicate for reduce to drop).
 */
function syntheticMetrics(i, t0Us) {
  const at = (k) => t0Us + Math.round((k * 1e6) / 30);
  const trace = (k) => ({ value: Math.sin((2 * Math.PI * k) / 120), stable: k > 150, timestamp: longLike(at(k)) });
  const t = i / 30;
  const gap = 8 + 6 * Math.max(0, Math.sin(2 * Math.PI * 0.1 * t));
  const pts = Array.from({ length: 478 }, (_, k) => ({ x: 560 + (k % 32) * 5, y: 330 + Math.floor(k / 32) * 12 }));
  const put = (k, x, y) => { pts[k] = { x, y }; };
  put(33, 580, 380); put(263, 700, 380); put(133, 615, 380); put(362, 665, 380);
  put(1, 640 + 2 * Math.sin(Math.PI * t), 430);
  put(78, 600, 474); put(308, 680, 474);
  [[13, 14, 640, 0], [82, 87, 628, 1], [312, 317, 652, 1], [81, 178, 620, 2], [311, 402, 660, 2]]
    .forEach(([up, low, x, d]) => { put(up, x, 470); put(low, x, 470 + gap - d); });
  return {
    breathing: { upperTrace: i > 0 && i % 100 === 0 ? [trace(i - 1), trace(i)] : [trace(i)] },
    face: {
      talking: [{ detected: false, stable: true, timestamp: longLike(at(i)) }],
      landmarks: [{ value: pts, stable: i > 30, reset: i === 0, timestamp: longLike(at(i)) }],
    },
  };
}

// ---- tap --dry (pure parts): what the stand-in SDK of tap.cjs emits and how its packets decode ----

const invert = (t) => Object.freeze(Object.fromEntries(Object.entries(t).map(([code, name]) => [name, Number(code)])));
/** Exports of the SDK that tap uses besides SmartSpectraSDK, with the values of the API reference (3.5.0). */
const DRY_API = Object.freeze({
  CameraSelection: Object.freeze({ byId: (id) => ({ id }) }),
  MetricType: Object.freeze({
    CHEST_BREATHING: 0, ABDOMEN_BREATHING: 1, BREATHING_RATE: 2, FACE_LANDMARKS: 11, TALKING: 13,
  }),
  breathingMetrics: Object.freeze([0, 1, 2]),
  SmartSpectraLogLevel: Object.freeze({ kDebug: 0, kInfo: 1, kWarning: 2, kError: 3, kNone: 4 }),
  ProcessingStatus: invert(PROCESSING_NAMES),
  ValidationCode: invert(VALIDATION_NAMES),
  SmartSpectraErrorCode: invert(ERROR_NAMES),
});
const DRY_CAMERAS = Object.freeze([
  Object.freeze({ id: 'dry-0', name: 'Copyholder dry camera', facing: 'unknown', lensType: 'unknown' }),
]);

/**
 * SDK events of tick i (30 Hz) after start() in the dry run, as [event, ...args]: statuses on tick 0, then
 * frameSentThrough and metrics (a 12-byte buffer: i and t0Us). errorSpec '<code>@<seconds>' adds one error
 * event (tests); code 8 fails the pipeline: the error, kError on the next tick, then nothing.
 */
function dryEvents(i, t0Us, errorSpec) {
  const tsUs = t0Us + Math.round((i * 1e6) / 30);
  const [code, atS] = /^(\d+)@(\d+(?:\.\d+)?)$/.exec(errorSpec ?? '')?.slice(1).map(Number) ?? [];
  const at = code === undefined ? -1 : Math.round(atS * 30);
  if (code === 8 && i > at) return i === at + 1 ? [['processingStatus', 5]] : [];
  const head = i === 0 ? [['processingStatus', 2], ['processingStatus', 3], ['validationStatus', 0, t0Us, '']] : [];
  const error = i === at ? [['error', code, 'dry error', false]] : [];
  if (code === 8 && i === at) return [...head, ...error];
  const buf = Buffer.alloc(12);
  buf.writeUInt32LE(i, 0);
  buf.writeDoubleLE(t0Us, 4);
  return [...head, ...error, ['frameSentThrough', true, tsUs], ['metrics', buf, tsUs + 20_000]];
}
/** decodeMetrics of the dry run. */
const dryDecode = (buf) => syntheticMetrics(buf.readUInt32LE(0), buf.readDoubleLE(4));

/**
 * Test hooks of tap --dry, from --dry-<name>=<value>: error '<code>@<s>' (see dryEvents), hang 'stopAsync'
 * (never settles), readiness '<ms>' (verdict after ms) or 'fail:<code>', readiness-timeout '<ms>' (tap's wait).
 */
function dryOptions(args) {
  const opt = (name) => args.find((a) => a.startsWith(`--dry-${name}=`))?.slice(name.length + 7);
  const ms = Number(opt('readiness-timeout'));
  const readinessTimeoutMs = ms > 0 ? ms : undefined;
  return { error: opt('error'), hang: opt('hang'), readiness: opt('readiness'), readinessTimeoutMs };
}

/**
 * The SDK module of tap --dry: DRY_API plus a SmartSpectraSDK stand-in driven by dryEvents at 30 Hz. Timers and
 * clock come in through env {every, clear, after, nowUs}. As in the API reference: start() only while idle,
 * reset() only after kError, a lifecycle error carries code and retryable; stopAsync() reports kStopping, kIdle.
 */
function drySdkModule(env, opts = {}) {
  const fail = (code, message, retryable = false) => Object.assign(new Error(message), { code, retryable });
  class SmartSpectraSDK {
    static availableCameras() { return DRY_CAMERAS; }
    constructor() { this.cb = {}; this.status = 1; this.timer = null; }
    on(ev, fn) { this.cb[ev] = fn; return this; }
    useCamera() { return this; }
    emit(ev, ...a) {
      if (ev === 'processingStatus') this.status = a[0];
      this.cb[ev]?.(...a);
    }
    checkDeviceReadiness() {
      const failCode = /^fail:(\d+)$/.exec(opts.readiness ?? '')?.[1];
      if (failCode) return Promise.reject(fail(Number(failCode), 'dry readiness failure', true));
      const afterMs = Number(opts.readiness) || 0;
      return new Promise((ok) => env.after(() => ok({ verdict: 'ready', reason: 'dry run' }), afterMs));
    }
    start() {
      if (this.status !== 1) throw fail(1, `start() in processing status ${this.status}`);
      const t0Us = env.nowUs();
      let i = 0;
      const tick = () => { for (const [ev, ...a] of dryEvents(i++, t0Us, opts.error)) this.emit(ev, ...a); };
      this.timer = env.every(tick, 1000 / 30);
    }
    reset() {
      if (this.status !== 5) throw fail(1, 'reset() is for kError');
      env.clear(this.timer);
      this.emit('processingStatus', 1);
    }
    stopAsync() {
      if (opts.hang === 'stopAsync') return new Promise(() => {});
      env.clear(this.timer);
      this.emit('processingStatus', 4);
      this.emit('processingStatus', 1);
      return Promise.resolve();
    }
    destroy() { return Promise.resolve(); }
  }
  return { ...DRY_API, SmartSpectraSDK };
}

module.exports = {
  LANDMARKS, LIP_PAIRS, HM_FRAMES, METRICS, SPARE_EXTRA, PROCESSING_NAMES, VALIDATION_NAMES, ERROR_NAMES, KEY_HINT,
  toUs, initialState, breakTrack, reduce, eyeSpanPx, lipGapPx, noseSpeedPxPerS, metricNames, need, requestedMetrics,
  sdkOptions, processingName, validationName, errorName, errorCodeOf, enumMismatches, enumChecks, enumLine, enumReport,
  validationLine, processingLine, frameLine, errorLine, loopLine, loopStats, rawLine, eventRecord, errorAction,
  errorHint, stopBudget, agoMs, pickCamera, parseEnvText, typeName, probeMetrics, longLike, syntheticMetrics,
  DRY_API, DRY_CAMERAS, dryEvents, dryDecode, dryOptions, drySdkModule,
};
