// The session folder as `npm run video` reads it (spec 8.1, 15.4): audio.wav (ch0 microphone, ch1
// narrator as played), the click stamps and step marks of stamps.jsonl, the D1 `armed` lines of
// events.jsonl, and L_rt from clock_report.json or calib.json. Only audio.wav and stamps.jsonl are
// needed; manifest.json gives the id and kind when present.

import fs from 'node:fs';
import path from 'node:path';
import { chunkLayout, CLICK_COUNT, QUANTUM_SAMPLES, type ChunkLayout, type EventLine, type Stamp } from '../../core/clock/index.ts';
import {
  parseJson,
  parseJsonl,
  SESSION_ID,
  validateCalib,
  validateClockReport,
  validateEventLine,
  validateManifest,
  validateStampLine,
  type Calib,
  type ClockReport,
} from '../../core/schemas/index.ts';
import { measureLoops } from '../../analysis/lib/measure.ts';
import { sessionsDir } from '../../analysis/lib/paths.ts';
import { latestSession, stepMarks, type StepMark } from '../../analysis/lib/session.ts';
import { readStereoFloatWav } from '../../analysis/lib/wav.ts';
import { DEMO_CLICK_STARTS_MS } from '../../web/lib/clicks.ts';
import { VideoError } from './ffmpeg.ts';
import type { ClickRef } from './match.ts';

export interface VideoSession {
  id: string;
  dir: string;
  /** manifest.json `kind` (headstart, demo, ...); null without a readable manifest. */
  kind: string | null;
  /** manifest.json `tap`: "real" (the SDK) or "mock" (a synthetic chest trace); null when absent. */
  tap: string | null;
  sampleRateHz: number;
  ch0: Float32Array;
  ch1: Float32Array;
  /** Where each session sample sits in audio.wav (chunk stamps; one run from 0 without them). */
  layout: ChunkLayout;
  stamps: Stamp[];
  events: EventLine[];
  calib: Calib | null;
  clockReport: ClockReport | null;
  /** Lines and files that could not be read; they were skipped. */
  problems: string[];
}

function readText(file: string): string | null {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw e;
  }
}

/**
 * Folder of a session argument: a bare id (headstart-2) lives in sessions/ (or
 * COPYHOLDER_SESSIONS_DIR); anything else is a path, taken from `base` (the folder npm was run in).
 */
export function sessionFolder(arg: string, env: NodeJS.ProcessEnv, base: string): string {
  if (SESSION_ID.test(arg)) {
    const inSessions = path.join(sessionsDir(env), arg);
    if (fs.existsSync(inSessions) || !fs.existsSync(path.resolve(base, arg))) return inSessions;
  }
  return path.resolve(base, arg);
}

/** L_rt of the newest full doctor run that measured one, as a hint for --lrt-ms (spec 7.12); null when none did. */
export function doctorLrtHint(env: NodeJS.ProcessEnv): { id: string; ms: number } | null {
  const lrtOf = (dir: string): number | null => {
    const text = readText(path.join(dir, 'calib.json'));
    const l = text === null ? undefined : parseJson(text, validateCalib).value?.L_rt_ms;
    if (!l) return null;
    return typeof l.used === 'number' ? l.used : meanOf([l.A, l.B]);
  };
  const id = latestSession('doctor', { env, scenario: 'doctor', accept: (dir) => lrtOf(dir) !== null });
  if (id === null) return null;
  const ms = lrtOf(path.join(sessionsDir(env), id));
  return ms === null ? null : { id, ms };
}

/** The newest headstart or demo recording (manifest started_utc), or null. */
export function latestTake(env: NodeJS.ProcessEnv): string | null {
  let best: { id: string; t: number } | null = null;
  for (const kind of ['headstart', 'demo'] as const) {
    const id = latestSession(kind, { env });
    if (id === null) continue;
    const text = readText(path.join(sessionsDir(env), id, 'manifest.json'));
    const m = text === null ? null : parseJson(text, validateManifest).value;
    const t = m ? Date.parse(m.started_utc) : Number.NEGATIVE_INFINITY;
    if (best === null || t > best.t) best = { id, t };
  }
  return best?.id ?? null;
}

