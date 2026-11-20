// The stored sample of `npm run headstart` (sample/; spec 7.11, 15.1; PREREG.md §11): the clips as
// the page decodes them, one timings-set/1 file that matches them, the public plan against the texts
// and timings, the loudness of the gate packs, the word lists, and nothing shared with the gate
// packs. The checks name no word of the texts, and a failure prints rules, ids, counts, clip
// lengths and levels only, never a word or a time inside a clip (`npm run sample:build --
// --show-text` gives those), so this file can be read and run before a demo take. The gate packs
// are compared as counts only, as tools/freeze/level-sample.test.ts does for the doctor sample: no
// pack text is ever printed (spec 9.2).
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { EXAMPLE_SHARED_WORDS, GATE_DIR, changedWords, parsePassage, publishedExampleFindings, quotedExamples, wordClassOf } from '../../gate/check-texts.ts';
import { gatePassageVariants, overlapCount, SHINGLE_WORDS } from '../../gate/level/text.ts';
import { readWavFormat } from '../../gate/level/wav16.ts';
import { LEVEL_MATCH_DB, LEVEL_WAV, rmsDbfs, wavSamples } from '../../gate/render-packs.ts';
import { decodeNarratorWav } from '../../web/ui/wav.ts';
import { loadList } from '../lint-words.ts';
import { parseTimingsSet, timingsForClip, timingsProblems, timingsTextProblems } from '../tts/timings.ts';
import { splitPassageWords } from '../tts/words.ts';
import { bannedWordFindings } from './build.ts';
import {
  DURATION_TOLERANCE_MS,
  FIRST_ERROR_MS,
  MAX_WORDS_AFTER_ERROR,
  MIN_ERROR_GAP_MS,
  SAMPLE_ERROR_CLASSES,
  SAMPLE_PASSAGES,
  SAMPLE_PASSAGE_IDS,
  audioFileOf,
  bareWord,
  correctedText,
  errorFactPhrase,
  phraseWords,
  samplePlanProblems,
  sampleTextProblems,
  textFileOf,
  type SamplePassageInput,
  type SamplePlan,
} from './plan.ts';

const SAMPLE = join(import.meta.dirname, '..', '..', 'sample');
const read = (name: string): Uint8Array => new Uint8Array(readFileSync(join(SAMPLE, name)));
const text = (name: string): string => readFileSync(join(SAMPLE, name), 'utf8');
const sha256 = (b: Uint8Array): string => createHash('sha256').update(b).digest('hex');
const buffer = (b: Uint8Array): ArrayBuffer => b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;

const setJson = JSON.parse(text('timings.json')) as unknown;
const set = parseTimingsSet(setJson);
const plan = JSON.parse(text('plan.json')) as SamplePlan;
const inputs: SamplePassageInput[] = SAMPLE_PASSAGE_IDS.map((id) => {
  const timings = timingsForClip(setJson, audioFileOf(id));
  if (timings === null) throw new Error(`timings.json has no ${id}`);
  return {
    id,
    text: text(textFileOf(id)),
    textSha256: sha256(read(textFileOf(id))),
    audioSha256: sha256(read(audioFileOf(id))),
    timings,
  };
});
const passage = (id: string): SamplePassageInput => inputs.find((p) => p.id === id)!;

