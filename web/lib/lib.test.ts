import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import type { Step } from '../scenarios/format.ts';
import { ScenarioRunner } from '../scenarios/runner.ts';
import { decodeChunkFrame, encodeChunkFrame } from './chk1.ts';
import { DEMO_CLICK_STARTS_MS, demoClicks, loopCheckClicks } from './clicks.ts';
import { Timeline, scenarioProblems } from './deck-scenario.ts';
import { batchFromTapLine } from './detector-adapter.ts';
import { deckModeOf, narratorStops } from './messages.ts';
import { lineProblems } from './testing/spec-lines.ts';
import { NO_WORDS, interruptedWordIndex, normalizeWordTimings, playedFraction, resumeWordIndex, stopPlan } from './timings.ts';

describe('word timings and the resume rule (spec 6.4, 7.7)', () => {
  const w = normalizeWordTimings([{ startMs: 100, endMs: 300 }, { startMs: 400, endMs: 500 }]);

  it('reads timings.json and the shapes tests use, in samples', () => {
    expect(w).toEqual({ startSamples: [4_800, 19_200], endSamples: [14_400, 24_000], ids: [0, 1] });
    expect(normalizeWordTimings([[100, 300], [400, 500]])).toEqual(w);
    const file = { schema: 'timings/1', words: [{ index: 57, startMs: 100, endMs: 300, sentenceIndex: 4 }, { index: 58, start_ms: 400, end_ms: 500 }] };
    expect(normalizeWordTimings(file)).toEqual({ ...w, ids: [57, 58] });
    expect(normalizeWordTimings({ words: [] })).toEqual({ startSamples: [], endSamples: [], ids: [] });
    expect(() => normalizeWordTimings([{ startMs: 5 }])).toThrow(/word 0/);
    expect(() => normalizeWordTimings([[0, 100], [50, 200]])).toThrow(/starts before/);
    expect(() => normalizeWordTimings([[-1, 100]])).toThrow();
    expect(() => normalizeWordTimings('words')).toThrow();
  });

  it('finds the interrupted word and applies the 80% rule', () => {
    expect(interruptedWordIndex(w, 0)).toBe(0);
    expect(interruptedWordIndex(w, 14_399)).toBe(0);
    expect(interruptedWordIndex(w, 14_400)).toBe(1); // pause: the next word
    expect(interruptedWordIndex(w, 30_000)).toBe(2); // after the last word
    expect(playedFraction(w, 0, 4_800 + 7_680)).toBe(0.8);
    expect(playedFraction(w, 1, 16_000)).toBe(0);
    expect(resumeWordIndex(w, 4_800 + 7_679)).toBe(0);
    expect(resumeWordIndex(w, 4_800 + 7_680)).toBe(1);
    expect(resumeWordIndex(w, 16_000)).toBe(1);
  });

  it('plans a stop: interrupted word for the stamps, resume position and word', () => {
    expect(stopPlan(w, 4_900)).toEqual({ word: 0, resumeFrom: 4_800, resumeWord: 0 });
    expect(stopPlan(w, 4_800 + 7_680)).toEqual({ word: 0, resumeFrom: 19_200, resumeWord: 1 });
    expect(stopPlan(w, 16_000)).toEqual({ word: 1, resumeFrom: 19_200, resumeWord: 1 });
    // 80% of the last word played: reading goes on after it, no word follows.
    expect(stopPlan(w, 19_200 + 3_840)).toEqual({ word: 1, resumeFrom: 24_000, resumeWord: null });
    expect(stopPlan(w, 30_000)).toEqual({ word: null, resumeFrom: null, resumeWord: null });
    expect(stopPlan(NO_WORDS, 1_000)).toEqual({ word: null, resumeFrom: null, resumeWord: null });
    const ids = normalizeWordTimings({ words: [{ index: 57, startMs: 100, endMs: 300 }, { index: 58, startMs: 400, endMs: 500 }] });
    expect(stopPlan(ids, 4_900)).toEqual({ word: 57, resumeFrom: 4_800, resumeWord: 57 });
  });
});

