import fc from 'fast-check';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { Step } from '../scenarios/format.ts';
import { demoClicks } from './clicks.ts';
import { DEFAULT_VAD_PARAMS, resolveVadParams, validateStampLine, vadEdges, vadFrozenBlock, type VadEdge } from './core.ts';
import { DeckCore, deckOptionsFrom, levelDb, resolveDeckVadParams, type DeckOptions } from './deck-core.ts';
import type { DeckStamp, DeckToMain, DeckToWorker, VadMessage, VoiceStamp } from './messages.ts';
import { DeckSim, playThenEnd } from './testing/deck-sim.ts';
import { lineProblems } from './testing/spec-lines.ts';
import { evenWords, noise, synthPassage, voicedTone, type SynthWord } from './testing/synth.ts';
import { msToSamples } from './units.ts';

const WORDS = evenWords(6, 600, 400); // word i: 200+1000i .. 800+1000i ms; pauses of 400 ms
const PCM = synthPassage(WORDS, 6000);

function liveSim(opts: ConstructorParameters<typeof DeckSim>[0] = {}, words: SynthWord[] = WORDS, pcm = PCM): DeckSim {
  const sim = new DeckSim({ mode: 'live', ...opts });
  sim.start([{ name: 'p1', pcm, timings: words }], playThenEnd('p1', { untilClipEnd: true }));
  return sim;
}

function fadeSample(pcm: Float32Array, p: number, j: number, gain = 1): number {
  return Math.fround(((pcm[p + j] as number) * ((1 * (384 - j)) / 384)) * gain);
}

/** Every stamp passes core/schemas and is written in the key order of spec 8.1. */
function expectSpecStamps(stamps: readonly DeckStamp[]): void {
  expect(lineProblems('stamps.jsonl', stamps)).toEqual([]);
}

function silentFrom(out: number[], from: number, to: number): number {
  for (let t = from; t < to; t++) if (out[t] !== 0) return t;
  return -1;
}

