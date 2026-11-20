// Tuning on pack A (PREREG §11): the rule on stand-in grades, then npm run retune end to end on
// synthetic pack A recordings written as session folders, through the checks of the gate-retune
// freeze and of the next pack's stage A, to stage B on the next pack with the tuned params.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { exampleVerdict } from '../../core/schemas/examples.ts';
import { formatForPath, validateFileText, validateFrozenParams } from '../../core/schemas/index.ts';
import type { RepoView } from '../../tools/freeze/git.ts';
import { checkTag } from '../../tools/freeze/tags.ts';
import { main as gate } from '../gate.ts';
import { sha256Hex } from '../lib/ledger.ts';
import { REPORT_JSON, REPORT_MD, loadRetune, main as retune, parseRetuneArgs } from '../retune.ts';
import type { GateDeps } from './deps.ts';
import { RETUNE_TAG, checkRetune, frozenParamsText, frozenWithTuning, jsonDiffPaths } from './frozen.ts';
import {
  FALLBACK_ORDER,
  LOWEST_ROW3_ORDER,
  RUNG2_ORDER,
  chosenParams,
  keepsStageAFile,
  makeGrader,
  paramsLine,
  paramsWithSet,
  passesAll,
  retuneParams,
  runRetune,
  setKey,
  tunedLine,
  type Graded,
  type Grader,
  type RetuneSet,
  type ThetaGChoice,
} from './retune.ts';
import { runStageA } from './stage-a.ts';
import { runStageB } from './stage-b.ts';
import { buildGateSynth, preregParamsText, writeGateSession, type GateSynthOptions, type ReplyPlan } from './synth.ts';

// ---- the rule of PREREG §11 on stand-in grades -------------------------------------------------

/** What a stand-in grader gives a set: row 1 count, row 3 rate as printed, PASS on all five rows. */
interface Grade {
  hits?: number;
  rate?: number | null;
  pass?: boolean;
}

const theta = (thetaG: number): ThetaGChoice => ({ thetaG, criterionMet: true, d1Fires: 2, d1ActiveMinutes: 2.1, gLimit: 2, trials: [] });

/** stage B's verdict object with the rows the rule reads; 6 hits and 1.0 false holds/min by default. */
function graded(g: Grade): Graded {
  const v = exampleVerdict();
  v.rows.hits.hits = g.hits ?? 6;
  v.rows.false_holds.per_min = g.rate === undefined ? 1 : g.rate;
  v.verdict = g.pass === true ? 'PASS' : 'BETWEEN';
  return { thetaG: theta(0.02), verdict: v };
}

/** Grades by set key, `dflt` for the rest; records every set graded. */
function grader(grades: Record<string, Grade>, calls: string[] = [], dflt: Grade = {}): Grader {
  return (s) => {
    calls.push(setKey(s));
    return graded(grades[setKey(s)] ?? dflt);
  };
}

const D1 = (k: number, L: number, M: number): string => setKey({ k, L, M, variant: 'D1' });
const D3 = (k: number, L: number, M: number): string => setKey({ k, L, M, variant: 'D3' });
const STAGE_A: RetuneSet = { k: 2.5, L: 5, M: 2, variant: 'D1' };
/** params/frozen.json as stage A writes it for STAGE_A: k 2.5 met stage A's limit, theta_G 0.0200. */
const STAGE_A_PARAMS = frozenWithTuning(JSON.parse(preregParamsText()) as Record<string, unknown>, {
  k: 2.5,
  criterionMet: true,
  thetaG: 0.02,
  step: 'stage_a',
}) as unknown as Record<string, unknown>;
const STAGE_A_TEXT = frozenParamsText(STAGE_A_PARAMS);

