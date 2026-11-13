import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { createRequire } from 'node:module';
import { fork } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import WebSocket from 'ws';
import { validateSampleLine, validateSdkRawLine } from '../../core/schemas/index.ts';

// live/ is CommonJS outside tsconfig; load it as tap.cjs does (spec 7.1: reduce has no SDK import).
const require = createRequire(import.meta.url);
const LIVE = join(import.meta.dirname, '..', '..', 'live');
const TAP = join(LIVE, 'tap.cjs');

type XY = [number, number];
type Pair = [number, number];
type Line = Record<string, unknown>;
interface Lm { ts: number; reset: 0 | 1; p: (XY | null)[] }
interface MLine {
  seq: number; k: 'm'; tArrNs: string; tsCbUs: number; tr: Pair[]; talk: Pair[];
  g: number | null; hm: number | null; lm: Lm | null;
}
interface Probe {
  fields: string[]; tsType: string; tr: number; talk: number; frames: number; points: number;
  lipsY13BelowY14: boolean | null; cornersX78BelowX308: boolean | null;
}
interface ReduceModule {
  LANDMARKS: readonly number[];
  VALIDATION_NAMES: Record<number, string>;
  KEY_HINT: string;
  DRY_API: Record<string, unknown>;
  toUs(t: unknown): number;
  initialState(): object;
  breakTrack(state: object): object;
  reduce(state: object, msg: unknown, meta: { seq: number; tArrNs: bigint | string; tsCbUs: unknown }): { state: object; line: MLine };
  eventRecord(kind: string, seq: number, tArrNs: bigint, tWallMs: number, args: unknown[]): { raw: string; line: Line };
  errorHint(code: number, from: string | null, smoke: boolean): string | null;
  sdkOptions(sdkModule: unknown, o: { apiKey: string; spare: boolean; smoke: boolean }): Record<string, unknown>;
  enumChecks(sdkModule: unknown): { label: string; differences: string[] }[];
  dryOptions(args: string[]): Record<string, unknown>;
  stopBudget(envText: string | undefined, totalMs: number): { stopAsyncMs: number; filesMs: number; destroyMs: number };
  agoMs(nowNs: bigint, thenNs: bigint | null): number | null;
  validationLine(seq: number, tArrNs: bigint, tsCbUs: unknown, code: number, hint?: string): Line;
  processingLine(seq: number, tArrNs: bigint, code: number): Line;
  frameLine(seq: number, tArrNs: bigint, tsCbUs: unknown, sent: boolean): Line;
  errorLine(seq: number, tArrNs: bigint, code: number, message: string, retryable: boolean): Line;
  rawLine(seq: number, kind: string, tArrNs: bigint, tWallMs: number, body: Record<string, unknown>): string;
  errorAction(code: number, canRestart: boolean): string;
  errorCodeOf(e: unknown): number | null;
  loopStats(h: { count: number; max: number; percentile(p: number): number }, resolutionMs: number): Record<string, number | null>;
  enumMismatches(table: Record<number, string>, sdkEnum: unknown): string[];
  pickCamera<T extends { name: string | null }>(cams: T[], want: string): T | undefined;
  parseEnvText(text: string): Record<string, string>;
  probeMetrics(msg: unknown): Probe;
  longLike(n: number): { toNumber(): number };
  syntheticMetrics(i: number, t0Us: number): unknown;
}
const R = require(join(LIVE, 'reduce.cjs')) as ReduceModule;
const E = require(join(LIVE, 'electron', 'command.cjs')) as {
  resolveCommand(argv: string[], scripts: Record<string, string> | undefined, root: string): {
    before: string[]; file: string; args: string[];
  };
  isHostPage(url: string): boolean;
};

/** Stand-in for the protobufjs Long that decodeMetrics returns for int64 fields. */
class Long {
  constructor(readonly low: number, readonly high: number, readonly unsigned = false) {}
  static fromNumber(n: number): Long {
    const high = Math.floor(n / 4294967296);
    return new Long((n - high * 4294967296) | 0, high);
  }
  toNumber(): number { return this.high * 4294967296 + (this.low >>> 0); }
}

const T0 = 1_794_935_111_123_456; // µs since the epoch, as in the spec 8.1 example
const STEP = 31_250; // 1/32 s: frame times stay exact in binary
type Frame = { ts: number; pts: { x: number; y: number }[]; reset?: boolean };

/** Decoded-packet shape that reduce.cjs reads (protobufjs camelCase, Long timestamps). */
function packet(p: { tr?: Pair[]; talk?: [number, boolean][]; frames?: Frame[] }): unknown {
  return {
    breathing: { upperTrace: (p.tr ?? []).map(([ts, value]) => ({ value, stable: false, timestamp: Long.fromNumber(ts) })) },
    face: {
      talking: (p.talk ?? []).map(([ts, detected]) => ({ detected, stable: false, timestamp: Long.fromNumber(ts) })),
      landmarks: (p.frames ?? []).map((f) => ({ value: f.pts, stable: true, reset: f.reset ?? false, timestamp: Long.fromNumber(f.ts) })),
    },
  };
}

/** 478 points at (0, 0) except the ones given. */
function mesh(set: Record<number, XY>): { x: number; y: number }[] {
  const pts = Array.from({ length: 478 }, () => ({ x: 0, y: 0 }));
  for (const [i, [x, y]] of Object.entries(set)) pts[Number(i)] = { x, y };
  return pts;
}

/** Runs reduce over packets in order, threading the state. */
function run(packets: unknown[]): MLine[] {
  let state = R.initialState();
  return packets.map((msg, i) => {
    const out = R.reduce(state, msg, { seq: i + 1, tArrNs: 812_345_678_901_234n + BigInt(i), tsCbUs: Long.fromNumber(T0 + i * STEP) });
    state = out.state;
    return out.line;
  });
}

// Eye corners 33 and 263 are 128 px apart. Lower-minus-upper lip gaps: 4, 1, 10, 2, 9 px.
// Median 4 (mean 5.2), so g = 4 / 128 = 0.03125 exactly (spec 7.5).
const LIPS: Record<number, XY> = {
  33: [500, 400], 263: [628, 400],
  13: [640, 600], 14: [640, 604],
  82: [630, 600], 87: [630, 601],
  312: [650, 600], 317: [650, 610],
  81: [620, 600], 178: [620, 602],
  311: [660, 600], 402: [660, 609],
};

function deepFreeze<T>(o: T): T {
  if (o !== null && typeof o === 'object' && !Object.isFrozen(o)) {
    Object.freeze(o);
    for (const v of Object.values(o)) deepFreeze(v);
  }
  return o;
}