describe('Deck stop rule (spec 6.2, 6.4, 7.3)', () => {
  it('mid-word: nCmd = nArr, nSilent = nCmd + 384, linear fade, pointer frozen, silence until H expires', () => {
    const sim = liveSim();
    sim.runTo(24_000); // word 0 spans 9600-38400
    const nCmd = sim.n;
    sim.pkt(7, true);
    sim.runTo(nCmd + 384 + 72_000 + 4_000);
    expect(sim.of('arr')).toEqual([{ n: nCmd, k: 'arr', seq: 7 }]);
    expect(sim.of('hold')).toEqual([{ n: nCmd, k: 'hold', cause: 'chest', seq: 7, nSilent: nCmd + 384, word: 0 }]);
    for (let j = 0; j < 384; j++) expect(sim.out[nCmd + j]).toBe(fadeSample(PCM, nCmd, j));
    expect(silentFrom(sim.out, nCmd + 384, nCmd + 384 + 72_000)).toBe(-1);
    const resume = sim.of('resume')[0];
    expect(resume).toEqual({ n: nCmd + 384 + 72_000, k: 'resume', word: 0 });
    // From the start of word 0 with a 10 ms fade-in.
    const r = resume?.n as number;
    const w0 = msToSamples(200);
    for (let j = 0; j < 480; j++) expect(sim.out[r + j]).toBe(Math.fround((PCM[w0 + j] as number) * ((j + 1) / 480)));
    expect(sim.out[r + 600]).toBe(PCM[w0 + 600]);
    expect(sim.states()).toEqual([[0, 'narrating'], [nCmd, 'hold_wait'], [r, 'resume'], [r, 'narrating']]);
    expect(sim.mainOf('state').map((m) => m.cause)).toEqual([null, 'chest', null, null]);
    expectSpecStamps(sim.stamps);
  });

  it('in a narrator pause the same rule holds: nSilent = nCmd + 384; resume from the next word', () => {
    const sim = liveSim();
    sim.runTo(96_000); // pause 86400-105600 between words 1 and 2
    const nCmd = sim.n;
    expect(PCM[nCmd]).toBe(0);
    sim.pkt(8, true);
    sim.runTo(nCmd + 384 + 72_000 + 1_000);
    expect(sim.of('hold')).toEqual([{ n: nCmd, k: 'hold', cause: 'chest', seq: 8, nSilent: nCmd + 384, word: 2 }]);
    expect(sim.of('resume')).toEqual([{ n: nCmd + 384 + 72_000, k: 'resume', word: 2 }]);
    expect(silentFrom(sim.out, nCmd, nCmd + 384 + 72_000)).toBe(-1);
    expect(sim.out[nCmd + 384 + 72_000 + 600]).toBe(PCM[msToSamples(2200) + 600]);
  });

  it('resumes from the next word when at least 80% of the interrupted word played', () => {
    const sim = liveSim();
    sim.runTo(178_048); // word 3 spans 153600-182400; 84.9% played
    const nCmd = sim.n;
    sim.pkt(9, true);
    sim.runTo(nCmd + 384 + 72_000 + 2_000);
    expect(sim.of('hold')[0]?.word).toBe(3);
    expect(sim.of('resume')[0]?.word).toBe(4);
    const r = sim.of('resume')[0]?.n as number;
    expect(sim.out[r + 1000]).toBe(PCM[msToSamples(4200) + 1000]);
  });

  it('after the last word the stop names no word and reading goes on from where it froze', () => {
    const words = evenWords(2, 300, 200, 100); // 100-400, 600-900 ms; clip 2000 ms
    const pcm = synthPassage(words, 2000);
    const sim = liveSim({}, words, pcm);
    sim.runTo(60_032); // 1250 ms: after the last word
    const nCmd = sim.n;
    sim.pkt(1, true);
    sim.runTo(nCmd + 384 + 72_000 + 128);
    expect(sim.of('hold')[0]).toEqual({ n: nCmd, k: 'hold', cause: 'chest', seq: 1, nSilent: nCmd + 384, word: null });
    expect(sim.of('resume')[0]).toEqual({ n: nCmd + 384 + 72_000, k: 'resume', word: null });
    expect(sim.deck.readPointer).toBeGreaterThan(nCmd + 384);
  });

  it('voice in HOLD_WAIT goes LISTENING; voice_off resumes (why voice_off is told by the state before)', () => {
    const sim = liveSim({ edges: [{ n: 60_000, on: true }, { n: 150_000, on: false }] });
    sim.runTo(50_000);
    const nCmd = sim.n;
    sim.pkt(1, true);
    sim.runTo(160_000);
    expect(sim.states().slice(1)).toEqual([
      [nCmd, 'hold_wait'], [60_000, 'listening'], [150_000, 'resume'], [150_000, 'narrating'],
    ]);
    expect(sim.of('voice')).toEqual([{ n: 60_000, k: 'voice', on: true }, { n: 150_000, k: 'voice', on: false }]);
    expect(sim.of('resume')[0]?.n).toBe(150_000);
    expectSpecStamps(sim.stamps);
  });

  it('voice_on at nSilent + 72000 is too late: the narrator resumes first, then the safety stops it', () => {
    const nCmd = 30_080;
    const deadline = nCmd + 384 + 72_000;
    const sim = liveSim({ edges: [{ n: deadline, on: true }] });
    sim.runTo(nCmd);
    sim.pkt(1, true);
    sim.runTo(deadline + 13_000);
    expect(sim.states().slice(1, 4)).toEqual([[nCmd, 'hold_wait'], [deadline, 'resume'], [deadline, 'narrating']]);
    expect(sim.of('hold')[1]).toEqual({ n: deadline + 12_000, k: 'hold', cause: 'voice', nSilent: deadline + 12_384, word: expect.any(Number) });
  });

  it('a chest hold after voice_on but before the safety is a normal CHEST stop, then LISTENING', () => {
    const sim = liveSim({ edges: [{ n: 40_000, on: true }, { n: 120_000, on: false }] });
    sim.runTo(45_056);
    const nCmd = sim.n;
    sim.pkt(3, true);
    sim.runTo(130_000);
    const holds = sim.of('hold');
    expect(holds).toHaveLength(1);
    expect(holds[0]).toMatchObject({ n: nCmd, cause: 'chest', seq: 3 });
    expect(sim.states().slice(1, 3)).toEqual([[nCmd, 'hold_wait'], [nCmd, 'listening']]);
    expect(sim.mainOf('state').slice(1, 3).map((m) => m.cause)).toEqual(['chest', 'chest']);
  });

  it('the audio safety is recorded as cause voice, never chest; holds and keys outside NARRATING are only stamped', () => {
    const sim = liveSim({ edges: [{ n: 30_000, on: true }, { n: 110_000, on: false }] });
    sim.runTo(60_000);
    // 42000 lies in the pause after word 0 (9600-38400): the interrupted word is the next one.
    expect(sim.of('hold')).toEqual([{ n: 42_000, k: 'hold', cause: 'voice', nSilent: 42_384, word: 1 }]);
    expect(sim.states()[1]).toEqual([42_000, 'listening']);
    const nIgnored = sim.n;
    sim.pkt(11, true); // arrives while LISTENING
    sim.send({ k: 'key' });
    sim.runTo(120_000);
    expect(sim.of('hold')).toHaveLength(1);
    expect(sim.of('ignored')).toEqual([
      { n: nIgnored, k: 'ignored', what: 'hold', seq: 11, s: 'listening' },
      { n: nIgnored, k: 'ignored', what: 'key', s: 'listening' },
    ]);
    expect(sim.mainOf('state').find((m) => m.s === 'listening')?.cause).toBe('voice');
    expectSpecStamps(sim.stamps);
  });

  it('a hold:true packet while idle is stamped as ignored with s idle', () => {
    const sim = new DeckSim({ mode: 'live' });
    sim.runTo(1_280);
    sim.pkt(5, true);
    expect(sim.stamps).toEqual([{ n: 1_280, k: 'arr', seq: 5 }, { n: 1_280, k: 'ignored', what: 'hold', seq: 5, s: 'idle' }]);
    expectSpecStamps(sim.stamps);
  });
});

