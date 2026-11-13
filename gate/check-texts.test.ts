// Tests of the gate packs and their checker (spec 9.2). Run:
//   npx vitest run gate/check-texts.test.ts
// Review 10: CI logs are public and the participant reads them, so this file holds no pack content.
// Rule tests use made-up passages; anything pack-specific is derived from the pack files at run time,
// and assertions on the real packs compare counts and blind messages only, never words or cue times.
import fc from 'fast-check';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { parseTimings, TIME_RULE } from '../tools/tts/timings.ts';
import {
  DESIGN_CUE_LIMITS_MS,
  DESIGN_SLACK_MS,
  EXAMPLE_SHARED_WORDS,
  GATE_DIR,
  PACK_SPECS,
  REPO_ROOT,
  SPEC_CUE_LIMITS_MS,
  SPEC_EXAMPLES,
  WORD_CLASSES,
  buildPacks,
  changedWords,
  checkCueRules,
  checkGate,
  checkPassage,
  checkSubstitutions,
  contentWords,
  countDifferent,
  crossPackProblems,
  cueTimesMs,
  factWord,
  formatCuesJson,
  formatProblem,
  intervalSpreadFindings,
  intervalsMs,
  loadPack,
  main,
  paragraphMixFindings,
  parsePassage,
  parsePredicted,
  placementProblems,
  preregCueHashes,
  publishedDocFiles,
  publishedExampleFindings,
  publishedExamples,
  quotedExamples,
  sha256Hex,
  soundsDifferent,
  splitWords,
  spokenText,
  timingAgreement,
  wavInfo,
  wordClassOf,
  wordNumberingProblems,
  writeSpokenTexts,
  type PackId,
  type Passage,
  type Problem,
  type Substitution,
} from './check-texts.ts';

const { packListing } = createRequire(import.meta.url)('../live/lib/narrator.cjs') as {
  packListing: (packJson: unknown) => Map<string, string | null>;
};

const temps: string[] = [];
afterAll(() => {
  for (const dir of temps) rmSync(dir, { recursive: true, force: true });
});

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  temps.push(dir);
  return dir;
}

/** A copy of the four pack folders (texts and predicted timings) in a temp gate folder. */
function tempGate(): string {
  const dir = tempDir('gate-texts-');
  for (const id of ['0', 'A', 'B', 'C']) {
    const from = join(GATE_DIR, `pack-${id}`);
    mkdirSync(join(dir, `pack-${id}`));
    for (const name of readdirSync(from)) {
      if (/^(listen|objections)\.(txt|predicted\.json)$/.test(name)) cpSync(join(from, name), join(dir, `pack-${id}`, name));
    }
  }
  return dir;
}

/**
 * Mono WAV of silence: 16-bit PCM, the format pack audio is stored in (gate/render-packs.ts), or
 * 32-bit float, the format tools/tts writes.
 */
function silentWav(frames: number, rateHz = 48_000, sample: 'pcm16' | 'float32' = 'pcm16'): Buffer {
  const width = sample === 'pcm16' ? 2 : 4;
  const bytes = frames * width;
  const b = Buffer.alloc(44 + bytes);
  b.write('RIFF', 0, 'ascii');
  b.writeUInt32LE(36 + bytes, 4);
  b.write('WAVE', 8, 'ascii');
  b.write('fmt ', 12, 'ascii');
  b.writeUInt32LE(16, 16);
  b.writeUInt16LE(sample === 'pcm16' ? 1 : 3, 20);
  b.writeUInt16LE(1, 22);
  b.writeUInt32LE(rateHz, 24);
  b.writeUInt32LE(rateHz * width, 28);
  b.writeUInt16LE(width, 32);
  b.writeUInt16LE(8 * width, 34);
  b.write('data', 36, 'ascii');
  b.writeUInt32LE(bytes, 40);
  return b;
}

/** Fakes npm run tts: the real timings equal the predicted ones (gate/predict_timings.py). */
function fakeRender(gateDir: string, id: PackId): void {
  for (const kind of ['listen', 'objections']) {
    const dir = join(gateDir, `pack-${id}`);
    const predicted = JSON.parse(readFileSync(join(dir, `${kind}.predicted.json`), 'utf8')) as { timings: { durationSamples: number } };
    writeFileSync(join(dir, `${kind}.timings.json`), `${JSON.stringify(predicted.timings, null, 2)}\n`);
    writeFileSync(join(dir, `${kind}.wav`), silentWav(predicted.timings.durationSamples));
  }
}

const messages = (findings: readonly { message: string }[]): string[] => findings.map((f) => f.message);
const blind = (problems: readonly Problem[]): string[] => problems.map((p) => formatProblem(p, false));

/** The rendered objection timings of a pack, to edit in a test. */
interface TimingsDoc {
  durationMs: number;
  durationSamples: number;
  words: { startMs: number; endMs: number }[];
}
const readTimings = (file: string): TimingsDoc => JSON.parse(readFileSync(file, 'utf8')) as TimingsDoc;

/** The parsed objection passage of a pack in a gate folder. */
const objectionsOf = (gateDir: string, id: PackId): Passage => parsePassage(readFileSync(join(gateDir, `pack-${id}`, 'objections.txt'), 'utf8'), true);

/** Replaces the n-th [[wrong|right]] markup of a text (1-based). */
function replaceMarkup(raw: string, n: number, make: (wrong: string, right: string) => string): string {
  let k = 0;
  return raw.replace(/\[\[([^[\]|]*)\|([^[\]|]*)\]\]/g, (all, wrong: string, right: string) => (++k === n ? make(wrong, right) : all));
}

/** A PREREG.md with only the cue-list hash table, one row per pack: a hash, or the placeholder. */
function preregWith(hashes: Partial<Record<PackId, string>>): string {
  const file = join(tempDir('gate-prereg-'), 'PREREG.md');
  const rows = PACK_SPECS.map((s) => `| ${s.id} | \`${hashes[s.id] ?? `{{CUES_SHA256_${s.id}}}`}\` |`);
  writeFileSync(file, ['# Pre-registration', '', '| Pack | SHA-256 of `cues.json` |', '|---|---|', ...rows, ''].join('\n'));
  return file;
}

// Made-up filler: one vocabulary per test pack, so that two packs share no run of words by accident.
const VOCAB: Record<string, string[]> = {
  a: ['the', 'small', 'robot', 'sorted', 'plastic', 'marbles', 'into', 'neat', 'trays', 'under', 'a', 'metal', 'drawer', 'labels'],
  b: ['some', 'striped', 'kites', 'hovered', 'across', 'that', 'windy', 'parking', 'garage', 'during', 'yesterday', 'traffic', 'jams', 'below'],
};
const words = (n: number, v = 'a', from = 0): string => Array.from({ length: n }, (_x, i) => VOCAB[v]![(from + i) % VOCAB[v]!.length]).join(' ');
const filler = (n: number, v = 'a'): string => `${words(n, v)}.`;

/** One substitution inside the second sentence of a three-sentence paragraph. */
const oneSub = (markup: string, v = 'a'): string => `${filler(10, v)} ${words(4, v, 3)} ${markup} ${words(5, v, 8)}. ${filler(10, v)}\n`;

// ---------------------------------------------------------------------------------------------