describe('reduce (spec 7.1, 8.1)', () => {
  it('converts number, Long and bigint time fields with one function', () => {
    fc.assert(fc.property(fc.maxSafeNat(), (n) => {
      expect(R.toUs(Long.fromNumber(n))).toBe(n);
      expect(R.toUs(R.longLike(n))).toBe(n);
      expect(R.toUs(BigInt(n))).toBe(n);
      expect(R.toUs(n)).toBe(n);
    }));
    expect(R.toUs(undefined)).toBeNaN();
  });

  it('builds the m line of spec 8.1 from a packet with Long timestamps', () => {
    const msg = packet({ tr: [[T0, -0.4000000059604645]], talk: [[T0, false]], frames: [{ ts: T0, pts: mesh(LIPS) }] });
    const { line } = R.reduce(R.initialState(), msg, { seq: 5417, tArrNs: 812_345_678_901_234n, tsCbUs: Long.fromNumber(1_794_935_111_156_789) });
    expect(Object.keys(line)).toEqual(['seq', 'k', 'tArrNs', 'tsCbUs', 'tr', 'talk', 'g', 'hm', 'lm']);
    expect(line).toMatchObject({
      seq: 5417, k: 'm', tArrNs: '812345678901234', tsCbUs: 1_794_935_111_156_789,
      tr: [[T0, -0.4000000059604645]], talk: [[T0, 0]], g: 0.03125, hm: null,
    });
    expect(line.lm).toMatchObject({ ts: T0, reset: 0 });
    expect(line.lm?.p).toHaveLength(16);
    // JSON.stringify without rounding reads back to the same numbers (spec 8.1).
    expect(JSON.parse(JSON.stringify(line))).toEqual(line);
  });

  it('keeps the 16 points in the spec order', () => {
    expect(R.LANDMARKS).toEqual([13, 14, 82, 87, 312, 317, 81, 178, 311, 402, 78, 308, 33, 263, 133, 362]);
    const pts = Array.from({ length: 478 }, (_, i) => ({ x: i + 0.25, y: 1000 + i }));
    const [line] = run([packet({ frames: [{ ts: T0, pts }] })]);
    expect(line?.lm?.p).toEqual(R.LANDMARKS.map((i) => [i + 0.25, 1000 + i]));
  });

  it('drops samples and frames whose ts is not after the last accepted one', () => {
    const lines = run([
      packet({ tr: [[T0, 0.1], [T0 + 33_333, 0.2], [T0 + 66_667, 0.3]], talk: [[T0, false]], frames: [{ ts: T0, pts: mesh(LIPS) }] }),
      packet({ tr: [[T0 + 33_333, 0.2], [T0 + 66_667, 0.3], [T0 + 100_000, 0.4]], talk: [[T0, false], [T0 + 100_000, true]], frames: [{ ts: T0, pts: mesh(LIPS) }] }),
      packet({ tr: [[T0 + 100_000, 0.4]] }),
      packet({ tr: [[T0 + 200_000, 0.6], [T0 + 150_000, 0.5], [T0 + 233_333, 0.7]] }),
    ]);
    expect(lines.map((l) => l.tr)).toEqual([
      [[T0, 0.1], [T0 + 33_333, 0.2], [T0 + 66_667, 0.3]],
      [[T0 + 100_000, 0.4]],
      [],
      [[T0 + 200_000, 0.6], [T0 + 233_333, 0.7]],
    ]);
    expect(lines.map((l) => l.talk)).toEqual([[[T0, 0]], [[T0 + 100_000, 1]], [], []]);
    expect(lines.map((l) => l.lm?.ts ?? null)).toEqual([T0, null, null, null]);
    expect(lines.map((l) => l.g)).toEqual([0.03125, null, null, null]);
    expect(lines.map((l) => l.seq)).toEqual([1, 2, 3, 4]); // one line per call, even when empty
  });

  it('g is the median lip gap over the 33-263 distance', () => {
    const [flat] = run([packet({ frames: [{ ts: T0, pts: mesh(LIPS) }] })]);
    expect(flat?.g).toBe(0.03125);
    // Tilted eye line: 96 px across and 72 px down is 120 px.
    const [tilted] = run([packet({ frames: [{ ts: T0, pts: mesh({ ...LIPS, 263: [596, 472] }) }] })]);
    expect(tilted?.g).toBe(4 / 120);
    // A missing lip point or a zero eye distance gives null, not a number.
    const [noScale] = run([packet({ frames: [{ ts: T0, pts: mesh({ ...LIPS, 263: [500, 400] }) }] })]);
    expect(noScale?.g).toBeNull();
    const [short] = run([packet({ frames: [{ ts: T0, pts: mesh(LIPS).slice(0, 100) }] })]);
    expect(short?.g).toBeNull();
  });

  it('hm is the nose-tip speed by least squares over 5 frames over the 33-263 distance', () => {
    // Point 1 moves 30 px/s right and 40 px/s down: 50 px/s; eyes 100 px apart: hm = 0.5 per second.
    const frames = Array.from({ length: 7 }, (_, i) => ({
      ts: T0 + i * STEP,
      pts: mesh({ 33: [590, 300], 263: [690, 300], 1: [640 + (30 * i) / 32, 360 + (40 * i) / 32] }),
    }));
    const lines = run(frames.map((f) => packet({ frames: [f] })));
    expect(lines.map((l) => l.hm)).toEqual([null, null, null, null, 0.5, 0.5, 0.5]);
    // Point 1 is not among the 16 written points: hm comes from the full mesh (spec 7.1).
    expect(R.LANDMARKS).not.toContain(1);
  });

  it('hm is a least-squares slope over all 5 frames, not the end points', () => {
    // Point 1 at x = 0, 0, 0, 0, 8 px every 1/32 s; eyes 128 px apart. Least squares: 51.2 px/s, hm = 0.4.
    // The end points alone would give 8 px in 1/8 s = 64 px/s, hm = 0.5.
    const xs = [0, 0, 0, 0, 8];
    const lines = run(xs.map((x, i) => packet({ frames: [{ ts: T0 + i * STEP, pts: mesh({ 33: [500, 400], 263: [628, 400], 1: [x, 300] }) }] })));
    expect(lines.map((l) => l.hm)).toEqual([null, null, null, null, 0.4]);
  });

  it('a packet with several frames: lm, g and hm from the last, reset from any, every frame feeds the track', () => {
    // Point 1 moves 4 px per 1/32 s frame: 128 px/s; eyes 128 px apart: hm = 1.
    const frame = (i: number, reset = false): Frame => ({ ts: T0 + i * STEP, reset, pts: mesh({ ...LIPS, 1: [640 + 4 * i, 360] }) });
    const lines = run([packet({ frames: [frame(0, true), frame(1)] }), ...[2, 3, 4].map((i) => packet({ frames: [frame(i)] }))]);
    expect(lines[0]).toMatchObject({ g: null, hm: null, lm: { ts: T0 + STEP, reset: 1 } });
    expect(lines.map((l) => l.lm?.reset)).toEqual([1, 0, 0, 0]);
    expect(lines.map((l) => l.g)).toEqual([null, 0.03125, 0.03125, 0.03125]);
    expect(lines.map((l) => l.hm)).toEqual([null, null, null, 1]); // frames 0-4: the reset frame starts the track
  });

  it('a newest frame without point 1 has no hm; the track goes on with the next frame', () => {
    const lines = run([0, 1, 2, 3, 4, 5].map((i) => packet({ frames: [{
      ts: T0 + i * STEP,
      pts: mesh({ ...LIPS, 1: i === 4 ? [Number.NaN, Number.NaN] : [640 + 4 * i, 360] }),
    }] })));
    expect(lines[4]).toMatchObject({ g: 0.03125, hm: null });
    expect(lines[3]?.hm).toBeNull(); // only 4 frames so far
    expect(lines[5]?.hm).toBeCloseTo(1, 12); // frames 0, 1, 2, 3, 5: the same 128 px/s
  });

  it('breakTrack (a start() after a pause) starts a new nose track and keeps the duplicate rule', () => {
    const frame = (i: number): Frame => ({ ts: T0 + i * STEP, pts: mesh({ ...LIPS, 1: [640 + 4 * i, 360] }) });
    let state = R.initialState();
    for (let i = 0; i < 5; i++) state = R.reduce(state, packet({ frames: [frame(i)], tr: [[T0 + i * STEP, i]] }), { seq: i, tArrNs: 1n, tsCbUs: T0 }).state;
    state = R.breakTrack(state);
    const { line } = R.reduce(state, packet({ frames: [frame(40)], tr: [[T0 + 4 * STEP, 9], [T0 + 40 * STEP, 1]] }), { seq: 9, tArrNs: 1n, tsCbUs: T0 });
    expect(line).toMatchObject({ hm: null, g: 0.03125, tr: [[T0 + 40 * STEP, 1]] });
  });

  it('reset frames write null g and hm, and the nose track restarts at the reset frame', () => {
    // Point 1 moves 32 px/s; eyes 128 px apart: hm = 0.25.
    const frames = Array.from({ length: 10 }, (_, i) => ({ ts: T0 + i * STEP, reset: i === 5, pts: mesh({ ...LIPS, 1: [640 + i, 360] }) }));
    const lines = run(frames.map((f) => packet({ frames: [f] })));
    expect(lines.map((l) => l.lm?.reset)).toEqual([0, 0, 0, 0, 0, 1, 0, 0, 0, 0]);
    expect(lines.map((l) => l.g)).toEqual([0.03125, 0.03125, 0.03125, 0.03125, 0.03125, null, 0.03125, 0.03125, 0.03125, 0.03125]);
    expect(lines.map((l) => l.hm)).toEqual([null, null, null, null, 0.25, null, null, null, null, 0.25]);
    expect(lines[5]?.lm?.p).toHaveLength(16); // the points are still written
  });

  it('is pure: frozen state and packets, same answers on a second run', () => {
    const msgs = Array.from({ length: 8 }, (_, i) => deepFreeze(packet({
      tr: [[T0 + i * STEP, i / 10]], talk: [[T0 + i * STEP, i % 2 === 0]],
      frames: [{ ts: T0 + i * STEP, pts: mesh({ ...LIPS, 1: [640 + i, 360 - i] }) }],
    })));
    const once = (): MLine[] => {
      let state = deepFreeze(R.initialState());
      return msgs.map((msg, i) => {
        const out = R.reduce(state, msg, { seq: i, tArrNs: BigInt(i), tsCbUs: T0 });
        state = deepFreeze(out.state);
        return out.line;
      });
    };
    expect(once()).toEqual(once());
  });

  it('accepts the synthetic packets of --dry and probes them like smoke does', () => {
    const t0 = 1_794_935_111_000_000;
    const msgs = Array.from({ length: 102 }, (_, i) => R.syntheticMetrics(i, t0));
    const lines = run(msgs);
    const ts = lines.flatMap((l) => l.tr.map(([t]) => t));
    expect(ts).toHaveLength(102); // packet 100 repeats sample 99: dropped
    expect(ts.every((t, i) => i === 0 || t > (ts[i - 1] ?? Infinity))).toBe(true);
    expect(lines[0]).toMatchObject({ g: null, hm: null, lm: { reset: 1 } });
    expect(lines.slice(1).every((l) => typeof l.g === 'number' && l.g > 0)).toBe(true);
    expect(lines.slice(5).every((l) => typeof l.hm === 'number')).toBe(true);
    expect(R.probeMetrics(msgs[1])).toMatchObject({
      fields: ['breathing', 'face'], tsType: 'Long', tr: 1, talk: 1, frames: 1, points: 478,
      lipsY13BelowY14: true, cornersX78BelowX308: true,
    });
    expect(R.probeMetrics({})).toMatchObject({ points: 0, tsType: 'undefined', lipsY13BelowY14: null });
  });
});

