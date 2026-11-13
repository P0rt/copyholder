// Deck and worker in Chromium with a fake microphone (spec 7.3 tests, 13.4).
// Run: PW_CHROMIUM_PATH=<chrome> npx playwright test tests/e2e/deck.spec.ts

import { expect, test, type Browser, type Page, type TestInfo } from '@playwright/test';
import type { ViteDevServer } from 'vite';
import type { Step } from '../../web/scenarios/format.ts';
import { loopCheckClicks } from '../../web/lib/clicks.ts';
import { DEFAULT_VAD_PARAMS, resolveVadParams, vadEdges, vadFrozenBlock, type DetectorInput } from '../../web/lib/core.ts';
import { replayFires } from '../../web/lib/detector-adapter.ts';
import { lineProblems } from '../../web/lib/testing/spec-lines.ts';
import { evenWords, noise, synthPassage, voicedTone, type SynthWord } from '../../web/lib/testing/synth.ts';
import { packetLines, statusLine, validationLine } from '../../web/lib/testing/tap-synth.ts';
import { interruptedWordIndex, normalizeWordTimings, playedFraction, resumeWordIndex } from '../../web/lib/timings.ts';
import { msToSamples } from '../../web/lib/units.ts';
import { E2E_DETECTOR, WARMUP_S } from './fixtures/detector-config.ts';
import { HARNESS_PATH, launchWithMic, startVite, writeWav } from './fixtures/env.ts';
import { FakeHost } from './fixtures/fake-host.ts';
import type { HarnessConfig, HarnessResult } from './fixtures/harness.ts';

type Line = Record<string, unknown>;

test.describe.configure({ mode: 'serial' });

let vite: { server: ViteDevServer; origin: string };

test.beforeAll(async () => {
  vite = await startVite();
});

test.afterAll(async () => {
  await vite?.server.close();
});

const END: Step = { k: 'end', name: 'end', text: '', lenSamples: 0 };

function playUntilEnd(name: string, clip: string): Step {
  return { k: 'play', name, text: '', lenSamples: 0, clip, untilClipEnd: true };
}

async function openHarness(mic: Float32Array, info: TestInfo): Promise<{ browser: Browser; page: Page; pageErrors: string[] }> {
  const browser = await launchWithMic(writeWav(info.outputPath('mic.wav'), mic));
  const page = await browser.newPage();
  const pageErrors: string[] = [];
  page.on('pageerror', (e) => pageErrors.push(e.message));
  await page.goto(vite.origin + HARNESS_PATH);
  await page.waitForFunction(() => typeof window.H !== 'undefined');
  return { browser, page, pageErrors };
}

async function runToDone(page: Page, host: FakeHost, timeoutMs: number): Promise<{ res: HarnessResult; doneN: number }> {
  await page.waitForFunction(() => window.H.done, null, { timeout: timeoutMs });
  const doneN = await page.evaluate(() => window.H.doneN);
  await expect.poll(() => host.log.ends.length, { timeout: 10_000 }).toBeGreaterThan(0);
  await expect.poll(() => host.log.chunks.reduce((a, c) => a + c.frames, 0), { timeout: 10_000 }).toBe(doneN);
  const res = await page.evaluate(() => window.H.result());
  return { res, doneN };
}

/** Blocks follow each other from n0 = 0 (spec 6.3); all but the last hold 9600 frames; nothing after {t:end}. */
function expectContiguousAudio(host: FakeHost, doneN: number): { ch0: Float32Array; ch1: Float32Array } {
  expect(host.log.chunks.length).toBeGreaterThan(0);
  expect(host.log.chunks[0]?.n0).toBe(0);
  let next = 0;
  for (const c of host.log.chunks) {
    expect(c.n0).toBe(next);
    next = c.n0 + c.frames;
  }
  expect(host.log.chunks.slice(0, -1).every((c) => c.frames === 9_600)).toBe(true);
  expect(next).toBe(doneN);
  expect(host.log.frames.at(-1)?.t).toBe('end');
  return host.recording();
}

