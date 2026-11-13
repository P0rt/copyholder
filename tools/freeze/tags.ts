// The three freeze tags (spec 8.4, 13.6): which file `ots stamp` dates, what must hold before the tag,
// and which SHA-256 values the annotated tag lists. Files are read from the working tree; earlier
// tags and commits through a RepoView (tools/freeze/git.ts).

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { paramsAreTuned, validateFreezeManifest, validateFrozenParams, validateScoringRules, type FrozenParams } from '../../core/schemas/index.ts';
import type { RepoView } from './git.ts';
import { FROZEN_PARAMS_PATH, gatePreregParamsProblems } from './params.ts';
import { backtickedCommitNames, checkCueLists, placeholderProblem, preregVadValues } from './prereg.ts';
import { sha256Hex } from './sha256.ts';

export { sha256Hex };

export type FreezeTag = 'gate-prereg' | 'gate-retune' | 'freeze-1';

export interface TagSpec {
  tag: FreezeTag;
  /** The file `ots stamp` dates, relative to the repository root; its .ots goes beside it. */
  stamped: string;
  /** First line of the tag message. */
  title: string;
  /** Sentence printed with the stamped file's SHA-256 (spec 13.6, 14.2). */
  publish: string;
}

export const PREREG_PATH = 'PREREG.md';
export const RETUNE_PATH = 'params/retune.json';
export const MANIFEST_PATH = 'freeze_manifest.json';
/** In the repository root (spec 13.1). */
export const SCORING_RULES_PATH = 'scoring_rules.json';

/** Doctor prints the floor to 0.1 dB and the periodicity threshold to 0.01 (analysis/doctor.ts). */
export const FLOOR_DB_TOLERANCE = 0.05;
export const PERIODICITY_TOLERANCE = 0.005;

export const TAG_SPECS: Readonly<Record<FreezeTag, TagSpec>> = {
  'gate-prereg': {
    tag: 'gate-prereg',
    stamped: PREREG_PATH,
    title: 'gate-prereg: rules and parameters fixed before the day-1 gate recording (spec 8.4)',
    publish: 'Publish this SHA-256 of PREREG.md before you start the day-1 gate recording.',
  },
  'gate-retune': {
    tag: 'gate-retune',
    stamped: RETUNE_PATH,
    title: 'gate-retune: parameters of the bounded retune, fixed before the next pack is recorded (spec 8.4, 9.8)',
    publish: 'Publish this SHA-256 of params/retune.json before you record the next pack.',
  },
  'freeze-1': {
    tag: 'freeze-1',
    stamped: MANIFEST_PATH,
    title: 'freeze-1: parameters, scoring rules and sealed plans fixed before the first numbers session (spec 8.4)',
    publish: 'Publish this SHA-256 of freeze_manifest.json before you start the first numbers session.',
  },
};

export function isFreezeTag(s: string): s is FreezeTag {
  return Object.hasOwn(TAG_SPECS, s);
}

export interface HashLine {
  hash: string;
  /** A repository path, or a description such as "prompts (as listed in freeze_manifest.json)". */
  what: string;
}

export interface TagCheck {
  problems: string[];
  notes: string[];
  /** Listed in the tag message; the stamped file first. */
  hashes: HashLine[];
}

function readIn(repoDir: string, rel: string): Buffer | null {
  const file = join(repoDir, rel);
  return existsSync(file) ? readFileSync(file) : null;
}

function parseJson(bytes: Uint8Array, rel: string, problems: string[]): unknown {
  try {
    return JSON.parse(Buffer.from(bytes).toString('utf8'));
  } catch (e) {
    problems.push(`${rel} is not valid JSON: ${(e as Error).message}`);
    return undefined;
  }
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function short(sha: string): string {
  return sha.slice(0, 12);
}

/** Deep equality of two JSON values; key order does not matter. */
export function sameJson(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null || Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a)) return a.length === (b as unknown[]).length && a.every((x, i) => sameJson(x, (b as unknown[])[i]));
  const ao = a as Record<string, unknown>;
  const bo = b as Record<string, unknown>;
  const keys = Object.keys(ao);
  return keys.length === Object.keys(bo).length && keys.every((k) => Object.hasOwn(bo, k) && sameJson(ao[k], bo[k]));
}

// ---- checks shared by the tags -----------------------------------------------------------------

/**
 * Spec 8.4, 13.6: a stamped file never changes after its tag. Compares the working copy of `path`
 * with its bytes in the commit of `tag`; only a note when the tag was never set.
 */
