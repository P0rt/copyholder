// Fixtures for the stand-in build: a fake /api/config and /api/narrator for `vite --mode standins`
// and for the page tests. Not part of the production page.
import { encodeWavPcm16 } from '../../ui/wav.ts';

/** Cue lists that follow spec 9.2 (packs A/B/C) and the probe layout (pack 0), in ms. */
export const FIXTURE_CUES_MS: Record<string, number[]> = {
  '0': [15000, 35000],
  A: [15000, 31000, 55000, 71000, 92000, 110000, 130000, 147000, 167000, 185000, 205000, 223000, 244000, 262000],
};

/** Narrator names host would list for a scenario. */
export function fixtureNarratorNames(scenario: string): string[] {
  if (scenario.startsWith('gate')) return ['listen.wav', 'listen.timings.json', 'objections.wav', 'objections.timings.json', 'cues.json'];
  if (scenario.startsWith('doctor')) return ['level.wav'];
  return [];
}

export function fixtureConfig(scenario: string, sessionId = 'standin-1'): Record<string, unknown> {
  const mode = scenario.startsWith('gate') ? 'gate' : scenario.startsWith('doctor') ? 'doctor' : scenario;
  return {
    mode,
    sessionId,
    scenario,
    tapUrl: null,
    sessionUrl: null,
    calib: mode === 'doctor' ? null : { schema: 'calib/1', output_gain: 0.35 },
    narrator: fixtureNarratorNames(scenario),
    consentText: mode === 'doctor' ? 'mic' : 'live',
  };
}

/** A quiet 2 s tone, mono 48 kHz PCM16. */
export function fixtureWav(seconds = 2): Uint8Array {
  const n = Math.round(seconds * 48_000);
  const pcm = new Float32Array(n);
  for (let i = 0; i < n; i += 1) pcm[i] = 0.05 * Math.sin((2 * Math.PI * 220 * i) / 48_000);
  return new Uint8Array(encodeWavPcm16(pcm));
}

export interface FixtureResponse {
  status: number;
  type: string;
  body: string | Uint8Array;
}

/** Answers /api/config and /api/narrator/<name> for the stand-in dev server; null for other paths. */
export function fixtureResponse(url: string, scenario = 'gate-0'): FixtureResponse | null {
  const path = url.split('?')[0] ?? '';
  if (path === '/api/config') return { status: 200, type: 'application/json', body: JSON.stringify(fixtureConfig(scenario)) };
  const m = /^\/api\/narrator\/(.+)$/.exec(path);
  if (!m || !m[1]) return null;
  const name = decodeURIComponent(m[1]);
  if (!fixtureNarratorNames(scenario).includes(name)) return { status: 404, type: 'text/plain', body: 'not served' };
  if (name.endsWith('.wav')) return { status: 200, type: 'audio/wav', body: fixtureWav() };
  if (name === 'cues.json') {
    const pack = scenario.endsWith('0') ? '0' : 'A';
    return { status: 200, type: 'application/json', body: JSON.stringify(FIXTURE_CUES_MS[pack]) };
  }
  return { status: 200, type: 'application/json', body: JSON.stringify({ words: [] }) };
}
