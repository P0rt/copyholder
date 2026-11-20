// npm run confirm end to end on synthetic gate recordings (PREREG.md section 11): pack A tuned by
// stage A, another set chosen by the retune and frozen under gate-retune, packs B and C scored with
// it by stage A and stage B, then the pooled confirmation and its outputs; a pack that failed
// quickcheck on condition 6 alone, which confirm scores and keeps, flagged; a pack lost after 4:15,
// or ended by kCreditExhausted at any time; pack B alone when pack C has no recording; the checks
// of the tag gate-retune; and each refusal, made before anything is computed.

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { appendLedger, isNoteLine, NOTE_STEP, THETA_G_GRID, type LedgerLine, type Verdict } from '../../core/schemas/index.ts';
import { loadList, scanText } from '../../tools/lint-words.ts';
import { main, parseConfirmArgs, USAGE } from '../confirm.ts';
import { main as gateMain } from '../gate.ts';
import { round1 } from '../gate/common.ts';
import { frozenParamsText, frozenWithTuning, parseParamsText } from '../gate/frozen.ts';
import { buildGateSynth, preregParamsText, writeGateSession, type ReplyPlan } from '../gate/synth.ts';
import { sha256Hex } from '../lib/ledger.ts';
import { REPO_ROOT } from '../lib/paths.ts';
import { gateSteps } from '../lib/steps.ts';
import type { ConfirmDeps } from './deps.ts';
import { SENSITIVITY_LABELS } from './facts.ts';
import { standingOf } from './load.ts';
import { shareLine } from './numbers.ts';
import { SENTENCE_ENDS_NOTE } from './report.ts';
import { runConfirm } from './run.ts';
import { confirmCodeFiles, retuneTagFacts } from './tag.ts';

const PREREG = preregParamsText();
const SDK = '2.1.0';
/** The time git gives the tag gate-retune here: before the synthetic recordings started. */
const TAG_TIME = '2026-11-13T12:00:00Z';

const PLAN_A: ReplyPlan[] = Array.from({ length: 14 }, (_, i) => (i < 10 ? { kind: 'inhale' } : { kind: 'plain' }));
/** Pack B: a cough, a reply more than 10 s late and no reply leave 11 valid objections, so it is flagged. */
const PLAN_B: ReplyPlan[] = [
  ...Array.from({ length: 8 }, (): ReplyPlan => ({ kind: 'inhale' })),
  { kind: 'cough' },
  { kind: 'late' },
  { kind: 'none' },
  { kind: 'plain' },
  { kind: 'plain' },
  { kind: 'plain' },
];
const PLAN_C: ReplyPlan[] = Array.from({ length: 14 }, (_, i) => (i < 11 ? { kind: 'inhale' } : { kind: 'plain' }));

interface World {
  base: string;
  sessions: string;
  paramsFile: string;
  retuneFile: string;
  /** params/frozen.json as pack A's stage A wrote it. */
  stageAText: string;
  /** params/frozen.json and params/retune.json after the retune: packs B and C were scored with it. */
  retuneText: string;
  /** manifest.json started_utc of the synthetic recordings. */
  start: string;
  /**
   * What git gives under the tag gate-retune: params/retune.json (null: no tag), the pooled code by
   * repository path where it differs from the file as it is (null: not under the tag), the tag's time.
   */
  tags: { retune: string | null; code: Record<string, string | null>; time: string | null };
  out: string[];
  err: string[];
  deps: ConfirmDeps;
  /** What stage A and stage B printed for each recording. */
  logs: Record<string, string[]>;
}

/** confirm.json, confirm.md and the lines confirm printed. */
interface Ran {
  json: Record<string, any>;
  md: string;
  summary: string[];
}

let w: World;
let resultsCount = 0;
/** The pooled numbers of gate-b and gate-c, as the main run below gives them. */
let pooledBC: Record<string, unknown> | null = null;

/** A tuned set as the retune writes it (step "retune"). */
function tunedText(k: number, thetaG: number): string {
  const base = parseParamsText(PREREG, 'params/frozen.json').value!;
  return frozenParamsText(frozenWithTuning(base, { k, criterionMet: true, thetaG, step: 'retune' }));
}

/** Writes a file of a session folder; a hard-linked one is unlinked first, so its original never changes. */
function putFile(file: string, text: string): void {
  fs.rmSync(file, { force: true });
  fs.writeFileSync(file, text);
}

function editManifest(dir: string, edit: (m: Record<string, any>) => void): void {
  const file = path.join(dir, 'manifest.json');
  const m = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, any>;
  edit(m);
  putFile(file, `${JSON.stringify(m, null, 2)}\n`);
}

/** manifest.json of a day-one recording of `pack`, with the SDK version host writes. */
function setPack(dir: string, pack: string): void {
  editManifest(dir, (m) => {
    m['pack'] = pack;
    m['scenario'] = `gate-${pack}`;
    if (m['sdk']) m['sdk'].version = SDK;
  });
}

async function stages(id: string): Promise<void> {
  const from = w.out.length;
  expect(await gateMain(['--stage', 'A', id], w.deps)).toBe(0);
  expect(await gateMain(['--stage', 'B', id], w.deps)).toBe(0);
  w.logs[id] = w.out.slice(from);
}

/** The deps with results written to their own new folder. */
function freshDeps(): { deps: ConfirmDeps; results: string } {
  const results = path.join(w.base, `results-${++resultsCount}`);
  return { deps: { ...w.deps, env: { ...w.deps.env, COPYHOLDER_RESULTS_DIR: results } }, results };
}

function readVerdict(id: string): Verdict {
  return JSON.parse(fs.readFileSync(path.join(w.sessions, id, 'verdict.json'), 'utf8')) as Verdict;
}

/** Stage B's A250 pairing of a recording, from its note line: [wins, losses, ties]. */
function a250Of(id: string): [number, number, number] {
  const m = /^note: A250: chest wins (\d+):(\d+), ties (\d+)/.exec(w.logs[id]!.find((l) => l.startsWith('note: A250:')) ?? '');
  expect(m).not.toBeNull();
  return [Number(m![1]), Number(m![2]), Number(m![3])];
}

/** Every file of the session folders with its size and time: confirm only reads them. */
function foldersSnapshot(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const id of fs.readdirSync(w.sessions).sort()) {
    for (const name of fs.readdirSync(path.join(w.sessions, id)).sort()) {
      const st = fs.statSync(path.join(w.sessions, id, name));
      out[`${id}/${name}`] = `${st.size}:${st.mtimeMs}`;
    }
  }
  return out;
}

/** The text holds no banned word and no long dash (npm run lint:words). */
function expectPlainText(md: string, json: Record<string, unknown>): void {
  const banned = loadList(path.join(REPO_ROOT, 'tools/words/banned.txt'));
  const allowed = loadList(path.join(REPO_ROOT, 'tools/words/allow.txt'));
  expect(scanText(md, banned, allowed, 'confirm.md')).toEqual([]);
  expect(scanText(JSON.stringify(json), banned, allowed, 'confirm.json')).toEqual([]);
  expect(md).not.toMatch(/—|–/);
}

// ---- forged copies of a recording (tests only) -------------------------------------------------

/** A copy of a recording under another folder name: big files hard-linked (never written here), the rest copied. */
function copySession(from: string, to: string, root: string = w.sessions): string {
  const src = path.join(w.sessions, from);
  const dst = path.join(root, to);
  fs.mkdirSync(dst);
  for (const name of fs.readdirSync(src)) {
    const f = path.join(src, name);
    if (fs.statSync(f).size > 1_000_000) fs.linkSync(f, path.join(dst, name));
    else fs.copyFileSync(f, path.join(dst, name));
  }
  return dst;
}

function ledgerRecords(dir: string): LedgerLine[] {
  return fs
    .readFileSync(path.join(dir, 'ledger.jsonl'), 'utf8')
    .split('\n')
    .filter((l) => l.length > 0)
    .map((l) => JSON.parse(l) as LedgerLine);
}

/** Rebuilds ledger.jsonl after `edit` (null drops the line), with a valid chain. */
function reforgeLedger(dir: string, edit: (r: LedgerLine) => LedgerLine | null): void {
  const hash = (t: string): string => sha256Hex(t);
  const lines: string[] = [];
  for (const record of ledgerRecords(dir)) {
    const r = edit(record);
    if (r === null) continue;
    lines.push(
      isNoteLine(r)
        ? appendLedger(lines, NOTE_STEP, { utc: r.utc, commit: r.commit, what: r.what, ...(r.detail === undefined ? {} : { detail: r.detail }) }, hash, { kind: 'gate' })
        : appendLedger(lines, r.step, { utc: r.utc, commit: r.commit, out_sha256: r.out_sha256, exploratory: r.exploratory }, hash, { kind: 'gate' }),
    );
  }
  putFile(path.join(dir, 'ledger.jsonl'), `${lines.join('\n')}\n`);
}

