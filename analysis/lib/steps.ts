// Step names of the scenarios, taken from web/scenarios (the names Deck stamps as `mark` `step`
// lines), so analysis never repeats them as strings. Spec 7.12, 9.3, 9.4.

import { PROMPT, deepBreaths, end, headsetOn, loopCheck, paSyllables, rest, sniffs } from '../../web/scenarios/blocks.ts';
import { DOCTOR_TEXT, buildDoctorLevelScenario, buildDoctorScenario, inhaleTest, levelSteps } from '../../web/scenarios/doctor.ts';
import type { Step } from '../../web/scenarios/format.ts';
import { CUE_RULES_MS, GATE_CLIPS, GATE_LAYOUT, buildGateScenario, gatePackOf, objectionBlock, type GatePack } from '../../web/scenarios/gate.ts';
import { buildSmokeScenario } from '../../web/scenarios/smoke.ts';

export { gatePackOf, GATE_LAYOUT, type GatePack };

const names = (steps: readonly Step[], pred: (s: Step) => boolean = () => true): string[] =>
  steps.filter(pred).map((s) => s.name);

function onlyName(steps: readonly Step[], pred: (s: Step) => boolean, what: string): string {
  const found = names(steps, pred);
  if (found.length !== 1 || found[0] === undefined) throw new Error(`web/scenarios: expected one ${what} step, found ${found.length}`);
  return found[0];
}

const loopA = loopCheck('A');
const loopB = loopCheck('B');

/** Click steps of the two loop checks (loop_a, loop_b) and their earcup prompts. */
export const LOOP_STEPS = {
  A: onlyName(loopA, (s) => s.k === 'clicks', 'loop A clicks'),
  B: onlyName(loopB, (s) => s.k === 'clicks', 'loop B clicks'),
  readyA: onlyName(loopA, (s) => s.k !== 'clicks', 'loop A prompt'),
  readyB: onlyName(loopB, (s) => s.k !== 'clicks', 'loop B prompt'),
} as const;

/** 'Headset on. Sit still.' */
export const HEADSET_STEP = headsetOn().name;
/** The last step; Deck stamps it when the steps run out. */
export const END_STEP = end('').name;

/** 'Breathe in' steps of n cued deep breaths: deep_<i>_in. */
export function deepInSteps(count: number): string[] {
  return names(deepBreaths(count), (s) => s.text === PROMPT.breatheIn);
}

/** 'Sniff' prompts of n sniffs: sniff_<i>. */
export function sniffSteps(count: number): string[] {
  return names(sniffs(count), (s) => s.text === PROMPT.sniff);
}

/** 'pa' prompts of a syllable block: <tag>_<i>. */
export function paSteps(tag: 'pa_start' | 'pa_end', count: number): string[] {
  return names(paSyllables(tag, count), (s) => s.text === PROMPT.pa);
}

/** 'Lips closed' prompts of a syllable block: <tag>_<i>_closed. */
export function paClosedSteps(tag: 'pa_start' | 'pa_end', count: number): string[] {
  return names(paSyllables(tag, count), (s) => s.text === PROMPT.lipsClosed);
}

/** A cue list that passes the rules of spec 9.2, only to read names out of the gate scenario. */
function exampleCuesMs(pack: GatePack): number[] {
  return Array.from({ length: GATE_LAYOUT[pack].cues }, (_, i) => CUE_RULES_MS.firstMin + i * CUE_RULES_MS.gapMin);
}

export interface GateSteps {
  pack: GatePack;
  deepIn: string[];
  sniffs: string[];
  paStart: string[];
  paEnd: string[];
  /** Steps where a cue dot fills: cue_<i>_on. */
  cueOn: string[];
  /** Every cue step of the objection block, on and off. */
  cueSteps: string[];
  listening: string;
  objections: string;
  /** The rest before the listening block: the quiet stretch for the voice floor. */
  restBeforeListening: string | null;
  /** Expected counts (spec 9.4 and its pack-0 variant). */
  counts: { cues: number; voices: number; paPerBlock: number; sniffs: number };
}

/** Spec 9.4 for packs A, B and C: voice after 12 of 14 cues, 4 of 5 'pa' per block, 4 sniffs. */
export const FULL_PACK_MINIMUM = { voices: 12, paPerBlock: 4, sniffs: 4 } as const;

/** Step names and counts of a day-one recording for one pack (web/scenarios/gate.ts). */
export function gateSteps(pack: GatePack): GateSteps {
  const g = GATE_LAYOUT[pack];
  const steps = buildGateScenario(pack, exampleCuesMs(pack));
  const listening = onlyName(steps, (s) => s.k === 'play' && s.clip === GATE_CLIPS.listen, 'listening');
  const iListen = steps.findIndex((s) => s.name === listening);
  const before = iListen > 0 ? steps[iListen - 1] : undefined;
  return {
    pack,
    deepIn: deepInSteps(g.deepBreaths),
    sniffs: sniffSteps(g.sniffs),
    paStart: paSteps('pa_start', g.paStart),
    paEnd: paSteps('pa_end', g.paEnd),
    cueOn: names(objectionBlock(exampleCuesMs(pack), g.objectionSamples), (s) => s.k === 'cue' && s.on === true),
    cueSteps: names(objectionBlock(exampleCuesMs(pack), g.objectionSamples), (s) => s.k === 'cue'),
    listening,
    objections: onlyName(steps, (s) => s.k === 'play' && s.clip === GATE_CLIPS.objections, 'objections'),
    restBeforeListening: before && before.k === 'rest' ? before.name : null,
    // Pack 0 (spec 9.4): both cues answered, both 'pa' (one per block) and both sniffs found.
    counts:
      pack === '0'
        ? { cues: g.cues, voices: g.cues, paPerBlock: g.paStart, sniffs: g.sniffs }
        : { cues: g.cues, ...FULL_PACK_MINIMUM },
  };
}

export interface DoctorSteps {
  floor: string;
  levelSample: string;
  leak: string;
  /** Inhale prompts inhale_<i> and their out steps, in order. */
  inhale: string[];
  /** Last step of the inhale test. */
  inhaleLast: string;
}

/** Doctor step names (web/scenarios/doctor.ts); the floor step is found by its text. */
export function doctorSteps(): DoctorSteps {
  const full = buildDoctorScenario('level.wav');
  const level = levelSteps('level.wav');
  const inhale = names(inhaleTest());
  const last = inhale[inhale.length - 1];
  if (last === undefined) throw new Error('web/scenarios: the inhale test has no steps');
  return {
    floor: onlyName(full, (s) => s.text === DOCTOR_TEXT.floor, 'floor'),
    levelSample: onlyName(level, (s) => s.k === 'play' && s.text === DOCTOR_TEXT.levelSample && !s.name.endsWith('_again'), 'level sample'),
    leak: onlyName(level, (s) => s.text === DOCTOR_TEXT.leak, 'leak'),
    inhale,
    inhaleLast: last,
  };
}

/** Steps of the level-only doctor run (`npm run doctor -- --level`). */
export function doctorLevelStepNames(): string[] {
  return names(buildDoctorLevelScenario('level.wav'));
}

/** Steps of the smoke run (web/scenarios/smoke.ts), for the smoke report. */
export function smokeStepNames(): string[] {
  return names(buildSmokeScenario());
}

/** Name of a rest step as web/scenarios/blocks.ts builds it. */
export function restStep(name: string): string {
  return rest(name).name;
}
