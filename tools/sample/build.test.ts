// tools/sample/build.ts on synthetic renders (tools/sample/synthetic.ts): the 16-bit clips at the
// loudness of the level sample, one timings-set/1 file over the stored clips (npm run tts -- --set),
// plan.json, a refused build that leaves sample/ as it was, and output that stays blind on failure
// unless --show-text asks for the words and times behind each problem.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readWavFormat } from '../../gate/level/wav16.ts';
import { loadList } from '../lint-words.ts';
import { main as runTts, nodeDeps } from '../tts/run.ts';
import { parseTimingsSet } from '../tts/timings.ts';
import { BUILT_FILES, SHOW_TEXT_HINT, bannedWordFindings, buildSample, main, type BuildDeps } from './build.ts';
import { SAMPLE_PASSAGE_IDS, readErrorSpecs, textFileOf, type SamplePassageId, type SamplePlan } from './plan.ts';
import { floatWav, pacedTimings, passageText, pcm16Wav, sentence, syntheticSample, tone } from './synthetic.ts';

const sha256 = (b: Uint8Array): string => createHash('sha256').update(b).digest('hex');
const WORDS = join(import.meta.dirname, '..', 'words');
const banned = loadList(join(WORDS, 'banned.txt'));
const allowed = loadList(join(WORDS, 'allow.txt'));

