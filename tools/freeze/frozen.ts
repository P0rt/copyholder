// Writes params/frozen.json for the tag gate-prereg (spec 8.4): the builder in ./params.ts with the
// noise floor and the periodicity threshold of a doctor run (spec 7.3, 7.12).
//
//   npx tsx tools/freeze/frozen.ts                       the latest doctor calib.json (on the Mac)
//   npx tsx tools/freeze/frozen.ts --doctor doctor-2     that doctor run's calib.json
//   npx tsx tools/freeze/frozen.ts --doctor doctor-2 --floor-db -58.3 --periodicity 0.6
//                                                        the values the doctor report prints (anywhere)
//   --check      exit 1 unless params/frozen.json matches: its copy under gate-prereg once that tag
//                exists (what stage A writes aside), else a rebuild from the doctor values
//   --commit     commit params/frozen.json alone and push it to origin main (spec 14.1)
//   --out <file> write elsewhere, never committed; COPYHOLDER_SESSIONS_DIR moves sessions/.
//
// Refuses without doctor values: a file written before doctor has no floor_db, and then the page and
// the analysis take doctor's floor and periodicity from calib.json instead of the file's (PREREG §5). Refuses once the tag gate-prereg exists (spec 7.12: the voice detector does not
// change after it) and over a file stage A has tuned.

import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { doctorVadOf, latestDoctorVad } from './doctor-calib.ts';
import { blobAt, commitOf, gitIn, isAncestor, remoteTagCommit, type Git } from './git.ts';
import {
  buildGatePreregParams,
  doctorVadProblems,
  FROZEN_PARAMS_PATH,
  frozenParamsText,
  roundedDoctorVad,
  STAGE_A_PATHS,
  stageAKeysFound,
  WRITE_HINT,
  type DoctorVad,
} from './params.ts';
import { sameJson } from './tags.ts';

export * from './params.ts';

export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

/** The tag that freezes this file without k and theta_G (spec 8.4). */
export const PREREG_TAG = 'gate-prereg';
const REMOTE = 'origin';
const MAIN_BRANCH = 'main';

export const USAGE =
  'Usage: npx tsx tools/freeze/frozen.ts [--doctor <id>] [--floor-db <dB> --periodicity <p>] [--check] [--commit] [--out <file>]';

/** Printed when no doctor values are known: the file is not written without them (spec 7.3). */
export const NO_DOCTOR_HINT = `No doctor values: params/frozen.json is written only with the noise floor and the periodicity threshold of a doctor run (spec 7.3, 7.12). ${WRITE_HINT}.`;

interface CliOptions {
  out: string | null;
  check: boolean;
  commit: boolean;
  doctorId: string | null;
  floorDb: number | null;
  periodicity: number | null;
}

function parseArgs(argv: readonly string[]): CliOptions | string {
  const o: CliOptions = { out: null, check: false, commit: false, doctorId: null, floorDb: null, periodicity: null };
  const num = (flag: string, v: string | undefined): number | string => {
    const n = v === undefined || v.trim() === '' ? Number.NaN : Number(v.replace(/−/g, '-'));
    return Number.isFinite(n) ? n : `${flag} needs a number, got ${v ?? 'nothing'}`;
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i]!;
    const next = argv[i + 1];
    if (a === '--check') o.check = true;
    else if (a === '--commit') o.commit = true;
    else if (a === '--out' && next !== undefined) o.out = resolve(argv[(i += 1)]!);
    else if (a === '--doctor' && next !== undefined) o.doctorId = argv[(i += 1)]!;
    else if (a === '--floor-db' || a === '--periodicity') {
      const n = num(a, next);
      i += 1;
      if (typeof n === 'string') return `${n}. ${USAGE}`;
      if (a === '--floor-db') o.floorDb = n;
      else o.periodicity = n;
    } else return `unknown argument ${a}. ${USAGE}`;
  }
  if ((o.floorDb === null) !== (o.periodicity === null)) return `--floor-db and --periodicity go together. ${USAGE}`;
  if (o.floorDb !== null && o.doctorId === null) return `--floor-db and --periodicity need --doctor <id>, the doctor run they come from. ${USAGE}`;
  if (o.commit && (o.out !== null || o.check)) return `--commit writes and commits params/frozen.json itself: not with --out or --check. ${USAGE}`;
  return o;
}

function safeParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/** A copy without the values stage A writes (d1.k, g.theta_G, tuned): what gate-prereg froze. */
export function withoutStageA(value: unknown): unknown {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return value;
  const out = structuredClone(value) as Record<string, unknown>;
  for (const p of STAGE_A_PATHS) {
    let at: unknown = out;
    for (const key of p.slice(0, -1)) at = at !== null && typeof at === 'object' ? (at as Record<string, unknown>)[key] : undefined;
    if (at !== null && typeof at === 'object') delete (at as Record<string, unknown>)[p[p.length - 1]!];
  }
  return out;
}

/** The commit of the gate-prereg tag in this clone, or null (also outside a git repository). */
function preregTagCommit(git: Git): string | null {
  return git.run(['rev-parse', '--git-dir']).status === 0 ? commitOf(git, `refs/tags/${PREREG_TAG}`) : null;
}

/** --check once the tag exists: the file must hold what the tag froze, stage A values aside. */
function checkAgainstTag(git: Git, tagCommit: string, existing: string | null, shown: string, log: (l: string) => void): number {
  const tagged = blobAt(git, tagCommit, FROZEN_PARAMS_PATH);
  if (tagged === null) {
    log(`The tag ${PREREG_TAG} (${tagCommit.slice(0, 12)}) holds no ${FROZEN_PARAMS_PATH}.`);
    return 1;
  }
  if (existing === null) {
    log(`${shown} does not exist, but the tag ${PREREG_TAG} holds it: restore it with git checkout ${PREREG_TAG} -- ${FROZEN_PARAMS_PATH}`);
    return 1;
  }
  if (sameJson(withoutStageA(safeParse(existing)), withoutStageA(safeParse(Buffer.from(tagged).toString('utf8'))))) {
    log(`${shown} holds the values frozen by the tag ${PREREG_TAG}, apart from what stage A writes (k, theta_G, tuned).`);
    return 0;
  }
  log(`${shown} differs from its copy under the tag ${PREREG_TAG} beyond k, theta_G and tuned: only stage A may change it (spec 7.12, 8.4).`);
  return 1;
}

/** The doctor values: the command line, else a named or the latest doctor calib.json. */
function doctorValues(o: CliOptions, env: NodeJS.ProcessEnv): DoctorVad | string | null {
  if (o.floorDb !== null && o.periodicity !== null && o.doctorId !== null) {
    return { id: o.doctorId, floorDb: o.floorDb, periodicity: o.periodicity };
  }
  if (o.doctorId !== null) return doctorVadOf(o.doctorId, env) ?? `sessions/${o.doctorId}/calib.json has no voice detector values (vad block)`;
  return latestDoctorVad(env);
}

/** --commit, before anything is written: on main, level with or ahead of origin/main, no tag yet. */
function commitPreconditions(git: Git): string | null {
  if (git.run(['rev-parse', '--git-dir']).status !== 0) return 'not a git repository';
  const branch = git.run(['symbolic-ref', '--quiet', '--short', 'HEAD']).stdout.trim();
  if (branch !== MAIN_BRANCH) return `--commit pushes ${MAIN_BRANCH}: check out ${MAIN_BRANCH} first (now on ${branch || 'a detached HEAD'})`;
  const fetch = git.run(['fetch', '--quiet', '--no-tags', REMOTE]);
  if (fetch.status !== 0) return `git fetch ${REMOTE} failed: ${(fetch.stderr || fetch.stdout).trim()}`;
  const originMain = commitOf(git, `refs/remotes/${REMOTE}/${MAIN_BRANCH}`);
  const head = commitOf(git, 'HEAD');
  if (originMain === null || head === null || !isAncestor(git, originMain, head)) return `HEAD is not equal to or ahead of ${REMOTE}/${MAIN_BRANCH}: run git pull --ff-only first (spec 14.1)`;
  const tagged = remoteTagCommit(git, REMOTE, PREREG_TAG);
  if (tagged !== null) return `the tag ${PREREG_TAG} is on ${REMOTE} (${tagged.slice(0, 12)}): ${FROZEN_PARAMS_PATH} is frozen (spec 7.12); run git pull --ff-only`;
  return null;
}

