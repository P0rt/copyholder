// clocks (spec 6.3, 7.12, 8.1, 8.5): the clock report of one recording. Runs after quickcheck and
// before the labelling. Writes clock_report.json (the `onset` block stays null until `label`),
// merges the clock blocks into calib.json (L_rt, camera clock; in the gate also the trace sign,
// A_ref and the sniff lag), and appends the ledger step `clocks` with the hashes of both files.
// Prints measured numbers only, in plain words.
//
//   npx tsx analysis/clocks.ts <id>    exit 0 clock check passed, 2 failed (files written), 1 refused or crashed

import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { validateCalib, validateClockReport } from '../core/schemas/index.ts';
import { clocksPlan, computeClocks, mergeCalib, reportLines, type ClocksComputation } from './clocks/compute.ts';
import { LedgerRefusal, appendLedgerNote, readJsonFile, readLedger, refusalFor, writeJsonFile, type LedgerStamp } from './clocks/ledger-io.ts';
import { gitShortCommit } from './lib/git.ts';
import { appendLedgerStep, utcSeconds } from './lib/ledger.ts';
import { REPO_ROOT, shownPath } from './lib/paths.ts';
import { SESSION_FILES, SessionLoadError, loadSession, type LoadedSession } from './lib/session.ts';

export const EXIT_OK = 0;
export const EXIT_CLOCK_CHECK_FAILED = 2;
export const EXIT_REFUSED = 1;

export const CLOCK_REPORT_FILE = 'clock_report.json';

/** Ledger note when the sniffs move the trace against the deep-breath sign (spec 7.4, 9.5). */
export const SIGN_NOTE = 'trace_sign_differs_from_sniffs';

export interface ClocksDeps {
  out?: (line: string) => void;
  env?: NodeJS.ProcessEnv;
  now?: () => Date;
  commit?: () => string | null;
  repoRoot?: string;
}

export interface ClocksRun {
  code: number;
  lines: string[];
  computation?: ClocksComputation;
  /** Why nothing was written. */
  refused?: string;
  /** SHA-256 of the files written, as in the ledger step. */
  outSha256?: Record<string, string>;
}

/** Measures one loaded session, writes its files and the ledger step, prints the report. */
export function runClocks(session: LoadedSession, deps: ClocksDeps = {}): ClocksRun {
  const lines: string[] = [];
  const out = (l: string): void => {
    lines.push(l);
    (deps.out ?? ((x: string) => console.log(x)))(l);
  };
  const refuse = (why: string): ClocksRun => {
    out(`CLOCKS DID NOT RUN for ${session.id}: ${why}`);
    return { code: EXIT_REFUSED, lines, refused: why };
  };

  const plan = clocksPlan(session.manifest);
  if ('refuse' in plan) return refuse(plan.refuse);
  let ledger;
  try {
    ledger = readLedger(session.dir, session.kind);
  } catch (e) {
    if (e instanceof LedgerRefusal) return refuse(e.message);
    throw e;
  }
  const notNow = refusalFor(ledger, 'clocks');
  if (notNow !== null) return refuse(notNow);

  const c = computeClocks(session, plan);
  const stamp: LedgerStamp = {
    utc: utcSeconds((deps.now ?? (() => new Date()))()),
    commit: (deps.commit ?? (() => gitShortCommit(deps.repoRoot ?? REPO_ROOT)))(),
  };

  let existingCalib: unknown = null;
  try {
    existingCalib = readJsonFile(session.dir, SESSION_FILES.calib);
  } catch (e) {
    out(`  ${SESSION_FILES.calib} could not be read (${(e as Error).message}); it is written anew`);
  }
  const calib = mergeCalib(existingCalib, c.calib);
  // Check both files before writing either, so a bad value leaves the folder as it was.
  const problems = [...validateClockReport(c.report).map((p) => `${CLOCK_REPORT_FILE}: ${p}`), ...validateCalib(calib).map((p) => `${SESSION_FILES.calib}: ${p}`)];
  if (problems.length > 0) throw new Error(`clocks would write invalid files:\n  ${problems.join('\n  ')}`);
  const outSha256 = {
    [SESSION_FILES.calib]: writeJsonFile(session.dir, SESSION_FILES.calib, calib, validateCalib),
    [CLOCK_REPORT_FILE]: writeJsonFile(session.dir, CLOCK_REPORT_FILE, c.report, validateClockReport),
  };
  const step = appendLedgerStep(session.dir, ledger.kind, 'clocks', { ...stamp, outSha256 });
  if (!step.appended) throw new Error(`ledger step clocks not appended: ${step.reason}`);
  if (c.gate?.signDisagrees) {
    const g = c.gate;
    const detail = `deep breaths give sign ${g.deep.calib.sign}, the sniffs move the trace the other way (median d ${g.sniffSign.medianD?.toPrecision(3) ?? 'none'}); the deep-breath sign is kept (spec 7.4)`;
    appendLedgerNote(session.dir, ledger.kind, SIGN_NOTE, detail, stamp);
  }

  const packText = c.gate ? `, pack ${c.gate.pack}` : '';
  out(`Clock report ${session.id} (${session.kind}${packText})`);
  for (const l of reportLines(c, session.sampleRateHz)) out(l);
  for (const p of session.problems.slice(0, 5)) out(`  file problem: ${p}`);
  out(`Wrote ${shownPath(path.join(session.dir, CLOCK_REPORT_FILE))} and ${SESSION_FILES.calib}; ledger step clocks appended.`);
  if (c.failures.length === 0) {
    out(c.report.trace_valid === null ? 'CLOCKS: audio valid (recorded without the camera)' : 'CLOCKS: audio valid, trace valid');
    return { code: EXIT_OK, lines, computation: c, outSha256 };
  }
  out(`CLOCKS: ${c.failures.join('; ')}. The recording does not count (spec 4.5, 9.4, 10.6).`);
  return { code: EXIT_CLOCK_CHECK_FAILED, lines, computation: c, outSha256 };
}

/** CLI: npx tsx analysis/clocks.ts <id or folder>. */
export function main(argv: readonly string[] = process.argv.slice(2), deps: ClocksDeps = {}): number {
  const id = argv.find((a) => !a.startsWith('-'));
  if (id === undefined) {
    console.log('Usage: npm run clocks -- <session id>');
    return EXIT_REFUSED;
  }
  try {
    const session = loadSession(id, { env: deps.env ?? process.env });
    return runClocks(session, deps).code;
  } catch (e) {
    // A wrong id or a missing file is the user's to fix: the message alone. Anything else: the stack.
    if (!(e instanceof SessionLoadError)) console.error(e instanceof Error ? (e.stack ?? e.message) : String(e));
    console.log(`CLOCKS DID NOT RUN: ${e instanceof Error ? e.message.split('\n')[0] : String(e)}`);
    return EXIT_REFUSED;
  }
}

const invokedDirectly = process.argv[1] !== undefined && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (invokedDirectly) process.exitCode = main();
