// Flashes against clicks (spec 15.4): which offset puts the click stamps of stamps.jsonl on the
// flash onsets of the screen recording. Pure.
//
// The clicks come in blocks with unequal gaps (loop check A, the three demo clicks, loop check B),
// so one offset lines up many of them and any other offset lines up few. Every flash-click pair
// proposes an offset; the one that puts the most clicks on a flash wins, and among equals the one
// that puts the fewest clicks inside the recording with no flash there. One missing or extra flash
// costs a point, while a wrong offset loses whole blocks. Loop checks A and B share one pattern:
// when only one of them is in the recording and nothing else tells them apart, it is refused as
// ambiguous. The offset is the median of t_video - n / 48000 over the matched clicks. A flash
// within PAIR_WINDOW_S of a click's predicted place counts as that click's flash, however late, so
// a late flash widens the spread instead of vanishing; a spread over 2 frames refuses the recording.

import { median } from './flash.ts';

export interface ClickRef {
  /** Sample number on the session clock. */
  n: number;
  /** "loop A 3", "demo 1", for the printout. */
  label: string;
}

export interface MatchOptions {
  sampleRateHz: number;
  /** One frame of the recording, seconds. */
  frameS: number;
  /** Recording time covered by frames: [first frame, last frame + one frame]. */
  span: [number, number];
  /** Voting tolerance in frames (default 2). */
  tolFrames?: number;
  /** Largest allowed spread of the residuals, in frames (default 2). */
  maxSpreadFrames?: number;
  /** At least this many clicks must match (default 3). */
  minMatches?: number;
}

export interface MatchedPair {
  click: ClickRef;
  /** Click time on the session clock, s. */
  clickS: number;
  /** Flash onset in the recording, s. */
  flashS: number;
  /** flashS - (clickS + offset), s. */
  residualS: number;
}

export interface MatchResult {
  /** Recording time = session time + offsetS. */
  offsetS: number;
  pairs: MatchedPair[];
  /** Clicks that fall inside the recording with no flash near them. */
  missed: ClickRef[];
  /** Clicks that fall outside the recording. */
  outside: number;
  /** Flash onsets that belong to no click. */
  extra: number[];
  /** max - min of the residuals, s. */
  spreadS: number;
  /** The limit the spread is held to, s. */
  limitS: number;
  /** Clicks on a flash and clicks inside the recording without one, at the voting offset. */
  votes: { matched: number; missed: number };
  /** The best offset that lines the clicks up another way, with its counts; null when there is none. */
  runnerUp: { offsetS: number; matched: number; missed: number } | null;
}

export type MatchOutcome = { ok: true; result: MatchResult } | { ok: false; why: string; result: MatchResult | null };

/** A flash this close to a click's predicted place is that click's flash for the spread (s). */
export const PAIR_WINDOW_S = 0.25;

/** Index of the onset nearest to t in an ascending array; -1 when empty. */
function nearest(sorted: readonly number[], t: number): number {
  let lo = 0;
  let hi = sorted.length - 1;
  if (hi < 0) return -1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if ((sorted[mid] as number) < t) lo = mid + 1;
    else hi = mid;
  }
  if (lo > 0 && Math.abs((sorted[lo - 1] as number) - t) <= Math.abs((sorted[lo] as number) - t)) return lo - 1;
  return lo;
}

interface Tally {
  offsetS: number;
  matched: number;
  missed: number;
  absSum: number;
}

/** Clicks put on a flash within tol, and clicks put inside the recording with none, at one offset. */
function tally(clickS: readonly number[], onsets: readonly number[], d: number, tol: number, span: readonly [number, number]): Tally {
  let matched = 0;
  let missed = 0;
  let absSum = 0;
  for (const c of clickS) {
    const p = c + d;
    const j = nearest(onsets, p);
    const err = j < 0 ? Infinity : Math.abs((onsets[j] as number) - p);
    if (err <= tol) {
      matched++;
      absSum += err;
    } else if (p >= span[0] + tol && p <= span[1] - tol) {
      missed++;
    }
  }
  return { offsetS: d, matched, missed, absSum };
}

function better(a: Tally, b: Tally | null): boolean {
  if (b === null) return true;
  if (a.matched !== b.matched) return a.matched > b.matched;
  if (a.missed !== b.missed) return a.missed < b.missed;
  return a.absSum < b.absSum;
}

