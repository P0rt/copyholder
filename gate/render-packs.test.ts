// Tests of gate/render-packs.ts with a fake npm run tts (no Python): the arguments, the 16-bit step at
// the loudness of the doctor sample, the skip rule, the check of a new render before it is installed,
// the cue hashes of PREREG.md, a stopped render and the whole run on pack 0. Run:
//   npx vitest run gate/render-packs.test.ts
// Like gate/check-texts.test.ts, this file holds no pack content (review 10): the fake render finds the
// predicted timings of the text it is given, and assertions compare counts, hashes and blind lines.
import fc from 'fast-check';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { decodeNarratorWav } from '../web/ui/wav.ts';
import {
  GATE_DIR,
  PACK_FOLDER_FILES,
  PACK_SPECS,
  PASSAGE_KINDS,
  checkGate,
  parsePassage,
  sha256Hex,
  spokenText,
  wavInfo,
  type PackId,
  type PassageKind,
} from './check-texts.ts';
import { convertTtsWavToPcm16, peakDbfs, readWavFormat } from './level/wav16.ts';
import {
  LEVEL_MATCH_DB,
  LEVEL_WAV,
  MAX_SCALED_PEAK_DBFS,
  PCM16_CLIP_DBFS,
  USAGE,
  isInterruption,
  levelGainDb,
  main,
  packClipToPcm16,
  parseRenderArgs,
  rmsDbfs,
  staleReasons,
  wavSamples,
  type RenderPacksDeps,
  type RenderPassage,
} from './render-packs.ts';

const load = createRequire(import.meta.url);
const narrator = load('../live/lib/narrator.cjs') as {
  gateSource: (dir: string) => unknown;
  doctorSource: (...dirs: string[]) => unknown;
  narratorNames: (source: unknown) => string[];
  readNarrator: (source: unknown, name: string) => Promise<{ status: number; body: Buffer | null }>;
};
const { resolvePaths } = load('../live/lib/paths.cjs') as { resolvePaths: (env: Record<string, string>) => { levelDir: string; sampleDir: string } };

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
  const dir = tempDir('gate-render-');
  for (const id of ['0', 'A', 'B', 'C']) {
    const from = join(GATE_DIR, `pack-${id}`);
    mkdirSync(join(dir, `pack-${id}`));
    for (const name of readdirSync(from)) {
      if (/^(listen|objections)\.(txt|predicted\.json)$/.test(name)) cpSync(join(from, name), join(dir, `pack-${id}`, name));
    }
  }
  return dir;
}

/** A PREREG.md with only the cue-list hash table: a hash for the packs given, the placeholder for the rest. */
function preregWith(hashes: Partial<Record<PackId, string>> = {}): string {
  const file = join(tempDir('gate-prereg-'), 'PREREG.md');
  const rows = PACK_SPECS.map((s) => `| ${s.id} | \`${hashes[s.id] ?? `{{CUES_SHA256_${s.id}}}`}\` |`);
  writeFileSync(file, ['# Pre-registration', '', '| Pack | SHA-256 of `cues.json` |', '|---|---|', ...rows, ''].join('\n'));
  return file;
}

/** Each file of a folder with its SHA-256. */
const snapshot = (dir: string): Record<string, string> => Object.fromEntries(readdirSync(dir).sort().map((n) => [n, sha256Hex(readFileSync(join(dir, n)))]));

/** A float WAV laid out as tools/tts/tts.py writes it: fmt (format 3), fact, data. */
function floatWav(samples: Float32Array, rateHz = 48_000): Uint8Array {
  const data = samples.length * 4;
  const out = new Uint8Array(56 + data);
  const v = new DataView(out.buffer);
  const tag = (at: number, s: string): void => [...s].forEach((c, i) => v.setUint8(at + i, c.charCodeAt(0)));
  tag(0, 'RIFF');
  v.setUint32(4, out.length - 8, true);
  tag(8, 'WAVE');
  tag(12, 'fmt ');
  v.setUint32(16, 16, true);
  v.setUint16(20, 3, true);
  v.setUint16(22, 1, true);
  v.setUint32(24, rateHz, true);
  v.setUint32(28, rateHz * 4, true);
  v.setUint16(32, 4, true);
  v.setUint16(34, 32, true);
  tag(36, 'fact');
  v.setUint32(40, 4, true);
  v.setUint32(44, samples.length, true);
  tag(48, 'data');
  v.setUint32(52, data, true);
  samples.forEach((x, i) => v.setFloat32(56 + i * 4, x, true));
  return out;
}

/** A 220 Hz tone whose RMS is `rmsDb` dBFS. */
function tone(frames: number, rmsDb: number): Float32Array {
  const amp = Math.SQRT2 * 10 ** (rmsDb / 20);
  return Float32Array.from({ length: frames }, (_x, i) => amp * Math.sin((2 * Math.PI * 220 * i) / 48_000));
}

