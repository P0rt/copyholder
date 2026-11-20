// What npm run confirm reads (PREREG.md section 11): params/frozen.json as the retune froze it,
// and each gate recording with the files its steps wrote, every one checked against ledger.jsonl
// before anything is computed. A recording of pack B or C enters in one of three ways:
//   counts   GOOD RECORDING and a valid clock check: stage B scored it, and its verdict.json is
//            the one stage B's computation run again must give;
//   content  quickcheck failed on condition 6 alone (voice after fewer than 12 cues, which is not
//            technical, PREREG section 7.4): stage A and stage B do not score such a recording,
//            but section 11 keeps it in the pooled numbers, flagged, so confirm scores it with
//            stage B's function (analysis/gate/score.ts scoreGate) and the frozen parameters;
//   lost     a technical failure after the objection block began (4:15), or a recording the SDK
//            ended with kCreditExhausted at any time: not in the numbers, not replaced, reported
//            with its reason (section 11).
// Any other technical failure before 4:15 is not a recording of the pack: section 11 records the
// pack again (RecordAgainRefusal). A recording host never saved (no ledger.jsonl, manifest.json not
// closed) is a technical failure too, judged by what host wrote while it recorded. One whose
// manifest.json says closed but that has no ledger.jsonl is refused (UnsavedRefusal): host did not
// finish saving it, or the ledger was removed, and the folder cannot tell which.
// A folder no SDK measured (manifest.json dry, a tap other than the real one, or sdk null; analysis/
// pack/rules.ts whyNotMeasured) is no recording at all (spec 6.5): refused when it is given, and
// not a recording of its pack when the sessions folder is scanned. Each recording given must lie
// directly inside the sessions folder, where the other recordings of its pack are looked for, and
// every manifest.json there must be readable. A file that cannot be read is refused with its name
// and what to do (UnreadableFileRefusal), never thrown as it is.

import fs from 'node:fs';
import path from 'node:path';
import type { Stamp } from '../../core/clock/index.ts';
import { d1ParamsFromFrozen, nArrMapFromStamps, type DetectorInput, type FrozenParamsLike } from '../../core/detector.ts';
import {
  LedgerError,
  findSteps,
  paramsAreTuned,
  parseJson,
  parseJsonl,
  quickcheckLine,
  splitJsonlLines,
  stageAParamsHash,
  validateCalib,
  validateClockReport,
  validateDetectorInLine,
  validateEventLine,
  validateManifest,
  validateOnsets,
  validateQuickcheck,
  validateSampleLine,
  validateStampLine,
  validateVerdict,
  type Calib,
  type ClockReport,
  type EventOther,
  type FrozenParams,
  type LedgerLine,
  type Manifest,
  type Quickcheck,
  type Validator,
  type Verdict,
} from '../../core/schemas/index.ts';
import { recountSniffLag } from '../clocks/compute.ts';
import { frozenParamsFile } from '../lib/calib-io.ts';
import { sha256Hex } from '../lib/ledger.ts';
import { isSessionId, sessionDirOf, sessionsDir, shownPath } from '../lib/paths.ts';
import { SESSION_FILES, stepStart } from '../lib/session.ts';
import { gateSteps } from '../lib/steps.ts';
import { gResetSeqs, lipBaselines } from '../rivals/index.ts';
import { GateRefusal, coreLrtOf, lrtUseFrom } from '../gate/common.ts';
import type { GateDeps } from '../gate/deps.ts';
import { RETUNE_TAG, checkRetune, criterionMetOf, gSettingsOf, jsonDiffPaths, sameJson, variantOf } from '../gate/frozen.ts';
import {
  CLOCK_REPORT_FILE,
  ONSETS_FILE,
  QUICKCHECK_FILE,
  readValidJson,
  recordedHash,
  recordingVoidReasons,
  requireInputsWhole,
  requireLabelsHash,
  requireRecordedHashes,
} from '../gate/inputs.ts';
import { readGateLedger, type GateLedger } from '../gate/ledger-guard.ts';
import { codeTimeline, traceTimeline } from '../gate/objections.ts';
import { runG, type DetectorRun, type RunSetup } from '../gate/runs.ts';
import { scoreGate } from '../gate/score.ts';
import { loadGateSession, signOf } from '../gate/stage-a.ts';
import { verdictMarkdown } from '../gate/verdict-text.ts';
import { gateLayout, scoredCues } from '../gate/view.ts';
import { whyNotMeasured } from '../pack/rules.ts';
import { ConfirmRefusal, RecordAgainRefusal, UnreadableFileRefusal, UnsavedRefusal, folderArg, isFsError, namedIn } from './common.ts';
import type { PackRuns } from './facts.ts';

/** Runs `f`; a refusal of the gate helpers becomes a refusal of confirm that names the recording. */
export function forRecording<T>(what: string, f: () => T): T {
  try {
    return f();
  } catch (e) {
    if (e instanceof GateRefusal) throw new ConfirmRefusal(`${what}: ${e.message}`);
    if (e instanceof LedgerError) throw new ConfirmRefusal(`${what}: ${e.problems.join('; ')}`);
    throw e;
  }
}

/**
 * The text of a file; null when it does not exist. Any other file system error (a folder in its
 * place, no permission to read it, a disk error) is refused with the file's name, since Node's
 * error for reading a folder names none (UnreadableFileRefusal).
 */
