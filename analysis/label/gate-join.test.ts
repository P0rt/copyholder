// The label step's onsets.json as analysis/gate scores it (spec 4.2, 4.5 point 3): a reply marked
// "No reply" is non-speech and never a valid objection, a reply that only paused at the dot began
// before it, and a cue reply less than 4 s after a remark is a continuation.

import { describe, expect, it } from 'vitest';
import type { SessionData } from '../../core/clock/index.ts';
import type { Manifest, OnsetEvent } from '../../core/schemas/index.ts';
import { makeSyntheticSession } from '../../tests/synthetic/session.ts';
import { isObjection, repliesOfCues, scoreCues, type ValidityContext } from '../gate/objections.ts';
import { inMemorySession } from '../lib/fixtures.ts';
import { gateSteps } from '../lib/steps.ts';
import { withVoices } from './fixture.ts';
import { gateOnsetEvents } from './gate-onsets.ts';
import { NO_REPLY, applyMarks, markFromPage, type LabelItem } from './marks.ts';

const R = 48_000;
const GATE = gateSteps('A');
/** No trace at all: the checks under test all come before the trace checks. */
const NO_TRACE: ValidityContext = { trace: { ts: new Float64Array(0), arr: new Float64Array(0), tsMax: new Float64Array(0) }, codes: [] };

function eventsOf(data: SessionData): OnsetEvent[] {
  const manifest = { schema: 'session/1', id: 'gate-a', kind: 'gate', pack: 'A', scenario: 'gate-A', audio: { settings: data.micSettings } } as unknown as Manifest;
  return gateOnsetEvents(inMemorySession(data, manifest), GATE).events;
}

describe('label answers as analysis/gate scores them', () => {
  it('a reply marked "No reply" is non-speech: never a valid objection (spec 4.2)', () => {
    const cueN = 100 * R;
    const event: OnsetEvent = {
      id: 'o01',
      kind: 'objection',
      label: null,
      voiced_ms: 600,
      floor_db: -60,
      cue: 1,
      n_end: cueN + 2 * R,
      auto: { n_v: cueN + R, n_a: cueN + R + 2000, breath: null, flags: [] },
      manual: null,
    };
    const item: LabelItem = { id: 'o01', anchor: cueN, hasEvent: true };
    const mark = markFromPage(item, { label: NO_REPLY, offset: null }, R);
    if (typeof mark === 'string') throw new Error(mark);
    const [labelled] = applyMarks({ schema: 'onsets/1', labels_sha256: null, events: [event] }, [mark], 'a'.repeat(64)).events;
    expect(labelled).toMatchObject({ label: 'other', manual: { n_v: null, blind: true } });
    // Unlabelled, the event counts as an objection; after "No reply" it does not.
    expect(isObjection(event)).toBe(true);
    expect(isObjection(labelled!)).toBe(false);
    expect(repliesOfCues([cueN], [labelled!], cueN + 20 * R)[0]!.reply).toEqual(labelled);
    const [scored] = scoreCues([cueN], [labelled!], cueN + 20 * R, NO_TRACE);
    expect(scored).toMatchObject({ valid: false, why: 'the first reply is non-speech (other)' });
  });

  it('a reply that only paused at the dot is not valid: its voice began before the dot (spec 4.5)', () => {
    const m = makeSyntheticSession({ scenario: 'gate', narrationS: 80, replies: 3, seed: 6 });
    const c = m.truth.cues;
    const events = eventsOf(
      withVoices(m.session, m.truth, [
        { at: Math.round(c[0]! + 1.2 * R), durS: 0.8 },
        { at: Math.round(c[1]! - 0.7 * R), durS: 0.6 },
        { at: Math.round(c[1]! + 0.4 * R), durS: 0.8 },
        { at: Math.round(c[2]! + 1.2 * R), durS: 0.8 },
      ]),
    );
    const scored = scoreCues(c, events, c[2]! + 20 * R, NO_TRACE);
    expect(scored.map((x) => x.reply?.id ?? null)).toEqual(['o01', 'o02', 'o03']);
    expect(scored[1]).toMatchObject({ valid: false, why: 'the voice began before the cue' });
    // The other cues fail here only for want of a trace.
    expect(scored[0]!.why).toMatch(/trace/);
    expect(scored[2]!.why).toMatch(/trace/);
  });

  it('a cue reply less than 4 s after a remark is a continuation, not a valid objection (spec 4.2, 4.5)', () => {
    const m = makeSyntheticSession({ scenario: 'gate', narrationS: 40, replies: 3, seed: 6 });
    const v = m.truth.voiceOnsets;
    const events = eventsOf(withVoices(m.session, m.truth, [...v.map((at) => ({ at, durS: 0.8 })), { at: Math.round(v[1]! - 3.3 * R), durS: 0.8 }]));
    const scored = scoreCues(m.truth.cues, events, m.truth.cues[2]! + 20 * R, NO_TRACE);
    expect(scored.map((x) => x.reply?.id ?? null)).toEqual(['o01', 'o02', 'o03']);
    expect(scored[1]).toMatchObject({ valid: false, why: 'the first reply is a continuation' });
  });
});
