// A gate run that no SDK measured is a rehearsal of the chain, not data (spec 6.5, PREREG.md
// section 11): the mock tap (`--tap mock`, live/mock-tap.cjs) made up its chest trace, tap ran its
// stand-in SDK (dry: true), or no SDK ran (sdk null). quickcheck keeps its verdict line for such a
// run and says so in one line before it; clocks, label and analyze:gate refuse the folder and write
// nothing, so nothing in it looks like a recording of the pack. The check is the one pack and purge
// use (analysis/pack/rules.ts whyNotMeasured).
//
// Gate mode plays the pack's own narration whichever tap runs (live/lib/args.cjs), so a rehearsal of
// pack A, B or C that reached its objection block (4:15) played the planted errors of that pack,
// which the participant must not hear before the pack is recorded (PREREG.md section 7.1). Such a
// folder is kept as the record of what was played; any other rehearsal is deleted with purge, and
// the pack is recorded with the real tap. None of the rules for a failed recording (PREREG.md
// sections 7.4 and 11) applies to a rehearsal, and no message here names the command that refuses,
// as each command puts its own name before the text.

import path from 'node:path';
import { whyNotMeasured } from '../pack/rules.ts';
import { stepStart, type LoadedSession } from './session.ts';
import { gateSteps, type GatePack } from './steps.ts';

/** What the words need of a gate run: its folder, manifest.json and step marks. */
export type RehearsalRun = Pick<LoadedSession, 'dir' | 'manifest' | 'stamps'>;

/** `manifest.json says <why>, so no SDK measured the chest`; null when an SDK measured it. */
export function notMeasuredWords(manifest: object): string | null {
  const why = whyNotMeasured(manifest as Readonly<Record<string, unknown>>);
  return why === null ? null : `manifest.json says ${why}, so no SDK measured the chest`;
}

/**
 * Whether a run of pack A, B or C played the planted errors of its pack: its objection block (4:15)
 * began, by the step mark in stamps.jsonl. Never for pack 0, the probe, which is played again until
 * it gives GOOD RECORDING (spec 9.4).
 */
export function playedPlantedErrors(run: Pick<LoadedSession, 'stamps'>, pack: GatePack): boolean {
  return pack !== '0' && stepStart(run, gateSteps(pack).objections) !== null;
}

/**
 * What to do with a rehearsal of `pack`, in full sentences: delete the folder with purge and record
 * the pack with the real tap, or, when the run played the planted errors of pack A, B or C, keep the
 * folder as the record of that (PREREG.md section 7.1).
 */
export function rehearsalNextStep(run: RehearsalRun, pack: GatePack): string {
  const purge = `npm run purge -- ${path.basename(run.dir)} --yes`;
  const real = `npm run gate -- --pack ${pack}, without --tap mock`;
  if (pack === '0') return `Delete it with ${purge}, and record the probe with the real tap (${real}).`;
  if (!playedPlantedErrors(run, pack)) {
    return `It stopped before the objection block (4:15), so it played no planted error of pack ${pack}: delete it with ${purge}, and record pack ${pack} with the real tap (${real}).`;
  }
  return `It played the planted errors of pack ${pack} (its objection block, from 4:15, began), and the participant does not hear a pack before it is recorded (PREREG.md section 7.1): keep this folder as the record of that, and do not record pack ${pack} with a participant who heard this run.`;
}

/**
 * quickcheck's line before the verdict of a gate run no SDK measured, with what to do next; null
 * when an SDK measured it.
 */
export function rehearsalLine(run: RehearsalRun, pack: GatePack): string | null {
  const words = notMeasuredWords(run.manifest);
  if (words === null) return null;
  return `This run is a rehearsal, not data: ${words}, and clocks, label and analyze:gate refuse it (PREREG.md section 11). ${rehearsalNextStep(run, pack)}`;
}

/**
 * Why clocks, label or analyze:gate (and retune and confirm through it) refuse a gate recording of
 * `pack` that no SDK measured, and what to do instead; null when an SDK measured it.
 */
export function rehearsalRefusal(run: RehearsalRun, pack: GatePack): string | null {
  const words = notMeasuredWords(run.manifest);
  if (words === null) return null;
  return `this recording is a rehearsal, not a recording of pack ${pack}: ${words} (PREREG.md section 11). ${rehearsalNextStep(run, pack)}`;
}

/**
 * The bracket of quickcheck's RE-RECORD NOW line for a rehearsal of pack A, B or C, in place of the
 * words on what a failed recording of the pack costs (analysis/quickcheck.ts technicalWords).
 */
export function rehearsalVerdictWords(pack: 'A' | 'B' | 'C'): string {
  return `rehearsal, not a recording of pack ${pack}: it does not count, and the rules for a failed recording of pack ${pack} do not apply (PREREG.md section 11)`;
}

/**
 * quickcheck's advice after RE-RECORD NOW on a rehearsal of pack A, B or C, in place of the advice
 * for a failed recording of the pack (analysis/gate/inputs.ts nextRecordingAdvice).
 */
export function rehearsalAdvice(run: RehearsalRun, pack: 'A' | 'B' | 'C'): string {
  return `This run is a rehearsal, not a recording of pack ${pack}, so what PREREG.md sections 7.4 and 11 say about a failed recording of pack ${pack} does not apply to it. ${rehearsalNextStep(run, pack)}`;
}
