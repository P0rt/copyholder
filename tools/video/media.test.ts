// npm run video on real (tiny) media: a synthetic screen recording (320 x 240, 30 fps, a white
// square flashing at known times next to a blinking cursor) and a matching session folder
// (audio.wav, stamps.jsonl). Checks the recovered offset, a missing flash, the refusals, and one
// whole cut whose picture and sound line up; then title cards and joining. A second session holds
// Deck's click itself on channel 1 at every stamped sample, and two harder recordings go through
// the whole cut: one at an uneven frame rate (as macOS records the screen) and one whose first
// frame is at 1.3 s. The same cuts and cards with the captions drawn by Chrome (--captions png, and
// an ffmpeg without drawtext) keep every frame and every flash where drawtext mode has them, with
// each caption where and while it belongs, its box on the pixels of drawtext's. A whole cut runs
// in each caption mode this machine has: drawtext where ffmpeg has it, PNG pictures where a Chrome
// starts (so on the Mac, whose ffmpeg has no drawtext, in PNG mode). Skipped where ffmpeg and
// ffprobe are not installed; the Chrome tests also where no Chrome or Chromium starts.

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { encodeStereoFloatWav } from '../../analysis/lib/wav.ts';
import { clickWaveform } from '../../core/clock/index.ts';
import { DEMO_CLICK_STARTS_MS } from '../../web/lib/clicks.ts';
import { cardLines, parseCards } from './cards.ts';
import { boxPad, captionFiles, captionLayout, cutFilter, cutFilterPng, SOUND_LINE_S, type CutOutput, type CutPlan } from './cut.ts';
import { ffmpegCaps, findFont, NO_DRAWTEXT_HINT, passthroughArgs, probeMedia, runTool, toolsFrom, type FfmpegCaps } from './ffmpeg.ts';
import { detectFlashes, type Rect } from './flash.ts';
import { matchFlashes } from './match.ts';
import { main } from './run.ts';
import { clickGroups, clickRefs, loadVideoSession } from './session.ts';
import { chromePath, launchChrome } from './textpng.ts';

const RATE = 48_000;
const FPS = 30;
const has = (cmd: string, args: string[]): boolean => {
  try {
    return spawnSync(cmd, args, { stdio: ['ignore', 'pipe', 'ignore'] }).status === 0;
  } catch {
    return false;
  }
};
const HAVE_FFMPEG = has('ffmpeg', ['-version']) && has('ffprobe', ['-version']);
const HAVE_DRAWTEXT =
  HAVE_FFMPEG && /\sdrawtext\s/.test(spawnSync('ffmpeg', ['-hide_banner', '-filters'], { encoding: 'utf8' }).stdout ?? '');
const HAVE_H264 =
  HAVE_FFMPEG && /\s(libx264|h264_videotoolbox)\s/.test(spawnSync('ffmpeg', ['-hide_banner', '-encoders'], { encoding: 'utf8' }).stdout ?? '');
const FONT = ((): string | null => {
  try {
    return findFont(undefined, process.platform);
  } catch {
    return null;
  }
})();
/** A Chrome starts as npm run video starts it: PW_CHROMIUM_PATH, else Playwright's own Chromium. */
const HAVE_CHROMIUM = await (async (): Promise<boolean> => {
  try {
    await (await launchChrome(chromePath(undefined, process.env))).close();
    return true;
  } catch {
    return false;
  }
})();
/** drawtext can write the captions here: this ffmpeg has it, and a font file is found. */
const CAN_DRAWTEXT = HAVE_DRAWTEXT && FONT !== null;
/** The caption modes a whole cut is made in here, drawtext first: none without an H.264 encoder. */
const CUT_MODES: ReadonlyArray<'drawtext' | 'png'> = HAVE_H264
  ? [...(CAN_DRAWTEXT ? (['drawtext'] as const) : []), ...(HAVE_CHROMIUM ? (['png'] as const) : [])]
  : [];
/** The sync square of the synthetic recordings. */
const SQUARE: Rect = { x: 16, y: 16, w: 48, h: 48 };

/** Recording time = session time + OFFSET_S: the screen recording started 0.6417 s before the session clock. */
const OFFSET_S = 0.6417;
/** Clicks (session s): three in a first block, then the demo clicks from 2.85 s. */
const FIRST = [0.8, 1.25, 2.07];
const DEMO_BASE_S = 2.85;
const DEMO = DEMO_CLICK_STARTS_MS.map((ms) => DEMO_BASE_S + ms / 1000);
const CLICKS_S = [...FIRST, ...DEMO];
const AUDIO_S = 7;
const LRT_MS = 25;
/** A narrator burst on channel 1 and a voice burst on channel 0 (session s), both inside the cut. */
const NARRATOR_AT_S = 3.3;
const VOICE_AT_S = 4.5;

const tools = toolsFrom(process.env);
let caps: FfmpegCaps;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'video-media-test-'));
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

function burst(x: Float32Array, atS: number, amp: number, hz: number): void {
  const at = Math.round(atS * RATE);
  for (let i = 0; i < 0.3 * RATE; i++) x[at + i] = (x[at + i] as number) + amp * Math.cos((2 * Math.PI * hz * i) / RATE);
}

/**
 * The session folder: audio.wav in 0.5 s chunks, click stamps, step marks. Its sound is either a
 * narrator burst on channel 1 and a voice burst on channel 0 ('bursts'), or Deck's click on
 * channel 1, the narrator as played, at every stamped click sample ('clicks').
 */
function writeSession(dir: string, sound: 'bursts' | 'clicks' = 'bursts'): void {
  fs.mkdirSync(dir, { recursive: true });
  const n = AUDIO_S * RATE;
  const ch0 = new Float32Array(n);
  const ch1 = new Float32Array(n);
  let s = 5;
  for (let i = 0; i < n; i++) {
    s = (s * 1_103_515_245 + 12_345) % 2_147_483_648;
    ch0[i] = 1e-4 * (2 * (s / 2_147_483_648) - 1);
  }
  if (sound === 'bursts') {
    burst(ch1, NARRATOR_AT_S, 0.5, 500);
    burst(ch0, VOICE_AT_S, 0.05, 300);
  } else {
    const click = clickWaveform();
    for (const t of CLICKS_S) ch1.set(click, Math.round(t * RATE));
  }
  fs.writeFileSync(path.join(dir, 'audio.wav'), encodeStereoFloatWav(ch0, ch1));
  const stamps: Array<Record<string, unknown>> = [];
  for (let k = 0; k < n; k += RATE / 2) stamps.push({ n: k, k: 'chunk', frames: RATE / 2 });
  stamps.push({ n: 0.2 * RATE, k: 'mark', what: 'step', name: 'intro' });
  FIRST.forEach((t, i) => stamps.push({ n: Math.round(t * RATE), k: 'click', i }));
  stamps.push({ n: 2.9 * RATE, k: 'mark', what: 'step', name: 'passage' });
  DEMO.forEach((t, i) => stamps.push({ n: Math.round(t * RATE), k: 'click', i }));
  stamps.push({ n: 5.8 * RATE, k: 'mark', what: 'step', name: 'outro' });
  stamps.sort((a, b) => (a['n'] as number) - (b['n'] as number));
  fs.writeFileSync(path.join(dir, 'stamps.jsonl'), stamps.map((x) => `${JSON.stringify(x)}\n`).join(''));
}

