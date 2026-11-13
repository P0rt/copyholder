// Narrator clips, word timings and cue lists from /api/narrator/<name> (docs/protocol.md).
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

async function get(fetchFn: FetchLike, name: string, pageSearch: string): Promise<Response> {
  const res = await fetchFn(apiUrl(narratorPath(name), pageSearch));
  if (!res.ok) throw new Error(`Narrator file ${name} is not served (HTTP ${res.status}).`);
  return res;
}

/** Fetches what the plan needs: every clip with its timings (null when none is served) and the cue list. */
export async function loadPlanAssets(plan: ScenarioPlan, narrator: readonly string[], fetchFn: FetchLike, pageSearch: string): Promise<PlanAssets> {
  const clips = await Promise.all(
    plan.clips.map(async (name): Promise<LoadedClip> => {
      const pcm = decodeNarratorWav(await (await get(fetchFn, name, pageSearch)).arrayBuffer(), name);
      const timingsName = timingsNameFor(name, narrator, plan.clips.length);
      const timings: unknown = timingsName ? await (await get(fetchFn, timingsName, pageSearch)).json() : null;
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
