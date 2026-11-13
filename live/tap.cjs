'use strict';
// tap (spec 7.1): the only code that loads the SmartSpectra SDK; its pure parts are in reduce.cjs. host forks it
// (IPC of docs/protocol.md); the page's worker reads ws://127.0.0.1:<port>/tap. samples.jsonl and sdk_raw.jsonl.gz
// (spec 8.1) from host's first readiness or start on, both after consent (spec 12.2). --list-cameras: the names,
// then exit. --smoke (or config.smoke): spec 7.12. --dry: R.drySdkModule (COPYHOLDER_TAP_DRY=1 under Vitest only).
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const { pipeline } = require('node:stream');
const { monitorEventLoopDelay } = require('node:perf_hooks');
const { WebSocketServer, WebSocket } = require('ws');
const { checkUpgrade } = require('./lib/guard.cjs'); // host's socket rules, the same for /tap (spec 7.2)
const R = require('./reduce.cjs');

const ARGS = process.argv.slice(2);
const DRY_ENV = process.env.COPYHOLDER_TAP_DRY === '1';
const DRY = ARGS.includes('--dry') || (DRY_ENV && Boolean(process.env.VITEST));
const DRY_OPTS = DRY ? R.dryOptions(ARGS) : {};
const CAMERA = { width: 1280, height: 720, fps: 30 }; // spec 7.1; smoke reads the real size and rate
const LOOP_RES_MS = 10, MAX_HELD = 20_000; // event-loop timer period; lines held for the files or first client
let timing = {}; // host's side of the timing contract (docs/protocol.md); the defaults below without it
try { timing = require('./lib/tap-timing.cjs'); } catch {}
const PULSE_MS = timing.PULSE_EVERY_MS ?? 1000; // the pulse and the 'l' line (spec 7.1)
// stopAsync(), files and destroy() inside host's wait for the exit; host's test hook shortens both alike
const STOP = R.stopBudget(process.env.COPYHOLDER_TAP_STOP_BUDGET_MS, timing.TAP_STOP_BUDGET_MS ?? 10_000);
const READINESS_MS = DRY_OPTS.readinessTimeoutMs ?? 30_000; // then host hears 'timeout'; start() still waits
const K_ERROR_WAIT_MS = 2_000; // code 8: reset() waits at most this long for processingStatus kError

let secret = ''; // the API key: kept only to blank it out of every text tap prints or sends
const redact = (s) => (secret ? String(s).split(secret).join('[key]') : String(s));
const say = (...a) => console.error('tap:', ...a.map(redact));
const ipc = (m) => process.connected && process.send(m);
const envFile = (name) => {
  try { return R.parseEnvText(fs.readFileSync(path.join(__dirname, '..', name), 'utf8')); } catch { return {}; }
};
const settings = DRY ? {} : envFile('settings.env'); // optional (spec 7.1, 13.6); the environment wins
const setting = (k) => process.env[k] ?? settings[k] ?? '';

let smoke = ARGS.includes('--smoke');
let S = null, decode = null, sdk = null, config = null, wss = null, client = null, files = null, tick = null;
let eld = null, restartTimer = null, pending = [], early = []; // lines for the first /tap client; for the files
let state = R.initialState(), calls = 0, packets = 0, pulse = 0, probes = 0, readiness = null; // promise: start ok
let lastPacketNs = null; // arrival of the last metrics callback, for the pulse's last_ago_ms
let running = false, restarted = false, restartDue = false, stopping = false, decodeFailed = false;
let queue = Promise.resolve(); // host's readiness, start and pause run in turn; stop never waits for them
const lastStatus = {}; // the last code per status kind: host hears of changes only

/** One SDK call: a throw or rejection becomes an Error naming the call, with the SDK's code and retryable. */
function call(name, fn) {
  const wrap = (e) => Object.assign(new Error(`${name} failed: ${e?.message ?? e}`),
    { code: R.errorCodeOf(e), retryable: Boolean(e?.retryable), call: name });
  let r;
  try { r = fn(); } catch (e) { throw wrap(e); }
  return typeof r?.then === 'function' ? r.then(undefined, (e) => { throw wrap(e); }) : r;
}
/** fn() bounded by ms: resolves null or the failure, never rejects. */
const settle = (fn, ms, what) => Promise.race([Promise.resolve().then(fn), new Promise((_, no) => {
  setTimeout(() => no(new Error(`${what} did not settle in ${ms / 1000} s`)), ms).unref();
})]).then(() => null, (e) => e);

