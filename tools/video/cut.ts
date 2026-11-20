// The live take as one uncut piece (spec 15.1-15.4): which session seconds go in, and the ffmpeg
// command that cuts the screen recording there, lays the app's own sound under it and writes the
// two captions: "LIVE · take k of n" at the top right for the whole take (spec 15.3 point 4) and
// the line about the sound at the bottom for its first 5 s (spec 15.4). drawtext writes them; an
// ffmpeg without it overlays the same captions as PNG pictures that Chrome drew (textpng.ts), at
// the same places (within a pixel or two) and times, on the same frames.

import { LOOP_STEPS } from '../../analysis/lib/steps.ts';
import { DEMO_CLICK_STARTS_MS } from '../../web/lib/clicks.ts';
import { d1At, firstDemoClick, recordedSpan, steps, type ClickGroup, type VideoSession } from './session.ts';
import {
  AUDIO_ENCODER_ARGS,
  encodeHead,
  escapeFilterValue,
  MP4_ARGS,
  secondsArg,
  videoEncoderArgs,
  VideoError,
  type CaptionMode,
  type FfmpegCaps,
} from './ffmpeg.ts';
import type { CaptionImage } from './textpng.ts';

export const SOUND_LINE = "Sound: the app's own recording, aligned to the picture by the clicks";
/** The sound line stays this long (s). */
export const SOUND_LINE_S = 5;
/**
 * The shown part opens with the three demo clicks, 3 s before the text (spec 15.1, 15.2: 0:00-0:03
 * three flashes and three clicks): the click block starts this long before its first click (s).
 */
export const CLICK_BLOCK_LEAD_S = (DEMO_CLICK_STARTS_MS[0] ?? 0) / 1000;
/** The shown part ends after the signal check, where the prompt of loop check B starts (spec 15.1, 15.2). */
export const END_STEP = LOOP_STEPS.readyB;
/** The screen recording is opened this long before the cut, so the frame on screen at its start is known (s). */
const SEEK_MARGIN_S = 3;

export const TAKE_FILE = 'take.txt';
export const SOUND_FILE = 'sound.txt';
/** The captions as PNG pictures (--captions png, or an ffmpeg without drawtext). */
export const TAKE_PNG = 'take.png';
export const SOUND_PNG = 'sound.png';

export interface Take {
  k: number;
  n: number;
  /** --rehearsal: a trial video, never a take (a run with the mock tap needs it). */
  rehearsal?: boolean;
}

export function takeCaption(t: Take): string {
  return t.rehearsal === true ? 'REHEARSAL · not a take' : `LIVE · take ${t.k} of ${t.n}`;
}

/** "1/2" as take 1 of 2; null when it is not k/n with 1 <= k <= n <= 9. */
export function parseTake(text: string): Take | null {
  const m = /^\s*(\d+)\s*\/\s*(\d+)\s*$/.exec(text);
  if (!m) return null;
  const k = Number(m[1]);
  const n = Number(m[2]);
  return k >= 1 && k <= n && n <= 9 ? { k, n } : null;
}

export type TimeArg = { seconds: number } | { step: string };

/** "95.5" or "1:35.5" as session seconds; anything else names a step of stamps.jsonl. */
export function parseTimeArg(text: string): TimeArg {
  const t = text.trim();
  if (/^\d+(\.\d+)?$/.test(t)) return { seconds: Number(t) };
  const m = /^(\d+):([0-5]?\d(?:\.\d+)?)$/.exec(t);
  if (m) return { seconds: 60 * Number(m[1]) + Number(m[2]) };
  return { step: t };
}

/**
 * Session or recording time as m:ss.sss. Rounded to `decimals` first and then split, so 59.97 s
 * at one decimal is 1:00.0, never 0:60.0.
 */
export function clock(s: number, decimals = 3): string {
  const scale = 10 ** decimals;
  const units = Math.round(Math.abs(s) * scale);
  const perMinute = 60 * scale;
  const m = Math.floor(units / perMinute);
  const rest = ((units - m * perMinute) / scale).toFixed(decimals);
  const sign = s < 0 && units > 0 ? '-' : '';
  return `${sign}${m}:${Number(rest) < 10 ? '0' : ''}${rest}`;
}