/** An 8 s screen recording (it runs past the session's end): the 48 px square at (16, 16) white for 100 ms from each flash time, a cursor blinking at (200, 120). */
async function writeScreen(file: string, flashesS: readonly number[]): Promise<void> {
  const on = flashesS.map((t) => `gte(t,${t.toFixed(4)})*lt(t,${(t + 0.1).toFixed(4)})`).join('+') || '0';
  const graph =
    `color=c=black:s=320x240:r=${FPS}:d=8,` +
    `drawbox=x=200:y=120:w=4:h=16:color=white:t=fill:enable='lt(mod(t,1),0.5)',` +
    `drawbox=x=100:y=180:w=120:h=10:color=gray:t=fill,` +
    `drawbox=x=16:y=16:w=48:h=48:color=white:t=fill:enable='${on}'`;
  const codec = caps.libx264 ? ['-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '12', '-pix_fmt', 'yuv420p'] : ['-c:v', 'mpeg4', '-q:v', '2'];
  const r = await runTool(tools.ffmpeg, ['-hide_banner', '-nostdin', '-y', '-v', 'error', '-f', 'lavfi', '-i', graph, ...codec, file]);
  if (r.code !== 0) throw new Error(`could not make ${file}: ${r.stderr}`);
}

const flashTimes = (clicks: readonly number[]): number[] => clicks.map((c) => c + OFFSET_S);

interface ScreenShape {
  /** Frame rate of the drawn frames. */
  fps: number;
  /**
   * Drop frames in an uneven pattern, as macOS does while the screen stands still: 4 of every 7
   * are kept, and every frame where the square changes, since a change always gets its frame.
   */
  uneven?: boolean;
  /** Time of the first frame in the file (s); the content is drawn from 0 as before. */
  startS?: number;
}

/** Like writeScreen, at another rate or shape; the square is bright on whole frames from each flash time for 100 ms. */
async function writeShapedScreen(file: string, flashesS: readonly number[], shape: ScreenShape): Promise<void> {
  const frames = flashesS.map((t) => [Math.ceil(t * shape.fps - 1e-9), Math.ceil((t + 0.1) * shape.fps - 1e-9)] as const);
  const filters = [
    `color=c=black:s=320x240:r=${shape.fps}:d=8`,
    `drawbox=x=200:y=120:w=4:h=16:color=white:t=fill:enable='lt(mod(t,1),0.5)'`,
    'drawbox=x=100:y=180:w=120:h=10:color=gray:t=fill',
    `drawbox=x=16:y=16:w=48:h=48:color=white:t=fill:enable='${frames.map(([on, off]) => `between(n,${on},${off - 1})`).join('+') || '0'}'`,
  ];
  if (shape.uneven) {
    const keep = [0, 2, 3, 5].map((k) => `eq(mod(n,7),${k})`).concat(frames.flatMap(([on, off]) => [`eq(n,${on})`, `eq(n,${off})`]));
    filters.push(`select='gt(${keep.join('+')},0)'`);
  }
  const codec = caps.libx264 ? ['-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '12', '-pix_fmt', 'yuv420p'] : ['-c:v', 'mpeg4', '-q:v', '2'];
  const sync = shape.uneven ? (caps.fpsMode ? ['-fps_mode', 'vfr'] : ['-vsync', 'vfr']) : [];
  const start = shape.startS === undefined ? [] : ['-output_ts_offset', String(shape.startS)];
  const r = await runTool(tools.ffmpeg, [
    '-hide_banner', '-nostdin', '-y', '-v', 'error', '-f', 'lavfi', '-i', filters.join(','),
    ...sync, ...codec, ...start, '-video_track_timescale', '600', file,
  ]);
  if (r.code !== 0) throw new Error(`could not make ${file}: ${r.stderr}`);
}

async function run(args: string[], env: NodeJS.ProcessEnv = {}): Promise<{ code: number; lines: string[] }> {
  const lines: string[] = [];
  const code = await main(args, {
    out: (l) => lines.push(l),
    env: { ...process.env, COPYHOLDER_SESSIONS_DIR: tmp, ...env },
    cwd: tmp,
    platform: process.platform,
    progress: false,
  });
  return { code, lines };
}

/** The times of every frame of a video's picture (s), as ffprobe reads them (a frame with side data ends its line with a comma). */
async function frameTimes(file: string): Promise<number[]> {
  const r = await runTool(tools.ffprobe, ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'frame=pts_time', '-of', 'csv=p=0', file]);
  if (r.code !== 0) throw new Error(r.stderr);
  return r.stdout
    .toString('utf8')
    .trim()
    .split(/\r?\n/)
    .map((l) => Number(l.split(',')[0]));
}

/** Every frame of a video's picture, cropped to `r`, as 8-bit gray rows. */
async function grayCrops(file: string, r: Rect): Promise<Uint8Array[]> {
  const res = await runTool(tools.ffmpeg, [
    '-v', 'error', '-i', file, '-an', '-vf', `crop=${r.w}:${r.h}:${r.x}:${r.y},format=gray`,
    ...passthroughArgs(caps), '-f', 'rawvideo', '-pix_fmt', 'gray', 'pipe:1',
  ]);
  if (res.code !== 0) throw new Error(res.stderr);
  const size = r.w * r.h;
  const frames: Uint8Array[] = [];
  for (let i = 0; i + size <= res.stdout.length; i += size) frames.push(new Uint8Array(res.stdout.subarray(i, i + size)));
  return frames;
}

/** Text pixels of a crop (brighter than 100 on the black screen): how many, and their box [x0, y0, x1, y1) in pixels of the video. */
function ink(f: Uint8Array, r: Rect): { count: number; box: [number, number, number, number] | null } {
  let count = 0;
  let [x0, y0, x1, y1] = [Infinity, Infinity, -Infinity, -Infinity];
  for (let y = 0; y < r.h; y++) {
    for (let x = 0; x < r.w; x++) {
      if (f[y * r.w + x]! <= 100) continue;
      count++;
      x0 = Math.min(x0, x);
      y0 = Math.min(y0, y);
      x1 = Math.max(x1, x + 1);
      y1 = Math.max(y1, y + 1);
    }
  }
  return { count, box: count === 0 ? null : [r.x + x0, r.y + y0, r.x + x1, r.y + y1] };
}

/** Rows with text in a crop, as bands [y0, y1) in pixels of the video, with the columns [x0, x1) of each. */
function inkBands(f: Uint8Array, r: Rect): Array<[number, number, number, number]> {
  const bands: Array<[number, number, number, number]> = [];
  for (let y = 0; y < r.h; y++) {
    const row = f.subarray(y * r.w, (y + 1) * r.w);
    const xs = [...row.keys()].filter((x) => row[x]! > 100);
    if (xs.length === 0) continue;
    const last = bands[bands.length - 1];
    const [a, b] = [r.x + xs[0]!, r.x + xs[xs.length - 1]! + 1];
    if (last && last[1] === r.y + y) bands[bands.length - 1] = [last[0], r.y + y + 1, Math.min(last[2], a), Math.max(last[3], b)];
    else bands.push([r.y + y, r.y + y + 1, a, b]);
  }
  return bands;
}

/** The click table a cut prints: the offset, every click with its flash and residual, the spread. */
function alignment(lines: readonly string[]): string[] {
  const from = lines.findIndex((l) => l.startsWith('Offset:'));
  const to = lines.findIndex((l) => l.startsWith('Residual spread'));
  expect(from).toBeGreaterThanOrEqual(0);
  expect(to).toBeGreaterThan(from);
  return lines.slice(from, to + 1);
}

/**
 * An ffmpeg as Homebrew builds it, without drawtext: the real one, with drawtext left out of
 * -filters, and refusing a filter graph that uses it.
 */
function ffmpegWithoutDrawtext(): string {
  const file = path.join(tmp, 'ffmpeg-without-drawtext');
  const real = `'${tools.ffmpeg.replace(/'/g, `'\\''`)}'`;
  fs.writeFileSync(
    file,
    [
      '#!/bin/sh',
      'case "$*" in *drawtext=*) echo "No such filter: \'drawtext\'" >&2; exit 1;; esac',
      `if [ "$2" = "-filters" ]; then ${real} "$@" | grep -v ' drawtext '; exit 0; fi`,
      `exec ${real} "$@"`,
      '',
    ].join('\n'),
  );
  fs.chmodSync(file, 0o755);
  return file;
}

/** The sound of a video as mono 48 kHz samples. */
async function decodeAudio(file: string): Promise<Float32Array> {
  const r = await runTool(tools.ffmpeg, ['-v', 'error', '-i', file, '-map', '0:a', '-ac', '1', '-ar', String(RATE), '-f', 'f32le', 'pipe:1']);
  if (r.code !== 0) throw new Error(r.stderr);
  const b = Buffer.from(r.stdout);
  return new Float32Array(b.buffer, b.byteOffset, Math.floor(b.length / 4));
}

/** Where each click starts in a sound (s): the first sample over a quarter of the peak after 50 ms below it. */
function clickOnsets(x: Float32Array): number[] {
  let peak = 0;
  for (const v of x) peak = Math.max(peak, Math.abs(v));
  const out: number[] = [];
  let last = Number.NEGATIVE_INFINITY;
  for (let i = 0; i < x.length; i++) {
    if (Math.abs(x[i]!) < 0.25 * peak) continue;
    if (i - last > 0.05 * RATE) out.push(i / RATE);
    last = i;
  }
  return out;
}

/** The residual the command printed for each demo click (s), in click order. */
function demoResiduals(lines: readonly string[]): number[] {
  return lines.flatMap((l) => {
    const m = /^ {2}demo \d+ +\S+ +\S+ +([+-]\d+\.\d) ms$/.exec(l);
    return m ? [Number(m[1]) / 1000] : [];
  });
}

/** Flash onsets of a written video minus the click onsets of its own sound (s), click by click, with both onsets. */
async function flashMinusClick(file: string): Promise<{ lags: number[]; frameS: number; flashes: number[]; clicks: number[] }> {
  const info = await probeMedia(tools, file);
  const f = await detectFlashes(tools, caps, info, SQUARE);
  const clicks = clickOnsets(await decodeAudio(file));
  expect(clicks).toHaveLength(DEMO.length);
  expect(f.onsets).toHaveLength(DEMO.length);
  return { lags: f.onsets.map((t, i) => t - clicks[i]!), frameS: 1 / info.fps, flashes: f.onsets, clicks };
}

/** An opaque white PNG of w x h: a caption picture whose every pixel shows where it lands. */
async function whitePicture(file: string, w: number, h: number): Promise<void> {
  // RGBA from the source on: in yuv420p it would lose an odd last column or row.
  const source = `color=c=white:s=${w}x${h}:d=1,format=rgba`;
  const r = await runTool(tools.ffmpeg, ['-hide_banner', '-nostdin', '-y', '-v', 'error', '-f', 'lavfi', '-i', source, '-frames:v', '1', file]);
  if (r.code !== 0) throw new Error(`could not make ${file}: ${r.stderr}`);
  const info = await probeMedia(tools, file);
  expect([info.width, info.height]).toEqual([w, h]);
}

/**
 * The first frame of a cut's video filter on a gray 320 x 240 picture, run in `dir` with the caption
 * files there and `pictures` as inputs 2 and up (input 1, the mix, is silence), as 8-bit gray rows.
 */
async function captionFrame(dir: string, graph: string, pictures: readonly string[]): Promise<Uint8Array> {
  const r = await runTool(
    tools.ffmpeg,
    [
      '-hide_banner', '-nostdin', '-v', 'error',
      '-f', 'lavfi', '-i', 'color=c=0x808080:s=320x240:r=30:d=1',
      '-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=stereo',
      ...pictures.flatMap((p) => ['-framerate', '30', '-i', p]),
      '-filter_complex', graph, '-map', '[v]', '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'gray', 'pipe:1',
    ],
    { cwd: dir },
  );
  if (r.code !== 0) throw new Error(r.stderr);
  expect(r.stdout.length).toBe(320 * 240);
  return new Uint8Array(r.stdout);
}

/** The box [x0, y0, x1, y1) of the pixels inside `r` of a 320 px wide frame that pass `test`; null when none do. */
function pixelBox(f: Uint8Array, r: Rect, test: (v: number) => boolean): [number, number, number, number] | null {
  let [x0, y0, x1, y1] = [Infinity, Infinity, -Infinity, -Infinity];
  for (let y = r.y; y < r.y + r.h; y++) {
    for (let x = r.x; x < r.x + r.w; x++) {
      if (!test(f[y * 320 + x]!)) continue;
      x0 = Math.min(x0, x);
      y0 = Math.min(y0, y);
      x1 = Math.max(x1, x + 1);
      y1 = Math.max(y1, y + 1);
    }
  }
  return x0 === Infinity ? null : [x0, y0, x1, y1];
}

describe.skipIf(!HAVE_FFMPEG)('npm run video on synthetic media', () => {
  const screens = {
    good: path.join(tmp, 'good.mov'),
    missing: path.join(tmp, 'missing.mov'),
    late: path.join(tmp, 'late.mov'),
    blank: path.join(tmp, 'blank.mov'),
  };

  beforeAll(async () => {
    caps = await ffmpegCaps(tools);
    writeSession(path.join(tmp, 'headstart-9'));
    const late = flashTimes(CLICKS_S);
    late[4] = (late[4] as number) + 0.15;
    await Promise.all([
      writeScreen(screens.good, flashTimes(CLICKS_S)),
      writeScreen(screens.missing, flashTimes(CLICKS_S.filter((_, i) => i !== 2))),
      writeScreen(screens.late, late),
      writeScreen(screens.blank, []),
    ]);
  }, 60_000);

  it('finds the square and recovers the offset within one frame', async () => {
    const info = await probeMedia(tools, screens.good);
    expect(info).toMatchObject({ width: 320, height: 240, fps: 30 });
    const f = await detectFlashes(tools, caps, info, null);
    expect(f.auto).toBe(true);
    expect(f.rect).toEqual({ x: 16, y: 16, w: 48, h: 48 });
    expect(f.onsets).toHaveLength(CLICKS_S.length);
    const session = loadVideoSession(path.join(tmp, 'headstart-9'));
    const refs = clickRefs(clickGroups(session.stamps, RATE));
    expect(refs.map((r) => r.label)).toEqual(['clicks 1', 'clicks 2', 'clicks 3', 'demo 1', 'demo 2', 'demo 3']);
    const m = matchFlashes(f.onsets, refs, { sampleRateHz: RATE, frameS: f.frameS, span: f.span });
    expect(m.ok).toBe(true);
    if (!m.ok) return;
    expect(Math.abs(m.result.offsetS - OFFSET_S)).toBeLessThan(1 / FPS);
    expect(m.result.spreadS).toBeLessThanOrEqual(1 / FPS + 1e-6);
  }, 60_000);

  it('aligns with one flash missing and names its click', async () => {
    const { code, lines } = await run(['headstart-9', '--screen', 'missing.mov', '--align-only']);
    expect(code).toBe(0);
    expect(lines.some((l) => /^ {2}clicks 3 +no flash near /.test(l))).toBe(true);
    expect(lines).toContain('ALIGNED. --align-only: no video written.');
    const offset = Number(/session time \+ (-?\d+\.\d+) s/.exec(lines.find((l) => l.startsWith('Offset:')) ?? '')?.[1]);
    expect(Math.abs(offset - OFFSET_S)).toBeLessThan(1 / FPS);
  }, 60_000);

  it('refuses a recording whose flash comes 150 ms late', async () => {
    const { code, lines } = await run(['headstart-9', '--screen', 'late.mov', '--align-only']);
    expect(code).toBe(1);
    expect(lines[lines.length - 1]).toMatch(/^VIDEO DID NOT RUN: The picture cannot be aligned to the sound: the residuals spread over \d+\.\d ms, more than 2 frames \(66\.7 ms\)\.$/);
    expect(lines.some((l) => /^ {2}demo 2 .* \+1\d\d\.\d ms$/.test(l))).toBe(true);
  }, 60_000);

  it('refuses a recording without the square', async () => {
    const { code, lines } = await run(['headstart-9', '--screen', 'blank.mov', '--align-only']);
    expect(code).toBe(1);
    expect(lines[lines.length - 1]).toMatch(/^VIDEO DID NOT RUN: No blinking square in the top-left 320 x 240 px/);
  }, 60_000);

  it.skipIf(CUT_MODES.length === 0)(
    'cuts the take with picture and sound in line, then makes title cards and joins them',
    async () => {
      // --captions auto: drawtext where this ffmpeg has it, else Chrome (on the Mac, Chrome). Where
      // it has drawtext but no font file is found, auto would stop for the font: Chrome draws.
      const captions = HAVE_DRAWTEXT && FONT === null ? ['--captions', 'png'] : [];
      const take = await run(['headstart-9', '--screen', 'good.mov', '--take', '1/2', '--lrt-ms', String(LRT_MS), ...captions, '--out', 'take.mp4']);
      expect(take.lines[take.lines.length - 1]).toMatch(/^Wrote .*take\.mp4: \d+\.\d s, 320 x 240, 30 fps, H\.264 \+ AAC\.$/);
      expect(take.code).toBe(0);
      // The cut opens with the demo click block (0.25 s before its first click) and runs to the end of the audio.
      const startS = DEMO_BASE_S;
      expect(take.lines.find((l) => l.startsWith('Cut:'))).toMatch(/^Cut: session 0:02\.9 \(the demo clicks\) to 0:07\.0 \(the end of the recording\), 4\.\d s;/);
      const out = path.join(tmp, 'take.mp4');
      const info = await probeMedia(tools, out);
      expect(info).toMatchObject({ width: 320, height: 240, fps: 30, hasAudio: true });
      expect(Math.abs(info.duration - (AUDIO_S - startS))).toBeLessThan(0.05);
      const streams = await runTool(tools.ffprobe, ['-v', 'error', '-show_entries', 'stream=codec_name,sample_rate,channels', '-of', 'json', out]);
      const parsed = JSON.parse(streams.stdout.toString('utf8')) as { streams: Array<Record<string, unknown>> };
      expect(parsed.streams).toEqual(
        expect.arrayContaining([expect.objectContaining({ codec_name: 'h264' }), expect.objectContaining({ codec_name: 'aac', sample_rate: '48000', channels: 2 })]),
      );

      // Picture: each demo flash within two frames of its click's sound (the square, not the captions).
      const f = await detectFlashes(tools, caps, info, SQUARE);
      expect(f.onsets).toHaveLength(DEMO.length);
      f.onsets.forEach((t, i) => {
        const d = t - (DEMO[i]! - startS);
        expect(d).toBeGreaterThan(-1 / FPS - 1e-6);
        expect(d).toBeLessThan(2 / FPS);
      });
      // Sound: the narrator burst L_rt later than on channel 1, the voice burst where it was.
      const audio = await decodeAudio(out);
      const firstLoud = (fromS: number): number => {
        for (let i = Math.round(fromS * RATE); i < audio.length; i++) if (Math.abs(audio[i]!) > 0.3) return i / RATE;
        return Number.NaN;
      };
      expect(Math.abs(firstLoud(0.1) - (NARRATOR_AT_S + LRT_MS / 1000 - startS))).toBeLessThan(0.005);
      expect(Math.abs(firstLoud(1.2) - (VOICE_AT_S - startS))).toBeLessThan(0.005);

      fs.writeFileSync(path.join(tmp, 'cards.json'), JSON.stringify({ cards: [{ text: 'A live take\nof the app', seconds: 1 }, { text: 'Take 1 of 2', seconds: 1.5 }] }));
      const cards = await run(['--cards', 'cards.json', '--like', 'take.mp4', ...captions, '--out', 'cards.mp4']);
      expect(cards.code).toBe(0);
      const cardsInfo = await probeMedia(tools, path.join(tmp, 'cards.mp4'));
      expect(cardsInfo).toMatchObject({ width: 320, height: 240, fps: 30, hasAudio: true });
      expect(cardsInfo.duration).toBeCloseTo(2.5, 1);

      const joined = await run(['--concat', 'cards.mp4', 'take.mp4', '--out', 'final.mp4']);
      expect(joined.code).toBe(0);
      const finalInfo = await probeMedia(tools, path.join(tmp, 'final.mp4'));
      expect(finalInfo).toMatchObject({ width: 320, height: 240, fps: 30, hasAudio: true });
      expect(Math.abs(finalInfo.duration - (cardsInfo.duration + info.duration))).toBeLessThan(0.05);
    },
    120_000,
  );

  it('lays each caption picture on the pixels of the box drawtext draws, at odd places too', async () => {
    const dir = path.join(tmp, 'places');
    fs.mkdirSync(dir, { recursive: true });
    const out: CutOutput = { fpsText: '30', fps: 30, width: 320, height: 240, scaleToHeight: null };
    const plan: CutPlan = { rateHz: RATE, nFrom: 0, nTo: RATE, durationS: 1, videoFromS: 0, seekS: 0, startAfterSeekS: 0, fromWhat: '', toWhat: '', notes: [] };
    const take = { k: 1, n: 2 };
    const l = captionLayout(320, 240);
    const [tp, sp] = [boxPad(l.take), boxPad(l.sound)];
    const topRight: Rect = { x: 160, y: 0, w: 160, h: 120 };
    const bottom: Rect = { x: 0, y: 120, w: 320, h: 120 };
    const size = (b: readonly number[]): [number, number] => [b[2]! - b[0]!, b[3]! - b[1]!];
    /**
     * Opaque white pictures of these sizes, overlaid as the cut overlays its captions: where their
     * pixels land, and how many pixels turned dark (none: the added column or row is transparent).
     */
    const land = async (takeSize: [number, number], soundSize: [number, number]) => {
      await whitePicture(path.join(dir, 'take.png'), ...takeSize);
      await whitePicture(path.join(dir, 'sound.png'), ...soundSize);
      const f = await captionFrame(dir, cutFilterPng(plan, out, take), ['take.png', 'sound.png']);
      const white = (v: number): boolean => v > 200;
      return { take: pixelBox(f, topRight, white), sound: pixelBox(f, bottom, white), dark: f.filter((v) => v < 100).length };
    };
    // drawtext puts a text of tw x th at x=w-tw-margin, y=margin (take) and x=(w-tw)/2, y=h-th-margin
    // (sound), its box pad px further out: places at odd and even columns and rows here (take: 233
    // and 234, row 3; sound: 22 and 23, rows 223 and 222), and overlay alone would round each odd one down.
    for (const [[tw, th], [sw, sh]] of [[[78, 8], [271, 9]], [[77, 9], [269, 10]]] as const) {
      const takeBox = [320 - tw - l.margin - tp, l.margin - tp, 320 - l.margin + tp, l.margin + th + tp];
      const soundX = Math.trunc((320 - sw) / 2) - sp;
      const soundBox = [soundX, 240 - sh - l.margin - sp, soundX + sw + 2 * sp, 240 - l.margin + sp];
      const got = await land(size(takeBox), size(soundBox));
      expect(got.take).toEqual(takeBox);
      expect(got.sound).toEqual(soundBox);
      expect(got.dark).toBe(0);
    }
    // Where this ffmpeg has drawtext (6.1 and newer: the box is the text's box, pad px around it),
    // pictures of the size of its own boxes land on them.
    if (CAN_DRAWTEXT && caps.yAlign) {
      for (const c of captionFiles(take)) fs.writeFileSync(path.join(dir, c.name), c.text, 'utf8');
      const drawn = await captionFrame(dir, cutFilter(plan, out, FONT!, take), []);
      const dark = (v: number): boolean => v < 100;
      const [takeBox, soundBox] = [pixelBox(drawn, topRight, dark), pixelBox(drawn, bottom, dark)];
      expect(takeBox).not.toBeNull();
      expect(soundBox).not.toBeNull();
      const got = await land(size(takeBox!), size(soundBox!));
      expect(got.take).toEqual(takeBox);
      expect(got.sound).toEqual(soundBox);
    }
  }, 60_000);

  it.skipIf(!HAVE_H264 || !HAVE_CHROMIUM)(
    'cuts the take with the captions drawn by Chrome (--captions png): frames and alignment as with drawtext, each caption where and while it belongs',
    async () => {
      // From 0.5 s to the end of the audio: 6.5 s, so the sound line shows for its 5 s and then goes.
      const args = ['headstart-9', '--screen', 'good.mov', '--take', '1/2', '--lrt-ms', String(LRT_MS), '--from', '0.5'];
      const png = await run([...args, '--captions', 'png', '--out', 'take-png.mp4']);
      expect(png.lines[png.lines.length - 1]).toMatch(/^Wrote .*take-png\.mp4: 6\.5 s, 320 x 240, 30 fps, H\.264 \+ AAC\.$/);
      expect(png.code).toBe(0);
      expect(png.lines).toContainEqual(expect.stringMatching(/^Captions drawn by Chrom(e|ium) \S+ as 2 PNG pictures \(--captions png\)\.$/));
      const out = path.join(tmp, 'take-png.mp4');

      // (a) The alignment --align-only prints, a frame every 1/30 s from 0, and every flash on its click.
      const plain = await run([...args, '--align-only']);
      expect(alignment(png.lines)).toEqual(alignment(plain.lines));
      const times = await frameTimes(out);
      expect(times).toHaveLength(6.5 * FPS);
      times.forEach((t, i) => expect(t).toBeCloseTo(i / FPS, 4));
      const flashes = await detectFlashes(tools, caps, await probeMedia(tools, out), SQUARE);
      expect(flashes.onsets).toHaveLength(CLICKS_S.length);
      flashes.onsets.forEach((t, i) => {
        const d = t - (CLICKS_S[i]! - 0.5);
        expect(d).toBeGreaterThan(-1 / FPS - 1e-6);
        expect(d).toBeLessThan(2 / FPS);
      });

      // (b) The take caption at the top right in every frame; the sound line centred at the bottom
      // in every frame before SOUND_LINE_S and in none after.
      const l = captionLayout(320, 240);
      const topRight: Rect = { x: 160, y: 0, w: 160, h: 40 };
      const bottom: Rect = { x: 0, y: 200, w: 320, h: 40 };
      const tops = (await grayCrops(out, topRight)).map((f) => ink(f, topRight));
      const bottoms = (await grayCrops(out, bottom)).map((f) => ink(f, bottom));
      expect(tops).toHaveLength(times.length);
      expect(bottoms).toHaveLength(times.length);
      for (const c of tops) expect(c.count).toBeGreaterThan(20);
      bottoms.forEach((c, i) => {
        if (times[i]! < SOUND_LINE_S) expect(c.count).toBeGreaterThan(20);
        else expect(c.count).toBe(0);
      });
      expect(bottoms.filter((c) => c.count > 0)).toHaveLength(SOUND_LINE_S * FPS);
      const [, ty0, tx1] = tops[0]!.box!;
      expect(tx1).toBeGreaterThanOrEqual(320 - l.margin - 4);
      expect(tx1).toBeLessThanOrEqual(320 - l.margin + 1);
      expect(ty0).toBeGreaterThanOrEqual(l.margin - 2);
      expect(ty0).toBeLessThanOrEqual(l.margin + 3);
      const [bx0, , bx1, by1] = bottoms[0]!.box!;
      expect(Math.abs((bx0 + bx1) / 2 - 160)).toBeLessThanOrEqual(3);
      expect(by1).toBeGreaterThanOrEqual(240 - l.margin - 3);
      expect(by1).toBeLessThanOrEqual(240 - l.margin + 2);

      // (c) Title cards: each card's lines where cardsPlan puts them, for the card's own seconds.
      const cardsSpec = { cards: [{ text: 'A live take\nof the app', seconds: 1 }, { text: 'Take 1 of 2', seconds: 1.5 }] };
      fs.writeFileSync(path.join(tmp, 'cards-png.json'), JSON.stringify(cardsSpec));
      const cards = await run(['--cards', 'cards-png.json', '--captions', 'png', '--like', 'take-png.mp4', '--out', 'cards-png.mp4']);
      expect(cards.code).toBe(0);
      expect(cards.lines).toContainEqual(expect.stringMatching(/^Cards drawn by Chrom(e|ium) \S+ as 2 PNG pictures \(--captions png\)\.$/));
      const cardsOut = path.join(tmp, 'cards-png.mp4');
      const cardsInfo = await probeMedia(tools, cardsOut);
      expect(cardsInfo).toMatchObject({ width: 320, height: 240, fps: 30, hasAudio: true });
      expect(cardsInfo.duration).toBeCloseTo(2.5, 1);
      const cardTimes = await frameTimes(cardsOut);
      expect(cardTimes).toHaveLength(2.5 * FPS);
      const whole: Rect = { x: 0, y: 0, w: 320, h: 240 };
      const cardFrames = await grayCrops(cardsOut, whole);
      expect(cardFrames).toHaveLength(cardTimes.length);
      const parsed = parseCards(JSON.stringify(cardsSpec));
      cardFrames.forEach((f, i) => {
        const lines = cardLines(parsed.cards[cardTimes[i]! < 1 ? 0 : 1]!, 320, 240);
        const bands = inkBands(f, whole);
        expect(bands).toHaveLength(lines.length);
        bands.forEach(([y0, y1, x0, x1], k) => {
          expect(y0).toBeGreaterThanOrEqual(lines[k]!.top);
          expect(y1).toBeLessThanOrEqual(lines[k]!.top + Math.ceil(1.3 * lines[k]!.size));
          expect(Math.abs((x0 + x1) / 2 - 160)).toBeLessThanOrEqual(3);
        });
      });

      // Where this ffmpeg has drawtext: the same frames, flashes and click table as drawtext mode,
      // and the text where drawtext writes it, to 2 px (Chrome measures and draws letters its own way).
      if (CAN_DRAWTEXT) {
        const near = (a: readonly number[] | null, b: readonly number[] | null): void => {
          expect(a).not.toBeNull();
          expect(b).not.toBeNull();
          a!.forEach((v, j) => expect(Math.abs(v - b![j]!)).toBeLessThanOrEqual(2));
        };
        const dt = await run([...args, '--captions', 'drawtext', '--out', 'take-drawtext.mp4']);
        expect(dt.code).toBe(0);
        const dtOut = path.join(tmp, 'take-drawtext.mp4');
        expect(alignment(dt.lines)).toEqual(alignment(png.lines));
        expect(await frameTimes(dtOut)).toEqual(times);
        expect((await detectFlashes(tools, caps, await probeMedia(tools, dtOut), SQUARE)).onsets).toEqual(flashes.onsets);
        const dtTops = (await grayCrops(dtOut, topRight)).map((f) => ink(f, topRight));
        const dtBottoms = (await grayCrops(dtOut, bottom)).map((f) => ink(f, bottom));
        expect(dtBottoms.map((c) => c.count > 0)).toEqual(bottoms.map((c) => c.count > 0));
        near(tops[0]!.box, dtTops[0]!.box);
        near(bottoms[0]!.box, dtBottoms[0]!.box);
        if (caps.yAlign) {
          const dtCards = await run(['--cards', 'cards-png.json', '--captions', 'drawtext', '--like', 'take-png.mp4', '--out', 'cards-drawtext.mp4']);
          expect(dtCards.code).toBe(0);
          const dtCardsOut = path.join(tmp, 'cards-drawtext.mp4');
          expect(await frameTimes(dtCardsOut)).toEqual(cardTimes);
          const dtFrames = await grayCrops(dtCardsOut, whole);
          dtFrames.forEach((f, i) => {
            const a = inkBands(f, whole);
            const b = inkBands(cardFrames[i]!, whole);
            expect(a).toHaveLength(b.length);
            a.forEach((band, k) => near(band, b[k]!));
          });
        }
      }
    },
    180_000,
  );

  it.skipIf(!HAVE_H264 || !HAVE_CHROMIUM)(
    'runs the cut, the cards and the join with an ffmpeg without drawtext: Chrome draws the captions',
    async () => {
      const ffmpeg = ffmpegWithoutDrawtext();
      const takeArgs = ['headstart-9', '--screen', 'good.mov', '--take', '2/2', '--lrt-ms', String(LRT_MS)];
      const take = await run([...takeArgs, '--ffmpeg', ffmpeg, '--out', 'take-auto.mp4']);
      expect(take.lines[take.lines.length - 1]).toMatch(/^Wrote .*take-auto\.mp4: 4\.\d s, 320 x 240, 30 fps, H\.264 \+ AAC\.$/);
      expect(take.code).toBe(0);
      expect(take.lines).toContainEqual(expect.stringMatching(/^Captions drawn by Chrom(e|ium) \S+ as 2 PNG pictures \(this ffmpeg has no drawtext filter\)\.$/));
      // The default cut, from the demo clicks: it starts 3.5 s into the recording, so ffmpeg seeks
      // (-ss) before it reads. Each demo flash within two frames of its click, as in drawtext mode.
      expect(take.lines.find((l) => l.startsWith('Cut:'))).toMatch(/^Cut: session 0:02\.9 \(the demo clicks\) to 0:07\.0 .*; recording 0:03\.5 to /);
      const autoOut = path.join(tmp, 'take-auto.mp4');
      const autoTimes = await frameTimes(autoOut);
      autoTimes.forEach((t, i) => expect(t).toBeCloseTo(i / FPS, 4));
      const autoFlashes = (await detectFlashes(tools, caps, await probeMedia(tools, autoOut), SQUARE)).onsets;
      expect(autoFlashes).toHaveLength(DEMO.length);
      autoFlashes.forEach((t, i) => {
        const d = t - (DEMO[i]! - DEMO_BASE_S);
        expect(d).toBeGreaterThan(-1 / FPS - 1e-6);
        expect(d).toBeLessThan(2 / FPS);
      });
      // Where the real ffmpeg has drawtext: the same click table, frames and flashes as its cut.
      if (CAN_DRAWTEXT) {
        const dt = await run([...takeArgs, '--captions', 'drawtext', '--out', 'take-auto-drawtext.mp4']);
        expect(dt.code).toBe(0);
        expect(alignment(dt.lines)).toEqual(alignment(take.lines));
        const dtOut = path.join(tmp, 'take-auto-drawtext.mp4');
        expect(await frameTimes(dtOut)).toEqual(autoTimes);
        expect((await detectFlashes(tools, caps, await probeMedia(tools, dtOut), SQUARE)).onsets).toEqual(autoFlashes);
      }
      fs.writeFileSync(path.join(tmp, 'cards-auto.json'), JSON.stringify([{ text: 'Take 2 of 2', seconds: 1 }]));
      const cards = await run(['--cards', 'cards-auto.json', '--like', 'take-auto.mp4', '--ffmpeg', ffmpeg, '--out', 'cards-auto.mp4']);
      expect(cards.code).toBe(0);
      expect(cards.lines).toContainEqual(expect.stringMatching(/^Cards drawn by Chrom(e|ium) \S+ as 1 PNG picture \(this ffmpeg has no drawtext filter\)\.$/));
      const joined = await run(['--concat', 'cards-auto.mp4', 'take-auto.mp4', '--ffmpeg', ffmpeg, '--out', 'final-auto.mp4']);
      expect(joined.code).toBe(0);
      const info = await probeMedia(tools, path.join(tmp, 'final-auto.mp4'));
      expect(info).toMatchObject({ width: 320, height: 240, fps: 30, hasAudio: true });

      // drawtext asked for by name is still refused; --align-only needs neither drawtext nor Chrome.
      const refused = await run(['headstart-9', '--screen', 'good.mov', '--captions', 'drawtext', '--ffmpeg', ffmpeg, '--out', 'never.mp4']);
      expect(refused.code).toBe(1);
      expect(refused.lines).toEqual([`VIDEO DID NOT RUN: ${NO_DRAWTEXT_HINT}`]);
      const aligned = await run(['headstart-9', '--screen', 'good.mov', '--align-only', '--captions', 'drawtext', '--chrome', 'no-such-chrome', '--ffmpeg', ffmpeg]);
      expect(aligned.code).toBe(0);
      expect(aligned.lines).toContain('ALIGNED. --align-only: no video written.');
      expect(fs.existsSync(path.join(tmp, 'never.mp4'))).toBe(false);
    },
    120_000,
  );

  it('names --chrome and PW_CHROMIUM_PATH when Chrome does not start, before any frame is read', async () => {
    const hint = 'Name it with --chrome <path> or PW_CHROMIUM_PATH, on the Mac "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome".';
    const cut = await run(['headstart-9', '--screen', 'good.mov', '--captions', 'png', '--chrome', 'no-such-chrome', '--out', 'never.mp4']);
    expect(cut.code).toBe(1);
    expect(cut.lines).not.toContain('Reading every frame for the flashes...');
    const line = cut.lines[cut.lines.length - 1]!;
    expect(line.startsWith('VIDEO DID NOT RUN: Chrome did not start to draw the captions (')).toBe(true);
    expect(line.endsWith(`; tried --chrome ${path.join(tmp, 'no-such-chrome')}). ${hint}`)).toBe(true);
    fs.writeFileSync(path.join(tmp, 'cards-never.json'), JSON.stringify([{ text: 'A card', seconds: 1 }]));
    const cards = await run(['--cards', 'cards-never.json', '--captions', 'png', '--out', 'never.mp4'], { PW_CHROMIUM_PATH: '/no/such/chrome' });
    expect(cards.code).toBe(1);
    expect(cards.lines[cards.lines.length - 1]!.endsWith(`; tried PW_CHROMIUM_PATH /no/such/chrome). ${hint}`)).toBe(true);
    expect(fs.existsSync(path.join(tmp, 'never.mp4'))).toBe(false);
  }, 60_000);
});

describe.skipIf(!HAVE_FFMPEG)('npm run video on an uneven frame rate, a late first frame and a clip without a rate', () => {
  /** Same clicks and steps as headstart-9; channel 1 holds the click itself at every stamped sample. */
  const CLICK_SESSION = 'headstart-12';
  const UNEVEN_FPS = 60;
  const FIRST_FRAME_S = 1.3;
  /**
   * The cuts start here (session s), 0.2383 s before the first demo click: 14.3 frames at 60 fps
   * and 7.15 at 30 fps. So the frames of a cut fall between frames of the recording, where it
   * matters which recorded frame each one shows.
   */
  const FROM = '2.8617';
  const screens = {
    uneven: path.join(tmp, 'uneven.mov'),
    lateStart: path.join(tmp, 'late-start.mov'),
  };

  beforeAll(async () => {
    caps = await ffmpegCaps(tools);
    writeSession(path.join(tmp, CLICK_SESSION), 'clicks');
    await Promise.all([
      writeShapedScreen(screens.uneven, flashTimes(CLICKS_S), { fps: UNEVEN_FPS, uneven: true }),
      writeShapedScreen(screens.lateStart, flashTimes(CLICKS_S), { fps: FPS, startS: FIRST_FRAME_S }),
    ]);
  }, 60_000);

  /**
   * Each flash of the cut against its click in the cut's own sound. The matching found each flash
   * `residual` after its click on the offset it chose: less than one source frame either way, as
   * every flash here has its own frame. The cut shows the flash from its first frame at or after
   * that instant, so at most one frame of its own later. 3 ms cover where a click is read in the sound.
   */
  function expectFlashesOnClicks(lags: readonly number[], residuals: readonly number[], sourceFrameS: number, outFrameS: number): void {
    expect(lags).toHaveLength(DEMO.length);
    expect(residuals).toHaveLength(DEMO.length);
    lags.forEach((d, i) => {
      const r = residuals[i]!;
      expect(Math.abs(r)).toBeLessThan(sourceFrameS);
      expect(d).toBeGreaterThan(r - 0.003);
      expect(d).toBeLessThan(r + outFrameS + 0.003);
    });
  }

  it('aligns a recording at an uneven frame rate by the times of its frames', async () => {
    const info = await probeMedia(tools, screens.uneven);
    expect(info.fps).toBe(UNEVEN_FPS);
    const { code, lines } = await run([CLICK_SESSION, '--screen', 'uneven.mov', '--align-only']);
    expect(code).toBe(0);
    expect(lines).toContain('ALIGNED. --align-only: no video written.');
    // About 4 frames in 7 kept: frame numbers are not times in this recording.
    const frames = Number(/ flashes in (\d+) frames\./.exec(lines.find((l) => l.startsWith('Square at')) ?? '')?.[1]);
    expect(frames).toBeLessThan(0.7 * 8 * UNEVEN_FPS);
    const offset = Number(/session time \+ (-?\d+\.\d+) s/.exec(lines.find((l) => l.startsWith('Offset:')) ?? '')?.[1]);
    expect(Math.abs(offset - OFFSET_S)).toBeLessThan(1 / UNEVEN_FPS);
  }, 60_000);

  /**
   * Cuts `screen` from FROM in every caption mode this machine has (CUT_MODES: drawtext where
   * ffmpeg has it, PNG pictures where a Chrome starts), each with every flash on its click in its
   * own sound. Where both modes run, they print the same click table and write the same frames at
   * the same times, with every flash and every click at the same instant. `recordingFrom` is where
   * the cut starts in the recording (m:ss.s): more than 3 s in, so ffmpeg seeks (-ss) before it reads.
   */
  async function cutInEachMode(screen: string, name: string, fps: number, recordingFrom: string): Promise<void> {
    const cuts: Array<{ mode: string; lines: string[]; times: number[]; flashes: number[]; clicks: number[] }> = [];
    for (const mode of CUT_MODES) {
      const file = `${name}-${mode}.mp4`;
      const { code, lines } = await run([CLICK_SESSION, '--screen', screen, '--from', FROM, '--lrt-ms', '0', '--captions', mode, '--out', file]);
      expect(lines[lines.length - 1]).toMatch(new RegExp(`^Wrote .*${file.replace('.', '\\.')}: 4\\.\\d s, 320 x 240, ${fps} fps, H\\.264 \\+ AAC\\.$`));
      expect(code).toBe(0);
      expect(lines.find((l) => l.startsWith('Cut:'))).toContain(`; recording ${recordingFrom} to `);
      const out = path.join(tmp, file);
      const { lags, frameS, flashes, clicks } = await flashMinusClick(out);
      expectFlashesOnClicks(lags, demoResiduals(lines), 1 / fps, frameS);
      cuts.push({ mode, lines, times: await frameTimes(out), flashes, clicks });
    }
    expect(cuts.map((c) => c.mode)).toEqual(CUT_MODES);
    for (const c of cuts.slice(1)) {
      expect(alignment(c.lines)).toEqual(alignment(cuts[0]!.lines));
      expect(c.times).toEqual(cuts[0]!.times);
      expect(c.flashes).toEqual(cuts[0]!.flashes);
      expect(c.clicks).toEqual(cuts[0]!.clicks);
    }
  }

  it.skipIf(CUT_MODES.length === 0)(
    'cuts a recording at an uneven frame rate with every flash on its click, the same in each caption mode',
    async () => {
      await cutInEachMode('uneven.mov', 'uneven', UNEVEN_FPS, '0:03.5');
    },
    120_000,
  );

  it.skipIf(CUT_MODES.length === 0)(
    'cuts a recording whose first frame is at 1.3 s with every flash on its click, the same in each caption mode',
    async () => {
      const probe = await runTool(tools.ffprobe, ['-v', 'error', '-show_entries', 'format=start_time', '-of', 'csv=p=0', screens.lateStart]);
      expect(Number(probe.stdout.toString('utf8').trim())).toBeCloseTo(FIRST_FRAME_S, 3);
      // Recording time counts from the first frame, as -ss does: the cut starts 3.5 s in.
      await cutInEachMode('late-start.mov', 'late-start', FPS, '0:03.5');
    },
    120_000,
  );

  it.skipIf(!HAVE_H264)('joins after a first clip without a readable frame rate once --fps is given', async () => {
    const make = async (file: string, inputs: string[], extra: string[]): Promise<void> => {
      const codec = caps.libx264 ? ['-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p'] : ['-c:v', 'mpeg4', '-q:v', '2'];
      const r = await runTool(tools.ffmpeg, ['-hide_banner', '-nostdin', '-y', '-v', 'error', ...inputs, ...codec, ...extra, path.join(tmp, file)]);
      if (r.code !== 0) throw new Error(`could not make ${file}: ${r.stderr}`);
    };
    // 2 frames per second is below the rates ffprobe's answer is taken for (5 to 240).
    await make('slow.mp4', ['-f', 'lavfi', '-i', 'color=c=gray:s=320x240:r=2:d=1'], []);
    await make('fast.mp4', ['-f', 'lavfi', '-i', 'color=c=black:s=320x240:r=30:d=1', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=1:sample_rate=48000'], ['-c:a', 'aac', '-shortest']);
    const refused = await run(['--concat', 'slow.mp4', 'fast.mp4', '--out', 'joined.mp4']);
    expect(refused.code).toBe(1);
    expect(refused.lines[refused.lines.length - 1]).toBe(`VIDEO DID NOT RUN: ${path.join(tmp, 'slow.mp4')}: no readable frame rate; give --fps`);
    const joined = await run(['--concat', 'slow.mp4', 'fast.mp4', '--fps', '30', '--out', 'joined.mp4']);
    expect(joined.code).toBe(0);
    expect(joined.lines[0]).toBe('Joining 2 clips, 2.0 s, into 320 x 240 at 30 fps.');
    const info = await probeMedia(tools, path.join(tmp, 'joined.mp4'));
    expect(info).toMatchObject({ width: 320, height: 240, fps: 30, hasAudio: true });
    expect(Math.abs(info.duration - 2)).toBeLessThan(0.1);
  }, 60_000);
});