export function unchangedSinceTag(view: RepoView, tag: FreezeTag, path: string, notes: string[]): string[] {
  const at = view.tagCommit(tag);
  if (at === null) {
    notes.push(`no ${tag} tag on origin or in this clone: ${path} was not compared with a tagged copy`);
    return [];
  }
  const problems = at.problem === null ? [] : [at.problem];
  const tagged = view.blobAt(at.commit, path);
  const now = readIn(view.dir, path);
  if (tagged === null) return [...problems, `${path} is not in the commit of ${tag} (${short(at.commit)})`];
  if (now === null) return [...problems, `${path} does not exist, but the tag ${tag} holds it: a stamped file never changes after its tag (spec 13.6)`];
  const before = sha256Hex(tagged);
  const after = sha256Hex(now);
  if (before !== after) {
    problems.push(`${path} changed after the tag ${tag}: SHA-256 ${after} now, ${before} under the tag. A stamped file never changes after its tag (spec 8.4, 13.6): restore it with git checkout ${tag} -- ${path}`);
  }
  return problems;
}

/** Spec 7.12: the voice detector parameters do not change after gate-prereg; freeze-1 only repeats them. */
export function vadSinceGatePrereg(view: RepoView, frozen: Uint8Array | null): string[] {
  const at = view.tagCommit('gate-prereg');
  if (at === null || frozen === null) return [];
  const tagged = view.blobAt(at.commit, FROZEN_PARAMS_PATH);
  if (tagged === null) return [`${FROZEN_PARAMS_PATH} is not in the commit of gate-prereg (${short(at.commit)})`];
  const scratch: string[] = [];
  const before = parseJson(tagged, `${FROZEN_PARAMS_PATH} at gate-prereg`, scratch);
  const now = parseJson(frozen, FROZEN_PARAMS_PATH, scratch);
  const vadOf = (v: unknown): unknown => (isRecord(v) ? v['vad'] : undefined);
  if (scratch.length > 0) return scratch;
  if (!sameJson(vadOf(before), vadOf(now))) {
    return [`the vad block of ${FROZEN_PARAMS_PATH} differs from its copy under gate-prereg: the voice detector parameters do not change after gate-prereg (spec 7.12)`];
  }
  return [];
}

/**
 * Spec 8.4: PREREG.md holds the voice detector parameters in words, params/frozen.json the same as
 * numbers. Compares the rows "Noise floor" and "Periodicity threshold" with vad.floor_db and
 * vad.periodicity, to the precision doctor prints. A placeholder or a missing value is reported by
 * the other checks.
 */
export function vadAgreementProblems(prereg: string, frozen: unknown): string[] {
  const v = preregVadValues(prereg);
  const problems = [...v.problems];
  const vad = isRecord(frozen) && isRecord(frozen['vad']) ? frozen['vad'] : null;
  if (vad === null) return problems;
  const pairs = [
    { name: 'noise floor', unit: ' dB', words: v.floorDb, numbers: vad['floor_db'], key: 'vad.floor_db', tolerance: FLOOR_DB_TOLERANCE },
    { name: 'periodicity threshold', unit: '', words: v.periodicity, numbers: vad['periodicity'], key: 'vad.periodicity', tolerance: PERIODICITY_TOLERANCE },
  ];
  for (const p of pairs) {
    if (p.words === null || typeof p.numbers !== 'number') continue;
    if (Math.abs(p.words - p.numbers) > p.tolerance + 1e-9) {
      problems.push(`PREREG.md gives the ${p.name} ${p.words}${p.unit}, but ${FROZEN_PARAMS_PATH} has ${p.key} ${p.numbers}: both hold the values of the same doctor run (spec 8.4)`);
    }
  }
  return problems;
}

const APP_COMMIT_RULE =
  'APP_COMMIT names, in backticks, the commit of the app, the gate analysis code and params/frozen.json, and is filled in last, in a commit that changes only PREREG.md (PREREG.md, Placeholders)';

/**
 * APP_COMMIT (PREREG.md): the one commit PREREG.md names; an ancestor of HEAD that differs from
 * it only in PREREG.md (and PREREG.md.ots once the stamp is committed).
 */
