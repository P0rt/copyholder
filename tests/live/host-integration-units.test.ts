// Pieces of host's integration pass: tap's console as tap.log (redaction, line splitting, the held lines
// before consent), tap's IPC answers as tap_* events (spec 7.12), the settings for devices and the port,
// the code 3 hint of spec 7.1 by SDK call, and the quickcheck process group helpers.
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import fc from 'fast-check';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { validateEventLine } from '../../core/schemas/session.ts';
import { processRunning, requireCjs, waitUntil } from './helpers.ts';

interface TapLogInstance {
  readonly isOpen: boolean;
  dropped: number;
  lines: number;
  line(text: string): void;
  open(dir: string): boolean;
  close(): void;
}
const tapLog = requireCjs('../../live/lib/tap-log.cjs') as {
  TAP_LOG: string;
  REDACTED: string;
  MIN_CREDENTIAL_CHARS: number;
  redactCredentials(text: string): string;
  isPathRun(run: string): boolean;
  isCredentialSegment(seg: string): boolean;
  letterDigitSwitches(s: string): number;
  cutPoint(text: string, max: number): number;
  LineSplitter: new (onLine: (line: string) => void, o?: { maxLineChars?: number }) => { push(chunk: Buffer | string): void; end(): void };
  TapLog: new (o?: { maxHeldLines?: number; maxHeldChars?: number }) => TapLogInstance;
};
const tapEvents = requireCjs('../../live/lib/tap-events.cjs') as {
  TAP_EVENT_NAMES: string[];
  tapEventOf(m: unknown): { e: string; fields: Record<string, unknown> } | null;
};
const settings = requireCjs('../../live/lib/settings.cjs') as {
  DEFAULT_PORT: number;
  PORT_FALLBACK_CODES: string[];
  parsePort(raw: unknown): { port: number; note: string | null };
  portSetting(env: Record<string, string>, repoRoot: string): { port: number; note: string | null };
  deviceSettings(env: Record<string, string>, repoRoot: string): { input?: string; output?: string };
};
const codes = requireCjs('../../live/lib/sdk-codes.cjs') as {
  ELECTRON_HINT: string;
  isCameraCall(call: unknown): boolean;
  isCameraFailure(code: number | null, call: string | null): boolean;
  sdkErrorText(code: number | null, name: string | null, o?: { smoke?: boolean; call?: string | null }): string;
};
const repoInfo = requireCjs('../../live/lib/repo-info.cjs') as {
  parseEnvText(text: string): Record<string, string>;
  hostSetting(env: Record<string, string>, repoRoot: string, name: string): string;
};
const host = requireCjs('../../live/host.cjs') as {
  killGroup(child: { pid?: number } | null, signal: string | number): boolean;
  stopGroup(child: { pid?: number } | null, graceMs: number, after?: () => void): void;
  stopGroupSync(child: { pid?: number } | null, graceMs: number): void;
  durationText(ms: number): string;
};
const manifestLib = requireCjs('../../live/lib/manifest.cjs') as {
  buildManifest(r: Record<string, unknown>, files: Record<string, string>): Record<string, unknown>;
};
const reduce = requireCjs('../../live/reduce.cjs') as {
  enumLine(c: { label: string; differences: string[] }): string;
  PROCESSING_NAMES: Record<string, string>;
  VALIDATION_NAMES: Record<string, string>;
  ERROR_NAMES: Record<string, string>;
  parseEnvText(text: string): Record<string, string>;
};

/** Runs as tap-log.cjs reads them: key characters, with an earlier [redacted] inside a path. */
const RUN = /(?:\[redacted\]|[A-Za-z0-9_+/=-])+/g;
/** Credential-shaped runs in `text`: 24+ key characters with a letter and a digit. */
const credentialRuns = (text: string) =>
  [...text.matchAll(RUN)].map((m) => m[0]).filter((r) => r.length >= 24 && /[A-Za-z]/.test(r) && /[0-9]/.test(r));
const ENUM_PAIR = /^k[A-Z][A-Za-z]*=\d+$/;

