// npm run tts -- <in.txt|-> <out.wav> <out.timings.json>      render one passage ("-": text on stdin)
// npm run tts -- --selftest                                    exactly one TTS SELFTEST line, exit 0 or 1
// npm run tts -- --set <out.json> <id> <clip.wav> <clip.timings.json> [<id> <wav> <timings> ...]
// Runs tools/tts/tts.py (Kokoro) through uv (spec 7.7, 13.3). A render passes uv's exit code through,
// then checks timings.json against words.ts and the written WAV. --set joins per-clip timings into
// one timings-set/1 file with the SHA-256 of each WAV: the sealed folder and sample/ keep one
// timings.json beside opening, p1, p2 and p3 (spec 8.2).

import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { accessSync, closeSync, constants as fsConstants, fsyncSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeSync } from 'node:fs';
import { constants, homedir } from 'node:os';
import { basename, delimiter, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  makeTimingsSet,
  parseTimings,
  stripBom,
  timingsProblems,
  timingsSetJson,
  timingsTextProblems,
  wavInfo,
  wavTimingsProblems,
  type TimingsSetEntry,
} from './timings.ts';

export const TTS_DIR = dirname(fileURLToPath(import.meta.url));
export const TTS_SCRIPT = join(TTS_DIR, 'tts.py');

/** Exit code when uv is missing outside the selftest, as a shell reports a missing command. */
export const EXIT_UV_MISSING = 127;
/** Exit code for wrong usage of --set. */
export const EXIT_USAGE = 2;

export const UV_MISSING_HELP = [
  'uv not found. The narrator voice (Kokoro, spec 7.7) runs in a Python 3.12 environment that uv manages.',
  'Install uv, open a new terminal, then run the command again:',
  '  macOS with Homebrew:  brew install uv',
  '  macOS or Linux:       curl -LsSf https://astral.sh/uv/install.sh | sh',
  'Details: https://docs.astral.sh/uv/getting-started/installation/',
  'If uv is installed somewhere unusual, set UV=/path/to/uv.',
].join('\n');

export const SET_USAGE = 'usage: npm run tts -- --set <out.json> <id> <clip.wav> <clip.timings.json> [<id> <wav> <timings> ...]';

export interface RunOptions {
  cwd: string;
  /** Bytes for the child's stdin; without them the child shares this process's stdin. */
  stdin?: Uint8Array;
  /** Collect the child's stdout instead of sharing this process's. */
  captureStdout?: boolean;
}

export interface RunResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  /** The child's stdout when captured, else ''. */
  stdout: string;
}

export interface RunDeps {
  env: NodeJS.ProcessEnv;
  platform: NodeJS.Platform;
  home: string;
  cwd: string;
  /** True for a regular file this process may execute. */
  isExecutableFile: (path: string) => boolean;
  readText: (path: string) => string;
  readBytes: (path: string) => Uint8Array;
  /** All of this process's stdin: the passage when the input is "-". */
  readStdin: () => Promise<Uint8Array>;
  /** Writes through a temporary file in the same folder, mode 0600. */
  writeText: (path: string, text: string) => void;
  /** Starts the child, resolves with its exit code or signal; rejects when it cannot start. */
  run: (cmd: string, args: string[], opts: RunOptions) => Promise<RunResult>;
  out: (line: string) => void;
  err: (line: string) => void;
}

/** Places to look for uv: $UV, then PATH, then the usual install folders. */
export function uvCandidates(env: NodeJS.ProcessEnv, platform: NodeJS.Platform, home: string): string[] {
  const exe = platform === 'win32' ? 'uv.exe' : 'uv';
  const out: string[] = [];
  if (env.UV) out.push(env.UV);
  for (const dir of (env.PATH ?? '').split(delimiter)) if (dir) out.push(join(dir, exe));
  out.push(join(home, '.local', 'bin', exe), join(home, '.cargo', 'bin', exe));
  if (platform === 'darwin') out.push('/opt/homebrew/bin/uv', '/usr/local/bin/uv');
  return out;
}

