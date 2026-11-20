// The session folder as `npm run video` reads it (spec 8.1, 15.4): click blocks, the files it
// needs, D1's armed lines and where L_rt comes from.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { clickSchedule, clickWaveform, type Stamp } from '../../core/clock/index.ts';
import type { Calib, ClockReport } from '../../core/schemas/index.ts';
import { encodeStereoFloatWav } from '../../analysis/lib/wav.ts';
import { DEMO_CLICK_STARTS_MS } from '../../web/lib/clicks.ts';
import { VideoError } from './ffmpeg.ts';
import { chooseLrt, clickGroups, clickRefs, d1At, firstDemoClick, loadVideoSession, sessionFolder, type VideoSession } from './session.ts';

const RATE = 48_000;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'video-session-test-'));
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

function clicksAt(baseS: number, offsets: readonly number[]): Stamp[] {
  return offsets.map((x, i) => ({ n: Math.round(baseS * RATE) + x, k: 'click', i }));
}
const demoOffsets = DEMO_CLICK_STARTS_MS.map((ms) => Math.round((ms * RATE) / 1000));

describe('click blocks', () => {
  const stamps: Stamp[] = [...clicksAt(10, clickSchedule()), ...clicksAt(40, demoOffsets), ...clicksAt(60, [0, 24_000, 30_000]), ...clicksAt(100, clickSchedule())];

  it('names loop checks A and B, the demo clicks and other clicks', () => {
    const g = clickGroups(stamps, RATE);
    expect(g.map((x) => [x.label, x.kind, x.ns.length])).toEqual([
      ['loop A', 'loop', 10],
      ['demo', 'demo', 3],
      ['clicks', 'other', 3],
      ['loop B', 'loop', 10],
    ]);
    expect(firstDemoClick(g)).toBe(40 * RATE + (demoOffsets[0] as number));
    const refs = clickRefs(g);
    expect(refs).toHaveLength(26);
    expect(refs[0]).toEqual({ n: 10 * RATE + (clickSchedule()[0] as number), label: 'loop A 1' });
    expect(refs[12]?.label).toBe('demo 3');
    expect(refs[25]?.label).toBe('loop B 10');
  });

  it('starts a block when the click index restarts, even without a gap', () => {
    const g = clickGroups([...clicksAt(1, [0, 30_000]), ...clicksAt(1.8, [0, 30_000])], RATE);
    expect(g.map((x) => x.ns.length)).toEqual([2, 2]);
  });
});

describe('D1 armed lines', () => {
  const events = [
    { n: 100, e: 'armed', det: 'D1', on: true },
    { n: 200, e: 'armed', det: 'D3', on: false },
    { n: 300, e: 'armed', det: 'D1', on: false },
    { n: 500, e: 'armed', det: 'D1', on: true },
  ];

  it('says whether D1 was active and when it next becomes active', () => {
    expect(d1At(events, 150)).toEqual({ active: true, nextOn: 500 });
    expect(d1At(events, 350)).toEqual({ active: false, nextOn: 500 });
    expect(d1At(events, 50)).toEqual({ active: false, nextOn: 100 });
    expect(d1At([], 50)).toBeNull();
  });
});

/** A session in memory: 13 s of audio with loop check A at 1 s, channel 0 hearing channel 1 `lagSamples` later. */
function memorySession(lagSamples: number | null, over: Partial<VideoSession> = {}): VideoSession {
  const length = 13 * RATE;
  const ch0 = new Float32Array(length);
  const ch1 = new Float32Array(length);
  const stamps: Stamp[] = [{ n: 0, k: 'chunk', frames: length }];
  if (lagSamples !== null) {
    const click = clickWaveform();
    let s = 3;
    for (let i = 0; i < length; i++) {
      s = (s * 1_103_515_245 + 12_345) % 2_147_483_648;
      ch0[i] = 1e-4 * (2 * (s / 2_147_483_648) - 1);
    }
    clickSchedule().forEach((x, i) => {
      const at = RATE + x;
      stamps.push({ n: at, k: 'click', i });
      click.forEach((v, j) => {
        ch1[at + j] = v;
        ch0[at + lagSamples + j] = (ch0[at + lagSamples + j] as number) + 0.3 * v;
      });
    });
  }
  return {
    id: 'headstart-1',
    dir: tmp,
    kind: 'headstart',
    tap: null,
    sampleRateHz: RATE,
    ch0,
    ch1,
    layout: { runs: [{ n0: 0, n1: length, index0: 0 }], contiguous: true, chunks: 1, frames: length },
    stamps,
    events: [],
    calib: null,
    clockReport: null,
    problems: [],
    ...over,
  };
}