/** Characters from `alphabet`, minLength..maxLength long, with at least one letter and one digit. */
function keyFrom(alphabet: string, minLength: number, maxLength: number) {
  return fc.array(fc.constantFrom(...alphabet.split('')), { minLength, maxLength })
    .map((a) => a.join(''))
    .filter((k) => /[A-Za-z]/.test(k) && /[0-9]/.test(k));
}
const ALNUM = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';

describe('tap.log redaction (spec 7.12, 12.5)', () => {
  it('redacts runs of 24+ key characters that hold a letter and a digit', () => {
    const r = tapLog.redactCredentials;
    expect(r('key: fake_key_AbCdEfGhIjKlMnOpQrSt1234 used')).toBe('key: [redacted] used');
    // '=' is a key character (base64), so a NAME=value pair is one run and goes whole
    expect(r('SMARTSPECTRA_API_KEY=AbCdEfGhIjKl1234')).toBe('[redacted]');
    expect(r('Bearer QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVo0123456789+/== end')).toBe('Bearer [redacted] end');
    expect(r('a1b2c3d4e5f6a7b8c9d0e1f2')).toBe('[redacted]'); // exactly 24
    expect(r('a1b2c3d4e5f6a7b8c9d0e1f')).toBe('a1b2c3d4e5f6a7b8c9d0e1f'); // 23
    expect(r('abcdefghijklmnopqrstuvwxyzabcdef')).toBe('abcdefghijklmnopqrstuvwxyzabcdef'); // no digit
    expect(r('1234567890123456789012345678')).toBe('1234567890123456789012345678'); // no letter
    expect(r('tap: cameras (copy one name into settings.env as COPYHOLDER_CAMERA_NAME=...):'))
      .toBe('tap: cameras (copy one name into settings.env as COPYHOLDER_CAMERA_NAME=...):');
    expect(r('packet 1: {"fields":["breathing","face"],"tsType":"number","tr":1}')).toBe('packet 1: {"fields":["breathing","face"],"tsType":"number","tr":1}');
    expect(r('two: aaaaaaaaaaaaaaaaaaaaaaa1 and bbbbbbbbbbbbbbbbbbbbbbb2.')).toBe('two: [redacted] and [redacted].');
    expect(r('uuid 123e4567-e89b-12d3-a456-426614174000 end')).toBe('uuid [redacted] end'); // a key may be a UUID
  });

  it('keeps tap\'s enum pairs, so the codes of the spec 7.1 table stay readable (spec 7.12 question 2)', () => {
    const line = reduce.enumLine({
      label: 'SmartSpectraErrorCode', differences: ['kSustainedLowFrameRate=14', 'kFrameConversionFailed=9', 'kNonMonotonicTimestamp=10'],
    });
    expect(line).toBe('SmartSpectraErrorCode: differs from reduce.cjs: kSustainedLowFrameRate=14, kFrameConversionFailed=9, kNonMonotonicTimestamp=10');
    expect(tapLog.redactCredentials(line)).toBe(line);
    // only that shape: a lower-case name, a name with digits or a value with letters is no enum pair
    expect(tapLog.redactCredentials('kfoobarbazquxquuxcorgegra=14')).toBe('[redacted]');
    expect(tapLog.redactCredentials('kSustainedLowFrameRate2=14')).toBe('[redacted]');
    expect(tapLog.redactCredentials('kSustainedLowFrameRate=1a4')).toBe('[redacted]');
  });

  it('keeps every enum line tap can print (property)', () => {
    const tables: [string, Record<string, string>][] = [
      ['ProcessingStatus', reduce.PROCESSING_NAMES], ['ValidationCode', reduce.VALIDATION_NAMES], ['SmartSpectraErrorCode', reduce.ERROR_NAMES],
    ];
    const pairs = tables.map(([label, t]) => [label, Object.entries(t).map(([code, name]) => `${name}=${code}`)] as const);
    fc.assert(
      fc.property(fc.constantFrom(...pairs), fc.integer({ min: 0, max: 1000 }), ([label, all], seed) => {
        const differences = all.filter((_, i) => ((seed >> (i % 10)) & 1) === 1 || i === seed % all.length);
        const line = reduce.enumLine({ label, differences });
        expect(tapLog.redactCredentials(line)).toBe(line);
      }),
      { numRuns: 100 },
    );
  });

  it('keeps the words of URL and file paths and redacts their id and key segments (spec 7.12 question 10)', () => {
    const r = tapLog.redactCredentials;
    const sdkLine = 'I20261113 08:00:01.234567 4242 net.cc:88] POST https://api.example.com/v2/insights/upload_snapshot sent';
    expect(r(sdkLine)).toBe(sdkLine);
    const model = 'loading /Users/jdoe/copyholder/live/node_modules/@smartspectra/node-sdk/models/v3/face_landmarker.task';
    expect(r(model)).toBe(model);
    expect(r('GET https://api.example.com/v1/sessions/8f14e45fceea167a5a36dedd4bea2543/insights'))
      .toBe('GET https://api.example.com/v1/sessions/[redacted]/insights');
    expect(r('PUT https://api.example.com/v1/sessions/123e4567-e89b-12d3-a456-426614174000/upload'))
      .toBe('PUT https://api.example.com/v1/sessions/[redacted]/upload');
    expect(r('https://api.example.com/v1/keys/AbCdEfGhIjKlMn0pQr5t/verify')).toBe('https://api.example.com/v1/keys/[redacted]/verify');
    expect(r('/data/abcd/efgh1234ijkl5678mnop/x1')).toBe('/data/abcd/[redacted]/x1'); // 8+ characters, two switches
    // a query value is no path: it goes whole
    expect(r('https://api.example.com/v1/auth?key=abcdefghijklmnopqrstu12345&x=1')).toBe('https://api.example.com/v1/auth?[redacted]&x=1');
    // a base64 key with slashes: '+' or '=', or half its letters upper case, so it is no path
    expect(r('token /QUJD/Ab3dEf9GhIj/kLmN0pQrSt56 end')).toBe('token [redacted] end');
    expect(r('token QUJD/REVGR0hJ/SktMTU5PUFFSU1RVVldYWVo0123+abc end')).toBe('token [redacted] end');
    expect(tapLog.isPathRun('com/v2/insights/upload_snapshot')).toBe(true);
    expect(tapLog.isPathRun('com/v2insights')).toBe(false); // one slash
    expect(tapLog.letterDigitSwitches('ab12c')).toBe(2);
    expect(tapLog.letterDigitSwitches('darwin-arm64')).toBe(1);
    expect(tapLog.isCredentialSegment('darwin-arm64')).toBe(false);
    expect(tapLog.isCredentialSegment('upload_snapshot_v2')).toBe(false);
  });

  it('keeps URL paths made of words (property)', () => {
    const segment = fc.constantFrom(
      'api', 'v1', 'v2', 'insights', 'upload', 'snapshot', 'upload_snapshot', 'upload-snapshot', 'uploadSnapshotV2', 'telemetry',
      'sessions', 'metrics', '2026', 'node-sdk', 'models', 'v3', 'face_landmarker', 'darwin-arm64', 'x86_64', 'Library',
    );
    fc.assert(
      fc.property(fc.array(segment, { minLength: 2, maxLength: 8 }), fc.constantFrom('https://api.example.com', 'http://10.0.0.1:8080', ''), (segs, base) => {
        const text = `I1113 08:00:01.234567 42 net.cc:1] POST ${base}/${segs.join('/')} sent`;
        expect(tapLog.redactCredentials(text)).toBe(text);
      }),
      { numRuns: 200 },
    );
  });

  it('never lets a key through, whole or in part, in the places an SDK log may print one (property)', () => {
    const key = fc.oneof(
      keyFrom('0123456789abcdef', 24, 64), // hex
      keyFrom(ALNUM, 24, 64),
      keyFrom(`${ALNUM}_-`, 24, 64), // base64url
      keyFrom(`${ALNUM}+`, 24, 62).map((k) => `${k}==`), // base64 without '/'
      fc.uuid(),
    );
    const place = fc.constantFrom(
      (k: string) => `key=${k}`, (k: string) => `Bearer ${k}`, (k: string) => `{"apiKey":"${k}"}`, (k: string) => `x-api-key: ${k}`,
      (k: string) => `GET https://api.example.com/v1/auth?api_key=${k}&v=2`, (k: string) => `GET https://api.example.com/v1/keys/${k}/verify`,
      (k: string) => `/v1/keys/${k}`, (k: string) => `[${k}]`, (k: string) => k,
    );
    fc.assert(
      fc.property(key, place, (k, at) => {
        const out = tapLog.redactCredentials(`I1113 08:00:01 auth.cc:9] ${at(k)} ok`);
        for (let i = 0; i + 12 <= k.length; i++) expect(out).not.toContain(k.slice(i, i + 12));
      }),
      { numRuns: 200 },
    );
  });

  it('is idempotent, changes nothing without a credential-shaped run, and leaves only enum pairs and clean paths (property)', () => {
    const keyChar = fc.constantFrom(...'abcXYZ0129_+/=- .:"[]'.split(''));
    fc.assert(
      fc.property(fc.array(keyChar, { maxLength: 120 }).map((a) => a.join('')), fc.string({ maxLength: 40 }), (keyish, other) => {
        const text = `${other}${keyish}${other}`;
        const once = tapLog.redactCredentials(text);
        expect(tapLog.redactCredentials(once)).toBe(once);
        if (credentialRuns(text).length === 0) expect(once).toBe(text);
        for (const run of credentialRuns(once)) {
          const kept = ENUM_PAIR.test(run) || (tapLog.isPathRun(run) && run.split('/').every((s) => !tapLog.isCredentialSegment(s)));
          expect(kept, run).toBe(true);
        }
      }),
      { numRuns: 200 },
    );
  });
});

