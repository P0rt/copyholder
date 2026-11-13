import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { validateTimings } from '../../core/schemas/index.ts';
import {
  TIME_RULE,
  frameLevelsDb,
  makeTimingsSet,
  parseTimings,
  parseTimingsSet,
  soundProblems,
  stripBom,
  timingsForClip,
  timingsProblems,
  timingsSetJson,
  timingsSetProblems,
  timingsTextProblems,
  wavFloatSamples,
  wavInfo,
  wavTimingsProblems,
  type Timings,
} from './timings.ts';

const DIR = import.meta.dirname;
const fixture = (): Timings => parseTimings(JSON.parse(readFileSync(join(DIR, 'fixtures/selftest.timings.json'), 'utf8')));
const sound = JSON.parse(readFileSync(join(DIR, 'fixtures/selftest.sound.json'), 'utf8')) as { frameMs: number; levelsDb: number[] };
const HASH = 'ab'.repeat(32);

function make(words: [number, number, number][], durationMs = 2000): Timings {
  const t = fixture();
  return {
    ...t,
    durationSamples: durationMs * 48,
    durationMs,
    wordCount: words.length,
    sentenceCount: words.length ? words[words.length - 1]![2] + 1 : 0,
    words: words.map(([startMs, endMs, sentenceIndex], index) => ({ index, startMs, endMs, sentenceIndex })),
  };
}

/** Mono WAV bytes: IEEE float 32-bit, or 16-bit PCM. */
function wav(samples: number[], opts: { rate?: number; channels?: number; pcm16?: boolean } = {}): Uint8Array {
  const rate = opts.rate ?? 48000;
  const channels = opts.channels ?? 1;
  const width = opts.pcm16 ? 2 : 4;
  const data = new Uint8Array(samples.length * width);
  const dv = new DataView(data.buffer);
  samples.forEach((s, i) => (opts.pcm16 ? dv.setInt16(2 * i, Math.round(s * 32767), true) : dv.setFloat32(4 * i, s, true)));
  const out = new Uint8Array(44 + data.length);
  const v = new DataView(out.buffer);
  const put = (at: number, s: string): void => [...s].forEach((c, i) => v.setUint8(at + i, c.charCodeAt(0)));
  put(0, 'RIFF');
  v.setUint32(4, 36 + data.length, true);
  put(8, 'WAVE');
  put(12, 'fmt ');
  v.setUint32(16, 16, true);
  v.setUint16(20, opts.pcm16 ? 1 : 3, true);
  v.setUint16(22, channels, true);
  v.setUint32(24, rate, true);
  v.setUint32(28, rate * width * channels, true);
  v.setUint16(32, width * channels, true);
  v.setUint16(34, 8 * width, true);
  put(36, 'data');
  v.setUint32(40, data.length, true);
  out.set(data, 44);
  return out;
}

describe('parseTimings', () => {
  it('accepts what tts.py writes', () => {
    const t = fixture();
    expect(t.schema).toBe('timings/1');
    expect(t.sampleRateHz).toBe(48000);
    expect(t.engine.timeRule).toBe(TIME_RULE);
    expect(timingsProblems(t)).toEqual([]);
  });

  it('writes files that core/schemas accepts as timings.json (spec 8.2)', () => {
    expect(validateTimings(JSON.parse(readFileSync(join(DIR, 'fixtures/selftest.timings.json'), 'utf8')))).toEqual([]);
  });

  it('rejects other schemas and malformed words', () => {
    const good = JSON.parse(JSON.stringify(fixture())) as Record<string, unknown>;
    expect(() => parseTimings({ ...good, schema: 'timings/2' })).toThrow(/schema/);
    expect(() => parseTimings({ ...good, durationMs: 1.5 })).toThrow(/durationMs/);
    expect(() => parseTimings({ ...good, words: [{ index: 0, startMs: '1', endMs: 2, sentenceIndex: 0 }] })).toThrow(/word 0/);
    expect(() => parseTimings([])).toThrow(/not an object/);
  });
});

