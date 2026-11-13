// The smoke report (spec 7.12): ten answers with their numbers, the three hard conditions and one
// verdict line, SMOKE OK or SMOKE FAIL: <reason>.

import { renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { TRACE_RATE_MIN_PER_S } from '../../core/clock/index.ts';
import { answerCredits, answerInsights, answerLens, answerWatchdog, NO_BALANCES, type CreditBalances } from './answers-run.ts';
import { answerData, answerStart, layoutFindings, traceMissingWhy, type ReduceVersionInfo } from './answers-start.ts';
import { answerRates, answerScreenRecording, answerSign, answerTime } from './answers-time.ts';
import type { SmokeContext } from './context.ts';
import { finiteJson, fmtPerS, r1, r3 } from './numbers.ts';
import { ACCESSOR_NAMES, reduceSource, type AccessorName, type ReduceSource } from './reduce-adapter.ts';
import { errorLabel, runningEvidence, sdkErrorTally, type Answer } from './sdk-events.ts';

export const SMOKE_REPORT_SCHEMA = 'smoke-report/1';
export const SMOKE_REPORT_FILE = 'smoke_report.json';

/** Keys of the ten answers in smoke_report.json, in the order of spec 7.12. */
export const QUESTION_KEYS = [
  'q1_start',
  'q2_data',
  'q3_trace_sign',
  'q4_time',
  'q5_rates',
  'q6_screen_recording',
  'q7_lens_cover',
  'q8_watchdog',
  'q9_credits',
  'q10_insights',
] as const;

export interface HardConditions {
  ok: boolean;
  /** Why the run fails, one entry per failed condition, for the verdict line. */
  reasons: string[];
  lines: string[];
  data: Record<string, unknown>;
}

/** The three hard conditions of the smoke run (spec 7.12): Running, median trace rate, no SDK error. */
export function hardConditions(ctx: SmokeContext, paths?: Readonly<Record<AccessorName, string>>): HardConditions {
  const reasons: string[] = [];
  const lines: string[] = [];

  const running = runningEvidence(ctx);
  const statuses = running.statuses.length > 0 ? `processingStatus: ${running.statuses.join(', ')}` : 'no processingStatus logged';
  if (!running.reached) reasons.push(`the SDK never reached Running (${statuses})`);
  lines.push(`Running: ${running.reached ? `yes (${running.sources.join(', ')})` : `NO (${statuses})`}.`);

  // The rule of core/clock traceRateMedian (quickcheck condition 4), over the trace inside its run.
  const traceMedian = ctx.traceRateMedian;
  const traceOk = traceMedian !== null && traceMedian >= TRACE_RATE_MIN_PER_S;
  const stray = ctx.streams.trace.outside;
  if (!traceOk) {
    if (traceMedian !== null) reasons.push(`median trace rate ${fmtPerS(traceMedian)} is below ${TRACE_RATE_MIN_PER_S}`);
    else if (ctx.trace.length === 0 && stray === 0) {
      const why = traceMissingWhy(ctx, layoutFindings(ctx, undefined, paths));
      reasons.push(`no trace samples${why ? ` (${why})` : ''}`);
    } else if (ctx.trace.length === 0) reasons.push(`no trace sample within the run (${stray} stray timestamps)`);
    else reasons.push(`trace too short for a rate: ${ctx.trace.length} samples within less than 1 s`);
  }
  lines.push(
    `Median trace rate: ${fmtPerS(traceMedian)} (at least ${TRACE_RATE_MIN_PER_S}): ${traceOk ? 'ok' : 'FAIL'}.${stray > 0 ? ` ${stray} stray trace timestamps left out (question 4).` : ''}`,
  );

  const tally = sdkErrorTally(ctx);
  const names = [...new Set(tally.counted.map((e) => errorLabel(e)))];
  const list = names.length > 3 ? `${names.slice(0, 3).join('; ')}; ...` : names.join('; ');
  if (tally.count > 0) reasons.push(`${tally.count} SDK error event${tally.count > 1 ? 's' : ''}${list ? `: ${list}` : ''}`);
  const restart = tally.restart ? `; tap's one restart (${errorLabel(tally.restart)}, before the first packet) does not count` : '';
  lines.push(`SDK error events: ${tally.count}${tally.count > 0 && list ? ` (${list})` : ''}${restart}: ${tally.count === 0 ? 'ok' : 'FAIL'}.`);

  return {
    ok: reasons.length === 0,
    reasons,
    lines,
    data: {
      running: { ok: running.reached, statuses: running.statuses, sources: running.sources, at_s: r3(running.atS) },
      trace_rate: { ok: traceOk, median_per_s: r1(traceMedian), min_per_s: TRACE_RATE_MIN_PER_S, samples: ctx.trace.length, stray_timestamps: stray },
      sdk_errors: {
        ok: tally.count === 0,
        count: tally.count,
        core_count: tally.coreCount,
        errors: tally.all.map((e) => ({
          code: e.code,
          name: e.name,
          message: e.message,
          sources: e.sources,
          at_s: r3(e.atS),
          step: e.step,
          counted: e.counted,
          restart: e.restart,
        })),
      },
    },
  };
}

/** The verdict line: exactly SMOKE OK, or SMOKE FAIL: <reasons joined by "; ">. */
export function verdictLine(reasons: readonly string[]): string {
  return reasons.length === 0 ? 'SMOKE OK' : `SMOKE FAIL: ${reasons.join('; ')}`;
}

/** reduce.cjs when the session was first reported (the report runs right after the recording) and now. */
export interface ReduceVersion {
  first: { sha256: string | null; paths: Record<AccessorName, string>; utc: string | null };
  nowSha256: string | null;
  changed: boolean;
}

function pathsOf(v: unknown): Record<AccessorName, string> | null {
  if (!v || typeof v !== 'object') return null;
  const o = v as Record<string, unknown>;
  return ACCESSOR_NAMES.every((k) => typeof o[k] === 'string') ? (o as Record<AccessorName, string>) : null;
}

/** Keeps the reduce.cjs of the first report of this session, so later edits do not rewrite what the lines were made with. */
export function reduceVersion(previous: Record<string, unknown> | null, now: ReduceSource = reduceSource(), nowUtc: string | null = null): ReduceVersion {
  const kept = previous?.['reduce_cjs'];
  const first = kept && typeof kept === 'object' ? (kept as Record<string, unknown>)['first'] : null;
  const f = first && typeof first === 'object' ? (first as Record<string, unknown>) : null;
  const paths = pathsOf(f?.['paths']);
  if (f && paths && (typeof f['sha256'] === 'string' || f['sha256'] === null)) {
    const sha = f['sha256'] as string | null;
    return {
      first: { sha256: sha, paths, utc: typeof f['utc'] === 'string' ? f['utc'] : null },
      nowSha256: now.sha256,
      changed: sha !== null && now.sha256 !== null && sha !== now.sha256,
    };
  }
  return { first: { sha256: now.sha256, paths: now.paths, utc: nowUtc }, nowSha256: now.sha256, changed: false };
}

function reduceInfo(v: ReduceVersion): ReduceVersionInfo {
  return {
    paths: v.first.paths,
    note: v.changed
      ? `Note: live/reduce.cjs changed since this session was first reported${v.first.utc ? ` (${v.first.utc})` : ''}; the lines were written by the earlier version, so the Layout lines show the fields it read.`
      : null,
  };
}

/** The ten answers in the order of spec 7.12. */
export function smokeAnswers(ctx: SmokeContext, balances: CreditBalances = NO_BALANCES, reduce?: ReduceVersionInfo): Answer[] {
  return [
    answerStart(ctx),
    answerData(ctx, reduce),
    answerSign(ctx),
    answerTime(ctx),
    answerRates(ctx),
    answerScreenRecording(ctx),
    answerLens(ctx),
    answerWatchdog(ctx),
    answerCredits(ctx, balances),
    answerInsights(ctx),
  ];
}

export interface SmokeReportParts {
  ok: boolean;
  verdict: string;
  reasons: string[];
  answers: Answer[];
  hard: HardConditions;
  /** smoke_report.json content. */
  report: Record<string, unknown>;
  /** Printed lines; the last one is the verdict. */
  lines: string[];
}

export interface ReportExtras {
  /** Where the folder was shown to the user (a path relative to the repository when inside it). */
  shownDir?: string;
  /** Problems the schema check of analysis/lib/session.ts found, when the caller loaded the session with it. */
  schemaProblems?: readonly string[];
  /** Why analysis/lib/session.ts could not load the folder, when it was tried. */
  loadError?: string | null;
  generatedUtc?: string;
  /** live/reduce.cjs now (tests pass another). */
  reduceNow?: ReduceSource;
}

function inputsLine(ctx: SmokeContext): string {
  const parts = ctx.folder.inputs.map((f) => {
    if (!f.present) return `${f.file} missing`;
    if (f.file.endsWith('.json')) return f.badLines > 0 ? `${f.file} unreadable` : f.file;
    const bad = f.badLines > 0 ? `, ${f.badLines} unreadable` : '';
    return `${f.file} ${f.lines} line${f.lines === 1 ? '' : 's'}${bad}${f.note ? ` (${f.note})` : ''}`;
  });
  return `Read: ${parts.join('; ')}.`;
}

/**
 * One note at the top when tap's console is not in the folder (host does not save it): questions
 * 1, 2, 4 and 10 need it, and their answers point here.
 */
export function consoleNoteLines(ctx: SmokeContext, shownDir: string): string[] {
  const tap = ctx.tap;
  const out: string[] = [];
  if (!tap.consoleFound) {
    out.push(
      `tap's console is not in the session folder: host does not save it. Without it question 1 lacks the camera list and the checkDeviceReadiness() verdict, question 2 the first-frame probe and the enum checks, question 4 the timestamp type (number or Long), and question 10 the SDK log. ` +
        `If the terminal still shows this run, copy its text into ${shownDir}/tap.log and run: npx tsx analysis/smoke.ts ${ctx.folder.id}. ` +
        'Next time: npm run smoke 2>&1 | tee smoke.log, then move smoke.log into the session folder.',
    );
  } else if (tap.foreignRuns.length > 0) {
    out.push(`Note: the text log names the run of ${tap.foreignRuns.join(', ')}, not ${ctx.folder.id}; its lines were read anyway.`);
  }
  return out;
}

/** Answers, hard conditions, printed lines and the JSON report of one smoke run. */
export function buildSmokeReport(ctx: SmokeContext, balances: CreditBalances = NO_BALANCES, extras: ReportExtras = {}): SmokeReportParts {
  const generatedUtc = extras.generatedUtc ?? new Date().toISOString();
  const reduce = reduceVersion(ctx.folder.previousReport, extras.reduceNow ?? reduceSource(), generatedUtc);
  const info = reduceInfo(reduce);
  const answers = smokeAnswers(ctx, balances, info);
  const hard = hardConditions(ctx, info.paths);
  const verdict = verdictLine(hard.reasons);
  const manifest = ctx.folder.manifest;
  const shownDir = extras.shownDir ?? ctx.folder.dir;

  const lines: string[] = [];
  const started = typeof manifest?.['started_utc'] === 'string' ? `, started ${manifest['started_utc']}` : '';
  lines.push(`Smoke report for ${ctx.folder.id} (${shownDir}${started}).`);
  lines.push(inputsLine(ctx));
  if (extras.loadError) lines.push(`analysis/lib/session.ts could not load the folder (${extras.loadError}); read it line by line instead.`);
  if (extras.schemaProblems && extras.schemaProblems.length > 0) {
    lines.push(`Schema check: ${extras.schemaProblems.length} problem${extras.schemaProblems.length > 1 ? 's' : ''}, first: ${extras.schemaProblems[0]}`);
  }
  if (manifest && manifest['kind'] !== undefined && manifest['kind'] !== 'smoke') {
    lines.push(`Note: manifest.json says kind "${String(manifest['kind'])}", not "smoke".`);
  }
  lines.push(...consoleNoteLines(ctx, shownDir));
  for (const a of answers) {
    lines.push('');
    lines.push(`${a.n}. ${a.title}`);
    for (const l of a.lines) lines.push(`   ${l}`);
  }
  lines.push('');
  lines.push('Hard conditions (spec 7.12)');
  for (const l of hard.lines) lines.push(`   ${l}`);

  const questions: Record<string, unknown> = {};
  answers.forEach((a, i) => {
    questions[QUESTION_KEYS[i] ?? `q${a.n}`] = { title: a.title, answer: a.lines, ...a.data };
  });
  const report = finiteJson({
    schema: SMOKE_REPORT_SCHEMA,
    id: ctx.folder.id,
    generated_utc: generatedUtc,
    ok: hard.ok,
    verdict,
    reasons: hard.reasons,
    hard: hard.data,
    questions,
    sample_rate_hz: ctx.sampleRateHz,
    clock_maps: {
      tap_to_audio: ctx.tapToSamples !== null,
      camera_to_audio: ctx.camera?.method ?? null,
      tap_to_wall: ctx.tapToWallUs !== null,
    },
    tap_console: {
      found: ctx.tap.consoleFound,
      text_lines: ctx.tap.textLines,
      searched: ctx.tap.searched,
      foreign_runs: ctx.tap.foreignRuns,
    },
    reduce_cjs: {
      first: reduce.first,
      now_sha256: reduce.nowSha256,
      changed: reduce.changed,
      app_commit: typeof manifest?.['app_commit'] === 'string' ? manifest['app_commit'] : null,
    },
    inputs: ctx.folder.inputs,
    schema_problems: extras.schemaProblems ? { count: extras.schemaProblems.length, first: extras.schemaProblems.slice(0, 20) } : null,
    load_error: extras.loadError ?? null,
  }) as Record<string, unknown>;
  return { ok: hard.ok, verdict, reasons: hard.reasons, answers, hard, report, lines };
}

/** Writes smoke_report.json into the session folder through a temporary file (no half-written report). */
export function writeSmokeReport(dir: string, report: Record<string, unknown>): string {
  const file = join(dir, SMOKE_REPORT_FILE);
  const tmp = `${file}.tmp-${process.pid}`;
  writeFileSync(tmp, `${JSON.stringify(report, null, 2)}\n`);
  renameSync(tmp, file);
  return file;
}
