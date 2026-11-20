// headstart end to end (spec 6.5, 7.11, 15.1, 15.2, 15.4): the real host in headstart mode with the
// mock tap, the production page in Chromium with the fake microphone (tests/e2e/fixtures), Deck, the
// worker and the session folder. The sample text is a stand-in: short 16-bit 48 kHz mono tones with
// a timings-set/1 file, written into a temporary folder (never the files of sample/). Checks: the live
// view comes up with its info line, the flash square flashes on every click Deck reports, every stop
// shows its cause, the summary counts the stops, and the run ends cleanly. The info line names the SDK
// version of live/package.json and shows kOk once the worker's readiness holds (spec 7.1); events.jsonl
// says how the sign of the run came out of the deep breaths (detector_sign, docs/protocol.md).
// Real time, about three minutes: only with COPYHOLDER_E2E_LIVE=1 (npm run test:headstart).
// Run: PW_CHROMIUM_PATH=<chrome> npm run test:headstart

import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium, expect, test, type Browser, type Page } from '@playwright/test';
import { loadSession, stepMarks } from '../../analysis/lib/session.ts';
import { eventLogProblems, formatForPath, parseJsonl, validateEventLine, validateFileText } from '../../core/schemas/index.ts';
import { DEEP_BREATH_SIGN_ERROR } from '../../web/lib/deep-breath-sign.ts';
import { evenWords, synthPassage, wavBytes } from '../../web/lib/testing/synth.ts';
import { buildHeadstartScenario, headstartClips } from '../../web/scenarios/headstart.ts';
import { buildPage, chromiumArgs, newSessionDir, readJson, rmsDb, SAMPLE_RATE_HZ, startHost, writeFakeMicWav, type HostProcess } from './fixtures/integration.ts';

const LIVE = process.env.COPYHOLDER_E2E_LIVE === '1';
test.skip(!LIVE, 'headstart runs in real time (about three minutes): npm run test:headstart');

const sha256 = (b: Uint8Array | string): string => createHash('sha256').update(b).digest('hex');

/** Stand-in clips of the sample folder (web/scenarios/headstart.ts HEADSTART_FILES; p3 left out). */
const CLIPS = [
  { name: 'opening.wav', ms: 2_500, freq: 200 },
  { name: 'p1.wav', ms: 3_000, freq: 220 },
  { name: 'p2.wav', ms: 3_000, freq: 247 },
] as const;
const CAUSE_LABEL: Record<string, string> = { chest: 'CHEST', voice: 'VOICE', key: 'KEY' };
const DETECTOR_TEXTS = ['chest detector: active', 'chest detector: not active', 'chest detector: not active yet', 'chest detector: off in this run'];
/** The SDK version live/package.json names: host passes it in /api/config `sdkVersion` (spec 15.1, 15.2). */
const SDK_VERSION = (JSON.parse(readFileSync(join(import.meta.dirname, '..', '..', 'live', 'package.json'), 'utf8')) as {
  dependencies: Record<string, string>;
}).dependencies['@smartspectra/node-sdk'] ?? '';
const escapeRegExp = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** The info line of the live view: "SmartSpectra SDK 3.5.0 · 30 samples/s · kOk" (web/ui/live-model.ts infoLine). */
const INFO_LINE = new RegExp(`^SmartSpectra SDK ${escapeRegExp(SDK_VERSION)} · \\d+ samples/s · .+$`);
/** The SDK part of the info line (web/ui/live-model.ts sdkStatusText) the run may show. */
const SDK_TEXTS = /^(kOk|waiting for kOk|starting|not running|tap socket closed|k[A-Za-z]+|code_\d+)$/;
/** Clicks Deck plays: loop checks A and B (10 each, spec 6.3) and the three demo sync clicks (spec 15.4). */
const CLICKS = 23;

