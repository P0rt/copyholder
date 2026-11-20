// npm run pack -- <id> --devices-ok [--alias "<system name>=<published name>"]... [--with-audio <id>] [--blank-home-paths] [--replace]
//
// Builds the published set data/<id>/ from sessions/<id>/ (spec 8.7; COPYHOLDER_SESSIONS_DIR moves
// sessions/, COPYHOLDER_DATA_DIR moves data/). Under PREREG section 11 the records that get a set
// are gate packs A, B and C and the headstart takes (the demo takes of section 11); pack 0, doctor,
// smoke, live_sim, live_from and every other kind are refused with the reason. So is a folder that
// no SDK measured (spec 6.5): a dry run, a run of the mock tap, a run without the SDK
// (pack/rules.ts whyNotMeasured, which purge reads too).
//
// The set holds only the files the session has, built as spec 8.7 says: manifest.json without local
// paths and with the --alias names; stream.jsonl from detector_in.jsonl and the arr stamps of
// stamps.jsonl; copies of events.jsonl (with --blank-home-paths, its paths into a home folder
// replaced), onsets.json, calib.json and clock_report.json; verdict.md and verdict.json (gate
// only, once the verdict is in the ledger); audio_env.json, the level of both channels of
// audio.wav every 10 ms; and audio.wav itself, 16 bit, only with --with-audio. A gate set also
// gets the files npm run replay recomputes its verdict with (analysis/replay/README.md):
// marks.jsonl, the "mark" lines of stamps.jsonl as they are (sample numbers, cue numbers and step
// names, no text; a line that is not as JSON.stringify writes it is refused), and g_resets.json,
// the packets stage B reads as reset frames of G, which pack finds as stage B does, with rivals
// gResetSeqs on detector_in.jsonl and samples.jsonl: so pack reads samples.jsonl of a gate
// recording, and checks it against the ledger like every file it reads. With the verdict, also
// sniff_onsets.json, the sample numbers of the sniff onsets that stage B finds in audio.wav channel
// 0 for row 4, which pack finds as stage B does: it loads the recording as stage B loads it and
// runs clocks/compute.ts recountSniffLag, and writes the file only when replay's recount from the
// set gives the same (sniffOnsetsJson). A headstart take gets none of them: replay scores gate
// sets only. Nothing else: never sdk_raw.jsonl.gz, samples.jsonl, stamps.jsonl, detector_in.jsonl,
// quickcheck.json, ledger.jsonl, timings.json or tap.log. The whole set is checked with
// validatePublishedFolder and scanned for what the manifest keeps private (a path into a home
// folder, as an SDK error message can hold, and the system name of a device that --alias
// replaces) before anything is written, then written into a temporary folder beside data/<id>/
// and renamed. A set that holds either is refused. Only --blank-home-paths rewrites a file: it
// replaces the paths into a home folder in events.jsonl before those checks (blankHomePaths).
// manifest.json then holds the SHA-256 of events.jsonl as published, not that of the session
// copy, which would confirm a guessed path (withPublishedEventsHash).
//
// --devices-ok      the device and machine names printed are fine as they stand in the published
//                   manifest. Without it pack prints them and writes nothing (exit 1).
// --alias "a=b"     replaces the system name a by b in those device and machine names only
//                   (repeatable); a manifest field outside them that still holds a is refused.
// --with-audio <id> also publishes audio.wav; the value repeats the session id as confirmation.
// --blank-home-paths replaces each path into a home folder in the strings of events.jsonl, such
//                   as an SDK or tap error message, by "<home path>", and adds a note naming the
//                   line and field of each, never the path. The hash of events.jsonl in
//                   manifest.json is then that of the file as published, with a note that says so.
//                   Without the option such a path refuses the set; in any other file it always
//                   does, as pack replaces paths in no other file.
// --replace         writes the set again over an existing data/<id>/ (swapped in by renames).
//
// Ledger (spec 8.5): a gate record needs its quickcheck step. When the step order allows `pack`
// now (after verdict, or right after an earlier pack) the step is appended with the SHA-256 of
// every written file, keyed data/<id>/<file>; when that append fails, the set is taken back and
// ledger.jsonl left as it was. A gate recording that never reached its verdict because it does not
// count (quickcheck condition 6 alone, or a technical failure) gets its set without a ledger line,
// and pack says why in one line, with what comes next by PREREG sections 7 and 11. Part B, the
// objection block, is released only once the stage A hash is in the ledger (PREREG section 7.5):
// pack A's set of such a recording ends at the step mark of the block, without onsets.json, and
// marks.jsonl and g_resets.json end there as stream.jsonl does. Packs B and C keep it, as stage A
// tunes nothing there (section 11: the parameters are frozen under the tag gate-retune before
// pack B is recorded). A headstart take has no ledger.
// Exit codes: 0 written, 1 refused (nothing written), 2 usage.

import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { chunkLayout, type EventLine } from '../core/clock/index.ts';
import { parseStream, type DetectorInput } from '../core/detector.ts';
import {
  G_RESETS_SCHEMA,
  SESSION_ID,
  SNIFF_ONSETS_SCHEMA,
  buildStreamJsonl,
  canAppendStep,
  findSteps,
  isNoteLine,
  isPlainObject,
  listDeviceNames,
  parseJson,
  parseJsonl,
  quickcheckLine,
  splitJsonlLines,
  splitTruncatedTail,
  toJsonText,
  toPublishedManifest,
  validateCalib,
  validateClockReport,
  validateDetectorInLine,
  validateEventLine,
  validateManifest,
  validateMarkLine,
  validatePublishedFolder,
  validateQuickcheck,
  validateSampleLine,
  validateStampLine,
  verifyLedger,
  type ClockReport,
  type LedgerLine,
  type Manifest,
  type StampLine,
  type StreamText,
  type Validator,
} from '../core/schemas/index.ts';
import { recountSniffLag, type SniffRecount } from './clocks/compute.ts';
import { GateRefusal, coreLrtOf } from './gate/common.ts';
import { sameJson } from './gate/frozen.ts';
import { creditsUsedUp, nextRecordingAdvice, recordedHash, recordingVoidReasons } from './gate/inputs.ts';
import { signOf } from './gate/stage-a.ts';
import { arrivalsBefore, detectorInPrefixLength, gateLayout } from './gate/view.ts';
import { gitShortCommit } from './lib/git.ts';
import { prepareLedgerStep, sha256Hex, utcSeconds, writeLedgerLine } from './lib/ledger.ts';
import { REPO_ROOT, dataDir, sessionsDir, shownPath } from './lib/paths.ts';
import { SESSION_FILES, SessionLoadError, loadSession, type LoadedSession } from './lib/session.ts';
import { gateSteps } from './lib/steps.ts';
import { readSessionAudio, type SessionAudio } from './pack/audio.ts';
import { PackRefusal, formatBytes, groupDigits, whyNoSet, whyNotMeasured } from './pack/rules.ts';
import { sniffRecountFrom } from './replay/sniffs.ts';
import { gResetSeqs, type SampleLmLike } from './rivals/index.ts';

export const USAGE =
  'usage: npm run pack -- <id> --devices-ok [--alias "<system name>=<published name>"]... [--with-audio <id>] [--blank-home-paths] [--replace]';

/** Files of data/<id>/ in the order pack writes and prints them. */
export const SET_ORDER = [
  'manifest.json', 'stream.jsonl', 'marks.jsonl', 'g_resets.json', 'sniff_onsets.json', 'events.jsonl', 'onsets.json',
  'calib.json', 'clock_report.json', 'verdict.md', 'verdict.json', 'audio_env.json', 'audio.wav',
] as const;

/** Copied byte for byte when the session has them (spec 8.7). */
const COPIED_FILES = ['onsets.json', 'calib.json', 'clock_report.json'] as const;
/** Copied only for a gate record whose verdict is in the ledger (spec 8.7). */
const VERDICT_FILES = ['verdict.md', 'verdict.json'] as const;
/** Recording files of a headstart take, hashed into manifest.json when the recording closed (live/host.cjs saveRecording). */
const RECORDING_FILES = [SESSION_FILES.audio, SESSION_FILES.stamps, SESSION_FILES.detectorIn, SESSION_FILES.events] as const;

/** GitHub warns about files over 50 MiB and refuses them over 100 MiB. */
const GITHUB_WARN_BYTES = 50 * 1024 * 1024;
const GITHUB_LIMIT_BYTES = 100 * 1024 * 1024;

