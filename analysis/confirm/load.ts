// What npm run confirm reads (PREREG.md section 11): params/frozen.json as the retune froze it,
// and each gate recording with the files its steps wrote, every one checked against ledger.jsonl
// before anything is computed. A recording of pack B or C enters in one of three ways:
//   counts   GOOD RECORDING and a valid clock check: stage B scored it, and its verdict.json is
//            the one stage B's computation run again must give;
//   content  quickcheck failed on condition 6 alone (voice after fewer than 12 cues, which is not
//            technical, PREREG section 7.4): stage A and stage B do not score such a recording,
//            but section 11 keeps it in the pooled numbers, flagged, so confirm scores it with
//            stage B's function (analysis/gate/score.ts scoreGate) and the frozen parameters;
//   lost     a technical failure after the objection block began (4:15): not in the numbers, not
//            replaced, reported with its reason (section 11).
// A technical failure before 4:15 is not a recording of the pack: section 11 records the pack again.

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
  validateManifest,
  validateOnsets,
  validateQuickcheck,
  validateSampleLine,
  validateStampLine,
  validateVerdict,
  type Calib,
  type ClockReport,
  type FrozenParams,
  type Manifest,
  type Quickcheck,
  type Validator,
  type Verdict,
} from '../../core/schemas/index.ts';
import { recountSniffLag } from '../clocks/compute.ts';
import { frozenParamsFile } from '../lib/calib-io.ts';
import { sha256Hex } from '../lib/ledger.ts';
import { sessionDirOf, shownPath } from '../lib/paths.ts';
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
import { ConfirmRefusal } from './common.ts';
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

function readText(file: string): string | null {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw e;
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
  ledger: GateLedger;
  standing: PackStanding;
  /** quickcheck.json as the quickcheck step wrote it. */
  quickcheck: Quickcheck;
  /** Why the recording does not count (quickcheck and the clock check); empty when it counts. */
  voidReasons: string[];
  /** Hash of params/frozen.json in the confirmatory stage_a line; null when stage A has not run. */
  stageASha256: string | null;
  /** verdict.json and verdict.md of the confirmatory stage B; null when it has not run (content, lost). */
  stageB: StageBOutputs | null;
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
 * put in the ledger, and an L_rt and a trace sign in calib.json.
 */
function requireScorableFiles(dir: string, ledger: GateLedger): void {
  requireInputsWhole(inputFiles(dir));
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

/**
 * The checks of one recording before any computation: a day-one gate recording of the right pack,
 * quickcheck.json and clock_report.json as their steps wrote them, its standing (section 11), and
 * for a recording that is scored, the files stage B scores from and, once stage B has run, its
 * verdict.json and verdict.md with the hashes the ledger holds. Reads no audio.
 */
export function inspectPack(arg: string, role: PackRole, env: NodeJS.ProcessEnv): PackRecord {
  const dir = sessionDirOf(arg, env);
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) throw new ConfirmRefusal(`${arg}: no session folder ${shownPath(dir)}`);
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

  // The lines as the session loader splits them (analysis/lib/session.ts).
  const ledgerText = readText(path.join(dir, SESSION_FILES.ledger));
  const ledger = forRecording(what, () => readGateLedger(dir, ledgerText === null ? null : splitJsonlLines(ledgerText).filter((l) => l.length > 0)));
  const records = ledger.records;

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
  const base = { arg, id, dir, pack, manifest, sdkVersion: manifest.sdk?.version ?? null, startedUtc: manifest.started_utc, ledger, quickcheck: q, voidReasons };

  if (role === 'dev' && status !== 'counts') {
    throw new ConfirmRefusal(
      [`${what} does not count, so it has no numbers: --dev takes the pack A recording with GOOD RECORDING, a valid clock check and its stage B (PREREG.md sections 4, 7.4, 11):`, ...voidReasons.map((r) => `  ${r}`)].join('\n'),
    );
  }
  if (status === 'technical') {
    if (stepStart({ stamps: readStamps(dir) }, gateSteps(pack).objections) === null) {
      throw new ConfirmRefusal(
        [
          `${what} failed for a technical reason before its objection block began (4:15), so it is not the recording of pack ${pack}: by PREREG.md section 11 pack ${pack} is recorded again, and that recording is the one to give:`,
          ...voidReasons.map((r) => `  ${r}`),
        ].join('\n'),
      );
    }
    return { ...base, standing: 'lost', stageASha256: null, stageB: null };
  }

  // Stage A, then the confirmatory stage B with its verdict (sections 7.5, 11). Neither runs on a
  // recording that does not count, so a content failure normally has neither.
  const stageASha256 = forRecording(what, () => stageAParamsHash(records));
  const stageBRan = findSteps(records, 'stage_b').length > 0 || findSteps(records, 'verdict').length > 0;
  let stageB: StageBOutputs | null = null;
  if (status === 'counts' || stageASha256 !== null || stageBRan) {
    if (stageASha256 === null) throw new ConfirmRefusal(`${what}: stage A has not run (no confirmatory stage_a line in ledger.jsonl): run npm run analyze:gate -- --stage A ${id}, then stage B`);
    if (findSteps(records, 'stage_b').length === 0 || findSteps(records, 'verdict').length === 0) {
      throw new ConfirmRefusal(`${what}: stage B has not finished (no confirmatory stage_b and verdict lines in ledger.jsonl): run npm run analyze:gate -- --stage B ${id} first (PREREG.md section 7.5)`);
    }
    stageB = readStageB(what, dir, id, pack, ledger, stageASha256);
  }
  forRecording(what, () => requireScorableFiles(dir, ledger));
  return { ...base, standing: status, stageASha256, stageB };
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
export function recomputePack(rec: PackRecord, params: RetunedParams, env: NodeJS.ProcessEnv): Recomputed {
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
