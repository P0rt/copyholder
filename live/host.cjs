'use strict';
// host: local server and session recorder (spec 7.2). Runs tap as a child process (spec 7.1),
// serves the built page, and writes sessions/<id>/ from the page's /session socket (spec 8.1).
// Wire formats: docs/protocol.md. Needs only `ws` and Node built-ins; never loads the SDK.
//   node live/host.cjs --mode <gate|doctor|smoke|session|rehearsal|demo|spacebar|headstart|live-from|live-sim>
//     [--pack A] [--id <id>] [--plan <id>] [--from <id>] [--tap real|mock] [--no-open] [--level]
// Settings (settings.env or the environment, live/lib/settings.cjs): COPYHOLDER_PORT, COPYHOLDER_MIC_NAME,
// COPYHOLDER_OUTPUT_NAME. Test hooks: COPYHOLDER_TAP_STOP_BUDGET_MS shortens the wait for tap's stop
// (live/lib/tap-timing.cjs), COPYHOLDER_QUICKCHECK_TIMEOUT_MS the wait for quickcheck.
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { fork, spawn } = require('node:child_process');
const { performance } = require('node:perf_hooks');
const { pipeline } = require('node:stream');
const { WebSocketServer, WebSocket } = require('ws');

const { MODES, parseHostArgs, scenarioName, kindFor, needsCleanTree } = require('./lib/args.cjs');
const { resolvePaths, shownPath } = require('./lib/paths.cjs');
const { newToken, pageOrigin, cookieHeader, checkHttp, checkUpgrade, rejectUpgrade } = require('./lib/guard.cjs');
const { SessionStore } = require('./lib/session-store.cjs');
const { hashFolderFiles, rehashFiles, sha256FileSync, writeJsonAtomic } = require('./lib/hash.cjs');
const { appendLedgerStep, isLedgerKind, utcSeconds } = require('./lib/ledger.cjs');
const { TAP_SILENCE_MS, TAP_STOP_BUDGET_MS } = require('./lib/tap-timing.cjs');
const { quickcheckVerdict } = require('./lib/quickcheck.cjs');
const {
  noSource, gateSource, sealedSource, sampleSource, doctorSource, replaySource,
  narratorNames, needsPreflight, holdsSealedAudio, readNarrator, parseSealKey,
} = require('./lib/narrator.cjs');
const {
  gitInfo, machineModel, sdkVersionFrom, hostSetting, metricsSetting, requestedMetrics,
} = require('./lib/repo-info.cjs');
const { pageCalib, usableGain, detectorSetup } = require('./lib/calib.cjs');
const { openPage } = require('./lib/chrome.cjs');
const { sdkErrorText, isRunningStatus, isCameraFailure, ELECTRON_HINT } = require('./lib/sdk-codes.cjs');
const { baseIdFor, reserveSessionDir } = require('./lib/session-ids.cjs');
const {
  readCommitment, planHeardIn, firstUnheardDemo, freezeRefusal, revealRefusal, gitRefusal,
} = require('./lib/preconditions.cjs');
const { buildManifest } = require('./lib/manifest.cjs');
const { TAP_LOG, TapLog, teeTapOutput } = require('./lib/tap-log.cjs');
const { tapEventOf } = require('./lib/tap-events.cjs');
const { PORT_FALLBACK_CODES, portSetting, deviceSettings } = require('./lib/settings.cjs');

const TAP_READY_TIMEOUT_MS = 30_000;
const TAP_OUTPUT_WAIT_MS = 1000; // after tap's exit, its last lines may still be in the pipes
const PAGE_GONE_GRACE_MS = 4000; // a page that closed and was not loaded again within this time is lost
const ABORT_DRAIN_MS = 5000; // after an abort, wait this long for the page's last frames and `end`
const WATCH_EVERY_MS = 100; // the silence watch fires at most this long after TAP_SILENCE_MS
const QUICKCHECK_TIMEOUT_MS = 10 * 60_000;
const QUICKCHECK_DRAIN_MS = 500; // after quickcheck's exit, its last stdout lines
const MAX_PENDING_LINES = 10_000;
const MAX_PENDING_TAP_EVENTS = 100;
// Requests that load the page: during a recording they mean a reload (spec 7.2, 7.3).
const PAGE_LOAD_PATHS = new Set(['/', '/index.html', '/api/config']);

const STATIC_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.map': 'application/json',
  '.wav': 'audio/wav',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.wasm': 'application/wasm',
  '.txt': 'text/plain; charset=utf-8',
};

const BASE_HEADERS = {
  'Cache-Control': 'no-store',
  'Referrer-Policy': 'no-referrer',
  'X-Content-Type-Options': 'nosniff',
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
};

const TITLES = {
  gate: (o) => `Gate check, pack ${o.pack}.`,
  doctor: (o) => (o.level ? 'Sound check: output level and leak only.' : 'Sound and device check (doctor).'),
  smoke: () => 'First SDK run (smoke).',
  session: (o) => `Numbers session ${o.plan}.`,
  rehearsal: (o) => `Rehearsal session (plan ${o.plan}).`,
  demo: (o) => (o.plan ? `Demo take ${o.plan}.` : 'Demo take.'),
  spacebar: (o) => `Space bar block (plan ${o.plan}).`,
  headstart: () => 'Head Start session on the sample text.',
  'live-from': (o) => `Live page on the recording ${o.from}.`,
  'live-sim': (o) => `Listening run on plan ${o.plan} with a synthetic breathing trace.`,
};

function say(text) {
  process.stdout.write(`${text}\n`);
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Resolves true when `promise` settles first, false after `ms`; the timer never outlives the race. */
function settlesWithin(promise, ms) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), ms);
    const done = () => {
      clearTimeout(timer);
      resolve(true);
    };
    promise.then(done, done);
  });
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

/**
 * Sends `signal` to the process group of a child spawned with detached: true (its pid is the group's id).
 * False when there is no such group any more.
 */
function killGroup(child, signal) {
  if (!child || !Number.isSafeInteger(child.pid) || child.pid <= 0) return false;
  try {
    process.kill(-child.pid, signal);
    return true;
  } catch {
    return false; // ESRCH: every process of the group has ended
  }
}

/**
 * Ends a detached child's process group: SIGTERM first, so its own handlers end what they started in groups of
 * their own (doctor's TTS self-test, analysis/lib/tts.ts), then SIGKILL after graceMs; `after` runs once the
 * SIGKILL is sent (or at once when the group is gone already). Returns at once.
 */
function stopGroup(child, graceMs, after = () => {}) {
  if (!killGroup(child, 'SIGTERM')) {
    after();
    return;
  }
  setTimeout(() => {
    killGroup(child, 'SIGKILL');
    after();
  }, graceMs).unref();
}

/** Blocks the thread for `ms` (an exit handler cannot wait any other way). */
function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Math.max(0, ms));
}

/**
 * stopGroup for host's own exit ('exit' handler, internal error), where no timer runs any more: SIGTERM, a wait
 * of at most graceMs while the group lasts, then SIGKILL.
 */
function stopGroupSync(child, graceMs) {
  if (!killGroup(child, 'SIGTERM')) return;
  const until = Date.now() + graceMs;
  while (Date.now() < until && killGroup(child, 0)) sleepSync(Math.min(20, until - Date.now()));
  killGroup(child, 'SIGKILL');
}

/** "10 minutes" or "2 seconds", for a line in the terminal. */
function durationText(ms) {
  if (ms >= 60_000) {
    const min = Math.round(ms / 60_000);
    return `${min} minute${min === 1 ? '' : 's'}`;
  }
  const s = Math.max(1, Math.round(ms / 1000));
  return `${s} second${s === 1 ? '' : 's'}`;
}

