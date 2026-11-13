// Stage A of analyze:gate (spec 9.5 step 4): reads only the recording before the objection block
// (4:15), tunes k of D1 and theta_G of G on the listening block, writes params/frozen.json (the
// gate-prereg file with k, theta_G and "tuned" filled in) and the ledger step stage_a with the
// file's hash. After a retune (params/retune.json present) it tunes nothing and only compares
// params/frozen.json with that frozen copy (spec 9.8).

import fs from 'node:fs';
import path from 'node:path';
import { d1ParamsFromFrozen, type DetectorInput, type FrozenParamsLike, type Sign } from '../../core/detector.ts';
import { gResetSeqs, type GResets } from '../rivals/index.ts';
import { frozenParamsFile } from '../lib/calib-io.ts';
import { sha256Hex, utcSeconds } from '../lib/ledger.ts';
import { SESSION_FILES, SessionLoadError, loadSession, type LoadedSession } from '../lib/session.ts';
import { gateSteps } from '../lib/steps.ts';
import { GateRefusal, exploratoryTag } from './common.ts';
import type { GateDeps } from './deps.ts';
import { PREREG_TAG, RETUNE_TAG, checkPrereg, checkRetune, frozenParamsText, frozenWithTuning, gSettingsOf, parseParamsText, variantOf } from './frozen.ts';
import { recordingAt, requireCountedRecording, requireInputsBeforeCut, requireRecordedHashes, withStampProblems } from './inputs.ts';
import { finishInterruptedRun, prepareGateSteps, readGateLedger, requireStep, stageARuns, writeGateRun } from './ledger-guard.ts';
import { tuneStageA, type StageATuning } from './tune.ts';
import { arrivalsBefore, cutOf, detectorInBefore, gatePackOfSession, samplesBefore } from './view.ts';

export { RETUNE_TAG };

/** The name stage A gives params/frozen.json in ledger.jsonl (spec 8.5). */
export const FROZEN_NAME = 'params/frozen.json';

export interface StageAOptions {
  id: string;
  exploratory: boolean;
  deps: GateDeps;
}

export interface StageAOutcome {
  /** File written (params/frozen.json, or the exploratory copy in the session folder); null after a retune. */
  written: string | null;
  paramsSha256: string;
  tuning: StageATuning | null;
  retune: boolean;
  ledgerLine: string;
}

export function loadGateSession(id: string, env: NodeJS.ProcessEnv): LoadedSession {
  try {
    return loadSession(id, { env });
  } catch (e) {
    if (e instanceof SessionLoadError) throw new GateRefusal(e.message);
    throw e;
  }
}

/** Trace sign from calib.json (spec 7.4: chosen after the recording from the cued deep breaths). */
export function signOf(s: Pick<LoadedSession, 'calib'>): Sign {
  const sign = s.calib?.polarity?.sign;
  if (sign !== 1 && sign !== -1) {
    throw new GateRefusal('calib.json has no trace sign (polarity.sign): run quickcheck and `npm run clocks -- <id>` first (spec 7.4, 9.5)');
  }
  return sign;
}

function readText(file: string): string | null {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw e;
  }
}

/** Where an output named in ledger.jsonl lives: params/frozen.json at its place, the rest in the session folder. */
export function outputFileOf(sessionDir: string, frozenFile: string): (name: string) => string {
  return (name) => (name === FROZEN_NAME ? frozenFile : path.join(sessionDir, name));
}

/**
 * The data stage A may see: every input sliced at the objections mark before any computation, after
 * a check that no line before the cut is lost or broken (lines after it are never read).
 */
export function stageAView(s: LoadedSession): {
  nCut: number;
  listening: { n0: number; n1: number };
  inputs: DetectorInput[];
  nArrBySeq: Map<number, number>;
  resets: GResets;
} {
  const gate = gateSteps(gatePackOfSession(s));
  const { nCut, listening } = withStampProblems(s, () => cutOf(s, gate));
  const nArrBySeq = arrivalsBefore(s.stamps, nCut);
  requireInputsBeforeCut(s, nCut, nArrBySeq);
  const inputs = detectorInBefore(s.detectorIn as unknown as DetectorInput[], nArrBySeq, nCut);
  const resets = gResetSeqs(inputs, samplesBefore(s.samples, nArrBySeq));
  return { nCut, listening, inputs, nArrBySeq, resets };
}