describe('the packs in the repository', () => {
  const report = checkGate();

  it('pass every rule: texts, predicted timings, rules across packs, published examples and banned words', () => {
    expect(blind(report.problems)).toEqual([]);
  });

  it('give each pack its number of cues within the design limits of the predicted timings', () => {
    for (const spec of PACK_SPECS) {
      const cues = report.predictedCues[spec.id] ?? [];
      expect(cues.length, `pack ${spec.id}`).toBe(spec.substitutions);
      const lim = DESIGN_CUE_LIMITS_MS;
      const outside = intervalsMs(cues).filter((gap) => gap < lim.intervalMin || gap > lim.intervalMax).length;
      expect(outside, `pack ${spec.id}: intervals outside the design limits`).toBe(0);
      expect((cues[0] ?? 0) >= lim.firstMin && (cues[cues.length - 1] ?? Infinity) <= lim.lastMax, `pack ${spec.id}: first and last cue inside the design limits`).toBe(true);
    }
  });

  it('keep every clip within its block (spec 9.2: 180 s and 300 s; probe 30 s and 60 s)', () => {
    for (const pack of report.packs) {
      const listen = pack.predicted.listen;
      const objections = pack.predicted.objections;
      if (typeof listen !== 'object' || typeof objections !== 'object') throw new Error(`pack ${pack.spec.id}: no predicted timings`);
      expect(listen.timings.durationMs).toBeLessThanOrEqual(pack.spec.listenMaxMs - DESIGN_SLACK_MS);
      expect(objections.timings.durationMs).toBeLessThanOrEqual(pack.spec.objectionMaxMs - DESIGN_SLACK_MS);
    }
  });

  it('place the cues of A, B and C differently, not as one rhythm shifted', () => {
    const { A, B, C } = report.predictedCues;
    for (const [x, y] of [[A, B], [A, C], [B, C]] as const) {
      expect(countDifferent(x!, y!, 2_000)).toBeGreaterThanOrEqual(12);
      expect(countDifferent(intervalsMs(x!), intervalsMs(y!), 1_000)).toBeGreaterThanOrEqual(6);
    }
  });

  it('keep no substitution at the end of a paragraph and few at the end of a sentence (review 3)', () => {
    for (const pack of report.packs) {
      const p = pack.passages.objections!;
      const atSentenceEnd = p.substitutions.filter((s) => s.lastWordIndex === p.sentences[s.sentenceIndex]!.lastWordIndex).length;
      expect(atSentenceEnd).toBeLessThanOrEqual(Math.floor(p.substitutions.length / 3));
      const atParagraphEnd = p.substitutions.filter((s) => s.lastWordIndex >= p.paragraphs[s.paragraphIndex]!.lastWordIndex).length;
      expect(atParagraphEnd, `pack ${pack.spec.id}`).toBe(0);
    }
  });

  it('commit predicted timings made from the current texts by gate/predict_timings.py', () => {
    for (const id of ['0', 'A', 'B', 'C'] as const) {
      for (const kind of ['listen', 'objections']) {
        const dir = join(GATE_DIR, `pack-${id}`);
        const predicted = parsePredicted(JSON.parse(readFileSync(join(dir, `${kind}.predicted.json`), 'utf8')));
        expect(predicted.spokenSha256).toBe(sha256Hex(spokenText(readFileSync(join(dir, `${kind}.txt`), 'utf8'))));
        expect(predicted.timings.engine.voice).toBe('af_heart');
        expect(predicted.timings.engine.speed).toBe(1);
      }
    }
  });
});

describe('gate test files hold no pack content (review 10)', () => {
  // The texts of each pack, and each passage as spoken (wrong phrases) and as corrected (right phrases).
  const packTexts = PACK_SPECS.map((s) => ['listen.txt', 'objections.txt'].map((n) => readFileSync(join(GATE_DIR, `pack-${s.id}`, n), 'utf8')));
  const corrected = (raw: string): string => raw.replace(/\[\[[^[\]|]*\|([^[\]|]*)\]\]/g, (_a, right: string) => right);
  const versionsOf = (raws: readonly string[]): string[] => raws.flatMap((raw) => [spokenText(raw), corrected(raw)]);
  const lower = (text: string): string[] => splitWords(text).map((w) => w.toLowerCase());
  /** Words of code and prose alike: letter runs, camelCase split, lower case. */
  const codeWords = (text: string): string[] => lower(text.replace(/([a-z])([A-Z])/g, '$1 $2'));
  const runsOf = (ws: readonly string[], n: number): Set<string> => new Set(ws.slice(0, Math.max(0, ws.length - n + 1)).map((_w, i) => ws.slice(i, i + n).join(' ')));
  const norm = (m: string): string => m.toLowerCase().replace(/\s+/g, ' ');
  const markups = new Set(packTexts.flat().flatMap((raw) => [...raw.matchAll(/\[\[[^[\]]*\]\]/g)].map((m) => norm(m[0]))));
  const packRuns = new Set(versionsOf(packTexts.flat()).flatMap((t) => [...runsOf(lower(t), 5)]));
  // A rare content word: five letters or more, in the texts of one pack only, and in none of the
  // module's own code and docs (words the module uses anyway say nothing about a pack).
  const moduleWords = new Set(['check-texts.ts', 'render-packs.ts', 'predict_timings.py', 'README.md', 'NOTES.md'].flatMap((f) => codeWords(readFileSync(join(GATE_DIR, f), 'utf8'))));
  const wordsOfPack = packTexts.map((raws) => new Set(versionsOf(raws).flatMap(lower)));
  const packsHolding = (w: string): number => wordsOfPack.filter((set) => set.has(w)).length;
  const rareWords = new Set(wordsOfPack.flatMap((set) => [...set]).filter((w) => w.length >= 5 && !moduleWords.has(w) && packsHolding(w) === 1));

  /** What a text shares with the packs, as counts only: a failure prints no pack content. */
  const shared = (text: string): { markups: number; runs: number; rareWords: number } => ({
    markups: [...text.matchAll(/\[\[[^[\]]*\]\]/g)].filter((m) => markups.has(norm(m[0]))).length,
    runs: [...runsOf(lower(text), 5)].filter((r) => packRuns.has(r)).length,
    rareWords: new Set(codeWords(text).filter((w) => rareWords.has(w))).size,
  });
  const none = { markups: 0, runs: 0, rareWords: 0 };

  it('finds what a test would leak: a markup, a run of five words, a rare word', () => {
    expect(markups.size).toBe(PACK_SPECS.reduce((n, s) => n + s.substitutions, 0));
    expect(rareWords.size).toBeGreaterThan(50);
    const raw = packTexts[1]![1]!;
    const [markup] = raw.match(/\[\[[^[\]]*\]\]/) ?? [''];
    const run = lower(spokenText(raw)).slice(10, 15).join(' ');
    const rare = [...rareWords][0] ?? '';
    expect(shared(`const x = '${markup.toUpperCase()}';`)).toEqual({ markups: 1, runs: 0, rareWords: shared(markup).rareWords });
    expect(shared(`// ${run}`).runs).toBe(1);
    expect(shared(`writeFileSync(file, '${rare}');`)).toEqual({ markups: 0, runs: 0, rareWords: 1 });
    expect(shared(`const ${rare}Count = 1;`).rareWords).toBe(1);
  });

  it('keeps every test file of gate/ free of them', () => {
    const tests = (readdirSync(GATE_DIR, { recursive: true }) as string[]).filter((n) => n.endsWith('.test.ts') && !n.includes('node_modules'));
    expect(tests).toContain('check-texts.test.ts');
    expect(tests).toContain('render-packs.test.ts');
    for (const name of tests) expect(shared(readFileSync(join(GATE_DIR, name), 'utf8')), `gate/${name} shares content with a pack`).toEqual(none);
  });
});