/** Stamps, detector inputs and events pass core/schemas in the key order of spec 8.1. */
function expectSpecLines(host: FakeHost): void {
  expect(lineProblems('stamps.jsonl', host.log.stamps)).toEqual([]);
  expect(lineProblems('detector_in.jsonl', host.log.det)).toEqual([]);
  expect(lineProblems('events.jsonl', host.log.events)).toEqual([]);
}

function silentFrom(ch1: Float32Array, from: number, to: number): number {
  for (let t = from; t < to; t++) if (ch1[t] !== 0) return t;
  return -1;
}

function of(stamps: Line[], k: string): Line[] {
  return stamps.filter((s) => s.k === k);
}

test('a stop in a narrator pause follows the same rule as one mid-word: nSilent = nCmd + 384', async ({}, info) => {
  test.setTimeout(120_000);
  const host = new FakeHost();
  await host.start();
  const { browser, page, pageErrors } = await openHarness(new Float32Array(48_000), info);
  try {
    const words = evenWords(6, 900, 1100, 1000); // word i: 1000+2000i .. 1900+2000i ms
    const gain = 0.5;
    const cfg: HarnessConfig = {
      mode: 'session', worker: 'page', sessionUrl: host.sessionUrl(), gain,
      passages: [{ name: 'p1', words, totalMs: 13_000 }],
      steps: [playUntilEnd('passage_1', 'p1'), END],
    };
    await page.evaluate((c) => window.H.start(c), cfg);
    // In the pause after word 0, in the middle of word 2, at 90% of word 4.
    await page.evaluate((p) => window.H.holdAtPtr(p, 'pause'), msToSamples(2_450));
    await page.evaluate((p) => window.H.holdAtPtr(p, 'mid-word'), msToSamples(5_450));
    await page.evaluate((p) => window.H.holdAtPtr(p, 'late-word'), msToSamples(9_810));
    const { res, doneN } = await runToDone(page, host, 60_000);
    expect(res.errors).toEqual([]);
    expect(pageErrors).toEqual([]);
    const { ch1 } = expectContiguousAudio(host, doneN);
    expectSpecLines(host);
    expect(host.log.stamps).toEqual(res.stamps);

    const stamps = res.stamps as unknown as Line[];
    const pcm = synthPassage(words, 13_000);
    const W = normalizeWordTimings(words);
    const holds = of(stamps, 'hold');
    const resumes = of(stamps, 'resume');
    const arr = new Map(of(stamps, 'arr').map((s) => [s.seq, s.n]));
    expect(holds.map((h) => h.cause)).toEqual(['chest', 'chest', 'chest']);
    expect(resumes).toHaveLength(3);
    // Narrating segments: start sample and read position at that sample.
    const segments: Array<{ n: number; ptr: number; fadeIn: boolean }> = [];
    let lastResumeWord: number | null = null;
    for (const s of stamps) {
      if (s.k === 'resume') lastResumeWord = s.word as number;
      if (s.k === 'state' && s.s === 'narrating') {
        const ptr = lastResumeWord === null ? 0 : (W.startSamples[lastResumeWord] as number);
        segments.push({ n: s.n as number, ptr, fadeIn: lastResumeWord !== null });
        lastResumeWord = null;
      }
    }
    expect(segments).toHaveLength(4);
    const kinds: string[] = [];
    holds.forEach((h, i) => {
      const nCmd = h.n as number;
      const r = resumes[i] as Line;
      expect(arr.get(h.seq)).toBe(nCmd); // nCmd = nArr: one message (spec 6.2)
      expect(h.nSilent).toBe(nCmd + 384);
      expect(r.n).toBe(nCmd + 384 + 72_000); // H = 72000 samples from nSilent, no voice
      expect(silentFrom(ch1, nCmd + 384, r.n as number)).toBe(-1);
      const seg = segments[i] as { n: number; ptr: number };
      const p = seg.ptr + (nCmd - seg.n);
      const iw = interruptedWordIndex(W, p);
      const inWord = p >= (W.startSamples[iw] ?? Infinity);
      kinds.push(!inWord ? 'pause' : playedFraction(W, iw, p) >= 0.8 ? 'late-word' : 'mid-word');
      expect(h.word).toBe(iw);
      expect(r.word).toBe(resumeWordIndex(W, p));
      for (let j = 0; j < 384; j++) {
        const want = Math.fround(((pcm[p + j] as number) * ((1 * (384 - j)) / 384)) * gain);
        expect(Math.abs((ch1[nCmd + j] as number) - want)).toBeLessThan(1e-6);
      }
    });
    expect(kinds).toEqual(['pause', 'mid-word', 'late-word']);
    expect(holds.map((h) => h.word)).toEqual([1, 2, 4]);
    expect(resumes.map((r) => r.word)).toEqual([1, 2, 5]);
    // Every narrated sample: passage sample at the read position, gain, 10 ms fade-in after a resume.
    segments.forEach((seg, i) => {
      const end = (holds[i]?.n as number | undefined) ?? (of(stamps, 'state').find((s) => s.s === 'idle')?.n as number);
      let worst = 0;
      for (let t = seg.n; t < end; t++) {
        const j = t - seg.n;
        const env = seg.fadeIn && j < 480 ? (j + 1) / 480 : 1;
        const want = Math.fround(((pcm[seg.ptr + j] ?? 0) * env) * gain);
        worst = Math.max(worst, Math.abs((ch1[t] as number) - want));
      }
      expect(worst).toBeLessThan(1e-6);
    });
  } finally {
    await browser.close();
    await host.close();
  }
});