describe('chooseLrt', () => {
  it('takes --lrt-ms first, then clock_report.json, then calib.json', () => {
    const report = { chain: { L_rt_ms: [30.2, 31.8] } } as unknown as ClockReport;
    const calib = { L_rt_ms: { A: 40, B: 42, used: null } } as unknown as Calib;
    const s = memorySession(null, { clockReport: report, calib });
    expect(chooseLrt(s, 25)).toEqual({ ms: 25, source: '--lrt-ms' });
    expect(() => chooseLrt(s, 500)).toThrow(/--lrt-ms 500: expected 0 to 200 ms/);
    expect(chooseLrt(s, null)).toEqual({ ms: 31, source: 'clock_report.json (loop checks A and B)' });
    expect(chooseLrt({ ...s, clockReport: null }, null)).toEqual({ ms: 41, source: 'calib.json' });
    const used = { L_rt_ms: { A: 40, B: 42, used: 40.5 } } as unknown as Calib;
    expect(chooseLrt({ ...s, clockReport: null, calib: used }, null).ms).toBe(40.5);
  });

  it('measures L_rt on the loop check in audio.wav when no file has it', () => {
    const lrt = chooseLrt(memorySession(1_440), null);
    expect(lrt.ms).toBeCloseTo(30, 0);
    expect(lrt.source).toBe('measured on loop check A of audio.wav');
  });

  it('refuses without any L_rt and names the latest doctor value', () => {
    expect(() => chooseLrt(memorySession(null), null, { id: 'doctor-3', ms: 33.4 })).toThrow(
      /No L_rt for headstart-1: .* Give it with --lrt-ms <ms>\. The latest doctor run, doctor-3, measured 33\.4 ms: --lrt-ms 33\.4\./,
    );
  });
});

describe('loadVideoSession', () => {
  function folder(name: string, files: Record<string, string | Buffer>): string {
    const dir = path.join(tmp, name);
    fs.mkdirSync(dir, { recursive: true });
    for (const [f, body] of Object.entries(files)) fs.writeFileSync(path.join(dir, f), body);
    return dir;
  }
  const wav = encodeStereoFloatWav(new Float32Array(2 * RATE), new Float32Array(2 * RATE));
  const stamps = [
    { n: 0, k: 'chunk', frames: RATE },
    { n: 2 * RATE, k: 'chunk', frames: RATE },
    { n: 1000, k: 'click', i: 0 },
    { n: 3000, k: 'mark', what: 'step', name: 'intro' },
  ];

  it('reads audio.wav through the chunk stamps and skips bad lines', () => {
    const dir = folder('take-a', {
      'audio.wav': wav,
      'stamps.jsonl': `${stamps.map((s) => JSON.stringify(s)).join('\n')}\n{"n":-4,"k":"click","i":0}\n`,
    });
    const s = loadVideoSession(dir);
    expect(s.id).toBe('take-a');
    expect(s.kind).toBeNull();
    expect(s.sampleRateHz).toBe(RATE);
    expect(s.layout.runs).toEqual([
      { n0: 0, n1: RATE, index0: 0 },
      { n0: 2 * RATE, n1: 3 * RATE, index0: RATE },
    ]);
    expect(s.stamps).toHaveLength(4);
    expect(s.problems).toHaveLength(1);
  });

  it('refuses a folder without audio.wav or stamps.jsonl', () => {
    expect(() => loadVideoSession(folder('no-stamps', { 'audio.wav': wav }))).toThrow(/has no stamps\.jsonl/);
    expect(() => loadVideoSession(folder('no-audio', { 'stamps.jsonl': '' }))).toThrow(/has no audio\.wav/);
    expect(() => loadVideoSession(path.join(tmp, 'missing'))).toThrow(VideoError);
  });

  it('finds a bare id in the sessions folder and a path from where npm was run', () => {
    const env = { COPYHOLDER_SESSIONS_DIR: tmp };
    expect(sessionFolder('take-a', env, '/elsewhere')).toBe(path.join(tmp, 'take-a'));
    expect(sessionFolder('./take-a', env, tmp)).toBe(path.join(tmp, 'take-a'));
    expect(sessionFolder('take-b', env, '/elsewhere')).toBe(path.join(tmp, 'take-b'));
  });
});
