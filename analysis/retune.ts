// npm run retune -- <id> [--write]   tuning on pack A (PREREG §11) after stage B
//
// Reads a pack A recording after `npm run analyze:gate -- --stage B <id>` (verdict.json in the
// ledger) and params/frozen.json as stage A wrote it. With PASS the stage A set stays; otherwise the
// ladder of PREREG §7.7 and step 3 of §11 choose the set for packs B and C (analysis/gate/retune.ts).
// Writes retune-report.json and retune-report.md in the session folder, both marked as development
// data.
// --write   also writes the chosen set into params/frozen.json and its copy params/retune.json,
//           which `npm run freeze -- gate-retune` freezes before pack B (spec 8.4, 9.8). When the
//           stage A set wins (PASS, or step 3) params/frozen.json stays as stage A wrote it and
//           params/retune.json is its copy.
// Exit codes: 0 done, 1 refused (nothing written), 2 usage.

import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { nArrMapFromStamps, type DetectorInput } from '../core/detector.ts';
import { findSteps, paramsAreTuned, stageAParamsHash, validateClockReport, validateOnsets, validateVerdict, type FrozenParams, type Verdict } from '../core/schemas/index.ts';
import { gResetSeqs } from './rivals/index.ts';
import { recountSniffLag } from './clocks/compute.ts';
import { frozenParamsFile } from './lib/calib-io.ts';
import { sha256Hex } from './lib/ledger.ts';
import { SESSION_FILES } from './lib/session.ts';
import { GateRefusal, coreLrtOf, lrtUseFrom } from './gate/common.ts';
import { defaultGateDeps, type GateDeps } from './gate/deps.ts';
import { RETUNE_TAG, criterionMetOf, gSettingsOf, jsonDiffPaths, parseParamsText } from './gate/frozen.ts';
import { CLOCK_REPORT_FILE, ONSETS_FILE, readValidJson, recordingAt, requireCountedRecording, requireInputsWhole, requireLabelsHash, requireRecordedHashes } from './gate/inputs.ts';
import { readGateLedger } from './gate/ledger-guard.ts';
import {
  chosenParams,
  makeGrader,
  retuneMarkdown,
  retuneReport,
  runRetune,
  setOfParams,
  type RetuneContext,
  type RetuneOutcome,
  type RetuneSet,
  type ScoreBase,
} from './gate/retune.ts';
import { loadGateSession, signOf, stageAView } from './gate/stage-a.ts';
import { gateLayout, scoredCues } from './gate/view.ts';

export const USAGE = 'usage: npm run retune -- <id> [--write]';

/** The confirmatory verdict of stage B (analysis/gate/stage-b.ts verdictFileNames). */
export const VERDICT_FILE = 'verdict.json';
/**
 * Outputs in the session folder. Not retune.json: core/schemas/registry.ts gives every file of that
 * name the params validator, for the commands that check a whole folder, and spec 13.1 keeps the
 * name for params/retune.json.
 */
export const REPORT_JSON = 'retune-report.json';
export const REPORT_MD = 'retune-report.md';

export interface RetuneArgs {
  id: string;
  write: boolean;
}

/** Parses the command line; returns a message for a usage error. */
export function parseRetuneArgs(argv: readonly string[]): RetuneArgs | string {
  let id: string | null = null;
  let write = false;
  for (const a of argv) {
    if (a === '--write') write = true;
    else if (a.startsWith('-')) return `unknown option ${a}`;
    else if (id === null) id = a;
    else return `unexpected argument ${a}`;
  }
  if (id === null) return 'the recording id of pack A is required (e.g. gate-a)';
  return { id, write };
}

function readText(file: string): string | null {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw e;
  }
}

/** Writes through <file>.partial and a rename, so a stopped run leaves the old file or the new one. */
function writeWhole(file: string, text: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(`${file}.partial`, text);
  fs.renameSync(`${file}.partial`, file);
}

/** params/retune.json beside params/frozen.json, where stage A looks for it (stage-a.ts). */
export function retuneParamsFile(frozenFile: string): string {
  return path.join(path.dirname(frozenFile), 'retune.json');
}

export interface RetuneLoaded {
  id: string;
  dir: string;
  verdict: Verdict;
  /** params/frozen.json as stage A wrote it: text, SHA-256 and parsed value. */
  baseText: string;
  baseSha256: string;
  base: FrozenParams & Record<string, unknown>;
  frozenFile: string;
  retuneFile: string;
  ctx: RetuneContext;
}

/**
 * A pack A recording after stage B, with the checks stage B makes on its inputs (spec 8.1, 8.5):
 * whole input files, the files of earlier steps and verdict.json as the ledger holds them, the
 * labels the label step hashed, and params/frozen.json with the hash stage A put in the ledger.
 */