export interface PackArgs {
  id: string;
  devicesOk: boolean;
  /** --alias pairs [system name, published name], in the order given. */
  aliases: [string, string][];
  /** Value of --with-audio: must repeat the session id. */
  withAudio: string | null;
  /** --blank-home-paths: paths into a home folder in events.jsonl are replaced (blankHomePaths). */
  blankHomePaths: boolean;
  replace: boolean;
}

/** Parses the command line; returns a message for a usage error. */
export function parsePackArgs(argv: readonly string[]): PackArgs | string {
  let id: string | null = null;
  let devicesOk = false;
  let blankHomePaths = false;
  let replace = false;
  let withAudio: string | null = null;
  const aliases: [string, string][] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    const eq = a.startsWith('--') ? a.indexOf('=') : -1;
    const flag = eq > 0 ? a.slice(0, eq) : a;
    const inline = eq > 0 ? a.slice(eq + 1) : null;
    const value = (): string | null => {
      if (inline !== null) return inline;
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) return null;
      i++;
      return next;
    };
    if (flag === '--devices-ok' || flag === '--blank-home-paths' || flag === '--replace') {
      if (inline !== null) return `${flag} takes no value`;
      if (flag === '--devices-ok') devicesOk = true;
      else if (flag === '--blank-home-paths') blankHomePaths = true;
      else replace = true;
    } else if (flag === '--with-audio') {
      if (withAudio !== null) return '--with-audio is given twice';
      const v = value();
      if (v === null || v === '') return '--with-audio needs the session id after it, typed again: --with-audio <id>';
      withAudio = v;
    } else if (flag === '--alias') {
      const v = value();
      if (v === null) return '--alias needs "<system name>=<published name>"';
      const at = v.indexOf('=');
      const from = at < 0 ? '' : v.slice(0, at);
      const to = at < 0 ? '' : v.slice(at + 1);
      if (from.trim() === '' || to.trim() === '') return `--alias "${v}": expected "<system name>=<published name>", neither empty`;
      if (aliases.some(([f]) => f === from)) return `--alias for "${from}" is given twice`;
      aliases.push([from, to]);
    } else if (a.startsWith('-')) {
      return `unknown option ${a}`;
    } else if (id === null) {
      id = a;
    } else {
      return `unexpected argument ${a}`;
    }
  }
  if (id === null) return 'the session id is required (e.g. gate-b or headstart-1)';
  return { id, devicesOk, aliases, withAudio, blankHomePaths, replace };
}

export interface PackDeps {
  env: NodeJS.ProcessEnv;
  now: () => Date;
  /** Short commit for the ledger line; null outside a checkout. */
  commit: () => string | null;
  log: (line: string) => void;
  /** Refusals and failures (stderr). */
  error: (line: string) => void;
  /**
   * Tests only: called after each file of the temporary folder is written ('file'), before the
   * rename ('rename'), with --replace between moving the old set aside and moving the new one in
   * ('swap'), and before the pack step is appended to ledger.jsonl ('ledger'). A throw there must
   * leave data/ and ledger.jsonl as they were.
   */
  hook?: (stage: 'file' | 'rename' | 'swap' | 'ledger', name: string) => void;
}

export function defaultPackDeps(): PackDeps {
  return {
    env: process.env,
    now: () => new Date(),
    commit: () => gitShortCommit(REPO_ROOT),
    log: (line) => process.stdout.write(`${line}\n`),
    error: (line) => process.stderr.write(`${line}\n`),
  };
}

// ---- reading the session folder ------------------------------------------------------------

function lstatOrNull(p: string): fs.Stats | null {
  try {
    return fs.lstatSync(p);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw e;
  }
}

