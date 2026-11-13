// The sniff numbers of calib.json sniff_lag_ms and verdict.json rows.sniff_lag (spec 8.1, 9.6;
// PREREG §4): the found sniffs whose trace never arrived are counted beside n, and the medians
// fall on them exactly when core/clock's median over the found sniffs does.
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { censoredMedianOverMs, medianOverFound } from '../clock/sniff.ts';
import { exampleCalib, exampleVerdict } from './examples.ts';
import { sniffMediansNotArrived, validateCalib, validateVerdict, type Verdict } from './index.ts';

const calibWith = (lag: Record<string, unknown>): Record<string, unknown> => ({ schema: 'calib/1', sniff_lag_ms: lag });
const round1 = (x: number): number => Math.round(x * 10) / 10;

describe('calib.json sniff_lag_ms (spec 8.1, PREREG §4)', () => {
  it('accepts measured medians, medians over a bound, no sniff found, and hi null without L_rt', () => {
    expect(validateCalib(exampleCalib())).toEqual([]);
    expect(validateCalib(calibWith({ n: 5, no_arrival: 2, lo_median: 148, hi_median: 171.5, median_over_ms: null }))).toEqual([]);
    expect(validateCalib(calibWith({ n: 5, no_arrival: 3, lo_median: null, hi_median: null, median_over_ms: 2000 }))).toEqual([]);
    expect(validateCalib(calibWith({ n: 4, no_arrival: 2, lo_median: null, hi_median: null, median_over_ms: 1000 }))).toEqual([]);
    expect(validateCalib(calibWith({ n: 0, no_arrival: 0, lo_median: null, hi_median: null, median_over_ms: null }))).toEqual([]);
    expect(validateCalib(calibWith({ n: 5, no_arrival: 0, lo_median: 148, hi_median: null, median_over_ms: null }))).toEqual([]);
    expect(validateCalib({ schema: 'calib/1', sniff_lag_ms: null })).toEqual([]);
  });

  it('needs the count beside n and the bound field, and says why', () => {
    expect(validateCalib(calibWith({ n: 5, lo_median: 148, hi_median: 171.5 }))).toEqual([
      'sniff_lag_ms.no_arrival: missing: the found sniffs whose trace never arrived are counted beside n (PREREG §4)',
      'sniff_lag_ms.median_over_ms: missing: null, or the bound of medians that fall on sniffs without an arrival (PREREG §4)',
    ]);
    expect(validateCalib(calibWith({ n: 5, no_arrival: 6, lo_median: null, hi_median: null, median_over_ms: 2000 }))).toEqual([
      'sniff_lag_ms.no_arrival: 6 is more than the 5 found sniffs: the found sniffs whose trace never arrived are counted beside n (PREREG §4)',
    ]);
    expect(validateCalib(calibWith({ n: 5, no_arrival: 1.5, lo_median: 148, hi_median: 171.5, median_over_ms: null }))).toEqual([
      'sniff_lag_ms.no_arrival: expected a count (non-negative integer), got 1.5',
    ]);
  });

  it('medians on sniffs without an arrival are null and bounded; measured ones are not', () => {
    // 3 of 5 never arrived: the middle one is among them.
    expect(validateCalib(calibWith({ n: 5, no_arrival: 3, lo_median: 148, hi_median: null, median_over_ms: null }))).toEqual([
      'sniff_lag_ms.median_over_ms: missing: 3 of the 5 found sniffs never arrived, so the medians fall on them and are over a bound (PREREG §4)',
      'sniff_lag_ms.lo_median: expected null: 3 of the 5 found sniffs never arrived, so the median falls on them, over median_over_ms (PREREG §4)',
    ]);
    expect(validateCalib(calibWith({ n: 5, no_arrival: 5, lo_median: null, hi_median: null, median_over_ms: 0 }))).toEqual([
      'sniff_lag_ms.median_over_ms: expected a bound above 0 ms, got 0',
    ]);
    // 2 of 5: the medians stay measured.
    expect(validateCalib(calibWith({ n: 5, no_arrival: 2, lo_median: 148, hi_median: 171.5, median_over_ms: 2000 }))).toEqual([
      'sniff_lag_ms.median_over_ms: expected null: 3 of the 5 found sniffs arrived, so the medians are measured (PREREG §4)',
    ]);
    expect(validateCalib(calibWith({ n: 5, no_arrival: 2, lo_median: null, hi_median: null, median_over_ms: null }))).toEqual([
      'sniff_lag_ms.lo_median: missing: 3 of the 5 found sniffs arrived, so the median is measured (PREREG §4)',
    ]);
    expect(validateCalib(calibWith({ n: 0, no_arrival: 0, lo_median: 148, hi_median: null, median_over_ms: null }))).toEqual([
      'sniff_lag_ms: medians without a found sniff: expected null',
    ]);
    expect(validateCalib(calibWith({ n: 5, no_arrival: 3, lo_median: null, hi_median: null, median_over_ms: 2000.25 }))).toEqual([
      'sniff_lag_ms.median_over_ms: expected a report value rounded to 0.1 (spec 8.1), got 2000.25',
    ]);
  });

  // The validator's rule and core/clock's median are one rule: medians fall on the sniffs without
  // an arrival exactly when core/clock's median over the found sniffs is infinite.
  it('sniffMediansNotArrived agrees with core/clock medianOverFound, and the block core/clock gives validates', () => {
    fc.assert(
      fc.property(
        fc.array(fc.double({ min: 0, max: 2000, noNaN: true }), { maxLength: 12 }),
        fc.nat({ max: 12 }),
        fc.boolean(),
        (measured, notArrived, withLrt) => {
          const n = measured.length + notArrived;
          const lo = medianOverFound(measured, notArrived);
          expect(sniffMediansNotArrived(n, notArrived)).toBe(lo === Number.POSITIVE_INFINITY);
          const censored = lo === Number.POSITIVE_INFINITY;
          const finite = lo === null || censored ? null : round1(lo);
          const block = {
            n,
            no_arrival: notArrived,
            lo_median: finite,
            hi_median: finite === null || !withLrt ? null : round1(lo! + 23.5),
            median_over_ms: censored ? censoredMedianOverMs(n, notArrived) : null,
          };
          expect(validateCalib(calibWith(block))).toEqual([]);
        },
      ),
      { numRuns: 200 },
    );
  });
});