export function loadRetune(id: string, deps: GateDeps): RetuneLoaded {
  const s = loadGateSession(id, deps.env);
  const layout = gateLayout(s);
  if (layout.pack !== 'A') {
    throw new GateRefusal(
      `the tuning runs on pack A only (PREREG §11); ${s.id} is pack ${layout.pack}, which confirms: its stage A only checks params/frozen.json against params/retune.json`,
    );
  }
  const ledger = readGateLedger(s.dir, s.ledgerLines);
  if (findSteps(ledger.records, 'verdict').length === 0) {
    throw new GateRefusal(`ledger.jsonl of ${s.id} has no verdict step: run stage B first (npm run analyze:gate -- --stage B ${s.id}); the tuning starts from the verdict of pack A (PREREG §11)`);
  }
  requireInputsWhole(s);
  requireRecordedHashes(ledger.records, s.dir, [SESSION_FILES.calib, ONSETS_FILE, CLOCK_REPORT_FILE, VERDICT_FILE]);
  requireCountedRecording(ledger.records, recordingAt(s), false);
  const verdict = readValidJson(s.dir, VERDICT_FILE, validateVerdict);
  const onsets = readValidJson(s.dir, ONSETS_FILE, validateOnsets);
  requireLabelsHash(onsets, ledger.records);
  const report = readValidJson(s.dir, CLOCK_REPORT_FILE, validateClockReport);

  // params/frozen.json as stage A wrote it (spec 8.5): the hash of the stage_a step.
  const frozenFile = frozenParamsFile(deps.env);
  const retuneFile = retuneParamsFile(frozenFile);
  const baseText = readText(frozenFile);
  if (baseText === null) throw new GateRefusal(`${frozenFile} does not exist: the tuning starts from params/frozen.json as stage A wrote it`);
  const staged = stageAParamsHash(ledger.records);
  if (staged === null) throw new GateRefusal('the ledger has no stage_a step with the hash of params/frozen.json (spec 8.5)');
  const baseSha256 = sha256Hex(baseText);
  if (baseSha256 !== staged) {
    const retuneText = readText(retuneFile);
    const parsedRetune = retuneText === null ? null : parseParamsText(retuneText, 'params/retune.json').value;
    const parsedFrozen = parseParamsText(baseText, 'params/frozen.json').value;
    if (parsedRetune !== null && parsedFrozen !== null && jsonDiffPaths(parsedRetune, parsedFrozen).length === 0) {
      throw new GateRefusal(
        `params/frozen.json already holds the tuned set: it equals params/retune.json, not the file stage A wrote (ledger ${staged.slice(0, 8)}). The copy never changes once written (spec 9.8); to run the tuning again, put params/frozen.json back as stage A wrote it (SHA-256 ${staged})`,
      );
    }
    throw new GateRefusal(`params/frozen.json changed since stage A (ledger ${staged.slice(0, 8)}, file ${baseSha256.slice(0, 8)}): the tuning starts from the set stage A froze (spec 8.5)`);
  }
  if (verdict.params_sha256 !== staged) {
    throw new GateRefusal(`verdict.json was scored with params ${verdict.params_sha256.slice(0, 8)}, not the ${staged.slice(0, 8)} stage A froze (spec 8.5)`);
  }
  const parsed = parseParamsText(baseText, 'params/frozen.json');
  if (parsed.value === null) throw new GateRefusal(parsed.problems.join('\n'));
  const base = parsed.value as FrozenParams & Record<string, unknown>;
  if (!paramsAreTuned(base)) throw new GateRefusal('params/frozen.json has no k or theta_G: run stage A first');
  const criterionMet = criterionMetOf(base, 'params/frozen.json');

  // What stage B scores (stage-b.ts) and what stage A saw (stage-a.ts), from the same files.
  const lrt = lrtUseFrom(s.calib?.L_rt_ms);
  const sign = signOf(s);
  const inputs = s.detectorIn as unknown as DetectorInput[];
  const score: ScoreBase = {
    id: s.id,
    pack: layout.pack,
    sign,
    lrt,
    inputs,
    nArrBySeq: nArrMapFromStamps(s.stamps),
    resetSeqs: gResetSeqs(inputs, s.samples).seqs,
    nCut: layout.nCut,
    listening: layout.listening,
    scored: layout.scored,
    cues: scoredCues(s, layout),
    onsets: onsets.events,
    calib: s.calib,
    onsetP90Ms: report.onset?.p90_abs_auto_minus_manual_ms ?? null,
    sniffRecount: recountSniffLag(s, layout.gate, coreLrtOf(s.calib!.L_rt_ms!), sign),
  };
  const view = stageAView(s);
  return {
    id: s.id,
    dir: s.dir,
    verdict,
    baseText,
    baseSha256,
    base,
    frozenFile,
    retuneFile,
    ctx: { base, criterionMet, score, listening: { inputs: view.inputs, nArrBySeq: view.nArrBySeq, resetSeqs: view.resets.seqs, span: view.listening } },
  };
}

/**
 * The stage A set graded again must give what stage A and stage B gave: its theta_G by the budget,
 * and the rows and verdict of verdict.json. A difference means the inputs or the scoring changed
 * since, and nothing chosen from them would be the tuning PREREG §11 describes.
 */