function readText(file: string): string | null {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch (e) {
    if (!isFsError(e)) throw e;
    if (e.code === 'ENOENT') return null;
    throw new UnreadableFileRefusal(shownPath(file), e.message);
  }
}

// ---- params/frozen.json after the retune (section 11) -------------------------------------

export interface RetunedParams {
  file: string;
  text: string;
  value: Record<string, unknown>;
  sha256: string;
  criterionMet: boolean;
  variant: 'D1' | 'D3';
  k: number;
  L: number;
  M: number;
  thetaG: number;
}

/**
 * params/frozen.json as section 11 freezes it before pack B: equal to its copy params/retune.json
 * and to that copy under the git tag gate-retune, read as stage A reads it (analysis/gate/frozen.ts
 * checkRetune, deps.tagFile). Refuses otherwise.
 */
export function readRetunedParams(deps: Pick<GateDeps, 'env' | 'tagFile'>): RetunedParams {
  const file = frozenParamsFile(deps.env);
  const retuneFile = path.join(path.dirname(file), 'retune.json');
  const text = readText(file);
  if (text === null) throw new ConfirmRefusal(`${shownPath(file)} does not exist: packs B and C are scored with the parameters tuned on pack A and frozen under the tag ${RETUNE_TAG} (PREREG.md section 11)`);
  const retuneText = readText(retuneFile);
  if (retuneText === null) {
    throw new ConfirmRefusal(
      `${shownPath(retuneFile)} does not exist: the confirmation needs the parameters tuned on pack A, copied to params/retune.json and frozen with npm run freeze -- ${RETUNE_TAG} before pack B (PREREG.md section 11)`,
    );
  }
  const value = forRecording('params', () => checkRetune({ frozenText: text, retuneText, taggedText: deps.tagFile(RETUNE_TAG, retuneFile), tag: RETUNE_TAG }));
  // paramsAreTuned reads g.theta_G as gSettingsOf does, so a tuned set always has a theta_G.
  const thetaG = gSettingsOf(value).thetaG;
  if (!paramsAreTuned(value as unknown as FrozenParams) || thetaG === null) {
    throw new ConfirmRefusal(`${shownPath(file)} has no k or theta_G: it is not a tuned parameter set (PREREG.md section 11)`);
  }
  const criterionMet = forRecording('params', () => criterionMetOf(value, 'params/frozen.json'));
  const d1 = d1ParamsFromFrozen(value);
  return { file, text, value, sha256: sha256Hex(text), criterionMet, variant: variantOf(value), k: d1.k, L: d1.L, M: d1.M, thetaG };
}

// ---- one recording: the checks before anything is computed ---------------------------------

/** What a recording must be: pack B or C for the confirmation, pack A for --dev. */
export type PackRole = 'confirm' | 'dev';

/** How a recording of pack B or C enters the confirmation (section 11; see the head of this file). */
export type PackStanding = 'counts' | 'content' | 'lost';

/** Why a recording is lost (section 11): the SDK credits ran out, or another technical failure after 4:15. */
export type LostCause = 'credits' | 'technical';

export interface LostFacts {
  cause: LostCause;
  /** Whether Deck had entered the objection block (4:15) when the recording failed. */
  objectionsBegun: boolean;
}

/** The confirmatory stage B's outputs, as it wrote them and the ledger holds their hashes. */
export interface StageBOutputs {
  verdict: Verdict;
  verdictMd: string;
}

export interface PackRecord {
  /** The id or folder given on the command line. */
  arg: string;
  id: string;
  dir: string;
  pack: 'A' | 'B' | 'C';
  manifest: Manifest;
  /** SmartSpectra SDK version from manifest.json; null when host could not read it. */
  sdkVersion: string | null;
  /** When the recording started (manifest.json started_utc). */
  startedUtc: string;
  /** ledger.jsonl, verified; null only for a lost recording host never saved, which has none. */
  ledger: GateLedger | null;
  standing: PackStanding;
  /** quickcheck.json as the quickcheck step wrote it; null only for a lost recording host never saved. */
  quickcheck: Quickcheck | null;
  /** Why the recording does not count (quickcheck and the clock check, or host's save); empty when it counts. */
  voidReasons: string[];
  /** Why a lost recording is lost; null unless the standing is lost. */
  lost: LostFacts | null;
  /** Hash of params/frozen.json in the confirmatory stage_a line; null when stage A has not run. */
  stageASha256: string | null;
  /** verdict.json and verdict.md of the confirmatory stage B; null when it has not run (content, lost). */
  stageB: StageBOutputs | null;
}

/** A recording in the numbers (it counts, or failed on condition 6 alone): it has its ledger and quickcheck.json. */
export type ScoredRecord = PackRecord & { standing: 'counts' | 'content'; ledger: GateLedger; quickcheck: Quickcheck };

/** Whether a recording is in the numbers; one that is not is lost, and may have no ledger or quickcheck.json. */
export function isScored(r: PackRecord): r is ScoredRecord {
  return r.standing !== 'lost' && r.ledger !== null && r.quickcheck !== null;
}

function packWord(p: unknown): string {
  return p === null || p === undefined ? 'no pack' : `pack ${String(p)}`;
}