export interface CutInputs {
  session: Pick<VideoSession, 'sampleRateHz' | 'layout' | 'stamps' | 'events'>;
  groups: readonly ClickGroup[];
  /** Recording time = session time + offsetS. */
  offsetS: number;
  /** Recording time covered by frames. */
  span: readonly [number, number];
  from?: TimeArg | undefined;
  to?: TimeArg | undefined;
}

export interface CutPlan {
  rateHz: number;
  /** Session samples [nFrom, nTo). */
  nFrom: number;
  nTo: number;
  durationS: number;
  /** Recording time of nFrom. */
  videoFromS: number;
  /** -ss of the screen recording, and the cut's start after that seek. */
  seekS: number;
  startAfterSeekS: number;
  /** Where the start and the end came from, for the printout. */
  fromWhat: string;
  toWhat: string;
  /** Clamps and hints, in plain words. */
  notes: string[];
}

function resolveTime(arg: TimeArg, session: CutInputs['session'], what: string): number {
  if ('seconds' in arg) return arg.seconds;
  const all = steps(session);
  const hit = all.find((m) => m.name === arg.step);
  if (!hit) {
    const names = [...new Set(all.map((m) => m.name))];
    throw new VideoError(`${what} ${arg.step}: no such number or step (steps: ${names.slice(0, 40).join(', ') || 'none'})`);
  }
  return hit.n / session.sampleRateHz;
}

/**
 * The session seconds of the cut. Default (spec 15.1, 15.2): from the start of the demo click block,
 * 3 s before the text, to the prompt of loop check B after the signal check, else to the end of the
 * recording; both kept inside the recorded audio and the screen recording.
 */
export function planCut(inp: CutInputs): CutPlan {
  const rate = inp.session.sampleRateHz;
  const notes: string[] = [];
  const rec = recordedSpan(inp.session);
  const lo = Math.max(rec.n0 / rate, inp.span[0] - inp.offsetS);
  const hi = Math.min(rec.n1 / rate, inp.span[1] - inp.offsetS);
  if (!(hi > lo)) throw new VideoError('The screen recording and the session audio do not overlap.');

  let from: number;
  let fromWhat: string;
  if (inp.from !== undefined) {
    from = resolveTime(inp.from, inp.session, '--from');
    fromWhat = '--from';
  } else {
    const demo = firstDemoClick(inp.groups);
    if (demo !== null) {
      from = demo / rate - CLICK_BLOCK_LEAD_S;
      fromWhat = 'the demo clicks';
    } else {
      from = lo;
      fromWhat = 'the start of both recordings';
      notes.push('No demo clicks in stamps.jsonl: the cut starts where both recordings begin (give --from to change it).');
    }
  }
  let to: number;
  let toWhat: string;
  if (inp.to !== undefined) {
    to = resolveTime(inp.to, inp.session, '--to');
    toWhat = '--to';
  } else {
    const endMark = steps(inp.session).find((m) => m.name === END_STEP && m.n / rate > from);
    to = endMark ? endMark.n / rate : rec.n1 / rate;
    toWhat = endMark ? `step ${END_STEP}, after the signal check` : 'the end of the recording';
  }
  if (from < lo) {
    notes.push(`The cut starts at ${clock(lo, 1)} instead of ${clock(from, 1)}: the ${lo === rec.n0 / rate ? 'session audio' : 'screen recording'} begins there.`);
    from = lo;
  }
  if (to > hi) {
    notes.push(`The cut ends at ${clock(hi, 1)} instead of ${clock(to, 1)}: the ${hi === rec.n1 / rate ? 'session audio' : 'screen recording'} ends there.`);
    to = hi;
  }
  if (!(to - from >= 0.5)) throw new VideoError(`Nothing to cut: from ${clock(from, 1)} to ${clock(to, 1)} (session time).`);

  const nFrom = Math.round(from * rate);
  const nTo = Math.round(to * rate);
  const videoFromS = nFrom / rate + inp.offsetS;
  const seekS = Math.max(0, videoFromS - SEEK_MARGIN_S);
  // D1 arms only after some breaths of reading (spec 7.4), so it is seldom active at the clicks;
  // spec 15.1 would start the segment where it becomes active. Said, not done: that would cut the
  // three sync clicks out of the picture.
  const d1 = d1At(inp.session.events, nFrom);
  if (d1 && !d1.active) {
    notes.push(
      d1.nextOn === null || d1.nextOn >= nTo
        ? 'D1 was not active at any time in the cut (events.jsonl).'
        : `D1 was not active at the start of the cut; it became active at ${clock(d1.nextOn / rate, 1)}, ` +
            `${((d1.nextOn - nFrom) / rate).toFixed(1)} s in (spec 15.1 would start there: --from ${(d1.nextOn / rate).toFixed(2)}).`,
    );
  }
  return {
    rateHz: rate,
    nFrom,
    nTo,
    durationS: (nTo - nFrom) / rate,
    videoFromS,
    seekS,
    startAfterSeekS: videoFromS - seekS,
    fromWhat,
    toWhat,
    notes,
  };
}

