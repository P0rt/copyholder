// npm run pack, then npm run replay on what pack published (spec 8.7, 9.6, 9.7): synthetic
// day-one recordings (analysis/gate/synth.ts) made to look as host leaves a real one, with the real
// tap and its SDK in manifest.json and every recording file hashed by the record step of
// ledger.jsonl (live/host.cjs saveRecording), scored by analyze:gate stages A and B, and packed by
// pack itself. Replay then reads data/<id>/ alone: no session folder, no camera, no key.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { appendLedger, isNoteLine, NOTE_STEP, splitJsonlLines, validatePublishedFolder, type LedgerLine, type Verdict } from '../../core/schemas/index.ts';
import { chromePath, launchChrome } from '../../tools/video/textpng.ts';
import { main as gateMain } from '../gate.ts';
import type { GateDeps } from '../gate/deps.ts';
import { RETUNE_TAG } from '../gate/frozen.ts';
import { buildGateSynth, preregParamsText, writeGateSession, type GateSynthOptions, type ReplyPlan } from '../gate/synth.ts';
import { verdictMarkdown } from '../gate/verdict-text.ts';
import { sha256Hex } from '../lib/ledger.ts';
import { gateSteps } from '../lib/steps.ts';
import { main as packMain, type PackDeps } from '../pack.ts';
import { main as replayMain, type ReplayDeps } from '../replay.ts';
import type { ReplayTable } from './table.ts';

/** A Chrome starts as npm run replay starts it: PW_CHROMIUM_PATH, else Playwright's own Chromium. */
const HAVE_CHROMIUM = await (async (): Promise<boolean> => {
  try {
    await (await launchChrome(chromePath(undefined, process.env))).close();
    return true;
  } catch {
    return false;
  }
})();

const PREREG = preregParamsText();

/** What host writes into manifest.json for a recording with the real tap and its SDK (live/lib/manifest.cjs). */
const SDK = { version: '3.5.0', metrics: ['CHEST_BREATHING', 'BREATHING_RATE', 'FACE_LANDMARKS', 'TALKING'], launcher: 'node' };

/** The files host hashes when it saves a gate recording (live/host.cjs saveRecording; the later steps write the rest). */
const RECORDED = ['audio.wav', 'stamps.jsonl', 'samples.jsonl', 'detector_in.jsonl', 'events.jsonl', 'calib.json'];

/** Hand marks 2, 4, ... 28 ms after the automatic onsets, as in replay.test.ts. */
const PLAN: ReplyPlan[] = Array.from({ length: 14 }, (_, i) => ({ kind: i < 10 ? 'inhale' : 'plain', manualShiftMs: 2 * (i + 1) }));

/**
 * Lips that part 0.7 s before every voice, so that row 5 turns on G (analysis/gate.test.ts): a
 * landmark reset 0.9 s before the voice makes G build its baseline anew with the lips already
 * open, a packet without a landmark frame there does not. Both carry g null in detector_in.jsonl.
 */
const LIPS_FIRST: ReplyPlan[] = PLAN.map((p) => ({ ...p, lipLeadS: 0.7 }));

interface World {
  root: string;
  sessions: string;
  data: string;
  paramsFile: string;
  tags: Map<string, string>;
  gate: GateDeps;
  /** What analyze:gate printed, for a failing stage. */
  gateOut: string[];
}

let w: World;

interface Ran {
  code: number;
  out: string[];
  err: string[];
}

function ledgerRecords(dir: string): LedgerLine[] {
  return splitJsonlLines(fs.readFileSync(path.join(dir, 'ledger.jsonl'), 'utf8')).map((l) => JSON.parse(l) as LedgerLine);
}

/** Rebuilds ledger.jsonl after `edit`, with a valid chain (as analysis/confirm/confirm.test.ts does). */
function reforgeLedger(dir: string, edit: (r: LedgerLine) => LedgerLine): void {
  const hash = (t: string): string => sha256Hex(t);
  const lines: string[] = [];
  for (const record of ledgerRecords(dir)) {
    const r = edit(record);
    lines.push(
      isNoteLine(r)
        ? appendLedger(lines, NOTE_STEP, { utc: r.utc, commit: r.commit, what: r.what, ...(r.detail === undefined ? {} : { detail: r.detail }) }, hash, { kind: 'gate' })
        : appendLedger(lines, r.step, { utc: r.utc, commit: r.commit, out_sha256: r.out_sha256, exploratory: r.exploratory }, hash, { kind: 'gate' }),
    );
  }
  fs.writeFileSync(path.join(dir, 'ledger.jsonl'), `${lines.join('\n')}\n`);
}