/** A whole number of ms from the environment (test hooks), else the fallback. */
function msFromEnv(text, fallback) {
  const v = Number(text);
  return text && Number.isSafeInteger(v) && v > 0 ? v : fallback;
}

/** Seal key: COPYHOLDER_SEAL_KEY (tests, other systems) or the macOS keychain item copyholder-seal (spec 8.2). */
function loadSealKey(env) {
  if (env.COPYHOLDER_SEAL_KEY) return parseSealKey(env.COPYHOLDER_SEAL_KEY);
  if (process.platform !== 'darwin') throw new Error('the seal key is kept in the macOS keychain');
  const { execFileSync } = require('node:child_process');
  const out = execFileSync('/usr/bin/security', ['find-generic-password', '-s', 'copyholder-seal', '-w'], {
    encoding: 'utf8', timeout: 120_000, stdio: ['ignore', 'pipe', 'ignore'],
  });
  return parseSealKey(out);
}

class Host {
  constructor(opts, env) {
    this.opts = opts;
    this.env = env;
    this.paths = resolvePaths(env);
    this.mode = MODES[opts.mode];
    this.kind = kindFor(opts);
    this.scenario = scenarioName(opts);
    this.token = newToken();
    this.port = null;
    this.origin = null;
    this.server = null;
    this.wss = null;
    this.worker = null; // the current /session socket
    this.workerEnded = false;
    this.hello = null;
    this.pageLoads = 0; // the page document served (GET / with the token)
    this.phase = 'idle'; // idle -> recording -> closing -> closed
    this.preflightOk = false;
    this.pending = []; // lines that came before consent
    this.droppedBlocks = 0;
    this.unusable = new Set();
    this.sealedServed = new Set(); // audit only: fetching does not spend the text
    this.firstSealedN = null; // sample of the first sealed sound (spec 10.4)
    this.replayStarted = false; // live-from: the page started the replayed audio
    this.end = null;
    this.consentUtc = null;
    this.endedUtc = null;
    this.planCommitment = null;
    this.narrator = noSource();
    this.sourceDir = null;
    this.calib = null;
    this.calibFrom = { doctor: [], gate: null };
    this.doctorGain = null;
    this.savedHashes = null; // {name: hex} of the files manifest.json lists, once saved
    this.tap = null;
    this.tapPort = null;
    this.tapExited = false;
    this.tapExit = Promise.resolve();
    this.tapRunning = false; // the SDK's processingStatus is Running
    this.tapStatus = null;
    this.sdkStatusName = null; // the latest processingStatus name
    this.tapStopRequested = false;
    this.watchArmed = false; // the silence watch of spec 7.2 is on
    this.tapDone = false; // live-from: every recorded line was replayed
    this.tapKilled = false;
    this.tapStopBudgetMs = msFromEnv(env.COPYHOLDER_TAP_STOP_BUDGET_MS, TAP_STOP_BUDGET_MS);
    this.lastPacketAt = 0; // performance.now() of tap's last SDK packet, as its pulses tell
    this.tapInfo = { cameraName: null, requested: [1280, 720, 30], metrics: null, dry: false };
    this.tapLog = new TapLog(); // tap's console, redacted: sessions/<id>/tap.log from consent on
    this.tapOutput = null; // the tee of tap's stdout and stderr
    this.tapClosed = Promise.resolve(); // tap exited and its pipes closed
    this.pendingTapEvents = []; // tap_* events from before consent (smoke)
    this.tapPacketSeen = false; // a pulse or a probe told of an SDK packet
    this.tapErrorSeen = false; // tap sent an sdk_error
    this.tapCameraList = null; // tap's camera list (cameras), once it sent one
    this.tapCameraPicked = false; // tap sent `camera`: the name matched
    this.electronHinted = false;
    this.devices = deviceSettings(env, this.paths.repoRoot);
    this.quickcheckChild = null;
    this.quickcheckStop = null; // why host stopped quickcheck: 'timeout' or 'interrupted'
    this.quickcheckTimeoutMs = msFromEnv(env.COPYHOLDER_QUICKCHECK_TIMEOUT_MS, QUICKCHECK_TIMEOUT_MS);
    this.interrupted = false;
    this.timers = [];
    this.finished = false;
    this.done = new Promise((resolve) => {
      this.resolveDone = resolve;
    });
  }

  // ---- start-up ----------------------------------------------------------------------------

  /** Runs until the recording is saved (or nothing was recorded). Resolves with the exit code. */
  async run() {
    const o = this.opts;
    const p = this.paths;
    say(`Copyholder: ${TITLES[o.mode](o)}`);
    if (!fs.existsSync(path.join(p.webDist, 'index.html'))) {
      say(`The page is not built yet (${shownPath(p.webDist)}/index.html is missing). Build it with: npm run build:web`);
      return 1;
    }
    this.git = gitInfo(p.repoRoot);
    if (needsCleanTree(o) && this.env.COPYHOLDER_ALLOW_DIRTY !== '1') {
      const refusal = gitRefusal(this.git); // spec 14.1: no recording on a dirty or stale clone
      if (refusal) {
        say(refusal);
        return 1;
      }
    } else if (this.git.treeClean === false) {
      say('Note: the repository has local changes; manifest.json records tree_clean: false.');
    }
    if (!this.prepareNarrator()) return 1;
    const c = pageCalib(p.sessionsDir);
    this.calib = c.calib;
    this.calibFrom = c.sources;
    this.detector = detectorSetup(p.frozenParams, this.calib);
    this.machine = machineModel();
    this.sdkVersion = sdkVersionFrom(p.livePackageJson);
    this.launcher = this.env.COPYHOLDER_LAUNCHER === 'electron' || process.versions.electron ? 'electron' : 'node';

    const { id, dir } = reserveSessionDir(p.sessionsDir, baseIdFor(o, p.sessionsDir));
    this.id = id;
    this.dir = dir;
    this.store = new SessionStore(dir);
    say(`Recording folder: ${shownPath(dir)}`);

    const want = portSetting(this.env, p.repoRoot);
    if (want.note) say(want.note);
    try {
      await this.listen(want.port);
    } catch (err) {
      say(`The page server could not start on 127.0.0.1 (${err.message}).`);
      try {
        fs.rmdirSync(dir); // still empty: nothing was recorded
      } catch {
        // keep what is there
      }
      return 1;
    }
    this.installSignalHandlers();
    if (o.tap) {
      const ok = await this.startTap();
      if (!ok) {
        this.finish(1);
        return this.done;
      }
    }
    this.timers.push(setInterval(() => this.watchTap(), WATCH_EVERY_MS));
    const url = `${this.origin}/?token=${this.token}`;
    const opened = o.open
      ? openPage(url, { launcher: this.launcher, profileDir: p.chromeProfile, send: process.send ? (m) => process.send(m) : null })
      : null;
    if (opened === 'chrome') say(`Opening Chrome at ${url}`);
    else if (opened === 'electron') say(`Opening the page in the Electron window: ${url}`);
    else say(`Open this address in Chrome: ${url}`);
    say('Waiting for "I agree, start" on the page.');
    return this.done;
  }

