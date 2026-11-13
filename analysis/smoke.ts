// Smoke report (spec 7.12): the ten first-day questions answered from one smoke session folder,
// with the numbers behind each answer, then exactly one verdict line, SMOKE OK or
// SMOKE FAIL: <reason>. Writes smoke_report.json into the folder. Reads session files only;
// it never loads the SDK.
//
//   npx tsx analysis/smoke.ts [<id or folder>] [--credits <before>,<after>]
//
// Without an id it takes the newest smoke session. Exit codes follow analysis/quickcheck.ts, which
// calls runSmoke() for smoke recordings: 0 SMOKE OK, 2 SMOKE FAIL, 1 when nothing could be read.
// A dry run (tap's stand-in SDK, manifest.json dry: true) is refused: SMOKE FAIL, nothing written
// (spec 6.5).

import { existsSync, realpathSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { SAMPLE_RATE_HZ } from '../core/clock/index.ts';
import { DRY_RUN_NOTE, DRY_RUN_REASON, isDryRun } from './lib/dry-run.ts';
import { sessionDirOf, sessionsDir, shownPath } from './lib/paths.ts';
import { latestSession, loadSession, type LoadedSession } from './lib/session.ts';
import { balancesFromReport, parseCreditBalances, type CreditBalances } from './smoke/answers-run.ts';
import { buildContext } from './smoke/context.ts';
import { readSessionFolder } from './smoke/read.ts';
import { buildSmokeReport, SMOKE_REPORT_FILE, SMOKE_REPORT_SCHEMA, verdictLine, writeSmokeReport } from './smoke/report.ts';

/**
 * The session to report on: what analysis/lib/session.ts loadSession() returns (only dir, id,
 * sampleRateHz and problems are used), or a session id or folder path.
 */
export type SmokeSession = string | (Pick<LoadedSession, 'dir'> & Partial<Pick<LoadedSession, 'id' | 'sampleRateHz' | 'problems'>>);

export interface SmokeOptions {
  /**
   * Balances read on the developer portal before and after the run (spec 11.5), as "100,94.6" or
   * an object. A blank keeps the balance of an earlier smoke_report.json in the folder.
   */
  credits?: string | Partial<CreditBalances>;
  /** Print the report to stdout, the verdict line last (default true). */
  print?: boolean;
  /** Write smoke_report.json into the session folder (default true). */
  write?: boolean;
  /** Where printed lines go (default console.log). */
  out?: (line: string) => void;
  env?: NodeJS.ProcessEnv;
  /** Why analysis/lib/session.ts could not load the folder, when the caller tried (shown in the report). */
  loadError?: string | null;
}

/** Exit codes of analysis/quickcheck.ts: 0 good, 2 re-record (here SMOKE FAIL), 1 crash or nothing to read. */
export const SMOKE_EXIT = { ok: 0, fail: 2, error: 1 } as const;

export interface SmokeResult {
  ok: boolean;
  /** Exit code for analysis/quickcheck.ts and the command line: 0 SMOKE OK, 2 SMOKE FAIL. */
  code: number;
  /** SMOKE OK, or SMOKE FAIL: <reasons>. */
  verdict: string;
  reasons: string[];
  /** The printed report; its last line is the verdict. */
  text: string;
  /** smoke_report.json content. */
  report: Record<string, unknown>;
  /** Path of smoke_report.json; null when it was not written. */
  reportPath: string | null;
}

const positive = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v > 0;

function balancesOf(given: SmokeOptions['credits'], earlier: CreditBalances): CreditBalances {
  if (given === undefined) return earlier;
  let typed: Partial<CreditBalances>;
  if (typeof given === 'string') {
    const parsed = parseCreditBalances(given);
    if (typeof parsed === 'string') throw new Error(`--credits: ${parsed}`);
    typed = parsed;
  } else {
    typed = given;
  }
  return { before: typed.before ?? earlier.before, after: typed.after ?? earlier.after };
}

/**
 * A dry run (tap's stand-in SDK, manifest.json dry: true) answers none of the smoke questions: it
 * is refused with SMOKE FAIL and nothing is written into the folder (spec 6.5).
 */
function dryRunRefusal(id: string, options: SmokeOptions): SmokeResult {
  const reasons = [DRY_RUN_REASON];
  const verdict = verdictLine(reasons);
  const lines = [DRY_RUN_NOTE, verdict];
  if (options.print !== false) {
    const out = options.out ?? ((line: string) => console.log(line));
    for (const line of lines) out(line);
  }
  return {
    ok: false,
    code: SMOKE_EXIT.fail,
    verdict,
    reasons,
    text: lines.join('\n'),
    report: { schema: SMOKE_REPORT_SCHEMA, id, ok: false, verdict, reasons, dry: true },
    reportPath: null,
  };
}

/**
 * Answers the ten smoke questions for one session and returns the verdict. The folder is read
 * line by line (analysis/smoke/read.ts), not through the schema check, so lines whose SDK layout
 * differs are still seen; sdk_raw.jsonl.gz and tap's logged output are read too.
 */
export function runSmoke(session: SmokeSession, options: SmokeOptions = {}): SmokeResult {
  const env = options.env ?? process.env;
  const dir = typeof session === 'string' ? sessionDirOf(session, env) : session.dir;
  if (!existsSync(dir) || !statSync(dir).isDirectory()) throw new Error(`No session folder ${dir}`);
  const folder = readSessionFolder(dir);
  if (typeof session !== 'string' && typeof session.id === 'string') folder.id = session.id;
  if (isDryRun(folder.manifest)) return dryRunRefusal(folder.id, options);

  const manifestRate = (folder.manifest?.['audio'] as Record<string, unknown> | undefined)?.['sample_rate'];
  const sampleRateHz =
    typeof session !== 'string' && positive(session.sampleRateHz) ? session.sampleRateHz : positive(manifestRate) ? manifestRate : SAMPLE_RATE_HZ;
  const ctx = buildContext(folder, sampleRateHz);
  const balances = balancesOf(options.credits, balancesFromReport(folder.previousReport));
  const parts = buildSmokeReport(ctx, balances, {
    shownDir: shownPath(dir),
    schemaProblems: typeof session !== 'string' ? session.problems : undefined,
    loadError: options.loadError ?? null,
  });

  const lines = [...parts.lines, ''];
  let reportPath: string | null = null;
  if (options.write !== false) {
    try {
      reportPath = writeSmokeReport(dir, parts.report);
      lines.push(`Numbers: ${shownPath(reportPath)}`);
    } catch (e) {
      lines.push(`${SMOKE_REPORT_FILE} could not be written: ${(e as Error).message}`);
    }
  }
  lines.push(parts.verdict);
  const text = lines.join('\n');
  if (options.print !== false) {
    const out = options.out ?? ((line: string) => console.log(line));
    for (const line of lines) out(line);
  }
  return {
    ok: parts.ok,
    code: parts.ok ? SMOKE_EXIT.ok : SMOKE_EXIT.fail,
    verdict: parts.verdict,
    reasons: parts.reasons,
    text,
    report: parts.report,
    reportPath,
  };
}

// ---- command line ----------------------------------------------------------------------------

const USAGE = 'usage: npx tsx analysis/smoke.ts [<session id or folder>] [--credits <before>,<after>]';

/** Command line: prints the report and returns the exit code (SMOKE_EXIT). */
export function main(
  argv: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
  out: (line: string) => void = (l) => console.log(l),
  err: (line: string) => void = (l) => console.error(l),
): number {
  let id: string | null = null;
  let credits: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === '--help' || a === '-h') {
      out(USAGE);
      return 0;
    } else if (a === '--credits') {
      const v = argv[i + 1];
      if (v === undefined) {
        err(`--credits needs a value\n${USAGE}`);
        return SMOKE_EXIT.error;
      }
      credits = v;
      i++;
    } else if (a.startsWith('--credits=')) {
      credits = a.slice('--credits='.length);
    } else if (a.startsWith('-')) {
      err(`unknown option ${a}\n${USAGE}`);
      return SMOKE_EXIT.error;
    } else if (id === null) {
      id = a;
    } else {
      err(`one session at a time\n${USAGE}`);
      return SMOKE_EXIT.error;
    }
  }
  if (credits !== undefined) {
    const parsed = parseCreditBalances(credits);
    if (typeof parsed === 'string') {
      err(`--credits: ${parsed}\n${USAGE}`);
      return SMOKE_EXIT.error;
    }
  }
  if (id === null) {
    id = latestSession('smoke', { env });
    if (id === null) {
      err(`No smoke session in ${shownPath(sessionsDir(env))}. Record one first (spec 7.12), or name the folder.`);
      return SMOKE_EXIT.error;
    }
  }
  const dir = sessionDirOf(id, env);
  if (!existsSync(dir) || !statSync(dir).isDirectory()) {
    err(`No session folder ${shownPath(dir)}`);
    return SMOKE_EXIT.error;
  }
  // The shared loader checks every file against core/schemas; its problems go into the report.
  let session: SmokeSession = dir;
  let loadError: string | null = null;
  try {
    session = loadSession(dir, { env, detectorIn: false });
  } catch (e) {
    loadError = (e as Error).message.split('\n')[0] ?? 'unknown error';
  }
  return runSmoke(session, { credits, env, out, loadError }).code;
}

function isMain(): boolean {
  try {
    return process.argv[1] !== undefined && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isMain()) process.exitCode = main(process.argv.slice(2));