describe('Deck modes (spec 6.5)', () => {
  it('gate mode never stops the narrator: no audio safety; a stray hold is only stamped', () => {
    const sim = new DeckSim({ mode: 'gate', edges: [{ n: 30_000, on: true }, { n: 100_000, on: false }] });
    sim.start([{ name: 'p1', pcm: PCM, timings: WORDS }], playThenEnd('p1', { untilClipEnd: true }));
    sim.runTo(50_048);
    sim.pkt(1, true);
    sim.send({ k: 'key' });
    sim.runTo(PCM.length + 1_000);
    expect(sim.of('hold')).toEqual([]);
    expect(sim.of('ignored').map((s) => s.s)).toEqual(['narrating', 'narrating']);
    for (let t = 0; t < PCM.length; t++) {
      if (sim.out[t] !== PCM[t]) throw new Error(`output differs from the clip at ${t}`);
    }
    expect(sim.states()).toEqual([[0, 'narrating'], [PCM.length, 'idle']]);
    expect(sim.mainOf('done')).toEqual([{ k: 'done', n: PCM.length }]);
  });

  it('key mode: the space bar stops with cause key; chest holds are ignored; the safety is on', () => {
    const sim = new DeckSim({ mode: 'key', edges: [{ n: 200_000, on: true }] });
    sim.start([{ name: 'p1', pcm: PCM, timings: WORDS }], playThenEnd('p1', { untilClipEnd: true }));
    sim.runTo(20_096);
    const nKey = sim.n;
    sim.send({ k: 'key' });
    sim.pkt(4, true);
    sim.runTo(230_000);
    expect(sim.stamps.slice(2, 7)).toEqual([
      { n: nKey, k: 'mark', what: 'key' },
      { n: nKey, k: 'hold', cause: 'key', nSilent: nKey + 384, word: 0 },
      { n: nKey, k: 'state', s: 'hold_wait' },
      { n: nKey, k: 'arr', seq: 4 },
      { n: nKey, k: 'ignored', what: 'hold', seq: 4, s: 'hold_wait' },
    ]);
    expect(sim.mainOf('state')[1]).toEqual({ k: 'state', n: nKey, s: 'hold_wait', cause: 'key' });
    expect(sim.of('hold')[1]).toMatchObject({ n: 212_000, cause: 'voice' });
    expectSpecStamps(sim.stamps);
  });

  it('live mode stamps a space bar press as a mark and ignores it', () => {
    const sim = liveSim();
    sim.runTo(1_280);
    sim.send({ k: 'key' });
    expect(sim.stamps.slice(-2)).toEqual([
      { n: 1_280, k: 'mark', what: 'key' },
      { n: 1_280, k: 'ignored', what: 'key', s: 'narrating' },
    ]);
  });

  it('voice mode (live-sim): only the audio safety stops the narrator; chest holds and keys are only stamped', () => {
    const sim = new DeckSim({ mode: 'voice', edges: [{ n: 60_000, on: true }, { n: 150_000, on: false }] });
    sim.start([{ name: 'p1', pcm: PCM, timings: WORDS }], playThenEnd('p1', { untilClipEnd: true }));
    sim.runTo(20_096);
    const t = sim.n;
    sim.pkt(4, true);
    sim.send({ k: 'key' });
    sim.runTo(160_000);
    expect(sim.of('ignored')).toEqual([
      { n: t, k: 'ignored', what: 'hold', seq: 4, s: 'narrating' },
      { n: t, k: 'ignored', what: 'key', s: 'narrating' },
    ]);
    // 72000 lies in word 1 (57600-86400), half of it played.
    expect(sim.of('hold')).toEqual([{ n: 72_000, k: 'hold', cause: 'voice', nSilent: 72_384, word: 1 }]);
    expect(sim.states()).toEqual([[0, 'narrating'], [72_000, 'listening'], [150_000, 'resume'], [150_000, 'narrating']]);
    expect(sim.mainOf('state')[1]).toEqual({ k: 'state', n: 72_000, s: 'listening', cause: 'voice' });
    expectSpecStamps(sim.stamps);
  });

  it('where something can stop the narrator, a timed play step is refused; gate mode runs it (spec 6.4)', () => {
    for (const mode of ['live', 'key', 'voice'] as const) {
      const sim = new DeckSim({ mode });
      sim.start([{ name: 'p1', pcm: PCM, timings: WORDS }], playThenEnd('p1', { lenSamples: 96_000 }));
      sim.runTo(10_000);
      expect(sim.mainOf('error').map((e) => e.message)).toEqual([
        'scenario: step 0 (play_p1): a stop can lengthen the passage in this mode, so a play step needs untilClipEnd (spec 6.4)',
      ]);
      expect(sim.states()).toEqual([]);
    }
    const gate = new DeckSim({ mode: 'gate' });
    gate.start([{ name: 'p1', pcm: PCM, timings: WORDS }], playThenEnd('p1', { lenSamples: 96_000 }));
    gate.runTo(100_000);
    expect(gate.mainOf('error')).toEqual([]);
    expect(gate.states()).toEqual([[0, 'narrating'], [96_000, 'idle']]);
  });

  it('a clip that starts while the voice has held 250 ms stops in its first sample (spec 6.4)', () => {
    const words = evenWords(6, 600, 400, 0); // sound from sample 0
    const pcm = synthPassage(words, 6_000);
    const sim = new DeckSim({ mode: 'live', edges: [{ n: 10_000, on: true }, { n: 100_000, on: false }] });
    sim.start([{ name: 'p1', pcm, timings: words }], [
      { k: 'wait', name: 'ready', text: 'Ready?', lenSamples: 0, until: 'button', button: 'Start' },
      ...playThenEnd('p1', { untilClipEnd: true }),
    ]);
    sim.runTo(30_000);
    const g = sim.n; // voice on for 20 000 samples
    sim.send({ k: 'go' });
    sim.runTo(110_000);
    expect(sim.of('hold')).toEqual([{ n: g, k: 'hold', cause: 'voice', nSilent: g + 384, word: 0 }]);
    expect(sim.states()).toEqual([[g, 'narrating'], [g, 'listening'], [100_000, 'resume'], [100_000, 'narrating']]);
    expect(sim.mainOf('state').map((m) => m.cause)).toEqual([null, 'voice', null, null]);
    for (let j = 0; j < 384; j++) expect(sim.out[g + j]).toBe(fadeSample(pcm, 0, j));
    expect(silentFrom(sim.out, g + 384, 100_000)).toBe(-1);
    expectSpecStamps(sim.stamps);
  });
});

