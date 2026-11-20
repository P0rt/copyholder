// results/confirm.json and results/confirm.md (PREREG.md section 11): the pooled confirmatory
// numbers of packs B and C, each pack's five rows and verdict (as stage B wrote them, or as
// confirm scored a pack stage B does not score), a lost pack with its reason (or pack C without a
// recording, when pack B is given alone), each later recording of a pack, which is not in the
// numbers, each folder of pack B or C that no SDK measured, which is not counted, and, with --dev,
// pack A's numbers printed apart as development data. Plain English, every number whether
// convenient or not, each with its n and the setup line. Pure: no I/O.

import type { Verdict } from '../../core/schemas/index.ts';
import { AFTER_MS, W_MS, round1, round1OrNull } from '../gate/common.ts';
import { RETUNE_TAG } from '../gate/frozen.ts';
import { ALPHA, CONFIDENCE, EARLIER_MS, UNDER_MS, WIN_MARGIN_MS, givenName, namedIn, roundOrNull, roundTo } from './common.ts';
import type { PackFacts } from './facts.ts';
import type { LostCause, PackStanding } from './load.ts';
import { shareLine, type ConfirmNumbers, type CountRate, type EqualRateLine, type MedianLine, type ShareLine, type SignLine } from './numbers.ts';
import { poissonRateInterval } from './stats.ts';
import type { RetuneTagFacts } from './tag.ts';

export const CONFIRM_SCHEMA = 'confirm/1';

/** Why estimate 3 of section 9.2 is missing, in every output (section 11). */
export const SENTENCE_ENDS_NOTE = 'not computed: estimate 3 needs the sentence ends of a sealed plan, and the gate packs have none (PREREG.md section 11)';

/** The quickcheck condition whose failure alone is not technical (PREREG.md section 7.4, analysis/lib/conditions.ts). */
const CONDITION_6 = 'voice_after_cues';

/** One recording in the numbers, as the report shows it. */
export interface PackSummary {
  id: string;
  /** The name of its folder, which differs from the id when an operator renamed the folder. */
  folder: string;
  pack: 'A' | 'B' | 'C';
  sdkVersion: string | null;
  standing: Exclude<PackStanding, 'lost'>;
  /** Who wrote the verdict below: stage B, or confirm for a recording stage B does not score. */
  source: 'stage B' | 'confirm';
  /** verdict.json and verdict.md as stage B wrote them, or scoreGate's verdict and its rows text. */
  verdict: Verdict;
  verdictMd: string;
  /** quickcheck.json and the clock check: why the recording does not count; empty when it counts. */
  voidReasons: string[];
  /** The quickcheck condition 6 check (replies after cues), as quickcheck.json holds it; null without one. */
  replies: { value: unknown; limit: unknown } | null;
  facts: PackFacts;
}

/**
 * A pack not in the numbers (section 11): its recording is lost (a technical failure after 4:15, or
 * the SDK credits ran out), or pack C has no recording because pack B was given alone.
 */
export interface LostPack {
  pack: 'B' | 'C';
  /** The recording's id; null when the pack has no recording. */
  id: string | null;
  /** The name of the recording's folder, which differs from the id when an operator renamed the folder; null without a recording. */
  folder: string | null;
  cause: LostCause | 'not recorded';
  /** Whether the lost recording had reached its objection block (4:15); false without a recording. */
  objectionsBegun: boolean;
  /** Why the recording does not count; for a pack without a recording, the attempts that failed before 4:15. */
  reasons: string[];
}

/**
 * A recording of pack B or C made after the one given for that pack, and not an attempt that
 * failed for a technical reason before 4:15 (section 11): not in the numbers, since section 11
 * records a pack again only after such a failure and does not replace a lost recording.
 */
export interface LaterRecording {
  pack: 'B' | 'C';
  id: string;
  /** The name of its folder, which differs from the id when an operator renamed the folder. */
  folder: string;
  /** The recording given for that pack. */
  after: string;
  /** The name of the folder of the recording given. */
  afterFolder: string;
  /** Whether the recording given is lost. */
  afterLost: boolean;
}

/**
 * A folder of pack B or C in the sessions folder that no SDK measured (manifest.json dry, a tap
 * other than the real one, or sdk null; analysis/pack/rules.ts whyNotMeasured): no recording of the
 * pack, so it is not counted, and the report lists it (spec 6.5, section 11).
 */
export interface NotCountedFolder {
  pack: 'B' | 'C';
  /** manifest.json id, or the folder name when the manifest has none. */
  id: string;
  folder: string;
  /** What its manifest.json says, as whyNotMeasured gives it. */
  why: string;
}

export interface ParamsSummary {
  sha256: string;
  variant: 'D1' | 'D3';
  k: number;
  L: number;
  M: number;
  thetaG: number;
  criterionMet: boolean;
}

export interface ReportInput {
  generatedUtc: string;
  commit: string | null;
  params: ParamsSummary;
  /** The tag gate-retune: the pooled code under it and its time against the recordings. */
  tag: RetuneTagFacts;
  /** The recordings in the numbers, pack B before pack C. */
  packs: readonly PackSummary[];
  lost: readonly LostPack[];
  /** Recordings made after the one given for their pack, which are not in the numbers. */
  later: readonly LaterRecording[];
  /** Folders of packs B and C that no SDK measured, which are not counted. */
  notCounted: readonly NotCountedFolder[];
  /**
   * Why the numbers are not confirmatory beyond the tag: a run no SDK measured reached the objection
   * block of a pack before the recording of that pack in the numbers (sections 7.1, 11).
   */
  heardBefore: readonly string[];
  pooled: ConfirmNumbers;
  dev: { pack: PackSummary; numbers: ConfirmNumbers } | null;
}

