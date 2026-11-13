// Frame features of spec 7.6 over channel 0: the 80 Hz high-pass forward and backward, energy E
// in dB in the 150 Hz-8 kHz band on 10 ms windows every 1 ms, and periodicity c on 30 ms windows.
//
// Frame k ends at the absolute sample firstEnd + k * hop, a multiple of hop, so every call sees
// the same grid. E of frame k covers [end - 10 ms, end): the end is where a window has first
// seen a sound, so an abrupt onset reads at its own time. The periodicity window is centred on
// the energy window: [end - 20 ms, end + 10 ms) (assumption). c is computed lazily, only for
// frames the rules ask about, on the same band as E decimated to 16 kHz.

import { madInPlace, maxNormalizedAutocorrelation, medianInPlace, powerToDb, sosFiltFiltInPlace } from '../vad/dsp.ts';
import type { OnsetConfig, SampleSpan } from './params.ts';

const CHUNK_SECONDS = 30;
const PAD_SECONDS = 0.5;

function alignUp(x: number, m: number): number {
  return Math.ceil(x / m) * m;
}

function alignDown(x: number, m: number): number {
  return Math.floor(x / m) * m;
}

/** A sample, or 0 when it is NaN or infinite (as core/vad counts it), so one bad sample cannot
 * poison the zero-phase filters and the prefix sums that follow. */
function finiteOr0(v: number): number {
  return v - v === 0 ? v : 0;
}

/** Copies absolute samples [from, from + out.length) of ch0 into out, with odd reflection
 * beyond the ends of the recording. Non-finite samples read as 0. */
export function extractReflected(ch0: Float32Array, n0: number, from: number, out: Float64Array): void {
  const len = ch0.length;
  if (len === 0) {
    out.fill(0);
    return;
  }
  const first = finiteOr0(ch0[0]!);
  const last = finiteOr0(ch0[len - 1]!);
  for (let i = 0; i < out.length; i++) {
    const idx = from + i - n0;
    if (idx >= 0 && idx < len) out[i] = finiteOr0(ch0[idx]!);
    else if (idx < 0) out[i] = 2 * first - finiteOr0(ch0[Math.min(-idx, len - 1)]!);
    else out[i] = 2 * last - finiteOr0(ch0[Math.max(2 * (len - 1) - idx, 0)]!);
  }
}

export interface Floor {
  /** N: median E, dB. */
  readonly db: number;
  /** s_N = 1.4826 * MAD, dB. */
  readonly spreadDb: number;
  /** Number of frames it was measured on. */
  readonly frames: number;
}

export class FeatureTrack {
  readonly cfg: OnsetConfig;
  /** Absolute sample number where frame 0's energy window ends (a multiple of hop). */
  readonly firstEnd: number;
  readonly count: number;
  /** E per frame, dB re full-scale mean square. */
  readonly energyDb: Float32Array;
  private readonly corr: Float32Array;
  private readonly dec: Float32Array;
  private readonly decFirst: number;
  private readonly win: Float64Array;
  private readonly prefix: Float64Array;

  constructor(
    cfg: OnsetConfig,
    firstEnd: number,
    count: number,
    energyDb: Float32Array,
    dec: Float32Array,
    decFirst: number,
  ) {
    this.cfg = cfg;
    this.firstEnd = firstEnd;
    this.count = count;
    this.energyDb = energyDb;
    this.corr = new Float32Array(count).fill(Number.NaN);
    this.dec = dec;
    this.decFirst = decFirst;
    this.win = new Float64Array(cfg.winC);
    this.prefix = new Float64Array(cfg.winC + 1);
  }

  /** Absolute sample number where frame k's energy window ends. */
  frameEnd(k: number): number {
    return this.firstEnd + k * this.cfg.hop;
  }

  /** First frame whose end is >= sample, clamped to [0, count]. */
  frameAtOrAfter(sample: number): number {
    const k = Math.ceil((sample - this.firstEnd) / this.cfg.hop);
    return k < 0 ? 0 : k > this.count ? this.count : k;
  }

  /** Periodicity c of frame k (spec 7.6), computed on first use. */
  periodicity(k: number): number {
    const cached = this.corr[k]!;
    if (cached === cached) return cached;
    const cfg = this.cfg;
    const m0 = (this.frameEnd(k) - cfg.cBack) / cfg.decim - this.decFirst;
    const win = this.win;
    const dec = this.dec;
    for (let i = 0; i < cfg.winC; i++) win[i] = dec[m0 + i]!;
    const c = maxNormalizedAutocorrelation(win, cfg.winC, cfg.lagMin, cfg.lagMax, this.prefix);
    this.corr[k] = c;
    return c;
  }

