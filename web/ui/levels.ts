// Output levels for the doctor volume step (spec 7.7, 5.2: "one notch quieter").

/** Level notches in dB of Deck output gain, quietest first (the notch set is an assumption). */
export const OUTPUT_LEVELS_DB: readonly number[] = [-21, -18, -15, -12, -9, -6, -3, 0];
export const DEFAULT_LEVEL_DB = -12;

export function dbToGain(db: number): number {
  return 10 ** (db / 20);
}

export function gainToDb(gain: number): number {
  return 20 * Math.log10(gain);
}

/** The notch closest to a stored gain. */
export function nearestLevelDb(gain: number): number {
  const db = gainToDb(gain);
  let best = OUTPUT_LEVELS_DB[0] ?? DEFAULT_LEVEL_DB;
  for (const level of OUTPUT_LEVELS_DB) if (Math.abs(level - db) < Math.abs(best - db)) best = level;
  return best;
}

export interface StartLevel {
  gain: number;
  db: number;
  source: 'calib' | 'default';
}

/** Gain from calib.json output_gain (written after doctor, spec 8.1), else the default notch. */
export function startLevel(calibOutputGain: unknown): StartLevel {
  if (typeof calibOutputGain === 'number' && Number.isFinite(calibOutputGain) && calibOutputGain > 0 && calibOutputGain <= 1) {
    return { gain: calibOutputGain, db: Math.round(gainToDb(calibOutputGain) * 10) / 10, source: 'calib' };
  }
  return { gain: dbToGain(DEFAULT_LEVEL_DB), db: DEFAULT_LEVEL_DB, source: 'default' };
}
