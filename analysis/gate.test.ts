// analyze:gate end to end on synthetic day-one recordings written as session folders (spec 8.5, 9.5-9.7).

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { sniffLag, sniffReading } from '../core/clock/index.ts';
import { parseDetectorIn, type DetectorInput } from '../core/detector.ts';
import { exampleQuickcheck } from '../core/schemas/examples.ts';
import {
  appendLedger,
  findSteps,
  isNoteLine,
  NOTE_STEP,
  parseJson,
  toJsonText,
  toJsonlText,
  validateFrozenParams,
  validateVerdict,
  verifyLedger,
  type CalibLrt,
  type ClockReport,
  type LedgerLine,
  type Quickcheck,
} from '../core/schemas/index.ts';
import { main, parseGateArgs } from './gate.ts';
import type { GateDeps } from './gate/deps.ts';
import { calibSniffLagBlock, recountSniffLag } from './clocks/compute.ts';
import { coreLrtOf } from './gate/common.ts';
import { sniffOnsets, tracePacketsOf } from './gate/sniffs.ts';
import { stageAView } from './gate/stage-a.ts';
import { SYNTH_CUES_MS, SYNTH_OBJECTIONS_S, buildGateSynth, preregParamsText, writeGateSession, type GateSynth, type ReplyPlan } from './gate/synth.ts';
import { arrivalsBefore, detectorInBefore } from './gate/view.ts';
import { loadSession } from './lib/session.ts';
import { sha256Hex } from './lib/ledger.ts';
import { gateSteps } from './lib/steps.ts';
import { encodeStereoFloatWav, readStereoFloatWav } from './lib/wav.ts';

let root: string;

beforeAll(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'analyze-gate-'));
});

