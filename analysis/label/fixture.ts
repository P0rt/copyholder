// Test fixtures for clocks and label (tests only): a synthetic day-1 gate folder (tests/synthetic)
// with its ledger up to a chosen step, optionally with clean replies (3 ms attack) in place of the
// generator's 15 ms-attack replies, or with clean voices wherever a test needs them.

import fs from 'node:fs';
import type { SessionData } from '../../core/clock/index.ts';
import { makeSyntheticSession, type SyntheticOptions, type SyntheticTruth } from '../../tests/synthetic/session.ts';
import { gaussian, mulberry32, type Rng } from '../../tests/synthetic/signals.ts';
import { runClocks } from '../clocks.ts';
import { writeSessionFolder } from '../lib/fixtures.ts';
import { appendLedgerStep, sha256Hex } from '../lib/ledger.ts';
import { loadSession } from '../lib/session.ts';

/** Generator constants (tests/synthetic/session.ts): noise floor RMS, narrator leak gain, reply length. */
const NOISE_RMS = 0.0005;
const LEAK_GAIN = 0.01;
const REPLY_REGION_S = 0.95;
const R = 48_000;

/**
 * A clean voiced reply: harmonics of a 120 Hz voice (1/k amplitudes, random phases, a slow f0
 * glide) present from the first sample, a 3 ms raised-cosine attack and a 40 ms release. Unlike
 * a wavetable vowel, its energy starts with the attack, so the onset is defined to the sample.
 */
export function addCleanVoice(dst: Float32Array, at: number, durS: number, amp: number, rng: Rng, rateHz = R): void {
  const n = Math.round(durS * rateHz);
  const attack = Math.round(0.003 * rateHz);
  const release = Math.round(0.04 * rateHz);
  const harmonics = Array.from({ length: 30 }, (_, k) => ({ k: k + 1, phase: 2 * Math.PI * rng() }));
  let peak = 0;
  const wave = new Float32Array(n);
  let phase = 0;
  for (let i = 0; i < n; i++) {
    const f0 = 120 - 10 * (i / n);
    phase += (2 * Math.PI * f0) / rateHz;
    let v = 0;
    for (const h of harmonics) if (h.k * f0 < 8000) v += Math.sin(h.k * phase + h.phase) / h.k;
    wave[i] = v;
    peak = Math.max(peak, Math.abs(v));
  }
  for (let i = 0; i < n; i++) {
    const env = i < attack ? 0.5 - 0.5 * Math.cos((Math.PI * i) / attack) : i > n - release ? 0.5 - 0.5 * Math.cos((Math.PI * (n - i)) / release) : 1;
    const j = at + i;
    if (j >= 0 && j < dst.length) dst[j] = dst[j]! + (amp * env * wave[i]!) / peak;
  }
}

/**
 * Blanks the generator's reply at nV: over [n_v, n_v + 0.95 s) fresh noise and the narrator leak
 * (channel 1 through L_rt at -40 dB, as the generator adds it) replace its voice.
 */
function blankReply(ch0: Float32Array, data: SessionData, truth: SyntheticTruth, nV: number, rng: Rng): void {
  const leakDelay = Math.round((truth.lrtMs.A * R) / 1000);
  const region = Math.round(REPLY_REGION_S * R);
  for (let n = nV; n < nV + region && n < ch0.length; n++) {
    const src = n - leakDelay;
    const leak = src >= truth.narration[0] && src < truth.narration[1] ? LEAK_GAIN * data.ch1[src]! : 0;
    ch0[n] = NOISE_RMS * gaussian(rng) + leak;
  }
}

/**
 * Channel 0 with every generated reply replaced by a clean one at the same onset: the generator's
 * voice is blanked and an 0.8 s clean voice (addCleanVoice) put in. The truth onsets stay those
 * of the generator.
 */
export function withCleanReplies(data: SessionData, truth: SyntheticTruth, seed = 7): SessionData {
  const ch0 = Float32Array.from(data.ch0);
  const rng = mulberry32(seed);
  for (const nV of truth.voiceOnsets) {
    blankReply(ch0, data, truth, nV, rng);
    addCleanVoice(ch0, nV, 0.8, 0.15, rng);
  }
  return { ...data, ch0 };
}

/** A clean voiced sound for channel 0: its onset (sample) and length. */
export interface CleanVoice {
  at: number;
  durS: number;
}

/**
 * Channel 0 with every generated reply blanked and the given clean voices put in instead: replies
 * late after their dot, a reply across the dot, a remark between cues. Their onsets are the truth.
 */
export function withVoices(data: SessionData, truth: SyntheticTruth, voices: readonly CleanVoice[], seed = 7): SessionData {
  const ch0 = Float32Array.from(data.ch0);
  const rng = mulberry32(seed);
  for (const nV of truth.voiceOnsets) blankReply(ch0, data, truth, nV, rng);
  for (const v of voices) addCleanVoice(ch0, v.at, v.durS, 0.15, rng);
  return { ...data, ch0 };
}

export interface GateFolderOptions {
  id?: string;
  seed?: number;
  replies?: number;
  /** Narration length, s; half of it is the listening block (A_ref needs 15 s of it). */
  narrationS?: number;
  clean?: boolean;
  /** Last ledger step before the commands under test (default clocks, run for real). */
  through?: 'record' | 'quickcheck' | 'clocks';
  faults?: SyntheticOptions['faults'];
  /** Changes the session before it is written. */
  edit?: (data: SessionData, truth: SyntheticTruth) => SessionData;
}

export interface GateFolder {
  dir: string;
  data: SessionData;
  truth: SyntheticTruth;
}

/** A gate recording (pack A) as host leaves it, plus quickcheck and clocks steps as asked. */
export function makeGateFolder(root: string, o: GateFolderOptions = {}): GateFolder {
  const { session, truth } = makeSyntheticSession({
    scenario: 'gate',
    narrationS: o.narrationS ?? 24,
    replies: o.replies ?? 3,
    seed: o.seed ?? 5,
    ...(o.faults ? { faults: o.faults } : {}),
  });
  let data = o.clean ? withCleanReplies(session, truth) : session;
  if (o.edit) data = o.edit(data, truth);
  fs.mkdirSync(root, { recursive: true });
  const dir = writeSessionFolder(root, data, { id: o.id ?? 'gate-a', kind: 'gate', pack: 'A' });
  const through = o.through ?? 'clocks';
  if (through !== 'record') {
    const r = appendLedgerStep(dir, 'gate', 'quickcheck', {
      utc: '2026-11-13T18:13:00Z',
      commit: null,
      outSha256: { 'quickcheck.json': sha256Hex('quickcheck stand-in') },
    });
    if (!r.appended) throw new Error(r.reason ?? 'quickcheck step not appended');
  }
  if (through === 'clocks') {
    const run = runClocks(loadSession(dir), { out: () => undefined, now: () => new Date('2026-11-13T18:20:00Z'), commit: () => 'abc1234' });
    if (run.refused) throw new Error(run.refused);
  }
  return { dir, data, truth };
}
