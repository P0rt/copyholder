// params/frozen.json and stage A (spec 8.4): stage A starts from the gate-prereg file, which holds
// everything but k and theta_G, and writes it back with k, theta_G and the "tuned" block filled in.
// After a retune stage A only compares frozen.json with retune.json (spec 9.8).

import { orderKeys, validateFrozenParams, type FrozenParams } from '../../core/schemas/index.ts';
import { STAGE_A_PATHS } from '../../tools/freeze/params.ts';
import { DEFAULT_G_PARAMS } from '../rivals/index.ts';
import { GateRefusal } from './common.ts';

/** The tag that freezes params/frozen.json without k and theta_G before the recording (spec 8.4, 9.1). */
export const PREREG_TAG = 'gate-prereg';
/** The tag that freezes params/retune.json (spec 8.4, 9.8). */
export const RETUNE_TAG = 'gate-retune';

export interface Tuned {
  k: number;
  criterionMet: boolean;
  thetaG: number;
  step: 'stage_a' | 'retune' | 'rehearsal';
}

/** The base with k, theta_G and "tuned" set; validated (spec 8.4). */
export function frozenWithTuning(base: Readonly<Record<string, unknown>>, t: Tuned): FrozenParams {
  const d1 = { ...(base['d1'] as Record<string, unknown>), k: t.k };
  const g = { ...(base['g'] as Record<string, unknown>), theta_G: t.thetaG };
  const value: Record<string, unknown> = {
    ...base,
    d1,
    g,
    tuned: { k: { step: t.step, criterion_met: t.criterionMet, rehearsal_step_up: false }, theta_G: { step: t.step } },
  };
  const problems = validateFrozenParams(value);
  if (problems.length > 0) throw new GateRefusal(`the new params/frozen.json would not be valid:\n  ${problems.join('\n  ')}`);
  return value as unknown as FrozenParams;
}

/** The text of params/frozen.json: the spec 8.4 key order, one top-level block per line. */
export function frozenParamsText(value: object): string {
  const ordered = orderKeys(value, 'params/frozen.json') as Record<string, unknown>;
  const lines = Object.entries(ordered).map(([k, v]) => `${JSON.stringify(k)}:${JSON.stringify(v)}`);
  return `{${lines.join(',\n ')}}\n`;
}

/** A parsed params file, or null with the reason. */
export function parseParamsText(text: string, name: string): { value: Record<string, unknown> | null; problems: string[] } {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (e) {
    return { value: null, problems: [`${name} is not valid JSON: ${(e as Error).message}`] };
  }
  const problems = validateFrozenParams(value);
  if (problems.length > 0) return { value: null, problems: problems.map((p) => `${name}: ${p}`) };
  return { value: value as Record<string, unknown>, problems: [] };
}

/** Deep equality of two JSON values (key order does not matter). */
export function sameJson(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b || a === null || b === null || typeof a !== 'object') return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a)) {
    const bb = b as unknown[];
    return a.length === bb.length && a.every((x, i) => sameJson(x, bb[i]));
  }
  const ao = a as Record<string, unknown>;
  const bo = b as Record<string, unknown>;
  const ka = Object.keys(ao);
  const kb = Object.keys(bo);
  return ka.length === kb.length && ka.every((k) => Object.hasOwn(bo, k) && sameJson(ao[k], bo[k]));
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** A copy without what stage A writes: d1.k, g.theta_G, tuned, and flat k or theta_G (spec 8.4). */
export function withoutStageAKeys(value: Readonly<Record<string, unknown>>): Record<string, unknown> {
  const out = structuredClone(value) as Record<string, unknown>;
  for (const p of STAGE_A_PATHS) {
    let at: unknown = out;
    for (const key of p.slice(0, -1)) at = isRecord(at) ? at[key] : undefined;
    if (isRecord(at)) delete at[p[p.length - 1]!];
  }
  return out;
}

/** Dotted paths where two JSON values differ, at most `max` of them. */
export function jsonDiffPaths(a: unknown, b: unknown, max = 8, at = ''): string[] {
  if (sameJson(a, b)) return [];
  if (!isRecord(a) || !isRecord(b)) return [at === '' ? '(the whole file)' : at];
  const out: string[] = [];
  for (const key of [...new Set([...Object.keys(a), ...Object.keys(b)])].sort()) {
    if (out.length >= max) break;
    out.push(...jsonDiffPaths(a[key], b[key], max - out.length, at === '' ? key : `${at}.${key}`));
  }
  return out;
}

/**
 * Spec 8.4, 9.1: stage A tunes on the params frozen under gate-prereg. params/frozen.json, without
 * the values stage A writes, must equal its copy under the tag; refuses otherwise.
 */
