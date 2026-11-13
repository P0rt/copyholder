// The post-hoc runner (spec 7.5 "Своя модель остановок"): own stops, own hold wait, own post-fire
// period, and only detector-independent facts from the recording.

import { describe, expect, it } from 'vitest';
import { runDetectorFile } from './d1.ts';
import { HOLD_WAIT_SAMPLES, RAMP_SAMPLES } from './params.ts';
import { d1Posthoc, firesPerActiveMinute, runPosthoc, type PosthocDetector } from './posthoc.ts';
import { synthSession } from './synth.ts';
import type { BatchInput, DetectorInput, NarratorState } from './types.ts';

const N0 = 480_000;
const PKT = 1600; // one packet per 30 Hz frame, in samples
const T0 = 1_794_935_000_000_000;
const H = HOLD_WAIT_SAMPLES;

const nArrOf = (seq: number): number => N0 + seq * PKT;
const state = (n: number, s: NarratorState): DetectorInput => ({ k: 'state', n, s });
const voice = (n: number, on: boolean): DetectorInput => ({ k: 'voice', n, on });

/** Packets 0..count-1 at nArrOf(seq), with other lines placed before the packet at or after their n. */
function recording(count: number, lines: DetectorInput[] = []): { inputs: DetectorInput[]; nArrBySeq: Map<number, number> } {
  const nArrBySeq = new Map<number, number>();
  const timed: { n: number; order: number; input: DetectorInput }[] = [];
  let order = 0;
  timed.push({ n: N0 - 1, order: order++, input: state(N0 - 1, 'narrating') });
  for (const l of lines) timed.push({ n: l.k === 'voice' || l.k === 'state' ? l.n : 0, order: order++, input: l });
  for (let seq = 0; seq < count; seq++) {
    nArrBySeq.set(seq, nArrOf(seq));
    const b: BatchInput = { k: 'batch', seq, tr: [[T0 + Math.round((seq * 1e6) / 30), 0]] };
    timed.push({ n: nArrOf(seq), order: order++, input: b });
  }
  timed.sort((a, b) => a.n - b.n || a.order - b.order);
  return { inputs: timed.map((t) => t.input), nArrBySeq };
}

interface ScriptState {
  narr: string | null;
}

/** A rival that holds on the listed packets while the narrator reads, as the lines it saw say. */
function scripted(fireOn: (seq: number) => boolean, ownPostFirePeriod = false): PosthocDetector<ScriptState, string> {
  return {
    name: 'scripted',
    ownPostFirePeriod,
    init: () => ({ narr: null }),
    step: (s, input) => {
      if (input.k === 'state') return { state: { narr: input.s }, hold: false };
      const hold = input.k === 'batch' && s.narr === 'narrating' && fireOn(input.seq);
      return hold ? { state: s, hold, fire: `seq ${input.seq}` } : { state: s, hold };
    },
  };
}

const ownStateLines = (inputs: readonly DetectorInput[] | undefined): string[] =>
  (inputs ?? []).filter((r): r is Extract<DetectorInput, { k: 'state' }> => r.k === 'state').map((r) => `${r.s}@${r.n}`);

