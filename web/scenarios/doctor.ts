// doctor (spec 7.12, 7.7): no camera. Device names and microphone flags, loop check A, the background,
// the 20 s volume sample with a level chosen by the user, the leak at that level, the inhale test,
// then loop check B at least five minutes after loop check A.
import { end, headsetOn, loopCheck } from './blocks.ts';
import { secondsToSamples, type Step } from './format.ts';

/** The 20 s volume sample, not from the text packs (spec 7.7), as served by /api/narrator/level.wav. */
export const DOCTOR_SAMPLE_CLIP = 'level.wav';
export const DOCTOR_SAMPLE_SECONDS = 20;

/** Loop check B (its clicks) starts this long after loop check A, or later after a slow level choice (spec 7.12). */
export const DOCTOR_LOOP_GAP_SECONDS = 300;

export const DOCTOR_TEXT = {
  devices: 'Check the microphone and the output below.',
  noSample: 'The volume sample level.wav is not served, so this run skips the level step.',
  devicesButton: 'Continue',
  floor: 'Stay silent. Measuring the background.',
  levelSample: 'Pick the level where every word is clear and comfortable.',
  levelChoice: 'Choose the level, then press Use this level.',
  levelButton: 'Use this level',
  leak: 'Stay silent while the sample plays again.',
  inhaleIn: 'Breathe in loudly',
  inhaleOut: 'Breathe out',
  waitB: 'Rest with the headset on. The second loop check comes next.',
  done: 'Doctor finished. The report is in the terminal.',
  levelDone: 'Level saved. The report is in the terminal.',
} as const;

function floor(): Step {
  return { k: 'prompt', name: 'floor', text: DOCTOR_TEXT.floor, lenSamples: secondsToSamples(10) };
}

/**
 * Volume sample twice with the level chooser (spec 7.7), the choice, then the leak at the chosen level.
 * Each play step lasts 20 s, or the clip when it is longer.
 */
export function levelSteps(clip: string, clipSamples = 0): Step[] {
  const len = Math.max(secondsToSamples(DOCTOR_SAMPLE_SECONDS), clipSamples);
  return [
    { k: 'play', name: 'level_sample', text: DOCTOR_TEXT.levelSample, lenSamples: len, clip, levels: true },
    { k: 'play', name: 'level_sample_again', text: DOCTOR_TEXT.levelSample, lenSamples: len, clip, levels: true },
    { k: 'wait', name: 'level_choice', text: DOCTOR_TEXT.levelChoice, lenSamples: 0, until: 'button', button: DOCTOR_TEXT.levelButton, levels: true },
    { k: 'play', name: 'leak', text: DOCTOR_TEXT.leak, lenSamples: len, clip },
  ];
}

/** Inhale test (spec 7.12): 10 s with three loud cued inhales. Names inhale_<i>, inhale_<i>_out. */
export function inhaleTest(): Step[] {
  const cycle = secondsToSamples(10) / 3;
  const inLen = secondsToSamples(1.5);
  const steps: Step[] = [];
  for (let i = 1; i <= 3; i += 1) {
    steps.push({ k: 'prompt', name: `inhale_${i}`, text: DOCTOR_TEXT.inhaleIn, lenSamples: inLen });
    steps.push({ k: 'prompt', name: `inhale_${i}_out`, text: DOCTOR_TEXT.inhaleOut, lenSamples: cycle - inLen });
  }
  return steps;
}

/**
 * Full doctor run. clip is null when host serves no volume sample: the level steps are left out.
 * The align step holds the rest so that the clicks of loop check B start five minutes after those
 * of loop check A, or at once when the steps before took longer (a slow level choice).
 */
export function buildDoctorScenario(clip: string | null = DOCTOR_SAMPLE_CLIP, clipSamples = 0): Step[] {
  const [readyA, clicksA] = loopCheck('A');
  const [readyB, clicksB] = loopCheck('B');
  if (!readyA || !clicksA || !readyB || !clicksB) throw new Error('a loop check has two steps');
  const devicesText = clip ? DOCTOR_TEXT.devices : `${DOCTOR_TEXT.devices} ${DOCTOR_TEXT.noSample}`;
  return [
    { k: 'wait', name: 'devices', text: devicesText, lenSamples: 0, until: 'button', button: DOCTOR_TEXT.devicesButton },
    readyA,
    clicksA,
    headsetOn(),
    floor(),
    ...(clip ? levelSteps(clip, clipSamples) : []),
    ...inhaleTest(),
    {
      k: 'align',
      name: 'wait_b',
      text: DOCTOR_TEXT.waitB,
      lenSamples: 0,
      anchor: clicksA.name,
      offsetSamples: secondsToSamples(DOCTOR_LOOP_GAP_SECONDS) - readyB.lenSamples,
    },
    readyB,
    clicksB,
    end(DOCTOR_TEXT.done),
  ];
}

/** `npm run doctor -- --level` (spec 5.2, 7.7): only the level step and the leak measurement. */
export function buildDoctorLevelScenario(clip: string = DOCTOR_SAMPLE_CLIP, clipSamples = 0): Step[] {
  return [headsetOn(), floor(), ...levelSteps(clip, clipSamples), end(DOCTOR_TEXT.levelDone)];
}
