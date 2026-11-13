'use strict';
// tap's console (spec 7.1, 7.12): host forks tap with piped stdout and stderr and tees every line into the
// terminal and into sessions/<id>/tap.log, where the smoke report reads the camera list, the readiness verdict,
// the probes, the enum checks and the SDK's own kInfo log (questions 1, 2, 4 and 10). Every line is redacted
// first: host never reads .env (spec 13.6), so it cannot look for the key itself, and anything shaped like a
// credential goes, except two shapes smoke needs (redactCredentials). tap.log stays on the Mac: no hash in
// manifest.json, never published (spec 8.7), shared only with the user's yes (spec 12.5).
const fs = require('node:fs');
const path = require('node:path');
const { StringDecoder } = require('node:string_decoder');

const TAP_LOG = 'tap.log';
const REDACTED = '[redacted]';
/** A run of key characters; a [redacted] left inside a path stays part of its run, so a second pass changes nothing. */
const RUN_RE = /(?:\[redacted\]|[A-Za-z0-9_+/=-])+/g;
const CREDENTIAL_CHAR_RE = /[A-Za-z0-9_+/=-]/;
const MIN_CREDENTIAL_CHARS = 24;
/** tap's enum lines (live/reduce.cjs enumLine) list `kName=code` pairs: the codes of the spec 7.1 table. */
const ENUM_PAIR_RE = /^k[A-Z][A-Za-z]*=\d+$/;
/** In a path, a segment this long that switches between letters and digits twice is an id or a key part. */
const MIN_MIXED_SEGMENT_CHARS = 8;
/** A line without a line break is cut after this many characters (a stray binary dump). */
const MAX_LINE_CHARS = 64 * 1024;
/** Lines held before the session folder opens (consent, spec 12.2). */
const MAX_HELD_LINES = 5000;
const MAX_HELD_CHARS = 1024 * 1024;

const hasLetterAndDigit = (s) => /[A-Za-z]/.test(s) && /[0-9]/.test(s);

/** Switches between a letter and a digit, counted within each part between other characters ('ab12c' has 2). */
function letterDigitSwitches(s) {
  let n = 0;
  let last = null;
  for (const ch of s) {
    const kind = ch >= '0' && ch <= '9' ? 'digit' : /[A-Za-z]/.test(ch) ? 'letter' : null;
    if (kind !== null && last !== null && kind !== last) n += 1;
    last = kind;
  }
  return n;
}

/**
 * A URL or file path: two or more '/', no '+' or '=' (base64), and at most a third of its letters upper case
 * (a base64 key has about half). A run that holds an earlier [redacted] was one already.
 */
