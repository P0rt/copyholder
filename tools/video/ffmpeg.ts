// ffmpeg and ffprobe for `npm run video` (spec 13.3, 15.4): every call is an argument array, never
// a shell string. What this ffmpeg can do (drawtext, an H.264 encoder) is asked once, and the
// commands are built from that: without drawtext, Chrome draws the captions as PNG pictures
// (textpng.ts) and ffmpeg lays them over the picture.

import { spawn } from 'node:child_process';
import fs from 'node:fs';

/** A refusal or failure the user can act on: printed as one line, no stack. */
export class VideoError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'VideoError';
  }
}

export interface Tools {
  ffmpeg: string;
  ffprobe: string;
}

/** ffmpeg and ffprobe from the flags, else COPYHOLDER_FFMPEG / COPYHOLDER_FFPROBE, else PATH. */
export function toolsFrom(env: NodeJS.ProcessEnv, flags: { ffmpeg?: string | undefined; ffprobe?: string | undefined } = {}): Tools {
  return {
    ffmpeg: flags.ffmpeg ?? env['COPYHOLDER_FFMPEG'] ?? 'ffmpeg',
    ffprobe: flags.ffprobe ?? env['COPYHOLDER_FFPROBE'] ?? 'ffprobe',
  };
}

export interface RunResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  /** stdout, unless onStdout took it. */
  stdout: Buffer;
  /** The last 64 KiB of stderr (empty when it went to our stderr). */
  stderr: string;
  /** Set when the program could not be started (not installed, not executable). */
  spawnError: Error | null;
}

export interface RunOptions {
  cwd?: string;
  /** Pass the child's stderr through to ours: ffmpeg's progress line during a long encode. */
  inheritStderr?: boolean;
  /** Each stdout chunk goes here instead of being collected. */
  onStdout?: (chunk: Buffer) => void;
  /** Each stderr text chunk goes here as well. */
  onStderr?: (text: string) => void;
}

const STDERR_KEEP = 65_536;

/** Runs one program with an argument array (no shell) and waits for it to close. */
export function runTool(cmd: string, args: readonly string[], opts: RunOptions = {}): Promise<RunResult> {
  return new Promise((resolve) => {
    let settled = false;
    const done = (r: RunResult): void => {
      if (!settled) {
        settled = true;
        resolve(r);
      }
    };
    const out: Buffer[] = [];
    let err = '';
    let child;
    try {
      child = spawn(cmd, [...args], {
        cwd: opts.cwd,
        shell: false,
        stdio: ['ignore', 'pipe', opts.inheritStderr ? 'inherit' : 'pipe'],
      });
    } catch (e) {
      done({ code: null, signal: null, stdout: Buffer.alloc(0), stderr: '', spawnError: e as Error });
      return;
    }
    child.stdout?.on('data', (c: Buffer) => {
      if (opts.onStdout) opts.onStdout(c);
      else out.push(c);
    });
    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', (t: string) => {
      opts.onStderr?.(t);
      err = (err + t).slice(-STDERR_KEEP);
    });
    child.on('error', (e) => done({ code: null, signal: null, stdout: Buffer.concat(out), stderr: err, spawnError: e }));
    child.on('close', (code, signal) => done({ code, signal, stdout: Buffer.concat(out), stderr: err, spawnError: null }));
  });
}

/** The last lines of stderr, for a failure message. */
export function stderrTail(stderr: string, lines = 6): string {
  return stderr
    .split(/\r?\n|\r/)
    .map((l) => l.trim())
    .filter((l) => l !== '')
    .slice(-lines)
    .join('\n  ');
}

/** Throws a VideoError naming the program when it did not run or did not exit 0. */
export function checkRun(what: string, cmd: string, r: RunResult): void {
  if (r.spawnError) {
    const missing = (r.spawnError as NodeJS.ErrnoException).code === 'ENOENT';
    throw new VideoError(missing ? `${cmd} was not found. ${INSTALL_HINT}` : `${cmd} could not be started: ${r.spawnError.message}`);
  }
  if (r.code !== 0) {
    const tail = stderrTail(r.stderr);
    throw new VideoError(`${what} failed (${cmd} exit ${r.code ?? r.signal})${tail ? `:\n  ${tail}` : ''}`);
  }
}