/** Pack role checks (section 11): B or C confirm, A is development data, 0 is never scored. */
export function packRoleProblem(id: string, pack: unknown, role: PackRole): string | null {
  if (role === 'dev') return pack === 'A' ? null : `--dev takes the pack A recording; ${id} is ${packWord(pack)}`;
  if (pack === 'B' || pack === 'C') return null;
  if (pack === 'A') {
    return `${id} is the pack A recording: pack A tunes the detector and is development data, printed apart with --dev and never pooled; the two ids are the recordings of packs B and C (PREREG.md section 11)`;
  }
  if (pack === '0') return `${id} is the pack 0 probe, which is never scored (PREREG.md section 7.4); the two ids are the recordings of packs B and C`;
  return `${id} has ${packWord(pack)}; the two ids are the gate recordings of packs B and C (PREREG.md section 11)`;
}

/**
 * The standing of a recording from quickcheck.json and clock_report.json, by the rule stage A and
 * stage B refuse with (analysis/gate/inputs.ts requireCountedRecording): it counts with GOOD
 * RECORDING and a valid clock check; its failure is content alone when quickcheck failed only on
 * condition 6 (technical false) and the clock check is valid; anything else is technical.
 * `report` is null when the clock check has not run, which only a technical failure may leave.
 */
export function standingOf(q: Pick<Quickcheck, 'result' | 'technical'>, report: Pick<ClockReport, 'audio_valid' | 'trace_valid'> | null): 'counts' | 'content' | 'technical' {
  const clockValid = report !== null && report.audio_valid && report.trace_valid === true;
  if (!clockValid) return 'technical';
  if (q.result === 'GOOD RECORDING') return 'counts';
  return q.technical === false ? 'content' : 'technical';
}

/** kCreditExhausted, the SDK error for used-up credits (live/lib/sdk-codes.cjs). */
export const CREDIT_EXHAUSTED_CODE = 4;
export const CREDIT_EXHAUSTED_NAME = 'kCreditExhausted';

/**
 * The events.jsonl line that says the SDK ended the recording because its credits ran out: an
 * `sdk_error` with code 4 or the name kCreditExhausted. Host writes such a line only while it
 * records, and then stops the recording (live/host.cjs onSdkError); the one restart of code 8 is
 * not an end. events.jsonl must be the file the record step wrote, when the ledger holds its hash.
 * Null when there is no such line.
 */
export function creditExhaustedEvent(dir: string, records: readonly LedgerLine[]): EventOther | null {
  if (recordedHash(records, SESSION_FILES.events) !== null) requireRecordedHashes(records, dir, [SESSION_FILES.events]);
  const text = readText(path.join(dir, SESSION_FILES.events));
  if (text === null) return null;
  const rows = parseJsonl(text, validateEventLine).rows as unknown as EventOther[];
  const ends = (ev: EventOther): boolean =>
    ev.e === 'sdk_error' && ev['action'] !== 'reset_restart' && (ev['code'] === CREDIT_EXHAUSTED_CODE || ev['name'] === CREDIT_EXHAUSTED_NAME);
  return rows.find(ends) ?? null;
}

/** Stamps of the recording as the session loader reads them (valid lines only), without audio.wav. */
function readStamps(dir: string): Stamp[] {
  const text = readText(path.join(dir, SESSION_FILES.stamps));
  return text === null ? [] : (parseJsonl(text, validateStampLine).rows as unknown as Stamp[]);
}

/**
 * The recording files stage B scores from, read as the session loader reads them (analysis/lib/
 * session.ts loadSession: every line validated, broken lines listed), without audio.wav: what
 * requireInputsWhole needs to judge them before any recording is loaded.
 */
export function inputFiles(dir: string): { dir: string; missing: string[]; problems: string[] } {
  const missing: string[] = [];
  const problems: string[] = [];
  const jsonl: readonly [string, Validator<unknown>][] = [
    [SESSION_FILES.stamps, validateStampLine],
    [SESSION_FILES.samples, validateSampleLine],
    [SESSION_FILES.detectorIn, validateDetectorInLine],
  ];
  for (const [file, validate] of jsonl) {
    const text = readText(path.join(dir, file));
    if (text === null) missing.push(file);
    else problems.push(...parseJsonl(text, validate, { file, maxErrors: 20 }).errors);
  }
  const calib = readText(path.join(dir, SESSION_FILES.calib));
  if (calib !== null) problems.push(...parseJson(calib, validateCalib, { file: SESSION_FILES.calib, maxErrors: 20 }).errors);
  return { dir, missing, problems };
}

/**
 * Stage B's checks of the files it scores from (analysis/gate/stage-b.ts runStageB), made here
 * before any recording is computed: every input file whole, calib.json, onsets.json and
 * clock_report.json with the hashes the ledger holds, the blind labels whose hash the label step
 * put in the ledger, and an L_rt and a trace sign in calib.json. events.jsonl must be readable too,
 * since the session loader reads it (analysis/lib/session.ts loadSession).
 */
function requireScorableFiles(dir: string, ledger: GateLedger): void {
  requireInputsWhole(inputFiles(dir));
  readText(path.join(dir, SESSION_FILES.events));
  requireRecordedHashes(ledger.records, dir, [SESSION_FILES.calib, ONSETS_FILE, CLOCK_REPORT_FILE]);
  const onsets = readValidJson(dir, ONSETS_FILE, validateOnsets);
  requireLabelsHash(onsets, ledger.records);
  const calib = readValidJson<Calib>(dir, SESSION_FILES.calib, validateCalib);
  lrtUseFrom(calib.L_rt_ms);
  signOf({ calib });
}

