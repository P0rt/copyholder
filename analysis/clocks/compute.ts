// The measurements of `npm run clocks` (spec 6.3, 7.12, 8.1): the clock check and clock_report.json
// from core/clock, and the calib.json blocks of one recording. Pure: a session in memory in, objects out.

import {
  CAMERA_OFFSET_AGREE_MS,
  QUANTUM_SAMPLES,
  clockCalib,
  clockCheckDetails,
  sniffLag,
  sniffLrtMs,
  tracePackets,
  type CalibLrt,
  type CameraClock,
  type ClockCheckDetails,
  type ClockReport,
  type SessionData,
  type SniffLag,
} from '../../core/clock/index.ts';
import type { Calib, CalibSniffLagBlock, Manifest, RecordKind } from '../../core/schemas/index.ts';
import { measureLoops, type LoopPair, type SessionView } from '../lib/measure.ts';
import { stepSpan, type LoadedSession } from '../lib/session.ts';
import { gatePackOf, gateSteps, type GatePack, type GateSteps } from '../lib/steps.ts';
import { clockSamples, type SampleSource } from './inputs.ts';
import {
  deepBreathSign,
  listeningAmplitudeRef,
  paBursts,
  sniffOnsets,
  sniffTraceSign,
  type AmplitudeRef,
  type DeepBreathSign,
  type PaBlock,
  type SniffOnsetAt,
  type SniffSign,
} from './measure.ts';

/** Record kinds recorded without the camera (spec 7.12): no trace conditions, no camera clock. */
export const NO_CAMERA_KINDS: ReadonlySet<RecordKind> = new Set<RecordKind>(['spacebar', 'pilot']);

export type ClocksPlan = { camera: boolean; gate: GateSteps | null } | { refuse: string };

/** What the clocks command measures for a record kind: camera or not, and the gate's steps. */
export function clocksPlan(manifest: Pick<Manifest, 'kind' | 'pack'> & { scenario?: unknown }): ClocksPlan {
  const camera = !NO_CAMERA_KINDS.has(manifest.kind);
  if (manifest.kind !== 'gate') return { camera, gate: null };
  const pack: GatePack | null = manifest.pack ?? gatePackOf(String(manifest.scenario ?? ''));
  if (pack === null) return { refuse: 'the gate recording names no pack in manifest.json' };
  return { camera, gate: gateSteps(pack) };
}

/**
 * The calib.json blocks the clocks command owns (spec 8.1); other writers own the other keys. The
 * sniff block is the file's (calibSniffLagBlock), never core/clock's measured part
 * (clockCalib().calib.sniff_lag_ms has no count beside n), which validateCalib refuses.
 */
export type ClockCalibBlocks = Pick<Calib, 'L_rt_ms' | 'camera_clock'> &
  Partial<Pick<Calib, 'polarity' | 'A_ref'>> & { sniff_lag_ms?: CalibSniffLagBlock | null };

export type { CalibSniffLagBlock };

/**
 * calib.json sniff_lag_ms of a measured lag (spec 8.1, PREREG §4): core/clock's block (n, and the
 * medians to 0.1 ms) with the found sniffs whose trace never arrived counted beside n, and the
 * bound of medians that fall on such sniffs. analyze:gate copies these numbers into verdict.json.
 */
export function calibSniffLagBlock(lag: Pick<SniffLag, 'calib' | 'noArrival' | 'medianOverMs'>): CalibSniffLagBlock {
  return {
    n: lag.calib.n,
    no_arrival: lag.noArrival,
    lo_median: lag.calib.lo_median,
    hi_median: lag.calib.hi_median,
    median_over_ms: lag.medianOverMs === null ? null : Math.round(lag.medianOverMs * 10) / 10,
  };
}

export interface GateMeasurements {
  pack: GatePack;
  deep: DeepBreathSign;
  sniffs: SniffOnsetAt[];
  sniffSign: SniffSign;
  aRef: AmplitudeRef;
  /** Sign the sniff lag was measured with: the deep breaths', else the sniffs' (assumption); null: not measured. */
  lagSign: 1 | -1 | null;
  lag: SniffLag | null;
  /** The sniffs move the trace against the deep-breath sign (spec 7.4: a warning in the ledger only). */
  signDisagrees: boolean;
}

