// npm run pack (analysis/pack.ts) on synthetic session folders in temporary folders: no SDK, no
// network, nothing from gate/. Device names are the sample ones of core/schemas/published.test.ts.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  EXAMPLE_SEAL,
  exampleCalib,
  exampleClockReport,
  exampleEvents,
  exampleHex,
  exampleManifest,
  exampleOnsets,
  exampleQuickcheck,
  exampleSamples,
  exampleVerdict,
} from '../core/schemas/examples.ts';
import {
  appendLedger,
  checkWavFormat,
  splitJsonlLines,
  toJsonText,
  toJsonlText,
  validateAudioEnv,
  validatePublishedFolder,
  verifyLedgerText,
  type ClockReport,
  type GatePack,
  type LedgerStep,
  type LedgerStepLine,
  type Manifest,
  type Quickcheck,
  type RecordKind,
  type SamplePacket,
} from '../core/schemas/index.ts';
import { nextRecordingAdvice } from './gate/inputs.ts';
import { sha256Hex } from './lib/ledger.ts';
import { gateSteps } from './lib/steps.ts';
import { encodeStereoFloatWav, readWavHeader } from './lib/wav.ts';
import { SET_ORDER, gResetsJson, holdsHomePath, main, marksJsonl, parsePackArgs, type PackDeps } from './pack.ts';
import { ENV_STEP_FRAMES, SILENCE_DB, levelDb, readSessionAudio } from './pack/audio.ts';
import { formatBytes, whyNoSet, whyNotMeasured } from './pack/rules.ts';
import { gResetSeqs, type SampleLmLike } from './rivals/index.ts';

// ---- fixtures ---------------------------------------------------------------------------------

/** Text that must never reach the output or the published set: it stands for the words of a text. */
const SECRET = 'PRIVATE-WORDS-7f3a';

interface Env {
  root: string;
  sessions: string;
  data: string;
  env: NodeJS.ProcessEnv;
}

let e: Env;

beforeEach(() => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'copyholder-pack-'));
  const sessions = path.join(root, 'sessions');
  fs.mkdirSync(sessions);
  const data = path.join(root, 'data');
  e = { root, sessions, data, env: { COPYHOLDER_SESSIONS_DIR: sessions, COPYHOLDER_DATA_DIR: data } };
});

afterEach(() => {
  fs.rmSync(e.root, { recursive: true, force: true });
});

const STEP = ENV_STEP_FRAMES;

/**
 * Four 10 ms steps and a last one of 100 frames, with known levels: mean square 0.01 is -20 dB,
 * 0.25 is -6.02 dB, 0.0625 is -12.04 dB, 0.0025 is -26.02 dB, 0.02 is -16.99 dB; silence and
 * 1e-6 (-120 dB) give the -90 floor; full scale gives 0 dB.
 */
function knownAudio(): { ch0: Float32Array; ch1: Float32Array; mic: number[]; narrator: number[] } {
  const n = 4 * STEP + 100;
  const ch0 = new Float32Array(n);
  const ch1 = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const step = Math.floor(i / STEP);
    const alt = i % 2 === 0 ? 1 : -1;
    ch0[i] = [0.1 * alt, 0, 1e-6, 0.5 * alt, alt][step]!;
    ch1[i] = [0.25, 0.05 * alt, i % STEP < STEP / 2 ? 0.2 : 0, 0, 0.5][step]!;
  }
  return { ch0, ch1, mic: [-20, -90, -90, -6, 0], narrator: [-12, -26, -17, -90, -6] };
}

const T0 = 1794935111123456;

const DETECTOR_IN = [
  { k: 'batch', seq: 1, tr: [[T0, -0.4]], talk: [[T0, 0]], g: 0.03, hm: 0.002 },
  { k: 'val', seq: 2, code: 0 },
  { k: 'batch', seq: 3, tr: [[T0 + 33_333, -0.35]], talk: [[T0 + 33_333, 1]], g: null, hm: null },
  { k: 'voice', n: 1700, on: true },
  { k: 'state', n: 1700, s: 'listening' },
];

/** stream.jsonl of DETECTOR_IN with the arr stamps of stampsOf (spec 8.7). */
const STREAM = [
  { k: 'batch', seq: 1, nArr: 600, tr: [[T0, -0.4]], talk: [[T0, 0]], g: 0.03, hm: 0.002 },
  { k: 'val', seq: 2, nArr: 900, code: 0 },
  { k: 'batch', seq: 3, nArr: 1200, tr: [[T0 + 33_333, -0.35]], talk: [[T0 + 33_333, 1]], g: null, hm: null },
  { k: 'voice', n: 1700, on: true },
  { k: 'state', n: 1700, s: 'listening' },
];

function stampsOf(objectionStep: string | null): object[] {
  const st: object[] = [
    { n: 0, k: 'chunk', frames: 4 * STEP + 100 },
    { n: 600, k: 'arr', seq: 1 },
    { n: 900, k: 'arr', seq: 2 },
    { n: 1200, k: 'arr', seq: 3 },
  ];
  if (objectionStep !== null) st.push({ n: 1500, k: 'mark', what: 'step', name: objectionStep });
  return st;
}

const SEALED: readonly RecordKind[] = ['numbers', 'spacebar', 'rehearsal', 'demo', 'pilot'];

/** manifest.json as host writes it (real tap, SDK ran), with device names that hold a person's name and a local path. */
function hostManifest(id: string, kind: RecordKind, pack: GatePack | null, files: Record<string, string>): Manifest {
  return {
    ...exampleManifest(),
    id,
    kind,
    plan_commitment: SEALED.includes(kind) ? EXAMPLE_SEAL : null,
    camera: { name: "Anna's iPhone Camera", requested: [1280, 720, 30] },
    audio: {
      microphone: "Anna's AirPods",
      output: "Anna's AirPods",
      sample_rate: 48000,
      mic_flags_off: true,
      output_gain: 0.35,
      settings: { label: "Anna's AirPods", deviceId: 'f00d', groupId: 'beef', sampleRate: 48000 },
    },
    mode: kind,
    tap: 'real',
    dry: false,
    ...(kind === 'gate' ? { pack } : {}),
    paths: { session: `/Users/anna/copyholder/sessions/${id}` },
    files,
  };
}

interface Recording {
  dir: string;
  /** SHA-256 of every file host hashed, by name. */
  hashes: Record<string, string>;
  manifestSha: string;
}

interface RecordingOptions {
  id: string;
  kind: RecordKind;
  pack?: GatePack | null;
  /** Step mark of the objection block in stamps.jsonl (gate). */
  objectionStep?: string | null;
  /** false: manifest.json holds no file hashes, as after a crash. */
  hashFiles?: boolean;
  /** Changes to the manifest before it is written. */
  manifest?: (m: Manifest) => Manifest;
  /** Lines of events.jsonl; default exampleEvents(). */
  events?: readonly object[];
  /** Lines of stamps.jsonl, or its text; default stampsOf(objectionStep). */
  stamps?: readonly object[] | string;
  /** Lines of detector_in.jsonl; default DETECTOR_IN. */
  detectorIn?: readonly object[];
  /** Lines of samples.jsonl, or its text; default exampleSamples(). */
  samples?: readonly object[] | string;
}

function put(dir: string, name: string, body: string | Buffer, hashes?: Record<string, string>): string {
  const bytes = typeof body === 'string' ? Buffer.from(body, 'utf8') : body;
  fs.writeFileSync(path.join(dir, name), bytes);
  const sha = sha256Hex(bytes);
  if (hashes) hashes[name] = sha;
  return sha;
}

/** A session folder as host leaves it after a recording (live/host.cjs saveRecording). */
function writeRecording(o: RecordingOptions): Recording {
  const dir = path.join(e.sessions, o.id);
  fs.mkdirSync(dir, { recursive: true });
  const hashes: Record<string, string> = {};
  const a = knownAudio();
  put(dir, 'audio.wav', encodeStereoFloatWav(a.ch0, a.ch1), hashes);
  put(dir, 'stamps.jsonl', typeof o.stamps === 'string' ? o.stamps : toJsonlText(o.stamps ?? stampsOf(o.objectionStep ?? null), 'stamps.jsonl'), hashes);
  put(dir, 'samples.jsonl', typeof o.samples === 'string' ? o.samples : toJsonlText(o.samples ?? exampleSamples(), 'samples.jsonl'), hashes);
  put(dir, 'detector_in.jsonl', toJsonlText(o.detectorIn ?? DETECTOR_IN, 'detector_in.jsonl'), hashes);
  put(dir, 'events.jsonl', toJsonlText(o.events ?? exampleEvents(), 'events.jsonl'), hashes);
  put(dir, 'calib.json', toJsonText(exampleCalib(), 'calib.json', 2), hashes);
  put(dir, 'sdk_raw.jsonl.gz', Buffer.from([0x1f, 0x8b, 8, 0, 1, 2, 3, 4]), hashes);
  put(dir, 'timings.json', `{"words":["${SECRET}"]}\n`, hashes);
  const files: Record<string, string> = {};
  if (o.hashFiles !== false) for (const name of Object.keys(hashes).sort()) files[name] = `sha256:${hashes[name]}`;
  let m = hostManifest(o.id, o.kind, o.pack ?? null, files);
  if (o.manifest) m = o.manifest(m);
  const manifestSha = put(dir, 'manifest.json', toJsonText(m, 'manifest.json', 2));
  // tap.log is a log, never hashed (live/host.cjs).
  fs.writeFileSync(path.join(dir, 'tap.log'), `tap: ${SECRET}\n`);
  return { dir, hashes, manifestSha };
}

type QuickcheckCase = 'good' | 'condition6' | 'technical';

function quickcheckOf(id: string, c: QuickcheckCase): Quickcheck {
  const q = { ...exampleQuickcheck(), id };
  if (c === 'good') return q;
  const failing = c === 'condition6' ? 'voice_after_cues' : 'trace_rate';
  return {
    ...q,
    result: 'RE-RECORD NOW',
    reasons: [c === 'condition6' ? 'voice after 10 of 14 cues (need 12)' : 'trace rate 12.0 per second (need 25)'],
    technical: c === 'technical',
    checks: q.checks.map((k) => (k.name === failing ? { ...k, ok: false, value: c === 'condition6' ? 10 : 12 } : k)),
  };
}

interface GateOptions {
  id: string;
  pack: 'A' | 'B' | 'C';
  /** Last ledger step written ('label' writes onsets and label). */
  stage: 'record' | 'quickcheck' | 'clocks' | 'label' | 'stage_a' | 'verdict';
  quickcheck?: QuickcheckCase;
  clockReport?: ClockReport;
  /** The objection block began (its step mark is in stamps.jsonl); default true. */
  objectionsReached?: boolean;
  manifest?: (m: Manifest) => Manifest;
  events?: readonly object[];
  stamps?: readonly object[] | string;
  detectorIn?: readonly object[];
  samples?: readonly object[] | string;
}

interface Gate extends Recording {
  ledgerText: () => string;
}

