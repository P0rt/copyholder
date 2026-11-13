// Test-only stand-ins for WebSocket and MessagePort, and a WorkerCore wired to them.

import type { WorkerConfig, WorkerToMain } from '../messages.ts';
import { WorkerCore, type PortLike, type SocketLike } from '../worker-core.ts';

export class FakeSocket implements SocketLike {
  binaryType = 'blob';
  readyState = 0;
  readonly sent: Array<string | ArrayBuffer> = [];
  onopen: ((ev: unknown) => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onclose: ((ev: unknown) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;

  constructor(readonly url: string) {}

  send(data: string | ArrayBuffer): void {
    if (this.readyState !== 1) throw new Error('send before open');
    this.sent.push(data);
  }

  close(): void {
    this.readyState = 3;
    this.onclose?.({});
  }

  open(): void {
    this.readyState = 1;
    this.onopen?.({});
  }

  receive(data: unknown): void {
    this.onmessage?.({ data: typeof data === 'string' ? data : JSON.stringify(data) });
  }

  /** Text frames, parsed. */
  json(): Array<Record<string, unknown>> {
    return this.sent.filter((f): f is string => typeof f === 'string').map((f) => JSON.parse(f) as Record<string, unknown>);
  }

  /** `line` of every text frame of type t, in order. */
  lines(t: string): Array<Record<string, unknown>> {
    return this.json().filter((f) => f.t === t).map((f) => f.line as Record<string, unknown>);
  }

  /** Raw text of every `line` of type t (exact digits and key order). */
  lineTexts(t: string): string[] {
    const head = `{"t":"${t}","line":`;
    return this.sent.filter((f): f is string => typeof f === 'string' && f.startsWith(head)).map((f) => f.slice(head.length, -1));
  }

  binary(): ArrayBuffer[] {
    return this.sent.filter((f): f is ArrayBuffer => f instanceof ArrayBuffer);
  }
}

export class FakePort implements PortLike {
  readonly posted: unknown[] = [];
  onmessage: ((ev: { data: unknown }) => void) | null = null;

  postMessage(msg: unknown): void {
    this.posted.push(msg);
  }

  /** A message from the other end. */
  deliver(data: unknown): void {
    this.onmessage?.({ data });
  }
}

export interface WiredWorker {
  worker: WorkerCore;
  session: FakeSocket;
  tap: FakeSocket | undefined;
  port: FakePort;
  toMain: WorkerToMain[];
  /** Callbacks the worker scheduled with env.later, run by the test. */
  timers: Array<{ ms: number; fn: () => void }>;
  /** A Deck message on the direct port. */
  deck(msg: unknown): void;
}

export const TAP_URL = 'ws://127.0.0.1:1/tap?token=a';
export const SESSION_URL = 'ws://127.0.0.1:2/session?token=b';

/** init, hello and consent as the page sends them; both sockets open unless `open` is false. */
export function wiredWorker(config: WorkerConfig, opts: { open?: boolean; consent?: boolean } = {}): WiredWorker {
  const sockets: FakeSocket[] = [];
  const toMain: WorkerToMain[] = [];
  const timers: Array<{ ms: number; fn: () => void }> = [];
  const worker = new WorkerCore({
    postToMain: (m) => toMain.push(m),
    openSocket: (url) => {
      const s = new FakeSocket(url);
      sockets.push(s);
      return s;
    },
    later: (ms, fn) => timers.push({ ms, fn }),
  });
  const port = new FakePort();
  worker.onMainMessage({ k: 'init', config: { sessionUrl: SESSION_URL, ...config }, port: port as unknown as MessagePort });
  worker.onMainMessage({ k: 'hello', ua: 'test-agent', settings: { sampleRate: 48_000 } });
  if (opts.consent !== false) worker.onMainMessage({ k: 'consent', at: '2026-11-12T10:00:00.000Z' });
  const session = sockets.find((s) => s.url === (config.sessionUrl ?? SESSION_URL)) as FakeSocket;
  const tap = sockets.find((s) => s !== session);
  if (opts.open !== false) {
    session?.open();
    tap?.open();
  }
  return { worker, session, tap, port, toMain, timers, deck: (msg) => port.deliver(msg) };
}