export interface Report {
  json: Record<string, unknown>;
  markdown: string;
  summary: string[];
}

// ---- the setup line (section 9.1, 11) -------------------------------------------------------

/** "one person, one setup, the SDK version, the number of events" (section 9.1). */
export function setupLine(packs: readonly Pick<PackSummary, 'pack' | 'sdkVersion'>[], cued: number, valid: number): string {
  const versions = [...new Set(packs.map((p) => p.sdkVersion))];
  const sdk =
    versions.length === 1
      ? versions[0] === null || versions[0] === undefined
        ? 'SmartSpectra SDK version not recorded in manifest.json'
        : `SmartSpectra SDK ${versions[0]}`
      : `SmartSpectra SDK ${packs.map((p) => `${p.sdkVersion ?? 'not recorded'} (pack ${p.pack})`).join(', ')}`;
  return `one person, one setup, ${sdk}, ${cued} cued events, ${valid} valid objections`;
}

/** "voice after only 11 of 14 cues": quickcheck condition 6 in words; null without the check. */
function repliesText(p: Pick<PackSummary, 'replies'>): string | null {
  if (p.replies === null) return null;
  return `voice after ${String(p.replies.value)} cues where quickcheck needs ${String(p.replies.limit)}`;
}

/**
 * Flags of a pack (section 11): a pack with fewer than 12 valid objections stays in the pooled
 * numbers, flagged, and so does one that failed quickcheck on condition 6 alone, which stage B
 * does not score.
 */
export function packFlags(p: Pick<PackSummary, 'pack' | 'verdict' | 'standing' | 'replies'>): string[] {
  const out: string[] = [];
  if (p.standing === 'content') {
    const replies = repliesText(p);
    out.push(
      `pack ${p.pack} failed quickcheck on condition 6 alone (${replies ?? 'too few replies after the cues'}), which is not technical: stage A and stage B do not score such a recording, so npm run confirm scored it with stage B's function and the frozen parameters, and it stays in the pooled numbers, flagged (PREREG.md sections 7.4, 11)`,
    );
  }
  if (p.verdict.events.valid < 12) {
    out.push(`pack ${p.pack} has ${p.verdict.events.valid} valid objections, fewer than 12: its gate verdict is NOT EVALUABLE, and it stays in the pooled numbers, flagged (PREREG.md section 11)`);
  }
  return out;
}

/** How a recording was lost, in words: "it failed for a technical reason after ... (4:15)". */
export function lostPhrase(l: { cause: LostCause; objectionsBegun: boolean }): string {
  if (l.cause === 'credits') {
    return `the SDK ended it with kCreditExhausted (the SDK credits were used up) ${l.objectionsBegun ? 'after' : 'before'} its objection block began (4:15)`;
  }
  return 'it failed for a technical reason after its objection block began (4:15)';
}

function lostText(l: LostPack): string {
  if (l.cause === 'not recorded') {
    const held = l.reasons.length === 0 ? `no recording of pack ${l.pack}` : `no recording of pack ${l.pack} that reached its objection block (4:15): ${l.reasons.join('; ')}`;
    return `pack ${l.pack} has no recording: npm run confirm was given pack B alone, and the sessions folder holds ${held}. PREREG.md section 11 allows this when pack C cannot be started for lack of SDK credits`;
  }
  // A recording whose folder an operator renamed is named with its folder: host may have given its id to a later one.
  const self = l.id === null || l.folder === null ? String(l.id) : namedIn(l.id, l.folder);
  return `pack ${l.pack} (${self}) is lost: ${lostPhrase({ cause: l.cause, objectionsBegun: l.objectionsBegun })}, so it is not in the numbers and not replaced (PREREG.md section 11). Reason: ${l.reasons.join('; ')}`;
}

/**
 * "pack C (gate-c-2) was recorded after gate-c and is not in the numbers: ...". A folder whose name
 * is not the id is named too, and the recording given by the name to give it under (common.ts
 * givenName): "after gate-c-failed (the folder of gate-c)".
 */
export function laterText(l: LaterRecording): string {
  const after = givenName(l.after, l.afterFolder);
  const self = namedIn(l.id, l.folder);
  const why = l.afterLost ? `${after} is lost, and PREREG.md section 11 does not replace a lost recording` : `${after} is the recording of pack ${l.pack} in the numbers (PREREG.md section 11)`;
  return `pack ${l.pack} (${self}) was recorded after ${after} and is not in the numbers: ${why}`;
}

/** "the folder gate-c-mock (pack C, id gate-c) holds no recording the SDK measured: ...". */
export function notCountedText(f: NotCountedFolder): string {
  const which = f.folder === f.id ? `pack ${f.pack}` : `pack ${f.pack}, id ${f.id}`;
  return `the folder ${f.folder} (${which}) holds no recording the SDK measured: its manifest.json says ${f.why}, so it is not a recording of pack ${f.pack} and is not counted (spec 6.5, PREREG.md section 11)`;
}

/** "pack C lost", "pack C not recorded". */
function lostWord(l: Pick<LostPack, 'pack' | 'cause'>): string {
  return `pack ${l.pack} ${l.cause === 'not recorded' ? 'not recorded' : 'lost'}`;
}

/**
 * The flag of numbers from one pack (section 11): with pack C lost or without a recording, the
 * confirmatory numbers are those of pack B alone (at most 14 valid objections), flagged, with the
 * same tests; the same holds the other way round.
 */
