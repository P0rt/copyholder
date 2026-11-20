import { describe, expect, it } from 'vitest';
import { scenarioProblems } from '../lib/deck-scenario.ts';
import { planTimeline, secondsToSamples, type ClicksStep, type PlayStep, type Step } from './format.ts';
import { parseConfig } from '../ui/config.ts';
import { buildHeadstartScenario, clipStepName, HEADSTART_SECONDS, HEADSTART_TEXT, headstartClips, signalCheckSteps } from './headstart.ts';
import { scenarioFor, timingsNameFor, type ScenarioPlan } from './index.ts';
import { HEADSTART_INSTRUCTION, instructionPlainText } from './instructions.ts';

const S = secondsToSamples;
const SAMPLE_FILES = ['opening.wav', 'p1.wav', 'p2.wav', 'timings.json'];
const CLIP_SAMPLES = new Map<string, number>([
  ['opening.wav', S(7.5)],
  ['p1.wav', S(41)],
  ['p2.wav', S(38.25)],
  ['p3.wav', S(44)],
]);

function step(steps: readonly Step[], name: string): Step {
  const s = steps.find((x) => x.name === name);
  if (!s) throw new Error(`no step ${name}`);
  return s;
}

function plan(narrator: readonly string[], lensCheck?: boolean): ScenarioPlan {
  const p = scenarioFor({ mode: 'headstart', scenario: 'headstart', narrator, ...(lensCheck === undefined ? {} : { lensCheck }) });
  if (typeof p === 'string') throw new Error(p);
  return p;
}

