// Reading the clock inputs out of a session in memory (spec 8.1). Pure.

import type { LipFrame, PacketTime } from './camera.ts';
import { CLICK_COUNT } from './clicks.ts';
import { SAMPLE_RATE_HZ, TRACE_STRAY_TOLERANCE_S } from './constants.ts';
import type { TracePacket } from './sniff.ts';
import { median } from './stats.ts';
import type { SampleLine, SessionData, Stamp } from './types.ts';

/** Contiguous recorded sample numbers [n0, n1) stored at audio indices from index0. */
export interface ChunkRun {
  n0: number;
  n1: number;
  index0: number;
}

export interface ChunkLayout {
  runs: ChunkRun[];
  /** First chunk at n = 0, each next chunk at the previous n + frames, frames add up to the audio length. */
  contiguous: boolean;
  chunks: number;
  frames: number;
}

/**
 * Layout of audio.wav from the `chunk` stamps, in file order (spec 6.3, 7.2). The first block
 * starts at sample 0 (spec 8.1 example; assumption), so a lost first block is a gap too.
 */
export function chunkLayout(stamps: readonly Stamp[], audioLength: number): ChunkLayout {
  const chunks = stamps.filter((s) => s.k === 'chunk');
  let contiguous = chunks.length > 0 && chunks[0]!.n === 0;
  const runs: ChunkRun[] = [];
  let index = 0;
  for (const c of chunks) {
    const frames = c.frames ?? 0;
    if (!Number.isInteger(c.n) || !Number.isInteger(frames) || frames <= 0) {
      contiguous = false;
      continue;
    }
    const last = runs[runs.length - 1];
    if (last && c.n === last.n1) last.n1 += frames;
    else {
      if (last) contiguous = false;
      runs.push({ n0: c.n, n1: c.n + frames, index0: index });
    }
    index += frames;
  }
  if (index !== audioLength) contiguous = false;
  return { runs, contiguous, chunks: chunks.length, frames: index };
}

/** Audio index of sample number n when [n, n + length) was recorded in one run; else null. */
export function audioIndex(layout: ChunkLayout, n: number, length = 1): number | null {
  for (const r of layout.runs) {
    if (n >= r.n0 && n + length <= r.n1) return r.index0 + (n - r.n0);
  }
  return null;
}

/** First and one-past-last recorded sample numbers; null without chunks. */
export function recordedSpan(layout: ChunkLayout): { n0: number; n1: number } | null {
  if (layout.runs.length === 0) return null;
  let n0 = layout.runs[0]!.n0;
  let n1 = layout.runs[0]!.n1;
  for (const r of layout.runs) {
    n0 = Math.min(n0, r.n0);
    n1 = Math.max(n1, r.n1);
  }
  return { n0, n1 };
}

/** A click run longer apart than this starts a new loop check. */
const CLICK_GROUP_GAP_SAMPLES = 3 * SAMPLE_RATE_HZ;

/**
 * Click starts (sample numbers) of loop checks A and B from the `click` stamps. A new group
 * starts when `i` restarts or after a 3 s gap. Only a group of all 10 clicks is a loop check:
 * A is the first, B the last of two or more. Other groups (the demo double's three sync clicks,
 * spec 7.3, or a check cut short) are ignored, so a missing check B gives null.
 */
export function loopClickBlocks(stamps: readonly Stamp[]): { A: number[] | null; B: number[] | null } {
  const groups: Stamp[][] = [];
  let prev: Stamp | null = null;
  for (const s of stamps) {
    if (s.k !== 'click') continue;
    const restart =
      prev === null ||
      s.n - prev.n > CLICK_GROUP_GAP_SAMPLES ||
      (typeof s.i === 'number' && typeof prev.i === 'number' && s.i <= prev.i);
    if (restart) groups.push([]);
    groups[groups.length - 1]!.push(s);
    prev = s;
  }
  const checks = groups.filter((g) => g.length === CLICK_COUNT);
  const first = checks[0];
  const last = checks.length > 1 ? checks[checks.length - 1] : undefined;
  return { A: first ? first.map((s) => s.n) : null, B: last ? last.map((s) => s.n) : null };
}

