// The page in Chromium with a fake microphone (spec 7.3, 12.2, 9.2, 9.3, 7.12): consent gating,
// verbatim texts, the gate scenario as Deck reports it, window and device events, Stop, doctor.
// The page is the production build of web/ (vite build --config web/vite.config.ts). Most tests use
// `--mode standins`, which puts the stand-in Deck and worker of web/lib/stand-ins/ in place of
// web/deck.worklet.ts and web/worker.ts; the last ones build the real Deck, with the stand-in worker
// and with the real worker.
// Run: PW_CHROMIUM_PATH=<chrome> npx playwright test tests/e2e/page.spec.ts

import { cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { extname, join, normalize, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test, type Page } from '@playwright/test';
import { build, type Plugin } from 'vite';
import { DEFAULT_VAD_PARAMS } from '../../core/vad/index.ts';
import { planTimeline, secondsToSamples, type Step } from '../../web/scenarios/format.ts';
import { buildGateScenario } from '../../web/scenarios/gate.ts';
import { microphoneRow, panelText } from '../../web/ui/device-panel.ts';
import { encodeWavPcm16 } from '../../web/ui/wav.ts';

const WEB = fileURLToPath(new URL('../../web/', import.meta.url));
const S = secondsToSamples;
/** The stand-in Deck moves its sample count this many times faster than real time. */
const SPEED = 512;
/** A cue list that follows spec 9.2 (14 cues, gaps 16-24 s, first >= 15 s, last <= 265 s), in ms. */
const CUES_A = [15000, 31000, 55000, 71000, 92000, 110000, 130000, 147000, 167000, 185000, 205000, 223000, 244000, 262000];

test.use({
  launchOptions: {
    executablePath: process.env.PW_CHROMIUM_PATH || undefined,
    args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--autoplay-policy=no-user-gesture-required'],
  },
});

// ---------------------------------------------------------------- the spec texts, verbatim

/** Spec 12.2, live modes, exactly as the spec prints it. */
const SPEC_CONSENT_LIVE = `Before you start

Copyholder will turn on your camera and your microphone.

- Camera frames are processed on this computer by the SmartSpectra
  SDK. The app does not store or upload them.
- In every session the SDK itself sends derived measurements (such as
  breathing rate) with session identifiers to Presage in the United
  States. Presage passes them to its AI provider, Anthropic, to
  generate "Insights". This cannot currently be switched off. The app
  never requests an Insight and sends no prompt text.
- The SDK also sends app credentials, hashed device identifiers and
  usage records, and Presage's servers see the IP address.
- SDK telemetry is switched off (\`enableTelemetry: false\`). That does
  not switch off authentication, model delivery or the transfer above.
- Your microphone recording, the chest trace, face points and the
  SDK's raw messages, which include the full face mesh, are saved to
  the folder sessions/<id>/ on this computer. The app uploads none of
  it.
- Measure only yourself. You must be 18 or older.
- SDK metrics are offered for general wellness and informational
  purposes only. SDK metrics have not been cleared by the FDA and may
  not be used for medical diagnosis or treatment. This app makes no
  diagnosis and no health claim.

Privacy notice: PRIVACY.md. Terms of use: TERMS.md.

[ I agree, start ]   [ Cancel ]`;

/** Spec 9.2, the instruction before Start. */
const SPEC_GATE_INSTRUCTION = `The recording takes about ten minutes. The narrator never stops.

1. Minute one: follow the prompts.
2. Three minutes: listen, stay silent.
3. Five minutes: 14 obvious mistakes. When the dot under the
   camera fills, say the correction aloud, three to five words.

Correct the narrator as you would correct a person.
Do not think about breathing.
If you did not catch what was wrong, say: "No, that was wrong."

Sit still, eyes on the dot.   [ Start ]`;

/** Paragraphs as the screen shows them: a wrapped item is one paragraph (spec 12.2). */
function consentParagraphs(spec: string, sessionId: string): { title: string; lead: string; bullets: string[]; after: string; buttons: string[] } {
  const blocks = spec.split('\n\n');
  const bullets: string[] = [];
  for (const line of (blocks[2] ?? '').split('\n')) {
    if (line.startsWith('- ')) bullets.push(line.slice(2));
    else bullets[bullets.length - 1] += ` ${line.trim()}`;
  }
  const buttons = [...(blocks[4] ?? '').matchAll(/\[ ([^\]]+) \]/g)].map((m) => m[1] ?? '');
  return {
    title: blocks[0] ?? '',
    lead: blocks[1] ?? '',
    // Backticks become a monospace font and <id> the session name (spec 12.2).
    bullets: bullets.map((b) => b.replaceAll('`', '').replace('<id>', sessionId)),
    after: blocks[3] ?? '',
    buttons,
  };
}

// ---------------------------------------------------------------- the page under test

interface Trace {
  gum: Array<{ audio?: Record<string, unknown>; video?: unknown }>;
  enumerate: number;
  contexts: Array<Record<string, unknown>>;
  modules: string[];
  nodes: Array<Record<string, unknown>>;
  toDeck: Array<Record<string, unknown>>;
  fromDeck: Array<Record<string, unknown>>;
  workers: string[];
  toWorker: Array<Record<string, unknown>>;
  fromWorker: Array<Record<string, unknown>>;
  sockets: number;
  processorErrors: number;
}

/**
 * Runs in the page before its scripts: records every call the consent gate is about (getUserMedia,
 * enumerateDevices, AudioContext, the worklet, the worker, sockets) and every message between the
 * page, Deck and the worker. It also asks the stand-in Deck to run `speed` times faster.
 */
