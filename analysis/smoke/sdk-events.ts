// SDK errors and processing statuses of a smoke run, from every file that records them:
// samples.jsonl `e` and `s` lines, sdk_raw.jsonl.gz `error` and `processingStatus` lines, and
// host's `sdk_error` and `tap` events in events.jsonl (spec 7.1, 7.2, 8.1).

import { SAMPLE_RATE_HZ, SDK_RESTART_CODE, sdkErrorCount, type EventLine, type SampleLine } from '../../core/clock/index.ts';
import { lineSamples, stepAt, type SmokeContext } from './context.ts';
import { redactLogText } from './numbers.ts';
import { errorName, processingName } from './reduce-adapter.ts';

/** One answer of the report: printed lines and the numbers for smoke_report.json. */
export interface Answer {
  n: number;
  title: string;
  lines: string[];
  data: Record<string, unknown>;
}

/** Where one error was logged: index among the `e` lines, the sdk_raw `error` lines and the `sdk_error` events. */
interface ErrorOrigins {
  line?: number;
  raw?: number;
  event?: number;
}

export interface SdkErrorSeen {
  code: number | null;
  name: string;
  /** The SDK's or tap's text, on one line, secrets blanked, cut to 200 characters. */
  message: string | null;
  /** Files that report it. */
  sources: string[];
  /** Seconds on the audio clock (from the first audio sample), when known. */
  atS: number | null;
  step: string | null;
  /** Counts for the hard condition (rule of sdkErrorTally). */
  counted: boolean;
  /** tap's one reset and restart: kProcessingFailed before the first packet (spec 7.1). */
  restart: boolean;
  origins: ErrorOrigins;
}

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const textOf = (v: unknown): string | null => (typeof v === 'string' && v.trim() !== '' ? redactLogText(v) : null);

/**
 * Every SDK error of the run, one entry per event: `e` lines first, then sdk_raw `error` lines
 * (merged with the `e` line of the same seq), then host `sdk_error` events (merged with an entry
 * of the same code that has no event yet; an exception from start() or useCamera() gives only
 * the event, code null and name 'tap'). `counted` and `restart` come from sdkErrorTally().
 */
function collectErrors(ctx: SmokeContext): SdkErrorSeen[] {
  const out: SdkErrorSeen[] = [];
  const at = (n: number | null) => ({
    atS: n === null ? null : n / ctx.sampleRateHz,
    step: n === null ? null : (stepAt(ctx.steps, n)?.name ?? null),
  });
  const base = { counted: false, restart: false };
  ctx.byKind.e.forEach((l, i) => {
    const code = isNum(l.code) ? l.code : null;
    out.push({
      code,
      name: typeof l.name === 'string' ? l.name : code === null ? 'unknown' : errorName(code),
      message: textOf(l.message),
      sources: ['samples.jsonl'],
      ...at(lineSamples(ctx, l)),
      ...base,
      origins: { line: i },
    });
  });
  ctx.folder.raw
    .filter((r) => r.kind === 'error')
    .forEach((r, j) => {
      const same = r.seq === null ? undefined : out.find((x) => x.origins.line !== undefined && ctx.byKind.e[x.origins.line]!.seq === r.seq);
      if (same) {
        same.origins.raw = j;
        same.sources.push('sdk_raw.jsonl.gz');
        same.message ??= textOf(r.args?.[1]);
        return;
      }
      const code = isNum(r.args?.[0]) ? (r.args[0] as number) : null;
      out.push({
        code,
        name: code === null ? 'unknown' : errorName(code),
        message: textOf(r.args?.[1]),
        sources: ['sdk_raw.jsonl.gz'],
        ...at(lineSamples(ctx, { tArrNs: r.tArrNs })),
        ...base,
        origins: { raw: j },
      });
    });
  ctx.folder.events
    .filter((ev) => ev.e === 'sdk_error')
    .forEach((ev, k) => {
      const code = isNum(ev['code']) ? (ev['code'] as number) : null;
      const same = out.find((x) => x.code === code && x.origins.event === undefined);
      if (same) {
        same.origins.event = k;
        same.sources.push('events.jsonl');
        same.message ??= textOf(ev['message']);
        return;
      }
      const n = isNum(ev.n) ? ev.n : null;
      out.push({
        code,
        name: typeof ev['name'] === 'string' ? (ev['name'] as string) : code === null ? 'unknown' : errorName(code),
        message: textOf(ev['message']),
        sources: ['events.jsonl'],
        ...at(n),
        ...base,
        origins: { event: k },
      });
    });
  return out;
}

export interface SdkErrorTally {
  /** SDK error events for the hard condition. */
  count: number;
  /** Every error seen, with `counted` and `restart` set. */
  all: SdkErrorSeen[];
  /** The `count` errors that count, from the file that has the most of them. */
  counted: SdkErrorSeen[];
  /** tap's one restart, when there was one. */
  restart: SdkErrorSeen | null;
  /** core/clock sdkErrorCount over samples.jsonl and events.jsonl (the rule of quickcheck). */
  coreCount: number;
}

/**
 * The hard condition's error count and the errors it names, from one rule: core/clock
 * sdkErrorCount, applied to each file on its own (samples.jsonl `e` lines, events.jsonl
 * `sdk_error` events and, as a third record, sdk_raw `error` lines). In each file the first
 * kProcessingFailed before the first packet is tap's reset and restart (spec 7.1) and does not
 * count; the count is the largest of the three, and the errors named are those of that file.
 */