  /** Frame mask: 1 where the centre of the frame's energy window lies in one of the spans. */
  maskFromSpans(spans: readonly SampleSpan[], into?: Uint8Array, value = 1): Uint8Array {
    const mask = into ?? new Uint8Array(this.count);
    const shift = this.cfg.winE / 2 - this.firstEnd;
    for (const [start, end] of spans) {
      const k0 = Math.max(0, Math.ceil((start + shift) / this.cfg.hop));
      const k1 = Math.min(this.count, Math.ceil((end + shift) / this.cfg.hop));
      for (let k = k0; k < k1; k++) mask[k] = value;
    }
    return mask;
  }

  /** Median and spread of E over frames [k0, k1) where mask is 1 (all when mask is null). */
  floorOver(k0: number, k1: number, mask: Uint8Array | null, scratch: Float64Array): Floor | null {
    const a = Math.max(0, k0);
    const b = Math.min(this.count, k1);
    let n = 0;
    const e = this.energyDb;
    for (let k = a; k < b; k++) if (mask === null || mask[k] === 1) scratch[n++] = e[k]!;
    if (n === 0) return null;
    const db = medianInPlace(scratch, n);
    const spreadDb = this.cfg.p.madScale * madInPlace(scratch, n, db);
    return { db, spreadDb, frames: n };
  }
}

/**
 * Features for frames ending in [fromSample, toSample], limited to frames whose energy window
 * lies inside the recording. ch0[0] is absolute sample n0. Long ranges go in 30 s chunks with
 * 0.5 s of real signal as filter padding, so memory stays bounded.
 */
export function computeFeatures(
  ch0: Float32Array,
  n0: number,
  fromSample: number,
  toSample: number,
  cfg: OnsetConfig,
): FeatureTrack {
  const hop = cfg.hop;
  const firstEnd = Math.max(alignUp(fromSample, hop), alignUp(n0 + cfg.winE, hop));
  const lastEnd = Math.min(alignDown(toSample, hop), alignDown(n0 + ch0.length, hop));
  const count = lastEnd >= firstEnd ? (lastEnd - firstEnd) / hop + 1 : 0;
  if (count === 0) {
    return new FeatureTrack(cfg, firstEnd, 0, new Float32Array(0), new Float32Array(0), 0);
  }

  // Samples needed: energy windows [end - winE, end), periodicity windows [end - cBack, end - cBack + cSpan).
  const s0 = alignDown(firstEnd - Math.max(cfg.winE, cfg.cBack), hop);
  const s1 = alignUp(lastEnd + Math.max(0, cfg.cSpan - cfg.cBack), hop);
  const decFirst = s0 / cfg.decim;
  const dec = new Float32Array((s1 - s0) / cfg.decim);
  const blocksPerWin = cfg.winE / hop;
  const blockFirstEnd = firstEnd - cfg.winE + hop;
  const blockSums = new Float64Array(count + blocksPerWin - 1);

  const fir = cfg.fir;
  const half = (fir.length - 1) / 2;
  const pad = alignUp(Math.round(PAD_SECONDS * cfg.fs) + fir.length, hop);
  const chunk = alignDown(Math.round(CHUNK_SECONDS * cfg.fs), hop);
  let buf = new Float64Array(0);

  for (let ca = s0; ca < s1; ca += chunk) {
    const cb = Math.min(s1, ca + chunk);
    const origin = ca - pad;
    const len = cb - ca + 2 * pad;
    if (buf.length !== len) buf = new Float64Array(len);
    extractReflected(ch0, n0, origin, buf);
    sosFiltFiltInPlace(cfg.hpSos, buf);
    sosFiltFiltInPlace(cfg.bandSos, buf);

    // Decimated copy of the band for periodicity (zero-phase FIR).
    for (let m = ca / cfg.decim; m < cb / cfg.decim; m++) {
      const centre = m * cfg.decim - origin;
      let acc = 0;
      for (let k = 0; k < fir.length; k++) acc += fir[k]! * buf[centre - half + k]!;
      dec[m - decFirst] = acc;
    }

    // Sums of squares of the band per hop-long block.
    const beFrom = Math.max(blockFirstEnd, ca + hop);
    const beTo = Math.min(lastEnd, cb);
    for (let be = beFrom; be <= beTo; be += hop) {
      let s = 0;
      for (let i = be - hop - origin; i < be - origin; i++) s += buf[i]! * buf[i]!;
      blockSums[(be - blockFirstEnd) / hop] = s;
    }
  }

  const energyDb = new Float32Array(count);
  for (let k = 0; k < count; k++) {
    let s = 0;
    for (let j = 0; j < blocksPerWin; j++) s += blockSums[k + j]!;
    energyDb[k] = powerToDb(s / cfg.winE);
  }
  return new FeatureTrack(cfg, firstEnd, count, energyDb, dec, decFirst);
}