export function requireStageAReproduced(o: RetuneOutcome, l: Pick<RetuneLoaded, 'verdict' | 'base'>): void {
  const a = o.candidates[0]!;
  const thetaG = gSettingsOf(l.base).thetaG;
  if (a.thetaG.thetaG !== thetaG) {
    throw new GateRefusal(`the budget of PREREG §6.4 gives the stage A set theta_G ${a.thetaG.thetaG.toFixed(4)}, but params/frozen.json holds ${String(thetaG)}: the listening block no longer reads as it did at stage A`);
  }
  const diff = [
    ...jsonDiffPaths(l.verdict.rows, a.verdict.rows).map((p) => `rows.${p}`),
    ...jsonDiffPaths(l.verdict.events, a.verdict.events).map((p) => `events.${p}`),
    ...(l.verdict.verdict === a.verdict.verdict ? [] : ['verdict']),
  ];
  if (diff.length > 0) {
    throw new GateRefusal(`the stage A set graded again differs from verdict.json at ${diff.join(', ')}: the recording, the labels or the scoring changed since stage B, so nothing is tuned`);
  }
}

export interface RetuneRun {
  outcome: RetuneOutcome;
  stageA: RetuneSet;
  report: Record<string, unknown>;
  markdown: string;
  jsonPath: string;
  mdPath: string;
  /** What --write puts (or would put) in params/frozen.json and params/retune.json. */
  paramsText: string;
  /** Files written under params/ by this run. */
  written: string[];
}

export function runRetuneCommand(o: { id: string; write: boolean; deps: GateDeps }): RetuneRun {
  const { deps } = o;
  const l = loadRetune(o.id, deps);
  const stageA = setOfParams(l.base);
  const outcome = runRetune(stageA, makeGrader(l.ctx));
  requireStageAReproduced(outcome, l);
  const chosen = chosenParams(outcome, l.base, l.baseText);
  const paramsText = chosen.text;

  const written: string[] = [];
  if (o.write) {
    // The copy never changes once written, and never after its tag (spec 8.4, 9.8, 13.6).
    const existing = readText(l.retuneFile);
    if (existing !== null && existing !== paramsText) {
      throw new GateRefusal(`${l.retuneFile} exists and holds another set: the copy never changes once written (spec 9.8); nothing was written`);
    }
    const tagged = deps.tagFile(RETUNE_TAG, l.retuneFile);
    if (tagged !== null && tagged !== paramsText) {
      throw new GateRefusal(`params/retune.json is frozen under the tag ${RETUNE_TAG} with another set: a tag never moves (spec 8.4); nothing was written`);
    }
    writeWhole(l.retuneFile, paramsText);
    written.push(l.retuneFile);
    if (!chosen.stageAFile) {
      writeWhole(l.frozenFile, paramsText);
      written.push(l.frozenFile);
    }
  }

  // In place: params/frozen.json and its copy hold the chosen set (the stage A file when it won).
  const inPlace = readText(l.retuneFile) === paramsText && readText(l.frozenFile) === paramsText;
  const meta = {
    id: l.id,
    verdict: l.verdict.verdict,
    stageAParamsSha256: l.baseSha256,
    chosenParamsSha256: sha256Hex(paramsText),
    stageAFile: chosen.stageAFile,
    tuned: chosen.tuned,
    written: inPlace,
  };
  const report = retuneReport(outcome, stageA, meta);
  const markdown = retuneMarkdown(outcome, stageA, meta);
  const jsonPath = path.join(l.dir, REPORT_JSON);
  const mdPath = path.join(l.dir, REPORT_MD);
  writeWhole(jsonPath, `${JSON.stringify(report, null, 2)}\n`);
  writeWhole(mdPath, markdown);

  for (const line of markdown.trimEnd().split('\n')) deps.log(line);
  deps.log(`retune: wrote ${jsonPath} and ${REPORT_MD}`);
  if (chosen.stageAFile && o.write) deps.log(`retune: params/frozen.json stays as stage A wrote it; ${l.retuneFile} is its copy`);
  else if (o.write) deps.log(`retune: wrote ${l.frozenFile} and its copy ${l.retuneFile}`);
  if (o.write) deps.log(`retune: next, commit both files and run npm run freeze -- ${RETUNE_TAG}, then push the tag before pack B is recorded (PREREG §11)`);
  return { outcome, stageA, report, markdown, jsonPath, mdPath, paramsText, written };
}

export async function main(argv: readonly string[], deps: GateDeps = defaultGateDeps()): Promise<number> {
  const args = parseRetuneArgs(argv);
  if (typeof args === 'string') {
    deps.error(`${args}\n${USAGE}`);
    return 2;
  }
  try {
    runRetuneCommand({ id: args.id, write: args.write, deps });
    return 0;
  } catch (e) {
    if (e instanceof GateRefusal) {
      deps.error(`retune refused: ${e.message}`);
      return 1;
    }
    throw e;
  }
}

const invokedDirectly = process.argv[1] !== undefined && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (invokedDirectly) {
  main(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (e: unknown) => {
      process.stderr.write(`retune failed: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}\n`);
      process.exitCode = 1;
    },
  );
}
