// Conditions of quickcheck (spec 7.12, 9.4), one pure function each: a session in memory in,
// {ok, value, reason, technical} out. Hard conditions decide GOOD RECORDING / RE-RECORD NOW;
// warnings only print. Every condition but 6 (voice after cues) is technical (spec 9.4); a
// recording that fails any technical one failed for a technical reason (quickcheck.ts).

import {
  AUDIO_GAP_EVENTS,
  LRT_BOTH_MAX_MS,
  LRT_MEAN_MAX_MS,
  SAMPLE_RATE_HZ,
  TRACE_RATE_MIN_PER_S,
  WINDOW_WARNING_EVENTS,
  loopRule,
  micFlagsOff,
  notSentShare,
  recordingSampleRateHz,
  sdkErrorCount,
  statusOkShare,
  tapLoopP99Ms,
  traceRateMedian,
  type CalibLrt,
  type LoopMeasurement,
} from '../../core/clock/index.ts';
import { polaritySign, type CueWindow } from '../../core/detector.ts';
import { findPaBursts, findSniffOnset } from '../../core/onset/index.ts';
import { DEFAULT_VAD_PARAMS, type VadParams } from '../../core/vad/index.ts';
import type { Manifest } from '../../core/schemas/index.ts';
import {
  armedDetectors,
  armedIntervals,
  cueMarkStarts,
  cueStarts,
  duringRecording,
  formatSampleTime,
  hardWindowEvents,
  measureLoops,
  overlapLength,
  packetEnvelope,
  readingIntervals,
  round1,
  round3,
  sampleToCameraUs,
  stepFloorDb,
  totalLength,
  traceSamples,
  voiceEdgesOver,
  type LoopPair,
  type SessionView,
} from './measure.ts';
import { runView, stepMarks, stepSpan, stepStart, type LoadedSession } from './session.ts';
import { END_STEP, HEADSET_STEP, deepInSteps, paClosedSteps, type GateSteps } from './steps.ts';

/** What a condition reads: the session in memory, its manifest and its WAV facts. */
export type ConditionSession = SessionView & Pick<LoadedSession, 'manifest' | 'wav'>;

export interface ConditionResult {
  /** Check name in quickcheck.json (core/schemas QUICKCHECK_NAMES). */
  name: string;
  ok: boolean;
  /** Hard condition (fails the recording) or warning only. */
  hard: boolean;
  /** The measured value (a primitive, ms and dB rounded to 0.1). */
  value: string | number | boolean | null;
  limit?: string | number | boolean | null;
  /** Plain words: why it failed, or what was found. */
  reason: string;
  /** A failure is technical: it does not use up the one re-record (spec 9.4). */
  technical: boolean;
  /** Numbers behind the value, for quickcheck.json and the printed report. */
  detail?: string;
}

export interface ConditionContext {
  /** Step names and counts of the gate pack (gate recordings only). */
  gate?: GateSteps;
  /**
   * Voice detector parameters to recompute edges with (frozen or doctor values); see vadSource.
   * Without floorDb the floor is measured on the recording.
   */
  vad?: Partial<VadParams>;
  /** Where `vad` came from, for the report. */
  vadSource?: string;
  /** Precomputed loop checks (doctor reuses them). */
  loops?: LoopPair;
  /** Cued deep breaths for the trace sign (default: the three of web/scenarios). */
  deepBreaths?: number;
  /** The confirming detector params/frozen.json names (D1, or D3 after the retune, spec 4, 9.8); default D1. */
  detector?: string;
}

const result = (r: ConditionResult): ConditionResult => r;
const hz = (n: number): string => `${n} Hz`;
const ms = (x: number | null): string => (x === null ? 'not found' : `${round1(x).toFixed(1)} ms`);

// ---- 1. audio continuous ---------------------------------------------------------------------

/** End of the run in plain words, from manifest `end` (host's record of how the recording ended). */
function endWords(manifest: Manifest): string {
  const end = manifest['end'];
  if (end && typeof end === 'object' && !Array.isArray(end)) {
    const reason = (end as Record<string, unknown>)['reason'];
    const by = (end as Record<string, unknown>)['by'];
    if (typeof reason === 'string') return ` (ended: ${reason.replace(/_/g, ' ')}${typeof by === 'string' ? ` by ${by}` : ''})`;
  }
  return '';
}

