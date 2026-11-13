import { describe, expect, it } from 'vitest';
import {
  DEFAULT_D1_PARAMS,
  DEFAULT_HOLD_PARAMS,
  INVALID_VALIDATION_CODES,
  K_GRID,
  d1ParamsFromFrozen,
  holdParamsFromFrozen,
  msToGridSteps,
  msToSamples,
  resolveD1Params,
} from './params.ts';

// The params/frozen.json example of spec 8.4.
const FROZEN_EXAMPLE = {
  schema: 'params/1',
  d1: {
    grid_hz: 30,
    L: 5,
    M: 2,
    k: 2.5,
    theta_clamp: [1.3, 3.0],
    min_rise_A: 0.15,
    min_rise_ms: 200,
    arm_breaths: 10,
    refractory_ms: 2000,
    rearm_ms: 4000,
  },
  hold: { H_ms: 1500, ramp_frames: 384, audio_pause_ms: 250 },
  g: { theta_G: 0.0275, frames: 2, baseline_s: 10 },
};

describe('detector params (spec 7.4 table, 8.4)', () => {
  it('defaults hold the values of the 7.4 table', () => {
    const p = DEFAULT_D1_PARAMS;
    expect(p.grid_hz).toBe(30);
    expect(p.L).toBe(5);
    expect(p.M).toBe(2);
    expect(p.theta_clamp).toEqual([1.3, 3.0]);
    expect(p.min_rise_A).toBe(0.15);
    expect(p.min_rise_ms).toBe(200);
    expect(p.arm_breaths).toBe(10);
    expect(p.refractory_ms).toBe(2000);
    expect(p.rearm_ms).toBe(4000);
    expect(p.gap_unusable_ms).toBe(100);
    expect(p.gap_reset_ms).toBe(500);
    expect(p.gap_inactive_ms).toBe(3000);
    expect(p.amp_window_ms).toBe(30_000);
    expect(p.amp_max_age_ms).toBe(120_000);
    expect(p.amp_min_ms).toBe(15_000);
    expect(p.segment_step_A).toBe(0.25);
    expect(p.memory_breaths).toBe(20);
    expect(p.memory_entry_ms).toBe(2000);
    expect([...p.invalid_codes]).toEqual([1, 2, 7, 12]);
    expect(INVALID_VALIDATION_CODES).toEqual([1, 2, 7, 12]);
    expect(p.d3).toEqual({ k: 1.0, early_interval: 0.6, high_start_A: 0.25, start_v: 0.35, start_points: 3 });
    expect(K_GRID).toEqual([1.5, 2.0, 2.5, 3.0, 3.5]);
    expect(K_GRID).toContain(p.k);
    expect(DEFAULT_HOLD_PARAMS).toEqual({ H_ms: 1500, ramp_frames: 384 });
  });

  it('reads the d1 and hold blocks of params/frozen.json', () => {
    const p = d1ParamsFromFrozen({ ...FROZEN_EXAMPLE, d1: { ...FROZEN_EXAMPLE.d1, k: 3.0, L: 7, M: 1 } });
    expect(p.k).toBe(3.0);
    expect(p.L).toBe(7);
    expect(p.M).toBe(1);
    expect(p.theta_clamp).toEqual([1.3, 3.0]);
    expect(p.memory_breaths).toBe(20);
    expect(holdParamsFromFrozen(FROZEN_EXAMPLE)).toEqual({ H_ms: 1500, ramp_frames: 384 });
  });

  it('takes the preliminary k when the file has none (gate-prereg)', () => {
    const { k: _k, ...noK } = FROZEN_EXAMPLE.d1;
    expect(d1ParamsFromFrozen({ d1: noK }).k).toBe(2.5);
    expect(d1ParamsFromFrozen({}).k).toBe(2.5);
    expect(d1ParamsFromFrozen(null)).toEqual(resolveD1Params());
  });

  it('rejects wrong values', () => {
    expect(() => d1ParamsFromFrozen({ d1: { L: 1 } })).toThrow(/L/);
    expect(() => d1ParamsFromFrozen({ d1: { M: 0 } })).toThrow(/M/);
    expect(() => d1ParamsFromFrozen({ d1: { k: '2.5' } })).toThrow(/k/);
    expect(() => d1ParamsFromFrozen({ d1: { theta_clamp: [3, 1.3] } })).toThrow(/theta_clamp/);
    expect(() => d1ParamsFromFrozen({ d1: { theta_clamp: [1.3] } })).toThrow(/theta_clamp/);
    expect(() => resolveD1Params({ amp_min_ms: 40_000 })).toThrow(/amp_min_ms/);
    expect(() => resolveD1Params({ d3: { start_points: 0 } })).toThrow(/start_points/);
  });

  it('converts periods to grid steps and samples', () => {
    expect(msToGridSteps(2000, 30)).toBe(60);
    expect(msToGridSteps(4000, 30)).toBe(120);
    expect(msToGridSteps(200, 30)).toBe(6);
    expect(msToGridSteps(120_000, 30)).toBe(3600);
    expect(msToSamples(1500)).toBe(72_000);
    expect(msToSamples(8)).toBe(384);
  });
});