function loadSdk() {
  const timers = { every: setInterval, clear: clearInterval, after: setTimeout, nowUs: () => Date.now() * 1000 };
  if (DRY) return void ((S = R.drySdkModule(timers, DRY_OPTS)), (decode = R.dryDecode));
  const load = (id) => {
    try { return require(id); } catch (e) {
      throw new Error(`cannot load ${id} (${String(e?.message).split('\n')[0]}). Run: npm run setup:live`);
    }
  };
  S = load('@smartspectra/node-sdk');
  // The root decodeMetrics returns the raw buffer unless a class is registered (API reference): /messages decodes.
  decode = R.need(load('@smartspectra/node-sdk/messages').decodeMetrics, 'decodeMetrics in /messages');
}
const cameraList = () => call('SmartSpectraSDK.availableCameras()',
  () => [...R.need(S.SmartSpectraSDK, 'SmartSpectraSDK').availableCameras()])
  .map((c) => ({ id: c.id, name: c.name ?? null }));
/** Camera names one per line on stdout (smoke, the user); returns the IPC message. */
function showCameras(list) {
  say('cameras (copy one name into settings.env as COPYHOLDER_CAMERA_NAME=...):');
  for (const c of list) console.log(c.name ?? `(no name) id=${c.id}`);
  return { t: 'cameras', list };
}
/** Exit once the IPC message and stdout/stderr are flushed. */
function finish(code, msg) {
  const exit = () => process.stdout.write('', () => process.stderr.write('', () => process.exit(code)));
  if (msg && process.connected) process.send(msg, exit);
  else exit();
}

/** A file line into the stream's buffer (no handler waits for disk); held until the files open. */
function put(stream, text) {
  if (files) files[stream].write(text);
  else if (early && early.length < MAX_HELD) early.push([stream, text]);
}
/** A samples.jsonl line: the /tap client and the file get the same text (spec 7.1, docs/protocol.md). */
function emit(line) {
  const text = JSON.stringify(line);
  if (client?.readyState === WebSocket.OPEN) client.send(text);
  else if (pending && pending.length < MAX_HELD) pending.push(text);
  put('samples', `${text}\n`);
}

/** metrics: the raw buffer first, then decode and reduce (spec 7.1); smoke probes two packets (7.12 q2, q4). */
function onMetrics(tArr, seq, buf, timestampUs) {
  packets++;
  pulse++;
  lastPacketNs = tArr;
  const tsCbUs = R.toUs(timestampUs);
  const b64 = (Buffer.isBuffer(buf) ? buf : Buffer.from(buf)).toString('base64');
  put('gz', `${R.rawLine(seq, 'metrics', tArr, Date.now(), { tsCbUs, b64 })}\n`);
  let msg = {};
  try { msg = call('decodeMetrics()', () => decode(buf)); } catch (e) {
    if (!decodeFailed) say(`${e.message}; lines go on with empty fields, sdk_raw.jsonl.gz keeps the buffers`);
    decodeFailed = true;
  }
  const out = R.reduce(state, msg, { seq, tArrNs: tArr, tsCbUs });
  state = out.state;
  emit(out.line);
  if (!smoke || probes >= 2 || (packets > 1 && !out.line.lm)) return;
  probes = out.line.lm ? 2 : 1;
  const probe = { ...R.probeMetrics(msg), tsCbType: R.typeName(timestampUs) };
  console.log(`packet ${packets}: ${JSON.stringify(probe)}`);
  ipc({ t: 'probe', packet: packets, ...probe });
}
/** validationStatus, processingStatus, frameSentThrough, error: both lines, then the status or the error. */
function onEvent(ev, tArr, seq, args) {
  if (ev === 'error') args[1] = redact(args[1] ?? '');
  const rec = R.eventRecord(ev, seq, tArr, Date.now(), args);
  put('gz', `${rec.raw}\n`);
  emit(rec.line);
  const code = args[0];
  if (ev === 'error') return onSdkError(code, args[1], args[2], null);
  if (ev === 'frameSentThrough' || lastStatus[ev] === code) return;
  lastStatus[ev] = code;
  ipc({ t: 'status', kind: ev, code, name: rec.line.name });
  if (ev === 'processingStatus' && code === 5 && restartDue) setImmediate(restart); // kError: reset() may run
}
/** The five handlers of spec 7.1; on() replaces an earlier handler, so each is set once. */
function attachHandlers() {
  for (const ev of ['metrics', 'validationStatus', 'processingStatus', 'frameSentThrough', 'error']) {
    call(`on('${ev}')`, () => sdk.on(ev, (...a) => {
      const tArr = process.hrtime.bigint(); // the first line of every handler (spec 6.2, 7.1)
      try { if (ev === 'metrics') onMetrics(tArr, ++calls, ...a); else onEvent(ev, tArr, ++calls, a); }
      catch (e) { say(`${ev} handler: ${e?.stack ?? e}`); }
    }));
  }
}

