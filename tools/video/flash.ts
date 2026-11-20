// Flash onsets of the sync square in a screen recording (spec 15.4). The page shows a square,
// black normally and white for 100 ms from each Deck click, near the top-left corner. ffmpeg
// decodes the recording into small gray frames of the top-left 400 x 400 px (or of the region
// given with --square), with each frame's own timestamp: macOS records the screen at a variable
// frame rate, so frame numbers are not times. The square is the patch of cells that is dark most
// of the time and lights up in short pulses; its onsets are the frames where it turns bright.

import { checkRun, passthroughArgs, runTool, VideoError, type FfmpegCaps, type MediaInfo, type Tools } from './ffmpeg.ts';

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** The square is looked for in the top-left SEARCH_PX x SEARCH_PX pixels of the recording. */
export const SEARCH_PX = 400;
/** One cell of the search grid: CELL_PX x CELL_PX pixels averaged (a 48 px square still has 6 x 6 cells). */
export const CELL_PX = 8;
/** One cell when the region is given with --square. */
export const SQUARE_CELL_PX = 4;

/** Cell levels (0-255): bright at or above HI, dark at or below LO, unchanged between. */
const CELL_HI = 160;
const CELL_LO = 96;
/** A flash lasts 100 ms (page); a bright run of a cell counts as a pulse within these bounds (s). */
const PULSE_MIN_S = 0.02;
const PULSE_MAX_S = 0.3;
/** A cell of the square is bright at most this share of the time. */
const MAX_BRIGHT_SHARE = 0.15;
/** A cell needs this many pulses to be part of the square. */
const MIN_CELL_PULSES = 3;
/** A bright run of the found region longer than this is not a flash (a window over it, a page change). */
export const MAX_FLASH_S = 1;

export interface GrayFrames {
  /** Cells per row and per column. */
  w: number;
  h: number;
  count: number;
  /** count * w * h cell values, frame after frame. */
  data: Uint8Array;
  /** Frame times in seconds from the start of the recording (showinfo pts_time). */
  times: number[];
}

/** The showinfo line of one frame: its number and its time. */
const SHOWINFO = /Parsed_showinfo\S*\s.*?\bn:\s*(\d+)\s+pts:\s*\S+\s+pts_time:\s*(\S+)/;

/** Collects frame times from showinfo lines on stderr, chunk by chunk. */
export class ShowinfoTimes {
  readonly times: number[] = [];
  private rest = '';

  push(text: string): void {
    const all = this.rest + text;
    const parts = all.split(/\r\n|\n|\r/);
    this.rest = parts.pop() ?? '';
    for (const line of parts) this.line(line);
  }

  end(): number[] {
    if (this.rest !== '') this.line(this.rest);
    this.rest = '';
    return this.times;
  }

  private line(line: string): void {
    const m = SHOWINFO.exec(line);
    if (!m) return;
    const n = Number(m[1]);
    const t = Number(m[2]);
    this.times[n] = Number.isFinite(t) ? t : Number.NaN;
  }
}

/** ffmpeg arguments that write `crop` of every frame, averaged down to outW x outH gray cells, to stdout. */
export function grayFramesArgs(caps: Pick<FfmpegCaps, 'fpsMode'>, file: string, crop: Rect, outW: number, outH: number): string[] {
  const vf = `crop=${crop.w}:${crop.h}:${crop.x}:${crop.y},scale=${outW}:${outH}:flags=area,format=gray,showinfo=checksum=0`;
  return [
    '-hide_banner', '-nostdin', '-nostats', '-v', 'info',
    '-i', file,
    '-an', '-sn', '-dn',
    '-vf', vf,
    ...passthroughArgs(caps),
    '-f', 'rawvideo', '-pix_fmt', 'gray',
    'pipe:1',
  ];
}

