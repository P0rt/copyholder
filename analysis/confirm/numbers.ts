// The confirmatory numbers of PREREG.md section 11, pooled over the valid objections of a set of
// packs: packs B and C for the confirmation, pack A alone for the development data printed
// apart. Counts are sums of the packs' counts; the statistics are those of section 9.1 and 9.2
// that section 11 takes: H1 with its Wilson interval and the exact binomial test against the
// larger of two chance estimates, the lead with its order-statistic interval, H3 and H4 as sign
// tests with Holm's correction and, beside H3, the exploratory line of section 6.5, the
// false-hold rate with its Poisson interval, and the sensitivity lines of section 5. Pure: no I/O.

import { holmAdjustedPValues, medianWithInterval, signTest, wilsonInterval, type PoissonChanceLevel } from '../../core/stats/index.ts';
import { round1 } from '../gate/common.ts';
import { ALPHA, CONFIDENCE, SHIFT_COUNT, SHIFT_SEED, UNDER_MS } from './common.ts';
import { SENSITIVITY_KEYS, SENSITIVITY_LABELS, equalRateOf, type PackFacts, type SensitivityKey } from './facts.ts';
import {
  h1Test,
  largerChanceLevel,
  poissonEstimate,
  poissonRateInterval,
  shiftEstimate,
  type BinomialTest,
  type ChanceChoice,
  type RateInterval,
  type ShiftEstimate,
} from './stats.ts';

const sum = (xs: readonly number[]): number => xs.reduce((a, b) => a + b, 0);

/** A share with its two-sided 95% Wilson interval (section 9.1). */
export interface ShareLine {
  k: number;
  n: number;
  /** k / n; null when n = 0. */
  share: number | null;
  low: number;
  high: number;
}

export function shareLine(k: number, n: number): ShareLine {
  const w = wilsonInterval(k, n, CONFIDENCE);
  return { k, n, share: w.estimate, low: w.low, high: w.high };
}

/** A median with its 95% order-statistic interval, or the range with 5 values or fewer (section 9.1). */
export interface MedianLine {
  n: number;
  median: number | null;
  low: number | null;
  high: number | null;
  kind: 'order-statistics' | 'range' | null;
  /** 1-based ranks of the bounds among the sorted values. */
  lowerRank: number | null;
  upperRank: number | null;
  /** Exact coverage of [low, high] for a continuous distribution. */
  coverage: number | null;
}

export function medianLine(values: readonly number[]): MedianLine {
  const m = medianWithInterval(values, CONFIDENCE);
  if (m === null) return { n: 0, median: null, low: null, high: null, kind: null, lowerRank: null, upperRank: null, coverage: null };
  return { n: m.n, median: m.median, low: m.low, high: m.high, kind: m.kind, lowerRank: m.lowerRank, upperRank: m.upperRank, coverage: m.coverage };
}

/** False stops over active minutes, with the rate and its two-sided 95% Poisson interval. */
export interface CountRate {
  count: number;
  /** Stops of the detector in the objection blocks, false or not. */
  stops: number;
  activeMinutes: number;
  rate: RateInterval;
}

function countRate(count: number, stops: number, activeMinutes: number): CountRate {
  return { count, stops, activeMinutes, rate: poissonRateInterval(count, activeMinutes) };
}

/** One paired comparison of section 6.5, pooled. */
export interface SignLine {
  wins: number;
  losses: number;
  ties: number;
  /** Pairs, ties included: one per valid objection. */
  nPairs: number;
  /** Pairs in the test: wins + losses. */
  nUntied: number;
  /** One-sided sign test P(W >= wins), W ~ Binomial(nUntied, 1/2); 1 without untied pairs. */
  pValue: number;
  /** Holm-adjusted over H3 and H4 (section 9.1). */
  pHolm: number;
  belowAlpha: boolean;
}

export interface SensitivityLine {
  key: SensitivityKey;
  label: string;
  share: ShareLine;
  lead: MedianLine;
}

/**
 * The exploratory line printed beside H3 (section 6.5): G's threshold set to give the chest's
 * rate, pooled. It is the smallest theta_G of the grid at which the lips' false fires over their
 * active minutes in the objection blocks, rounded to 0.1 per minute as stage B rounds its own line,
 * are at most the chest's pooled false holds per active minute; the pairs at it are pooled. Not a test.
 */