/** An error event or a coded exception: the table of spec 7.1. 'abort' is host's to act on (spec 7.2). */
function onSdkError(code, message, retryable, from) {
  const action = R.errorAction(code, running && packets === 0 && !restarted); // "before the recording"
  const name = R.errorName(code);
  ipc({ t: 'sdk_error', code, name, message: redact(message), retryable: Boolean(retryable), call: from, action });
  say(`SDK error ${code} ${name}${from ? ` from ${from}` : ''}: ${redact(message)}`);
  if (action === 'exit_key') console.error(R.KEY_HINT);
  const hint = R.errorHint(code, from, smoke);
  if (hint) say(hint);
  if (action === 'exit_cameras') { try { ipc(showCameras(cameraList())); } catch (e) { say(e.message); } }
  if (action.startsWith('exit')) shutdown(1);
  if (action !== 'reset_restart') return;
  restarted = restartDue = true; // reset() is "rebuild after kError" (API reference): wait for kError, bounded
  restartTimer = setTimeout(restart, lastStatus.processingStatus === 5 ? 0 : K_ERROR_WAIT_MS);
}
/** A failure: an SDK code goes through the table, anything else stops tap (action 'exit'). */
function onThrow(e) {
  if (Number.isInteger(e?.code)) return onSdkError(e.code, e.message, e.retryable, e.call ?? null);
  const message = redact(e?.message ?? e);
  say(message);
  ipc({ t: 'sdk_error', code: null, name: 'tap', message, retryable: false, call: e?.call ?? null, action: 'exit' });
  return shutdown(1);
}
/** kProcessingFailed before the first packet: reset() and one restart (spec 7.1); the typed camera stays. */
async function restart() {
  clearTimeout(restartTimer);
  if (!restartDue || stopping || !running) return;
  restartDue = false;
  say('kProcessingFailed before the first packet: reset() and one restart');
  try { // start() is a plain call in the quickstart; a returned promise is awaited all the same
    await call('reset()', () => sdk.reset());
    if (!stopping && running) await call('start()', () => sdk.start());
  } catch (e) { onThrow(e); }
}

/** host's first readiness or start (after consent): the session files and the 1 s clock. */
function begin() {
  if (files || !early) return;
  fs.mkdirSync(config.sessionDir, { recursive: true });
  const file = (name) => fs.createWriteStream(path.join(config.sessionDir, name), { flags: 'a' });
  const gz = zlib.createGzip();
  const done = new Promise((ok) => pipeline(gz, file('sdk_raw.jsonl.gz'), (e) => { if (e) onFileError(e); ok(); }));
  files = { samples: file('samples.jsonl').on('error', onFileError), gz, done };
  for (const [stream, text] of early) files[stream].write(text);
  early = null;
  eld = monitorEventLoopDelay({ resolution: LOOP_RES_MS });
  eld.enable();
  tick = setInterval(everySecond, PULSE_MS);
}
function onFileError(e) { if (!stopping) onThrow(new Error(`session files: ${e.message}`)); }
async function closeFiles() {
  const f = files;
  files = early = null;
  if (!f) return;
  await new Promise((ok) => f.samples.end(ok));
  f.gz.end();
  await f.done;
}
/** Once a second: the 'l' line (spec 7.1, 8.1), the pulse to host (spec 7.2), a gzip sync point. */
function everySecond() {
  emit({ ...R.loopLine(process.hrtime.bigint(), R.loopStats(eld, LOOP_RES_MS)), ...(DRY && { dry: 1 }) });
  eld.reset();
  ipc({ t: 'pulse', packets: pulse, last_ago_ms: R.agoMs(process.hrtime.bigint(), lastPacketNs) });
  pulse = 0;
  files?.gz.flush(zlib.constants.Z_SYNC_FLUSH);
}

