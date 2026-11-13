// doctor report on synthetic doctor recordings with known L_rt, leak and inhales (spec 7.12, 7.7).

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CHUNK_SAMPLES, SAMPLE_RATE_HZ, chunkLayout, type Stamp } from '../core/clock/index.ts';
import { parseJson, validateCalib, type Calib } from '../core/schemas/index.ts';
import { addNoise, mulberry32 } from '../tests/synthetic/signals.ts';
import { main as frozenMain } from '../tools/freeze/frozen.ts';
import { EXIT_DOCTOR_FAIL, EXIT_DOCTOR_OK, chosenGain, frozenCommandLines, frozenParamsCommand, main, runDoctor } from './doctor.ts';
import { calibVad } from './lib/calib-io.ts';
import { makeDoctorFixture, writeSessionFolder, type DoctorFixtureOptions } from './lib/fixtures.ts';
import { narratorLeakDb, type SessionView } from './lib/measure.ts';
import { latestSession, loadSession } from './lib/session.ts';
import { interpretTtsSelftest, runTtsSelftest, type TtsSelftest } from './lib/tts.ts';
import { runQuickcheck } from './quickcheck.ts';

let root = '';

beforeAll(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'copyholder-doctor-'));
});

afterAll(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

const env = (dir = root): NodeJS.ProcessEnv => ({ COPYHOLDER_SESSIONS_DIR: dir, COPYHOLDER_PARAMS_FILE: path.join(root, 'no-params.json') });
const TTS_OK: TtsSelftest = { ok: true, line: 'TTS SELFTEST OK 25 812', summary: 'TTS SELFTEST OK 25 812' };

function recordDoctor(id: string, o: DoctorFixtureOptions = {}, startedUtc = '2026-11-12T19:00:00Z', dir = root) {
  const fx = makeDoctorFixture(o);
  const scenario = o.scenario ?? 'doctor';
  const folder = writeSessionFolder(dir, fx.data, { id, kind: 'doctor', scenario, mode: 'doctor', outputAccepted: true, startedUtc });
  return { fx, dir: folder, session: loadSession(folder, { env: env(dir) }) };
}

async function doctor(session: ReturnType<typeof loadSession>, tts: TtsSelftest | null = TTS_OK) {
  const out: string[] = [];
  const r = await runDoctor(session, { out: (l) => out.push(l), env: env(), tts: tts === null ? null : async () => tts });
  return { ...r, out };
}

function readCalib(dir: string): Calib {
  const parsed = parseJson(fs.readFileSync(path.join(dir, 'calib.json'), 'utf8'), validateCalib);
  expect(parsed.errors).toEqual([]);
  return parsed.value!;
}

const last = (out: readonly string[]): string => out[out.length - 1] ?? '';

/** A stand-in for tools/tts/run.ts that ignores SIGTERM and leaves a grandchild holding stdout. */
function hangingSelftest(dir: string): string {
  const file = path.join(dir, 'hang.mjs');
  fs.writeFileSync(
    file,
    [
      "import { spawn } from 'node:child_process';",
      "import fs from 'node:fs';",
      "process.on('SIGTERM', () => {});",
      "if (process.argv[2] === 'ok') console.log('TTS SELFTEST OK 25 812');",
      "const child = spawn(process.execPath, ['-e', 'process.on(\"SIGTERM\", () => {}); setTimeout(() => {}, 60000)'], { stdio: ['ignore', 'inherit', 'ignore'] });",
      'fs.writeFileSync(process.argv[3], String(child.pid));',
      'setInterval(() => {}, 1000);',
      '',
    ].join('\n'),
  );
  return file;
}

/** True when the process is gone (or a zombie waiting to be reaped). */
function processGone(pid: number): boolean {
  try {
    process.kill(pid, 0);
  } catch {
    return true;
  }
  try {
    return /\)\s+[ZX]\s/.test(fs.readFileSync(`/proc/${pid}/stat`, 'utf8'));
  } catch {
    return false;
  }
}

async function waitFor(pred: () => boolean, ms: number): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (pred()) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return pred();
}

