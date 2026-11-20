// npm run confirm (PREREG.md section 11): every check first, then stage B's computation again on
// each recording of pack B and C that is in the numbers (and on pack A with --dev), the pooled
// numbers, and results/confirm.json and results/confirm.md. Pack B may be given alone when pack C
// has no recording (section 11: pack C cannot be started for lack of SDK credits). Each recording
// given must be the one section 11 keeps for its pack: no earlier recording of that pack but an
// attempt that section 11 records again, and the later ones are reported as not in the numbers.
// A folder of pack B or C that no SDK measured (dry, the mock tap, no SDK) is no recording: it is
// reported as not counted, and one that reached the objection block before the recording of its
// pack in the numbers marks the numbers not confirmatory (the participant heard that pack before).
// A file that cannot be read is refused with its name and what to do, never thrown as it is.
// Session folders are only read; a refusal writes nothing.

import fs from 'node:fs';
import path from 'node:path';
import { utcSeconds } from '../lib/ledger.ts';
import { sessionDirOf, shownPath } from '../lib/paths.ts';
import { RETUNE_TAG } from '../gate/frozen.ts';
import {
  ConfirmRefusal,
  RecordAgainRefusal,
  UnreadableFileRefusal,
  UnsavedRefusal,
  folderArg,
  givenName,
  isFsError,
  namedIn,
  resultsDir,
  unreadableFile,
} from './common.ts';
import type { ConfirmDeps } from './deps.ts';
import { packFacts, requireFactsMatch } from './facts.ts';
import {
  compareRecordings,
  gateRecordingsOf,
  inspectPack,
  isScored,
  objectionsReached,
  readRetunedParams,
  recomputePack,
  type GateRecordingEntry,
  type LostFacts,
  type PackFolders,
  type PackRecord,
  type RetunedParams,
  type ScoredRecord,
  type UnmeasuredFolder,
} from './load.ts';
import { confirmNumbers } from './numbers.ts';
import { confirmReport, lostPhrase, repliesCheck, type LaterRecording, type LostPack, type NotCountedFolder, type PackSummary, type Report } from './report.ts';
import { retuneTagFacts } from './tag.ts';

export const CONFIRM_JSON = 'confirm.json';
export const CONFIRM_MD = 'confirm.md';

export interface ConfirmOptions {
  /** The recordings of packs B and C, in either order (ids or folders); pack B alone when pack C has no recording. */
  ids: readonly string[];
  /** The pack A recording, for its numbers as development data; null without --dev. */
  dev: string | null;
  deps: ConfirmDeps;
}

export interface ConfirmOutcome extends Report {
  jsonPath: string;
  mdPath: string;
}

const short = (sha: string): string => sha.slice(0, 8);

/** Pack C without a recording, when pack B is given alone (section 11). */
export interface NotRecorded {
  pack: 'C';
  /** Ids of pack C recordings that failed for a technical reason before 4:15, which section 11 records again. */
  attempts: string[];
}

export interface CheckedPacks {
  /** The recordings given, pack B first. */
  packs: PackRecord[];
  /** Those in the numbers (they count, or failed quickcheck on condition 6 alone), pack B first. */
  scored: ScoredRecord[];
  /** Those lost: after 4:15, or ended by kCreditExhausted (section 11). */
  lost: PackRecord[];
  /** Pack C when pack B is given alone; null with two recordings. */
  notRecorded: NotRecorded | null;
  /** Recordings of the packs given made after the ones given, which are not in the numbers (section 11). */
  later: LaterRecording[];
  /** Folders of packs B and C in the sessions folder that no SDK measured: no recordings, not counted (spec 6.5). */
  notCounted: NotCountedFolder[];
  /**
   * Why the numbers are not confirmatory, beyond the tag: a run no SDK measured reached the objection
   * block of a pack before the recording of that pack in the numbers (sections 7.1, 11).
   */
  heardBefore: string[];
  params: RetunedParams;
}

