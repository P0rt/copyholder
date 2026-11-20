// Spec 7.2, 7.11; PREREG.md §11: headstart serves the public sample of sample/ through the one narrator
// allow list (live/lib/narrator.cjs, list `sample`): the clips and timings.json byte for byte, never
// the plan, the texts or the README. The page then takes each clip's word times from the set only
// when its audioSha256 matches the bytes it fetched (docs/protocol.md), which the last test repeats.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseTimingsSet } from '../../tools/tts/timings.ts';
import { decodeNarratorWav } from '../../web/ui/wav.ts';

type Source = { kind: string };
interface ReadResult {
  status: number;
  error: string | null;
  contentType: string | null;
  body: Buffer | NodeJS.ReadableStream | null;
  length: number;
}
const requireCjs = createRequire(import.meta.url);
const narrator = requireCjs('../../live/lib/narrator.cjs') as {
  NARRATOR_ALLOW: { sample: readonly string[] };
  sampleSource(dir: string): Source;
  narratorNames(source: Source): string[];
  readNarrator(source: Source, name: string, opts?: { preflightOk?: boolean }): Promise<ReadResult>;
  needsPreflight(source: Source, name: string): boolean;
  holdsSealedAudio(source: Source): boolean;
};
const paths = requireCjs('../../live/lib/paths.cjs') as { REPO_ROOT: string; resolvePaths(env?: Record<string, string>): { sampleDir: string } };

const SAMPLE = join(import.meta.dirname, '..', '..', 'sample');
const SERVED = ['opening.wav', 'p1.wav', 'p2.wav', 'timings.json'];
const sha256 = (b: Uint8Array): string => createHash('sha256').update(b).digest('hex');

async function body(r: ReadResult): Promise<Buffer> {
  expect(Buffer.isBuffer(r.body)).toBe(true);
  return r.body as Buffer;
}

describe('narrator files of headstart: the sample in sample/', () => {
  it('is where host looks for it by default', () => {
    expect(paths.resolvePaths({}).sampleDir).toBe(join(paths.REPO_ROOT, 'sample'));
    expect(paths.resolvePaths({}).sampleDir).toBe(SAMPLE);
  });

  it('serves the clips and timings.json byte for byte, without waiting for preflight', async () => {
    const src = narrator.sampleSource(SAMPLE);
    expect(narrator.narratorNames(src)).toEqual(SERVED);
    expect(narrator.holdsSealedAudio(src)).toBe(false);
    for (const name of SERVED) {
      expect(narrator.needsPreflight(src, name)).toBe(false);
      const r = await narrator.readNarrator(src, name);
      expect(r.status, name).toBe(200);
      expect(r.contentType, name).toBe(name.endsWith('.wav') ? 'audio/wav' : 'application/json');
      expect((await body(r)).equals(readFileSync(join(SAMPLE, name))), name).toBe(true);
      expect(r.length, name).toBe(readFileSync(join(SAMPLE, name)).length);
    }
  });

  it('never serves the plan, the texts, the README or anything outside the allow list', async () => {
    const src = narrator.sampleSource(SAMPLE);
    const refused = [
      'plan.json', 'README.md', 'texts/p1.txt', 'p1.txt', 'texts', 'p3.wav', 'level.wav', 'P1.WAV', 'p1', '../sample/plan.json',
      '../gate/level/level.wav', '/etc/passwd', '', '__proto__',
    ];
    for (const name of refused) {
      const r = await narrator.readNarrator(src, name, { preflightOk: true });
      expect(r.status, name).toBe(404);
      expect(r.body, name).toBeNull();
    }
    expect(narrator.NARRATOR_ALLOW.sample).not.toContain('plan.json');
  });

  it('serves clips the page can use: mono 48 kHz, each with its entry of timings.json', async () => {
    const src = narrator.sampleSource(SAMPLE);
    const set = parseTimingsSet(JSON.parse((await body(await narrator.readNarrator(src, 'timings.json'))).toString('utf8')));
    for (const clip of SERVED.filter((n) => n.endsWith('.wav'))) {
      const bytes = await body(await narrator.readNarrator(src, clip));
      const entry = set.passages.find((p) => p.passageId === clip.replace(/\.wav$/, ''));
      expect(entry?.audioSha256, clip).toBe(sha256(bytes));
      const pcm = decodeNarratorWav(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer, clip);
      expect(pcm.length, clip).toBe(entry?.timings.durationSamples);
    }
  });
});
