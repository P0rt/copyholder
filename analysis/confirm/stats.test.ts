// Hand-checked examples for the statistics of npm run confirm (PREREG.md sections 9.1, 9.2, 11).
// Each expected value is worked out by hand or from a chi-square table in the comment beside it.

import { describe, expect, it } from 'vitest';
import { exampleVerdict } from '../../core/schemas/examples.ts';
import { THETA_G_GRID, type Verdict } from '../../core/schemas/index.ts';
import { buildShiftSession, circleCoverage, median, type ShiftSession } from '../../core/stats/index.ts';
import type { HitsRow, PairTally } from '../gate/rows.ts';
import { msToN, round1, round1OrNull } from '../gate/common.ts';
import { ConfirmRefusal } from './common.ts';
import { SENSITIVITY_KEYS, equalRateOf, factsDifferences, ownEqualRate, requireFactsMatch, type LipsAtTheta, type PackFacts, type SensitivityKey } from './facts.ts';
import { confirmNumbers, equalRateLine, medianLine, shareLine } from './numbers.ts';
import { equalRateText } from './report.ts';
import { h1Test, largerChanceLevel, packCircleInput, poissonEstimate, poissonRateInterval, postVoiceEndN, shiftEstimate } from './stats.ts';

describe('the share and its 95% Wilson interval (section 9.1)', () => {
  it('8 of 14: 57.1%, 32.6% to 78.6%', () => {
    // centre (p + z^2/2n) / (1 + z^2/n) = 0.5561, half width 0.2301, z = 1.95996
    const s = shareLine(8, 14);
    expect(s.share).toBeCloseTo(8 / 14, 12);
    expect(s.low).toBeCloseTo(0.325906, 5);
    expect(s.high).toBeCloseTo(0.786192, 5);
  });

  it('0 of 0 has no share', () => {
    expect(shareLine(0, 0)).toMatchObject({ k: 0, n: 0, share: null });
  });
});

describe('H1: the exact one-sided binomial test (section 9.1)', () => {
  it('2 of 2 against p0 0.1 gives p = 0.01, 1 of 2 gives 0.19', () => {
    // P(X >= 2) = 0.1^2; P(X >= 1) = 1 - 0.9^2
    expect(h1Test(2, 2, 0.1)).toMatchObject({ k: 2, n: 2, p0: 0.1, alpha: 0.05, belowAlpha: true });
    expect(h1Test(2, 2, 0.1).pValue).toBeCloseTo(0.01, 12);
    expect(h1Test(1, 2, 0.1).pValue).toBeCloseTo(0.19, 12);
    expect(h1Test(1, 2, 0.1).belowAlpha).toBe(false);
  });

  it('p at alpha exactly is below alpha (at or below)', () => {
    // P(X >= 1) with n = 1 is p0 itself
    expect(h1Test(1, 1, 0.05).belowAlpha).toBe(true);
  });
});

