// Test fixtures (tests only): session folders in the real file formats (spec 8.1), written from
// tests/synthetic sessions, and a synthetic doctor recording with known L_rt, leak and inhales.

import fs from 'node:fs';
import path from 'node:path';
import {
  CHUNK_SAMPLES,
  SAMPLE_RATE_HZ,
  chunkLayout,
  clickSchedule,
  clickWaveform,
  type EventLine,
  type MicSettings,
  type SampleLine,
  type SessionData,
  type Stamp,
} from '../../core/clock/index.ts';
import {
  appendLedger,
  isLedgerKind,
  SEALED_PLAN_KINDS,
  sampleToDetectorIn,
  toJsonText,
  toJsonlText,
  type GatePack,
  type Manifest,
  type RecordKind,
  type SampleLine as SchemaSampleLine,
} from '../../core/schemas/index.ts';
import { addCoupledClick, addNoise, gaussian, mulberry32, type Rng } from '../../tests/synthetic/signals.ts';
import { sha256Hex } from './ledger.ts';
import { SESSION_FILES, micSettingsOf, type LoadedSession } from './session.ts';
import { buildDoctorLevelScenario, buildDoctorScenario } from '../../web/scenarios/doctor.ts';
import type { Step } from '../../web/scenarios/format.ts';
import { doctorSteps, LOOP_STEPS } from './steps.ts';
import { encodeStereoFloatWav } from './wav.ts';

export interface FolderOptions {
  id: string;
  kind: RecordKind;
  pack?: GatePack | null;
  scenario?: string;
  mode?: string;
  /** Microphone name (hello settings label); default the synthetic settings' label. */
  microphone?: string | null;
  output?: string | null;
  outputAccepted?: boolean;
  startedUtc?: string;
  /** audio.wav header length field; e.g. 0 for a crash before the close. */
  headerDataBytes?: number;
  /** Write ledger.jsonl with the `record` step (default: for record kinds with a ledger). */
  ledger?: boolean;
  /** calib.json to place in the folder. */
  calib?: Record<string, unknown> | null;
  /** manifest.json plan_commitment; default a fixed seal for kinds that narrate a sealed plan, else null (spec 8.3). */
  planCommitment?: string | null;
  /** manifest.json dry, host's marker of tap's stand-in SDK (spec 6.5); left out by default. */
  dry?: boolean;
}

/** The seal a fixture of a sealed-plan record kind carries by default (64 hex digits). */
export const FIXTURE_PLAN_COMMITMENT = '5e'.repeat(32);

const HELLO_SETTINGS_KEYS = 64;

/** Primitive hello settings as host keeps them (live/lib/manifest.cjs plainSettings). */
function plainSettings(m: MicSettings | null, outputAccepted: boolean | undefined): Record<string, string | number | boolean | null> | null {
  if (!m) return null;
  const out: Record<string, string | number | boolean | null> = {};
  for (const [k, v] of Object.entries(m).slice(0, HELLO_SETTINGS_KEYS)) {
    if (typeof v === 'string' || typeof v === 'boolean' || v === null || (typeof v === 'number' && Number.isFinite(v))) out[k] = v;
  }
  if (outputAccepted !== undefined) out['output_accepted'] = outputAccepted;
  return out;
}

/** Every sample line with tArrNs (tap writes it on every line, spec 8.1). */
function withArrival(samples: readonly SampleLine[]): SampleLine[] {
  let t = 900_000_000_000n;
  return samples.map((l) => {
    t += 1_000_000n;
    return l.tArrNs === undefined ? { ...l, tArrNs: t.toString() } : l;
  });
}

