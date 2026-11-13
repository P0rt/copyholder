'use strict';
// tap's IPC answers as events.jsonl lines (spec 7.12 questions 1, 2, 4 and 10; docs/protocol.md): 'cameras',
// 'camera', 'readiness', 'probe' and 'enums' become tap_cameras, tap_camera, tap_readiness, tap_probe and
// tap_enums, by:'host'. analysis/smoke/tap-output.ts reads them as tap's messages (its ipcMessageOf).
//
// Left out on purpose: camera ids (a device identifier; tap finds the camera by name on every start, spec 7.1)
// and the probe's xRange and yRange (the face's extent in frame pixels: face coordinates do not leave the Mac by
// default, spec 12.5). The probe sits under `ipc` as tap sent it ({t:'probe', ...}), because `points` (its mesh
// point count) is a field name an events.jsonl line may not carry at its top level (core/schemas LANDMARK_FIELDS).

const MAX_TEXT = 200;
const MAX_ITEMS = 64;

const text = (v) => (typeof v === 'string' ? v.slice(0, MAX_TEXT) : null);
const finite = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const flag = (v) => (typeof v === 'boolean' ? v : null);
const texts = (v) => (Array.isArray(v) ? v.filter((x) => typeof x === 'string').slice(0, MAX_ITEMS).map((x) => x.slice(0, MAX_TEXT)) : null);

/** Camera names of a 'cameras' list, in order; a camera without a name stays as name null. */
function cameraList(list) {
  return (Array.isArray(list) ? list : []).slice(0, MAX_ITEMS).map((c) => ({ name: text(c && c.name) }));
}

/** {width, height, fps} as tap asked, when it is three whole numbers. */
function requestedFormat(v) {
  return Array.isArray(v) && v.length === 3 && v.every((x) => Number.isSafeInteger(x) && x > 0) ? v.slice(0, 3) : null;
}

function enumChecks(checks) {
  return (Array.isArray(checks) ? checks : []).slice(0, 8).filter((c) => c && typeof c === 'object').map((c) => ({
    label: text(c.label),
    differences: texts(c.differences) ?? [],
  }));
}

/** The probe of one decoded packet (live/reduce.cjs probeMetrics plus tsCbType), without xRange and yRange. */
function probeMessage(m) {
  const out = { t: 'probe' };
  if (finite(m.packet) !== null) out.packet = m.packet;
  out.fields = texts(m.fields) ?? [];
  out.tsType = text(m.tsType);
  for (const k of ['tr', 'talk', 'frames', 'points']) out[k] = finite(m[k]);
  out.lipsY13BelowY14 = flag(m.lipsY13BelowY14);
  out.cornersX78BelowX308 = flag(m.cornersX78BelowX308);
  if (typeof m.tsCbType === 'string') out.tsCbType = text(m.tsCbType);
  return out;
}

/**
 * The events.jsonl line of one tap message, as {e, fields}, or null for a message that is no tap_* event.
 * `fields` never holds n, e or by: SessionStore.writeHostEvent adds them.
 */
function tapEventOf(m) {
  if (!m || typeof m !== 'object') return null;
  switch (m.t) {
    case 'cameras':
      return { e: 'tap_cameras', fields: { list: cameraList(m.list) } };
    case 'camera': {
      const fields = { name: text(m.name), requested: requestedFormat(m.requested), metrics: texts(m.metrics) };
      if (m.dry === true) fields.dry = true;
      return { e: 'tap_camera', fields };
    }
    case 'readiness':
      // the early {verdict:null, reason:'timeout'} comes first when checkDeviceReadiness() is slow; a verdict may follow
      return { e: 'tap_readiness', fields: { verdict: text(m.verdict), reason: text(m.reason) } };
    case 'probe':
      return { e: 'tap_probe', fields: { ipc: probeMessage(m) } };
    case 'enums':
      return { e: 'tap_enums', fields: { checks: enumChecks(m.checks) } };
    default:
      return null;
  }
}

const TAP_EVENT_NAMES = Object.freeze(['tap_cameras', 'tap_camera', 'tap_readiness', 'tap_probe', 'tap_enums']);

module.exports = { TAP_EVENT_NAMES, tapEventOf, probeMessage, cameraList };