function isPathRun(run) {
  if ((run.match(/\//g) || []).length < 2) return false;
  if (run.includes(REDACTED)) return true;
  if (/[+=]/.test(run)) return false;
  const letters = run.replace(/[^A-Za-z]/g, '');
  return letters.replace(/[^A-Z]/g, '').length * 3 <= letters.length;
}

/** A path segment that is credential-shaped by itself: 24+ characters, or 8+ that mix letters and digits twice. */
function isCredentialSegment(seg) {
  if (seg === REDACTED || !hasLetterAndDigit(seg)) return false;
  return seg.length >= MIN_CREDENTIAL_CHARS || (seg.length >= MIN_MIXED_SEGMENT_CHARS && letterDigitSwitches(seg) >= 2);
}

/** One run of key characters, redacted or kept (see redactCredentials). */
function redactRun(run) {
  if (run.length < MIN_CREDENTIAL_CHARS || !hasLetterAndDigit(run)) return run;
  if (ENUM_PAIR_RE.test(run)) return run;
  if (isPathRun(run)) return run.split('/').map((seg) => (isCredentialSegment(seg) ? REDACTED : seg)).join('/');
  return REDACTED;
}

/**
 * `text` with every credential-shaped run as [redacted]: 24 or more characters of [A-Za-z0-9_+/=-] that hold a
 * letter and a digit. Two shapes stay readable for the smoke report (spec 7.12 questions 2 and 10): an enum pair
 * `kName=code`, and a URL or file path (isPathRun), which is judged segment by segment, so
 * `https://api.example.com/v2/insights/upload` keeps its words while an id or key segment in it goes.
 */
function redactCredentials(text) {
  return String(text).replace(RUN_RE, redactRun);
}

/** Where to cut a line longer than `max`: after its last character outside a credential run, so no run is split. */
function cutPoint(text, max) {
  for (let k = max; k > 0; k--) {
    if (!CREDENTIAL_CHAR_RE.test(text[k - 1])) return k;
  }
  return max; // one run of `max` characters: redacted whole
}

/**
 * Bytes in, lines out: UTF-8 split across chunks is joined, a trailing \r is dropped, a line longer than
 * maxLineChars is cut (never inside a credential run), and end() gives the last line without a break.
 */
class LineSplitter {
  constructor(onLine, { maxLineChars = MAX_LINE_CHARS } = {}) {
    this.onLine = onLine;
    this.max = Math.max(MIN_CREDENTIAL_CHARS * 2, maxLineChars);
    this.decoder = new StringDecoder('utf8');
    this.buf = '';
  }

  push(chunk) {
    this.buf += typeof chunk === 'string' ? chunk : this.decoder.write(chunk);
    const parts = this.buf.split('\n');
    this.buf = parts.pop() ?? '';
    for (const line of parts) this.emit(line);
    while (this.buf.length > this.max) {
      const cut = cutPoint(this.buf, this.max);
      this.emit(this.buf.slice(0, cut));
      this.buf = this.buf.slice(cut);
    }
  }

  /** The last line without a line break, if any. Safe to call twice. */
  end() {
    this.buf += this.decoder.end();
    const rest = this.buf;
    this.buf = '';
    if (rest !== '') this.emit(rest);
  }

  emit(line) {
    this.onLine(line.endsWith('\r') ? line.slice(0, -1) : line);
  }
}

/**
 * tap.log of one run. Lines before the session folder opens are held in memory (bounded) and written when it
 * opens at consent; a run that never reaches consent writes nothing, so its folder stays empty and is removed.
 * Appends are synchronous: the file is complete when close() returns.
 */
class TapLog {
  constructor({ maxHeldLines = MAX_HELD_LINES, maxHeldChars = MAX_HELD_CHARS } = {}) {
    this.maxHeldLines = maxHeldLines;
    this.maxHeldChars = maxHeldChars;
    this.held = [];
    this.heldChars = 0;
    this.dropped = 0; // lines over the hold limit: shown in the terminal only
    this.fd = null;
    this.file = null;
    this.closed = false;
    this.lines = 0;
    this.error = null;
  }

  get isOpen() {
    return this.fd !== null;
  }

  /** One redacted line of tap's output. */
  line(text) {
    if (this.closed) return;
    if (this.fd !== null) {
      this.write(text);
    } else if (this.held.length < this.maxHeldLines && this.heldChars + text.length <= this.maxHeldChars) {
      this.held.push(text);
      this.heldChars += text.length;
    } else {
      this.dropped += 1;
    }
  }

  /** Creates (or appends to) <dir>/tap.log and writes the held lines. Returns false when it cannot. */
  open(dir) {
    if (this.fd !== null || this.closed) return this.fd !== null;
    this.file = path.join(dir, TAP_LOG);
    try {
      this.fd = fs.openSync(this.file, 'a');
    } catch (err) {
      this.error = err.message;
      this.close();
      return false;
    }
    const held = this.held;
    this.held = [];
    this.heldChars = 0;
    for (const text of held) this.write(text);
    if (this.dropped > 0) this.write(`[${this.dropped} more lines from before consent went to the terminal only]`);
    return this.fd !== null;
  }

  write(text) {
    if (this.fd === null) return;
    try {
      fs.writeSync(this.fd, `${text}\n`);
      this.lines += 1;
    } catch (err) {
      this.error = err.message; // a full disk: the terminal still shows every line
      this.closeFd();
    }
  }

  closeFd() {
    const fd = this.fd;
    this.fd = null;
    if (fd === null) return;
    try {
      fs.closeSync(fd);
    } catch {
      // already closed
    }
  }

  /** Closes the file; lines still held (no consent) are dropped. Safe to call twice. */
  close() {
    this.closed = true;
    this.held = [];
    this.heldChars = 0;
    this.closeFd();
  }
}

/**
 * Tees a forked tap's stdout and stderr: each line, redacted, to the matching terminal stream and to `log`
 * (a TapLog). `ended` resolves when both pipes have ended; flush() emits partial lines now (a pipe that a
 * leftover process keeps open).
 */
function teeTapOutput(child, log, { stdout = process.stdout, stderr = process.stderr } = {}) {
  const splitters = [];
  const ends = [];
  for (const [from, to] of [[child.stdout, stdout], [child.stderr, stderr]]) {
    if (!from) continue;
    const split = new LineSplitter((line) => {
      const text = redactCredentials(line);
      try {
        to.write(`${text}\n`);
      } catch {
        // the terminal is gone; tap.log still gets the line
      }
      log.line(text);
    });
    splitters.push(split);
    from.on('data', (chunk) => split.push(chunk));
    ends.push(new Promise((resolve) => {
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        split.end();
        resolve();
      };
      from.once('end', finish);
      from.once('close', finish);
      from.once('error', finish);
    }));
  }
  return {
    ended: Promise.all(ends).then(() => undefined),
    flush: () => {
      for (const s of splitters) s.end();
    },
  };
}

module.exports = {
  TAP_LOG, REDACTED, MIN_CREDENTIAL_CHARS, MIN_MIXED_SEGMENT_CHARS, MAX_LINE_CHARS, MAX_HELD_LINES, MAX_HELD_CHARS,
  redactCredentials, isPathRun, isCredentialSegment, letterDigitSwitches, cutPoint, LineSplitter, TapLog, teeTapOutput,
};
