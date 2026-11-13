// Control values computed in advance in the spec (13.4 row "Статистика", 7.10, 4.3, 4.4, 8.6).
import { describe, expect, it } from 'vitest';
import {
  binomialTestGreaterPValue,
  chanceLevelFromRatePerMin,
  holmAdjustedPValues,
  medianWithInterval,
  minSuccessesForSignificance,
  poissonChanceLevel,
  poissonRateUpperBoundPerMin,
  signTest,
  signTestMinWins,
  wilsonInterval,
} from './index.ts';

const pct = (x: number): number => Math.round(x * 100);
const oneDecimal = (x: number): number => Math.round(x * 10) / 10;

describe('spec 13.4, row "Статистика"', () => {
  it('Wilson 95%: 8 of 14 gives 33-79%', () => {
    const w = wilsonInterval(8, 14);
    expect(pct(w.low)).toBe(33);
    expect(pct(w.high)).toBe(79);
    // Independent 40-digit Decimal computation.
    expect(w.low).toBeCloseTo(0.325906445796507, 12);
    expect(w.high).toBeCloseTo(0.786192010955259, 12);
  });

  it('32 false stops in 16 minutes: upper bound 2.7 per minute (exact one-sided 95% Poisson)', () => {
    const upper = poissonRateUpperBoundPerMin(32, 16);
    expect(oneDecimal(upper)).toBe(2.7);
    // chi2_{0.95}(66) / 2 = 42.982453720615479, from an independent Decimal computation.
    expect(upper).toBeCloseTo(42.982453720615479 / 16, 12);
    // The two-sided 95% bound would print 2.8: the spec number pins the one-sided method.
    expect(oneDecimal(poissonRateUpperBoundPerMin(32, 16, 0.975))).toBe(2.8);
  });
});

describe('spec 7.10 control values', () => {
  it('14 events and p0 = 4.9%: 3 stops before the voice are enough', () => {
    expect(minSuccessesForSignificance(14, 0.049, 0.05)).toBe(3);
    expect(binomialTestGreaterPValue(3, 14, 0.049)).toBeCloseTo(0.028522885058882903, 14);
    expect(binomialTestGreaterPValue(2, 14, 0.049)).toBeCloseTo(0.14808669778038322, 14);
    // Same answer with the unrounded p0 of 2 false stops per minute.
    expect(minSuccessesForSignificance(14, chanceLevelFromRatePerMin(2), 0.05)).toBe(3);
  });

  it('20 pairs without ties: the sign test needs 15 wins', () => {
    expect(signTestMinWins(20, 0.05)).toBe(15);
    expect(signTest(15, 5).pValue).toBe(21700 / 2 ** 20);
    expect(signTest(14, 6).pValue).toBeGreaterThan(0.05);
  });

  it('14 leads: the median interval runs from the 3rd value from the bottom to the 3rd from the top', () => {
    const leadsMs = [410, 120, 330, 75, 260, 190, 505, 240, 160, 300, 220, 95, 380, 280];
    const sorted = [...leadsMs].sort((a, b) => a - b);
    const m = medianWithInterval(leadsMs);
    expect(m).not.toBeNull();
    expect(m?.kind).toBe('order-statistics');
    expect(m?.lowerRank).toBe(3);
    expect(m?.upperRank).toBe(12);
    expect(m?.low).toBe(sorted[2]);
    expect(m?.high).toBe(sorted[sorted.length - 3]);
    expect(m?.coverage).toBeCloseTo(1 - (2 * 106) / 16384, 15);
  });

  it('5 or fewer values: no 95% interval exists, the range is printed', () => {
    const m = medianWithInterval([210, 90, 160, 300, 140]);
    expect(m?.kind).toBe('range');
    expect(m?.low).toBe(90);
    expect(m?.high).toBe(300);
    expect(m?.median).toBe(160);
    expect(medianWithInterval([1, 2, 3, 4, 5, 6])?.kind).toBe('order-statistics');
  });
});

describe('spec 4.3 and 4.4 worked examples', () => {
  it('p0 at W = 1.5 s: 1, 2, 3, 5 false stops per minute give 2.5, 4.9, 7.2, 11.8%', () => {
    const p0Pct = (rate: number): number => Math.round(chanceLevelFromRatePerMin(rate, 1500) * 1000) / 10;
    expect([1, 2, 3, 5].map(p0Pct)).toEqual([2.5, 4.9, 7.2, 11.8]);
  });

  it('32 false stops in 16 active minutes: 2.0 per minute, upper bound 2.7, p0 = 6.5%', () => {
    const c = poissonChanceLevel(32, 16);
    expect(c.ratePerMin).toBe(2);
    expect(oneDecimal(c.rateUpperPerMin)).toBe(2.7);
    expect(Math.round(c.p0 * 1000) / 10).toBe(6.5);
  });

  it('Wilson: 11 of 20 gives 34-74%, 20 of 27 caught gives 55-87%', () => {
    const a = wilsonInterval(11, 20);
    const b = wilsonInterval(20, 27);
    expect([pct(a.low), pct(a.high)]).toEqual([34, 74]);
    expect([pct(b.low), pct(b.high)]).toEqual([55, 87]);
  });

  it('the results.json example of spec 8.6 is self-consistent', () => {
    // 5 hits of 17 matched: wilson_low_pct 13, wilson_high_pct 53.
    const w = wilsonInterval(5, 17);
    expect([pct(w.low), pct(w.high)]).toEqual([13, 53]);
    // chest_vs_lips 7:4 (ties 6) and chest_vs_audio250 6:11: p_holm 0.55 and 0.93.
    const lips = signTest(7, 4, 6);
    const audio = signTest(6, 11);
    // paired.chest_vs_lips.n is 17: every pair, ties included, as many as matched objections.
    expect(lips.nPairs).toBe(17);
    expect(lips.nUntied).toBe(11);
    const [holmLips, holmAudio] = holmAdjustedPValues([lips.pValue, audio.pValue]);
    expect(Math.round((holmLips ?? NaN) * 100) / 100).toBe(0.55);
    expect(Math.round((holmAudio ?? NaN) * 100) / 100).toBe(0.93);
  });
});
