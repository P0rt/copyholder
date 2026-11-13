// Third chance-level estimate of spec 4.3 (spec 7.10: pseudo voice onsets after sentence
// ends without an objection, at the median response latency).
// After each end of a narrator's sentence that no objection follows, a pseudo voice onset
// is put at end + the median response latency. "No objection follows" means no objection
// begins within the catch window's length after the end (spec 4.3). A point whose window
// [t - W, t) does not lie in active time by the rule of spec 4.3 (armed.ts) is dropped.
// The estimate is the share of the remaining points with a chest stop t_s in [t - W, t),
// pooled over all sessions like the other two (spec 8.6).
// Times are ms on each session's clock (sample index / 48 at 48 kHz).

import { type ChestFireMs, armedCheckEndMs, checkChestFires, checkWindowMs } from './armed.ts';
import { type IntervalMs, firstIndexAtOrAfter, isSpanCoveredMs, normalizeIntervalsMs } from './intervals.ts';
import { CHANCE_WINDOW_MS } from './poisson.ts';
import { assertFiniteNumber, sortedFiniteCopy } from './validate.ts';

/**
 * Catch window close after the end of a planted span (spec 4.2; scoring_rules.json
 * catch_close_after_span_end_ms, which may grow to 8000 by the rule of spec 10.2). Its
 * final value is the "length of the catch window" of the third estimate.
 */
export const CATCH_CLOSE_AFTER_SPAN_END_MS = 5_000;

export interface PseudoOnsetSession {
  /** Ends of the narrator's sentences (sentence_ends.json), ms on the session clock. */
  sentenceEndsMs: readonly number[];
  /** Voice onsets t_v of every objection of the session (spec 4.2), ms. */
  objectionOnsetsMs: readonly number[];
  /** Active time of the session (spec 4.2), ms. */
  activeMs: readonly IntervalMs[];
  /** Chest-detector fires with their stops (spec 4.2), ms. */
  fires: readonly ChestFireMs[];
}

export interface PseudoOnsetOptions {
  /**
   * Median response latency in ms: from the end of the planted span to t_v, median over
   * the caught plants of the same sessions (spec 4.3).
   */
  responseLatencyMs: number;
  /**
   * An objection beginning in [end, end + noObjectionMs] follows a sentence end. Default
   * 5000 ms; pass the final catch_close_after_span_end_ms of scoring_rules.json.
   */
  noObjectionMs?: number;
  /** Window W before the point; default 1500 ms (spec 4.2). */
  windowMs?: number;
}

/**
 * objection: an objection follows the sentence end, no point is placed.
 * not-armed: the window before the point is not in active time, the point is dropped.
 * hit: a chest stop lies in [t - W, t). miss: none does.
 */
export type PseudoOnsetOutcome = 'objection' | 'not-armed' | 'hit' | 'miss';

export interface PseudoOnsetPoint {
  sentenceEndMs: number;
  /** The pseudo voice onset t = sentenceEndMs + responseLatencyMs. */
  pointMs: number;
  outcome: PseudoOnsetOutcome;
}

interface ResolvedOptions {
  responseLatencyMs: number;
  noObjectionMs: number;
  windowMs: number;
}

function resolveOptions(options: PseudoOnsetOptions): ResolvedOptions {
  const resolved = {
    responseLatencyMs: options.responseLatencyMs,
    noObjectionMs: options.noObjectionMs ?? CATCH_CLOSE_AFTER_SPAN_END_MS,
    windowMs: options.windowMs ?? CHANCE_WINDOW_MS,
  };
  assertFiniteNumber(resolved.responseLatencyMs, 'responseLatencyMs');
  assertFiniteNumber(resolved.noObjectionMs, 'noObjectionMs');
  if (resolved.noObjectionMs < 0) throw new RangeError(`noObjectionMs must be >= 0, got ${resolved.noObjectionMs}`);
  checkWindowMs(resolved.windowMs);
  return resolved;
}

function classifySession(session: PseudoOnsetSession, o: ResolvedOptions, index: number): PseudoOnsetPoint[] {
  const name = `sessions[${index}]`;
  const ends = sortedFiniteCopy(session.sentenceEndsMs, `${name}.sentenceEndsMs`);
  const objections = sortedFiniteCopy(session.objectionOnsetsMs, `${name}.objectionOnsetsMs`);
  const active = normalizeIntervalsMs(session.activeMs, `${name}.activeMs`);
  checkChestFires(session.fires, `${name}.fires`);
  const stops = session.fires.map((f) => f.stopMs).sort((a, b) => a - b);

  return ends.map((sentenceEndMs): PseudoOnsetPoint => {
    const pointMs = sentenceEndMs + o.responseLatencyMs;
    const next = objections[firstIndexAtOrAfter(objections, sentenceEndMs)];
    if (next !== undefined && next <= sentenceEndMs + o.noObjectionMs) {
      return { sentenceEndMs, pointMs, outcome: 'objection' };
    }
    const windowStartMs = pointMs - o.windowMs;
    if (!isSpanCoveredMs(active, windowStartMs, armedCheckEndMs(pointMs, session.fires, o.windowMs))) {
      return { sentenceEndMs, pointMs, outcome: 'not-armed' };
    }
    const stop = stops[firstIndexAtOrAfter(stops, windowStartMs)];
    return { sentenceEndMs, pointMs, outcome: stop !== undefined && stop < pointMs ? 'hit' : 'miss' };
  });
}

/** Pseudo onsets of one session with the outcome of each, sorted by sentence end. */
export function pseudoOnsetPoints(session: PseudoOnsetSession, options: PseudoOnsetOptions): PseudoOnsetPoint[] {
  return classifySession(session, resolveOptions(options), 0);
}

export interface PseudoOnsetResult {
  /** hits / points over all sessions: the third chance-level estimate; null without points. */
  share: number | null;
  sentenceEnds: number;
  /** Sentence ends followed by an objection: no point. */
  followedByObjection: number;
  /** Points dropped because their window was not in active time. */
  notArmed: number;
  /** Points kept: the denominator. */
  points: number;
  /** Kept points with a chest stop in the window before them. */
  hits: number;
  responseLatencyMs: number;
  noObjectionMs: number;
  windowMs: number;
}

/** Third chance-level estimate of spec 4.3, pooled over the sessions. */
export function pseudoOnsetChanceLevel(
  sessions: readonly PseudoOnsetSession[],
  options: PseudoOnsetOptions,
): PseudoOnsetResult {
  const o = resolveOptions(options);
  const counts = { sentenceEnds: 0, followedByObjection: 0, notArmed: 0, points: 0, hits: 0 };
  sessions.forEach((session, i) => {
    for (const p of classifySession(session, o, i)) {
      counts.sentenceEnds++;
      if (p.outcome === 'objection') counts.followedByObjection++;
      else if (p.outcome === 'not-armed') counts.notArmed++;
      else {
        counts.points++;
        if (p.outcome === 'hit') counts.hits++;
      }
    }
  });
  return { share: counts.points === 0 ? null : counts.hits / counts.points, ...counts, ...o };
}