describe('the chance level of H1 (sections 9.2 and 11)', () => {
  it('estimate 1: 32 false holds in 16 active minutes give 2.686/min and p0 = 6.50%', () => {
    // one-sided 95% upper bound: chi2(0.95, 66) / 2 = 42.982, / 16 min = 2.6864/min;
    // p0 = 1 - exp(-2.6864 * 1.5 / 60) = 0.06495
    const e = poissonEstimate(32, 16)!;
    expect(e.ratePerMin).toBe(2);
    expect(e.rateUpperPerMin).toBeCloseTo(2.6864, 3);
    expect(e.p0).toBeCloseTo(0.064954, 5);
    expect(e.windowMs).toBe(1500);
  });

  it('estimate 1 does not exist without active time', () => {
    expect(poissonEstimate(0, 0)).toBeNull();
  });

  it('p0 is the larger estimate; a tie goes to the Poisson one; both must exist', () => {
    expect(largerChanceLevel(0.02, 0.03)).toEqual({ p0: 0.03, source: 'shift' });
    expect(largerChanceLevel(0.03, 0.02)).toEqual({ p0: 0.03, source: 'poisson' });
    expect(largerChanceLevel(0.03, 0.03)).toEqual({ p0: 0.03, source: 'poisson' });
    expect(largerChanceLevel(null, 0.03)).toBeNull();
    expect(largerChanceLevel(0.03, null)).toBeNull();
  });

  it('estimate 2: one stop on a 60 s circle covers 1.5 s of it, so the shifts give about 2.5%', () => {
    const session: ShiftSession = { lengthMs: 60_000, stopsMs: [10_000], onsetsMs: [5_000, 20_000, 40_000] };
    expect(circleCoverage(session.stopsMs, 1500, session.lengthMs)).toBeCloseTo(0.025, 12);
    const e = shiftEstimate([{ name: 'pack B', session }], { seed: 43, shifts: 10_000 })!;
    expect(e.share!).toBeGreaterThan(0.025 - 4 * e.standardError!);
    expect(e.share!).toBeLessThan(0.025 + 4 * e.standardError!);
    expect(e).toMatchObject({ shifts: 10_000, seed: 43, onsets: 3, windowMs: 1500, circleMinutes: 1, leftOut: [] });
    // Seeded: the same call gives the same share, bit for bit.
    expect(shiftEstimate([{ name: 'pack B', session }], { seed: 43, shifts: 10_000 })!.share).toBe(e.share);
  });

  it('estimate 2 pools the packs and names a pack with objections but no active time', () => {
    const b: ShiftSession = { lengthMs: 60_000, stopsMs: [], onsetsMs: [1_000] };
    const c: ShiftSession = { lengthMs: 0, stopsMs: [], onsetsMs: [0, 0] };
    const e = shiftEstimate(
      [
        { name: 'pack B', session: b },
        { name: 'pack C', session: c },
      ],
      { shifts: 100 },
    )!;
    expect(e.share).toBe(0);
    expect(e.onsets).toBe(1);
    expect(e.leftOut).toEqual(['pack C']);
    expect(shiftEstimate([{ name: 'pack C', session: c }], { shifts: 100 })).toBeNull();
    expect(shiftEstimate([{ name: 'pack B', session: { lengthMs: 60_000, stopsMs: [], onsetsMs: [] } }], { shifts: 100 })).toBeNull();
  });
});

describe('the circle of one pack (section 9.2 item 2)', () => {
  const n = (seconds: number): number => msToN(seconds * 1000);
  const spans = [
    { n0: n(100), n1: n(200) },
    { n0: n(210), n1: n(400) },
  ];

  it('the post-voice period ends where the trace detector is next active', () => {
    expect(postVoiceEndN(spans, n(205), n(500))).toBe(n(210));
    // active at the end of the voice: no post-voice period
    expect(postVoiceEndN(spans, n(150), n(500))).toBe(n(150));
    // no later active span: to the end of the block
    expect(postVoiceEndN(spans, n(450), n(500))).toBe(n(500));
    expect(postVoiceEndN(spans, n(600), n(500))).toBe(n(600));
  });

  it('keeps active time inside the block and cuts each objection from 3 s before its voice to its post-voice end', () => {
    const c = packCircleInput({
      spans: [{ n0: n(50), n1: n(200) }, spans[1]!],
      block: { n0: n(120), n1: n(300) },
      stopsN: [n(130), n(197), n(250)],
      objections: [{ nV: n(199), nEnd: n(205) }],
      onsetsN: [n(199)],
    });
    expect(c.activeMs).toEqual([
      { startMs: 120_000, endMs: 200_000 },
      { startMs: 210_000, endMs: 300_000 },
    ]);
    // from 199 - 3 s to the next active time after the voice ends at 205 s
    expect(c.cutMs).toEqual([{ startMs: 196_000, endMs: 210_000 }]);
    expect(c.stopsMs).toEqual([130_000, 197_000, 250_000]);
    expect(c.onsetsMs).toEqual([199_000]);
    // 76 s + 90 s stay on the circle; the stop at 197 s is inside the cut and leaves it
    const session = buildShiftSession(c);
    expect(session.lengthMs).toBe(166_000);
    expect(session.onsetsMs).toEqual([76_000]);
    expect(session.stopsMs).toEqual([10_000, 116_000]);
  });
});