describe('tap helpers (spec 7.1)', () => {
  it('maps every SDK error code to the action of the table', () => {
    expect(R.errorAction(2, true)).toBe('exit_key');
    expect(R.errorAction(3, true)).toBe('exit_metrics');
    expect(R.errorAction(13, false)).toBe('exit_metrics');
    expect(R.errorAction(7, true)).toBe('exit_cameras');
    expect(R.errorAction(8, true)).toBe('reset_restart');
    expect(R.errorAction(8, false)).toBe('abort');
    for (const code of [4, 5, 6, 14, 1, 9, 10, 11, 99]) expect(R.errorAction(code, true)).toBe('abort');
  });

  it('turns event-loop timer intervals into delays for the l line (interval minus the 10 ms period)', () => {
    const h = { count: 100, max: 25_000_000, percentile: (p: number) => (p === 50 ? 10_100_000 : 12_345_678) };
    expect(R.loopStats(h, 10)).toEqual({ p50Ms: 0.1, p99Ms: 2.346, maxMs: 15, n: 100 });
    expect(R.loopStats({ count: 0, max: 0, percentile: () => 0 }, 10)).toEqual({ p50Ms: null, p99Ms: null, maxMs: null, n: 0 });
  });

  it('reads the SDK code of an exception as a number or a name', () => {
    expect(R.errorCodeOf(Object.assign(new Error('x'), { code: 7 }))).toBe(7);
    expect(R.errorCodeOf({ code: 'kInputUnavailable' })).toBe(7);
    expect(R.errorCodeOf({ code: 'kAuthenticationFailed' })).toBe(2);
    expect(R.errorCodeOf({ code: 'MODULE_NOT_FOUND' })).toBeNull();
    expect(R.errorCodeOf(new Error('plain'))).toBeNull();
    expect(R.errorCodeOf(undefined)).toBeNull();
  });

  it('writes sdk_raw lines in the spec 8.1 shape, bigint and Long as numbers', () => {
    const metrics = JSON.parse(R.rawLine(5417, 'metrics', 812_345_678_901_234n, 1_794_935_111_190, {
      tsCbUs: 1_794_935_111_156_789, b64: Buffer.from([1, 2, 3]).toString('base64'),
    })) as Line;
    expect(Object.keys(metrics)).toEqual(['seq', 'kind', 'tArrNs', 'tWallMs', 'tsCbUs', 'b64']);
    expect(metrics).toEqual({
      seq: 5417, kind: 'metrics', tArrNs: '812345678901234', tWallMs: 1_794_935_111_190, tsCbUs: 1_794_935_111_156_789, b64: 'AQID',
    });
    const v = JSON.parse(R.rawLine(1, 'validationStatus', 2n, 3, { tsCbUs: T0, args: [0, Long.fromNumber(T0), 7n, 'hint'] })) as Line;
    expect(v.args).toEqual([0, T0, '7', 'hint']);
    for (const line of [metrics, v]) expect(validateSdkRawLine(line)).toEqual([]);
  });

  it('writes v, s, f and e lines with names', () => {
    expect(R.validationLine(7, 5n, Long.fromNumber(T0), 1, 'Face not found')).toEqual({
      seq: 7, k: 'v', tArrNs: '5', tsCbUs: T0, code: 1, name: 'kNoFaceFound', hint: 'Face not found',
    });
    expect(R.processingLine(8, 6n, 3)).toEqual({ seq: 8, k: 's', tArrNs: '6', code: 3, name: 'kRunning' });
    expect(R.frameLine(9, 7n, T0, false)).toEqual({ seq: 9, k: 'f', tArrNs: '7', tsCbUs: T0, sent: false });
    expect(R.errorLine(10, 8n, 4, 'no credits', false)).toEqual({
      seq: 10, k: 'e', tArrNs: '8', code: 4, name: 'kCreditExhausted', message: 'no credits', retryable: false,
    });
    expect(R.validationLine(1, 1n, T0, 42).name).toBe('code_42');
    expect(R.enumMismatches({ 0: 'kOk', 1: 'kNoFaceFound' }, { kOk: 0, kNoFaceFound: 1, kExtra: 9 })).toEqual([]);
    expect(R.enumMismatches(R.VALIDATION_NAMES, { kOk: 0 })).toContain('kNoFaceFound=1');
  });

  it('picks the camera by name, or the only one', () => {
    const cams = [{ id: 'a', name: 'FaceTime HD Camera' }, { id: 'b', name: 'Logitech BRIO' }, { id: 'c', name: null }];
    expect(R.pickCamera(cams, 'BRIO')?.id).toBe('b');
    expect(R.pickCamera(cams, 'Nope')).toBeUndefined();
    expect(R.pickCamera(cams, '')).toBeUndefined();
    expect(R.pickCamera(cams.slice(1, 2), '')?.id).toBe('b');
  });

  it('parses .env and settings.env without dotenv', () => {
    const text = '﻿# comment\r\nSMARTSPECTRA_API_KEY=abc123\r\nexport COPYHOLDER_CAMERA_NAME="Logitech BRIO"\n'
      + 'COPYHOLDER_METRICS=   # empty\nQUOTED=\'a # b\'\nTRAILING=x # note\nnot a line\nHASH=a#b\n';
    expect(R.parseEnvText(text)).toEqual({
      SMARTSPECTRA_API_KEY: 'abc123', COPYHOLDER_CAMERA_NAME: 'Logitech BRIO', COPYHOLDER_METRICS: '',
      QUOTED: 'a # b', TRAILING: 'x', HASH: 'a#b',
    });
    // A quoted value with a comment after it loses its quotes too (a camera name has spaces, so it gets quoted).
    expect(R.parseEnvText('COPYHOLDER_CAMERA_NAME="FaceTime HD Camera" # built-in\nK=\'k1\'   #x\n')).toEqual({
      COPYHOLDER_CAMERA_NAME: 'FaceTime HD Camera', K: 'k1',
    });
  });

  it('advises by the call: code 3 from the camera selection names the camera first, the spare set after in smoke', () => {
    const camera = 'the camera selection or its capture options (1280x720, 30 fps) were refused: check COPYHOLDER_CAMERA_NAME';
    const next = `${camera}; if the name is right, set COPYHOLDER_METRICS=spare in settings.env`;
    expect(R.errorHint(3, 'useCamera()', true)).toBe(next);
    expect(R.errorHint(3, 'CameraSelection.byId()', true)).toBe(next);
    expect(R.errorHint(3, 'useCamera()', false)).toBe(camera);
    expect(R.errorHint(3, 'CameraSelection.byId()', false)).toBe(camera); // outside smoke the spare set is no step (spec 7.1)
    expect(R.errorHint(3, null, true)).toBe('metrics refused: set COPYHOLDER_METRICS=spare in settings.env');
    expect(R.errorHint(13, 'start()', true)).toMatch(/COPYHOLDER_METRICS=spare/);
    expect(R.errorHint(3, 'start()', false)).toBeNull(); // the spare set is a smoke step (spec 7.1)
    expect(R.errorHint(4, null, true)).toBeNull();
    expect(R.KEY_HINT).toBe('Check SMARTSPECTRA_API_KEY in .env');
  });

  it("gives the next step host's text gives for code 3 from the camera request (live/lib/sdk-codes.cjs)", () => {
    const host = require(join(LIVE, 'lib', 'sdk-codes.cjs')) as {
      sdkErrorText(code: number, name: string | null, o: { smoke?: boolean; call?: string | null }): string;
    };
    for (const call of ['useCamera()', 'CameraSelection.byId()']) {
      for (const smoke of [true, false]) {
        const steps = (text: string) => ['COPYHOLDER_CAMERA_NAME', 'COPYHOLDER_METRICS=spare'].filter((s) => text.includes(s));
        expect(steps(R.errorHint(3, call, smoke)!)).toEqual(steps(host.sdkErrorText(3, null, { smoke, call })));
      }
    }
  });

  it('builds the raw and samples lines of the events without a buffer', () => {
    const rec = (kind: string, args: unknown[]) => R.eventRecord(kind, 3, 9n, 1_794_935_111_190, args);
    const v = rec('validationStatus', [1, Long.fromNumber(T0), 'Face not found']);
    expect(v.line).toEqual({ seq: 3, k: 'v', tArrNs: '9', tsCbUs: T0, code: 1, name: 'kNoFaceFound', hint: 'Face not found' });
    expect(JSON.parse(v.raw)).toEqual({ seq: 3, kind: 'validationStatus', tArrNs: '9', tWallMs: 1_794_935_111_190, tsCbUs: T0, args: [1, T0, 'Face not found'] });
    expect(rec('processingStatus', [5]).line).toMatchObject({ k: 's', code: 5, name: 'kError' });
    expect(JSON.parse(rec('processingStatus', [5]).raw)).not.toHaveProperty('tsCbUs');
    expect(rec('frameSentThrough', [false, T0]).line).toEqual({ seq: 3, k: 'f', tArrNs: '9', tsCbUs: T0, sent: false });
    expect(rec('error', [8, 'boom', true]).line).toMatchObject({ k: 'e', code: 8, name: 'kProcessingFailed', retryable: true });
    for (const kind of ['validationStatus', 'processingStatus', 'frameSentThrough', 'error']) {
      const r = rec(kind, kind === 'error' ? [4, 'x', false] : [0, T0, '']);
      expect(validateSampleLine(r.line)).toEqual([]);
      expect(validateSdkRawLine(JSON.parse(r.raw))).toEqual([]);
    }
  });

  it('builds the SDK options of spec 7.1: kInfo only in smoke, the spare set on request', () => {
    expect(R.sdkOptions(R.DRY_API, { apiKey: 'k', spare: false, smoke: false })).toEqual({
      apiKey: 'k', requestedMetrics: [0, 2, 11, 13], enableTelemetry: false, enableAccumulatedOutput: false,
    });
    expect(R.sdkOptions(R.DRY_API, { apiKey: 'k', spare: true, smoke: true })).toMatchObject({ requestedMetrics: [0, 1, 2, 11, 13], logLevel: 1 });
    expect(() => R.sdkOptions({ ...R.DRY_API, MetricType: { CHEST_BREATHING: 0 } }, { apiKey: 'k', spare: false, smoke: false }))
      .toThrow(/no MetricType\.BREATHING_RATE/);
    expect(() => R.sdkOptions({ MetricType: R.DRY_API['MetricType'] }, { apiKey: 'k', spare: false, smoke: true }))
      .toThrow(/SmartSpectraLogLevel\.kInfo/);
    expect(R.enumChecks(R.DRY_API).map((c) => c.differences)).toEqual([[], [], []]);
    expect(R.enumChecks({}).map((c) => c.label)).toEqual(['ProcessingStatus', 'ValidationCode', 'SmartSpectraErrorCode']);
  });

  it('reads the dry-run test hooks', () => {
    expect(R.dryOptions(['--dry', '--dry-error=8@0', '--dry-readiness=fail:4', '--dry-readiness-timeout=300', '--dry-hang=stopAsync'])).toEqual({
      error: '8@0', readiness: 'fail:4', readinessTimeoutMs: 300, hang: 'stopAsync',
    });
    expect(R.dryOptions([])).toEqual({ error: undefined, hang: undefined, readiness: undefined, readinessTimeoutMs: undefined });
  });

  it("splits host's stop budget: stopAsync(), the files, destroy() and a tenth to spare (spec 7.2)", () => {
    const { TAP_STOP_BUDGET_MS } = require(join(LIVE, 'lib', 'tap-timing.cjs')) as { TAP_STOP_BUDGET_MS: number };
    const b = R.stopBudget(undefined, TAP_STOP_BUDGET_MS);
    expect(b.stopAsyncMs + b.filesMs + b.destroyMs).toBeLessThanOrEqual(TAP_STOP_BUDGET_MS * 0.9);
    expect(R.stopBudget(undefined, 25_000)).toEqual({ stopAsyncMs: 15_000, filesMs: 3750, destroyMs: 3750 });
    expect(R.stopBudget('5000', 25_000)).toEqual({ stopAsyncMs: 3000, filesMs: 750, destroyMs: 750 }); // host's hook
    for (const bad of ['', '0', '-5', '2.5', 'soon']) expect(R.stopBudget(bad, 10_000).stopAsyncMs).toBe(6000);
  });

  it('gives the age of the last packet for the pulse, null before the first', () => {
    expect(R.agoMs(5_000_000_000n, null)).toBeNull();
    expect(R.agoMs(5_000_000_000n, 4_250_400_000n)).toBe(750);
    expect(R.agoMs(5_000_000_000n, 5_000_000_001n)).toBe(0);
  });
});