export function aloneFlags(r: Pick<ReportInput, 'packs' | 'lost'>): string[] {
  if (r.packs.length !== 1 || r.lost.length === 0) return [];
  const p = r.packs[0]!;
  const why = r.lost.map((l) => `pack ${l.pack} ${l.cause === 'not recorded' ? 'has no recording' : 'is lost'}`).join(' and ');
  return [
    `the confirmatory numbers are those of pack ${p.pack} alone, ${p.verdict.events.valid} valid objections (at most 14), with the same tests, because ${why} (PREREG.md section 11)`,
  ];
}

// ---- formatting ---------------------------------------------------------------------------

function pct(x: number | null, digits = 1): string {
  return x === null ? 'n/a' : `${(x * 100).toFixed(digits)}%`;
}

/** "1 false hold", "2 false holds". */
export function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** A p-value: four decimals, or two significant digits in exponent form below 0.0001. */
export function pText(p: number): string {
  return p < 1e-4 ? p.toExponential(2) : p.toFixed(4);
}

function msText(x: number | null): string {
  return x === null ? 'n/a' : `${round1(x).toFixed(1)} ms`;
}

function minText(x: number): string {
  return x.toFixed(2);
}

function rateText(x: number | null): string {
  return x === null ? 'n/a' : x.toFixed(2);
}

function rate1(x: number | null): string {
  return x === null ? 'n/a' : round1(x).toFixed(1);
}

function shareText(s: ShareLine, what: string): string {
  return `${s.k} of ${s.n} ${what}, ${pct(s.share)} (95% Wilson interval ${pct(s.low)} to ${pct(s.high)}), n = ${s.n}`;
}

function medianText(m: MedianLine, what: string): string {
  if (m.n === 0 || m.median === null) return `no ${what}: no median, n = 0`;
  const interval =
    m.kind === 'range'
      ? `range ${msText(m.low)} to ${msText(m.high)} (with 5 values or fewer no 95% order-statistic interval exists)`
      : `95% interval ${msText(m.low)} to ${msText(m.high)} (order statistics ${m.lowerRank} and ${m.upperRank} of ${m.n}, exact coverage ${pct(m.coverage)})`;
  return `${msText(m.median)}, ${interval}, n = ${m.n} ${what}`;
}

function rateLine(c: CountRate, one: string, many: string): string {
  return `${plural(c.count, one, many)} in ${minText(c.activeMinutes)} active minutes: ${rateText(c.rate.perMin)} per minute (two-sided 95% Poisson interval ${rateText(c.rate.low)} to ${rateText(c.rate.high)}), n = ${c.count}`;
}

function signText(s: SignLine, first: string, second: string): string {
  return `${first} wins ${s.wins}, ${second} wins ${s.losses}, ties ${s.ties}; n = ${s.nPairs} pairs, ${s.nUntied} untied. One-sided sign test p = ${pText(s.pValue)}; Holm-adjusted p = ${pText(s.pHolm)}`;
}

/** The reading of a Holm-adjusted sign test; `rival` names the second detector ("the lips"). */
function holmVerdict(s: SignLine, rival: string): string {
  return s.belowAlpha
    ? `at or below alpha ${ALPHA}: the chest stopped the narrator earlier than ${rival} on more paired objections than chance gives`
    : `above alpha ${ALPHA}: the test does not show the chest earlier than ${rival}`;
}

/** The exploratory line beside H3 (section 6.5), in words. */
export function equalRateText(e: EqualRateLine | null): string {
  if (e === null) return 'Exploratory, lips at the chest rate (section 6.5): no line, the trace detector had no active time in the objection blocks.';
  if (e.thetaG === null || e.pairs === null) {
    return `Exploratory, lips at the chest rate (section 6.5): no theta_G of the grid brings the lips down to the chest's ${rate1(e.chestPerMin)} false stops per active minute (${rate1(e.lipsPerMin)} at theta_G ${e.lastThetaG.toFixed(4)}): wins n/a. Not a test.`;
  }
  return `Exploratory, lips at the chest rate (section 6.5): at theta_G ${e.thetaG.toFixed(4)}, the smallest of the grid that does it, the lips make ${rate1(e.lipsPerMin)} false fires per active minute in the objection blocks against the chest's ${rate1(e.chestPerMin)} (rounded to 0.1 as printed); chest wins ${e.pairs.wins}, lips wins ${e.pairs.losses}, ties ${e.pairs.ties}, n = ${e.pairs.nPairs} pairs. Not a test.`;
}

// ---- confirm.json ---------------------------------------------------------------------------

function shareJson(s: ShareLine): Record<string, unknown> {
  return { k: s.k, n: s.n, share: roundOrNull(s.share, 6), wilson95: [roundTo(s.low, 6), roundTo(s.high, 6)] };
}

function medianJson(m: MedianLine): Record<string, unknown> {
  return {
    n: m.n,
    median_ms: round1OrNull(m.median),
    low_ms: round1OrNull(m.low),
    high_ms: round1OrNull(m.high),
    interval: m.kind,
    lower_rank: m.lowerRank,
    upper_rank: m.upperRank,
    coverage: roundOrNull(m.coverage, 6),
  };
}

function countRateJson(c: CountRate): Record<string, unknown> {
  return {
    false_stops: c.count,
    stops: c.stops,
    active_min: roundTo(c.activeMinutes, 4),
    per_min: roundOrNull(c.rate.perMin, 4),
    ci95_per_min: c.rate.low === null || c.rate.high === null ? null : [roundTo(c.rate.low, 4), roundTo(c.rate.high, 4)],
  };
}