describe('Deck recording, meters and scenario (docs/protocol.md)', () => {
  it('records contiguous 9600-frame blocks: ch0 = microphone, ch1 = own output after gain; flushes at stop', () => {
    const mic = (n: number) => Math.fround(Math.sin(n / 7) * 0.1);
    const sim = liveSim({ mic, gain: 0.5 });
    sim.runTo(50_000);
    const stopAt = sim.n;
    sim.send({ k: 'stop' });
    sim.runTo(52_000);
    let n0 = 0;
    for (const c of sim.chunks) {
      expect(c.n0).toBe(n0);
      n0 += c.frames;
    }
    expect(sim.chunks.slice(0, -1).every((c) => c.frames === 9_600)).toBe(true);
    const done = sim.mainOf('done');
    expect(done).toEqual([{ k: 'done', n: stopAt + 384 }]);
    expect(n0).toBe(stopAt + 384);
    // The last chunk comes before done on the worker port.
    expect(sim.toWorker.at(-1)).toEqual({ k: 'done', n: stopAt + 384 });
    expect(sim.toWorker.at(-2)?.k).toBe('chunk');
    for (const c of sim.chunks) {
      for (let i = 0; i < c.frames; i++) {
        if (c.ch0[i] !== Math.fround(mic(c.n0 + i))) throw new Error(`ch0 mismatch at ${c.n0 + i}`);
        if (c.ch1[i] !== sim.out[c.n0 + i]) throw new Error(`ch1 mismatch at ${c.n0 + i}`);
      }
    }
    expect(sim.out[9_700]).toBe(Math.fround((PCM[9_700] as number) * 0.5));
    for (let j = 0; j < 384; j++) expect(sim.out[stopAt + j]).toBe(fadeSample(PCM, stopAt, j, 0.5));
    expect(silentFrom(sim.out, stopAt + 384, 52_000)).toBe(-1);
    expect(sim.states().at(-1)).toEqual([stopAt, 'idle']);
    const levels = sim.mainOf('level');
    expect(levels.length).toBe(Math.floor((stopAt + 384) / 4_800));
    expect(levels[0]?.ch0Db).toBeCloseTo(levelDb(0.005), 0);
    expect(Object.keys(levels[0] ?? {})).toEqual(['k', 'ch0Db', 'ch1Db']);
  });

  it('runs a scenario on the sample clock: wait/go, prompt, cue, clicks, play, align and end', () => {
    const clip = synthPassage(evenWords(2, 100, 50, 50), 400); // 19 200 samples, shorter than the play step
    const steps: Step[] = [
      { k: 'wait', name: 'sdk_start', text: 'Starting camera...', lenSamples: 0, until: 'sdk_ok' },
      { k: 'clicks', name: 'loop_a', block: 'A', text: 'Hold one earcup on the microphone', lenSamples: 48_000 },
      { k: 'prompt', name: 'breathe', text: 'Breathe in', lenSamples: 4_800, bar: 'grow' },
      { k: 'play', name: 'listen', text: '', lenSamples: 24_000, clip: 'c1' },
      { k: 'cue', name: 'cue_1_on', text: '', lenSamples: 2_400, i: 1, on: true },
      { k: 'cue', name: 'cue_1_off', text: '', lenSamples: 0, i: 1, on: false },
      { k: 'play', name: 'tail', text: '', lenSamples: 0, clip: 'c1', untilClipEnd: true },
      { k: 'align', name: 'hold_b', text: '', lenSamples: 0, anchor: 'loop_a', offsetSamples: 300_000 },
      { k: 'rest', name: 'rest', text: 'Rest', lenSamples: 480 },
      { k: 'end', name: 'end', text: '', lenSamples: 0 },
    ];
    const sim = new DeckSim({ mode: 'gate', clickOffsetsSamples: [100, 1000], clickWaveform: new Float32Array([0.5, 0.25]) });
    sim.start([{ name: 'c1', pcm: clip }], steps);
    sim.runTo(2_560);
    const g = sim.n;
    sim.send({ k: 'go' });
    sim.send({ k: 'go' }); // nothing waits any more: no effect
    sim.runTo(g + 300_000 + 2_000);
    const L = clip.length;
    const tPlay = g + 48_000 + 4_800;
    const tTail = tPlay + 24_000 + 2_400;
    const marks = sim.of('mark').map((m) => [m.n, m.what === 'step' ? m.name : m.what === 'cue' ? `cue ${m.i} ${m.on}` : m.what]);
    expect(marks).toEqual([
      [0, 'sdk_start'],
      [g, 'loop_a'],
      [g + 48_000, 'breathe'],
      [tPlay, 'listen'],
      [tPlay + 24_000, 'cue_1_on'],
      [tPlay + 24_000, 'cue 1 true'],
      [tPlay + 26_400, 'cue_1_off'],
      [tPlay + 26_400, 'cue 1 false'],
      [tTail, 'tail'],
      [tTail + L, 'hold_b'],
      [g + 300_000, 'rest'],
      [g + 300_480, 'end'],
    ]);
    expect(sim.of('click')).toEqual([{ n: g + 100, k: 'click', i: 0 }, { n: g + 1_000, k: 'click', i: 1 }]);
    // Every click also goes to the page, which flashes the square (spec 15.4).
    expect(sim.mainOf('click')).toEqual([{ k: 'click', n: g + 100, i: 0, block: 'A' }, { k: 'click', n: g + 1_000, i: 1, block: 'A' }]);
    expect([sim.out[g + 100], sim.out[g + 101], sim.out[g + 102]]).toEqual([0.5, 0.25, 0]);
    expect(sim.mainOf('step')).toEqual(steps.map((s) => ({ k: 'step', n: marks.find((m) => m[1] === s.name)?.[0], name: s.name, text: s.text })));
    expect(sim.mainOf('cue')).toEqual([{ k: 'cue', n: tPlay + 24_000, on: true }, { k: 'cue', n: tPlay + 26_400, on: false }]);
    // The first clip ends on its own (L < 24000); the second one releases the align step where it ends.
    expect(sim.states()).toEqual([[tPlay, 'narrating'], [tPlay + L, 'idle'], [tTail, 'narrating'], [tTail + L, 'idle']]);
    expect(sim.mainOf('done')).toEqual([{ k: 'done', n: g + 300_480 }]);
    expect(sim.chunks.reduce((a, c) => a + c.frames, 0)).toBe(g + 300_480);
    expectSpecStamps(sim.stamps);
  });

  it('demo clicks: three clicks at their offsets, each stamped and sent to the page for the square (spec 7.3, 15.4)', () => {
    const sim = new DeckSim({ mode: 'live', clickWaveform: new Float32Array([0.5, -0.5]) });
    const steps = [
      { k: 'clicks', name: 'demo_clicks', block: 'demo', text: '', lenSamples: 144_000 },
      ...playThenEnd('p1', { untilClipEnd: true }),
    ] as unknown as Step[];
    sim.start([{ name: 'p1', pcm: PCM, timings: WORDS }], steps);
    sim.runTo(150_000);
    expect(sim.mainOf('error')).toEqual([]);
    const offsets = demoClicks().offsetsSamples;
    expect(sim.of('click')).toEqual(offsets.map((o, i) => ({ n: o, k: 'click', i })));
    expect(sim.mainOf('click')).toEqual(offsets.map((o, i) => ({ k: 'click', n: o, i, block: 'demo' })));
    for (const o of offsets) expect([sim.out[o - 1], sim.out[o], sim.out[o + 1], sim.out[o + 2]]).toEqual([0, 0.5, -0.5, 0]);
    // The passage follows the clicks step.
    expect(sim.states()[0]).toEqual([144_000, 'narrating']);
    expectSpecStamps(sim.stamps);
  });

  it('Stop during the clicks: no further clicks, the current click plays out, then done', () => {
    const wave = new Float32Array(240).fill(0.1);
    const sim = new DeckSim({ mode: 'live', clickOffsetsSamples: [1_000, 5_000], clickWaveform: wave });
    sim.start([], [
      { k: 'clicks', name: 'loop_b', block: 'B', text: '', lenSamples: 48_000 },
      { k: 'end', name: 'end', text: '', lenSamples: 0 },
    ]);
    sim.runTo(1_024);
    const t = sim.n;
    sim.send({ k: 'stop' });
    sim.runTo(10_000);
    expect(sim.of('click')).toEqual([{ n: 1_000, k: 'click', i: 0 }]);
    expect(sim.mainOf('done')).toEqual([{ k: 'done', n: 1_240 }]);
    expect(sim.out.slice(1_000, 1_240).every((x) => x === Math.fround(0.1))).toBe(true);
    expect(sim.of('mark').map((m) => (m.what === 'step' ? m.name : m.what))).toEqual(['loop_b']);
    expect(t).toBe(1_024);
  });

  it('reports a scenario it cannot run and messages it cannot use', () => {
    const sim = new DeckSim({ mode: 'live' });
    sim.send({ k: 'scenario', steps: [{ k: 'rest', name: 'r', text: '', lenSamples: 10 }] });
    sim.send({ k: 'load', name: 'x', pcm: [1, 2] as unknown as Float32Array, timings: null });
    sim.send({ k: 'load', name: 'y', pcm: new Float32Array(10), timings: { words: [{ startMs: 5 }] } });
    sim.worker({ k: 'pkt', seq: -1, hold: false });
    const errors = sim.mainOf('error').map((e) => e.message);
    expect(errors).toHaveLength(4);
    expect(errors[0]).toMatch(/last step must be end/);
    // Live mode: a play step that ends on a timer could start the next clip during a stop.
    sim.send({ k: 'scenario', steps: playThenEnd('y') });
    expect(sim.mainOf('error').at(-1)?.message).toMatch(/play step needs untilClipEnd/);
    sim.send({ k: 'scenario', steps: playThenEnd('y', { untilClipEnd: true }) });
    expect(sim.mainOf('error')).toHaveLength(5);
    sim.send({ k: 'scenario', steps: playThenEnd('y', { untilClipEnd: true }) });
    expect(sim.mainOf('error').at(-1)?.message).toMatch(/one scenario/);
  });

  it('a stopped Deck sends nothing more', () => {
    const sim = liveSim();
    sim.runTo(1_280);
    sim.send({ k: 'stop' });
    sim.runTo(3_000);
    const count = sim.toWorker.length;
    sim.pkt(1, true);
    sim.send({ k: 'key' });
    sim.runTo(20_000);
    expect(sim.toWorker.length).toBe(count);
    expect(sim.out.slice(3_000, 20_000).every((x) => x === 0)).toBe(true);
  });
});