test('voice edges recompute offline from channel 0; the audio safety is never recorded as chest', async ({}, info) => {
  test.setTimeout(120_000);
  // Microphone, 6 s period: breath-like noise 2.0-2.6 s, then 1 s of voiced sound.
  const mic = new Float32Array(6 * 48_000);
  mic.set(noise(msToSamples(600), 0.03, 99), msToSamples(2_000));
  mic.set(voicedTone(48_000, 140, 0.2), msToSamples(2_600));
  const host = new FakeHost();
  await host.start();
  const { browser, page, pageErrors } = await openHarness(mic, info);
  try {
    const words = evenWords(30, 300, 200, 200);
    const cfg: HarnessConfig = {
      mode: 'session', worker: 'page', sessionUrl: host.sessionUrl(), gain: 0.5,
      passages: [{ name: 'p1', words, totalMs: 15_200 }],
      // The passage starts 400 ms after the first voice_on, while the voice is still on.
      steps: [
        { k: 'wait', name: 'ready', text: 'Ready?', lenSamples: 0, until: 'button', button: 'Start' },
        playUntilEnd('passage_1', 'p1'),
        END,
      ],
      goAfterVoiceOnMs: 400,
      chestOnVoiceOn: [1, 4],
      probeAfterSafetyMs: 150,
    };
    await page.evaluate((c) => window.H.start(c), cfg);
    const { res, doneN } = await runToDone(page, host, 90_000);
    expect(res.errors).toEqual([]);
    expect(pageErrors).toEqual([]);
    const { ch0, ch1 } = expectContiguousAudio(host, doneN);
    expectSpecLines(host);
    const stamps = res.stamps as unknown as Line[];

    // Recorded voice edges equal the edges recomputed from the recorded channel 0 (spec 7.3, 13.4).
    const recorded = of(stamps, 'voice').map((v) => ({ n: v.n, on: v.on }));
    expect(recorded.length).toBeGreaterThanOrEqual(4);
    expect(vadEdges(ch0, DEFAULT_VAD_PARAMS, 0).map((e) => ({ n: e.n, on: e.on }))).toEqual(recorded);
    // Breath noise before the voiced sound gives no voice_on (spec 7.3): the noise was recorded (RMS about
    // 0.017), and the 30 ms before every voice_on hold the voiced tone (RMS about 0.07), not the noise.
    const rms = (a: number, b: number) => Math.sqrt(ch0.subarray(a, b).reduce((s, x) => s + x * x, 0) / (b - a));
    let noisy = 0;
    for (let a = 0; a + 480 <= ch0.length; a += 480) {
      const r = rms(a, a + 480);
      if (r > 0.008 && r < 0.03) noisy++;
    }
    expect(noisy).toBeGreaterThan(20);
    for (const v of of(stamps, 'voice').filter((x) => x.on)) {
      expect(rms((v.n as number) - 1_440, v.n as number)).toBeGreaterThan(0.04);
    }

    const sentHold = new Map(res.sentPkts.filter((p) => p.hold).map((p) => [p.seq, p.why]));
    const arr = new Map(of(stamps, 'arr').map((s) => [s.seq, s.n]));
    const voiceOn = of(stamps, 'voice').filter((v) => v.on).map((v) => v.n as number);
    const narrStarts = of(stamps, 'state').filter((s) => s.s === 'narrating').map((s) => s.n as number);
    const holds = of(stamps, 'hold');
    const safety = holds.filter((h) => h.cause === 'voice');
    const chest = holds.filter((h) => h.cause === 'chest');
    expect(safety.length).toBeGreaterThan(0);
    expect(chest.length).toBeGreaterThan(0);
    // A passage that starts after the voice held 250 ms stops in its first sample (spec 6.4).
    const first = safety[0] as Line;
    expect(first.n).toBe(narrStarts[0]);
    const onBefore = voiceOn.filter((n) => n <= (first.n as number)).at(-1) as number;
    expect((first.n as number) - onBefore).toBeGreaterThan(12_000);
    expect(stamps.filter((s) => s.k === 'state' && s.n === first.n).map((s) => s.s)).toEqual(['narrating', 'listening']);
    expect(silentFrom(ch1, first.nSilent as number, (of(stamps, 'resume')[0]?.n as number | undefined) ?? doneN)).toBe(-1);
    // Deck recorded the voice detector parameters it ran with (none given: the defaults).
    expect(res.vads).toEqual([{ k: 'vad', n: 0, source: 'default', params: vadFrozenBlock(DEFAULT_VAD_PARAMS) }]);
    for (const h of safety) {
      // No packet behind it: no seq; 250 ms after voice_on, or at once when narrating restarts with voice on.
      expect('seq' in h).toBe(false);
      const on = voiceOn.filter((n) => n <= (h.n as number)).at(-1) as number;
      expect(h.n === on + 12_000 || ((h.n as number) > on + 12_000 && narrStarts.includes(h.n as number))).toBe(true);
      expect(stamps).toContainEqual({ n: h.n, k: 'state', s: 'listening' });
    }
    for (const h of chest) {
      // Only a packet message with hold:true makes a chest stop: same seq, nCmd = nArr.
      expect(sentHold.get(h.seq as number)).toBe('chest-after-voice');
      expect(arr.get(h.seq)).toBe(h.n);
      const on = voiceOn.filter((n) => n <= (h.n as number)).at(-1) as number;
      expect((h.n as number) - on).toBeLessThan(12_000);
      expect(stamps).toContainEqual({ n: h.n, k: 'state', s: 'hold_wait' });
      expect(stamps).toContainEqual({ n: h.n, k: 'state', s: 'listening' });
    }
    // Probes sent while LISTENING after the safety are only stamped.
    const probes = res.sentPkts.filter((p) => p.why === 'probe').map((p) => p.seq);
    expect(probes.length).toBeGreaterThan(0);
    for (const seq of probes) {
      expect(of(stamps, 'ignored')).toContainEqual({ n: arr.get(seq), k: 'ignored', what: 'hold', seq, s: 'listening' });
    }
    for (const h of holds) {
      const r = of(stamps, 'resume').find((x) => (x.n as number) > (h.n as number));
      expect(silentFrom(ch1, h.nSilent as number, (r?.n as number | undefined) ?? doneN)).toBe(-1);
    }
  } finally {
    await browser.close();
    await host.close();
  }
});