export interface ClocksComputation {
  report: ClockReport;
  calib: ClockCalibBlocks;
  /** Failed hard conditions in words (core/clock); empty when the recording passes. */
  failures: string[];
  check: ClockCheckDetails;
  loops: LoopPair;
  camera: CameraClock | null;
  pa: { start: PaBlock; end: PaBlock } | null;
  gate: GateMeasurements | null;
  sampleSource: SampleSource;
}

/** Significant digits kept for A_ref (trace units, not ms or dB). */
const A_REF_DIGITS = 4;

/** What the sniff lag measures besides the trace sign and L_rt (spec 6.3): the sniffs heard and A_ref. */
export interface SniffBasis {
  sniffs: SniffOnsetAt[];
  /** n_sniff of every sniff heard, in prompt order: the found sniffs of PREREG §4. */
  onsets: number[];
  aRef: AmplitudeRef;
}

/** Sniff onsets and A_ref of the listening block, as the clocks step measures them (spec 6.3). */
export function sniffBasis(s: SessionView, gate: Pick<GateSteps, 'sniffs' | 'listening'>): SniffBasis {
  const sniffs = sniffOnsets(s, gate.sniffs);
  const onsets = sniffs.map((x) => x.n).filter((n): n is number => n !== null);
  return { sniffs, onsets, aRef: listeningAmplitudeRef(s, stepSpan(s, gate.listening)) };
}

/** The sniff lag recomputed by recountSniffLag. */
export interface SniffRecount {
  /** n_sniff of every sniff heard, in prompt order. */
  onsets: number[];
  /** A_ref of the listening block, unrounded; null with too little trace. */
  aRef: number | null;
  /** The lag as clocks computes it for calib.json; null without A_ref. */
  lag: SniffLag | null;
}

/**
 * The sniff lag of a gate recording computed as the clocks step computes it for calib.json (spec
 * 6.3, 7.12): the same samples, sniff onsets, unrounded A_ref and core sniffLag, with the L_rt
 * block of calib.json and the trace sign `sign` (the deep-breath sign of calib.json, which is the
 * sign clocks measured the lag with whenever calib.json has one). analyze:gate checks it against
 * calib.json and, when it gives the same block, grades row 4 on its unrounded medians (spec 9.6):
 * calib.json holds the medians to 0.1 ms. n, the count of sniffs without an arrival and the bound
 * come from calib.json (PREREG §4); the recount stands in for them only when calib.json has none.
 */
export function recountSniffLag(
  session: SessionView & Pick<LoadedSession, 'detectorIn'>,
  gate: Pick<GateSteps, 'sniffs' | 'listening'>,
  lrt: CalibLrt,
  sign: 1 | -1,
): SniffRecount {
  const { samples } = clockSamples(session);
  const s: SessionView = { ...session, samples };
  const basis = sniffBasis(s, gate);
  const aRef = basis.aRef.aRef;
  const lag = aRef !== null && aRef > 0 ? sniffLag({ onsets: basis.onsets, packets: tracePackets(s), aRef, lrtMs: sniffLrtMs(lrt), sign }) : null;
  return { onsets: basis.onsets, aRef, lag };
}

export interface ClocksOptions {
  /** Loop checks as measured elsewhere (tests of the L_rt rule); default measured here. */
  loops?: LoopPair;
}