/** The confirmatory stage B's verdict, checked against the ledger and the stage A line. */
function readStageB(what: string, dir: string, id: string, pack: string, ledger: GateLedger, stageASha256: string): StageBOutputs {
  forRecording(what, () => requireRecordedHashes(ledger.records, dir, ['verdict.json', 'verdict.md']));
  const verdict = forRecording(what, () => readValidJson(dir, 'verdict.json', validateVerdict));
  if (verdict.run !== 1 || verdict.exploratory) throw new ConfirmRefusal(`${what}: verdict.json is from stage B run ${verdict.run}, not the confirmatory run 1`);
  if (verdict.pack !== pack || verdict.id !== id) throw new ConfirmRefusal(`${what}: verdict.json is for ${verdict.id} pack ${verdict.pack}, not for ${id} pack ${pack}`);
  if (verdict.params_sha256 !== stageASha256) {
    throw new ConfirmRefusal(`${what}: verdict.json was scored with params ${verdict.params_sha256.slice(0, 8)}, but stage A froze ${stageASha256.slice(0, 8)}`);
  }
  return { verdict, verdictMd: readText(path.join(dir, 'verdict.md')) ?? '' };
}

/** The refusal of --dev for a pack A recording that does not count (sections 4, 7.4, 11). */
function devRefusal(what: string, voidReasons: readonly string[]): ConfirmRefusal {
  return new ConfirmRefusal(
    [`${what} does not count, so it has no numbers: --dev takes the pack A recording with GOOD RECORDING, a valid clock check and its stage B (PREREG.md sections 4, 7.4, 11):`, ...voidReasons.map((r) => `  ${r}`)].join('\n'),
  );
}

/**
 * The refusal of a recording whose manifest.json says closed but that has no ledger.jsonl. With
 * "Saving failed" nothing can judge it, and for pack B or C npm run confirm then refuses every form
 * that would leave it out (run.ts laterRecordings, notRecordedC), so section 11 is applied by hand.
 */
function unsavedMessage(what: string, pack: 'A' | 'B' | 'C', role: PackRole): string {
  const head = `${what}: host did not finish saving this folder, or its ledger.jsonl was removed later. Its manifest.json says closed, but ledger.jsonl does not exist: host closes manifest.json and then appends the record step to ledger.jsonl (live/host.cjs saveRecording), and when that append fails it prints "Saving failed" as the recording ends. No step can run without the record step, and the folder cannot tell the two cases apart, so confirm does not judge this recording. If ledger.jsonl was moved or deleted, put it back and run npm run confirm again. If host printed "Saving failed", no command can add the record step now`;
  if (role === 'dev') return `${head}, and the recording has no numbers: --dev takes the pack A recording with GOOD RECORDING, a valid clock check and its stage B (PREREG.md sections 4, 7.4, 11)`;
  const also = pack === 'C' ? 'pack B alone and every later recording of pack C' : `every later recording of pack ${pack}`;
  return `${head}: npm run confirm refuses this recording, and also ${also}, so unless an earlier recording of pack ${pack} is the one section 11 keeps, it cannot give the confirmatory numbers of this participant. They are then reported by hand, with this recording as a technical failure: recorded again if it stopped before 4:15 for a reason other than the end of the SDK credits, and lost otherwise (PREREG.md section 11)`;
}

/** What a recording is before its standing: the folder, its manifest.json, and what was read of its steps. */
type RecordBase = Omit<PackRecord, 'standing' | 'lost' | 'stageASha256' | 'stageB'>;

/**
 * A recording of pack B or C that failed for a technical reason (section 11): lost when the SDK
 * ended it with kCreditExhausted, at any time, or when Deck had entered its objection block (4:15)
 * by its step mark in stamps.jsonl; otherwise the pack is recorded again, and this recording is not
 * the pack's (RecordAgainRefusal). `records` is its ledger, which holds the hash of events.jsonl
 * once the record step ran; a recording host never saved has none, so its events.jsonl is read as
 * it is.
 */
function technicalFailure(base: RecordBase, records: readonly LedgerLine[]): PackRecord {
  const what = `pack ${base.pack} (${base.id})`;
  const objectionsBegun = objectionsReached(base.dir, base.pack);
  // Section 11: a recording the SDK ends with kCreditExhausted is lost, before 4:15 too, and not replaced.
  if (forRecording(what, () => creditExhaustedEvent(base.dir, records)) !== null) {
    return { ...base, standing: 'lost', lost: { cause: 'credits', objectionsBegun }, stageASha256: null, stageB: null };
  }
  if (!objectionsBegun) {
    throw new RecordAgainRefusal(
      [
        `${what} failed for a technical reason before its objection block began (4:15), so it is not the recording of pack ${base.pack}: by PREREG.md section 11 pack ${base.pack} is recorded again, and that recording is the one to give:`,
        ...base.voidReasons.map((r) => `  ${r}`),
      ].join('\n'),
    );
  }
  return { ...base, standing: 'lost', lost: { cause: 'technical', objectionsBegun }, stageASha256: null, stageB: null };
}

function realPathOrNull(p: string): string | null {
  try {
    return fs.realpathSync(p);
  } catch {
    return null;
  }
}

/**
 * Refuses a recording whose folder does not lie directly inside the sessions folder. The other
 * recordings of a pack, which decide whether a recording is the one section 11 keeps, are looked
 * for in the sessions folder alone (gateRecordingsOf), so a recording given from elsewhere would be
 * judged without them. The folders are compared by their real paths, links resolved.
 */