export function sdkErrorTally(ctx: SmokeContext): SdkErrorTally {
  const all = collectErrors(ctx);
  // samples.jsonl: before the first `m` line, in file order.
  const restartLine = new Set<number>();
  let packetSeen = false;
  let eIndex = 0;
  for (const l of ctx.folder.samples) {
    if (l.k === 'm') packetSeen = true;
    else if (l.k === 'e') {
      if (!packetSeen && restartLine.size === 0 && l.code === SDK_RESTART_CODE) restartLine.add(eIndex);
      eIndex++;
    }
  }
  // sdk_raw.jsonl.gz: before the first `metrics` line, in file order.
  const restartRaw = new Set<number>();
  let metricsSeen = false;
  let rIndex = 0;
  for (const r of ctx.folder.raw) {
    if (r.kind === 'metrics') metricsSeen = true;
    else if (r.kind === 'error') {
      if (!metricsSeen && restartRaw.size === 0 && r.args?.[0] === SDK_RESTART_CODE) restartRaw.add(rIndex);
      rIndex++;
    }
  }
  // events.jsonl: n not after the first `arr` stamp (core/clock sdkErrorCount).
  let firstArr = Number.POSITIVE_INFINITY;
  for (const s of ctx.folder.stamps) if (s.k === 'arr' && isNum(s.n) && s.n < firstArr) firstArr = s.n;
  const restartEvent = new Set<number>();
  ctx.folder.events
    .filter((ev) => ev.e === 'sdk_error')
    .forEach((ev, k) => {
      const early = typeof ev.n !== 'number' || ev.n <= firstArr;
      if (restartEvent.size === 0 && early && ev['code'] === SDK_RESTART_CODE) restartEvent.add(k);
    });

  const bySource = {
    line: { restart: restartLine, total: ctx.byKind.e.length },
    event: { restart: restartEvent, total: ctx.folder.events.filter((ev) => ev.e === 'sdk_error').length },
    raw: { restart: restartRaw, total: rIndex },
  } as const;
  const sources = ['line', 'event', 'raw'] as const;
  const countOf = (s: (typeof sources)[number]) => bySource[s].total - bySource[s].restart.size;
  const count = Math.max(...sources.map(countOf));
  const chosen = sources.find((s) => countOf(s) === count)!;
  for (const e of all) {
    e.restart = sources.some((s) => e.origins[s] !== undefined && bySource[s].restart.has(e.origins[s]!));
    const idx = e.origins[chosen];
    e.counted = count > 0 && idx !== undefined && !bySource[chosen].restart.has(idx);
  }
  return {
    count,
    all,
    counted: all.filter((e) => e.counted),
    restart: all.find((e) => e.restart && !e.counted) ?? null,
    coreCount: sdkErrorEventCount(ctx),
  };
}

/** Every SDK error of the run (see sdkErrorTally). */
export function sdkErrorsSeen(ctx: SmokeContext): SdkErrorSeen[] {
  return sdkErrorTally(ctx).all;
}

/** "5 kNetworkError: <message>", or for tap's own failure (code null) "tap: <message>". */
export function errorLabel(e: Pick<SdkErrorSeen, 'code' | 'name' | 'message'>, maxMessage = 120): string {
  const msg = e.message === null ? null : redactLogText(e.message, maxMessage);
  if (e.code === null) return msg === null ? e.name : `${e.name}: ${msg}`;
  return msg === null ? `${e.code} ${e.name}` : `${e.code} ${e.name}: ${msg}`;
}

/** SDK error count of core/clock sdkErrorCount, as quickcheck counts it (spec 7.12). */
export function sdkErrorEventCount(ctx: SmokeContext): number {
  return sdkErrorCount({
    sampleRateHz: SAMPLE_RATE_HZ,
    ch0: new Float32Array(0),
    ch1: new Float32Array(0),
    stamps: ctx.folder.stamps,
    samples: ctx.coreSamples,
    events: ctx.folder.events as EventLine[],
    micSettings: null,
  });
}

/** 'Running' or 'kRunning' (web/lib/sdk-ready.ts reads the names the same way). */
export function isRunningName(name: unknown): boolean {
  return typeof name === 'string' && name.replace(/^k(?=[A-Z])/, '').toLowerCase() === 'running';
}

/** Name of an `s` line: its own name, else the reduce.cjs name of its code. */
export function processingLineName(l: SampleLine): string | null {
  if (typeof l.name === 'string') return l.name;
  return isNum(l.code) ? processingName(l.code) : null;
}

export interface RunningEvidence {
  reached: boolean;
  /** Audio seconds of the first Running status, when it can be placed. */
  atS: number | null;
  /** Statuses in order of arrival, without repeats. */
  statuses: string[];
  /** Where Running was seen. */
  sources: string[];
}

/** Did the SDK report Running (spec 7.12 hard condition)? */
export function runningEvidence(ctx: SmokeContext): RunningEvidence {
  const statuses: string[] = [];
  const sources = new Set<string>();
  let atN: number | null = null;
  for (const l of ctx.byKind.s) {
    const name = processingLineName(l);
    if (name !== null && statuses[statuses.length - 1] !== name) statuses.push(name);
    if (isRunningName(name)) {
      sources.add('samples.jsonl');
      if (atN === null) atN = lineSamples(ctx, l);
    }
  }
  for (const r of ctx.folder.raw) {
    if (r.kind !== 'processingStatus' || !isNum(r.args?.[0])) continue;
    const name = processingName(r.args[0] as number);
    if (ctx.byKind.s.length === 0 && statuses[statuses.length - 1] !== name) statuses.push(name);
    if (isRunningName(name)) sources.add('sdk_raw.jsonl.gz');
  }
  for (const ev of ctx.folder.events) {
    if (ev.e === 'tap' && ev['status'] === 'running') sources.add('events.jsonl (host)');
  }
  return { reached: sources.size > 0, atS: atN === null ? null : atN / ctx.sampleRateHz, statuses, sources: [...sources] };
}