/** A DeckCore with the real core/vad, driven by a microphone signal quantum by quantum. */
function realDeck(opts: DeckOptions) {
  const toWorker: DeckToWorker[] = [];
  const main: DeckToMain[] = [];
  const deck = new DeckCore(opts, { toMain: (m) => main.push(m), toWorker: (m) => toWorker.push(m) });
  const out = new Float32Array(128);
  return {
    deck,
    toWorker,
    main,
    /** A rest step long enough for `samples`, then end. */
    rest(samples: number): void {
      deck.onMainMessage({ k: 'scenario', steps: [
        { k: 'rest', name: 'r', text: '', lenSamples: samples - 128 },
        { k: 'end', name: 'end', text: '', lenSamples: 0 },
      ] });
    },
    run(mic: Float32Array, from: number, to: number): void {
      for (let n = from; n + 128 <= to; n += 128) deck.process(mic.subarray(n, n + 128), [out], 128);
    },
    vads: () => toWorker.filter((m): m is VadMessage => m.k === 'vad'),
    voice: () => toWorker.flatMap((m) => (m.k === 'stamp' && m.line.k === 'voice' ? [{ n: m.line.n, on: (m.line as VoiceStamp).on }] : [])),
    rec0(): Float32Array {
      const parts = toWorker.flatMap((m) => (m.k === 'chunk' ? [m.ch0] : []));
      const all = new Float32Array(parts.reduce((a, p) => a + p.length, 0));
      let at = 0;
      for (const p of parts) {
        all.set(p, at);
        at += p.length;
      }
      return all;
    },
  };
}

