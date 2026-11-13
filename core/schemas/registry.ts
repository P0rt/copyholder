// File name -> format and validator, for commands that check a whole folder (pack, verify,
// quickcheck) and for tests of other modules.

import type { Validator } from './check.ts';
import { parseJson, parseJsonl } from './jsonl.ts';
import { validateLedgerLine } from './ledger.ts';
import { validateFrozenParams, validateScoringRules } from './params.ts';
import { validateFreezeManifest, validateSealedPlan, validateTexts, validateTimings } from './plan.ts';
import {
  validateAudioEnv, validatePlantedTimes, validatePublishedManifest, validateSentenceEnds, validateStreamLine,
} from './published.ts';
import { validateReceipt } from './receipt.ts';
import {
  validateCalib, validateClockReport, validateOnsets, validateQuickcheck, validateReview, validateVerdict,
} from './reports.ts';
import { validateResults } from './results.ts';
import {
  validateDetectorInLine, validateEventLine, validateManifest, validateSampleLine, validateSdkRawLine, validateStampLine,
} from './session.ts';

export interface FileFormat {
  /** "jsonl": one validated object per line; "json": one validated document. */
  format: 'json' | 'jsonl';
  validate: Validator<unknown>;
  /** Spec section that defines the file. */
  spec: string;
}

const json = (validate: Validator<unknown>, spec: string): FileFormat => ({ format: 'json', validate, spec });
const jsonl = (validate: Validator<unknown>, spec: string): FileFormat => ({ format: 'jsonl', validate, spec });

/**
 * Formats by file name. sdk_raw.jsonl is the line format inside sdk_raw.jsonl.gz.
 * "data/manifest.json" stands for the public copy in data/<id>/.
 */
export const FILE_FORMATS: Readonly<Record<string, FileFormat>> = {
  'manifest.json': json(validateManifest, '8.1'),
  'stamps.jsonl': jsonl(validateStampLine, '8.1'),
  'samples.jsonl': jsonl(validateSampleLine, '8.1'),
  'sdk_raw.jsonl': jsonl(validateSdkRawLine, '8.1'),
  'detector_in.jsonl': jsonl(validateDetectorInLine, '8.1'),
  'events.jsonl': jsonl(validateEventLine, '8.1'),
  'calib.json': json(validateCalib, '8.1'),
  'quickcheck.json': json(validateQuickcheck, '8.1, 7.12'),
  'clock_report.json': json(validateClockReport, '8.1, 7.12'),
  'onsets.json': json(validateOnsets, '8.1, 7.6'),
  'review.json': json(validateReview, '8.1, 7.9'),
  'verdict.json': json(validateVerdict, '8.1, 9.7'),
  'ledger.jsonl': jsonl(validateLedgerLine, '8.5'),
  'receipt.json': json(validateReceipt, '8.6'),
  'results.json': json(validateResults, '8.6'),
  'frozen.json': json(validateFrozenParams, '8.4'),
  'retune.json': json(validateFrozenParams, '8.4'),
  'scoring_rules.json': json(validateScoringRules, '8.4'),
  'freeze_manifest.json': json(validateFreezeManifest, '8.4'),
  'plan.json': json(validateSealedPlan, '8.3'),
  'timings.json': json(validateTimings, '8.2'),
  'texts.json': json(validateTexts, '8.2'),
  'stream.jsonl': jsonl(validateStreamLine, '8.7'),
  'audio_env.json': json(validateAudioEnv, '8.7'),
  'sentence_ends.json': json(validateSentenceEnds, '8.7'),
  'planted_times.json': json(validatePlantedTimes, '8.7'),
  'data/manifest.json': json(validatePublishedManifest, '8.7'),
};

/** Format of a path: by file name; a manifest.json inside data/<id>/ is the public copy. */
export function formatForPath(path: string): FileFormat | null {
  const norm = path.replace(/\\/g, '/');
  if (/(^|\/)data\/[^/]+\/manifest\.json$/.test(norm)) return FILE_FORMATS['data/manifest.json'] ?? null;
  const name = norm.slice(norm.lastIndexOf('/') + 1);
  return FILE_FORMATS[name] ?? null;
}

/**
 * Validates a file's text by its path. Messages start with the file name and, for JSONL,
 * the line number. An unknown file name gives one problem.
 * Note: a valid ledger.jsonl here is only well-formed lines; use verifyLedger for the chain.
 */
export function validateFileText(path: string, text: string): string[] {
  const f = formatForPath(path);
  if (f === null) return [`${path}: no schema for this file name`];
  return f.format === 'jsonl'
    ? parseJsonl(text, f.validate, { file: path }).errors
    : parseJson(text, f.validate, { file: path }).errors;
}
