// npx tsx tools/sample/build.ts [--show-text] --from <dir>
// Stores the public sample text that `npm run headstart` reads (sample/README.md; spec 7.11, 15.1;
// PREREG.md §11 "Demo takes"). <dir> holds what `npm run tts` rendered from sample/texts/<id>.txt for
// opening, p1 and p2: <id>.wav (32-bit float) and <id>.timings.json. This command
//   1. checks each render against its text (tools/tts/run.ts renderProblems),
//   2. stores each clip as the gate packs store theirs: 16-bit PCM, mono, 48 kHz, the same sample
//      count, at the loudness of the doctor sample gate/level/level.wav (gate/render-packs.ts
//      packClipToPcm16, gate/README.md step 5),
//   3. joins the word timings into one timings-set/1 file over the stored clips with
//      `npm run tts -- --set` (tools/tts/run.ts), so its audioSha256 are those of the 16-bit WAVs,
//   4. writes plan.json from the hand-written error list it already holds (tools/sample/plan.ts adds
//      word numbers and times), and checks every rule of plan.ts and the banned words (spec 13.6).
// All of it happens in a temporary folder first; on any problem nothing in sample/ changes.
// The output is blind, on success and on failure: clip lengths, levels, counts, rules and ids,
// never a word of the texts and never a time inside a clip, because the participant of a demo
// take has not heard them and may be the one who runs this. As in gate/check-texts.ts, the words,
// word and sentence numbers and times behind a problem are printed only with --show-text.

