'use strict';
// Mock tap (spec 6.5 live:sim and live:from; tests): the same fork IPC and /tap socket as
// live/tap.cjs (docs/protocol.md), without the SDK. After host's `start` it sends samples.jsonl
// lines (spec 8.1) at about 30 Hz from a synthetic breathing trace, or replays a recording's
// detector_in.jsonl in real time (--replay <session folder>), and writes its own samples.jsonl
// into the session folder. Status codes and names are those of the real tap (live/lib/sdk-codes.cjs).
//
// live:from (--replay): the replay waits for host's {t:'replay_start'}, sent when the page starts
// channel 0 of the recording in place of the microphone. Then it goes Running and sends each recorded
// line (nArr - first audio sample) / 48 ms after that moment, so packets meet the audio as they did
// in the recording (spec 6.5). After the last line it sends {t:'replay_done'} and leaves Running.
//
// Script (JSON, from --script <json|file> or COPYHOLDER_MOCK_SCRIPT), all fields optional:
//   rateHz 30, seed 1, breathPeriodS 4.6, startDelayMs 300 (Starting -> Running)
//   firstPacketAfterMs 0              the first packet comes this long after Running
//   talking [[startMs, endMs], ...]   talking flag on (and lips open) in these spans
//   codes [{atMs, code}, ...]         validationStatus codes at these times
//   stallAfterMs                      the SDK goes quiet (still Running, process alive): host sees tap_lost
//   idleAfterMs                       the SDK leaves Running by itself (kIdle, no error, process alive)
//   errorAtMs, errorCode 5            SDK error event at this time; then no more packets (or exit, as tap)
//   errorCall                         the SDK call named in that sdk_error ('call', e.g. 'useCamera()'); default null
//   restartMs 500                     code 8 before the first packet: kError, Starting after this long, Running again
//   exitAfterMs, exitCode 1           the process dies at this time (a crash)
//   stopHangMs                        host's stop takes this long (a slow SDK stop; host may kill the mock)
//   cameras ["Mock camera (no SDK)"]  the names availableCameras() gives (null: a camera without a name)
//   cameraName ''                     COPYHOLDER_CAMERA_NAME as tap reads it (a part of a name); '' takes the only camera
//   camerasAndExit                    the same as cameras ["Mock camera A", "Mock camera B"]: tap lists them and exits
//   configError {code, call, message} an SDK failure in tap's configure(): code (null: no SDK code) from call
//                                     (default 'useCamera()'), handled as tap does (spec 7.1 table)
//   enumDifferences {label: [...]}    smoke: what tap's enum check finds for a label, e.g. ["kSustainedLowFrameRate=14"]
//   print [{to, text, when}, ...]     more console lines, e.g. the SDK's own log: to 'stdout' (default) or 'stderr',
//                                     when 'config', 'start' (default) or 'stop'
//   readiness 'ready'                 smoke: the checkDeviceReadiness() verdict at start, 'ready', 'timeout'
//                                     (the early {verdict: null, reason: 'timeout'}, then ready) or 'fail'
// Times count from `start`. COPYHOLDER_MOCK_LOG=<file> appends every IPC message received (tests).
//
// Smoke (config.smoke, spec 7.12): like tap, the camera list, the camera with its metric set and the enum
// checks after config, the readiness verdict before `started`, and a probe of the first packet, over IPC and
// as the console lines tap prints for them (live/tap.cjs, live/reduce.cjs): the camera header on stderr and
// the names on stdout, the enum lines, the readiness line and `packet <n>: {...}`. SDK errors and a camera
// that cannot be picked print tap's lines too. Two pipes keep no common order, so the mock waits
// STREAM_GAP_MS between a line on one and a line on the other: host's tap.log then holds them as printed.
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { performance, monitorEventLoopDelay } = require('node:perf_hooks');
const { WebSocketServer, WebSocket } = require('ws');
const { checkUpgrade, rejectUpgrade } = require('./lib/guard.cjs');
const { SyntheticStream, LANDMARK_IDS } = require('./lib/synth-trace.cjs');
const { loadReplay } = require('./lib/replay.cjs');
const { processingName, validationName, errorName, errorAction } = require('./lib/sdk-codes.cjs');
const { PULSE_EVERY_MS } = require('./lib/tap-timing.cjs');
const { MAIN_METRICS } = require('./lib/repo-info.cjs');
const R = require('./reduce.cjs'); // pure, no SDK: tap's own console formats and camera pick

