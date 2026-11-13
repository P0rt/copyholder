'use strict';
// Token, cookie, Host and Origin rules for HTTP and both sockets (spec 6.1, 7.2; docs/protocol.md).
const crypto = require('node:crypto');

const TOKEN_COOKIE = 'ch_token';

/** Random 32-byte hex token, one per run. */
function newToken() {
  return crypto.randomBytes(32).toString('hex');
}

function sameToken(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const x = Buffer.from(a, 'utf8');
  const y = Buffer.from(b, 'utf8');
  return x.length === y.length && x.length > 0 && crypto.timingSafeEqual(x, y);
}

function parseCookies(header) {
  const out = new Map();
  if (typeof header !== 'string') return out;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    out.set(part.slice(0, i).trim(), part.slice(i + 1).trim());
  }
  return out;
}

/** The token a request carries: `?token=` first, then the cookie. */
function requestToken(req, url) {
  const q = url.searchParams.get('token');
  if (q) return q;
  return parseCookies(req.headers.cookie).get(TOKEN_COOKIE) ?? null;
}

function pageOrigin(port) {
  return `http://127.0.0.1:${port}`;
}

function hostHeaderOk(req, port) {
  return req.headers.host === `127.0.0.1:${port}`;
}

function cookieHeader(token) {
  return `${TOKEN_COOKIE}=${token}; HttpOnly; SameSite=Strict; Path=/`;
}

/**
 * HTTP rule: Host must be 127.0.0.1:<port>; an Origin header, when present, must be the page;
 * the token must come as `?token=` or as the cookie. Returns {ok, status, url}.
 */
function checkHttp(req, { token, port }) {
  let url;
  try {
    url = new URL(req.url || '/', pageOrigin(port));
  } catch {
    return { ok: false, status: 400, url: null };
  }
  if (!hostHeaderOk(req, port)) return { ok: false, status: 403, url };
  const origin = req.headers.origin;
  if (origin !== undefined && origin !== pageOrigin(port)) return { ok: false, status: 403, url };
  if (!sameToken(requestToken(req, url), token)) return { ok: false, status: 403, url };
  return { ok: true, status: 200, url };
}

/**
 * WebSocket rule: path, Host of the listening server, exact Origin of the page, token.
 * `origin` is the page origin; `port` is the port of the server that got the upgrade.
 */
function checkUpgrade(req, { path, token, origin, port }) {
  let url;
  try {
    url = new URL(req.url || '/', `http://127.0.0.1:${port}`);
  } catch {
    return { ok: false, status: 400 };
  }
  if (url.pathname !== path) return { ok: false, status: 404 };
  if (!hostHeaderOk(req, port)) return { ok: false, status: 403 };
  if (req.headers.origin !== origin) return { ok: false, status: 403 };
  if (!sameToken(requestToken(req, url), token)) return { ok: false, status: 403 };
  return { ok: true, status: 101 };
}

const STATUS_TEXT = { 400: 'Bad Request', 403: 'Forbidden', 404: 'Not Found', 409: 'Conflict' };

function rejectUpgrade(socket, status) {
  const text = STATUS_TEXT[status] || 'Forbidden';
  try {
    socket.write(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
  } catch {
    // socket already gone
  }
  socket.destroy();
}

module.exports = {
  TOKEN_COOKIE, newToken, sameToken, parseCookies, requestToken, pageOrigin,
  cookieHeader, checkHttp, checkUpgrade, rejectUpgrade,
};