function signJson(s: SignLine): Record<string, unknown> {
  return {
    wins: s.wins,
    losses: s.losses,
    ties: s.ties,
    n_pairs: s.nPairs,
    n_untied: s.nUntied,
    p_value: Number(s.pValue.toPrecision(6)),
    p_holm: Number(s.pHolm.toPrecision(6)),
    below_alpha: s.belowAlpha,
  };
}

function equalRateJson(e: EqualRateLine | null): Record<string, unknown> | null {
  if (e === null) return null;
  return {
    exploratory: true,
    theta_G: e.thetaG,
    lips_false_per_min: roundOrNull(e.lipsPerMin, 4),
    chest_false_per_min: roundTo(e.chestPerMin, 4),
    last_theta_G: e.lastThetaG,
    wins: e.pairs?.wins ?? null,
    losses: e.pairs?.losses ?? null,
    ties: e.pairs?.ties ?? null,
    n_pairs: e.pairs?.nPairs ?? null,
  };
}

/** The numbers of section 11 as confirm.json holds them. */
export function numbersJson(n: ConfirmNumbers): Record<string, unknown> {
  const c = n.h1.chance;
  return {
    packs: n.packs,
    events: { cued: n.cued, valid: n.valid, armed: n.armed, audible_inbreath: n.audibleInbreath },
    h1: {
      stops_before_voice: shareJson(n.h1.share),
      armed_hits: n.h1.armedHits,
      leads_0_50: n.h1.leads0to50,
      leads_under_300: shareJson(n.h1.under300),
      misses: { no_inbreath: n.h1.misses.noInbreath, inbreath_audible: n.h1.misses.inbreathAudible },
      chance: {
        poisson:
          c.poisson === null
            ? null
            : {
                false_holds: c.poisson.falseStops,
                active_min: roundTo(c.poisson.activeMin, 4),
                rate_per_min: roundTo(c.poisson.ratePerMin, 4),
                rate_upper_per_min: roundTo(c.poisson.rateUpperPerMin, 4),
                confidence: c.poisson.confidence,
                window_ms: c.poisson.windowMs,
                p0: roundTo(c.poisson.p0, 6),
              },
        circular_shift:
          c.shift === null
            ? null
            : {
                share: roundOrNull(c.shift.share, 6),
                standard_error: roundOrNull(c.shift.standardError, 6),
                shifts: c.shift.shifts,
                seed: c.shift.seed,
                objections: c.shift.onsets,
                hits: c.shift.hits,
                circle_min: roundTo(c.shift.circleMinutes, 4),
                window_ms: c.shift.windowMs,
                left_out: c.shift.leftOut,
              },
        sentence_ends: null,
        sentence_ends_note: SENTENCE_ENDS_NOTE,
        p0: c.choice === null ? null : roundTo(c.choice.p0, 6),
        source: c.choice?.source ?? null,
      },
      test:
        n.h1.test === null
          ? null
          : {
              method: 'exact one-sided binomial test',
              k: n.h1.test.k,
              n: n.h1.test.n,
              p0: roundTo(n.h1.test.p0, 6),
              p_value: Number(n.h1.test.pValue.toPrecision(6)),
              alpha: n.h1.test.alpha,
              below_alpha: n.h1.test.belowAlpha,
            },
      no_test: n.h1.noTest,
    },
    lead: { stops_before_voice: medianJson(n.lead.hits), all_stops_in_window: { ...medianJson(n.lead.allStops), window_ms: [-W_MS, AFTER_MS] } },
    h3: {
      rival: 'G (lips)',
      theta_G: Object.fromEntries(n.h3.thetaG.map((t) => [t.pack, t.thetaG])),
      ...signJson(n.h3),
      chest_false: countRateJson(n.h3.chest),
      lips_false: countRateJson(n.h3.lips),
      exploratory_equal_rate: equalRateJson(n.h3.equalRate),
    },
    h4: { rival: 'A250', ...signJson(n.h4), chest_false: countRateJson(n.h4.chest), a250_false_per_min: 0, a250_stops: n.h4.a250Stops },
    holm: { family: ['h3', 'h4'], alpha: ALPHA },
    false_holds: { ...countRateJson(n.falseHolds), per_pack: n.falseHolds.perPack.map((p) => ({ pack: p.pack, id: p.id, ...countRateJson(p) })) },
    sensitivity: n.sensitivity.map((s) => ({ key: s.key, label: s.label, ...shareJson(s.share), median_lead_ms: round1OrNull(s.lead.median), lead_n: s.lead.n })),
  };
}

/** The counts of one pack, from its facts (the same as its verdict, checked before). */
function packCountsJson(f: PackFacts): Record<string, unknown> {
  const rate = poissonRateInterval(f.chestFalse.falseStops, f.chestFalse.activeMinutes);
  return {
    cued: f.cued,
    valid: f.hits.valid,
    stops_before_voice: f.hits.hits,
    false_holds: f.chestFalse.falseStops,
    active_min: roundTo(f.chestFalse.activeMinutes, 4),
    false_holds_per_min: roundOrNull(rate.perMin, 4),
    vs_lips: { wins: f.vsLips.wins, losses: f.vsLips.losses, ties: f.vsLips.ties },
    vs_a250: { wins: f.vsA250.wins, losses: f.vsA250.losses, ties: f.vsA250.ties },
    theta_G: f.thetaG,
  };
}

