import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { CLICK_COUNT, CLICK_SAMPLES, LOOP_BLOCK_SAMPLES, SAMPLE_RATE_HZ, clickSchedule, clickWaveform } from './index.ts';

describe('clickSchedule (spec 6.3)', () => {
  const s = clickSchedule();

  it('has 10 integer sample offsets, deterministic', () => {
    expect(s).toHaveLength(CLICK_COUNT);
    expect(s.every(Number.isInteger)).toBe(true);
    expect(clickSchedule()).toEqual(s);
  });

  it('has unequal intervals, each longer than the 100 ms search plus the click', () => {
    const intervals = s.slice(1).map((v, i) => v - s[i]!);
    expect(new Set(intervals).size).toBe(intervals.length);
    expect(Math.min(...intervals)).toBeGreaterThan(0.1 * SAMPLE_RATE_HZ + CLICK_SAMPLES);
  });

  it('spans about 12 s and leaves the last search window inside the block', () => {
    expect(LOOP_BLOCK_SAMPLES).toBe(12 * SAMPLE_RATE_HZ);
    expect(s[0]!).toBeGreaterThan(0);
    expect(s[s.length - 1]! - s[0]!).toBeGreaterThan(10 * SAMPLE_RATE_HZ);
    expect(s[s.length - 1]! + CLICK_SAMPLES + 0.1 * SAMPLE_RATE_HZ).toBeLessThan(LOOP_BLOCK_SAMPLES);
  });
});

describe('clickWaveform', () => {
  const c = clickWaveform();
  const energy = c.reduce((a, v) => a + v * v, 0);
  const autocorr = (lag: number): number => {
    let s = 0;
    for (let i = 0; i + lag < c.length; i++) s += c[i]! * c[i + lag]!;
    return s / energy;
  };

  it('is a 5 ms click with peak <= 0.5 and no DC', () => {
    expect(c).toHaveLength(CLICK_SAMPLES);
    expect(Math.max(...Array.from(c, Math.abs))).toBeLessThanOrEqual(0.5);
    expect(Math.abs(c.reduce((a, v) => a + v, 0) / c.length)).toBeLessThan(1e-3);
    expect(clickWaveform(0.25)[100]!).toBeCloseTo(c[100]! / 2, 6);
  });

  it('correlates sharply: below 0.4 of the peak from 0.17 ms on', () => {
    for (let lag = 8; lag < c.length; lag++) expect(Math.abs(autocorr(lag))).toBeLessThan(0.4);
  });

  it('keeps its energy between 0.7 and 9 kHz', () => {
    let inBand = 0;
    let total = 0;
    for (let f = 0; f <= SAMPLE_RATE_HZ / 2; f += 100) {
      let re = 0;
      let im = 0;
      for (let i = 0; i < c.length; i++) {
        const p = (-2 * Math.PI * f * i) / SAMPLE_RATE_HZ;
        re += c[i]! * Math.cos(p);
        im += c[i]! * Math.sin(p);
      }
      total += re * re + im * im;
      if (f >= 700 && f <= 9000) inBand += re * re + im * im;
    }
    expect(inBand / total).toBeGreaterThan(0.99);
  });

  it('is safe in an AudioWorklet: no Node APIs, imports only ./constants.ts', () => {
    for (const file of ['clicks.ts', 'constants.ts']) {
      const src = readFileSync(join(import.meta.dirname, file), 'utf8');
      const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
      const imports = [...code.matchAll(/^import\s.*?from\s+'([^']+)'/gm)].map((m) => m[1]);
      expect(imports.every((p) => p === './constants.ts')).toBe(true);
      expect(code).not.toMatch(/\b(require|process|Buffer|globalThis|window|document|self)\b/);
      expect(code).not.toMatch(/node:/);
    }
  });
});