/** A gate recording with its ledger (spec 8.5) up to `stage`, with the files each step wrote. */
function writeGate(o: GateOptions): Gate {
  const rec = writeRecording({
    id: o.id,
    kind: 'gate',
    pack: o.pack,
    objectionStep: o.objectionsReached === false ? null : gateSteps(o.pack).objections,
    ...(o.manifest ? { manifest: o.manifest } : {}),
    ...(o.events ? { events: o.events } : {}),
    ...(o.stamps ? { stamps: o.stamps } : {}),
    ...(o.detectorIn ? { detectorIn: o.detectorIn } : {}),
    ...(o.samples ? { samples: o.samples } : {}),
  });
  const lines: string[] = [];
  let minute = 10;
  const add = (step: LedgerStep, out: Record<string, string>): void => {
    lines.push(appendLedger(lines, step, { utc: `2026-11-21T10:${String(minute++)}:00Z`, commit: '1234abc', out_sha256: out }, (t) => sha256Hex(t), { kind: 'gate' }));
  };
  add('record', { ...rec.hashes, 'manifest.json': rec.manifestSha });
  const stages = ['record', 'quickcheck', 'clocks', 'label', 'stage_a', 'verdict'];
  const reached = (s: string): boolean => stages.indexOf(o.stage) >= stages.indexOf(s);
  if (reached('quickcheck')) {
    add('quickcheck', { 'quickcheck.json': put(rec.dir, 'quickcheck.json', toJsonText(quickcheckOf(o.id, o.quickcheck ?? 'good'), null, 2)) });
  }
  if (reached('clocks')) {
    const report = put(rec.dir, 'clock_report.json', toJsonText(o.clockReport ?? exampleClockReport(), 'clock_report.json', 2));
    add('clocks', { 'calib.json': rec.hashes['calib.json']!, 'clock_report.json': report });
  }
  if (reached('label')) {
    const onsets = put(rec.dir, 'onsets.json', toJsonText(exampleOnsets(), 'onsets.json', 2));
    add('onsets', { 'onsets.json': onsets });
    add('label', { 'clock_report.json': sha256Hex(fs.readFileSync(path.join(rec.dir, 'clock_report.json'))), 'onsets.json': onsets });
  }
  if (reached('stage_a')) add('stage_a', { 'params/frozen.json': exampleHex('7') });
  if (reached('verdict')) {
    const verdict = put(rec.dir, 'verdict.json', toJsonText({ ...exampleVerdict(), id: o.id, pack: o.pack }, null, 2));
    add('stage_b', { 'verdict.json': verdict });
    add('verdict', { 'verdict.json': verdict, 'verdict.md': put(rec.dir, 'verdict.md', `# Verdict of ${o.id}\n\n${SECRET}\n`) });
  }
  fs.writeFileSync(path.join(rec.dir, 'ledger.jsonl'), `${lines.join('\n')}\n`);
  return { ...rec, ledgerText: () => fs.readFileSync(path.join(rec.dir, 'ledger.jsonl'), 'utf8') };
}

// ---- running the command ------------------------------------------------------------------------

interface Run {
  code: number;
  out: string[];
  err: string[];
  /** stdout and stderr together. */
  all: string;
}

async function pack(argv: string[], hook?: PackDeps['hook']): Promise<Run> {
  const out: string[] = [];
  const err: string[] = [];
  const deps: PackDeps = {
    env: e.env,
    now: () => new Date('2026-11-22T09:30:00.250Z'),
    commit: () => 'abc1234',
    log: (l) => out.push(l),
    error: (l) => err.push(l),
  };
  if (hook) deps.hook = hook;
  const code = await main(argv, deps);
  return { code, out, err, all: [...out, ...err].join('\n') };
}

const OK = ['--devices-ok'];

function setDir(id: string): string {
  return path.join(e.data, id);
}

function namesIn(dir: string): string[] {
  return fs.readdirSync(dir).sort();
}

/** The "mark" lines of stamps.jsonl in a session folder, as the file holds them. */
function markLinesOf(dir: string): string {
  const lines = splitJsonlLines(fs.readFileSync(path.join(dir, 'stamps.jsonl'), 'utf8')).filter((l) => (JSON.parse(l) as { k: string }).k === 'mark');
  return lines.length === 0 ? '' : `${lines.join('\n')}\n`;
}

function readSet(id: string): Record<string, string | null> {
  const out: Record<string, string | null> = {};
  for (const name of namesIn(setDir(id))) out[name] = name === 'audio.wav' ? null : fs.readFileSync(path.join(setDir(id), name), 'utf8');
  return out;
}

/** Nothing of the set and no temporary folder is in data/. */
function expectNothingWritten(id: string): void {
  expect(fs.existsSync(setDir(id))).toBe(false);
  if (fs.existsSync(e.data)) expect(fs.readdirSync(e.data).filter((n) => n.startsWith('.'))).toEqual([]);
}

function lastLedgerLine(text: string): LedgerStepLine {
  const lines = splitJsonlLines(text);
  return JSON.parse(lines[lines.length - 1]!) as LedgerStepLine;
}

function headstart(id = 'headstart-1', o: Partial<RecordingOptions> = {}): Recording {
  return writeRecording({ id, kind: 'headstart', ...o });
}

// ---- tests --------------------------------------------------------------------------------------

describe('pack command line', () => {
  it('parses the flags; --alias repeats and splits at the first "="', () => {
    expect(parsePackArgs(['gate-b', '--devices-ok', '--alias', 'A=B=C', '--alias=X=Y', '--with-audio', 'gate-b', '--replace'])).toEqual({
      id: 'gate-b',
      devicesOk: true,
      aliases: [['A', 'B=C'], ['X', 'Y']],
      withAudio: 'gate-b',
      replace: true,
    });
    expect(parsePackArgs(['headstart-1'])).toEqual({ id: 'headstart-1', devicesOk: false, aliases: [], withAudio: null, replace: false });
  });

  it.each([
    [[], 'the session id is required'],
    [['gate-b', 'gate-c'], 'unexpected argument gate-c'],
    [['gate-b', '--yes'], 'unknown option --yes'],
    [['gate-b', '--with-audio'], '--with-audio needs the session id'],
    [['gate-b', '--with-audio', '--replace'], '--with-audio needs the session id'],
    [['gate-b', '--with-audio', 'gate-b', '--with-audio', 'gate-b'], '--with-audio is given twice'],
    [['gate-b', '--alias'], '--alias needs'],
    [['gate-b', '--alias', 'no equals sign'], 'expected "<system name>=<published name>"'],
    [['gate-b', '--alias', '=Headset'], 'expected "<system name>=<published name>"'],
    [['gate-b', '--alias', 'Mic='], 'expected "<system name>=<published name>"'],
    [['gate-b', '--alias', 'Mic=A', '--alias', 'Mic=B'], 'is given twice'],
    [['gate-b', '--devices-ok=yes'], '--devices-ok takes no value'],
  ])('usage error for %j: exit 2, nothing read or written', async (argv, message) => {
    const r = await pack(argv as string[]);
    expect(r.code).toBe(2);
    expect(r.err.join('\n')).toContain(message);
    expect(r.err.join('\n')).toContain('usage: npm run pack -- <id> --devices-ok');
    expect(r.out).toEqual([]);
    expect(fs.existsSync(e.data)).toBe(false);
  });
});

describe('which records get a set (spec 8.7 as PREREG section 11 amends it)', () => {
  it('gate packs A, B and C and the headstart takes; nothing else', () => {
    for (const p of ['A', 'B', 'C'] as const) expect(whyNoSet('gate', p)).toBeNull();
    expect(whyNoSet('headstart', null)).toBeNull();
    expect(whyNoSet('gate', '0')).toContain('the probe before the gate (pack 0) is a development record');
    expect(whyNoSet('gate', null)).toContain('names no pack A, B or C');
    for (const k of ['doctor', 'smoke', 'live_sim', 'live_from', 'pilot', 'rehearsal'] as const) expect(whyNoSet(k, null)).toContain('is a development record');
    for (const k of ['numbers', 'spacebar', 'demo'] as const) expect(whyNoSet(k, null)).toContain('PREREG section 11 replaced');
  });

  it.each([
    ['gate', '0', 'pack 0'],
    ['gate', null, 'names no pack A, B or C'],
    ['doctor', null, 'a doctor record is a development record'],
    ['smoke', null, 'a smoke record is a development record'],
    ['live_sim', null, 'a live_sim record is a development record'],
    ['live_from', null, 'a live_from record is a development record'],
    ['pilot', null, 'a pilot record is a development record'],
    ['rehearsal', null, 'a rehearsal record is a development record'],
    ['numbers', null, 'PREREG section 11 replaced'],
    ['spacebar', null, 'PREREG section 11 replaced'],
    ['demo', null, 'PREREG section 11 replaced'],
  ] as const)('a %s record (pack %s) is refused with the reason, nothing written', async (kind, p, reason) => {
    writeRecording({ id: 'r1', kind, pack: p });
    const r = await pack(['r1', ...OK]);
    expect(r.code).toBe(1);
    expect(r.err.join('\n')).toContain('pack refused: r1: ');
    expect(r.err.join('\n')).toContain(reason);
    expectNothingWritten('r1');
  });
});

describe('refusals before anything is read or written', () => {
  it.each(['../gate-b', 'gate/b', 'Gate-B', '.', 'gate.b'])('refuses the id %j', async (id) => {
    const r = await pack([id, ...OK]);
    expect(r.code).toBe(1);
    expect(r.err.join('\n')).toContain('is not a session id');
    expect(fs.existsSync(e.data)).toBe(false);
  });

  it('refuses a missing folder, a missing or invalid manifest and one of another session', async () => {
    expect((await pack(['gate-b', ...OK])).err.join('\n')).toContain('no session folder');
    fs.mkdirSync(path.join(e.sessions, 'gate-b'));
    expect((await pack(['gate-b', ...OK])).err.join('\n')).toContain('has no manifest.json');
    fs.writeFileSync(path.join(e.sessions, 'gate-b', 'manifest.json'), '{"schema":"session/1"');
    expect((await pack(['gate-b', ...OK])).err.join('\n')).toContain('manifest.json of gate-b is not valid');
    headstart('headstart-2', { manifest: (m) => ({ ...m, id: 'headstart-9' }) });
    const r = await pack(['headstart-2', ...OK]);
    expect(r.code).toBe(1);
    expect(r.err.join('\n')).toContain('manifest.json names session headstart-9, not headstart-2');
    expect(fs.existsSync(e.data)).toBe(false);
  });

  it.each([
    [{ tap: 'mock', sdk: null }, 'tap: "mock" (the mock tap made up the chest trace)'],
    [{ sdk: null }, 'sdk: null (no SDK ran)'],
    [{ dry: true }, 'dry: true (tap ran its stand-in SDK)'],
  ] as const)('refuses a gate pack or headstart folder that no SDK measured, %j (spec 6.5)', async (change, says) => {
    writeGate({ id: 'gate-a', pack: 'A', stage: 'verdict', manifest: (m) => ({ ...m, ...change }) });
    headstart('headstart-1', { manifest: (m) => ({ ...m, ...change }) });
    for (const id of ['gate-a', 'headstart-1']) {
      const r = await pack([id, ...OK, '--with-audio', id]);
      expect(r.code, id).toBe(1);
      expect(r.err).toEqual([`pack refused: manifest.json of ${id} says ${says}: no SDK measured this folder, so it is no recording and gets no set (spec 6.5)`]);
      expect(r.out).toEqual([]);
      expectNothingWritten(id);
    }
  });

  it('whyNotMeasured, shared with purge: the real tap, or a manifest without tap that names its SDK, is measured', () => {
    const sdk = exampleManifest().sdk;
    expect(whyNotMeasured({ tap: 'real', dry: false, sdk })).toBeNull();
    expect(whyNotMeasured({ sdk })).toBeNull();
    expect(whyNotMeasured({ tap: 'mock', sdk })).toBe('tap: "mock" (the mock tap made up the chest trace)');
    expect(whyNotMeasured({ tap: null, sdk })).toBe('tap: null (not the real tap)');
    expect(whyNotMeasured({ tap: 'real', sdk: null })).toBe('sdk: null (no SDK ran)');
    expect(whyNotMeasured({ tap: 'real', dry: true, sdk })).toBe('dry: true (tap ran its stand-in SDK)');
  });

  it('refuses --with-audio whose value does not repeat the session id, with the confirmation text of spec 8.7', async () => {
    headstart();
    const r = await pack(['headstart-1', ...OK, '--with-audio', 'headstart-2']);
    expect(r.code).toBe(1);
    expect(r.err.join('\n')).toContain('This publishes your voice from session headstart-1. Type the session id to confirm: --with-audio headstart-1');
    expectNothingWritten('headstart-1');
  });

  it('refuses when data/<id>/ exists without --replace, and when it is not a folder even with --replace', async () => {
    headstart();
    fs.mkdirSync(setDir('headstart-1'), { recursive: true });
    fs.writeFileSync(path.join(setDir('headstart-1'), 'manifest.json'), 'old\n');
    let r = await pack(['headstart-1', ...OK]);
    expect(r.code).toBe(1);
    expect(r.err.join('\n')).toContain('exists: add --replace to write the set again');
    expect(namesIn(setDir('headstart-1'))).toEqual(['manifest.json']);
    fs.rmSync(setDir('headstart-1'), { recursive: true });
    fs.writeFileSync(setDir('headstart-1'), 'a file\n');
    r = await pack(['headstart-1', ...OK, '--replace']);
    expect(r.code).toBe(1);
    expect(r.err.join('\n')).toContain('exists and is not a folder');
    expect(fs.readFileSync(setDir('headstart-1'), 'utf8')).toBe('a file\n');
  });
});