export const INSTALL_HINT =
  'Install ffmpeg (it brings ffprobe): on the Mac with Homebrew, brew install ffmpeg. A build at another place can be named with --ffmpeg and --ffprobe.';

// ---- ffprobe ------------------------------------------------------------------------------

/** "30000/1001" or "60" as a number; NaN when it is not a positive rate. */
export function parseRational(text: string | undefined): number {
  if (text === undefined) return Number.NaN;
  const m = /^\s*(\d+(?:\.\d+)?)\s*(?:\/\s*(\d+(?:\.\d+)?))?\s*$/.exec(text);
  if (!m) return Number.NaN;
  const num = Number(m[1]);
  const den = m[2] === undefined ? 1 : Number(m[2]);
  return den > 0 && num > 0 ? num / den : Number.NaN;
}

/** Frame rates outside this range are container guesses, not the recording's rate. */
const SANE_FPS: readonly [number, number] = [5, 240];

export function isSaneFps(fps: number): boolean {
  return Number.isFinite(fps) && fps >= SANE_FPS[0] && fps <= SANE_FPS[1];
}

export interface MediaInfo {
  file: string;
  width: number;
  height: number;
  /** Nominal frame rate as ffprobe writes it ("60/1", "30000/1001"); a recording's own rate. */
  fpsText: string;
  fps: number;
  /** Video stream duration in seconds, else the container's; NaN when neither is given. */
  duration: number;
  hasAudio: boolean;
}

interface ProbeStream {
  codec_type?: string;
  width?: number;
  height?: number;
  r_frame_rate?: string;
  avg_frame_rate?: string;
  duration?: string;
}

/** Picks the frame rate of a probed video stream: r_frame_rate, else avg_frame_rate, when sane. */
export function streamFps(s: Pick<ProbeStream, 'r_frame_rate' | 'avg_frame_rate'>): { text: string; fps: number } | null {
  for (const text of [s.r_frame_rate, s.avg_frame_rate]) {
    const fps = parseRational(text);
    if (text !== undefined && isSaneFps(fps)) return { text: text.trim(), fps };
  }
  return null;
}

/** Size, frame rate, duration and audio presence of a media file. */
export async function probeMedia(tools: Tools, file: string): Promise<MediaInfo> {
  const args = [
    '-v', 'error',
    '-show_entries', 'stream=codec_type,width,height,r_frame_rate,avg_frame_rate,duration:format=duration',
    '-of', 'json',
    file,
  ];
  const r = await runTool(tools.ffprobe, args);
  checkRun(`Reading ${file}`, tools.ffprobe, r);
  let parsed: { streams?: ProbeStream[]; format?: { duration?: string } };
  try {
    parsed = JSON.parse(r.stdout.toString('utf8')) as typeof parsed;
  } catch {
    throw new VideoError(`ffprobe gave no readable answer for ${file}`);
  }
  const streams = parsed.streams ?? [];
  const video = streams.find((s) => s.codec_type === 'video');
  if (!video || !video.width || !video.height) throw new VideoError(`${file} has no video stream`);
  const rate = streamFps(video);
  const vd = Number(video.duration);
  const fd = Number(parsed.format?.duration);
  return {
    file,
    width: video.width,
    height: video.height,
    fpsText: rate?.text ?? '',
    fps: rate?.fps ?? Number.NaN,
    duration: Number.isFinite(vd) && vd > 0 ? vd : Number.isFinite(fd) && fd > 0 ? fd : Number.NaN,
    hasAudio: streams.some((s) => s.codec_type === 'audio'),
  };
}

// ---- what this ffmpeg can do ------------------------------------------------------------

export interface FfmpegCaps {
  /** "6.1.1" from "ffmpeg version 6.1.1-3ubuntu5"; null for a git build or an unreadable line. */
  version: string | null;
  drawtext: boolean;
  /** drawtext has y_align (FFmpeg 6.1 and newer). */
  yAlign: boolean;
  libx264: boolean;
  videotoolbox: boolean;
  /** -fps_mode exists (FFmpeg 5.1 and newer); older builds take -vsync. */
  fpsMode: boolean;
}