/** Clock check, clock report and calib.json blocks of one recording (spec 6.3, 7.12). */
export function computeClocks(
  session: SessionView & Pick<LoadedSession, 'detectorIn'>,
  plan: { camera: boolean; gate: GateSteps | null },
  opts: ClocksOptions = {},
): ClocksComputation {
  const { samples, source } = clockSamples(session);
  const s: SessionView = { ...session, samples };
  const data: SessionData = s;
  const loops = opts.loops ?? measureLoops(s);
  const loop = { A: loops.A, B: loops.B };
  const check = clockCheckDetails(data, { camera: plan.camera, loop });
  const pa = plan.camera ? paBursts(s) : null;

  let gate: GateMeasurements | null = null;
  let sniffInput: { onsets: number[]; aRef: number; sign: 1 | -1 } | null = null;
  if (plan.gate) {
    const deep = deepBreathSign(s);
    // The same basis recountSniffLag takes, so analyze:gate can recompute the lag exactly.
    const { sniffs, onsets, aRef } = sniffBasis(s, plan.gate);
    const sniffSign = sniffTraceSign(s, onsets);
    const lagSign = deep.calib.sign ?? sniffSign.sign;
    if (aRef.aRef !== null && aRef.aRef > 0 && lagSign !== null) sniffInput = { onsets, aRef: aRef.aRef, sign: lagSign };
    gate = {
      pack: plan.gate.pack,
      deep,
      sniffs,
      sniffSign,
      aRef,
      lagSign,
      lag: null,
      signDisagrees: deep.calib.sign !== null && sniffSign.sign !== null && deep.calib.sign !== sniffSign.sign,
    };
  }

  const cc = clockCalib(
    data,
    {
      bursts: pa ? { start: pa.start.bursts, end: pa.end.bursts } : null,
      sniff: sniffInput,
      loop,
    },
    { camera: { agreeMs: CAMERA_OFFSET_AGREE_MS } },
  );
  if (gate) gate.lag = cc.sniff;

  const calib: ClockCalibBlocks = { L_rt_ms: cc.calib.L_rt_ms, camera_clock: plan.camera ? cc.calib.camera_clock : null };
  if (gate) {
    calib.polarity = gate.deep.result === null ? null : gate.deep.calib;
    calib.A_ref = gate.aRef.aRef === null ? null : Number(gate.aRef.aRef.toPrecision(A_REF_DIGITS));
    calib.sniff_lag_ms = cc.sniff ? calibSniffLagBlock(cc.sniff) : null;
  }
  return { report: check.report, calib, failures: check.failures, check, loops, camera: cc.camera, pa, gate, sampleSource: source };
}

/** calib.json after the clocks step: the file as it was, with the clock blocks replaced. */
export function mergeCalib(existing: unknown, blocks: ClockCalibBlocks): Calib {
  const base = existing !== null && typeof existing === 'object' && !Array.isArray(existing) ? (existing as Record<string, unknown>) : {};
  return { ...base, schema: 'calib/1', ...blocks } as Calib;
}

// ---- plain words --------------------------------------------------------------------------------

const ms1 = (x: number | null | undefined): string => (x === null || x === undefined ? 'none' : `${x.toFixed(1)} ms`);
const yes = (b: boolean): string => (b ? 'yes' : 'no');

/**
 * The printed clock report (spec 6.3, 7.12): measured numbers in plain words, one fact per line.
 * Never the words of CLOCK_REPORT_BANNED_WORDS.
 */
