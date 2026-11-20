// The "Next step in m:ss" line on long quiet steps (web/ui/run.ts): which steps show it, when it
// ends, and that the controller moves it by Deck's reports and the audio clock and hides it at the end.
import { describe, expect, it } from 'vitest';
import { secondsToSamples, type Step } from '../scenarios/format.ts';
import { buildDoctorScenario } from '../scenarios/doctor.ts';
import { COUNTDOWN_MIN_SAMPLES, countdownEndN, countdownText, RunController, type RunView } from './run.ts';

const S = secondsToSamples;

function viewWithCountdown() {
  const shown: Array<string | null> = [];
  const view: RunView = {
    prompt: () => {},
    bar: () => {},
    dot: () => {},
    note: () => {},
    waitButton: () => {},
    levels: () => {},
    status: () => {},
    meters: () => {},
    recording: () => {},
    countdown: (t) => void shown.push(t),
  };
  return { shown, view };
}

function controller(steps: Step[]) {
  const { shown, view } = viewWithCountdown();
  let clockS = 0;
  const c = new RunController(
    steps,
    view,
    { toDeck: () => {}, toWorker: () => {} },
    { done: () => {}, aborted: () => {}, failed: () => {}, closed: () => {} },
    -12,
    () => clockS,
  );
  /** Audio clock at `s` seconds, then a level report: what Deck sends ten times a second on a quiet step. */
  const level = (s: number) => {
    clockS = s;
    c.handleDeck({ k: 'level', ch0Db: -60, ch1Db: -60 });
  };
  /** Deck's step report at `s` seconds of audio clock and sample number. */
  const step = (s: number, name: string, text: string) => {
    clockS = s;
    c.handleDeck({ k: 'step', n: S(s), name, text });
  };
  return { c, shown, level, step };
}

describe('countdown text', () => {
  it('rounds up to the second and never goes below 0:00', () => {
    expect(countdownText(S(161.2))).toBe('Next step in 2:42');
    expect(countdownText(S(60))).toBe('Next step in 1:00');
    expect(countdownText(S(0.01))).toBe('Next step in 0:01');
    expect(countdownText(0)).toBe('Next step in 0:00');
    expect(countdownText(-S(3))).toBe('Next step in 0:00');
  });
});

describe('which steps count down', () => {
  const none = new Map<string, number>();
  it('quiet steps of at least 8 s: rest, clicks and prompts without the bar', () => {
    expect(COUNTDOWN_MIN_SAMPLES).toBe(S(8));
    expect(countdownEndN({ k: 'rest', name: 'r', text: 'Rest', lenSamples: S(8) }, 100, none)).toBe(100 + S(8));
    expect(countdownEndN({ k: 'clicks', name: 'loop_a', text: '', lenSamples: S(12), block: 'A' }, 0, none)).toBe(S(12));
    expect(countdownEndN({ k: 'prompt', name: 'quiet', text: 'Sit still.', lenSamples: S(60) }, 5, none)).toBe(5 + S(60));
  });

  it('no countdown on short steps, breath-bar prompts, narrator, cue, wait and end steps', () => {
    expect(countdownEndN({ k: 'rest', name: 'r', text: 'Rest', lenSamples: S(5) }, 0, none)).toBeNull();
    expect(countdownEndN({ k: 'prompt', name: 'deep_1_out', text: 'Breathe out', lenSamples: S(10), bar: 'shrink' }, 0, none)).toBeNull();
    expect(countdownEndN({ k: 'play', name: 'listening', text: '', lenSamples: S(180), clip: 'listen.wav' }, 0, none)).toBeNull();
    expect(countdownEndN({ k: 'cue', name: 'cue_1_on', text: '', lenSamples: S(20), i: 1, on: true }, 0, none)).toBeNull();
    expect(countdownEndN({ k: 'wait', name: 'devices', text: '', lenSamples: 0, until: 'button' }, 0, none)).toBeNull();
    expect(countdownEndN({ k: 'end', name: 'end', text: 'Done', lenSamples: 0 }, 0, none)).toBeNull();
  });

  it('an align step ends at its anchor start plus the offset, and has no countdown without the anchor', () => {
    const align: Step = { k: 'align', name: 'wait_b', text: 'Rest', lenSamples: 0, anchor: 'loop_a', offsetSamples: S(290) };
    expect(countdownEndN(align, S(100), new Map([['loop_a', S(20)]]))).toBe(S(310));
    expect(countdownEndN(align, S(100), none)).toBeNull();
  });

  it("the doctor's rest before loop check B counts down to the clicks' prompt", () => {
    const steps = buildDoctorScenario('level.wav', S(20));
    const wait = steps.find((s) => s.k === 'align');
    const loopA = steps.find((s) => s.name === 'loop_a');
    if (!wait || wait.k !== 'align' || !loopA) throw new Error('the doctor has an align step and loop check A');
    expect(wait.anchor).toBe('loop_a');
    // loop B's clicks start five minutes after loop A's: the rest ends one ready prompt earlier.
    expect(countdownEndN(wait, S(200), new Map([['loop_a', S(30)]]))).toBe(S(30) + S(300) - S(10));
  });
});

describe('the controller shows and hides the countdown', () => {
  const steps: Step[] = [
    { k: 'prompt', name: 'loop_a_ready', text: 'Hold', lenSamples: S(10) },
    { k: 'clicks', name: 'loop_a', text: 'Hold', lenSamples: S(12), block: 'A' },
    { k: 'prompt', name: 'deep_1_in', text: 'Breathe in', lenSamples: S(2), bar: 'grow' },
    { k: 'align', name: 'wait_b', text: 'Rest', lenSamples: 0, anchor: 'loop_a', offsetSamples: S(60) },
    { k: 'end', name: 'end', text: 'Done', lenSamples: 0 },
  ];

  it('counts down by the audio clock between reports, once per second, and clears on a step without one', () => {
    const { shown, level, step } = controller(steps);
    step(0, 'loop_a_ready', 'Hold');
    expect(shown.at(-1)).toBe('Next step in 0:10');
    level(2.5);
    expect(shown.at(-1)).toBe('Next step in 0:08');
    const before = shown.length;
    level(2.6);
    expect(shown.length).toBe(before); // same text: the view is not touched again
    level(9.2);
    expect(shown.at(-1)).toBe('Next step in 0:01');
    step(10, 'loop_a', 'Hold');
    expect(shown.at(-1)).toBe('Next step in 0:12');
    step(22, 'deep_1_in', 'Breathe in');
    expect(shown.at(-1)).toBeNull();
    step(24, 'wait_b', 'Rest');
    expect(shown.at(-1)).toBe('Next step in 0:46'); // loop_a started at 10 s: 10 + 60 - 24
    level(54.5);
    expect(shown.at(-1)).toBe('Next step in 0:16');
  });

  it('a later sample number from Deck wins over the audio clock', () => {
    const { c, shown, step } = controller(steps);
    step(0, 'loop_a_ready', 'Hold');
    c.handleDeck({ k: 'state', n: S(4), s: 'reading', cause: null });
    expect(shown.at(-1)).toBe('Next step in 0:06');
  });

  it('hides it when the scenario ends and after Stop', () => {
    const a = controller(steps);
    a.step(0, 'loop_a_ready', 'Hold');
    a.c.handleDeck({ k: 'done', n: S(5) });
    expect(a.shown.at(-1)).toBeNull();

    const b = controller(steps);
    b.step(0, 'loop_a_ready', 'Hold');
    b.c.stop();
    expect(b.shown.at(-1)).toBeNull();
    b.level(3);
    expect(b.shown.at(-1)).toBeNull();
  });
});