export function requireInSessionsFolder(arg: string, dir: string, env: NodeJS.ProcessEnv): void {
  const root = sessionsDir(env);
  const parent = realPathOrNull(path.dirname(dir));
  if (parent !== null && parent === realPathOrNull(root)) return;
  const name = path.basename(dir);
  // A folder whose name is not a session id is given by its path even inside the sessions folder.
  const give = isSessionId(name)
    ? `give the ids of the recordings, such as ${name}, in place of their folder paths`
    : `give this folder by its path again, since its name ${name} is not a session id`;
  throw new ConfirmRefusal(
    `${arg} is the folder ${shownPath(dir)}, which does not lie directly inside the sessions folder ${shownPath(root)}. npm run confirm looks for the other recordings of each pack in the sessions folder alone, so it cannot check that a recording given from elsewhere is the one section 11 keeps for its pack: set COPYHOLDER_SESSIONS_DIR to ${shownPath(path.dirname(dir))} and ${give} (PREREG.md section 11)`,
  );
}

/**
 * The checks of one recording before any computation: a folder directly inside the sessions
 * folder, a day-one gate recording of the right pack that an SDK measured, quickcheck.json and
 * clock_report.json as their steps wrote them, its standing (section 11), and for a recording that
 * is scored, the files stage B scores from and, once stage B has run, its verdict.json and
 * verdict.md with the hashes the ledger holds. Reads no audio. With --dev it returns only a
 * recording that counts, and refuses any other.
 */
export function inspectPack(arg: string, role: 'dev', env: NodeJS.ProcessEnv): ScoredRecord;
export function inspectPack(arg: string, role: PackRole, env: NodeJS.ProcessEnv): PackRecord;
export function inspectPack(arg: string, role: PackRole, env: NodeJS.ProcessEnv): PackRecord {
  const dir = sessionDirOf(arg, env);
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) throw new ConfirmRefusal(`${arg}: no session folder ${shownPath(dir)}`);
  requireInSessionsFolder(arg, dir, env);
  const manifestText = readText(path.join(dir, SESSION_FILES.manifest));
  if (manifestText === null) throw new ConfirmRefusal(`${arg}: ${shownPath(dir)} has no ${SESSION_FILES.manifest}`);
  const m = parseJson(manifestText, validateManifest, { file: SESSION_FILES.manifest });
  if (m.value === null) throw new ConfirmRefusal(`${arg}: ${SESSION_FILES.manifest} is not valid:\n  ${m.errors.join('\n  ')}`);
  const manifest = m.value;
  const id = manifest.id;
  if (manifest.kind !== 'gate') {
    throw new ConfirmRefusal(`${arg} is a ${manifest.kind} record, not a day-one gate recording: npm run confirm pools the gate recordings of packs B and C (PREREG.md section 11)`);
  }
  const roleProblem = packRoleProblem(id, manifest.pack, role);
  if (roleProblem !== null) throw new ConfirmRefusal(roleProblem);
  const pack = manifest.pack as 'A' | 'B' | 'C';
  const what = `pack ${pack} (${id})`;
  // The name of the folder, which differs from the id when an operator renamed the folder.
  const folderName = path.basename(dir);

  // A recording no SDK measured is never data (spec 6.5): the stand-in SDK, the mock tap's made-up
  // chest trace, or no SDK at all. It has no SDK version for the setup line either (section 11).
  const notMeasured = whyNotMeasured(manifest as unknown as Record<string, unknown>);
  if (notMeasured !== null) {
    const wanted = role === 'dev' ? 'the pack A recording' : `the recording of pack ${pack}`;
    throw new ConfirmRefusal(
      `${what} is not a recording the SDK measured: its manifest.json says ${notMeasured}, and a recording no SDK measured is never data, whatever quickcheck and the later steps made of it. Give ${wanted} that the SDK measured, made with the real tap (spec 6.5, PREREG.md section 11)`,
    );
  }
  const folder = { arg, id, dir, pack, manifest, sdkVersion: manifest.sdk?.version ?? null, startedUtc: manifest.started_utc };

  // A recording host never saved: host writes manifest.json with state 'recording' at consent and
  // 'crashed' on an uncaught exception. It writes state 'closed' when it saves the recording, just
  // before it appends the record step to ledger.jsonl (live/host.cjs saveRecording). A second
  // Ctrl+C while host waits for tap, a crash or a closed terminal leaves no ledger.jsonl, and no
  // later step can add one (quickcheck appends its step only after record), so the folder stays as
  // host left it: a technical failure (section 11).
  const ledgerText = readText(path.join(dir, SESSION_FILES.ledger));
  const state = manifest['state'];
  if (ledgerText === null && state !== 'closed') {
    const voidReasons = [`host did not save the recording (${SESSION_FILES.manifest} state ${typeof state === 'string' ? state : 'not set'}, no ${SESSION_FILES.ledger})`];
    if (role === 'dev') throw devRefusal(what, voidReasons);
    return technicalFailure({ ...folder, ledger: null, quickcheck: null, voidReasons }, []);
  }
  // A closed manifest.json without ledger.jsonl: host closed the manifest, then the append of the
  // record step failed (host printed "Saving failed"), or ledger.jsonl was removed later. The folder
  // cannot tell the two apart, and no step can run without the record step, so it is refused: a
  // removed ledger must not turn a recording into an attempt that section 11 records again, or into
  // a lost one. A later recording of the pack, and pack B alone, are refused while it stands (run.ts).
  if (ledgerText === null) throw new UnsavedRefusal(unsavedMessage(what, pack, role));

  // The lines as the session loader splits them (analysis/lib/session.ts).
  const ledger = forRecording(what, () => readGateLedger(dir, splitJsonlLines(ledgerText).filter((l) => l.length > 0)));
  const records = ledger.records;

  // host saved the recording, but quickcheck has not run on it: host runs it after the record step,
  // unless the recording was stopped with Ctrl+C. Without quickcheck.json nothing tells the standing.
  if (findSteps(records, 'quickcheck').length === 0) {
    throw new ConfirmRefusal(
      `quickcheck has not run on ${namedIn(id, folderName)} (host does not run it after Ctrl+C): run npm run quickcheck -- ${folderArg(dir)}, then npm run confirm again (PREREG.md section 11)`,
    );
  }

  // Quickcheck and the clock check, as their steps wrote them (sections 4, 7.4). Only a technical
  // quickcheck failure may come without a clock check.
  forRecording(what, () => requireRecordedHashes(records, dir, [QUICKCHECK_FILE]));
  const q = forRecording(what, () => readValidJson(dir, QUICKCHECK_FILE, validateQuickcheck));
  let report: ClockReport | null = null;
  if (q.technical !== true || recordedHash(records, CLOCK_REPORT_FILE) !== null) {
    forRecording(what, () => requireRecordedHashes(records, dir, [CLOCK_REPORT_FILE]));
    report = forRecording(what, () => readValidJson(dir, CLOCK_REPORT_FILE, validateClockReport));
  }
  const voidReasons = report === null ? [`${QUICKCHECK_FILE} says ${quickcheckLine(q)}`] : recordingVoidReasons(q, report);
  const status = standingOf(q, report);
  const base: RecordBase = { ...folder, ledger, quickcheck: q, voidReasons };

  if (role === 'dev' && status !== 'counts') throw devRefusal(what, voidReasons);
  if (status === 'technical') return technicalFailure(base, records);

  // Stage A, then the confirmatory stage B with its verdict (sections 7.5, 11). Neither runs on a
  // recording that does not count, so a content failure normally has neither.
  const stageASha256 = forRecording(what, () => stageAParamsHash(records));
  const stageBRan = findSteps(records, 'stage_b').length > 0 || findSteps(records, 'verdict').length > 0;
  let stageB: StageBOutputs | null = null;
  if (status === 'counts' || stageASha256 !== null || stageBRan) {
    // analyze:gate takes the folder as confirm does: by its name, which is the id unless an operator renamed it.
    if (stageASha256 === null) {
      throw new ConfirmRefusal(`${what}: stage A has not run (no confirmatory stage_a line in ledger.jsonl): run npm run analyze:gate -- --stage A ${folderArg(dir)}, then stage B (PREREG.md section 7.5)`);
    }
    if (findSteps(records, 'stage_b').length === 0 || findSteps(records, 'verdict').length === 0) {
      throw new ConfirmRefusal(
        `${what}: stage B has not finished (no confirmatory stage_b and verdict lines in ledger.jsonl): run npm run analyze:gate -- --stage B ${folderArg(dir)} first (PREREG.md section 7.5)`,
      );
    }
    stageB = readStageB(what, dir, id, pack, ledger, stageASha256);
  }
  forRecording(what, () => requireScorableFiles(dir, ledger));
  return { ...base, standing: status, lost: null, stageASha256, stageB };
}

