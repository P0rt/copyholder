// host's integration pass, end to end with the mock tap (--tap mock --no-open): tap's console teed into the
// terminal and tap.log (spec 7.12), tap's answers as tap_* events read by analysis/smoke.ts, the device names
// in /api/config, the fixed port and its fallback (spec 7.2), the quickcheck process group (spec 7.12) and the
// code 3 hint by SDK call (spec 7.1).
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { createServer, request, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { validateEventLine, validateManifest } from '../../core/schemas/session.ts';
import {
  FakeWorker, ROOT, makeSandbox, processRunning, readJson, readJsonl, sleep, startHost, upgradeStatus, waitUntil,
  type HostRun, type Sandbox,
} from './helpers.ts';

const MOCK_CAMERA = 'Mock camera (no SDK)';
/** tap's camera list header (live/tap.cjs showCameras), after 'tap: '. */
const MOCK_HEADER = 'cameras (copy one name into settings.env as COPYHOLDER_CAMERA_NAME=...):';
const ELECTRON_HINT = 'If the camera does not open in plain Node, run it again with: npm run live:electron -- smoke (spec 6.7).';
const KEY_A = 'fake_key_AbCdEfGhIjKlMnOpQrSt1234';
const KEY_B = 'QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVo0123456789+/==';

/** manifest.json and events.jsonl pass the core validators (core/schemas). */
function schemaProblems(dir: string): string[] {
  const out = validateManifest(readJson(join(dir, 'manifest.json'))).map((p) => `manifest.json ${p}`);
  readJsonl(join(dir, 'events.jsonl')).forEach((e, i) => out.push(...validateEventLine(e).map((p) => `events.jsonl:${i + 1} ${p}`)));
  return out;
}

/** A quickcheck stand-in run by `npx tsx`: starts a process that outlives it, records both pids, then exits or waits. */
function leftoverScript(pidFile: string, verdict: string, then: 'exit' | 'wait'): string {
  return [
    "import { spawn } from 'node:child_process';",
    "import { writeFileSync } from 'node:fs';",
    "const g = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: ['ignore', 'inherit', 'inherit'] });",
    `writeFileSync(${JSON.stringify(pidFile)}, JSON.stringify({ script: process.pid, leftover: g.pid }));`,
    then === 'exit'
      ? `process.stdout.write(${JSON.stringify(`${verdict}\n`)}, () => process.exit(0));`
      : `console.log(${JSON.stringify(verdict)});\nsetInterval(() => {}, 1000);`,
    '',
  ].join('\n');
}

/**
 * A quickcheck stand-in like doctor's (analysis/lib/tts.ts): a helper in a process group of its own, which only the
 * stand-in's SIGTERM and exit handlers end. It records both pids and waits.
 */
function ownGroupScript(pidFile: string): string {
  return [
    "import { spawn } from 'node:child_process';",
    "import { writeFileSync } from 'node:fs';",
    "const g = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore', detached: true });",
    "const stop = () => { try { if (g.pid) process.kill(-g.pid, 'SIGKILL'); } catch { /* gone */ } };",
    "process.on('exit', stop);",
    "process.on('SIGTERM', () => { stop(); process.exit(143); });",
    `writeFileSync(${JSON.stringify(pidFile)}, JSON.stringify({ script: process.pid, leftover: g.pid }));`,
    "console.log('checking gate-a');",
    'setInterval(() => {}, 1000);',
    '',
  ].join('\n');
}

function rawGet(port: number, path: string, headers: Record<string, string>): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path, headers }, (res) => {
      res.resume();
      resolve(res.statusCode ?? 0);
    });
    req.on('error', reject);
    req.end();
  });
}

