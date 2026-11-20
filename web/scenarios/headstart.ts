// headstart (spec 6.5, 7.11, 15.1, 15.2; PREREG.md §11 "Demo takes"): a live take on the public sample
// text that host serves from sample/. The SDK starts, loop check A runs, three paced deep breaths give
// the trace sign of this run (the worker finds it, spec 7.4, 7.11), then the narrator reads the opening,
// where D1 learns ordinary breaths (spec 7.4; sample/README.md: no planted errors there). Three sync
// clicks open the part the demo video shows, 3 s before the first passage (spec 15.1, 15.4), and the
// passages follow. A fast rise of the chest trace (CHEST) or the voice (VOICE) stops the narrator
// (spec 6.4). After the text: the summary of the take, the signal check of spec 15.2 (one deep breath,
// then the lens covered for 2 s, unless smoke saw an SDK error on the covered lens) and loop check B.
// The clock of the status line starts at 'Signal OK', so the shown part never starts at 0:00.
import { breatheNormally, deepBreaths, end, headsetOn, loopCheck, PROMPT, rest, signalOk, waitForSdk, SECONDS } from './blocks.ts';
import { secondsToSamples, type ClicksStep, type PlayStep, type Step } from './format.ts';

/**
 * Narrator names of the sample folder (live/lib/narrator.cjs, allow list `sample`): the opening, the
 * passages and one timings-set/1 file with the word times of every clip (spec 8.2).
 */
export const HEADSTART_FILES = {
  opening: 'opening.wav',
  passages: ['p1.wav', 'p2.wav', 'p3.wav'],
  timings: 'timings.json',
} as const;

/** The take needs these; p3.wav plays only when host serves it. */
export const HEADSTART_REQUIRED = ['opening.wav', 'p1.wav', 'p2.wav', 'timings.json'] as const;

export const HEADSTART_TEXT = {
  /** Status-line label outside the reading (spec 7.3). */
  status: 'Live demo',
  opening: 'Opening',
  /** Shown with the three sync clicks, between the opening and the first passage. */
  listen: 'Listen',
  summary: 'Summary of this take',
  signalCheck: 'Signal check',
  lensCover: 'Cover the lens',
  lensUncover: 'Uncover the lens',
  done: 'Live demo finished.',
} as const;

/** Durations in seconds; all are assumptions except where marked. */
export const HEADSTART_SECONDS = {
  /** The demo click block: clicks at 0.25, 1.05 and 2.15 s (web/lib/clicks.ts); the shown part opens 3 s before the passage (spec 15.1). */
  demoClicks: 3,
  /** The summary scene (spec 15.2 storyboard: 0:55-1:10, about 10 s on screen). */
  summary: 10,
  /** Lens covered for two seconds (spec 15.2). */
  lensCover: 2,
  /** Time for the SDK status to come back after the lens (as in smoke, web/scenarios/smoke.ts). */
  lensUncover: 5,
} as const;

export interface HeadstartOptions {
  /**
   * The signal check covers the lens (spec 15.2). False when smoke saw an SDK error on the covered lens
   * (host reads the newest smoke_report.json, or settings.env COPYHOLDER_LENS_CHECK): an SDK error ends
   * the recording (live/host.cjs), so the check then keeps only the deep breath. Default true.
   */
  lensCheck?: boolean;
}

/** Clips of the take in reading order: opening, p1, p2, and p3 when host serves it. */
export function headstartClips(narrator: readonly string[]): string[] {
  const passages = HEADSTART_FILES.passages.filter((p) => narrator.includes(p));
  return [HEADSTART_FILES.opening, ...passages];
}

/** Step name of a clip: the passage id, its file name without .wav ('opening', 'p1', ...). */
export function clipStepName(clip: string): string {
  return clip.replace(/\.wav$/i, '');
}

function withStatus(steps: Step[], status: string): Step[] {
  for (const s of steps) s.status = status;
  return steps;
}

