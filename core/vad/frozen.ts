// The `vad` block of params/frozen.json (spec 8.4) <-> VadParams. The spec example names
// highpass_hz, hop_ms, over_floor_db, periodicity, on_ms and off_ms ("часть полей"); the other
// keys, floor_db among them, are this module's names (assumption). The tag gate-prereg freezes
// the whole block after doctor has measured the floor (spec 7.3, 7.12).

import { DEFAULT_VAD_PARAMS, createVad, resolveVadParams, type VadParams } from './vad.ts';

/** The `vad` block as written to params/frozen.json. */
export interface VadFrozenBlock {
  highpass_hz: number;
  highpass_order: number;
  hop_ms: number;
  energy_window_ms: number;
  decimate_to_hz: number;
  anti_alias_taps: number;
  anti_alias_hz: number;
  corr_window_ms: number;
  lag_ms: [number, number];
  floor_db: number;
  over_floor_db: number;
  periodicity: number;
  on_ms: [number, number];
  off_ms: number;
}

const SCALARS: ReadonlyArray<readonly [keyof VadFrozenBlock, keyof VadParams]> = [
  ['highpass_hz', 'highpassHz'],
  ['highpass_order', 'highpassOrder'],
  ['hop_ms', 'hopMs'],
  ['energy_window_ms', 'energyWindowMs'],
  ['decimate_to_hz', 'decimateToHz'],
  ['anti_alias_taps', 'antiAliasTaps'],
  ['anti_alias_hz', 'antiAliasHz'],
  ['corr_window_ms', 'corrWindowMs'],
  ['floor_db', 'floorDb'],
  ['over_floor_db', 'overFloorDb'],
  ['periodicity', 'periodicity'],
  ['off_ms', 'offMs'],
];

const PAIRS: ReadonlyArray<readonly [keyof VadFrozenBlock, keyof VadParams]> = [
  ['lag_ms', 'lagMs'],
  ['on_ms', 'onMs'],
];

/** The block to freeze for `params` (all keys, so the freeze leaves nothing to defaults). */
export function vadFrozenBlock(params: Partial<VadParams> = DEFAULT_VAD_PARAMS): VadFrozenBlock {
  const p = resolveVadParams(params);
  return {
    highpass_hz: p.highpassHz,
    highpass_order: p.highpassOrder,
    hop_ms: p.hopMs,
    energy_window_ms: p.energyWindowMs,
    decimate_to_hz: p.decimateToHz,
    anti_alias_taps: p.antiAliasTaps,
    anti_alias_hz: p.antiAliasHz,
    corr_window_ms: p.corrWindowMs,
    lag_ms: [p.lagMs[0], p.lagMs[1]],
    floor_db: p.floorDb,
    over_floor_db: p.overFloorDb,
    periodicity: p.periodicity,
    on_ms: [p.onMs[0], p.onMs[1]],
    off_ms: p.offMs,
  };
}

export interface VadFrozenOptions {
  /**
   * Throw a RangeError when the block has no floor_db. The floor is the one detector parameter
   * doctor measures before gate-prereg freezes the block (spec 7.3, 7.12); without this option a
   * missing floor_db silently takes the -70 dB placeholder of DEFAULT_VAD_PARAMS.
   */
  readonly requireFloor?: boolean;
}

/** A frozen `vad` block read with a marker for its floor. */
export interface VadFrozenRead {
  readonly params: VadParams;
  /**
   * False when the block has no floor_db: params.floorDb is then the -70 dB placeholder, not a
   * measured floor, and the caller must supply one (doctor's calib.json) or refuse to run.
   */
  readonly floorMeasured: boolean;
}

/**
 * VadParams from the `vad` block of params/frozen.json. Keys it does not know are ignored (the
 * schema keeps the block open); a missing key takes its DEFAULT_VAD_PARAMS value, floor_db
 * included unless `requireFloor` (use readVadFrozenBlock to tell); a key of the wrong type
 * throws a RangeError. The result is checked like createVad() checks it.
 */
export function vadParamsFromFrozen(block: Readonly<Record<string, unknown>>, opts: VadFrozenOptions = {}): VadParams {
  if (block === null || typeof block !== 'object' || Array.isArray(block)) {
    throw new RangeError('vadParamsFromFrozen: the vad block must be an object');
  }
  if (opts.requireFloor === true && block['floor_db'] === undefined) {
    throw new RangeError('vadParamsFromFrozen: floor_db is missing: freeze the floor doctor measured with the block (spec 7.3, 7.12)');
  }
  const out: Record<string, unknown> = {};
  for (const [key, name] of SCALARS) {
    const v = block[key];
    if (v === undefined) continue;
    if (typeof v !== 'number' || !Number.isFinite(v)) throw new RangeError(`vadParamsFromFrozen: ${key} must be a finite number`);
    out[name] = v;
  }
  for (const [key, name] of PAIRS) {
    const v = block[key];
    if (v === undefined) continue;
    if (!Array.isArray(v) || v.length !== 2 || !v.every((x) => typeof x === 'number' && Number.isFinite(x))) {
      throw new RangeError(`vadParamsFromFrozen: ${key} must be a pair of finite numbers`);
    }
    out[name] = Object.freeze([v[0] as number, v[1] as number]);
  }
  const params = resolveVadParams(out as Partial<VadParams>);
  // Construct once so inconsistent values fail here, not later in the worklet.
  createVad(params);
  return params;
}

/**
 * The `vad` block of params/frozen.json with a marker for its floor: `floorMeasured` is false
 * when floor_db is absent and params.floorDb is the placeholder (the spec 8.4 example lists only
 * part of the keys and has none). Throws like vadParamsFromFrozen.
 */
export function readVadFrozenBlock(block: Readonly<Record<string, unknown>>): VadFrozenRead {
  const params = vadParamsFromFrozen(block);
  return { params, floorMeasured: block['floor_db'] !== undefined };
}
