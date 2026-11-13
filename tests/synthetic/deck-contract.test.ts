// Contract between Deck and core/clock (spec 6.3, 7.3, 8.1): a real DeckCore, driven quantum by
// quantum through its test harness DeckSim, plays loop check A, a passage with two live chest
// stops and loop check B. Its stamps and audio blocks are stored as web/lib/worker-core.ts and
// live/lib/session-store.cjs store them, and the clock check reads them back.

import { beforeAll, describe, expect, it } from 'vitest';
import {
  FADE_SAMPLES,
  LOOP_BLOCK_SAMPLES,
  QUANTUM_SAMPLES,
  SAMPLE_RATE_HZ,
  chunkLayout,
  clickSchedule,
  clockCheckDetails,
  hardFailures,
  loopClickBlocks,
  type ClockCheckDetails,
  type EventLine,
  type SessionData,
  type Stamp,
} from '../../core/clock/index.ts';
import { validateClockReport, validateStampLine } from '../../core/schemas/index.ts';
import { loopCheckClicks } from '../../web/lib/clicks.ts';
import { DeckSim } from '../../web/lib/testing/deck-sim.ts';
import { evenWords, synthPassage } from '../../web/lib/testing/synth.ts';
import { HOLD_WAIT_SAMPLES } from '../../web/lib/units.ts';
import type { Step } from '../../web/scenarios/format.ts';
import { gaussian, mulberry32 } from './signals.ts';

const R = SAMPLE_RATE_HZ;
/** The round-trip path, Deck output to channel 0: whole samples, so L_rt is known exactly. */
const LAG_SAMPLES = 1_123;
const LRT_MS = (LAG_SAMPLES * 1000) / R;
/** Passage start: loop check A is the first step, 12 s from sample 0. */
const PASSAGE_N = LOOP_BLOCK_SAMPLES;
/** Chest stops (packets with hold true), on quantum boundaries as the worker's messages arrive. */
const HOLD_1_N = PASSAGE_N + 3 * R;
const HOLD_2_N = PASSAGE_N + 8 * R;
/** A reply in the first stop: voice on and off; the second stop has none and ends after H. */
const VOICE_ON_N = HOLD_1_N + 24_000;
const VOICE_OFF_N = HOLD_1_N + 67_200;
/** An SDK packet every 13 quanta (about 29 per second). */
const PACKET_EVERY = 13 * QUANTUM_SAMPLES;

interface DeckRun {
  sim: DeckSim;
  session: SessionData;
}

function steps(): Step[] {
  return [
    { k: 'clicks', name: 'loop_a', text: '', lenSamples: LOOP_BLOCK_SAMPLES, block: 'A' },
    { k: 'play', name: 'passage_1', text: '', lenSamples: 0, clip: 'p1', untilClipEnd: true },
    { k: 'clicks', name: 'loop_b', text: '', lenSamples: LOOP_BLOCK_SAMPLES, block: 'B' },
    { k: 'end', name: 'end', text: '', lenSamples: 0 },
  ];
}

