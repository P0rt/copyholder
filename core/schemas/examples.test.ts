// Every complete example of examples.ts passes its validator through the file registry
// (spec 13.4 "Схемы": the files of section 8), written with the spec's key order.
import { describe, expect, it } from 'vitest';
import * as ex from './examples.ts';
import {
  FILE_FORMATS, formatForPath, toJsonText, toJsonlText, validateFileText, validateLedgerLine, validateSampleLine,
  type JsonlFile, type OrderedJsonFile,
} from './index.ts';

/** File name -> example document. */
const JSON_EXAMPLES: Readonly<Record<string, () => object>> = {
  'manifest.json': ex.exampleManifest,
  'data/s1/manifest.json': ex.exampleManifest,
  'calib.json': ex.exampleCalib,
  'quickcheck.json': ex.exampleQuickcheck,
  'clock_report.json': ex.exampleClockReport,
  'onsets.json': ex.exampleOnsets,
  'review.json': ex.exampleReview,
  'verdict.json': ex.exampleVerdict,
  'receipt.json': ex.exampleReceipt,
  'results.json': ex.exampleResults,
  'params/frozen.json': ex.exampleFrozenParams,
  'params/retune.json': ex.exampleFrozenParams,
  'scoring_rules.json': ex.exampleScoringRules,
  'freeze_manifest.json': ex.exampleFreezeManifest,
  'plan.json': ex.exampleSealedPlan,
  'timings.json': ex.exampleTimings,
  'texts.json': ex.exampleTexts,
  'audio_env.json': ex.exampleAudioEnv,
  'sentence_ends.json': ex.exampleSentenceEnds,
  'planted_times.json': ex.examplePlantedTimes,
};

/** File name -> example lines. */
const JSONL_EXAMPLES: Readonly<Record<JsonlFile, () => object[]>> = {
  'stamps.jsonl': ex.exampleStamps,
  'samples.jsonl': ex.exampleSamples,
  'detector_in.jsonl': ex.exampleDetectorIn,
  'stream.jsonl': ex.exampleStream,
  'events.jsonl': ex.exampleEvents,
  'ledger.jsonl': () => [ex.exampleLedgerLine()],
  'sdk_raw.jsonl': () => [
    { seq: 5417, kind: 'metrics', tArrNs: '812345678901234', tWallMs: 1794935111190, tsCbUs: 1794935111156789, b64: 'AAEC' },
    { seq: 5418, kind: 'error', tArrNs: '812345712345678', tWallMs: 1794935111224, args: [8, 'kCameraError'] },
  ],
};

const ORDERED: readonly string[] = [
  'manifest.json', 'calib.json', 'clock_report.json', 'onsets.json', 'params/frozen.json', 'freeze_manifest.json', 'audio_env.json',
];

describe('examples.ts: a complete, valid example of every file format', () => {
  for (const [name, make] of Object.entries(JSON_EXAMPLES)) {
    it(name, () => {
      const file = ORDERED.includes(name) ? (name as OrderedJsonFile) : null;
      expect(validateFileText(name, toJsonText(make(), file))).toEqual([]);
      // Pretty-printed files read the same.
      expect(validateFileText(name, toJsonText(make(), file, 2))).toEqual([]);
    });
  }
  for (const [name, make] of Object.entries(JSONL_EXAMPLES)) {
    it(name, () => {
      expect(validateFileText(name, toJsonlText(make(), name as JsonlFile))).toEqual([]);
    });
  }

  it('every format of the registry has an example', () => {
    const covered = new Set<string>();
    for (const name of [...Object.keys(JSON_EXAMPLES), ...Object.keys(JSONL_EXAMPLES)]) {
      const f = formatForPath(name);
      expect(f, name).not.toBeNull();
      const key = Object.entries(FILE_FORMATS).find(([, v]) => v === f)?.[0];
      if (key !== undefined) covered.add(key);
    }
    expect([...covered].sort()).toEqual(Object.keys(FILE_FORMATS).sort());
  });

  it('returns fresh copies', () => {
    const a = ex.exampleReceipt();
    a.planted.events.length = 0;
    expect(ex.exampleReceipt().planted.events).toHaveLength(9);
  });

  it('the samples example carries all 16 face points; the ledger example is one well-formed line', () => {
    const [packet] = ex.exampleSamples();
    expect(validateSampleLine(packet)).toEqual([]);
    expect(validateLedgerLine(ex.exampleLedgerLine())).toEqual([]);
  });
});

describe('validateFileText and formatForPath', () => {
  it('picks the format by file name; a manifest inside data/<id>/ is the public copy', () => {
    expect(formatForPath('sessions/s1/stamps.jsonl')?.format).toBe('jsonl');
    expect(formatForPath('C:\\sessions\\s1\\calib.json')?.spec).toBe('8.1');
    expect(formatForPath('data/s1/manifest.json')).toBe(FILE_FORMATS['data/manifest.json']);
    expect(formatForPath('sessions/s1/manifest.json')).toBe(FILE_FORMATS['manifest.json']);
    expect(formatForPath('params/frozen.json')).toBe(FILE_FORMATS['frozen.json']);
    expect(formatForPath('notes.txt')).toBeNull();
  });

  it('prefixes every problem with the path and, for JSONL, the line number', () => {
    expect(validateFileText('x/notes.txt', '')).toEqual(['x/notes.txt: no schema for this file name']);
    const stamps = '{"n":0,"k":"chunk","frames":9600}\n{"n":9600,"k":"chunk","frames":0}\n';
    expect(validateFileText('sessions/s1/stamps.jsonl', stamps)).toEqual([
      'sessions/s1/stamps.jsonl line 2: frames: expected a frame count (positive integer) >= 1, got 0',
    ]);
    expect(validateFileText('calib.json', '{"schema":"calib/2"}')).toEqual(['calib.json: schema: expected "calib/1", got "calib/2"']);
    expect(validateFileText('data/s1/manifest.json', '{')[0]).toMatch(/^data\/s1\/manifest\.json: not valid JSON/);
  });

  it('the public manifest refuses local paths that the session copy may keep', () => {
    const m = { ...ex.exampleManifest(), paths: { session: '/Users/someone/copyholder/sessions/s1' } };
    expect(validateFileText('sessions/s1/manifest.json', JSON.stringify(m))).toEqual([]);
    expect(validateFileText('data/s1/manifest.json', JSON.stringify(m))).toEqual([
      'data/s1/manifest.json: paths: not allowed in the published manifest (spec 8.7: local paths removed)',
    ]);
  });
});
