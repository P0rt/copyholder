// npm run replay -- <id or folder> [<id or folder> ...] [--params <file>] [--json <out.json>]
//                   [--svg <out.svg>] [--png <out.png>] [--chrome <path>]
// Recomputes the numbers of published gate sets data/<id>/ with stage B's own functions and
// compares each with the set's verdict.json (spec 8.7, 9.6, 9.7): no camera, no API key, no
// session folder. A gate set without verdict.json, the set of a recording that never reached its
// verdict, has its files checked and no verdict to recompute. A bare id is <id>/ in the data
// folder (COPYHOLDER_DATA_DIR, else data/ under the repository root). --params names the params
// file stage B scored with when params/retune.json and params/frozen.json are not it; --json
// writes one row per cue, --svg and --png the figure of every valid objection (--chrome or
// PW_CHROMIUM_PATH names the Chrome that draws the PNG). Nothing is read or written inside gate/
// or sample/. See analysis/replay/README.md.
// Exit codes: 0 verified: the verdict and the five row outcomes of every set are recomputed and
// match without a condition, and no recomputed value differs; 1 a value differs, or a set or an
// output is refused; 2 usage; 3 nothing differs, but the verdict or a row outcome of a set is not
// recomputable from it (a set without verdict.json has none), or matches only under a condition
// the set does not show.

import fs from 'node:fs';
import path from 'node:path';
import { chromePath } from '../tools/video/textpng.ts';
import { gitTagFile } from './gate/deps.ts';
import { isMainModule } from './lib/cli.ts';
import { FigureError, figureData, figurePng, figureSvg } from './replay/figure.ts';
import { findParams } from './replay/params.ts';
import {
  KEY_VALUES,
  checkLines,
  countStatus,
  countText,
  replaySet,
  replayVerdictless,
  verifies,
  type ScoredSet,
  type SetReplay,
  type VerdictlessReplay,
} from './replay/recompute.ts';
import { MARKS_FILE, ReplayRefusal, readSetFolder, realPathOf, setFolderOf, unreadFolderWhy, unreadPathWhy } from './replay/set.ts';
import { replayTable, tableProblems } from './replay/table.ts';

export const USAGE =
  'usage: npm run replay -- <id or folder> [<id or folder> ...] [--params <file>] [--json <out.json>] [--svg <out.svg>] [--png <out.png>] [--chrome <path>]';

export interface ReplayArgs {
  sets: string[];
  paramsFile: string | null;
  json: string | null;
  svg: string | null;
  png: string | null;
  chrome: string | undefined;
}

export interface ReplayDeps {
  env: NodeJS.ProcessEnv;
  log: (line: string) => void;
  /** Refusals and failures (stderr). */
  error: (line: string) => void;
  /** A file's text under a git tag (read-only `git show`); null when the tag or file is missing. */
  tagFile: (tag: string, file: string) => string | null;
}

export function defaultReplayDeps(): ReplayDeps {
  return {
    env: process.env,
    log: (line) => process.stdout.write(`${line}\n`),
    error: (line) => process.stderr.write(`${line}\n`),
    tagFile: gitTagFile,
  };
}

const VALUE_OPTIONS = ['--params', '--json', '--svg', '--png', '--chrome'] as const;
type ValueOption = (typeof VALUE_OPTIONS)[number];

/** Parses the command line; returns a message for a usage error. */
export function parseReplayArgs(argv: readonly string[]): ReplayArgs | string {
  const values = new Map<ValueOption, string>();
  const sets: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    const eq = a.indexOf('=');
    const name = (eq > 0 ? a.slice(0, eq) : a) as ValueOption;
    if (a.startsWith('--') && (VALUE_OPTIONS as readonly string[]).includes(name)) {
      const v = eq > 0 ? a.slice(eq + 1) : argv[++i];
      // An option after the name is the next option, not its value: --json --svg x.svg would write the table to "--svg".
      if (v === undefined || v === '' || v.startsWith('--')) return `${name} needs a value`;
      if (values.has(name)) return `${name} is given twice`;
      values.set(name, v);
    } else if (a.startsWith('-')) {
      return `unknown option ${a}`;
    } else {
      sets.push(a);
    }
  }
  if (sets.length === 0) return 'name at least one published set: its id (data/<id>/) or its folder';
  return {
    sets,
    paramsFile: values.get('--params') ?? null,
    json: values.get('--json') ?? null,
    svg: values.get('--svg') ?? null,
    png: values.get('--png') ?? null,
    chrome: values.get('--chrome'),
  };
}

function write(file: string, data: string | Uint8Array): string {
  const abs = path.resolve(file);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, data);
  return abs;
}

/** The replay of one set: with its verdict, or of a set without verdict.json. */
type AnyReplay = SetReplay | VerdictlessReplay;

function printSet(r: AnyReplay, deps: ReplayDeps): void {
  deps.log(`replay ${r.set.name} (pack ${r.set.pack}, from ${r.set.dir})`);
  if (r.params !== null) deps.log(`  params: ${r.params.source}; sha256 ${r.params.sha256.slice(0, 8)}, as verdict.json holds it`);
  for (const note of r.notes) deps.log(`  note: ${note}`);
  for (const line of checkLines(r.checks)) deps.log(line);
  deps.log(`  ${r.set.id}: ${countText(countStatus(r.checks))}`);
  deps.log('');
}

/** The key values of a set (KEY_VALUES) that are not verified, by their short names. */
function unverifiedOf(r: AnyReplay): string[] {
  return r.checks.filter((c) => KEY_VALUES.includes(c.name) && !verifies(c)).map((c) => (c.name === 'verdict' ? 'verdict' : c.name.replace(/^rows\.(\w+)\.outcome$/, 'row $1')));
}

