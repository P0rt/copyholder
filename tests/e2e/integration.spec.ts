// The whole live chain in real time (spec 7.2, 7.7, 7.12, 9.4): the real host (node live/host.cjs,
// with the mock tap where a camera is needed), the production page in Chromium with a microphone
// from a file, Deck, the worker, the session folder (spec 8.1) and quickcheck, which host starts.
// A person's clicks only: consent, Start, and the buttons the scenario asks for.
// The fake microphone hears none of Deck's loop-check clicks, so the loop checks cannot be found:
// doctor and quickcheck must fail on exactly that and on nothing else. Without a 48 kHz input device
// (a container) Chromium's fake track reports 44100 Hz; then they must fail on the sample rate too.
// doctor --level runs twice: with the system default devices, and with the headset named as in
// settings.env (the page then opens the microphone by deviceId exact and the output by sinkId).
// The gate run starts with a doctor-1/calib.json in the sessions folder, so its output gain must reach
// Deck through /api/config. The full doctor run (about 6 minutes plus the TTS self-test) is tagged @slow.
// Run: PW_CHROMIUM_PATH=<chrome> npx playwright test tests/e2e/integration.spec.ts
// COPYHOLDER_E2E_PACK0=stand-in makes the gate run use the stand-in pack 0 even when the real one is ready.

import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium, expect, test, type Browser, type Page, type TestInfo } from '@playwright/test';
import { loadSession, stepMarks, stepSpan, type LoadedSession } from '../../analysis/lib/session.ts';
import { QUESTION_KEYS } from '../../analysis/smoke/report.ts';
import { audioIndex } from '../../core/clock/index.ts';
import {
  eventLogProblems,
  formatForPath,
  HARD_WINDOW_EVENTS,
  isPageHiddenEvent,
  parseJsonl,
  validateEventLine,
  validateFileText,
  verifyLedgerText,
  type LedgerStepLine,
  type Manifest,
  type Quickcheck,
} from '../../core/schemas/index.ts';
import { buildDoctorLevelScenario, buildDoctorScenario, DOCTOR_LOOP_GAP_SECONDS, DOCTOR_SAMPLE_CLIP } from '../../web/scenarios/doctor.ts';
import type { Step } from '../../web/scenarios/format.ts';
import { buildGateScenario, CUE_RULES_MS, GATE_LAYOUT } from '../../web/scenarios/gate.ts';
import { buildSmokeScenario } from '../../web/scenarios/smoke.ts';
import { dbToGain } from '../../web/ui/levels.ts';
import { decodeNarratorWav } from '../../web/ui/wav.ts';
import {
  buildPage,
  chromiumArgs,
  newSessionDir,
  readJson,
  realPackZeroReady,
  REPO_ROOT,
  rmsDb,
  SAMPLE_RATE_HZ,
  seedDoctorCalib,
  startHost,
  writeFakeMicWav,
  writeStandInPackZero,
  type HostProcess,
} from './fixtures/integration.ts';

const sha256 = (b: Uint8Array | string): string => createHash('sha256').update(b).digest('hex');
const bare = (h: string): string => h.replace(/^sha256:/, '');

/** host's line before quickcheck's own output (live/host.cjs runQuickcheck). */
const QUICKCHECK_START = 'Running the quick check...';
/** Deck's audio block (spec 7.2): 9600 frames, 0.2 s. */
const BLOCK_FRAMES = 9600;
/** The level a person picks in the doctor's chooser (web/ui/levels.ts OUTPUT_LEVELS_DB). */
const CHOSEN_LEVEL_DB = -9;
/** Channel 1 while the narrator plays is far above this; with nothing to play it is digital silence. */
const NARRATOR_MIN_DB = -60;
const SILENT_MAX_DB = -90;
/** The headset as settings.env names it on the Mac; here Chromium's fake devices (spec 7.3, 13.6). */
const NAMED_DEVICES = { input: 'Fake Audio Input 1', output: 'Fake Audio Output 1' } as const;
/** Output gain of the doctor-1/calib.json the gate run finds: far from the page's default level (-12 dB). */
const SEEDED_GAIN = 0.1;
/** Channel 1 is the clip times the gain, sample for sample (spec 7.3): the RMS may differ by this much. */
const GAIN_TOLERANCE_DB = 0.5;

/** Loop check A not heard (analysis/lib/conditions.ts loop_checks): the one reason the gate run must fail on. */
const LOOP_A_REASON = /^loop check A was not found: only \d+ of 10 clicks were heard in the microphone; hold the earcup on the microphone during the clicks$/;
const GATE_PROBE_WORDS = 'technical failure; fix it and repeat the short probe until it gives GOOD RECORDING (spec 9.4)';
/** doctor's hard check of the loop clicks (analysis/doctor.ts) when loop check A is not heard. */
const DOCTOR_LOOP_A = 'clicks of loop check A not found: hold the earcup on the microphone during the clicks';

let dist = '';
let distRoot = '';

test.beforeAll(async ({}, testInfo) => {
  testInfo.setTimeout(240_000);
  distRoot = mkdtempSync(join(tmpdir(), 'copyholder-e2e-dist-'));
  dist = await buildPage(join(distRoot, 'dist'));
});

test.afterAll(() => {
  if (distRoot) rmSync(distRoot, { recursive: true, force: true });
});

// ---------------------------------------------------------------- one live run

interface Served {
  status: number;
  sha256: string;
}

