// Calibration read from other folders: params/frozen.json (the frozen voice detector and the
// confirming detector, spec 8.4, 7.4) and calib.json of the doctor runs (spec 7.12, 8.1).

import fs from 'node:fs';
import path from 'node:path';
import { parseJson, validateCalib, type Calib } from '../../core/schemas/index.ts';
import { vadParamsFromFrozen, type VadParams } from '../../core/vad/index.ts';
import { pickVadParams } from '../../web/ui/deck-options.ts';
import { REPO_ROOT, sessionsDir } from './paths.ts';
import { latestSession } from './session.ts';

/** The `vad` block doctor adds to calib.json (names of the params/frozen.json block, core/vad/frozen.ts). */
export interface CalibVad {
  floor_db: number;
  periodicity: number;
}

/** calib.json `vad` of a doctor run, or null. */
export function calibVad(calib: Calib | null | undefined): CalibVad | null {
  return vadValues(calib?.['vad']);
}

/** A `vad` block with a finite floor_db and periodicity, or null (as Deck reads it, web/ui/deck-options.ts). */
function vadValues(v: unknown): CalibVad | null {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const floor = o['floor_db'];
  const p = o['periodicity'];
  return typeof floor === 'number' && Number.isFinite(floor) && typeof p === 'number' && Number.isFinite(p)
    ? { floor_db: floor, periodicity: p }
    : null;
}

/** params/frozen.json, or COPYHOLDER_PARAMS_FILE as host reads it (live/lib/paths.cjs). */
export function frozenParamsFile(env: NodeJS.ProcessEnv = process.env): string {
  const v = env['COPYHOLDER_PARAMS_FILE'];
  return v ? path.resolve(v) : path.join(REPO_ROOT, 'params', 'frozen.json');
}