describe('parsePassage', () => {
  it('numbers words, sentences, paragraphs and substitutions as the TTS does', () => {
    const raw = 'One two three. Four five [[six seven|eight]] nine.\n\nTen eleven, twelve.\n';
    const p = parsePassage(raw, true);
    expect(p.problems).toEqual([]);
    expect(p.words).toEqual(['One', 'two', 'three', 'Four', 'five', 'six', 'seven', 'nine', 'Ten', 'eleven', 'twelve']);
    expect(p.sentences).toEqual([
      { firstWordIndex: 0, lastWordIndex: 2 },
      { firstWordIndex: 3, lastWordIndex: 7 },
      { firstWordIndex: 8, lastWordIndex: 10 },
    ]);
    expect(p.paragraphs).toEqual([
      { firstWordIndex: 0, lastWordIndex: 7 },
      { firstWordIndex: 8, lastWordIndex: 10 },
    ]);
    expect(p.substitutions).toEqual([
      { n: 1, wrong: 'six seven', right: 'eight', firstWordIndex: 5, lastWordIndex: 6, sentenceIndex: 1, paragraphIndex: 0 },
    ]);
    expect(spokenText(raw)).toBe('One two three. Four five six seven nine.\n\nTen eleven, twelve.\n');
    expect(wordNumberingProblems(spokenText(raw), p.words)).toEqual([]);
  });

  it('reports characters, glued punctuation, unfinished paragraphs and stray markup', () => {
    expect(messages(parsePassage('Bay 9 isn’t ajar.\n', false).problems)).toEqual([
      'line 1: a character other than letters, spaces, periods and commas',
      'line 1: a character other than letters, spaces, periods and commas',
    ]);
    expect(messages(parsePassage('One.Two three.\n', false).problems)).toEqual(['line 1: a period or comma without a space after it']);
    expect(messages(parsePassage('One two\nthree four.\n', false).problems)).toEqual(['line 1: the paragraph must end with a period']);
    expect(messages(parsePassage('A line\r\n', false).problems)[0]).toMatch(/character other than/);
    expect(messages(parsePassage('One [[two|three]] four.\n', false).problems)).toEqual(['line 1: markup is not allowed in a listening passage']);
    expect(messages(parsePassage('One [[two three four|five]] six.\n', true).problems)).toEqual([
      'line 1: substitution 1: the wrong phrase must be 1 to 2 words of letters',
    ]);
    expect(messages(parsePassage('One ]] two.\n', true).problems)).toEqual(['line 1: a markup character outside [[wrong|right]]']);
    expect(messages(parsePassage('One ]] two.\n', false).problems)).toEqual(['line 1: a markup character outside [[wrong|right]]']);
  });

  it('keeps words of a problem out of the blind message and in the detail', () => {
    const [f] = parsePassage('One [[two three four|five]] six.\n', true).problems;
    expect(f?.message).not.toContain('two three four');
    expect(f?.detail).toBe('two three four');
  });
});

describe('rules of each substitution (spec 7.8, 9.2)', () => {
  const check = (raw: string): string[] => messages(checkSubstitutions(parsePassage(raw, true), { substitutions: 1 }));

  it('accepts a clean swap inside a sentence', () => {
    expect(check(oneSub('[[three mugs|five mugs]]'))).toEqual([]);
  });

  it('refuses the first and the last sentence of the passage', () => {
    expect(check(`${words(4)} [[three|five]] ${words(5, 'a', 8)}. ${filler(10)}\n`)).toContain('substitution 1: in the first sentence of the passage');
    expect(check(`${filler(10)} ${words(4, 'a', 3)} [[three|five]] ${words(5, 'a', 8)}.\n`)).toContain('substitution 1: in the last sentence of the passage');
  });

  it('refuses an error at the end of a paragraph, the narrator’s longest pause (review 3)', () => {
    const raw = `${filler(10)} ${words(8, 'a', 3)} [[three|five]].\n\n${filler(10)}\n`;
    expect(check(raw)).toContain('substitution 1: the last word of its paragraph');
  });

  it('caps errors at the end of a sentence at a third of them', () => {
    const at = (end: boolean): string => `${words(6, 'a', 2)} [[three|five]]${end ? '.' : ` ${words(3, 'a', 9)}.`}`;
    const raw = (ends: number): string => `${filler(10)} ${[0, 1, 2].map((i) => at(i < ends)).join(' ')} ${filler(10)}\n`;
    expect(messages(checkSubstitutions(parsePassage(raw(1), true), { substitutions: 3 }))).not.toContain('2 substitutions end their sentence, at most 1');
    expect(messages(checkSubstitutions(parsePassage(raw(2), true), { substitutions: 3 }))).toContain('2 substitutions end their sentence, at most 1');
  });

  it('needs context before the wrong phrase and a sentence of at least 8 words', () => {
    expect(check(`${filler(10)} The [[three|five]] ${words(8, 'a', 8)}. ${filler(10)}\n`)).toContain('substitution 1: fewer than 2 words before it in its sentence');
    expect(check(`${filler(10)} ${words(3, 'a', 3)} [[three|five]] ${words(1, 'a', 8)}. ${filler(10)}\n`)).toContain('substitution 1: its sentence has fewer than 8 words');
  });

  it('needs a changed word that sounds different (spec 7.8)', () => {
    expect(check(oneSub('[[three mugs|three mugs]]'))).toContain('substitution 1: the wrong and right phrases must differ by a word');
    expect(check(oneSub('[[mittens|muttons]]'))).toContain('substitution 1: the wrong and right words sound too alike (spec 7.8)');
    expect(check(oneSub('[[fifteen|fifty]]'))).toContain('substitution 1: the wrong and right words sound too alike (spec 7.8)');
    expect(check(oneSub('[[four|three]]'))).toContain('substitution 1: the change is too small to notice');
    expect(soundsDifferent('violet', 'maroon')).toBe(true);
    expect(soundsDifferent('mittens', 'muttons')).toBe(false);
  });

  it('keeps the kind of word out of the blind message (review 16)', () => {
    const p = parsePassage(`${oneSub('[[fifteen|fifty]]')}${oneSub('[[four|three]]')}`.replace(/\n(?!$)/g, '\n\n'), true);
    const found = checkSubstitutions(p, { substitutions: 2 });
    expect(found.some((f) => f.detail?.includes('teen and ty') === true)).toBe(true);
    expect(found.some((f) => f.detail?.includes('numbers less than 2 apart') === true)).toBe(true);
    for (const m of messages(found)) expect(m).not.toMatch(/teen|number|fifteen|fifty|four|three/);
  });

  it('keeps the right word out of the 50 words on either side of the error', () => {
    const raw = `${filler(10)} ${words(4, 'a', 3)} [[three|five]] ${words(5, 'a', 8)}. Each tray had five ${words(8)}.\n`;
    expect(check(raw)).toContain('substitution 1: the right word is spoken 9 words away, closer than 50');
    const far = `${filler(10)} ${words(4, 'a', 3)} [[three|five]] ${words(5, 'a', 8)}. ${filler(25)} ${filler(25)} Each tray had five ${words(8)}.\n`;
    expect(check(far)).toEqual([]);
  });

  it('does not change one word in two substitutions of a pack', () => {
    const raw = `${filler(10)} ${words(4, 'a', 3)} [[three|five]] ${words(5, 'a', 8)}. ${words(4, 'a', 1)} [[six|three]] ${words(5, 'a', 6)}. ${filler(10)}\n`;
    expect(messages(checkSubstitutions(parsePassage(raw, true), { substitutions: 2 }))).toContain('substitution 2: changes a word substitution 1 changes too');
  });

  it('mixes paragraphs with two errors and paragraphs without one in a full pack (review 3)', () => {
    const para = (n: number): string => Array.from({ length: n }, (_x, i) => `${words(4, 'a', i)} [[three|five]] ${words(5, 'a', 8)}.`).join(' ');
    const one = `${filler(10)}\n\n${Array.from({ length: 3 }, () => `${para(1)} ${filler(9)}`).join('\n\n')}\n\n${filler(10)}\n`;
    expect(messages(paragraphMixFindings(parsePassage(one, true)))).toEqual([
      '0 paragraphs hold two substitutions, at least 2',
      '1 paragraphs before the last substitution hold none, at least 2',
    ]);
    const varied = `${filler(10)}\n\n${para(2)} ${filler(9)}\n\n${filler(9)}\n\n${para(2)} ${filler(9)}\n\n${filler(10)}\n`;
    expect(messages(paragraphMixFindings(parsePassage(varied, true)))).toEqual([]);
  });

  it('checks the passage as a whole: count, sentence length and topic words', () => {
    const spec = PACK_SPECS[0]!;
    const long = `${filler(10)} ${words(31)}. ${filler(10)}\n`;
    expect(messages(checkPassage(parsePassage(long, false), 'listen', spec))).toEqual(['sentence 2 has 31 words, more than 30']);
    expect(messages(checkPassage(parsePassage(oneSub('[[three|five]]'), true), 'objections', spec))).toContain('1 substitutions, expected 2');
    const topic = `${filler(10)} The robot held a breath and felt calm near ${words(5)}. ${filler(10)}\n`;
    expect(messages(checkPassage(parsePassage(topic, false), 'listen', spec))).toEqual([
      'a word off topic for the gate texts',
      'a word off topic for the gate texts',
      'a word off topic for the gate texts',
    ]);
  });
});

