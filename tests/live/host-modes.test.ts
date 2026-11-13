// live:from (spec 6.5: the mock tap replays a recording's detector inputs at their recorded nArr,
// channel 0 of audio.wav stands in for the microphone, both from the page's replay_start) and the
// quickcheck hand-off after a recording (spec 7.2, 7.12).
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import {
  FakeWorker, TapClient, makeSandbox, readJson, readJsonl, requireCjs, sleep, startHost, waitUntil,
  type HostRun, type Sandbox,
} from './helpers.ts';

const wav = requireCjs('../../live/lib/wav.cjs') as {
  WavWriter: new (file: string) => { append(b: Buffer): boolean; close(): void };
};

/**
 * A finished gate recording with three detector inputs at known arrival samples: packet 10 at
 * sample 24000 (0.5 s after the first audio sample), validation 11 with it, packet 12 at 72000 (1.5 s).
 */
function makeSourceRecording(sessions: string): string {
  const dir = join(sessions, 'gate-a');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify({ schema: 'session/1', id: 'gate-a', kind: 'gate', mode: 'gate', scenario: 'gate-A', pack: 'A' }));
  writeFileSync(join(dir, 'detector_in.jsonl'), [
    '{"k":"batch","seq":10,"tr":[[1000000,0.5]],"talk":[[1000000,0]],"g":0.01,"hm":0.002}',
    '{"k":"val","seq":11,"code":0}',
    '{"k":"voice","n":1500,"on":true}',
    '{"k":"batch","seq":12,"tr":[[1033333,-0.4000000059604645]],"talk":[[1033333,1]],"g":0.031746031746031744,"hm":null}',
    '',
  ].join('\n'));
  writeFileSync(join(dir, 'stamps.jsonl'), [
    '{"n":0,"k":"chunk","frames":9600}',
    '{"n":24000,"k":"arr","seq":10}',
    '{"n":72000,"k":"arr","seq":12}',
    '',
  ].join('\n'));
  const w = new wav.WavWriter(join(dir, 'audio.wav'));
  const frames = Buffer.alloc(9600 * 8);
  for (let i = 0; i < 9600; i++) {
    frames.writeFloatLE(0.25, i * 8);
    frames.writeFloatLE(-0.5, i * 8 + 4);
  }
  w.append(frames);
  w.close();
  return dir;
}