/** manifest.json as host writes it for `data` (live/lib/manifest.cjs), with the given file hashes. */
export function sessionManifest(data: SessionData, o: FolderOptions, hashes: Readonly<Record<string, string>> = {}): Manifest {
  const mic = data.micSettings;
  const label = o.microphone === undefined ? (typeof mic?.['label'] === 'string' ? (mic['label'] as string) : null) : o.microphone;
  const settings = plainSettings(mic ? { ...mic, label } : null, o.outputAccepted);
  const layout = chunkLayout(data.stamps, data.ch0.length);
  const manifest: Manifest = {
    schema: 'session/1',
    id: o.id,
    kind: o.kind,
    started_utc: o.startedUtc ?? '2026-11-13T18:00:00Z',
    app_commit: null,
    tree_clean: null,
    plan_commitment: o.planCommitment !== undefined ? o.planCommitment : SEALED_PLAN_KINDS.includes(o.kind) ? FIXTURE_PLAN_COMMITMENT : null,
    sdk: data.samples.length > 0 ? { version: null, metrics: null, launcher: 'node' } : null,
    machine: 'test machine',
    camera: data.samples.length > 0 ? { name: 'Synthetic camera', requested: [1280, 720, 30] } : null,
    audio: {
      microphone: label,
      output: o.output === undefined ? 'External Headphones' : o.output,
      sample_rate: typeof mic?.contextSampleRate === 'number' ? mic.contextSampleRate : (mic?.sampleRate ?? null),
      mic_flags_off: mic !== null && mic.echoCancellation === false && mic.noiseSuppression === false && mic.autoGainControl === false,
      output_gain: null,
      settings,
      frames: data.ch0.length,
      blocks: layout.chunks,
      contiguous: layout.contiguous,
    },
    mode: o.mode ?? o.kind,
    scenario: o.scenario ?? (o.kind === 'gate' ? `gate-${o.pack ?? 'A'}` : o.kind),
    pack: o.kind === 'gate' ? (o.pack ?? 'A') : null,
    end: { reason: 'done', by: 'page' },
    files: {},
  };
  if (o.dry !== undefined) manifest.dry = o.dry;
  for (const name of Object.keys(hashes).sort()) manifest.files[name] = `sha256:${hashes[name]}`;
  return manifest;
}

/**
 * Writes a session folder as host leaves it after a recording: audio.wav (2 x float32, 48 kHz),
 * stamps.jsonl, samples.jsonl, detector_in.jsonl, events.jsonl, manifest.json with file hashes,
 * and ledger.jsonl with the `record` step. Returns the folder.
 */
export function writeSessionFolder(root: string, data: SessionData, o: FolderOptions): string {
  const dir = path.join(root, o.id);
  fs.mkdirSync(dir, { recursive: true });
  const hashes: Record<string, string> = {};
  const put = (name: string, body: string | Buffer): void => {
    fs.writeFileSync(path.join(dir, name), body);
    hashes[name] = sha256Hex(typeof body === 'string' ? Buffer.from(body, 'utf8') : body);
  };
  put(SESSION_FILES.audio, encodeStereoFloatWav(data.ch0, data.ch1, o.headerDataBytes === undefined ? {} : { headerDataBytes: o.headerDataBytes }));
  put(SESSION_FILES.stamps, toJsonlText(data.stamps as object[], 'stamps.jsonl'));
  const samples = withArrival(data.samples);
  put(SESSION_FILES.samples, toJsonlText(samples as object[], 'samples.jsonl'));
  const det = samples.map((l) => sampleToDetectorIn(l as unknown as SchemaSampleLine)).filter((x) => x !== null);
  put(SESSION_FILES.detectorIn, toJsonlText(det, 'detector_in.jsonl'));
  put(SESSION_FILES.events, toJsonlText(data.events as object[], 'events.jsonl'));
  if (o.calib) put(SESSION_FILES.calib, toJsonText({ schema: 'calib/1', ...o.calib }, 'calib.json'));
  fs.writeFileSync(path.join(dir, SESSION_FILES.manifest), toJsonText(sessionManifest(data, o, hashes), 'manifest.json'));

  if (o.ledger ?? isLedgerKind(o.kind)) {
    const line = appendLedger([], 'record', { utc: '2026-11-13T18:12:00Z', commit: null, out_sha256: { 'audio.wav': hashes[SESSION_FILES.audio]! } }, (t) => sha256Hex(t));
    fs.writeFileSync(path.join(dir, SESSION_FILES.ledger), `${line}\n`);
  }
  return dir;
}

/** A session in memory as loadSession would give it, without files (for pure condition tests). */
export function inMemorySession(data: SessionData, manifest: Manifest, dir = '/nonexistent'): LoadedSession {
  return {
    id: manifest.id,
    dir,
    manifest,
    kind: manifest.kind,
    wav: {
      fileBytes: 44 + data.ch0.length * 8,
      riffBytes: 36 + data.ch0.length * 8,
      dataOffset: 44,
      dataBytes: data.ch0.length * 8,
      presentBytes: data.ch0.length * 8,
      formatTag: 3,
      channels: 2,
      sampleRateHz: data.sampleRateHz,
      blockAlign: 8,
      bitsPerSample: 32,
      frames: data.ch0.length,
      lengthFrom: 'header',
      headerNote: null,
    },
    sampleRateHz: data.sampleRateHz,
    ch0: data.ch0,
    ch1: data.ch1,
    stamps: [...data.stamps],
    samples: [...data.samples],
    events: [...data.events],
    detectorIn: [],
    micSettings: micSettingsOf(manifest),
    calib: null,
    ledgerLines: null,
    problems: [],
    missing: [],
    layout: chunkLayout(data.stamps, data.ch0.length),
  };
}

// ---- a synthetic doctor recording --------------------------------------------------------------

