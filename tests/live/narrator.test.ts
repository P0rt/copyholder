// Spec 7.2 / 8.2: narrator files go through one read function with one allow list; sealed audio
// is decrypted in memory and only after preflight_ok; plan, texts and the rest are never served.
// Spec 10.4: a plan's text is spent at its first sealed sound, not when its files are fetched.
import { createHash, randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  FakeWorker, makeSandbox, readJson, requireCjs, startHost, waitUntil, type HostConfig, type HostRun, type Sandbox,
} from './helpers.ts';

type Source = { kind: string };
interface ReadResult {
  status: number;
  error: string | null;
  contentType: string | null;
  body: Buffer | NodeJS.ReadableStream | null;
  length: number;
}
const narrator = requireCjs('../../live/lib/narrator.cjs') as {
  NARRATOR_ALLOW: {
    gate: readonly string[];
    sealed: Record<string, string>;
    sample: readonly string[];
    doctor: readonly string[];
    replay: readonly string[];
  };
  gateSource(dir: string): Source;
  sealedSource(dir: string, key: Buffer): Source;
  sampleSource(dir: string): Source;
  doctorSource(dir: string): Source;
  noSource(): Source;
  readNarrator(source: Source, name: string, opts?: { preflightOk?: boolean }): Promise<ReadResult>;
  holdsSealedAudio(source: Source): boolean;
  replaySource(audioFile: string, inner?: Source): Source;
  narratorNames(source: Source): string[];
  packListing(pack: unknown): Map<string, string | null>;
  sealBytes(plain: Buffer, key: Buffer): Buffer;
  openSealed(buf: Buffer, key: Buffer): Buffer;
  parseSealKey(text: string): Buffer;
};

const OUTSIDE = [
  'plan.json', 'plan.json.enc', 'texts.json', 'texts.json.enc', 'score.json.enc', 'planter.log.enc', 'commitment.txt',
  'audio/p1.wav.enc', 'p1.wav.enc', 'P1.WAV', 'p4.wav', '../p1.wav', '..', '', '/etc/passwd', 'notes.txt',
  '__proto__', 'constructor', 'toString', 'hasOwnProperty', 'pack.json/../notes.txt',
];

function makePlan(root: string, key: Buffer): Record<string, Buffer> {
  const dir = join(root, 'pilot');
  mkdirSync(join(dir, 'audio'), { recursive: true });
  const plain: Record<string, Buffer> = {
    'opening.wav': Buffer.from('RIFF-opening'),
    'p1.wav': Buffer.from('RIFF-p1'),
    'timings.json': Buffer.from('{"words":[[0,120,0]]}'),
  };
  writeFileSync(join(dir, 'audio', 'opening.wav.enc'), narrator.sealBytes(plain['opening.wav'] ?? Buffer.alloc(0), key));
  writeFileSync(join(dir, 'audio', 'p1.wav.enc'), narrator.sealBytes(plain['p1.wav'] ?? Buffer.alloc(0), key));
  writeFileSync(join(dir, 'timings.json.enc'), narrator.sealBytes(plain['timings.json'] ?? Buffer.alloc(0), key));
  for (const secret of ['plan.json.enc', 'texts.json.enc', 'score.json.enc', 'planter.log.enc']) {
    writeFileSync(join(dir, secret), narrator.sealBytes(Buffer.from(`{"secret":"${secret}"}`), key));
  }
  writeFileSync(join(dir, 'commitment.txt'), `${'ab'.repeat(32)}\n`);
  return plain;
}

