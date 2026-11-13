// Day-1 gate packs (spec 9.2): text rules, cue rules on Kokoro's predicted word timings, and the
// build of cues.json and pack.json after the render. Run with tsx from the repository root:
//   npx tsx gate/check-texts.ts               check every pack; blind output (numbers and OK/FAIL)
//   npx tsx gate/check-texts.ts --show-text   also print cue times and the words behind each problem
//   npx tsx gate/check-texts.ts --spoken      write each pack's objections.spoken.txt (input of npm run tts)
//   npx tsx gate/check-texts.ts --build       after the render: check the real timings, then write
//                                             cues.json and pack.json of every pack without problems;
//                                             a cue hash PREREG.md already holds is never changed
//   --tolerance-ms <n>   largest gap between real and predicted word times (default 50)
//   --banned <file>, --allow <file>   word lists (default tools/words/banned.txt, allow.txt)
//   --prereg <file>      PREREG.md with the cue-list hashes (default the repository's)
// The participant does not run this before the recording; its default output names no word and no time.

import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { dirname, extname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { cueHashRows } from '../tools/freeze/prereg.ts';
import { loadList, scanText } from '../tools/lint-words.ts';
import { parseTimings, stripBom, timingsProblems, timingsTextProblems, type Timings } from '../tools/tts/timings.ts';
import { splitPassageWords } from '../tools/tts/words.ts';

export const GATE_DIR = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = resolve(GATE_DIR, '..');
/** The lint:words lists (spec 13.6): substring match without case; exact phrases are allowed. */
export const DEFAULT_BANNED_FILE = join(REPO_ROOT, 'tools', 'words', 'banned.txt');
export const DEFAULT_ALLOW_FILE = join(REPO_ROOT, 'tools', 'words', 'allow.txt');

// ---------------------------------------------------------------------------------------------
// Rules
// ---------------------------------------------------------------------------------------------

export interface CueLimitsMs {
  firstMin: number;
  intervalMin: number;
  intervalMax: number;
  lastMax: number;
  /** Reading after the last cue. */
  tailMin: number;
}

/** After the last cue the narrator reads on through the 10 s voice window (spec 9.4, 9.6). */
export const VOICE_WINDOW_MS = 10_000;

/** Spec 9.2, checked on the real render: cues from 15 s, 16-24 s apart, the last by 265 s. */
export const SPEC_CUE_LIMITS_MS: CueLimitsMs = {
  firstMin: 15_000,
  intervalMin: 16_000,
  intervalMax: 24_000,
  lastMax: 265_000,
  tailMin: VOICE_WINDOW_MS,
};

/** Room the predicted times keep inside every limit (assumption; the brief asks for slack). */
export const DESIGN_SLACK_MS = 1_500;

/** The design limits, checked on the predicted timings. */
export const DESIGN_CUE_LIMITS_MS: CueLimitsMs = {
  firstMin: SPEC_CUE_LIMITS_MS.firstMin + DESIGN_SLACK_MS,
  intervalMin: SPEC_CUE_LIMITS_MS.intervalMin + DESIGN_SLACK_MS,
  intervalMax: SPEC_CUE_LIMITS_MS.intervalMax - DESIGN_SLACK_MS,
  lastMax: SPEC_CUE_LIMITS_MS.lastMax - DESIGN_SLACK_MS,
  tailMin: SPEC_CUE_LIMITS_MS.tailMin + DESIGN_SLACK_MS,
};

/** The right phrase is not spoken this close to its substitution, in words. */
export const NEARBY_WORDS = 50;
export const MAX_SENTENCE_WORDS = 30;
/** Spec 7.8 item 4 asks 8 to 40 words of a planted sentence; the gate keeps 8 to 30. */
export const MIN_SUBSTITUTION_SENTENCE_WORDS = 8;
/** Words of context before the wrong phrase inside its sentence. */
export const MIN_CONTEXT_WORDS = 2;
/** A clean swap of one or two words. */
export const MAX_PHRASE_WORDS = 2;
/** No run of this many words appears in two different passages. */
export const SHINGLE_WORDS = 8;
/** Packs A, B and C differ in cue placement (spec 9.2): cue times, position by position... */
export const MIN_DIFFERENT_CUES = 12;
export const CUE_DIFFERENCE_MS = 2_000;
/** ...and the rhythm, so that no pack is another one shifted in time. */
export const MIN_DIFFERENT_INTERVALS = 6;
export const INTERVAL_DIFFERENCE_MS = 1_000;
/** Intervals of a full pack spread over at least this much (jitter, not a fixed spacing). */
export const MIN_INTERVAL_SPREAD_MS = 3_000;
/** In a full pack at least this many paragraphs hold two substitutions... */
export const MIN_DOUBLE_PARAGRAPHS = 2;
/** ...and at least this many paragraphs before the last substitution hold none. */
export const MIN_EMPTY_PARAGRAPHS = 2;
/** Default largest difference between real and predicted word times at the build. */
export const DEFAULT_TOLERANCE_MS = 50;

export type PackId = '0' | 'A' | 'B' | 'C';
export type PassageKind = 'listen' | 'objections';
export const PASSAGE_KINDS: readonly PassageKind[] = ['listen', 'objections'];

export interface PackSpec {
  id: PackId;
  substitutions: number;
  /** Design range of the predicted clip lengths in ms (assumption). */
  listenClipMs: readonly [number, number];
  objectionClipMs: readonly [number, number];
  /** Longest real clip: the block length of spec 9.2 (pack 0: assumption). */
  listenMaxMs: number;
  objectionMaxMs: number;
}

const FULL = { substitutions: 14, listenMaxMs: 180_000, objectionMaxMs: 300_000 } as const;

/**
 * Spec 9.2: pack 0 is the 90 s probe (30 s of listening, two cues); A, B and C have 180 s of
 * listening and 300 s of objections with 14 cues. web/scenarios/gate.ts stretches a block to a
 * longer clip, so the real clips stay within the blocks and the predicted ones keep 1.5 s of room.
 */
export const PACK_SPECS: readonly PackSpec[] = [
  { id: '0', substitutions: 2, listenClipMs: [26_000, 28_500], objectionClipMs: [46_000, 58_500], listenMaxMs: 30_000, objectionMaxMs: 60_000 },
  { id: 'A', ...FULL, listenClipMs: [170_000, 178_500], objectionClipMs: [288_000, 298_500] },
  { id: 'B', ...FULL, listenClipMs: [170_000, 178_500], objectionClipMs: [288_000, 298_500] },
  { id: 'C', ...FULL, listenClipMs: [170_000, 178_500], objectionClipMs: [288_000, 298_500] },
];

/** Packs that differ from each other in text and in cue placement (spec 9.2). */
export const FULL_PACKS: readonly PackId[] = ['A', 'B', 'C'];

/**
 * Kinds of fact a participant would recognise in a later pack (review of the first packs): the
 * changed words of one class appear in the substitutions of one pack only.
 */
export const WORD_CLASSES: Readonly<Record<string, readonly string[]>> = {
  weekday: ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday', 'weekday', 'weekdays', 'weekend', 'weekends'],
  month: ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'],
  season: ['spring', 'summer', 'autumn', 'winter', 'season', 'seasons'],
  'time of day': ['morning', 'noon', 'midday', 'afternoon', 'evening', 'night', 'midnight', 'dawn', 'dusk', 'sunrise', 'sunset'],
  direction: ['north', 'south', 'east', 'west', 'up', 'down', 'uphill', 'downhill', 'upward', 'downward', 'upstream', 'downstream'],
};

/** Words the English front end of the TTS splits in two or reads as an abbreviation. */
const SPLIT_WORDS = new Set(['cannot', 'gonna', 'gotta', 'wanna', 'lemme', 'gimme', 'dunno', 'gotcha', 'whatcha', 'whaddya', 'ain']);
const ABBREVIATIONS = new Set(['mr', 'mrs', 'ms', 'dr', 'st', 'mt', 'etc', 'eg', 'ie', 'vs', 'ok', 'am', 'pm']);

/** Topic guard (task brief): nothing about breathing, the body, health, feelings, the listener or the recording. */
const OFF_TOPIC_PREFIXES = ['breath', 'inhal', 'exhal'];
const OFF_TOPIC_WORDS = new Set([
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

const NUMBER_WORDS: Readonly<Record<string, number>> = {
  zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17,
  eighteen: 18, nineteen: 19, twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70,
  eighty: 80, ninety: 90, hundred: 100,
};

// ---------------------------------------------------------------------------------------------
// Problems: a blind message, and words or times only behind --show-text (spec 9.2, review 5)
// ---------------------------------------------------------------------------------------------

export interface Finding {
  /** Rule and numbers only: no word of a passage and no cue time. */
  message: string;
  /** Words, phrases or times; printed only with --show-text. */
  detail?: string;
}

export interface Problem extends Finding {
  /** Packs the problem concerns; the build writes nothing for them. Empty: the folder as a whole. */
  packs: PackId[];
  /** "pack A objections", "packs A and C", "gate". */
  where: string;
}

const finding = (message: string, detail?: string): Finding => (detail === undefined ? { message } : { message, detail });

export function formatProblem(p: Problem, showText: boolean): string {
  return `${p.where}: ${p.message}${showText && p.detail !== undefined ? ` [${p.detail}]` : ''}`;
}

function toProblems(packs: PackId[], where: string, findings: readonly Finding[]): Problem[] {
  return findings.map((f) => ({ ...f, packs, where }));
}

/** Messages of tools/tts name words by number and give times: kept behind --show-text. */
function ttsFindings(what: string, messages: readonly string[]): Finding[] {
  return messages.length === 0 ? [] : [finding(`${what}: ${messages.length} defect(s) found by tools/tts/timings.ts`, messages.join('; '))];
}

// ---------------------------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------------------------

/** Word span, inclusive, 0-based word indices. */
export interface Span {
  firstWordIndex: number;
  lastWordIndex: number;
}

export interface Substitution {
  /** 1-based order in the passage; cue n belongs to substitution n. */
  n: number;
  /** Spoken by the narrator. */
  wrong: string;
  /** What the sentence should say; never spoken. */
  right: string;
  /** 0-based index of the first wrong word in the spoken word list. */
  firstWordIndex: number;
  /** 0-based index of the last wrong word: the cue is the end of this word (spec 9.2). */
  lastWordIndex: number;
  sentenceIndex: number;
  paragraphIndex: number;
}

export interface Passage {
  /** Spoken words in order. Word i here is word i of the TTS timings. */
  words: string[];
  sentences: Span[];
  /** One per non-empty line: the unit tools/tts hands to Kokoro. */
  paragraphs: Span[];
  substitutions: Substitution[];
  /** Characters, markup and punctuation. */
  problems: Finding[];
}

const WORD_RE = /[A-Za-z]+/g;
const PHRASE_RE = /^[A-Za-z]+( [A-Za-z]+)*$/;
const MARKUP_RE = /\[\[([^[\]|]*)\|([^[\]|]*)\]\]/g;
const TOKEN_RE = /\[\[([^[\]|]*)\|([^[\]|]*)\]\]|[A-Za-z]+|\.|[[\]|]/g;

/** Words are runs of letters; the allowed character set makes this match any sane tokenizer. */
export function splitWords(text: string): string[] {
  return text.match(WORD_RE) ?? [];
}

/** The text the TTS speaks: markup replaced by the wrong phrase (as gate/predict_timings.py does). */
export function spokenText(markup: string): string {
  return stripBom(markup).replace(MARKUP_RE, (_all, wrong: string) => wrong.trim());
}

export function sha256Hex(data: string | Uint8Array): string {
  return createHash('sha256').update(data).digest('hex');
}

/** Parses a passage. Markup [[wrong phrase|right phrase]] is allowed only in objection passages. */
export function parsePassage(raw: string, allowMarkup: boolean): Passage {
  const text = stripBom(raw);
  const problems: Finding[] = [];
  const badChars = new Map<string, number>();
  const lines = text.split('\n');
  lines.forEach((line, k) => {
    for (const ch of line) {
      // Markup characters are reported below, once for the markup or once for a stray one.
      if (/[A-Za-z .,[\]|]/.test(ch)) continue;
      if (!badChars.has(ch)) badChars.set(ch, k + 1);
    }
  });
  for (const [ch, line] of badChars) {
    problems.push(finding(`line ${line}: a character other than letters, spaces, periods and commas`, JSON.stringify(ch)));
  }

  const words: string[] = [];
  const sentences: Span[] = [];
  const paragraphs: Span[] = [];
  const substitutions: Substitution[] = [];
  let sentenceStart = 0;
  const closeSentence = (): void => {
    if (words.length > sentenceStart) sentences.push({ firstWordIndex: sentenceStart, lastWordIndex: words.length - 1 });
    sentenceStart = words.length;
  };

  lines.forEach((line, k) => {
    const lineNo = k + 1;
    // A period or comma glued to the next word makes one TTS word of two (tools/tts/words.ts).
    if (/[.,][A-Za-z]/.test(line.replace(MARKUP_RE, (_a, w: string) => w.trim()))) {
      problems.push(finding(`line ${lineNo}: a period or comma without a space after it`));
    }
    const paragraphStart = words.length;
    let stray = false;
    for (const m of line.matchAll(TOKEN_RE)) {
      const tok = m[0];
      if (tok.startsWith('[[')) {
        const wrong = (m[1] ?? '').trim();
        const right = (m[2] ?? '').trim();
        const n = substitutions.length + 1;
        if (!allowMarkup) problems.push(finding(`line ${lineNo}: markup is not allowed in a listening passage`));
        for (const [name, phrase] of [['wrong', wrong], ['right', right]] as const) {
          const count = splitWords(phrase).length;
          if (!PHRASE_RE.test(phrase) || count < 1 || count > MAX_PHRASE_WORDS) {
            problems.push(finding(`line ${lineNo}: substitution ${n}: the ${name} phrase must be 1 to ${MAX_PHRASE_WORDS} words of letters`, phrase));
          }
        }
        const wrongWords = splitWords(wrong);
        if (wrongWords.length === 0) continue;
        const firstWordIndex = words.length;
        words.push(...wrongWords);
        substitutions.push({
          n,
          wrong,
          right,
          firstWordIndex,
          lastWordIndex: words.length - 1,
          sentenceIndex: sentences.length,
          paragraphIndex: paragraphs.length,
        });
      } else if (tok === '.') {
        closeSentence();
      } else if (/^[A-Za-z]+$/.test(tok)) {
        words.push(tok);
      } else {
        stray = true;
      }
    }
    if (stray) problems.push(finding(`line ${lineNo}: a markup character outside [[wrong|right]]`));
    if (words.length > paragraphStart) {
      paragraphs.push({ firstWordIndex: paragraphStart, lastWordIndex: words.length - 1 });
      // Every line is one Kokoro segment (tools/tts): it ends its last sentence.
      if (words.length > sentenceStart) {
        problems.push(finding(`line ${lineNo}: the paragraph must end with a period`));
        closeSentence();
      }
    }
  });
  return { words, sentences, paragraphs, substitutions, problems };
}

/**
 * Word numbering of the TTS (tools/tts/words.ts, the `index` of timings.json) against ours:
 * the same count and the same words once attached punctuation is dropped.
 */
export function wordNumberingProblems(spoken: string, words: readonly string[]): Finding[] {
  const tts = splitPassageWords(spoken).map((w) => w.text.replace(/[^A-Za-z]/g, ''));
  if (tts.length !== words.length) return [finding(`tools/tts numbers ${tts.length} words, the checker ${words.length}`)];
  const k = tts.findIndex((w, i) => w !== words[i]);
  return k < 0 ? [] : [finding(`word ${k} differs between tools/tts and the checker`, `${tts[k]} / ${words[k]}`)];
}

// ---------------------------------------------------------------------------------------------
// Word and substitution checks
// ---------------------------------------------------------------------------------------------

export function levenshtein(a: string, b: string): number {
  let prev = Array.from({ length: b.length + 1 }, (_v, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      cur.push(Math.min((prev[j] ?? 0) + 1, (cur[j - 1] ?? 0) + 1, (prev[j - 1] ?? 0) + cost));
    }
    prev = cur;
  }
  return prev[b.length] ?? 0;
}

/** Spec 7.8 audibility rule, on letters: another first sound, or normalised edit distance >= 0.5. */
export function soundsDifferent(wrong: string, right: string): boolean {
  const a = wrong.toLowerCase();
  const b = right.toLowerCase();
  if (a.charAt(0) !== b.charAt(0)) return true;
  return levenshtein(a, b) / Math.max(a.length, b.length, 1) >= 0.5;
}

/** Words of `phrase` that the other phrase does not have (lower case). */
export function changedWords(phrase: string, other: string): string[] {
  const otherSet = new Set(splitWords(other).map((w) => w.toLowerCase()));
  return splitWords(phrase)
    .map((w) => w.toLowerCase())
    .filter((w) => !otherSet.has(w));
}

/** Words both phrases share, such as "kites" in "three kites|five kites" (lower case). */
export function sharedWords(wrong: string, right: string): string[] {
  const rightSet = new Set(splitWords(right).map((w) => w.toLowerCase()));
  return splitWords(wrong)
    .map((w) => w.toLowerCase())
    .filter((w) => rightSet.has(w));
}

/** The class of WORD_CLASSES a word belongs to, if any. */
export function wordClassOf(word: string): string | undefined {
  const w = word.toLowerCase();
  return Object.keys(WORD_CLASSES).find((c) => WORD_CLASSES[c]?.includes(w));
}

/** Checks words of any passage: tokenizer safety and the topic guard. */
export function checkWords(words: readonly string[]): Finding[] {
  const out: Finding[] = [];
  const seen = new Set<string>();
  for (const w of words) {
    const lw = w.toLowerCase();
    if (seen.has(lw)) continue;
    seen.add(lw);
    if (/^[A-Z]{2,}$/.test(w)) out.push(finding('a capitalised abbreviation', w));
    if (ABBREVIATIONS.has(lw)) out.push(finding('an abbreviation', w));
    if (SPLIT_WORDS.has(lw)) out.push(finding('a word the TTS tokenizer splits', w));
    if (OFF_TOPIC_WORDS.has(lw) || OFF_TOPIC_PREFIXES.some((p) => lw.startsWith(p))) out.push(finding('a word off topic for the gate texts', w));
  }
  return out;
}

const sentenceLength = (s: Span): number => s.lastWordIndex - s.firstWordIndex + 1;

/** Checks one passage. Problems come without a pack prefix. */
export function checkPassage(p: Passage, kind: PassageKind, spec: PackSpec): Finding[] {
  const out = [...p.problems, ...checkWords(p.words)];
  p.sentences.forEach((s, i) => {
    if (sentenceLength(s) > MAX_SENTENCE_WORDS) {
      out.push(finding(`sentence ${i + 1} has ${sentenceLength(s)} words, more than ${MAX_SENTENCE_WORDS}`, p.words.slice(s.firstWordIndex, s.firstWordIndex + 5).join(' ')));
    }
  });
  const expected = kind === 'listen' ? 0 : spec.substitutions;
  if (p.substitutions.length !== expected) out.push(finding(`${p.substitutions.length} substitutions, expected ${expected}`));
  if (kind === 'objections') out.push(...checkSubstitutions(p, spec));
  return out;
}

/** Rules of each substitution, its place in the passage, and the mix of paragraphs (spec 7.8, 9.2). */
export function checkSubstitutions(p: Passage, spec: Pick<PackSpec, 'substitutions'>): Finding[] {
  const out: Finding[] = [];
  const usedSentences = new Set<number>();
  const usedChanged = new Map<string, number>();
  let sentenceFinal = 0;
  for (const s of p.substitutions) {
    const at = `substitution ${s.n}`;
    const shown = `${s.wrong} | ${s.right}`;
    const sentence = p.sentences[s.sentenceIndex];
    const paragraph = p.paragraphs[s.paragraphIndex];
    if (s.sentenceIndex === 0) out.push(finding(`${at}: in the first sentence of the passage`, shown));
    if (s.sentenceIndex === p.sentences.length - 1) out.push(finding(`${at}: in the last sentence of the passage`, shown));
    if (usedSentences.has(s.sentenceIndex)) out.push(finding(`${at}: a second substitution in one sentence`, shown));
    usedSentences.add(s.sentenceIndex);
    if (sentence !== undefined) {
      if (s.firstWordIndex - sentence.firstWordIndex < MIN_CONTEXT_WORDS) {
        out.push(finding(`${at}: fewer than ${MIN_CONTEXT_WORDS} words before it in its sentence`, shown));
      }
      if (sentenceLength(sentence) < MIN_SUBSTITUTION_SENTENCE_WORDS) {
        out.push(finding(`${at}: its sentence has fewer than ${MIN_SUBSTITUTION_SENTENCE_WORDS} words`, shown));
      }
      if (s.lastWordIndex === sentence.lastWordIndex) sentenceFinal++;
    }
    // Review 3: an error at the end of a paragraph sits in the narrator's longest pause.
    if (paragraph !== undefined && s.lastWordIndex === paragraph.lastWordIndex) {
      out.push(finding(`${at}: the last word of its paragraph`, shown));
    }
    const wrongKey = changedWords(s.wrong, s.right);
    const rightKey = changedWords(s.right, s.wrong);
    if (wrongKey.length === 0 || rightKey.length === 0) {
      out.push(finding(`${at}: the wrong and right phrases must differ by a word`, shown));
      continue;
    }
    for (const w of [...wrongKey, ...rightKey]) {
      const before = usedChanged.get(w);
      if (before !== undefined) out.push(finding(`${at}: changes a word substitution ${before} changes too`, w));
      else usedChanged.set(w, s.n);
    }
    const a = wrongKey.join(' ');
    const b = rightKey.join(' ');
    // Review 16: the blind message names the rule only; what kind of word it is stays in the detail.
    if (!soundsDifferent(a, b)) out.push(finding(`${at}: the wrong and right words sound too alike (spec 7.8)`, shown));
    if ((a.endsWith('teen') && b.endsWith('ty')) || (a.endsWith('ty') && b.endsWith('teen'))) {
      out.push(finding(`${at}: the wrong and right words sound too alike (spec 7.8)`, `teen and ty: ${shown}`));
    }
    const na = NUMBER_WORDS[a];
    const nb = NUMBER_WORDS[b];
    if (na !== undefined && nb !== undefined && Math.abs(na - nb) < 2) out.push(finding(`${at}: the change is too small to notice`, `numbers less than 2 apart: ${shown}`));
    const lo = Math.max(0, s.firstWordIndex - NEARBY_WORDS);
    const hi = Math.min(p.words.length - 1, s.lastWordIndex + NEARBY_WORDS);
    const keys = new Set(rightKey);
    for (let i = lo; i <= hi; i++) {
      if (i >= s.firstWordIndex && i <= s.lastWordIndex) continue;
      const w = (p.words[i] ?? '').toLowerCase();
      if (keys.has(w)) {
        out.push(finding(`${at}: the right word is spoken ${Math.abs(i - s.lastWordIndex)} words away, closer than ${NEARBY_WORDS}`, w));
      }
    }
  }
  const maxFinal = Math.floor(p.substitutions.length / 3);
  if (sentenceFinal > maxFinal) out.push(finding(`${sentenceFinal} substitutions end their sentence, at most ${maxFinal}`));
  if (spec.substitutions >= 14) out.push(...paragraphMixFindings(p));
  return out;
}

/** Review 3: not one error per paragraph, so a paragraph break never tells what comes. */
export function paragraphMixFindings(p: Passage): Finding[] {
  const counts = p.paragraphs.map((_s, i) => p.substitutions.filter((s) => s.paragraphIndex === i).length);
  const last = p.substitutions[p.substitutions.length - 1];
  if (last === undefined) return [];
  const doubles = counts.filter((c) => c >= 2).length;
  const empty = counts.slice(0, last.paragraphIndex).filter((c) => c === 0).length;
  const out: Finding[] = [];
  if (doubles < MIN_DOUBLE_PARAGRAPHS) out.push(finding(`${doubles} paragraphs hold two substitutions, at least ${MIN_DOUBLE_PARAGRAPHS}`));
  if (empty < MIN_EMPTY_PARAGRAPHS) out.push(finding(`${empty} paragraphs before the last substitution hold none, at least ${MIN_EMPTY_PARAGRAPHS}`));
  return out;
}

// ---------------------------------------------------------------------------------------------
// Rules across packs (spec 9.2: B and C are other texts; review 9: no recognisable frames)
// ---------------------------------------------------------------------------------------------

export interface PackPassages {
  id: PackId;
  listen?: Passage;
  objections?: Passage;
}

/** The two spoken words before the wrong phrase in its sentence, lower case. */
export function frameOf(p: Passage, s: Substitution): string {
  const start = p.sentences[s.sentenceIndex]?.firstWordIndex ?? 0;
  return p.words.slice(Math.max(start, s.firstWordIndex - 2), s.firstWordIndex).map((w) => w.toLowerCase()).join(' ');
}

function packsLabel(a: PackId, b: PackId): string {
  return a === b ? `pack ${a}` : `packs ${a} and ${b}`;
}

/** Text rules between packs: reused wrong words, reversed pairs, shared frames, word classes, shared runs of words. */
export function crossPackProblems(packs: readonly PackPassages[]): Problem[] {
  const out: Problem[] = [];
  type Seen = { pack: PackId; n: number };
  const seenOnce = (map: Map<string, Seen>, key: string, here: Seen, message: string, detail: string): void => {
    const before = map.get(key);
    if (before === undefined) map.set(key, here);
    else if (before.pack !== here.pack) {
      out.push({ packs: [before.pack, here.pack], where: packsLabel(before.pack, here.pack), message: `substitution ${before.n} of pack ${before.pack} and ${here.n} of pack ${here.pack}: ${message}`, detail });
    }
  };
  const wrongWords = new Map<string, Seen>();
  const pairs = new Map<string, Seen>();
  const kept = new Map<string, Seen>();
  const frames = new Map<string, Seen>();
  const classes = new Map<string, Seen>();
  for (const pack of packs) {
    const p = pack.objections;
    if (p === undefined) continue;
    for (const s of p.substitutions) {
      const here = { pack: pack.id, n: s.n };
      const wrong = changedWords(s.wrong, s.right);
      const right = changedWords(s.right, s.wrong);
      for (const w of wrong) seenOnce(wrongWords, w, here, 'the same wrong word', w);
      const pair = `${wrong.join(' ')}>${right.join(' ')}`;
      pairs.set(pair, pairs.get(pair) ?? here);
      const reversed = pairs.get(`${right.join(' ')}>${wrong.join(' ')}`);
      if (reversed !== undefined && reversed.pack !== pack.id) {
        out.push({ packs: [reversed.pack, pack.id], where: packsLabel(reversed.pack, pack.id), message: `substitution ${reversed.n} of pack ${reversed.pack} and ${s.n} of pack ${pack.id}: the same pair reversed`, detail: pair });
      }
      for (const w of sharedWords(s.wrong, s.right)) seenOnce(kept, w, here, 'the same unchanged word in the phrase', w);
      const frame = frameOf(p, s);
      if (frame !== '') seenOnce(frames, frame, here, 'the same two words before the wrong phrase', frame);
      // Review 16: the blind message names no class of fact; the class and the word are the detail.
      for (const w of [...wrong, ...right]) {
        const c = wordClassOf(w);
        if (c !== undefined) seenOnce(classes, c, here, 'both change a word of one class of fact', `${c}: ${w}`);
      }
    }
  }
  // Different texts: no run of SHINGLE_WORDS words in two passages.
  const seen = new Map<string, { pack: PackId; kind: PassageKind }>();
  const reported = new Set<string>();
  for (const pack of packs) {
    for (const kind of PASSAGE_KINDS) {
      const p = pack[kind];
      if (p === undefined) continue;
      const lower = p.words.map((w) => w.toLowerCase());
      for (let i = 0; i + SHINGLE_WORDS <= lower.length; i++) {
        const g = lower.slice(i, i + SHINGLE_WORDS).join(' ');
        const other = seen.get(g);
        if (other === undefined) seen.set(g, { pack: pack.id, kind });
        else if (other.pack !== pack.id || other.kind !== kind) {
          const key = `${other.pack}${other.kind}/${pack.id}${kind}`;
          if (reported.has(key)) continue;
          reported.add(key);
          out.push({ packs: [other.pack, pack.id], where: packsLabel(other.pack, pack.id), message: `the ${other.kind} passage of pack ${other.pack} and the ${kind} passage of pack ${pack.id} share a run of ${SHINGLE_WORDS} words`, detail: g });
        }
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Published examples (spec 9.2; review 11): the participant has read the spec, PREREG.md and the
// READMEs before the recording, so no planted error may repeat an example error they quote.
// ---------------------------------------------------------------------------------------------

/** The example error spec 9.2 quotes (table, row A). The spec itself is not in the repository. */
export const SPEC_EXAMPLES: readonly string[] = ['a week has nine days'];

/** A substitution that shares this many content words with a quoted example repeats it. */
export const EXAMPLE_SHARED_WORDS = 2;

/** Words that carry no fact. Numbers are content words: an example error changes one. */
const STOP_WORDS = new Set([
  'a', 'an', 'the', 'and', 'or', 'but', 'nor', 'of', 'to', 'in', 'on', 'at', 'by', 'for', 'with', 'from', 'into', 'onto', 'as',
  'is', 'are', 'was', 'were', 'be', 'been', 'being', 'am', 'has', 'have', 'had', 'do', 'does', 'did',
  'it', 'its', 'this', 'that', 'these', 'those', 'there', 'here', 'their', 'they', 'them', 'he', 'him', 'his', 'she', 'her',
  'we', 'us', 'our', 'you', 'your', 'i', 'me', 'my', 'no', 'not', 'so', 'if', 'than', 'then', 'every', 'each', 'per', 'own',
  'what', 'which', 'who', 'whom', 'whose', 'when', 'where', 'why', 'how', 'all', 'any', 'some', 'very', 'just', 'also', 'only', 'too',
]);

/** A word as the example rule compares it: lower case, a plural s dropped ("Days" and "day" match). */
export function factWord(word: string): string {
  const w = word.toLowerCase().replace(/[^a-z]/g, '');
  return w.length > 3 && w.endsWith('s') && !w.endsWith('ss') ? w.slice(0, -1) : w;
}

/** Content words of a phrase, as factWord gives them. */
export function contentWords(text: string): Set<string> {
  return new Set(splitWords(text).map(factWord).filter((w) => w.length > 1 && !STOP_WORDS.has(w)));
}

const QUOTE_RE = /"([^"\n]{1,160})"|“([^”\n]{1,160})”|«([^»\n]{1,160})»/g;

/** Prose quoted in a document ("...", curly quotes or guillemets): three words or more, letters and punctuation only. */
export function quotedExamples(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(QUOTE_RE)) {
    const q = (m[1] ?? m[2] ?? m[3] ?? '').trim();
    // File names (a period inside a word) and code are not examples.
    if (!/^[A-Za-z][A-Za-z ,.!?'’]*$/.test(q) || /\.[A-Za-z]/.test(q)) continue;
    if (splitWords(q).length >= 3) out.push(q);
  }
  return out;
}

const DOC_SKIP_DIRS = new Set(['node_modules', 'dist', 'sessions', 'results', 'data', 'test-results']);

/**
 * Documents the participant reads before the recording: the Markdown files of the repository root
 * (PREREG.md, README.md, ...), docs/*.md and every README.md down to three folders deep.
 */
export function publishedDocFiles(repoRoot: string = REPO_ROOT): string[] {
  const out: string[] = [];
  const walk = (dir: string, depth: number): void => {
    if (!existsSync(dir)) return;
    for (const name of readdirSync(dir).sort()) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) {
        if (depth < 3 && !name.startsWith('.') && !DOC_SKIP_DIRS.has(name)) walk(p, depth + 1);
      } else if (name === 'README.md' || ((depth === 0 || dir === join(repoRoot, 'docs')) && extname(name) === '.md')) out.push(p);
    }
  };
  walk(repoRoot, 0);
  return out;
}

/** The example errors of spec 9.2 and every quoted example of the given documents (missing files are skipped). */
export function publishedExamples(docFiles: readonly string[]): string[] {
  const all = [...SPEC_EXAMPLES];
  for (const file of docFiles) if (existsSync(file)) all.push(...quotedExamples(readFileSync(file, 'utf8')));
  return [...new Set(all.map((q) => q.toLowerCase()))];
}

/**
 * Content words of the fact a substitution changes: its changed words (wrong and right), the
 * unchanged words of its phrase, and the two words on either side of it in its sentence.
 */
export function factWords(p: Passage, s: Substitution): Set<string> {
  const sentence = p.sentences[s.sentenceIndex];
  const from = Math.max(sentence?.firstWordIndex ?? 0, s.firstWordIndex - 2);
  const to = Math.min(sentence?.lastWordIndex ?? p.words.length - 1, s.lastWordIndex + 2);
  return contentWords([...p.words.slice(from, to + 1), s.right].join(' '));
}

/** Review 11: no substitution shares EXAMPLE_SHARED_WORDS content words with a published example. */
export function publishedExampleFindings(p: Passage, examples: readonly string[]): Finding[] {
  const out: Finding[] = [];
  for (const s of p.substitutions) {
    const words = factWords(p, s);
    const hit = examples.find((q) => [...contentWords(q)].filter((w) => words.has(w)).length >= EXAMPLE_SHARED_WORDS);
    if (hit !== undefined) {
      out.push(finding(`substitution ${s.n}: repeats an example error quoted in the spec or a document the participant reads (spec 9.2)`, `${hit} / ${s.wrong} | ${s.right}`));
    }
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Timings and cue rules
// ---------------------------------------------------------------------------------------------

/** Cue start times: the end of the last word of each wrong phrase (spec 9.2), in ms. */
export function cueTimesMs(t: Pick<Timings, 'words'>, subs: readonly Substitution[]): number[] {
  return subs.map((s) => {
    const w = t.words[s.lastWordIndex];
    if (w === undefined) throw new Error(`no timing for word ${s.lastWordIndex}`);
    return w.endMs;
  });
}

export function intervalsMs(cuesMs: readonly number[]): number[] {
  return cuesMs.slice(1).map((t, i) => t - (cuesMs[i] ?? 0));
}

const sec = (ms: number): string => (ms / 1000).toFixed(2);

/** Cue rules of spec 9.2 under the given limits, and the reading left after the last cue. */
export function checkCueRules(cuesMs: readonly number[], passageEndMs: number, limits: CueLimitsMs): Finding[] {
  const out: Finding[] = [];
  const first = cuesMs[0];
  const last = cuesMs[cuesMs.length - 1];
  if (first === undefined || last === undefined) return [finding('no cues')];
  if (first < limits.firstMin) out.push(finding(`the first cue comes before ${sec(limits.firstMin)} s`, `${sec(first)} s`));
  intervalsMs(cuesMs).forEach((gap, i) => {
    if (gap < limits.intervalMin || gap > limits.intervalMax) {
      out.push(finding(`the interval from cue ${i + 1} to cue ${i + 2} is outside ${sec(limits.intervalMin)} to ${sec(limits.intervalMax)} s`, `${sec(gap)} s`));
    }
  });
  if (last > limits.lastMax) out.push(finding(`the last cue comes after ${sec(limits.lastMax)} s`, `${sec(last)} s`));
  if (passageEndMs - last < limits.tailMin) out.push(finding(`less than ${sec(limits.tailMin)} s of reading after the last cue`, `${sec(passageEndMs - last)} s`));
  return out;
}

/** Length of a clip against its design range (predicted) or its block (real). */
export function checkClipMs(kind: PassageKind, durationMs: number, range: readonly [number, number]): Finding[] {
  const [lo, hi] = range;
  return durationMs < lo || durationMs > hi ? [finding(`the ${kind} clip is outside ${sec(lo)} to ${sec(hi)} s`, `${sec(durationMs)} s`)] : [];
}

/** Review 3: intervals jitter instead of keeping one spacing. */
export function intervalSpreadFindings(cuesMs: readonly number[]): Finding[] {
  const gaps = intervalsMs(cuesMs);
  if (gaps.length < 2) return [];
  const spread = Math.max(...gaps) - Math.min(...gaps);
  return spread < MIN_INTERVAL_SPREAD_MS ? [finding(`the intervals spread over less than ${sec(MIN_INTERVAL_SPREAD_MS)} s`, `${sec(spread)} s`)] : [];
}

/** How many values differ by `minMs` or more, position by position. */
export function countDifferent(a: readonly number[], b: readonly number[], minMs: number): number {
  const n = Math.min(a.length, b.length);
  let count = 0;
  for (let i = 0; i < n; i++) if (Math.abs((a[i] ?? 0) - (b[i] ?? 0)) >= minMs) count++;
  return count;
}

/** Cue placement between the full packs (spec 9.2: B and C place their cues differently). */
export function placementProblems(cues: Partial<Record<PackId, readonly number[]>>, what: string): Problem[] {
  const out: Problem[] = [];
  for (let i = 0; i < FULL_PACKS.length; i++) {
    for (let j = i + 1; j < FULL_PACKS.length; j++) {
      const x = FULL_PACKS[i] as PackId;
      const y = FULL_PACKS[j] as PackId;
      const a = cues[x];
      const b = cues[y];
      if (a === undefined || b === undefined) continue;
      const where = packsLabel(x, y);
      const cueCount = countDifferent(a, b, CUE_DIFFERENCE_MS);
      if (cueCount < MIN_DIFFERENT_CUES) {
        out.push({ packs: [x, y], where, message: `${what}: ${cueCount} cue times differ by ${sec(CUE_DIFFERENCE_MS)} s or more, need ${MIN_DIFFERENT_CUES}` });
      }
      const gapCount = countDifferent(intervalsMs(a), intervalsMs(b), INTERVAL_DIFFERENCE_MS);
      if (gapCount < MIN_DIFFERENT_INTERVALS) {
        out.push({ packs: [x, y], where, message: `${what}: ${gapCount} intervals differ by ${sec(INTERVAL_DIFFERENCE_MS)} s or more, need ${MIN_DIFFERENT_INTERVALS}` });
      }
    }
  }
  return out;
}

/** gate/pack-<X>/<kind>.predicted.json, written by gate/predict_timings.py. */
export const PREDICTED_SCHEMA = 'gate-predicted/1';

export interface Predicted {
  /** SHA-256 of the spoken text the timings were computed from. */
  spokenSha256: string;
  timings: Timings;
}

export function parsePredicted(value: unknown): Predicted {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('not an object');
  const v = value as Record<string, unknown>;
  if (v.schema !== PREDICTED_SCHEMA) throw new Error(`schema is ${String(v.schema)}, expected ${PREDICTED_SCHEMA}`);
  if (typeof v.spokenSha256 !== 'string' || !/^[0-9a-f]{64}$/.test(v.spokenSha256)) throw new Error('spokenSha256 is not a SHA-256');
  return { spokenSha256: v.spokenSha256, timings: parseTimings(v.timings) };
}

/** Real against predicted word times: the render must come from the same text (review 4). */
export function timingAgreement(real: Timings, predicted: Timings, toleranceMs: number): Finding[] {
  if (real.words.length !== predicted.words.length) {
    return [finding(`the render has ${real.words.length} words, the prediction ${predicted.words.length}`)];
  }
  let off = 0;
  let largest = Math.abs(real.durationMs - predicted.durationMs);
  real.words.forEach((w, k) => {
    const p = predicted.words[k];
    if (p === undefined) return;
    const d = Math.max(Math.abs(w.startMs - p.startMs), Math.abs(w.endMs - p.endMs));
    if (d > toleranceMs) off++;
    largest = Math.max(largest, d);
  });
  const out: Finding[] = [];
  if (off > 0) out.push(finding(`${off} word times differ from the prediction by more than ${toleranceMs} ms (render from other text, or predict again on this machine)`, `largest ${largest} ms`));
  else if (Math.abs(real.durationMs - predicted.durationMs) > toleranceMs) out.push(finding(`the clip length differs from the prediction by more than ${toleranceMs} ms`));
  return out;
}

export interface PackWavInfo {
  sampleRateHz: number;
  channels: number;
  frames: number;
  /** 1 integer PCM, 3 IEEE float. */
  formatTag: number;
  bitsPerSample: number;
}

/** Sample frames of a WAV file, its rate, channels and sample format; throws when it is not a WAV file. */
export function wavInfo(bytes: Uint8Array): PackWavInfo {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const tag = (at: number): string => String.fromCharCode(...bytes.subarray(at, at + 4));
  if (bytes.length < 12 || tag(0) !== 'RIFF' || tag(8) !== 'WAVE') throw new Error('not a RIFF WAVE file');
  let at = 12;
  let fmt: { channels: number; sampleRateHz: number; blockAlign: number; formatTag: number; bitsPerSample: number } | undefined;
  while (at + 8 <= bytes.length) {
    const id = tag(at);
    const size = view.getUint32(at + 4, true);
    if (id === 'fmt ' && size >= 16) {
      fmt = {
        formatTag: view.getUint16(at + 8, true),
        channels: view.getUint16(at + 10, true),
        sampleRateHz: view.getUint32(at + 12, true),
        blockAlign: view.getUint16(at + 20, true),
        bitsPerSample: view.getUint16(at + 22, true),
      };
    } else if (id === 'data') {
      if (fmt === undefined || fmt.blockAlign === 0) throw new Error('data chunk before a fmt chunk');
      if (at + 8 + size > bytes.length) throw new Error('data chunk is cut short');
      const { sampleRateHz, channels, formatTag, bitsPerSample } = fmt;
      return { sampleRateHz, channels, frames: Math.floor(size / fmt.blockAlign), formatTag, bitsPerSample };
    }
    at += 8 + size + (size % 2);
  }
  throw new Error('no data chunk');
}

/**
 * Pack audio is stored as 16-bit PCM, as the doctor level sample (gate/level/wav16.ts): tools/tts
 * writes 32-bit float, twice the size in git. gate/render-packs.ts converts it.
 */
export const PACK_WAV_FORMAT = { formatTag: 1, bitsPerSample: 16 } as const;

// ---------------------------------------------------------------------------------------------
// Banned words (spec 13.6), with the lint:words lists and matcher
// ---------------------------------------------------------------------------------------------

const SCANNED_EXTENSIONS = new Set(['.txt', '.md', '.json', '.ts', '.py']);

/** Files of this module: everything in gate/ but gate/level/, which belongs to doctor. */
function listModuleFiles(gateDir: string): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir).sort()) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) {
        if (!(dir === gateDir && name === 'level') && name !== 'node_modules') walk(p);
      } else if (SCANNED_EXTENSIONS.has(extname(name))) out.push(p);
    }
  };
  walk(gateDir);
  return out;
}

