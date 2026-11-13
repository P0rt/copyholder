// PREREG.md checks before the tag gate-prereg (spec 8.4, 9.2):
// - the cue list of every gate pack (gate/pack-<X>/cues.json, PREREG.md 7.1) is hashed here and must
//   equal its row in the cue-list hash table of PREREG.md, and the cues.json hash pack.json lists;
// - the voice detector rows "Noise floor" and "Periodicity threshold" are read for the comparison
//   with params/frozen.json (tools/freeze/tags.ts);
// - APP_COMMIT names one commit, written in backticks;
// - no {{NAME}} placeholder is left ("the tag is set only when none is left", PREREG.md).

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { firstNumber, hasPlaceholder, markdownTables, plainCell, sha256sIn, type MdTable } from './md.ts';
import { sha256Hex } from './sha256.ts';

const PLACEHOLDER = /\{\{[A-Za-z0-9_]+\}\}/g;

export interface GatePack {
  /** The pack name: 0, A, B, C (folder gate/pack-<name>). */
  id: string;
  dir: string;
}

/** gate/pack-* folders, sorted by name. */
export function listGatePacks(repoDir: string): GatePack[] {
  const gate = join(repoDir, 'gate');
  if (!existsSync(gate)) return [];
  return readdirSync(gate)
    .filter((n) => /^pack-[A-Za-z0-9]+$/.test(n) && statSync(join(gate, n)).isDirectory())
    .sort()
    .map((n) => ({ id: n.slice('pack-'.length), dir: join(gate, n) }));
}

/** The stored cue list of a pack, relative to the repository root (PREREG.md 7.1, docs/protocol.md). */
export function cueListPath(packId: string): string {
  return `gate/pack-${packId}/cues.json`;
}

// ---- the cue-list hash table ---------------------------------------------------------------

export interface CueHashRow {
  /** Pack id from the first cell (`A`, `pack A`, `pack-A`). */
  pack: string;
  /** 64-hex values of the SHA-256 cell, lowercase, without repeats. */
  hashes: string[];
  /** The SHA-256 cell still holds a {{NAME}} placeholder. */
  placeholder: boolean;
  line: number;
}

/** The pack id a first cell names, or null. */
export function packIdOfCell(cell: string): string | null {
  const m = /^(?:pack[-\s]+)?([A-Za-z0-9]+)$/i.exec(plainCell(cell));
  return m ? m[1]! : null;
}

const SHA_HEADER = /sha-?256/i;

/**
 * Rows of the cue-list hash table: a table whose first header cell is "Pack" and with a SHA-256
 * column. When several tables qualify, only those whose SHA-256 header names the cue list
 * ("cues.json" or "cue") count.
 */
export function cueHashRows(prereg: string): { rows: CueHashRow[]; tables: number } {
  const candidates = markdownTables(prereg).filter((t) => /^pack$/i.test(plainCell(t.header[0] ?? '')) && t.header.some((c) => SHA_HEADER.test(c)));
  const named = candidates.filter((t) => t.header.some((c) => SHA_HEADER.test(c) && /cue/i.test(c)));
  const tables = named.length > 0 ? named : candidates;
  const rows: CueHashRow[] = [];
  for (const t of tables) {
    const col = t.header.findIndex((c) => SHA_HEADER.test(c) && /cue/i.test(c));
    const at = col >= 0 ? col : t.header.findIndex((c) => SHA_HEADER.test(c));
    for (const r of t.rows) {
      const pack = packIdOfCell(r.cells[0] ?? '');
      if (pack === null) continue;
      const cell = r.cells[at] ?? '';
      rows.push({ pack, hashes: [...new Set(sha256sIn(cell))], placeholder: hasPlaceholder(cell), line: r.line });
    }
  }
  return { rows, tables: tables.length };
}

// ---- pack.json as host reads it ------------------------------------------------------------

type PackListing = (packJson: unknown) => Map<string, string | null>;

let hostListing: PackListing | null = null;

/** live/lib/narrator.cjs packListing: the shapes of pack.json host accepts, read the same way. */
function packListing(): PackListing {
  if (hostListing === null) {
    const narrator = createRequire(import.meta.url)('../../live/lib/narrator.cjs') as { packListing?: unknown };
    if (typeof narrator.packListing !== 'function') throw new Error('live/lib/narrator.cjs has no packListing');
    hostListing = narrator.packListing as PackListing;
  }
  return hostListing;
}