describe('narrator read function (unit)', () => {
  let dir: string;
  const key = randomBytes(32);

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'copyholder-narrator-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('serves only gate files that are on the list and in pack.json', async () => {
    const pack = join(dir, 'pack-A');
    mkdirSync(pack);
    const listen = Buffer.from('RIFF-listen');
    writeFileSync(join(pack, 'pack.json'), JSON.stringify({
      files: { 'listen.wav': { sha256: createHash('sha256').update(listen).digest('hex') }, 'cues.json': {} },
    }));
    writeFileSync(join(pack, 'listen.wav'), listen);
    writeFileSync(join(pack, 'cues.json'), '[]');
    writeFileSync(join(pack, 'objections.wav'), 'allowed name, but pack.json does not list it');
    writeFileSync(join(pack, 'notes.txt'), 'never');
    const src = narrator.gateSource(pack);
    expect(narrator.narratorNames(src)).toEqual(['cues.json', 'listen.wav', 'pack.json']);
    const ok = await narrator.readNarrator(src, 'listen.wav');
    expect(ok.status).toBe(200);
    expect(ok.contentType).toBe('audio/wav');
    expect(ok.body).toEqual(listen);
    expect((await narrator.readNarrator(src, 'pack.json')).status).toBe(200);
    expect((await narrator.readNarrator(src, 'objections.wav')).status).toBe(404);
    for (const name of OUTSIDE) expect((await narrator.readNarrator(src, name)).status, name).toBe(404);
    // a file that does not match its pack.json hash is refused
    writeFileSync(join(pack, 'listen.wav'), 'tampered');
    expect((await narrator.readNarrator(src, 'listen.wav')).status).toBe(500);
  });

  it('reads pack.json listings in several shapes', () => {
    const h = 'c'.repeat(64);
    const a = narrator.packListing({ files: ['listen.wav', 'notes.txt'] });
    expect([...a.keys()].sort()).toEqual(['listen.wav', 'pack.json']);
    const b = narrator.packListing({ files: { 'objections.wav': `sha256:${h}` } });
    expect(b.get('objections.wav')).toBe(h);
    const c = narrator.packListing({ blocks: [{ name: 'listen.timings.json', sha256: h }, { file: 'cues.json' }] });
    expect(c.get('listen.timings.json')).toBe(h);
    expect(c.has('cues.json')).toBe(true);
  });

  it('serves sealed audio and timings only, decrypted, and only after preflight_ok', async () => {
    const plain = makePlan(dir, key);
    const src = narrator.sealedSource(join(dir, 'pilot'), key);
    expect(narrator.narratorNames(src)).toEqual(['opening.wav', 'p1.wav', 'timings.json']);
    const locked = await narrator.readNarrator(src, 'opening.wav');
    expect(locked.status).toBe(409);
    expect(locked.body).toBeNull();
    for (const [name, bytes] of Object.entries(plain)) {
      const r = await narrator.readNarrator(src, name, { preflightOk: true });
      expect(r.status, name).toBe(200);
      expect(r.body).toEqual(bytes);
    }
    expect((await narrator.readNarrator(src, 'p2.wav', { preflightOk: true })).status).toBe(404); // allowed, missing
    for (const name of OUTSIDE) {
      expect((await narrator.readNarrator(src, name, { preflightOk: true })).status, name).toBe(404);
    }
    // a wrong key fails the GCM tag instead of returning garbage
    const wrong = narrator.sealedSource(join(dir, 'pilot'), randomBytes(32));
    expect((await narrator.readNarrator(wrong, 'p1.wav', { preflightOk: true })).status).toBe(500);
  });

  it('knows which sources hold sealed audio (the first sealed sound spends the text, spec 10.4)', () => {
    const sealed = narrator.sealedSource(join(dir, 'pilot'), key);
    expect(narrator.holdsSealedAudio(sealed)).toBe(true);
    expect(narrator.holdsSealedAudio(narrator.replaySource(join(dir, 'audio.wav'), sealed))).toBe(true);
    expect(narrator.holdsSealedAudio(narrator.replaySource(join(dir, 'audio.wav')))).toBe(false);
    expect(narrator.holdsSealedAudio(narrator.sampleSource(dir))).toBe(false);
    expect(narrator.holdsSealedAudio(narrator.doctorSource(dir))).toBe(false);
    expect(narrator.holdsSealedAudio(narrator.noSource())).toBe(false);
  });

  it('has one allow list and refuses everything when a mode has no narrator', async () => {
    expect(Object.keys(narrator.NARRATOR_ALLOW).sort()).toEqual(['doctor', 'gate', 'replay', 'sample', 'sealed']);
    expect(narrator.NARRATOR_ALLOW.gate).toEqual([
      'pack.json', 'cues.json', 'listen.wav', 'objections.wav', 'listen.timings.json', 'objections.timings.json',
    ]);
    expect(Object.values(narrator.NARRATOR_ALLOW.sealed).every((f) => f.startsWith('audio/') || f === 'timings.json.enc')).toBe(true);
    expect((await narrator.readNarrator(narrator.noSource(), 'p1.wav', { preflightOk: true })).status).toBe(404);
  });

  it('doctor serves only the volume sample level.wav (spec 7.7)', async () => {
    writeFileSync(join(dir, 'level.wav'), 'RIFF-level');
    writeFileSync(join(dir, 'p1.wav'), 'RIFF-sample-passage');
    const src = narrator.doctorSource(dir);
    expect(narrator.narratorNames(src)).toEqual(['level.wav']);
    const r = await narrator.readNarrator(src, 'level.wav');
    expect(r.status).toBe(200);
    expect(r.body).toEqual(Buffer.from('RIFF-level'));
    expect((await narrator.readNarrator(src, 'p1.wav')).status).toBe(404);
    for (const name of OUTSIDE) expect((await narrator.readNarrator(src, name)).status, name).toBe(404);
  });

  it('parses the seal key as hex or base64 and seals round-trip', () => {
    expect(narrator.parseSealKey(key.toString('hex'))).toEqual(key);
    expect(narrator.parseSealKey(key.toString('base64'))).toEqual(key);
    expect(() => narrator.parseSealKey('short')).toThrow();
    const sealed = narrator.sealBytes(Buffer.from('hello'), key);
    expect(sealed.length).toBe(12 + 5 + 16);
    expect(narrator.openSealed(sealed, key).toString()).toBe('hello');
  });
});

