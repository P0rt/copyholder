// The integration fixtures leave no process behind on their failure paths (tests/e2e/fixtures/integration.ts):
// runQuiet ends with the command's whole process group, even when a leftover child holds its stdout, and
// startHost stops a host that printed no page address before it rejects.
// Node only: no browser. Run: npx playwright test tests/e2e/process-cleanup.spec.ts

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { processRunning, waitUntil } from '../live/helpers.ts';
import { runQuiet, startHost } from './fixtures/integration.ts';

test('runQuiet resolves at the exit and kills a child that still holds stdout', async () => {
  const t0 = performance.now();
  // sh exits at once; its background sleep keeps the stdout pipe open for a minute
  const r = await runQuiet('sh', ['-c', 'sleep 60 & echo $!'], 30_000);
  expect(performance.now() - t0, 'resolved without waiting for the pipe').toBeLessThan(10_000);
  expect([r.code, r.timedOut]).toEqual([0, false]);
  const pid = Number(r.stdout.trim());
  expect(Number.isInteger(pid) && pid > 0, `pid of the sleep: ${r.stdout}`).toBe(true);
  await waitUntil(() => !processRunning(pid), 5000);
});

test('runQuiet kills the whole process group at the timeout', async () => {
  const t0 = performance.now();
  const r = await runQuiet('sh', ['-c', 'sleep 60 & echo $!; wait'], 1000);
  expect(r.timedOut).toBe(true);
  expect(performance.now() - t0).toBeLessThan(10_000);
  const pid = Number(r.stdout.trim());
  expect(Number.isInteger(pid) && pid > 0, `pid of the sleep: ${r.stdout}`).toBe(true);
  await waitUntil(() => !processRunning(pid), 5000);
});

test('startHost stops a host that printed no page address in time, then rejects', async () => {
  const root = mkdtempSync(join(tmpdir(), 'copyholder-cleanup-'));
  try {
    const dist = join(root, 'dist');
    mkdirSync(dist);
    writeFileSync(join(dist, 'index.html'), '<!doctype html><title>stand-in page</title>');
    mkdirSync(join(root, 'sessions'));
    const env = { COPYHOLDER_SESSIONS_DIR: join(root, 'sessions'), COPYHOLDER_WEB_DIST: dist, COPYHOLDER_QUICKCHECK_SCRIPT: 'off' };
    // 1 ms: the deadline passes long before host can print its address
    const err = await startHost(['--mode', 'doctor', '--level'], env, 1).then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toMatch(/^host printed no page address in 1 ms/);
    const pid = (err as { pid?: number }).pid;
    expect(typeof pid).toBe('number');
    await waitUntil(() => !processRunning(pid ?? 0), 5000);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
