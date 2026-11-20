// quickcheck (spec 7.12, 9.4): runs after every recording and prints one verdict line on stdout,
// last, GOOD RECORDING or RE-RECORD NOW: <reason>; the per-condition report goes to stderr.
// Writes quickcheck.json and the ledger step `quickcheck` (spec 8.5). Doctor recordings get the
// doctor report, smoke recordings the smoke report. A dry run (tap's stand-in SDK, manifest.json
// dry: true) is refused before any check and nothing is written (spec 6.5). A gate run that no SDK
// measured (the mock tap) is checked as usual, but one stdout line before the verdict says that it
// is a rehearsal, not data, and what to do with its folder; when such a run of pack A, B or C fails,
// its verdict and advice say it is a rehearsal instead of what a failed recording of the pack costs
// (PREREG.md sections 7.1 and 11, analysis/lib/rehearsal.ts).
//
//   npx tsx analysis/quickcheck.ts <id>     exit 0 GOOD RECORDING, 2 RE-RECORD NOW, 1 crash

import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  findSteps,
  isLedgerKind,
  splitJsonlLines,
  toJsonText,
  validateQuickcheck,
  type Manifest,
  type Quickcheck,
} from '../core/schemas/index.ts';
import { EXIT_DOCTOR_FAIL, runDoctor, type DoctorDeps } from './doctor.ts';
import { chooseVadParams, frozenDetectorVariant, type VadChoice } from './lib/calib-io.ts';
import { isMainModule } from './lib/cli.ts';
import { DRY_RUN_NEVER_COUNTS, DRY_RUN_NOTE, isDryRun } from './lib/dry-run.ts';
import { writeFileAtomic } from './lib/files.ts';
import {
  audioContinuous,
  cuesMarked,
  d1ActiveShare,
  filesWarning,
  loopChecks,
  lrtDiffWarning,
  micFlags,
  noHardWindowEvents,
  noSdkError,
  notSentWarning,
  paBursts,
  polarity,
  sampleRate,
  sniffsFound,
  statusOkWarning,
  tapLoopWarning,
  traceRate,
  voiceAfterCues,
  windowWarnings,
  type ConditionContext,
  type ConditionResult,
  type ConditionSession,
} from './lib/conditions.ts';
import { LATER_PACKS, creditsUsedUp, nextRecordingAdvice } from './gate/inputs.ts';
import { gitShortCommit } from './lib/git.ts';
import { ledgerRecords, prepareLedgerStep, sha256Hex, utcSeconds, writeLedgerLine } from './lib/ledger.ts';
import { measureLoops } from './lib/measure.ts';
import { REPO_ROOT } from './lib/paths.ts';
import { notMeasuredWords, rehearsalAdvice, rehearsalLine, rehearsalVerdictWords } from './lib/rehearsal.ts';
import { SESSION_FILES, loadSession, stepStart, type LoadedSession } from './lib/session.ts';
import { gateSteps, gatePackOf, type GatePack } from './lib/steps.ts';

export const EXIT_GOOD = 0;
export const EXIT_RERECORD = 2;
export const EXIT_CRASH = 1;

/** Which condition set a recording gets (spec 7.12, 9.4). */
export type QuickcheckPlan =
  | { set: 'gate'; pack: GatePack }
  /** Numbers sessions and the rehearsal (with D1 active), the demo take (without). */
  | { set: 'session'; d1: boolean }
  /** Space-bar block and listening without camera: conditions 1, 2 and the audio conditions. */
  | { set: 'listening' }
  | { set: 'doctor' }
  | { set: 'smoke' }
  | { set: 'none'; why: string };

/** The condition set from manifest.json `kind` (and `pack` or `scenario` for the gate). */
export function planFor(manifest: Manifest): QuickcheckPlan {
  switch (manifest.kind) {
    case 'gate': {
      const pack = manifest.pack ?? gatePackOf(String(manifest['scenario'] ?? ''));
      return pack ? { set: 'gate', pack } : { set: 'none', why: 'the gate recording names no pack in manifest.json' };
    }
    case 'numbers':
    case 'rehearsal':
      return { set: 'session', d1: true };
    case 'demo':
      return { set: 'session', d1: false };
    case 'spacebar':
    case 'pilot':
      return { set: 'listening' };
    case 'doctor':
      return { set: 'doctor' };
    case 'smoke':
      return { set: 'smoke' };
    default:
      return { set: 'none', why: `spec 7.12 sets no quickcheck conditions for a ${manifest.kind} recording` };
  }
}

