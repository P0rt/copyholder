// Steps 3 to 7 of gate/README.md in one command, for a later re-render of the day-1 packs (spec 9.2, 7.7):
//   npx tsx gate/render-packs.ts [--force] [0] [A] [B] [C]   render both passages (tools/tts), store them as
//                                                            16-bit PCM, check them, install them, build
//                                                            cues.json and pack.json, check the folder
//   npx tsx gate/render-packs.ts --convert [0] [A] [B] [C]   no render: store the float WAV files that
//                                                            npm run tts wrote into the pack folders as
//                                                            16-bit PCM, then build and check
// Packs default to all four. A pack that is already built and current is skipped unless --force (see
// staleReasons). The predictions come first (npm run gate:predict): a pack whose texts or predicted
// timings have a problem is not rendered. Renders run one at a time in a temporary folder outside
// gate/. A new render is checked there with every check of the build (the prediction, spec 9.2, the
// clip lengths, placement against the other packs, the cue hashes PREREG.md holds) and installed only
// when all pass; a refused render leaves the pack folder as it was (review 12). A render stopped by a
// signal, such as Ctrl+C, stops the whole run.
// The output is blind (spec 9.2): pack ids, passage kinds, clip lengths, levels, sizes, OK/FAIL and
// hashes; never a word of a passage or a cue time.

import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { main as runTts, nodeDeps } from '../tools/tts/run.ts';
import { parseTimings } from '../tools/tts/timings.ts';
import { decodeWav } from '../web/ui/wav.ts';
import {
  DEFAULT_PREREG_FILE,
  DEFAULT_TOLERANCE_MS,
  GATE_DIR,
  PACK_SPECS,
  PACK_WAV_FORMAT,
  PASSAGE_KINDS,
  buildPacks,
  checkGate,
  checkRealPacks,
  formatProblem,
  main as checkTexts,
  spokenText,
  timingAgreement,
  type GateReport,
  type LoadedPack,
  type PackId,
  type PassageKind,
} from './check-texts.ts';
import { convertTtsWavToPcm16, encodePcm16MonoWav, floatToPcm16, LEVEL_SAMPLE_RATE_HZ, peakDbfs, readFloatMonoWav, readWavFormat } from './level/wav16.ts';

export const PACK_IDS: readonly PackId[] = PACK_SPECS.map((s) => s.id);

/** doctor sets the narrator volume with this sample (spec 7.7), so the packs play at its loudness. */
export const LEVEL_WAV = join(GATE_DIR, 'level', 'level.wav');
/** A clip whose RMS lies within this many dB of level.wav is stored without a gain (assumption). */
export const LEVEL_MATCH_DB = 3;
/** A clip that needs a gain is scaled to level.wav's RMS, with its peak at or below this. */
export const MAX_SCALED_PEAK_DBFS = -1;
/** The 16-bit conversion (x * 32768, rounded) clips a sample at or above this level. */
export const PCM16_CLIP_DBFS = 20 * Math.log10(32_767.5 / 32_768);

const FORMAT_FLOAT = 3;

// ---------------------------------------------------------------------------------------------
// Arguments
// ---------------------------------------------------------------------------------------------

export type RenderMode = 'render' | 'convert';

export interface RenderArgs {
  /** In the order of PACK_SPECS, without repeats. */
  packs: PackId[];
  force: boolean;
  mode: RenderMode;
  help: boolean;
}

export const USAGE = 'usage: npx tsx gate/render-packs.ts [--force | --convert] [0] [A] [B] [C]';

/** Packs by id (0, A, B, C; also a, pack-A); none named means all four. */
export function parseRenderArgs(argv: readonly string[]): RenderArgs | { error: string } {
  const named = new Set<PackId>();
  let force = false;
  let convert = false;
  let help = false;
  for (const arg of argv) {
    if (arg === '--force') force = true;
    else if (arg === '--convert') convert = true;
    else if (arg === '--help' || arg === '-h') help = true;
    else {
      const id = /^(?:pack-?)?([0abc])$/i.exec(arg)?.[1]?.toUpperCase();
      if (id === undefined) return { error: `unknown argument: ${arg}` };
      named.add(id as PackId);
    }
  }
  if (force && convert) return { error: '--force renders again and --convert never renders: give one of them' };
  return { packs: PACK_IDS.filter((id) => named.size === 0 || named.has(id)), force, mode: convert ? 'convert' : 'render', help };
}

