// The doctor's volume sample (spec 7.7): host serves level.wav from gate/level/, where
// gate/level/render.ts writes it, and from sample/ only when gate/level/ has none
// (live/lib/narrator.cjs doctorSource, live/lib/paths.cjs levelDir, docs/protocol.md).
// Node only: no browser. Run: npx playwright test tests/e2e/narrator-level.spec.ts

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { REPO_ROOT, startHost } from './fixtures/integration.ts';

const require = createRequire(import.meta.url);

type Source = { kind: string };
interface ReadResult {
  status: number;
  error: string | null;
  body: Buffer | null;
}
const narrator = require('../../live/lib/narrator.cjs') as {
  doctorSource(...dirs: string[]): Source;
  readNarrator(source: Source, name: string, opts?: { preflightOk?: boolean }): Promise<ReadResult>;
  narratorNames(source: Source): string[];
};
const paths = require('../../live/lib/paths.cjs') as {
  resolvePaths(env: Record<string, string | undefined>): { gateDir: string; levelDir: string; sampleDir: string };
};

let root = '';
let levelDir = '';
let sampleDir = '';

test.beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'copyholder-level-'));
  levelDir = join(root, 'gate', 'level');
  sampleDir = join(root, 'sample');
  mkdirSync(levelDir, { recursive: true });
  mkdirSync(join(sampleDir, 'audio'), { recursive: true });
});

test.afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

async function served(source: Source, name: string): Promise<string | number> {
  const r = await narrator.readNarrator(source, name);
  return r.status === 200 && Buffer.isBuffer(r.body) ? r.body.toString('utf8') : r.status;
}

test('level.wav comes from gate/level/ even when sample/ has one too', async () => {
  writeFileSync(join(levelDir, 'level.wav'), 'RIFF-gate-level');
  writeFileSync(join(sampleDir, 'level.wav'), 'RIFF-sample');
  const src = narrator.doctorSource(levelDir, sampleDir);
  expect(narrator.narratorNames(src)).toEqual(['level.wav']);
  expect(await served(src, 'level.wav')).toBe('RIFF-gate-level');
});

test('without gate/level/level.wav, sample/ and then sample/audio/ serve it', async () => {
  const src = narrator.doctorSource(levelDir, sampleDir);
  writeFileSync(join(sampleDir, 'audio', 'level.wav'), 'RIFF-sample-audio');
  expect(await served(src, 'level.wav')).toBe('RIFF-sample-audio');
  writeFileSync(join(sampleDir, 'level.wav'), 'RIFF-sample');
  expect(await served(src, 'level.wav')).toBe('RIFF-sample');
});

test('no level.wav anywhere: 404 and no narrator names', async () => {
  const src = narrator.doctorSource(levelDir, sampleDir);
  expect(narrator.narratorNames(src)).toEqual([]);
  const r = await narrator.readNarrator(src, 'level.wav');
  expect([r.status, r.error]).toEqual([404, 'missing']);
});

test('only level.wav is on the doctor allow list, whatever gate/level/ holds', async () => {
  for (const f of ['level.timings.json', 'level.txt', 'listen.wav']) writeFileSync(join(levelDir, f), 'x');
  const src = narrator.doctorSource(levelDir, sampleDir);
  for (const f of ['level.timings.json', 'level.txt', 'listen.wav', '../level/level.txt']) {
    expect((await narrator.readNarrator(src, f)).status, f).toBe(404);
  }
});

test('levelDir is <COPYHOLDER_GATE_DIR>/level, by default gate/level of the repository', () => {
  expect(paths.resolvePaths({ COPYHOLDER_GATE_DIR: join(root, 'gate') }).levelDir).toBe(levelDir);
  expect(paths.resolvePaths({}).levelDir).toBe(join(REPO_ROOT, 'gate', 'level'));
});

test('host --mode doctor --level lists and serves gate/level/level.wav (spec 7.7)', async () => {
  writeFileSync(join(levelDir, 'level.wav'), 'RIFF-gate-level');
  const dist = join(root, 'dist');
  mkdirSync(dist);
  writeFileSync(join(dist, 'index.html'), '<!doctype html><title>stand-in page</title>');
  const sessions = join(root, 'sessions');
  mkdirSync(sessions);
  const host = await startHost(['--mode', 'doctor', '--level'], {
    COPYHOLDER_SESSIONS_DIR: sessions,
    COPYHOLDER_WEB_DIST: dist,
    COPYHOLDER_GATE_DIR: join(root, 'gate'),
    COPYHOLDER_SAMPLE_DIR: sampleDir,
    COPYHOLDER_QUICKCHECK_SCRIPT: 'off',
  });
  try {
    const page = new URL(host.url);
    const token = page.searchParams.get('token') ?? '';
    const config = (await (await fetch(`${page.origin}/api/config?token=${token}`)).json()) as { narrator: string[] };
    expect(config.narrator).toEqual(['level.wav']);
    const res = await fetch(`${page.origin}/api/narrator/level.wav?token=${token}`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('audio/wav');
    expect(await res.text()).toBe('RIFF-gate-level');
  } finally {
    await host.stop();
  }
});