/**
 * Condition 1 (spec 9.4): the audio is continuous and not shorter than the scenario. Chunk stamps
 * contiguous from sample 0 and adding up to audio.wav, both channels equally long, no audio gap
 * events from host, and the scenario reached its end step.
 */
export function audioContinuous(s: ConditionSession): ConditionResult {
  const rate = s.sampleRateHz;
  const gapEvents = s.events.filter((ev) => AUDIO_GAP_EVENTS.has(ev.e));
  const runs = s.layout.runs;
  const holes: string[] = [];
  if (runs.length > 0 && runs[0]!.n0 !== 0) holes.push(`the first ${round1((runs[0]!.n0 * 1000) / rate)} ms are missing`);
  for (let i = 1; i < runs.length; i++) {
    const prev = runs[i - 1]!;
    const cur = runs[i]!;
    const lost = cur.n0 - prev.n1;
    holes.push(lost > 0 ? `${round1((lost * 1000) / rate)} ms lost at ${formatSampleTime(prev.n1, rate)}` : `audio blocks out of order at ${formatSampleTime(cur.n0, rate)}`);
  }
  const endN = stepStart(s, END_STEP);
  const lastN = runs.length > 0 ? runs[runs.length - 1]!.n1 : 0;
  const value = holes.length > 0 ? holes.length : gapEvents.length;
  const base = { name: 'audio_continuous', hard: true, technical: true, limit: 0 } as const;
  if (runs.length === 0 || s.layout.chunks === 0) {
    return result({ ...base, ok: false, value: null, reason: 'no audio blocks are stamped in stamps.jsonl, so the audio cannot be checked' });
  }
  if (holes.length > 0) {
    return result({ ...base, ok: false, value, reason: `the audio has a gap: ${holes[0]}${holes.length > 1 ? ` (and ${holes.length - 1} more)` : ''}`, detail: holes.join('; ') });
  }
  if (!s.layout.contiguous || s.ch0.length !== s.ch1.length) {
    return result({ ...base, ok: false, value, reason: `audio.wav holds ${s.ch0.length} frames but the chunk stamps add up to ${s.layout.frames}` });
  }
  if (gapEvents.length > 0) {
    const first = gapEvents[0]!;
    const at = typeof first.n === 'number' ? ` at ${formatSampleTime(first.n, rate)}` : '';
    return result({ ...base, ok: false, value, reason: `host reported ${gapEvents.length} lost or damaged audio block(s) (${first.e}${at})` });
  }
  if (endN === null) {
    return result({
      ...base,
      ok: false,
      value,
      reason: `the recording stopped at ${formatSampleTime(lastN, rate)}, before the end of the scenario${endWords(s.manifest)}`,
    });
  }
  return result({ ...base, ok: true, value, reason: `continuous audio, ${formatSampleTime(lastN, rate)} long, scenario finished`, detail: `${s.layout.chunks} blocks` });
}

// ---- 2. loop checks -----------------------------------------------------------------------------

function loopWords(block: 'A' | 'B', m: LoopMeasurement | null): string {
  if (m === null) return `loop check ${block}: no clicks stamped`;
  return `loop check ${block}: ${ms(m.L_rt_ms)}, ${m.found} of ${m.total} clicks heard`;
}

/** The L_rt rule of spec 6.3 over both loop checks, with what was measured. */
export function lrtOf(loops: LoopPair): CalibLrt {
  return loopRule(loops.A, loops.B);
}

/**
 * Condition 2 (spec 9.4): both loop checks found, A and B no more than 15 ms apart (rule of spec
 * 6.3: `mean` or `both`; `void` fails).
 */
