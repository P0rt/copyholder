// Spec 7.2 tests of the recording path with the mock tap: start only after consent, audio gaps,
// page reload, tap_lost, SDK errors, tap's stop, WAV header, manifest hashes and the ledger step `record`.
// Pages follow the real order (web/main.ts): GET /, GET /api/config, then /session after consent.
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { validateEventLine, validateManifest, validateSampleLine, validateStampLine } from '../../core/schemas/session.ts';
import { verifyLedgerText } from '../../core/schemas/ledger.ts';
import { validateCalib } from '../../core/schemas/reports.ts';
import {
  FakeWorker, TapClient, makeSandbox, readJson, readJsonl, requireCjs, sleep, startHost, waitUntil,
  type HostConfig, type HostRun, type Sandbox,
} from './helpers.ts';

interface WavInfo {
  fileBytes: number;
  riffBytes: number;
  dataOffset: number;
  dataBytes: number;
  presentBytes: number;
  placeholder: boolean;
  formatTag: number;
  channels: number;
  sampleRate: number;
  bitsPerSample: number;
  blockAlign: number;
}
const wav = requireCjs('../../live/lib/wav.cjs') as {
  readWavInfo(file: string): WavInfo;
  isConsistentWav(info: WavInfo): boolean;
  repairWav(file: string): WavInfo;
};
const ledger = requireCjs('../../live/lib/ledger.cjs') as {
  verifyLedgerText(text: string): { ok: boolean; lines: string[]; error: string | null };
};

const sha256 = (file: string) => createHash('sha256').update(readFileSync(file)).digest('hex');
const sha256Text = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');

/** Every file host writes passes the core validators (core/schemas), one message per problem. */
function schemaProblems(dir: string): string[] {
  const out: string[] = [];
  out.push(...validateManifest(readJson(join(dir, 'manifest.json'))).map((p) => `manifest.json ${p}`));
  readJsonl(join(dir, 'events.jsonl')).forEach((e, i) => out.push(...validateEventLine(e).map((p) => `events.jsonl:${i + 1} ${p}`)));
  readJsonl(join(dir, 'stamps.jsonl')).forEach((e, i) => out.push(...validateStampLine(e).map((p) => `stamps.jsonl:${i + 1} ${p}`)));
  // the mock tap writes samples.jsonl lines of the same form as the real tap (spec 8.1)
  readJsonl(join(dir, 'samples.jsonl')).forEach((e, i) => out.push(...validateSampleLine(e).map((p) => `samples.jsonl:${i + 1} ${p}`)));
  // only record kinds with a step order have a ledger (spec 8.5)
  if (existsSync(join(dir, 'ledger.jsonl'))) {
    out.push(...verifyLedgerText(readFileSync(join(dir, 'ledger.jsonl'), 'utf8'), sha256Text).errors);
  }
  return out;
}