/** The first candidate that is an executable file; a folder or a file without the x bit is skipped. */
export function findUv(deps: Pick<RunDeps, 'env' | 'platform' | 'home' | 'isExecutableFile'>): string | null {
  return uvCandidates(deps.env, deps.platform, deps.home).find((p) => deps.isExecutableFile(p)) ?? null;
}

/** uv arguments: --locked keeps uv.lock as committed instead of resolving again. */
export function uvArgs(ttsArgs: string[]): string[] {
  return ['run', '--locked', '--project', TTS_DIR, 'python', TTS_SCRIPT, ...ttsArgs];
}

/** The three file arguments of a render ("-" is stdin), or null for --selftest, --help and wrong usage. */
export function renderFiles(ttsArgs: string[]): { input: string; wav: string; timings: string } | null {
  if (ttsArgs.includes('--selftest') || ttsArgs.includes('--help') || ttsArgs.includes('-h')) return null;
  const files = ttsArgs.filter((a) => a === '-' || !a.startsWith('-'));
  if (files.length !== 3) return null;
  return { input: files[0]!, wav: files[1]!, timings: files[2]! };
}

export function signalExitCode(signal: NodeJS.Signals): number {
  return 128 + (constants.signals[signal] ?? 0);
}

/** Collapses every run of whitespace and line breaks (NEL and the C0 separators too) to one space. */
const oneLine = (s: string): string => s.replace(/[\s\u0085\u001c-\u001f]+/g, ' ').trim();
const SELFTEST_OK = /^TTS SELFTEST OK \d+ \d+$/;

/**
 * The one line and exit code of a selftest from what uv and tts.py did: tts.py's own line when it
 * printed one and its exit code agrees, otherwise a FAIL line that says what happened instead
 * (spec 7.7: doctor reads this line). Other stdout lines go to stderr.
 */
export function selftestOutcome(r: RunResult): { line: string; exitCode: 0 | 1; other: string[] } {
  const lines = r.stdout.split(/\r\n|\n|\r/).map(oneLine).filter((l) => l !== '');
  const other = lines.filter((l) => !l.startsWith('TTS SELFTEST '));
  const last = lines.filter((l) => l.startsWith('TTS SELFTEST ')).pop();
  if (r.signal !== null) return { line: `TTS SELFTEST FAIL: stopped by ${r.signal}`, exitCode: 1, other: last === undefined ? other : [...other, last] };
  if (last === undefined) {
    return { line: `TTS SELFTEST FAIL: uv exited with code ${String(r.code)} before the selftest printed its result`, exitCode: 1, other };
  }
  if (SELFTEST_OK.test(last)) {
    if (r.code === 0) return { line: last, exitCode: 0, other };
    return { line: `TTS SELFTEST FAIL: exit code ${String(r.code)} after ${last}`, exitCode: 1, other };
  }
  if (last.startsWith('TTS SELFTEST FAIL:')) {
    return { line: `TTS SELFTEST FAIL: ${last.slice('TTS SELFTEST FAIL:'.length).trim() || 'no reason given'}`, exitCode: 1, other };
  }
  return { line: 'TTS SELFTEST FAIL: unreadable result line', exitCode: 1, other: [...other, last] };
}

async function selftest(ttsArgs: string[], uv: string, deps: RunDeps): Promise<number> {
  let r: RunResult;
  try {
    r = await deps.run(uv, uvArgs(ttsArgs), { cwd: deps.cwd, captureStdout: true });
  } catch (e) {
    deps.err(`cannot start ${uv}: ${(e as Error).message}`);
    deps.out('TTS SELFTEST FAIL: cannot start uv');
    return 1;
  }
  const outcome = selftestOutcome(r);
  for (const l of outcome.other) deps.err(l);
  deps.out(outcome.line);
  return outcome.exitCode;
}

