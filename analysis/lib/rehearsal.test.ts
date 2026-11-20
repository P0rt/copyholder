// A gate run that no SDK measured is a rehearsal (PREREG.md section 11): the words quickcheck,
// clocks, label and analyze:gate print for it, from manifest.json and the step marks alone. A
// rehearsal of pack A, B or C that reached its objection block played the planted errors of the
// pack (section 7.1), so its folder is kept; any other rehearsal is deleted with purge.

import { describe, expect, it } from 'vitest';
import type { Manifest } from '../../core/schemas/index.ts';
import type { Stamp } from '../../core/clock/index.ts';
import {
  notMeasuredWords,
  playedPlantedErrors,
  rehearsalAdvice,
  rehearsalLine,
  rehearsalNextStep,
  rehearsalRefusal,
  rehearsalVerdictWords,
  type RehearsalRun,
} from './rehearsal.ts';
import { gateSteps } from './steps.ts';

const SDK = { version: '2.0.4', metrics: ['breathing'], launcher: 'node' };
const MOCK_WORDS = 'manifest.json says tap: "mock" (the mock tap made up the chest trace), so no SDK measured the chest';

/** A step mark as Deck stamps it (analysis/lib/session.ts stepMarks). */
const step = (name: string, n: number): Stamp => ({ k: 'mark', what: 'step', name, n }) as unknown as Stamp;

/** A gate run in sessions/<folder>/ with these manifest fields, up to the listening block or into the objection block. */
function run(folder: string, fields: Record<string, unknown>, reached: boolean): RehearsalRun {
  const g = gateSteps('A');
  const stamps = [step(g.listening, 1_000), ...(reached ? [step(g.objections, 9_000)] : [])];
  return { dir: `sessions/${folder}`, manifest: { kind: 'gate', ...fields } as unknown as Manifest, stamps };
}

/** Words that would treat a rehearsal as a failed recording of the pack (PREREG.md sections 7.4 and 11). */
const FAILED_RECORDING = /lost|not recorded again|cannot be recorded again|re-record|next unused pack|pooled numbers/;

