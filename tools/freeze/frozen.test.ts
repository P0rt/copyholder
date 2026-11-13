// params/frozen.json for gate-prereg (spec 8.4): values, schema, the doctor values, the file text, and
// the command that writes it (refuses without doctor values and after the tag gate-prereg).
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { d1ParamsFromFrozen, DEFAULT_HOLD_PARAMS, holdParamsFromFrozen, K_PRELIMINARY, resolveD1Params } from '../../core/detector.ts';
import { exampleManifest } from '../../core/schemas/examples.ts';
import { validateCalib, validateFrozenParams, validateManifest } from '../../core/schemas/index.ts';
import { DEFAULT_VAD_PARAMS, vadParamsFromFrozen } from '../../core/vad/index.ts';
import { doctorVadOf, latestDoctorVad } from './doctor-calib.ts';
import {
  buildGatePreregParams,
  doctorVadProblems,
  FROZEN_PARAMS_PATH,
  frozenParamsText,
  gatePreregParamsProblems,
  main,
  measuredFloorProblem,
  NO_DOCTOR_HINT,
  REPO_ROOT,
  roundedDoctorVad,
  stageAKeysFound,
  vadBlockFor,
  withoutStageA,
} from './frozen.ts';
import { makeTempRepo, type TempRepo } from './test-repo.ts';

const DOCTOR = { id: 'doctor-2', periodicity: 0.6, floorDb: -58.3 };