/** Writes a file a step wrote, and its hash in every step line that lists it. */
function replaceStepFile(dir: string, file: string, text: string): void {
  fs.writeFileSync(path.join(dir, file), text);
  reforgeLedger(dir, (r) => (isNoteLine(r) || r.out_sha256[file] === undefined ? r : { ...r, out_sha256: { ...r.out_sha256, [file]: sha256Hex(text) } }));
}

/**
 * A gate recording of `pack` as host leaves it: manifest.json with the real tap, its SDK and the
 * file hashes, and the record step of ledger.jsonl with the hash of every recording file and of
 * manifest.json; then the steps before analyze:gate (quickcheck, clocks, onsets, label).
 */
function record(id: string, pack: 'A' | 'B' | 'C', o: GateSynthOptions): string {
  const dir = writeGateSession(w.sessions, buildGateSynth(o), id);
  const hashes = Object.fromEntries(RECORDED.map((f) => [f, sha256Hex(fs.readFileSync(path.join(dir, f)))]));
  const file = path.join(dir, 'manifest.json');
  const m = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
  const files = Object.fromEntries(Object.entries(hashes).map(([f, h]) => [f, `sha256:${h}`]));
  const text = `${JSON.stringify({ ...m, pack, scenario: `gate-${pack}`, tap: 'real', dry: false, sdk: SDK, state: 'closed', files }, null, 2)}\n`;
  fs.writeFileSync(file, text);
  reforgeLedger(dir, (r) => (!isNoteLine(r) && r.step === 'record' ? { ...r, out_sha256: { ...hashes, 'manifest.json': sha256Hex(text) } } : r));
  return dir;
}

async function stages(id: string): Promise<void> {
  const from = w.gateOut.length;
  for (const stage of ['A', 'B']) {
    const code = await gateMain(['--stage', stage, id], w.gate);
    expect(code, w.gateOut.slice(from).join('\n')).toBe(0);
  }
}

async function pack(id: string): Promise<Ran> {
  const out: string[] = [];
  const err: string[] = [];
  const deps: PackDeps = {
    env: { COPYHOLDER_SESSIONS_DIR: w.sessions, COPYHOLDER_DATA_DIR: w.data },
    now: () => new Date('2026-11-21T09:30:00Z'),
    commit: () => 'abc1234',
    log: (l) => out.push(l),
    error: (l) => err.push(l),
  };
  return { code: await packMain([id, '--devices-ok'], deps), out, err };
}

/** npm run replay as a clone runs it: the data folder, params/ with its tags, and the Chrome of PW_CHROMIUM_PATH. */
async function replay(argv: string[]): Promise<Ran> {
  const out: string[] = [];
  const err: string[] = [];
  const chrome = process.env['PW_CHROMIUM_PATH'];
  const deps: ReplayDeps = {
    env: { COPYHOLDER_DATA_DIR: w.data, COPYHOLDER_PARAMS_FILE: w.paramsFile, ...(chrome !== undefined ? { PW_CHROMIUM_PATH: chrome } : {}) },
    log: (l) => out.push(l),
    error: (l) => err.push(l),
    tagFile: (tag) => (tag === 'gate-prereg' ? PREREG : (w.tags.get(tag) ?? null)),
  };
  return { code: await replayMain(argv, deps), out, err };
}

/** The console line of one value. */
function lineOf(out: readonly string[], name: string): string {
  const found = out.find((l) => l.startsWith(`  ${name} `));
  if (found === undefined) throw new Error(`no line for ${name} in:\n${out.join('\n')}`);
  return found;
}

function last(out: readonly string[]): string {
  return out[out.length - 1]!;
}

function setOf(id: string): string {
  return path.join(w.data, id);
}

function readSet(id: string): Record<string, string> {
  return Object.fromEntries(fs.readdirSync(setOf(id)).map((f) => [f, fs.readFileSync(path.join(setOf(id), f), 'utf8')]));
}

function copySet(id: string, to: string): string {
  const dir = path.join(w.root, to, id);
  fs.cpSync(setOf(id), dir, { recursive: true });
  return dir;
}