// ---------------------------------------------------------------------------------------------
// 16-bit audio at the loudness of the doctor sample
// ---------------------------------------------------------------------------------------------

/** RMS level of the whole clip in dBFS (-Infinity for silence). */
export function rmsDbfs(samples: Float32Array): number {
  let sum = 0;
  for (const x of samples) sum += x * x;
  return samples.length === 0 ? -Infinity : 10 * Math.log10(sum / samples.length);
}

/** Samples as the page decodes them (web/ui/wav.ts): float as is, 16-bit PCM divided by 32768. */
export function wavSamples(bytes: Uint8Array): Float32Array {
  return decodeWav(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer).samples;
}

/**
 * Gain in dB for one clip. Within LEVEL_MATCH_DB of the reference RMS: none. Further away: the
 * difference, limited so that the peak stays at or below MAX_SCALED_PEAK_DBFS; a boost that the
 * peak does not allow becomes no gain, never a cut. A peak that the 16-bit conversion would clip
 * always gets at least the cut to MAX_SCALED_PEAK_DBFS (review 17); packClipToPcm16 then refuses
 * the clip only if that cut leaves its RMS more than LEVEL_MATCH_DB from the reference.
 */
export function levelGainDb(rms: number, peak: number, referenceRms: number): number {
  const delta = referenceRms - rms;
  if (!Number.isFinite(delta) || !Number.isFinite(peak)) return 0;
  const wanted = Math.abs(delta) <= LEVEL_MATCH_DB ? 0 : delta;
  const headroom = MAX_SCALED_PEAK_DBFS - peak;
  if (peak >= PCM16_CLIP_DBFS) return Math.min(wanted, headroom);
  if (wanted > 0) return Math.max(0, Math.min(wanted, headroom));
  return wanted < 0 ? Math.min(wanted, headroom) : 0;
}

export interface Pcm16Clip {
  /** The 16-bit PCM WAV: mono, 48 kHz, the 44-byte header of gate/level/wav16.ts. */
  wav: Uint8Array;
  frames: number;
  /** Gain applied before the conversion (0: the clip is converted exactly as the level sample). */
  gainDb: number;
  /** Levels of the stored clip, as the page reads it. */
  peakDbfs: number;
  rmsDbfs: number;
  clippedSamples: number;
  /** Why the clip cannot be stored; blind. */
  problems: string[];
}

const db = (x: number): string => x.toFixed(2);

/**
 * A tools/tts float WAV as the 16-bit PCM clip of a pack, with the same sample count, so the word
 * timings stay valid. Without a gain it is gate/level/wav16.ts convertTtsWavToPcm16 itself.
 */
export function packClipToPcm16(floatWav: Uint8Array, referenceRmsDbfs: number): Pcm16Clip {
  const { sampleRateHz, samples } = readFloatMonoWav(floatWav);
  if (sampleRateHz !== LEVEL_SAMPLE_RATE_HZ) throw new Error(`expected ${LEVEL_SAMPLE_RATE_HZ} Hz, got ${sampleRateHz} Hz`);
  const gainDb = levelGainDb(rmsDbfs(samples), peakDbfs(samples), referenceRmsDbfs);
  let wav: Uint8Array;
  let clippedSamples: number;
  if (gainDb === 0) {
    ({ wav, clippedSamples } = convertTtsWavToPcm16(floatWav));
  } else {
    const k = 10 ** (gainDb / 20);
    const pcm = floatToPcm16(samples.map((x) => x * k));
    wav = encodePcm16MonoWav(pcm.pcm, sampleRateHz);
    clippedSamples = pcm.clippedSamples;
  }
  const stored = wavSamples(wav);
  const clip: Pcm16Clip = { wav, frames: stored.length, gainDb, peakDbfs: peakDbfs(stored), rmsDbfs: rmsDbfs(stored), clippedSamples, problems: [] };
  if (clip.frames !== samples.length) clip.problems.push(`the 16-bit clip has ${clip.frames} samples, the render ${samples.length}`);
  if (clippedSamples > 0) clip.problems.push(`${clippedSamples} samples clip at 16 bits`);
  if (!(Math.abs(clip.rmsDbfs - referenceRmsDbfs) <= LEVEL_MATCH_DB)) {
    clip.problems.push(`RMS ${db(clip.rmsDbfs)} dBFS stays more than ${LEVEL_MATCH_DB} dB from level.wav (${db(referenceRmsDbfs)} dBFS)`);
  }
  return clip;
}

