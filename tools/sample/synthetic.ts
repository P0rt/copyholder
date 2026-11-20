// Synthetic sample clips for the tests of tools/sample: filler sentences of ten words, planted errors
// made of placeholder words, word timings at a fixed pace and WAV files of a plain tone. Nothing here
// comes from the real sample text, so the tests can be read before a demo take.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { encodePcm16MonoWav, floatToPcm16 } from '../../gate/level/wav16.ts';
import { parseTimings, SAMPLE_RATE_HZ, type Timings } from '../tts/timings.ts';
import { splitPassageWords } from '../tts/words.ts';
import type { SampleErrorSpec, SamplePassageId } from './plan.ts';

/** Every word lasts this long; the clip starts and ends with LEAD_MS of silence. */
export const MS_PER_WORD = 300;
export const LEAD_MS = 300;

const FILLER = ['Plain', 'words', 'fill', 'this', 'line', 'of', 'the', 'test', 'text', 'now'];

/** A sentence of ten words whose last words are `end`. */
export function sentence(end: readonly string[] = []): string {
  return `${[...FILLER.slice(0, FILLER.length - end.length), ...end].join(' ')}.`;
}

/** Sentences, five to a line, with one line break at the end. */
export function passageText(sentences: readonly string[]): string {
  const lines: string[] = [];
  for (let i = 0; i < sentences.length; i += 5) lines.push(sentences.slice(i, i + 5).join(' '));
  return `${lines.join('\n')}\n`;
}

/** Start of word k in ms. */
export const wordStartMs = (k: number): number => LEAD_MS + k * MS_PER_WORD;

const ENGINE = parseTimings(JSON.parse(readFileSync(join(import.meta.dirname, '..', 'tts', 'fixtures', 'selftest.timings.json'), 'utf8'))).engine;

/** timings/1 of a text read at MS_PER_WORD a word, numbered as tools/tts/words.ts numbers it. */
export function pacedTimings(text: string): Timings {
  const words = splitPassageWords(text);
  const durationMs = 2 * LEAD_MS + words.length * MS_PER_WORD;
  return {
    schema: 'timings/1',
    wordRule: 'copyholder-words/1',
    sampleRateHz: SAMPLE_RATE_HZ,
    durationSamples: (durationMs * SAMPLE_RATE_HZ) / 1000,
    durationMs,
    wordCount: words.length,
    sentenceCount: words.length === 0 ? 0 : words[words.length - 1]!.sentenceIndex + 1,
    engine: { ...ENGINE },
    correctedChunks: 0,
    words: words.map((w, index) => ({ index, startMs: wordStartMs(index), endMs: wordStartMs(index + 1), sentenceIndex: w.sentenceIndex })),
  };
}

export interface SyntheticSample {
  texts: Record<SamplePassageId, string>;
  specs: SampleErrorSpec[];
}

/**
 * A sample that keeps every rule of plan.ts: the opening has 20 filler sentences (60.6 s); p1 has
 * 18 (54.6 s) with errors ending sentences 3, 8 and 13 (from 12.0, 26.7 and 41.1 s); p2 has 15
 * (45.6 s) with errors ending sentences 3 and 9 (from 12.0 and 30.0 s).
 */
export function syntheticSample(): SyntheticSample {
  const filler = (n: number): string[] => Array.from({ length: n }, () => sentence());
  const p1 = filler(18);
  p1[3] = sentence(['beta']);
  p1[8] = sentence(['gamma', 'delta']);
  p1[13] = sentence(['did', 'not', 'go', 'home']);
  const p2 = filler(15);
  p2[3] = sentence(['zeta']);
  p2[9] = sentence(['theta']);
  return {
    texts: { opening: passageText(filler(20)), p1: passageText(p1), p2: passageText(p2) },
    specs: [
      { error_id: 'sample-e1', passage_id: 'p1', class: 'number', sentence_index: 3, replacement: 'beta', original_span: 'alpha' },
      { error_id: 'sample-e2', passage_id: 'p1', class: 'swapped_fact', sentence_index: 8, replacement: 'gamma delta', original_span: 'kappa' },
      { error_id: 'sample-e3', passage_id: 'p1', class: 'negation', sentence_index: 13, replacement: 'did not go', original_span: 'went' },
      { error_id: 'sample-e4', passage_id: 'p2', class: 'swapped_fact', sentence_index: 3, replacement: 'zeta', original_span: 'eta' },
      { error_id: 'sample-e5', passage_id: 'p2', class: 'number', sentence_index: 9, replacement: 'theta', original_span: 'iota' },
    ],
  };
}

/** A tone of `frames` samples at `amplitude`. */
export function tone(frames: number, amplitude = 0.1, hz = 440): Float32Array {
  const out = new Float32Array(frames);
  for (let i = 0; i < frames; i++) out[i] = amplitude * Math.sin((2 * Math.PI * hz * i) / SAMPLE_RATE_HZ);
  return out;
}

/** A mono 32-bit float WAV at 48 kHz, as tools/tts writes it (without the fact chunk). */
export function floatWav(samples: Float32Array): Uint8Array {
  const out = new Uint8Array(44 + samples.length * 4);
  const v = new DataView(out.buffer);
  const put = (at: number, s: string): void => [...s].forEach((c, i) => v.setUint8(at + i, c.charCodeAt(0)));
  put(0, 'RIFF');
  v.setUint32(4, 36 + samples.length * 4, true);
  put(8, 'WAVE');
  put(12, 'fmt ');
  v.setUint32(16, 16, true);
  v.setUint16(20, 3, true);
  v.setUint16(22, 1, true);
  v.setUint32(24, SAMPLE_RATE_HZ, true);
  v.setUint32(28, SAMPLE_RATE_HZ * 4, true);
  v.setUint16(32, 4, true);
  v.setUint16(34, 32, true);
  put(36, 'data');
  v.setUint32(40, samples.length * 4, true);
  samples.forEach((x, i) => v.setFloat32(44 + 4 * i, x, true));
  return out;
}

/** A mono 16-bit PCM WAV at 48 kHz, as the stored clips and gate/level/level.wav are. */
export function pcm16Wav(samples: Float32Array): Uint8Array {
  return encodePcm16MonoWav(floatToPcm16(samples).pcm, SAMPLE_RATE_HZ);
}