describe('tap output line splitting', () => {
  it('joins UTF-8 split across chunks, drops \\r and gives the last line at end()', () => {
    const lines: string[] = [];
    const s = new tapLog.LineSplitter((l) => lines.push(l));
    const bytes = Buffer.from('caméra prête\r\nsecond', 'utf8');
    const cut = bytes.indexOf(0xc3) + 1; // inside the two bytes of "é"
    s.push(bytes.subarray(0, cut));
    s.push(bytes.subarray(cut));
    expect(lines).toEqual(['caméra prête']);
    s.end();
    s.end();
    expect(lines).toEqual(['caméra prête', 'second']);
  });

  it('cuts a line without a break, never inside a credential run', () => {
    const lines: string[] = [];
    const s = new tapLog.LineSplitter((l) => lines.push(l), { maxLineChars: 48 });
    const key = 'Zz9'.repeat(10); // 30 key characters
    s.push(`${'x '.repeat(15)}${key} tail`); // the key straddles character 48
    s.end();
    expect(lines.join('')).toBe(`${'x '.repeat(15)}${key} tail`);
    expect(lines.every((l) => l.length <= 48)).toBe(true);
    expect(lines.some((l) => l.includes(key))).toBe(true);
    expect(lines.map((l) => tapLog.redactCredentials(l)).join('')).not.toContain('Zz9');
  });
});

