// Small host pieces: CLI and modes (spec 6.5, 13.3), folder names (spec 8.1), start checks
// (spec 8.3, 8.5, 14.1), calibration lookup (spec 8.1), Chrome launch (spec 7.2), mock stream (spec 7.5).
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { LEDGER_KINDS, RECORD_KINDS } from '../../core/schemas/common.ts';
import { requireCjs } from './helpers.ts';

interface Opts {
  mode: string;
  pack: string | null;
  id: string | null;
  plan: string | null;
  from: string | null;
  tap: string | null;
  open: boolean;
  level: boolean;
}
const args = requireCjs('../../live/lib/args.cjs') as {
  MODE_NAMES: string[];
  MODES: Record<string, { kind: string; tap: string | null; consent: string; narrator: string; counts: boolean }>;
  parseHostArgs(argv: string[]): { opts: Opts | null; error: string | null };
  scenarioName(o: Opts): string;
  kindFor(o: Opts): string;
  needsCleanTree(o: Opts): boolean;
};
const ids = requireCjs('../../live/lib/session-ids.cjs') as {
  nextFreeId(dir: string, base: string): string;
  nextNumberedId(dir: string, prefix: string): string;
  baseIdFor(o: Opts, dir: string): string;
  reserveSessionDir(dir: string, base: string): { id: string; dir: string };
};
const pre = requireCjs('../../live/lib/preconditions.cjs') as {
  readCommitment(dir: string): string | null;
  sealedSoundPlayed(manifest: unknown): boolean;
  planHeardIn(dir: string, plan: string): string | null;
  firstUnheardDemo(dir: string): string | null;
  freezeRefusal(file: string, commitment: string | null): string | null;
  revealRefusal(dir: string): string | null;
  gitRefusal(g: { commit: string | null; treeClean: boolean | null; behind: boolean | null }): string | null;
};
const calib = requireCjs('../../live/lib/calib.cjs') as {
  pageCalib(dir: string): { calib: Record<string, unknown> | null; sources: { doctor: string[]; gate: string | null } };
  usableGain(c: unknown): number | null;
  detectorSetup(file: string, c: unknown): { params: Record<string, unknown>; sign: number; variant: string };
};
type SpawnFn = (cmd: string, a: string[], opts: object) => unknown;
const chrome = requireCjs('../../live/lib/chrome.cjs') as {
  OPEN_BIN: string;
  openArgs(url: string, profile: string): string[];
  openChrome(url: string, profile: string, o: { platform: string; spawnFn: SpawnFn }): boolean;
  openPage(url: string, o: { launcher: string; profileDir: string; send: ((m: object) => void) | null; platform: string; spawnFn: SpawnFn }): string | null;
};
interface CodeTables {
  PROCESSING_NAMES: Record<number, string>;
  VALIDATION_NAMES: Record<number, string>;
  ERROR_NAMES: Record<number, string>;
  errorAction(code: number, canRestart: boolean): string;
}
const codes = requireCjs('../../live/lib/sdk-codes.cjs') as CodeTables & {
  KEY_MESSAGE: string;
  sdkErrorText(code: number | null, name: string | null, o?: { smoke?: boolean; call?: string | null }): string;
  isRunningStatus(name: unknown): boolean;
};
const reduce = requireCjs('../../live/reduce.cjs') as CodeTables;
const mock = requireCjs('../../live/mock-tap.cjs') as {
  normalizeScript(s: unknown): Record<string, unknown>;
  pulseMessage(packets: number, lastPacketAtMs: number | null, nowMs: number): { t: string; packets: number; last_ago_ms: number | null };
  PROCESSING: Record<string, number>;
};
const timing = requireCjs('../../live/lib/tap-timing.cjs') as {
  PULSE_EVERY_MS: number;
  TAP_SILENCE_MS: number;
  TAP_STOP_BUDGET_MS: number;
};
const quick = requireCjs('../../live/lib/quickcheck.cjs') as {
  EXIT_PASS: number;
  EXIT_FAIL: number;
  quickcheckVerdict(code: number | null, stdout: string): { ok: boolean | null; text: string | null };
};
const ledgerLib = requireCjs('../../live/lib/ledger.cjs') as {
  LEDGER_KINDS: readonly string[];
  isLedgerKind(kind: string): boolean;
};
const synth = requireCjs('../../live/lib/synth-trace.cjs') as {
  LANDMARK_IDS: number[];
  lipGapFromPoints(p: number[][]): number;
  facePoints(gapPx: number, dx: number, dy: number): number[][];
  SyntheticStream: new (o: { seed?: number; breathPeriodS?: number; talking?: number[][] }) => {
    frame(tS: number): { value: number; talking: number; g: number; hm: number; points: number[][] };
  };
};
const replay = requireCjs('../../live/lib/replay.cjs') as {
  loadReplay(dir: string): { atMs: number; line: Record<string, unknown> }[];
};
const guard = requireCjs('../../live/lib/guard.cjs') as {
  newToken(): string;
  sameToken(a: unknown, b: unknown): boolean;
  parseCookies(h: string | undefined): Map<string, string>;
};

