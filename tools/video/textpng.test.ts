// Captions and title cards as PNG pictures drawn by Chrome (spec 15.2-15.4): the pages, which
// Chrome starts and the one-line hint when none does, and the pictures themselves, read back pixel
// by pixel: a caption on drawtext's box (black at 60 %, the padding all box), a card frame that is
// transparent around its lines, each line inside its own band and centred. The drawing tests are
// skipped where no Chrome or Chromium starts.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { afterAll, describe, expect, it } from 'vitest';
import { cardLines } from './cards.ts';
import { findFontOrNone, VideoError } from './ffmpeg.ts';
import {
  appProgram,
  chromeHint,
  chromePath,
  drawTextImages,
  firstLine,
  fontStack,
  launchChrome,
  MAC_CHROME,
  pageFile,
  textPage,
  type CaptionImage,
  type CardImage,
} from './textpng.ts';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'video-textpng-test-'));
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

/** A Chrome starts as npm run video starts it: PW_CHROMIUM_PATH, else Playwright's own Chromium. */
const CHROME = chromePath(undefined, process.env);
const HAVE_CHROMIUM = await (async (): Promise<boolean> => {
  try {
    await (await launchChrome(CHROME)).close();
    return true;
  } catch {
    return false;
  }
})();
const FONT = findFontOrNone(undefined, process.platform);

