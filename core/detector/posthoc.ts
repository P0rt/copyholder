// Post-hoc runs over a recorded detector_in.jsonl with the detector's own stop model
// (spec 7.5 "Своя модель остановок", 9.6): own stops, own hold wait, own post-fire period.
// The run sees only detector-independent facts: voice edges, signal validity and the reading
// schedule. The live stops recorded in the session are not visible to it.

import { initDetector, stepMut, type DetectorState, type FrozenParamsLike } from './d1.ts';
import { HOLD_WAIT_SAMPLES, RAMP_SAMPLES, REFRACTORY_MS, SAMPLE_RATE_HZ, msToSamples, type D1ParamsInput } from './params.ts';
import type { DetectorInput, Fire, NarratorState, Sign, Variant } from './types.ts';

/** One answer of a detector step; `state` is the state to use next (it may be the same object). */
export interface PosthocStepOutput<S, F> {
  state: S;
  hold: boolean;
  fire?: F;
  armed?: boolean;
}

/**
 * What a detector offers to be run after the recording: D1 and D3 here, the rivals G, T and M
 * later (spec 7.5). step() may update the state in place. The runner tells the detector about
 * its own stops through narrator state lines (hold_wait, listening, resume, narrating).
 */
export interface PosthocDetector<S, F = unknown> {
  readonly name: string;
  init(): S;
  step(state: S, input: DetectorInput): PosthocStepOutput<S, F>;
  /**
   * True when the detector keeps the 2.0 s post-fire period itself (D1 and D3 do, on the 30 Hz
   * grid, spec 7.4). Otherwise the runner keeps it: after an own stop, holds are dropped until
   * the stop has ended and 2.0 s of samples have passed since the fire (spec 7.5).
   */
  readonly ownPostFirePeriod?: boolean;
}

/** D1 or D3 as a post-hoc detector; params as for initDetector (d1 fields or params/frozen.json). */
export function d1Posthoc(
  params: D1ParamsInput | FrozenParamsLike = {},
  sign: Sign = 1,
  variant: Variant = 'D1',
): PosthocDetector<DetectorState, Fire> {
  return { name: variant, init: () => initDetector(params, sign, variant), step: stepMut, ownPostFirePeriod: true };
}

export interface PosthocOptions<S, F> {
  detector: PosthocDetector<S, F>;
  /** Arrival sample nArr of each packet, from the stamps.jsonl "arr" lines (spec 6.3, 8.1). */
  nArrBySeq: ReadonlyMap<number, number>;
  /** Hold wait H in samples, counted from nSilent (spec 6.4): 72 000. */
  holdWaitSamples?: number;
  /** Fade length: a post-hoc stop is nSilent = nArr + 384 (spec 6.3). */
  rampSamples?: number;
  /** Post-fire period kept by the runner for detectors without their own: 2.0 s = 96 000 samples. */
  postFireSamples?: number;
  /** Return the input sequence the detector saw: recorded lines plus its own narrator lines. */
  keepInputs?: boolean;
}

export interface PosthocFire<F> {
  /** Index of the firing line in the recorded inputs. */
  index: number;
  seq: number;
  /** Arrival sample of the firing packet: the fire time (spec 6.3). */
  nArr: number | null;
  /** True when the packet had no "arr" stamp and the last known position stands in. */
  nArrEstimated: boolean;
  /** False when the own narrator was not reading: Deck would only log such a hold (spec 6.4). */
  accepted: boolean;
  fire: F | undefined;
}

export interface PosthocStop {
  seq: number;
  nCmd: number;
  /** nArr + 384 (spec 6.3). */
  nSilent: number;
  /** Where the own narrator reads again; null if the recording ended inside the stop. */
  nResume: number | null;
  why: 'timeout' | 'voice_off' | 'schedule' | null;
}

export interface PosthocArmed {
  /** Sample position of the line where activity changed (nArr for a packet). */
  n: number;
  on: boolean;
  index: number;
}

export interface PosthocResult<F> {
  fires: PosthocFire<F>[];
  stops: PosthocStop[];
  armed: PosthocArmed[];
  /** Active time in samples (spec 4.2 "Активное время"), from the armed changes. */
  activeSamples: number;
  activeMinutes: number;
  /** Holds dropped by the runner's post-fire period (detectors without their own). */
  suppressed: number;
  /** Packets with no "arr" stamp. */
  missingArrSeqs: number[];
  inputs?: DetectorInput[];
}

type OwnDeck = 'off' | 'narrating' | 'hold_wait' | 'listening';

/** A recorded line's own nArr, as stream.jsonl lines carry it (spec 8.7). */
function ownNArr(r: DetectorInput): number | null {
  const n = (r as { nArr?: unknown }).nArr;
  return typeof n === 'number' && Number.isFinite(n) ? n : null;
}

function positionOf(r: DetectorInput, nArrBySeq: ReadonlyMap<number, number>): number | null {
  switch (r.k) {
    case 'batch':
    case 'val':
      return nArrBySeq.get(r.seq) ?? ownNArr(r);
    default:
      return r.n;
  }
}

/**
 * Runs a detector over recorded inputs with its own stop model (spec 7.5):
 * - recorded hold_wait, listening and resume lines are dropped (live stops and the audio pause);
 *   a recorded narrating line only switches the reading schedule on, any other state off;
 * - after its own fire on a packet while its narrator reads: stop nSilent = nArr + 384, state
 *   hold_wait; voice_on before nSilent + H gives listening, voice_off then resumes; otherwise the
 *   narrator resumes at nSilent + H (spec 6.4). These state lines go to the detector in order.
 * Lines are taken in file order, which is the processing order (spec 8.1); a hold wait runs out
 * at the first line positioned at or after nSilent + H. The audio pause (VOICE) of the live Deck
 * is not modelled: it starts after voice_on and ends at voice_off, so it never changes D1.
 */