describe('the rule of PREREG §11 (stand-in grades)', () => {
  it('step 1: PASS on pack A keeps the stage A set and tries nothing else', () => {
    const calls: string[] = [];
    const o = runRetune(STAGE_A, grader({ [setKey(STAGE_A)]: { pass: true } }, calls));
    expect(o).toMatchObject({ step: 'pass', ladderK: null, rung1K: null, rung3Pair: null, decidedBy: null, among: 1 });
    expect(o.chosen.set).toEqual(STAGE_A);
    expect(calls).toEqual([setKey(STAGE_A)]);
    // After PASS, --write copies the stage A file unchanged.
    expect(chosenParams(o, STAGE_A_PARAMS, STAGE_A_TEXT)).toEqual({ text: STAGE_A_TEXT, stageAFile: true, tuned: { step: 'stage_a', criterionMet: true } });
  });

  it('rung 1: k one grid step down with PASS on all five rows ends the ladder', () => {
    const calls: string[] = [];
    const o = runRetune(STAGE_A, grader({ [D1(2, 5, 2)]: { pass: true } }, calls));
    expect(o).toMatchObject({ step: 'rung_1', ladderK: 2, rung1K: 2, rung3Pair: null });
    expect(o.chosen.set).toEqual({ k: 2, L: 5, M: 2, variant: 'D1' });
    expect(o.chosen.sources).toEqual(['rung_1']);
    expect(calls).toEqual([setKey(STAGE_A), D1(2, 5, 2)]);
  });

  it('k = 1.5 has no rung 1: rung 2 runs at k = 1.5 and grades the stage A set once', () => {
    const calls: string[] = [];
    const o = runRetune({ ...STAGE_A, k: 1.5 }, grader({ [D1(1.5, 7, 1)]: { pass: true } }, calls));
    expect(o).toMatchObject({ step: 'rung_2', ladderK: 1.5, rung1K: null, among: 1, decidedBy: null });
    expect(o.chosen.set).toEqual({ k: 1.5, L: 7, M: 1, variant: 'D1' });
    expect(calls).toHaveLength(9);
    expect(new Set(calls).size).toBe(9);
    expect(o.candidates[0]!.sources).toEqual(['stage_a', 'rung_2']);
  });

  const rung2Cases: Array<{ by: string | null; passing: Record<string, Grade>; want: [number, number] }> = [
    { by: 'the higher row 1 count', passing: { [D1(2, 7, 3)]: { hits: 11 }, [D1(2, 5, 1)]: { hits: 10 } }, want: [7, 3] },
    { by: 'the lower row 3 rate', passing: { [D1(2, 7, 3)]: { rate: 1.5 }, [D1(2, 4, 1)]: { rate: 0.4 } }, want: [4, 1] },
    { by: 'L nearer 5', passing: { [D1(2, 4, 2)]: {}, [D1(2, 7, 2)]: {}, [D1(2, 5, 3)]: {} }, want: [5, 3] },
    { by: 'M nearer 2', passing: { [D1(2, 4, 1)]: {}, [D1(2, 4, 2)]: {} }, want: [4, 2] },
    { by: 'the larger M', passing: { [D1(2, 7, 1)]: {}, [D1(2, 7, 3)]: {} }, want: [7, 3] },
    { by: null, passing: { [D1(2, 4, 3)]: { hits: 3 } }, want: [4, 3] },
  ];
  for (const c of rung2Cases) {
    it(c.by === null ? 'rung 2: a lone pair with PASS on all five rows needs no tie rule' : `rung 2: among the pairs with PASS on all five rows, ${c.by} decides`, () => {
      const grades = Object.fromEntries(Object.entries(c.passing).map(([key, g]) => [key, { ...g, pass: true }]));
      const calls: string[] = [];
      const o = runRetune(STAGE_A, grader(grades, calls));
      expect(o).toMatchObject({ step: 'rung_2', ladderK: 2, rung1K: 2, decidedBy: c.by, among: Object.keys(c.passing).length });
      expect(o.chosen.set).toEqual({ k: 2, L: c.want[0], M: c.want[1], variant: 'D1' });
      // Rung 1's set is the pair with stage A's L and M: graded once, for both rungs.
      expect(calls).toHaveLength(10);
      expect(o.candidates[1]!.sources).toEqual(['rung_1', 'rung_2']);
    });
  }

  it('rung 3: D3 at the L and M of the pair with the highest row 1 count, ties as in rung 2', () => {
    const calls: string[] = [];
    // (4,1) and (4,3) tie on row 1, row 3, L and M nearness: the larger M gives rung 3 its pair.
    const grades = { [D1(2, 4, 1)]: { hits: 9 }, [D1(2, 4, 3)]: { hits: 9 }, [D1(2, 5, 1)]: { hits: 9, rate: 1.5 }, [D3(2, 4, 3)]: { pass: true } };
    const o = runRetune(STAGE_A, grader(grades, calls));
    expect(o).toMatchObject({ step: 'rung_3', rung3Pair: { L: 4, M: 3 } });
    expect(o.chosen.set).toEqual({ k: 2, L: 4, M: 3, variant: 'D3' });
    expect(o.chosen.sources).toEqual(['rung_3']);
    expect(calls).toHaveLength(11);
  });

  it('rung 3 at k = 1.5 keeps the stage A k', () => {
    const o = runRetune({ ...STAGE_A, k: 1.5 }, grader({ [D1(1.5, 5, 2)]: { hits: 9 }, [D3(1.5, 5, 2)]: { pass: true } }));
    expect(o).toMatchObject({ step: 'rung_3', ladderK: 1.5, rung1K: null, rung3Pair: { L: 5, M: 2 } });
    expect(o.chosen.set).toEqual({ k: 1.5, L: 5, M: 2, variant: 'D3' });
  });

  const fallbackCases: Array<{ by: string; grades: Record<string, Grade>; want: string; among?: number }> = [
    // A set with more hits but row 3 above 2 (as printed) is left out; 2.0 itself is kept.
    { by: 'the higher row 1 count', grades: { [D1(2, 7, 1)]: { hits: 9, rate: 2.1 }, [D1(2, 4, 1)]: { hits: 8, rate: 2 } }, want: D1(2, 4, 1), among: 10 },
    { by: 'the lower row 3 rate', grades: { [D1(2, 7, 1)]: { hits: 9, rate: 1.4 }, [D1(2, 4, 1)]: { hits: 9, rate: 1.3 } }, want: D1(2, 4, 1) },
    { by: 'L nearer 5', grades: { [D1(2, 7, 2)]: { hits: 9 }, [D1(2, 4, 3)]: { hits: 9 } }, want: D1(2, 4, 3) },
    { by: 'M nearer 2', grades: { [D1(2, 4, 1)]: { hits: 9 }, [D1(2, 4, 2)]: { hits: 9 } }, want: D1(2, 4, 2) },
    // Rung 3 tries D3 at (4,3); D3 ties its D1 pair on everything before the variant.
    { by: 'D1 before D3', grades: { [D1(2, 4, 3)]: { hits: 9 }, [D3(2, 4, 3)]: { hits: 9 } }, want: D1(2, 4, 3) },
    { by: 'the larger M', grades: { [D1(2, 7, 1)]: { hits: 9 }, [D1(2, 7, 3)]: { hits: 9 } }, want: D1(2, 7, 3) },
    // The stage A set and rung 1's set differ only in k: the one tried first, the stage A set, stays.
    { by: 'the set tried first', grades: { [setKey(STAGE_A)]: { hits: 9 }, [D1(2, 5, 2)]: { hits: 9 } }, want: setKey(STAGE_A) },
  ];
  for (const c of fallbackCases) {
    it(`step 3, row 3 at most 2: ${c.by} decides`, () => {
      const o = runRetune(STAGE_A, grader(c.grades));
      expect(o.step).toBe('row3_at_most_2');
      expect(o.candidates).toHaveLength(11);
      expect(setKey(o.chosen.set)).toBe(c.want);
      expect(o.decidedBy).toBe(c.by);
      expect(o.among).toBe(c.among ?? 11);
    });
  }

  it('step 3 with no set at row 3 at most 2: the lowest rate wins, a rate without active time last', () => {
    // Stage A has the most hits but no rate; (4,1) has the lowest rate, (4,2) the same with more hits.
    const grades = { [setKey(STAGE_A)]: { hits: 14, rate: null }, [D1(2, 4, 1)]: { hits: 6, rate: 2.2 }, [D1(2, 4, 2)]: { hits: 7, rate: 2.2 } };
    const o = runRetune(STAGE_A, grader(grades, [], { rate: 3 }));
    expect(o).toMatchObject({ step: 'lowest_row3', decidedBy: 'the higher row 1 count', among: 11 });
    expect(o.chosen.set).toEqual({ k: 2, L: 4, M: 2, variant: 'D1' });
    const lone = runRetune(STAGE_A, grader({ [D1(2, 7, 3)]: { rate: 2.5 } }, [], { rate: 4 }));
    expect(lone).toMatchObject({ step: 'lowest_row3', decidedBy: 'the lower row 3 rate' });
    expect(setKey(lone.chosen.set)).toBe(D1(2, 7, 3));
  });

  it('names the orders of PREREG §7.7 and §11', () => {
    const names = (o: ReadonlyArray<{ name: string }>): string[] => o.map((c) => c.name);
    expect(names(RUNG2_ORDER)).toEqual(['the higher row 1 count', 'the lower row 3 rate', 'L nearer 5', 'M nearer 2', 'the larger M', 'the set tried first']);
    expect(names(FALLBACK_ORDER)).toEqual(['the higher row 1 count', 'the lower row 3 rate', 'L nearer 5', 'M nearer 2', 'D1 before D3', 'the larger M', 'the set tried first']);
    expect(names(LOWEST_ROW3_ORDER)[0]).toBe('the lower row 3 rate');
  });

  it('puts a set in the params: d1.k, d1.L, d1.M, the variant, theta_G and the retune record', () => {
    const base = JSON.parse(preregParamsText()) as Record<string, unknown>;
    const set: RetuneSet = { k: 2, L: 7, M: 3, variant: 'D3' };
    const p = paramsWithSet(base, set, 0.0125);
    expect(jsonDiffPaths(base, p)).toEqual(['d1.L', 'd1.M', 'd1.k', 'g.theta_G', 'variant']);
    expect(p).toMatchObject({ d1: { k: 2, L: 7, M: 3 }, g: { theta_G: 0.0125 }, variant: 'D3' });
    // A file that names the variant in d1 too gets the new one there as well (spec 8.4).
    const both = paramsWithSet({ ...base, d1: { ...(base['d1'] as object), variant: 'D1' } }, set, null);
    expect(both).toMatchObject({ d1: { variant: 'D3' }, variant: 'D3', g: base['g'] });
    for (const pass of [true, false]) {
      const t = retuneParams(base, { set, thetaG: theta(0.0125), verdict: graded({ pass }).verdict });
      expect(validateFrozenParams(t)).toEqual([]);
      expect(t.tuned).toEqual({ k: { step: 'retune', criterion_met: pass, rehearsal_step_up: false }, theta_G: { step: 'retune' } });
    }
  });

  it('when the stage A set wins, by PASS or by step 3, --write keeps the stage A file with its own record', () => {
    // Step 3: the stage A set and rung 1's set tie up to the set tried first.
    const step3 = runRetune(STAGE_A, grader({ [setKey(STAGE_A)]: { hits: 9 }, [D1(2, 5, 2)]: { hits: 9 } }));
    expect(step3).toMatchObject({ step: 'row3_at_most_2', decidedBy: 'the set tried first' });
    const pass = runRetune(STAGE_A, grader({ [setKey(STAGE_A)]: { pass: true } }));
    for (const o of [pass, step3]) {
      expect(keepsStageAFile(o)).toBe(true);
      // Byte for byte, so verdict.md of packs B and C prints stage A's "criterion met" for its k.
      expect(chosenParams(o, STAGE_A_PARAMS, STAGE_A_TEXT)).toEqual({ text: STAGE_A_TEXT, stageAFile: true, tuned: { step: 'stage_a', criterionMet: true } });
    }
  });

  it('a set the ladder tried gets a record of step retune: criterion met on PASS on all five rows, not met by step 3', () => {
    const rung2 = runRetune(STAGE_A, grader({ [D1(2, 7, 3)]: { pass: true } }));
    const step3 = runRetune(STAGE_A, grader({ [D1(2, 4, 3)]: { hits: 9 } }));
    expect([rung2.step, step3.step]).toEqual(['rung_2', 'row3_at_most_2']);
    for (const [o, want, met] of [
      [rung2, D1(2, 7, 3), true],
      [step3, D1(2, 4, 3), false],
    ] as const) {
      expect(setKey(o.chosen.set)).toBe(want);
      expect(keepsStageAFile(o)).toBe(false);
      const p = chosenParams(o, STAGE_A_PARAMS, STAGE_A_TEXT);
      expect(p).toMatchObject({ stageAFile: false, tuned: { step: 'retune', criterionMet: met } });
      const value = JSON.parse(p.text) as Record<string, unknown>;
      expect(p.text).toBe(frozenParamsText(value));
      const { k, L, M } = o.chosen.set;
      expect(value).toMatchObject({ d1: { k, L, M }, g: { theta_G: 0.02 }, variant: 'D1' });
    }
  });

  it('says on its TUNED and PARAMS lines what --write keeps, writes or wrote, and what the criterion is', () => {
    const tail = '. Packs B and C print it on the TUNING line of verdict.md';
    expect(tunedLine({ stageAFile: true, tuned: { step: 'stage_a', criterionMet: true } })).toBe(
      `TUNED   tuned.k as stage A wrote it: step stage_a, criterion met; in this record the criterion is stage A's limit of 1.0 fire per active minute in the listening block (PREREG §6.2)${tail}`,
    );
    expect(tunedLine({ stageAFile: false, tuned: { step: 'retune', criterionMet: true } })).toBe(
      `TUNED   tuned.k of the retune: step retune, criterion met; in this record the criterion is PASS on all five rows of pack A (PREREG §11 step 2)${tail}`,
    );
    expect(tunedLine({ stageAFile: false, tuned: { step: 'retune', criterionMet: false } })).toBe(
      `TUNED   tuned.k of the retune: step retune, criterion not met; in this record the criterion is PASS on all five rows of pack A (PREREG §11 step 2), and step 3 chose this set${tail}`,
    );
    const freeze = 'npm run freeze -- gate-retune freezes them before pack B';
    expect(paramsLine({ id: 'gate-a', stageAFile: true, written: false })).toBe(
      'PARAMS  not written: npm run retune -- gate-a --write copies params/frozen.json, which stays as stage A wrote it, to params/retune.json',
    );
    expect(paramsLine({ id: 'gate-a', stageAFile: false, written: false })).toBe(
      'PARAMS  not written: npm run retune -- gate-a --write writes this set to params/frozen.json and its copy params/retune.json',
    );
    expect(paramsLine({ id: 'gate-a', stageAFile: true, written: true })).toBe(`PARAMS  params/frozen.json, as stage A wrote it, and its copy params/retune.json hold this set; ${freeze}`);
    expect(paramsLine({ id: 'gate-a', stageAFile: false, written: true })).toBe(`PARAMS  params/frozen.json and its copy params/retune.json hold this set; ${freeze}`);
  });

  it('names its session report so that no schema of a whole-folder check claims it', () => {
    // core/schemas/registry.ts gives every file named retune.json the params validator (params/retune.json, spec 13.1).
    expect(formatForPath('sessions/gate-a/retune.json')).not.toBeNull();
    expect(formatForPath(`sessions/gate-a/${REPORT_JSON}`)).toBeNull();
    expect(formatForPath(`sessions/gate-a/${REPORT_MD}`)).toBeNull();
  });

  it('parses its command line', () => {
    expect(parseRetuneArgs(['gate-a'])).toEqual({ id: 'gate-a', write: false });
    expect(parseRetuneArgs(['--write', 'gate-a'])).toEqual({ id: 'gate-a', write: true });
    expect(parseRetuneArgs([])).toMatch(/recording id of pack A is required/);
    expect(parseRetuneArgs(['gate-a', 'gate-b'])).toBe('unexpected argument gate-b');
    expect(parseRetuneArgs(['gate-a', '--force'])).toBe('unknown option --force');
  });
});