interface LiveRun {
  root: string;
  dir: string;
  session: LoadedSession;
  manifest: Manifest;
  host: HostProcess;
  /** quickcheck's stdout lines as host relayed them, after "Running the quick check...". */
  quickcheckLines: string[];
  /** What the run screen's prompt shows at the end, and its verdict class. */
  shown: { text: string; ok: boolean | null };
  /** /api/narrator/<name> answers the page got. */
  narrator: Map<string, Served>;
  pageErrors: string[];
}

interface LiveSpec {
  name: string;
  /** Arguments of live/host.cjs (--no-open is added). */
  args: string[];
  env?: Record<string, string>;
  /** Earlier recordings put into the sessions folder before host starts. */
  seed?: (sessionsDir: string) => void;
  /** What a person presses after Start. */
  person?: (page: Page) => Promise<void>;
  /** From Start until host exits by itself. */
  runMs: number;
  /** Real pack 0: digits are hidden in every failure message (its cue times, spec 9.2). */
  secret?: boolean;
}

/** Hides the digits of a text from the real pack's run, so no cue time reaches a log. */
function shownText(text: string, secret: boolean): string {
  return secret ? text.replace(/\d/g, '#') : text;
}

async function pageState(page: Page): Promise<string> {
  try {
    return await page.evaluate(() => (document.getElementById('screen') ?? document.body).innerText.slice(0, 2000));
  } catch (e) {
    return `(page not readable: ${String(e)})`;
  }
}

/**
 * Starts host, opens its page in Chromium with the fake microphone, agrees, presses Start, lets
 * `person` press the scenario's buttons, waits for host to exit, then reads the session folder.
 */
async function liveRun(spec: LiveSpec, root: string, testInfo: TestInfo): Promise<LiveRun> {
  const secret = spec.secret === true;
  const sessionsDir = join(root, 'sessions');
  mkdirSync(sessionsDir, { recursive: true });
  spec.seed?.(sessionsDir);
  const before = new Set(readdirSync(sessionsDir));
  const mic = writeFakeMicWav(join(root, 'mic.wav'));
  let host: HostProcess | null = null;
  let browser: Browser | null = null;
  let page: Page | null = null;
  const narrator = new Map<string, Served>();
  const bodies: Promise<void>[] = [];
  const pageErrors: string[] = [];
  try {
    host = await startHost(spec.args, { COPYHOLDER_SESSIONS_DIR: sessionsDir, COPYHOLDER_WEB_DIST: dist, ...spec.env });
    browser = await chromium.launch({ executablePath: process.env.PW_CHROMIUM_PATH || undefined, args: chromiumArgs(mic) });
    page = await browser.newPage();
    page.on('pageerror', (e) => pageErrors.push(e.message));
    page.on('response', (r) => {
      const { pathname } = new URL(r.url());
      if (!pathname.startsWith('/api/narrator/')) return;
      const name = decodeURIComponent(pathname.slice('/api/narrator/'.length));
      bodies.push(
        r.body().then(
          (b) => void narrator.set(name, { status: r.status(), sha256: sha256(b) }),
          () => void narrator.set(name, { status: r.status(), sha256: '' }),
        ),
      );
    });
    await page.goto(host.url);
    await page.locator('#agree').click();
    await expect(page.locator('#start')).toBeEnabled({ timeout: 60_000 });
    await page.locator('#start').click();
    await spec.person?.(page);
    const code = await host.waitExit(spec.runMs);
    expect(code, 'host exit code').toBe(0);
    await Promise.all(bodies);
    // host sends the verdict, then closes /session and exits: the page shows it in the prompt's place
    const prompt = page.locator('#prompt');
    await expect(prompt).toHaveClass(/verdict-(ok|bad)/, { timeout: 10_000 });
    const shown = {
      text: (await prompt.textContent()) ?? '',
      ok: (await prompt.getAttribute('class'))?.includes('verdict-ok') ? true : (await prompt.getAttribute('class'))?.includes('verdict-bad') ? false : null,
    };
    const dir = newSessionDir(sessionsDir, before);
    const session = loadSession(dir);
    const manifest = readJson<Manifest>(join(dir, 'manifest.json'));
    const out = host.stdout();
    const at = out.lastIndexOf(`${QUICKCHECK_START}\n`);
    const quickcheckLines = at < 0 ? [] : out.slice(at + QUICKCHECK_START.length + 1).split('\n').map((l) => l.trim()).filter(Boolean);
    return { root, dir, session, manifest, host, quickcheckLines, shown, narrator, pageErrors };
  } catch (err) {
    const state = page ? await pageState(page) : '(no page)';
    const detail = [
      (err as Error).message,
      `--- page (${spec.name}) ---`,
      state,
      `--- page errors ---`,
      pageErrors.join('\n') || '(none)',
      `--- host output, last 6000 characters ---`,
      host ? host.output().slice(-6000) : '(host did not start)',
      `--- files kept in ${root} ---`,
    ].join('\n');
    testInfo.annotations.push({ type: 'kept', description: root });
    throw new Error(shownText(detail, secret));
  } finally {
    await browser?.close().catch(() => undefined);
    await host?.stop();
  }
}

// ---------------------------------------------------------------- checks of a session folder

/** Exactly these files in the folder (spec 8.1 for this mode). */
function expectFiles(run: LiveRun, files: readonly string[]): void {
  expect(readdirSync(run.dir).sort(), `files of ${run.dir}`).toEqual([...files].sort());
}

/** Every file with a schema in core/schemas validates line by line; loadSession found nothing wrong. */
function expectSchemas(run: LiveRun, secret = false): void {
  for (const name of readdirSync(run.dir)) {
    if (formatForPath(name) === null) continue;
    const problems = validateFileText(name, readFileSync(join(run.dir, name), 'utf8'));
    expect(problems.map((p) => shownText(p, secret)), `${name} against core/schemas`).toEqual([]);
  }
  expect(run.session.problems.map((p) => shownText(p, secret)), 'problems loadSession found').toEqual([]);
}