describe('tools/sample/build.ts', () => {
  let root: string;
  let sampleDir: string;
  let renderDir: string;
  let lines: string[];
  let deps: BuildDeps;

  /** A new text for one clip, and the render's word timings for it (the same words keep the same WAV). */
  const setText = (id: SamplePassageId, text: string): void => {
    writeFileSync(join(sampleDir, textFileOf(id)), text);
    writeFileSync(join(renderDir, `${id}.timings.json`), `${JSON.stringify(pacedTimings(text), null, 2)}\n`);
  };

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'copyholder-sample-test-'));
    sampleDir = join(root, 'sample');
    renderDir = join(root, 'render');
    mkdirSync(join(sampleDir, 'texts'), { recursive: true });
    mkdirSync(renderDir);
    const s = syntheticSample();
    for (const id of SAMPLE_PASSAGE_IDS) {
      setText(id, s.texts[id]);
      writeFileSync(join(renderDir, `${id}.wav`), floatWav(tone(pacedTimings(s.texts[id]).durationSamples, 0.1)));
    }
    writeFileSync(join(sampleDir, 'plan.json'), `${JSON.stringify({ errors: s.specs }, null, 2)}\n`);
    writeFileSync(join(root, 'level.wav'), pcm16Wav(tone(48_000, 0.08)));
    lines = [];
    deps = {
      sampleDir,
      levelWav: join(root, 'level.wav'),
      bannedWords: banned,
      allowedWords: allowed,
      makeWorkDir: () => mkdtempSync(join(root, 'work-')),
      joinTimings: (args, log) => runTts(['--set', ...args], { ...nodeDeps(), out: log, err: log }),
      out: (l) => lines.push(l),
      err: (l) => lines.push(l),
    };
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('stores 16-bit clips, one timings set over them and the plan, then removes its work folder', async () => {
    expect(await buildSample(renderDir, deps)).toBe(0);
    expect(lines).toContain('TTS SET OK 3 passages');
    expect(lines.at(-1)).toBe('SAMPLE OK: opening.wav, p1.wav, p2.wav, timings.json, plan.json written to sample/');
    const set = parseTimingsSet(JSON.parse(readFileSync(join(sampleDir, 'timings.json'), 'utf8')));
    expect(set.passages.map((p) => p.passageId)).toEqual(['opening', 'p1', 'p2']);
    for (const p of set.passages) {
      const wav = new Uint8Array(readFileSync(join(sampleDir, `${p.passageId}.wav`)));
      expect(readWavFormat(wav)).toMatchObject({ format: 1, bitsPerSample: 16, channels: 1, sampleRateHz: 48_000, frames: p.timings.durationSamples });
      expect(p.audioSha256).toBe(sha256(wav));
    }
    const plan = JSON.parse(readFileSync(join(sampleDir, 'plan.json'), 'utf8')) as SamplePlan;
    expect(plan.schema).toBe('sample-plan/1');
    expect(plan.passages.map((p) => p.audio_sha256)).toEqual(set.passages.map((p) => p.audioSha256));
    expect(plan.passages[0]!.text_sha256).toBe(sha256(new Uint8Array(readFileSync(join(sampleDir, 'texts', 'opening.txt')))));
    expect(plan.errors.map((e) => e.word_start)).toEqual([39, 88, 136, 39, 99]);
    expect(readErrorSpecs(plan)).toEqual(syntheticSample().specs);
    // the output is blind: counts, lengths and levels, never a word of the texts
    for (const word of ['beta', 'gamma', 'theta', 'Plain']) expect(lines.join('\n')).not.toContain(word);
    expect(readdirSync(root).filter((n) => n.startsWith('work-'))).toEqual([]);
    // a second build of the same renders gives the same bytes
    const before = BUILT_FILES.map((n) => sha256(new Uint8Array(readFileSync(join(sampleDir, n)))));
    expect(await buildSample(renderDir, deps)).toBe(0);
    expect(BUILT_FILES.map((n) => sha256(new Uint8Array(readFileSync(join(sampleDir, n)))))).toEqual(before);
  });

  it('scales a quiet render to the level sample, like the gate packs', async () => {
    writeFileSync(join(renderDir, 'p2.wav'), floatWav(tone(pacedTimings(syntheticSample().texts.p2).durationSamples, 0.01)));
    expect(await buildSample(renderDir, deps)).toBe(0);
    expect(lines.find((l) => l.startsWith('p2:'))).toMatch(/gain 18\.1 dB/);
  });

  it('changes nothing in sample/ when a rule fails', async () => {
    expect(await buildSample(renderDir, deps)).toBe(0);
    const before = BUILT_FILES.map((n) => sha256(new Uint8Array(readFileSync(join(sampleDir, n)))));
    // the hand-written list now names a word that sentence 3 of p1 does not hold
    const plan = JSON.parse(readFileSync(join(sampleDir, 'plan.json'), 'utf8')) as SamplePlan;
    plan.errors[0]!.replacement = 'omega';
    writeFileSync(join(sampleDir, 'plan.json'), JSON.stringify(plan));
    const planBytes = readFileSync(join(sampleDir, 'plan.json'));
    lines = [];
    expect(await buildSample(renderDir, deps)).toBe(1);
    expect(lines).toContain('SAMPLE FAIL: 1 problem(s); sample/ is unchanged');
    expect(lines).toContain('- sample-e1: replacement occurs 0 times in its sentence, expected once');
    expect(lines.at(-1)).toBe(SHOW_TEXT_HINT);
    expect(BUILT_FILES.filter((n) => n !== 'plan.json').map((n) => sha256(new Uint8Array(readFileSync(join(sampleDir, n)))))).toEqual(before.slice(0, 4));
    expect(readFileSync(join(sampleDir, 'plan.json'))).toEqual(planBytes);
  });

  it('refuses a render of another text, a stray p3.wav and a missing render', async () => {
    writeFileSync(join(sampleDir, 'texts', 'p1.txt'), syntheticSample().texts.p2);
    writeFileSync(join(sampleDir, 'p3.wav'), 'RIFF');
    rmSync(join(renderDir, 'opening.timings.json'));
    expect(await buildSample(renderDir, deps, { showText: true })).toBe(1);
    expect(lines.join('\n')).toMatch(/- p1: the render does not fit sample\/texts\/p1.txt: \d+ defect\(s\) found by tools\/tts \[.*words.ts finds 150 words, timings.json lists 180/);
    expect(lines.join('\n')).toMatch(/sample\/p3.wav exists/);
    expect(lines.join('\n')).toMatch(/opening: missing opening.timings.json/);
    expect(existsSync(join(sampleDir, 'timings.json'))).toBe(false);
  });

  it('names no word of the texts and no time inside a clip when it fails; --show-text adds them', async () => {
    const s = syntheticSample();
    // p1: the first planted error moves to 6.0 s, and one sentence opens with a banned word
    const p1 = Array.from({ length: 18 }, () => sentence());
    p1[1] = sentence(['beta']);
    p1[8] = sentence(['gamma', 'delta']);
    p1[13] = sentence(['did', 'not', 'go', 'home']);
    setText('p1', passageText(p1).replace('Plain', 'Truth'));
    // p2: a word off topic
    setText('p2', s.texts.p2.replace('Plain words', 'Plain breathing'));
    const plan = { errors: s.specs.map((e) => (e.error_id === 'sample-e1' ? { ...e, sentence_index: 1 } : e)) };
    writeFileSync(join(sampleDir, 'plan.json'), JSON.stringify(plan));

    expect(await buildSample(renderDir, deps)).toBe(1);
    const blind = lines.filter((l) => l.startsWith('- '));
    expect(blind).toEqual([
      '- p2: 1 off-topic word(s) (topic guard)',
      '- sample-e1: starts in the first 8000 ms of p1',
      '- sample/texts/p1.txt:1: a banned word (spec 13.6)',
    ]);
    for (const secret of ['Truth', 'truth', 'breathing', 'beta', 'Plain', '6000']) expect(lines.join('\n')).not.toContain(secret);
    expect(lines.at(-1)).toBe(SHOW_TEXT_HINT);

    lines = [];
    expect(await main(['--show-text', '--from', renderDir], deps)).toBe(1);
    expect(lines.filter((l) => l.startsWith('- '))).toEqual([
      '- p2: 1 off-topic word(s) (topic guard) [breathing]',
      '- sample-e1: starts in the first 8000 ms of p1 [at 6000 ms]',
      '- sample/texts/p1.txt:1: a banned word (spec 13.6) [truth]',
    ]);
    expect(lines).not.toContain(SHOW_TEXT_HINT);
    expect(existsSync(join(sampleDir, 'timings.json'))).toBe(false);
  });

  it('keeps what npm run tts -- --set prints on failure behind --show-text: it names words by number and gives times', async () => {
    const said = 'TTS FAIL: passage p1: word 7 starts at 2400 ms, before word 6 ends at 2500 ms';
    deps.joinTimings = async (_args, log) => {
      log(said);
      return 1;
    };
    expect(await buildSample(renderDir, deps)).toBe(1);
    expect(lines).toContain('- npm run tts -- --set exited with code 1');
    expect(lines.join('\n')).not.toContain('2400');
    lines = [];
    expect(await buildSample(renderDir, deps, { showText: true })).toBe(1);
    expect(lines).toContain(`- npm run tts -- --set exited with code 1 [${said}]`);
    expect(existsSync(join(sampleDir, 'timings.json'))).toBe(false);
  });

  it('reads plan.json blind: a JSON error can quote the planted sentences', async () => {
    writeFileSync(join(sampleDir, 'plan.json'), '{"errors": [{"planted_sentence": "Plain words beta.", }]}');
    expect(await buildSample(renderDir, deps)).toBe(1);
    expect(lines).toContain('- sample/plan.json is not JSON');
    expect(lines.join('\n')).not.toContain('beta');
  });

  it('finds banned words by file and line, the word as the detail', () => {
    expect(bannedWordFindings('texts/p2.txt', 'A plain line.\nThe whole truth of it.\n', banned, allowed)).toEqual([
      { message: 'sample/texts/p2.txt:2: a banned word (spec 13.6)', detail: 'truth' },
    ]);
    expect(bannedWordFindings('texts/p2.txt', 'Compared with ground truth.\n', banned, allowed)).toEqual([]);
  });

  it('needs --from and a folder, and takes --show-text before or after them', async () => {
    expect(await main([], deps)).toBe(2);
    expect(await main(['--from'], deps)).toBe(2);
    expect(await main(['--show-text'], deps)).toBe(2);
    expect(await main(['--from', renderDir, 'extra'], deps)).toBe(2);
    expect(lines[0]).toMatch(/^usage: npx tsx tools\/sample\/build.ts \[--show-text\] --from/);
    lines = [];
    expect(await main(['--from', renderDir, '--show-text'], deps)).toBe(0);
    expect(lines.at(-1)).toMatch(/^SAMPLE OK/);
  });
});
