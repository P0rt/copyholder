// The replay figure on a table made by hand: one circle per valid objection in each row, the
// "no stop" column, the lips row without the cues whose lips stop the readings of the packets
// with g null leave open (table.ts lips_why), and the PNG drawn by headless Chrome at 2x (only
// where a Chrome starts, as in the tools/video tests).

import { describe, expect, it } from 'vitest';
import { chromePath, launchChrome } from '../../tools/video/textpng.ts';
import { FIGURE_WIDTH, PNG_SCALE, figureData, figurePng, figureSvg, wrap } from './figure.ts';
import type { CueRow, ReplayTable, StopCell } from './table.ts';

/** A Chrome starts as npm run replay starts it: PW_CHROMIUM_PATH, else Playwright's own Chromium. */
const HAVE_CHROMIUM = await (async (): Promise<boolean> => {
  try {
    await (await launchChrome(chromePath(undefined, process.env))).close();
    return true;
  } catch {
    return false;
  }
})();

function stop(leadMs: number | null): StopCell {
  return { stop_ms: leadMs === null ? null : 20_000 - leadMs, lead_ms: leadMs, before_voice: leadMs !== null && leadMs > 0 };
}

const OPEN = 'the readings of the packets with g null place this stop differently';

/** lips 'open': the readings of the packets with g null place the lips stop differently. */
function row(id: string, pack: 'A' | 'B' | 'C', cue: number, chest: number | null, lips: number | null | 'open', valid = true): CueRow {
  return {
    pack,
    id,
    cue,
    cue_ms: 18_000,
    valid,
    why_not: valid ? null : 'no reply',
    voice_onset_ms: valid ? 20_000 : null,
    manual_onset_ms: valid ? 20_004 : null,
    manual_mark: valid ? true : null,
    chest: valid ? stop(chest) : null,
    lips: valid && lips !== 'open' ? stop(lips) : null,
    lips_why: valid && lips === 'open' ? OPEN : null,
    result: valid ? (chest !== null && chest > 0 ? 'hit' : 'miss') : null,
    armed: valid ? true : null,
    audible_inbreath: valid ? chest !== null : null,
    false_stops: { chest: 0, lips: lips === 'open' ? null : 0 },
  };
}

/** openB: the lips stops of gate-b cues 1 and 3 are left open by the readings of G. */
function table(openB: boolean): ReplayTable {
  const rows = [
    row('gate-a', 'A', 1, 310.2, 95),
    row('gate-a', 'A', 2, 1499, null),
    row('gate-a', 'A', 3, null, null),
    row('gate-a', 'A', 4, -420, 12.5, true),
    row('gate-a', 'A', 5, null, null, false),
    row('gate-b', 'B', 1, 0, openB ? 'open' : -499.9),
    row('gate-b', 'B', 2, 288, 288),
    row('gate-b', 'B', 3, 291, openB ? 'open' : null),
  ];
  const set = (id: string, pack: 'A' | 'B'): ReplayTable['sets'][number] => {
    const own = rows.filter((r) => r.id === id);
    const open = own.filter((r) => r.valid && r.lips === null).map((r) => r.cue);
    return {
      id,
      pack,
      set: `data/${id}/`,
      cues: own.length,
      valid: own.filter((r) => r.valid).length,
      false_stops_before_first_cue: { chest: 0, lips: open.length > 0 ? null : 0 },
      g_resets: open.length > 0 ? 'both readings: every packet with g null a reset frame, and none' : 'no packet with g null',
      lips_unknown: open,
    };
  };
  return { schema: 'replay-table/2', times: '', lead: '', sets: [set('gate-a', 'A'), set('gate-b', 'B')], rows };
}