// ---- the command --------------------------------------------------------------------------

export interface CaptionFile {
  name: string;
  text: string;
}

/** The caption texts, as files next to the mix (drawtext reads them verbatim: no escaping). */
export function captionFiles(take: Take | null): CaptionFile[] {
  return [...(take ? [{ name: TAKE_FILE, text: takeCaption(take) }] : []), { name: SOUND_FILE, text: SOUND_LINE }];
}

/** Average glyph width of the caption fonts, in units of the font size (for fitting a line). */
const GLYPH_EM = 0.56;

export interface TextBox {
  file: string;
  font: string;
  size: number;
  x: string;
  y: string;
  /** Padding of the dark box behind the text; 0 for none. */
  pad: number;
  /** drawtext `enable` expression. */
  enable?: string;
  /** y is the top of the font's ascent rather than of the text's own box (FFmpeg 6.1 and newer). */
  yAlignFont?: boolean;
}

/** One drawtext filter: white text from a file, verbatim, with an optional dark box. */
export function drawtext(t: TextBox): string {
  const opts = [
    `fontfile=${escapeFilterValue(t.font)}`,
    `textfile=${escapeFilterValue(t.file)}`,
    'expansion=none',
    'fontcolor=white',
    `fontsize=${t.size}`,
    `x=${t.x}`,
    `y=${t.y}`,
  ];
  if (t.yAlignFont) opts.push('y_align=font');
  if (t.pad > 0) opts.push('box=1', 'boxcolor=black@0.6', `boxborderw=${t.pad}`);
  if (t.enable !== undefined) opts.push(`enable=${escapeFilterValue(t.enable)}`);
  return `drawtext=${opts.join(':')}`;
}

export interface CutOutput {
  /** Output frame rate for the fps filter ("60/1") and as a number. */
  fpsText: string;
  fps: number;
  /** Size of the recording, and the output height when it is scaled down (--height). */
  width: number;
  height: number;
  scaleToHeight: number | null;
}

/** Output size: the recording's, or scaled to --height with an even width. */
export function outputSize(o: Pick<CutOutput, 'width' | 'height' | 'scaleToHeight'>): [number, number] {
  if (o.scaleToHeight === null) return [o.width - (o.width % 2), o.height - (o.height % 2)];
  const h = o.scaleToHeight - (o.scaleToHeight % 2);
  return [Math.max(2, 2 * Math.round((o.width * h) / o.height / 2)), h];
}

/** Font sizes and margins of the two captions for an output of w x h. */
export function captionLayout(w: number, h: number): { take: number; sound: number; margin: number } {
  const take = Math.max(8, Math.round(h * 0.036));
  const fitSound = Math.floor((0.92 * w) / (GLYPH_EM * SOUND_LINE.length));
  const sound = Math.max(8, Math.min(Math.round(h * 0.03), fitSound));
  return { take, sound, margin: Math.max(4, Math.round(h * 0.025)) };
}

/** Padding of the dark box around a caption, in pixels: 0.3 of its font size (drawtext's boxborderw). */
export function boxPad(size: number): number {
  return Math.round(size * 0.3);
}

