// The doctor volume sample shares no sentence with the gate packs (spec 7.7: "не из наборов текстов",
// spec 9.2). Pure helpers that only count overlaps, so no pack text is ever printed.

/** Runs of this many words count as shared text, the rule gate/check-texts.ts applies between packs. */
export const SHINGLE_WORDS = 8;

const SENTENCES = new Intl.Segmenter('en', { granularity: 'sentence' });
const WORD = /[\p{L}\p{N}]+(?:['’][\p{L}\p{N}]+)*/gu;
const MARKUP = /\[\[([^[\]|]*)\|([^[\]|]*)\]\]/g;

/** Lowercase words without punctuation: the form both texts are compared in. */
export function normalizedWords(text: string): string[] {
  return (text.toLowerCase().match(WORD) ?? []).map((w) => w.replace(/’/g, "'"));
}

/** Sentences (Intl.Segmenter, as tools/tts/words.ts) as normalized word strings; empty ones dropped. */
export function normalizedSentences(text: string): string[] {
  const out: string[] = [];
  for (const s of SENTENCES.segment(text)) {
    const words = normalizedWords(s.segment);
    if (words.length > 0) out.push(words.join(' '));
  }
  return out;
}

/** Every run of `n` consecutive words, inside one line (a line break ends a paragraph, tools/tts). */
export function wordShingles(text: string, n: number = SHINGLE_WORDS): Set<string> {
  const out = new Set<string>();
  for (const line of text.split('\n')) {
    const words = normalizedWords(line);
    for (let i = 0; i + n <= words.length; i += 1) out.add(words.slice(i, i + n).join(' '));
  }
  return out;
}

/** An objection passage as spoken (wrong phrase) and as corrected (right phrase); gate/README.md markup. */
export function gatePassageVariants(markup: string): string[] {
  const spoken = markup.replace(MARKUP, (_all, wrong: string) => wrong.trim());
  const corrected = markup.replace(MARKUP, (_all, _wrong: string, right: string) => right.trim());
  return spoken === corrected ? [spoken] : [spoken, corrected];
}

export interface OverlapCount {
  /** Sentences of the sample that also occur, word for word, in the other text. */
  sharedSentences: number;
  /** Runs of SHINGLE_WORDS words of the sample that also occur in the other text. */
  sharedRuns: number;
}

/** How much of `sample` occurs in `other`, as counts only. */
export function overlapCount(sample: string, other: string, runWords: number = SHINGLE_WORDS): OverlapCount {
  const theirs = new Set(normalizedSentences(other));
  const sharedSentences = normalizedSentences(sample).filter((s) => theirs.has(s)).length;
  const theirRuns = wordShingles(other, runWords);
  let sharedRuns = 0;
  for (const run of wordShingles(sample, runWords)) if (theirRuns.has(run)) sharedRuns += 1;
  return { sharedSentences, sharedRuns };
}