const referenceRms = rmsDbfs(wavSamples(new Uint8Array(readFileSync(LEVEL_WAV))));

/** The word timings of a render, to edit in a test. */
interface TimingsDoc {
  durationMs: number;
  durationSamples: number;
  words: { startMs: number; endMs: number }[];
}

interface FakeOptions {
  /** RMS of the rendered tone in dBFS (default: that of level.wav). */
  level?: number;
  /** Edits the timings of a render before they are written: a render that differs from the prediction. */
  edit?: (id: PackId, kind: PassageKind, timings: TimingsDoc) => void;
  /** An exit code in place of the render, by call number (0 for the first call). */
  exitCodes?: Record<number, number>;
}

interface Run {
  deps: RenderPacksDeps;
  out: string[];
  err: string[];
  /** `pack-<id> <kind>` of each render call. */
  calls: string[];
  /** The input file of each render call. */
  inputs: string[];
  /** The files of the rendered pack's folder at each render call. */
  folderAtCall: string[][];
  work: string[];
}

/**
 * Fakes npm run tts: finds the pack passage whose spoken text is the input, then writes a float WAV
 * as long as its predicted clip, at the loudness of level.wav, and the predicted timings as the real
 * ones (gate/predict_timings.py equals a render).
 */
function fakeRender(gateDir: string, run: Pick<Run, 'calls' | 'inputs' | 'folderAtCall'>, opts: FakeOptions = {}): RenderPassage {
  const passages = PACK_SPECS.flatMap((s) => PASSAGE_KINDS.map((kind) => ({ id: s.id, kind })));
  return async (input, wavOut, timingsOut) => {
    const text = spokenText(readFileSync(input, 'utf8'));
    const hit = passages.find(({ id, kind }) => spokenText(readFileSync(join(gateDir, `pack-${id}`, `${kind}.txt`), 'utf8')) === text);
    if (hit === undefined) throw new Error('the fake render was given a text of no pack');
    const dir = join(gateDir, `pack-${hit.id}`);
    const n = run.calls.push(`pack-${hit.id} ${hit.kind}`) - 1;
    run.inputs.push(input);
    run.folderAtCall.push(readdirSync(dir).sort());
    const code = opts.exitCodes?.[n];
    if (code !== undefined) return code;
    const timings = (JSON.parse(readFileSync(join(dir, `${hit.kind}.predicted.json`), 'utf8')) as { timings: TimingsDoc }).timings;
    opts.edit?.(hit.id, hit.kind, timings);
    writeFileSync(wavOut, floatWav(tone(timings.durationSamples, opts.level ?? referenceRms)));
    writeFileSync(timingsOut, `${JSON.stringify(timings, null, 2)}\n`);
    return 0;
  };
}

/** Deps for a run on a temp gate folder; PREREG.md binds nothing unless a file is given. */
function runner(gateDir: string, opts: FakeOptions = {}, preregFile = preregWith()): Run {
  const run: Run = { out: [], err: [], calls: [], inputs: [], folderAtCall: [], work: [], deps: undefined as unknown as RenderPacksDeps };
  run.deps = {
    gateDir,
    levelWav: LEVEL_WAV,
    preregFile,
    render: fakeRender(gateDir, run, opts),
    makeWorkDir: () => {
      const dir = tempDir('gate-render-work-');
      run.work.push(dir);
      return dir;
    },
    out: (l) => run.out.push(l),
    err: (l) => run.err.push(l),
  };
  return run;
}

/** Every line the command prints: pack ids, kinds, lengths, levels, sizes, counts, OK/FAIL and hashes only. */
const BLIND_LINES = [
  /^level\.wav: RMS -\d+\.\d\d dBFS, the loudness of the pack clips \(within 3 dB\)$/,
  /^pack [0ABC] (listen|objections): rendering$/,
  /^pack [0ABC] (listen|objections): \d+\.\d\d s, 16-bit PCM, peak -\d+\.\d\d dBFS, RMS -\d+\.\d\d dBFS, gain -?\d+\.\d dB, \d+ bytes( \(stored before\))?$/,
  /^pack [0ABC]: built; cues\.json SHA-256 [0-9a-f]{64}; pack\.json SHA-256 [0-9a-f]{64}$/,
  /^pack [0ABC]: (not rendered yet|NOT BUILT)$/,
  /^pack [0ABC]: skipped, already built and current \(--force renders it again\)$/,
  /^pack [0ABC]: NOT INSTALLED, \d+ problem\(s\) in the new render; the pack folder is unchanged:$/,
  /^pack [0ABC] (listen|objections): render FAILED \(exit code \d+\)$/,
  /^pack [0ABC] (listen|objections): render interrupted \(exit code \d+\); the run stops, nothing more is rendered or built$/,
  /^- pack [0ABC] objections render: \d+ word times differ from the prediction by more than \d+ ms \(render from other text, or predict again on this machine\)$/,
  /^- pack [0ABC] build: the new cues\.json differs from the SHA-256 that PREREG\.md holds for it: after the gate-prereg tag cues\.json stays byte for byte the same \(spec 9\.2, 13\.6\)$/,
  /^- pack [0ABC] (listen|objections): RMS -\d+\.\d\d dBFS stays more than 3 dB from level\.wav \(-\d+\.\d\d dBFS\)$/,
  /^pack [0ABC]: (OK|FAIL \(\d+ problem\(s\)\)), \d+ substitutions$/,
  /^OK: 4 packs pass every rule\.$/,
];
const isBlind = (line: string): boolean => BLIND_LINES.some((re) => re.test(line));