describe('buildGatePreregParams (spec 8.4)', () => {
  const { params } = buildGatePreregParams(null);

  it('holds every value of the spec 8.4 example except k and theta_G', () => {
    expect(params.schema).toBe('params/1');
    expect(params.d1).toMatchObject({ grid_hz: 30, L: 5, M: 2, theta_clamp: [1.3, 3.0], min_rise_A: 0.15, min_rise_ms: 200, arm_breaths: 10, refractory_ms: 2000, rearm_ms: 4000 });
    expect(params.hold).toEqual({ H_ms: 1500, ramp_frames: 384, audio_pause_ms: 250 });
    expect(params.g).toMatchObject({ frames: 2, baseline_s: 10 });
    expect(params.vad).toMatchObject({ highpass_hz: 150, hop_ms: 5, over_floor_db: 15, periodicity: 0.5, on_ms: [30, 50], off_ms: 1200 });
    expect('k' in params.d1).toBe(false);
    expect('theta_G' in params.g).toBe(false);
    expect('tuned' in params).toBe(false);
    expect(validateFrozenParams(params)).toEqual([]);
    expect(stageAKeysFound(params)).toEqual([]);
  });

  it('gives the code its own defaults back', () => {
    expect(d1ParamsFromFrozen(params)).toEqual(resolveD1Params({ k: K_PRELIMINARY }));
    expect(holdParamsFromFrozen(params)).toEqual(DEFAULT_HOLD_PARAMS);
    expect(vadParamsFromFrozen(params.vad)).toEqual(DEFAULT_VAD_PARAMS);
  });

  it('leaves the floor out without doctor values, so no placeholder passes for a measured floor', () => {
    expect('floor_db' in params.vad).toBe(false);
    expect(buildGatePreregParams(null).vadSource).toMatch(/^defaults \(periodicity 0\.5, no floor/);
  });

  it('takes the periodicity threshold and the floor of a doctor run', () => {
    const b = buildGatePreregParams(DOCTOR);
    expect(b.params.vad).toMatchObject({ periodicity: 0.6, floor_db: -58.3 });
    expect(vadParamsFromFrozen(b.params.vad)).toMatchObject({ periodicity: 0.6, floorDb: -58.3 });
    expect(b.vadSource).toBe('doctor-2 (periodicity 0.6, floor -58.3 dB)');
    expect(vadBlockFor(DOCTOR)['highpass_hz']).toBe(150);
  });

  it('refuses a doctor value the schema rejects', () => {
    expect(() => buildGatePreregParams({ ...DOCTOR, periodicity: 1.5 })).toThrow(/periodicity/);
  });
});

describe('doctor values', () => {
  it('accept the thresholds of the in-breath test and a floor below full scale (spec 7.12)', () => {
    for (const periodicity of [0.5, 0.55, 0.6, 0.65, 0.7]) expect(doctorVadProblems({ ...DOCTOR, periodicity })).toEqual([]);
    expect(doctorVadProblems({ ...DOCTOR, periodicity: 0.6000000000000001 })).toEqual([]);
    expect(doctorVadProblems({ ...DOCTOR, periodicity: 0.62 })[0]).toMatch(/not one of 0\.5, 0\.55, 0\.6, 0\.65, 0\.7/);
    expect(doctorVadProblems({ ...DOCTOR, periodicity: 6 })).toHaveLength(1);
    expect(doctorVadProblems({ ...DOCTOR, floorDb: 58.3 })[0]).toMatch(/not a floor in dB re full scale/);
    expect(doctorVadProblems({ ...DOCTOR, floorDb: Number.NaN })).toHaveLength(1);
  });

  it('are rounded as doctor prints them', () => {
    expect(roundedDoctorVad({ id: 'd', floorDb: -58.27, periodicity: 0.6000000000000001 })).toEqual({ id: 'd', floorDb: -58.3, periodicity: 0.6 });
  });
});

describe('stage A values', () => {
  const base = buildGatePreregParams(null).params as unknown as Record<string, Record<string, unknown>>;

  it('finds d1.k, g.theta_G and tuned, but not the fixed D3 number d1.d3.k', () => {
    expect(stageAKeysFound(base)).toEqual([]);
    expect(stageAKeysFound({ ...base, d1: { ...base['d1'], k: null } })).toEqual([]);
    expect(stageAKeysFound({ ...base, d1: { ...base['d1'], k: 2.5 } })).toEqual(['d1.k is set: stage A writes it after the gate recording (spec 8.4)']);
    expect(stageAKeysFound({ ...base, g: { ...base['g'], theta_G: 0.0275 } })[0]).toMatch(/^g\.theta_G is set/);
    expect(stageAKeysFound({ ...base, tuned: { k: {}, theta_G: {} } })[0]).toMatch(/^tuned is set/);
    const tuned = { ...base, d1: { ...base['d1'], k: 2.5 }, g: { ...base['g'], theta_G: 0.0275 }, tuned: { k: {}, theta_G: {} } };
    expect(withoutStageA(tuned)).toEqual(base);
  });

  it('reports bad JSON and schema problems of a file text', () => {
    expect(gatePreregParamsProblems('{')[0]).toMatch(/not valid JSON/);
    expect(gatePreregParamsProblems(JSON.stringify({ schema: 'params/1' })).length).toBeGreaterThan(0);
    expect(gatePreregParamsProblems(frozenParamsText(buildGatePreregParams(DOCTOR).params))).toEqual([]);
  });

  it('asks for the floor a doctor run measured before the tag (spec 7.3)', () => {
    expect(gatePreregParamsProblems(frozenParamsText(base))).toEqual([expect.stringMatching(/^vad\.floor_db is missing: .*spec 7\.3/)]);
    expect(measuredFloorProblem(buildGatePreregParams(DOCTOR).params)).toBeNull();
  });
});

describe('frozenParamsText', () => {
  it('writes the spec 8.4 key order, one top-level block per line', () => {
    const { params } = buildGatePreregParams(null);
    const text = frozenParamsText(params);
    const lines = text.split('\n');
    expect(lines[0]).toBe('{"schema":"params/1",');
    expect(lines.slice(1, 5).map((l) => l.slice(0, 7))).toEqual([' "d1":{', ' "hold"', ' "g":{"', ' "vad":']);
    expect(text.endsWith('}\n')).toBe(true);
    expect(JSON.parse(text)).toEqual(params);
    expect(lines[1]).toMatch(/^ "d1":\{"grid_hz":30,"L":5,"M":2,"theta_clamp":\[1\.3,3\],"min_rise_A":0\.15/);
  });

  it('a committed params/frozen.json is valid and holds doctor values, never the defaults alone', () => {
    const file = join(REPO_ROOT, FROZEN_PARAMS_PATH);
    // Before doctor there is no file: host, the page and the analysis then use doctor's calib.json.
    if (!existsSync(file)) return;
    const value: unknown = JSON.parse(readFileSync(file, 'utf8'));
    expect(validateFrozenParams(value)).toEqual([]);
    expect(measuredFloorProblem(value)).toBeNull();
    expect(() => d1ParamsFromFrozen(value)).not.toThrow();
    expect(() => vadParamsFromFrozen((value as { vad: Record<string, unknown> }).vad)).not.toThrow();
  });
});

describe('the doctor calib.json and the command', () => {
  let dir: string;
  let env: NodeJS.ProcessEnv;
  let logs: string[];
  const out = (): string => join(dir, 'frozen.json');
  const log = (l: string): void => {
    logs.push(l);
  };

  function doctorRun(id: string, startedUtc: string, calib: Record<string, unknown>): void {
    const folder = join(dir, 'sessions', id);
    mkdirSync(folder, { recursive: true });
    const manifest = { ...exampleManifest(), id, kind: 'doctor', scenario: 'doctor', started_utc: startedUtc, plan_commitment: null };
    expect(validateManifest(manifest)).toEqual([]);
    expect(validateCalib(calib)).toEqual([]);
    writeFileSync(join(folder, 'manifest.json'), JSON.stringify(manifest));
    writeFileSync(join(folder, 'calib.json'), JSON.stringify(calib));
  }

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'copyholder-frozen-'));
    env = { COPYHOLDER_SESSIONS_DIR: join(dir, 'sessions') };
    logs = [];
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('finds the newest doctor run whose calib.json has the vad block, or a named one', () => {
    expect(latestDoctorVad(env)).toBeNull();
    doctorRun('doctor-1', '2026-11-12T20:00:00Z', { schema: 'calib/1', L_rt_ms: { used: 23.5 }, vad: { floor_db: -61.2, periodicity: 0.5 } });
    doctorRun('doctor-2', '2026-11-13T08:00:00Z', { schema: 'calib/1', L_rt_ms: { used: 23.4 }, vad: { floor_db: -58.3, periodicity: 0.6 } });
    doctorRun('doctor-3', '2026-11-13T09:00:00Z', { schema: 'calib/1', output_gain: 0.4 });
    expect(latestDoctorVad(env)).toEqual(DOCTOR);
    expect(doctorVadOf('doctor-1', env)).toEqual({ id: 'doctor-1', periodicity: 0.5, floorDb: -61.2 });
    expect(doctorVadOf('doctor-3', env)).toBeNull();
    expect(doctorVadOf('../doctor-1', env)).toBeNull();
  });

  it('writes the file, then --check compares it with a rebuild', () => {
    doctorRun('doctor-2', '2026-11-13T08:00:00Z', { schema: 'calib/1', vad: { floor_db: -58.3, periodicity: 0.6 } });
    expect(main(['--out', out()], env, log)).toBe(0);
    const written: unknown = JSON.parse(readFileSync(out(), 'utf8'));
    expect(written).toMatchObject({ vad: { periodicity: 0.6, floor_db: -58.3 } });
    expect(gatePreregParamsProblems(readFileSync(out(), 'utf8'))).toEqual([]);
    expect(logs.join('\n')).toMatch(/without k and theta_G\. Voice detector: doctor-2 \(periodicity 0\.6, floor -58\.3 dB\)/);
    expect(main(['--out', out(), '--check'], env, log)).toBe(0);
    writeFileSync(out(), readFileSync(out(), 'utf8').replace('"periodicity":0.6', '"periodicity":0.65'));
    expect(main(['--out', out(), '--check'], env, log)).toBe(1);
  });

  it('takes the values the doctor report prints, with the doctor id, where no calib.json exists', () => {
    expect(main(['--out', out(), '--doctor', 'doctor-7', '--floor-db', '−61.24', '--periodicity', '0.55'], env, log)).toBe(0);
    expect(JSON.parse(readFileSync(out(), 'utf8'))).toMatchObject({ vad: { floor_db: -61.2, periodicity: 0.55 } });
    expect(logs.join('\n')).toMatch(/Voice detector: doctor-7 \(periodicity 0\.55, floor -61\.2 dB\)/);
    expect(main(['--out', out(), '--floor-db', '-61.2', '--periodicity', '0.55'], env, log)).toBe(2);
    expect(logs.at(-1)).toMatch(/need --doctor <id>/);
    expect(main(['--out', out(), '--doctor', 'doctor-7', '--floor-db', '-61.2'], env, log)).toBe(2);
    expect(main(['--out', out(), '--doctor', 'doctor-7', '--floor-db', 'loud', '--periodicity', '0.5'], env, log)).toBe(2);
    expect(main(['--out', out(), '--doctor', 'doctor-7', '--floor-db', '-61.2', '--periodicity', '0.62'], env, log)).toBe(1);
    expect(logs.at(-1)).toMatch(/cannot be used: the periodicity threshold 0\.62 is not one of/);
  });

  it('does not write without doctor values (spec 7.3, 7.12)', () => {
    expect(main(['--out', out()], env, log)).toBe(1);
    expect(existsSync(out())).toBe(false);
    expect(logs).toContain(NO_DOCTOR_HINT);
    expect(main(['--out', out(), '--check'], env, log)).toBe(1);
    expect(main(['--out', out(), '--doctor', 'doctor-9'], env, log)).toBe(1);
    expect(logs.join('\n')).toMatch(/sessions\/doctor-9\/calib\.json has no voice detector values/);
  });

  it('does not rebuild a file that stage A has tuned', () => {
    doctorRun('doctor-2', '2026-11-13T08:00:00Z', { schema: 'calib/1', vad: { floor_db: -58.3, periodicity: 0.6 } });
    const base = buildGatePreregParams(DOCTOR).params;
    writeFileSync(out(), frozenParamsText({ ...base, d1: { ...base.d1, k: 2.0 } }));
    expect(main(['--out', out()], env, log)).toBe(1);
    expect(logs.join('\n')).toMatch(/already holds k or theta_G/);
    expect(JSON.parse(readFileSync(out(), 'utf8'))).toMatchObject({ d1: { k: 2.0 } });
  });

  it('refuses an unknown argument', () => {
    expect(main(['--bogus'], env, log)).toBe(2);
    expect(logs[0]).toMatch(/Usage: npx tsx tools\/freeze\/frozen\.ts/);
  });
});