describe('rules across packs (spec 9.2, review 9)', () => {
  const pack = (id: PackId, raw: string): { id: PackId; objections: Passage } => ({ id, objections: parsePassage(raw, true) });
  const acrossProblems = (a: string, b: string): Problem[] => crossPackProblems([pack('A', oneSub(a, 'a')), pack('B', oneSub(b, 'b'))]);
  const across = (a: string, b: string): string[] => acrossProblems(a, b).map((p) => p.message);

  it('accepts two packs with different words, frames and classes', () => {
    expect(across('[[three mugs|five mugs]]', '[[violet|maroon]]')).toEqual([]);
  });

  it('refuses a wrong word used in two packs', () => {
    expect(across('[[three mugs|five mugs]]', '[[three jars|two jars]]')).toContain('substitution 1 of pack A and 1 of pack B: the same wrong word');
  });

  it('refuses a pair used reversed', () => {
    expect(across('[[violet|maroon]]', '[[maroon|violet]]')).toContain('substitution 1 of pack A and 1 of pack B: the same pair reversed');
  });

  it('refuses the same counted noun in two packs', () => {
    expect(across('[[three mugs|five mugs]]', '[[nine mugs|two mugs]]')).toContain('substitution 1 of pack A and 1 of pack B: the same unchanged word in the phrase');
  });

  it('refuses the same two words before the wrong phrase', () => {
    const a = `${filler(10)} A box holds [[three jars|ten jars]] ${words(5, 'a', 8)}. ${filler(10)}\n`;
    const b = `${filler(10, 'b')} A box holds [[two cans|six cans]] ${words(5, 'b', 8)}. ${filler(10, 'b')}\n`;
    expect(crossPackProblems([pack('A', a), pack('C', b)]).map((p) => p.message)).toContain(
      'substitution 1 of pack A and 1 of pack C: the same two words before the wrong phrase',
    );
  });

  it('keeps each class of fact (weekdays, months, seasons, times of day, directions) to one pack, and its name out of the blind message', () => {
    expect(wordClassOf('Monday')).toBe('weekday');
    expect(wordClassOf('south')).toBe('direction');
    expect(wordClassOf('walrus')).toBeUndefined();
    const problems = acrossProblems('[[downstream|upward]]', '[[north|south]]');
    expect(problems.map((p) => p.message)).toContain('substitution 1 of pack A and 1 of pack B: both change a word of one class of fact');
    expect(problems.map((p) => p.detail)).toContain('direction: north');
    for (const line of blind(problems)) for (const c of Object.keys(WORD_CLASSES)) expect(line).not.toContain(c);
    expect(across('[[midnight|sunset]]', '[[Monday|Friday]]')).toEqual([]);
  });

  it('refuses a run of eight words in two passages', () => {
    const run = 'the robot hauled the dented metal bowls into the garage';
    const a = `${filler(10)} ${run} and saw ${words(2)} [[three|five]] ${words(5, 'a', 8)}. ${filler(10)}\n`;
    const b = { id: 'B' as PackId, listen: parsePassage(`${filler(10, 'b')} Then ${run} once more.\n`, false) };
    const problems = crossPackProblems([pack('A', a), b]);
    expect(problems.map((p) => p.message)).toEqual(['the objections passage of pack A and the listen passage of pack B share a run of 8 words']);
    expect(problems[0]?.packs).toEqual(['A', 'B']);
  });

  it('reads changed words in lower case', () => {
    expect(changedWords('Three Mugs', 'five mugs')).toEqual(['three']);
  });
});

describe('published examples (spec 9.2; review 11)', () => {
  it('reads quoted prose of three words or more from a document, not names of files or code', () => {
    const doc = 'He said "an octopus has nine arms" and “the reef is made of syrup”, or «two plus two is five»; not "x.json is here", "two words", "`npm run tts`" or "bay 9 is ajar".';
    expect(quotedExamples(doc)).toEqual(['an octopus has nine arms', 'the reef is made of syrup', 'two plus two is five']);
  });

  it('takes the example of spec 9.2 and the quoted examples of the documents the participant reads', () => {
    const doc = join(tempDir('gate-docs-'), 'README.md');
    writeFileSync(doc, 'Example: "An octopus has nine arms."\n');
    expect(publishedExamples([doc, join(doc, 'missing.md')])).toEqual([...SPEC_EXAMPLES, 'an octopus has nine arms.']);
    const files = publishedDocFiles(REPO_ROOT).map((f) => f.slice(REPO_ROOT.length + 1));
    expect(files).toContain('PREREG.md');
    expect(files).toContain('README.md');
    expect(files).toContain('gate/README.md');
    expect(files).not.toContain('gate/NOTES.md');
    expect(files.some((f) => f.includes('node_modules') || f.startsWith('.'))).toBe(false);
  });

  it('refuses a substitution that shares two content words with an example: the same fact, with or without its number', () => {
    const examples = ['an octopus has nine arms'];
    const sub = (markup: string, tail = 'and hides in caves'): Passage => parsePassage(`${filler(10)} By the reef every octopus has ${markup} ${tail}. ${filler(10)}\n`, true);
    const hit = 'substitution 1: repeats an example error quoted in the spec or a document the participant reads (spec 9.2)';
    expect(messages(publishedExampleFindings(sub('[[nine arms|eight arms]]'), examples))).toEqual([hit]);
    expect(messages(publishedExampleFindings(sub('[[sixteen arms|eight arms]]'), examples))).toEqual([hit]);
    expect(messages(publishedExampleFindings(sub('[[nine eyes|two eyes]]'), examples))).toEqual([hit]);
    expect(publishedExampleFindings(sub('[[thirteen eyes|two eyes]]'), examples)).toEqual([]);
    expect(publishedExampleFindings(parsePassage(oneSub('[[nine mugs|two mugs]]'), true), examples)).toEqual([]);
    expect(factWord('Arms')).toBe('arm');
    expect(factWord('moss')).toBe('moss');
  });

  it('keeps the example out of the blind message', () => {
    const [f] = publishedExampleFindings(parsePassage(`${filler(10)} The diver said an octopus has [[nine arms|eight arms]] ${words(4)}. ${filler(10)}\n`, true), ['an octopus has nine arms']);
    expect(f?.message).not.toMatch(/octopus|arms|\bnine\b/);
    expect(f?.detail).toContain('an octopus has nine arms');
  });

  it('reports a pack that repeats an example of a document it is given', () => {
    const gate = tempGate();
    const p = objectionsOf(gate, 'B');
    // A document that quotes a substitution of pack B with the two words before it: the first one
    // whose quote holds enough content words, chosen at run time.
    const quoteOf = (s: Substitution): string => [...p.words.slice(s.firstWordIndex - 2, s.firstWordIndex), s.wrong].join(' ');
    const s = p.substitutions.find((x) => contentWords(quoteOf(x)).size >= EXAMPLE_SHARED_WORDS);
    if (s === undefined) throw new Error('no substitution of pack B to quote');
    const doc = join(tempDir('gate-docs-'), 'README.md');
    writeFileSync(doc, `An error such as "${quoteOf(s)}" is obvious.\n`);
    const repeats = 'repeats an example error quoted in the spec or a document the participant reads (spec 9.2)';
    const lines = blind(checkGate({ gateDir: gate, publishedDocs: [doc] }).problems);
    expect(lines).toContain(`pack B objections: substitution ${s.n}: ${repeats}`);
    expect(lines.every((l) => l.startsWith('pack B objections: substitution ') && l.endsWith(repeats))).toBe(true);
  });
});