  /** Picks the narrator files and the plan for this mode; prints why it cannot. */
  prepareNarrator() {
    const o = this.opts;
    const p = this.paths;
    try {
      switch (this.mode.narrator) {
        case 'gate': {
          const packDir = path.join(p.gateDir, `pack-${o.pack}`);
          if (!fs.existsSync(path.join(packDir, 'pack.json'))) {
            say(`Pack ${o.pack} is not ready: ${shownPath(packDir)}/pack.json was not found.`);
            return false;
          }
          this.narrator = gateSource(packDir);
          return true;
        }
        case 'sealed':
          return this.prepareSealed();
        case 'sample':
          if (!fs.existsSync(p.sampleDir)) {
            say(`The sample text is missing: ${shownPath(p.sampleDir)} was not found.`);
            return false;
          }
          this.narrator = sampleSource(p.sampleDir);
          this.planCommitment = readCommitment(p.sampleDir);
          return true;
        case 'doctor':
          // level.wav, the 20 s volume sample (spec 7.7): gate/level/, where it is rendered; sample/ as a fallback
          this.narrator = doctorSource(p.levelDir, p.sampleDir);
          return true;
        case 'replay':
          return this.prepareReplay();
        default:
          return true;
      }
    } catch (err) {
      say(`The narrator files cannot be read: ${err.message}`);
      return false;
    }
  }

  prepareSealed() {
    const o = this.opts;
    const p = this.paths;
    if (o.mode === 'demo' && !o.plan) {
      o.plan = firstUnheardDemo(p.sessionsDir);
      if (!o.plan) {
        say('All three demo plans (demo-1, demo-2, demo-3) have been played already.');
        return false;
      }
    }
    const planDir = path.join(p.sealedRoot, o.plan);
    if (!fs.existsSync(planDir)) {
      say(`The sealed plan ${o.plan} was not found (expected ${planDir}). Run npm run plant first.`);
      return false;
    }
    const heard = planHeardIn(p.sessionsDir, o.plan);
    if (heard) {
      say(`Plan ${o.plan} was already played in ${shownPath(path.join(p.sessionsDir, heard))}. Each text is heard only once.`);
      return false;
    }
    this.planCommitment = readCommitment(planDir);
    if (['session', 'spacebar', 'demo'].includes(o.mode)) {
      const refusal = freezeRefusal(p.freezeManifest, this.planCommitment);
      if (refusal) {
        say(refusal);
        return false;
      }
    }
    if (o.mode === 'session') {
      const refusal = revealRefusal(p.sessionsDir);
      if (refusal) {
        say(refusal);
        return false;
      }
    }
    let key;
    try {
      key = loadSealKey(this.env);
    } catch (err) {
      say(`The seal key cannot be read (${err.message}). It is the keychain item copyholder-seal made by npm run plant.`);
      return false;
    }
    this.narrator = sealedSource(planDir, key);
    return true;
  }

  /** live-from: the recording to replay and the narrator files it used (spec 6.5). */
  prepareReplay() {
    const o = this.opts;
    const p = this.paths;
    const src = path.join(p.sessionsDir, o.from);
    for (const f of ['detector_in.jsonl', 'audio.wav']) {
      if (!fs.existsSync(path.join(src, f))) {
        say(`Recording ${o.from} cannot be replayed: ${shownPath(path.join(src, f))} was not found.`);
        return false;
      }
    }
    this.sourceDir = src;
    const m = readJson(path.join(src, 'manifest.json')) || {};
    if (typeof m.scenario === 'string') this.scenario = m.scenario;
    let inner = noSource();
    const srcMode = MODES[m.mode];
    try {
      if (srcMode && srcMode.narrator === 'gate' && typeof m.pack === 'string') {
        const packDir = path.join(p.gateDir, `pack-${m.pack}`);
        if (fs.existsSync(path.join(packDir, 'pack.json'))) inner = gateSource(packDir);
      } else if (srcMode && srcMode.narrator === 'sealed' && typeof m.plan === 'string') {
        const planDir = path.join(p.sealedRoot, m.plan);
        if (fs.existsSync(planDir)) inner = sealedSource(planDir, loadSealKey(this.env));
        this.planCommitment = readCommitment(planDir);
      } else if (srcMode && srcMode.narrator === 'sample') {
        inner = sampleSource(p.sampleDir);
      }
    } catch (err) {
      say(`Note: the narrator files of ${o.from} are not available (${err.message}); only its microphone channel is.`);
      inner = noSource();
    }
    this.narrator = replaySource(path.join(src, 'audio.wav'), inner);
    return true;
  }

  /**
   * 127.0.0.1 only (spec 7.2). A fixed port (COPYHOLDER_PORT, else 47811) keeps the page's origin, so Chrome
   * remembers the microphone grant in its own profile; when that port is taken, the system picks one and host
   * says once that Chrome may ask again. Token, cookie, Origin and Host rules are the same on any port.
   */
  async listen(port) {
    this.server = http.createServer((req, res) => {
      this.handleHttp(req, res).catch((err) => {
        if (!res.headersSent) res.writeHead(500, BASE_HEADERS);
        res.end();
        say(`Page request failed: ${err.message}`);
      });
    });
    this.server.on('clientError', (_err, socket) => socket.destroy());
    this.wss = new WebSocketServer({ noServer: true, maxPayload: 8 * 1024 * 1024 });
    this.server.on('upgrade', (req, socket, head) => {
      const v = checkUpgrade(req, { path: '/session', token: this.token, origin: this.origin, port: this.port });
      if (!v.ok) return rejectUpgrade(socket, v.status);
      this.wss.handleUpgrade(req, socket, head, (ws) => this.onConnection(ws));
      return undefined;
    });
    const listenOn = (p) => new Promise((resolve, reject) => {
      const onError = (err) => {
        this.server.off('listening', onListening);
        reject(err);
      };
      const onListening = () => {
        this.server.off('error', onError);
        resolve();
      };
      this.server.once('error', onError);
      this.server.once('listening', onListening);
      this.server.listen(p, '127.0.0.1');
    });
    try {
      await listenOn(port);
    } catch (err) {
      if (port === 0 || !PORT_FALLBACK_CODES.includes(err && err.code)) throw err;
      await listenOn(0);
      say(`Port ${port} is taken, so this run uses port ${this.server.address().port}: Chrome may ask for the microphone again.`);
    }
    this.port = this.server.address().port;
    this.origin = pageOrigin(this.port);
  }

  installSignalHandlers() {
    this.onSignal = (sig) => this.interrupt(sig);
    process.on('SIGINT', this.onSignal);
    process.on('SIGTERM', this.onSignal);
  }

  // ---- tap ---------------------------------------------------------------------------------

  /** Forks tap (real or mock), waits for `ready`, sends `config`. Never sends `start` here (spec 12.2). */
  async startTap() {
    const o = this.opts;
    const file = o.tap === 'real' ? this.paths.tapFile : this.paths.mockTapFile;
    if (!fs.existsSync(file)) {
      say(o.tap === 'real'
        ? 'The camera part (live/tap.cjs) is missing, so this mode cannot run yet.'
        : 'The stand-in camera part (live/mock-tap.cjs) is missing.');
      return false;
    }
    const args = o.mode === 'live-from' ? ['--replay', this.sourceDir] : [];
    // stdout and stderr are piped: host tees them, redacted, to the terminal and tap.log (spec 7.12)
    const child = fork(file, args, {
      cwd: this.paths.repoRoot,
      env: this.env,
      execArgv: [],
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    });
    this.tap = child;
    this.tapOutput = teeTapOutput(child, this.tapLog);
    this.tapClosed = new Promise((resolve) => child.once('close', resolve));
    let readyResolve;
    const ready = new Promise((resolve) => {
      readyResolve = resolve;
    });
    this.onTapReady = readyResolve;
    this.tapExit = new Promise((resolve) => {
      child.once('exit', (code, signal) => {
        this.tapExited = true;
        readyResolve(false);
        this.onTapExit(code, signal);
        resolve();
      });
    });
    child.on('error', (err) => say(`The camera process failed: ${err.message}`));
    child.on('message', (m) => this.onTapMessage(m));
    const timer = setTimeout(() => readyResolve(false), TAP_READY_TIMEOUT_MS);
    const ok = await ready;
    clearTimeout(timer);
    if (!ok) {
      if (!this.tapExited) {
        say('The camera process did not start in time.');
        child.kill('SIGKILL');
      } else if (o.tap === 'real') {
        say('The camera process stopped before it was ready. If the SDK is not installed yet, run: npm run setup:live');
      } else {
        say('The stand-in camera process stopped before it was ready.');
      }
      return false;
    }
    child.send({ t: 'config', token: this.token, origin: this.origin, sessionDir: this.dir, smoke: o.mode === 'smoke' });
    return true;
  }