describe('the command in a repository: the tag gate-prereg and --commit', () => {
  let repo: TempRepo;
  let logs: string[];
  const log = (l: string): void => {
    logs.push(l);
  };
  const VALUES = ['--doctor', 'doctor-2', '--floor-db', '-58.3', '--periodicity', '0.6'];
  const run = (...argv: string[]): number => main(argv, repo.env, log, repo.work);

  beforeEach(() => {
    repo = makeTempRepo('copyholder-frozen-git-');
    repo.write('README.md', 'Repository.\n');
    repo.commitAll('start');
    repo.git(['push', '--quiet', '-u', 'origin', 'main']);
    logs = [];
  });
  afterEach(() => repo.remove());

  it('--commit commits params/frozen.json alone and pushes main (spec 14.1)', () => {
    repo.write('notes.txt', 'unrelated, not committed\n');
    expect(run(...VALUES, '--commit'), logs.join('\n')).toBe(0);
    expect(repo.git(['show', '--name-only', '--format=%s', 'HEAD'])).toBe('params/frozen.json: voice detector values of doctor-2 (spec 7.3, 8.4)\n\nparams/frozen.json');
    expect(repo.git(['rev-parse', 'main'], repo.remote)).toBe(repo.git(['rev-parse', 'HEAD']));
    expect(repo.git(['status', '--porcelain'])).toBe('?? notes.txt');
    // The same values again: nothing new to commit.
    expect(run(...VALUES, '--commit')).toBe(0);
    expect(logs.join('\n')).toMatch(/already committed with these values/);
  });

  it('--commit refuses another branch and a clone behind origin/main, before writing', () => {
    repo.git(['checkout', '--quiet', '-b', 'side']);
    expect(run(...VALUES, '--commit')).toBe(1);
    expect(logs.at(-1)).toMatch(/--commit pushes main: check out main first \(now on side\)/);
    expect(existsSync(join(repo.work, FROZEN_PARAMS_PATH))).toBe(false);
    repo.git(['checkout', '--quiet', 'main']);
    repo.git(['commit', '--quiet', '--allow-empty', '-m', 'ahead']);
    repo.git(['push', '--quiet', 'origin', 'main']);
    repo.git(['reset', '--quiet', '--hard', 'HEAD~1']);
    expect(run(...VALUES, '--commit')).toBe(1);
    expect(logs.at(-1)).toMatch(/HEAD is not equal to or ahead of origin\/main/);
    expect(existsSync(join(repo.work, FROZEN_PARAMS_PATH))).toBe(false);
  });

  it('after the tag gate-prereg: no rewrite, and --check compares with the tagged copy (spec 7.12)', () => {
    expect(run(...VALUES, '--commit')).toBe(0);
    repo.git(['tag', '-a', '-m', 'gate-prereg', 'gate-prereg']);
    const tagged = repo.read(FROZEN_PARAMS_PATH).toString('utf8');

    expect(run('--doctor', 'doctor-3', '--floor-db', '-50', '--periodicity', '0.7')).toBe(1);
    expect(logs.at(-1)).toMatch(/is frozen by the tag gate-prereg .* not rewritten/);
    expect(repo.read(FROZEN_PARAMS_PATH).toString('utf8')).toBe(tagged);
    expect(run('--check')).toBe(0);

    // Stage A adds k, theta_G and tuned: still the tagged values.
    const p = JSON.parse(tagged) as Record<string, Record<string, unknown>>;
    const tuned = { ...p, d1: { ...p['d1'], k: 2.5 }, g: { ...p['g'], theta_G: 0.0275 }, tuned: { k: { step: 'stage_a', criterion_met: true, rehearsal_step_up: false }, theta_G: { step: 'stage_a' } } };
    repo.write(FROZEN_PARAMS_PATH, frozenParamsText(tuned));
    expect(run('--check')).toBe(0);
    // Any other change is not.
    repo.write(FROZEN_PARAMS_PATH, frozenParamsText({ ...tuned, vad: { ...p['vad'], periodicity: 0.65 } }));
    expect(run('--check')).toBe(1);
    expect(logs.at(-1)).toMatch(/differs from its copy under the tag gate-prereg beyond k, theta_G and tuned/);
    // --out elsewhere is a scratch copy and stays possible.
    expect(run(...VALUES, '--out', join(repo.root, 'scratch.json'))).toBe(0);
  });

  it('--commit refuses when origin has the tag that this clone lacks', () => {
    expect(run(...VALUES, '--commit')).toBe(0);
    repo.git(['tag', '-a', '-m', 'gate-prereg', 'gate-prereg']);
    repo.git(['push', '--quiet', 'origin', 'refs/tags/gate-prereg']);
    repo.git(['tag', '-d', 'gate-prereg']);
    expect(run('--doctor', 'doctor-3', '--floor-db', '-50', '--periodicity', '0.7', '--commit')).toBe(1);
    expect(logs.at(-1)).toMatch(/the tag gate-prereg is on origin .*is frozen \(spec 7\.12\)/);
  });
});