test('the voice detector runs with the parameters of processorOptions and records them (spec 7.3)', async ({}, info) => {
  test.setTimeout(120_000);
  // Microphone, 6 s period: a quiet voiced tone 0.5-1.5 s, a loud one 3.5-4.5 s.
  const mic = new Float32Array(6 * 48_000);
  mic.set(voicedTone(48_000, 140, 0.02), msToSamples(500));
  mic.set(voicedTone(48_000, 140, 0.2), msToSamples(3_500));
  const host = new FakeHost();
  await host.start();
  const { browser, page, pageErrors } = await openHarness(mic, info);
  try {
    const vadParams = { floorDb: -45 };
    const cfg: HarnessConfig = {
      mode: 'session', worker: 'real', sessionUrl: host.sessionUrl(), vadParams, vadSource: 'test floor',
      passages: [],
      steps: [{ k: 'rest', name: 'listen', text: '', lenSamples: 13 * 48_000 }, END],
    };
    await page.evaluate((c) => window.H.start(c), cfg);
    const { res, doneN } = await runToDone(page, host, 60_000);
    expect(res.errors).toEqual([]);
    expect(pageErrors).toEqual([]);
    const { ch0 } = expectContiguousAudio(host, doneN);
    expectSpecLines(host);
    const P = resolveVadParams(vadParams);
    expect(host.log.events.filter((e) => e.e === 'vad')).toEqual([{ n: 0, e: 'vad', source: 'options', note: 'test floor', params: vadFrozenBlock(P) }]);
    // The recorded edges are the offline edges with the recorded parameters, not with the defaults.
    const recorded = of(host.log.stamps, 'voice').map((v) => ({ n: v.n, on: v.on }));
    expect(vadEdges(ch0, P, 0).map((e) => ({ n: e.n, on: e.on }))).toEqual(recorded);
    const ons = recorded.filter((e) => e.on).map((e) => e.n as number);
    expect(ons.length).toBeGreaterThanOrEqual(2);
    const rms = (a: number, b: number) => Math.sqrt(ch0.subarray(a, b).reduce((acc, x) => acc + x * x, 0) / Math.max(1, b - a));
    for (const n of ons) expect(rms(Math.max(0, n - 1_440), n)).toBeGreaterThan(0.04); // only the loud tone
    expect(vadEdges(ch0, DEFAULT_VAD_PARAMS, 0).filter((e) => e.on).length).toBeGreaterThan(ons.length);
  } finally {
    await browser.close();
    await host.close();
  }
});

