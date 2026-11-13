// Test-only synthetic tap stream: samples.jsonl lines (spec 8.1) with a regular breathing trace
// at 30 Hz and optional steep inhales.

export interface BreathTraceOptions {
  /** Camera clock of the first sample, microseconds since the epoch. */
  startUs?: number;
  rateHz?: number;
  periodS?: number;
  inhaleS?: number;
  amp?: number;
  /** Breath indices (0-based) whose inhale lasts steepInhaleS instead of inhaleS. */
  steepBreaths?: number[];
  steepInhaleS?: number;
  /** Polarity of the raw trace; the detector's sign undoes it. */
  rawSign?: number;
}

/** Breathing value at time t seconds: raised-cosine inhale then raised-cosine exhale. */
export function breathValue(tS: number, o: Required<BreathTraceOptions>): number {
  const i = Math.floor(tS / o.periodS);
  const u = tS - i * o.periodS;
  const inhale = o.steepBreaths.includes(i) ? o.steepInhaleS : o.inhaleS;
  if (u < inhale) return o.amp * (0.5 - 0.5 * Math.cos((Math.PI * u) / inhale));
  const ex = o.periodS - inhale;
  return o.amp * (0.5 + 0.5 * Math.cos((Math.PI * (u - inhale)) / ex));
}

const DEFAULTS: Required<BreathTraceOptions> = {
  startUs: 1_794_935_100_000_000,
  rateHz: 30,
  periodS: 4,
  inhaleS: 1.6,
  amp: 1,
  steepBreaths: [],
  steepInhaleS: 0.35,
  rawSign: 1,
};

export interface TapLine {
  seq: number;
  k: string;
  [field: string]: unknown;
}

/** Packet lines for samples [i0, i1) of the 30 Hz trace, one trace point per packet. */
export function packetLines(i0: number, i1: number, seq0: number, opts: BreathTraceOptions = {}): TapLine[] {
  const o: Required<BreathTraceOptions> = { ...DEFAULTS, ...opts };
  const out: TapLine[] = [];
  for (let i = i0; i < i1; i++) {
    const tS = i / o.rateHz;
    const ts = o.startUs + Math.round(tS * 1e6);
    // Float32 values like the SDK's: they print with many digits and must round-trip exactly.
    const value = Math.fround(o.rawSign * breathValue(tS, o));
    out.push({
      seq: seq0 + (i - i0),
      k: 'm',
      tArrNs: String(812_345_678_901_234 + i * 33_333_333),
      tsCbUs: ts + 21_000,
      tr: [[ts, value]],
      talk: [[ts, 0]],
      g: Math.fround(0.03 + 0.001 * Math.sin(i / 5)),
      hm: Math.fround(0.002),
      lm: { ts, reset: 0, p: [[640.2, 402.1], [640.6, 409.8]] },
    });
  }
  return out;
}

/** processingStatus and validationStatus names of tap (live/lib/sdk-codes.cjs). */
const PROCESSING_CODES: Record<string, number> = { kUninitialized: 0, kIdle: 1, kStarting: 2, kRunning: 3, kStopping: 4, kError: 5 };
const VALIDATION_NAMES: Record<number, string> = { 0: 'kOk', 1: 'kNoFaceFound', 2: 'kMultipleFacesFound', 7: 'kChestNotVisible', 12: 'kExcessiveMotion' };

export function statusLine(seq: number, name = 'kRunning'): TapLine {
  return { seq, k: 's', tArrNs: '0', code: PROCESSING_CODES[name] ?? 0, name };
}

export function validationLine(seq: number, code: number): TapLine {
  return { seq, k: 'v', tArrNs: '0', tsCbUs: 0, code, name: VALIDATION_NAMES[code] ?? `code_${code}`, hint: '' };
}

/**
 * The /tap lines behind detector inputs (core/detector/synth.ts sessions): `batch` becomes an `m`
 * line, `val` a `v` line; Deck's own lines (voice, state) are left out.
 */
export function tapLinesOf(inputs: ReadonlyArray<{ k: string; seq?: number; tr?: ReadonlyArray<readonly [number, number]>; code?: number }>): TapLine[] {
  const out: TapLine[] = [];
  for (const d of inputs) {
    if (d.k === 'batch' && d.seq !== undefined && d.tr) {
      const last = d.tr[d.tr.length - 1];
      const ts = last ? last[0] : 0;
      out.push({
        seq: d.seq, k: 'm', tArrNs: '0', tsCbUs: ts + 21_000,
        tr: d.tr.map(([t, v]) => [t, v]), talk: d.tr.map(([t]) => [t, 0]), g: 0.03, hm: 0.002, lm: null,
      });
    } else if (d.k === 'val' && d.seq !== undefined && d.code !== undefined) {
      out.push(validationLine(d.seq, d.code));
    }
  }
  return out;
}
