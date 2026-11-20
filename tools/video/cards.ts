// Title cards (spec 15.2): white text on black, one card after another, each for its own number of
// seconds, at a given size and frame rate, with a silent sound track so the clips join cleanly.
// Card texts pass the same banned-word check as lint:words (spec 13.6, 15.6). drawtext writes the
// lines; an ffmpeg without it overlays each card as one PNG frame that Chrome drew (textpng.ts),
// with the same lines at the same places, while that card shows.
//
// cards.json: either a list of cards or {"size": "1920x1080", "fps": 60, "cards": [...]}; a card is
// {"text": "line one\nline two", "seconds": 4} or {"lines": ["line one", "line two"], "seconds": 4},
// with an optional "fontSize" in pixels.

import { drawtext, overlay, type CaptionFile } from './cut.ts';
import {
  AUDIO_ENCODER_ARGS,
  encodeHead,
  isSaneFps,
  MP4_ARGS,
  parseRational,
  secondsArg,
  videoEncoderArgs,
  VideoError,
  type CaptionMode,
  type FfmpegCaps,
} from './ffmpeg.ts';
import type { CardImage, CardLine } from './textpng.ts';

export interface Card {
  lines: string[];
  seconds: number;
  fontSize?: number;
}

export interface CardsSpec {
  cards: Card[];
  size: [number, number] | null;
  fpsText: string | null;
}

/** All cards together at most this long (s): titles, not a film. */
const MAX_TOTAL_S = 600;

/** "1920x1080" as [1920, 1080], even sizes from 16 to 7680; null otherwise. */
export function parseSize(text: string): [number, number] | null {
  const m = /^\s*(\d+)\s*[x×]\s*(\d+)\s*$/.exec(text);
  if (!m) return null;
  const w = Number(m[1]);
  const h = Number(m[2]);
  const ok = (v: number): boolean => v >= 16 && v <= 7680 && v % 2 === 0;
  return ok(w) && ok(h) ? [w, h] : null;
}

/** A frame rate argument ("60", "30000/1001") as ffmpeg takes it; null when it is not 5 to 240. */
export function parseFps(text: string | number): string | null {
  const t = String(text).trim();
  return isSaneFps(parseRational(t)) ? t : null;
}

/** Reads cards.json. Throws VideoError listing every problem. */
export function parseCards(text: string): CardsSpec {
  let v: unknown;
  try {
    v = JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
  } catch (e) {
    throw new VideoError(`cards: not valid JSON (${(e as Error).message})`);
  }
  const problems: string[] = [];
  const o = Array.isArray(v) ? { cards: v } : v && typeof v === 'object' ? (v as Record<string, unknown>) : null;
  if (o === null || !Array.isArray(o['cards'])) throw new VideoError('cards: expected a list of cards, or an object with "cards"');
  let size: [number, number] | null = null;
  if (o['size'] !== undefined) {
    size = typeof o['size'] === 'string' ? parseSize(o['size']) : null;
    if (size === null) problems.push('size: expected "WIDTHxHEIGHT" with even numbers, like "1920x1080"');
  }
  let fpsText: string | null = null;
  if (o['fps'] !== undefined) {
    fpsText = typeof o['fps'] === 'number' || typeof o['fps'] === 'string' ? parseFps(o['fps']) : null;
    if (fpsText === null) problems.push('fps: expected a frame rate from 5 to 240, like 60 or "30000/1001"');
  }
  const cards: Card[] = [];
  (o['cards'] as unknown[]).forEach((c, i) => {
    const at = `card ${i + 1}`;
    if (!c || typeof c !== 'object' || Array.isArray(c)) {
      problems.push(`${at}: expected an object with "text" (or "lines") and "seconds"`);
      return;
    }
    const r = c as Record<string, unknown>;
    let lines: string[] | null = null;
    if (typeof r['text'] === 'string') lines = r['text'].split(/\r?\n/);
    else if (Array.isArray(r['lines']) && r['lines'].every((l) => typeof l === 'string')) lines = r['lines'] as string[];
    if (lines === null || lines.every((l) => l.trim() === '')) problems.push(`${at}: "text" (a string) or "lines" (strings) with some text is needed`);
    const seconds = r['seconds'];
    if (typeof seconds !== 'number' || !(seconds > 0) || seconds > MAX_TOTAL_S) problems.push(`${at}: "seconds" must be a number above 0 and at most ${MAX_TOTAL_S}`);
    const fontSize = r['fontSize'];
    if (fontSize !== undefined && (typeof fontSize !== 'number' || !Number.isInteger(fontSize) || fontSize < 8 || fontSize > 400)) {
      problems.push(`${at}: "fontSize" must be a whole number of pixels from 8 to 400`);
    }
    if (lines !== null && typeof seconds === 'number') cards.push({ lines, seconds, ...(typeof fontSize === 'number' ? { fontSize } : {}) });
  });
  if (cards.length === 0 && problems.length === 0) problems.push('cards: the list is empty');
  const total = cards.reduce((a, c) => a + c.seconds, 0);
  if (total > MAX_TOTAL_S) problems.push(`cards: ${total} s in all, more than ${MAX_TOTAL_S} s`);
  if (problems.length > 0) throw new VideoError(`cards:\n  ${problems.join('\n  ')}`);
  return { cards, size, fpsText };
}