const parse = (...a: string[]) => args.parseHostArgs(a);

describe('CLI and modes', () => {
  it('knows the ten modes and their taps (spec 6.5)', () => {
    expect(args.MODE_NAMES).toEqual(['gate', 'doctor', 'smoke', 'session', 'rehearsal', 'demo', 'spacebar', 'headstart', 'live-from', 'live-sim']);
    expect(args.MODES.doctor?.tap).toBeNull();
    expect(args.MODES.spacebar?.tap).toBeNull();
    expect(args.MODES['live-sim']?.tap).toBe('mock');
    expect(args.MODES.session?.kind).toBe('numbers');
  });

  it('parses the npm script forms', () => {
    expect(parse('--mode', 'gate', '--pack', 'a').opts).toMatchObject({ mode: 'gate', pack: 'A', tap: 'real', open: true });
    expect(parse('--mode', 'session', 's1').opts).toMatchObject({ mode: 'session', plan: 's1', id: null });
    expect(parse('--mode', 'live-from', 'gate-a').opts).toMatchObject({ mode: 'live-from', from: 'gate-a', tap: 'mock' });
    expect(parse('--mode', 'live-sim', '--plan', 'pilot').opts).toMatchObject({ plan: 'pilot', tap: 'mock' });
    expect(parse('--mode', 'live-sim').opts?.plan).toBe('pilot');
    expect(parse('--mode', 'spacebar').opts).toMatchObject({ plan: 'k1', tap: null });
    expect(parse('--mode', 'rehearsal').opts?.plan).toBe('rehearsal');
    expect(parse('--mode', 'doctor', '--level', '--tap', 'mock').opts).toMatchObject({ level: true, tap: null });
    expect(parse('--mode', 'smoke', '--id', 'smoke-x', '--no-open', '--tap=mock').opts).toMatchObject({ id: 'smoke-x', open: false, tap: 'mock' });
  });

  it('explains wrong arguments', () => {
    expect(parse().error).toMatch(/Choose a mode/);
    expect(parse('--mode', 'gate').error).toMatch(/--pack A/);
    expect(parse('--mode', 'session').error).toMatch(/session -- s1/);
    expect(parse('--mode', 'live-from').error).toMatch(/live:from -- gate-a/);
    expect(parse('--mode', 'gate', '--pack', 'A', '--tap', 'other').error).toMatch(/real or mock/);
    expect(parse('--mode', 'smoke', '--id', '../x').error).toMatch(/Not a valid/);
    expect(parse('--mode', 'smoke', '--pack', 'A').error).toMatch(/only with --mode gate/);
    expect(parse('--mode', 'smoke', '--bogus').error).toMatch(/Unknown option/);
  });

  it('names the record kind and which runs need a clean git tree (spec 8.5, 14.1)', () => {
    const o = (...a: string[]) => parse(...a).opts as Opts;
    expect(args.kindFor(o('--mode', 'live-sim'))).toBe('pilot'); // the listening without camera
    expect(args.kindFor(o('--mode', 'live-sim', '--plan', 'r9'))).toBe('live_sim');
    expect(args.kindFor(o('--mode', 'spacebar'))).toBe('spacebar');
    expect(args.kindFor(o('--mode', 'live-from', 'gate-a'))).toBe('live_from');
    expect(args.needsCleanTree(o('--mode', 'gate', '--pack', 'A'))).toBe(true);
    expect(args.needsCleanTree(o('--mode', 'session', 's1'))).toBe(true);
    expect(args.needsCleanTree(o('--mode', 'live-sim'))).toBe(true);
    expect(args.needsCleanTree(o('--mode', 'live-sim', '--plan', 'r9'))).toBe(false);
    expect(args.needsCleanTree(o('--mode', 'live-from', 'gate-a'))).toBe(false);
    expect(args.needsCleanTree(o('--mode', 'headstart'))).toBe(false);
  });

  it('names the scenario', () => {
    expect(args.scenarioName(parse('--mode', 'gate', '--pack', '0').opts as Opts)).toBe('gate-0');
    expect(args.scenarioName(parse('--mode', 'doctor', '--level').opts as Opts)).toBe('doctor-level');
    expect(args.scenarioName(parse('--mode', 'session', 's2').opts as Opts)).toBe('session');
  });
});

