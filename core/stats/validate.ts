// Argument checks shared by core/stats. Bad input throws a RangeError instead of
// flowing on as NaN: a statistic that cannot be computed must never print silently.

export function assertFiniteNumber(value: number, name: string): void {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new RangeError(`${name} must be a finite number, got ${String(value)}`);
  }
}

/** A count: a non-negative safe integer. */
export function assertCount(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${name} must be a non-negative integer, got ${String(value)}`);
  }
}

/** A probability in [0, 1]. */
export function assertProbability(value: number, name: string): void {
  if (typeof value !== 'number' || Number.isNaN(value) || value < 0 || value > 1) {
    throw new RangeError(`${name} must be in [0, 1], got ${String(value)}`);
  }
}

/** A confidence level or significance level strictly inside (0, 1). */
export function assertOpenUnit(value: number, name: string): void {
  if (typeof value !== 'number' || !(value > 0 && value < 1)) {
    throw new RangeError(`${name} must be in (0, 1), got ${String(value)}`);
  }
}

/** Every value finite; returns a sorted ascending copy. */
export function sortedFiniteCopy(values: readonly number[], name: string): number[] {
  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    if (typeof v !== 'number' || !Number.isFinite(v)) {
      throw new RangeError(`${name}[${i}] must be a finite number, got ${String(v)}`);
    }
  }
  return [...values].sort((a, b) => a - b);
}

/** Element of an array whose bounds the caller has already checked. */
export function at(values: readonly number[], index: number): number {
  const v = values[index];
  if (v === undefined) throw new RangeError(`index ${index} out of range for length ${values.length}`);
  return v;
}
