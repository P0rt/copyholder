// Adapter over analysis/lib (written in parallel): the voice detector values that a doctor run
// stored in its calib.json (spec 7.12, 8.1). One small file, so an API change lands here only.

import path from 'node:path';
import { calibVad, readCalib } from '../../analysis/lib/calib-io.ts';
import { sessionsDir } from '../../analysis/lib/paths.ts';
import { latestSession } from '../../analysis/lib/session.ts';
import type { DoctorVad } from './params.ts';

export type { DoctorVad };

/** The vad block of sessions/<id>/calib.json (or under COPYHOLDER_SESSIONS_DIR), or null. */
export function doctorVadOf(id: string, env: NodeJS.ProcessEnv = process.env): DoctorVad | null {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(id)) return null;
  const vad = calibVad(readCalib(path.join(sessionsDir(env), id)));
  return vad === null ? null : { id, periodicity: vad.periodicity, floorDb: vad.floor_db };
}

/**
 * The newest doctor folder in sessions/ (or COPYHOLDER_SESSIONS_DIR) whose calib.json holds the
 * `vad` block, or null. A `doctor -- --level` run copies that block from its full run, so either
 * kind may answer.
 */
export function latestDoctorVad(env: NodeJS.ProcessEnv = process.env): DoctorVad | null {
  const id = latestSession('doctor', { env, accept: (dir) => calibVad(readCalib(dir)) !== null });
  return id === null ? null : doctorVadOf(id, env);
}
