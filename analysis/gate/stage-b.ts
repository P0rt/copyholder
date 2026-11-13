// Stage B of analyze:gate (spec 9.5 step 5, 9.6, 9.7): opens the objection block once, writes
// sessions/<id>/verdict.md and verdict.json, then the ledger steps stage_b and verdict in the same
// run. Every later run needs --exploratory: its files and console lines are marked, its ledger
// lines too, and it never replaces the verdict.

import fs from 'node:fs';
import path from 'node:path';
import { nArrMapFromStamps, type DetectorInput } from '../../core/detector.ts';
import {
  paramsAreTuned,
  parseJson,
  stageAParamsHash,
  validateClockReport,
  validateOnsets,
  type ClockReport,
  type FrozenParams,
  type Onsets,
  type Verdict,
} from '../../core/schemas/index.ts';
import { gResetSeqs } from '../rivals/index.ts';
import { recountSniffLag } from '../clocks/compute.ts';
import { frozenParamsFile } from '../lib/calib-io.ts';
import { sha256Hex, utcSeconds } from '../lib/ledger.ts';
import { SESSION_FILES } from '../lib/session.ts';
import { GateRefusal, coreLrtOf, exploratoryTag, lrtUseFrom } from './common.ts';
import type { GateDeps } from './deps.ts';
import { criterionMetOf, parseParamsText } from './frozen.ts';
import { CLOCK_REPORT_FILE, ONSETS_FILE, recordingAt, requireCountedRecording, requireInputsWhole, requireLabelsHash, requireRecordedHashes } from './inputs.ts';
import { finishInterruptedRun, prepareGateSteps, readGateLedger, requireStep, stageBRuns, writeGateRun } from './ledger-guard.ts';
import { scoreGate, type GateScore } from './score.ts';
import { loadGateSession, outputFileOf, signOf } from './stage-a.ts';
import { verdictMarkdown } from './verdict-text.ts';
import { gateLayout, scoredCues } from './view.ts';

export { ONSETS_FILE };

export interface StageBOptions {
  id: string;
  exploratory: boolean;
  /** Exploratory runs only: score with another params file. */
  paramsFile?: string | null;
  /** Leave out the OTHER line (T and M), spec 14.4. */
  skipOther?: boolean;
  deps: GateDeps;
}

export interface StageBOutcome {
  verdict: Verdict;
  markdown: string;
  mdPath: string;
  jsonPath: string;
  ledgerLines: string[];
  score: GateScore;
}

function readOnsets(dir: string): Onsets {
  const parsed = parseJson(fs.readFileSync(path.join(dir, ONSETS_FILE), 'utf8'), validateOnsets, { file: ONSETS_FILE });
  if (parsed.value === null) throw new GateRefusal(`${ONSETS_FILE} is not valid:\n  ${parsed.errors.join('\n  ')}`);
  return parsed.value;
}

function readClockReport(dir: string): ClockReport {
  const parsed = parseJson(fs.readFileSync(path.join(dir, CLOCK_REPORT_FILE), 'utf8'), validateClockReport, { file: CLOCK_REPORT_FILE });
  if (parsed.value === null) throw new GateRefusal(`${CLOCK_REPORT_FILE} is not valid:\n  ${parsed.errors.join('\n  ')}`);
  return parsed.value;
}

/** File names of a run: the verdict itself, or marked copies for an exploratory run. */
export function verdictFileNames(run: number, exploratory: boolean): { md: string; json: string } {
  return exploratory ? { md: `verdict.exploratory-${run}.md`, json: `verdict.exploratory-${run}.json` } : { md: 'verdict.md', json: 'verdict.json' };
}

