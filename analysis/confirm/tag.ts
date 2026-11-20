// The tag gate-retune beyond params/retune.json (PREREG.md section 11): "npm run freeze --
// gate-retune freezes them together with the pooled analysis code below, and the tag is pushed
// before pack B is recorded". npm run confirm compares its own code with the copy under the tag,
// and the time git gives the tag with the start of each recording of pack B and C. A difference
// does not stop the numbers: they are computed and marked not confirmatory, with the reasons.
// The push itself leaves no time in the clone; the tag's own time stands for it.

import fs from 'node:fs';
import path from 'node:path';
import { REPO_ROOT } from '../lib/paths.ts';
import { RETUNE_TAG } from '../gate/frozen.ts';
import type { ConfirmDeps } from './deps.ts';

/** The pooled analysis code that gate-retune freezes: analysis/confirm.ts and every file of analysis/confirm/ but the tests. */
export function confirmCodeFiles(root: string = REPO_ROOT): string[] {
  const dir = path.join(root, 'analysis', 'confirm');
  const names = fs
    .readdirSync(dir)
    .filter((n) => n.endsWith('.ts') && !n.endsWith('.test.ts'))
    .sort();
  return [path.join(root, 'analysis', 'confirm.ts'), ...names.map((n) => path.join(dir, n))];
}

function repoPath(file: string, root: string): string {
  return path.relative(root, file).split(path.sep).join('/');
}

/** Each file that is not under the tag, or differs from its copy there; empty when all match. */
export function codeDifferences(files: readonly string[], tagFile: ConfirmDeps['tagFile'], root: string = REPO_ROOT): string[] {
  const out: string[] = [];
  for (const file of files) {
    const tagged = tagFile(RETUNE_TAG, file);
    if (tagged === null) out.push(`${repoPath(file, root)} is not under the tag ${RETUNE_TAG}`);
    else if (tagged !== fs.readFileSync(file, 'utf8')) out.push(`${repoPath(file, root)} differs from its copy under the tag ${RETUNE_TAG}`);
  }
  return out;
}

/** A recording of pack B or C, by its start (manifest.json started_utc). */
export interface RecordingStart {
  pack: string;
  id: string;
  startedUtc: string;
}

export interface RetuneTagFacts {
  tag: string;
  /** When git says the tag was made; null when it could not be read. */
  tagTime: string | null;
  recordings: RecordingStart[];
  /** The pooled analysis code compared with the tag, as repository paths. */
  codeFiles: string[];
  codeDifferences: string[];
  /** Why the numbers are not confirmatory; empty when they are. */
  problems: string[];
}

/**
 * The conditions of section 11 on the tag gate-retune that params/retune.json alone does not show:
 * the pooled analysis code is the copy under the tag, and the tag came before each recording.
 */
export function retuneTagFacts(recordings: readonly RecordingStart[], deps: Pick<ConfirmDeps, 'tagFile' | 'tagTime'>, root: string = REPO_ROOT): RetuneTagFacts {
  const files = confirmCodeFiles(root);
  const differences = codeDifferences(files, deps.tagFile, root);
  const problems = differences.map((d) => `the pooled analysis code is not the code frozen with the parameters: ${d}`);
  const tagTime = deps.tagTime(RETUNE_TAG);
  if (tagTime === null) {
    problems.push(`the time of the tag ${RETUNE_TAG} could not be read from git, so it is not shown to come before the recordings`);
  } else {
    for (const r of recordings) {
      if (!(Date.parse(tagTime) < Date.parse(r.startedUtc))) {
        problems.push(`the tag ${RETUNE_TAG} (${tagTime}) is not earlier than the start of pack ${r.pack} (${r.id}) at ${r.startedUtc}: the parameters were not frozen before that pack was recorded`);
      }
    }
  }
  return { tag: RETUNE_TAG, tagTime, recordings: [...recordings], codeFiles: files.map((f) => repoPath(f, root)), codeDifferences: differences, problems };
}