function isDirectory(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/** Bytes of a file of the session folder; null when it is not there. Links are refused: pack copies real files only. */
function readSessionFile(dir: string, name: string): Buffer | null {
  const file = path.join(dir, name);
  const st = lstatOrNull(file);
  if (st === null) return null;
  if (st.isSymbolicLink()) throw new PackRefusal(`${name} in ${shownPath(dir)} is a link: pack copies real files only`);
  if (!st.isFile()) throw new PackRefusal(`${name} in ${shownPath(dir)} is not a file`);
  return fs.readFileSync(file);
}

function readManifest(dir: string, id: string): { manifest: Manifest; bytes: Buffer } {
  const bytes = readSessionFile(dir, SESSION_FILES.manifest);
  if (bytes === null) throw new PackRefusal(`${shownPath(dir)} has no manifest.json`);
  const parsed = parseJson(bytes.toString('utf8'), validateManifest, { file: 'manifest.json' });
  if (parsed.value === null) throw new PackRefusal(`manifest.json of ${id} is not valid:\n  ${parsed.errors.join('\n  ')}`);
  if (parsed.value.id !== id) throw new PackRefusal(`manifest.json names session ${parsed.value.id}, not ${id}: the folder was renamed or its manifest replaced`);
  return { manifest: parsed.value, bytes };
}

// ---- the ledger of a gate record -------------------------------------------------------------

type LedgerPlan =
  /** Append `pack` with the hashes of the set. */
  | { mode: 'append'; records: LedgerLine[] }
  /**
   * A gate recording that never reached its verdict: no ledger line, `why` says so. `cutAt` is
   * the sample of the objection block's step mark when part B is held back (pack A, PREREG
   * section 7.5), else null; `notes` say what happened to part B.
   */
  | { mode: 'skip'; records: LedgerLine[]; why: string; cutAt: number | null; notes: string[] }
  /** A headstart take: no ledger. */
  | { mode: 'none' };

function readLedgerText(dir: string): string | null {
  const bytes = readSessionFile(dir, SESSION_FILES.ledger);
  return bytes === null ? null : bytes.toString('utf8');
}

/** Problem of one source file against the hash the last step line of the ledger holds for it; null when it matches. */
function ledgerHashProblem(records: readonly LedgerLine[], name: string, sha256: string | null): string | null {
  const want = recordedHash(records, name);
  if (want === null) return sha256 === null ? null : `${name}: no step line of ledger.jsonl holds its hash, so nothing says which step wrote it`;
  if (sha256 === null) return `${name} is missing (step ${want.step} wrote it)`;
  if (sha256 !== want.sha256) return `${name} changed after step ${want.step} wrote it (ledger ${want.sha256.slice(0, 8)}, file ${sha256.slice(0, 8)})`;
  return null;
}

function parseOrRefuse<T>(bytes: Buffer, name: string, validate: Validator<T>): T {
  const parsed = parseJson(bytes.toString('utf8'), validate, { file: name });
  if (parsed.value === null) throw new PackRefusal(`${name} is not valid:\n  ${parsed.errors.join('\n  ')}`);
  return parsed.value;
}

/** The valid lines of stamps.jsonl, a last line cut short by a crash left out. */
function stampRows(stamps: Buffer): StampLine[] {
  return parseJsonl(splitTruncatedTail(stamps.toString('utf8')).complete, validateStampLine, { file: 'stamps.jsonl' }).rows;
}

/** The valid lines of events.jsonl, as the session loader reads them, a last line cut short by a crash left out; none without the file. */
function eventRows(events: Buffer | null): EventLine[] {
  if (events === null) return [];
  return parseJsonl(splitTruncatedTail(events.toString('utf8')).complete, validateEventLine, { file: 'events.jsonl' }).rows as EventLine[];
}

/**
 * Sample of the objection block's step mark (4:15) in stamps.jsonl, the first one as stage A
 * takes it (analysis/lib/session.ts stepStart); null when the block never began.
 */
function objectionBlockStart(stamps: Buffer | null, pack: 'A' | 'B' | 'C'): number | null {
  if (stamps === null) return null;
  const name = gateSteps(pack).objections;
  for (const s of stampRows(stamps)) {
    const r = s as { k: string; n: number; what?: unknown; name?: unknown };
    if (r.k === 'mark' && r.what === 'step' && r.name === name) return r.n;
  }
  return null;
}

/**
 * Why a gate recording that does not count never reaches its verdict, and what comes next, by
 * pack. Pack A follows PREREG section 7 (section 11: "exactly as §7 says"), in the words of
 * analyze:gate (analysis/gate/inputs.ts nextRecordingAdvice), which quickcheck gives too: a
 * recording the SDK ended with kCreditExhausted is lost, before 4:15 too, and not replaced. Packs B
 * and C follow section 11: before 4:15 the pack is recorded again; after it the recording is lost;
 * a failure on condition 6 alone (fewer than 12 valid objections) stays in the pooled numbers, flagged.
 */
function noVerdictReason(a: {
  id: string;
  pack: 'A' | 'B' | 'C';
  contentOnly: boolean;
  objectionsReached: boolean;
  detectorComputed: boolean;
  creditsUsedUp: boolean;
  reason: string;
}): string {
  const head = `${a.id} never reached its verdict: ${a.reason}.`;
  if (a.pack === 'A') {
    const advice = nextRecordingAdvice({
      technical: !a.contentOnly,
      pack: 'A',
      objectionsReached: a.objectionsReached,
      detectorComputed: a.detectorComputed,
      creditsUsedUp: a.creditsUsedUp,
    });
    return `${head} ${advice.charAt(0).toUpperCase()}${advice.slice(1)}`;
  }
  if (a.contentOnly) {
    return `${head} Quickcheck failed on condition 6 alone (voice after fewer than 12 cues), which is not technical: stage A and stage B do not score such a recording, and PREREG section 11 keeps a pack ${a.pack} with fewer than 12 valid objections in the pooled numbers, flagged.`;
  }
  if (a.objectionsReached) {
    return `${head} The failure is technical and came after the objection block began (4:15): pack ${a.pack} is lost, reported with its reason and not replaced (PREREG section 11).`;
  }
  return `${head} The failure is technical and came before the objection block (4:15): pack ${a.pack} is recorded again, unless the SDK ended the recording with kCreditExhausted, which loses it (PREREG section 11).`;
}

/**
 * What the ledger of a gate record allows (spec 8.5, PREREG section 7.5): `pack` comes after the
 * verdict. A recording that does not count never gets one, so its set is written without a ledger
 * line; one that counts but has no verdict yet is refused.
 */
function gateLedgerPlan(dir: string, id: string, pack: 'A' | 'B' | 'C'): LedgerPlan {
  const text = readLedgerText(dir);
  if (text === null) throw new PackRefusal(`${id} has no ledger.jsonl: a gate record has its step journal from the record step on (spec 8.5)`);
  const v = verifyLedger(splitJsonlLines(text).filter((l) => l.length > 0), (t) => sha256Hex(t), { kind: 'gate' });
  if (!v.ok) throw new PackRefusal(`ledger.jsonl of ${id} is broken, nothing is written:\n  ${v.errors.join('\n  ')}`);
  const records = v.records;
  if (findSteps(records, 'quickcheck').length === 0) {
    throw new PackRefusal(`ledger.jsonl of ${id} has no quickcheck step: run npm run quickcheck -- ${id} first (spec 8.5, PREREG section 7.4)`);
  }
  if (canAppendStep(records, 'gate', 'pack') === null) return { mode: 'append', records };

  // No verdict: pack runs only if the recording does not count, by the files the steps wrote.
  const problems: string[] = [];
  const qBytes = readSessionFile(dir, SESSION_FILES.quickcheck);
  if (qBytes === null) throw new PackRefusal(`${id} has no quickcheck.json, so pack cannot tell whether the recording counts (spec 8.5)`);
  const qProblem = ledgerHashProblem(records, SESSION_FILES.quickcheck, sha256Hex(qBytes));
  if (qProblem !== null) problems.push(qProblem);
  const rBytes = readSessionFile(dir, 'clock_report.json');
  const rProblem = ledgerHashProblem(records, 'clock_report.json', rBytes === null ? null : sha256Hex(rBytes));
  if (rProblem !== null) problems.push(rProblem);
  if (problems.length > 0) throw new PackRefusal(`a file of an earlier step does not match ledger.jsonl (spec 8.5):\n  ${problems.join('\n  ')}`);
  const q = parseOrRefuse(qBytes, SESSION_FILES.quickcheck, validateQuickcheck);
  const report: ClockReport | null = rBytes === null ? null : parseOrRefuse(rBytes, 'clock_report.json', validateClockReport);
  const reasons = report !== null ? recordingVoidReasons(q, report) : q.result === 'GOOD RECORDING' ? [] : [`quickcheck.json says ${quickcheckLine(q)}`];
  if (reasons.length === 0) {
    throw new PackRefusal(
      `${id} has no verdict yet and nothing says it does not count: pack is the last step, after the verdict (PREREG section 7.5); run ${report === null ? 'clocks, label' : 'label'} and analyze:gate (stage A, stage B) first`,
    );
  }
  // quickcheck's technical flag is false only when condition 6 is its one failure (analysis/quickcheck.ts);
  // a clock check that has run must pass too, as analyze:gate reads it (analysis/gate/inputs.ts requireCountedRecording).
  const contentOnly = q.result !== 'GOOD RECORDING' && q.technical === false && (report === null || (report.audio_valid && report.trace_valid === true));
  const objectionsAt = objectionBlockStart(readSessionFile(dir, SESSION_FILES.stamps), pack);
  const stageAInLedger = records.some((r) => !isNoteLine(r) && r.step === 'stage_a');
  const why = noVerdictReason({
    id,
    pack,
    contentOnly,
    objectionsReached: objectionsAt !== null,
    detectorComputed: stageAInLedger,
    creditsUsedUp: creditsUsedUp(eventRows(readSessionFile(dir, SESSION_FILES.events))),
    reason: reasons[0]!,
  });
  if (objectionsAt === null) return { mode: 'skip', records, why, cutAt: null, notes: [] };
  if (pack === 'A' && !stageAInLedger) {
    // PREREG section 7.5: pack releases part B only after the stage A hash is in the ledger, and a
    // recording that does not count never gets one. Stage A tunes on pack A (section 11: "exactly
    // as section 7"), so the objection block heard here stays unpublished.
    return {
      mode: 'skip',
      records,
      why,
      cutAt: objectionsAt,
      notes: [
        `part B, the objection block from sample ${groupDigits(objectionsAt)} (4:15) on, is held back: pack releases it only after the stage A hash is in ledger.jsonl, and this recording never gets one (PREREG section 7.5). The set ends at that step mark; onsets.json, which times the replies of the objection block, is left out`,
      ],
    };
  }
  // Pack A with the stage A hash in the ledger: part B may be released (PREREG section 7.5).
  if (pack === 'A') return { mode: 'skip', records, why, cutAt: null, notes: [] };
  return {
    mode: 'skip',
    records,
    why,
    cutAt: null,
    notes: [
      `part B, the objection block, is published without a stage A line in ledger.jsonl: on packs B and C stage A tunes nothing, as PREREG section 11 freezes the parameters under the tag gate-retune before pack B is recorded${contentOnly ? ', and its numbers enter the pooled ones' : ''}`,
    ],
  };
}

// ---- reading the sources and building the set -------------------------------------------------

/** What pack reads from the session folder, before anything is built from it. */
interface Sources {
  /** Bytes of each text file read; null when the folder does not have it. */
  bytes: Map<string, Buffer | null>;
  audio: SessionAudio;
  /** SHA-256 of every file read (null: not in the folder), for the integrity checks. */
  hashes: Map<string, string | null>;
}

/**
 * Frames of audio.wav that hold the samples before `n`: the chunk stamps place each block of the
 * file on the sample clock (spec 8.1, core/clock chunkLayout); without them the file starts at 0.
 */
function framesBefore(stamps: Buffer | null, n: number): number {
  const runs = stamps === null ? [] : chunkLayout(stampRows(stamps), 0).runs;
  if (runs.length === 0) return n;
  let frames = 0;
  for (const r of runs) frames += Math.max(0, Math.min(r.n1, n) - r.n0);
  return frames;
}

/** Sample where the set ends when part B is held back; null for a whole set. */
function cutOf(plan: LedgerPlan): number | null {
  return plan.mode === 'skip' ? plan.cutAt : null;
}

/**
 * Reads every file the set is made from, audio.wav in one pass (its levels, its hash, the 16-bit
 * copy). samples.jsonl only for a gate record, for g_resets.json; it is never published.
 */
function readSources(dir: string, manifestBytes: Buffer, args: PackArgs, plan: LedgerPlan): Sources {
  const bytes = new Map<string, Buffer | null>();
  const hashes = new Map<string, string | null>([[SESSION_FILES.manifest, sha256Hex(manifestBytes)]]);
  const names = [
    SESSION_FILES.detectorIn,
    SESSION_FILES.stamps,
    SESSION_FILES.events,
    ...(plan.mode === 'none' ? [] : [SESSION_FILES.samples]),
    ...COPIED_FILES,
    ...(plan.mode === 'append' ? VERDICT_FILES : []),
  ];
  for (const name of names) {
    const b = readSessionFile(dir, name);
    bytes.set(name, b);
    hashes.set(name, b === null ? null : sha256Hex(b));
  }
  const audioFile = path.join(dir, SESSION_FILES.audio);
  const st = lstatOrNull(audioFile);
  if (st === null) throw new PackRefusal('audio.wav is missing: audio_env.json is made from it (spec 8.7)');
  if (st.isSymbolicLink() || !st.isFile()) throw new PackRefusal('audio.wav is not a plain file: pack reads real files only');
  const cut = cutOf(plan);
  const endFrame = cut === null ? null : framesBefore(bytes.get(SESSION_FILES.stamps) ?? null, cut);
  const audio = readSessionAudio(audioFile, { pcm16: args.withAudio !== null, endFrame });
  hashes.set(SESSION_FILES.audio, audio.sha256);
  return { bytes, audio, hashes };
}

/**
 * stream.jsonl of the recording before the objection block: the lines stage A reads (analysis/gate/
 * view.ts), so part B stays out. The whole build runs first, so a bad line anywhere still refuses.
 */
function streamBefore(detectorIn: string, stamps: string, nCut: number): StreamText {
  const whole = buildStreamJsonl(detectorIn, stamps);
  if (whole.text === null) return whole;
  const det = parseJsonl(splitTruncatedTail(detectorIn).complete, validateDetectorInLine, { file: 'detector_in.jsonl' }).rows as unknown as DetectorInput[];
  const st = parseJsonl(splitTruncatedTail(stamps).complete, validateStampLine, { file: 'stamps.jsonl' }).rows;
  const keep = detectorInPrefixLength(det, arrivalsBefore(st, nCut), nCut);
  const lines = splitJsonlLines(whole.text).slice(0, keep);
  const batchesWithoutArr = lines.flatMap((l) => {
    const row = JSON.parse(l) as { k: string; seq?: number; nArr?: number | null };
    return row.k === 'batch' && row.nArr === null && typeof row.seq === 'number' ? [row.seq] : [];
  });
  return { text: lines.length === 0 ? '' : `${lines.join('\n')}\n`, errors: [], warnings: whole.warnings, batchesWithoutArr };
}

/**
 * events.jsonl lines before the cut: those with n below it, and those without n (before the first
 * audio block, or where host knew no sample) up to the first line at or after it, as the file is in
 * time order. A line pack cannot read stays, for the checks to refuse.
 */
function eventsBefore(complete: string, nCut: number): string {
  let past = false;
  const kept = splitJsonlLines(complete).filter((line) => {
    let n: unknown;
    try {
      const v = JSON.parse(line) as unknown;
      n = isPlainObject(v) ? v['n'] : undefined;
    } catch {
      return true;
    }
    if (typeof n !== 'number') return !past;
    if (n >= nCut) past = true;
    return n < nCut;
  });
  return kept.length === 0 ? '' : `${kept.join('\n')}\n`;
}

/**
 * marks.jsonl of a gate set: the "mark" lines of stamps.jsonl as they are, in file order, from
 * which stage B lays out its steps and cues (analysis/gate/view.ts gateLayout, scoredCues). With
 * `nCut`, those before it, the marks stage A reads (view.ts stampsBefore). A last line a crash cut
 * short is left out, as stream.jsonl leaves it out; a mark line that is not valid stays, for
 * validatePublishedFolder to refuse. Deck writes each mark line as JSON.stringify writes its
 * fields, and a line that is not so is refused: the checks read parsed values, and a key given
 * twice would publish its first value, which none of them reads.
 */
export function marksJsonl(stamps: string, nCut: number | null): string {
  const kept: string[] = [];
  splitJsonlLines(splitTruncatedTail(stamps).complete).forEach((line, i) => {
    let v: unknown;
    try {
      v = JSON.parse(line) as unknown;
    } catch {
      return;
    }
    if (!isPlainObject(v) || v['k'] !== 'mark') return;
    const n = v['n'];
    if (nCut !== null && typeof n === 'number' && n >= nCut) return;
    if (JSON.stringify(v) !== line) {
      throw new PackRefusal(
        `stamps.jsonl line ${i + 1}: a mark line that is not as Deck writes it, JSON.stringify of its fields (a key given twice, a space or an escape differs). Pack copies mark lines unchanged into marks.jsonl, and a key given twice would publish a value that no check reads. Report the recording as broken with this line number; pack publishes no set of it`,
      );
    }
    kept.push(line);
  });
  return kept.length === 0 ? '' : `${kept.join('\n')}\n`;
}

/**
 * g_resets.json of a gate set: the packets stage B reads as reset frames of G, found as stage B
 * finds them, rivals gResetSeqs on the lines of detector_in.jsonl and samples.jsonl
 * (analysis/gate/stage-b.ts), kept to the packets of the published stream.jsonl. Before a cut those
 * are the packets stage A reads, and the seqs the ones it finds (stage-a.ts: view.ts samplesBefore
 * keeps the samples.jsonl line of each of them). A last line of samples.jsonl that a crash cut short
 * is dropped, as stream.jsonl drops one; with a broken line anywhere else the set gets no
 * g_resets.json (null), as stage B reads every line of samples.jsonl and scores no such recording
 * (analysis/gate/inputs.ts requireInputsWhole). live/reduce.cjs writes g null on every reset frame,
 * and replay checks that each listed packet has it, so files that disagree are refused here.
 */
export function gResetsJson(detectorIn: string, samples: string, stream: string, notes: string[]): string | null {
  const tail = splitTruncatedTail(samples);
  if (tail.tail !== null) notes.push(`samples.jsonl line ${String(tail.tailLine)}: partial last line dropped (no newline, not valid JSON: the recording was cut off)`);
  const parsed = parseJsonl(tail.complete, validateSampleLine, { file: SESSION_FILES.samples });
  if (parsed.errors.length > 0) {
    const more = parsed.errors.length > 1 ? ` (and ${groupDigits(parsed.errors.length - 1)} more)` : '';
    notes.push(
      `the set has no g_resets.json: ${parsed.errors[0]!}${more}, so samples.jsonl does not tell which packets with g null were reset frames of G; stage B reads every line of it and scores no such recording`,
    );
    return null;
  }
  const inputs = parseJsonl(splitTruncatedTail(detectorIn).complete, validateDetectorInLine, { file: SESSION_FILES.detectorIn }).rows as unknown as DetectorInput[];
  const gBySeq = new Map<number, number | null>();
  for (const line of splitJsonlLines(stream)) {
    const row = JSON.parse(line) as { k: string; seq?: unknown; g?: number | null };
    if (row.k === 'batch' && typeof row.seq === 'number') gBySeq.set(row.seq, row.g ?? null);
  }
  const seqs = [...gResetSeqs(inputs, parsed.rows as unknown as SampleLmLike[]).seqs].filter((seq) => gBySeq.has(seq)).sort((a, b) => a - b);
  const withG = seqs.filter((seq) => gBySeq.get(seq) !== null);
  if (withG.length > 0) {
    const shown = withG.slice(0, 5).join(', ') + (withG.length > 5 ? ` and ${groupDigits(withG.length - 5)} more` : '');
    throw new PackRefusal(
      `samples.jsonl flags the landmark frame of packet ${shown} as a reset of G, but detector_in.jsonl holds a g value there, while live/reduce.cjs writes g null on every reset frame: the two files disagree, and replay would refuse g_resets.json. Report the recording as broken with these packet numbers; pack publishes no set of it`,
    );
  }
  return toJsonText({ schema: G_RESETS_SCHEMA, seqs }, null);
}

/**
 * sniff_onsets.json of a gate set with its verdict: n_sniff of every sniff stage B heard, found as
 * stage B finds them (analysis/gate/stage-b.ts): the recording loaded as stage B loads it, laid out
 * by view.ts gateLayout, and clocks/compute.ts recountSniffLag with the L_rt block and the trace
 * sign of calib.json. npm run replay recounts row 4 from them with the published stream.jsonl,
 * marks.jsonl and calib.json (analysis/replay/sniffs.ts sniffRecountFrom), so the file is written
 * only when that recount gives what recountSniffLag gives on the recording. Otherwise, or when
 * stage B's layout of the recording fails, the set gets none, a note says why, and replay calls
 * the values that need it not recomputable.
 */
export function sniffOnsetsJson(sessionDir: string, files: ReadonlyMap<string, Buffer>, notes: string[]): string | null {
  const none = (why: string): null => {
    notes.push(`the set has no sniff_onsets.json: ${why}, so npm run replay cannot recount row 4, and best_case_ms and d1_on_sniffs_ms read not recomputable from the set`);
    return null;
  };
  const text = (name: string): string | null => files.get(name)?.toString('utf8') ?? null;
  const streamText = text('stream.jsonl');
  const marksText = text('marks.jsonl');
  const calib = parseJson(text('calib.json') ?? '', validateCalib, { file: 'calib.json' }).value;
  if (streamText === null || marksText === null || calib === null) return none('the recount needs stream.jsonl, marks.jsonl and a valid calib.json in the set');
  let s: LoadedSession;
  try {
    s = loadSession(sessionDir);
  } catch (e) {
    if (e instanceof SessionLoadError) return none(`the recording cannot be loaded as stage B loads it (${e.message})`);
    throw e;
  }
  let stageB: SniffRecount;
  let listening: string;
  let sign: 1 | -1;
  try {
    const layout = gateLayout(s);
    if (s.calib?.L_rt_ms === undefined || calib.L_rt_ms === undefined) return none('calib.json has no L_rt_ms');
    sign = signOf(s);
    stageB = recountSniffLag(s, layout.gate, coreLrtOf(s.calib.L_rt_ms), sign);
    listening = layout.gate.listening;
  } catch (e) {
    if (e instanceof GateRefusal) return none(`stage B's layout of the recording fails (${e.message})`);
    throw e;
  }
  const { inputs, nArrBySeq } = parseStream(streamText);
  const marks = parseJsonl(marksText, validateMarkLine, { file: 'marks.jsonl' }).rows;
  const fromSet = sniffRecountFrom({ inputs, nArrBySeq, marks, listening, lrt: coreLrtOf(calib.L_rt_ms), sign }, stageB.onsets);
  if (!sameJson(fromSet, stageB)) {
    const what = fromSet.aRef !== stageB.aRef ? 'A_ref of the listening block' : 'the sniff lag';
    return none(
      `recounted from the published stream.jsonl, marks.jsonl and calib.json with the onsets stage B finds, ${what} is not what recountSniffLag gives on samples.jsonl and stamps.jsonl of the recording`,
    );
  }
  return toJsonText({ schema: SNIFF_ONSETS_SCHEMA, onsets: stageB.onsets }, null);
}

interface BuiltSet {
  files: Map<string, Buffer>;
  notes: string[];
}

/**
 * The files of data/<id>/ from the sources (spec 8.7), in memory. With `cut` (part B held back)
 * stream.jsonl, marks.jsonl, g_resets.json, events.jsonl, audio_env.json and audio.wav end before
 * that sample, and onsets.json stays out. With --blank-home-paths the paths into a home folder in
 * events.jsonl are replaced here, so every check after it and the pack step's hashes see the
 * file as it is published. When that changes the file, manifest.json is built again after it,
 * with the hash of events.jsonl as published (withPublishedEventsHash).
 */
function buildSet(published: Manifest, sources: Sources, args: PackArgs, cut: number | null): BuiltSet {
  const notes: string[] = [];
  const files = new Map<string, Buffer>();
  const source = (name: string): Buffer | null => sources.bytes.get(name) ?? null;
  const manifestJson = (m: Manifest): Buffer => Buffer.from(toJsonText(m, 'manifest.json', 2), 'utf8');

  files.set('manifest.json', manifestJson(published));

  const detectorIn = source(SESSION_FILES.detectorIn);
  const stamps = source(SESSION_FILES.stamps);
  let streamText: string | null = null;
  if (detectorIn !== null) {
    if (stamps === null) throw new PackRefusal('detector_in.jsonl is there but stamps.jsonl is missing: stream.jsonl takes nArr from its arr stamps (spec 8.7)');
    const stream = cut === null ? buildStreamJsonl(detectorIn.toString('utf8'), stamps.toString('utf8')) : streamBefore(detectorIn.toString('utf8'), stamps.toString('utf8'), cut);
    if (stream.text === null) throw new PackRefusal(`stream.jsonl cannot be built:\n  ${stream.errors.join('\n  ')}`);
    notes.push(...stream.warnings);
    if (stream.batchesWithoutArr.length > 0) {
      const n = stream.batchesWithoutArr.length;
      notes.push(`stream.jsonl: the last ${n === 1 ? 'packet has' : `${groupDigits(n)} packets have`} no arr stamp (Deck had stopped), so nArr is null there`);
    }
    files.set('stream.jsonl', Buffer.from(stream.text, 'utf8'));
    streamText = stream.text;
  } else {
    notes.push('the session has no detector_in.jsonl, so the set has no stream.jsonl');
  }

  // A gate set: what npm run replay needs beside stream.jsonl (see the head of this file).
  if (published.kind === 'gate') {
    if (stamps !== null) files.set('marks.jsonl', Buffer.from(marksJsonl(stamps.toString('utf8'), cut), 'utf8'));
    else notes.push('the session has no stamps.jsonl, so the set has no marks.jsonl');
    const samples = source(SESSION_FILES.samples);
    if (detectorIn !== null && streamText !== null) {
      const resets = samples === null ? null : gResetsJson(detectorIn.toString('utf8'), samples.toString('utf8'), streamText, notes);
      if (resets !== null) files.set('g_resets.json', Buffer.from(resets, 'utf8'));
      else if (samples === null) notes.push('the session has no samples.jsonl, so the set has no g_resets.json: it does not say which packets with g null were reset frames of G');
    }
  }

  const events = source(SESSION_FILES.events);
  if (events !== null) {
    const tail = splitTruncatedTail(events.toString('utf8'));
    if (tail.tail !== null) {
      notes.push(`events.jsonl line ${String(tail.tailLine)}: partial last line dropped (no newline, not valid JSON: the recording was cut off)`);
    }
    const kept = cut !== null ? Buffer.from(eventsBefore(tail.complete, cut), 'utf8') : tail.tail !== null ? Buffer.from(tail.complete, 'utf8') : events;
    const blanked = args.blankHomePaths ? blankHomePaths(kept, notes) : kept;
    files.set('events.jsonl', blanked);
    const rehashed = blanked.equals(kept) ? null : withPublishedEventsHash(published, blanked);
    if (rehashed !== null) {
      // manifest.json is built again here and keeps its place in `files`.
      files.set('manifest.json', manifestJson(rehashed));
      notes.push('manifest.json holds the SHA-256 of events.jsonl as published, not of the session copy, whose hash would confirm a guessed home path (--blank-home-paths)');
    }
  }
  for (const name of [...COPIED_FILES, ...VERDICT_FILES]) {
    const b = source(name);
    // onsets.json times the replies of the objection block: part B.
    if (b !== null && !(cut !== null && name === 'onsets.json')) files.set(name, b);
  }

  const audio = sources.audio;
  if (audio.lengthNote !== null) notes.push(`audio.wav: ${audio.lengthNote}; audio_env.json covers the audio the file holds`);
  files.set('audio_env.json', Buffer.from(toJsonText(audio.env, 'audio_env.json'), 'utf8'));
  if (audio.pcm16 !== null) {
    files.set('audio.wav', audio.pcm16);
    if (audio.clipped > 0) notes.push(`audio.wav: ${groupDigits(audio.clipped)} ${audio.clipped === 1 ? 'sample was' : 'samples were'} outside the 16-bit range and clipped in the copy`);
    notes.push('audio.wav holds your voice: it becomes public once the set is pushed (spec 8.7, PRIVACY.md)');
  }
  return { files, notes };
}

/**
 * Checks the files read against ledger.jsonl, every one of them (gate), or against the hashes
 * manifest.json took of the recording files when the recording closed (headstart take).
 */
function integrityProblems(manifest: Manifest, hashes: ReadonlyMap<string, string | null>, plan: LedgerPlan, notes: string[]): string[] {
  const problems: string[] = [];
  if (plan.mode !== 'none') {
    for (const [name, sha] of hashes) {
      const p = ledgerHashProblem(plan.records, name, sha);
      if (p !== null) problems.push(p);
    }
    return problems;
  }
  const listed = manifest.files;
  if (Object.keys(listed).length === 0) {
    notes.push('manifest.json holds no file hashes (the recording did not close), so the recording files are not checked against it');
    return problems;
  }
  for (const name of RECORDING_FILES) {
    const sha = hashes.get(name) ?? null;
    const entry = listed[name];
    const want = typeof entry === 'string' ? entry.replace(/^sha256:/, '') : null;
    if (want === null) {
      if (sha !== null) problems.push(`${name} is not among the files manifest.json hashed when the recording closed`);
    } else if (sha === null) {
      problems.push(`${name} is missing (manifest.json holds its hash)`);
    } else if (sha !== want) {
      problems.push(`${name} changed after the recording closed (manifest.json ${want.slice(0, 8)}, file ${sha.slice(0, 8)})`);
    }
  }
  return problems;
}

// ---- device names ----------------------------------------------------------------------------

/** A device name with the --alias pairs applied in order, each replacing every occurrence of its system name. */
function aliasName(name: string, aliases: readonly (readonly [string, string])[]): string {
  return aliases.reduce((acc, [from, to]) => acc.split(from).join(to), name);
}

/** A copy of `value` with the string at a dotted listDeviceNames path (camera.name, audio.settings.label) replaced. */
function withStringAt(value: Record<string, unknown>, keys: readonly string[], s: string): Record<string, unknown> {
  const [k, ...rest] = keys;
  if (k === undefined) return value;
  const here = value[k];
  return { ...value, [k]: rest.length === 0 ? s : isPlainObject(here) ? withStringAt(here, rest, s) : here };
}

/**
 * The public manifest.json (spec 8.7): toPublishedManifest without aliases (no local paths, no
 * device ids), then the --alias pairs applied to the device and machine names that listDeviceNames
 * finds and pack prints, and nowhere else: the ids, the pack letter, the SDK version and every other
 * field stay as host wrote them.
 */
export function publishedManifest(m: Manifest, aliases: readonly (readonly [string, string])[]): Manifest {
  let out = toPublishedManifest(m) as unknown as Record<string, unknown>;
  for (const d of listDeviceNames(out as unknown as Manifest)) {
    const to = aliasName(d.value, aliases);
    if (to !== d.value) out = withStringAt(out, d.path.split('.'), to);
  }
  return out as unknown as Manifest;
}

/** The names pack prints before it writes (spec 8.7): system name, and the published one when an alias changes it. */
export function deviceNameLines(m: Manifest, aliases: readonly [string, string][]): string[] {
  const published = new Map(listDeviceNames(publishedManifest(m, aliases)).map((d) => [d.path, d.value]));
  const names = listDeviceNames(m);
  if (names.length === 0) return ['  (manifest.json holds no device or machine name)'];
  return names.map((d) => {
    const to = published.get(d.path);
    return to === undefined || to === d.value ? `  ${d.path}: ${d.value}` : `  ${d.path}: ${d.value} -> ${to} (--alias)`;
  });
}

/** Aliases whose system name no device or machine name holds: a name typed differently from the system's, or another field's text. */
export function unusedAliases(m: Manifest, aliases: readonly [string, string][]): string[] {
  const names = listDeviceNames(m).map((d) => d.value);
  return aliases.filter(([from]) => !names.some((n) => n.includes(from))).map(([from]) => from);
}

/** System names an alias replaces, each with the device and machine names that hold it. */
function aliasedNames(m: Manifest, aliases: readonly [string, string][]): { name: string; paths: string }[] {
  const byName = new Map<string, string[]>();
  for (const d of listDeviceNames(m)) {
    if (aliasName(d.value, aliases) !== d.value) byName.set(d.value, [...(byName.get(d.value) ?? []), d.path]);
  }
  return [...byName].map(([name, paths]) => ({ name, paths: paths.join(', ') }));
}

/** Every string inside a JSON value with its path (keys are not read). */
function stringsIn(value: unknown, at = ''): { path: string; s: string }[] {
  if (typeof value === 'string') return [{ path: at === '' ? '(value)' : at, s: value }];
  if (Array.isArray(value)) return value.flatMap((x, i) => stringsIn(x, `${at}[${i}]`));
  if (isPlainObject(value)) return Object.entries(value).flatMap(([k, x]) => stringsIn(x, at === '' ? k : `${at}.${k}`));
  return [];
}

/**
 * Fields of the public manifest outside the device and machine names (which pack prints with
 * their published values) that still hold a system name an alias replaces. Empty when none does.
 */
export function aliasLeaks(m: Manifest, aliases: readonly [string, string][]): string[] {
  const replaced = aliasedNames(m, aliases);
  if (replaced.length === 0) return [];
  const printed = new Set(listDeviceNames(m).map((d) => d.path));
  const out: string[] = [];
  for (const { path: at, s } of stringsIn(publishedManifest(m, aliases))) {
    if (printed.has(at)) continue;
    for (const r of replaced) {
      if (s.includes(r.name)) out.push(`manifest.json ${at}: holds the system name of ${r.paths}, which --alias replaces only in the device and machine names above`);
    }
  }
  return out;
}

/**
 * A home folder in a path (/Users/<name>, /home/<name>, ~/, \Users\, a drive letter): it can show
 * the account name. What may stand before ~/ or a drive letter is a lookbehind, so that a match
 * starts where the path starts (blankHomePathsIn).
 */
const HOME_PATH = /\/Users\/|\/home\/|\\Users\\|(?<![\w.~-])~\/|(?<![A-Za-z0-9])[A-Za-z]:[\\/]/;
/** Web addresses, left out before HOME_PATH is tried: their paths are no folders of the computer. */
const WEB_URL = /\b(?:https?|wss?):\/\/[^\s"'<>]*/gi;

/** True when a string holds a path into a home folder; URL paths such as "/" and web addresses pass. */
export function holdsHomePath(s: string): boolean {
  return HOME_PATH.test(s.replace(WEB_URL, ' '));
}

/** What --blank-home-paths puts in place of each path into a home folder in events.jsonl. */
export const HOME_PATH_BLANK = '<home path>';
/** A path into a home folder ends at white space or a quote, or with the string. */
const PATH_END = /[\s"'`]/;

/**
 * `s` with each path into a home folder replaced by HOME_PATH_BLANK, from where HOME_PATH matches
 * to the end of the path; web addresses stay, as holdsHomePath skips them. `count` is the number
 * of paths replaced. The result is gone over again until it holds none, so that holdsHomePath
 * passes every string this returns.
 */
export function blankHomePathsIn(s: string): { text: string; count: number } {
  let text = s;
  let count = 0;
  for (;;) {
    const urls = [...text.matchAll(WEB_URL)].map((m) => [m.index, m.index + m[0].length] as const);
    const home = new RegExp(HOME_PATH.source, 'g');
    let out = '';
    let from = 0;
    let found = 0;
    for (let m = home.exec(text); m !== null; m = home.exec(text)) {
      const at = m.index;
      if (urls.some(([a, b]) => at >= a && at < b)) continue;
      let end = at + m[0].length;
      while (end < text.length && !PATH_END.test(text.charAt(end))) end++;
      out += `${text.slice(from, at)}${HOME_PATH_BLANK}`;
      from = end;
      home.lastIndex = end;
      found++;
    }
    if (found === 0) return { text, count };
    text = `${out}${text.slice(from)}`;
    count += found;
  }
}

/** `value` with blankHomePathsIn applied to every string in it (keys are not read); `fields` gets the field of each path replaced, named as stringsIn names it. */
function blankStrings(value: unknown, at: string, fields: string[]): unknown {
  if (typeof value === 'string') {
    const r = blankHomePathsIn(value);
    for (let k = 0; k < r.count; k++) fields.push(at === '' ? '(value)' : at);
    return r.text;
  }
  if (Array.isArray(value)) return value.map((x, i) => blankStrings(x, `${at}[${i}]`, fields));
  if (isPlainObject(value)) return Object.fromEntries(Object.entries(value).map(([k, x]) => [k, blankStrings(x, at === '' ? k : `${at}.${k}`, fields)]));
  return value;
}

/**
 * events.jsonl with each path into a home folder in its strings replaced by HOME_PATH_BLANK, the
 * one rewrite pack makes, and only with --blank-home-paths. tap blanks out only the API key of an
 * SDK or tap error message (live/tap.cjs redact), host writes the message into events.jsonl
 * (live/host.cjs onSdkError), and a file error names its absolute path. A line that holds such a
 * path is written again as JSON.stringify writes it, as host writes every line; the other lines
 * stay byte for byte. Each path replaced adds a note naming the line, numbered as privateStrings
 * numbers it, and the field, never the path. Without such a path the bytes come back as they are.
 */
export function blankHomePaths(events: Buffer, notes: string[]): Buffer {
  let changed = false;
  const lines = events.toString('utf8').split('\n').map((raw, i) => {
    const bom = i === 0 && raw.charCodeAt(0) === 0xfeff ? raw.charAt(0) : '';
    const cr = raw.endsWith('\r') ? '\r' : '';
    let value: unknown;
    try {
      value = JSON.parse(raw.slice(bom.length, raw.length - cr.length));
    } catch {
      return raw; // validatePublishedFolder refuses a line that is not JSON
    }
    const fields: string[] = [];
    const blanked = blankStrings(value, '', fields);
    if (fields.length === 0) return raw;
    changed = true;
    for (const f of fields) notes.push(`events.jsonl line ${i + 1}, ${f}: a path into a home folder is replaced by "${HOME_PATH_BLANK}" (--blank-home-paths)`);
    return `${bom}${JSON.stringify(blanked)}${cr}`;
  });
  return changed ? Buffer.from(lines.join('\n'), 'utf8') : events;
}

/**
 * The public manifest with "sha256:" and the hash of `events`, events.jsonl as published, in place
 * of the hash host took of the session copy when the recording closed; null when `files` holds no
 * hash of events.jsonl (the recording did not close), so there is none to replace. Once
 * blankHomePaths has replaced a path, the hash of the session copy would let anyone with the set
 * confirm a guessed path, and the account name in it: the rest of the file is published, and the
 * rest of such a path is easy to guess from the repository. The other fields stay as they are.
 */
function withPublishedEventsHash(published: Manifest, events: Buffer): Manifest | null {
  if (!Object.hasOwn(published.files, SESSION_FILES.events)) return null;
  return { ...published, files: { ...published.files, [SESSION_FILES.events]: `sha256:${sha256Hex(events)}` } };
}

/** Files of a set whose strings are scanned: every file but manifest.json, which has its own checks, and audio.wav. */
const SCANNED_FILES = [
  'stream.jsonl', 'marks.jsonl', 'g_resets.json', 'sniff_onsets.json', 'events.jsonl', 'onsets.json', 'calib.json', 'clock_report.json',
  'verdict.md', 'verdict.json', 'audio_env.json',
] as const;

/**
 * Strings of the set that publish what the manifest keeps private (spec 8.7): a home folder path
 * (an SDK error message can hold one, live/host.cjs onSdkError) or the system name of a device
 * that --alias replaces. A name published as confirmed (--devices-ok, no alias) is in manifest.json
 * anyway, so it passes. The files are copied unchanged (spec 8.7), so pack refuses rather than
 * edit them; the one exception is events.jsonl, whose paths into a home folder --blank-home-paths
 * replaces before this scan (blankHomePaths), so such a path found there names the option. Names
 * file, line and field (JSON) or line (verdict.md), never the string itself.
 */
export function privateStrings(files: ReadonlyMap<string, Buffer>, m: Manifest, aliases: readonly [string, string][]): string[] {
  const replaced = aliasedNames(m, aliases);
  const out: string[] = [];
  const check = (where: string, s: string, hint = ''): void => {
    if (holdsHomePath(s)) out.push(`${where}: holds a path into a home folder, which can show the account name${hint}`);
    for (const r of replaced) if (s.includes(r.name)) out.push(`${where}: holds the system name of ${r.paths}, which --alias replaces`);
  };
  const checkJson = (where: string, value: unknown, hint = ''): void => {
    for (const { path: at, s } of stringsIn(value)) check(`${where}, ${at}`, s, hint);
  };
  for (const name of SCANNED_FILES) {
    const bytes = files.get(name);
    if (bytes === undefined) continue;
    const text = bytes.toString('utf8');
    if (name.endsWith('.md')) {
      text.split('\n').forEach((line, i) => check(`${name} line ${i + 1}`, line));
    } else if (name.endsWith('.jsonl')) {
      const hint = name === 'events.jsonl' ? `; --blank-home-paths replaces it by "${HOME_PATH_BLANK}"` : '';
      splitJsonlLines(text).forEach((line, i) => {
        try {
          checkJson(`${name} line ${i + 1}`, JSON.parse(line), hint);
        } catch {
          // validatePublishedFolder refuses a line that is not JSON
        }
      });
    } else {
      try {
        checkJson(name, JSON.parse(text));
      } catch {
        // validatePublishedFolder refuses a file that is not JSON
      }
    }
  }
  return out;
}

/** At most `max` lines of a list, the rest counted. */
function capped(lines: readonly string[], max = 10): string[] {
  return lines.length <= max ? [...lines] : [...lines.slice(0, max), `... and ${lines.length - max} more`];
}

// ---- writing ----------------------------------------------------------------------------------

/** A set renamed into place, the set it replaced (if any) still kept aside until `commit`. */
interface PlacedSet {
  /** Removes the set that was replaced; returns a note when it could not be removed. */
  commit(): string | null;
  /** Takes the new set out and puts back the set that was there, or none; throws when it cannot. */
  rollback(): void;
}

function placeSetAtomically(
  dataRoot: string,
  target: string,
  id: string,
  files: ReadonlyMap<string, Buffer>,
  replace: boolean,
  deps: PackDeps,
  beforeRename: () => void,
): PlacedSet {
  fs.mkdirSync(dataRoot, { recursive: true });
  const tmp = fs.mkdtempSync(path.join(dataRoot, `.${id}.pack-`));
  const old = `${tmp}-old`;
  let hasOld = false;
  let placed = false;
  try {
    // mkdtemp makes the folder private (0700); the published folder is an ordinary one.
    fs.chmodSync(tmp, 0o755);
    for (const name of SET_ORDER) {
      const bytes = files.get(name);
      if (bytes === undefined) continue;
      fs.writeFileSync(path.join(tmp, name), bytes, { flag: 'wx' });
      deps.hook?.('file', name);
    }
    deps.hook?.('rename', target);
    beforeRename();
    if (replace && lstatOrNull(target) !== null) {
      fs.renameSync(target, old);
      try {
        deps.hook?.('swap', target);
        fs.renameSync(tmp, target);
      } catch (e) {
        try {
          fs.renameSync(old, target);
        } catch {
          throw new Error(`the old set could not be moved back: it is in ${shownPath(old)}/; rename it to ${shownPath(target)}/ (${(e as Error).message})`);
        }
        throw e;
      }
      hasOld = true;
    } else {
      fs.renameSync(tmp, target);
    }
    placed = true;
  } finally {
    if (!placed) fs.rmSync(tmp, { recursive: true, force: true });
  }
  return {
    commit: () => {
      if (!hasOld) return null;
      try {
        fs.rmSync(old, { recursive: true, force: true });
        return null;
      } catch (e) {
        // The new set is in place: say where the old one is left rather than fail.
        return `the set that was there could not be removed (${(e as Error).message}): it is in ${shownPath(old)}/, delete it by hand`;
      }
    },
    rollback: () => {
      try {
        fs.renameSync(target, tmp);
      } catch (e) {
        throw new Error(`${shownPath(target)}/ still holds the new set (${(e as Error).message})${hasOld ? `; the set that was there is in ${shownPath(old)}/` : ''}`);
      }
      if (hasOld) {
        try {
          fs.renameSync(old, target);
        } catch (e) {
          throw new Error(`the set that was there is in ${shownPath(old)}/ and the new one in ${shownPath(tmp)}/ (${(e as Error).message}): rename the first to ${shownPath(target)}/ and delete the second`);
        }
      }
      try {
        fs.rmSync(tmp, { recursive: true, force: true });
      } catch (e) {
        throw new Error(`the new set is left in ${shownPath(tmp)}/ (${(e as Error).message}): delete it by hand`);
      }
    },
  };
}

/**
 * Takes ledger.jsonl back to the bytes it had before pack appended to it: an append that failed
 * can leave part of a line. Returns null when the file is as it was, else what is wrong.
 */
function restoreLedger(dir: string, before: Buffer): string | null {
  const file = path.join(dir, SESSION_FILES.ledger);
  try {
    const now = fs.readFileSync(file);
    if (now.equals(before)) return null;
    if (now.length > before.length && now.subarray(0, before.length).equals(before)) {
      fs.truncateSync(file, before.length);
      return null;
    }
    return 'it changed in another way while pack ran';
  } catch (e) {
    return (e as Error).message;
  }
}

// ---- the command ------------------------------------------------------------------------------

/** Runs pack; returns 0 when data/<id>/ is written. Throws PackRefusal when nothing is written. */
export function runPack(args: PackArgs, deps: PackDeps): number {
  const { id } = args;
  if (!SESSION_ID.test(id)) {
    throw new PackRefusal(`"${id}" is not a session id: an id names a folder in sessions/, like gate-b or headstart-1`);
  }
  const sessionDir = path.join(sessionsDir(deps.env), id);
  if (!isDirectory(sessionDir)) throw new PackRefusal(`no session folder ${shownPath(sessionDir)}`);
  const { manifest, bytes: manifestBytes } = readManifest(sessionDir, id);
  const noSet = whyNoSet(manifest.kind, manifest.pack);
  if (noSet !== null) throw new PackRefusal(`${id}: ${noSet}`);
  const notMeasured = whyNotMeasured(manifest as unknown as Record<string, unknown>);
  if (notMeasured !== null) {
    throw new PackRefusal(`manifest.json of ${id} says ${notMeasured}: no SDK measured this folder, so it is no recording and gets no set (spec 6.5)`);
  }
  if (args.withAudio !== null && args.withAudio !== id) {
    throw new PackRefusal(`--with-audio ${args.withAudio} does not repeat the session id. This publishes your voice from session ${id}. Type the session id to confirm: --with-audio ${id}`);
  }

  const dataRoot = dataDir(deps.env);
  const target = path.join(dataRoot, id);
  const existing = lstatOrNull(target);
  if (existing !== null) {
    if (!existing.isDirectory()) throw new PackRefusal(`${shownPath(target)} exists and is not a folder: remove it by hand`);
    if (!args.replace) throw new PackRefusal(`${shownPath(target)}/ exists: add --replace to write the set again`);
  }

  const pack = manifest.pack;
  const plan: LedgerPlan = manifest.kind === 'gate' && (pack === 'A' || pack === 'B' || pack === 'C') ? gateLedgerPlan(sessionDir, id, pack) : { mode: 'none' };

  deps.log(`pack ${id}: device and machine names as the published manifest.json will hold them (spec 8.7):`);
  for (const line of deviceNameLines(manifest, args.aliases)) deps.log(line);
  const unused = unusedAliases(manifest, args.aliases);
  if (unused.length > 0) {
    throw new PackRefusal(
      `${unused.map((n) => `--alias "${n}=..."`).join(', ')}: no device or machine name above holds ${unused.length === 1 ? 'this name' : 'these names'}, so nothing would be replaced; use the system name exactly as printed above`,
    );
  }
  const leaks = aliasLeaks(manifest, args.aliases);
  if (leaks.length > 0) {
    throw new PackRefusal(`nothing written: the published manifest.json would still show a name --alias replaces:\n  ${capped(leaks).join('\n  ')}`);
  }
  if (!args.devicesOk) {
    throw new PackRefusal(
      'nothing written: check the names above. If they may be published as shown, run again with --devices-ok; to replace one, add --alias "<system name>=<published name>"',
    );
  }

  const sources = readSources(sessionDir, manifestBytes, args, plan);
  const integrityNotes: string[] = [];
  const integrity = integrityProblems(manifest, sources.hashes, plan, integrityNotes);
  if (integrity.length > 0) {
    throw new PackRefusal(`a file of ${id} does not match the hash recorded for it, so nothing is published (spec 8.5):\n  ${integrity.join('\n  ')}`);
  }
  const set = buildSet(publishedManifest(manifest, args.aliases), sources, args, cutOf(plan));
  if (plan.mode === 'append') {
    // A gate set with its verdict: the sniff onsets of row 4 for npm run replay.
    const sniffs = sniffOnsetsJson(sessionDir, set.files, set.notes);
    if (sniffs !== null) set.files.set('sniff_onsets.json', Buffer.from(sniffs, 'utf8'));
  }
  set.notes.unshift(...integrityNotes, ...(plan.mode === 'skip' ? plan.notes : []));
  const texts: Record<string, string | null> = {};
  for (const [name, bytes] of set.files) texts[name] = name === 'audio.wav' ? null : bytes.toString('utf8');
  const problems = validatePublishedFolder(texts, { audio: args.withAudio !== null });
  if (problems.length > 0) throw new PackRefusal(`the set for data/${id}/ would not be valid (spec 8.7):\n  ${problems.join('\n  ')}`);
  const leaked = privateStrings(set.files, manifest, args.aliases);
  if (leaked.length > 0) {
    throw new PackRefusal(
      `the set for data/${id}/ would publish what the manifest keeps private (spec 8.7, PRIVACY.md); pack copies the files as they are, and only --blank-home-paths rewrites one of them, events.jsonl:\n  ${capped(leaked).join('\n  ')}`,
    );
  }

  let ledgerLine: string | null = null;
  let ledgerAtPrepare: Buffer | null = null;
  if (plan.mode === 'append') {
    const outSha256: Record<string, string> = {};
    for (const [name, bytes] of set.files) outSha256[`data/${id}/${name}`] = sha256Hex(bytes);
    ledgerAtPrepare = readSessionFile(sessionDir, SESSION_FILES.ledger);
    const prepared = prepareLedgerStep(sessionDir, 'gate', 'pack', { utc: utcSeconds(deps.now()), commit: deps.commit(), outSha256 });
    if (prepared.line === null) throw new PackRefusal(`ledger.jsonl of ${id} refuses the pack step: ${String(prepared.reason)}`);
    ledgerLine = prepared.line;
  }

  const asItWas = existing !== null ? 'the old set is as it was' : 'no folder was left behind';
  let placed: PlacedSet;
  try {
    placed = placeSetAtomically(dataRoot, target, id, set.files, existing !== null, deps, () => {
      if (ledgerAtPrepare !== null && !sameBytes(readSessionFile(sessionDir, SESSION_FILES.ledger), ledgerAtPrepare)) {
        throw new PackRefusal(`ledger.jsonl of ${id} changed while pack ran; run pack again`);
      }
    });
  } catch (e) {
    if (e instanceof PackRefusal) throw new PackRefusal(`${e.message}; nothing written`);
    throw new PackRefusal(`writing ${shownPath(target)}/ failed (${(e as Error).message}); nothing written, ${asItWas}`);
  }
  if (ledgerLine !== null && ledgerAtPrepare !== null) {
    try {
      deps.hook?.('ledger', SESSION_FILES.ledger);
      writeLedgerLine(sessionDir, ledgerLine);
    } catch (e) {
      // A set without its pack step would be a release the ledger does not record: take it back.
      const why = (e as Error).message;
      const ledgerProblem = restoreLedger(sessionDir, ledgerAtPrepare);
      let setProblem: string | null = null;
      try {
        placed.rollback();
      } catch (r) {
        setProblem = (r as Error).message;
      }
      if (setProblem !== null || ledgerProblem !== null) {
        throw new Error(
          [
            `the pack step could not be appended to ledger.jsonl of ${id} (${why})`,
            setProblem !== null ? `the set could not be taken back: ${setProblem}` : `the set was taken back (${asItWas})`,
            ledgerProblem !== null ? `ledger.jsonl could not be put back as it was (${ledgerProblem}): check its last line by hand` : 'ledger.jsonl is as it was',
          ].join('; '),
        );
      }
      throw new PackRefusal(`the pack step could not be appended to ledger.jsonl of ${id} (${why}); nothing written, ${asItWas}, and ledger.jsonl is as it was`);
    }
  }
  const leftover = placed.commit();

  if (leftover !== null) set.notes.push(leftover);
  let total = 0;
  for (const bytes of set.files.values()) total += bytes.length;
  deps.log(`pack: wrote ${shownPath(target)}/ (${set.files.size} files, ${formatBytes(total)}${existing !== null ? ', replacing the set that was there' : ''}):`);
  const width = Math.max(...[...set.files.keys()].map((n) => n.length));
  const sizeWidth = Math.max(...[...set.files.values()].map((b) => groupDigits(b.length).length));
  for (const name of SET_ORDER) {
    const bytes = set.files.get(name);
    if (bytes === undefined) continue;
    deps.log(`  ${name.padEnd(width)}  ${groupDigits(bytes.length).padStart(sizeWidth)} ${bytes.length === 1 ? 'byte' : 'bytes'}`);
    if (bytes.length > GITHUB_LIMIT_BYTES) set.notes.push(`${name} is over 100 MiB: GitHub refuses such a file, so leave it out of the commit`);
    else if (bytes.length > GITHUB_WARN_BYTES) set.notes.push(`${name} is over 50 MiB: GitHub warns about such a file`);
  }
  if (plan.mode === 'append') deps.log(`ledger: step pack appended to ledger.jsonl of ${id} with the SHA-256 of each file`);
  else if (plan.mode === 'skip') deps.log(`ledger: no pack step: ${plan.why}`);
  else deps.log('ledger: none, a headstart take has no step journal (spec 8.5)');
  for (const note of set.notes) deps.log(`note: ${note}`);
  deps.log(`next: git add ${shownPath(target)}`);
  return 0;
}

/** True when both are null or hold the same bytes. */
function sameBytes(a: Buffer | null, b: Buffer | null): boolean {
  return a === null || b === null ? a === b : a.equals(b);
}

export async function main(argv: readonly string[], deps: PackDeps = defaultPackDeps()): Promise<number> {
  const args = parsePackArgs(argv);
  if (typeof args === 'string') {
    deps.error(`${args}\n${USAGE}`);
    return 2;
  }
  try {
    return runPack(args, deps);
  } catch (e) {
    if (e instanceof PackRefusal) {
      deps.error(`pack refused: ${e.message}`);
      return 1;
    }
    deps.error(`pack failed: ${e instanceof Error ? e.message : String(e)}`);
    return 1;
  }
}

const invokedDirectly = process.argv[1] !== undefined && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (invokedDirectly) {
  main(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (e: unknown) => {
      process.stderr.write(`pack failed: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}\n`);
      process.exitCode = 1;
    },
  );
}