/** Banned words in every text file of the module, as problems with file and line. */
export function bannedWordProblems(gateDir: string, banned: string[], allowed: string[]): Problem[] {
  const out: Problem[] = [];
  for (const file of listModuleFiles(gateDir)) {
    const rel = relative(gateDir, file).split(sep).join('/');
    for (const hit of scanText(readFileSync(file, 'utf8'), banned, allowed, rel)) {
      const pack = /^pack-([0ABC])\//.exec(rel)?.[1] as PackId | undefined;
      out.push({ packs: pack === undefined ? [] : [pack], where: `${hit.file}:${hit.line}`, message: 'a banned word (spec 13.6)', detail: hit.word });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Packs
// ---------------------------------------------------------------------------------------------

/** Files a built pack lists in pack.json; host serves only these (live/lib/narrator.cjs). */
export const PACK_FILES = ['cues.json', 'listen.timings.json', 'listen.wav', 'objections.timings.json', 'objections.wav'] as const;
export const PACK_SCHEMA = 'gate-pack/1';

export interface LoadedPack {
  spec: PackSpec;
  dir: string;
  raw: Partial<Record<PassageKind, string>>;
  passages: Partial<Record<PassageKind, Passage>>;
  /** Parsed predicted timings, or the reason they cannot be used. */
  predicted: Partial<Record<PassageKind, Predicted | string>>;
}

export function packDir(gateDir: string, id: PackId): string {
  return join(gateDir, `pack-${id}`);
}

function readIfExists(file: string): string | undefined {
  return existsSync(file) ? readFileSync(file, 'utf8') : undefined;
}

function readJson(file: string): unknown {
  return JSON.parse(readFileSync(file, 'utf8')) as unknown;
}

export function loadPack(gateDir: string, spec: PackSpec): LoadedPack {
  const dir = packDir(gateDir, spec.id);
  const pack: LoadedPack = { spec, dir, raw: {}, passages: {}, predicted: {} };
  for (const kind of PASSAGE_KINDS) {
    const raw = readIfExists(join(dir, `${kind}.txt`));
    if (raw === undefined) continue;
    pack.raw[kind] = raw;
    pack.passages[kind] = parsePassage(raw, kind === 'objections');
    const file = join(dir, `${kind}.predicted.json`);
    if (!existsSync(file)) {
      pack.predicted[kind] = `${kind}.predicted.json is missing (run gate/predict_timings.py)`;
      continue;
    }
    try {
      const predicted = parsePredicted(readJson(file));
      pack.predicted[kind] =
        predicted.spokenSha256 === sha256Hex(spokenText(raw)) ? predicted : `${kind}.predicted.json is out of date (run gate/predict_timings.py)`;
    } catch (e) {
      pack.predicted[kind] = `${kind}.predicted.json cannot be read: ${(e as Error).message}`;
    }
  }
  return pack;
}

const usable = (p: Predicted | string | undefined): Predicted | undefined => (typeof p === 'object' ? p : undefined);

/** Predicted cue times of a pack, when its objection passage and timings fit together. */
export function predictedCuesMs(pack: LoadedPack): number[] | undefined {
  const p = pack.passages.objections;
  const t = usable(pack.predicted.objections)?.timings;
  if (p === undefined || t === undefined || t.words.length !== p.words.length) return undefined;
  return cueTimesMs(t, p.substitutions);
}

// ---------------------------------------------------------------------------------------------
// cues.json
// ---------------------------------------------------------------------------------------------

/** cues.json as docs/protocol.md gives it: a JSON array of cue start times in ms. */
export function formatCuesJson(cuesMs: readonly number[]): string {
  return `${JSON.stringify(cuesMs)}\n`;
}

// ---------------------------------------------------------------------------------------------
// pack.json (review 4): the served files with their SHA-256, and the spoken texts of the render
// ---------------------------------------------------------------------------------------------

export interface PackJson {
  schema: typeof PACK_SCHEMA;
  pack: PackId;
  note: string;
  /** Read by host (live/lib/narrator.cjs packListing): a name as key, {sha256} as value. */
  files: Record<(typeof PACK_FILES)[number], { sha256: string }>;
  /** SHA-256 of the text each clip was rendered from (the markup replaced by the wrong phrase). */
  spoken: Record<PassageKind, { sha256: string }>;
}

export function formatPackJson(pj: PackJson): string {
  return `${JSON.stringify(pj, null, 2)}\n`;
}

/** Checks pack.json and the files it lists against the folder and the current texts. */
export function verifyPackJson(pack: LoadedPack): Finding[] {
  const file = join(pack.dir, 'pack.json');
  if (!existsSync(file)) {
    return existsSync(join(pack.dir, 'cues.json')) ? [finding('cues.json exists without pack.json (run --build)')] : [];
  }
  let pj: Partial<PackJson>;
  try {
    pj = readJson(file) as Partial<PackJson>;
  } catch {
    return [finding('pack.json is not JSON')];
  }
  const out: Finding[] = [];
  if (pj.schema !== PACK_SCHEMA || pj.pack !== pack.spec.id) out.push(finding(`pack.json is not a ${PACK_SCHEMA} file of this pack`));
  for (const name of PACK_FILES) {
    const listed = pj.files?.[name]?.sha256;
    const path = join(pack.dir, name);
    if (typeof listed !== 'string') out.push(finding(`pack.json does not list ${name} with a SHA-256`));
    else if (!existsSync(path)) out.push(finding(`${name} is missing`));
    else if (sha256Hex(readFileSync(path)) !== listed) out.push(finding(`${name} does not match its SHA-256 in pack.json (run --build)`));
  }
  for (const kind of PASSAGE_KINDS) {
    const raw = pack.raw[kind];
    if (raw !== undefined && pj.spoken?.[kind]?.sha256 !== sha256Hex(spokenText(raw))) {
      out.push(finding(`the ${kind} text changed after the build: render it again, then run --build`));
    }
  }
  const timingsFile = join(pack.dir, 'objections.timings.json');
  const p = pack.passages.objections;
  if (p !== undefined && existsSync(timingsFile) && existsSync(join(pack.dir, 'cues.json'))) {
    try {
      const t = parseTimings(readJson(timingsFile));
      if (t.words.length !== p.words.length || readFileSync(join(pack.dir, 'cues.json'), 'utf8') !== formatCuesJson(cueTimesMs(t, p.substitutions))) {
        out.push(finding('cues.json does not follow from objections.timings.json and the text (run --build)'));
      }
    } catch (e) {
      out.push(finding('objections.timings.json cannot be read', (e as Error).message));
    }
  }
  return out;
}

/** objections.spoken.txt, when present, is the spoken text of objections.txt. */
function spokenFileFindings(pack: LoadedPack): Finding[] {
  const spoken = readIfExists(join(pack.dir, 'objections.spoken.txt'));
  const raw = pack.raw.objections;
  if (spoken === undefined || raw === undefined) return [];
  return spoken === spokenText(raw) ? [] : [finding('objections.spoken.txt is out of date (run --spoken)')];
}

// ---------------------------------------------------------------------------------------------
// The whole gate folder
// ---------------------------------------------------------------------------------------------

export interface GateOptions {
  gateDir?: string;
  bannedFile?: string;
  allowFile?: string;
  /** Check pack.json, cues.json and objections.spoken.txt against the texts (default true). */
  verifyBuild?: boolean;
  /** Documents whose quoted example errors no substitution may repeat (default publishedDocFiles()). */
  publishedDocs?: readonly string[];
  /** PREREG.md whose cue-list hashes cues.json must keep once filled in (default DEFAULT_PREREG_FILE). */
  preregFile?: string;
}

export interface GateReport {
  packs: LoadedPack[];
  problems: Problem[];
  /** Predicted cue times by pack, where they can be computed. */
  predictedCues: Partial<Record<PackId, number[]>>;
}

/**
 * Files a pack folder may hold: the texts, their predicted timings, the render input and the build.
 * No other file: in particular no second, readable copy of the cue list (spec 9.2, review 4).
 */
export const PACK_FOLDER_FILES: readonly string[] = [
  'listen.txt',
  'objections.txt',
  'listen.predicted.json',
  'objections.predicted.json',
  'objections.spoken.txt',
  'pack.json',
  ...PACK_FILES,
];

/** Files in a pack folder that do not belong there (dot files, as an OS leaves them, are ignored). */
export function strayFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => !name.startsWith('.') && !PACK_FOLDER_FILES.includes(name))
    .sort();
}

/** Checks one pack: its folder, its texts and its predicted timings. */
export function checkPack(pack: LoadedPack): Problem[] {
  const id = pack.spec.id;
  const out: Problem[] = [];
  for (const kind of PASSAGE_KINDS) {
    const where = `pack ${id} ${kind}`;
    const p = pack.passages[kind];
    const raw = pack.raw[kind];
    if (p === undefined || raw === undefined) {
      out.push({ packs: [id], where, message: `${kind}.txt is missing` });
      continue;
    }
    out.push(...toProblems([id], where, checkPassage(p, kind, pack.spec)));
    out.push(...toProblems([id], where, wordNumberingProblems(spokenText(raw), p.words)));
    const predicted = pack.predicted[kind];
    if (typeof predicted !== 'object') {
      out.push({ packs: [id], where, message: predicted ?? `${kind}.predicted.json is missing` });
      continue;
    }
    const t = predicted.timings;
    const tts = [...timingsProblems(t), ...timingsTextProblems(t, spokenText(raw))];
    out.push(...toProblems([id], where, ttsFindings('predicted timings', tts)));
    if (tts.length > 0 || t.words.length !== p.words.length) continue;
    out.push(...toProblems([id], where, checkClipMs(kind, t.durationMs, kind === 'listen' ? pack.spec.listenClipMs : pack.spec.objectionClipMs)));
    if (kind === 'objections') {
      const cues = cueTimesMs(t, p.substitutions);
      const endMs = t.words[t.words.length - 1]?.endMs ?? 0;
      out.push(...toProblems([id], `pack ${id} cues`, checkCueRules(cues, endMs, DESIGN_CUE_LIMITS_MS)));
      if (FULL_PACKS.includes(id)) out.push(...toProblems([id], `pack ${id} cues`, intervalSpreadFindings(cues)));
    }
  }
  for (const name of strayFiles(pack.dir)) {
    out.push({ packs: [id], where: `pack ${id}`, message: `${name} does not belong in the pack folder: remove it` });
  }
  return out;
}

/** Checks every pack, the rules across packs, the build outputs and the banned words. */
export function checkGate(options: GateOptions = {}): GateReport {
  const gateDir = options.gateDir ?? GATE_DIR;
  const packs = PACK_SPECS.map((spec) => loadPack(gateDir, spec));
  const problems: Problem[] = [];
  const predictedCues: Partial<Record<PackId, number[]>> = {};
  const examples = publishedExamples(options.publishedDocs ?? publishedDocFiles());
  const prereg = options.verifyBuild !== false ? preregCueHashes(options.preregFile ?? DEFAULT_PREREG_FILE) : {};
  for (const pack of packs) {
    problems.push(...checkPack(pack));
    const objections = pack.passages.objections;
    if (objections !== undefined) {
      problems.push(...toProblems([pack.spec.id], `pack ${pack.spec.id} objections`, publishedExampleFindings(objections, examples)));
    }
    const cues = predictedCuesMs(pack);
    if (cues !== undefined) predictedCues[pack.spec.id] = cues;
    if (options.verifyBuild !== false) {
      const id = pack.spec.id;
      const cuesText = readIfExists(join(pack.dir, 'cues.json'));
      const bound = cuesText === undefined ? [] : preregCueFindings(cuesText, prereg[id], 'cues.json');
      problems.push(...toProblems([id], `pack ${id} build`, [...verifyPackJson(pack), ...spokenFileFindings(pack), ...bound]));
    }
  }
  problems.push(...crossPackProblems(packs.map((p) => ({ id: p.spec.id, ...p.passages }))));
  problems.push(...placementProblems(predictedCues, 'predicted'));

  const bannedFile = options.bannedFile ?? DEFAULT_BANNED_FILE;
  const allowFile = options.allowFile ?? DEFAULT_ALLOW_FILE;
  if (!existsSync(bannedFile)) {
    problems.push({ packs: [], where: 'gate', message: 'the banned word list was not found (spec 13.6)', detail: bannedFile });
  } else {
    const banned = loadList(bannedFile);
    if (banned.length === 0) problems.push({ packs: [], where: 'gate', message: 'the banned word list is empty', detail: bannedFile });
    const allowed = existsSync(allowFile) ? loadList(allowFile) : [];
    problems.push(...bannedWordProblems(gateDir, banned, allowed));
  }
  return { packs, problems, predictedCues };
}

/** Writes objections.spoken.txt of every pack: the text npm run tts renders. */
export function writeSpokenTexts(gateDir: string = GATE_DIR): string[] {
  const written: string[] = [];
  for (const spec of PACK_SPECS) {
    const dir = packDir(gateDir, spec.id);
    const raw = readIfExists(join(dir, 'objections.txt'));
    if (raw === undefined) continue;
    writeFileSync(join(dir, 'objections.spoken.txt'), spokenText(raw));
    written.push(join(dir, 'objections.spoken.txt'));
  }
  return written;
}

// ---------------------------------------------------------------------------------------------
// Build: real timings, cues.json and pack.json (spec 9.2, review 4 and 7)
// ---------------------------------------------------------------------------------------------

export interface BuildOutcome {
  pack: PackId;
  /** Not rendered yet: listen or objection timings are missing. */
  rendered: boolean;
  built: boolean;
  /** SHA-256 of cues.json: the value of {{CUES_SHA256_<X>}} in PREREG.md. */
  cuesSha256?: string;
  packJsonSha256?: string;
}

export interface BuildReport {
  outcomes: BuildOutcome[];
  problems: Problem[];
}

interface RealPack {
  pack: LoadedPack;
  timings: Partial<Record<PassageKind, Timings>>;
  cuesMs?: number[];
  problems: Problem[];
}

function writeAtomic(file: string, data: string): void {
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, data);
  renameSync(tmp, file);
}