/**
 * manifest.json: kind, 48 kHz, processing off, and the hashes of exactly the files host saved (spec 8.1),
 * each equal to its file now, after the report host ran (docs/protocol.md: doctor may rewrite calib.json).
 */
function expectManifest(run: LiveRun, kind: string, hashed: readonly string[]): void {
  const m = run.manifest;
  expect(m.kind).toBe(kind);
  expect(m.id).toBe(run.session.id);
  expect(m.audio.sample_rate).toBe(SAMPLE_RATE_HZ);
  expect(m.audio.mic_flags_off).toBe(true);
  expect(Object.keys(m.files).sort(), 'files manifest.json hashes').toEqual([...hashed].sort());
  for (const [name, h] of Object.entries(m.files)) {
    expect(bare(h), `manifest.json hash of ${name}`).toBe(sha256(readFileSync(join(run.dir, name))));
  }
}

/** audio.wav: 2 channels of float32 at 48 kHz, one run of 9600-frame blocks from sample 0 (spec 7.2, 8.1). */
function expectAudio(run: LiveRun): void {
  const s = run.session;
  expect(s.wav.sampleRateHz).toBe(SAMPLE_RATE_HZ);
  expect(s.ch0.length).toBe(s.ch1.length);
  expect(s.layout.contiguous, 'chunk stamps add up to audio.wav').toBe(true);
  expect(s.layout.runs.length).toBe(1);
  expect(s.layout.runs[0]?.n0).toBe(0);
  const chunks = s.stamps.filter((x) => x.k === 'chunk');
  expect(chunks.length).toBe(s.layout.chunks);
  expect(chunks.slice(0, -1).every((c) => c.frames === BLOCK_FRAMES), 'every block but the last has 9600 frames').toBe(true);
  expect(s.ch0.length).toBe(s.layout.frames);
  // the microphone was recorded: the fake microphone's syllables and sniffs, not silence
  expect(rmsDb(s.ch0, 0, s.ch0.length)).toBeGreaterThan(-50);
  const gaps = s.events.filter((e) => /gap|lost|damaged/.test(e.e));
  expect(gaps.map((e) => e.e), 'lost or damaged audio blocks').toEqual([]);
}

/** Deck entered every step of the scenario, in order, and nothing else (stamps.jsonl marks). */
function expectSteps(run: LiveRun, steps: readonly Step[]): void {
  expect(stepMarks(run.session).map((m) => m.name)).toEqual(steps.map((s) => s.name));
}

/** events.jsonl: the record kind's rules (core/schemas eventLogProblems), no device or window events. */
function expectEvents(run: LiveRun, secret = false): void {
  const parsed = parseJsonl(readFileSync(join(run.dir, 'events.jsonl'), 'utf8'), validateEventLine, { file: 'events.jsonl' });
  expect(parsed.errors.map((p) => shownText(p, secret))).toEqual([]);
  expect(eventLogProblems(run.session.kind, parsed.rows, parsed.lineNumbers).map((p) => shownText(p, secret))).toEqual([]);
  const window = parsed.rows.filter((e) => HARD_WINDOW_EVENTS.includes(e.e) || isPageHiddenEvent(e));
  expect(window.map((e) => e.e), 'device and window events').toEqual([]);
}

/** Index range of a step in audio.wav. */
function stepRange(s: LoadedSession, name: string): { i: number; len: number } {
  const span = stepSpan(s, name);
  if (!span) throw new Error(`step ${name} is not in the recording`);
  const i = audioIndex(s.layout, span.n0, span.n1 - span.n0);
  if (i === null) throw new Error(`step ${name} is not recorded in one run`);
  return { i, len: span.n1 - span.n0 };
}

/** RMS of a channel over one step, in dB re full scale. */
function stepDb(s: LoadedSession, channel: 0 | 1, name: string): number {
  const { i, len } = stepRange(s, name);
  return rmsDb(channel === 0 ? s.ch0 : s.ch1, i, i + len);
}

/** Channel 1 is Deck's output: the narrator plays in every play step and nothing plays in the quiet ones. */
function expectNarratorPlayed(run: LiveRun, steps: readonly Step[], quiet: readonly string[]): void {
  for (const st of steps.filter((x) => x.k === 'play')) {
    expect(stepDb(run.session, 1, st.name), `channel 1 in play step ${st.name}`).toBeGreaterThan(NARRATOR_MIN_DB);
  }
  for (const name of quiet) expect(stepDb(run.session, 1, name), `channel 1 in quiet step ${name}`).toBeLessThan(SILENT_MAX_DB);
}

/** The narrator files the page fetched are byte for byte the files host was meant to serve. */
function expectServed(run: LiveRun, files: Record<string, string>): void {
  for (const [name, file] of Object.entries(files)) {
    const got = run.narrator.get(name);
    expect(got?.status, `GET /api/narrator/${name}`).toBe(200);
    expect(got?.sha256, `/api/narrator/${name} is ${file}`).toBe(sha256(readFileSync(file)));
  }
}

/** The clicks Deck stamped (10 per loop check, spec 6.3). */
function clickCount(run: LiveRun): number {
  return run.session.stamps.filter((x) => x.k === 'click').length;
}

/** Sample numbers of the clicks Deck stamped inside a step. */
function clicksIn(run: LiveRun, name: string): number[] {
  const span = stepSpan(run.session, name);
  if (!span) throw new Error(`step ${name} is not in the recording`);
  return run.session.stamps.filter((x) => x.k === 'click' && x.n >= span.n0 && x.n < span.n1).map((x) => x.n);
}

