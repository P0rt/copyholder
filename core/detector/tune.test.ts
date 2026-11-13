import { describe, expect, it } from 'vitest';
import { synthSession } from './synth.ts';
import { chooseK, kStepDown, kStepUp, stageAChooseK } from './tune.ts';

describe('stage A choice of k (spec 7.4)', () => {
  const trial = (k: number, fires: number, activeMinutes: number) => ({ k, fires, activeMinutes });

  it('takes the smallest k with at most 1.0 fire per active minute', () => {
    const c = chooseK([trial(3.5, 0, 2), trial(1.5, 5, 2), trial(2.0, 3, 2), trial(2.5, 2, 2), trial(3.0, 1, 2)]);
    expect(c.k).toBe(2.5);
    expect(c.criterionMet).toBe(true);
    expect(c.trials.map((t) => [t.k, t.rate])).toEqual([
      [1.5, 2.5],
      [2.0, 1.5],
      [2.5, 1.0],
      [3.0, 0.5],
      [3.5, 0],
    ]);
  });

  it('takes 3.5 with criterion not met when no k qualifies, or there was no active time', () => {
    expect(chooseK([1.5, 2, 2.5, 3, 3.5].map((k) => trial(k, 9, 3)))).toMatchObject({ k: 3.5, criterionMet: false });
    expect(chooseK([1.5, 2, 2.5, 3, 3.5].map((k) => trial(k, 0, 0)))).toMatchObject({ k: 3.5, criterionMet: false });
    expect(() => chooseK([trial(1.5, 0, 1)])).toThrow(/k = 2/);
  });

  it('steps k along the grid', () => {
    expect(kStepUp(2.5)).toBe(3.0);
    expect(kStepUp(3.5)).toBeNull();
    expect(kStepDown(2.5)).toBe(2.0);
    expect(kStepDown(1.5)).toBeNull();
  });

  it('runs D1 with its own stops for every k; fewer fires with a larger k', () => {
    // A listening block of irregular breathing (25% jitter of depth and rate) with steep inhales
    // and no reply: every fire is false.
    const ses = synthSession({
      seed: 42,
      durationS: 300,
      rateJitter: 0.25,
      depthJitter: 0.25,
      objections: [100, 125, 150, 175, 200, 225, 250, 275].map((atS, i) => ({ atS, voice: false, depth: 0.8 + 0.1 * i, inhaleS: 0.9 })),
    });
    const c = stageAChooseK(ses.inputs, { nArrBySeq: ses.nArrBySeq, sign: 1 });
    const fires = c.trials.map((t) => t.fires);
    for (let i = 1; i < fires.length; i++) expect(fires[i]!).toBeLessThanOrEqual(fires[i - 1]!);
    expect(fires[0]! - fires[fires.length - 1]!).toBeGreaterThanOrEqual(5);
    expect(c.trials.every((t) => t.activeMinutes > 3)).toBe(true);
    expect(c.trials[0]!.rate!).toBeGreaterThan(1);
    expect(c.criterionMet).toBe(true);
    expect(c.k).toBe(c.trials.find((t) => t.rate !== null && t.rate <= 1)!.k);
    expect(c.k).toBeGreaterThan(1.5);
    // The frozen-file form of the params gives the same answer.
    const frozen = stageAChooseK(ses.inputs, { nArrBySeq: ses.nArrBySeq, sign: 1, params: { schema: 'params/1', d1: { L: 5 } } });
    expect(frozen).toEqual(c);
  });
});
