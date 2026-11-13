// quickcheck.json (spec 7.12, 9.4), verdict.json (spec 9.6, 9.7) and review.json (spec 7.9, 10.5).
// calib.json, clock_report.json and onsets.json are covered in session-files.test.ts.
import { describe, expect, it } from 'vitest';
import {
  GATE_MIN_VALID, VERDICT_ROWS, combineGateVerdict, quickcheckLine, validateQuickcheck, validateReview, validateVerdict,
  type GateOutcome, type Quickcheck, type Verdict,
} from './index.ts';
import { exampleQuickcheck, exampleReview, exampleVerdict } from './examples.ts';

/** A day-1 gate recording that failed the audio check. */
function failed(): Quickcheck {
  const q = exampleQuickcheck();
  const audio = q.checks[0];
  if (audio === undefined) throw new Error('example has checks');
  audio.ok = false;
  audio.detail = 'gap of 9600 samples at 2:31';
  return { ...q, result: 'RE-RECORD NOW', reasons: ['audio gap at 2:31'], technical: true };
}

describe('quickcheck.json', () => {
  it('accepts a good recording and a failed one; prints the one line of spec 7.12', () => {
    expect(validateQuickcheck(exampleQuickcheck())).toEqual([]);
    expect(quickcheckLine(exampleQuickcheck())).toBe('GOOD RECORDING');
    expect(validateQuickcheck(failed())).toEqual([]);
    expect(quickcheckLine(failed())).toBe('RE-RECORD NOW: audio gap at 2:31');
    expect(quickcheckLine({ result: 'RE-RECORD NOW', reasons: ['a', 'b'] })).toBe('RE-RECORD NOW: a; b');
  });

  it('a failed warning leaves the recording good (spec 7.12: warnings only warn)', () => {
    const q = exampleQuickcheck();
    const warn = q.checks.find((c) => c.name === 'not_sent_share');
    if (warn === undefined) throw new Error('example has the warning');
    warn.ok = false;
    expect(validateQuickcheck(q)).toEqual([]);
  });

  it('the result must follow from the hard checks, with reasons and the technical flag of spec 9.4', () => {
    const goodButFailed = { ...failed(), result: 'GOOD RECORDING', reasons: [], technical: null };
    expect(validateQuickcheck(goodButFailed)).toEqual(['result is GOOD RECORDING but hard check "audio_continuous" failed']);
    expect(validateQuickcheck({ ...exampleQuickcheck(), result: 'RE-RECORD NOW', reasons: [], technical: null })).toEqual([
      'result is RE-RECORD NOW but no hard check failed',
      'reasons: RE-RECORD NOW needs at least one reason',
      'technical: say whether the failure is technical (spec 9.4)',
    ]);
    expect(validateQuickcheck({ ...exampleQuickcheck(), reasons: ['x'], technical: false })).toEqual([
      'reasons must be empty for GOOD RECORDING',
      'technical must be null for GOOD RECORDING',
    ]);
  });

  it('names the field of each malformed value', () => {
    const q = exampleQuickcheck() as unknown as Record<string, unknown>;
    expect(validateQuickcheck({ ...q, result: 'OK', kind: 'session' })).toEqual([
      'kind: expected one of "gate", "numbers", "spacebar", "rehearsal", "demo", "pilot", "doctor", "smoke", "headstart", "live_from", "live_sim", got "session"',
      'result: expected one of "GOOD RECORDING", "RE-RECORD NOW", got "OK"',
    ]);
    const twice = exampleQuickcheck();
    twice.checks.push({ name: 'sniffs', ok: true, hard: true });
    expect(validateQuickcheck(twice)).toEqual(['checks: "sniffs" appears twice']);
    const badName = exampleQuickcheck();
    badName.checks.push({ name: 'L_rt diff', ok: true, hard: false, value: [1, 2] as unknown as number });
    expect(validateQuickcheck(badName)).toEqual([
      'checks[15].name: expected a check name like "audio_continuous", got "L_rt diff"',
      'checks[15].value: expected a string, number, boolean or null, got a list of 2',
    ]);
  });
});

