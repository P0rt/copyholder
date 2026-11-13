import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { buildDoctorLevelScenario, buildDoctorScenario, DOCTOR_LOOP_GAP_SECONDS } from './doctor.ts';
import { planTimeline, scenarioErrors, secondsToSamples, type Step } from './format.ts';
import { buildGateScenario } from './gate.ts';
import { ScenarioRunner, type StepStart } from './runner.ts';
import { buildSmokeScenario } from './smoke.ts';

const S = secondsToSamples;
const QUANTUM = 128;
const CUES_A = [15000, 31000, 55000, 71000, 92000, 110000, 130000, 147000, 167000, 185000, 205000, 223000, 244000, 262000];

/** Drives a runner one render quantum at a time, as Deck does, releasing each wait after waitSamples. */
function drive(steps: Step[], n0: number, waitSamples: (name: string) => number, quantum = QUANTUM): StepStart[] {
  const runner = new ScenarioRunner(steps);
  runner.start(n0);
  const out: StepStart[] = [];
  let n = n0 - (n0 % quantum);
  let releaseAt: number | null = null;
  for (let guard = 0; guard < 10_000_000 && !runner.finished; guard += 1) {
    if (releaseAt !== null && n >= releaseAt) {
      expect(runner.go(n)).toBe(true);
      releaseAt = null;
    }
    for (const s of runner.advance(n + quantum)) {
      out.push(s);
      if (s.step.k === 'wait') releaseAt = s.n + waitSamples(s.step.name);
    }
    n += quantum;
  }
  expect(runner.finished).toBe(true);
  return out;
}

function startOf(starts: StepStart[], name: string): number {
  const s = starts.find((x) => x.step.name === name);
  if (!s) throw new Error(`step ${name} never started`);
  return s.n;
}

