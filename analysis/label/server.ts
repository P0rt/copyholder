// The blind label page server (spec 7.6): plain HTTP on 127.0.0.1 at a port the OS picks, one random
// token per run (the rules of live/lib/guard.cjs), the page files of analysis/label/page/ served as
// they are, the channel 0 window of one item at a time, and the marks posted back. It knows the
// item ids, the page only sees positions in the random order. A save that fails for a reason the
// person can fix (a full disk) leaves the marks on the page to save again.

import fs from 'node:fs';
import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkRequest, cookieHeader, newToken } from './guard.ts';
import { markFromPage, pageMarkOf, windowSamples, type LabelItem, type LabelMark } from './marks.ts';

export const PAGE_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'page');

/** Files the page may load, with their types. Nothing else is served from disk. */
const STATIC_FILES: Readonly<Record<string, { file: string; type: string }>> = {
  '/': { file: 'index.html', type: 'text/html; charset=utf-8' },
  '/label.js': { file: 'label.js', type: 'text/javascript; charset=utf-8' },
  '/label.css': { file: 'label.css', type: 'text/css; charset=utf-8' },
};

/** Headers of every answer (live/host.cjs BASE_HEADERS) and the page's content policy. */
const BASE_HEADERS: Readonly<Record<string, string>> = {
  'Cache-Control': 'no-store',
  'Referrer-Policy': 'no-referrer',
  'X-Content-Type-Options': 'nosniff',
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
  'Cross-Origin-Resource-Policy': 'same-origin',
};
const PAGE_CSP =
  "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

/** Largest JSON body the page sends. */
const MAX_BODY_BYTES = 4096;

export interface LabelServerOptions {
  /** Items in the random display order. */
  items: readonly LabelItem[];
  /** Channel 0 over [anchor - 1 s, anchor + 11 s) of an item, zeros where nothing was recorded. */
  audio: (item: LabelItem) => Float32Array;
  sampleRateHz: number;
  exploratory?: boolean;
  /**
   * Called with every mark in display order when the page says it is done. What it returns is
   * shown on the page. When it throws, the page shows the error; a retryable error keeps the
   * marks open for another save, any other ends the run and `finished` rejects.
   */
  onFinish: (marks: LabelMark[]) => Promise<string> | string;
  /** Whether a failed onFinish may be tried again from the page (default: always). */
  retryable?: (e: Error) => boolean;
  /** Told about every failed onFinish (the command prints it). */
  onFinishError?: (e: Error, retryable: boolean) => void;
  /** Fixed token (tests); default a new random one. */
  token?: string;
  pageDir?: string;
}

export interface LabelServer {
  /** The page address with the token: open it in Chrome. */
  url: string;
  port: number;
  token: string;
  /** Resolves with the marks after onFinish succeeded; rejects when it threw an error that is not retryable. */
  finished: Promise<LabelMark[]>;
  close: () => Promise<void>;
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { ...BASE_HEADERS, 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const type = String(req.headers['content-type'] ?? '').split(';')[0]!.trim().toLowerCase();
    if (type !== 'application/json') {
      reject(new HttpError(415, 'expected application/json'));
      req.resume();
      return;
    }
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY_BYTES) {
        reject(new HttpError(413, 'body too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      try {
        const v = JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
        if (v === null || typeof v !== 'object' || Array.isArray(v)) throw new Error('not an object');
        resolve(v as Record<string, unknown>);
      } catch {
        reject(new HttpError(400, 'body is not a JSON object'));
      }
    });
    req.on('error', reject);
  });
}