describe('headstart scenario (spec 6.5, 7.11, 15.1, 15.2)', () => {
  const clips = headstartClips(SAMPLE_FILES);
  const steps = buildHeadstartScenario(clips, CLIP_SAMPLES);

  it('reads the opening, then p1 and p2; p3 only when host serves it', () => {
    expect(clips).toEqual(['opening.wav', 'p1.wav', 'p2.wav']);
    expect(headstartClips([...SAMPLE_FILES, 'p3.wav'])).toEqual(['opening.wav', 'p1.wav', 'p2.wav', 'p3.wav']);
    // Reading order is fixed whatever order host lists the files in.
    expect(headstartClips(['p3.wav', 'timings.json', 'p2.wav', 'opening.wav', 'p1.wav'])).toEqual(['opening.wav', 'p1.wav', 'p2.wav', 'p3.wav']);
    expect(clipStepName('opening.wav')).toBe('opening');
    expect(clipStepName('p2.wav')).toBe('p2');
  });

  it('is a valid scenario that Deck runs in live mode', () => {
    expect(scenarioProblems(steps, { narratorStops: true })).toEqual([]);
  });

  it('has the steps of the take in order', () => {
    expect(steps.map((s) => s.name)).toEqual([
      'sdk_start',
      'signal_ok',
      'loop_a_ready',
      'loop_a',
      'headset',
      'breathe_normally',
      'deep_1_in',
      'deep_1_out',
      'deep_2_in',
      'deep_2_out',
      'deep_3_in',
      'deep_3_out',
      'rest_1',
      'opening',
      'demo_clicks',
      'p1',
      'p2',
      'summary',
      'signal_in',
      'signal_out',
      'lens_cover',
      'lens_uncover',
      'loop_b_ready',
      'loop_b',
      'end',
    ]);
    expect(steps.filter((s) => s.origin === true).map((s) => s.name)).toEqual(['signal_ok']);
    expect(step(steps, 'sdk_start')).toMatchObject({ k: 'wait', until: 'sdk_ok', lenSamples: 0 });
    expect(step(steps, 'end')).toMatchObject({ k: 'end', text: HEADSTART_TEXT.done, lenSamples: 0 });
  });

  it('sets the lengths of the prompts, the breaths, the clicks, the summary and the signal check', () => {
    const lengths = Object.fromEntries(steps.map((s) => [s.name, s.lenSamples]));
    expect(lengths).toMatchObject({
      signal_ok: S(2),
      loop_a_ready: S(5),
      loop_a: S(12),
      headset: S(8),
      breathe_normally: S(10),
      deep_1_in: S(2),
      deep_1_out: S(4),
      deep_2_in: S(2),
      deep_2_out: S(4),
      deep_3_in: S(2),
      deep_3_out: S(4),
      rest_1: S(5),
      demo_clicks: S(3),
      summary: S(10),
      signal_in: S(2),
      signal_out: S(4),
      lens_cover: S(2),
      lens_uncover: S(5),
      loop_b_ready: S(5),
      loop_b: S(12),
    });
    for (let i = 1; i <= 3; i++) {
      expect(step(steps, `deep_${i}_in`)).toMatchObject({ k: 'prompt', text: 'Breathe in', bar: 'grow' });
      expect(step(steps, `deep_${i}_out`)).toMatchObject({ k: 'prompt', text: 'Breathe out', bar: 'shrink' });
    }
    expect(step(steps, 'signal_in')).toMatchObject({ k: 'prompt', text: 'Breathe in', bar: 'grow', status: 'Signal check' });
    expect(step(steps, 'signal_out')).toMatchObject({ k: 'prompt', text: 'Breathe out', bar: 'shrink', status: 'Signal check' });
    expect(step(steps, 'lens_cover')).toMatchObject({ text: 'Cover the lens', status: 'Signal check' });
    expect(step(steps, 'lens_uncover')).toMatchObject({ text: 'Uncover the lens', status: 'Signal check' });
    expect(step(steps, 'summary')).toMatchObject({ k: 'prompt', text: 'Summary of this take', status: 'Summary of this take' });
    expect(HEADSTART_SECONDS.summary).toBe(10);
  });

  it('opens the shown part with the three demo sync clicks 3 s before the first passage, after the opening (spec 15.1, 15.4)', () => {
    const clicks = step(steps, 'demo_clicks') as ClicksStep;
    expect(clicks).toMatchObject({ k: 'clicks', block: 'demo', lenSamples: S(3), text: 'Listen', status: 'Live demo' });
    // D1 learns ordinary breaths while the opening plays (spec 7.4); the shown part starts with the passage.
    expect(steps[steps.indexOf(clicks) - 1]?.name).toBe('opening');
    expect(steps[steps.indexOf(clicks) + 1]?.name).toBe('p1');
    const withP3 = buildHeadstartScenario(headstartClips([...SAMPLE_FILES, 'p3.wav']), CLIP_SAMPLES);
    expect(withP3.map((s) => s.name).slice(withP3.findIndex((s) => s.name === 'opening'), withP3.findIndex((s) => s.name === 'summary'))).toEqual([
      'opening',
      'demo_clicks',
      'p1',
      'p2',
      'p3',
    ]);
    expect(steps.filter((s) => s.k === 'clicks').map((s) => [s.name, (s as ClicksStep).block])).toEqual([
      ['loop_a', 'A'],
      ['demo_clicks', 'demo'],
      ['loop_b', 'B'],
    ]);
  });

  it('plays every clip to its end with no text on screen; the step lasts the clip (spec 6.4, 7.8)', () => {
    const plays = steps.filter((s): s is PlayStep => s.k === 'play');
    expect(plays.map((p) => [p.name, p.clip, p.lenSamples, p.untilClipEnd, p.text, p.status])).toEqual([
      ['opening', 'opening.wav', S(7.5), true, '', 'Opening'],
      ['p1', 'p1.wav', S(41), true, '', 'Passage 1 of 2'],
      ['p2', 'p2.wav', S(38.25), true, '', 'Passage 2 of 2'],
    ]);
    const withP3 = buildHeadstartScenario(headstartClips([...SAMPLE_FILES, 'p3.wav']), CLIP_SAMPLES).filter((s): s is PlayStep => s.k === 'play');
    expect(withP3.map((p) => [p.name, p.lenSamples, p.status])).toEqual([
      ['opening', S(7.5), 'Opening'],
      ['p1', S(41), 'Passage 1 of 3'],
      ['p2', S(38.25), 'Passage 2 of 3'],
      ['p3', S(44), 'Passage 3 of 3'],
    ]);
  });

  it('labels the status line Live demo outside the reading, the summary and the signal check', () => {
    const before = steps.slice(0, steps.findIndex((s) => s.name === 'opening'));
    expect(new Set(before.map((s) => s.status))).toEqual(new Set(['Live demo']));
    expect(step(steps, 'demo_clicks').status).toBe('Live demo');
    expect(step(steps, 'loop_b_ready').status).toBe('Live demo');
    expect(step(steps, 'loop_b').status).toBe('Live demo');
  });

  it('puts the breaths at fixed times after Signal OK; each clip starts a new segment', () => {
    const rows = planTimeline(steps);
    const at = (name: string) => rows.find((r) => r.name === name);
    // Segment 1 starts after the SDK wait, at Signal OK.
    expect(at('signal_ok')).toMatchObject({ segment: 1, startSamples: 0 });
    expect(at('loop_a')?.startSamples).toBe(S(7));
    expect(at('breathe_normally')?.startSamples).toBe(S(27));
    expect(at('deep_1_in')?.startSamples).toBe(S(37));
    expect(at('deep_3_out')?.startSamples).toBe(S(51));
    expect(at('rest_1')?.startSamples).toBe(S(55));
    expect(at('opening')).toMatchObject({ segment: 1, startSamples: S(60) });
    // The demo clicks start where the opening ends; the first passage 3 s later.
    expect(at('demo_clicks')).toMatchObject({ segment: 2, startSamples: 0 });
    expect(at('p1')).toMatchObject({ segment: 2, startSamples: S(3) });
    expect(at('p2')).toMatchObject({ segment: 3, startSamples: 0 });
    expect(at('summary')).toMatchObject({ segment: 4, startSamples: 0 });
    expect(at('loop_b')).toMatchObject({ segment: 4, startSamples: S(10 + 13 + 5) });
    // Fixed parts: 60 s from Signal OK to the text, 3 s of clicks before p1 and 40 s after the text.
    expect(at('end')).toMatchObject({ segment: 4, startSamples: S(40) });
  });

  it('signal check without the covered lens when smoke saw an SDK error there (spec 15.2): one deep breath only', () => {
    const noLens = buildHeadstartScenario(clips, CLIP_SAMPLES, { lensCheck: false });
    expect(scenarioProblems(noLens, { narratorStops: true })).toEqual([]);
    const names = noLens.map((s) => s.name);
    expect(names).not.toContain('lens_cover');
    expect(names).not.toContain('lens_uncover');
    expect(names.slice(names.indexOf('summary'))).toEqual(['summary', 'signal_in', 'signal_out', 'loop_b_ready', 'loop_b', 'end']);
    expect(step(noLens, 'signal_in')).toMatchObject({ k: 'prompt', text: 'Breathe in', bar: 'grow', status: 'Signal check' });
    expect(step(noLens, 'signal_out')).toMatchObject({ k: 'prompt', text: 'Breathe out', bar: 'shrink', status: 'Signal check' });
    const rows = planTimeline(noLens);
    expect(rows.find((r) => r.name === 'loop_b')).toMatchObject({ segment: 4, startSamples: S(10 + 6 + 5) });
    // Everything else is the same take; the default and lensCheck true keep the lens.
    expect(noLens.filter((s) => !s.name.startsWith('lens_'))).toEqual(steps.filter((s) => !s.name.startsWith('lens_')));
    expect(buildHeadstartScenario(clips, CLIP_SAMPLES, { lensCheck: true })).toEqual(steps);
    expect(signalCheckSteps().map((s) => s.name)).toEqual(['signal_in', 'signal_out', 'lens_cover', 'lens_uncover']);
    expect(signalCheckSteps(false).map((s) => s.name)).toEqual(['signal_in', 'signal_out']);
  });
});