/** "  pack C (gate-c): it failed for a technical reason after ... Reason: ..." for a refusal. */
function lostLine(r: PackRecord): string {
  return `  pack ${r.pack} (${namedIn(r.id, path.basename(r.dir))}): ${lostPhrase(r.lost ?? { cause: 'technical', objectionsBegun: true })}. Reason: ${r.voidReasons.join('; ')}`;
}

/** Two different recordings, one of pack B and one of pack C, pack B first. */
function pairOf(x: PackRecord, y: PackRecord): PackRecord[] {
  if (path.resolve(x.dir) === path.resolve(y.dir)) throw new ConfirmRefusal(`${x.arg} and ${y.arg} are the same recording: give the recordings of packs B and C`);
  if (x.pack === y.pack) {
    throw new ConfirmRefusal(`${x.id} and ${y.id} are both pack ${x.pack}: the confirmation pools one recording of pack B and one of pack C (PREREG.md section 11)`);
  }
  return x.pack === 'B' ? [x, y] : [y, x];
}

/** One id alone: the pack B recording, for the numbers of pack B alone (section 11). */
function aloneB(b: PackRecord): PackRecord {
  if (b.pack !== 'B') {
    throw new ConfirmRefusal(
      `${b.id} is pack ${b.pack}: one id alone must be the pack B recording, for the numbers of pack B alone when pack C cannot be started for lack of SDK credits (PREREG.md section 11); pack B is recorded before pack C, so give the pack B recording too, and a lost one is reported as lost`,
    );
  }
  return b;
}

/**
 * What section 11 makes of a recording that was not given: an attempt recorded again, in the
 * numbers, or lost; or confirm cannot judge it yet: a step it needs has not run (unread), a file of
 * it cannot be read (unreadable), or host did not finish saving it (unsaved).
 */
type OtherStanding =
  | { kind: 'again' }
  | { kind: 'scored' }
  | { kind: 'lost'; lost: LostFacts }
  | { kind: 'unread'; why: string }
  | { kind: 'unreadable'; file: UnreadableFileRefusal }
  | { kind: 'unsaved'; why: string };

function otherStanding(dir: string, env: NodeJS.ProcessEnv): OtherStanding {
  try {
    const r = inspectPack(dir, 'confirm', env);
    return r.standing === 'lost' ? { kind: 'lost', lost: r.lost ?? { cause: 'technical', objectionsBegun: true } } : { kind: 'scored' };
  } catch (e) {
    if (e instanceof RecordAgainRefusal) return { kind: 'again' };
    if (e instanceof UnsavedRefusal) return { kind: 'unsaved', why: e.message };
    // A file of the folder that cannot be read (a folder in its place, no permission to read it):
    // the recording is judged once it can be read.
    if (e instanceof UnreadableFileRefusal) return { kind: 'unreadable', file: e };
    if (e instanceof ConfirmRefusal) return { kind: 'unread', why: e.message };
    if (isFsError(e)) return { kind: 'unreadable', file: unreadableFile(e, dir) };
    throw e;
  }
}

/**
 * How to name a recording of the sessions folder to be given on the command line: its id, or its
 * folder with the id, by its name or, when that is not a session id, by its path (folderArg).
 */
function toGive(r: Pick<GateRecordingEntry, 'id' | 'dir'>): string {
  return givenName(r.id, folderArg(r.dir));
}

/**
 * The recording section 11 keeps for the pack of `r`, among `others`, the recordings of that pack in
 * the sessions folder: the first one made (load.ts compareRecordings), unless it failed for a
 * technical reason before 4:15 other than the end of the SDK credits, when the pack is recorded
 * again; a lost recording is not replaced. So each recording of the pack made before `r` must be
 * such an attempt; any other is the pack's recording, and `r` is refused with the name to give in
 * its place (its folder too, when an operator renamed the folder). One confirm cannot judge yet is
 * refused with what keeps it from judging it. Returns the recordings made after `r` that are not
 * such attempts, each once: they are not in the numbers, and the report says so. A copy of `r` (the
 * same start and id), its own folder among them, is neither.
 */
