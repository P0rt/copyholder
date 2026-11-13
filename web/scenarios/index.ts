// Picks the scenario for a run from /api/config (docs/protocol.md: mode, scenario, narrator).
import { buildDoctorLevelScenario, buildDoctorScenario, DOCTOR_SAMPLE_CLIP } from './doctor.ts';
import type { Step } from './format.ts';
import { buildGateScenario, gatePackOf, GATE_CLIPS, type GatePack } from './gate.ts';
import {
  DOCTOR_INSTRUCTION,
  DOCTOR_LEVEL_INSTRUCTION,
  GATE_INSTRUCTION,
  GATE_PROBE_INSTRUCTION,
  SMOKE_INSTRUCTION,
  type Instruction,
} from './instructions.ts';
import { buildSmokeScenario } from './smoke.ts';

export * from './format.ts';
export { ScenarioRunner, type StepStart } from './runner.ts';

export interface ScenarioRequest {
  mode: string;
  scenario: string;
  /** Narrator names host serves for this run. */
  narrator: readonly string[];
}

/** What the page fetched before it builds the steps. */
export interface ScenarioAssets {
  /** cues.json of a gate pack: cue start times in ms from the start of the objection block. */
  cuesMs?: readonly number[];
  /** Decoded length of each loaded clip, in samples. */
  clipSamples: ReadonlyMap<string, number>;
}

/**
 * How Deck treats the narrator (processorOptions.mode): 'gate' never stops it (day-one check, doctor,
 * smoke), 'live' stops it on the chest and the audio safety, 'key' on the space bar and the audio safety.
 */
export type DeckModeName = 'live' | 'gate' | 'key';

export interface ScenarioPlan {
  id: string;
  kind: 'gate' | 'doctor' | 'smoke';
  /** The SDK and the camera run (consent text 'live'). */
  camera: boolean;
  deckMode: DeckModeName;
  instruction: Instruction;
  /** Narrator clips to fetch and load into Deck before the steps start. */
  clips: string[];
  /** Name of the cue list to fetch, if any. */
  cuesFile: string | null;
  /** Show the microphone and narrator meters (doctor only: nothing else moves in a recording). */
  meters: boolean;
  /** Show the device names and microphone flags (doctor, spec 7.12). */
  devicePanel: boolean;
  build(assets: ScenarioAssets): Step[];
}

function missing(narrator: readonly string[], names: readonly string[]): string[] {
  return names.filter((n) => !narrator.includes(n));
}

function gatePlan(pack: GatePack): ScenarioPlan {
  return {
    id: `gate-${pack}`,
    kind: 'gate',
    camera: true,
    deckMode: 'gate',
    instruction: pack === '0' ? GATE_PROBE_INSTRUCTION : GATE_INSTRUCTION,
    clips: [GATE_CLIPS.listen, GATE_CLIPS.objections],
    cuesFile: GATE_CLIPS.cues,
    meters: false,
    devicePanel: false,
    build: (assets) =>
      buildGateScenario(pack, assets.cuesMs ?? [], {
        listen: assets.clipSamples.get(GATE_CLIPS.listen),
        objections: assets.clipSamples.get(GATE_CLIPS.objections),
      }),
  };
}

function doctorPlan(levelOnly: boolean, narrator: readonly string[]): ScenarioPlan | string {
  const clip = narrator.includes(DOCTOR_SAMPLE_CLIP) ? DOCTOR_SAMPLE_CLIP : null;
  if (levelOnly && !clip) return `The level step needs the volume sample ${DOCTOR_SAMPLE_CLIP}, and host does not serve it.`;
  return {
    id: levelOnly ? 'doctor-level' : 'doctor',
    kind: 'doctor',
    camera: false,
    deckMode: 'gate',
    instruction: levelOnly ? DOCTOR_LEVEL_INSTRUCTION : DOCTOR_INSTRUCTION,
    clips: clip ? [clip] : [],
    cuesFile: null,
    meters: true,
    devicePanel: true,
    build: (assets) => {
      const samples = clip ? (assets.clipSamples.get(clip) ?? 0) : 0;
      return levelOnly && clip ? buildDoctorLevelScenario(clip, samples) : buildDoctorScenario(clip, samples);
    },
  };
}

const SMOKE_PLAN: ScenarioPlan = {
  id: 'smoke',
  kind: 'smoke',
  camera: true,
  deckMode: 'gate',
  instruction: SMOKE_INSTRUCTION,
  clips: [],
  cuesFile: null,
  meters: false,
  devicePanel: false,
  build: buildSmokeScenario,
};

/** The scenario plan for a run, or a message for a mode or scenario this page cannot run. */
export function scenarioFor(req: ScenarioRequest): ScenarioPlan | string {
  const name = (req.scenario || '').trim();
  const mode = (req.mode || '').trim();
  const pack = gatePackOf(name);
  if (mode === 'gate' || (pack !== null && mode === '')) {
    if (pack === null) return `Unknown gate pack in scenario "${name}". Expected gate-0, gate-A, gate-B or gate-C.`;
    const absent = missing(req.narrator, [GATE_CLIPS.listen, GATE_CLIPS.objections, GATE_CLIPS.cues]);
    if (absent.length > 0) return `Pack ${pack} is not ready: host does not serve ${absent.join(', ')}.`;
    return gatePlan(pack);
  }
  if (mode === 'doctor' || name === 'doctor' || name === 'doctor-level') return doctorPlan(name === 'doctor-level', req.narrator);
  if (mode === 'smoke' || name === 'smoke') return SMOKE_PLAN;
  return `This page has no scenario for mode "${mode}" and scenario "${name}".`;
}

/**
 * Word timings file for a clip among the narrator names: <clip>.timings.json, <clip>_timings.json,
 * <clip>.json, or a lone timings.json when the scenario has one clip. Null when none is served.
 */
export function timingsNameFor(clip: string, narrator: readonly string[], clipCount: number): string | null {
  const base = clip.replace(/\.wav$/i, '');
  const candidates = [`${base}.timings.json`, `${base}_timings.json`, `${base}-timings.json`, `${base}.json`];
  for (const c of candidates) if (narrator.includes(c)) return c;
  if (clipCount === 1 && narrator.includes('timings.json')) return 'timings.json';
  return null;
}
