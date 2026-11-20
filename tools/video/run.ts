// npm run video (spec 13.3, 15.2-15.4): the demo video, put together with ffmpeg on the Mac.
//
//   npm run video -- [<session id or folder>] --screen <recording.mov> [--out <file.mp4>] [--take k/n]
//                    [--from <s | m:ss | step>] [--to <s | m:ss | step>] [--square x,y,w,h] [--lrt-ms <ms>]
//                    [--height <px>] [--fps <rate>] [--font <file>] [--max-spread-frames <n>] [--align-only]
//   npm run video -- --cards <cards.json> --out <cards.mp4> [--size WxH] [--fps <rate>] [--like <clip.mp4>] [--font <file>]
//   npm run video -- --concat <a.mp4> <b.mp4> [...] --out <final.mp4> [--size WxH] [--fps <rate>]
//   The take and the cards: [--captions auto|drawtext|png] [--chrome <path>]
//   Any of them: [--ffmpeg <path>] [--ffprobe <path>] [--keep-temp]
//
// The first form cuts the live take out of a macOS screen recording without sound (spec 15.4): it
// finds the flashes of the sync square, matches them to the click stamps of stamps.jsonl, refuses
// when they do not line up within 2 frames, and lays the app's own recording under the picture,
// the narrator channel moved L_rt later. By default the cut runs from the demo click block, 3 s
// before the text, to the prompt of loop check B after the signal check (spec 15.1, 15.2). Without
// a session id it takes the newest headstart or demo recording. The captions and the cards are
// drawn by ffmpeg's drawtext, or, by an ffmpeg without it (--captions auto) or with --captions png,
// as PNG pictures by Chrome (--chrome, else PW_CHROMIUM_PATH, else Playwright's own Chromium) that
// ffmpeg overlays. Exit 0 done, 1 refused or failed (one line says why), 2 wrong usage.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isMainModule } from '../../analysis/lib/cli.ts';
import { REPO_ROOT, shownPath } from '../../analysis/lib/paths.ts';
import { loadList, scanText } from '../lint-words.ts';
import { encodeMonoFloatWav, mixTrack } from './audio.ts';
import { cardsPlan, cardsText, parseCards, parseFps, parseSize } from './cards.ts';
import { concatArgs, concatTarget } from './concat.ts';
import {
  captionFiles,
  captionImages,
  clock,
  cutArgs,
  outputSize,
  parseTake,
  parseTimeArg,
  planCut,
  type CaptionFile,
  type CutOutput,
  type Take,
} from './cut.ts';
import {
  captionMode,
  checkRun,
  ffmpegCaps,
  findFont,
  findFontOrNone,
  parseCaptionChoice,
  parseRational,
  probeMedia,
  runTool,
  toolsFrom,
  VideoError,
  type CaptionChoice,
  type FfmpegCaps,
  type MediaInfo,
  type Tools,
} from './ffmpeg.ts';
import { detectFlashes, type FlashResult, type Rect } from './flash.ts';
import { matchFlashes, type MatchResult } from './match.ts';
import { chromePath, drawTextImages, type ChromePath, type TextImage } from './textpng.ts';
import {
  chooseLrt,
  clickGroups,
  clickRefs,
  doctorLrtHint,
  latestTake,
  loadVideoSession,
  sessionFolder,
  steps,
  type ClickGroup,
  type VideoSession,
} from './session.ts';

export const EXIT_OK = 0;
export const EXIT_REFUSED = 1;
export const EXIT_USAGE = 2;

export const USAGE = [
  'Usage:',
  '  npm run video -- [<session id>] --screen <recording.mov> [--out <file.mp4>] [--take k/n]',
  '                   [--from <s | m:ss | step>] [--to <s | m:ss | step>] [--square x,y,w,h] [--lrt-ms <ms>]',
  '                   [--height <px>] [--fps <rate>] [--font <file>] [--max-spread-frames <n>] [--align-only] [--rehearsal]',
  '  npm run video -- --cards <cards.json> --out <cards.mp4> [--size WxH] [--fps <rate>] [--like <clip.mp4>] [--font <file>]',
  '  npm run video -- --concat <a.mp4> <b.mp4> [...] --out <final.mp4> [--size WxH] [--fps <rate>]',
  '  The take and the cards: [--captions auto|drawtext|png] [--chrome <path>]',
  '  Any of them: [--ffmpeg <path>] [--ffprobe <path>] [--keep-temp]',
  'tools/video/README.md explains the steps.',
].join('\n');