/** Hard conditions and warnings of one set, in the order of spec 9.4 (first failure is named). */
export function evaluateConditions(s: ConditionSession, plan: QuickcheckPlan, ctx: ConditionContext, problems: readonly string[] = []): ConditionResult[] {
  const loops = ctx.loops ?? measureLoops(s);
  const c: ConditionContext = { ...ctx, loops };
  const audio = [micFlags(s), sampleRate(s), noHardWindowEvents(s)];
  const traceWarnings = [notSentWarning(s), tapLoopWarning(s), statusOkWarning(s)];
  const common = [windowWarnings(s), lrtDiffWarning(s, c), filesWarning(problems)];
  switch (plan.set) {
    case 'gate': {
      const g: ConditionContext = { ...c, gate: gateSteps(plan.pack) };
      return [
        audioContinuous(s),
        loopChecks(s, g),
        cuesMarked(s, g),
        traceRate(s),
        noSdkError(s),
        voiceAfterCues(s, g),
        paBursts(s, g),
        sniffsFound(s, g),
        polarity(s, g),
        ...audio,
        ...traceWarnings,
        ...common,
      ];
    }
    case 'session':
      return [
        audioContinuous(s),
        loopChecks(s, c),
        traceRate(s),
        noSdkError(s),
        polarity(s, c),
        ...audio,
        ...(plan.d1 ? [d1ActiveShare(s, c)] : []),
        ...traceWarnings,
        ...common,
      ];
    case 'listening':
      return [audioContinuous(s), loopChecks(s, c), ...audio, ...common];
    default:
      throw new Error(`no condition set for "${plan.set}"`);
  }
}

/** Ledger steps that compute a detector (spec 9.4: a failed recording with none of them does not use up the re-record). */
const DETECTOR_STEPS = ['stage_a', 'stage_b', 'verdict', 'score'] as const;

/** True when ledger.jsonl already records a step that computed a detector. */
export function detectorComputed(ledgerLines: readonly string[] | null): boolean {
  const records = ledgerRecords(ledgerLines);
  return DETECTOR_STEPS.some((step) => findSteps(records, step).length > 0 || findSteps(records, step, { exploratory: true }).length > 0);
}

export interface QuickcheckEvaluation {
  quickcheck: Quickcheck;
  conditions: ConditionResult[];
  /** The one verdict line. */
  line: string;
  /** Report lines printed before the verdict line. */
  report: string[];
}

/** What follows a lost pack C (PREREG.md section 11). */
const PACK_B_ALONE = 'the confirmatory numbers are those of pack B alone, flagged';

/** How far a gate recording ran: the objection block (4:15) began; the SDK ended it with kCreditExhausted. */
export interface RecordingEnd {
  objectionsReached: boolean;
  creditsUsedUp: boolean;
}

/**
 * Plain words on whether the failure is technical and what it costs, the bracket of the verdict
 * line (spec 9.4, 9.6, 10.6, PREREG.md section 11). The pack-0 probe spends no pack: whatever
 * failed, it is repeated until GOOD RECORDING (spec 9.4). Pack A follows spec 9.4. Packs B and C
 * follow section 11: a technical failure before 4:15 is recorded again on the same pack, one after
 * 4:15 is lost and not replaced, and a failure on condition 6 alone stays in the pooled numbers,
 * flagged. A recording the SDK ended with kCreditExhausted is lost and not replaced, on any pack.
 */
export function technicalWords(plan: QuickcheckPlan, technical: boolean, computed: boolean, end: RecordingEnd): string {
  if (plan.set === 'gate' && end.creditsUsedUp) {
    const credits = 'the SDK credits are used up (kCreditExhausted)';
    if (plan.pack === '0') return `${credits}: nothing can be recorded until the SDK has credits again (PREREG.md section 11)`;
    return `${credits}: pack ${plan.pack} is lost and not replaced${plan.pack === 'C' ? `; ${PACK_B_ALONE}` : ''} (PREREG.md section 11)`;
  }
  if (plan.set === 'gate' && plan.pack === '0') {
    return technical
      ? 'technical failure; fix it and repeat the short probe until it gives GOOD RECORDING (spec 9.4)'
      : 'not technical; the probe spends no pack: repeat the short probe until it gives GOOD RECORDING (spec 9.4)';
  }
  if (plan.set === 'gate' && (plan.pack === 'B' || plan.pack === 'C')) {
    if (!technical) return `not technical: pack ${plan.pack} is not recorded again and stays in the pooled numbers, flagged (PREREG.md section 11)`;
    if (!end.objectionsReached) return `technical failure before 4:15: pack ${plan.pack} is recorded again (PREREG.md section 11)`;
    const later = LATER_PACKS[plan.pack];
    return `technical failure after 4:15: pack ${plan.pack} is lost and not replaced; ${later === '' ? PACK_B_ALONE : `next come one demo take and pack ${later}`} (PREREG.md section 11)`;
  }
  if (!technical) return 'not technical: the next recording is the one content re-record (spec 9.6)';
  if (plan.set !== 'gate') return 'technical failure; spec 10.6 decides on a replacement';
  return computed
    ? 'technical failure, but a detector was already computed, so it uses up the one re-record (spec 9.4)'
    : 'technical failure; this re-record is free (spec 9.4)';
}