describe('tap.log file', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'copyholder-taplog-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('holds the lines before consent and writes them first when the folder opens', () => {
    const log = new tapLog.TapLog();
    log.line('before 1');
    log.line('before 2');
    expect(existsSync(join(dir, tapLog.TAP_LOG))).toBe(false);
    expect(log.open(dir)).toBe(true);
    log.line('after');
    log.close();
    log.line('after close');
    expect(readFileSync(join(dir, 'tap.log'), 'utf8')).toBe('before 1\nbefore 2\nafter\n');
  });

  it('says how many held lines went to the terminal only', () => {
    const log = new tapLog.TapLog({ maxHeldLines: 2, maxHeldChars: 1000 });
    for (const t of ['a', 'b', 'c', 'd']) log.line(t);
    log.open(dir);
    log.close();
    expect(readFileSync(join(dir, 'tap.log'), 'utf8')).toBe('a\nb\n[2 more lines from before consent went to the terminal only]\n');
  });

  it('writes nothing when the folder never opens (no consent)', () => {
    const log = new tapLog.TapLog();
    log.line('seen in the terminal only');
    log.close();
    expect(log.open(dir)).toBe(false);
    expect(existsSync(join(dir, 'tap.log'))).toBe(false);
  });
});

describe('tap_* events (spec 7.12 questions 1, 2, 4, 10)', () => {
  const lineOf = (m: unknown) => {
    const ev = tapEvents.tapEventOf(m);
    return ev === null ? null : { n: null, e: ev.e, by: 'host', ...ev.fields };
  };

  it('turns cameras, camera, readiness, probe and enums into valid event lines', () => {
    const lines = [
      lineOf({ t: 'cameras', list: [{ id: 'cam-id-0', name: 'FaceTime HD Camera' }, { id: 'cam-id-1' }] }),
      lineOf({ t: 'camera', id: 'cam-id-0', name: 'FaceTime HD Camera', requested: [1280, 720, 30], metrics: ['FACE_LANDMARKS'], dry: true }),
      lineOf({ t: 'readiness', verdict: null, reason: 'timeout' }),
      lineOf({
        t: 'probe', packet: 1, fields: ['breathing', 'face'], tsType: 'Long', tr: 1, talk: 1, frames: 1, points: 478,
        lipsY13BelowY14: true, cornersX78BelowX308: true, xRange: [512.5, 760.25], yRange: [250, 610], tsCbType: 'number',
      }),
      lineOf({ t: 'enums', checks: [{ label: 'ProcessingStatus', differences: [] }, { label: 'ValidationCode', differences: ['kTooDark=5'] }] }),
    ];
    expect(lines.map((l) => l?.e)).toEqual(tapEvents.TAP_EVENT_NAMES);
    for (const l of lines) expect(validateEventLine(l)).toEqual([]);
    expect(lines[0]).toEqual({ n: null, e: 'tap_cameras', by: 'host', list: [{ name: 'FaceTime HD Camera' }, { name: null }] });
    expect(lines[1]).toEqual({
      n: null, e: 'tap_camera', by: 'host', name: 'FaceTime HD Camera', requested: [1280, 720, 30], metrics: ['FACE_LANDMARKS'], dry: true,
    });
    expect(lines[2]).toEqual({ n: null, e: 'tap_readiness', by: 'host', verdict: null, reason: 'timeout' });
    // the probe keeps its point count under `ipc` and leaves the face's extent on the Mac (spec 12.5)
    expect(lines[3]).toEqual({
      n: null, e: 'tap_probe', by: 'host',
      ipc: {
        t: 'probe', packet: 1, fields: ['breathing', 'face'], tsType: 'Long', tr: 1, talk: 1, frames: 1, points: 478,
        lipsY13BelowY14: true, cornersX78BelowX308: true, tsCbType: 'number',
      },
    });
    expect(JSON.stringify(lines)).not.toContain('cam-id');
    expect(lines[4]).toEqual({
      n: null, e: 'tap_enums', by: 'host',
      checks: [{ label: 'ProcessingStatus', differences: [] }, { label: 'ValidationCode', differences: ['kTooDark=5'] }],
    });
  });

  it('marks dry only for tap\'s stand-in SDK and leaves other messages alone', () => {
    expect(tapEvents.tapEventOf({ t: 'camera', name: 'X', requested: [1280, 720, 30] })?.fields).not.toHaveProperty('dry');
    expect(tapEvents.tapEventOf({ t: 'camera', name: 'X', requested: [1280, 720], dry: 'yes' })?.fields)
      .toEqual({ name: 'X', requested: null, metrics: null });
    for (const t of ['ready', 'status', 'pulse', 'sdk_error', 'started', 'paused', 'stopped', 'replay_done']) {
      expect(tapEvents.tapEventOf({ t })).toBeNull();
    }
    expect(tapEvents.tapEventOf(null)).toBeNull();
  });

  it('copies camera.dry into manifest.json at the top level (spec 6.5)', () => {
    const r = {
      id: 'smoke-1', kind: 'smoke', startedUtc: null, git: { commit: null, treeClean: null }, planCommitment: null, sdk: null,
      machine: null, camera: { name: 'Dry camera', requested: [1280, 720, 30] }, outputGain: null, audioSummary: {}, mode: 'smoke',
      scenario: 'smoke', pack: null, plan: null, source: null, tapKind: 'real', state: 'closed', consentUtc: null, endedUtc: null,
      end: null, unusableReasons: [], pageLoads: 1, tapKilled: false, narratorNames: [], sealedServed: [], firstSealedN: null,
      calibFrom: { doctor: [], gate: null }, hello: null,
    };
    expect(manifestLib.buildManifest({ ...r, dry: true }, {})).toMatchObject({ tap: 'real', dry: true, camera: { name: 'Dry camera' } });
    expect(manifestLib.buildManifest(r, {})['dry']).toBe(false);
  });
});