/** host's config: SDK, handlers and the camera by name (spec 7.1). The camera turns on only at start(). */
function configure(m) {
  if (![m.token, m.origin, m.sessionDir].every((v) => typeof v === 'string' && v)) {
    return onThrow(new Error('config needs token, origin and sessionDir'));
  }
  config = m;
  smoke ||= m.smoke === true;
  try {
    if (DRY) say('DRY RUN: synthetic packets, no SDK and no camera; these files are no recording');
    secret = DRY ? '' : envFile('.env').SMARTSPECTRA_API_KEY || process.env.SMARTSPECTRA_API_KEY || ''; // spec 13.6
    if (!DRY && !secret) return onSdkError(2, 'SMARTSPECTRA_API_KEY is missing from .env', false, 'tap');
    loadSdk();
    const cams = cameraList(), want = setting('COPYHOLDER_CAMERA_NAME'), cam = R.pickCamera(cams, want);
    if (smoke || !cam) ipc(showCameras(cams));
    if (!cam) {
      say(want ? `no camera name contains "${want}"` : `${cams.length} cameras and no COPYHOLDER_CAMERA_NAME`);
      return shutdown(1);
    }
    const options = R.sdkOptions(S, { apiKey: secret, spare: setting('COPYHOLDER_METRICS') === 'spare', smoke });
    const SDK = R.need(S.SmartSpectraSDK, 'SmartSpectraSDK');
    sdk = call('new SmartSpectraSDK()', () => new SDK(options));
    attachHandlers();
    const selection = call('CameraSelection.byId()', () => R.need(S.CameraSelection, 'CameraSelection').byId(cam.id));
    call('useCamera()', () => sdk.useCamera(selection, CAMERA));
    const metrics = R.metricNames(S.MetricType, options.requestedMetrics), requested = Object.values(CAMERA);
    ipc({ t: 'camera', id: cam.id, name: cam.name, requested, metrics, ...(DRY && { dry: true }) });
    if (!smoke) return;
    const checks = R.enumChecks(S);
    for (const c of checks) console.log(R.enumLine(c));
    ipc({ t: 'enums', checks });
  } catch (e) { onThrow(e); }
}