/**
 * Failed hard conditions, technical ones first (spec order inside each group). A technical
 * failure is the cause to fix; a voice count that fails with it is usually its consequence
 * (a muted microphone hears no answers).
 */
export function failedInOrder(conditions: readonly ConditionResult[]): ConditionResult[] {
  const failed = conditions.filter((c) => c.hard && !c.ok);
  return [...failed.filter((c) => c.technical), ...failed.filter((c) => !c.technical)];
}

/**
 * Pure verdict: conditions, quickcheck.json, the printed report and the verdict line. A failed
 * gate run of pack A, B or C that no SDK measured is a rehearsal (analysis/lib/rehearsal.ts): its
 * line and advice say so, in place of what a failed recording of the pack costs (PREREG.md
 * section 11). The probe keeps its words either way.
 */
export function evaluateQuickcheck(
  s: ConditionSession & Pick<LoadedSession, 'id' | 'kind' | 'dir'>,
  plan: QuickcheckPlan,
  ctx: ConditionContext,
  opts: { problems?: readonly string[]; detectorComputed?: boolean } = {},
): QuickcheckEvaluation {
  const conditions = evaluateConditions(s, plan, ctx, opts.problems ?? []);
  const failed = failedInOrder(conditions);
  // Spec 9.4: a recording that failed for a technical reason did not take place. Condition 6 alone
  // is not technical; with a technical failure beside it the recording still failed technically.
  const technical = failed.length === 0 ? null : failed.some((c) => c.technical);
  const quickcheck: Quickcheck = {
    schema: 'quickcheck/1',
    id: s.id,
    kind: s.kind,
    result: failed.length === 0 ? 'GOOD RECORDING' : 'RE-RECORD NOW',
    reasons: failed.map((c) => c.reason),
    technical,
    checks: conditions.map((c) => {
      const check: Quickcheck['checks'][number] = { name: c.name, ok: c.ok, hard: c.hard, value: c.value, detail: c.detail ? `${c.reason}; ${c.detail}` : c.reason };
      if (c.limit !== undefined) check.limit = c.limit;
      return check;
    }),
  };
  const report = [
    `Quickcheck ${s.id} (${s.kind}${plan.set === 'gate' ? `, pack ${plan.pack}` : ''})`,
    ...conditions.map((c) => `  ${c.ok ? 'ok  ' : c.hard ? 'FAIL' : 'warn'}  ${c.name}: ${c.reason}`),
  ];
  let line: string;
  if (failed.length === 0) {
    const flag = conditions.find((c) => c.name === 'L_rt_diff' && !c.ok);
    line = flag ? `GOOD RECORDING (flagged: loop checks A and B differ by ${Number(flag.value).toFixed(1)} ms)` : 'GOOD RECORDING';
  } else {
    const more = failed.length > 1 ? ` (and ${failed.length - 1} more)` : '';
    // The same facts as analyze:gate's refusal (analysis/gate/inputs.ts recordingAt), so both give the same advice.
    const end: RecordingEnd = {
      objectionsReached: plan.set === 'gate' && plan.pack !== '0' && stepStart(s, gateSteps(plan.pack).objections) !== null,
      creditsUsedUp: plan.set === 'gate' && creditsUsedUp(s.events),
    };
    const computed = opts.detectorComputed ?? false;
    // A run of pack A, B or C that no SDK measured is no recording of the pack, so it is neither
    // recorded again, nor lost, nor kept in the numbers: analyze:gate refuses it in the same words.
    const rehearsal = plan.set === 'gate' && plan.pack !== '0' && notMeasuredWords(s.manifest) !== null ? plan.pack : null;
    const words = rehearsal !== null ? rehearsalVerdictWords(rehearsal) : technicalWords(plan, technical === true, computed, end);
    line = `RE-RECORD NOW: ${failed[0]!.reason}${more} [${words}]`;
    if (failed.length > 1) report.push(`Failed hard conditions, technical ones first: ${failed.map((c) => c.name).join(', ')}.`);
    if (rehearsal !== null) {
      report.push(rehearsalAdvice(s, rehearsal));
    } else if (plan.set === 'gate' && plan.pack === '0') {
      report.push(
        end.creditsUsedUp
          ? 'The SDK ended the probe with kCreditExhausted, so its credits are used up: neither the probe nor a pack can be recorded until the SDK has credits again (PREREG.md section 11).'
          : 'Fix the cause and repeat the probe (npm run gate -- --pack 0) until it gives GOOD RECORDING (spec 9.4).',
      );
    } else if (plan.set === 'gate' && plan.pack !== '0') {
      report.push(nextRecordingAdvice({ technical: technical === true, pack: plan.pack, objectionsReached: end.objectionsReached, detectorComputed: computed, creditsUsedUp: end.creditsUsedUp }));
    }
  }
  return { quickcheck, conditions, line, report };
}