export function appCommitProblems(prereg: string, view: RepoView): string[] {
  const commits = new Map<string, string>();
  for (const name of backtickedCommitNames(prereg)) {
    const full = view.resolveCommit(name);
    if (full !== null && !commits.has(full)) commits.set(full, name);
  }
  if (commits.size === 0) return [`PREREG.md names no commit of this repository: ${APP_COMMIT_RULE}`];
  if (commits.size > 1) return [`PREREG.md names ${commits.size} commits (${[...commits.values()].join(', ')}), expected one: ${APP_COMMIT_RULE}`];
  const [full, name] = [...commits.entries()][0]!;
  if (full === view.head || !view.isAncestor(full, view.head)) return [`APP_COMMIT ${name} is not an earlier commit of HEAD: ${APP_COMMIT_RULE}`];
  const other = view.changedPaths(full, view.head).filter((p) => p !== PREREG_PATH && p !== `${PREREG_PATH}.ots`);
  if (other.length > 0) {
    return [`HEAD differs from APP_COMMIT ${name} in ${other.slice(0, 8).join(', ')}${other.length > 8 ? ', ...' : ''}, not only in PREREG.md: ${APP_COMMIT_RULE}`];
  }
  return [];
}

// ---- the tags ----------------------------------------------------------------------------------

/**
 * gate-prereg: PREREG.md with the cue-list hash of every pack (computed from cues.json), the voice
 * detector values of params/frozen.json, APP_COMMIT and no placeholder; params/frozen.json without
 * k and theta_G but with the doctor floor.
 */
function checkGatePrereg(view: RepoView): TagCheck {
  const problems: string[] = [];
  const notes: string[] = [];
  const hashes: HashLine[] = [];
  const prereg = readIn(view.dir, PREREG_PATH);
  if (prereg === null) problems.push(`${PREREG_PATH} does not exist`);
  else hashes.push({ hash: sha256Hex(prereg), what: PREREG_PATH });
  const params = readIn(view.dir, FROZEN_PARAMS_PATH);
  let frozen: unknown;
  if (params === null) problems.push(`${FROZEN_PARAMS_PATH} does not exist: write it after doctor with npx tsx tools/freeze/frozen.ts (spec 7.3)`);
  else {
    problems.push(...gatePreregParamsProblems(params.toString('utf8')).map((p) => `${FROZEN_PARAMS_PATH}: ${p}`));
    hashes.push({ hash: sha256Hex(params), what: FROZEN_PARAMS_PATH });
    frozen = parseJson(params, FROZEN_PARAMS_PATH, []);
  }
  if (prereg !== null) {
    const text = prereg.toString('utf8');
    const cues = checkCueLists(view.dir, text);
    problems.push(...cues.problems);
    notes.push(...cues.notes);
    hashes.push(...cues.hashes.map((c) => ({ hash: c.hash, what: c.path })));
    if (frozen !== undefined) problems.push(...vadAgreementProblems(text, frozen));
    problems.push(...appCommitProblems(text, view));
    const left = placeholderProblem(text);
    if (left !== null) problems.push(left);
  }
  return { problems, notes, hashes };
}

/** A tuned params file: valid, with k and theta_G (spec 8.4). */
function tunedParamsProblems(bytes: Buffer, rel: string): string[] {
  const problems: string[] = [];
  const value = parseJson(bytes, rel, problems);
  if (value === undefined) return problems;
  const invalid = validateFrozenParams(value);
  problems.push(...invalid.map((p) => `${rel}: ${p}`));
  if (invalid.length === 0 && !paramsAreTuned(value as FrozenParams)) problems.push(`${rel} has no k or no theta_G: stage A writes them first (spec 8.4)`);
  return problems;
}

/**
 * gate-retune: params/retune.json, a tuned copy equal to params/frozen.json (spec 8.4, 9.8);
 * PREREG.md and the voice detector as under gate-prereg.
 */
function checkGateRetune(view: RepoView): TagCheck {
  const problems: string[] = [];
  const notes: string[] = [];
  const hashes: HashLine[] = [];
  const retune = readIn(view.dir, RETUNE_PATH);
  const frozen = readIn(view.dir, FROZEN_PARAMS_PATH);
  if (retune === null) problems.push(`${RETUNE_PATH} does not exist`);
  else {
    hashes.push({ hash: sha256Hex(retune), what: RETUNE_PATH });
    problems.push(...tunedParamsProblems(retune, RETUNE_PATH));
  }
  if (frozen === null) problems.push(`${FROZEN_PARAMS_PATH} does not exist`);
  else hashes.push({ hash: sha256Hex(frozen), what: FROZEN_PARAMS_PATH });
  if (retune !== null && frozen !== null) {
    const scratch: string[] = [];
    if (!sameJson(parseJson(retune, RETUNE_PATH, scratch), parseJson(frozen, FROZEN_PARAMS_PATH, scratch))) {
      problems.push(`${RETUNE_PATH} must be a copy of ${FROZEN_PARAMS_PATH} (spec 8.4)`);
    }
  }
  const prereg = readIn(view.dir, PREREG_PATH);
  if (prereg !== null) hashes.push({ hash: sha256Hex(prereg), what: PREREG_PATH });
  problems.push(...unchangedSinceTag(view, 'gate-prereg', PREREG_PATH, notes));
  problems.push(...vadSinceGatePrereg(view, frozen));
  return { problems, notes, hashes };
}