/** Checks a finished render: timings.json against words.ts and against the WAV it describes. */
export function renderProblems(text: string, timingsJson: string, wav: Uint8Array): string[] {
  const timings = parseTimings(JSON.parse(timingsJson));
  const info = wavInfo(wav);
  const format = info.formatTag === 3 && info.bitsPerSample === 32 ? [] : [`the WAV is format ${info.formatTag}, ${info.bitsPerSample} bit, expected 32-bit float`];
  return [...timingsProblems(timings), ...timingsTextProblems(timings, stripBom(text)), ...format, ...wavTimingsProblems(info, timings)];
}

async function render(ttsArgs: string[], uv: string, deps: RunDeps): Promise<number> {
  const files = renderFiles(ttsArgs);
  const stdin = files?.input === '-' ? await deps.readStdin() : undefined;
  let r: RunResult;
  try {
    r = await deps.run(uv, uvArgs(ttsArgs), stdin === undefined ? { cwd: deps.cwd } : { cwd: deps.cwd, stdin });
  } catch (e) {
    deps.err(`cannot start ${uv}: ${(e as Error).message}`);
    return 1;
  }
  if (r.signal !== null) return signalExitCode(r.signal);
  if (r.code !== 0) return r.code ?? 1;
  if (files === null) return 0;
  try {
    const text = stdin === undefined ? deps.readText(resolve(deps.cwd, files.input)) : new TextDecoder('utf-8', { fatal: true }).decode(stdin);
    const problems = renderProblems(text, deps.readText(resolve(deps.cwd, files.timings)), deps.readBytes(resolve(deps.cwd, files.wav)));
    if (problems.length > 0) {
      deps.err(`TTS FAIL: timings.json does not match words.ts or the WAV: ${problems.slice(0, 3).join('; ')}`);
      return 1;
    }
  } catch (e) {
    deps.err(`TTS FAIL: cannot check timings.json: ${(e as Error).message}`);
    return 1;
  }
  return 0;
}

export function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/** --set: one timings-set/1 file from per-clip WAV and timings.json pairs, each checked first. */
export function joinTimings(args: string[], deps: RunDeps): number {
  const [out, ...rest] = args;
  if (out === undefined || out.startsWith('-') || rest.length === 0 || rest.length % 3 !== 0) {
    deps.err(SET_USAGE);
    return EXIT_USAGE;
  }
  try {
    const entries: TimingsSetEntry[] = [];
    for (let i = 0; i < rest.length; i += 3) {
      const [passageId, wavPath, timingsPath] = rest.slice(i, i + 3) as [string, string, string];
      const wav = deps.readBytes(resolve(deps.cwd, wavPath));
      const timings = parseTimings(JSON.parse(deps.readText(resolve(deps.cwd, timingsPath))));
      const problems = [...timingsProblems(timings), ...wavTimingsProblems(wavInfo(wav), timings)];
      if (problems.length > 0) throw new Error(`passage ${passageId}: ${problems.slice(0, 3).join('; ')}`);
      entries.push({ passageId, audioSha256: sha256Hex(wav), timings });
    }
    deps.writeText(resolve(deps.cwd, out), timingsSetJson(makeTimingsSet(entries)));
    deps.out(`TTS SET OK ${entries.length} ${entries.length === 1 ? 'passage' : 'passages'}`);
    return 0;
  } catch (e) {
    deps.err(`TTS FAIL: ${(e as Error).message}`);
    return 1;
  }
}

export async function main(ttsArgs: string[], deps: RunDeps): Promise<number> {
  if (ttsArgs[0] === '--set') return joinTimings(ttsArgs.slice(1), deps);
  const isSelftest = ttsArgs.includes('--selftest');
  const uv = findUv(deps);
  if (uv === null) {
    deps.err(UV_MISSING_HELP);
    if (isSelftest) deps.out('TTS SELFTEST FAIL: uv not found');
    return isSelftest ? 1 : EXIT_UV_MISSING;
  }
  return isSelftest ? selftest(ttsArgs, uv, deps) : render(ttsArgs, uv, deps);
}