// processingStatus codes of the SDK enum (live/reduce.cjs PROCESSING_NAMES).
const PROCESSING = Object.freeze({ idle: 1, starting: 2, running: 3, stopping: 4, error: 5 });
const MOCK_CAMERA = 'Mock camera (no SDK)';
const ENUM_LABELS = Object.freeze(['ProcessingStatus', 'ValidationCode', 'SmartSpectraErrorCode']);
/** tap's smoke enum checks (live/reduce.cjs enumChecks): the mock's tables are the same ones. */
const MOCK_ENUM_CHECKS = Object.freeze(ENUM_LABELS.map((label) => Object.freeze({ label, differences: Object.freeze([]) })));
const PRINT_WHEN = Object.freeze(['config', 'start', 'stop']);
const READINESS = Object.freeze(['ready', 'timeout', 'fail']);
/** tap's showCameras() header (live/tap.cjs), after its 'tap: ' prefix. */
const CAMERAS_HEADER = 'cameras (copy one name into settings.env as COPYHOLDER_CAMERA_NAME=...):';
const STREAM_GAP_MS = 50;

function num(v, fallback, min, max) {
  return typeof v === 'number' && Number.isFinite(v) && v >= min && v <= max ? v : fallback;
}

function optMs(v) {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null;
}

/** Console lines of the script: {to, text, when}; items without text are dropped. */
function printItems(v) {
  return (Array.isArray(v) ? v : []).filter((p) => p && typeof p.text === 'string').map((p) => ({
    to: p.to === 'stderr' ? 'stderr' : 'stdout',
    text: p.text,
    when: PRINT_WHEN.includes(p.when) ? p.when : 'start',
  }));
}

/** configError: {code: integer or null, call, message}; anything else is no error. */
function configErrorOf(v) {
  if (!v || typeof v !== 'object' || !(v.code === null || Number.isInteger(v.code))) return null;
  return {
    code: v.code,
    call: typeof v.call === 'string' && v.call ? v.call : 'useCamera()',
    message: typeof v.message === 'string' ? v.message : 'mock camera failure',
  };
}

/** enumDifferences: label -> `kName=code` strings, for tap's three labels only. */
function enumDifferencesOf(v) {
  const out = {};
  if (!v || typeof v !== 'object') return out;
  for (const label of ENUM_LABELS) {
    if (Array.isArray(v[label])) out[label] = v[label].filter((d) => typeof d === 'string');
  }
  return out;
}

/** Script fields with their defaults; unknown or malformed fields are ignored. */
function normalizeScript(s) {
  const o = s && typeof s === 'object' ? s : {};
  return {
    rateHz: num(o.rateHz, 30, 1, 240),
    seed: num(o.seed, 1, 0, 2 ** 32),
    breathPeriodS: num(o.breathPeriodS, 4.6, 0.5, 60),
    startDelayMs: num(o.startDelayMs, 300, 0, 60_000),
    firstPacketAfterMs: num(o.firstPacketAfterMs, 0, 0, 60_000),
    talking: Array.isArray(o.talking) ? o.talking.filter((p) => Array.isArray(p) && p.length === 2) : [],
    codes: Array.isArray(o.codes) ? o.codes.filter((c) => c && optMs(c.atMs) !== null && Number.isInteger(c.code)) : [],
    stallAfterMs: optMs(o.stallAfterMs),
    idleAfterMs: optMs(o.idleAfterMs),
    errorAtMs: optMs(o.errorAtMs),
    errorCode: Number.isInteger(o.errorCode) ? o.errorCode : 5,
    errorCall: typeof o.errorCall === 'string' ? o.errorCall : null,
    restartMs: num(o.restartMs, 500, 0, 60_000),
    exitAfterMs: optMs(o.exitAfterMs),
    exitCode: Number.isInteger(o.exitCode) ? o.exitCode : 1,
    stopHangMs: optMs(o.stopHangMs),
    camerasAndExit: o.camerasAndExit === true,
    cameras: Array.isArray(o.cameras) ? o.cameras.filter((c) => c === null || typeof c === 'string') : null,
    cameraName: typeof o.cameraName === 'string' ? o.cameraName : '',
    configError: configErrorOf(o.configError),
    enumDifferences: enumDifferencesOf(o.enumDifferences),
    print: printItems(o.print),
    readiness: READINESS.includes(o.readiness) ? o.readiness : 'ready',
  };
}