/** The objection passage of pack 0 in a gate folder. */
const objections0 = (gateDir: string) => parsePassage(readFileSync(join(gateDir, 'pack-0', 'objections.txt'), 'utf8'), true);

// ---------------------------------------------------------------------------------------------

describe('arguments', () => {
  it('takes pack ids in any case and order, all four by default', () => {
    expect(parseRenderArgs([])).toEqual({ packs: ['0', 'A', 'B', 'C'], force: false, mode: 'render', help: false });
    expect(parseRenderArgs(['c', 'A', 'pack-0', 'A'])).toEqual({ packs: ['0', 'A', 'C'], force: false, mode: 'render', help: false });
    expect(parseRenderArgs(['--force', 'B'])).toEqual({ packs: ['B'], force: true, mode: 'render', help: false });
    expect(parseRenderArgs(['--convert'])).toEqual({ packs: ['0', 'A', 'B', 'C'], force: false, mode: 'convert', help: false });
  });

  it('refuses unknown arguments and --force with --convert', async () => {
    for (const argv of [['D'], ['AB'], ['--frce'], ['--convert', '--force'], ['-f']]) {
      expect(parseRenderArgs(argv), argv.join(' ')).toHaveProperty('error');
      const r = runner(tempGate());
      expect(await main(argv, r.deps)).toBe(2);
      expect(r.err.join('\n')).toContain(USAGE);
      expect(r.out).toEqual([]);
      expect(r.calls).toEqual([]);
    }
  });

  it('prints the usage for --help and renders nothing', async () => {
    const r = runner(tempGate());
    expect(await main(['--help'], r.deps)).toBe(0);
    expect(r.out).toEqual([USAGE]);
    expect(r.calls).toEqual([]);
  });
});