/** major.minor of a version string, or null. */
export function versionNumber(version: string | null): [number, number] | null {
  const m = version === null ? null : /^(\d+)\.(\d+)/.exec(version);
  return m ? [Number(m[1]), Number(m[2])] : null;
}

/** Reads the version, the filters and the encoders of this ffmpeg. */
export async function ffmpegCaps(tools: Tools): Promise<FfmpegCaps> {
  const v = await runTool(tools.ffmpeg, ['-hide_banner', '-version']);
  checkRun('Asking ffmpeg for its version', tools.ffmpeg, v);
  const first = v.stdout.toString('utf8').split('\n')[0] ?? '';
  const version = /ffmpeg version (\d+\.\d+(?:\.\d+)?)/.exec(first)?.[1] ?? null;
  const filters = await runTool(tools.ffmpeg, ['-hide_banner', '-filters']);
  checkRun('Asking ffmpeg for its filters', tools.ffmpeg, filters);
  const encoders = await runTool(tools.ffmpeg, ['-hide_banner', '-encoders']);
  checkRun('Asking ffmpeg for its encoders', tools.ffmpeg, encoders);
  const filterText = filters.stdout.toString('utf8');
  const encoderText = encoders.stdout.toString('utf8');
  const drawtext = /\sdrawtext\s/.test(filterText);
  let yAlign = false;
  if (drawtext) {
    const h = await runTool(tools.ffmpeg, ['-hide_banner', '-h', 'filter=drawtext']);
    yAlign = h.code === 0 && /\by_align\b/.test(h.stdout.toString('utf8'));
  }
  const vn = versionNumber(version);
  return {
    version,
    drawtext,
    yAlign,
    libx264: /\slibx264\s/.test(encoderText),
    videotoolbox: /\sh264_videotoolbox\s/.test(encoderText),
    fpsMode: vn === null || vn[0] > 5 || (vn[0] === 5 && vn[1] >= 1),
  };
}

/** Frames passed on with their own timestamps: no frame is doubled or dropped. */
export function passthroughArgs(caps: Pick<FfmpegCaps, 'fpsMode'>): string[] {
  return caps.fpsMode ? ['-fps_mode', 'passthrough'] : ['-vsync', 'passthrough'];
}

export const NO_DRAWTEXT_HINT =
  'This ffmpeg has no drawtext filter, which --captions drawtext needs (spec 15.2, 15.4). Without that option ' +
  'Chrome draws the captions (--captions png); or name a build with libfreetype with --ffmpeg.';

/** How the captions and cards are drawn: by ffmpeg's drawtext, or as PNG pictures from Chrome that ffmpeg overlays. */
export type CaptionMode = 'drawtext' | 'png';

export const CAPTION_CHOICES = ['auto', 'drawtext', 'png'] as const;
export type CaptionChoice = (typeof CAPTION_CHOICES)[number];

/** --captions as given; null when it is none of auto, drawtext and png. */
export function parseCaptionChoice(text: string): CaptionChoice | null {
  const t = text.trim().toLowerCase();
  return (CAPTION_CHOICES as readonly string[]).includes(t) ? (t as CaptionChoice) : null;
}

/**
 * The mode for this ffmpeg: auto takes drawtext where the ffmpeg has it and PNG pictures where it
 * does not; png never needs drawtext; drawtext without it is refused.
 */
export function captionMode(choice: CaptionChoice, caps: Pick<FfmpegCaps, 'drawtext'>): CaptionMode {
  if (choice === 'png') return 'png';
  if (caps.drawtext) return 'drawtext';
  if (choice === 'drawtext') throw new VideoError(NO_DRAWTEXT_HINT);
  return 'png';
}

