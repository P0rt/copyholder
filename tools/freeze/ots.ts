// OpenTimestamps for the freeze command (spec 8.4, 13.6): `ots stamp <file>` writes <file>.ots.
// The command is `uvx --from opentimestamps-client ots`; COPYHOLDER_OTS_COMMAND replaces it (tests
// use a stand-in; never stamp for real in tests). The value is a JSON array of strings, or words
// split on whitespace.

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';

export const OTS_ENV = 'COPYHOLDER_OTS_COMMAND';
export const DEFAULT_OTS_COMMAND: readonly string[] = ['uvx', '--from', 'opentimestamps-client', 'ots'];

/**
 * Start of every detached proof: the header magic of python-opentimestamps DetachedTimestampFile,
 * major version 1, then the file hash op (0x08 = SHA-256) and the 32-byte digest of the file.
 */
export const OTS_MAGIC = Uint8Array.from([
  0x00, ...Array.from('OpenTimestamps', (c) => c.charCodeAt(0)), 0x00, 0x00, ...Array.from('Proof', (c) => c.charCodeAt(0)), 0x00,
  0xbf, 0x89, 0xe2, 0xe8, 0x84, 0xe8, 0x92, 0x94,
]);
const OTS_MAJOR_VERSION = 0x01;
const OTS_OP_SHA256 = 0x08;

/** The ots command words from the environment, or the default. */
export function otsCommand(env: NodeJS.ProcessEnv): string[] {
  const raw = env[OTS_ENV]?.trim();
  if (!raw) return [...DEFAULT_OTS_COMMAND];
  if (raw.startsWith('[')) {
    const v: unknown = JSON.parse(raw);
    if (!Array.isArray(v) || v.length === 0 || !v.every((w) => typeof w === 'string' && w !== '')) {
      throw new Error(`${OTS_ENV} must be a JSON array of non-empty strings`);
    }
    return v as string[];
  }
  return raw.split(/\s+/);
}

export interface OtsRun {
  ok: boolean;
  /** The command line, for messages. */
  shown: string;
  output: string;
}

/** Runs `<ots> stamp <file>` in `cwd`; `file` is relative to it. Output is passed through to the log. */
export function runOtsStamp(cwd: string, file: string, env: NodeJS.ProcessEnv, timeoutMs = 600_000): OtsRun {
  const [cmd, ...pre] = otsCommand(env);
  const args = [...pre, 'stamp', file];
  const shown = [cmd, ...args].join(' ');
  const r = spawnSync(cmd!, args, { cwd, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: timeoutMs });
  if (r.error) return { ok: false, shown, output: `cannot run ${cmd}: ${r.error.message}` };
  return { ok: r.status === 0, shown, output: `${r.stdout ?? ''}${r.stderr ?? ''}`.trim() };
}

/** Why `proof` is not a detached OpenTimestamps proof of exactly `stamped`, or null when it is. */
export function otsProofProblem(proof: Uint8Array, stamped: Uint8Array): string | null {
  const head = OTS_MAGIC.length;
  if (proof.length < head + 2 + 32 || OTS_MAGIC.some((b, i) => proof[i] !== b)) return 'it is not an OpenTimestamps proof';
  if (proof[head] !== OTS_MAJOR_VERSION) return `it has proof version ${proof[head]}, expected ${OTS_MAJOR_VERSION}`;
  if (proof[head + 1] !== OTS_OP_SHA256) return 'it does not use SHA-256 for the file';
  const digest = createHash('sha256').update(stamped).digest();
  const got = proof.subarray(head + 2, head + 2 + 32);
  return digest.equals(got) ? null : 'it stamps other bytes than the file as it is now';
}