const VERIFIED = /^replay: verified: the verdict and the five row outcomes of (the set are|all \d+ sets are) recomputed and match, and no recomputed value differs \(/;

/** Packets of the reset frames and of the frames without landmarks, before the voices of LIPS_FIRST. */
const before = buildGateSynth({ replies: LIPS_FIRST }).truth.map((t) => t.voiceS! - 0.9);

const packed: Record<string, Ran> = {};

beforeAll(async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pack-replay-'));
  const sessions = path.join(root, 'sessions');
  const paramsFile = path.join(root, 'params', 'frozen.json');
  fs.mkdirSync(sessions, { recursive: true });
  fs.mkdirSync(path.dirname(paramsFile), { recursive: true });
  fs.writeFileSync(paramsFile, PREREG);
  const tags = new Map<string, string>();
  const gateOut: string[] = [];
  w = {
    root,
    sessions,
    data: path.join(root, 'data'),
    paramsFile,
    tags,
    gateOut,
    gate: {
      env: { COPYHOLDER_SESSIONS_DIR: sessions, COPYHOLDER_PARAMS_FILE: paramsFile },
      now: () => new Date('2026-11-20T21:00:00Z'),
      commit: () => 'abc1234',
      log: (l) => gateOut.push(l),
      error: (l) => gateOut.push(l),
      tagFile: (tag) => (tag === 'gate-prereg' ? PREREG : (tags.get(tag) ?? null)),
    },
  };

  // Pack A, scored with the params stage A tunes on it: reset frames before the voices of cues 1
  // to 7, packets without a landmark frame before those of cues 8 to 14.
  record('gate-a', 'A', { replies: LIPS_FIRST, resetsAtS: before.slice(0, 7), noFrameAtS: before.slice(7) });
  await stages('gate-a');
  // The retune keeps stage A's params: params/retune.json is their copy, frozen under gate-retune before pack B (PREREG section 11).
  const tuned = fs.readFileSync(paramsFile, 'utf8');
  fs.writeFileSync(path.join(path.dirname(paramsFile), 'retune.json'), tuned);
  tags.set(RETUNE_TAG, tuned);

  // Pack B, scored with the frozen params; breaths stage A would have tuned otherwise.
  const lipOpenings = [80, 110, 140, 170, 200].map((t) => ({ fromS: t, toS: t + 1, rise: 0.019 }));
  record('gate-b', 'B', { replies: PLAN, seed: 12, jitter: 0.12, lipOpenings });
  await stages('gate-b');
  expect(fs.readFileSync(paramsFile, 'utf8')).toBe(tuned);

  // A pack A that broke off for a technical reason after the objection block began: quickcheck
  // says so, and analyze:gate never scored it, so no stage A hash is in its ledger.
  const lost = record('gate-a-lost', 'A', { replies: LIPS_FIRST, seed: 5, resetsAtS: before.slice(0, 7), noFrameAtS: before.slice(7) });
  const q = JSON.parse(fs.readFileSync(path.join(lost, 'quickcheck.json'), 'utf8')) as Record<string, any>;
  q['result'] = 'RE-RECORD NOW';
  q['reasons'] = ['microphone processing not off'];
  q['technical'] = true;
  q['checks'] = (q['checks'] as { name: string }[]).map((c) => (c.name === 'mic_flags_off' ? { ...c, ok: false } : c));
  replaceStepFile(lost, 'quickcheck.json', `${JSON.stringify(q)}\n`);

  for (const id of ['gate-a', 'gate-b', 'gate-a-lost']) packed[id] = await pack(id);
}, 300_000);

afterAll(() => {
  if (w) fs.rmSync(w.root, { recursive: true, force: true });
});

