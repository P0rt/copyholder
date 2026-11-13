// The calib.json blocks the clocks command writes for one recording (spec 7.12, 8.1):
// L_rt_ms from the session's loop checks, camera_clock, and sniff_lag_ms in the gate.

import type { Calib } from '../schemas/reports.ts';
import { cameraClock, type CameraClock, type CameraClockOptions } from './camera.ts';
import { measureLoopBlocks } from './check.ts';
import { loopRule, type LoopMeasurement, type LoopOptions, type LrtThresholds } from './loop.ts';
import { lipFrames, packetTimes, tracePackets } from './session.ts';
import { sniffLag, type SniffLag, type SniffLagOptions } from './sniff.ts';
import type { CalibLrt, SessionData } from './types.ts';

export interface ClockCalibInput {
  /** 'pa' plosive bursts in channel 0, sample numbers (core/onset findPaBursts); null without the camera. */
  bursts?: { start: readonly number[]; end: readonly number[] } | null;
  /** Gate recordings only: sniff onsets n_sniff (core/onset findSniffOnset), A_ref and the trace sign. */
  sniff?: { onsets: readonly number[]; aRef: number; sign?: 1 | -1 } | null;
  /** Loop checks already measured (for example ClockCheckDetails.loop). */
  loop?: { A: LoopMeasurement | null; B: LoopMeasurement | null };
}

export interface ClockCalibOptions {
  loop?: LoopOptions;
  lrt?: LrtThresholds;
  camera?: CameraClockOptions;
  sniff?: SniffLagOptions;
}

export interface ClockCalib {
  /** The three calib.json blocks; a block that does not apply is null. */
  calib: { L_rt_ms: CalibLrt; camera_clock: Calib['camera_clock']; sniff_lag_ms: Calib['sniff_lag_ms'] };
  camera: CameraClock | null;
  sniff: SniffLag | null;
}

/**
 * L_rt for the upper sniff bound: `used` under rule mean, the larger of A and B under rule both
 * (assumption: the less favourable value for the 150 ms test). Null under rule void, which
 * includes a missing loop check: the spec 6.3 rule gives no valid L_rt then.
 */
export function sniffLrtMs(lrt: CalibLrt): number | null {
  if (lrt.rule === 'mean') return lrt.used;
  if (lrt.rule === 'both' && lrt.A !== null && lrt.B !== null) return Math.max(lrt.A, lrt.B);
  return null;
}

/**
 * calib.json clock blocks of one recording. Merge `calib` into the file; other writers own the
 * other keys. Without a valid L_rt the sniff block keeps n and lo_median (they do not use L_rt);
 * hi_median and the reading are null.
 */
export function clockCalib(session: SessionData, input: ClockCalibInput = {}, opts: ClockCalibOptions = {}): ClockCalib {
  const loop = input.loop ?? measureLoopBlocks(session, opts.loop);
  const lrt = loopRule(loop.A, loop.B, opts.lrt);
  const camera = input.bursts
    ? cameraClock({ packets: packetTimes(session), frames: lipFrames(session), bursts: input.bursts }, opts.camera)
    : null;
  const sniff = input.sniff
    ? sniffLag(
        {
          onsets: input.sniff.onsets,
          packets: tracePackets(session),
          aRef: input.sniff.aRef,
          lrtMs: sniffLrtMs(lrt),
          ...(input.sniff.sign !== undefined ? { sign: input.sniff.sign } : {}),
        },
        opts.sniff,
      )
    : null;
  const calib: Required<Pick<Calib, 'L_rt_ms' | 'camera_clock' | 'sniff_lag_ms'>> & { L_rt_ms: CalibLrt } = {
    L_rt_ms: lrt,
    camera_clock: camera ? camera.calib : null,
    sniff_lag_ms: sniff ? sniff.calib : null,
  };
  return { calib, camera, sniff };
}
