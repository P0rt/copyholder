// The public sample text of `npm run headstart` (spec 7.11, 15.1; PREREG.md §11 "Demo takes"): an
// opening without planted errors, then two passages with obvious ones, read by the narrator voice
// (tools/tts). Its plan, sample/plan.json (`sample-plan/1`), is public, so the sample is not blind:
// it lists every planted error with the changed words, what is right, its word numbers and its
// times. This module builds that plan from the texts and the word timings and checks it against
// them. Pure: no Node APIs; tools/sample/build.ts reads and writes the files.
//
// Problems are blind, as in gate/check-texts.ts (Finding, formatProblem): the message names the
// rule, the passage, the error and counts, and never a word of the texts or a time inside a clip,
// because the participant of a demo take may rebuild the sample before the take. Words, word and
// sentence numbers and times go into the detail, which build.ts prints only with --show-text.

import type { Finding } from '../../gate/check-texts.ts';
import { splitPassageSentences, splitPassageWords, type PassageSentence, type PassageWord } from '../tts/words.ts';
import { timingsProblems, timingsTextProblems, type Timings } from '../tts/timings.ts';

export const SAMPLE_PLAN_SCHEMA = 'sample-plan/1';
export const SAMPLE_LICENCE = 'CC0-1.0';
export const SAMPLE_PLAN_NOTE =
  'Public plan of the sample text (spec 7.11, PREREG.md section 11): not sealed, so the sample is not blind. ' +
  'Word numbers and sentence numbers count from 0 as timings.json does; word_end is inclusive; times are ms from the first sample of the clip.';

/**
 * The clips in reading order, with the length each aims at and its number of planted errors. The
 * opening has none: the chest detector learns ordinary breaths while the narrator reads it (spec 7.4).
 * Lengths and counts are the brief of this sample (assumption, after spec 15.1).
 */
export const SAMPLE_PASSAGES = [
  { id: 'opening', targetMs: 60_000, errors: 0 },
  { id: 'p1', targetMs: 55_000, errors: 3 },
  { id: 'p2', targetMs: 45_000, errors: 2 },
] as const;

export type SamplePassageId = (typeof SAMPLE_PASSAGES)[number]['id'];
export const SAMPLE_PASSAGE_IDS: readonly SamplePassageId[] = SAMPLE_PASSAGES.map((p) => p.id);

/** A clip may differ from its target length by at most this much. */
export const DURATION_TOLERANCE_MS = 10_000;
/** No planted error starts in the first 8 s of its passage. */
export const FIRST_ERROR_MS = 8_000;
/** From the end of one planted error to the start of the next one in the same passage. */
export const MIN_ERROR_GAP_MS = 12_000;
/** The changed words close their sentence: at most this many words of the sentence follow them. */
export const MAX_WORDS_AFTER_ERROR = 1;
/** Changed words and right words: one to three words each (spec 7.8: up to 3 removed and 3 inserted). */
export const MAX_SPAN_WORDS = 3;

/** The kinds of slip: a number, a negation, a swapped fact. Each appears at least once. */
export const SAMPLE_ERROR_CLASSES = ['number', 'negation', 'swapped_fact'] as const;
export type SampleErrorClass = (typeof SAMPLE_ERROR_CLASSES)[number];

/** What a planted error is: the part of plan.json written by hand. build.ts adds where and when. */
export interface SampleErrorSpec {
  /** sample-e1, sample-e2, ... */
  error_id: string;
  passage_id: SamplePassageId;
  class: SampleErrorClass;
  /** Number of the sentence in its passage, from 0, as timings.json numbers sentences. */
  sentence_index: number;
  /** The changed words as the narrator reads them (punctuation left out). */
  replacement: string;
  /** What is right: the words the sentence should hold instead. */
  original_span: string;
}

export interface SamplePlanError extends SampleErrorSpec {
  /** The sentence as the narrator reads it. */
  planted_sentence: string;
  /** The same sentence with original_span in place of the changed words. */
  original_sentence: string;
  /** First and last changed word (inclusive): word numbers of timings.json, from 0. */
  word_start: number;
  word_end: number;
  /** Start of word_start and end of word_end in the clip, from timings.json. */
  span_start_ms: number;
  span_end_ms: number;
  /** End of the last word of the sentence. */
  sentence_end_ms: number;
}

