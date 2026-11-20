// npm run take -- <id> [<id> ...]   the demo-take rule of PREREG.md section 11
//
// "The first take with at least one CHEST stop made while no voice was on and followed by the
// participant's voice within 1.5 s, by Deck's voice edges, is published; if no take qualifies,
// the last one is." Reads stamps.jsonl of each headstart take: Deck's hold stamps (cause chest)
// and its voice edges. A CHEST stop qualifies when Deck's voice was off at the stop (the last
// voice edge at or before the hold is off, or there is none) and a voice-on edge follows after
// the hold and before the end of the hold window, nSilent + 1.5 s, the window Deck itself waits
// for the voice (web/lib/deck-core.ts, spec 6.4). Prints each CHEST stop, each take's verdict
// and, for the takes given in recording order, which one the rule publishes.
// Reads stamps.jsonl and manifest.json only: no audio, no text.
// Exit codes: 0 done, 1 a folder that cannot be read, 2 usage.

import fs from 'node:fs';
import path from 'node:path';
import { parseJsonl, validateManifest, validateStampLine, parseJson, type StampLine } from '../core/schemas/index.ts';
import { SAMPLE_RATE_HZ } from '../core/clock/constants.ts';
import { isMainModule } from './lib/cli.ts';
import { sessionDirOf, shownPath } from './lib/paths.ts';
import { SESSION_FILES } from './lib/session.ts';

export const USAGE = 'usage: npm run take -- <id> [<id> ...]   (headstart takes, in recording order)';

/** The hold window Deck waits for the voice after a stop: 1.5 s after nSilent (spec 6.4). */
export const ANSWER_WINDOW_SAMPLES = 1.5 * SAMPLE_RATE_HZ;

export interface ChestStop {
  /** Sample number of the hold (nCmd) and of the narrator's silence. */
  n: number;
  nSilent: number;
  /** Seconds from the first stamp of the take. */
  atS: number;
  voiceOnAtStop: boolean;
  /** Seconds from the silence to the next voice-on edge inside the window; null when none came. */
  voiceAfterS: number | null;
  qualifies: boolean;
}

export interface TakeCheck {
  chest: ChestStop[];
  voiceStops: number;
  qualifies: boolean;
}

/** The rule on one take's stamps (stamps.jsonl lines, in file order). */
export function checkTake(stamps: readonly StampLine[]): TakeCheck {
  const t0 = stamps.length > 0 ? Math.min(...stamps.map((s) => s.n)) : 0;
  const edges = stamps.filter((s): s is Extract<StampLine, { k: 'voice' }> => s.k === 'voice').sort((a, b) => a.n - b.n);
  const chest: ChestStop[] = [];
  let voiceStops = 0;
  for (const s of stamps) {
    if (s.k !== 'hold') continue;
    if (s.cause !== 'chest') {
      if (s.cause === 'voice') voiceStops++;
      continue;
    }
    const before = edges.filter((e) => e.n <= s.n);
    const voiceOnAtStop = before.length > 0 && before[before.length - 1]!.on;
    const next = edges.find((e) => e.on && e.n > s.n && e.n < s.nSilent + ANSWER_WINDOW_SAMPLES);
    const voiceAfterS = next === undefined ? null : (next.n - s.nSilent) / SAMPLE_RATE_HZ;
    chest.push({ n: s.n, nSilent: s.nSilent, atS: (s.n - t0) / SAMPLE_RATE_HZ, voiceOnAtStop, voiceAfterS, qualifies: !voiceOnAtStop && next !== undefined });
  }
  return { chest, voiceStops, qualifies: chest.some((c) => c.qualifies) };
}

/** m:ss.s */
export function clockText(s: number): string {
  const m = Math.floor(s / 60);
  const rest = s - m * 60;
  return `${m}:${rest.toFixed(1).padStart(4, '0')}`;
}

