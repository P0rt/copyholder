// Scenario format: the steps of one run, authored in web/scenarios/ (docs/protocol.md, "Scenario steps").
// Every length is a sample count at 48 kHz on the AudioContext clock (spec 6.3). Pure data, no I/O:
// the same module runs on the main thread, in Deck and in tests. The page sends these steps to Deck
// as they are ({k:'scenario', steps}); Deck ignores the page-only fields (status, origin, levels).

export const SAMPLE_RATE_HZ = 48_000;

/** Seconds to samples at 48 kHz, rounded to the nearest sample. */
export function secondsToSamples(seconds: number): number {
  return Math.round(seconds * SAMPLE_RATE_HZ);
}

/** Milliseconds to samples at 48 kHz, rounded to the nearest sample. */
export function msToSamples(ms: number): number {
  return Math.round((ms * SAMPLE_RATE_HZ) / 1000);
}

/** Samples to seconds at 48 kHz. */
export function samplesToSeconds(samples: number): number {
  return samples / SAMPLE_RATE_HZ;
}

/** Samples to milliseconds at 48 kHz, unrounded (msToSamples gives the same sample count back). */
export function samplesToMs(samples: number): number {
  return (samples * 1000) / SAMPLE_RATE_HZ;
}

/**
 * What releases a `wait` step: the SDK signal (spec 7.1) or a page button. Only these two: the page
 * sends {k:'go'} for nothing else. The preflight check of a session (spec 10.4) comes with the
 * session scenario, together with the code that runs it and releases its wait.
 */
export type WaitUntil = 'sdk_ok' | 'button';

/** Every WaitUntil value the page can release. */
export const WAIT_UNTIL: readonly WaitUntil[] = ['sdk_ok', 'button'];

/** Deep-breath bar motion (spec 9.3): grows on the in-breath, shrinks on the out-breath. */
export type BarMotion = 'grow' | 'shrink';

interface StepBase {
  /** Unique within the scenario; Deck stamps it as {"k":"mark","what":"step","name":...}. */
  name: string;
  /** Prompt shown while the step runs; '' leaves only the dot. */
  text: string;
  /** Samples from this step's start to the next step's start. */
  lenSamples: number;
  /** Optional status-line label for session screens, e.g. 'Passage 2 of 3' (spec 7.3). */
  status?: string;
  /** Marks the step whose start is time 0:00 of the scenario (spec 9.3). */
  origin?: boolean;
  /** Show the output level chooser while this step runs (doctor, spec 7.7). */
  levels?: boolean;
}

export interface PromptStep extends StepBase {
  k: 'prompt';
  bar?: BarMotion;
}

export interface RestStep extends StepBase {
  k: 'rest';
}

export interface CueStep extends StepBase {
  k: 'cue';
  /** Cue number, from 1 in scenario order. */
  i: number;
  /** true: the dot fills; false: it empties. */
  on: boolean;
}

/**
 * Starts a narrator clip at its first sample. The clip plays to its last sample. The cue steps right
 * after a play step belong to its play group and run while the clip plays; the group (the play step
 * and those cue steps) must be at least as long as the clip, and the page pads the clip with silence
 * to the group length. With untilClipEnd the next step starts where the clip ends instead.
 */
export interface PlayStep extends StepBase {
  k: 'play';
  /** Narrator clip name, as served by /api/narrator/<name>. */
  clip: string;
  untilClipEnd?: boolean;
}

export interface ClicksStep extends StepBase {
  k: 'clicks';
  /** Loop-check block (spec 6.3): Deck plays the 10 clicks inside the step. */
  block: 'A' | 'B';
}

export interface WaitStep extends StepBase {
  k: 'wait';
  until: WaitUntil;
  /** Button label when until === 'button'. */
  button?: string;
}

/**
 * Holds the scenario until a sample tied to an earlier step: the next step starts at
 * start(anchor) + offsetSamples, or at once when that sample has passed (doctor: loop check B
 * five minutes after loop check A, spec 7.12).
 */
export interface AlignStep extends StepBase {
  k: 'align';
  /** Name of an earlier step. */
  anchor: string;
  offsetSamples: number;
}

export interface EndStep extends StepBase {
  k: 'end';
}

export type Step = PromptStep | RestStep | CueStep | PlayStep | ClicksStep | WaitStep | AlignStep | EndStep;
export type StepKind = Step['k'];

/** Kinds whose length is not a fixed sample count; they carry lenSamples = 0. */
const OPEN_ENDED: ReadonlySet<StepKind> = new Set<StepKind>(['wait', 'align', 'end']);