/** nArr by packet seq, from the `arr` stamps (first stamp of a seq wins). */
export function arrivalsBySeq(stamps: readonly Stamp[]): Map<number, number> {
  const out = new Map<number, number>();
  for (const s of stamps) {
    if (s.k === 'arr' && typeof s.seq === 'number' && !out.has(s.seq)) out.set(s.seq, s.n);
  }
  return out;
}

function packetLines(session: SessionData): Array<{ line: SampleLine; nArr: number }> {
  const arr = arrivalsBySeq(session.stamps);
  const out: Array<{ line: SampleLine; nArr: number }> = [];
  for (const line of session.samples) {
    if (line.k !== 'm' || line.seq === undefined) continue;
    const nArr = arr.get(line.seq);
    if (nArr !== undefined) out.push({ line, nArr });
  }
  return out;
}

/** Arrival and newest camera timestamp of every packet with an `arr` stamp. */
export function packetTimes(session: SessionData): PacketTime[] {
  const out: PacketTime[] = [];
  for (const { line, nArr } of packetLines(session)) {
    let ts = Number.NEGATIVE_INFINITY;
    for (const [t] of line.tr ?? []) if (t > ts) ts = t;
    if (line.lm && line.lm.ts > ts) ts = line.lm.ts;
    if (Number.isFinite(ts)) out.push({ nArr, tsUs: ts });
  }
  return out;
}

/** Lip gap per frame (landmark timestamp), skipping reset frames and null gaps. */
export function lipFrames(session: SessionData): LipFrame[] {
  const out: LipFrame[] = [];
  for (const { line, nArr } of packetLines(session)) {
    if (!line.lm || line.lm.reset || typeof line.g !== 'number' || !Number.isFinite(line.g)) continue;
    out.push({ tsUs: line.lm.ts, g: line.g, nArr });
  }
  return out;
}

/** Trace samples of every packet with its nArr, in file order. */
export function tracePackets(session: SessionData): TracePacket[] {
  return packetLines(session).map(({ line, nArr }) => ({ nArr, tr: line.tr ?? [] }));
}

/** Unique trace timestamps of the session, ascending (us). */
export function traceTimestamps(samples: readonly SampleLine[]): number[] {
  const seen = new Set<number>();
  for (const line of samples) {
    if (line.k !== 'm') continue;
    for (const [ts] of line.tr ?? []) seen.add(ts);
  }
  return [...seen].sort((a, b) => a - b);
}

/** Arrival of a samples.jsonl line on tap's clock (`tArrNs`, a string of ns), in us; null when unreadable. */
function arrivalUs(line: SampleLine): number | null {
  if (typeof line.tArrNs !== 'string' || line.tArrNs === '') return null;
  const ns = Number(line.tArrNs);
  return Number.isFinite(ns) ? ns / 1000 : null;
}

/**
 * Unique trace timestamps of the recording's trace, ascending (us), strays left out. Within one
 * run ts minus the arrival of its line (tArrNs, tap's monotonic clock) stays constant up to
 * latency and drift; a sample whose difference lies more than `toleranceS` from the median one
 * is a stray: ts 0, another epoch, nanoseconds (tap's reduce accepts any first sample, spec 7.1).
 * Samples of lines without a readable tArrNs are kept: nothing tells them apart.
 */
export function traceRunTimestamps(samples: readonly SampleLine[], toleranceS: number = TRACE_STRAY_TOLERANCE_S): number[] {
  const arrival = new Map<number, number | null>();
  for (const line of samples) {
    if (line.k !== 'm') continue;
    const arr = arrivalUs(line);
    for (const [ts] of line.tr ?? []) {
      if (Number.isFinite(ts) && !arrival.has(ts)) arrival.set(ts, arr);
    }
  }
  const offsets: number[] = [];
  for (const [ts, arr] of arrival) if (arr !== null) offsets.push(ts - arr);
  const mid = median(offsets);
  const kept: number[] = [];
  for (const [ts, arr] of arrival) {
    if (arr === null || mid === null || Math.abs(ts - arr - mid) <= toleranceS * 1e6) kept.push(ts);
  }
  return kept.sort((a, b) => a - b);
}