describe('narrator over HTTP in a sealed-plan mode (live-sim)', () => {
  let sb: Sandbox;
  let host: HostRun | null = null;
  const key = randomBytes(32);

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

  /** A live-sim run on the pilot plan whose page has loaded and whose worker is connected (before consent). */
  async function startPilot(env: Record<string, string> = {}): Promise<{
    h: HostRun; w: FakeWorker; cfg: HostConfig; get: (name: string) => Promise<Response>;
  }> {
    const h = await startHost(sb, ['--mode', 'live-sim', '--plan', 'pilot'], { COPYHOLDER_SEAL_KEY: key.toString('hex'), ...env });
    host = h;
    expect(await h.loadPage()).toBe(200);
    const cfg = await h.config();
    const get = (name: string) => fetch(`${h.origin}/api/narrator/${encodeURIComponent(name)}?token=${h.token}`);
    const w = await FakeWorker.open(cfg.sessionUrl, h.origin);
    w.hello();
    return { h, w, cfg, get };
  }

  async function afterPreflight(get: (name: string) => Promise<Response>): Promise<Response> {
    let res = await get('opening.wav');
    for (let i = 0; i < 40 && res.status === 409; i++) {
      await new Promise((r) => setTimeout(r, 50));
      res = await get('opening.wav');
    }
    return res;
  }

  it('refuses names off the list, holds sealed audio until preflight_ok, then serves it; fetching does not spend the text', async () => {
    const plain = makePlan(sb.sealed, key);
    // the SDK fails 2.5 s in: the attempt ends after the clips were fetched but before any sealed sound
    const { h, w, cfg, get } = await startPilot({ COPYHOLDER_MOCK_SCRIPT: JSON.stringify({ errorAtMs: 2500 }) });
    expect(cfg).toMatchObject({ mode: 'live-sim', sessionId: 'pilot', consentText: 'mic', planCommitment: 'ab'.repeat(32) });
    expect(cfg.narrator).toEqual(['opening.wav', 'p1.wav', 'timings.json']);
    for (const name of OUTSIDE.filter((n) => n !== '')) expect((await get(name)).status, name).toBe(404);
    expect((await get('opening.wav')).status).toBe(409); // before consent

    w.send({ t: 'consent', at: 1 });
    await w.waitMessage((m) => m.t === 'tap' && m.status === 'running');
    expect((await get('opening.wav')).status).toBe(409); // before preflight_ok
    // narration before preflight_ok cannot be sealed sound: no sealed file was served yet
    w.send({ t: 'stamp', line: { n: 500, k: 'state', s: 'narrating' } });
    w.send({ t: 'event', line: { n: 1000, e: 'preflight_ok' } });
    const res = await afterPreflight(get);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('audio/wav');
    expect(Buffer.from(await res.arrayBuffer())).toEqual(plain['opening.wav']);
    const timings = await get('timings.json');
    expect(await timings.text()).toBe(plain['timings.json']?.toString());
    expect((await get('plan.json')).status).toBe(404);

    expect((await w.waitMessage((m) => m.t === 'abort')).reason).toBe('sdk_error');
    w.send({ t: 'end', reason: 'abort' });
    expect(await h.exited).toBe(0);
    const m = readJson(join(sb.sessions, 'pilot', 'manifest.json'));
    // live:sim on the pilot plan is the listening without camera, with its own step order (spec 8.5, 10.2)
    expect(m).toMatchObject({ kind: 'pilot', mode: 'live-sim', plan: 'pilot', plan_commitment: 'ab'.repeat(32), tap: 'mock', sdk: null });
    expect(m.narrator).toEqual({ names: ['opening.wav', 'p1.wav', 'timings.json'], sealed_served: ['opening.wav', 'timings.json'], first_sealed_n: null });

    // no sealed sound played, so the text is not spent: the plan starts again (spec 10.4)
    const again = await startHost(sb, ['--mode', 'live-sim', '--plan', 'pilot'], { COPYHOLDER_SEAL_KEY: key.toString('hex') });
    host = again;
    await again.waitFor(/Waiting for "I agree, start" on the page\./);
    expect(again.out()).not.toContain('was already played');
    expect(again.out()).toContain('Recording folder:');
  }, 30_000);

  it('spends the text at the first sealed sound and records it at once, so even a crash counts (spec 7.8, 10.4)', async () => {
    makePlan(sb.sealed, key);
    const { h, w, get } = await startPilot();
    w.send({ t: 'consent', at: 1 });
    await w.waitMessage((m) => m.t === 'tap' && m.status === 'running');
    w.send({ t: 'event', line: { n: 1000, e: 'preflight_ok' } });
    expect((await afterPreflight(get)).status).toBe(200);
    const manifest = () => readJson(join(sb.sessions, 'pilot', 'manifest.json'));
    expect((manifest().narrator as Record<string, unknown>).first_sealed_n).toBeNull();
    // Deck starts the opening clip: {n, k:'state', s:'narrating'} (web/lib/deck-core.ts)
    w.send({ t: 'stamp', line: { n: 48000, k: 'state', s: 'narrating' } });
    w.send({ t: 'stamp', line: { n: 96000, k: 'state', s: 'narrating' } });
    await waitUntil(() => (manifest().narrator as Record<string, unknown>).first_sealed_n === 48000);
    expect(manifest().state).toBe('recording');
    h.kill('SIGKILL'); // a crash after the first sealed sound
    await h.exited;
    host = null;
    const { spawnSync } = await import('node:child_process');
    const again = spawnSync(process.execPath, [join(import.meta.dirname, '..', '..', 'live', 'host.cjs'), '--mode', 'live-sim', '--plan', 'pilot', '--no-open'], {
      env: {
        ...process.env, COPYHOLDER_SESSIONS_DIR: sb.sessions, COPYHOLDER_WEB_DIST: sb.dist, COPYHOLDER_SEALED_DIR: sb.sealed,
        COPYHOLDER_SEAL_KEY: key.toString('hex'), COPYHOLDER_ALLOW_DIRTY: '1',
      },
      encoding: 'utf8',
      timeout: 15_000,
    });
    expect(again.status).toBe(1);
    expect(again.stdout).toContain('Plan pilot was already played');
  }, 30_000);
});