export function loopChecks(s: ConditionSession, ctx: ConditionContext = {}): ConditionResult {
  const loops = ctx.loops ?? measureLoops(s);
  const lrt = lrtOf(loops);
  const detail = `${loopWords('A', loops.A)}; ${loopWords('B', loops.B)}; rule ${lrt.rule}`;
  const base = { name: 'loop_checks', hard: true, technical: true, limit: LRT_BOTH_MAX_MS, detail } as const;
  for (const block of ['A', 'B'] as const) {
    const m = loops[block];
    if (m === null || m.L_rt_ms === null) {
      const heard = m === null ? 'no clicks were stamped' : `only ${m.found} of ${m.total} clicks were heard in the microphone`;
      return result({ ...base, ok: false, value: null, reason: `loop check ${block} was not found: ${heard}; hold the earcup on the microphone during the clicks` });
    }
  }
  const diff = round1(Math.abs(lrt.A! - lrt.B!));
  if (lrt.rule === 'void') {
    return result({ ...base, ok: false, value: diff, reason: `loop checks A and B differ by ${diff.toFixed(1)} ms, more than ${LRT_BOTH_MAX_MS} ms: the audio path changed during the recording` });
  }
  return result({ ...base, ok: true, value: diff, reason: `L_rt A ${lrt.A!.toFixed(1)} ms, B ${lrt.B!.toFixed(1)} ms, rule ${lrt.rule}` });
}

/** Warning: A and B differ by 3-15 ms; the recording is good but flagged (spec 9.4). */
export function lrtDiffWarning(s: ConditionSession, ctx: ConditionContext = {}): ConditionResult {
  const lrt = lrtOf(ctx.loops ?? measureLoops(s));
  const both = lrt.A !== null && lrt.B !== null;
  const diff = both ? round1(Math.abs(lrt.A! - lrt.B!)) : null;
  const flagged = lrt.rule === 'both';
  return result({
    name: 'L_rt_diff',
    hard: false,
    technical: true,
    ok: !flagged,
    value: diff,
    limit: LRT_MEAN_MAX_MS,
    reason: flagged
      ? `loop checks A and B differ by ${diff!.toFixed(1)} ms (3-15 ms): flagged, every lead is computed with both values`
      : diff === null
        ? 'loop checks not both found'
        : `loop checks A and B differ by ${diff.toFixed(1)} ms`,
  });
}

// ---- 3. cues ---------------------------------------------------------------------------------------

/**
 * Condition 3 (spec 9.4): every cue of the pack is marked in stamps.jsonl. Only Deck's own
 * `mark` `cue` stamps count; the cue steps of the scenario do not stand in for them.
 */
export function cuesMarked(s: ConditionSession, ctx: ConditionContext): ConditionResult {
  const gate = requireGate(ctx);
  const found = cueMarkStarts(s).length;
  const want = gate.counts.cues;
  const base = { name: 'cues_marked', hard: true, technical: true, value: found, limit: want } as const;
  if (found < want) {
    const steps = cueStarts(s, gate.cueOn).length;
    const why = found === 0 && steps > 0 ? ` (the scenario entered ${steps} cue steps, but Deck's cue marks are missing)` : '';
    return result({ ...base, ok: false, reason: `only ${found} of ${want} cue marks are in stamps.jsonl${why}` });
  }
  return result({ ...base, ok: true, reason: `${found} of ${want} cues marked` });
}

function requireGate(ctx: ConditionContext): GateSteps {
  if (!ctx.gate) throw new Error('this condition needs the gate pack (ConditionContext.gate)');
  return ctx.gate;
}

// ---- 4. trace rate ----------------------------------------------------------------------------------

/** Condition 4 (spec 9.4): median trace rate at least 25 samples per second. */
export function traceRate(s: ConditionSession): ConditionResult {
  const rate = traceRateMedian(s.samples);
  const base = { name: 'trace_rate', hard: true, technical: true, limit: TRACE_RATE_MIN_PER_S } as const;
  if (rate === null) {
    return result({ ...base, ok: false, value: null, reason: 'no breathing trace was recorded (samples.jsonl has no trace)' });
  }
  const v = round1(rate);
  if (rate < TRACE_RATE_MIN_PER_S) {
    return result({ ...base, ok: false, value: v, reason: `the breathing trace ran at ${v.toFixed(1)} samples per second, below ${TRACE_RATE_MIN_PER_S}: check the light and the camera` });
  }
  return result({ ...base, ok: true, value: v, reason: `breathing trace at ${v.toFixed(1)} samples per second` });
}

