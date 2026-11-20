// npm run confirm (PREREG.md section 11): every check first, then stage B's computation again on
// each recording of pack B and C that is in the numbers (and on pack A with --dev), the pooled
// numbers, and results/confirm.json and results/confirm.md. Session folders are only read; a
// refusal writes nothing.

import fs from 'node:fs';
import path from 'node:path';
import { utcSeconds } from '../lib/ledger.ts';
import { shownPath } from '../lib/paths.ts';
import { RETUNE_TAG } from '../gate/frozen.ts';
import { ConfirmRefusal, resultsDir } from './common.ts';
import type { ConfirmDeps } from './deps.ts';
import { packFacts, requireFactsMatch } from './facts.ts';
import { inspectPack, readRetunedParams, recomputePack, type PackRecord, type RetunedParams } from './load.ts';
import { confirmNumbers } from './numbers.ts';
import { confirmReport, repliesCheck, type LostPack, type PackSummary, type Report } from './report.ts';
import { retuneTagFacts } from './tag.ts';

export const CONFIRM_JSON = 'confirm.json';
export const CONFIRM_MD = 'confirm.md';

export interface ConfirmOptions {
  /** The recordings of packs B and C, in either order (ids or folders). */
  ids: readonly [string, string];
  /** The pack A recording, for its numbers as development data; null without --dev. */
  dev: string | null;
  deps: ConfirmDeps;
}

export interface ConfirmOutcome extends Report {
  jsonPath: string;
  mdPath: string;
}

const short = (sha: string): string => sha.slice(0, 8);

export interface CheckedPair {
  /** The two recordings, pack B first. */
  packs: [PackRecord, PackRecord];
  /** Those in the numbers (they count, or failed quickcheck on condition 6 alone), pack B first. */
  scored: PackRecord[];
  /** Those lost after 4:15 (section 11). */
  lost: PackRecord[];
  params: RetunedParams;
}

/**
 * The checks of section 11 across recordings: two different recordings, one of pack B and one of
 * pack C, at least one of them in the numbers, and every stage A among them run on the same
 * params, which are params/frozen.json as the retune froze it.
 */
export function checkPair(recs: readonly [PackRecord, PackRecord], deps: Pick<ConfirmDeps, 'env' | 'tagFile'>): CheckedPair {
  const [x, y] = recs;
  if (path.resolve(x.dir) === path.resolve(y.dir)) throw new ConfirmRefusal(`${x.arg} and ${y.arg} are the same recording: give the recordings of packs B and C`);
  if (x.pack === y.pack) {
    throw new ConfirmRefusal(`${x.id} and ${y.id} are both pack ${x.pack}: the confirmation pools one recording of pack B and one of pack C (PREREG.md section 11)`);
  }
  const packs: [PackRecord, PackRecord] = x.pack === 'B' ? [x, y] : [y, x];
  const scored = packs.filter((r) => r.standing !== 'lost');
  const lost = packs.filter((r) => r.standing === 'lost');
  if (scored.length === 0) {
    throw new ConfirmRefusal(
      [
        'both recordings are lost, each failed for a technical reason after its objection block began (4:15), so there are no confirmatory numbers (PREREG.md section 11):',
        ...lost.map((r) => `  pack ${r.pack} (${r.id}): ${r.voidReasons.join('; ')}`),
      ].join('\n'),
    );
  }
  const staged = scored.filter((r): r is PackRecord & { stageASha256: string } => r.stageASha256 !== null);
  const [b, c] = staged;
  if (b !== undefined && c !== undefined && b.stageASha256 !== c.stageASha256) {
    throw new ConfirmRefusal(
      `pack B (${b.id}) was scored with params ${short(b.stageASha256)} and pack C (${c.id}) with params ${short(c.stageASha256)}: both packs are recorded and scored with the same frozen parameters (PREREG.md section 11)`,
    );
  }
  const params = readRetunedParams(deps);
  for (const r of staged) {
    if (r.stageASha256 !== params.sha256) {
      throw new ConfirmRefusal(
        `pack ${r.pack} (${r.id}): stage A recorded params ${short(r.stageASha256)}, but params/frozen.json is ${short(params.sha256)}: on packs B and C stage A only checks params/frozen.json against params/retune.json under the tag ${RETUNE_TAG} and tunes nothing, so it must have run on this very file (PREREG.md section 11)`,
      );
    }
  }
  return { packs, scored, lost, params };
}