/** The whole text of the cards, one card after another, for the banned-word check. */
export function cardsText(spec: CardsSpec): string {
  return spec.cards.map((c) => c.lines.join('\n')).join('\n');
}

const GLYPH_EM = 0.56;
const LINE_HEIGHT = 1.35;

/** Font size of a card on a w x h frame: its own, or 1/16 of the height, shrunk until every line fits. */
export function cardFontSize(card: Card, w: number, h: number): number {
  let s = card.fontSize ?? Math.round(h / 16);
  const longest = Math.max(1, ...card.lines.map((l) => [...l].length));
  s = Math.min(s, Math.floor((0.9 * w) / (GLYPH_EM * longest)));
  s = Math.min(s, Math.floor((0.9 * h) / (LINE_HEIGHT * Math.max(1, card.lines.length))));
  return Math.max(8, s);
}

/** A line of a card with text: its place among the card's lines (from 0), font size and drawtext y. */
export interface PlacedLine extends CardLine {
  index: number;
}

/**
 * The lines of a card on a w x h frame, both modes alike: one font size, LINE_HEIGHT apart, the
 * block centred in height; `top` is drawtext's y (with y_align=font, the top of the font's ascent).
 * Blank lines keep their place and are not drawn.
 */
export function cardLines(card: Card, w: number, h: number): PlacedLine[] {
  const s = cardFontSize(card, w, h);
  const lineH = Math.round(LINE_HEIGHT * s);
  const top = Math.round((h - (card.lines.length - 1) * lineH - s) / 2);
  return card.lines.flatMap((text, j) => (text.trim() === '' ? [] : [{ index: j, text, size: s, top: top + j * lineH }]));
}

export interface CardsCommand {
  spec: CardsSpec;
  size: [number, number];
  fpsText: string;
  /** The font file drawtext reads (unused for PNG cards). */
  font: string;
  out: string;
  caps: Pick<FfmpegCaps, 'libx264' | 'videotoolbox' | 'yAlign'>;
  progress: boolean;
  /** drawtext (the default), or one PNG frame per card overlaid. */
  captions?: CaptionMode;
}

export interface CardsPlan {
  args: string[];
  /** Text files the filter reads, to write into the folder ffmpeg runs in (drawtext). */
  files: CaptionFile[];
  /** Card frames for Chrome to draw into that folder (PNG cards). */
  images: CardImage[];
  totalS: number;
}

/** Input number of the first card picture: 0 is the black source, 1 the silence. */
export const CARD_PICTURE_INPUT = 2;

/**
 * ffmpeg arguments of the cards: a black source and silence; one drawtext per line, or one PNG
 * frame per card overlaid, enabled while its card shows. Both modes map, time and encode alike.
 */
export function cardsPlan(c: CardsCommand): CardsPlan {
  const [w, h] = c.size;
  const png = c.captions === 'png';
  const files: CaptionFile[] = [];
  const images: CardImage[] = [];
  const enables: string[] = [];
  const filters: string[] = ['format=yuv420p'];
  let t = 0;
  c.spec.cards.forEach((card, i) => {
    const enable = `gte(t,${secondsArg(t)})*lt(t,${secondsArg(t + card.seconds)})`;
    const lines = cardLines(card, w, h);
    if (png) {
      images.push({ kind: 'card', name: `card${i + 1}.png`, width: w, height: h, lines: lines.map(({ text, size, top }) => ({ text, size, top })) });
      enables.push(enable);
    } else {
      for (const l of lines) {
        const name = `card${i + 1}-${l.index + 1}.txt`;
        files.push({ name, text: l.text });
        filters.push(drawtext({ file: name, font: c.font, size: l.size, x: '(w-tw)/2', y: `${l.top}`, pad: 0, enable, yAlignFont: c.caps.yAlign }));
      }
    }
    t += card.seconds;
  });
  // PNG cards: each frame (the card's size, transparent around the text) over the black source.
  const graph = [`[0:v]format=yuv420p[${images.length === 0 ? 'v' : 'c0'}]`];
  images.forEach((_, k) => {
    graph.push(`[c${k}][${CARD_PICTURE_INPUT + k}:v]${overlay('0', '0', enables[k])}[${k === images.length - 1 ? 'v' : `c${k + 1}`}]`);
  });
  const fps = parseRational(c.fpsText);
  const args = [
    ...encodeHead(c.progress),
    '-f', 'lavfi', '-i', `color=c=black:s=${w}x${h}:r=${c.fpsText}:d=${secondsArg(t)}`,
    '-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=stereo',
    ...images.flatMap((p) => ['-framerate', c.fpsText, '-i', p.name]),
    '-filter_complex', png ? graph.join(';') : `[0:v]${filters.join(',')}[v]`,
    '-map', '[v]',
    '-map', '1:a',
    '-t', secondsArg(t),
    ...videoEncoderArgs(c.caps, w, h, fps),
    ...AUDIO_ENCODER_ARGS,
    ...MP4_ARGS,
    c.out,
  ];
  return { args, files, images, totalS: t };
}