// ---- 5. SDK errors and tap -------------------------------------------------------------------------------

/** Condition 5 (spec 7.12): no SDK `error` and no `tap_lost` during the recording. */
export function noSdkError(s: ConditionSession): ConditionResult {
  const during = duringRecording(s);
  const errors = sdkErrorCount(s, during);
  const tapLost = s.events.filter((ev) => ev.e === 'tap_lost' && during(ev)).length;
  const base = { name: 'no_sdk_error', hard: true, technical: true, value: errors + tapLost, limit: 0 } as const;
  if (errors > 0) {
    const ev = s.events.find((e) => e.e === 'sdk_error');
    const line = s.samples.find((l) => l.k === 'e');
    const name = (typeof ev?.['name'] === 'string' ? ev['name'] : null) ?? line?.name ?? null;
    const code = (typeof ev?.['code'] === 'number' ? ev['code'] : null) ?? line?.code ?? null;
    const what = name !== null || code !== null ? ` (${[code === null ? null : `code ${code}`, name].filter(Boolean).join(' ')})` : '';
    return result({ ...base, ok: false, reason: `the SDK reported ${errors} error(s)${what}` });
  }
  if (tapLost > 0) {
    return result({ ...base, ok: false, reason: `the connection to tap was lost ${tapLost} time(s): the SDK stopped sending` });
  }
  return result({ ...base, ok: true, reason: 'no SDK error, tap stayed connected' });
}

// ---- 6. voice after cues -------------------------------------------------------------------------------

/** Voice must start within this long after a cue (spec 9.4). */
export const VOICE_AFTER_CUE_MS = 10_000;

/**
 * Voice detector parameters for the recomputation: ctx.vad (frozen or doctor values) when it
 * has a floor; else ctx.vad (or the default detector) with the floor measured on the quiet rest
 * before the listening block, or on the headset step.
 */
export function vadParamsFor(s: ConditionSession, ctx: ConditionContext): { params: Partial<VadParams>; source: string } {
  if (ctx.vad && ctx.vad.floorDb !== undefined) return { params: ctx.vad, source: ctx.vadSource ?? 'given parameters' };
  const base: Partial<VadParams> = ctx.vad ?? DEFAULT_VAD_PARAMS;
  const prefix = ctx.vad ? `${ctx.vadSource ?? 'given parameters'}; ` : '';
  for (const step of [ctx.gate?.restBeforeListening ?? null, HEADSET_STEP]) {
    if (step === null) continue;
    const floor = stepFloorDb(s, step, base);
    if (floor !== null) return { params: { ...base, floorDb: round1(floor) }, source: `${prefix}floor ${round1(floor).toFixed(1)} dB measured on step ${step}` };
  }
  return { params: base, source: `${prefix}no quiet step to measure the floor on: the default floor ${DEFAULT_VAD_PARAMS.floorDb} dB` };
}

/** The voice detector starts this long before the first cue (or at the objection block, if earlier). */
export const VOICE_LEAD_IN_MS = 5_000;

/** End of the objection block: the first step after `objections` that is not a cue step. */
export function objectionBlockEnd(s: ConditionSession, gate: GateSteps): number {
  const marks = stepMarks(s);
  const i = marks.findIndex((m) => m.name === gate.objections);
  if (i < 0) return Number.POSITIVE_INFINITY;
  const cueSteps = new Set(gate.cueSteps);
  return marks.slice(i + 1).find((m) => !cueSteps.has(m.name))?.n ?? Number.POSITIVE_INFINITY;
}

/**
 * Condition 6 (spec 9.4): a voice (core/vad voice_on, recomputed on channel 0) within 10 s after
 * at least 12 of the 14 cues; both cues in pack 0. One detector runs over the whole stretch from
 * 5 s before the first cue (or the objection block start) to the last window, so only a voice
 * that starts after the cue counts (spec 9.6: the voice began after the cue); a voice already
 * running at the cue does not. A cue's window ends at the next cue or at the end of the objection
 * block, so each voice_on belongs to one cue. Not technical: fewer answers mean fewer usable
 * objections (spec 9.4).
 */