/** One blind line per stored clip. */
export function clipLine(id: PackId, kind: PassageKind, clip: Pick<Pcm16Clip, 'frames' | 'gainDb' | 'peakDbfs' | 'rmsDbfs' | 'wav'>): string {
  return `pack ${id} ${kind}: ${(clip.frames / LEVEL_SAMPLE_RATE_HZ).toFixed(2)} s, 16-bit PCM, peak ${db(clip.peakDbfs)} dBFS, RMS ${db(clip.rmsDbfs)} dBFS, gain ${clip.gainDb.toFixed(1)} dB, ${clip.wav.length} bytes`;
}

// ---------------------------------------------------------------------------------------------
// The skip rule
// ---------------------------------------------------------------------------------------------

function isPackWav(bytes: Uint8Array): boolean {
  const f = readWavFormat(bytes);
  return f.format === PACK_WAV_FORMAT.formatTag && f.bitsPerSample === PACK_WAV_FORMAT.bitsPerSample && f.channels === 1 && f.sampleRateHz === LEVEL_SAMPLE_RATE_HZ;
}

/**
 * Why a pack does not count as built and current; empty when it does. Current: pack.json exists,
 * check-texts.ts reports no problem for the pack or the folder (pack.json verified against the files
 * and the texts), both WAV files are 16-bit PCM, mono, 48 kHz, and both timings files come from the
 * engine of the prediction and match it within the build's tolerance.
 */
export function staleReasons(report: GateReport, id: PackId, toleranceMs: number = DEFAULT_TOLERANCE_MS): string[] {
  const pack = report.packs.find((p) => p.spec.id === id);
  if (pack === undefined) return ['not in the gate folder'];
  const reasons: string[] = [];
  if (!existsSync(join(pack.dir, 'pack.json'))) reasons.push('no pack.json');
  const problems = report.problems.filter((p) => p.packs.length === 0 || p.packs.includes(id)).length;
  if (problems > 0) reasons.push(`${problems} problem(s) in gate/check-texts.ts`);
  for (const kind of PASSAGE_KINDS) {
    try {
      if (!isPackWav(new Uint8Array(readFileSync(join(pack.dir, `${kind}.wav`))))) reasons.push(`${kind}.wav is not 16-bit PCM, mono, 48 kHz`);
    } catch {
      reasons.push(`${kind}.wav cannot be read`);
    }
    const predicted = pack.predicted[kind];
    try {
      const real = parseTimings(JSON.parse(readFileSync(join(pack.dir, `${kind}.timings.json`), 'utf8')));
      if (typeof predicted !== 'object') reasons.push(`no usable ${kind}.predicted.json`);
      else if (!isDeepStrictEqual(real.engine, predicted.timings.engine) || timingAgreement(real, predicted.timings, toleranceMs).length > 0) {
        reasons.push(`${kind}.timings.json differs from the prediction`);
      }
    } catch {
      reasons.push(`${kind}.timings.json cannot be read`);
    }
  }
  return reasons;
}

// ---------------------------------------------------------------------------------------------
// Rendering, checking and installing
// ---------------------------------------------------------------------------------------------

/** Renders one passage file into a float WAV and its timings.json; resolves with the exit code. */
export type RenderPassage = (input: string, wavOut: string, timingsOut: string) => Promise<number>;

/** npm run tts (tools/tts/run.ts). No --show-text: its messages name words by number only. */
export const ttsRender: RenderPassage = (input, wavOut, timingsOut) => runTts([input, wavOut, timingsOut], nodeDeps());

/**
 * Exit code 128 + n: the render was stopped by signal n (tools/tts/run.ts), such as Ctrl+C. The run
 * stops there instead of starting the next render (review 13).
 */
