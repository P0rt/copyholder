import { describe, expect, it } from 'vitest';
import { assertScenario, planTimeline, playGroups, samplesToMs, secondsToSamples, type CueStep, type Step } from './format.ts';
import { buildGateScenario, gateBlocks, gateCueErrors, gatePackOf, GATE_LAYOUT } from './gate.ts';
import { GATE_INSTRUCTION, instructionPlainText } from './instructions.ts';

// A cue list that follows spec 9.2: 14 cues, gaps 16-24 s, first >= 15 s, last <= 265 s.
const CUES_A = [15000, 31000, 55000, 71000, 92000, 110000, 130000, 147000, 167000, 185000, 205000, 223000, 244000, 262000];
const S = secondsToSamples;

/** Start of every step in samples from time 0:00 (the step marked origin), for steps after the SDK wait. */
function fromOrigin(steps: Step[]): Map<string, number> {
  const rows = planTimeline(steps).filter((r) => r.segment === 1);
  const origins = steps.filter((s) => s.origin === true);
  if (origins.length !== 1) throw new Error(`expected one origin step, found ${origins.length}`);
  const origin = rows.find((r) => r.name === origins[0]?.name)?.startSamples;
  if (origin === undefined) throw new Error('no origin');
  return new Map(rows.map((r) => [r.name, r.startSamples - origin]));
}

/** Running with kOk held 5 s before the scenario goes on (spec 7.1, assumption there). */
const SDK_OK_HOLD_S = 5;

function at(map: Map<string, number>, name: string): number {
  const v = map.get(name);
  if (v === undefined) throw new Error(`no step ${name}`);
  return v;
}