/** Replaces a file a step wrote, and its hash in every step line that lists it. */
function replaceRecorded(dir: string, file: string, text: string): void {
  putFile(path.join(dir, file), text);
  const sha = sha256Hex(text);
  reforgeLedger(dir, (r) => (isNoteLine(r) || r.out_sha256[file] === undefined ? r : { ...r, out_sha256: { ...r.out_sha256, [file]: sha } }));
}

function editJson(dir: string, file: string, edit: (v: Record<string, any>) => void): void {
  const v = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8')) as Record<string, any>;
  edit(v);
  replaceRecorded(dir, file, `${JSON.stringify(v, null, 2)}\n`);
}

/** Adds `line` to the end of a file, without the ledger knowing. */
function appendTo(dir: string, file: string, line: string): void {
  putFile(path.join(dir, file), `${fs.readFileSync(path.join(dir, file), 'utf8')}${line}\n`);
}

/** As stage A and stage B leave a recording they do not score: no stage lines, no verdict. */
function withoutStages(dir: string): void {
  reforgeLedger(dir, (r) => (!isNoteLine(r) && (r.step === 'stage_a' || r.step === 'stage_b' || r.step === 'verdict') ? null : r));
  fs.rmSync(path.join(dir, 'verdict.json'));
  fs.rmSync(path.join(dir, 'verdict.md'));
}

/** quickcheck.json of a recording that failed on condition 6 alone: too few replies, which is not technical. */
function failRepliesOnly(dir: string, answered: number): void {
  editJson(dir, 'quickcheck.json', (q) => {
    q['result'] = 'RE-RECORD NOW';
    q['reasons'] = [`a voice was found within 10 s after only ${answered} of 14 cues (needs 12)`];
    q['technical'] = false;
    q['checks'] = (q['checks'] as { name: string }[]).map((c) => (c.name === 'voice_after_cues' ? { ...c, ok: false, value: answered, limit: 12 } : c));
  });
}

/** quickcheck.json of a recording that failed for a technical reason. */
function failTechnical(dir: string): void {
  editJson(dir, 'quickcheck.json', (q) => {
    q['result'] = 'RE-RECORD NOW';
    q['reasons'] = ['microphone processing not off'];
    q['technical'] = true;
    q['checks'] = (q['checks'] as { name: string }[]).map((c) => (c.name === 'mic_flags_off' ? { ...c, ok: false } : c));
  });
}

/**
 * As host leaves a recording the SDK ended because its credits ran out: the sdk_error line of
 * events.jsonl (live/host.cjs onSdkError) and quickcheck failing on condition 5, which is technical.
 */
function endByCredits(dir: string): void {
  appendTo(dir, 'events.jsonl', JSON.stringify({ n: null, e: 'sdk_error', by: 'host', code: 4, name: 'kCreditExhausted', message: 'no credits left' }));
  editJson(dir, 'quickcheck.json', (q) => {
    q['result'] = 'RE-RECORD NOW';
    q['reasons'] = ['the SDK reported 1 error(s) (code 4 kCreditExhausted)'];
    q['technical'] = true;
    q['checks'] = (q['checks'] as { name: string }[]).map((c) => (c.name === 'no_sdk_error' ? { ...c, ok: false, value: 1 } : c));
  });
}

/** Removes the step mark of `name` from stamps.jsonl: Deck never entered that step. */
function dropStepMark(dir: string, name: string): void {
  const file = path.join(dir, 'stamps.jsonl');
  const lines = fs.readFileSync(file, 'utf8').split('\n');
  const kept = lines.filter((l) => {
    if (l.length === 0) return true;
    const s = JSON.parse(l) as { k?: string; what?: string; name?: string };
    return !(s.k === 'mark' && s.what === 'step' && s.name === name);
  });
  expect(lines.length - kept.length).toBe(1);
  putFile(file, kept.join('\n'));
}

/** Pack B with a verdict.json stage B did not write, its hash put in the ledger: only computing pack B shows it. */
function forgedB(): string {
  const dir = path.join(w.sessions, 'gate-b-forged');
  if (fs.existsSync(dir)) return dir;
  copySession('gate-b', 'gate-b-forged');
  editJson(dir, 'verdict.json', (v) => {
    v['misses'].no_inbreath += 1;
  });
  return dir;
}

/** Runs confirm, which must finish and write its outputs; `env` changes the environment (a sessions folder). */
function confirmed(argv: string[], env: NodeJS.ProcessEnv = {}): Ran {
  const { deps, results } = freshDeps();
  Object.assign(deps.env, env);
  const from = w.out.length;
  w.err.length = 0;
  expect(main(argv, deps)).toBe(0);
  expect(w.err).toEqual([]);
  return {
    json: JSON.parse(fs.readFileSync(path.join(results, 'confirm.json'), 'utf8')) as Record<string, any>,
    md: fs.readFileSync(path.join(results, 'confirm.md'), 'utf8'),
    summary: w.out.slice(from),
  };
}

/** Runs confirm, which must refuse with `why`, print it and write nothing. */
function refused(argv: string[], why: RegExp, env: NodeJS.ProcessEnv = {}): string {
  const { deps, results } = freshDeps();
  Object.assign(deps.env, env);
  w.err.length = 0;
  expect(main(argv, deps)).toBe(1);
  const text = w.err.join('\n');
  expect(text).toMatch(/^confirm refused: /);
  expect(text).toMatch(why);
  expect(fs.existsSync(results)).toBe(false);
  return text;
}

/** Runs `f` with params/frozen.json, params/retune.json and the tagged copy set as given, then puts them back. */
function withParams(p: { frozen?: string | null; retune?: string | null; tagged?: string | null }, f: () => void): void {
  const keep = { frozen: fs.readFileSync(w.paramsFile, 'utf8'), retune: fs.readFileSync(w.retuneFile, 'utf8'), tagged: w.tags.retune };
  const put = (file: string, text: string | null | undefined): void => {
    if (text === undefined) return;
    if (text === null) fs.rmSync(file, { force: true });
    else fs.writeFileSync(file, text);
  };
  try {
    put(w.paramsFile, p.frozen);
    put(w.retuneFile, p.retune);
    if (p.tagged !== undefined) w.tags.retune = p.tagged;
    f();
  } finally {
    fs.writeFileSync(w.paramsFile, keep.frozen);
    fs.writeFileSync(w.retuneFile, keep.retune);
    w.tags.retune = keep.tagged;
  }
}

/** Runs `f` with the pooled code under the tag gate-retune or the tag's time changed as given, then puts them back. */
function withTag(t: { code?: Record<string, string | null>; time?: string | null }, f: () => void): void {
  const keep = { code: w.tags.code, time: w.tags.time };
  try {
    if (t.code !== undefined) w.tags.code = t.code;
    if (t.time !== undefined) w.tags.time = t.time;
    f();
  } finally {
    w.tags.code = keep.code;
    w.tags.time = keep.time;
  }
}

const repoPath = (file: string): string => path.relative(REPO_ROOT, file).split(path.sep).join('/');

beforeAll(async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'confirm-'));
  const sessions = path.join(base, 'sessions');
  const paramsFile = path.join(base, 'params', 'frozen.json');
  const retuneFile = path.join(base, 'params', 'retune.json');
  fs.mkdirSync(sessions, { recursive: true });
  fs.mkdirSync(path.dirname(paramsFile), { recursive: true });
  fs.writeFileSync(paramsFile, PREREG);
  const out: string[] = [];
  const err: string[] = [];
  const tags: World['tags'] = { retune: null, code: {}, time: TAG_TIME };
  w = {
    base,
    sessions,
    paramsFile,
    retuneFile,
    stageAText: '',
    retuneText: '',
    start: '',
    tags,
    out,
    err,
    logs: {},
    deps: {
      env: { COPYHOLDER_SESSIONS_DIR: sessions, COPYHOLDER_PARAMS_FILE: paramsFile, COPYHOLDER_RESULTS_DIR: path.join(base, 'results') },
      now: () => new Date('2026-11-21T10:00:00Z'),
      commit: () => 'abc1234',
      log: (l) => out.push(l),
      error: (l) => err.push(l),
      tagFile: (tag, file) => {
        if (tag === 'gate-prereg') return PREREG;
        if (tag !== 'gate-retune') return null;
        if (path.resolve(file) === retuneFile) return tags.retune;
        // The pooled analysis code: frozen as it is, unless a test changes it.
        const rel = repoPath(path.resolve(file));
        if (rel in tags.code) return tags.code[rel] ?? null;
        return fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null;
      },
      tagTime: (tag) => (tag === 'gate-retune' ? tags.time : null),
    },
  };

  // Pack A: stage A tunes k and theta_G on its listening block, stage B scores it.
  setPack(writeGateSession(sessions, buildGateSynth({ replies: PLAN_A, seed: 11 }), 'gate-a'), 'A');
  await stages('gate-a');
  w.stageAText = fs.readFileSync(paramsFile, 'utf8');

  // The retune chose another set (section 11): params/frozen.json and its copy, frozen under gate-retune.
  w.retuneText = tunedText(2, 0.02);
  fs.writeFileSync(paramsFile, w.retuneText);
  fs.writeFileSync(w.retuneFile, w.retuneText);
  tags.retune = w.retuneText;

  // Packs B and C: stage A only checks the frozen file, stage B scores each with it.
  setPack(writeGateSession(sessions, buildGateSynth({ replies: PLAN_B, seed: 23, inhalesS: [300.5, 400.2] }), 'gate-b'), 'B');
  setPack(writeGateSession(sessions, buildGateSynth({ replies: PLAN_C, seed: 37 }), 'gate-c'), 'C');
  await stages('gate-b');
  await stages('gate-c');
  w.start = (JSON.parse(fs.readFileSync(path.join(sessions, 'gate-b', 'manifest.json'), 'utf8')) as { started_utc: string }).started_utc;
  expect(Date.parse(TAG_TIME)).toBeLessThan(Date.parse(w.start));
}, 120_000);