/** Fake tap: kRunning, kOk, then packets at 30 Hz real time; 8x faster once the narrator reads. */
function driveTap(host: FakeHost, steepEvery: number, warmupS: number): () => void {
  let i = 0;
  let seq = 3;
  let fast = false;
  let steep: number[] = [];
  let stopped = false;
  host.onTapConnect = (h) => {
    h.sendTap(statusLine(1, 'kRunning'));
    h.sendTap(validationLine(2, 0));
  };
  host.onSessionFrame = (f) => {
    const line = f.line as Line | undefined;
    if (!fast && f.t === 'stamp' && line?.k === 'state' && line.s === 'narrating') {
      fast = true;
      const b0 = Math.ceil((i / 30 + warmupS) / 4);
      steep = Array.from({ length: 12 }, (_, k) => b0 + k * steepEvery);
    }
    if (f.t === 'end') stopped = true;
  };
  const timer = setInterval(() => {
    if (stopped || !host.tapConnected) return;
    for (let k = 0; k < (fast ? 8 : 1); k++) {
      host.sendTap(packetLines(i, i + 1, seq, { steepBreaths: steep })[0] as Line);
      i++;
      seq++;
    }
  }, 33);
  return () => clearInterval(timer);
}

test('worker path: SDK ok releases the scenario, holds come from step(), replaying detector_in gives the same fires', async ({}, info) => {
  test.setTimeout(150_000);
  const host = new FakeHost();
  await host.start();
  const stopTap = driveTap(host, 3, WARMUP_S);
  const { browser, page, pageErrors } = await openHarness(new Float32Array(48_000), info);
  try {
    const words: SynthWord[] = evenWords(28, 300, 200, 200);
    const gain = 0.5;
    const cfg: HarnessConfig = {
      mode: 'session', worker: 'real', sessionUrl: host.sessionUrl(), tapUrl: host.tapUrl(), detector: E2E_DETECTOR, gain,
      passages: [{ name: 'p1', words, totalMs: 14_200 }],
      steps: [
        { k: 'wait', name: 'sdk_start', text: 'Starting camera...', lenSamples: 0, until: 'sdk_ok' },
        { k: 'clicks', name: 'loop_a', block: 'A', text: 'Hold one earcup on the microphone', lenSamples: 552_000 },
        playUntilEnd('passage_1', 'p1'),
        END,
      ],
    };
    await page.evaluate((c) => window.H.start(c), cfg);
    const { res, doneN } = await runToDone(page, host, 120_000);
    stopTap();
    expect(res.errors).toEqual([]);
    expect(pageErrors).toEqual([]);
    const { ch1 } = expectContiguousAudio(host, doneN);
    expectSpecLines(host);
    const stamps = host.log.stamps;
    const det = host.log.det;
    const events = host.log.events;

    // /session starts with hello and consent; the wait step ended only after 5 s of Running with kOk.
    expect(host.log.firstFrameKind).toBe('text');
    expect(host.log.frames.slice(0, 2).map((f) => f.t)).toEqual(['hello', 'consent']);
    expect(res.fromWorker.filter((m) => m.k === 'sdk')).toContainEqual({ k: 'sdk', tap: 'running', ok: true });
    const loopA = stamps.find((s) => s.k === 'mark' && s.name === 'loop_a') as Line;
    expect(loopA.n as number).toBeGreaterThanOrEqual(240_000);
    // After its last frame the worker reports closed and passes host's quickcheck line on.
    await expect.poll(() => page.evaluate(() => window.H.fromWorker.map((m) => m.k)), { timeout: 10_000 }).toContain('quickcheck');
    const fromWorker = await page.evaluate(() => window.H.fromWorker);
    expect(fromWorker.slice(-2)).toEqual([{ k: 'closed' }, { k: 'quickcheck', ok: null, text: null }]);

    // detector_in: batch lines carry the tap values unchanged; one pkt (one arr stamp) per packet, in order.
    expect(det[0]).toEqual({ k: 'val', seq: 2, code: 0 });
    const batches = det.filter((d) => d.k === 'batch');
    expect(batches.length).toBeGreaterThan(300);
    for (const b of batches) {
      const sent = host.tapSent.get(b.seq as number) as Line;
      expect(JSON.stringify([b.tr, b.talk, b.g, b.hm])).toBe(JSON.stringify([sent.tr, sent.talk, sent.g, sent.hm]));
    }
    // Packets the worker passed on while Deck was finishing reach no quantum: at most the last few lack arr.
    const arrs = stamps.filter((s) => s.k === 'arr');
    expect(arrs.map((a) => a.seq)).toEqual(batches.slice(0, arrs.length).map((b) => b.seq));
    expect(batches.length - arrs.length).toBeLessThanOrEqual(8);
    const arr = new Map(arrs.map((s) => [s.seq, s.n]));
    expect(det.filter((d) => d.k === 'state').map((d) => d.s)).toContain('narrating');

    // Replay identity (spec 7.3, 7.4): the logged inputs through a fresh step() give the same fires.
    // A packet Deck never stamped (after its last quantum) has no nArr, so its fire is not written.
    const live = events.filter((e) => e.e === 'fire');
    const replay = replayFires(E2E_DETECTOR, det as unknown as DetectorInput[]).filter((f) => arr.has(f.seq));
    expect(live.length).toBeGreaterThan(0);
    expect(replay.map((f) => [f.seq, f.v, f.theta])).toEqual(live.map((f) => [f.seq, f.v, f.theta]));
    for (const f of live) {
      expect(f.n).toBe(arr.get(f.seq));
      const hold = stamps.find((s) => s.k === 'hold' && s.seq === f.seq);
      const ignored = stamps.find((s) => s.k === 'ignored' && s.seq === f.seq);
      expect(Boolean(hold) !== Boolean(ignored)).toBe(true);
      if (hold) expect(hold.n).toBe(f.n);
    }
    // Hold and resume events mirror Deck's stamps; no voice, so every resume is a timeout.
    const holdStamps = stamps.filter((s) => s.k === 'hold');
    expect(holdStamps.length).toBeGreaterThan(0);
    expect(holdStamps.every((h) => h.cause === 'chest')).toBe(true);
    expect(events.filter((e) => e.e === 'hold')).toEqual(holdStamps.map((h) => ({
      n: h.n, e: 'hold', cause: h.cause, nCmd: h.n, nSilent: h.nSilent, word: h.word,
    })));
    for (const r of events.filter((e) => e.e === 'resume')) expect(r.why).toBe('timeout');
    for (const h of holdStamps) {
      const r = stamps.find((s) => s.k === 'resume' && (s.n as number) > (h.n as number));
      expect(r?.n).toBe((h.nSilent as number) + 72_000);
      expect(silentFrom(ch1, h.nSilent as number, r?.n as number)).toBe(-1);
    }
    expect(events.some((e) => e.e === 'armed' && e.on === true)).toBe(true);

    // Loop check A: 10 clicks at the scheduled samples, in channel 1 after the gain.
    const clicks = loopCheckClicks();
    const clickStamps = stamps.filter((s) => s.k === 'click');
    expect(clickStamps).toEqual(clicks.offsetsSamples.map((o, i) => ({ n: (loopA.n as number) + o, k: 'click', i })));
    for (const c of clickStamps) {
      for (let j = 0; j < clicks.waveform.length; j++) {
        expect(ch1[(c.n as number) + j]).toBe(Math.fround((clicks.waveform[j] as number) * gain));
      }
    }
    // The page gets every click, to flash the square (spec 15.4).
    expect(res.main.filter((m) => m.k === 'click')).toEqual(clickStamps.map((c) => ({ k: 'click', n: c.n, i: c.i, block: 'A' })));
    // The voice detector parameters Deck ran with (spec 7.3).
    expect(events.filter((e) => e.e === 'vad')).toEqual([{ n: 0, e: 'vad', source: 'default', params: vadFrozenBlock(DEFAULT_VAD_PARAMS) }]);
  } finally {
    stopTap();
    await browser.close();
    await host.close();
  }
});

