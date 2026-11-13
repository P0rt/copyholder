// Day-one check scenarios (spec 9.3 minute table; pack 0 per spec 9.4). Time 0:00 is 'Breathe normally'
// in packs A, B and C, and the first deep breath in pack 0.
import {
  breatheNormally,
  deepBreaths,
  end,
  headsetOn,
  loopCheck,
  paSyllables,
  rest,
  signalOk,
  sniffs,
  waitForSdk,
  SECONDS,
} from './blocks.ts';
import { msToSamples, samplesToMs, secondsToSamples, type Step } from './format.ts';

export type GatePack = '0' | 'A' | 'B' | 'C';

/** Narrator names of a pack (docs/protocol.md): gate/pack-<X>/ through /api/narrator/<name>. */
export const GATE_CLIPS = { listen: 'listen.wav', objections: 'objections.wav', cues: 'cues.json' } as const;

export interface GateLayout {
  /** 'Breathe normally' for 10 s at 0:00 (spec 9.3). Without it, the first deep breath is 0:00. */
  breatheNormally: boolean;
  deepBreaths: number;
  sniffs: number;
  /** 'Rest' between the sniffs and the first 'pa' (spec 9.3, 0:50-0:55). */
  restAfterSniffs: boolean;
  /** 'pa' syllables at the start (0:55) and at the end (9:15). */
  paStart: number;
  paEnd: number;
  /** Planned block lengths; a longer clip stretches its block (see gateBlocks). */
  listenSamples: number;
  objectionSamples: number;
  cues: number;
}

const FULL: GateLayout = {
  breatheNormally: true,
  deepBreaths: 3,
  sniffs: 5,
  restAfterSniffs: true,
  paStart: 5,
  paEnd: 5,
  listenSamples: secondsToSamples(180),
  objectionSamples: secondsToSamples(300),
  cues: 14,
};

/**
 * Pack 0 (spec 9.4), about 2.5 minutes of camera: only the path 9.4 lists. SDK start, both loop
 * checks, three deep breaths, two 'pa' (one at the start and one at the end, so the camera clock is
 * checked at both ends, spec 7.12), two sniffs, 30 s of listening and two cues. No 'Breathe normally'
 * and no rest after the sniffs; the rest before listening stays (the quiet stretch for the voice
 * floor). The planned objection block is the shortest the cue rules of 9.2 allow for two cues with
 * the 10 s voice window of 9.4 (cue 2 at 31 s or later, 1.5 s fill, 10 s, margin): 45 s
 * (assumption). The pack's clip (about 54 s, gate/README.md) stretches it.
 */
const PROBE: GateLayout = {
  breatheNormally: false,
  deepBreaths: 3,
  sniffs: 2,
  restAfterSniffs: false,
  paStart: 1,
  paEnd: 1,
  listenSamples: secondsToSamples(30),
  objectionSamples: secondsToSamples(45),
  cues: 2,
};

export const GATE_LAYOUT: Readonly<Record<GatePack, GateLayout>> = { '0': PROBE, A: FULL, B: FULL, C: FULL };

export const GATE_END_TEXT = 'Recording finished';

/** Cue rules of spec 9.2, in ms from the start of the objection block. */
export const CUE_RULES_MS = { firstMin: 15_000, gapMin: 16_000, gapMax: 24_000, lastMax: 265_000 } as const;

/** Decoded clip lengths in samples, when known. */
export interface GateClipSamples {
  listen?: number;
  objections?: number;
}

/**
 * Block lengths: the planned length of spec 9.3, or the clip when it is longer, so a clip is never cut
 * and never runs into the next block (assumption: the table holds exactly when the clips fit).
 */
export function gateBlocks(pack: GatePack, clips: GateClipSamples = {}): { listenSamples: number; objectionSamples: number } {
  const g = GATE_LAYOUT[pack];
  return {
    listenSamples: Math.max(g.listenSamples, clips.listen ?? 0),
    objectionSamples: Math.max(g.objectionSamples, clips.objections ?? 0),
  };
}

/**
 * Cue list problems (spec 9.2): the pack's cue count, increasing times, first >= 15 s, gaps 16-24 s,
 * last <= 265 s, and the last 1.5 s fill inside the objection block. Pack 0 follows the same rules.
 */