describe('ScenarioRunner', () => {
  const tiny: Step[] = [
    { k: 'prompt', name: 'a', text: 'A', lenSamples: 300 },
    { k: 'wait', name: 'w', text: 'W', lenSamples: 0, until: 'button', button: 'Go' },
    { k: 'cue', name: 'c_on', text: '', lenSamples: 0, i: 1, on: true },
    { k: 'cue', name: 'c_off', text: '', lenSamples: 50, i: 1, on: false },
    { k: 'end', name: 'end', text: 'E', lenSamples: 0 },
  ];

  it('reports each start with its exact sample, inside the quantum that contains it', () => {
    const r = new ScenarioRunner(tiny);
    r.start(1000);
    expect(r.advance(1000)).toEqual([]);
    expect(r.advance(1128).map((s) => [s.step.name, s.n])).toEqual([['a', 1000]]);
    expect(r.advance(1256)).toEqual([]);
    expect(r.advance(1384).map((s) => [s.step.name, s.n])).toEqual([['w', 1300]]);
    expect(r.waiting?.name).toBe('w');
    expect(r.advance(5000)).toEqual([]);
  });

  it('starts the step after a wait at the sample where go is handled', () => {
    const r = new ScenarioRunner(tiny);
    r.start(0);
    r.advance(400);
    expect(r.go(1536)).toBe(true);
    expect(r.go(1600)).toBe(false);
    expect(r.advance(1664).map((s) => [s.step.name, s.n])).toEqual([
      ['c_on', 1536],
      ['c_off', 1536],
      ['end', 1586],
    ]);
    expect(r.finished).toBe(true);
    expect(r.startOf('c_off')).toBe(1536);
  });

  it('ignores go when nothing waits and stops on stop()', () => {
    const r = new ScenarioRunner(tiny);
    r.start(0);
    expect(r.go(10)).toBe(false);
    r.advance(100);
    r.stop();
    expect(r.advance(1_000_000)).toEqual([]);
    expect(r.finished).toBe(true);
  });

  it('waits for the clip end on an untilClipEnd play step', () => {
    const steps: Step[] = [
      { k: 'play', name: 'p1', text: '', lenSamples: 0, clip: 'p1.wav', untilClipEnd: true, status: 'Passage 1 of 3' },
      { k: 'end', name: 'end', text: '', lenSamples: 0 },
    ];
    const r = new ScenarioRunner(steps);
    r.start(0);
    expect(r.advance(10_000).map((s) => s.step.name)).toEqual(['p1']);
    expect(r.go(500)).toBe(false);
    expect(r.clipEnded(9000)).toBe(true);
    expect(r.advance(9128).map((s) => [s.step.name, s.n])).toEqual([['end', 9000]]);
  });

  it('rejects invalid scenarios', () => {
    expect(() => new ScenarioRunner([])).toThrow();
    const bad: Step[] = [
      { k: 'cue', name: 'x', text: '', lenSamples: 1, i: 1, on: true },
      { k: 'wait', name: 'y', text: '', lenSamples: 5, until: 'button' },
      { k: 'prompt', name: 'x', text: '', lenSamples: -1 },
    ];
    const errors = scenarioErrors(bad).join('\n');
    expect(errors).toMatch(/duplicate name/);
    expect(errors).toMatch(/wait steps have lenSamples 0/);
    expect(errors).toMatch(/button wait without a label/);
    expect(errors).toMatch(/non-negative/);
    expect(errors).toMatch(/last step must be end/);
    expect(errors).toMatch(/cue 1 is never turned off/);
  });

  it('rejects a wait that the page never releases (only sdk_ok and button send go)', () => {
    const steps = [
      { k: 'wait', name: 'preflight', text: '', lenSamples: 0, until: 'preflight' },
      { k: 'end', name: 'end', text: '', lenSamples: 0 },
    ] as unknown as Step[];
    expect(scenarioErrors(steps)).toEqual(['step 0 (preflight): nothing releases a wait until preflight (only sdk_ok, button)']);
    expect(() => new ScenarioRunner(steps)).toThrow(/nothing releases a wait until preflight/);
  });

  it('runs the gate scenario quantum by quantum to the samples the plan gives', () => {
    const steps = buildGateScenario('A', CUES_A);
    const sdkWait = 777 * QUANTUM + 5;
    const starts = drive(steps, 4096, () => sdkWait);
    const plan = planTimeline(steps);
    const release = startOf(starts, 'signal_ok');
    expect(release - 4096).toBeGreaterThanOrEqual(sdkWait);
    expect(release - 4096).toBeLessThan(sdkWait + QUANTUM);
    expect(starts.map((s) => s.step.name)).toEqual(steps.map((s) => s.name));
    for (const row of plan.filter((r) => r.segment === 1)) {
      expect([row.name, starts[row.index]?.n]).toEqual([row.name, release + row.startSamples]);
    }
  });

  it('starts the clicks of loop check B five minutes after those of A in doctor, whatever the level choice took', () => {
    const steps = buildDoctorScenario();
    for (const levelWait of [S(3), S(150)]) {
      const starts = drive(steps, 0, (name) => (name === 'level_choice' ? levelWait : S(1)));
      expect(startOf(starts, 'leak') - startOf(starts, 'level_choice')).toBeGreaterThanOrEqual(levelWait);
      expect(startOf(starts, 'loop_b') - startOf(starts, 'loop_a')).toBe(S(DOCTOR_LOOP_GAP_SECONDS));
      expect(startOf(starts, 'loop_b') - startOf(starts, 'loop_b_ready')).toBe(S(5));
    }
  });

  it('starts loop check B at once after a level choice slower than the five minutes allow', () => {
    const steps = buildDoctorScenario();
    const starts = drive(steps, 0, (name) => (name === 'level_choice' ? S(400) : S(1)));
    expect(startOf(starts, 'loop_b_ready')).toBe(startOf(starts, 'wait_b'));
    expect(startOf(starts, 'loop_b') - startOf(starts, 'loop_a')).toBeGreaterThan(S(DOCTOR_LOOP_GAP_SECONDS));
  });

  it('starts loop check B exactly five minutes after A when there is no volume sample', () => {
    const steps = buildDoctorScenario(null);
    expect(steps.some((s) => s.k === 'play')).toBe(false);
    const starts = drive(steps, 0, () => S(2));
    expect(startOf(starts, 'loop_b') - startOf(starts, 'loop_a')).toBe(S(DOCTOR_LOOP_GAP_SECONDS));
  });

  it('runs an align step to start(anchor) + offset, or at once when that has passed', () => {
    const steps: Step[] = [
      { k: 'prompt', name: 'a', text: '', lenSamples: 1000 },
      { k: 'prompt', name: 'b', text: '', lenSamples: 500 },
      { k: 'align', name: 'hold', text: '', lenSamples: 0, anchor: 'a', offsetSamples: 4000 },
      { k: 'prompt', name: 'c', text: '', lenSamples: 300 },
      { k: 'align', name: 'late', text: '', lenSamples: 0, anchor: 'a', offsetSamples: 10 },
      { k: 'end', name: 'end', text: '', lenSamples: 0 },
    ];
    const r = new ScenarioRunner(steps);
    r.start(100);
    expect(r.advance(100_000).map((s) => [s.step.name, s.n])).toEqual([
      ['a', 100],
      ['b', 1100],
      ['hold', 1600],
      ['c', 4100],
      ['late', 4400],
      ['end', 4400],
    ]);
    expect(planTimeline(steps).map((row) => [row.name, row.segment, row.startSamples])).toEqual([
      ['a', 0, 0],
      ['b', 0, 1000],
      ['hold', 0, 1500],
      ['c', 0, 4000],
      ['late', 0, 4300],
      ['end', 0, 4300],
    ]);
    expect(scenarioErrors([{ ...steps[2]!, anchor: 'nowhere' } as Step, steps[5]!]).join()).toMatch(/not an earlier step/);
  });

  it('is causal: a later go never changes the steps before it (property)', () => {
    const steps = buildDoctorLevelScenario();
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 2_000_000 }), fc.integer({ min: 64, max: 4096 }), (wait, quantum) => {
        const starts = drive(steps, 0, () => wait, quantum);
        const choice = steps.findIndex((s) => s.name === 'level_choice');
        const plan = planTimeline(steps);
        for (const row of plan.slice(0, choice + 1)) expect(starts[row.index]?.n).toBe(row.startSamples);
        const released = starts[choice + 1]?.n ?? NaN;
        expect(released).toBeGreaterThanOrEqual((starts[choice]?.n ?? 0) + wait);
        expect(released - ((starts[choice]?.n ?? 0) + wait)).toBeLessThanOrEqual(quantum);
      }),
      { numRuns: 60 },
    );
  });
});

