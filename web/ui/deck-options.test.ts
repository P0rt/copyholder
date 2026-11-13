import { describe, expect, it } from 'vitest';
import { DEFAULT_VAD_PARAMS } from '../../core/vad/index.ts';
import { chooseDeckVadParams, deckNodeOptions } from './deck-options.ts';

const FROZEN = { floor_db: -62.5, periodicity: 0.55, note_for_later: 'kept open' };
const DOCTOR = { schema: 'calib/1', vad: { floor_db: -58, periodicity: 0.6 } };

function config(frozenVad: unknown, calib: unknown): Record<string, unknown> {
  return { mode: 'gate', detector: { params: frozenVad === undefined ? {} : { vad: frozenVad }, sign: 1, variant: 'D1' }, calib };
}

describe('Deck voice detector parameters in processorOptions (spec 7.3, 7.12)', () => {
  it('takes the frozen block when it has a floor, over the doctor values', () => {
    const got = chooseDeckVadParams(config(FROZEN, DOCTOR));
    expect(got?.params).toEqual({ ...DEFAULT_VAD_PARAMS, floorDb: -62.5, periodicity: 0.55 });
    expect(got?.source).toBe('params/frozen.json (floor -62.5 dB, periodicity 0.55)');
  });

  it('puts the doctor floor and periodicity into a frozen block without floor_db, and keeps its other keys', () => {
    const got = chooseDeckVadParams(config({ periodicity: 0.45, off_ms: 900 }, DOCTOR));
    expect(got?.params).toEqual({ ...DEFAULT_VAD_PARAMS, floorDb: -58, periodicity: 0.6, offMs: 900 });
    expect(got?.source).toMatch(/^params\/frozen.json with the floor measured by doctor/);
  });

  it('runs a frozen block without floor_db and without doctor on the default floor', () => {
    const got = chooseDeckVadParams(config({ periodicity: 0.45 }, null));
    expect(got?.params).toEqual({ ...DEFAULT_VAD_PARAMS, periodicity: 0.45 });
    expect(got?.source).toMatch(/default floor/);
  });

  it('takes floor and periodicity of doctor before the freeze', () => {
    const got = chooseDeckVadParams(config(undefined, DOCTOR));
    expect(got?.params).toEqual({ ...DEFAULT_VAD_PARAMS, floorDb: -58, periodicity: 0.6 });
    expect(got?.source).toBe('calib.json of doctor (floor -58 dB, periodicity 0.6)');
  });

  it('treats a frozen block core/vad cannot use as absent, as analysis does', () => {
    const got = chooseDeckVadParams(config({ periodicity: 'high' }, DOCTOR));
    expect(got?.params).toEqual({ ...DEFAULT_VAD_PARAMS, floorDb: -58, periodicity: 0.6 });
    expect(chooseDeckVadParams(config({ periodicity: 'high' }, null))).toBeNull();
  });

  it('leaves vadParams out when nothing is known, and ignores a doctor block with missing values', () => {
    expect(chooseDeckVadParams(config(undefined, null))).toBeNull();
    expect(chooseDeckVadParams(config(undefined, { vad: { floor_db: -58 } }))).toBeNull();
    expect(chooseDeckVadParams({ mode: 'doctor', detector: null, calib: null })).toBeNull();
    const { options, vadSource } = deckNodeOptions({ mode: 'doctor', raw: { mode: 'doctor', calib: null } }, 0.25);
    expect(options).toEqual({ mode: 'doctor', gain: 0.25 });
    expect('vadParams' in options).toBe(false);
    expect(vadSource).toMatch(/DEFAULT_VAD_PARAMS/);
  });

  it('builds processorOptions that survive the structured clone into the AudioWorklet', () => {
    const { options } = deckNodeOptions({ mode: 'gate', raw: config(FROZEN, DOCTOR) }, 0.35);
    expect(options).toEqual({ mode: 'gate', gain: 0.35, vadParams: { ...DEFAULT_VAD_PARAMS, floorDb: -62.5, periodicity: 0.55 } });
    expect(structuredClone(options)).toEqual(options);
  });
});