describe('16-bit audio at the loudness of level.wav', () => {
  it('measures level.wav as the page decodes it', () => {
    expect(referenceRms).toBeGreaterThan(-35);
    expect(referenceRms).toBeLessThan(-15);
  });

  it('needs no gain within 3 dB, boosts or cuts outside it, and keeps a scaled peak at or below -1 dBFS', () => {
    expect(levelGainDb(-27, -6, -25.5)).toBe(0);
    expect(levelGainDb(-22.5, -3, -25.5)).toBe(0);
    expect(levelGainDb(-35, -20, -25.5)).toBeCloseTo(9.5, 9);
    expect(levelGainDb(-35, -4, -25.5)).toBeCloseTo(3, 9);
    expect(levelGainDb(-35, -0.5, -25.5)).toBe(0);
    expect(levelGainDb(-18, -0.2, -25.5)).toBeCloseTo(-7.5, 9);
    expect(levelGainDb(-20, 0.5, -25.5)).toBeCloseTo(-5.5, 9);
    expect(levelGainDb(-Infinity, -Infinity, -25.5)).toBe(0);
    expect(levelGainDb(Number.NaN, Number.NaN, -25.5)).toBe(0);
  });

  it('cuts a peak that would clip at 16 bits to -1 dBFS, even within 3 dB of the reference (review 17)', () => {
    expect(PCM16_CLIP_DBFS).toBeLessThan(0);
    expect(PCM16_CLIP_DBFS).toBeGreaterThan(-0.001);
    expect(levelGainDb(-25, 0.5, -25.5)).toBeCloseTo(-1.5, 9);
    expect(levelGainDb(-25.5, PCM16_CLIP_DBFS, -25.5)).toBeCloseTo(MAX_SCALED_PEAK_DBFS - PCM16_CLIP_DBFS, 9);
    expect(levelGainDb(-25.5, PCM16_CLIP_DBFS - 1e-6, -25.5)).toBe(0);
    // A boost the reference asks for becomes a cut when the peak clips.
    expect(levelGainDb(-30, 0.2, -25.5)).toBeCloseTo(-1.2, 9);
  });

  it('never leaves a clipping peak, never puts a scaled peak above -1 dBFS, and gets to the reference wherever the peak allows', () => {
    fc.assert(
      fc.property(fc.double({ min: -60, max: -6, noNaN: true }), fc.double({ min: 0, max: 30, noNaN: true }), fc.double({ min: -30, max: -15, noNaN: true }), (rms, crest, ref) => {
        // A float render may peak above 0 dBFS.
        const peak = rms + crest;
        const gain = levelGainDb(rms, peak, ref);
        const delta = ref - rms;
        expect(Number.isFinite(gain)).toBe(true);
        if (peak >= PCM16_CLIP_DBFS || gain !== 0) expect(peak + gain).toBeLessThanOrEqual(MAX_SCALED_PEAK_DBFS + 1e-9);
        if (peak >= PCM16_CLIP_DBFS) return;
        if (Math.abs(delta) <= LEVEL_MATCH_DB) expect(gain).toBe(0);
        else if (delta < 0) expect(gain).toBeCloseTo(delta, 9);
        else {
          expect(gain).toBeGreaterThanOrEqual(0);
          expect(gain).toBeLessThanOrEqual(delta + 1e-9);
          // Short of the reference only where the peak stops the boost at -1 dBFS.
          if (gain < delta - 1e-9) expect(peak + gain).toBeGreaterThanOrEqual(MAX_SCALED_PEAK_DBFS - 1e-9);
        }
      }),
      { numRuns: 200 },
    );
  });

  it('stores no clipped sample, whatever the level and the peak of the render (review 17)', () => {
    fc.assert(
      fc.property(fc.double({ min: -40, max: -6, noNaN: true }), fc.double({ min: 0.05, max: 1.6, noNaN: true }), (rmsDb, spike) => {
        const samples = tone(4_800, rmsDb);
        samples[123] = spike;
        const clip = packClipToPcm16(floatWav(samples), referenceRms);
        expect(clip.clippedSamples).toBe(0);
        if (clip.gainDb !== 0) expect(clip.peakDbfs).toBeLessThanOrEqual(MAX_SCALED_PEAK_DBFS + 0.001);
        expect(clip.peakDbfs).toBeLessThan(0);
        expect(clip.problems.length === 0).toBe(Math.abs(clip.rmsDbfs - referenceRms) <= LEVEL_MATCH_DB);
      }),
      { numRuns: 100 },
    );
  });

  it('converts a clip at the reference level exactly as the doctor sample was converted', () => {
    const src = floatWav(tone(48_000, referenceRms + 1));
    const clip = packClipToPcm16(src, referenceRms);
    expect(clip.gainDb).toBe(0);
    expect(clip.wav).toEqual(convertTtsWavToPcm16(src).wav);
    expect(clip.frames).toBe(48_000);
    expect(clip.problems).toEqual([]);
    expect(readWavFormat(clip.wav)).toMatchObject({ format: 1, channels: 1, sampleRateHz: 48_000, bitsPerSample: 16, dataOffset: 44, frames: 48_000 });
    expect(wavInfo(clip.wav)).toEqual({ sampleRateHz: 48_000, channels: 1, frames: 48_000, formatTag: 1, bitsPerSample: 16 });
    const page = decodeNarratorWav(clip.wav.buffer.slice(0) as ArrayBuffer, 'listen.wav');
    expect(page.length).toBe(48_000);
    expect(Math.abs(rmsDbfs(page) - (referenceRms + 1))).toBeLessThan(0.05);
  });

  it('scales a quiet clip to the reference RMS with one gain and keeps the sample count', () => {
    const clip = packClipToPcm16(floatWav(tone(24_000, referenceRms - 12)), referenceRms);
    expect(clip.gainDb).toBeCloseTo(12, 6);
    expect(Math.abs(clip.rmsDbfs - referenceRms)).toBeLessThan(0.05);
    expect(clip.peakDbfs).toBeLessThanOrEqual(MAX_SCALED_PEAK_DBFS);
    expect(clip.frames).toBe(24_000);
    expect(clip.problems).toEqual([]);
  });

  it('cuts a loud clip to the reference RMS', () => {
    const clip = packClipToPcm16(floatWav(tone(24_000, referenceRms + 8)), referenceRms);
    expect(clip.gainDb).toBeCloseTo(-8, 6);
    expect(Math.abs(clip.rmsDbfs - referenceRms)).toBeLessThan(0.05);
    expect(clip.problems).toEqual([]);
  });

  it('reports a clip the peak keeps too quiet', () => {
    const tooQuiet = /^RMS -\d+\.\d\d dBFS stays more than 3 dB from level\.wav \(-\d+\.\d\d dBFS\)$/;
    // A peak above -1 dBFS allows no boost at all: the clip is stored as it is.
    const spiky = tone(24_000, referenceRms - 12);
    spiky[100] = 0.95;
    const unscaled = packClipToPcm16(floatWav(spiky), referenceRms);
    expect(unscaled.gainDb).toBe(0);
    expect(unscaled.peakDbfs).toBeCloseTo(20 * Math.log10(0.95), 3);
    expect(unscaled.problems).toHaveLength(1);
    expect(unscaled.problems[0]).toMatch(tooQuiet);
    // A peak just below -1 dBFS allows a small boost: the stored peak sits at -1 dBFS (within 16-bit rounding).
    spiky[100] = 0.85;
    const quiet = packClipToPcm16(floatWav(spiky), referenceRms);
    expect(quiet.gainDb).toBeCloseTo(MAX_SCALED_PEAK_DBFS - 20 * Math.log10(0.85), 4);
    expect(quiet.peakDbfs).toBeLessThanOrEqual(MAX_SCALED_PEAK_DBFS + 0.001);
    expect(quiet.problems).toHaveLength(1);
    expect(quiet.problems[0]).toMatch(tooQuiet);
  });

  it('cuts a clip whose peak would clip, and refuses it only when the cut leaves it more than 3 dB from level.wav (review 17)', () => {
    // At the reference level: the cut to -1 dBFS costs under 3 dB, so the clip is stored, unclipped.
    const hot = tone(24_000, referenceRms);
    hot[7] = 1.25;
    const cut = packClipToPcm16(floatWav(hot), referenceRms);
    expect(cut.gainDb).toBeCloseTo(MAX_SCALED_PEAK_DBFS - 20 * Math.log10(1.25), 4);
    expect(cut.clippedSamples).toBe(0);
    expect(cut.peakDbfs).toBeLessThanOrEqual(MAX_SCALED_PEAK_DBFS + 0.001);
    expect(cut.problems).toEqual([]);
    // 2 dB under the reference, the same cut leaves it about 5 dB under: refused, still unclipped.
    const low = tone(24_000, referenceRms - 2);
    low[7] = 1.25;
    const refused = packClipToPcm16(floatWav(low), referenceRms);
    expect(refused.clippedSamples).toBe(0);
    expect(refused.problems).toHaveLength(1);
    expect(refused.problems[0]).toMatch(/^RMS -\d+\.\d\d dBFS stays more than 3 dB from level\.wav/);
  });

  it('refuses a clip with a sample that is not a number', () => {
    const broken = tone(24_000, referenceRms);
    broken[9] = Number.NaN;
    const clip = packClipToPcm16(floatWav(broken), referenceRms);
    expect(clip.gainDb).toBe(0);
    expect(clip.problems).toContain('1 samples clip at 16 bits');
  });

  it('refuses another rate', () => {
    expect(() => packClipToPcm16(floatWav(tone(100, -25), 24_000), referenceRms)).toThrow(/48000 Hz/);
  });
});

