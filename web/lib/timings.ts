// Word times of one passage (timings.json, spec 7.7; format tools/tts/timings.ts) and the resume
// rule of spec 6.4: read again from the start of the interrupted word, or from the next word when
// at least 80% of the interrupted word played.

import { RESUME_NEXT_WORD_FRACTION, msToSamples } from './units.ts';

export interface WordTimes {
  /** First sample of each word in the passage audio. */
  startSamples: number[];
  /** First sample after each word. */
  endSamples: number[];
  /** Word number written into stamps (`word`): timings.json `index`, else the array index. */
  ids: number[];
}

export const NO_WORDS: WordTimes = Object.freeze({ startSamples: [], endSamples: [], ids: [] }) as unknown as WordTimes;

function num(o: Record<string, unknown>, keys: readonly string[]): number | null {
  for (const k of keys) {
    const v = o[k];
    if (typeof v === 'number' && Number.isFinite(v)) return v;
  }
  return null;
}

/**
 * Reads timings.json (`{schema:'timings/1', words:[{index, startMs, endMs, sentenceIndex}]}`).
 * Also accepts a bare word array, of such objects or of [startMs, endMs] pairs (tests).
 * Throws on a word without a valid start and end, or on words out of order.
 */
export function normalizeWordTimings(raw: unknown): WordTimes {
  let list: unknown = raw;
  if (list && typeof list === 'object' && !Array.isArray(list)) list = (list as Record<string, unknown>).words;
  if (!Array.isArray(list)) throw new Error('timings: expected {words: [...]} or a word array');
  const out: WordTimes = { startSamples: [], endSamples: [], ids: [] };
  list.forEach((w: unknown, index: number) => {
    let startMs: number | null = null;
    let endMs: number | null = null;
    let id: number | null = null;
    if (Array.isArray(w)) {
      startMs = typeof w[0] === 'number' ? w[0] : null;
      endMs = typeof w[1] === 'number' ? w[1] : null;
    } else if (w && typeof w === 'object') {
      const o = w as Record<string, unknown>;
      startMs = num(o, ['startMs', 'start_ms']);
      endMs = num(o, ['endMs', 'end_ms']);
      id = num(o, ['index']);
    }
    if (startMs === null || endMs === null || !(endMs >= startMs) || startMs < 0) {
      throw new Error(`timings: word ${index} has no valid startMs and endMs`);
    }
    const start = msToSamples(startMs);
    if (index > 0 && start < (out.endSamples[index - 1] as number)) throw new Error(`timings: word ${index} starts before word ${index - 1} ends`);
    out.startSamples.push(start);
    out.endSamples.push(msToSamples(endMs));
    out.ids.push(id === null ? index : id);
  });
  return out;
}

/**
 * Index of the word interrupted at read position p (samples): the word that contains p,
 * else the next word to be read (p in a pause), else words.length (p after the last word).
 */
export function interruptedWordIndex(words: WordTimes, p: number): number {
  const ends = words.endSamples;
  for (let i = 0; i < ends.length; i++) if (p < (ends[i] as number)) return i;
  return ends.length;
}

/** Share of word i output before position p; 0 when p is in the pause before it. */
export function playedFraction(words: WordTimes, i: number, p: number): number {
  const start = words.startSamples[i];
  const end = words.endSamples[i];
  if (start === undefined || end === undefined || p <= start) return 0;
  if (end <= start) return 1;
  return Math.min(1, (p - start) / (end - start));
}

/** Word index reading resumes from after a stop whose fade started at read position p (spec 6.4). */
export function resumeWordIndex(words: WordTimes, p: number, minFraction: number = RESUME_NEXT_WORD_FRACTION): number {
  const i = interruptedWordIndex(words, p);
  if (i >= words.startSamples.length) return i;
  return playedFraction(words, i, p) >= minFraction ? i + 1 : i;
}

/** What a stop at read position p means for the stamps and the resume (spec 6.4, 8.1). */
export interface StopPlan {
  /** Word number of the interrupted word; null without timings or after the last word. */
  word: number | null;
  /** Read position to resume from; null: from where the pointer froze. */
  resumeFrom: number | null;
  /** Word number reading resumes with; null when no word follows. */
  resumeWord: number | null;
}

export function stopPlan(words: WordTimes, p: number): StopPlan {
  const count = words.startSamples.length;
  const i = interruptedWordIndex(words, p);
  if (i >= count) return { word: null, resumeFrom: null, resumeWord: null };
  const r = resumeWordIndex(words, p);
  if (r >= count) {
    // At least 80% of the last word played: go on after it.
    return { word: words.ids[i] as number, resumeFrom: words.endSamples[count - 1] as number, resumeWord: null };
  }
  return { word: words.ids[i] as number, resumeFrom: words.startSamples[r] as number, resumeWord: words.ids[r] as number };
}