/** Starts the server on 127.0.0.1 at a port the OS picks. */
export async function startLabelServer(opts: LabelServerOptions): Promise<LabelServer> {
  const token = opts.token ?? newToken();
  const pageDir = opts.pageDir ?? PAGE_DIR;
  const rate = opts.sampleRateHz;
  const w = windowSamples(rate);
  const items = [...opts.items];
  const marks: Array<LabelMark | null> = items.map(() => null);
  let state: 'open' | 'finishing' | 'saved' | 'failed' = 'open';
  const closedWhy = (): string => (state === 'saved' ? 'the labels are already saved' : 'this label run has ended without saving');
  let port = 0;

  let resolveFinished!: (m: LabelMark[]) => void;
  let rejectFinished!: (e: Error) => void;
  const finished = new Promise<LabelMark[]>((resolve, reject) => {
    resolveFinished = resolve;
    rejectFinished = reject;
  });
  // A caller that only awaits close() must not see an unhandled rejection.
  finished.catch(() => undefined);

  const positionOf = (raw: unknown): number => {
    const pos = typeof raw === 'string' && /^\d+$/.test(raw) ? Number(raw) : raw;
    if (typeof pos !== 'number' || !Number.isInteger(pos) || pos < 0 || pos >= items.length) throw new HttpError(404, 'no such event');
    return pos;
  };

  const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const g = checkRequest(req, { token, port });
    if (!g.ok || g.url === null) {
      res.writeHead(g.status, { ...BASE_HEADERS, 'Content-Type': 'text/plain; charset=utf-8' });
      res.end(g.status === 403 ? 'Forbidden\n' : 'Bad request\n');
      return;
    }
    const route = g.url.pathname;
    if (req.method === 'GET') {
      const file = STATIC_FILES[route];
      if (file) {
        const body = fs.readFileSync(path.join(pageDir, file.file));
        const headers: Record<string, string> = { ...BASE_HEADERS, 'Content-Type': file.type };
        if (route === '/') headers['Content-Security-Policy'] = PAGE_CSP;
        if (g.tokenInQuery) headers['Set-Cookie'] = cookieHeader(token);
        res.writeHead(200, headers);
        res.end(body);
        return;
      }
      if (route === '/favicon.ico') {
        // Chrome asks for it on its own; an empty answer keeps its console clean.
        res.writeHead(204, BASE_HEADERS);
        res.end();
        return;
      }
      if (route === '/api/state') {
        sendJson(res, 200, {
          count: items.length,
          sampleRateHz: rate,
          beforeSamples: w.before,
          afterSamples: w.after,
          exploratory: opts.exploratory === true,
          done: state === 'saved',
          marks: marks.map((m, i) => (m === null ? null : pageMarkOf(items[i]!, m, rate))),
        });
        return;
      }
      const audio = /^\/api\/audio\/(\d+)$/.exec(route);
      if (audio) {
        const item = items[positionOf(audio[1])]!;
        const samples = Float32Array.from(opts.audio(item));
        if (samples.length !== w.length) throw new Error(`window of ${samples.length} samples, expected ${w.length}`);
        res.writeHead(200, { ...BASE_HEADERS, 'Content-Type': 'application/octet-stream' });
        res.end(Buffer.from(samples.buffer, samples.byteOffset, samples.byteLength));
        return;
      }
      throw new HttpError(404, 'not found');
    }
    if (req.method === 'POST') {
      if (route === '/api/mark') {
        const body = await readJsonBody(req);
        if (state === 'finishing') throw new HttpError(409, 'the labels are being saved');
        if (state !== 'open') throw new HttpError(409, closedWhy());
        const pos = positionOf(body['pos']);
        const mark = markFromPage(items[pos]!, body, rate);
        if (typeof mark === 'string') throw new HttpError(400, mark);
        marks[pos] = mark;
        sendJson(res, 200, { ok: true, marked: marks.filter((m) => m !== null).length, count: items.length });
        return;
      }
      if (route === '/api/finish') {
        await readJsonBody(req);
        if (state === 'finishing') throw new HttpError(409, 'the labels are being saved');
        if (state !== 'open') throw new HttpError(409, closedWhy());
        const missing = marks.flatMap((m, i) => (m === null ? [i + 1] : []));
        if (missing.length > 0) throw new HttpError(409, `event(s) ${missing.join(', ')} have no mark yet`);
        state = 'finishing';
        const all = [...(marks as LabelMark[])];
        try {
          const message = await opts.onFinish(all);
          state = 'saved';
          sendJson(res, 200, { ok: true, message });
          resolveFinished(all);
        } catch (e) {
          const err = e instanceof Error ? e : new Error(String(e));
          const retry = opts.retryable ? opts.retryable(err) : true;
          opts.onFinishError?.(err, retry);
          const why = err.message.split('\n')[0];
          if (retry) {
            // The marks stay here and on the page: the person fixes the cause and saves again.
            state = 'open';
            sendJson(res, 500, { ok: false, retry: true, error: `The labels were not saved: ${why}. Your marks are kept: fix the cause and press Save again.` });
          } else {
            state = 'failed';
            sendJson(res, 500, { ok: false, retry: false, error: `The labels were not saved: ${why}` });
            rejectFinished(err);
          }
        }
        return;
      }
      throw new HttpError(404, 'not found');
    }
    res.writeHead(405, { ...BASE_HEADERS, Allow: 'GET, POST' });
    res.end();
  };

  const server = http.createServer((req, res) => {
    handle(req, res).catch((e: unknown) => {
      const status = e instanceof HttpError ? e.status : 500;
      const message = e instanceof Error ? e.message : String(e);
      if (!res.headersSent) sendJson(res, status, { ok: false, error: message });
      else res.end();
    });
  });
  server.on('clientError', (_err, socket) => socket.destroy());
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  port = (server.address() as AddressInfo).port;

  const close = (): Promise<void> =>
    new Promise((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections();
    });
  return { url: `http://127.0.0.1:${port}/?token=${token}`, port, token, finished, close };
}