function parseMockArgs(argv, env) {
  let replay = null;
  let scriptText = env.COPYHOLDER_MOCK_SCRIPT || null;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--replay') replay = argv[++i] ?? null;
    else if (argv[i] === '--script') scriptText = argv[++i] ?? null;
  }
  let script = {};
  if (scriptText) {
    const text = scriptText.trim().startsWith('{') ? scriptText : fs.readFileSync(scriptText, 'utf8');
    script = JSON.parse(text);
  }
  return { replay: replay ? path.resolve(replay) : null, script: normalizeScript(script) };
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Wall-clock microseconds, an integer like the SDK's timestamps. */
function nowUs() {
  return Math.round((performance.timeOrigin + performance.now()) * 1000);
}

/** The pulse to host (spec 7.1, 7.2): packets in the last period and the age of the last one. */
function pulseMessage(packets, lastPacketAtMs, nowMs) {
  return { t: 'pulse', packets, last_ago_ms: lastPacketAtMs === null ? null : Math.max(0, Math.round(nowMs - lastPacketAtMs)) };
}

class MockTap {
  constructor({ replay, script }, env) {
    this.replayDir = replay;
    this.script = script;
    this.logFile = env.COPYHOLDER_MOCK_LOG || null;
    this.config = null;
    this.client = null;
    this.fd = null;
    this.seq = 0;
    this.started = false;
    this.stopping = false;
    this.stopped = false;
    this.halted = false; // after an SDK error, a stall or kIdle: no more packets
    this.gen = 0; // one SDK start; a restart begins the next and ends the loops of the last
    this.restarted = false;
    this.replayBegun = false;
    this.packets = 0; // since the last pulse
    this.totalPackets = 0;
    this.lastPacketAt = null; // performance.now() of the last packet
    this.timers = [];
    this.loopTimer = null; // the packet loop's next tick
    this.validation = null;
    this.smoke = false; // config.smoke: spec 7.12 messages
    this.readinessSent = false;
    this.probes = 0; // smoke: packet 1 and the first packet with landmarks are probed, as tap does
    this.cams = []; // availableCameras()
    this.configured = false; // tap's configure() is done; a start that came before waits for it
    this.startQueued = false;
    this.console = Promise.resolve(); // console lines, in the order written (see STREAM_GAP_MS)
    this.lastStream = null;
  }

  log(msg) {
    if (!this.logFile) return;
    fs.appendFileSync(this.logFile, JSON.stringify({ wallMs: Date.now(), msg }) + '\n');
  }

  boot() {
    this.server = http.createServer((_req, res) => {
      res.writeHead(404);
      res.end();
    });
    this.wss = new WebSocketServer({ noServer: true, maxPayload: 4096 });
    this.server.on('upgrade', (req, socket, head) => {
      if (!this.config) return rejectUpgrade(socket, 403);
      const v = checkUpgrade(req, { path: '/tap', token: this.config.token, origin: this.config.origin, port: this.port });
      if (!v.ok) return rejectUpgrade(socket, v.status);
      if (this.client) return rejectUpgrade(socket, 409); // one client only (spec 7.1)
      this.wss.handleUpgrade(req, socket, head, (ws) => {
        this.client = ws;
        ws.on('close', () => {
          if (this.client === ws) this.client = null;
        });
        ws.on('error', () => {});
      });
      return undefined;
    });
    process.on('message', (m) => this.onMessage(m));
    process.on('disconnect', () => this.exit(0)); // host is gone
    this.server.listen(0, '127.0.0.1', () => {
      this.port = this.server.address().port;
      this.tell({ t: 'ready', port: this.port });
    });
  }

  onMessage(m) {
    this.log(m);
    if (!m || typeof m !== 'object') return;
    if (m.t === 'config' && !this.config) {
      this.onConfig(m).catch((err) => {
        this.say(String(err && err.stack ? err.stack : err));
        this.stop(1);
      });
    }
    else if (m.t === 'start') this.start();
    else if (m.t === 'replay_start') this.replayStart();
    else if (m.t === 'stop') this.stopFromHost();
  }

