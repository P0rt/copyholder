// Narrator clips, word timings and cue lists from /api/narrator/<name> (docs/protocol.md).
import { parseTimingsSet, TIMINGS_SET_SCHEMA } from '../../tools/tts/timings.ts';
import { timingsNameFor, type ScenarioAssets, type ScenarioPlan } from '../scenarios/index.ts';
import { SAMPLE_RATE_HZ } from '../scenarios/format.ts';
import { apiUrl, narratorPath } from './config.ts';
import { decodeNarratorWav } from './wav.ts';

export interface LoadedClip {
  name: string;
  pcm: Float32Array;
  timings: unknown;
  seconds: number;
}

/** What the plan's build() needs, plus the decoded clips for Deck. */
export interface PlanAssets extends ScenarioAssets {
  clips: LoadedClip[];
  cuesMs?: number[];
}

type FetchLike = (url: string) => Promise<Response>;
/** SHA-256 of bytes as lowercase hex. */
export type Sha256Hex = (bytes: ArrayBuffer) => Promise<string>;

async function get(fetchFn: FetchLike, name: string, pageSearch: string): Promise<Response> {
  const res = await fetchFn(apiUrl(narratorPath(name), pageSearch));
  if (!res.ok) throw new Error(`Narrator file ${name} is not served (HTTP ${res.status}).`);
  return res;
}

/** SHA-256 with Web Crypto (the page is a secure context on 127.0.0.1; Node has it too). */
export async function sha256Hex(bytes: ArrayBuffer): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  return Array.from(digest, (b) => b.toString(16).padStart(2, '0')).join('');
}

function isTimingsSet(raw: unknown): boolean {
  return typeof raw === 'object' && raw !== null && (raw as { schema?: unknown }).schema === TIMINGS_SET_SCHEMA;
}

/**
 * The word timings Deck gets for one clip (spec 6.4, 8.2). A timings-set/1 file (one file for several
 * clips) gives the entry whose passageId is the clip name without .wav, after its audioSha256 is
 * checked against the clip's bytes as host served them, so the word times never belong to another
 * rendering. Any other file goes to Deck as it is (per-clip timings/1 files of the gate packs).
 * Throws on a set without the clip or with another hash.
 */
export async function clipTimings(raw: unknown, file: string, clip: string, wav: ArrayBuffer, sha256: Sha256Hex = sha256Hex): Promise<unknown> {
  if (!isTimingsSet(raw)) return raw;
  let set: ReturnType<typeof parseTimingsSet>;
  try {
    set = parseTimingsSet(raw);
  } catch (err) {
    throw new Error(`${file} cannot be used: ${err instanceof Error ? err.message : String(err)}.`);
  }
  const id = clip.replace(/\.wav$/i, '');
  const entry = set.passages.find((p) => p.passageId === id);
  if (!entry) throw new Error(`${file} has no word times for ${clip}.`);
  if ((await sha256(wav)) !== entry.audioSha256) {
    throw new Error(`The word times in ${file} were made for another version of ${clip} (its SHA-256 differs).`);
  }
  return entry.timings;
}

/**
 * Fetches what the plan needs: every clip with its timings (null when none is served) and the cue
 * list. A timings file several clips share (the plan's timingsSet) is fetched once.
 */
export async function loadPlanAssets(
  plan: ScenarioPlan,
  narrator: readonly string[],
  fetchFn: FetchLike,
  pageSearch: string,
  sha256: Sha256Hex = sha256Hex,
): Promise<PlanAssets> {
  const timingsFiles = new Map<string, Promise<unknown>>();
  const timingsFile = (name: string): Promise<unknown> => {
    let p = timingsFiles.get(name);
    if (!p) {
      p = get(fetchFn, name, pageSearch).then((r) => r.json() as Promise<unknown>);
      timingsFiles.set(name, p);
    }
    return p;
  };
  const clips = await Promise.all(
    plan.clips.map(async (name): Promise<LoadedClip> => {
      const bytes = await (await get(fetchFn, name, pageSearch)).arrayBuffer();
      const pcm = decodeNarratorWav(bytes, name);
      const timingsName = timingsNameFor(name, narrator, plan.clips.length, plan.timingsSet ?? null);
      const timings: unknown = timingsName ? await clipTimings(await timingsFile(timingsName), timingsName, name, bytes, sha256) : null;
      return { name, pcm, timings, seconds: pcm.length / SAMPLE_RATE_HZ };
    }),
  );
  const assets: PlanAssets = { clips, clipSamples: new Map(clips.map((c) => [c.name, c.pcm.length])) };
  if (plan.cuesFile) {
    const cues: unknown = await (await get(fetchFn, plan.cuesFile, pageSearch)).json();
    if (!Array.isArray(cues) || !cues.every((c) => typeof c === 'number')) throw new Error(`${plan.cuesFile} must be a JSON array of numbers (ms).`);
    assets.cuesMs = cues;
  }
  return assets;
}