export interface EqualRateLine {
  /** Null when no theta_G of the grid qualifies. */
  thetaG: number | null;
  /** The lips' pooled rate at thetaG, or at the largest theta_G when none qualifies. */
  lipsPerMin: number | null;
  /** The largest theta_G tried. */
  lastThetaG: number;
  chestPerMin: number;
  /** Pooled pairs at thetaG (chest first); null without thetaG. */
  pairs: { wins: number; losses: number; ties: number; nPairs: number } | null;
}

/** The pooled exploratory line; null when the chest has no rate (no active time). */
export function equalRateLine(facts: readonly PackFacts[], chestPerMin: number | null): EqualRateLine | null {
  const grid = facts[0]?.lipsGrid.map((g) => g.thetaG) ?? [];
  for (const f of facts) {
    if (f.lipsGrid.length !== grid.length || f.lipsGrid.some((g, i) => g.thetaG !== grid[i])) throw new Error(`pack ${f.pack}: the lips grid differs from pack ${facts[0]!.pack}'s`);
  }
  const pooled = grid.map((thetaG, i) => {
    const minutes = sum(facts.map((f) => f.lipsGrid[i]!.lipsFalse.activeMinutes));
    return { thetaG, perMin: minutes > 0 ? sum(facts.map((f) => f.lipsGrid[i]!.lipsFalse.falseStops)) / minutes : null };
  });
  const e = equalRateOf(pooled, chestPerMin);
  if (e === null || chestPerMin === null) return null;
  const at = e.index;
  const pairs =
    at === null
      ? null
      : {
          wins: sum(facts.map((f) => f.lipsGrid[at]!.vsLips.wins)),
          losses: sum(facts.map((f) => f.lipsGrid[at]!.vsLips.losses)),
          ties: sum(facts.map((f) => f.lipsGrid[at]!.vsLips.ties)),
          nPairs: sum(facts.map((f) => f.lipsGrid[at]!.vsLips.wins + f.lipsGrid[at]!.vsLips.losses + f.lipsGrid[at]!.vsLips.ties)),
        };
  return { thetaG: e.thetaG, lipsPerMin: e.lipsPerMin, lastThetaG: e.lastThetaG, chestPerMin, pairs };
}

export interface PackRef {
  pack: 'A' | 'B' | 'C';
  id: string;
}

export interface ConfirmNumbers {
  packs: PackRef[];
  cued: number;
  valid: number;
  armed: number;
  audibleInbreath: number;
  h1: {
    share: ShareLine;
    armedHits: number;
    /** Stops before the voice with a lead of 0-50 ms: counted, and on their own line (section 3.2). */
    leads0to50: number;
    /** The separate count with only leads under 300 ms (section 3.2). */
    under300: ShareLine;
    misses: { noInbreath: number; inbreathAudible: number };
    chance: {
      poisson: PoissonChanceLevel | null;
      shift: ShiftEstimate | null;
      /** Estimate 3 of section 9.2 is not computed for gate packs (section 11). */
      sentenceEnds: null;
      choice: ChanceChoice | null;
    };
    test: BinomialTest | null;
    /** Why there is no test; null with a test. */
    noTest: string | null;
  };
  lead: { hits: MedianLine; allStops: MedianLine };
  h3: SignLine & { thetaG: { pack: string; thetaG: number }[]; chest: CountRate; lips: CountRate; equalRate: EqualRateLine | null };
  h4: SignLine & { chest: CountRate; a250Stops: number };
  falseHolds: CountRate & { perPack: (CountRate & PackRef)[] };
  sensitivity: SensitivityLine[];
}

/** Why H1 has no test: no objection, or no active time for either chance estimate. */
function noTestReason(n: number, poisson: PoissonChanceLevel | null, shift: ShiftEstimate | null): string | null {
  if (n === 0) return 'no valid objections';
  if (poisson === null) return 'the trace detector had no active time in the objection blocks, so neither chance estimate exists';
  if (shift === null) return 'no valid objection could be shifted, so the circular-shift estimate does not exist';
  return null;
}

