// processorOptions of the Deck node (docs/protocol.md): mode, output gain and the voice detector
// parameters. Deck and the recomputation of the voice edges after a recording (analysis/lib/
// calib-io.ts chooseVadParams) pick the parameters with one rule, pickVadParams below, so the live
// edges in detector_in.jsonl and the recomputed ones come from one parameter set (spec 7.3, 7.12):
//   1. the `vad` block of params/frozen.json (/api/config detector.params.vad) when it names
//      floor_db; a block without floor_db was frozen before doctor measured anything, so the floor
//      and the periodicity threshold doctor wrote into calib.json (calib.vad) replace its
//      placeholder floor and its threshold, and its other keys stay;
//   2. else the floor and periodicity doctor wrote into calib.json (calib.vad);
//   3. else none: Deck runs DEFAULT_VAD_PARAMS.
// A block that core/vad cannot use counts as absent, as in analysis.
import { vadParamsFromFrozen, type VadParams } from '../../core/vad/index.ts';

export interface DeckVadChoice {
  /** Every field of the detector; Deck reads camelCase fields as VadParams (web/lib/deck-core.ts). */
  params: VadParams;
  /** Where the values come from, for the console log. */
  source: string;
}

export interface DeckNodeOptions {
  /** /api/config mode (Deck maps it to live, key or gate). */
  mode: string;
  /** Output gain until the first {k:'gain'} (spec 7.7). */
  gain: number;
  vadParams?: VadParams;
}

/** calib.json `vad` of doctor (analysis/doctor.ts): the floor and the periodicity threshold (spec 7.12). */
export interface DoctorVadValues {
  floor_db: number;
  periodicity: number;
}

/**
 * Where picked parameters come from: the frozen block as written; the frozen block with doctor's
 * floor and threshold; the frozen block on its placeholder floor (nobody measured one); doctor.
 */
export type VadOrigin = 'frozen' | 'frozen+doctor' | 'frozen-default-floor' | 'doctor';

export interface VadPick {
  /** Every field of the detector; with origin 'frozen-default-floor' floorDb is the default placeholder. */
  params: VadParams;
  origin: VadOrigin;
}

type Obj = Record<string, unknown>;

function obj(v: unknown): Obj | null {
  return typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Obj) : null;
}

/** calib.json `vad` of doctor: {floor_db, periodicity}, both finite numbers (analysis/lib/calib-io.ts calibVad). */
function doctorVad(calib: unknown): DoctorVadValues | null {
  const v = obj(obj(calib)?.['vad']);
  const floor = v?.['floor_db'];
  const periodicity = v?.['periodicity'];
  return typeof floor === 'number' && Number.isFinite(floor) && typeof periodicity === 'number' && Number.isFinite(periodicity)
    ? { floor_db: floor, periodicity }
    : null;
}

function usable(block: Obj): VadParams | null {
  try {
    return vadParamsFromFrozen(block);
  } catch {
    return null;
  }
}

/**
 * The one rule Deck and analysis share (spec 7.3, 7.12): `frozenBlock` is the `vad` block of
 * params/frozen.json (anything else counts as absent), `doctor` the calib.json `vad` of doctor.
 * A frozen block that names floor_db is taken as written. One without floor_db was frozen before
 * doctor (the spec 8.4 example has none): doctor's floor and periodicity threshold replace its
 * placeholder floor and its threshold, its other keys stay; without doctor values it runs on the
 * placeholder floor. Without a usable frozen block, doctor's values; else null.
 */
export function pickVadParams(frozenBlock: unknown, doctor: DoctorVadValues | null): VadPick | null {
  const block = obj(frozenBlock);
  const frozen = block ? usable(block) : null;
  if (block && frozen) {
    if (typeof block['floor_db'] === 'number') return { params: frozen, origin: 'frozen' };
    const withDoctor = doctor ? usable({ ...block, floor_db: doctor.floor_db, periodicity: doctor.periodicity }) : null;
    return withDoctor ? { params: withDoctor, origin: 'frozen+doctor' } : { params: frozen, origin: 'frozen-default-floor' };
  }
  const fromDoctor = doctor ? usable({ floor_db: doctor.floor_db, periodicity: doctor.periodicity }) : null;
  return fromDoctor ? { params: fromDoctor, origin: 'doctor' } : null;
}

const DECK_SOURCES: Record<VadOrigin, string> = {
  frozen: 'params/frozen.json',
  'frozen+doctor': 'params/frozen.json with the floor measured by doctor and its periodicity threshold (the file has no floor_db)',
  'frozen-default-floor': 'params/frozen.json; no floor_db and no doctor floor, so the default floor',
  doctor: 'calib.json of doctor',
};

/** The voice detector parameters for Deck from the /api/config JSON, or null for Deck's defaults. */
export function chooseDeckVadParams(config: Obj): DeckVadChoice | null {
  const pick = pickVadParams(obj(obj(config['detector'])?.['params'])?.['vad'], doctorVad(config['calib']));
  if (!pick) return null;
  const p = pick.params;
  return { params: p, source: `${DECK_SOURCES[pick.origin]} (floor ${p.floorDb} dB, periodicity ${p.periodicity})` };
}

/** processorOptions for `new AudioWorkletNode(ctx, 'deck', ...)` (docs/protocol.md). */
export function deckNodeOptions(config: { mode: string; raw: Obj }, gain: number): { options: DeckNodeOptions; vadSource: string } {
  const vad = chooseDeckVadParams(config.raw);
  const options: DeckNodeOptions = { mode: config.mode, gain };
  if (vad) options.vadParams = vad.params;
  return { options, vadSource: vad ? vad.source : 'none in /api/config: Deck runs DEFAULT_VAD_PARAMS' };
}