export function isInterruption(code: number): boolean {
  return code >= 128;
}

export interface RenderPacksDeps {
  gateDir: string;
  /** The reference loudness: gate/level/level.wav. */
  levelWav: string;
  /** PREREG.md, whose cue-list hashes a new build must keep (spec 9.2, 13.6). */
  preregFile: string;
  render: RenderPassage;
  /** A new empty folder outside gate/ for one pack's renders; removed afterwards. */
  makeWorkDir: () => string;
  out: (line: string) => void;
  err: (line: string) => void;
}

export function nodeRenderDeps(): RenderPacksDeps {
  return {
    gateDir: GATE_DIR,
    levelWav: LEVEL_WAV,
    preregFile: DEFAULT_PREREG_FILE,
    render: ttsRender,
    makeWorkDir: () => mkdtempSync(join(tmpdir(), 'copyholder-gate-render-')),
    out: (line) => console.log(line),
    err: (line) => console.error(line),
  };
}

/** Writes through a dot file in the same folder (the checker ignores dot files), then renames it. */
function writeFileAtomic(file: string, data: string | Uint8Array): void {
  const tmp = join(dirname(file), `.${basename(file)}.${process.pid}.tmp`);
  try {
    writeFileSync(tmp, data);
    renameSync(tmp, file);
  } catch (e) {
    rmSync(tmp, { force: true });
    throw e;
  }
}

interface StoredClip {
  kind: PassageKind;
  clip: Pcm16Clip;
  timingsText: string;
}

/** A rendered float WAV and its timings as a pack clip, or the blind reasons it cannot be one. */
function storeClip(id: PackId, kind: PassageKind, floatWav: Uint8Array, timingsText: string, referenceRms: number): { stored?: StoredClip; problems: string[] } {
  const where = `pack ${id} ${kind}`;
  try {
    const timings = parseTimings(JSON.parse(timingsText));
    const clip = packClipToPcm16(floatWav, referenceRms);
    const problems = clip.problems.map((p) => `${where}: ${p}`);
    if (clip.frames !== timings.durationSamples) problems.push(`${where}: the clip has ${clip.frames} samples, its timings ${timings.durationSamples}`);
    return problems.length > 0 ? { problems } : { stored: { kind, clip, timingsText }, problems };
  } catch (e) {
    return { problems: [`${where}: ${(e as Error).message}`] };
  }
}

type RenderOutcome = { clips: StoredClip[]; spoken: string } | { failed: true } | { interrupted: number };

/**
 * Renders both passages of a pack into `work` and converts them to 16-bit clips. The render input
 * of the objection passage (README step 3) is written into `work` too: nothing in the pack folder
 * changes here.
 */
async function renderPack(pack: LoadedPack, referenceRms: number, deps: RenderPacksDeps, work: string): Promise<RenderOutcome> {
  const id = pack.spec.id;
  const spoken = spokenText(pack.raw.objections ?? '');
  const inputs: Record<PassageKind, string> = { listen: join(pack.dir, 'listen.txt'), objections: join(work, 'objections.spoken.txt') };
  writeFileSync(inputs.objections, spoken);
  const clips: StoredClip[] = [];
  for (const kind of PASSAGE_KINDS) {
    const wavFile = join(work, `${kind}.float.wav`);
    const timingsFile = join(work, `${kind}.float.timings.json`);
    deps.out(`pack ${id} ${kind}: rendering`);
    const code = await deps.render(inputs[kind], wavFile, timingsFile);
    if (isInterruption(code)) {
      deps.out(`pack ${id} ${kind}: render interrupted (exit code ${code}); the run stops, nothing more is rendered or built`);
      return { interrupted: code };
    }
    if (code !== 0 || !existsSync(wavFile) || !existsSync(timingsFile)) {
      deps.out(`pack ${id} ${kind}: render FAILED (exit code ${code})`);
      return { failed: true };
    }
    const r = storeClip(id, kind, new Uint8Array(readFileSync(wavFile)), readFileSync(timingsFile, 'utf8'), referenceRms);
    if (r.stored === undefined) {
      for (const p of r.problems) deps.out(`- ${p}`);
      return { failed: true };
    }
    clips.push(r.stored);
  }
  return { clips, spoken };
}

