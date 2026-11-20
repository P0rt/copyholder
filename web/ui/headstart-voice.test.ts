// headstart through Deck with the real voice detector (spec 6.4, 7.3, 7.11): the processorOptions
// the page builds from /api/config (deckNodeOptions), with the vad block of params/frozen.json or
// without one, stop the narrator on the voice; the live view counts those stops by cause.
import { describe, expect, it } from 'vitest';
import { DEFAULT_VAD_PARAMS, vadFrozenBlock, vadParamsFromFrozen } from '../lib/core.ts';
import { DeckCore, deckOptionsFrom } from '../lib/deck-core.ts';
import type { DeckProcessorOptions, DeckStamp, DeckToMain, DeckToWorker } from '../lib/messages.ts';
import { evenWords, synthPassage, voicedTone } from '../lib/testing/synth.ts';
import { msToSamples } from '../lib/units.ts';
import { HEADSTART_TEXT, readingSteps } from '../scenarios/headstart.ts';
import type { Step } from '../scenarios/format.ts';
import { deckNodeOptions, LIVE_VIEW_LEVEL_WINDOW_SAMPLES } from './deck-options.ts';
import { LiveModel } from './live-model.ts';
import type { FromDeck } from './messages.ts';

const CLIP = 'opening.wav';
const WORDS = evenWords(14, 400, 150);
const PCM = synthPassage(WORDS, 8_000);
/** A quiet voiced tone at 0.5-1.5 s and a loud one at 3.5-4.5 s (web/lib/deck-core.test.ts: only the loud one passes floor -45 dB). */
const MIC = (() => {
  const mic = new Float32Array(16 * 48_000);
  mic.set(voicedTone(48_000, 140, 0.02), msToSamples(500));
  mic.set(voicedTone(48_000, 140, 0.2), msToSamples(3_500));
  return mic;
})();

function configWith(frozenVad: unknown): Record<string, unknown> {
  return { mode: 'headstart', detector: { params: frozenVad === undefined ? {} : { vad: frozenVad }, sign: 1, variant: 'D1' }, calib: null };
}

/** The page's processorOptions through Deck's own reading of them, then the take's reading and its end. */
function runTake(raw: Record<string, unknown>) {
  const { options, vadSource } = deckNodeOptions({ mode: 'headstart', raw }, 0.3, { liveView: true });
  const stamps: DeckStamp[] = [];
  const toWorker: DeckToWorker[] = [];
  const main: DeckToMain[] = [];
  const deck = new DeckCore(deckOptionsFrom(structuredClone(options) as DeckProcessorOptions), {
    toMain: (m) => main.push(m),
    toWorker: (m) => {
      toWorker.push(m);
      if (m.k === 'stamp') stamps.push(m.line);
    },
  });
  const steps: Step[] = [...readingSteps([CLIP], new Map([[CLIP, PCM.length]])), { k: 'end', name: 'end', text: HEADSTART_TEXT.done, lenSamples: 0 }];
  deck.onMainMessage({ k: 'load', name: CLIP, pcm: PCM.slice(), timings: WORDS });
  deck.onMainMessage({ k: 'scenario', steps });
  const out = new Float32Array(128);
  for (let n = 0; n + 128 <= MIC.length; n += 128) deck.process(MIC.subarray(n, n + 128), [out], 128);
  const live = new LiveModel(options.levelWindowSamples ?? 0);
  for (const m of main) live.deck(m as FromDeck);
  return { options, vadSource, stamps, toWorker, main, live };
}

const holds = (stamps: readonly DeckStamp[]) => stamps.filter((s): s is Extract<DeckStamp, { k: 'hold' }> => s.k === 'hold');

describe('headstart: VOICE stops with the page parameters (spec 6.4, 7.3)', () => {
  it('with the vad block of params/frozen.json: only the voice above its floor stops the narrator', () => {
    const block = { floor_db: -45 };
    const r = runTake(configWith(block));
    expect(r.options).toMatchObject({ mode: 'headstart', gain: 0.3, levelWindowSamples: LIVE_VIEW_LEVEL_WINDOW_SAMPLES });
    expect(r.options.vadParams).toEqual(vadParamsFromFrozen(block));
    expect(r.vadSource).toMatch(/^params\/frozen\.json \(floor -45 dB/);
    expect(r.toWorker[0]).toEqual({ k: 'vad', n: 0, source: 'options', params: vadFrozenBlock(vadParamsFromFrozen(block)) });
    const h = holds(r.stamps);
    expect(h).toHaveLength(1);
    expect(h[0]).toMatchObject({ cause: 'voice' });
    expect(h[0]!.n).toBeGreaterThan(msToSamples(3_500));
    expect(r.main.filter((m) => m.k === 'state' && m.s === 'listening')).toEqual([{ k: 'state', n: h[0]!.n, s: 'listening', cause: 'voice' }]);
    // The take reads to the end of the clip and ends.
    expect(r.main.at(-1)).toMatchObject({ k: 'done' });
    expect(r.live.stopCounts()).toEqual({ chest: 0, voice: 1, key: 0 });
    expect(r.live.badge).toBeNull();
  });

  it('without a vad block Deck runs its defaults: the quiet voice stops the narrator too', () => {
    const r = runTake(configWith(undefined));
    expect('vadParams' in r.options).toBe(false);
    expect(r.vadSource).toMatch(/DEFAULT_VAD_PARAMS/);
    expect(r.toWorker[0]).toEqual({ k: 'vad', n: 0, source: 'default', params: vadFrozenBlock(DEFAULT_VAD_PARAMS) });
    const h = holds(r.stamps);
    expect(h.map((x) => x.cause)).toEqual(['voice', 'voice']);
    expect(h[0]!.n).toBeGreaterThan(msToSamples(500));
    expect(h[0]!.n).toBeLessThan(msToSamples(1_500));
    expect(r.live.stopCounts()).toEqual({ chest: 0, voice: 2, key: 0 });
    expect(r.live.summaryLines()).toEqual(['CHEST stops: 0', 'VOICE stops: 2']);
  });

  it('sends 20 level messages per second for the live view, other plans keep 10', () => {
    const r = runTake(configWith(undefined));
    const processed = Math.floor(MIC.length / 128) * 128;
    const done = r.main.find((m) => m.k === 'done') as { n: number } | undefined;
    const counted = done ? Math.min(processed, done.n) : processed;
    expect(r.main.filter((m) => m.k === 'level').length).toBe(Math.floor(counted / LIVE_VIEW_LEVEL_WINDOW_SAMPLES));
    const gate = deckNodeOptions({ mode: 'gate', raw: { mode: 'gate' } }, 0.3);
    expect('levelWindowSamples' in gate.options).toBe(false);
    expect(deckOptionsFrom({ mode: 'gate' })).toEqual({ mode: 'gate' });
    expect(deckOptionsFrom({ mode: 'headstart', levelWindowSamples: 2_400 })).toEqual({ mode: 'live', levelWindowSamples: 2_400 });
    // A window Deck cannot count is left out: Deck keeps its 4800.
    expect(deckOptionsFrom({ mode: 'headstart', levelWindowSamples: 0 })).toEqual({ mode: 'live' });
    expect(deckOptionsFrom({ mode: 'headstart', levelWindowSamples: 1.5 })).toEqual({ mode: 'live' });
  });
});
