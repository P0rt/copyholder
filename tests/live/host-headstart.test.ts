// headstart in /api/config (docs/protocol.md): the SDK version of live/package.json for the info line of
// the live view (spec 15.1, 15.2), and `lensCheck`, whether the signal check after the summary covers
// the lens. Spec 15.2: smoke tries the covered lens in advance (spec 7.12, question 7); if that raised an
// SDK error event, the signal check keeps only the deep breath. live/lib/lens-check.cjs reads the newest
// smoke_report.json that reached the lens step; settings.env COPYHOLDER_LENS_CHECK (on, off) wins.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ROOT, makeSandbox, requireCjs, startHost, type HostRun, type Sandbox } from './helpers.ts';

const lensCheck = requireCjs('../../live/lib/lens-check.cjs') as {
  SETTING: string;
  smokeLensAnswer(sessionsDir: string): { id: string; errors: number } | null;
  headstartLensCheck(sessionsDir: string, setting: unknown): { lens: boolean; why: string };
};

/** The SDK version live/package.json names (the dependency of live/tap.cjs). */
const SDK_VERSION = (JSON.parse(readFileSync(join(ROOT, 'live', 'package.json'), 'utf8')) as { dependencies: Record<string, string> })
  .dependencies['@smartspectra/node-sdk'];

/** sessions/<id>/smoke_report.json with the lens answer as analysis/smoke/report.ts writes it (spec 7.12, question 7). */
function writeSmokeReport(sessions: string, id: string, lens: Record<string, unknown> | null): void {
  const dir = join(sessions, id);
  mkdirSync(dir, { recursive: true });
  const questions: Record<string, unknown> = {
    q6_reload: { title: 'Reload', answer: ['...'] },
  };
  if (lens !== null) questions.q7_lens_cover = { title: 'Lens cover', answer: ['...'], ...lens };
  writeFileSync(join(dir, 'smoke_report.json'), JSON.stringify({ schema: 'smoke-report/1', id, questions }, null, 2));
}

const COVERED_CLEAN = { covered: true, cover_start_s: 120.5, cover_s: 5, errors: [] };
const COVERED_ERROR = {
  covered: true,
  cover_start_s: 120.5,
  cover_s: 5,
  errors: [{ code: 5, name: 'kNetworkError', message: 'no face' }],
};
const NOT_REACHED = { covered: false };

describe('lens-check.cjs: does the signal check of headstart cover the lens (spec 15.2)', () => {
  let sb: Sandbox;
  beforeEach(() => {
    sb = makeSandbox();
  });
  afterEach(() => sb.cleanup());

  it('keeps the lens when no smoke run reached the lens step', () => {
    expect(lensCheck.SETTING).toBe('COPYHOLDER_LENS_CHECK');
    expect(lensCheck.smokeLensAnswer(sb.sessions)).toBeNull();
    expect(lensCheck.headstartLensCheck(sb.sessions, '')).toEqual({ lens: true, why: 'no smoke report with the lens step' });
    // a missing sessions folder, a run without a report, a report without question 7, one that ended before it
    expect(lensCheck.headstartLensCheck(join(sb.dir, 'nowhere'), '').lens).toBe(true);
    mkdirSync(join(sb.sessions, 'smoke-1'));
    writeSmokeReport(sb.sessions, 'smoke-2', null);
    writeSmokeReport(sb.sessions, 'smoke-3', NOT_REACHED);
    expect(lensCheck.smokeLensAnswer(sb.sessions)).toBeNull();
    expect(lensCheck.headstartLensCheck(sb.sessions, undefined).lens).toBe(true);
  });

  it('leaves the lens out when the covered lens raised an SDK error in smoke', () => {
    writeSmokeReport(sb.sessions, 'smoke-1', COVERED_ERROR);
    expect(lensCheck.smokeLensAnswer(sb.sessions)).toEqual({ id: 'smoke-1', errors: 1 });
    expect(lensCheck.headstartLensCheck(sb.sessions, '')).toEqual({
      lens: false,
      why: 'smoke-1: the covered lens raised an SDK error',
    });
  });

  it('the newest smoke run that reached the lens step decides, by run number', () => {
    writeSmokeReport(sb.sessions, 'smoke-2', COVERED_ERROR);
    writeSmokeReport(sb.sessions, 'smoke-9', COVERED_ERROR);
    writeSmokeReport(sb.sessions, 'smoke-10', COVERED_CLEAN); // newer than smoke-9, though it sorts first as text
    writeSmokeReport(sb.sessions, 'smoke-11', NOT_REACHED); // ended before the lens step: skipped
    writeSmokeReport(sb.sessions, 'smoke-x', COVERED_ERROR); // not a smoke run name
    writeSmokeReport(sb.sessions, 'gate-12', COVERED_ERROR); // not a smoke run
    mkdirSync(join(sb.sessions, 'smoke-12'));
    writeFileSync(join(sb.sessions, 'smoke-12', 'smoke_report.json'), '{ not json');
    expect(lensCheck.smokeLensAnswer(sb.sessions)).toEqual({ id: 'smoke-10', errors: 0 });
    expect(lensCheck.headstartLensCheck(sb.sessions, '')).toEqual({ lens: true, why: 'smoke-10: no SDK error on the covered lens' });
  });

  it('COPYHOLDER_LENS_CHECK on or off wins over smoke, in any case; other values defer to smoke', () => {
    writeSmokeReport(sb.sessions, 'smoke-1', COVERED_ERROR);
    expect(lensCheck.headstartLensCheck(sb.sessions, 'on')).toEqual({ lens: true, why: 'COPYHOLDER_LENS_CHECK=on' });
    expect(lensCheck.headstartLensCheck(sb.sessions, ' ON ')).toEqual({ lens: true, why: 'COPYHOLDER_LENS_CHECK=on' });
    expect(lensCheck.headstartLensCheck(sb.sessions, 'yes').lens).toBe(false);
    const clean = makeSandbox();
    try {
      expect(lensCheck.headstartLensCheck(clean.sessions, 'Off')).toEqual({ lens: false, why: 'COPYHOLDER_LENS_CHECK=off' });
      expect(lensCheck.headstartLensCheck(clean.sessions, 'maybe').lens).toBe(true);
    } finally {
      clean.cleanup();
    }
  });
});

