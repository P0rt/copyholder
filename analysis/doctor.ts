// doctor report (spec 7.12, 7.7, 5.1-5.2): device names, microphone flags and sample rate from
// the hello settings, L_rt of two loop checks, the narrator leak, the voice detector floor, the
// inhale test, the output level and the TTS self-test. Writes calib.json (spec 8.1) and ends with
// exactly one line: DOCTOR OK or DOCTOR FAIL: <reason>. The analysis, calib.json and the report
// come first; the TTS self-test runs after them with a hard deadline (lib/tts.ts), so it can
// never hold calib.json back.
//
//   npx tsx analysis/doctor.ts [id] [--skip-tts]     (default: the newest doctor folder)

import path from 'node:path';
import { LRT_BOTH_MAX_MS, LRT_MEAN_MAX_MS, SAMPLE_RATE_HZ, type CalibLrt, type EventLine } from '../core/clock/index.ts';
import { toJsonText, validateCalib, type Calib } from '../core/schemas/index.ts';
import { DEFAULT_VAD_PARAMS, tuneVadThreshold, vadEdges, type VadTuneResult } from '../core/vad/index.ts';
import { latestDoctorCalib, type CalibVad } from './lib/calib-io.ts';
import { isMainModule } from './lib/cli.ts';
import { lrtOf, micFlags, type ConditionSession } from './lib/conditions.ts';
import { BUILTIN_MIC_WARNING, classifyMicrophone, outputWarning, type MicClass } from './lib/devices.ts';
import { writeFileAtomic } from './lib/files.ts';
import { audioView, latestSession, loadSession, stepSpan, stepStart, SESSION_FILES, type LoadedSession } from './lib/session.ts';
import { formatSampleTime, measureLoops, narratorLeakDb, round1, stepFloorDb, type LoopPair } from './lib/measure.ts';
import { doctorSteps } from './lib/steps.ts';
import { TTS_SELFTEST_TIMEOUT_MS, durationWords, runTtsSelftest, type TtsRunner, type TtsSelftest } from './lib/tts.ts';

/** Leak above the background that warns (spec 7.6, 7.12: 6 dB). */
export const LEAK_WARN_DB = 6;
/** Inhale test: periodicity threshold steps of 0.05 up to 0.7 (spec 7.12). */
export const VAD_STEP = 0.05;
export const VAD_MAX_PERIODICITY = 0.7;

export const EXIT_DOCTOR_OK = 0;
export const EXIT_DOCTOR_FAIL = 2;

export interface DoctorCheck {
  name: string;
  ok: boolean;
  /** Hard condition of spec 7.12; otherwise a warning. */
  hard: boolean;
  text: string;
}

export interface DoctorGain {
  value: number;
  db: number;
}

export interface DoctorAnalysis {
  /** The `--level` run: only the gain and the leak (spec 5.2, 7.7). */
  level: boolean;
  checks: DoctorCheck[];
  mic: MicClass;
  loops: LoopPair | null;
  lrt: CalibLrt | null;
  /** Time from the first click of loop check A to the first click of B, s. */
  loopGapS: number | null;
  /** Background on the quiet step, dB re full-scale mean square (the voice detector floor). */
  floorDb: number | null;
  leakDbOverFloor: number | null;
  inhale: VadTuneResult | null;
  gain: DoctorGain | null;
  tts: TtsSelftest | null;
  /** calib.json to write (spec 8.1). */
  calib: Calib;
  ok: boolean;
  /** Report lines printed before the TTS self-test: title, hard checks, measurements, PREREG values. */
  head: string[];
  /** The last line: DOCTOR OK or DOCTOR FAIL: <reason>. The TTS self-test never changes it. */
  final: string;
  /** The whole report for the TTS result in `tts`: head, TTS line, warnings, final line. */
  lines: string[];
}

export interface DoctorOptions {
  /** calib.json already in the folder (host writes the output gain into it). */
  existingCalib?: Calib | null;
  /** For the `--level` run: calib.json of the latest full doctor, copied except gain and leak. */
  baseCalib?: { id: string; calib: Calib } | null;
  /** Result of the TTS self-test; null when it was not run. */
  tts?: TtsSelftest | null;
}

