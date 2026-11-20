// Shared by pack and purge: which records get a published set data/<id>/ under PREREG section 11,
// which folders no SDK measured (pack refuses them, purge holds none back for a set), and small
// helpers for the lines both commands print.

import fs from 'node:fs';
import path from 'node:path';
import { GATE_PACKS, RECORD_KINDS, whyNoPublishedSet, type GatePack, type RecordKind } from '../../core/schemas/index.ts';
import { isDryRun } from '../lib/dry-run.ts';

/** A refusal: the command writes or deletes nothing and exits with code 1. */
export class PackRefusal extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PackRefusal';
  }
}

/** What PREREG section 11 says gets a set; the tail of every "no set" reason. */
export const SET_RULE = 'under PREREG section 11 only gate packs A, B and C and the headstart takes (its demo takes) get one';

/**
 * Why a record gets no published set, or null when it gets one (spec 8.7 as PREREG section 11
 * amends it): gate packs A, B and C, and the headstart takes, which are the demo takes of section
 * 11. Section 11 replaced the numbers sessions, the space-bar block and the sealed demo takes, so
 * those kinds get none now; development records (pack 0, doctor, smoke, pilot, rehearsal,
 * live_from, live_sim) never did.
 */
export function whyNoSet(kind: RecordKind, pack: GatePack | null | undefined): string | null {
  const development = whyNoPublishedSet(kind, pack ?? null);
  if (development !== null) return `${development}; ${SET_RULE}`;
  if (kind === 'gate') {
    if (pack === 'A' || pack === 'B' || pack === 'C') return null;
    return `this gate record names no pack A, B or C in manifest.json, so it is no recording of a full pack; ${SET_RULE}`;
  }
  if (kind === 'headstart') return null;
  return `a ${kind} record gets no set: PREREG section 11 replaced the numbers sessions, the space-bar block and the sealed demo takes; ${SET_RULE}`;
}

/**
 * Why a folder holds no measurement by the SDK, or null when it does (spec 6.5): tap ran its
 * stand-in SDK (dry: true), the mock tap (live/mock-tap.cjs, `--tap mock`) made up the chest trace
 * (tap "mock"), or no SDK ran at all (sdk null). Host writes all three into manifest.json; a
 * manifest without `tap` is read by its sdk field alone. pack refuses such a folder, and purge
 * does not keep it for a set it never gets. The text follows "manifest.json says".
 */
export function whyNotMeasured(m: Readonly<Record<string, unknown>>): string | null {
  if (isDryRun(m)) return 'dry: true (tap ran its stand-in SDK)';
  if (m['tap'] !== undefined && m['tap'] !== 'real') {
    return `tap: ${JSON.stringify(m['tap'])} (${m['tap'] === 'mock' ? 'the mock tap made up the chest trace' : 'not the real tap'})`;
  }
  if (m['sdk'] === null) return 'sdk: null (no SDK ran)';
  return null;
}

/** 1234567 -> "1,234,567". */
export function groupDigits(n: number): string {
  return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

/** "1,234 bytes" (one byte is "1 byte"). */
export function formatBytes(n: number): string {
  return `${groupDigits(n)} ${n === 1 ? 'byte' : 'bytes'}`;
}

/**
 * Kind and gate pack named by the manifest.json of a folder, and whyNotMeasured of it, read
 * leniently (the rest of the file is not checked); null when the file cannot be read or names no
 * known kind.
 */
export function manifestKindOf(dir: string): { kind: RecordKind; pack: GatePack | null; notMeasured: string | null } | null {
  let value: unknown;
  try {
    value = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
  } catch {
    return null;
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const m = value as Record<string, unknown>;
  const kind = m['kind'];
  const pack = m['pack'];
  if (typeof kind !== 'string' || !(RECORD_KINDS as readonly string[]).includes(kind)) return null;
  return {
    kind: kind as RecordKind,
    pack: typeof pack === 'string' && (GATE_PACKS as readonly string[]).includes(pack) ? (pack as GatePack) : null,
    notMeasured: whyNotMeasured(m),
  };
}
