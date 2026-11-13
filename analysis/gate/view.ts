// The time layout of a day-one recording and the cut at the objection block (spec 9.3, 9.5).
// Stage A reads only data before the "objections" step mark (4:15): every input is sliced by
// sample number here, before any computation (spec 9.5 step 4).

import { nArrMapFromStamps, type DetectorInput, type StampLike } from '../../core/detector.ts';
import type { GatePack } from '../../core/schemas/index.ts';
import type { SpanSamples } from '../rivals/index.ts';
import { objectionBlockEnd } from '../lib/conditions.ts';
import { cueStarts } from '../lib/measure.ts';
import { recordedRange, stepStart, type LoadedSession } from '../lib/session.ts';
import { gateSteps, type GateSteps } from '../lib/steps.ts';
import { GateRefusal } from './common.ts';

export interface GateLayout {
  pack: Exclude<GatePack, '0'>;
  gate: GateSteps;
  /** First sample of the objection block: the "objections" step mark (spec 9.3, 4:15). */
  nCut: number;
  /** Listening block: from its step mark to nCut (the tuning block of stage A). */
  listening: SpanSamples;
  /** Scored block: from nCut to the first step after the cues, or the end of the recording. */
  scored: SpanSamples;
}

/** Pack of a gate recording; refuses other records and the short probe (spec 9.4). */
export function gatePackOfSession(s: Pick<LoadedSession, 'kind' | 'manifest'>): Exclude<GatePack, '0'> {
  if (s.kind !== 'gate') throw new GateRefusal(`analyze:gate reads day-one gate recordings; this one is a ${s.kind} record`);
  const pack = s.manifest.pack;
  if (pack === 'A' || pack === 'B' || pack === 'C') return pack;
  throw new GateRefusal(`analyze:gate needs a full pack (A, B or C); this recording has pack ${String(pack)} (the probe is not scored, spec 9.4)`);
}

/** Step marks only: the part of the layout stage A may read (all marks at or before the cut). */
export function cutOf(s: Pick<LoadedSession, 'stamps'>, gate: GateSteps): { nCut: number; listening: SpanSamples } {
  const nCut = stepStart(s, gate.objections);
  if (nCut === null) throw new GateRefusal(`no "${gate.objections}" step mark in stamps.jsonl: the objection block never started`);
  const n0 = stepStart(s, gate.listening);
  if (n0 === null || n0 >= nCut) throw new GateRefusal(`no "${gate.listening}" step mark before the objection block`);
  return { nCut, listening: { n0, n1: nCut } };
}

/** The whole layout (stage B). */
export function gateLayout(s: LoadedSession): GateLayout {
  const pack = gatePackOfSession(s);
  const gate = gateSteps(pack);
  const { nCut, listening } = cutOf(s, gate);
  const end = objectionBlockEnd(s, gate);
  const recEnd = recordedRange(s)?.n1 ?? nCut;
  const lastN = Math.max(recEnd, ...s.stamps.map((x) => x.n));
  const n1 = Number.isFinite(end) ? end : lastN;
  return { pack, gate, nCut, listening, scored: { n0: nCut, n1: Math.max(nCut, n1) } };
}

/** Cue starts inside the scored block, ascending (spec 9.2: the dot fills). */
export function scoredCues(s: LoadedSession, layout: GateLayout): number[] {
  return [...cueStarts(s, layout.gate.cueOn)].filter((n) => n >= layout.scored.n0 && n < layout.scored.n1).sort((a, b) => a - b);
}

// ---- slicing at the cut -----------------------------------------------------------------

/** Stamps with n before the cut. */
export function stampsBefore<T extends { n: number }>(stamps: readonly T[], nCut: number): T[] {
  return stamps.filter((x) => x.n < nCut);
}

/** nArr by seq from the "arr" stamps before the cut. */
export function arrivalsBefore(stamps: readonly StampLike[], nCut: number): Map<number, number> {
  return nArrMapFromStamps(stampsBefore(stamps, nCut));
}

/**
 * detector_in.jsonl lines before the cut. The file order is the processing order (spec 8.1), so
 * the prefix ends at the first line known to lie at or after the cut: a voice or state line with
 * n >= nCut, or a packet that arrived after it (no "arr" stamp before the cut and a seq above every
 * seq that has one). A packet without a stamp inside the prefix keeps its place (runPosthoc estimates it).
 */
export function detectorInBefore(lines: readonly DetectorInput[], nArrBefore: ReadonlyMap<number, number>, nCut: number): DetectorInput[] {
  return lines.slice(0, detectorInPrefixLength(lines, nArrBefore, nCut));
}

/** Number of detector_in.jsonl lines before the cut: the index of the first line known to lie at or after it. */
export function detectorInPrefixLength(lines: readonly DetectorInput[], nArrBefore: ReadonlyMap<number, number>, nCut: number): number {
  const maxSeq = maxSeqOf(nArrBefore);
  for (let i = 0; i < lines.length; i++) {
    const r = lines[i]!;
    if (r.k === 'voice' || r.k === 'state') {
      if (!(r.n < nCut)) return i;
    } else {
      const n = nArrBefore.get(r.seq);
      if (n === undefined ? !(r.seq < maxSeq) : !(n < nCut)) return i;
    }
  }
  return lines.length;
}

/** The largest seq with an "arr" stamp before the cut; -Infinity without one. */
export function maxSeqOf(nArrBefore: ReadonlyMap<number, number>): number {
  let maxSeq = Number.NEGATIVE_INFINITY;
  for (const seq of nArrBefore.keys()) if (seq > maxSeq) maxSeq = seq;
  return maxSeq;
}

/**
 * samples.jsonl lines of the prefix: seq up to the last packet that arrived before the cut (tap
 * numbers packets in arrival order, spec 7.1), so every packet of the detector_in prefix is there.
 */
export function samplesBefore<T extends { seq?: unknown }>(samples: readonly T[], nArrBefore: ReadonlyMap<number, number>): T[] {
  const maxSeq = maxSeqOf(nArrBefore);
  return samples.filter((l) => typeof l.seq === 'number' && l.seq <= maxSeq);
}

/** The last known position of a run's lines (nArr for packets, n otherwise). */
export function lastPositionSamples(lines: readonly DetectorInput[], nArrBySeq: ReadonlyMap<number, number>): number {
  let last = Number.NEGATIVE_INFINITY;
  for (const r of lines) {
    const n = r.k === 'batch' || r.k === 'val' ? nArrBySeq.get(r.seq) : r.n;
    if (n !== undefined && n > last) last = n;
  }
  return last;
}