describe('the stored sample (sample/)', () => {
  it('holds the files headstart needs, and no other clip host would serve', () => {
    const listed = (dir: string): string[] => readdirSync(dir).filter((n) => !n.startsWith('.')).sort(); // .DS_Store and the like
    expect(listed(SAMPLE)).toEqual(['README.md', 'opening.wav', 'p1.wav', 'p2.wav', 'plan.json', 'texts', 'timings.json']);
    expect(listed(join(SAMPLE, 'texts'))).toEqual(['opening.txt', 'p1.txt', 'p2.txt']);
    expect(existsSync(join(SAMPLE, 'p3.wav')) || existsSync(join(SAMPLE, 'audio'))).toBe(false);
  });

  it('stores every clip as the gate packs do: 16-bit PCM, mono, 48 kHz, which the page decodes', () => {
    for (const id of SAMPLE_PASSAGE_IDS) {
      const wav = read(audioFileOf(id));
      const f = readWavFormat(wav);
      expect(f, id).toMatchObject({ format: 1, bitsPerSample: 16, channels: 1, sampleRateHz: 48_000 });
      expect(f.dataOffset, id).toBe(44); // the canonical header of gate/level/wav16.ts, nothing else
      expect(decodeNarratorWav(buffer(wav), audioFileOf(id)).length, id).toBe(f.frames);
    }
  });

  it('has one timings-set/1 file whose entries are the stored clips', () => {
    expect(set.passages.map((p) => p.passageId)).toEqual(['opening', 'p1', 'p2']);
    for (const p of set.passages) {
      const wav = read(`${p.passageId}.wav`);
      expect(p.audioSha256, p.passageId).toBe(sha256(wav)); // what the page checks before it uses the times
      expect(readWavFormat(wav).frames, p.passageId).toBe(p.timings.durationSamples);
      // tools/tts messages name words by number and give times: only their count is printed here.
      expect(timingsProblems(p.timings).length, `${p.passageId}: defects of its word timings`).toBe(0);
    }
  });

  it('numbers the words of each text as its timings do, and keeps the rules of a sample text', () => {
    for (const p of inputs) {
      expect(timingsTextProblems(p.timings, p.text).length, `${p.id}: defects of its word timings against its text`).toBe(0);
      expect(sampleTextProblems(p.text).map((f) => f.message), p.id).toEqual([]);
    }
  });

  it(`keeps each clip within ${DURATION_TOLERANCE_MS / 1000} s of its target length`, () => {
    for (const target of SAMPLE_PASSAGES) {
      const t = passage(target.id).timings;
      expect(Math.abs(t.durationMs - target.targetMs), target.id).toBeLessThanOrEqual(DURATION_TOLERANCE_MS);
    }
  });

  it('has a plan that follows from the texts and timings, with every rule of plan.ts kept', () => {
    expect(samplePlanProblems(plan, inputs).map((f) => f.message)).toEqual([]);
    expect(plan.passages.map((p) => [p.passage_id, p.error_count])).toEqual(SAMPLE_PASSAGES.map((p) => [p.id, p.errors]));
    expect(new Set(plan.errors.map((e) => e.class))).toEqual(new Set(SAMPLE_ERROR_CLASSES));
  });

  it('places each planted error inside its passage, on the changed words, at their times in timings.json', () => {
    // Each check is a yes or no with the error id, so a failure shows no word and no time.
    for (const e of plan.errors) {
      const p = passage(e.passage_id);
      const words = splitPassageWords(p.text);
      const t = p.timings.words;
      const inside = Number.isInteger(e.word_start) && e.word_start >= 0 && e.word_start <= e.word_end && e.word_end < p.timings.wordCount;
      expect(inside, `${e.error_id}: its word range lies inside ${p.id}`).toBe(true);
      const changed = words.slice(e.word_start, e.word_end + 1).map((w) => bareWord(w.text));
      expect(changed.join(' ') === phraseWords(e.replacement).join(' '), `${e.error_id}: its word range holds the changed words`).toBe(true);
      const first = t[e.word_start]!;
      const last = t[e.word_end]!;
      expect(first.startMs === e.span_start_ms && last.endMs === e.span_end_ms, `${e.error_id}: its times are those of its words in timings.json`).toBe(true);
      expect(first.sentenceIndex === e.sentence_index && last.sentenceIndex === e.sentence_index, `${e.error_id}: its words lie in its sentence`).toBe(true);
      const after = t.filter((w) => w.sentenceIndex === e.sentence_index && w.index > e.word_end).length;
      expect(after <= MAX_WORDS_AFTER_ERROR, `${e.error_id}: at most ${MAX_WORDS_AFTER_ERROR} word of its sentence follows the changed words`).toBe(true);
      expect(e.span_start_ms >= FIRST_ERROR_MS, `${e.error_id}: starts ${FIRST_ERROR_MS} ms or more into ${p.id}`).toBe(true);
      expect(e.span_end_ms <= e.sentence_end_ms && e.sentence_end_ms <= p.timings.durationMs, `${e.error_id}: ends inside its sentence and its clip`).toBe(true);
    }
    for (const id of SAMPLE_PASSAGE_IDS) {
      const mine = plan.errors.filter((e) => e.passage_id === id);
      for (let k = 1; k < mine.length; k++) {
        const gap = mine[k]!.span_start_ms - mine[k - 1]!.span_end_ms;
        expect(gap >= MIN_ERROR_GAP_MS, `${mine[k]!.error_id}: starts ${MIN_ERROR_GAP_MS} ms or more after ${mine[k - 1]!.error_id} ends`).toBe(true);
      }
    }
  });

  it(`plays at the loudness of the doctor sample, like the gate packs (RMS within ${LEVEL_MATCH_DB} dB, no clipping)`, () => {
    const reference = rmsDbfs(wavSamples(new Uint8Array(readFileSync(LEVEL_WAV))));
    for (const id of SAMPLE_PASSAGE_IDS) {
      const samples = wavSamples(read(audioFileOf(id)));
      expect(Math.abs(rmsDbfs(samples) - reference), id).toBeLessThanOrEqual(LEVEL_MATCH_DB);
      let peak = 0;
      for (const x of samples) peak = Math.max(peak, Math.abs(x));
      expect(peak, id).toBeLessThan(32_767 / 32_768);
    }
  });

  it('holds no banned word, and its README quotes no example the gate checker would compare (spec 9.2, 13.6)', () => {
    const banned = loadList(join(import.meta.dirname, '..', 'words', 'banned.txt'));
    const allowed = loadList(join(import.meta.dirname, '..', 'words', 'allow.txt'));
    // File and line only: lint:words checks just the README, because it prints the line of each hit.
    for (const name of ['README.md', 'plan.json', 'timings.json', ...SAMPLE_PASSAGE_IDS.map(textFileOf)]) {
      expect(bannedWordFindings(name, text(name), banned, allowed).map((f) => f.message), name).toEqual([]);
    }
    expect(quotedExamples(text('README.md'))).toEqual([]);
  });

  it('states the placement rules in its README as plan.ts holds them', () => {
    const readme = text('README.md').replace(/\s+/g, ' ');
    expect(MAX_WORDS_AFTER_ERROR).toBe(1);
    expect(readme).toContain('close their sentence, with at most one word after them');
    expect(readme).toContain(`at least ${FIRST_ERROR_MS / 1000} s into its passage`);
    expect(readme).toContain(`at least ${MIN_ERROR_GAP_MS / 1000} s after the one before it ends`);
  });
});