function laterRecordings(r: PackRecord, others: readonly GateRecordingEntry[], env: NodeJS.ProcessEnv): LaterRecording[] {
  if (r.pack === 'A') return [];
  const pack = r.pack;
  const given = toGive(r);
  for (const o of others.filter((x) => compareRecordings(x, r) < 0)) {
    const s = otherStanding(o.dir, env);
    if (s.kind === 'again') continue;
    const head = `pack ${pack} has a recording made before ${given}: ${o.id} in ${shownPath(o.dir)}, which`;
    if (s.kind === 'unreadable') {
      throw new ConfirmRefusal(
        `${head} confirm cannot read yet: ${s.file.bare}. Unless ${o.id} failed for a technical reason before 4:15 other than the end of the SDK credits, it is the recording of pack ${pack}, and ${toGive(o)} is the one to give (PREREG.md section 11)`,
      );
    }
    if (s.kind === 'unsaved') throw new ConfirmRefusal(`${head} confirm cannot judge: ${s.why}`);
    if (s.kind === 'unread') {
      throw new ConfirmRefusal(
        `${head} confirm cannot read yet. Unless it failed for a technical reason before 4:15 other than the end of the SDK credits, it is the recording of pack ${pack}, and ${toGive(o)} is the one to give (PREREG.md section 11): ${s.why}`,
      );
    }
    throw new ConfirmRefusal(
      s.kind === 'lost'
        ? `${head} is lost (${lostPhrase(s.lost)}). Section 11 does not replace a lost recording, so ${o.id} is the recording of pack ${pack}, reported as lost: give ${toGive(o)} in place of ${given} (PREREG.md section 11)`
        : `${head} is in the numbers. Section 11 keeps the first recording of a pack and records a pack again only after a technical failure before 4:15, so ${o.id} is the recording of pack ${pack}: give ${toGive(o)} in place of ${given} (PREREG.md section 11)`,
    );
  }
  const later = others.filter((x) => compareRecordings(x, r) > 0 && otherStanding(x.dir, env).kind !== 'again');
  return later
    .filter((x, i) => later.findIndex((y) => compareRecordings(x, y) === 0) === i)
    .map((x) => ({ pack, id: x.id, folder: path.basename(x.dir), after: r.id, afterFolder: path.basename(r.dir), afterLost: r.standing === 'lost' }));
}

/**
 * Pack C when pack B is given alone (section 11: pack C cannot be started for lack of SDK
 * credits): `cs`, the recordings of pack C in the sessions folder, are all attempts that failed for
 * a technical reason before 4:15, which section 11 records again. A pack C recording in the numbers,
 * a lost one, or one confirm cannot read yet is refused, with the name to give: it is given as the
 * second id, so that nothing of pack C is left out of the report. One confirm cannot judge yet is
 * refused with what keeps it from judging it.
 */
function notRecordedC(cs: readonly GateRecordingEntry[], env: NodeJS.ProcessEnv): NotRecorded {
  const attempts: string[] = [];
  for (const c of cs) {
    const s = otherStanding(c.dir, env);
    if (s.kind === 'again') {
      attempts.push(c.id);
      continue;
    }
    const head = `pack C has a recording, ${c.id} in ${shownPath(c.dir)}`;
    if (s.kind === 'unreadable') {
      throw new ConfirmRefusal(
        `${head}, which confirm cannot read yet: ${s.file.bare}. Unless ${c.id} failed for a technical reason before 4:15 other than the end of the SDK credits, pack B is not given alone, and ${toGive(c)} is the second id (PREREG.md section 11)`,
      );
    }
    if (s.kind === 'unsaved') throw new ConfirmRefusal(`${head}, so pack B is not given alone, and confirm cannot judge that recording: ${s.why}`);
    const state =
      s.kind === 'lost' ? `it is lost (${lostPhrase(s.lost)}) and is reported as lost` : s.kind === 'scored' ? 'it is in the numbers' : `confirm cannot read it yet: ${s.why}`;
    throw new ConfirmRefusal(`${head}, so pack B is not given alone: give ${toGive(c)} as the second id; ${state} (PREREG.md section 11)`);
  }
  return { pack: 'C', attempts };
}

