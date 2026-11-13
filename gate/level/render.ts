// npx tsx gate/level/render.ts
// Renders gate/level/level.txt with the narrator voice (tools/tts: Kokoro, af_heart, speed 1.0) and
// stores level.wav (mono, 48 kHz, 16-bit PCM) and level.timings.json beside it. `doctor` plays this
// 20 s sample to set the output level and to measure the leak (spec 7.7, 7.12). The text is not
// from the gate packs (spec 7.7, 9.2). Ends with LEVEL OK <words> words <ms> ms, or LEVEL FAIL.

import { mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { main as runTts, nodeDeps } from '../../tools/tts/run.ts';
import { parseTimings, stripBom, timingsProblems, timingsTextProblems } from '../../tools/tts/timings.ts';
import { countPassageWords } from '../../tools/tts/words.ts';
import { convertTtsWavToPcm16 } from './wav16.ts';

export const LEVEL_DIR = dirname(fileURLToPath(import.meta.url));

export const LEVEL_FILES = {
  text: join(LEVEL_DIR, 'level.txt'),
  wav: join(LEVEL_DIR, 'level.wav'),
  timings: join(LEVEL_DIR, 'level.timings.json'),
} as const;

/** About 20 s (spec 7.7). Outside this range the text is edited and rendered again. */
export const LEVEL_DURATION_MS = { min: 18_000, max: 22_000 } as const;

/** Why a rendered length is not usable, or null. */
export function durationProblem(durationMs: number): string | null {
  if (durationMs < LEVEL_DURATION_MS.min) return `${durationMs} ms is shorter than ${LEVEL_DURATION_MS.min} ms: add words to level.txt`;
  if (durationMs > LEVEL_DURATION_MS.max) return `${durationMs} ms is longer than ${LEVEL_DURATION_MS.max} ms: remove words from level.txt`;
  return null;
}

function writeAtomic(file: string, bytes: Uint8Array | string): void {
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, bytes);
  renameSync(tmp, file);
}

async function render(): Promise<number> {
  // PyTorch threads: the machine is shared (tools/tts/README.md measured with 2).
  process.env['OMP_NUM_THREADS'] ??= '2';
  process.env['MKL_NUM_THREADS'] ??= '2';
  const work = mkdtempSync(join(tmpdir(), 'copyholder-level-'));
  try {
    const floatWav = join(work, 'level.f32.wav');
    const timingsFile = join(work, 'level.timings.json');
    // The level text is public, so error messages may show it (--show-text, tools/tts/README.md).
    const code = await runTts(['--show-text', LEVEL_FILES.text, floatWav, timingsFile], nodeDeps());
    if (code !== 0) {
      console.log(`LEVEL FAIL: the narrator render exited with code ${code}`);
      return code;
    }
    const text = stripBom(readFileSync(LEVEL_FILES.text, 'utf8'));
    const timingsText = readFileSync(timingsFile, 'utf8');
    const timings = parseTimings(JSON.parse(timingsText));
    const problems = [...timingsProblems(timings), ...timingsTextProblems(timings, text)];
    const converted = convertTtsWavToPcm16(new Uint8Array(readFileSync(floatWav)));
    if (converted.frames !== timings.durationSamples) problems.push(`the WAV has ${converted.frames} samples, timings.json says ${timings.durationSamples}`);
    if (converted.clippedSamples > 0) problems.push(`${converted.clippedSamples} samples clip at 16 bits`);
    const length = durationProblem(timings.durationMs);
    if (length !== null) problems.push(length);
    if (problems.length > 0) {
      console.log(`LEVEL FAIL: ${problems.join('; ')}`);
      return 1;
    }
    writeAtomic(LEVEL_FILES.wav, converted.wav);
    writeAtomic(LEVEL_FILES.timings, timingsText);
    console.log(`LEVEL OK ${countPassageWords(text)} words ${timings.durationMs} ms, peak ${converted.peakDbfs.toFixed(1)} dBFS`);
    return 0;
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

function isEntryPoint(): boolean {
  try {
    return process.argv[1] !== undefined && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isEntryPoint()) {
  render().then(
    (code) => process.exit(code),
    (e: unknown) => {
      console.log(`LEVEL FAIL: ${(e as Error).message}`);
      process.exit(1);
    },
  );
}
