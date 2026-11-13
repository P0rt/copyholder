// git for the freeze command (spec 8.4, 13.6). Only plain git subcommands, run in the repository;
// no author or committer is ever set here: git takes them from the repository's config.

import { spawnSync } from 'node:child_process';

export interface GitResult {
  status: number;
  stdout: string;
  stderr: string;
}

/** A git run whose stdout stays raw bytes (blobs are hashed as stored, never decoded). */
export interface RawGitResult {
  status: number;
  stdout: Buffer;
  stderr: string;
}

export class GitError extends Error {
  constructor(
    message: string,
    readonly result: GitResult,
  ) {
    super(message);
    this.name = 'GitError';
  }
}

export interface Git {
  /** Runs git and returns its exit code and output; never throws for a non-zero exit. */
  run(args: readonly string[]): GitResult;
  /** Runs git and returns trimmed stdout; throws GitError on a non-zero exit. */
  out(args: readonly string[]): string;
  /** Runs git and returns stdout as raw bytes. */
  raw(args: readonly string[]): RawGitResult;
}

/** git in `repoDir` with the given environment. Network steps (fetch, push) get a long timeout. */
export function gitIn(repoDir: string, env: NodeJS.ProcessEnv, timeoutMs = 300_000): Git {
  const spawn = (args: readonly string[]) =>
    spawnSync('git', [...args], {
      cwd: repoDir,
      env: { ...env, GIT_TERMINAL_PROMPT: env['GIT_TERMINAL_PROMPT'] ?? '0' },
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: timeoutMs,
      maxBuffer: 64 * 1024 * 1024,
    });
  const raw = (args: readonly string[]): RawGitResult => {
    const r = spawn(args);
    if (r.error) return { status: 128, stdout: Buffer.alloc(0), stderr: `cannot run git: ${r.error.message}` };
    return { status: r.status ?? 128, stdout: r.stdout ?? Buffer.alloc(0), stderr: (r.stderr ?? Buffer.alloc(0)).toString('utf8') };
  };
  const run = (args: readonly string[]): GitResult => {
    const r = raw(args);
    return { status: r.status, stdout: r.stdout.toString('utf8'), stderr: r.stderr };
  };
  return {
    run,
    raw,
    out(args) {
      const r = run(args);
      if (r.status !== 0) {
        const detail = (r.stderr || r.stdout).trim().split('\n').slice(-3).join(' | ');
        throw new GitError(`git ${args.join(' ')} failed (exit ${r.status})${detail ? `: ${detail}` : ''}`, r);
      }
      return r.stdout.trim();
    },
  };
}

/** Commit a ref points to (tags peeled), or null when it does not exist. */
export function commitOf(git: Git, ref: string): string | null {
  const r = git.run(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]);
  return r.status === 0 ? r.stdout.trim() : null;
}

/** True when `ancestor` is reachable from `descendant` (equal counts). */
export function isAncestor(git: Git, ancestor: string, descendant: string): boolean {
  const r = git.run(['merge-base', '--is-ancestor', ancestor, descendant]);
  if (r.status === 0) return true;
  if (r.status === 1) return false;
  throw new GitError(`git merge-base --is-ancestor ${ancestor} ${descendant} failed: ${r.stderr.trim()}`, r);
}

/**
 * The tag on a remote as `git ls-remote` shows it: the commit it points to (peeled), or null when
 * the remote has no such tag.
 */
export function remoteTagCommit(git: Git, remote: string, tag: string): string | null {
  const out = git.out(['ls-remote', '--tags', remote, `refs/tags/${tag}`, `refs/tags/${tag}^{}`]);
  let direct: string | null = null;
  let peeled: string | null = null;
  for (const line of out.split('\n')) {
    const [sha, ref] = line.trim().split(/\s+/);
    if (!sha || !ref) continue;
    if (ref === `refs/tags/${tag}^{}`) peeled = sha;
    else if (ref === `refs/tags/${tag}`) direct = sha;
  }
  return peeled ?? direct;
}

/** Lines of `git status --porcelain`: changed, staged and untracked files (ignored ones are not listed). */
export function dirtyEntries(git: Git): string[] {
  return git
    .out(['status', '--porcelain=v1', '--untracked-files=normal'])
    .split('\n')
    .filter((l) => l.trim() !== '');
}

/** Raw bytes of `path` at `commit` as git stores them, or null when the path is not there. */
export function blobAt(git: Git, commit: string, path: string): Uint8Array | null {
  const r = git.raw(['cat-file', 'blob', `${commit}:${path}`]);
  return r.status === 0 ? new Uint8Array(r.stdout) : null;
}

/** Paths that differ between two commits; a rename counts as its two paths. */
export function changedPaths(git: Git, from: string, to: string): string[] {
  const r = git.raw(['diff', '--name-only', '--no-renames', '-z', from, to]);
  if (r.status !== 0) throw new GitError(`git diff ${from} ${to} failed: ${r.stderr.trim()}`, { status: r.status, stdout: '', stderr: r.stderr });
  return r.stdout
    .toString('utf8')
    .split('\0')
    .filter((p) => p !== '');
}

/** Where an earlier freeze tag points. */
export interface TagAt {
  commit: string;
  /** origin when the remote has the tag, clone when only this clone has it. */
  where: 'origin' | 'clone';
  /** Set when this clone has the tag at another commit than origin. */
  problem: string | null;
}

/** What the tag checks read from git (tools/freeze/tags.ts). */
export interface RepoView {
  /** Repository root. */
  dir: string;
  /** The commit the freeze would tag (HEAD, or the stamp commit on top of it). */
  head: string;
  /** An earlier freeze tag: as origin has it, else as this clone has it; null when it was never set. */
  tagCommit(tag: string): TagAt | null;
  blobAt(commit: string, path: string): Uint8Array | null;
  /** Full hash of a commit name (hash prefix, ref), or null. */
  resolveCommit(name: string): string | null;
  isAncestor(ancestor: string, descendant: string): boolean;
  changedPaths(from: string, to: string): string[];
}

/**
 * RepoView over a clone. `remote` is asked for tags with ls-remote unless it is null (a failed
 * fetch); a tag commit missing here is fetched by its tag name, without creating a local ref.
 */
export function repoView(git: Git, dir: string, head: string, remote: string | null): RepoView {
  const tags = new Map<string, TagAt | null>();
  const hasCommit = (sha: string): boolean => git.run(['cat-file', '-e', `${sha}^{commit}`]).status === 0;
  return {
    dir,
    head,
    tagCommit(tag) {
      if (tags.has(tag)) return tags.get(tag)!;
      let at: TagAt | null = null;
      const local = commitOf(git, `refs/tags/${tag}`);
      const onRemote = remote === null ? null : remoteTagCommit(git, remote, tag);
      if (onRemote !== null) {
        if (!hasCommit(onRemote)) git.run(['fetch', '--quiet', '--no-tags', remote!, `refs/tags/${tag}`]);
        const problem =
          local !== null && local !== onRemote ? `this clone has the tag ${tag} at ${local.slice(0, 12)}, ${remote} at ${onRemote.slice(0, 12)}: tags never move (spec 13.6)` : null;
        at = { commit: onRemote, where: 'origin', problem };
      } else if (local !== null) at = { commit: local, where: 'clone', problem: null };
      tags.set(tag, at);
      return at;
    },
    blobAt: (commit, path) => blobAt(git, commit, path),
    resolveCommit: (name) => commitOf(git, name),
    isAncestor: (a, b) => isAncestor(git, a, b),
    changedPaths: (from, to) => changedPaths(git, from, to),
  };
}