  onTapMessage(m) {
    if (!m || typeof m !== 'object') return;
    switch (m.t) {
      case 'ready':
        if (Number.isInteger(m.port) && m.port > 0) {
          this.tapPort = m.port;
          this.onTapReady(true);
        }
        break;
      case 'cameras': {
        this.tapCameraList = Array.isArray(m.list) ? m.list : [];
        const names = this.tapCameraList
          .map((c) => (c && typeof c.name === 'string' ? `"${c.name}"` : `(no name) id=${c && c.id}`))
          .join(', ');
        say(`Cameras found: ${names || 'none'}.`);
        if (this.opts.mode !== 'smoke') {
          say('Put the exact name of the camera to use in settings.env as COPYHOLDER_CAMERA_NAME=..., then start again.');
        }
        if (this.tapCameraList.length === 0) this.hintElectron(); // no camera seen at all
        this.tapEvent(m);
        break;
      }
      case 'camera':
        this.tapCameraPicked = true;
        if (typeof m.name === 'string') this.tapInfo.cameraName = m.name.slice(0, 200);
        if (Array.isArray(m.requested) && m.requested.length === 3 && m.requested.every(Number.isInteger)) {
          this.tapInfo.requested = m.requested.slice(0, 3);
        }
        if (Array.isArray(m.metrics)) this.tapInfo.metrics = m.metrics.filter((x) => typeof x === 'string');
        if (m.dry === true) this.tapInfo.dry = true; // tap's stand-in SDK: no recording (spec 6.5), manifest.json says so
        this.tapEvent(m);
        break;
      case 'probe':
        this.tapPacketSeen = true;
        this.tapEvent(m);
        break;
      case 'readiness':
      case 'enums':
        this.tapEvent(m);
        break;
      case 'status':
        if (m.kind === 'processingStatus') this.onProcessingStatus(m.name);
        break;
      case 'pulse':
        this.onPulse(m);
        break;
      case 'sdk_error':
        this.onSdkError(m);
        break;
      case 'replay_done':
        this.onReplayDone();
        break;
      default:
        break; // started, paused, stopped: lifecycle comes from status and exit
    }
  }

  /**
   * tap's answers to spec 7.12 questions 1, 2, 4 and 10 as tap_* lines of events.jsonl, for analysis/smoke.ts.
   * Smoke only: elsewhere the camera's name would reach events.jsonl, which is published unchanged (spec 8.7).
   * Before consent they wait, and follow the consent line with n null.
   */
  tapEvent(m) {
    if (this.opts.mode !== 'smoke') return;
    const ev = tapEventOf(m);
    if (!ev) return;
    if (this.phase === 'idle') {
      if (this.pendingTapEvents.length < MAX_PENDING_TAP_EVENTS) this.pendingTapEvents.push(ev);
    } else if (this.store && this.store.isOpen) {
      this.store.writeHostEvent(ev.e, ev.fields);
    }
  }

  /**
   * Once a second tap reports its SDK packets (spec 7.1): `packets` in the last period and
   * `last_ago_ms`, the age of the last packet when it sent the pulse. The silence of spec 7.2 is
   * counted from that packet. Without last_ago_ms (an older tap) the pulse time stands in, up to
   * one pulse period late.
   */
  onPulse(m) {
    const now = performance.now();
    const ago = typeof m.last_ago_ms === 'number' && Number.isFinite(m.last_ago_ms) && m.last_ago_ms >= 0 ? m.last_ago_ms : null;
    if (ago !== null) this.lastPacketAt = Math.max(this.lastPacketAt, now - ago);
    else if (typeof m.packets === 'number' && m.packets > 0) this.lastPacketAt = now;
    if (ago !== null || (typeof m.packets === 'number' && m.packets > 0)) this.tapPacketSeen = true;
  }

  /**
   * Spec 6.7 and 7.12 question 1: in smoke under plain Node, a camera that did not open (before the first
   * SDK packet) gets the Electron step, once. Before consent no folder is kept, so no smoke report says it.
   */
  hintElectron() {
    if (this.opts.mode !== 'smoke' || this.launcher !== 'node' || this.tapPacketSeen || this.electronHinted) return;
    this.electronHinted = true;
    say(ELECTRON_HINT);
  }

  onProcessingStatus(name) {
    const running = isRunningStatus(name);
    this.sdkStatusName = typeof name === 'string' ? name.slice(0, 40) : null;
    if (running && !this.tapRunning) {
      this.tapRunning = true;
      this.watchArmed = true;
      this.lastPacketAt = performance.now(); // 3 s for the first packet after Running
      this.setTapStatus('running');
      say('Camera running.');
    } else if (!running && this.tapRunning) {
      this.tapRunning = false;
      // The SDK left Running by itself: no packet will come. The watch stays on, so 3 s after the
      // last packet this is tap_lost (spec 7.2), unless an SDK error ends the recording first. Only
      // tap's announced restart (code 8, see onSdkError) turns the watch off until Running again.
      if (this.phase === 'recording' && this.watchArmed && !this.tapStopRequested && !this.tapDone) {
        say(`The camera stopped running (${this.sdkStatusName}).`);
      }
    }
  }

  /** live-from: the mock tap sent every recorded line; the end of the replay is not a lost tap. */
  onReplayDone() {
    this.tapDone = true;
    say('All recorded detector inputs were replayed.');
  }

  /** {t:'tap', status} to the worker plus a host event line while recording. */
  setTapStatus(status) {
    if (this.tapStatus === status) return;
    this.tapStatus = status;
    if (this.store && this.store.isOpen) this.store.writeHostEvent('tap', { status });
    this.send({ t: 'tap', status });
  }

  /**
   * Spec 7.2: no SDK packet for 3 s while Running is tap_lost. The watch starts at Running and stays
   * on if the SDK leaves Running after its packets started; `status` then names where it went.
   */
  watchTap() {
    if (this.phase !== 'recording' || !this.watchArmed || this.tapStopRequested || this.tapDone) return;
    const silentMs = performance.now() - this.lastPacketAt;
    if (silentMs > TAP_SILENCE_MS) {
      const fields = { why: 'silence', silent_ms: Math.round(silentMs) };
      if (!this.tapRunning) fields.status = this.sdkStatusName;
      this.abort('tap_lost', fields, 'The camera stopped sending data for 3 seconds.');
    }
  }

  /** Spec 7.1 table: every SDK error during a recording aborts it, except tap's one restart before the first packet. */
  onSdkError(m) {
    const code = Number.isInteger(m.code) ? m.code : null;
    const name = typeof m.name === 'string' ? m.name : null;
    const action = typeof m.action === 'string' ? m.action : null;
    const call = typeof m.call === 'string' ? m.call.slice(0, 80) : null; // picks the hint for code 3
    this.tapErrorSeen = true;
    say(sdkErrorText(code, name, { smoke: this.opts.mode === 'smoke', call }));
    if (isCameraFailure(code, call)) this.hintElectron();
    // tap restarts the SDK once (code 8 before the first packet): the SDK leaves Running and comes
    // back, so the silence watch waits for Running again (onProcessingStatus).
    if (action === 'reset_restart') this.watchArmed = false;
    if (this.phase !== 'recording') return;
    const message = typeof m.message === 'string' ? m.message.slice(0, 300) : '';
    if (action === 'reset_restart') {
      this.store.writeHostEvent('sdk_error', { code, name, message, action });
      say('The SDK is restarted once (no data had arrived yet).');
      return;
    }
    this.abort('sdk_error', { code, name, message }, 'The SDK reported an error.');
  }