/** The video is meant to be shorter than this (spec 15, 17.5). */
const MAX_VIDEO_S = 180;

const VALUE_FLAGS = [
  'screen', 'out', 'take', 'from', 'to', 'square', 'lrt-ms', 'height', 'fps', 'font', 'max-spread-frames',
  'cards', 'size', 'like', 'ffmpeg', 'ffprobe', 'captions', 'chrome',
] as const;
type ValueFlag = (typeof VALUE_FLAGS)[number];
const BOOL_FLAGS = ['align-only', 'keep-temp', 'help', 'rehearsal'] as const;
type BoolFlag = (typeof BOOL_FLAGS)[number];

export interface VideoArgs {
  session: string | null;
  values: Partial<Record<ValueFlag, string>>;
  flags: Set<BoolFlag>;
  /** The clips after --concat; null when --concat is not given, empty when it is given bare. */
  concat: string[] | null;
}

/** Splits the command line; an unknown flag, a missing value or a second session id is an error. */
export function parseArgs(argv: readonly string[]): VideoArgs | { error: string } {
  const out: VideoArgs = { session: null, values: {}, flags: new Set(), concat: null };
  let inConcat = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] as string;
    if (a === '-h' || a === '--help') {
      out.flags.add('help');
      continue;
    }
    if (a.startsWith('--')) {
      inConcat = false;
      const eq = a.indexOf('=');
      const name = eq > 0 ? a.slice(2, eq) : a.slice(2);
      if (name === 'concat') {
        inConcat = true;
        out.concat ??= [];
        if (eq > 0 && eq < a.length - 1) out.concat.push(a.slice(eq + 1));
        continue;
      }
      if ((BOOL_FLAGS as readonly string[]).includes(name)) {
        out.flags.add(name as BoolFlag);
        continue;
      }
      if (!(VALUE_FLAGS as readonly string[]).includes(name)) return { error: `Unknown option ${a}` };
      const value = eq > 0 ? a.slice(eq + 1) : argv[++i];
      if (value === undefined || (eq < 0 && value.startsWith('--'))) return { error: `${a} needs a value` };
      out.values[name as ValueFlag] = value;
      continue;
    }
    if (inConcat && out.concat !== null) out.concat.push(a);
    else if (out.session === null) out.session = a;
    else return { error: `One session at a time: ${out.session} and ${a}` };
  }
  return out;
}

export interface VideoDeps {
  out?: (line: string) => void;
  env?: NodeJS.ProcessEnv;
  /** Folder relative paths are taken from: npm's INIT_CWD (where npm run was typed), else the working folder. */
  cwd?: string;
  platform?: NodeJS.Platform;
  /** Show ffmpeg's progress line while it encodes (default: when stdout is a terminal). */
  progress?: boolean;
}

interface Ctx {
  out: (line: string) => void;
  env: NodeJS.ProcessEnv;
  base: string;
  platform: NodeJS.Platform;
  progress: boolean;
  tools: Tools;
  keepTemp: boolean;
  /** The Chrome that draws PNG captions and cards. */
  chrome: ChromePath;
}

/** A user path from `base`; `~/` is the home folder (npm does not expand it inside an option). */
export function userPath(p: string, base: string): string {
  if (p === '~' || p.startsWith('~/')) return path.join(os.homedir(), p.slice(2));
  return path.resolve(base, p);
}

function toolPath(p: string | undefined, base: string): string | undefined {
  return p === undefined ? undefined : p.includes('/') ? userPath(p, base) : p;
}

function needFile(p: string, what: string): void {
  if (!fs.existsSync(p) || !fs.statSync(p).isFile()) throw new VideoError(`${what} ${p}: no such file`);
}

function needMp4(out: string, inputs: readonly string[]): void {
  if (!/\.mp4$/i.test(out)) throw new VideoError(`--out ${out}: the video is written as .mp4`);
  if (inputs.some((i) => path.resolve(i) === path.resolve(out))) throw new VideoError(`--out ${out} would overwrite an input`);
}

function num(text: string | undefined, what: string, ok: (v: number) => boolean, rule: string): number | null {
  if (text === undefined) return null;
  const v = Number(text);
  if (text.trim() === '' || !Number.isFinite(v) || !ok(v)) throw new VideoError(`${what} ${text}: ${rule}`);
  return v;
}