export interface DoctorFixtureOptions {
  seed?: number;
  /** True L_rt of both loop checks, ms (default 23.4). */
  lrtMs?: number;
  /** Extra L_rt of loop check B, ms. */
  lrtShiftBMs?: number;
  /** Leak of the narrator into the microphone over the background, dB (default 3). */
  leakDb?: number;
  /** Background noise, RMS (default 0.0005). */
  noiseRms?: number;
  /**
   * Inhales with a weak 200 Hz hum that switch the voice detector on at periodicity 0.5 but not
   * at 0.65 (default false: plain breath noise, which never does).
   */
  periodicInhales?: boolean;
  /** Final gain event value (default 0.25); null: no gain event. */
  gain?: number | null;
  /** false: the level button was never pressed, only slider events with final false (default true). */
  gainFinal?: boolean;
  /** 'doctor-level' writes only the level steps. */
  scenario?: 'doctor' | 'doctor-level';
  micLabel?: string;
}

export interface DoctorFixture {
  data: SessionData;
  truth: { lrtMsA: number; lrtMsB: number; leakDb: number; steps: Record<string, number> };
}

const NARRATOR_RMS = 0.05;

/** One voiced syllable: harmonics of f0 up to 3 kHz (amplitude 1/k), 10 ms raised-cosine ramps, plateau RMS `rms`. */
function addHarmonicSyllable(dst: Float32Array, at: number, len: number, f0Hz: number, rms: number, rateHz: number, rng: Rng): void {
  const harmonics = Math.max(1, Math.floor(3000 / f0Hz));
  let power = 0;
  for (let k = 1; k <= harmonics; k++) power += 1 / (2 * k * k);
  const scale = rms / Math.sqrt(power);
  const phases = Array.from({ length: harmonics }, () => 2 * Math.PI * rng());
  const ramp = Math.round(0.01 * rateHz);
  for (let i = 0; i < len && at + i < dst.length; i++) {
    let v = 0;
    for (let k = 1; k <= harmonics; k++) v += Math.sin((2 * Math.PI * k * f0Hz * i) / rateHz + phases[k - 1]!) / k;
    const env = i < ramp ? 0.5 - 0.5 * Math.cos((Math.PI * i) / ramp) : i > len - ramp ? 0.5 - 0.5 * Math.cos((Math.PI * (len - i)) / ramp) : 1;
    dst[at + i] = dst[at + i]! + scale * env * v;
  }
}

/**
 * Speech-like narrator for doctor tests: voiced syllables of 120-200 ms at f0 220-260 Hz (above
 * the 150 Hz high-pass of the leak measure, so it passes them whole), 30-60 ms gaps inside words,
 * 150-400 ms between words and 0.5-0.8 s after every fifth word. Syllable plateaus have RMS `rms`;
 * the gaps are exact zeros, as channel 1 is when Deck is silent.
 */
export function speechLikeNarrator(length: number, rng: Rng, rateHz: number, rms: number): Float32Array {
  const out = new Float32Array(length);
  let t = Math.round(0.1 * rateHz);
  let words = 0;
  while (t < length) {
    const syllables = 1 + Math.floor(rng() * 3);
    for (let k = 0; k < syllables && t < length; k++) {
      const len = Math.round((0.12 + 0.08 * rng()) * rateHz);
      addHarmonicSyllable(out, t, len, 220 + 40 * rng(), rms, rateHz, rng);
      t += len + Math.round((0.03 + 0.03 * rng()) * rateHz);
    }
    words++;
    t += Math.round((words % 5 === 0 ? 0.5 + 0.3 * rng() : 0.15 + 0.25 * rng()) * rateHz);
  }
  return out;
}

/**
 * A doctor recording with the step names of web/scenarios/doctor.ts and short waits: loop check A,
 * headset, the quiet floor, the volume sample twice and the leak step (a speech-like narrator with
 * pauses in channel 1, leaking into channel 0 L_rt later at a known level), three loud inhales,
 * loop check B, end.
 */