describe('a gate run no SDK measured', () => {
  it('names why from manifest.json: the mock tap, the stand-in SDK, or no SDK', () => {
    expect(notMeasuredWords({ kind: 'gate', tap: 'mock', sdk: null })).toBe(MOCK_WORDS);
    expect(notMeasuredWords({ kind: 'gate', tap: 'real', dry: true, sdk: SDK })).toBe('manifest.json says dry: true (tap ran its stand-in SDK), so no SDK measured the chest');
    expect(notMeasuredWords({ kind: 'gate', sdk: null })).toBe('manifest.json says sdk: null (no SDK ran), so no SDK measured the chest');
    expect(notMeasuredWords({ kind: 'gate', tap: null, sdk: null })).toBe('manifest.json says tap: null (not the real tap), so no SDK measured the chest');
  });

  it('says nothing about a run the SDK measured, with or without the tap field', () => {
    expect(notMeasuredWords({ kind: 'gate', tap: 'real', sdk: SDK })).toBeNull();
    expect(notMeasuredWords({ kind: 'gate', sdk: SDK })).toBeNull();
    const real = run('gate-a', { tap: 'real', sdk: SDK }, true);
    expect(rehearsalLine(real, 'A')).toBeNull();
    expect(rehearsalRefusal(real, 'A')).toBeNull();
  });

  it('knows a run of pack A, B or C played the planted errors once its objection block began; the probe never does', () => {
    for (const pack of ['A', 'B', 'C'] as const) {
      expect(playedPlantedErrors(run('x', {}, true), pack)).toBe(true);
      expect(playedPlantedErrors(run('x', {}, false), pack)).toBe(false);
    }
    expect(playedPlantedErrors(run('x', {}, true), '0')).toBe(false);
  });

  // PREREG.md section 7.1: "The participant neither reads nor hears the packs beforehand".
  it('keeps a rehearsal that played the planted errors of pack A, B or C, and deletes any other with purge', () => {
    const mock = { tap: 'mock', sdk: null };
    expect(rehearsalNextStep(run('gate-b', mock, true), 'B')).toBe(
      'It played the planted errors of pack B (its objection block, from 4:15, began), and the participant does not hear a pack before it is recorded (PREREG.md section 7.1): keep this folder as the record of that, and do not record pack B with a participant who heard this run.',
    );
    expect(rehearsalNextStep(run('gate-c-2', mock, false), 'C')).toBe(
      'It stopped before the objection block (4:15), so it played no planted error of pack C: delete it with npm run purge -- gate-c-2 --yes, and record pack C with the real tap (npm run gate -- --pack C, without --tap mock).',
    );
    // The probe is played again until it gives GOOD RECORDING (spec 9.4), so it is always deleted.
    expect(rehearsalNextStep(run('gate-0', mock, true), '0')).toBe(
      'Delete it with npm run purge -- gate-0 --yes, and record the probe with the real tap (npm run gate -- --pack 0, without --tap mock).',
    );
  });

  it("gives quickcheck's line before the verdict, with what to do next", () => {
    const mock = { tap: 'mock', sdk: null };
    expect(rehearsalLine(run('gate-0', mock, true), '0')).toBe(
      `This run is a rehearsal, not data: ${MOCK_WORDS}, and clocks, label and analyze:gate refuse it (PREREG.md section 11). Delete it with npm run purge -- gate-0 --yes, and record the probe with the real tap (npm run gate -- --pack 0, without --tap mock).`,
    );
    expect(rehearsalLine(run('gate-a', mock, true), 'A')).toBe(
      `This run is a rehearsal, not data: ${MOCK_WORDS}, and clocks, label and analyze:gate refuse it (PREREG.md section 11). It played the planted errors of pack A (its objection block, from 4:15, began), and the participant does not hear a pack before it is recorded (PREREG.md section 7.1): keep this folder as the record of that, and do not record pack A with a participant who heard this run.`,
    );
  });

  // retune and confirm reach the refusal through gateLayout and put their own name before it.
  it('gives the refusal of clocks, label and analyze:gate with the pack and the next step, naming no command', () => {
    const mock = { tap: 'mock', sdk: null };
    expect(rehearsalRefusal(run('gate-b', mock, true), 'B')).toBe(
      `this recording is a rehearsal, not a recording of pack B: ${MOCK_WORDS} (PREREG.md section 11). It played the planted errors of pack B (its objection block, from 4:15, began), and the participant does not hear a pack before it is recorded (PREREG.md section 7.1): keep this folder as the record of that, and do not record pack B with a participant who heard this run.`,
    );
    expect(rehearsalRefusal(run('gate-a', { sdk: null }, false), 'A')).toBe(
      'this recording is a rehearsal, not a recording of pack A: manifest.json says sdk: null (no SDK ran), so no SDK measured the chest (PREREG.md section 11). It stopped before the objection block (4:15), so it played no planted error of pack A: delete it with npm run purge -- gate-a --yes, and record pack A with the real tap (npm run gate -- --pack A, without --tap mock).',
    );
    for (const reached of [false, true]) {
      for (const pack of ['0', 'A', 'B', 'C'] as const) {
        expect(rehearsalRefusal(run('gate-x', mock, reached), pack)).not.toMatch(/analyze:gate|clocks|label|retune|confirm/);
      }
    }
  });

  it("puts the rehearsal into quickcheck's verdict and advice, never the rules for a failed recording of the pack", () => {
    const mock = { tap: 'mock', sdk: null };
    expect(rehearsalVerdictWords('B')).toBe('rehearsal, not a recording of pack B: it does not count, and the rules for a failed recording of pack B do not apply (PREREG.md section 11)');
    expect(rehearsalAdvice(run('gate-c', mock, false), 'C')).toBe(
      'This run is a rehearsal, not a recording of pack C, so what PREREG.md sections 7.4 and 11 say about a failed recording of pack C does not apply to it. It stopped before the objection block (4:15), so it played no planted error of pack C: delete it with npm run purge -- gate-c --yes, and record pack C with the real tap (npm run gate -- --pack C, without --tap mock).',
    );
    for (const pack of ['A', 'B', 'C'] as const) {
      for (const reached of [false, true]) {
        const texts = [rehearsalVerdictWords(pack), rehearsalAdvice(run('gate-x', mock, reached), pack), rehearsalLine(run('gate-x', mock, reached), pack)!];
        for (const text of texts) {
          expect(text).not.toMatch(FAILED_RECORDING);
          expect(text).not.toMatch(/[–—]/);
        }
      }
    }
  });
});