describe('CHK1 frames (docs/protocol.md)', () => {
  it('round-trips any block', () => {
    fc.assert(
      fc.property(fc.array(fc.float({ noNaN: true }), { maxLength: 64 }), fc.nat({ max: 2 ** 40 }), (xs, n0) => {
        const ch0 = new Float32Array(xs);
        const ch1 = new Float32Array(xs.map((x) => -x));
        const buf = encodeChunkFrame(n0, ch0, ch1);
        expect(new TextDecoder().decode(new Uint8Array(buf, 0, 4))).toBe('CHK1');
        expect(buf.byteLength).toBe(16 + 8 * xs.length);
        expect(decodeChunkFrame(buf)).toEqual({ frames: xs.length, n0, ch0, ch1 });
      }),
    );
  });

  it('rejects a wrong magic or length', () => {
    const buf = encodeChunkFrame(0, new Float32Array(2), new Float32Array(2));
    expect(() => decodeChunkFrame(buf.slice(0, 20))).toThrow(/length/);
    const bad = new Uint8Array(buf.slice(0));
    bad[0] = 0x58;
    expect(() => decodeChunkFrame(bad)).toThrow(/magic/);
    expect(() => encodeChunkFrame(0, new Float32Array(2), new Float32Array(3))).toThrow();
  });
});