/**
 * The sample rate the microphone track reported (getSettings, in manifest.json). A real 48 kHz input
 * gives 48000. Without any audio device (a container), Chromium's fake input falls back to 44100, and
 * doctor and quickcheck then fail on the sample rate as well, as they must (spec 5.2, 6.3).
 */
function trackRate(run: LiveRun, testInfo: TestInfo): number | null {
  const settings = run.manifest.audio.settings;
  const rate = settings && typeof settings['sampleRate'] === 'number' ? settings['sampleRate'] : null;
  testInfo.annotations.push({ type: 'microphone track', description: `${rate ?? 'unknown'} Hz` });
  return rate;
}

/** doctor's hard check of the rates (analysis/doctor.ts) when the track is not at 48 kHz; none when it is. */
function doctorRateFailures(rate: number | null): string[] {
  return rate === SAMPLE_RATE_HZ
    ? []
    : [`not everything runs at 48000 Hz (audio context 48000 Hz, microphone track ${rate ?? 'unknown'} Hz, audio.wav 48000 Hz): set 48 000 Hz in Audio MIDI Setup (spec 5.2)`];
}

/** quickcheck printed exactly one verdict line, last, and the page shows the same line. */
function expectOneVerdict(run: LiveRun, verdict: RegExp, ok: boolean, secret = false): string {
  const lines = run.quickcheckLines;
  const verdicts = lines.filter((l) => verdict.test(l));
  expect(verdicts.length, `verdict lines among quickcheck's output:\n${shownText(lines.join('\n'), secret)}`).toBe(1);
  const line = lines[lines.length - 1] ?? '';
  expect(line === verdicts[0], `the verdict is quickcheck's last line: ${shownText(line, secret)}`).toBe(true);
  expect(run.shown.text === line, `the page shows: ${shownText(run.shown.text, secret)}`).toBe(true);
  expect(run.shown.ok).toBe(ok);
  return line;
}

/** The one line of doctor's report that matches `re`. */
function oneLine(lines: readonly string[], re: RegExp, what: string): string {
  const hits = lines.filter((l) => re.test(l));
  expect(hits.length, `${what}: one line ${String(re)} in doctor's report:\n${lines.join('\n')}`).toBe(1);
  return hits[0] ?? '';
}

/**
 * doctor's report (analysis/doctor.ts) prints what spec 7.12 and 7.7 list. Both runs: device names,
 * the processing flags, the rates, the background, the leak and the chosen level. The full run also:
 * L_rt of both loop checks, whether an inhale switched the voice detector on, the voice detector
 * values for PREREG.md and the result of the TTS self-test, which must pass (spec 7.7).
 */