export function makeDoctorFixture(o: DoctorFixtureOptions = {}): DoctorFixture {
  const rate = SAMPLE_RATE_HZ;
  const rng: Rng = mulberry32(o.seed ?? 7);
  const lrtA = o.lrtMs ?? 23.4;
  const lrtB = lrtA + (o.lrtShiftBMs ?? 0);
  const leakDb = o.leakDb ?? 3;
  const noise = o.noiseRms ?? 0.0005;
  const level = o.scenario === 'doctor-level';
  const names = doctorSteps();
  const scenario = level ? buildDoctorLevelScenario('level.wav') : buildDoctorScenario('level.wav');
  // Real step names and order; the waits are shortened, the measured steps keep useful lengths.
  const seconds = (st: Step): number => {
    if (st.k === 'clicks') return 12;
    if (st.k === 'play') return st.name === names.leak ? 4 : 2;
    if (st.k === 'wait') return 0.5;
    if (st.k === 'align' || st.k === 'end') return 1;
    if (st.name === names.floor) return 3;
    if (names.inhale.includes(st.name)) return st.lenSamples / rate;
    return Math.min(1, st.lenSamples / rate);
  };
  const plan: Array<[string, number]> = scenario.map((st) => [st.name, seconds(st)]);
  const samplePlays = scenario.filter((st) => st.k === 'play').map((st) => st.name);
  const steps: Record<string, number> = {};
  let t = 0;
  const stamps: Stamp[] = [];
  for (const [name, len] of plan) {
    const n = Math.round(t * rate / 128) * 128;
    steps[name] = n;
    stamps.push({ n, k: 'mark', what: 'step', name });
    t += len;
  }
  const total = Math.round(t * rate);
  const ch0 = new Float32Array(total);
  const ch1 = new Float32Array(total);

  // Loop checks: clicks in channel 1, coupled into channel 0 through the earcup.
  const click = clickWaveform();
  for (const [step, lrt] of level ? [] : ([[LOOP_STEPS.A, lrtA], [LOOP_STEPS.B, lrtB]] as const)) {
    clickSchedule().forEach((offset, i) => {
      const n = steps[step]! + 4800 + offset;
      for (let j = 0; j < click.length; j++) ch1[n + j] = ch1[n + j]! + click[j]!;
      addCoupledClick(ch0, click, n + (lrt * rate) / 1000, 0.3, rate);
      stamps.push({ n, k: 'click', i });
    });
  }

  // Narrator: a speech-like voice with pauses in channel 1 during the volume sample and the leak
  // step; channel 0 hears it L_rt later at the gain that puts its syllables leakDb over the
  // background (the 150 Hz high-pass passes both the white background and the voice whole).
  const g = (noise * Math.sqrt(10 ** (leakDb / 10) - 1)) / NARRATOR_RMS;
  const delay = Math.round((lrtA * rate) / 1000);
  for (const name of samplePlays) {
    const n0 = steps[name]!;
    const next = stamps.filter((s) => s.k === 'mark' && s.n > n0).map((s) => s.n).sort((a, b) => a - b)[0] ?? total;
    const voice = speechLikeNarrator(next - n0, rng, rate, NARRATOR_RMS);
    for (let i = 0; i < voice.length; i++) {
      const n = n0 + i;
      ch1[n] = voice[i]!;
      if (n + delay < total) ch0[n + delay] = ch0[n + delay]! + g * voice[i]!;
    }
  }

  // Inhales: 0.8 s of breath noise 1.3 s after each prompt; optionally with a weak periodic part.
  if (!level) {
    names.inhale.forEach((name, i) => {
      if (i % 2 !== 0) return;
      const n0 = steps[name]! + Math.round(0.3 * rate);
      const len = Math.round(0.8 * rate);
      for (let k = 0; k < len; k++) {
        const env = Math.sin((Math.PI * k) / len);
        let v = 0.02 * env * gaussian(rng);
        if (o.periodicInhales) v += 0.01 * env * Math.sin((2 * Math.PI * 200 * k) / rate);
        ch0[n0 + k] = ch0[n0 + k]! + v;
      }
    });
  }
  addNoise(ch0, noise, rng);

  for (let n0 = 0; n0 < total; n0 += CHUNK_SAMPLES) stamps.push({ n: n0, k: 'chunk', frames: Math.min(CHUNK_SAMPLES, total - n0) });
  stamps.sort((a, b) => a.n - b.n);

  const events: EventLine[] = [];
  if (o.gain !== null) {
    const gain = o.gain ?? 0.25;
    const at = steps[names.leak]! - 4800;
    events.push({ n: at - 4800, e: 'gain', value: 0.5, db: round1db(0.5), final: false }, { n: at, e: 'gain', value: gain, db: round1db(gain), final: o.gainFinal !== false });
  }
  const micSettings: MicSettings = {
    deviceId: 'synthetic',
    label: o.micLabel ?? 'External Microphone (Built-in)',
    sampleRate: rate,
    channelCount: 1,
    echoCancellation: false,
    noiseSuppression: false,
    autoGainControl: false,
    contextSampleRate: rate,
  };
  return {
    data: { sampleRateHz: rate, ch0, ch1, stamps, samples: [], events, micSettings },
    truth: { lrtMsA: lrtA, lrtMsB: lrtB, leakDb, steps },
  };
}

function round1db(gain: number): number {
  return Math.round(200 * Math.log10(gain)) / 10;
}