/** Decodes every frame of `file` into outW x outH cells of `crop`, with the frame times. */
export async function readGrayFrames(
  tools: Tools,
  caps: Pick<FfmpegCaps, 'fpsMode'>,
  file: string,
  crop: Rect,
  outW: number,
  outH: number,
  expectedFrames = 4096,
): Promise<GrayFrames> {
  const frameBytes = outW * outH;
  let data = new Uint8Array(frameBytes * Math.max(64, Math.min(expectedFrames, 400_000)));
  let used = 0;
  const times = new ShowinfoTimes();
  const r = await runTool(tools.ffmpeg, grayFramesArgs(caps, file, crop, outW, outH), {
    onStdout: (chunk) => {
      if (used + chunk.length > data.length) {
        const bigger = new Uint8Array(Math.max(data.length * 2, used + chunk.length));
        bigger.set(data.subarray(0, used));
        data = bigger;
      }
      data.set(chunk, used);
      used += chunk.length;
    },
    onStderr: (t) => times.push(t),
  });
  checkRun(`Reading the frames of ${file}`, tools.ffmpeg, r);
  const t = times.end();
  const count = Math.min(Math.floor(used / frameBytes), t.length);
  if (count === 0) throw new VideoError(`ffmpeg read no frames from ${file}`);
  const ts = t.slice(0, count);
  // A frame without a readable time sits one median step after the one before it.
  const steps = ts.slice(1).map((x, i) => x - (ts[i] as number)).filter((d) => Number.isFinite(d) && d > 0);
  const step = median(steps) ?? 1 / 30;
  for (let i = 0; i < ts.length; i++) if (!Number.isFinite(ts[i])) ts[i] = i === 0 ? 0 : (ts[i - 1] as number) + step;
  return { w: outW, h: outH, count, data: data.subarray(0, count * frameBytes), times: ts };
}

// ---- finding the square --------------------------------------------------------------------