describe('live package and the Electron fallback (spec 6.7, 13.6)', () => {
  const pkg = JSON.parse(readFileSync(join(LIVE, 'package.json'), 'utf8')) as Record<string, Record<string, string>>;
  const lock = JSON.parse(readFileSync(join(LIVE, 'package-lock.json'), 'utf8')) as {
    lockfileVersion: number; packages: Record<string, { version?: string; optional?: boolean; dev?: boolean } & Record<string, unknown>>;
  };

  it('pins the SDK to 3.5.0 without a caret, with ws, and Electron 43.8.1 as optional', () => {
    expect(pkg.dependencies).toEqual({ '@smartspectra/node-sdk': '3.5.0', ws: expect.stringMatching(/^\^?8\./) });
    expect(pkg.optionalDependencies).toEqual({ electron: '43.8.1' });
    expect(pkg.devDependencies).toBeUndefined();
    expect(pkg.type).toBe('commonjs');
    expect(lock.lockfileVersion).toBe(3);
    expect(lock.packages['']).toMatchObject({ dependencies: pkg.dependencies, optionalDependencies: pkg.optionalDependencies });
    expect(lock.packages['node_modules/@smartspectra/node-sdk']?.version).toBe('3.5.0');
    expect(lock.packages['node_modules/electron']).toMatchObject({ version: '43.8.1', optional: true });
    expect(lock.packages['node_modules/ws']?.version).toMatch(/^8\./);
  });

  it('runs the npm script of the command: its npm run steps, then node <file> [args] plus the extra args', () => {
    const scripts = {
      gate: 'node live/host.cjs --mode gate', smoke: 'npm run -s build:web && node live/host.cjs --mode smoke',
      'build:web': 'vite build', test: 'vitest run', loop: 'npm run -s loop && node x.cjs',
      odd: 'npm run -s nope && node x.cjs', shell: 'rm -rf dist && node x.cjs',
    };
    expect(E.resolveCommand(['gate', '--pack', 'A'], scripts, '/repo')).toEqual({
      before: [], file: '/repo/live/host.cjs', args: ['--mode', 'gate', '--pack', 'A'],
    });
    expect(E.resolveCommand(['--', 'smoke'], scripts, '/repo')).toEqual({
      before: ['build:web'], file: '/repo/live/host.cjs', args: ['--mode', 'smoke'],
    });
    for (const cmd of ['loop', 'odd', 'shell']) expect(() => E.resolveCommand([cmd], scripts, '/repo')).toThrow(`"${cmd}"`);
    const root = JSON.parse(readFileSync(join(LIVE, '..', 'package.json'), 'utf8')) as { scripts: Record<string, string> };
    expect(E.resolveCommand(['smoke'], root.scripts, '/repo').file).toBe('/repo/live/host.cjs'); // the real scripts
    expect(() => E.resolveCommand([], scripts, '/repo')).toThrow(/name a command/);
    expect(() => E.resolveCommand(['test'], scripts, '/repo')).toThrow(/not an npm script of the form/);
    expect(() => E.resolveCommand(['nope'], scripts, '/repo')).toThrow(/"nope"/);
    expect(() => E.resolveCommand(['live:electron'], { 'live:electron': 'node x.cjs' }, '/repo')).toThrow();
    expect(() => E.resolveCommand(['toString'], {}, '/repo')).toThrow(); // own keys only
  });

  it('opens only host pages on 127.0.0.1 with a port', () => {
    expect(E.isHostPage('http://127.0.0.1:51234/?token=abc')).toBe(true);
    for (const url of ['https://127.0.0.1:51234/', 'http://localhost:51234/', 'http://127.0.0.1/', 'file:///tmp/x.html',
      'http://user:pw@127.0.0.1:51234/', 'http://example.com:80/', 'not a url']) {
      expect(E.isHostPage(url)).toBe(false);
    }
  });

  it('keeps the launcher rules of spec 6.7 in main.cjs', () => {
    const src = readFileSync(join(LIVE, 'electron', 'main.cjs'), 'utf8');
    expect(src).toContain('backgroundThrottling: false');
    expect(src).toMatch(/fork\(target\.file/); // host, then tap, stay separate Node-mode child processes
    expect(src).toContain("ELECTRON_RUN_AS_NODE: '1'");
    expect(src).not.toMatch(/@smartspectra\//); // the SDK never loads in Electron's main process
  });
});

// ---- tap --dry: the whole tap without the SDK, as host runs it (docs/protocol.md) ----

interface Msg { t: string; [k: string]: unknown }

async function until<T>(get: () => T | undefined, ms = 5000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = get();
    if (v !== undefined) return v;
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 10));
  }
}