function instrument(speed: number): void {
  const w = window as unknown as Record<string, unknown>;
  const t = {
    gum: [] as unknown[],
    enumerate: 0,
    contexts: [] as unknown[],
    modules: [] as string[],
    nodes: [] as unknown[],
    toDeck: [] as unknown[],
    fromDeck: [] as unknown[],
    workers: [] as string[],
    toWorker: [] as unknown[],
    fromWorker: [] as unknown[],
    sockets: 0,
    processorErrors: 0,
  };
  const streams: MediaStream[] = [];
  const workerRefs: Worker[] = [];
  w.__t = t;
  w.__streams = streams;
  w.__workers = workerRefs;
  const clone = (m: unknown): unknown => {
    try {
      return JSON.parse(
        JSON.stringify(m, (_k, v: unknown) => {
          if (v instanceof MessagePort) return '[port]';
          if (ArrayBuffer.isView(v)) return `[${v.constructor.name} ${(v as Float32Array).length}]`;
          return v;
        }),
      ) as unknown;
    } catch {
      return String(m);
    }
  };
  const md = navigator.mediaDevices;
  const gum = md.getUserMedia.bind(md);
  md.getUserMedia = async (c?: MediaStreamConstraints) => {
    t.gum.push(clone(c));
    const s = await gum(c);
    streams.push(s);
    return s;
  };
  const enumerate = md.enumerateDevices.bind(md);
  md.enumerateDevices = async () => {
    t.enumerate += 1;
    return enumerate();
  };
  const AC = window.AudioContext;
  w.AudioContext = class extends AC {
    constructor(o?: AudioContextOptions) {
      t.contexts.push(clone(o ?? {}));
      super(o);
      const wl = this.audioWorklet;
      const add = wl.addModule.bind(wl);
      wl.addModule = (url: string | URL, opts?: WorkletOptions) => {
        t.modules.push(String(url));
        return add(url, opts);
      };
    }
  };
  const AWN = window.AudioWorkletNode;
  w.AudioWorkletNode = class extends AWN {
    constructor(ctx: BaseAudioContext, name: string, o?: AudioWorkletNodeOptions) {
      t.nodes.push(clone({ name, ...(o ?? {}) }));
      const po = (o?.processorOptions ?? {}) as Record<string, unknown>;
      super(ctx, name, { ...(o ?? {}), processorOptions: { ...po, standinSpeed: speed } });
      const port = this.port;
      const post = port.postMessage.bind(port) as (m: unknown, tr?: Transferable[]) => void;
      port.postMessage = ((m: unknown, tr?: Transferable[]) => {
        t.toDeck.push(clone(m));
        if (tr === undefined) post(m);
        else post(m, tr);
      }) as typeof port.postMessage;
      port.addEventListener('message', (e) => t.fromDeck.push(clone(e.data)));
      // Chromium dispatches a processor failure as an ErrorEvent of type 'error'; a spec browser as 'processorerror'.
      this.addEventListener('error', () => (t.processorErrors += 1));
      this.addEventListener('processorerror', () => (t.processorErrors += 1));
    }
  };
  const W = window.Worker;
  w.Worker = class extends W {
    constructor(url: string | URL, o?: WorkerOptions) {
      super(url, o);
      t.workers.push(String(url));
      workerRefs.push(this);
      const post = this.postMessage.bind(this) as (m: unknown, tr?: Transferable[]) => void;
      this.postMessage = ((m: unknown, tr?: Transferable[]) => {
        t.toWorker.push(clone(m));
        if (tr === undefined) post(m);
        else post(m, tr);
      }) as typeof this.postMessage;
      this.addEventListener('message', (e) => t.fromWorker.push(clone(e.data)));
    }
  };
  const WS = window.WebSocket;
  w.WebSocket = class extends WS {
    constructor(url: string | URL, protocols?: string | string[]) {
      t.sockets += 1;
      super(url, protocols);
    }
  };
}

async function trace(page: Page): Promise<Trace> {
  return page.evaluate(() => (window as unknown as { __t: Trace }).__t);
}

/** Sends a control message to the stand-in worker (web/lib/stand-ins/worker.ts). */
async function toStandInWorker(page: Page, msg: Record<string, unknown>): Promise<void> {
  await page.evaluate((m) => (window as unknown as { __workers: Worker[] }).__workers[0]?.postMessage(m), msg);
}

/** Asks the stand-in worker what it received and whether its pkt came back from Deck as an arr stamp. */
async function standInReport(page: Page): Promise<{ received: string[]; deckPortOk: boolean } | undefined> {
  await toStandInWorker(page, { k: 'standin_report' });
  const all = (await trace(page)).fromWorker.filter((m) => m.k === 'standin' && m.what === 'report');
  return all.at(-1)?.detail as { received: string[]; deckPortOk: boolean } | undefined;
}

const pageMessages = (list: Array<Record<string, unknown>>) => list.filter((m) => !String(m.k).startsWith('standin'));
const kinds = (list: Array<Record<string, unknown>>) => pageMessages(list).map((m) => String(m.k));

function wav(seconds: number): Buffer {
  const pcm = new Float32Array(Math.round(seconds * 48_000));
  for (let i = 0; i < pcm.length; i += 1) pcm[i] = 0.05 * Math.sin((2 * Math.PI * 220 * i) / 48_000);
  return Buffer.from(encodeWavPcm16(pcm));
}

interface Fixture {
  config: Record<string, unknown>;
  files: Record<string, { type: string; body: Buffer | string }>;
}