export function runPosthoc<S, F>(inputs: readonly DetectorInput[], opts: PosthocOptions<S, F>): PosthocResult<F> {
  const H = opts.holdWaitSamples ?? HOLD_WAIT_SAMPLES;
  const ramp = opts.rampSamples ?? RAMP_SAMPLES;
  const det = opts.detector;
  const runnerPeriod = det.ownPostFirePeriod === true ? null : (opts.postFireSamples ?? msToSamples(REFRACTORY_MS));
  let state = det.init();
  const fires: PosthocFire<F>[] = [];
  const stops: PosthocStop[] = [];
  const armed: PosthocArmed[] = [];
  const missingArrSeqs: number[] = [];
  const seen: DetectorInput[] | undefined = opts.keepInputs ? [] : undefined;

  let deck: OwnDeck = 'off';
  let reading = false; // the recorded reading schedule
  let voiceOn = false;
  let open: PosthocStop | null = null;
  let postFireUntil = Number.NEGATIVE_INFINITY;
  let suppressed = 0;
  let lastPos = Number.NEGATIVE_INFINITY;
  let active = false;
  let activeFrom = 0;
  let activeSamples = 0;
  let index = 0;

  const feed = (input: DetectorInput, pos: number): PosthocStepOutput<S, F> => {
    const out = det.step(state, input);
    state = out.state;
    seen?.push(input);
    if (out.armed !== undefined && out.armed !== active) {
      active = out.armed;
      armed.push({ n: pos, on: active, index });
      if (active) activeFrom = pos;
      else activeSamples += Math.max(0, pos - activeFrom);
    }
    return out;
  };
  const say = (n: number, s: NarratorState): void => {
    feed({ k: 'state', n, s }, n);
  };
  const endStop = (n: number, why: 'timeout' | 'voice_off'): void => {
    say(n, 'resume');
    if (reading) {
      say(n, 'narrating');
      deck = 'narrating';
    } else {
      deck = 'off';
    }
    if (open !== null) {
      open.nResume = n;
      open.why = why;
      open = null;
    }
  };

  for (index = 0; index < inputs.length; index++) {
    const r = inputs[index]!;
    const known = positionOf(r, opts.nArrBySeq);
    const pos = known ?? lastPos;
    if (r.k === 'batch' && known === null) missingArrSeqs.push(r.seq);
    // The own hold wait ran out before this line (spec 6.4: nSilent + 72000, no voice).
    if (deck === 'hold_wait' && open !== null && pos >= open.nSilent + H) endStop(open.nSilent + H, 'timeout');
    if (known !== null && known > lastPos) lastPos = known;

    switch (r.k) {
      case 'state': {
        if (r.s === 'hold_wait' || r.s === 'listening' || r.s === 'resume') break;
        if (r.s === 'narrating') {
          if (!reading) {
            reading = true;
            if (deck === 'off') deck = 'narrating';
            feed(r, pos);
          }
          break;
        }
        // Any other state ends the reading schedule; an own stop ends with it.
        reading = false;
        if (open !== null) {
          open.nResume = r.n;
          open.why = 'schedule';
          open = null;
        }
        deck = 'off';
        feed(r, pos);
        break;
      }
      case 'voice': {
        feed(r, pos);
        voiceOn = r.on;
        if (r.on && deck === 'hold_wait') {
          deck = 'listening';
          say(r.n, 'listening');
        } else if (!r.on && deck === 'listening') {
          endStop(r.n, 'voice_off');
        }
        break;
      }
      default: {
        const out = feed(r, pos);
        if (!out.hold) break;
        const nArr = known ?? (Number.isFinite(lastPos) ? lastPos : null);
        // The runner's post-fire period: 2.0 s and not before the end of the own stop (spec 7.5).
        if (runnerPeriod !== null && (open !== null || (nArr !== null && nArr < postFireUntil))) {
          suppressed++;
          break;
        }
        const rec: PosthocFire<F> = {
          index,
          seq: r.seq,
          nArr,
          nArrEstimated: known === null,
          accepted: false,
          fire: out.fire,
        };
        if (deck === 'narrating' && nArr !== null) {
          rec.accepted = true;
          open = { seq: r.seq, nCmd: nArr, nSilent: nArr + ramp, nResume: null, why: null };
          stops.push(open);
          if (runnerPeriod !== null) postFireUntil = nArr + runnerPeriod;
          deck = 'hold_wait';
          say(nArr, 'hold_wait');
          if (voiceOn) {
            // Voice already going: Deck goes straight to listening (spec 6.4).
            deck = 'listening';
            say(nArr, 'listening');
          }
        }
        fires.push(rec);
      }
    }
  }
  const last = open as PosthocStop | null;
  if (last !== null && deck === 'hold_wait') {
    last.nResume = last.nSilent + H;
    last.why = 'timeout';
  }
  if (active && Number.isFinite(lastPos)) activeSamples += Math.max(0, lastPos - activeFrom);
  const result: PosthocResult<F> = {
    fires,
    stops,
    armed,
    activeSamples,
    activeMinutes: activeSamples / SAMPLE_RATE_HZ / 60,
    suppressed,
    missingArrSeqs,
  };
  if (seen !== undefined) result.inputs = seen;
  return result;
}

/** Fires per minute of active time, as stage A counts them (spec 7.4); null with no active time. */
export function firesPerActiveMinute(result: PosthocResult<unknown>): number | null {
  return result.activeMinutes > 0 ? result.fires.length / result.activeMinutes : null;
}