/** Reads the folder. Throws VideoError when audio.wav or stamps.jsonl is missing or unreadable. */
export function loadVideoSession(dir: string): VideoSession {
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) throw new VideoError(`No session folder ${dir}`);
  const problems: string[] = [];
  let id = path.basename(dir);
  let kind: string | null = null;
  let tap: string | null = null;
  const manifestText = readText(path.join(dir, 'manifest.json'));
  if (manifestText !== null) {
    const m = parseJson(manifestText, validateManifest, { file: 'manifest.json' });
    if (m.value) {
      id = m.value.id;
      kind = m.value.kind;
      tap = typeof m.value.tap === 'string' ? m.value.tap : null;
    } else {
      problems.push(...m.errors.slice(0, 3));
    }
  }

  const wavFile = path.join(dir, 'audio.wav');
  if (!fs.existsSync(wavFile)) throw new VideoError(`${dir} has no audio.wav`);
  let audio;
  try {
    audio = readStereoFloatWav(wavFile);
  } catch (e) {
    throw new VideoError(`audio.wav of ${dir} cannot be read: ${(e as Error).message}`);
  }
  if (audio.info.headerNote !== null) problems.push(`audio.wav: ${audio.info.headerNote}; length taken from the file size`);

  const stampsText = readText(path.join(dir, 'stamps.jsonl'));
  if (stampsText === null) throw new VideoError(`${dir} has no stamps.jsonl: the click stamps align the picture`);
  const st = parseJsonl(stampsText, validateStampLine, { file: 'stamps.jsonl', maxErrors: 5 });
  problems.push(...st.errors);
  const stamps = st.rows as Stamp[];

  const eventsText = readText(path.join(dir, 'events.jsonl'));
  const ev = eventsText === null ? null : parseJsonl(eventsText, validateEventLine, { file: 'events.jsonl', maxErrors: 5 });
  if (ev) problems.push(...ev.errors);

  const calibText = readText(path.join(dir, 'calib.json'));
  const calib = calibText === null ? null : parseJson(calibText, validateCalib, { file: 'calib.json', maxErrors: 3 });
  if (calib) problems.push(...calib.errors);
  const reportText = readText(path.join(dir, 'clock_report.json'));
  const report = reportText === null ? null : parseJson(reportText, validateClockReport, { file: 'clock_report.json', maxErrors: 3 });
  if (report) problems.push(...report.errors);

  let layout = chunkLayout(stamps, audio.ch0.length);
  if (layout.runs.length === 0) {
    layout = { runs: [{ n0: 0, n1: audio.ch0.length, index0: 0 }], contiguous: true, chunks: 0, frames: audio.ch0.length };
  }
  return {
    id,
    dir,
    kind,
    tap,
    sampleRateHz: audio.info.sampleRateHz,
    ch0: audio.ch0,
    ch1: audio.ch1,
    layout,
    stamps,
    events: (ev?.rows ?? []) as EventLine[],
    calib: calib?.value ?? null,
    clockReport: report?.value ?? null,
    problems,
  };
}

/** First and one-past-last session samples held in audio.wav. */
export function recordedSpan(s: Pick<VideoSession, 'layout'>): { n0: number; n1: number } {
  let n0 = Number.POSITIVE_INFINITY;
  let n1 = Number.NEGATIVE_INFINITY;
  for (const r of s.layout.runs) {
    n0 = Math.min(n0, r.n0);
    n1 = Math.max(n1, r.n1);
  }
  return Number.isFinite(n0) ? { n0, n1 } : { n0: 0, n1: 0 };
}

// ---- clicks ------------------------------------------------------------------------------

export interface ClickGroup {
  /** "loop A", "loop B", "loop", "demo" or "clicks". */
  label: string;
  kind: 'loop' | 'demo' | 'other';
  /** Click starts, session samples. */
  ns: number[];
}

/** A run of clicks more than this far apart starts a new block (core/clock loopClickBlocks). */
const GROUP_GAP_S = 3;

/** The demo clicks' gaps in samples (web/lib/clicks.ts), to know the three sync clicks by. */
function demoGaps(rateHz: number): number[] {
  const at = DEMO_CLICK_STARTS_MS.map((ms) => Math.round((ms * rateHz) / 1000));
  return at.slice(1).map((x, i) => x - (at[i] as number));
}

/**
 * Click blocks in stamp order: a block starts when the click index restarts or after a 3 s gap
 * (the rule of core/clock). 10 clicks make a loop check (the first is A, the last B), three clicks
 * with the gaps of the demo clicks make the demo block (spec 7.3, 15.4).
 */
export function clickGroups(stamps: readonly Stamp[], rateHz: number): ClickGroup[] {
  const runs: Array<{ n: number; i: number | undefined }[]> = [];
  let prev: { n: number; i: number | undefined } | null = null;
  for (const s of stamps) {
    if (s.k !== 'click') continue;
    const cur = { n: s.n, i: s.i };
    const restart = prev === null || cur.n - prev.n > GROUP_GAP_S * rateHz || (cur.i !== undefined && prev.i !== undefined && cur.i <= prev.i);
    if (restart) runs.push([]);
    (runs[runs.length - 1] as Array<{ n: number; i: number | undefined }>).push(cur);
    prev = cur;
  }
  const gaps = demoGaps(rateHz);
  const isDemo = (ns: number[]): boolean =>
    ns.length === gaps.length + 1 && ns.slice(1).every((x, k) => Math.abs(x - (ns[k] as number) - (gaps[k] as number)) <= QUANTUM_SAMPLES);
  const groups: ClickGroup[] = runs.map((r) => {
    const ns = r.map((c) => c.n);
    if (ns.length === CLICK_COUNT) return { label: 'loop', kind: 'loop', ns };
    if (isDemo(ns)) return { label: 'demo', kind: 'demo', ns };
    return { label: 'clicks', kind: 'other', ns };
  });
  const loops = groups.filter((g) => g.kind === 'loop');
  if (loops.length >= 1) (loops[0] as ClickGroup).label = 'loop A';
  if (loops.length >= 2) (loops[loops.length - 1] as ClickGroup).label = 'loop B';
  return groups;
}