function folder(name: string): string {
  const dir = path.join(tmp, name);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

interface Picture {
  width: number;
  height: number;
  /** RGBA, row after row. */
  data: Uint8Array;
}

/** An 8-bit RGB or RGBA PNG without interlacing, as Chrome's screenshots are. */
function readPng(file: string): Picture {
  const buf = fs.readFileSync(file);
  expect([...buf.subarray(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  let width = 0;
  let height = 0;
  let channels = 0;
  const idat: Buffer[] = [];
  for (let pos = 8; pos + 8 <= buf.length; ) {
    const len = buf.readUInt32BE(pos);
    const type = buf.toString('latin1', pos + 4, pos + 8);
    const body = buf.subarray(pos + 8, pos + 8 + len);
    if (type === 'IHDR') {
      width = body.readUInt32BE(0);
      height = body.readUInt32BE(4);
      const [depth, colour, , , interlace] = [...body.subarray(8, 13)];
      if (depth !== 8 || interlace !== 0 || (colour !== 6 && colour !== 2)) {
        throw new Error(`PNG not read here: depth ${depth}, colour type ${colour}, interlace ${interlace}`);
      }
      channels = colour === 6 ? 4 : 3;
    } else if (type === 'IDAT') idat.push(body);
    else if (type === 'IEND') break;
    pos += 12 + len;
  }
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const data = new Uint8Array(width * height * 4);
  let prev = new Uint8Array(stride);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)] as number;
    const row = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    const cur = new Uint8Array(stride);
    for (let i = 0; i < stride; i++) {
      const a = i >= channels ? (cur[i - channels] as number) : 0;
      const b = prev[i] as number;
      const c = i >= channels ? (prev[i - channels] as number) : 0;
      const p = a + b - c;
      const paeth = Math.abs(p - a) <= Math.abs(p - b) && Math.abs(p - a) <= Math.abs(p - c) ? a : Math.abs(p - b) <= Math.abs(p - c) ? b : c;
      const add = [0, a, b, (a + b) >> 1, paeth][filter];
      if (add === undefined) throw new Error(`PNG filter ${filter}`);
      cur[i] = ((row[i] as number) + add) & 0xff;
    }
    for (let x = 0; x < width; x++) {
      for (let k = 0; k < 4; k++) data[(y * width + x) * 4 + k] = k < channels ? (cur[x * channels + k] as number) : 255;
    }
    prev = cur;
  }
  return { width, height, data };
}

function rgba(p: Picture, x: number, y: number): [number, number, number, number] {
  const i = (y * p.width + x) * 4;
  return [p.data[i] as number, p.data[i + 1] as number, p.data[i + 2] as number, p.data[i + 3] as number];
}

/** White and opaque: the inside of a letter. */
function ink(p: Picture, x: number, y: number): boolean {
  const [r, g, b, a] = rgba(p, x, y);
  return a === 255 && r >= 240 && g >= 240 && b >= 240;
}

/** The ink of a picture inside rows [y0, y1): its bounds, or null when there is none. */
function inkBounds(p: Picture, y0 = 0, y1 = p.height): { x0: number; x1: number; y0: number; y1: number; n: number } | null {
  let b: { x0: number; x1: number; y0: number; y1: number; n: number } | null = null;
  for (let y = y0; y < y1; y++) {
    for (let x = 0; x < p.width; x++) {
      if (!ink(p, x, y)) continue;
      b ??= { x0: x, x1: x, y0: y, y1: y, n: 0 };
      b.x0 = Math.min(b.x0, x);
      b.x1 = Math.max(b.x1, x);
      b.y0 = Math.min(b.y0, y);
      b.y1 = Math.max(b.y1, y);
      b.n++;
    }
  }
  return b;
}

const caption: CaptionImage = { kind: 'caption', name: 'take.png', text: 'Take 1 of 2', size: 40, pad: 12 };

describe('the pages', () => {
  it('ask for the font file first, then the fonts findFont looks for, then any sans-serif font', () => {
    expect(fontStack(true, 'darwin')).toBe('"CopyholderCaption", Helvetica, Arial, "DejaVu Sans", "Liberation Sans", FreeSans, sans-serif');
    expect(fontStack(false, 'linux')).toBe('"DejaVu Sans", "Liberation Sans", FreeSans, Helvetica, Arial, sans-serif');
  });

  it('load the font file from its file URL and carry the text as JSON that cannot end its script early', () => {
    const text = 'Take </script><b>1</b> of "2" \u2028 & more';
    const image: CaptionImage = { ...caption, text };
    const spec = (page: string): unknown => JSON.parse(/<script id="spec" type="application\/json">(.*)<\/script>/.exec(page)?.[1] as string);
    const page = textPage(image, '/Library/My Fonts/Sans #1.ttf', 'darwin');
    expect(page).toContain('@font-face { font-family: "CopyholderCaption"; src: url("file:///Library/My%20Fonts/Sans%20%231.ttf"); }');
    expect(page).toContain('#image.box { background: rgba(0, 0, 0, 0.6); }');
    // Two script elements end: the text closed neither.
    expect(page.split('</script>')).toHaveLength(3);
    expect(page).not.toMatch(/[\u2028\u2029]/);
    expect(spec(page)).toEqual({ ...image, stack: fontStack(true, 'darwin'), fontFace: true });
    const plain = textPage(image, null, 'linux');
    expect(plain).not.toContain('@font-face');
    expect(spec(plain)).toEqual({ ...image, stack: fontStack(false, 'linux'), fontFace: false });
  });

  it('are written next to their pictures', () => {
    expect(pageFile('take.png')).toBe('take.html');
    expect(pageFile('card12.PNG')).toBe('card12.html');
  });
});

describe('which Chrome', () => {
  it("takes --chrome, else PW_CHROMIUM_PATH, else Playwright's own Chromium", () => {
    expect(chromePath('/opt/chrome', { PW_CHROMIUM_PATH: '/usr/bin/chromium' })).toEqual({ path: '/opt/chrome', from: '--chrome' });
    expect(chromePath(undefined, { PW_CHROMIUM_PATH: '/usr/bin/chromium' })).toEqual({ path: '/usr/bin/chromium', from: 'PW_CHROMIUM_PATH' });
    expect(chromePath(undefined, { PW_CHROMIUM_PATH: '' })).toEqual({ path: null, from: null });
    expect(chromePath(undefined, {})).toEqual({ path: null, from: null });
  });

  it('takes a Mac app folder as the program inside it', () => {
    const app = path.join(folder('apps'), 'Google Chrome.app');
    fs.mkdirSync(app, { recursive: true });
    const program = path.join(app, 'Contents', 'MacOS', 'Google Chrome');
    expect(appProgram(app)).toBe(program);
    expect(appProgram(`${app}/`)).toBe(program);
    expect(chromePath(app, {})).toEqual({ path: program, from: '--chrome' });
    expect(chromePath(undefined, { PW_CHROMIUM_PATH: app })).toEqual({ path: program, from: 'PW_CHROMIUM_PATH' });
    // No such folder, or the program itself: the path as given.
    expect(appProgram(path.join(tmp, 'Missing.app'))).toBe(path.join(tmp, 'Missing.app'));
    expect(appProgram(MAC_CHROME)).toBe(MAC_CHROME);
  });

  it('says in one line why Chrome did not start and how to name it', () => {
    const playwright = new Error(
      "browserType.launch: \u001b[31mExecutable doesn't exist at /no/such/chrome\u001b[39m\n" +
        '\u2554\u2550\u2550\u2557\n\u2551 Looks like Playwright was just installed or updated. \u2551\n\u255a\u2550\u2550\u255d',
    );
    expect(firstLine(playwright)).toBe("Executable doesn't exist at /no/such/chrome");
    expect(firstLine('\n\n  spawn   ENOENT \n')).toBe('spawn ENOENT');
    expect(firstLine('')).toBe('no reason given');
    const long = firstLine(new Error('x'.repeat(400)));
    expect(long).toHaveLength(300);
    expect(long.endsWith('...')).toBe(true);
    expect(chromeHint({ path: '/no/such/chrome', from: '--chrome' }, playwright)).toBe(
      "Chrome did not start to draw the captions (Executable doesn't exist at /no/such/chrome; tried --chrome /no/such/chrome). " +
        `Name it with --chrome <path> or PW_CHROMIUM_PATH, on the Mac "${MAC_CHROME}".`,
    );
    expect(chromeHint({ path: '/c', from: 'PW_CHROMIUM_PATH' }, 'gone')).toContain('(gone; tried PW_CHROMIUM_PATH /c)');
    expect(chromeHint({ path: null, from: null }, new Error('no browser'))).toContain("(no browser; tried Playwright's own Chromium)");
  });

  it('refuses with that hint when the browser does not start, before any page is written', async () => {
    const dir = folder('no-chrome');
    const missing = path.join(tmp, 'no-such-chrome');
    const e = await drawTextImages([caption], { dir, font: null, chrome: chromePath(missing, {}), platform: process.platform }).catch((err: unknown) => err);
    expect(e).toBeInstanceOf(VideoError);
    const message = (e as VideoError).message;
    expect(message).not.toContain('\n');
    expect(message.startsWith('Chrome did not start to draw the captions (')).toBe(true);
    expect(message.endsWith(`; tried --chrome ${missing}). Name it with --chrome <path> or PW_CHROMIUM_PATH, on the Mac "${MAC_CHROME}".`)).toBe(true);
    expect(fs.readdirSync(dir)).toEqual([]);
  });
});

describe.skipIf(!HAVE_CHROMIUM)('drawn by Chrome', () => {
  const W = 640;
  const H = 360;
  const lines = cardLines({ lines: ['First card', '', 'third line'], seconds: 1 }, W, H);
  const card: CardImage = { kind: 'card', name: 'card1.png', width: W, height: H, lines: lines.map(({ text, size, top }) => ({ text, size, top })) };

  it("draws a caption on drawtext's box and a card frame transparent around its lines, with one browser", async () => {
    const dir = folder('drawn');
    const drawn = await drawTextImages([caption, card], { dir, font: FONT, chrome: CHROME, platform: process.platform });
    expect(drawn.browser).toMatch(/^(Chrome|Chromium) \d+\.\d+/);
    // Chrome may not read a font collection (.ttc): a system font then draws, and the run says so.
    if (FONT === null) expect(drawn.fontLoaded).toBeNull();
    else if (/\.ttc$/i.test(FONT)) expect(typeof drawn.fontLoaded).toBe('boolean');
    else expect(drawn.fontLoaded).toBe(true);
    expect(fs.readdirSync(dir).sort()).toEqual(['card1.html', 'card1.png', 'take.html', 'take.png']);

    // The caption: as tall as its ink and as wide as its advance, pad px of box around them.
    const take = readPng(path.join(dir, 'take.png'));
    expect(drawn.sizes['take.png']).toEqual([take.width, take.height]);
    const { size, pad } = caption;
    expect(take.height - 2 * pad).toBeGreaterThan(0.6 * size);
    expect(take.height - 2 * pad).toBeLessThan(1.1 * size);
    expect(take.width - 2 * pad).toBeGreaterThan(0.35 * size * caption.text.length);
    expect(take.width - 2 * pad).toBeLessThan(0.75 * size * caption.text.length);
    // The padding is all box, but for the smoothed edge of a letter whose ink starts a hair left of
    // its origin (DejaVu's T): drawtext lays its box out from the same origin.
    let notBox = 0;
    let boxInside = 0;
    for (let y = 0; y < take.height; y++) {
      for (let x = 0; x < take.width; x++) {
        const [r, g, b, a] = rgba(take, x, y);
        const box = r === 0 && g === 0 && b === 0 && Math.abs(a - 153) <= 1;
        const inside = y >= pad && y < take.height - pad && x >= pad && x < take.width - pad;
        const edge = y >= pad - 1 && y < take.height - pad + 1 && x >= pad - 1 && x < take.width - pad + 1;
        if (!edge && !box) notBox++;
        if (inside && box) boxInside++;
      }
    }
    expect(notBox).toBe(0);
    expect(boxInside).toBeGreaterThan(0);
    const text = inkBounds(take);
    expect(text).not.toBeNull();
    expect(text!.n).toBeGreaterThan(0.05 * (take.width - 2 * pad) * (take.height - 2 * pad));
    expect(text!.x0).toBeGreaterThanOrEqual(pad);
    expect(text!.y0).toBeGreaterThanOrEqual(pad);
    expect(text!.x1).toBeLessThan(take.width - pad);
    expect(text!.y1).toBeLessThan(take.height - pad);

    // The card: the whole frame, transparent but for white lines inside their bands, centred.
    const frame = readPng(path.join(dir, 'card1.png'));
    expect([frame.width, frame.height]).toEqual([W, H]);
    expect(drawn.sizes['card1.png']).toEqual([W, H]);
    for (const [x, y] of [[0, 0], [W - 1, 0], [0, H - 1], [W - 1, H - 1], [W / 2, H / 2]] as const) expect(rgba(frame, x, y)[3]).toBe(0);
    const lineH = Math.round(1.35 * (lines[0]?.size as number));
    const band = (y: number): number => lines.findIndex((l) => y >= l.top && y < l.top + lineH);
    let outside = 0;
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) if (rgba(frame, x, y)[3] > 0 && band(y) < 0) outside++;
    }
    expect(outside).toBe(0);
    expect(lines.map((l) => l.index)).toEqual([0, 2]);
    for (const l of lines) {
      const b = inkBounds(frame, l.top, l.top + lineH);
      expect(b, l.text).not.toBeNull();
      expect(Math.abs((b!.x0 + b!.x1) / 2 - W / 2)).toBeLessThanOrEqual(0.1 * l.size + 2);
      // drawtext's y with y_align=font is the top of the ascent: capitals start a little below it,
      // and the baseline (neither line has a descender) is one ascent down.
      expect(b!.y0 - l.top).toBeLessThan(0.4 * l.size);
      expect(b!.y1 - l.top).toBeGreaterThan(0.6 * l.size);
      expect(b!.y1 - l.top).toBeLessThanOrEqual(l.size);
    }
  });

  it('draws with a font of the system when there is no font file, or one Chrome cannot read', async () => {
    const dir = folder('system-font');
    const bogus = path.join(dir, 'not a font.ttf');
    fs.writeFileSync(bogus, 'not a font at all');
    const unread = await drawTextImages([caption], { dir, font: bogus, chrome: CHROME, platform: process.platform });
    expect(unread.fontLoaded).toBe(false);
    expect(inkBounds(readPng(path.join(dir, 'take.png')))?.n ?? 0).toBeGreaterThan(100);
    const none = await drawTextImages([{ ...caption, name: 'plain.png' }], { dir, font: null, chrome: CHROME, platform: process.platform });
    expect(none.fontLoaded).toBeNull();
    expect(inkBounds(readPng(path.join(dir, 'plain.png')))?.n ?? 0).toBeGreaterThan(100);
  });

  it('refuses a picture Chrome gives no size for', async () => {
    const empty: CardImage = { kind: 'card', name: 'card0.png', width: 0, height: 0, lines: [] };
    const e = await drawTextImages([empty], { dir: folder('no-size'), font: null, chrome: CHROME, platform: process.platform }).catch((err: unknown) => err);
    expect(e).toBeInstanceOf(VideoError);
    expect((e as VideoError).message).toBe('Chrome gave no size for card0.png');
  });
});