export function voiceAfterCues(s: ConditionSession, ctx: ConditionContext): ConditionResult {
  const gate = requireGate(ctx);
  const fromMarks = cueMarkStarts(s).length > 0;
  const cues = [...cueStarts(s, gate.cueOn)].sort((a, b) => a - b);
  // Cues that may go unanswered (2 of 14, none in pack 0). A cue without a mark is condition 3's
  // failure (technical), so this condition is judged on the marked cues only.
  const allowedMisses = gate.counts.cues - gate.counts.voices;
  const need = Math.max(0, cues.length - allowedMisses);
  const rate = s.sampleRateHz;
  const win = Math.round((VOICE_AFTER_CUE_MS * rate) / 1000);
  const blockEnd = objectionBlockEnd(s, gate);
  const { params, source } = vadParamsFor(s, ctx);
  const windows = cues.map((c, i) => [c, Math.min(c + win, cues[i + 1] ?? Number.POSITIVE_INFINITY, blockEnd)] as const);
  let ons: number[] = [];
  if (cues.length > 0) {
    const blockStart = stepStart(s, gate.objections) ?? Number.POSITIVE_INFINITY;
    const from = Math.max(0, Math.min(blockStart, cues[0]! - Math.round((VOICE_LEAD_IN_MS * rate) / 1000)));
    const to = Math.max(...windows.map(([, end]) => end));
    ons = voiceEdgesOver(s, from, to, params).filter((e) => e.on).map((e) => e.n);
  }
  // An edge at the cue sample was decided on samples before it: the voice started earlier.
  const answered = windows.filter(([c, end]) => ons.some((n) => n > c && n < end)).length;
  const cueSource = fromMarks ? '' : '; cue times from the cue steps (Deck cue marks missing)';
  const base = { name: 'voice_after_cues', hard: true, technical: false, value: answered, limit: need, detail: `voice detector: ${source}${cueSource}` } as const;
  if (answered < need) {
    return result({ ...base, ok: false, reason: `a voice was found within 10 s after only ${answered} of ${cues.length} cues (needs ${need})` });
  }
  return result({ ...base, ok: true, reason: `voice within 10 s after ${answered} of ${cues.length} cues` });
}

// ---- 7. 'pa' bursts -------------------------------------------------------------------------------------

/**
 * 'pa' bursts found in one syllable block: core/onset findPaBursts over the whole block (its floor
 * is the block's median, spec 6.3), then each prompt counts when its window, from its 'Lips
 * closed' step to the next one, holds a burst.
 */
export function paBlockFound(s: ConditionSession, tag: 'pa_start' | 'pa_end', count: number): { found: number; total: number } {
  const starts = paClosedSteps(tag, count).map((name) => stepStart(s, name));
  const first = starts.find((n): n is number => n !== null);
  const lastSpan = stepSpan(s, `${tag}_${count}`);
  if (first === undefined) return { found: 0, total: count };
  const view = runView(s, 0, first);
  if (!view) return { found: 0, total: count };
  const blockEnd = Math.min(view.n1, lastSpan ? lastSpan.n1 : view.n1);
  if (blockEnd <= first) return { found: 0, total: count };
  const bursts = findPaBursts(view.signal, first, blockEnd, { n0: view.n0 }).bursts;
  let found = 0;
  starts.forEach((n0, i) => {
    if (n0 === null) return;
    const n1 = starts.slice(i + 1).find((n): n is number => n !== null) ?? blockEnd;
    if (bursts.some((b) => b.n >= n0 && b.n < n1)) found++;
  });
  return { found, total: count };
}