describe('cue rules (spec 9.2)', () => {
  const ok = [17_000, 35_000, 54_000];

  it('takes spec limits at their bounds and refuses 1 ms outside them', () => {
    const lim = SPEC_CUE_LIMITS_MS;
    expect(checkCueRules([15_000, 31_000, 55_000], 65_000, lim)).toEqual([]);
    expect(messages(checkCueRules([14_999, 31_000], 41_000, lim))).toEqual(['the first cue comes before 15.00 s']);
    expect(messages(checkCueRules([15_000, 30_999], 41_000, lim))).toEqual(['the interval from cue 1 to cue 2 is outside 16.00 to 24.00 s']);
    expect(messages(checkCueRules([15_000, 39_001], 50_000, lim))).toEqual(['the interval from cue 1 to cue 2 is outside 16.00 to 24.00 s']);
    expect(messages(checkCueRules([249_000, 265_001], 280_000, lim))).toEqual(['the last cue comes after 265.00 s']);
    expect(messages(checkCueRules(ok, 63_999, lim))).toEqual(['less than 10.00 s of reading after the last cue']);
    expect(messages(checkCueRules([], 1, lim))).toEqual(['no cues']);
  });

  it('keeps times out of the blind message', () => {
    const [f] = checkCueRules([14_321, 31_000], 41_000, SPEC_CUE_LIMITS_MS);
    expect(f?.message).not.toContain('14.32');
    expect(f?.detail).toBe('14.32 s');
  });

  it('design limits keep 1.5 s of room: a render up to 0.75 s off each predicted cue still passes spec 9.2', () => {
    const lim = DESIGN_CUE_LIMITS_MS;
    const plan = fc
      .tuple(
        fc.integer({ min: lim.firstMin, max: lim.firstMin + 5_000 }),
        fc.array(fc.integer({ min: lim.intervalMin, max: lim.intervalMax }), { minLength: 1, maxLength: 13 }),
      )
      .map(([first, gaps]) => gaps.reduce((cues, g) => [...cues, (cues[cues.length - 1] ?? 0) + g], [first]))
      .filter((cues) => (cues[cues.length - 1] ?? 0) <= lim.lastMax);
    fc.assert(
      fc.property(plan, fc.array(fc.integer({ min: -750, max: 750 }), { minLength: 14, maxLength: 14 }), (cues, jitter) => {
        const end = (cues[cues.length - 1] ?? 0) + lim.tailMin;
        expect(checkCueRules(cues, end, lim)).toEqual([]);
        const real = cues.map((c, i) => c + (jitter[i] ?? 0));
        expect(checkCueRules(real, end + 750, SPEC_CUE_LIMITS_MS)).toEqual([]);
      }),
      { numRuns: 200 },
    );
  });

  it('wants intervals spread over 3 s and different rhythms in A, B and C', () => {
    expect(messages(intervalSpreadFindings([20_000, 38_000, 56_000, 74_000]))).toEqual(['the intervals spread over less than 3.00 s']);
    expect(intervalSpreadFindings([20_000, 38_000, 59_000, 77_000])).toEqual([]);
    const a = Array.from({ length: 14 }, (_x, i) => 17_000 + i * 18_500 + (i % 3) * 1_200);
    const shifted = a.map((t) => t + 2_500);
    const problems = placementProblems({ A: a, B: shifted }, 'predicted');
    expect(problems.map((p) => p.message)).toEqual(['predicted: 0 intervals differ by 1.00 s or more, need 6']);
    expect(problems[0]?.packs).toEqual(['A', 'B']);
    expect(placementProblems({ A: a, B: a }, 'real').map((p) => p.message)).toEqual([
      'real: 0 cue times differ by 2.00 s or more, need 12',
      'real: 0 intervals differ by 1.00 s or more, need 6',
    ]);
  });
});

describe('predicted and real timings (review 1, 4 and 8)', () => {
  it('marks predicted timings out of date when the spoken text changes', () => {
    const gate = tempGate();
    const file = join(gate, 'pack-A', 'listen.txt');
    writeFileSync(file, `Then ${readFileSync(file, 'utf8')}`);
    expect(blind(checkGate({ gateDir: gate }).problems)).toContain('pack A listen: listen.predicted.json is out of date (run gate/predict_timings.py)');
  });

  it('reads predicted.json and refuses other files', () => {
    expect(() => parsePredicted({ schema: 'gate-predicted/2' })).toThrow(/schema/);
    expect(() => parsePredicted({ schema: 'gate-predicted/1', spokenSha256: 'abc' })).toThrow(/SHA-256/);
  });

  it('compares real word times with the prediction', () => {
    const pack = loadPack(GATE_DIR, PACK_SPECS[0]!);
    const predicted = pack.predicted.objections;
    if (typeof predicted !== 'object') throw new Error('no predicted timings');
    const t = predicted.timings;
    expect(timingAgreement(t, t, 0)).toEqual([]);
    const skewed = { ...t, words: t.words.map((w, k) => (k === 3 ? { ...w, endMs: w.endMs + 60 } : w)) };
    expect(messages(timingAgreement(skewed, t, 50))[0]).toMatch(/^1 word times differ from the prediction by more than 50 ms/);
    expect(timingAgreement(skewed, t, 60)).toEqual([]);
    expect(messages(timingAgreement({ ...t, words: t.words.slice(1) }, t, 50))).toEqual([`the render has ${t.words.length - 1} words, the prediction ${t.words.length}`]);
    expect(cueTimesMs(t, pack.passages.objections!.substitutions)).toHaveLength(2);
  });

  it('equal a real render word for word: the committed fixture of a short passage (review 8)', () => {
    // gate/fixtures/render: a neutral passage of two paragraphs rendered by npm run tts, and its
    // timings from gate/predict_timings.py --text. The WAV file is not committed.
    const dir = join(GATE_DIR, 'fixtures', 'render');
    const text = readFileSync(join(dir, 'passage.txt'), 'utf8');
    const real = parseTimings(JSON.parse(readFileSync(join(dir, 'real.timings.json'), 'utf8')));
    const predicted = parsePredicted(JSON.parse(readFileSync(join(dir, 'passage.predicted.json'), 'utf8')));
    expect(predicted.spokenSha256).toBe(sha256Hex(spokenText(text)));
    expect(real.words.length).toBeGreaterThan(100);
    expect(timingAgreement(real, predicted.timings, 0)).toEqual([]);
    expect(real.durationSamples).toBe(predicted.timings.durationSamples);
    expect(real.engine).toEqual(predicted.timings.engine);
    // Rendered under the time rule tools/tts uses now (word edges on kokoro's pauses, README "Times").
    expect(real.engine.timeRule).toBe(TIME_RULE);
    expect(wordNumberingProblems(spokenText(text), parsePassage(text, false).words)).toEqual([]);
    // The pack timings come from the same engine and lock as this render.
    for (const spec of PACK_SPECS) {
      for (const p of Object.values(loadPack(GATE_DIR, spec).predicted)) {
        if (typeof p !== 'object') throw new Error(`pack ${spec.id}: ${String(p)}`);
        expect(p.timings.engine).toEqual(real.engine);
      }
    }
  });

  it('reads the length and sample format of a WAV file', () => {
    expect(wavInfo(silentWav(480))).toEqual({ sampleRateHz: 48_000, channels: 1, frames: 480, formatTag: 1, bitsPerSample: 16 });
    expect(wavInfo(silentWav(480, 48_000, 'float32'))).toEqual({ sampleRateHz: 48_000, channels: 1, frames: 480, formatTag: 3, bitsPerSample: 32 });
    expect(() => wavInfo(Buffer.from('not a wav file at all'))).toThrow(/RIFF/);
    expect(() => wavInfo(silentWav(480).subarray(0, 100))).toThrow(/cut short/);
  });
});