describe('folders, checks and lookups', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'copyholder-units-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const manifest = (id: string, m: object) => {
    mkdirSync(join(dir, id), { recursive: true });
    writeFileSync(join(dir, id, 'manifest.json'), JSON.stringify(m));
  };

  it('picks default folder names and never reuses one', () => {
    expect(ids.baseIdFor(parse('--mode', 'gate', '--pack', 'A').opts as Opts, dir)).toBe('gate-a');
    expect(ids.baseIdFor(parse('--mode', 'gate', '--pack', '0').opts as Opts, dir)).toBe('gate-0');
    expect(ids.baseIdFor(parse('--mode', 'doctor').opts as Opts, dir)).toBe('doctor-1');
    expect(ids.baseIdFor(parse('--mode', 'session', 's1').opts as Opts, dir)).toBe('s1');
    mkdirSync(join(dir, 'doctor-1'));
    mkdirSync(join(dir, 'doctor-7'));
    expect(ids.nextNumberedId(dir, 'doctor')).toBe('doctor-8');
    expect(ids.nextNumberedId(dir, 'live-from')).toBe('live-from-1');
    const a = ids.reserveSessionDir(dir, 'gate-a');
    const b = ids.reserveSessionDir(dir, 'gate-a');
    expect([a.id, b.id]).toEqual(['gate-a', 'gate-a-2']);
    expect(existsSync(b.dir)).toBe(true);
  });

  it('knows which plans were heard and which demo comes next (spec 7.8, 10.4)', () => {
    expect(pre.firstUnheardDemo(dir)).toBe('demo-1');
    manifest('demo-1', { plan: 'demo-1', narrator: { sealed_served: [], first_sealed_n: null } }); // preflight failed
    expect(pre.firstUnheardDemo(dir)).toBe('demo-1');
    // clips and timings fetched, then an abort before the first sealed sound: the text is not spent
    manifest('demo-1-2', { plan: 'demo-1', narrator: { sealed_served: ['opening.wav', 'timings.json'], first_sealed_n: null } });
    expect(pre.planHeardIn(dir, 'demo-1')).toBeNull();
    expect(pre.firstUnheardDemo(dir)).toBe('demo-1');
    manifest('demo-1-3', { plan: 'demo-1', narrator: { sealed_served: ['opening.wav'], first_sealed_n: 96000 } });
    expect(pre.planHeardIn(dir, 'demo-1')).toBe('demo-1-3');
    expect(pre.firstUnheardDemo(dir)).toBe('demo-2');
    // a manifest from before first_sealed_n counts as heard once a sealed file was served
    manifest('demo-2', { plan: 'demo-2', narrator: { sealed_served: ['p1.wav'] } });
    expect(pre.planHeardIn(dir, 'demo-2')).toBe('demo-2');
    expect(pre.firstUnheardDemo(dir)).toBe('demo-3');
  });

  it('counts a text as spent only from its first sealed sound', () => {
    expect(pre.sealedSoundPlayed(null)).toBe(false);
    expect(pre.sealedSoundPlayed({})).toBe(false);
    expect(pre.sealedSoundPlayed({ narrator: null })).toBe(false);
    expect(pre.sealedSoundPlayed({ narrator: { sealed_served: ['opening.wav'], first_sealed_n: null } })).toBe(false);
    expect(pre.sealedSoundPlayed({ narrator: { sealed_served: [], first_sealed_n: 0 } })).toBe(true); // sample 0 is a sample
    expect(pre.sealedSoundPlayed({ narrator: { sealed_served: ['p1.wav'] } })).toBe(true);
    expect(pre.sealedSoundPlayed({ narrator: { sealed_served: [] } })).toBe(false);
  });

  it('reads the plan seal and checks it against freeze_manifest.json (spec 8.3)', () => {
    const c = 'ab'.repeat(32);
    writeFileSync(join(dir, 'commitment.txt'), `${c.toUpperCase()}\n`);
    expect(pre.readCommitment(dir)).toBe(c);
    const fm = join(dir, 'freeze_manifest.json');
    expect(pre.freezeRefusal(fm, c)).toBeNull(); // before freeze-1
    writeFileSync(fm, JSON.stringify({ plans: [{ id: 's1', plan_commitment: c }] }));
    expect(pre.freezeRefusal(fm, c)).toBeNull();
    expect(pre.freezeRefusal(fm, 'cd'.repeat(32))).toMatch(/not in freeze_manifest/);
    expect(pre.freezeRefusal(fm, null)).toMatch(/no seal/);
  });

  it('stops numbers sessions after a reveal (spec 8.5)', () => {
    manifest('s1', { kind: 'numbers' });
    writeFileSync(join(dir, 's1', 'ledger.jsonl'), '{"i":0,"step":"record"}\n');
    expect(pre.revealRefusal(dir)).toBeNull();
    writeFileSync(join(dir, 's1', 'ledger.jsonl'), '{"i":0,"step":"record"}\n{"i":1,"step":"reveal"}\n');
    expect(pre.revealRefusal(dir)).toMatch(/already revealed/);
  });

  it('asks for a clean, current git tree for counting recordings (spec 14.1)', () => {
    expect(pre.gitRefusal({ commit: 'abc1234', treeClean: true, behind: false })).toBeNull();
    expect(pre.gitRefusal({ commit: 'abc1234', treeClean: true, behind: null })).toBeNull();
    expect(pre.gitRefusal({ commit: 'abc1234', treeClean: false, behind: false })).toMatch(/local changes/);
    expect(pre.gitRefusal({ commit: 'abc1234', treeClean: true, behind: true })).toMatch(/git pull/);
    expect(pre.gitRefusal({ commit: null, treeClean: null, behind: null })).toMatch(/not a git clone/);
  });

  it('gives the page the latest doctor calibration and the sign of the gate recording with a verdict (spec 8.1)', () => {
    expect(calib.pageCalib(dir)).toEqual({ calib: null, sources: { doctor: [], gate: null } });
    const write = (id: string, c: object) => {
      mkdirSync(join(dir, id), { recursive: true });
      writeFileSync(join(dir, id, 'calib.json'), JSON.stringify(c));
    };
    write('doctor-2', { schema: 'calib/1', L_rt_ms: { used: 23.5 }, output_gain: 0.3, polarity: { sign: 1 } });
    write('doctor-10', { schema: 'calib/1', output_gain: 0.4 }); // doctor --level: gain and leak only
    mkdirSync(join(dir, 'doctor-11')); // no calib.json yet
    write('gate-a', { schema: 'calib/1', polarity: { sign: -1, breaths_agree: 3 } });
    const before = calib.pageCalib(dir);
    expect(before.calib).toEqual({ schema: 'calib/1', L_rt_ms: { used: 23.5 }, output_gain: 0.4 }); // no verdict yet: no sign
    expect(before.sources).toEqual({ doctor: ['doctor-2', 'doctor-10'], gate: null });
    writeFileSync(join(dir, 'gate-a', 'verdict.json'), '{}');
    const after = calib.pageCalib(dir);
    expect(after.calib).toEqual({ schema: 'calib/1', L_rt_ms: { used: 23.5 }, output_gain: 0.4, polarity: { sign: -1, breaths_agree: 3 } });
    expect(after.sources.gate).toBe('gate-a');
    expect(calib.usableGain(after.calib)).toBe(0.4);
    expect(calib.usableGain({ output_gain: 1.5 })).toBeNull();
    expect(calib.usableGain(null)).toBeNull();
  });

  it('gives the worker the frozen detector parameters and the trace sign (spec 7.4, 8.4)', () => {
    const file = join(dir, 'frozen.json');
    expect(calib.detectorSetup(file, null)).toEqual({ params: {}, sign: 1, variant: 'D1' });
    writeFileSync(file, JSON.stringify({ schema: 'params/1', d1: { k: 2.5 } }));
    expect(calib.detectorSetup(file, { polarity: { sign: -1 } })).toEqual({ params: { schema: 'params/1', d1: { k: 2.5 } }, sign: -1, variant: 'D1' });
    writeFileSync(file, JSON.stringify({ d1: { k: 2.5, variant: 'D3' } }));
    expect(calib.detectorSetup(file, { polarity: { sign: 0 } })).toMatchObject({ sign: 1, variant: 'D3' });
  });

  it('builds the replay schedule from recorded nArr', () => {
    writeFileSync(join(dir, 'stamps.jsonl'), [
      '{"n":96000,"k":"chunk","frames":9600}',
      '{"n":96480,"k":"arr","seq":10}',
      '{"n":98400,"k":"arr","seq":12}',
    ].join('\n'));
    writeFileSync(join(dir, 'detector_in.jsonl'), [
      '{"k":"batch","seq":10,"tr":[[1000000,0.5]],"talk":[[1000000,0]],"g":0.01,"hm":0.002}',
      '{"k":"val","seq":11,"code":1}',
      '{"k":"voice","n":97000,"on":true}',
      '{"k":"batch","seq":12,"tr":[[1033333,0.25]],"talk":[[1033333,1]],"g":0.02,"hm":0.003}',
    ].join('\n'));
    const items = replay.loadReplay(dir);
    expect(items.map((i) => i.atMs)).toEqual([10, 10, 50]);
    expect(items[0]?.line).toEqual({ seq: 10, k: 'm', tsCbUs: 1000000, tr: [[1000000, 0.5]], talk: [[1000000, 0]], g: 0.01, hm: 0.002, lm: null });
    // a validation line has no time of its own: it keeps the packet before it (samples.jsonl needs tsCbUs)
    expect(items[1]?.line).toEqual({ seq: 11, k: 'v', tsCbUs: 1000000, code: 1, name: 'kNoFaceFound' });
    expect(items[2]?.line).toMatchObject({ seq: 12, k: 'm', tsCbUs: 1033333 });
  });
});