describe('device names (spec 8.7)', () => {
  it('without --devices-ok prints every name the manifest holds and writes nothing (exit 1)', async () => {
    headstart();
    const r = await pack(['headstart-1']);
    expect(r.code).toBe(1);
    expect(r.out).toEqual([
      'pack headstart-1: device and machine names as the published manifest.json will hold them (spec 8.7):',
      "  camera.name: Anna's iPhone Camera",
      "  audio.microphone: Anna's AirPods",
      "  audio.output: Anna's AirPods",
      "  audio.settings.label: Anna's AirPods",
      '  machine: MacBook Pro (14-inch, M3)',
    ]);
    expect(r.err.join('\n')).toContain('nothing written: check the names above');
    expect(r.err.join('\n')).toContain('--devices-ok');
    expectNothingWritten('headstart-1');
  });

  it('--alias replaces a name in the published manifest only; device ids and local paths are dropped', async () => {
    const rec = headstart();
    const r = await pack(['headstart-1', ...OK, '--alias', "Anna's AirPods=Headset", '--alias', "Anna's iPhone Camera=Phone camera"]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("  audio.microphone: Anna's AirPods -> Headset (--alias)");
    expect(r.out).toContain("  camera.name: Anna's iPhone Camera -> Phone camera (--alias)");
    const text = fs.readFileSync(path.join(setDir('headstart-1'), 'manifest.json'), 'utf8');
    const pub = JSON.parse(text) as Manifest;
    expect(pub.camera?.name).toBe('Phone camera');
    expect(pub.audio.microphone).toBe('Headset');
    expect(pub.audio.output).toBe('Headset');
    expect(pub.audio.settings).toEqual({ label: 'Headset', sampleRate: 48000 });
    expect(pub.paths).toBeUndefined();
    expect(text.includes('Anna')).toBe(false);
    expect(text.includes('/Users/')).toBe(false);
    expect(pub.files).toEqual(JSON.parse(fs.readFileSync(path.join(rec.dir, 'manifest.json'), 'utf8')).files);
    // The session copy keeps the system names.
    expect(sha256Hex(fs.readFileSync(path.join(rec.dir, 'manifest.json')))).toBe(rec.manifestSha);
  });

  it('refuses an alias that matches no name, after printing the names', async () => {
    headstart();
    const r = await pack(['headstart-1', ...OK, '--alias', 'Annas AirPods=Headset']);
    expect(r.code).toBe(1);
    expect(r.out[0]).toContain('device and machine names');
    expect(r.err.join('\n')).toContain('--alias "Annas AirPods=...": no device or machine name above holds this name');
    expectNothingWritten('headstart-1');
  });

  it('--alias changes the device and machine names only: never the pack letter or the SDK version (an alias found only there is refused)', async () => {
    writeGate({ id: 'gate-b', pack: 'B', stage: 'verdict', manifest: (m) => ({ ...m, camera: { name: 'Cam B', requested: [1280, 720, 30] } }) });
    let r = await pack(['gate-b', ...OK, '--alias', '3.5=4.0']);
    expect(r.code).toBe(1);
    expect(r.err).toEqual([
      'pack refused: --alias "3.5=...": no device or machine name above holds this name, so nothing would be replaced; use the system name exactly as printed above',
    ]);
    expectNothingWritten('gate-b');

    r = await pack(['gate-b', ...OK, '--alias', 'B=C']);
    expect(r.err).toEqual([]);
    expect(r.code).toBe(0);
    // Every name it changes is printed, the machine name too.
    expect(r.out).toContain('  camera.name: Cam B -> Cam C (--alias)');
    expect(r.out).toContain('  machine: MacBook Pro (14-inch, M3) -> MacCook Pro (14-inch, M3) (--alias)');
    const pub = JSON.parse(readSet('gate-b')['manifest.json']!) as Manifest;
    expect(pub.camera?.name).toBe('Cam C');
    expect(pub.machine).toBe('MacCook Pro (14-inch, M3)');
    expect(pub.pack).toBe('B');
    expect(pub.id).toBe('gate-b');
    expect(pub.sdk).toEqual(exampleManifest().sdk);
    expect(pub.audio.microphone).toBe("Anna's AirPods");
    expect(JSON.parse(readSet('gate-b')['verdict.json']!)).toMatchObject({ pack: 'B' });
  });

  it('refuses when a manifest field outside the printed names still holds a name --alias replaces', async () => {
    headstart('headstart-1', { manifest: (m) => ({ ...m, browser: "Chrome 131 with Anna's AirPods" }) });
    let r = await pack(['headstart-1', ...OK, '--alias', "Anna's AirPods=Headset"]);
    expect(r.code).toBe(1);
    expect(r.err).toEqual([
      'pack refused: nothing written: the published manifest.json would still show a name --alias replaces:\n' +
        "  manifest.json browser: holds the system name of audio.microphone, audio.output, audio.settings.label, which --alias replaces only in the device and machine names above",
    ]);
    expectNothingWritten('headstart-1');
    // Without the alias the name is published as printed and confirmed.
    r = await pack(['headstart-1', ...OK]);
    expect(r.code).toBe(0);
  });
});

describe('strings of the set that the manifest keeps private (spec 8.7, PRIVACY.md)', () => {
  const sdkError = (message: string): object => ({ n: 9000000, e: 'sdk_error', code: 5, name: 'kError', message });

  it('refuses a path into a home folder in events.jsonl (an SDK error message), naming file, line and field but not the text', async () => {
    headstart('headstart-1', { events: [...exampleEvents(), sdkError('could not open /Users/someone/copyholder/live/node_modules/x/graph.binarypb')] });
    const r = await pack(['headstart-1', ...OK]);
    expect(r.code).toBe(1);
    expect(r.err).toEqual([
      'pack refused: the set for data/headstart-1/ would publish what the manifest keeps private (spec 8.7, PRIVACY.md); the files are copied as they are, so pack does not rewrite them:\n' +
        '  events.jsonl line 5, message: holds a path into a home folder, which can show the account name',
    ]);
    expect(r.all.includes('someone')).toBe(false);
    expectNothingWritten('headstart-1');
  });

  it('URL paths and web addresses pass, such as page_reload via "/"', async () => {
    headstart('headstart-1', {
      events: [
        ...exampleEvents(),
        { n: null, e: 'page_reload', via: '/' },
        { n: null, e: 'page_reload', via: '/deck/?id=headstart-1' },
        sdkError('fetch http://127.0.0.1:5173/home/x failed'),
      ],
    });
    const r = await pack(['headstart-1', ...OK]);
    expect(r.err).toEqual([]);
    expect(r.code).toBe(0);
  });

  it('refuses a device name that --alias replaces in events.jsonl; a name published as confirmed passes', async () => {
    headstart('headstart-1', { events: [...exampleEvents(), sdkError("camera Anna's iPhone Camera is in use")] });
    let r = await pack(['headstart-1', ...OK, '--alias', "Anna's iPhone Camera=Phone camera"]);
    expect(r.code).toBe(1);
    expect(r.err.join('\n')).toContain('  events.jsonl line 5, message: holds the system name of camera.name, which --alias replaces');
    expectNothingWritten('headstart-1');
    r = await pack(['headstart-1', ...OK]);
    expect(r.code).toBe(0);
    expect(JSON.parse(readSet('headstart-1')['manifest.json']!).camera.name).toBe("Anna's iPhone Camera");
  });

  it('holdsHomePath: home folders, ~/ and drive letters; not URL paths, web addresses or times', () => {
    for (const s of ['/Users/anna/x', 'at /home/anna/x', 'C:\\Users\\anna\\x', 'D:/data/x', 'see ~/Library/x', '(E:\\x)', 'file:///Users/anna/x']) {
      expect(holdsHomePath(s), s).toBe(true);
    }
    for (const s of ['/', '/deck/', 'http://127.0.0.1:5173/home/x', 'https://example.org/Users/x', 'wss://localhost/home/', '4:15', 'a:b', 'ratio 1:2/3', 'kError']) {
      expect(holdsHomePath(s), s).toBe(false);
    }
  });
});

describe('a headstart take (a demo take of PREREG section 11)', () => {
  it('writes the set of spec 8.7 and nothing else; no ledger', async () => {
    const rec = headstart();
    const r = await pack(['headstart-1', ...OK]);
    expect(r.err).toEqual([]);
    expect(r.code).toBe(0);
    expect(namesIn(setDir('headstart-1'))).toEqual(['audio_env.json', 'calib.json', 'events.jsonl', 'manifest.json', 'stream.jsonl']);
    const set = readSet('headstart-1');
    expect(validatePublishedFolder(set)).toEqual([]);
    expect(set['stream.jsonl']).toBe(toJsonlText(STREAM, 'stream.jsonl'));
    expect(fs.readFileSync(path.join(setDir('headstart-1'), 'events.jsonl'))).toEqual(fs.readFileSync(path.join(rec.dir, 'events.jsonl')));
    expect(fs.readFileSync(path.join(setDir('headstart-1'), 'calib.json'))).toEqual(fs.readFileSync(path.join(rec.dir, 'calib.json')));
    expect(fs.existsSync(path.join(rec.dir, 'ledger.jsonl'))).toBe(false);
    expect(r.out).toContain('ledger: none, a headstart take has no step journal (spec 8.5)');
    expect(r.out[r.out.length - 1]).toBe(`next: git add ${setDir('headstart-1')}`);
    // Files with sizes.
    const size = fs.statSync(path.join(setDir('headstart-1'), 'stream.jsonl')).size;
    expect(r.out.some((l) => /^ {2}stream\.jsonl +[\d,]+ bytes$/.test(l) && l.includes(size.toLocaleString('en-US')))).toBe(true);
    expect(r.out.some((l) => l.startsWith(`pack: wrote ${setDir('headstart-1')}/ (5 files, `))).toBe(true);
    // No word of a text, no log line, no raw data in the output or the set.
    expect(r.all.includes(SECRET)).toBe(false);
    for (const text of Object.values(set)) expect(text?.includes(SECRET)).toBe(false);
  });

  it('audio_env.json: the level of both channels every 10 ms on a WAV with known levels', async () => {
    headstart();
    expect((await pack(['headstart-1', ...OK])).code).toBe(0);
    const env = JSON.parse(fs.readFileSync(path.join(setDir('headstart-1'), 'audio_env.json'), 'utf8'));
    expect(validateAudioEnv(env)).toEqual([]);
    const a = knownAudio();
    expect(env).toEqual({ schema: 'audio-env/1', step_ms: 10, mic_db: a.mic, narrator_db: a.narrator });
  });

  it('--with-audio adds audio.wav: both channels as 16-bit PCM at 48 kHz (spec 8.7)', async () => {
    const rec = headstart();
    const r = await pack(['headstart-1', ...OK, '--with-audio', 'headstart-1']);
    expect(r.code).toBe(0);
    expect(namesIn(setDir('headstart-1'))).toContain('audio.wav');
    expect(validatePublishedFolder(readSet('headstart-1'), { audio: true })).toEqual([]);
    const file = path.join(setDir('headstart-1'), 'audio.wav');
    const h = readWavHeader(file);
    expect(checkWavFormat('published', h)).toEqual([]);
    expect(h.dataBytes).toBe((4 * STEP + 100) * 4);
    const pcm = fs.readFileSync(file).subarray(h.dataOffset);
    const a = knownAudio();
    for (const i of [0, 1, 2 * STEP, 3 * STEP + 1, 4 * STEP, 4 * STEP + 1]) {
      expect(pcm.readInt16LE(4 * i), `ch0 frame ${i}`).toBe(Math.max(-32768, Math.min(32767, Math.round(a.ch0[i]! * 32768))));
      expect(pcm.readInt16LE(4 * i + 2), `ch1 frame ${i}`).toBe(Math.max(-32768, Math.min(32767, Math.round(a.ch1[i]! * 32768))));
    }
    // +1.0 is one step beyond 16 bit: the 50 such samples of the last step are clipped and counted.
    expect(r.out).toContain('note: audio.wav: 50 samples were outside the 16-bit range and clipped in the copy');
    expect(r.out.some((l) => l.includes('holds your voice'))).toBe(true);
    // The session audio stays as it was.
    expect(sha256Hex(fs.readFileSync(path.join(rec.dir, 'audio.wav')))).toBe(rec.hashes['audio.wav']);
  });

  it('refuses a recording file that changed after the recording closed (manifest.json hashes)', async () => {
    const rec = headstart();
    fs.appendFileSync(path.join(rec.dir, 'events.jsonl'), '{"n":9000000,"e":"armed","det":"D1","on":false}\n');
    const r = await pack(['headstart-1', ...OK]);
    expect(r.code).toBe(1);
    expect(r.err.join('\n')).toContain('events.jsonl changed after the recording closed');
    expectNothingWritten('headstart-1');
  });

  it('refuses a recording file that manifest.json did not hash, and a missing one', async () => {
    headstart('headstart-1', { manifest: (m) => ({ ...m, files: Object.fromEntries(Object.entries(m.files).filter(([k]) => k !== 'stamps.jsonl')) }) });
    let r = await pack(['headstart-1', ...OK]);
    expect(r.code).toBe(1);
    expect(r.err.join('\n')).toContain('stamps.jsonl is not among the files manifest.json hashed');
    const other = headstart('headstart-2');
    fs.rmSync(path.join(other.dir, 'events.jsonl'));
    r = await pack(['headstart-2', ...OK]);
    expect(r.code).toBe(1);
    expect(r.err.join('\n')).toContain('events.jsonl is missing (manifest.json holds its hash)');
    expect(fs.existsSync(e.data)).toBe(false);
  });

  it('a take that did not close: no hashes to check, a partial last line of events.jsonl is dropped', async () => {
    const rec = headstart('headstart-1', { hashFiles: false });
    fs.appendFileSync(path.join(rec.dir, 'events.jsonl'), '{"n":9000000,"e":"ar');
    const r = await pack(['headstart-1', ...OK]);
    expect(r.code).toBe(0);
    expect(r.out.some((l) => l.includes('manifest.json holds no file hashes'))).toBe(true);
    expect(r.out.some((l) => l.includes('events.jsonl line 5: partial last line dropped'))).toBe(true);
    expect(fs.readFileSync(path.join(setDir('headstart-1'), 'events.jsonl'), 'utf8')).toBe(toJsonlText(exampleEvents(), 'events.jsonl'));
  });

  it('refuses a set that would not be valid: a broken copy, a link, detector_in.jsonl without stamps.jsonl', async () => {
    const a = headstart('headstart-1', { hashFiles: false });
    fs.writeFileSync(path.join(a.dir, 'calib.json'), '{"schema":"calib/1","L_rt_ms":"none"}\n');
    let r = await pack(['headstart-1', ...OK]);
    expect(r.code).toBe(1);
    expect(r.err.join('\n')).toContain('the set for data/headstart-1/ would not be valid (spec 8.7)');
    expect(r.err.join('\n')).toContain('calib.json');

    const b = headstart('headstart-2', { hashFiles: false });
    fs.rmSync(path.join(b.dir, 'stamps.jsonl'));
    r = await pack(['headstart-2', ...OK]);
    expect(r.code).toBe(1);
    expect(r.err.join('\n')).toContain('stamps.jsonl is missing: stream.jsonl takes nArr from its arr stamps');

    const c = headstart('headstart-3', { hashFiles: false });
    fs.rmSync(path.join(c.dir, 'calib.json'));
    fs.symlinkSync(path.join(a.dir, 'calib.json'), path.join(c.dir, 'calib.json'));
    r = await pack(['headstart-3', ...OK]);
    expect(r.code).toBe(1);
    expect(r.err.join('\n')).toContain('calib.json in');
    expect(r.err.join('\n')).toContain('is a link');
    expect(fs.existsSync(e.data)).toBe(false);
  });

  it('refuses a detector_in.jsonl with a broken line, notes packets after Deck stopped', async () => {
    const a = headstart('headstart-1', { hashFiles: false });
    const lines = toJsonlText(DETECTOR_IN, 'detector_in.jsonl').split('\n');
    lines[1] = '{"k":"val","seq":2';
    fs.writeFileSync(path.join(a.dir, 'detector_in.jsonl'), lines.join('\n'));
    let r = await pack(['headstart-1', ...OK]);
    expect(r.code).toBe(1);
    expect(r.err.join('\n')).toContain('stream.jsonl cannot be built');
    expect(r.err.join('\n')).toContain('detector_in.jsonl line 2');

    const b = headstart('headstart-2', { hashFiles: false });
    fs.appendFileSync(path.join(b.dir, 'detector_in.jsonl'), `${JSON.stringify({ k: 'batch', seq: 4, tr: [[T0 + 66_666, -0.3]], talk: [[T0 + 66_666, 0]], g: null, hm: null })}\n`);
    r = await pack(['headstart-2', ...OK]);
    expect(r.code).toBe(0);
    expect(r.out).toContain('note: stream.jsonl: the last packet has no arr stamp (Deck had stopped), so nArr is null there');
    const stream = fs.readFileSync(path.join(setDir('headstart-2'), 'stream.jsonl'), 'utf8').trim().split('\n');
    expect(JSON.parse(stream[stream.length - 1]!)).toMatchObject({ k: 'batch', seq: 4, nArr: null });
  });

  it('refuses audio.wav that is missing, in another format or damaged', async () => {
    const a = headstart('headstart-1', { hashFiles: false });
    fs.rmSync(path.join(a.dir, 'audio.wav'));
    let r = await pack(['headstart-1', ...OK]);
    expect(r.err.join('\n')).toContain('audio.wav is missing');

    const b = headstart('headstart-2', { hashFiles: false });
    fs.writeFileSync(path.join(b.dir, 'audio.wav'), encodeStereoFloatWav(new Float32Array(10), new Float32Array(10), { sampleRateHz: 44_100 }));
    r = await pack(['headstart-2', ...OK]);
    expect(r.code).toBe(1);
    expect(r.err.join('\n')).toContain('audio.wav is not in the session format');
    expect(r.err.join('\n')).toContain('expected 48000 Hz, got 44100');

    const c = headstart('headstart-3', { hashFiles: false });
    const ch0 = new Float32Array(3 * STEP);
    ch0[STEP + 7] = Number.NaN;
    fs.writeFileSync(path.join(c.dir, 'audio.wav'), encodeStereoFloatWav(ch0, new Float32Array(3 * STEP)));
    r = await pack(['headstart-3', ...OK]);
    expect(r.code).toBe(1);
    expect(r.err.join('\n')).toContain('not finite numbers in the 10 ms from 10 ms');

    const d = headstart('headstart-4', { hashFiles: false });
    fs.renameSync(path.join(d.dir, 'audio.wav'), path.join(e.root, 'audio.wav'));
    fs.symlinkSync(path.join(e.root, 'audio.wav'), path.join(d.dir, 'audio.wav'));
    r = await pack(['headstart-4', ...OK]);
    expect(r.code).toBe(1);
    expect(r.err.join('\n')).toContain('audio.wav is not a plain file');
    expect(fs.existsSync(e.data)).toBe(false);
  });
});

describe('audio_env.json numbers (analysis/pack/audio.ts)', () => {
  it('levelDb: 10 log10 of the mean square, rounded to 0.1, floor -90', () => {
    expect(levelDb(0.01 * 480, 480)).toBe(-20);
    expect(levelDb(0.25 * 10, 10)).toBe(-6);
    expect(levelDb(0, 480)).toBe(SILENCE_DB);
    expect(levelDb(1e-12 * 480, 480)).toBe(-90);
    expect(levelDb(1e-9, 1)).toBe(-90);
    expect(levelDb(1.0000001e-9 * 480, 480)).toBe(-90);
    expect(levelDb(2 * 480, 480)).toBe(3);
    expect(levelDb(0, 0)).toBe(-90);
  });

  it('with endFrame the levels and the 16-bit copy stop before that frame; the hash still covers the whole file', () => {
    const dir = fs.mkdtempSync(path.join(e.root, 'wav-'));
    const a = knownAudio();
    const file = path.join(dir, 'audio.wav');
    fs.writeFileSync(file, encodeStereoFloatWav(a.ch0, a.ch1));
    const r = readSessionAudio(file, { pcm16: true, endFrame: 1500 });
    expect(r.frames).toBe(4 * STEP + 100);
    expect(r.usedFrames).toBe(1500);
    expect(r.env.mic_db).toEqual([-20, -90, -90, -6]);
    expect(r.env.narrator_db).toEqual([-12, -26, -17, -90]);
    expect(r.pcm16!.length).toBe(44 + 1500 * 4);
    expect(r.pcm16!.readUInt32LE(40)).toBe(1500 * 4);
    // The full-scale samples of the last step lie after the cut: nothing is clipped.
    expect(r.clipped).toBe(0);
    expect(r.sha256).toBe(sha256Hex(fs.readFileSync(file)));
    expect(readSessionAudio(file, { pcm16: false, endFrame: 0 }).env.mic_db).toEqual([]);
    expect(readSessionAudio(file, { pcm16: false, endFrame: 1e9 }).usedFrames).toBe(4 * STEP + 100);
  });

  it('reads a recording that did not close up to the audio present, and hashes the whole file', () => {
    const dir = fs.mkdtempSync(path.join(e.root, 'wav-'));
    const a = knownAudio();
    const bytes = encodeStereoFloatWav(a.ch0, a.ch1, { headerDataBytes: 0 });
    const file = path.join(dir, 'audio.wav');
    fs.writeFileSync(file, Buffer.concat([bytes, Buffer.from([1, 2, 3])]));
    const r = readSessionAudio(file, { pcm16: false });
    expect(r.env.mic_db).toEqual(a.mic);
    expect(r.env.narrator_db).toEqual(a.narrator);
    expect(r.frames).toBe(4 * STEP + 100);
    expect(r.lengthNote).toContain('crash before close');
    expect(r.sha256).toBe(sha256Hex(fs.readFileSync(file)));
    expect(r.pcm16).toBeNull();
  });
});

describe('a gate recording whose verdict is in the ledger', () => {
  it('writes the set with verdict.md and verdict.json and appends the pack step with the SHA-256 of every file', async () => {
    const g = writeGate({ id: 'gate-b', pack: 'B', stage: 'verdict' });
    const before = g.ledgerText();
    const r = await pack(['gate-b', ...OK, '--alias', "Anna's AirPods=Headset", '--alias', "Anna's iPhone Camera=Phone camera"]);
    expect(r.err).toEqual([]);
    expect(r.code).toBe(0);
    expect(namesIn(setDir('gate-b'))).toEqual([
      'audio_env.json', 'calib.json', 'clock_report.json', 'events.jsonl', 'g_resets.json', 'manifest.json', 'marks.jsonl', 'onsets.json', 'stream.jsonl',
      'verdict.json', 'verdict.md',
    ]);
    const set = readSet('gate-b');
    expect(validatePublishedFolder(set)).toEqual([]);
    // What npm run replay needs: the mark lines of stamps.jsonl as they are, and the packets stage B
    // reads as reset frames of G (packet 3 has g null and no line in samples.jsonl).
    expect(set['marks.jsonl']).toBe(markLinesOf(g.dir));
    expect(set['g_resets.json']).toBe('{"schema":"g-resets/1","seqs":[3]}\n');
    for (const name of ['events.jsonl', 'onsets.json', 'calib.json', 'clock_report.json', 'verdict.md', 'verdict.json']) {
      expect(fs.readFileSync(path.join(setDir('gate-b'), name)), name).toEqual(fs.readFileSync(path.join(g.dir, name)));
    }
    // The ledger: one new line, a confirmatory pack step, chain intact.
    const after = g.ledgerText();
    expect(after.startsWith(before)).toBe(true);
    expect(splitJsonlLines(after).length).toBe(splitJsonlLines(before).length + 1);
    expect(verifyLedgerText(after, (t) => sha256Hex(t), { kind: 'gate' }).ok).toBe(true);
    const line = lastLedgerLine(after);
    expect(line.step).toBe('pack');
    expect(line.exploratory).toBe(false);
    expect(line.utc).toBe('2026-11-22T09:30:00Z');
    expect(line.commit).toBe('abc1234');
    const expected: Record<string, string> = {};
    for (const name of namesIn(setDir('gate-b'))) expected[`data/gate-b/${name}`] = sha256Hex(fs.readFileSync(path.join(setDir('gate-b'), name)));
    expect(line.out_sha256).toEqual(expected);
    expect(r.out).toContain('ledger: step pack appended to ledger.jsonl of gate-b with the SHA-256 of each file');
    // Never a word of a text: verdict.md is copied, not printed.
    expect(r.all.includes(SECRET)).toBe(false);
  });

  it('--replace writes the set again, swapped in whole, and appends a second pack step', async () => {
    const g = writeGate({ id: 'gate-b', pack: 'B', stage: 'verdict' });
    expect((await pack(['gate-b', ...OK])).code).toBe(0);
    const first = fs.readFileSync(path.join(setDir('gate-b'), 'manifest.json'), 'utf8');
    fs.writeFileSync(path.join(setDir('gate-b'), 'stray.txt'), 'left from an older set\n');
    const r = await pack(['gate-b', ...OK, '--replace', '--alias', "Anna's AirPods=Headset", '--with-audio', 'gate-b']);
    expect(r.code).toBe(0);
    expect(r.out.some((l) => l.includes('replacing the set that was there'))).toBe(true);
    const second = fs.readFileSync(path.join(setDir('gate-b'), 'manifest.json'), 'utf8');
    expect(second).not.toBe(first);
    expect(second.includes("Anna's AirPods")).toBe(false);
    expect(namesIn(setDir('gate-b'))).not.toContain('stray.txt');
    expect(namesIn(setDir('gate-b'))).toContain('audio.wav');
    const records = splitJsonlLines(g.ledgerText()).map((l) => JSON.parse(l) as LedgerStepLine);
    expect(records.filter((x) => x.step === 'pack')).toHaveLength(2);
    expect(verifyLedgerText(g.ledgerText(), (t) => sha256Hex(t), { kind: 'gate' }).ok).toBe(true);
    expect(lastLedgerLine(g.ledgerText()).out_sha256['data/gate-b/audio.wav']).toBe(sha256Hex(fs.readFileSync(path.join(setDir('gate-b'), 'audio.wav'))));
    expect(fs.readdirSync(e.data)).toEqual(['gate-b']);
  });

  it('refuses a file that changed after the step that wrote it', async () => {
    const g = writeGate({ id: 'gate-b', pack: 'B', stage: 'verdict' });
    fs.appendFileSync(path.join(g.dir, 'verdict.md'), 'edited\n');
    const before = g.ledgerText();
    const r = await pack(['gate-b', ...OK]);
    expect(r.code).toBe(1);
    expect(r.err.join('\n')).toContain('verdict.md changed after step verdict wrote it');
    expect(g.ledgerText()).toBe(before);
    expectNothingWritten('gate-b');
  });

  it('refuses a manifest.json that changed after the record step', async () => {
    const g = writeGate({ id: 'gate-c', pack: 'C', stage: 'verdict' });
    const m = JSON.parse(fs.readFileSync(path.join(g.dir, 'manifest.json'), 'utf8')) as Manifest;
    fs.writeFileSync(path.join(g.dir, 'manifest.json'), toJsonText({ ...m, machine: 'other' }, 'manifest.json', 2));
    const r = await pack(['gate-c', ...OK]);
    expect(r.code).toBe(1);
    expect(r.err.join('\n')).toContain('manifest.json changed after step record wrote it');
    expectNothingWritten('gate-c');
  });
});

describe('a gate recording without a verdict', () => {
  it('refuses a record without a ledger, a broken ledger and one without its quickcheck step', async () => {
    writeGate({ id: 'gate-a', pack: 'A', stage: 'record' });
    let r = await pack(['gate-a', ...OK]);
    expect(r.code).toBe(1);
    expect(r.err.join('\n')).toContain('has no quickcheck step');

    const b = writeGate({ id: 'gate-b', pack: 'B', stage: 'verdict' });
    const lines = splitJsonlLines(b.ledgerText());
    lines[2] = lines[2]!.replace('"commit":"1234abc"', '"commit":"5678def"');
    fs.writeFileSync(path.join(b.dir, 'ledger.jsonl'), `${lines.join('\n')}\n`);
    r = await pack(['gate-b', ...OK]);
    expect(r.code).toBe(1);
    expect(r.err.join('\n')).toContain('ledger.jsonl of gate-b is broken');

    const c = writeGate({ id: 'gate-c', pack: 'C', stage: 'verdict' });
    fs.rmSync(path.join(c.dir, 'ledger.jsonl'));
    r = await pack(['gate-c', ...OK]);
    expect(r.code).toBe(1);
    expect(r.err.join('\n')).toContain('gate-c has no ledger.jsonl');
    expect(fs.existsSync(e.data)).toBe(false);
  });

  it('refuses a recording that counts but has no verdict yet: pack is the last step (PREREG section 7.5)', async () => {
    writeGate({ id: 'gate-b', pack: 'B', stage: 'clocks' });
    let r = await pack(['gate-b', ...OK]);
    expect(r.code).toBe(1);
    expect(r.err.join('\n')).toContain('gate-b has no verdict yet and nothing says it does not count');
    expect(r.err.join('\n')).toContain('run label and analyze:gate');
    writeGate({ id: 'gate-c', pack: 'C', stage: 'quickcheck' });
    r = await pack(['gate-c', ...OK]);
    expect(r.err.join('\n')).toContain('run clocks, label and analyze:gate');
    expect(fs.existsSync(e.data)).toBe(false);
  });

  it('pack B, quickcheck condition 6 alone: the whole set, no ledger line; part B stays, as stage A tunes nothing on B and C (PREREG section 11)', async () => {
    const g = writeGate({ id: 'gate-b', pack: 'B', stage: 'quickcheck', quickcheck: 'condition6' });
    const before = g.ledgerText();
    const r = await pack(['gate-b', ...OK]);
    expect(r.err).toEqual([]);
    expect(r.code).toBe(0);
    expect(g.ledgerText()).toBe(before);
    expect(r.out.filter((l) => l.startsWith('ledger: '))).toEqual([
      'ledger: no pack step: gate-b never reached its verdict: quickcheck.json says RE-RECORD NOW: voice after 10 of 14 cues (need 12). Quickcheck failed on condition 6 alone (voice after fewer than 12 cues), which is not technical: stage A and stage B do not score such a recording, and PREREG section 11 keeps a pack B with fewer than 12 valid objections in the pooled numbers, flagged.',
    ]);
    expect(r.out).toContain(
      'note: part B, the objection block, is published without a stage A line in ledger.jsonl: on packs B and C stage A tunes nothing, as PREREG section 11 freezes the parameters under the tag gate-retune before pack B is recorded, and its numbers enter the pooled ones',
    );
    // No verdict files in such a set; the rest as for any record, after the step mark too.
    expect(namesIn(setDir('gate-b'))).toEqual(['audio_env.json', 'calib.json', 'events.jsonl', 'g_resets.json', 'manifest.json', 'marks.jsonl', 'stream.jsonl']);
    const set = readSet('gate-b');
    expect(validatePublishedFolder(set)).toEqual([]);
    expect(set['stream.jsonl']).toBe(toJsonlText(STREAM, 'stream.jsonl'));
    expect(set['marks.jsonl']).toBe(markLinesOf(g.dir));
    expect(set['g_resets.json']).toBe('{"schema":"g-resets/1","seqs":[3]}\n');
    expect(JSON.parse(set['audio_env.json']!)).toMatchObject({ mic_db: knownAudio().mic });
  });

  it('pack C, a technical failure after the objection block began: lost; the set is written without a ledger line', async () => {
    const report: ClockReport = { ...exampleClockReport(), trace_valid: false, hard: { ...exampleClockReport().hard, trace_rate_median: 12 } };
    const g = writeGate({ id: 'gate-c', pack: 'C', stage: 'clocks', quickcheck: 'technical', clockReport: report });
    const before = g.ledgerText();
    const r = await pack(['gate-c', ...OK]);
    expect(r.code).toBe(0);
    expect(g.ledgerText()).toBe(before);
    expect(r.out.filter((l) => l.startsWith('ledger: '))).toEqual([
      'ledger: no pack step: gate-c never reached its verdict: quickcheck.json says RE-RECORD NOW: trace rate 12.0 per second (need 25). The failure is technical and came after the objection block began (4:15): pack C is lost, reported with its reason and not replaced (PREREG section 11).',
    ]);
    expect(r.out).toContain(
      'note: part B, the objection block, is published without a stage A line in ledger.jsonl: on packs B and C stage A tunes nothing, as PREREG section 11 freezes the parameters under the tag gate-retune before pack B is recorded',
    );
    expect(namesIn(setDir('gate-c'))).toEqual([
      'audio_env.json', 'calib.json', 'clock_report.json', 'events.jsonl', 'g_resets.json', 'manifest.json', 'marks.jsonl', 'stream.jsonl',
    ]);
  });

  it.each([
    [
      'A',
      'The failure is technical. Remove the cause, repeat pack 0 until it says GOOD RECORDING, then record pack A again: the recording broke off before the objection block (4:15), so its errors were not heard (spec 9.4). A technical failure with no detector computed does not spend the one re-record for content (spec 9.4).',
    ],
    [
      'B',
      'The failure is technical and came before the objection block (4:15): pack B is recorded again, unless the SDK ended the recording with kCreditExhausted, which loses it (PREREG section 11).',
    ],
  ] as const)('pack %s, a technical failure before the objection block: the whole set without a ledger line, and what comes next', async (p, next) => {
    const id = `gate-${p.toLowerCase()}`;
    const g = writeGate({ id, pack: p, stage: 'quickcheck', quickcheck: 'technical', objectionsReached: false });
    const before = g.ledgerText();
    const r = await pack([id, ...OK]);
    expect(r.code).toBe(0);
    expect(g.ledgerText()).toBe(before);
    expect(r.out.filter((l) => l.startsWith('ledger: '))).toEqual([
      `ledger: no pack step: ${id} never reached its verdict: quickcheck.json says RE-RECORD NOW: trace rate 12.0 per second (need 25). ${next}`,
    ]);
    // No objection block was heard, so there is no part B to hold back.
    expect(r.out.some((l) => l.includes('part B'))).toBe(false);
    expect(readSet(id)['stream.jsonl']).toBe(toJsonlText(STREAM, 'stream.jsonl'));
  });

  // PREREG.md section 11: "A recording that the SDK ends with kCreditExhausted is lost, reported with
  // its reason and not replaced", before 4:15 too: pack says what quickcheck and analyze:gate say
  // (analysis/gate/inputs.ts nextRecordingAdvice), not "record pack A again".
  it('pack A, the SDK ended the recording with kCreditExhausted before 4:15: lost and not replaced, in the words of analyze:gate', async () => {
    const credit = { n: null, e: 'sdk_error', by: 'host', code: 4, name: 'kCreditExhausted', message: 'The credits are used up.' };
    const g = writeGate({ id: 'gate-a', pack: 'A', stage: 'quickcheck', quickcheck: 'technical', objectionsReached: false, events: [...exampleEvents(), credit] });
    const before = g.ledgerText();
    const r = await pack(['gate-a', ...OK]);
    expect(r.code).toBe(0);
    expect(g.ledgerText()).toBe(before);
    const advice = nextRecordingAdvice({ technical: true, pack: 'A', objectionsReached: false, detectorComputed: false, creditsUsedUp: true });
    expect(advice).toBe(
      'The SDK ended the recording with kCreditExhausted, so its credits are used up: pack A is lost, reported with its reason and not replaced (PREREG.md section 11). Packs B, then C need credits too, so none can be recorded until the SDK has credits again.',
    );
    expect(r.out.filter((l) => l.startsWith('ledger: '))).toEqual([
      `ledger: no pack step: gate-a never reached its verdict: quickcheck.json says RE-RECORD NOW: trace rate 12.0 per second (need 25). ${advice}`,
    ]);
    expect(r.all).not.toMatch(/record pack A again|does not spend/);
  });

  /** events.jsonl around the step mark of the objection block (n 1500 in stampsOf). */
  const EVENTS_AROUND_MARK = [
    { n: null, e: 'consent' },
    { n: 1200, e: 'armed', det: 'D1', on: true },
    { n: 1500, e: 'armed', det: 'D1', on: false },
    { n: 1700, e: 'fire', det: 'D1', seq: 3, v: 2.3125, theta: 1.875 },
    { n: null, e: 'page_lost' },
  ];

  it('pack A, a technical failure after 4:15: part B is held back, so the set ends at the step mark of the objection block (PREREG section 7.5)', async () => {
    const report: ClockReport = { ...exampleClockReport(), trace_valid: false, hard: { ...exampleClockReport().hard, trace_rate_median: 12 } };
    const g = writeGate({ id: 'gate-a', pack: 'A', stage: 'label', quickcheck: 'technical', clockReport: report, events: EVENTS_AROUND_MARK });
    const before = g.ledgerText();
    const r = await pack(['gate-a', ...OK, '--with-audio', 'gate-a']);
    expect(r.err).toEqual([]);
    expect(r.code).toBe(0);
    expect(g.ledgerText()).toBe(before);
    expect(r.out.filter((l) => l.startsWith('ledger: '))).toEqual([
      'ledger: no pack step: gate-a never reached its verdict: quickcheck.json says RE-RECORD NOW: trace rate 12.0 per second (need 25). The failure is technical. Remove the cause, repeat pack 0 until it says GOOD RECORDING, then record the next unused pack (B, then C): the objection block (from 4:15) was heard, so pack A cannot be recorded again (spec 9.4). A technical failure with no detector computed does not spend the one re-record for content (spec 9.4).',
    ]);
    expect(r.out).toContain(
      'note: part B, the objection block from sample 1,500 (4:15) on, is held back: pack releases it only after the stage A hash is in ledger.jsonl, and this recording never gets one (PREREG section 7.5). The set ends at that step mark; onsets.json, which times the replies of the objection block, is left out',
    );
    // onsets.json is in the session folder, but not in the set.
    expect(fs.existsSync(path.join(g.dir, 'onsets.json'))).toBe(true);
    expect(namesIn(setDir('gate-a'))).toEqual([
      'audio.wav', 'audio_env.json', 'calib.json', 'clock_report.json', 'events.jsonl', 'g_resets.json', 'manifest.json', 'marks.jsonl', 'stream.jsonl',
    ]);
    const set = readSet('gate-a');
    expect(validatePublishedFolder(set, { audio: true })).toEqual([]);
    // stream.jsonl: the three packets that arrived before n 1500; the voice and state lines at 1700 are out.
    expect(set['stream.jsonl']).toBe(toJsonlText(STREAM.slice(0, 3), 'stream.jsonl'));
    // marks.jsonl: the marks before n 1500, as stage A reads them; the step mark of the block is at 1500.
    expect(set['marks.jsonl']).toBe('');
    // g_resets.json: packet 3 arrived at n 1200, before the cut.
    expect(set['g_resets.json']).toBe('{"schema":"g-resets/1","seqs":[3]}\n');
    // events.jsonl: lines before the mark; a line without n stays only before the first line after it.
    expect(set['events.jsonl']).toBe(toJsonlText(EVENTS_AROUND_MARK.slice(0, 2), 'events.jsonl'));
    // audio_env.json: 1500 frames, three full steps and 60 frames of the fourth.
    expect(JSON.parse(set['audio_env.json']!)).toEqual({ schema: 'audio-env/1', step_ms: 10, mic_db: [-20, -90, -90, -6], narrator_db: [-12, -26, -17, -90] });
    const h = readWavHeader(path.join(setDir('gate-a'), 'audio.wav'));
    expect(h.dataBytes).toBe(1500 * 4);
    // The session folder keeps the whole recording.
    expect(sha256Hex(fs.readFileSync(path.join(g.dir, 'audio.wav')))).toBe(g.hashes['audio.wav']);
  });

  it('pack A after 4:15 with a gap in the audio: the cut falls on the frame of audio.wav that the step mark maps to', async () => {
    // 1000 frames from n 0, a gap, then 1020 frames from n 2000: the mark at n 2500 is frame 1500.
    const stamps = [
      { n: 0, k: 'chunk', frames: 1000 },
      { n: 600, k: 'arr', seq: 1 },
      { n: 900, k: 'arr', seq: 2 },
      { n: 1200, k: 'arr', seq: 3 },
      { n: 2000, k: 'chunk', frames: 4 * STEP + 100 - 1000 },
      { n: 2500, k: 'mark', what: 'step', name: gateSteps('A').objections },
    ];
    writeGate({ id: 'gate-a', pack: 'A', stage: 'quickcheck', quickcheck: 'technical', stamps });
    const r = await pack(['gate-a', ...OK, '--with-audio', 'gate-a']);
    expect(r.code).toBe(0);
    expect(r.out.some((l) => l.startsWith('note: part B, the objection block from sample 2,500 (4:15) on, is held back'))).toBe(true);
    const set = readSet('gate-a');
    expect(JSON.parse(set['audio_env.json']!)).toMatchObject({ mic_db: [-20, -90, -90, -6], narrator_db: [-12, -26, -17, -90] });
    expect(readWavHeader(path.join(setDir('gate-a'), 'audio.wav')).dataBytes).toBe(1500 * 4);
    // The voice and state lines at n 1700 lie before the mark here.
    expect(set['stream.jsonl']).toBe(toJsonlText(STREAM, 'stream.jsonl'));
  });

  it('pack A, quickcheck condition 6 alone: part B is held back too, and the next pack is the one re-record for content', async () => {
    const g = writeGate({ id: 'gate-a', pack: 'A', stage: 'quickcheck', quickcheck: 'condition6' });
    const r = await pack(['gate-a', ...OK]);
    expect(r.code).toBe(0);
    expect(r.out.filter((l) => l.startsWith('ledger: '))).toEqual([
      'ledger: no pack step: gate-a never reached its verdict: quickcheck.json says RE-RECORD NOW: voice after 10 of 14 cues (need 12). Quickcheck marks the failure as not technical (fewer than 12 replies, spec 9.4): record the next unused pack (B, then C), which is the one re-record for content (spec 9.6).',
    ]);
    expect(r.out.some((l) => l.startsWith('note: part B, the objection block from sample 1,500 (4:15) on, is held back'))).toBe(true);
    expect(readSet('gate-a')['stream.jsonl']).toBe(toJsonlText(STREAM.slice(0, 3), 'stream.jsonl'));
    expect(splitJsonlLines(readSet('gate-a')['events.jsonl']!)).toEqual([]);
    expect(g.ledgerText().includes('"step":"pack"')).toBe(false);
  });

  it('pack A with the stage A hash in the ledger: part B may be released, so the set is whole', async () => {
    writeGate({ id: 'gate-a', pack: 'A', stage: 'stage_a', quickcheck: 'condition6' });
    const r = await pack(['gate-a', ...OK]);
    expect(r.code).toBe(0);
    expect(r.out.some((l) => l.includes('part B'))).toBe(false);
    expect(namesIn(setDir('gate-a'))).toContain('onsets.json');
    expect(readSet('gate-a')['stream.jsonl']).toBe(toJsonlText(STREAM, 'stream.jsonl'));
  });

  it('refuses when quickcheck.json is missing or not valid', async () => {
    const g = writeGate({ id: 'gate-b', pack: 'B', stage: 'quickcheck', quickcheck: 'condition6' });
    fs.rmSync(path.join(g.dir, 'quickcheck.json'));
    let r = await pack(['gate-b', ...OK]);
    expect(r.code).toBe(1);
    expect(r.err.join('\n')).toContain('gate-b has no quickcheck.json, so pack cannot tell whether the recording counts');

    // A file the ledger holds, but not a quickcheck report: refused, not guessed at.
    const h = writeGate({ id: 'gate-c', pack: 'C', stage: 'record' });
    const bad = '{"schema":"quickcheck/1"}\n';
    fs.writeFileSync(path.join(h.dir, 'quickcheck.json'), bad);
    const lines = splitJsonlLines(h.ledgerText());
    lines.push(appendLedger(lines, 'quickcheck', { utc: '2026-11-21T11:00:00Z', commit: null, out_sha256: { 'quickcheck.json': sha256Hex(bad) } }, (t) => sha256Hex(t), { kind: 'gate' }));
    fs.writeFileSync(path.join(h.dir, 'ledger.jsonl'), `${lines.join('\n')}\n`);
    r = await pack(['gate-c', ...OK]);
    expect(r.code).toBe(1);
    expect(r.err.join('\n')).toContain('quickcheck.json is not valid');
    expect(fs.existsSync(e.data)).toBe(false);
  });

  it('refuses when quickcheck.json changed after its step, or a file is there that no step wrote', async () => {
    const g = writeGate({ id: 'gate-b', pack: 'B', stage: 'quickcheck', quickcheck: 'condition6' });
    fs.writeFileSync(path.join(g.dir, 'quickcheck.json'), toJsonText(quickcheckOf('gate-b', 'technical'), null, 2));
    let r = await pack(['gate-b', ...OK]);
    expect(r.code).toBe(1);
    expect(r.err.join('\n')).toContain('quickcheck.json changed after step quickcheck wrote it');

    const h = writeGate({ id: 'gate-c', pack: 'C', stage: 'quickcheck', quickcheck: 'condition6' });
    fs.writeFileSync(path.join(h.dir, 'onsets.json'), toJsonText(exampleOnsets(), 'onsets.json', 2));
    r = await pack(['gate-c', ...OK]);
    expect(r.code).toBe(1);
    expect(r.err.join('\n')).toContain('onsets.json: no step line of ledger.jsonl holds its hash');
    expect(fs.existsSync(e.data)).toBe(false);
  });
});

describe('marks.jsonl, g_resets.json and sniff_onsets.json of a gate set (for npm run replay)', () => {
  /** Every sort of mark between the arr stamps of the packets; the objection block starts at n 1500. */
  function markedStamps(pack: GatePack, arrs: readonly [number, number][]): object[] {
    const s = gateSteps(pack);
    const marks: object[] = [
      { n: 100, k: 'mark', what: 'step', name: s.listening },
      { n: 700, k: 'voice', on: true },
      { n: 1000, k: 'mark', what: 'key' },
      { n: 1500, k: 'mark', what: 'step', name: s.objections },
      { n: 1600, k: 'mark', what: 'step', name: s.cueOn[0]! },
      { n: 1600, k: 'mark', i: 0, what: 'cue', on: true },
      { n: 1650, k: 'mark', i: 0, what: 'cue', on: false },
    ];
    const lines = [...marks, ...arrs.map(([seq, n]) => ({ n, k: 'arr', seq }))].sort((a, b) => (a as { n: number }).n - (b as { n: number }).n);
    return [{ n: 0, k: 'chunk', frames: 4 * STEP + 100 }, ...lines];
  }

  /** A batch of detector_in.jsonl. */
  const batch = (seq: number, g: number | null): object => ({ k: 'batch', seq, tr: [[T0 + seq * 33_333, -0.4]], talk: [[T0 + seq * 33_333, 0]], g, hm: g === null ? null : 0.002 });

  /** A samples.jsonl packet line: lm the landmark frame (reset 0 or 1) or null (no frame). */
  function packet(seq: number, lm: 0 | 1 | null): object {
    const m = exampleSamples()[0] as SamplePacket;
    const g = lm === 0 ? m.g : null;
    return { ...m, seq, g, hm: g === null ? null : m.hm, lm: lm === null ? null : { ...m.lm!, reset: lm } };
  }

  // Packet 3: a frame with the reset flag. Packet 4: no landmark frame. Packet 5: g null, and no line
  // of samples.jsonl says why (taken as a reset). Packet 6: as 3, after the objection block began.
  const DETECTOR_IN_G = [batch(1, 0.03), { k: 'val', seq: 2, code: 0 }, batch(3, null), batch(4, null), batch(5, null), batch(6, null)];
  const SAMPLES_G = [packet(1, 0), packet(3, 1), packet(4, null), packet(6, 1)];
  const ARRS_G: [number, number][] = [[1, 600], [2, 900], [3, 1200], [4, 1300], [5, 1400], [6, 1800]];

  it('marks.jsonl holds every "mark" line of stamps.jsonl as it is, in file order (step, cue and key marks), and no other stamp', async () => {
    const g = writeGate({ id: 'gate-b', pack: 'B', stage: 'verdict', stamps: markedStamps('B', [[1, 600], [2, 900], [3, 1200]]) });
    const r = await pack(['gate-b', ...OK]);
    expect(r.err).toEqual([]);
    expect(r.code).toBe(0);
    const set = readSet('gate-b');
    expect(validatePublishedFolder(set)).toEqual([]);
    const lines = splitJsonlLines(set['marks.jsonl']!);
    expect(lines.map((l) => (JSON.parse(l) as { what: string }).what)).toEqual(['step', 'key', 'step', 'step', 'cue', 'cue']);
    expect(set['marks.jsonl']).toBe(markLinesOf(g.dir));
    // The lines are those of stamps.jsonl byte for byte: none is written again.
    const stamps = fs.readFileSync(path.join(g.dir, 'stamps.jsonl'), 'utf8');
    for (const line of lines) expect(stamps.includes(`${line}\n`)).toBe(true);
    // No sniff step was marked, so stage B finds no sniff onset: sample numbers only, none here.
    expect(set['sniff_onsets.json']).toBe('{"schema":"sniff-onsets/1","onsets":[]}\n');
    // The pack step holds their hashes, as of every file of the set.
    expect(lastLedgerLine(g.ledgerText()).out_sha256['data/gate-b/marks.jsonl']).toBe(sha256Hex(set['marks.jsonl']!));
    expect(lastLedgerLine(g.ledgerText()).out_sha256['data/gate-b/g_resets.json']).toBe(sha256Hex(set['g_resets.json']!));
    expect(lastLedgerLine(g.ledgerText()).out_sha256['data/gate-b/sniff_onsets.json']).toBe(sha256Hex(set['sniff_onsets.json']!));
    // pack lists them after stream.jsonl, in SET_ORDER.
    const listed = r.out.slice(r.out.findIndex((l) => l.startsWith('pack: wrote ')) + 1).filter((l) => l.startsWith('  '));
    expect(listed.map((l) => l.trim().split(/\s+/)[0])).toEqual([
      'manifest.json', 'stream.jsonl', 'marks.jsonl', 'g_resets.json', 'sniff_onsets.json', 'events.jsonl', 'onsets.json', 'calib.json', 'clock_report.json',
      'verdict.md', 'verdict.json', 'audio_env.json',
    ]);
  });

  it('writes no sniff_onsets.json when stage B could not lay out the recording, and says why: replay then calls the two values of row 4 not recomputable', async () => {
    // stampsOf has no step mark of the listening block, so stage B's layout (analysis/gate/view.ts gateLayout) refuses.
    writeGate({ id: 'gate-b', pack: 'B', stage: 'verdict' });
    const r = await pack(['gate-b', ...OK]);
    expect(r.err).toEqual([]);
    expect(r.code).toBe(0);
    expect(r.out).toContain(
      `note: the set has no sniff_onsets.json: stage B's layout of the recording fails (no "${gateSteps('B').listening}" step mark before the objection block), so npm run replay cannot recount row 4, and best_case_ms and d1_on_sniffs_ms read not recomputable from the set`,
    );
    const set = readSet('gate-b');
    expect(Object.keys(set)).not.toContain('sniff_onsets.json');
    expect(Object.keys(set)).toContain('verdict.json');
    expect(validatePublishedFolder(set)).toEqual([]);
  });

  it('refuses a mark line that is not as Deck writes it: with a key given twice, JSON.parse keeps one value, and the other would be published unchecked', async () => {
    const s = gateSteps('B');
    const lines = [
      ...(stampsOf(s.objections) as object[]).map((x) => JSON.stringify(x)),
      `{"n":1600,"k":"mark","what":"step","name":"Breathe in, then say ${SECRET}","name":"${s.cueOn[0]!}"}`,
    ].sort((a, b) => (JSON.parse(a) as { n: number }).n - (JSON.parse(b) as { n: number }).n);
    const g = writeGate({ id: 'gate-b', pack: 'B', stage: 'verdict', stamps: `${lines.join('\n')}\n` });
    const at = lines.findIndex((l) => l.includes(SECRET)) + 1;
    const before = g.ledgerText();
    const r = await pack(['gate-b', ...OK]);
    expect(r.code).toBe(1);
    expect(r.err.join('\n')).toContain(
      `stamps.jsonl line ${at}: a mark line that is not as Deck writes it, JSON.stringify of its fields (a key given twice, a space or an escape differs). Pack copies mark lines unchanged into marks.jsonl, and a key given twice would publish a value that no check reads. Report the recording as broken with this line number; pack publishes no set of it`,
    );
    expect(r.out.join('\n')).not.toContain(SECRET);
    expect(r.err.join('\n')).not.toContain(SECRET);
    expect(g.ledgerText()).toBe(before);
    expectNothingWritten('gate-b');
    // The same mark as Deck writes it is published as it is.
    expect(marksJsonl(`{"n":1600,"k":"mark","what":"step","name":"${s.cueOn[0]!}"}\n`, null)).toBe(`{"n":1600,"k":"mark","what":"step","name":"${s.cueOn[0]!}"}\n`);
    expect(() => marksJsonl('{"n":1600, "k":"mark","what":"key"}\n', null)).toThrow('stamps.jsonl line 1: a mark line that is not as Deck writes it');
  });

  it('g_resets.json lists the packets gResetSeqs finds on detector_in.jsonl and samples.jsonl, as stage B calls it: a frame with the reset flag and a null g samples.jsonl does not explain, never a packet without a landmark frame', async () => {
    writeGate({ id: 'gate-b', pack: 'B', stage: 'verdict', stamps: markedStamps('B', ARRS_G), detectorIn: DETECTOR_IN_G, samples: SAMPLES_G });
    const r = await pack(['gate-b', ...OK]);
    expect(r.err).toEqual([]);
    expect(r.code).toBe(0);
    const set = readSet('gate-b');
    expect(validatePublishedFolder(set)).toEqual([]);
    expect(set['g_resets.json']).toBe('{"schema":"g-resets/1","seqs":[3,5,6]}\n');
    const stageB = gResetSeqs(DETECTOR_IN_G as never, SAMPLES_G as SampleLmLike[]);
    expect([...stageB.seqs].sort((a, b) => a - b)).toEqual([3, 5, 6]);
    expect({ flagged: stageB.flagged, noFrame: stageB.noFrame, unknown: stageB.unknown }).toEqual({ flagged: 2, noFrame: 1, unknown: 1 });
    // Each listed packet has g null in stream.jsonl, as replay checks.
    const gOf = new Map(splitJsonlLines(set['stream.jsonl']!).map((l) => JSON.parse(l) as { k: string; seq?: number; g?: number | null }).filter((x) => x.k === 'batch').map((x) => [x.seq, x.g]));
    for (const seq of [3, 4, 5, 6]) expect(gOf.get(seq)).toBeNull();
  });

  it('pack A held back at the step mark of the objection block: marks.jsonl and g_resets.json end where stream.jsonl ends, as stage A reads them (PREREG section 7.5)', async () => {
    const report: ClockReport = { ...exampleClockReport(), trace_valid: false, hard: { ...exampleClockReport().hard, trace_rate_median: 12 } };
    writeGate({ id: 'gate-a', pack: 'A', stage: 'label', quickcheck: 'technical', clockReport: report, stamps: markedStamps('A', ARRS_G), detectorIn: DETECTOR_IN_G, samples: SAMPLES_G });
    const r = await pack(['gate-a', ...OK]);
    expect(r.err).toEqual([]);
    expect(r.code).toBe(0);
    expect(r.out.some((l) => l.startsWith('note: part B, the objection block from sample 1,500 (4:15) on, is held back'))).toBe(true);
    const set = readSet('gate-a');
    expect(validatePublishedFolder(set)).toEqual([]);
    // Packets 1 to 5 arrived before n 1500; packet 6 at n 1800 is part B.
    expect(splitJsonlLines(set['stream.jsonl']!).map((l) => (JSON.parse(l) as { seq?: number }).seq)).toEqual([1, 2, 3, 4, 5]);
    expect(set['g_resets.json']).toBe('{"schema":"g-resets/1","seqs":[3,5]}\n');
    // The marks before the step mark of the block (view.ts stampsBefore): the listening step and the key.
    expect(splitJsonlLines(set['marks.jsonl']!).map((l) => (JSON.parse(l) as { n: number }).n)).toEqual([100, 1000]);
    expect(set['marks.jsonl']!.includes(gateSteps('A').objections)).toBe(false);
  });

  it('refuses a samples.jsonl that changed after the record step, or a link: pack reads it and checks it as every file it reads', async () => {
    const g = writeGate({ id: 'gate-b', pack: 'B', stage: 'verdict' });
    fs.appendFileSync(path.join(g.dir, 'samples.jsonl'), `${JSON.stringify(exampleSamples()[2])}\n`);
    let r = await pack(['gate-b', ...OK]);
    expect(r.code).toBe(1);
    expect(r.err.join('\n')).toContain('samples.jsonl changed after step record wrote it');
    expectNothingWritten('gate-b');

    const h = writeGate({ id: 'gate-c', pack: 'C', stage: 'verdict' });
    fs.renameSync(path.join(h.dir, 'samples.jsonl'), path.join(e.root, 'samples.jsonl'));
    fs.symlinkSync(path.join(e.root, 'samples.jsonl'), path.join(h.dir, 'samples.jsonl'));
    r = await pack(['gate-c', ...OK]);
    expect(r.code).toBe(1);
    expect(r.err.join('\n')).toContain('samples.jsonl in');
    expect(r.err.join('\n')).toContain('is a link');
    expectNothingWritten('gate-c');
  });

  it('refuses a recording whose samples.jsonl flags a reset frame where detector_in.jsonl holds a g value: the files disagree', async () => {
    const g = writeGate({ id: 'gate-b', pack: 'B', stage: 'verdict', samples: [packet(1, 1), packet(3, null)] });
    const before = g.ledgerText();
    const r = await pack(['gate-b', ...OK]);
    expect(r.code).toBe(1);
    expect(r.err.join('\n')).toContain(
      'samples.jsonl flags the landmark frame of packet 1 as a reset of G, but detector_in.jsonl holds a g value there, while live/reduce.cjs writes g null on every reset frame: the two files disagree, and replay would refuse g_resets.json. Report the recording as broken with these packet numbers; pack publishes no set of it',
    );
    expect(g.ledgerText()).toBe(before);
    expectNothingWritten('gate-b');
  });

  it('a samples.jsonl cut short by a crash: the partial last line is dropped; with a broken line before it the set is written without g_resets.json', async () => {
    const whole = toJsonlText(exampleSamples(), 'samples.jsonl');
    const technical = { stage: 'quickcheck', quickcheck: 'technical', objectionsReached: false } as const;
    writeGate({ id: 'gate-b', pack: 'B', ...technical, samples: `${whole}{"seq":5419,"k":"m","tArr` });
    let r = await pack(['gate-b', ...OK]);
    expect(r.code).toBe(0);
    expect(r.out).toContain('note: samples.jsonl line 4: partial last line dropped (no newline, not valid JSON: the recording was cut off)');
    expect(readSet('gate-b')['g_resets.json']).toBe('{"schema":"g-resets/1","seqs":[3]}\n');

    const lines = whole.split('\n');
    lines[1] = '{"seq":5418,"k":"v","tArrNs":"812345712345678"';
    writeGate({ id: 'gate-c', pack: 'C', ...technical, samples: lines.join('\n') });
    r = await pack(['gate-c', ...OK]);
    expect(r.code).toBe(0);
    const note = r.out.find((l) => l.startsWith('note: the set has no g_resets.json: samples.jsonl line 2: not valid JSON'));
    expect(note).toBeDefined();
    expect(note).toContain('so samples.jsonl does not tell which packets with g null were reset frames of G; stage B reads every line of it and scores no such recording');
    expect(namesIn(setDir('gate-c'))).toEqual(['audio_env.json', 'calib.json', 'events.jsonl', 'manifest.json', 'marks.jsonl', 'stream.jsonl']);
    expect(validatePublishedFolder(readSet('gate-c'))).toEqual([]);
  });

  it('refuses a mark line that would publish more than a mark: a step name that is not a name of the scenario', async () => {
    const stamps = [...stampsOf(null), { n: 1600, k: 'mark', what: 'step', name: 'Breathe in' }];
    writeGate({ id: 'gate-b', pack: 'B', stage: 'verdict', stamps });
    const r = await pack(['gate-b', ...OK]);
    expect(r.code).toBe(1);
    expect(r.err.join('\n')).toContain('the set for data/gate-b/ would not be valid (spec 8.7)');
    expect(r.err.join('\n')).toContain('marks.jsonl line 1: name: expected a step name of the scenario (lowercase letters, digits and _)');
    expectNothingWritten('gate-b');
  });

  it('a headstart take gets neither file, and pack does not read its samples.jsonl', async () => {
    const rec = headstart('headstart-1');
    fs.renameSync(path.join(rec.dir, 'samples.jsonl'), path.join(e.root, 'samples.jsonl'));
    fs.symlinkSync(path.join(e.root, 'samples.jsonl'), path.join(rec.dir, 'samples.jsonl'));
    const r = await pack(['headstart-1', ...OK]);
    expect(r.err).toEqual([]);
    expect(r.code).toBe(0);
    expect(namesIn(setDir('headstart-1'))).toEqual(['audio_env.json', 'calib.json', 'events.jsonl', 'manifest.json', 'stream.jsonl']);
  });

  it('marksJsonl and gResetsJson: the text of the two files from the session texts', () => {
    const stamps = [
      '{"n":0,"k":"chunk","frames":4096}',
      '{"n":10,"k":"mark","what":"step","name":"listening"}',
      '{"n":20,"k":"arr","seq":1}',
      '{"n":30,"k":"mark","i":0,"what":"cue","on":true}',
      '{"n":40,"k":"mark","what":"key"}',
    ].join('\n');
    expect(marksJsonl(`${stamps}\n`, null)).toBe('{"n":10,"k":"mark","what":"step","name":"listening"}\n{"n":30,"k":"mark","i":0,"what":"cue","on":true}\n{"n":40,"k":"mark","what":"key"}\n');
    // A last line a crash cut short is left out; with a cut, the marks before it.
    expect(marksJsonl(`${stamps}\n{"n":50,"k":"mark","wh`, null)).toBe(marksJsonl(`${stamps}\n`, null));
    expect(marksJsonl(`${stamps}\n`, 30)).toBe('{"n":10,"k":"mark","what":"step","name":"listening"}\n');
    expect(marksJsonl(`${stamps}\n`, 10)).toBe('');
    expect(marksJsonl('', null)).toBe('');

    const detectorIn = toJsonlText(DETECTOR_IN, 'detector_in.jsonl');
    const stream = toJsonlText(STREAM, 'stream.jsonl');
    const notes: string[] = [];
    expect(gResetsJson(detectorIn, toJsonlText(exampleSamples(), 'samples.jsonl'), stream, notes)).toBe('{"schema":"g-resets/1","seqs":[3]}\n');
    // Packet 3 framed without a landmark frame: a null g that is no reset.
    expect(gResetsJson(detectorIn, toJsonlText([packet(3, null)], 'samples.jsonl'), stream, notes)).toBe('{"schema":"g-resets/1","seqs":[]}\n');
    // Only packets of the published stream.jsonl: none when it holds none.
    expect(gResetsJson(detectorIn, '', toJsonlText(STREAM.slice(0, 2), 'stream.jsonl'), notes)).toBe('{"schema":"g-resets/1","seqs":[]}\n');
    expect(notes).toEqual([]);
  });
});

describe('atomic writes', () => {
  it('a failure while the set is written leaves no folder, no temporary folder and no ledger line', async () => {
    const g = writeGate({ id: 'gate-b', pack: 'B', stage: 'verdict' });
    const before = g.ledgerText();
    for (const [stage, name] of [['file', 'stream.jsonl'], ['file', 'audio_env.json'], ['rename', setDir('gate-b')]] as const) {
      const r = await pack(['gate-b', ...OK], (s, n) => {
        if (s === stage && n === name) throw new Error('disk full');
      });
      expect(r.code, `${stage} ${name}`).toBe(1);
      expect(r.err.join('\n')).toContain('(disk full); nothing written, no folder was left behind');
      expectNothingWritten('gate-b');
      expect(g.ledgerText()).toBe(before);
    }
  });

  it('with --replace a failure between the two renames puts the old set back', async () => {
    const g = writeGate({ id: 'gate-b', pack: 'B', stage: 'verdict' });
    expect((await pack(['gate-b', ...OK])).code).toBe(0);
    const old = new Map(namesIn(setDir('gate-b')).map((n) => [n, sha256Hex(fs.readFileSync(path.join(setDir('gate-b'), n)))]));
    const ledger = g.ledgerText();
    for (const stage of ['file', 'rename', 'swap'] as const) {
      const r = await pack(['gate-b', ...OK, '--replace', '--alias', "Anna's AirPods=Headset"], (s) => {
        if (s === stage) throw new Error('power cut');
      });
      expect(r.code, stage).toBe(1);
      expect(r.err.join('\n')).toContain('(power cut); nothing written, the old set is as it was');
      expect(new Map(namesIn(setDir('gate-b')).map((n) => [n, sha256Hex(fs.readFileSync(path.join(setDir('gate-b'), n)))]))).toEqual(old);
      expect(fs.readdirSync(e.data)).toEqual(['gate-b']);
      expect(g.ledgerText()).toBe(ledger);
    }
  });

  it('a failure while the pack step is appended takes the set back and leaves ledger.jsonl as it was, a part line too: exit 1, nothing written', async () => {
    const g = writeGate({ id: 'gate-b', pack: 'B', stage: 'verdict' });
    const before = g.ledgerText();
    for (const partial of ['', '{"step":"pack","utc":"2026-']) {
      const r = await pack(['gate-b', ...OK], (s) => {
        if (s !== 'ledger') return;
        // The data/ set is in place at this point.
        expect(fs.existsSync(path.join(setDir('gate-b'), 'manifest.json'))).toBe(true);
        if (partial !== '') fs.appendFileSync(path.join(g.dir, 'ledger.jsonl'), partial);
        throw new Error('disk full');
      });
      expect(r.code, partial).toBe(1);
      expect(r.err).toEqual([
        'pack refused: the pack step could not be appended to ledger.jsonl of gate-b (disk full); nothing written, no folder was left behind, and ledger.jsonl is as it was',
      ]);
      expectNothingWritten('gate-b');
      expect(g.ledgerText()).toBe(before);
    }
    // A run after it writes the set and the step.
    expect((await pack(['gate-b', ...OK])).code).toBe(0);
    expect(lastLedgerLine(g.ledgerText()).step).toBe('pack');
  });

  it('with --replace a failed append of the pack step puts the old set back', async () => {
    const g = writeGate({ id: 'gate-b', pack: 'B', stage: 'verdict' });
    expect((await pack(['gate-b', ...OK])).code).toBe(0);
    const snapshot = (): Map<string, string> => new Map(namesIn(setDir('gate-b')).map((n) => [n, sha256Hex(fs.readFileSync(path.join(setDir('gate-b'), n)))]));
    const old = snapshot();
    const ledger = g.ledgerText();
    const r = await pack(['gate-b', ...OK, '--replace', '--alias', "Anna's AirPods=Headset", '--with-audio', 'gate-b'], (s) => {
      if (s !== 'ledger') return;
      fs.appendFileSync(path.join(g.dir, 'ledger.jsonl'), '{"st');
      throw new Error('disk full');
    });
    expect(r.code).toBe(1);
    expect(r.err).toEqual([
      'pack refused: the pack step could not be appended to ledger.jsonl of gate-b (disk full); nothing written, the old set is as it was, and ledger.jsonl is as it was',
    ]);
    expect(snapshot()).toEqual(old);
    expect(fs.readdirSync(e.data)).toEqual(['gate-b']);
    expect(g.ledgerText()).toBe(ledger);
  });

  it('when ledger.jsonl cannot be put back either, pack says what is where (exit 1, pack failed)', async () => {
    const g = writeGate({ id: 'gate-b', pack: 'B', stage: 'verdict' });
    const r = await pack(['gate-b', ...OK], (s) => {
      if (s !== 'ledger') return;
      fs.writeFileSync(path.join(g.dir, 'ledger.jsonl'), 'replaced by another program\n');
      throw new Error('disk full');
    });
    expect(r.code).toBe(1);
    expect(r.err).toEqual([
      'pack failed: the pack step could not be appended to ledger.jsonl of gate-b (disk full); the set was taken back (no folder was left behind); ledger.jsonl could not be put back as it was (it changed in another way while pack ran): check its last line by hand',
    ]);
    expectNothingWritten('gate-b');
  });

  it('refuses when ledger.jsonl changed while the set was written', async () => {
    const g = writeGate({ id: 'gate-b', pack: 'B', stage: 'verdict' });
    // Another command adds to the ledger between the check and the rename.
    const r = await pack(['gate-b', ...OK], (s) => {
      if (s === 'rename') fs.writeFileSync(path.join(g.dir, 'ledger.jsonl'), `${g.ledgerText()}\n`);
    });
    expect(r.code).toBe(1);
    expect(r.err.join('\n')).toContain('ledger.jsonl of gate-b changed while pack ran');
    expectNothingWritten('gate-b');
  });
});

describe('what the set never holds (spec 8.7)', () => {
  it('no raw SDK data, samples, stamps, detector input, quickcheck, ledger, timings or log in any set', async () => {
    writeGate({ id: 'gate-b', pack: 'B', stage: 'verdict' });
    headstart();
    expect((await pack(['gate-b', ...OK, '--with-audio', 'gate-b'])).code).toBe(0);
    expect((await pack(['headstart-1', ...OK, '--with-audio', 'headstart-1'])).code).toBe(0);
    for (const id of ['gate-b', 'headstart-1']) {
      const names = namesIn(setDir(id));
      for (const never of ['sdk_raw.jsonl.gz', 'samples.jsonl', 'stamps.jsonl', 'detector_in.jsonl', 'quickcheck.json', 'ledger.jsonl', 'timings.json', 'tap.log']) {
        expect(names, `${id} ${never}`).not.toContain(never);
      }
      for (const n of names) expect((SET_ORDER as readonly string[]).includes(n), n).toBe(true);
      // Fields only samples.jsonl holds (its arrival times and landmark frames) reach no file of the set.
      for (const [name, text] of Object.entries(readSet(id))) if (text !== null) expect(text, `${id} ${name}`).not.toMatch(/"(tArrNs|tsCbUs|lm)"/);
    }
    expect(namesIn(setDir('gate-b'))).toEqual(expect.arrayContaining(['marks.jsonl', 'g_resets.json']));
    expect(formatBytes(1)).toBe('1 byte');
    expect(formatBytes(1234567)).toBe('1,234,567 bytes');
  });
});