/** The lines npm run take prints for one take. */
export function takeLines(id: string, c: TakeCheck): string[] {
  const lines = [`take ${id}: ${c.chest.length} CHEST stop(s), ${c.voiceStops} VOICE stop(s)`];
  for (const s of c.chest) {
    const voice = s.voiceAfterS === null ? 'no voice within 1.5 s' : `voice ${s.voiceAfterS.toFixed(2)} s after the silence`;
    lines.push(`  CHEST at ${clockText(s.atS)}: ${s.voiceOnAtStop ? 'voice was on at the stop' : 'no voice at the stop'}; ${voice}: ${s.qualifies ? 'qualifies' : 'does not qualify'}`);
  }
  lines.push(
    c.qualifies
      ? `  QUALIFIES: at least one CHEST stop made while no voice was on and followed by the voice within 1.5 s (PREREG.md section 11)`
      : '  DOES NOT QUALIFY: no CHEST stop made while no voice was on and followed by the voice within 1.5 s (PREREG.md section 11)',
  );
  return lines;
}

/** Which take the rule publishes: the first that qualifies, else the last. */
export function publishedTake(ids: readonly string[], checks: readonly TakeCheck[]): { id: string; why: string } {
  const i = checks.findIndex((c) => c.qualifies);
  if (i >= 0) return { id: ids[i]!, why: `take ${i + 1} of ${ids.length}, the first that qualifies` };
  return { id: ids[ids.length - 1]!, why: `take ${ids.length} of ${ids.length}: no take qualifies, so the last one is published` };
}

function readTake(arg: string, env: NodeJS.ProcessEnv): StampLine[] {
  const dir = sessionDirOf(arg, env);
  const manifestFile = path.join(dir, SESSION_FILES.manifest);
  if (!fs.existsSync(manifestFile)) throw new Error(`${arg}: ${shownPath(dir)} has no ${SESSION_FILES.manifest}`);
  const m = parseJson(fs.readFileSync(manifestFile, 'utf8'), validateManifest, { file: SESSION_FILES.manifest });
  if (m.value === null) throw new Error(`${arg}: ${SESSION_FILES.manifest} is not valid: ${m.errors.join('; ')}`);
  if (m.value.kind !== 'headstart') throw new Error(`${arg} is a ${m.value.kind} record, not a headstart take`);
  const stampsFile = path.join(dir, SESSION_FILES.stamps);
  if (!fs.existsSync(stampsFile)) throw new Error(`${arg}: ${shownPath(dir)} has no ${SESSION_FILES.stamps}`);
  const parsed = parseJsonl(fs.readFileSync(stampsFile, 'utf8'), validateStampLine, { file: SESSION_FILES.stamps, maxErrors: 5 });
  if (parsed.errors.length > 0) throw new Error(`${arg}: ${SESSION_FILES.stamps} has broken lines: ${parsed.errors.join('; ')}`);
  return parsed.rows as unknown as StampLine[];
}

export function main(argv: readonly string[], env: NodeJS.ProcessEnv = process.env, out: (l: string) => void = (l) => process.stdout.write(`${l}\n`), err: (l: string) => void = (l) => process.stderr.write(`${l}\n`)): number {
  const ids = argv.filter((a) => !a.startsWith('-'));
  if (ids.length === 0 || ids.length !== argv.length) {
    err(USAGE);
    return 2;
  }
  const checks: TakeCheck[] = [];
  for (const id of ids) {
    let stamps: StampLine[];
    try {
      stamps = readTake(id, env);
    } catch (e) {
      err(`take refused: ${e instanceof Error ? e.message : String(e)}`);
      return 1;
    }
    const c = checkTake(stamps);
    checks.push(c);
    for (const l of takeLines(id, c)) out(l);
  }
  const p = publishedTake(ids, checks);
  out(`published by the rule: ${p.id} (${p.why})`);
  return 0;
}

if (isMainModule(import.meta.url)) process.exitCode = main(process.argv.slice(2));