/**
 * The runs no SDK measured that started before `r`, the recording of its pack in the numbers, and
 * reached that pack's objection block (4:15) by the step mark in their stamps.jsonl: the
 * participant heard the planted errors of the pack before its recording, which section 7.1 rules
 * out ("neither reads nor hears the packs beforehand"), so the numbers are not confirmatory. A run
 * whose stamps.jsonl cannot be read is not shown to have stopped before 4:15, and counts too.
 */
function heardBeforeProblems(r: ScoredRecord, unmeasured: readonly UnmeasuredFolder[]): string[] {
  if (r.pack === 'A') return [];
  const pack = r.pack;
  const out: string[] = [];
  for (const u of unmeasured.filter((x) => compareRecordings(x, r) < 0)) {
    // The report names folders, never paths.
    const run = `the folder ${path.basename(u.dir)} holds a run of pack ${pack} that no SDK measured, which started before ${givenName(r.id, path.basename(r.dir))}, the recording of pack ${pack} in the numbers`;
    let reached: boolean;
    try {
      reached = objectionsReached(u.dir, pack);
    } catch (e) {
      const error = e instanceof UnreadableFileRefusal ? e.error : isFsError(e) ? e.message : null;
      if (error === null) throw e;
      out.push(
        `${run}, and its stamps.jsonl cannot be read (${error}), so it is not shown that the run stopped before its objection block (4:15): the participant may have heard the planted errors of pack ${pack} before that recording, and the participant neither reads nor hears the packs beforehand (PREREG.md sections 7.1 and 11)`,
      );
      continue;
    }
    if (reached) {
      out.push(
        `${run}, and reached its objection block (4:15): the participant heard the planted errors of pack ${pack} before that recording, and the participant neither reads nor hears the packs beforehand (PREREG.md sections 7.1 and 11)`,
      );
    }
  }
  return out;
}

/** A folder of pack B or C no SDK measured, as the report lists it: not counted (spec 6.5). */
function notCountedOf(pack: 'B' | 'C', u: UnmeasuredFolder): NotCountedFolder {
  return { pack, id: u.id, folder: path.basename(u.dir), why: u.why };
}

/**
 * The checks of section 11 across recordings: two different recordings, one of pack B and one of
 * pack C, or pack B alone when pack C has no recording; each the recording section 11 keeps for
 * its pack; at least one recording in the numbers; and every stage A among them run on the same
 * params, which are params/frozen.json as the retune froze it. The folders of packs B and C that no
 * SDK measured are not recordings: they are listed as not counted, and one that reached the
 * objection block of a pack before its recording in the numbers marks the numbers not confirmatory.
 */
export function checkPacks(recs: readonly PackRecord[], deps: Pick<ConfirmDeps, 'env' | 'tagFile'>): CheckedPacks {
  if (recs.length !== 1 && recs.length !== 2) throw new ConfirmRefusal(`one or two recordings are checked, not ${recs.length}`);
  const packs = recs.length === 2 ? pairOf(recs[0]!, recs[1]!) : [aloneB(recs[0]!)];
  // The gate folders of packs B and C in the sessions folder, read once for every check below.
  const folders: Record<'B' | 'C', PackFolders> = { B: gateRecordingsOf('B', deps.env), C: gateRecordingsOf('C', deps.env) };
  const later = packs.flatMap((r) => (r.pack === 'A' ? [] : laterRecordings(r, folders[r.pack].recordings, deps.env)));
  const notRecorded = recs.length === 1 ? notRecordedC(folders.C.recordings, deps.env) : null;
  const scored = packs.filter(isScored);
  const lost = packs.filter((r) => !isScored(r));
  if (scored.length === 0) {
    const head =
      notRecorded === null
        ? 'both recordings are lost, so there are no confirmatory numbers (PREREG.md section 11):'
        : 'pack B is lost and pack C has no recording, so there are no confirmatory numbers (PREREG.md section 11):';
    throw new ConfirmRefusal([head, ...lost.map(lostLine)].join('\n'));
  }
  const staged = scored.filter((r): r is ScoredRecord & { stageASha256: string } => r.stageASha256 !== null);
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
  const notCounted = (['B', 'C'] as const).flatMap((p) => folders[p].unmeasured.map((u) => notCountedOf(p, u)));
  const heardBefore = scored.flatMap((r) => (r.pack === 'A' ? [] : heardBeforeProblems(r, folders[r.pack].unmeasured)));
  return { packs, scored, lost, notRecorded, later, notCounted, heardBefore, params };
}

