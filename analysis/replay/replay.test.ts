// npm run replay on published sets built as pack builds them (spec 8.7): synthetic day-one
// recordings (analysis/gate/synth.ts) scored by analyze:gate stages A and B as its own tests run
// them, then turned into data/<id>/ folders with stream.jsonl from detector_in.jsonl and
// stamps.jsonl, the other published files copied and the unpublished ones left out. Each finding
// of the review has a test here: a changed value of verdict.json never leaves replay at exit 0.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { SniffLag } from '../../core/clock/index.ts';
import type { DetectorInput } from '../../core/detector.ts';
import {
  G_RESETS_SCHEMA,
  buildStreamJsonl,
  parseJson,
  splitJsonlLines,
  toJsonText,
  toPublishedManifest,
  validateManifest,
  validatePublishedFolder,
  type Manifest,
  type Onsets,
  type Verdict,
} from '../../core/schemas/index.ts';
import { exampleCalib, exampleVerdict } from '../../core/schemas/examples.ts';
import { main as gateMain } from '../gate.ts';
import type { GateDeps } from '../gate/deps.ts';
import { RETUNE_TAG, frozenParamsText, frozenWithTuning, parseParamsText, withoutStageAKeys } from '../gate/frozen.ts';
import { buildGateSynth, preregParamsText, writeGateSession, type GateSynthOptions, type ReplyPlan } from '../gate/synth.ts';
import { verdictMarkdown } from '../gate/verdict-text.ts';
import { sha256Hex } from '../lib/ledger.ts';
import { REPO_ROOT } from '../lib/paths.ts';
import { sniffOnsetsJson } from '../pack.ts';
import { gResetSeqs, type SampleLmLike } from '../rivals/index.ts';
import { main, parseReplayArgs, type ReplayDeps } from '../replay.ts';
import { findParams, tunedByStageA, tunedStepOf } from './params.ts';
import { calibSniffCheck, replaySet, sniffEdgeOf, VERDICT_FIELDS, verdictMdCheck, type Check, type ScoredSet, type SetReplay } from './recompute.ts';
import { MARKS_FILE, RESETS_FILE, SNIFFS_FILE, readPublishedSet, setFolderOf, unreadFolderWhy } from './set.ts';
import { replayTable, tableProblems, type ReplayTable } from './table.ts';

const PREREG = preregParamsText();

let root: string;

beforeAll(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'replay-'));
});

