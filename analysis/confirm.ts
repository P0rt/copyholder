// npm run confirm -- <idB> [<idC>] [--dev <idA>]   the pooled confirmation of PREREG.md section 11
//
// Checks first, before anything is computed: one gate recording of pack B and one of pack C, all
// their files as their steps wrote them, and params/frozen.json as the retune froze it (equal to
// params/retune.json and to its copy under the tag gate-retune). A recording with GOOD RECORDING
// needs its finished confirmatory stage B, run on that file; stage B's computation runs again on
// it and must give the verdict.json stage B wrote. One that failed quickcheck on condition 6 alone
// (too few replies) is scored here with stage B's function and stays in the numbers, flagged; one
// that failed for a technical reason after 4:15, or that the SDK ended with kCreditExhausted at any
// time, is lost and reported with its reason (section 11).
// Pack B alone, without <idC>: the numbers of pack B alone, flagged, which section 11 gives when
// pack C cannot be started for lack of SDK credits. It is refused while the sessions folder holds a
// pack C recording other than one that failed for a technical reason before 4:15.
// The numbers of section 11 are pooled over the valid objections of the packs in the numbers.
// The output is marked not confirmatory when the pooled analysis code differs from its copy under
// gate-retune, or the tag is not earlier than the recordings.
// --dev <idA>   also the numbers of the pack A recording, printed apart as development data
// Writes results/confirm.json and results/confirm.md; session folders are only read.
// Exit codes: 0 done, 1 refused (nothing written), 2 usage.

import { isMainModule } from './lib/cli.ts';
import { ConfirmRefusal } from './confirm/common.ts';
import { defaultConfirmDeps, type ConfirmDeps } from './confirm/deps.ts';
import { runConfirm } from './confirm/run.ts';
import { GateRefusal } from './gate/common.ts';

export const USAGE = 'usage: npm run confirm -- <idB> [<idC>] [--dev <idA>]';

export interface ConfirmArgs {
  /** The recordings of packs B and C, or pack B alone. */
  ids: string[];
  dev: string | null;
}

/** Parses the command line; returns a message for a usage error. */
export function parseConfirmArgs(argv: readonly string[]): ConfirmArgs | string {
  const ids: string[] = [];
  let dev: string | null = null;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === '--dev') {
      const v = argv[++i];
      if (v === undefined || v.startsWith('-')) return '--dev needs the pack A recording id';
      if (dev !== null) return '--dev is given twice';
      dev = v;
    } else if (a.startsWith('--dev=')) {
      if (dev !== null) return '--dev is given twice';
      dev = a.slice('--dev='.length);
      if (dev === '') return '--dev needs the pack A recording id';
    } else if (a.startsWith('-')) {
      return `unknown option ${a}`;
    } else {
      ids.push(a);
    }
  }
  if (ids.length < 1 || ids.length > 2) {
    return `one or two recording ids are required: those of packs B and C, or pack B alone when pack C has no recording (got ${ids.length})`;
  }
  return { ids, dev };
}

export function main(argv: readonly string[], deps: ConfirmDeps = defaultConfirmDeps()): number {
  const args = parseConfirmArgs(argv);
  if (typeof args === 'string') {
    deps.error(`${args}\n${USAGE}`);
    return 2;
  }
  try {
    runConfirm({ ids: args.ids, dev: args.dev, deps });
    return 0;
  } catch (e) {
    if (e instanceof ConfirmRefusal || e instanceof GateRefusal) {
      deps.error(`confirm refused: ${e.message}`);
      return 1;
    }
    throw e;
  }
}

if (isMainModule(import.meta.url)) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (e) {
    process.stderr.write(`confirm failed: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}\n`);
    process.exitCode = 1;
  }
}