describe('host --mode headstart: /api/config for the live view and the signal check', () => {
  let sb: Sandbox;
  let host: HostRun | null = null;

  beforeEach(() => {
    sb = makeSandbox();
  });

  afterEach(async () => {
    if (host) {
      host.kill();
      await host.exited;
      host = null;
    }
    sb.cleanup();
  });

  /** headstart with the mock tap; COPYHOLDER_LENS_CHECK empty unless given, so no settings.env decides. */
  async function headstart(env: Record<string, string> = {}): Promise<Record<string, unknown>> {
    host = await startHost(sb, ['--mode', 'headstart', '--tap', 'mock'], { COPYHOLDER_LENS_CHECK: '', ...env });
    return (await host.config()) as unknown as Record<string, unknown>;
  }

  it('carries the SDK version of live/package.json and keeps the lens by default', async () => {
    expect(SDK_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
    const cfg = await headstart();
    expect(cfg).toMatchObject({ mode: 'headstart', tap: 'mock', sdkVersion: SDK_VERSION, lensCheck: true });
    expect(host!.out()).not.toMatch(/keeps only the deep breath/);
  });

  it('leaves the lens out after a smoke run whose covered lens raised an SDK error, and says why', async () => {
    writeSmokeReport(sb.sessions, 'smoke-1', COVERED_ERROR);
    const cfg = await headstart();
    expect(cfg).toMatchObject({ mode: 'headstart', lensCheck: false, sdkVersion: SDK_VERSION });
    expect(host!.out()).toMatch(/The signal check keeps only the deep breath, without the covered lens \(spec 15\.2\): smoke-1: the covered lens raised an SDK error\./);
  });

  it('keeps the lens after a smoke run without an SDK error on the covered lens', async () => {
    writeSmokeReport(sb.sessions, 'smoke-1', COVERED_CLEAN);
    expect(await headstart()).toMatchObject({ lensCheck: true });
  });

  it('COPYHOLDER_LENS_CHECK=on keeps the lens despite smoke; =off leaves it out', async () => {
    writeSmokeReport(sb.sessions, 'smoke-1', COVERED_ERROR);
    expect(await headstart({ COPYHOLDER_LENS_CHECK: 'on' })).toMatchObject({ lensCheck: true });
    host!.kill();
    await host!.exited;
    host = null;
    const clean = makeSandbox();
    try {
      const h = await startHost(clean, ['--mode', 'headstart', '--tap', 'mock'], { COPYHOLDER_LENS_CHECK: 'off' });
      host = h;
      expect(await h.config()).toMatchObject({ lensCheck: false });
      expect(h.out()).toMatch(/keeps only the deep breath.*COPYHOLDER_LENS_CHECK=off\./);
      h.kill();
      await h.exited;
      host = null;
    } finally {
      clean.cleanup();
    }
  });

  it('other modes carry sdkVersion too, but no lensCheck', async () => {
    host = await startHost(sb, ['--mode', 'gate', '--pack', 'A', '--tap', 'mock'], { COPYHOLDER_LENS_CHECK: 'off' });
    const cfg = (await host.config()) as unknown as Record<string, unknown>;
    expect(cfg).toMatchObject({ mode: 'gate', sdkVersion: SDK_VERSION });
    expect('lensCheck' in cfg).toBe(false);
    expect(host.out()).not.toMatch(/keeps only the deep breath/);
  });
});
