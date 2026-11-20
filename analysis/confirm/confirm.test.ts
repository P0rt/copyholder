// npm run confirm end to end on synthetic gate recordings (PREREG.md section 11): pack A tuned by
// stage A, another set chosen by the retune and frozen under gate-retune, packs B and C scored with
// it by stage A and stage B, then the pooled confirmation and its outputs; a pack that failed
// quickcheck on condition 6 alone, which confirm scores and keeps, flagged; a pack lost after 4:15,
// or ended by kCreditExhausted at any time; pack B alone when pack C has no recording; a pack C
// recording host never saved, and one it closed without ledger.jsonl ("Saving failed"); the
// recording section 11 keeps when a pack has more than one, renamed folders (some whose names are
// not session ids) and folders confirm cannot read yet among them; a folder given from outside the
// sessions folder; a manifest.json or a sessions folder confirm cannot read; files it cannot read,
// refused with their names; a recording stopped with Ctrl+C; folders no SDK measured (dry, the mock
// tap); the checks of the tag gate-retune; and each refusal, made before anything is computed.
// confirm reads every recording of pack B and C in the sessions folder, so each scenario that adds
// recordings of pack B or C has a sessions folder of its own (ownSessions).

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { appendLedger, isNoteLine, NOTE_STEP, THETA_G_GRID, type LedgerLine, type Verdict } from '../../core/schemas/index.ts';
import { loadList, scanText } from '../../tools/lint-words.ts';
import { main, parseConfirmArgs, USAGE } from '../confirm.ts';
import { main as gateMain } from '../gate.ts';
import { round1 } from '../gate/common.ts';
import { frozenParamsText, frozenWithTuning, parseParamsText } from '../gate/frozen.ts';
import { buildGateSynth, preregParamsText, writeGateSession, type ReplyPlan } from '../gate/synth.ts';
import { sha256Hex } from '../lib/ledger.ts';
import { REPO_ROOT, isSessionId, sessionDirOf } from '../lib/paths.ts';
import { gateSteps } from '../lib/steps.ts';
import { folderArg, givenName, unreadableFile } from './common.ts';
import type { ConfirmDeps } from './deps.ts';
import { SENSITIVITY_LABELS } from './facts.ts';
import { compareRecordings, standingOf } from './load.ts';
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

/**
 * manifest.json of a day-one recording of `pack`, with the SDK version host writes and the state
 * it writes when it saves the recording (live/host.cjs saveRecording).
 */