/** The numbers of section 11 over the valid objections of `facts` (one pack or several, pooled). */
export function confirmNumbers(facts: readonly PackFacts[], o: { seed?: number; shifts?: number } = {}): ConfirmNumbers {
  const valid = sum(facts.map((f) => f.hits.valid));
  const hits = sum(facts.map((f) => f.hits.hits));
  const leads = facts.flatMap((f) => f.hits.leadsMs);

  // H1 and its chance level (sections 9.1, 9.2, 11).
  const falseHolds = sum(facts.map((f) => f.chestFalse.falseStops));
  const activeMinutes = sum(facts.map((f) => f.chestFalse.activeMinutes));
  const poisson = poissonEstimate(falseHolds, activeMinutes);
  const shift = shiftEstimate(
    facts.map((f) => ({ name: `pack ${f.pack}`, session: f.circle })),
    { seed: o.seed ?? SHIFT_SEED, shifts: o.shifts ?? SHIFT_COUNT },
  );
  const choice = largerChanceLevel(poisson?.p0 ?? null, shift?.share ?? null);
  const noTest = noTestReason(valid, poisson, shift);
  const test = noTest === null && choice !== null ? h1Test(hits, valid, choice.p0) : null;

  // H3 and H4: sign tests on the paired objections, Holm over the two (sections 6.5, 9.1).
  const tally = (pick: (f: PackFacts) => { wins: number; losses: number; ties: number }): ReturnType<typeof signTest> =>
    signTest(sum(facts.map((f) => pick(f).wins)), sum(facts.map((f) => pick(f).losses)), sum(facts.map((f) => pick(f).ties)));
  const h3 = tally((f) => f.vsLips);
  const h4 = tally((f) => f.vsA250);
  const [h3Holm, h4Holm] = holmAdjustedPValues([h3.pValue, h4.pValue]) as [number, number];
  const signLine = (t: ReturnType<typeof signTest>, pHolm: number): SignLine => ({
    wins: t.wins,
    losses: t.losses,
    ties: t.ties,
    nPairs: t.nPairs,
    nUntied: t.nUntied,
    pValue: t.pValue,
    pHolm,
    belowAlpha: pHolm <= ALPHA,
  });
  const chest = countRate(falseHolds, sum(facts.map((f) => f.chestFalse.stops)), activeMinutes);
  const lips = countRate(
    sum(facts.map((f) => f.lipsFalse.falseStops)),
    sum(facts.map((f) => f.lipsFalse.stops)),
    sum(facts.map((f) => f.lipsFalse.activeMinutes)),
  );

  const sensitivity: SensitivityLine[] = SENSITIVITY_KEYS.map((key) => ({
    key,
    label: SENSITIVITY_LABELS[key],
    share: shareLine(sum(facts.map((f) => f.sensitivity[key].hits.hits)), sum(facts.map((f) => f.sensitivity[key].valid))),
    lead: medianLine(facts.flatMap((f) => f.sensitivity[key].hits.leadsMs)),
  }));

  return {
    packs: facts.map((f) => ({ pack: f.pack, id: f.id })),
    cued: sum(facts.map((f) => f.cued)),
    valid,
    armed: sum(facts.map((f) => f.hits.armed)),
    audibleInbreath: sum(facts.map((f) => f.points.filter((p) => p.breath).length)),
    h1: {
      share: shareLine(hits, valid),
      armedHits: sum(facts.map((f) => f.hits.armedHits)),
      leads0to50: sum(facts.map((f) => f.hits.leads0to50)),
      under300: shareLine(leads.filter((l) => round1(l) < UNDER_MS).length, valid),
      misses: {
        noInbreath: sum(facts.map((f) => f.misses.noInbreath)),
        inbreathAudible: sum(facts.map((f) => f.misses.inbreathAudible)),
      },
      chance: { poisson, shift, sentenceEnds: null, choice },
      test,
      noTest,
    },
    lead: { hits: medianLine(leads), allStops: medianLine(facts.flatMap((f) => f.leadsAllMs)) },
    h3: {
      ...signLine(h3, h3Holm),
      thetaG: facts.map((f) => ({ pack: f.pack, thetaG: f.thetaG })),
      chest,
      lips,
      equalRate: equalRateLine(facts, chest.rate.perMin),
    },
    h4: { ...signLine(h4, h4Holm), chest, a250Stops: sum(facts.map((f) => f.a250Stops)) },
    falseHolds: {
      ...chest,
      perPack: facts.map((f) => ({ pack: f.pack, id: f.id, ...countRate(f.chestFalse.falseStops, f.chestFalse.stops, f.chestFalse.activeMinutes) })),
    },
    sensitivity,
  };
}