/** Stage B's computation again on one recording, and what the report shows of it. */
function summaryOf(rec: PackRecord, params: RetunedParams, env: NodeJS.ProcessEnv): PackSummary {
  const what = `pack ${rec.pack} (${rec.id})`;
  const r = recomputePack(rec, params, env);
  if (r.differences !== null && r.differences.length > 0) {
    throw new ConfirmRefusal(
      `${what}: stage B's computation run again on the same files and params does not give the verdict.json stage B wrote, so the pooled numbers would not be the ones behind its verdict:\n  ${r.differences.join('\n  ')}`,
    );
  }
  const facts = packFacts(r.runs);
  // The pooled numbers add up these facts: they must be the counts of the verdict the same runs give.
  requireFactsMatch(what, facts, r.verdict);
  const own = rec.stageB;
  return {
    id: rec.id,
    pack: rec.pack,
    sdkVersion: rec.sdkVersion,
    standing: rec.standing === 'content' ? 'content' : 'counts',
    source: own === null ? 'confirm' : 'stage B',
    verdict: own?.verdict ?? r.verdict,
    verdictMd: own?.verdictMd ?? r.rowsText,
    voidReasons: rec.voidReasons,
    replies: repliesCheck(rec.quickcheck.checks),
    facts,
  };
}

/** Writes each file as <file>.partial and renames it, so a stop never leaves half a file. */
function writeOutputs(files: readonly { file: string; text: string }[]): void {
  for (const f of files) {
    fs.mkdirSync(path.dirname(f.file), { recursive: true });
    fs.writeFileSync(`${f.file}.partial`, f.text);
  }
  for (const f of files) fs.renameSync(`${f.file}.partial`, f.file);
}

export function runConfirm(o: ConfirmOptions): ConfirmOutcome {
  const { deps } = o;
  const env = deps.env;

  // Checks first; nothing is computed until every one has passed (section 11): each recording,
  // the pair and the params, the pack A recording, and the tag gate-retune.
  const recs: [PackRecord, PackRecord] = [inspectPack(o.ids[0], 'confirm', env), inspectPack(o.ids[1], 'confirm', env)];
  const { packs, scored, lost, params } = checkPair(recs, deps);
  const devRec = o.dev === null ? null : inspectPack(o.dev, 'dev', env);
  const tag = retuneTagFacts(
    packs.map((r) => ({ pack: r.pack, id: r.id, startedUtc: r.startedUtc })),
    deps,
  );

  // Stage B's computation again, one recording at a time (each holds its audio only while it runs).
  const summaries = scored.map((rec) => summaryOf(rec, params, env));
  const devSummary = devRec === null ? null : summaryOf(devRec, params, env);
  const lostPacks: LostPack[] = lost.map((r) => ({ pack: r.pack as 'B' | 'C', id: r.id, reasons: r.voidReasons }));

  const report = confirmReport({
    generatedUtc: utcSeconds(deps.now()),
    commit: deps.commit(),
    params: { sha256: params.sha256, variant: params.variant, k: params.k, L: params.L, M: params.M, thetaG: params.thetaG, criterionMet: params.criterionMet },
    tag,
    packs: summaries,
    lost: lostPacks,
    pooled: confirmNumbers(summaries.map((s) => s.facts)),
    dev: devSummary === null ? null : { pack: devSummary, numbers: confirmNumbers([devSummary.facts]) },
  });

  const dir = resultsDir(env);
  const jsonPath = path.join(dir, CONFIRM_JSON);
  const mdPath = path.join(dir, CONFIRM_MD);
  writeOutputs([
    { file: jsonPath, text: `${JSON.stringify(report.json, null, 2)}\n` },
    { file: mdPath, text: report.markdown },
  ]);
  for (const line of report.summary) deps.log(line);
  deps.log(`confirm: wrote ${shownPath(jsonPath)} and ${shownPath(mdPath)}`);
  return { ...report, jsonPath, mdPath };
}