describe('build after the render: cues.json and pack.json (review 4 and 7)', () => {
  it('writes cues.json and a pack.json host reads, and checkGate verifies them afterwards', () => {
    const gate = tempGate();
    fakeRender(gate, '0');
    const result = buildPacks({ gateDir: gate });
    expect(blind(result.problems)).toEqual([]);
    expect(result.outcomes.map((o) => [o.pack, o.rendered, o.built])).toEqual([
      ['0', true, true],
      ['A', false, false],
      ['B', false, false],
      ['C', false, false],
    ]);
    const dir = join(gate, 'pack-0');
    const pack = loadPack(gate, PACK_SPECS[0]!);
    const predicted = pack.predicted.objections;
    if (typeof predicted !== 'object') throw new Error('no predicted timings');
    const cuesText = readFileSync(join(dir, 'cues.json'), 'utf8');
    expect(cuesText === formatCuesJson(cueTimesMs(predicted.timings, pack.passages.objections!.substitutions))).toBe(true);
    expect(result.outcomes[0]?.cuesSha256).toBe(sha256Hex(cuesText));

    const listing = packListing(JSON.parse(readFileSync(join(dir, 'pack.json'), 'utf8')));
    for (const name of ['cues.json', 'listen.wav', 'objections.wav', 'listen.timings.json', 'objections.timings.json']) {
      expect(listing.get(name)).toBe(sha256Hex(readFileSync(join(dir, name))));
    }
    expect(checkGate({ gateDir: gate }).problems).toEqual([]);

    // A same-length edit of a wrong word after the build no longer passes silently.
    const objections = join(dir, 'objections.txt');
    writeFileSync(objections, replaceMarkup(readFileSync(objections, 'utf8'), 1, (wrong, right) => `[[${'z'.repeat(wrong.length)}|${right}]]`));
    expect(blind(checkGate({ gateDir: gate }).problems)).toContain('pack 0 build: the objections text changed after the build: render it again, then run --build');
  });

  it('notices a served file that changed after the build', () => {
    const gate = tempGate();
    fakeRender(gate, '0');
    buildPacks({ gateDir: gate });
    const wav = join(gate, 'pack-0', 'listen.wav');
    const bytes = readFileSync(wav);
    bytes[100] = 1;
    writeFileSync(wav, bytes);
    expect(blind(checkGate({ gateDir: gate }).problems)).toEqual(['pack 0 build: listen.wav does not match its SHA-256 in pack.json (run --build)']);
  });

  it('writes nothing for a pack whose text breaks a rule, even with good timings (review 7)', () => {
    const gate = tempGate();
    fakeRender(gate, '0');
    // The right phrase is never spoken, so the predicted timings stay valid. Make it a word spoken
    // a few words after substitution 2 (chosen at run time from the pack's own text).
    const p = objectionsOf(gate, '0');
    const s = p.substitutions[1]!;
    const used = new Set(p.substitutions.flatMap((x) => [...changedWords(x.wrong, x.right), ...changedWords(x.right, x.wrong)]));
    const near = p.words
      .slice(s.lastWordIndex + 1, s.lastWordIndex + 12)
      .map((w) => w.toLowerCase())
      .find((w) => w.length >= 4 && w[0] !== s.wrong.toLowerCase()[0] && !used.has(w) && wordClassOf(w) === undefined);
    if (near === undefined) throw new Error('no word to use near substitution 2');
    const objections = join(gate, 'pack-0', 'objections.txt');
    writeFileSync(objections, replaceMarkup(readFileSync(objections, 'utf8'), 2, (wrong) => `[[${wrong}|${near}]]`));
    const result = buildPacks({ gateDir: gate });
    expect(result.outcomes[0]).toEqual({ pack: '0', rendered: true, built: false });
    expect(result.problems.some((x) => /^substitution 2: the right word is spoken \d+ words away, closer than 50$/.test(x.message))).toBe(true);
    expect(existsSync(join(gate, 'pack-0', 'cues.json'))).toBe(false);
    expect(existsSync(join(gate, 'pack-0', 'pack.json'))).toBe(false);
  });

  it('refuses a render that differs from the prediction, unless the tolerance allows it', () => {
    const gate = tempGate();
    fakeRender(gate, '0');
    const file = join(gate, 'pack-0', 'objections.timings.json');
    const t = readTimings(file);
    t.words[0]!.startMs += 100;
    writeFileSync(file, JSON.stringify(t));
    const refused = buildPacks({ gateDir: gate });
    expect(refused.outcomes[0]?.built).toBe(false);
    expect(refused.problems.map((p) => p.message)[0]).toMatch(/^1 word times differ from the prediction by more than 50 ms/);
    expect(buildPacks({ gateDir: gate, toleranceMs: 100 }).outcomes[0]?.built).toBe(true);
  });

  it('checks the real clip lengths and the real cues against spec 9.2 itself (review 1 and 2)', () => {
    const gate = tempGate();
    fakeRender(gate, '0');
    const dir = join(gate, 'pack-0');
    // A listening clip 0.5 s longer than the 30 s block of the probe.
    const listen = readTimings(join(dir, 'listen.timings.json'));
    listen.durationSamples = 30_500 * 48;
    listen.durationMs = 30_500;
    writeFileSync(join(dir, 'listen.timings.json'), JSON.stringify(listen));
    writeFileSync(join(dir, 'listen.wav'), silentWav(listen.durationSamples));
    // An objection render that reads a fifth quicker: cue 1 before 15 s, the interval under 16 s.
    const objections = readTimings(join(dir, 'objections.timings.json'));
    for (const w of objections.words) {
      w.startMs = Math.round(w.startMs * 0.8);
      w.endMs = Math.round(w.endMs * 0.8);
    }
    writeFileSync(join(dir, 'objections.timings.json'), JSON.stringify(objections));
    const result = buildPacks({ gateDir: gate, toleranceMs: 100_000, preregFile: preregWith({}) });
    expect(result.outcomes[0]?.built).toBe(false);
    expect(blind(result.problems)).toEqual([
      'pack 0 listen render: the listen clip is outside 0.00 to 30.00 s',
      'pack 0 real cues: the first cue comes before 15.00 s',
      'pack 0 real cues: the interval from cue 1 to cue 2 is outside 16.00 to 24.00 s',
    ]);
    expect(existsSync(join(dir, 'cues.json'))).toBe(false);
  });

  it('places the real cues of A, B and C differently too (review 3)', () => {
    const gate = tempGate();
    for (const id of ['A', 'B'] as const) fakeRender(gate, id);
    const cuesOf = (id: PackId): number[] => checkGate({ gateDir: gate, verifyBuild: false }).predictedCues[id]!;
    const a = cuesOf('A');
    const b = cuesOf('B');
    // A render of B whose reading speed drifts so that its cues land exactly on those of A:
    // a piecewise linear warp of time through the cues, shifted after the last one.
    const from = [0, ...b];
    const to = [0, ...a];
    const warp = (ms: number): number => {
      const k = from.findIndex((t, i) => ms <= t && i > 0);
      if (k < 0) return Math.round(ms + to[to.length - 1]! - from[from.length - 1]!);
      return Math.round(to[k - 1]! + ((ms - from[k - 1]!) * (to[k]! - to[k - 1]!)) / (from[k]! - from[k - 1]!));
    };
    const file = join(gate, 'pack-B', 'objections.timings.json');
    const t = readTimings(file);
    for (const w of t.words) {
      w.startMs = warp(w.startMs);
      w.endMs = warp(w.endMs);
    }
    t.durationMs += 2_000;
    t.durationSamples = t.durationMs * 48;
    writeFileSync(file, JSON.stringify(t));
    writeFileSync(join(gate, 'pack-B', 'objections.wav'), silentWav(t.durationSamples));
    const result = buildPacks({ gateDir: gate, toleranceMs: 100_000, preregFile: preregWith({}) });
    expect(blind(result.problems)).toEqual([
      'packs A and B: real: 0 cue times differ by 2.00 s or more, need 12',
      'packs A and B: real: 0 intervals differ by 1.00 s or more, need 6',
    ]);
    expect(result.outcomes.map((o) => [o.pack, o.rendered, o.built])).toEqual([
      ['0', false, false],
      ['A', true, false],
      ['B', true, false],
      ['C', false, false],
    ]);
  });

  it('refuses a WAV file that does not match its timings', () => {
    const gate = tempGate();
    fakeRender(gate, '0');
    writeFileSync(join(gate, 'pack-0', 'listen.wav'), silentWav(48_000));
    const result = buildPacks({ gateDir: gate });
    expect(result.outcomes[0]?.built).toBe(false);
    expect(blind(result.problems)).toEqual(['pack 0 listen render: listen.wav does not match listen.timings.json (rate, channels or length)']);
  });

  it('refuses the 32-bit float WAV of tools/tts until it is stored as 16-bit PCM', () => {
    const gate = tempGate();
    fakeRender(gate, '0');
    const file = join(gate, 'pack-0', 'objections.wav');
    const frames = wavInfo(readFileSync(file)).frames;
    writeFileSync(file, silentWav(frames, 48_000, 'float32'));
    const result = buildPacks({ gateDir: gate });
    expect(result.outcomes[0]?.built).toBe(false);
    expect(blind(result.problems)).toEqual(['pack 0 objections render: objections.wav is not 16-bit PCM (store it with npx tsx gate/render-packs.ts --convert)']);
  });

  it('refuses a second, readable copy of the cue list or any other stray file in a pack folder (review 4)', () => {
    const gate = tempGate();
    writeFileSync(join(gate, 'pack-A', 'cues.estimate.json'), '[17000]\n');
    writeFileSync(join(gate, 'pack-C', 'cues.json.tmp'), '[]\n');
    writeFileSync(join(gate, 'pack-B', '.DS_Store'), '');
    expect(blind(checkGate({ gateDir: gate }).problems)).toEqual([
      'pack A: cues.estimate.json does not belong in the pack folder: remove it',
      'pack C: cues.json.tmp does not belong in the pack folder: remove it',
    ]);
  });

  it('checks cues.json without pack.json and a stale objections.spoken.txt', () => {
    const gate = tempGate();
    writeFileSync(join(gate, 'pack-A', 'cues.json'), '[]\n');
    expect(writeSpokenTexts(gate)).toHaveLength(4);
    writeFileSync(join(gate, 'pack-B', 'objections.spoken.txt'), 'stale text\n');
    expect(readFileSync(join(gate, 'pack-C', 'objections.spoken.txt'), 'utf8') === spokenText(readFileSync(join(gate, 'pack-C', 'objections.txt'), 'utf8'))).toBe(true);
    expect(blind(checkGate({ gateDir: gate, preregFile: preregWith({}) }).problems)).toEqual([
      'pack A build: cues.json exists without pack.json (run --build)',
      'pack B build: objections.spoken.txt is out of date (run --spoken)',
    ]);
  });
});