export function gateCueErrors(pack: GatePack, cuesMs: readonly unknown[], objectionSamples = GATE_LAYOUT[pack].objectionSamples): string[] {
  const layout = GATE_LAYOUT[pack];
  if (!Array.isArray(cuesMs)) return ['cues.json must be a JSON array of numbers'];
  const errors: string[] = [];
  if (cuesMs.length !== layout.cues) errors.push(`pack ${pack} needs ${layout.cues} cues, cues.json has ${cuesMs.length}`);
  cuesMs.forEach((ms, i) => {
    if (typeof ms !== 'number' || !Number.isFinite(ms) || ms < 0) errors.push(`cue ${i + 1}: ${String(ms)} is not a time in ms`);
    const prev = cuesMs[i - 1];
    if (i > 0 && typeof ms === 'number' && typeof prev === 'number' && ms <= prev) errors.push(`cue ${i + 1}: times must increase`);
  });
  if (errors.length > 0) return errors;
  const times = cuesMs as number[];
  const first = times[0] ?? 0;
  const last = times[times.length - 1] ?? 0;
  if (first < CUE_RULES_MS.firstMin) errors.push(`first cue at ${first} ms is earlier than 15 s`);
  if (last > CUE_RULES_MS.lastMax) errors.push(`last cue at ${last} ms is later than 265 s`);
  for (let i = 1; i < times.length; i += 1) {
    const gap = (times[i] ?? 0) - (times[i - 1] ?? 0);
    if (gap < CUE_RULES_MS.gapMin || gap > CUE_RULES_MS.gapMax) errors.push(`gap before cue ${i + 1} is ${gap} ms, outside 16-24 s`);
  }
  const blockMs = samplesToMs(objectionSamples);
  if (last + SECONDS.cueOn * 1000 > blockMs) errors.push(`last cue at ${last} ms ends after the ${blockMs} ms objection block`);
  return errors;
}

/**
 * Objection block (spec 9.3): the clip starts, and each cue fills the dot for 1.5 s.
 * Names objections, cue_<i>_on, cue_<i>_off; the last cue_<i>_off runs to the end of the block.
 */
export function objectionBlock(cuesMs: readonly number[], blockSamples: number): Step[] {
  const onLen = secondsToSamples(SECONDS.cueOn);
  const starts = cuesMs.map(msToSamples);
  const steps: Step[] = [
    { k: 'play', name: 'objections', text: '', lenSamples: starts[0] ?? blockSamples, clip: GATE_CLIPS.objections },
  ];
  starts.forEach((start, idx) => {
    const i = idx + 1;
    const next = starts[idx + 1] ?? blockSamples;
    steps.push({ k: 'cue', name: `cue_${i}_on`, text: '', lenSamples: onLen, i, on: true });
    steps.push({ k: 'cue', name: `cue_${i}_off`, text: '', lenSamples: next - start - onLen, i, on: false });
  });
  return steps;
}

/**
 * Steps of a day-one recording for one pack. cuesMs comes from the pack's cues.json; clips gives the
 * decoded clip lengths. Throws on a bad cue list.
 */
export function buildGateScenario(pack: GatePack, cuesMs: readonly number[], clips: GateClipSamples = {}): Step[] {
  const g = GATE_LAYOUT[pack];
  const blocks = gateBlocks(pack, clips);
  const errors = gateCueErrors(pack, cuesMs, blocks.objectionSamples);
  if (errors.length > 0) throw new Error(`cues.json of pack ${pack}:\n${errors.join('\n')}`);
  const breaths = deepBreaths(g.deepBreaths);
  const first = breaths[0];
  // Time 0:00 is the first scenario prompt (spec 9.3): 'Breathe normally', else the first deep breath.
  if (!g.breatheNormally && first) first.origin = true;
  return [
    waitForSdk(),
    signalOk(),
    ...loopCheck('A'),
    headsetOn(),
    ...(g.breatheNormally ? [breatheNormally(true)] : []),
    ...breaths,
    ...sniffs(g.sniffs),
    ...(g.restAfterSniffs ? [rest('rest_1')] : []),
    ...paSyllables('pa_start', g.paStart),
    // The rest before listening keeps its name in every pack: analysis measures the voice floor on it.
    rest('rest_2'),
    { k: 'play', name: 'listening', text: '', lenSamples: blocks.listenSamples, clip: GATE_CLIPS.listen },
    ...objectionBlock(cuesMs, blocks.objectionSamples),
    ...paSyllables('pa_end', g.paEnd),
    ...loopCheck('B'),
    end(GATE_END_TEXT),
  ];
}

/** Gate pack from a scenario name: gate-A, gate_b, pack-0, gate-pack-C, A, ... */
export function gatePackOf(name: string): GatePack | null {
  const m = /^(?:gate[-_:]?)?(?:pack[-_:]?)?([0abc])$/i.exec(name.trim());
  if (!m || !m[1]) return null;
  return m[1].toUpperCase() as GatePack;
}