/**
 * Real timings of one pack against the text, the prediction, the WAV files and spec 9.2. The render
 * (both timings files and both WAV files) is read from `renderDir`: the pack folder, or the folder
 * where gate/render-packs.ts keeps a new render until it passes (review 12).
 */
function checkRealPack(pack: LoadedPack, toleranceMs: number, renderDir: string = pack.dir): RealPack {
  const id = pack.spec.id;
  const real: RealPack = { pack, timings: {}, problems: [] };
  for (const kind of PASSAGE_KINDS) {
    const where = `pack ${id} ${kind} render`;
    const add = (findings: Finding[]): void => {
      real.problems.push(...toProblems([id], where, findings));
    };
    const raw = pack.raw[kind];
    const p = pack.passages[kind];
    const predicted = usable(pack.predicted[kind]);
    if (raw === undefined || p === undefined) continue;
    let t: Timings;
    try {
      t = parseTimings(readJson(join(renderDir, `${kind}.timings.json`)));
    } catch (e) {
      add([finding(`${kind}.timings.json cannot be read`, (e as Error).message)]);
      continue;
    }
    const tts = [...timingsProblems(t), ...timingsTextProblems(t, spokenText(raw))];
    add(ttsFindings('real timings', tts));
    if (tts.length > 0 || t.words.length !== p.words.length) {
      if (tts.length === 0) add([finding(`the render has ${t.words.length} words, the text ${p.words.length}`)]);
      continue;
    }
    real.timings[kind] = t;
    if (predicted === undefined) add([finding('no usable predicted timings to compare with (run gate/predict_timings.py)')]);
    else add(timingAgreement(t, predicted.timings, toleranceMs));
    try {
      const wav = wavInfo(readFileSync(join(renderDir, `${kind}.wav`)));
      if (wav.sampleRateHz !== t.sampleRateHz || wav.channels !== 1 || wav.frames !== t.durationSamples) {
        add([finding(`${kind}.wav does not match ${kind}.timings.json (rate, channels or length)`)]);
      }
      if (wav.formatTag !== PACK_WAV_FORMAT.formatTag || wav.bitsPerSample !== PACK_WAV_FORMAT.bitsPerSample) {
        add([finding(`${kind}.wav is not 16-bit PCM (store it with npx tsx gate/render-packs.ts --convert)`)]);
      }
    } catch (e) {
      add([finding(`${kind}.wav cannot be read`, (e as Error).message)]);
    }
    add(checkClipMs(kind, t.durationMs, [0, kind === 'listen' ? pack.spec.listenMaxMs : pack.spec.objectionMaxMs]));
    if (kind === 'objections') {
      const cues = cueTimesMs(t, p.substitutions);
      real.cuesMs = cues;
      const endMs = t.words[t.words.length - 1]?.endMs ?? 0;
      real.problems.push(...toProblems([id], `pack ${id} real cues`, checkCueRules(cues, endMs, SPEC_CUE_LIMITS_MS)));
    }
  }
  return real;
}