describe('Chrome launch, tokens and the synthetic stream', () => {
  it('opens Chrome through /usr/bin/open with the window flags', () => {
    const calls: { cmd: string; a: string[] }[] = [];
    const fake = (cmd: string, a: string[]) => {
      calls.push({ cmd, a });
      return { unref() {}, on() {} };
    };
    expect(chrome.openChrome('http://127.0.0.1:1/?token=t', '/h/.copyholder/chrome-profile', { platform: 'linux', spawnFn: fake })).toBe(false);
    expect(calls).toHaveLength(0);
    expect(chrome.openChrome('http://127.0.0.1:1/?token=t', '/h/.copyholder/chrome-profile', { platform: 'darwin', spawnFn: fake })).toBe(true);
    expect(calls[0]?.cmd).toBe('/usr/bin/open');
    expect(calls[0]?.a.slice(0, 3)).toEqual(['-na', 'Google Chrome', '--args']);
    expect(calls[0]?.a).toEqual(expect.arrayContaining([
      '--app=http://127.0.0.1:1/?token=t', '--new-window', '--start-fullscreen',
      '--user-data-dir=/h/.copyholder/chrome-profile', '--autoplay-policy=no-user-gesture-required',
      '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows',
    ]));
  });

  it('under the Electron fallback asks the launcher to open the page (spec 6.7)', () => {
    const sent: object[] = [];
    const calls: string[] = [];
    const fake = (cmd: string) => {
      calls.push(cmd);
      return { unref() {}, on() {} };
    };
    const url = 'http://127.0.0.1:1/?token=t';
    expect(chrome.openPage(url, { launcher: 'electron', profileDir: '/p', send: (m) => sent.push(m), platform: 'darwin', spawnFn: fake })).toBe('electron');
    expect(sent).toEqual([{ t: 'open', url }]);
    expect(calls).toEqual([]);
    expect(chrome.openPage(url, { launcher: 'node', profileDir: '/p', send: null, platform: 'darwin', spawnFn: fake })).toBe('chrome');
    expect(calls).toEqual(['/usr/bin/open']);
    expect(chrome.openPage(url, { launcher: 'node', profileDir: '/p', send: null, platform: 'linux', spawnFn: fake })).toBeNull();
  });

  it('makes 32-byte hex tokens and compares them safely', () => {
    const t = guard.newToken();
    expect(t).toMatch(/^[0-9a-f]{64}$/);
    expect(guard.newToken()).not.toBe(t);
    expect(guard.sameToken(t, t)).toBe(true);
    expect(guard.sameToken(t, t.slice(1))).toBe(false);
    expect(guard.sameToken(null, t)).toBe(false);
    expect(guard.sameToken('', '')).toBe(false);
    expect(guard.parseCookies('a=1; ch_token=xyz').get('ch_token')).toBe('xyz');
  });

  it('gives a repeatable stream whose g follows the spec 7.5 formula', () => {
    const a = new synth.SyntheticStream({ seed: 7, talking: [[1000, 2000]] });
    const b = new synth.SyntheticStream({ seed: 7, talking: [[1000, 2000]] });
    const fa = [0, 0.5, 1.5].map((t) => a.frame(t));
    const fb = [0, 0.5, 1.5].map((t) => b.frame(t));
    expect(fa).toEqual(fb);
    const quiet = fa[0];
    const talking = fa[2];
    expect(quiet?.points).toHaveLength(16);
    expect(talking?.talking).toBe(1);
    expect(talking?.g ?? 0).toBeGreaterThan(quiet?.g ?? 1);
    // geometry: y[13] < y[14] and x[78] < x[308] (spec 7.12 smoke checks the same on the SDK)
    const p = synth.facePoints(10, 0, 0);
    const at = (id: number) => p[synth.LANDMARK_IDS.indexOf(id)] ?? [NaN, NaN];
    expect((at(13)[1] ?? 0) < (at(14)[1] ?? 0)).toBe(true);
    expect((at(78)[0] ?? 0) < (at(308)[0] ?? 0)).toBe(true);
    // median of 10, 9.5, 9.5, 8, 8 px over the 180 px eye distance
    expect(synth.lipGapFromPoints(p)).toBeCloseTo(9.5 / 180, 12);
  });
});