/** Every click, labelled with its block and place in it ("loop A 3"). */
export function clickRefs(groups: readonly ClickGroup[]): ClickRef[] {
  return groups.flatMap((g) => g.ns.map((n, i) => ({ n, label: `${g.label} ${i + 1}` })));
}

/** First click of the first demo block, or null. */
export function firstDemoClick(groups: readonly ClickGroup[]): number | null {
  return groups.find((g) => g.kind === 'demo')?.ns[0] ?? null;
}

/** Step marks of stamps.jsonl in order (analysis/lib/session.ts). */
export function steps(s: Pick<VideoSession, 'stamps'>): StepMark[] {
  return stepMarks(s);
}

// ---- D1 active ---------------------------------------------------------------------------

/** D1's `armed` lines of events.jsonl as [n, on], in file order. */
export function armedEdges(events: readonly EventLine[]): Array<[number, boolean]> {
  const out: Array<[number, boolean]> = [];
  for (const e of events) {
    if (e.e !== 'armed' || e['det'] !== 'D1' || typeof e.n !== 'number' || typeof e['on'] !== 'boolean') continue;
    out.push([e.n, e['on']]);
  }
  return out;
}

/**
 * Whether D1 was active at sample n (the last `armed` line at or before n), and where it next
 * becomes active after n; null when the record has no `armed` lines (spec 15.1 starts the shown
 * segment where D1 is active).
 */
export function d1At(events: readonly EventLine[], n: number): { active: boolean; nextOn: number | null } | null {
  const edges = armedEdges(events);
  if (edges.length === 0) return null;
  let active = false;
  for (const [m, on] of edges) if (m <= n) active = on;
  const next = edges.find(([m, on]) => m > n && on);
  return { active, nextOn: next ? next[0] : null };
}

// ---- L_rt ----------------------------------------------------------------------------------

export interface LrtChoice {
  ms: number;
  source: string;
}

function meanOf(values: ReadonlyArray<number | null | undefined>): number | null {
  const v = values.filter((x): x is number => typeof x === 'number' && Number.isFinite(x));
  return v.length === 0 ? null : v.reduce((a, b) => a + b, 0) / v.length;
}

/** L_rt above this is no loop path (ms); it is not used. */
const LRT_MAX_MS = 200;

/**
 * L_rt for the narrator channel (spec 6.3, 15.4): --lrt-ms, else clock_report.json (mean of
 * loop checks A and B), else calib.json (`used`, else the mean of A and B), else measured here on
 * the loop checks of audio.wav, as `clocks` does. Throws VideoError when there is none.
 */
export function chooseLrt(s: VideoSession, overrideMs: number | null, hintMs: { id: string; ms: number } | null = null): LrtChoice {
  const ok = (ms: number | null): ms is number => ms !== null && ms >= 0 && ms <= LRT_MAX_MS;
  if (overrideMs !== null) {
    if (!ok(overrideMs)) throw new VideoError(`--lrt-ms ${overrideMs}: expected 0 to ${LRT_MAX_MS} ms`);
    return { ms: overrideMs, source: '--lrt-ms' };
  }
  const report = s.clockReport ? meanOf(s.clockReport.chain.L_rt_ms) : null;
  if (ok(report)) return { ms: report, source: 'clock_report.json (loop checks A and B)' };
  const l = s.calib?.L_rt_ms;
  const calib = l ? (typeof l.used === 'number' ? l.used : meanOf([l.A, l.B])) : null;
  if (ok(calib)) return { ms: calib, source: 'calib.json' };
  const loops = measureLoops({
    sampleRateHz: s.sampleRateHz,
    ch0: s.ch0,
    ch1: s.ch1,
    stamps: s.stamps,
    samples: [],
    events: s.events,
    micSettings: null,
    layout: s.layout,
  });
  const measured = meanOf([loops.A?.L_rt_ms, loops.B?.L_rt_ms]);
  if (ok(measured)) {
    const which = [loops.A?.L_rt_ms != null ? 'A' : null, loops.B?.L_rt_ms != null ? 'B' : null].filter((x) => x !== null).join(' and ');
    return { ms: measured, source: `measured on loop check ${which} of audio.wav` };
  }
  const hint = hintMs ? ` The latest doctor run, ${hintMs.id}, measured ${hintMs.ms.toFixed(1)} ms: --lrt-ms ${hintMs.ms.toFixed(1)}.` : '';
  throw new VideoError(
    `No L_rt for ${s.id}: no clock_report.json, no L_rt in calib.json and no loop check with all 10 clicks found in audio.wav. ` +
      `Give it with --lrt-ms <ms>.${hint}`,
  );
}