/** H.264 at the given size and rate: libx264, else Apple's hardware encoder. */
export function videoEncoderArgs(caps: Pick<FfmpegCaps, 'libx264' | 'videotoolbox'>, width: number, height: number, fps: number): string[] {
  if (caps.libx264) return ['-c:v', 'libx264', '-preset', 'fast', '-crf', '18', '-pix_fmt', 'yuv420p'];
  if (caps.videotoolbox) {
    // Screen content: about 0.07 bit per pixel and frame.
    const kbps = Math.min(60_000, Math.max(2_000, Math.round((width * height * (Number.isFinite(fps) ? fps : 30) * 0.07) / 1000)));
    return ['-c:v', 'h264_videotoolbox', '-b:v', `${kbps}k`, '-pix_fmt', 'yuv420p'];
  }
  throw new VideoError('This ffmpeg has no H.264 encoder (libx264 or h264_videotoolbox).');
}

/** AAC, 48 kHz, stereo. */
export const AUDIO_ENCODER_ARGS: readonly string[] = ['-c:a', 'aac', '-b:a', '192k', '-ar', '48000', '-ac', '2'];

/** mp4 without the source's metadata or chapters, playable while it downloads. */
export const MP4_ARGS: readonly string[] = ['-map_metadata', '-1', '-map_chapters', '-1', '-movflags', '+faststart'];

/** Start of every encoding command: overwrite, no prompts, errors only (plus the progress line when shown). */
export function encodeHead(showProgress: boolean): string[] {
  return ['-hide_banner', '-nostdin', '-y', '-v', 'error', ...(showProgress ? ['-stats'] : ['-nostats'])];
}

// ---- filtergraph text ---------------------------------------------------------------------

/**
 * A literal value inside a filter option, escaped for both levels ffmpeg parses: the option list
 * (`:` `'` `\`) and then the filtergraph (`[` `]` `,` `;` `'` `\`). Commas of an expression
 * (enable=lt(t,5)) need it as much as a font path with spaces or colons.
 */
export function escapeFilterValue(value: string): string {
  const level1 = value.replace(/[\\':]/g, (c) => `\\${c}`);
  return level1.replace(/[\\'[\],;]/g, (c) => `\\${c}`);
}

/** Seconds for a command line: at most 6 decimals, no trailing zeros. */
export function secondsArg(s: number): string {
  const t = s.toFixed(6).replace(/\.?0+$/, '');
  return t === '-0' ? '0' : t;
}

// ---- fonts --------------------------------------------------------------------------------

export const MAC_FONTS: readonly string[] = [
  '/System/Library/Fonts/Helvetica.ttc',
  '/System/Library/Fonts/Supplemental/Arial.ttf',
  '/Library/Fonts/Arial.ttf',
];

export const LINUX_FONTS: readonly string[] = [
  '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf',
  '/usr/share/fonts/TTF/DejaVuSans.ttf',
  '/usr/share/fonts/dejavu/DejaVuSans.ttf',
  '/usr/share/fonts/dejavu-sans-fonts/DejaVuSans.ttf',
  '/usr/share/fonts/truetype/liberation/LiberationSans-Regular.ttf',
  '/usr/share/fonts/truetype/freefont/FreeSans.ttf',
];

function fontOrder(platform: NodeJS.Platform): string[] {
  return platform === 'darwin' ? [...MAC_FONTS, ...LINUX_FONTS] : [...LINUX_FONTS, ...MAC_FONTS];
}

/** The font for the captions: --font, else the first known font file that exists here. */
export function findFont(explicit: string | undefined, platform: NodeJS.Platform, exists: (p: string) => boolean = fs.existsSync): string {
  const found = findFontOrNone(explicit, platform, exists);
  if (found === null) {
    const order = fontOrder(platform);
    throw new VideoError(`No font file found (looked for ${order.slice(0, 2).join(', ')} and others). Name one with --font <file.ttf>.`);
  }
  return found;
}

/**
 * The font file for PNG captions: as findFont, but null when no known font file exists here (Chrome
 * then takes a sans-serif font of the system). A --font that does not exist is still refused.
 */
export function findFontOrNone(explicit: string | undefined, platform: NodeJS.Platform, exists: (p: string) => boolean = fs.existsSync): string | null {
  if (explicit !== undefined) {
    if (!exists(explicit)) throw new VideoError(`--font ${explicit}: no such file`);
    return explicit;
  }
  return fontOrder(platform).find((p) => exists(p)) ?? null;
}