function startTap(args: string[], env: Record<string, string> = {}, dry = true) {
  const child = fork(TAP, dry ? ['--dry', ...args] : args, {
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    env: { ...process.env, COPYHOLDER_CAMERA_NAME: '', COPYHOLDER_METRICS: '', ...env },
  });
  const msgs: Msg[] = [];
  let out = '';
  let err = '';
  child.on('message', (m) => msgs.push(m as Msg));
  child.stdout?.on('data', (d) => { out += String(d); });
  child.stderr?.on('data', (d) => { err += String(d); });
  const closed = new Promise<number | null>((resolve) => child.on('close', (code) => resolve(code)));
  const next = (pred: (m: Msg) => boolean, ms?: number) => until(() => msgs.find(pred), ms);
  return { child, msgs, closed, next, out: () => out, err: () => err };
}

type Tap = ReturnType<typeof startTap>;
const ORIGIN = 'http://127.0.0.1:5999';

async function configured(args: string[], smoke = false, env: Record<string, string> = {}, dry = true) {
  const tap = startTap(args, env, dry);
  const ready = await tap.next((m) => m.t === 'ready');
  const token = randomBytes(32).toString('hex');
  const dir = mkdtempSync(join(tmpdir(), 'tap-dry-'));
  tap.child.send({ t: 'config', token, origin: ORIGIN, sessionDir: dir, smoke });
  return { tap, dir, url: `ws://127.0.0.1:${ready.port as number}/tap?token=${token}` };
}

