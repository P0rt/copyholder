import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { createHash } from 'node:crypto';
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import {
  EXIT_USAGE,
  EXIT_UV_MISSING,
  SET_USAGE,
  TTS_DIR,
  TTS_SCRIPT,
  findUv,
  main,
  nodeDeps,
  renderFiles,
  runChild,
  selftestOutcome,
  signalExitCode,
  uvArgs,
  uvCandidates,
  writeFileAtomic,
  type RunDeps,
  type RunOptions,
  type RunResult,
} from './run.ts';
import { parseTimingsSet, timingsForClip } from './timings.ts';

const DIR = import.meta.dirname;
const TIMINGS = readFileSync(join(DIR, 'fixtures/selftest.timings.json'), 'utf8');
const SAMPLES = (JSON.parse(TIMINGS) as { durationSamples: number }).durationSamples;
const SELFTEST_TEXT = (JSON.parse(readFileSync(join(DIR, 'selftest.json'), 'utf8')) as { text: string }).text;
const OK_LINE = 'TTS SELFTEST OK 31 10600';
const POSIX = process.platform !== 'win32';

/** Silent mono WAV: 32-bit float by default, else 16-bit PCM. */
function silentWav(frames: number, pcm16 = false): Uint8Array {
  const width = pcm16 ? 2 : 4;
  const out = new Uint8Array(44 + frames * width);
  const v = new DataView(out.buffer);
  const put = (at: number, s: string): void => [...s].forEach((c, i) => v.setUint8(at + i, c.charCodeAt(0)));
  put(0, 'RIFF');
  v.setUint32(4, 36 + frames * width, true);
  put(8, 'WAVE');
  put(12, 'fmt ');
  v.setUint32(16, 16, true);
  v.setUint16(20, pcm16 ? 1 : 3, true);
  v.setUint16(22, 1, true);
  v.setUint32(24, 48000, true);
  v.setUint32(28, 48000 * width, true);
  v.setUint16(32, width, true);
  v.setUint16(34, 8 * width, true);
  put(36, 'data');
  v.setUint32(40, frames * width, true);
  return out;
}

const WAV = silentWav(SAMPLES);

interface Fake {
  deps: RunDeps;
  out: string[];
  err: string[];
  calls: { cmd: string; args: string[]; opts: RunOptions }[];
  written: Record<string, string>;
}

function fakeDeps(over: Partial<RunDeps> & { files?: Record<string, string | Uint8Array>; result?: Partial<RunResult> } = {}): Fake {
  const { files = {}, result = {}, ...rest } = over;
  const out: string[] = [];
  const err: string[] = [];
  const calls: Fake['calls'] = [];
  const written: Record<string, string> = {};
  const file = (p: string): string | Uint8Array => {
    const v = files[p];
    if (v === undefined) throw new Error(`ENOENT: no such file ${p}`);
    return v;
  };
  const deps: RunDeps = {
    env: { PATH: '/usr/bin' },
    platform: 'linux',
    home: '/home/me',
    cwd: '/work',
    isExecutableFile: (p) => p === '/usr/bin/uv',
    readText: (p) => {
      const v = file(p);
      return typeof v === 'string' ? v : new TextDecoder().decode(v);
    },
    readBytes: (p) => {
      const v = file(p);
      return typeof v === 'string' ? new TextEncoder().encode(v) : v;
    },
    readStdin: () => Promise.reject(new Error('stdin is not read here')),
    writeText: (p, text) => {
      written[p] = text;
    },
    run: async (cmd, args, opts) => {
      calls.push({ cmd, args, opts });
      return { code: 0, signal: null, stdout: '', ...result };
    },
    out: (l) => out.push(l),
    err: (l) => err.push(l),
    ...rest,
  };
  return { deps, out, err, calls, written };
}

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'tts-run-'));
}

const signalListeners = (): number[] => [process.listenerCount('SIGINT'), process.listenerCount('SIGTERM')];