describe('the median lead and its 95% interval (section 9.1)', () => {
  it('14 values: order statistics 3 and 12, exact coverage 98.7%', () => {
    // P(Binomial(14, 1/2) <= 2) = 106 / 16384 = 0.00647 <= 0.025 < P(<= 3); coverage 1 - 2 * 0.00647
    const values = [310, 120, 450, 300, 280, 330, 205, 260, 410, 390, 350, 290, 240, 500];
    const m = medianLine(values);
    const sorted = [...values].sort((a, b) => a - b);
    expect(m).toMatchObject({ n: 14, kind: 'order-statistics', lowerRank: 3, upperRank: 12, low: sorted[2], high: sorted[11] });
    expect(m.median).toBe((sorted[6]! + sorted[7]!) / 2);
    expect(m.coverage).toBeCloseTo(0.987061, 5);
  });

  it('5 values or fewer: the range', () => {
    expect(medianLine([300, 100, 200])).toMatchObject({ n: 3, median: 200, low: 100, high: 300, kind: 'range' });
    expect(medianLine([])).toMatchObject({ n: 0, median: null, kind: null });
  });
});

describe('false holds per active minute with a two-sided 95% Poisson interval (section 11)', () => {
  it('10 in 10 minutes: 1.00/min, 0.480 to 1.839', () => {
    // chi2(0.025, 20) / 2 = 4.7954 and chi2(0.975, 22) / 2 = 18.390, over 10 minutes
    const r = poissonRateInterval(10, 10);
    expect(r.perMin).toBe(1);
    expect(r.low!).toBeCloseTo(0.479539, 5);
    expect(r.high!).toBeCloseTo(1.839036, 5);
  });

  it('0 in 10 minutes: 0.00/min, 0 to 0.369', () => {
    // chi2(0.975, 2) / 2 = 3.6889, over 10 minutes
    const r = poissonRateInterval(0, 10);
    expect(r.perMin).toBe(0);
    expect(r.low).toBe(0);
    expect(r.high!).toBeCloseTo(0.368888, 5);
  });

  it('no active time: no rate', () => {
    expect(poissonRateInterval(3, 0)).toMatchObject({ perMin: null, low: null, high: null });
  });
});

// ---- pooled numbers from hand-made pack facts ------------------------------------------------

function hitsRowOf(valid: number, leadsMs: number[], armed = valid): HitsRow {
  return { hits: leadsMs.length, armedHits: leadsMs.length, valid, armed, leadsMs, leads0to50: leadsMs.filter((l) => l <= 50).length, outcome: 'PASS' };
}

function tally([wins, losses, ties]: [number, number, number]): PairTally {
  return { wins, losses, ties, bothBeforeN: 0, leadDiffMedianMs: null };
}

/** G at one theta_G: `falseStops` false fires over `minutes` active minutes, and the pairs (chest first). */
function lipsAt(thetaG: number, falseStops: number, minutes: number, pairs: [number, number, number]): LipsAtTheta {
  return { thetaG, lipsFalse: { stops: falseStops + 1, falseStops, activeMinutes: minutes, perMin: falseStops / minutes }, vsLips: tally(pairs) };
}

