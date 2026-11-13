// manifest.json hashes after the report host runs (spec 7.12, 8.1, 8.5; docs/protocol.md): a record
// kind without a ledger keeps its file hashes in manifest.json alone, and doctor rewrites calib.json
// (which holds the gain host wrote at the level choice) on DOCTOR OK. host then puts the new hash
// into `files`; on DOCTOR FAIL the file and its hash stay as host wrote them.
// Node only: the real host, a stand-in worker on /session and a stand-in report instead of
// analysis/quickcheck.ts. Run: npx playwright test tests/e2e/host-hashes.spec.ts

import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { FakeWorker } from '../live/helpers.ts';
import { readJson, startHost } from './fixtures/integration.ts';

const require = createRequire(import.meta.url);
const hash = require('../../live/lib/hash.cjs') as {
  rehashFiles(dir: string, hashes: Record<string, string>): { files: Record<string, string>; changed: string[] };
};

const sha256 = (b: Uint8Array | string): string => createHash('sha256').update(b).digest('hex');
const CHOSEN_GAIN = 0.35;

let root = '';

test.beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'copyholder-hashes-'));
});

test.afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

test('rehashFiles: new hashes for rewritten files, the rest and gone files keep theirs', () => {
  const dir = join(root, 'folder');
  mkdirSync(dir);
  writeFileSync(join(dir, 'audio.wav'), 'audio');
  writeFileSync(join(dir, 'calib.json'), '{"output_gain":0.35}\n');
  const saved = { 'audio.wav': sha256('audio'), 'calib.json': sha256('{"output_gain":0.35}\n'), 'gone.jsonl': sha256('gone') };
  expect(hash.rehashFiles(dir, saved)).toEqual({ files: saved, changed: [] });
  writeFileSync(join(dir, 'calib.json'), '{"output_gain":0.35,"leak_db_over_floor":1.5}\n');
  writeFileSync(join(dir, 'new.json'), 'not listed, not hashed');
  expect(hash.rehashFiles(dir, saved)).toEqual({
    files: { ...saved, 'calib.json': sha256('{"output_gain":0.35,"leak_db_over_floor":1.5}\n') },
    changed: ['calib.json'],
  });
});

/** A stand-in for analysis/quickcheck.ts: on 'ok' it rewrites calib.json as doctor does, then prints the verdict. */
function writeReport(verdict: 'ok' | 'fail'): string {
  const file = join(root, `report-${verdict}.mjs`);
  writeFileSync(
    file,
    [
      "import { readFileSync, writeFileSync } from 'node:fs';",
      "import { join } from 'node:path';",
      'const file = join(process.env.COPYHOLDER_SESSIONS_DIR, process.argv[2], "calib.json");',
      verdict === 'ok'
        ? [
            'const calib = JSON.parse(readFileSync(file, "utf8"));',
            'writeFileSync(file, JSON.stringify({ ...calib, L_rt_ms: { A: 23.4, B: 23.6, rule: "mean", used: 23.5 }, leak_db_over_floor: 1.5 }, null, 2) + "\\n");',
            'console.log("DOCTOR OK");',
            'process.exitCode = 0;',
          ].join('\n')
        : ['console.log("DOCTOR FAIL: stand-in report");', 'process.exitCode = 2;'].join('\n'),
      '',
    ].join('\n'),
  );
  return file;
}

/** A doctor --level recording through the real host: consent, one audio block, the level choice, end. */
async function doctorRecording(report: string): Promise<{ dir: string; verdict: Record<string, unknown> }> {
  const levelDir = join(root, 'gate', 'level');
  mkdirSync(levelDir, { recursive: true });
  writeFileSync(join(levelDir, 'level.wav'), 'RIFF-level');
  const dist = join(root, 'dist');
  mkdirSync(dist);
  writeFileSync(join(dist, 'index.html'), '<!doctype html><title>stand-in page</title>');
  const sessions = join(root, 'sessions');
  mkdirSync(sessions);
  const host = await startHost(['--mode', 'doctor', '--level'], {
    COPYHOLDER_SESSIONS_DIR: sessions,
    COPYHOLDER_WEB_DIST: dist,
    COPYHOLDER_GATE_DIR: join(root, 'gate'),
    COPYHOLDER_SAMPLE_DIR: join(root, 'sample'),
    COPYHOLDER_QUICKCHECK_SCRIPT: report,
  });
  let worker: FakeWorker | null = null;
  try {
    const page = new URL(host.url);
    const token = page.searchParams.get('token') ?? '';
    const config = (await (await fetch(`${page.origin}/api/config?token=${token}`)).json()) as { sessionUrl: string };
    worker = await FakeWorker.open(config.sessionUrl, page.origin);
    worker.hello();
    worker.send({ t: 'consent', at: '2026-11-13T08:00:00.000Z' });
    worker.block(0);
    worker.send({ t: 'event', line: { n: 4800, e: 'gain', hard: false, value: CHOSEN_GAIN, db: -9.1, final: true } });
    worker.send({ t: 'end', reason: 'done' });
    const verdict = await worker.waitMessage((m) => m.t === 'quickcheck', 60_000);
    expect(await host.waitExit(30_000)).toBe(0);
    const dirs = readdirSync(sessions);
    expect(dirs).toHaveLength(1);
    return { dir: join(sessions, dirs[0] ?? ''), verdict };
  } finally {
    await worker?.close();
    await host.stop();
  }
}

/** Every file manifest.json lists has that hash now. */
function expectHashesMatch(dir: string): Record<string, string> {
  const files = readJson<{ files: Record<string, string> }>(join(dir, 'manifest.json')).files;
  for (const [name, h] of Object.entries(files)) expect(h, `manifest.json hash of ${name}`).toBe(`sha256:${sha256(readFileSync(join(dir, name)))}`);
  return files;
}

test('DOCTOR OK: doctor rewrote calib.json, and manifest.json holds the hash of the new file', async () => {
  const { dir, verdict } = await doctorRecording(writeReport('ok'));
  expect(verdict).toMatchObject({ ok: true, text: 'DOCTOR OK' });
  const calib = readJson<Record<string, unknown>>(join(dir, 'calib.json'));
  expect(calib).toMatchObject({ schema: 'calib/1', output_gain: CHOSEN_GAIN, leak_db_over_floor: 1.5 });
  const files = expectHashesMatch(dir);
  expect(Object.keys(files).sort()).toEqual(['audio.wav', 'calib.json', 'detector_in.jsonl', 'events.jsonl', 'stamps.jsonl']);
  // nothing else of manifest.json changed: the record as host closed it
  const m = readJson<Record<string, unknown>>(join(dir, 'manifest.json'));
  expect(m).toMatchObject({ kind: 'doctor', scenario: 'doctor-level', state: 'closed' });
  expect((m['audio'] as Record<string, unknown>)['output_gain']).toBe(CHOSEN_GAIN);
});

test('DOCTOR FAIL: calib.json keeps only the chosen level, and its hash in manifest.json is that file', async () => {
  const { dir, verdict } = await doctorRecording(writeReport('fail'));
  expect(verdict).toMatchObject({ ok: false, text: 'DOCTOR FAIL: stand-in report' });
  expect(readJson(join(dir, 'calib.json'))).toEqual({ schema: 'calib/1', output_gain: CHOSEN_GAIN });
  expect(Object.keys(expectHashesMatch(dir))).toContain('calib.json');
});