function parseSquare(text: string | undefined): Rect | null {
  if (text === undefined) return null;
  const parts = text.split(',').map((x) => Number(x.trim()));
  if (parts.length !== 4 || parts.some((v) => !Number.isInteger(v) || v < 0)) throw new VideoError(`--square ${text}: expected x,y,w,h in whole pixels`);
  const [x, y, w, h] = parts as [number, number, number, number];
  return { x, y, w, h };
}

/** --captions as given (auto when left out); anything else is refused. */
function captionChoice(text: string | undefined): CaptionChoice {
  if (text === undefined) return 'auto';
  const choice = parseCaptionChoice(text);
  if (choice === null) throw new VideoError(`--captions ${text}: expected auto, drawtext or png`);
  return choice;
}

/** Writes caption and card texts into the folder ffmpeg runs in, without a final newline (drawtext would draw it). */
function writeTexts(dir: string, files: readonly CaptionFile[]): void {
  for (const f of files) fs.writeFileSync(path.join(dir, f.name), f.text, 'utf8');
}

/** The temporary folder ffmpeg runs in: made on first use; close() removes it, or names it with --keep-temp. */
interface Temp {
  dir(): string;
  close(): void;
}

function makeTemp(ctx: Ctx): Temp {
  let dir: string | null = null;
  return {
    dir: () => (dir ??= fs.mkdtempSync(path.join(os.tmpdir(), 'copyholder-video-'))),
    close: () => {
      if (dir === null) return;
      if (ctx.keepTemp) ctx.out(`Temporary files kept in ${dir}`);
      else fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

async function withTemp<T>(ctx: Ctx, fn: (dir: string) => Promise<T>): Promise<T> {
  const temp = makeTemp(ctx);
  try {
    return await fn(temp.dir());
  } finally {
    temp.close();
  }
}

/**
 * PNG captions or cards (spec 15.2-15.4): one Chrome draws `images` into `dir`, the folder ffmpeg
 * runs in. Says which browser drew them and why drawtext did not, and when a system font stood in.
 */
async function drawPictures(ctx: Ctx, dir: string, images: readonly TextImage[], font: string | null, choice: CaptionChoice, what: string): Promise<void> {
  const drawn = await drawTextImages(images, { dir, font, chrome: ctx.chrome, platform: ctx.platform });
  const why = choice === 'png' ? '--captions png' : 'this ffmpeg has no drawtext filter';
  ctx.out(`${what} drawn by ${drawn.browser} as ${images.length} PNG picture${images.length === 1 ? '' : 's'} (${why}).`);
  if (font === null) ctx.out('  No font file found: a sans-serif font of the system drew them (--font <file> names one).');
  else if (drawn.fontLoaded === false) ctx.out(`  Chrome could not read the font ${font}: a sans-serif font of the system drew them.`);
}

async function encode(ctx: Ctx, args: string[], cwd: string, what: string, out: string): Promise<MediaInfo> {
  fs.mkdirSync(path.dirname(out), { recursive: true });
  const r = await runTool(ctx.tools.ffmpeg, args, { cwd, inheritStderr: ctx.progress });
  checkRun(what, ctx.tools.ffmpeg, r);
  const info = await probeMedia(ctx.tools, out);
  ctx.out(`Wrote ${shownPath(out)}: ${info.duration.toFixed(1)} s, ${info.width} x ${info.height}, ${fpsLabel(info.fps)} fps, H.264 + AAC.`);
  if (info.duration > MAX_VIDEO_S) ctx.out(`  It is longer than ${MAX_VIDEO_S / 60} minutes: the whole video must stay under that (spec 15, 17.5).`);
  return info;
}

function fpsLabel(fps: number): string {
  return Number.isFinite(fps) ? (Math.abs(fps - Math.round(fps)) < 0.005 ? String(Math.round(fps)) : fps.toFixed(2)) : '?';
}

function signedMs(s: number): string {
  const ms = s * 1000;
  return `${ms >= 0 ? '+' : '-'}${Math.abs(ms).toFixed(1)} ms`;
}

// ---- the live take -------------------------------------------------------------------------

/** The match printed as a table: every click, its flash and the residual in ms. */
export function matchLines(m: MatchResult, frameS: number, rateHz = 48_000): string[] {
  const lines = [
    `Offset: recording time = session time + ${m.offsetS.toFixed(3)} s (median over ${m.pairs.length} clicks).`,
    `  ${'click'.padEnd(12)} ${'session'.padStart(10)} ${'flash'.padStart(10)} ${'residual'.padStart(10)}`,
  ];
  for (const p of m.pairs) {
    lines.push(`  ${p.click.label.padEnd(12)} ${clock(p.clickS).padStart(10)} ${clock(p.flashS).padStart(10)} ${signedMs(p.residualS).padStart(10)}`);
  }
  for (const c of m.missed) lines.push(`  ${c.label.padEnd(12)} no flash near ${clock(c.n / rateHz + m.offsetS)} of the recording`);
  if (m.outside > 0) lines.push(`  ${m.outside} click(s) fall outside the screen recording.`);
  if (m.extra.length > 0) lines.push(`  ${m.extra.length} flash(es) belong to no click: ${m.extra.slice(0, 6).map((t) => clock(t)).join(', ')}${m.extra.length > 6 ? ', ...' : ''}`);
  lines.push(
    `Residual spread ${(m.spreadS * 1000).toFixed(1)} ms; the limit is ${(m.limitS * 1000).toFixed(1)} ms (${(m.limitS / frameS).toFixed(0)} frames of ${(frameS * 1000).toFixed(1)} ms).`,
  );
  return lines;
}

function groupSummary(groups: readonly ClickGroup[]): string {
  return groups.map((g) => `${g.label} ${g.ns.length}`).join(', ');
}

function stepLines(s: VideoSession): string[] {
  const marks = steps(s);
  if (marks.length === 0) return ['Steps: none stamped.'];
  const items = marks.map((m) => `${m.name} ${clock(m.n / s.sampleRateHz, 1)}`);
  const lines: string[] = [];
  let line = 'Steps (session time):';
  for (const it of items) {
    if (line.length + it.length + 2 > 110) {
      lines.push(`${line},`);
      line = `  ${it}`;
    } else line = line.endsWith(':') ? `${line} ${it}` : `${line}, ${it}`;
  }
  lines.push(line);
  return lines;
}

async function runCut(a: VideoArgs, ctx: Ctx): Promise<number> {
  const temp = makeTemp(ctx);
  try {
    return await cutTake(a, ctx, temp);
  } finally {
    temp.close();
  }
}

/**
 * The take caption of a run. A run with the mock tap (a synthetic chest trace) is no demo take: it
 * is refused without --rehearsal, and with --rehearsal any run is captioned as a rehearsal.
 */
export function shownTake(take: Take | null, tap: string | null, rehearsal: boolean, id: string): Take | null {
  if (tap === 'mock' && !rehearsal) {
    throw new VideoError(`${id} ran with the mock tap, a synthetic chest trace, so it is no demo take. Add --rehearsal for a trial video, captioned REHEARSAL.`);
  }
  if (!rehearsal) return take;
  return { k: take?.k ?? 1, n: take?.n ?? 1, rehearsal: true };
}

async function cutTake(a: VideoArgs, ctx: Ctx, temp: Temp): Promise<number> {
  const v = a.values;
  const id = a.session ?? latestTake(ctx.env);
  if (id === null) throw new VideoError('No session given and no headstart or demo recording found: npm run video -- <session id> --screen <recording.mov>');
  if (v.screen === undefined) throw new VideoError('--screen <recording.mov> is needed: the screen recording of the take (tools/video/README.md)');
  const screen = userPath(v.screen, ctx.base);
  needFile(screen, '--screen');
  const takeArg = v.take === undefined ? null : parseTake(v.take);
  if (v.take !== undefined && takeArg === null) throw new VideoError(`--take ${v.take}: expected k/n, like 1/2`);
  const from = v.from === undefined ? undefined : parseTimeArg(v.from);
  const to = v.to === undefined ? undefined : parseTimeArg(v.to);
  const square = parseSquare(v.square);
  const lrtMs = num(v['lrt-ms'], '--lrt-ms', (x) => x >= 0, 'expected milliseconds');
  const height = num(v.height, '--height', (x) => Number.isInteger(x) && x >= 120 && x <= 4320, 'expected a whole number of pixels from 120 to 4320');
  const fpsText = v.fps === undefined ? null : parseFps(v.fps);
  if (v.fps !== undefined && fpsText === null) throw new VideoError(`--fps ${v.fps}: expected a frame rate from 5 to 240`);
  const maxSpread = num(v['max-spread-frames'], '--max-spread-frames', (x) => x > 0 && x <= 30, 'expected a number of frames above 0') ?? 2;
  const choice = captionChoice(v.captions);
  const alignOnly = a.flags.has('align-only');

  const caps = await ffmpegCaps(ctx.tools);
  // --align-only draws nothing: it needs neither drawtext nor Chrome.
  const mode = alignOnly ? null : captionMode(choice, caps);
  const fontFlag = v.font === undefined ? undefined : userPath(v.font, ctx.base);
  const font = mode === 'drawtext' ? findFont(fontFlag, ctx.platform) : mode === 'png' ? findFontOrNone(fontFlag, ctx.platform) : null;

  const dir = sessionFolder(id, ctx.env, ctx.base);
  const session = loadVideoSession(dir);
  const take = shownTake(takeArg, session.tap, a.flags.has('rehearsal'), session.id);
  const out = v.out === undefined ? path.join(REPO_ROOT, 'video', `${session.id}.mp4`) : userPath(v.out, ctx.base);
  if (!alignOnly) needMp4(out, [screen]);
  ctx.out(`Video of ${session.id}${session.kind ? ` (${session.kind})` : ''}`);
  for (const p of session.problems.slice(0, 5)) ctx.out(`  file problem: ${p}`);
  const groups = clickGroups(session.stamps, session.sampleRateHz);
  const refs = clickRefs(groups);
  if (refs.length === 0) throw new VideoError(`stamps.jsonl of ${session.id} has no click stamps: nothing to align the picture with`);
  ctx.out(`Clicks in stamps.jsonl: ${refs.length} (${groupSummary(groups)}).`);

  const info = await probeMedia(ctx.tools, screen);
  ctx.out(
    `Screen recording ${path.basename(screen)}: ${info.width} x ${info.height}, ${fpsLabel(info.fps)} fps, ${Number.isFinite(info.duration) ? info.duration.toFixed(1) : '?'} s.` +
      (info.hasAudio ? ' Its own sound track is not used.' : ''),
  );
  if (mode === 'png') {
    // Chrome draws the captions now, before every frame is read: a browser that does not start is
    // known at once. Their size follows the output's (--height scales it).
    const [w, h] = outputSize({ width: info.width, height: info.height, scaleToHeight: height });
    await drawPictures(ctx, temp.dir(), captionImages(take, w, h), font, choice, 'Captions');
  }
  ctx.out('Reading every frame for the flashes...');
  const flashes: FlashResult = await detectFlashes(ctx.tools, caps, info, square);
  const r = flashes.rect;
  ctx.out(
    `Square at x ${r.x}, y ${r.y}, ${r.w} x ${r.h} px (${flashes.auto ? 'found in the top-left corner' : 'given with --square'}); ` +
      `${flashes.onsets.length} flashes in ${flashes.frames} frames.` +
      (flashes.long > 0 ? ` ${flashes.long} bright stretch(es) over 1 s left out.` : ''),
  );
  const outcome = matchFlashes(flashes.onsets, refs, {
    sampleRateHz: session.sampleRateHz,
    frameS: flashes.frameS,
    span: flashes.span,
    maxSpreadFrames: maxSpread,
  });
  if (outcome.result) for (const l of matchLines(outcome.result, flashes.frameS, session.sampleRateHz)) ctx.out(l);
  if (!outcome.ok) throw new VideoError(`The picture cannot be aligned to the sound: ${outcome.why}.`);
  const m = outcome.result;
  if (alignOnly || mode === null) {
    for (const l of stepLines(session)) ctx.out(l);
    ctx.out('ALIGNED. --align-only: no video written.');
    return EXIT_OK;
  }

  const lrt = chooseLrt(session, lrtMs, doctorLrtHint(ctx.env));
  ctx.out(`L_rt ${lrt.ms.toFixed(1)} ms, from ${lrt.source}: the narrator channel is moved that much later.`);
  const plan = planCut({ session, groups, offsetS: m.offsetS, span: flashes.span, from, to });
  const rate = session.sampleRateHz;
  ctx.out(
    `Cut: session ${clock(plan.nFrom / rate, 1)} (${plan.fromWhat}) to ${clock(plan.nTo / rate, 1)} (${plan.toWhat}), ${plan.durationS.toFixed(1)} s; ` +
      `recording ${clock(plan.videoFromS, 1)} to ${clock(plan.videoFromS + plan.durationS, 1)}.`,
  );
  for (const n of plan.notes) ctx.out(`  ${n}`);
  const mix = mixTrack(session.ch0, session.ch1, session.layout, plan.nFrom, plan.nTo, Math.round((lrt.ms * rate) / 1000));
  ctx.out(
    `Sound: microphone ${mix.micGainDb >= 0 ? '+' : ''}${mix.micGainDb.toFixed(1)} dB, narrator ${mix.narratorGainDb >= 0 ? '+' : ''}${mix.narratorGainDb.toFixed(1)} dB, ` +
      `then ${mix.normDb >= 0 ? '+' : ''}${mix.normDb.toFixed(1)} dB to a peak of -1 dBFS.`,
  );

  const output: CutOutput = {
    fpsText: fpsText ?? (info.fpsText || String(Math.round(1 / flashes.frameS))),
    fps: parseRational(fpsText ?? (info.fpsText || String(Math.round(1 / flashes.frameS)))),
    width: info.width,
    height: info.height,
    scaleToHeight: height,
  };
  const tmp = temp.dir();
  fs.writeFileSync(path.join(tmp, 'mix.wav'), encodeMonoFloatWav(mix.samples, rate));
  if (mode === 'drawtext') writeTexts(tmp, captionFiles(take));
  const args = cutArgs({ plan, output, screen, mix: 'mix.wav', out, font: font ?? '', take, caps, progress: ctx.progress, captions: mode });
  await encode(ctx, args, tmp, 'Writing the video', out);
  return EXIT_OK;
}

// ---- title cards ---------------------------------------------------------------------------

/** Banned words (tools/words) in the card texts, as lines; empty when there are none. */
export function cardWordProblems(text: string): string[] {
  const words = path.join(REPO_ROOT, 'tools', 'words');
  const hits = scanText(text, loadList(path.join(words, 'banned.txt')), loadList(path.join(words, 'allow.txt')), 'cards');
  return hits.map((h) => `line ${h.line}: "${h.word}" in: ${h.text}`);
}

/** --size and --fps as given; null where an option is not given. A bad value is refused. */
function sizeFpsFlags(values: VideoArgs['values']): { size: [number, number] | null; fpsText: string | null } {
  let size: [number, number] | null = null;
  if (values.size !== undefined) {
    size = parseSize(values.size);
    if (size === null) throw new VideoError(`--size ${values.size}: expected WIDTHxHEIGHT with even numbers, like 1920x1080`);
  }
  let fpsText: string | null = null;
  if (values.fps !== undefined) {
    fpsText = parseFps(values.fps);
    if (fpsText === null) throw new VideoError(`--fps ${values.fps}: expected a frame rate from 5 to 240`);
  }
  return { size, fpsText };
}

async function sizeAndRate(a: VideoArgs, ctx: Ctx, fromFile: { size: [number, number] | null; fpsText: string | null }): Promise<{ size: [number, number]; fpsText: string }> {
  const given = sizeFpsFlags(a.values);
  let like: MediaInfo | null = null;
  if (a.values.like !== undefined) {
    const p = userPath(a.values.like, ctx.base);
    needFile(p, '--like');
    like = await probeMedia(ctx.tools, p);
  }
  const size: [number, number] = given.size ?? (like ? [like.width - (like.width % 2), like.height - (like.height % 2)] : (fromFile.size ?? [1920, 1080]));
  const fpsText = given.fpsText ?? (like?.fpsText || null) ?? fromFile.fpsText ?? '30';
  return { size, fpsText };
}

async function runCards(a: VideoArgs, ctx: Ctx): Promise<number> {
  const file = userPath(a.values.cards as string, ctx.base);
  needFile(file, '--cards');
  if (a.values.out === undefined) throw new VideoError('--out <cards.mp4> is needed');
  const out = userPath(a.values.out, ctx.base);
  needMp4(out, [file]);
  const spec = parseCards(fs.readFileSync(file, 'utf8'));
  const banned = cardWordProblems(cardsText(spec));
  if (banned.length > 0) throw new VideoError(`the cards hold banned words (spec 13.6, 15.6):\n  ${banned.join('\n  ')}`);
  const { size, fpsText } = await sizeAndRate(a, ctx, spec);
  const choice = captionChoice(a.values.captions);
  const caps: FfmpegCaps = await ffmpegCaps(ctx.tools);
  const mode = captionMode(choice, caps);
  const fontFlag = a.values.font === undefined ? undefined : userPath(a.values.font, ctx.base);
  const font = mode === 'drawtext' ? findFont(fontFlag, ctx.platform) : findFontOrNone(fontFlag, ctx.platform);
  const plan = cardsPlan({ spec, size, fpsText, font: font ?? '', out, caps, progress: ctx.progress, captions: mode });
  ctx.out(`Cards: ${spec.cards.length}, ${plan.totalS.toFixed(1)} s, ${size[0]} x ${size[1]} at ${fpsLabel(parseRational(fpsText))} fps.`);
  await withTemp(ctx, async (tmp) => {
    if (mode === 'drawtext') writeTexts(tmp, plan.files);
    else await drawPictures(ctx, tmp, plan.images, font, choice, 'Cards');
    await encode(ctx, plan.args, tmp, 'Writing the cards', out);
  });
  return EXIT_OK;
}

// ---- joining -------------------------------------------------------------------------------

async function runConcat(a: VideoArgs, ctx: Ctx): Promise<number> {
  const files = (a.concat ?? []).map((f) => userPath(f, ctx.base));
  if (files.length < 2) throw new VideoError('--concat needs at least two clips');
  for (const f of files) needFile(f, '--concat');
  if (a.values.out === undefined) throw new VideoError('--out <final.mp4> is needed');
  const out = userPath(a.values.out, ctx.base);
  needMp4(out, files);
  // --size and --fps first: the first clip's own size and rate fill in only what they leave open.
  const given = sizeFpsFlags(a.values);
  const infos: MediaInfo[] = [];
  for (const f of files) infos.push(await probeMedia(ctx.tools, f));
  const target = concatTarget(infos[0] as MediaInfo, given);
  const caps = await ffmpegCaps(ctx.tools);
  const args = concatArgs(infos, out, target, caps, ctx.progress);
  const total = infos.reduce((s, i) => s + i.duration, 0);
  ctx.out(`Joining ${files.length} clips, ${total.toFixed(1)} s, into ${target.width} x ${target.height} at ${fpsLabel(target.fps)} fps.`);
  await withTemp(ctx, async (tmp) => {
    await encode(ctx, args, tmp, 'Joining the clips', out);
  });
  return EXIT_OK;
}

// ---- entry ---------------------------------------------------------------------------------

export async function main(argv: readonly string[] = process.argv.slice(2), deps: VideoDeps = {}): Promise<number> {
  const out = deps.out ?? ((line: string) => console.log(line));
  const env = deps.env ?? process.env;
  const parsed = parseArgs(argv);
  if ('error' in parsed) {
    out(parsed.error);
    out(USAGE);
    return EXIT_USAGE;
  }
  if (parsed.flags.has('help')) {
    out(USAGE);
    return EXIT_OK;
  }
  const base = deps.cwd ?? env['INIT_CWD'] ?? process.cwd();
  const ctx: Ctx = {
    out,
    env,
    base,
    platform: deps.platform ?? process.platform,
    progress: deps.progress ?? process.stdout.isTTY === true,
    tools: toolsFrom(env, { ffmpeg: toolPath(parsed.values.ffmpeg, base), ffprobe: toolPath(parsed.values.ffprobe, base) }),
    keepTemp: parsed.flags.has('keep-temp'),
    chrome: chromePath(parsed.values.chrome === undefined ? undefined : userPath(parsed.values.chrome, base), env),
  };
  const modes = [parsed.concat !== null, parsed.values.cards !== undefined, parsed.session !== null || parsed.values.screen !== undefined];
  if (modes.filter(Boolean).length > 1) {
    out('Pick one of: a session with --screen, --cards, or --concat.');
    out(USAGE);
    return EXIT_USAGE;
  }
  try {
    if (parsed.concat !== null) return await runConcat(parsed, ctx);
    if (parsed.values.cards !== undefined) return await runCards(parsed, ctx);
    return await runCut(parsed, ctx);
  } catch (e) {
    if (e instanceof VideoError) {
      out(`VIDEO DID NOT RUN: ${e.message}`);
      return EXIT_REFUSED;
    }
    throw e;
  }
}

if (isMainModule(import.meta.url)) {
  main().then(
    (code) => {
      process.exitCode = code;
    },
    (e: unknown) => {
      console.error(e instanceof Error ? (e.stack ?? e.message) : String(e));
      process.exitCode = EXIT_REFUSED;
    },
  );
}