describe('doctor', () => {
  it('recovers a known L_rt within 0.5 ms and a known leak within 1 dB, and writes calib.json', async () => {
    const { fx, dir, session } = recordDoctor('doctor-1', { lrtMs: 31.7, leakDb: 4.5, gain: 0.35 });
    const r = await doctor(session);
    expect(r.code).toBe(EXIT_DOCTOR_OK);
    expect(last(r.out)).toBe('DOCTOR OK');
    expect(r.out.filter((l) => /^DOCTOR (OK|FAIL)/.test(l))).toHaveLength(1);

    const calib = readCalib(dir);
    expect(Math.abs(calib.L_rt_ms!.A! - fx.truth.lrtMsA)).toBeLessThan(0.5);
    expect(Math.abs(calib.L_rt_ms!.B! - fx.truth.lrtMsB)).toBeLessThan(0.5);
    expect(calib.L_rt_ms!.rule).toBe('mean');
    expect(Math.abs(calib.leak_db_over_floor! - fx.truth.leakDb)).toBeLessThan(1);
    expect(calib.output_gain).toBe(0.35);
    const vad = calibVad(calib);
    expect(vad?.periodicity).toBe(0.5);
    expect(vad?.floor_db).toBeLessThan(-55);
    expect(r.out).toContain(`  {{VAD_FLOOR_DB}} = ${vad!.floor_db.toFixed(1)}`);
    expect(r.out).toContain('  {{VAD_PERIODICITY}} = 0.50');
    expect(r.out.some((l) => l.startsWith('  {{LRT_THRESHOLDS_CONFIRMED}} = confirmed: 3 ms and 15 ms'))).toBe(true);
    // Next to the PREREG.md values: the command that writes params/frozen.json from this run.
    const at = r.out.findIndex((l) => l.startsWith('  {{LRT_THRESHOLDS_CONFIRMED}} = '));
    expect(r.out.slice(at + 1, at + 3)).toEqual([
      'params/frozen.json for gate-prereg from this doctor run (spec 7.3, 8.4):',
      `  npx tsx tools/freeze/frozen.ts --doctor doctor-1 --floor-db ${vad!.floor_db.toFixed(1)} --periodicity 0.50`,
    ]);
    expect(r.out).toContain('TTS self-test: TTS SELFTEST OK 25 812');
  });

  it('prints the frozen.json command that writes what tools/freeze/frozen.ts writes from this calib.json', async () => {
    const { dir, session } = recordDoctor('doctor-freeze', { seed: 5 });
    const r = await doctor(session, null);
    expect(r.code).toBe(EXIT_DOCTOR_OK);
    const vad = calibVad(readCalib(dir))!;
    const line = r.out.find((l) => l.startsWith('  npx tsx tools/freeze/frozen.ts '));
    expect(line).toBe(`  ${frozenParamsCommand('doctor-freeze', vad.floor_db, vad.periodicity)}`);
    const argv = line!.trim().split(/\s+/).slice(3); // after "npx tsx tools/freeze/frozen.ts"
    const out = fs.mkdtempSync(path.join(root, 'frozen-'));
    const log: string[] = [];
    const fromCommand = path.join(out, 'command.json');
    const fromCalib = path.join(out, 'calib.json');
    expect(frozenMain([...argv, '--out', fromCommand], env(), (l) => log.push(l))).toBe(0);
    expect(frozenMain(['--doctor', 'doctor-freeze', '--out', fromCalib], env(), (l) => log.push(l))).toBe(0);
    const written = fs.readFileSync(fromCommand, 'utf8');
    expect(written).toBe(fs.readFileSync(fromCalib, 'utf8'));
    expect((JSON.parse(written) as { vad: { floor_db: number; periodicity: number } }).vad).toMatchObject({ floor_db: vad.floor_db, periodicity: vad.periodicity });
  });

  it('finds the leak of a speech-like narrator only where channel 1 plays, at several levels', async () => {
    for (const [i, leakDb] of [2, 8, 12].entries()) {
      const { fx, session } = recordDoctor(`doctor-leak-${i}`, { leakDb, lrtMs: 40, seed: 11 + i });
      const r = await doctor(session, null);
      expect(Math.abs(r.analysis.leakDbOverFloor! - fx.truth.leakDb)).toBeLessThan(1);
      expect(r.analysis.checks.some((c) => c.name === 'leak')).toBe(leakDb > 6);
    }
  });

  it('writes calib.json and prints the report before the TTS self-test runs', async () => {
    const { dir, session } = recordDoctor('doctor-order');
    const out: string[] = [];
    let calibAtTts = false;
    let linesAtTts = 0;
    const r = await runDoctor(session, {
      out: (l) => out.push(l),
      env: env(),
      tts: async () => {
        calibAtTts = fs.existsSync(path.join(dir, 'calib.json'));
        linesAtTts = out.length;
        return TTS_OK;
      },
    });
    expect(calibAtTts).toBe(true);
    const before = out.slice(0, linesAtTts);
    expect(before.some((l) => l.startsWith('  {{VAD_FLOOR_DB}} = '))).toBe(true);
    expect(before.some((l) => l.startsWith('calib.json written'))).toBe(true);
    expect(before.some((l) => l.startsWith('DOCTOR'))).toBe(false);
    expect(last(out)).toBe('DOCTOR OK');
    expect(r.analysis.lines[r.analysis.lines.length - 1]).toBe('DOCTOR OK');
  });

  it('a hanging TTS self-test is stopped after its timeout; calib.json and DOCTOR OK do not wait for it', async () => {
    const { dir, session } = recordDoctor('doctor-hang');
    const script = hangingSelftest(root);
    const pidFile = path.join(root, 'hang-none.pid');
    const out: string[] = [];
    const t0 = Date.now();
    const r = await runDoctor(session, {
      out: (l) => out.push(l),
      env: env(),
      tts: () => runTtsSelftest({ command: [process.execPath, script, 'none', pidFile], timeoutMs: 1500, killGraceMs: 300, stderr: 'ignore' }),
    });
    expect(Date.now() - t0).toBeLessThan(6000);
    expect(r.code).toBe(EXIT_DOCTOR_OK);
    expect(last(out)).toBe('DOCTOR OK');
    expect(fs.existsSync(path.join(dir, 'calib.json'))).toBe(true);
    expect(out).toContain('  warn  TTS self-test failed: TTS self-test did not finish in 1.5 s; run npm run tts -- --selftest by hand');
    const grandchild = Number(fs.readFileSync(pidFile, 'utf8'));
    expect(await waitFor(() => processGone(grandchild), 3000)).toBe(true);
  });

  it('only warns on a leak over 6 dB, loop checks 3 ms apart and a failing TTS self-test', async () => {
    const { session } = recordDoctor('doctor-3', { leakDb: 8, lrtShiftBMs: 4.2 });
    const r = await doctor(session, interpretTtsSelftest('TTS SELFTEST FAIL: uv not found\n', 1));
    expect(r.code).toBe(EXIT_DOCTOR_OK);
    expect(last(r.out)).toBe('DOCTOR OK');
    const warnings = r.analysis.checks.filter((c) => !c.hard).map((c) => c.name);
    expect(warnings).toEqual(expect.arrayContaining(['leak', 'lrt_ab_diff', 'tts']));
    expect(r.out.some((l) => l.includes('uv is not installed'))).toBe(true);
    expect(r.out.some((l) => l.startsWith('  {{LRT_THRESHOLDS_CONFIRMED}} = not confirmed: A and B differ by 4.2 ms'))).toBe(true);
  });

  it('accepts the built-in microphone as the fallback of spec 5.1, with a warning, and writes calib.json', async () => {
    const { dir, session } = recordDoctor('doctor-4', { micLabel: 'MacBook Pro Microphone (Built-in)' });
    const r = await doctor(session);
    expect(r.code).toBe(EXIT_DOCTOR_OK);
    expect(last(r.out)).toBe('DOCTOR OK');
    expect(r.out).toContain('ok    microphone "MacBook Pro Microphone (Built-in)" is the built-in microphone, the fallback reference of spec 5.1');
    const warning = r.out.find((l) => l.startsWith('  warn  The built-in microphone is in use'));
    expect(warning).toMatch(/20-30 ms instead of 10-20 ms/);
    expect(readCalib(dir).L_rt_ms?.A).not.toBeNull();
  });

  it('fails on a Bluetooth microphone and does not write calib.json', async () => {
    const { dir, session } = recordDoctor('doctor-bt', { micLabel: 'AirPods Pro (Bluetooth)' });
    const r = await doctor(session);
    expect(r.code).toBe(EXIT_DOCTOR_FAIL);
    expect(last(r.out)).toMatch(/^DOCTOR FAIL: headset microphone not found: "AirPods Pro \(Bluetooth\)" is a Bluetooth device/);
    expect(r.out).toContain('calib.json not written: fix the problem and run npm run doctor again.');
    expect(fs.existsSync(path.join(dir, 'calib.json'))).toBe(false);
    // No params/frozen.json command from a failed run.
    expect(r.out.some((l) => l.includes('tools/freeze/frozen.ts'))).toBe(false);
    expect(r.out).toContain('params/frozen.json: no command from a failed doctor run; fix the problem and run npm run doctor again');
  });

  it('says that calib.json keeps only the output level when host wrote it before a failed run', async () => {
    const { dir, session } = recordDoctor('doctor-bt2', { micLabel: 'AirPods Pro (Bluetooth)' });
    // host writes output_gain into calib.json at the level step, before the report runs (spec 7.7)
    const withGain = { ...session, calib: { schema: 'calib/1', output_gain: 0.35 } } as typeof session;
    const r = await doctor(withGain);
    expect(r.code).toBe(EXIT_DOCTOR_FAIL);
    expect(r.out).toContain('calib.json keeps only the output level chosen in this run; L_rt, the leak and the voice detector values were not written: fix the problem and run npm run doctor again.');
    expect(r.out).not.toContain('calib.json not written: fix the problem and run npm run doctor again.');
    expect(fs.existsSync(path.join(dir, 'calib.json'))).toBe(false);
  });

  it('fails when the clicks of loop check B are not heard', async () => {
    const { fx, session } = recordDoctor('doctor-5');
    // Silence the microphone over loop check B: the clicks reach channel 1 only.
    session.ch0.fill(0, fx.truth.steps['loop_b']!, session.ch0.length);
    const r = await doctor(session);
    expect(last(r.out)).toBe('DOCTOR FAIL: clicks of loop check B not found: hold the earcup on the microphone during the clicks');
  });

  it('the level run changes only the gain and the leak, copying the rest from the latest full doctor', async () => {
    const full = recordDoctor('doctor-6', { lrtMs: 27.3, gain: 0.3 }, '2026-11-12T20:00:00Z');
    await doctor(full.session);
    const fullCalib = readCalib(full.dir);
    expect(latestSession('doctor', { env: env(), scenario: 'doctor' })).toBe('doctor-6');

    const level = recordDoctor('doctor-7', { scenario: 'doctor-level', leakDb: 5, gain: 0.5, lrtMs: 27.3 }, '2026-11-12T21:00:00Z');
    const r = await doctor(level.session, null);
    expect(r.code).toBe(EXIT_DOCTOR_OK);
    expect(r.out.some((l) => l.includes('copied from doctor-6'))).toBe(true);
    expect(r.out.some((l) => l.includes('TTS'))).toBe(false);
    expect(r.out.some((l) => l.includes('no L_rt to align with'))).toBe(false);
    const calib = readCalib(level.dir);
    expect(calib.L_rt_ms).toEqual(fullCalib.L_rt_ms);
    expect(calib['vad']).toEqual(fullCalib['vad']);
    expect(calib.output_gain).toBe(0.5);
    expect(Math.abs(calib.leak_db_over_floor! - 5)).toBeLessThan(1);

    // The level button never pressed: no level is chosen, the full doctor's level stays.
    const aborted = recordDoctor('doctor-8', { scenario: 'doctor-level', gain: 0.6, gainFinal: false }, '2026-11-12T22:00:00Z');
    const a = await doctor(aborted.session, null);
    expect(a.analysis.gain).toBeNull();
    expect(a.out.some((l) => l.startsWith('  warn  no output level was chosen in this run'))).toBe(true);
    expect(readCalib(aborted.dir).output_gain).toBe(0.3);
  });

  it('quickcheck hands a doctor recording to the doctor report', async () => {
    const { session } = recordDoctor('doctor-9');
    const out: string[] = [];
    const r = await runQuickcheck(session, { out: (l) => out.push(l), log: () => {}, env: env(), doctor: { tts: async () => TTS_OK } });
    expect(r.code).toBe(EXIT_DOCTOR_OK);
    expect(last(out)).toBe('DOCTOR OK');
  });

  it('the CLI takes the newest doctor folder, skips the TTS self-test on request and returns the exit code', async () => {
    const cliRoot = path.join(root, 'cli');
    fs.mkdirSync(cliRoot, { recursive: true });
    recordDoctor('doctor-1', { micLabel: 'AirPods Pro (Bluetooth)' }, '2026-11-12T19:00:00Z', cliRoot);
    recordDoctor('doctor-2', {}, '2026-11-13T08:00:00Z', cliRoot);
    const saved = { dir: process.env['COPYHOLDER_SESSIONS_DIR'], params: process.env['COPYHOLDER_PARAMS_FILE'] };
    const logs: string[] = [];
    const { log, error } = console;
    process.env['COPYHOLDER_SESSIONS_DIR'] = cliRoot;
    process.env['COPYHOLDER_PARAMS_FILE'] = path.join(root, 'no-params.json');
    console.log = (...a: unknown[]) => void logs.push(a.join(' '));
    console.error = () => {};
    try {
      expect(await main(['--skip-tts'])).toBe(EXIT_DOCTOR_OK);
      expect(logs[0]).toBe('Doctor report for doctor-2');
      expect(logs).toContain('TTS self-test: not run');
      expect(last(logs)).toBe('DOCTOR OK');
      expect(fs.existsSync(path.join(cliRoot, 'doctor-2', 'calib.json'))).toBe(true);

      logs.length = 0;
      expect(await main(['doctor-1', '--skip-tts'])).toBe(EXIT_DOCTOR_FAIL);
      expect(last(logs)).toMatch(/^DOCTOR FAIL: headset microphone not found/);

      logs.length = 0;
      expect(await main(['doctor-404', '--skip-tts'])).toBe(1);
      expect(last(logs)).toMatch(/^DOCTOR FAIL: the report crashed: No session folder/);

      process.env['COPYHOLDER_SESSIONS_DIR'] = path.join(root, 'empty');
      logs.length = 0;
      expect(await main(['--skip-tts'])).toBe(1);
      expect(logs).toEqual(['No doctor recording found. Record one with npm run doctor.']);
    } finally {
      console.log = log;
      console.error = error;
      for (const [k, v] of [['COPYHOLDER_SESSIONS_DIR', saved.dir], ['COPYHOLDER_PARAMS_FILE', saved.params]] as const) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  });
});

describe('doctor helpers', () => {
  it('formats the frozen.json command as doctor prints the values, or says why there is none', () => {
    expect(frozenParamsCommand('doctor-2', -58.24, 0.6000000000000001)).toBe('npx tsx tools/freeze/frozen.ts --doctor doctor-2 --floor-db -58.2 --periodicity 0.60');
    expect(frozenCommandLines('doctor-2', -61, 0.55, true)).toEqual([
      'params/frozen.json for gate-prereg from this doctor run (spec 7.3, 8.4):',
      '  npx tsx tools/freeze/frozen.ts --doctor doctor-2 --floor-db -61.0 --periodicity 0.55',
    ]);
    expect(frozenCommandLines('doctor-2', null, 0.5, true)).toEqual(['params/frozen.json: no command, the noise floor was not measured; run npm run doctor again']);
    expect(frozenCommandLines('doctor-2', -61, 0.5, false)[0]).toMatch(/^params\/frozen\.json: no command from a failed doctor run/);
  });

  it('takes the last final gain event and never a slider position', () => {
    expect(chosenGain([{ n: 1, e: 'gain', value: 0.5, final: false }, { n: 2, e: 'gain', value: 0.25, db: -12, final: true }, { n: 3, e: 'gain', value: 0.7, final: false }])).toEqual({ value: 0.25, db: -12 });
    expect(chosenGain([{ n: 1, e: 'gain', value: 0.5, final: false }])).toBeNull();
    expect(chosenGain([{ n: 1, e: 'gain', value: 0.5 }])).toBeNull();
    expect(chosenGain([])).toBeNull();
  });

  it('reads the TTS self-test line', () => {
    expect(interpretTtsSelftest('noise\nTTS SELFTEST OK 25 812\n', 0)).toMatchObject({ ok: true, line: 'TTS SELFTEST OK 25 812' });
    expect(interpretTtsSelftest('TTS SELFTEST OK 25 812\n', 1).ok).toBe(false);
    expect(interpretTtsSelftest('TTS SELFTEST FAIL: uv not found\n', 1).summary).toMatch(/^uv is not installed/);
    expect(interpretTtsSelftest('TTS SELFTEST FAIL: word count 24, expected 25\n', 1)).toMatchObject({ ok: false, summary: 'TTS SELFTEST FAIL: word count 24, expected 25' });
    expect(interpretTtsSelftest('', null, true).summary).toBe('TTS self-test did not finish in 8 minutes; run npm run tts -- --selftest by hand');
    expect(interpretTtsSelftest('Downloading torch\n', null, true, 90_000).summary).toBe('TTS self-test did not finish in 1.5 minutes; run npm run tts -- --selftest by hand');
    // The OK line came before the timeout: the self-test passed, only its exit hung.
    expect(interpretTtsSelftest('TTS SELFTEST OK 25 812\n', null, true, 3000)).toEqual({
      ok: true,
      line: 'TTS SELFTEST OK 25 812',
      summary: 'TTS SELFTEST OK 25 812 (it did not exit and was stopped after 3 s)',
    });
  });

  it('runTtsSelftest keeps an OK line printed before a hang and stops the whole process group', async () => {
    const script = hangingSelftest(root);
    const pidFile = path.join(root, 'hang-ok.pid');
    const t0 = Date.now();
    const r = await runTtsSelftest({ command: [process.execPath, script, 'ok', pidFile], timeoutMs: 1500, killGraceMs: 300, stderr: 'ignore' });
    expect(Date.now() - t0).toBeLessThan(5000);
    expect(r).toEqual({ ok: true, line: 'TTS SELFTEST OK 25 812', summary: 'TTS SELFTEST OK 25 812 (it did not exit and was stopped after 1.5 s)' });
    const grandchild = Number(fs.readFileSync(pidFile, 'utf8'));
    expect(await waitFor(() => processGone(grandchild), 3000)).toBe(true);
  });

  it('runTtsSelftest returns as soon as a quick self-test exits', async () => {
    const r = await runTtsSelftest({ command: [process.execPath, '-e', "console.log('TTS SELFTEST OK 25 700')"], timeoutMs: 20_000, stderr: 'ignore' });
    expect(r).toEqual({ ok: true, line: 'TTS SELFTEST OK 25 700', summary: 'TTS SELFTEST OK 25 700' });
  });

  it('the leak measure aligns channel 1 with channel 0 by L_rt and counts only steps where the narrator plays', () => {
    // 40 ms tone bursts every 100 ms in channel 1; channel 0 hears them 50 ms later, 6 dB over its noise.
    const rate = SAMPLE_RATE_HZ;
    const n = 4 * rate;
    const ch0 = new Float32Array(n);
    const ch1 = new Float32Array(n);
    const lag = Math.round(0.05 * rate);
    const noise = 0.001;
    const g = (noise * Math.sqrt(10 ** (6 / 10) - 1)) / 0.05;
    for (let i = 0; i < n; i++) {
      if (i % 4800 < 1920) ch1[i] = 0.05 * Math.SQRT2 * Math.sin((2 * Math.PI * 440 * i) / rate);
      if (i + lag < n) ch0[i + lag] = g * ch1[i]!;
    }
    addNoise(ch0, noise, mulberry32(5));
    const stamps: Stamp[] = [];
    for (let s = 0; s < n; s += CHUNK_SAMPLES) stamps.push({ n: s, k: 'chunk', frames: Math.min(CHUNK_SAMPLES, n - s) });
    const view: SessionView = { sampleRateHz: rate, ch0, ch1, stamps, samples: [], events: [], micSettings: null, layout: chunkLayout(stamps, n) };
    const floor = 10 * Math.log10(noise * noise);
    const aligned = narratorLeakDb(view, 0, n, 50)!;
    const unaligned = narratorLeakDb(view, 0, n, 0)!;
    expect(Math.abs(aligned.leakDb - floor - 6)).toBeLessThan(1);
    expect(aligned.activeSteps).toBeLessThan(0.5 * (n / 240));
    expect(unaligned.leakDb - floor).toBeLessThan(2);
  });
});