describe('verdict.json: the rules of spec 9.6', () => {
  it('accepts the example: BETWEEN from rows hits and sniff lag', () => {
    expect(validateVerdict(exampleVerdict())).toEqual([]);
  });

  it('combineGateVerdict: any KILL, five PASS, else BETWEEN; under 12 valid NOT EVALUABLE', () => {
    const all = (o: GateOutcome | null): (GateOutcome | null)[] => VERDICT_ROWS.map(() => o);
    expect(GATE_MIN_VALID).toBe(12);
    expect(combineGateVerdict(all('PASS'), 12)).toBe('PASS');
    expect(combineGateVerdict(['PASS', 'PASS', 'PASS', 'PASS', 'KILL'], 14)).toBe('KILL');
    expect(combineGateVerdict(['KILL', 'BETWEEN', 'PASS', 'PASS', 'PASS'], 14)).toBe('KILL');
    expect(combineGateVerdict(['PASS', 'PASS', 'BETWEEN', 'PASS', 'PASS'], 14)).toBe('BETWEEN');
    expect(combineGateVerdict(['PASS', 'PASS', 'PASS', 'PASS'], 14)).toBe('BETWEEN');
    expect(combineGateVerdict(all('KILL'), 11)).toBe('NOT EVALUABLE');
    expect(combineGateVerdict(all(null), 0)).toBe('NOT EVALUABLE');
  });

  it('the verdict word must follow from the rows', () => {
    const v = exampleVerdict();
    v.verdict = 'PASS';
    expect(validateVerdict(v)).toEqual(['verdict PASS does not follow from the rows: expected BETWEEN (spec 9.6)']);
    const kill = exampleVerdict();
    kill.rows.chest_vs_lips.outcome = 'KILL';
    expect(validateVerdict(kill)).toEqual(['verdict BETWEEN does not follow from the rows: expected KILL (spec 9.6)']);
  });

  it('under 12 valid objections the rows may stay open and the verdict is NOT EVALUABLE', () => {
    const v: Verdict = exampleVerdict();
    v.events.valid = 11;
    v.rows.hits.hits = 6;
    for (const r of VERDICT_ROWS) v.rows[r].outcome = null;
    v.verdict = 'NOT EVALUABLE';
    expect(validateVerdict(v)).toEqual([]);
    v.events.valid = 12;
    v.verdict = 'BETWEEN';
    expect(validateVerdict(v)).toEqual(VERDICT_ROWS.map((r) => `rows.${r}.outcome: missing although 12 objections are valid`));
  });

  it('a row that changes with manual onsets reads BETWEEN', () => {
    const v = exampleVerdict();
    v.manual_changes = ['lead'];
    expect(validateVerdict(v)).toEqual(['rows.lead.outcome: a row that changes with manual onsets reads BETWEEN (spec 9.6)']);
    v.rows.lead.outcome = 'BETWEEN';
    expect(validateVerdict(v)).toEqual([]);
  });

  it('stage B runs once: run 1 is confirmatory, later runs exploratory (spec 8.5)', () => {
    expect(validateVerdict({ ...exampleVerdict(), run: 2 })).toEqual([
      'run 2 must have exploratory true: stage B runs once, later runs are exploratory (spec 8.5)',
    ]);
    expect(validateVerdict({ ...exampleVerdict(), run: 2, exploratory: true })).toEqual([]);
    expect(validateVerdict({ ...exampleVerdict(), exploratory: true })).toEqual([
      'run 1 must have exploratory false: stage B runs once, later runs are exploratory (spec 8.5)',
    ]);
  });

  it('report values in ms are rounded to 0.1; counts are integers; packs are A, B or C', () => {
    const v = exampleVerdict();
    v.rows.lead.median_hits_ms = 230.25;
    v.events.armed = 12.5;
    expect(validateVerdict({ ...v, pack: '0' })).toEqual([
      'pack: expected one of "A", "B", "C", got "0"',
      'events.armed: expected a count (non-negative integer), got 12.5',
      'rows.lead.median_hits_ms: expected a report value rounded to 0.1 (spec 8.1), got 230.25',
    ]);
    v.events.armed = 12;
    expect(validateVerdict(v)).toEqual(['rows.lead.median_hits_ms: expected a report value rounded to 0.1 (spec 8.1), got 230.25']);
    const tooMany = exampleVerdict();
    tooMany.rows.hits.hits = 14;
    expect(validateVerdict(tooMany)).toEqual(['rows.hits.hits cannot exceed events.valid']);
  });

  it('OTHER may be left for a later exploratory run (spec 9.7, 14.4)', () => {
    expect(validateVerdict({ ...exampleVerdict(), other: null })).toEqual([]);
  });
});

describe('review.json: blind labels of own objections (spec 7.9, 10.5)', () => {
  it('accepts the labels real_error, false_alarm, unclear, and null while open', () => {
    expect(validateReview(exampleReview())).toEqual([]);
    const open = exampleReview();
    open.items.push({ n_on: 10000000, n_off: 10048000, label: null });
    expect(validateReview(open)).toEqual([]);
  });

  it('refuses other labels and a segment that ends before it starts', () => {
    const r = exampleReview() as unknown as { items: Record<string, unknown>[] };
    r.items.push({ n_on: 100, n_off: 50, label: 'false_alarm' }, { n_on: 1, n_off: 2, label: 'maybe' });
    expect(validateReview(r)).toEqual([
      'items[2]: n_off lies before n_on',
      'items[3].label: expected one of "real_error", "false_alarm", "unclear", got "maybe"',
    ]);
  });
});