/** PREREG.md of the repository: its cue-list hash table binds every later build (spec 9.2, 13.6). */
export const DEFAULT_PREREG_FILE = join(REPO_ROOT, 'PREREG.md');

/**
 * SHA-256 values PREREG.md already holds for each pack's cues.json, read as tools/freeze reads the
 * cue-list hash table. A row that still holds its {{CUES_SHA256_X}} placeholder binds nothing.
 */
export function preregCueHashes(preregFile: string = DEFAULT_PREREG_FILE): Partial<Record<PackId, string[]>> {
  const out: Partial<Record<PackId, string[]>> = {};
  if (!existsSync(preregFile)) return out;
  for (const row of cueHashRows(readFileSync(preregFile, 'utf8')).rows) {
    const id = row.pack.toUpperCase() as PackId;
    if (!PACK_SPECS.some((s) => s.id === id) || row.hashes.length === 0) continue;
    out[id] = [...(out[id] ?? []), ...row.hashes];
  }
  return out;
}

export interface RealCheckOptions extends GateOptions {
  toleranceMs?: number;
}

/** A cues.json whose bytes PREREG.md does not allow, once its row holds a hash (spec 9.2, 13.6). */
export function preregCueFindings(cuesText: string, bound: readonly string[] | undefined, what: string): Finding[] {
  if (bound === undefined || bound.includes(sha256Hex(cuesText))) return [];
  return [finding(`${what} differs from the SHA-256 that PREREG.md holds for it: after the gate-prereg tag cues.json stays byte for byte the same (spec 9.2, 13.6)`)];
}

