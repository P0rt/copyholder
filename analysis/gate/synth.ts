// Synthetic day-one recordings for the analyze:gate tests (tests only): the 9.3 timeline with a
// 180 s listening block and a 300 s objection block with 14 cues, a breathing trace from
// core/detector/synth.ts, lips (g), talking flags and head motion per packet, and what the steps
// before analyze:gate leave: samples.jsonl, calib.json, quickcheck.json, clock_report.json,
// onsets.json and a ledger up to label holding the hash of every file each step wrote, with the
// label_order note of the label step (spec 8.5).

import fs from 'node:fs';
import path from 'node:path';
import { CHUNK_SAMPLES, chunkLayout, type SampleLine, type Stamp } from '../../core/clock/index.ts';
import { synthSession, type SynthObjection } from '../../core/detector/synth.ts';
import { mulberry32 } from '../../core/detector/math.ts';
import type { BatchInput, DetectorInput } from '../../core/detector.ts';
import { exampleClockReport, exampleLandmarkPoints, exampleQuickcheck } from '../../core/schemas/examples.ts';
import {
  appendLedger,
  NOTE_STEP,
  toJsonText,
  toJsonlText,
  validateClockReport,
  validateOnsets,
  validateQuickcheck,
  type ClockReport,
  type LedgerStep,
  type OnsetEvent,
  type Onsets,
  type Quickcheck,
} from '../../core/schemas/index.ts';
import { addNoise, addSniff } from '../../tests/synthetic/signals.ts';
import { buildGatePreregParams, frozenParamsText } from '../../tools/freeze/params.ts';
import { buildGateScenario } from '../../web/scenarios/gate.ts';
import { calibSniffLagBlock, recountSniffLag, type SniffRecount } from '../clocks/compute.ts';
import { onsetErrorBlock, onsetsAcceptLabelOrder, onsetsLabelsSha256, withLabelOrder } from '../label/marks.ts';
import { writeSessionFolder } from '../lib/fixtures.ts';
import { sha256Hex } from '../lib/ledger.ts';
import { gateSteps } from '../lib/steps.ts';

export const SYNTH_LISTEN_S = 55;
export const SYNTH_OBJECTIONS_S = 235;
export const SYNTH_BLOCK_END_S = 535;
export const SYNTH_DURATION_S = 545;
/** Cue times in the objection block: first at 15 s, then every 18 s (spec 9.2 rules). */
export const SYNTH_CUES_MS: readonly number[] = Array.from({ length: 14 }, (_, i) => 15_000 + 18_000 * i);
/** "Sniff" prompts, s: 4.4 s apart before the listening block, each 1.5 s after its "wait" (spec 9.3). */
export const SYNTH_SNIFF_PROMPTS_S: readonly number[] = [30, 34.4, 38.8, 43.2, 47.6];
/** The sniff sound starts this long after its prompt, s. */
export const SYNTH_SNIFF_AFTER_PROMPT_S = 0.3;

export type ReplyKind = 'inhale' | 'plain' | 'none' | 'cough' | 'late';

export interface ReplyPlan {
  kind: ReplyKind;
  /** Seconds from the cue to the start of the reply (the inhale, or the voice). */
  afterCueS?: number;
  /** Voice onset after the inhale peak, s (default 0.12: a D1 lead near 300 ms). */
  voiceDelayS?: number;
  /** Lips part this long before the voice, s (default 0.25: a G lead near 100 ms). */
  lipLeadS?: number;
  speechS?: number;
  /** Blind hand mark minus the automatic onset, ms (default 4: 192 samples late). */
  manualShiftMs?: number;
}

/** Lips part without a voice: g rises by `rise` over [fromS, toS). */
export interface LipOpening {
  fromS: number;
  toS: number;
  rise: number;
}

