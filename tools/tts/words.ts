// Word and sentence numbering of a narrator passage: the numbers timings.json uses (spec 7.7, 8.2).
// tools/tts/words.py mirrors this file; tools/tts/words.test.ts checks the two agree.
//
// A word is a maximal run of non-whitespace characters that holds at least one letter or digit,
// so attached punctuation stays with its word ("aloud,") and a lone dash or "..." is no word.
// Sentences come from Intl.Segmenter('en', { granularity: 'sentence' }) as in the planter (spec 7.8).
// A word belongs to the sentence that holds its first character. Sentence numbers count only
// sentences that hold at least one word start, so they run 0, 1, 2, ... without gaps.

/** Unicode White_Space, spelled out so words.py can use the very same set. */
export const WHITESPACE_CLASS =
  '\\t\\n\\u000b\\u000c\\r \\u0085\\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000';

const RUN = new RegExp(`[^${WHITESPACE_CLASS}]+`, 'gu');
const WORD_CHAR = /[\p{L}\p{N}]/u;
const SENTENCES = new Intl.Segmenter('en', { granularity: 'sentence' });

export interface PassageWord {
  /** 0-based word number in the passage: the `index` in timings.json. */
  index: number;
  /** 0-based number of the sentence that holds the word's first character. */
  sentenceIndex: number;
  /** The word as written, with attached punctuation. */
  text: string;
  /** UTF-16 offset of the first character in the passage. */
  charStart: number;
  /** UTF-16 offset just past the last character. */
  charEnd: number;
}

export interface PassageSentence {
  /** 0-based sentence number, as in PassageWord.sentenceIndex. */
  index: number;
  /** The sentence segment as Intl.Segmenter returns it, trailing whitespace included. */
  text: string;
  charStart: number;
  charEnd: number;
  /** Number of the first word that starts in this sentence. */
  firstWord: number;
  /** Number of words that start in this sentence (at least 1). */
  wordCount: number;
}

interface Segment {
  text: string;
  start: number;
}

function sentenceSegments(text: string): Segment[] {
  return Array.from(SENTENCES.segment(text), (s) => ({ text: s.segment, start: s.index }));
}

/** True when the run holds at least one letter or digit. */
export function isWordRun(run: string): boolean {
  return WORD_CHAR.test(run);
}

/** Splits a passage into the words timings.json numbers, in order. */
export function splitPassageWords(text: string): PassageWord[] {
  return numberWords(text, sentenceSegments(text)).words;
}

/** The sentences that hold at least one word start, numbered as in splitPassageWords. */
export function splitPassageSentences(text: string): PassageSentence[] {
  return numberWords(text, sentenceSegments(text)).sentences;
}

/** Number of words timings.json holds for this passage. */
export function countPassageWords(text: string): number {
  let n = 0;
  for (const m of text.matchAll(RUN)) if (isWordRun(m[0])) n++;
  return n;
}

function numberWords(text: string, segments: Segment[]): { words: PassageWord[]; sentences: PassageSentence[] } {
  const words: PassageWord[] = [];
  const sentences: PassageSentence[] = [];
  let seg = -1;
  for (const m of text.matchAll(RUN)) {
    const run = m[0];
    if (!isWordRun(run)) continue;
    const start = m.index;
    while (seg + 1 < segments.length && segments[seg + 1]!.start <= start) seg++;
    const s = segments[seg]!;
    let current = sentences[sentences.length - 1];
    if (current === undefined || current.charStart !== s.start) {
      current = {
        index: sentences.length,
        text: s.text,
        charStart: s.start,
        charEnd: s.start + s.text.length,
        firstWord: words.length,
        wordCount: 0,
      };
      sentences.push(current);
    }
    current.wordCount++;
    words.push({ index: words.length, sentenceIndex: current.index, text: run, charStart: start, charEnd: start + run.length });
  }
  return { words, sentences };
}
