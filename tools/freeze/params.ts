// params/frozen.json for the tag gate-prereg (spec 8.4): the parameters fixed in advance by spec 6.4,
// 7.3, 7.4 and 7.5, as numbers for the code, without k and theta_G (stage A writes those, spec 7.4,
// 7.5). Pure: the doctor values come in as an argument (tools/freeze/frozen.ts finds them).

import { DEFAULT_D1_PARAMS, DEFAULT_HOLD_PARAMS } from '../../core/detector.ts';
import { orderKeys, validateFrozenParams, type FrozenParams } from '../../core/schemas/index.ts';
import { DEFAULT_VAD_PARAMS, vadFrozenBlock, type VadParams } from '../../core/vad/index.ts';

export const FROZEN_PARAMS_PATH = 'params/frozen.json';

/** How params/frozen.json gets the doctor values, for messages. */
export const WRITE_HINT =
  'Run doctor, then npx tsx tools/freeze/frozen.ts on the Mac (it reads calib.json), or anywhere npx tsx tools/freeze/frozen.ts --doctor <id> --floor-db <dB> --periodicity <p> with the values the doctor report prints';

/** Audio safety: voice_on plus 250 ms before VOICE stops the narrator (spec 6.4, 8.4 example). */
export const AUDIO_PAUSE_MS = 250;

/** G, the lip detector (spec 7.5): two frames in a row over a 10 s baseline; 1 s of frames after a reset (assumption). */
export const G_FRAMES = 2;
export const G_BASELINE_S = 10;
export const G_RESET_WAIT_S = 1;

/**
 * What stage A writes (spec 7.4, 7.5, 8.4): d1.k, g.theta_G and the `tuned` block that names the step.
 * Under gate-prereg each is absent or null (core/schemas FrozenParams). d1.d3.k is D3's fixed 1.0,
 * not a tuned value (spec 7.4); top-level k and theta_G are refused too, should anyone write them flat.
 */
export const STAGE_A_PATHS: readonly (readonly string[])[] = [['d1', 'k'], ['g', 'theta_G'], ['tuned'], ['k'], ['theta_G']];

/** The voice detector values of a doctor run: its calib.json, or its report (spec 7.12, 8.1). */
export interface DoctorVad {
  /** Session folder name, e.g. doctor-2. */
  id: string;
  /** Periodicity threshold after the in-breath test (spec 7.12). */
  periodicity: number;
  /** Noise floor of the voice detector, dB (spec 7.3, 7.12). */
  floorDb: number;
}

/** The thresholds the in-breath test can give: 0.5, raised in steps of 0.05, at most 0.7 (spec 7.12). */
export const DOCTOR_PERIODICITY_STEPS: readonly number[] = [0.5, 0.55, 0.6, 0.65, 0.7];

/** A noise floor in dB re full scale, as doctor measures it (analysis/doctor.ts). */
export const FLOOR_DB_RANGE = { min: -150, max: 0 } as const;

/** Why doctor values cannot go into params/frozen.json; empty when they can. */
export function doctorVadProblems(d: DoctorVad): string[] {
  const problems: string[] = [];
  if (!Number.isFinite(d.floorDb) || d.floorDb <= FLOOR_DB_RANGE.min || d.floorDb >= FLOOR_DB_RANGE.max) {
    problems.push(`the noise floor ${d.floorDb} dB is not a floor in dB re full scale (between ${FLOOR_DB_RANGE.min} and ${FLOOR_DB_RANGE.max})`);
  }
  if (!DOCTOR_PERIODICITY_STEPS.some((p) => Math.abs(p - d.periodicity) < 1e-9)) {
    problems.push(`the periodicity threshold ${d.periodicity} is not one of ${DOCTOR_PERIODICITY_STEPS.join(', ')} (spec 7.12)`);
  }
  return problems;
}

/** Doctor values as doctor prints them: the floor to 0.1 dB, the threshold to 0.01 (analysis/doctor.ts). */
export function roundedDoctorVad(d: DoctorVad): DoctorVad {
  return { id: d.id, floorDb: Math.round(d.floorDb * 10) / 10, periodicity: Math.round(d.periodicity * 100) / 100 };
}

export interface FrozenBuild {
  params: FrozenParams;
  /** Where the voice detector values came from, for the terminal. */
  vadSource: string;
}

