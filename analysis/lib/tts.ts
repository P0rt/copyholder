// The TTS self-test doctor runs (spec 7.7, 7.12): `npx tsx tools/tts/run.ts --selftest`, whose
// last stdout line is `TTS SELFTEST OK <words> <ms>` or `TTS SELFTEST FAIL: <reason>`.
// It runs in its own process group with a hard deadline: on the timeout the whole group (npx,
// tsx, uv, python) is stopped, so a child that ignores SIGTERM or a grandchild that keeps the
// stdout pipe open cannot hold the doctor report.

import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { REPO_ROOT } from './paths.ts';

export interface TtsSelftest {
  ok: boolean;
  /** The self-test's own line, or what happened instead. */
  line: string;
  /** Plain words for the doctor report. */
  summary: string;
}

/**
 * The first run downloads the voice model and its packages (about 560 MB): 8 minutes, inside
 * the 10 minutes host gives quickcheck (live/host.cjs QUICKCHECK_TIMEOUT_MS).
 */
export const TTS_SELFTEST_TIMEOUT_MS = 8 * 60_000;
/** After SIGTERM to the group on the timeout, SIGKILL follows this much later. */
export const TTS_KILL_GRACE_MS = 5_000;
/** After the self-test exits, its stdout gets this long to drain (a grandchild may still hold the pipe). */
export const TTS_DRAIN_MS = 1_000;

export const TTS_SELFTEST_COMMAND: readonly string[] = ['npx', 'tsx', 'tools/tts/run.ts', '--selftest'];

/** A duration in plain words: minutes from one minute up, else seconds. */
export function durationWords(ms: number): string {
  if (ms >= 60_000) {
    const m = ms / 60_000;
    return Number.isInteger(m) ? `${m} minute${m === 1 ? '' : 's'}` : `${m.toFixed(1)} minutes`;
  }
  const s = ms / 1000;
  return `${Number.isInteger(s) ? s : s.toFixed(1)} s`;
}

/** Reads the self-test's stdout and exit code into a result. An OK line printed before a timeout still counts. */
export function interpretTtsSelftest(stdout: string, code: number | null, timedOut = false, timeoutMs: number = TTS_SELFTEST_TIMEOUT_MS): TtsSelftest {
  const lines = stdout.split('\n').map((l) => l.trim()).filter((l) => l.length > 0);
  const line = [...lines].reverse().find((l) => l.startsWith('TTS SELFTEST')) ?? lines[lines.length - 1] ?? '';
  const okLine = line.startsWith('TTS SELFTEST OK');
  if (okLine && code === 0) return { ok: true, line, summary: line };
  if (okLine && timedOut) return { ok: true, line, summary: `${line} (it did not exit and was stopped after ${durationWords(timeoutMs)})` };
  if (/uv not found/i.test(line)) {
    return { ok: false, line, summary: 'uv is not installed, so the narrator voice cannot run. Install it with brew install uv (spec 5.1), then run npm run tts -- --selftest' };
  }
  if (timedOut && !line.startsWith('TTS SELFTEST')) {
    return { ok: false, line, summary: `TTS self-test did not finish in ${durationWords(timeoutMs)}; run npm run tts -- --selftest by hand` };
  }
  if (line === '') return { ok: false, line, summary: `TTS self-test printed nothing (exit code ${String(code)})` };
  return { ok: false, line, summary: line };
}

export type TtsRunner = () => Promise<TtsSelftest>;

export interface TtsSelftestOptions {
  repoRoot?: string;
  timeoutMs?: number;
  killGraceMs?: number;
  drainMs?: number;
  /** Command and arguments; default TTS_SELFTEST_COMMAND (tests pass a stand-in). */
  command?: readonly string[];
  /** The child's stderr: 'inherit' (default) shows uv's download progress in the terminal. */
  stderr?: 'inherit' | 'ignore';
  env?: NodeJS.ProcessEnv;
}