describe('own stop model (spec 6.4, 7.5)', () => {
  it('a stop is nArr + 384 and the hold wait runs out after 72 000 samples without voice', () => {
    const rec = recording(200);
    const r = runPosthoc(rec.inputs, { detector: scripted((q) => q === 100), nArrBySeq: rec.nArrBySeq, keepInputs: true });
    const nArr = nArrOf(100);
    expect(r.fires).toEqual([{ index: expect.any(Number), seq: 100, nArr, nArrEstimated: false, accepted: true, fire: 'seq 100' }]);
    expect(r.stops).toEqual([{ seq: 100, nCmd: nArr, nSilent: nArr + RAMP_SAMPLES, nResume: nArr + RAMP_SAMPLES + H, why: 'timeout' }]);
    const end = nArr + RAMP_SAMPLES + H;
    expect(ownStateLines(r.inputs)).toEqual([`narrating@${N0 - 1}`, `hold_wait@${nArr}`, `resume@${end}`, `narrating@${end}`]);
    // The resume comes before the first packet that arrives at or after it.
    const seen = r.inputs!;
    const k = seen.findIndex((x) => x.k === 'state' && x.s === 'resume');
    const next = seen[k + 2]!;
    expect(next.k).toBe('batch');
    expect(nArrOf((next as BatchInput).seq)).toBeGreaterThanOrEqual(end);
    expect(nArrOf((seen[k - 1] as BatchInput).seq)).toBeLessThan(end);
  });

  it('voice during the hold wait: listening until voice_off, then resume', () => {
    const nSilent = nArrOf(100) + RAMP_SAMPLES;
    const rec = recording(400, [voice(nSilent + 30_000, true), voice(nSilent + 200_000, false)]);
    const r = runPosthoc(rec.inputs, { detector: scripted((q) => q === 100), nArrBySeq: rec.nArrBySeq, keepInputs: true });
    expect(r.stops).toEqual([{ seq: 100, nCmd: nArrOf(100), nSilent, nResume: nSilent + 200_000, why: 'voice_off' }]);
    expect(ownStateLines(r.inputs)).toEqual([
      `narrating@${N0 - 1}`,
      `hold_wait@${nArrOf(100)}`,
      `listening@${nSilent + 30_000}`,
      `resume@${nSilent + 200_000}`,
      `narrating@${nSilent + 200_000}`,
    ]);
  });

  it('voice that starts after the hold wait ran out does not reopen the stop', () => {
    const nSilent = nArrOf(100) + RAMP_SAMPLES;
    const rec = recording(400, [voice(nSilent + H + 8_000, true), voice(nSilent + H + 100_000, false)]);
    const r = runPosthoc(rec.inputs, { detector: scripted((q) => q === 100), nArrBySeq: rec.nArrBySeq });
    expect(r.stops).toEqual([{ seq: 100, nCmd: nArrOf(100), nSilent, nResume: nSilent + H, why: 'timeout' }]);
  });

  it('voice already going at the fire: listening at once', () => {
    const rec = recording(400, [voice(nArrOf(90), true), voice(nArrOf(200), false)]);
    const r = runPosthoc(rec.inputs, { detector: scripted((q) => q === 100), nArrBySeq: rec.nArrBySeq, keepInputs: true });
    expect(r.stops[0]).toMatchObject({ nResume: nArrOf(200), why: 'voice_off' });
    expect(ownStateLines(r.inputs)).toContain(`listening@${nArrOf(100)}`);
  });

  it('does not see the live stops of the recording', () => {
    // A live stop recorded by Deck from packet 98 on: hold_wait, listening, resume, narrating.
    const live = [
      state(nArrOf(98), 'hold_wait'),
      voice(nArrOf(99) + 500, true),
      state(nArrOf(99) + 500, 'listening'),
      voice(nArrOf(160), false),
      state(nArrOf(160), 'resume'),
      state(nArrOf(160), 'narrating'),
    ];
    const rec = recording(400, live);
    const naive = scripted((q) => q === 101);
    // Fed the recording as it is, the rival would see the narrator stopped and stay silent.
    let s = naive.init();
    let holds = 0;
    for (const input of rec.inputs) {
      const out = naive.step(s, input);
      s = out.state;
      if (out.hold) holds++;
    }
    expect(holds).toBe(0);
    // With its own stop model it reads on, fires, and has its own stop; voice is a fact it sees.
    const r = runPosthoc(rec.inputs, { detector: naive, nArrBySeq: rec.nArrBySeq, keepInputs: true });
    expect(r.stops).toEqual([
      { seq: 101, nCmd: nArrOf(101), nSilent: nArrOf(101) + RAMP_SAMPLES, nResume: nArrOf(160), why: 'voice_off' },
    ]);
    expect(ownStateLines(r.inputs)).toEqual([
      `narrating@${N0 - 1}`,
      `hold_wait@${nArrOf(101)}`,
      `listening@${nArrOf(101)}`,
      `resume@${nArrOf(160)}`,
      `narrating@${nArrOf(160)}`,
    ]);
    expect(r.inputs!.filter((x) => x.k === 'voice')).toHaveLength(2);
  });

  it('follows the reading schedule: no stop outside reading, and a stop ends with the passage', () => {
    const rec = recording(600, [state(nArrOf(120), 'idle'), state(nArrOf(300), 'narrating'), state(nArrOf(520), 'idle')]);
    const fireOn = (q: number): boolean => q === 100 || q === 200 || q === 510;
    const r = runPosthoc(rec.inputs, { detector: scripted(fireOn, true), nArrBySeq: rec.nArrBySeq });
    // Packet 200 is outside reading: the scripted rival is inactive there and never holds.
    expect(r.fires.map((f) => [f.seq, f.accepted])).toEqual([
      [100, true],
      [510, true],
    ]);
    expect(r.stops.map((x) => [x.seq, x.nResume, x.why])).toEqual([
      [100, nArrOf(120), 'schedule'],
      [510, nArrOf(520), 'schedule'],
    ]);
    // A detector that ignores the schedule gets its hold logged but no stop (Deck ignores it).
    const blind: PosthocDetector<null, null> = {
      name: 'blind',
      ownPostFirePeriod: true,
      init: () => null,
      step: (s, input) => ({ state: s, hold: input.k === 'batch' && input.seq === 200 }),
    };
    const b = runPosthoc(rec.inputs, { detector: blind, nArrBySeq: rec.nArrBySeq });
    expect(b.fires.map((f) => [f.seq, f.accepted])).toEqual([[200, false]]);
    expect(b.stops).toEqual([]);
  });

  it('keeps a 2.0 s post-fire period for a detector without its own', () => {
    const rec = recording(900);
    const every = scripted(() => true);
    const r = runPosthoc(rec.inputs, { detector: every, nArrBySeq: rec.nArrBySeq });
    expect(r.stops.length).toBeGreaterThan(5);
    for (let k = 1; k < r.stops.length; k++) {
      const prev = r.stops[k - 1]!;
      const cur = r.stops[k]!;
      expect(cur.nCmd - prev.nCmd).toBeGreaterThanOrEqual(96_000);
      expect(cur.nCmd).toBeGreaterThanOrEqual(prev.nResume!);
      // The first packet that arrives after the period fires again.
      expect(cur.nCmd - prev.nCmd).toBeLessThan(96_000 + PKT);
    }
    expect(r.fires.every((f) => f.accepted)).toBe(true);
    expect(r.suppressed).toBeGreaterThan(0);
    // A detector that keeps its own period is not filtered: its holds in a stop are only logged.
    const own = runPosthoc(rec.inputs, { detector: scripted(() => true, true), nArrBySeq: rec.nArrBySeq });
    expect(own.suppressed).toBe(0);
    expect(own.stops[1]!.nCmd).toBe(own.stops[0]!.nResume! + (PKT - ((own.stops[0]!.nResume! - N0) % PKT)));
  });

  it('marks packets without an arr stamp and stands in the last known arrival', () => {
    const rec = recording(200);
    rec.nArrBySeq.delete(100);
    const r = runPosthoc(rec.inputs, { detector: scripted((q) => q === 100), nArrBySeq: rec.nArrBySeq });
    expect(r.missingArrSeqs).toEqual([100]);
    expect(r.fires[0]).toMatchObject({ seq: 100, nArr: nArrOf(99), nArrEstimated: true, accepted: true });
  });

  it('positions stream.jsonl lines by their own nArr', () => {
    const rec = recording(200);
    const inputs = rec.inputs.map((x) => (x.k === 'batch' ? { ...x, nArr: nArrOf(x.seq) } : x));
    const r = runPosthoc(inputs, { detector: scripted((q) => q === 100), nArrBySeq: new Map() });
    expect(r.missingArrSeqs).toEqual([]);
    expect(r.stops[0]).toMatchObject({ nCmd: nArrOf(100), why: 'timeout' });
  });
});

