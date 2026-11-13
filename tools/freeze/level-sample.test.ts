// The doctor volume sample in gate/level (spec 7.7, 7.12): its text, the stored 16-bit WAV and its word
// timings. Overlap with the gate packs is reported as counts only: no pack text is ever printed (spec
// 9.2). It lives under tools/ because Vitest and tsc collect tools/ and not gate/ (spec 13.4).
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { loadList, scanText } from '../lint-words.ts';
import { parseTimings, timingsProblems, timingsTextProblems } from '../tts/timings.ts';
import { countPassageWords, splitPassageSentences } from '../tts/words.ts';
import { decodeNarratorWav, decodeWav } from '../../web/ui/wav.ts';
import { durationProblem, LEVEL_DIR, LEVEL_DURATION_MS, LEVEL_FILES } from '../../gate/level/render.ts';
import { gatePassageVariants, overlapCount, SHINGLE_WORDS } from '../../gate/level/text.ts';
import { convertTtsWavToPcm16, encodePcm16MonoWav, floatToPcm16, peakDbfs, readFloatMonoWav, readWavFormat } from '../../gate/level/wav16.ts';

const GATE_DIR = join(LEVEL_DIR, '..');
const REPO = join(GATE_DIR, '..');
const text = readFileSync(LEVEL_FILES.text, 'utf8');

/** A float WAV as tools/tts/tts.py writes it: fmt (format 3), fact, data. */
function floatWav(samples: number[], rateHz = 48_000, channels = 1): Uint8Array {
  const data = samples.length * 4;
  const out = new Uint8Array(12 + 8 + 18 + 8 + 4 + 8 + data);
  const v = new DataView(out.buffer);
  const tag = (at: number, s: string): void => [...s].forEach((c, i) => v.setUint8(at + i, c.charCodeAt(0)));
  tag(0, 'RIFF');
  v.setUint32(4, out.length - 8, true);
  tag(8, 'WAVE');
  tag(12, 'fmt ');
  v.setUint32(16, 18, true);
  v.setUint16(20, 3, true);
  v.setUint16(22, channels, true);
  v.setUint32(24, rateHz, true);
  v.setUint32(28, rateHz * 4 * channels, true);
  v.setUint16(32, 4 * channels, true);
  v.setUint16(34, 32, true);
  v.setUint16(36, 0, true);
  tag(38, 'fact');
  v.setUint32(42, 4, true);
  v.setUint32(46, samples.length / channels, true);
  tag(50, 'data');
  v.setUint32(54, data, true);
  samples.forEach((x, i) => v.setFloat32(58 + i * 4, x, true));
  return out;
}

describe('level.txt (spec 7.7)', () => {
  it('is one paragraph of about 55 words in plain sentences', () => {
    expect(text.endsWith('\n')).toBe(true);
    expect(text.trimEnd().split('\n')).toHaveLength(1);
    const words = countPassageWords(text);
    expect(words).toBeGreaterThanOrEqual(50);
    expect(words).toBeLessThanOrEqual(65);
    expect(splitPassageSentences(text).length).toBeGreaterThanOrEqual(3);
    // tools/tts refuses [text](target); digits and symbols would be read in ways the timings do not number.
    expect(text).toMatch(/^[A-Za-z ,.\n]+$/);
  });

  it('holds no word from the banned list (spec 13.6)', () => {
    const banned = loadList(join(REPO, 'tools', 'words', 'banned.txt'));
    const allowed = loadList(join(REPO, 'tools', 'words', 'allow.txt'));
    expect(scanText(text, banned, allowed, 'gate/level/level.txt')).toEqual([]);
  });

  it('shares no sentence and no run of words with any gate pack (spec 7.7, 9.2)', () => {
    const packs = readdirSync(GATE_DIR).filter((n) => n.startsWith('pack-') && statSync(join(GATE_DIR, n)).isDirectory()).sort();
    let compared = 0;
    const overlaps: string[] = [];
    for (const pack of packs) {
      for (const file of readdirSync(join(GATE_DIR, pack)).filter((n) => n.endsWith('.txt')).sort()) {
        for (const variant of gatePassageVariants(readFileSync(join(GATE_DIR, pack, file), 'utf8'))) {
          compared += 1;
          const c = overlapCount(text, variant);
          // Counts and names only: the pack texts stay unread by anyone running the tests.
          if (c.sharedSentences > 0 || c.sharedRuns > 0) overlaps.push(`${pack}/${file}: ${c.sharedSentences} sentences, ${c.sharedRuns} runs of ${SHINGLE_WORDS} words`);
        }
      }
    }
    expect(compared).toBeGreaterThan(0);
    expect(overlaps).toEqual([]);
  });
});

describe('overlap counting', () => {
  it('counts shared sentences and word runs, ignoring case and punctuation', () => {
    const sample = 'The cat sat on the warm mat by the door. Rain fell.';
    expect(overlapCount(sample, 'Rain fell! Something else.')).toEqual({ sharedSentences: 1, sharedRuns: 0 });
    // "the cat sat on the warm mat by" and "cat sat on the warm mat by the".
    expect(overlapCount(sample, 'so the cat sat on the warm mat by the fire')).toEqual({ sharedSentences: 0, sharedRuns: 2 });
    expect(overlapCount(sample, 'Nothing alike here at all, not one bit of it.')).toEqual({ sharedSentences: 0, sharedRuns: 0 });
  });

  it('compares objection passages as spoken and as corrected', () => {
    expect(gatePassageVariants('A week has [[nine|seven]] days.')).toEqual(['A week has nine days.', 'A week has seven days.']);
    expect(gatePassageVariants('No markup.')).toEqual(['No markup.']);
  });
});