/**
 * The captions as pictures for Chrome to draw (PNG captions): the same texts, font sizes and box
 * padding as the drawtext captions of an output of w x h. The take caption first, when there is one.
 */
export function captionImages(take: Take | null, w: number, h: number): CaptionImage[] {
  const l = captionLayout(w, h);
  const images: CaptionImage[] = [];
  if (take !== null) images.push({ kind: 'caption', name: TAKE_PNG, text: takeCaption(take), size: l.take, pad: boxPad(l.take) });
  images.push({ kind: 'caption', name: SOUND_PNG, text: SOUND_LINE, size: l.sound, pad: boxPad(l.sound) });
  return images;
}

/** The picture of the cut, without captions: frames on screen at each output instant, from the cut's start. */
function cutPicture(plan: CutPlan, out: CutOutput): string[] {
  const [w, h] = outputSize(out);
  const parts = [
    // Each output frame shows the last recorded frame at or before its instant (round=up), from
    // the cut's start; a variable-rate screen recording becomes a constant rate.
    `fps=fps=${out.fpsText}:start_time=${secondsArg(plan.startAfterSeekS)}:round=up`,
    `trim=duration=${secondsArg(plan.durationS)}`,
    'setpts=PTS-STARTPTS',
  ];
  if (out.scaleToHeight !== null) parts.push(`scale=${w}:${h}:flags=lanczos`);
  else if (out.width % 2 === 1 || out.height % 2 === 1) parts.push(`crop=${w}:${h}:0:0`);
  parts.push('format=yuv420p');
  return parts;
}

/** The video filter of the cut: frames on screen at each output instant, from the cut's start, with the captions. */
export function cutFilter(plan: CutPlan, out: CutOutput, font: string, take: Take | null): string {
  const [w, h] = outputSize(out);
  const parts = cutPicture(plan, out);
  const l = captionLayout(w, h);
  if (take !== null) {
    parts.push(drawtext({ file: TAKE_FILE, font, size: l.take, x: `w-tw-${l.margin}`, y: `${l.margin}`, pad: boxPad(l.take) }));
  }
  parts.push(
    drawtext({
      file: SOUND_FILE,
      font,
      size: l.sound,
      x: '(w-tw)/2',
      y: `h-th-${l.margin}`,
      pad: boxPad(l.sound),
      enable: `lt(t,${SOUND_LINE_S})`,
    }),
  );
  return `[0:v]${parts.join(',')}[v]`;
}

/**
 * One overlay of a still picture: an input of one frame, held over every frame of the main input
 * (eof_action=repeat, repeatlast), which alone sets the frames and their times (shortest=0). The
 * output stays yuv420p; there x and y are rounded down to even numbers.
 */
export function overlay(x: string, y: string, enable?: string): string {
  const opts = [`x=${x}`, `y=${y}`, 'eof_action=repeat', 'shortest=0', 'repeatlast=1', 'format=yuv420'];
  if (enable !== undefined) opts.push(`enable=${escapeFilterValue(enable)}`);
  return `overlay=${opts.join(':')}`;
}

/**
 * A caption picture made ready for overlay(x, y) on a frame of `W` x `H`. overlay puts a picture
 * on even columns and rows only (in yuv420 it rounds x and y down), which would move a caption up
 * to one pixel left of and above the place drawtext gives it. So where x or y, worked out with the
 * picture's own size, is odd, the picture first gets one transparent column at its left or one
 * transparent row at its top (in RGBA, where pad can add a single pixel): overlay then puts the
 * larger picture one pixel further left or up, on an even pixel, and the drawn pixels land on x
 * and y. x and y are overlay's expressions of W, H and w, h as cutFilterPng writes them: a fixed
 * number, or a place that moves left or up as the picture grows (W-w-..., (W-w)/2, H-h-...).
 */