const edgesOf = (es: readonly VadEdge[]) => es.map((e) => ({ n: e.n, on: e.on }));

describe('Deck with the real core/vad', () => {
  it('voice stamps equal vadEdges() recomputed from the recorded channel 0; breath noise gives no edge', () => {
    // 1.0-1.6 s breath-like noise, 1.6-2.6 s voiced tone, then silence.
    const micSig = new Float32Array(4 * 48_000);
    micSig.set(noise(msToSamples(600), 0.03, 7), msToSamples(1_000));
    micSig.set(voicedTone(48_000, 140, 0.2), msToSamples(1_600));
    const stamps: DeckStamp[] = [];
    const rec0: number[] = [];
    const deck = new DeckCore({ mode: 'live' }, {
      toMain: () => {},
      toWorker: (m: DeckToWorker) => {
        if (m.k === 'stamp') stamps.push(m.line);
        if (m.k === 'chunk') rec0.push(...m.ch0);
      },
    });
    deck.onMainMessage({ k: 'scenario', steps: [
      { k: 'rest', name: 'r', text: '', lenSamples: micSig.length - 128 },
      { k: 'end', name: 'end', text: '', lenSamples: 0 },
    ] });
    const out = new Float32Array(128);
    for (let n = 0; n + 128 <= micSig.length; n += 128) deck.process(micSig.subarray(n, n + 128), [out], 128);
    const recorded = stamps.filter((s) => s.k === 'voice').map((s) => ({ n: s.n, on: (s as { on: boolean }).on }));
    expect(recorded.map((e) => e.on)).toEqual([true, false]);
    expect(recorded[0]?.n).toBeGreaterThan(msToSamples(1_600));
    expect(vadEdges(new Float32Array(rec0), DEFAULT_VAD_PARAMS, 0).map((e) => ({ n: e.n, on: e.on }))).toEqual(recorded);
  });

  it('records the parameters it runs with from sample 0, with their source (spec 7.3)', () => {
    expect(realDeck({ mode: 'live' }).toWorker[0]).toEqual({ k: 'vad', n: 0, source: 'default', params: vadFrozenBlock(DEFAULT_VAD_PARAMS) });
    expect(realDeck({ mode: 'live', vadSource: 'none in /api/config' }).toWorker[0]).toEqual({
      k: 'vad', n: 0, source: 'default', note: 'none in /api/config', params: vadFrozenBlock(DEFAULT_VAD_PARAMS),
    });
    const opts = deckOptionsFrom({ mode: 'session', vadParams: { floorDb: -45, periodicity: 0.7 }, vadSource: 'frozen + doctor floor' });
    expect(opts).toEqual({ mode: 'live', vadParams: { floorDb: -45, periodicity: 0.7 }, vadSource: 'frozen + doctor floor' });
    expect(realDeck(opts).toWorker[0]).toEqual({
      k: 'vad', n: 0, source: 'options', note: 'frozen + doctor floor', params: vadFrozenBlock({ floorDb: -45, periodicity: 0.7 }),
    });
    // The vad block of params/frozen.json is taken as it is.
    const block = { ...vadFrozenBlock(), floor_db: -52, off_ms: 900 };
    expect(realDeck({ mode: 'live', vadParams: block }).toWorker[0]).toEqual({ k: 'vad', n: 0, source: 'options', params: block });
    // Unusable parameters: the page hears it; the record holds the defaults Deck runs with and why.
    const bad = realDeck({ mode: 'live', vadParams: { floorDb: -45, bogus: 1 } });
    expect(bad.main).toEqual([{ k: 'error', message: expect.stringMatching(/^unusable vadParams: .*bogus.*DEFAULT_VAD_PARAMS$/) }]);
    expect(bad.toWorker[0]).toEqual({
      k: 'vad', n: 0, source: 'default', note: expect.stringMatching(/^unusable vadParams: .*bogus/), params: vadFrozenBlock(DEFAULT_VAD_PARAMS),
    });
    // A frozen block has no sample rate: only 48 kHz parameters can be recorded faithfully.
    expect(() => resolveDeckVadParams({ floorDb: -45, sampleRateHz: 44_100 })).toThrow(/sampleRateHz must be 48000/);
    expect(resolveDeckVadParams(null)).toBe(DEFAULT_VAD_PARAMS);
  });

  it('with the page parameters, voice stamps equal vadEdges() with those parameters, not with the defaults', () => {
    // A quiet voiced tone, then a loud one: with floorDb -45 only the loud one is voice.
    const mic = new Float32Array(7 * 48_000);
    mic.set(voicedTone(48_000, 140, 0.02), msToSamples(500));
    mic.set(voicedTone(48_000, 140, 0.2), msToSamples(3_500));
    const P = resolveVadParams({ floorDb: -45 });
    const d = realDeck({ mode: 'live', vadParams: { floorDb: -45 } });
    d.rest(mic.length);
    d.run(mic, 0, mic.length);
    const recorded = d.voice();
    expect(recorded.map((e) => e.on)).toEqual([true, false]);
    expect(recorded[0]?.n).toBeGreaterThan(msToSamples(3_500));
    const ch0 = d.rec0();
    expect(edgesOf(vadEdges(ch0, P, 0))).toEqual(recorded);
    // The defaults would have called the quiet tone voice as well.
    expect(edgesOf(vadEdges(ch0, DEFAULT_VAD_PARAMS, 0)).filter((e) => e.on)).toHaveLength(2);
  });

  it('{k:vad} takes effect at the first quantum without voice and is recorded; offline the edges split there', () => {
    const mic = new Float32Array(10 * 48_000);
    mic.set(voicedTone(48_000, 140, 0.02), msToSamples(500)); // voice with the defaults only
    mic.set(voicedTone(48_000, 140, 0.2), msToSamples(4_000)); // voice with both
    mic.set(voicedTone(48_000, 140, 0.02), msToSamples(7_000)); // voice with the defaults only
    const P = resolveVadParams({ floorDb: -45 });
    const d = realDeck({ mode: 'live' });
    d.rest(mic.length);
    const at = msToSamples(1_000);
    d.run(mic, 0, at);
    expect(d.voice().map((e) => e.on)).toEqual([true]); // the quiet tone is voice now: the switch waits
    d.deck.onMainMessage({ k: 'vad', params: { floorDb: -45 }, source: 'doctor floor' });
    expect(d.vads()).toHaveLength(1);
    d.run(mic, at, mic.length);
    const firstOff = d.voice().find((e) => !e.on)?.n as number;
    const nSwitch = Math.ceil(firstOff / 128) * 128;
    expect(d.vads()).toEqual([
      { k: 'vad', n: 0, source: 'default', params: vadFrozenBlock(DEFAULT_VAD_PARAMS) },
      { k: 'vad', n: nSwitch, source: 'message', note: 'doctor floor', params: vadFrozenBlock(P) },
    ]);
    const ch0 = d.rec0();
    const offline = [...vadEdges(ch0.slice(0, nSwitch), DEFAULT_VAD_PARAMS, 0), ...vadEdges(ch0.subarray(nSwitch), P, nSwitch)];
    expect(d.voice()).toEqual(edgesOf(offline));
    expect(d.voice().map((e) => e.on)).toEqual([true, false, true, false]);
    expect(d.voice()[2]?.n).toBeGreaterThan(msToSamples(4_000));
    expect(d.main.filter((m) => m.k === 'error')).toEqual([]);
  });

  it('a quiet {k:vad} switches at once; one without a floor, with unusable values or for a test detector is refused', () => {
    const d = realDeck({ mode: 'live' });
    const mic = new Float32Array(48_000);
    d.rest(mic.length);
    d.run(mic, 0, 1_280);
    d.deck.onMainMessage({ k: 'vad', params: { ...vadFrozenBlock(), floor_db: -48 } });
    expect(d.vads().at(-1)).toEqual({ k: 'vad', n: 1_280, source: 'message', params: { ...vadFrozenBlock(), floor_db: -48 } });
    d.deck.onMainMessage({ k: 'vad', params: { overFloorDb: 10 } });
    d.deck.onMainMessage({ k: 'vad', params: { floorDb: -45, bogus: 1 } });
    d.deck.onMainMessage({ k: 'vad', params: { floorDb: -45, sampleRateHz: 44_100 } });
    expect(d.main.flatMap((m) => (m.k === 'error' ? [m.message] : []))).toEqual([
      'vad: the parameters must name the floor (floorDb or floor_db)',
      expect.stringMatching(/^vad: unusable parameters \(.*bogus.*\); the voice detector keeps its parameters$/),
      expect.stringMatching(/^vad: unusable parameters \(.*sampleRateHz must be 48000\)/),
    ]);
    expect(d.vads()).toHaveLength(2);
    const sim = new DeckSim({ mode: 'live' });
    sim.send({ k: 'vad', params: { floorDb: -45 } });
    expect(sim.mainOf('error').map((e) => e.message)).toEqual(['vad: this Deck runs a test voice detector']);
    expect(sim.toWorker.filter((m) => m.k === 'vad')).toEqual([]);
  });
});