const GATE_A: Fixture = {
  config: {
    mode: 'gate',
    sessionId: 'gate-a-test',
    scenario: 'gate-A',
    tapUrl: null,
    sessionUrl: null,
    // A frozen vad block with its floor, and a doctor floor it outranks (docs/protocol.md processorOptions).
    detector: { params: { vad: { floor_db: -62.5, periodicity: 0.55 } }, sign: 1, variant: 'D1' },
    calib: { schema: 'calib/1', output_gain: 0.35, vad: { floor_db: -58, periodicity: 0.6 } },
    narrator: ['pack.json', 'cues.json', 'listen.wav', 'objections.wav', 'listen.timings.json', 'objections.timings.json'],
    consentText: 'live',
    standin: { sdk: 'manual' },
  },
  files: {
    'listen.wav': { type: 'audio/wav', body: wav(2) },
    'objections.wav': { type: 'audio/wav', body: wav(2) },
    'listen.timings.json': { type: 'application/json', body: JSON.stringify({ schema: 'timings/1', words: [{ index: 0, startMs: 100, endMs: 400 }] }) },
    'objections.timings.json': { type: 'application/json', body: JSON.stringify({ schema: 'timings/1', words: [] }) },
    'cues.json': { type: 'application/json', body: JSON.stringify(CUES_A) },
  },
};

const DOCTOR: Fixture = {
  config: {
    mode: 'doctor',
    sessionId: 'doctor-1',
    scenario: 'doctor',
    tapUrl: null,
    sessionUrl: null,
    calib: null,
    narrator: ['level.wav'],
    consentText: 'mic',
  },
  files: { 'level.wav': { type: 'audio/wav', body: wav(2) } },
};

/** doctor after an earlier doctor run: its floor and periodicity go to Deck's voice detector. */
const DOCTOR_VAD: Fixture = { ...DOCTOR, config: { ...DOCTOR.config, calib: { schema: 'calib/1', vad: { floor_db: -61, periodicity: 0.52 } } } };

/** GATE_A with host's verdict after a run that did not finish (the stand-in worker sends it after closed). */
const GATE_A_REDO: Fixture = {
  ...GATE_A,
  config: { ...GATE_A.config, standin: { sdk: 'manual', verdict: { ok: false, text: 'RE-RECORD NOW: the recording did not reach its end' } } },
};

async function openPage(page: Page, origin: string, fx: Fixture): Promise<void> {
  await page.addInitScript(instrument, SPEED);
  await page.route('**/api/config*', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(fx.config) }));
  await page.route('**/api/narrator/**', (r) => {
    const name = decodeURIComponent(new URL(r.request().url()).pathname.split('/').pop() ?? '');
    const f = fx.files[name];
    return f ? r.fulfill({ status: 200, contentType: f.type, body: f.body }) : r.fulfill({ status: 404, body: 'not served' });
  });
  await page.goto(`${origin}/?token=t0`);
}

/** Consent, then Start: the camera and the microphone may run only from here on. */
async function agreeAndStart(page: Page): Promise<void> {
  await page.click('#agree');
  await expect(page.locator('#start')).toBeEnabled();
  await page.click('#start');
  await expect.poll(async () => kinds((await trace(page)).toDeck).includes('scenario'), { timeout: 15_000 }).toBe(true);
}

// ---------------------------------------------------------------- static server for a build

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.map': 'application/json',
};

