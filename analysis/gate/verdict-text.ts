// verdict.md in the layout of spec 9.7, from the verdict.json object. Values in ms print with
// one decimal (the precision of the file, spec 8.1); a value that could not be measured prints n/a.

import type { Verdict, VerdictRow } from '../../core/schemas/index.ts';
import type { SniffRow } from './sniffs.ts';

const LABEL = 15;
const VALUE = 38;

/** Row labels of spec 9.7, by verdict.json row. */
export const ROW_LABELS: Readonly<Record<VerdictRow, string>> = {
  hits: '1 HITS',
  lead: '2 LEAD',
  false_holds: '3 FALSE HOLDS',
  sniff_lag: '4 SNIFF LAG',
  chest_vs_lips: '5 CHEST v LIPS',
};

function f1(x: number | null): string {
  return x === null ? 'n/a' : x.toFixed(1);
}

function rowLine(label: string, value: string, outcome: string | null): string {
  const v = value.length < VALUE ? value.padEnd(VALUE) : value;
  return `${label.padEnd(LABEL)}${v} ${outcome ?? 'n/a'}`.trimEnd();
}

function more(text: string): string {
  return `${' '.repeat(LABEL)}${text}`;
}

/** Row 4 facts verdict.md prints beyond verdict.json; sniffs.ts sniffRow gives them. */
export type SniffTextExtras = Pick<SniffRow, 'gradedUnrounded'>;

/** What verdict.md prints beyond verdict.json. */
export interface VerdictTextExtras {
  /** Row 4: whether it was graded on the medians before rounding. Absent: not known. */
  sniff?: SniffTextExtras;
}

/**
 * The row 4 value, from verdict.json alone: the medians and n, and beside n the found sniffs whose
 * trace never arrived, the count calib.json holds (PREREG §4). Medians that fall on such sniffs
 * print as the bound they are known to exceed (median_over_ms).
 */
export function sniffLagText(row: Verdict['rows']['sniff_lag']): string {
  const over = row.median_over_ms;
  const medians = over !== null ? `[> ${over}, > ${over}]` : `[${f1(row.lo_median_ms)}, ${f1(row.hi_median_ms)}]`;
  const beside = row.n > 0 ? `, ${row.no_arrival} without arrival` : '';
  return `median ${medians} ms, n=${row.n}${beside}`;
}

/** The second line of row 4: best case and D1 on sniffs, and how the row was graded when the printed medians do not show it. */
export function sniffLagMore(row: Verdict['rows']['sniff_lag'], extras: SniffTextExtras | null = null): string {
  const graded = extras?.gradedUnrounded ? '; graded on the medians before rounding' : '';
  return `best case ${f1(row.best_case_ms)} ms; D1 on sniffs ${f1(row.d1_on_sniffs_ms)} ms${graded}`;
}

/** The text of verdict.md (spec 9.7). `runs` is the number of stage B runs so far, this one included. */
export function verdictMarkdown(v: Verdict, runs: number, extras: VerdictTextExtras = {}): string {
  const r = v.rows;
  const ex = v.exploratory ? ' | EXPLORATORY' : '';
  const [a, b] = v.clock.L_rt_ms;
  const eq = r.chest_vs_lips.exploratory_equal_rate;
  const manual = v.manual_changes.length === 0 ? 'none' : v.manual_changes.map((x) => ROW_LABELS[x]).join(', ');
  const lines = [
    `GATE VERDICT ${v.id} pack ${v.pack} | stage B run ${v.run} of ${runs} | params ${v.params_sha256.slice(0, 8)}${ex}`,
    `CLOCK   L_rt A ${f1(a)} / B ${f1(b)} ms, diff ${f1(v.clock.diff_ms)} ms | onset P90 |auto-manual| ${f1(v.clock.onset_p90_ms)} ms`,
    `TUNING  k=${v.tuning.k.toFixed(1)} (criterion ${v.tuning.criterion_met ? 'met' : 'not met'}) | theta_G=${v.tuning.theta_G.toFixed(4)} | listening block only`,
    `EVENTS  ${v.events.cued} cued, ${v.events.valid} valid, ${v.events.armed} armed, ${v.events.audible_inbreath} audible in-breath`,
    rowLine(ROW_LABELS.hits, `${r.hits.hits} of ${v.events.valid} valid (${r.hits.armed_hits} of ${v.events.armed} armed)`, r.hits.outcome),
    more(`leads 0-50 ms: ${r.hits.leads_0_50}`),
    rowLine(ROW_LABELS.lead, `median of hits ${f1(r.lead.median_hits_ms)} ms`, r.lead.outcome),
    more(`median of all stops -1.5..+0.5 s: ${f1(r.lead.median_all_stops_ms)} ms`),
    rowLine(ROW_LABELS.false_holds, `${f1(r.false_holds.per_min)}/min on ${f1(r.false_holds.armed_min)} armed min, scored block`, r.false_holds.outcome),
    more(`in-sample, tuning block: chest ${f1(r.false_holds.in_sample_chest_per_min)}/min, lips ${f1(r.false_holds.in_sample_lips_per_min)}/min`),
    rowLine(ROW_LABELS.sniff_lag, sniffLagText(r.sniff_lag), r.sniff_lag.outcome),
    more(sniffLagMore(r.sniff_lag, extras.sniff ?? null)),
    rowLine(ROW_LABELS.chest_vs_lips, `wins ${r.chest_vs_lips.wins}:${r.chest_vs_lips.losses}, ties ${r.chest_vs_lips.ties}`, r.chest_vs_lips.outcome),
    more(`both before voice ${r.chest_vs_lips.both_before_n}, median diff ${f1(r.chest_vs_lips.lead_diff_ms_median)} ms`),
    more(`false fires/min, scored block: chest ${f1(r.chest_vs_lips.chest_false_per_min)}, lips ${f1(r.chest_vs_lips.lips_false_per_min)}`),
    more(`exploratory, lips at the chest rate: wins ${eq === null ? 'n/a' : `${eq.wins}:${eq.losses}`}`),
    `MISSES  no audible in-breath ${v.misses.no_inbreath} | in-breath audible ${v.misses.inbreath_audible}`,
    v.other === null
      ? 'OTHER   not computed (descriptive)'
      : `OTHER   talking flag ${v.other.talking_flag_hits} hits | head motion ${v.other.head_motion_hits} hits (descriptive)`,
    `MANUAL  lines that change with manual onsets: ${manual}`,
    `VERDICT ${v.verdict}${v.exploratory ? ' (EXPLORATORY: not the verdict of the gate)' : ''}`,
  ];
  return `${lines.join('\n')}\n`;
}
