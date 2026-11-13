// Test-only: checks the lines Deck and the worker produce against core/schemas and the key order of
// the spec 8.1 examples (host writes each line with JSON.stringify as it arrives). No test runner
// import, so Vitest and Playwright both use it.

import { orderKeys, validateDetectorInLine, validateEventLine, validateStampLine } from '../core.ts';

export type LineFile = 'stamps.jsonl' | 'detector_in.jsonl' | 'events.jsonl';

const VALIDATORS: Record<LineFile, (value: unknown) => string[]> = {
  'stamps.jsonl': validateStampLine,
  'detector_in.jsonl': validateDetectorInLine,
  'events.jsonl': validateEventLine,
};

/** Schema errors and key-order differences of lines meant for one file; [] when every line passes. */
export function lineProblems(file: LineFile, lines: readonly unknown[]): string[] {
  const out: string[] = [];
  for (const line of lines) {
    const text = JSON.stringify(line);
    for (const e of VALIDATORS[file](line)) out.push(`${file} ${text}: ${e}`);
    const canonical = JSON.stringify(orderKeys(line, file));
    if (canonical !== text) out.push(`${file} ${text}: key order should be ${canonical}`);
  }
  return out;
}