describe('Deck scenario timeline (docs/protocol.md "Scenario steps")', () => {
  type Draft =
    | { k: 'prompt' | 'rest' | 'clicks' | 'cue'; len: number }
    | { k: 'play'; len: number; until: boolean }
    | { k: 'wait' }
    | { k: 'align'; back: number; offset: number };
  const len = fc.integer({ min: 0, max: 600 });
  const draft: fc.Arbitrary<Draft> = fc.oneof(
    fc.record({ k: fc.constantFrom('prompt' as const, 'rest' as const, 'clicks' as const, 'cue' as const), len }),
    fc.record({ k: fc.constant('play' as const), len, until: fc.boolean() }),
    fc.record({ k: fc.constant('wait' as const) }),
    fc.record({ k: fc.constant('align' as const), back: fc.integer({ min: 1, max: 6 }), offset: fc.integer({ min: 0, max: 3_000 }) }),
  );

  function build(drafts: Draft[]): Step[] {
    const steps: Step[] = [];
    let cueOn = false;
    drafts.forEach((d, i) => {
      const base = { name: `s${i}`, text: '' };
      if (d.k === 'wait') steps.push({ ...base, k: 'wait', lenSamples: 0, until: 'sdk_ok' });
      else if (d.k === 'align' && i > 0) steps.push({ ...base, k: 'align', lenSamples: 0, anchor: `s${Math.max(0, i - d.back)}`, offsetSamples: d.offset });
      else if (d.k === 'align') steps.push({ ...base, k: 'rest', lenSamples: d.offset });
      else if (d.k === 'play') steps.push({ ...base, k: 'play', clip: 'c', ...(d.until ? { lenSamples: 0, untilClipEnd: true } : { lenSamples: d.len }) });
      else if (d.k === 'cue') {
        cueOn = !cueOn;
        steps.push({ ...base, k: 'cue', lenSamples: d.len, i: 1, on: cueOn });
      } else if (d.k === 'clicks') steps.push({ ...base, k: 'clicks', lenSamples: d.len, block: 'A' });
      else steps.push({ ...base, k: d.k, lenSamples: d.len });
    });
    if (cueOn) steps.push({ name: 'cue_off', text: '', k: 'cue', lenSamples: 0, i: 1, on: false });
    steps.push({ name: 'end', text: '', k: 'end', lenSamples: 0 });
    return steps;
  }

  interface Model {
    startsAt(t: number): Array<{ index: number; name: string; n: number; step: Step }>;
    go(t: number): void;
    clipEnded(t: number): void;
  }

  /** Runs sample by sample; a wait is released and an untilClipEnd clip ends `delays` samples after its start. */
  function starts(model: Model, n0: number, delays: number[]): Array<[number, string, number]> {
    const out: Array<[number, string, number]> = [];
    let release: { at: number; kind: 'go' | 'clip' } | null = null;
    let d = 0;
    for (let t = n0; t < n0 + 60_000; t++) {
      for (let changed = true; changed; ) {
        changed = false;
        if (release && release.at <= t) {
          if (release.kind === 'go') model.go(t);
          else model.clipEnded(t);
          release = null;
          changed = true;
        }
        for (const s of model.startsAt(t)) {
          out.push([s.index, s.step.name, s.n]);
          if (s.step.k === 'wait') release = { at: t + (delays[d++ % delays.length] as number), kind: 'go' };
          if (s.step.k === 'play' && s.step.untilClipEnd) release = { at: t + (delays[d++ % delays.length] as number), kind: 'clip' };
          if (s.step.k === 'end') return out;
          changed = true;
        }
      }
    }
    return out;
  }

  it('starts every step at the same sample as web/scenarios/runner.ts', () => {
    fc.assert(
      fc.property(fc.array(draft, { minLength: 1, maxLength: 12 }), fc.array(fc.integer({ min: 0, max: 600 }), { minLength: 1, maxLength: 8 }), fc.nat({ max: 5_000 }), (drafts, delays, n0) => {
        const steps = build(drafts);
        expect(scenarioProblems(steps)).toEqual([]);
        const runner = new ScenarioRunner(steps);
        runner.start(n0);
        const ref = starts({
          startsAt: (t) => runner.advance(t + 1).map((s) => ({ ...s, name: s.step.name })),
          go: (t) => runner.go(t),
          clipEnded: (t) => runner.clipEnded(t),
        }, n0, delays);
        const tl = new Timeline(steps, n0);
        const got = starts({
          startsAt: (t) => {
            const list = [];
            while (tl.nextStart !== null && tl.nextStart <= t) {
              const s = tl.enter(t);
              if (s) list.push({ ...s, name: s.step.name });
            }
            return list;
          },
          go: (t) => tl.go(t),
          clipEnded: (t) => tl.clipEnded(t),
        }, n0, delays);
        expect(got).toEqual(ref);
        expect(got.at(-1)?.[1]).toBe('end');
        expect(tl.ended).toBe(true);
      }),
      { numRuns: 150 },
    );
  });

  it('lists what keeps Deck from running a step list', () => {
    expect(scenarioProblems({})).toEqual(['scenario: steps must be an array']);
    expect(scenarioProblems([{ name: 'x' }])).toEqual(['step 0: not a step']);
    expect(scenarioProblems([{ k: 'rest', name: 'r', text: '', lenSamples: 1 }])).toEqual(['the last step must be end']);
    expect(scenarioProblems([{ k: 'end', name: 'end', text: '', lenSamples: 0 }])).toEqual([]);
  });

  it('clicks steps name a click block: A, B or the demo take (spec 6.3, 15.4)', () => {
    const END: Step = { k: 'end', name: 'end', text: '', lenSamples: 0 };
    const clicks = (block: string): Step[] => [{ k: 'clicks', name: 'c', text: '', lenSamples: 48_000, block } as unknown as Step, END];
    expect(scenarioProblems(clicks('A'))).toEqual([]);
    expect(scenarioProblems(clicks('B'))).toEqual([]);
    expect(scenarioProblems(clicks('demo'))).toEqual([]);
    expect(scenarioProblems(clicks('C'))).toEqual(['step 0 (c): clicks block must be A, B, demo']);
  });

  it('where something can stop the narrator, a play step must play its clip to the end (spec 6.4)', () => {
    const END: Step = { k: 'end', name: 'end', text: '', lenSamples: 0 };
    const timed: Step[] = [{ k: 'play', name: 'listen', text: '', lenSamples: 24_000, clip: 'c' }, END];
    const toEnd: Step[] = [{ k: 'play', name: 'passage', text: '', lenSamples: 0, clip: 'c', untilClipEnd: true }, END];
    expect(scenarioProblems(timed)).toEqual([]);
    expect(scenarioProblems(timed, { narratorStops: false })).toEqual([]);
    expect(scenarioProblems(timed, { narratorStops: true })).toEqual([
      'step 0 (listen): a stop can lengthen the passage in this mode, so a play step needs untilClipEnd (spec 6.4)',
    ]);
    expect(scenarioProblems(toEnd, { narratorStops: true })).toEqual([]);
  });

  it('a stopped timeline starts nothing more; go and clipEnded only release what waits', () => {
    const steps: Step[] = [
      { k: 'wait', name: 'w', text: '', lenSamples: 0, until: 'button', button: 'Go' },
      { k: 'rest', name: 'r', text: '', lenSamples: 10 },
      { k: 'end', name: 'end', text: '', lenSamples: 0 },
    ];
    const tl = new Timeline(steps, 5);
    expect(tl.enter(4)).toBeNull();
    expect(tl.enter(5)?.step.name).toBe('w');
    expect(tl.clipEnded(6)).toBe(false);
    expect(tl.go(7)).toBe(true);
    expect(tl.go(8)).toBe(false);
    expect(tl.enter(7)).toEqual({ index: 1, step: steps[1], n: 7 });
    expect(tl.startOf('r')).toBe(7);
    tl.stop();
    expect(tl.nextStart).toBeNull();
    expect(tl.enter(100)).toBeNull();
    expect(tl.ended).toBe(true);
  });
});