/** The outputs that need every set scored: refused with what is missing, or written. */
async function writeOutputs(args: ReplayArgs, replays: readonly AnyReplay[], deps: ReplayDeps): Promise<boolean> {
  const wanted = [args.json && '--json', args.svg && '--svg', args.png && '--png'].filter((x): x is string => typeof x === 'string');
  if (wanted.length === 0) return true;
  const unscored = replays.filter((r) => r.scored === null);
  if (unscored.length > 0) {
    const why = (r: AnyReplay): string => `${r.set.name} has no ${r.params === null ? 'verdict.json' : `${MARKS_FILE} with the cue and step marks`}`;
    deps.error(`replay wrote no ${wanted.join(', ')}: ${wanted.length === 1 ? 'it needs' : 'they need'} the verdict and the cues of every set, and ${unscored.map(why).join(', ')} (see the notes above)`);
    return false;
  }
  const scored = replays as (SetReplay & { scored: ScoredSet })[];
  const table = replayTable(scored);
  const problems = tableProblems(table, scored);
  if (problems.length > 0) {
    deps.error(`replay wrote no ${wanted.join(', ')}: the table does not add up to the recomputed verdict, a fault of replay and not of the sets; please report it:\n  ${problems.join('\n  ')}`);
    return false;
  }
  if (args.json) deps.log(`replay: wrote ${write(args.json, `${JSON.stringify(table, null, 2)}\n`)} (${table.rows.length} cues)`);
  if (args.svg || args.png) {
    const svg = figureSvg(figureData(table));
    if (args.svg) deps.log(`replay: wrote ${write(args.svg, svg.svg)}`);
    if (args.png) {
      try {
        const png = await figurePng(svg, chromePath(args.chrome, deps.env));
        deps.log(`replay: wrote ${write(args.png, png)}`);
      } catch (e) {
        if (!(e instanceof FigureError)) throw e;
        deps.error(`replay wrote no PNG: ${e.message}`);
        return false;
      }
    }
  }
  return true;
}

export async function main(argv: readonly string[], deps: ReplayDeps = defaultReplayDeps()): Promise<number> {
  const args = parseReplayArgs(argv);
  if (typeof args === 'string') {
    deps.error(`${args}\n${USAGE}`);
    return 2;
  }
  const folders = args.sets.map((a) => setFolderOf(a, deps.env));
  const named: [string, string | null][] = [
    ['--params', args.paramsFile],
    ['--json', args.json],
    ['--svg', args.svg],
    ['--png', args.png],
  ];
  const whys = [
    ...folders.map((dir) => unreadFolderWhy(dir)),
    ...named.map(([option, file]) => (file === null ? null : unreadPathWhy(file, `${option} ${file}`))),
  ].filter((w): w is string => w !== null);
  // The same folder twice would count its values twice in the totals, the table and the figure.
  const seen = new Map<string, string>();
  args.sets.forEach((a, i) => {
    const real = realPathOf(folders[i]!);
    const before = seen.get(real);
    if (before !== undefined) whys.push(`${before} and ${a} name the same set folder ${real}: name each set once`);
    else seen.set(real, a);
  });
  if (whys.length > 0) {
    deps.error(`${whys[0]}\n${USAGE}`);
    return 2;
  }

  const replays: AnyReplay[] = [];
  let refused = 0;
  folders.forEach((dir, i) => {
    try {
      const set = readSetFolder(dir);
      const r = set.verdict === null ? replayVerdictless(set) : replaySet(set, findParams(set.verdict, { env: deps.env, tagFile: deps.tagFile, paramsFile: args.paramsFile }));
      replays.push(r);
      printSet(r, deps);
    } catch (e) {
      if (!(e instanceof ReplayRefusal)) throw e;
      deps.error(`replay refused ${args.sets[i]}: ${e.message}`);
      refused++;
    }
  });

  const differs = replays.flatMap((r) => r.checks.filter((c) => c.status === 'DIFFERS').map((c) => `${r.set.id} ${c.name}`));
  const counted = countText(countStatus(replays.flatMap((r) => r.checks)));
  let failed = refused > 0 || differs.length > 0;
  if (differs.length > 0) deps.log(`replay: ${differs.length} recomputed ${differs.length === 1 ? 'value differs' : 'values differ'} from the set: ${differs.join(', ')}`);
  const outputs = args.json !== null || args.svg !== null || args.png !== null;
  if (refused > 0) deps.log(`replay: ${refused} of ${folders.length} sets refused (see above)${outputs ? '; no table or figure written' : ''}`);
  else if (!(await writeOutputs(args, replays, deps))) failed = true;
  if (failed) return 1;

  const unverified = replays.map((r) => [r, unverifiedOf(r)] as const).filter(([, names]) => names.length > 0);
  if (unverified.length > 0) {
    deps.log(
      `replay: no recomputed value differs, but the verdict is not verified: ${unverified.map(([r, names]) => `${r.set.name} ${names.join(', ')}`).join('; ')} ${
        unverified.length === 1 && unverified[0]![1].length === 1 ? 'is' : 'are'
      } not recomputable from the set or match only under a condition it does not show (see above; ${counted})`,
    );
    return 3;
  }
  deps.log(
    `replay: verified: the verdict and the five row outcomes of ${replays.length === 1 ? 'the set are' : `all ${replays.length} sets are`} recomputed and match, and no recomputed value differs (${counted})`,
  );
  return 0;
}

if (isMainModule(import.meta.url)) {
  main(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (e: unknown) => {
      process.stderr.write(`replay failed: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}\n`);
      process.exitCode = 1;
    },
  );
}