  onTapExit(code, signal) {
    this.tapRunning = false;
    if (this.tapStopRequested || this.interrupted || this.finished) {
      this.setTapStatus('stopped');
      return;
    }
    // tap stopped without saying why (no sdk_error, no unmatched camera name): perhaps the camera (spec 6.7)
    const unexplained = !this.tapErrorSeen && (this.tapCameraList === null || this.tapCameraPicked);
    if (this.phase === 'recording') {
      this.abort('tap_lost', { why: 'exit', code, signal }, 'The camera process stopped.');
      if (unexplained) this.hintElectron();
    } else if (this.phase === 'idle' && this.tapPort !== null) {
      say('The camera process stopped before the recording started. Nothing was recorded.');
      if (unexplained) this.hintElectron();
      this.finish(1);
    }
  }

  /**
   * {t:'stop'}, then tap's exit: await stopAsync() and its files (spec 7.1). After the budget host
   * kills it; the folder records that (event tap_killed, manifest tap_killed), because tap's files
   * may then miss their last lines.
   */
  async stopTap() {
    if (!this.tap || this.tapExited) return;
    this.tapStopRequested = true;
    this.tapRunning = false;
    try {
      this.tap.send({ t: 'stop' });
    } catch {
      // IPC already closed; the exit will follow
    }
    await settlesWithin(this.tapExit, this.tapStopBudgetMs);
    if (!this.tapExited) {
      say('The camera process did not stop in time; ending it. Its files may miss their last lines.');
      this.tapKilled = true;
      if (this.store && this.store.isOpen) this.store.writeHostEvent('tap_killed', { after_ms: this.tapStopBudgetMs });
      this.tap.kill('SIGKILL');
      await settlesWithin(this.tapExit, 2000);
    }
    this.setTapStatus('stopped');
  }

  // ---- HTTP --------------------------------------------------------------------------------