/**
 * The build's checks on a new render before it is installed (review 12): the 16-bit clips and their
 * timings go into `<work>/stage/` and check-texts.ts reads the pack's render from there. Returns the
 * blind problems of this pack and of the folder as a whole.
 */
function checkNewRender(pack: LoadedPack, clips: readonly StoredClip[], deps: RenderPacksDeps, work: string): string[] {
  const id = pack.spec.id;
  const stage = join(work, 'stage');
  mkdirSync(stage);
  for (const { kind, clip, timingsText } of clips) {
    writeFileSync(join(stage, `${kind}.wav`), clip.wav);
    writeFileSync(join(stage, `${kind}.timings.json`), timingsText);
  }
  const check = checkRealPacks({ gateDir: deps.gateDir, preregFile: deps.preregFile, renderDirs: { [id]: stage } });
  return check.problems.filter((p) => p.packs.length === 0 || p.packs.includes(id)).map((p) => formatProblem(p, false));
}

/** Puts a pack's checked clips and its render input in place; the build then writes cues.json and pack.json. */
function installPack(pack: LoadedPack, clips: readonly StoredClip[], spoken: string, deps: RenderPacksDeps): void {
  const spokenFile = join(pack.dir, 'objections.spoken.txt');
  if (!existsSync(spokenFile) || readFileSync(spokenFile, 'utf8') !== spoken) writeFileAtomic(spokenFile, spoken);
  for (const { kind, clip, timingsText } of clips) {
    writeFileAtomic(join(pack.dir, `${kind}.wav`), clip.wav);
    writeFileAtomic(join(pack.dir, `${kind}.timings.json`), timingsText);
    deps.out(clipLine(pack.spec.id, kind, clip));
  }
}

/** --convert: the float WAV files of README step 4 in a pack folder as 16-bit clips; false on a problem. */
function convertPack(pack: LoadedPack, referenceRms: number, deps: RenderPacksDeps): boolean {
  const id = pack.spec.id;
  const clips: StoredClip[] = [];
  let ok = true;
  for (const kind of PASSAGE_KINDS) {
    const wavFile = join(pack.dir, `${kind}.wav`);
    const timingsFile = join(pack.dir, `${kind}.timings.json`);
    if (!existsSync(wavFile) || !existsSync(timingsFile)) {
      deps.out(`pack ${id} ${kind}: not rendered yet (npm run tts, gate/README.md step 4)`);
      ok = false;
      continue;
    }
    const bytes = new Uint8Array(readFileSync(wavFile));
    let format: number;
    try {
      format = readWavFormat(bytes).format;
    } catch (e) {
      deps.out(`- pack ${id} ${kind}: ${(e as Error).message}`);
      ok = false;
      continue;
    }
    if (format !== FORMAT_FLOAT) {
      if (isPackWav(bytes)) {
        const samples = wavSamples(bytes);
        deps.out(`${clipLine(id, kind, { frames: samples.length, gainDb: 0, peakDbfs: peakDbfs(samples), rmsDbfs: rmsDbfs(samples), wav: bytes })} (stored before)`);
      } else {
        deps.out(`- pack ${id} ${kind}: ${kind}.wav is neither the float WAV of tools/tts nor 16-bit PCM, mono, 48 kHz`);
        ok = false;
      }
      continue;
    }
    const r = storeClip(id, kind, bytes, readFileSync(timingsFile, 'utf8'), referenceRms);
    if (r.stored === undefined) {
      for (const p of r.problems) deps.out(`- ${p}`);
      ok = false;
    } else clips.push(r.stored);
  }
  if (!ok) return false;
  for (const { kind, clip } of clips) {
    writeFileAtomic(join(pack.dir, `${kind}.wav`), clip.wav);
    deps.out(clipLine(id, kind, clip));
  }
  return true;
}

// ---------------------------------------------------------------------------------------------
// Command line
// ---------------------------------------------------------------------------------------------

