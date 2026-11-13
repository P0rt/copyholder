// Fixtures of tests/e2e/integration.spec.ts: the fake microphone, a stand-in pack 0, the page build,
// the real host as a child process and the checks of a recorded session folder (spec 8.1).
// Nothing here prints the words or the cue times of the real gate packs (spec 9.2).

import { spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'vite';
import { Scene, createRng, paSyllable, sniff } from '../../../core/vad/synth.ts';
import { evenWords, synthPassage, wavBytes } from '../../../web/lib/testing/synth.ts';
import { GATE_LAYOUT } from '../../../web/scenarios/gate.ts';

export const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url));
export const HOST_FILE = join(REPO_ROOT, 'live', 'host.cjs');
export const SAMPLE_RATE_HZ = 48_000;

// ---------------------------------------------------------------- the fake microphone

/** One cycle of the fake microphone: a 'pa' at its start, a sniff after it, background between. */
export const MIC_CYCLE_MS = 2000;
export const MIC_SNIFF_AT_MS = 800;
/** Levels in dB re full scale (RMS): the vowel, the sniff noise, the white background. */
export const MIC_LEVELS_DB = { vowel: -24, sniff: -32, background: -62 } as const;

/**
 * Speech-like microphone audio that Chromium loops as the fake capture device: every 2 s a 'pa'
 * from closed lips (plosive burst, then a 250 ms voiced /a/), 0.8 s later a sharp sniff, white
 * background noise under both. Whatever the phase of the loop against the scenario, every 2 s
 * window holds a fresh sniff onset, every 3 s window a 'pa' burst, and every 10 s window several
 * voice onsets that follow 1.7 s of silence (core/vad voice_off needs 1.2 s). No loop-check click
 * reaches this microphone, so the loop checks cannot be found.
 */
export function fakeMicSamples(seconds = 30, seed = 7): Float32Array {
  const rng = createRng(seed);
  const scene = new Scene(seconds * 1000).background(MIC_LEVELS_DB.background, rng);
  for (let t = 0; t + MIC_CYCLE_MS <= seconds * 1000; t += MIC_CYCLE_MS) {
    scene.add(paSyllable({ levelDb: MIC_LEVELS_DB.vowel, f0Hz: [130, 115] }, rng), t);
    scene.add(sniff({ levelDb: MIC_LEVELS_DB.sniff }, rng), t + MIC_SNIFF_AT_MS);
  }
  return scene.toFloat32(0.99);
}

/** Writes the fake microphone as a 16-bit 48 kHz mono WAV (--use-file-for-fake-audio-capture). */
export function writeFakeMicWav(file: string): string {
  writeFileSync(file, wavBytes(fakeMicSamples()));
  return file;
}

/** Chromium flags for a run with the fake microphone (spec 7.3: Playwright with a microphone from a file). */
export function chromiumArgs(micWav: string): string[] {
  return [
    '--use-fake-ui-for-media-stream',
    '--use-fake-device-for-media-stream',
    `--use-file-for-fake-audio-capture=${micWav}`,
    '--autoplay-policy=no-user-gesture-required',
  ];
}

// ---------------------------------------------------------------- the page

/** The production page (npm run build:web), built into `outDir` so web/dist stays as it is. */
export async function buildPage(outDir: string): Promise<string> {
  await build({
    configFile: join(REPO_ROOT, 'web', 'vite.config.ts'),
    mode: 'production',
    logLevel: 'warn',
    build: { outDir, emptyOutDir: true },
  });
  if (!existsSync(join(outDir, 'index.html'))) throw new Error(`the page build wrote no index.html into ${outDir}`);
  return outDir;
}

// ---------------------------------------------------------------- pack 0

/** The line gate/check-texts.ts ends with when every pack passes (gate/README.md step 2). */
export const CHECK_TEXTS_OK = 'OK: 4 packs pass every rule.';

/**
 * Whether the real pack 0 can be used: pack.json and cues.json exist and gate/check-texts.ts ends
 * with the OK line. Its output is never shown: it is only searched for that exact line.
 */
export async function realPackZeroReady(): Promise<{ ok: boolean; why: string }> {
  const dir = join(REPO_ROOT, 'gate', 'pack-0');
  for (const f of ['pack.json', 'cues.json']) if (!existsSync(join(dir, f))) return { ok: false, why: `gate/pack-0/${f} is missing` };
  const r = await runQuiet('npx', ['tsx', 'gate/check-texts.ts'], 180_000);
  if (r.timedOut) return { ok: false, why: 'gate/check-texts.ts did not finish in 3 minutes' };
  const lines = r.stdout.split('\n').map((l) => l.trim());
  return lines.includes(CHECK_TEXTS_OK) ? { ok: true, why: CHECK_TEXTS_OK } : { ok: false, why: `gate/check-texts.ts did not print "${CHECK_TEXTS_OK}" (exit ${String(r.code)})` };
}

/** After a command's exit, how long its last stdout may take to arrive. */
const STDOUT_DRAIN_MS = 2000;

