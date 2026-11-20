// Captions and title cards as PNG pictures drawn by Chrome (spec 15.2-15.4), for an ffmpeg without
// the drawtext filter (Homebrew's ffmpeg has no libfreetype). Playwright starts Chrome headless,
// once per command; every picture is an HTML page of its own in the folder ffmpeg runs in, and a
// screenshot of the page's one element, without the page background, is the PNG that ffmpeg lays
// over the picture. A caption is white text on the box drawtext draws (black at 60 %, the same
// padding, as tight around the text as drawtext's box); a card is the whole frame, transparent,
// with its lines where cardsPlan puts them. The font size is the one drawtext would be given, and
// 1 CSS px is 1 video px. The font file of --font (or the one findFont found) is loaded with
// @font-face from a file:// URL; without one, or when Chrome cannot read it, a sans-serif font of
// the system draws the text.

import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { Browser, BrowserType } from '@playwright/test';
import { VideoError } from './ffmpeg.ts';

/** One caption on its dark box: text at `size` px, `pad` px of box around it (drawtext's boxborderw). */
export interface CaptionImage {
  kind: 'caption';
  /** PNG file name in the folder ffmpeg runs in. */
  name: string;
  text: string;
  size: number;
  pad: number;
}

/** One line of a card: `top` is drawtext's y with y_align=font, the top of the font's ascent. */
export interface CardLine {
  text: string;
  size: number;
  top: number;
}

/** A whole card frame, transparent around the text. */
export interface CardImage {
  kind: 'card';
  name: string;
  width: number;
  height: number;
  lines: CardLine[];
}

export type TextImage = CaptionImage | CardImage;

/** Family name of the font file inside the pages. */
export const FONT_FAMILY = 'CopyholderCaption';

/** The Mac's Chrome, for the hints. */
export const MAC_CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

/** Waiting for one page to lay out its picture (ms). */
const PAGE_TIMEOUT_MS = 30_000;

/**
 * The fonts a page asks for: the font file's family first (when there is one), then the system
 * fonts findFont looks for, in the same order, then any sans-serif font.
 */
export function fontStack(withFile: boolean, platform: NodeJS.Platform): string {
  const mac = ['Helvetica', 'Arial'];
  const linux = ['"DejaVu Sans"', '"Liberation Sans"', 'FreeSans'];
  const system = platform === 'darwin' ? [...mac, ...linux] : [...linux, ...mac];
  return [...(withFile ? [`"${FONT_FAMILY}"`] : []), ...system, 'sans-serif'].join(', ');
}

/** The page's own script (plain JavaScript): lays out the picture and leaves its size in window.__textpng. */
const PAGE_SCRIPT = `
(async () => {
  const spec = JSON.parse(document.getElementById('spec').textContent);
  let fontLoaded = null;
  if (spec.fontFace) {
    try {
      await document.fonts.load('16px "${FONT_FAMILY}"');
    } catch (e) {
      // A font Chrome cannot read: the next font of the stack draws the text.
    }
    fontLoaded = Array.from(document.fonts).some((f) => f.status === 'loaded');
  }
  const font = (size) => size + 'px ' + spec.stack;
  const image = document.getElementById('image');
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d');
  if (spec.kind === 'caption') {
    // drawtext's box: the text's advance width and the height of its ink, pad px around them.
    ctx.font = font(spec.size);
    const m = ctx.measureText(spec.text);
    const w = Math.max(1, Math.ceil(m.width));
    const ascent = Math.ceil(m.actualBoundingBoxAscent);
    const h = Math.max(1, ascent + Math.ceil(m.actualBoundingBoxDescent));
    image.className = 'box';
    image.style.width = w + 'px';
    image.style.height = h + 'px';
    image.style.padding = spec.pad + 'px';
    // The canvas covers the padding too, so ink left of the first glyph's origin is not cut off.
    canvas.width = w + 2 * spec.pad;
    canvas.height = h + 2 * spec.pad;
    ctx.font = font(spec.size);
    ctx.fillStyle = '#fff';
    ctx.fillText(spec.text, spec.pad, spec.pad + ascent);
  } else {
    image.style.width = spec.width + 'px';
    image.style.height = spec.height + 'px';
    canvas.width = spec.width;
    canvas.height = spec.height;
    ctx.fillStyle = '#fff';
    for (const line of spec.lines) {
      // drawtext: x=(w-tw)/2, and y_align=font puts the baseline one font ascent below y.
      ctx.font = font(line.size);
      const m = ctx.measureText(line.text);
      ctx.fillText(line.text, Math.trunc((spec.width - Math.ceil(m.width)) / 2), line.top + Math.ceil(m.fontBoundingBoxAscent));
    }
  }
  image.appendChild(canvas);
  const r = image.getBoundingClientRect();
  window.__textpng = { width: Math.round(r.width), height: Math.round(r.height), fontLoaded };
})().catch((e) => {
  window.__textpng = { error: String((e && e.message) || e) };
});
`;