export interface RealCheck {
  report: GateReport;
  /** Packs whose render was found: both timings files. */
  rendered: PackId[];
  /** The cues.json each rendered pack would get, when its timings give one. */
  cuesJson: Partial<Record<PackId, string>>;
  /** Text rules, real timings, real placement and PREREG.md: everything that blocks a build. */
  problems: Problem[];
}

/**
 * The checks of --build, without writing anything: texts and predictions, every rendered pack's real
 * timings and WAV files, real placement, and the cue hashes PREREG.md holds. `renderDirs` reads a
 * pack's render from another folder (gate/render-packs.ts checks a new render there before it
 * installs it; review 12).
 */
export function checkRealPacks(options: RealCheckOptions & { renderDirs?: Partial<Record<PackId, string>> } = {}): RealCheck {
  const gateDir = options.gateDir ?? GATE_DIR;
  const report = checkGate({ ...options, gateDir, verifyBuild: false });
  const toleranceMs = options.toleranceMs ?? DEFAULT_TOLERANCE_MS;
  const problems = [...report.problems];
  const reals: RealPack[] = [];
  for (const pack of report.packs) {
    const dir = options.renderDirs?.[pack.spec.id] ?? pack.dir;
    const rendered = PASSAGE_KINDS.every((k) => existsSync(join(dir, `${k}.timings.json`)));
    if (rendered) reals.push(checkRealPack(pack, toleranceMs, dir));
  }
  for (const r of reals) problems.push(...r.problems);
  const realCues: Partial<Record<PackId, number[]>> = {};
  for (const r of reals) if (r.cuesMs !== undefined) realCues[r.pack.spec.id] = r.cuesMs;
  problems.push(...placementProblems(realCues, 'real'));

  // Spec 9.2 and 13.6: once PREREG.md holds a pack's cue hash, a rebuild keeps cues.json byte for byte.
  const prereg = preregCueHashes(options.preregFile ?? DEFAULT_PREREG_FILE);
  const cuesJson: Partial<Record<PackId, string>> = {};
  for (const [id, cues] of Object.entries(realCues) as [PackId, number[]][]) {
    const text = formatCuesJson(cues);
    cuesJson[id] = text;
    problems.push(...toProblems([id], `pack ${id} build`, preregCueFindings(text, prereg[id], 'the new cues.json')));
  }
  return { report, rendered: reals.map((r) => r.pack.spec.id), cuesJson, problems };
}

