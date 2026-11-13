// Stage A (analysis/gate/frozen.ts, written in parallel) rewrites the file this module writes: it must
// add only what STAGE_A_PATHS names and keep the text format. A static import, so a broken or renamed
// module fails here instead of skipping.
import { describe, expect, it } from 'vitest';
import { frozenParamsText as stageAText, frozenWithTuning, withoutStageAKeys } from '../../analysis/gate/frozen.ts';
import { validateFrozenParams } from '../../core/schemas/index.ts';
import { buildGatePreregParams, frozenParamsText, stageAKeysFound, STAGE_A_PATHS, withoutStageA } from './frozen.ts';

const DOCTOR = { id: 'doctor-2', periodicity: 0.6, floorDb: -58.3 };

describe('agreement with stage A (spec 8.4)', () => {
  const base = buildGatePreregParams(DOCTOR).params as unknown as Record<string, unknown>;
  const tuned = frozenWithTuning(base, { k: 2.5, criterionMet: true, thetaG: 0.0275, step: 'stage_a' }) as unknown as Record<string, unknown>;

  it('stage A writes exactly the values STAGE_A_PATHS names, and nothing else', () => {
    expect(validateFrozenParams(tuned)).toEqual([]);
    expect(stageAKeysFound(tuned).map((l) => l.split(' ')[0])).toEqual(STAGE_A_PATHS.filter((p) => p.length > 1 || p[0] === 'tuned').map((p) => p.join('.')));
    expect(withoutStageAKeys(tuned)).toEqual(base);
    expect(withoutStageA(tuned)).toEqual(base);
  });

  it('both write the same text for the same values', () => {
    expect(stageAText(base)).toBe(frozenParamsText(base));
    expect(stageAText(tuned)).toBe(frozenParamsText(tuned));
  });
});