/** Condition 7 (spec 9.4): in each 'pa' block at least 4 of 5 bursts; pack 0 needs its one per block. */
export function paBursts(s: ConditionSession, ctx: ConditionContext): ConditionResult {
  const gate = requireGate(ctx);
  const start = paBlockFound(s, 'pa_start', gate.paStart.length);
  const end = paBlockFound(s, 'pa_end', gate.paEnd.length);
  const need = gate.counts.paPerBlock;
  const value = `${start.found}/${start.total}, ${end.found}/${end.total}`;
  const base = { name: 'pa_bursts', hard: true, technical: true, value, limit: need, detail: `start block ${start.found} of ${start.total}, end block ${end.found} of ${end.total}` } as const;
  for (const [label, b] of [['start', start], ['end', end]] as const) {
    if (b.found < need) {
      return result({ ...base, ok: false, reason: `only ${b.found} of ${b.total} 'pa' bursts were found in the ${label} block (needs ${need}): say 'pa' clearly from closed lips` });
    }
  }
  return result({ ...base, ok: true, reason: `'pa' bursts: ${value}` });
}

// ---- 8. sniffs ---------------------------------------------------------------------------------------------

/** Condition 8 (spec 9.4): at least 4 sniff onsets (both in pack 0), searched from each 'Sniff' prompt. */
export function sniffsFound(s: ConditionSession, ctx: ConditionContext): ConditionResult {
  const gate = requireGate(ctx);
  let found = 0;
  for (const name of gate.sniffs) {
    const n = stepStart(s, name);
    if (n === null) continue;
    const view = runView(s, 0, n);
    if (!view) continue;
    const span = stepSpan(s, name);
    const searchTo = span ? Math.min(span.n1, n + 2 * s.sampleRateHz) : undefined;
    const onset = findSniffOnset(view.signal, n, searchTo === undefined ? { n0: view.n0 } : { n0: view.n0, searchToSample: searchTo });
    if (onset !== null) found++;
  }
  const need = gate.counts.sniffs;
  const base = { name: 'sniffs', hard: true, technical: true, value: found, limit: need } as const;
  if (found < need) {
    return result({ ...base, ok: false, reason: `only ${found} of ${gate.sniffs.length} sniffs were heard (needs ${need}): sniff sharply through the nose on 'Sniff'` });
  }
  return result({ ...base, ok: true, reason: `${found} of ${gate.sniffs.length} sniffs heard` });
}

// ---- 9. trace sign -----------------------------------------------------------------------------------------

/**
 * Condition 9 (spec 9.4): the three cued deep breaths give one trace sign (core/detector
 * polaritySign). The 'Breathe in' steps are put on the camera clock through the packet arrival
 * envelope (core/clock lowerEnvelope).
 */
export function polarity(s: ConditionSession, ctx: ConditionContext = {}): ConditionResult {
  const names = deepInSteps(ctx.deepBreaths ?? 3);
  const base = { name: 'polarity', hard: true, technical: true, limit: 'one sign' } as const;
  const env = packetEnvelope(s);
  if (env === null) return result({ ...base, ok: false, value: null, reason: 'no breathing trace packets, so the trace sign cannot be found' });
  const windows: CueWindow[] = [];
  for (const name of names) {
    const span = stepSpan(s, name);
    if (!span) continue;
    windows.push({ startUs: sampleToCameraUs(env, span.n0, s.sampleRateHz), endUs: sampleToCameraUs(env, span.n1, s.sampleRateHz) });
  }
  if (windows.length < names.length) {
    return result({ ...base, ok: false, value: null, reason: `only ${windows.length} of ${names.length} cued deep breaths are in the recording` });
  }
  const p = polaritySign(traceSamples(s), windows);
  const detail = `d = ${p.d.map((x) => (Number.isFinite(x) ? x.toPrecision(3) : 'none')).join(', ')}`;
  if (!p.agree || p.sign === null) {
    return result({ ...base, ok: false, value: null, detail, reason: 'the three cued deep breaths do not move the breathing trace the same way: breathe in fully on each cue and sit still' });
  }
  return result({ ...base, ok: true, value: p.sign, detail, reason: `trace sign ${p.sign > 0 ? '+1' : '-1'} from all three deep breaths${p.margin ? '' : ' (small margin)'}` });
}

// ---- audio conditions of the clock check (spec 6.3) ----------------------------------------------------------

/** Names of the processing flags that are not off. */
function flagsOn(s: ConditionSession): string[] {
  const m = s.micSettings;
  if (!m) return [];
  const out: string[] = [];
  if (m.echoCancellation !== false) out.push('echo cancellation');
  if (m.noiseSuppression !== false) out.push('noise suppression');
  if (m.autoGainControl !== false) out.push('auto gain control');
  return out;
}

