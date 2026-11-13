// receipt.json (spec 8.6, 7.9): blocks and keys, modes without camera, the space-bar block,
// counts that must add up, and report precision.
import { describe, expect, it } from 'vitest';
import { GIT_COMMITMENTS, NO_CAMERA_MODES, RECEIPT_MODES, RIVALS, validateReceipt, type Receipt } from './index.ts';
import { exampleReceipt, exampleSpacebarReceipt } from './examples.ts';

describe('receipt.json (receipt/1)', () => {
  it('accepts a numbers session with the camera, a replay and the space-bar block', () => {
    expect(validateReceipt(exampleReceipt())).toEqual([]);
    expect(validateReceipt({ ...exampleReceipt(), mode: 'replay' })).toEqual([]);
    expect(validateReceipt(exampleSpacebarReceipt())).toEqual([]);
    expect(RECEIPT_MODES).toEqual(['live_camera', 'replay', 'no_camera_spacebar', 'no_camera_microphone']);
    expect(RIVALS).toEqual(['G', 'T', 'M', 'A100', 'A250', 'A500']);
  });

  it('without the camera stops, chance and rivals are null (spec 8.6)', () => {
    const mic: Receipt = { ...exampleSpacebarReceipt(), mode: 'no_camera_microphone' };
    delete mic.key;
    expect(NO_CAMERA_MODES).toContain('no_camera_microphone');
    expect(validateReceipt(mic)).toEqual([]);
    const withStops = { ...mic, stops: exampleReceipt().stops };
    expect(validateReceipt(withStops)).toEqual(['stops must be null in mode no_camera_microphone (spec 8.6)']);
    const live = { ...exampleReceipt(), chance: null, rivals: null };
    expect(validateReceipt(live)).toEqual(['chance: missing in mode live_camera', 'rivals: missing in mode live_camera']);
    const noTrace = exampleReceipt();
    noTrace.clock.trace_valid = null;
    expect(validateReceipt(noTrace)).toEqual(['clock.trace_valid: true or false in mode live_camera']);
  });

  it('the key block belongs to the space-bar block only (spec 8.6, 10.7)', () => {
    const k: Receipt = exampleSpacebarReceipt();
    const key = k.key;
    delete k.key;
    expect(validateReceipt(k)).toEqual(['key: missing (the space-bar block carries it, spec 8.6)']);
    expect(validateReceipt({ ...exampleReceipt(), key })).toEqual(['key: only in mode no_camera_spacebar (spec 8.6)']);
    expect(validateReceipt({ ...exampleSpacebarReceipt(), key: { ...key, lead_K_label: 'lead' } })).toEqual([
      'key.lead_K_label: expected "pressed, then spoke", got "lead"',
    ]);
  });

  it('planted errors add up: caught + late + missed = presented, events agree', () => {
    const r = exampleReceipt();
    r.planted.missed = 2;
    expect(validateReceipt(r)).toEqual([
      'planted: caught + caught_late + missed must equal presented (5 + 1 + 2 != 9)',
      'planted: events outcomes do not add up to caught, caught_late and missed',
    ]);
    const ev = exampleReceipt();
    const first = ev.planted.events[0];
    if (first === undefined) throw new Error('example has events');
    first.outcome = 'missed';
    expect(validateReceipt(ev)).toEqual(['planted: events outcomes do not add up to caught, caught_late and missed']);
    const short = exampleReceipt();
    short.planted.events.pop();
    expect(validateReceipt(short)).toEqual(['planted: events lists 8 errors, planted says 9']);
    const notPresented = exampleReceipt();
    const last = notPresented.planted.events[8];
    if (last === undefined) throw new Error('example has nine events');
    last.outcome = 'not_presented';
    notPresented.planted.presented = 8;
    notPresented.planted.missed = 2;
    expect(validateReceipt(notPresented)).toEqual([]);
  });

  it('p0_used is the largest of the three chance estimates (spec 4.3)', () => {
    const r = exampleReceipt();
    if (r.chance === null) throw new Error('camera mode');
    r.chance.p0_used = 0.061;
    expect(validateReceipt(r)).toEqual(['chance: p0_used must be the largest of the three estimates, 0.074 (spec 4.3)']);
  });

  it('receipt needs a clean git tree (spec 8.5, 7.9)', () => {
    const r = exampleReceipt();
    (r.commitments as { working_tree_clean: boolean }).working_tree_clean = false;
    expect(validateReceipt(r)).toEqual(['commitments.working_tree_clean: expected true, got false']);
  });

  it('git and ledger commitments: required with the camera; all null on the judge page (spec 7.11, 8.6)', () => {
    expect(GIT_COMMITMENTS).toEqual(['analysis_commit', 'ledger_head', 'working_tree_clean']);
    const browser = (r: Receipt): Receipt => ({ ...r, commitments: { ...r.commitments, analysis_commit: null, ledger_head: null, working_tree_clean: null } });
    const mic: Receipt = { ...exampleSpacebarReceipt(), mode: 'no_camera_microphone' };
    delete mic.key;
    expect(validateReceipt(browser(mic))).toEqual([]);
    expect(validateReceipt(browser({ ...exampleReceipt(), mode: 'replay' }))).toEqual([]);
    expect(validateReceipt(browser(exampleSpacebarReceipt()))).toEqual([]);
    expect(validateReceipt(browser(exampleReceipt()))).toEqual([
      'commitments.analysis_commit: required in mode live_camera: npm run receipt takes it from the git tree and the ledger (spec 8.5, 8.6)',
      'commitments.ledger_head: required in mode live_camera: npm run receipt takes it from the git tree and the ledger (spec 8.5, 8.6)',
      'commitments.working_tree_clean: required in mode live_camera: npm run receipt takes it from the git tree and the ledger (spec 8.5, 8.6)',
    ]);
    const half = { ...mic, commitments: { ...mic.commitments, ledger_head: null } };
    expect(validateReceipt(half)).toEqual([
      "commitments: analysis_commit, ledger_head, working_tree_clean are all set (npm run receipt) or all null (the judge's page, spec 7.11); null here: ledger_head",
    ]);
  });

  it('counts across blocks: matched = caught = primary_n; in-breath and no-signal among matched (spec 8.6)', () => {
    // The review probe: matched = caught + 5 and audible_inbreath above matched.
    const r = exampleReceipt();
    r.objections = { ...r.objections, total: 12, matched: 10, audible_inbreath: 11 };
    if (r.stops === null) throw new Error('camera mode');
    r.stops.primary_n = 10;
    expect(validateReceipt(r)).toEqual([
      'objections.matched: 10 must equal planted.caught, 5: each caught error answers one objection (spec 8.6)',
      'objections.audible_inbreath: 11 counts among the matched objections, 10 (spec 8.6)',
    ]);
    const n = exampleReceipt();
    if (n.stops === null) throw new Error('camera mode');
    n.stops.primary_n = 6;
    n.objections.matched_no_signal = 6;
    n.stops.hits_all = 9;
    n.stops.signal_only_hits = 1;
    expect(validateReceipt(n)).toEqual([
      'objections.matched_no_signal: 6 counts among the matched objections, 5 (spec 8.6)',
      'stops.primary_n: 6 must equal objections.matched, 5: the main share is primary_hits of the matched objections (spec 8.6)',
      'stops.hits_all: 9 cannot exceed objections.total, 8 (spec 8.6, H1 row 3)',
      'stops.signal_only_hits: 1 cannot exceed primary_n minus matched_no_signal, 0 (spec 8.6, H1 row 4)',
    ]);
    const over = exampleReceipt();
    over.objections.total = 4;
    expect(validateReceipt(over)).toContain('objections.matched: 5 cannot exceed objections.total, 4');
    // Without the camera the stops rules have nothing to check; the objection rules still hold.
    const k = exampleSpacebarReceipt();
    k.objections.matched = 4;
    expect(validateReceipt(k)).toEqual(['objections.matched: 4 must equal planted.caught, 5: each caught error answers one objection (spec 8.6)']);
  });

  it('the rehearsal receipt has no freeze commit ("before freeze-1", spec 7.9)', () => {
    const r = exampleReceipt();
    r.commitments.freeze_commit = null;
    expect(validateReceipt(r)).toEqual([]);
  });

  it('report values in ms are rounded to 0.1, everywhere in the receipt', () => {
    const r = exampleReceipt();
    if (r.stops === null) throw new Error('camera mode');
    r.stops.median_lead_ms = 230.55;
    r.clock.L_rt_ms = [23.45, 23.6];
    expect(validateReceipt(r)).toEqual([
      'clock.L_rt_ms[0]: expected a report value rounded to 0.1 (spec 8.1), got 23.45',
      'stops.median_lead_ms: expected a report value rounded to 0.1 (spec 8.1), got 230.55',
    ]);
  });

  it('two leads per stop when the loop checks differ by 3-15 ms: only with rule "both" (spec 6.3, 7.9)', () => {
    const block = { median_lead_ms: 230.5, lead_interval_ms: [120, 410.5] as [number, number], median_lead_all_stops_ms: 180 };
    const r = exampleReceipt();
    if (r.stops === null) throw new Error('camera mode');
    r.stops.lead_by_block = { A: block, B: { ...block, median_lead_ms: 224.5 } };
    expect(validateReceipt(r)).toEqual(['stops.lead_by_block only when clock.rule is "both"']);
    r.clock.rule = 'both';
    expect(validateReceipt(r)).toEqual([]);
  });

  it('stops counts: primary hits within primary_n, leads under 300 within hits', () => {
    const r = exampleReceipt();
    if (r.stops === null) throw new Error('camera mode');
    r.stops.primary_hits = 6;
    r.stops.hits_lead_under_300 = 7;
    expect(validateReceipt(r)).toEqual([
      'stops: primary_hits cannot exceed primary_n',
      'stops: hits_lead_under_300 cannot exceed primary_hits',
    ]);
  });

  it('rival M may be cut (spec 14.4); the other rivals are required', () => {
    const r = exampleReceipt();
    if (r.rivals === null) throw new Error('camera mode');
    delete r.rivals.M;
    expect(validateReceipt(r)).toEqual([]);
    delete r.rivals.A250;
    expect(validateReceipt(r)).toEqual(['rivals.A250: missing']);
  });

  it('names missing blocks, unknown fields and a wrong scoring_rules copy', () => {
    const r = exampleReceipt() as unknown as Record<string, unknown>;
    delete r['objections'];
    r['content_mismatch'] = 0;
    (r['scoring_rules'] as Record<string, unknown>)['W_ms'] = 1000;
    expect(validateReceipt(r)).toEqual([
      'objections: missing',
      'scoring_rules.W_ms: expected 1500, got 1000',
      'content_mismatch: unexpected field',
    ]);
    expect(validateReceipt({ ...exampleReceipt(), mode: 'camera' })[0]).toBe(
      'mode: expected one of "live_camera", "replay", "no_camera_spacebar", "no_camera_microphone", got "camera"',
    );
  });
});