export interface GateSynthOptions {
  seed?: number;
  replies: readonly ReplyPlan[];
  /** Overrides g of a packet (by seq, arrival and session time of its newest sample). */
  gOverride?: (seq: number, nArr: number, tS: number) => number | undefined;
  lrt?: { A: number; B: number; rule: 'mean' | 'both' | 'void'; used: number | null };
  /** Relative std of breath length and depth (default 0.05; about 0.2 makes k change theta). */
  jitter?: number;
  /** SDK-to-Deck latency range, ms (default [60, 110]). */
  latencyMs?: readonly [number, number];
  /** Steep in-breaths without a voice, session s. */
  inhalesS?: readonly number[];
  lipOpenings?: readonly LipOpening[];
  /** Landmark frames with the reset flag: g and hm null, samples.jsonl lm.reset 1 (session s). */
  resetsAtS?: readonly number[];
  /** Packets without a landmark frame: g and hm null, samples.jsonl lm null (session s). */
  noFrameAtS?: readonly number[];
  /** hm null on every packet: no head-motion threshold (spec 7.5 M). */
  noHeadMotion?: boolean;
  /** The five sharp sniffs before the listening block, with their sound in audio.wav (spec 6.3, 9.3). */
  sniffs?: boolean;
  /** calib.json A_ref (default 0.8, or the measured one with sniffLag 'measured'); null leaves it out. */
  aRef?: number | null;
  /**
   * calib.json sniff_lag_ms: 'fixed' n 5, none without an arrival, [118.5, 142] (default; it does
   * not come from the recording), 'measured' as the clocks step measures and writes it on the
   * recording (analysis/clocks/compute.ts calibSniffLagBlock), or null.
   */
  sniffLag?: 'fixed' | 'measured' | null;
  /**
   * Sniffs (0-based) whose trace never arrives (PREREG §4): the chest does not rise, and no packet
   * arrives from the sound onset to 2.5 s after it. Their sound stays in audio.wav.
   */
  sniffsNotArrived?: readonly number[];
}

export interface GateSynthTruth {
  cue: number;
  cueS: number;
  kind: ReplyKind;
  voiceS: number | null;
  nV: number | null;
}

export interface GateSynth {
  inputs: DetectorInput[];
  nArrBySeq: Map<number, number>;
  stamps: Stamp[];
  /** samples.jsonl: one "m" line per packet, all 16 lip points on each frame. */
  samples: SampleLine[];
  /** onsets.json as label leaves it (hand marks in), and as the onsets step wrote it before. */
  onsets: Onsets;
  onsetsBeforeLabel: Onsets;
  calib: Record<string, unknown>;
  /** clock_report.json as label leaves it (with its onset block). */
  clockReport: ClockReport;
  /** quickcheck.json as the quickcheck step wrote it: GOOD RECORDING (exampleQuickcheck). */
  quickcheck: Quickcheck;
  /** Detail of the label_order note the label step leaves before its line; null: no note. */
  labelOrderDetail: string | null;
  cues: number[];
  nCut: number;
  listening: { n0: number; n1: number };
  scored: { n0: number; n1: number };
  truth: GateSynthTruth[];
  /** True sound onsets of the sniffs, samples. */
  sniffSoundN: number[];
  /** With sniffLag 'measured': the clocks measurement calib.json holds, unrounded; else null. */
  sniffClocks: SniffRecount | null;
  ch0: Float32Array;
  ch1: Float32Array;
  nOf(tS: number): number;
}

const T0_US = 1_794_935_000_000_000;
/** The label step's shuffle seed in the label_order note. */
const LABEL_SEED = 7;
const DEFAULT_VOICE_DELAY_S = 0.12;
const DEFAULT_LIP_LEAD_S = 0.25;
const RATE = 48_000;
const POINTS = exampleLandmarkPoints();

/** The name of the first step after the objection block (web/scenarios/gate.ts). */
function stepAfterCues(): string {
  const steps = buildGateScenario('A', SYNTH_CUES_MS);
  const gate = gateSteps('A');
  const cueSteps = new Set(gate.cueSteps);
  const i = steps.findIndex((s) => s.name === gate.objections);
  const after = steps.slice(i + 1).find((s) => !cueSteps.has(s.name));
  if (!after) throw new Error('no step after the objection block');
  return after.name;
}

/** params/frozen.json as frozen under gate-prereg without a doctor run (tools/freeze). */
export function preregParamsText(): string {
  return frozenParamsText(buildGatePreregParams(null).params);
}