afterAll(() => {
  if (w) fs.rmSync(w.base, { recursive: true, force: true });
});

describe('the command line', () => {
  it('takes the two recordings in either order, or one alone, and --dev with the pack A recording', () => {
    expect(parseConfirmArgs(['gate-b', 'gate-c'])).toEqual({ ids: ['gate-b', 'gate-c'], dev: null });
    expect(parseConfirmArgs(['gate-b', '--dev', 'gate-a'])).toEqual({ ids: ['gate-b'], dev: 'gate-a' });
    expect(parseConfirmArgs(['gate-c', 'gate-b', '--dev', 'gate-a'])).toEqual({ ids: ['gate-c', 'gate-b'], dev: 'gate-a' });
    expect(parseConfirmArgs(['--dev=gate-a', 'gate-b', 'gate-c'])).toEqual({ ids: ['gate-b', 'gate-c'], dev: 'gate-a' });
  });

  it('refuses a wrong command line with exit code 2 and the usage', () => {
    expect(parseConfirmArgs([])).toMatch(/one or two recording ids are required: those of packs B and C, or pack B alone when pack C has no recording \(got 0\)/);
    expect(parseConfirmArgs(['--dev', 'gate-a'])).toMatch(/one or two recording ids are required/);
    expect(parseConfirmArgs(['gate-b', 'gate-c', 'gate-a'])).toMatch(/one or two recording ids are required.*\(got 3\)/);
    expect(parseConfirmArgs(['gate-b', 'gate-c', '--dev'])).toMatch(/--dev needs the pack A recording id/);
    expect(parseConfirmArgs(['gate-b', 'gate-c', '--dev', 'gate-a', '--dev', 'gate-a'])).toMatch(/--dev is given twice/);
    expect(parseConfirmArgs(['gate-b', 'gate-c', '--exploratory'])).toBe('unknown option --exploratory');
    const { deps, results } = freshDeps();
    w.err.length = 0;
    expect(main([], deps)).toBe(2);
    expect(w.err.join('\n')).toContain(USAGE);
    expect(fs.existsSync(results)).toBe(false);
  });

  it('runs as a script', () => {
    const r = spawnSync('npx', ['tsx', 'analysis/confirm.ts'], { cwd: REPO_ROOT, encoding: 'utf8', timeout: 60_000 });
    expect(r.status).toBe(2);
    expect(r.stderr).toContain(USAGE);
  });
});