describe('verdict.json rows.sniff_lag (spec 9.6, 9.7; PREREG §4)', () => {
  const censoredRow = (outcome: Verdict['rows']['sniff_lag']['outcome']): Verdict => {
    const v = exampleVerdict();
    v.rows.sniff_lag = { ...v.rows.sniff_lag, outcome, lo_median_ms: null, hi_median_ms: null, median_over_ms: 2000, no_arrival: 5, best_case_ms: null };
    v.verdict = outcome === 'KILL' ? 'KILL' : 'BETWEEN';
    return v;
  };

  it('holds the count calib.json holds beside n, and the bound of medians on sniffs without an arrival', () => {
    expect(exampleVerdict().rows.sniff_lag).toMatchObject({ n: 5, no_arrival: 0, median_over_ms: null });
    expect(validateVerdict(censoredRow('KILL'))).toEqual([]);
    const v = exampleVerdict() as unknown as { rows: { sniff_lag: Record<string, unknown> } };
    delete v.rows.sniff_lag['no_arrival'];
    expect(validateVerdict(v)).toEqual(['rows.sniff_lag.no_arrival: missing']);
  });

  it('medians on sniffs without an arrival read KILL (PREREG §4, spec 9.6), unless the row stays open', () => {
    expect(validateVerdict(censoredRow('BETWEEN'))).toEqual([
      'rows.sniff_lag.outcome: expected KILL: the medians fall on sniffs whose trace never arrived, over 2000 ms (PREREG §4, spec 9.6)',
    ]);
    const open = censoredRow('KILL');
    open.events.valid = 11;
    open.rows.hits.hits = 6;
    for (const r of ['hits', 'lead', 'false_holds', 'sniff_lag', 'chest_vs_lips'] as const) open.rows[r].outcome = null;
    open.verdict = 'NOT EVALUABLE';
    expect(validateVerdict(open)).toEqual([]);
  });

  it('checks the numbers as calib.json does', () => {
    const v = exampleVerdict();
    v.rows.sniff_lag.no_arrival = 3;
    expect(validateVerdict(v)).toEqual([
      'rows.sniff_lag.median_over_ms: missing: 3 of the 5 found sniffs never arrived, so the medians fall on them and are over a bound (PREREG §4)',
      'rows.sniff_lag.lo_median_ms: expected null: 3 of the 5 found sniffs never arrived, so the median falls on them, over median_over_ms (PREREG §4)',
      'rows.sniff_lag.hi_median_ms: expected null: 3 of the 5 found sniffs never arrived, so the median falls on them, over median_over_ms (PREREG §4)',
    ]);
  });
});