function factsOf(
  pack: 'B' | 'C',
  o: {
    valid: number;
    leadsMs: number[];
    vsLips: [number, number, number];
    vsA250: [number, number, number];
    falseStops: number;
    stops: number;
    minutes: number;
    breaths: number;
    /** G over the grid; by default no false fire at any theta_G and the pairs of vsLips. */
    lipsGrid?: LipsAtTheta[];
  },
): PackFacts {
  const hits = hitsRowOf(o.valid, o.leadsMs);
  const sensitivity = Object.fromEntries(SENSITIVITY_KEYS.map((k) => [k, { valid: o.valid, hits }])) as Record<SensitivityKey, { valid: number; hits: HitsRow }>;
  return {
    id: `gate-${pack.toLowerCase()}`,
    pack,
    cued: 14,
    points: Array.from({ length: o.valid }, (_, i) => ({ cue: i + 1, nV: 0, armed: true, breath: i < o.breaths })),
    hits,
    misses: { noInbreath: o.valid - o.leadsMs.length, inbreathAudible: 0 },
    leadsAllMs: o.leadsMs,
    chestFalse: { stops: o.stops, falseStops: o.falseStops, activeMinutes: o.minutes, perMin: o.falseStops / o.minutes },
    lipsFalse: { stops: 0, falseStops: 0, activeMinutes: o.minutes, perMin: 0 },
    vsLips: tally(o.vsLips),
    vsA250: tally(o.vsA250),
    a250Stops: o.valid,
    thetaG: 0.02,
    lipsGrid: o.lipsGrid ?? [...THETA_G_GRID].sort((x, y) => x - y).map((t) => lipsAt(t, 0, o.minutes, o.vsLips)),
    circle: { lengthMs: o.minutes * 60_000, stopsMs: [], onsetsMs: Array.from({ length: o.valid }, (_, i) => i * 1000) },
    sensitivity: { ...sensitivity, manual: { valid: o.valid, hits: hitsRowOf(o.valid, o.leadsMs.slice(1)) } },
  };
}

