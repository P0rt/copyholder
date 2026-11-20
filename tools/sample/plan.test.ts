// tools/sample/plan.ts on synthetic clips (tools/sample/synthetic.ts): where a planted error is, the
// rules of the sample (task brief; spec 7.11, 15.1), a stored plan that drifts from its files, and
// blind problems: rules, ids and counts in the message, words and times only in the detail.
import { describe, expect, it } from 'vitest';
import type { Finding } from '../../gate/check-texts.ts';
import {
  DURATION_TOLERANCE_MS,
  FACT_CONTEXT_WORDS,
  FIRST_ERROR_MS,
  MIN_ERROR_GAP_MS,
  SAMPLE_PASSAGE_IDS,
  bareWord,
  buildSamplePlan,
  correctedText,
  errorFactPhrase,
  formatFinding,
  locateError,
  phraseWords,
  readErrorSpecs,
  samplePlanJson,
  samplePlanProblems,
  sampleTextProblems,
  type SampleErrorSpec,
  type SamplePassageInput,
} from './plan.ts';
import { pacedTimings, passageText, sentence, syntheticSample, wordStartMs, type SyntheticSample } from './synthetic.ts';

const HASH = 'ab'.repeat(32);

function inputsOf(s: SyntheticSample): SamplePassageInput[] {
  return SAMPLE_PASSAGE_IDS.map((id) => ({ id, text: s.texts[id], textSha256: HASH, audioSha256: HASH, timings: pacedTimings(s.texts[id]) }));
}

const spec = (over: Partial<SampleErrorSpec>): SampleErrorSpec => ({
  error_id: 'sample-e9', passage_id: 'p1', class: 'number', sentence_index: 0, replacement: 'beta', original_span: 'alpha', ...over,
});

const messages = (fs: readonly Finding[]): string[] => fs.map((f) => f.message);

describe('locateError', () => {
  const text = 'One two three, four five beta. Six seven gamma delta eight.\nNine ten eleven beta, twelve.\n';

  it('finds the changed words in their sentence and writes both versions of the sentence', () => {
    expect(locateError(text, spec({ sentence_index: 0 }))).toEqual({
      word_start: 5,
      word_end: 5,
      planted_sentence: 'One two three, four five beta.',
      original_sentence: 'One two three, four five alpha.',
    });
    expect(locateError(text, spec({ sentence_index: 1, replacement: 'gamma delta', original_span: 'kappa' }))).toEqual({
      word_start: 8,
      word_end: 9,
      planted_sentence: 'Six seven gamma delta eight.',
      original_sentence: 'Six seven kappa eight.',
    });
    // the comma after the changed word stays; the sentence ends at its line break
    expect(locateError(text, spec({ sentence_index: 2 }))).toMatchObject({ word_start: 14, word_end: 14, original_sentence: 'Nine ten eleven alpha, twelve.' });
  });

  it('refuses a change that is missing, repeated, too far from the end of its sentence or too long', () => {
    const problems = (s: SampleErrorSpec): Finding[] => {
      const r = locateError(text, s);
      return 'problems' in r ? r.problems : [];
    };
    expect(problems(spec({ replacement: 'omega' }))).toEqual([{ message: 'sample-e9: replacement occurs 0 times in its sentence, expected once', detail: 'sentence 0' }]);
    expect(problems(spec({ replacement: 'one', sentence_index: 0 }))).toEqual([
      { message: 'sample-e9: 5 words of its sentence follow the changed words, at most 1: they close their sentence' },
    ]);
    expect(problems(spec({ sentence_index: 3 }))).toEqual([{ message: 'sample-e9: sentence_index names no sentence of its passage', detail: 'sentence 3; the passage has 3' }]);
    expect(messages(problems(spec({ replacement: 'three four five beta' })))).toEqual(['sample-e9: replacement must be 1 to 3 words']);
    expect(messages(problems(spec({ original_span: 'Beta.' })))).toEqual(['sample-e9: replacement and original_span are the same words']);
    const twice = 'Beta and then beta.\n';
    expect('problems' in locateError(twice, spec({ replacement: 'beta' }))).toBe(true);
  });

  it('compares words without case and punctuation', () => {
    expect(bareWord('Trees.')).toBe('trees');
    expect(phraseWords('  on  Trees, ')).toEqual(['on', 'trees']);
  });
});