export interface PackJsonCue {
  /** gate/pack-<X>/pack.json exists. */
  exists: boolean;
  /** pack.json lists cues.json, so host serves it. */
  listed: boolean;
  /** The SHA-256 pack.json gives for cues.json, lowercase hex, or null. */
  hash: string | null;
  problem: string | null;
}

/** What gate/pack-<X>/pack.json says about cues.json, read with host's own packListing. */
export function packJsonCue(pack: GatePack): PackJsonCue {
  const shown = `gate/pack-${pack.id}/pack.json`;
  const file = join(pack.dir, 'pack.json');
  if (!existsSync(file)) return { exists: false, listed: false, hash: null, problem: null };
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(file, 'utf8'));
  } catch (e) {
    return { exists: true, listed: false, hash: null, problem: `${shown} is not valid JSON: ${(e as Error).message}` };
  }
  try {
    const listing = packListing()(value);
    return { exists: true, listed: listing.has('cues.json'), hash: listing.get('cues.json') ?? null, problem: null };
  } catch (e) {
    return { exists: true, listed: false, hash: null, problem: `${shown} cannot be read the way host reads it (live/lib/narrator.cjs): ${(e as Error).message}` };
  }
}

// ---- cue lists -----------------------------------------------------------------------------

export interface CueListCheck {
  problems: string[];
  notes: string[];
  /** SHA-256 of each pack's cues.json, computed here, by repository path. */
  hashes: { path: string; hash: string }[];
}

function rowProblem(row: CueHashRow, pack: GatePack, rel: string, actual: string): string | null {
  const where = `PREREG.md line ${row.line}`;
  if (row.placeholder) return `${where} still holds the placeholder of pack ${pack.id}; ${rel} has SHA-256 ${actual}`;
  if (row.hashes.length === 0) return `${where} holds no SHA-256 for pack ${pack.id}; ${rel} has SHA-256 ${actual}`;
  if (row.hashes.length > 1) return `${where} holds ${row.hashes.length} SHA-256 values for pack ${pack.id}, expected one: ${actual} (${rel})`;
  if (row.hashes[0] !== actual) return `${where} lists ${row.hashes[0]} for pack ${pack.id}, but ${rel} has SHA-256 ${actual}`;
  return null;
}

/**
 * Spec 9.2: the SHA-256 of every pack's cue list is in PREREG.md before the tag. Each gate/pack-<X>
 * needs its cues.json; its hash is computed here and must equal the pack's row in the cue-list
 * hash table, and the cues.json hash of pack.json when pack.json lists one (host refuses to serve
 * a file that differs from pack.json).
 */
export function checkCueLists(repoDir: string, prereg: string): CueListCheck {
  const problems: string[] = [];
  const notes: string[] = [];
  const hashes: { path: string; hash: string }[] = [];
  const packs = listGatePacks(repoDir);
  if (packs.length === 0) problems.push('no gate pack folder (gate/pack-*) found');
  const { rows, tables } = cueHashRows(prereg);
  if (tables === 0) {
    problems.push('PREREG.md has no cue-list hash table: a table whose first column is "Pack" and with a column "SHA-256 of `cues.json`" (spec 9.2)');
  }
  const same = (a: string, b: string): boolean => a.toUpperCase() === b.toUpperCase();
  for (const pack of packs) {
    const rel = cueListPath(pack.id);
    const file = join(repoDir, rel);
    if (!existsSync(file)) {
      problems.push(`${rel} does not exist: render pack ${pack.id} and write its cue list first (gate/README.md); its SHA-256 goes into PREREG.md`);
      continue;
    }
    const actual = sha256Hex(readFileSync(file));
    hashes.push({ path: rel, hash: actual });
    const mine = rows.filter((r) => same(r.pack, pack.id));
    if (tables > 0) {
      if (mine.length === 0) problems.push(`PREREG.md has no row for pack ${pack.id} in its cue-list hash table; ${rel} has SHA-256 ${actual}`);
      else if (mine.length > 1) problems.push(`PREREG.md has ${mine.length} rows for pack ${pack.id} in its cue-list hash table (lines ${mine.map((r) => r.line).join(', ')}), expected one`);
      else {
        const p = rowProblem(mine[0]!, pack, rel, actual);
        if (p !== null) problems.push(p);
      }
    }
    const pj = packJsonCue(pack);
    if (pj.problem !== null) problems.push(pj.problem);
    else if (!pj.exists) notes.push(`gate/pack-${pack.id}/pack.json does not exist yet: host serves no file of pack ${pack.id} until it does`);
    else if (!pj.listed) notes.push(`gate/pack-${pack.id}/pack.json does not list cues.json: host will not serve the cue list of pack ${pack.id}`);
    else if (pj.hash === null) notes.push(`gate/pack-${pack.id}/pack.json lists cues.json without a SHA-256`);
    else if (pj.hash !== actual) problems.push(`gate/pack-${pack.id}/pack.json lists ${pj.hash} for cues.json, but ${rel} has SHA-256 ${actual}: host would refuse to serve it`);
  }
  for (const r of rows) {
    if (!packs.some((p) => same(p.id, r.pack))) problems.push(`PREREG.md line ${r.line} has a cue-list row for pack ${r.pack}, but gate/pack-${r.pack}/ does not exist`);
  }
  return { problems, notes, hashes };
}