/** Audio condition (spec 6.3): the three browser processing flags of the microphone are off. */
export function micFlags(s: ConditionSession): ConditionResult {
  const ok = micFlagsOff(s.micSettings);
  const base = { name: 'mic_flags_off', hard: true, technical: true, value: ok, limit: true } as const;
  if (ok) return result({ ...base, ok, reason: 'echo cancellation, noise suppression and auto gain control are off' });
  if (!s.micSettings) return result({ ...base, ok, reason: 'the microphone settings were not logged, so the processing flags are unknown' });
  return result({ ...base, ok, reason: `microphone processing is on: ${flagsOn(s).join(', ')}` });
}

/** Audio condition (spec 6.3): audio.wav, the AudioContext, the microphone track and the manifest at 48 000 Hz. */
export function sampleRate(s: ConditionSession): ConditionResult {
  const rates: Array<[string, number | null | undefined]> = [
    ['audio.wav', s.wav.sampleRateHz],
    ['the audio context', typeof s.micSettings?.contextSampleRate === 'number' ? s.micSettings.contextSampleRate : null],
    ['the microphone track', typeof s.micSettings?.sampleRate === 'number' ? s.micSettings.sampleRate : null],
    ['manifest.json', s.manifest.audio.sample_rate],
  ];
  const wrong = rates.find(([, r]) => typeof r === 'number' && r !== SAMPLE_RATE_HZ);
  const value = recordingSampleRateHz(s);
  const base = { name: 'sample_rate', hard: true, technical: true, limit: SAMPLE_RATE_HZ } as const;
  if (wrong) {
    return result({ ...base, ok: false, value: wrong[1] as number, reason: `${wrong[0]} runs at ${hz(wrong[1] as number)}, not ${hz(SAMPLE_RATE_HZ)}: set 48 000 Hz in Audio MIDI Setup (spec 5.2)` });
  }
  return result({ ...base, ok: true, value, reason: `everything at ${hz(SAMPLE_RATE_HZ)}` });
}

/** Plain words for the hard window and device events (spec 6.3, docs/protocol.md). */
const HARD_EVENT_WORDS: Readonly<Record<string, string>> = {
  visibilitychange: 'the page was hidden',
  devicechange: 'the audio devices changed',
  track_ended: 'the microphone track ended',
  track_mute: 'the microphone track was muted',
  page_reload: 'the page was reloaded',
  page_lost: 'the page was lost',
};

/** Audio condition (spec 6.3): no hard window or device event during the recording. */
export function noHardWindowEvents(s: ConditionSession): ConditionResult {
  const evs = hardWindowEvents(s);
  const base = { name: 'no_hard_window_events', hard: true, technical: true, value: evs.length, limit: 0 } as const;
  if (evs.length > 0) {
    const first = evs[0]!;
    const what = HARD_EVENT_WORDS[first.e] ?? `the page reported a hard event "${first.e}"`;
    const at = typeof first.n === 'number' ? ` at ${formatSampleTime(first.n, s.sampleRateHz)}` : '';
    return result({ ...base, ok: false, reason: `${what}${at} during the recording${evs.length > 1 ? ` (${evs.length} hard events)` : ''}` });
  }
  return result({ ...base, ok: true, reason: 'no hard window or device event' });
}

// ---- sessions --------------------------------------------------------------------------------------------------

/** D1 must be active at least this share of the reading time (spec 7.12). */
export const D1_ACTIVE_MIN_SHARE = 0.5;

/**
 * The detector whose activity counts: the worker writes `armed` events with its live variant
 * (D1, or D3 when the limited retune ended on it, spec 4, 7.4, 9.8). One variant in the events:
 * that one; several: the one params/frozen.json names (`preferred`); none: `preferred`, else D1.
 */
export function confirmingDetector(s: Pick<ConditionSession, 'events'>, preferred = 'D1'): string {
  const dets = armedDetectors(s);
  if (dets.length === 1) return dets[0]!;
  if (dets.length === 0 || dets.includes(preferred)) return preferred;
  return dets[0]!;
}

