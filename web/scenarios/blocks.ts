// Building blocks shared by the gate, doctor and smoke scenarios (spec 9.3, 7.12).
// Step names are what Deck stamps as marks in stamps.jsonl; docs/protocol.md lists them.
import { secondsToSamples, type Step } from './format.ts';

/** Prompt texts as the user sees them (spec 9.3 table, column "На экране"). */
export const PROMPT = {
  startingCamera: 'Starting camera...',
  signalOk: 'Signal OK',
  holdEarcup: 'Hold one earcup on the microphone',
  headsetOn: 'Headset on. Sit still.',
  breatheNormally: 'Breathe normally',
  breatheIn: 'Breathe in',
  breatheOut: 'Breathe out',
  breatheOutAndWait: 'Breathe out and wait',
  sniff: 'Sniff',
  rest: 'Rest',
  lipsClosed: 'Lips closed',
  pa: 'pa',
} as const;

/** Durations in seconds. Spec 9.3 unless marked as an assumption. */
export const SECONDS = {
  /** 'Signal OK' shown after the SDK wait (assumption). */
  signalOk: 2,
  /** Earcup prompt before the clicks start, time to take the headset off (assumption). */
  loopReady: 5,
  /** Loop check: 10 clicks, about 12 s (spec 6.3, 9.3). */
  loopClicks: 12,
  /** 'Headset on. Sit still.' (spec 9.3). */
  headset: 8,
  breatheNormally: 10,
  deepIn: 2,
  deepOut: 4,
  /** 'Breathe out and wait', then 'Sniff' 1.5 s later (spec 6.3, 9.3). */
  sniffWait: 1.5,
  /** Five sniffs in 0:28-0:50: 22 s / 5. */
  sniffCycle: 4.4,
  rest: 5,
  /** 'Lips closed', then 'pa' (the split of the 3 s cycle is an assumption). */
  paClosed: 1.5,
  /** Five 'pa' in 15 s. */
  paCycle: 3,
  /** The dot stays filled 1.5 s (spec 9.2). */
  cueOn: 1.5,
} as const;

/** Waits for the SDK: Running with kOk held 5 s (spec 7.1, 9.3). Name sdk_start. */
export function waitForSdk(): Step {
  return { k: 'wait', name: 'sdk_start', text: PROMPT.startingCamera, lenSamples: 0, until: 'sdk_ok' };
}

export function signalOk(): Step {
  return { k: 'prompt', name: 'signal_ok', text: PROMPT.signalOk, lenSamples: secondsToSamples(SECONDS.signalOk) };
}

/** Loop check (spec 6.3): the earcup prompt, then the 12 s click block. Names loop_a_ready, loop_a (or _b). */
export function loopCheck(block: 'A' | 'B'): Step[] {
  const tag = `loop_${block.toLowerCase()}`;
  return [
    { k: 'prompt', name: `${tag}_ready`, text: PROMPT.holdEarcup, lenSamples: secondsToSamples(SECONDS.loopReady) },
    { k: 'clicks', name: tag, text: PROMPT.holdEarcup, lenSamples: secondsToSamples(SECONDS.loopClicks), block },
  ];
}

/** 'Headset on. Sit still.' for 8 s. Name headset. */
export function headsetOn(): Step {
  return { k: 'rest', name: 'headset', text: PROMPT.headsetOn, lenSamples: secondsToSamples(SECONDS.headset) };
}

/** 10 s of quiet breathing; with origin it is time 0:00 of the scenario. Name breathe_normally. */
export function breatheNormally(origin: boolean): Step {
  const step: Step = { k: 'prompt', name: 'breathe_normally', text: PROMPT.breatheNormally, lenSamples: secondsToSamples(SECONDS.breatheNormally) };
  if (origin) step.origin = true;
  return step;
}

/** Cued deep breaths: 2 s in with the bar growing, 4 s out with it shrinking. Names deep_<i>_in, deep_<i>_out. */
export function deepBreaths(count: number): Step[] {
  const steps: Step[] = [];
  for (let i = 1; i <= count; i += 1) {
    steps.push({ k: 'prompt', name: `deep_${i}_in`, text: PROMPT.breatheIn, lenSamples: secondsToSamples(SECONDS.deepIn), bar: 'grow' });
    steps.push({ k: 'prompt', name: `deep_${i}_out`, text: PROMPT.breatheOut, lenSamples: secondsToSamples(SECONDS.deepOut), bar: 'shrink' });
  }
  return steps;
}

/** Sniffs: 'Breathe out and wait', then 'Sniff' 1.5 s later, every 4.4 s. Names sniff_<i>_wait, sniff_<i>. */
export function sniffs(count: number): Step[] {
  const wait = secondsToSamples(SECONDS.sniffWait);
  const cycle = secondsToSamples(SECONDS.sniffCycle);
  const steps: Step[] = [];
  for (let i = 1; i <= count; i += 1) {
    steps.push({ k: 'prompt', name: `sniff_${i}_wait`, text: PROMPT.breatheOutAndWait, lenSamples: wait });
    steps.push({ k: 'prompt', name: `sniff_${i}`, text: PROMPT.sniff, lenSamples: cycle - wait });
  }
  return steps;
}

/** 'pa' syllables from closed lips, every 3 s. Names <tag>_<i>_closed, <tag>_<i> (tags pa_start, pa_end). */
export function paSyllables(tag: 'pa_start' | 'pa_end', count: number): Step[] {
  const closed = secondsToSamples(SECONDS.paClosed);
  const cycle = secondsToSamples(SECONDS.paCycle);
  const steps: Step[] = [];
  for (let i = 1; i <= count; i += 1) {
    steps.push({ k: 'prompt', name: `${tag}_${i}_closed`, text: PROMPT.lipsClosed, lenSamples: closed });
    steps.push({ k: 'prompt', name: `${tag}_${i}`, text: PROMPT.pa, lenSamples: cycle - closed });
  }
  return steps;
}

export function rest(name: string, seconds: number = SECONDS.rest, text: string = PROMPT.rest): Step {
  return { k: 'rest', name, text, lenSamples: secondsToSamples(seconds) };
}

export function end(text: string): Step {
  return { k: 'end', name: 'end', text, lenSamples: 0 };
}