  /**
   * host's config, as tap's configure() (live/tap.cjs): the camera list (smoke, or no camera to pick), the
   * camera by name, an SDK failure of the script, then the camera and (smoke) the enum checks.
   */
  async onConfig(m) {
    if (![m.token, m.origin, m.sessionDir].every((v) => typeof v === 'string' && v)) return;
    this.config = m;
    this.smoke = m.smoke === true;
    this.print('config');
    const s = this.script;
    const fail = s.configError;
    if (fail && /^SmartSpectraSDK\.availableCameras/.test(fail.call)) {
      await this.failAtConfig(fail);
      return;
    }
    const names = s.camerasAndExit ? ['Mock camera A', 'Mock camera B'] : s.cameras ?? [MOCK_CAMERA];
    this.cams = names.map((name, i) => ({ id: `mock-${i}`, name }));
    const cam = R.pickCamera(this.cams, s.cameraName);
    if (this.smoke || !cam) await this.showCameras();
    if (!cam) {
      await this.say(s.cameraName
        ? `no camera name contains "${s.cameraName}"`
        : `${this.cams.length} cameras and no COPYHOLDER_CAMERA_NAME`);
      this.stop(1);
      return;
    }
    if (fail) {
      await this.failAtConfig(fail);
      return;
    }
    this.tell({ t: 'camera', id: cam.id, name: cam.name, requested: [1280, 720, 30], metrics: [...MAIN_METRICS] });
    if (this.smoke) {
      const checks = ENUM_LABELS.map((label) => ({ label, differences: s.enumDifferences[label] ?? [] }));
      for (const c of checks) this.write('stdout', R.enumLine(c));
      await this.console; // tap prints, then tells host
      this.tell({ t: 'enums', checks });
    }
    this.configured = true;
    if (this.startQueued) this.start();
  }

  /** One console line, after the lines written before it; STREAM_GAP_MS when it changes stream. */
  write(to, text) {
    const stream = to === 'stderr' ? process.stderr : process.stdout;
    this.console = this.console.then(async () => {
      if (this.lastStream !== null && this.lastStream !== stream) await delay(STREAM_GAP_MS);
      this.lastStream = stream;
      await new Promise((resolve) => {
        try {
          stream.write(`${text}\n`, () => resolve());
        } catch {
          resolve();
        }
      });
    });
    return this.console;
  }

  /** tap's say(): stderr, after 'tap: '. */
  say(text) {
    return this.write('stderr', `tap: ${text}`);
  }

  /** The script's console lines for this moment (host tees them into tap.log). */
  print(when) {
    for (const p of this.script.print) if (p.when === when) this.write(p.to, p.text);
  }

  /** tap's showCameras(): the header, one name per line, then the list to host. */
  async showCameras() {
    this.say(CAMERAS_HEADER);
    for (const c of this.cams) this.write('stdout', c.name ?? `(no name) id=${c.id}`);
    await this.console;
    this.tell({ t: 'cameras', list: this.cams.map((c) => ({ id: c.id, name: c.name ?? null })) });
  }

  /** An SDK call of configure() failed: tap's onThrow (live/tap.cjs), then its exit. */
  async failAtConfig({ code, call, message }) {
    const text = `${call} failed: ${message}`; // tap's call() names the call
    if (code === null) {
      await this.say(text);
      this.tell({ t: 'sdk_error', code: null, name: 'tap', message: text, retryable: false, call, action: 'exit' });
    } else {
      await this.reportSdkError(code, text, call, errorAction(code, false));
    }
    this.stop(1);
  }

  /** tap's onSdkError (live/tap.cjs): the sdk_error to host, tap's lines about it, the camera list for code 7. */
  async reportSdkError(code, message, call, action) {
    const name = errorName(code);
    this.tell({ t: 'sdk_error', code, name, message, retryable: false, call, action });
    this.say(`SDK error ${code} ${name}${call ? ` from ${call}` : ''}: ${message}`);
    if (action === 'exit_key') this.write('stderr', R.KEY_HINT);
    const hint = R.errorHint(code, call, this.smoke);
    if (hint) this.say(hint);
    if (action === 'exit_cameras') await this.showCameras();
    await this.console;
  }