describe('settings: port and devices', () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'copyholder-settings-'));
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('reads COPYHOLDER_PORT: empty is 47811, 0 lets the system pick, anything else is noted', () => {
    expect(settings.DEFAULT_PORT).toBe(47811);
    expect(settings.parsePort('')).toEqual({ port: 47811, note: null });
    expect(settings.parsePort(undefined)).toEqual({ port: 47811, note: null });
    expect(settings.parsePort(' 8080 ')).toEqual({ port: 8080, note: null });
    expect(settings.parsePort('0')).toEqual({ port: 0, note: null });
    expect(settings.parsePort('65535')).toEqual({ port: 65535, note: null });
    for (const bad of ['65536', '-1', '1e3', '80.5', 'http']) {
      expect(settings.parsePort(bad)).toEqual({ port: 47811, note: `COPYHOLDER_PORT=${bad} is not a port number (0-65535); using 47811.` });
    }
    expect(settings.PORT_FALLBACK_CODES).toContain('EADDRINUSE');
    writeFileSync(join(root, 'settings.env'), 'COPYHOLDER_PORT=50123\n');
    expect(settings.portSetting({}, root)).toEqual({ port: 50123, note: null });
    expect(settings.portSetting({ COPYHOLDER_PORT: '0' }, root)).toEqual({ port: 0, note: null }); // the environment wins
  });

  it('gives /api/config devices from COPYHOLDER_MIC_NAME and COPYHOLDER_OUTPUT_NAME', () => {
    expect(settings.deviceSettings({}, root)).toEqual({});
    writeFileSync(join(root, 'settings.env'), '# devices\nCOPYHOLDER_MIC_NAME=External Microphone\nCOPYHOLDER_OUTPUT_NAME=\n');
    expect(settings.deviceSettings({}, root)).toEqual({ input: 'External Microphone' });
    expect(settings.deviceSettings({ COPYHOLDER_MIC_NAME: '', COPYHOLDER_OUTPUT_NAME: '  External Headphones ' }, root))
      .toEqual({ output: 'External Headphones' });
  });

  it('reads settings.env with tap\'s own parser, so an inline # note is no part of a value (spec 7.1, 13.6)', () => {
    expect(repoInfo.parseEnvText).toBe(reduce.parseEnvText);
    writeFileSync(join(root, 'settings.env'), [
      'COPYHOLDER_CAMERA_NAME="FaceTime HD Camera" # built-in',
      'COPYHOLDER_MIC_NAME=External Microphone # the USB one',
      'COPYHOLDER_OUTPUT_NAME=Mac#2 Speakers',
      'export COPYHOLDER_PORT=47900   # free on this Mac',
      '',
    ].join('\n'));
    expect(settings.deviceSettings({}, root)).toEqual({ input: 'External Microphone', output: 'Mac#2 Speakers' });
    expect(settings.portSetting({}, root)).toEqual({ port: 47900, note: null });
    expect(repoInfo.hostSetting({}, root, 'COPYHOLDER_CAMERA_NAME')).toBe('FaceTime HD Camera');
    expect(repoInfo.hostSetting({ COPYHOLDER_CAMERA_NAME: '' }, root, 'COPYHOLDER_CAMERA_NAME')).toBe(''); // as tap: env wins
    expect(repoInfo.hostSetting({}, root, 'COPYHOLDER_METRICS')).toBe('');
  });
});