describe('the pooled confirmation of packs B and C, with pack A as development data', () => {
  let json: Record<string, any>;
  let md: string;
  let before: Record<string, string>;
  let results: string;
  let logFrom: number;

  beforeAll(() => {
    before = foldersSnapshot();
    const f = freshDeps();
    results = f.results;
    logFrom = w.out.length;
    w.err.length = 0;
    expect(main(['gate-c', 'gate-b', '--dev', 'gate-a'], f.deps)).toBe(0);
    expect(w.err).toEqual([]);
    json = JSON.parse(fs.readFileSync(path.join(results, 'confirm.json'), 'utf8')) as Record<string, any>;
    md = fs.readFileSync(path.join(results, 'confirm.md'), 'utf8');
    pooledBC = json['pooled'] as Record<string, unknown>;
  }, 60_000);

  it('pools pack B and pack C, in pack order, scored with the frozen parameters', () => {
    expect(json['schema']).toBe('confirm/1');
    expect(json['confirmatory']).toBe(true);
    expect(json['not_confirmatory_because']).toEqual([]);
    expect(json['lost']).toEqual([]);
    expect(json['pooled'].packs).toEqual([
      { pack: 'B', id: 'gate-b' },
      { pack: 'C', id: 'gate-c' },
    ]);
    expect(json['params']).toMatchObject({ sha256: sha256Hex(w.retuneText), retune_tag: 'gate-retune', variant: 'D1', k: 2, theta_G: 0.02 });
    expect(json['packs'].map((p: Record<string, unknown>) => [p['pack'], p['standing'], p['verdict_by'], p['does_not_count_because']])).toEqual([
      ['B', 'counts', 'stage B', []],
      ['C', 'counts', 'stage B', []],
    ]);
    for (const p of json['packs']) expect(p.verdict_json.params_sha256).toBe(sha256Hex(w.retuneText));
  });

  it("gives counts that are the sums of the two packs' stage B counts", () => {
    const vb = readVerdict('gate-b');
    const vc = readVerdict('gate-c');
    const sum = (f: (v: Verdict) => number): number => f(vb) + f(vc);
    const p = json['pooled'];
    expect(p.events).toEqual({
      cued: sum((v) => v.events.cued),
      valid: sum((v) => v.events.valid),
      armed: sum((v) => v.events.armed),
      audible_inbreath: sum((v) => v.events.audible_inbreath),
    });
    expect(p.events.valid).toBe(25);
    expect(p.h1.stops_before_voice).toMatchObject({ k: sum((v) => v.rows.hits.hits), n: sum((v) => v.events.valid) });
    expect(p.h1.armed_hits).toBe(sum((v) => v.rows.hits.armed_hits));
    expect(p.h1.leads_0_50).toBe(sum((v) => v.rows.hits.leads_0_50));
    expect(p.h1.misses).toEqual({ no_inbreath: sum((v) => v.misses.no_inbreath), inbreath_audible: sum((v) => v.misses.inbreath_audible) });
    expect([p.h3.wins, p.h3.losses, p.h3.ties]).toEqual([sum((v) => v.rows.chest_vs_lips.wins), sum((v) => v.rows.chest_vs_lips.losses), sum((v) => v.rows.chest_vs_lips.ties)]);
    const [ab, ac] = [a250Of('gate-b'), a250Of('gate-c')];
    expect([p.h4.wins, p.h4.losses, p.h4.ties]).toEqual([ab[0] + ac[0], ab[1] + ac[1], ab[2] + ac[2]]);
    // False holds: each pack as stage B printed it, the pool as their sum.
    const perPack = p.false_holds.per_pack as { pack: string; false_stops: number; active_min: number; per_min: number }[];
    expect(perPack.map((x) => x.pack)).toEqual(['B', 'C']);
    [vb, vc].forEach((v, i) => {
      expect(round1(perPack[i]!.per_min)).toBe(v.rows.false_holds.per_min);
      expect(round1(perPack[i]!.active_min)).toBe(v.rows.false_holds.armed_min);
    });
    expect(p.false_holds.false_stops).toBe(perPack[0]!.false_stops + perPack[1]!.false_stops);
    expect(p.false_holds.false_stops).toBeGreaterThan(0);
    expect(p.false_holds.active_min).toBeCloseTo(perPack[0]!.active_min + perPack[1]!.active_min, 3);
    expect(p.h3.theta_G).toEqual({ B: 0.02, C: 0.02 });
  });

  it('tests H1 against the larger of the two chance estimates, and says estimate 3 is not computed', () => {
    const h1 = json['pooled'].h1;
    const share = shareLine(h1.stops_before_voice.k, h1.stops_before_voice.n);
    expect(h1.stops_before_voice.wilson95[0]).toBeCloseTo(share.low, 6);
    expect(h1.stops_before_voice.wilson95[1]).toBeCloseTo(share.high, 6);
    const c = h1.chance;
    expect(c.poisson.false_holds).toBe(json['pooled'].false_holds.false_stops);
    expect(c.circular_shift).toMatchObject({ shifts: 10_000, seed: 43, objections: h1.stops_before_voice.n, window_ms: 1500, left_out: [] });
    expect(c.sentence_ends).toBeNull();
    expect(c.sentence_ends_note).toBe(SENTENCE_ENDS_NOTE);
    expect(c.p0).toBe(Math.max(c.poisson.p0, c.circular_shift.share));
    expect(c.source).toBe(c.poisson.p0 >= c.circular_shift.share ? 'poisson' : 'shift');
    expect(h1.test).toMatchObject({ method: 'exact one-sided binomial test', k: h1.stops_before_voice.k, n: h1.stops_before_voice.n, p0: c.p0, alpha: 0.05 });
    expect(h1.test.below_alpha).toBe(h1.test.p_value <= 0.05);
    expect(md).toContain(`Estimate 3, sentence ends: ${SENTENCE_ENDS_NOTE}`);
  });

  it('prints the lead, H3 and H4 with Holm, the false holds and the sensitivity lines, each with its n', () => {
    const p = json['pooled'];
    expect(p.lead.stops_before_voice.n).toBe(p.h1.stops_before_voice.k);
    expect(p.lead.stops_before_voice.interval).toBe('order-statistics');
    expect(p.lead.all_stops_in_window.window_ms).toEqual([-1500, 500]);
    expect(p.holm).toEqual({ family: ['h3', 'h4'], alpha: 0.05 });
    expect(p.h3.p_holm).toBeGreaterThanOrEqual(p.h3.p_value);
    expect(p.h4.p_holm).toBeGreaterThanOrEqual(p.h4.p_value);
    expect(p.sensitivity.map((s: { key: string }) => s.key)).toEqual(['manual', 'earlier_25ms', 't_a', 'objection_400ms', 'non_speech_included']);
    // With non-speech counted, pack B's cough is a valid objection too.
    expect(p.sensitivity.find((s: { key: string }) => s.key === 'non_speech_included').n).toBe(p.events.valid + 1);
    for (const heading of ['## H1: stops before the voice (main)', '## Lead', '## H3 and H4: paired comparisons', '## False holds', '## Sensitivity lines (section 5)', '## Per pack']) {
      expect(md).toContain(heading);
    }
    expect(md).toContain('Holm-adjusted p = ');
  });

  it('labels the sensitivity lines as written, t_a in lower case', () => {
    expect(json['pooled'].sensitivity.map((s: { label: string }) => s.label)).toEqual(Object.values(SENSITIVITY_LABELS));
    expect(md).toContain('| Anchor t_a instead of t_v |');
    expect(md).not.toContain('T_a');
  });

  it('prints the exploratory line beside H3: the lips at the pooled chest rate, not a test (section 6.5)', () => {
    const p = json['pooled'];
    const smallest = Math.min(...THETA_G_GRID);
    const [ob, oc] = [readVerdict('gate-b'), readVerdict('gate-c')].map((v) => v.rows.chest_vs_lips.exploratory_equal_rate!);
    // The lips make no false fire in these objection blocks even at the smallest theta_G of the grid,
    // so the pooled line and each pack's own line in its verdict.json are all there, and the pooled
    // pairs are the sums of the packs' own (one pair per valid objection, chest first).
    expect(p.h3.lips_false.false_stops).toBe(0);
    const wins = ob!.wins + oc!.wins;
    const losses = ob!.losses + oc!.losses;
    expect(p.h3.exploratory_equal_rate).toEqual({
      exploratory: true,
      theta_G: smallest,
      lips_false_per_min: 0,
      chest_false_per_min: p.h3.chest_false.per_min,
      last_theta_G: smallest,
      wins,
      losses,
      ties: p.events.valid - wins - losses,
      n_pairs: p.events.valid,
    });
    expect(md).toContain(
      `  - Exploratory, lips at the chest rate (section 6.5): at theta_G ${smallest.toFixed(4)}, the smallest of the grid that does it, the lips make 0.0 false fires per active minute in the objection blocks against the chest's ${round1(p.h3.chest_false.per_min).toFixed(1)} (rounded to 0.1 as printed); chest wins ${wins}, lips wins ${losses}, ties ${p.events.valid - wins - losses}, n = ${p.events.valid} pairs. Not a test.`,
    );
    expect(md.indexOf('Exploratory, lips at the chest rate')).toBeGreaterThan(md.indexOf('- H3, chest against lips'));
    expect(md.indexOf('Exploratory, lips at the chest rate')).toBeLessThan(md.indexOf('- H4, chest against the 250 ms rule'));
  });

  it('carries the setup line and flags a pack with fewer than 12 valid objections', () => {
    const line = `one person, one setup, SmartSpectra SDK ${SDK}, 28 cued events, 25 valid objections`;
    expect(json['setup']).toMatchObject({ line, people: 1, setups: 1, sdk_versions: { B: SDK, C: SDK }, cued: 28, valid: 25 });
    expect(md).toContain(`- Setup: ${line}.`);
    const [b, c] = json['packs'];
    expect(b.flags).toEqual([expect.stringMatching(/^pack B has 11 valid objections, fewer than 12: .* stays in the pooled numbers, flagged/)]);
    expect(c.flags).toEqual([]);
    expect(md).toContain('Flag: pack B has 11 valid objections');
  });

  it("shows each pack's five rows and verdict as stage B wrote them", () => {
    for (const [i, id] of ['gate-b', 'gate-c'].entries()) {
      const p = json['packs'][i];
      expect(p.verdict_json).toEqual(readVerdict(id));
      const text = fs.readFileSync(path.join(w.sessions, id, 'verdict.md'), 'utf8');
      expect(p.verdict_md).toBe(text);
      expect(md).toContain(text.trimEnd());
    }
    expect(json['packs'][0].verdict).toBe('NOT EVALUABLE');
  });

  it('says what it checked of the parameters and of the tag gate-retune, and claims no more', () => {
    const t = json['retune_tag'];
    expect(t).toMatchObject({ tag: 'gate-retune', time: TAG_TIME, code_differences: [] });
    expect(t.recordings).toEqual([
      { pack: 'B', id: 'gate-b', started_utc: w.start },
      { pack: 'C', id: 'gate-c', started_utc: w.start },
    ]);
    expect(t.code_files).toEqual(confirmCodeFiles().map(repoPath));
    expect(md).toContain('- Stage A and stage B: the ledgers of pack B and pack C hold this hash in their stage A lines, and stage B scored with it.');
    expect(md).toContain(`- The tag gate-retune: made ${TAG_TIME} (the time git gives the tag); pack B started ${w.start}, pack C started ${w.start}.`);
    expect(md).toMatch(/^- The pooled analysis code \(\d+ files: analysis\/confirm\.ts, analysis\/confirm\/[^)]*\) equals its copy under the tag gate-retune\.$/m);
    expect(md).not.toMatch(/tuned nothing|Not confirmatory/);
  });

  it('prints pack A apart as development data, never pooled, with the frozen parameters', () => {
    const dev = json['dev'];
    expect(dev).toMatchObject({ development_data: true, pooled: false });
    expect(dev.numbers.packs).toEqual([{ pack: 'A', id: 'gate-a' }]);
    expect(dev.numbers.h3.theta_G).toEqual({ A: 0.02 });
    // Pack A's own verdict, as stage B wrote it with its stage A parameters.
    expect(dev.pack.verdict_json).toEqual(readVerdict('gate-a'));
    expect(dev.pack.verdict_json.params_sha256).toBe(sha256Hex(w.stageAText));
    expect(dev.params_note).toContain(`stage A parameters ${sha256Hex(w.stageAText).slice(0, 8)}`);
    expect(dev.numbers.events.cued).toBe(14);
    expect(json['pooled'].events.cued).toBe(28);
    expect(md).toContain('## Development data: pack A (gate-a), not pooled');
    expect(md.indexOf('## Development data')).toBeGreaterThan(md.indexOf('## Per pack'));
  });

  it('writes plain public text, prints a short summary and only reads the session folders', () => {
    expectPlainText(md, json);
    expect(fs.readFileSync(path.join(results, 'confirm.json'), 'utf8').endsWith('}\n')).toBe(true);
    expect(fs.readdirSync(results).sort()).toEqual(['confirm.json', 'confirm.md']);
    const summary = w.out.slice(logFrom);
    expect(summary[0]).toMatch(/^confirm: pooled pack B \(gate-b\) and pack C \(gate-c\)/);
    expect(summary.some((l) => l.startsWith('H1: '))).toBe(true);
    expect(summary.some((l) => l.startsWith('development data, pack A (gate-a), not pooled'))).toBe(true);
    expect(summary.some((l) => l.startsWith('NOT CONFIRMATORY'))).toBe(false);
    expect(summary[summary.length - 1]).toMatch(/^confirm: wrote .*confirm\.json and .*confirm\.md$/);
    expect(foldersSnapshot()).toEqual(before);
  });

  it('gives the same pooled numbers for the ids in the other order, without --dev', () => {
    const { deps } = freshDeps();
    const o = runConfirm({ ids: ['gate-b', 'gate-c'], dev: null, deps });
    expect(o.json['pooled']).toEqual(json['pooled']);
    expect(o.json['dev']).toBeNull();
    expect(o.markdown).not.toContain('Development data');
  }, 60_000);
});

