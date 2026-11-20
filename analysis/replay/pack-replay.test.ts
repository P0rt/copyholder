// npm run pack, then npm run replay on what pack published (spec 8.7, 9.6, 9.7): synthetic
// day-one recordings (analysis/gate/synth.ts) made to look as host leaves a real one, with the real
// tap and its SDK in manifest.json and every recording file hashed by the record step of
// ledger.jsonl (live/host.cjs saveRecording), scored by analyze:gate stages A and B, and packed by
// pack itself. Replay then reads data/<id>/ alone: no session folder, no camera, no key.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  appendLedger,
  combineGateVerdict,
  isNoteLine,
  NOTE_STEP,
  splitJsonlLines,
  validatePublishedFolder,
  VERDICT_ROWS,
  type LedgerLine,
  type Verdict,
} from '../../core/schemas/index.ts';
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
import { NO_LABELS_HASH } from './recompute.ts';
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

/** quickcheck.json of a recording that broke off for a technical reason: it does not count, and analyze:gate never scores it. */
function technicalBreak(dir: string): void {
  const q = JSON.parse(fs.readFileSync(path.join(dir, 'quickcheck.json'), 'utf8')) as Record<string, any>;
  q['result'] = 'RE-RECORD NOW';
  q['reasons'] = ['microphone processing not off'];
  q['technical'] = true;
  q['checks'] = (q['checks'] as { name: string }[]).map((c) => (c.name === 'mic_flags_off' ? { ...c, ok: false } : c));
  replaceStepFile(dir, 'quickcheck.json', `${JSON.stringify(q)}\n`);
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
  // to 7, packets without a landmark frame before those of cues 8 to 14. Five sniffs before the
  // listening block, with the sniff block of calib.json as the clocks step measures it on the
  // recording, which replay checks against its recount from sniff_onsets.json.
  record('gate-a', 'A', { replies: LIPS_FIRST, resetsAtS: before.slice(0, 7), noFrameAtS: before.slice(7), sniffs: true, sniffLag: 'measured' });
  await stages('gate-a');
  // The retune keeps stage A's params: params/retune.json is their copy, frozen under gate-retune before pack B (PREREG section 11).
  const tuned = fs.readFileSync(paramsFile, 'utf8');
  fs.writeFileSync(path.join(path.dirname(paramsFile), 'retune.json'), tuned);
  tags.set(RETUNE_TAG, tuned);

  // Pack B, scored with the frozen params; breaths stage A would have tuned otherwise. Five sniffs
  // before the listening block, with the lag the clocks step measures in calib.json: row 4 has a
  // best case and D1 on sniffs, which replay recounts from sniff_onsets.json.
  const lipOpenings = [80, 110, 140, 170, 200].map((t) => ({ fromS: t, toS: t + 1, rise: 0.019 }));
  record('gate-b', 'B', { replies: PLAN, seed: 12, jitter: 0.12, lipOpenings, sniffs: true, sniffLag: 'measured' });
  await stages('gate-b');
  expect(fs.readFileSync(paramsFile, 'utf8')).toBe(tuned);

  // A pack A that broke off for a technical reason after the objection block began: quickcheck
  // says so, and analyze:gate never scored it, so no stage A hash is in its ledger.
  technicalBreak(record('gate-a-lost', 'A', { replies: LIPS_FIRST, seed: 5, resetsAtS: before.slice(0, 7), noFrameAtS: before.slice(7) }));

  // A pack B that broke off for a technical reason, whose onsets.json holds no event and no labels
  // hash, as the onsets step writes it when it finds no reply, and whose clock_report.json has no
  // onset block, as the clocks step writes it: the label step had nothing to label.
  const lostB = record('gate-b-lost', 'B', { replies: PLAN, seed: 7 });
  technicalBreak(lostB);
  replaceStepFile(lostB, 'onsets.json', `${JSON.stringify({ schema: 'onsets/1', labels_sha256: null, events: [] }, null, 2)}\n`);
  const report = JSON.parse(fs.readFileSync(path.join(lostB, 'clock_report.json'), 'utf8')) as Record<string, unknown>;
  replaceStepFile(lostB, 'clock_report.json', `${JSON.stringify({ ...report, onset: null }, null, 2)}\n`);

  for (const id of ['gate-a', 'gate-b', 'gate-a-lost', 'gate-b-lost']) packed[id] = await pack(id);
}, 300_000);

afterAll(() => {
  if (w) fs.rmSync(w.root, { recursive: true, force: true });
});