  async handleHttp(req, res) {
    const g = checkHttp(req, { token: this.token, port: this.port });
    if (!g.ok) {
      res.writeHead(g.status, { ...BASE_HEADERS, 'Content-Type': 'text/plain; charset=utf-8' });
      res.end(g.status === 403 ? 'Forbidden\n' : 'Bad request\n');
      return;
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, { ...BASE_HEADERS, Allow: 'GET, HEAD' });
      res.end();
      return;
    }
    const pathname = g.url.pathname;
    if (req.method === 'GET' && PAGE_LOAD_PATHS.has(pathname)) this.onPageLoad(pathname);
    const headers = { ...BASE_HEADERS };
    if (g.url.searchParams.has('token')) headers['Set-Cookie'] = cookieHeader(this.token);
    if (pathname === '/api/config') {
      this.sendJson(req, res, 200, this.config(), headers);
    } else if (pathname.startsWith('/api/narrator/')) {
      await this.serveNarrator(pathname.slice('/api/narrator/'.length), req, res, headers);
    } else if (pathname.startsWith('/api/')) {
      this.sendJson(req, res, 404, { error: 'not found' }, headers);
    } else {
      this.serveStatic(pathname === '/' ? '/index.html' : pathname, req, res, headers);
    }
  }

  sendJson(req, res, status, value, headers) {
    const body = Buffer.from(JSON.stringify(value));
    res.writeHead(status, { ...headers, 'Content-Type': 'application/json', 'Content-Length': body.length });
    res.end(req.method === 'HEAD' ? undefined : body);
  }

  /** GET /api/config (docs/protocol.md); fields after consentText are optional extras. */
  config() {
    const o = this.opts;
    const cfg = {
      mode: o.mode,
      sessionId: this.id,
      scenario: this.scenario,
      tapUrl: this.tapPort ? `ws://127.0.0.1:${this.tapPort}/tap?token=${this.token}` : null,
      sessionUrl: `ws://127.0.0.1:${this.port}/session?token=${this.token}`,
      calib: this.calib,
      narrator: narratorNames(this.narrator),
      consentText: this.mode.consent,
      detector: this.detector,
      kind: this.kind,
      pack: o.pack,
      plan: o.plan,
      source: o.from,
      tap: o.tap,
      level: o.level,
      planCommitment: this.planCommitment,
      // COPYHOLDER_MIC_NAME and COPYHOLDER_OUTPUT_NAME: part of a device's name; a key is left out when not set
      devices: { ...this.devices },
    };
    // Demo take: the face preview of spec 15.5, unless it was taken out (spec 14.4, assumption: a setting).
    if (o.mode === 'demo' && hostSetting(this.env, this.paths.repoRoot, 'COPYHOLDER_FACE_PREVIEW') !== 'off') {
      cfg.facePreview = true;
    }
    // live-from (spec 6.5): channel 0 of the recording goes into Deck in place of the microphone.
    if (o.mode === 'live-from') cfg.replayAudio = 'mic.wav';
    return cfg;
  }

  /** Every narrator byte goes through readNarrator and its allow list (spec 7.2, 8.2). */
  async serveNarrator(rawName, req, res, headers) {
    let name;
    try {
      name = decodeURIComponent(rawName);
    } catch {
      this.sendJson(req, res, 404, { error: 'not on the narrator allow list' }, headers);
      return;
    }
    const unlocked = this.preflightOk && this.phase === 'recording';
    const r = await readNarrator(this.narrator, name, { preflightOk: unlocked });
    if (r.status !== 200) {
      if (r.status === 500) say(`Narrator file ${name} could not be served: ${r.error}`);
      this.sendJson(req, res, r.status, { error: r.error }, headers);
      return;
    }
    if (needsPreflight(this.narrator, name) && !this.sealedServed.has(name)) {
      this.sealedServed.add(name); // audit only: the text is spent at the first sealed sound (onNarrating)
      this.writeManifest('recording');
    }
    res.writeHead(200, { ...headers, 'Content-Type': r.contentType, 'Content-Length': r.length });
    if (req.method === 'HEAD') {
      if (!Buffer.isBuffer(r.body)) r.body.destroy();
      res.end();
    } else if (Buffer.isBuffer(r.body)) {
      res.end(r.body);
    } else {
      pipeline(r.body, res, () => {});
    }
  }

  serveStatic(pathname, req, res, headers) {
    let rel;
    try {
      rel = decodeURIComponent(pathname);
    } catch {
      rel = null;
    }
    const root = path.resolve(this.paths.webDist);
    const file = rel === null || rel.includes('\0') ? null : path.resolve(root, `.${rel}`);
    let stat = null;
    if (file && file.startsWith(root + path.sep)) {
      try {
        stat = fs.statSync(file);
      } catch {
        stat = null;
      }
    }
    if (!stat || !stat.isFile()) {
      res.writeHead(404, { ...headers, 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Not found\n');
      return;
    }
    const type = STATIC_TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream';
    res.writeHead(200, { ...headers, 'Content-Type': type, 'Content-Length': stat.size });
    if (req.method === 'HEAD') res.end();
    else pipeline(fs.createReadStream(file), res, () => {});
  }

  // ---- /session socket ---------------------------------------------------------------------

  send(msg) {
    const ws = this.worker;
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
  }

  /**
   * GET of the page or of /api/config. The recording page asks for them once, before consent; the
   * worker gets the config from the page. So during a recording they mean the page is loading again:
   * a reload, which a reloaded page shows long before its new worker could reach /session.
   */
  onPageLoad(pathname) {
    if (pathname !== '/api/config') this.pageLoads += 1;
    if (this.phase === 'recording') this.pageReloaded(pathname);
  }

  /** Spec 7.2, 7.3: a reload during the recording makes the session unusable and ends it. */
  pageReloaded(via) {
    if (this.phase !== 'recording') return;
    this.store.writeHostEvent('page_reload', { page_loads: this.pageLoads, via });
    this.unusable.add('page_reload');
    say(`The page was reloaded during the recording. This recording cannot be used; its files stay in ${shownPath(this.dir)}.`);
    if (this.worker && this.worker.readyState === WebSocket.OPEN) {
      this.send({ t: 'abort', reason: 'page_reload' }); // its last frames and `end` are still stored
    } else {
      this.workerEnded = true; // the recording page's socket is gone: nothing more to wait for
    }
    this.closeRecording({ reason: 'page_reload', by: 'host' });
  }

  /** A socket that is not the recording page's: told why, then closed. */
  refuseWorker(ws, reason) {
    try {
      ws.send(JSON.stringify({ t: 'abort', reason }));
    } catch {
      // already closing
    }
    ws.close(4001, reason);
  }

  onConnection(ws) {
    ws.on('error', () => {});
    const current = this.worker && this.worker.readyState === WebSocket.OPEN ? this.worker : null;
    if (this.phase === 'recording') this.pageReloaded('/session'); // a second worker: a reload or a second page
    if (this.phase !== 'idle' && current) {
      // The recording page keeps its socket for its last blocks and `end`; saved and the
      // quickcheck verdict go to it, not to the newcomer (spec 7.2, docs/protocol.md).
      this.refuseWorker(ws, 'recording_closed');
      return;
    }
    this.worker = ws;
    ws.on('message', (data, isBinary) => this.onWorkerMessage(ws, data, isBinary));
    ws.on('close', () => this.onWorkerClose(ws));
    clearTimeout(this.pageGoneTimer);
    if (this.phase !== 'idle') {
      this.send({ t: 'abort', reason: 'recording_closed' }); // a page loaded after the recording ended
    } else {
      if (current) current.close(4000, 'replaced by a newer page'); // before consent the newest page wins
      if (this.tapStatus) this.send({ t: 'tap', status: this.tapStatus });
    }
  }

  onWorkerClose(ws) {
    if (ws !== this.worker) return;
    this.worker = null;
    if (this.phase === 'recording') {
      this.pageGoneTimer = setTimeout(() => {
        if (this.phase !== 'recording' || this.worker) return;
        this.store.writeHostEvent('page_lost');
        this.unusable.add('page_lost');
        say(`The page closed during the recording. This recording cannot be used; its files stay in ${shownPath(this.dir)}.`);
        this.workerEnded = true;
        this.closeRecording({ reason: 'page_lost', by: 'host' });
      }, PAGE_GONE_GRACE_MS);
    } else if (this.phase === 'closing') {
      this.workerEnded = true;
    } else if (this.phase === 'idle') {
      say('The page was closed. Open the address again, or press Ctrl+C to quit.');
    }
  }

  onWorkerMessage(ws, data, isBinary) {
    if (ws !== this.worker) return;
    if (isBinary) {
      this.onAudio(Buffer.isBuffer(data) ? data : Buffer.concat(data));
      return;
    }
    let msg;
    try {
      msg = JSON.parse(data.toString('utf8'));
    } catch {
      return;
    }
    if (!msg || typeof msg !== 'object' || typeof msg.t !== 'string') return;
    switch (msg.t) {
      case 'hello': this.onHello(msg); break;
      case 'consent': this.onConsent(msg); break;
      case 'stamp': this.onLine('stamp', msg.line); break;
      case 'det': this.onLine('det', msg.line); break;
      case 'event': this.onLine('event', msg.line); break;
      case 'end': this.onEnd(msg); break;
      default: break;
    }
  }

  /** Devices for manifest.json: the latest hello before consent; during a recording only fills missing settings. */
  onHello(msg) {
    const settings = msg.settings && typeof msg.settings === 'object' ? msg.settings : null;
    if (this.phase === 'idle' || this.hello === null || (this.hello.settings === null && settings !== null)) {
      this.hello = { ua: typeof msg.ua === 'string' ? msg.ua : null, settings };
    }
  }

  /** Consent from the page (spec 12.2): the recording starts and only now tap gets `start`. */
  onConsent(msg) {
    if (this.phase !== 'idle') return;
    this.phase = 'recording';
    this.consentUtc = utcSeconds(new Date());
    this.store.open();
    this.store.writeHostEvent('consent', typeof msg.at === 'string' || typeof msg.at === 'number' ? { at: msg.at } : {});
    if (this.tap) this.tapLog.open(this.dir); // with tap's lines from before consent
    const tapEvents = this.pendingTapEvents;
    this.pendingTapEvents = [];
    for (const ev of tapEvents) this.store.writeHostEvent(ev.e, ev.fields, null);
    const pending = this.pending;
    this.pending = [];
    for (const [kind, line] of pending) this.store.writeLine(kind, line); // a preflight_ok from before consent unlocks nothing
    this.writeManifest('recording');
    if (this.tap && !this.tapExited) {
      this.tap.send({ t: 'start' });
      this.setTapStatus('starting');
      say(this.opts.mode === 'live-from'
        ? `Consent given. The recording ${this.opts.from} plays as soon as the page starts its sound.`
        : 'Consent given. Starting the camera...');
    } else {
      say('Consent given. Recording.');
    }
  }

  onLine(kind, line) {
    if (this.phase === 'idle') {
      if (this.pending.length < MAX_PENDING_LINES) this.pending.push([kind, line]);
      return;
    }
    const obj = this.store.writeLine(kind, line);
    if (!obj) return;
    if (kind === 'stamp') {
      // also while closing: a stamp of sound that played before an abort may come after it
      if (obj.k === 'state' && obj.s === 'narrating') this.onNarrating(obj.n);
      return;
    }
    if (kind !== 'event' || this.phase !== 'recording') return;
    if (obj.e === 'preflight_ok') this.preflightOk = true;
    if (obj.e === 'replay_start') this.onReplayStart();
    // doctor: the level chosen on the page is stored for every later recording (spec 7.7, 8.1).
    if (obj.e === 'gain' && obj.final === true && this.kind === 'doctor' && typeof obj.value === 'number' && obj.value > 0) {
      this.doctorGain = obj.value;
      this.store.writeCalib({ output_gain: obj.value });
    }
  }

  /**
   * Deck narrates: a clip started (or resumed). With sealed audio, which is served only after
   * preflight_ok, the first such stamp is the first sealed sound: from it on the plan's text is spent
   * (spec 7.8, 10.4). manifest.json records it at once, so a crash later still counts as heard.
   */
  onNarrating(n) {
    if (this.firstSealedN !== null || !this.preflightOk || !holdsSealedAudio(this.narrator)) return;
    this.firstSealedN = Number.isSafeInteger(n) && n >= 0 ? n : this.store.lastN() ?? 0;
    this.writeManifest('recording');
  }

  /** live-from: the page started the replayed audio; the mock tap sends the recorded lines from now on. */
  onReplayStart() {
    if (this.opts.mode !== 'live-from' || this.replayStarted || !this.tap || this.tapExited) return;
    this.replayStarted = true;
    this.tap.send({ t: 'replay_start' });
    say(`Replaying the detector inputs of ${this.opts.from}.`);
  }

  onAudio(buf) {
    if (this.phase === 'idle' || !this.store.isOpen) {
      this.droppedBlocks += 1;
      return;
    }
    const r = this.store.writeAudioBlock(buf);
    if (r.gap && !this.unusable.has('audio_gap')) {
      say(`Audio blocks are missing (expected sample ${r.gap.expected}, got ${r.gap.got}). This recording cannot be used for numbers.`);
    }
    if (r.gap) this.unusable.add('audio_gap');
    if (r.error) {
      const reason = r.error === 'audio.wav is full' ? 'audio_full' : 'audio_bad_block';
      if (!this.unusable.has(reason)) say(`Audio could not be stored (${r.error}). This recording cannot be used for numbers.`);
      this.unusable.add(reason);
    }
  }

  onEnd(msg) {
    const reason = typeof msg.reason === 'string' && msg.reason ? msg.reason.slice(0, 80) : 'end';
    if (this.phase === 'idle') {
      say('Stopped before the recording started. Nothing was recorded.');
      this.finish(0);
    } else if (this.phase === 'recording') {
      this.workerEnded = true;
      this.closeRecording({ reason, by: 'page' });
    } else if (this.phase === 'closing') {
      this.workerEnded = true;
    }
  }

  // ---- ending a recording --------------------------------------------------------------------

  /** SDK error or tap_lost: Deck mutes at once, the SDK stops, the files stay (spec 7.2). */
  abort(reason, fields, text) {
    if (this.phase !== 'recording') return;
    this.store.writeHostEvent(reason, fields);
    this.unusable.add(reason);
    this.send({ t: 'abort', reason });
    say(`${text} The recording was stopped and cannot be used; its files stay in ${shownPath(this.dir)}.`);
    this.closeRecording({ reason, by: 'host' });
  }

  async closeRecording(end) {
    if (this.phase !== 'recording') return;
    this.phase = 'closing';
    this.end = end;
    this.endedUtc = utcSeconds(new Date());
    clearTimeout(this.pageGoneTimer);
    if (end.by === 'page') say('Recording finished. Saving...');
    await this.stopTap();
    await this.closeTapLog();
    const until = performance.now() + ABORT_DRAIN_MS;
    while (!this.workerEnded && this.worker && performance.now() < until) await delay(50);
    let saved = true;
    try {
      this.saveRecording();
    } catch (err) {
      saved = false;
      say(`Saving failed: ${err.message}. The recorded files stay in ${shownPath(this.dir)}.`);
    }
    // The page shows the verdict in place of its end prompt; null when none ran (docs/protocol.md).
    const verdict = saved && !this.interrupted ? await this.runQuickcheck() : { ok: null, text: null };
    this.send({ t: 'quickcheck', ok: verdict.ok, text: verdict.text });
    if (saved) this.refreshHashes();
    await this.closeWorker();
    this.finish(saved ? 0 : 1);
  }

  /**
   * After tap's exit its last lines may still be in the pipes: they go into tap.log, then the file is closed,
   * complete before quickcheck reads the folder. A pipe a leftover process keeps open is not waited for.
   */
  async closeTapLog() {
    if (this.tap) {
      await settlesWithin(this.tapClosed, TAP_OUTPUT_WAIT_MS);
      if (this.tapOutput) this.tapOutput.flush();
    }
    this.tapLog.close();
    if (this.tapLog.error) say(`Note: tap.log is incomplete (${this.tapLog.error}); tap's lines are in the terminal above.`);
  }

  /** host closes /session after its last frame (docs/protocol.md); a close handshake, so no frame is cut off. */
  async closeWorker() {
    const ws = this.worker;
    if (!ws || ws.readyState === WebSocket.CLOSED) return;
    const closed = new Promise((resolve) => ws.once('close', resolve));
    ws.close(1000, 'recording saved');
    await settlesWithin(closed, 2000);
    if (ws.readyState !== WebSocket.CLOSED) ws.terminate();
  }

  record(state) {
    const o = this.opts;
    const realSdk = o.tap === 'real';
    return {
      id: this.id,
      kind: this.kind,
      mode: o.mode,
      scenario: this.scenario,
      pack: o.pack,
      plan: o.plan,
      source: o.from,
      tapKind: o.tap,
      dry: this.tapInfo.dry,
      startedUtc: this.consentUtc,
      consentUtc: this.consentUtc,
      endedUtc: this.endedUtc,
      git: this.git,
      planCommitment: this.planCommitment,
      // No SDK without the real tap (doctor, spacebar, mock runs): sdk null (core/schemas/session.ts).
      sdk: realSdk
        ? {
          version: this.sdkVersion,
          metrics: this.tapInfo.metrics && this.tapInfo.metrics.length > 0
            ? this.tapInfo.metrics : requestedMetrics(metricsSetting(this.env, this.paths.repoRoot)),
          launcher: this.launcher,
        }
        : null,
      camera: o.tap ? { name: this.tapInfo.cameraName, requested: this.tapInfo.requested } : null,
      machine: this.machine,
      hello: this.hello,
      outputGain: this.doctorGain ?? usableGain(this.calib),
      audioSummary: { ...this.store.audioSummary(), dropped_before_consent: this.droppedBlocks },
      state,
      end: this.end,
      unusableReasons: [...this.unusable],
      pageLoads: this.pageLoads,
      tapKilled: this.tapKilled,
      narratorNames: narratorNames(this.narrator),
      sealedServed: [...this.sealedServed],
      firstSealedN: this.firstSealedN,
      calibFrom: this.calibFrom,
    };
  }

  /** manifest.json while recording (state 'recording', no hashes yet). */
  writeManifest(state) {
    if (this.phase === 'closed') return;
    writeJsonAtomic(path.join(this.dir, 'manifest.json'), buildManifest(this.record(state), {}));
  }

  /**
   * Close files, hash them into manifest.json, then the ledger step `record` (spec 8.1, 8.5). Only
   * records with a step order in spec 8.5 get a ledger; doctor, smoke, headstart, live_from and
   * live_sim keep their hashes in manifest.json alone. tap.log is a log, not a recording file: no
   * hash, so it is never among the published files (spec 8.7).
   */
  saveRecording() {
    this.store.close();
    const files = hashFolderFiles(this.dir, ['manifest.json', 'ledger.jsonl', TAP_LOG]);
    const manifestFile = path.join(this.dir, 'manifest.json');
    writeJsonAtomic(manifestFile, buildManifest(this.record('closed'), files));
    this.savedHashes = files;
    this.phase = 'closed';
    if (isLedgerKind(this.kind)) {
      appendLedgerStep(this.dir, {
        step: 'record',
        commit: this.git.commit,
        outSha256: { ...files, 'manifest.json': sha256FileSync(manifestFile) },
        date: new Date(),
      });
    }
    const reasons = [...this.unusable];
    say(reasons.length
      ? `Saved to ${shownPath(this.dir)}. Not usable for numbers: ${reasons.join(', ')}.`
      : `Saved to ${shownPath(this.dir)}.`);
    this.send({ t: 'saved', sessionId: this.id, unusable: reasons.length > 0, reasons });
  }

  /**
   * A record kind without a ledger keeps its file hashes in manifest.json alone (spec 8.1, 8.5). The
   * report host ran may rewrite a file it hashed: on DOCTOR OK doctor rewrites calib.json, which held
   * the gain host wrote (spec 7.12; calib.json has three writers). host, manifest.json's one writer,
   * puts the new hashes into `files` and changes nothing else. A ledger kind keeps manifest.json as
   * the ledger's `record` step hashed it: a later write is a step of the ledger.
   */
  refreshHashes() {
    if (isLedgerKind(this.kind) || this.savedHashes === null) return;
    try {
      const { files, changed } = rehashFiles(this.dir, this.savedHashes);
      if (changed.length === 0) return;
      const manifestFile = path.join(this.dir, 'manifest.json');
      const m = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
      m.files = {};
      for (const name of Object.keys(files).sort()) m.files[name] = `sha256:${files[name]}`;
      writeJsonAtomic(manifestFile, m);
      this.savedHashes = files;
    } catch (err) {
      say(`Note: manifest.json keeps the file hashes from before the report (${err.message}).`);
    }
  }

  /**
   * `npx tsx analysis/quickcheck.ts <id>` from the repo root (spec 7.12). Resolves {ok, text}. It runs in its
   * own process group, so the timeout and Ctrl+C end npx, tsx and node together: SIGTERM first, so quickcheck's
   * own handlers stop what it started in other groups, then SIGKILL (stopGroup). host goes on at its exit plus
   * a short drain of stdout, then ends what is left of the group the same way: none of it outlives host.
   */
  runQuickcheck() {
    const script = this.paths.quickcheckScript;
    if (script === 'off') return Promise.resolve({ ok: null, text: null });
    if (!fs.existsSync(path.resolve(this.paths.repoRoot, script))) {
      say(`The quick check is not built yet. When it is, run: npm run quickcheck -- ${this.id}`);
      return Promise.resolve({ ok: null, text: null });
    }
    say('Running the quick check...');
    const again = `npm run quickcheck -- ${this.id}`;
    return new Promise((resolve) => {
      const chunks = [];
      let settled = false;
      let child = null;
      let timer = null;
      const onHostExit = () => stopGroupSync(child, QUICKCHECK_DRAIN_MS); // a second Ctrl+C, an internal error
      const done = (code) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        // tsx's node or a helper still running after npx exited; the exit hook stays until its SIGKILL
        stopGroup(child, QUICKCHECK_DRAIN_MS, () => process.off('exit', onHostExit));
        this.quickcheckChild = null;
        const stop = this.quickcheckStop;
        if (stop === 'timeout') {
          const text = `The quick check did not finish in ${durationText(this.quickcheckTimeoutMs)}. Run it again: ${again}`;
          say(text);
          resolve({ ok: null, text });
        } else if (stop === 'interrupted') {
          const text = `The quick check was stopped. Run it later: ${again}`;
          say(text);
          resolve({ ok: null, text });
        } else {
          // The verdict is the last line (GOOD RECORDING, DOCTOR OK, SMOKE OK or a failure line, spec 7.12);
          // ok comes from the exit code, which says pass or fail the same way for every record kind.
          resolve(quickcheckVerdict(code, Buffer.concat(chunks).toString('utf8')));
        }
      };
      try {
        child = spawn('npx', ['tsx', script, this.id], {
          cwd: this.paths.repoRoot,
          env: { ...this.env, COPYHOLDER_SESSIONS_DIR: this.paths.sessionsDir },
          stdio: ['ignore', 'pipe', 'inherit'],
          detached: true, // its own process group (setsid): one kill ends every process of it
        });
      } catch (err) {
        say(`The quick check could not run: ${err.message}`);
        done(null);
        return;
      }
      this.quickcheckChild = child;
      this.quickcheckStop = null;
      process.on('exit', onHostExit); // host exits on a second Ctrl+C or an internal error
      if (child.stdout) {
        child.stdout.on('data', (chunk) => {
          chunks.push(chunk);
          process.stdout.write(chunk);
        });
      }
      const closed = new Promise((r) => child.once('close', r));
      timer = setTimeout(() => {
        this.quickcheckStop = 'timeout';
        stopGroup(child, QUICKCHECK_DRAIN_MS);
      }, this.quickcheckTimeoutMs);
      child.on('error', (err) => {
        say(`The quick check could not run: ${err.message}`);
        done(null);
      });
      // 'close' waits for every holder of the stdout pipe; a leftover process could hold it for ever
      child.once('exit', (code) => {
        settlesWithin(closed, QUICKCHECK_DRAIN_MS).then(() => done(code));
      });
    });
  }

  /** Ctrl+C while quickcheck runs: it is in its own process group, so the terminal's signal does not reach it. */
  stopQuickcheck() {
    const child = this.quickcheckChild;
    if (!child) return;
    this.quickcheckStop = 'interrupted';
    stopGroup(child, QUICKCHECK_DRAIN_MS);
  }

  // ---- shutting down -----------------------------------------------------------------------

  interrupt(sig) {
    if (this.interrupted) {
      say('Stopping now.');
      process.exit(130);
    }
    this.interrupted = true;
    if (this.phase === 'recording') {
      say(`Stopping the recording (${sig})...`);
      this.store.writeHostEvent('host_interrupted', { signal: sig });
      this.unusable.add('host_interrupted');
      this.send({ t: 'abort', reason: 'host_interrupted' });
      this.closeRecording({ reason: 'host_interrupted', by: 'host' });
    } else if (this.phase === 'idle') {
      say('Stopped. Nothing was recorded.');
      this.finish(130);
    } else {
      this.stopQuickcheck(); // closing: the recording is saved or being saved
    }
  }

  /** Stops timers, tap and servers; removes the folder of a run that recorded nothing. */
  finish(code) {
    if (this.finished) return;
    this.finished = true;
    for (const t of this.timers) clearInterval(t);
    clearTimeout(this.pageGoneTimer);
    this.tapLog.close(); // lines held before a consent that never came are dropped: the terminal showed them
    stopGroup(this.quickcheckChild, QUICKCHECK_DRAIN_MS);
    if (this.tap && !this.tapExited) {
      try {
        this.tap.send({ t: 'stop' });
      } catch {
        // already gone
      }
      setTimeout(() => {
        if (!this.tapExited) this.tap.kill('SIGKILL');
      }, this.tapStopBudgetMs).unref();
    }
    if (this.onSignal) {
      process.off('SIGINT', this.onSignal);
      process.off('SIGTERM', this.onSignal);
    }
    const closeServer = () => {
      if (this.wss) for (const c of this.wss.clients) c.terminate();
      if (this.server) {
        this.server.close();
        this.server.closeAllConnections();
      }
    };
    const waitTap = this.tap && !this.tapExited ? settlesWithin(this.tapExit, this.tapStopBudgetMs + 500) : Promise.resolve();
    waitTap.then(() => {
      if (this.phase === 'idle' && this.dir) {
        try {
          fs.rmdirSync(this.dir); // only succeeds when empty: nothing recorded, nothing deleted
        } catch {
          // not empty: keep what is there
        }
      }
      closeServer();
      this.resolveDone(code);
    });
  }
}