describe('a pack that failed quickcheck on condition 6 alone: scored by confirm, in the numbers, flagged (section 11)', () => {
  let r: Ran;

  beforeAll(() => {
    // Pack C as quickcheck leaves it with too few replies: stage A and stage B never ran.
    const dir = copySession('gate-c', 'gate-c-content');
    withoutStages(dir);
    failRepliesOnly(dir, 11);
    r = confirmed(['gate-b', 'gate-c-content']);
  }, 60_000);

  it('is a recording stage A refuses, so it never has a stage B of its own', async () => {
    w.err.length = 0;
    expect(await gateMain(['--stage', 'A', 'gate-c-content'], w.deps)).toBe(1);
    expect(w.err.join('\n')).toMatch(/this recording does not count, so analyze:gate does not score it/);
  }, 60_000);

  it('gives the pooled numbers that pack B and pack C give when stage B scored both', () => {
    const expected = pooledBC ?? runConfirm({ ids: ['gate-b', 'gate-c'], dev: null, deps: freshDeps().deps }).json['pooled'];
    expect(r.json['pooled']).toEqual(expected);
    expect(r.json['confirmatory']).toBe(true);
    expect(r.json['lost']).toEqual([]);
    expect(r.md.startsWith('# Pooled confirmation: packs B and C\n')).toBe(true);
  }, 60_000);

  it("scores it with stage B's function and the frozen parameters, marked as confirm's scoring", () => {
    const [b, c] = r.json['packs'];
    expect(b).toMatchObject({ pack: 'B', standing: 'counts', verdict_by: 'stage B' });
    expect(c).toMatchObject({ pack: 'C', id: 'gate-c', standing: 'content', verdict_by: 'confirm' });
    // Stage B's verdict on the same files, but for T and M, which confirm does not run.
    expect(c.verdict_json).toEqual({ ...readVerdict('gate-c'), other: null });
    expect(c.does_not_count_because).toEqual(['quickcheck.json says RE-RECORD NOW: a voice was found within 10 s after only 11 of 14 cues (needs 12)']);
    const own = fs.readFileSync(path.join(w.sessions, 'gate-c', 'verdict.md'), 'utf8').split('\n');
    const head = `GATE ROWS gate-c pack C | scored by npm run confirm with stage B's function, not by stage B | params ${sha256Hex(w.retuneText).slice(0, 8)}`;
    expect(c.verdict_md).toBe(own.map((l, i) => (i === 0 ? head : l.startsWith('OTHER ') ? 'OTHER   not computed (descriptive)' : l)).join('\n'));
  });

  it('flags it in confirm.json, confirm.md and the summary', () => {
    const flag =
      /^pack C failed quickcheck on condition 6 alone \(voice after 11 cues where quickcheck needs 12\), which is not technical: stage A and stage B do not score such a recording, so npm run confirm scored it with stage B's function and the frozen parameters, and it stays in the pooled numbers, flagged \(PREREG\.md sections 7\.4, 11\)$/;
    expect(r.json['packs'][1].flags).toEqual([expect.stringMatching(flag)]);
    expect(r.md).toContain('- Flag: pack C failed quickcheck on condition 6 alone');
    expect(r.md).toContain("### Pack C (gate-c): five rows and verdict by stage B's function, scored by npm run confirm: stage B does not score a recording that failed quickcheck");
    expect(r.md).toMatch(/^\| C \| gate-c \|.*\(scored by npm run confirm\) \|$/m);
    expect(r.md).toContain(
      '- Stage A and stage B: the ledger of pack B holds this hash in its stage A line, and stage B scored with it; pack C has no stage A or stage B, which do not run on a recording that failed quickcheck, and was scored here with this file.',
    );
    expect(r.summary.some((l) => l.startsWith('flag: pack C failed quickcheck on condition 6 alone'))).toBe(true);
    expectPlainText(r.md, r.json);
  });
});

describe('a pack lost after 4:15 is reported, not replaced; one that failed before 4:15 is recorded again (section 11)', () => {
  it('gives the numbers of the other pack and reports the lost one with its reason', () => {
    const dir = copySession('gate-c', 'gate-c-lost');
    withoutStages(dir);
    failTechnical(dir);
    const r = confirmed(['gate-b', 'gate-c-lost']);
    const why = 'quickcheck.json says RE-RECORD NOW: microphone processing not off';
    expect(r.json['lost']).toEqual([
      {
        pack: 'C',
        id: 'gate-c',
        cause: 'technical',
        objections_begun: true,
        reasons: [why],
        note: `pack C (gate-c) is lost: it failed for a technical reason after its objection block began (4:15), so it is not in the numbers and not replaced (PREREG.md section 11). Reason: ${why}`,
      },
    ]);
    const alone = `the confirmatory numbers are those of pack B alone, ${readVerdict('gate-b').events.valid} valid objections (at most 14), with the same tests, because pack C is lost (PREREG.md section 11)`;
    expect(r.json['flags']).toEqual([alone]);
    const vb = readVerdict('gate-b');
    expect(r.json['packs'].map((p: { pack: string }) => p.pack)).toEqual(['B']);
    expect(r.json['pooled'].packs).toEqual([{ pack: 'B', id: 'gate-b' }]);
    expect(r.json['pooled'].events).toEqual({ cued: vb.events.cued, valid: vb.events.valid, armed: vb.events.armed, audible_inbreath: vb.events.audible_inbreath });
    expect(r.json['setup'].line).toBe(`one person, one setup, SmartSpectra SDK ${SDK}, 14 cued events, 11 valid objections`);
    // The tag must come before every recording of packs B and C, the lost one too.
    expect(r.json['retune_tag'].recordings.map((x: { pack: string }) => x.pack)).toEqual(['B', 'C']);
    expect(r.json['confirmatory']).toBe(true);
    expect(r.md.startsWith('# Confirmation: pack B, pack C lost\n')).toBe(true);
    expect(r.md).toContain('Confirmatory numbers over the valid objections of pack B, with the frozen trace detector');
    expect(r.md).toContain(`- Lost: ${r.json['lost'][0].note}.`);
    expect(r.md).toContain(`- Flag: ${alone}.`);
    expect(r.summary[0]).toMatch(/^confirm: numbers of pack B \(gate-b\); params /);
    expect(r.summary).toContain(`lost: ${r.json['lost'][0].note}`);
    expect(r.summary).toContain(`flag: ${alone}`);
    expectPlainText(r.md, r.json);
  }, 60_000);

  it('refuses a pack that failed for a technical reason before its objection block began', () => {
    const dir = copySession('gate-c', 'gate-c-early');
    failTechnical(dir);
    dropStepMark(dir, gateSteps('C').objections);
    refused(
      ['gate-b', 'gate-c-early'],
      /pack C \(gate-c\) failed for a technical reason before its objection block began \(4:15\), so it is not the recording of pack C: by PREREG\.md section 11 pack C is recorded again, and that recording is the one to give:\n {2}quickcheck\.json says RE-RECORD NOW: microphone processing not off$/,
    );
  });

  it('reports a pack the SDK ended with kCreditExhausted before 4:15 as lost, not recorded again, and gives pack B alone, flagged', () => {
    const dir = copySession('gate-c', 'gate-c-credits-early');
    withoutStages(dir);
    endByCredits(dir);
    dropStepMark(dir, gateSteps('C').objections);
    const r = confirmed(['gate-c-credits-early', 'gate-b']);
    const why = 'quickcheck.json says RE-RECORD NOW: the SDK reported 1 error(s) (code 4 kCreditExhausted)';
    const note = `pack C (gate-c) is lost: the SDK ended it with kCreditExhausted (the SDK credits were used up) before its objection block began (4:15), so it is not in the numbers and not replaced (PREREG.md section 11). Reason: ${why}`;
    expect(r.json['lost']).toEqual([{ pack: 'C', id: 'gate-c', cause: 'credits', objections_begun: false, reasons: [why], note }]);
    const vb = readVerdict('gate-b');
    const alone = `the confirmatory numbers are those of pack B alone, ${vb.events.valid} valid objections (at most 14), with the same tests, because pack C is lost (PREREG.md section 11)`;
    expect(r.json['flags']).toEqual([alone]);
    expect(r.json['packs'].map((p: { pack: string }) => p.pack)).toEqual(['B']);
    expect(r.json['pooled'].packs).toEqual([{ pack: 'B', id: 'gate-b' }]);
    expect(r.json['pooled'].events).toEqual({ cued: vb.events.cued, valid: vb.events.valid, armed: vb.events.armed, audible_inbreath: vb.events.audible_inbreath });
    expect(r.json['confirmatory']).toBe(true);
    expect(r.md.startsWith('# Confirmation: pack B, pack C lost\n')).toBe(true);
    expect(r.md).toContain(`- Lost: ${note}.`);
    expect(r.md).toContain(`- Flag: ${alone}.`);
    expect(r.summary).toContain(`lost: ${note}`);
    expect(r.summary).toContain(`flag: ${alone}`);
    expectPlainText(r.md, r.json);
  }, 60_000);

  it('reports a pack the SDK ended with kCreditExhausted after 4:15 as lost, with that cause', () => {
    const dir = copySession('gate-c', 'gate-c-credits-late');
    withoutStages(dir);
    endByCredits(dir);
    const r = confirmed(['gate-b', 'gate-c-credits-late']);
    expect(r.json['lost']).toMatchObject([{ pack: 'C', id: 'gate-c', cause: 'credits', objections_begun: true }]);
    expect(r.json['lost'][0].note).toMatch(
      /^pack C \(gate-c\) is lost: the SDK ended it with kCreditExhausted \(the SDK credits were used up\) after its objection block began \(4:15\), so it is not in the numbers and not replaced \(PREREG\.md section 11\)\. Reason: /,
    );
    expect(r.json['pooled'].packs).toEqual([{ pack: 'B', id: 'gate-b' }]);
  }, 60_000);

  it('reads the kCreditExhausted line only from events.jsonl as the record step wrote it', () => {
    const dir = copySession('gate-c', 'gate-c-credits-added');
    withoutStages(dir);
    failTechnical(dir);
    dropStepMark(dir, gateSteps('C').objections);
    // The record step holds the hash of events.jsonl, as host writes it (live/host.cjs saveRecording).
    const events = fs.readFileSync(path.join(dir, 'events.jsonl'), 'utf8');
    reforgeLedger(dir, (r) => (!isNoteLine(r) && r.step === 'record' ? { ...r, out_sha256: { ...r.out_sha256, 'events.jsonl': sha256Hex(events) } } : r));
    refused(['gate-b', 'gate-c-credits-added'], /pack C \(gate-c\) failed for a technical reason before its objection block began \(4:15\)/);
    // A kCreditExhausted line added after the recording does not make it lost.
    appendTo(dir, 'events.jsonl', JSON.stringify({ n: null, e: 'sdk_error', by: 'host', code: 4, name: 'kCreditExhausted', message: 'added later' }));
    refused(['gate-b', 'gate-c-credits-added'], /pack C \(gate-c\): a file of an earlier step does not match ledger\.jsonl, so nothing is scored \(spec 8\.5\):\n {2}events\.jsonl changed after step record wrote it/);
  });

  it('does not take the one restart of the SDK, or another SDK error, for the end of the credits', () => {
    const dir = copySession('gate-c', 'gate-c-other-error');
    withoutStages(dir);
    failTechnical(dir);
    dropStepMark(dir, gateSteps('C').objections);
    appendTo(dir, 'events.jsonl', JSON.stringify({ n: null, e: 'sdk_error', by: 'host', code: 8, name: 'kCameraFailure', message: 'restart', action: 'reset_restart' }));
    appendTo(dir, 'events.jsonl', JSON.stringify({ n: null, e: 'sdk_error', by: 'host', code: 1, name: 'kInvalidState', message: 'state' }));
    refused(['gate-b', 'gate-c-other-error'], /pack C \(gate-c\) failed for a technical reason before its objection block began \(4:15\), so it is not the recording of pack C/);
  });

  it('refuses when both recordings are lost: there are no confirmatory numbers', () => {
    failTechnical(copySession('gate-b', 'gate-b-lost'));
    failTechnical(copySession('gate-c', 'gate-c-lost-too'));
    refused(
      ['gate-c-lost-too', 'gate-b-lost'],
      /both recordings are lost, so there are no confirmatory numbers \(PREREG\.md section 11\):\n {2}pack B \(gate-b\): it failed for a technical reason after its objection block began \(4:15\)\. Reason: quickcheck\.json says RE-RECORD NOW: microphone processing not off\n {2}pack C \(gate-c\): it failed for a technical reason after its objection block began \(4:15\)\. Reason: quickcheck\.json says RE-RECORD NOW/,
    );
  });

  it('reads the standing as stage A and stage B do: the clock check must be valid, and condition 6 alone is not technical', () => {
    const valid = { audio_valid: true, trace_valid: true as boolean | null };
    expect(standingOf({ result: 'GOOD RECORDING', technical: null }, valid)).toBe('counts');
    expect(standingOf({ result: 'RE-RECORD NOW', technical: false }, valid)).toBe('content');
    expect(standingOf({ result: 'RE-RECORD NOW', technical: true }, valid)).toBe('technical');
    expect(standingOf({ result: 'GOOD RECORDING', technical: null }, { audio_valid: false, trace_valid: true })).toBe('technical');
    expect(standingOf({ result: 'GOOD RECORDING', technical: null }, { audio_valid: true, trace_valid: false })).toBe('technical');
    // without the camera there is no trace verdict
    expect(standingOf({ result: 'RE-RECORD NOW', technical: false }, { audio_valid: true, trace_valid: null })).toBe('technical');
    // a technical quickcheck failure may come without a clock check
    expect(standingOf({ result: 'RE-RECORD NOW', technical: true }, null)).toBe('technical');
  });

  it('refuses --dev with a pack A recording that does not count', () => {
    failTechnical(copySession('gate-a', 'gate-a-void'));
    refused(
      ['gate-b', 'gate-c', '--dev', 'gate-a-void'],
      /pack A \(gate-a\) does not count, so it has no numbers: --dev takes the pack A recording with GOOD RECORDING, a valid clock check and its stage B \(PREREG\.md sections 4, 7\.4, 11\):\n {2}quickcheck\.json says RE-RECORD NOW: microphone processing not off/,
    );
  });
});

