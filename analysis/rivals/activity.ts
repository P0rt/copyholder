// Post-hoc rivals on SDK data (spec 7.5): each one runs the recording with its own stop model
// (core/detector runPosthoc), its own hold wait and its own 2.0 s post-fire period. Activity uses
// only detector-independent facts: voice edges, signal validity and the reading schedule.
// Positions are samples of the 48 kHz mic clock: nArr for a packet, n for voice and state lines.

import {
  INVALID_VALIDATION_CODES,
  REARM_MS,
  REFRACTORY_MS,
  msToSamples,
  type BatchInput,
  type DetectorInput,
  type NarratorState,
  type PosthocArmed,
  type PosthocDetector,
  type PosthocStepOutput,
} from '../../core/detector.ts';

export interface RivalTiming {
  /** Own post-fire period, counted from the fire's nArr: 2.0 s (spec 7.5). */
  refractorySamples: number;
  /** Quiet after voice_off before the rival is active again: 4.0 s (spec 4.2, 7.4 table). */
  postVoiceSamples: number;
}

export const DEFAULT_RIVAL_TIMING: Readonly<RivalTiming> = Object.freeze({
  refractorySamples: msToSamples(REFRACTORY_MS),
  postVoiceSamples: msToSamples(REARM_MS),
});

/** What a rival reports when it fires: the value that met its threshold. */
export interface RivalFire {
  rule: string;
  value: number;
  threshold: number;
}

/** The answer of a rule on one packet. */
export interface PacketVerdict {
  /** The rule can fire at all (its baseline exists, the packet carries a usable value). */
  ready: boolean;
  /** Set when the rule held on this packet while the rival was active. */
  fire: RivalFire | null;
}

/** A rival's own rule on SDK packets; the activity around it is shared. */
export interface PacketRule<R> {
  init(): R;
  /**
   * Called on every packet in file order, active or not, so baselines can follow the signal.
   * `active` is the shared activity; a rule must fire only while it is true.
   */
  onPacket(rule: R, input: BatchInput, active: boolean): PacketVerdict;
}

export interface RivalState<R> {
  narr: NarratorState | null;
  voiceOn: boolean;
  voiceOffN: number;
  codeInvalid: boolean;
  lastFireN: number;
  /** Last known position (samples). */
  pos: number;
  /** Readiness from the last packet. */
  ready: boolean;
  active: boolean;
  rule: R;
}

export interface SdkRivalOptions {
  /** Arrival samples of the packets (stamps.jsonl "arr" lines). */
  nArrBySeq: ReadonlyMap<number, number>;
  timing?: RivalTiming;
  /** validationStatus codes that make the signal unusable (spec 7.1, d1.invalid_codes). */
  invalidCodes?: readonly number[];
}

/** Position of a line: nArr for packets and codes, n for voice and state lines; null if unknown. */
export function linePositionSamples(input: DetectorInput, nArrBySeq: ReadonlyMap<number, number>): number | null {
  switch (input.k) {
    case 'batch':
    case 'val': {
      const n = nArrBySeq.get(input.seq);
      if (n !== undefined) return n;
      const own = (input as { nArr?: unknown }).nArr;
      return typeof own === 'number' && Number.isFinite(own) ? own : null;
    }
    default:
      return input.n;
  }
}

/**
 * Shared activity at sample n (spec 4.2, 7.5): the own narrator reads, no voice, 4.0 s since the
 * last voice_off, no invalid validation code, 2.0 s since the own fire. The own stop shows as a
 * narrator state other than "narrating" until the runner resumes reading.
 */
export function sharedActive(s: Pick<RivalState<unknown>, 'narr' | 'voiceOn' | 'voiceOffN' | 'codeInvalid' | 'lastFireN'>, n: number, t: RivalTiming): boolean {
  return (
    s.narr === 'narrating' &&
    !s.voiceOn &&
    n >= s.voiceOffN + t.postVoiceSamples &&
    !s.codeInvalid &&
    n >= s.lastFireN + t.refractorySamples
  );
}

/**
 * A post-hoc detector from a packet rule. It keeps its own post-fire period (2.0 s and the end of
 * its own stop), so the runner does not drop its holds (ownPostFirePeriod).
 */
export function sdkRivalPosthoc<R>(name: string, rule: PacketRule<R>, opts: SdkRivalOptions): PosthocDetector<RivalState<R>, RivalFire> {
  const timing = opts.timing ?? DEFAULT_RIVAL_TIMING;
  const invalid = new Set(opts.invalidCodes ?? INVALID_VALIDATION_CODES);
  const map = opts.nArrBySeq;
  return {
    name,
    ownPostFirePeriod: true,
    init: (): RivalState<R> => ({
      narr: null,
      voiceOn: false,
      voiceOffN: Number.NEGATIVE_INFINITY,
      codeInvalid: false,
      lastFireN: Number.NEGATIVE_INFINITY,
      pos: Number.NEGATIVE_INFINITY,
      ready: false,
      active: false,
      rule: rule.init(),
    }),
    step(s: RivalState<R>, input: DetectorInput): PosthocStepOutput<RivalState<R>, RivalFire> {
      const known = linePositionSamples(input, map);
      if (known !== null && known > s.pos) s.pos = known;
      const n = known ?? s.pos;
      const was = s.active;
      let fire: RivalFire | null = null;
      switch (input.k) {
        case 'val':
          s.codeInvalid = invalid.has(input.code);
          break;
        case 'voice':
          s.voiceOn = input.on;
          if (!input.on) s.voiceOffN = n;
          break;
        case 'state':
          s.narr = input.s;
          break;
        case 'batch': {
          const base = sharedActive(s, n, timing);
          const v = rule.onPacket(s.rule, input, base);
          s.ready = v.ready;
          if (base && v.ready && v.fire !== null && Number.isFinite(n)) {
            fire = v.fire;
            s.lastFireN = n;
          }
          break;
        }
        default:
          break;
      }
      s.active = fire === null && s.ready && sharedActive(s, n, timing);
      const out: PosthocStepOutput<RivalState<R>, RivalFire> = { state: s, hold: fire !== null };
      if (fire !== null) out.fire = fire;
      if (s.active !== was) out.armed = s.active;
      return out;
    },
  };
}

// ---- active time from the runner's armed changes ---------------------------------------------

/** Half-open span of samples [n0, n1). */
export interface SpanSamples {
  n0: number;
  n1: number;
}

/** Active spans from the armed changes of a post-hoc run; an open span ends at endN. */
export function activeSpansSamples(armed: readonly PosthocArmed[], endN: number): SpanSamples[] {
  const out: SpanSamples[] = [];
  let start: number | null = null;
  for (const a of armed) {
    if (a.on) {
      if (start === null) start = a.n;
    } else if (start !== null) {
      if (a.n > start) out.push({ n0: start, n1: a.n });
      start = null;
    }
  }
  if (start !== null && endN > start) out.push({ n0: start, n1: endN });
  return out;
}

/** Samples of `spans` inside [n0, n1). */
export function overlapSamples(spans: readonly SpanSamples[], n0: number, n1: number): number {
  let sum = 0;
  for (const s of spans) sum += Math.max(0, Math.min(s.n1, n1) - Math.max(s.n0, n0));
  return sum;
}