import { createHash } from 'node:crypto';
import { chmodSync, copyFileSync, existsSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { Finding } from '../../gate/check-texts.ts';
import { LEVEL_MATCH_DB, LEVEL_WAV, packClipToPcm16, rmsDbfs, wavSamples } from '../../gate/render-packs.ts';
import { loadList, scanText } from '../lint-words.ts';
import { main as runTts, nodeDeps, renderProblems, type RunDeps } from '../tts/run.ts';
import { parseTimingsSet, stripBom, timingsForClip } from '../tts/timings.ts';
import {
  SAMPLE_PASSAGE_IDS,
  audioFileOf,
  buildSamplePlan,
  finding,
  formatFinding,
  readErrorSpecs,
  samplePlanJson,
  textFileOf,
  ttsFinding,
  type SampleErrorSpec,
  type SamplePassageInput,
} from './plan.ts';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
export const SAMPLE_DIR = join(REPO, 'sample');
export const USAGE = 'usage: npx tsx tools/sample/build.ts [--show-text] --from <dir with opening.wav, opening.timings.json, p1.wav, ...>';
/** Printed after a blind failure whose problems have words or times behind them. */
export const SHOW_TEXT_HINT =
  'The words, word numbers and times behind these problems: run again with --show-text, where the participant of a demo take cannot see the screen.';

/** Files this command writes into sample/; host serves all but plan.json (live/lib/narrator.cjs). */
export const BUILT_FILES = [...SAMPLE_PASSAGE_IDS.map(audioFileOf), 'timings.json', 'plan.json'] as const;

export interface BuildDeps {
  sampleDir: string;
  /** The reference loudness: gate/level/level.wav. */
  levelWav: string;
  /** The word lists of lint:words (tools/words/banned.txt and allow.txt, spec 13.6). */
  bannedWords: string[];
  allowedWords: string[];
  /** A new empty folder for the staged files; removed afterwards. */
  makeWorkDir: () => string;
  /** `npm run tts -- --set ...` (tools/tts/run.ts main); every line it prints goes to `log`; resolves with its exit code. */
  joinTimings: (args: string[], log: (line: string) => void) => Promise<number>;
  out: (line: string) => void;
  err: (line: string) => void;
}

export interface BuildOptions {
  /** Print the words, word numbers and times behind each problem (gate/check-texts.ts --show-text). */
  showText?: boolean;
}

export function nodeBuildDeps(): BuildDeps {
  const out = (line: string): void => console.log(line);
  const err = (line: string): void => console.error(line);
  return {
    sampleDir: SAMPLE_DIR,
    levelWav: LEVEL_WAV,
    bannedWords: loadList(join(REPO, 'tools', 'words', 'banned.txt')),
    allowedWords: loadList(join(REPO, 'tools', 'words', 'allow.txt')),
    makeWorkDir: () => mkdtempSync(join(tmpdir(), 'copyholder-sample-')),
    joinTimings: (args, log) => runTts(['--set', ...args], { ...nodeDeps(), out: log, err: log } satisfies RunDeps),
    out,
    err,
  };
}

const sha256 = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');
const db = (x: number): string => x.toFixed(2);

/**
 * Banned words (spec 13.6) in a file of the sample, blind as gate/check-texts.ts bannedWordProblems
 * reports them for the packs: file and line in the message, the word as the detail. lint:words
 * checks only sample/README.md, because it prints the line of every hit.
 */
export function bannedWordFindings(name: string, text: string, banned: string[], allowed: string[]): Finding[] {
  return scanText(text, banned, allowed, name).map((h) => finding(`sample/${h.file}:${h.line}: a banned word (spec 13.6)`, h.word));
}

/** Copies through a dot file in the same folder, then renames it into place; public files, mode 0644. */
function installFile(from: string, to: string): void {
  const tmp = join(dirname(to), `.${basename(to)}.${process.pid}.tmp`);
  try {
    copyFileSync(from, tmp);
    chmodSync(tmp, 0o644);
    renameSync(tmp, to);
  } catch (e) {
    rmSync(tmp, { force: true });
    throw e;
  }
}

/** The hand-written error list of sample/plan.json, or the problems that keep it from being read. */
function readSpecs(sampleDir: string): { specs: SampleErrorSpec[] } | { problem: Finding } {
  const file = join(sampleDir, 'plan.json');
  if (!existsSync(file)) return { problem: finding('sample/plan.json is missing: it holds the hand-written list of planted errors') };
  let json: unknown;
  try {
    json = JSON.parse(readFileSync(file, 'utf8')) as unknown;
  } catch (e) {
    // A JSON error can quote the file, and plan.json holds the planted sentences.
    return { problem: finding('sample/plan.json is not JSON', (e as Error).message) };
  }
  try {
    return { specs: readErrorSpecs(json) };
  } catch (e) {
    return { problem: finding((e as Error).message) };
  }
}

export async function buildSample(fromDir: string, deps: BuildDeps, options: BuildOptions = {}): Promise<number> {
  const showText = options.showText === true;
  const problems: Finding[] = [];
  const fail = (): number => {
    deps.out(`SAMPLE FAIL: ${problems.length} problem(s); sample/ is unchanged`);
    for (const p of problems) deps.out(`- ${formatFinding(p, showText)}`);
    if (!showText && problems.some((p) => p.detail !== undefined)) deps.out(SHOW_TEXT_HINT);
    return 1;
  };
  if (!existsSync(deps.levelWav)) {
    problems.push(finding(`the reference loudness ${basename(deps.levelWav)} was not found (gate/level/render.ts makes it)`));
    return fail();
  }
  const referenceRms = rmsDbfs(wavSamples(new Uint8Array(readFileSync(deps.levelWav))));
  deps.out(`level.wav: RMS ${db(referenceRms)} dBFS, the loudness of the sample clips (within ${LEVEL_MATCH_DB} dB)`);
  // host serves p3.wav when the folder has it, and a clip from audio/ when sample/ has none (live/lib/narrator.cjs).
  if (existsSync(join(deps.sampleDir, 'p3.wav'))) problems.push(finding('sample/p3.wav exists, but the sample has no p3: host would serve it (remove it)'));
  if (existsSync(join(deps.sampleDir, 'audio'))) problems.push(finding('sample/audio/ exists: host could serve a clip from there, so keep the clips in sample/ only (remove it)'));
  const read = readSpecs(deps.sampleDir);
  const specs = 'specs' in read ? read.specs : [];
  if ('problem' in read) problems.push(read.problem);

  const work = deps.makeWorkDir();
  try {
    // 1-2: every render against its text, then the 16-bit clip in the work folder.
    const texts = new Map<string, { text: string; sha256: string }>();
    for (const id of SAMPLE_PASSAGE_IDS) {
      const textFile = join(deps.sampleDir, textFileOf(id));
      const wavFile = join(fromDir, `${id}.wav`);
      const timingsFile = join(fromDir, `${id}.timings.json`);
      const missing = [textFile, wavFile, timingsFile].filter((f) => !existsSync(f));
      if (missing.length > 0) {
        problems.push(finding(`${id}: missing ${missing.map((f) => basename(f)).join(', ')}`));
        continue;
      }
      const textBytes = new Uint8Array(readFileSync(textFile));
      let text: string;
      try {
        text = stripBom(new TextDecoder('utf-8', { fatal: true }).decode(textBytes));
      } catch {
        problems.push(finding(`${id}: sample/${textFileOf(id)} is not UTF-8`));
        continue;
      }
      texts.set(id, { text, sha256: sha256(textBytes) });
      const floatWav = new Uint8Array(readFileSync(wavFile));
      let renderIssues: string[];
      try {
        renderIssues = renderProblems(text, readFileSync(timingsFile, 'utf8'), floatWav);
      } catch (e) {
        problems.push(finding(`${id}: ${id}.wav and ${id}.timings.json cannot be read as a render of tools/tts`, (e as Error).message));
        continue;
      }
      if (renderIssues.length > 0) {
        problems.push(...ttsFinding(`${id}: the render does not fit sample/${textFileOf(id)}`, renderIssues));
        continue;
      }
      let clip: ReturnType<typeof packClipToPcm16>;
      try {
        clip = packClipToPcm16(floatWav, referenceRms);
      } catch (e) {
        problems.push(finding(`${id}: the render cannot be stored as 16-bit PCM: ${(e as Error).message}`));
        continue;
      }
      if (clip.problems.length > 0) {
        problems.push(...clip.problems.map((p) => finding(`${id}: ${p}`)));
        continue;
      }
      writeFileSync(join(work, audioFileOf(id)), clip.wav);
      deps.out(`${id}: ${(clip.frames / 48_000).toFixed(2)} s, 16-bit PCM, peak ${db(clip.peakDbfs)} dBFS, RMS ${db(clip.rmsDbfs)} dBFS, gain ${clip.gainDb.toFixed(1)} dB, ${clip.wav.length} bytes`);
    }
    if (problems.length > 0) return fail();

    // 3: one timings-set/1 file over the stored clips, as `npm run tts -- --set` writes it. Its
    // messages name words by number and give times, so they reach the output only as a detail.
    const setFile = join(work, 'timings.json');
    const setArgs = SAMPLE_PASSAGE_IDS.flatMap((id) => [id, join(work, audioFileOf(id)), join(fromDir, `${id}.timings.json`)]);
    const setLines: string[] = [];
    const code = await deps.joinTimings([setFile, ...setArgs], (line) => setLines.push(line));
    if (code !== 0 || !existsSync(setFile)) {
      problems.push(finding(`npm run tts -- --set exited with code ${code}`, setLines.join('; ')));
      return fail();
    }
    for (const line of setLines) deps.out(line);
    const setText = readFileSync(setFile, 'utf8');
    const setJson = JSON.parse(setText) as unknown;
    const set = parseTimingsSet(setJson);
    const inputs: SamplePassageInput[] = [];
    for (const id of SAMPLE_PASSAGE_IDS) {
      const wav = new Uint8Array(readFileSync(join(work, audioFileOf(id))));
      const entry = set.passages.find((p) => p.passageId === id);
      const timings = timingsForClip(setJson, audioFileOf(id));
      if (entry === undefined || timings === null) {
        problems.push(finding(`${id}: not in timings.json`));
        continue;
      }
      if (entry.audioSha256 !== sha256(wav)) problems.push(finding(`${id}: timings.json holds another SHA-256 than the stored clip`));
      const t = texts.get(id)!;
      inputs.push({ id, text: t.text, textSha256: t.sha256, audioSha256: entry.audioSha256, timings });
    }
    if (set.passages.length !== SAMPLE_PASSAGE_IDS.length) problems.push(finding(`timings.json holds ${set.passages.length} passages, expected ${SAMPLE_PASSAGE_IDS.length}`));

    // 4: the plan, with every rule of plan.ts, then the banned words of everything public it stores.
    const built = buildSamplePlan(inputs, specs);
    problems.push(...built.problems);
    const planJson = samplePlanJson(built.plan);
    for (const id of SAMPLE_PASSAGE_IDS) {
      const t = texts.get(id);
      if (t !== undefined) problems.push(...bannedWordFindings(textFileOf(id), t.text, deps.bannedWords, deps.allowedWords));
    }
    problems.push(...bannedWordFindings('plan.json', planJson, deps.bannedWords, deps.allowedWords));
    problems.push(...bannedWordFindings('timings.json', setText, deps.bannedWords, deps.allowedWords));
    if (problems.length > 0) return fail();
    writeFileSync(join(work, 'plan.json'), planJson);

    for (const name of BUILT_FILES) installFile(join(work, name), join(deps.sampleDir, name));
    const errors = built.plan.errors.length;
    const withErrors = built.plan.passages.filter((p) => p.error_count > 0).length;
    deps.out(`plan.json: ${errors} planted errors in ${withErrors} passages`);
    deps.out(`SAMPLE OK: ${BUILT_FILES.join(', ')} written to sample/`);
    return 0;
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

export async function main(argv: readonly string[], deps: BuildDeps = nodeBuildDeps()): Promise<number> {
  if (argv.includes('--help') || argv.includes('-h')) {
    deps.out(USAGE);
    return 0;
  }
  const showText = argv.includes('--show-text');
  const rest = argv.filter((a) => a !== '--show-text');
  const at = rest.indexOf('--from');
  const from = at >= 0 ? rest[at + 1] : undefined;
  if (from === undefined || from.startsWith('-') || rest.length !== 2) {
    deps.err(USAGE);
    return 2;
  }
  // npm runs scripts from the package root; INIT_CWD is where `npm run` was typed.
  return buildSample(resolve(process.env['INIT_CWD'] ?? process.cwd(), from), deps, { showText });
}

const invoked = process.argv[1];
if (invoked !== undefined && pathToFileURL(resolve(invoked)).href === import.meta.url) {
  main(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (e: unknown) => {
      console.error(`SAMPLE FAIL: ${(e as Error).message}`);
      process.exitCode = 1;
    },
  );
}