describe('scenarioFor: headstart (spec 7.11)', () => {
  it('gives a live plan with the live view and the timings set', () => {
    const p = plan(SAMPLE_FILES);
    expect(p).toMatchObject({
      id: 'headstart',
      kind: 'headstart',
      camera: true,
      deckMode: 'live',
      clips: ['opening.wav', 'p1.wav', 'p2.wav'],
      cuesFile: null,
      timingsSet: 'timings.json',
      liveView: true,
      meters: false,
      devicePanel: false,
    });
    expect(p.instruction).toBe(HEADSTART_INSTRUCTION);
    expect(p.build({ clipSamples: CLIP_SAMPLES })).toEqual(buildHeadstartScenario(p.clips, CLIP_SAMPLES));
    expect(p.build({ clipSamples: CLIP_SAMPLES }).map((s) => s.name)).toContain('lens_cover');
    expect(plan([...SAMPLE_FILES, 'p3.wav']).clips).toEqual(['opening.wav', 'p1.wav', 'p2.wav', 'p3.wav']);
    // The scenario name alone also selects it.
    expect(scenarioFor({ mode: '', scenario: 'headstart', narrator: SAMPLE_FILES })).toMatchObject({ kind: 'headstart' });
  });

  it('leaves the covered lens out only when /api/config says lensCheck: false (spec 15.2)', () => {
    const noLens = plan(SAMPLE_FILES, false).build({ clipSamples: CLIP_SAMPLES });
    expect(noLens).toEqual(buildHeadstartScenario(['opening.wav', 'p1.wav', 'p2.wav'], CLIP_SAMPLES, { lensCheck: false }));
    expect(noLens.map((s) => s.name)).not.toContain('lens_cover');
    expect(plan(SAMPLE_FILES, true).build({ clipSamples: CLIP_SAMPLES }).map((s) => s.name)).toContain('lens_cover');
    // The page reads the field from host's /api/config; anything but false keeps the lens.
    const config = (raw: Record<string, unknown>) => parseConfig({ mode: 'headstart', scenario: 'headstart', narrator: SAMPLE_FILES, ...raw });
    expect(config({ lensCheck: false }).lensCheck).toBe(false);
    expect(config({ lensCheck: true }).lensCheck).toBe(true);
    expect(config({}).lensCheck).toBe(true);
    expect(config({ lensCheck: 'off' }).lensCheck).toBe(true);
    const fromConfig = scenarioFor(config({ lensCheck: false }));
    expect(typeof fromConfig === 'string' ? fromConfig : fromConfig.build({ clipSamples: CLIP_SAMPLES }).map((s) => s.name)).not.toContain('lens_cover');
  });

  it('refuses a sample folder without the opening, p1, p2 or the word times', () => {
    expect(scenarioFor({ mode: 'headstart', scenario: 'headstart', narrator: ['opening.wav', 'p1.wav'] })).toBe(
      'The sample text is not ready: host does not serve p2.wav, timings.json.',
    );
    expect(scenarioFor({ mode: 'headstart', scenario: 'headstart', narrator: [] })).toBe(
      'The sample text is not ready: host does not serve opening.wav, p1.wav, p2.wav, timings.json.',
    );
  });

  it('other plans keep no live view', () => {
    const smoke = scenarioFor({ mode: 'smoke', scenario: 'smoke', narrator: [] });
    expect(typeof smoke === 'string' ? null : smoke.liveView).toBeUndefined();
  });

  it('timingsNameFor: a clip file of its own first, then the set of the plan, then a lone timings.json', () => {
    const narrator = ['opening.wav', 'p1.wav', 'p2.wav', 'p1.timings.json', 'timings.json'];
    expect(timingsNameFor('p1.wav', narrator, 3, 'timings.json')).toBe('p1.timings.json');
    expect(timingsNameFor('p2.wav', narrator, 3, 'timings.json')).toBe('timings.json');
    expect(timingsNameFor('opening.wav', narrator, 3, 'timings.json')).toBe('timings.json');
    // Without a set, several clips never share timings.json (as before).
    expect(timingsNameFor('p2.wav', narrator, 3)).toBeNull();
    expect(timingsNameFor('level.wav', ['level.wav', 'timings.json'], 1)).toBe('timings.json');
    // A set host does not serve gives nothing.
    expect(timingsNameFor('p2.wav', ['p2.wav'], 3, 'timings.json')).toBeNull();
  });
});

describe('headstart instruction screen', () => {
  it('has the three rules of the live demo', () => {
    expect(instructionPlainText(HEADSTART_INSTRUCTION)).toBe(
      [
        'Live demo. About five minutes.',
        [
          '1. Follow the prompts.',
          '2. Listen to the text. When you hear a mistake, correct it aloud in three to five words.',
          '3. The narrator may stop before you speak. If it stops and you heard nothing wrong, stay silent.',
        ].join('\n'),
        'Sit still, eyes on the dot.   [ Start ]',
      ].join('\n\n'),
    );
  });
});
