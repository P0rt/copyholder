// npm run analyze:gate -- --stage A <id>   tune k and theta_G on the recording up to 4:15 (spec 9.5)
// npm run analyze:gate -- --stage B <id>   open the objection block once and write the verdict
// --exploratory   any run after the confirmatory stage B; marks every output and ledger line
// --params <file> exploratory stage B only: score with another params file
// --no-other      leave out the descriptive OTHER line (T and M), spec 14.4
// Exit codes: 0 done, 1 refused (nothing written), 2 usage.

import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { GateRefusal } from './gate/common.ts';
import { defaultGateDeps, type GateDeps } from './gate/deps.ts';
import { runStageA } from './gate/stage-a.ts';
import { runStageB } from './gate/stage-b.ts';

export const USAGE = [
  'usage: npm run analyze:gate -- --stage A <id> [--exploratory]',
  '       npm run analyze:gate -- --stage B <id> [--exploratory] [--params <file>] [--no-other]',
].join('\n');

export interface GateArgs {
  stage: 'A' | 'B';
  id: string;
  exploratory: boolean;
  paramsFile: string | null;
  skipOther: boolean;
}

/** Parses the command line; returns a message for a usage error. */
export function parseGateArgs(argv: readonly string[]): GateArgs | string {
  let stage: string | null = null;
  let id: string | null = null;
  let exploratory = false;
  let paramsFile: string | null = null;
  let skipOther = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === '--stage') {
      const v = argv[++i];
      if (v === undefined) return '--stage needs A or B';
      stage = v;
    } else if (a.startsWith('--stage=')) {
      stage = a.slice('--stage='.length);
    } else if (a === '--exploratory') {
      exploratory = true;
    } else if (a === '--params') {
      const v = argv[++i];
      if (v === undefined) return '--params needs a file';
      paramsFile = v;
    } else if (a === '--no-other') {
      skipOther = true;
    } else if (a.startsWith('-')) {
      return `unknown option ${a}`;
    } else if (id === null) {
      id = a;
    } else {
      return `unexpected argument ${a}`;
    }
  }
  const st = stage?.toUpperCase();
  if (st !== 'A' && st !== 'B') return '--stage A or --stage B is required';
  if (id === null) return 'the recording id is required (e.g. gate-a)';
  if (paramsFile !== null && st !== 'B') return '--params is for stage B only';
  return { stage: st, id, exploratory, paramsFile, skipOther };
}

export async function main(argv: readonly string[], deps: GateDeps = defaultGateDeps()): Promise<number> {
  const args = parseGateArgs(argv);
  if (typeof args === 'string') {
    deps.error(`${args}\n${USAGE}`);
    return 2;
  }
  try {
    if (args.stage === 'A') runStageA({ id: args.id, exploratory: args.exploratory, deps });
    else runStageB({ id: args.id, exploratory: args.exploratory, paramsFile: args.paramsFile, skipOther: args.skipOther, deps });
    return 0;
  } catch (e) {
    if (e instanceof GateRefusal) {
      deps.error(`analyze:gate refused: ${e.message}`);
      return 1;
    }
    throw e;
  }
}

const invokedDirectly = process.argv[1] !== undefined && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (invokedDirectly) {
  main(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (e: unknown) => {
      process.stderr.write(`analyze:gate failed: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}\n`);
      process.exitCode = 1;
    },
  );
}