/**
 * The one verdict line for a dry run (spec 6.5), in the format of the report the kind gets:
 * DOCTOR FAIL: for a doctor recording, RE-RECORD NOW: for every other kind.
 */
export function dryRunLine(plan: QuickcheckPlan): string {
  return plan.set === 'doctor' ? `DOCTOR FAIL: ${DRY_RUN_NEVER_COUNTS}` : `RE-RECORD NOW: ${DRY_RUN_NEVER_COUNTS}`;
}

// ---- running it ------------------------------------------------------------------------------------

export interface QuickcheckDeps {
  /**
   * stdout: the one verdict line, last (and the doctor report, which ends with its own one line);
   * before it, for a gate run no SDK measured, the line that says it is a rehearsal.
   */
  out?: (line: string) => void;
  /** stderr: the per-condition report and the ledger note, so stdout keeps the verdict for its last line (spec 7.12). */
  log?: (line: string) => void;
  env?: NodeJS.ProcessEnv;
  now?: () => Date;
  commit?: () => string | null;
  /** Voice detector parameters; undefined: chosen from params/frozen.json or the latest doctor. */
  vad?: VadChoice | null;
  /** The confirming detector (D1 or D3); undefined: the one params/frozen.json names. */
  detector?: string;
  /** Passed on to the doctor report. */
  doctor?: DoctorDeps;
  repoRoot?: string;
}

export interface QuickcheckRun {
  code: number;
  /** What went to stdout. */
  lines: string[];
  evaluation?: QuickcheckEvaluation;
}

async function runSmokeReport(session: LoadedSession, root: string, out: (l: string) => void, env: NodeJS.ProcessEnv): Promise<number> {
  const file = path.join(root, 'analysis', 'smoke.ts');
  if (!fs.existsSync(file)) {
    out(`The smoke report is not built yet (analysis/smoke.ts is missing); the recording is in ${session.dir}.`);
    return EXIT_GOOD;
  }
  const mod = (await import(pathToFileURL(file).href)) as {
    runSmoke?: (s: LoadedSession, o: { out: (l: string) => void; env: NodeJS.ProcessEnv }) => unknown;
  };
  if (typeof mod.runSmoke !== 'function') {
    out('analysis/smoke.ts has no runSmoke(session); the smoke report did not run.');
    return EXIT_CRASH;
  }
  const r = await mod.runSmoke(session, { out, env });
  if (typeof r === 'number') return r;
  if (r && typeof r === 'object' && typeof (r as { code?: unknown }).code === 'number') return (r as { code: number }).code;
  return EXIT_GOOD;
}

/**
 * Checks one loaded session and prints the report. Writes quickcheck.json and appends the
 * ledger step for record kinds with a ledger. Returns the exit code.
 */