describe('Deck invariants under random holds, keys and voice (fast-check)', () => {
  const words = evenWords(10, 300, 250, 100);
  const pcm = synthPassage(words, 5_800);
  const ALLOWED = new Set([
    'idle>narrating', 'narrating>hold_wait', 'narrating>listening', 'narrating>idle', 'hold_wait>listening',
    'hold_wait>resume', 'hold_wait>idle', 'listening>resume', 'listening>idle', 'resume>narrating',
  ]);
  const action = fc.record({ q: fc.integer({ min: 0, max: 3_500 }), kind: fc.constantFrom('hold', 'nohold', 'key') });
  const voice = fc.record({ start: fc.integer({ min: 0, max: 400_000 }), len: fc.integer({ min: 2_000, max: 120_000 }) });

  it('keeps nSilent = nCmd + 384, the causes, silence after nSilent and the 6.4 transitions', () => {
    fc.assert(
      fc.property(fc.array(action, { maxLength: 10 }), fc.array(voice, { maxLength: 4 }), fc.constantFrom('live', 'key', 'voice', 'gate'), (acts, segs, mode) => {
        const edges: Array<{ n: number; on: boolean }> = [];
        let last = -1;
        for (const s of [...segs].sort((a, b) => a.start - b.start)) {
          if (s.start <= last) continue;
          edges.push({ n: s.start, on: true }, { n: s.start + s.len, on: false });
          last = s.start + s.len + 1;
        }
        const sim = new DeckSim({ mode: mode as 'live' | 'key' | 'voice' | 'gate', edges });
        sim.start([{ name: 'p', pcm, timings: words }], playThenEnd('p', { untilClipEnd: true }));
        const sentHolds = new Map<number, number>();
        let seq = 0;
        for (const a of [...acts].sort((x, y) => x.q - y.q)) {
          sim.runTo(a.q * 128);
          if (sim.deck.isDone) break;
          if (a.kind === 'key') sim.send({ k: 'key' });
          else {
            seq++;
            if (a.kind === 'hold') sentHolds.set(seq, sim.n);
            sim.pkt(seq, a.kind === 'hold');
          }
        }
        sim.runTo(Math.max(sim.n, 3_600 * 128));
        expect(sim.stamps.flatMap((s) => validateStampLine(s))).toEqual([]);
        const arr = new Map(sim.of('arr').map((s) => [s.seq, s.n]));
        const voiceOns = sim.of('voice').filter((v) => v.on).map((v) => v.n);
        const resumes = sim.of('resume').map((r) => r.n);
        if (mode === 'gate') expect(sim.of('hold')).toEqual([]);
        for (const h of sim.of('hold')) {
          expect(h.nSilent).toBe(h.n + 384);
          if (h.cause === 'chest') {
            expect(mode).toBe('live');
            expect(sentHolds.get(h.seq)).toBe(h.n);
            expect(arr.get(h.seq)).toBe(h.n);
          } else if (h.cause === 'voice') {
            expect('seq' in h).toBe(false);
            expect(voiceOns.some((v) => v <= h.n - 12_000)).toBe(true);
          } else {
            expect(mode).toBe('key');
          }
          const end = resumes.find((r) => r > h.n) ?? sim.out.length;
          expect(silentFrom(sim.out, h.nSilent, end)).toBe(-1);
        }
        const st = sim.states().map(([, s]) => s);
        for (let i = 1; i < st.length; i++) expect(ALLOWED.has(`${st[i - 1]}>${st[i]}`)).toBe(true);
        let n0 = 0;
        for (const c of sim.chunks) {
          expect(c.n0).toBe(n0);
          n0 += c.frames;
        }
      }),
      { numRuns: 60 },
    );
  });
});

describe('no timers in Deck (spec 6.1)', () => {
  it('Deck sources use no timer, wall clock or animation frame', () => {
    const files = ['../deck.worklet.ts', './deck-core.ts', './deck-scenario.ts', './timings.ts', './units.ts', './clicks.ts'];
    for (const f of files) {
      const src = readFileSync(new URL(f, import.meta.url), 'utf8').replace(/\/\/.*$/gm, '');
      expect(src, f).not.toMatch(/setTimeout|setInterval|requestAnimationFrame|Date\.now|performance\.now|currentTime/);
    }
  });
});