/**
 * The reading: one play step per clip, each to the end of its clip (a stop lengthens it, spec 6.4),
 * with no text on screen (spec 7.8). Status 'Opening', then 'Passage k of n'.
 */
export function readingSteps(clips: readonly string[], clipSamples: ReadonlyMap<string, number>): PlayStep[] {
  const passages = clips.filter((c) => c !== HEADSTART_FILES.opening);
  return clips.map((clip): PlayStep => {
    const k = passages.indexOf(clip);
    return {
      k: 'play',
      name: clipStepName(clip),
      text: '',
      lenSamples: clipSamples.get(clip) ?? 0,
      clip,
      untilClipEnd: true,
      status: k < 0 ? HEADSTART_TEXT.opening : `Passage ${k + 1} of ${passages.length}`,
    };
  });
}

/** The three demo sync clicks with their flashes (spec 15.1, 15.4): the first 3 s of the shown part. */
export function demoClicksStep(): ClicksStep {
  return {
    k: 'clicks',
    name: 'demo_clicks',
    text: HEADSTART_TEXT.listen,
    lenSamples: secondsToSamples(HEADSTART_SECONDS.demoClicks),
    block: 'demo',
    status: HEADSTART_TEXT.status,
  };
}

/**
 * Signal check (spec 15.2): one deep breath with the bar, then the lens covered for 2 s and uncovered.
 * Without lensCheck only the deep breath (spec 15.2: smoke saw an SDK error on the covered lens).
 */
export function signalCheckSteps(lensCheck = true): Step[] {
  const breath: Step[] = [
    { k: 'prompt', name: 'signal_in', text: PROMPT.breatheIn, lenSamples: secondsToSamples(SECONDS.deepIn), bar: 'grow' },
    { k: 'prompt', name: 'signal_out', text: PROMPT.breatheOut, lenSamples: secondsToSamples(SECONDS.deepOut), bar: 'shrink' },
  ];
  const lens: Step[] = [
    { k: 'prompt', name: 'lens_cover', text: HEADSTART_TEXT.lensCover, lenSamples: secondsToSamples(HEADSTART_SECONDS.lensCover) },
    { k: 'prompt', name: 'lens_uncover', text: HEADSTART_TEXT.lensUncover, lenSamples: secondsToSamples(HEADSTART_SECONDS.lensUncover) },
  ];
  return withStatus(lensCheck ? [...breath, ...lens] : breath, HEADSTART_TEXT.signalCheck);
}

/**
 * Steps of a headstart take. `clips` comes from headstartClips(); `clipSamples` holds the decoded clip
 * lengths (a play step lasts its clip). The deep breaths keep their names deep_<i>_in and deep_<i>_out:
 * the worker reads the inhale windows from their marks (spec 7.4). The demo clicks come after the
 * opening, so the shown part starts 3 s before the first passage with D1 trained on the opening
 * (spec 15.1: D1 resets its memory only when the narrator first reads, spec 7.4 rule 4).
 */
export function buildHeadstartScenario(clips: readonly string[], clipSamples: ReadonlyMap<string, number>, opts: HeadstartOptions = {}): Step[] {
  const start = signalOk();
  start.origin = true;
  const [opening, ...passages] = readingSteps(clips, clipSamples);
  return [
    ...withStatus([waitForSdk(), start, ...loopCheck('A'), headsetOn(), breatheNormally(false), ...deepBreaths(3), rest('rest_1')], HEADSTART_TEXT.status),
    ...(opening ? [opening] : []),
    demoClicksStep(),
    ...passages,
    {
      k: 'prompt',
      name: 'summary',
      text: HEADSTART_TEXT.summary,
      lenSamples: secondsToSamples(HEADSTART_SECONDS.summary),
      status: HEADSTART_TEXT.summary,
    },
    ...signalCheckSteps(opts.lensCheck !== false),
    ...withStatus(loopCheck('B'), HEADSTART_TEXT.status),
    end(HEADSTART_TEXT.done),
  ];
}