describe('finding uv', () => {
  it('tries $UV, then PATH, then the usual install folders', () => {
    expect(uvCandidates({ UV: '/x/uv', PATH: '/a:/b' }, 'darwin', '/h')).toEqual([
      '/x/uv',
      '/a/uv',
      '/b/uv',
      '/h/.local/bin/uv',
      '/h/.cargo/bin/uv',
      '/opt/homebrew/bin/uv',
      '/usr/local/bin/uv',
    ]);
    expect(uvCandidates({}, 'linux', '/h')).toEqual(['/h/.local/bin/uv', '/h/.cargo/bin/uv']);
  });

  it('returns the first candidate that is an executable file', () => {
    const isExecutableFile = (p: string): boolean => p === '/h/.local/bin/uv' || p === '/b/uv';
    expect(findUv({ env: { PATH: '/a:/b' }, platform: 'linux', home: '/h', isExecutableFile })).toBe('/b/uv');
    expect(findUv({ env: {}, platform: 'linux', home: '/h', isExecutableFile: () => false })).toBeNull();
  });

  it.skipIf(!POSIX)('skips a folder and a file without the execute bit and keeps looking', () => {
    const dir = tempDir();
    try {
      const [a, b, c] = ['a', 'b', 'c'].map((d) => join(dir, d)) as [string, string, string];
      mkdirSync(join(a, 'uv'), { recursive: true });
      mkdirSync(b);
      writeFileSync(join(b, 'uv'), '#!/bin/sh\n', { mode: 0o644 });
      mkdirSync(c);
      writeFileSync(join(c, 'uv'), '#!/bin/sh\n', { mode: 0o755 });
      const { isExecutableFile } = nodeDeps();
      expect(findUv({ env: { PATH: [a, b, c].join(delimiter) }, platform: 'linux', home: dir, isExecutableFile })).toBe(join(c, 'uv'));
      expect(findUv({ env: { PATH: [a, b].join(delimiter) }, platform: 'linux', home: dir, isExecutableFile })).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('arguments', () => {
  it('runs tts.py in the locked tools/tts project', () => {
    expect(uvArgs(['--selftest'])).toEqual(['run', '--locked', '--project', TTS_DIR, 'python', TTS_SCRIPT, '--selftest']);
  });

  it('knows a render by its three file arguments, "-" being stdin', () => {
    expect(renderFiles(['a.txt', 'a.wav', 'a.json'])).toEqual({ input: 'a.txt', wav: 'a.wav', timings: 'a.json' });
    expect(renderFiles(['--show-text', 'a.txt', 'a.wav', 'a.json'])).toEqual({ input: 'a.txt', wav: 'a.wav', timings: 'a.json' });
    expect(renderFiles(['-', 'a.wav', 'a.json'])).toEqual({ input: '-', wav: 'a.wav', timings: 'a.json' });
    expect(renderFiles(['--selftest'])).toBeNull();
    expect(renderFiles(['a.txt', 'a.wav'])).toBeNull();
  });

  it('maps a signal to 128 plus its number, as a shell does', () => {
    expect(signalExitCode('SIGINT')).toBe(130);
    expect(signalExitCode('SIGTERM')).toBe(143);
  });
});

describe('selftest: exactly one line and exit 0 or 1 (spec 7.7)', () => {
  it("keeps tts.py's own line and sends other stdout to stderr", () => {
    expect(selftestOutcome({ code: 0, signal: null, stdout: `Downloading weights\n${OK_LINE}\n` })).toEqual({
      line: OK_LINE,
      exitCode: 0,
      other: ['Downloading weights'],
    });
    expect(selftestOutcome({ code: 1, signal: null, stdout: 'TTS SELFTEST FAIL: 30 words, expected 31\n' })).toEqual({
      line: 'TTS SELFTEST FAIL: 30 words, expected 31',
      exitCode: 1,
      other: [],
    });
  });

  it('says what happened when uv or Python failed before the result line', () => {
    // A stale uv.lock with --locked: uv exits 2 and prints nothing on stdout.
    expect(selftestOutcome({ code: 2, signal: null, stdout: '' }).line).toBe(
      'TTS SELFTEST FAIL: uv exited with code 2 before the selftest printed its result',
    );
    expect(selftestOutcome({ code: null, signal: 'SIGKILL', stdout: `${OK_LINE}\n` })).toEqual({
      line: 'TTS SELFTEST FAIL: stopped by SIGKILL',
      exitCode: 1,
      other: [OK_LINE],
    });
    expect(selftestOutcome({ code: 3, signal: null, stdout: `${OK_LINE}\n` }).line).toBe(`TTS SELFTEST FAIL: exit code 3 after ${OK_LINE}`);
    expect(selftestOutcome({ code: 0, signal: null, stdout: 'TTS SELFTEST OK thirty one\n' })).toEqual({
      line: 'TTS SELFTEST FAIL: unreadable result line',
      exitCode: 1,
      other: ['TTS SELFTEST OK thirty one'],
    });
  });

  it('puts a reason with line breaks on one line', () => {
    expect(selftestOutcome({ code: 1, signal: null, stdout: 'TTS SELFTEST FAIL:  model\tfile\u2028missing\u0085here \n' }).line).toBe(
      'TTS SELFTEST FAIL: model file missing here',
    );
    expect(selftestOutcome({ code: 1, signal: null, stdout: 'TTS SELFTEST FAIL:\n' }).line).toBe('TTS SELFTEST FAIL: no reason given');
  });

  it('any stdout, exit code or signal gives one OK or FAIL line, and OK only with exit code 0', () => {
    const piece = fc.oneof(
      fc.string(),
      fc.constant(OK_LINE),
      fc.constant('TTS SELFTEST OK 31'),
      fc.constant('TTS SELFTEST FAIL: model\r\nfile missing'),
      fc.constant(' TTS SELFTEST FAIL:\tbad\u2028thing '),
      fc.constant('Downloading kokoro\r'),
    );
    const signal = fc.option(fc.constantFrom<NodeJS.Signals>('SIGINT', 'SIGTERM', 'SIGKILL'), { nil: null });
    fc.assert(
      fc.property(fc.array(piece, { maxLength: 6 }), fc.integer({ min: 0, max: 255 }), signal, (pieces, code, sig) => {
        const r: RunResult = { code: sig === null ? code : null, signal: sig, stdout: pieces.join('\n') };
        const o = selftestOutcome(r);
        expect(o.line).toMatch(/^TTS SELFTEST (OK \d+ \d+|FAIL: \S.*)$/);
        expect(o.line).not.toMatch(/[\r\n\u0085\u2028\u2029]/);
        expect(o.exitCode).toBe(o.line.startsWith('TTS SELFTEST OK ') ? 0 : 1);
        if (o.exitCode === 0) expect(r).toMatchObject({ code: 0, signal: null });
      }),
      { numRuns: 200 },
    );
  });
});

describe('main', () => {
  it('explains how to install uv when it is missing', async () => {
    const self = fakeDeps({ isExecutableFile: () => false });
    expect(await main(['--selftest'], self.deps)).toBe(1);
    expect(self.out).toEqual(['TTS SELFTEST FAIL: uv not found']);
    expect(self.err.join('\n')).toMatch(/brew install uv/);

    const render = fakeDeps({ isExecutableFile: () => false });
    expect(await main(['a.txt', 'a.wav', 'a.json'], render.deps)).toBe(EXIT_UV_MISSING);
    expect(render.out).toEqual([]);
  });

  it('runs the selftest from the folder where npm was called and prints its one line', async () => {
    const f = fakeDeps({ result: { stdout: `${OK_LINE}\n` } });
    expect(await main(['--selftest'], f.deps)).toBe(0);
    expect(f.calls).toEqual([{ cmd: '/usr/bin/uv', args: uvArgs(['--selftest']), opts: { cwd: '/work', captureStdout: true } }]);
    expect(f.out).toEqual([OK_LINE]);
  });

  it('turns every selftest failure into one FAIL line and exit 1', async () => {
    const failed = fakeDeps({ result: { code: 3 } });
    expect(await main(['--selftest'], failed.deps)).toBe(1);
    expect(failed.out).toEqual(['TTS SELFTEST FAIL: uv exited with code 3 before the selftest printed its result']);
    const killed = fakeDeps({ result: { code: null, signal: 'SIGTERM' } });
    expect(await main(['--selftest'], killed.deps)).toBe(1);
    expect(killed.out).toEqual(['TTS SELFTEST FAIL: stopped by SIGTERM']);
    const broken = fakeDeps({ run: () => Promise.reject(new Error('spawn EACCES')) });
    expect(await main(['--selftest'], broken.deps)).toBe(1);
    expect(broken.out).toEqual(['TTS SELFTEST FAIL: cannot start uv']);
  });

  it('passes the exit code and signals of a render through', async () => {
    const failed = fakeDeps({ result: { code: 3 } });
    expect(await main(['a.txt', 'a.wav', 'a.json'], failed.deps)).toBe(3);
    expect(failed.calls[0]!.opts).toEqual({ cwd: '/work' });
    const killed = fakeDeps({ result: { code: null, signal: 'SIGINT' } });
    expect(await main(['a.txt', 'a.wav', 'a.json'], killed.deps)).toBe(130);
    const broken = fakeDeps({ run: () => Promise.reject(new Error('spawn ENOENT')) });
    expect(await main(['a.txt', 'a.wav', 'a.json'], broken.deps)).toBe(1);
  });

  it('checks a render against words.ts and against the WAV it wrote', async () => {
    const files = { '/work/in.txt': SELFTEST_TEXT, '/work/out.json': TIMINGS, '/work/out.wav': WAV };
    const ok = fakeDeps({ files });
    expect(await main(['in.txt', 'out.wav', 'out.json'], ok.deps)).toBe(0);
    expect(ok.err).toEqual([]);

    const wrongText = fakeDeps({ files: { ...files, '/work/in.txt': `${SELFTEST_TEXT} One more.` } });
    expect(await main(['in.txt', 'out.wav', 'out.json'], wrongText.deps)).toBe(1);
    expect(wrongText.err[0]).toMatch(/^TTS FAIL: timings.json does not match words.ts or the WAV: words.ts finds 33 words/);

    const shortWav = fakeDeps({ files: { ...files, '/work/out.wav': silentWav(SAMPLES - 1) } });
    expect(await main(['in.txt', 'out.wav', 'out.json'], shortWav.deps)).toBe(1);
    expect(shortWav.err[0]).toContain(`the WAV holds ${SAMPLES - 1} samples, timings.json says ${SAMPLES}`);

    const pcmWav = fakeDeps({ files: { ...files, '/work/out.wav': silentWav(SAMPLES, true) } });
    expect(await main(['in.txt', 'out.wav', 'out.json'], pcmWav.deps)).toBe(1);
    expect(pcmWav.err[0]).toContain('the WAV is format 1, 16 bit, expected 32-bit float');

    const missing = fakeDeps({ files: { '/work/in.txt': SELFTEST_TEXT, '/work/out.wav': WAV } });
    expect(await main(['in.txt', 'out.wav', 'out.json'], missing.deps)).toBe(1);
    expect(missing.err[0]).toMatch(/^TTS FAIL: cannot check timings.json/);
  });

  it('hands a passage on stdin to tts.py and checks against that text (no draft file on disk)', async () => {
    const text = new TextEncoder().encode(`\ufeff${SELFTEST_TEXT}`);
    const f = fakeDeps({ files: { '/work/out.json': TIMINGS, '/work/out.wav': WAV }, readStdin: async () => text });
    expect(await main(['-', 'out.wav', 'out.json'], f.deps)).toBe(0);
    expect(f.calls[0]!.args).toEqual(uvArgs(['-', 'out.wav', 'out.json']));
    expect(f.calls[0]!.opts).toEqual({ cwd: '/work', stdin: text });
    expect(f.err).toEqual([]);
  });
});

describe('--set: one timings.json for the clips of a folder (spec 8.2)', () => {
  const files = { '/work/a.wav': WAV, '/work/a.json': TIMINGS };

  it('joins checked clips with the SHA-256 of each WAV', async () => {
    const f = fakeDeps({ files });
    expect(await main(['--set', 'out/timings.json', 'opening', 'a.wav', 'a.json', 'p1', 'a.wav', 'a.json'], f.deps)).toBe(0);
    expect(f.out).toEqual(['TTS SET OK 2 passages']);
    expect(f.calls).toEqual([]);
    const text = f.written['/work/out/timings.json']!;
    const set = parseTimingsSet(JSON.parse(text));
    expect(set.passages.map((p) => p.passageId)).toEqual(['opening', 'p1']);
    expect(set.passages[0]!.audioSha256).toBe(createHash('sha256').update(WAV).digest('hex'));
    expect(timingsForClip(set, 'p1.wav')).toEqual(JSON.parse(TIMINGS));
    expect(text.split('\n').filter((l) => /^ +\{"index": \d+, "startMs": \d+, "endMs": \d+, "sentenceIndex": \d+\},?$/.test(l))).toHaveLength(62);
  });

  it('shows the usage for wrong arguments', async () => {
    for (const args of [[], ['out.json'], ['out.json', 'p1', 'a.wav'], ['--x', 'p1', 'a.wav', 'a.json']]) {
      const f = fakeDeps({ files });
      expect(await main(['--set', ...args], f.deps)).toBe(EXIT_USAGE);
      expect(f.err).toEqual([SET_USAGE]);
      expect(f.written).toEqual({});
    }
  });

  it('refuses a WAV that is not the clip, duplicate or bad ids and missing files, and writes nothing', async () => {
    const cases: [string[], RegExp][] = [
      [['p1', 'short.wav', 'a.json'], /^TTS FAIL: passage p1: the WAV holds \d+ samples, timings.json says \d+$/],
      [['p1', 'a.wav', 'a.json', 'p1', 'a.wav', 'a.json'], /listed twice/],
      [['P1.wav', 'a.wav', 'a.json'], /passageId/],
      [['p1', 'a.wav', 'missing.json'], /ENOENT/],
    ];
    for (const [args, message] of cases) {
      const f = fakeDeps({ files: { ...files, '/work/short.wav': silentWav(100) } });
      expect(await main(['--set', 'timings.json', ...args], f.deps)).toBe(1);
      expect(f.err[0]).toMatch(message);
      expect(f.written).toEqual({});
    }
  });
});

describe.skipIf(!POSIX)('child processes', () => {
  /** A stand-in uv: a shell script in a fresh folder, found through PATH. */
  function standIn(body: string): { dir: string; deps: RunDeps; out: string[]; err: string[] } {
    const dir = tempDir();
    writeFileSync(join(dir, 'uv'), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
    const out: string[] = [];
    const err: string[] = [];
    const deps: RunDeps = { ...nodeDeps(), env: { PATH: dir }, home: dir, cwd: dir, out: (l) => out.push(l), err: (l) => err.push(l) };
    return { dir, deps, out, err };
  }

  it('spawns uv in the calling folder with the arguments and forwards the selftest line', async () => {
    const s = standIn(`printf '%s\\n' "$PWD" "$@" > args.txt\necho 'Downloading weights'\necho '${OK_LINE}'`);
    try {
      expect(await main(['--selftest'], s.deps)).toBe(0);
      expect(s.out).toEqual([OK_LINE]);
      expect(s.err).toEqual(['Downloading weights']);
      const lines = readFileSync(join(s.dir, 'args.txt'), 'utf8').trim().split('\n');
      expect(lines.slice(1)).toEqual(uvArgs(['--selftest']));
    } finally {
      rmSync(s.dir, { recursive: true, force: true });
    }
  });

  it('prints a FAIL line when uv exits before the selftest prints its result', async () => {
    const s = standIn('exit 5');
    try {
      expect(await main(['--selftest'], s.deps)).toBe(1);
      expect(s.out).toEqual(['TTS SELFTEST FAIL: uv exited with code 5 before the selftest printed its result']);
    } finally {
      rmSync(s.dir, { recursive: true, force: true });
    }
  });

  it("pipes a passage from stdin into tts.py's stdin and passes a render's exit code through", async () => {
    const s = standIn('cat > got.txt\nexit 7');
    try {
      const bytes = new TextEncoder().encode('A planted draft.\nSecond paragraph.\n');
      expect(await main(['-', 'out.wav', 'out.json'], { ...s.deps, readStdin: async () => bytes })).toBe(7);
      expect(readFileSync(join(s.dir, 'got.txt'), 'utf8')).toBe('A planted draft.\nSecond paragraph.\n');
    } finally {
      rmSync(s.dir, { recursive: true, force: true });
    }
  });

  it('ignores SIGINT and SIGTERM only while the child runs, and reports its code or signal', async () => {
    const dir = tempDir();
    try {
      const before = signalListeners();
      const script = join(dir, 'child');
      writeFileSync(script, '#!/bin/sh\nprintf "one\\ntwo\\n"\nexit 4\n', { mode: 0o755 });
      const running = runChild(script, [], { cwd: dir, captureStdout: true });
      expect(signalListeners()).toEqual(before.map((n) => n + 1));
      expect(await running).toEqual({ code: 4, signal: null, stdout: 'one\ntwo\n' });
      expect(signalListeners()).toEqual(before);

      const killer = join(dir, 'killer');
      writeFileSync(killer, '#!/bin/sh\nkill -9 $$\n', { mode: 0o755 });
      expect(await runChild(killer, [], { cwd: dir })).toEqual({ code: null, signal: 'SIGKILL', stdout: '' });
      expect(signalListeners()).toEqual(before);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('removes its signal listeners when the child cannot start (ENOENT, EACCES)', async () => {
    const dir = tempDir();
    try {
      const before = signalListeners();
      await expect(runChild(join(dir, 'missing'), [], { cwd: dir })).rejects.toThrow(/ENOENT/);
      expect(signalListeners()).toEqual(before);
      const notExecutable = join(dir, 'uv');
      writeFileSync(notExecutable, '#!/bin/sh\nexit 0\n', { mode: 0o644 });
      await expect(runChild(notExecutable, [], { cwd: dir })).rejects.toThrow(/EACCES/);
      expect(signalListeners()).toEqual(before);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('writes files through a temporary file with mode 0600 (spec 8.2: drafts stay private)', () => {
    const dir = tempDir();
    try {
      const path = join(dir, 'sub', 'timings.json');
      writeFileAtomic(path, 'one');
      writeFileAtomic(path, 'two');
      expect(readFileSync(path, 'utf8')).toBe('two');
      expect(statSync(path).mode & 0o777).toBe(0o600);
      expect(readdirSync(join(dir, 'sub'))).toEqual(['timings.json']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