/**
 * The output level the user chose: the last `gain` event with final true, written when the level
 * button is pressed (web/ui/run.ts); host stores only those (spec 7.7). Positions the slider only
 * passed through (final false) are never a choice. Null when the button was not pressed.
 */
export function chosenGain(events: readonly EventLine[]): DoctorGain | null {
  const finals = events.filter((e) => e.e === 'gain' && e['final'] === true && typeof e['value'] === 'number' && Number.isFinite(e['value']));
  const last = finals[finals.length - 1];
  if (!last) return null;
  const value = last['value'] as number;
  const db = typeof last['db'] === 'number' ? last['db'] : value > 0 ? 20 * Math.log10(value) : Number.NEGATIVE_INFINITY;
  return { value, db };
}

const fmt = (x: number, digits = 1): string => x.toFixed(digits);

/**
 * The command that writes params/frozen.json for gate-prereg with the voice detector values of a
 * doctor run (tools/freeze/frozen.ts; spec 7.3, 7.12, 8.4), as doctor prints them: the floor to
 * 0.1 dB, the periodicity threshold to 0.01.
 */
export function frozenParamsCommand(id: string, floorDb: number, periodicity: number): string {
  return `npx tsx tools/freeze/frozen.ts --doctor ${id} --floor-db ${fmt(floorDb)} --periodicity ${fmt(periodicity, 2)}`;
}

/**
 * The report lines after the PREREG.md values: the command above for this run, or why there is
 * none (a failed run writes no doctor values into calib.json, and without the floor there is nothing to freeze).
 */
export function frozenCommandLines(id: string, floorDb: number | null, periodicity: number, ok: boolean): string[] {
  if (!ok) return ['params/frozen.json: no command from a failed doctor run; fix the problem and run npm run doctor again'];
  if (floorDb === null) return ['params/frozen.json: no command, the noise floor was not measured; run npm run doctor again'];
  return ['params/frozen.json for gate-prereg from this doctor run (spec 7.3, 8.4):', `  ${frozenParamsCommand(id, floorDb, periodicity)}`];
}