describe('the cue hashes of PREREG.md bind every later build (spec 9.2, 13.6; review 12)', () => {
  const builtPack0 = (): { gate: string; dir: string; cuesSha: string } => {
    const gate = tempGate();
    fakeRender(gate, '0');
    expect(buildPacks({ gateDir: gate }).outcomes[0]?.built).toBe(true);
    const dir = join(gate, 'pack-0');
    return { gate, dir, cuesSha: sha256Hex(readFileSync(join(dir, 'cues.json'))) };
  };
  /** Moves the end of the cue word of substitution 1 by 30 ms: within the tolerance, but another cues.json. */
  const moveCue = (gate: string): void => {
    const file = join(gate, 'pack-0', 'objections.timings.json');
    const t = readTimings(file);
    t.words[objectionsOf(gate, '0').substitutions[0]!.lastWordIndex]!.endMs -= 30;
    writeFileSync(file, JSON.stringify(t));
  };
  const refusal = 'pack 0 build: the new cues.json differs from the SHA-256 that PREREG.md holds for it: after the gate-prereg tag cues.json stays byte for byte the same (spec 9.2, 13.6)';

  it('reads the hash rows as tools/freeze does: a placeholder binds nothing', () => {
    expect(preregCueHashes(preregWith({}))).toEqual({});
    expect(preregCueHashes(preregWith({ A: 'a'.repeat(64) }))).toEqual({ A: ['a'.repeat(64)] });
    expect(preregCueHashes(join(tempDir('gate-prereg-'), 'none.md'))).toEqual({});
    // The repository's PREREG.md: rows for every pack, hashes or placeholders.
    expect(Object.keys(preregCueHashes()).every((id) => ['0', 'A', 'B', 'C'].includes(id))).toBe(true);
  });

  it('rebuilds a pack whose cues.json keeps the hash PREREG.md holds', () => {
    const { gate, dir, cuesSha } = builtPack0();
    const prereg = preregWith({ '0': cuesSha });
    expect(buildPacks({ gateDir: gate, preregFile: prereg }).outcomes[0]?.built).toBe(true);
    expect(sha256Hex(readFileSync(join(dir, 'cues.json')))).toBe(cuesSha);
    expect(checkGate({ gateDir: gate, preregFile: prereg }).problems).toEqual([]);
  });

  it('refuses a build that would change cues.json after its hash is in PREREG.md, and leaves the built files as they were', () => {
    const { gate, dir, cuesSha } = builtPack0();
    const packJson = readFileSync(join(dir, 'pack.json'));
    moveCue(gate);
    const prereg = preregWith({ '0': cuesSha });
    const refused = buildPacks({ gateDir: gate, preregFile: prereg });
    expect(refused.outcomes[0]?.built).toBe(false);
    expect(blind(refused.problems)).toEqual([refusal]);
    expect(sha256Hex(readFileSync(join(dir, 'cues.json')))).toBe(cuesSha);
    expect(readFileSync(join(dir, 'pack.json')).equals(packJson)).toBe(true);
    // With the placeholder the same render builds, with another cue hash.
    const built = buildPacks({ gateDir: gate, preregFile: preregWith({}) });
    expect(built.outcomes[0]?.built).toBe(true);
    expect(built.outcomes[0]?.cuesSha256).not.toBe(cuesSha);
    // And the checker then reports the cue list PREREG.md does not hold.
    expect(blind(checkGate({ gateDir: gate, preregFile: prereg }).problems)).toEqual([
      'pack 0 build: cues.json differs from the SHA-256 that PREREG.md holds for it: after the gate-prereg tag cues.json stays byte for byte the same (spec 9.2, 13.6)',
    ]);
    const r = main(['--prereg', prereg], () => undefined, () => undefined, gate);
    expect(r).toBe(1);
  });
});