describe('level.wav (spec 7.7: mono, 48 kHz; stored as 16-bit PCM)', () => {
  const bytes = new Uint8Array(readFileSync(LEVEL_FILES.wav));
  const timings = parseTimings(JSON.parse(readFileSync(LEVEL_FILES.timings, 'utf8')));

  it('is a canonical 16-bit PCM mono WAV at 48 000 Hz', () => {
    const f = readWavFormat(bytes);
    expect(f).toMatchObject({ format: 1, channels: 1, sampleRateHz: 48_000, bitsPerSample: 16, dataOffset: 44 });
    expect(bytes.length).toBe(44 + f.frames * 2);
  });

  it('lasts close to 20 s and matches its timings', () => {
    const f = readWavFormat(bytes);
    expect(f.frames).toBe(timings.durationSamples);
    expect(timings.durationMs).toBeGreaterThanOrEqual(LEVEL_DURATION_MS.min);
    expect(timings.durationMs).toBeLessThanOrEqual(LEVEL_DURATION_MS.max);
    expect(durationProblem(timings.durationMs)).toBeNull();
  });

  it('is read by the page decoder (web/ui/wav.ts) and is not silent', () => {
    const buf = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
    const pcm = decodeNarratorWav(buf, 'level.wav');
    expect(pcm.length).toBe(timings.durationSamples);
    const peak = peakDbfs(pcm);
    expect(peak).toBeGreaterThan(-20);
    expect(peak).toBeLessThan(0);
  });

  it('has word timings in the tools/tts format for exactly the words of level.txt', () => {
    expect(timingsProblems(timings)).toEqual([]);
    expect(timingsTextProblems(timings, text)).toEqual([]);
    expect(timings.wordCount).toBe(countPassageWords(text));
    expect(timings.sampleRateHz).toBe(48_000);
    expect(timings.engine).toMatchObject({ name: 'kokoro', voice: 'af_heart', speed: 1 });
    expect(timings.words[0]!.startMs).toBeGreaterThan(0);
  });
});

describe('float to 16-bit conversion', () => {
  it('rounds x * 32768 to the nearest integer and counts clipped samples', () => {
    const { pcm, clippedSamples } = floatToPcm16(new Float32Array([0, 0.5, -0.5, -1, 1, 1.5, -2, 1 / 65536, Number.NaN]));
    expect(Array.from(pcm)).toEqual([0, 16384, -16384, -32768, 32767, 32767, -32768, 1, 0]);
    expect(clippedSamples).toBe(4);
  });

  it('keeps every sample within one step of the float value, as the page reads it back', () => {
    fc.assert(
      fc.property(fc.array(fc.float({ min: -1, max: Math.fround(0.99996), noNaN: true }), { maxLength: 200 }), (xs) => {
        const samples = Float32Array.from(xs);
        const wav = encodePcm16MonoWav(floatToPcm16(samples).pcm);
        const back = decodeWav(wav.buffer as ArrayBuffer).samples;
        expect(back.length).toBe(samples.length);
        back.forEach((y, i) => expect(Math.abs(y - samples[i]!)).toBeLessThanOrEqual(0.5 / 32768 + 1e-9));
      }),
      { numRuns: 100 },
    );
  });

  it('converts a tools/tts float WAV without changing the sample count', () => {
    const src = floatWav([0, 0.25, -0.25, 0.999]);
    expect(readFloatMonoWav(src).samples.length).toBe(4);
    const out = convertTtsWavToPcm16(src);
    expect(out.frames).toBe(4);
    expect(out.clippedSamples).toBe(0);
    expect(readWavFormat(out.wav)).toMatchObject({ format: 1, channels: 1, sampleRateHz: 48_000, bitsPerSample: 16, frames: 4 });
  });

  it('refuses another rate, stereo and integer input', () => {
    expect(() => convertTtsWavToPcm16(floatWav([0, 0], 24_000))).toThrow(/48000 Hz/);
    expect(() => readFloatMonoWav(floatWav([0, 0, 0, 0], 48_000, 2))).toThrow(/mono/);
    expect(() => readFloatMonoWav(encodePcm16MonoWav(new Int16Array(4)))).toThrow(/float/);
    expect(() => readWavFormat(new Uint8Array(16))).toThrow(/RIFF/);
  });
});

describe('durationProblem', () => {
  it('accepts 18 to 22 s only', () => {
    expect(durationProblem(17_999)).toMatch(/shorter/);
    expect(durationProblem(18_000)).toBeNull();
    expect(durationProblem(22_000)).toBeNull();
    expect(durationProblem(22_001)).toMatch(/longer/);
  });

  it('the stored files exist next to the text', () => {
    for (const f of Object.values(LEVEL_FILES)) expect(existsSync(f)).toBe(true);
  });
});
