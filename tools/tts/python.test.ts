// Runs test_tts.py under Vitest, so npm test and CI cover the timing arithmetic of tts.py and the
// words.py mirror of words.ts (spec 13.4). Checks that need kokoro, numpy or soxr skip themselves
// where those are not installed; the whole file skips without Python 3.10 or newer.

import { spawn, spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { TTS_DIR } from './run.ts';

const PYTHON = process.platform === 'win32' ? 'python' : 'python3';

/** True when PYTHON runs and is at least 3.10 (pyproject.toml requires-python). */
function pythonUsable(): boolean {
  const r = spawnSync(PYTHON, ['--version'], { encoding: 'utf8' });
  const m = /Python (\d+)\.(\d+)/.exec(`${r.stdout ?? ''}${r.stderr ?? ''}`);
  return r.status === 0 && m !== null && (Number(m[1]) > 3 || (Number(m[1]) === 3 && Number(m[2]) >= 10));
}

function runUnittest(): Promise<{ code: number | null; output: string }> {
  return new Promise((done, fail) => {
    const child = spawn(PYTHON, ['-m', 'unittest', 'discover', '-s', TTS_DIR, '-p', 'test_*.py'], {
      cwd: TTS_DIR,
      // No __pycache__ in the source folder; torch, where installed, stays on two threads.
      env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1', OMP_NUM_THREADS: '2', MKL_NUM_THREADS: '2' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    child.stdout.setEncoding('utf8').on('data', (s: string) => (output += s));
    child.stderr.setEncoding('utf8').on('data', (s: string) => (output += s));
    child.on('error', fail);
    child.on('close', (code) => done({ code, output }));
  });
}

describe.skipIf(!pythonUsable())('tts.py and words.py', () => {
  it('pass their Python unit tests', async () => {
    const r = await runUnittest();
    expect(r.code, r.output).toBe(0);
    expect(r.output).toMatch(/^Ran \d+ tests? in /m);
    expect(r.output).toMatch(/^OK\b/m);
  });
});