describe('correctedText and errorFactPhrase', () => {
  const text = 'One two three, four five beta. Six seven gamma delta eight.\nNine ten eleven beta, twelve.\n';

  it('puts what is right in place of each planted error, punctuation and line breaks kept', () => {
    const errors = [
      { sentence_index: 0, word_start: 5, word_end: 5, original_span: 'alpha' },
      { sentence_index: 2, word_start: 14, word_end: 14, original_span: ' iota kappa ' },
      { sentence_index: 1, word_start: 8, word_end: 9, original_span: 'mu' },
    ];
    expect(correctedText(text, errors)).toBe('One two three, four five alpha. Six seven mu eight.\nNine ten eleven iota kappa, twelve.\n');
    expect(correctedText(text, [])).toBe(text);
    expect(() => correctedText(text, [{ sentence_index: 2, word_start: 15, word_end: 16, original_span: 'x' }])).toThrow(/outside its passage/);
  });

  it(`keeps the changed words, ${FACT_CONTEXT_WORDS} words of their sentence on either side and what is right`, () => {
    // inside its sentence: "four five" before, nothing after "beta." at the end of the sentence
    expect(errorFactPhrase(text, { sentence_index: 0, word_start: 5, word_end: 5, original_span: 'Alpha' })).toBe('four five beta alpha');
    // "six seven" before, "eight" after, and never a word of the next sentence
    expect(errorFactPhrase(text, { sentence_index: 1, word_start: 8, word_end: 9, original_span: 'kappa' })).toBe('six seven gamma delta eight kappa');
    // the sentence starts on a new line: nothing of the line before
    expect(errorFactPhrase(text, { sentence_index: 2, word_start: 11, word_end: 11, original_span: 'nil' })).toBe('nine ten eleven nil');
  });
});