/** The offset that puts the clicks on the flashes, its residuals, or why there is none. */
export function matchFlashes(onsetsIn: readonly number[], clicks: readonly ClickRef[], o: MatchOptions): MatchOutcome {
  const tol = (o.tolFrames ?? 2) * o.frameS;
  const limitS = (o.maxSpreadFrames ?? 2) * o.frameS;
  const minMatches = o.minMatches ?? 3;
  const onsets = [...onsetsIn].sort((a, b) => a - b);
  const sorted = [...clicks].sort((a, b) => a.n - b.n);
  const clickS = sorted.map((c) => c.n / o.sampleRateHz);
  if (sorted.length === 0) return { ok: false, why: 'stamps.jsonl has no click stamps', result: null };
  if (onsets.length === 0) return { ok: false, why: 'no flashes were found in the recording', result: null };

  let best: Tally | null = null;
  const all: Tally[] = [];
  for (const f of onsets) {
    for (const c of clickS) {
      const t = tally(clickS, onsets, f - c, tol, o.span);
      all.push(t);
      if (better(t, best)) best = t;
    }
  }
  if (best === null) return { ok: false, why: 'no flashes were found in the recording', result: null };
  let runner: Tally | null = null;
  for (const t of all) if (Math.abs(t.offsetS - best.offsetS) > 2 * tol && better(t, runner)) runner = t;

  // Refine: the median over the clicks matched at the best offset, then pair every click with the
  // nearest flash within PAIR_WINDOW_S and take the median again.
  const firstPairs: number[] = [];
  for (const c of clickS) {
    const j = nearest(onsets, c + best.offsetS);
    if (j >= 0 && Math.abs((onsets[j] as number) - (c + best.offsetS)) <= tol) firstPairs.push((onsets[j] as number) - c);
  }
  let offsetS = median(firstPairs) ?? best.offsetS;
  const window = Math.max(PAIR_WINDOW_S, tol);
  const pairUp = (d: number): { pairs: MatchedPair[]; used: Set<number>; missed: ClickRef[]; outside: number } => {
    const pairs: MatchedPair[] = [];
    const used = new Set<number>();
    const missed: ClickRef[] = [];
    let outside = 0;
    sorted.forEach((click, i) => {
      const c = clickS[i] as number;
      const p = c + d;
      const j = nearest(onsets, p);
      if (j >= 0 && !used.has(j) && Math.abs((onsets[j] as number) - p) <= window) {
        used.add(j);
        pairs.push({ click, clickS: c, flashS: onsets[j] as number, residualS: 0 });
      } else if (p >= o.span[0] && p <= o.span[1]) {
        missed.push(click);
      } else {
        outside++;
      }
    });
    return { pairs, used, missed, outside };
  };
  let paired = pairUp(offsetS);
  offsetS = median(paired.pairs.map((p) => p.flashS - p.clickS)) ?? offsetS;
  paired = pairUp(offsetS);
  for (const p of paired.pairs) p.residualS = p.flashS - (p.clickS + offsetS);
  const res = paired.pairs.map((p) => p.residualS);
  const spreadS = res.length > 0 ? Math.max(...res) - Math.min(...res) : 0;
  const result: MatchResult = {
    offsetS,
    pairs: paired.pairs,
    missed: paired.missed,
    outside: paired.outside,
    extra: onsets.filter((_, j) => !paired.used.has(j)),
    spreadS,
    limitS,
    votes: { matched: best.matched, missed: best.missed },
    runnerUp: runner === null ? null : { offsetS: runner.offsetS, matched: runner.matched, missed: runner.missed },
  };

  if (best.matched < minMatches) {
    return { ok: false, why: `only ${best.matched} of ${sorted.length} clicks line up with a flash (at least ${minMatches} are needed)`, result };
  }
  // Another offset about as good on both counts: nothing in the recording says which one is true.
  if (runner !== null && runner.matched >= Math.max(minMatches, best.matched - 1) && runner.missed <= best.missed + 1) {
    return {
      ok: false,
      why:
        `the flashes fit the clicks at two offsets, ${best.offsetS.toFixed(3)} s (${best.matched} clicks) and ` +
        `${runner.offsetS.toFixed(3)} s (${runner.matched} clicks): the recording holds too few click blocks to tell them apart`,
      result,
    };
  }
  if (spreadS > limitS + 1e-9) {
    return {
      ok: false,
      why: `the residuals spread over ${(spreadS * 1000).toFixed(1)} ms, more than ${o.maxSpreadFrames ?? 2} frames (${(limitS * 1000).toFixed(1)} ms)`,
      result,
    };
  }
  return { ok: true, result };
}