function packJson(p: PackSummary): Record<string, unknown> {
  return {
    pack: p.pack,
    id: p.id,
    folder: p.folder,
    sdk_version: p.sdkVersion,
    standing: p.standing,
    verdict_by: p.source,
    verdict: p.verdict.verdict,
    does_not_count_because: p.voidReasons,
    flags: packFlags(p),
    counts: packCountsJson(p.facts),
    verdict_json: p.verdict,
    verdict_md: p.verdictMd,
  };
}

// ---- confirm.md -------------------------------------------------------------------------------

/** The numbers of section 11 in plain words; `h` is the heading prefix of the sub-sections. */
export function numbersMarkdown(n: ConfirmNumbers, h: string): string[] {
  const c = n.h1.chance;
  const lines: string[] = [];
  lines.push(`${h} H1: stops before the voice (main)`, '');
  lines.push(`- Valid objections with a trace-detector stop before the voice: ${shareText(n.h1.share, 'valid objections')}.`);
  lines.push(`- Armed (section 3.2): ${n.armed} of the ${plural(n.valid, 'valid objection', 'valid objections')}; ${n.h1.armedHits} of the ${plural(n.h1.share.k, 'stop', 'stops')} before the voice came on armed objections, n = ${n.armed}.`);
  lines.push('- Chance level, the larger of two estimates (PREREG.md sections 9.2 and 11):');
  if (c.poisson === null) lines.push('  - Estimate 1, Poisson: not computed, the trace detector had no active time in the objection blocks.');
  else {
    lines.push(
      `  - Estimate 1, Poisson: ${plural(c.poisson.falseStops, 'false hold', 'false holds')} in ${minText(c.poisson.activeMin)} active minutes of the objection blocks, ${rateText(c.poisson.ratePerMin)} per minute; one-sided 95% exact upper bound ${rateText(c.poisson.rateUpperPerMin)} per minute; p0 = 1 - exp(-${rateText(c.poisson.rateUpperPerMin)} * ${W_MS / 1000} / 60) = ${pct(c.poisson.p0, 2)}, n = ${plural(c.poisson.falseStops, 'false hold', 'false holds')}.`,
    );
  }
  if (c.shift === null) lines.push('  - Estimate 2, circular shifts: not computed, no valid objection could be shifted along active time.');
  else {
    const left = c.shift.leftOut.length > 0 ? ` Left out, with no active time to shift along: ${c.shift.leftOut.join(', ')}.` : '';
    lines.push(
      `  - Estimate 2, circular shifts: ${c.shift.shifts} rounds (seed ${c.shift.seed}). In each round the valid objections of a pack move by one random shift round the circle of that pack's objection block: its active time, with every objection cut out from 3 s before its voice onset to the end of its post-voice period (${minText(c.shift.circleMinutes)} active minutes in all). Mean share of shifted objections with a stop in the ${W_MS / 1000} s before: ${pct(c.shift.share, 2)} (Monte Carlo standard error ${pct(c.shift.standardError, 2)}), n = ${plural(c.shift.onsets, 'objection', 'objections')}.${left}`,
    );
  }
  lines.push(`  - Estimate 3, sentence ends: ${SENTENCE_ENDS_NOTE}.`);
  if (c.choice !== null) lines.push(`  - p0 = ${pct(c.choice.p0, 2)}, the larger, from the ${c.choice.source === 'poisson' ? 'Poisson estimate' : 'circular shifts'}.`);
  if (n.h1.test !== null) {
    const t = n.h1.test;
    const word = t.belowAlpha
      ? `at or below alpha ${t.alpha}: the share of stops before the voice is above the chance level`
      : `above alpha ${t.alpha}: the test does not show the share above the chance level`;
    lines.push(`- Exact one-sided binomial test of ${t.k} of ${t.n} against p0 = ${pct(t.p0, 2)}: p = ${pText(t.pValue)}, n = ${t.n}; ${word}.`);
  } else lines.push(`- No test: ${n.h1.noTest ?? 'no chance level'}.`);
  lines.push(`- Leads of 0-50 ms among the stops before the voice: ${n.h1.leads0to50} of ${n.h1.share.k}, n = ${n.h1.share.k}.`);
  lines.push(`- Counting only leads under ${UNDER_MS} ms (section 3.2): ${shareText(n.h1.under300, 'valid objections')}.`);
  lines.push(`- Misses, valid objections without a stop before the voice: ${n.h1.misses.noInbreath} without an audible in-breath, ${n.h1.misses.inbreathAudible} with one; n = ${n.h1.misses.noInbreath + n.h1.misses.inbreathAudible}.`);
  lines.push('- Lines (2) and (3) of section 9.1 do not apply to gate packs: every valid objection answers a cue, and an objection with no signal is not valid (section 7.5).');
  lines.push('');

  lines.push(`${h} Lead`, '');
  lines.push(`- Median lead over the stops before the voice: ${medianText(n.lead.hits, 'stops before the voice')}.`);
  lines.push(`- Beside it, the median over all stops from t_v - 1.5 s to t_v + 0.5 s: ${n.lead.allStops.median === null ? 'n/a' : msText(n.lead.allStops.median)}, n = ${plural(n.lead.allStops.n, 'stop', 'stops')}.`);
  lines.push('');

  lines.push(`${h} H3 and H4: paired comparisons`, '');
  lines.push(
    `Paired objections of section 6.5: each detector's first stop from t_v - 1.5 s to t_v + 0.5 s; a stop at least ${WIN_MARGIN_MS} ms earlier wins, a detector without a stop loses to one with a stop, the rest are ties, left out of the tests and counted. Holm's correction covers the two tests.`,
    '',
  );
  const thetas = n.h3.thetaG.map((t) => `${t.thetaG.toFixed(4)} in pack ${t.pack}`).join(', ');
  lines.push(`- H3, chest against lips (G at theta_G ${thetas}): ${signText(n.h3, 'chest', 'lips')}; ${holmVerdict(n.h3, 'the lips')}.`);
  lines.push(`  - False fires in the objection blocks, chest: ${rateLine(n.h3.chest, 'false hold', 'false holds')}.`);
  lines.push(`  - False fires in the objection blocks, lips: ${rateLine(n.h3.lips, 'false fire', 'false fires')}.`);
  lines.push(`  - ${equalRateText(n.h3.equalRate)}`);
  lines.push(`- H4, chest against the 250 ms rule (A250): ${signText(n.h4, 'chest', 'A250')}; ${holmVerdict(n.h4, 'the 250 ms rule')}.`);
  lines.push(`  - False holds per active minute: chest ${rateText(n.h4.chest.rate.perMin)} (n = ${n.h4.chest.count}), A250 0.00 by construction (${plural(n.h4.a250Stops, 'A250 stop', 'A250 stops')}, each after a voice onset).`);
  lines.push('- The gate narrator never stops (virtual stops), so no objection follows a live chest stop.');
  lines.push('');

  lines.push(`${h} False holds`, '');
  lines.push(`- Objection blocks together: ${rateLine(n.falseHolds, 'false hold', 'false holds')}; ${plural(n.falseHolds.stops, 'trace-detector stop', 'trace-detector stops')} in all.`);
  for (const p of n.falseHolds.perPack) lines.push(`- Pack ${p.pack} (${p.id}): ${rateLine(p, 'false hold', 'false holds')}; ${plural(p.stops, 'stop', 'stops')} in all.`);
  lines.push('');

  lines.push(`${h} Sensitivity lines (section 5)`, '');
  lines.push('| Line | Stops before the voice | Share | 95% Wilson interval | Median lead (n) |');
  lines.push('|---|---|---|---|---|');
  lines.push(`| Main: automatic onsets | ${n.h1.share.k} of ${n.h1.share.n} | ${pct(n.h1.share.share)} | ${pct(n.h1.share.low)} to ${pct(n.h1.share.high)} | ${msText(n.lead.hits.median)} (${n.lead.hits.n}) |`);
  for (const s of n.sensitivity) {
    lines.push(`| ${s.label} | ${s.share.k} of ${s.share.n} | ${pct(s.share.share)} | ${pct(s.share.low)} to ${pct(s.share.high)} | ${msText(s.lead.median)} (${s.lead.n}) |`);
  }
  lines.push('');
  lines.push(
    `The blind manual onsets are the participant's hand marks (an event marked without a first sound keeps its automatic onset, as stage B reads it); the ${EARLIER_MS} ms line moves every onset earlier; the t_a line uses the anchor of the onset reference; the 400 ms and non-speech lines change which replies are valid objections. The stops are the same in every line.`,
  );
  lines.push('');
  return lines;
}

