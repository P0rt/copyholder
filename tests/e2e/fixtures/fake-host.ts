// Stand-in for live/host.cjs and tap in Playwright tests: one WebSocket server on 127.0.0.1 that
// serves /tap (sends samples.jsonl lines) and /session (collects what the worker or the harness sends).

import type { AddressInfo } from 'node:net';
import { WebSocketServer, type WebSocket } from 'ws';
import { decodeChunkFrame, type ChunkFrame } from '../../../web/lib/chk1.ts';

export interface SessionLog {
  hello: Record<string, unknown> | null;
  /** Text frames in arrival order. */
  frames: Array<Record<string, unknown>>;
  stamps: Array<Record<string, unknown>>;
  det: Array<Record<string, unknown>>;
  events: Array<Record<string, unknown>>;
  chunks: ChunkFrame[];
  ends: Array<Record<string, unknown>>;
  firstFrameKind: 'text' | 'binary' | null;
}

export class FakeHost {
  readonly token = 'e2e-token';
  readonly log: SessionLog = {
    hello: null, frames: [], stamps: [], det: [], events: [], chunks: [], ends: [], firstFrameKind: null,
  };
  /** Every line sent on /tap, by seq. */
  readonly tapSent = new Map<number, Record<string, unknown>>();
  onTapConnect: ((host: FakeHost) => void) | null = null;
  onSessionFrame: ((frame: Record<string, unknown>) => void) | null = null;
  /** Sent on /session connect, as host does with its tap status (docs/protocol.md). */
  tapStatusOnConnect: 'starting' | 'running' | 'stopped' | null = 'running';
  /** host's last line after {t:'end'}; null sends nothing. */
  quickcheckOnEnd: { ok: boolean | null; text: string | null } | null = { ok: null, text: null };
  private wss: WebSocketServer | null = null;
  private tap: WebSocket | null = null;
  private session: WebSocket | null = null;
  private rejected = 0;

  async start(): Promise<void> {
    const wss = new WebSocketServer({ host: '127.0.0.1', port: 0 });
    this.wss = wss;
    await new Promise<void>((resolve) => wss.once('listening', () => resolve()));
    wss.on('connection', (ws, req) => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      if (url.searchParams.get('token') !== this.token) {
        this.rejected++;
        ws.close(4401, 'token');
        return;
      }
      if (url.pathname === '/tap') {
        this.tap = ws;
        this.onTapConnect?.(this);
      } else if (url.pathname === '/session') {
        this.session = ws;
        ws.on('message', (data, isBinary) => this.onSession(data as Buffer, isBinary));
        if (this.tapStatusOnConnect) this.sendSession({ t: 'tap', status: this.tapStatusOnConnect });
      } else {
        ws.close(4404, 'path');
      }
    });
  }

  get port(): number {
    return (this.wss?.address() as AddressInfo).port;
  }

  tapUrl(): string {
    return `ws://127.0.0.1:${this.port}/tap?token=${this.token}`;
  }

  sessionUrl(): string {
    return `ws://127.0.0.1:${this.port}/session?token=${this.token}`;
  }

  get tapConnected(): boolean {
    return this.tap !== null && this.tap.readyState === 1;
  }

  sendTap(line: Record<string, unknown>): void {
    if (typeof line.seq === 'number') this.tapSent.set(line.seq, line);
    this.tap?.send(JSON.stringify(line));
  }

  sendSession(frame: Record<string, unknown>): void {
    this.session?.send(JSON.stringify(frame));
  }

  private onSession(data: Buffer, isBinary: boolean): void {
    if (this.log.firstFrameKind === null) this.log.firstFrameKind = isBinary ? 'binary' : 'text';
    if (isBinary) {
      this.log.chunks.push(decodeChunkFrame(new Uint8Array(data.buffer, data.byteOffset, data.byteLength)));
      return;
    }
    const frame = JSON.parse(data.toString('utf8')) as Record<string, unknown>;
    this.log.frames.push(frame);
    switch (frame.t) {
      case 'hello':
        this.log.hello = frame;
        break;
      case 'stamp':
        this.log.stamps.push(frame.line as Record<string, unknown>);
        break;
      case 'det':
        this.log.det.push(frame.line as Record<string, unknown>);
        break;
      case 'event':
        this.log.events.push(frame.line as Record<string, unknown>);
        break;
      case 'end':
        this.log.ends.push(frame);
        if (this.quickcheckOnEnd) this.sendSession({ t: 'quickcheck', ...this.quickcheckOnEnd });
        break;
      default:
        break;
    }
    this.onSessionFrame?.(frame);
  }

  /** Both channels of the recording, joined; throws when a block does not follow the previous one. */
  recording(): { ch0: Float32Array; ch1: Float32Array } {
    const total = this.log.chunks.reduce((a, c) => a + c.frames, 0);
    const ch0 = new Float32Array(total);
    const ch1 = new Float32Array(total);
    let n = 0;
    for (const c of this.log.chunks) {
      if (c.n0 !== n) throw new Error(`audio gap: block n0 ${c.n0}, expected ${n}`);
      ch0.set(c.ch0, n);
      ch1.set(c.ch1, n);
      n += c.frames;
    }
    return { ch0, ch1 };
  }

  get rejectedConnections(): number {
    return this.rejected;
  }

  async close(): Promise<void> {
    for (const c of this.wss?.clients ?? []) c.terminate();
    await new Promise<void>((resolve) => (this.wss ? this.wss.close(() => resolve()) : resolve()));
  }
}