export function reportLines(c: ClocksComputation, sampleRateHz: number): string[] {
  const r = c.report;
  const lrt = c.check.lrt;
  const out: string[] = [];
  const [a, b] = r.chain.L_rt_ms;
  const [sa, sb] = r.chain.spread_ms;
  out.push(`  L_rt loop check A: ${ms1(a)} (spread ${ms1(sa)}); loop check B: ${ms1(b)} (spread ${ms1(sb)})`);
  if (a !== null && b !== null) {
    const used = lrt.used === null ? '' : `, L_rt used ${ms1(lrt.used)}`;
    out.push(`  A and B differ by ${ms1(Math.abs(a - b))}: rule ${lrt.rule}${used}`);
  } else {
    out.push(`  rule ${lrt.rule}: a loop check was not found`);
  }
  out.push(`  stamp quantum: ${r.chain.quantum_ms.toFixed(1)} ms (${QUANTUM_SAMPLES} samples at ${sampleRateHz} Hz)`);
  out.push(`  live stops: ${r.chain.stops}; channel 1 zero from nSilent to the resume after ${r.chain.stops_match_ch1} of them`);
  out.push(
    r.chain.nCmd_minus_nArr === null
      ? '  nCmd - nArr: no chest stops'
      : `  nCmd - nArr: ${r.chain.nCmd_minus_nArr} samples (the chest stop farthest from 0)`,
  );
  out.push(
    `  audio blocks contiguous: ${yes(r.hard.chunks_contiguous)}; sample rate ${r.hard.sample_rate ?? 'unknown'} Hz; microphone processing off: ${yes(r.hard.mic_flags_off)}`,
  );
  out.push(`  device events: ${r.hard.device_events}; page hidden: ${r.hard.visibility_events} time(s)`);
  if (r.trace_valid !== null) {
    const rate = r.hard.trace_rate_median === null ? 'unknown' : `${r.hard.trace_rate_median.toFixed(1)} per s`;
    out.push(`  trace rate median: ${rate}; SDK errors: ${r.hard.sdk_errors}; tap lost: ${r.hard.tap_lost} time(s)`);
    if (c.sampleSource === 'detector_in.jsonl') out.push('  packets read from detector_in.jsonl (samples.jsonl has none)');
  }
  const w = r.warn;
  out.push(
    `  warnings: frames not sent ${w.not_sent_share ?? 'unknown'}; tap event-loop delay P99 ${ms1(w.tap_loop_p99_ms)}; kOk share ${w.status_ok_share ?? 'unknown'}; blur and resize events ${w.window_warnings}`,
  );
  if (c.pa && c.camera) {
    const [s, e] = c.camera.calib.offset_ms;
    const diff = s !== null && e !== null ? `, apart by ${ms1(Math.abs(s - e))} (limit ${CAMERA_OFFSET_AGREE_MS} ms)` : '';
    const slope = c.camera.calib.slope_ppm === null ? 'unknown' : `${c.camera.calib.slope_ppm.toFixed(1)} ppm`;
    out.push(
      `  camera clock: offset at start ${ms1(s)} from ${c.camera.start.found} of ${c.pa.start.prompts} 'pa', at end ${ms1(e)} from ${c.camera.end.found} of ${c.pa.end.prompts} 'pa'${diff}; slope ${slope}; camera positions usable: ${yes(c.camera.ok)}`,
    );
  } else if (c.pa) {
    out.push('  camera clock: not measured');
  }
  if (c.gate) {
    const g = c.gate;
    const d = g.deep.result ? g.deep.result.d.map((x) => (Number.isFinite(x) ? x.toPrecision(3) : 'none')).join(', ') : 'none';
    const sign = g.deep.calib.sign === null ? 'none' : g.deep.calib.sign > 0 ? '+1' : '-1';
    out.push(`  trace sign from the deep breaths: ${sign}; ${g.deep.calib.breaths_agree} of ${g.deep.cues} breaths one way (d = ${d})`);
    const sniffSign = g.sniffSign.sign === null ? 'none' : g.sniffSign.sign > 0 ? '+1' : '-1';
    out.push(`  trace sign from the sniffs: ${sniffSign}${g.signDisagrees ? ' (differs from the deep breaths: warning written to the ledger)' : ''}`);
    out.push(`  A_ref: ${g.aRef.aRef === null ? 'none' : g.aRef.aRef.toPrecision(A_REF_DIGITS)} (median of ${g.aRef.windows} amplitudes of the listening block)`);
    const heard = g.sniffs.filter((x) => x.n !== null).length;
    if (g.lag) {
      // PREREG §4: n counts every sniff heard; those whose trace never arrived rank above every measured lag.
      const medians = g.lag.medianNotArrived
        ? `median lo and hi over ${g.lag.medianOverMs ?? 1000} ms: the medians fall on sniffs whose trace never arrived`
        : `median lo ${ms1(g.lag.calib.lo_median)}, median hi ${ms1(g.lag.calib.hi_median)}`;
      out.push(
        `  sniff lag [lo, lo + L_rt]: ${g.lag.n} sniffs heard, ${g.lag.n - g.lag.noArrival} reached the trace within 2 s, ${g.lag.noArrival} without arrival; ${medians}`,
      );
    } else {
      out.push(`  sniff lag: not measured (${heard} sniffs heard; A_ref ${g.aRef.aRef === null ? 'none' : 'found'}; trace sign ${g.lagSign === null ? 'none' : 'found'})`);
    }
  }
  return out;
}