  /** smoke: the checkDeviceReadiness() verdict, once, with tap's console lines (live/tap.cjs checkReadiness). */
  sendReadiness() {
    if (this.readinessSent) return;
    this.readinessSent = true;
    const r = this.script.readiness;
    if (r === 'timeout') {
      this.say('checkDeviceReadiness() did not settle in 30 s; start() waits for it');
      this.tell({ t: 'readiness', verdict: null, reason: 'timeout' });
    }
    if (r === 'fail') {
      const reason = 'checkDeviceReadiness() failed: mock readiness failure'; // tap's call() wrapper
      this.say(reason);
      this.tell({ t: 'readiness', verdict: null, reason });
    } else {
      this.write('stdout', 'checkDeviceReadiness(): ready (camera ok)');
      this.tell({ t: 'readiness', verdict: 'ready', reason: 'camera ok' });
    }
  }

  /** smoke: tap's probe of one packet (live/reduce.cjs probeMetrics plus tsCbType), from its samples.jsonl line. */
  probeOf(line) {
    const pts = line.lm && Array.isArray(line.lm.p) ? line.lm.p : [];
    const at = (id) => pts[LANDMARK_IDS.indexOf(id)] ?? null;
    const below = (a, b, axis) => (a && b ? a[axis] < b[axis] : null);
    const range = (vs) => (vs.length > 0 ? [Math.min(...vs), Math.max(...vs)] : null);
    return {
      t: 'probe',
      packet: this.totalPackets,
      fields: ['breathing', 'face'],
      tsType: 'number',
      tr: line.tr.length,
      talk: line.talk.length,
      frames: line.lm ? 1 : 0,
      points: pts.length,
      lipsY13BelowY14: below(at(13), at(14), 1),
      cornersX78BelowX308: below(at(78), at(308), 0),
      xRange: range(pts.map((p) => p[0])),
      yRange: range(pts.map((p) => p[1])),
      tsCbType: 'number',
    };
  }

  /** One samples.jsonl line: to the file, then to the socket, exactly the same text (spec 7.1). */
  emit(line) {
    const text = JSON.stringify(line);
    if (this.fd !== null) fs.writeSync(this.fd, text + '\n');
    if (this.client && this.client.readyState === WebSocket.OPEN) this.client.send(text);
  }

  tArrNs() {
    return String(process.hrtime.bigint());
  }

  nextSeq() {
    this.seq += 1;
    return this.seq;
  }

  /** IPC to host; a closed channel means host is gone and `disconnect` ends this process. */
  tell(msg) {
    try {
      process.send(msg);
    } catch {
      // channel closed
    }
  }

  setProcessing(code) {
    const name = processingName(code);
    this.emit({ seq: this.nextSeq(), k: 's', tArrNs: this.tArrNs(), code, name });
    this.tell({ t: 'status', kind: 'processingStatus', code, name });
  }

  setValidation(code) {
    const name = validationName(code);
    this.emit({ seq: this.nextSeq(), k: 'v', tArrNs: this.tArrNs(), tsCbUs: nowUs(), code, name, hint: '' });
    if (this.validation !== code) this.tell({ t: 'status', kind: 'validationStatus', code, name });
    this.validation = code;
  }

  later(ms, fn) {
    this.timers.push(setTimeout(fn, ms));
  }

  countPacket() {
    this.packets += 1;
    this.totalPackets += 1;
    this.lastPacketAt = performance.now();
  }