async function serve(dir: string): Promise<{ server: Server; origin: string }> {
  const root = normalize(dir + sep);
  const server = createServer((req, res) => {
    const path = decodeURIComponent((req.url ?? '/').split('?')[0] ?? '/');
    const file = normalize(join(root, path === '/' ? 'index.html' : path));
    if (!file.startsWith(root) || !existsSync(file) || !TYPES[extname(file)]) {
      res.writeHead(404).end('not found');
      return;
    }
    res.writeHead(200, { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream' }).end(readFileSync(file));
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  return { server, origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}` };
}

async function buildPage(mode: 'standins' | 'production', outDir: string, plugins: Plugin[] = []): Promise<void> {
  await build({ configFile: join(WEB, 'vite.config.ts'), mode, logLevel: 'silent', plugins, build: { outDir, emptyOutDir: true } });
}

/** For a production build with the real Deck: main.ts gets the stand-in worker in place of web/worker.ts. */
function standInWorkerOnly(): Plugin {
  return {
    name: 'test-stand-in-worker',
    enforce: 'pre',
    resolveId(source, importer) {
      if (!importer?.startsWith(join(WEB, 'main.ts')) || !source.startsWith('./worker.ts')) return null;
      return join(WEB, 'lib/stand-ins/worker.ts') + source.slice('./worker.ts'.length);
    },
  };
}

let standIn: { server: Server; origin: string; dir: string };

test.beforeAll(async () => {
  const dir = mkdtempSync(join(tmpdir(), 'copyholder-page-'));
  await buildPage('standins', dir);
  standIn = { ...(await serve(dir)), dir };
});

test.afterAll(async () => {
  if (!standIn) return;
  await new Promise((done) => standIn.server.close(done));
  rmSync(standIn.dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------- tests

test('consent screen shows spec 12.2 verbatim and nothing turns on before "I agree, start"', async ({ page }) => {
  await openPage(page, standIn.origin, GATE_A);
  await expect(page.locator('#agree')).toBeVisible();
  const want = consentParagraphs(SPEC_CONSENT_LIVE, 'gate-a-test');
  const shown = await page.evaluate(() => ({
    title: document.querySelector('.consent h1')?.textContent ?? '',
    paragraphs: [...document.querySelectorAll('.consent > p')].map((p) => p.textContent ?? ''),
    bullets: [...document.querySelectorAll('.consent li')].map((li) => li.textContent ?? ''),
    code: [...document.querySelectorAll('.consent li code')].map((c) => [c.textContent, getComputedStyle(c).fontFamily]),
    buttons: [...document.querySelectorAll('.consent button')].map((b) => b.textContent ?? ''),
  }));
  expect(shown.title).toBe(want.title);
  expect(shown.paragraphs).toEqual([want.lead, want.after]);
  expect(shown.bullets).toEqual(want.bullets);
  expect(shown.buttons).toEqual(want.buttons);
  expect(shown.code).toHaveLength(1);
  expect(shown.code[0]?.[0]).toBe('enableTelemetry: false');
  expect(String(shown.code[0]?.[1])).toMatch(/mono|Menlo/i);

  // Give the page time to do anything it would do on its own; nothing may turn on.
  await page.waitForTimeout(300);
  const t = await trace(page);
  expect({ gum: t.gum.length, enumerate: t.enumerate, contexts: t.contexts.length, workers: t.workers.length, modules: t.modules.length, sockets: t.sockets }).toEqual({
    gum: 0,
    enumerate: 0,
    contexts: 0,
    workers: 0,
    modules: 0,
    sockets: 0,
  });
  await expect(page.locator('#rec')).toBeHidden();
});

test('Cancel turns nothing on', async ({ page }) => {
  await openPage(page, standIn.origin, GATE_A);
  await page.click('#cancel');
  await expect(page.locator('.message h1')).toHaveText('Cancelled');
  await page.waitForTimeout(200);
  const t = await trace(page);
  expect([t.gum.length, t.contexts.length, t.workers.length]).toEqual([0, 0, 0]);
});

test('instruction is spec 9.2 verbatim; the microphone and the worker start only after Start', async ({ page }) => {
  await openPage(page, standIn.origin, GATE_A);
  await page.click('#agree');
  await expect(page.locator('#start')).toBeEnabled();
  const shown = await page.evaluate(() => {
    const text = (sel: string) => [...document.querySelectorAll<HTMLElement>(sel)].map((e) => e.innerText);
    return {
      lead: text('.instruction > p:not(.lines):not(.note)'),
      steps: text('.instruction .steps p'),
      lines: text('.instruction p.lines'),
      footer: text('.instruction .footer'),
      button: text('.instruction #start'),
    };
  });
  const blocks = SPEC_GATE_INSTRUCTION.split('\n\n');
  const steps = (blocks[1] ?? '').replace(/\n {3}/g, ' ').split('\n');
  const [footer, button] = (blocks[3] ?? '').split(/ {3}\[ | \]/);
  expect(shown).toEqual({ lead: [blocks[0]], steps, lines: [blocks[2]], footer: [footer], button: [button] });

  // Consent given, instruction on screen: still no microphone, no audio, no worker (spec 9.3: "до камеры").
  await page.waitForTimeout(200);
  let t = await trace(page);
  expect([t.gum.length, t.contexts.length, t.workers.length, t.modules.length]).toEqual([0, 0, 0, 0]);

  await page.click('#start');
  await expect.poll(async () => kinds((await trace(page)).toWorker), { timeout: 15_000 }).toEqual(['init', 'hello', 'consent']);
  t = await trace(page);
  // spec 7.3: one AudioContext at 48 kHz, interactive; the microphone by exact id, mono, processing off.
  expect(t.contexts).toEqual([{ sampleRate: 48_000, latencyHint: 'interactive' }]);
  expect(t.gum.length).toBeGreaterThanOrEqual(1);
  for (const c of t.gum) {
    expect(c.video).toBe(false);
    expect(c.audio).toMatchObject({ channelCount: 1, echoCancellation: false, noiseSuppression: false, autoGainControl: false });
    expect(typeof (c.audio?.deviceId as { exact?: unknown } | undefined)?.exact).toBe('string');
  }
  const [init, hello, consent] = pageMessages(t.toWorker);
  expect(init).toMatchObject({ k: 'init', port: '[port]', config: GATE_A.config });
  expect(hello).toMatchObject({
    k: 'hello',
    settings: { echoCancellation: false, noiseSuppression: false, autoGainControl: false, contextSampleRate: 48_000 },
  });
  expect(typeof (hello?.settings as { label?: unknown }).label).toBe('string');
  expect(String(consent?.at)).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/);
  expect(t.workers).toHaveLength(1);
  expect(t.modules).toHaveLength(1);
  expect(t.sockets).toBe(0); // the main thread opens no socket; the worker owns /tap and /session
  expect(t.nodes).toEqual([
    {
      name: 'deck',
      numberOfInputs: 1,
      numberOfOutputs: 1,
      outputChannelCount: [1],
      channelCount: 1,
      channelCountMode: 'explicit',
      channelInterpretation: 'speakers',
      processorOptions: { mode: 'gate', gain: 0.35, vadParams: { ...DEFAULT_VAD_PARAMS, floorDb: -62.5, periodicity: 0.55 } },
    },
  ]);
  // The direct channel: Deck gets its end first, the worker the other end in init.
  expect(t.toDeck[0]).toEqual({ k: 'port', port: '[port]' });
  await expect(page.locator('#rec')).toBeVisible();
  await expect(page.locator('#stop')).toBeVisible();
  await expect(page.locator('#dot')).toBeVisible();
});

test('gate pack A: Deck runs the minute table of spec 9.3, counted in samples', async ({ page }) => {
  const steps: Step[] = buildGateScenario('A', CUES_A, { listen: S(2), objections: S(2) });
  await openPage(page, standIn.origin, GATE_A);
  await agreeAndStart(page);
  let t = await trace(page);
  expect(kinds(t.toDeck)).toEqual(['port', 'gain', 'load', 'load', 'scenario']);
  expect(t.toDeck[1]).toEqual({ k: 'gain', value: 0.35 });
  expect(t.toDeck.slice(2, 4).map((m) => [m.name, m.pcm])).toEqual([
    ['listen.wav', '[Float32Array 96000]'],
    ['objections.wav', '[Float32Array 96000]'],
  ]);
  expect(t.toDeck[4]).toEqual(JSON.parse(JSON.stringify({ k: 'scenario', steps })));

  // The SDK is not ready: the scenario holds on its first step, whatever the sample count does.
  await expect(page.locator('#prompt')).toHaveText('Starting camera...');
  // The page's MessageChannel joins Deck and the worker directly: a pkt from the worker comes back as an arr stamp.
  await expect.poll(async () => (await standInReport(page))?.deckPortOk).toBe(true);
  expect((await standInReport(page))?.received.slice(0, 3)).toEqual(['init', 'hello', 'consent']);
  await toStandInWorker(page, { k: 'standin_sdk', tap: 'running', ok: false, note: 'kNoFaceFound' });
  await expect(page.locator('#note')).toHaveText('No face found. Check the framing and the light.');
  await page.waitForTimeout(400); // about 100 s of samples at the stand-in's speed
  t = await trace(page);
  expect(t.fromDeck.filter((m) => m.k === 'step').map((m) => m.name)).toEqual(['sdk_start']);

  // Running with kOk held 5 s (the worker decides): the page releases the wait with go.
  await toStandInWorker(page, { k: 'standin_sdk', tap: 'running', ok: true });
  await expect.poll(async () => kinds((await trace(page)).fromDeck).includes('done'), { timeout: 30_000 }).toBe(true);
  t = await trace(page);
  expect(kinds(t.toDeck).filter((k) => k === 'go')).toHaveLength(1);

  const reported = t.fromDeck.filter((m) => m.k === 'step') as Array<{ n: number; name: string; text: string }>;
  expect(reported.map((m) => [m.name, m.text])).toEqual(steps.map((s) => [s.name, s.text]));
  const n = new Map(reported.map((m) => [m.name, m.n]));
  const at = (name: string) => {
    const v = n.get(name);
    if (v === undefined) throw new Error(`no step ${name}`);
    return v;
  };
  // Every step after the release starts at release + its planned offset, to the sample.
  const release = at('signal_ok');
  for (const row of planTimeline(steps).filter((r) => r.segment === 1)) expect([row.name, at(row.name) - release]).toEqual([row.name, row.startSamples]);

  // The minute table, from 0:00 = 'Breathe normally'.
  const origin = at('breathe_normally');
  const table: Array<[string, number]> = [
    ['loop_a', -20],
    ['headset', -8],
    ['deep_1_in', 10],
    ['sniff_1_wait', 28],
    ['sniff_1', 29.5],
    ['rest_1', 50],
    ['pa_start_1_closed', 55],
    ['rest_2', 70],
    ['listening', 75],
    ['objections', 255],
    ['pa_end_1_closed', 555],
    ['loop_b', 575],
    ['end', 587],
  ];
  expect(table.map(([name]) => [name, at(name) - origin])).toEqual(table.map(([name, s]) => [name, S(s)]));
  expect(at('loop_a') - at('loop_a_ready')).toBe(S(5));

  // The dot fills for 1.5 s at each cue of cues.json, counted from the start of the objection block.
  const cues = t.fromDeck.filter((m) => m.k === 'cue') as Array<{ n: number; on: boolean }>;
  expect(cues.map((c) => [c.on, c.n - at('objections')])).toEqual(CUES_A.flatMap((ms) => [[true, ms * 48], [false, ms * 48 + S(1.5)]]));

  // End: the worker ends the run, the microphone is off, host's verdict is on screen.
  const done = t.fromDeck.find((m) => m.k === 'done') as { n: number };
  expect(done.n).toBe(at('end'));
  await expect.poll(async () => pageMessages((await trace(page)).toWorker).at(-1)).toEqual({ k: 'end', reason: 'done' });
  await expect(page.locator('#prompt')).toHaveText('GOOD RECORDING');
  await expect(page.locator('#rec')).toBeHidden();
  await expect(page.locator('#dot')).toBeHidden();
  const tracks = await page.evaluate(() => (window as unknown as { __streams: MediaStream[] }).__streams.flatMap((s) => s.getTracks().map((k) => k.readyState)));
  expect(tracks.every((r) => r === 'ended')).toBe(true);
  // No breathing curve on the gate screen (spec 9.3): no canvas, no status line.
  expect(await page.locator('canvas').count()).toBe(0);
  await expect(page.locator('#status')).toBeHidden();
});

test('window and device events reach the worker; hidden page, devicechange, ended and mute are hard', async ({ page }) => {
  await openPage(page, standIn.origin, GATE_A);
  await agreeAndStart(page);
  const events = async () => pageMessages((await trace(page)).toWorker).filter((m) => m.k === 'event');
  await page.waitForTimeout(300); // let a full-screen resize, if any, land before the baseline
  const before = (await events()).length;
  await page.evaluate(() => {
    const set = (v: string) => Object.defineProperty(document, 'visibilityState', { value: v, configurable: true });
    set('hidden');
    document.dispatchEvent(new Event('visibilitychange'));
    set('visible');
    document.dispatchEvent(new Event('visibilitychange'));
    window.dispatchEvent(new Event('blur'));
    navigator.mediaDevices.dispatchEvent(new Event('devicechange'));
    const streams = (window as unknown as { __streams: MediaStream[] }).__streams;
    const track = streams[streams.length - 1]?.getAudioTracks()[0];
    track?.dispatchEvent(new Event('mute'));
    track?.dispatchEvent(new Event('ended'));
  });
  await page.setViewportSize({ width: 900, height: 700 });
  await expect
    .poll(async () => (await events()).slice(before).map((m) => [m.e, m.hard]))
    .toEqual([
      ['visibilitychange', true],
      ['visibilitychange', false],
      ['blur', false],
      ['devicechange', true],
      ['track_mute', true],
      ['track_ended', true],
      ['resize', false],
    ]);
  const mine = (await events()).slice(before);
  expect(mine[0]).toMatchObject({ state: 'hidden' });
  expect(mine[6]).toMatchObject({ w: 900, h: 700 });
});

test('Stop turns the microphone off at once, stops Deck and ends the run', async ({ page }) => {
  await openPage(page, standIn.origin, GATE_A_REDO);
  await agreeAndStart(page);
  await expect(page.locator('#rec')).toBeVisible();
  await page.click('#stop');
  await expect(page.locator('.message h1')).toHaveText('Stopped');
  const t = await trace(page);
  expect(kinds(t.toDeck)).toContain('stop');
  expect(pageMessages(t.toWorker).filter((m) => m.k === 'end')).toEqual([{ k: 'end', reason: 'stop' }]);
  const tracks = await page.evaluate(() => (window as unknown as { __streams: MediaStream[] }).__streams.flatMap((s) => s.getTracks().map((k) => k.readyState)));
  expect(tracks.every((r) => r === 'ended')).toBe(true);
  // The indicator stays until the camera is reported stopped too.
  await expect(page.locator('#rec')).toBeHidden();
  // host's quickcheck line still comes after Stop, and goes under the message (spec 9.3).
  await expect(page.locator('.message #verdict')).toHaveText('RE-RECORD NOW: the recording did not reach its end');
  await expect(page.locator('#verdict')).toHaveClass(/verdict-bad/);
  await expect(page.locator('.message h1')).toHaveText('Stopped');
});

/** A Deck that starts the scenario, then throws in process() as a broken worklet would (spec 12.2). */
const THROWING_DECK = `
class ThrowingDeck extends AudioWorkletProcessor {
  constructor() {
    super();
    this.quanta = -1;
    this.port.onmessage = (e) => {
      const m = e.data;
      if (m && m.k === 'scenario' && Array.isArray(m.steps) && m.steps[0]) {
        this.port.postMessage({ k: 'step', n: 0, name: m.steps[0].name, text: m.steps[0].text });
        this.quanta = 0;
      }
    };
  }
  process() {
    if (this.quanta >= 0 && ++this.quanta > 40) throw new Error('stand-in Deck failure');
    return true;
  }
}
registerProcessor('deck', ThrowingDeck);
`;

test('a Deck processor failure ends the run with deck_error, turns the microphone off and says why', async ({ page }) => {
  // The stand-in build with the throwing Deck in place of the stand-in one (a route does not reach worklet fetches).
  const dir = mkdtempSync(join(tmpdir(), 'copyholder-page-throw-'));
  cpSync(standIn.dir, dir, { recursive: true });
  const deckFile = readdirSync(join(dir, 'assets')).find((f) => /^deck\.worklet-.*\.js$/.test(f));
  if (!deckFile) throw new Error('no Deck bundle in the stand-in build');
  writeFileSync(join(dir, 'assets', deckFile), THROWING_DECK);
  const broken = await serve(dir);
  try {
    await runThrowingDeck(page, broken.origin);
  } finally {
    await new Promise((done) => broken.server.close(done));
    rmSync(dir, { recursive: true, force: true });
  }
});

async function runThrowingDeck(page: Page, origin: string): Promise<void> {
  await openPage(page, origin, GATE_A_REDO);
  await agreeAndStart(page);
  await expect(page.locator('.message h1')).toHaveText('Recording stopped', { timeout: 10_000 });
  await expect(page.locator('.message p').first()).toContainText('Deck, the audio part of this page, stopped with an error');
  const t = await trace(page);
  expect(t.processorErrors).toBe(1);
  const toWorker = pageMessages(t.toWorker);
  const failure = toWorker.filter((m) => m.k === 'event' && m.e === 'deck_error');
  expect(failure).toHaveLength(1);
  expect(failure[0]).toMatchObject({ hard: true });
  expect(String(failure[0]?.message)).toMatch(/stand-in Deck failure|the Deck processor stopped with an error/);
  // The hard line first, then the end: host stores both (events.jsonl, then {t:'end'}).
  expect(toWorker.filter((m) => m.k === 'end')).toEqual([{ k: 'end', reason: 'deck_error' }]);
  expect(toWorker.findIndex((m) => m.k === 'event' && m.e === 'deck_error')).toBeLessThan(toWorker.findIndex((m) => m.k === 'end'));
  expect(kinds(t.toDeck)).toContain('stop');
  const tracks = await page.evaluate(() => (window as unknown as { __streams: MediaStream[] }).__streams.flatMap((s) => s.getTracks().map((k) => k.readyState)));
  expect(tracks.length).toBeGreaterThan(0);
  expect(tracks.every((r) => r === 'ended')).toBe(true);
  await expect(page.locator('#dot')).toBeHidden();
  await expect(page.locator('#rec')).toBeHidden();
  await expect(page.locator('.message #verdict')).toHaveText('RE-RECORD NOW: the recording did not reach its end');
}

test('doctor: the microphone-only consent, device names and flags, the level choice, no camera', async ({ page }) => {
  await openPage(page, standIn.origin, DOCTOR);
  await expect(page.locator('#agree')).toBeVisible();
  const shown = await page.evaluate(() => [...document.querySelectorAll('.consent h1, .consent > p, .consent li, .consent button')].map((e) => e.textContent));
  expect(shown).toEqual([
    'Before you start',
    'This mode turns on your microphone only. The camera stays off and the SmartSpectra SDK does not run.',
    'Your microphone recording is saved to the folder sessions/doctor-1/ on this computer. The app uploads none of it.',
    'I agree, start',
    'Cancel',
  ]);
  expect(await trace(page)).toMatchObject({ gum: [], contexts: [], workers: [] });
  await agreeAndStart(page);

  // The first step waits for the user: device names and microphone flags (spec 7.12).
  await expect(page.locator('#go')).toHaveText('Continue');
  await expect(page.locator('#devices')).toBeVisible();
  const rows = await page.locator('#devices dt').allTextContents();
  expect(rows).toEqual(['Microphone', 'Output', 'Echo cancellation', 'Noise suppression', 'Auto gain', 'Channels', 'Sample rate']);
  // The rows follow the terminal doctor (analysis/doctor.ts): the microphone judged by its name, and
  // 48 kHz on both the audio context and the track. Chromium's fake input reports its own rate.
  const hello = pageMessages((await trace(page)).toWorker).find((m) => m.k === 'hello') as { settings: { label: string; sampleRate?: number } };
  const cells = await page.locator('#devices dd').evaluateAll((els) => els.map((e) => [e.className, e.textContent ?? '']));
  const mic = microphoneRow(hello.settings.label);
  expect(cells[0]).toEqual([mic.state, panelText(mic)]);
  expect(cells.slice(2, 5).map((c) => c[0])).toEqual(['ok', 'ok', 'ok']);
  const trackHz = hello.settings.sampleRate;
  const rateText = `audio context 48000 Hz, microphone ${typeof trackHz === 'number' ? `${trackHz} Hz` : 'unknown'}`;
  expect(cells[6]).toEqual(
    trackHz === 48_000 ? ['ok', rateText] : ['bad', `${rateText} (should be 48000 Hz for both; set the input to 48000 Hz in Audio MIDI Setup)`],
  );
  await expect(page.locator('#meters')).toBeVisible();
  await page.click('#go');

  // The level choice waits for 'Use this level'; each notch goes to Deck at once (spec 7.7).
  await expect(page.locator('#go')).toHaveText('Use this level', { timeout: 20_000 });
  await expect(page.locator('#levels')).toBeVisible();
  await page.click('#levels .level[data-db="-15"]');
  await page.click('#go');
  await expect.poll(async () => kinds((await trace(page)).fromDeck).includes('done'), { timeout: 30_000 }).toBe(true);
  const t = await trace(page);
  // No doctor run yet (calib null): the default notch, -12 dB, then the chosen -15 dB.
  expect(t.toDeck.filter((m) => m.k === 'gain').map((m) => Number(m.value).toFixed(4))).toEqual([(10 ** (-12 / 20)).toFixed(4), (10 ** (-15 / 20)).toFixed(4)]);
  const toWorker = pageMessages(t.toWorker);
  expect(toWorker.filter((m) => m.k === 'event' && m.e === 'gain').map((m) => [m.db, m.final])).toEqual([
    [-15, false],
    [-15, true],
  ]);
  // host writes output_gain into calib.json from the final gain event (docs/protocol.md).
  const final = toWorker.find((m) => m.k === 'event' && m.e === 'gain' && m.final === true);
  expect(Number(final?.value)).toBeCloseTo(10 ** (-15 / 20), 12);
  // No SDK wait in doctor; loop check B starts five minutes after A (spec 7.12).
  const stepsN = new Map((t.fromDeck.filter((m) => m.k === 'step') as Array<{ name: string; n: number }>).map((m) => [m.name, m.n]));
  expect(stepsN.has('sdk_start')).toBe(false);
  expect((stepsN.get('loop_b') ?? 0) - (stepsN.get('loop_a') ?? 0)).toBe(S(300));
});

test.describe('production build with the real Deck and the stand-in worker', () => {
  let built: { server: Server; origin: string; dir: string } | null = null;

  test.beforeAll(async () => {
    test.skip(!existsSync(join(WEB, 'deck.worklet.ts')), 'web/deck.worklet.ts is not written yet');
    const dir = mkdtempSync(join(tmpdir(), 'copyholder-page-deck-'));
    try {
      await buildPage('production', dir, [standInWorkerOnly()]);
    } catch (err) {
      rmSync(dir, { recursive: true, force: true });
      throw err;
    }
    built = { ...(await serve(dir)), dir };
  });

  test.afterAll(async () => {
    if (!built) return;
    const { server, dir } = built;
    await new Promise((done) => server.close(done));
    rmSync(dir, { recursive: true, force: true });
  });

  test('the page runs the real Deck on the sample clock and joins it to the worker, then Stop', async ({ page }) => {
    if (!built) throw new Error('no build');
    const bundle = readdirSync(join(built.dir, 'assets')).find((f) => /^deck\.worklet-.*\.js$/.test(f)) ?? '';
    expect(readFileSync(join(built.dir, 'assets', bundle), 'utf8')).not.toContain('standinSpeed');
    await openPage(page, built.origin, DOCTOR_VAD);
    await agreeAndStart(page);
    await expect(page.locator('#go')).toHaveText('Continue', { timeout: 10_000 });
    // Doctor's floor and periodicity reach the real Deck's voice detector, which takes them without an error.
    expect((await trace(page)).nodes[0]).toMatchObject({ processorOptions: { mode: 'doctor', vadParams: { ...DEFAULT_VAD_PARAMS, floorDb: -61, periodicity: 0.52 } } });
    // The worker's pkt reaches the real Deck on the direct channel and comes back as an arr stamp.
    await expect.poll(async () => (await standInReport(page))?.deckPortOk).toBe(true);
    await page.click('#go');
    const steps = async () => (await trace(page)).fromDeck.filter((m) => m.k === 'step') as Array<{ name: string; n: number }>;
    // loop_a starts 5 s after loop_a_ready, counted by Deck in samples (real time here).
    await expect.poll(async () => (await steps()).map((m) => m.name).includes('loop_a'), { timeout: 15_000 }).toBe(true);
    const n = new Map((await steps()).map((m) => [m.name, m.n]));
    expect((n.get('loop_a') ?? 0) - (n.get('loop_a_ready') ?? 0)).toBe(S(5));
    await expect(page.locator('#prompt')).toHaveText('Hold one earcup on the microphone');
    const t = await trace(page);
    expect(t.fromDeck.filter((m) => m.k === 'error')).toEqual([]);
    expect(t.processorErrors).toBe(0);
    await page.click('#stop');
    await expect(page.locator('.message h1')).toHaveText('Stopped');
    await expect.poll(async () => kinds((await trace(page)).fromDeck).includes('done'), { timeout: 10_000 }).toBe(true);
    expect(pageMessages((await trace(page)).toWorker).filter((m) => m.k === 'end')).toEqual([{ k: 'end', reason: 'stop' }]);
  });
});

test.describe('production build with the real Deck and worker', () => {
  let real: { server: Server; origin: string; dir: string; deckFile: string; workerFile: string } | null = null;

  test.beforeAll(async () => {
    test.skip(!existsSync(join(WEB, 'deck.worklet.ts')) || !existsSync(join(WEB, 'worker.ts')), 'web/deck.worklet.ts or web/worker.ts is not written yet');
    const dir = mkdtempSync(join(tmpdir(), 'copyholder-page-real-'));
    try {
      await buildPage('production', dir);
    } catch (err) {
      rmSync(dir, { recursive: true, force: true });
      throw err;
    }
    const assets = readdirSync(join(dir, 'assets'));
    const deckFile = assets.find((f) => /^deck\.worklet-.*\.js$/.test(f)) ?? '';
    const workerFile = assets.find((f) => /^worker-.*\.js$/.test(f)) ?? '';
    real = { ...(await serve(dir)), dir, deckFile, workerFile };
  });

  test.afterAll(async () => {
    if (!real) return;
    const { server, dir } = real;
    await new Promise((done) => server.close(done));
    rmSync(dir, { recursive: true, force: true });
  });

  test('builds the worklet and the worker as their own files, and both load in Chromium', async ({ page }) => {
    if (!real) throw new Error('no build');
    expect(real.deckFile).not.toBe('');
    expect(real.workerFile).not.toBe('');
    const index = readFileSync(join(real.dir, 'index.html'), 'utf8');
    expect(index).toMatch(/<script type="module"[^>]*src="\.\/assets\/index-[^"]+\.js"/);
    await page.route('**/api/**', (r) => r.fulfill({ status: 404, body: 'not served' }));
    await page.goto(`${real.origin}/`);
    await expect(page.locator('.message h1')).toHaveText('Cannot start');
    const result = await page.evaluate(
      async ({ deck, worker }) => {
        const ctx = new AudioContext({ sampleRate: 48_000, latencyHint: 'interactive' });
        await ctx.audioWorklet.addModule(`./assets/${deck}`);
        const node = new AudioWorkletNode(ctx, 'deck', { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1], processorOptions: { mode: 'gate' } });
        const processorError = await new Promise<string | null>((done) => {
          node.onprocessorerror = () => done('processorerror');
          setTimeout(() => done(null), 300);
        });
        const w = new Worker(`./assets/${worker}`, { type: 'module' });
        const workerError = await new Promise<string | null>((done) => {
          w.onerror = (e) => done(e.message || 'error');
          setTimeout(() => done(null), 500);
        });
        w.terminate();
        await ctx.close();
        return { sampleRate: ctx.sampleRate, processorError, workerError };
      },
      { deck: real.deckFile, worker: real.workerFile },
    );
    expect(result).toEqual({ sampleRate: 48_000, processorError: null, workerError: null });
  });

  test('the page drives the real Deck: doctor steps on the sample clock, then Stop', async ({ page }) => {
    if (!real) throw new Error('no build');
    await openPage(page, real.origin, DOCTOR);
    await agreeAndStart(page);
    await expect(page.locator('#go')).toHaveText('Continue', { timeout: 10_000 });
    const steps = async () => (await trace(page)).fromDeck.filter((m) => m.k === 'step').map((m) => m.name);
    expect(await steps()).toEqual(['devices']);
    await page.click('#go');
    await expect.poll(steps, { timeout: 10_000 }).toEqual(['devices', 'loop_a_ready']);
    await expect(page.locator('#prompt')).toHaveText('Hold one earcup on the microphone');
    const t = await trace(page);
    const reported = t.fromDeck.filter((m) => m.k === 'step') as Array<{ n: number }>;
    expect(reported[1]?.n).toBeGreaterThan(reported[0]?.n ?? Infinity);
    expect(t.fromDeck.some((m) => m.k === 'error')).toBe(false);
    await page.click('#stop');
    await expect(page.locator('.message h1')).toHaveText('Stopped');
    await expect.poll(async () => kinds((await trace(page)).fromDeck).includes('done'), { timeout: 10_000 }).toBe(true);
    expect(pageMessages((await trace(page)).toWorker).filter((m) => m.k === 'end')).toEqual([{ k: 'end', reason: 'stop' }]);
  });
});