describe('npm run pack, then npm run replay on the set it wrote (spec 8.7, 9.6, 9.7)', () => {
  it('pack writes marks.jsonl, g_resets.json and sniff_onsets.json into each gate set beside the files of spec 8.7, and the sets pass the published-set checks', () => {
    for (const id of ['gate-a', 'gate-b']) {
      const r = packed[id]!;
      expect(r.err, r.err.join('\n')).toEqual([]);
      expect(r.code).toBe(0);
      expect(r.out).toContain(`ledger: step pack appended to ledger.jsonl of ${id} with the SHA-256 of each file`);
      expect(r.out.some((l) => l.includes('sniff_onsets.json:'))).toBe(false);
      const set = readSet(id);
      expect(Object.keys(set).sort()).toEqual([
        'audio_env.json', 'calib.json', 'clock_report.json', 'events.jsonl', 'g_resets.json', 'manifest.json', 'marks.jsonl', 'onsets.json', 'sniff_onsets.json',
        'stream.jsonl', 'verdict.json', 'verdict.md',
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
    // Sample numbers only: five sniffs in each pack, each in the 2 s after the mark of its sniff step.
    for (const [id, p] of [['gate-a', 'A'], ['gate-b', 'B']] as const) {
      const sniffs = JSON.parse(readSet(id)['sniff_onsets.json']!) as { schema: string; onsets: number[] };
      expect(Object.keys(sniffs)).toEqual(['schema', 'onsets']);
      const marks = splitJsonlLines(readSet(id)['marks.jsonl']!).map((l) => JSON.parse(l) as { n: number; what: string; name?: string });
      const prompts = gateSteps(p).sniffs.map((step) => marks.find((m) => m.what === 'step' && m.name === step)!.n);
      expect(sniffs.onsets).toHaveLength(5);
      sniffs.onsets.forEach((n, i) => {
        expect(n).toBeGreaterThanOrEqual(prompts[i]!);
        expect(n).toBeLessThanOrEqual(prompts[i]! + 2 * 48_000);
      });
    }
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
    // The sniff block of calib.json is the one the recount from sniff_onsets.json gives.
    expect(lineOf(r.out, 'calib.json sniff_lag_ms')).toMatch(/ ([0-9a-f]{8}) +\1 +MATCH$/);
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

  it('verifies pack B, scored with the params the retune froze under gate-retune, its row 4 recounted from sniff_onsets.json: exit 0, and both sets together', async () => {
    const r = await replay(['gate-b']);
    expect(r.err).toEqual([]);
    expect(r.code).toBe(0);
    expect(r.out.find((l) => l.startsWith('  params: '))).toMatch(/retune\.json, hashed as stage B hashes it/);
    expect(lineOf(r.out, 'rows.hits.hits')).toMatch(/ MATCH$/);
    // Row 4: the best case and D1 on sniffs stage B found on the five sniffs, recounted from the set.
    const row = (JSON.parse(readSet('gate-b')['verdict.json']!) as Verdict).rows.sniff_lag;
    expect(row.n).toBe(5);
    expect(row.best_case_ms).toBeGreaterThan(0);
    expect(row.d1_on_sniffs_ms).toBeGreaterThan(0);
    for (const name of ['rows.sniff_lag.outcome', 'rows.sniff_lag.lo_median_ms', 'rows.sniff_lag.best_case_ms', 'rows.sniff_lag.d1_on_sniffs_ms']) {
      expect(lineOf(r.out, name)).toMatch(/ MATCH$/);
    }
    expect(lineOf(r.out, 'rows.sniff_lag.best_case_ms')).toMatch(new RegExp(` ${String(row.best_case_ms).replace('.', '\\.')} +${String(row.best_case_ms).replace('.', '\\.')} +MATCH$`));
    expect(lineOf(r.out, 'calib.json sniff_lag_ms')).toMatch(/ ([0-9a-f]{8}) +\1 +MATCH$/);
    expect(r.out).toContain(
      '  note: row 4: replay recounts the sniff lag as stage B does (analysis/clocks/compute.ts recountSniffLag), from the 5 sniff onsets sniff_onsets.json lists, the trace of stream.jsonl and calib.json, and D1 on sniffs from those onsets (analysis/gate/sniffs.ts sniffRow)',
    );
    expect(last(r.out)).toMatch(VERIFIED);
    expect(last(r.out)).toMatch(/differs \(\d+ MATCH, 0 DIFFERS, 0 not recomputable from the set, 1 input\)$/);

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

  it('exits 1 when best_case_ms or d1_on_sniffs_ms of verdict.json was changed, verdict.md written anew with it: replay recounts both from sniff_onsets.json', async () => {
    for (const [field, by] of [['best_case_ms', 37.5], ['d1_on_sniffs_ms', 25]] as const) {
      const dir = copySet('gate-b', `edit-${field}`);
      const file = path.join(dir, 'verdict.json');
      const v = JSON.parse(fs.readFileSync(file, 'utf8')) as Verdict;
      const was = v.rows.sniff_lag[field]!;
      const edited: Verdict = { ...v, rows: { ...v.rows, sniff_lag: { ...v.rows.sniff_lag, [field]: was + by } } };
      fs.writeFileSync(file, `${JSON.stringify(edited, null, 2)}\n`);
      const graded = fs.readFileSync(path.join(dir, 'verdict.md'), 'utf8').includes('graded on the medians before rounding');
      fs.writeFileSync(path.join(dir, 'verdict.md'), verdictMarkdown(edited, edited.run, { sniff: { gradedUnrounded: graded } }));
      const r = await replay([dir]);
      expect(r.code).toBe(1);
      expect(lineOf(r.out, `rows.sniff_lag.${field}`)).toMatch(/ DIFFERS$/);
      expect(lineOf(r.out, 'verdict.md')).toMatch(/ MATCH$/);
      expect(last(r.out)).toBe(`replay: 1 recomputed value differs from the set: gate-b rows.sniff_lag.${field}`);
    }
  });

  it("exits 1 when the sniff block of calib.json and row 4 of verdict.json were changed together, verdict.md written anew: row 4 copies calib.json's block, which replay checks against its recount from sniff_onsets.json", async () => {
    const round1 = (x: number): number => Math.round(x * 10) / 10;
    // Both medians 0.1 ms later; then both past the KILL threshold (spec 9.6), with the outcome and the verdict word.
    const cases: [string, (row: Verdict['rows']['sniff_lag']) => [number, number], boolean][] = [
      ['later', (row) => [round1(row.lo_median_ms! + 0.1), round1(row.hi_median_ms! + 0.1)], false],
      ['kill', () => [360, 383.5], true],
    ];
    for (const [name, medians, kill] of cases) {
      const dir = copySet('gate-b', `calib-${name}`);
      const calibFile = path.join(dir, 'calib.json');
      const calib = JSON.parse(fs.readFileSync(calibFile, 'utf8')) as Record<string, any>;
      const v = JSON.parse(fs.readFileSync(path.join(dir, 'verdict.json'), 'utf8')) as Verdict;
      expect(calib['sniff_lag_ms']).toMatchObject({ n: 5, lo_median: v.rows.sniff_lag.lo_median_ms, hi_median: v.rows.sniff_lag.hi_median_ms });
      const [lo, hi] = medians(v.rows.sniff_lag);
      fs.writeFileSync(calibFile, `${JSON.stringify({ ...calib, sniff_lag_ms: { ...calib['sniff_lag_ms'], lo_median: lo, hi_median: hi } }, null, 2)}\n`);
      const rows = { ...v.rows, sniff_lag: { ...v.rows.sniff_lag, lo_median_ms: lo, hi_median_ms: hi, ...(kill ? { outcome: 'KILL' as const } : {}) } };
      const edited: Verdict = { ...v, rows, verdict: combineGateVerdict(VERDICT_ROWS.map((row) => rows[row].outcome), v.events.valid) };
      fs.writeFileSync(path.join(dir, 'verdict.json'), `${JSON.stringify(edited, null, 2)}\n`);
      fs.writeFileSync(path.join(dir, 'verdict.md'), verdictMarkdown(edited, edited.run, { sniff: { gradedUnrounded: false } }));
      const r = await replay([dir]);
      expect(r.err).toEqual([]);
      expect(r.code).toBe(1);
      // Stage B copies calib.json's numbers into row 4 and grades the row on them, so row 4 and the verdict match.
      expect(lineOf(r.out, 'rows.sniff_lag.lo_median_ms')).toMatch(new RegExp(` ${lo} +${lo} +MATCH$`));
      expect(lineOf(r.out, 'rows.sniff_lag.outcome')).toMatch(kill ? / KILL +KILL +MATCH$/ : / MATCH$/);
      expect(lineOf(r.out, 'verdict')).toMatch(kill ? / KILL +KILL +MATCH$/ : / MATCH$/);
      expect(r.out.some((l) => l.startsWith('  note: row 4: the recount of the sniff lag gives n=5, 0 without arrival, median ['))).toBe(true);
      expect(lineOf(r.out, 'calib.json sniff_lag_ms')).toMatch(/ [0-9a-f]{8} +[0-9a-f]{8} +DIFFERS$/);
      expect(last(r.out)).toBe('replay: 1 recomputed value differs from the set: gate-b calib.json sniff_lag_ms');
    }
  });

  it('exits 1 on a set whose blind labels were taken out of onsets.json and the onset P90 out of clock_report.json, verdict.json and verdict.md: stage B scores no onsets.json without labels_sha256', async () => {
    const dir = copySet('gate-a', 'no-labels');
    const onsetsFile = path.join(dir, 'onsets.json');
    const onsets = JSON.parse(fs.readFileSync(onsetsFile, 'utf8')) as Record<string, any>;
    expect(onsets['labels_sha256']).toMatch(/^[0-9a-f]{64}$/);
    delete onsets['label_order'];
    const events = (onsets['events'] as Record<string, unknown>[]).map((e) => ({ ...e, label: null, manual: null }));
    expect(events).toHaveLength(14);
    fs.writeFileSync(onsetsFile, `${JSON.stringify({ ...onsets, labels_sha256: null, events }, null, 2)}\n`);
    const reportFile = path.join(dir, 'clock_report.json');
    fs.writeFileSync(reportFile, `${JSON.stringify({ ...(JSON.parse(fs.readFileSync(reportFile, 'utf8')) as object), onset: null }, null, 2)}\n`);
    const v = JSON.parse(fs.readFileSync(path.join(dir, 'verdict.json'), 'utf8')) as Verdict;
    const edited: Verdict = { ...v, clock: { ...v.clock, onset_p90_ms: null } };
    fs.writeFileSync(path.join(dir, 'verdict.json'), `${JSON.stringify(edited, null, 2)}\n`);
    fs.writeFileSync(path.join(dir, 'verdict.md'), verdictMarkdown(edited, edited.run, { sniff: { gradedUnrounded: false } }));
    expect(validatePublishedFolder(Object.fromEntries(fs.readdirSync(dir).map((f) => [f, fs.readFileSync(path.join(dir, f), 'utf8')])))).toEqual([]);
    const r = await replay([dir]);
    expect(r.err).toEqual([]);
    expect(r.code).toBe(1);
    // Without the hand marks there is no onset P90 to recompute, and the three files that held it agree.
    for (const name of ['clock.onset_p90_ms', 'clock_report.json onset.p90_abs_auto_minus_manual_ms', 'verdict.md']) expect(lineOf(r.out, name)).toMatch(/ MATCH$/);
    expect(lineOf(r.out, 'onsets.json labels_sha256')).toMatch(/ +null +null +DIFFERS$/);
    expect(r.out).toContain(`  note: ${NO_LABELS_HASH}`);
    expect(last(r.out)).toBe('replay: 1 recomputed value differs from the set: gate-a onsets.json labels_sha256');

    // With no event at all the label step would write the hash of no label: null differs from it too.
    const empty = copySet('gate-a', 'no-events');
    fs.writeFileSync(path.join(empty, 'onsets.json'), `${JSON.stringify({ schema: 'onsets/1', labels_sha256: null, events: [] }, null, 2)}\n`);
    const r2 = await replay([empty]);
    expect(r2.code).toBe(1);
    expect(lineOf(r2.out, 'onsets.json labels_sha256')).toMatch(/ [0-9a-f]{8} +null +DIFFERS$/);
  });

  it('a set without sniff_onsets.json, as an earlier pack wrote it: the two values of row 4 stay unchecked, and the verified line names them; exit 0', async () => {
    const dir = copySet('gate-b', 'no-sniffs');
    fs.rmSync(path.join(dir, 'sniff_onsets.json'));
    const r = await replay([dir]);
    expect(r.err).toEqual([]);
    expect(r.code).toBe(0);
    for (const name of ['rows.sniff_lag.best_case_ms', 'rows.sniff_lag.d1_on_sniffs_ms']) {
      expect(lineOf(r.out, name)).toMatch(
        / not recomputable from the set: needs the sniff onsets stage B finds in audio\.wav channel 0 after the sniff_<i> step marks \(analysis\/clocks\/compute\.ts recountSniffLag\), which the set does not carry \(no sniff_onsets\.json\); replay reads no audio$/,
      );
    }
    expect(lineOf(r.out, 'rows.sniff_lag.outcome')).toMatch(/ MATCH$/);
    expect(last(r.out)).toMatch(
      /^replay: verified: the verdict and the five row outcomes of the set are recomputed and match, and no recomputed value differs, but these values are not recomputable from the set and stay unchecked: data\/gate-b\/ rows\.sniff_lag\.best_case_ms, rows\.sniff_lag\.d1_on_sniffs_ms \(see above; \d+ MATCH, 0 DIFFERS, 2 not recomputable from the set, 1 input\)$/,
    );
  });

  it('refuses a sniff_onsets.json whose onsets do not fit the sniff step marks of marks.jsonl, or that is not valid: exit 1', async () => {
    const dir = copySet('gate-b', 'moved-sniffs');
    const file = path.join(dir, 'sniff_onsets.json');
    const sniffs = JSON.parse(fs.readFileSync(file, 'utf8')) as { schema: string; onsets: number[] };
    fs.writeFileSync(file, `${JSON.stringify({ ...sniffs, onsets: sniffs.onsets.map((n, i) => (i === 2 ? n + 3 * 48_000 : n)) })}\n`);
    let r = await replay([dir]);
    expect(r.code).toBe(1);
    expect(r.err.join('\n')).toContain(`replay refused ${dir}: ${path.join(dir, 'sniff_onsets.json')} does not fit marks.jsonl, so its onsets are not the ones of this recording:`);
    expect(r.err.join('\n')).toContain('onset 3 of 5, at sample ');
    expect(r.err.join('\n')).toContain('lies within 2 s after the mark of no sniff step left in prompt order (5 of 5 sniff steps have a mark)');

    fs.writeFileSync(file, `${JSON.stringify({ ...sniffs, onsets: [...sniffs.onsets.slice(0, 4), sniffs.onsets[4]! + 0.5] })}\n`);
    r = await replay([dir]);
    expect(r.code).toBe(1);
    expect(r.err.join('\n')).toContain('onsets[4]: expected a sample number (non-negative integer)');
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
      'replay: no recomputed value differs, but the verdict is not verified: data/gate-a-lost/ verdict is not recomputable from the set or matches only under a condition it does not show (see above; 0 MATCH, 0 DIFFERS, 1 not recomputable from the set, 0 inputs)',
    );
  });

  it('a set of pack B without a verdict whose onsets.json holds no event and no labels hash, as the onsets step writes it: nothing differs, so exit 3, not 1', async () => {
    const p = packed['gate-b-lost']!;
    expect(p.err, p.err.join('\n')).toEqual([]);
    expect(p.code).toBe(0);
    const set = readSet('gate-b-lost');
    expect(JSON.parse(set['onsets.json']!)).toEqual({ schema: 'onsets/1', labels_sha256: null, events: [] });
    expect(Object.keys(set)).not.toContain('sniff_onsets.json');
    expect(validatePublishedFolder(set)).toEqual([]);

    const r = await replay(['gate-b-lost']);
    expect(r.err).toEqual([]);
    expect(r.code).toBe(3);
    expect(lineOf(r.out, 'onsets.json labels_sha256')).toMatch(/ +null +null +MATCH$/);
    expect(lineOf(r.out, 'clock_report.json onset.p90_abs_auto_minus_manual_ms')).toMatch(/ MATCH$/);
    expect(r.out.some((l) => / DIFFERS$/.test(l))).toBe(false);
    expect(last(r.out)).toBe(
      'replay: no recomputed value differs, but the verdict is not verified: data/gate-b-lost/ verdict is not recomputable from the set or matches only under a condition it does not show (see above; 2 MATCH, 0 DIFFERS, 1 not recomputable from the set, 0 inputs)',
    );

    // A hash in its place is still recomputed: with no event it is the hash of no label, and another one differs.
    const dir = copySet('gate-b-lost', 'other-hash');
    fs.writeFileSync(path.join(dir, 'onsets.json'), `${JSON.stringify({ schema: 'onsets/1', labels_sha256: 'ab'.repeat(32), events: [] }, null, 2)}\n`);
    const hashed = await replay([dir]);
    expect(hashed.code).toBe(1);
    expect(lineOf(hashed.out, 'onsets.json labels_sha256')).toMatch(/ DIFFERS$/);
    expect(last(hashed.out)).toBe('replay: 1 recomputed value differs from the set: gate-b-lost onsets.json labels_sha256');
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
