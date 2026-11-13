// Deck and the recomputation after a recording pick the same voice detector parameters from the
// same files (spec 7.3, 7.12): params/frozen.json and the doctor calib.json files. Deck's side runs
// as on the Mac: host builds GET /api/config from the files (live/lib/calib.cjs), the page picks
// from it (web/ui/deck-options.ts); analysis reads the files itself (analysis/lib/calib-io.ts).

import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DEFAULT_VAD_PARAMS, type VadParams } from '../../core/vad/index.ts';
import { buildGatePreregParams, frozenParamsText } from '../../tools/freeze/params.ts';
import { chooseDeckVadParams } from '../../web/ui/deck-options.ts';
import { chooseVadParams } from './calib-io.ts';

const requireCjs = createRequire(import.meta.url);
const host = requireCjs('../../live/lib/calib.cjs') as {
  pageCalib(sessionsDir: string): { calib: Record<string, unknown> | null };
  detectorSetup(frozenParamsFile: string, calib: unknown): { params: Record<string, unknown>; sign: number; variant: string };
};

let root = '';

beforeAll(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'vad-choice-'));
});

afterAll(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

const LRT = { A: 23.4, B: 23.6, rule: 'mean', used: 23.5 };
const vad = (floor: number, periodicity: number) => ({ floor_db: floor, periodicity });

/** Doctor folders: calib.json as doctor writes it (a level run copies the vad block of its full run). */
const SESSIONS: Record<string, Record<string, Record<string, unknown> | null>> = {
  none: {},
  'one doctor': { 'doctor-1': { L_rt_ms: LRT, vad: vad(-61.2, 0.55), output_gain: 0.3 } },
  'level run and a full run without the quiet step': {
    'doctor-1': { L_rt_ms: LRT, vad: vad(-61.2, 0.55), output_gain: 0.3 },
    'doctor-2': { L_rt_ms: LRT, vad: vad(-61.2, 0.55), output_gain: 0.25, leak_db_over_floor: 3.1 },
    'doctor-3': { L_rt_ms: LRT, output_gain: 0.25 },
    'doctor-4': null, // a failed run: no calib.json
  },
  'two full runs, numbered past 9': {
    'doctor-2': { L_rt_ms: LRT, vad: vad(-61.2, 0.55) },
    'doctor-10': { L_rt_ms: LRT, vad: vad(-57.9, 0.65) },
  },
  'a vad block without a threshold': { 'doctor-1': { L_rt_ms: LRT, vad: { floor_db: -60 } } },
};

/** params/frozen.json variants; null: no file yet. */
const FROZEN: Record<string, string | null> = {
  'no file': null,
  'gate-prereg with doctor values': frozenParamsText(buildGatePreregParams({ id: 'doctor-1', floorDb: -63.1, periodicity: 0.6 }).params),
  'gate-prereg without doctor values': frozenParamsText(buildGatePreregParams(null).params),
  'the spec 8.4 example block': JSON.stringify({ vad: { highpass_hz: 150, hop_ms: 5, over_floor_db: 15, periodicity: 0.5, on_ms: [30, 50], off_ms: 1200 } }),
  'a block without floor_db, other keys changed': JSON.stringify({ vad: { periodicity: 0.45, over_floor_db: 12, off_ms: 900 } }),
  'a block core/vad cannot use': JSON.stringify({ vad: { periodicity: 'high', off_ms: 900 } }),
  'not JSON': '{"vad": ',
};

function writeFixture(name: string, sessions: Record<string, Record<string, unknown> | null>, frozen: string | null): { sessionsDir: string; frozenFile: string } {
  const base = path.join(root, name.replace(/[^a-z0-9]+/gi, '-'));
  const sessionsDir = path.join(base, 'sessions');
  fs.mkdirSync(sessionsDir, { recursive: true });
  for (const [id, calib] of Object.entries(sessions)) {
    fs.mkdirSync(path.join(sessionsDir, id), { recursive: true });
    if (calib !== null) fs.writeFileSync(path.join(sessionsDir, id, 'calib.json'), JSON.stringify({ schema: 'calib/1', ...calib }));
  }
  const frozenFile = path.join(base, 'params', 'frozen.json');
  if (frozen !== null) {
    fs.mkdirSync(path.dirname(frozenFile), { recursive: true });
    fs.writeFileSync(frozenFile, frozen);
  }
  return { sessionsDir, frozenFile };
}

/** Both choosers on one fixture: Deck through the /api/config host builds, analysis on the files. */
function bothChoices(sessionsDir: string, frozenFile: string) {
  const { calib } = host.pageCalib(sessionsDir);
  const config = { mode: 'gate', detector: host.detectorSetup(frozenFile, calib), calib };
  const deck = chooseDeckVadParams(config);
  const analysis = chooseVadParams({ COPYHOLDER_SESSIONS_DIR: sessionsDir, COPYHOLDER_PARAMS_FILE: frozenFile });
  return { deck, analysis };
}

const CASES = Object.entries(SESSIONS).flatMap(([s, sessions]) => Object.entries(FROZEN).map(([f, frozen]) => ({ name: `${s} / ${f}`, sessions, frozen })));

describe('Deck and analysis pick the same voice detector parameters (spec 7.3, 7.12)', () => {
  it.each(CASES)('$name', ({ name, sessions, frozen }) => {
    const { sessionsDir, frozenFile } = writeFixture(name, sessions, frozen);
    const { deck, analysis } = bothChoices(sessionsDir, frozenFile);
    const deckParams: VadParams = deck?.params ?? DEFAULT_VAD_PARAMS;
    if (analysis?.params.floorDb !== undefined) {
      // A floor is known (frozen or doctor): every field the same.
      expect(deckParams).toEqual({ ...DEFAULT_VAD_PARAMS, ...analysis.params });
    } else {
      // Nobody measured a floor: Deck, which cannot measure ahead, runs the placeholder floor;
      // analysis measures the floor on the recording. Every other field the same.
      expect(deckParams.floorDb).toBe(DEFAULT_VAD_PARAMS.floorDb);
      expect({ ...deckParams, floorDb: 0 }).toEqual({ ...DEFAULT_VAD_PARAMS, ...analysis?.params, floorDb: 0 });
    }
  });

  it('a block without floor_db takes the floor and the threshold of doctor, and keeps its other keys', () => {
    const { sessionsDir, frozenFile } = writeFixture('without floor', SESSIONS['one doctor']!, FROZEN['a block without floor_db, other keys changed']!);
    const { deck, analysis } = bothChoices(sessionsDir, frozenFile);
    const want = { ...DEFAULT_VAD_PARAMS, floorDb: -61.2, periodicity: 0.55, overFloorDb: 12, offMs: 900 };
    expect(deck?.params).toEqual(want);
    expect(analysis?.params).toEqual(want);
    expect(deck?.source).toBe(
      'params/frozen.json with the floor measured by doctor and its periodicity threshold (the file has no floor_db) (floor -61.2 dB, periodicity 0.55)',
    );
    expect(analysis?.source).toBe('params/frozen.json (it has no floor_db) with the floor -61.2 dB and the periodicity 0.55 of doctor doctor-1');
  });

  it('a block with floor_db is taken as written, over the doctor values', () => {
    const { sessionsDir, frozenFile } = writeFixture('with floor', SESSIONS['two full runs, numbered past 9']!, FROZEN['gate-prereg with doctor values']!);
    const { deck, analysis } = bothChoices(sessionsDir, frozenFile);
    expect(deck?.params).toMatchObject({ floorDb: -63.1, periodicity: 0.6 });
    expect(analysis?.params).toEqual(deck?.params);
  });

  it('without params/frozen.json, the vad block of the highest doctor-<n> that wrote one', () => {
    for (const [s, want] of [
      ['two full runs, numbered past 9', { floorDb: -57.9, periodicity: 0.65, id: 'doctor-10' }],
      ['level run and a full run without the quiet step', { floorDb: -61.2, periodicity: 0.55, id: 'doctor-2' }],
    ] as const) {
      const { sessionsDir, frozenFile } = writeFixture(`doctor only ${s}`, SESSIONS[s]!, null);
      const { deck, analysis } = bothChoices(sessionsDir, frozenFile);
      expect(deck?.params).toEqual({ ...DEFAULT_VAD_PARAMS, floorDb: want.floorDb, periodicity: want.periodicity });
      expect(analysis?.params).toEqual(deck?.params);
      expect(analysis?.source).toBe(`doctor ${want.id} (floor ${want.floorDb} dB, periodicity ${want.periodicity})`);
    }
  });

  it('nothing to pick: Deck runs its defaults, analysis measures the floor on the recording', () => {
    const { sessionsDir, frozenFile } = writeFixture('nothing', SESSIONS['a vad block without a threshold']!, FROZEN['a block core/vad cannot use']!);
    const { deck, analysis } = bothChoices(sessionsDir, frozenFile);
    expect(deck).toBeNull();
    expect(analysis).toBeNull();
  });
});