// ---- npm run retune on synthetic recordings -----------------------------------------------------

let root: string;

beforeAll(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'retune-'));
});

afterAll(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

const PREREG = preregParamsText();
/** PREREG.md of the stand-in repository: the gate-retune check compares its bytes with the tagged ones. */
const PREREG_MD = '# Preregistration (stand-in for the retune test)\n';
const PREREG_COMMIT = 'c'.repeat(40);

interface Env {
  deps: GateDeps;
  out: string[];
  err: string[];
  /** The stand-in repository: PREREG.md, params/ and sessions/. */
  repo: string;
  sessions: string;
  paramsFile: string;
  retuneFile: string;
  /** What git holds under each tag (deps.tagFile): gate-prereg from the start. */
  tags: Map<string, string>;
}

function env(name: string): Env {
  const repo = path.join(root, name);
  const sessions = path.join(repo, 'sessions');
  const paramsFile = path.join(repo, 'params', 'frozen.json');
  fs.mkdirSync(sessions, { recursive: true });
  fs.mkdirSync(path.dirname(paramsFile), { recursive: true });
  fs.writeFileSync(paramsFile, PREREG);
  fs.writeFileSync(path.join(repo, 'PREREG.md'), PREREG_MD);
  const tags = new Map([['gate-prereg', PREREG]]);
  const out: string[] = [];
  const err: string[] = [];
  return {
    out,
    err,
    repo,
    sessions,
    paramsFile,
    retuneFile: path.join(repo, 'params', 'retune.json'),
    tags,
    deps: {
      env: { COPYHOLDER_SESSIONS_DIR: sessions, COPYHOLDER_PARAMS_FILE: paramsFile },
      now: () => new Date('2026-11-14T10:00:00Z'),
      commit: () => 'abc1234',
      log: (l) => out.push(l),
      error: (l) => err.push(l),
      tagFile: (tag) => tags.get(tag) ?? null,
    },
  };
}

/** git as tools/freeze/tags.ts reads it, without git: gate-prereg holds PREREG.md and the prereg params. */
function repoView(e: Env): RepoView {
  const atPrereg: Record<string, string> = { 'PREREG.md': PREREG_MD, 'params/frozen.json': PREREG };
  return {
    dir: e.repo,
    head: 'f'.repeat(40),
    tagCommit: (tag) => (tag === 'gate-prereg' ? { commit: PREREG_COMMIT, where: 'origin', problem: null } : null),
    blobAt: (commit, p) => (commit === PREREG_COMMIT && atPrereg[p] !== undefined ? new TextEncoder().encode(atPrereg[p]) : null),
    resolveCommit: () => null,
    isAncestor: () => true,
    changedPaths: () => [],
  };
}

const read = (file: string): string => fs.readFileSync(file, 'utf8');
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const readJson = (file: string): Record<string, any> => JSON.parse(read(file)) as Record<string, any>;

/**
 * params/retune.json after --write: a copy of params/frozen.json that `npm run freeze -- gate-retune`
 * accepts (tools/freeze/tags.ts), and that the next pack's stage A accepts once the tag holds it
 * (analysis/gate/frozen.ts checkRetune). Returns its text.
 */
function expectFreezable(e: Env): string {
  const frozenText = read(e.paramsFile);
  const retuneText = read(e.retuneFile);
  expect(retuneText).toBe(frozenText);
  const check = checkTag('gate-retune', repoView(e));
  expect(check.problems).toEqual([]);
  expect(check.notes).toEqual([]);
  expect(check.hashes.map((h) => h.what)).toEqual(['params/retune.json', 'params/frozen.json', 'PREREG.md']);
  expect(checkRetune({ frozenText, retuneText, taggedText: retuneText, tag: RETUNE_TAG })).toEqual(JSON.parse(retuneText));
  return retuneText;
}

/**
 * Every file of the session folder whose name core/schemas/registry.ts knows passes its schema, as a
 * check of a whole folder reads it (tests/e2e/integration.spec.ts): the retune report is not one.
 */
function expectFolderValid(dir: string): void {
  const names = fs.readdirSync(dir);
  expect(names).toEqual(expect.arrayContaining([REPORT_JSON, REPORT_MD, 'verdict.json']));
  for (const name of names) {
    if (formatForPath(name) === null) continue;
    expect(validateFileText(name, read(path.join(dir, name))), name).toEqual([]);
  }
}

const inhale = (n: number, extra: Partial<ReplyPlan> = {}): ReplyPlan[] =>
  Array.from({ length: 14 }, (_, i) => (i < n ? { kind: 'inhale', ...extra } : { kind: 'plain' }));

/** A synthetic recording of a full pack with its ledger up to label (synth.ts writes pack A). */
function record(e: Env, o: GateSynthOptions, id = 'gate-a', pack: 'A' | 'B' | 'C' = 'A'): string {
  const dir = writeGateSession(e.sessions, buildGateSynth(o), id);
  if (pack !== 'A') {
    const file = path.join(dir, 'manifest.json');
    fs.writeFileSync(file, `${JSON.stringify({ ...readJson(file), pack, scenario: `gate-${pack}` }, null, 2)}\n`);
  }
  return dir;
}

async function stages(e: Env, id = 'gate-a'): Promise<void> {
  expect(await gate(['--stage', 'A', id], e.deps)).toBe(0);
  expect(await gate(['--stage', 'B', id], e.deps)).toBe(0);
}

/** Five lip openings without a voice in the listening and objection blocks (fallback scenario). */
const LIP_OPENINGS = [80, 110, 140, 170, 200].map((s, i) => ({ fromS: s, toS: s + 1, rise: 0.013 + 0.003 * i }));

describe('npm run retune on synthetic pack A recordings', () => {
  it('step 1: PASS keeps the stage A set; --write makes params/retune.json its copy', async () => {
    const e = env('pass');
    const dir = record(e, { replies: inhale(10) });
    await stages(e);
    const stageA = read(e.paramsFile);
    expect(await retune(['gate-a'], e.deps)).toBe(0);
    const r = readJson(path.join(dir, REPORT_JSON));
    expect(r).toMatchObject({
      schema: 'retune-report/1',
      id: 'gate-a',
      pack: 'A',
      development_data: true,
      verdict: 'PASS',
      step: 'pass',
      ladder: null,
      decided_by: null,
      params_in_place: false,
    });
    expect(r['chosen']).toMatchObject({ set: 1, k: 1.5, L: 5, M: 2, variant: 'D1', stage_a_set: true, stage_a_file: true, params_sha256: sha256Hex(stageA) });
    expect(r['chosen'].tuned).toMatchObject({ step: 'stage_a', criterion_met: true });
    expect(r['stage_a']).toMatchObject({ k: 1.5, L: 5, M: 2, variant: 'D1', theta_G: readJson(e.paramsFile)['g'].theta_G, params_sha256: sha256Hex(stageA) });
    expect(r['candidates']).toHaveLength(1);
    expect(fs.existsSync(e.retuneFile)).toBe(false);
    const md = read(path.join(dir, REPORT_MD)).split('\n');
    expect(md[0]).toBe('RETUNE gate-a pack A | DEVELOPMENT DATA: pack A tunes, packs B and C confirm (PREREG §11)');
    expect(md).toContain('LADDER  not run: pack A passed (PREREG §11 step 1)');
    expect(md).toContain('RULE    step 1: pack A gave PASS on all five rows, so the stage A set stays (PREREG §11)');
    // After PASS --write only copies params/frozen.json; it never rewrites it.
    expect(e.out).toContain('PARAMS  not written: npm run retune -- gate-a --write copies params/frozen.json, which stays as stage A wrote it, to params/retune.json');

    expect(await retune(['gate-a', '--write'], e.deps)).toBe(0);
    expect(read(e.paramsFile)).toBe(stageA);
    expect(read(e.retuneFile)).toBe(stageA);
    expect(readJson(path.join(dir, REPORT_JSON))['params_in_place']).toBe(true);
    expect(e.out).toContain('PARAMS  params/frozen.json, as stage A wrote it, and its copy params/retune.json hold this set; npm run freeze -- gate-retune freezes them before pack B');
    expectFreezable(e);
    // A check of the whole folder still reads pack A's: the report has a name of its own.
    expectFolderValid(dir);
    // Once more: the copy is there and the same, so nothing changes.
    expect(await retune(['gate-a', '--write'], e.deps)).toBe(0);
    expect(read(e.retuneFile)).toBe(stageA);
    expect(e.err).toEqual([]);
  });

  it('step 2: the first rung with PASS on all five rows sets k, L and M; the next pack runs them', async () => {
    const e = env('ladder');
    const plan: GateSynthOptions = { seed: 12, jitter: 0.12, replies: inhale(10, { voiceDelayS: 0 }) };
    const dir = record(e, plan);
    await stages(e);
    const stageAText = read(e.paramsFile);
    const verdictA = readJson(path.join(dir, 'verdict.json'));
    expect(verdictA['verdict']).toBe('BETWEEN');
    expect(verdictA['rows'].lead.outcome).toBe('BETWEEN');

    expect(await retune(['gate-a', '--write'], e.deps)).toBe(0);
    const r = readJson(path.join(dir, REPORT_JSON));
    expect(r).toMatchObject({ step: 'rung_2', ladder: { k: 2, rung_1_k: 2, rung_3_pair: null }, decided_by: 'L nearer 5', params_in_place: true });
    expect(r['chosen']).toMatchObject({ set: 6, k: 2, L: 5, M: 1, variant: 'D1', theta_G: 0.01, stage_a_set: false, stage_a_file: false });
    expect(r['chosen'].tuned).toEqual({ step: 'retune', criterion_met: true, criterion: 'PASS on all five rows of pack A (PREREG §11 step 2)' });
    expect(e.out).toContain('PARAMS  params/frozen.json and its copy params/retune.json hold this set; npm run freeze -- gate-retune freezes them before pack B');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const cands = r['candidates'] as Array<Record<string, any>>;
    expect(cands.map((c) => c['tried'])).toEqual([['stage_a'], ['rung_1', 'rung_2'], ...Array.from({ length: 8 }, () => ['rung_2'])]);
    expect(cands.filter((c) => c['pass_all_five']).map((c) => [c['set'], c['L'], c['M']])).toEqual([
      [3, 4, 1],
      [6, 5, 1],
    ]);
    // The stage A set graded again gives stage B's verdict.json.
    expect(cands[0]!['rows']).toEqual(verdictA['rows']);

    const tuned = readJson(e.paramsFile);
    expect(validateFrozenParams(tuned)).toEqual([]);
    expect(jsonDiffPaths(JSON.parse(stageAText), tuned)).toEqual(['d1.M', 'd1.k', 'tuned.k.step', 'tuned.theta_G.step', 'variant']);
    expect(tuned).toMatchObject({ d1: { k: 2, L: 5, M: 1 }, g: { theta_G: 0.01 }, variant: 'D1' });
    expect(tuned['tuned']).toEqual({ k: { step: 'retune', criterion_met: true, rehearsal_step_up: false }, theta_G: { step: 'retune' } });
    const copy = expectFreezable(e);
    expect(r['chosen'].params_sha256).toBe(sha256Hex(copy));
    expect(e.out).toContain(`retune: next, commit both files and run npm run freeze -- ${RETUNE_TAG}, then push the tag before pack B is recorded (PREREG §11)`);

    // Pack A is spent: on the tuned file, or on another pack, the command refuses.
    expect(await retune(['gate-a'], e.deps)).toBe(1);
    expect(e.err.at(-1)).toMatch(/params\/frozen\.json already holds the tuned set: it equals params\/retune\.json/);

    // The next pack, recorded after the tag: stage A tunes nothing, stage B scores the tuned set.
    e.tags.set(RETUNE_TAG, copy);
    const dirB = record(e, plan, 'gate-b', 'B');
    await stages(e, 'gate-b');
    expect(e.out).toContain(`stage A: params/frozen.json equals params/retune.json (tag ${RETUNE_TAG}); nothing tuned (spec 9.8)`);
    expect(read(e.paramsFile)).toBe(copy);
    const verdictB = readJson(path.join(dirB, 'verdict.json'));
    expect(verdictB).toMatchObject({ pack: 'B', params_sha256: sha256Hex(copy), tuning: { k: 2, criterion_met: true, theta_G: 0.01 } });
    // The same synthetic recording: pack B's rows are the ones the chosen set had on pack A ...
    expect(verdictB['rows']).toEqual(cands[5]!['rows']);
    expect(verdictB['rows'].lead.outcome).toBe('PASS');
    // ... and scored with the stage A file instead (exploratory), pack A's verdict comes back.
    const stageAFile = path.join(e.repo, 'stage-a.json');
    fs.writeFileSync(stageAFile, stageAText);
    expect(await gate(['--stage', 'B', 'gate-b', '--exploratory', '--params', stageAFile], e.deps)).toBe(0);
    expect(readJson(path.join(dirB, 'verdict.exploratory-2.json'))['rows']).toEqual(verdictA['rows']);

    expect(await retune(['gate-b'], e.deps)).toBe(1);
    expect(e.err.at(-1)).toMatch(/the tuning runs on pack A only \(PREREG §11\); gate-b is pack B/);
  });

  it('the next pack grades with the k, L, M and variant the tuned params/frozen.json names', async () => {
    const e = env('next-pack');
    // Breaths jittered by 25% include early ones, on which D3 fires earlier than D1 or alone (PREREG §6.3).
    const plan: GateSynthOptions = { seed: 7, jitter: 0.25, replies: inhale(6) };
    record(e, plan);
    await stages(e);
    // Sets graded on pack A as npm run retune grades them (development data).
    const grade = makeGrader(loadRetune('gate-a', e.deps).ctx);
    const set: RetuneSet = { k: 2, L: 4, M: 3, variant: 'D3' };
    const c = grade(set);
    // Rows 1 to 3 come from the trace detector's run alone (the lips' in-sample rate aside). On this
    // recording L, M and the variant each change them: a stage B that read the default L = 5, M = 2
    // or D1 in place of the file's values would print other rows than the set's.
    const traceRows = (g: Graded): unknown => {
      const r = g.verdict.rows;
      return { hits: r.hits, lead: r.lead, false_holds: { ...r.false_holds, in_sample_lips_per_min: null } };
    };
    for (const other of [{ ...set, L: 5 }, { ...set, M: 2 }, { ...set, variant: 'D1' as const }]) {
      expect(traceRows(grade(other)), setKey(other)).not.toEqual(traceRows(c));
    }

    // The set in params/frozen.json and its copy as --write would put it there, frozen by the tag.
    const text = frozenParamsText(retuneParams(readJson(e.paramsFile), { set, thetaG: c.thetaG, verdict: c.verdict }));
    fs.writeFileSync(e.paramsFile, text);
    fs.writeFileSync(e.retuneFile, text);
    expectFreezable(e);
    e.tags.set(RETUNE_TAG, text);
    record(e, plan, 'gate-c', 'C');
    expect(runStageA({ id: 'gate-c', exploratory: false, deps: e.deps }).retune).toBe(true);
    const b = runStageB({ id: 'gate-c', exploratory: false, deps: e.deps });
    expect(b.score.runs.d1.name).toBe('D3');
    // Pack C is the same synthetic recording: stage B gives it the rows the tuning gave the set on pack A.
    expect(b.verdict.rows).toEqual(c.verdict.rows);
    expect(b.verdict).toMatchObject({
      pack: 'C',
      params_sha256: sha256Hex(text),
      tuning: { k: 2, criterion_met: passesAll(c), theta_G: c.thetaG.thetaG },
      events: c.verdict.events,
      verdict: c.verdict.verdict,
    });
  });

  it('step 3: no rung passes; of the sets with row 3 at most 2 the tie rules choose, each with its own theta_G', async () => {
    const e = env('fallback');
    const plan: GateSynthOptions = { seed: 12, jitter: 0.12, replies: inhale(6), lipOpenings: LIP_OPENINGS };
    const dir = record(e, plan);
    await stages(e);
    const stageAText = read(e.paramsFile);
    expect(await retune(['gate-a', '--write'], e.deps)).toBe(0);
    const r = readJson(path.join(dir, REPORT_JSON));
    expect(r).toMatchObject({ verdict: 'KILL', step: 'row3_at_most_2', ladder: { k: 2, rung_1_k: 2, rung_3_pair: { L: 4, M: 3 } }, decided_by: 'L nearer 5' });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const cands = r['candidates'] as Array<Record<string, any>>;
    expect(cands).toHaveLength(11);
    expect(cands[10]).toMatchObject({ tried: ['rung_3'], k: 2, L: 4, M: 3, variant: 'D3' });
    expect(cands.every((c) => c['pass_all_five'] === false && c['row3_at_most_2'] === true)).toBe(true);
    // Every set has row 1 at 6; three share the lowest row 3, and L nearer 5 takes the stage A set.
    expect(new Set(cands.map((c) => c['rows'].hits.hits))).toEqual(new Set([6]));
    const lowest = Math.min(...cands.map((c) => c['rows'].false_holds.per_min as number));
    expect(cands.filter((c) => c['rows'].false_holds.per_min === lowest).map((c) => c['set'])).toEqual([1, 5, 11]);
    expect(r['chosen']).toMatchObject({ set: 1, k: 2.5, L: 5, M: 2, variant: 'D1', theta_G: 0.02, stage_a_set: true, stage_a_file: true, params_sha256: sha256Hex(stageAText) });
    expect(r['chosen'].tuned).toMatchObject({ step: 'stage_a', criterion_met: true });
    // theta_G by each set's own budget (PREREG §6.4): rung 1's set fires 3 times in the listening block.
    expect(cands[0]!['theta_G_budget']).toMatchObject({ d1_fires: 1, limit: 2, criterion_met: true });
    expect(cands[1]!['theta_G_budget']).toMatchObject({ d1_fires: 3, limit: 3, criterion_met: true });
    expect(cands.map((c) => c['theta_G'])).toEqual([0.02, 0.0175, 0.02, 0.02, 0.02, 0.0175, 0.02, 0.0175, 0.02, 0.02, 0.02]);

    // The stage A set won: params/frozen.json stays as stage A wrote it, its record of stage A's
    // criterion too, and params/retune.json is its copy.
    expect(read(e.paramsFile)).toBe(stageAText);
    expect(read(e.retuneFile)).toBe(stageAText);
    expect(readJson(e.paramsFile)['tuned'].k).toEqual({ step: 'stage_a', criterion_met: true, rehearsal_step_up: false });
    const copy = expectFreezable(e);
    expect(e.out).toContain(`retune: params/frozen.json stays as stage A wrote it; ${e.retuneFile} is its copy`);
    const md = read(path.join(dir, REPORT_MD));
    expect(md).toContain('RULE    step 3: no rung gave PASS on all five rows; of the 11 sets with row 3 at most 2 false holds per active minute, set 1 wins, set apart by L nearer 5 (PREREG §11)');
    expect(md).toContain(`CHOSEN  set 1: k=2.5 L=5 M=2 D1 theta_G=0.0200 | params ${sha256Hex(stageAText).slice(0, 8)}`);
    expect(md).toContain('TUNED   tuned.k as stage A wrote it: step stage_a, criterion met;');
    expect(md).toContain('PARAMS  params/frozen.json, as stage A wrote it, and its copy params/retune.json hold this set; npm run freeze -- gate-retune freezes them before pack B');

    // The next pack prints stage A's "criterion met" for this k, which met stage A's limit.
    e.tags.set(RETUNE_TAG, copy);
    const dirB = record(e, plan, 'gate-b', 'B');
    await stages(e, 'gate-b');
    expect(readJson(path.join(dirB, 'verdict.json'))).toMatchObject({ pack: 'B', params_sha256: sha256Hex(stageAText), tuning: { k: 2.5, criterion_met: true, theta_G: 0.02 } });
    expect(read(path.join(dirB, 'verdict.md'))).toContain('TUNING  k=2.5 (criterion met) | theta_G=0.0200');
  });

  it('step 3 with no set at row 3 at most 2: the lowest row 3 rate, then D1 before D3; nothing written without --write', async () => {
    const e = env('row3');
    const dir = record(e, { replies: inhale(10), inhalesS: [265, 283, 301, 319, 337, 355, 373, 391, 409, 427, 445, 463, 481] });
    await stages(e);
    const stageAText = read(e.paramsFile);
    expect(await retune(['gate-a'], e.deps)).toBe(0);
    const r = readJson(path.join(dir, REPORT_JSON));
    expect(r).toMatchObject({ step: 'lowest_row3', ladder: { k: 1.5, rung_1_k: null, rung_3_pair: { L: 7, M: 3 } }, decided_by: 'D1 before D3', params_in_place: false });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const cands = r['candidates'] as Array<Record<string, any>>;
    expect(cands).toHaveLength(10);
    expect(cands[0]!['tried']).toEqual(['stage_a', 'rung_2']);
    expect(cands.some((c) => c['row3_at_most_2'])).toBe(false);
    expect(r['chosen']).toMatchObject({ set: 9, k: 1.5, L: 7, M: 3, variant: 'D1', stage_a_set: false, stage_a_file: false });
    expect(r['chosen'].tuned).toMatchObject({ step: 'retune', criterion_met: false });
    expect(cands[9]).toMatchObject({ set: 10, L: 7, M: 3, variant: 'D3' });
    expect(cands[9]!['rows'].false_holds.per_min).toBe(cands[8]!['rows'].false_holds.per_min);
    const md = read(path.join(dir, REPORT_MD));
    expect(md).toContain('LADDER  rung 1 none at k=1.5; rung 2 at k=1.5; rung 3 D3 at k=1.5 L=7 M=3');
    expect(md).toContain('TUNED   tuned.k of the retune: step retune, criterion not met;');
    expect(md).toContain('PARAMS  not written: npm run retune -- gate-a --write writes this set to params/frozen.json and its copy params/retune.json');
    expect(read(e.paramsFile)).toBe(stageAText);
    expect(fs.existsSync(e.retuneFile)).toBe(false);
  });

  it('refuses before stage B, on a changed params/frozen.json and on another copy or tag, writing nothing', async () => {
    const e = env('refusals');
    const dir = record(e, { replies: inhale(10) });
    expect(await gate(['--stage', 'A', 'gate-a'], e.deps)).toBe(0);
    expect(await retune(['gate-a', '--write'], e.deps)).toBe(1);
    expect(e.err.at(-1)).toMatch(/has no verdict step: run stage B first/);
    expect(await gate(['--stage', 'B', 'gate-a'], e.deps)).toBe(0);
    const stageA = read(e.paramsFile);

    fs.writeFileSync(e.paramsFile, PREREG);
    expect(await retune(['gate-a', '--write'], e.deps)).toBe(1);
    expect(e.err.at(-1)).toMatch(/params\/frozen\.json changed since stage A/);
    fs.writeFileSync(e.paramsFile, stageA);

    fs.writeFileSync(e.retuneFile, PREREG);
    expect(await retune(['gate-a', '--write'], e.deps)).toBe(1);
    expect(e.err.at(-1)).toMatch(/retune\.json exists and holds another set/);
    expect(read(e.retuneFile)).toBe(PREREG);
    fs.rmSync(e.retuneFile);

    e.tags.set(RETUNE_TAG, PREREG);
    expect(await retune(['gate-a', '--write'], e.deps)).toBe(1);
    expect(e.err.at(-1)).toMatch(/frozen under the tag gate-retune with another set/);
    expect(fs.existsSync(e.retuneFile)).toBe(false);
    expect(read(e.paramsFile)).toBe(stageA);
    expect(fs.existsSync(path.join(dir, REPORT_JSON))).toBe(false);

    expect(await retune([], e.deps)).toBe(2);
    expect(e.err.at(-1)).toMatch(/usage: npm run retune -- <id> \[--write\]/);
  });

  // PREREG.md section 11: a pack A run no SDK measured is a rehearsal. retune reaches the refusal
  // through gateLayout, as confirm does, so the refusal names no command but the ones to run next.
  it('refuses a pack A run with the mock tap, naming no other command, and writes nothing', async () => {
    const e = env('rehearsal');
    const dir = record(e, { replies: inhale(10) });
    const file = path.join(dir, 'manifest.json');
    fs.writeFileSync(file, `${JSON.stringify({ ...readJson(file), tap: 'mock', sdk: null }, null, 2)}\n`);
    const before = fs.readdirSync(dir).sort();
    expect(await retune(['gate-a', '--write'], e.deps)).toBe(1);
    expect(e.err).toEqual([
      'retune refused: this recording is a rehearsal, not a recording of pack A: manifest.json says tap: "mock" (the mock tap made up the chest trace), so no SDK measured the chest (PREREG.md section 11). It played the planted errors of pack A (its objection block, from 4:15, began), and the participant does not hear a pack before it is recorded (PREREG.md section 7.1): keep this folder as the record of that, and do not record pack A with a participant who heard this run.',
    ]);
    expect(e.err.join('\n')).not.toMatch(/analyze:gate|Run /);
    expect(fs.readdirSync(dir).sort()).toEqual(before);
    expect(read(e.paramsFile)).toBe(PREREG);
    expect(fs.existsSync(e.retuneFile)).toBe(false);
  });
});