describe('SDK error text by call (spec 7.1 table)', () => {
  it('names the camera request for code 3 from useCamera() or CameraSelection, else the metric set', () => {
    expect(codes.isCameraCall('useCamera()')).toBe(true);
    expect(codes.isCameraCall('CameraSelection.byId()')).toBe(true);
    expect(codes.isCameraCall('start()')).toBe(false);
    expect(codes.isCameraCall(null)).toBe(false);
    const camera = 'The SDK refused the camera request (kConfigurationFailed): the camera selection or its 1280x720, 30 fps format. Check COPYHOLDER_CAMERA_NAME in settings.env.';
    expect(codes.sdkErrorText(3, 'kConfigurationFailed', { call: 'useCamera()' })).toBe(camera);
    // spec 7.1: the same code from useCamera() gets the same action, so smoke still names the spare set
    expect(codes.sdkErrorText(3, 'kConfigurationFailed', { smoke: true, call: 'useCamera()' })).toBe(
      `${camera} If the name is right, put COPYHOLDER_METRICS=spare in settings.env and run smoke again.`,
    );
    expect(codes.sdkErrorText(3, null, { call: 'CameraSelection.byId()' })).toMatch(/^The SDK refused the camera request \(kConfigurationFailed\)/);
    for (const call of ['start()', 'new SmartSpectraSDK()', null, undefined]) {
      expect(codes.sdkErrorText(3, 'kConfigurationFailed', { smoke: true, call })).toBe(
        'The SDK did not accept the requested metrics (kConfigurationFailed). Put COPYHOLDER_METRICS=spare in settings.env and run smoke again.',
      );
    }
    expect(codes.sdkErrorText(13, 'kMetricNotAuthorized', { call: 'useCamera()' })).toBe('The SDK did not accept the requested metrics (kMetricNotAuthorized).');
  });

  it('tells camera failures, which get the Electron step in smoke (spec 6.7, 7.12 question 1), from the rest', () => {
    expect(codes.ELECTRON_HINT).toBe('If the camera does not open in plain Node, run it again with: npm run live:electron -- smoke (spec 6.7).');
    const camera: [number | null, string | null][] = [
      [7, null], [7, 'start()'], [7, 'useCamera()'], [3, 'useCamera()'], [3, 'CameraSelection.byId()'],
      [null, 'useCamera()'], [null, 'CameraSelection.byId()'], [null, 'SmartSpectraSDK.availableCameras()'], [null, 'start()'],
    ];
    for (const [code, call] of camera) expect(codes.isCameraFailure(code, call), `${code} ${call}`).toBe(true);
    const other: [number | null, string | null][] = [
      [2, 'tap'], [3, 'start()'], [3, null], [13, 'useCamera()'], [4, 'start()'], [5, null], [8, 'start()'], [14, null],
      [null, null], [null, 'tap'], [null, 'new SmartSpectraSDK()'], [null, 'decodeMetrics()'], [null, 'reset()'], [null, 'stopAsync()'],
    ];
    for (const [code, call] of other) expect(codes.isCameraFailure(code, call), `${code} ${call}`).toBe(false);
  });
});