export function checkPrereg(c: { frozen: Readonly<Record<string, unknown>>; taggedText: string | null; tag: string }): void {
  const fix = `freeze params/frozen.json before the recording (npx tsx tools/freeze/frozen.ts, then npm run freeze -- ${c.tag})`;
  if (c.taggedText === null) throw new GateRefusal(`params/frozen.json is not under the git tag ${c.tag}: ${fix} (spec 8.4, 9.1)`);
  let tagged: unknown;
  try {
    tagged = JSON.parse(c.taggedText);
  } catch (e) {
    throw new GateRefusal(`params/frozen.json under the tag ${c.tag} is not valid JSON: ${(e as Error).message}`);
  }
  if (!isRecord(tagged)) throw new GateRefusal(`params/frozen.json under the tag ${c.tag} is not a JSON object`);
  const diff = jsonDiffPaths(withoutStageAKeys(tagged), withoutStageAKeys(c.frozen));
  if (diff.length > 0) {
    throw new GateRefusal(`params/frozen.json differs from its copy under the tag ${c.tag} at ${diff.join(', ')}: only k, theta_G and "tuned" may change at stage A (spec 8.4)`);
  }
}

/** tuned.k.criterion_met of tuned params; a refusal when stage A did not write it (spec 8.4, 9.7). */
export function criterionMetOf(frozen: Readonly<Record<string, unknown>>, name: string): boolean {
  const tuned = frozen['tuned'];
  const k = isRecord(tuned) ? tuned['k'] : undefined;
  const met = isRecord(k) ? k['criterion_met'] : undefined;
  if (typeof met !== 'boolean') throw new GateRefusal(`${name} has no tuned.k.criterion_met: run stage A first (spec 8.4)`);
  return met;
}

export interface RetuneCheckInput {
  frozenText: string | null;
  retuneText: string;
  /** retune.json as stored under the gate-retune tag; null when the tag or the file is missing. */
  taggedText: string | null;
  tag: string;
}

/**
 * Spec 9.8: on the recording after a retune stage A tunes nothing; params/frozen.json must equal its
 * copy params/retune.json, and that copy must be the one under the gate-retune tag. Returns the
 * parsed frozen params, or refuses.
 */
export function checkRetune(c: RetuneCheckInput): Record<string, unknown> {
  if (c.frozenText === null) throw new GateRefusal('params/retune.json exists but params/frozen.json does not (spec 9.8)');
  const frozen = parseParamsText(c.frozenText, 'params/frozen.json');
  if (frozen.value === null) throw new GateRefusal(frozen.problems.join('\n'));
  const retune = parseParamsText(c.retuneText, 'params/retune.json');
  if (retune.value === null) throw new GateRefusal(retune.problems.join('\n'));
  if (c.taggedText === null) throw new GateRefusal(`params/retune.json is not under the git tag ${c.tag}: freeze it first (npm run freeze -- ${c.tag}, spec 8.4)`);
  const tagged = parseParamsText(c.taggedText, `params/retune.json at ${c.tag}`);
  if (tagged.value === null || !sameJson(tagged.value, retune.value)) {
    throw new GateRefusal(`params/retune.json differs from its copy under the tag ${c.tag}: the frozen copy must not change (spec 9.8)`);
  }
  if (!sameJson(frozen.value, retune.value)) {
    throw new GateRefusal('params/frozen.json differs from params/retune.json: stage A tunes nothing after a retune and refuses a mismatch (spec 9.5, 9.8)');
  }
  return frozen.value;
}

export interface GSettings {
  thetaG: number | null;
  frames: number;
  baselineS: number;
  resetWaitS: number;
}

/** The g block of params/frozen.json with the defaults of spec 7.5 for missing fields. */
export function gSettingsOf(frozen: Readonly<Record<string, unknown>>): GSettings {
  const g = (frozen['g'] ?? {}) as Record<string, unknown>;
  const num = (v: unknown, d: number): number => (typeof v === 'number' && Number.isFinite(v) ? v : d);
  return {
    thetaG: typeof g['theta_G'] === 'number' ? g['theta_G'] : null,
    frames: num(g['frames'], DEFAULT_G_PARAMS.frames),
    baselineS: num(g['baseline_s'], DEFAULT_G_PARAMS.baseline_s),
    resetWaitS: num(g['reset_wait_s'], DEFAULT_G_PARAMS.reset_wait_s),
  };
}

/** Detector variant of the frozen params (spec 7.4, 9.8): D3 only after the retune ladder reached it. */
export function variantOf(frozen: Readonly<Record<string, unknown>>): 'D1' | 'D3' {
  const d1 = (frozen['d1'] ?? {}) as Record<string, unknown>;
  return frozen['variant'] === 'D3' || d1['variant'] === 'D3' ? 'D3' : 'D1';
}