test('gate mode: step() runs but nothing it answers is written; the narrator never stops', async ({}, info) => {
  test.setTimeout(120_000);
  const host = new FakeHost();
  await host.start();
  const stopTap = driveTap(host, 2, 3);
  const { browser, page, pageErrors } = await openHarness(new Float32Array(48_000), info);
  try {
    const words = evenWords(14, 300, 200, 200);
    const cfg: HarnessConfig = {
      mode: 'gate', worker: 'real', sessionUrl: host.sessionUrl(), tapUrl: host.tapUrl(), detector: E2E_DETECTOR,
      passages: [{ name: 'p1', words, totalMs: 7_200 }],
      steps: [
        { k: 'wait', name: 'sdk_start', text: 'Starting camera...', lenSamples: 0, until: 'sdk_ok' },
        playUntilEnd('listening', 'p1'),
        END,
      ],
    };
    await page.evaluate((c) => window.H.start(c), cfg);
    const { res, doneN } = await runToDone(page, host, 90_000);
    stopTap();
    expect(res.errors).toEqual([]);
    expect(pageErrors).toEqual([]);
    expectContiguousAudio(host, doneN);
    expectSpecLines(host);
    expect(host.log.events.filter((e) => ['fire', 'hold', 'resume', 'armed'].includes(e.e as string))).toEqual([]);
    expect(host.log.stamps.filter((s) => s.k === 'hold' || s.k === 'ignored')).toEqual([]);
    const batches = host.log.det.filter((d) => d.k === 'batch');
    expect(batches.length).toBeGreaterThan(100);
    const arrCount = host.log.stamps.filter((s) => s.k === 'arr').length;
    expect(batches.length - arrCount).toBeGreaterThanOrEqual(0);
    expect(batches.length - arrCount).toBeLessThanOrEqual(8);
    expect(host.log.stamps.filter((s) => s.k === 'state').map((s) => s.s)).toEqual(['narrating', 'idle']);
  } finally {
    stopTap();
    await browser.close();
    await host.close();
  }
});
