import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { countPassageWords, splitPassageSentences, splitPassageWords } from './words.ts';
import { parseTimings, timingsProblems, timingsTextProblems } from './timings.ts';

// words.ts numbers the words that timings.json times (spec 7.7). tts.py numbers them with
// words.py; the fixtures below come from tts.py and words.py (make_fixtures.py).
const DIR = import.meta.dirname;
const readJson = (name: string): unknown => JSON.parse(readFileSync(join(DIR, name), 'utf8'));

interface Selftest {
  text: string;
  wordCount: number;
  sentenceCount: number;
}
const selftest = readJson('selftest.json') as Selftest;
const pairs = (text: string): [string, number][] => splitPassageWords(text).map((w) => [w.text, w.sentenceIndex]);

describe('selftest phrase', () => {
  it('has the word and sentence counts stored with it', () => {
    expect(countPassageWords(selftest.text)).toBe(selftest.wordCount);
    expect(splitPassageWords(selftest.text)).toHaveLength(selftest.wordCount);
    expect(splitPassageSentences(selftest.text)).toHaveLength(selftest.sentenceCount);
  });

  it('is numbered as words.py numbers it', () => {
    const fixture = readJson('fixtures/selftest.words.json') as { words: [string, number][] };
    expect(pairs(selftest.text)).toEqual(fixture.words);
  });

  it('matches the timings.json that tts.py rendered', () => {
    const timings = parseTimings(readJson('fixtures/selftest.timings.json'));
    expect(timings.wordCount).toBe(selftest.wordCount);
    expect(timings.sentenceCount).toBe(selftest.sentenceCount);
    expect(timings.words.map((w) => w.sentenceIndex)).toEqual(splitPassageWords(selftest.text).map((w) => w.sentenceIndex));
    expect(timingsProblems(timings)).toEqual([]);
    expect(timingsTextProblems(timings, selftest.text)).toEqual([]);
    expect(timings.engine.modelRepo).toBe('hexgrad/Kokoro-82M');
    expect(timings.engine.modelRevision).toMatch(/^[0-9a-f]{40}$/);
    expect(timings.engine.voice).toBe('af_heart');
  });

  it('keeps text out of timings.json', () => {
    const doc = readJson('fixtures/selftest.timings.json') as { words: object[] };
    for (const w of doc.words) expect(Object.keys(w)).toEqual(['index', 'startMs', 'endMs', 'sentenceIndex']);
    const tokens = new Set<string>();
    const walk = (v: unknown): void => {
      if (typeof v === 'string') for (const t of v.toLowerCase().split(/[^\p{L}]+/u)) tokens.add(t);
      else if (v !== null && typeof v === 'object') Object.values(v).forEach(walk);
    };
    walk(doc);
    const leaked = splitPassageWords(selftest.text)
      .map((w) => w.text.toLowerCase().replace(/[^\p{L}]/gu, ''))
      .filter((letters) => letters.length >= 4 && tokens.has(letters));
    expect(leaked).toEqual([]);
  });
});

describe('edge cases numbered by words.py', () => {
  const fixture = readJson('fixtures/words-cases.json') as { cases: { text: string; words: [string, number][] }[] };
  it.each(fixture.cases.map((c, k) => [k, c] as const))('case %i', (_k, c) => {
    expect(pairs(c.text)).toEqual(c.words);
  });
});

describe('splitPassageWords', () => {
  it('keeps punctuation with its word and skips runs without letters or digits', () => {
    expect(pairs('Wait \u{2014} one, two... -- & three.')).toEqual([
      ['Wait', 0],
      ['one,', 0],
      ['two...', 0],
      ['three.', 0],
    ]);
  });

  it('numbers sentences without gaps when a sentence holds no word', () => {
    const text = 'One here. ... ! Two here.';
    expect(pairs(text)).toEqual([
      ['One', 0],
      ['here.', 0],
      ['Two', 1],
      ['here.', 1],
    ]);
    expect(splitPassageSentences(text).map((s) => [s.index, s.firstWord, s.wordCount])).toEqual([
      [0, 0, 2],
      [1, 2, 2],
    ]);
  });

  it('gives a word to the sentence where it starts', () => {
    expect(pairs('Stop!Go now. Next')).toEqual([
      ['Stop!Go', 0],
      ['now.', 1],
      ['Next', 2],
    ]);
  });

  it('returns UTF-16 offsets that slice back to the word', () => {
    const text = '\u{A0}Caf\u{E9} \u{1F600}ok here.\nNew line';
    for (const w of splitPassageWords(text)) expect(text.slice(w.charStart, w.charEnd)).toBe(w.text);
  });

  it('finds no words in empty or blank text', () => {
    expect(splitPassageWords('')).toEqual([]);
    expect(splitPassageWords(' \n\t ')).toEqual([]);
    expect(splitPassageSentences('-- ...')).toEqual([]);
  });
});

const pieces = [
  'word', 'Word', 'I', 'U', 'e', 'g', '3', '1,500', '.', '.', '!', '?', '...', '\u{2026}', ',', ';', ':', '-', '\u{2014}',
  '"', "'", '\u{201C}', '\u{201D}', '(', ')', ' ', ' ', ' ', '\t', '\n', '\n\n', '\r\n', '\u{A0}', 'Mr.', 'U.S.', 'e.g.',
  '3.30', '\u{E9}', '\u{301}', '\u{200B}', '\u{1F600}', '&', '%', '$',
];
const passage = fc.array(fc.constantFrom(...pieces), { maxLength: 60 }).map((a) => a.join(''));

describe('properties', () => {
  it('words are ordered whitespace-free runs with a letter or digit, sentences step by one', () => {
    fc.assert(
      fc.property(passage, (text) => {
        const words = splitPassageWords(text);
        expect(countPassageWords(text)).toBe(words.length);
        let prevEnd = 0;
        let prevSentence = 0;
        words.forEach((w, k) => {
          expect(w.index).toBe(k);
          expect(text.slice(w.charStart, w.charEnd)).toBe(w.text);
          expect(w.text).toMatch(/^\P{White_Space}+$/u);
          expect(w.text).toMatch(/[\p{L}\p{N}]/u);
          expect(w.charStart).toBeGreaterThanOrEqual(prevEnd);
          expect([prevSentence, prevSentence + 1]).toContain(w.sentenceIndex);
          if (k === 0) expect(w.sentenceIndex).toBe(0);
          prevEnd = w.charEnd;
          prevSentence = w.sentenceIndex;
        });
        const sentences = splitPassageSentences(text);
        expect(sentences.reduce((n, s) => n + s.wordCount, 0)).toBe(words.length);
        sentences.forEach((s, k) => {
          expect(s.index).toBe(k);
          expect(s.wordCount).toBeGreaterThan(0);
          expect(words[s.firstWord]!.sentenceIndex).toBe(k);
        });
      }),
      { numRuns: 500, seed: 7 },
    );
  });
});
