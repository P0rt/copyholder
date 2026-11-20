// npm run take: the demo-take rule of PREREG.md section 11 on Deck's stamps.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import type { StampLine } from '../core/schemas/index.ts';
import { writeSessionFolder } from './lib/fixtures.ts';
import { ANSWER_WINDOW_SAMPLES, checkTake, clockText, main, publishedTake, takeLines, USAGE } from './take.ts';

const FS = 48_000;
const at = (s: number): number => Math.round(s * FS);
const hold = (s: number, cause: 'chest' | 'voice' | 'key' = 'chest'): StampLine => ({ n: at(s), k: 'hold', cause, nSilent: at(s) + 384, word: null, ...(cause === 'chest' ? { seq: 1 } : {}) });
const voice = (s: number, on: boolean): StampLine => ({ n: at(s), k: 'voice', on });
const chunk: StampLine = { n: 0, k: 'chunk', frames: 128 };

describe('the demo-take rule (PREREG.md section 11)', () => {
  it('takes a CHEST stop with no voice at the stop and a voice-on edge within 1.5 s of the silence', () => {
    const c = checkTake([chunk, voice(5, true), voice(6, false), hold(10), voice(10.8, true), voice(12, false)]);
    expect(c.chest).toHaveLength(1);
    expect(c.chest[0]).toMatchObject({ voiceOnAtStop: false, qualifies: true });
    expect(c.chest[0]!.voiceAfterS).toBeCloseTo(0.8 - 384 / FS, 6);
    expect(c.qualifies).toBe(true);
  });

  it('does not take a CHEST stop while the voice was on, or one the voice did not follow within the window', () => {
    const during = checkTake([chunk, voice(9.5, true), hold(10), voice(11, false)]);
    expect(during.chest[0]).toMatchObject({ voiceOnAtStop: true, qualifies: false });
    const late = checkTake([chunk, hold(10), { n: at(10) + 384 + ANSWER_WINDOW_SAMPLES, k: 'voice', on: true }]);
    expect(late.chest[0]).toMatchObject({ voiceOnAtStop: false, voiceAfterS: null, qualifies: false });
    const justIn = checkTake([chunk, hold(10), { n: at(10) + 384 + ANSWER_WINDOW_SAMPLES - 1, k: 'voice', on: true }]);
    expect(justIn.qualifies).toBe(true);
    const none = checkTake([chunk, hold(10)]);
    expect(none.qualifies).toBe(false);
  });

  it('counts VOICE stops apart and never lets them qualify a take', () => {
    const c = checkTake([chunk, voice(3, true), hold(3.25, 'voice'), voice(4, false), voice(8, true), hold(8.25, 'voice')]);
    expect(c).toMatchObject({ chest: [], voiceStops: 2, qualifies: false });
  });

  it('publishes the first take that qualifies, else the last', () => {
    const yes = checkTake([chunk, hold(10), voice(10.5, true)]);
    const no = checkTake([chunk, hold(10)]);
    expect(publishedTake(['t1', 't2', 't3'], [no, yes, yes])).toEqual({ id: 't2', why: 'take 2 of 3, the first that qualifies' });
    expect(publishedTake(['t1', 't2'], [no, no])).toEqual({ id: 't2', why: 'take 2 of 2: no take qualifies, so the last one is published' });
  });

  it('prints each CHEST stop with its time from the start of the take', () => {
    expect(clockText(65.04)).toBe('1:05.0');
    const lines = takeLines('headstart-1', checkTake([chunk, hold(65), voice(65.5, true)]));
    expect(lines[0]).toBe('take headstart-1: 1 CHEST stop(s), 0 VOICE stop(s)');
    expect(lines[1]).toMatch(/^ {2}CHEST at 1:05\.0: no voice at the stop; voice 0\.49 s after the silence: qualifies$/);
    expect(lines[2]).toMatch(/^ {2}QUALIFIES/);
  });
});

describe('npm run take on session folders', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'take-'));
  afterAll(() => fs.rmSync(root, { recursive: true, force: true }));
  const env = { COPYHOLDER_SESSIONS_DIR: root };
  const write = (id: string, kind: 'headstart' | 'smoke', stamps: StampLine[]): void => {
    const ch = new Float32Array(at(20));
    writeSessionFolder(root, { sampleRateHz: FS, ch0: ch, ch1: ch, stamps: stamps as never, samples: [], events: [], micSettings: null }, { id, kind });
  };

  it('checks each take in order and names the one the rule publishes', () => {
    write('headstart-1', 'headstart', [chunk, hold(10)]);
    write('headstart-2', 'headstart', [chunk, hold(10), voice(10.6, true), voice(12, false)]);
    const out: string[] = [];
    const err: string[] = [];
    expect(main(['headstart-1', 'headstart-2'], env, (l) => out.push(l), (l) => err.push(l))).toBe(0);
    expect(err).toEqual([]);
    expect(out).toContain('take headstart-1: 1 CHEST stop(s), 0 VOICE stop(s)');
    expect(out[out.length - 1]).toBe('published by the rule: headstart-2 (take 2 of 2, the first that qualifies)');
  });

  it('refuses a folder that is not a headstart take, and a wrong command line', () => {
    write('smoke-1', 'smoke', [chunk]);
    const err: string[] = [];
    expect(main(['smoke-1'], env, () => {}, (l) => err.push(l))).toBe(1);
    expect(err[0]).toBe('take refused: smoke-1 is a smoke record, not a headstart take');
    expect(main(['missing-1'], env, () => {}, (l) => err.push(l))).toBe(1);
    expect(err[1]).toMatch(/^take refused: missing-1: .* has no manifest\.json$/);
    expect(main([], env, () => {}, (l) => err.push(l))).toBe(2);
    expect(main(['--all'], env, () => {}, (l) => err.push(l))).toBe(2);
    expect(err.slice(2)).toEqual([USAGE, USAGE]);
  });
});
