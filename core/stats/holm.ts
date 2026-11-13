// Holm step-down correction (spec 4.4 and 7.10: H3 and H4, two comparisons).
// Adjusted p-values: sort ascending, p_adj(i) = max over j <= i of min(1, (m - j + 1) p(j)),
// returned in the input order. A hypothesis is rejected at alpha when p_adj <= alpha.
// Spec 8.6 example: sign tests 7:4 and 6:11 give p_holm 0.55 and 0.93.

export function holmAdjustedPValues(pValues: readonly number[]): number[] {
  pValues.forEach((p, i) => {
    if (typeof p !== 'number' || Number.isNaN(p) || p < 0 || p > 1) {
      throw new RangeError(`pValues[${i}] must be in [0, 1], got ${String(p)}`);
    }
  });
  const m = pValues.length;
  const order = pValues.map((p, i) => ({ p, i })).sort((a, b) => a.p - b.p || a.i - b.i);
  const adjusted = new Array<number>(m).fill(1);
  let runningMax = 0;
  order.forEach(({ p, i }, rank) => {
    runningMax = Math.max(runningMax, Math.min(1, (m - rank) * p));
    adjusted[i] = runningMax;
  });
  return adjusted;
}

/** Which hypotheses Holm rejects at family-wise level alpha, in the input order. */
export function holmRejects(pValues: readonly number[], alpha = 0.05): boolean[] {
  if (!(alpha > 0 && alpha < 1)) throw new RangeError(`alpha must be in (0, 1), got ${alpha}`);
  return holmAdjustedPValues(pValues).map((p) => p <= alpha);
}