describe('host integration with the mock tap', () => {
  let sb: Sandbox;
  let hosts: HostRun[] = [];
  let pids: number[] = [];
  let blocker: Server | null = null;

  beforeEach(() => {
    sb = makeSandbox();
  });

  afterEach(async () => {
    for (const h of hosts) {
      h.kill();
      await h.exited;
    }
    hosts = [];
    for (const pid of pids) {
      if (processRunning(pid)) process.kill(pid, 'SIGKILL');
    }
    pids = [];
    if (blocker) await new Promise((resolve) => blocker?.close(resolve));
    blocker = null;
    sb.cleanup();
  });

  async function start(args: string[], env: Record<string, string> = {}): Promise<HostRun> {
    const h = await startHost(sb, args, env);
    hosts.push(h);
    return h;
  }

  /** The page's order (web/main.ts): GET /, GET /api/config, the worker's socket and its hello. */
  async function openPage(h: HostRun): Promise<{ w: FakeWorker; dir: string; id: string }> {
    expect(await h.loadPage()).toBe(200);
    const cfg = await h.config();
    const w = await FakeWorker.open(cfg.sessionUrl, h.origin);
    w.hello();
    return { w, dir: join(sb.sessions, cfg.sessionId), id: cfg.sessionId };
  }

  /** Consent, then audio blocks of 0.2 s every 200 ms until `untilFn` holds (or 8 s), then `end`. */
  async function record(h: HostRun, w: FakeWorker, untilFn: () => boolean = () => true): Promise<number | null> {
    w.send({ t: 'consent', at: '2026-11-13T08:00:00.000Z' });
    await w.waitMessage((m) => m.t === 'tap' && m.status === 'running');
    let n0 = 0;
    const end = Date.now() + 8000;
    do {
      w.block(n0);
      n0 += 9600;
      await sleep(200);
    } while (!untilFn() && Date.now() < end);
    w.send({ t: 'end', reason: 'done' });
    return h.exited;
  }

  it('tees tap\'s stdout and stderr, redacted, into the terminal and tap.log, which has no hash (spec 7.12, 8.7)', async () => {
    const script = {
      print: [
        { when: 'config', to: 'stdout', text: `mock: config ${KEY_A} ok` },
        { when: 'config', to: 'stderr', text: 'mock: stderr before consent' },
        { when: 'start', to: 'stdout', text: `mock: started ${KEY_B}` },
        { when: 'start', to: 'stderr', text: 'mock: stderr after start' },
        { when: 'stop', to: 'stdout', text: 'mock: stopping' },
      ],
    };
    const h = await start(['--mode', 'gate', '--pack', 'A', '--tap', 'mock'], { COPYHOLDER_MOCK_SCRIPT: JSON.stringify(script) });
    await h.waitFor(/mock: stderr before consent/);
    await h.waitFor(/mock: config \[redacted\] ok/);
    // each stream to its own terminal stream
    expect(h.stdout()).toContain('mock: config [redacted] ok\n');
    expect(h.stderr()).toContain('mock: stderr before consent\n');
    expect(h.stdout()).not.toContain('mock: stderr before consent');
    const { w, dir } = await openPage(h);
    expect(await record(h, w, () => h.out().includes('mock: stderr after start'))).toBe(0);
    expect(h.stdout()).toContain('mock: started [redacted]\n');
    expect(h.stdout()).toContain('mock: stopping\n');
    expect(h.out()).not.toContain(KEY_A);
    expect(h.out()).not.toContain(KEY_B);

    const lines = readFileSync(join(dir, 'tap.log'), 'utf8').split('\n');
    expect(lines.pop()).toBe('');
    expect([...lines].sort()).toEqual([
      'mock: config [redacted] ok', 'mock: started [redacted]', 'mock: stderr after start', 'mock: stderr before consent', 'mock: stopping',
    ]);
    // the lines from before consent come first, tap's last line (after host's stop) is in
    const at = (t: string) => lines.indexOf(t);
    expect(Math.max(at('mock: config [redacted] ok'), at('mock: stderr before consent')))
      .toBeLessThan(Math.min(at('mock: started [redacted]'), at('mock: stderr after start')));
    expect(at('mock: stopping')).toBe(4);

    const m = readJson(join(dir, 'manifest.json'));
    expect(Object.keys(m.files as object)).toEqual(['audio.wav', 'detector_in.jsonl', 'events.jsonl', 'samples.jsonl', 'stamps.jsonl']);
    expect(m).toMatchObject({ tap: 'mock', dry: false });
    expect(readFileSync(join(dir, 'ledger.jsonl'), 'utf8')).not.toContain('tap.log');
    expect(schemaProblems(dir)).toEqual([]);
    // no tap_* events outside smoke: the camera's name stays out of the published events.jsonl
    expect(readJsonl(join(dir, 'events.jsonl')).filter((e) => String(e.e).startsWith('tap_'))).toEqual([]);
  }, 30_000);

  it('keeps no tap.log and no folder when consent never came', async () => {
    const script = { print: [{ when: 'config', to: 'stdout', text: 'mock: config line' }] };
    const h = await start(['--mode', 'gate', '--pack', 'A', '--tap', 'mock'], { COPYHOLDER_MOCK_SCRIPT: JSON.stringify(script) });
    await h.waitFor(/mock: config line/);
    const { w } = await openPage(h);
    w.send({ t: 'end', reason: 'cancel' });
    expect(await h.exited).toBe(0);
    expect(h.out()).toContain('Nothing was recorded.');
    expect(readdirSync(sb.sessions)).toEqual([]);
  }, 20_000);

  it('keeps tap\'s smoke answers in tap.log and as tap_* events, and analysis/smoke.ts reads them from tap.log (spec 7.12 questions 1, 2, 4, 10)', async () => {
    const sdkLine = 'I20261113 08:00:01.234567  4242 net.cc:88] POST https://api.example.com/v2/insights/upload_snapshot sent';
    const differences = ['kSustainedLowFrameRate=14', 'kFrameConversionFailed=9'];
    const mock = { readiness: 'timeout', enumDifferences: { SmartSpectraErrorCode: differences }, print: [{ when: 'start', to: 'stderr', text: sdkLine }] };
    const h = await start(['--mode', 'smoke', '--tap', 'mock'], { COPYHOLDER_MOCK_SCRIPT: JSON.stringify(mock), COPYHOLDER_LAUNCHER: '' });
    const { w, dir, id } = await openPage(h);
    // tap's configure() answers come before consent (a person takes longer than this)
    await h.waitFor(/SmartSpectraErrorCode: differs from reduce\.cjs/);
    await sleep(100);
    // 3 s of packets: the median trace rate needs more than 1 s of trace (spec 7.12 hard conditions)
    const samples = join(dir, 'samples.jsonl');
    const packets = () => (existsSync(samples) ? readFileSync(samples, 'utf8').split('\n').filter((l) => l.includes('"k":"m"')).length : 0);
    expect(await record(h, w, () => packets() >= 90)).toBe(0);
    expect(h.out()).not.toContain('live:electron'); // the camera opened

    // tap.log holds tap's lines as tap prints them (live/tap.cjs), the enum pairs and the SDK's URL unredacted
    const log = readFileSync(join(dir, 'tap.log'), 'utf8').split('\n');
    expect(log.pop()).toBe('');
    const lineOf = (text: string) => {
      const i = log.indexOf(text);
      expect(i, `tap.log has no line "${text}":\n${log.join('\n')}`).toBeGreaterThanOrEqual(0);
      return `tap.log:${i + 1}`;
    };
    const header = lineOf(`tap: ${MOCK_HEADER}`);
    expect(log[log.indexOf(`tap: ${MOCK_HEADER}`) + 1]).toBe(MOCK_CAMERA);
    const enumLines = {
      ProcessingStatus: lineOf('ProcessingStatus: matches reduce.cjs'),
      ValidationCode: lineOf('ValidationCode: matches reduce.cjs'),
      SmartSpectraErrorCode: lineOf(`SmartSpectraErrorCode: differs from reduce.cjs: ${differences.join(', ')}`),
    };
    lineOf('tap: checkDeviceReadiness() did not settle in 30 s; start() waits for it');
    const ready = lineOf('checkDeviceReadiness(): ready (camera ok)');
    const sdk = lineOf(sdkLine);
    const probeIndex = log.findIndex((l) => /^packet 1: \{.*\}$/.test(l));
    expect(probeIndex).toBeGreaterThanOrEqual(0);
    expect(JSON.parse(log[probeIndex]!.slice('packet 1: '.length))).toMatchObject({
      fields: ['breathing', 'face'], tsType: 'number', tr: 1, talk: 1, frames: 1, points: 16, tsCbType: 'number',
    });
    expect(log.join('\n')).not.toContain('[redacted]');

    // the same answers as tap_* events, after the consent line (n null), without face coordinates
    const events = readJsonl(join(dir, 'events.jsonl'));
    expect(schemaProblems(dir)).toEqual([]);
    expect(events.slice(0, 4)).toEqual([
      { n: null, e: 'consent', by: 'host', at: '2026-11-13T08:00:00.000Z' },
      { n: null, e: 'tap_cameras', by: 'host', list: [{ name: MOCK_CAMERA }] },
      {
        n: null, e: 'tap_camera', by: 'host', name: MOCK_CAMERA, requested: [1280, 720, 30],
        metrics: ['CHEST_BREATHING', 'BREATHING_RATE', 'FACE_LANDMARKS', 'TALKING'],
      },
      {
        n: null, e: 'tap_enums', by: 'host',
        checks: [
          { label: 'ProcessingStatus', differences: [] }, { label: 'ValidationCode', differences: [] },
          { label: 'SmartSpectraErrorCode', differences },
        ],
      },
    ]);
    const readiness = events.filter((e) => e.e === 'tap_readiness').map(({ verdict, reason }) => ({ verdict, reason }));
    expect(readiness).toEqual([{ verdict: null, reason: 'timeout' }, { verdict: 'ready', reason: 'camera ok' }]);
    const probes = events.filter((e) => e.e === 'tap_probe');
    expect(probes).toHaveLength(1);
    expect(probes[0]?.ipc).toMatchObject({
      t: 'probe', packet: 1, fields: ['breathing', 'face'], tsType: 'number', tr: 1, talk: 1, frames: 1, points: 16, tsCbType: 'number',
    });
    expect(probes[0]?.ipc).not.toHaveProperty('xRange');
    expect(probes[0]?.ipc).not.toHaveProperty('yRange');
    expect(readJson(join(dir, 'manifest.json'))).toMatchObject({ kind: 'smoke', tap: 'mock', dry: false, camera: { name: MOCK_CAMERA } });

    const r = spawnSync('npx', ['tsx', 'analysis/smoke.ts', id], {
      cwd: ROOT,
      env: { ...process.env, COPYHOLDER_SESSIONS_DIR: sb.sessions },
      encoding: 'utf8',
      timeout: 90_000,
    });
    expect(r.status, `${r.stdout}\n${r.stderr}`).toBe(0);
    expect(r.stdout).toMatch(/^SMOKE OK$/m);
    const report = readJson(join(dir, 'smoke_report.json'));
    const q = report.questions as Record<string, Record<string, unknown>>;
    // tap.log is read first, as with the real tap (analysis/smoke/tap-output.ts)
    expect(q.q1_start).toMatchObject({
      cameras: [MOCK_CAMERA],
      cameras_source: header,
      camera_name: MOCK_CAMERA,
      readiness: { verdict: 'ready', reason: 'camera ok', failed: false, source: ready },
    });
    const q2 = q.q2_data as { probes: Record<string, unknown>[]; enums: Record<string, unknown>[] };
    expect(q2.probes).toEqual([expect.objectContaining({
      source: `tap.log:${probeIndex + 1}`, packet: 1, fields: ['breathing', 'face'], ts_type: 'number', ts_cb_type: 'number', mesh_points: 16,
    })]);
    expect(q2.enums).toEqual([
      { label: 'ProcessingStatus', matches: true, differences: [], source: enumLines.ProcessingStatus },
      { label: 'ValidationCode', matches: true, differences: [], source: enumLines.ValidationCode },
      { label: 'SmartSpectraErrorCode', matches: false, differences, source: enumLines.SmartSpectraErrorCode },
    ]);
    expect(q.q4_time).toMatchObject({ sample_ts_types: ['number'], callback_ts_types: ['number'] });
    const q10 = q.q10_insights as { answered: boolean; matches: { where: string; labels: string[] }[] };
    expect(q10.answered).toBe(true);
    expect(q10.matches).toEqual([expect.objectContaining({ where: sdk })]);
    expect(q10.matches[0]?.labels).toEqual(expect.arrayContaining(['insight', 'upload', 'snapshot', 'remote URL']));
    expect(report.tap_console).toMatchObject({ found: true });
    expect((report.tap_console as { searched: string[] }).searched).toEqual(expect.arrayContaining(['tap.log', 'events.jsonl']));
  }, 120_000);

  it('passes SMOKE OK on as a pass; tap.log is complete before quickcheck reads it (spec 7.12)', async () => {
    const script = join(sb.dir, 'quickcheck-smoke.ts');
    writeFileSync(script, [
      "import { readFileSync } from 'node:fs';",
      "import { join } from 'node:path';",
      "const log = readFileSync(join(process.env.COPYHOLDER_SESSIONS_DIR ?? '', process.argv[2] ?? '', 'tap.log'), 'utf8');",
      "if (log.includes('mock: stopping')) { console.log('SMOKE OK'); } else { console.log('SMOKE FAIL: tap.log has no stop line'); process.exitCode = 2; }",
      '',
    ].join('\n'));
    const mock = { print: [{ when: 'stop', to: 'stderr', text: 'mock: stopping' }] };
    const h = await start(['--mode', 'smoke', '--tap', 'mock'], {
      COPYHOLDER_QUICKCHECK_SCRIPT: script, COPYHOLDER_MOCK_SCRIPT: JSON.stringify(mock),
    });
    const { w } = await openPage(h);
    expect(await record(h, w)).toBe(0);
    expect(w.messages.at(-1)).toEqual({ t: 'quickcheck', ok: true, text: 'SMOKE OK' });
  }, 40_000);

  it('goes on after quickcheck exits even when a process it started holds its stdout, and ends that process', async () => {
    const pidFile = join(sb.dir, 'quickcheck-pids.json');
    const script = join(sb.dir, 'quickcheck-leftover.ts');
    writeFileSync(script, leftoverScript(pidFile, 'GOOD RECORDING', 'exit'));
    const h = await start(['--mode', 'gate', '--pack', 'A', '--tap', 'mock'], { COPYHOLDER_QUICKCHECK_SCRIPT: script });
    const { w } = await openPage(h);
    expect(await record(h, w)).toBe(0);
    const p = JSON.parse(readFileSync(pidFile, 'utf8')) as { script: number; leftover: number };
    pids.push(p.script, p.leftover);
    expect(w.messages.at(-1)).toEqual({ t: 'quickcheck', ok: true, text: 'GOOD RECORDING' });
    await waitUntil(() => !processRunning(p.leftover), 5000);
  }, 40_000);

  it('ends the whole quickcheck process group at its timeout', async () => {
    const pidFile = join(sb.dir, 'quickcheck-pids.json');
    const script = join(sb.dir, 'quickcheck-hang.ts');
    writeFileSync(script, leftoverScript(pidFile, 'checking gate-a', 'wait'));
    const h = await start(['--mode', 'gate', '--pack', 'A', '--tap', 'mock'], {
      COPYHOLDER_QUICKCHECK_SCRIPT: script, COPYHOLDER_QUICKCHECK_TIMEOUT_MS: '5000',
    });
    const { w } = await openPage(h);
    expect(await record(h, w)).toBe(0);
    const p = JSON.parse(readFileSync(pidFile, 'utf8')) as { script: number; leftover: number };
    pids.push(p.script, p.leftover);
    const text = 'The quick check did not finish in 5 seconds. Run it again: npm run quickcheck -- gate-a';
    expect(w.messages.at(-1)).toEqual({ t: 'quickcheck', ok: null, text });
    expect(h.out()).toContain(text);
    await waitUntil(() => !processRunning(p.script) && !processRunning(p.leftover), 5000);
  }, 40_000);

  it('ends quickcheck at its timeout with SIGTERM first, so a group it started of its own ends as well', async () => {
    const pidFile = join(sb.dir, 'quickcheck-pids.json');
    const script = join(sb.dir, 'quickcheck-own-group.ts');
    writeFileSync(script, ownGroupScript(pidFile));
    const h = await start(['--mode', 'gate', '--pack', 'A', '--tap', 'mock'], {
      COPYHOLDER_QUICKCHECK_SCRIPT: script, COPYHOLDER_QUICKCHECK_TIMEOUT_MS: '5000',
    });
    const { w } = await openPage(h);
    expect(await record(h, w)).toBe(0);
    const p = JSON.parse(readFileSync(pidFile, 'utf8')) as { script: number; leftover: number };
    pids.push(p.script, p.leftover);
    const text = 'The quick check did not finish in 5 seconds. Run it again: npm run quickcheck -- gate-a';
    expect(w.messages.at(-1)).toEqual({ t: 'quickcheck', ok: null, text });
    // a SIGKILL alone would skip the stand-in's handlers and leave its helper running after host
    await waitUntil(() => !processRunning(p.script) && !processRunning(p.leftover), 5000);
  }, 40_000);

  it('stops the quickcheck process group on Ctrl+C: it does not get the terminal\'s signal', async () => {
    const pidFile = join(sb.dir, 'quickcheck-pids.json');
    const script = join(sb.dir, 'quickcheck-hang.ts');
    writeFileSync(script, leftoverScript(pidFile, 'checking gate-a', 'wait'));
    const h = await start(['--mode', 'gate', '--pack', 'A', '--tap', 'mock'], { COPYHOLDER_QUICKCHECK_SCRIPT: script });
    const { w } = await openPage(h);
    w.send({ t: 'consent', at: '2026-11-13T08:00:00.000Z' });
    await w.waitMessage((m) => m.t === 'tap' && m.status === 'running');
    w.block(0);
    w.send({ t: 'end', reason: 'done' });
    await waitUntil(() => existsSync(pidFile) && readFileSync(pidFile, 'utf8').length > 0, 30_000);
    const p = JSON.parse(readFileSync(pidFile, 'utf8')) as { script: number; leftover: number };
    pids.push(p.script, p.leftover);
    h.proc.kill('SIGINT');
    expect(await h.exited).toBe(0);
    const text = 'The quick check was stopped. Run it later: npm run quickcheck -- gate-a';
    expect(w.messages.at(-1)).toEqual({ t: 'quickcheck', ok: null, text });
    await waitUntil(() => !processRunning(p.script) && !processRunning(p.leftover), 5000);
  }, 60_000);

  it('gives the page the device names from COPYHOLDER_MIC_NAME and COPYHOLDER_OUTPUT_NAME', async () => {
    const named = await start(['--mode', 'gate', '--pack', 'A', '--tap', 'mock'], {
      COPYHOLDER_MIC_NAME: 'External Microphone', COPYHOLDER_OUTPUT_NAME: ' External Headphones ',
    });
    expect((await named.config()).devices).toEqual({ input: 'External Microphone', output: 'External Headphones' });
    const plain = await start(['--mode', 'gate', '--pack', 'A', '--tap', 'mock']);
    expect((await plain.config()).devices).toEqual({});
  }, 20_000);

  it('listens on COPYHOLDER_PORT when it is free', async () => {
    const free = await new Promise<number>((resolve) => {
      const s = createServer();
      s.listen(0, '127.0.0.1', () => {
        const port = (s.address() as AddressInfo).port;
        s.close(() => resolve(port));
      });
    });
    const h = await start(['--mode', 'gate', '--pack', 'A', '--tap', 'mock'], { COPYHOLDER_PORT: String(free) });
    expect(h.port).toBe(free);
    expect(h.out()).not.toContain('is taken');
  }, 20_000);

  it('falls back to a port the system picks when COPYHOLDER_PORT is taken, with the same guards (spec 7.2)', async () => {
    blocker = createServer((_req, res) => res.end('other'));
    const taken = await new Promise<number>((resolve) => {
      blocker?.listen(0, '127.0.0.1', () => resolve((blocker?.address() as AddressInfo).port));
    });
    const h = await start(['--mode', 'gate', '--pack', 'A', '--tap', 'mock'], { COPYHOLDER_PORT: String(taken) });
    expect(h.port).not.toBe(taken);
    expect(h.out()).toContain(`Port ${taken} is taken, so this run uses port ${h.port}: Chrome may ask for the microphone again.`);
    expect(h.out().match(/is taken/g)).toHaveLength(1);
    // token, Host and Origin checks hold on the new port
    expect((await fetch(`${h.origin}/api/config`)).status).toBe(403);
    expect((await fetch(`${h.origin}/api/config?token=${h.token}`)).status).toBe(200);
    expect(await rawGet(h.port, `/api/config?token=${h.token}`, { Host: `127.0.0.1:${taken}` })).toBe(403);
    const cfg = await h.config();
    expect(await upgradeStatus(cfg.sessionUrl, { Origin: `http://127.0.0.1:${taken}` })).not.toBe(101);
    expect(await upgradeStatus(cfg.sessionUrl, { Origin: h.origin })).toBe(101);
  }, 20_000);

  it('says so when COPYHOLDER_PORT is not a port number', async () => {
    const h = await start(['--mode', 'gate', '--pack', 'A', '--tap', 'mock'], { COPYHOLDER_PORT: 'http' });
    expect(h.out()).toContain('COPYHOLDER_PORT=http is not a port number (0-65535); using 47811.');
  }, 20_000);

  it('in smoke, names the camera and then the spare metric set for code 3 from useCamera(), and the Electron run (spec 6.7, 7.1)', async () => {
    const mock = { configError: { code: 3, call: 'useCamera()' } };
    const h = await start(['--mode', 'smoke', '--tap', 'mock'], { COPYHOLDER_MOCK_SCRIPT: JSON.stringify(mock), COPYHOLDER_LAUNCHER: '' });
    expect(await h.exited).toBe(1);
    expect(h.out()).toContain(
      'The SDK refused the camera request (kConfigurationFailed): the camera selection or its 1280x720, 30 fps format. ' +
      'Check COPYHOLDER_CAMERA_NAME in settings.env. If the name is right, put COPYHOLDER_METRICS=spare in settings.env and run smoke again.',
    );
    // tap's own lines, teed to the terminal
    expect(h.stderr()).toContain('tap: SDK error 3 kConfigurationFailed from useCamera(): useCamera() failed: mock camera failure\n');
    expect(h.out()).toContain(`${ELECTRON_HINT}\n`);
    expect(h.out().split(ELECTRON_HINT)).toHaveLength(2); // once
    expect(h.out()).toContain('The camera process stopped before the recording started. Nothing was recorded.');
    expect(readdirSync(sb.sessions)).toEqual([]);
  }, 20_000);

  it('names the Electron run in smoke when the camera fails before consent (spec 6.7, 7.12 question 1)', async () => {
    const run = async (mock: object, env: Record<string, string> = {}, args = ['--mode', 'smoke']) => {
      const h = await start([...args, '--tap', 'mock'], { COPYHOLDER_MOCK_SCRIPT: JSON.stringify(mock), COPYHOLDER_LAUNCHER: '', ...env });
      expect(await h.exited).toBe(1);
      expect(readdirSync(sb.sessions)).toEqual([]);
      return h.out();
    };
    // kInputUnavailable from useCamera(): tap lists the cameras and exits
    let out = await run({ configError: { code: 7, call: 'useCamera()' } });
    expect(out).toContain('The camera is not available (kInputUnavailable).');
    expect(out).toContain(`${ELECTRON_HINT}\n`);
    // a failure without an SDK code in the camera request
    out = await run({ configError: { code: null, call: 'CameraSelection.byId()', message: 'no such device' } });
    expect(out).toContain('tap: CameraSelection.byId() failed: no such device');
    expect(out).toContain(ELECTRON_HINT);
    // no camera at all
    out = await run({ cameras: [] });
    expect(out).toContain('Cameras found: none.');
    expect(out).toContain('tap: 0 cameras and no COPYHOLDER_CAMERA_NAME');
    expect(out).toContain(ELECTRON_HINT);
    // not about the camera opening: a name that matches no camera, a refused metric set, another launcher, another mode
    out = await run({ cameras: ['FaceTime HD Camera'], cameraName: 'Logitech' });
    expect(out).toContain('tap: no camera name contains "Logitech"');
    expect(out).not.toContain('live:electron');
    out = await run({ configError: { code: 13, call: 'new SmartSpectraSDK()' } });
    expect(out).toContain('The SDK did not accept the requested metrics (kMetricNotAuthorized). Put COPYHOLDER_METRICS=spare');
    expect(out).not.toContain('live:electron');
    out = await run({ configError: { code: 7, call: 'useCamera()' } }, { COPYHOLDER_LAUNCHER: 'electron' });
    expect(out).toContain('The camera is not available (kInputUnavailable).');
    expect(out).not.toContain('live:electron');
    out = await run({ configError: { code: 7, call: 'useCamera()' } }, {}, ['--mode', 'gate', '--pack', 'A']);
    expect(out).not.toContain('live:electron');
  }, 60_000);

  it('names the Electron run in smoke when tap stops before the first packet without saying why, not after one', async () => {
    const early = await start(['--mode', 'smoke', '--tap', 'mock'], {
      COPYHOLDER_MOCK_SCRIPT: JSON.stringify({ startDelayMs: 5000, exitAfterMs: 300 }), COPYHOLDER_LAUNCHER: '',
    });
    let page = await openPage(early);
    page.w.send({ t: 'consent', at: '2026-11-13T08:00:00.000Z' });
    page.w.block(0);
    await page.w.waitMessage((m) => m.t === 'abort' && m.reason === 'tap_lost');
    page.w.send({ t: 'end', reason: 'abort' });
    expect(await early.exited).toBe(0);
    expect(early.out()).toContain(`The camera process stopped.`);
    expect(early.out()).toContain(ELECTRON_HINT);

    const late = await start(['--mode', 'smoke', '--tap', 'mock'], {
      COPYHOLDER_MOCK_SCRIPT: JSON.stringify({ exitAfterMs: 2500 }), COPYHOLDER_LAUNCHER: '',
    });
    page = await openPage(late);
    page.w.send({ t: 'consent', at: '2026-11-13T08:00:00.000Z' });
    page.w.block(0);
    await page.w.waitMessage((m) => m.t === 'abort' && m.reason === 'tap_lost');
    page.w.send({ t: 'end', reason: 'abort' });
    expect(await late.exited).toBe(0);
    expect(late.out()).not.toContain('live:electron'); // packets came: the camera opened
  }, 40_000);

  it('names the camera request for an SDK error 3 from useCamera() (spec 7.1)', async () => {
    const mock = { errorAtMs: 400, errorCode: 3, errorCall: 'useCamera()' };
    const h = await start(['--mode', 'gate', '--pack', 'A', '--tap', 'mock'], { COPYHOLDER_MOCK_SCRIPT: JSON.stringify(mock) });
    const { w } = await openPage(h);
    w.send({ t: 'consent', at: '2026-11-13T08:00:00.000Z' });
    w.block(0);
    await w.waitMessage((m) => m.t === 'abort' && m.reason === 'sdk_error');
    w.send({ t: 'end', reason: 'sdk_error' });
    expect(await h.exited).toBe(0);
    expect(h.out()).toContain('The SDK refused the camera request (kConfigurationFailed): the camera selection or its 1280x720, 30 fps format. Check COPYHOLDER_CAMERA_NAME in settings.env.');
    expect(h.out()).not.toContain('did not accept the requested metrics');
  }, 30_000);
});