describe('host modes', () => {
  let sb: Sandbox;
  let host: HostRun | null = null;

  beforeEach(() => {
    sb = makeSandbox();
  });

  afterEach(async () => {
    if (host) {
      host.kill();
      await host.exited;
      host = null;
    }
    sb.cleanup();
  });

  it('live:from replays the recorded detector inputs over /tap from the page\'s replay_start, at their recorded offsets', async () => {
    makeSourceRecording(sb.sessions);
    const h = await startHost(sb, ['--mode', 'live-from', 'gate-a']);
    host = h;
    expect(await h.loadPage()).toBe(200);
    const cfg = (await h.config()) as unknown as Record<string, unknown>;
    // no camera and no microphone in live:from: its own consent text, and the recording's channel 0 as input
    expect(cfg).toMatchObject({
      mode: 'live-from', sessionId: 'live-from-1', scenario: 'gate-A', consentText: 'replay', replayAudio: 'mic.wav', tap: 'mock',
    });
    expect(cfg.narrator).toEqual(['mic.wav', 'cues.json', 'listen.timings.json', 'listen.wav', 'pack.json']);

    const mic = await fetch(`${h.origin}/api/narrator/mic.wav?token=${h.token}`);
    expect(mic.status).toBe(200);
    const bytes = Buffer.from(await mic.arrayBuffer());
    expect(bytes.readUInt16LE(22)).toBe(1); // mono
    expect(bytes.readUInt32LE(40)).toBe(9600 * 4);
    expect(bytes.readFloatLE(44)).toBe(0.25); // the microphone channel, not the narrator

    const tap = await TapClient.open(String(cfg.tapUrl), h.origin);
    const w = await FakeWorker.open(String(cfg.sessionUrl), h.origin);
    w.hello();
    await sleep(300);
    expect(tap.lines).toEqual([]); // nothing before consent
    w.send({ t: 'consent', at: '2026-11-12T20:00:00.000Z' });
    await w.waitMessage((m) => m.t === 'tap' && m.status === 'starting');
    await sleep(800);
    // consent alone starts nothing: the replay waits for the page's audio
    expect(tap.of('m')).toEqual([]);
    expect(tap.of('s').map((l) => l.line.name)).toEqual(['kStarting']);
    expect(w.messages.some((m) => m.t === 'tap' && m.status === 'running')).toBe(false);
    w.send({ t: 'event', line: { n: 0, e: 'replay_start' } });
    const anchor = performance.now();
    await waitUntil(() => tap.of('m').length === 2, 10_000);
    const [first, second] = tap.of('m');
    expect((first?.at ?? 0) - anchor).toBeGreaterThan(400);
    expect((first?.at ?? 0) - anchor).toBeLessThan(700);
    expect((second?.at ?? 0) - (first?.at ?? 0)).toBeGreaterThan(900);
    expect((second?.at ?? 0) - (first?.at ?? 0)).toBeLessThan(1100);
    const replayed = tap.lines.map((l) => l.line).filter((l) => l.k === 'm' || (l.k === 'v' && l.seq === 11));
    expect(replayed.map((l) => [l.k, l.seq])).toEqual([['m', 10], ['v', 11], ['m', 12]]);
    expect(replayed[2]).toMatchObject({ tr: [[1033333, -0.4000000059604645]], talk: [[1033333, 1]], g: 0.031746031746031744, hm: null });
    expect(typeof replayed[0]?.tArrNs).toBe('string');
    // the mock's own status lines number on above the recorded seq values
    const own = tap.of('s').map((l) => Number(l.line.seq));
    expect(own.every((s) => s > 12)).toBe(true);
    // the replay ending is not a lost tap: the mock leaves Running after replay_done
    await sleep(3600);
    expect(w.messages.some((m) => m.t === 'abort')).toBe(false);
    tap.close();
    w.send({ t: 'end', reason: 'done' });
    expect(await h.exited).toBe(0);
    expect(h.out()).toContain('All recorded detector inputs were replayed.');
    const dir = join(sb.sessions, 'live-from-1');
    const m = readJson(join(dir, 'manifest.json'));
    expect(m).toMatchObject({ kind: 'live_from', mode: 'live-from', source: 'gate-a', tap: 'mock', unusable: false, pack: null });
    expect(readJsonl(join(dir, 'samples.jsonl')).filter((l) => l.k === 'm').map((l) => l.seq)).toEqual([10, 12]);
    expect(readJsonl(join(dir, 'events.jsonl')).filter((e) => e.e === 'replay_start')).toEqual([{ n: 0, e: 'replay_start' }]);
    expect(existsSync(join(dir, 'ledger.jsonl'))).toBe(false); // live_from has no step order (spec 8.5)
  }, 25_000);

  it('runs quickcheck after the recording and prints its verdict (spec 7.12)', async () => {
    const script = join(sb.dir, 'quickcheck.ts');
    const seen = join(sb.dir, 'quickcheck-args.json');
    writeFileSync(script, [
      "import { writeFileSync } from 'node:fs';",
      `writeFileSync(${JSON.stringify(seen)}, JSON.stringify({ id: process.argv[2], sessions: process.env.COPYHOLDER_SESSIONS_DIR }));`,
      "console.log('GOOD RECORDING');",
      '',
    ].join('\n'));
    const h = await startHost(sb, ['--mode', 'gate', '--pack', 'A', '--tap', 'mock'], { COPYHOLDER_QUICKCHECK_SCRIPT: script });
    host = h;
    const cfg = await h.config();
    const w = await FakeWorker.open(cfg.sessionUrl, h.origin);
    w.hello();
    w.send({ t: 'consent', at: '2026-11-12T20:00:00.000Z' });
    w.block(0);
    w.send({ t: 'end', reason: 'done' });
    expect(await h.exited).toBe(0);
    expect(h.out()).toMatch(/Saved to [^\n]*\nRunning the quick check\.\.\.\nGOOD RECORDING\n/);
    expect(JSON.parse(readFileSync(seen, 'utf8'))).toEqual({ id: 'gate-a', sessions: sb.sessions });
    // the verdict goes to the page too, as host's last frame (docs/protocol.md)
    expect(w.messages.at(-1)).toEqual({ t: 'quickcheck', ok: true, text: 'GOOD RECORDING' });
    // the ledger step record is written before quickcheck starts
    expect(readFileSync(join(sb.sessions, 'gate-a', 'ledger.jsonl'), 'utf8')).toContain('"step":"record"');
  }, 30_000);

  it('passes DOCTOR OK on as a pass: ok comes from the exit code (spec 7.12)', async () => {
    const script = join(sb.dir, 'quickcheck-doctor.ts');
    writeFileSync(script, "console.log('checking doctor-1');\nconsole.log('DOCTOR OK');\nprocess.exitCode = 0;\n");
    writeFileSync(join(sb.sample, 'level.wav'), 'RIFF-level');
    const h = await startHost(sb, ['--mode', 'doctor'], { COPYHOLDER_QUICKCHECK_SCRIPT: script });
    host = h;
    expect(await h.loadPage()).toBe(200);
    const cfg = await h.config();
    const w = await FakeWorker.open(cfg.sessionUrl, h.origin);
    w.hello();
    w.send({ t: 'consent', at: '2026-11-12T20:00:00.000Z' });
    w.block(0);
    w.send({ t: 'end', reason: 'done' });
    expect(await h.exited).toBe(0);
    expect(w.messages.at(-1)).toEqual({ t: 'quickcheck', ok: true, text: 'DOCTOR OK' });
    expect(existsSync(join(sb.sessions, 'doctor-1', 'ledger.jsonl'))).toBe(false);
  }, 30_000);

  it('says so when quickcheck is not built yet', async () => {
    const h = await startHost(sb, ['--mode', 'gate', '--pack', 'A', '--tap', 'mock'], {
      COPYHOLDER_QUICKCHECK_SCRIPT: 'analysis/no-such-quickcheck.ts',
    });
    host = h;
    const cfg = await h.config();
    const w = await FakeWorker.open(cfg.sessionUrl, h.origin);
    w.hello();
    w.send({ t: 'consent', at: '2026-11-12T20:00:00.000Z' });
    w.send({ t: 'end', reason: 'done' });
    expect(await h.exited).toBe(0);
    expect(h.out()).toContain('The quick check is not built yet. When it is, run: npm run quickcheck -- gate-a');
    expect(existsSync(join(sb.sessions, 'gate-a', 'ledger.jsonl'))).toBe(true);
  });

  // The real live/tap.cjs in its dry mode (no SDK: synthetic packets through reduce) speaks the same
  // IPC as the mock: ready, camera, status, pulse, stopped (docs/protocol.md).
  const tapFile = join(import.meta.dirname, '..', '..', 'live', 'tap.cjs');
  const dryTap = existsSync(tapFile) && readFileSync(tapFile, 'utf8').includes('COPYHOLDER_TAP_DRY');
  it.skipIf(!dryTap)('works with the real tap in its dry mode (no SDK)', async () => {
    const h = await startHost(sb, ['--mode', 'gate', '--pack', 'A', '--tap', 'real'], { COPYHOLDER_TAP_DRY: '1' });
    host = h;
    const cfg = await h.config();
    const w = await FakeWorker.open(cfg.sessionUrl, h.origin);
    w.hello();
    const tapLines: Record<string, unknown>[] = [];
    const tap = new WebSocket(String(cfg.tapUrl), { headers: { Origin: h.origin } });
    tap.on('message', (d) => tapLines.push(JSON.parse(d.toString()) as Record<string, unknown>));
    await new Promise((resolve, reject) => {
      tap.once('open', resolve);
      tap.once('error', reject);
    });
    w.send({ t: 'consent', at: '2026-11-12T20:00:00.000Z' });
    await w.waitMessage((m) => m.t === 'tap' && m.status === 'running', 15_000);
    await waitUntil(() => tapLines.filter((l) => l.k === 'm').length >= 10, 10_000);
    w.block(0);
    w.block(9600);
    await sleep(2200); // two pulses: the watchdog sees packets and stays quiet
    expect(w.messages.some((m) => m.t === 'abort')).toBe(false);
    tap.close();
    w.send({ t: 'end', reason: 'done' });
    expect(await h.exited).toBe(0);
    const dir = join(sb.sessions, 'gate-a');
    const m = readJson(join(dir, 'manifest.json'));
    // tap's stand-in SDK ran (camera.dry): manifest.json marks the folder as no recording (spec 6.5)
    expect(m).toMatchObject({ tap: 'real', dry: true, unusable: false, sdk: { version: '3.5.0', launcher: 'node' } });
    // tap's console is in tap.log, which has no hash (spec 7.12, 8.7)
    expect(existsSync(join(dir, 'tap.log'))).toBe(true);
    expect(Object.keys(m.files as object)).not.toContain('tap.log');
    expect((m.sdk as { metrics: string[] }).metrics.length).toBeGreaterThan(0);
    expect((m.camera as { name: string }).name).toBeTruthy();
    expect(Object.keys(m.files as object)).toEqual(expect.arrayContaining(['samples.jsonl', 'sdk_raw.jsonl.gz', 'audio.wav']));
    const tapEvents = readJsonl(join(dir, 'events.jsonl')).filter((e) => e.e === 'tap').map((e) => e.status);
    expect(tapEvents).toEqual(['starting', 'running', 'stopped']);
  }, 40_000);

  it('refuses to start without a built page and says how to build it', async () => {
    const { spawnSync } = await import('node:child_process');
    const r = spawnSync(process.execPath, [join(import.meta.dirname, '..', '..', 'live', 'host.cjs'), '--mode', 'smoke', '--no-open'], {
      env: { ...process.env, COPYHOLDER_SESSIONS_DIR: sb.sessions, COPYHOLDER_WEB_DIST: join(sb.dir, 'no-dist') },
      encoding: 'utf8',
      timeout: 15_000,
    });
    expect(r.status).toBe(1);
    expect(r.stdout).toContain('The page is not built yet');
    expect(r.stdout).toContain('npm run build:web');
  });
});
