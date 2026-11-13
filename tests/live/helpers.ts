// Helpers for the host tests: a temporary sandbox, a host process with the mock tap,
// and a stand-in worker on /session (docs/protocol.md).
import { spawn, type ChildProcess } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import WebSocket from 'ws';

export const ROOT = join(import.meta.dirname, '..', '..');
export const HOST = join(ROOT, 'live', 'host.cjs');
export const requireCjs = createRequire(import.meta.url);

export interface AudioBlockLib {
  encodeAudioBlock(n0: number, ch0: ArrayLike<number>, ch1: ArrayLike<number>): Buffer;
}
export const audioBlock = requireCjs('../../live/lib/audio-block.cjs') as AudioBlockLib;

export interface Sandbox {
  dir: string;
  sessions: string;
  dist: string;
  gate: string;
  sealed: string;
  sample: string;
  cleanup(): void;
}

/** Temporary folders: sessions, a one-file page build, gate pack A, empty sealed and sample roots. */
export function makeSandbox(): Sandbox {
  const dir = mkdtempSync(join(tmpdir(), 'copyholder-host-'));
  const sb: Sandbox = {
    dir,
    sessions: join(dir, 'sessions'),
    dist: join(dir, 'dist'),
    gate: join(dir, 'gate'),
    sealed: join(dir, 'sealed'),
    sample: join(dir, 'sample'),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
  for (const d of [sb.sessions, sb.dist, join(sb.dist, 'assets'), join(sb.gate, 'pack-A'), sb.sealed, sb.sample]) {
    mkdirSync(d, { recursive: true });
  }
  writeFileSync(join(sb.dist, 'index.html'), '<!doctype html><title>Copyholder</title>\n');
  writeFileSync(join(sb.dist, 'assets', 'app.js'), 'console.log(1);\n');
  writeFileSync(
    join(sb.gate, 'pack-A', 'pack.json'),
    JSON.stringify({ schema: 'gate-pack/1', pack: 'A', files: ['listen.wav', 'listen.timings.json', 'cues.json'] }),
  );
  writeFileSync(join(sb.gate, 'pack-A', 'listen.wav'), Buffer.from('RIFF-listen'));
  writeFileSync(join(sb.gate, 'pack-A', 'listen.timings.json'), '{"words":[]}');
  writeFileSync(join(sb.gate, 'pack-A', 'cues.json'), '[]');
  writeFileSync(join(sb.gate, 'pack-A', 'objections.wav'), Buffer.from('RIFF-not-listed'));
  writeFileSync(join(sb.gate, 'pack-A', 'notes.txt'), 'not on the allow list');
  return sb;
}

export interface HostRun {
  proc: ChildProcess;
  /** host's stdout and stderr together, in arrival order. */
  out: () => string;
  /** host's stdout alone. */
  stdout: () => string;
  /** host's stderr alone. */
  stderr: () => string;
  port: number;
  token: string;
  origin: string;
  exited: Promise<number | null>;
  waitFor(re: RegExp, ms?: number): Promise<RegExpExecArray>;
  config(): Promise<HostConfig>;
  /** GET /?token=T, as the page does when it loads (or reloads). Resolves with the status. */
  loadPage(): Promise<number>;
  kill(signal?: NodeJS.Signals): void;
}

export interface HostConfig {
  mode: string;
  sessionId: string;
  scenario: string;
  tapUrl: string | null;
  sessionUrl: string;
  narrator: string[];
  consentText: string;
  planCommitment: string | null;
  /** COPYHOLDER_MIC_NAME and COPYHOLDER_OUTPUT_NAME; a key is left out when not set. */
  devices?: { input?: string; output?: string };
}

/** Starts live/host.cjs with --no-open in the sandbox and waits for its page address. */
export async function startHost(sb: Sandbox, args: string[], env: Record<string, string> = {}): Promise<HostRun> {
  const proc = spawn(process.execPath, [HOST, ...args, '--no-open'], {
    cwd: ROOT,
    env: {
      ...process.env,
      COPYHOLDER_SESSIONS_DIR: sb.sessions,
      COPYHOLDER_WEB_DIST: sb.dist,
      COPYHOLDER_GATE_DIR: sb.gate,
      COPYHOLDER_SEALED_DIR: sb.sealed,
      COPYHOLDER_SAMPLE_DIR: sb.sample,
      COPYHOLDER_ALLOW_DIRTY: '1',
      COPYHOLDER_QUICKCHECK_SCRIPT: 'off',
      // A port the system picks (no clash between parallel tests), and no device names from a settings.env.
      COPYHOLDER_PORT: '0',
      COPYHOLDER_MIC_NAME: '',
      COPYHOLDER_OUTPUT_NAME: '',
      ...env,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let text = '';
  let stdoutText = '';
  let stderrText = '';
  const listeners = new Set<() => void>();
  const onData = (d: Buffer) => {
    text += d.toString('utf8');
    for (const l of listeners) l();
  };
  proc.stdout?.on('data', (d: Buffer) => {
    stdoutText += d.toString('utf8');
    onData(d);
  });
  proc.stderr?.on('data', (d: Buffer) => {
    stderrText += d.toString('utf8');
    onData(d);
  });
  const exited = new Promise<number | null>((resolve) => proc.on('exit', (code) => resolve(code)));
  const waitFor = (re: RegExp, ms = 10_000) =>
    new Promise<RegExpExecArray>((resolve, reject) => {
      const check = () => {
        const m = re.exec(text);
        if (m) {
          listeners.delete(check);
          clearTimeout(timer);
          resolve(m);
        }
      };
      const timer = setTimeout(() => {
        listeners.delete(check);
        reject(new Error(`host output did not match ${re} within ${ms} ms:\n${text}`));
      }, ms);
      listeners.add(check);
      check();
    });
  const m = await waitFor(/http:\/\/127\.0\.0\.1:(\d+)\/\?token=([0-9a-f]{64})/);
  const port = Number(m[1]);
  const token = m[2] ?? '';
  const origin = `http://127.0.0.1:${port}`;
  return {
    proc,
    out: () => text,
    stdout: () => stdoutText,
    stderr: () => stderrText,
    port,
    token,
    origin,
    exited,
    waitFor,
    config: async () => (await (await fetch(`${origin}/api/config?token=${token}`)).json()) as HostConfig,
    loadPage: async () => {
      const res = await fetch(`${origin}/?token=${token}`);
      await res.arrayBuffer();
      return res.status;
    },
    kill: (signal = 'SIGKILL') => {
      if (proc.exitCode === null && proc.signalCode === null) proc.kill(signal);
    },
  };
}

/** HTTP status of a WebSocket upgrade: 101 when it opens, else the refusal status. */
export function upgradeStatus(url: string, headers: Record<string, string>): Promise<number> {
  return new Promise((resolve) => {
    const ws = new WebSocket(url, { headers });
    ws.on('open', () => {
      ws.close();
      resolve(101);
    });
    ws.on('unexpected-response', (_req, res) => {
      resolve(res.statusCode ?? 0);
      res.resume();
    });
    ws.on('error', () => resolve(0));
  });
}

export interface WorkerMsg {
  t: string;
  [k: string]: unknown;
}

/** A stand-in for web/worker.ts on /session. */
export class FakeWorker {
  readonly messages: WorkerMsg[] = [];
  /** performance.now() when each of `messages` arrived. */
  readonly arrivals: number[] = [];
  /** Resolves with the close code when the socket closes. */
  readonly closed: Promise<number>;
  private waiters = new Set<() => void>();

  private constructor(readonly ws: WebSocket) {
    this.closed = new Promise((resolve) => ws.once('close', (code) => resolve(code)));
    ws.on('message', (data, isBinary) => {
      if (isBinary) return;
      this.messages.push(JSON.parse(data.toString()) as WorkerMsg);
      this.arrivals.push(performance.now());
      for (const w of this.waiters) w();
    });
  }

  static open(url: string, origin: string): Promise<FakeWorker> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url, { headers: { Origin: origin } });
      ws.once('open', () => resolve(new FakeWorker(ws)));
      ws.once('error', reject);
    });
  }

  send(msg: object): void {
    this.ws.send(JSON.stringify(msg));
  }

  hello(): void {
    this.send({
      t: 'hello',
      ua: 'vitest',
      settings: {
        sampleRate: 48000, channelCount: 1, echoCancellation: false, noiseSuppression: false,
        autoGainControl: false, label: 'Test headset microphone', outputDevice: 'Test headset',
      },
    });
  }

  /** One CHK1 block of `frames` frames: ch0 = 0.25, ch1 = -0.5. */
  block(n0: number, frames = 9600): void {
    this.ws.send(audioBlock.encodeAudioBlock(n0, new Float32Array(frames).fill(0.25), new Float32Array(frames).fill(-0.5)));
  }

  waitMessage(pred: (m: WorkerMsg) => boolean, ms = 10_000): Promise<WorkerMsg> {
    return new Promise((resolve, reject) => {
      const check = () => {
        const m = this.messages.find(pred);
        if (m) {
          this.waiters.delete(check);
          clearTimeout(timer);
          resolve(m);
        }
      };
      const timer = setTimeout(() => {
        this.waiters.delete(check);
        reject(new Error(`no matching message within ${ms} ms: ${JSON.stringify(this.messages)}`));
      }, ms);
      this.waiters.add(check);
      check();
    });
  }

  close(): Promise<void> {
    return new Promise((resolve) => {
      if (this.ws.readyState === WebSocket.CLOSED) return resolve();
      this.ws.once('close', () => resolve());
      this.ws.close();
    });
  }
}