describe('buildSamplePlan', () => {
  it('places every planted error by word numbers and times of timings.json', () => {
    const s = syntheticSample();
    const { plan, problems } = buildSamplePlan(inputsOf(s), s.specs);
    expect(problems).toEqual([]);
    expect(plan.passages.map((p) => [p.passage_id, p.error_count, p.word_count, p.sentence_count])).toEqual([
      ['opening', 0, 200, 20],
      ['p1', 3, 180, 18],
      ['p2', 2, 150, 15],
    ]);
    expect(plan.passages[1]).toMatchObject({ text_file: 'texts/p1.txt', audio_file: 'p1.wav', duration_ms: 54_600, audio_sha256: HASH });
    expect(plan.errors.map((e) => [e.error_id, e.word_start, e.word_end, e.span_start_ms, e.span_end_ms, e.sentence_end_ms])).toEqual([
      ['sample-e1', 39, 39, wordStartMs(39), wordStartMs(40), wordStartMs(40)],
      ['sample-e2', 88, 89, wordStartMs(88), wordStartMs(90), wordStartMs(90)],
      ['sample-e3', 136, 138, wordStartMs(136), wordStartMs(139), wordStartMs(140)],
      ['sample-e4', 39, 39, wordStartMs(39), wordStartMs(40), wordStartMs(40)],
      ['sample-e5', 99, 99, wordStartMs(99), wordStartMs(100), wordStartMs(100)],
    ]);
    expect(plan.errors[2]).toMatchObject({ planted_sentence: sentence(['did', 'not', 'go', 'home']), original_sentence: 'Plain words fill this line of went home.' });
    // the corrected passage holds each original_sentence in place of its planted_sentence
    const p1 = plan.errors.filter((e) => e.passage_id === 'p1');
    let expected = s.texts.p1;
    for (const e of p1) expected = expected.replace(e.planted_sentence, e.original_sentence);
    expect(correctedText(s.texts.p1, p1)).toBe(expected);
    // a stored plan that is the built one has no problem, also after a JSON round trip
    expect(samplePlanProblems(JSON.parse(samplePlanJson(plan)), inputsOf(s))).toEqual([]);
  });

  it('lists errors in reading order whatever order the hand-written list has', () => {
    const s = syntheticSample();
    const { plan } = buildSamplePlan(inputsOf(s), [...s.specs].reverse());
    expect(plan.errors.map((e) => e.error_id)).toEqual(['sample-e1', 'sample-e2', 'sample-e3', 'sample-e4', 'sample-e5']);
  });

  it(`refuses an error in the first ${FIRST_ERROR_MS} ms or within ${MIN_ERROR_GAP_MS} ms of the one before, with the times as the detail`, () => {
    const s = syntheticSample();
    const p1 = Array.from({ length: 18 }, () => sentence());
    p1[1] = sentence(['beta']); // word 19, 6.0 s
    p1[4] = sentence(['gamma', 'delta']); // words 48-49, 14.7 s: 8.4 s after the first
    p1[13] = sentence(['did', 'not', 'go', 'home']);
    s.texts.p1 = passageText(p1);
    const specs = s.specs.map((e) => (e.error_id === 'sample-e1' ? { ...e, sentence_index: 1 } : e.error_id === 'sample-e2' ? { ...e, sentence_index: 4 } : e));
    const { problems } = buildSamplePlan(inputsOf(s), specs);
    expect(problems).toEqual([
      { message: 'sample-e1: starts in the first 8000 ms of p1', detail: 'at 6000 ms' },
      { message: 'sample-e2: starts less than 12000 ms after sample-e1 ends', detail: '8400 ms after it' },
    ]);
  });

  it(`refuses a clip more than ${DURATION_TOLERANCE_MS} ms from its target, and wrong error counts and kinds`, () => {
    const s = syntheticSample();
    s.texts.opening = passageText(Array.from({ length: 16 }, () => sentence())); // 48.6 s for 60 s
    const specs = s.specs.filter((e) => e.error_id !== 'sample-e3'); // no negation left, p1 has two
    const { problems } = buildSamplePlan(inputsOf(s), specs);
    expect(problems).toEqual([
      { message: 'opening: the clip lasts 48600 ms, more than 10000 ms from its target 60000 ms' },
      { message: 'p1: 2 planted errors, expected 3' },
      { message: 'no planted error of class negation: vary the kind' },
    ]);
  });

  it('refuses timings that number the words of the text otherwise, and clips out of order', () => {
    const s = syntheticSample();
    const inputs = inputsOf(s);
    inputs[2] = { ...inputs[2]!, timings: pacedTimings(passageText(Array.from({ length: 15 }, () => sentence())).replace('now.\n', 'now and more.\n')) };
    const { problems } = buildSamplePlan([inputs[0]!, inputs[2]!, inputs[1]!], s.specs);
    expect(problems[0]!.message).toMatch(/the clips are opening, p2, p1/);
    const tts = problems.find((p) => p.message.startsWith('p2: its word timings: '));
    expect(tts?.message).toMatch(/^p2: its word timings: \d+ defect\(s\) found by tools\/tts$/);
    expect(tts?.detail).toMatch(/words.ts finds 150 words, timings.json lists 152/);
  });

  it('names no word of the texts and no time inside a clip in any message (spec 7.11: the participant has not heard them)', () => {
    const s = syntheticSample();
    // an off-topic word, a stray character, an early error, a short gap and a sentence that does not exist
    const p1 = Array.from({ length: 18 }, () => sentence());
    p1[1] = sentence(['beta']);
    p1[4] = sentence(['gamma', 'delta']);
    p1[13] = sentence(['did', 'not', 'go', 'home']);
    p1[6] = sentence(['breathing']);
    s.texts.p1 = passageText(p1).replace('Plain words', 'Plain wordsé');
    const specs = s.specs.map((e) =>
      e.error_id === 'sample-e1' ? { ...e, sentence_index: 1 } : e.error_id === 'sample-e2' ? { ...e, sentence_index: 4 } : e.error_id === 'sample-e5' ? { ...e, sentence_index: 40 } : e,
    );
    const { problems } = buildSamplePlan(inputsOf(s), specs);
    expect(problems.length).toBeGreaterThanOrEqual(5);
    const blind = problems.map((p) => formatFinding(p, false)).join('\n');
    for (const secret of ['breathing', 'é', 'beta', 'gamma', 'Plain', '6000', '8400', 'sentence 40']) expect(blind).not.toContain(secret);
    const shown = problems.map((p) => formatFinding(p, true)).join('\n');
    for (const secret of ['breathing', '"é"', '6000 ms', '8400 ms', 'sentence 40']) expect(shown).toContain(secret);
  });
});

