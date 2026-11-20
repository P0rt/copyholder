// The figure of `npm run replay -- --svg <out.svg> --png <out.png>`, pooled over every set: one
// dot per valid objection and detector, at t_s - t_v of the earliest stop in [t_v - 1.5 s,
// t_v + 0.5 s] (analysis/gate/rows.ts windowStopN, the window of rows 2 and 5), so a dot left of
// 0 is a stop that would have silenced the narrator before the voice. Stage B's lead is
// t_v - t_s: the same number with the sign turned. An objection without a stop in that window
// sits in the "no stop" column at the right. Plain SVG on a white box (no font file, no script),
// so it reads the same on a light or a dark page; the PNG is that SVG drawn by headless Chrome at
// 2x, started as tools/video/textpng.ts starts it (--chrome or PW_CHROMIUM_PATH).

import { MAC_CHROME, firstLine, type ChromePath } from '../../tools/video/textpng.ts';
import type { ReplayTable } from './table.ts';

/** Width of the SVG in px; the PNG is twice as wide (1200 px). */
export const FIGURE_WIDTH = 600;
export const PNG_SCALE = 2;
/** The axis, ms around the voice onset t_v (spec 4.2: W = 1.5 s before, 0.5 s after). */
export const AXIS_MS: readonly [number, number] = [-1500, 500];
export const TICKS_MS: readonly number[] = [-1500, -1000, -500, 0, 500];

/** Series colors (categorical slots 1 and 2 of the dataviz reference palette, checked for color vision deficiency on white). */
const CHEST = '#2a78d6';
const LIPS = '#eb6834';
const INK = '#1f1f1e';
const MUTED = '#5f5e58';
const GRID = '#e3e2dc';

const R = 4;
const STEP = 2 * R + 2;
/** A stack of dots at one time reaches at most this far above and below its row's line; dots overlap beyond. */
const MAX_HALF_STACK = 60;
const X0 = 150;
const X1 = 480;
const NO_STOP_X = 540;
const NO_STOP_COLS = 5;

/** Chrome could not draw the PNG: the message says how to name it. */
export class FigureError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FigureError';
  }
}

export interface FigureRow {
  label: string;
  color: string;
  /** t_s - t_v in ms per valid objection; null: no stop in the window. */
  points: { offsetMs: number | null; tip: string }[];
}

export interface FigureData {
  title: string;
  caption: string[];
  rows: FigureRow[];
  footnote: string[];
}

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** "A", "A and B", "A, B and C". */
function listed(items: readonly string[]): string {
  if (items.length <= 1) return items.join('');
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}

const signed = (ms: number): string => (ms > 0 ? `+${ms}` : `${ms}`);

/** Characters per line of the small text: about 560 px of 11 px sans-serif. */
const WRAP = 104;

/** Lines of at most `max` characters, broken at spaces. */
export function wrap(text: string, max = WRAP): string[] {
  const out: string[] = [];
  let line = '';
  for (const word of text.split(' ')) {
    if (line !== '' && line.length + 1 + word.length > max) {
      out.push(line);
      line = word;
    } else {
      line = line === '' ? word : `${line} ${word}`;
    }
  }
  if (line !== '') out.push(line);
  return out;
}

/** The figure's content from the replay table: same stops, same rounding. */
export function figureData(table: ReplayTable): FigureData {
  const valid = table.rows.filter((r) => r.valid);
  const point = (r: (typeof valid)[number], cell: 'chest' | 'lips'): { offsetMs: number | null; tip: string } => {
    const lead = r[cell]?.lead_ms ?? null;
    const offsetMs = lead === null ? null : lead === 0 ? 0 : -lead;
    const where = `data/${r.id}/ cue ${r.cue}`;
    return { offsetMs, tip: offsetMs === null ? `${where}: no stop` : `${where}: t_s - t_v = ${signed(offsetMs)} ms` };
  };
  const chest = valid.map((r) => point(r, 'chest'));
  // A lips cell the readings of the packets with g null leave open (table.ts lips_why) is no point.
  const lips = valid.filter((r) => r.lips !== null).map((r) => point(r, 'lips'));
  const packs = [...new Set(table.sets.map((s) => s.pack))];
  const left = table.sets.filter((s) => s.lips_unknown.length > 0).map((s) => `${s.set} ${s.lips_unknown.length === 1 ? 'cue' : 'cues'} ${listed(s.lips_unknown.map(String))}`);
  return {
    title: `Stops around the voice onset, gate ${packs.length === 1 ? 'pack' : 'packs'} ${listed(packs)}`,
    caption: [
      'One dot per valid objection: t_s - t_v of the first stop within 1500 ms before to 500 ms after the voice onset.',
      "Left of 0 the narrator went silent before the voice. Stage B's lead is t_v - t_s, the same value with the sign turned.",
    ],
    rows: [
      { label: `chest D1 (n = ${chest.length})`, color: CHEST, points: chest },
      { label: `lips G (n = ${lips.length})`, color: LIPS, points: lips },
    ],
    footnote: [
      `recomputed from ${listed(table.sets.map((s) => s.set))} by npm run replay`,
      ...(left.length > 0
        ? [
            `the lips row leaves out ${listed(left)}: stream.jsonl does not say which packets with g null were reset frames of G, and the two readings, every one or none, place the lips stop differently`,
          ]
        : []),
    ],
  };
}