/** Problems with a step list; empty when the list is a valid scenario. */
export function scenarioErrors(steps: readonly Step[]): string[] {
  const errors: string[] = [];
  const seen = new Set<string>();
  const cueOpen = new Map<number, boolean>();
  if (steps.length === 0) errors.push('scenario has no steps');
  steps.forEach((s, idx) => {
    const at = `step ${idx} (${s.name || '?'})`;
    if (!s.name) errors.push(`${at}: empty name`);
    if (seen.has(s.name)) errors.push(`${at}: duplicate name`);
    if (!Number.isInteger(s.lenSamples) || s.lenSamples < 0) errors.push(`${at}: lenSamples must be a non-negative integer`);
    if (OPEN_ENDED.has(s.k) && s.lenSamples !== 0) errors.push(`${at}: ${s.k} steps have lenSamples 0`);
    if (typeof s.text !== 'string') errors.push(`${at}: text must be a string`);
    switch (s.k) {
      case 'cue': {
        const open = cueOpen.get(s.i) ?? false;
        if (s.on === open) errors.push(`${at}: cue ${s.i} turned ${s.on ? 'on' : 'off'} twice`);
        cueOpen.set(s.i, s.on);
        break;
      }
      case 'play':
        if (!s.clip) errors.push(`${at}: play without clip`);
        break;
      case 'wait':
        if (!WAIT_UNTIL.includes(s.until)) errors.push(`${at}: nothing releases a wait until ${String(s.until)} (only ${WAIT_UNTIL.join(', ')})`);
        if (s.until === 'button' && !s.button) errors.push(`${at}: button wait without a label`);
        break;
      case 'align':
        if (!seen.has(s.anchor)) errors.push(`${at}: anchor ${s.anchor || '?'} is not an earlier step`);
        if (!Number.isInteger(s.offsetSamples) || s.offsetSamples < 0) errors.push(`${at}: offsetSamples must be a non-negative integer`);
        break;
      case 'end':
        if (idx !== steps.length - 1) errors.push(`${at}: end must be the last step`);
        break;
      default:
        break;
    }
    seen.add(s.name);
  });
  const last = steps[steps.length - 1];
  if (last && last.k !== 'end') errors.push('the last step must be end');
  for (const [i, open] of cueOpen) if (open) errors.push(`cue ${i} is never turned off`);
  return errors;
}

/** Throws with all problems listed when the step list is not a valid scenario. */
export function assertScenario(steps: readonly Step[]): void {
  const errors = scenarioErrors(steps);
  if (errors.length > 0) throw new Error(`invalid scenario:\n${errors.join('\n')}`);
}

/** One row of a planned timeline: where a step starts relative to the start of its segment. */
export interface PlannedStep {
  index: number;
  name: string;
  k: StepKind;
  /**
   * Segment number: 0 at the scenario start, +1 after each wait, untilClipEnd play, or align on an
   * anchor in an earlier segment (their end is not known before the run).
   */
  segment: number;
  /** Start in samples from the segment start. */
  startSamples: number;
}

/** Planned start of every step within its segment (see PlannedStep). */
export function planTimeline(steps: readonly Step[]): PlannedStep[] {
  const rows: PlannedStep[] = [];
  const byName = new Map<string, PlannedStep>();
  let segment = 0;
  let at = 0;
  for (const [index, s] of steps.entries()) {
    const row: PlannedStep = { index, name: s.name, k: s.k, segment, startSamples: at };
    rows.push(row);
    byName.set(s.name, row);
    const anchor = s.k === 'align' ? byName.get(s.anchor) : undefined;
    if (s.k === 'wait' || (s.k === 'play' && s.untilClipEnd) || (s.k === 'align' && anchor?.segment !== segment)) {
      segment += 1;
      at = 0;
    } else if (s.k === 'align' && anchor) {
      at = Math.max(at, anchor.startSamples + s.offsetSamples);
    } else {
      at += s.lenSamples;
    }
  }
  return rows;
}

/** Start of the named step in samples from its segment start (see planTimeline). */
export function plannedStart(steps: readonly Step[], name: string): number {
  const row = planTimeline(steps).find((r) => r.name === name);
  if (!row) throw new Error(`no step named ${name}`);
  return row.startSamples;
}

/** Narrator clips the scenario plays, in first-use order. */
export function clipsOf(steps: readonly Step[]): string[] {
  const clips: string[] = [];
  for (const s of steps) if (s.k === 'play' && !clips.includes(s.clip)) clips.push(s.clip);
  return clips;
}

/** A cue step inside a play group, placed relative to the start of the play step. */
export interface GroupCue {
  index: number;
  i: number;
  on: boolean;
  offsetSamples: number;
}

/** A play step (without untilClipEnd) and the cue steps right after it (see PlayStep). */
export interface PlayGroup {
  /** Index of the play step. */
  index: number;
  name: string;
  clip: string;
  /** Samples from the play step's start to the start of the first step after the group. */
  lenSamples: number;
  cues: GroupCue[];
}

/** The play groups of a scenario, in order. */
export function playGroups(steps: readonly Step[]): PlayGroup[] {
  const groups: PlayGroup[] = [];
  steps.forEach((s, index) => {
    if (s.k !== 'play' || s.untilClipEnd) return;
    const group: PlayGroup = { index, name: s.name, clip: s.clip, lenSamples: s.lenSamples, cues: [] };
    for (let j = index + 1; j < steps.length; j += 1) {
      const c = steps[j];
      if (!c || c.k !== 'cue') break;
      group.cues.push({ index: j, i: c.i, on: c.on, offsetSamples: group.lenSamples });
      group.lenSamples += c.lenSamples;
    }
    groups.push(group);
  });
  return groups;
}