describe('SDK codes and the mock tap', () => {
  it('names codes exactly as the real tap does (live/reduce.cjs)', () => {
    expect(codes.PROCESSING_NAMES).toEqual(reduce.PROCESSING_NAMES);
    expect(codes.VALIDATION_NAMES).toEqual(reduce.VALIDATION_NAMES);
    expect(codes.ERROR_NAMES).toEqual(reduce.ERROR_NAMES);
    for (const code of [0, 2, 3, 4, 5, 6, 7, 8, 13, 14, 99]) {
      for (const canRestart of [true, false]) expect(codes.errorAction(code, canRestart)).toBe(reduce.errorAction(code, canRestart));
    }
    expect(mock.PROCESSING).toEqual({ idle: 1, starting: 2, running: 3, stopping: 4, error: 5 });
    expect(codes.PROCESSING_NAMES[mock.PROCESSING.running ?? -1]).toBe('kRunning');
    expect(codes.PROCESSING_NAMES[mock.PROCESSING.error ?? -1]).toBe('kError');
  });

  it('says what an SDK error means in one line (spec 7.1 table)', () => {
    expect(codes.KEY_MESSAGE).toBe('Check SMARTSPECTRA_API_KEY in .env');
    expect(codes.sdkErrorText(2, 'kAuthenticationFailed')).toBe('Check SMARTSPECTRA_API_KEY in .env');
    expect(codes.sdkErrorText(13, null, { smoke: true })).toMatch(/COPYHOLDER_METRICS=spare/);
    expect(codes.sdkErrorText(4, 'kCreditExhausted')).toBe('The SDK credits are used up (kCreditExhausted).');
    expect(codes.isRunningStatus('kRunning')).toBe(true);
    expect(codes.isRunningStatus('Running')).toBe(true);
    expect(codes.isRunningStatus('kStarting')).toBe(false);
    expect(codes.isRunningStatus(3)).toBe(false);
  });

  it('reads a mock script with defaults and drops malformed fields', () => {
    expect(mock.normalizeScript(undefined)).toMatchObject({
      rateHz: 30, startDelayMs: 300, firstPacketAfterMs: 0, stallAfterMs: null, idleAfterMs: null, errorAtMs: null, errorCode: 5,
      restartMs: 500, stopHangMs: null,
    });
    expect(mock.normalizeScript({ rateHz: 0, stallAfterMs: -1, codes: [{ atMs: 5, code: 1 }, { atMs: 'x', code: 2 }] }))
      .toMatchObject({ rateHz: 30, stallAfterMs: null, codes: [{ atMs: 5, code: 1 }] });
    expect(mock.normalizeScript({ idleAfterMs: 1200, stopHangMs: 'long', restartMs: -5 }))
      .toMatchObject({ idleAfterMs: 1200, stopHangMs: null, restartMs: 500 });
  });

  it('tells the age of the last packet in each pulse (spec 7.2, docs/protocol.md)', () => {
    expect(mock.pulseMessage(0, null, 5000)).toEqual({ t: 'pulse', packets: 0, last_ago_ms: null });
    expect(mock.pulseMessage(30, 4990.4, 5000)).toEqual({ t: 'pulse', packets: 30, last_ago_ms: 10 });
    expect(mock.pulseMessage(0, 1200, 5000)).toEqual({ t: 'pulse', packets: 0, last_ago_ms: 3800 });
    expect(mock.pulseMessage(1, 5001, 5000).last_ago_ms).toBe(0);
  });
});

