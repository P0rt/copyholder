// The sync square on decoded frames (spec 15.4): found among a blinking cursor and a flickering
// patch, its onsets with hysteresis, and the frame times read from showinfo.

import { describe, expect, it } from 'vitest';
import {
  cellBoxToRect,
  checkSquare,
  findSquare,
  flashOnsets,
  frameSeconds,
  innerBox,
  regionLuma,
  ShowinfoTimes,
  type GrayFrames,
} from './flash.ts';

/** A 40 x 30 cell grid (320 x 240 px in 8 px cells), 30 fps, with `paint` deciding each cell. */
function frames(seconds: number, paint: (x: number, y: number, t: number, k: number) => number): GrayFrames {
  const w = 40;
  const h = 30;
  const count = Math.round(seconds * 30);
  const data = new Uint8Array(count * w * h);
  const times: number[] = [];
  for (let k = 0; k < count; k++) {
    const t = k / 30;
    times.push(t);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) data[k * w * h + y * w + x] = paint(x, y, t, k);
  }
  return { w, h, count, data, times };
}

const FLASHES = [0.9, 2.05, 3.33, 4.3, 5.62, 6.75, 8.11];
const flashing = (t: number): boolean => FLASHES.some((f) => t >= f && t < f + 0.1);

describe('findSquare', () => {
  // The square: cells 2-7 x 2-7 (16-64 px), white for 100 ms from each flash. A text cursor
  // blinks every 0.5 s at cell (30, 20); a video plays in cells 20-24 x 5-8, flickering every
  // two frames; page text sits still in row 12.
  const f = frames(9, (x, y, t, k) => {
    if (x >= 2 && x < 8 && y >= 2 && y < 8) return flashing(t) ? 250 : 12;
    if (x === 30 && y === 20) return Math.floor(t / 0.5) % 2 === 0 ? 240 : 20;
    if (x >= 20 && x < 25 && y >= 5 && y < 9) return k % 4 < 2 ? 230 : 30;
    if (y === 12) return 200;
    return 40;
  });

  it('finds the flashing square and nothing else', () => {
    const sq = findSquare(f);
    expect(sq).not.toBeNull();
    expect(sq?.box).toEqual({ x0: 2, y0: 2, x1: 8, y1: 8 });
    expect(sq?.cells).toBe(36);
    expect(sq?.pulses).toBe(FLASHES.length);
    expect(cellBoxToRect(sq!.box, { x: 0, y: 0, w: 320, h: 240 }, 40, 30)).toEqual({ x: 16, y: 16, w: 48, h: 48 });
  });

  it('finds no square in frames without flashes', () => {
    expect(findSquare(frames(4, (x, y, t) => (x === 30 && y === 20 && Math.floor(t / 0.5) % 2 === 0 ? 240 : 30)))).toBeNull();
  });

  it('reads the onsets inside the square', () => {
    const luma = regionLuma(f, innerBox({ x0: 2, y0: 2, x1: 8, y1: 8 }));
    const on = flashOnsets(f.times, luma);
    expect(on?.onsets).toHaveLength(FLASHES.length);
    on?.onsets.forEach((t, i) => {
      const flash = FLASHES[i] as number;
      expect(t).toBeGreaterThanOrEqual(flash - 1e-9);
      expect(t).toBeLessThan(flash + 1 / 30);
    });
    expect(on?.long).toBe(0);
  });
});

describe('flashOnsets', () => {
  const times = Array.from({ length: 60 }, (_, k) => k / 30);

  it('counts a rise through the middle after a fall, not a recording that starts bright, and leaves out long runs', () => {
    const luma = times.map((_, k) => {
      if (k < 3) return 230; // starts bright: no onset
      if (k >= 10 && k < 13) return k === 10 ? 150 : 230; // partly bright first frame counts
      if (k >= 20 && k < 52) return 230; // a window over the square for over 1 s
      return 20;
    });
    const on = flashOnsets(times, luma);
    expect(on?.onsets).toEqual([10 / 30]);
    expect(on?.long).toBe(1);
    expect(on?.low).toBe(20);
    expect(on?.high).toBe(230);
  });

  it('ignores a wobble between the thresholds', () => {
    const luma = times.map((_, k) => (k === 10 || k === 12 ? 230 : k === 11 ? 100 : 20));
    expect(flashOnsets(times, luma)?.onsets).toEqual([10 / 30]);
  });

  it('gives null when the region never turns clearly brighter', () => {
    expect(flashOnsets(times, times.map((_, k) => (k % 10 === 0 ? 70 : 20)))).toBeNull();
  });
});

describe('frame times and checks', () => {
  it('reads showinfo lines split across chunks', () => {
    const s = new ShowinfoTimes();
    s.push('[Parsed_showinfo_3 @ 0x5580b7b3b8c0] config in time_base: 1/30, frame_rate: 30/1\n[Parsed_showinfo_3 @ 0x5580b7b3b8c0] n:   0 pts:      0 pts_time:0       duration:      1 duration_time:0.0333333 fmt:gray\n');
    s.push('[Parsed_showinfo_3 @ 0x5580b7b3b8c0] n:   1 pts:    512 pts_time:0.0');
    s.push('166667 duration:    512\n[Parsed_showinfo_3 @ 0x5580b7b3b8c0] color_range:unknown\n[Parsed_showinfo_3 @ 0x1] n:   2 pts:   1536 pts_time:0.05');
    expect(s.end()).toEqual([0, 0.0166667, 0.05]);
  });

  it('takes one frame from the nominal rate, else from the frame steps', () => {
    expect(frameSeconds(60, [])).toBeCloseTo(1 / 60, 12);
    expect(frameSeconds(Number.NaN, [0, 0.02, 0.04, 0.07, 0.09])).toBeCloseTo(0.02, 12);
  });

  it('shrinks a box by its edge cells only where it is 3 cells wide', () => {
    expect(innerBox({ x0: 2, y0: 2, x1: 8, y1: 8 })).toEqual({ x0: 3, y0: 3, x1: 7, y1: 7 });
    expect(innerBox({ x0: 2, y0: 2, x1: 4, y1: 8 })).toEqual({ x0: 2, y0: 3, x1: 4, y1: 7 });
  });

  it('checks a --square region against the recording', () => {
    const info = { width: 2880, height: 1800 };
    expect(checkSquare({ x: 32, y: 32, w: 96, h: 96 }, info)).toBeNull();
    expect(checkSquare({ x: 32, y: 32, w: 2, h: 96 }, info)).toMatch(/at least 4 x 4/);
    expect(checkSquare({ x: 2850, y: 32, w: 96, h: 96 }, info)).toMatch(/runs past the 2880 x 1800 px recording/);
  });
});