/**
 * After the render: checks every rendered pack and writes cues.json and pack.json only for packs
 * without any problem, text rules included (review 7). Packs not rendered yet are skipped.
 */
export function buildPacks(options: RealCheckOptions = {}): BuildReport {
  const { report, rendered, cuesJson, problems } = checkRealPacks({ ...options, renderDirs: {} });
  const outcomes: BuildOutcome[] = report.packs.map((pack) => {
    const id = pack.spec.id;
    if (!rendered.includes(id)) return { pack: id, rendered: false, built: false };
    const blocked = problems.some((p) => p.packs.length === 0 || p.packs.includes(id));
    const listenRaw = pack.raw.listen;
    const objectionsRaw = pack.raw.objections;
    const cuesText = cuesJson[id];
    if (blocked || cuesText === undefined || listenRaw === undefined || objectionsRaw === undefined) return { pack: id, rendered: true, built: false };
    writeAtomic(join(pack.dir, 'cues.json'), cuesText);
    const files = Object.fromEntries(PACK_FILES.map((name) => [name, { sha256: sha256Hex(readFileSync(join(pack.dir, name))) }])) as PackJson['files'];
    const pj: PackJson = {
      schema: PACK_SCHEMA,
      pack: id,
      note: 'Built by gate/check-texts.ts --build after the render. Host serves only the files listed here, with these SHA-256.',
      files,
      spoken: { listen: { sha256: sha256Hex(spokenText(listenRaw)) }, objections: { sha256: sha256Hex(spokenText(objectionsRaw)) } },
    };
    const packJsonText = formatPackJson(pj);
    writeAtomic(join(pack.dir, 'pack.json'), packJsonText);
    return { pack: id, rendered: true, built: true, cuesSha256: sha256Hex(cuesText), packJsonSha256: sha256Hex(packJsonText) };
  });
  return { outcomes, problems };
}