function packTable(packs: readonly PackSummary[]): string[] {
  const lines = [
    '| Pack | Recording | Cued | Valid | Stops before the voice | 95% Wilson interval | False holds / active min | Chest v lips W:L:T | Chest v A250 W:L:T | Median lead | Verdict |',
    '|---|---|---|---|---|---|---|---|---|---|---|',
  ];
  for (const p of packs) {
    const f = p.facts;
    const v = p.verdict;
    const s = shareLine(f.hits.hits, f.hits.valid);
    const by = p.source === 'confirm' ? ' (scored by npm run confirm)' : '';
    lines.push(
      `| ${p.pack} | ${p.id} | ${f.cued} | ${f.hits.valid} | ${f.hits.hits} (${pct(s.share)}) | ${pct(s.low)} to ${pct(s.high)} | ${f.chestFalse.falseStops} / ${minText(f.chestFalse.activeMinutes)} | ${f.vsLips.wins}:${f.vsLips.losses}:${f.vsLips.ties} | ${f.vsA250.wins}:${f.vsA250.losses}:${f.vsA250.ties} | ${msText(v.rows.lead.median_hits_ms)} | ${v.verdict}${by} |`,
    );
  }
  return lines;
}

function verdictBlock(p: PackSummary, h: string): string[] {
  const how =
    p.source === 'stage B'
      ? 'five rows and verdict as stage B wrote them'
      : "five rows and verdict by stage B's function, scored by npm run confirm: stage B does not score a recording that failed quickcheck";
  const lines = [`${h} Pack ${p.pack} (${p.id}): ${how}`, ''];
  for (const f of packFlags(p)) lines.push(`Flag: ${f}.`, '');
  lines.push('```text', ...p.verdictMd.trimEnd().split('\n'), '```', '');
  return lines;
}

function paramsLine(p: ParamsSummary): string {
  return `${p.variant}, k ${p.k.toFixed(1)} (criterion ${p.criterionMet ? 'met' : 'not met'}), L ${p.L}, M ${p.M}; lips rival G at theta_G ${p.thetaG.toFixed(4)}`;
}

