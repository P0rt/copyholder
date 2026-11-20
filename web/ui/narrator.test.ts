import { describe, expect, it } from 'vitest';
import { evenWords, synthPassage, wavBytes } from '../lib/testing/synth.ts';
import { scenarioFor, type ScenarioPlan } from '../scenarios/index.ts';
import { clipTimings, loadPlanAssets, sha256Hex } from './narrator.ts';

/** timings/1 of evenly spaced words (tools/tts/timings.ts parseTimings checks the shape). */
function timingsOf(words: ReturnType<typeof evenWords>, totalMs: number, tag: string) {
  return {
    schema: 'timings/1',
    wordRule: 'copyholder-words/1',
    sampleRateHz: 48_000,
    durationSamples: totalMs * 48,
    durationMs: totalMs,
    wordCount: words.length,
    sentenceCount: 1,
    engine: { name: `stand-in ${tag}` },
    correctedChunks: 0,
    words: words.map((w, index) => ({ index, startMs: w.startMs, endMs: w.endMs, sentenceIndex: 0 })),
  };
}

interface Clip {
  bytes: Uint8Array;
  timings: ReturnType<typeof timingsOf>;
}

function clip(ms: number, freq: number, tag: string): Clip {
  const words = evenWords(4, 300, 150);
  return { bytes: wavBytes(synthPassage(words, ms, freq, 0.25)), timings: timingsOf(words, ms, tag) };
}

const toBuffer = (b: Uint8Array): ArrayBuffer => b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;

/** timings-set/1 of the clips, each with the SHA-256 of its WAV bytes. */
async function timingsSet(clips: Record<string, Clip>) {
  const passages = [];
  for (const [name, c] of Object.entries(clips)) passages.push({ passageId: name.replace(/\.wav$/, ''), audioSha256: await sha256Hex(toBuffer(c.bytes)), timings: c.timings });
  return { schema: 'timings-set/1', passages };
}

/** A fetch that serves `files` under /api/narrator/<name> and counts the requests. */
function fakeFetch(files: Record<string, Uint8Array | unknown>) {
  const asked: string[] = [];
  const fetchFn = async (url: string): Promise<Response> => {
    asked.push(url);
    const name = decodeURIComponent(url.replace(/^\/api\/narrator\//, '').replace(/\?.*$/, ''));
    const body = files[name];
    if (body === undefined) return new Response('not found', { status: 404 });
    return new Response(body instanceof Uint8Array ? toBuffer(body) : JSON.stringify(body), { status: 200 });
  };
  return { fetchFn, asked };
}

function headstartPlan(narrator: readonly string[]): ScenarioPlan {
  const p = scenarioFor({ mode: 'headstart', scenario: 'headstart', narrator });
  if (typeof p === 'string') throw new Error(p);
  return p;
}

describe('word times from a timings-set/1 file (spec 8.2)', () => {
  const opening = clip(1_500, 200, 'opening');
  const p1 = clip(2_000, 220, 'p1');
  const p2 = clip(2_500, 240, 'p2');

  it('gives each clip its own entry once the SHA-256 of its WAV matches', async () => {
    const set = await timingsSet({ 'opening.wav': opening, 'p1.wav': p1, 'p2.wav': p2 });
    expect(await clipTimings(set, 'timings.json', 'p1.wav', toBuffer(p1.bytes))).toEqual(p1.timings);
    expect(await clipTimings(set, 'timings.json', 'opening.wav', toBuffer(opening.bytes))).toEqual(opening.timings);
  });

  it('passes a file of one clip to Deck as it is', async () => {
    const own = p1.timings;
    expect(await clipTimings(own, 'p1.timings.json', 'p1.wav', toBuffer(p1.bytes))).toBe(own);
  });

  it('refuses a set without the clip, with another hash, or of the wrong shape', async () => {
    const set = await timingsSet({ 'opening.wav': opening, 'p1.wav': p1 });
    await expect(clipTimings(set, 'timings.json', 'p2.wav', toBuffer(p2.bytes))).rejects.toThrow('timings.json has no word times for p2.wav.');
    await expect(clipTimings(set, 'timings.json', 'p1.wav', toBuffer(p2.bytes))).rejects.toThrow(
      'The word times in timings.json were made for another version of p1.wav (its SHA-256 differs).',
    );
    await expect(clipTimings({ schema: 'timings-set/1', passages: [] }, 'timings.json', 'p1.wav', toBuffer(p1.bytes))).rejects.toThrow(
      /^timings\.json cannot be used: timings set: passages is not a non-empty array\.$/,
    );
  });

  it('sha256Hex is the lowercase hex SHA-256', async () => {
    const abc = new TextEncoder().encode('abc');
    expect(await sha256Hex(toBuffer(abc))).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });
});

describe('loadPlanAssets: the headstart clips (spec 7.11, 8.2)', () => {
  const opening = clip(1_500, 200, 'opening');
  const p1 = clip(2_000, 220, 'p1');
  const p2 = clip(2_500, 240, 'p2');

  it('fetches every clip and the shared timings file once; each clip gets its word times', async () => {
    const set = await timingsSet({ 'opening.wav': opening, 'p1.wav': p1, 'p2.wav': p2 });
    const files = { 'opening.wav': opening.bytes, 'p1.wav': p1.bytes, 'p2.wav': p2.bytes, 'timings.json': set };
    const narrator = Object.keys(files);
    const { fetchFn, asked } = fakeFetch(files);
    const assets = await loadPlanAssets(headstartPlan(narrator), narrator, fetchFn, '?token=t0');
    expect(assets.clips.map((c) => [c.name, c.seconds, c.timings])).toEqual([
      ['opening.wav', 1.5, opening.timings],
      ['p1.wav', 2, p1.timings],
      ['p2.wav', 2.5, p2.timings],
    ]);
    expect([...assets.clipSamples]).toEqual([
      ['opening.wav', 72_000],
      ['p1.wav', 96_000],
      ['p2.wav', 120_000],
    ]);
    expect(asked.filter((u) => u.startsWith('/api/narrator/timings.json'))).toEqual(['/api/narrator/timings.json?token=t0']);
    expect(asked).toHaveLength(4);
  });

  it('a timings file of the clip itself wins over the set', async () => {
    const set = await timingsSet({ 'opening.wav': opening, 'p1.wav': p1, 'p2.wav': p2 });
    const ownP2 = { ...p2.timings, engine: { name: 'own file' } };
    const files = { 'opening.wav': opening.bytes, 'p1.wav': p1.bytes, 'p2.wav': p2.bytes, 'timings.json': set, 'p2.timings.json': ownP2 };
    const narrator = Object.keys(files);
    const { fetchFn } = fakeFetch(files);
    const assets = await loadPlanAssets(headstartPlan(narrator), narrator, fetchFn, '');
    expect(assets.clips.find((c) => c.name === 'p2.wav')?.timings).toEqual(ownP2);
    expect(assets.clips.find((c) => c.name === 'p1.wav')?.timings).toEqual(p1.timings);
  });

  it('a clip whose WAV changed after the word times were made stops the loading', async () => {
    const stale = clip(2_000, 330, 'p1 rendered again');
    const set = await timingsSet({ 'opening.wav': opening, 'p1.wav': stale, 'p2.wav': p2 });
    const files = { 'opening.wav': opening.bytes, 'p1.wav': p1.bytes, 'p2.wav': p2.bytes, 'timings.json': set };
    const narrator = Object.keys(files);
    const { fetchFn } = fakeFetch(files);
    await expect(loadPlanAssets(headstartPlan(narrator), narrator, fetchFn, '')).rejects.toThrow(/another version of p1\.wav/);
  });
});