describe('pack B alone, when pack C has no recording (section 11)', () => {
  let alone: string;

  beforeAll(() => {
    alone = path.join(w.base, 'sessions-b-alone');
    fs.mkdirSync(alone);
    copySession('gate-b', 'gate-b', alone);
    // An attempt at pack C that failed for a technical reason before 4:15: section 11 records the pack again.
    const early = copySession('gate-c', 'gate-c-early', alone);
    withoutStages(early);
    failTechnical(early);
    dropStepMark(early, gateSteps('C').objections);
  });

  it('gives the numbers of pack B alone, flagged, and says pack C has no recording', () => {
    const r = confirmed(['gate-b'], { COPYHOLDER_SESSIONS_DIR: alone });
    const vb = readVerdict('gate-b');
    const tried = 'the recording gate-c failed for a technical reason before 4:15, so section 11 records the pack again';
    const note = `pack C has no recording: npm run confirm was given pack B alone, and the sessions folder holds no recording of pack C that reached its objection block (4:15): ${tried}. PREREG.md section 11 allows this when pack C cannot be started for lack of SDK credits`;
    expect(r.json['lost']).toEqual([{ pack: 'C', id: null, cause: 'not recorded', objections_begun: false, reasons: [tried], note }]);
    const flag = `the confirmatory numbers are those of pack B alone, ${vb.events.valid} valid objections (at most 14), with the same tests, because pack C has no recording (PREREG.md section 11)`;
    expect(r.json['flags']).toEqual([flag]);
    expect(r.json['packs'].map((p: { pack: string }) => p.pack)).toEqual(['B']);
    expect(r.json['pooled'].packs).toEqual([{ pack: 'B', id: 'gate-b' }]);
    expect(r.json['pooled'].events).toEqual({ cued: vb.events.cued, valid: vb.events.valid, armed: vb.events.armed, audible_inbreath: vb.events.audible_inbreath });
    expect(r.json['retune_tag'].recordings.map((x: { pack: string }) => x.pack)).toEqual(['B']);
    expect(r.json['confirmatory']).toBe(true);
    expect(r.md.startsWith('# Confirmation: pack B, pack C not recorded\n')).toBe(true);
    expect(r.md).toContain('Confirmatory numbers over the valid objections of pack B, with the frozen trace detector');
    expect(r.md).toContain(`- Not recorded: ${note}.`);
    expect(r.md).toContain(`- Flag: ${flag}.`);
    expect(r.summary[0]).toMatch(/^confirm: numbers of pack B \(gate-b\); params /);
    expect(r.summary).toContain(`not recorded: ${note}`);
    expect(r.summary).toContain(`flag: ${flag}`);
    expectPlainText(r.md, r.json);
  }, 60_000);

  it('refuses pack B alone while the sessions folder holds a recording of pack C', () => {
    refused(['gate-b'], /pack C has a recording, gate-c in .*gate-c, so pack B is not given alone: give it as the second id; it is in the numbers \(PREREG\.md section 11\)$/);
    const lostC = copySession('gate-c', 'gate-c-lost', alone);
    try {
      withoutStages(lostC);
      failTechnical(lostC);
      refused(
        ['gate-b'],
        /pack C has a recording, gate-c in .*gate-c-lost, so pack B is not given alone: give it as the second id; it is lost \(it failed for a technical reason after its objection block began \(4:15\)\) and is reported as lost \(PREREG\.md section 11\)$/,
        { COPYHOLDER_SESSIONS_DIR: alone },
      );
    } finally {
      fs.rmSync(lostC, { recursive: true, force: true });
    }
  });

  it('refuses a pack C recording it cannot read yet, so that nothing of pack C is left out', () => {
    const fresh = copySession('gate-c', 'gate-c-unread', alone);
    try {
      withoutStages(fresh);
      refused(['gate-b'], /pack C has a recording, gate-c in .*gate-c-unread, so pack B is not given alone: give it as the second id; confirm cannot read it yet: pack C \(gate-c\): stage A has not run/, {
        COPYHOLDER_SESSIONS_DIR: alone,
      });
    } finally {
      fs.rmSync(fresh, { recursive: true, force: true });
    }
  });

  it('refuses pack C alone: pack B is recorded first', () => {
    refused(['gate-c'], /gate-c is pack C: one id alone must be the pack B recording, for the numbers of pack B alone when pack C cannot be started for lack of SDK credits \(PREREG\.md section 11\)/);
  });

  it('refuses pack B alone when pack B is lost: there are no confirmatory numbers', () => {
    const root = path.join(w.base, 'sessions-b-lost');
    fs.mkdirSync(root);
    const b = copySession('gate-b', 'gate-b-lost', root);
    withoutStages(b);
    failTechnical(b);
    refused(
      ['gate-b-lost'],
      /pack B is lost and pack C has no recording, so there are no confirmatory numbers \(PREREG\.md section 11\):\n {2}pack B \(gate-b\): it failed for a technical reason after its objection block began \(4:15\)\. Reason: quickcheck\.json says RE-RECORD NOW: microphone processing not off$/,
      { COPYHOLDER_SESSIONS_DIR: root },
    );
  });
});