async function main(argv = process.argv.slice(2), env = process.env) {
  const { opts, error } = parseHostArgs(argv);
  if (error) {
    say(error);
    return 2;
  }
  const host = new Host(opts, env);
  process.on('uncaughtException', (err) => {
    say(`Internal error: ${err && err.stack ? err.stack : err}`);
    try {
      if (host.store && host.store.isOpen) {
        host.writeManifest('crashed');
        host.store.close();
        say(`The files recorded so far stay in ${shownPath(host.dir)}.`);
      }
    } catch {
      // nothing more to save
    }
    host.tapLog.close();
    stopGroupSync(host.quickcheckChild, QUICKCHECK_DRAIN_MS);
    if (host.tap && !host.tapExited) host.tap.kill('SIGKILL');
    process.exit(1);
  });
  return host.run();
}

/** Lets stdout drain (pipes are asynchronous on macOS), then exits even if a handle lingers. */
function exitSoon(code) {
  process.exitCode = code;
  setTimeout(() => process.exit(code), 2000).unref();
}

if (require.main === module) {
  main().then(exitSoon, (err) => {
    say(`Internal error: ${err && err.stack ? err.stack : err}`);
    exitSoon(1);
  });
}

module.exports = { main, Host, TAP_SILENCE_MS, TAP_STOP_BUDGET_MS, killGroup, stopGroup, stopGroupSync, durationText };
