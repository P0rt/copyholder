// Request rules of the label page server, the same as host's (live/lib/guard.cjs, spec 6.1, 7.2):
// Host must be 127.0.0.1:<port>, an Origin header must be the page, and every request carries the
// run's random token as ?token= or as the cookie. The cookie has its own name, so it never
// overwrites host's cookie on 127.0.0.1.

import { randomBytes, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage } from 'node:http';

export const LABEL_TOKEN_COOKIE = 'ch_label_token';

/** Random 32-byte hex token, one per run. */
export function newToken(): string {
  return randomBytes(32).toString('hex');
}

export function sameToken(a: unknown, b: unknown): boolean {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const x = Buffer.from(a, 'utf8');
  const y = Buffer.from(b, 'utf8');
  return x.length === y.length && x.length > 0 && timingSafeEqual(x, y);
}

export function parseCookies(header: string | undefined): Map<string, string> {
  const out = new Map<string, string>();
  if (typeof header !== 'string') return out;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    out.set(part.slice(0, i).trim(), part.slice(i + 1).trim());
  }
  return out;
}

export function pageOrigin(port: number): string {
  return `http://127.0.0.1:${port}`;
}

/** Set-Cookie value for the token: HttpOnly, SameSite=Strict, whole site. */
export function cookieHeader(token: string): string {
  return `${LABEL_TOKEN_COOKIE}=${token}; HttpOnly; SameSite=Strict; Path=/`;
}

export interface GuardResult {
  ok: boolean;
  status: 200 | 400 | 403;
  url: URL | null;
  /** The token came in the query (the first page load): set the cookie. */
  tokenInQuery: boolean;
}

/** The HTTP rule of live/lib/guard.cjs checkHttp. */
export function checkRequest(req: Pick<IncomingMessage, 'url' | 'headers'>, opts: { token: string; port: number }): GuardResult {
  let url: URL;
  try {
    url = new URL(req.url || '/', pageOrigin(opts.port));
  } catch {
    return { ok: false, status: 400, url: null, tokenInQuery: false };
  }
  const fail = { ok: false, status: 403, url, tokenInQuery: false } as const;
  if (req.headers.host !== `127.0.0.1:${opts.port}`) return fail;
  const origin = req.headers.origin;
  if (origin !== undefined && origin !== pageOrigin(opts.port)) return fail;
  const q = url.searchParams.get('token');
  const given = q ? q : (parseCookies(req.headers.cookie).get(LABEL_TOKEN_COOKIE) ?? null);
  if (!sameToken(given, opts.token)) return fail;
  return { ok: true, status: 200, url, tokenInQuery: Boolean(q) };
}