/** timings/1 of evenly spaced stand-in words (tools/tts/timings.ts parseTimings checks the shape). */
function timingsOf(words: ReturnType<typeof evenWords>, totalMs: number) {
  return {
    schema: 'timings/1',
    wordRule: 'copyholder-words/1',
    sampleRateHz: SAMPLE_RATE_HZ,
    durationSamples: Math.round((totalMs * SAMPLE_RATE_HZ) / 1000),
    durationMs: totalMs,
    wordCount: words.length,
    sentenceCount: 1,
    engine: { name: 'stand-in (tests/e2e/headstart.spec.ts)' },
    correctedChunks: 0,
    words: words.map((w, index) => ({ index, startMs: w.startMs, endMs: w.endMs, sentenceIndex: 0 })),
  };
}

/** The stand-in sample folder: the clips and one timings-set/1 file with the SHA-256 of each clip (spec 8.2). */
function writeStandInSample(dir: string): { lengths: Map<string, number>; files: Map<string, string> } {
  mkdirSync(dir, { recursive: true });
  const lengths = new Map<string, number>();
  const files = new Map<string, string>();
  const passages = CLIPS.map((c) => {
    const words = evenWords(Math.floor((c.ms - 400) / 450), 300, 150);
    const pcm = synthPassage(words, c.ms, c.freq, 0.25);
    const bytes = wavBytes(pcm);
    writeFileSync(join(dir, c.name), bytes);
    lengths.set(c.name, pcm.length);
    files.set(c.name, sha256(bytes));
    return { passageId: c.name.replace(/\.wav$/, ''), audioSha256: sha256(bytes), timings: timingsOf(words, c.ms) };
  });
  const set = `${JSON.stringify({ schema: 'timings-set/1', passages }, null, 2)}\n`;
  writeFileSync(join(dir, 'timings.json'), set);
  files.set('timings.json', sha256(set));
  return { lengths, files };
}

interface Seen {
  /** Times the flash square turned white, and whether it was white then. */
  flashes: number;
  white: number;
  badges: string[];
  detector: string[];
  status: string[];
  maxRate: number;
  info: string;
  /** The SDK parts of the info line seen, in order of first sight. */
  sdk: string[];
  sign: string | null;
}

/** In the page: counts the flashes (a MutationObserver) and samples the live view's texts every 40 ms. */
function watchLiveView(): void {
  const seen: Seen = { flashes: 0, white: 0, badges: [], detector: [], status: [], maxRate: 0, info: '', sdk: [], sign: null };
  (window as unknown as { __seen: Seen }).__seen = seen;
  const flash = document.getElementById('flash');
  if (flash) {
    new MutationObserver((records) => {
      for (const r of records) {
        if ((r.oldValue ?? '').split(/\s+/).includes('on')) continue;
        if (!flash.classList.contains('on')) continue;
        seen.flashes += 1;
        if (getComputedStyle(flash).backgroundColor === 'rgb(255, 255, 255)') seen.white += 1;
      }
    }).observe(flash, { attributes: true, attributeFilter: ['class'], attributeOldValue: true });
  }
  const add = (list: string[], text: string | null | undefined) => {
    if (text && !list.includes(text)) list.push(text);
  };
  setInterval(() => {
    const badge = document.getElementById('live-badge');
    if (badge && !badge.hidden) add(seen.badges, badge.textContent);
    add(seen.detector, document.getElementById('live-detector')?.textContent);
    const status = document.getElementById('status');
    if (status && !status.hidden) add(seen.status, status.textContent);
    const info = document.getElementById('live-info')?.textContent ?? '';
    seen.info = info;
    const m = / (\d+) samples\/s /.exec(info);
    if (m) seen.maxRate = Math.max(seen.maxRate, Number(m[1]));
    add(seen.sdk, info.split(' · ')[2]);
    const sign = document.getElementById('live-sign');
    if (sign && !sign.hidden) seen.sign = sign.textContent;
  }, 40);
}