describe('doctor plays gate/level/level.wav, the loudness of the pack clips (spec 7.7; review 14)', () => {
  it('is served by host from the folder resolvePaths names, byte for byte', async () => {
    const paths = resolvePaths({});
    expect(paths.levelDir).toBe(dirname(LEVEL_WAV));
    const source = narrator.doctorSource(paths.levelDir, paths.sampleDir);
    expect(narrator.narratorNames(source)).toEqual(['level.wav']);
    const res = await narrator.readNarrator(source, 'level.wav');
    expect(res.status).toBe(200);
    expect(sha256Hex(res.body!)).toBe(sha256Hex(readFileSync(LEVEL_WAV)));
    const page = decodeNarratorWav(new Uint8Array(res.body!).buffer as ArrayBuffer, 'level.wav');
    expect(rmsDbfs(page)).toBeCloseTo(referenceRms, 6);
  });

  it('comes from gate/level before a level.wav of the sample folder', async () => {
    const sample = tempDir('gate-sample-');
    writeFileSync(join(sample, 'level.wav'), floatWav(tone(480, -30)));
    const res = await narrator.readNarrator(narrator.doctorSource(dirname(LEVEL_WAV), sample), 'level.wav');
    expect(res.status).toBe(200);
    expect(sha256Hex(res.body!)).toBe(sha256Hex(readFileSync(LEVEL_WAV)));
  });
});

describe('the packs in the repository', () => {
  const report = checkGate();

  it('are built and current, so a run without --force renders nothing', () => {
    for (const spec of PACK_SPECS) expect(staleReasons(report, spec.id), `pack ${spec.id}`).toEqual([]);
  });

  it('store 16-bit clips at the loudness of level.wav, without clipping', () => {
    for (const spec of PACK_SPECS) {
      for (const kind of PASSAGE_KINDS) {
        const bytes = new Uint8Array(readFileSync(join(GATE_DIR, `pack-${spec.id}`, `${kind}.wav`)));
        expect(readWavFormat(bytes)).toMatchObject({ format: 1, channels: 1, sampleRateHz: 48_000, bitsPerSample: 16, dataOffset: 44 });
        const samples = wavSamples(bytes);
        expect(Math.abs(rmsDbfs(samples) - referenceRms), `pack ${spec.id} ${kind}`).toBeLessThanOrEqual(LEVEL_MATCH_DB);
        expect(peakDbfs(samples)).toBeLessThan(0);
      }
    }
  });
});

