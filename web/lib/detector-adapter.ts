// The worker's detector (spec 7.3, 7.4): step() from core/detector.ts on every detector_in line, in
// arrival order. The setup comes from /api/config `detector` (docs/protocol.md).

import { initDetector, runDetectorFile, step, type DetectorInput, type DetectorState, type StepResult } from './core.ts';
import type { DetBatch, DetectorVariant, TracePair, WorkerConfig } from './messages.ts';

type DetectorParams = Parameters<typeof initDetector>[0];

export interface DetectorChoice {
  /** Parsed params/frozen.json or D1 fields; {} gives the preliminary parameters (spec 7.4). */
  params: Record<string, unknown>;
  sign: 1 | -1;
  variant: DetectorVariant;
}

/** Day-one check (spec 7.3): preliminary parameters, sign 1, D1. */
export const PRELIMINARY_DETECTOR: Readonly<DetectorChoice> = Object.freeze({ params: {}, sign: 1, variant: 'D1' });

function isRecord(x: unknown): x is Record<string, unknown> {
  return typeof x === 'object' && x !== null && !Array.isArray(x);
}

/**
 * config.detector {params, sign, variant}; a missing sign falls back to calib.polarity.sign, then 1.
 * Throws on params that are not an object, a sign other than 1 or -1, or a variant other than D1 or D3.
 */
export function detectorChoice(config: WorkerConfig): DetectorChoice {
  const d = isRecord(config.detector) ? config.detector : {};
  const params = d.params ?? {};
  if (!isRecord(params)) throw new Error('detector.params: expected an object');
  const polarity = isRecord(config.calib) && isRecord(config.calib.polarity) ? config.calib.polarity.sign : undefined;
  const sign = d.sign ?? polarity ?? 1;
  if (sign !== 1 && sign !== -1) throw new Error(`detector.sign: expected 1 or -1, got ${JSON.stringify(sign)}`);
  const variant = d.variant ?? 'D1';
  if (variant !== 'D1' && variant !== 'D3') throw new Error(`detector.variant: expected D1 or D3, got ${JSON.stringify(variant)}`);
  return { params, sign, variant };
}

/** Holds the detector state between inputs; one step() per input. */
export class DetectorRunner {
  private state: DetectorState;

  /** Throws when initDetector() rejects the parameters. */
  constructor(readonly choice: DetectorChoice) {
    this.state = initDetector(choice.params as DetectorParams, choice.sign, choice.variant);
  }

  feed(input: DetectorInput): StepResult {
    const out = step(this.state, input);
    this.state = out.state;
    return out;
  }
}

/** Fires of a detector_in replay (spec 7.3 test: replay gives the same fires). */
export function replayFires(choice: DetectorChoice, inputs: readonly DetectorInput[]): Array<{ seq: number; v: number; theta: number }> {
  return runDetectorFile(inputs, choice.params as DetectorParams, choice.sign, choice.variant).fires.map((f) => ({ seq: f.seq, v: f.v, theta: f.theta }));
}

function pairs(x: unknown): TracePair[] {
  return Array.isArray(x) ? x.filter((p): p is TracePair => Array.isArray(p)).map((p) => [p[0], p[1]]) : [];
}

function numOrNull(x: unknown): number | null {
  return typeof x === 'number' ? x : null;
}

/**
 * detector_in `batch` line of a /tap `m` line (spec 8.1): tr, talk, g and hm copied as sent, no
 * rounding; landmarks, tArrNs and tsCbUs left out. Null when seq is not a sequence number.
 */
export function batchFromTapLine(line: Record<string, unknown>): DetBatch | null {
  const seq = line.seq;
  if (typeof seq !== 'number' || !Number.isSafeInteger(seq) || seq < 0) return null;
  return { k: 'batch', seq, tr: pairs(line.tr), talk: pairs(line.talk), g: numOrNull(line.g), hm: numOrNull(line.hm) };
}