/** Cells [x0, x1) x [y0, y1) of the search grid. */
export interface CellBox {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

export interface SquareFind {
  box: CellBox;
  /** Cells of the connected patch. */
  cells: number;
  /** Median pulse count of its cells. */
  pulses: number;
}

/**
 * The flash square on the search grid: the largest connected patch (by pulses summed over its
 * cells) of cells that are bright at most 15 % of the time and light up in at least 3 short
 * pulses. Null when no cell does. A blinking text cursor (pulses of about 0.5 s) and a ticking
 * clock (bright half the time) do not qualify.
 */
export function findSquare(f: GrayFrames): SquareFind | null {
  const n = f.w * f.h;
  if (f.count < 2 || n === 0) return null;
  const pulses = new Uint32Array(n);
  const brightS = new Float64Array(n);
  const bright = new Uint8Array(n);
  const since = new Float64Array(n);
  const t0 = f.times[0] as number;
  for (let c = 0; c < n; c++) {
    bright[c] = (f.data[c] as number) >= CELL_HI ? 1 : 0;
    since[c] = t0;
  }
  for (let k = 1; k < f.count; k++) {
    const t = f.times[k] as number;
    const base = k * n;
    for (let c = 0; c < n; c++) {
      const v = f.data[base + c] as number;
      if (bright[c] === 0) {
        if (v >= CELL_HI) {
          bright[c] = 1;
          since[c] = t;
        }
      } else if (v <= CELL_LO) {
        bright[c] = 0;
        const d = t - (since[c] as number);
        brightS[c] = (brightS[c] as number) + d;
        if (d >= PULSE_MIN_S && d <= PULSE_MAX_S) pulses[c] = (pulses[c] as number) + 1;
      }
    }
  }
  const tEnd = f.times[f.count - 1] as number;
  const total = Math.max(1e-9, tEnd - t0);
  for (let c = 0; c < n; c++) if (bright[c] === 1) brightS[c] = (brightS[c] as number) + (tEnd - (since[c] as number));

  const ok = new Uint8Array(n);
  for (let c = 0; c < n; c++) ok[c] = (pulses[c] as number) >= MIN_CELL_PULSES && (brightS[c] as number) / total <= MAX_BRIGHT_SHARE ? 1 : 0;

  // Connected patches (4-neighbours); the one with the most pulses in all wins.
  const seen = new Uint8Array(n);
  let best: { cells: number[]; mass: number } | null = null;
  for (let c = 0; c < n; c++) {
    if (ok[c] === 0 || seen[c] === 1) continue;
    const cells: number[] = [];
    const stack = [c];
    seen[c] = 1;
    let mass = 0;
    while (stack.length > 0) {
      const p = stack.pop() as number;
      cells.push(p);
      mass += pulses[p] as number;
      const x = p % f.w;
      const y = (p - x) / f.w;
      const near = [x > 0 ? p - 1 : -1, x < f.w - 1 ? p + 1 : -1, y > 0 ? p - f.w : -1, y < f.h - 1 ? p + f.w : -1];
      for (const q of near) {
        if (q >= 0 && ok[q] === 1 && seen[q] === 0) {
          seen[q] = 1;
          stack.push(q);
        }
      }
    }
    if (best === null || mass > best.mass || (mass === best.mass && cells.length > best.cells.length)) best = { cells, mass };
  }
  if (best === null) return null;
  let x0 = f.w;
  let y0 = f.h;
  let x1 = 0;
  let y1 = 0;
  for (const p of best.cells) {
    const x = p % f.w;
    const y = (p - x) / f.w;
    x0 = Math.min(x0, x);
    y0 = Math.min(y0, y);
    x1 = Math.max(x1, x + 1);
    y1 = Math.max(y1, y + 1);
  }
  const counts = best.cells.map((p) => pulses[p] as number);
  return { box: { x0, y0, x1, y1 }, cells: best.cells.length, pulses: median(counts) ?? 0 };
}

/** The box without its edge cells, which the square only partly covers, where it is 3 or more cells wide. */
export function innerBox(b: CellBox): CellBox {
  const shrinkX = b.x1 - b.x0 >= 3 ? 1 : 0;
  const shrinkY = b.y1 - b.y0 >= 3 ? 1 : 0;
  return { x0: b.x0 + shrinkX, y0: b.y0 + shrinkY, x1: b.x1 - shrinkX, y1: b.y1 - shrinkY };
}

/** Mean cell level over `box` in every frame. */
export function regionLuma(f: GrayFrames, box: CellBox): Float64Array {
  const out = new Float64Array(f.count);
  const n = f.w * f.h;
  const cells = Math.max(1, (box.x1 - box.x0) * (box.y1 - box.y0));
  for (let k = 0; k < f.count; k++) {
    let sum = 0;
    for (let y = box.y0; y < box.y1; y++) {
      const row = k * n + y * f.w;
      for (let x = box.x0; x < box.x1; x++) sum += f.data[row + x] as number;
    }
    out[k] = sum / cells;
  }
  return out;
}

/** Pixel rectangle of a cell box, for a grid laid over `crop`. */
export function cellBoxToRect(box: CellBox, crop: Rect, gridW: number, gridH: number): Rect {
  const sx = crop.w / gridW;
  const sy = crop.h / gridH;
  const x = crop.x + Math.round(box.x0 * sx);
  const y = crop.y + Math.round(box.y0 * sy);
  return { x, y, w: crop.x + Math.round(box.x1 * sx) - x, h: crop.y + Math.round(box.y1 * sy) - y };
}

// ---- onsets ------------------------------------------------------------------------------

export interface Pulse {
  /** Time of the first bright frame. */
  on: number;
  /** Time of the first dark frame after it; null when the recording ends bright. */
  off: number | null;
}

export interface OnsetFind {
  /** Times of the first bright frame of every flash, ascending. */
  onsets: number[];
  pulses: Pulse[];
  /** Dark and bright level of the region (0-255). */
  low: number;
  high: number;
  /** Bright runs longer than MAX_FLASH_S, left out. */
  long: number;
}

/**
 * Flash onsets in the mean level of the square: a rise through the middle between its dark and
 * bright level, after a fall below 30 % of the way (hysteresis). A recording that starts bright
 * has no onset there. Null when the region never turns clearly brighter (60 levels of 255).
 */
export function flashOnsets(times: readonly number[], luma: ArrayLike<number>): OnsetFind | null {
  const n = Math.min(times.length, luma.length);
  if (n < 2) return null;
  const values = Array.from({ length: n }, (_, i) => luma[i] as number).sort((a, b) => a - b);
  const low = values[Math.floor(0.1 * (n - 1))] as number;
  const high = values[n - 1] as number;
  if (high - low < 60) return null;
  const up = low + 0.5 * (high - low);
  const down = low + 0.3 * (high - low);
  const pulses: Pulse[] = [];
  let long = 0;
  let isBright = (luma[0] as number) >= up;
  let skipFirst = isBright;
  let on = 0;
  for (let k = 1; k < n; k++) {
    const v = luma[k] as number;
    const t = times[k] as number;
    if (!isBright && v >= up) {
      isBright = true;
      on = t;
    } else if (isBright && v <= down) {
      isBright = false;
      if (skipFirst) skipFirst = false;
      else if (t - on > MAX_FLASH_S) long++;
      else pulses.push({ on, off: t });
    }
  }
  if (isBright && !skipFirst) {
    const end = times[n - 1] as number;
    if (end - on > MAX_FLASH_S) long++;
    else pulses.push({ on, off: null });
  }
  return { onsets: pulses.map((p) => p.on), pulses, low, high, long };
}

// ---- the whole step ---------------------------------------------------------------------

export interface FlashResult {
  /** The square in pixels of the recording. */
  rect: Rect;
  /** Found in the top-left corner (true) or given with --square (false). */
  auto: boolean;
  onsets: number[];
  pulses: Pulse[];
  long: number;
  low: number;
  high: number;
  /** Frames decoded, and the span they cover: [first frame, last frame + one frame]. */
  frames: number;
  span: [number, number];
  /** One frame of the recording in seconds: 1 / its nominal rate, else the median frame step. */
  frameS: number;
}

/** One frame in seconds: from the nominal rate when ffprobe gave one, else from the frame times. */
export function frameSeconds(fps: number, times: readonly number[]): number {
  if (Number.isFinite(fps) && fps > 0) return 1 / fps;
  const steps = times.slice(1).map((x, i) => x - (times[i] as number)).filter((d) => d > 0);
  return median(steps) ?? 1 / 30;
}

/** Checks a --square rectangle against the recording's size. */
export function checkSquare(r: Rect, info: Pick<MediaInfo, 'width' | 'height'>): string | null {
  if (![r.x, r.y, r.w, r.h].every((v) => Number.isInteger(v) && v >= 0)) return '--square takes four whole numbers of pixels: x,y,w,h';
  if (r.w < 4 || r.h < 4) return '--square: the region must be at least 4 x 4 px';
  if (r.x + r.w > info.width || r.y + r.h > info.height) return `--square ${r.x},${r.y},${r.w},${r.h} runs past the ${info.width} x ${info.height} px recording`;
  return null;
}

/** Finds the square (or reads the given one) and its flash onsets. */
export async function detectFlashes(tools: Tools, caps: Pick<FfmpegCaps, 'fpsMode'>, info: MediaInfo, square: Rect | null): Promise<FlashResult> {
  const expected = Number.isFinite(info.duration) ? Math.ceil(info.duration * (Number.isFinite(info.fps) ? Math.max(info.fps, 30) : 60) * 1.05) + 16 : 4096;
  let crop: Rect;
  let frames: GrayFrames;
  let box: CellBox;
  let rect: Rect;
  if (square !== null) {
    const bad = checkSquare(square, info);
    if (bad !== null) throw new VideoError(bad);
    crop = square;
    const gw = Math.max(1, Math.min(64, Math.round(square.w / SQUARE_CELL_PX)));
    const gh = Math.max(1, Math.min(64, Math.round(square.h / SQUARE_CELL_PX)));
    frames = await readGrayFrames(tools, caps, info.file, crop, gw, gh, expected);
    box = innerBox({ x0: 0, y0: 0, x1: gw, y1: gh });
    rect = square;
  } else {
    crop = { x: 0, y: 0, w: Math.min(SEARCH_PX, info.width), h: Math.min(SEARCH_PX, info.height) };
    const gw = Math.max(1, Math.round(crop.w / CELL_PX));
    const gh = Math.max(1, Math.round(crop.h / CELL_PX));
    frames = await readGrayFrames(tools, caps, info.file, crop, gw, gh, expected);
    const found = findSquare(frames);
    if (found === null) {
      throw new VideoError(
        `No blinking square in the top-left ${crop.w} x ${crop.h} px of the recording (looked at ${frames.count} frames). ` +
          'Give its place with --square x,y,w,h (pixels of the recording; Preview shows them on a still frame).',
      );
    }
    box = innerBox(found.box);
    rect = cellBoxToRect(found.box, crop, gw, gh);
  }
  const luma = regionLuma(frames, box);
  const on = flashOnsets(frames.times, luma);
  if (on === null) {
    throw new VideoError(`The square at ${rect.x},${rect.y} (${rect.w} x ${rect.h} px) never turns bright in the recording: no flashes.`);
  }
  const frameS = frameSeconds(info.fps, frames.times);
  const last = frames.times[frames.count - 1] as number;
  return {
    rect,
    auto: square === null,
    onsets: on.onsets,
    pulses: on.pulses,
    long: on.long,
    low: on.low,
    high: on.high,
    frames: frames.count,
    span: [frames.times[0] as number, last + frameS],
    frameS,
  };
}

export function median(xs: readonly number[]): number | null {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 === 1 ? (s[m] as number) : ((s[m - 1] as number) + (s[m] as number)) / 2;
}
