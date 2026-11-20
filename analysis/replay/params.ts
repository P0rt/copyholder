// The params stage B scored with: the file whose SHA-256 verdict.json holds (params_sha256),
// hashed as stage B hashes it (analysis/gate/stage-b.ts: sha256Hex of the file's text, spec 8.5).
//
// Stage B scores params/frozen.json as stage A left it (spec 8.4, 9.5, 9.8). On pack A stage A
// tunes k and theta_G and writes the file anew: the gate-prereg copy with k, theta_G and "tuned"
// filled in (analysis/gate/stage-a.ts). Once params/retune.json exists (frozen under the tag
// gate-retune before pack B, PREREG §11) stage A writes nothing: it requires params/frozen.json to
// equal params/retune.json and that file's copy under gate-retune. So by the time a set is
// replayed, params/frozen.json may hold a later pack's params, or the retuned ones.
//
// The order: --params <file> when given, else params/retune.json and then params/frozen.json as
// they stand; then the copy of params/retune.json under the tag gate-retune; then the params stage
// A wrote, rebuilt: the copy of params/frozen.json under the tag gate-prereg with k, criterion_met
// and theta_G of verdict.json (frozen.ts frozenWithTuning and frozenParamsText). Without the tag (a
// copy of the repository without git), a file at hand without what stage A writes (frozen.ts
// withoutStageAKeys) stands in for the tagged copy: stage A refuses to tune unless the two are
// equal (frozen.ts checkPrereg). Whatever replay uses must give the hash of verdict.json; it refuses
// otherwise. A rebuilt file takes its tuning from verdict.json, so recompute.ts reports that tuning
// as an input of the replay unless it recomputes it from the listening block.

import fs from 'node:fs';
import path from 'node:path';
import type { Verdict } from '../../core/schemas/index.ts';
import { GateRefusal } from '../gate/common.ts';
import { PREREG_TAG, RETUNE_TAG, criterionMetOf, frozenParamsText, frozenWithTuning, parseParamsText, withoutStageAKeys } from '../gate/frozen.ts';
import { frozenParamsFile } from '../lib/calib-io.ts';
import { sha256Hex } from '../lib/ledger.ts';
import { shownPath } from '../lib/paths.ts';
import { ReplayRefusal, unreadPathWhy } from './set.ts';

export interface ParamsMatch {
  /** The params as stage B parses them (frozen.ts parseParamsText of the text). */
  value: Record<string, unknown>;
  sha256: string;
  /** tuned.k.criterion_met (spec 8.4, 9.7). */
  criterionMet: boolean;
  /** Where they come from, for the printout. */
  source: string;
  /** A file whose text gives the hash, or a file rebuilt with the tuning of verdict.json. */
  how: 'file' | 'rebuilt';
}

export interface ParamsLookup {
  env: NodeJS.ProcessEnv;
  /** A file's text under a git tag (analysis/gate/deps.ts gitTagFile); null without the tag. */
  tagFile: (tag: string, file: string) => string | null;
  /** --params <file>; null for params/retune.json, then params/frozen.json. */
  paramsFile: string | null;
}

function readText(file: string): string | null {
  const why = unreadPathWhy(file, shownPath(file));
  if (why !== null) throw new ReplayRefusal(why);
  try {
    return fs.readFileSync(file, 'utf8');
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'EISDIR') return null;
    throw e;
  }
}

/** The text and its parse, when the text gives the wanted hash; null otherwise. */
function matchOf(text: string, name: string, want: string, source: string, how: ParamsMatch['how']): ParamsMatch | null {
  const sha = sha256Hex(text);
  if (sha !== want) return null;
  const parsed = parseParamsText(text, name);
  if (parsed.value === null) throw new ReplayRefusal(`${name} gives the params_sha256 of verdict.json but is not valid params:\n  ${parsed.problems.join('\n  ')}`);
  let criterionMet: boolean;
  try {
    criterionMet = criterionMetOf(parsed.value, name);
  } catch (e) {
    if (e instanceof GateRefusal) throw new ReplayRefusal(e.message);
    throw e;
  }
  return { value: parsed.value, sha256: sha, criterionMet, source, how };
}