describe('a run with a fake render (pack 0)', () => {
  it('renders, checks the new clips before it installs them, builds, and prints only blind lines', async () => {
    const gate = tempGate();
    const dir = join(gate, 'pack-0');
    const initial = readdirSync(dir).sort();
    const r = runner(gate);
    expect(await main(['0'], r.deps)).toBe(0);
    expect(r.calls).toEqual(['pack-0 listen', 'pack-0 objections']);
    // The render input of the objections is written into the work folder, and the pack folder gets
    // nothing until both clips are checked (review 12).
    expect(r.inputs[0]).toBe(join(dir, 'listen.txt'));
    expect(r.inputs[1]!.startsWith(r.work[0]!)).toBe(true);
    expect(r.folderAtCall).toEqual([initial, initial]);
    expect(r.out.filter((l) => !isBlind(l))).toEqual([]);
    expect(r.out).toContain('OK: 4 packs pass every rule.');
    expect(r.out.filter((l) => l.startsWith('pack 0: built; '))).toHaveLength(1);
    expect(r.out).toContain('pack A: not rendered yet');
    expect(r.err).toEqual([]);

    // Only the files of a pack, no temporary file; the work folders are gone.
    expect(readdirSync(dir).filter((n) => !PACK_FOLDER_FILES.includes(n))).toEqual([]);
    expect(r.work.length).toBe(1);
    expect(r.work.every((w) => !existsSync(w))).toBe(true);
    for (const kind of PASSAGE_KINDS) {
      const wav = new Uint8Array(readFileSync(join(dir, `${kind}.wav`)));
      const timings = JSON.parse(readFileSync(join(dir, `${kind}.timings.json`), 'utf8')) as { durationSamples: number };
      expect(readWavFormat(wav)).toMatchObject({ format: 1, bitsPerSample: 16, frames: timings.durationSamples });
    }
    expect(readFileSync(join(dir, 'objections.spoken.txt'), 'utf8')).not.toContain('[[');
    expect(checkGate({ gateDir: gate }).problems).toEqual([]);

    // host serves every file pack.json lists, each with its SHA-256 checked.
    const source = narrator.gateSource(dir);
    for (const name of ['cues.json', 'listen.wav', 'objections.wav', 'listen.timings.json', 'objections.timings.json']) {
      const res = await narrator.readNarrator(source, name);
      expect(res.status, name).toBe(200);
      expect(sha256Hex(res.body!)).toBe(sha256Hex(readFileSync(join(dir, name))));
    }
  });

  it('skips a pack that is built and current unless --force, and renders a changed one again', async () => {
    const gate = tempGate();
    const first = runner(gate);
    expect(await main(['0'], first.deps)).toBe(0);
    const builtPack = readFileSync(join(gate, 'pack-0', 'pack.json'));

    const again = runner(gate);
    expect(await main(['0'], again.deps)).toBe(0);
    expect(again.calls).toEqual([]);
    expect(again.out).toContain('pack 0: skipped, already built and current (--force renders it again)');
    expect(readFileSync(join(gate, 'pack-0', 'pack.json'))).toEqual(builtPack);

    const forced = runner(gate);
    expect(await main(['--force', '0'], forced.deps)).toBe(0);
    expect(forced.calls).toEqual(['pack-0 listen', 'pack-0 objections']);
    expect(readFileSync(join(gate, 'pack-0', 'pack.json'))).toEqual(builtPack);

    // A served file changed after the build: no longer current.
    const wav = join(gate, 'pack-0', 'listen.wav');
    const bytes = readFileSync(wav);
    bytes[200] = (bytes[200]! + 1) % 256;
    writeFileSync(wav, bytes);
    expect(staleReasons(checkGate({ gateDir: gate }), '0')).toEqual(['1 problem(s) in gate/check-texts.ts']);
    const changed = runner(gate);
    expect(await main(['0'], changed.deps)).toBe(0);
    expect(changed.calls).toEqual(['pack-0 listen', 'pack-0 objections']);
    expect(staleReasons(checkGate({ gateDir: gate }), '0')).toEqual([]);
  });

  it('names what is stale: no build, another engine, a float WAV', async () => {
    const gate = tempGate();
    expect(staleReasons(checkGate({ gateDir: gate }), '0')).toEqual([
      'no pack.json',
      'listen.wav cannot be read',
      'listen.timings.json cannot be read',
      'objections.wav cannot be read',
      'objections.timings.json cannot be read',
    ]);
    expect(await main(['0'], runner(gate).deps)).toBe(0);
    const file = join(gate, 'pack-0', 'objections.timings.json');
    const t = JSON.parse(readFileSync(file, 'utf8')) as { engine: Record<string, unknown> };
    t.engine.torchVersion = 'another build';
    writeFileSync(file, JSON.stringify(t));
    writeFileSync(join(gate, 'pack-0', 'listen.wav'), floatWav(tone(480, -25)));
    expect(staleReasons(checkGate({ gateDir: gate }), '0')).toEqual([
      '2 problem(s) in gate/check-texts.ts',
      'listen.wav is not 16-bit PCM, mono, 48 kHz',
      'objections.timings.json differs from the prediction',
    ]);
  });

  it('renders nothing for a pack whose text no longer fits its prediction', async () => {
    const gate = tempGate();
    const file = join(gate, 'pack-0', 'listen.txt');
    writeFileSync(file, `${readFileSync(file, 'utf8').trimEnd()} One more line.\n`);
    const r = runner(gate);
    expect(await main(['0'], r.deps)).toBe(1);
    expect(r.calls).toEqual([]);
    expect(r.out).toContain(
      'pack 0: NOT RENDERED, 1 problem(s) in the texts or predicted timings (run npm run gate:predict, then npx tsx gate/check-texts.ts):',
    );
    expect(r.out).toContain('- pack 0 listen: listen.predicted.json is out of date (run gate/predict_timings.py)');
    expect(existsSync(join(gate, 'pack-0', 'listen.wav'))).toBe(false);
  });

  it('leaves the pack folder as it was when a render fails', async () => {
    const gate = tempGate();
    const before = snapshot(join(gate, 'pack-0'));
    const r = runner(gate, { exitCodes: { 1: 1 } });
    expect(await main(['0'], r.deps)).toBe(1);
    expect(r.out).toContain('pack 0 objections: render FAILED (exit code 1)');
    expect(snapshot(join(gate, 'pack-0'))).toEqual(before);
    expect(r.work.every((w) => !existsSync(w))).toBe(true);
  });

  it('refuses a render far from the loudness of level.wav that the peak cannot fix', async () => {
    const gate = tempGate();
    const r = runner(gate, { level: referenceRms - 20 });
    const quiet = r.deps.render;
    r.deps.render = async (input, wav, timings) => {
      const code = await quiet(input, wav, timings);
      const bytes = readFileSync(wav);
      bytes.writeFloatLE(0.99, 56);
      writeFileSync(wav, bytes);
      return code;
    };
    expect(await main(['0'], r.deps)).toBe(1);
    expect(r.out.filter((l) => l.startsWith('- pack 0 listen: RMS '))).toHaveLength(1);
    expect(r.out.filter((l) => !isBlind(l))).toEqual([]);
    expect(existsSync(join(gate, 'pack-0', 'listen.wav'))).toBe(false);
  });

  it('--convert stores the float WAV files of npm run tts as 16-bit clips, then builds', async () => {
    const gate = tempGate();
    const render = fakeRender(gate, { calls: [], inputs: [], folderAtCall: [] });
    // gate/README.md step 4: npm run tts writes into the pack folder.
    const dir = join(gate, 'pack-0');
    writeFileSync(join(dir, 'objections.spoken.txt'), spokenText(readFileSync(join(dir, 'objections.txt'), 'utf8')));
    await render(join(dir, 'listen.txt'), join(dir, 'listen.wav'), join(dir, 'listen.timings.json'));
    await render(join(dir, 'objections.spoken.txt'), join(dir, 'objections.wav'), join(dir, 'objections.timings.json'));
    const r = runner(gate);
    expect(await main(['--convert', '0'], r.deps)).toBe(0);
    expect(r.calls).toEqual([]);
    expect(r.out.filter((l) => !isBlind(l))).toEqual([]);
    expect(readWavFormat(new Uint8Array(readFileSync(join(dir, 'listen.wav'))))).toMatchObject({ format: 1, bitsPerSample: 16 });
    expect(checkGate({ gateDir: gate }).problems).toEqual([]);

    const again = runner(gate);
    expect(await main(['--convert', '0'], again.deps)).toBe(0);
    expect(again.out.filter((l) => l.endsWith('(stored before)'))).toHaveLength(2);
    expect(again.out.filter((l) => !isBlind(l))).toEqual([]);
  });

  it('--convert reports a pack that was not rendered', async () => {
    const r = runner(tempGate());
    expect(await main(['--convert', '0'], r.deps)).toBe(1);
    expect(r.out).toContain('pack 0 listen: not rendered yet (npm run tts, gate/README.md step 4)');
  });
});