export async function renderPacks(args: RenderArgs, deps: RenderPacksDeps): Promise<number> {
  const { gateDir } = deps;
  if (!existsSync(deps.levelWav)) {
    deps.out(`FAIL: the reference loudness ${basename(deps.levelWav)} was not found (gate/level/render.ts makes it)`);
    return 1;
  }
  const referenceRms = rmsDbfs(wavSamples(new Uint8Array(readFileSync(deps.levelWav))));
  deps.out(`level.wav: RMS ${db(referenceRms)} dBFS, the loudness of the pack clips (within ${LEVEL_MATCH_DB} dB)`);

  let failed = false;
  const before = checkGate({ gateDir, preregFile: deps.preregFile });
  const plain = checkGate({ gateDir, verifyBuild: false });
  const folderProblems = plain.problems.filter((p) => p.packs.length === 0);
  if (folderProblems.length > 0) {
    deps.out(`FAIL: ${folderProblems.length} problem(s) of the gate folder as a whole:`);
    for (const p of folderProblems) deps.out(`- ${formatProblem(p, false)}`);
    return 1;
  }
  for (const id of args.packs) {
    const pack = plain.packs.find((p) => p.spec.id === id);
    if (pack === undefined) continue;
    if (args.mode === 'convert') {
      if (!convertPack(pack, referenceRms, deps)) failed = true;
      continue;
    }
    if (!args.force && staleReasons(before, id).length === 0) {
      deps.out(`pack ${id}: skipped, already built and current (--force renders it again)`);
      continue;
    }
    const mine = plain.problems.filter((p) => p.packs.includes(id));
    if (mine.length > 0) {
      deps.out(`pack ${id}: NOT RENDERED, ${mine.length} problem(s) in the texts or predicted timings (run npm run gate:predict, then npx tsx gate/check-texts.ts):`);
      for (const p of mine) deps.out(`- ${formatProblem(p, false)}`);
      failed = true;
      continue;
    }
    const work = deps.makeWorkDir();
    try {
      const outcome = await renderPack(pack, referenceRms, deps, work);
      if ('interrupted' in outcome) return outcome.interrupted;
      if ('failed' in outcome) {
        failed = true;
        continue;
      }
      const problems = checkNewRender(pack, outcome.clips, deps, work);
      if (problems.length > 0) {
        deps.out(`pack ${id}: NOT INSTALLED, ${problems.length} problem(s) in the new render; the pack folder is unchanged:`);
        for (const p of problems) deps.out(`- ${p}`);
        failed = true;
        continue;
      }
      installPack(pack, outcome.clips, outcome.spoken, deps);
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  }

  // README step 6: cues.json and pack.json of every rendered pack without a problem.
  const built = buildPacks({ gateDir, preregFile: deps.preregFile });
  for (const o of built.outcomes) {
    if (!o.rendered) deps.out(`pack ${o.pack}: not rendered yet`);
    else if (!o.built) deps.out(`pack ${o.pack}: NOT BUILT`);
    else deps.out(`pack ${o.pack}: built; cues.json SHA-256 ${o.cuesSha256 ?? ''}; pack.json SHA-256 ${o.packJsonSha256 ?? ''}`);
  }
  for (const p of built.problems) deps.out(`- ${formatProblem(p, false)}`);
  if (args.packs.some((id) => built.outcomes.find((o) => o.pack === id)?.built !== true)) failed = true;

  // README step 7: the whole folder once more, pack.json and cues.json included.
  if (checkTexts(['--prereg', deps.preregFile], deps.out, deps.err, gateDir) !== 0) failed = true;
  return failed ? 1 : 0;
}

export async function main(argv: readonly string[], deps: RenderPacksDeps = nodeRenderDeps()): Promise<number> {
  const args = parseRenderArgs(argv);
  if ('error' in args) {
    deps.err(`${args.error}\n${USAGE}`);
    return 2;
  }
  if (args.help) {
    deps.out(USAGE);
    return 0;
  }
  return renderPacks(args, deps);
}

const invoked = process.argv[1];
if (invoked !== undefined && pathToFileURL(resolve(invoked)).href === import.meta.url) {
  // PyTorch threads: the machine is shared (tools/tts/README.md measured with 2).
  process.env['OMP_NUM_THREADS'] ??= '2';
  process.env['MKL_NUM_THREADS'] ??= '2';
  main(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (e: unknown) => {
      console.error(`FAIL: ${(e as Error).message}`);
      process.exitCode = 1;
    },
  );
}