describe('contracts with tap, quickcheck and the ledger', () => {
  it('keeps the timing of host and tap in one place', () => {
    expect(timing.PULSE_EVERY_MS).toBe(1000);
    expect(timing.TAP_SILENCE_MS).toBe(3000);
    // the silence is measured from tap's last packet, so a pulse period fits well inside it
    expect(timing.TAP_SILENCE_MS).toBeGreaterThanOrEqual(2 * timing.PULSE_EVERY_MS);
    expect(timing.TAP_STOP_BUDGET_MS).toBe(25_000);
  });

  // live/tap.cjs splits host's stop budget among its stop steps (live/reduce.cjs stopBudget); together
  // they must end before host kills it, also under the test hook that shortens the budget.
  const stopBudget = (requireCjs('../../live/reduce.cjs') as { stopBudget?: (env: string | undefined, total: number) => Record<string, unknown> }).stopBudget;
  it.skipIf(typeof stopBudget !== 'function')('lets tap finish its whole stop inside host\'s wait', () => {
    const total = (b: Record<string, unknown>) => Object.values(b).reduce<number>((a, v) => a + (typeof v === 'number' ? v : 0), 0);
    expect(total(stopBudget?.(undefined, timing.TAP_STOP_BUDGET_MS) ?? {})).toBeLessThan(timing.TAP_STOP_BUDGET_MS);
    expect(total(stopBudget?.('800', timing.TAP_STOP_BUDGET_MS) ?? {})).toBeLessThan(800);
  });

  it('takes the quickcheck verdict from the exit code for every record kind (spec 7.12)', () => {
    expect(quick.EXIT_PASS).toBe(0);
    expect(quick.EXIT_FAIL).toBe(2);
    expect(quick.quickcheckVerdict(0, 'checking gate-a\nGOOD RECORDING\n')).toEqual({ ok: true, text: 'GOOD RECORDING' });
    expect(quick.quickcheckVerdict(2, 'RE-RECORD NOW: audio gap\n')).toEqual({ ok: false, text: 'RE-RECORD NOW: audio gap' });
    expect(quick.quickcheckVerdict(0, 'DOCTOR OK\n')).toEqual({ ok: true, text: 'DOCTOR OK' });
    expect(quick.quickcheckVerdict(2, 'DOCTOR FAIL: leak\n\n')).toEqual({ ok: false, text: 'DOCTOR FAIL: leak' });
    expect(quick.quickcheckVerdict(0, 'SMOKE OK')).toEqual({ ok: true, text: 'SMOKE OK' });
    expect(quick.quickcheckVerdict(2, 'SMOKE FAIL: rate')).toEqual({ ok: false, text: 'SMOKE FAIL: rate' });
    expect(quick.quickcheckVerdict(1, 'Error: boom\n')).toEqual({ ok: null, text: 'Error: boom' });
    expect(quick.quickcheckVerdict(null, '')).toEqual({ ok: null, text: null });
    expect(quick.quickcheckVerdict(0, `${'x'.repeat(2000)}\n`).text).toHaveLength(1000);
  });

  it('writes a ledger only for the record kinds with a step order (spec 8.5)', () => {
    expect([...ledgerLib.LEDGER_KINDS]).toEqual([...LEDGER_KINDS]);
    for (const kind of RECORD_KINDS) expect(ledgerLib.isLedgerKind(kind), kind).toBe((LEDGER_KINDS as readonly string[]).includes(kind));
    // every mode's kind is a record kind
    for (const [mode, m] of Object.entries(args.MODES)) expect(RECORD_KINDS as readonly string[], mode).toContain(m.kind);
    expect(args.MODES['live-from']?.consent).toBe('replay');
  });
});