describe('quickcheck process group helpers', () => {
  it('words the timeout', () => {
    expect(host.durationText(10 * 60_000)).toBe('10 minutes');
    expect(host.durationText(60_000)).toBe('1 minute');
    expect(host.durationText(1500)).toBe('2 seconds');
    expect(host.durationText(1000)).toBe('1 second');
  });

  it('ends every process of a detached child\'s group, and says false once it is gone', async () => {
    if (process.platform === 'win32') return;
    // the child starts a grandchild in its own group, prints its pid, and both wait
    const child = spawn(process.execPath, ['-e', [
      "const { spawn } = require('node:child_process');",
      "const g = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });",
      'console.log(g.pid);',
      'setInterval(() => {}, 1000);',
    ].join('\n')], { detached: true, stdio: ['ignore', 'pipe', 'ignore'] });
    let out = '';
    child.stdout.on('data', (d: Buffer) => {
      out += d.toString();
    });
    await waitUntil(() => /\d+\n/.test(out));
    const grandchild = Number(out.trim());
    const exited = new Promise((resolve) => child.once('exit', resolve));
    try {
      expect(host.killGroup(child, 'SIGKILL')).toBe(true);
      await exited;
      await waitUntil(() => !processRunning(grandchild), 5000);
    } finally {
      if (processRunning(grandchild)) process.kill(grandchild, 'SIGKILL');
    }
    // a group whose only process ended and was reaped: nothing to signal
    const done = spawn(process.execPath, ['-e', ''], { detached: true, stdio: 'ignore' });
    await new Promise((resolve) => done.once('exit', resolve));
    expect(host.killGroup(done, 'SIGKILL')).toBe(false);
    expect(host.killGroup(null, 'SIGKILL')).toBe(false);
    expect(host.killGroup({}, 'SIGKILL')).toBe(false);
  });

  /**
   * A detached child like doctor's quickcheck: it starts a helper in a group of its own (analysis/lib/tts.ts) and
   * ends that group only in its SIGTERM handler, so a SIGKILL to the child's group alone would leave the helper.
   */
  async function childWithOwnGroupHelper() {
    const child = spawn(process.execPath, ['-e', [
      "const { spawn } = require('node:child_process');",
      "const g = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore', detached: true });",
      "process.on('SIGTERM', () => { try { if (g.pid) process.kill(-g.pid, 'SIGKILL'); } catch {} process.exit(143); });",
      'console.log(g.pid);',
      'setInterval(() => {}, 1000);',
    ].join('\n')], { detached: true, stdio: ['ignore', 'pipe', 'ignore'] });
    let out = '';
    child.stdout.on('data', (d: Buffer) => {
      out += d.toString();
    });
    await waitUntil(() => /\d+\n/.test(out));
    return { child, helper: Number(out.trim()) };
  }

  it('stops a group with SIGTERM first, so the group\'s own handlers end what they started (stopGroup)', async () => {
    if (process.platform === 'win32') return;
    const { child, helper } = await childWithOwnGroupHelper();
    const exited = new Promise((resolve) => child.once('exit', (code, signal) => resolve({ code, signal })));
    let after = 0;
    try {
      host.stopGroup(child, 300, () => {
        after += 1;
      });
      expect(await exited).toEqual({ code: 143, signal: null }); // its SIGTERM handler ran
      await waitUntil(() => !processRunning(helper), 5000);
      await waitUntil(() => after === 1, 2000); // after the SIGKILL that follows
    } finally {
      if (processRunning(helper)) process.kill(helper, 'SIGKILL');
    }
    host.stopGroup(child, 300, () => {
      after += 1;
    });
    expect(after).toBe(2); // the group is gone: `after` at once
  });

  it('does the same while host exits, without a timer (stopGroupSync)', async () => {
    if (process.platform === 'win32') return;
    const { child, helper } = await childWithOwnGroupHelper();
    const exited = new Promise((resolve) => child.once('exit', (code, signal) => resolve({ code, signal })));
    try {
      const t0 = Date.now();
      host.stopGroupSync(child, 700);
      expect(Date.now() - t0).toBeLessThan(3000);
      expect(await exited).toEqual({ code: 143, signal: null });
      await waitUntil(() => !processRunning(helper), 5000);
    } finally {
      if (processRunning(helper)) process.kill(helper, 'SIGKILL');
    }
    expect(host.killGroup(child, 0)).toBe(false);
    host.stopGroupSync(null, 700); // nothing to stop
  });
});