/**
 * Runs a command in a process group of its own and resolves at its exit plus a short drain of stdout, so a
 * leftover process that holds the pipe never keeps the test waiting. On the timeout, after the exit, and
 * when the test process exits first, the whole group is killed: npx, tsx and node together.
 */
export function runQuiet(cmd: string, args: string[], timeoutMs: number): Promise<{ code: number | null; stdout: string; timedOut: boolean }> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd: REPO_ROOT, stdio: ['ignore', 'pipe', 'ignore'], env: { ...process.env }, detached: true });
    let stdout = '';
    let timedOut = false;
    let settled = false;
    const killGroup = () => {
      if (child.pid === undefined) return;
      try {
        process.kill(-child.pid, 'SIGKILL');
      } catch {
        // the group is gone
      }
    };
    process.on('exit', killGroup);
    const timer = setTimeout(() => {
      timedOut = true;
      killGroup();
    }, timeoutMs);
    const finish = (code: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      killGroup(); // whatever the command left running
      process.off('exit', killGroup);
      resolve({ code, stdout, timedOut });
    };
    child.stdout?.on('data', (d: Buffer) => {
      stdout += d.toString('utf8');
    });
    // 'close' waits for every holder of the stdout pipe, 'exit' only for the command itself
    const closed = new Promise<void>((r) => child.once('close', () => r()));
    child.once('error', () => finish(null));
    child.once('exit', (code) => void settles(closed, STDOUT_DRAIN_MS).then(() => finish(code)));
  });
}

const sha256 = (b: Uint8Array | string): string => createHash('sha256').update(b).digest('hex');

/** Stand-in cue times (ms from the objection block start): spec 9.2 rules for two cues (gate/check-texts.ts). */
export const STANDIN_CUES_MS = [16_000, 34_000] as const;

/** timings/1 of evenly spaced stand-in words (tools/tts/timings.ts; the page reads index, startMs, endMs). */
function standInTimings(words: ReturnType<typeof evenWords>, totalMs: number): string {
  return `${JSON.stringify(
    {
      schema: 'timings/1',
      wordRule: 'copyholder-words/1',
      sampleRateHz: SAMPLE_RATE_HZ,
      durationSamples: Math.round((totalMs * SAMPLE_RATE_HZ) / 1000),
      durationMs: totalMs,
      wordCount: words.length,
      sentenceCount: 1,
      engine: { name: 'stand-in (tests/e2e/fixtures/integration.ts)' },
      correctedChunks: 0,
      words: words.map((w, index) => ({ index, startMs: w.startMs, endMs: w.endMs, sentenceIndex: 0 })),
    },
    null,
    2,
  )}\n`;
}

/**
 * A stand-in pack 0 in `<gateDir>/pack-0/`: short 16-bit 48 kHz mono tone passages (listen 30 s,
 * objections 50 s), their timings, cues.json and pack.json in the formats of gate/check-texts.ts
 * (formatCuesJson, formatPackJson) that live/lib/narrator.cjs packListing reads.
 */
export function writeStandInPackZero(gateDir: string): string {
  const dir = join(gateDir, 'pack-0');
  mkdirSync(dir, { recursive: true });
  const layout = GATE_LAYOUT['0'];
  const clips = {
    listen: { ms: Math.round((layout.listenSamples * 1000) / SAMPLE_RATE_HZ), freq: 220 },
    objections: { ms: 50_000, freq: 196 },
  };
  const files: Record<string, { sha256: string }> = {};
  const put = (name: string, bytes: Uint8Array | string) => {
    writeFileSync(join(dir, name), bytes);
    files[name] = { sha256: sha256(bytes) };
  };
  for (const [kind, c] of Object.entries(clips)) {
    const words = evenWords(Math.floor((c.ms - 400) / 450), 300, 150);
    put(`${kind}.wav`, wavBytes(synthPassage(words, c.ms, c.freq, 0.25)));
    put(`${kind}.timings.json`, standInTimings(words, c.ms));
  }
  put('cues.json', `${JSON.stringify(STANDIN_CUES_MS)}\n`);
  const pack = {
    schema: 'gate-pack/1',
    pack: '0',
    note: 'Stand-in pack 0 for tests/e2e/integration.spec.ts: generated tones, not the real pack.',
    files,
    spoken: { listen: { sha256: sha256('stand-in listen') }, objections: { sha256: sha256('stand-in objections') } },
  };
  writeFileSync(join(dir, 'pack.json'), `${JSON.stringify(pack, null, 2)}\n`);
  return dir;
}

// ---------------------------------------------------------------- host

export interface HostProcess {
  proc: ChildProcess;
  /** host's stdout so far. */
  stdout(): string;
  /** stdout and stderr together, in arrival order. */
  output(): string;
  /** The page address host printed (http://127.0.0.1:<port>/?token=<token>). */
  url: string;
  exited: Promise<number | null>;
  /** Waits for host to exit by itself; rejects after `ms`. */
  waitExit(ms: number): Promise<number | null>;
  /** Ends host as Ctrl+C twice would, then kills it (cleanup after a failure). */
  stop(): Promise<void>;
}

