// smoke (spec 7.12): first SDK run, about two minutes of camera. Three cued deep breaths for the trace
// sign (question 3), a quiet minute with the macOS screen recording on (question 6), then the lens
// covered once for 2 s (question 7). The lens step is last: an SDK error there ends the run (spec 7.2).
import { breatheNormally, deepBreaths, end, rest, signalOk, waitForSdk } from './blocks.ts';
import { secondsToSamples, type Step } from './format.ts';

export const SMOKE_TEXT = {
  screenRecording: 'Start the macOS screen recording now',
  quiet: 'Sit still. Breathe normally.',
  lensReady: 'Get ready to cover the lens',
  lensCover: 'Cover the lens',
  lensUncover: 'Uncover the lens',
  done: 'Smoke run finished. Stop the screen recording. The answers are in the terminal.',
} as const;

export function buildSmokeScenario(): Step[] {
  return [
    waitForSdk(),
    signalOk(),
    breatheNormally(true),
    ...deepBreaths(3),
    rest('rest_1'),
    { k: 'prompt', name: 'screen_recording', text: SMOKE_TEXT.screenRecording, lenSamples: secondsToSamples(10) },
    { k: 'prompt', name: 'quiet', text: SMOKE_TEXT.quiet, lenSamples: secondsToSamples(60) },
    { k: 'prompt', name: 'lens_ready', text: SMOKE_TEXT.lensReady, lenSamples: secondsToSamples(3) },
    { k: 'prompt', name: 'lens_cover', text: SMOKE_TEXT.lensCover, lenSamples: secondsToSamples(2) },
    { k: 'prompt', name: 'lens_uncover', text: SMOKE_TEXT.lensUncover, lenSamples: secondsToSamples(5) },
    end(SMOKE_TEXT.done),
  ];
}