/**
 * Session condition (spec 7.12): the confirming detector (D1 by plan, D3 after the retune; D3 has
 * the same activity, spec 7.4) armed for at least half of the reading time (`armed` events).
 */
export function d1ActiveShare(s: ConditionSession, ctx: ConditionContext = {}): ConditionResult {
  const det = confirmingDetector(s, ctx.detector ?? 'D1');
  const reading = readingIntervals(s);
  const readN = totalLength(reading);
  const base = { name: 'd1_active_share', hard: true, technical: true, limit: D1_ACTIVE_MIN_SHARE, detail: `detector ${det}` } as const;
  if (readN <= 0) return result({ ...base, ok: false, value: null, reason: 'no reading time was found (no narrating state in stamps.jsonl)' });
  const share = overlapLength(reading, armedIntervals(s, det)) / readN;
  const v = round3(share);
  if (share < D1_ACTIVE_MIN_SHARE) {
    return result({ ...base, ok: false, value: v, reason: `${det} was active for only ${Math.round(100 * share)}% of the reading time (needs 50%)` });
  }
  return result({ ...base, ok: true, value: v, reason: `${det} active for ${Math.round(100 * share)}% of the reading time` });
}

// ---- warnings ----------------------------------------------------------------------------------------------------

/**
 * Warning thresholds. Spec 7.12 sets them after the first runs; these are placeholders
 * (assumption): frames not sent above 5 %, tap's event-loop P99 above 20 ms, kOk below 90 %.
 */
export const WARN = { notSentShare: 0.05, tapLoopP99Ms: 20, statusOkShare: 0.9 } as const;

export function notSentWarning(s: ConditionSession): ConditionResult {
  const v = notSentShare(s.samples);
  const ok = v === null || v <= WARN.notSentShare;
  return result({
    name: 'not_sent_share', hard: false, technical: true, ok, value: v === null ? null : round3(v), limit: WARN.notSentShare,
    reason: v === null ? 'no frameSentThrough events' : `${(100 * v).toFixed(1)}% of frames were not sent through`,
  });
}

export function tapLoopWarning(s: ConditionSession): ConditionResult {
  const v = tapLoopP99Ms(s.samples);
  const ok = v === null || v <= WARN.tapLoopP99Ms;
  return result({
    name: 'tap_loop_delay', hard: false, technical: true, ok, value: v === null ? null : round1(v), limit: WARN.tapLoopP99Ms,
    reason: v === null ? 'no event-loop delay lines from tap' : `tap event-loop delay P99 ${round1(v).toFixed(1)} ms`,
  });
}

export function statusOkWarning(s: ConditionSession): ConditionResult {
  const v = statusOkShare(s.samples);
  const ok = v === null || v >= WARN.statusOkShare;
  return result({
    name: 'status_ok_share', hard: false, technical: true, ok, value: v === null ? null : round3(v), limit: WARN.statusOkShare,
    reason: v === null ? 'no validation status lines' : `SDK status kOk ${(100 * v).toFixed(1)}% of the camera time`,
  });
}

export function windowWarnings(s: ConditionSession): ConditionResult {
  const during = duringRecording(s);
  const evs = s.events.filter((ev) => WINDOW_WARNING_EVENTS.has(ev.e) && during(ev));
  const blur = evs.filter((ev) => ev.e === 'blur').length;
  return result({
    name: 'window_warnings', hard: false, technical: true, ok: evs.length === 0, value: evs.length, limit: 0,
    reason: evs.length === 0 ? 'no blur or resize' : `${blur} blur and ${evs.length - blur} resize event(s): keep the Chrome window in front`,
  });
}

/** Warning: problems found while reading the files (skipped lines, a WAV header fixed from the file size). */
export function filesWarning(problems: readonly string[]): ConditionResult {
  return result({
    name: 'files_valid', hard: false, technical: true, ok: problems.length === 0, value: problems.length, limit: 0,
    reason: problems.length === 0 ? 'every file line is valid' : `${problems.length} file problem(s), first: ${problems[0]}`,
  });
}