describe('timingsProblems', () => {
  it('accepts touching words and pauses', () => {
    expect(timingsProblems(make([[100, 300, 0], [300, 500, 0], [700, 900, 1]]))).toEqual([]);
  });

  it('finds overlaps, empty words, sentence jumps and words past the end', () => {
    expect(timingsProblems(make([[100, 300, 0], [250, 500, 0]]))).toEqual([
      'word 1 starts at 250 ms, before word 0 ends at 300 ms',
    ]);
    expect(timingsProblems(make([[100, 100, 0]]))).toEqual(['word 0 starts at 100 ms, not before its end 100 ms']);
    expect(timingsProblems(make([[100, 200, 0], [300, 400, 2]]))[0]).toBe('word 1 jumps from sentence 0 to 2');
    expect(timingsProblems(make([[100, 2500, 0]]))).toEqual(['the last word ends at 2500 ms, after the audio (2000 ms)']);
  });

  it('checks the counts against the list', () => {
    const t = make([[100, 200, 0]]);
    expect(timingsProblems({ ...t, wordCount: 2 })[0]).toMatch(/wordCount is 2/);
    expect(timingsProblems({ ...t, durationMs: 1999 })[0]).toMatch(/durationMs 1999/);
  });

  it('rejects a first word outside sentence 0, another rate and sentences without words', () => {
    const t = fixture();
    const shifted = { ...t, sentenceCount: t.sentenceCount + 1, words: t.words.map((w) => ({ ...w, sentenceIndex: w.sentenceIndex + 1 })) };
    expect(timingsProblems(shifted)).toEqual(['word 0 is in sentence 1, expected 0']);
    const rate = { ...t, sampleRateHz: 44100, durationSamples: 467460 }; // 10600 ms at 44.1 kHz
    expect(timingsProblems(rate)).toEqual(['sampleRateHz is 44100, expected 48000']);
    expect(timingsProblems({ ...make([]), sentenceCount: 5 })).toEqual(['sentenceCount is 5 but no words are listed']);
    expect(timingsProblems(make([]))).toEqual([]);
  });
});

describe('timingsTextProblems', () => {
  it('compares word count and sentence numbers with words.ts', () => {
    const t = make([[100, 200, 0], [200, 300, 0], [400, 500, 1]]);
    expect(timingsTextProblems(t, 'One two. Three')).toEqual([]);
    expect(timingsTextProblems(t, 'One two three')).toEqual(['word 2 is in sentence 0 for words.ts, 1 in timings.json']);
    expect(timingsTextProblems(t, 'One two. Three four')[0]).toBe('words.ts finds 4 words, timings.json lists 3');
  });
});

describe('timings-set/1: one timings.json for the clips of a folder (spec 8.2)', () => {
  const opening = make([[100, 200, 0], [300, 400, 1]]);
  const p1 = make([[50, 900, 0]], 1000);

  it('builds, parses and picks a clip by its file name', () => {
    const set = makeTimingsSet([
      { passageId: 'opening', audioSha256: HASH, timings: opening },
      { passageId: 'p1', audioSha256: 'cd'.repeat(32), timings: p1 },
    ]);
    const back = parseTimingsSet(JSON.parse(JSON.stringify(set)));
    expect(back.passages.map((p) => p.passageId)).toEqual(['opening', 'p1']);
    expect(timingsSetProblems(back)).toEqual([]);
    expect(timingsForClip(back, 'p1.wav')).toEqual(p1);
    expect(timingsForClip(back, 'opening')).toEqual(opening);
    expect(timingsForClip(back, 'p2.wav')).toBeNull();
    expect(timingsForClip(JSON.parse(JSON.stringify(opening)), 'anything.wav')).toEqual(opening);
  });

  it('writes two-space JSON with one word per line, as tts.py writes timings/1', () => {
    const set = makeTimingsSet([
      { passageId: 'opening', audioSha256: HASH, timings: opening },
      { passageId: 'p1', audioSha256: HASH, timings: p1 },
    ]);
    const text = timingsSetJson(set);
    expect(JSON.parse(text)).toEqual(set);
    expect(text.endsWith('}\n')).toBe(true);
    expect(text).toContain('\n          {"index": 0, "startMs": 100, "endMs": 200, "sentenceIndex": 0},\n');
    expect(text).toContain('\n          {"index": 1, "startMs": 300, "endMs": 400, "sentenceIndex": 1}\n');
    expect(text.split('\n').filter((l) => l.includes('"startMs"'))).toHaveLength(3);
  });

  it('refuses bad ids, hashes, duplicates, extra fields and broken clips', () => {
    const entry = { passageId: 'p1', audioSha256: HASH, timings: p1 };
    expect(() => makeTimingsSet([])).toThrow(/non-empty/);
    expect(() => makeTimingsSet([{ ...entry, passageId: 'P1.wav' }])).toThrow(/passageId/);
    expect(() => makeTimingsSet([{ ...entry, audioSha256: 'xyz' }])).toThrow(/audioSha256/);
    expect(() => makeTimingsSet([entry, entry])).toThrow(/listed twice/);
    expect(() => makeTimingsSet([{ ...entry, timings: { ...p1, sampleRateHz: 44100 } }])).toThrow(/passage p1: sampleRateHz/);
    expect(() => parseTimingsSet({ schema: 'timings-set/1', passages: [{ ...entry, text: 'x' }] })).toThrow(/unexpected field text/);
    expect(() => parseTimingsSet({ schema: 'timings-set/1', passages: [entry], note: 1 })).toThrow(/unexpected field note/);
    expect(() => timingsForClip({ schema: 'timings/9' }, 'p1.wav')).toThrow(/schema/);
  });
});