describe('the replay figure', () => {
  it('puts every valid objection in each row, misses in the no-stop column, at t_s - t_v', () => {
    const d = figureData(table(false));
    expect(d.title).toBe('Stops around the voice onset, gate packs A and B');
    expect(d.rows.map((r) => r.label)).toEqual(['chest D1 (n = 7)', 'lips G (n = 7)']);
    // Stage B's lead turned around: a stop 310.2 ms before the voice sits at -310.2.
    expect(d.rows[0]!.points.map((p) => p.offsetMs)).toEqual([-310.2, -1499, null, 420, 0, -288, -291]);
    expect(d.rows[1]!.points.map((p) => p.offsetMs)).toEqual([-95, null, null, -12.5, 499.9, -288, null]);
    expect(d.rows[0]!.points[0]!.tip).toBe('data/gate-a/ cue 1: t_s - t_v = -310.2 ms');
    expect(d.rows[0]!.points[2]!.tip).toBe('data/gate-a/ cue 3: no stop');
    expect(d.footnote).toEqual(['recomputed from data/gate-a/ and data/gate-b/ by npm run replay']);

    const { svg, width, height } = figureSvg(d);
    expect(width).toBe(FIGURE_WIDTH);
    expect(svg.startsWith(`<svg xmlns="http://www.w3.org/2000/svg" width="600" height="${height}"`)).toBe(true);
    expect(svg.match(/<circle /g)).toHaveLength(14);
    expect(svg.match(new RegExp('fill="#2a78d6"', 'g'))).toHaveLength(7);
    expect(svg.match(new RegExp('fill="#eb6834"', 'g'))).toHaveLength(7);
    for (const label of ['chest D1 (n = 7)', 'lips G (n = 7)', '>no stop<', '>-1500<', '>-1000<', '>-500<', '>0<', '>+500<']) expect(svg).toContain(label);
    // Every dot on the axis lies between -1500 and +500 ms; the misses lie right of it.
    const xs = [...svg.matchAll(/<circle cx="([\d.]+)"/g)].map((m) => Number(m[1]));
    const axis = [...svg.matchAll(/<line x1="([\d.]+)" y1="\d+" x2="[\d.]+" y2="\d+" stroke="[^"]+" stroke-width="1"\/>\n<text x="[\d.]+" y="\d+" font-size="11" fill="#5f5e58" text-anchor="middle">([-+\d]+)</g)].map(
      (m) => [Number(m[2]), Number(m[1])] as const,
    );
    expect(axis.map(([t]) => t)).toEqual([-1500, -1000, -500, 0, 500]);
    const left = axis[0]![1];
    const right = axis[4]![1];
    expect(xs.filter((x) => x > right)).toHaveLength(4);
    expect(xs.filter((x) => x <= right).every((x) => x >= left - 0.05)).toBe(true);
  });

  it('leaves out a lips stop the readings of G leave open, names its cues, and keeps every chest stop', () => {
    const d = figureData(table(true));
    expect(d.rows.map((r) => r.label)).toEqual(['chest D1 (n = 7)', 'lips G (n = 5)']);
    expect(d.rows[0]!.points.map((p) => p.offsetMs)).toEqual([-310.2, -1499, null, 420, 0, -288, -291]);
    // gate-b cue 2 stays: both readings place its lips stop alike.
    expect(d.rows[1]!.points.map((p) => p.tip)).toEqual([
      'data/gate-a/ cue 1: t_s - t_v = -95 ms',
      'data/gate-a/ cue 2: no stop',
      'data/gate-a/ cue 3: no stop',
      'data/gate-a/ cue 4: t_s - t_v = -12.5 ms',
      'data/gate-b/ cue 2: t_s - t_v = -288 ms',
    ]);
    expect(d.footnote[1]).toBe(
      'the lips row leaves out data/gate-b/ cues 1 and 3: stream.jsonl does not say which packets with g null were reset frames of G, and the two readings, every one or none, place the lips stop differently',
    );
    const { svg } = figureSvg(d);
    expect(svg.match(/<circle /g)).toHaveLength(12);
    // The long footnote is wrapped to the width of the figure.
    expect(svg.match(/<text x="16" y="\d+" font-size="10.5"/g)!.length).toBeGreaterThan(2);
  });

  it('keeps a tall stack of equal times within its row', () => {
    const rows = Array.from({ length: 42 }, (_, i) => row('gate-a', 'A', i + 1, 300 + (i % 3), 100));
    const t: ReplayTable = { ...table(false), sets: [table(false).sets[0]!], rows };
    const { svg, height } = figureSvg(figureData(t));
    expect(svg.match(/<circle /g)).toHaveLength(84);
    expect(height).toBeLessThan(500);
  });

  it('wraps text at spaces', () => {
    expect(wrap('aa bb cc dd', 5)).toEqual(['aa bb', 'cc dd']);
    expect(wrap('a-very-long-word x', 5)).toEqual(['a-very-long-word', 'x']);
  });

  it.skipIf(!HAVE_CHROMIUM)('draws the PNG 1200 px wide with headless Chrome', async () => {
    const svg = figureSvg(figureData(table(false)));
    const png = await figurePng(svg, chromePath(undefined, process.env));
    expect(png.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a');
    // IHDR: width and height, big-endian, at bytes 16 and 20.
    expect(png.readUInt32BE(16)).toBe(FIGURE_WIDTH * PNG_SCALE);
    expect(png.readUInt32BE(16)).toBe(1200);
    expect(png.readUInt32BE(20)).toBe(svg.height * PNG_SCALE);
  });
});