// ---- voice detector rows -------------------------------------------------------------------

export interface PreregVad {
  /** Noise floor in dB, or null while the row holds its placeholder. */
  floorDb: number | null;
  periodicity: number | null;
  problems: string[];
}

const FLOOR_ROW = /^noise floor\b/i;
const PERIODICITY_ROW = /^periodicity threshold\b/i;

function rowsOf(table: MdTable, re: RegExp) {
  return table.rows.filter((r) => re.test(plainCell(r.cells[0] ?? '')));
}

/**
 * The rows "Noise floor" and "Periodicity threshold" of the voice detector table of PREREG.md
 * (the one table that has both): the first number of each value cell.
 */
export function preregVadValues(prereg: string): PreregVad {
  const tables = markdownTables(prereg).filter((t) => rowsOf(t, FLOOR_ROW).length > 0 && rowsOf(t, PERIODICITY_ROW).length > 0);
  if (tables.length !== 1) {
    const why = tables.length === 0 ? 'has no' : `has ${tables.length} tables that look like its`;
    return { floorDb: null, periodicity: null, problems: [`PREREG.md ${why} voice detector table with the rows "Noise floor" and "Periodicity threshold" (spec 8.4)`] };
  }
  const problems: string[] = [];
  const read = (re: RegExp, name: string): number | null => {
    const rows = rowsOf(tables[0]!, re);
    if (rows.length > 1) {
      problems.push(`PREREG.md has ${rows.length} rows "${name}" in its voice detector table (lines ${rows.map((r) => r.line).join(', ')})`);
      return null;
    }
    const cell = rows[0]!.cells[1] ?? '';
    if (hasPlaceholder(cell)) return null;
    const n = firstNumber(cell);
    if (n === null) problems.push(`PREREG.md line ${rows[0]!.line}: the row "${name}" holds no number`);
    return n;
  };
  return { floorDb: read(FLOOR_ROW, 'Noise floor'), periodicity: read(PERIODICITY_ROW, 'Periodicity threshold'), problems };
}

// ---- APP_COMMIT and placeholders ------------------------------------------------------------

/** Commit names in backticks (7 to 40 lowercase hex digits): where APP_COMMIT goes once filled in. */
export function backtickedCommitNames(prereg: string): string[] {
  return [...new Set(Array.from(prereg.matchAll(/`([0-9a-f]{7,40})`/g), (m) => m[1]!))];
}

export interface PlaceholderHit {
  name: string;
  line: number;
}

/**
 * {{NAME}} placeholders left in PREREG.md, outside the section that lists them (a heading with the
 * word "Placeholders"). Line numbers count from 1.
 */
export function placeholdersLeft(prereg: string): PlaceholderHit[] {
  const out: PlaceholderHit[] = [];
  let skipLevel: number | null = null;
  let inFence = false;
  prereg.split('\n').forEach((line, i) => {
    if (/^\s*(```|~~~)/.test(line)) inFence = !inFence;
    const heading = inFence ? null : /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      const level = heading[1]!.length;
      if (skipLevel !== null && level <= skipLevel) skipLevel = null;
      if (skipLevel === null && /\bplaceholders\b/i.test(heading[2]!)) skipLevel = level;
      return;
    }
    if (skipLevel !== null) return;
    for (const m of line.matchAll(PLACEHOLDER)) out.push({ name: m[0], line: i + 1 });
  });
  return out;
}

/** One problem line for the placeholders left, or null. */
export function placeholderProblem(prereg: string): string | null {
  const left = placeholdersLeft(prereg);
  if (left.length === 0) return null;
  const names = [...new Set(left.map((h) => h.name))];
  return `PREREG.md still holds ${names.length} placeholder(s): ${names.map((n) => `${n} (line ${left.find((h) => h.name === n)!.line})`).join(', ')}`;
}