export interface SamplePlanPassage {
  passage_id: SamplePassageId;
  /** Relative to sample/. */
  text_file: string;
  /** SHA-256 of the text file's bytes. */
  text_sha256: string;
  audio_file: string;
  /** SHA-256 of the WAV bytes, as in timings.json. */
  audio_sha256: string;
  duration_ms: number;
  word_count: number;
  sentence_count: number;
  error_count: number;
}

export interface SamplePlan {
  schema: typeof SAMPLE_PLAN_SCHEMA;
  licence: typeof SAMPLE_LICENCE;
  note: string;
  passages: SamplePlanPassage[];
  errors: SamplePlanError[];
}

/** One clip as build.ts hands it over: its text, the hashes of the files and its word timings. */
export interface SamplePassageInput {
  id: SamplePassageId;
  /** The text the clip was rendered from, without a byte order mark. */
  text: string;
  textSha256: string;
  audioSha256: string;
  timings: Timings;
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

export const textFileOf = (id: SamplePassageId): string => `texts/${id}.txt`;
export const audioFileOf = (id: SamplePassageId): string => `${id}.wav`;

// ---------------------------------------------------------------------------------------------
// Problems
// ---------------------------------------------------------------------------------------------

/** A blind message, and the words, word numbers or times behind it as an optional detail. */
export function finding(message: string, detail?: string): Finding {
  return detail === undefined || detail === '' ? { message } : { message, detail };
}

/** One problem as a line: the detail in brackets only with --show-text (gate/check-texts.ts formatProblem). */
export function formatFinding(f: Finding, showText: boolean): string {
  return `${f.message}${showText && f.detail !== undefined ? ` [${f.detail}]` : ''}`;
}

/** Messages of tools/tts name words by number and give times: a count here, the messages as the detail. */
export function ttsFinding(what: string, messages: readonly string[]): Finding[] {
  return messages.length === 0 ? [] : [finding(`${what}: ${messages.length} defect(s) found by tools/tts`, messages.join('; '))];
}

const prefixed = (where: string, findings: readonly Finding[]): Finding[] => findings.map((f) => ({ ...f, message: `${where}: ${f.message}` }));

// ---------------------------------------------------------------------------------------------
// The texts
// ---------------------------------------------------------------------------------------------

/**
 * Topic guard, as for the gate packs (gate/check-texts.ts, task brief): nothing about breathing,
 * the body, health, feelings, the listener, the recording, or errors themselves. Whole words,
 * lower case; the prefixes match the start of a word.
 */
export const OFF_TOPIC_PREFIXES: readonly string[] = ['breath', 'inhal', 'exhal'];
export const OFF_TOPIC_WORDS: ReadonlySet<string> = new Set([
  'lung', 'lungs', 'sniff', 'sniffed', 'sigh', 'sighed', 'gasp', 'gasped', 'cough', 'coughed',
  'pant', 'panted', 'panting', 'yawn', 'yawned', 'wheeze', 'wheezed',
  'chest', 'nose', 'mouth', 'lips', 'lip', 'throat',
  'health', 'healthy', 'ill', 'sick', 'doctor', 'nurse', 'hospital', 'medicine', 'pain', 'painful',
  'heart', 'hearts', 'blood', 'patient', 'tired', 'weary',
  'happy', 'unhappy', 'sad', 'angry', 'anger', 'afraid', 'fear', 'feared', 'scared', 'frightened',
  'worried', 'worry', 'lonely', 'glad', 'proud', 'upset',
  'calm', 'calmly', 'nervous', 'excited', 'love', 'loved', 'hate', 'joy', 'feel', 'feels', 'feeling', 'felt',
  'you', 'your', 'yours', 'yourself', 'listener', 'listeners',
  'mistake', 'mistakes', 'error', 'errors', 'wrong', 'correct', 'correction', 'camera', 'dot',
  'voice', 'voices', 'speak', 'speaks', 'spoke', 'spoken', 'silent', 'silence', 'quiet', 'quietly',
]);

/**
 * Rules for a sample text, as for the gate texts (gate/check-texts.ts parsePassage): one paragraph
 * per line, each ending with a period; only letters, spaces, periods and commas, so numbers are
 * words and every word is one word for tools/tts; a space after every period and comma; no word
 * of the topic guard. The characters and words at fault are the detail.
 */
export function sampleTextProblems(text: string): Finding[] {
  const out: Finding[] = [];
  if (text.length === 0 || !text.endsWith('\n') || text.endsWith('\n\n')) out.push(finding('the text must end with exactly one line break'));
  const lines = text.replace(/\n$/, '').split('\n');
  lines.forEach((line, k) => {
    const n = k + 1;
    const bad = [...new Set([...line].filter((ch) => !/[A-Za-z .,]/.test(ch)))];
    if (bad.length > 0) out.push(finding(`line ${n}: characters other than letters, spaces, periods and commas`, bad.map((c) => JSON.stringify(c)).join(' ')));
    if (line.trim() === '') out.push(finding(`line ${n}: an empty line`));
    else if (!line.endsWith('.')) out.push(finding(`line ${n}: the paragraph must end with a period`));
    if (/[.,][A-Za-z]/.test(line)) out.push(finding(`line ${n}: a period or comma without a space after it`));
    if (/^ | $| {2}/.test(line)) out.push(finding(`line ${n}: a space at the start, at the end or twice`));
  });
  const hits = new Set<string>();
  for (const word of text.toLowerCase().match(/[a-z]+/g) ?? []) {
    if (OFF_TOPIC_WORDS.has(word) || OFF_TOPIC_PREFIXES.some((p) => word.startsWith(p))) hits.add(word);
  }
  if (hits.size > 0) out.push(finding(`${hits.size} off-topic word(s) (topic guard)`, [...hits].sort().join(', ')));
  return out;
}

// ---------------------------------------------------------------------------------------------
// Where a planted error is
// ---------------------------------------------------------------------------------------------

/** A word as the plan compares it: lower case, letters and digits only ("Trees." is "trees"). */
export function bareWord(word: string): string {
  return word.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
}

/** The words of a phrase as bareWord gives them. */
export function phraseWords(phrase: string): string[] {
  return phrase.split(/\s+/).map(bareWord).filter((w) => w !== '');
}

export interface LocatedError {
  word_start: number;
  word_end: number;
  planted_sentence: string;
  original_sentence: string;
}

/** Characters of a word without the punctuation before and after it. */
function coreRange(w: PassageWord): [number, number] {
  const lead = /^[^\p{L}\p{N}]*/u.exec(w.text)?.[0].length ?? 0;
  const trail = /[^\p{L}\p{N}]*$/u.exec(w.text)?.[0].length ?? 0;
  return [w.charStart + lead, w.charEnd - trail];
}

/**
 * Finds a planted error in its passage: the one run of words in sentence `sentence_index` that
 * reads `replacement`. Returns its word numbers and the sentence before and after the change, or
 * the problems that keep it from being a planted error of this sample.
 */
export function locateError(text: string, spec: SampleErrorSpec): LocatedError | { problems: Finding[] } {
  const where = spec.error_id;
  const sentences = splitPassageSentences(text);
  const words = splitPassageWords(text);
  const problems: Finding[] = [];
  const want = phraseWords(spec.replacement);
  const right = phraseWords(spec.original_span);
  if (want.length < 1 || want.length > MAX_SPAN_WORDS) problems.push(finding(`${where}: replacement must be 1 to ${MAX_SPAN_WORDS} words`));
  if (right.length < 1 || right.length > MAX_SPAN_WORDS) problems.push(finding(`${where}: original_span must be 1 to ${MAX_SPAN_WORDS} words`));
  if (want.join(' ') === right.join(' ')) problems.push(finding(`${where}: replacement and original_span are the same words`));
  const sentence: PassageSentence | undefined = Number.isInteger(spec.sentence_index) ? sentences[spec.sentence_index] : undefined;
  if (sentence === undefined) {
    problems.push(finding(`${where}: sentence_index names no sentence of its passage`, `sentence ${spec.sentence_index}; the passage has ${sentences.length}`));
    return { problems };
  }
  if (problems.length > 0) return { problems };
  const first = sentence.firstWord;
  const last = first + sentence.wordCount - 1;
  const hits: number[] = [];
  for (let i = first; i + want.length - 1 <= last; i++) {
    if (want.every((w, k) => bareWord(words[i + k]!.text) === w)) hits.push(i);
  }
  if (hits.length !== 1) {
    return { problems: [finding(`${where}: replacement occurs ${hits.length} times in its sentence, expected once`, `sentence ${spec.sentence_index}`)] };
  }
  const word_start = hits[0]!;
  const word_end = word_start + want.length - 1;
  if (last - word_end > MAX_WORDS_AFTER_ERROR) {
    problems.push(finding(`${where}: ${last - word_end} words of its sentence follow the changed words, at most ${MAX_WORDS_AFTER_ERROR}: they close their sentence`));
  }
  const [spanStart] = coreRange(words[word_start]!);
  const [, spanEnd] = coreRange(words[word_end]!);
  const sentenceEnd = sentence.charStart + sentence.text.trimEnd().length;
  const planted_sentence = text.slice(sentence.charStart, sentenceEnd);
  const original_sentence = text.slice(sentence.charStart, spanStart) + spec.original_span.trim() + text.slice(spanEnd, sentenceEnd);
  if (problems.length > 0) return { problems };
  return { word_start, word_end, planted_sentence, original_sentence };
}

type PlacedError = Pick<SampleErrorSpec, 'sentence_index' | 'original_span'> & { word_start: number; word_end: number };

/**
 * The passage as it should read: the changed words of each planted error replaced by what is
 * right, punctuation kept. tools/sample/sample.test.ts compares it with the gate packs too.
 */
export function correctedText(text: string, errors: readonly PlacedError[]): string {
  const words = splitPassageWords(text);
  let out = text;
  for (const e of [...errors].sort((x, y) => y.word_start - x.word_start)) {
    const a = words[e.word_start];
    const b = words[e.word_end];
    if (a === undefined || b === undefined || e.word_end < e.word_start) throw new Error('a planted error lies outside its passage');
    out = out.slice(0, coreRange(a)[0]) + e.original_span.trim() + out.slice(coreRange(b)[1]);
  }
  return out;
}

/** Words of its sentence on either side of the changed words that errorFactPhrase keeps. */
export const FACT_CONTEXT_WORDS = 2;

/**
 * The fact a planted error changes, as a short phrase: the changed words with up to
 * FACT_CONTEXT_WORDS words of its sentence on either side, then what is right. gate/check-texts.ts
 * takes the same words of a gate substitution (factWords) to ask whether it repeats a published
 * example (publishedExampleFindings), so a test can ask whether a gate pack repeats a fact of the
 * sample (spec 9.2; PREREG.md §11: a demo take may come before packs B and C).
 */
export function errorFactPhrase(text: string, e: PlacedError): string {
  const words = splitPassageWords(text);
  const sentence = splitPassageSentences(text)[e.sentence_index];
  const lo = sentence?.firstWord ?? 0;
  const hi = sentence === undefined ? words.length - 1 : sentence.firstWord + sentence.wordCount - 1;
  const kept = words.slice(Math.max(lo, e.word_start - FACT_CONTEXT_WORDS), Math.min(hi, e.word_end + FACT_CONTEXT_WORDS) + 1);
  return [...kept.map((w) => bareWord(w.text)), ...phraseWords(e.original_span)].join(' ');
}

// ---------------------------------------------------------------------------------------------
// The plan
// ---------------------------------------------------------------------------------------------

/** The hand-written part of each entry of plan.json `errors`; throws on a malformed entry. */
export function readErrorSpecs(value: unknown): SampleErrorSpec[] {
  const list = isObject(value) ? value.errors : value;
  if (!Array.isArray(list)) throw new Error('plan.json: errors is not an array');
  return list.map((e: unknown, k: number): SampleErrorSpec => {
    if (!isObject(e)) throw new Error(`plan.json: error ${k} is not an object`);
    const { error_id, passage_id, class: cls, sentence_index, replacement, original_span } = e;
    if (typeof error_id !== 'string' || !/^sample-e[1-9][0-9]*$/.test(error_id)) throw new Error(`plan.json: error ${k} has no error_id like sample-e1`);
    if (!SAMPLE_PASSAGE_IDS.includes(passage_id as SamplePassageId)) throw new Error(`plan.json: ${error_id} names no sample passage`);
    if (!SAMPLE_ERROR_CLASSES.includes(cls as SampleErrorClass)) throw new Error(`plan.json: ${error_id} has class ${String(cls)}, expected one of ${SAMPLE_ERROR_CLASSES.join(', ')}`);
    if (!Number.isInteger(sentence_index) || (sentence_index as number) < 0) throw new Error(`plan.json: ${error_id} has no sentence_index`);
    if (typeof replacement !== 'string' || typeof original_span !== 'string') throw new Error(`plan.json: ${error_id} needs replacement and original_span`);
    return {
      error_id,
      passage_id: passage_id as SamplePassageId,
      class: cls as SampleErrorClass,
      sentence_index: sentence_index as number,
      replacement,
      original_span,
    };
  });
}

/** Last word of every sentence, by sentence number. */
function sentenceLastWords(text: string): number[] {
  return splitPassageSentences(text).map((s) => s.firstWord + s.wordCount - 1);
}

/**
 * The plan of the sample from its clips and the hand-written error list, with every problem the
 * rules of this module find. A plan with problems is not stored (build.ts).
 */
export function buildSamplePlan(inputs: readonly SamplePassageInput[], specs: readonly SampleErrorSpec[]): { plan: SamplePlan; problems: Finding[] } {
  const problems: Finding[] = [];
  const ids = inputs.map((p) => p.id);
  if (ids.join(',') !== SAMPLE_PASSAGE_IDS.join(',')) problems.push(finding(`the clips are ${ids.join(', ')}, expected ${SAMPLE_PASSAGE_IDS.join(', ')} in this order`));
  const passages: SamplePlanPassage[] = [];
  for (const p of inputs) {
    const target = SAMPLE_PASSAGES.find((s) => s.id === p.id);
    const words = splitPassageWords(p.text);
    const errorCount = specs.filter((e) => e.passage_id === p.id).length;
    problems.push(...prefixed(p.id, sampleTextProblems(p.text)));
    problems.push(...ttsFinding(`${p.id}: its word timings`, [...timingsProblems(p.timings), ...timingsTextProblems(p.timings, p.text)]));
    if (target !== undefined) {
      // The length of a whole clip is no time inside it: the build prints it on success too.
      if (Math.abs(p.timings.durationMs - target.targetMs) > DURATION_TOLERANCE_MS) {
        problems.push(finding(`${p.id}: the clip lasts ${p.timings.durationMs} ms, more than ${DURATION_TOLERANCE_MS} ms from its target ${target.targetMs} ms`));
      }
      if (errorCount !== target.errors) problems.push(finding(`${p.id}: ${errorCount} planted errors, expected ${target.errors}`));
    }
    passages.push({
      passage_id: p.id,
      text_file: textFileOf(p.id),
      text_sha256: p.textSha256,
      audio_file: audioFileOf(p.id),
      audio_sha256: p.audioSha256,
      duration_ms: p.timings.durationMs,
      word_count: words.length,
      sentence_count: words.length === 0 ? 0 : words[words.length - 1]!.sentenceIndex + 1,
      error_count: errorCount,
    });
  }

  const errors: SamplePlanError[] = [];
  const seenIds = new Set<string>();
  for (const spec of specs) {
    if (seenIds.has(spec.error_id)) problems.push(finding(`${spec.error_id} is listed twice`));
    seenIds.add(spec.error_id);
    const p = inputs.find((x) => x.id === spec.passage_id);
    if (p === undefined) {
      problems.push(finding(`${spec.error_id}: passage ${spec.passage_id} is not among the clips`));
      continue;
    }
    const found = locateError(p.text, spec);
    if ('problems' in found) {
      problems.push(...found.problems);
      continue;
    }
    const w = p.timings.words;
    const lastWord = sentenceLastWords(p.text)[spec.sentence_index];
    const a = w[found.word_start];
    const b = w[found.word_end];
    const s = lastWord === undefined ? undefined : w[lastWord];
    if (a === undefined || b === undefined || s === undefined) {
      problems.push(finding(`${spec.error_id}: its changed words are not in timings.json`, `words ${found.word_start} to ${found.word_end}`));
      continue;
    }
    if (a.sentenceIndex !== spec.sentence_index) {
      problems.push(finding(`${spec.error_id}: timings.json puts its first changed word in another sentence`, `word ${found.word_start} in sentence ${a.sentenceIndex}, not ${spec.sentence_index}`));
    }
    errors.push({
      ...spec,
      planted_sentence: found.planted_sentence,
      original_sentence: found.original_sentence,
      word_start: found.word_start,
      word_end: found.word_end,
      span_start_ms: a.startMs,
      span_end_ms: b.endMs,
      sentence_end_ms: s.endMs,
    });
  }

  // Placement: not in the first seconds of a passage, and apart from each other (in reading order).
  for (const id of SAMPLE_PASSAGE_IDS) {
    const mine = errors.filter((e) => e.passage_id === id).sort((x, y) => x.word_start - y.word_start);
    mine.forEach((e, k) => {
      if (e.span_start_ms < FIRST_ERROR_MS) problems.push(finding(`${e.error_id}: starts in the first ${FIRST_ERROR_MS} ms of ${id}`, `at ${e.span_start_ms} ms`));
      const prev = mine[k - 1];
      if (prev !== undefined && e.span_start_ms - prev.span_end_ms < MIN_ERROR_GAP_MS) {
        problems.push(finding(`${e.error_id}: starts less than ${MIN_ERROR_GAP_MS} ms after ${prev.error_id} ends`, `${e.span_start_ms - prev.span_end_ms} ms after it`));
      }
    });
  }
  const missing = SAMPLE_ERROR_CLASSES.filter((c) => !specs.some((e) => e.class === c));
  if (missing.length > 0) problems.push(finding(`no planted error of class ${missing.join(', ')}: vary the kind`));

  // Reading order: passages as listed, errors by passage and position.
  const order = (e: SamplePlanError): number => SAMPLE_PASSAGE_IDS.indexOf(e.passage_id) * 1e6 + e.word_start;
  errors.sort((x, y) => order(x) - order(y));
  const plan: SamplePlan = { schema: SAMPLE_PLAN_SCHEMA, licence: SAMPLE_LICENCE, note: SAMPLE_PLAN_NOTE, passages, errors };
  return { plan, problems };
}

/** plan.json as stored: two-space JSON, one line break at the end. */
export function samplePlanJson(plan: SamplePlan): string {
  return `${JSON.stringify(plan, null, 2)}\n`;
}

/**
 * Problems of a stored plan.json against the clips: the rules of buildSamplePlan, and every
 * field equal to what the texts and timings give (so the plan cannot drift from the files).
 */
export function samplePlanProblems(stored: unknown, inputs: readonly SamplePassageInput[]): Finding[] {
  let specs: SampleErrorSpec[];
  try {
    specs = readErrorSpecs(stored);
  } catch (e) {
    return [finding((e as Error).message)];
  }
  const { plan, problems } = buildSamplePlan(inputs, specs);
  if (samplePlanJson(plan) !== samplePlanJson(stored as SamplePlan)) {
    problems.push(finding('plan.json differs from the plan the texts and timings give (run tools/sample/build.ts)'));
  }
  return problems;
}