/** Seqs of the first packet at or after each time. */
function packetsAt(inputs: readonly DetectorInput[], timesS: readonly number[]): Set<number> {
  const out = new Set<number>();
  for (const t of timesS) {
    for (const r of inputs) {
      if (r.k !== 'batch' || r.tr.length === 0) continue;
      if ((r.tr[r.tr.length - 1]![0] - T0_US) / 1e6 >= t) {
        out.add(r.seq);
        break;
      }
    }
  }
  return out;
}

export function buildGateSynth(o: GateSynthOptions): GateSynth {
  const seed = o.seed ?? 11;
  const gate = gateSteps('A');
  const objections: SynthObjection[] = [];
  const voices: { onS: number; offS: number }[] = [];
  const lips: [number, number][] = [];
  const talks: [number, number][] = [];
  const truth: GateSynthTruth[] = [];
  const cueS = SYNTH_CUES_MS.map((ms) => SYNTH_OBJECTIONS_S + ms / 1000);
  o.replies.forEach((r, i) => {
    const c = cueS[i]!;
    const after = r.afterCueS ?? 2;
    const speech = r.speechS ?? 2;
    let voiceS: number | null = null;
    if (r.kind === 'inhale') {
      const delay = r.voiceDelayS ?? DEFAULT_VOICE_DELAY_S;
      objections.push({ atS: c + after, inhaleS: 0.5, depth: 1.3, speechS: speech, voiceDelayS: delay });
      voiceS = c + after + 0.5 + delay;
    } else if (r.kind === 'plain' || r.kind === 'late') {
      voiceS = c + (r.kind === 'late' ? 11 : after);
      voices.push({ onS: voiceS + 0.03, offS: voiceS + speech + 1.2 });
    } else if (r.kind === 'cough') {
      voiceS = c + after;
      voices.push({ onS: voiceS + 0.03, offS: voiceS + 0.3 + 1.2 });
    }
    if (voiceS !== null && r.kind !== 'cough') {
      lips.push([voiceS - (r.lipLeadS ?? DEFAULT_LIP_LEAD_S), voiceS + speech]);
      talks.push([voiceS + 0.15, voiceS + speech]);
    }
    truth.push({ cue: i + 1, cueS: c, kind: r.kind, voiceS, nV: null });
  });
  for (const t of o.inhalesS ?? []) objections.push({ atS: t, inhaleS: 0.5, depth: 1.3, voice: false });
  // A sharp sniff: the chest rises fast as the sound starts (spec 6.3).
  const sniffSoundS = o.sniffs ? SYNTH_SNIFF_PROMPTS_S.map((p) => p + SYNTH_SNIFF_AFTER_PROMPT_S) : [];
  const notArrived = new Set(o.sniffsNotArrived ?? []);
  sniffSoundS.forEach((t, i) => {
    if (!notArrived.has(i)) objections.push({ atS: t, inhaleS: 0.25, depth: 1.2, voice: false });
  });
  objections.sort((a, b) => a.atS - b.atS);

  const jitter = o.jitter ?? 0.05;
  const base = synthSession({
    seed,
    durationS: SYNTH_DURATION_S,
    objections,
    voices,
    narratingFromS: SYNTH_LISTEN_S,
    states: [{ atS: SYNTH_BLOCK_END_S, s: 'idle' }],
    t0Us: T0_US,
    dropProb: 0.005,
    rateJitter: jitter,
    depthJitter: jitter,
    ...(o.latencyMs ? { latencyMs: o.latencyMs } : {}),
  });
  const nOf = base.nOf;
  for (const t of truth) t.nV = t.voiceS === null ? null : nOf(t.voiceS);

  // Lips, talking flags and head motion per packet, by the time of its newest sample.
  const rng = mulberry32(seed ^ 0x5bd1e995);
  const inside = (spans: readonly [number, number][], tS: number): boolean => spans.some(([a, b]) => tS >= a && tS < b);
  const resets = packetsAt(base.inputs, o.resetsAtS ?? []);
  const noFrame = packetsAt(base.inputs, o.noFrameAtS ?? []);
  const samples: SampleLine[] = [];
  // Packets of the sniffs whose trace never arrives: none arrives in the 2.5 s after the sound onset.
  const lost = sniffSoundS.filter((_, i) => notArrived.has(i)).map((t) => [nOf(t), nOf(t + 2.5)] as const);
  const lostSeqs = new Set([...base.nArrBySeq].filter(([, n]) => lost.some(([a, b]) => n >= a && n < b)).map(([seq]) => seq));
  const nArrBySeq = new Map([...base.nArrBySeq].filter(([seq]) => !lostSeqs.has(seq)));
  const inputs: DetectorInput[] = base.inputs.filter((r) => r.k !== 'batch' || !lostSeqs.has(r.seq)).map((r) => {
    if (r.k !== 'batch') return r;
    const lastTs = r.tr.length > 0 ? r.tr[r.tr.length - 1]![0] : T0_US;
    const tS = (lastTs - T0_US) / 1e6;
    const nArr = base.nArrBySeq.get(r.seq) ?? 0;
    const noise = (rng() * 2 - 1) * 0.001;
    let g: number | null = 0.035 + noise + (inside(lips, tS) ? 0.06 : 0);
    for (const l of o.lipOpenings ?? []) if (tS >= l.fromS && tS < l.toS) g += l.rise;
    const over = o.gOverride?.(r.seq, nArr, tS);
    if (over !== undefined) g = over;
    let hm: number | null = 0.002 + (rng() * 2 - 1) * 0.0005;
    if (o.noHeadMotion) hm = null;
    const reset = resets.has(r.seq);
    const without = noFrame.has(r.seq);
    if (reset || without) {
      g = null;
      hm = null;
    }
    const talk: [number, 0 | 1][] = [[lastTs, inside(talks, tS) ? 1 : 0]];
    const tr = r.tr.map(([t, v]): [number, number] => [t, v]);
    samples.push({
      seq: r.seq,
      k: 'm',
      tArrNs: String(800_000_000_000_000 + Math.round((nArr * 1e9) / RATE)),
      tsCbUs: lastTs,
      tr,
      talk,
      g,
      hm,
      lm: without ? null : { ts: lastTs, reset: reset ? 1 : 0, p: POINTS },
    });
    const b: BatchInput = { k: 'batch', seq: r.seq, tr: r.tr, talk, g, hm };
    return b;
  });

  const nCut = nOf(SYNTH_OBJECTIONS_S);
  const blockEnd = nOf(SYNTH_BLOCK_END_S);
  const cues = cueS.map(nOf);
  const stamps: Stamp[] = [];
  const mark = (n: number, name: string): void => {
    stamps.push({ n, k: 'mark', what: 'step', name });
  };
  if (o.sniffs) {
    SYNTH_SNIFF_PROMPTS_S.forEach((p, i) => {
      mark(nOf(p - 1.5), `sniff_${i + 1}_wait`);
      mark(nOf(p), gate.sniffs[i]!);
    });
  }
  mark(nOf(SYNTH_LISTEN_S), gate.listening);
  mark(nCut, gate.objections);
  cues.forEach((n, i) => {
    mark(n, `cue_${i + 1}_on`);
    stamps.push({ n, k: 'mark', what: 'cue', on: true, i: i + 1 });
    mark(n + 72_000, `cue_${i + 1}_off`);
    stamps.push({ n: n + 72_000, k: 'mark', what: 'cue', on: false, i: i + 1 });
  });
  mark(blockEnd, stepAfterCues());
  for (const [seq, n] of nArrBySeq) stamps.push({ n, k: 'arr', seq });

  // Audio: chunks around the cut (the analysis reads none of it) and around each sniff prompt.
  const runs: [number, number][] = [[nCut - 2 * CHUNK_SAMPLES, 4]];
  for (const p of o.sniffs ? SYNTH_SNIFF_PROMPTS_S : []) runs.push([nOf(p) - 6 * CHUNK_SAMPLES, 18]);
  runs.sort((a, b) => a[0] - b[0]);
  const total = runs.reduce((acc, [, chunks]) => acc + chunks * CHUNK_SAMPLES, 0);
  const ch0 = new Float32Array(total);
  const ch1 = new Float32Array(total);
  const sniffSoundN = sniffSoundS.map(nOf);
  const audioRng = mulberry32(seed ^ 0x2545f491);
  let at = 0;
  for (const [n0, chunks] of runs) {
    const len = chunks * CHUNK_SAMPLES;
    for (let c = 0; c < chunks; c++) stamps.push({ n: n0 + c * CHUNK_SAMPLES, k: 'chunk', frames: CHUNK_SAMPLES });
    if (o.sniffs) {
      const run = ch0.subarray(at, at + len);
      addNoise(run, 1e-4, audioRng);
      for (const n of sniffSoundN) if (n >= n0 && n < n0 + len) addSniff(run, n - n0, audioRng, RATE);
    }
    at += len;
  }
  stamps.sort((a, b) => a.n - b.n);

  const events: OnsetEvent[] = [];
  const eventsBefore: OnsetEvent[] = [];
  o.replies.forEach((r, i) => {
    const t = truth[i]!;
    if (t.nV === null) return;
    const speech = r.kind === 'cough' ? 0.3 : (r.speechS ?? 2);
    const delay = r.voiceDelayS ?? DEFAULT_VOICE_DELAY_S;
    const breath: [number, number] | null = r.kind === 'inhale' ? [nOf(t.voiceS! - 0.5 - delay), nOf(t.voiceS! - delay)] : null;
    const e: OnsetEvent = {
      id: `o${String(i + 1).padStart(2, '0')}`,
      kind: 'objection',
      label: r.kind === 'cough' ? 'cough' : 'speech',
      voiced_ms: r.kind === 'cough' ? 300 : speech * 1000,
      floor_db: -60,
      cue: i + 1,
      n_end: nOf(t.voiceS! + speech),
      auto: { n_v: t.nV, n_a: t.nV + 2400, breath, flags: [] },
      manual: { n_v: t.nV + Math.round(((r.manualShiftMs ?? 4) * RATE) / 1000), blind: true },
    };
    events.push(e);
    eventsBefore.push({ ...e, label: null, manual: null }); // labels and hand marks come with the label step (spec 8.5)
  });
  // As the label step writes them (analysis/label.ts): labels_sha256 over the blind labels and hand
  // marks, and the seed, the order and that hash in a label_order note (or in onsets.json itself).
  const labelsHash = onsetsLabelsSha256({ schema: 'onsets/1', labels_sha256: null, events }, sha256Hex);
  if (labelsHash === null) throw new Error('a synthetic event has no blind label');
  const order = events.map((e) => e.id);
  const onsets: Onsets = withLabelOrder({ schema: 'onsets/1', labels_sha256: labelsHash, events }, LABEL_SEED, order);
  const onsetsBeforeLabel: Onsets = { schema: 'onsets/1', labels_sha256: null, events: eventsBefore };
  const labelOrderDetail = onsetsAcceptLabelOrder() ? null : `seed ${LABEL_SEED}; order ${order.join(' ')}; labels_sha256 ${labelsHash}`;

  const lrt = o.lrt ?? { A: 23.4, B: 23.6, rule: 'mean' as const, used: 23.5 };
  const example = exampleClockReport();
  const clocksReport: ClockReport = { ...example, chain: { ...example.chain, L_rt_ms: [lrt.A, lrt.B] }, onset: null };
  const clockReport: ClockReport = { ...clocksReport, onset: onsetErrorBlock(onsets, RATE) };
  const lagMode = o.sniffLag === undefined ? 'fixed' : o.sniffLag;
  const lrtBlock = { A: lrt.A, B: lrt.B, spread: [0.3, 0.2] as [number, number], rule: lrt.rule, used: lrt.used };
  let lag: Record<string, unknown> | null = null;
  let sniffClocks: SniffRecount | null = null;
  let aRef = o.aRef === undefined ? 0.8 : o.aRef;
  if (lagMode === 'fixed') {
    lag = { n: 5, no_arrival: 0, lo_median: 118.5, hi_median: 142, median_over_ms: null };
  } else if (lagMode === 'measured') {
    // As the clocks step measures it, on the recording writeGateSession writes (sign +1 as below).
    const view = { sampleRateHz: RATE, ch0, ch1, stamps, samples, events: [], micSettings: null, layout: chunkLayout(stamps, ch0.length), detectorIn: [] };
    sniffClocks = recountSniffLag(view, gate, lrtBlock, 1);
    lag = sniffClocks.lag ? { ...calibSniffLagBlock(sniffClocks.lag) } : null;
    if (aRef !== null) aRef = sniffClocks.aRef === null ? null : Number(sniffClocks.aRef.toPrecision(4));
  }
  const calib: Record<string, unknown> = {
    L_rt_ms: lrtBlock,
    polarity: { sign: 1, breaths_agree: 3 },
    ...(aRef === null ? {} : { A_ref: aRef }),
    sniff_lag_ms: lag,
  };
  return {
    inputs,
    nArrBySeq,
    stamps,
    samples,
    onsets,
    onsetsBeforeLabel,
    calib,
    clockReport,
    quickcheck: exampleQuickcheck(),
    labelOrderDetail,
    cues,
    nCut,
    listening: { n0: nOf(SYNTH_LISTEN_S), n1: nCut },
    scored: { n0: nCut, n1: blockEnd },
    truth,
    sniffSoundN,
    sniffClocks,
    ch0,
    ch1,
    nOf,
  };
}