describe('the WAV beside the timings', () => {
  it('reads float and PCM headers and checks length and rate against the timings', () => {
    const t = make([[0, 1, 0]], 1);
    const f = wav(new Array(48).fill(0.25));
    const info = wavInfo(f);
    expect(info).toMatchObject({ formatTag: 3, channels: 1, sampleRateHz: 48000, bitsPerSample: 32, frames: 48 });
    expect(wavTimingsProblems(info, t)).toEqual([]);
    expect(Array.from(wavFloatSamples(f))).toEqual(new Array(48).fill(0.25));
    expect(wavTimingsProblems(wavInfo(wav(new Array(47).fill(0))), t)).toEqual(['the WAV holds 47 samples, timings.json says 48']);
    expect(wavTimingsProblems(wavInfo(wav(new Array(48).fill(0), { pcm16: true })), t)).toEqual([]);
    expect(wavTimingsProblems(wavInfo(wav(new Array(96).fill(0), { channels: 2 })), t)).toEqual(['the WAV has 2 channels, expected 1']);
    expect(wavTimingsProblems(wavInfo(wav(new Array(48).fill(0), { rate: 44100 })), t)).toEqual([
      'the WAV runs at 44100 Hz, timings.json at 48000 Hz',
    ]);
    expect(() => wavInfo(new TextEncoder().encode('not a wav file'))).toThrow(/RIFF/);
    expect(() => wavFloatSamples(wav([0], { pcm16: true }))).toThrow(/float/);
  });
});

describe('word times against the sound', () => {
  it('frame levels are RMS dBFS per 5 ms frame', () => {
    const levels = frameLevelsDb(new Float32Array([...new Array(240).fill(0), ...new Array(240).fill(0.5), 0.1]));
    expect(levels).toHaveLength(2);
    expect(levels[0]).toBe(-120);
    expect(levels[1]).toBeCloseTo(-6.0206, 3);
  });

  const levels = (ranges: [number, number][], totalMs: number): number[] =>
    Array.from({ length: totalMs / 5 }, (_, f) => (ranges.some(([a, b]) => a <= f * 5 && f * 5 < b) ? -20 : -80));

  it('finds words that hold a pause and sound outside every word', () => {
    const w = (startMs: number, endMs: number, index: number) => ({ index, startMs, endMs, sentenceIndex: 0 });
    expect(soundProblems(levels([[110, 690], [1210, 1490]], 2000), [w(100, 400, 0), w(400, 700, 1), w(1200, 1500, 2)])).toEqual([]);
    expect(soundProblems(levels([[100, 600], [1200, 1500]], 2000), [w(100, 900, 0), w(1200, 1500, 1)])).toEqual([
      'word 0 ends at 900 ms, 300 ms after its sound',
    ]);
    expect(soundProblems(levels([[100, 400], [1000, 1500]], 2000), [w(100, 400, 0), w(600, 1500, 1)])).toEqual([
      'word 1 starts at 600 ms, 400 ms before its sound',
    ]);
    expect(soundProblems(levels([[100, 400], [700, 800], [1200, 1500]], 2000), [w(100, 400, 0), w(1200, 1500, 1)])).toEqual([
      'sound at 700 ms lies outside every word',
    ]);
  });

  it('the committed selftest render: every word next to a pause is within 50 ms of its sound', () => {
    const t = fixture();
    expect(sound.frameMs).toBe(5);
    expect(sound.levelsDb).toHaveLength(Math.floor(t.durationSamples / 240));
    expect(soundProblems(sound.levelsDb, t.words, { slackMs: 50 })).toEqual([]);
    const gaps = t.words.slice(1).filter((w, k) => w.startMs > t.words[k]!.endMs).length;
    expect(gaps).toBe(5); // the pauses after "aloud," "time." "mistake," "so." and "idea:" stay gaps
  });

  it('would catch the times kokoro gives itself: words that hold the pause after them', () => {
    // kokoro's join_timestamps for "time." and "When": 3175..3975 and 4075.. (75 ms early, pause inside "time.")
    const t = fixture();
    const words = t.words.map((w) => ({ ...w }));
    words[10] = { ...words[10]!, startMs: 3175, endMs: 3975 };
    words[11] = { ...words[11]!, startMs: 4075 };
    expect(soundProblems(sound.levelsDb, words, { slackMs: 50 })).toEqual([
      'word 10 ends at 3975 ms, 345 ms after its sound',
      'word 11 starts at 4075 ms, 80 ms before its sound',
    ]);
  });
});

describe('stripBom', () => {
  it('drops a leading byte order mark only', () => {
    expect(stripBom('\u{FEFF}Hello')).toBe('Hello');
    expect(stripBom('Hello\u{FEFF}')).toBe('Hello\u{FEFF}');
  });
});