describe('the tag gate-retune: the pooled code frozen under it, and its time before the recordings (section 11)', () => {
  const asItIs = (_tag: string, file: string): string | null => (fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null);
  const starts = [
    { pack: 'B', id: 'gate-b', startedUtc: '2026-11-13T18:00:00Z' },
    { pack: 'C', id: 'gate-c', startedUtc: '2026-11-14T18:00:00Z' },
  ];

  it('compares analysis/confirm.ts and every file of analysis/confirm/ but the tests with their copies under the tag', () => {
    const files = confirmCodeFiles().map(repoPath);
    expect(files[0]).toBe('analysis/confirm.ts');
    expect(files).toEqual(expect.arrayContaining(['analysis/confirm/load.ts', 'analysis/confirm/numbers.ts', 'analysis/confirm/run.ts', 'analysis/confirm/tag.ts']));
    expect(files.every((f) => f === 'analysis/confirm.ts' || /^analysis\/confirm\/[a-z-]+\.ts$/.test(f))).toBe(true);
    expect(files.some((f) => f.endsWith('.test.ts'))).toBe(false);
    const t = retuneTagFacts(starts, { tagFile: asItIs, tagTime: () => TAG_TIME });
    expect(t).toMatchObject({ tag: 'gate-retune', tagTime: TAG_TIME, codeFiles: files, codeDifferences: [], problems: [] });
  });

  it('names each file that differs from its copy under the tag, or is not under it', () => {
    const run = path.join(REPO_ROOT, 'analysis', 'confirm', 'run.ts');
    const tag = path.join(REPO_ROOT, 'analysis', 'confirm', 'tag.ts');
    const t = retuneTagFacts(starts, { tagFile: (x, f) => (f === run ? '// an older copy\n' : f === tag ? null : asItIs(x, f)), tagTime: () => TAG_TIME });
    expect(t.codeDifferences).toEqual(['analysis/confirm/run.ts differs from its copy under the tag gate-retune', 'analysis/confirm/tag.ts is not under the tag gate-retune']);
    expect(t.problems).toEqual(t.codeDifferences.map((d) => `the pooled analysis code is not the code frozen with the parameters: ${d}`));
  });

  it('needs the tag earlier than the start of each recording, by the clock in any time zone, and its time from git', () => {
    const problems = (time: string | null): string[] => retuneTagFacts(starts, { tagFile: asItIs, tagTime: () => time }).problems;
    // 19:30 at +02:00 is 17:30 UTC, half an hour before pack B started
    expect(problems('2026-11-13T19:30:00+02:00')).toEqual([]);
    expect(problems('2026-11-14T00:00:00Z')).toEqual([
      'the tag gate-retune (2026-11-14T00:00:00Z) is not earlier than the start of pack B (gate-b) at 2026-11-13T18:00:00Z: the parameters were not frozen before that pack was recorded',
    ]);
    // the same second is not earlier
    expect(problems('2026-11-14T18:00:00Z')).toHaveLength(2);
    expect(problems(null)).toEqual(['the time of the tag gate-retune could not be read from git, so it is not shown to come before the recordings']);
  });

  it('computes the numbers but marks them not confirmatory, with the reasons, when a condition is not met', () => {
    // Pack C lost, so that only pack B is computed.
    const dir = copySession('gate-c', 'gate-c-lost-again');
    withoutStages(dir);
    failTechnical(dir);
    let r: Ran | null = null;
    const late = '2026-11-20T09:00:00Z';
    withTag({ code: { 'analysis/confirm/numbers.ts': '// an older copy\n' }, time: late }, () => {
      r = confirmed(['gate-b', 'gate-c-lost-again']);
    });
    const ran = r as unknown as Ran;
    const why = [
      'the pooled analysis code is not the code frozen with the parameters: analysis/confirm/numbers.ts differs from its copy under the tag gate-retune',
      `the tag gate-retune (${late}) is not earlier than the start of pack B (gate-b) at ${w.start}: the parameters were not frozen before that pack was recorded`,
      `the tag gate-retune (${late}) is not earlier than the start of pack C (gate-c) at ${w.start}: the parameters were not frozen before that pack was recorded`,
    ];
    expect(ran.json['confirmatory']).toBe(false);
    expect(ran.json['not_confirmatory_because']).toEqual(why);
    expect(ran.json['retune_tag']).toMatchObject({ time: late, code_differences: ['analysis/confirm/numbers.ts differs from its copy under the tag gate-retune'] });
    expect(ran.md).toContain(`**Not confirmatory.** These numbers are computed as PREREG.md section 11 says, but a condition of section 11 is not met: ${why.join('; ')}.`);
    expect(ran.md).toContain('- The pooled analysis code differs from its copy under the tag gate-retune: analysis/confirm/numbers.ts differs from its copy under the tag gate-retune.');
    expect(ran.summary[1]).toBe(`NOT CONFIRMATORY: ${why.join('; ')}`);
    expect(ran.json['pooled'].packs).toEqual([{ pack: 'B', id: 'gate-b' }]);
    expectPlainText(ran.md, ran.json);
  }, 60_000);
});