function xOf(ms: number): number {
  return X0 + ((ms - AXIS_MS[0]) / (AXIS_MS[1] - AXIS_MS[0])) * (X1 - X0);
}

/** Levels 0, +1, -1, +2, ... so that dots of one level keep apart: a dot plot without overlaps. */
function stack(xs: readonly number[]): number[] {
  const order = xs.map((x, i) => [x, i] as const).sort((a, b) => a[0] - b[0]);
  const placed = new Map<number, number[]>();
  const level = new Array<number>(xs.length).fill(0);
  for (const [x, i] of order) {
    for (let k = 0; ; k++) {
      const l = k === 0 ? 0 : k % 2 === 1 ? (k + 1) / 2 : -k / 2;
      const at = placed.get(l) ?? [];
      if (at.every((p) => Math.abs(p - x) >= STEP)) {
        at.push(x);
        placed.set(l, at);
        level[i] = l;
        break;
      }
    }
  }
  return level;
}

interface Placed {
  x: number;
  dy: number;
  tip: string;
}

function placeRow(row: FigureRow): { dots: Placed[]; up: number; down: number } {
  const onAxis = row.points.filter((p) => p.offsetMs !== null);
  const none = row.points.filter((p) => p.offsetMs === null);
  const xs = onAxis.map((p) => xOf(p.offsetMs!));
  const levels = stack(xs);
  const deepest = Math.max(0, ...levels.map(Math.abs));
  const dy = deepest > 0 ? Math.min(STEP, MAX_HALF_STACK / deepest) : STEP;
  const dots: Placed[] = onAxis.map((p, i) => ({ x: xs[i]!, dy: levels[i]! * dy, tip: p.tip }));
  const cols = Math.min(NO_STOP_COLS, Math.max(1, none.length));
  const lines = Math.ceil(none.length / NO_STOP_COLS);
  none.forEach((p, k) => {
    const c = k % NO_STOP_COLS;
    const l = Math.floor(k / NO_STOP_COLS);
    dots.push({ x: NO_STOP_X + (c - (cols - 1) / 2) * STEP, dy: (l - (lines - 1) / 2) * STEP, tip: p.tip });
  });
  const up = Math.ceil(Math.max(0, ...dots.map((d) => -d.dy)));
  const down = Math.ceil(Math.max(0, ...dots.map((d) => d.dy)));
  return { dots, up, down };
}