  /** host's start, sent only after consent (spec 12.2): files, status lines, then packets. */
  start() {
    if (this.started || this.stopping || !this.config) return;
    if (!this.configured) {
      this.startQueued = true; // tap's configure() is synchronous, so its start never comes first
      return;
    }
    this.started = true;
    this.t0 = performance.now();
    this.fd = fs.openSync(path.join(this.config.sessionDir, 'samples.jsonl'), 'a');
    // A replay keeps the recorded seq numbers; the mock's own lines number on above them.
    this.replayItems = this.replayDir ? loadReplay(this.replayDir) : null;
    if (this.replayItems) {
      for (const it of this.replayItems) if (Number.isFinite(it.line.seq)) this.seq = Math.max(this.seq, it.line.seq);
    }
    this.print('start');
    if (this.smoke) this.sendReadiness(); // tap waits for the verdict before start() (spec 7.12 question 1)
    this.tell({ t: 'started' });
    this.setProcessing(PROCESSING.starting);
    const s = this.script;
    if (!this.replayItems) {
      const gen = this.gen;
      this.later(s.startDelayMs, () => this.goRunning(gen)); // a replay runs from host's replay_start
    }
    for (const c of s.codes) this.later(c.atMs, () => !this.stopping && this.setValidation(c.code));
    if (s.errorAtMs !== null) this.later(s.errorAtMs, () => this.sdkError(s.errorCode));
    if (s.exitAfterMs !== null) this.later(s.exitAfterMs, () => process.exit(s.exitCode));
    if (s.idleAfterMs !== null) {
      this.later(s.idleAfterMs, () => {
        if (this.stopping) return;
        this.halted = true; // the SDK stopped by itself: no error event, no more packets
        this.setProcessing(PROCESSING.idle);
      });
    }
    this.timers.push(setInterval(() => {
      this.tell(pulseMessage(this.packets, this.lastPacketAt, performance.now()));
      this.packets = 0;
    }, PULSE_EVERY_MS));
    this.loop = monitorEventLoopDelay({ resolution: 10 });
    this.loop.enable();
    this.timers.push(setInterval(() => {
      const ms = (ns) => Math.max(0, Math.round((ns / 1e6 - 10) * 1000) / 1000);
      this.emit({ k: 'l', tArrNs: this.tArrNs(), p50Ms: ms(this.loop.percentile(50)), p99Ms: ms(this.loop.percentile(99)), maxMs: ms(this.loop.max) });
      this.loop.reset();
    }, 1000));
  }

  /** SDK Running for start `gen`: the synthetic stream, or the recorded lines from now on. */
  goRunning(gen) {
    if (this.stopping || this.halted || gen !== this.gen) return;
    this.setProcessing(PROCESSING.running);
    if (this.replayItems) {
      this.runReplay(gen);
      return;
    }
    if (this.validation === null) this.setValidation(0);
    this.later(this.script.firstPacketAfterMs, () => this.runSynthetic(gen));
  }

  /** live:from: the page started the replayed audio (host's replay_start); the recorded lines go from here. */
  replayStart() {
    if (!this.started || this.stopping || !this.replayItems || this.replayBegun) return;
    this.replayBegun = true;
    this.goRunning(this.gen);
  }

  /** An SDK error event, handled as tap does (spec 7.1 table): exits for 2, 3, 7, 13; one restart for 8 before data. */
  sdkError(code) {
    if (this.stopping) return;
    const name = errorName(code);
    const message = 'mock SDK error';
    const action = errorAction(code, this.totalPackets === 0 && !this.restarted);
    this.emit({ seq: this.nextSeq(), k: 'e', tArrNs: this.tArrNs(), code, name, message, retryable: false });
    if (action === 'reset_restart') {
      this.reportSdkError(code, message, this.script.errorCall, action);
      this.restart();
      return;
    }
    this.halted = true;
    this.reportSdkError(code, message, this.script.errorCall, action).then(() => {
      if (action.startsWith('exit')) this.stop(1);
    });
  }

  /** tap's one restart after code 8 before the first packet (spec 7.1): kError, reset(), start() again. */
  restart() {
    this.restarted = true;
    this.gen += 1; // the packet loop and a pending Running of the first start end here
    const gen = this.gen;
    this.setProcessing(PROCESSING.error);
    this.later(this.script.restartMs, () => {
      if (this.stopping || gen !== this.gen) return;
      this.setProcessing(PROCESSING.starting);
      this.later(this.script.startDelayMs, () => this.goRunning(gen));
    });
  }

  /** One SDK frame: frameSentThrough, then the metrics packet. */
  emitFrame(tS) {
    const f = this.stream.frame(tS);
    const tsCbUs = nowUs();
    const ts = tsCbUs - 40_000;
    this.emit({ seq: this.nextSeq(), k: 'f', tArrNs: this.tArrNs(), tsCbUs: ts, sent: true });
    const line = {
      seq: this.nextSeq(), k: 'm', tArrNs: this.tArrNs(), tsCbUs,
      tr: [[ts, f.value]], talk: [[ts, f.talking]], g: f.g, hm: f.hm,
      lm: { ts, reset: 0, p: f.points },
    };
    this.emit(line);
    this.countPacket();
    if (this.smoke && this.probes < 2 && (this.totalPackets === 1 || line.lm)) {
      this.probes = line.lm ? 2 : 1;
      const probe = this.probeOf(line);
      const { t: _t, packet, ...shown } = probe;
      this.write('stdout', `packet ${packet}: ${JSON.stringify(shown)}`); // tap's probe line
      this.tell(probe);
    }
  }