/**
 * Spawns cmd and waits for it. While it runs, this process ignores SIGINT and SIGTERM: Ctrl+C
 * reaches uv and Python too, and their exit code is what counts. The listeners go away when the
 * child exits and when it cannot start (Node then emits 'error' and no 'exit').
 */
export function runChild(cmd: string, args: string[], opts: RunOptions): Promise<RunResult> {
  return new Promise((done, fail) => {
    const ignore = (): void => {};
    let settled = false;
    let drain: NodeJS.Timeout | undefined;
    let stdout = '';
    let exited: { code: number | null; signal: NodeJS.Signals | null } | null = null;
    const finish = (settle: () => void): void => {
      if (settled) return;
      settled = true;
      if (drain !== undefined) clearTimeout(drain);
      process.off('SIGINT', ignore);
      process.off('SIGTERM', ignore);
      settle();
    };
    process.on('SIGINT', ignore);
    process.on('SIGTERM', ignore);
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(cmd, args, {
        cwd: opts.cwd,
        stdio: [opts.stdin === undefined ? 'inherit' : 'pipe', opts.captureStdout ? 'pipe' : 'inherit', 'inherit'],
      });
    } catch (e) {
      finish(() => fail(e as Error));
      return;
    }
    child.on('error', (e) => finish(() => fail(e)));
    child.stdout?.setEncoding('utf8').on('data', (s: string) => {
      stdout += s;
    });
    if (opts.stdin !== undefined && child.stdin) {
      child.stdin.on('error', () => {}); // a child that exits without reading stdin
      child.stdin.end(Buffer.from(opts.stdin));
    }
    child.on('exit', (code, signal) => {
      exited = { code, signal };
      // The last stdout bytes arrive before 'close'; a grandchild holding the pipe must not hold us.
      drain = setTimeout(() => finish(() => done({ code, signal, stdout })), 2000);
    });
    child.on('close', (code, signal) => finish(() => done({ code: exited?.code ?? code, signal: exited?.signal ?? signal, stdout })));
  });
}

function isExecutableFile(path: string): boolean {
  try {
    if (!statSync(path).isFile()) return false;
    accessSync(path, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** Writes through a temporary file in the same folder, mode 0600, then renames it into place. */
export function writeFileAtomic(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = join(dirname(path), `.${basename(path)}.${process.pid}.tmp`);
  const fd = openSync(tmp, 'w', 0o600);
  try {
    writeSync(fd, text);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  try {
    renameSync(tmp, path);
  } catch (e) {
    rmSync(tmp, { force: true });
    throw e;
  }
}

async function readAllStdin(): Promise<Uint8Array> {
  const chunks: Buffer[] = [];
  for await (const c of process.stdin) chunks.push(typeof c === 'string' ? Buffer.from(c) : (c as Buffer));
  return new Uint8Array(Buffer.concat(chunks));
}

/** Real process, file system and console. */
export function nodeDeps(): RunDeps {
  return {
    env: process.env,
    platform: process.platform,
    home: homedir(),
    // npm runs scripts from the package root; INIT_CWD is where `npm run` was typed.
    cwd: process.env.INIT_CWD ?? process.cwd(),
    isExecutableFile,
    readText: (p) => readFileSync(p, 'utf8'),
    readBytes: (p) => new Uint8Array(readFileSync(p)),
    readStdin: readAllStdin,
    writeText: writeFileAtomic,
    run: runChild,
    out: (line) => process.stdout.write(`${line}\n`),
    err: (line) => process.stderr.write(`${line}\n`),
  };
}

function isEntryPoint(): boolean {
  try {
    return process.argv[1] !== undefined && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isEntryPoint()) {
  main(process.argv.slice(2), nodeDeps()).then(
    (code) => process.exit(code),
    (e: unknown) => {
      process.stderr.write(`TTS FAIL: ${(e as Error).message}\n`);
      process.exit(1);
    },
  );
}