/** A stand-in for the worker's /tap client: every line with its arrival time (performance.now()). */
export class TapClient {
  readonly lines: { at: number; line: Record<string, unknown> }[] = [];

  private constructor(readonly ws: WebSocket) {
    ws.on('message', (d) => this.lines.push({ at: performance.now(), line: JSON.parse(d.toString()) as Record<string, unknown> }));
  }

  static open(url: string, origin: string): Promise<TapClient> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url, { headers: { Origin: origin } });
      ws.once('open', () => resolve(new TapClient(ws)));
      ws.once('error', reject);
    });
  }

  /** Lines of kind `k` (samples.jsonl kinds: m, v, s, f, e, l). */
  of(k: string): { at: number; line: Record<string, unknown> }[] {
    return this.lines.filter((l) => l.line.k === k);
  }

  close(): void {
    this.ws.close();
  }
}

export async function waitUntil(fn: () => boolean, ms = 10_000, stepMs = 50): Promise<void> {
  const end = Date.now() + ms;
  while (!fn()) {
    if (Date.now() > end) throw new Error(`condition not met within ${ms} ms`);
    await new Promise((r) => setTimeout(r, stepMs));
  }
}

export function readJsonl(file: string): Record<string, unknown>[] {
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8')
    .split('\n')
    .filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}

export function readJson(file: string): Record<string, unknown> {
  return JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** A process that has not ended; a zombie (ended, not yet reaped) counts as ended. */
export function processRunning(pid: number): boolean {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    const state = stat.slice(stat.lastIndexOf(')') + 2, stat.lastIndexOf(')') + 3);
    return state !== 'Z' && state !== 'X';
  } catch {
    // no /proc (macOS) or no such process
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