describe('the pooled numbers (section 11)', () => {
  const b = factsOf('B', { valid: 12, leadsMs: [100, 250, 299.94, 299.96, 320, 400, 40], vsLips: [4, 2, 1], vsA250: [9, 1, 2], falseStops: 2, stops: 9, minutes: 3, breaths: 7 });
  const c = factsOf('C', { valid: 14, leadsMs: [200, 310, 330, 350], vsLips: [3, 2, 0], vsA250: [1, 0, 4], falseStops: 1, stops: 4, minutes: 2.5, breaths: 4 });
  const n = confirmNumbers([b, c], { shifts: 200 });

  it('adds up the counts of both packs', () => {
    expect(n.packs).toEqual([
      { pack: 'B', id: 'gate-b' },
      { pack: 'C', id: 'gate-c' },
    ]);
    expect([n.cued, n.valid, n.armed, n.audibleInbreath]).toEqual([28, 26, 26, 11]);
    expect(n.h1.share).toMatchObject({ k: 11, n: 26 });
    expect(n.h1.leads0to50).toBe(1);
    expect(n.h1.misses).toEqual({ noInbreath: 15, inbreathAudible: 0 });
    expect(n.falseHolds).toMatchObject({ count: 3, stops: 13, activeMinutes: 5.5 });
    expect(n.falseHolds.perPack.map((p) => [p.pack, p.count])).toEqual([
      ['B', 2],
      ['C', 1],
    ]);
    expect(n.sensitivity.find((s) => s.key === 'manual')!.share).toMatchObject({ k: 9, n: 26 });
  });

  it('counts leads under 300 ms on the printed lead (0.1 ms)', () => {
    // 40, 100, 200, 250 and 299.94 (299.9) are under 300; 299.96 prints as 300.0
    expect(n.h1.under300).toMatchObject({ k: 5, n: 26 });
  });

  it('runs the sign tests on the pooled pairs with Holm over H3 and H4', () => {
    // H3 7:4 (ties 1): P(W >= 7 | 11) = 562 / 2048; H4 10:1 (ties 6): P(W >= 10 | 11) = 12 / 2048.
    // Holm: 2 * 12/2048 = 0.01172 for H4, then max(0.01172, 562/2048) for H3.
    expect(n.h3).toMatchObject({ wins: 7, losses: 4, ties: 1, nPairs: 12, nUntied: 11 });
    expect(n.h3.pValue).toBeCloseTo(562 / 2048, 12);
    expect(n.h4).toMatchObject({ wins: 10, losses: 1, ties: 6, nPairs: 17, nUntied: 11 });
    expect(n.h4.pValue).toBeCloseTo(12 / 2048, 12);
    expect(n.h4.pHolm).toBeCloseTo(24 / 2048, 12);
    expect(n.h3.pHolm).toBeCloseTo(562 / 2048, 12);
    expect([n.h3.belowAlpha, n.h4.belowAlpha]).toEqual([false, true]);
    expect(n.h3.thetaG).toEqual([
      { pack: 'B', thetaG: 0.02 },
      { pack: 'C', thetaG: 0.02 },
    ]);
  });

  it('Holm keeps the adjusted p-values in the order of the raw ones', () => {
    // H3 9:1: 11/1024 = 0.01074; H4 10:1: 12/2048 = 0.00586. Holm: 2 * 0.00586 = 0.01172 for H4,
    // and max(0.01172, 0.01074) = 0.01172 for H3.
    const x = factsOf('B', { valid: 10, leadsMs: [300], vsLips: [9, 1, 0], vsA250: [10, 1, 0], falseStops: 0, stops: 1, minutes: 3, breaths: 0 });
    const m = confirmNumbers([x], { shifts: 10 });
    expect(m.h3.pValue).toBeCloseTo(11 / 1024, 12);
    expect(m.h3.pHolm).toBeCloseTo(24 / 2048, 12);
    expect(m.h4.pHolm).toBeCloseTo(24 / 2048, 12);
  });

  it('tests H1 against the larger chance estimate', () => {
    const p = n.h1.chance.poisson!;
    expect(p).toMatchObject({ falseStops: 3, activeMin: 5.5 });
    expect(n.h1.chance.shift!.onsets).toBe(26);
    expect(n.h1.chance.sentenceEnds).toBeNull();
    expect(n.h1.chance.choice!.p0).toBe(Math.max(p.p0, n.h1.chance.shift!.share!));
    expect(n.h1.test).toMatchObject({ k: 11, n: 26, p0: n.h1.chance.choice!.p0 });
    expect(n.h1.noTest).toBeNull();
  });

  it('has no test without valid objections or without active time', () => {
    const none = factsOf('B', { valid: 0, leadsMs: [], vsLips: [0, 0, 0], vsA250: [0, 0, 0], falseStops: 0, stops: 0, minutes: 3, breaths: 0 });
    expect(confirmNumbers([none], { shifts: 10 }).h1).toMatchObject({ test: null, noTest: 'no valid objections' });
    const idle = { ...factsOf('B', { valid: 3, leadsMs: [], vsLips: [0, 0, 3], vsA250: [0, 0, 3], falseStops: 0, stops: 0, minutes: 1, breaths: 0 }) };
    idle.chestFalse = { ...idle.chestFalse, activeMinutes: 0, perMin: null };
    idle.circle = { lengthMs: 0, stopsMs: [], onsetsMs: [0, 0, 0] };
    const m = confirmNumbers([idle], { shifts: 10 });
    expect(m.h1.test).toBeNull();
    expect(m.h1.noTest).toMatch(/no active time/);
    // the sign tests still run: three ties, no untied pair, p = 1
    expect(m.h3).toMatchObject({ ties: 3, nUntied: 0, pValue: 1 });
  });
});