/**
 * Spawns the self-test from the repository root and keeps its one-line result. Resolves at the
 * latest timeoutMs + killGraceMs after the start, whatever the children do.
 */
export function runTtsSelftest(opts: TtsSelftestOptions = {}): Promise<TtsSelftest> {
  const repoRoot = opts.repoRoot ?? REPO_ROOT;
  const timeoutMs = opts.timeoutMs ?? TTS_SELFTEST_TIMEOUT_MS;
  const graceMs = opts.killGraceMs ?? TTS_KILL_GRACE_MS;
  const drainMs = opts.drainMs ?? TTS_DRAIN_MS;
  const command = opts.command ?? TTS_SELFTEST_COMMAND;
  if (opts.command === undefined && !fs.existsSync(path.join(repoRoot, 'tools', 'tts', 'run.ts'))) {
    return Promise.resolve({ ok: false, line: '', summary: 'TTS self-test not available: tools/tts/run.ts is missing' });
  }
  const [cmd, ...args] = command;
  if (cmd === undefined) return Promise.resolve({ ok: false, line: '', summary: 'TTS self-test has no command' });
  // Its own process group (POSIX): one kill reaches npx, tsx, uv and python.
  const ownGroup = process.platform !== 'win32';

  return new Promise((resolve) => {
    let stdout = '';
    let code: number | null = null;
    let timedOut = false;
    let settled = false;
    const timers: NodeJS.Timeout[] = [];
    let child: ChildProcess | null = null;

    const signalGroup = (signal: NodeJS.Signals): void => {
      const pid = child?.pid;
      if (pid === undefined) return;
      try {
        process.kill(ownGroup ? -pid : pid, signal);
      } catch {
        // the group is gone already
      }
    };
    // The group outlives this process unless stopped: stop it when this process exits or is interrupted.
    const onParentExit = (): void => signalGroup('SIGKILL');
    const onParentSignal = (signal: NodeJS.Signals): void => {
      signalGroup('SIGKILL');
      unhook();
      process.kill(process.pid, signal);
    };
    const unhook = (): void => {
      process.off('exit', onParentExit);
      process.off('SIGINT', onParentSignal);
      process.off('SIGTERM', onParentSignal);
    };
    const finish = (result: TtsSelftest): void => {
      if (settled) return;
      settled = true;
      for (const t of timers) clearTimeout(t);
      unhook();
      child?.stdout?.destroy();
      child?.unref();
      resolve(result);
    };
    const verdict = (): TtsSelftest => interpretTtsSelftest(stdout, code, timedOut, timeoutMs);

    try {
      child = spawn(cmd, args, {
        cwd: repoRoot,
        stdio: ['ignore', 'pipe', opts.stderr ?? 'inherit'],
        env: opts.env ?? process.env,
        detached: ownGroup,
      });
    } catch (e) {
      finish({ ok: false, line: '', summary: `TTS self-test could not start: ${(e as Error).message}` });
      return;
    }
    process.on('exit', onParentExit);
    process.on('SIGINT', onParentSignal);
    process.on('SIGTERM', onParentSignal);

    timers.push(
      setTimeout(() => {
        timedOut = true;
        signalGroup('SIGTERM');
        timers.push(
          setTimeout(() => {
            signalGroup('SIGKILL');
            finish(verdict());
          }, graceMs),
        );
      }, timeoutMs),
    );
    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (d: string) => {
      stdout += d;
    });
    child.on('error', (e) => {
      finish({ ok: false, line: '', summary: `TTS self-test could not start: ${e.message}` });
    });
    child.on('exit', (c) => {
      code = c;
      // A grandchild may keep stdout open: wait briefly for the rest of the output, then stop the group.
      timers.push(
        setTimeout(() => {
          signalGroup('SIGKILL');
          finish(verdict());
        }, drainMs),
      );
    });
    child.on('close', (c) => {
      if (code === null) code = c;
      finish(verdict());
    });
  });
}