describe('npm run pack, then npm run replay on the set it wrote (spec 8.7, 9.6, 9.7)', () => {
  it('pack writes marks.jsonl and g_resets.json into each gate set beside the files of spec 8.7, and the sets pass the published-set checks', () => {
    for (const id of ['gate-a', 'gate-b']) {
      const r = packed[id]!;
      expect(r.err, r.err.join('\n')).toEqual([]);
      expect(r.code).toBe(0);
      expect(r.out).toContain(`ledger: step pack appended to ledger.jsonl of ${id} with the SHA-256 of each file`);
      const set = readSet(id);
      expect(Object.keys(set).sort()).toEqual([
        'audio_env.json', 'calib.json', 'clock_report.json', 'events.jsonl', 'g_resets.json', 'manifest.json', 'marks.jsonl', 'onsets.json', 'stream.jsonl',
        'verdict.json', 'verdict.md',
      ]);
      expect(validatePublishedFolder(set)).toEqual([]);
      // marks.jsonl: the mark lines of stamps.jsonl as they are, nothing else of it.
      const stamps = splitJsonlLines(fs.readFileSync(path.join(w.sessions, id, 'stamps.jsonl'), 'utf8'));
      expect(splitJsonlLines(set['marks.jsonl']!)).toEqual(stamps.filter((l) => (JSON.parse(l) as { k: string }).k === 'mark'));
    }
    // Packet numbers only: the reset frames of pack A, none in pack B.
    const resetsA = JSON.parse(readSet('gate-a')['g_resets.json']!) as { schema: string; seqs: number[] };
    expect(resetsA.seqs).toHaveLength(7);
    expect(JSON.parse(readSet('gate-b')['g_resets.json']!)).toEqual({ schema: 'g-resets/1', seqs: [] });
  });

  it('verifies pack A, whose row 5 turns on which packets with g null were reset frames: exit 0', async () => {
    const r = await replay(['gate-a']);
    expect(r.err).toEqual([]);
    expect(r.code).toBe(0);
    expect(r.out).toContain(`replay data/gate-a/ (pack A, from ${setOf('gate-a')})`);
    expect(r.out).toContain('  note: G: the reset frames are the 7 packets g_resets.json lists (rivals gResetSeqs on samples.jsonl), of the 14 packets of stream.jsonl with g null');
    const v = JSON.parse(readSet('gate-a')['verdict.json']!) as Verdict;
    expect([v.rows.chest_vs_lips.wins, v.rows.chest_vs_lips.losses]).toEqual([7, 7]);
    for (const name of ['rows.chest_vs_lips.wins', 'rows.chest_vs_lips.losses', 'rows.chest_vs_lips.outcome', 'tuning.k', 'tuning.theta_G', 'verdict', 'verdict.md']) {
      expect(lineOf(r.out, name)).toMatch(/ MATCH$/);
    }
    expect(r.out.some((l) => / DIFFERS$/.test(l))).toBe(false);
    expect(last(r.out)).toMatch(VERIFIED);

    // Without g_resets.json neither reading, every null a reset or none, gives row 5: not verified.
    const bare = copySet('gate-a', 'no-resets');
    fs.rmSync(path.join(bare, 'g_resets.json'));
    const without = await replay([bare]);
    expect(without.code).toBe(3);
    expect(lineOf(without.out, 'rows.chest_vs_lips.wins')).toMatch(/ +7 +not recomputable from the set: neither reading of the 14 packets of stream\.jsonl with g null gives it/);
    expect(without.out.some((l) => / DIFFERS$/.test(l))).toBe(false);
  });

  it('verifies pack B, scored with the params the retune froze under gate-retune: exit 0, and both sets together', async () => {
    const r = await replay(['gate-b']);
    expect(r.err).toEqual([]);
    expect(r.code).toBe(0);
    expect(r.out.find((l) => l.startsWith('  params: '))).toMatch(/retune\.json, hashed as stage B hashes it/);
    expect(lineOf(r.out, 'rows.hits.hits')).toMatch(/ MATCH$/);
    expect(last(r.out)).toMatch(VERIFIED);

    const both = await replay(['gate-a', 'gate-b']);
    expect(both.code).toBe(0);
    expect(last(both.out)).toMatch(/^replay: verified: the verdict and the five row outcomes of all 2 sets are recomputed and match, and no recomputed value differs \(/);
  });

  it('exits 1 when one number of verdict.json was changed, verdict.md written anew with it', async () => {
    const dir = copySet('gate-a', 'edit-hits');
    const file = path.join(dir, 'verdict.json');
    const v = JSON.parse(fs.readFileSync(file, 'utf8')) as Verdict;
    const hits = v.rows.hits.hits;
    const edited: Verdict = { ...v, rows: { ...v.rows, hits: { ...v.rows.hits, hits: hits + 1 } } };
    fs.writeFileSync(file, `${JSON.stringify(edited, null, 2)}\n`);
    fs.writeFileSync(path.join(dir, 'verdict.md'), verdictMarkdown(edited, edited.run, { sniff: { gradedUnrounded: false } }));
    const r = await replay([dir]);
    expect(r.code).toBe(1);
    expect(lineOf(r.out, 'rows.hits.hits')).toMatch(new RegExp(` ${hits} +${hits + 1} +DIFFERS$`));
    expect(last(r.out)).toBe('replay: 1 recomputed value differs from the set: gate-a rows.hits.hits');
  });

  it('pack A cut at the objection block, as pack writes it without a stage A hash (PREREG section 7.5): no value differs, and there is no verdict to verify; exit 3', async () => {
    const p = packed['gate-a-lost']!;
    expect(p.err, p.err.join('\n')).toEqual([]);
    expect(p.code).toBe(0);
    expect(p.out.some((l) => l.startsWith('note: part B, the objection block from sample '))).toBe(true);
    const set = readSet('gate-a-lost');
    expect(Object.keys(set).sort()).toEqual(['audio_env.json', 'calib.json', 'clock_report.json', 'events.jsonl', 'g_resets.json', 'manifest.json', 'marks.jsonl', 'stream.jsonl']);
    expect(validatePublishedFolder(set)).toEqual([]);
    // The marks end before the step mark of the objection block, and the reset frames with the packets of stream.jsonl.
    const marks = splitJsonlLines(set['marks.jsonl']!).map((l) => JSON.parse(l) as { n: number; what: string; name?: string });
    const objections = splitJsonlLines(fs.readFileSync(path.join(w.sessions, 'gate-a-lost', 'stamps.jsonl'), 'utf8'))
      .map((l) => JSON.parse(l) as { n: number; k: string; what?: string; name?: string })
      .find((s) => s.k === 'mark' && s.what === 'step' && s.name === gateSteps('A').objections)!;
    expect(marks.length).toBeGreaterThan(0);
    expect(marks.every((m) => m.n < objections.n)).toBe(true);
    expect(marks.some((m) => m.what === 'cue')).toBe(false);
    expect(JSON.parse(set['g_resets.json']!)).toEqual({ schema: 'g-resets/1', seqs: [] });

    const r = await replay(['gate-a-lost']);
    expect(r.err).toEqual([]);
    expect(r.code).toBe(3);
    expect(r.out).toContain(
      '  note: replay read manifest.json, stream.jsonl, marks.jsonl, g_resets.json, calib.json and clock_report.json of this set and found each valid (core/schemas); with no verdict it scores nothing',
    );
    expect(lineOf(r.out, 'verdict')).toMatch(/not recomputable from the set: the set has no verdict\.json, so it holds no verdict to recompute/);
    expect(r.out.some((l) => / DIFFERS$/.test(l))).toBe(false);
    expect(last(r.out)).toBe(
      'replay: no recomputed value differs, but the verdict is not verified: data/gate-a-lost/ verdict is not recomputable from the set or match only under a condition it does not show (see above; 0 MATCH, 0 DIFFERS, 1 not recomputable from the set, 0 inputs)',
    );
  });

  it('writes the table and the figure of two packed sets with --json and --svg', async () => {
    const json = path.join(w.root, 'out', 'replay.json');
    const svg = path.join(w.root, 'out', 'replay.svg');
    const r = await replay(['gate-a', 'gate-b', '--json', json, '--svg', svg]);
    expect(r.err).toEqual([]);
    expect(r.code).toBe(0);
    expect(r.out).toContain(`replay: wrote ${json} (28 cues)`);
    expect(r.out).toContain(`replay: wrote ${svg}`);
    const table = JSON.parse(fs.readFileSync(json, 'utf8')) as ReplayTable;
    expect(table.rows).toHaveLength(28);
    expect(table.sets.map((s) => [s.set, s.pack, s.g_resets, s.lips_unknown])).toEqual([
      ['data/gate-a/', 'A', 'g_resets.json', []],
      ['data/gate-b/', 'B', 'g_resets.json', []],
    ]);
    const drawn = fs.readFileSync(svg, 'utf8');
    expect(drawn).toContain('Stops around the voice onset, gate packs A and B');
    expect(drawn).toContain('recomputed from data/gate-a/ and data/gate-b/ by npm run replay');
    expect(drawn).not.toMatch(/<script|href=|@import|@font-face|url\(/);
  });

  it.skipIf(!HAVE_CHROMIUM)('draws the PNG of two packed sets with --png in the Chrome of PW_CHROMIUM_PATH', async () => {
    const png = path.join(w.root, 'out', 'replay.png');
    const r = await replay(['gate-a', 'gate-b', '--png', png]);
    expect(r.err).toEqual([]);
    expect(r.code).toBe(0);
    expect(r.out).toContain(`replay: wrote ${png}`);
    const bytes = fs.readFileSync(png);
    expect(bytes.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a');
    expect(bytes.readUInt32BE(16)).toBe(1200);
  });
});