describe('modes, clicks and tap lines', () => {
  it('maps host modes to Deck modes (spec 6.5, 10.2); unknown modes never stop', () => {
    const modes = ['session', 'rehearsal', 'demo', 'headstart', 'live-from', 'live', 'spacebar', 'key', 'live-sim', 'voice'];
    expect(modes.map(deckModeOf)).toEqual(['live', 'live', 'live', 'live', 'live', 'live', 'key', 'key', 'voice', 'voice']);
    const never = ['gate', 'doctor', 'smoke', 'judge', '', undefined, 3];
    expect(never.map(deckModeOf)).toEqual(never.map(() => 'gate'));
    expect((['live', 'key', 'voice', 'gate'] as const).map(narratorStops)).toEqual([true, true, true, false]);
  });

  it('takes the 10 loop-check clicks from core/clock (spec 6.3)', () => {
    const c = loopCheckClicks();
    expect(c.offsetsSamples).toEqual([500, 1_550, 2_830, 3_800, 5_120, 6_250, 7_610, 8_560, 9_870, 11_020].map((ms) => ms * 48));
    expect(c.waveform.length).toBeGreaterThan(0);
    expect(Math.max(...c.waveform.map(Math.abs))).toBeLessThanOrEqual(0.5);
  });

  it('the demo take opens with three clicks at unequal gaps, the loop-check waveform (spec 7.3, 15.4)', () => {
    const d = demoClicks();
    expect(DEMO_CLICK_STARTS_MS).toEqual([250, 1_050, 2_150]);
    expect(d.offsetsSamples).toEqual([12_000, 50_400, 103_200]);
    expect(d.waveform).toEqual(loopCheckClicks().waveform);
    // Within the 3 s before the passage, and the gaps differ, so the video aligns one way only.
    expect((d.offsetsSamples.at(-1) as number) + d.waveform.length).toBeLessThan(3 * 48_000);
    const [a, b, c] = d.offsetsSamples as [number, number, number];
    expect(b - a).not.toBe(c - b);
  });

  it('copies a packet line into a batch line and refuses a line without a seq', () => {
    const line = { seq: 3, k: 'm', tArrNs: '9', tsCbUs: 7, tr: [[1, 0.1], [2, 0.2]], talk: [[1, 1]], g: 0.5, hm: null, lm: { p: [] } };
    expect(batchFromTapLine(line)).toEqual({ k: 'batch', seq: 3, tr: [[1, 0.1], [2, 0.2]], talk: [[1, 1]], g: 0.5, hm: null });
    expect(batchFromTapLine({ k: 'm', tr: [] })).toBeNull();
    expect(batchFromTapLine({ seq: 1.5, k: 'm' })).toBeNull();
  });

  it('spec line checks catch a schema error and a key order that differs from spec 8.1', () => {
    expect(lineProblems('stamps.jsonl', [{ n: 1, k: 'arr', seq: 2 }])).toEqual([]);
    expect(lineProblems('stamps.jsonl', [{ k: 'arr', n: 1, seq: 2 }])).toHaveLength(1);
    expect(lineProblems('stamps.jsonl', [{ n: 1, k: 'hold', cause: 'chest', seq: 1, nSilent: 2, word: null }]).length).toBeGreaterThan(0);
    expect(lineProblems('events.jsonl', [{ n: null, e: 'blur', hard: false }])).toEqual([]);
  });
});