/** What was checked of the parameters and the tag gate-retune, in plain words (section 11). */
function frozenLines(r: ReportInput): string[] {
  const p = r.params;
  const t = r.tag;
  const lines = [`- Detector: ${paramsLine(p)}. params/frozen.json ${p.sha256.slice(0, 8)}, equal to params/retune.json and to its copy under the tag ${RETUNE_TAG}.`];
  const staged = r.packs.filter((x) => x.source === 'stage B').map((x) => `pack ${x.pack}`);
  const own = r.packs.filter((x) => x.source === 'confirm').map((x) => `pack ${x.pack}`);
  /** The words for one pack or for two. */
  const forCount = (xs: readonly string[], one: string, many: string): string => (xs.length === 1 ? one : many);
  const stageA = [
    staged.length > 0
      ? `${forCount(staged, 'the ledger of', 'the ledgers of')} ${staged.join(' and ')} ${forCount(staged, 'holds this hash in its stage A line', 'hold this hash in their stage A lines')}, and stage B scored with it`
      : null,
    own.length > 0
      ? `${own.join(' and ')} ${forCount(own, 'has', 'have')} no stage A or stage B, which do not run on a recording that failed quickcheck, and ${forCount(own, 'was', 'were')} scored here with this file`
      : null,
  ].filter((x) => x !== null);
  lines.push(`- Stage A and stage B: ${stageA.join('; ')}.`);
  const starts = t.recordings.map((s) => `pack ${s.pack} started ${s.startedUtc}`).join(', ');
  lines.push(`- The tag ${RETUNE_TAG}: ${t.tagTime === null ? 'git gives no time for it' : `made ${t.tagTime} (the time git gives the tag)`}; ${starts}.`);
  const code = `- The pooled analysis code, every module npm run confirm loads (${plural(t.codeFiles.length, 'file', 'files')}, listed in confirm.json under retune_tag.code_files),`;
  lines.push(
    t.codeDifferences.length === 0
      ? `${code} equals its copy under the tag ${RETUNE_TAG}.`
      : `${code} differs from its copy under the tag ${RETUNE_TAG}: ${t.codeDifferences.join('; ')}.`,
  );
  return lines;
}