/** Stage B's computation again on one recording, and what the report shows of it. */
function summaryOf(rec: ScoredRecord, params: RetunedParams, env: NodeJS.ProcessEnv): PackSummary {
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
    folder: path.basename(rec.dir),
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

/**
 * Runs `f` on the recording given on the command line as `arg`. A file of it that cannot be read
 * is refused with `arg`, the file and the error, and what to do (PREREG.md section 11), never
 * thrown as it is: the error Node gives for a folder in place of a file names no file.
 */
function onGiven<T>(arg: string, env: NodeJS.ProcessEnv, f: () => T): T {
  try {
    return f();
  } catch (e) {
    if (e instanceof UnreadableFileRefusal) throw new ConfirmRefusal(`${arg}: ${e.message}`);
    if (e instanceof ConfirmRefusal || !isFsError(e)) throw e;
    throw new ConfirmRefusal(`${arg}: ${unreadableFile(e, sessionDirOf(arg, env)).message}`);
  }
}

export function runConfirm(o: ConfirmOptions): ConfirmOutcome {
  const { deps } = o;
  const env = deps.env;

  // Checks first; nothing is computed until every one has passed (section 11): each recording,
  // the pair, the other recordings of each pack, the params, the pack A recording, and the tag
  // gate-retune.
  const recs = o.ids.map((id) => onGiven(id, env, () => inspectPack(id, 'confirm', env)));
  const { packs, scored, lost, notRecorded, later, notCounted, heardBefore, params } = checkPacks(recs, deps);
  const dev = o.dev;
  const devRec = dev === null ? null : onGiven(dev, env, () => inspectPack(dev, 'dev', env));
  const tag = retuneTagFacts(
    packs.map((r) => ({ pack: r.pack, id: r.id, startedUtc: r.startedUtc })),
    deps,
  );

  // Stage B's computation again, one recording at a time (each holds its audio only while it runs).
  const summaries = scored.map((rec) => onGiven(rec.arg, env, () => summaryOf(rec, params, env)));
  const devSummary = devRec === null ? null : onGiven(devRec.arg, env, () => summaryOf(devRec, params, env));
  const lostPacks: LostPack[] = lost.map((r) => ({
    pack: r.pack as 'B' | 'C',
    id: r.id,
    folder: path.basename(r.dir),
    cause: r.lost?.cause ?? 'technical',
    objectionsBegun: r.lost?.objectionsBegun ?? true,
    reasons: r.voidReasons,
  }));
  if (notRecorded !== null) {
    const tried = notRecorded.attempts;
    lostPacks.push({
      pack: notRecorded.pack,
      id: null,
      folder: null,
      cause: 'not recorded',
      objectionsBegun: false,
      reasons: tried.length === 0 ? [] : [`${tried.length === 1 ? 'the recording' : 'the recordings'} ${tried.join(', ')} failed for a technical reason before 4:15, so section 11 records the pack again`],
    });
  }

  const report = confirmReport({
    generatedUtc: utcSeconds(deps.now()),
    commit: deps.commit(),
    params: { sha256: params.sha256, variant: params.variant, k: params.k, L: params.L, M: params.M, thetaG: params.thetaG, criterionMet: params.criterionMet },
    tag,
    packs: summaries,
    lost: lostPacks,
    later,
    notCounted,
    heardBefore,
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