/** A recording of a pack in the sessions folder, as its manifest.json gives it, for the order of section 11. */
export interface GateRecordingEntry {
  dir: string;
  /** manifest.json id, or the folder name when the manifest has none. */
  id: string;
  /** manifest.json started_utc (host's time of consent); null when the manifest has none. */
  startedUtc: string | null;
}

/** "gate-c-10" as ["gate-c", 10]: the session id host gives and its numeric suffix; an id without one is the first, 1. */
function idParts(id: string): [string, number] {
  const m = /^(.+)-(\d+)$/.exec(id);
  return m === null ? [id, 1] : [m[1]!, Number(m[2])];
}

function textOrder(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * The order in which two recordings of a pack were made, for section 11, which keeps the first
 * recording of a pack unless it failed for a technical reason before 4:15 (then the pack is
 * recorded again): negative when `a` came first. The order rule: by manifest.json started_utc,
 * which host sets at consent; on a tie, or when either has no started_utc that parses, by the
 * session id host gives (live/lib/session-ids.cjs: gate-c, then gate-c-2, gate-c-3, ...), its base
 * name first and then its numeric suffix, so that gate-c comes before gate-c-2 and gate-c-2 before
 * gate-c-10; then by the whole id. Zero for two folders with the same start and id: host gives
 * each recording its own id, so they are copies of one recording, whatever the folder names.
 */
export function compareRecordings(a: Pick<GateRecordingEntry, 'id' | 'startedUtc'>, b: Pick<GateRecordingEntry, 'id' | 'startedUtc'>): number {
  const ta = a.startedUtc === null ? NaN : Date.parse(a.startedUtc);
  const tb = b.startedUtc === null ? NaN : Date.parse(b.startedUtc);
  if (!Number.isNaN(ta) && !Number.isNaN(tb) && ta !== tb) return ta - tb;
  const [baseA, nA] = idParts(a.id);
  const [baseB, nB] = idParts(b.id);
  if (baseA !== baseB) return textOrder(baseA, baseB);
  if (nA !== nB) return nA - nB;
  return textOrder(a.id, b.id);
}

/** A folder of a pack that no SDK measured (analysis/pack/rules.ts whyNotMeasured): no recording of the pack. */
export interface UnmeasuredFolder extends GateRecordingEntry {
  /** What its manifest.json says, as whyNotMeasured gives it: "tap: "mock" (the mock tap made up the chest trace)". */
  why: string;
}

/** The gate folders of a pack in the sessions folder: its recordings, and the folders no SDK measured. */
export interface PackFolders {
  /** The recordings of the pack, which an SDK measured, in the order they were made. */
  recordings: GateRecordingEntry[];
  /** The folders of the pack no SDK measured (dry, the mock tap, no SDK), in the same order. */
  unmeasured: UnmeasuredFolder[];
}

/**
 * The order of the folders of a pack: the order the recordings were made (compareRecordings);
 * among copies of one recording, the folder named by its id first, then by folder name, so that a
 * message names that folder when a copy has another name.
 */
function folderOrder(a: GateRecordingEntry, b: GateRecordingEntry): number {
  const made = compareRecordings(a, b);
  if (made !== 0) return made;
  const renamed = (x: GateRecordingEntry): number => (path.basename(x.dir) === x.id ? 0 : 1);
  return renamed(a) - renamed(b) || textOrder(path.basename(a.dir), path.basename(b.dir));
}

/** The message of an error, for a refusal. */
function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/**
 * The refusal of the folders of the sessions folder whose manifest.json cannot be read or holds no
 * JSON object (`problems`, one line each): confirm cannot tell whether they hold recordings of pack
 * B or C, which decide whether a recording given is the one section 11 keeps for its pack.
 */
function unreadManifests(root: string, problems: readonly string[]): ConfirmRefusal {
  const one = problems.length === 1;
  return new ConfirmRefusal(
    [
      `npm run confirm cannot tell whether ${one ? 'a folder' : `${problems.length} folders`} of the sessions folder ${shownPath(root)} ${one ? 'holds' : 'hold'} a recording of pack B or C, since ${one ? 'its' : 'their'} manifest.json cannot be read, and the other recordings of a pack decide whether a recording given is the one section 11 keeps for that pack. Make each manifest.json below readable to this user: where a folder stands in its place, put the file back, and where it holds no JSON object, put back the manifest.json host wrote. Then run npm run confirm again (PREREG.md section 11):`,
      ...problems.map((p) => `  ${p}`),
    ].join('\n'),
  );
}

/**
 * The day-one gate folders of `pack` in the sessions folder, by their manifest.json alone (kind
 * gate, that pack), in the order they were made (folderOrder). A folder no SDK measured
 * (whyNotMeasured: dry, a tap other than the real one, or sdk null) is no recording of the pack
 * (spec 6.5), so it is kept apart, to be reported as not counted. An entry without manifest.json (a
 * plain file, or a folder host never wrote one in) holds no recording host started, and is left
 * out. Refuses when the sessions folder cannot be listed, or when a manifest.json there cannot be
 * read or holds no JSON object (a folder in its place, no permission to read it, a broken file):
 * confirm could not tell then whether that folder holds a recording of the pack.
 */
export function gateRecordingsOf(pack: 'B' | 'C', env: NodeJS.ProcessEnv): PackFolders {
  const root = sessionsDir(env);
  let names: string[];
  try {
    names = fs.readdirSync(root).sort();
  } catch (e) {
    throw new ConfirmRefusal(
      `the sessions folder ${shownPath(root)} cannot be listed (${errorText(e)}), so npm run confirm cannot look for the other recordings of packs B and C there, which decide whether a recording given is the one section 11 keeps for its pack: make the folder readable to this user, then run npm run confirm again (PREREG.md section 11)`,
    );
  }
  const recordings: GateRecordingEntry[] = [];
  const unmeasured: UnmeasuredFolder[] = [];
  const unread: string[] = [];
  for (const name of names) {
    const dir = path.join(root, name);
    const file = path.join(dir, SESSION_FILES.manifest);
    let text: string;
    try {
      text = fs.readFileSync(file, 'utf8');
    } catch (e) {
      // No manifest.json: a folder without one (ENOENT), or a plain file of the sessions folder (ENOTDIR).
      if (isFsError(e) && (e.code === 'ENOENT' || e.code === 'ENOTDIR')) continue;
      unread.push(`${shownPath(file)}: ${errorText(e)}`);
      continue;
    }
    let m: unknown;
    try {
      m = JSON.parse(text);
    } catch {
      unread.push(`${shownPath(file)}: not valid JSON`);
      continue;
    }
    if (m === null || typeof m !== 'object' || Array.isArray(m)) {
      unread.push(`${shownPath(file)}: not a JSON object`);
      continue;
    }
    const v = m as Record<string, unknown>;
    if (v['kind'] !== 'gate' || v['pack'] !== pack) continue;
    const entry: GateRecordingEntry = { dir, id: typeof v['id'] === 'string' ? v['id'] : name, startedUtc: typeof v['started_utc'] === 'string' ? v['started_utc'] : null };
    const why = whyNotMeasured(v);
    if (why === null) recordings.push(entry);
    else unmeasured.push({ ...entry, why });
  }
  if (unread.length > 0) throw unreadManifests(root, unread);
  return { recordings: recordings.sort(folderOrder), unmeasured: unmeasured.sort(folderOrder) };
}

/**
 * Whether Deck entered the objection block (4:15) of `pack` in the folder `dir`, by its step mark
 * in stamps.jsonl, read as the session loader reads it (valid lines only); false without
 * stamps.jsonl. Throws an UnreadableFileRefusal when stamps.jsonl exists but cannot be read.
 */
export function objectionsReached(dir: string, pack: 'A' | 'B' | 'C'): boolean {
  return stepStart({ stamps: readStamps(dir) }, gateSteps(pack).objections) !== null;
}

// ---- one recording: stage B's computation again ---------------------------------------------

export interface Recomputed {
  runs: PackRuns;
  /** scoreGate's verdict with these params (OTHER left out). */
  verdict: Verdict;
  /** verdict.md's text of that verdict, headed as computed by npm run confirm, not by stage B. */
  rowsText: string;
  /** Problems when it differs from stage B's verdict.json; null when there is none to compare with these params. */
  differences: string[] | null;
}

/** verdict.json paths where two verdicts differ, OTHER left out (confirm never runs T and M). */
export function verdictDifferences(a: Verdict, b: Verdict): string[] {
  const strip = (v: Verdict): Record<string, unknown> => ({ ...v, other: null });
  return sameJson(strip(a), strip(b)) ? [] : jsonDiffPaths(strip(a), strip(b), 12);
}

/** The five rows in verdict.md's layout (analysis/gate/verdict-text.ts), headed as confirm's own scoring. */
export function confirmRowsText(v: Verdict, text: string): string {
  const head = `GATE ROWS ${v.id} pack ${v.pack} | scored by npm run confirm with stage B's function, not by stage B | params ${v.params_sha256.slice(0, 8)}`;
  return [head, ...text.split('\n').slice(1)].join('\n');
}

/**
 * Runs stage B's computation on one recording (analysis/gate/stage-b.ts runStageB, without its
 * writes): the same files, checked again as stage B checks them (inspectPack checked them before
 * any recording was loaded), and scoreGate with `params`. With the params stage B used, the
 * verdict must be the one it wrote. The lips rival G also runs at every theta_G of the grid, for
 * the exploratory line of section 6.5, wired as scoreGate wires it.
 */
export function recomputePack(rec: ScoredRecord, params: RetunedParams, env: NodeJS.ProcessEnv): Recomputed {
  const what = `pack ${rec.pack} (${rec.id})`;
  return forRecording(what, () => {
    const s = loadGateSession(rec.dir, env);
    requireInputsWhole(s);
    requireRecordedHashes(rec.ledger.records, s.dir, [SESSION_FILES.calib, ONSETS_FILE, CLOCK_REPORT_FILE]);
    const layout = gateLayout(s);
    const lrt = lrtUseFrom(s.calib?.L_rt_ms);
    const sign = signOf(s);
    const sniffRecount = recountSniffLag(s, layout.gate, coreLrtOf(s.calib!.L_rt_ms!), sign);
    const onsets = readValidJson(s.dir, ONSETS_FILE, validateOnsets);
    requireLabelsHash(onsets, rec.ledger.records);
    const report = readValidJson(s.dir, CLOCK_REPORT_FILE, validateClockReport);
    const inputs = s.detectorIn as unknown as DetectorInput[];
    const nArrBySeq = nArrMapFromStamps(s.stamps);
    const cues = scoredCues(s, layout);
    const resetSeqs = gResetSeqs(inputs, s.samples).seqs;
    const score = scoreGate({
      id: s.id,
      pack: layout.pack,
      run: rec.stageB?.verdict.run ?? 1,
      paramsSha256: params.sha256,
      frozen: params.value,
      sign,
      lrt,
      inputs,
      nArrBySeq,
      resetSeqs,
      nCut: layout.nCut,
      listening: layout.listening,
      scored: layout.scored,
      cues,
      onsets: onsets.events,
      calib: s.calib,
      onsetP90Ms: report.onset?.p90_abs_auto_minus_manual_ms ?? null,
      criterionMet: params.criterionMet,
      sniffRecount,
      skipOther: true,
    });
    const invalidCodes = d1ParamsFromFrozen(params.value).invalid_codes;
    // G at another theta_G, as scoreGate runs it for its own exploratory line (analysis/gate/score.ts).
    const frozen = params.value as FrozenParamsLike;
    const setup: RunSetup = { frozen, sign, variant: variantOf(params.value) };
    const gs = gSettingsOf(params.value);
    const lipPoints = lipBaselines(inputs, nArrBySeq, { baselineS: gs.baselineS, resetWaitS: gs.resetWaitS, resetSeqs });
    const gAt = (thetaG: number): DetectorRun => runG(inputs, nArrBySeq, setup, { thetaG, frames: gs.frames, points: lipPoints, invalidCodes });
    const runs: PackRuns = {
      id: s.id,
      pack: layout.pack,
      lrt,
      scored: layout.scored,
      cues,
      onsets: onsets.events,
      ctx: { trace: traceTimeline(inputs, nArrBySeq), codes: codeTimeline(inputs, nArrBySeq, invalidCodes) },
      replies: score.replies,
      d1: score.runs.d1,
      g: score.runs.g,
      gAt,
      thetaG: params.thetaG,
    };
    const differences = rec.stageB !== null && rec.stageB.verdict.params_sha256 === params.sha256 ? verdictDifferences(score.verdict, rec.stageB.verdict) : null;
    const rowsText = confirmRowsText(score.verdict, verdictMarkdown(score.verdict, 1, { sniff: score.sniff }));
    return { runs, verdict: score.verdict, rowsText, differences };
  });
}