describe('the exploratory line beside H3: lips at the chest rate (section 6.5)', () => {
  it('takes the smallest theta_G whose rate, rounded to 0.1 as printed, is at most the chest rate', () => {
    // 3.04 prints 3.0 and 1.26 prints 1.3, both above the chest's 1.2; 1.24 prints 1.2
    const grid = [
      { thetaG: 0.01, perMin: 3.04 },
      { thetaG: 0.0125, perMin: 1.26 },
      { thetaG: 0.015, perMin: 1.24 },
      { thetaG: 0.0175, perMin: 0.2 },
    ];
    expect(equalRateOf(grid, 1.2)).toEqual({ index: 2, thetaG: 0.015, lipsPerMin: 1.24, lastThetaG: 0.015 });
    // 0.549 is above 6/11 = 0.5454, but both print 0.5
    expect(equalRateOf([{ thetaG: 0.01, perMin: 0.549 }], 6 / 11)).toMatchObject({ index: 0, thetaG: 0.01 });
    expect(equalRateOf([{ thetaG: 0.01, perMin: 0.551 }], 6 / 11)).toMatchObject({ index: null, thetaG: null });
  });

  it('skips a theta_G without active time; without a qualifying one it keeps the rate at the largest', () => {
    expect(equalRateOf([{ thetaG: 0.01, perMin: null }, { thetaG: 0.0125, perMin: 0.1 }], 0.5)).toMatchObject({ index: 1, thetaG: 0.0125 });
    expect(equalRateOf([{ thetaG: 0.01, perMin: 3 }, { thetaG: 0.0125, perMin: 2.5 }], 0.5)).toEqual({ index: null, thetaG: null, lipsPerMin: 2.5, lastThetaG: 0.0125 });
    // no chest rate (no active time): no line, as stage B leaves exploratory_equal_rate null
    expect(equalRateOf([{ thetaG: 0.01, perMin: 3 }], null)).toBeNull();
  });

  // Pack B: chest 2 false holds in 3 min; pack C: 1 in 2.5 min. Pooled chest rate 3 / 5.5 = 0.545, printed 0.5.
  // Lips, pooled over minutes: 0.0100 15 / 5.5 = 2.7; 0.0125 5 / 5.5 = 0.9; 0.0150 2 / 4 = 0.5, the first at most 0.5.
  const grid = (rows: [number, number, number, [number, number, number]][]): LipsAtTheta[] => rows.map(([t, f, m, p]) => lipsAt(t, f, m, p));
  const b = factsOf('B', {
    valid: 12,
    leadsMs: [100],
    vsLips: [3, 2, 7],
    vsA250: [1, 0, 11],
    falseStops: 2,
    stops: 9,
    minutes: 3,
    breaths: 0,
    lipsGrid: grid([
      [0.01, 9, 3, [1, 5, 6]],
      [0.0125, 4, 3, [2, 4, 6]],
      [0.015, 1, 2, [3, 2, 7]],
    ]),
  });
  const c = factsOf('C', {
    valid: 14,
    leadsMs: [200],
    vsLips: [5, 1, 8],
    vsA250: [1, 0, 13],
    falseStops: 1,
    stops: 4,
    minutes: 2.5,
    breaths: 0,
    lipsGrid: grid([
      [0.01, 6, 2.5, [0, 6, 8]],
      [0.0125, 1, 2.5, [4, 3, 7]],
      [0.015, 1, 2, [5, 1, 8]],
    ]),
  });

  it("is pooled: the lips' false fires over their minutes against the pooled chest rate, and the pairs at that theta_G added up", () => {
    const e = equalRateLine([b, c], 3 / 5.5)!;
    expect(e).toMatchObject({ thetaG: 0.015, lastThetaG: 0.015, pairs: { wins: 8, losses: 3, ties: 15, nPairs: 26 } });
    expect(e.lipsPerMin).toBeCloseTo(0.5, 12);
    expect(e.chestPerMin).toBeCloseTo(3 / 5.5, 12);
    // Each pack alone, as its verdict.json holds it: pack C reaches its own 0.4 at 0.0125 already.
    expect(ownEqualRate(c)).toEqual({ wins: 4, losses: 3 });
    expect(ownEqualRate(b)).toEqual({ wins: 3, losses: 2 });
    expect(confirmNumbers([b, c], { shifts: 10 }).h3.equalRate).toEqual(e);
    expect(equalRateText(e)).toBe(
      "Exploratory, lips at the chest rate (section 6.5): at theta_G 0.0150, the smallest of the grid that does it, the lips make 0.5 false fires per active minute in the objection blocks against the chest's 0.5 (rounded to 0.1 as printed); chest wins 8, lips wins 3, ties 15, n = 26 pairs. Not a test.",
    );
  });

  it('says so when no theta_G qualifies or the chest has no rate, and refuses packs on different grids', () => {
    const none = equalRateLine([b, c], 0)!;
    expect(none).toMatchObject({ thetaG: null, pairs: null, lastThetaG: 0.015, chestPerMin: 0 });
    expect(none.lipsPerMin).toBeCloseTo(0.5, 12);
    expect(equalRateText(none)).toMatch(/no theta_G of the grid brings the lips down to the chest's 0\.0 false stops per active minute \(0\.5 at theta_G 0\.0150\): wins n\/a/);
    expect(equalRateLine([b, c], null)).toBeNull();
    expect(equalRateText(null)).toMatch(/no line, the trace detector had no active time/);
    expect(() => equalRateLine([b, { ...c, lipsGrid: c.lipsGrid.slice(1) }], 0.5)).toThrow(/lips grid differs/);
  });
});

describe('the counts added up are the counts of the verdict (a guard of the code, section 11)', () => {
  const f = factsOf('B', { valid: 12, leadsMs: [100, 250, 40], vsLips: [4, 2, 6], vsA250: [9, 1, 2], falseStops: 2, stops: 9, minutes: 3, breaths: 7 });

  /** verdict.json as stage B would write it from these facts (the rows the pooled numbers add up). */
  function verdictOf(x: PackFacts): Verdict {
    const v = exampleVerdict();
    return {
      ...v,
      id: x.id,
      pack: x.pack,
      tuning: { ...v.tuning, theta_G: x.thetaG },
      events: { cued: x.cued, valid: x.hits.valid, armed: x.hits.armed, audible_inbreath: x.points.filter((p) => p.breath).length },
      rows: {
        ...v.rows,
        hits: { ...v.rows.hits, hits: x.hits.hits, armed_hits: x.hits.armedHits, leads_0_50: x.hits.leads0to50 },
        lead: { ...v.rows.lead, median_hits_ms: round1OrNull(median(x.hits.leadsMs)), median_all_stops_ms: round1OrNull(median(x.leadsAllMs)) },
        false_holds: { ...v.rows.false_holds, per_min: round1OrNull(x.chestFalse.perMin), armed_min: round1(x.chestFalse.activeMinutes) },
        chest_vs_lips: {
          ...v.rows.chest_vs_lips,
          wins: x.vsLips.wins,
          losses: x.vsLips.losses,
          ties: x.vsLips.ties,
          both_before_n: x.vsLips.bothBeforeN,
          lips_false_per_min: round1OrNull(x.lipsFalse.perMin),
          exploratory_equal_rate: ownEqualRate(x),
        },
      },
      misses: { no_inbreath: x.misses.noInbreath, inbreath_audible: x.misses.inbreathAudible },
    };
  }

  it('agree on the facts the verdict was made from', () => {
    expect(factsDifferences(f, verdictOf(f))).toEqual([]);
    expect(() => requireFactsMatch('pack B (gate-b)', f, verdictOf(f))).not.toThrow();
  });

  it('refuses, naming each count that differs, the exploratory line included', () => {
    const v = verdictOf(f);
    // no false fire of the lips at any theta_G: the chest's 0.7 per minute is reached at the smallest, with the pairs 4:2
    const off: Verdict = { ...v, rows: { ...v.rows, hits: { ...v.rows.hits, hits: 2 }, chest_vs_lips: { ...v.rows.chest_vs_lips, exploratory_equal_rate: null } } };
    expect(factsDifferences(f, off)).toEqual(['rows.hits.hits: verdict 2, recomputed 3', 'rows.chest_vs_lips.exploratory_equal_rate: verdict null, recomputed {"wins":4,"losses":2}']);
    expect(() => requireFactsMatch('pack B (gate-b)', f, off)).toThrow(ConfirmRefusal);
    expect(() => requireFactsMatch('pack B (gate-b)', f, off)).toThrow(
      /^pack B \(gate-b\): the counts added up here differ from the counts of its verdict:\n {2}rows\.hits\.hits: verdict 2, recomputed 3\n {2}rows\.chest_vs_lips\.exploratory_equal_rate/,
    );
  });
});