/** JSON that is safe inside a script element. */
function scriptJson(v: unknown): string {
  return JSON.stringify(v).replace(/</g, '\\u003c').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
}

/** The HTML page of one picture. `font` is a font file to load from its file:// URL, or null. */
export function textPage(image: TextImage, font: string | null, platform: NodeJS.Platform): string {
  const spec = { ...image, stack: fontStack(font !== null, platform), fontFace: font !== null };
  const face = font === null ? '' : `@font-face { font-family: "${FONT_FAMILY}"; src: url("${pathToFileURL(font).href}"); }\n`;
  return [
    '<!doctype html>',
    '<html><head><meta charset="utf-8"><title>caption</title>',
    '<style>',
    `${face}html, body { margin: 0; padding: 0; overflow: hidden; background: transparent; }`,
    '#image { position: absolute; left: 0; top: 0; }',
    '#image.box { background: rgba(0, 0, 0, 0.6); }',
    '#image canvas { position: absolute; left: 0; top: 0; }',
    '</style>',
    '</head><body><div id="image"></div>',
    `<script id="spec" type="application/json">${scriptJson(spec)}</script>`,
    `<script>${PAGE_SCRIPT}</script>`,
    '</body></html>',
    '',
  ].join('\n');
}

// ---- which Chrome ------------------------------------------------------------------------------

export interface ChromePath {
  /** The program to start; null for Playwright's own Chromium. */
  path: string | null;
  /** Where the path came from, for messages. */
  from: '--chrome' | 'PW_CHROMIUM_PATH' | null;
}

/** A Mac app folder (Google Chrome.app) stands for the program inside it. */
export function appProgram(p: string): string {
  if (!/\.app\/?$/.test(p)) return p;
  try {
    if (!fs.statSync(p).isDirectory()) return p;
  } catch {
    return p;
  }
  const dir = p.replace(/\/$/, '');
  return path.join(dir, 'Contents', 'MacOS', path.basename(dir, '.app'));
}

/**
 * The Chrome that draws: --chrome (already resolved from where npm was run), else the variable
 * PW_CHROMIUM_PATH (as the Playwright tests of this repository take it), else Playwright's own.
 */
export function chromePath(flag: string | undefined, env: NodeJS.ProcessEnv): ChromePath {
  if (flag !== undefined) return { path: appProgram(flag), from: '--chrome' };
  const fromEnv = env['PW_CHROMIUM_PATH'];
  if (fromEnv) return { path: appProgram(fromEnv), from: 'PW_CHROMIUM_PATH' };
  return { path: null, from: null };
}