describe('a new render is checked before it is installed (review 12)', () => {
  /** A render whose first objection word starts 100 ms after the prediction: outside the 50 ms tolerance. */
  const late: FakeOptions = {
    edit: (_id, kind, t) => {
      if (kind === 'objections') t.words[0]!.startMs += 100;
    },
  };
  const notInstalled = 'pack 0: NOT INSTALLED, 1 problem(s) in the new render; the pack folder is unchanged:';

  it('refuses a render that fails a check of the build, and leaves the pack folder byte for byte as it was', async () => {
    const gate = tempGate();
    const dir = join(gate, 'pack-0');
    // A pack never built: nothing of the render lands in its folder.
    const initial = snapshot(dir);
    const first = runner(gate, late);
    expect(await main(['0'], first.deps)).toBe(1);
    expect(first.out).toContain(notInstalled);
    expect(first.out.filter((l) => /^- pack 0 objections render: 1 word times differ from the prediction by more than 50 ms/.test(l))).toHaveLength(1);
    expect(first.out.filter((l) => !isBlind(l))).toEqual([]);
    expect(snapshot(dir)).toEqual(initial);

    // A built pack: its clips, timings, cues.json and pack.json stay as they were.
    expect(await main(['0'], runner(gate).deps)).toBe(0);
    const built = snapshot(dir);
    const forced = runner(gate, late);
    expect(await main(['--force', '0'], forced.deps)).toBe(1);
    expect(forced.out).toContain(notInstalled);
    expect(snapshot(dir)).toEqual(built);
    expect(forced.work.every((w) => !existsSync(w))).toBe(true);
    expect(checkGate({ gateDir: gate }).problems).toEqual([]);
  });
});

