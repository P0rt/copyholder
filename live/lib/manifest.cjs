'use strict';
// manifest.json of a session folder (spec 8.1): the spec fields (kind, versions, devices, plan seal,
// file hashes) plus the host's own record of the run (mode, pack, state, end, unusable mark, served
// narrator files). core/schemas/session.ts validateManifest accepts the extra fields; the key order
// follows core/schemas/jsonl.ts KEY_ORDERS['manifest.json'].

const MAX_TEXT = 200;

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function text(v) {
  return typeof v === 'string' && v.length > 0 ? v.slice(0, MAX_TEXT) : null;
}

function wholeNumber(v) {
  return typeof v === 'number' && Number.isSafeInteger(v) && v > 0 ? v : null;
}

/** Primitive values of the settings the page sends (getSettings() plus names, docs/protocol.md). */
function plainSettings(settings) {
  if (!isPlainObject(settings)) return null;
  const out = {};
  for (const [k, v] of Object.entries(settings).slice(0, 64)) {
    if (typeof v === 'string') out[k] = v.slice(0, MAX_TEXT);
    else if ((typeof v === 'number' && Number.isFinite(v)) || typeof v === 'boolean' || v === null) out[k] = v;
  }
  // output: {name, sinkId, accepted}: the name goes to audio.output; sinkId (a device id) is dropped.
  if (isPlainObject(settings.output) && typeof settings.output.accepted === 'boolean') {
    out.output_accepted = settings.output.accepted;
  }
  return out;
}

/** The three browser processing flags all false (spec 6.3, 7.3). */
function micFlagsOff(settings) {
  return isPlainObject(settings) && settings.echoCancellation === false &&
    settings.noiseSuppression === false && settings.autoGainControl === false;
}

/**
 * Device facts from the hello frame {ua, settings} (docs/protocol.md). sampleRateHz is the
 * AudioContext rate (the clock of the recording), else the track's rate.
 */
function devicesFromHello(hello) {
  const s = hello && isPlainObject(hello.settings) ? hello.settings : null;
  const output = s && isPlainObject(s.output) ? s.output : null;
  return {
    microphone: s ? text(s.label) ?? text(s.microphone) : null,
    output: (output ? text(output.name) : null) ?? (s ? text(s.outputDevice) ?? text(s.output) : null),
    sampleRateHz: s ? wholeNumber(s.contextSampleRate) ?? wholeNumber(s.sampleRate) : null,
    micFlagsOff: micFlagsOff(s),
    settings: plainSettings(s),
    browser: hello ? text(hello.ua) : null,
  };
}

/**
 * manifest.json. `r` is the host's record of the run, `files` is {name: hex SHA-256}.
 * Values host cannot know are null. `unusable` is the mark of spec 6.3 / 7.2 (audio gap,
 * page reload, tap_lost, SDK error); the same reasons are events in events.jsonl.
 * `tap_killed`: tap did not stop within host's budget and was killed, so its files may miss
 * their last lines (event tap_killed). narrator.first_sealed_n: the sample of the first sealed
 * sound, null when none played; it decides whether the plan's text is spent (spec 10.4).
 * `dry`: tap ran its stand-in SDK (its 'camera' message said dry: true, tests only), so no SDK ran
 * and the folder is no recording (spec 6.5): quickcheck and analysis/smoke.ts read it and refuse
 * the folder (analysis/lib/dry-run.ts). It sits at the top level: core/schemas allows no extra
 * field inside `camera`. tap.log is a log, not a
 * recording file: it has no hash in `files`.
 */
function buildManifest(r, files) {
  const dev = devicesFromHello(r.hello);
  const m = {
    schema: 'session/1',
    id: r.id,
    kind: r.kind,
    started_utc: r.startedUtc,
    app_commit: r.git.commit,
    tree_clean: r.git.treeClean,
    plan_commitment: r.planCommitment,
    sdk: r.sdk,
    machine: r.machine,
    camera: r.camera,
    audio: {
      microphone: dev.microphone,
      output: dev.output,
      sample_rate: dev.sampleRateHz,
      mic_flags_off: dev.micFlagsOff,
      output_gain: r.outputGain,
      settings: dev.settings,
      ...r.audioSummary,
    },
    mode: r.mode,
    scenario: r.scenario,
    pack: r.kind === 'gate' ? r.pack : null,
    plan: r.plan,
    source: r.source,
    tap: r.tapKind,
    dry: r.dry === true,
    browser: dev.browser,
    state: r.state,
    consent_utc: r.consentUtc,
    ended_utc: r.endedUtc,
    end: r.end,
    unusable: r.unusableReasons.length > 0,
    unusable_reasons: [...r.unusableReasons],
    page_loads: r.pageLoads,
    tap_killed: r.tapKilled === true,
    narrator: {
      names: [...r.narratorNames],
      sealed_served: [...r.sealedServed],
      first_sealed_n: typeof r.firstSealedN === 'number' ? r.firstSealedN : null,
    },
    calib_from: r.calibFrom,
    files: {},
  };
  for (const name of Object.keys(files).sort()) m.files[name] = `sha256:${files[name]}`;
  return m;
}

module.exports = { plainSettings, micFlagsOff, devicesFromHello, buildManifest };