/** The first line of an error, without colours, Playwright's "browserType.launch:" or its boxes. */
export function firstLine(e: unknown): string {
  const text = (e instanceof Error ? e.message : String(e)).replace(/\u001b\[[0-9;]*m/g, '');
  const line =
    text
      .split(/\r?\n/)
      .map((l) => l.trim())
      .find((l) => l !== '' && !/^[\u2500-\u257f]/.test(l)) ?? 'no reason given';
  const plain = line.replace(/^[A-Za-z]+\.[A-Za-z]+: /, '').replace(/\s+/g, ' ');
  return plain.length > 300 ? `${plain.slice(0, 297)}...` : plain;
}

/** One line: why Chrome did not start, and how to name it. */
export function chromeHint(chrome: ChromePath, e: unknown): string {
  const tried = chrome.path === null ? "Playwright's own Chromium" : `${chrome.from} ${chrome.path}`;
  return (
    `Chrome did not start to draw the captions (${firstLine(e)}; tried ${tried}). ` +
    `Name it with --chrome <path> or PW_CHROMIUM_PATH, on the Mac "${MAC_CHROME}".`
  );
}

/** Starts Chrome headless; a failure is a VideoError with the hint. */
export async function launchChrome(chrome: ChromePath): Promise<Browser> {
  let chromium: BrowserType;
  try {
    ({ chromium } = await import('@playwright/test'));
  } catch (e) {
    throw new VideoError(`Playwright, which starts Chrome for the captions, could not be loaded (${firstLine(e)}): npm ci in the repository installs it.`);
  }
  try {
    return await chromium.launch({ headless: true, ...(chrome.path !== null ? { executablePath: chrome.path } : {}) });
  } catch (e) {
    throw new VideoError(chromeHint(chrome, e));
  }
}

// ---- drawing -----------------------------------------------------------------------------------

export interface DrawOptions {
  /** Folder for the pages and the PNG files: the one ffmpeg runs in. */
  dir: string;
  /** Font file for @font-face; null for the system's sans-serif fonts alone. */
  font: string | null;
  chrome: ChromePath;
  platform: NodeJS.Platform;
}

export interface Drawn {
  /** What drew the pictures, for the printout: "Chrome 157.0.7000.1". */
  browser: string;
  /** Chrome could read the font file (false: a system font drew the text); null without one. */
  fontLoaded: boolean | null;
  /** Width and height of each PNG, by file name. */
  sizes: Record<string, [number, number]>;
}

interface PageResult {
  width: number;
  height: number;
  fontLoaded: boolean | null;
}

function pageResult(v: unknown, name: string): PageResult {
  const r = v !== null && typeof v === 'object' ? (v as Record<string, unknown>) : {};
  if (typeof r['error'] === 'string') throw new VideoError(`Chrome could not draw ${name}: ${r['error']}`);
  const width = r['width'];
  const height = r['height'];
  if (typeof width !== 'number' || typeof height !== 'number' || !(width >= 1) || !(height >= 1)) {
    throw new VideoError(`Chrome gave no size for ${name}`);
  }
  return { width, height, fontLoaded: typeof r['fontLoaded'] === 'boolean' ? r['fontLoaded'] : null };
}

/** <name>.html next to <name>.png. */
export function pageFile(name: string): string {
  return `${name.replace(/\.png$/i, '')}.html`;
}

/**
 * Draws every picture with one Chrome, closed again at the end: writes each page and its PNG into
 * `dir`. Errors become a VideoError of one line.
 */
export async function drawTextImages(images: readonly TextImage[], opts: DrawOptions): Promise<Drawn> {
  const browser = await launchChrome(opts.chrome);
  try {
    const context = await browser.newContext({ deviceScaleFactor: 1, viewport: { width: 640, height: 360 } });
    const page = await context.newPage();
    const sizes: Record<string, [number, number]> = {};
    let fontLoaded: boolean | null = null;
    for (const image of images) {
      const html = path.join(opts.dir, pageFile(image.name));
      fs.writeFileSync(html, textPage(image, opts.font, opts.platform), 'utf8');
      await page.goto(pathToFileURL(html).href);
      await page.waitForFunction('window.__textpng !== undefined', undefined, { timeout: PAGE_TIMEOUT_MS });
      const r = pageResult(await page.evaluate('window.__textpng'), image.name);
      if (r.fontLoaded !== null) fontLoaded = fontLoaded === false ? false : r.fontLoaded;
      // The viewport takes the picture's size: a screenshot holds only what the viewport shows.
      await page.setViewportSize({ width: r.width, height: r.height });
      const png = await page.screenshot({ type: 'png', omitBackground: true, clip: { x: 0, y: 0, width: r.width, height: r.height } });
      fs.writeFileSync(path.join(opts.dir, image.name), png);
      sizes[image.name] = [r.width, r.height];
    }
    return { browser: `${opts.chrome.path === null ? 'Chromium' : 'Chrome'} ${browser.version()}`, fontLoaded, sizes };
  } catch (e) {
    if (e instanceof VideoError) throw e;
    throw new VideoError(`Chrome could not draw the captions: ${firstLine(e)}`);
  } finally {
    await browser.close().catch(() => undefined);
  }
}