describe('command line (review 5 and 10)', () => {
  const run = (argv: string[], gateDir = GATE_DIR): { code: number; out: string[]; err: string[] } => {
    const out: string[] = [];
    const err: string[] = [];
    const code = main(argv, (l) => out.push(l), (l) => err.push(l), gateDir);
    return { code, out, err };
  };

  it('prints no word of the passages and no cue time by default', () => {
    const { code, out } = run([]);
    expect(code).toBe(0);
    expect(out).toEqual(['pack 0: OK, 2 substitutions', 'pack A: OK, 14 substitutions', 'pack B: OK, 14 substitutions', 'pack C: OK, 14 substitutions', 'OK: 4 packs pass every rule.']);
  });

  it('shows the substitutions and cue times only with --show-text (compared by count, not by content)', () => {
    const shown = run(['--show-text']).out;
    const total = PACK_SPECS.reduce((n, s) => n + s.substitutions, 0);
    expect(shown.filter((l) => /^ {2}\d+\. [A-Za-z ]+ \| [A-Za-z ]+$/.test(l)).length).toBe(total);
    expect(shown.filter((l) => /^ {2}cues \(s\): \d+\.\d\d( \d+\.\d\d)*$/.test(l)).length).toBe(PACK_SPECS.length);
    expect(run([]).out.some((l) => /\d+\.\d\d/.test(l))).toBe(false);
  });

  it('exits 2 when a flag lacks its value or gets another flag instead', () => {
    for (const argv of [['--banned'], ['--allow'], ['--prereg'], ['--banned', '--allow', 'x.txt'], ['--tolerance-ms'], ['--tolerance-ms', 'ten'], ['--tolerance-ms', '-5'], ['--nope']]) {
      const r = run(argv);
      expect(r.code, argv.join(' ')).toBe(2);
      expect(r.out).toEqual([]);
    }
  });

  it('uses the banned list it is given, and keeps the word out of the blind output', () => {
    const gate = tempGate();
    // A word of pack A's objection passage that no other file of the folder holds, chosen at run time.
    const rel = 'pack-A/objections.txt';
    const files = PACK_SPECS.flatMap((s) => readdirSync(join(gate, `pack-${s.id}`)).map((n) => `pack-${s.id}/${n}`));
    const text = readFileSync(join(gate, rel), 'utf8').toLowerCase();
    const otherTexts = files.filter((f) => f !== rel).map((f) => readFileSync(join(gate, f), 'utf8').toLowerCase());
    const word = [...new Set(splitWords(text))].filter((w) => w.length >= 6).find((w) => !otherTexts.some((o) => o.includes(w)));
    if (word === undefined) throw new Error('no word only in that passage');
    const lines = text.split('\n').flatMap((l, i) => (l.includes(word) ? [i + 1] : []));
    const banned = join(tempDir('gate-banned-'), 'banned.txt');
    writeFileSync(banned, `${word}\n`);
    const r = run(['--banned', banned], gate);
    expect(r.code).toBe(1);
    expect(r.out).toEqual([
      'pack 0: OK, 2 substitutions',
      `pack A: FAIL (${lines.length} problem(s)), 14 substitutions`,
      'pack B: OK, 14 substitutions',
      'pack C: OK, 14 substitutions',
      `${lines.length} problem(s):`,
      ...lines.map((n) => `- ${rel}:${n}: a banned word (spec 13.6)`),
    ]);
    expect(r.out.some((l) => l.toLowerCase().includes(word))).toBe(false);
    expect(run(['--banned', banned, '--show-text'], gate).out.some((l) => l.endsWith(`a banned word (spec 13.6) [${word}]`))).toBe(true);
  });

  it('writes the spoken texts into the folder it checks', () => {
    const gate = tempGate();
    const r = run(['--spoken'], gate);
    expect(r.code).toBe(0);
    expect(r.out.filter((l) => l.startsWith('wrote '))).toHaveLength(4);
    expect(existsSync(join(gate, 'pack-B', 'objections.spoken.txt'))).toBe(true);
    expect(run(['--build'], gate).out).toEqual(['pack 0: not rendered yet', 'pack A: not rendered yet', 'pack B: not rendered yet', 'pack C: not rendered yet']);
  });
});

describe('banned words (spec 13.6)', () => {
  // Test lists of made-up and harmless words: this file is scanned too, against the real list.
  it('scans the module files, Python included, and leaves gate/level to its own module', () => {
    const gate = tempGate();
    const banned = join(gate, 'banned.txt');
    writeFileSync(banned, 'quokka\nwombat\n');
    writeFileSync(join(gate, 'notes.py'), '# no quokka here\n');
    mkdirSync(join(gate, 'level'));
    writeFileSync(join(gate, 'level', 'level.txt'), 'quokka\n');
    mkdirSync(join(gate, 'fixtures'));
    writeFileSync(join(gate, 'fixtures', 'passage.txt'), 'One line.\nA wombat.\n');
    writeFileSync(join(gate, 'pack-A', 'objections.txt'), `quokka ${readFileSync(join(gate, 'pack-A', 'objections.txt'), 'utf8')}`);
    const problems = checkGate({ gateDir: gate, bannedFile: banned }).problems.filter((p) => p.message === 'a banned word (spec 13.6)');
    expect(problems.map((p) => p.where).sort()).toEqual(['banned.txt:1', 'banned.txt:2', 'fixtures/passage.txt:2', 'notes.py:1', 'pack-A/objections.txt:1']);
    expect(problems.find((p) => p.where === 'pack-A/objections.txt:1')?.packs).toEqual(['A']);
  });

  it('allows an exact phrase from the allow list', () => {
    const gate = tempGate();
    const banned = join(gate, 'banned.txt');
    const allow = join(gate, 'allow.txt');
    writeFileSync(banned, 'quokka\n');
    writeFileSync(allow, 'a quokka is a small animal\n');
    writeFileSync(join(gate, 'notes.py'), '# a quokka is a small animal\n# one quokka\n');
    const problems = checkGate({ gateDir: gate, bannedFile: banned, allowFile: allow }).problems.filter((p) => p.message === 'a banned word (spec 13.6)');
    expect(problems.map((p) => p.where).sort()).toEqual(['banned.txt:1', 'notes.py:2']);
  });
});