/** checkDeviceReadiness() (spec 7.12 question 1), verdict to host; false after a coded failure: no start(). */
async function checkReadiness() {
  let result, timer;
  const p = Promise.resolve().then(() => call('checkDeviceReadiness()', () => sdk.checkDeviceReadiness()))
    .then((r) => { result = r; return null; }, (e) => e); // null or the failure
  if ((await Promise.race([p, new Promise((ok) => { timer = setTimeout(ok, READINESS_MS, 'late'); })])) === 'late') {
    say(`checkDeviceReadiness() did not settle in ${READINESS_MS / 1000} s; start() waits for it`);
    ipc({ t: 'readiness', verdict: null, reason: 'timeout' });
  }
  clearTimeout(timer);
  const e = await p, reason = e ? e.message : result?.reason;
  if (!e) console.log(redact(`checkDeviceReadiness(): ${result?.verdict} (${result?.reason})`));
  else if (!Number.isInteger(e.code)) say(e.message);
  ipc({ t: 'readiness', verdict: e ? null : result?.verdict ?? null, reason: reason == null ? null : redact(reason) });
  if (!Number.isInteger(e?.code)) return true;
  onSdkError(e.code, e.message, e.retryable, e.call);
  return false;
}
/** host's steps after consent (spec 12.2): readiness alone, start(), pause (await stopAsync(); spec 11.5). */
const steps = {
  __proto__: null,
  async readiness() {
    if (!sdk || stopping) return;
    begin();
    await (readiness = checkReadiness());
  },
  async start() {
    if (!sdk || stopping || running) return;
    begin();
    if (smoke && !readiness) readiness = checkReadiness(); // host asked for none first: smoke still gets one
    if (readiness && !(await readiness)) return say('start() skipped: checkDeviceReadiness() gave an SDK code');
    if (stopping) return;
    running = true;
    state = R.breakTrack(state);
    await call('start()', () => sdk.start()); // a throw or rejection goes to the queue's onThrow
    ipc({ t: 'started' });
  },
  async pause() { // the files, the process and the socket stay for the next start (typed selection is kept)
    if (!running || stopping) return;
    const e = await stopSdk();
    if (e) return onThrow(e);
    ipc({ t: 'paused' });
  },
};
/** Only await sdk.stopAsync() (spec 7.1: stop() blocks for seconds), bounded by its share of the stop budget. */
function stopSdk() {
  running = restartDue = false;
  return settle(() => call('stopAsync()', () => sdk.stopAsync()), STOP.stopAsyncMs, 'stopAsync()');
}
/** stopAsync(), then the files, then destroy(): each bounded, together inside host's wait for the exit (7.2). */
async function shutdown(code) {
  if (stopping) return;
  stopping = true;
  clearInterval(tick);
  clearTimeout(restartTimer);
  eld?.disable();
  const failed = (e) => { if (e) { say(e.message); code ||= 1; } };
  if (running) failed(await stopSdk());
  await new Promise((ok) => setImmediate(ok)); // callbacks already queued still get their lines
  failed(await settle(closeFiles, STOP.filesMs, 'closing the session files'));
  if (typeof sdk?.destroy === 'function') {
    failed(await settle(() => call('destroy()', () => sdk.destroy()), STOP.destroyMs, 'destroy()'));
  }
  client?.close(1001, 'tap stopped');
  wss?.close();
  finish(code, { t: 'stopped' });
}

/** /tap: host's token and the page origin, one client (spec 7.1, 7.2). */
function verifyClient({ req }, done) {
  const v = config
    ? checkUpgrade(req, { path: '/tap', token: config.token, origin: config.origin, port: wss.address().port })
    : { ok: false, status: 403 };
  if (!v.ok) done(false, v.status);
  else done(!client, client ? 409 : undefined);
}
function onClient(ws) {
  if (client) return ws.close(1008, 'one client');
  client = ws;
  ws.on('close', () => { if (client === ws) client = null; });
  ws.on('error', () => {});
  for (const text of pending ?? []) ws.send(text);
  pending = null;
}

if (DRY_ENV && !DRY) {
  say('COPYHOLDER_TAP_DRY=1 is a test switch (Vitest only): unset it, or pass --dry');
  process.exitCode = 1;
} else if (ARGS.includes('--list-cameras')) {
  try { loadSdk(); finish(0, showCameras(cameraList())); } catch (e) { say(e.message); finish(1); }
} else if (!process.send) {
  say('tap runs under live/host.cjs (fork IPC); on its own it only takes --list-cameras');
  process.exitCode = 1;
} else {
  wss = new WebSocketServer({ host: '127.0.0.1', port: 0, maxPayload: 1024, verifyClient });
  wss.on('connection', onClient);
  wss.on('listening', () => ipc({ t: 'ready', port: wss.address().port }));
  wss.on('error', (e) => onThrow(new Error(`/tap server: ${e.message}`)));
  process.on('message', (m) => {
    if (m?.t === 'config' && !config) configure(m);
    else if (m?.t === 'stop') shutdown(0);
    else if (typeof m?.t === 'string' && steps[m.t]) queue = queue.then(() => steps[m.t]()).catch(onThrow);
  });
  process.on('disconnect', () => shutdown(0)); // host is gone: stop the SDK as well
  for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => shutdown(0));
  process.on('uncaughtException', (e) => { say(e?.stack ?? e); shutdown(1); });
  process.on('unhandledRejection', (e) => { say(e?.stack ?? e); shutdown(1); });
}
