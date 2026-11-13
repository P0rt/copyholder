// npm run freeze -- <tag> [--check] (spec 8.4, 13.3, 13.6, 14.2)
// Runs on main only (the Mac records from origin/main, spec 14.1). Refuses on a dirty tree and when
// HEAD is not equal to or ahead of origin/main after a fetch; runs the tag's checks; stamps the tag's
// file with OpenTimestamps; commits the .ots file; sets an annotated tag that lists the SHA-256
// values; pushes the commit to main and the tag to origin; prints the stamped file's SHA-256 to
// publish before the recording. --check runs every check and changes nothing.
// A run that stopped after its commit or its tag is picked up again by the same command.

import { existsSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { blobAt, commitOf, dirtyEntries, gitIn, GitError, isAncestor, remoteTagCommit, repoView, type Git } from './git.ts';
import { OTS_ENV, otsCommand, otsProofProblem, runOtsStamp } from './ots.ts';
import { checkTag, isFreezeTag, sha256Hex, stampCommitSubject, tagMessage, TAG_SPECS, type HashLine, type TagSpec } from './tags.ts';

export const REMOTE = 'origin';
export const MAIN_BRANCH = 'main';
export const USAGE = 'Usage: npm run freeze -- <gate-prereg|gate-retune|freeze-1> [--check]';

export interface FreezeDeps {
  /** Repository root. */
  repoDir: string;
  /** Environment for git and ots (git takes the author from the repository's config). */
  env: NodeJS.ProcessEnv;
  log: (line: string) => void;
}

/** What is left to do: everything, the tag and push after an earlier commit, or the push only. */
export type FreezeMode = 'stamp' | 'tag' | 'push';

class Refusal extends Error {}

function refuse(message: string): never {
  throw new Refusal(message);
}

function short(sha: string): string {
  return sha.slice(0, 12);
}

function detail(r: { stdout: string; stderr: string }): string {
  return (r.stderr || r.stdout).trim().split('\n').slice(-3).join(' | ');
}

/** HEAD is the commit an earlier run made: the stamp subject, adding only <stamped>.ots. */
export function headIsStampCommit(git: Git, spec: TagSpec): boolean {
  const subject = git.run(['log', '-1', '--format=%s', 'HEAD']);
  if (subject.status !== 0 || subject.stdout.trim() !== stampCommitSubject(spec)) return false;
  const files = git.out(['diff-tree', '--no-commit-id', '--name-only', '-r', '--root', 'HEAD']).split('\n').filter((l) => l !== '');
  return files.length === 1 && files[0] === `${spec.stamped}.ots`;
}

interface GitState {
  head: string;
  problems: string[];
  /** False after a failed fetch, when the remote could not be asked. */
  remoteReachable: boolean;
  /** The tag on origin (undefined when the remote could not be asked). */
  remoteTag: string | null | undefined;
  localTag: string | null;
}

function gitState(git: Git, spec: TagSpec, repoDir: string): GitState {
  const top = git.run(['rev-parse', '--show-toplevel']);
  if (top.status !== 0) refuse(`${repoDir} is not a git repository`);
  if (realpathSync(top.stdout.trim()) !== realpathSync(repoDir)) refuse(`${repoDir} is not the root of its git repository`);
  const sym = git.run(['symbolic-ref', '--quiet', '--short', 'HEAD']);
  if (sym.status !== 0) refuse(`HEAD is detached: check out ${MAIN_BRANCH} first`);
  const branch = sym.stdout.trim();
  const head = commitOf(git, 'HEAD');
  if (head === null) refuse('the repository has no commit yet');
  const problems: string[] = [];
  // Spec 14.1: the Mac pulls and records main, and host checks the clone against origin/main.
  if (branch !== MAIN_BRANCH) {
    problems.push(`the freeze runs on ${MAIN_BRANCH}, not on ${branch}: the Mac records from origin/${MAIN_BRANCH} (spec 14.1). Run git checkout ${MAIN_BRANCH} && git merge --ff-only ${branch} first`);
  }

  const dirty = dirtyEntries(git);
  if (dirty.length > 0) {
    const shown = dirty.slice(0, 8).map((l) => l.trim()).join('; ');
    problems.push(`the working tree is not clean (${dirty.length} entries: ${shown}${dirty.length > 8 ? '; ...' : ''}): commit or remove them first`);
  }

  let remoteTag: string | null | undefined;
  const fetch = git.run(['fetch', '--quiet', '--no-tags', REMOTE]);
  if (fetch.status !== 0) problems.push(`git fetch ${REMOTE} failed: ${detail(fetch)}`);
  else {
    const originMain = commitOf(git, `refs/remotes/${REMOTE}/${MAIN_BRANCH}`);
    if (originMain === null) problems.push(`${REMOTE}/${MAIN_BRANCH} does not exist after git fetch`);
    else if (!isAncestor(git, originMain, head)) {
      problems.push(`HEAD is not equal to or ahead of ${REMOTE}/${MAIN_BRANCH}: run git pull --ff-only first (spec 14.1)`);
    }
    remoteTag = remoteTagCommit(git, REMOTE, spec.tag);
  }
  return { head, problems, remoteReachable: fetch.status === 0, remoteTag, localTag: commitOf(git, `refs/tags/${spec.tag}`) };
}

function readBytes(file: string): Uint8Array {
  return new Uint8Array(readFileSync(file));
}

/**
 * The tag message lists working-tree hashes; GitHub shows the committed bytes. They differ only when
 * an eol or filter setting converts a file, which would make every published hash wrong.
 */
function committedBytesProblems(git: Git, head: string, repoDir: string, hashes: readonly HashLine[]): string[] {
  const problems: string[] = [];
  for (const h of hashes) {
    if (!existsSync(join(repoDir, h.what))) continue;
    const stored = blobAt(git, head, h.what);
    if (stored !== null && sha256Hex(stored) !== h.hash) {
      problems.push(`${h.what} in the working tree is not byte for byte the committed file (an eol or filter setting converts it): its SHA-256 would not match the file on GitHub`);
    }
  }
  return problems;
}

/** ots stamp, then the proof is checked against the file; a failed stamp leaves no .ots behind. */
function stamp(spec: TagSpec, d: FreezeDeps): void {
  const otsRel = `${spec.stamped}.ots`;
  const otsAbs = join(d.repoDir, otsRel);
  d.log(`Stamping ${spec.stamped} with OpenTimestamps: ${[...otsCommand(d.env), 'stamp', spec.stamped].join(' ')}`);
  const r = runOtsStamp(d.repoDir, spec.stamped, d.env);
  if (r.output !== '') for (const line of r.output.split('\n')) d.log(`  ${line}`);
  if (!r.ok) {
    rmSync(otsAbs, { force: true });
    refuse(
      `ots stamp failed, so nothing was committed or tagged. If the OpenTimestamps calendars cannot be reached from this machine, run the command on the Mac (spec 14.2). uvx comes with uv (tools/tts/README.md); ${OTS_ENV} replaces the ots command`,
    );
  }
  const problem = existsSync(otsAbs) ? otsProofProblem(readBytes(otsAbs), readBytes(join(d.repoDir, spec.stamped))) : 'ots wrote no file';
  if (problem !== null) {
    rmSync(otsAbs, { force: true });
    refuse(`${otsRel} cannot be used: ${problem}. It was removed; nothing was committed or tagged`);
  }
}

/** Commits <stamped>.ots alone; on failure the stamp is removed again. */
function commitStamp(spec: TagSpec, stampedSha256: string, git: Git, d: FreezeDeps): void {
  const otsRel = `${spec.stamped}.ots`;
  const add = git.run(['add', '--', otsRel]);
  const commit = add.status === 0 ? git.run(['commit', '--quiet', '-m', stampCommitSubject(spec), '-m', `SHA-256 of ${spec.stamped}: ${stampedSha256}`, '--', otsRel]) : add;
  if (commit.status !== 0) {
    git.run(['rm', '--cached', '--quiet', '--ignore-unmatch', '--', otsRel]);
    rmSync(join(d.repoDir, otsRel), { force: true });
    refuse(`git could not commit ${otsRel} (${detail(commit)}). The stamp was removed; nothing was tagged`);
  }
  d.log(`Committed ${otsRel} (${short(git.out(['rev-parse', 'HEAD']))}).`);
}

function finalLines(spec: TagSpec, stampedSha256: string, d: FreezeDeps): void {
  d.log(`FREEZE OK ${spec.tag}`);
  d.log(`SHA-256 of ${spec.stamped}: ${stampedSha256}`);
  d.log(spec.publish);
}

function freezeTag(spec: TagSpec, checkOnly: boolean, d: FreezeDeps): number {
  const git = gitIn(d.repoDir, d.env);
  const s = gitState(git, spec, d.repoDir);
  const problems = [...s.problems];
  const stampedAbs = join(d.repoDir, spec.stamped);
  const otsRel = `${spec.stamped}.ots`;

  // Where an earlier run stopped (spec 13.6: tags never move).
  let mode: FreezeMode = 'stamp';
  if (s.remoteTag !== undefined && s.remoteTag !== null) {
    if (s.localTag === s.remoteTag) {
      d.log(`The tag ${spec.tag} is already on ${REMOTE} at ${short(s.remoteTag)}: nothing to do.`);
      // The bytes git stores, hashed as they are (spec 14.2: this is the hash the user publishes).
      const atTag = blobAt(git, s.remoteTag, spec.stamped);
      if (atTag !== null) finalLines(spec, sha256Hex(atTag), d);
      return 0;
    }
    refuse(`the tag ${spec.tag} is already on ${REMOTE} at ${short(s.remoteTag)}, ${s.localTag === null ? 'and this clone lacks it' : `not at ${short(s.localTag)} where this clone has it`}; tags never move (spec 13.6)`);
  }
  const stampAtHead = headIsStampCommit(git, spec);
  if (s.localTag !== null) {
    if (s.localTag !== s.head || !stampAtHead) {
      refuse(`the tag ${spec.tag} exists in this clone at ${short(s.localTag)} but not on ${REMOTE}, and HEAD is not its stamp commit. If an earlier freeze stopped, delete it with git tag -d ${spec.tag} and run again`);
    }
    mode = 'push';
  } else if (stampAtHead) mode = 'tag';

  const check = checkTag(spec.tag, repoView(git, d.repoDir, s.head, s.remoteReachable ? REMOTE : null));
  problems.push(...check.problems);
  const repoFiles = check.hashes.map((h) => h.what).filter((p) => existsSync(join(d.repoDir, p)));
  if (repoFiles.length > 0) {
    const tracked = git.run(['ls-files', '--error-unmatch', '--', ...repoFiles]);
    if (tracked.status !== 0) problems.push(`not every frozen file is committed: ${detail(tracked)}`);
    else problems.push(...committedBytesProblems(git, s.head, d.repoDir, check.hashes));
  }
  if (mode === 'stamp' && existsSync(join(d.repoDir, otsRel))) {
    problems.push(`${otsRel} already exists: the file was stamped before, and a stamped file never changes after its tag (spec 13.6)`);
  }
  if (mode !== 'stamp' && existsSync(stampedAbs)) {
    const proof = existsSync(join(d.repoDir, otsRel)) ? otsProofProblem(readBytes(join(d.repoDir, otsRel)), readBytes(stampedAbs)) : 'it is missing';
    if (proof !== null) problems.push(`${otsRel} of the earlier run cannot be used: ${proof}`);
  }

  for (const n of check.notes) d.log(`Note: ${n}`);
  if (problems.length > 0) {
    for (const p of problems) d.log(`- ${p}`);
    d.log(`${checkOnly ? 'FREEZE NOT READY' : 'FREEZE REFUSED'} ${spec.tag}: ${problems.length} problem(s) above${checkOnly ? '' : '; nothing was stamped, committed or pushed'}.`);
    return 1;
  }
  const stampedSha256 = check.hashes.find((h) => h.what === spec.stamped)?.hash ?? sha256Hex(readBytes(stampedAbs));
  if (checkOnly) {
    d.log(`FREEZE READY ${spec.tag}: every check passed; the run would ${mode === 'stamp' ? 'stamp, commit, tag and push' : mode === 'tag' ? 'tag and push the earlier stamp commit' : 'push the earlier tag'}.`);
    for (const h of check.hashes) d.log(`  ${h.hash}  ${h.what}`);
    return 0;
  }

  if (mode === 'stamp') {
    stamp(spec, d);
    commitStamp(spec, stampedSha256, git, d);
  }
  const head = git.out(['rev-parse', 'HEAD']);
  if (mode !== 'push') {
    const tag = git.run(['tag', '-a', '-m', tagMessage(spec, check.hashes), spec.tag, head]);
    if (tag.status !== 0) refuse(`git tag failed (${detail(tag)}). The stamp commit stays in this clone: run the command again to tag and push it`);
    d.log(`Tagged ${short(head)} as ${spec.tag}.`);
  }
  const push = git.run(['push', '--atomic', REMOTE, `${head}:refs/heads/${MAIN_BRANCH}`, `refs/tags/${spec.tag}`]);
  if (push.status !== 0) {
    refuse(`git push failed (${detail(push)}). The stamp commit and the tag ${spec.tag} stay in this clone: run npm run freeze -- ${spec.tag} again to push them`);
  }
  const onRemote = remoteTagCommit(git, REMOTE, spec.tag);
  if (onRemote !== head) refuse(`after the push ${REMOTE} shows ${spec.tag} at ${onRemote === null ? 'nothing' : short(onRemote)}, not at ${short(head)}`);
  d.log(`Pushed ${MAIN_BRANCH} and the tag ${spec.tag} to ${REMOTE}.`);
  d.log(`OpenTimestamps confirms the stamp after a few hours; then ots upgrade ${otsRel} completes the file, in a separate commit (spec 8.4).`);
  finalLines(spec, stampedSha256, d);
  return 0;
}

/** The command: returns the exit code (0 done or ready, 1 refused or failed, 2 usage). */
export function runFreeze(argv: readonly string[], d: FreezeDeps): number {
  const checkOnly = argv.includes('--check');
  const rest = argv.filter((a) => a !== '--check');
  const tag = rest[0];
  if (rest.length !== 1 || tag === undefined || !isFreezeTag(tag)) {
    d.log(USAGE);
    return 2;
  }
  try {
    return freezeTag(TAG_SPECS[tag], checkOnly, d);
  } catch (e) {
    if (e instanceof Refusal || e instanceof GitError) {
      d.log(`FREEZE REFUSED ${tag}: ${e.message}`);
      return 1;
    }
    throw e;
  }
}