describe('doctor and smoke scenarios (spec 7.12)', () => {
  it('doctor has device names first, loop checks A and B, the level choice and three loud inhales; no camera wait', () => {
    const steps = buildDoctorScenario();
    expect(steps[0]).toMatchObject({ k: 'wait', name: 'devices', until: 'button' });
    expect(steps.some((s) => s.k === 'wait' && s.until === 'sdk_ok')).toBe(false);
    expect(steps.filter((s) => s.k === 'clicks').map((s) => s.name)).toEqual(['loop_a', 'loop_b']);
    expect(steps.findIndex((s) => s.name === 'loop_a')).toBeLessThan(steps.findIndex((s) => s.name === 'level_sample'));
    const sample = steps.find((s) => s.name === 'level_sample');
    expect(sample).toMatchObject({ k: 'play', clip: 'level.wav', lenSamples: S(20), levels: true });
    expect(steps.find((s) => s.name === 'level_choice')).toMatchObject({ k: 'wait', until: 'button', levels: true });
    expect(steps.find((s) => s.name === 'leak')).toMatchObject({ k: 'play', clip: 'level.wav' });
    const inhales = steps.filter((s) => s.name.startsWith('inhale_'));
    expect(inhales.filter((s) => s.text === 'Breathe in loudly')).toHaveLength(3);
    expect(inhales.reduce((sum, s) => sum + s.lenSamples, 0)).toBe(S(10));
  });

  it('doctor stretches the sample steps to a longer clip and keeps the five minutes', () => {
    const steps = buildDoctorScenario('level.wav', S(23));
    expect(steps.find((s) => s.name === 'level_sample')?.lenSamples).toBe(S(23));
    const starts = drive(steps, 0, () => 0);
    expect(startOf(starts, 'loop_b') - startOf(starts, 'loop_a')).toBe(S(DOCTOR_LOOP_GAP_SECONDS));
  });

  it('doctor --level repeats only the level step and the leak measurement', () => {
    const names = buildDoctorLevelScenario().map((s) => s.name);
    expect(names).toEqual(['headset', 'floor', 'level_sample', 'level_sample_again', 'level_choice', 'leak', 'end']);
  });

  it('smoke has three cued deep breaths, a quiet minute, a 2 s lens cover last, and runs about two minutes', () => {
    const steps = buildSmokeScenario();
    expect(steps[0]).toMatchObject({ k: 'wait', until: 'sdk_ok' });
    expect(steps.filter((s) => s.k === 'prompt' && s.bar === 'grow')).toHaveLength(3);
    expect(steps.find((s) => s.name === 'quiet')).toMatchObject({ lenSamples: S(60) });
    expect(steps.find((s) => s.name === 'lens_cover')).toMatchObject({ text: 'Cover the lens', lenSamples: S(2) });
    expect(steps.at(-2)?.name).toBe('lens_uncover');
    expect(steps.some((s) => s.k === 'play' || s.k === 'clicks')).toBe(false);
    const total = steps.reduce((sum, s) => sum + s.lenSamples, 0);
    expect(total).toBeGreaterThanOrEqual(S(100));
    expect(total).toBeLessThanOrEqual(S(130));
  });
});