/** The SVG text; its height follows the rows. */
export function figureSvg(data: FigureData): { svg: string; width: number; height: number } {
  const d: FigureData = { ...data, caption: data.caption.flatMap((l) => wrap(l)), footnote: data.footnote.flatMap((l) => wrap(l)) };
  const out: string[] = [];
  const titleY = 28;
  const captionY = titleY + 22;
  let y = captionY + 16 * (d.caption.length - 1) + 30;
  const top = y;
  const rows = d.rows.map((row) => {
    const p = placeRow(row);
    const center = y + Math.max(18, p.up + R + 8);
    y = center + Math.max(18, p.down + R + 8);
    return { row, ...p, center, bottom: y };
  });
  const bottom = y;
  const tickY = bottom + 16;
  const axisTitleY = tickY + 18;
  const footY = axisTitleY + 26;
  const height = footY + 15 * (d.footnote.length - 1) + 14;
  const W = FIGURE_WIDTH;

  out.push(`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${height}" viewBox="0 0 ${W} ${height}" role="img" aria-labelledby="fig-title fig-desc" font-family="Helvetica, Arial, sans-serif">`);
  out.push(`<title id="fig-title">${esc(d.title)}</title>`);
  out.push(`<desc id="fig-desc">${esc([...d.caption, ...d.rows.map((r) => r.label), ...d.footnote].join(' '))}</desc>`);
  out.push(`<rect x="0" y="0" width="${W}" height="${height}" fill="#ffffff"/>`);
  out.push(`<text x="16" y="${titleY}" font-size="15" font-weight="600" fill="${INK}">${esc(d.title)}</text>`);
  d.caption.forEach((line, i) => out.push(`<text x="16" y="${captionY + 16 * i}" font-size="11" fill="${MUTED}">${esc(line)}</text>`));

  // Recessive grid at the ticks, the line at 0 in ink, and the frame of the "no stop" column.
  for (const t of TICKS_MS) {
    const x = xOf(t).toFixed(1);
    out.push(`<line x1="${x}" y1="${top}" x2="${x}" y2="${bottom}" stroke="${t === 0 ? INK : GRID}" stroke-width="1"/>`);
    out.push(`<text x="${x}" y="${tickY}" font-size="11" fill="${MUTED}" text-anchor="middle">${signed(t)}</text>`);
  }
  const colLeft = NO_STOP_X - (NO_STOP_COLS * STEP) / 2 - 4;
  out.push(`<rect x="${colLeft}" y="${top}" width="${NO_STOP_COLS * STEP + 8}" height="${bottom - top}" fill="#f6f6f3"/>`);
  out.push(`<text x="${NO_STOP_X}" y="${tickY}" font-size="11" fill="${MUTED}" text-anchor="middle">no stop</text>`);
  out.push(`<text x="${xOf(-500).toFixed(1)}" y="${axisTitleY}" font-size="11" fill="${MUTED}" text-anchor="middle">t_s - t_v, ms (negative: stop before the voice)</text>`);

  for (const r of rows) {
    out.push(`<line x1="${X0}" y1="${r.bottom}" x2="${X1}" y2="${r.bottom}" stroke="${GRID}" stroke-width="1"/>`);
    out.push(`<text x="${X0 - 12}" y="${r.center + 4}" font-size="12" fill="${INK}" text-anchor="end">${esc(r.row.label)}</text>`);
    for (const dot of r.dots) {
      out.push(
        `<circle cx="${dot.x.toFixed(1)}" cy="${(r.center + dot.dy).toFixed(1)}" r="${R}" fill="${r.row.color}" stroke="#ffffff" stroke-width="1.5"><title>${esc(dot.tip)}</title></circle>`,
      );
    }
  }
  d.footnote.forEach((line, i) => out.push(`<text x="16" y="${footY + 15 * i}" font-size="10.5" fill="${MUTED}">${esc(line)}</text>`));
  out.push('</svg>');
  return { svg: `${out.join('\n')}\n`, width: W, height };
}

/** The SVG drawn by headless Chrome at PNG_SCALE: a PNG FIGURE_WIDTH * 2 px wide. */
export async function figurePng(svg: { svg: string; width: number; height: number }, chrome: ChromePath): Promise<Buffer> {
  let launch: typeof import('@playwright/test').chromium.launch;
  try {
    const { chromium } = await import('@playwright/test');
    launch = chromium.launch.bind(chromium);
  } catch (e) {
    throw new FigureError(`Playwright, which starts Chrome for the PNG, could not be loaded (${firstLine(e)}): npm ci in the repository installs it`);
  }
  let browser: Awaited<ReturnType<typeof launch>>;
  try {
    browser = await launch({ headless: true, ...(chrome.path !== null ? { executablePath: chrome.path } : {}) });
  } catch (e) {
    const tried = chrome.path === null ? "Playwright's own Chromium" : `${chrome.from} ${chrome.path}`;
    throw new FigureError(`Chrome did not start to draw the PNG (${firstLine(e)}; tried ${tried}). Name it with --chrome <path> or PW_CHROMIUM_PATH, on the Mac "${MAC_CHROME}"`);
  }
  try {
    const context = await browser.newContext({ deviceScaleFactor: PNG_SCALE, viewport: { width: svg.width, height: svg.height } });
    const page = await context.newPage();
    await page.setContent(`<!doctype html><html><head><meta charset="utf-8"><style>html,body{margin:0;background:#ffffff}svg{display:block}</style></head><body>${svg.svg}</body></html>`);
    return await page.screenshot({ type: 'png', clip: { x: 0, y: 0, width: svg.width, height: svg.height } });
  } catch (e) {
    throw new FigureError(`Chrome could not draw the PNG: ${firstLine(e)}`);
  } finally {
    await browser.close().catch(() => undefined);
  }
}