/**
 * freeze-1: freeze_manifest.json valid, its hashes equal PREREG.md, the tuned params/frozen.json and
 * scoring_rules.json; PREREG.md and params/retune.json as under their tags; the voice detector as
 * under gate-prereg (spec 7.12, 8.4).
 */
function checkFreeze1(view: RepoView): TagCheck {
  const problems: string[] = [];
  const notes: string[] = [];
  const hashes: HashLine[] = [];
  const manifestBytes = readIn(view.dir, MANIFEST_PATH);
  if (manifestBytes === null) return { problems: [`${MANIFEST_PATH} does not exist`], notes, hashes };
  hashes.push({ hash: sha256Hex(manifestBytes), what: MANIFEST_PATH });
  const manifest = parseJson(manifestBytes, MANIFEST_PATH, problems) as Record<string, unknown> | undefined;
  if (manifest !== undefined) problems.push(...validateFreezeManifest(manifest).map((p) => `${MANIFEST_PATH}: ${p}`));
  const listed = (key: string): string | null => {
    const v = manifest?.[key];
    return typeof v === 'string' ? v.toLowerCase().replace(/^sha256:/, '') : null;
  };
  const matches = (key: string, rel: string, bytes: Buffer | null): void => {
    if (bytes === null) {
      problems.push(`${rel} does not exist`);
      return;
    }
    const h = sha256Hex(bytes);
    hashes.push({ hash: h, what: rel });
    if (listed(key) !== h) problems.push(`${key} of ${MANIFEST_PATH} is ${listed(key) ?? 'missing'}, not the SHA-256 of ${rel} (${h})`);
  };

  matches('prereg_sha256', PREREG_PATH, readIn(view.dir, PREREG_PATH));
  problems.push(...unchangedSinceTag(view, 'gate-prereg', PREREG_PATH, notes));

  const frozen = readIn(view.dir, FROZEN_PARAMS_PATH);
  matches('params_sha256', FROZEN_PARAMS_PATH, frozen);
  if (frozen !== null) problems.push(...tunedParamsProblems(frozen, FROZEN_PARAMS_PATH));
  problems.push(...vadSinceGatePrereg(view, frozen));

  const rules = readIn(view.dir, SCORING_RULES_PATH);
  matches('scoring_rules_sha256', SCORING_RULES_PATH, rules);
  if (rules !== null) {
    const value = parseJson(rules, SCORING_RULES_PATH, problems);
    if (value !== undefined) problems.push(...validateScoringRules(value).map((p) => `${SCORING_RULES_PATH}: ${p}`));
  }

  if (view.tagCommit('gate-retune') !== null) problems.push(...unchangedSinceTag(view, 'gate-retune', RETUNE_PATH, notes));

  const prompts = listed('prompts_sha256');
  if (prompts !== null && /^[0-9a-f]{64}$/.test(prompts)) {
    hashes.push({ hash: prompts, what: `prompts (as listed in ${MANIFEST_PATH})` });
    notes.push(`prompts_sha256 is taken from ${MANIFEST_PATH} as listed: the prompts have no fixed path to hash yet`);
  }
  return { problems, notes, hashes };
}

/** The checks of one tag on the working tree and the earlier tags. */
export function checkTag(tag: FreezeTag, view: RepoView): TagCheck {
  switch (tag) {
    case 'gate-prereg':
      return checkGatePrereg(view);
    case 'gate-retune':
      return checkGateRetune(view);
    case 'freeze-1':
      return checkFreeze1(view);
  }
}

/** The annotated tag's message: title, then one `<sha256>  <what>` line per hash (sha256sum style). */
export function tagMessage(spec: TagSpec, hashes: readonly HashLine[]): string {
  return [
    spec.title,
    '',
    'SHA-256:',
    ...hashes.map((h) => `${h.hash}  ${h.what}`),
    '',
    `${spec.stamped}.ots holds the OpenTimestamps stamp of ${spec.stamped}.`,
    '',
  ].join('\n');
}

/** First line of the commit that adds the .ots file. */
export function stampCommitSubject(spec: TagSpec): string {
  return `freeze ${spec.tag}: OpenTimestamps stamp of ${spec.stamped} (spec 8.4)`;
}