export function evenPlace(x: string, y: string, W: number, H: number): string {
  const own = (e: string): string =>
    e.replace(/\bW\b/g, String(W)).replace(/\bH\b/g, String(H)).replace(/\bw\b/g, 'iw').replace(/\bh\b/g, 'ih');
  const odd = (e: string): string => escapeFilterValue(`mod(floor(${own(e)}),2)`);
  return `format=rgba,pad=w=iw+${odd(x)}:h=ih+${odd(y)}:x=${odd(x)}:y=${odd(y)}:color=black@0`;
}

/** Input number of the first caption picture of the cut: 0 is the screen recording, 1 the mix. */
export const CUT_PICTURE_INPUT = 2;

/**
 * The video filter of the cut with the captions as pictures (captionImages, inputs 2 and up, the
 * take caption first): the same picture as cutFilter, then each PNG overlaid. A PNG is drawtext's
 * box, `pad` px around the text, so it goes `pad` px further out than the text: drawtext puts the
 * text `margin` px from the edges, and the box's outer edge lands where drawtext draws its own,
 * to the pixel (evenPlace). The text inside it is Chrome's: it may sit a pixel higher or lower
 * than drawtext's, and the box may be a pixel or two taller, as Chrome measures letters its own way.
 */
export function cutFilterPng(plan: CutPlan, out: CutOutput, take: Take | null): string {
  const [w, h] = outputSize(out);
  const l = captionLayout(w, h);
  const graph = [`[0:v]${cutPicture(plan, out).join(',')}[cut]`];
  const shown: Array<{ label: string; x: string; y: string; enable?: string }> = [];
  if (take !== null) {
    const pad = boxPad(l.take);
    shown.push({ label: 'take', x: `W-w-${l.margin}+${pad}`, y: `${l.margin}-${pad}` });
  }
  const pad = boxPad(l.sound);
  shown.push({ label: 'sound', x: '(W-w)/2', y: `H-h-${l.margin}+${pad}`, enable: `lt(t,${SOUND_LINE_S})` });
  let last = 'cut';
  shown.forEach((p, k) => {
    const next = k === shown.length - 1 ? 'v' : p.label;
    graph.push(`[${CUT_PICTURE_INPUT + k}:v]${evenPlace(p.x, p.y, w, h)}[${p.label}png]`);
    graph.push(`[${last}][${p.label}png]${overlay(p.x, p.y, p.enable)}[${next}]`);
    last = next;
  });
  return graph.join(';');
}

export interface CutCommand {
  plan: CutPlan;
  output: CutOutput;
  /** Absolute path of the screen recording. */
  screen: string;
  /** The mix WAV (relative to the temporary folder ffmpeg runs in, or absolute). */
  mix: string;
  /** Absolute path of the mp4 to write. */
  out: string;
  /** The font file drawtext reads (unused for PNG captions). */
  font: string;
  take: Take | null;
  caps: Pick<FfmpegCaps, 'libx264' | 'videotoolbox'>;
  progress: boolean;
  /** drawtext (the default), or the PNG files of captionImages overlaid. */
  captions?: CaptionMode;
}

/**
 * ffmpeg arguments of the cut. Run with the caption files (or the caption PNGs) in the working
 * folder. Both modes map, time and encode alike; only the drawing of the captions differs.
 */
export function cutArgs(c: CutCommand): string[] {
  const [w, h] = outputSize(c.output);
  const png = c.captions === 'png';
  // Each picture is one frame, at the output's frame rate, so its time base is the cut's own.
  const pictures = png ? captionImages(c.take, w, h).flatMap((p) => ['-framerate', c.output.fpsText, '-i', p.name]) : [];
  return [
    ...encodeHead(c.progress),
    ...(c.plan.seekS > 0 ? ['-ss', secondsArg(c.plan.seekS)] : []),
    '-i', c.screen,
    '-i', c.mix,
    ...pictures,
    '-filter_complex', png ? cutFilterPng(c.plan, c.output, c.take) : cutFilter(c.plan, c.output, c.font, c.take),
    '-map', '[v]',
    '-map', '1:a',
    '-t', secondsArg(c.plan.durationS),
    ...videoEncoderArgs(c.caps, w, h, c.output.fps),
    ...AUDIO_ENCODER_ARGS,
    ...MP4_ARGS,
    c.out,
  ];
}