describe('refusals: nothing is computed or written unless every check passes', () => {
  it('refuses the same recording twice', () => {
    refused(['gate-b', 'gate-b'], /gate-b and gate-b are the same recording/);
    refused(['gate-b', path.join(w.sessions, 'gate-b')], /are the same recording/);
  });

  it('refuses two recordings of the same pack', () => {
    copySession('gate-b', 'gate-b-again');
    refused(['gate-b', 'gate-b-again'], /are both pack B: the confirmation pools one recording of pack B and one of pack C/);
  });

  it('refuses pack A among the two, and anything but pack A for --dev', () => {
    refused(['gate-a', 'gate-c'], /gate-a is the pack A recording: pack A tunes the detector and is development data/);
    refused(['gate-b', 'gate-c', '--dev', 'gate-b'], /--dev takes the pack A recording; gate-b is pack B/);
  });

  it('refuses the pack 0 probe and a folder that is not there', () => {
    const dir = copySession('gate-c', 'gate-probe');
    setPack(dir, '0');
    refused(['gate-b', 'gate-probe'], /pack 0 probe, which is never scored/);
    refused(['gate-b', 'gate-missing'], /gate-missing: no session folder/);
  });

  it('refuses a folder that is not a day-one gate recording of a pack', () => {
    const none = copySession('gate-c', 'gate-no-manifest');
    fs.rmSync(path.join(none, 'manifest.json'));
    refused(['gate-b', 'gate-no-manifest'], /^confirm refused: gate-no-manifest: .*gate-no-manifest has no manifest\.json$/);
    const bad = copySession('gate-c', 'gate-bad-manifest');
    putFile(path.join(bad, 'manifest.json'), '{}\n');
    refused(['gate-b', 'gate-bad-manifest'], /^confirm refused: gate-bad-manifest: manifest\.json is not valid:\n {2}/);
    const smoke = copySession('gate-c', 'gate-smoke');
    editManifest(smoke, (m) => {
      m['kind'] = 'smoke';
      m['pack'] = null;
    });
    refused(['gate-b', 'gate-smoke'], /gate-smoke is a smoke record, not a day-one gate recording: npm run confirm pools the gate recordings of packs B and C/);
    const packless = copySession('gate-c', 'gate-no-pack');
    editManifest(packless, (m) => {
      m['pack'] = null;
    });
    refused(['gate-b', 'gate-no-pack'], /gate-c has no pack; the two ids are the gate recordings of packs B and C/);
  });

  it('refuses a recording whose ledger.jsonl is missing or broken', () => {
    const none = copySession('gate-c', 'gate-no-ledger');
    fs.rmSync(path.join(none, 'ledger.jsonl'));
    refused(['gate-b', 'gate-no-ledger'], /pack C \(gate-c\): .*ledger\.jsonl does not exist: the recording has no step journal/);
    const broken = copySession('gate-c', 'gate-broken-ledger');
    appendTo(broken, 'ledger.jsonl', 'not a ledger line');
    refused(['gate-b', 'gate-broken-ledger'], /pack C \(gate-c\): ledger\.jsonl is broken, nothing is run:\n {2}/);
  });

  it('refuses quickcheck.json and clock_report.json other than their steps wrote them', () => {
    const q = copySession('gate-c', 'gate-quickcheck-edited');
    appendTo(q, 'quickcheck.json', '');
    refused(['gate-b', 'gate-quickcheck-edited'], /pack C \(gate-c\): a file of an earlier step does not match ledger\.jsonl, so nothing is scored \(spec 8\.5\):\n {2}quickcheck\.json changed after step quickcheck wrote it/);
    const c = copySession('gate-c', 'gate-clock-edited');
    appendTo(c, 'clock_report.json', '');
    refused(['gate-b', 'gate-clock-edited'], /pack C \(gate-c\): a file of an earlier step does not match ledger\.jsonl[\s\S]*clock_report\.json changed after step \w+ wrote it/);
    const invalid = copySession('gate-c', 'gate-quickcheck-invalid');
    replaceRecorded(invalid, 'quickcheck.json', '{}\n');
    refused(['gate-b', 'gate-quickcheck-invalid'], /pack C \(gate-c\): quickcheck\.json is not valid:\n {2}/);
  });

  it('refuses a recording whose stage B has not finished, or whose stage A has not run', () => {
    const b = copySession('gate-c', 'gate-no-stage-b');
    reforgeLedger(b, (r) => (!isNoteLine(r) && (r.step === 'stage_b' || r.step === 'verdict') ? null : r));
    fs.rmSync(path.join(b, 'verdict.json'));
    fs.rmSync(path.join(b, 'verdict.md'));
    refused(['gate-b', 'gate-no-stage-b'], /pack C \(gate-c\): stage B has not finished/);
    const a = copySession('gate-c', 'gate-no-stage-a');
    reforgeLedger(a, (r) => (!isNoteLine(r) && (r.step === 'stage_a' || r.step === 'stage_b' || r.step === 'verdict') ? null : r));
    refused(['gate-b', 'gate-no-stage-a'], /pack C \(gate-c\): stage A has not run/);
  });

  it('refuses a verdict.json changed after stage B wrote it', () => {
    const dir = copySession('gate-c', 'gate-edited');
    const v = readVerdict('gate-c');
    putFile(path.join(dir, 'verdict.json'), `${JSON.stringify({ ...v, verdict: 'PASS' })}\n`);
    refused(['gate-b', 'gate-edited'], /pack C \(gate-c\): a file of an earlier step does not match ledger\.jsonl[\s\S]*verdict\.json changed after step \w+ wrote it/);
  });

  it('refuses a verdict.json of another run, another recording or another parameter set than its stage A', () => {
    const run2 = copySession('gate-c', 'gate-verdict-run-2');
    editJson(run2, 'verdict.json', (v) => {
      v['run'] = 2;
      v['exploratory'] = true;
    });
    refused(['gate-b', 'gate-verdict-run-2'], /pack C \(gate-c\): verdict\.json is from stage B run 2, not the confirmatory run 1/);
    const other = copySession('gate-c', 'gate-verdict-other');
    editJson(other, 'verdict.json', (v) => {
      v['id'] = 'gate-x';
    });
    refused(['gate-b', 'gate-verdict-other'], /pack C \(gate-c\): verdict\.json is for gate-x pack C, not for gate-c pack C/);
    const params = copySession('gate-c', 'gate-verdict-params');
    const next = sha256Hex(tunedText(2.5, 0.02));
    editJson(params, 'verdict.json', (v) => {
      v['params_sha256'] = next;
    });
    refused(['gate-b', 'gate-verdict-params'], new RegExp(`pack C \\(gate-c\\): verdict\\.json was scored with params ${next.slice(0, 8)}, but stage A froze ${sha256Hex(w.retuneText).slice(0, 8)}`));
  });

  it('checks the files stage B scores from in both recordings before it computes either', () => {
    // Computing the forged pack B would refuse on its verdict.json; each refusal below names a
    // file of pack C instead, so pack C was checked before pack B was computed.
    forgedB();
    const samples = copySession('gate-c', 'gate-no-samples');
    fs.rmSync(path.join(samples, 'samples.jsonl'));
    refused(
      ['gate-b-forged', 'gate-no-samples'],
      /pack C \(gate-c\): stage B reads every line of stamps\.jsonl, detector_in\.jsonl, samples\.jsonl, calib\.json; a lost or broken input is a technical failure, not a reading of the gate \(spec 8\.1, 9\.4\):\n {2}samples\.jsonl is missing/,
    );
    const broken = copySession('gate-c', 'gate-broken-input');
    appendTo(broken, 'detector_in.jsonl', 'not a line');
    refused(['gate-b-forged', 'gate-broken-input'], /pack C \(gate-c\): stage B reads every line of [\s\S]*\n {2}detector_in\.jsonl line \d+: not valid JSON/);
    const calib = copySession('gate-c', 'gate-calib-edited');
    appendTo(calib, 'calib.json', '');
    refused(['gate-b-forged', 'gate-calib-edited'], /pack C \(gate-c\): a file of an earlier step does not match ledger\.jsonl[\s\S]*calib\.json changed after step \w+ wrote it/);
    const onsets = copySession('gate-c', 'gate-onsets-edited');
    appendTo(onsets, 'onsets.json', '');
    refused(['gate-b-forged', 'gate-onsets-edited'], /pack C \(gate-c\): a file of an earlier step does not match ledger\.jsonl[\s\S]*onsets\.json changed after step label wrote it/);
    const labels = copySession('gate-c', 'gate-labels-forged');
    editJson(labels, 'onsets.json', (o) => {
      o['labels_sha256'] = 'a'.repeat(64);
    });
    refused(['gate-b-forged', 'gate-labels-forged'], /pack C \(gate-c\): onsets\.json: its blind labels and hand marks give labels_sha256 [0-9a-f]{8}, not the aaaaaaaa it holds/);
    const sign = copySession('gate-c', 'gate-no-sign');
    editJson(sign, 'calib.json', (c) => {
      c['polarity'].sign = null;
    });
    refused(['gate-b-forged', 'gate-no-sign'], /pack C \(gate-c\): calib\.json has no trace sign \(polarity\.sign\)/);
    // The same checks on the pack A recording of --dev come before any computing too.
    const dev = copySession('gate-a', 'gate-a-no-samples');
    fs.rmSync(path.join(dev, 'samples.jsonl'));
    refused(['gate-b-forged', 'gate-c', '--dev', 'gate-a-no-samples'], /pack A \(gate-a\): stage B reads every line of [\s\S]*samples\.jsonl is missing/);
  });

  it('refuses when stage B run again does not give the verdict.json stage B wrote', () => {
    forgedB();
    refused(['gate-b-forged', 'gate-c'], /pack B \(gate-b\): stage B's computation run again on the same files and params does not give the verdict\.json stage B wrote[\s\S]*misses\.no_inbreath/);
  }, 60_000);

  it('refuses packs scored with different parameters', () => {
    const dir = copySession('gate-c', 'gate-other-params');
    const other = sha256Hex(tunedText(2.5, 0.02));
    const own = sha256Hex(w.retuneText);
    editJson(dir, 'verdict.json', (v) => {
      v['params_sha256'] = other;
    });
    reforgeLedger(dir, (r) => (isNoteLine(r) || r.step !== 'stage_a' ? r : { ...r, out_sha256: Object.fromEntries(Object.entries(r.out_sha256).map(([k, s]) => [k, s === own ? other : s])) }));
    refused(['gate-b', 'gate-other-params'], new RegExp(`pack B \\(gate-b\\) was scored with params ${own.slice(0, 8)} and pack C \\(gate-c\\) with params ${other.slice(0, 8)}`));
  });

  it('refuses when params/frozen.json is not the set both stages A recorded', () => {
    const next = tunedText(2.5, 0.03);
    withParams({ frozen: next, retune: next, tagged: next }, () => {
      refused(['gate-b', 'gate-c'], new RegExp(`stage A recorded params ${sha256Hex(w.retuneText).slice(0, 8)}, but params/frozen\\.json is ${sha256Hex(next).slice(0, 8)}`));
    });
  });

  it('refuses unless params/frozen.json equals params/retune.json and its copy under gate-retune', () => {
    withParams({ retune: null }, () => refused(['gate-b', 'gate-c'], /retune\.json does not exist: the confirmation needs the parameters tuned on pack A/));
    withParams({ frozen: null }, () => refused(['gate-b', 'gate-c'], /frozen\.json does not exist/));
    withParams({ tagged: null }, () => refused(['gate-b', 'gate-c'], /params\/retune\.json is not under the git tag gate-retune/));
    withParams({ tagged: tunedText(2.5, 0.02) }, () => refused(['gate-b', 'gate-c'], /params\/retune\.json differs from its copy under the tag gate-retune/));
    withParams({ frozen: tunedText(2.5, 0.02) }, () => refused(['gate-b', 'gate-c'], /params\/frozen\.json differs from params\/retune\.json/));
    withParams({ frozen: '{', retune: '{', tagged: '{' }, () => refused(['gate-b', 'gate-c'], /params: params\/frozen\.json is not valid JSON/));
  });

  it('refuses a parameter set that is not tuned, or tuned without the criterion of stage A', () => {
    withParams({ frozen: PREREG, retune: PREREG, tagged: PREREG }, () => refused(['gate-b', 'gate-c'], /not a tuned parameter set/));
    const v = parseParamsText(w.retuneText, 'params/retune.json').value!;
    delete v['tuned'];
    const text = frozenParamsText(v);
    withParams({ frozen: text, retune: text, tagged: text }, () => refused(['gate-b', 'gate-c'], /params: params\/frozen\.json has no tuned\.k\.criterion_met/));
  });
});