export function runStageA(o: StageAOptions): StageAOutcome {
  const { deps } = o;
  const s = loadGateSession(o.id, deps.env);
  gatePackOfSession(s);
  const ledger = readGateLedger(s.dir, s.ledgerLines);
  const frozenFile = frozenParamsFile(deps.env);
  const run = stageARuns(ledger) + 1;
  const tag = exploratoryTag('A', run, o.exploratory);
  for (const f of finishInterruptedRun(ledger, outputFileOf(s.dir, frozenFile))) deps.log(`${tag}stage A: finished the run before this one, which stopped after its ledger line: ${f}`);
  requireStep(ledger, 'stage_a', o.exploratory);
  // Spec 9.4, 9.5: a recording that does not count is not tuned on; --exploratory reads it, marked.
  for (const r of requireCountedRecording(ledger.records, recordingAt(s), o.exploratory)) deps.log(`${tag}note: this recording does not count: ${r}`);

  const retuneFile = path.join(path.dirname(frozenFile), 'retune.json');
  const frozenText = readText(frozenFile);
  const retuneText = readText(retuneFile);
  const fields = { utc: utcSeconds(deps.now()), commit: deps.commit(), exploratory: o.exploratory };

  if (retuneText !== null && !o.exploratory) {
    // Spec 9.8: on the recording after a retune nothing is tuned; frozen.json must equal its copy.
    checkRetune({ frozenText, retuneText, taggedText: deps.tagFile(RETUNE_TAG, retuneFile), tag: RETUNE_TAG });
    const sha = sha256Hex(frozenText!);
    const lines = prepareGateSteps(ledger, [{ step: 'stage_a', outSha256: { [FROZEN_NAME]: sha } }], fields);
    writeGateRun(ledger, lines, []);
    deps.log(`stage A: params/frozen.json equals params/retune.json (tag ${RETUNE_TAG}); nothing tuned (spec 9.8)`);
    deps.log(`stage A: ledger step stage_a, params ${sha.slice(0, 8)}`);
    return { written: null, paramsSha256: sha, tuning: null, retune: true, ledgerLine: lines[0]! };
  }

  // Spec 8.4: stage A starts from the file frozen under gate-prereg, never from code defaults.
  if (frozenText === null) {
    throw new GateRefusal(`${frozenFile} does not exist: build it after doctor (npx tsx tools/freeze/frozen.ts) and freeze it with \`npm run freeze -- ${PREREG_TAG}\` before the recording (spec 8.4, 9.1)`);
  }
  const parsed = parseParamsText(frozenText, FROZEN_NAME);
  if (parsed.value === null) throw new GateRefusal(parsed.problems.join('\n'));
  const base = parsed.value;
  // An exploratory run may start from params the retune ladder changed (spec 9.8); it is marked anyway.
  if (!o.exploratory) checkPrereg({ frozen: base, taggedText: deps.tagFile(PREREG_TAG, frozenFile), tag: PREREG_TAG });

  const view = stageAView(s);
  requireRecordedHashes(ledger.records, s.dir, [SESSION_FILES.calib]);
  const sign = signOf(s);
  const g = gSettingsOf(base);
  const tuning = tuneStageA({
    inputs: view.inputs,
    nArrBySeq: view.nArrBySeq,
    resetSeqs: view.resets.seqs,
    listening: view.listening,
    frozen: base as FrozenParamsLike,
    sign,
    variant: variantOf(base),
    gFrames: g.frames,
    gBaselineS: g.baselineS,
    gResetWaitS: g.resetWaitS,
    invalidCodes: d1ParamsFromFrozen(base).invalid_codes,
  });
  const frozen = frozenWithTuning(base, { k: tuning.k, criterionMet: tuning.criterionMet, thetaG: tuning.thetaG, step: 'stage_a' });
  const text = frozenParamsText(frozen);
  const sha = sha256Hex(text);

  // Exploratory runs never touch params/frozen.json (spec 9.5).
  const outName = o.exploratory ? `frozen.exploratory-${run}.json` : FROZEN_NAME;
  const written = outputFileOf(s.dir, frozenFile)(outName);
  const lines = prepareGateSteps(ledger, [{ step: 'stage_a', outSha256: { [outName]: sha } }], fields);
  writeGateRun(ledger, lines, [{ file: written, text }]);

  for (const t of tuning.kTrials) {
    deps.log(`${tag}stage A: k=${t.k.toFixed(1)} ${t.fires} fires on ${t.activeMinutes.toFixed(1)} active min${t.rate === null ? '' : ` = ${t.rate.toFixed(2)}/min`}`);
  }
  deps.log(`${tag}stage A: k=${tuning.k.toFixed(1)} (criterion ${tuning.criterionMet ? 'met' : 'not met'}), listening block only`);
  deps.log(`${tag}stage A: G budget ${tuning.gLimit} fires (D1 ${tuning.d1Fires} fires, ${tuning.d1ActiveMinutes.toFixed(1)} active min)`);
  const last = tuning.gTrials[tuning.gTrials.length - 1];
  deps.log(
    `${tag}stage A: theta_G=${tuning.thetaG.toFixed(4)} (${last ? `${last.fires} G fires` : 'no trial'}${tuning.thetaGCriterionMet ? '' : ', budget not met: largest grid value'})`,
  );
  deps.log(`${tag}stage A: wrote ${written}, ledger step stage_a${o.exploratory ? ' (exploratory)' : ''}, params ${sha.slice(0, 8)}`);
  return { written, paramsSha256: sha, tuning, retune: false, ledgerLine: lines[0]! };
}