/** confirm.json, confirm.md and the console summary. */
export function confirmReport(r: ReportInput): Report {
  const n = r.pooled;
  const setup = setupLine(r.packs, n.cued, n.valid);
  // Section 11 conditions the numbers do not meet: the tag, then a pack heard before its recording.
  const problems = [...r.tag.problems, ...r.heardBefore];
  const confirmatory = problems.length === 0;
  const inNumbers = r.packs.map((p) => `pack ${p.pack}`).join(' and ');
  const md: string[] = [];
  md.push(r.lost.length === 0 ? '# Pooled confirmation: packs B and C' : `# Confirmation: ${inNumbers}, ${r.lost.map(lostWord).join(' and ')}`, '');
  if (!confirmatory) {
    md.push(`**Not confirmatory.** These numbers are computed as PREREG.md section 11 says, but a condition of section 11 is not met: ${problems.join('; ')}.`, '');
  }
  md.push(
    `PREREG.md section 11. ${r.lost.length === 0 ? 'Confirmatory numbers, pooled over the valid objections of packs B and C' : `Confirmatory numbers over the valid objections of ${inNumbers}`}, with the frozen trace detector, automatic onsets and virtual stops (section 3.1). Every number carries its n.`,
    '',
  );
  md.push(`- Setup: ${setup}.`);
  md.push(...frozenLines(r));
  md.push(
    `- Recordings: ${r.packs.map((p) => `pack ${p.pack} ${namedIn(p.id, p.folder)} (verdict ${p.verdict.verdict}${p.source === 'confirm' ? ', scored by npm run confirm' : ''}, ${p.verdict.events.valid} valid objections of ${p.verdict.events.cued} cued)`).join('; ')}.`,
  );
  for (const l of r.lost) md.push(`- ${l.cause === 'not recorded' ? 'Not recorded' : 'Lost'}: ${lostText(l)}.`);
  for (const l of r.later) md.push(`- Recorded later: ${laterText(l)}.`);
  for (const f of r.notCounted) md.push(`- Not counted: ${notCountedText(f)}.`);
  for (const f of aloneFlags(r)) md.push(`- Flag: ${f}.`);
  for (const p of r.packs) for (const f of packFlags(p)) md.push(`- Flag: ${f}.`);
  md.push(`- Generated ${r.generatedUtc}${r.commit === null ? '' : ` at commit ${r.commit}`} by npm run confirm.`, '');
  md.push(...numbersMarkdown(n, '##'));
  md.push('## Per pack', '');
  md.push(...packTable(r.packs), '');
  for (const p of r.packs) md.push(...verdictBlock(p, '###'));

  let devJson: Record<string, unknown> | null = null;
  if (r.dev !== null) {
    const d = r.dev;
    const devSetup = setupLine([d.pack], d.numbers.cued, d.numbers.valid);
    const own = d.pack.verdict.params_sha256;
    const paramsNote =
      own === r.params.sha256
        ? `pack A's verdict was scored with these same parameters (${own.slice(0, 8)})`
        : `pack A's own verdict below was scored by stage B with its stage A parameters ${own.slice(0, 8)}; these numbers use the frozen parameters ${r.params.sha256.slice(0, 8)}, tuned on pack A`;
    md.push(`## Development data: pack A (${d.pack.id}), not pooled`, '');
    md.push(
      'Pack A tuned the frozen parameters (PREREG.md section 11), so its numbers are in-sample development data. They are printed apart and never pooled with packs B and C.',
      '',
    );
    md.push(`- Setup: ${devSetup}.`);
    md.push(`- Parameters: ${paramsNote}.`, '');
    md.push(...numbersMarkdown(d.numbers, '###'));
    md.push(...verdictBlock(d.pack, '###'));
    devJson = {
      development_data: true,
      pooled: false,
      note: 'pack A tuned the frozen parameters: in-sample numbers, printed apart and never pooled with packs B and C (PREREG.md section 11)',
      params_note: paramsNote,
      setup: { line: devSetup, people: 1, setups: 1, sdk_version: d.pack.sdkVersion, cued: d.numbers.cued, valid: d.numbers.valid },
      numbers: numbersJson(d.numbers),
      pack: packJson(d.pack),
    };
  }

  const json: Record<string, unknown> = {
    schema: CONFIRM_SCHEMA,
    prereg: 'PREREG.md section 11',
    confirmatory,
    not_confirmatory_because: problems,
    generated_utc: r.generatedUtc,
    commit: r.commit,
    params: {
      file: 'params/frozen.json',
      sha256: r.params.sha256,
      retune_tag: RETUNE_TAG,
      variant: r.params.variant,
      k: r.params.k,
      L: r.params.L,
      M: r.params.M,
      theta_G: r.params.thetaG,
      criterion_met: r.params.criterionMet,
    },
    retune_tag: {
      tag: r.tag.tag,
      time: r.tag.tagTime,
      recordings: r.tag.recordings.map((s) => ({ pack: s.pack, id: s.id, started_utc: s.startedUtc })),
      code_files: r.tag.codeFiles,
      code_differences: r.tag.codeDifferences,
    },
    setup: {
      line: setup,
      people: 1,
      setups: 1,
      sdk_versions: Object.fromEntries(r.packs.map((p) => [p.pack, p.sdkVersion])),
      cued: n.cued,
      valid: n.valid,
    },
    confidence: CONFIDENCE,
    alpha: ALPHA,
    pooled: numbersJson(n),
    packs: r.packs.map(packJson),
    lost: r.lost.map((l) => ({ pack: l.pack, id: l.id, folder: l.folder, cause: l.cause, objections_begun: l.objectionsBegun, reasons: l.reasons, note: lostText(l) })),
    recorded_later: r.later.map((l) => ({ pack: l.pack, id: l.id, folder: l.folder, after: l.after, after_folder: l.afterFolder, note: laterText(l) })),
    not_counted: r.notCounted.map((f) => ({ pack: f.pack, id: f.id, folder: f.folder, why: f.why, note: notCountedText(f) })),
    flags: aloneFlags(r),
    dev: devJson,
  };

  const t = n.h1.test;
  const summary = [
    `confirm: ${r.lost.length === 0 ? 'pooled' : 'numbers of'} ${r.packs.map((p) => `pack ${p.pack} (${p.id})`).join(' and ')}; params ${r.params.sha256.slice(0, 8)} (${r.params.variant}, k ${r.params.k.toFixed(1)}); ${setup}`,
  ];
  if (!confirmatory) summary.push(`NOT CONFIRMATORY: ${problems.join('; ')}`);
  for (const l of r.lost) summary.push(`${l.cause === 'not recorded' ? 'not recorded' : 'lost'}: ${lostText(l)}`);
  for (const l of r.later) summary.push(`recorded later: ${laterText(l)}`);
  for (const f of r.notCounted) summary.push(`not counted: ${notCountedText(f)}`);
  summary.push(
    `H1: ${n.h1.share.k} of ${n.h1.share.n} valid objections with a stop before the voice, ${pct(n.h1.share.share)} (95% Wilson ${pct(n.h1.share.low)} to ${pct(n.h1.share.high)}); ${
      t === null ? `no test: ${n.h1.noTest ?? 'no chance level'}` : `p0 ${pct(t.p0, 2)} (${n.h1.chance.choice?.source ?? 'n/a'}); exact binomial p ${pText(t.pValue)}, ${t.belowAlpha ? 'at or below' : 'above'} alpha ${t.alpha}`
    }`,
    `lead: median ${msText(n.lead.hits.median)} over ${n.lead.hits.n} stops before the voice (${n.lead.hits.kind === 'range' ? 'range' : '95% interval'} ${msText(n.lead.hits.low)} to ${msText(n.lead.hits.high)})`,
    `H3 chest v lips ${n.h3.wins}:${n.h3.losses}, ties ${n.h3.ties}, Holm p ${pText(n.h3.pHolm)}; H4 chest v A250 ${n.h4.wins}:${n.h4.losses}, ties ${n.h4.ties}, Holm p ${pText(n.h4.pHolm)}`,
    `false holds: ${n.falseHolds.count} in ${minText(n.falseHolds.activeMinutes)} active min, ${rateText(n.falseHolds.rate.perMin)}/min (95% ${rateText(n.falseHolds.rate.low)} to ${rateText(n.falseHolds.rate.high)})`,
    `estimate 3 of the chance level: ${SENTENCE_ENDS_NOTE}`,
  );
  for (const f of aloneFlags(r)) summary.push(`flag: ${f}`);
  for (const p of r.packs) for (const f of packFlags(p)) summary.push(`flag: ${f}`);
  if (r.dev !== null) {
    const d = r.dev.numbers;
    summary.push(`development data, pack A (${r.dev.pack.id}), not pooled: ${d.h1.share.k} of ${d.h1.share.n} valid objections with a stop before the voice, ${pct(d.h1.share.share)}`);
  }
  return { json, markdown: `${md.join('\n').trimEnd()}\n`, summary };
}

/** Condition 6 of quickcheck (replies after cues) as quickcheck.json holds it, for the flag; null without it. */
export function repliesCheck(checks: readonly { name: string; value?: unknown; limit?: unknown }[]): { value: unknown; limit: unknown } | null {
  const c = checks.find((x) => x.name === CONDITION_6);
  return c === undefined ? null : { value: c.value ?? null, limit: c.limit ?? null };
}