describe('host recording with the mock tap', () => {
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

  /** A gate run whose page loaded as Chrome loads it: GET /, GET /api/config, then the worker's socket. */
  async function begin(env: Record<string, string> = {}): Promise<{ h: HostRun; w: FakeWorker; cfg: HostConfig; dir: string }> {
    const h = await startHost(sb, ['--mode', 'gate', '--pack', 'A', '--tap', 'mock'], env);
    host = h;
    expect(await h.loadPage()).toBe(200);
    const cfg = await h.config();
    const w = await FakeWorker.open(cfg.sessionUrl, h.origin);
    w.hello();
    return { h, w, cfg, dir: join(sb.sessions, cfg.sessionId) };
  }

  it('sends start to tap only after the consent frame', async () => {
    const log = join(sb.dir, 'mock-ipc.jsonl');
    const { h, w } = await begin({ COPYHOLDER_MOCK_LOG: log });
    const cfg = await h.config();
    const tap = new WebSocket(cfg.tapUrl ?? '', { headers: { Origin: h.origin } });
    const tapLines: string[] = [];
    tap.on('message', (d) => tapLines.push(d.toString()));
    await new Promise((resolve, reject) => {
      tap.once('open', resolve);
      tap.once('error', reject);
    });
    const ipc = () => readJsonl(log).map((r) => (r.msg as { t: string }).t);
    await waitUntil(() => ipc().includes('config'));
    // page traffic before consent must not start the SDK
    w.block(0);
    w.send({ t: 'event', line: { n: 0, e: 'resize' } });
    await sleep(1200);
    expect(ipc()).toEqual(['config']);
    expect(tapLines).toEqual([]);
    w.send({ t: 'consent', at: 12345 });
    await waitUntil(() => ipc().includes('start'));
    expect(ipc().slice(0, 2)).toEqual(['config', 'start']);
    await w.waitMessage((m) => m.t === 'tap' && m.status === 'running');
    await waitUntil(() => tapLines.some((l) => JSON.parse(l).k === 'm'));
    const first = JSON.parse(tapLines.find((l) => JSON.parse(l).k === 'm') ?? '{}');
    expect(first).toMatchObject({ k: 'm' });
    expect(typeof first.tArrNs).toBe('string');
    expect(first.lm.p).toHaveLength(16);
    tap.close();
    w.send({ t: 'end', reason: 'done' });
    expect(await h.exited).toBe(0);
    // the block from before consent was dropped, the event line kept
    const dir = join(sb.sessions, cfg.sessionId);
    expect(readJsonl(join(dir, 'events.jsonl')).some((e) => e.e === 'resize')).toBe(true);
    const manifest = readJson(join(dir, 'manifest.json'));
    expect((manifest.audio as Record<string, unknown>).dropped_before_consent).toBe(1);
    expect(manifest.consent_utc).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/);
  });

  it('finds a skipped audio block (n0 gap) and marks the audio unusable', async () => {
    const { h, w, dir } = await begin();
    w.send({ t: 'consent', at: 1 });
    w.block(0);
    w.block(9600);
    w.block(28800); // the block at 19200 never came
    w.block(38400);
    await waitUntil(() => readJsonl(join(dir, 'stamps.jsonl')).length === 4);
    w.send({ t: 'end', reason: 'done' });
    expect(await h.exited).toBe(0);
    // n is the sample after the last stored block, as on every host line (docs/protocol.md)
    const gaps = readJsonl(join(dir, 'events.jsonl')).filter((e) => e.e === 'audio_gap');
    expect(gaps).toEqual([{ n: 19200, e: 'audio_gap', by: 'host', expected: 19200, got: 28800, missing: 9600 }]);
    const chunks = readJsonl(join(dir, 'stamps.jsonl')).filter((s) => s.k === 'chunk');
    expect(chunks.map((c) => c.n)).toEqual([0, 9600, 28800, 38400]);
    expect(chunks.every((c) => c.frames === 9600)).toBe(true);
    const m = readJson(join(dir, 'manifest.json'));
    expect(m.unusable).toBe(true);
    expect(m.unusable_reasons).toEqual(['audio_gap']);
    expect(m.audio).toMatchObject({ contiguous: false, gaps: 1, blocks: 4, frames: 4 * 9600, first_n0: 0 });
    expect(schemaProblems(dir)).toEqual([]);
  });

  it('keeps contiguous audio usable', async () => {
    const { h, w, dir } = await begin();
    w.send({ t: 'consent', at: 1 });
    for (let k = 0; k < 3; k++) w.block(4800 + k * 9600);
    w.send({ t: 'end', reason: 'done' });
    expect(await h.exited).toBe(0);
    const m = readJson(join(dir, 'manifest.json'));
    expect(m.unusable).toBe(false);
    expect(m.audio).toMatchObject({ contiguous: true, gaps: 0, first_n0: 4800, mic_flags_off: true, sample_rate: 48000 });
    expect(readJsonl(join(dir, 'events.jsonl')).some((e) => e.e === 'audio_gap')).toBe(false);
  });

  it('a reload before consent is no problem: the newest page records (spec 12.2)', async () => {
    const { h, w, cfg, dir } = await begin();
    expect(await h.loadPage()).toBe(200);
    await h.config();
    const again = await FakeWorker.open(cfg.sessionUrl, h.origin);
    again.hello();
    expect(await w.closed).toBe(4000); // the first page's socket is replaced
    again.send({ t: 'consent', at: 1 });
    again.block(0);
    again.send({ t: 'end', reason: 'done' });
    expect(await h.exited).toBe(0);
    expect(readJson(join(dir, 'manifest.json'))).toMatchObject({ unusable: false, unusable_reasons: [], page_loads: 2 });
    expect(readJsonl(join(dir, 'events.jsonl')).some((e) => e.e === 'page_reload')).toBe(false);
  });

  it('a page reload during the recording marks the session unusable: the reloaded page asks for / again (spec 7.2, 7.3)', async () => {
    const { h, w, dir } = await begin();
    w.send({ t: 'consent', at: 1 });
    w.block(0);
    w.block(9600);
    await waitUntil(() => readJsonl(join(dir, 'stamps.jsonl')).length === 2);
    await w.close(); // the old page goes away ...
    expect(await h.loadPage()).toBe(200); // ... and the reloaded page loads; its worker connects only after a new consent
    expect(await h.exited).toBe(0);
    const events = readJsonl(join(dir, 'events.jsonl'));
    expect(events.filter((e) => e.e === 'page_reload')).toEqual([{ n: 19200, e: 'page_reload', by: 'host', page_loads: 2, via: '/' }]);
    expect(events.some((e) => e.e === 'page_lost')).toBe(false);
    const m = readJson(join(dir, 'manifest.json'));
    expect(m.unusable).toBe(true);
    expect(m.unusable_reasons).toEqual(['page_reload']);
    expect(m.end).toEqual({ reason: 'page_reload', by: 'host' });
    expect(m.page_loads).toBe(2);
    expect(m.state).toBe('closed');
    expect(schemaProblems(dir)).toEqual([]);
  });

  it('a page load while the recording page is still open ends the recording; that page still sends its last frames', async () => {
    const { h, w, dir } = await begin();
    w.send({ t: 'consent', at: 1 });
    w.block(0);
    await waitUntil(() => readJsonl(join(dir, 'stamps.jsonl')).length === 1);
    await h.config(); // only a loading page asks for its configuration
    const abort = await w.waitMessage((m) => m.t === 'abort');
    expect(abort.reason).toBe('page_reload');
    w.block(9600);
    w.send({ t: 'end', reason: 'abort' });
    expect(await h.exited).toBe(0);
    expect(w.messages.find((m) => m.t === 'saved')).toEqual({ t: 'saved', sessionId: 'gate-a', unusable: true, reasons: ['page_reload'] });
    expect(w.messages.at(-1)).toEqual({ t: 'quickcheck', ok: null, text: null });
    const reload = readJsonl(join(dir, 'events.jsonl')).filter((e) => e.e === 'page_reload');
    expect(reload).toEqual([{ n: 9600, e: 'page_reload', by: 'host', page_loads: 1, via: '/api/config' }]);
    expect(readJson(join(dir, 'manifest.json')).audio).toMatchObject({ blocks: 2, contiguous: true });
  });

  it('a second /session socket during the recording counts as a reload; it gets recording_closed', async () => {
    const { h, w, cfg, dir } = await begin();
    w.send({ t: 'consent', at: 1 });
    w.block(0);
    await waitUntil(() => readJsonl(join(dir, 'stamps.jsonl')).length === 1);
    const other = await FakeWorker.open(cfg.sessionUrl, h.origin);
    await other.waitMessage((m) => m.t === 'abort' && m.reason === 'recording_closed');
    expect(await other.closed).toBe(4001);
    await w.waitMessage((m) => m.t === 'abort' && m.reason === 'page_reload');
    w.send({ t: 'end', reason: 'abort' });
    expect(await h.exited).toBe(0);
    expect(w.messages.find((m) => m.t === 'saved')).toMatchObject({ unusable: true, reasons: ['page_reload'] });
    expect(other.messages).toEqual([{ t: 'abort', reason: 'recording_closed' }]);
    expect(readJsonl(join(dir, 'events.jsonl')).filter((e) => e.e === 'page_reload')).toMatchObject([{ via: '/session', page_loads: 1 }]);
  });

  it('after an abort the recording page keeps its socket; a newer one is refused with recording_closed', async () => {
    const { h, w, cfg, dir } = await begin({ COPYHOLDER_MOCK_SCRIPT: JSON.stringify({ errorAtMs: 600 }) });
    w.send({ t: 'consent', at: 1 });
    w.block(0);
    expect((await w.waitMessage((m) => m.t === 'abort')).reason).toBe('sdk_error');
    // another page connects while host waits for the recording page's last frames (spec 7.2)
    const other = await FakeWorker.open(cfg.sessionUrl, h.origin);
    other.hello();
    await other.waitMessage((m) => m.t === 'abort' && m.reason === 'recording_closed');
    expect(await other.closed).toBe(4001);
    w.block(9600);
    w.block(19200);
    w.send({ t: 'end', reason: 'abort' });
    expect(await h.exited).toBe(0);
    expect(w.messages.filter((m) => m.t === 'saved')).toEqual([{ t: 'saved', sessionId: 'gate-a', unusable: true, reasons: ['sdk_error'] }]);
    expect(w.messages.at(-1)).toEqual({ t: 'quickcheck', ok: null, text: null });
    expect(other.messages).toEqual([{ t: 'abort', reason: 'recording_closed' }]);
    const m = readJson(join(dir, 'manifest.json'));
    expect(m.audio).toMatchObject({ blocks: 3, contiguous: true });
    expect(m.unusable_reasons).toEqual(['sdk_error']);
    expect(m.page_loads).toBe(1);
  });

  it('a page that closes and never returns ends the recording as page_lost', async () => {
    const { h, w, dir } = await begin();
    w.send({ t: 'consent', at: 1 });
    w.block(0);
    await waitUntil(() => readJsonl(join(dir, 'stamps.jsonl')).length === 1);
    await w.close();
    expect(await h.exited).toBe(0);
    const m = readJson(join(dir, 'manifest.json'));
    expect(m.unusable_reasons).toContain('page_lost');
    expect(readJsonl(join(dir, 'events.jsonl')).some((e) => e.e === 'page_lost')).toBe(true);
  }, 20_000);

  it('tap_lost after the SDK goes quiet for 3 s while Running', async () => {
    const { h, w, dir } = await begin({ COPYHOLDER_MOCK_SCRIPT: JSON.stringify({ stallAfterMs: 600 }) });
    w.send({ t: 'consent', at: 1 });
    w.block(0);
    await w.waitMessage((m) => m.t === 'tap' && m.status === 'running');
    const abort = await w.waitMessage((m) => m.t === 'abort', 12_000);
    expect(abort.reason).toBe('tap_lost');
    w.block(9600); // the page may still flush audio before it ends
    w.send({ t: 'end', reason: 'abort' });
    expect(await h.exited).toBe(0);
    const lost = readJsonl(join(dir, 'events.jsonl')).filter((e) => e.e === 'tap_lost');
    expect(lost).toHaveLength(1);
    expect(lost[0]).toMatchObject({ by: 'host', why: 'silence' });
    expect(Number(lost[0]?.silent_ms)).toBeGreaterThan(3000);
    expect(w.messages.find((m) => m.t === 'saved')).toEqual({ t: 'saved', sessionId: 'gate-a', unusable: true, reasons: ['tap_lost'] });
    const m = readJson(join(dir, 'manifest.json'));
    expect(m.unusable_reasons).toEqual(['tap_lost']);
    expect(m.end).toEqual({ reason: 'tap_lost', by: 'host' });
    expect(m.audio).toMatchObject({ blocks: 2 }); // files are kept, late audio included
    expect(readdirSync(dir)).toEqual(expect.arrayContaining(['samples.jsonl', 'audio.wav', 'ledger.jsonl']));
    expect(schemaProblems(dir)).toEqual([]);
  }, 25_000);

  it('tap_lost comes 3 s after the last SDK packet, not after the pulse that reported it (spec 7.2)', async () => {
    const { h, w, cfg, dir } = await begin({ COPYHOLDER_MOCK_SCRIPT: JSON.stringify({ stallAfterMs: 1200 }) });
    const tap = await TapClient.open(cfg.tapUrl ?? '', h.origin);
    w.send({ t: 'consent', at: 1 });
    const abort = await w.waitMessage((m) => m.t === 'abort', 12_000);
    expect(abort.reason).toBe('tap_lost');
    const abortAt = w.arrivals[w.messages.indexOf(abort)] ?? Number.NaN;
    const packets = tap.of('m');
    expect(packets.length).toBeGreaterThan(10);
    const gap = abortAt - (packets.at(-1)?.at ?? Number.NaN);
    // packets stop at 1.2 s; the pulse that reports the last one comes at 2 s, 0.8 s later
    expect(gap).toBeGreaterThanOrEqual(2900);
    expect(gap).toBeLessThan(3450);
    tap.close();
    w.send({ t: 'end', reason: 'abort' });
    expect(await h.exited).toBe(0);
    const lost = readJsonl(join(dir, 'events.jsonl')).filter((e) => e.e === 'tap_lost');
    expect(lost).toHaveLength(1);
    expect(lost[0]).toMatchObject({ by: 'host', why: 'silence' });
    expect(lost[0]?.status).toBeUndefined(); // the SDK was still Running, only quiet
    const silent = Number(lost[0]?.silent_ms);
    // host fires once the silence exceeds 3000 ms and rounds it, so 3000.4 ms is written as 3000
    expect(silent).toBeGreaterThanOrEqual(3000);
    expect(Math.abs(silent - gap)).toBeLessThan(250);
  }, 20_000);

  it('tap_lost when the SDK leaves Running by itself, without an error (spec 7.2)', async () => {
    const { h, w, dir } = await begin({ COPYHOLDER_MOCK_SCRIPT: JSON.stringify({ idleAfterMs: 1200 }) });
    w.send({ t: 'consent', at: 1 });
    w.block(0);
    await w.waitMessage((m) => m.t === 'tap' && m.status === 'running');
    const abort = await w.waitMessage((m) => m.t === 'abort', 12_000);
    expect(abort.reason).toBe('tap_lost');
    w.send({ t: 'end', reason: 'abort' });
    expect(await h.exited).toBe(0);
    expect(h.out()).toContain('The camera stopped running (kIdle).');
    const lost = readJsonl(join(dir, 'events.jsonl')).filter((e) => e.e === 'tap_lost');
    expect(lost).toHaveLength(1);
    expect(lost[0]).toMatchObject({ by: 'host', why: 'silence', status: 'kIdle' });
    expect(Number(lost[0]?.silent_ms)).toBeGreaterThan(3000);
    const m = readJson(join(dir, 'manifest.json'));
    expect(m.unusable_reasons).toEqual(['tap_lost']);
    expect(m.end).toEqual({ reason: 'tap_lost', by: 'host' });
    expect(schemaProblems(dir)).toEqual([]);
  }, 20_000);

  it('the one SDK restart after code 8 is no lost tap, even when Running comes back more than 3 s later (spec 7.1)', async () => {
    // Running at 0.3 s, code 8 at 0.6 s before any packet, kError, Running again at 3.9 s, packets from 4.9 s
    const script = { errorAtMs: 600, errorCode: 8, restartMs: 3000, firstPacketAfterMs: 1000 };
    const { h, w, dir } = await begin({ COPYHOLDER_MOCK_SCRIPT: JSON.stringify(script) });
    w.send({ t: 'consent', at: 1 });
    w.block(0);
    await waitUntil(() => readJsonl(join(dir, 'samples.jsonl')).some((l) => l.k === 'm'), 12_000);
    await sleep(300);
    expect(w.messages.some((m) => m.t === 'abort')).toBe(false);
    w.block(9600);
    w.send({ t: 'end', reason: 'done' });
    expect(await h.exited).toBe(0);
    const events = readJsonl(join(dir, 'events.jsonl'));
    expect(events.find((e) => e.e === 'sdk_error')).toMatchObject({ by: 'host', code: 8, action: 'reset_restart' });
    expect(events.some((e) => e.e === 'tap_lost')).toBe(false);
    const statuses = readJsonl(join(dir, 'samples.jsonl')).filter((l) => l.k === 's').map((l) => l.name);
    expect(statuses.slice(0, 5)).toEqual(['kStarting', 'kRunning', 'kError', 'kStarting', 'kRunning']);
    expect(readJson(join(dir, 'manifest.json'))).toMatchObject({ unusable: false, unusable_reasons: [] });
  }, 25_000);

  it('tap_lost when the tap process exits during the recording', async () => {
    const { h, w, dir } = await begin({ COPYHOLDER_MOCK_SCRIPT: JSON.stringify({ exitAfterMs: 900 }) });
    w.send({ t: 'consent', at: 1 });
    const abort = await w.waitMessage((m) => m.t === 'abort');
    expect(abort.reason).toBe('tap_lost');
    w.send({ t: 'end', reason: 'abort' });
    expect(await h.exited).toBe(0);
    const lost = readJsonl(join(dir, 'events.jsonl')).find((e) => e.e === 'tap_lost');
    expect(lost).toMatchObject({ why: 'exit', code: 1 });
  });

  it('an SDK error aborts the recording and keeps the files', async () => {
    const { h, w, dir } = await begin({ COPYHOLDER_MOCK_SCRIPT: JSON.stringify({ errorAtMs: 900, errorCode: 4 }) });
    w.send({ t: 'consent', at: 1 });
    w.block(0);
    const abort = await w.waitMessage((m) => m.t === 'abort');
    expect(abort.reason).toBe('sdk_error');
    w.send({ t: 'end', reason: 'abort' });
    expect(await h.exited).toBe(0);
    expect(h.out()).toContain('The SDK credits are used up (kCreditExhausted).');
    const err = readJsonl(join(dir, 'events.jsonl')).find((e) => e.e === 'sdk_error');
    expect(err).toMatchObject({ by: 'host', code: 4, name: 'kCreditExhausted' });
    const m = readJson(join(dir, 'manifest.json'));
    expect(m.unusable_reasons).toEqual(['sdk_error']);
    const samples = readJsonl(join(dir, 'samples.jsonl'));
    expect(samples.some((s) => s.k === 'e' && s.code === 4)).toBe(true);
    expect(schemaProblems(dir)).toEqual([]);
  });

  it('writes manifest hashes that match the files, and the ledger step record', async () => {
    const { h, w, dir } = await begin();
    w.send({ t: 'consent', at: 1 });
    await w.waitMessage((m) => m.t === 'tap' && m.status === 'running');
    w.block(0);
    w.block(9600);
    w.send({ t: 'stamp', line: { n: 9000, k: 'arr', seq: 5 } });
    w.send({ t: 'det', line: '{"k":"batch","seq":5,"tr":[[1794935111123456,-0.4000000059604645]],"talk":[[1794935111123456,0]],"g":0.031746031746031744,"hm":0.0021}' });
    w.send({ t: 'event', line: { n: 9000, e: 'armed', det: 'D1', on: true } });
    w.send({ t: 'end', reason: 'done' });
    expect(await h.exited).toBe(0);
    expect(h.out()).toContain('Saved to');
    // only the frames of docs/protocol.md go to the worker: tap lifecycle, then saved and the quickcheck
    // verdict (null here: quickcheck is off in the sandbox), then host closes the socket
    const types = w.messages.map((m) => m.t);
    expect(types.every((t) => t === 'tap' || t === 'saved' || t === 'quickcheck')).toBe(true);
    expect(w.messages.slice(-2)).toEqual([
      { t: 'saved', sessionId: 'gate-a', unusable: false, reasons: [] },
      { t: 'quickcheck', ok: null, text: null },
    ]);
    expect(w.ws.readyState).toBe(WebSocket.CLOSED);

    // detector values are written exactly as sent (spec 8.1)
    expect(readFileSync(join(dir, 'detector_in.jsonl'), 'utf8')).toBe(
      '{"k":"batch","seq":5,"tr":[[1794935111123456,-0.4000000059604645]],"talk":[[1794935111123456,0]],"g":0.031746031746031744,"hm":0.0021}\n',
    );
    const m = readJson(join(dir, 'manifest.json'));
    expect(m).toMatchObject({
      schema: 'session/1', id: 'gate-a', kind: 'gate', mode: 'gate', scenario: 'gate-A', pack: 'A', tap: 'mock', state: 'closed',
      sdk: null, unusable: false, unusable_reasons: [], end: { reason: 'done', by: 'page' }, browser: 'vitest', page_loads: 1,
      plan_commitment: null, tap_killed: false,
    });
    expect(m.started_utc).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/);
    expect(typeof m.machine).toBe('string');
    expect(m.camera).toEqual({ name: 'Mock camera (no SDK)', requested: [1280, 720, 30] });
    expect(m.audio).toMatchObject({
      microphone: 'Test headset microphone', output: 'Test headset', mic_flags_off: true, sample_rate: 48000, output_gain: null,
    });
    expect((m.audio as { settings: Record<string, unknown> }).settings).toMatchObject({ echoCancellation: false, channelCount: 1 });
    expect(m.narrator).toEqual({ names: ['cues.json', 'listen.timings.json', 'listen.wav', 'pack.json'], sealed_served: [], first_sealed_n: null });
    const files = m.files as Record<string, string>;
    expect(Object.keys(files).sort()).toEqual(['audio.wav', 'detector_in.jsonl', 'events.jsonl', 'samples.jsonl', 'stamps.jsonl']);
    for (const [name, value] of Object.entries(files)) expect(value).toBe(`sha256:${sha256(join(dir, name))}`);
    // app commit and clean-tree flag come from git (null outside a checkout)
    expect(m.app_commit === null || /^[0-9a-f]{7,40}$/.test(String(m.app_commit))).toBe(true);
    expect(m.tree_clean === null || typeof m.tree_clean === 'boolean').toBe(true);
    // host's own event lines: consent, then tap status, all by:"host"
    const hostEvents = readJsonl(join(dir, 'events.jsonl')).filter((e) => e.by === 'host');
    expect(hostEvents[0]).toMatchObject({ e: 'consent', at: 1 });
    expect(hostEvents.filter((e) => e.e === 'tap').map((e) => e.status)).toEqual(['starting', 'running', 'stopped']);
    expect(schemaProblems(dir)).toEqual([]);

    // ledger.jsonl: one `record` line in the spec's format (spec 8.5)
    const text = readFileSync(join(dir, 'ledger.jsonl'), 'utf8');
    const check = ledger.verifyLedgerText(text);
    expect(check.ok).toBe(true);
    expect(check.lines).toHaveLength(1);
    const line = check.lines[0] ?? '';
    expect(line).toMatch(
      /^\{"i":0,"step":"record","utc":"\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ","commit":("[0-9a-f]{7,}"|null),"out_sha256":\{.*\},"exploratory":false,"prev":"0{64}"\}$/,
    );
    const row = JSON.parse(line) as { out_sha256: Record<string, string>; commit: string | null };
    expect(row.commit).toBe(m.app_commit);
    expect(row.out_sha256['manifest.json']).toBe(sha256(join(dir, 'manifest.json')));
    for (const name of Object.keys(files)) expect(row.out_sha256[name]).toBe(sha256(join(dir, name)));

    // the WAV header is valid after a clean close
    const info = wav.readWavInfo(join(dir, 'audio.wav'));
    expect(wav.isConsistentWav(info)).toBe(true);
    expect(info).toMatchObject({ formatTag: 3, channels: 2, sampleRate: 48000, bitsPerSample: 32, blockAlign: 8, dataOffset: 44 });
    expect(info.dataBytes).toBe(2 * 9600 * 8);
    const bytes = readFileSync(join(dir, 'audio.wav'));
    expect(bytes.readFloatLE(44)).toBe(0.25); // ch0 microphone
    expect(bytes.readFloatLE(48)).toBe(-0.5); // ch1 Deck output
  });

  it('kills a tap that does not stop within its budget, and records that (spec 7.2)', async () => {
    const { h, w, dir } = await begin({
      COPYHOLDER_TAP_STOP_BUDGET_MS: '800',
      COPYHOLDER_MOCK_SCRIPT: JSON.stringify({ stopHangMs: 10_000 }),
    });
    w.send({ t: 'consent', at: 1 });
    await w.waitMessage((m) => m.t === 'tap' && m.status === 'running');
    w.block(0);
    const asked = performance.now();
    w.send({ t: 'end', reason: 'done' });
    expect(await h.exited).toBe(0);
    expect(performance.now() - asked).toBeLessThan(8000); // host did not wait out the 10 s hang
    expect(h.out()).toContain('The camera process did not stop in time; ending it.');
    const events = readJsonl(join(dir, 'events.jsonl'));
    expect(events.filter((e) => e.e === 'tap_killed')).toEqual([{ n: 9600, e: 'tap_killed', by: 'host', after_ms: 800 }]);
    expect(events.filter((e) => e.e === 'tap').map((e) => e.status)).toEqual(['starting', 'running', 'stopped']);
    const m = readJson(join(dir, 'manifest.json'));
    expect(m).toMatchObject({ tap_killed: true, unusable: false, state: 'closed', end: { reason: 'done', by: 'page' } });
    expect(Object.keys(m.files as object)).toContain('samples.jsonl');
    expect(schemaProblems(dir)).toEqual([]);
  }, 20_000);

  it('leaves a WAV that a reader can repair from the file size after a crash', async () => {
    const { h, w, dir } = await begin();
    w.send({ t: 'consent', at: 1 });
    for (let k = 0; k < 3; k++) w.block(k * 9600);
    await waitUntil(() => readJsonl(join(dir, 'stamps.jsonl')).filter((s) => s.k === 'chunk').length === 3);
    h.kill('SIGKILL'); // host dies mid-recording: no clean close
    await h.exited;
    const file = join(dir, 'audio.wav');
    const before = wav.readWavInfo(file);
    expect(before.placeholder).toBe(true);
    expect(before.presentBytes).toBe(3 * 9600 * 8);
    expect(wav.isConsistentWav(before)).toBe(false);
    const { spawnSync } = await import('node:child_process');
    const fix = spawnSync(process.execPath, [join(import.meta.dirname, '..', '..', 'live', 'lib', 'wav.cjs'), 'repair', file], { encoding: 'utf8' });
    expect(fix.stdout).toContain(`repaired: ${3 * 9600} frames`);
    const after = wav.readWavInfo(file);
    expect(wav.isConsistentWav(after)).toBe(true);
    expect(after.dataBytes).toBe(3 * 9600 * 8);
    expect(after.riffBytes).toBe(after.fileBytes - 8);
    // the manifest written at consent says the recording never closed
    expect(readJson(join(dir, 'manifest.json')).state).toBe('recording');
  });

  it('stopping before consent records nothing and leaves no folder', async () => {
    const { h, w } = await begin();
    const cfg = await h.config();
    w.send({ t: 'end', reason: 'cancel' });
    expect(await h.exited).toBe(0);
    expect(readdirSync(sb.sessions)).not.toContain(cfg.sessionId);
  });

  it('an SDK processing error before the first packet restarts once and does not abort (spec 7.1)', async () => {
    const { h, w, dir } = await begin({ COPYHOLDER_MOCK_SCRIPT: JSON.stringify({ errorAtMs: 50, errorCode: 8, startDelayMs: 400 }) });
    w.send({ t: 'consent', at: 1 });
    w.block(0);
    await w.waitMessage((m) => m.t === 'tap' && m.status === 'running');
    await sleep(1500);
    expect(w.messages.some((m) => m.t === 'abort')).toBe(false);
    w.block(9600);
    w.send({ t: 'end', reason: 'done' });
    expect(await h.exited).toBe(0);
    const err = readJsonl(join(dir, 'events.jsonl')).find((e) => e.e === 'sdk_error');
    expect(err).toMatchObject({ by: 'host', code: 8, name: 'kProcessingFailed', action: 'reset_restart' });
    expect(readJson(join(dir, 'manifest.json')).unusable).toBe(false);
    expect(readJsonl(join(dir, 'samples.jsonl')).some((l) => l.k === 'm')).toBe(true);
  });

  it('prints the camera names and stops when tap could not pick a camera', async () => {
    const h = await startHost(sb, ['--mode', 'gate', '--pack', 'A', '--tap', 'mock'], {
      COPYHOLDER_MOCK_SCRIPT: JSON.stringify({ camerasAndExit: true }),
    });
    host = h;
    expect(await h.exited).toBe(1);
    expect(h.out()).toContain('Cameras found: "Mock camera A", "Mock camera B".');
    expect(h.out()).toContain('COPYHOLDER_CAMERA_NAME');
    expect(readdirSync(sb.sessions)).toEqual([]);
  });

  it('doctor runs without tap, uses the mic consent and keeps the chosen level in calib.json (spec 7.7, 7.12)', async () => {
    writeFileSync(join(sb.sample, 'level.wav'), 'RIFF-level');
    const h = await startHost(sb, ['--mode', 'doctor', '--tap', 'mock']);
    host = h;
    const cfg = (await h.config()) as unknown as Record<string, unknown>;
    expect(cfg).toMatchObject({ mode: 'doctor', scenario: 'doctor', tapUrl: null, consentText: 'mic', narrator: ['level.wav'], calib: null });
    expect(cfg.sessionId).toBe('doctor-1');
    const w = await FakeWorker.open(String(cfg.sessionUrl), h.origin);
    w.hello();
    w.send({ t: 'consent', at: '2026-11-12T20:00:00.000Z' });
    w.block(0);
    w.send({ t: 'event', line: { n: 4800, e: 'gain', hard: false, value: 0.5, db: -6, final: false } });
    w.send({ t: 'event', line: { n: 9000, e: 'gain', hard: false, value: 0.35, db: -9.1, final: true } });
    w.send({ t: 'end', reason: 'done' });
    expect(await h.exited).toBe(0);
    const dir = join(sb.sessions, 'doctor-1');
    expect(readJson(join(dir, 'calib.json'))).toEqual({ schema: 'calib/1', output_gain: 0.35 });
    expect(validateCalib(readJson(join(dir, 'calib.json')))).toEqual([]);
    const m = readJson(join(dir, 'manifest.json'));
    expect(m).toMatchObject({ kind: 'doctor', tap: null, sdk: null, camera: null, pack: null });
    expect((m.audio as Record<string, unknown>).output_gain).toBe(0.35);
    expect(Object.keys(m.files as object)).toContain('calib.json');
    expect(readdirSync(dir)).not.toContain('samples.jsonl');
    expect(readdirSync(dir)).not.toContain('ledger.jsonl'); // doctor has no step order in spec 8.5
    expect(schemaProblems(dir)).toEqual([]);

    // the next recording gets that level and the frozen detector setup through /api/config
    const params = join(sb.dir, 'frozen.json');
    writeFileSync(params, JSON.stringify({ d1: { k: 2.5 } }));
    const next = await startHost(sb, ['--mode', 'gate', '--pack', 'A', '--tap', 'mock'], { COPYHOLDER_PARAMS_FILE: params });
    host = next;
    const cfg2 = (await next.config()) as unknown as Record<string, unknown>;
    expect(cfg2.calib).toEqual({ schema: 'calib/1', output_gain: 0.35 });
    expect(cfg2.detector).toEqual({ params: { d1: { k: 2.5 } }, sign: 1, variant: 'D1' });
    expect(cfg2.facePreview).toBeUndefined();
  });
});