describe('D1 after the recording (spec 7.4 first-day check, 9.6)', () => {
  it('stops at nArr + 384 with its own hold wait, and counts fires per active minute', () => {
    const ses = synthSession({
      seed: 31,
      durationS: 200,
      objections: [{ atS: 110, voice: false }, { atS: 140 }, { atS: 170, voice: false }],
    });
    const r = runPosthoc(ses.inputs, { detector: d1Posthoc(), nArrBySeq: ses.nArrBySeq, keepInputs: true });
    expect(r.fires.length).toBe(3);
    expect(r.fires.every((f) => f.accepted && !f.nArrEstimated)).toBe(true);
    expect(r.stops.map((x) => x.nSilent)).toEqual(r.fires.map((f) => f.nArr! + RAMP_SAMPLES));
    expect(r.stops.map((x) => x.why)).toEqual(['timeout', 'voice_off', 'timeout']);
    expect(r.stops[1]!.nResume).toBe(ses.objections[1]!.voiceOffN);
    // The same fires come from a plain run over the lines it saw (its own stop lines included).
    const again = runDetectorFile(r.inputs!, {}, 1, 'D1');
    expect(again.fires.map((f) => f.seq)).toEqual(r.fires.map((f) => f.seq));
    // Active time adds up the armed intervals.
    let on: number | null = null;
    let total = 0;
    for (const a of r.armed) {
      if (a.on) on = a.n;
      else if (on !== null) {
        total += a.n - on;
        on = null;
      }
    }
    if (on !== null) total += Math.max(...ses.nArrBySeq.values()) - on;
    expect(r.activeSamples).toBe(total);
    expect(r.activeMinutes).toBeGreaterThan(1);
    expect(firesPerActiveMinute(r)).toBeCloseTo(3 / r.activeMinutes, 12);
  });

  it('reads params/frozen.json like initDetector', () => {
    const ses = synthSession({ seed: 32, durationS: 140, objections: [{ atS: 120, voice: false }] });
    const frozen = { schema: 'params/1', d1: { k: 3.5, arm_breaths: 21 } };
    const r = runPosthoc(ses.inputs, { detector: d1Posthoc(frozen), nArrBySeq: ses.nArrBySeq });
    expect(r.fires).toEqual([]);
    expect(r.activeSamples).toBe(0);
    expect(firesPerActiveMinute(r)).toBeNull();
  });
});