export function runStageB(o: StageBOptions): StageBOutcome {
  const { deps } = o;
  if (!o.exploratory && o.paramsFile) throw new GateRefusal('--params is for exploratory runs only: the confirmatory stage B scores params/frozen.json as stage A froze it');
  const s = loadGateSession(o.id, deps.env);
  const ledger = readGateLedger(s.dir, s.ledgerLines);
  const run = stageBRuns(ledger) + 1;
  const tag = exploratoryTag('B', run, o.exploratory);
  const say = (line: string): void => deps.log(`${tag}${line}`);
  for (const f of finishInterruptedRun(ledger, outputFileOf(s.dir, frozenParamsFile(deps.env)))) say(`stage B: finished the run before this one, which stopped after its ledger lines: ${f}`);
  requireStep(ledger, 'stage_b', o.exploratory);
  // Spec 8.1, 8.5: whole inputs, and the files of clocks and label as the journal holds them.
  requireInputsWhole(s);
  requireRecordedHashes(ledger.records, s.dir, [SESSION_FILES.calib, ONSETS_FILE, CLOCK_REPORT_FILE]);
  // Spec 9.4, 9.5: a recording that does not count is not scored; --exploratory reads it, marked.
  for (const r of requireCountedRecording(ledger.records, recordingAt(s), o.exploratory)) say(`note: this recording does not count: ${r}`);
  const layout = gateLayout(s);

  // Params: the file stage A froze, unchanged since (spec 8.5, 9.5).
  const paramsPath = o.paramsFile ? path.resolve(o.paramsFile) : frozenParamsFile(deps.env);
  let paramsText: string;
  try {
    paramsText = fs.readFileSync(paramsPath, 'utf8');
  } catch {
    throw new GateRefusal(`${paramsPath} does not exist: run stage A first (npm run analyze:gate -- --stage A ${o.id})`);
  }
  const parsed = parseParamsText(paramsText, path.basename(paramsPath));
  if (parsed.value === null) throw new GateRefusal(parsed.problems.join('\n'));
  if (!paramsAreTuned(parsed.value as unknown as FrozenParams)) throw new GateRefusal(`${paramsPath} has no k or theta_G: run stage A first`);
  const criterionMet = criterionMetOf(parsed.value, path.basename(paramsPath));
  const paramsSha = sha256Hex(paramsText);
  const staged = stageAParamsHash(ledger.records);
  if (!o.paramsFile && staged !== paramsSha) {
    throw new GateRefusal(
      staged === null
        ? 'the ledger has no stage_a step with the hash of params/frozen.json (spec 8.5)'
        : `params/frozen.json changed since stage A (ledger ${staged.slice(0, 8)}, file ${paramsSha.slice(0, 8)}): stage B scores the frozen file only${
            o.exploratory ? '; an exploratory run can score another file with --params <file>' : ''
          }`,
    );
  }

  const lrt = lrtUseFrom(s.calib?.L_rt_ms);
  const sign = signOf(s);
  // Row 4 (spec 9.6, PREREG §4): the sniff lag recomputed as clocks computed it for calib.json.
  const sniffRecount = recountSniffLag(s, layout.gate, coreLrtOf(s.calib!.L_rt_ms!), sign);
  const onsets = readOnsets(s.dir);
  // Spec 8.5, 9.5 step 3: the labels are the ones whose hash the label step put in the ledger.
  requireLabelsHash(onsets, ledger.records);
  const report = readClockReport(s.dir);
  const inputs = s.detectorIn as unknown as DetectorInput[];
  const resets = gResetSeqs(inputs, s.samples);
  const score = scoreGate({
    id: s.id,
    pack: layout.pack,
    run,
    paramsSha256: paramsSha,
    frozen: parsed.value,
    sign,
    lrt,
    inputs,
    nArrBySeq: nArrMapFromStamps(s.stamps),
    resetSeqs: resets.seqs,
    nCut: layout.nCut,
    listening: layout.listening,
    scored: layout.scored,
    cues: scoredCues(s, layout),
    onsets: onsets.events,
    calib: s.calib,
    onsetP90Ms: report.onset?.p90_abs_auto_minus_manual_ms ?? null,
    criterionMet,
    sniffRecount,
    skipOther: o.skipOther ?? false,
  });

  // Both journal lines are checked before anything is written, then go in one append (spec 8.5).
  const names = verdictFileNames(run, o.exploratory);
  const markdown = verdictMarkdown(score.verdict, run, { sniff: score.sniff });
  const json = `${JSON.stringify(score.verdict, null, 2)}\n`;
  const mdPath = path.join(s.dir, names.md);
  const jsonPath = path.join(s.dir, names.json);
  const jsonSha = sha256Hex(json);
  const lines = prepareGateSteps(
    ledger,
    [
      { step: 'stage_b', outSha256: { [names.json]: jsonSha } },
      { step: 'verdict', outSha256: { [names.json]: jsonSha, [names.md]: sha256Hex(markdown) } },
    ],
    { utc: utcSeconds(deps.now()), commit: deps.commit(), exploratory: o.exploratory },
  );
  writeGateRun(ledger, lines, [
    { file: jsonPath, text: json },
    { file: mdPath, text: markdown },
  ]);

  for (const line of markdown.trimEnd().split('\n')) say(line);
  for (const note of score.notes) say(`note: ${note}`);
  if (resets.noFrame > 0) {
    say(
      `note: G: ${resets.noFrame} packets without a landmark frame carry g null; samples.jsonl tells them from the ${resets.flagged} reset frames (spec 8.1), so a recompute from stream.jsonl alone, where every null reads as a reset, may give other G stops`,
    );
  }
  if (resets.unknown > 0) say(`note: G: ${resets.unknown} packets with g null have no landmark field in samples.jsonl and count as resets (assumption)`);
  for (const r of score.replies) {
    if (!r.valid) say(`note: cue ${r.cue} has no valid objection: ${r.why}`);
  }
  say(`stage B: wrote ${mdPath} and ${names.json}; ledger steps stage_b and verdict${o.exploratory ? ' (exploratory)' : ''}`);
  return { verdict: score.verdict, markdown, mdPath, jsonPath, ledgerLines: lines, score };
}