function concat(parts: readonly Float32Array[]): Float32Array {
  const out = new Float32Array(parts.reduce((s, p) => s + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

/**
 * The session folder of a Deck run: Deck's stamps as the worker forwards them, a chunk stamp
 * after each audio block as host appends it to audio.wav, and the hold and resume lines the
 * worker writes into events.jsonl.
 */
function sessionOf(sim: DeckSim): SessionData {
  const stamps: Stamp[] = [];
  const events: EventLine[] = [];
  const ch0: Float32Array[] = [];
  const ch1: Float32Array[] = [];
  let state: string | null = null;
  let prevState: string | null = null;
  for (const m of sim.toWorker) {
    if (m.k === 'stamp') {
      const line = m.line;
      stamps.push(line);
      if (line.k === 'state') {
        prevState = state;
        state = line.s;
      } else if (line.k === 'hold') {
        events.push({ n: line.n, e: 'hold', cause: line.cause, nCmd: line.n, nSilent: line.nSilent, word: line.word });
      } else if (line.k === 'resume') {
        events.push({ n: line.n, e: 'resume', word: line.word, why: prevState === 'listening' ? 'voice_off' : 'timeout' });
      }
    } else if (m.k === 'chunk') {
      ch0.push(m.ch0);
      ch1.push(m.ch1);
      stamps.push({ n: m.n0, k: 'chunk', frames: m.frames });
    }
  }
  return {
    sampleRateHz: R,
    ch0: concat(ch0),
    ch1: concat(ch1),
    stamps,
    samples: [],
    events,
    micSettings: { sampleRate: R, echoCancellation: false, noiseSuppression: false, autoGainControl: false, contextSampleRate: R },
  };
}

function runDeck(): DeckRun {
  const rng = mulberry32(11);
  const clicks = loopCheckClicks();
  const words = evenWords(30, 220, 110);
  const pcm = synthPassage(words, 10_000);
  // Channel 0 hears Deck's output through the earcup path, over a quiet noise floor.
  const sim: DeckSim = new DeckSim({
    mode: 'live',
    clickOffsetsSamples: clicks.offsetsSamples,
    clickWaveform: clicks.waveform,
    edges: [
      { n: VOICE_ON_N, on: true },
      { n: VOICE_OFF_N, on: false },
    ],
    mic: (n) => 0.3 * (sim.out[n - LAG_SAMPLES] ?? 0) + 0.0005 * gaussian(rng),
  });
  sim.start([{ name: 'p1', pcm, timings: words }], steps());
  let seq = 0;
  const limit = 60 * R;
  while (!sim.deck.isDone && sim.n < limit) {
    sim.quantum();
    const t = sim.n;
    if (t === HOLD_1_N || t === HOLD_2_N) sim.pkt(++seq, true);
    else if (t % PACKET_EVERY === 0) sim.pkt(++seq, false);
  }
  return { sim, session: sessionOf(sim) };
}

describe('Deck stamps and audio read by the clock check (spec 6.3, 7.3, 8.1)', () => {
  let run: DeckRun;
  let d: ClockCheckDetails;
  beforeAll(() => {
    run = runDeck();
    d = clockCheckDetails(run.session, { camera: false });
  });

  it('Deck finished the scenario, and every stamp passes the core/schemas validator', () => {
    expect(run.sim.deck.isDone).toBe(true);
    const problems = run.session.stamps.flatMap((l, i) => validateStampLine(l).map((p) => `stamps[${i}] ${p}`));
    expect(problems).toEqual([]);
  });

  it('records contiguous 9600-sample blocks from sample 0 in both channels', () => {
    const { session } = run;
    expect(session.ch0.length).toBe(session.ch1.length);
    // The recording ends at Deck's done sample, inside the last quantum.
    const done = run.sim.toWorker.find((m) => m.k === 'done');
    expect(done).toEqual({ k: 'done', n: session.ch1.length });
    expect(run.sim.out.length - session.ch1.length).toBeLessThan(QUANTUM_SAMPLES);
    const layout = chunkLayout(session.stamps, session.ch0.length);
    expect(layout.contiguous).toBe(true);
    expect(layout.runs).toEqual([{ n0: 0, n1: session.ch0.length, index0: 0 }]);
    // Channel 1 is what Deck rendered, sample for sample.
    for (const n of [0, PASSAGE_N + 4_321, HOLD_2_N + 100_000]) expect(session.ch1[n]).toBe(Math.fround(run.sim.out[n]!));
  });

  it('finds both loop checks at the stamped clicks and measures the true L_rt', () => {
    const blocks = loopClickBlocks(run.session.stamps);
    expect(blocks.A).toEqual(clickSchedule());
    expect(blocks.B).toHaveLength(10);
    for (const block of [d.loop.A!, d.loop.B!]) {
      expect(block.found).toBe(10);
      expect(Math.abs(block.L_rt_ms! - LRT_MS)).toBeLessThan(0.02);
      expect(block.spread_ms!).toBeLessThan(0.02);
    }
    expect(d.lrt).toMatchObject({ rule: 'mean', used: Math.round(LRT_MS * 10) / 10 });
  });

  it("confirms each live stop with Deck's own nSilent and resume", () => {
    expect(d.stops).toEqual([
      { nCmd: HOLD_1_N, nSilent: HOLD_1_N + FADE_SAMPLES, nEnd: VOICE_OFF_N, cause: 'chest', seq: expect.any(Number), nArr: HOLD_1_N, silent: true },
      {
        nCmd: HOLD_2_N,
        nSilent: HOLD_2_N + FADE_SAMPLES,
        nEnd: HOLD_2_N + FADE_SAMPLES + HOLD_WAIT_SAMPLES,
        cause: 'chest',
        seq: expect.any(Number),
        nArr: HOLD_2_N,
        silent: true,
      },
    ]);
    // Deck played again at each nEnd: the range checked is the whole stop.
    for (const s of d.stops) {
      expect(run.session.ch1.subarray(s.nEnd, s.nEnd + 4_800).some((x) => x !== 0)).toBe(true);
    }
    expect(run.session.events.filter((e) => e.e === 'resume').map((e) => e['why'])).toEqual(['voice_off', 'timeout']);
  });

  it('passes the clock check of a recording without the camera', () => {
    expect(d.failures).toEqual([]);
    expect(d.report.audio_valid).toBe(true);
    expect(d.report.trace_valid).toBeNull();
    expect(d.report.chain).toMatchObject({ rule: 'mean', quantum_ms: 2.7, stops: 2, stops_match_ch1: 2, nCmd_minus_nArr: 0 });
    expect(d.report.hard).toMatchObject({ chunks_contiguous: true, sample_rate: R, mic_flags_off: true, device_events: 0, visibility_events: 0 });
    expect(hardFailures(d.report)).toEqual([]);
    expect(validateClockReport(d.report)).toEqual([]);
  });

  it('rejects a stop when one sample of the narrator leaks into its silence', () => {
    const ch1 = run.session.ch1.slice();
    ch1[HOLD_2_N + FADE_SAMPLES + 30_000] = 1e-6;
    const leaked = clockCheckDetails({ ...run.session, ch1 }, { camera: false, loop: d.loop });
    expect(leaked.report.chain).toMatchObject({ stops: 2, stops_match_ch1: 1 });
    expect(leaked.report.audio_valid).toBe(false);
  });
});