export async function runQuickcheck(session: LoadedSession, deps: QuickcheckDeps = {}): Promise<QuickcheckRun> {
  const lines: string[] = [];
  const out = (l: string): void => {
    lines.push(l);
    (deps.out ?? ((x: string) => console.log(x)))(l);
  };
  const log = deps.log ?? ((x: string) => console.error(x));
  const env = deps.env ?? process.env;
  const plan = planFor(session.manifest);

  // The smoke report refuses a dry run itself (SMOKE FAIL); every other kind is refused here,
  // before any check, and nothing is written into the folder (spec 6.5).
  if (plan.set !== 'smoke' && isDryRun(session.manifest)) {
    log(DRY_RUN_NOTE);
    out(dryRunLine(plan));
    return { code: plan.set === 'doctor' ? EXIT_DOCTOR_FAIL : EXIT_RERECORD, lines };
  }
  if (plan.set === 'doctor') {
    const r = await runDoctor(session, { out, env, ...deps.doctor });
    return { code: r.code, lines };
  }
  if (plan.set === 'smoke') return { code: await runSmokeReport(session, deps.repoRoot ?? REPO_ROOT, out, env), lines };
  if (plan.set === 'none') {
    out(`No quickcheck for ${session.id}: ${plan.why}.`);
    return { code: EXIT_GOOD, lines };
  }

  const vad = deps.vad === undefined ? chooseVadParams(env) : deps.vad;
  const ctx: ConditionContext = { ...(vad ? { vad: vad.params, vadSource: vad.source } : {}), detector: deps.detector ?? frozenDetectorVariant(env) };
  const evaluation = evaluateQuickcheck(session, plan, ctx, {
    problems: session.problems,
    detectorComputed: detectorComputed(session.ledgerLines),
  });
  const problems = validateQuickcheck(evaluation.quickcheck);
  if (problems.length > 0) throw new Error(`quickcheck.json would be invalid: ${problems.join('; ')}`);
  const text = toJsonText(evaluation.quickcheck, null);
  for (const l of evaluation.report) log(l);
  log(writeQuickcheckFile(session, text, deps));
  // PREREG.md section 11: a gate run no SDK measured keeps its verdict, and one line before it
  // says that it is a rehearsal, which clocks, label and analyze:gate refuse, and what to do next.
  const rehearsal = plan.set === 'gate' ? rehearsalLine(session, plan.pack) : null;
  if (rehearsal !== null) out(rehearsal);
  out(evaluation.line);
  return { code: evaluation.quickcheck.result === 'GOOD RECORDING' ? EXIT_GOOD : EXIT_RERECORD, lines, evaluation };
}

/**
 * Writes quickcheck.json and appends the ledger step `quickcheck` (spec 8.5). The ledger is asked
 * first: when it refuses the step (quickcheck re-run after `clocks`), a quickcheck.json whose hash
 * the ledger already holds is left as it is, so file and ledger keep matching. Returns the note.
 */
export function writeQuickcheckFile(session: Pick<LoadedSession, 'dir' | 'kind'>, text: string, deps: Pick<QuickcheckDeps, 'now' | 'commit' | 'repoRoot'> = {}): string {
  const file = path.join(session.dir, SESSION_FILES.quickcheck);
  if (!isLedgerKind(session.kind)) {
    writeFileAtomic(file, text);
    return 'quickcheck.json written (this record kind has no ledger).';
  }
  const prepared = prepareLedgerStep(session.dir, session.kind, 'quickcheck', {
    utc: utcSeconds((deps.now ?? (() => new Date()))()),
    commit: (deps.commit ?? (() => gitShortCommit(deps.repoRoot ?? REPO_ROOT)))(),
    outSha256: { [SESSION_FILES.quickcheck]: sha256Hex(text) },
  });
  if (prepared.line !== null) {
    writeFileAtomic(file, text);
    writeLedgerLine(session.dir, prepared.line);
    return 'Ledger: step quickcheck appended.';
  }
  const lines = fs.existsSync(path.join(session.dir, SESSION_FILES.ledger)) ? ledgerLinesOf(session.dir) : [];
  if (findSteps(ledgerRecords(lines), 'quickcheck').length > 0) {
    return `Ledger: not appended (${prepared.reason}); quickcheck.json left as it was, so it still matches the ledger.`;
  }
  writeFileAtomic(file, text);
  return `Ledger: not appended (${prepared.reason}).`;
}

/** CLI: npx tsx analysis/quickcheck.ts <id or folder>. */
export async function main(argv: readonly string[] = process.argv.slice(2)): Promise<number> {
  const id = argv.find((a) => !a.startsWith('-'));
  if (id === undefined) {
    console.log('Usage: npm run quickcheck -- <session id>');
    return EXIT_CRASH;
  }
  try {
    const session = loadSession(id, { detectorIn: false });
    return (await runQuickcheck(session)).code;
  } catch (e) {
    console.error(e instanceof Error ? (e.stack ?? e.message) : String(e));
    console.log(`QUICKCHECK DID NOT RUN: ${e instanceof Error ? e.message.split('\n')[0] : String(e)}`);
    return EXIT_CRASH;
  }
}

if (isMainModule(import.meta.url)) {
  main().then(
    (code) => {
      process.exitCode = code;
    },
    (e: unknown) => {
      console.error(e);
      process.exitCode = EXIT_CRASH;
    },
  );
}

/** Lines of ledger.jsonl (for tests and tools). */
export function ledgerLinesOf(dir: string): string[] {
  try {
    return splitJsonlLines(fs.readFileSync(path.join(dir, 'ledger.jsonl'), 'utf8')).filter((l) => l.length > 0);
  } catch {
    return [];
  }
}