describe('gate scenario, packs A/B/C (spec 9.3)', () => {
  const steps = buildGateScenario('A', CUES_A);
  const t = fromOrigin(steps);

  it('is a valid scenario', () => {
    expect(() => assertScenario(steps)).not.toThrow();
  });

  it('starts with the SDK wait, Signal OK, loop check A and the 8 s rest, in that order', () => {
    expect(steps.slice(0, 6).map((s) => [s.k, s.name, s.text])).toEqual([
      ['wait', 'sdk_start', 'Starting camera...'],
      ['prompt', 'signal_ok', 'Signal OK'],
      ['prompt', 'loop_a_ready', 'Hold one earcup on the microphone'],
      ['clicks', 'loop_a', 'Hold one earcup on the microphone'],
      ['rest', 'headset', 'Headset on. Sit still.'],
      ['prompt', 'breathe_normally', 'Breathe normally'],
    ]);
    expect(steps[0]).toMatchObject({ until: 'sdk_ok', lenSamples: 0 });
    expect(steps[3]).toMatchObject({ block: 'A', lenSamples: S(12) });
    expect(steps[4]).toMatchObject({ lenSamples: S(8) });
    expect(steps[5]).toMatchObject({ origin: true });
    expect(at(t, 'loop_a')).toBe(-S(20));
    expect(at(t, 'headset')).toBe(-S(8));
    expect(at(t, 'signal_ok')).toBe(-S(27));
  });

  it('puts every block of the minute table at its time, in samples', () => {
    const table: Array<[string, number]> = [
      ['breathe_normally', 0],
      ['deep_1_in', 10],
      ['sniff_1_wait', 28],
      ['rest_1', 50],
      ['pa_start_1_closed', 55],
      ['rest_2', 70],
      ['listening', 75],
      ['objections', 255],
      ['pa_end_1_closed', 555],
      ['loop_b_ready', 570],
    ];
    for (const [name, seconds] of table) expect([name, at(t, name)]).toEqual([name, S(seconds)]);
    expect(at(t, 'loop_b')).toBe(S(575));
    expect(at(t, 'end')).toBe(S(587));
    expect(steps.find((s) => s.name === 'rest_1')).toMatchObject({ text: 'Rest', lenSamples: S(5) });
    expect(steps.find((s) => s.name === 'rest_2')).toMatchObject({ text: 'Rest', lenSamples: S(5) });
  });

  it('cues three deep breaths: 2 s in with the bar growing, 4 s out with it shrinking', () => {
    const deep = steps.filter((s) => s.name.startsWith('deep_'));
    expect(deep.map((s) => [s.name, s.text, s.lenSamples, s.k === 'prompt' ? s.bar : undefined])).toEqual([
      ['deep_1_in', 'Breathe in', S(2), 'grow'],
      ['deep_1_out', 'Breathe out', S(4), 'shrink'],
      ['deep_2_in', 'Breathe in', S(2), 'grow'],
      ['deep_2_out', 'Breathe out', S(4), 'shrink'],
      ['deep_3_in', 'Breathe in', S(2), 'grow'],
      ['deep_3_out', 'Breathe out', S(4), 'shrink'],
    ]);
    expect(at(t, 'deep_3_out') + S(4)).toBe(S(28));
  });

  it("cues five sniffs: 'Breathe out and wait', then 'Sniff' 1.5 s later", () => {
    for (let i = 1; i <= 5; i += 1) {
      const wait = at(t, `sniff_${i}_wait`);
      expect(wait).toBe(S(28) + (i - 1) * S(4.4));
      expect(at(t, `sniff_${i}`) - wait).toBe(S(1.5));
    }
    expect(steps.filter((s) => s.text === 'Sniff')).toHaveLength(5);
    expect(steps.filter((s) => s.text === 'Breathe out and wait')).toHaveLength(5);
  });

  it("has two blocks of five 'pa', each 'Lips closed' then 'pa', 15 s long", () => {
    for (const [tag, start] of [['pa_start', 55], ['pa_end', 555]] as const) {
      for (let i = 1; i <= 5; i += 1) {
        expect(at(t, `${tag}_${i}_closed`)).toBe(S(start) + (i - 1) * S(3));
        expect(at(t, `${tag}_${i}`)).toBe(S(start) + (i - 1) * S(3) + S(1.5));
      }
    }
    expect(steps.filter((s) => s.text === 'pa')).toHaveLength(10);
    expect(steps.filter((s) => s.text === 'Lips closed')).toHaveLength(10);
  });

  it('plays the listening clip for 180 s and the objection clip from 4:15, with only the dot on screen', () => {
    const listen = steps.find((s) => s.name === 'listening');
    const objections = steps.find((s) => s.name === 'objections');
    expect(listen).toMatchObject({ k: 'play', clip: 'listen.wav', text: '', lenSamples: S(180) });
    expect(objections).toMatchObject({ k: 'play', clip: 'objections.wav', text: '' });
    const groups = playGroups(steps);
    expect(groups.map((g) => [g.name, g.lenSamples])).toEqual([
      ['listening', S(180)],
      ['objections', S(300)],
    ]);
  });

  it('fills the dot for 1.5 s at each of the 14 cues of the list', () => {
    const cues = steps.filter((s): s is CueStep => s.k === 'cue');
    expect(cues).toHaveLength(28);
    CUES_A.forEach((ms, idx) => {
      const i = idx + 1;
      expect(at(t, `cue_${i}_on`)).toBe(S(255) + ms * 48);
      expect(at(t, `cue_${i}_off`)).toBe(S(255) + ms * 48 + S(1.5));
    });
    expect(cues.every((c) => c.text === '')).toBe(true);
    expect(cues.map((c) => c.on)).toEqual(CUES_A.flatMap(() => [true, false]));
  });

  it('ends with loop check B and the end step', () => {
    expect(steps.slice(-3).map((s) => [s.k, s.name])).toEqual([
      ['prompt', 'loop_b_ready'],
      ['clicks', 'loop_b'],
      ['end', 'end'],
    ]);
    expect(steps.at(-2)).toMatchObject({ block: 'B', lenSamples: S(12) });
  });

  it('builds packs B and C the same way', () => {
    expect(buildGateScenario('B', CUES_A).map((s) => s.name)).toEqual(steps.map((s) => s.name));
    expect(GATE_LAYOUT.C).toEqual(GATE_LAYOUT.A);
  });

  it('never cuts a clip: a longer clip stretches its block and moves the later steps', () => {
    const clips = { listen: S(182.5), objections: S(303) };
    expect(gateBlocks('A', clips)).toEqual({ listenSamples: S(182.5), objectionSamples: S(303) });
    const long = fromOrigin(buildGateScenario('A', CUES_A, clips));
    expect(at(long, 'objections')).toBe(S(75 + 182.5));
    expect(at(long, 'cue_1_on')).toBe(S(75 + 182.5) + CUES_A[0]! * 48);
    expect(at(long, 'pa_end_1_closed')).toBe(S(75 + 182.5 + 303));
    // Shorter clips keep the table: the rest of the block is silence.
    expect(gateBlocks('A', { listen: S(170), objections: S(290) })).toEqual({ listenSamples: S(180), objectionSamples: S(300) });
  });
});