/** The params whose hash verdict.json holds; a ReplayRefusal lists what was tried. */
export function findParams(verdict: Verdict, o: ParamsLookup): ParamsMatch {
  const want = verdict.params_sha256;
  const frozenFile = frozenParamsFile(o.env);
  const retuneFile = path.join(path.dirname(frozenFile), 'retune.json');
  const files = o.paramsFile !== null ? [path.resolve(o.paramsFile)] : [retuneFile, frozenFile];
  const tried: string[] = [];
  const bases: { source: string; value: Record<string, unknown> }[] = [];

  for (const file of files) {
    const name = shownPath(file);
    const text = readText(file);
    if (text === null) {
      tried.push(`${name} (no such file)`);
      continue;
    }
    const found = matchOf(text, name, want, `${name}, hashed as stage B hashes it`, 'file');
    if (found !== null) return found;
    tried.push(`${name} (${sha256Hex(text).slice(0, 8)})`);
    const parsed = parseParamsText(text, name);
    if (parsed.value !== null) bases.push({ source: `${name} without k, theta_G and tuned`, value: withoutStageAKeys(parsed.value) });
  }

  // Packs B and C: params/retune.json as frozen under gate-retune, when the working copy lost it.
  const retuneTagged = o.tagFile(RETUNE_TAG, retuneFile);
  const retuneName = `params/retune.json under the tag ${RETUNE_TAG}`;
  if (retuneTagged === null) {
    tried.push(`${retuneName} (not in this copy of the repository)`);
  } else {
    const found = matchOf(retuneTagged, retuneName, want, `${retuneName}, hashed as stage B hashes it`, 'file');
    if (found !== null) return found;
    tried.push(`${retuneName} (${sha256Hex(retuneTagged).slice(0, 8)})`);
  }

  // Rebuilt as stage A writes it: the gate-prereg copy first, then the files at hand.
  const taggedText = o.tagFile(PREREG_TAG, frozenFile);
  if (taggedText === null) {
    tried.push(`params/frozen.json under the tag ${PREREG_TAG} (not in this copy of the repository)`);
  } else {
    const tagged = parseParamsText(taggedText, `params/frozen.json at ${PREREG_TAG}`);
    if (tagged.value === null) tried.push(`params/frozen.json under the tag ${PREREG_TAG} (${tagged.problems.join('; ')})`);
    else bases.unshift({ source: `params/frozen.json under the tag ${PREREG_TAG}`, value: tagged.value });
  }
  const t = verdict.tuning;
  const tuning = `k ${t.k}, criterion_met ${t.criterion_met} and theta_G ${t.theta_G} of verdict.json`;
  for (const base of bases) {
    let text: string;
    try {
      text = frozenParamsText(frozenWithTuning(base.value, { k: t.k, criterionMet: t.criterion_met, thetaG: t.theta_G, step: 'stage_a' }));
    } catch (e) {
      if (!(e instanceof GateRefusal)) throw e;
      tried.push(`${base.source} with ${tuning} (${e.message})`);
      continue;
    }
    const source = `${base.source} with ${tuning}, written as stage A writes params/frozen.json`;
    const found = matchOf(text, 'params/frozen.json as stage A wrote it', want, source, 'rebuilt');
    if (found !== null) return found;
    tried.push(`${base.source} with ${tuning} (${sha256Hex(text).slice(0, 8)})`);
  }

  throw new ReplayRefusal(
    `no params give the params_sha256 of verdict.json (${want.slice(0, 8)}); tried ${tried.join('; ')}. ` +
      `Name the params file stage B scored with --params <file>, or fetch the tags (git fetch --tags) so that replay can find it under ${RETUNE_TAG} or rebuild it from ${PREREG_TAG} (spec 8.4, 8.5)`,
  );
}

/**
 * True when the params hold stage A's tuning: a "tuned" block that names stage_a for both k and
 * theta_G (frozen.ts frozenWithTuning). Stage A tunes them on the gate recording, pack A (PREREG
 * §11), or pack B or C when it was recorded as the gate after a lost pack A (PREREG §7.4); a
 * retune.json that keeps pack A's stage A file carries them onto packs B and C unchanged. Params of
 * the retune name "retune" (analysis/gate/retune.ts retuneParams).
 */
export function tunedByStageA(params: Pick<ParamsMatch, 'value'>): boolean {
  const tuned = params.value['tuned'] as { k?: { step?: unknown }; theta_G?: { step?: unknown } } | undefined;
  return tuned?.k?.step === 'stage_a' && tuned.theta_G?.step === 'stage_a';
}

/** tuned.k.step of the params, for the printout; null when the file has none. */
export function tunedStepOf(params: Pick<ParamsMatch, 'value'>): string | null {
  const tuned = params.value['tuned'] as { k?: { step?: unknown } } | undefined;
  return typeof tuned?.k?.step === 'string' ? tuned.k.step : null;
}