afterAll(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

interface Env {
  deps: GateDeps;
  out: string[];
  err: string[];
  sessions: string;
  paramsFile: string;
}

const PREREG = preregParamsText();

/** A repository with params/frozen.json as frozen under gate-prereg (spec 8.4), and its tag. */
function env(name: string, o: { prereg?: boolean; tagged?: string | null } = {}): Env {
  const base = path.join(root, name);
  const sessions = path.join(base, 'sessions');
  const paramsFile = path.join(base, 'params', 'frozen.json');
  fs.mkdirSync(sessions, { recursive: true });
  fs.mkdirSync(path.dirname(paramsFile), { recursive: true });
  if (o.prereg ?? true) fs.writeFileSync(paramsFile, PREREG);
  const tagged = o.tagged === undefined ? PREREG : o.tagged;
  const out: string[] = [];
  const err: string[] = [];
  return {
    out,
    err,
    sessions,
    paramsFile,
    deps: {
      env: { COPYHOLDER_SESSIONS_DIR: sessions, COPYHOLDER_PARAMS_FILE: paramsFile },
      now: () => new Date('2026-11-14T10:00:00Z'),
      commit: () => 'abc1234',
      log: (l) => out.push(l),
      error: (l) => err.push(l),
      tagFile: (tag) => (tag === 'gate-prereg' ? tagged : null),
    },
  };
}

const PASS_PLAN: ReplyPlan[] = Array.from({ length: 14 }, (_, i) => (i < 10 ? { kind: 'inhale' } : { kind: 'plain' }));
const CUES_S = SYNTH_CUES_MS.map((ms) => SYNTH_OBJECTIONS_S + ms / 1000);

function ledgerLines(dir: string): string[] {
  return fs
    .readFileSync(path.join(dir, 'ledger.jsonl'), 'utf8')
    .split('\n')
    .filter((l) => l.length > 0);
}

function ledgerSteps(dir: string): string[] {
  return ledgerLines(dir).map((l) => {
    const o = JSON.parse(l) as { step: string; exploratory: boolean };
    return o.exploratory ? `${o.step}*` : o.step;
  });
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function readVerdict(dir: string, name = 'verdict.json'): Record<string, any> {
  const text = fs.readFileSync(path.join(dir, name), 'utf8');
  const v = JSON.parse(text) as Record<string, any>;
  expect(validateVerdict(v)).toEqual([]);
  return v;
}

async function stages(e: Env, id = 'gate-a'): Promise<void> {
  expect(await main(['--stage', 'A', id], e.deps)).toBe(0);
  expect(await main(['--stage', 'B', id], e.deps)).toBe(0);
}

/** What a refused run must leave as it was: params/frozen.json, the ledger and the session folder. */
function snapshot(e: Env, dir: string): { params: string | null; ledger: string; files: string[] } {
  return {
    params: fs.existsSync(e.paramsFile) ? fs.readFileSync(e.paramsFile, 'utf8') : null,
    ledger: fs.readFileSync(path.join(dir, 'ledger.jsonl'), 'utf8'),
    files: fs.readdirSync(dir).sort(),
  };
}

async function refused(e: Env, dir: string, argv: string[], why: RegExp): Promise<void> {
  const before = snapshot(e, dir);
  e.err.length = 0;
  expect(await main(argv, e.deps)).toBe(1);
  expect(e.err.join('\n')).toMatch(why);
  expect(snapshot(e, dir)).toEqual(before);
}

/** Rebuilds ledger.jsonl from its records after `edit` (null drops the line): a forged journal, for tests only. */
function reforgeLedger(dir: string, edit: (r: LedgerLine) => LedgerLine | null): void {
  const hash = (t: string): string => sha256Hex(t);
  const lines: string[] = [];
  for (const l of ledgerLines(dir)) {
    const r = edit(JSON.parse(l) as LedgerLine);
    if (r === null) continue;
    lines.push(
      isNoteLine(r)
        ? appendLedger(lines, NOTE_STEP, { utc: r.utc, commit: r.commit, what: r.what, ...(r.detail === undefined ? {} : { detail: r.detail }) }, hash, { kind: 'gate' })
        : appendLedger(lines, r.step, { utc: r.utc, commit: r.commit, out_sha256: r.out_sha256, exploratory: r.exploratory }, hash, { kind: 'gate' }),
    );
  }
  fs.writeFileSync(path.join(dir, 'ledger.jsonl'), `${lines.join('\n')}\n`);
}

/** Replaces a file an earlier step wrote, and its hash in every step line that lists it (forged, for tests only). */
function replaceRecorded(dir: string, file: string, text: string): void {
  fs.writeFileSync(path.join(dir, file), text);
  const sha = sha256Hex(text);
  reforgeLedger(dir, (r) => (isNoteLine(r) || r.out_sha256[file] === undefined ? r : { ...r, out_sha256: { ...r.out_sha256, [file]: sha } }));
}

/** quickcheck.json of a recording with microphone processing on: RE-RECORD NOW, a technical failure (spec 9.4). */
function reRecordQuickcheck(): Quickcheck {
  const q = exampleQuickcheck();
  return { ...q, result: 'RE-RECORD NOW', reasons: ['microphone processing not off'], technical: true, checks: q.checks.map((c) => (c.name === 'mic_flags_off' ? { ...c, ok: false } : c)) };
}

/** clock_report.json with the audio (microphone processing on) or the trace (two SDK errors) not valid (spec 7.12). */
function voidClockReport(r: ClockReport, what: 'audio' | 'trace'): ClockReport {
  return what === 'audio' ? { ...r, audio_valid: false, hard: { ...r.hard, mic_flags_off: false } } : { ...r, trace_valid: false, hard: { ...r.hard, sdk_errors: 2 } };
}

/** Number of detector_in.jsonl lines before the cut. */
function prefixLength(s: GateSynth): number {
  return detectorInBefore(s.inputs, arrivalsBefore(s.stamps, s.nCut), s.nCut).length;
}

/** Replaces line `i` (0-based) of a session file. */
function breakLine(dir: string, file: string, i: number, text = '{"k":"batch","seq":'): void {
  const lines = fs.readFileSync(path.join(dir, file), 'utf8').split('\n');
  lines[i] = text;
  fs.writeFileSync(path.join(dir, file), lines.join('\n'));
}

describe('analyze:gate on a recording where D1 leads the voice (spec 9.6)', () => {
  let e: Env;
  let dir: string;

  beforeAll(async () => {
    e = env('pass');
    dir = writeGateSession(e.sessions, buildGateSynth({ replies: PASS_PLAN }));
    await stages(e);
  });

  it('stage A writes the gate-prereg params with k, theta_G and tuned, and puts their hash in the ledger', () => {
    const text = fs.readFileSync(e.paramsFile, 'utf8');
    const frozen = JSON.parse(text) as Record<string, any>;
    expect(validateFrozenParams(frozen)).toEqual([]);
    expect(frozen['d1']['k']).toBe(1.5);
    expect(frozen['g']['theta_G']).toBe(0.01);
    expect(frozen['tuned']).toEqual({ k: { step: 'stage_a', criterion_met: true, rehearsal_step_up: false }, theta_G: { step: 'stage_a' } });
    // Everything else is the file frozen under gate-prereg (spec 8.4).
    const prereg = JSON.parse(PREREG) as Record<string, any>;
    const { tuned: _tuned, ...rest } = frozen;
    expect({ ...rest, d1: { ...frozen['d1'], k: undefined }, g: { ...frozen['g'], theta_G: undefined } }).toEqual({
      ...prereg,
      d1: { ...prereg['d1'], k: undefined },
      g: { ...prereg['g'], theta_G: undefined },
    });
    const v = verifyLedger(ledgerLines(dir), (t) => sha256Hex(t), { kind: 'gate' });
    expect(v.errors).toEqual([]);
    expect(findSteps(v.records, 'stage_a')[0]!.out_sha256).toEqual({ 'params/frozen.json': sha256Hex(text) });
  });

  it('passes all five rows: 10 of 14 hits, a lead near 300 ms, few false holds, the sniff lag of calib.json, chest over lips', () => {
    const v = readVerdict(dir);
    expect(v['events']).toEqual({ cued: 14, valid: 14, armed: 14, audible_inbreath: 10 });
    expect(v['rows']['hits']).toMatchObject({ outcome: 'PASS', hits: 10, armed_hits: 10, leads_0_50: 0 });
    expect(v['rows']['lead']['outcome']).toBe('PASS');
    expect(v['rows']['lead']['median_hits_ms']).toBeGreaterThan(250);
    expect(v['rows']['lead']['median_hits_ms']).toBeLessThan(350);
    const fh = v['rows']['false_holds'];
    expect(fh['outcome']).toBe('PASS');
    expect(fh['per_min']).toBeLessThanOrEqual(2);
    expect(fh['armed_min']).toBeGreaterThan(2);
    expect(fh['in_sample_chest_per_min']).toBe(0);
    expect(fh['in_sample_lips_per_min']).toBe(0);
    expect(v['rows']['sniff_lag']).toEqual({ outcome: 'PASS', lo_median_ms: 118.5, hi_median_ms: 142, median_over_ms: null, n: 5, no_arrival: 0, best_case_ms: null, d1_on_sniffs_ms: null });
    const cl = v['rows']['chest_vs_lips'];
    expect(cl).toMatchObject({ outcome: 'PASS', wins: 10, losses: 4, ties: 0, both_before_n: 10, lips_false_per_min: 0, exploratory_equal_rate: { wins: 10, losses: 4 } });
    expect(cl['chest_false_per_min']).toBe(fh['per_min']);
    expect(cl['lead_diff_ms_median']).toBeGreaterThan(100);
    expect(v['tuning']).toEqual({ k: 1.5, criterion_met: true, theta_G: 0.01 });
    expect(v['clock']).toEqual({ L_rt_ms: [23.4, 23.6], diff_ms: 0.2, rule: 'mean', onset_p90_ms: 4 });
    expect(v['misses']).toEqual({ no_inbreath: 4, inbreath_audible: 0 });
    expect(v['other']).toEqual({ talking_flag_hits: 0, head_motion_hits: 0 });
    expect(v['manual_changes']).toEqual([]);
    expect(v['verdict']).toBe('PASS');
    expect(v['run']).toBe(1);
    expect(v['exploratory']).toBe(false);
    expect(v['params_sha256']).toBe(sha256Hex(fs.readFileSync(e.paramsFile, 'utf8')));
  });

  it('writes verdict.md in the layout of spec 9.7', () => {
    const md = fs.readFileSync(path.join(dir, 'verdict.md'), 'utf8').split('\n');
    expect(md[0]).toMatch(/^GATE VERDICT gate-a pack A \| stage B run 1 of 1 \| params [0-9a-f]{8}$/);
    expect(md[1]).toBe('CLOCK   L_rt A 23.4 / B 23.6 ms, diff 0.2 ms | onset P90 |auto-manual| 4.0 ms');
    expect(md[2]).toBe('TUNING  k=1.5 (criterion met) | theta_G=0.0100 | listening block only');
    expect(md[3]).toBe('EVENTS  14 cued, 14 valid, 14 armed, 10 audible in-breath');
    expect(md[4]).toBe(`1 HITS         ${'10 of 14 valid (10 of 14 armed)'.padEnd(38)} PASS`);
    expect(md[5]).toBe('               leads 0-50 ms: 0');
    for (const [i, label] of [[6, '2 LEAD         '], [8, '3 FALSE HOLDS  '], [12, '5 CHEST v LIPS ']] as const) {
      expect(md[i]!.slice(0, 15)).toBe(label);
      expect(md[i]!.slice(54)).toBe('PASS');
    }
    // This calib.json lag is fixed, not measured on the recording, which has no sniffs: the recount
    // differs, so row 4 is graded on calib.json, and n and the count are calib.json's (PREREG §4).
    expect(md[10]).toBe(`4 SNIFF LAG    ${'median [118.5, 142.0] ms, n=5, 0 without arrival'.padEnd(38)} PASS`);
    expect(md[11]).toBe('               best case n/a ms; D1 on sniffs n/a ms');
    expect(e.out).toContain(
      'note: row 4: the recount of the sniff lag gives n=0, 0 without arrival, median [null, null] ms, but calib.json holds n=5, 0 without arrival, median [118.5, 142.0] ms: row 4 is graded on calib.json as the clocks step wrote it, to 0.1 ms (PREREG §4)',
    );
    expect(md[12]).toBe(`5 CHEST v LIPS ${'wins 10:4, ties 0'.padEnd(38)} PASS`);
    expect(md[15]).toBe('               exploratory, lips at the chest rate: wins 10:4');
    expect(md[16]).toBe('MISSES  no audible in-breath 4 | in-breath audible 0');
    expect(md[17]).toBe('OTHER   talking flag 0 hits | head motion 0 hits (descriptive)');
    expect(md[18]).toBe('MANUAL  lines that change with manual onsets: none');
    expect(md[19]).toBe('VERDICT PASS');
    expect(md).toHaveLength(21); // 20 lines and the final newline
  });

  it('prints A250 paired with both false rates, and A100 and A500 as descriptive lines (spec 4.4, 7.5)', () => {
    const notes = e.out.filter((l) => l.startsWith('note: A'));
    expect(notes).toEqual([
      expect.stringMatching(/^note: A100: stops before voice on 0 of 14 valid; lead -131\.5 ms on each of its 14 stops; 0\.0 false stops\/min by construction \(descriptive\)$/),
      expect.stringMatching(/^note: A250: chest wins 10:4, ties 0; false stops\/min: chest \d+\.\d, A250 0\.0 by construction/),
      expect.stringMatching(/^note: A500: stops before voice on 0 of 14 valid; lead -531\.5 ms/),
    ]);
    expect(e.out.join('\n')).toMatch(/note: exploratory line: lips at theta_G=0\.0100 fire 0\.0\/min against the chest's \d+\.\d\/min; chest wins 10:4/);
  });

  it('writes stage_b and verdict in the same run, and refuses a second stage B without --exploratory', async () => {
    // The note before label is the label_order note with the labels hash (analysis/label.ts).
    expect(ledgerSteps(dir)).toEqual(['record', 'quickcheck', 'clocks', 'onsets', 'note', 'label', 'stage_a', 'stage_b', 'verdict']);
    const before = fs.readFileSync(path.join(dir, 'verdict.json'), 'utf8');
    e.err.length = 0;
    expect(await main(['--stage', 'B', 'gate-a'], e.deps)).toBe(1);
    expect(e.err.join('\n')).toMatch(/--exploratory/);
    expect(ledgerSteps(dir)).toHaveLength(9);
    expect(await main(['--stage', 'A', 'gate-a'], e.deps)).toBe(1);

    e.out.length = 0;
    expect(await main(['--stage', 'B', 'gate-a', '--exploratory'], e.deps)).toBe(0);
    expect(fs.readFileSync(path.join(dir, 'verdict.json'), 'utf8')).toBe(before);
    const ex = readVerdict(dir, 'verdict.exploratory-2.json');
    expect(ex['run']).toBe(2);
    expect(ex['exploratory']).toBe(true);
    const md = fs.readFileSync(path.join(dir, 'verdict.exploratory-2.md'), 'utf8');
    expect(md.split('\n')[0]).toMatch(/run 2 of 2 \| params [0-9a-f]{8} \| EXPLORATORY$/);
    expect(md).toMatch(/^VERDICT .*EXPLORATORY/m);
    expect(ledgerSteps(dir).slice(9)).toEqual(['stage_b*', 'verdict*']);
    // Every console line of an exploratory run is marked (spec 9.5).
    expect(e.out.length).toBeGreaterThan(20);
    expect(e.out.filter((l) => !l.startsWith('EXPLORATORY stage B run 2: '))).toEqual([]);
  });

  it('an exploratory stage A writes a marked copy and leaves params/frozen.json alone', async () => {
    const frozenBefore = fs.readFileSync(e.paramsFile, 'utf8');
    e.out.length = 0;
    expect(await main(['--stage', 'A', 'gate-a', '--exploratory'], e.deps)).toBe(0);
    expect(fs.readFileSync(e.paramsFile, 'utf8')).toBe(frozenBefore);
    const copyFile = path.join(dir, 'frozen.exploratory-2.json');
    const copy = fs.readFileSync(copyFile, 'utf8');
    expect(copy).toBe(frozenBefore); // the same recording before 4:15 gives the same params
    expect(e.out.filter((l) => !l.startsWith('EXPLORATORY stage A run 2: '))).toEqual([]);
    expect(ledgerSteps(dir).slice(11)).toEqual(['stage_a*']);
    expect((JSON.parse(ledgerLines(dir)[11]!) as { out_sha256: Record<string, string> }).out_sha256).toEqual({ 'frozen.exploratory-2.json': sha256Hex(copy) });

    // A later exploratory stage B may score that copy; the verdict files stay as they were.
    const verdictBefore = fs.readFileSync(path.join(dir, 'verdict.json'), 'utf8');
    expect(await main(['--stage', 'B', 'gate-a', '--exploratory', '--params', copyFile], e.deps)).toBe(0);
    expect(fs.readFileSync(path.join(dir, 'verdict.json'), 'utf8')).toBe(verdictBefore);
    expect(readVerdict(dir, 'verdict.exploratory-3.json')['run']).toBe(3);
    expect(ledgerSteps(dir).slice(12)).toEqual(['stage_b*', 'verdict*']);
    expect(verifyLedger(ledgerLines(dir), (t) => sha256Hex(t), { kind: 'gate' }).ok).toBe(true);
  });

  it('refuses params without the tuned block stage A writes (spec 8.4)', async () => {
    const frozen = JSON.parse(fs.readFileSync(e.paramsFile, 'utf8')) as Record<string, unknown>;
    delete frozen['tuned'];
    const file = path.join(root, 'pass', 'untuned.json');
    fs.writeFileSync(file, JSON.stringify(frozen));
    await refused(e, dir, ['--stage', 'B', 'gate-a', '--exploratory', '--params', file], /untuned\.json has no tuned\.k\.criterion_met/);
  });
});

describe('analyze:gate verdicts (spec 9.6)', () => {
  it('reads KILL when no objection gets a stop before the voice', async () => {
    const e = env('kill');
    const dir = writeGateSession(e.sessions, buildGateSynth({ replies: Array.from({ length: 14 }, () => ({ kind: 'plain' as const })) }));
    await stages(e);
    const v = readVerdict(dir);
    expect(v['rows']['hits']).toMatchObject({ outcome: 'KILL', hits: 0 });
    expect(v['rows']['lead']).toMatchObject({ outcome: 'KILL', median_hits_ms: null });
    expect(v['verdict']).toBe('KILL');
    expect(fs.readFileSync(path.join(dir, 'verdict.md'), 'utf8')).toMatch(/\nVERDICT KILL\n$/);
  });

  it('reads KILL on row 5 when the lips win more often than the chest', async () => {
    const e = env('lips');
    const replies: ReplyPlan[] = Array.from({ length: 14 }, (_, i) => (i < 9 ? { kind: 'inhale', lipLeadS: 0.7 } : { kind: 'plain', lipLeadS: 0.7 }));
    const dir = writeGateSession(e.sessions, buildGateSynth({ replies }));
    await stages(e);
    const v = readVerdict(dir);
    expect(v['rows']['hits']['outcome']).toBe('PASS');
    const row = v['rows']['chest_vs_lips'];
    expect(row['losses']).toBeGreaterThan(row['wins']);
    expect(row['outcome']).toBe('KILL');
    expect(v['verdict']).toBe('KILL');
  });

  it('reads NOT EVALUABLE with 11 valid objections; the onset P90 is the speech-only one of clock_report.json', async () => {
    const e = env('nev');
    // The cough's hand mark lies 300 ms off: label leaves non-speech out of the P90 (spec 6.3).
    const replies: ReplyPlan[] = Array.from({ length: 14 }, (_, i) =>
      i < 11 ? { kind: 'inhale' } : i === 11 ? { kind: 'none' } : i === 12 ? { kind: 'cough', manualShiftMs: 300 } : { kind: 'late' },
    );
    const synth = buildGateSynth({ replies });
    expect(synth.clockReport.onset?.p90_abs_auto_minus_manual_ms).toBe(4);
    const dir = writeGateSession(e.sessions, synth);
    await stages(e);
    const v = readVerdict(dir);
    expect(v['events']['valid']).toBe(11);
    expect(v['verdict']).toBe('NOT EVALUABLE');
    expect(v['clock']['onset_p90_ms']).toBe(4);
    for (const r of ['hits', 'lead', 'false_holds', 'sniff_lag', 'chest_vs_lips']) expect(v['rows'][r]['outcome']).toBeNull();
    expect(e.out.join('\n')).toMatch(/cue 12 has no valid objection: no reply/);
    expect(e.out.join('\n')).toMatch(/cue 13 has no valid objection: the first reply is non-speech \(cough\)/);
    expect(e.out.join('\n')).toMatch(/cue 14 has no valid objection: the voice began more than 10 s after the cue/);
    expect(fs.readFileSync(path.join(dir, 'verdict.md'), 'utf8')).toMatch(/\nVERDICT NOT EVALUABLE\n$/);
  });

  it('reads BETWEEN on a row whose outcome changes on the manual onsets (spec 9.6)', async () => {
    const e = env('manual');
    // Hand marks 150 ms before the automatic onsets of the hits: the lead row falls into 100-199 ms.
    const replies: ReplyPlan[] = PASS_PLAN.map((r) => (r.kind === 'inhale' ? { ...r, manualShiftMs: -150 } : r));
    const dir = writeGateSession(e.sessions, buildGateSynth({ replies }));
    await stages(e);
    const v = readVerdict(dir);
    expect(v['rows']['lead']['median_hits_ms']).toBeGreaterThan(250); // the automatic onsets alone would PASS
    expect(v['rows']['lead']['outcome']).toBe('BETWEEN');
    expect(v['rows']['hits']['outcome']).toBe('PASS');
    expect(v['manual_changes']).toEqual(['lead']);
    expect(v['verdict']).toBe('BETWEEN');
    expect(v['clock']['onset_p90_ms']).toBe(150);
    expect(fs.readFileSync(path.join(dir, 'verdict.md'), 'utf8')).toMatch(/\nMANUAL  lines that change with manual onsets: 2 LEAD\nVERDICT BETWEEN\n$/);
  });
});

describe('stage A tuning (spec 7.4, 7.5)', () => {
  it('raises k until D1 fires at most once per active minute, and theta_G until G keeps within its budget', async () => {
    const e = env('tune');
    // Breaths that vary from one to the next make D1 fire at k 1.5 and 2.0; lips that part in the
    // listening block make G fire up to theta_G 0.0175.
    const lipOpenings = [80, 110, 140, 170, 200].map((t) => ({ fromS: t, toS: t + 1, rise: 0.019 }));
    const dir = writeGateSession(e.sessions, buildGateSynth({ replies: PASS_PLAN, seed: 12, jitter: 0.12, lipOpenings }));
    await stages(e);
    expect(e.out).toContain('stage A: k=2.5 (criterion met), listening block only');
    expect(e.out.filter((l) => /^stage A: k=\d\.\d \d+ fires/.test(l)).map((l) => /(\d+) fires/.exec(l)![1])).toEqual(['3', '3', '1', '1', '1']);
    const frozen = JSON.parse(fs.readFileSync(e.paramsFile, 'utf8')) as Record<string, any>;
    expect(frozen['d1']['k']).toBe(2.5);
    expect(frozen['g']['theta_G']).toBe(0.02);
    expect(readVerdict(dir)['tuning']).toEqual({ k: 2.5, criterion_met: true, theta_G: 0.02 });
    expect(fs.readFileSync(path.join(dir, 'verdict.md'), 'utf8')).toMatch(/\nTUNING  k=2\.5 \(criterion met\) \| theta_G=0\.0200 \| listening block only\n/);
  });

  it('takes k 3.5 "criterion not met" when every k fires too often, and stage B prints it from the params (spec 9.6)', async () => {
    const e = env('tune-not-met');
    const dir = writeGateSession(e.sessions, buildGateSynth({ replies: PASS_PLAN, inhalesS: [70, 95, 120, 145, 170, 195, 220] }));
    await stages(e);
    const frozen = JSON.parse(fs.readFileSync(e.paramsFile, 'utf8')) as Record<string, any>;
    expect(frozen['d1']['k']).toBe(3.5);
    expect(frozen['tuned']['k']['criterion_met']).toBe(false);
    expect(readVerdict(dir)['tuning']['criterion_met']).toBe(false);
    expect(fs.readFileSync(path.join(dir, 'verdict.md'), 'utf8')).toMatch(/\nTUNING  k=3\.5 \(criterion not met\) \|/);
  });
});

describe('rival G and the reset flag of samples.jsonl (spec 7.5, 8.1)', () => {
  // Lips that part 0.7 s before every voice beat the chest, unless a landmark reset 0.2 s before
  // the opening makes G build its baseline anew with the lips already open.
  const replies: ReplyPlan[] = Array.from({ length: 14 }, (_, i) => (i < 9 ? { kind: 'inhale', lipLeadS: 0.7 } : { kind: 'plain', lipLeadS: 0.7 }));

  it('silences G after a reset frame, and not after a packet without a frame', async () => {
    const before = buildGateSynth({ replies }).truth.map((t) => t.voiceS! - 0.9);
    const reset = env('g-reset');
    const dirReset = writeGateSession(reset.sessions, buildGateSynth({ replies, resetsAtS: before }));
    await stages(reset);
    const noFrame = env('g-noframe');
    const dirNoFrame = writeGateSession(noFrame.sessions, buildGateSynth({ replies, noFrameAtS: before }));
    await stages(noFrame);

    expect(readVerdict(dirReset)['rows']['chest_vs_lips']).toMatchObject({ outcome: 'PASS', losses: 0 });
    expect(readVerdict(dirNoFrame)['rows']['chest_vs_lips']).toMatchObject({ outcome: 'KILL', wins: 0, losses: 14 });
    expect(reset.out.join('\n')).not.toMatch(/note: G:/);
    expect(noFrame.out.join('\n')).toMatch(/note: G: 14 packets without a landmark frame carry g null; samples\.jsonl tells them from the 0 reset frames/);
  });
});

describe('descriptive lines (spec 7.5, 9.7)', () => {
  it('prints n/a for the equal-rate line when no theta_G brings the lips to the chest rate, and leaves OTHER out without hm', async () => {
    const e = env('descriptive');
    // Lips part for 1 s between cues, with no voice after: G fires falsely at every theta_G of the grid.
    const lipOpenings = CUES_S.slice(0, 8).map((c) => ({ fromS: c + 10, toS: c + 11, rise: 0.08 }));
    const dir = writeGateSession(e.sessions, buildGateSynth({ replies: PASS_PLAN, lipOpenings, noHeadMotion: true }));
    await stages(e);
    const v = readVerdict(dir);
    expect(v['rows']['chest_vs_lips']['exploratory_equal_rate']).toBeNull();
    expect(v['rows']['chest_vs_lips']['lips_false_per_min']).toBeGreaterThan(v['rows']['chest_vs_lips']['chest_false_per_min']);
    expect(v['other']).toBeNull();
    const md = fs.readFileSync(path.join(dir, 'verdict.md'), 'utf8').split('\n');
    expect(md[15]).toBe('               exploratory, lips at the chest rate: wins n/a');
    expect(md[17]).toBe('OTHER   not computed (descriptive)');
    const out = e.out.join('\n');
    expect(out).toMatch(/note: exploratory line: no theta_G of the grid brings the lips down to the chest's \d+\.\d\/min \(\d+\.\d\/min at 0\.0600\): wins n\/a/);
    expect(out).toMatch(/note: OTHER not computed: no head-motion threshold \(the listening block has no hm values\); talking flag 0 hits/);
  });
});

describe('row 4 on recorded sniffs (spec 6.3, 9.6)', () => {
  it('finds the sniff sounds, reads the lag clocks measured, and adds the best case and D1 on sniffs', async () => {
    const e = env('sniffs');
    const synth = buildGateSynth({ replies: PASS_PLAN, sniffs: true, sniffLag: 'measured' });
    const dir = writeGateSession(e.sessions, synth);
    const found = sniffOnsets(loadSession('gate-a', { env: e.deps.env }), gateSteps('A').sniffs);
    expect(found).toHaveLength(5);
    found.forEach((n, i) => expect(Math.abs(n - synth.sniffSoundN[i]!)).toBeLessThan(10 * 48)); // within 10 ms
    await stages(e);
    // calib.json as the clocks step writes it; the outcome follows the medians before rounding.
    const clocks = synth.sniffClocks!.lag!;
    const lag = synth.calib['sniff_lag_ms'] as { n: number; no_arrival: number; lo_median: number; hi_median: number; median_over_ms: null };
    expect(lag).toEqual(calibSniffLagBlock(clocks));
    expect([clocks.n, clocks.noArrival, clocks.reading]).toEqual([5, 0, sniffReading(clocks.loMedianMs!, clocks.hiMedianMs!)]);
    const row = readVerdict(dir)['rows']['sniff_lag'];
    expect(row).toMatchObject({ outcome: clocks.reading, lo_median_ms: lag.lo_median, hi_median_ms: lag.hi_median, median_over_ms: null, n: 5, no_arrival: 0 });
    expect(row['best_case_ms']).toBeGreaterThan(0);
    expect(row['best_case_ms']).toBeLessThanOrEqual(row['lo_median_ms']);
    expect(row['d1_on_sniffs_ms']).toBeGreaterThan(0);
    expect(row['d1_on_sniffs_ms']).toBeLessThan(2000);
    // All five arrived: PREREG §4 prints the count of those without an arrival beside n.
    expect(fs.readFileSync(path.join(dir, 'verdict.md'), 'utf8')).toMatch(/\n4 SNIFF LAG {4}median \[\d+\.\d, \d+\.\d\] ms, n=5, 0 without arrival /);
    expect(e.out.join('\n')).not.toMatch(/note: row 4/);
  });

  it('counts sniffs whose trace never arrived and ranks them above every measured lag (PREREG §4)', async () => {
    const e = env('sniffs-some-lost');
    const synth = buildGateSynth({ replies: PASS_PLAN, sniffs: true, sniffLag: 'measured', sniffsNotArrived: [1, 3] });
    const clocks = synth.sniffClocks!.lag!;
    expect([clocks.n, clocks.noArrival, clocks.medianNotArrived]).toEqual([5, 2, false]);
    expect(clocks.sniffs.map((s) => s.arrived)).toEqual([true, false, true, false, true]);
    // Two of five above every measured lag: the median is the largest of the three measured.
    expect(clocks.loMedianMs).toBe(Math.max(...clocks.sniffs.filter((s) => s.arrived).map((s) => s.loMs!)));
    const lag = synth.calib['sniff_lag_ms'] as { n: number; no_arrival: number; lo_median: number; hi_median: number; median_over_ms: null };
    expect(lag).toEqual(calibSniffLagBlock(clocks));
    expect(lag.no_arrival).toBe(2);
    const dir = writeGateSession(e.sessions, synth);
    await stages(e);
    const row = readVerdict(dir)['rows']['sniff_lag'];
    // verdict.json copies n and the count from calib.json (PREREG §4).
    expect(row).toMatchObject({ outcome: clocks.reading, lo_median_ms: lag.lo_median, hi_median_ms: lag.hi_median, median_over_ms: null, n: 5, no_arrival: 2 });
    const md = fs.readFileSync(path.join(dir, 'verdict.md'), 'utf8').split('\n');
    // The count is the one clocks measured: the recount, made as clocks makes it, agrees with calib.json.
    expect(md[10]).toBe(`4 SNIFF LAG    median [${lag.lo_median.toFixed(1)}, ${lag.hi_median.toFixed(1)}] ms, n=5, 2 without arrival ${row['outcome']}`);
  });

  it('copies the count calib.json holds into verdict.json and verdict.md, even when the recount finds another (PREREG §4)', async () => {
    const e = env('sniffs-count-from-calib');
    const synth = buildGateSynth({ replies: PASS_PLAN, sniffs: true, sniffLag: 'measured', sniffsNotArrived: [1, 3] });
    const lag: Record<string, unknown> = { ...(synth.calib['sniff_lag_ms'] as Record<string, unknown>), no_arrival: 1 };
    synth.calib['sniff_lag_ms'] = lag;
    const dir = writeGateSession(e.sessions, synth);
    await stages(e);
    const row = readVerdict(dir)['rows']['sniff_lag'];
    expect(row).toMatchObject({ n: 5, no_arrival: 1, lo_median_ms: lag['lo_median'], hi_median_ms: lag['hi_median'], median_over_ms: null });
    const md = fs.readFileSync(path.join(dir, 'verdict.md'), 'utf8').split('\n');
    expect(md[10]).toMatch(/^4 SNIFF LAG {4}median \[\d+\.\d, \d+\.\d\] ms, n=5, 1 without arrival /);
    expect(e.out.join('\n')).toMatch(
      /note: row 4: the recount of the sniff lag gives n=5, 2 without arrival, median \[[\d.]+, [\d.]+\] ms, but calib\.json holds n=5, 1 without arrival, median \[[\d.]+, [\d.]+\] ms: row 4 is graded on calib\.json as the clocks step wrote it, to 0\.1 ms \(PREREG §4\)/,
    );
  });

  it('keeps a calib.json block without a reading even when the recount could grade row 4 (one source, PREREG §4)', async () => {
    const e = env('sniffs-block-no-reading');
    const synth = buildGateSynth({ replies: PASS_PLAN, sniffs: true, sniffLag: 'measured' });
    expect(synth.sniffClocks!.lag).toMatchObject({ n: 5, noArrival: 0 });
    // The clocks step wrote that it found no sniff; the recount on these files finds five.
    synth.calib['sniff_lag_ms'] = { n: 0, no_arrival: 0, lo_median: null, hi_median: null, median_over_ms: null };
    const dir = writeGateSession(e.sessions, synth);
    await stages(e);
    const v = readVerdict(dir);
    expect(v['rows']['sniff_lag']).toMatchObject({ outcome: 'BETWEEN', lo_median_ms: null, hi_median_ms: null, median_over_ms: null, n: 0, no_arrival: 0 });
    expect(v['verdict']).toBe('BETWEEN');
    const md = fs.readFileSync(path.join(dir, 'verdict.md'), 'utf8').split('\n');
    expect(md[10]).toBe(`4 SNIFF LAG    ${'median [n/a, n/a] ms, n=0'.padEnd(38)} BETWEEN`);
    const out = e.out.join('\n');
    expect(out).toMatch(
      /note: row 4: the recount of the sniff lag gives n=5, 0 without arrival, median \[[\d.]+, [\d.]+\] ms, but calib\.json holds n=0, 0 without arrival, median \[null, null\] ms: row 4 is graded on calib\.json as the clocks step wrote it, to 0\.1 ms \(PREREG §4\)/,
    );
    expect(e.out).toContain('note: row 4: calib.json counts no sniff found in channel 0: BETWEEN (spec 9.6 "the rest")');
    expect(out).not.toContain('recomputed as the clocks step computes it');
  });

  it('reads KILL on row 4 when no sniff reached the trace, and prints the medians as over 2000 ms (PREREG §4)', async () => {
    const e = env('sniffs-none-arrived');
    const synth = buildGateSynth({ replies: PASS_PLAN, sniffs: true, sniffLag: 'measured', sniffsNotArrived: [0, 1, 2, 3, 4] });
    // What clocks writes then: every sniff found, none arrived, null medians over 2000 ms.
    expect(synth.calib['sniff_lag_ms']).toEqual({ n: 5, no_arrival: 5, lo_median: null, hi_median: null, median_over_ms: 2000 });
    expect(synth.sniffClocks!.lag).toMatchObject({ noArrival: 5, medianOverMs: 2000, reading: 'KILL' });
    const dir = writeGateSession(e.sessions, synth);
    await stages(e);
    const v = readVerdict(dir);
    expect(v['rows']['sniff_lag']).toEqual({ outcome: 'KILL', lo_median_ms: null, hi_median_ms: null, median_over_ms: 2000, n: 5, no_arrival: 5, best_case_ms: null, d1_on_sniffs_ms: null });
    // The other rows pass: row 4 alone gives the KILL.
    for (const r of ['hits', 'lead', 'false_holds', 'chest_vs_lips']) expect(v['rows'][r]['outcome']).toBe('PASS');
    expect(v['verdict']).toBe('KILL');
    const md = fs.readFileSync(path.join(dir, 'verdict.md'), 'utf8').split('\n');
    expect(md[10]).toBe('4 SNIFF LAG    median [> 2000, > 2000] ms, n=5, 5 without arrival KILL');
    expect(e.out.join('\n')).toMatch(/note: row 4: 5 of the 5 sniffs found never reached the trace within 2 s; .*, which are over 2000 ms: KILL \(PREREG §4\)/);
  });

  it('recomputes the lag from the sniffs in channel 0 when calib.json has none', async () => {
    const e = env('sniffs-recomputed');
    const synth = buildGateSynth({ replies: PASS_PLAN, sniffs: true, sniffLag: null });
    const dir = writeGateSession(e.sessions, synth);
    await stages(e);
    // Against the true sound onsets, with the A_ref the listening block gives.
    const aRef = recountSniffLag(loadSession('gate-a', { env: e.deps.env }), gateSteps('A'), coreLrtOf(synth.calib['L_rt_ms'] as CalibLrt), 1).aRef!;
    const truth = sniffLag({ onsets: synth.sniffSoundN, packets: tracePacketsOf(synth.inputs, synth.nArrBySeq), aRef, lrtMs: 23.5, sign: 1 });
    const row = readVerdict(dir)['rows']['sniff_lag'];
    expect(row['n']).toBe(5);
    expect(Math.abs(row['lo_median_ms'] - truth.loMedianMs!)).toBeLessThan(5);
    expect(Math.abs(row['hi_median_ms'] - truth.hiMedianMs!)).toBeLessThan(5);
    expect(fs.readFileSync(path.join(dir, 'verdict.md'), 'utf8')).toMatch(/\n4 SNIFF LAG {4}median \[\d+\.\d, \d+\.\d\] ms, n=5, 0 without arrival /);
    expect(e.out).toContain('note: row 4: calib.json has no sniff lag; recomputed as the clocks step computes it, on 5 sniffs found');
  });
});

describe('analyze:gate refusals (spec 8.5, 9.5)', () => {
  it('refuses stage B before stage A and stage A before the label step', async () => {
    const e = env('order');
    const dir = writeGateSession(e.sessions, buildGateSynth({ replies: PASS_PLAN }));
    expect(await main(['--stage', 'B', 'gate-a'], e.deps)).toBe(1);
    expect(e.err.join('\n')).toMatch(/stage_b/);
    // Drop the label line: stage A must wait for it.
    fs.writeFileSync(path.join(dir, 'ledger.jsonl'), `${ledgerLines(dir).slice(0, -1).join('\n')}\n`);
    await refused(e, dir, ['--stage', 'A', 'gate-a'], /after "onsets" the next gate step is "label"/);
    expect(fs.readFileSync(e.paramsFile, 'utf8')).toBe(PREREG);
    expect(await main(['--stage', 'B', 'gate-a', '--exploratory'], e.deps)).toBe(1);
  });

  it('refuses stage B when params/frozen.json changed after stage A', async () => {
    const e = env('changed');
    writeGateSession(e.sessions, buildGateSynth({ replies: PASS_PLAN }));
    expect(await main(['--stage', 'A', 'gate-a'], e.deps)).toBe(0);
    const frozen = JSON.parse(fs.readFileSync(e.paramsFile, 'utf8')) as Record<string, any>;
    frozen['d1']['k'] = 3.0;
    fs.writeFileSync(e.paramsFile, JSON.stringify(frozen));
    expect(await main(['--stage', 'B', 'gate-a'], e.deps)).toBe(1);
    expect(e.err.join('\n')).toMatch(/changed since stage A/);
  });

  it('parses the command line', () => {
    expect(parseGateArgs(['--stage', 'a', 'gate-a'])).toEqual({ stage: 'A', id: 'gate-a', exploratory: false, paramsFile: null, skipOther: false });
    expect(parseGateArgs(['--stage', 'B', 'gate-b', '--exploratory', '--params', 'x.json'])).toMatchObject({ stage: 'B', exploratory: true, paramsFile: 'x.json' });
    expect(parseGateArgs(['gate-a'])).toMatch(/--stage/);
    expect(parseGateArgs(['--stage', 'A'])).toMatch(/id/);
    expect(parseGateArgs(['--stage', 'A', 'gate-a', '--params', 'x'])).toMatch(/stage B only/);
  });
});

describe('a recording that does not count is not scored (spec 9.4, 9.6)', () => {
  let synth: GateSynth;
  beforeAll(() => {
    synth = buildGateSynth({ replies: PASS_PLAN });
  });

  it('refuses stage A when quickcheck.json says RE-RECORD NOW, in plain words and with nothing written', async () => {
    const e = env('void-quickcheck');
    const dir = writeGateSession(e.sessions, { ...synth, quickcheck: reRecordQuickcheck() });
    await refused(
      e,
      dir,
      ['--stage', 'A', 'gate-a'],
      /this recording does not count, so analyze:gate does not score it \(spec 9\.4, 9\.6\):\n  quickcheck\.json says RE-RECORD NOW: microphone processing not off\nThe failure is technical\. Remove the cause, repeat pack 0 until it says GOOD RECORDING, then record the next unused pack \(B, then C\): the objection block \(from 4:15\) was heard/,
    );
    expect(fs.readFileSync(e.paramsFile, 'utf8')).toBe(PREREG);
    // An exploratory run may come only after the confirmatory stage B (spec 8.5), which never ran here.
    await refused(e, dir, ['--stage', 'A', 'gate-a', '--exploratory'], /exploratory "stage_a" before the confirmatory stage_b/);
  });

  it('says when the failure is not technical: the next pack is the one re-record for content', async () => {
    const e = env('void-content');
    const q = exampleQuickcheck();
    const content: Quickcheck = {
      ...q,
      result: 'RE-RECORD NOW',
      reasons: ['voice after 11 cues, fewer than 12'],
      technical: false,
      checks: q.checks.map((c) => (c.name === 'voice_after_cues' ? { ...c, ok: false, value: 11 } : c)),
    };
    const dir = writeGateSession(e.sessions, { ...synth, quickcheck: content });
    await refused(e, dir, ['--stage', 'A', 'gate-a'], /RE-RECORD NOW: voice after 11 cues, fewer than 12\nquickcheck marks the failure as not technical .*record the next unused pack/);
  });

  it('refuses stage A when clock_report.json finds the audio or the trace not valid', async () => {
    const audio = env('void-audio');
    const dirA = writeGateSession(audio.sessions, { ...synth, clockReport: voidClockReport(synth.clockReport, 'audio') });
    await refused(audio, dirA, ['--stage', 'A', 'gate-a'], /\n  clock_report\.json says the audio is not valid: microphone processing not off\n/);
    const trace = env('void-trace');
    const dirT = writeGateSession(trace.sessions, { ...synth, clockReport: voidClockReport(synth.clockReport, 'trace') });
    await refused(trace, dirT, ['--stage', 'A', 'gate-a'], /\n  clock_report\.json says the trace is not valid: 2 SDK error event\(s\)\n/);
    expect(trace.err.join('\n')).not.toMatch(/audio is not valid/);
  });

  it('refuses stage B on such a recording, and an exploratory run after stage B reads it with marked notes', async () => {
    const e = env('void-after-a');
    const dir = writeGateSession(e.sessions, synth);
    expect(await main(['--stage', 'A', 'gate-a'], e.deps)).toBe(0);
    const good = fs.readFileSync(path.join(dir, 'quickcheck.json'), 'utf8');
    replaceRecorded(dir, 'quickcheck.json', toJsonText(reRecordQuickcheck(), null));
    await refused(e, dir, ['--stage', 'B', 'gate-a'], /does not score it[^\n]*\n  quickcheck\.json says RE-RECORD NOW: microphone processing not off/);
    expect(fs.existsSync(path.join(dir, 'verdict.json'))).toBe(false);

    // The recording counted when stage B ran; later it does not: exploratory runs read it, marked.
    replaceRecorded(dir, 'quickcheck.json', good);
    expect(await main(['--stage', 'B', 'gate-a'], e.deps)).toBe(0);
    const verdict = fs.readFileSync(path.join(dir, 'verdict.json'), 'utf8');
    replaceRecorded(dir, 'clock_report.json', toJsonText(voidClockReport(synth.clockReport, 'trace'), 'clock_report.json'));
    await refused(e, dir, ['--stage', 'B', 'gate-a'], /any later analyze:gate run needs --exploratory/);
    e.out.length = 0;
    expect(await main(['--stage', 'B', 'gate-a', '--exploratory'], e.deps)).toBe(0);
    expect(e.out).toContain('EXPLORATORY stage B run 2: note: this recording does not count: clock_report.json says the trace is not valid: 2 SDK error event(s)');
    expect(fs.readFileSync(path.join(dir, 'verdict.json'), 'utf8')).toBe(verdict);
    e.out.length = 0;
    expect(await main(['--stage', 'A', 'gate-a', '--exploratory'], e.deps)).toBe(0);
    expect(e.out).toContain('EXPLORATORY stage A run 2: note: this recording does not count: clock_report.json says the trace is not valid: 2 SDK error event(s)');
  });
});

describe('stage B scores the labels whose hash the label step put in the ledger (spec 8.5, 9.5 step 3)', () => {
  let e: Env;
  let dir: string;
  let synth: GateSynth;
  let ledgerText: string;

  beforeAll(async () => {
    e = env('labels');
    synth = buildGateSynth({ replies: PASS_PLAN });
    dir = writeGateSession(e.sessions, synth);
    expect(await main(['--stage', 'A', 'gate-a'], e.deps)).toBe(0);
    ledgerText = fs.readFileSync(path.join(dir, 'ledger.jsonl'), 'utf8');
  });

  afterEach(() => {
    fs.writeFileSync(path.join(dir, 'ledger.jsonl'), ledgerText);
    fs.writeFileSync(path.join(dir, 'onsets.json'), toJsonText(synth.onsets, 'onsets.json'));
  });

  it('writes the label_order note with the labels hash of onsets.json just before label', () => {
    const records = ledgerLines(dir).map((l) => JSON.parse(l) as LedgerLine);
    const at = records.findIndex((r) => !isNoteLine(r) && r.step === 'label');
    const note = records[at - 1]!;
    expect(isNoteLine(note) && note.what).toBe('label_order');
    expect(isNoteLine(note) && note.detail).toMatch(new RegExp(`; labels_sha256 ${synth.onsets.labels_sha256!}$`));
  });

  it('refuses when the label_order note holds another labels hash', async () => {
    const other = 'b'.repeat(64);
    reforgeLedger(dir, (r) => (isNoteLine(r) && r.what === 'label_order' ? { ...r, detail: r.detail!.replace(/labels_sha256 [0-9a-f]{64}/, `labels_sha256 ${other}`) } : r));
    await refused(e, dir, ['--stage', 'B', 'gate-a'], /onsets\.json labels_sha256 [0-9a-f]{8} differs from the label_order note on ledger\.jsonl line 5 \(bbbbbbbb\)/);
  });

  it('refuses without a label_order note', async () => {
    reforgeLedger(dir, (r) => (isNoteLine(r) && r.what === 'label_order' ? null : r));
    await refused(e, dir, ['--stage', 'B', 'gate-a'], /ledger\.jsonl has no label_order note before the label step/);
  });

  it('refuses onsets.json whose labels and hand marks do not give the labels_sha256 it holds', async () => {
    const [first, ...rest] = synth.onsets.events;
    const nV = first?.manual?.n_v;
    if (first === undefined || typeof nV !== 'number') throw new Error('the synthetic onsets carry hand marks');
    const moved = { ...synth.onsets, events: [{ ...first, manual: { n_v: nV + 480, blind: true } }, ...rest] };
    replaceRecorded(dir, 'onsets.json', toJsonText(moved, 'onsets.json'));
    await refused(e, dir, ['--stage', 'B', 'gate-a'], /onsets\.json: its blind labels and hand marks give labels_sha256 [0-9a-f]{8}, not the [0-9a-f]{8} it holds/);
  });
});

describe('lost or broken inputs refuse, with nothing written (spec 8.1, 9.4)', () => {
  let synth: GateSynth;
  beforeAll(() => {
    synth = buildGateSynth({ replies: PASS_PLAN });
  });

  it('refuses stage A without detector_in.jsonl', async () => {
    const e = env('lost-detector-in');
    const dir = writeGateSession(e.sessions, synth);
    fs.rmSync(path.join(dir, 'detector_in.jsonl'));
    await refused(e, dir, ['--stage', 'A', 'gate-a'], /detector_in\.jsonl is missing/);
  });

  it('refuses stage A without samples.jsonl: G needs its reset flags', async () => {
    const e = env('lost-samples');
    const dir = writeGateSession(e.sessions, synth);
    fs.rmSync(path.join(dir, 'samples.jsonl'));
    await refused(e, dir, ['--stage', 'A', 'gate-a'], /samples\.jsonl is missing/);
  });

  it('refuses a broken calib.json and prints what is wrong with it', async () => {
    const e = env('broken-calib');
    const dir = writeGateSession(e.sessions, synth);
    const calib = JSON.parse(fs.readFileSync(path.join(dir, 'calib.json'), 'utf8')) as Record<string, unknown>;
    fs.writeFileSync(path.join(dir, 'calib.json'), JSON.stringify({ ...calib, A_ref: -1 }));
    await refused(e, dir, ['--stage', 'A', 'gate-a'], /calib\.json: A_ref/);
  });

  it('refuses stage A on a broken line before the cut', async () => {
    const e = env('broken-before-cut');
    const dir = writeGateSession(e.sessions, synth);
    breakLine(dir, 'detector_in.jsonl', 99);
    await refused(e, dir, ['--stage', 'A', 'gate-a'], /detector_in\.jsonl line 100: not valid JSON/);
  });

  it('runs stage A past a broken line in the objection block, which stage B refuses', async () => {
    const e = env('broken-after-cut');
    const dir = writeGateSession(e.sessions, synth);
    const i = prefixLength(synth) + 300;
    breakLine(dir, 'detector_in.jsonl', i);
    expect(await main(['--stage', 'A', 'gate-a'], e.deps)).toBe(0);
    await refused(e, dir, ['--stage', 'B', 'gate-a'], new RegExp(`detector_in\\.jsonl line ${i + 1}: not valid JSON`));
    expect(fs.existsSync(path.join(dir, 'verdict.json'))).toBe(false);
  });
});

describe('stage A starts from params/frozen.json as frozen under gate-prereg (spec 8.4)', () => {
  let synth: GateSynth;
  beforeAll(() => {
    synth = buildGateSynth({ replies: PASS_PLAN });
  });

  it('refuses without params/frozen.json instead of using code defaults', async () => {
    const e = env('no-params', { prereg: false });
    const dir = writeGateSession(e.sessions, synth);
    await refused(e, dir, ['--stage', 'A', 'gate-a'], /frozen\.json does not exist: .*npm run freeze -- gate-prereg/);
    expect(fs.existsSync(e.paramsFile)).toBe(false);
  });

  it('refuses when the file is not under the tag, or differs from its tagged copy beyond k and theta_G', async () => {
    const untagged = env('untagged', { tagged: null });
    const dirU = writeGateSession(untagged.sessions, synth);
    await refused(untagged, dirU, ['--stage', 'A', 'gate-a'], /not under the git tag gate-prereg/);

    const changed = env('prereg-changed');
    const dirC = writeGateSession(changed.sessions, synth);
    const p = JSON.parse(PREREG) as Record<string, any>;
    fs.writeFileSync(changed.paramsFile, JSON.stringify({ ...p, d1: { ...p['d1'], L: 7 } }));
    await refused(changed, dirC, ['--stage', 'A', 'gate-a'], /differs from its copy under the tag gate-prereg at d1\.L/);
  });
});

describe('files of earlier steps must match the ledger, and a run writes once (spec 8.5)', () => {
  let e: Env;
  let dir: string;

  beforeAll(async () => {
    e = env('hashes');
    dir = writeGateSession(e.sessions, buildGateSynth({ replies: PASS_PLAN }));
    expect(await main(['--stage', 'A', 'gate-a'], e.deps)).toBe(0);
  });

  it('refuses stage B when onsets.json or clock_report.json changed after label', async () => {
    for (const file of ['onsets.json', 'clock_report.json']) {
      const p = path.join(dir, file);
      const text = fs.readFileSync(p, 'utf8');
      fs.writeFileSync(p, text.replace(/\n$/, ' \n'));
      await refused(e, dir, ['--stage', 'B', 'gate-a'], new RegExp(`${file.replace('.', '\\.')} changed after step label wrote it`));
      fs.writeFileSync(p, text);
    }
  });

  it('refuses and writes nothing when the ledger changes while stage B runs', async () => {
    const ledger = path.join(dir, 'ledger.jsonl');
    const text = fs.readFileSync(ledger, 'utf8');
    const deps: GateDeps = {
      ...e.deps,
      commit: () => {
        const note = appendLedger(ledgerLines(dir), 'note', { utc: '2026-11-14T10:00:00Z', commit: null, what: 'narrowed_claim' }, (t) => sha256Hex(t));
        fs.appendFileSync(ledger, `${note}\n`);
        return 'abc1234';
      },
    };
    const files = fs.readdirSync(dir).sort();
    e.err.length = 0;
    expect(await main(['--stage', 'B', 'gate-a'], deps)).toBe(1);
    expect(e.err.join('\n')).toMatch(/ledger\.jsonl changed while analyze:gate ran: nothing was written/);
    expect(fs.readdirSync(dir).sort()).toEqual(files); // no verdict, no .partial
    fs.writeFileSync(ledger, text);
  });

  it('finishes a stage B that stopped between its ledger lines and the names of its files', async () => {
    expect(await main(['--stage', 'B', 'gate-a'], e.deps)).toBe(0);
    const json = fs.readFileSync(path.join(dir, 'verdict.json'), 'utf8');
    for (const f of ['verdict.json', 'verdict.md']) fs.renameSync(path.join(dir, f), path.join(dir, `${f}.partial`));
    e.out.length = 0;
    expect(await main(['--stage', 'B', 'gate-a'], e.deps)).toBe(1); // stage B ran: only the names are finished
    expect(e.out.filter((l) => /finished the run before this one/.test(l))).toHaveLength(2);
    expect(fs.readFileSync(path.join(dir, 'verdict.json'), 'utf8')).toBe(json);
    expect(fs.existsSync(path.join(dir, 'verdict.md'))).toBe(true);
    expect(fs.readdirSync(dir).filter((f) => f.endsWith('.partial'))).toEqual([]);
  });

  it('finishes a stage A that stopped before params/frozen.json got its name', async () => {
    const e2 = env('interrupted-a');
    const dir2 = writeGateSession(e2.sessions, buildGateSynth({ replies: PASS_PLAN }));
    expect(await main(['--stage', 'A', 'gate-a'], e2.deps)).toBe(0);
    const tuned = fs.readFileSync(e2.paramsFile, 'utf8');
    fs.renameSync(e2.paramsFile, `${e2.paramsFile}.partial`);
    fs.writeFileSync(e2.paramsFile, PREREG);
    expect(await main(['--stage', 'B', 'gate-a'], e2.deps)).toBe(0);
    expect(fs.readFileSync(e2.paramsFile, 'utf8')).toBe(tuned);
    expect(readVerdict(dir2)['params_sha256']).toBe(sha256Hex(tuned));
  });
});

describe('stage A reads nothing after 4:15 (spec 9.5 step 4)', () => {
  it('gives the same params/frozen.json when everything after the cut is garbage', async () => {
    const synth = buildGateSynth({ replies: PASS_PLAN, seed: 23 });
    const clean = env('cut-clean');
    writeGateSession(clean.sessions, synth);
    expect(await main(['--stage', 'A', 'gate-a'], clean.deps)).toBe(0);

    const dirty = env('cut-dirty');
    const dir = writeGateSession(dirty.sessions, synth);
    spoilAfterCut(dir, synth);
    expect(await main(['--stage', 'A', 'gate-a'], dirty.deps)).toBe(0);
    expect(fs.readFileSync(dirty.paramsFile, 'utf8')).toBe(fs.readFileSync(clean.paramsFile, 'utf8'));

    // What stage A computes from: the same lines, all of them before the cut.
    const a = stageAView(loadSession('gate-a', { env: clean.deps.env }));
    const b = stageAView(loadSession('gate-a', { env: dirty.deps.env }));
    expect(b.nCut).toBe(synth.nCut);
    expect(b.inputs).toEqual(a.inputs);
    expect([...b.nArrBySeq]).toEqual([...a.nArrBySeq]);
    expect(b.resets).toEqual(a.resets);
    for (const r of b.inputs) {
      const n = r.k === 'batch' || r.k === 'val' ? b.nArrBySeq.get(r.seq) : r.n;
      expect(n).toBeLessThan(synth.nCut);
    }
    expect(Math.max(...b.nArrBySeq.values())).toBeLessThan(synth.nCut);
    // Stage B reads the whole recording, and refuses this one.
    expect(await main(['--stage', 'B', 'gate-a'], dirty.deps)).toBe(1);
  });
});

/** Replaces every input after the objections mark with garbage that still lies after the cut. */
function spoilAfterCut(dir: string, s: GateSynth): void {
  let k = 0;
  const odd = (): number => ((k = (k * 1103515245 + 12345) % 2147483648), k / 2147483648);
  const cut = s.nCut;
  const keep = prefixLength(s);
  // The first line after the cut stays readable: a broken line there could hide one before it.
  const lines = s.inputs.map((r, i): string => {
    if (i < keep) return toJsonlText([r], 'detector_in.jsonl').trimEnd();
    if (i > keep && (i - keep) % 7 === 3) return '{"k":"batch","seq":';
    const spoiled: DetectorInput =
      r.k === 'batch'
        ? { ...r, tr: r.tr.map(([t]) => [t, 1e6 * (odd() - 0.5)] as const), g: 10 * odd(), hm: 10 * odd() }
        : r.k === 'val'
          ? { ...r, code: 2 }
          : { ...r, n: r.n + Math.round(odd() * 1e6) };
    return toJsonlText([spoiled], 'detector_in.jsonl').trimEnd();
  });
  fs.writeFileSync(path.join(dir, 'detector_in.jsonl'), `${lines.join('\n')}\n`);
  expect(parseDetectorIn(lines.slice(0, keep).join('\n'))).toHaveLength(keep);

  // samples.jsonl: packets that arrived after the cut get reset flags, and some lines break.
  const maxSeq = Math.max(...arrivalsBefore(s.stamps, cut).keys());
  const samples = fs.readFileSync(path.join(dir, 'samples.jsonl'), 'utf8').split('\n').filter((l) => l.length > 0);
  let after = 0;
  const spoiledSamples = samples.map((l) => {
    const o = JSON.parse(l) as { seq: number };
    if (o.seq <= maxSeq) return l;
    after++;
    if (after % 9 === 5) return 'not json';
    return JSON.stringify({ ...o, g: null, hm: null, lm: { ts: 1, reset: 1, p: Array.from({ length: 16 }, () => null) } });
  });
  fs.writeFileSync(path.join(dir, 'samples.jsonl'), `${spoiledSamples.join('\n')}\n`);

  const stamps = fs.readFileSync(path.join(dir, 'stamps.jsonl'), 'utf8').split('\n').filter((l) => l.length > 0);
  const spoiledStamps = stamps.map((l) => {
    const o = JSON.parse(l) as { n: number; k: string; name?: string };
    if (o.n <= cut) return l;
    if (o.k === 'arr') return JSON.stringify({ ...o, n: o.n + Math.round(odd() * 4e5) });
    if (o.k === 'mark') return JSON.stringify({ ...o, name: o.name === undefined ? undefined : `junk_${Math.round(odd() * 100)}` });
    return l;
  });
  spoiledStamps.push('not json at all');
  fs.writeFileSync(path.join(dir, 'stamps.jsonl'), `${spoiledStamps.join('\n')}\n`);

  const wav = readStereoFloatWav(path.join(dir, 'audio.wav'));
  const half = wav.ch0.length / 2; // the audio spans the cut symmetrically (synth.ts)
  for (let i = half; i < wav.ch0.length; i++) {
    wav.ch0[i] = Number.NaN;
    wav.ch1[i] = Number.NaN;
  }
  fs.writeFileSync(path.join(dir, 'audio.wav'), encodeStereoFloatWav(wav.ch0, wav.ch1));
  fs.writeFileSync(path.join(dir, 'onsets.json'), 'garbage');
  fs.writeFileSync(path.join(dir, 'events.jsonl'), '{"n":1,"e":\n');
  // The parsed onsets would refuse stage B; stage A must not read them at all.
  expect(parseJson('garbage', validateFrozenParams).value).toBeNull();
}