function setPack(dir: string, pack: string): void {
  editManifest(dir, (m) => {
    m['pack'] = pack;
    m['scenario'] = `gate-${pack}`;
    m['state'] = 'closed';
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

/**
 * A sessions folder of one scenario, with copies of the recordings named under their own names:
 * confirm reads every recording of pack B and C in the sessions folder (section 11), so the extra
 * recordings of one scenario must not reach the others.
 */
function ownSessions(name: string, ...ids: string[]): string {
  const root = path.join(w.base, `sessions-${name}`);
  fs.mkdirSync(root);
  for (const id of ids) copySession(id, id, root);
  return root;
}

/** The environment of a run on the sessions folder `root`. */
const at = (root: string): NodeJS.ProcessEnv => ({ COPYHOLDER_SESSIONS_DIR: root });

/**
 * A copy of a recording as host names a later recording of the same pack (live/lib/session-ids.cjs):
 * folder and manifest.json id `id`, started at `startedUtc`, and stage B's outputs, when it has
 * them, for that id.
 */
function laterCopy(from: string, id: string, root: string, startedUtc: string): string {
  const dir = copySession(from, id, root);
  editManifest(dir, (m) => {
    m['id'] = id;
    m['started_utc'] = startedUtc;
  });
  if (fs.existsSync(path.join(dir, 'verdict.json'))) {
    editJson(dir, 'verdict.json', (v) => {
      v['id'] = id;
    });
    const md = fs.readFileSync(path.join(dir, 'verdict.md'), 'utf8');
    replaceRecorded(dir, 'verdict.md', md.replace(/^GATE VERDICT \S+ /, `GATE VERDICT ${id} `));
  }
  return dir;
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

/** The events.jsonl line host writes when the SDK ends a recording because its credits ran out (live/host.cjs onSdkError). */
const CREDITS_LINE = JSON.stringify({ n: null, e: 'sdk_error', by: 'host', code: 4, name: 'kCreditExhausted', message: 'no credits left' });

/**
 * As host leaves a recording the SDK ended because its credits ran out: the sdk_error line of
 * events.jsonl (live/host.cjs onSdkError) and quickcheck failing on condition 5, which is technical.
 */
function endByCredits(dir: string): void {
  appendTo(dir, 'events.jsonl', CREDITS_LINE);
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

/**
 * As host leaves a recording it never saved (live/host.cjs writeManifest): manifest.json as host
 * writes it while it records, with the state it wrote at consent ('recording') or on an uncaught
 * exception ('crashed'), no file hashes (files {}), no end and no end time, the files it recorded,
 * and no ledger.jsonl, so no file of a later step either.
 */
function neverSaved(dir: string, state: 'recording' | 'crashed'): void {
  for (const name of ['ledger.jsonl', 'quickcheck.json', 'clock_report.json', 'onsets.json', 'verdict.json', 'verdict.md']) fs.rmSync(path.join(dir, name), { force: true });
  editManifest(dir, (m) => {
    m['state'] = state;
    m['files'] = {};
    m['ended_utc'] = null;
    m['end'] = null;
  });
}

/**
 * As host leaves a recording stopped with one Ctrl+C (live/host.cjs): saved, with the record step
 * alone in ledger.jsonl, since host runs quickcheck only after a recording that was not stopped so,
 * and no file a later step wrote.
 */
function recordStepOnly(dir: string): void {
  const records = ledgerRecords(dir);
  const recorded = new Set(records.flatMap((r) => (!isNoteLine(r) && r.step === 'record' ? Object.keys(r.out_sha256) : [])));
  const later = records.flatMap((r) => (isNoteLine(r) || r.step === 'record' ? [] : Object.keys(r.out_sha256)));
  reforgeLedger(dir, (r) => (!isNoteLine(r) && r.step === 'record' ? r : null));
  for (const name of later) if (!recorded.has(name)) fs.rmSync(path.join(dir, name), { force: true });
  expect(fs.existsSync(path.join(dir, 'quickcheck.json'))).toBe(false);
}

/** manifest.json as host writes it for a run with the mock tap (`--tap mock`): tap "mock", no SDK (live/host.cjs record). */
function mockTap(dir: string): void {
  editManifest(dir, (m) => {
    m['tap'] = 'mock';
    m['dry'] = false;
    m['sdk'] = null;
  });
}

/** Puts a folder where the file `name` of a session folder was: reading it fails with EISDIR, a file system error. */
function unreadable(dir: string, name: string): void {
  fs.rmSync(path.join(dir, name), { force: true });
  fs.mkdirSync(path.join(dir, name));
}

/** The message of the file system error that reading a folder as a file gives. */
const EISDIR_READ = 'EISDIR: illegal operation on a directory, read';

/** What the refusal of a file confirm cannot read says to do (common.ts MAKE_READABLE). */
const MAKE_READABLE_TEXT = 'make it readable to this user (where a folder stands in place of the file, put the file back), then run npm run confirm again';

/** A time `hours` after the synthetic recordings started (before them for a negative number), as host writes started_utc. */
const afterStart = (hours: number): string => new Date(Date.parse(w.start) + hours * 3_600_000).toISOString().replace('.000Z', 'Z');

/** Pack B with a verdict.json stage B did not write, its hash put in the ledger, in the sessions folder `root`: only computing pack B shows it. */
function forgedB(root: string): string {
  const dir = copySession('gate-b', 'gate-b-forged', root);
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
        return fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null;
      },
      tagBytes: (tag, file) => {
        if (tag !== 'gate-retune') return null;
        // The pooled analysis code, by repository path: frozen as it is, unless a test changes it.
        if (file in tags.code) {
          const text = tags.code[file];
          return text === null || text === undefined ? null : Buffer.from(text);
        }
        const own = path.join(REPO_ROOT, ...file.split('/'));
        return fs.existsSync(own) ? fs.readFileSync(own) : null;
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
    expect(t.code_files).toEqual(confirmCodeFiles());
    expect(md).toContain('- Stage A and stage B: the ledgers of pack B and pack C hold this hash in their stage A lines, and stage B scored with it.');
    expect(md).toContain(`- The tag gate-retune: made ${TAG_TIME} (the time git gives the tag); pack B started ${w.start}, pack C started ${w.start}.`);
    expect(md).toContain(
      `- The pooled analysis code, every module npm run confirm loads (${t.code_files.length} files, listed in confirm.json under retune_tag.code_files), equals its copy under the tag gate-retune.`,
    );
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
  let root: string;

  beforeAll(() => {
    // Pack C as quickcheck leaves it with too few replies: stage A and stage B never ran.
    root = ownSessions('content', 'gate-b');
    const dir = copySession('gate-c', 'gate-c-content', root);
    withoutStages(dir);
    failRepliesOnly(dir, 11);
    r = confirmed(['gate-b', 'gate-c-content'], at(root));
  }, 60_000);

  it('is a recording stage A refuses, so it never has a stage B of its own', async () => {
    w.err.length = 0;
    expect(await gateMain(['--stage', 'A', 'gate-c-content'], { ...w.deps, env: { ...w.deps.env, ...at(root) } })).toBe(1);
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
    const root = ownSessions('c-lost', 'gate-b');
    const dir = copySession('gate-c', 'gate-c-lost', root);
    withoutStages(dir);
    failTechnical(dir);
    const r = confirmed(['gate-b', 'gate-c-lost'], at(root));
    const why = 'quickcheck.json says RE-RECORD NOW: microphone processing not off';
    // The folder of the lost recording has another name than its id, so the report names both.
    expect(r.json['lost']).toEqual([
      {
        pack: 'C',
        id: 'gate-c',
        folder: 'gate-c-lost',
        cause: 'technical',
        objections_begun: true,
        reasons: [why],
        note: `pack C (gate-c in the folder gate-c-lost) is lost: it failed for a technical reason after its objection block began (4:15), so it is not in the numbers and not replaced (PREREG.md section 11). Reason: ${why}`,
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
    const root = ownSessions('c-early', 'gate-b');
    const dir = copySession('gate-c', 'gate-c-early', root);
    failTechnical(dir);
    dropStepMark(dir, gateSteps('C').objections);
    refused(
      ['gate-b', 'gate-c-early'],
      /pack C \(gate-c\) failed for a technical reason before its objection block began \(4:15\), so it is not the recording of pack C: by PREREG\.md section 11 pack C is recorded again, and that recording is the one to give:\n {2}quickcheck\.json says RE-RECORD NOW: microphone processing not off$/,
      at(root),
    );
  });

  it('reports a pack the SDK ended with kCreditExhausted before 4:15 as lost, not recorded again, and gives pack B alone, flagged', () => {
    const root = ownSessions('c-credits-early', 'gate-b');
    const dir = copySession('gate-c', 'gate-c-credits-early', root);
    withoutStages(dir);
    endByCredits(dir);
    dropStepMark(dir, gateSteps('C').objections);
    const r = confirmed(['gate-c-credits-early', 'gate-b'], at(root));
    const why = 'quickcheck.json says RE-RECORD NOW: the SDK reported 1 error(s) (code 4 kCreditExhausted)';
    const note = `pack C (gate-c in the folder gate-c-credits-early) is lost: the SDK ended it with kCreditExhausted (the SDK credits were used up) before its objection block began (4:15), so it is not in the numbers and not replaced (PREREG.md section 11). Reason: ${why}`;
    expect(r.json['lost']).toEqual([{ pack: 'C', id: 'gate-c', folder: 'gate-c-credits-early', cause: 'credits', objections_begun: false, reasons: [why], note }]);
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
    const root = ownSessions('c-credits-late', 'gate-b');
    const dir = copySession('gate-c', 'gate-c-credits-late', root);
    withoutStages(dir);
    endByCredits(dir);
    const r = confirmed(['gate-b', 'gate-c-credits-late'], at(root));
    expect(r.json['lost']).toMatchObject([{ pack: 'C', id: 'gate-c', folder: 'gate-c-credits-late', cause: 'credits', objections_begun: true }]);
    expect(r.json['lost'][0].note).toMatch(
      /^pack C \(gate-c in the folder gate-c-credits-late\) is lost: the SDK ended it with kCreditExhausted \(the SDK credits were used up\) after its objection block began \(4:15\), so it is not in the numbers and not replaced \(PREREG\.md section 11\)\. Reason: /,
    );
    expect(r.json['pooled'].packs).toEqual([{ pack: 'B', id: 'gate-b' }]);
  }, 60_000);

  it('reads the kCreditExhausted line only from events.jsonl as the record step wrote it', () => {
    const root = ownSessions('c-credits-added', 'gate-b');
    const dir = copySession('gate-c', 'gate-c-credits-added', root);
    withoutStages(dir);
    failTechnical(dir);
    dropStepMark(dir, gateSteps('C').objections);
    // The record step holds the hash of events.jsonl, as host writes it (live/host.cjs saveRecording).
    const events = fs.readFileSync(path.join(dir, 'events.jsonl'), 'utf8');
    reforgeLedger(dir, (r) => (!isNoteLine(r) && r.step === 'record' ? { ...r, out_sha256: { ...r.out_sha256, 'events.jsonl': sha256Hex(events) } } : r));
    refused(['gate-b', 'gate-c-credits-added'], /pack C \(gate-c\) failed for a technical reason before its objection block began \(4:15\)/, at(root));
    // A kCreditExhausted line added after the recording does not make it lost.
    appendTo(dir, 'events.jsonl', JSON.stringify({ n: null, e: 'sdk_error', by: 'host', code: 4, name: 'kCreditExhausted', message: 'added later' }));
    refused(
      ['gate-b', 'gate-c-credits-added'],
      /pack C \(gate-c\): a file of an earlier step does not match ledger\.jsonl, so nothing is scored \(spec 8\.5\):\n {2}events\.jsonl changed after step record wrote it/,
      at(root),
    );
  });

  it('does not take the one restart of the SDK, or another SDK error, for the end of the credits', () => {
    const root = ownSessions('c-other-error', 'gate-b');
    const dir = copySession('gate-c', 'gate-c-other-error', root);
    withoutStages(dir);
    failTechnical(dir);
    dropStepMark(dir, gateSteps('C').objections);
    appendTo(dir, 'events.jsonl', JSON.stringify({ n: null, e: 'sdk_error', by: 'host', code: 8, name: 'kCameraFailure', message: 'restart', action: 'reset_restart' }));
    appendTo(dir, 'events.jsonl', JSON.stringify({ n: null, e: 'sdk_error', by: 'host', code: 1, name: 'kInvalidState', message: 'state' }));
    refused(['gate-b', 'gate-c-other-error'], /pack C \(gate-c\) failed for a technical reason before its objection block began \(4:15\), so it is not the recording of pack C/, at(root));
  });

  it('refuses when both recordings are lost: there are no confirmatory numbers', () => {
    const root = ownSessions('both-lost');
    failTechnical(copySession('gate-b', 'gate-b-lost', root));
    failTechnical(copySession('gate-c', 'gate-c-lost-too', root));
    refused(
      ['gate-c-lost-too', 'gate-b-lost'],
      /both recordings are lost, so there are no confirmatory numbers \(PREREG\.md section 11\):\n {2}pack B \(gate-b in the folder gate-b-lost\): it failed for a technical reason after its objection block began \(4:15\)\. Reason: quickcheck\.json says RE-RECORD NOW: microphone processing not off\n {2}pack C \(gate-c in the folder gate-c-lost-too\): it failed for a technical reason after its objection block began \(4:15\)\. Reason: quickcheck\.json says RE-RECORD NOW/,
      at(root),
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
    expect(r.json['lost']).toEqual([{ pack: 'C', id: null, folder: null, cause: 'not recorded', objections_begun: false, reasons: [tried], note }]);
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
    refused(['gate-b'], /pack C has a recording, gate-c in .*gate-c, so pack B is not given alone: give gate-c as the second id; it is in the numbers \(PREREG\.md section 11\)$/);
    const lostC = copySession('gate-c', 'gate-c-lost', alone);
    try {
      withoutStages(lostC);
      failTechnical(lostC);
      refused(
        ['gate-b'],
        /pack C has a recording, gate-c in .*gate-c-lost, so pack B is not given alone: give gate-c-lost \(the folder of gate-c\) as the second id; it is lost \(it failed for a technical reason after its objection block began \(4:15\)\) and is reported as lost \(PREREG\.md section 11\)$/,
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
      refused(['gate-b'], /pack C has a recording, gate-c in .*gate-c-unread, so pack B is not given alone: give gate-c-unread \(the folder of gate-c\) as the second id; confirm cannot read it yet: pack C \(gate-c\): stage A has not run/, {
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
      /pack B is lost and pack C has no recording, so there are no confirmatory numbers \(PREREG\.md section 11\):\n {2}pack B \(gate-b in the folder gate-b-lost\): it failed for a technical reason after its objection block began \(4:15\)\. Reason: quickcheck\.json says RE-RECORD NOW: microphone processing not off$/,
      { COPYHOLDER_SESSIONS_DIR: root },
    );
  });
});

/** `s` as a regular expression that matches it literally. */
const esc = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * The refusal of a folder whose manifest.json says closed but that has no ledger.jsonl, after
 * "pack C (gate-c): ": host closes manifest.json just before it appends the record step, so a failed
 * append leaves the folder so too (live/host.cjs saveRecording).
 */
const CLOSED_NO_LEDGER =
  'host did not finish saving this folder, or its ledger.jsonl was removed later. Its manifest.json says closed, but ledger.jsonl does not exist: host closes manifest.json and then appends the record step to ledger.jsonl (live/host.cjs saveRecording), and when that append fails it prints "Saving failed" as the recording ends. No step can run without the record step, and the folder cannot tell the two cases apart, so confirm does not judge this recording. If ledger.jsonl was moved or deleted, put it back and run npm run confirm again. If host printed "Saving failed", no command can add the record step now';

/**
 * The refusal above for a recording of pack `pack`, given or found in the sessions folder: npm run
 * confirm refuses every form that would leave it out, so with "Saving failed" the numbers are
 * reported by hand, unless an earlier recording is the pack's (PREREG.md section 11).
 */
const closedNoLedger = (pack: 'B' | 'C'): string =>
  `${CLOSED_NO_LEDGER}: npm run confirm refuses this recording, and also ${pack === 'C' ? 'pack B alone and every later recording of pack C' : 'every later recording of pack B'}, so unless an earlier recording of pack ${pack} is the one section 11 keeps, it cannot give the confirmatory numbers of this participant. They are then reported by hand, with this recording as a technical failure: recorded again if it stopped before 4:15 for a reason other than the end of the SDK credits, and lost otherwise (PREREG.md section 11)`;

describe('a pack C recording host never saved: no ledger.jsonl, manifest.json not closed (section 11)', () => {
  const cases = (['recording', 'crashed'] as const).flatMap((state) => [false, true].flatMap((begun) => [false, true].map((credits) => ({ state, begun, credits }))));

  /** A sessions folder of its own with gate-b, and gate-c as host leaves a recording it never saved. */
  function unsavedC(c: (typeof cases)[number]): string {
    const root = ownSessions(`unsaved-${c.state}-${c.begun ? 'after' : 'before'}-${c.credits ? 'credits' : 'technical'}`, 'gate-b');
    const dir = copySession('gate-c', 'gate-c', root);
    neverSaved(dir, c.state);
    // Deck marks the start of the objection block (4:15) in stamps.jsonl.
    if (!c.begun) dropStepMark(dir, gateSteps('C').objections);
    if (c.credits) appendTo(dir, 'events.jsonl', CREDITS_LINE);
    return root;
  }

  for (const c of cases) {
    const when = c.begun ? 'after' : 'before';
    const title = `state ${c.state}, ended ${when} 4:15, ${c.credits ? 'with' : 'without'} the kCreditExhausted line`;
    const why = `host did not save the recording (manifest.json state ${c.state}, no ledger.jsonl)`;
    const vbEvents = (): Record<string, number> => {
      const vb = readVerdict('gate-b');
      return { cued: vb.events.cued, valid: vb.events.valid, armed: vb.events.armed, audible_inbreath: vb.events.audible_inbreath };
    };

    if (!c.begun && !c.credits) {
      it(`${title}: not the recording of pack C, which is recorded again, so pack B is given alone`, () => {
        const root = unsavedC(c);
        refused(
          ['gate-b', 'gate-c'],
          new RegExp(
            `^confirm refused: pack C \\(gate-c\\) failed for a technical reason before its objection block began \\(4:15\\), so it is not the recording of pack C: by PREREG\\.md section 11 pack C is recorded again, and that recording is the one to give:\\n {2}${esc(why)}$`,
          ),
          at(root),
        );
        const r = confirmed(['gate-b'], at(root));
        const tried = 'the recording gate-c failed for a technical reason before 4:15, so section 11 records the pack again';
        const note = `pack C has no recording: npm run confirm was given pack B alone, and the sessions folder holds no recording of pack C that reached its objection block (4:15): ${tried}. PREREG.md section 11 allows this when pack C cannot be started for lack of SDK credits`;
        expect(r.json['lost']).toEqual([{ pack: 'C', id: null, folder: null, cause: 'not recorded', objections_begun: false, reasons: [tried], note }]);
        const flag = `the confirmatory numbers are those of pack B alone, ${readVerdict('gate-b').events.valid} valid objections (at most 14), with the same tests, because pack C has no recording (PREREG.md section 11)`;
        expect(r.json['flags']).toEqual([flag]);
        expect(r.json['pooled'].packs).toEqual([{ pack: 'B', id: 'gate-b' }]);
        expect(r.json['pooled'].events).toEqual(vbEvents());
        expect(r.json['recorded_later']).toEqual([]);
        expect(r.md.startsWith('# Confirmation: pack B, pack C not recorded\n')).toBe(true);
        expect(r.md).toContain(`- Not recorded: ${note}.`);
        expect(r.summary).toContain(`not recorded: ${note}`);
        expectPlainText(r.md, r.json);
      }, 60_000);
      continue;
    }

    it(`${title}: lost, reported with its reason, so pack B alone is refused`, () => {
      const root = unsavedC(c);
      const phrase = c.credits
        ? `the SDK ended it with kCreditExhausted (the SDK credits were used up) ${when} its objection block began (4:15)`
        : 'it failed for a technical reason after its objection block began (4:15)';
      const note = `pack C (gate-c) is lost: ${phrase}, so it is not in the numbers and not replaced (PREREG.md section 11). Reason: ${why}`;
      const r = confirmed(['gate-b', 'gate-c'], at(root));
      expect(r.json['lost']).toEqual([{ pack: 'C', id: 'gate-c', folder: 'gate-c', cause: c.credits ? 'credits' : 'technical', objections_begun: c.begun, reasons: [why], note }]);
      const alone = `the confirmatory numbers are those of pack B alone, ${readVerdict('gate-b').events.valid} valid objections (at most 14), with the same tests, because pack C is lost (PREREG.md section 11)`;
      expect(r.json['flags']).toEqual([alone]);
      expect(r.json['packs'].map((p: { pack: string }) => p.pack)).toEqual(['B']);
      expect(r.json['pooled'].packs).toEqual([{ pack: 'B', id: 'gate-b' }]);
      expect(r.json['pooled'].events).toEqual(vbEvents());
      // The tag must come before every recording of packs B and C, this one too.
      expect(r.json['retune_tag'].recordings).toEqual([
        { pack: 'B', id: 'gate-b', started_utc: w.start },
        { pack: 'C', id: 'gate-c', started_utc: w.start },
      ]);
      expect(r.json['confirmatory']).toBe(true);
      expect(r.md.startsWith('# Confirmation: pack B, pack C lost\n')).toBe(true);
      expect(r.md).toContain(`- Lost: ${note}.`);
      expect(r.md).toContain(`- Flag: ${alone}.`);
      expect(r.summary).toContain(`lost: ${note}`);
      expect(r.summary).toContain(`flag: ${alone}`);
      expectPlainText(r.md, r.json);
      refused(
        ['gate-b'],
        new RegExp(
          `^confirm refused: pack C has a recording, gate-c in .*gate-c, so pack B is not given alone: give gate-c as the second id; it is lost \\(${esc(phrase)}\\) and is reported as lost \\(PREREG\\.md section 11\\)$`,
        ),
        at(root),
      );
    }, 60_000);
  }

  it('still refuses a manifest.json host closed without ledger.jsonl, in both forms: host did not finish saving it, or the ledger was removed', () => {
    const root = ownSessions('closed-no-ledger', 'gate-b');
    const dir = copySession('gate-c', 'gate-c', root);
    // As host leaves a recording whose record step it could not append, or one whose ledger went missing later.
    fs.rmSync(path.join(dir, 'ledger.jsonl'));
    const missing = `pack C \\(gate-c\\): ${esc(closedNoLedger('C'))}`;
    refused(['gate-b', 'gate-c'], new RegExp(`^confirm refused: ${missing}$`), at(root));
    refused(
      ['gate-b'],
      new RegExp(`^confirm refused: pack C has a recording, gate-c in .*gate-c, so pack B is not given alone, and confirm cannot judge that recording: ${missing}$`),
      at(root),
    );
    // Without a state, which host always writes, the folder is judged as host left it.
    editManifest(dir, (m) => {
      delete m['state'];
    });
    dropStepMark(dir, gateSteps('C').objections);
    refused(
      ['gate-b', 'gate-c'],
      /^confirm refused: pack C \(gate-c\) failed for a technical reason before its objection block began \(4:15\)[^\n]*:\n {2}host did not save the recording \(manifest\.json state not set, no ledger\.jsonl\)$/,
      at(root),
    );
  });

  it('refuses every form while a pack C recording with "Saving failed" stands before 4:15, and says that the numbers are then reported by hand', () => {
    // host printed "Saving failed" as gate-c ended before its objection block, and pack C was recorded again as gate-c-2.
    const root = ownSessions('closed-no-ledger-then-c-2', 'gate-b');
    const first = copySession('gate-c', 'gate-c', root);
    fs.rmSync(path.join(first, 'ledger.jsonl'));
    dropStepMark(first, gateSteps('C').objections);
    laterCopy('gate-c', 'gate-c-2', root, afterStart(1));
    const missing = `pack C \\(gate-c\\): ${esc(closedNoLedger('C'))}`;
    // The recording itself, the one recorded after it, and pack B alone: each refused with what to do.
    const given = refused(['gate-b', 'gate-c'], new RegExp(`^confirm refused: ${missing}$`), at(root));
    refused(['gate-b', 'gate-c-2'], new RegExp(`^confirm refused: pack C has a recording made before gate-c-2: gate-c in .*gate-c, which confirm cannot judge: ${missing}$`), at(root));
    refused(['gate-c-2', 'gate-b'], new RegExp(`^confirm refused: pack C has a recording made before gate-c-2: gate-c in .*gate-c, which confirm cannot judge: ${missing}$`), at(root));
    refused(['gate-b'], new RegExp(`^confirm refused: pack C has a recording, gate-c in .*gate-c, so pack B is not given alone, and confirm cannot judge that recording: ${missing}$`), at(root));
    // No form is left that the refusal could send the operator to, so it says that the numbers are reported by hand.
    expect(given).toContain('it cannot give the confirmatory numbers of this participant. They are then reported by hand');
  });

  it('lists a recording host closed without ledger.jsonl after the recording of its pack as recorded later, and refuses it given', () => {
    const root = ownSessions('c-then-closed-no-ledger', 'gate-b', 'gate-c');
    fs.rmSync(path.join(laterCopy('gate-c', 'gate-c-2', root, afterStart(1)), 'ledger.jsonl'));
    const r = confirmed(['gate-b', 'gate-c'], at(root));
    expect(r.json['pooled']).toEqual(pooledBC ?? runConfirm({ ids: ['gate-b', 'gate-c'], dev: null, deps: freshDeps().deps }).json['pooled']);
    const note = 'pack C (gate-c-2) was recorded after gate-c and is not in the numbers: gate-c is the recording of pack C in the numbers (PREREG.md section 11)';
    expect(r.json['recorded_later']).toEqual([{ pack: 'C', id: 'gate-c-2', folder: 'gate-c-2', after: 'gate-c', after_folder: 'gate-c', note }]);
    expect(r.md).toContain(`- Recorded later: ${note}.`);
    refused(['gate-b', 'gate-c-2'], new RegExp(`^confirm refused: pack C \\(gate-c-2\\): ${esc(closedNoLedger('C'))}$`), at(root));
  }, 60_000);

  it('says the same of a pack B recording, whose later recordings it refuses too, and of the pack A recording of --dev', () => {
    const root = ownSessions('b-closed-no-ledger', 'gate-c');
    fs.rmSync(path.join(copySession('gate-b', 'gate-b', root), 'ledger.jsonl'));
    laterCopy('gate-b', 'gate-b-2', root, afterStart(1));
    const missing = `pack B \\(gate-b\\): ${esc(closedNoLedger('B'))}`;
    refused(['gate-b', 'gate-c'], new RegExp(`^confirm refused: ${missing}$`), at(root));
    refused(['gate-b-2', 'gate-c'], new RegExp(`^confirm refused: pack B has a recording made before gate-b-2: gate-b in .*gate-b, which confirm cannot judge: ${missing}$`), at(root));
    fs.rmSync(path.join(copySession('gate-a', 'gate-a-no-ledger'), 'ledger.jsonl'));
    refused(
      ['gate-b', 'gate-c', '--dev', 'gate-a-no-ledger'],
      new RegExp(
        `^confirm refused: pack A \\(gate-a\\): ${esc(CLOSED_NO_LEDGER)}, and the recording has no numbers: --dev takes the pack A recording with GOOD RECORDING, a valid clock check and its stage B \\(PREREG\\.md sections 4, 7\\.4, 11\\)$`,
      ),
    );
  });

  it('refuses --dev with a pack A recording host never saved', () => {
    neverSaved(copySession('gate-a', 'gate-a-unsaved'), 'crashed');
    refused(
      ['gate-b', 'gate-c', '--dev', 'gate-a-unsaved'],
      /^confirm refused: pack A \(gate-a\) does not count, so it has no numbers: --dev takes the pack A recording with GOOD RECORDING, a valid clock check and its stage B \(PREREG\.md sections 4, 7\.4, 11\):\n {2}host did not save the recording \(manifest\.json state crashed, no ledger\.jsonl\)$/,
    );
  });
});

describe('the recording section 11 keeps when a pack has more than one', () => {
  /** A time `hours` after the synthetic recordings started, as host writes started_utc. */
  const objections = gateSteps('C').objections;

  it('orders the recordings of a pack by manifest.json started_utc, then by session id and its numeric suffix', () => {
    const rec = (id: string, startedUtc: string | null, folder = id): { dir: string; id: string; startedUtc: string | null } => ({
      dir: path.join(w.base, 'sessions-order', folder),
      id,
      startedUtc,
    });
    const order = (...xs: ReturnType<typeof rec>[]): string[] => [...xs].sort(compareRecordings).map((x) => path.basename(x.dir));
    // By the time host wrote at consent, in any time zone, whatever the ids: 19:30 at +02:00 is 17:30 UTC.
    expect(order(rec('gate-c', '2026-11-13T19:00:00Z'), rec('gate-c-2', '2026-11-13T18:00:00Z'))).toEqual(['gate-c-2', 'gate-c']);
    expect(order(rec('gate-c', '2026-11-13T18:00:00Z'), rec('gate-c-2', '2026-11-13T19:30:00+02:00'))).toEqual(['gate-c-2', 'gate-c']);
    // On a tie, or without a time that parses: gate-c, then gate-c-2, then gate-c-10.
    const t = '2026-11-13T18:00:00Z';
    expect(order(rec('gate-c-10', t), rec('gate-c-2', t), rec('gate-c', t))).toEqual(['gate-c', 'gate-c-2', 'gate-c-10']);
    expect(order(rec('gate-c-10', null), rec('gate-c-2', 'not a time'), rec('gate-c', t))).toEqual(['gate-c', 'gate-c-2', 'gate-c-10']);
    // The same start and id: copies of one recording, whatever their folder names.
    expect(compareRecordings(rec('gate-c', t, 'gate-c-lost'), rec('gate-c', t, 'gate-c-early'))).toBe(0);
    expect(compareRecordings(rec('gate-c', null), rec('gate-c', t))).toBe(0);
  });

  const losses = [
    {
      how: 'the SDK ended it with kCreditExhausted before 4:15',
      folder: 'c-credits-then-c-2',
      lose: (dir: string): void => {
        endByCredits(dir);
        dropStepMark(dir, objections);
      },
      phrase: 'the SDK ended it with kCreditExhausted (the SDK credits were used up) before its objection block began (4:15)',
    },
    {
      how: 'it failed for a technical reason after 4:15',
      folder: 'c-lost-then-c-2',
      lose: failTechnical,
      phrase: 'it failed for a technical reason after its objection block began (4:15)',
    },
  ];

  for (const l of losses) {
    it(`keeps a lost pack C recording (${l.how}): a later one is refused, and reported as not in the numbers`, () => {
      // gate-c lost, gate-c-2 recorded after it and counts, gate-c-3 an attempt that failed before 4:15.
      const root = ownSessions(l.folder, 'gate-b');
      const first = copySession('gate-c', 'gate-c', root);
      withoutStages(first);
      l.lose(first);
      laterCopy('gate-c', 'gate-c-2', root, afterStart(1));
      const attempt = laterCopy('gate-c', 'gate-c-3', root, afterStart(2));
      withoutStages(attempt);
      failTechnical(attempt);
      dropStepMark(attempt, objections);
      const why = new RegExp(
        `^confirm refused: pack C has a recording made before gate-c-2: gate-c in .*gate-c, which is lost \\(${esc(l.phrase)}\\)\\. Section 11 does not replace a lost recording, so gate-c is the recording of pack C, reported as lost: give gate-c in place of gate-c-2 \\(PREREG\\.md section 11\\)$`,
      );
      refused(['gate-b', 'gate-c-2'], why, at(root));
      refused(['gate-c-2', 'gate-b'], why, at(root));
      refused(
        ['gate-b'],
        new RegExp(
          `^confirm refused: pack C has a recording, gate-c in .*gate-c, so pack B is not given alone: give gate-c as the second id; it is lost \\(${esc(l.phrase)}\\) and is reported as lost \\(PREREG\\.md section 11\\)$`,
        ),
        at(root),
      );
      const r = confirmed(['gate-b', 'gate-c'], at(root));
      expect(r.json['lost']).toMatchObject([{ pack: 'C', id: 'gate-c' }]);
      expect(r.json['pooled'].packs).toEqual([{ pack: 'B', id: 'gate-b' }]);
      const note = 'pack C (gate-c-2) was recorded after gate-c and is not in the numbers: gate-c is lost, and PREREG.md section 11 does not replace a lost recording';
      // gate-c-3 is an attempt that section 11 records again, not a recording of the pack: not listed.
      expect(r.json['recorded_later']).toEqual([{ pack: 'C', id: 'gate-c-2', folder: 'gate-c-2', after: 'gate-c', after_folder: 'gate-c', note }]);
      expect(r.md).toContain(`- Recorded later: ${note}.`);
      expect(r.summary).toContain(`recorded later: ${note}`);
      expectPlainText(r.md, r.json);
    }, 60_000);
  }

  it('keeps a lost pack B recording: a later one is refused alone or with pack C, and reported as not in the numbers', () => {
    const root = ownSessions('b-lost-then-b-2');
    const first = copySession('gate-b', 'gate-b', root);
    withoutStages(first);
    failTechnical(first);
    laterCopy('gate-b', 'gate-b-2', root, afterStart(1));
    const why =
      /^confirm refused: pack B has a recording made before gate-b-2: gate-b in .*gate-b, which is lost \(it failed for a technical reason after its objection block began \(4:15\)\)\. Section 11 does not replace a lost recording, so gate-b is the recording of pack B, reported as lost: give gate-b in place of gate-b-2 \(PREREG\.md section 11\)$/;
    refused(['gate-b-2'], why, at(root));
    // The later recording does not stand in for it: pack B is lost, and pack C has no recording.
    refused(
      ['gate-b'],
      /^confirm refused: pack B is lost and pack C has no recording, so there are no confirmatory numbers \(PREREG\.md section 11\):\n {2}pack B \(gate-b\): it failed for a technical reason after its objection block began \(4:15\)\. Reason: quickcheck\.json says RE-RECORD NOW: microphone processing not off$/,
      at(root),
    );
    copySession('gate-c', 'gate-c', root);
    refused(['gate-b-2', 'gate-c'], why, at(root));
    refused(['gate-c', 'gate-b-2'], why, at(root));
    const r = confirmed(['gate-c', 'gate-b'], at(root));
    expect(r.json['lost']).toMatchObject([{ pack: 'B', id: 'gate-b', cause: 'technical', objections_begun: true }]);
    const alone = `the confirmatory numbers are those of pack C alone, ${readVerdict('gate-c').events.valid} valid objections (at most 14), with the same tests, because pack B is lost (PREREG.md section 11)`;
    expect(r.json['flags']).toEqual([alone]);
    expect(r.json['pooled'].packs).toEqual([{ pack: 'C', id: 'gate-c' }]);
    expect(r.md.startsWith('# Confirmation: pack C, pack B lost\n')).toBe(true);
    const note = 'pack B (gate-b-2) was recorded after gate-b and is not in the numbers: gate-b is lost, and PREREG.md section 11 does not replace a lost recording';
    expect(r.json['recorded_later']).toEqual([{ pack: 'B', id: 'gate-b-2', folder: 'gate-b-2', after: 'gate-b', after_folder: 'gate-b', note }]);
    expect(r.md).toContain(`- Recorded later: ${note}.`);
    expect(r.summary).toContain(`recorded later: ${note}`);
    expectPlainText(r.md, r.json);
  }, 60_000);

  it('keeps the first recording of a pack that is in the numbers: a later one is refused, and reported as not in the numbers', () => {
    const root = ownSessions('b-2-and-c-2', 'gate-b', 'gate-c');
    laterCopy('gate-b', 'gate-b-2', root, afterStart(1));
    laterCopy('gate-c', 'gate-c-2', root, afterStart(1));
    // Copies of a recording under other folder names (the same start and id) are that recording:
    // neither before nor after it, and listed once.
    fs.cpSync(path.join(root, 'gate-c'), path.join(root, 'copy-of-gate-c'), { recursive: true });
    fs.cpSync(path.join(root, 'gate-c-2'), path.join(root, 'gate-c-2-copy'), { recursive: true });
    const firstB =
      /^confirm refused: pack B has a recording made before gate-b-2: gate-b in .*gate-b, which is in the numbers\. Section 11 keeps the first recording of a pack and records a pack again only after a technical failure before 4:15, so gate-b is the recording of pack B: give gate-b in place of gate-b-2 \(PREREG\.md section 11\)$/;
    refused(['gate-b-2'], firstB, at(root));
    refused(['gate-c', 'gate-b-2'], firstB, at(root));
    refused(
      ['gate-b', 'gate-c-2'],
      /^confirm refused: pack C has a recording made before gate-c-2: gate-c in .*gate-c, which is in the numbers\. Section 11 keeps the first recording of a pack and records a pack again only after a technical failure before 4:15, so gate-c is the recording of pack C: give gate-c in place of gate-c-2 \(PREREG\.md section 11\)$/,
      at(root),
    );
    const r = confirmed(['gate-b', 'gate-c'], at(root));
    expect(r.json['pooled']).toEqual(pooledBC ?? runConfirm({ ids: ['gate-b', 'gate-c'], dev: null, deps: freshDeps().deps }).json['pooled']);
    expect(r.json['lost']).toEqual([]);
    expect(r.md.startsWith('# Pooled confirmation: packs B and C\n')).toBe(true);
    const notes = [
      'pack B (gate-b-2) was recorded after gate-b and is not in the numbers: gate-b is the recording of pack B in the numbers (PREREG.md section 11)',
      'pack C (gate-c-2) was recorded after gate-c and is not in the numbers: gate-c is the recording of pack C in the numbers (PREREG.md section 11)',
    ];
    expect(r.json['recorded_later']).toEqual([
      { pack: 'B', id: 'gate-b-2', folder: 'gate-b-2', after: 'gate-b', after_folder: 'gate-b', note: notes[0] },
      { pack: 'C', id: 'gate-c-2', folder: 'gate-c-2', after: 'gate-c', after_folder: 'gate-c', note: notes[1] },
    ]);
    for (const note of notes) {
      expect(r.md).toContain(`- Recorded later: ${note}.`);
      expect(r.summary).toContain(`recorded later: ${note}`);
    }
    expectPlainText(r.md, r.json);
  }, 60_000);

  it('accepts a recording made after attempts that failed for a technical reason before 4:15, which section 11 records again', () => {
    const root = ownSessions('c-3-after-attempts', 'gate-b');
    // gate-c failed quickcheck for a technical reason, and host never saved gate-c-2: both before 4:15.
    const first = copySession('gate-c', 'gate-c', root);
    withoutStages(first);
    failTechnical(first);
    dropStepMark(first, objections);
    const second = laterCopy('gate-c', 'gate-c-2', root, afterStart(1));
    neverSaved(second, 'crashed');
    dropStepMark(second, objections);
    laterCopy('gate-c', 'gate-c-3', root, afterStart(2));
    const r = confirmed(['gate-c-3', 'gate-b'], at(root));
    expect(r.json['lost']).toEqual([]);
    expect(r.json['recorded_later']).toEqual([]);
    expect(r.json['pooled'].packs).toEqual([
      { pack: 'B', id: 'gate-b' },
      { pack: 'C', id: 'gate-c-3' },
    ]);
    expect(r.json['retune_tag'].recordings).toEqual([
      { pack: 'B', id: 'gate-b', started_utc: w.start },
      { pack: 'C', id: 'gate-c-3', started_utc: afterStart(2) },
    ]);
    expect(r.md).not.toContain('Recorded later');
    expectPlainText(r.md, r.json);
    // Each attempt given in its place is refused as such.
    refused(['gate-b', 'gate-c'], /^confirm refused: pack C \(gate-c\) failed for a technical reason before its objection block began \(4:15\), so it is not the recording of pack C/, at(root));
    refused(
      ['gate-b', 'gate-c-2'],
      /^confirm refused: pack C \(gate-c-2\) failed for a technical reason before its objection block began \(4:15\), so it is not the recording of pack C: by PREREG\.md section 11 pack C is recorded again, and that recording is the one to give:\n {2}host did not save the recording \(manifest\.json state crashed, no ledger\.jsonl\)$/,
      at(root),
    );
  }, 60_000);

  it('refuses a later recording while an earlier one of the pack cannot be read yet', () => {
    const root = ownSessions('c-unread-then-c-2', 'gate-b');
    // gate-c has GOOD RECORDING, but stage A has not run on it.
    withoutStages(copySession('gate-c', 'gate-c', root));
    laterCopy('gate-c', 'gate-c-2', root, afterStart(1));
    refused(
      ['gate-b', 'gate-c-2'],
      /^confirm refused: pack C has a recording made before gate-c-2: gate-c in .*gate-c, which confirm cannot read yet\. Unless it failed for a technical reason before 4:15 other than the end of the SDK credits, it is the recording of pack C, and gate-c is the one to give \(PREREG\.md section 11\): pack C \(gate-c\): stage A has not run/,
      at(root),
    );
  });

  it('keeps a pack C recording host never saved after 4:15: it is lost, so a later one is refused, and reported as not in the numbers', () => {
    const root = ownSessions('c-crashed-then-c-2', 'gate-b');
    // gate-c: host crashed after Deck entered the objection block (its step mark is in stamps.jsonl), and never saved it.
    neverSaved(copySession('gate-c', 'gate-c', root), 'crashed');
    laterCopy('gate-c', 'gate-c-2', root, afterStart(1));
    const why = 'host did not save the recording (manifest.json state crashed, no ledger.jsonl)';
    const phrase = 'it failed for a technical reason after its objection block began (4:15)';
    refused(
      ['gate-b', 'gate-c-2'],
      new RegExp(
        `^confirm refused: pack C has a recording made before gate-c-2: gate-c in .*gate-c, which is lost \\(${esc(phrase)}\\)\\. Section 11 does not replace a lost recording, so gate-c is the recording of pack C, reported as lost: give gate-c in place of gate-c-2 \\(PREREG\\.md section 11\\)$`,
      ),
      at(root),
    );
    const r = confirmed(['gate-b', 'gate-c'], at(root));
    const lostNote = `pack C (gate-c) is lost: ${phrase}, so it is not in the numbers and not replaced (PREREG.md section 11). Reason: ${why}`;
    expect(r.json['lost']).toEqual([{ pack: 'C', id: 'gate-c', folder: 'gate-c', cause: 'technical', objections_begun: true, reasons: [why], note: lostNote }]);
    expect(r.json['pooled'].packs).toEqual([{ pack: 'B', id: 'gate-b' }]);
    const note = 'pack C (gate-c-2) was recorded after gate-c and is not in the numbers: gate-c is lost, and PREREG.md section 11 does not replace a lost recording';
    expect(r.json['recorded_later']).toEqual([{ pack: 'C', id: 'gate-c-2', folder: 'gate-c-2', after: 'gate-c', after_folder: 'gate-c', note }]);
    expect(r.md).toContain(`- Lost: ${lostNote}.`);
    expect(r.md).toContain(`- Recorded later: ${note}.`);
    expect(r.summary).toContain(`recorded later: ${note}`);
    expectPlainText(r.md, r.json);
  }, 60_000);

  it('refuses a later recording while an earlier one stopped with Ctrl+C has no quickcheck yet', () => {
    const root = ownSessions('c-stopped-then-c-2', 'gate-b');
    recordStepOnly(copySession('gate-c', 'gate-c', root));
    laterCopy('gate-c', 'gate-c-2', root, afterStart(1));
    refused(
      ['gate-b', 'gate-c-2'],
      new RegExp(
        `^confirm refused: pack C has a recording made before gate-c-2: gate-c in .*gate-c, which confirm cannot read yet\\. Unless it failed for a technical reason before 4:15 other than the end of the SDK credits, it is the recording of pack C, and gate-c is the one to give \\(PREREG\\.md section 11\\): ${esc(
          'quickcheck has not run on gate-c (host does not run it after Ctrl+C): run npm run quickcheck -- gate-c, then npm run confirm again (PREREG.md section 11)',
        )}$`,
      ),
      at(root),
    );
  });

  it('refuses a later recording while a file of an earlier one cannot be read, names that file and its error, and refuses the earlier one given until the file is put back', () => {
    const root = ownSessions('c-unreadable-then-c-2', 'gate-b');
    const first = copySession('gate-c', 'gate-c', root);
    unreadable(first, 'ledger.jsonl');
    laterCopy('gate-c', 'gate-c-2', root, afterStart(1));
    const ledger = path.join(first, 'ledger.jsonl');
    const cannot = `${esc(ledger)} cannot be read \\(${esc(EISDIR_READ)}\\): ${esc(MAKE_READABLE_TEXT)}`;
    refused(
      ['gate-b', 'gate-c-2'],
      new RegExp(
        `^confirm refused: pack C has a recording made before gate-c-2: gate-c in .*gate-c, which confirm cannot read yet: ${cannot}\\. Unless gate-c failed for a technical reason before 4:15 other than the end of the SDK credits, it is the recording of pack C, and gate-c is the one to give \\(PREREG\\.md section 11\\)$`,
      ),
      at(root),
    );
    // Pack B alone is refused too: the pack C recording is judged once it can be read.
    refused(
      ['gate-b'],
      new RegExp(
        `^confirm refused: pack C has a recording, gate-c in .*gate-c, which confirm cannot read yet: ${cannot}\\. Unless gate-c failed for a technical reason before 4:15 other than the end of the SDK credits, pack B is not given alone, and gate-c is the second id \\(PREREG\\.md section 11\\)$`,
      ),
      at(root),
    );
    // Given as the refusals say, it is refused with the same file and what to do, not thrown as a file system error.
    refused(['gate-b', 'gate-c'], new RegExp(`^confirm refused: gate-c: ${cannot} \\(PREREG\\.md section 11\\)$`), at(root));
    // With the file put back, the earlier one gives the numbers, and the later one is not in them.
    fs.rmSync(ledger, { recursive: true });
    fs.copyFileSync(path.join(w.sessions, 'gate-c', 'ledger.jsonl'), ledger);
    const r = confirmed(['gate-b', 'gate-c'], at(root));
    expect(r.json['pooled']).toEqual(pooledBC ?? runConfirm({ ids: ['gate-b', 'gate-c'], dev: null, deps: freshDeps().deps }).json['pooled']);
    expect(r.json['recorded_later']).toMatchObject([{ pack: 'C', id: 'gate-c-2', after: 'gate-c' }]);
  }, 60_000);

  it('refuses a recording given whose events.jsonl cannot be read, with the file and what to do', () => {
    const root = ownSessions('b-events-unreadable', 'gate-c');
    const b = copySession('gate-b', 'gate-b', root);
    unreadable(b, 'events.jsonl');
    refused(
      ['gate-b', 'gate-c'],
      new RegExp(`^confirm refused: gate-b: ${esc(path.join(b, 'events.jsonl'))} cannot be read \\(${esc(EISDIR_READ)}\\): ${esc(MAKE_READABLE_TEXT)} \\(PREREG\\.md section 11\\)$`),
      at(root),
    );
  });

  it('refuses any other file system error on a recording given, with the folder or the file it names', () => {
    const root = ownSessions('c-stat-denied', 'gate-b');
    const c = copySession('gate-c', 'gate-c', root);
    // The tests may run as a user who may read every file, so the error of a folder without permission is made here.
    const stat = fs.statSync;
    const denied = `EACCES: permission denied, stat '${c}'`;
    const spy = vi.spyOn(fs, 'statSync').mockImplementation(((p: fs.PathLike, ...rest: unknown[]) => {
      if (path.resolve(String(p)) === c) throw Object.assign(new Error(denied), { code: 'EACCES', errno: -13, syscall: 'stat', path: c });
      return (stat as (...a: unknown[]) => unknown)(p, ...rest);
    }) as typeof fs.statSync);
    try {
      refused(['gate-b', 'gate-c'], new RegExp(`^confirm refused: gate-c: ${esc(c)} cannot be read \\(${esc(denied)}\\): ${esc(MAKE_READABLE_TEXT)} \\(PREREG\\.md section 11\\)$`), at(root));
    } finally {
      spy.mockRestore();
    }
    // An error that names no file, as reading a folder in place of a file gives, names the folder of the recording.
    const noPath = unreadableFile(Object.assign(new Error(EISDIR_READ), { code: 'EISDIR' }), c);
    expect(noPath.message).toBe(`a file of ${c} cannot be read (${EISDIR_READ}): ${MAKE_READABLE_TEXT} (PREREG.md section 11)`);
  });

  it('lists each later recording confirm cannot read yet as recorded later: one whose stage A has not run, one with a file it cannot read', () => {
    const root = ownSessions('c-then-unread', 'gate-b', 'gate-c');
    // gate-c-2 has GOOD RECORDING, but stage A has not run on it; ledger.jsonl of gate-c-3 cannot be read.
    withoutStages(laterCopy('gate-c', 'gate-c-2', root, afterStart(1)));
    unreadable(laterCopy('gate-c', 'gate-c-3', root, afterStart(2)), 'ledger.jsonl');
    const r = confirmed(['gate-b', 'gate-c'], at(root));
    expect(r.json['pooled']).toEqual(pooledBC ?? runConfirm({ ids: ['gate-b', 'gate-c'], dev: null, deps: freshDeps().deps }).json['pooled']);
    const notes = ['gate-c-2', 'gate-c-3'].map(
      (id) => `pack C (${id}) was recorded after gate-c and is not in the numbers: gate-c is the recording of pack C in the numbers (PREREG.md section 11)`,
    );
    expect(r.json['recorded_later']).toEqual([
      { pack: 'C', id: 'gate-c-2', folder: 'gate-c-2', after: 'gate-c', after_folder: 'gate-c', note: notes[0] },
      { pack: 'C', id: 'gate-c-3', folder: 'gate-c-3', after: 'gate-c', after_folder: 'gate-c', note: notes[1] },
    ]);
    for (const note of notes) expect(r.md).toContain(`- Recorded later: ${note}.`);
    expectPlainText(r.md, r.json);
  }, 60_000);

  it('names the folder to give when an operator renamed the folder of a recording and host gave its id to a later one', () => {
    const root = ownSessions('c-renamed', 'gate-b');
    // The first recording of pack C, in the numbers, in a folder an operator renamed gate-c-failed.
    fs.renameSync(copySession('gate-c', 'gate-c', root), path.join(root, 'gate-c-failed'));
    // host then gave the id gate-c to the next recording of pack C, since no folder had that name,
    // and gate-c-2 to the one after it, whose folder was renamed gate-c-retry.
    laterCopy('gate-c', 'gate-c', root, afterStart(1));
    fs.renameSync(laterCopy('gate-c', 'gate-c-2', root, afterStart(2)), path.join(root, 'gate-c-retry'));
    const inNumbers =
      'which is in the numbers\\. Section 11 keeps the first recording of a pack and records a pack again only after a technical failure before 4:15, so gate-c is the recording of pack C';
    refused(
      ['gate-b', 'gate-c'],
      new RegExp(`^confirm refused: pack C has a recording made before gate-c: gate-c in .*gate-c-failed, ${inNumbers}: give gate-c-failed \\(the folder of gate-c\\) in place of gate-c \\(PREREG\\.md section 11\\)$`),
      at(root),
    );
    refused(
      ['gate-b', 'gate-c-retry'],
      new RegExp(
        `^confirm refused: pack C has a recording made before gate-c-retry \\(the folder of gate-c-2\\): gate-c in .*gate-c-failed, ${inNumbers}: give gate-c-failed \\(the folder of gate-c\\) in place of gate-c-retry \\(the folder of gate-c-2\\) \\(PREREG\\.md section 11\\)$`,
      ),
      at(root),
    );
    const r = confirmed(['gate-b', 'gate-c-failed'], at(root));
    expect(r.json['pooled']).toEqual(pooledBC ?? runConfirm({ ids: ['gate-b', 'gate-c'], dev: null, deps: freshDeps().deps }).json['pooled']);
    const why = 'gate-c-failed (the folder of gate-c) is the recording of pack C in the numbers (PREREG.md section 11)';
    const notes = [
      `pack C (gate-c) was recorded after gate-c-failed (the folder of gate-c) and is not in the numbers: ${why}`,
      `pack C (gate-c-2 in the folder gate-c-retry) was recorded after gate-c-failed (the folder of gate-c) and is not in the numbers: ${why}`,
    ];
    expect(r.json['recorded_later']).toEqual([
      { pack: 'C', id: 'gate-c', folder: 'gate-c', after: 'gate-c', after_folder: 'gate-c-failed', note: notes[0] },
      { pack: 'C', id: 'gate-c-2', folder: 'gate-c-retry', after: 'gate-c', after_folder: 'gate-c-failed', note: notes[1] },
    ]);
    for (const note of notes) {
      expect(r.md).toContain(`- Recorded later: ${note}.`);
      expect(r.summary).toContain(`recorded later: ${note}`);
    }
    // The recording in the numbers is named with its folder, apart from the later gate-c.
    expect(r.json['packs'].map((p: { pack: string; id: string; folder: string }) => [p.pack, p.id, p.folder])).toEqual([
      ['B', 'gate-b', 'gate-b'],
      ['C', 'gate-c', 'gate-c-failed'],
    ]);
    expect(r.md).toMatch(/^- Recordings: pack B gate-b \(verdict [^)]*\); pack C gate-c in the folder gate-c-failed \(verdict /m);
    expectPlainText(r.md, r.json);
  }, 60_000);

  it('names a lost recording in a renamed folder with its folder, apart from the later recording host gave its id', () => {
    const root = ownSessions('c-lost-renamed', 'gate-b');
    // The first recording of pack C, which the SDK ended with kCreditExhausted after 4:15, in a folder an operator renamed gate-c-failed.
    const lostDir = copySession('gate-c', 'gate-c', root);
    withoutStages(lostDir);
    endByCredits(lostDir);
    fs.renameSync(lostDir, path.join(root, 'gate-c-failed'));
    laterCopy('gate-c', 'gate-c', root, afterStart(1));
    const r = confirmed(['gate-b', 'gate-c-failed'], at(root));
    const why = 'quickcheck.json says RE-RECORD NOW: the SDK reported 1 error(s) (code 4 kCreditExhausted)';
    const lostNote = `pack C (gate-c in the folder gate-c-failed) is lost: the SDK ended it with kCreditExhausted (the SDK credits were used up) after its objection block began (4:15), so it is not in the numbers and not replaced (PREREG.md section 11). Reason: ${why}`;
    expect(r.json['lost']).toEqual([{ pack: 'C', id: 'gate-c', folder: 'gate-c-failed', cause: 'credits', objections_begun: true, reasons: [why], note: lostNote }]);
    const laterNote =
      'pack C (gate-c) was recorded after gate-c-failed (the folder of gate-c) and is not in the numbers: gate-c-failed (the folder of gate-c) is lost, and PREREG.md section 11 does not replace a lost recording';
    expect(r.json['recorded_later']).toEqual([{ pack: 'C', id: 'gate-c', folder: 'gate-c', after: 'gate-c', after_folder: 'gate-c-failed', note: laterNote }]);
    expect(r.md).toContain(`- Lost: ${lostNote}.`);
    expect(r.md).toContain(`- Recorded later: ${laterNote}.`);
    expect(r.summary).toContain(`lost: ${lostNote}`);
    expect(r.json['pooled'].packs).toEqual([{ pack: 'B', id: 'gate-b' }]);
    expectPlainText(r.md, r.json);
  }, 60_000);

  it('names by its path a renamed folder whose name is not a session id, and that path gives the numbers', () => {
    const root = ownSessions('c-lost-not-an-id', 'gate-b');
    // The first recording of pack C, lost after 4:15, in a folder an operator renamed gate-c.failed;
    // host then gave the id gate-c to the next recording of pack C.
    const lostDir = copySession('gate-c', 'gate-c', root);
    withoutStages(lostDir);
    failTechnical(lostDir);
    const renamed = path.join(root, 'gate-c.failed');
    fs.renameSync(lostDir, renamed);
    laterCopy('gate-c', 'gate-c', root, afterStart(1));
    const text = refused(['gate-b', 'gate-c'], /^confirm refused: pack C has a recording made before gate-c: gate-c in .*gate-c\.failed, which is lost /, at(root));
    // The refusal names the folder by its path, which the command line takes as a folder path.
    const m = /: give (\S+) \(the folder of gate-c\) in place of gate-c \(PREREG\.md section 11\)$/.exec(text);
    expect(m).not.toBeNull();
    const arg = m![1]!;
    expect(arg).toBe(renamed);
    expect(sessionDirOf(arg, at(root))).toBe(renamed);
    const r = confirmed(['gate-b', arg], at(root));
    expect(r.json['lost']).toMatchObject([{ pack: 'C', id: 'gate-c', folder: 'gate-c.failed', cause: 'technical' }]);
    expect(r.json['lost'][0].note).toMatch(/^pack C \(gate-c in the folder gate-c\.failed\) is lost: /);
    expect(r.json['recorded_later']).toMatchObject([{ pack: 'C', id: 'gate-c', folder: 'gate-c', after: 'gate-c', after_folder: 'gate-c.failed' }]);
    // The report names folders, never paths.
    expect(r.md).not.toContain(root);
    expect(JSON.stringify(r.json)).not.toContain(root);
    expectPlainText(r.md, r.json);
  }, 60_000);

  it('gives the folder to the other commands by its name when that is a session id, and by its path otherwise', () => {
    for (const name of ['gate-c', 'gate-c-failed', 'gate-c-2']) expect(isSessionId(name)).toBe(true);
    for (const name of ['gate-c.failed', 'gate-c_FAILED', 'Gate-c', '-gate-c', '']) expect(isSessionId(name)).toBe(false);
    const root = path.join(w.base, 'sessions-names');
    const env = at(root);
    for (const name of ['gate-c-failed', 'gate-c.failed', 'gate-c_FAILED']) {
      const dir = path.join(root, name);
      const arg = folderArg(dir);
      expect(arg).toBe(isSessionId(name) ? name : dir);
      // npm run confirm, npm run quickcheck and npm run analyze:gate find the folder by it (analysis/lib/paths.ts sessionDirOf).
      expect(sessionDirOf(arg, env)).toBe(dir);
      expect(givenName('gate-c', arg)).toBe(`${arg} (the folder of gate-c)`);
    }
    // Inside the repository, a path relative to it, which npm run resolves from the repository root.
    const inRepo = path.join(REPO_ROOT, 'sessions', 'gate-c.failed');
    expect(folderArg(inRepo)).toBe(path.join('sessions', 'gate-c.failed'));
    expect(path.resolve(REPO_ROOT, folderArg(inRepo))).toBe(inRepo);
  });
});

describe('each recording given lies directly inside the sessions folder, where the other recordings of its pack are looked for (section 11)', () => {
  /** The refusal of the folder `dir` given as `arg`, whose parent is not the sessions folder `root`. */
  const outside = (arg: string, dir: string, root: string): RegExp =>
    new RegExp(
      `^confirm refused: ${esc(arg)} is the folder ${esc(dir)}, which does not lie directly inside the sessions folder ${esc(root)}\\. npm run confirm looks for the other recordings of each pack in the sessions folder alone, so it cannot check that a recording given from elsewhere is the one section 11 keeps for its pack: set COPYHOLDER_SESSIONS_DIR to ${esc(path.dirname(dir))} and give the ids of the recordings, such as ${esc(path.basename(dir))}, in place of their folder paths \\(PREREG\\.md section 11\\)$`,
    );

  it('refuses a folder given from elsewhere for pack B, pack C or --dev, and one below the sessions folder but not directly inside it', () => {
    const root = ownSessions('inside', 'gate-b', 'gate-c');
    const elsewhere = ownSessions('elsewhere', 'gate-b', 'gate-c', 'gate-a');
    const from = (id: string): string => path.join(elsewhere, id);
    refused([from('gate-b'), 'gate-c'], outside(from('gate-b'), from('gate-b'), root), at(root));
    refused(['gate-b', from('gate-c')], outside(from('gate-c'), from('gate-c'), root), at(root));
    refused(['gate-b', 'gate-c', '--dev', from('gate-a')], outside(from('gate-a'), from('gate-a'), root), at(root));
    // A relative folder path is resolved first, and a folder deeper in the sessions folder is refused too.
    const relative = path.relative(process.cwd(), from('gate-c'));
    refused(['gate-b', relative], outside(relative, from('gate-c'), root), at(root));
    fs.mkdirSync(path.join(root, 'deeper'));
    const deeper = copySession('gate-c', path.join('deeper', 'gate-c'), root);
    refused(['gate-b', deeper], outside(deeper, deeper, root), at(root));
  });

  it('takes a folder path directly inside the sessions folder as its recording, by the real paths of the folders', () => {
    const root = ownSessions('inside-links', 'gate-b', 'gate-c');
    // COPYHOLDER_SESSIONS_DIR names the sessions folder through a link; the folders are given by either path.
    const link = path.join(w.base, 'sessions-inside-link');
    fs.symlinkSync(root, link);
    const r = confirmed([path.join(root, 'gate-b'), path.join(link, 'gate-c')], at(link));
    expect(r.json['pooled']).toEqual(pooledBC ?? runConfirm({ ids: ['gate-b', 'gate-c'], dev: null, deps: freshDeps().deps }).json['pooled']);
    expect(r.json['recorded_later']).toEqual([]);
  }, 60_000);

  it('says to give a folder whose name is not a session id by its path again, from its own sessions folder', () => {
    const root = ownSessions('inside-not-an-id', 'gate-b', 'gate-c');
    const elsewhere = path.join(w.base, 'sessions-elsewhere-not-an-id');
    fs.mkdirSync(elsewhere);
    const moved = copySession('gate-c', 'gate-c.moved', elsewhere);
    refused(
      ['gate-b', moved],
      new RegExp(
        `^confirm refused: ${esc(moved)} is the folder ${esc(moved)}, which does not lie directly inside the sessions folder ${esc(root)}\\. .*: set COPYHOLDER_SESSIONS_DIR to ${esc(elsewhere)} and give this folder by its path again, since its name gate-c\\.moved is not a session id \\(PREREG\\.md section 11\\)$`,
      ),
      at(root),
    );
  });
});

describe('every manifest.json of the sessions folder must be readable: the other recordings of a pack decide which one section 11 keeps', () => {
  /** The refusal of the sessions folder `root` while the manifest.json files of `lines` ("<file>: <error>") cannot be read. */
  const unreadManifests = (root: string, lines: readonly string[]): RegExp => {
    const one = lines.length === 1;
    return new RegExp(
      `^confirm refused: npm run confirm cannot tell whether ${one ? 'a folder' : `${lines.length} folders`} of the sessions folder ${esc(root)} ${one ? 'holds' : 'hold'} a recording of pack B or C, since ${one ? 'its' : 'their'} manifest\\.json cannot be read, and the other recordings of a pack decide whether a recording given is the one section 11 keeps for that pack\\. Make each manifest\\.json below readable to this user: where a folder stands in its place, put the file back, and where it holds no JSON object, put back the manifest\\.json host wrote\\. Then run npm run confirm again \\(PREREG\\.md section 11\\):${lines.map((l) => `\\n {2}${esc(l)}`).join('')}$`,
    );
  };

  it('refuses pack B alone and a later recording of pack C while an earlier folder has a folder in place of its manifest.json', () => {
    // gate-c, the first recording of pack C, with a folder where its manifest.json was; gate-c-2 recorded after it.
    const root = ownSessions('manifest-unreadable', 'gate-b');
    const first = copySession('gate-c', 'gate-c', root);
    unreadable(first, 'manifest.json');
    laterCopy('gate-c', 'gate-c-2', root, afterStart(1));
    const why = unreadManifests(root, [`${path.join(first, 'manifest.json')}: ${EISDIR_READ}`]);
    // Read as no recording, gate-c would let pack B alone or gate-c-2 give confirmatory numbers.
    refused(['gate-b'], why, at(root));
    refused(['gate-b', 'gate-c-2'], why, at(root));
    refused(['gate-c-2', 'gate-b'], why, at(root));
  });

  it('lists each manifest.json that holds no JSON object, and leaves out a plain file and a folder without manifest.json', () => {
    const root = ownSessions('manifest-broken', 'gate-b', 'gate-c');
    const notJson = copySession('gate-c', 'gate-x-cut', root);
    putFile(path.join(notJson, 'manifest.json'), '{ "kind": "gate", "pack": "C"');
    const notObject = copySession('gate-c', 'gate-x-array', root);
    putFile(path.join(notObject, 'manifest.json'), '[]\n');
    // Neither holds a recording host started.
    fs.writeFileSync(path.join(root, 'notes.txt'), 'a file of the operator\n');
    fs.mkdirSync(path.join(root, 'empty'));
    refused(
      ['gate-b', 'gate-c'],
      unreadManifests(root, [`${path.join(notObject, 'manifest.json')}: not a JSON object`, `${path.join(notJson, 'manifest.json')}: not valid JSON`]),
      at(root),
    );
    fs.rmSync(notJson, { recursive: true });
    fs.rmSync(notObject, { recursive: true });
    const r = confirmed(['gate-b', 'gate-c'], at(root));
    expect(r.json['pooled']).toEqual(pooledBC ?? runConfirm({ ids: ['gate-b', 'gate-c'], dev: null, deps: freshDeps().deps }).json['pooled']);
    expect(r.json['recorded_later']).toEqual([]);
  }, 60_000);

  it('refuses a manifest.json this user may not read, and a sessions folder it cannot list', () => {
    const root = ownSessions('manifest-denied', 'gate-b', 'gate-c');
    const denied = path.join(copySession('gate-c', 'gate-c-denied', root), 'manifest.json');
    // The tests may run as a user who may read every file, so the errors of missing permissions are made here.
    const read = fs.readFileSync;
    const openDenied = `EACCES: permission denied, open '${denied}'`;
    const readSpy = vi.spyOn(fs, 'readFileSync').mockImplementation(((file: fs.PathOrFileDescriptor, ...rest: unknown[]) => {
      if (file === denied) throw Object.assign(new Error(openDenied), { code: 'EACCES', errno: -13, syscall: 'open', path: denied });
      return (read as (...a: unknown[]) => unknown)(file, ...rest);
    }) as typeof fs.readFileSync);
    try {
      refused(['gate-b', 'gate-c'], unreadManifests(root, [`${denied}: ${openDenied}`]), at(root));
    } finally {
      readSpy.mockRestore();
    }
    const list = fs.readdirSync;
    const scanDenied = `EACCES: permission denied, scandir '${root}'`;
    const listSpy = vi.spyOn(fs, 'readdirSync').mockImplementation(((dir: fs.PathLike, ...rest: unknown[]) => {
      if (path.resolve(String(dir)) === root) throw Object.assign(new Error(scanDenied), { code: 'EACCES', errno: -13, syscall: 'scandir', path: root });
      return (list as (...a: unknown[]) => unknown)(dir, ...rest);
    }) as typeof fs.readdirSync);
    try {
      refused(
        ['gate-b', 'gate-c'],
        new RegExp(
          `^confirm refused: the sessions folder ${esc(root)} cannot be listed \\(${esc(scanDenied)}\\), so npm run confirm cannot look for the other recordings of packs B and C there, which decide whether a recording given is the one section 11 keeps for its pack: make the folder readable to this user, then run npm run confirm again \\(PREREG\\.md section 11\\)$`,
        ),
        at(root),
      );
    } finally {
      listSpy.mockRestore();
    }
  });
});

describe('a recording stopped with Ctrl+C: host saved it, but did not run quickcheck (section 11)', () => {
  /** The refusal of a recording `named` whose folder `folder` has no quickcheck step. */
  const noQuickcheck = (named: string, folder: string): string =>
    `quickcheck has not run on ${named} (host does not run it after Ctrl+C): run npm run quickcheck -- ${folder}, then npm run confirm again (PREREG.md section 11)`;

  it('refuses it as the second id, and pack B alone while it is in the sessions folder, with the command to run', () => {
    const root = ownSessions('c-stopped', 'gate-b');
    recordStepOnly(copySession('gate-c', 'gate-c', root));
    refused(['gate-b', 'gate-c'], new RegExp(`^confirm refused: ${esc(noQuickcheck('gate-c', 'gate-c'))}$`), at(root));
    refused(
      ['gate-b'],
      new RegExp(
        `^confirm refused: pack C has a recording, gate-c in .*gate-c, so pack B is not given alone: give gate-c as the second id; confirm cannot read it yet: ${esc(noQuickcheck('gate-c', 'gate-c'))} \\(PREREG\\.md section 11\\)$`,
      ),
      at(root),
    );
  });

  it('names the folder for quickcheck when an operator renamed it', () => {
    const root = ownSessions('c-stopped-renamed', 'gate-b');
    recordStepOnly(copySession('gate-c', 'gate-c-stopped', root));
    refused(['gate-b', 'gate-c-stopped'], new RegExp(`^confirm refused: ${esc(noQuickcheck('gate-c in the folder gate-c-stopped', 'gate-c-stopped'))}$`), at(root));
  });

  it('names the folder for quickcheck by its path when its name is not a session id', () => {
    const root = ownSessions('c-stopped-not-an-id', 'gate-b');
    const dir = copySession('gate-c', 'gate-c.stopped', root);
    recordStepOnly(dir);
    refused(['gate-b', dir], new RegExp(`^confirm refused: ${esc(noQuickcheck('gate-c in the folder gate-c.stopped', dir))}$`), at(root));
    // npm run quickcheck finds the folder by that path, as npm run confirm does (analysis/lib/paths.ts sessionDirOf).
    expect(sessionDirOf(dir, at(root))).toBe(dir);
  });

  it('refuses --dev with a pack A recording stopped with Ctrl+C', () => {
    recordStepOnly(copySession('gate-a', 'gate-a-stopped'));
    refused(['gate-b', 'gate-c', '--dev', 'gate-a-stopped'], new RegExp(`^confirm refused: ${esc(noQuickcheck('gate-a in the folder gate-a-stopped', 'gate-a-stopped'))}$`));
  });
});

describe('a folder no SDK measured (dry, the mock tap, no SDK) is no recording of its pack (spec 6.5, section 11)', () => {
  /** The refusal of such a folder given as the recording of pack `pack` (`wanted`, the recording to give instead). */
  const notMeasured = (pack: string, id: string, why: string, wanted: string): RegExp =>
    new RegExp(
      `^confirm refused: pack ${pack} \\(${id}\\) is not a recording the SDK measured: its manifest\\.json says ${esc(why)}, and a recording no SDK measured is never data, whatever quickcheck and the later steps made of it\\. Give ${esc(wanted)} that the SDK measured, made with the real tap \\(spec 6\\.5, PREREG\\.md section 11\\)$`,
    );
  const MOCK = 'tap: "mock" (the mock tap made up the chest trace)';
  const DRY = 'dry: true (tap ran its stand-in SDK)';
  const NO_SDK = 'sdk: null (no SDK ran)';
  /** The note confirm gives such a folder: not counted. */
  const notCounted = (folder: string, which: string, pack: string, why: string): string =>
    `the folder ${folder} (${which}) holds no recording the SDK measured: its manifest.json says ${why}, so it is not a recording of pack ${pack} and is not counted (spec 6.5, PREREG.md section 11)`;

  it('refuses such a folder given for pack B, pack C or --dev, with what its manifest.json says', () => {
    const root = ownSessions('unmeasured-given', 'gate-b', 'gate-c');
    mockTap(copySession('gate-b', 'gate-b-mock', root));
    editManifest(copySession('gate-c', 'gate-c-dry', root), (m) => {
      m['dry'] = true;
    });
    editManifest(copySession('gate-a', 'gate-a-no-sdk', root), (m) => {
      m['sdk'] = null;
    });
    refused(['gate-b-mock', 'gate-c'], notMeasured('B', 'gate-b', MOCK, 'the recording of pack B'), at(root));
    refused(['gate-b', 'gate-c-dry'], notMeasured('C', 'gate-c', DRY, 'the recording of pack C'), at(root));
    refused(['gate-b', 'gate-c', '--dev', 'gate-a-no-sdk'], notMeasured('A', 'gate-a', NO_SDK, 'the pack A recording'), at(root));
  });

  it('leaves such folders out of the recordings of each pack, and lists them as not counted', () => {
    const root = ownSessions('unmeasured-listed', 'gate-b', 'gate-c');
    // A mock run of pack C before gate-c that stopped before its objection block (4:15), and one of
    // pack B after gate-b under the id gate-b in another folder: neither is a recording of its pack.
    const before = laterCopy('gate-c', 'gate-c-mock', root, afterStart(-1));
    mockTap(before);
    dropStepMark(before, gateSteps('C').objections);
    const after = copySession('gate-b', 'gate-b-mock-run', root);
    mockTap(after);
    editManifest(after, (m) => {
      m['started_utc'] = afterStart(1);
    });
    const r = confirmed(['gate-b', 'gate-c'], at(root));
    expect(r.json['confirmatory']).toBe(true);
    expect(r.json['not_confirmatory_because']).toEqual([]);
    expect(r.json['recorded_later']).toEqual([]);
    expect(r.json['pooled']).toEqual(pooledBC ?? runConfirm({ ids: ['gate-b', 'gate-c'], dev: null, deps: freshDeps().deps }).json['pooled']);
    const notes = [notCounted('gate-b-mock-run', 'pack B, id gate-b', 'B', MOCK), notCounted('gate-c-mock', 'pack C', 'C', MOCK)];
    expect(r.json['not_counted']).toEqual([
      { pack: 'B', id: 'gate-b', folder: 'gate-b-mock-run', why: MOCK, note: notes[0] },
      { pack: 'C', id: 'gate-c-mock', folder: 'gate-c-mock', why: MOCK, note: notes[1] },
    ]);
    for (const note of notes) {
      expect(r.md).toContain(`- Not counted: ${note}.`);
      expect(r.summary).toContain(`not counted: ${note}`);
    }
    expect(r.md).not.toContain('Not confirmatory');
    expectPlainText(r.md, r.json);
  }, 60_000);

  it('gives pack B alone when pack C has only a folder no SDK measured, and lists that folder as not counted', () => {
    const root = ownSessions('unmeasured-c-only', 'gate-b');
    const dry = copySession('gate-c', 'gate-c', root);
    editManifest(dry, (m) => {
      m['dry'] = true;
    });
    const r = confirmed(['gate-b'], at(root));
    expect(r.json['lost']).toMatchObject([{ pack: 'C', id: null, cause: 'not recorded', reasons: [] }]);
    expect(r.json['pooled'].packs).toEqual([{ pack: 'B', id: 'gate-b' }]);
    // Pack C has no recording in the numbers, so a run of pack C heard before cannot touch them.
    expect(r.json['confirmatory']).toBe(true);
    const note = notCounted('gate-c', 'pack C', 'C', DRY);
    expect(r.json['not_counted']).toEqual([{ pack: 'C', id: 'gate-c', folder: 'gate-c', why: DRY, note }]);
    expect(r.md).toContain(`- Not counted: ${note}.`);
    expectPlainText(r.md, r.json);
  }, 60_000);

  it('marks the numbers not confirmatory when such a run reached the objection block of a pack before its recording in the numbers', () => {
    const root = ownSessions('unmeasured-heard', 'gate-b', 'gate-c');
    // A mock run of pack C that reached its objection block before gate-c was recorded.
    mockTap(laterCopy('gate-c', 'gate-c-mock', root, afterStart(-2)));
    // A dry run of pack B before gate-b whose stamps.jsonl cannot be read: it is not shown to have stopped before 4:15.
    const dry = copySession('gate-b', 'gate-b-dry', root);
    editManifest(dry, (m) => {
      m['dry'] = true;
      m['started_utc'] = afterStart(-1);
    });
    unreadable(dry, 'stamps.jsonl');
    const r = confirmed(['gate-b', 'gate-c'], at(root));
    const why = [
      `the folder gate-b-dry holds a run of pack B that no SDK measured, which started before gate-b, the recording of pack B in the numbers, and its stamps.jsonl cannot be read (${EISDIR_READ}), so it is not shown that the run stopped before its objection block (4:15): the participant may have heard the planted errors of pack B before that recording, and the participant neither reads nor hears the packs beforehand (PREREG.md sections 7.1 and 11)`,
      'the folder gate-c-mock holds a run of pack C that no SDK measured, which started before gate-c, the recording of pack C in the numbers, and reached its objection block (4:15): the participant heard the planted errors of pack C before that recording, and the participant neither reads nor hears the packs beforehand (PREREG.md sections 7.1 and 11)',
    ];
    expect(r.json['confirmatory']).toBe(false);
    expect(r.json['not_confirmatory_because']).toEqual(why);
    // The numbers are computed all the same, as for a condition of the tag.
    expect(r.json['pooled']).toEqual(pooledBC ?? runConfirm({ ids: ['gate-b', 'gate-c'], dev: null, deps: freshDeps().deps }).json['pooled']);
    expect(r.json['not_counted'].map((f: { folder: string }) => f.folder)).toEqual(['gate-b-dry', 'gate-c-mock']);
    expect(r.md).toContain(`**Not confirmatory.** These numbers are computed as PREREG.md section 11 says, but a condition of section 11 is not met: ${why.join('; ')}.`);
    expect(r.summary[1]).toBe(`NOT CONFIRMATORY: ${why.join('; ')}`);
    expectPlainText(r.md, r.json);
  }, 60_000);
});

describe('the tag gate-retune: the pooled code frozen under it, and its time before the recordings (section 11)', () => {
  /** Each file of the pooled code under the tag as it is in this checkout, by repository path. */
  const asItIs = (_tag: string, file: string): Buffer | null => {
    const own = path.join(REPO_ROOT, ...file.split('/'));
    return fs.existsSync(own) ? fs.readFileSync(own) : null;
  };
  const tagDeps = (tagBytes: ConfirmDeps['tagBytes'] = asItIs, time: string | null = TAG_TIME): Pick<ConfirmDeps, 'tagBytes' | 'tagTime'> => ({ tagBytes, tagTime: () => time });
  const starts = [
    { pack: 'B', id: 'gate-b', startedUtc: '2026-11-13T18:00:00Z' },
    { pack: 'C', id: 'gate-c', startedUtc: '2026-11-14T18:00:00Z' },
  ];

  it('compares every module npm run confirm loads, found by following its imports, test files aside, with its copy under the tag', () => {
    const files = confirmCodeFiles();
    expect(files).toEqual([...files].sort());
    expect(files).toContain('analysis/confirm.ts');
    // Every module of analysis/confirm/ but the tests, and what they load from stage B, analysis/lib and core.
    const own = fs
      .readdirSync(path.join(REPO_ROOT, 'analysis', 'confirm'))
      .filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'))
      .map((f) => `analysis/confirm/${f}`);
    expect(files).toEqual(expect.arrayContaining([...own, 'analysis/gate/score.ts', 'analysis/gate/stage-a.ts', 'analysis/pack/rules.ts', 'analysis/lib/paths.ts', 'core/detector.ts']));
    expect(files.some((f) => f.endsWith('.test.ts'))).toBe(false);
    expect(files.every((f) => fs.existsSync(path.join(REPO_ROOT, f)))).toBe(true);
    const t = retuneTagFacts(starts, tagDeps());
    expect(t).toMatchObject({ tag: 'gate-retune', tagTime: TAG_TIME, codeFiles: files, codeDifferences: [], problems: [] });
  });

  it('names each file that differs from its copy under the tag by a single byte, or is not under it', () => {
    const t = retuneTagFacts(
      starts,
      tagDeps((x, f) => {
        if (f === 'analysis/confirm/run.ts') return Buffer.from('// an older copy\n');
        if (f === 'analysis/confirm/tag.ts') return null;
        // A module of stage B that confirm loads, with one more byte under the tag.
        if (f === 'analysis/gate/score.ts') return Buffer.concat([asItIs(x, f)!, Buffer.from('\n')]);
        return asItIs(x, f);
      }),
    );
    expect(t.codeDifferences).toEqual([
      'analysis/confirm/run.ts differs from its copy under the tag gate-retune',
      'analysis/confirm/tag.ts is not under the tag gate-retune',
      'analysis/gate/score.ts differs from its copy under the tag gate-retune',
    ]);
    const n = t.codeFiles.length;
    expect(t.problems).toEqual(t.codeDifferences.map((d) => `the pooled analysis code (${n} files, every module npm run confirm loads) is not the code frozen with the parameters: ${d}`));
  });

  it('needs the tag earlier than the start of each recording, by the clock in any time zone, and its time from git', () => {
    const problems = (time: string | null): string[] => retuneTagFacts(starts, tagDeps(asItIs, time)).problems;
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
    const root = ownSessions('c-lost-again', 'gate-b');
    const dir = copySession('gate-c', 'gate-c-lost-again', root);
    withoutStages(dir);
    failTechnical(dir);
    let r: Ran | null = null;
    const late = '2026-11-20T09:00:00Z';
    withTag({ code: { 'analysis/confirm/numbers.ts': '// an older copy\n' }, time: late }, () => {
      r = confirmed(['gate-b', 'gate-c-lost-again'], at(root));
    });
    const ran = r as unknown as Ran;
    const n = confirmCodeFiles().length;
    const why = [
      `the pooled analysis code (${n} files, every module npm run confirm loads) is not the code frozen with the parameters: analysis/confirm/numbers.ts differs from its copy under the tag gate-retune`,
      `the tag gate-retune (${late}) is not earlier than the start of pack B (gate-b) at ${w.start}: the parameters were not frozen before that pack was recorded`,
      `the tag gate-retune (${late}) is not earlier than the start of pack C (gate-c) at ${w.start}: the parameters were not frozen before that pack was recorded`,
    ];
    expect(ran.json['confirmatory']).toBe(false);
    expect(ran.json['not_confirmatory_because']).toEqual(why);
    expect(ran.json['retune_tag']).toMatchObject({ time: late, code_differences: ['analysis/confirm/numbers.ts differs from its copy under the tag gate-retune'] });
    expect(ran.json['retune_tag'].code_files).toHaveLength(n);
    expect(ran.md).toContain(`**Not confirmatory.** These numbers are computed as PREREG.md section 11 says, but a condition of section 11 is not met: ${why.join('; ')}.`);
    expect(ran.md).toContain(
      `- The pooled analysis code, every module npm run confirm loads (${n} files, listed in confirm.json under retune_tag.code_files), differs from its copy under the tag gate-retune: analysis/confirm/numbers.ts differs from its copy under the tag gate-retune.`,
    );
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
    const root = ownSessions('b-again', 'gate-b');
    copySession('gate-b', 'gate-b-again', root);
    refused(['gate-b', 'gate-b-again'], /are both pack B: the confirmation pools one recording of pack B and one of pack C/, at(root));
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

  /** A sessions folder of its own holding gate-b and a copy of gate-c named `name`, for one refusal. */
  const withC = (name: string): { root: string; dir: string } => {
    const root = ownSessions(name, 'gate-b');
    return { root, dir: copySession('gate-c', name, root) };
  };

  /** A sessions folder of its own holding the forged pack B and a copy of `from` named `name`. */
  const forgedWith = (name: string, from = 'gate-c'): { root: string; dir: string } => {
    const root = ownSessions(name);
    forgedB(root);
    return { root, dir: copySession(from, name, root) };
  };

  it('refuses a recording whose ledger.jsonl is missing or broken', () => {
    // host closed the recording (manifest.json state closed), then its ledger went missing.
    const none = withC('gate-no-ledger');
    fs.rmSync(path.join(none.dir, 'ledger.jsonl'));
    refused(['gate-b', 'gate-no-ledger'], new RegExp(`^confirm refused: pack C \\(gate-c\\): ${esc(closedNoLedger('C'))}$`), at(none.root));
    const broken = withC('gate-broken-ledger');
    appendTo(broken.dir, 'ledger.jsonl', 'not a ledger line');
    refused(['gate-b', 'gate-broken-ledger'], /pack C \(gate-c\): ledger\.jsonl is broken, nothing is run:\n {2}/, at(broken.root));
  });

  it('refuses quickcheck.json and clock_report.json other than their steps wrote them', () => {
    const q = withC('gate-quickcheck-edited');
    appendTo(q.dir, 'quickcheck.json', '');
    refused(
      ['gate-b', 'gate-quickcheck-edited'],
      /pack C \(gate-c\): a file of an earlier step does not match ledger\.jsonl, so nothing is scored \(spec 8\.5\):\n {2}quickcheck\.json changed after step quickcheck wrote it/,
      at(q.root),
    );
    const c = withC('gate-clock-edited');
    appendTo(c.dir, 'clock_report.json', '');
    refused(['gate-b', 'gate-clock-edited'], /pack C \(gate-c\): a file of an earlier step does not match ledger\.jsonl[\s\S]*clock_report\.json changed after step \w+ wrote it/, at(c.root));
    const invalid = withC('gate-quickcheck-invalid');
    replaceRecorded(invalid.dir, 'quickcheck.json', '{}\n');
    refused(['gate-b', 'gate-quickcheck-invalid'], /pack C \(gate-c\): quickcheck\.json is not valid:\n {2}/, at(invalid.root));
  });

  it('refuses a recording whose stage B has not finished, or whose stage A has not run', () => {
    const b = withC('gate-no-stage-b');
    reforgeLedger(b.dir, (r) => (!isNoteLine(r) && (r.step === 'stage_b' || r.step === 'verdict') ? null : r));
    fs.rmSync(path.join(b.dir, 'verdict.json'));
    fs.rmSync(path.join(b.dir, 'verdict.md'));
    refused(['gate-b', 'gate-no-stage-b'], /pack C \(gate-c\): stage B has not finished/, at(b.root));
    const a = withC('gate-no-stage-a');
    reforgeLedger(a.dir, (r) => (!isNoteLine(r) && (r.step === 'stage_a' || r.step === 'stage_b' || r.step === 'verdict') ? null : r));
    refused(['gate-b', 'gate-no-stage-a'], /pack C \(gate-c\): stage A has not run/, at(a.root));
  });

  it('names the folder for analyze:gate by its path when its name is not a session id, and analyze:gate then scores it', async () => {
    const root = ownSessions('c-unscored-not-an-id', 'gate-b');
    const dir = copySession('gate-c', 'gate-c.unscored', root);
    withoutStages(dir);
    refused(
      ['gate-b', dir],
      new RegExp(`^confirm refused: pack C \\(gate-c\\): stage A has not run \\(no confirmatory stage_a line in ledger\\.jsonl\\): run npm run analyze:gate -- --stage A ${esc(dir)}, then stage B \\(PREREG\\.md section 7\\.5\\)$`),
      at(root),
    );
    const deps = { ...w.deps, env: { ...w.deps.env, ...at(root) } };
    expect(await gateMain(['--stage', 'A', dir], deps)).toBe(0);
    refused(
      ['gate-b', dir],
      new RegExp(
        `^confirm refused: pack C \\(gate-c\\): stage B has not finished \\(no confirmatory stage_b and verdict lines in ledger\\.jsonl\\): run npm run analyze:gate -- --stage B ${esc(dir)} first \\(PREREG\\.md section 7\\.5\\)$`,
      ),
      at(root),
    );
    expect(await gateMain(['--stage', 'B', dir], deps)).toBe(0);
    const r = confirmed(['gate-b', dir], at(root));
    expect(r.json['pooled']).toEqual(pooledBC ?? runConfirm({ ids: ['gate-b', 'gate-c'], dev: null, deps: freshDeps().deps }).json['pooled']);
    expect(r.json['packs'][1]).toMatchObject({ pack: 'C', id: 'gate-c', folder: 'gate-c.unscored', verdict_by: 'stage B' });
  }, 120_000);

  it('refuses a verdict.json changed after stage B wrote it', () => {
    const { root, dir } = withC('gate-edited');
    const v = readVerdict('gate-c');
    putFile(path.join(dir, 'verdict.json'), `${JSON.stringify({ ...v, verdict: 'PASS' })}\n`);
    refused(['gate-b', 'gate-edited'], /pack C \(gate-c\): a file of an earlier step does not match ledger\.jsonl[\s\S]*verdict\.json changed after step \w+ wrote it/, at(root));
  });

  it('refuses a verdict.json of another run, another recording or another parameter set than its stage A', () => {
    const run2 = withC('gate-verdict-run-2');
    editJson(run2.dir, 'verdict.json', (v) => {
      v['run'] = 2;
      v['exploratory'] = true;
    });
    refused(['gate-b', 'gate-verdict-run-2'], /pack C \(gate-c\): verdict\.json is from stage B run 2, not the confirmatory run 1/, at(run2.root));
    const other = withC('gate-verdict-other');
    editJson(other.dir, 'verdict.json', (v) => {
      v['id'] = 'gate-x';
    });
    refused(['gate-b', 'gate-verdict-other'], /pack C \(gate-c\): verdict\.json is for gate-x pack C, not for gate-c pack C/, at(other.root));
    const params = withC('gate-verdict-params');
    const next = sha256Hex(tunedText(2.5, 0.02));
    editJson(params.dir, 'verdict.json', (v) => {
      v['params_sha256'] = next;
    });
    refused(
      ['gate-b', 'gate-verdict-params'],
      new RegExp(`pack C \\(gate-c\\): verdict\\.json was scored with params ${next.slice(0, 8)}, but stage A froze ${sha256Hex(w.retuneText).slice(0, 8)}`),
      at(params.root),
    );
  });

  it('checks the files stage B scores from in both recordings before it computes either', () => {
    // Computing the forged pack B would refuse on its verdict.json; each refusal below names a
    // file of pack C instead, so pack C was checked before pack B was computed.
    const samples = forgedWith('gate-no-samples');
    fs.rmSync(path.join(samples.dir, 'samples.jsonl'));
    refused(
      ['gate-b-forged', 'gate-no-samples'],
      /pack C \(gate-c\): stage B reads every line of stamps\.jsonl, detector_in\.jsonl, samples\.jsonl, calib\.json; a lost or broken input is a technical failure, not a reading of the gate \(spec 8\.1, 9\.4\):\n {2}samples\.jsonl is missing/,
      at(samples.root),
    );
    const broken = forgedWith('gate-broken-input');
    appendTo(broken.dir, 'detector_in.jsonl', 'not a line');
    refused(['gate-b-forged', 'gate-broken-input'], /pack C \(gate-c\): stage B reads every line of [\s\S]*\n {2}detector_in\.jsonl line \d+: not valid JSON/, at(broken.root));
    const calib = forgedWith('gate-calib-edited');
    appendTo(calib.dir, 'calib.json', '');
    refused(['gate-b-forged', 'gate-calib-edited'], /pack C \(gate-c\): a file of an earlier step does not match ledger\.jsonl[\s\S]*calib\.json changed after step \w+ wrote it/, at(calib.root));
    const onsets = forgedWith('gate-onsets-edited');
    appendTo(onsets.dir, 'onsets.json', '');
    refused(['gate-b-forged', 'gate-onsets-edited'], /pack C \(gate-c\): a file of an earlier step does not match ledger\.jsonl[\s\S]*onsets\.json changed after step label wrote it/, at(onsets.root));
    const labels = forgedWith('gate-labels-forged');
    editJson(labels.dir, 'onsets.json', (o) => {
      o['labels_sha256'] = 'a'.repeat(64);
    });
    refused(['gate-b-forged', 'gate-labels-forged'], /pack C \(gate-c\): onsets\.json: its blind labels and hand marks give labels_sha256 [0-9a-f]{8}, not the aaaaaaaa it holds/, at(labels.root));
    const sign = forgedWith('gate-no-sign');
    editJson(sign.dir, 'calib.json', (c) => {
      c['polarity'].sign = null;
    });
    refused(['gate-b-forged', 'gate-no-sign'], /pack C \(gate-c\): calib\.json has no trace sign \(polarity\.sign\)/, at(sign.root));
    // The same checks on the pack A recording of --dev come before any computing too.
    const dev = forgedWith('gate-a-no-samples', 'gate-a');
    copySession('gate-c', 'gate-c', dev.root);
    fs.rmSync(path.join(dev.dir, 'samples.jsonl'));
    refused(['gate-b-forged', 'gate-c', '--dev', 'gate-a-no-samples'], /pack A \(gate-a\): stage B reads every line of [\s\S]*samples\.jsonl is missing/, at(dev.root));
  });

  it('refuses when stage B run again does not give the verdict.json stage B wrote', () => {
    const root = ownSessions('b-forged', 'gate-c');
    forgedB(root);
    refused(['gate-b-forged', 'gate-c'], /pack B \(gate-b\): stage B's computation run again on the same files and params does not give the verdict\.json stage B wrote[\s\S]*misses\.no_inbreath/, at(root));
  }, 60_000);

  it('refuses packs scored with different parameters', () => {
    const { root, dir } = withC('gate-other-params');
    const other = sha256Hex(tunedText(2.5, 0.02));
    const own = sha256Hex(w.retuneText);
    editJson(dir, 'verdict.json', (v) => {
      v['params_sha256'] = other;
    });
    reforgeLedger(dir, (r) => (isNoteLine(r) || r.step !== 'stage_a' ? r : { ...r, out_sha256: Object.fromEntries(Object.entries(r.out_sha256).map(([k, s]) => [k, s === own ? other : s])) }));
    refused(['gate-b', 'gate-other-params'], new RegExp(`pack B \\(gate-b\\) was scored with params ${own.slice(0, 8)} and pack C \\(gate-c\\) with params ${other.slice(0, 8)}`), at(root));
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