/** Commits params/frozen.json alone (other changes stay as they are) and pushes main. */
function commitAndPush(git: Git, doctor: DoctorVad, log: (l: string) => void): number {
  const changed = git.run(['status', '--porcelain', '--', FROZEN_PARAMS_PATH]).stdout.trim() !== '';
  if (changed) {
    const add = git.run(['add', '--', FROZEN_PARAMS_PATH]);
    const subject = `params/frozen.json: voice detector values of ${doctor.id} (spec 7.3, 8.4)`;
    const body = `Noise floor ${doctor.floorDb} dB, periodicity threshold ${doctor.periodicity}; written by tools/freeze/frozen.ts.`;
    const commit = add.status === 0 ? git.run(['commit', '--quiet', '-m', subject, '-m', body, '--', FROZEN_PARAMS_PATH]) : add;
    if (commit.status !== 0) {
      log(`git could not commit ${FROZEN_PARAMS_PATH}: ${(commit.stderr || commit.stdout).trim()}`);
      return 1;
    }
    log(`Committed ${FROZEN_PARAMS_PATH} (${git.out(['rev-parse', '--short=12', 'HEAD'])}).`);
  } else log(`${FROZEN_PARAMS_PATH} is already committed with these values.`);
  const push = git.run(['push', '--quiet', REMOTE, `HEAD:refs/heads/${MAIN_BRANCH}`]);
  if (push.status !== 0) {
    log(`git push failed: ${(push.stderr || push.stdout).trim()}. The commit stays in this clone: push it with git push ${REMOTE} ${MAIN_BRANCH}.`);
    return 1;
  }
  log(`Pushed ${MAIN_BRANCH} to ${REMOTE}.`);
  return 0;
}

/** The command: 0 written or matching, 1 refused or differs, 2 usage. */
export function main(
  argv: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
  log: (line: string) => void = console.log,
  repoDir: string = REPO_ROOT,
): number {
  const o = parseArgs(argv);
  if (typeof o === 'string') {
    log(o);
    return 2;
  }
  const repoFile = join(repoDir, FROZEN_PARAMS_PATH);
  const out = o.out ?? repoFile;
  const shown = relative(process.cwd(), out) || out;
  const existing = existsSync(out) ? readFileSync(out, 'utf8') : null;
  const git = gitIn(repoDir, env);

  // Spec 7.12: after gate-prereg the voice detector parameters do not change.
  const tagCommit = out === repoFile ? preregTagCommit(git) : null;
  if (tagCommit !== null) {
    if (o.check) return checkAgainstTag(git, tagCommit, existing, shown, log);
    log(`${shown} is frozen by the tag ${PREREG_TAG} (${tagCommit.slice(0, 12)}) and is not rewritten: the voice detector parameters do not change after it (spec 7.12). Stage A writes k and theta_G (spec 8.4).`);
    return 1;
  }

  const found = doctorValues(o, env);
  if (found === null || typeof found === 'string') {
    if (typeof found === 'string') log(`${found}.`);
    log(NO_DOCTOR_HINT);
    return 1;
  }
  const problems = doctorVadProblems(found);
  if (problems.length > 0) {
    log(`The doctor values cannot be used: ${problems.join('; ')}.`);
    return 1;
  }
  const doctor = roundedDoctorVad(found);
  const { params, vadSource } = buildGatePreregParams(doctor);
  const text = frozenParamsText(params);

  if (o.check) {
    if (existing === text) {
      log(`${shown} matches a rebuild (${vadSource}).`);
      return 0;
    }
    log(`${shown} ${existing === null ? 'does not exist' : 'differs from a rebuild'} (${vadSource}). Write it with npx tsx tools/freeze/frozen.ts and the same values.`);
    return 1;
  }
  if (existing !== null && stageAKeysFound(safeParse(existing)).length > 0) {
    log(`${shown} already holds k or theta_G from stage A: it is not rebuilt (spec 8.4).`);
    return 1;
  }
  if (o.commit) {
    const why = commitPreconditions(git);
    if (why !== null) {
      log(`Not written: ${why}.`);
      return 1;
    }
  }
  const tmp = `${out}.tmp`;
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(tmp, text);
  renameSync(tmp, out);
  log(`${shown} written for gate-prereg, without k and theta_G. Voice detector: ${vadSource}.`);
  return o.commit ? commitAndPush(git, doctor, log) : 0;
}

function isEntryPoint(): boolean {
  try {
    return process.argv[1] !== undefined && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isEntryPoint()) process.exit(main(process.argv.slice(2)));
