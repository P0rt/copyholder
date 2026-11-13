'use strict';
// ledger.jsonl, the step log of a session folder (spec 8.5). One line per step:
// {"i":4,"step":"label","utc":"2026-11-14T09:12:40Z","commit":"1a2b3c4","out_sha256":{...},"exploratory":false,"prev":"…"}
// `prev` is the SHA-256 (hex) of the previous line's UTF-8 text without its newline;
// the first line has 64 zeros. `i` counts lines from 0.
const fs = require('node:fs');
const path = require('node:path');
const { sha256Hex } = require('./hash.cjs');

const LEDGER_FILE = 'ledger.jsonl';
const ZERO_HASH = '0'.repeat(64);

// Record kinds with a step order in spec 8.5 (core/schemas/common.ts LEDGER_KINDS; tests/live keeps
// them equal). doctor, smoke, headstart, live_from and live_sim records have no ledger.
const LEDGER_KINDS = Object.freeze(['gate', 'numbers', 'spacebar', 'rehearsal', 'demo', 'pilot']);

function isLedgerKind(kind) {
  return LEDGER_KINDS.includes(kind);
}

/** UTC time without milliseconds: 2026-11-14T09:12:40Z. */
function utcSeconds(date) {
  return date.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

/** One ledger line in the spec's key order; out_sha256 keys sorted. */
function formatLedgerLine({ i, step, utc, commit, outSha256, exploratory = false, prev }) {
  const out = {};
  for (const k of Object.keys(outSha256).sort()) out[k] = outSha256[k];
  return JSON.stringify({ i, step, utc, commit, out_sha256: out, exploratory, prev });
}

function ledgerLines(text) {
  return text.split('\n').filter((l) => l.length > 0);
}

/** Checks numbering and the hash chain. Returns {ok, lines, error}. */
function verifyLedgerText(text) {
  const lines = ledgerLines(text);
  let prev = ZERO_HASH;
  for (let k = 0; k < lines.length; k++) {
    let row;
    try {
      row = JSON.parse(lines[k]);
    } catch {
      return { ok: false, lines, error: `line ${k + 1} is not JSON` };
    }
    if (row.i !== k) return { ok: false, lines, error: `line ${k + 1} has i=${row.i}` };
    if (row.prev !== prev) return { ok: false, lines, error: `line ${k + 1} breaks the hash chain` };
    prev = sha256Hex(lines[k]);
  }
  return { ok: true, lines, error: null };
}

/**
 * Appends one step to <dir>/ledger.jsonl after checking the chain so far. Returns the line.
 * `date` is passed in by the caller (spec: the time of the step).
 */
function appendLedgerStep(dir, { step, commit, outSha256, exploratory = false, date }) {
  const file = path.join(dir, LEDGER_FILE);
  const text = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  const check = verifyLedgerText(text);
  if (!check.ok) throw new Error(`${file}: ${check.error}`);
  const last = check.lines[check.lines.length - 1];
  const line = formatLedgerLine({
    i: check.lines.length,
    step,
    utc: utcSeconds(date),
    commit,
    outSha256,
    exploratory,
    prev: last === undefined ? ZERO_HASH : sha256Hex(last),
  });
  const sep = text.length > 0 && !text.endsWith('\n') ? '\n' : '';
  fs.appendFileSync(file, sep + line + '\n');
  return line;
}

module.exports = {
  LEDGER_FILE, ZERO_HASH, LEDGER_KINDS, isLedgerKind, utcSeconds, formatLedgerLine, verifyLedgerText, appendLedgerStep,
};