afterAll(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

interface Repo {
  sessions: string;
  paramsFile: string;
  gate: GateDeps;
}

/**
 * A repository with params/frozen.json as frozen under gate-prereg (spec 8.4), as analyze:gate's
 * tests set it up; `tags` holds the other tags analyze:gate sees, such as gate-retune.
 */
function repo(name: string, tags: ReadonlyMap<string, string> = new Map()): Repo {
  const base = path.join(root, name);
  const sessions = path.join(base, 'sessions');
  const paramsFile = path.join(base, 'params', 'frozen.json');
  fs.mkdirSync(sessions, { recursive: true });
  fs.mkdirSync(path.dirname(paramsFile), { recursive: true });
  fs.writeFileSync(paramsFile, PREREG);
  return {
    sessions,
    paramsFile,
    gate: {
      env: { COPYHOLDER_SESSIONS_DIR: sessions, COPYHOLDER_PARAMS_FILE: paramsFile },
      now: () => new Date('2026-11-20T21:00:00Z'),
      commit: () => 'abc1234',
      log: () => undefined,
      error: () => undefined,
      tagFile: (tag) => (tag === 'gate-prereg' ? PREREG : (tags.get(tag) ?? null)),
    },
  };
}

interface Run {
  deps: ReplayDeps;
  out: string[];
  err: string[];
}

/**
 * Replay's side effects for a repository: `tag` is params/frozen.json under gate-prereg and
 * `retune` params/retune.json under gate-retune, null without the tag.
 */
function replayDeps(r: Repo, tag: string | null = PREREG, retune: string | null = null, env: NodeJS.ProcessEnv = {}): Run {
  const out: string[] = [];
  const err: string[] = [];
  const tags: Record<string, string | null> = { 'gate-prereg': tag, 'gate-retune': retune };
  return {
    out,
    err,
    deps: { env: { COPYHOLDER_PARAMS_FILE: r.paramsFile, ...env }, log: (l) => out.push(l), error: (l) => err.push(l), tagFile: (t) => tags[t] ?? null },
  };
}

/** What host writes into manifest.json for a recording with the real tap and its SDK (live/lib/manifest.cjs). */
const MEASURED = {
  tap: 'real',
  dry: false,
  sdk: { version: '3.5.0', metrics: ['CHEST_BREATHING', 'BREATHING_RATE', 'FACE_LANDMARKS', 'TALKING'], launcher: 'node' },
} as const;

/** Records with the real tap, scores with stages A and B, and returns the session folder. */
async function scored(r: Repo, id: string, o: GateSynthOptions, stageB: string[] = [], pack: 'A' | 'B' | 'C' = 'A'): Promise<string> {
  const dir = writeGateSession(r.sessions, buildGateSynth(o), id);
  // synth.ts writes pack A; the other packs follow the same scenario (as analysis/gate/retune.test.ts records them).
  const file = path.join(dir, 'manifest.json');
  fs.writeFileSync(file, `${JSON.stringify({ ...(JSON.parse(fs.readFileSync(file, 'utf8')) as object), ...MEASURED, pack, scenario: `gate-${pack}` }, null, 2)}\n`);
  expect(await gateMain(['--stage', 'A', id], r.gate)).toBe(0);
  expect(await gateMain(['--stage', 'B', id, ...stageB], r.gate)).toBe(0);
  return dir;
}

/** Files pack copies as they are (spec 8.7); manifest.json and stream.jsonl are written anew. */
const COPIED = ['events.jsonl', 'onsets.json', 'calib.json', 'clock_report.json', 'verdict.md', 'verdict.json'];

function jsonl<T>(text: string): T[] {
  return text
    .split('\n')
    .filter((l) => l.length > 0)
    .map((l) => JSON.parse(l) as T);
}

/**
 * data/<id>/ as pack writes it: the public manifest, stream.jsonl built from detector_in.jsonl
 * and stamps.jsonl, audio_env.json (levels only; replay does not read it) and the copied files;
 * audio.wav, samples.jsonl, stamps.jsonl, detector_in.jsonl, ledger.jsonl and quickcheck.json
 * stay out. With `marks`, the "mark" lines of stamps.jsonl go into marks.jsonl as they are; with
 * `resets`, the reset frames stage B found go into g_resets.json; with `sniffs`, the sniff onsets
 * stage B found go into sniff_onsets.json, as pack finds them (analysis/pack.ts sniffOnsetsJson).
 * Pack writes all three into a gate set with its verdict (pack-replay.test.ts runs pack itself);
 * without them the set is one an earlier pack wrote.
 */
function publish(session: string, out: string, o: { marks: boolean; resets?: boolean; sniffs?: boolean }): string {
  fs.mkdirSync(out, { recursive: true });
  const read = (f: string): string => fs.readFileSync(path.join(session, f), 'utf8');
  const manifest = parseJson(read('manifest.json'), validateManifest).value as Manifest;
  fs.writeFileSync(path.join(out, 'manifest.json'), toJsonText(toPublishedManifest(manifest), 'manifest.json'));
  const stream = buildStreamJsonl(read('detector_in.jsonl'), read('stamps.jsonl'));
  expect(stream.errors).toEqual([]);
  fs.writeFileSync(path.join(out, 'stream.jsonl'), stream.text!);
  fs.writeFileSync(path.join(out, 'audio_env.json'), toJsonText({ schema: 'audio-env/1', step_ms: 10, mic_db: [-90, -61.5], narrator_db: [-90, -90] }, 'audio_env.json'));
  for (const f of COPIED) fs.copyFileSync(path.join(session, f), path.join(out, f));
  if (o.marks) {
    const lines = read('stamps.jsonl').split('\n').filter((l) => l.length > 0 && (JSON.parse(l) as { k: string }).k === 'mark');
    fs.writeFileSync(path.join(out, MARKS_FILE), `${lines.join('\n')}\n`);
  }
  if (o.resets) {
    const seqs = [...gResetSeqs(jsonl<DetectorInput>(read('detector_in.jsonl')), jsonl<SampleLmLike>(read('samples.jsonl'))).seqs].sort((a, b) => a - b);
    fs.writeFileSync(path.join(out, RESETS_FILE), `${JSON.stringify({ schema: G_RESETS_SCHEMA, seqs })}\n`);
  }
  if (o.sniffs) {
    const files = new Map(['stream.jsonl', MARKS_FILE, 'calib.json'].map((f) => [f, fs.readFileSync(path.join(out, f))] as const));
    const notes: string[] = [];
    const text = sniffOnsetsJson(session, files, notes);
    expect(notes).toEqual([]);
    fs.writeFileSync(path.join(out, SNIFFS_FILE), text!);
  }
  return out;
}

function folderFiles(dir: string): Record<string, string | null> {
  return Object.fromEntries(fs.readdirSync(dir).map((f) => [f, fs.readFileSync(path.join(dir, f), 'utf8')]));
}

function copySet(from: string, to: string): string {
  fs.cpSync(from, to, { recursive: true });
  return to;
}

function editJson(file: string, f: (j: Record<string, any>) => void): void {
  const j = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, any>;
  f(j);
  fs.writeFileSync(file, `${JSON.stringify(j, null, 2)}\n`);
}

/** verdict.md written anew from verdict.json, as stage B writes it, so that it agrees with a changed verdict.json. */
function restateMd(dir: string, gradedUnrounded = false): void {
  const v = JSON.parse(fs.readFileSync(path.join(dir, 'verdict.json'), 'utf8')) as Verdict;
  fs.writeFileSync(path.join(dir, 'verdict.md'), verdictMarkdown(v, v.run, { sniff: { gradedUnrounded } }));
}

/** The console line of one value. */
function lineOf(out: readonly string[], name: string): string {
  const found = out.find((l) => l.startsWith(`  ${name} `));
  if (found === undefined) throw new Error(`no line for ${name} in:\n${out.join('\n')}`);
  return found;
}

function replayOf(dir: string, r: Repo, tag: string | null = PREREG): SetReplay {
  const set = readPublishedSet(dir);
  const params = findParams(set.verdict, { env: { COPYHOLDER_PARAMS_FILE: r.paramsFile }, tagFile: (t) => (t === 'gate-prereg' ? tag : null), paramsFile: null });
  return replaySet(set, params);
}

function checksOf(dir: string, r: Repo, tag: string | null = PREREG): Check[] {
  return replayOf(dir, r, tag).checks;
}

function last(out: readonly string[]): string {
  return out[out.length - 1]!;
}

/**
 * The last line of a verified run. A set without sniff_onsets.json leaves best_case_ms and
 * d1_on_sniffs_ms unchecked (NEVER), and the line names them; no other value may stay unchecked.
 */
const VERIFIED =
  /^replay: verified: the verdict and the five row outcomes of (the set are|all \d+ sets are) recomputed and match, and no recomputed value differs(, but these values are not recomputable from (the set|their sets) and stay unchecked: data\/[\w-]+\/ rows\.sniff_lag\.best_case_ms, rows\.sniff_lag\.d1_on_sniffs_ms(; data\/[\w-]+\/ rows\.sniff_lag\.best_case_ms, rows\.sniff_lag\.d1_on_sniffs_ms)*)? \(/;
const NOT_VERIFIED = /^replay: no recomputed value differs, but the verdict is not verified: /;
const NO_RESET = 'MATCH if no packet with g null was a reset frame';

/** Hand marks 2, 4, ... 28 ms after the automatic onsets, so that the P90 of |auto - manual| rests on single marks. */
const PLAN: ReplyPlan[] = Array.from({ length: 14 }, (_, i) => ({ kind: i < 10 ? 'inhale' : 'plain', manualShiftMs: 2 * (i + 1) }));

/** Values replay cannot have from a set without sniff_onsets.json: the recount of row 4 from audio.wav. */
const NEVER = ['rows.sniff_lag.best_case_ms', 'rows.sniff_lag.d1_on_sniffs_ms'];

describe('npm run replay on the published sets of two recordings (spec 8.7, 9.6, 9.7)', () => {
  let r: Repo;
  let setA: string;
  let bareA: string;
  let setB: string;
  let frozenAfterA: string;

  beforeAll(async () => {
    r = repo('two');
    const a = await scored(r, 'gate-a', { replies: PLAN });
    frozenAfterA = fs.readFileSync(r.paramsFile, 'utf8');
    // Stage A of the next recording writes params/frozen.json anew: other breaths give k 2.5 and theta_G 0.02.
    const lipOpenings = [80, 110, 140, 170, 200].map((t) => ({ fromS: t, toS: t + 1, rise: 0.019 }));
    const b = await scored(r, 'gate-b', { replies: PLAN, seed: 12, jitter: 0.12, lipOpenings });
    setA = publish(a, path.join(root, 'two', 'data', 'gate-a'), { marks: true });
    bareA = publish(a, path.join(root, 'two', 'bare', 'gate-a'), { marks: false });
    setB = publish(b, path.join(root, 'two', 'data', 'gate-b'), { marks: true });
  }, 180_000);

  it('builds sets that pass the published-set checks of core/schemas, marks.jsonl included', () => {
    expect(validatePublishedFolder(folderFiles(bareA))).toEqual([]);
    expect(validatePublishedFolder(folderFiles(setA))).toEqual([]);
    const tunedB = JSON.parse(fs.readFileSync(r.paramsFile, 'utf8')) as { d1: { k: number }; g: { theta_G: number } };
    expect([tunedB.d1.k, tunedB.g.theta_G]).toEqual([2.5, 0.02]);
    expect(fs.readFileSync(r.paramsFile, 'utf8')).not.toBe(frozenAfterA);
  });

  it("recomputes every value of verdict.json from a set with its marks, stage A's tuning and run 1 included, checks verdict.md, and verifies the verdict; exit 0", async () => {
    const run = replayDeps(r);
    expect(await main([setA, setB], run.deps)).toBe(0);
    expect(run.err).toEqual([]);
    const out = run.out;
    // gate-a was scored with params params/frozen.json no longer holds: rebuilt from gate-prereg and verdict.json.
    expect(out).toContain('replay data/gate-a/ (pack A, from ' + setA + ')');
    expect(out.find((l) => l.startsWith('  params: params/frozen.json under the tag gate-prereg with k 1.5'))).toBeDefined();
    expect(out.filter((l) => /^ {2}params: .*frozen\.json, hashed as stage B hashes it/.test(l))).toHaveLength(1);
    expect(out.filter((l) => l.startsWith('  note: tuning: stage A tuned k and theta_G on the listening block of this recording; replay tunes them again there'))).toHaveLength(2);
    for (const name of ['run', 'exploratory', 'tuning.k', 'tuning.criterion_met', 'tuning.theta_G', 'events.valid', 'rows.hits.hits', 'rows.lead.median_hits_ms', 'rows.false_holds.per_min', 'rows.chest_vs_lips.wins', 'misses.no_inbreath', 'verdict', 'verdict.md']) {
      expect(lineOf(out, name)).toMatch(/ MATCH$/);
    }
    expect(lineOf(out, 'params_sha256')).toMatch(/ +- +[0-9a-f]{8} +an input of the replay: replay finds the params by this hash/);
    expect(lineOf(out, 'rows.sniff_lag.best_case_ms')).toMatch(
      /not recomputable from the set: needs the sniff onsets stage B finds in audio\.wav channel 0 after the sniff_<i> step marks \(analysis\/clocks\/compute\.ts recountSniffLag\), which the set does not carry \(no sniff_onsets\.json\); replay reads no audio$/,
    );
    expect(out.some((l) => / DIFFERS$/.test(l))).toBe(false);
    expect(last(out)).toMatch(VERIFIED);
    // These sets are as an earlier pack wrote them, without sniff_onsets.json: the line names what stays unchecked.
    expect(last(out)).toBe(
      `replay: verified: the verdict and the five row outcomes of all 2 sets are recomputed and match, and no recomputed value differs, but these values are not recomputable from their sets and stay unchecked: data/gate-a/ ${NEVER.join(', ')}; data/gate-b/ ${NEVER.join(', ')} (see above; ${
        out.filter((l) => / MATCH$/.test(l)).length
      } MATCH, 0 DIFFERS, 4 not recomputable from the set, 2 inputs)`,
    );

    for (const dir of [setA, setB]) {
      const checks = checksOf(dir, r);
      expect(checks.filter((c) => c.status !== 'MATCH').map((c) => [c.name, c.status])).toEqual([['params_sha256', 'INPUT'], ...NEVER.map((n) => [n, 'NOT_RECOMPUTABLE'])]);
      expect(checks.filter((c) => c.status === 'MATCH' && c.condition === null)).toHaveLength(VERDICT_FIELDS.length + 3 - 1 - NEVER.length);
    }
  });

  it('exits 3, not 0, on a set without marks.jsonl, as pack wrote one before it published the marks: the verdict needs them, so it is not verified, also when verdict.json was changed', async () => {
    const run = replayDeps(r);
    expect(await main([bareA], run.deps)).toBe(3);
    const out = run.out;
    for (const name of ['run', 'exploratory', 'clock.L_rt_ms', 'clock.rule', 'clock.onset_p90_ms', 'rows.sniff_lag.n', 'rows.sniff_lag.hi_median_ms', 'onsets.json labels_sha256', 'verdict.md']) {
      expect(lineOf(out, name)).toMatch(/ MATCH$/);
    }
    expect(lineOf(out, 'params_sha256')).toMatch(/an input of the replay: replay finds the params by this hash/);
    // The params were rebuilt with the tuning of verdict.json: the tuning is an input here, not a result.
    for (const name of ['tuning.k', 'tuning.criterion_met', 'tuning.theta_G']) {
      expect(lineOf(out, name)).toMatch(/an input of the replay: replay rebuilt the params with this value of verdict\.json/);
    }
    for (const name of ['events.cued', 'events.valid', 'rows.hits.hits', 'rows.false_holds.in_sample_lips_per_min', 'rows.chest_vs_lips.wins', 'rows.sniff_lag.outcome', 'verdict']) {
      expect(lineOf(out, name)).toMatch(/not recomputable from the set: needs the cue and step marks of stamps\.jsonl \("mark" lines\), which the set does not carry \(no marks\.jsonl\)$/);
    }
    expect(out.some((l) => l.includes('note: stage B takes the cues and the step marks'))).toBe(true);
    expect(out.some((l) => / DIFFERS$/.test(l))).toBe(false);
    expect(last(out)).toMatch(NOT_VERIFIED);
    expect(last(out)).toMatch(
      /verified: data\/gate-a\/ row hits, row lead, row false_holds, row sniff_lag, row chest_vs_lips, verdict are not recomputable from the set or match only under a condition it does not show \(see above; \d+ MATCH, 0 DIFFERS, \d+ not recomputable from the set, 4 inputs\)$/,
    );

    // A verdict.json changed to KILL, verdict.md with it: still not verified, never exit 0.
    const dir = copySet(bareA, path.join(root, 'two', 'bare-edit', 'gate-a'));
    editJson(path.join(dir, 'verdict.json'), (v) => {
      v['rows']['hits'] = { ...v['rows']['hits'], hits: 0, armed_hits: 0, outcome: 'KILL' };
      v['verdict'] = 'KILL';
    });
    restateMd(dir);
    const edited = replayDeps(r);
    expect(await main([dir], edited.deps)).toBe(3);
    expect(lineOf(edited.out, 'rows.hits.hits')).toMatch(/ +- +0 +not recomputable from the set: needs the cue and step marks/);
    expect(last(edited.out)).toMatch(NOT_VERIFIED);

    // The table and the figure need the cues: nothing is written, exit 1.
    const json = path.join(root, 'two', 'bare.json');
    const refused = replayDeps(r);
    expect(await main([bareA, '--json', json, '--svg', `${json}.svg`], refused.deps)).toBe(1);
    expect(refused.err.join('\n')).toMatch(/^replay wrote no --json, --svg: they need the verdict and the cues of every set, and data\/gate-a\/ has no marks\.jsonl with the cue and step marks \(see the notes above\)$/);
    expect(fs.existsSync(json) || fs.existsSync(`${json}.svg`)).toBe(false);
  });

  it('reads the set of a recording with the real tap and its SDK, and refuses one of a run no SDK measured (PREREG section 11); exit 1', async () => {
    const m = JSON.parse(fs.readFileSync(path.join(setA, 'manifest.json'), 'utf8')) as Record<string, unknown>;
    expect([m['tap'], m['dry'], (m['sdk'] as { version: string }).version]).toEqual(['real', false, '3.5.0']);
    expect(readPublishedSet(setA).manifest).toMatchObject(MEASURED);
    const cases: Array<[string, Record<string, unknown>, string]> = [
      ['mock', { tap: 'mock', sdk: null }, 'tap: "mock" (the mock tap made up the chest trace)'],
      ['dry', { dry: true }, 'dry: true (tap ran its stand-in SDK)'],
      ['no-sdk', { sdk: null }, 'sdk: null (no SDK ran)'],
    ];
    for (const [name, fields, says] of cases) {
      const dir = copySet(setA, path.join(root, 'two', `rehearsal-${name}`, 'gate-a'));
      editJson(path.join(dir, 'manifest.json'), (j) => Object.assign(j, fields));
      const run = replayDeps(r);
      expect(await main([dir], run.deps)).toBe(1);
      expect(run.err).toEqual([
        `replay refused ${dir}: ${path.join(dir, 'manifest.json')} says ${says}: no SDK measured this run, so it is a rehearsal and no recording of pack A; stage B scores no such run and pack publishes none (spec 6.5, PREREG section 11). Name the set of a recording`,
      ]);
      expect(run.out.some((l) => / MATCH$/.test(l))).toBe(false);
    }
  });

  it('refuses a stream.jsonl without a packet: verdict.json holds a verdict scored on camera data', async () => {
    const dir = copySet(bareA, path.join(root, 'two', 'empty-stream', 'gate-a'));
    fs.writeFileSync(path.join(dir, 'stream.jsonl'), '');
    const run = replayDeps(r);
    expect(await main([dir], run.deps)).toBe(1);
    expect(run.err.join('\n')).toMatch(/stream\.jsonl holds no packet \(no "batch" line\), yet verdict\.json holds a verdict stage B scored on the camera data: the file is cut short or not the one pack wrote; fetch the whole folder again$/);
  });

  it('reports a changed count, row outcome or verdict word of verdict.json as DIFFERS and exits 1', async () => {
    const hits = copySet(setA, path.join(root, 'two', 'edit-hits', 'gate-a'));
    editJson(path.join(hits, 'verdict.json'), (v) => {
      v['rows']['hits']['hits'] = v['rows']['hits']['hits'] + 1;
    });
    restateMd(hits);
    const run = replayDeps(r);
    expect(await main([hits], run.deps)).toBe(1);
    expect(lineOf(run.out, 'rows.hits.hits')).toMatch(/ 10 +11 +DIFFERS$/);
    expect(lineOf(run.out, 'verdict.md')).toMatch(/ MATCH$/);
    expect(last(run.out)).toBe('replay: 1 recomputed value differs from the set: gate-a rows.hits.hits');

    const word = copySet(setA, path.join(root, 'two', 'edit-word', 'gate-a'));
    editJson(path.join(word, 'verdict.json'), (v) => {
      v['rows']['chest_vs_lips'] = { ...v['rows']['chest_vs_lips'], wins: 0, losses: 14, outcome: 'KILL' };
      v['verdict'] = 'KILL';
    });
    restateMd(word);
    const run2 = replayDeps(r);
    expect(await main([word], run2.deps)).toBe(1);
    expect(lineOf(run2.out, 'rows.chest_vs_lips.outcome')).toMatch(/ PASS +KILL +DIFFERS$/);
    expect(lineOf(run2.out, 'verdict')).toMatch(/ PASS +KILL +DIFFERS$/);
    expect(last(run2.out)).toBe(
      'replay: 4 recomputed values differ from the set: gate-a rows.chest_vs_lips.outcome, gate-a rows.chest_vs_lips.wins, gate-a rows.chest_vs_lips.losses, gate-a verdict',
    );
  });

  it('tunes stage A again on pack A: a k stage A did not find differs, even with params_sha256 set to match it', async () => {
    const dir = copySet(setA, path.join(root, 'two', 'edit-k', 'gate-a'));
    const prereg = parseParamsText(PREREG, 'frozen.json').value!;
    const forged = frozenParamsText(frozenWithTuning(withoutStageAKeys(prereg), { k: 2.5, criterionMet: true, thetaG: 0.01, step: 'stage_a' }));
    editJson(path.join(dir, 'verdict.json'), (v) => {
      v['tuning']['k'] = 2.5;
      v['params_sha256'] = sha256Hex(forged);
    });
    restateMd(dir);
    const run = replayDeps(r);
    expect(await main([dir], run.deps)).toBe(1);
    expect(run.out.find((l) => l.startsWith('  params: '))).toMatch(/with k 2\.5, criterion_met true and theta_G 0\.01 of verdict\.json, written as stage A writes params\/frozen\.json/);
    expect(lineOf(run.out, 'tuning.k')).toMatch(/ 1\.5 +2\.5 +DIFFERS$/);
    expect(lineOf(run.out, 'params_sha256')).toMatch(/an input of the replay/);
  });

  it('checks run and exploratory (stage B writes verdict.json on its confirmatory run 1) and verdict.md against verdict.json', async () => {
    const runs = copySet(setA, path.join(root, 'two', 'edit-run', 'gate-a'));
    editJson(path.join(runs, 'verdict.json'), (v) => {
      v['run'] = 2;
      v['exploratory'] = true;
    });
    restateMd(runs);
    const run = replayDeps(r);
    expect(await main([runs], run.deps)).toBe(1);
    expect(lineOf(run.out, 'run')).toMatch(/ 1 +2 +DIFFERS$/);
    expect(lineOf(run.out, 'exploratory')).toMatch(/ false +true +DIFFERS$/);
    expect(lineOf(run.out, 'verdict.md')).toMatch(/ MATCH$/);

    const md = copySet(setA, path.join(root, 'two', 'edit-md', 'gate-a'));
    const text = fs.readFileSync(path.join(md, 'verdict.md'), 'utf8');
    expect(text).toContain('\nVERDICT PASS\n');
    fs.writeFileSync(path.join(md, 'verdict.md'), text.replace('\nVERDICT PASS\n', '\nVERDICT KILL\n'));
    const run2 = replayDeps(r);
    expect(await main([md], run2.deps)).toBe(1);
    expect(lineOf(run2.out, 'verdict.md')).toMatch(/ [0-9a-f]{8} +[0-9a-f]{8} +DIFFERS$/);
    expect(run2.out).toContain(
      `  note: verdict.md line ${text.split('\n').indexOf('VERDICT PASS') + 1} reads "VERDICT KILL", where stage B writes "VERDICT PASS" from verdict.json (analysis/gate/verdict-text.ts)`,
    );
    expect(lineOf(run2.out, 'verdict')).toMatch(/ PASS +PASS +MATCH$/);

    // A line added at the end is named too.
    const added = copySet(setA, path.join(root, 'two', 'edit-md-end', 'gate-a'));
    fs.writeFileSync(path.join(added, 'verdict.md'), `${text}VERDICT KILL\n`);
    const run4 = replayDeps(r);
    expect(await main([added], run4.deps)).toBe(1);
    expect(run4.out).toContain(
      `  note: verdict.md line ${text.split('\n').length} reads "VERDICT KILL", where stage B writes "" from verdict.json (analysis/gate/verdict-text.ts)`,
    );

    const gone = copySet(setA, path.join(root, 'two', 'no-md', 'gate-a'));
    fs.rmSync(path.join(gone, 'verdict.md'));
    const run3 = replayDeps(r);
    expect(await main([gone], run3.deps)).toBe(1);
    expect(run3.err[0]).toBe(`replay refused ${gone}: ${path.join(gone, 'verdict.md')} is missing: pack copies it with verdict.json, which is here (spec 8.7); fetch the whole folder again`);
  });

  it('reports the values a changed hand mark changes, and exits 1', async () => {
    const dir = path.join(root, 'two', 'hand', 'gate-a');
    fs.cpSync(setA, dir, { recursive: true });
    const onsets = JSON.parse(fs.readFileSync(path.join(dir, 'onsets.json'), 'utf8')) as Onsets;
    // The hand mark 26 ms after the automatic onset moves to 100 ms after it.
    const e = onsets.events.find((x) => x.id === 'o13')!;
    e.manual = { ...e.manual!, n_v: e.auto.n_v + 4800 };
    fs.writeFileSync(path.join(dir, 'onsets.json'), toJsonText(onsets, 'onsets.json'));
    const run = replayDeps(r);
    expect(await main([dir], run.deps)).toBe(1);
    const out = run.out;
    expect(lineOf(out, 'onsets.json labels_sha256')).toMatch(/ DIFFERS$/);
    // P90 of |auto - manual| over 2, 4, ... 28 ms is 25.4 ms; with 100 for 26 it is 26.8 ms.
    expect(lineOf(out, 'clock_report.json onset.p90_abs_auto_minus_manual_ms')).toMatch(/ 26\.8 +25\.4 +DIFFERS$/);
    expect(lineOf(out, 'clock.onset_p90_ms')).toMatch(/ 26\.8 +25\.4 +DIFFERS$/);
    expect(lineOf(out, 'rows.hits.hits')).toMatch(/ 10 +10 +MATCH$/);
    expect(last(out)).toBe(
      'replay: 3 recomputed values differ from the set: gate-a clock.onset_p90_ms, gate-a onsets.json labels_sha256, gate-a clock_report.json onset.p90_abs_auto_minus_manual_ms',
    );
  });

  it('refuses params whose hash is not the one of verdict.json, after every place it looks', async () => {
    const other = parseParamsText(frozenAfterA, 'frozen.json').value as Record<string, any>;
    other['hold'] = { ...other['hold'], H_ms: other['hold']['H_ms'] + 100 };
    const file = path.join(root, 'two', 'other-params.json');
    fs.writeFileSync(file, frozenParamsText(other));
    const run = replayDeps(r, null);
    expect(await main([setA, '--params', file], run.deps)).toBe(1);
    const sha = (JSON.parse(fs.readFileSync(path.join(setA, 'verdict.json'), 'utf8')) as { params_sha256: string }).params_sha256;
    expect(run.err.join('\n')).toMatch(
      new RegExp(
        `^replay refused ${setA.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}: no params give the params_sha256 of verdict\\.json \\(${sha.slice(0, 8)}\\); tried .*other-params\\.json \\([0-9a-f]{8}\\); params/retune\\.json under the tag gate-retune \\(not in this copy of the repository\\); params/frozen\\.json under the tag gate-prereg \\(not in this copy of the repository\\); .*other-params\\.json without k, theta_G and tuned with k 1\\.5, criterion_met true and theta_G 0\\.01 of verdict\\.json \\([0-9a-f]{8}\\)\\. Name the params file stage B scored with --params <file>, or fetch the tags \\(git fetch --tags\\) so that replay can find it under gate-retune or rebuild it from gate-prereg \\(spec 8\\.4, 8\\.5\\)$`,
      ),
    );
    expect(run.out.some((l) => l.includes(' MATCH'))).toBe(false);

    // The params of gate-a itself, named with --params, are found as they are, and stage A's tuning is recomputed.
    const own = path.join(root, 'two', 'params-a.json');
    fs.writeFileSync(own, frozenAfterA);
    const named = replayDeps(r, null);
    expect(await main([setA, '--params', own], named.deps)).toBe(0);
    expect(named.out.find((l) => l.startsWith('  params: '))).toMatch(/params-a\.json, hashed as stage B hashes it; sha256 [0-9a-f]{8}, as verdict\.json holds it$/);
    expect(lineOf(named.out, 'tuning.k')).toMatch(/ 1\.5 +1\.5 +MATCH$/);
  });

  it('finds params/retune.json under the tag gate-retune when the working copy no longer holds it (PREREG §11)', async () => {
    // As if gate-a's params had been frozen as the retune: no retune.json at hand, frozen.json is gate-b's, no gate-prereg tag.
    const run = replayDeps(r, null, frozenAfterA);
    expect(await main([setA], run.deps)).toBe(0);
    expect(run.out.find((l) => l.startsWith('  params: '))).toMatch(/^ {2}params: params\/retune\.json under the tag gate-retune, hashed as stage B hashes it; sha256 [0-9a-f]{8}, as verdict\.json holds it$/);
    expect(last(run.out)).toMatch(VERIFIED);
  });

  it('rebuilds the params of an earlier recording without the tag, from params/frozen.json without what stage A writes', async () => {
    const run = replayDeps(r, null);
    expect(await main([setA], run.deps)).toBe(0);
    expect(run.out.find((l) => l.startsWith('  params: '))).toMatch(
      /^ {2}params: .*frozen\.json without k, theta_G and tuned with k 1\.5, criterion_met true and theta_G 0\.01 of verdict\.json, written as stage A writes params\/frozen\.json; sha256/,
    );
    expect(sha256Hex(frozenAfterA)).toBe((JSON.parse(fs.readFileSync(path.join(setA, 'verdict.json'), 'utf8')) as { params_sha256: string }).params_sha256);
  });

  it('writes one table row per cue, with the counts of verdict.json, and checks the table against the recomputed verdict', async () => {
    const file = path.join(root, 'two', 'out', 'replay.json');
    const run = replayDeps(r);
    expect(await main([setA, setB, '--json', file], run.deps)).toBe(0);
    expect(run.out).toContain(`replay: wrote ${file} (28 cues)`);
    const table = JSON.parse(fs.readFileSync(file, 'utf8')) as ReplayTable;
    expect(table.schema).toBe('replay-table/2');
    expect(table.rows).toHaveLength(28);
    expect(table.sets.map((s) => [s.id, s.pack, s.set, s.cues, s.valid, s.g_resets, s.lips_unknown])).toEqual([
      ['gate-a', 'A', 'data/gate-a/', 14, 14, 'no packet with g null', []],
      ['gate-b', 'A', 'data/gate-b/', 14, 14, 'no packet with g null', []],
    ]);
    for (const [id, dir] of [['gate-a', setA], ['gate-b', setB]] as const) {
      const v = JSON.parse(fs.readFileSync(path.join(dir, 'verdict.json'), 'utf8')) as Record<string, any>;
      const rows = table.rows.filter((x) => x.id === id);
      expect(rows.map((x) => x.cue)).toEqual(Array.from({ length: 14 }, (_, i) => i + 1));
      expect(rows.filter((x) => x.valid)).toHaveLength(v['events']['valid']);
      expect(rows.filter((x) => x.result === 'hit')).toHaveLength(v['rows']['hits']['hits']);
      expect(rows.filter((x) => x.armed === true)).toHaveLength(v['events']['armed']);
      expect(rows.filter((x) => x.audible_inbreath === true)).toHaveLength(v['events']['audible_inbreath']);
      expect(rows.every((x) => x.lips !== null && x.lips_why === null)).toBe(true);
      // Leads keep stage B's sign: the hits lead the voice.
      expect(rows.filter((x) => x.result === 'hit').every((x) => x.chest!.lead_ms! > 0 && x.chest!.stop_ms! < x.voice_onset_ms!)).toBe(true);
      expect(rows.every((x) => x.manual_mark === true && x.manual_onset_ms! > x.voice_onset_ms!)).toBe(true);
    }
    // Times and counts only: no text of the pack, no word, nothing of the narrator.
    const keys = new Set(table.rows.flatMap((x) => Object.keys(x)));
    expect([...keys].sort()).toEqual(
      ['armed', 'audible_inbreath', 'chest', 'cue', 'cue_ms', 'false_stops', 'id', 'lips', 'lips_why', 'manual_mark', 'manual_onset_ms', 'pack', 'result', 'valid', 'voice_onset_ms', 'why_not'].sort(),
    );

    // The check before writing: rows that no longer add up to the recomputed verdict are named.
    const replayed = [replayOf(setA, r)] as (SetReplay & { scored: ScoredSet })[];
    const own = replayTable(replayed);
    expect(tableProblems(own, replayed)).toEqual([]);
    const first = own.rows[0]!;
    expect([first.result, first.armed]).toEqual(['hit', true]);
    own.rows[0] = { ...first, result: 'miss', armed: false, false_stops: { ...first.false_stops, chest: first.false_stops.chest + 1 } };
    expect(tableProblems(own, replayed)).toEqual([
      'data/gate-a/: 9 hits in the table, 10 in the recomputed verdict',
      'data/gate-a/: 13 armed objections in the table, 14 in the recomputed verdict',
      expect.stringMatching(/^data\/gate-a\/: \d+ chest false stops in the table, \d+ in the recomputed verdict$/),
    ]);
  });

  it('refuses a set with verdict.md but without verdict.json, or with a broken file, names the file, and goes on with the other sets', async () => {
    const dir = path.join(root, 'two', 'broken', 'gate-a');
    fs.cpSync(setA, dir, { recursive: true });
    fs.rmSync(path.join(dir, 'verdict.json'));
    const marks = path.join(root, 'two', 'broken-marks', 'gate-a');
    fs.cpSync(setA, marks, { recursive: true });
    fs.appendFileSync(path.join(marks, MARKS_FILE), '{"n":5,"k":"arr","seq":3}\n');
    const run = replayDeps(r);
    expect(await main([dir, path.join(root, 'two', 'nothing-here'), marks, setB], run.deps)).toBe(1);
    expect(run.err[0]).toBe(
      `replay refused ${dir}: ${path.join(dir, 'verdict.md')} is here, but verdict.json is not: pack copies the two together (spec 8.7); fetch the whole folder again`,
    );
    expect(run.err[1]).toMatch(/^replay refused .*nothing-here: .*nothing-here is not a folder: name a published set, data\/<id>\/, or its id$/);
    expect(run.err[2]).toMatch(/marks\.jsonl is not valid \(core\/schemas\):\n {2}marks\.jsonl line \d+: k: expected "mark", got "arr": marks\.jsonl holds only the "mark" lines of stamps\.jsonl$/);
    expect(run.out).toContain(`replay data/gate-b/ (pack A, from ${setB})`);
    expect(last(run.out)).toBe('replay: 3 of 4 sets refused (see above)');

    // A set with verdict.json but without onsets.json: pack copies both, so the folder is not whole.
    const noOnsets = copySet(setA, path.join(root, 'two', 'no-onsets', 'gate-a'));
    fs.rmSync(path.join(noOnsets, 'onsets.json'));
    const run2 = replayDeps(r);
    expect(await main([noOnsets], run2.deps)).toBe(1);
    expect(run2.err[0]).toBe(`replay refused ${noOnsets}: ${path.join(noOnsets, 'onsets.json')} is missing: pack copies it with verdict.json, which is here (spec 8.7); fetch the whole folder again`);
  });

  it('refuses a marks.jsonl line that is not as pack copies it from stamps.jsonl: a key given twice would publish a value no check reads', async () => {
    const dir = copySet(setA, path.join(root, 'two', 'twice', 'gate-a'));
    const file = path.join(dir, MARKS_FILE);
    const lines = splitJsonlLines(fs.readFileSync(file, 'utf8'));
    // A step mark whose name is given twice: JSON.parse keeps the second, a step name, and the first is text.
    const step = lines.findIndex((l) => (JSON.parse(l) as { what: string }).what === 'step');
    lines[step] = lines[step]!.replace('"name":', '"name":"Breathe in, then speak","name":');
    fs.writeFileSync(file, `${lines.join('\n')}\n`);
    expect((JSON.parse(lines[step]!) as { name: string }).name).toMatch(/^[a-z0-9_]+$/);
    const run = replayDeps(r);
    expect(await main([dir], run.deps)).toBe(1);
    expect(run.err).toEqual([
      `replay refused ${dir}: ${file} is not as pack writes it:\n  marks.jsonl line ${step + 1}: not as JSON.stringify writes its value (a key given twice, a space or an escape differs), as Deck writes every mark line and pack publishes it unchanged; a key given twice would publish a value that no check reads\n  Fetch the whole folder again`,
    ]);
  });

  it('checks a set without verdict.json, as pack writes one for a recording that never reached its verdict: nothing differs, and there is no verdict to verify; exit 3', async () => {
    const dir = copySet(setA, path.join(root, 'two', 'no-verdict', 'gate-a'));
    for (const f of ['verdict.json', 'verdict.md']) fs.rmSync(path.join(dir, f));
    const run = replayDeps(r);
    expect(await main([dir], run.deps)).toBe(3);
    expect(run.err).toEqual([]);
    const out = run.out;
    expect(out).toContain(`replay data/gate-a/ (pack A, from ${dir})`);
    expect(out.some((l) => l.startsWith('  params: '))).toBe(false);
    expect(out).toContain(
      '  note: replay read manifest.json, stream.jsonl, marks.jsonl, onsets.json, calib.json and clock_report.json of this set and found each valid (core/schemas); with no verdict it scores nothing',
    );
    expect(lineOf(out, 'verdict')).toMatch(
      / +- +- +not recomputable from the set: the set has no verdict\.json, so it holds no verdict to recompute: pack writes none for a recording that never reached its verdict, because it does not count or stage B has not run on it \(PREREG sections 7 and 11\)$/,
    );
    expect(lineOf(out, 'onsets.json labels_sha256')).toMatch(/ MATCH$/);
    expect(lineOf(out, 'clock_report.json onset.p90_abs_auto_minus_manual_ms')).toMatch(/ MATCH$/);
    expect(out.some((l) => / DIFFERS$/.test(l))).toBe(false);
    expect(last(out)).toBe(
      'replay: no recomputed value differs, but the verdict is not verified: data/gate-a/ verdict is not recomputable from the set or matches only under a condition it does not show (see above; 2 MATCH, 0 DIFFERS, 1 not recomputable from the set, 0 inputs)',
    );

    // Without onsets.json, as pack A writes the set while part B is held back (PREREG section 7.5),
    // beside a set with its verdict: that one is verified, the run is not.
    fs.rmSync(path.join(dir, 'onsets.json'));
    const cut = replayDeps(r);
    expect(await main([setA, dir], cut.deps)).toBe(3);
    expect(cut.out).toContain(
      '  note: a set of pack A without a verdict and without onsets.json may end at the step mark of the objection block: pack holds part B back until the stage A hash is in the ledger, and this recording never got one (PREREG section 7.5)',
    );
    expect(cut.out.filter((l) => l.startsWith('  onsets.json ') || l.startsWith('  clock_report.json '))).toHaveLength(2);
    expect(last(cut.out)).toMatch(/^replay: no recomputed value differs, but the verdict is not verified: data\/gate-a\/ verdict is not recomputable/);

    // The table and the figure need a verdict: nothing is written, exit 1.
    const json = path.join(root, 'two', 'no-verdict.json');
    const refused = replayDeps(r);
    expect(await main([dir, '--json', json], refused.deps)).toBe(1);
    expect(refused.err).toEqual(['replay wrote no --json: it needs the verdict and the cues of every set, and data/gate-a/ has no verdict.json (see the notes above)']);
    expect(fs.existsSync(json)).toBe(false);

    // Its files are checked all the same: a g_resets.json that names a packet with a g value, or one without stream.jsonl.
    const withG = jsonl<{ k: string; seq: number; g?: number | null }>(fs.readFileSync(path.join(dir, 'stream.jsonl'), 'utf8')).find((l) => l.k === 'batch' && typeof l.g === 'number')!;
    fs.writeFileSync(path.join(dir, RESETS_FILE), `${JSON.stringify({ schema: G_RESETS_SCHEMA, seqs: [withG.seq] })}\n`);
    const bad = replayDeps(r);
    expect(await main([dir], bad.deps)).toBe(1);
    expect(bad.err[0]).toMatch(new RegExp(`g_resets\\.json lists seq ${withG.seq}, which is no packet of stream\\.jsonl with g null`));
    fs.rmSync(path.join(dir, 'stream.jsonl'));
    const noStream = replayDeps(r);
    expect(await main([dir], noStream.deps)).toBe(1);
    expect(noStream.err[0]).toBe(
      `replay refused ${dir}: ${path.join(dir, RESETS_FILE)} names packets of stream.jsonl, which the set does not hold: pack writes the two together; fetch the whole folder again`,
    );
  });

  it('refuses marks.jsonl that does not fit onsets.json: marks of another recording', async () => {
    const dir = copySet(setA, path.join(root, 'two', 'moved-cue', 'gate-a'));
    const file = path.join(dir, MARKS_FILE);
    const lines = fs.readFileSync(file, 'utf8').split('\n').filter((l) => l.length > 0);
    // Cue 5 moves 60 s later: its reply now ends before it.
    const moved = lines.map((l) => {
      const m = JSON.parse(l) as { n: number; what: string; i?: number };
      return m.what === 'cue' && m.i === 5 ? JSON.stringify({ ...m, n: m.n + 60 * 48_000 }) : l;
    });
    expect(moved).not.toEqual(lines);
    fs.writeFileSync(file, `${moved.join('\n')}\n`);
    const run = replayDeps(r);
    expect(await main([dir], run.deps)).toBe(1);
    const lines2 = run.err.join('\n').split('\n');
    expect(lines2[0]).toBe(`replay refused ${dir}: ${file} does not fit onsets.json, so its marks are not the ones of this recording:`);
    expect(lines2).toContain('  its cues in time order are numbered 1, 2, 3, 4, 6, 7, 8, 5, 9, 10, 11, 12, 13, 14: the numbers do not rise');
    expect(lines2.some((l) => /^ {2}o05 ends at sample \d+, before the mark of cue 5 at \d+$/.test(l))).toBe(true);
    expect(lines2[lines2.length - 1]).toBe('  Fetch the set again, or take marks.jsonl out of the folder to replay it without the marks');
  });

  it('refuses a file of the set that leads out of its folder through a link', async () => {
    const dir = copySet(setA, path.join(root, 'two', 'linked', 'gate-a'));
    fs.rmSync(path.join(dir, 'verdict.json'));
    fs.symlinkSync(path.join(setB, 'verdict.json'), path.join(dir, 'verdict.json'));
    const run = replayDeps(r);
    expect(await main([dir], run.deps)).toBe(1);
    expect(run.err[0]).toMatch(/verdict\.json leads out of the set folder \(to .*gate-b.verdict\.json\): replay reads only the files of the set itself; copy the file into the folder$/);
  });

  it('draws one circle per valid objection in each row, with the labels, the title and the footnote', async () => {
    const file = path.join(root, 'two', 'out', 'replay.svg');
    const run = replayDeps(r);
    expect(await main([setA, setB, '--svg', file], run.deps)).toBe(0);
    const svg = fs.readFileSync(file, 'utf8');
    expect(svg.match(/<circle /g)).toHaveLength(2 * 28);
    for (const label of ['chest D1 (n = 28)', 'lips G (n = 28)', 'no stop', '>-1500<', '>-1000<', '>-500<', '>0<', '>+500<']) expect(svg).toContain(label);
    expect(svg).toContain('Stops around the voice onset, gate pack A');
    expect(svg).toContain('recomputed from data/gate-a/ and data/gate-b/ by npm run replay');
    expect(svg).toContain("Stage B's lead is t_v - t_s, the same value with the sign turned.");
    expect(svg).toMatch(/<rect x="0" y="0" width="600" height="\d+" fill="#ffffff"\/>/);
    // Plain SVG: no script, no link, no font file.
    expect(svg).not.toMatch(/<script|href=|@import|@font-face|url\(/);
  });
});

describe('a set whose stream.jsonl has packets with g null (spec 7.5, 8.1)', () => {
  // Lips that part 0.7 s before every voice: the lips lead the chest, so row 5 reads KILL.
  const lipsFirst = (i: number): ReplyPlan => ({ kind: i < 9 ? 'inhale' : 'plain', lipLeadS: 0.7 });
  let r1: Repo;
  let one: string;
  let r14: Repo;
  let fourteen: string;
  let session14: string;

  beforeAll(async () => {
    // One packet without a landmark frame 0.2 s before the lips of cue 3 part; cue 14 gets no reply.
    r1 = repo('noframe-1');
    const replies1: ReplyPlan[] = Array.from({ length: 14 }, (_, i) => (i === 13 ? { kind: 'none' } : lipsFirst(i)));
    const cue3 = buildGateSynth({ replies: replies1 }).truth[2]!.voiceS!;
    one = publish(await scored(r1, 'gate-a', { replies: replies1, noFrameAtS: [cue3 - 0.9] }), path.join(root, 'noframe-1', 'data', 'gate-a'), { marks: true });
    // Such a packet before every reply. Stage B knows from samples.jsonl that these are no reset; stream.jsonl does not.
    r14 = repo('noframe-14');
    const replies14 = Array.from({ length: 14 }, (_, i) => lipsFirst(i));
    const noFrameAtS = buildGateSynth({ replies: replies14 }).truth.map((t) => t.voiceS! - 0.9);
    session14 = await scored(r14, 'gate-a', { replies: replies14, noFrameAtS });
    fourteen = publish(session14, path.join(root, 'noframe-14', 'data', 'gate-a'), { marks: true });
  }, 180_000);

  it('one packet: values both readings give alike are checked as any other; those they give differently match under the reading that gives them all; exit 0', async () => {
    const run = replayDeps(r1);
    expect(await main([one], run.deps)).toBe(0);
    const out = run.out;
    expect(out.some((l) => l.startsWith('  note: G: 1 packet of stream.jsonl carries g null; it is a reset frame of G or a packet without a landmark frame'))).toBe(true);
    expect(lineOf(out, 'rows.chest_vs_lips.losses')).toMatch(new RegExp(` 13 +13 +${NO_RESET}$`));
    expect(lineOf(out, 'rows.chest_vs_lips.wins')).toMatch(new RegExp(` 0 +0 +${NO_RESET}$`));
    // The verdict and row 5's outcome are the same under both readings: verified.
    expect(lineOf(out, 'rows.chest_vs_lips.outcome')).toMatch(/ KILL +KILL +MATCH$/);
    expect(lineOf(out, 'verdict')).toMatch(/ KILL +KILL +MATCH$/);
    expect(last(out)).toMatch(VERIFIED);
  });

  it('one packet: a changed verdict or row 5 differs, since the two readings cover every case', async () => {
    const word = copySet(one, path.join(root, 'noframe-1', 'edit-word', 'gate-a'));
    editJson(path.join(word, 'verdict.json'), (v) => {
      // core/schemas refuses a verdict that does not follow from the rows, so both change.
      v['rows']['chest_vs_lips']['outcome'] = 'PASS';
      v['verdict'] = 'PASS';
    });
    restateMd(word);
    const run = replayDeps(r1);
    expect(await main([word], run.deps)).toBe(1);
    expect(lineOf(run.out, 'rows.chest_vs_lips.outcome')).toMatch(/ KILL +PASS +DIFFERS$/);
    expect(lineOf(run.out, 'verdict')).toMatch(/ KILL +PASS +DIFFERS$/);

    // Row 5 counts no one reading gives together with the rest of verdict.json.
    const mixed = copySet(one, path.join(root, 'noframe-1', 'edit-mixed', 'gate-a'));
    editJson(path.join(mixed, 'verdict.json'), (v) => {
      v['rows']['chest_vs_lips'] = { ...v['rows']['chest_vs_lips'], wins: 1, losses: 12 };
    });
    restateMd(mixed);
    const run2 = replayDeps(r1);
    expect(await main([mixed], run2.deps)).toBe(1);
    expect(lineOf(run2.out, 'rows.chest_vs_lips.wins')).toMatch(/ +1 +DIFFERS$/);
    expect(lineOf(run2.out, 'rows.chest_vs_lips.losses')).toMatch(/ +12 +DIFFERS$/);
    expect(run2.out.some((l) => / MATCH if /.test(l))).toBe(false);
  });

  it('one packet: the table and the figure leave out the lips stop of that cue only, and say so; a cue without a valid objection has no in-breath', async () => {
    const json = path.join(root, 'noframe-1', 'out.json');
    const svg = path.join(root, 'noframe-1', 'out.svg');
    const run = replayDeps(r1);
    expect(await main([one, '--json', json, '--svg', svg], run.deps)).toBe(0);
    const table = JSON.parse(fs.readFileSync(json, 'utf8')) as ReplayTable;
    expect(table.sets[0]!.g_resets).toBe('both readings: every packet with g null a reset frame, and none');
    expect(table.sets[0]!.lips_unknown).toEqual([3]);
    const cue3 = table.rows.find((x) => x.cue === 3)!;
    expect([cue3.valid, cue3.lips, cue3.chest !== null]).toEqual([true, null, true]);
    expect(cue3.lips_why).toBe('the readings of the packets with g null place this stop differently; stream.jsonl does not say which were reset frames (g_resets.json would)');
    expect(table.rows.filter((x) => x.cue !== 3 && x.valid).every((x) => x.lips !== null)).toBe(true);
    const cue14 = table.rows.find((x) => x.cue === 14)!;
    expect([cue14.valid, cue14.why_not, cue14.audible_inbreath, cue14.armed, cue14.chest, cue14.lips, cue14.lips_why]).toEqual([false, 'no reply', null, null, null, null, null]);
    const drawn = fs.readFileSync(svg, 'utf8');
    expect(drawn).toContain('chest D1 (n = 13)');
    expect(drawn).toContain('lips G (n = 12)');
    expect(drawn).toMatch(/the lips row leaves out data\/gate-a\/ cue 3: stream\.jsonl does not say which packets with g null were/);
  });

  it('fourteen packets: values only the reading of no reset gives match under that condition, and the verdict is not verified; exit 3', async () => {
    const svg = path.join(root, 'noframe-14', 'g.svg');
    const run = replayDeps(r14);
    expect(await main([fourteen, '--svg', svg], run.deps)).toBe(3);
    const out = run.out;
    expect(out.some((l) => l.startsWith('  note: G: 14 packets of stream.jsonl carry g null, each a reset frame of G or a packet without a landmark frame'))).toBe(true);
    expect(lineOf(out, 'rows.chest_vs_lips.losses')).toMatch(new RegExp(` 14 +14 +${NO_RESET}$`));
    expect(lineOf(out, 'verdict')).toMatch(new RegExp(` KILL +KILL +${NO_RESET}$`));
    expect(lineOf(out, 'rows.hits.hits')).toMatch(/ MATCH$/);
    expect(last(out)).toMatch(/^replay: no recomputed value differs, but the verdict is not verified: data\/gate-a\/ row chest_vs_lips, verdict are not recomputable/);
    const drawn = fs.readFileSync(svg, 'utf8');
    expect(drawn).toContain('lips G (n = 0)');
    expect(drawn).toContain('chest D1 (n = 14)');
    expect(drawn.match(/<circle /g)).toHaveLength(14);
  });

  it('fourteen packets: a changed value of G that neither reading gives is not recomputable, never a MATCH; exit 3', async () => {
    const dir = copySet(fourteen, path.join(root, 'noframe-14', 'edit', 'gate-a'));
    editJson(path.join(dir, 'verdict.json'), (v) => {
      v['rows']['chest_vs_lips'] = { ...v['rows']['chest_vs_lips'], wins: 5, losses: 9 };
    });
    restateMd(dir);
    const run = replayDeps(r14);
    expect(await main([dir], run.deps)).toBe(3);
    expect(lineOf(run.out, 'rows.chest_vs_lips.wins')).toMatch(/ +5 +not recomputable from the set: neither reading of the 14 packets of stream\.jsonl with g null gives it, every one a reset frame or none/);
    expect(lineOf(run.out, 'verdict')).toMatch(/not recomputable from the set: verdict\.json holds the value replay finds if no packet with g null was a reset frame, but no one reading gives every value/);
    expect(run.out.some((l) => / MATCH if /.test(l))).toBe(false);
  });

  it('with g_resets.json the reset frames are known: every value of G is recomputed and verified, and the figure keeps every lips stop', async () => {
    const dir = publish(session14, path.join(root, 'noframe-14', 'resets', 'gate-a'), { marks: true, resets: true });
    expect(JSON.parse(fs.readFileSync(path.join(dir, RESETS_FILE), 'utf8'))).toEqual({ schema: G_RESETS_SCHEMA, seqs: [] });
    const svg = path.join(root, 'noframe-14', 'resets.svg');
    const run = replayDeps(r14);
    expect(await main([dir, '--svg', svg], run.deps)).toBe(0);
    expect(run.out.some((l) => l.startsWith('  note: G: the reset frames are the 0 packets g_resets.json lists'))).toBe(true);
    expect(lineOf(run.out, 'rows.chest_vs_lips.losses')).toMatch(/ 14 +14 +MATCH$/);
    expect(last(run.out)).toMatch(VERIFIED);
    expect(fs.readFileSync(svg, 'utf8')).toContain('lips G (n = 14)');

    // A packet g_resets.json names must carry g null in stream.jsonl.
    const withG = jsonl<{ k: string; seq: number; g?: number | null }>(fs.readFileSync(path.join(dir, 'stream.jsonl'), 'utf8')).find((l) => l.k === 'batch' && typeof l.g === 'number')!;
    fs.writeFileSync(path.join(dir, RESETS_FILE), `${JSON.stringify({ schema: G_RESETS_SCHEMA, seqs: [withG.seq] })}\n`);
    const run2 = replayDeps(r14);
    expect(await main([dir], run2.deps)).toBe(1);
    expect(run2.err[0]).toMatch(new RegExp(`g_resets\\.json lists seq ${withG.seq}, which is no packet of stream\\.jsonl with g null: live/reduce\\.cjs writes g null on every reset frame`));
  });
});

describe('row 4 recounted from sniff_onsets.json (spec 6.3, 9.6, PREREG §4)', () => {
  let r: Repo;
  let session: string;
  let set: string;

  beforeAll(async () => {
    r = repo('sniffs');
    // Five sniffs before the listening block, and no sniff block in calib.json: stage B recounted row 4 from audio.wav.
    session = await scored(r, 'gate-a', { replies: PLAN, sniffs: true, sniffLag: null });
    set = publish(session, path.join(root, 'sniffs', 'data', 'gate-a'), { marks: true, resets: true, sniffs: true });
  }, 120_000);

  it('recounts every number of row 4 from the onsets when calib.json has no sniff block, as stage B did, and every value of verdict.json matches; calib.json differs, since the clocks step writes the block of a lag it measures: exit 1', async () => {
    const v = JSON.parse(fs.readFileSync(path.join(set, 'verdict.json'), 'utf8')) as Verdict;
    expect(v.rows.sniff_lag.n).toBe(5);
    expect(v.rows.sniff_lag.best_case_ms).toBeGreaterThan(0);
    expect(v.rows.sniff_lag.d1_on_sniffs_ms).toBeGreaterThan(0);
    const run = replayDeps(r);
    expect(await main([set], run.deps)).toBe(1);
    expect(run.err).toEqual([]);
    for (const name of ['outcome', 'lo_median_ms', 'hi_median_ms', 'median_over_ms', 'n', 'no_arrival', 'best_case_ms', 'd1_on_sniffs_ms']) {
      expect(lineOf(run.out, `rows.sniff_lag.${name}`)).toMatch(/ MATCH$/);
    }
    expect(lineOf(run.out, 'verdict')).toMatch(/ MATCH$/);
    expect(lineOf(run.out, 'verdict.md')).toMatch(/ MATCH$/);
    expect(run.out).toContain(
      '  note: row 4: replay recounts the sniff lag as stage B does (analysis/clocks/compute.ts recountSniffLag), from the 5 sniff onsets sniff_onsets.json lists, the trace of stream.jsonl and calib.json, and D1 on sniffs from those onsets (analysis/gate/sniffs.ts sniffRow)',
    );
    expect(lineOf(run.out, 'calib.json sniff_lag_ms')).toMatch(/ [0-9a-f]{8} +null +DIFFERS$/);
    expect(checksOf(set, r).filter((c) => c.status !== 'MATCH' || c.condition !== null).map((c) => c.name)).toEqual(['params_sha256', 'calib.json sniff_lag_ms']);
    expect(last(run.out)).toBe('replay: 1 recomputed value differs from the set: gate-a calib.json sniff_lag_ms');

    // With the block the clocks step writes for that lag, whose numbers row 4 holds, the set is verified: exit 0.
    const block = copySet(set, path.join(root, 'sniffs', 'block', 'gate-a'));
    const row = v.rows.sniff_lag;
    editJson(path.join(block, 'calib.json'), (c) => {
      expect(c['sniff_lag_ms'] ?? null).toBeNull();
      c['sniff_lag_ms'] = { n: row.n, no_arrival: row.no_arrival, lo_median: row.lo_median_ms, hi_median: row.hi_median_ms, median_over_ms: row.median_over_ms };
    });
    const measured = replayDeps(r);
    expect(await main([block], measured.deps)).toBe(0);
    expect(lineOf(measured.out, 'calib.json sniff_lag_ms')).toMatch(/ ([0-9a-f]{8}) +\1 +MATCH$/);
    expect(last(measured.out)).toMatch(/^replay: verified: the verdict and the five row outcomes of the set are recomputed and match, and no recomputed value differs \(\d+ MATCH, 0 DIFFERS, 0 not recomputable from the set, 1 input\)$/);

    // Without the file every number of row 4 needs audio.wav, and the verdict matches only for the row 4 of verdict.json: exit 3.
    // There is no recount, so the sniff block of calib.json goes unchecked.
    const bare = publish(session, path.join(root, 'sniffs', 'bare', 'gate-a'), { marks: true, resets: true });
    const without = replayDeps(r);
    expect(await main([bare], without.deps)).toBe(3);
    expect(without.out.some((l) => l.startsWith('  calib.json sniff_lag_ms '))).toBe(false);
    expect(lineOf(without.out, 'rows.sniff_lag.n')).toMatch(
      /not recomputable from the set: calib\.json has no sniff_lag_ms, so stage B recounted the sniff lag, and the recount needs the sniff onsets stage B finds in audio\.wav channel 0/,
    );
    expect(last(without.out)).toMatch(/^replay: no recomputed value differs, but the verdict is not verified: data\/gate-a\/ row sniff_lag, verdict are not recomputable/);
  });

  it('a sniff_onsets.json without one of its onsets recounts another row 4: its values differ from verdict.json; exit 1', async () => {
    const dir = copySet(set, path.join(root, 'sniffs', 'four', 'gate-a'));
    editJson(path.join(dir, SNIFFS_FILE), (j) => {
      j['onsets'] = (j['onsets'] as number[]).slice(1);
    });
    const run = replayDeps(r);
    expect(await main([dir], run.deps)).toBe(1);
    expect(run.err).toEqual([]);
    expect(lineOf(run.out, 'rows.sniff_lag.n')).toMatch(/ 4 +5 +DIFFERS$/);
    expect(run.out).toContain(
      '  note: row 4: replay recounts the sniff lag as stage B does (analysis/clocks/compute.ts recountSniffLag), from the 4 sniff onsets sniff_onsets.json lists, the trace of stream.jsonl and calib.json, and D1 on sniffs from those onsets (analysis/gate/sniffs.ts sniffRow)',
    );
    expect(last(run.out)).toBe(
      `replay: 6 recomputed values differ from the set: ${['lo_median_ms', 'hi_median_ms', 'n', 'best_case_ms', 'd1_on_sniffs_ms'].map((f) => `gate-a rows.sniff_lag.${f}`).join(', ')}, gate-a calib.json sniff_lag_ms`,
    );
  });
});

describe('what a set does not say: OTHER, row 4 and the end of the scored block (spec 9.3, 9.6, 14.4)', () => {
  let r: Repo;
  let set: string;

  beforeAll(async () => {
    r = repo('other');
    const session = await scored(r, 'gate-a', { replies: PLAN }, ['--no-other']);
    set = publish(session, path.join(root, 'other', 'data', 'gate-a'), { marks: true });
  }, 120_000);

  it('calls OTHER not recomputable when verdict.json has none and replay computes one; OTHER does not make the verdict, so exit 0', async () => {
    const run = replayDeps(r);
    expect(await main([set], run.deps)).toBe(0);
    expect(lineOf(run.out, 'other')).toMatch(/^ {2}other +\{"talking_flag_hits":\d+,"head_motion_hits":\d+\} +null +not recomputable from the set: verdict\.json has no OTHER line: stage B leaves it out with --no-other \(spec 14\.4\)/);
    expect(checksOf(set, r).filter((c) => c.status !== 'MATCH').map((c) => c.name)).toEqual(['params_sha256', ...NEVER, 'other']);
  });

  it('calls every number of row 4 not recomputable when calib.json has no sniff block, and the verdict matches only for the row 4 of verdict.json; exit 3', async () => {
    const dir = copySet(set, path.join(root, 'other', 'no-sniff', 'gate-a'));
    editJson(path.join(dir, 'calib.json'), (c) => {
      expect(c['sniff_lag_ms']).toMatchObject({ n: expect.any(Number) });
      delete c['sniff_lag_ms'];
    });
    const run = replayDeps(r);
    expect(await main([dir], run.deps)).toBe(3);
    for (const name of ['outcome', 'lo_median_ms', 'hi_median_ms', 'median_over_ms', 'n', 'no_arrival']) {
      expect(lineOf(run.out, `rows.sniff_lag.${name}`)).toMatch(
        /not recomputable from the set: calib\.json has no sniff_lag_ms, so stage B recounted the sniff lag, and the recount needs the sniff onsets stage B finds in audio\.wav channel 0 after the sniff_<i> step marks \(analysis\/clocks\/compute\.ts recountSniffLag\), which the set does not carry \(no sniff_onsets\.json\); replay reads no audio$/,
      );
    }
    expect(lineOf(run.out, 'verdict')).toMatch(/ PASS +PASS +MATCH if row 4 read PASS on the recount from audio\.wav$/);
    expect(lineOf(run.out, 'clock.L_rt_ms')).toMatch(/ MATCH$/);
    expect(lineOf(run.out, 'rows.hits.hits')).toMatch(/ MATCH$/);
    expect(run.out.some((l) => / DIFFERS$/.test(l))).toBe(false);
    expect(last(run.out)).toMatch(/not verified: data\/gate-a\/ row sniff_lag, verdict are not recomputable/);
  });

  it('at a threshold of row 4 the grade of the unrounded medians matches only under that condition (exit 3), and a grade neither side gives differs (exit 1)', async () => {
    // As if stage B had recounted a hi median of 150.04 ms: calib.json and verdict.json hold 150.0,
    // stage B graded BETWEEN (above 150), and the rounded value alone grades PASS (PREREG §4).
    const dir = copySet(set, path.join(root, 'other', 'edge', 'gate-a'));
    editJson(path.join(dir, 'calib.json'), (c) => {
      expect(c['sniff_lag_ms']['lo_median']).toBeLessThan(150);
      c['sniff_lag_ms']['hi_median'] = 150;
    });
    editJson(path.join(dir, 'verdict.json'), (v) => {
      expect([v['rows']['sniff_lag']['outcome'], v['verdict']]).toEqual(['PASS', 'PASS']);
      v['rows']['sniff_lag']['hi_median_ms'] = 150;
      v['rows']['sniff_lag']['outcome'] = 'BETWEEN';
      v['verdict'] = 'BETWEEN';
    });
    restateMd(dir, true);
    expect(fs.readFileSync(path.join(dir, 'verdict.md'), 'utf8')).toContain('; graded on the medians before rounding');
    const run = replayDeps(r);
    expect(await main([dir], run.deps)).toBe(3);
    const edge = / BETWEEN +BETWEEN +MATCH if the hi median before rounding is above 150 ms$/;
    expect(lineOf(run.out, 'rows.sniff_lag.outcome')).toMatch(edge);
    expect(lineOf(run.out, 'verdict')).toMatch(edge);
    expect(lineOf(run.out, 'rows.sniff_lag.hi_median_ms')).toMatch(/ MATCH$/);
    expect(lineOf(run.out, 'verdict.md')).toMatch(/ MATCH$/);
    expect(run.out.some((l) => / DIFFERS$/.test(l))).toBe(false);

    const kill = copySet(dir, path.join(root, 'other', 'edge-kill', 'gate-a'));
    editJson(path.join(kill, 'verdict.json'), (v) => {
      v['rows']['sniff_lag']['outcome'] = 'KILL';
      v['verdict'] = 'KILL';
    });
    restateMd(kill, true);
    const run2 = replayDeps(r);
    expect(await main([kill], run2.deps)).toBe(1);
    expect(lineOf(run2.out, 'rows.sniff_lag.outcome')).toMatch(/ PASS or BETWEEN +KILL +DIFFERS$/);
  });

  it('calls every value that needs the cues not recomputable when marks.jsonl has no step mark after the cues; the listening block still gives stage A and the in-sample rates; exit 3', async () => {
    // Stage B then ends the scored block at the last stamp of stamps.jsonl or audio chunk (view.ts gateLayout).
    const dir = copySet(set, path.join(root, 'other', 'open-end', 'gate-a'));
    const file = path.join(dir, MARKS_FILE);
    const lines = fs.readFileSync(file, 'utf8').split('\n').filter((l) => l.length > 0);
    const marks = lines.map((l) => JSON.parse(l) as { n: number; what: string });
    const lastCue = Math.max(...marks.filter((m) => m.what === 'cue').map((m) => m.n));
    const kept = lines.filter((_, i) => !(marks[i]!.what === 'step' && marks[i]!.n > lastCue));
    expect(kept.length).toBeLessThan(lines.length);
    fs.writeFileSync(file, `${kept.join('\n')}\n`);
    const run = replayDeps(r);
    expect(await main([dir], run.deps)).toBe(3);
    const why = /not recomputable from the set: marks\.jsonl has no step mark after the cues, so stage B ended the scored block at the last stamp or audio chunk of stamps\.jsonl, which the set does not hold$/;
    for (const name of ['events.valid', 'rows.hits.hits', 'rows.chest_vs_lips.wins', 'verdict']) expect(lineOf(run.out, name)).toMatch(why);
    for (const name of ['clock.L_rt_ms', 'tuning.k', 'tuning.theta_G', 'rows.false_holds.in_sample_chest_per_min', 'rows.false_holds.in_sample_lips_per_min']) {
      expect(lineOf(run.out, name)).toMatch(/ MATCH$/);
    }
    expect(run.out.some((l) => / DIFFERS$/.test(l))).toBe(false);
  });
});

describe("packs B and C: stage A's tuning comes from pack A, or from the pack itself when it was the gate (PREREG §7.4, §11)", () => {
  const tags = new Map<string, string>();
  let r: Repo;
  let paramsA: string;
  let setA: string;
  let setB: string;

  beforeAll(async () => {
    r = repo('packs', tags);
    const a = await scored(r, 'gate-a', { replies: PLAN });
    paramsA = fs.readFileSync(r.paramsFile, 'utf8');
    // PASS keeps the stage A file: params/retune.json is its copy, frozen by gate-retune before pack B (PREREG §11).
    fs.writeFileSync(path.join(path.dirname(r.paramsFile), 'retune.json'), paramsA);
    tags.set(RETUNE_TAG, paramsA);
    // Breaths that stage A would tune to k 2.5 and theta_G 0.02 (see the first describe); after the retune it tunes nothing.
    const lipOpenings = [80, 110, 140, 170, 200].map((t) => ({ fromS: t, toS: t + 1, rise: 0.019 }));
    const b = await scored(r, 'gate-b', { replies: PLAN, seed: 12, jitter: 0.12, lipOpenings }, [], 'B');
    expect(fs.readFileSync(r.paramsFile, 'utf8')).toBe(paramsA);
    setA = publish(a, path.join(root, 'packs', 'data', 'gate-a'), { marks: true });
    setB = publish(b, path.join(root, 'packs', 'data', 'gate-b'), { marks: true });
  }, 180_000);

  it("pack B scored with pack A's params: tuning agrees with the params, and tuning again here shows they were not tuned here; exit 0", async () => {
    const run = replayDeps(r);
    expect(await main([setB], run.deps)).toBe(0);
    expect(run.out).toContain(`replay data/gate-b/ (pack B, from ${setB})`);
    expect(run.out.find((l) => l.startsWith('  params: '))).toMatch(/retune\.json, hashed as stage B hashes it/);
    for (const name of ['tuning.k', 'tuning.criterion_met', 'tuning.theta_G']) expect(lineOf(run.out, name)).toMatch(/ MATCH$/);
    expect(lineOf(run.out, 'tuning.k')).toMatch(/ 1\.5 +1\.5 +MATCH$/);
    expect(run.out).toContain(
      "  note: tuning: packs B and C are scored with pack A's params once the retune froze them (PREREG §11), so tuning holds the values of the params, which the replay of pack A's set recomputes; tuned again on the listening block of this recording they would be k 2.5, criterion_met true and theta_G 0.02, so stage A did not tune them here (it would have, had pack B been recorded as the gate after a lost pack A, PREREG §7.4)",
    );
    expect(last(run.out)).toMatch(VERIFIED);

    // A tuning in verdict.json that is not the one of the params its params_sha256 names differs.
    const dir = copySet(setB, path.join(root, 'packs', 'edit-k', 'gate-b'));
    editJson(path.join(dir, 'verdict.json'), (v) => {
      v['tuning']['k'] = 2.5;
    });
    restateMd(dir);
    const edited = replayDeps(r);
    expect(await main([dir], edited.deps)).toBe(1);
    expect(lineOf(edited.out, 'tuning.k')).toMatch(/ 1\.5 +2\.5 +DIFFERS$/);
  });

  it('a pack B recorded as the gate after a lost pack A: stage A tuned it there, and the tuning is recomputed', async () => {
    // Pack A's recording and verdict as if they were pack B's: stage A tuned the params on this recording.
    const dir = copySet(setA, path.join(root, 'packs', 'gate-pack-b', 'gate-a'));
    editJson(path.join(dir, 'manifest.json'), (m) => {
      m['pack'] = 'B';
      m['scenario'] = 'gate-B';
    });
    editJson(path.join(dir, 'verdict.json'), (v) => {
      v['pack'] = 'B';
    });
    restateMd(dir);
    const run = replayDeps(r);
    expect(await main([dir], run.deps)).toBe(0);
    expect(run.out).toContain(`replay data/gate-a/ (pack B, from ${dir})`);
    expect(run.out).toContain(
      '  note: tuning: replay tunes k and theta_G again on the listening block of this recording (analysis/gate/tune.ts tuneStageA) and gets the values of the params, as stage A does when pack B is the gate recording after a lost pack A (PREREG §7.4)',
    );
    expect(lineOf(run.out, 'tuning.k')).toMatch(/ 1\.5 +1\.5 +MATCH$/);
    expect(last(run.out)).toMatch(VERIFIED);
  });

  it('params set by the retune were not tuned by stage A on any recording: tuning holds their values', async () => {
    // The set the retune chose, here with pack A's k and theta_G, under step "retune" (analysis/gate/retune.ts retuneParams).
    const a = parseParamsText(paramsA, 'retune.json').value as Record<string, any>;
    const text = frozenParamsText(frozenWithTuning(withoutStageAKeys(a), { k: a['d1']['k'], criterionMet: true, thetaG: a['g']['theta_G'], step: 'retune' }));
    expect(text).not.toBe(paramsA);
    const dir = copySet(setB, path.join(root, 'packs', 'retune-step', 'gate-b'));
    editJson(path.join(dir, 'verdict.json'), (v) => {
      v['params_sha256'] = sha256Hex(text);
    });
    restateMd(dir);
    const file = path.join(root, 'packs', 'retune-step.json');
    fs.writeFileSync(file, text);
    const run = replayDeps(r);
    expect(await main([dir, '--params', file], run.deps)).toBe(0);
    expect(lineOf(run.out, 'tuning.k')).toMatch(/ 1\.5 +1\.5 +MATCH$/);
    expect(run.out).toContain(
      '  note: tuning: the params stage B scored with were set by the retune on pack A (PREREG §11), not by stage A on this recording, so tuning holds the values of the params',
    );
    expect(last(run.out)).toMatch(VERIFIED);
  });
});

describe('the command line and the folders replay reads', () => {
  it('parses the options, never takes an option for a value, and resolves a bare id in the data folder', () => {
    expect(parseReplayArgs(['gate-a', 'x/gate-b', '--params=p.json', '--json', 'o.json', '--svg', 'o.svg', '--png', 'o.png', '--chrome', '/c'])).toEqual({
      sets: ['gate-a', 'x/gate-b'],
      paramsFile: 'p.json',
      json: 'o.json',
      svg: 'o.svg',
      png: 'o.png',
      chrome: '/c',
    });
    expect(parseReplayArgs([])).toMatch(/^name at least one published set/);
    expect(parseReplayArgs(['gate-a', '--svg'])).toBe('--svg needs a value');
    expect(parseReplayArgs(['gate-a', '--json', '--svg', 'o.svg'])).toBe('--json needs a value');
    expect(parseReplayArgs(['gate-a', '--json', 'a', '--json', 'b'])).toBe('--json is given twice');
    expect(parseReplayArgs(['gate-a', '--stage', 'B'])).toBe('unknown option --stage');
    expect(setFolderOf('gate-a', {})).toBe(path.join(REPO_ROOT, 'data', 'gate-a'));
    expect(setFolderOf('gate-a', { COPYHOLDER_DATA_DIR: path.join(root, 'elsewhere') })).toBe(path.join(root, 'elsewhere', 'gate-a'));
    expect(setFolderOf('./gate-a', { COPYHOLDER_DATA_DIR: path.join(root, 'elsewhere') })).toBe(path.resolve('gate-a'));
  });

  it('reads a bare id from COPYHOLDER_DATA_DIR, and refuses the same set named twice (exit 2)', async () => {
    const r = repo('ids');
    const data = path.join(root, 'ids', 'published');
    fs.mkdirSync(path.join(data, 'gate-z'), { recursive: true });
    const run = replayDeps(r, PREREG, null, { COPYHOLDER_DATA_DIR: data });
    expect(await main(['gate-z'], run.deps)).toBe(1);
    expect(run.err[0]).toBe(`replay refused gate-z: ${path.join(data, 'gate-z', 'manifest.json')} is missing: every published set holds it (spec 8.7); fetch the whole folder again`);
    const twice = replayDeps(r, PREREG, null, { COPYHOLDER_DATA_DIR: data });
    expect(await main(['gate-z', path.join(data, 'gate-z')], twice.deps)).toBe(2);
    expect(twice.err[0]).toMatch(/^gate-z and .*gate-z name the same set folder .*gate-z: name each set once\nusage: npm run replay/);
    expect(twice.out).toEqual([]);
  });

  it('never reads or writes inside gate/ or sample/: set folders, --params and the outputs; exit 2', async () => {
    expect(unreadFolderWhy(path.join(REPO_ROOT, 'gate'))).toMatch(/inside gate\/, whose pack files stay unopened before the day-1 recording \(spec 9\.2\)/);
    expect(unreadFolderWhy(path.join(REPO_ROOT, 'sample', 'x'))).toMatch(/inside sample\//);
    expect(unreadFolderWhy(path.join(REPO_ROOT, 'data', 'gate-a'))).toBeNull();
    const r = repo('usage');
    const set = path.join(root, 'usage', 'data', 'gate-a');
    const cases: [string[], RegExp][] = [
      [[`${path.join(REPO_ROOT, 'gate')}${path.sep}`], /lies inside gate\//],
      [[set, '--params', path.join(REPO_ROOT, 'gate', 'frozen.json')], /^--params .*gate.frozen\.json lies inside gate\//],
      [[set, '--json', path.join(REPO_ROOT, 'sample', 'replay.json')], /^--json .*sample.replay\.json lies inside sample\//],
      [[set, '--svg', path.join(REPO_ROOT, 'gate', 'replay.svg')], /^--svg .*gate.replay\.svg lies inside gate\//],
      [['gate-a', '--bogus'], /^unknown option --bogus/],
    ];
    for (const [argv, why] of cases) {
      const run = replayDeps(r);
      expect(await main(argv, run.deps)).toBe(2);
      expect(run.err.join('\n')).toMatch(why);
      expect(run.err.join('\n')).toMatch(/usage: npm run replay -- <id or folder>/);
      expect(run.out).toEqual([]);
    }
    expect(fs.existsSync(path.join(REPO_ROOT, 'sample', 'replay.json')) || fs.existsSync(path.join(REPO_ROOT, 'gate', 'replay.svg'))).toBe(false);
  });

  it('finds the threshold of row 4 from the constants of core/clock, to 0.1 ms', () => {
    expect(sniffEdgeOf({ lo: 120, hi: 150, over: null, n: 5 })).toBe('hi');
    expect(sniffEdgeOf({ lo: 350, hi: 400, over: null, n: 5 })).toBe('lo');
    expect(sniffEdgeOf({ lo: 120, hi: 150.1, over: null, n: 5 })).toBeNull();
    expect(sniffEdgeOf({ lo: 349.9, hi: 400, over: null, n: 5 })).toBeNull();
    expect(sniffEdgeOf({ lo: null, hi: null, over: 350, n: 5 })).toBeNull();
    expect(sniffEdgeOf({ lo: 120, hi: 150, over: null, n: 0 })).toBeNull();
  });

  it('checks the sniff block of calib.json against the block the clocks step writes for the recounted lag, a missing block and no lag both null', () => {
    // A lag as core/clock sniffLag gives it, whose block is the one of the calib.json example.
    const lag: SniffLag = {
      sniffs: [],
      n: 5,
      noArrival: 0,
      medianNotArrived: false,
      medianOverMs: null,
      loMedianMs: 148.04,
      hiMedianMs: 171.46,
      bestCaseMedianMs: 148.04,
      reading: 'BETWEEN',
      calib: { n: 5, lo_median: 148, hi_median: 171.5 },
    };
    const measured = { onsets: [1, 2, 3, 4, 5], aRef: 0.84, lag };
    const noLag = { onsets: [], aRef: null, lag: null };
    const calib = exampleCalib();
    const hash = sha256Hex(JSON.stringify(calib.sniff_lag_ms));
    expect(calibSniffCheck(calib, measured)).toEqual({
      name: 'calib.json sniff_lag_ms',
      against: 'calib.json',
      recomputed: hash,
      candidates: null,
      published: hash,
      status: 'MATCH',
      why: null,
      condition: null,
    });
    const later = { ...calib, sniff_lag_ms: { ...calib.sniff_lag_ms!, hi_median: 171.6 } };
    expect(calibSniffCheck(later, measured)).toMatchObject({ recomputed: hash, published: sha256Hex(JSON.stringify(later.sniff_lag_ms)), status: 'DIFFERS' });
    expect(calibSniffCheck(calib, noLag)).toMatchObject({ recomputed: null, published: hash, status: 'DIFFERS' });
    const bare = { ...calib };
    delete bare.sniff_lag_ms;
    for (const none of [bare, { ...calib, sniff_lag_ms: null }]) {
      expect(calibSniffCheck(none, measured)).toMatchObject({ recomputed: hash, published: null, status: 'DIFFERS' });
      expect(calibSniffCheck(none, noLag)).toMatchObject({ recomputed: null, published: null, status: 'MATCH' });
    }
  });

  it('takes verdict.md in the wording of row 4 the recount gives, and either wording at a threshold without the recount', () => {
    const v = exampleVerdict();
    // A hi median of 150.0 ms sits on the PASS threshold: stage B may have graded the medians before rounding.
    const edge: Verdict = { ...v, rows: { ...v.rows, sniff_lag: { ...v.rows.sniff_lag, hi_median_ms: 150 } } };
    const md = (verdict: Verdict, gradedUnrounded: boolean): string => verdictMarkdown(verdict, verdict.run, { sniff: { gradedUnrounded } });
    const status = (verdict: Verdict, text: string, gradedUnrounded: boolean | null): string => verdictMdCheck({ verdict, verdictMd: text }, gradedUnrounded).check.status;
    expect(md(edge, true)).toContain('; graded on the medians before rounding');
    expect(md(edge, false)).not.toContain('graded on the medians before rounding');
    expect([status(edge, md(edge, false), null), status(edge, md(edge, true), null)]).toEqual(['MATCH', 'MATCH']);
    expect([status(edge, md(edge, false), false), status(edge, md(edge, true), false)]).toEqual(['MATCH', 'DIFFERS']);
    expect([status(edge, md(edge, false), true), status(edge, md(edge, true), true)]).toEqual(['DIFFERS', 'MATCH']);
    // Off a threshold, without the recount, only the wording without the clause stands.
    expect([status(v, md(v, false), null), status(v, md(v, true), null)]).toEqual(['MATCH', 'DIFFERS']);
    // The note quotes the line of row 4 against the one stage B writes.
    const theirs = md(edge, true).split('\n');
    const mine = md(edge, false).split('\n');
    const i = theirs.findIndex((l) => l.includes('graded on the medians before rounding'));
    expect(verdictMdCheck({ verdict: edge, verdictMd: md(edge, true) }, false).note).toBe(
      `verdict.md line ${i + 1} reads ${JSON.stringify(theirs[i])}, where stage B writes ${JSON.stringify(mine[i])} from verdict.json (analysis/gate/verdict-text.ts)`,
    );
  });

  it("tunes again only params that hold stage A's tuning, whatever the pack", () => {
    const tuned = (k: string, thetaG: string): { value: Record<string, unknown> } => ({ value: { tuned: { k: { step: k, criterion_met: true }, theta_G: { step: thetaG } } } });
    expect(tunedByStageA(tuned('stage_a', 'stage_a'))).toBe(true);
    expect(tunedByStageA(tuned('retune', 'retune'))).toBe(false);
    expect(tunedByStageA(tuned('stage_a', 'retune'))).toBe(false);
    expect(tunedByStageA({ value: {} })).toBe(false);
    expect([tunedStepOf(tuned('retune', 'retune')), tunedStepOf({ value: {} })]).toEqual(['retune', null]);
  });
});