// ---------------------------------------------------------------------------------------------
// Command line
// ---------------------------------------------------------------------------------------------

/** Cue times and clip lengths: printed only with --show-text. */
function textSummary(report: GateReport): string[] {
  const lines: string[] = [];
  for (const pack of report.packs) {
    const listen = usable(pack.predicted.listen)?.timings;
    const objections = usable(pack.predicted.objections)?.timings;
    const cues = report.predictedCues[pack.spec.id];
    lines.push(`pack ${pack.spec.id}: listen clip ${listen ? sec(listen.durationMs) : '?'} s, objection clip ${objections ? sec(objections.durationMs) : '?'} s (predicted)`);
    if (cues !== undefined) {
      lines.push(`  cues (s): ${cues.map(sec).join(' ')}`);
      lines.push(`  intervals (s): ${intervalsMs(cues).map(sec).join(' ')}`);
    }
    for (const s of pack.passages.objections?.substitutions ?? []) lines.push(`  ${s.n}. ${s.wrong} | ${s.right}`);
  }
  return lines;
}

const USAGE = 'usage: npx tsx gate/check-texts.ts [--show-text] [--spoken] [--build] [--tolerance-ms <n>] [--banned <file>] [--allow <file>] [--prereg <file>]';

export function main(
  argv: readonly string[],
  out: (line: string) => void = console.log,
  err: (line: string) => void = console.error,
  gateDir: string = GATE_DIR,
): number {
  let showText = false;
  let spoken = false;
  let build = false;
  let toleranceMs = DEFAULT_TOLERANCE_MS;
  const options: GateOptions = { gateDir };
  // A flag that takes a value refuses a missing one or another flag in its place (review 10).
  const valueOf = (i: number): string | undefined => {
    const v = argv[i];
    return v === undefined || v.startsWith('--') ? undefined : v;
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--show-text') showText = true;
    else if (arg === '--spoken') spoken = true;
    else if (arg === '--build') build = true;
    else if (arg === '--banned' || arg === '--allow' || arg === '--prereg') {
      const v = valueOf(++i);
      if (v === undefined) {
        err(`${arg} needs a file`);
        return 2;
      }
      if (arg === '--banned') options.bannedFile = resolve(v);
      else if (arg === '--allow') options.allowFile = resolve(v);
      else options.preregFile = resolve(v);
    } else if (arg === '--tolerance-ms') {
      const v = valueOf(++i);
      const n = Number(v);
      if (v === undefined || !Number.isInteger(n) || n < 0) {
        err('--tolerance-ms needs a whole number of ms');
        return 2;
      }
      toleranceMs = n;
    } else {
      err(`unknown argument: ${String(arg)}\n${USAGE}`);
      return 2;
    }
  }
  if (spoken) for (const file of writeSpokenTexts(gateDir)) out(`wrote ${relative(REPO_ROOT, file)}`);

  if (build) {
    const result = buildPacks({ ...options, toleranceMs });
    for (const o of result.outcomes) {
      if (!o.rendered) out(`pack ${o.pack}: not rendered yet`);
      else if (!o.built) out(`pack ${o.pack}: NOT BUILT`);
      else out(`pack ${o.pack}: built; cues.json SHA-256 ${o.cuesSha256 ?? ''}`);
    }
    for (const p of result.problems) out(`- ${formatProblem(p, showText)}`);
    return result.outcomes.every((o) => o.built) && result.problems.length === 0 ? 0 : 1;
  }

  const report = checkGate(options);
  if (showText) for (const line of textSummary(report)) out(line);
  for (const pack of report.packs) {
    const id = pack.spec.id;
    const mine = report.problems.filter((p) => p.packs.includes(id)).length;
    out(`pack ${id}: ${mine === 0 ? 'OK' : `FAIL (${mine} problem(s))`}, ${pack.passages.objections?.substitutions.length ?? 0} substitutions`);
  }
  if (report.problems.length > 0) {
    out(`${report.problems.length} problem(s):`);
    for (const p of report.problems) out(`- ${formatProblem(p, showText)}`);
    return 1;
  }
  out(`OK: ${report.packs.length} packs pass every rule.`);
  return 0;
}

const invoked = process.argv[1];
if (invoked !== undefined && pathToFileURL(resolve(invoked)).href === import.meta.url) {
  process.exitCode = main(process.argv.slice(2));
}