// A demo take may come before packs B and C are recorded (PREREG.md §11: it needs only the frozen
// parameters), and the sample is readable in the repository. So it shares no sentence, no run of
// SHINGLE_WORDS words and no planted fact with any gate pack (spec 9.2). Counts and names only.
describe('the sample and the gate packs (spec 9.2; PREREG.md §11), as counts only', () => {
  const packs = readdirSync(GATE_DIR).filter((n) => n.startsWith('pack-') && statSync(join(GATE_DIR, n)).isDirectory()).sort();
  const errorsOf = (id: string): SamplePlan['errors'] => plan.errors.filter((e) => e.passage_id === id);

  it('shares no sentence and no run of words with any gate pack text, as read and as corrected', () => {
    const versions = inputs.flatMap((p) =>
      errorsOf(p.id).length === 0 ? [{ name: p.id, text: p.text }] : [{ name: p.id, text: p.text }, { name: `${p.id} as corrected`, text: correctedText(p.text, errorsOf(p.id)) }],
    );
    let compared = 0;
    const overlaps: string[] = [];
    for (const pack of packs) {
      for (const file of readdirSync(join(GATE_DIR, pack)).filter((n) => n.endsWith('.txt')).sort()) {
        for (const variant of gatePassageVariants(readFileSync(join(GATE_DIR, pack, file), 'utf8'))) {
          for (const v of versions) {
            compared += 1;
            const c = overlapCount(v.text, variant);
            if (c.sharedSentences > 0 || c.sharedRuns > 0) overlaps.push(`${v.name} / ${pack}/${file}: ${c.sharedSentences} sentences, ${c.sharedRuns} runs of ${SHINGLE_WORDS} words`);
          }
        }
      }
    }
    expect(compared).toBeGreaterThan(0);
    expect(overlaps).toEqual([]);
  });

  it(`repeats no fact of a gate pack substitution: no planted error shares ${EXAMPLE_SHARED_WORDS} content words with one`, () => {
    // gate/check-texts.ts publishedExampleFindings, with the fact phrase of each planted error as the
    // example. Its findings carry pack words as their detail: only their number is kept.
    let objectionPassages = 0;
    const hits: string[] = [];
    for (const pack of packs) {
      const file = join(GATE_DIR, pack, 'objections.txt');
      if (!existsSync(file)) continue;
      objectionPassages += 1;
      const objections = parsePassage(readFileSync(file, 'utf8'), true);
      for (const e of plan.errors) {
        const n = publishedExampleFindings(objections, [errorFactPhrase(passage(e.passage_id).text, e)]).length;
        if (n > 0) hits.push(`${e.error_id} / ${pack}/objections.txt: ${n} substitution(s)`);
      }
    }
    expect(objectionPassages).toBeGreaterThan(0);
    expect(hits).toEqual([]);
  });

  it('changes no word of a kind of fact that the gate keeps to one pack (gate/check-texts.ts WORD_CLASSES)', () => {
    for (const e of plan.errors) {
      const changed = [...changedWords(e.replacement, e.original_span), ...changedWords(e.original_span, e.replacement)];
      expect(changed.filter((w) => wordClassOf(w) !== undefined).length, e.error_id).toBe(0);
    }
  });
});