async function stop(tap: Tap): Promise<number | null> {
  tap.child.send({ t: 'stop' });
  await tap.next((m) => m.t === 'stopped');
  return tap.closed;
}

/** Opens a /tap client; resolves with its frames, or with the HTTP status of a refusal. */
function connect(url: string, origin: string): Promise<{ ws: WebSocket; frames: string[] } | { status: number }> {
  return new Promise((resolve) => {
    const ws = new WebSocket(url, { origin });
    const frames: string[] = [];
    ws.on('message', (d) => frames.push(String(d)));
    ws.on('open', () => resolve({ ws, frames }));
    ws.on('unexpected-response', (req, res) => { resolve({ status: res.statusCode ?? 0 }); req.destroy(); });
    ws.on('error', () => {});
  });
}

const readSamples = (dir: string) => readFileSync(join(dir, 'samples.jsonl'), 'utf8').trim().split('\n');
const kindOf = (s: string) => (JSON.parse(s) as Line).k;

describe('tap --dry (spec 7.1, docs/protocol.md)', () => {
  it('serves /tap to one client, starts only on start, writes both files, stops on stop', async () => {
    const { tap, dir, url } = await configured([], true);
    expect(await tap.next((m) => m.t === 'camera')).toMatchObject({ name: 'Copyholder dry camera', requested: [1280, 720, 30], dry: true });
    expect(await tap.next((m) => m.t === 'cameras')).toMatchObject({ list: [{ id: 'dry-0' }] }); // smoke lists them
    expect(await tap.next((m) => m.t === 'enums')).toEqual({ t: 'enums', checks: [
      { label: 'ProcessingStatus', differences: [] }, { label: 'ValidationCode', differences: [] },
      { label: 'SmartSpectraErrorCode', differences: [] },
    ] });

    expect(await connect(url.replace(/token=\w+/, 'token=wrong'), ORIGIN)).toEqual({ status: 403 });
    expect(await connect(url, 'http://127.0.0.1:6000')).toEqual({ status: 403 });
    const first = await connect(url, ORIGIN);
    if (!('ws' in first)) throw new Error(`refused: ${first.status}`);
    expect(await connect(url, ORIGIN)).toEqual({ status: 409 });

    await new Promise((r) => setTimeout(r, 300));
    expect(first.frames.map(kindOf).filter((k) => k !== 'l')).toEqual([]); // nothing before start
    expect(tap.msgs.some((m) => m.t === 'started')).toBe(false);

    tap.child.send({ t: 'start' });
    expect(await tap.next((m) => m.t === 'readiness')).toEqual({ t: 'readiness', verdict: 'ready', reason: 'dry run' });
    await tap.next((m) => m.t === 'started');
    expect(await tap.next((m) => m.t === 'probe')).toMatchObject({ packet: 1, points: 478, tsType: 'Long' });
    expect(await tap.next((m) => m.t === 'status' && m.code === 3)).toMatchObject({ kind: 'processingStatus', name: 'kRunning' });
    await tap.next((m) => m.t === 'pulse' && (m.packets as number) > 10, 4000);
    await until(() => (first.frames.filter((f) => kindOf(f) === 'l').length >= 2 ? true : undefined), 4000);
    expect(await stop(tap)).toBe(0);

    const fileLines = readSamples(dir);
    expect(fileLines.slice(0, first.frames.length)).toEqual(first.frames); // the socket carries the file lines
    const lines = fileLines.map((s) => JSON.parse(s) as Line);
    expect(new Set(lines.map((l) => l.k))).toEqual(new Set(['l', 's', 'v', 'f', 'm']));
    const sdkLines = lines.filter((l) => l.k !== 'l');
    const seqs = sdkLines.map((l) => l.seq as number);
    expect(seqs).toEqual(seqs.map((_, i) => i + 1));
    expect(lines.filter((l) => l.k === 's').map((l) => l.code)).toEqual([2, 3, 4, 1]);
    const m = lines.filter((l) => l.k === 'm') as unknown as MLine[];
    expect(m.length).toBeGreaterThan(20);
    for (const l of m) {
      expect(l.tArrNs).toMatch(/^\d+$/);
      expect(Number.isSafeInteger(l.tsCbUs)).toBe(true);
      expect(l.lm?.p).toHaveLength(16);
    }
    expect(m[0]).toMatchObject({ g: null, hm: null, lm: { reset: 1 } });
    expect(m.slice(5).every((l) => typeof l.g === 'number' && typeof l.hm === 'number')).toBe(true);
    for (const l of lines.filter((x) => x.k === 'l')) expect(l).toMatchObject({ p99Ms: expect.any(Number), n: expect.any(Number), dry: 1 });

    const raw = gunzipSync(readFileSync(join(dir, 'sdk_raw.jsonl.gz'))).toString('utf8').trim().split('\n').map((s) => JSON.parse(s) as Line);
    expect(raw.map((r) => r.seq)).toEqual(seqs);
    expect(raw.map((r) => r.tArrNs)).toEqual(sdkLines.map((l) => l.tArrNs));
    for (const r of raw) expect(r).toMatchObject({ tArrNs: expect.stringMatching(/^\d+$/), tWallMs: expect.any(Number) });
    const metrics = raw.filter((r) => r.kind === 'metrics');
    expect(metrics.length).toBe(m.length);
    expect(Buffer.from(String(metrics[0]?.b64), 'base64')).toHaveLength(12);
    expect(raw.find((r) => r.kind === 'processingStatus')).toMatchObject({ args: [2] });
    expect(raw.find((r) => r.kind === 'processingStatus')).not.toHaveProperty('tsCbUs'); // no timestampUs argument
    expect(raw.find((r) => r.kind === 'validationStatus')).toMatchObject({ args: [0, expect.any(Number), ''] });

    // Every line passes the shared schemas of core/schemas (spec 8.1).
    expect(lines.flatMap((l, i) => validateSampleLine(l).map((p) => `samples ${i}: ${p}`))).toEqual([]);
    expect(raw.flatMap((r, i) => validateSdkRawLine(r).map((p) => `sdk_raw ${i}: ${p}`))).toEqual([]);
  });

  it('--list-cameras prints the camera names and exits', async () => {
    const tap = startTap(['--list-cameras']);
    expect(await tap.next((m) => m.t === 'cameras')).toEqual({ t: 'cameras', list: [{ id: 'dry-0', name: 'Copyholder dry camera' }] });
    expect(await tap.closed).toBe(0);
    expect(tap.out()).toBe('Copyholder dry camera\n');
  });

  it('prints the camera names and exits when no name matches COPYHOLDER_CAMERA_NAME', async () => {
    const { tap } = await configured([], false, { COPYHOLDER_CAMERA_NAME: 'No such camera' });
    expect(await tap.next((m) => m.t === 'cameras')).toMatchObject({ list: [{ name: 'Copyholder dry camera' }] });
    await tap.next((m) => m.t === 'stopped');
    expect(await tap.closed).toBe(1);
    expect(tap.out()).toContain('Copyholder dry camera');
    expect(tap.msgs.some((m) => m.t === 'camera')).toBe(false);
  });

  it('error 2 exits with the key message', async () => {
    const { tap } = await configured(['--dry-error=2@0.1']);
    tap.child.send({ t: 'start' });
    expect(await tap.next((m) => m.t === 'sdk_error')).toMatchObject({ code: 2, name: 'kAuthenticationFailed', action: 'exit_key' });
    await tap.next((m) => m.t === 'stopped');
    expect(await tap.closed).toBe(1);
    expect(tap.err()).toContain('Check SMARTSPECTRA_API_KEY in .env');
  });

  it('error 8 before any packet: reset() once kError is reported, one restart; the next one is left to host', async () => {
    const { tap, dir } = await configured(['--dry-error=8@0']);
    tap.child.send({ t: 'start' });
    const errors = await until(() => {
      const e = tap.msgs.filter((m) => m.t === 'sdk_error');
      return e.length >= 2 ? e : undefined;
    });
    // The dry SDK sends the error before kError and refuses reset() outside kError (API reference): a reset()
    // right after the error event would give [1, 'abort'] (kInvalidState) here instead of the second error 8.
    expect(errors.map((e) => [e.code, e.action])).toEqual([[8, 'reset_restart'], [8, 'abort']]);
    expect(await stop(tap)).toBe(0);
    const codes = readSamples(dir).map((s) => JSON.parse(s) as Line).filter((l) => l.k === 's').map((l) => l.code);
    expect(codes.slice(0, 6)).toEqual([2, 3, 5, 1, 2, 3]); // kError, reset() to kIdle, the one restart
  });

  it('readiness, start, pause and start again in one process and one pair of files (spec 7.12 q9, 11.5)', async () => {
    const { tap, dir } = await configured([]);
    tap.child.send({ t: 'readiness' });
    expect(await tap.next((m) => m.t === 'readiness')).toEqual({ t: 'readiness', verdict: 'ready', reason: 'dry run' });
    // The 1 s clock runs from the readiness on; no packet yet, so no age (docs/protocol.md).
    expect(await tap.next((m) => m.t === 'pulse', 3000)).toEqual({ t: 'pulse', packets: 0, last_ago_ms: null });
    expect(tap.msgs.some((m) => m.t === 'started')).toBe(false); // readiness alone never starts the camera
    tap.child.send({ t: 'start' });
    await tap.next((m) => m.t === 'started');
    const live = await tap.next((m) => m.t === 'pulse' && (m.packets as number) > 0, 3000);
    expect(live.last_ago_ms).toBeGreaterThanOrEqual(0);
    expect(live.last_ago_ms).toBeLessThan(1000); // 30 packets a second
    tap.child.send({ t: 'pause' });
    await tap.next((m) => m.t === 'paused');
    const paused = tap.msgs.length;
    const quiet = await until(() => tap.msgs.slice(paused).find((m) => m.t === 'pulse' && m.packets === 0), 3000);
    expect(quiet.last_ago_ms).toEqual(expect.any(Number)); // the age of the last packet before the pause
    tap.child.send({ t: 'start' });
    await until(() => (tap.msgs.filter((m) => m.t === 'started').length === 2 ? true : undefined));
    const restarted = tap.msgs.length;
    await until(() => tap.msgs.slice(restarted).find((m) => m.t === 'pulse' && (m.packets as number) > 0), 3000);
    expect(await stop(tap)).toBe(0);

    const lines = readSamples(dir).map((s) => JSON.parse(s) as Line);
    expect(lines.filter((l) => l.k === 's').map((l) => l.code)).toEqual([2, 3, 4, 1, 2, 3, 4, 1]);
    const idle = lines.findIndex((l) => l.k === 's' && l.code === 1);
    const again = lines.findIndex((l, i) => i > idle && l.k === 's' && l.code === 2);
    expect(lines.slice(idle, again).some((l) => l.k === 'm')).toBe(false); // paused: no packets
    expect(lines.slice(again).some((l) => l.k === 'm')).toBe(true);
    const seqs = lines.filter((l) => l.k !== 'l').map((l) => l.seq as number);
    expect(seqs).toEqual(seqs.map((_, i) => i + 1)); // one seq counter for the whole process
    const raw = gunzipSync(readFileSync(join(dir, 'sdk_raw.jsonl.gz'))).toString('utf8').trim().split('\n');
    expect(raw).toHaveLength(seqs.length);
  });

  it('a coded checkDeviceReadiness() failure: no start(), the table decides, retryable is kept', async () => {
    const { tap } = await configured(['--dry-readiness=fail:4'], true);
    tap.child.send({ t: 'start' }); // smoke: tap checks readiness first when host did not ask
    expect(await tap.next((m) => m.t === 'sdk_error')).toEqual({
      t: 'sdk_error', code: 4, name: 'kCreditExhausted', message: 'checkDeviceReadiness() failed: dry readiness failure',
      retryable: true, call: 'checkDeviceReadiness()', action: 'abort',
    });
    expect(await tap.next((m) => m.t === 'readiness')).toMatchObject({ verdict: null, reason: expect.stringContaining('dry readiness') });
    await new Promise((r) => setTimeout(r, 500));
    expect(tap.msgs.some((m) => m.t === 'started' || (m.t === 'status' && m.code === 2))).toBe(false); // camera off
    expect(tap.err()).toContain('SDK error 4 kCreditExhausted from checkDeviceReadiness()');
    expect(tap.err()).toContain('start() skipped');
    expect(await stop(tap)).toBe(0);
  });

  it('checkDeviceReadiness() past its time: host hears timeout, start() waits for the check', async () => {
    const { tap } = await configured(['--dry-readiness=1500', '--dry-readiness-timeout=300'], true);
    tap.child.send({ t: 'start' });
    expect(await tap.next((m) => m.t === 'readiness')).toEqual({ t: 'readiness', verdict: null, reason: 'timeout' });
    expect(tap.msgs.some((m) => m.t === 'started')).toBe(false);
    await tap.next((m) => m.t === 'started', 4000);
    const order = tap.msgs.filter((m) => m.t === 'readiness' || m.t === 'started').map((m) => (m.t === 'started' ? 'started' : m.verdict));
    expect(order).toEqual([null, 'ready', 'started']);
    expect(tap.err()).toContain('checkDeviceReadiness() did not settle in 0.3 s');
    expect(await stop(tap)).toBe(0);
  });

  it("stop with a hung stopAsync(): complete files and stopped inside host's stop budget (spec 7.2)", async () => {
    // host's test hook shortens its wait to 5 s; tap reads the same variable: stopAsync() gets 3 s of it.
    const { tap, dir } = await configured(['--dry-hang=stopAsync'], false, { COPYHOLDER_TAP_STOP_BUDGET_MS: '5000' });
    tap.child.send({ t: 'start' });
    await tap.next((m) => m.t === 'pulse' && (m.packets as number) > 0, 3000);
    const t0 = Date.now();
    tap.child.send({ t: 'stop' });
    await tap.next((m) => m.t === 'stopped', 8000);
    expect(Date.now() - t0).toBeLessThan(5000);
    expect(await tap.closed).toBe(1); // the stop failed, the files did not
    expect(tap.err()).toContain('stopAsync() did not settle in 3 s');
    const raw = gunzipSync(readFileSync(join(dir, 'sdk_raw.jsonl.gz'))).toString('utf8'); // strict: needs the trailer
    const text = readFileSync(join(dir, 'samples.jsonl'), 'utf8');
    expect(raw.endsWith('\n') && text.endsWith('\n')).toBe(true);
    const lines = text.trim().split('\n').map((s) => JSON.parse(s) as Line);
    expect(lines.filter((l) => l.k === 'm').length).toBeGreaterThan(5);
    expect(raw.trim().split('\n')).toHaveLength(lines.filter((l) => l.k !== 'l').length);
  }, 20_000);

  it('COPYHOLDER_TAP_DRY=1 works only under Vitest, and the dry run says so', async () => {
    const { tap } = await configured([], false, { COPYHOLDER_TAP_DRY: '1' }, false); // no --dry: the env switch
    expect(await tap.next((m) => m.t === 'camera')).toMatchObject({ name: 'Copyholder dry camera', dry: true });
    expect(tap.err()).toContain('DRY RUN');
    expect(await stop(tap)).toBe(0);
    const outside = startTap([], { COPYHOLDER_TAP_DRY: '1', VITEST: '' }, false);
    expect(await outside.closed).toBe(1);
    expect(outside.err()).toContain('COPYHOLDER_TAP_DRY=1 is a test switch');
    expect(outside.msgs).toEqual([]); // never ready: host cannot use it
  });

  // Without --dry tap would load the SDK; run these only where it is not installed and .env is absent (CI).
  const cloud = !existsSync(join(LIVE, 'node_modules', '@smartspectra')) && !existsSync(join(LIVE, '..', '.env'));

  it.skipIf(!cloud)('without a key: exits with the key message before loading the SDK', async () => {
    const { tap } = await configured([], false, { SMARTSPECTRA_API_KEY: '' }, false);
    expect(await tap.next((m) => m.t === 'sdk_error')).toMatchObject({ code: 2, action: 'exit_key', call: 'tap' });
    await tap.next((m) => m.t === 'stopped');
    expect(await tap.closed).toBe(1);
    expect(tap.err()).toContain('Check SMARTSPECTRA_API_KEY in .env');
  });

  it.skipIf(!cloud)('without the SDK installed: exits with the setup hint and never prints the key', async () => {
    const key = 'test-key-7f3a9c';
    const { tap } = await configured([], true, { SMARTSPECTRA_API_KEY: key }, false);
    expect(await tap.next((m) => m.t === 'sdk_error')).toMatchObject({ code: null, action: 'exit' });
    await tap.next((m) => m.t === 'stopped');
    expect(await tap.closed).toBe(1);
    expect(tap.err()).toContain('npm run setup:live');
    expect(tap.err() + tap.out() + JSON.stringify(tap.msgs)).not.toContain(key);
  });

  it('error 4 marks the trace unusable and leaves the stop to host', async () => {
    const { tap, dir } = await configured(['--dry-error=4@0.2']);
    tap.child.send({ t: 'start' });
    expect(await tap.next((m) => m.t === 'sdk_error')).toMatchObject({ code: 4, name: 'kCreditExhausted', action: 'abort' });
    await tap.next((m) => m.t === 'pulse' && (m.packets as number) > 0, 3000); // still running
    expect(await stop(tap)).toBe(0);
    const e = readSamples(dir).map((s) => JSON.parse(s) as Line).filter((l) => l.k === 'e');
    expect(e).toMatchObject([{ k: 'e', code: 4, name: 'kCreditExhausted', message: 'dry error', retryable: false }]);
  });
});