describe('the cue hashes of PREREG.md (spec 9.2, 13.6; review 12)', () => {
  /** Moves the end of the cue word of substitution 1 by 30 ms: within the tolerance, but another cues.json. */
  const cueEarlier = (gate: string): FakeOptions => ({
    edit: (_id, kind, t) => {
      if (kind === 'objections') t.words[objections0(gate).substitutions[0]!.lastWordIndex]!.endMs -= 30;
    },
  });

  it('rebuilds a pack whose new cues.json keeps the hash PREREG.md holds: cues.json stays byte for byte the same', async () => {
    const gate = tempGate();
    expect(await main(['0'], runner(gate).deps)).toBe(0);
    const cuesFile = join(gate, 'pack-0', 'cues.json');
    const cuesSha = sha256Hex(readFileSync(cuesFile));
    const prereg = preregWith({ '0': cuesSha });
    const r = runner(gate, {}, prereg);
    expect(await main(['--force', '0'], r.deps)).toBe(0);
    expect(r.calls).toEqual(['pack-0 listen', 'pack-0 objections']);
    expect(r.out).toContain(`pack 0: built; cues.json SHA-256 ${cuesSha}; pack.json SHA-256 ${sha256Hex(readFileSync(join(gate, 'pack-0', 'pack.json')))}`);
    expect(sha256Hex(readFileSync(cuesFile))).toBe(cuesSha);
  });

  it('refuses a render that would change cues.json once PREREG.md holds its hash, and installs nothing', async () => {
    const gate = tempGate();
    expect(await main(['0'], runner(gate).deps)).toBe(0);
    const dir = join(gate, 'pack-0');
    const built = snapshot(dir);
    const prereg = preregWith({ '0': built['cues.json']! });
    const r = runner(gate, cueEarlier(gate), prereg);
    expect(await main(['--force', '0'], r.deps)).toBe(1);
    expect(r.out).toContain('pack 0: NOT INSTALLED, 1 problem(s) in the new render; the pack folder is unchanged:');
    expect(r.out).toContain(
      '- pack 0 build: the new cues.json differs from the SHA-256 that PREREG.md holds for it: after the gate-prereg tag cues.json stays byte for byte the same (spec 9.2, 13.6)',
    );
    expect(r.out.filter((l) => !isBlind(l))).toEqual([]);
    expect(snapshot(dir)).toEqual(built);
    // The same render with the placeholder in PREREG.md is installed, with another cue hash.
    const open = runner(gate, cueEarlier(gate));
    expect(await main(['--force', '0'], open.deps)).toBe(0);
    expect(sha256Hex(readFileSync(join(dir, 'cues.json')))).not.toBe(built['cues.json']);
  });
});

describe('a render stopped by a signal stops the run (review 13)', () => {
  it('reads exit codes of 128 and more as a signal', () => {
    expect(isInterruption(130)).toBe(true);
    expect(isInterruption(143)).toBe(true);
    expect(isInterruption(128)).toBe(true);
    expect(isInterruption(127)).toBe(false);
    expect(isInterruption(1)).toBe(false);
    expect(isInterruption(0)).toBe(false);
  });

  it('renders no other passage or pack, builds nothing, returns the exit code and leaves the folders as they were', async () => {
    for (const call of [0, 1]) {
      const gate = tempGate();
      const before = PACK_SPECS.map((s) => snapshot(join(gate, `pack-${s.id}`)));
      const r = runner(gate, { exitCodes: { [call]: 130 } });
      expect(await main(['0', 'A'], r.deps)).toBe(130);
      expect(r.calls).toEqual(['pack-0 listen', 'pack-0 objections'].slice(0, call + 1));
      const kind = call === 0 ? 'listen' : 'objections';
      expect(r.out[r.out.length - 1]).toBe(`pack 0 ${kind}: render interrupted (exit code 130); the run stops, nothing more is rendered or built`);
      expect(r.out.some((l) => l.includes('built') && !l.includes('nothing more'))).toBe(false);
      expect(r.out.filter((l) => !isBlind(l))).toEqual([]);
      expect(PACK_SPECS.map((s) => snapshot(join(gate, `pack-${s.id}`)))).toEqual(before);
      expect(r.work.every((w) => !existsSync(w))).toBe(true);
    }
  });
});