/** A JSON object file; null when absent, unreadable or not an object. */
function readJsonObject(file: string): Record<string, unknown> | null {
  try {
    const v = JSON.parse(fs.readFileSync(file, 'utf8')) as unknown;
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** params/frozen.json as an object; null before the freeze or when unreadable. */
function readFrozen(env: NodeJS.ProcessEnv): Record<string, unknown> | null {
  return readJsonObject(frozenParamsFile(env));
}

export interface FrozenVad {
  params: VadParams;
  /**
   * The block names floor_db. The spec example lists only part of the keys (spec 8.4) and has
   * none; without it `params.floorDb` is the -70 dB placeholder, not a measured floor.
   */
  hasFloor: boolean;
}

/** The `vad` block of params/frozen.json, or null before the freeze or when the block is unusable. */
export function frozenVad(env: NodeJS.ProcessEnv = process.env): FrozenVad | null {
  const block = readFrozen(env)?.['vad'];
  if (!block || typeof block !== 'object' || Array.isArray(block)) return null;
  try {
    const b = block as Record<string, unknown>;
    return { params: vadParamsFromFrozen(b), hasFloor: typeof b['floor_db'] === 'number' };
  } catch {
    return null;
  }
}

/** The frozen voice detector of params/frozen.json, or null before the freeze or when the block is unreadable. */
export function frozenVadParams(env: NodeJS.ProcessEnv = process.env): VadParams | null {
  return frozenVad(env)?.params ?? null;
}

/**
 * The confirming detector (spec 4, 7.4, 9.8): D1 by plan, D3 when params/frozen.json names it
 * (`variant`, or `d1.variant`), the rule host uses for the worker (live/lib/calib.cjs detectorSetup).
 */
export function frozenDetectorVariant(env: NodeJS.ProcessEnv = process.env): 'D1' | 'D3' {
  const p = readFrozen(env);
  const d1 = p?.['d1'];
  const named = p?.['variant'] ?? (d1 && typeof d1 === 'object' && !Array.isArray(d1) ? (d1 as Record<string, unknown>)['variant'] : undefined);
  return named === 'D3' ? 'D3' : 'D1';
}

/** Reads and validates <dir>/calib.json; null when absent or invalid. */
export function readCalib(dir: string): Calib | null {
  try {
    return parseJson(fs.readFileSync(path.join(dir, 'calib.json'), 'utf8'), validateCalib).value;
  } catch {
    return null;
  }
}

/** calib.json of the newest full doctor run (scenario 'doctor', not 'doctor-level') that wrote L_rt. */
export function latestDoctorCalib(env: NodeJS.ProcessEnv = process.env, exceptId?: string): { id: string; calib: Calib } | null {
  const id = latestSession('doctor', {
    env,
    scenario: 'doctor',
    ...(exceptId === undefined ? {} : { exceptId }),
    accept: (dir) => readCalib(dir)?.L_rt_ms !== undefined,
  });
  if (id === null) return null;
  const calib = readCalib(path.join(sessionsDir(env), id));
  return calib ? { id, calib } : null;
}

/**
 * The doctor `vad` block the page gets in GET /api/config `calib` (live/lib/calib.cjs pageCalib):
 * calib.json of the doctor-<n> folders merged lowest n first, so the block of the highest n that
 * has one; a `doctor -- --level` run copies it from its full run (analysis/doctor.ts). `vad` is
 * null when that block is not usable: Deck then has no doctor values either.
 */
export function pageDoctorVad(env: NodeJS.ProcessEnv = process.env): { id: string; vad: CalibVad | null } | null {
  const root = sessionsDir(env);
  let names: string[];
  try {
    names = fs
      .readdirSync(root, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
  } catch {
    return null;
  }
  let best: { n: number; id: string; vad: unknown } | null = null;
  for (const name of names) {
    const m = /^doctor-(\d+)$/.exec(name);
    if (!m) continue;
    const calib = readJsonObject(path.join(root, name, 'calib.json'));
    if (calib === null || !Object.hasOwn(calib, 'vad')) continue;
    const n = Number(m[1]);
    if (best === null || n >= best.n) best = { n, id: name, vad: calib['vad'] };
  }
  return best && { id: best.id, vad: vadValues(best.vad) };
}

export interface VadChoice {
  /** Without floorDb, the floor is measured on the recording (conditions.ts vadParamsFor). */
  params: Partial<VadParams>;
  source: string;
}

/**
 * Voice detector parameters for recomputing edges after a recording, by the rule Deck runs with
 * (web/ui/deck-options.ts pickVadParams) on the files host serves it (spec 7.3, 7.12):
 * 1. the frozen block when it names floor_db;
 * 2. a frozen block without floor_db was frozen before doctor: the floor and the periodicity
 *    threshold of doctor (pageDoctorVad) replace its placeholder floor and its threshold; without
 *    doctor values the floor is left out, to be measured on the recording (Deck, which cannot
 *    measure ahead, runs the placeholder there);
 * 3. else the floor and threshold of doctor;
 * 4. else null (the condition then measures the floor on the recording).
 */
export function chooseVadParams(env: NodeJS.ProcessEnv = process.env): VadChoice | null {
  const doctor = pageDoctorVad(env);
  const pick = pickVadParams(readFrozen(env)?.['vad'], doctor?.vad ?? null);
  if (!pick) return null;
  const p = pick.params;
  const id = doctor?.id ?? 'none'; // origins with doctor values always have one
  switch (pick.origin) {
    case 'frozen':
      return { params: p, source: `params/frozen.json (floor ${p.floorDb} dB, periodicity ${p.periodicity})` };
    case 'frozen+doctor':
      return { params: p, source: `params/frozen.json (it has no floor_db) with the floor ${p.floorDb} dB and the periodicity ${p.periodicity} of doctor ${id}` };
    case 'frozen-default-floor': {
      const { floorDb: _placeholder, ...noFloor } = p;
      return { params: noFloor, source: `params/frozen.json (periodicity ${p.periodicity}; it has no floor_db and no doctor floor exists)` };
    }
    case 'doctor':
      return { params: p, source: `doctor ${id} (floor ${p.floorDb} dB, periodicity ${p.periodicity})` };
  }
}