const URL_RE = /(?:Open this address in Chrome|Opening Chrome at): (http:\/\/127\.0\.0\.1:\d+\/\?token=[0-9a-f]+)/;

/**
 * Starts `node live/host.cjs <args> --no-open` as the npm scripts do, with the sessions in
 * `sessionsDir`, a port the system picks and no device names from a settings.env.
 */
export async function startHost(args: string[], env: Record<string, string>, readyMs = 60_000): Promise<HostProcess> {
  const proc = spawn(process.execPath, [HOST_FILE, ...args, '--no-open'], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      COPYHOLDER_PORT: '0',
      COPYHOLDER_ALLOW_DIRTY: '1',
      COPYHOLDER_MIC_NAME: '',
      COPYHOLDER_OUTPUT_NAME: '',
      // Python and torch of the doctor's TTS self-test stay light on a shared machine
      OMP_NUM_THREADS: '2',
      MKL_NUM_THREADS: '2',
      ...env,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  let all = '';
  const listeners = new Set<() => void>();
  proc.stdout?.on('data', (d: Buffer) => {
    out += d.toString('utf8');
    all += d.toString('utf8');
    for (const l of listeners) l();
  });
  proc.stderr?.on('data', (d: Buffer) => {
    all += d.toString('utf8');
    for (const l of listeners) l();
  });
  const exited = new Promise<number | null>((resolve) => proc.once('exit', (code) => resolve(code)));
  // the error names the process, so a test can see that it is gone
  const hostError = (message: string) => Object.assign(new Error(message), { pid: proc.pid });
  const stop = async () => {
    if (proc.exitCode !== null || proc.signalCode !== null) return;
    proc.kill('SIGINT'); // host stops the recording, saves and ends quickcheck's process group
    if (await settles(exited, 8000)) return;
    proc.kill('SIGINT'); // the second Ctrl+C: host exits at once and kills quickcheck's group
    if (await settles(exited, 3000)) return;
    proc.kill('SIGKILL'); // tap, its child, ends when the IPC channel closes
    await settles(exited, 3000);
  };
  const url = await new Promise<string>((resolve, reject) => {
    let gaveUp = false;
    const check = () => {
      const m = URL_RE.exec(out);
      if (m?.[1]) {
        listeners.delete(check);
        clearTimeout(timer);
        resolve(m[1]);
      }
    };
    const timer = setTimeout(() => {
      gaveUp = true;
      listeners.delete(check);
      // no caller gets this process: end it (and its tap) before failing
      void stop().finally(() => reject(hostError(`host printed no page address in ${readyMs} ms:\n${all}`)));
    }, readyMs);
    listeners.add(check);
    void exited.then((code) => {
      if (gaveUp) return; // the exit stop() caused: the timeout rejects
      clearTimeout(timer);
      listeners.delete(check);
      reject(hostError(`host exited (${String(code)}) before it printed the page address:\n${all}`));
    });
    check();
  });
  const waitExit = (ms: number) =>
    Promise.race([
      exited,
      new Promise<number | null>((_, reject) => setTimeout(() => reject(new Error(`host did not exit within ${ms} ms`)), ms).unref()),
    ]);
  return { proc, stdout: () => out, output: () => all, url, exited, waitExit, stop };
}

async function settles(p: Promise<unknown>, ms: number): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  const r = await Promise.race([p.then(() => true), new Promise<boolean>((resolve) => (timer = setTimeout(() => resolve(false), ms)))]);
  clearTimeout(timer);
  return r;
}

// ---------------------------------------------------------------- the session folder

/** The one folder host made in `sessionsDir`: the one not among `before` (the folders a test put there). */
export function newSessionDir(sessionsDir: string, before: ReadonlySet<string> = new Set()): string {
  const dirs = readdirSync(sessionsDir).filter((d) => !before.has(d));
  if (dirs.length !== 1 || dirs[0] === undefined) throw new Error(`expected one new session folder in ${sessionsDir}, found ${dirs.length}: ${dirs.join(', ')}`);
  return join(sessionsDir, dirs[0]);
}

/**
 * calib.json of an earlier doctor recording, as host and doctor leave it in sessions/doctor-<n>/ (spec 7.7,
 * 8.1): host gives it to the next recording's page through /api/config (live/lib/calib.cjs pageCalib).
 */
export function seedDoctorCalib(sessionsDir: string, calib: Record<string, unknown>, id = 'doctor-1'): string {
  const dir = join(sessionsDir, id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'calib.json'), `${JSON.stringify({ schema: 'calib/1', ...calib }, null, 2)}\n`);
  return id;
}

export function readJson<T = Record<string, unknown>>(file: string): T {
  return JSON.parse(readFileSync(file, 'utf8')) as T;
}

/** RMS in dB re full scale of x[from, to); -Infinity for silence. */
export function rmsDb(x: Float32Array, from: number, to: number): number {
  let s = 0;
  const a = Math.max(0, from);
  const b = Math.min(x.length, to);
  for (let i = a; i < b; i++) s += x[i]! * x[i]!;
  return b > a && s > 0 ? 10 * Math.log10(s / (b - a)) : Number.NEGATIVE_INFINITY;
}