describe('samplePlanProblems', () => {
  it('finds a stored plan that no longer follows from its texts and timings', () => {
    const s = syntheticSample();
    const { plan } = buildSamplePlan(inputsOf(s), s.specs);
    const stored = JSON.parse(samplePlanJson(plan)) as typeof plan;
    stored.errors[0]!.span_start_ms += 1;
    expect(samplePlanProblems(stored, inputsOf(s))).toEqual([{ message: 'plan.json differs from the plan the texts and timings give (run tools/sample/build.ts)' }]);
    const other = inputsOf(s).map((p) => (p.id === 'p2' ? { ...p, audioSha256: 'cd'.repeat(32) } : p));
    expect(samplePlanProblems(JSON.parse(samplePlanJson(plan)), other)).toHaveLength(1);
    expect(messages(samplePlanProblems({}, inputsOf(s)))).toEqual(['plan.json: errors is not an array']);
  });

  it('reads only the hand-written fields of each error, and refuses a malformed one', () => {
    const s = syntheticSample();
    expect(readErrorSpecs({ errors: s.specs.map((e) => ({ ...e, word_start: 1 })) })).toEqual(s.specs);
    expect(() => readErrorSpecs({ errors: [{ ...s.specs[0], class: 'sense' }] })).toThrow(/class sense/);
    expect(() => readErrorSpecs({ errors: [{ ...s.specs[0], passage_id: 'opening ' }] })).toThrow(/names no sample passage/);
    expect(() => readErrorSpecs({ errors: [{ ...s.specs[0], error_id: 'e1' }] })).toThrow(/error_id like sample-e1/);
    expect(() => readErrorSpecs({})).toThrow(/errors is not an array/);
  });
});

describe('sampleTextProblems', () => {
  it('accepts plain lines that end with a period', () => {
    expect(sampleTextProblems('A plain line, with a comma.\nAnd a second one.\n')).toEqual([]);
  });

  it('refuses digits, other punctuation, bad spacing, unfinished lines and off-topic words, the words at fault as the detail', () => {
    expect(sampleTextProblems('It took 40 minutes.\n')).toEqual([{ message: 'line 1: characters other than letters, spaces, periods and commas', detail: '"4" "0"' }]);
    expect(sampleTextProblems('It is done!\n')).toEqual([
      { message: 'line 1: characters other than letters, spaces, periods and commas', detail: '"!"' },
      { message: 'line 1: the paragraph must end with a period' },
    ]);
    expect(sampleTextProblems('One line,glued.\n')).toEqual([{ message: 'line 1: a period or comma without a space after it' }]);
    expect(sampleTextProblems('Two  spaces.\n')).toEqual([{ message: 'line 1: a space at the start, at the end or twice' }]);
    expect(sampleTextProblems('No break at the end.')).toEqual([{ message: 'the text must end with exactly one line break' }]);
    expect(sampleTextProblems('A line.\n\nAnother.\n')).toEqual([{ message: 'line 2: an empty line' }]);
    expect(sampleTextProblems('Then you take a deep breath and feel calm.\n')).toEqual([{ message: '4 off-topic word(s) (topic guard)', detail: 'breath, calm, feel, you' }]);
  });

  it('prints the detail only when asked (gate/check-texts.ts formatProblem)', () => {
    const [f] = sampleTextProblems('It took 40 minutes.\n');
    expect(formatFinding(f!, false)).toBe('line 1: characters other than letters, spaces, periods and commas');
    expect(formatFinding(f!, true)).toBe('line 1: characters other than letters, spaces, periods and commas ["4" "0"]');
  });
});