/**
 * The `vad` block: every key of core/vad. The floor and the periodicity threshold come from doctor
 * when it ran (spec 7.3: frozen after doctor has measured the floor); without it the threshold is
 * the default and floor_db is left out, so the -70 dB placeholder never passes for a measured floor.
 */
export function vadBlockFor(doctor: DoctorVad | null): Record<string, unknown> {
  const params: Partial<VadParams> = doctor ? { ...DEFAULT_VAD_PARAMS, periodicity: doctor.periodicity, floorDb: doctor.floorDb } : DEFAULT_VAD_PARAMS;
  const block: Record<string, unknown> = { ...vadFrozenBlock(params) };
  if (!doctor) delete block['floor_db'];
  return block;
}

/** params/frozen.json for gate-prereg; throws when the result fails core/schemas. */
export function buildGatePreregParams(doctor: DoctorVad | null): FrozenBuild {
  const { k: _preliminaryK, ...d1Defaults } = DEFAULT_D1_PARAMS;
  const value: Record<string, unknown> = {
    schema: 'params/1',
    d1: {
      ...d1Defaults,
      theta_clamp: [...DEFAULT_D1_PARAMS.theta_clamp],
      invalid_codes: [...DEFAULT_D1_PARAMS.invalid_codes],
      d3: { ...DEFAULT_D1_PARAMS.d3 },
    },
    hold: { H_ms: DEFAULT_HOLD_PARAMS.H_ms, ramp_frames: DEFAULT_HOLD_PARAMS.ramp_frames, audio_pause_ms: AUDIO_PAUSE_MS },
    g: { frames: G_FRAMES, baseline_s: G_BASELINE_S, reset_wait_s: G_RESET_WAIT_S },
    vad: vadBlockFor(doctor),
  };
  const problems = [...validateFrozenParams(value), ...stageAKeysFound(value)];
  if (problems.length > 0) throw new Error(`params/frozen.json would not be valid:\n  ${problems.join('\n  ')}`);
  const vadSource = doctor
    ? `${doctor.id} (periodicity ${doctor.periodicity}, floor ${doctor.floorDb} dB)`
    : `defaults (periodicity ${DEFAULT_VAD_PARAMS.periodicity}, no floor: no doctor values)`;
  return { params: value as unknown as FrozenParams, vadSource };
}

function valueAt(value: unknown, path: readonly string[]): unknown {
  let v = value;
  for (const key of path) {
    if (v === null || typeof v !== 'object' || Array.isArray(v)) return undefined;
    v = (v as Record<string, unknown>)[key];
  }
  return v;
}

/** One line for each stage A value already set (not absent, not null). */
export function stageAKeysFound(value: unknown): string[] {
  return STAGE_A_PATHS.filter((p) => valueAt(value, p) !== undefined && valueAt(value, p) !== null).map(
    (p) => `${p.join('.')} is set: stage A writes it after the gate recording (spec 8.4)`,
  );
}

/** The file text: spec 8.4 key order, one top-level block per line (as stage A writes it). */
export function frozenParamsText(value: object): string {
  const ordered = orderKeys(value, 'params/frozen.json') as Record<string, unknown>;
  const lines = Object.entries(ordered).map(([k, v]) => `${JSON.stringify(k)}:${JSON.stringify(v)}`);
  return `{${lines.join(',\n ')}}\n`;
}

/** Spec 7.3: gate-prereg freezes the voice detector after doctor has measured the noise floor. */
export function measuredFloorProblem(value: unknown): string | null {
  const floor = valueAt(value, ['vad', 'floor_db']);
  if (floor !== undefined && floor !== null) return null;
  return `vad.floor_db is missing: gate-prereg freezes the voice detector after doctor has measured the noise floor (spec 7.3). ${WRITE_HINT}`;
}

/** Problems of a params/frozen.json text for gate-prereg: schema, no stage A values, a measured floor. */
export function gatePreregParamsProblems(text: string): string[] {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (e) {
    return [`not valid JSON: ${(e as Error).message}`];
  }
  const floor = measuredFloorProblem(value);
  return [...validateFrozenParams(value), ...stageAKeysFound(value), ...(floor === null ? [] : [floor])];
}