async function pageState(page: Page): Promise<string> {
  try {
    return await page.evaluate(() => (document.getElementById('screen') ?? document.body).innerText.slice(0, 2000));
  } catch (e) {
    return `(page not readable: ${String(e)})`;
  }
}

let dist = '';
let distRoot = '';

test.beforeAll(async ({}, testInfo) => {
  if (!LIVE) return;
  testInfo.setTimeout(240_000);
  distRoot = mkdtempSync(join(tmpdir(), 'copyholder-e2e-dist-'));
  dist = await buildPage(join(distRoot, 'dist'));
});

test.afterAll(() => {
  if (distRoot) rmSync(distRoot, { recursive: true, force: true });
});

test('headstart with the mock tap: live view, flash square, stop causes, summary and a clean end', async ({}, testInfo) => {
  testInfo.setTimeout(7 * 60_000);
  const root = mkdtempSync(join(tmpdir(), 'copyholder-e2e-headstart-'));
  const sessionsDir = join(root, 'sessions');
  mkdirSync(sessionsDir, { recursive: true });
  const sampleDir = join(root, 'sample');
  const sample = writeStandInSample(sampleDir);
  const mic = writeFakeMicWav(join(root, 'mic.wav'));
  let host: HostProcess | null = null;
  let browser: Browser | null = null;
  let page: Page | null = null;
  const pageErrors: string[] = [];
  const served = new Map<string, { status: number; sha256: string }>();
  const bodies: Promise<void>[] = [];
  try {
    host = await startHost(['--mode', 'headstart', '--tap', 'mock'], {
      COPYHOLDER_SESSIONS_DIR: sessionsDir,
      COPYHOLDER_WEB_DIST: dist,
      COPYHOLDER_SAMPLE_DIR: sampleDir,
      // no params/frozen.json: the detector and the voice detector run on their defaults
      COPYHOLDER_PARAMS_FILE: join(root, 'frozen.json'),
      // one breath per deep-breath cycle (2 s in, 4 s out), as in the gate and smoke runs
      COPYHOLDER_MOCK_SCRIPT: JSON.stringify({ breathPeriodS: 6 }),
      // no settings.env decides the lens: a sessions folder without smoke keeps it (live/lib/lens-check.cjs)
      COPYHOLDER_LENS_CHECK: '',
    });
    // /api/config before the page loads it (host counts only page loads of / as reloads)
    const configUrl = new URL(host.url);
    configUrl.pathname = '/api/config';
    const config = (await (await fetch(configUrl)).json()) as { mode?: string; sdkVersion?: unknown; lensCheck?: unknown };
    expect(SDK_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
    expect(config).toMatchObject({ mode: 'headstart', sdkVersion: SDK_VERSION, lensCheck: true });
    browser = await chromium.launch({ executablePath: process.env.PW_CHROMIUM_PATH || undefined, args: chromiumArgs(mic) });
    page = await browser.newPage();
    page.on('pageerror', (e) => pageErrors.push(e.message));
    page.on('response', (r) => {
      const { pathname } = new URL(r.url());
      if (!pathname.startsWith('/api/narrator/')) return;
      const name = decodeURIComponent(pathname.slice('/api/narrator/'.length));
      bodies.push(r.body().then((b) => void served.set(name, { status: r.status(), sha256: sha256(b) }), () => void served.set(name, { status: r.status(), sha256: '' })));
    });
    await page.goto(host.url);
    await page.locator('#agree').click();
    await expect(page.locator('#start')).toBeEnabled({ timeout: 60_000 });
    await expect(page.locator('#screen')).toContainText('Live demo. About five minutes.');
    await expect(page.locator('#screen')).toContainText('If it stops and you heard nothing wrong, stay silent.');
    await page.locator('#start').click();

    // The live view and the flash square (spec 15.2, 15.4).
    await expect(page.locator('#live')).toBeVisible({ timeout: 30_000 });
    await expect(page.locator('#live-tag')).toHaveText('LIVE');
    await expect(page.locator('#live-info')).toHaveText(INFO_LINE);
    await expect(page.locator('#live-lanes')).toBeVisible();
    const flash = page.locator('#flash');
    expect(await flash.boundingBox()).toEqual({ x: 16, y: 16, width: 48, height: 48 });
    expect(await flash.evaluate((el) => getComputedStyle(el).position)).toBe('fixed');
    expect(await flash.evaluate((el) => getComputedStyle(el).backgroundColor)).toBe('rgb(0, 0, 0)');
    await page.evaluate(watchLiveView);

    // The summary of the take while it is on screen (spec 15.2).
    const summary = page.locator('#live-summary');
    await expect(summary).toBeVisible({ timeout: 5 * 60_000 });
    const summaryText = await summary.innerText();

    const code = await host.waitExit(3 * 60_000);
    expect(code, 'host exit code').toBe(0);
    await Promise.all(bodies);
    const prompt = page.locator('#prompt');
    await expect(prompt).toHaveClass(/verdict-ok/, { timeout: 10_000 });
    await expect(prompt).toHaveText(/^No quickcheck for headstart-\d+: /);
    const seen = await page.evaluate(() => (window as unknown as { __seen: Seen }).__seen);
    const canvasPainted = await page.locator('#live-lanes').evaluate((c) => {
      const canvas = c as HTMLCanvasElement;
      const data = canvas.getContext('2d')?.getImageData(0, 0, canvas.width, canvas.height).data;
      let painted = 0;
      if (data) for (let i = 3; i < data.length; i += 4) if (data[i] !== 0) painted += 1;
      return painted;
    });

    // The session folder (spec 8.1).
    const dir = newSessionDir(sessionsDir);
    const files = readdirSync(dir).sort();
    testInfo.annotations.push({ type: 'files', description: files.join(', ') });
    for (const f of ['manifest.json', 'audio.wav', 'stamps.jsonl', 'samples.jsonl', 'events.jsonl', 'detector_in.jsonl']) expect(files).toContain(f);
    for (const name of files) {
      if (formatForPath(name) === null) continue;
      expect(validateFileText(name, readFileSync(join(dir, name), 'utf8')), `${name} against core/schemas`).toEqual([]);
    }
    const session = loadSession(dir);
    expect(session.problems).toEqual([]);
    expect(session.kind).toBe('headstart');
    expect(readJson<{ kind: string }>(join(dir, 'manifest.json')).kind).toBe('headstart');
    const parsed = parseJsonl(readFileSync(join(dir, 'events.jsonl'), 'utf8'), validateEventLine, { file: 'events.jsonl' });
    expect(parsed.errors).toEqual([]);
    expect(eventLogProblems(session.kind, parsed.rows, parsed.lineNumbers)).toEqual([]);

    // Every step of the take, in order, with the stand-in clips (web/scenarios/headstart.ts).
    const narrator = [...sample.files.keys()];
    const steps = buildHeadstartScenario(headstartClips(narrator), sample.lengths, { lensCheck: true });
    expect(stepMarks(session).map((m) => m.name)).toEqual(steps.map((s) => s.name));
    for (const [name, hash] of sample.files) expect(served.get(name), `GET /api/narrator/${name}`).toEqual({ status: 200, sha256: hash });
    expect(rmsDb(session.ch1, 0, session.ch1.length), 'the narrator played').toBeGreaterThan(-60);

    // The flash square turned white on every click Deck played (spec 15.4).
    const clicks = session.stamps.filter((s) => s.k === 'click');
    expect(clicks.length, 'clicks of loop checks A and B and the demo clicks').toBe(CLICKS);
    expect(seen.flashes, 'flashes of the square').toBe(CLICKS);
    expect(seen.white, 'flashes seen white').toBe(CLICKS);

    // Stops: each cause was shown while the narrator was stopped; the summary counts them.
    const holds = session.stamps.filter((s) => s.k === 'hold') as Array<{ cause?: string }>;
    const count = (cause: string) => holds.filter((h) => h.cause === cause).length;
    testInfo.annotations.push({ type: 'stops', description: `chest ${count('chest')}, voice ${count('voice')}` });
    console.log(`headstart: ${count('chest')} CHEST and ${count('voice')} VOICE stops; badges shown: ${seen.badges.join(', ') || 'none'}`);
    const causes = [...new Set(holds.map((h) => h.cause ?? ''))].map((c) => CAUSE_LABEL[c] ?? c).sort();
    expect([...seen.badges].sort(), 'badges shown').toEqual(causes);
    expect(summaryText.split('\n').filter(Boolean)).toEqual([`CHEST stops: ${count('chest')}`, `VOICE stops: ${count('voice')}`]);

    // The sign of the run: one detector_sign line either way, with the change of the trace over each
    // deep breath's inhale (d); sign null with why when they gave none, and then the page says D1 is
    // off (spec 7.11).
    const signs = session.events.filter((e) => e.e === 'detector_sign');
    expect(signs, 'detector_sign lines').toHaveLength(1);
    const signLine = signs[0] as Record<string, unknown>;
    testInfo.annotations.push({ type: 'trace sign', description: JSON.stringify(signLine) });
    expect(signLine['det']).toBe('D1');
    expect(Array.isArray(signLine['d']) ? (signLine['d'] as unknown[]).length : null, 'd: one entry per deep breath').toBe(3);
    for (const d of signLine['d'] as unknown[]) expect(d === null || typeof d === 'number').toBe(true);
    if (signLine['sign'] === null) {
      expect(typeof signLine['why'] === 'string' && (signLine['why'] as string).length > 0, 'why').toBe(true);
      expect(seen.sign).toBe(DEEP_BREATH_SIGN_ERROR);
      expect(seen.detector).toContain('chest detector: off in this run');
      expect(count('chest'), 'no CHEST stop without a sign').toBe(0);
    } else {
      expect([1, -1]).toContain(signLine['sign']);
      expect('why' in signLine).toBe(false);
      expect(seen.sign).toBeNull();
      expect(seen.detector).not.toContain('chest detector: off in this run');
    }
    for (const d of seen.detector) expect(DETECTOR_TEXTS).toContain(d);

    // The info line counted the mock's 30 trace samples per second; the lanes were drawn.
    expect(seen.maxRate).toBeGreaterThanOrEqual(20);
    expect(seen.maxRate).toBeLessThanOrEqual(40);
    expect(seen.info).toMatch(INFO_LINE);
    // kOk only once Running with kOk held 5 s (spec 7.1): the mock says kOk from the start, so the take shows it.
    expect(seen.sdk, `SDK parts of the info line: ${seen.sdk.join(' | ')}`).toContain('kOk');
    for (const t of seen.sdk) expect(t, 'SDK part of the info line').toMatch(SDK_TEXTS);
    expect(canvasPainted, 'painted pixels of the lanes').toBeGreaterThan(1000);
    expect(seen.status.some((t) => /^Live demo/.test(t)), `status lines: ${seen.status.join(' | ')}`).toBe(true);
    expect(seen.status.some((t) => /^Passage 1 of 2/.test(t)), `status lines: ${seen.status.join(' | ')}`).toBe(true);

    expect(pageErrors).toEqual([]);
    rmSync(root, { recursive: true, force: true });
  } catch (err) {
    const state = page ? await pageState(page) : '(no page)';
    testInfo.annotations.push({ type: 'kept', description: root });
    throw new Error(
      [
        (err as Error).message,
        '--- page ---',
        state,
        '--- page errors ---',
        pageErrors.join('\n') || '(none)',
        '--- host output, last 6000 characters ---',
        host ? host.output().slice(-6000) : '(host did not start)',
        `--- files kept in ${root} ---`,
      ].join('\n'),
    );
  } finally {
    await browser?.close().catch(() => undefined);
    await host?.stop();
  }
});
