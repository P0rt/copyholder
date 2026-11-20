// Flashes against clicks (spec 15.4): the offset from flash onsets on a frame grid, a missing or
// extra flash, and the refusals (late flash, too few flashes, one loop check alone).

import { describe, expect, it } from 'vitest';
import { clickSchedule } from '../../core/clock/index.ts';
import { DEMO_CLICK_STARTS_MS } from '../../web/lib/clicks.ts';
import { matchFlashes, type ClickRef } from './match.ts';

const RATE = 48_000;

/** Loop check A at 10 s, the demo clicks at 40 s and loop check B at 100 s (session time). */
function takeClicks(): ClickRef[] {
  const loop = (base: number, label: string): ClickRef[] => clickSchedule().map((x, i) => ({ n: base * RATE + x, label: `${label} ${i + 1}` }));
  const demo = DEMO_CLICK_STARTS_MS.map((ms, i) => ({ n: Math.round((40 + ms / 1000) * RATE), label: `demo ${i + 1}` }));
  return [...loop(10, 'loop A'), ...demo, ...loop(100, 'loop B')];
}

/** The first frame at or after each click's place in the recording: what a screen recording shows. */
function onsetsFor(clicks: readonly ClickRef[], offsetS: number, fps: number, phaseS = 0): number[] {
  return clicks.map((c) => {
    const t = c.n / RATE + offsetS;
    return Math.ceil((t - phaseS) * fps - 1e-9) / fps + phaseS;
  });
}

describe('matchFlashes', () => {
  const clicks = takeClicks();
  const offset = 7.3217;

  it('recovers the offset within one frame at 60 and 30 fps', () => {
    for (const fps of [60, 30]) {
      const onsets = onsetsFor(clicks, offset, fps, 0.004);
      const r = matchFlashes(onsets, clicks, { sampleRateHz: RATE, frameS: 1 / fps, span: [0, 130] });
      expect(r.ok).toBe(true);
      if (!r.ok) continue;
      expect(Math.abs(r.result.offsetS - offset)).toBeLessThan(1 / fps);
      expect(r.result.pairs).toHaveLength(clicks.length);
      expect(r.result.missed).toHaveLength(0);
      expect(r.result.extra).toHaveLength(0);
      expect(r.result.spreadS).toBeLessThanOrEqual(1 / fps + 1e-9);
      for (const p of r.result.pairs) expect(Math.abs(p.residualS)).toBeLessThan(1 / fps);
    }
  });

  it('matches with one flash missing and names the click without one', () => {
    const onsets = onsetsFor(clicks, offset, 60);
    onsets.splice(11, 1); // demo 2
    const r = matchFlashes(onsets, clicks, { sampleRateHz: RATE, frameS: 1 / 60, span: [0, 130] });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(Math.abs(r.result.offsetS - offset)).toBeLessThan(1 / 60);
    expect(r.result.missed.map((c) => c.label)).toEqual(['demo 2']);
    expect(r.result.pairs).toHaveLength(clicks.length - 1);
  });

  it('matches with one extra flash and lists it', () => {
    const onsets = [...onsetsFor(clicks, offset, 60), 63.5];
    const r = matchFlashes(onsets, clicks, { sampleRateHz: RATE, frameS: 1 / 60, span: [0, 130] });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.result.extra).toEqual([63.5]);
    expect(Math.abs(r.result.offsetS - offset)).toBeLessThan(1 / 60);
  });

  it('matches a recording that stops after the demo clicks', () => {
    const shown = clicks.slice(0, 13);
    const onsets = onsetsFor(shown, offset, 60);
    const r = matchFlashes(onsets, clicks, { sampleRateHz: RATE, frameS: 1 / 60, span: [0, 60] });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.result.pairs).toHaveLength(13);
    expect(r.result.outside).toBe(10);
    expect(Math.abs(r.result.offsetS - offset)).toBeLessThan(1 / 60);
  });

  it('refuses a flash more than 2 frames late', () => {
    const onsets = onsetsFor(clicks, offset, 60);
    onsets[5] = (onsets[5] as number) + 0.12;
    const r = matchFlashes(onsets, clicks, { sampleRateHz: RATE, frameS: 1 / 60, span: [0, 130] });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.why).toMatch(/residuals spread over 1\d\d\.\d ms, more than 2 frames \(33\.3 ms\)/);
    expect(r.result?.pairs.find((p) => p.click.label === 'loop A 6')?.residualS).toBeGreaterThan(0.1);
  });

  it('takes a larger spread when it is allowed', () => {
    const onsets = onsetsFor(clicks, offset, 60);
    onsets[5] = (onsets[5] as number) + 0.06;
    expect(matchFlashes(onsets, clicks, { sampleRateHz: RATE, frameS: 1 / 60, span: [0, 130] }).ok).toBe(false);
    expect(matchFlashes(onsets, clicks, { sampleRateHz: RATE, frameS: 1 / 60, span: [0, 130], maxSpreadFrames: 6 }).ok).toBe(true);
  });

  it('refuses flashes that do not follow the clicks', () => {
    const onsets = [3.1, 4.9, 9.2, 15.15, 22.7, 23.05, 31.4];
    const r = matchFlashes(onsets, clicks, { sampleRateHz: RATE, frameS: 1 / 60, span: [0, 40] });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.why).toMatch(/only \d of 23 clicks line up with a flash/);
  });

  it('refuses a recording with only one loop check and nothing else', () => {
    const onlyB = clicks.slice(13);
    const onsets = onsetsFor(onlyB, offset, 60);
    const r = matchFlashes(onsets, clicks, { sampleRateHz: RATE, frameS: 1 / 60, span: [105, 122] });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.why).toMatch(/fit the clicks at two offsets/);
  });

  it('refuses without flashes or clicks', () => {
    expect(matchFlashes([], takeClicks(), { sampleRateHz: RATE, frameS: 1 / 60, span: [0, 10] })).toMatchObject({ ok: false, why: 'no flashes were found in the recording' });
    expect(matchFlashes([1, 2, 3], [], { sampleRateHz: RATE, frameS: 1 / 60, span: [0, 10] })).toMatchObject({ ok: false, why: 'stamps.jsonl has no click stamps' });
  });
});
