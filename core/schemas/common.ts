// Field rules shared by several files of spec section 8.

import { fail, int, num, oneOf, str, describe, type Spec } from './check.ts';

/** Sample number on the 48 kHz clock: a non-negative integer (spec 8.1). */
export const sampleN: Spec = int({ min: 0, what: 'a sample number (non-negative integer)' });

/** SDK timestamp: integer microseconds (spec 8.1). */
export const microsUs: Spec = int({ min: 0, what: 'an SDK timestamp in integer microseconds' });

/** Non-negative integer count. */
export const count: Spec = int({ min: 0, what: 'a count (non-negative integer)' });

/** Report value in ms or dB, rounded to 0.1 (spec 8.1). */
export const report1: Spec = num({ round1: true });

/** A share between 0 and 1. */
export const share: Spec = num({ min: 0, max: 1, what: 'a share between 0 and 1' });

/** tArrNs: process.hrtime.bigint() as a decimal string (spec 8.1). */
export const nsString: Spec = str({ pattern: /^(0|[1-9][0-9]*)$/, what: 'nanoseconds as a decimal string (spec 8.1)' });

export const HEX64 = /^[0-9a-f]{64}$/;

/** Bare SHA-256: 64 lowercase hex characters. */
export const sha256Hex: Spec = str({ pattern: HEX64, what: 'a SHA-256 as 64 lowercase hex characters' });

/** "sha256:" followed by 64 lowercase hex characters (manifest files, Ollama digests). */
export const sha256Prefixed: Spec = str({
  pattern: /^sha256:[0-9a-f]{64}$/,
  what: '"sha256:" and 64 lowercase hex characters',
});

/** Git commit, short or full. */
export const commitSha: Spec = str({ pattern: /^[0-9a-f]{7,40}$/, what: 'a git commit (7 to 40 lowercase hex characters)' });

/**
 * Git commit, or null when the code ran outside a git checkout (host writes null for
 * values it cannot know, e.g. in tests). Assumption: a real record always has one.
 */
export const commitOrNull: Spec = (v, p, out) => {
  if (v !== null) commitSha(v, p, out);
};

/** Relative file name: no leading "/", no ".." segment, no backslash or newline. */
export const RELATIVE_FILE = /^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$))[^\n\\]+$/;

/** UTC time like 2026-11-17T17:02:11Z. */
export const utcTime: Spec = (v, p, out) => {
  const re = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/;
  if (typeof v !== 'string' || !re.test(v) || Number.isNaN(Date.parse(v))) {
    fail(out, p, `expected a UTC time like "2026-11-17T17:02:11Z", got ${describe(v)}`);
  }
};

/** Session folder id: gate-a, s1, demo-2, pilot, r1, k1 (spec 8.1). */
export const SESSION_ID = /^[a-z0-9][a-z0-9_-]{0,63}$/;
export const sessionId: Spec = str({ pattern: SESSION_ID, what: 'a session id like "s1" or "gate-a"' });

/** snake_case word used for names of checks, notes and events. */
export const snakeName: Spec = str({ pattern: /^[a-z][a-z0-9_]*$/, what: 'a snake_case name' });

/** Record kinds that have a step order in ledger.jsonl (spec 8.5). */
export const LEDGER_KINDS = ['gate', 'numbers', 'spacebar', 'rehearsal', 'demo', 'pilot'] as const;
export type LedgerKind = (typeof LEDGER_KINDS)[number];

/**
 * Value of manifest.json `kind`: what the recording was (spec 6.5, 8.1).
 * The six ledger kinds plus development runs without a step order.
 */
export const RECORD_KINDS = [...LEDGER_KINDS, 'doctor', 'smoke', 'headstart', 'live_from', 'live_sim'] as const;
export type RecordKind = (typeof RECORD_KINDS)[number];
export const recordKind: Spec = oneOf(RECORD_KINDS);

export function isLedgerKind(kind: string): kind is LedgerKind {
  return (LEDGER_KINDS as readonly string[]).includes(kind);
}

/**
 * Narrator states in files: the four states of spec 6.4 in lower case (spec 8.1), plus
 * "idle", which Deck writes while no passage plays (before, between and after passages).
 * Assumption: spec 6.4 names only the states of a passage being read.
 */
export const NARRATOR_STATES = ['narrating', 'hold_wait', 'listening', 'resume', 'idle'] as const;
export type NarratorState = (typeof NARRATOR_STATES)[number];

/** Stop causes in files: chest, voice (audio safety) or key (space bar) (spec 6.4, 8.1). */
export const HOLD_CAUSES = ['chest', 'voice', 'key'] as const;
export type HoldCause = (typeof HOLD_CAUSES)[number];

/** Outcome of the L_rt rule of spec 6.3. */
export const LRT_RULES = ['mean', 'both', 'void'] as const;
export type LrtRule = (typeof LRT_RULES)[number];

/** Planted error classes (spec 7.8). */
export const ERROR_CLASSES = ['negation', 'number', 'referent', 'sense', 'connective'] as const;
export type ErrorClass = (typeof ERROR_CLASSES)[number];

/** Day-1 gate packs: A, spares B and C, and the short probe 0 (spec 9.4, 13.3). */
export const GATE_PACKS = ['A', 'B', 'C', '0'] as const;
export type GatePack = (typeof GATE_PACKS)[number];

/** A pair [ts, value]: SDK timestamp in integer microseconds and a finite number. */
export type TimedValue = [number, number];
/** A pair [ts, flag] with flag 0 or 1. */
export type TimedFlag = [number, 0 | 1];