/** Steps a session folder holds before analyze:gate (spec 8.5). */
export const STEPS_BEFORE_GATE: readonly LedgerStep[] = ['quickcheck', 'clocks', 'onsets', 'label'];

/**
 * Writes the synthetic recording as a session folder with its ledger up to `label`; returns the
 * folder. Each step line holds the hashes of what that step writes (spec 7.10, 8.5): quickcheck
 * quickcheck.json, clocks calib.json and clock_report.json, onsets onsets.json, label onsets.json
 * and clock_report.json. The label_order note, when there is one, stands just before label.
 */
export function writeGateSession(root: string, s: GateSynth, id = 'gate-a'): string {
  const dir = writeSessionFolder(
    root,
    { sampleRateHz: RATE, ch0: s.ch0, ch1: s.ch1, stamps: s.stamps, samples: s.samples, events: [], micSettings: null },
    { id, kind: 'gate', pack: 'A', calib: s.calib },
  );
  const put = (name: string, text: string): string => {
    fs.writeFileSync(path.join(dir, name), text);
    return sha256Hex(text);
  };
  const problems = [...validateOnsets(s.onsets), ...validateOnsets(s.onsetsBeforeLabel), ...validateClockReport(s.clockReport), ...validateQuickcheck(s.quickcheck)];
  if (problems.length > 0) throw new Error(`synthetic files would be invalid:\n  ${problems.join('\n  ')}`);
  put('detector_in.jsonl', toJsonlText(s.inputs, 'detector_in.jsonl'));
  const calibSha = sha256Hex(fs.readFileSync(path.join(dir, 'calib.json')));
  const clocksReport = sha256Hex(toJsonText({ ...s.clockReport, onset: null }, 'clock_report.json'));
  const onsetsBefore = sha256Hex(toJsonText(s.onsetsBeforeLabel, 'onsets.json'));
  const outputs: Partial<Record<LedgerStep, Record<string, string>>> = {
    quickcheck: { 'quickcheck.json': put('quickcheck.json', toJsonText({ ...s.quickcheck, id }, null)) },
    clocks: { 'calib.json': calibSha, 'clock_report.json': clocksReport },
    onsets: { 'onsets.json': onsetsBefore },
    label: { 'onsets.json': put('onsets.json', toJsonText(s.onsets, 'onsets.json')), 'clock_report.json': put('clock_report.json', toJsonText(s.clockReport, 'clock_report.json')) },
  };
  const ledgerFile = path.join(dir, 'ledger.jsonl');
  const lines = fs.readFileSync(ledgerFile, 'utf8').split('\n').filter((l) => l.length > 0);
  const utc = '2026-11-14T09:00:00Z';
  for (const step of STEPS_BEFORE_GATE) {
    if (step === 'label' && s.labelOrderDetail !== null) {
      lines.push(appendLedger(lines, NOTE_STEP, { utc, commit: null, what: 'label_order', detail: s.labelOrderDetail }, (t) => sha256Hex(t), { kind: 'gate' }));
    }
    lines.push(appendLedger(lines, step, { utc, commit: null, out_sha256: outputs[step] ?? {} }, (t) => sha256Hex(t), { kind: 'gate' }));
  }
  fs.writeFileSync(ledgerFile, `${lines.join('\n')}\n`);
  return dir;
}