function expectDoctorReport(run: LiveRun, level: boolean): void {
  const lines = run.quickcheckLines;
  oneLine(lines, new RegExp(`^Doctor report for ${run.session.id}${level ? ' \\(level and leak only\\)' : ''}$`), 'title');
  oneLine(lines, /^(ok {4}microphone "|FAIL {2}headset microphone not found: )/, 'microphone name');
  oneLine(lines, /^Output: "[^"]+"$/, 'output device name');
  oneLine(lines, /^Output device \(sinkId\): accepted$/, 'output device taken as sinkId');
  expect(lines.filter((l) => l.startsWith('warn') && l.includes('sinkId')), 'sinkId warning').toEqual([]);
  oneLine(lines, /^ok {4}echo cancellation, noise suppression and auto gain control are off$/, 'processing flags');
  oneLine(lines, /^(ok {4}sample rate: |FAIL {2}not everything runs at 48000 Hz )/, 'sample rates');
  oneLine(lines, /^Background \(step floor\): -?\d+\.\d dB re full scale$/, 'background (voice detector floor)');
  oneLine(lines, /^Narrator leak into the microphone: -?\d+\.\d dB over the background \(warning above 6 dB\)/, 'leak');
  const gain = dbToGain(CHOSEN_LEVEL_DB);
  oneLine(lines, new RegExp(`^Output level: ${CHOSEN_LEVEL_DB.toFixed(1)} dB \\(gain ${gain.toPrecision(3).replace('.', '\\.')}\\)$`), 'chosen level');
  oneLine(lines, /^Warnings( \(\d+\):|: none)$/, 'warnings header');
  const full = [/^Loop check A: /, /^Loop check B: .+ after A$/, /^For PREREG\.md:$/, /^Running the TTS self-test /, /^TTS self-test: /];
  if (level) {
    for (const re of full) expect(lines.filter((l) => re.test(l)), `the level run has no ${String(re)}`).toEqual([]);
    return;
  }
  oneLine(lines, /^Loop check A: /, 'L_rt of loop check A');
  oneLine(lines, /^Loop check B: .+ after A$/, 'L_rt of loop check B and its distance from A');
  oneLine(
    lines,
    /^(Inhale test: (no inhale|an inhale) switched the voice detector on|warn {2}the inhales still switch the voice detector on at the cap)/,
    'whether an inhale switched the voice detector on',
  );
  oneLine(lines, /^For PREREG\.md:$/, 'PREREG.md values');
  oneLine(lines, /^\{\{VAD_FLOOR_DB\}\} = -?\d+\.\d$/, 'voice detector floor');
  oneLine(lines, /^\{\{VAD_PERIODICITY\}\} = \d\.\d\d$/, 'periodicity threshold');
  oneLine(lines, /^\{\{LRT_THRESHOLDS_CONFIRMED\}\} = not measured: a loop check is missing$/, 'L_rt thresholds');
  oneLine(lines, /^Running the TTS self-test /, 'TTS self-test start');
  oneLine(lines, /^TTS self-test: TTS SELFTEST OK\b/, 'TTS self-test result');
  expect(lines.filter((l) => /TTS self-test (failed|: not run)/.test(l)), 'TTS self-test failure').toEqual([]);
}

/** The verdict in the test output, so a reader sees what the run said (never for the real pack). */
function tellVerdict(name: string, line: string, testInfo: TestInfo): void {
  testInfo.annotations.push({ type: 'verdict', description: line });
  console.log(`${name}: ${line}`);
}

function cleanUp(run: LiveRun): void {
  rmSync(run.root, { recursive: true, force: true });
}

// ---------------------------------------------------------------- what a person presses

/** The level chooser (spec 7.7): one notch, then 'Use this level'. */
async function chooseLevel(page: Page, timeoutMs: number): Promise<void> {
  const use = page.locator('#go', { hasText: 'Use this level' });
  await expect(use).toBeVisible({ timeout: timeoutMs });
  await page.locator(`.level[data-db="${CHOSEN_LEVEL_DB}"]`).click();
  await use.click();
}

// ---------------------------------------------------------------- the runs

for (const named of [false, true]) {
  const title = named
    ? `doctor --level with the headset named (${NAMED_DEVICES.input}, ${NAMED_DEVICES.output}): deviceId exact and sinkId`
    : 'doctor --level: the volume sample from gate/level, the chosen level in calib.json';
  test(title, async ({}, testInfo) => {
    testInfo.setTimeout(5 * 60_000);
    const root = mkdtempSync(join(tmpdir(), 'copyholder-e2e-level-'));
    const steps = buildDoctorLevelScenario(DOCTOR_SAMPLE_CLIP);
    const run = await liveRun(
      {
        name: title,
        args: ['--mode', 'doctor', '--level'],
        env: named ? { COPYHOLDER_MIC_NAME: NAMED_DEVICES.input, COPYHOLDER_OUTPUT_NAME: NAMED_DEVICES.output } : {},
        // headset 8 s, floor 10 s and the sample twice (20 s each) come before the choice
        person: (page) => chooseLevel(page, 120_000),
        runMs: 3 * 60_000,
      },
      root,
      testInfo,
    );

    expectFiles(run, ['manifest.json', 'audio.wav', 'stamps.jsonl', 'events.jsonl', 'detector_in.jsonl', 'calib.json']);
    expectSchemas(run);
    expectManifest(run, 'doctor', ['audio.wav', 'stamps.jsonl', 'events.jsonl', 'detector_in.jsonl', 'calib.json']);
    expect(run.manifest.sdk).toBeNull();
    expect(run.manifest.camera).toBeNull();
    expectAudio(run);
    expectSteps(run, steps);
    expectEvents(run);
    expect(clickCount(run)).toBe(0);
    if (named) {
      // the devices settings.env names (spec 7.3): the microphone by deviceId exact, the output as the sinkId
      expect(run.manifest.audio.microphone).toBe(NAMED_DEVICES.input);
      expect(run.manifest.audio.output).toBe(NAMED_DEVICES.output);
      expect(run.manifest.audio.settings?.['output_accepted']).toBe(true);
      oneLine(run.quickcheckLines, new RegExp(`^Output: "${NAMED_DEVICES.output}"$`), 'the named output');
      oneLine(run.quickcheckLines, new RegExp(`^ok {4}microphone "${NAMED_DEVICES.input}" `), 'the named microphone');
    }

    // the 20 s volume sample, served from gate/level/ (spec 7.7), played in all three play steps
    expectServed(run, { [DOCTOR_SAMPLE_CLIP]: join(REPO_ROOT, 'gate', 'level', DOCTOR_SAMPLE_CLIP) });
    expectNarratorPlayed(run, steps, ['headset', 'floor']);

    // the chosen level: one final gain event, stored by host at once (spec 7.7)
    const finals = run.session.events.filter((e) => e.e === 'gain' && e['final'] === true);
    expect(finals.map((e) => e['db'])).toEqual([CHOSEN_LEVEL_DB]);
    const calib = readJson<Record<string, unknown>>(join(run.dir, 'calib.json'));
    expect(calib['output_gain']).toBeCloseTo(dbToGain(CHOSEN_LEVEL_DB), 9);

    // quickcheck ran doctor: the microphone, processing off and 48 kHz are its hard checks here
    const fails = doctorRateFailures(trackRate(run, testInfo));
    const line = expectOneVerdict(run, /^DOCTOR (OK|FAIL: .*)$/, fails.length === 0);
    tellVerdict(title, line, testInfo);
    expect(run.quickcheckLines.filter((l) => l.startsWith('FAIL'))).toEqual(fails.map((f) => `FAIL  ${f}`));
    expectDoctorReport(run, true);
    if (fails.length === 0) {
      expect(line).toBe('DOCTOR OK');
      expect(run.quickcheckLines).toContain('calib.json written: output gain and leak.');
      expect(typeof calib['leak_db_over_floor']).toBe('number');
    } else {
      // doctor writes calib.json only on DOCTOR OK: the file is what host wrote at the level choice,
      // the chosen level that later recordings use (live/lib/calib.cjs pageCalib)
      expect(line).toBe(`DOCTOR FAIL: ${fails[0]}`);
      expect(run.quickcheckLines.filter((l) => l.startsWith('calib.json written')), 'no claim that doctor wrote calib.json').toEqual([]);
      expect(Object.keys(calib).sort(), 'calib.json as host wrote it').toEqual(['output_gain', 'schema']);
    }
    expect(run.pageErrors).toEqual([]);
    cleanUp(run);
  });
}

test('gate --pack 0: the probe with the mock tap, RE-RECORD NOW on the loop check (and a track not at 48 kHz) only', async ({}, testInfo) => {
  testInfo.setTimeout(8 * 60_000);
  const root = mkdtempSync(join(tmpdir(), 'copyholder-e2e-gate-'));
  const forced = process.env['COPYHOLDER_E2E_PACK0'] === 'stand-in';
  const real = forced ? { ok: false, why: 'COPYHOLDER_E2E_PACK0=stand-in' } : await realPackZeroReady();
  const gateDir = real.ok ? join(REPO_ROOT, 'gate') : join(root, 'gate');
  if (!real.ok) writeStandInPackZero(gateDir);
  const packDir = join(gateDir, 'pack-0');
  const which = real.ok ? `real pack 0 (gate/pack-0; ${real.why})` : `stand-in pack 0 (${real.why})`;
  testInfo.annotations.push({ type: 'pack 0', description: which });
  console.log(`gate --pack 0 uses the ${which}`);
  const secret = real.ok;

  const run = await liveRun(
    {
      name: 'gate --pack 0',
      args: ['--mode', 'gate', '--pack', '0', '--tap', 'mock'],
      // one breath per deep-breath cycle (2 s in, 4 s out), so the three cued breaths move the trace alike
      env: { COPYHOLDER_MOCK_SCRIPT: JSON.stringify({ breathPeriodS: 6 }), ...(real.ok ? {} : { COPYHOLDER_GATE_DIR: gateDir }) },
      // the level an earlier doctor stored (spec 7.7: it acts in every later recording)
      seed: (dir) => void seedDoctorCalib(dir, { output_gain: SEEDED_GAIN }),
      runMs: 6 * 60_000,
      secret,
    },
    root,
    testInfo,
  );
  const hide = (xs: string[]) => xs.map((x) => shownText(x, secret));

  expectFiles(run, [
    'manifest.json', 'audio.wav', 'stamps.jsonl', 'samples.jsonl', 'events.jsonl', 'detector_in.jsonl',
    'tap.log', 'ledger.jsonl', 'quickcheck.json',
  ]);
  expectSchemas(run, secret);
  expectManifest(run, 'gate', ['audio.wav', 'stamps.jsonl', 'samples.jsonl', 'events.jsonl', 'detector_in.jsonl']);
  expect(run.manifest.pack).toBe('0');
  expectAudio(run);
  // the step names do not depend on the cue times: any cue list that passes spec 9.2 gives the same names
  const steps = buildGateScenario('0', [CUE_RULES_MS.firstMin, CUE_RULES_MS.firstMin + CUE_RULES_MS.gapMin]);
  expectSteps(run, steps);
  expectEvents(run, secret);
  expect(clickCount(run), 'clicks of loop checks A and B').toBe(20);
  const cueMarks = run.session.stamps.filter((x) => x.k === 'mark' && x.what === 'cue' && x.on === true);
  expect(cueMarks.length, 'cue dots filled').toBe(GATE_LAYOUT['0'].cues);
  expect(run.session.samples.length, 'samples.jsonl lines from the mock tap').toBeGreaterThan(1000);
  expect(run.session.detectorIn.length, 'detector_in.jsonl lines from the worker').toBeGreaterThan(100);

  // the camera runs from the SDK start to its stop, and both loop checks lie inside (spec 9.3): host's
  // tap events carry n = the sample after the last stored block, null before the first one
  const clicksA = clicksIn(run, 'loop_a');
  const clicksB = clicksIn(run, 'loop_b');
  expect([clicksA.length, clicksB.length], 'clicks inside loop_a and loop_b').toEqual([10, 10]);
  const tapAt = (status: string) => run.session.events.filter((e) => e.e === 'tap' && e['by'] === 'host' && e['status'] === status).map((e) => e.n ?? null);
  const [running, ...moreRunning] = tapAt('running');
  const [stopped, ...moreStopped] = tapAt('stopped');
  expect([moreRunning.length, moreStopped.length], 'one running and one stopped event').toEqual([0, 0]);
  expect(running === null || (running !== undefined && running < (clicksA[0] ?? 0)), 'the SDK runs before the first click of loop A').toBe(true);
  expect(stopped ?? -1, 'the SDK stops after the last click of loop B').toBeGreaterThanOrEqual(clicksB[clicksB.length - 1] ?? Number.MAX_SAFE_INTEGER);

  // the narrator never stops in the gate run (spec 6.5, 9.3): no hold, resume or silence stamp, and
  // Deck's state is only narrating, or idle between the clips
  const stops = run.session.stamps.filter((x) => x.k === 'hold' || x.k === 'resume' || x.nSilent !== undefined);
  expect(stops.length, 'hold, resume or nSilent stamps').toBe(0);
  const states = new Set(run.session.stamps.filter((x) => x.k === 'state').map((x) => x.s));
  expect(states.has('narrating'), 'Deck narrated').toBe(true);
  expect([...states].filter((s) => s !== 'narrating' && s !== 'idle'), 'states other than narrating and idle').toEqual([]);

  // pack 0 as listed in its pack.json: the two clips and the cue list, played in both play steps
  expectServed(run, { 'listen.wav': join(packDir, 'listen.wav'), 'objections.wav': join(packDir, 'objections.wav') });
  expect(run.narrator.get('cues.json')?.status).toBe(200);
  expectNarratorPlayed(run, steps, ['headset']);

  // the stored level reaches Deck (spec 7.3, 7.7, 8.1): host merged doctor-1/calib.json into /api/config,
  // and channel 1 in 'listening' is listen.wav times that gain
  expect((run.manifest as unknown as Record<string, unknown>)['calib_from']).toEqual({ doctor: ['doctor-1'], gate: null });
  expect(run.manifest.audio.output_gain).toBe(SEEDED_GAIN);
  const clip = decodeNarratorWav(new Uint8Array(readFileSync(join(packDir, 'listen.wav'))).buffer, 'listen.wav');
  const { len } = stepRange(run.session, 'listening');
  const clipDb = rmsDb(clip, 0, Math.min(len, clip.length)) + 10 * Math.log10(Math.min(len, clip.length) / len);
  const expectedDb = clipDb + 20 * Math.log10(SEEDED_GAIN);
  const gotDb = stepDb(run.session, 1, 'listening');
  expect(Math.abs(gotDb - expectedDb), `channel 1 in listening: ${gotDb.toFixed(2)} dB, expected ${expectedDb.toFixed(2)} dB`).toBeLessThan(GAIN_TOLERANCE_DB);

  // ledger (spec 8.5): host's record, then quickcheck's step, chained and matching the files
  const ledger = verifyLedgerText(readFileSync(join(run.dir, 'ledger.jsonl'), 'utf8'), sha256, { kind: 'gate' });
  expect(hide(ledger.errors)).toEqual([]);
  expect(ledger.records.map((r) => r.step)).toEqual(['record', 'quickcheck']);
  const [record, qcStep] = ledger.records as LedgerStepLine[];
  expect(bare(record?.out_sha256['manifest.json'] ?? '')).toBe(sha256(readFileSync(join(run.dir, 'manifest.json'))));
  expect(bare(record?.out_sha256['audio.wav'] ?? '')).toBe(sha256(readFileSync(join(run.dir, 'audio.wav'))));
  expect(bare(qcStep?.out_sha256['quickcheck.json'] ?? '')).toBe(sha256(readFileSync(join(run.dir, 'quickcheck.json'))));

  // quickcheck: exactly one stdout line, RE-RECORD NOW for loop check A, and no other hard condition
  // failed (but the sample rate, when the track is not at 48 kHz: see trackRate)
  expect(run.quickcheckLines.length, 'quickcheck stdout lines').toBe(1);
  const line = expectOneVerdict(run, /^(GOOD RECORDING|RE-RECORD NOW: .*)$/, false, secret);
  const qc = readJson<Quickcheck>(join(run.dir, 'quickcheck.json'));
  const rate = trackRate(run, testInfo);
  const rateReasons = rate === SAMPLE_RATE_HZ ? [] : [`the microphone track runs at ${rate} Hz, not 48000 Hz: set 48 000 Hz in Audio MIDI Setup (spec 5.2)`];
  expect(qc.result).toBe('RE-RECORD NOW');
  expect(qc.technical).toBe(true);
  const failed = qc.checks.filter((c) => c.hard && !c.ok);
  expect(failed.map((c) => c.name), `failed hard checks: ${hide(failed.map((c) => `${c.name}: ${c.detail ?? ''}`)).join(' | ')}`).toEqual([
    'loop_checks',
    ...(rateReasons.length > 0 ? ['sample_rate'] : []),
  ]);
  expect(qc.reasons.length, `reasons: ${hide(qc.reasons).join(' | ')}`).toBe(1 + rateReasons.length);
  expect(LOOP_A_REASON.test(qc.reasons[0] ?? ''), `reason: ${shownText(qc.reasons[0] ?? '', secret)}`).toBe(true);
  expect(hide(qc.reasons.slice(1))).toEqual(hide(rateReasons));
  const more = rateReasons.length > 0 ? ` (and ${rateReasons.length} more)` : '';
  expect(line === `RE-RECORD NOW: ${qc.reasons[0]}${more} [${GATE_PROBE_WORDS}]`, `verdict line: ${shownText(line, secret)}`).toBe(true);
  if (!secret) tellVerdict('gate --pack 0', line, testInfo);
  expect(hide(run.pageErrors)).toEqual([]);
  cleanUp(run);
});

test('smoke: two minutes with the mock tap, SMOKE OK', async ({}, testInfo) => {
  testInfo.setTimeout(6 * 60_000);
  const root = mkdtempSync(join(tmpdir(), 'copyholder-e2e-smoke-'));
  const steps = buildSmokeScenario();
  const run = await liveRun(
    {
      name: 'smoke',
      args: ['--mode', 'smoke', '--tap', 'mock'],
      env: { COPYHOLDER_MOCK_SCRIPT: JSON.stringify({ breathPeriodS: 6 }) },
      runMs: 5 * 60_000,
    },
    root,
    testInfo,
  );

  expectFiles(run, [
    'manifest.json', 'audio.wav', 'stamps.jsonl', 'samples.jsonl', 'events.jsonl', 'detector_in.jsonl',
    'tap.log', 'smoke_report.json',
  ]);
  expectSchemas(run);
  expectManifest(run, 'smoke', ['audio.wav', 'stamps.jsonl', 'samples.jsonl', 'events.jsonl', 'detector_in.jsonl']);
  expectAudio(run);
  expectSteps(run, steps);
  expectEvents(run);
  expect(clickCount(run)).toBe(0);
  expect(run.session.samples.length, 'samples.jsonl lines from the mock tap').toBeGreaterThan(1000);
  expect(run.session.detectorIn.length, 'detector_in.jsonl lines from the worker').toBeGreaterThan(100);
  // no narrator in smoke: Deck's output stays silent the whole run
  expect(run.narrator.size).toBe(0);
  expect(rmsDb(run.session.ch1, 0, run.session.ch1.length)).toBeLessThan(SILENT_MAX_DB);

  const line = expectOneVerdict(run, /^SMOKE (OK|FAIL: .*)$/, true);
  tellVerdict('smoke', line, testInfo);
  expect(line).toBe('SMOKE OK');

  // smoke_report.json (analysis/smoke/report.ts) answers the ten day-one questions (spec 7.12)
  type Report = {
    schema: string; ok: boolean; verdict: string; reasons: string[];
    hard: { running: { ok: boolean }; trace_rate: { ok: boolean }; sdk_errors: { count: number } };
    questions: Record<string, { answer: string[]; sign?: number | null; agree?: boolean }>;
    clock_maps: { tap_to_audio: boolean }; schema_problems: { count: number } | null; load_error: string | null;
  };
  const report = readJson<Report>(join(run.dir, 'smoke_report.json'));
  expect([report.schema, report.ok, report.verdict, report.reasons]).toEqual(['smoke-report/1', true, 'SMOKE OK', []]);
  expect([report.hard.running.ok, report.hard.trace_rate.ok, report.hard.sdk_errors.count], 'hard conditions').toEqual([true, true, 0]);
  expect(Object.keys(report.questions), 'the ten questions, in order').toEqual([...QUESTION_KEYS]);
  for (const key of QUESTION_KEYS) expect(report.questions[key]?.answer.length ?? 0, `answer lines of ${key}`).toBeGreaterThan(0);
  expect(report.schema_problems === null || report.schema_problems.count === 0, 'schema problems').toBe(true);
  expect(report.load_error).toBeNull();
  expect(report.clock_maps.tap_to_audio, 'tap time mapped onto the audio clock').toBe(true);
  // question 3: the mock breathes once per 6 s cued cycle, so the three cued breaths give one sign
  const sign = report.questions['q3_trace_sign'];
  expect([sign?.agree, Math.abs(sign?.sign ?? 0)], 'question 3: one sign from the three cued breaths').toEqual([true, 1]);
  expect(run.pageErrors).toEqual([]);
  cleanUp(run);
});

test('doctor: the full run, DOCTOR FAIL on the loop clicks (and a track not at 48 kHz) only', { tag: '@slow' }, async ({}, testInfo) => {
  // about 6 minutes of scenario (loop check B comes 5 minutes after A), then the TTS self-test (8 minutes at most)
  testInfo.setTimeout(22 * 60_000);
  const root = mkdtempSync(join(tmpdir(), 'copyholder-e2e-doctor-'));
  const steps = buildDoctorScenario(DOCTOR_SAMPLE_CLIP);
  const run = await liveRun(
    {
      name: 'doctor',
      args: ['--mode', 'doctor'],
      person: async (page) => {
        const go = page.locator('#go', { hasText: 'Continue' });
        await expect(go).toBeVisible({ timeout: 30_000 });
        await expect(page.locator('#devices')).toBeVisible();
        await go.click();
        // loop check A (17 s), headset 8 s, floor 10 s and the sample twice (40 s)
        await chooseLevel(page, 150_000);
      },
      runMs: 18 * 60_000,
    },
    root,
    testInfo,
  );

  expectFiles(run, ['manifest.json', 'audio.wav', 'stamps.jsonl', 'events.jsonl', 'detector_in.jsonl', 'calib.json']);
  expectSchemas(run);
  expectManifest(run, 'doctor', ['audio.wav', 'stamps.jsonl', 'events.jsonl', 'detector_in.jsonl', 'calib.json']);
  expectAudio(run);
  expectSteps(run, steps);
  expectEvents(run);
  expect(clickCount(run), 'clicks of loop checks A and B').toBe(20);
  const a = stepSpan(run.session, 'loop_a');
  const b = stepSpan(run.session, 'loop_b');
  expect((b?.n0 ?? 0) - (a?.n0 ?? 0), 'loop check B five minutes after A').toBeGreaterThanOrEqual(DOCTOR_LOOP_GAP_SECONDS * SAMPLE_RATE_HZ - BLOCK_FRAMES);

  expectServed(run, { [DOCTOR_SAMPLE_CLIP]: join(REPO_ROOT, 'gate', 'level', DOCTOR_SAMPLE_CLIP) });
  expectNarratorPlayed(run, steps, ['headset', 'floor']);
  for (const loop of ['loop_a', 'loop_b']) {
    expect(stepDb(run.session, 1, loop), `channel 1 carries the clicks of ${loop}`).toBeGreaterThan(-70);
  }

  // doctor failed on the clicks of loop check A (and on the rate, without a 48 kHz track), so it kept
  // calib.json as host wrote it: the chosen level only
  const fails = [...doctorRateFailures(trackRate(run, testInfo)), DOCTOR_LOOP_A];
  const line = expectOneVerdict(run, /^DOCTOR (OK|FAIL: .*)$/, false);
  tellVerdict('doctor', line, testInfo);
  expect(line).toBe(`DOCTOR FAIL: ${fails[0]}`);
  expect(run.quickcheckLines.filter((l) => l.startsWith('FAIL'))).toEqual(fails.map((f) => `FAIL  ${f}`));
  expectDoctorReport(run, false);
  expect(run.quickcheckLines.filter((l) => l.startsWith('calib.json written')), 'no claim that doctor wrote calib.json').toEqual([]);
  const calib = readJson<Record<string, unknown>>(join(run.dir, 'calib.json'));
  expect(Object.keys(calib).sort(), 'calib.json as host wrote it').toEqual(['output_gain', 'schema']);
  expect(calib['output_gain']).toBeCloseTo(dbToGain(CHOSEN_LEVEL_DB), 9);
  expect(run.pageErrors).toEqual([]);
  cleanUp(run);
});