  runSynthetic(gen) {
    const s = this.script;
    if (!this.stream) {
      this.stream = new SyntheticStream({ seed: s.seed, breathPeriodS: s.breathPeriodS, talking: s.talking });
      this.streamT0 = performance.now();
    }
    const periodMs = 1000 / s.rateHz;
    const base = performance.now();
    let k = 0;
    const tick = () => {
      if (this.stopping || this.halted || gen !== this.gen) return;
      if (s.stallAfterMs !== null && performance.now() - this.t0 >= s.stallAfterMs) {
        this.halted = true; // the SDK went quiet; pulses now report 0 packets
        return;
      }
      this.emitFrame((performance.now() - this.streamT0) / 1000);
      k += 1;
      this.loopTimer = setTimeout(tick, Math.max(0, base + k * periodMs - performance.now()));
    };
    tick();
  }

  /** live:from (spec 6.5): the recorded packets and codes at their recorded offsets from the replay start. */
  runReplay(gen) {
    const items = this.replayItems;
    const base = performance.now();
    let i = 0;
    const pump = () => {
      if (this.stopping || this.halted || gen !== this.gen) return;
      const now = performance.now() - base;
      while (i < items.length && items[i].atMs <= now) {
        const { seq, k, ...rest } = items[i].line;
        this.emit({ seq, k, tArrNs: this.tArrNs(), ...rest });
        if (k === 'm') this.countPacket();
        i += 1;
      }
      if (i >= items.length) {
        // The recording is over: host stops watching for silence, then the stand-in SDK leaves Running.
        this.tell({ t: 'replay_done' });
        this.setProcessing(PROCESSING.idle);
        return;
      }
      this.loopTimer = setTimeout(pump, Math.max(0, items[i].atMs - (performance.now() - base)));
    };
    pump();
  }

  /** host's stop; with stopHangMs the stand-in SDK takes that long, as a slow stopAsync() would. */
  stopFromHost() {
    const hang = this.script.stopHangMs;
    if (hang === null || this.stopping) {
      this.stop(0);
      return;
    }
    this.halted = true;
    setTimeout(() => this.stop(0), hang);
  }

  stop(code = 0) {
    if (this.stopping) return;
    this.stopping = true;
    for (const t of this.timers) clearTimeout(t);
    clearTimeout(this.loopTimer);
    if (this.started) {
      this.setProcessing(PROCESSING.stopping);
      this.setProcessing(PROCESSING.idle);
    }
    if (this.fd !== null) {
      fs.closeSync(this.fd);
      this.fd = null;
    }
    this.print('stop');
    this.stopped = true;
    try {
      process.send({ t: 'stopped' }, () => this.exit(code));
    } catch {
      this.exit(code);
    }
  }

  /** Exits once its console lines are out and flushed (pipes are asynchronous on macOS), as tap does. */
  exit(code) {
    if (this.loop) this.loop.disable();
    if (this.client) this.client.terminate();
    if (this.server) this.server.close();
    process.exitCode = code;
    const done = () => process.exit(code);
    setTimeout(done, 1000).unref();
    this.console.then(() => {
      try {
        process.stdout.write('', () => process.stderr.write('', done));
      } catch {
        done();
      }
    });
  }
}

if (require.main === module) {
  if (typeof process.send !== 'function') {
    process.stderr.write('mock-tap.cjs is started by live/host.cjs (child_process.fork).\n');
    process.exit(2);
  }
  new MockTap(parseMockArgs(process.argv.slice(2), process.env), process.env).boot();
}

module.exports = {
  MockTap, parseMockArgs, normalizeScript, pulseMessage, PROCESSING, MOCK_CAMERA, MOCK_ENUM_CHECKS, CAMERAS_HEADER, STREAM_GAP_MS,
};