describe('cue list rules (spec 9.2)', () => {
  it('accepts a list that follows them', () => {
    expect(gateCueErrors('A', CUES_A)).toEqual([]);
  });

  it('rejects a wrong count, an early first cue, a late last cue and gaps outside 16-24 s', () => {
    expect(gateCueErrors('A', CUES_A.slice(1)).join()).toMatch(/14 cues/);
    expect(gateCueErrors('A', [14000, ...CUES_A.slice(1)]).join()).toMatch(/earlier than 15 s/);
    expect(gateCueErrors('A', [...CUES_A.slice(0, 13), 266000]).join()).toMatch(/later than 265 s/);
    expect(gateCueErrors('A', [...CUES_A.slice(0, 13), 248000 + 30000]).join()).toMatch(/outside 16-24 s/);
    expect(gateCueErrors('A', [...CUES_A.slice(0, 12), 262000, 244000]).join()).toMatch(/increase/);
    expect(gateCueErrors('A', ['15000', ...CUES_A.slice(1)]).join()).toMatch(/not a time in ms/);
    expect(() => buildGateScenario('A', [])).toThrow(/cues\.json/);
  });
});

describe('pack 0 (spec 9.4)', () => {
  const cues = [18000, 36000];
  const steps = buildGateScenario('0', cues);
  const t = fromOrigin(steps);

  it('follows the gate path with three deep breaths, two sniffs, two pa, 30 s listening and two cues', () => {
    expect(steps.filter((s) => s.text === 'Breathe in')).toHaveLength(3);
    expect(steps.filter((s) => s.text === 'Sniff')).toHaveLength(2);
    expect(steps.filter((s) => s.text === 'pa').map((s) => s.name)).toEqual(['pa_start_1', 'pa_end_1']);
    expect(steps.find((s) => s.name === 'listening')).toMatchObject({ lenSamples: S(30) });
    expect(steps.filter((s) => s.k === 'cue' && s.on)).toHaveLength(2);
    expect(steps.filter((s) => s.k === 'clicks').map((s) => s.name)).toEqual(['loop_a', 'loop_b']);
    expect(steps[0]).toMatchObject({ k: 'wait', until: 'sdk_ok' });
    expect(() => assertScenario(steps)).not.toThrow();
  });

  it('keeps only the path of 9.4: no Breathe normally, one rest, right before listening', () => {
    expect(steps.map((s) => s.name)).not.toContain('breathe_normally');
    expect(steps.filter((s) => s.k === 'rest').map((s) => s.name)).toEqual(['headset', 'rest_2']);
    const iListen = steps.findIndex((s) => s.name === 'listening');
    expect(steps[iListen - 1]).toMatchObject({ k: 'rest', name: 'rest_2', text: 'Rest', lenSamples: S(5) });
    // 0:00 is the first scenario prompt, the first deep breath, right after the headset step.
    expect(steps.filter((s) => s.origin).map((s) => s.name)).toEqual(['deep_1_in']);
    expect(at(t, 'headset')).toBe(-S(8));
    expect(at(t, 'loop_a')).toBe(-S(20));
    expect(at(t, 'signal_ok')).toBe(-S(27));
  });

  it('runs breaths, sniffs, pa, rest, listening, objections, pa and loop check B back to back, in samples', () => {
    const table: Array<[string, number]> = [
      ['deep_1_in', 0],
      ['sniff_1_wait', 18],
      ['sniff_1', 19.5],
      ['sniff_2_wait', 22.4],
      ['pa_start_1_closed', 26.8],
      ['pa_start_1', 28.3],
      ['rest_2', 29.8],
      ['listening', 34.8],
      ['objections', 64.8],
      ['pa_end_1_closed', 109.8],
      ['loop_b_ready', 112.8],
      ['loop_b', 117.8],
      ['end', 129.8],
    ];
    expect(table.map(([name]) => [name, at(t, name)])).toEqual(table.map(([name, s]) => [name, S(s)]));
    expect(at(t, 'cue_1_on')).toBe(at(t, 'objections') + 18000 * 48);
    expect(at(t, 'cue_2_off')).toBe(at(t, 'objections') + 36000 * 48 + S(1.5));
  });

  it('plans about 2.5 minutes of camera (spec 9.4, 11.2), a longer clip stretching its block', () => {
    const planned = (s: Step[]) => {
      const end = planTimeline(s).find((r) => r.name === 'end');
      if (end?.segment !== 1) throw new Error('end is not in the segment after the SDK wait');
      return end.startSamples;
    };
    // Camera time: the SDK wait (Running, then kOk held 5 s) and every step after it, to the end step.
    expect(planned(steps)).toBe(S(156.8));
    expect(S(SDK_OK_HOLD_S) + planned(steps)).toBeLessThanOrEqual(S(2.75 * 60));
    // The pack's own clips (about 31 s and 54 s, gate/README.md) set their blocks.
    expect(planned(buildGateScenario('0', cues, { listen: S(31), objections: S(54) }))).toBe(S(166.8));
  });

  it('checks the two-cue list with the same rules', () => {
    expect(gateCueErrors('0', cues)).toEqual([]);
    expect(gateCueErrors('0', [15000]).join()).toMatch(/2 cues/);
    expect(gateCueErrors('0', [15000, 59000]).join()).toMatch(/ends after/);
    expect(gateCueErrors('0', [10000, 26000]).join()).toMatch(/earlier than 15 s/);
    // The shortest list the rules allow fits the planned block with the 10 s voice window after it.
    expect(gateCueErrors('0', [15000, 31000])).toEqual([]);
    expect(31_000 + 1_500 + 10_000).toBeLessThanOrEqual(samplesToMs(GATE_LAYOUT['0'].objectionSamples));
  });
});

describe('gate pack names and the instruction text', () => {
  it('reads the pack from a scenario name', () => {
    expect(['gate-A', 'gate-b', 'pack-0', 'gate-pack-C', 'A', 'gate_0'].map(gatePackOf)).toEqual(['A', 'B', '0', 'C', 'A', '0']);
    expect(gatePackOf('gate-D')).toBeNull();
    expect(gatePackOf('session')).toBeNull();
  });

  it('keeps the instruction of spec 9.2 verbatim', () => {
    expect(instructionPlainText(GATE_INSTRUCTION)).toBe(
      [
        'The recording takes about ten minutes. The narrator never stops.',
        '',
        '1. Minute one: follow the prompts.',
        '2. Three minutes: listen, stay silent.',
        '3. Five minutes: 14 obvious mistakes. When the dot under the camera fills, say the correction aloud, three to five words.',
        '',
        'Correct the narrator as you would correct a person.',
        'Do not think about breathing.',
        'If you did not catch what was wrong, say: "No, that was wrong."',
        '',
        'Sit still, eyes on the dot.   [ Start ]',
      ].join('\n'),
    );
  });
});