function settingNumber(s: ConditionSession, key: string): number | null {
  const v = s.micSettings?.[key];
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

/** True for the `npm run doctor -- --level` recording (spec 5.2, 7.7). */
export function isLevelRun(manifest: LoadedSession['manifest']): boolean {
  return manifest['scenario'] === 'doctor-level';
}

/** L_rt to align channel 1 with channel 0 for the leak: the rule's value, else A; null when unmeasured. */
function lrtForLeak(lrt: { used?: number | null; A?: number | null } | null | undefined): number | null {
  const v = lrt?.used ?? lrt?.A ?? null;
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

/** Pure doctor analysis of one loaded doctor recording; the report includes opts.tts when given. */
export function analyzeDoctor(s: ConditionSession & Pick<LoadedSession, 'id'>, opts: DoctorOptions = {}): DoctorAnalysis {
  const level = isLevelRun(s.manifest);
  const names = doctorSteps();
  const rate = s.sampleRateHz;
  const checks: DoctorCheck[] = [];
  const info: string[] = [];
  const hard = (name: string, ok: boolean, text: string): void => void checks.push({ name, ok, hard: true, text });
  const warn = (name: string, text: string): void => void checks.push({ name, ok: false, hard: false, text });

  // Devices (spec 5.1-5.2): names from the hello settings host keeps in manifest.json. The
  // built-in microphone is the last fallback reference of spec 5.1: accepted, with a warning
  // (spec 7.12 says "headset microphone found"; its hard/warning split is an assumption there).
  const label = s.manifest.audio.microphone ?? (typeof s.micSettings?.['label'] === 'string' ? (s.micSettings['label'] as string) : null);
  const mic = classifyMicrophone(label);
  hard('microphone', mic.ok, mic.ok ? `microphone ${mic.reason}` : `headset microphone not found: ${mic.reason}`);
  if (mic.verdict === 'builtin') warn('builtin_microphone', `${BUILTIN_MIC_WARNING.charAt(0).toUpperCase()}${BUILTIN_MIC_WARNING.slice(1)}`);
  if (mic.verdict === 'unknown') warn('microphone_name', mic.reason);
  const output = typeof s.manifest.audio.output === 'string' ? s.manifest.audio.output : null;
  info.push(`Output: ${output === null ? 'not reported' : `"${output}"`}`);
  const outWarn = outputWarning(output);
  if (outWarn) warn('output_device', outWarn);
  const accepted = s.micSettings?.['output_accepted'];
  if (accepted === false) warn('sink_id', 'Chrome did not accept the output device (sinkId); the narrator may play on the default output');
  else info.push(`Output device (sinkId): ${accepted === true ? 'accepted' : 'not reported'}`);

  // Processing flags and sample rate (spec 6.3, 7.3).
  const flags = micFlags(s);
  hard('mic_flags_off', flags.ok, flags.reason);
  const ctxRate = settingNumber(s, 'contextSampleRate');
  const trackRate = settingNumber(s, 'sampleRate');
  const rates = `audio context ${ctxRate ?? 'unknown'} Hz, microphone track ${trackRate ?? 'unknown'} Hz, audio.wav ${s.wav.sampleRateHz} Hz`;
  const ratesOk = ctxRate === SAMPLE_RATE_HZ && trackRate === SAMPLE_RATE_HZ && s.wav.sampleRateHz === SAMPLE_RATE_HZ;
  hard('sample_rate', ratesOk, ratesOk ? `sample rate: ${rates}` : `not everything runs at 48000 Hz (${rates}): set 48 000 Hz in Audio MIDI Setup (spec 5.2)`);

  // Loop checks A and B (spec 6.3, 7.12): clicks of each clicks step, then the L_rt rule.
  let loops: LoopPair | null = null;
  let lrt: CalibLrt | null = null;
  let loopGapS: number | null = null;
  if (!level) {
    loops = measureLoops(s);
    lrt = lrtOf(loops);
    const words = (b: 'A' | 'B'): string => {
      const m = loops![b];
      if (!m) return 'no clicks stamped';
      return m.L_rt_ms === null ? `not found (${m.found} of ${m.total} clicks heard)` : `L_rt ${fmt(m.L_rt_ms)} ms, ${m.found} of ${m.total} clicks, spread ${fmt(m.spread_ms ?? 0)} ms`;
    };
    const a0 = loops.clicks.A?.[0];
    const b0 = loops.clicks.B?.[0];
    loopGapS = a0 !== undefined && b0 !== undefined ? (b0 - a0) / rate : null;
    info.push(`Loop check A: ${words('A')}`);
    info.push(`Loop check B: ${words('B')}${loopGapS === null ? '' : `, ${formatSampleTime(b0! - a0!, rate)} after A`}`);
    const found = lrt.A !== null && lrt.B !== null;
    hard('loop_clicks', found, found ? 'clicks of both loop checks found' : `clicks of loop check ${lrt.A === null ? 'A' : 'B'} not found: hold the earcup on the microphone during the clicks`);
    if (found) {
      const diff = Math.abs(lrt.A! - lrt.B!);
      info.push(`L_rt rule: ${lrt.rule}${lrt.used === null ? '' : `, L_rt used ${fmt(lrt.used)} ms`}`);
      if (diff > LRT_MEAN_MAX_MS) warn('lrt_ab_diff', `loop checks A and B differ by ${fmt(diff)} ms, more than ${LRT_MEAN_MAX_MS} ms`);
    }
  }

  // Background and voice detector floor (spec 7.3, 7.12): the quiet floor step.
  const floorRaw = stepFloorDb(s, names.floor);
  const floorDb = floorRaw === null ? null : round1(floorRaw);
  if (floorDb === null) warn('floor', `the quiet step "${names.floor}" was not recorded: no background and no voice detector floor`);
  else info.push(`Background (step ${names.floor}): ${fmt(floorDb)} dB re full scale`);

  // Leak: channel 0 while the narrator plays the sample at the chosen level (step leak), in dB over
  // the background of the floor step. The measure is the voice detector's step energy: dB re
  // full-scale mean square of the 150 Hz high-passed microphone over 10 ms windows, median over the
  // steps where channel 1, moved by L_rt, plays (lib/measure.ts narratorLeakDb). The level run has
  // no loop checks: it aligns with L_rt of the full doctor it copies.
  let leakDbOverFloor: number | null = null;
  const leakSpan = stepSpan(s, names.leak);
  const alignMs = level ? lrtForLeak(opts.baseCalib?.calib.L_rt_ms) : lrtForLeak(lrt);
  if (leakSpan && floorRaw !== null) {
    const leak = narratorLeakDb(s, leakSpan.n0, leakSpan.n1, alignMs ?? 0);
    if (leak) leakDbOverFloor = round1(leak.leakDb - floorRaw);
  }
  if (leakDbOverFloor === null) warn('leak_missing', `no leak measured: the "${names.leak}" step with the volume sample was not recorded`);
  else {
    info.push(`Narrator leak into the microphone: ${fmt(leakDbOverFloor)} dB over the background (warning above ${LEAK_WARN_DB} dB)${alignMs === null ? '; no L_rt to align with' : ''}`);
    if (leakDbOverFloor > LEAK_WARN_DB) {
      warn('leak', `the narrator raises the microphone ${fmt(leakDbOverFloor)} dB over the background, more than ${LEAK_WARN_DB} dB: seat the earcups or choose a quieter level (npm run doctor -- --level)`);
    }
  }

  // Inhale test (spec 7.12): voice edges over the three loud inhales; any voice_on raises the
  // periodicity threshold in steps of 0.05, at most 0.7 (core/vad tuneVadThreshold).
  let inhale: VadTuneResult | null = null;
  if (!level) {
    const first = stepStart(s, names.inhale[0] ?? '');
    const lastSpan = stepSpan(s, names.inhaleLast);
    const view = first !== null && lastSpan ? audioView(s, 0, first, lastSpan.n1) : null;
    if (view && floorDb !== null) {
      const params = { ...DEFAULT_VAD_PARAMS, floorDb };
      const ons = vadEdges(view.signal, params, view.n0).filter((e) => e.on).length;
      inhale =
        ons === 0
          ? { periodicity: params.periodicity, params, inhaleTriggered: false, ok: true, trials: [{ periodicity: params.periodicity, onEdges: 0 }] }
          : tuneVadThreshold(view.signal, params, { stepPeriodicity: VAD_STEP, maxPeriodicity: VAD_MAX_PERIODICITY, n0: view.n0 });
      if (!inhale.inhaleTriggered) info.push(`Inhale test: no inhale switched the voice detector on; periodicity threshold stays ${fmt(inhale.periodicity, 2)}`);
      else if (inhale.ok) info.push(`Inhale test: an inhale switched the voice detector on; periodicity threshold raised to ${fmt(inhale.periodicity, 2)}`);
      else warn('inhale', `the inhales still switch the voice detector on at the cap ${fmt(VAD_MAX_PERIODICITY, 2)}; the threshold stays at ${fmt(inhale.periodicity, 2)}`);
    } else {
      warn('inhale_missing', 'the inhale test was not recorded: the periodicity threshold stays at the default');
    }
  }

  // Output level (spec 7.7): the last final gain event.
  const gain = chosenGain(s.events);
  if (gain === null) warn('gain', 'no output level was chosen in this run (the level button was not pressed): calib.json keeps no new level, so the level of an earlier doctor stays in use, if there is one');
  else if (!(gain.value > 0 && gain.value <= 1)) warn('gain', `output gain ${gain.value} is outside (0, 1] and is not stored`);
  else info.push(`Output level: ${Number.isFinite(gain.db) ? fmt(gain.db) : '-inf'} dB (gain ${gain.value.toPrecision(3)})`);
  const gainOk = gain !== null && gain.value > 0 && gain.value <= 1;

  // calib.json (spec 8.1) plus the voice detector block (names of params/frozen.json).
  const periodicity = inhale ? inhale.periodicity : DEFAULT_VAD_PARAMS.periodicity;
  let calib: Calib;
  if (level) {
    const base = opts.baseCalib?.calib ?? null;
    if (!base) warn('base_calib', 'no full doctor run with calib.json was found: only the gain and the leak are stored; run npm run doctor');
    calib = { ...(base ?? {}), ...(opts.existingCalib ?? {}), schema: 'calib/1' };
    if (base?.L_rt_ms !== undefined) calib.L_rt_ms = base.L_rt_ms;
    if (base && base['vad'] !== undefined) calib['vad'] = base['vad'];
  } else {
    calib = { ...(opts.existingCalib ?? {}), schema: 'calib/1' };
    if (lrt) calib.L_rt_ms = lrt;
    if (floorDb !== null) calib['vad'] = { floor_db: floorDb, periodicity } satisfies CalibVad;
  }
  calib.leak_db_over_floor = leakDbOverFloor;
  if (gainOk) calib.output_gain = gain.value;

  const failed = checks.filter((c) => c.hard && !c.ok);
  const ok = failed.length === 0;
  const head = [
    `Doctor report for ${s.id}${level ? ' (level and leak only)' : ''}`,
    ...checks.filter((c) => c.hard).map((c) => `${c.ok ? 'ok  ' : 'FAIL'}  ${c.text}`),
    ...info,
  ];
  if (!level) {
    const lrtWords =
      lrt && lrt.A !== null && lrt.B !== null
        ? Math.abs(lrt.A - lrt.B) <= LRT_MEAN_MAX_MS
          ? `confirmed: ${LRT_MEAN_MAX_MS} ms and ${LRT_BOTH_MAX_MS} ms (L_rt A ${fmt(lrt.A)} ms, B ${fmt(lrt.B)} ms)`
          : `not confirmed: A and B differ by ${fmt(Math.abs(lrt.A - lrt.B))} ms (L_rt A ${fmt(lrt.A)} ms, B ${fmt(lrt.B)} ms); decide the thresholds before gate-prereg (spec 6.3)`
        : 'not measured: a loop check is missing';
    head.push(
      'For PREREG.md:',
      `  {{VAD_FLOOR_DB}} = ${floorDb === null ? 'not measured' : fmt(floorDb)}`,
      `  {{VAD_PERIODICITY}} = ${fmt(periodicity, 2)}`,
      `  {{LRT_THRESHOLDS_CONFIRMED}} = ${lrtWords}`,
      ...frozenCommandLines(s.id, floorDb, periodicity, ok),
    );
  }
  const final = ok ? 'DOCTOR OK' : `DOCTOR FAIL: ${failed[0]!.text}`;
  const analysis: DoctorAnalysis = { level, checks, mic, loops, lrt, loopGapS, floorDb, leakDbOverFloor, inhale, gain, tts: null, calib, ok, head, final, lines: [] };
  return finishDoctorReport(analysis, opts.tts ?? null);
}

/**
 * The report for a TTS self-test result (spec 7.7: a failing self-test only warns): the head,
 * the TTS line (full run only), the warnings and the final line, which the TTS never changes.
 */
export function finishDoctorReport(a: DoctorAnalysis, tts: TtsSelftest | null): DoctorAnalysis {
  const checks = a.checks.filter((c) => c.name !== 'tts');
  const ttsLines: string[] = [];
  if (!a.level) {
    if (tts === null) ttsLines.push('TTS self-test: not run');
    else if (tts.ok) ttsLines.push(`TTS self-test: ${tts.summary}`);
    else checks.push({ name: 'tts', ok: false, hard: false, text: `TTS self-test failed: ${tts.summary}` });
  }
  const warnings = checks.filter((c) => !c.hard);
  const lines = [
    ...a.head,
    ...ttsLines,
    warnings.length === 0 ? 'Warnings: none' : `Warnings (${warnings.length}):`,
    ...warnings.map((w) => `  warn  ${w.text}`),
    a.final,
  ];
  return { ...a, tts, checks, lines };
}

export interface DoctorDeps {
  out?: (line: string) => void;
  env?: NodeJS.ProcessEnv;
  /** TTS self-test runner; null skips it (tests never run the real one). */
  tts?: TtsRunner | null;
}

/**
 * Doctor report of a loaded doctor recording: analyses, writes calib.json when the hard conditions
 * hold, prints the report, then runs the TTS self-test (full run only, bounded by its timeout) and
 * prints its result, the warnings and the final line. Exit code 0 OK, 2 FAIL.
 */
export async function runDoctor(session: LoadedSession, deps: DoctorDeps = {}): Promise<{ code: number; analysis: DoctorAnalysis }> {
  const out = deps.out ?? ((l: string) => console.log(l));
  const env = deps.env ?? process.env;
  const level = isLevelRun(session.manifest);
  const baseCalib = level ? latestDoctorCalib(env, session.id) : null;
  const analysis = analyzeDoctor(session, { existingCalib: session.calib, baseCalib });
  const problems = validateCalib(analysis.calib);
  if (problems.length > 0) throw new Error(`calib.json would be invalid: ${problems.join('; ')}`);
  for (const l of analysis.head) out(l);
  if (analysis.ok) {
    writeFileAtomic(path.join(session.dir, SESSION_FILES.calib), toJsonText(analysis.calib, 'calib.json'));
    out(`calib.json written: ${level ? 'output gain and leak' : 'L_rt, output gain, leak, voice detector floor and threshold'}${level && baseCalib ? ` (the rest copied from ${baseCalib.id})` : ''}.`);
  } else if (typeof session.calib?.output_gain === 'number') {
    // host wrote the chosen output level into calib.json at the level step (spec 7.7, 8.1)
    out(`calib.json keeps only the output level chosen in this run; ${level ? 'the leak was' : 'L_rt, the leak and the voice detector values were'} not written: fix the problem and run npm run doctor again.`);
  } else {
    out('calib.json not written: fix the problem and run npm run doctor again.');
  }
  let tts: TtsSelftest | null = null;
  if (!level && deps.tts !== null) {
    out(`Running the TTS self-test (the first run downloads the voice model; it stops after ${durationWords(TTS_SELFTEST_TIMEOUT_MS)} at most)...`);
    tts = await (deps.tts ?? (() => runTtsSelftest()))();
  }
  const done = finishDoctorReport(analysis, tts);
  for (const l of done.lines.slice(analysis.head.length)) out(l);
  return { code: done.ok ? EXIT_DOCTOR_OK : EXIT_DOCTOR_FAIL, analysis: done };
}

/** CLI: npx tsx analysis/doctor.ts [id] [--skip-tts]; without an id, the newest doctor folder. */
export async function main(argv: readonly string[] = process.argv.slice(2), deps: Pick<DoctorDeps, 'tts'> = {}): Promise<number> {
  try {
    const id = argv.find((a) => !a.startsWith('-')) ?? latestSession('doctor');
    if (id === null) {
      console.log('No doctor recording found. Record one with npm run doctor.');
      return 1;
    }
    const tts = argv.includes('--skip-tts') ? { tts: null } : deps;
    return (await runDoctor(loadSession(id, { detectorIn: false }), tts)).code;
  } catch (e) {
    console.error(e instanceof Error ? (e.stack ?? e.message) : String(e));
    console.log(`DOCTOR FAIL: the report crashed: ${e instanceof Error ? e.message.split('\n')[0] : String(e)}`);
    return 1;
  }
}

if (isMainModule(import.meta.url)) {
  main().then(
    (code) => {
      process.exitCode = code;
    },
    (e: unknown) => {
      console.error(e);
      process.exitCode = 1;
    },
  );
}
